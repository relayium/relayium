package account

import (
	"context"
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
	NodeID        string   `json:"nodeID"`
	TURNSecret    string   `json:"turnSecret"`
	URLs          []string `json:"urls"`
	Region        string   `json:"region"`
	Version       string   `json:"version"`
	Capabilities  []string `json:"capabilities"`
	StorageURL    string   `json:"storageURL"`
	StorageSecret string   `json:"storageSecret"`
	StorageFP     string   `json:"storageFP"` // node blob-endpoint TLS cert fingerprint (hex SHA-256); "" for legacy http nodes
	StorageTotal  int64    `json:"storageTotal"`
	StorageFree   int64    `json:"storageFree"`
}

// nodeLimits carries a node's admin-set hard caps plus its current-month relayed
// total, so the node can enforce them locally in real time (workstream B) instead
// of relying on central to withhold it at ICE time between heartbeats.
type nodeLimits struct {
	TrafficLimitBytes int64 `json:"trafficLimitBytes"` // resolved (node override or global default); 0 = unlimited
	DiskLimitBytes    int64 `json:"diskLimitBytes"`    // 0 = unlimited
	RelayedThisMonth  int64 `json:"relayedThisMonth"`  // central's authoritative month-to-date
}

type nodeRegisterResp struct {
	NodeID            string `json:"nodeID"`
	HeartbeatInterval int    `json:"heartbeatInterval"`
	nodeLimits
}

type nodeHeartbeatResp struct {
	OK                bool `json:"ok"`
	HeartbeatInterval int  `json:"heartbeatInterval"`
	nodeLimits
}

// 中继流量的调度余量：中心端只把生效上限的 90% 发出去，留 10% 给已经建连的
// 会话吐完。比例只在这里定义一次（与存储侧 storageHeadroomNum/Den 同纪律）。
const nodeTrafficHeadroomNum, nodeTrafficHeadroomDen = 9, 10

// usableTraffic 是中心端愿意排给一台节点的月度流量。limit <= 0（不限）时原样返回。
func usableTraffic(limit int64) int64 {
	if limit <= 0 {
		return limit
	}
	return limit * nodeTrafficHeadroomNum / nodeTrafficHeadroomDen
}

// resolveNodeTrafficLimit 给出一台节点本月真正生效的中继流量上限（字节）。
//
// 节点行里的 traffic_limit_bytes 为 0 表示"继承全局默认"，不再是"无限"——
// 这条语义在 2026-07 改过：官方节点默认应当有一个上限（出厂 1 TiB），管理员
// 想给某台机器单独放开就填一个大数，而不是靠 0。返回 0 仍表示不限，那只会在
// 全局默认也被设成 0（整体关掉这套机制）时发生。
func resolveNodeTrafficLimit(node Node, st Settings) int64 {
	if node.TrafficLimitBytes > 0 {
		return node.TrafficLimitBytes
	}
	return st.NodeTrafficDefault
}

// nodeLimitsFor assembles a node's caps and month-to-date relayed total.
func (s *Service) nodeLimitsFor(ctx context.Context, node Node) nodeLimits {
	monthStart, _ := monthRange(periodOf(s.now().Unix()))
	relayed := int64(0)
	if m, err := s.store.NodeRelayedSince(ctx, monthStart); err == nil {
		relayed = m[node.ID]
	}
	return nodeLimits{
		// 下发**解析后**的上限：节点行里可能是 0（继承全局默认），直接发 0 会让
		// 节点以为自己不限流量，本地硬闸永远不触发。
		TrafficLimitBytes: resolveNodeTrafficLimit(node, s.resolveSettings(ctx)),
		DiskLimitBytes:    node.DiskLimitBytes,
		RelayedThisMonth:  relayed,
	}
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
	StorageTotal int64       `json:"storageTotal"`
	StorageFree  int64       `json:"storageFree"`
}

// RegisterNodeRoutes mounts the node register/heartbeat endpoints on mux, but
// only when a fleet NodeToken is configured. They are bearer-authenticated and
// therefore mount on the root mux (bypassing the cookie CSRF guard).
func (s *Service) RegisterNodeRoutes(mux *http.ServeMux) {
	if s.cfg.NodeToken == "" && !s.cfg.EnableUserNodes {
		return
	}
	mux.HandleFunc("POST /api/nodes/register", s.handleNodeRegister)
	mux.HandleFunc("POST /api/nodes/heartbeat", s.handleNodeHeartbeat)
}

// nodeOwner resolves the bearer token to a node owner: the shared fleet token,
// or a per-user node token (hashed lookup). ok=false → 401.
func (s *Service) nodeOwner(r *http.Request) (ownerType, ownerUserID string, ok bool) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		return "", "", false
	}
	if s.cfg.NodeToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.NodeToken)) == 1 {
		return "fleet", "", true
	}
	// Admin-minted fleet tokens (userless) — resolved like the env token but
	// per-node and revocable from the admin panel.
	if ft, found, err := s.store.FleetTokenByHash(r.Context(), hashToken(tok)); err == nil && found {
		_ = s.store.TouchFleetTokenUsed(r.Context(), ft.ID, s.now().Unix())
		return "fleet", "", true
	}
	if s.cfg.EnableUserNodes {
		if nt, found, err := s.store.NodeTokenByHash(r.Context(), hashToken(tok)); err == nil && found {
			_ = s.store.TouchNodeTokenUsed(r.Context(), nt.ID, s.now().Unix())
			return "user", nt.UserID, true
		}
	}
	return "", "", false
}

