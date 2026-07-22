package account

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/selfupdate"
)

// rolloutPanelView is ONE track's panel: its own target version, status, halt
// reason, progress and node rows, plus the track name its own control forms
// post to.
//
// There are two of these on the dashboard and they are built by two separate,
// independent calls to rolloutPanel — never one shared read, never one shared
// form with a track selector. That is not a style preference: the whole point
// of two tracks is that a halted, wedged or unreadable BYO rollout cannot stop
// the fleet from shipping, and a UI that couples them (one form, one error
// path, one state object) hands that property straight back. If a panel cannot
// be built, Err is set on THAT panel only and the other one renders as usual.
type rolloutPanelView struct {
	Track string // "fleet" | "byo" — goes straight into this panel's form actions
	Title string
	// Err marks a panel whose state could not be read. Its controls are hidden
	// (acting on state we could not read is how an operator makes things
	// worse), which must never affect the other panel.
	Err bool
	// Configured is false when no rollout has ever been started on this track.
	Configured     bool
	TargetVersion  string
	Status         string // raw "rolling" | "halted" | "complete"
	StatusText     string // Chinese label for the above
	HaltedReason   string
	Emergency      bool
	StageStartedAt int64
	// CurrentNodeID (fleet) is the node in flight; ByoBatch (byo) is the batch
	// percentage currently open. Each is meaningless on the other track, and
	// the template only renders the one that belongs to this panel.
	CurrentNodeID string
	ByoBatch      int
	OnTarget      int // nodes already running TargetVersion
	Total         int
	Nodes         []rolloutNodeView
}

// rolloutNodeView is one machine's row inside a panel: enough to diagnose a
// halt without opening the database — what it runs, what it was told to
// install, and what it reported back.
type rolloutNodeView struct {
	ID                string
	Label             string
	Version           string
	Online            bool
	OnTarget          bool
	UpdateFromVersion string
	UpdateStartedAt   int64
	Result            string // raw update_result
	ResultText        string // Chinese label
	Current           bool   // fleet: this node holds the rollout slot
	InBatch           bool   // byo: this node is in the batch currently open
}

// rolloutStatusText maps the stored status onto the panel's label. An empty
// status (a row that exists but was never started) reads as 未启动 rather than
// rendering blank.
func rolloutStatusText(status string, configured bool) string {
	if !configured {
		return "未启动"
	}
	switch status {
	case "rolling":
		return "发布中"
	case "halted":
		return "已中止"
	case "complete":
		return "已完成"
	default:
		return "未启动"
	}
}

// rolloutResultText maps nodes.update_result onto its label. "" is the normal
// state for a node that was never commanded, so it must not read as an error.
func rolloutResultText(result string) string {
	switch result {
	case "ok":
		return "成功"
	case "failed":
		return "更新失败"
	case "rolled_back":
		return "已回滚"
	case "skipped":
		return "已跳过"
	default:
		return "—"
	}
}

// validRolloutTrack mirrors SetTargetVersion's own track check for the paths
// that never reach it (pause/resume act on the store directly). Without it an
// unknown track name would silently no-op an UPDATE and report success.
func validRolloutTrack(track string) bool { return track == "fleet" || track == "byo" }

// rolloutOwnerClass maps a track to the nodes.owner_type it governs. The owner
// type IS the track (see handleUpdateCheck): our machines roll on "fleet",
// users' machines on "byo", and neither is ever read across.
func rolloutOwnerClass(track string) string {
	if track == "byo" {
		return "user"
	}
	return "fleet"
}

