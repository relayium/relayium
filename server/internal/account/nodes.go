package account

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/relayium/relayium/internal/relayusage"
)

// nodeHeartbeatInterval is the seconds a node waits between heartbeats. The
// /api/ice online window is 3x this (see nodeOnlineWindow in turn.go).
const nodeHeartbeatInterval = 30

type nodeRegisterReq struct {
	NodeID       string   `json:"nodeID"`
	TURNSecret   string   `json:"turnSecret"`
	URLs         []string `json:"urls"`
	Region       string   `json:"region"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

type nodeRegisterResp struct {
	NodeID            string `json:"nodeID"`
	HeartbeatInterval int    `json:"heartbeatInterval"`
}

type nodeUsage struct {
	AllocID      string `json:"allocID"`
	Username     string `json:"username"`
	RelayedBytes int64  `json:"relayedBytes"`
}

type nodeHeartbeatReq struct {
	NodeID       string      `json:"nodeID"`
	Status       string      `json:"status"`
	Usage        []nodeUsage `json:"usage"`
	RelayedTotal int64       `json:"relayedTotal"`
	StoredBytes  int64       `json:"storedBytes"`
}

// RegisterNodeRoutes mounts the node register/heartbeat endpoints on mux, but
// only when a fleet NodeToken is configured. They are bearer-authenticated and
// therefore mount on the root mux (bypassing the cookie CSRF guard).
func (s *Service) RegisterNodeRoutes(mux *http.ServeMux) {
	if s.cfg.NodeToken == "" {
		return
	}
	mux.HandleFunc("POST /api/nodes/register", s.handleNodeRegister)
	mux.HandleFunc("POST /api/nodes/heartbeat", s.handleNodeHeartbeat)
}

// nodeAuthorized constant-time-compares the request's bearer token to NodeToken.
func (s *Service) nodeAuthorized(r *http.Request) bool {
	if s.cfg.NodeToken == "" {
		return false
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.NodeToken)) == 1
}

func (s *Service) handleNodeRegister(w http.ResponseWriter, r *http.Request) {
	if !s.nodeAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req nodeRegisterReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.TURNSecret == "" || len(req.URLs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "turnSecret and urls required"})
		return
	}
	now := s.now().Unix()
	n := Node{
		ID: req.NodeID, OwnerType: "fleet", Region: req.Region, URLs: req.URLs,
		TURNSecret: req.TURNSecret, Version: req.Version, CreatedAt: now, LastSeenAt: now,
	}
	saved, err := s.store.UpsertNode(r.Context(), n)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	writeJSON(w, http.StatusOK, nodeRegisterResp{NodeID: saved.ID, HeartbeatInterval: nodeHeartbeatInterval})
}

func (s *Service) handleNodeHeartbeat(w http.ResponseWriter, r *http.Request) {
	if !s.nodeAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req nodeHeartbeatReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.NodeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nodeID required"})
		return
	}
	// A node unknown to us (DB reset / never registered) is told to re-register
	// with 410 Gone. We check existence via ListNodes (fleet is dozens of rows);
	// swap for a GetNode(id) store method if the fleet ever grows large.
	nodes, err := s.store.ListNodes(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	known := false
	for _, n := range nodes {
		if n.ID == req.NodeID {
			known = true
			break
		}
	}
	if !known {
		writeJSON(w, http.StatusGone, map[string]string{"error": "unknown node, re-register"})
		return
	}
	now := s.now().Unix()
	if err := s.store.TouchNode(r.Context(), req.NodeID, req.RelayedTotal, req.StoredBytes, now); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	// Attribute per-allocation relayed bytes through the existing keep-max path.
	for _, u := range req.Usage {
		token := relayusage.TokenFromUsername(u.Username)
		if token == "" {
			continue
		}
		userID, code := relayusage.SplitAttrib(token)
		if err := s.store.RecordUsage(r.Context(), UsageEvent{
			AllocID: u.AllocID, Token: code, UserID: userID,
			RelayedBytes: u.RelayedBytes, RecordedAt: now,
		}); err != nil {
			// Log-and-continue: one bad alloc must not drop the rest.
			log.Printf("node %s heartbeat: record alloc %s failed: %v", req.NodeID, u.AllocID, err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "heartbeatInterval": nodeHeartbeatInterval})
}
