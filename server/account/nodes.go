package account

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/relayusage"
	"github.com/relayium/relayium/selfupdate"
)

// nodeIDPattern is exactly what authx.NewID() produces: 16 random bytes, hex-encoded
// (32 lowercase hex characters). Kept in lockstep with authx.NewID() by hand — there
// is no shared constant, because the two live in different files for
// different reasons (newID is store-side id generation; this is wire input
// validation), but a future change to one must carry the other.
var nodeIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// validNodeID reports whether id is a plausible central-generated node id —
// the charset and length authx.NewID() itself produces. Used to reject a
// client-supplied id for a BRAND-NEW registration (see handleNodeRegister);
// an existing id is validated by ownership instead, not by this.
func validNodeID(id string) bool {
	return nodeIDPattern.MatchString(id)
}

// isHTTPSURL reports whether s is a well-formed absolute https URL with a host —
// the bar for a node's public DownloadURL, since central redirects clients to it.
func isHTTPSURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme == "https" && u.Host != ""
}

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
	// DownloadURL is the node's PUBLIC https base URL for direct client downloads
	// (e.g. https://node7.relayium.com). Honored only for fleet nodes and only when
	// https; empty otherwise (central then proxies). See Node.DownloadURL.
	DownloadURL string `json:"downloadURL"`
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
		TrafficLimitBytes: resolveNodeTrafficLimit(node, s.ResolveSettings(ctx)),
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
	// ActiveTransfers is how many relay allocations the node is serving RIGHT
	// NOW. It is the load signal decideFleet's canary pick runs on, and it is a
	// separate field on purpose rather than len(Usage): Usage skips allocations
	// that have not joined a username yet and includes ones that closed since
	// the last heartbeat (reported once more so their bytes flush), so its
	// length means "allocations seen since the last heartbeat", not "active".
	//
	// A POINTER on purpose, not a plain int: nil is how the WIRE tells apart "a
	// binary older than this field, which omits the key entirely" from "a
	// current binary genuinely reporting zero in-flight transfers" — the two
	// are different claims (see Node.ActiveTransfers) and encoding/json can
	// only preserve that distinction through a JSON key that is either present
	// (even as `0`) or absent. WIRE COMPATIBILITY holds both ways: an old node
	// omits the key and this decodes nil exactly as it decoded 0 before this
	// was a pointer; a new node always sends it, so an old server (which
	// doesn't know this field at all) is unaffected either way.
	ActiveTransfers *int `json:"activeTransfers,omitempty"`
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
	mux.HandleFunc("POST /api/nodes/download-receipt", s.handleDownloadReceipt)
	mux.HandleFunc("POST /api/nodes/update-check", s.handleUpdateCheck)
	mux.HandleFunc("POST /api/nodes/deregister", s.handleNodeDeregister)
}