// rolloutPanel builds one track's panel. It reads that track's row and that
// track's nodes and NOTHING ELSE — in particular it never touches the other
// track, so neither the data nor the failure modes of the two panels are
// shared. Any read failure degrades to Err on this panel alone.
func (s *Service) rolloutPanel(ctx context.Context, track, title string, now time.Time) rolloutPanelView {
	p := rolloutPanelView{Track: track, Title: title}
	tr, found, err := s.store.GetRolloutTrack(ctx, track)
	if err != nil {
		log.Printf("admin: GetRolloutTrack(%s) failed: %v", track, err)
		p.Err = true
		return p
	}
	nodes, nerr := s.store.NodesByOwnerType(ctx, rolloutOwnerClass(track))
	if nerr != nil {
		log.Printf("admin: NodesByOwnerType(%s) failed: %v", rolloutOwnerClass(track), nerr)
		p.Err = true
		return p
	}

	p.Configured = found
	p.TargetVersion, p.Status = tr.TargetVersion, tr.Status
	p.StatusText = rolloutStatusText(tr.Status, found)
	p.HaltedReason, p.Emergency = tr.HaltedReason, tr.Emergency
	p.StageStartedAt, p.CurrentNodeID, p.ByoBatch = tr.StageStartedAt, tr.CurrentNodeID, tr.ByoBatch

	snaps := nodeSnapshots(nodes)
	// Batch membership is derived, not stored per node; byoOpenBatchMembers is
	// the same ordering/prefix decideByo uses, so the panel cannot disagree
	// with what the endpoint will actually allow.
	inBatch := map[string]bool{}
	if track == "byo" && found {
		inBatch = byoOpenBatchMembers(tr, snaps)
	}
	cutoff := now.Add(-nodeOnlineWindow).Unix()
	p.Total = len(nodes)
	for _, n := range nodes {
		onTarget := tr.TargetVersion != "" && selfupdate.SameVersion(n.Version, tr.TargetVersion)
		if onTarget {
			p.OnTarget++
		}
		p.Nodes = append(p.Nodes, rolloutNodeView{
			ID: n.ID, Label: n.Label, Version: n.Version,
			Online: n.LastSeenAt >= cutoff, OnTarget: onTarget,
			UpdateFromVersion: n.UpdateFromVersion, UpdateStartedAt: n.UpdateStartedAt,
			Result: n.UpdateResult, ResultText: rolloutResultText(n.UpdateResult),
			Current: track == "fleet" && n.ID == tr.CurrentNodeID && tr.CurrentNodeID != "",
			InBatch: inBatch[n.ID],
		})
	}
	return p
}

// renderAdminRolloutError re-renders the dashboard with msg in a banner and the
// given status, so a rejected control (a bad version, the byo-behind-fleet
// gate, pausing a track that is not rolling) reaches the operator as readable
// text on the page they were just looking at — instead of a bare 500 or, worse,
// a redirect that looks exactly like success.
func (s *Service) renderAdminRolloutError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	data, err := s.buildAdminHomeData(r)
	if err != nil {
		// The dashboard itself is unbuildable; the operator still has to be
		// told why their action was refused.
		http.Error(w, msg, status)
		return
	}
	data.RolloutError = msg
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := adminUsersTmpl.Execute(w, data); err != nil {
		log.Printf("admin: rendering rollout error page failed: %v", err)
	}
}

// handleAdminRolloutTarget points a track at a new version, starting a staged
// rollout. handleAdminRolloutRollback is the same operation aimed backwards; it
// is a separate route/action purely so the audit trail (and the UI) can tell
// "shipping v1.3.0" from "getting off v1.3.0", which is the fact an incident
// review actually needs.
func (s *Service) handleAdminRolloutTarget(w http.ResponseWriter, r *http.Request) {
	s.rolloutSetVersion(w, r, AuditRolloutTarget)
}

func (s *Service) handleAdminRolloutRollback(w http.ResponseWriter, r *http.Request) {
	s.rolloutSetVersion(w, r, AuditRolloutRollback)
}