// containsCap reports whether caps includes want.
func containsCap(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

func (s *Service) handleNodeRegister(w http.ResponseWriter, r *http.Request) {
	ownerType, ownerUserID, ok := s.nodeOwner(r)
	if !ok {
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
	// StorageURL is user-controlled and central makes outbound calls to it;
	// reject non-public / malformed endpoints to prevent SSRF.
	if req.StorageURL != "" {
		if err := validateNodeStorageURL(req.StorageURL, s.allowPrivateNodeURLs); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	// Prevent node-ID takeover: a re-register of an existing node id must come from
	// the SAME owner. A fleet token may only re-register a fleet node; a user token
	// may only re-register its own user node. Unknown ids fall through as new nodes.
	if req.NodeID != "" {
		if existing, found, gerr := s.store.GetNode(r.Context(), req.NodeID); gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
			return
		} else if found {
			mismatch := existing.OwnerType != ownerType ||
				(ownerType == "user" && existing.OwnerUserID != ownerUserID)
			if mismatch {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "node id belongs to another owner"})
				return
			}
		}
	}
	// Resolve the presented token once: its name seeds the node's initial label
	// (only used on first INSERT — UpsertNode preserves a later rename), and its
	// id binds the token to the node for per-node revoke/delete.
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	var userTok *NodeToken
	var fleetTok *FleetToken
	label := ""
	if ownerType == "user" {
		if nt, found, e := s.store.NodeTokenByHash(r.Context(), hashToken(tok)); e == nil && found {
			userTok = &nt
			label = nt.Name
		}
	} else if ft, found, e := s.store.FleetTokenByHash(r.Context(), hashToken(tok)); e == nil && found {
		fleetTok = &ft
		label = ft.Name
	}
	now := s.now().Unix()
	n := Node{
		ID: req.NodeID, OwnerType: ownerType, OwnerUserID: ownerUserID, Label: label,
		Region: req.Region, URLs: req.URLs, TURNSecret: req.TURNSecret, Version: req.Version,
		CreatedAt: now, LastSeenAt: now,
		StorageURL: req.StorageURL, StorageSecret: req.StorageSecret, StorageFP: req.StorageFP,
		StorageEnabled: containsCap(req.Capabilities, "storage"),
		StorageTotal:   req.StorageTotal, StorageFree: req.StorageFree,
	}
	saved, err := s.store.UpsertNode(r.Context(), n)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	// Bind the presented token to its node for per-node revoke/delete.
	if userTok != nil {
		_ = s.store.BindNodeToken(r.Context(), userTok.ID, saved.ID)
	} else if fleetTok != nil {
		// An admin-minted fleet token (not the shared env token) binds to its node.
		_ = s.store.BindFleetToken(r.Context(), fleetTok.ID, saved.ID)
	}
	writeJSON(w, http.StatusOK, nodeRegisterResp{
		NodeID: saved.ID, HeartbeatInterval: nodeHeartbeatInterval,
		nodeLimits: s.nodeLimitsFor(r.Context(), saved),
	})
}

// handleNodeHeartbeat trusts the reported usage[]: any holder of a valid node
// credential (fleet token or a user's own node token) can report relayed bytes
// for its allocations. A fleet node's relay is billable against the attributed
// user's quota; a BYO user node's relay is free (own-node), and it may only
// attribute to its own owner — cross-user attribution is dropped.
func (s *Service) handleNodeHeartbeat(w http.ResponseWriter, r *http.Request) {
	ownerType, ownerUserID, ok := s.nodeOwner(r)
	if !ok {
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
	// with 410 Gone.
	node, known, err := s.store.GetNode(r.Context(), req.NodeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !known {
		writeJSON(w, http.StatusGone, map[string]string{"error": "unknown node, re-register"})
		return
	}
	// A user token may only heartbeat a node it owns (a fleet token may heartbeat any fleet node).
	if ownerType == "user" && (node.OwnerType != "user" || node.OwnerUserID != ownerUserID) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your node"})
		return
	}
	billable := node.OwnerType == "fleet"
	now := s.now().Unix()
	if err := s.store.TouchNode(r.Context(), req.NodeID, req.RelayedTotal, req.StoredBytes, req.StorageTotal, req.StorageFree, now); err != nil {
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
		// An unattributable username (no owner) can't be billed to anyone and
		// would violate foreign_keys=ON; skip it.
		if userID == "" {
			continue
		}
		// A user-owned node may only attribute usage to its own owner.
		if node.OwnerType == "user" && userID != node.OwnerUserID {
			log.Printf("node %s: dropping cross-user attribution to %s", req.NodeID, userID)
			continue
		}
		// Attribution binding: the reported username embeds a pairing code whose
		// true owner central assigned at ICE time. If that code still resolves to a
		// DIFFERENT user, the node is forging attribution (e.g. billing a victim) —
		// drop it. An expired/unknown code can't be contradicted, so it's accepted
		// (magnitude is still bounded by RecordUsage's clamp).
		if s.pairCodeOwner != nil && code != "" {
			if realOwner, ok := s.pairCodeOwner(code); ok && realOwner != userID {
				log.Printf("node %s: dropping forged attribution (code owner %s != reported %s)", req.NodeID, realOwner, userID)
				continue
			}
		}
		if err := s.store.RecordUsage(r.Context(), UsageEvent{
			AllocID: u.AllocID, Token: code, UserID: userID, RelayedBytes: u.RelayedBytes,
			RecordedAt: now, NodeID: req.NodeID, Billable: billable,
		}); err != nil {
			// Log-and-continue: one bad alloc must not drop the rest.
			log.Printf("node %s heartbeat: record alloc %s failed: %v", req.NodeID, u.AllocID, err)
		}
	}
	writeJSON(w, http.StatusOK, nodeHeartbeatResp{
		OK: true, HeartbeatInterval: nodeHeartbeatInterval,
		nodeLimits: s.nodeLimitsFor(r.Context(), node),
	})
}