// handleNodeDeregister is what the uninstaller calls on its way out: this
// machine is being removed, stop handing it out. Central marks the row removed
// (never deletes it — the admin panel and the audit trail still have to be able
// to explain where a file's node went) which takes it out of the placement
// pool, out of the ICE candidate list and out of the direct-download redirect
// path in one write.
//
// The node is expected to be gone moments later, so this must be cheap and
// forgiving: the caller treats every failure as non-fatal and uninstalls
// anyway. An already-removed node is a 200, not an error.
//
// AUTHENTICATION is exactly handleUpdateCheck's, including BOTH directions of
// the ownership boundary, and here they matter more than anywhere else in this
// file: this is the one node endpoint that takes a node out of service. Without
// the fleet→user check, a holder of the shared fleet token could name a
// stranger's BYO node and silently strand every file on it behind central's
// proxy path; without the user→user check, any user with a node token could do
// the same to anyone else's.
func (s *Service) handleNodeDeregister(w http.ResponseWriter, r *http.Request) {
	ownerType, ownerUserID, ok := s.nodeOwner(r)
	if !ok {
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req struct {
		NodeID string `json:"nodeID"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.NodeID == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "nodeID required"})
		return
	}
	node, known, err := s.store.GetNode(r.Context(), req.NodeID)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !known {
		// Nothing to remove. The uninstall is still correct, so this is not an
		// error the script should shout about.
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": false})
		return
	}
	if ownerType == "user" && (node.OwnerType != "user" || node.OwnerUserID != ownerUserID) {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "not your node"})
		return
	}
	if ownerType == "fleet" && node.OwnerType != "fleet" {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "not a fleet node"})
		return
	}
	at := s.now().Unix()
	if err := s.store.MarkNodeRemoved(r.Context(), req.NodeID, at); err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	// Audited, exactly like the two admin controls that reach the SAME store
	// method (handleAdminMarkNodeRemoved / handleAdminRestoreNode) — and this is
	// the path that matters most, because it is how nodes normally leave
	// service. Without it, "when did node7 go away" had no answer at all: the
	// admin actions were in the trail and the common case was not.
	//
	// The actor is the NODE, not a person (writeNodeAudit), and the action is
	// its own (node.deregister, never node.remove): nobody was in the room, and
	// an entry that implies an admin was would be worse than none.
	//
	// Written only when this call ACTUALLY transitioned the node — node.RemovedAt
	// (read BEFORE MarkNodeRemoved, which is first-write-wins) was still zero.
	// Without this guard every repeat call on an already-removed node — and
	// there is no rate limit on this endpoint, nor a prune path for admin_audit
	// unlike PruneUploadEvents/PruneDownloadReceipts — would keep writing a row
	// that changed nothing, which is exactly what "records what happened rather
	// than what was attempted" rules out, and gives any node-token holder an
	// unbounded way to grow the audit table and dilute the trail this exists to
	// build.
	if node.RemovedAt == 0 {
		s.writeNodeAudit(r, AuditNodeDeregister, req.NodeID,
			[]ChangeField{{Field: "removed_at", Old: node.RemovedAt, New: at}})
	}
	// Loud on purpose. Every file still on this node has just become unreachable
	// for its owner, and no admin was necessarily in the room when it happened.
	if live, _, cerr := s.store.CountFilesOnNode(r.Context(), req.NodeID, at); cerr == nil && live > 0 {
		log.Printf("node %s deregistered while still holding %d live file(s) — those files are now unreachable", req.NodeID, live)
	} else {
		log.Printf("node %s deregistered (uninstalled)", req.NodeID)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": true})
}

// updateCheckReq is what a node's ROOT UPDATER asks central: "what should I be
// running, and is it my turn?". Result carries the outcome of the PREVIOUS
// update this node was commanded to perform, piggybacked on the next poll.
type updateCheckReq struct {
	NodeID         string `json:"nodeID"`
	CurrentVersion string `json:"currentVersion"`
	Result         string `json:"result,omitempty"` // outcome of the PREVIOUS update
}

// updateCheckResp is central's answer. Eligible is the only field that
// authorises a binary swap; TargetVersion alone means nothing but "this is
// where the track is headed".
type updateCheckResp struct {
	TargetVersion  string `json:"targetVersion"`
	Eligible       bool   `json:"eligible"`
	AllowDowngrade bool   `json:"allowDowngrade"`
	Reason         string `json:"reason,omitempty"`
}

// updateResults is the closed set of outcomes a node may report. Anything else
// is rejected rather than stored: the rollout state machines branch on these
// exact strings, so an unrecognised value would silently read as "no result
// yet" and a real failure could go uncounted.
//
// "unreachable" (a node that never obtained the artifact — DNS, TLS, a reset)
// is accepted here before any node can send it: central deploys on every push
// to main, while nodes only pick up a new binary when a rollout reaches them,
// so this map is always live well before the first node capable of reporting
// the value exists.
var updateResults = map[string]bool{"ok": true, "failed": true, "rolled_back": true, "skipped": true, "unreachable": true}

// handleUpdateCheck is the rollout state machines' only mouth: the node's root
// updater polls it, and central answers with the target version and whether
// this node may move now. The node proper never asks for a binary — a
// compromised node therefore has no channel through which to request a swap.
//
// TRUST MODEL (deliberate, matches register/heartbeat): the FLEET token is
// shared across the whole fleet and does not bind to a nodeID, so a fleet node
// could in principle report results for, or claim the slot of, another fleet
// node. nodeID is therefore NOT authenticated on the fleet path — do not build
// anything on the assumption that it is. That licence stops at the OWNERSHIP
// BOUNDARY, and both directions are checked below: a user token may only speak
// for that user's own nodes, and a fleet token may only speak for fleet nodes.
// A fleet token naming a user's node would otherwise be able to write
// update_result onto a stranger's machine and poison the BYO track's failure
// accounting — a track it has no business touching at all.
//
// CONCURRENCY: with several app instances behind the load balancer, the fleet
// track's "one node at a time" property rests on ClaimRolloutNode's
// compare-and-swap, NOT on decideFleet being deterministic. Two instances
// reading a moment apart genuinely see different candidate sets (online() is
// last_seen_at >= now-90s, and update-check does not refresh last_seen_at), so
// they can pick different nodes; the CAS is what makes exactly one of those
// picks win. What is guaranteed is therefore: a node is told "eligible" only
// after its claim has been durably recorded against the state the decision was
// made from — never that two nodes cannot both be picked.
func (s *Service) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	ownerType, ownerUserID, ok := s.nodeOwner(r)
	if !ok {
		// An unauthenticated caller learns nothing — not even the target
		// version, which would name the exact release to hunt for CVEs in.
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req updateCheckReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.NodeID == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "nodeID required"})
		return
	}
	if req.Result != "" && !updateResults[req.Result] {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown result"})
		return
	}
	ctx := r.Context()
	node, known, err := s.store.GetNode(ctx, req.NodeID)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !known {
		httpx.WriteJSON(w, http.StatusGone, map[string]string{"error": "unknown node, re-register"})
		return
	}
	if ownerType == "user" && (node.OwnerType != "user" || node.OwnerUserID != ownerUserID) {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "not your node"})
		return
	}
	// The other direction of the same boundary. The shared fleet token stands in
	// for ANY fleet node by design, but never for a user's node: without this a
	// fleet-token holder could POST a stranger's nodeID with Result:"failed" and
	// have it written to that node's row (SetNodeUpdateResult runs before the
	// track is even resolved), corrupting decideByo's failure numerator.
	if ownerType == "fleet" && node.OwnerType != "fleet" {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "not a fleet node"})
		return
	}
	now := s.now().Unix()

	// A DEREGISTERED node is never commanded, on any path, and — since a "not
	// eligible" refusal must mean nothing was written, not just nothing was
	// commanded — it must never even have its reported Result persisted. The
	// machine is on its way out (the uninstaller deregisters seconds BEFORE it
	// stops the service, and a node whose row was marked removed by an admin
	// is being retired deliberately), so telling it to download and install a
	// new binary is at best wasted work on a dying host and at worst an
	// install that never finishes on a machine nobody is watching.
	//
	// This sits AHEAD of the SetNodeUpdateResult write below on purpose: it
	// used to sit after track resolution, which meant a removed node POSTing
	// Result:"failed" got update_result="failed" persisted before being
	// refused (update_started_at correctly stayed 0, since nothing downstream
	// of the write ever re-commands a removed node — but "nothing is written
	// when refused" was not literally true).
	//
	// The staged ladders already had the "never commanded" property, but only
	// INDIRECTLY: their snapshot comes from NodesByOwnerType, which filters
	// removed_at = 0, so a removed node is neither a candidate nor the picked
	// NodeID, and the fleet path's `d.NodeID != node.ID` guard turns the rest
	// away. The EMERGENCY path bypasses both — it reads this node with an
	// unfiltered GetNode and commands it directly — which made it the one
	// hole. The check sits HERE, in front of every other branch (including the
	// result write), so it holds for every present and future path out of
	// this handler.
	//
	// Answered as a plain "not eligible", not an error: the node's updater
	// polls this every 30 seconds and a failing endpoint would just produce
	// log noise on a machine that is about to disappear.
	if node.RemovedAt != 0 {
		httpx.WriteJSON(w, http.StatusOK, updateCheckResp{Reason: "node is deregistered"})
		return
	}

	// Land the reported result BEFORE any decision is taken, so a report is
	// never lost to a subsequent decision error — and so the snapshot read
	// below already contains it (that is what lets the state machine halt on
	// this very poll).
	if req.Result != "" {
		if err := s.store.SetNodeUpdateResult(ctx, req.NodeID, req.Result); err != nil {
			httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
			return
		}
		node.UpdateResult = req.Result
	}

	// The owner type IS the track: our own machines roll on "fleet", user
	// machines on "byo", and the two are never read across (a BYO node must
	// never follow the fleet's rollout).
	track, ownerClass := "fleet", "fleet"
	if ownerType == "user" {
		track, ownerClass = "byo", "user"
	}
	tr, found, err := s.store.GetRolloutTrack(ctx, track)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !found {
		httpx.WriteJSON(w, http.StatusOK, updateCheckResp{Reason: "no rollout configured for this track"})
		return
	}
	resp := updateCheckResp{
		TargetVersion: tr.TargetVersion,
		// AllowDowngrade is true ONLY when the track points at a version older
		// than what this node runs, i.e. an operator deliberately rolled the
		// target back. Compared numerically, never as strings ("v0.10.0" sorts
		// before "v0.9.0").
		//
		// The STORED version wins over the one in the request body: the body is
		// self-reported and unauthenticated on the fleet path, so preferring it
		// would let a node claim "v9.9.9" and be handed AllowDowngrade for any
		// target it likes. req.CurrentVersion is only a fallback for a row that
		// has no version recorded yet.
		//
		// This is NOT authoritative in an absolute sense: node.Version is itself
		// written by the node via register/heartbeat, so a node can still walk
		// its OWN recorded version up over successive calls to obtain
		// AllowDowngrade for itself. What it closes is cross-node spoofing (one
		// node claiming another's or an arbitrary version at request time) — the
		// trust model documented on handleUpdateCheck accepts self-spoofing as
		// the node's own problem, same as register/heartbeat already do.
		AllowDowngrade: isVersionDowngrade(firstNonEmpty(node.Version, req.CurrentVersion), tr.TargetVersion),
	}
	if tr.Status != "rolling" {
		resp.Reason = "rollout track is " + tr.Status
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}

	// EVERY node of the track, INCLUDING OFFLINE ONES. decideFleet does its own
	// online filtering and detects a bricked node by its row still being
	// present but stale; a listing pre-filtered on last_seen_at (OnlineNodes)
	// would make that node vanish instead of halting the track.
	all, err := s.store.NodesByOwnerType(ctx, ownerClass)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	snaps := nodeSnapshots(all)

	// Emergency release short-circuits BOTH state machines: the operator has
	// explicitly (and with a step-up confirmation) asked for the whole track at
	// once, so there is no queue to wait in and no batch to be a member of.
	// Placed before the per-track dispatch so the semantics are identical on
	// fleet and byo — an emergency is not a different kind of thing on our own
	// machines than on a user's.
	if tr.Emergency {
		resp.Eligible, resp.Reason, err = s.updateCheckEmergency(ctx, tr, snaps, node, now)
		if err != nil {
			httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
			return
		}
		httpx.WriteJSON(w, http.StatusOK, resp)
		return
	}

	if track == "fleet" {
		resp.Eligible, resp.Reason, err = s.updateCheckFleet(ctx, tr, snaps, node, now)
	} else {
		resp.Eligible, resp.Reason, err = s.updateCheckByo(ctx, tr, snaps, node, now)
	}
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, resp)
}

// updateCheckEmergency answers a node while its track is in emergency mode:
// everyone who is behind the target updates NOW, with no queue, no canary and
// no batch ladder. It replaces decideFleet/decideByo rather than configuring
// them, so neither state machine grows an "except when..." branch.
//
// Two things it still does, because dropping them would make the emergency
// unusable rather than just fast:
//
//   - it does NOT re-command a node that already reported a failure for THIS
//     rollout (emergencyRefusesNode). Without that, a node whose update fails
//     is handed the same command on every 30-second poll forever — a reinstall
//     loop, not a release. Its row keeps the failure for the admin panel to
//     show.
//   - it completes the track once nobody we can still reach is behind AND
//     still commandable, exactly as the staged paths do, so an emergency
//     release does not leave the track rolling forever and every node
//     re-checking on every poll.
//
// The two bullets use the SAME predicate, and that is load-bearing rather than
// tidiness: a node the first bullet will never command cannot be allowed to
// count as "still in progress" in the second, or one permanently-refused node
// pins the track in rolling+emergency forever — and a track stuck like that
// keeps blanket-commanding every node that comes back online or registers
// afterwards.
//
// What it deliberately does NOT do is halt on failures: an emergency release
// has already reached everyone by the time a failure is reported, so there is
// nothing left to stop. The admin's pause control is the kill switch.
func (s *Service) updateCheckEmergency(ctx context.Context, tr RolloutTrack, snaps []NodeSnapshot, node Node, now int64) (bool, string, error) {
	self := nodeSnapshot(node)
	if !selfupdate.SameVersion(node.Version, tr.TargetVersion) {
		if emergencyRefusesNode(self, tr) {
			return false, "emergency release: this node already reported " + node.UpdateResult, nil
		}
		if err := s.store.CommandNodeUpdate(ctx, node.ID, node.Version, now); err != nil {
			return false, "", err
		}
		return true, "", nil
	}
	// This node is done. Complete the track only when no node we have heard
	// from recently is still behind AND still commandable — same "landed, not
	// just elapsed" rule decideByo's final batch uses, so a straggler is never
	// declared shipped. Nodes this release has given up on (emergencyRefusesNode)
	// are excluded: they are never going to be commanded again, so counting them
	// as in-progress would only keep the track armed forever.
	cutoff := now - int64(nodeOnlineWindow/time.Second)
	for _, n := range snaps {
		if n.LastSeenAt >= cutoff && !selfupdate.SameVersion(n.Version, tr.TargetVersion) &&
			!emergencyRefusesNode(n, tr) {
			return false, "emergency release in progress", nil
		}
	}
	ok, err := s.store.CompleteRolloutTrack(ctx, tr.Track, now)
	if err != nil {
		return false, "", err
	}
	if !ok {
		return false, "rollout state changed before this could be recorded as complete", nil
	}
	return false, "rollout complete", nil
}

// emergencyRefusesNode reports whether the emergency path has given up on n:
// it reported a failure that BELONGS TO THIS RELEASE, so re-commanding it would
// just be a reinstall loop.
//
// All three conditions are needed, and the third is the one that is easy to
// leave out:
//
//   - a failed/rolled_back result at all;
//   - byoWasCommandedForTarget: there is a command record behind that result,
//     and it did not start from the target itself;
//   - UpdateStartedAt >= tr.StageStartedAt: the command it describes was issued
//     by THIS rollout.
//
// The last two together are byoCommandedByThisStage, which the staged BYO
// failure check now shares: both are asking "is this row this release's, or a
// dead one's".
//
// Without the time scope the predicate says nothing about WHICH rollout failed,
// and nothing ever clears nodes.update_result except CommandNodeUpdate — not
// re-register, not heartbeat, and not SetTargetVersion, which does not touch
// node rows at all. So a node carrying a leftover "failed" from an update
// attempt two releases ago was permanently excluded from every future emergency
// release: the operator hit 紧急发布 and that machine silently sat it out, even
// though the STAGED ladder would have re-commanded it (decideFleet/decideByo
// use failures for the halt rate only, never to exclude candidates). Emergency
// was stricter than staging in exactly the place it is supposed to be looser.
//
// StageStartedAt is the right clock because every path that (re)arms emergency
// mode stamps it: SetEmergencyTargetVersion writes it with the row, and
// ResumeRolloutTrack resets it. A command issued before that instant cannot
// have come from the release now in flight.
func emergencyRefusesNode(n NodeSnapshot, tr RolloutTrack) bool {
	if n.UpdateResult != "failed" && n.UpdateResult != "rolled_back" {
		return false
	}
	return byoCommandedByThisStage(n, tr)
}

// rolloutHaltLogPrefix is the greppable marker every halt transition is logged
// under. There is no notification system in this server, and a halted track is
// otherwise visible only to somebody who happens to open /admin -- but the
// fleet ladder runs for ~14h and each BYO batch window is 6h, so a halt can sit
// unnoticed for a day while nothing ships. A single well-known token an
// existing log monitor can alert on is the cheapest honest fix; do not rename
// it without updating whatever greps for it.
const rolloutHaltLogPrefix = "ROLLOUT-HALTED"

// haltRollout stops a track and logs the transition, exactly once.
//
// The log line is emitted ONLY when the store reports the transition actually
// landed (HaltRolloutTrack is conditional on the track still being 'rolling'),
// so a track that several instances all decide to halt in the same second logs
// one line, not one per instance per poll -- and a "halt" decision computed
// against a row that has since completed logs nothing, because nothing halted.
func (s *Service) haltRollout(ctx context.Context, tr RolloutTrack, reason string, at int64) error {
	ok, err := s.store.HaltRolloutTrack(ctx, tr.Track, reason, at)
	if err != nil {
		return err
	}
	if ok {
		log.Printf("%s track=%s target=%s reason=%q", rolloutHaltLogPrefix, tr.Track, tr.TargetVersion, reason)
	}
	return nil
}

// updateCheckFleet runs the fleet state machine and persists whatever it
// decided, then answers the asking node.
func (s *Service) updateCheckFleet(ctx context.Context, tr RolloutTrack, snaps []NodeSnapshot, node Node, now int64) (bool, string, error) {
	d := decideFleet(tr, snaps, now)
	switch d.Action {
	case "halt":
		// Conditional on the track still being 'rolling', and touching only the
		// three halt columns: CurrentNodeID/FirstNodeID are kept for diagnosis,
		// and a whole-row rewrite here could clobber a concurrent instance's
		// halt (or be clobbered by its claim).
		if err := s.haltRollout(ctx, tr, d.Reason, now); err != nil {
			return false, "", err
		}
		return false, d.Reason, nil
	case "complete":
		// Conditional on the track still being 'rolling', same as the halt
		// above: a whole-row rewrite here could report "complete" over a row a
		// concurrent instance just halted (erasing the halt and its reason,
		// and reporting a stopped-bad release as a success), or clobber a
		// concurrent claim, leaving a node commanded while the track says
		// complete so that node's eventual failure is never attributable.
		ok, err := s.store.CompleteRolloutTrack(ctx, tr.Track, now)
		if err != nil {
			return false, "", err
		}
		if !ok {
			// Another instance changed the row since this decision was
			// computed (halted it, claimed it, or completed it already). Do
			// NOT report "complete" as if our decision still held.
			return false, "rollout state changed before this could be recorded as complete", nil
		}
		return false, "rollout complete", nil
	case "update":
		if d.NodeID != node.ID {
			// Somebody else is next. We do NOT claim on their behalf: the slot
			// is claimed by whoever actually polls, which is what keeps the
			// track strictly serial without a lock.
			return false, "another node is next in the rollout queue", nil
		}
		// CLAIM FIRST, ANSWER SECOND, and claim by COMPARE-AND-SWAP. The write
		// only lands if the row still carries the current_node_id AND the
		// target_version this decision was computed from, and is still
		// 'rolling'; a concurrent instance that got there first (with a
		// different candidate set, or with a halt) -- or an admin who retargeted
		// the track in between -- makes this a no-op and the node is told to
		// wait, rather than being commanded to install the version this response
		// was about to name. A whole-row upsert here would silently overwrite
		// that instance's claim or halt.
		first := tr.FirstNodeID
		if d.IsFirst {
			// The canary is positional and cannot be re-derived later; losing
			// it silently downgrades the 6h observation window to 30 minutes.
			first = node.ID
		}
		claimed, err := s.store.ClaimRolloutNode(ctx, tr.Track, tr.TargetVersion, tr.CurrentNodeID, node.ID, first, now)
		if err != nil {
			return false, "", err
		}
		if !claimed {
			return false, "another node claimed the rollout slot first", nil
		}
		// update_from_version is what makes a later result attributable to this
		// rollout, and update_result is cleared so the previous rollout's
		// outcome cannot poison this one.
		if err := s.store.CommandNodeUpdate(ctx, node.ID, node.Version, now); err != nil {
			return false, "", err
		}
		return true, "", nil
	default: // "wait"
		// The machine says wait, but this node may already HOLD the claim — an
		// updater that restarted mid-update must be told to carry on, or the
		// track sits until the silence check halts it.
		//
		// tr.TargetVersion != "" repeats decideFleet's own guard: it answers
		// "wait" for a rolling track with no target precisely so nobody is told
		// to install the empty version, and resuming past that would route
		// straight around the defence (Eligible with an empty TargetVersion).
		if tr.CurrentNodeID == node.ID && node.UpdateResult == "" &&
			tr.TargetVersion != "" &&
			!selfupdate.SameVersion(node.Version, tr.TargetVersion) {
			if node.UpdateStartedAt == 0 {
				// The claim was persisted but the node's own stamp was not
				// (a crash between the two writes). Repair it, starting the
				// timeout clock below fresh; never re-stamp an ALREADY-set
				// one, which would reset that clock on every poll and make a
				// wedged node undetectable.
				if err := s.store.CommandNodeUpdate(ctx, node.ID, node.Version, now); err != nil {
					return false, "", err
				}
				return true, "", nil
			}
			// Bound the resume by ELAPSED WALL CLOCK time since the update was
			// commanded, not by how many times this node has polled. A
			// poll-count budget is cadence-dependent -- the poll interval is
			// entirely client-side -- so it can be burned in seconds by a
			// crash-restart loop (or by replaying the in-flight node's ID
			// against the shared fleet token), while a genuinely slow download
			// on a thin link can exceed it on an otherwise healthy rollout.
			// now-node.UpdateStartedAt has neither problem, and reuses
			// updateSilenceLimit: a node that fails to install, reports
			// nothing and keeps heartbeating is never SILENT (so decideFleet's
			// own brick check can never fire against it), but it gets exactly
			// the same wall-clock budget a silent node does before the track
			// gives up and halts for a human.
			if now-node.UpdateStartedAt > updateSilenceLimit {
				reason := fmt.Sprintf("node %s has been resuming its update for over %d seconds without ever reporting a result",
					node.ID, updateSilenceLimit)
				if err := s.haltRollout(ctx, tr, reason, now); err != nil {
					return false, "", err
				}
				return false, reason, nil
			}
			return true, "", nil
		}
		return false, "waiting for the current stage to finish", nil
	}
}

// updateCheckByo runs the byo state machine and persists whatever it decided.
// Unlike the fleet track it commands a whole batch at once, so the answer to
// the asking node is "were you in that batch".
func (s *Service) updateCheckByo(ctx context.Context, tr RolloutTrack, snaps []NodeSnapshot, node Node, now int64) (bool, string, error) {
	action, eligible, reason := decideByo(tr, snaps, now)
	switch action {
	case "halt":
		// Conditional on the track still being 'rolling' — see the fleet path:
		// a whole-row rewrite can lose another instance's halt, and a halt is
		// the one write that must never be lost.
		if err := s.haltRollout(ctx, tr, reason, now); err != nil {
			return false, "", err
		}
		// The detailed reason (e.g. "4/17 nodes in the 10% batch failed") is
		// stored in HaltedReason for the admin, but is never handed back to the
		// polling node here: unlike the fleet path — fleet-token-only, and
		// naming fleet node IDs an operator already controls — this is reached
		// by any authenticated BYO node, and the detailed message discloses how
		// many BYO nodes exist globally and how many of them are failing.
		return false, "rollout paused", nil
	case "complete":
		// Conditional on the track still being 'rolling', same rationale as the
		// fleet path's "complete" case: a whole-row rewrite could report
		// "complete" over a row a concurrent instance just halted, erasing the
		// halt and its reason.
		ok, err := s.store.CompleteRolloutTrack(ctx, tr.Track, now)
		if err != nil {
			return false, "", err
		}
		if !ok {
			return false, "rollout state changed before this could be recorded as complete", nil
		}
		return false, "rollout complete", nil
	case "update":
		// Persist the newly-opened batch and restart the observation window
		// BEFORE commanding anyone: StageStartedAt is what gates the next,
		// wider batch, and a batch opened but not recorded would re-open (and
		// re-command) on every single poll. This is a compare-and-swap, not a
		// blind write: it only lands if the row is STILL 'rolling', STILL
		// at the batch percentage (tr.ByoBatch) AND still on the target version
		// this decision was computed from. Dropping any of those reproduces the
		// worst finding in this package -- a concurrent halt (computed from the same
		// pre-halt read) silently resurrected, AND the ladder jumped straight
		// to the wider batch in the same write, reaching a release the failure
		// check had already decided to stop. See AdvanceByoBatch's doc comment.
		toBatch := nextByoBatch(tr.ByoBatch)
		advanced, err := s.store.AdvanceByoBatch(ctx, tr.Track, tr.TargetVersion, tr.ByoBatch, toBatch, now)
		if err != nil {
			return false, "", err
		}
		if !advanced {
			// Another instance already halted, completed, or advanced the
			// track since this decision was computed. Do NOT command anyone
			// off a decision that no longer matches persisted state.
			return false, "rollout state changed before this batch could be opened", nil
		}
		byID := make(map[string]NodeSnapshot, len(snaps))
		for _, n := range snaps {
			byID[n.ID] = n
		}
		mine := false
		for _, id := range eligible {
			if err := s.store.CommandNodeUpdate(ctx, id, byID[id].Version, now); err != nil {
				// One unwritable row must not abort the whole batch; it simply
				// never counts as commanded (and so never as a failure).
				log.Printf("rollout byo: commanding node %s failed: %v", id, err)
				continue
			}
			if id == node.ID {
				mine = true
			}
		}
		if mine {
			return true, "", nil
		}
		return false, "not in the batch currently open", nil
	default: // "wait"
		// A batch opens once per window but nodes poll every 30s, so almost
		// every poll from a node that IS in the open batch lands here and must
		// still be told to carry on.
		//
		// Membership of the CURRENTLY-OPEN batch is the gate, and it is not
		// optional. The node's own update_from_version is NOT a substitute:
		// byoWasCommandedForTarget only asks "was this node ever commanded away
		// from some other version", with no notion of which rollout. Starting a
		// new rollout resets the track's ByoBatch but never clears the per-node
		// update_* columns, and update_result == "" is the NORMAL state (nothing
		// on the node side reports results yet) — so answering from those two
		// alone told EVERY node still carrying the previous rollout's command
		// record that it could update on its first poll, batch ladder skipped
		// and 100% of BYO machines moving in one poll cycle. That is the exact
		// property the 10/50/100 ladder exists to provide.
		if byoOpenBatchMembers(tr, snaps)[node.ID] &&
			node.UpdateResult == "" &&
			byoWasCommandedForTarget(nodeSnapshot(node), tr.TargetVersion) &&
			!selfupdate.SameVersion(node.Version, tr.TargetVersion) {
			return true, "", nil
		}
		return false, "waiting for the next batch", nil
	}
}

// nextByoBatch is the percentage decideByo just opened, mirroring its own
// "next entry after tr.ByoBatch" walk: 0 means nothing has opened yet, and a
// value past the end stays at the widest batch. decideByo halts on an
// unrecognised percentage before ever returning "update", so the fallback here
// is only ever reached for the final batch.
func nextByoBatch(cur int) int {
	if cur == 0 {
		return byoBatches[0]
	}
	for i, pct := range byoBatches {
		if pct == cur && i+1 < len(byoBatches) {
			return byoBatches[i+1]
		}
	}
	return byoBatches[len(byoBatches)-1]
}

// nodeSnapshot projects a stored node onto what the rollout state machines
// read. ActiveTransfers comes straight from the nodes row, which the heartbeat
// writes (see Node.ActiveTransfers): this line is the LAST link in the chain
// that makes decideFleet's canary pick genuinely load-aware, so dropping it
// silently returns the pick to the fleetHash order without breaking anything
// that would show up as an error.
func nodeSnapshot(n Node) NodeSnapshot {
	return NodeSnapshot{
		ID: n.ID, Version: n.Version, LastSeenAt: n.LastSeenAt,
		ActiveTransfers: n.ActiveTransfers,
		UpdateStartedAt: n.UpdateStartedAt, UpdateFromVersion: n.UpdateFromVersion,
		UpdateResult: n.UpdateResult,
	}
}

func nodeSnapshots(nodes []Node) []NodeSnapshot {
	out := make([]NodeSnapshot, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, nodeSnapshot(n))
	}
	return out
}

// isVersionDowngrade reports whether target is strictly OLDER than current.
// Both must be plain release tags; anything else (a "dev" build, a pre-release)
// is incomparable and answers false, so a downgrade is never authorised on a
// guess.
func isVersionDowngrade(current, target string) bool {
	if !selfupdate.IsPlainVersion(current) || !selfupdate.IsPlainVersion(target) {
		return false
	}
	c, cok := plainVersionParts(current)
	tv, tok := plainVersionParts(target)
	if !cok || !tok {
		return false
	}
	for i := 0; i < 3; i++ {
		if tv[i] != c[i] {
			return tv[i] < c[i]
		}
	}
	return false
}

// plainVersionParts splits a "vMAJOR.MINOR.PATCH" tag into its numeric parts.
// Only ever called behind selfupdate.IsPlainVersion, which has already accepted
// the string; ok=false is defence in depth, not an expected path.
func plainVersionParts(s string) ([3]int, bool) {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// handleDownloadReceipt reconciles a direct-download's metering: central
// pre-metered the whole file size when it issued the 302, so a fleet node
// reports how many bytes it actually served and central refunds the owner the
// over-metered difference (partial/aborted downloads). Idempotent per receipt
// nonce so a re-sent receipt can't double-refund; servedBytes is clamped to the
// file size so a receipt can only ever refund, never charge. Fleet-only (BYO
// direct download and its receipts are a later phase).
func (s *Service) handleDownloadReceipt(w http.ResponseWriter, r *http.Request) {
	ownerType, _, ok := s.nodeOwner(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if ownerType != "fleet" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		BlobKey     string `json:"blobKey"`
		Nonce       string `json:"nonce"`
		ServedBytes int64  `json:"servedBytes"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Nonce == "" || req.BlobKey == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	now := s.now().Unix()
	// Idempotency: only the first receipt for this nonce reconciles.
	first, err := s.store.ClaimDownloadReceipt(r.Context(), req.Nonce, now)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !first {
		w.WriteHeader(http.StatusOK) // duplicate — already reconciled
		return
	}
	sf, err := s.store.GetStoredFileByBlobKey(r.Context(), req.BlobKey)
	if err != nil {
		// File gone (deleted/expired) or unknown key: nothing to reconcile. The
		// pre-charge stands (safe over-charge). ACK so the node stops retrying.
		w.WriteHeader(http.StatusOK)
		return
	}
	served := req.ServedBytes
	if served < 0 {
		served = 0
	}
	if served > sf.Size {
		served = sf.Size // clamp: a receipt can only refund, never charge
	}
	if refund := sf.Size - served; refund > 0 {
		_ = s.store.RecordMeter(r.Context(), sf.UserID, MeterDownload, -refund, now)
		_ = s.store.AddDownloadStat(r.Context(), sf.UserID, -refund)
	}
	w.WriteHeader(http.StatusOK)
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
	if ft, found, err := s.store.FleetTokenByHash(r.Context(), authx.HashToken(tok)); err == nil && found {
		_ = s.store.TouchFleetTokenUsed(r.Context(), ft.ID, s.now().Unix())
		return "fleet", "", true
	}
	if s.cfg.EnableUserNodes {
		if nt, found, err := s.store.NodeTokenByHash(r.Context(), authx.HashToken(tok)); err == nil && found {
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
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req nodeRegisterReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.TURNSecret == "" || len(req.URLs) == 0 {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "turnSecret and urls required"})
		return
	}
	// StorageURL is user-controlled and central makes outbound calls to it;
	// reject non-public / malformed endpoints to prevent SSRF.
	if req.StorageURL != "" {
		if err := validateNodeStorageURL(req.StorageURL, s.allowPrivateNodeURLs); err != nil {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	// Prevent node-ID takeover: a re-register of an existing node id must come from
	// the SAME owner. A fleet token may only re-register a fleet node; a user token
	// may only re-register its own user node. Unknown ids fall through as new nodes.
	var existing Node
	var existingFound bool
	if req.NodeID != "" {
		e, found, gerr := s.store.GetNode(r.Context(), req.NodeID)
		if gerr != nil {
			httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
			return
		}
		if !found && !validNodeID(req.NodeID) {
			// A BRAND-NEW id must match the charset/length central itself
			// generates (authx.NewID(): 16 random bytes, lowercase hex). Nothing here
			// lets an attacker impersonate an admin — the audit actor is always
			// "node:<id>" with auth=node-token, and the audit page auto-escapes
			// — but with no check at all, an arbitrary client-supplied id like
			// "admin" becomes that actor string (nodeAuditActor), which is
			// reachable for no good reason: central never generates an id like
			// that, so nothing legitimate is lost by rejecting one. An EXISTING
			// id is exempt (checked below by the ownership guard instead): every
			// node id already in the store was either generated by authx.NewID() or
			// has already passed this same check on some earlier registration.
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid node id"})
			return
		}
		if found {
			existing, existingFound = e, true
			mismatch := existing.OwnerType != ownerType ||
				(ownerType == "user" && existing.OwnerUserID != ownerUserID)
			if mismatch {
				httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "node id belongs to another owner"})
				return
			}
			// A deregistered node id coming back is worth shouting about. Upsert
			// preserves removed_at, so the node will run and heartbeat while being
			// invisible to placement, ICE and downloads — a silent failure unless
			// something says so. Two ways in: a restored state.json on a rebuilt
			// machine, or a node deregistered by mistake (the shared fleet token
			// does not bind to a node id, so one bad call can name any node).
			//
			// We log and let the registration through rather than rejecting it.
			// Register happens ONCE at startup, so a rejection is fatal to the
			// node process, and systemd's Restart=always then crash-loops it — a
			// fleet-wide accidental deregistration would take every node DOWN
			// instead of merely making it invisible, which is strictly worse. A
			// removed node is already excluded from every pool, so letting it run
			// costs nothing, and an admin undoes the mistake in one click with the
			// "restore" control, which keeps the row's history intact.
			if existing.RemovedAt != 0 {
				log.Printf("node %s: WARNING — registering a node id that was deregistered (uninstalled) at %d; it will run but stays excluded from placement, ICE and downloads until an admin restores it in the Relayium panel", req.NodeID, existing.RemovedAt)
			}
		}
	}
	// Pin ratchet: once a node has reported a TLS fingerprint, a re-register must
	// not silently drop the central↔node blob channel back to plaintext (empty FP
	// or a non-https URL). A leaked fleet token or a rolled-back node binary would
	// otherwise downgrade a pinned channel to a sniffable bearer with no trace.
	// Retain the last-known-good storage config (URL/secret/FP) and log it; every
	// other field still updates. A legit node keeps a stable identity fingerprint,
	// so this never fires for it.
	storeURL, storeSecret, storeFP := req.StorageURL, req.StorageSecret, req.StorageFP
	if existingFound && existing.StorageFP != "" &&
		(storeFP == "" || !strings.HasPrefix(strings.ToLower(storeURL), "https://")) {
		log.Printf("node %s: refusing storage pin downgrade (fp %q→%q, url %q→%q); retaining prior pinned config",
			req.NodeID, existing.StorageFP, storeFP, existing.StorageURL, storeURL)
		storeURL, storeSecret, storeFP = existing.StorageURL, existing.StorageSecret, existing.StorageFP
	}
	// Resolve the presented token once: its name seeds the node's initial label
	// (only used on first INSERT — UpsertNode preserves a later rename), and its
	// id binds the token to the node for per-node revoke/delete.
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	var userTok *NodeToken
	var fleetTok *FleetToken
	label := ""
	if ownerType == "user" {
		if nt, found, e := s.store.NodeTokenByHash(r.Context(), authx.HashToken(tok)); e == nil && found {
			userTok = &nt
			label = nt.Name
		}
	} else if ft, found, e := s.store.FleetTokenByHash(r.Context(), authx.HashToken(tok)); e == nil && found {
		fleetTok = &ft
		label = ft.Name
	}
	// DownloadURL is honored for fleet AND user (BYO) nodes, but only when it's a
	// valid https URL — central 302s clients there, so a plaintext or malformed
	// value must never become a redirect target. A BYO node setting this is the
	// user's opt-in to serving their own files directly (exposing their node's
	// address to downloaders); the URL must carry a browser-trusted cert (their
	// own domain), which is on them. Anything else is dropped to "" (central proxies).
	downloadURL := ""
	if (ownerType == "fleet" || ownerType == "user") && isHTTPSURL(req.DownloadURL) {
		downloadURL = req.DownloadURL
	}
	now := s.now().Unix()
	n := Node{
		ID: req.NodeID, OwnerType: ownerType, OwnerUserID: ownerUserID, Label: label,
		Region: req.Region, URLs: req.URLs, TURNSecret: req.TURNSecret, Version: req.Version,
		CreatedAt: now, LastSeenAt: now,
		StorageURL: storeURL, StorageSecret: storeSecret, StorageFP: storeFP,
		StorageEnabled: containsCap(req.Capabilities, "storage"),
		StorageTotal:   req.StorageTotal, StorageFree: req.StorageFree,
		DownloadURL: downloadURL,
		// -1: no load signal yet. Only takes effect on a first INSERT — UpsertNode's
		// ON CONFLICT clause omits active_transfers, so a re-register never
		// touches an existing row's real reading (see Node.ActiveTransfers).
		ActiveTransfers: -1,
	}
	saved, err := s.store.UpsertNode(r.Context(), n)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	// Bind the presented token to its node for per-node revoke/delete.
	if userTok != nil {
		_ = s.store.BindNodeToken(r.Context(), userTok.ID, saved.ID)
	} else if fleetTok != nil {
		// An admin-minted fleet token (not the shared env token) binds to its node.
		_ = s.store.BindFleetToken(r.Context(), fleetTok.ID, saved.ID)
	}
	httpx.WriteJSON(w, http.StatusOK, nodeRegisterResp{
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
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req nodeHeartbeatReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.NodeID == "" {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "nodeID required"})
		return
	}
	// A node unknown to us (DB reset / never registered) is told to re-register
	// with 410 Gone.
	node, known, err := s.store.GetNode(r.Context(), req.NodeID)
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !known {
		httpx.WriteJSON(w, http.StatusGone, map[string]string{"error": "unknown node, re-register"})
		return
	}
	// A user token may only heartbeat a node it owns (a fleet token may heartbeat any fleet node).
	if ownerType == "user" && (node.OwnerType != "user" || node.OwnerUserID != ownerUserID) {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "not your node"})
		return
	}
	// ...and the mirror check, which deregister/update-check already had and this
	// endpoint did not. A fleet token is not bound to a node id, so without this a
	// fleet credential could heartbeat someone else's BYO node: forge LastSeenAt
	// (keep a dead node "online"), StorageFree (steer where uploads land) and
	// ActiveTransfers (steer which node gets canary builds first). Every one of
	// those is a user-visible lie about hardware the caller does not own.
	if ownerType == "fleet" && node.OwnerType != "fleet" {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{"error": "not a fleet node"})
		return
	}
	billable := node.OwnerType == "fleet"
	now := s.now().Unix()
	// -1: "this heartbeat carried no load signal" — an old binary that omits
	// the JSON key decodes req.ActiveTransfers as a nil pointer. Real reports
	// are clamped non-negative: the count is self-reported, and a negative
	// value would rank the node as MORE idle than a genuinely idle one in
	// canaryRank — i.e. a node could volunteer itself to receive every new
	// build first. Clamping costs nothing and makes that impossible; an
	// inflated positive value only ever moves a node further back in the
	// queue.
	active := -1
	if req.ActiveTransfers != nil {
		active = *req.ActiveTransfers
		if active < 0 {
			active = 0
		}
	}
	if err := s.store.TouchNode(r.Context(), req.NodeID, req.RelayedTotal, req.StoredBytes, req.StorageTotal, req.StorageFree, now, active); err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	// 单次心跳给单个用户记了多少（用于下面的异常告警）。
	attributed := map[string]int64{}
	// 单次心跳给单个用户记了多少**条**。这是限幅真正的刀口，见 maxAllocsPerUser。
	entries := map[string]int{}
	clamped := map[string]bool{}

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
		// 限幅（报告 M1，方案 C）。跨用户伪造的既有防线对"过期/未知的码"是
		// "无法反驳即接受"，所以持车队凭据的人仍然能给别人记账。真正的封堵要在
		// 签发凭据时嵌不可伪造的归因标签，那要动计费链路；在那之前先把**单次爆发**
		// 压下去。
		//
		// 卡的是条数而不是字节数，因为：
		//   · 每条 usage 的字节已经被 RecordUsage 钳在约 3.25 GiB，攻击者要凑出
		//     20 TB 靠的是**换 7000 个新 allocID**——条数才是杠杆；
		//   · RecordUsage 是按 allocID keep-max 的，所以一次心跳里的字节和是**累计值**
		//     不是增量。按字节做"每秒多少"的折算会把一个跑了很久的长传输当成异常，
		//     那是最典型的误伤。
		//
		// 代价是明确的：一个用户在单个窗口里通过同一个节点真的有超过 64 条分配时
		// （比如脚本化地连开几十个传输，或节点掉线一小时后补报），超出的部分**不计入
		// 他的配额**。方向是偏向用户的（少计而不是多计），并且会打日志。
		if entries[userID] >= maxAllocsPerUser {
			if !clamped[userID] {
				clamped[userID] = true
				log.Printf("WARNING: node %s reported >%d allocations for user %s in one heartbeat — attribution clamped (possible forgery; see M1)",
					req.NodeID, maxAllocsPerUser, userID)
			}
			continue
		}
		entries[userID]++
		if err := s.store.RecordUsage(r.Context(), UsageEvent{
			AllocID: u.AllocID, Token: code, UserID: userID, RelayedBytes: u.RelayedBytes,
			RecordedAt: now, NodeID: req.NodeID, Billable: billable,
		}); err != nil {
			// Log-and-continue: one bad alloc must not drop the rest.
			log.Printf("node %s heartbeat: record alloc %s failed: %v", req.NodeID, u.AllocID, err)
		}
		if u.RelayedBytes > 0 {
			attributed[userID] += u.RelayedBytes
		}
	}
	warnImplausibleAttribution(req.NodeID, len(req.Usage), attributed)
	httpx.WriteJSON(w, http.StatusOK, nodeHeartbeatResp{
		OK: true, HeartbeatInterval: nodeHeartbeatInterval,
		nodeLimits: s.nodeLimitsFor(r.Context(), node),
	})
}