// rolloutSetVersion routes both through SetTargetVersion, which is the ONLY
// way a target changes: it owns the track-name and version validation and the
// one-way byo-behind-fleet gate. This handler never re-implements or bypasses
// any of that — it only turns the error into something an admin can read.
//
// Note what is NOT here: any read of the OTHER track. For track == "fleet"
// SetTargetVersion consults nothing but the fleet row, so a byo track that is
// halted, wedged, or pointed at a broken build cannot make this fail.
func (s *Service) rolloutSetVersion(w http.ResponseWriter, r *http.Request, action string) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	version := strings.TrimSpace(r.FormValue("version"))
	// Best-effort before-image for the audit diff; an unknown track simply has
	// none, and SetTargetVersion rejects it a line later anyway.
	before, _, _ := s.store.GetRolloutTrack(r.Context(), track)
	if err := s.SetTargetVersion(r.Context(), track, version); err != nil {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "目标版本设置失败："+err.Error())
		return
	}
	s.writeAudit(r, action, "rollout:"+track, []ChangeField{
		{Field: "target_version", Old: before.TargetVersion, New: version},
		{Field: "status", Old: before.Status, New: "rolling"},
	}, StepUpNone)
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminRolloutPause stops a track where it is. It is the kill switch for
// a release that is going wrong — including an emergency one — because every
// decision path in the package treats a track that is not 'rolling' as inert.
func (s *Service) handleAdminRolloutPause(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	if !validRolloutTrack(track) {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "暂停失败：未知轨道 "+track)
		return
	}
	// HaltRolloutTrack is conditional on the track still being 'rolling', so a
	// track another instance just completed is not resurrected as halted.
	ok, err := s.store.HaltRolloutTrack(r.Context(), track, "管理员手动暂停", s.now().Unix())
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "暂停失败："+err.Error())
		return
	}
	if !ok {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "暂停失败：该轨道当前不在发布中")
		return
	}
	s.writeAudit(r, AuditRolloutPause, "rollout:"+track,
		[]ChangeField{{Field: "status", Old: "rolling", New: "halted"}}, StepUpNone)
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminRolloutResume restarts a halted track on the version it already
// targets. It goes through ResumeRolloutTrack rather than SetTargetVersion
// precisely so it cannot be blocked by the other track: see that method's doc
// comment for why resuming byo through the gate would make an unrelated fleet
// release silently un-resumable.
func (s *Service) handleAdminRolloutResume(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	if !validRolloutTrack(track) {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "继续失败：未知轨道 "+track)
		return
	}
	ok, err := s.store.ResumeRolloutTrack(r.Context(), track, s.now().Unix())
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "继续失败："+err.Error())
		return
	}
	if !ok {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "继续失败：该轨道当前不是已中止状态")
		return
	}
	s.writeAudit(r, AuditRolloutResume, "rollout:"+track,
		[]ChangeField{{Field: "status", Old: "halted", New: "rolling"}}, StepUpNone)
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminRolloutEmergency releases the whole track at once: it sets the
// target the normal way and then arms emergency mode, which makes the update
// check bypass the staged ladder for every node of this track (see
// RolloutTrack.Emergency and updateCheckEmergency).
//
// It is registered behind requireStepUp, so by the time this runs the operator
// has seen a confirmation page naming the version and the fact that staging is
// skipped, and has re-presented a second factor; handleAdminConfirm writes the
// audit entry (rollout.emergency, target rollout:<track>, with the factor that
// satisfied the step-up) once this returns a non-error status. This handler
// must therefore NOT write its own audit entry — that would double-log it, and
// log it without the factor.
//
// The one thing an emergency does NOT skip is the byo-behind-fleet gate: it
// still goes through SetTargetVersion. Skipping the ladder is a decision about
// speed on OUR machines; pushing users' machines a build our own fleet has
// never run is a different promise, and an emergency is not a reason to break
// it. Emergency-release the fleet first, then byo.
func (s *Service) handleAdminRolloutEmergency(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	track := r.PathValue("id")
	version := strings.TrimSpace(r.FormValue("version"))
	if err := s.SetTargetVersion(r.Context(), track, version); err != nil {
		s.renderAdminRolloutError(w, r, http.StatusBadRequest, "紧急发布失败："+err.Error())
		return
	}
	// Compare-and-swap against the version just written: if anything moved the
	// track in between, nothing is released.
	ok, err := s.store.SetRolloutEmergency(r.Context(), track, version, s.now().Unix())
	if err != nil {
		s.renderAdminRolloutError(w, r, http.StatusInternalServerError, "紧急发布失败："+err.Error())
		return
	}
	if !ok {
		s.renderAdminRolloutError(w, r, http.StatusConflict,
			"紧急发布失败：轨道状态在确认期间发生了变化，请重新确认")
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}
