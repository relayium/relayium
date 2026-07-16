package account

import (
	"encoding/json"
	"net/http"
	"strings"
)

const maxNodeTokensPerUser = 10

// nodeHost extracts the host (IP or DNS name) from a node's first TURN URL,
// e.g. "turn:8.212.173.136:3478?transport=udp" -> "8.212.173.136". Returns ""
// when there are no URLs. Public info for the node's own dashboard/admin.
func nodeHost(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	u := urls[0]
	if i := strings.IndexByte(u, ':'); i >= 0 { // strip the turn:/turns: scheme
		u = u[i+1:]
	}
	if i := strings.IndexAny(u, "?"); i >= 0 { // strip ?transport=…
		u = u[:i]
	}
	// Strip the port: for "host:port" take the part before the LAST colon (IPv6
	// bare addresses aren't emitted by coturn-setup, which uses turn:<ip>:3478).
	if i := strings.LastIndexByte(u, ':'); i >= 0 {
		u = u[:i]
	}
	return strings.Trim(u, "[]")
}

type provisionReq struct {
	Name string `json:"name"`
}

// handleProvisionNode mints a new BYO-node bearer token for the caller. The
// plaintext token is returned exactly once; only its hash is persisted.
func (s *Service) handleProvisionNode(w http.ResponseWriter, r *http.Request, u User) {
	var req provisionReq
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	if req.Name == "" {
		req.Name = "node"
	}
	existing, err := s.store.ListNodeTokensByUser(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if len(existing) >= maxNodeTokensPerUser {
		http.Error(w, "too many nodes", http.StatusTooManyRequests)
		return
	}
	raw := randToken() // unguessable plaintext, shown once
	id := newID()
	if err := s.store.CreateNodeToken(r.Context(), NodeToken{
		ID: id, TokenHash: hashToken(raw), UserID: u.ID, Name: req.Name, CreatedAt: s.now().Unix(),
	}); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "token": raw, "name": req.Name})
}

// handleMyNodes lists all of the caller's own nodes (online and offline), for
// the personal-center dashboard.
func (s *Service) handleMyNodes(w http.ResponseWriter, r *http.Request, u User) {
	// Include offline nodes too (list all the user owns), with an online flag.
	since := s.now().Add(-nodeOnlineWindow).Unix()
	nodes, err := s.store.UserNodesAll(r.Context(), u.ID) // owner's nodes regardless of last_seen
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, map[string]any{
			"id": n.ID, "name": n.Label, "region": n.Region, "host": nodeHost(n.URLs),
			"online":       n.LastSeenAt >= since,
			"relayedBytes": n.RelayedBytes, "storedBytes": n.StoredBytes,
			"storageFree": n.StorageFree, "storageTotal": n.StorageTotal, "lastSeen": n.LastSeenAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": out})
}

type renameReq struct {
	Name string `json:"name"`
}

// handleRenameMyNode sets the display label of one of the caller's own nodes.
// Owner-scoped in SQL, so a non-owner or missing id is an indistinguishable 404.
func (s *Service) handleRenameMyNode(w http.ResponseWriter, r *http.Request, u User) {
	id := r.PathValue("id")
	var req renameReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	label := strings.TrimSpace(req.Name)
	if len(label) > 64 {
		label = label[:64]
	}
	if err := s.store.SetUserNodeLabel(r.Context(), id, u.ID, label); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": label})
}

// handleDeleteMyNode removes one of the caller's own nodes and revokes any
// node token bound to it. Non-owner and missing ids are indistinguishable
// (both 404), so the endpoint never leaks another user's node existence.
func (s *Service) handleDeleteMyNode(w http.ResponseWriter, r *http.Request, u User) {
	id := r.PathValue("id")
	if err := s.store.DeleteNode(r.Context(), id, u.ID); err != nil {
		http.Error(w, "not found", http.StatusNotFound) // non-owner and missing are indistinguishable
		return
	}
	// Revoke any token bound to this node (owner-scoped).
	toks, _ := s.store.ListNodeTokensByUser(r.Context(), u.ID)
	for _, t := range toks {
		if t.NodeID == id {
			_ = s.store.RevokeNodeToken(r.Context(), t.ID, u.ID, s.now().Unix())
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type strictReq struct {
	OnlyOwnNodes bool `json:"onlyOwnNodes"`
}

// handleStrictNodes toggles the BYO-nodes-only restriction (SP3) for the
// caller: when on, their transfers are restricted to their own self-hosted
// nodes, excluding the shared fleet.
func (s *Service) handleStrictNodes(w http.ResponseWriter, r *http.Request, u User) {
	var req strictReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.store.SetOnlyOwnNodes(r.Context(), u.ID, req.OnlyOwnNodes); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"onlyOwnNodes": req.OnlyOwnNodes})
}