// SetNodeDraining is the operator-facing entry point for the first half of a
// safe node uninstall: it takes a node OUT of new-upload placement (see
// StorageNodes/UserStorageNodes) while leaving everything else — including its
// existing files' download path — untouched, so they can reach their full TTL
// before the machine is removed. on=false reverses it, putting the node back
// in the placement pool.
func (s *Service) SetNodeDraining(ctx context.Context, nodeID string, on bool) error {
	return s.store.SetNodeDraining(ctx, nodeID, on)
}

// maxAllocsPerUser 是单次心跳里、单个节点能为**同一个用户**记账的分配条数上限。
//
// 真实数字是个位数：一次传输对应一到两个中继分配，而心跳周期只有 30 秒。64 给
// 长时间掉线后补报留了足够余量，同时把伪造的天花板从约 20 TB（7000 条 × 3.25 GiB）
// 压到约 208 GiB——两个数量级，而且每次触顶都会在日志里叫。
const maxAllocsPerUser = 64

// implausiblePerHeartbeat 是"一次心跳给一个用户记的量"的可信上限。
//
// 心跳周期是 30 秒。一个 10 Gbps 满速跑满 30 秒的节点也只有约 37 GiB，而且那还是
// 它**所有**用户加起来的量。128 GiB 因此远高于任何真实的单用户单周期数字，同时又
// 远低于伪造能达到的量级：一个 1 MiB 的心跳体能塞进约 7000 条 usage，每条各带一个
// 新的 allocID 绕过单条钳制，一次就能给受害者记上约 20 TB。
const implausiblePerHeartbeat = 128 << 30

// implausibleUsageCount 是单次心跳里 usage 条数的可信上限。真实节点在 30 秒里不会
// 有几千个并发中继分配；条数本身就是一个比字节数更早暴露的信号。
const implausibleUsageCount = 512

// warnImplausibleAttribution 在归因量级不像真的时喊一声。
//
// **不改计费**：跨用户伪造的既有防线（pairCodeOwner 比对）对**过期/未知**的码是
// "无法反驳即接受"，所以持有节点凭据的人仍然可以给别人记账。真正的修复是让中心
// 在签发凭据时嵌一个不可伪造的归因标签（报告 M1），那要动计费链路。在那之前，
// 至少别让这件事发生得**完全无声**——一条日志就是"被记了 20 TB"和"有人在记 20 TB"
// 的区别。
func warnImplausibleAttribution(nodeID string, entries int, attributed map[string]int64) {
	if entries > implausibleUsageCount {
		log.Printf("WARNING: node %s reported %d usage entries in one heartbeat (>%d) — possible forged attribution",
			nodeID, entries, implausibleUsageCount)
	}
	for userID, bytes := range attributed {
		if bytes > implausiblePerHeartbeat {
			log.Printf("WARNING: node %s attributed %d bytes to user %s in one heartbeat (>%d) — implausible for a %ds window, possible forged attribution",
				nodeID, bytes, userID, int64(implausiblePerHeartbeat), nodeHeartbeatInterval)
		}
	}
}
