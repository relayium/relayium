package account

import (
	"context"
	"errors"
	"net/http"
)

// stepUpCtxKey is the unexported context-key type stepUpDoneKey is built
// from. An unexported struct type (rather than a bare string) means no other
// package — and no accidental second definition in this one — can ever
// collide with it via context.WithValue, since context keys compare by
// (dynamic type, value).
type stepUpCtxKey struct{}

// stepUpDoneKey marks a request that HandleAdminConfirm has already resolved
// (pending action taken, original form restored onto the request) and is now
// forwarding to the real handler. RequireStepUp checks for this and, when
// present, lets the request straight through instead of intercepting it
// again — without it, the forwarded POST would just mint a second pending
// action and re-render the confirm page instead of ever applying anything.
var stepUpDoneKey = stepUpCtxKey{}

// confirmNowCtxKey / confirmNowKey pin ONE instant for one confirmation.
//
// HandleAdminConfirm computes the audit's before/after image and then runs the
// handler that actually writes. Both used to read the clock independently, which
// is harmless for an action whose written value does not contain a timestamp —
// and wrong for one that does. A time-bounded grant's expiry is derived from
// "now", so two reads either side of a second boundary would record one expiry
// in the audit and store another. Freezing the instant makes the audit's claim
// and the stored column the same number by construction rather than by luck.
//
// Only the grant path reads it (via Service.confirmNow); every other action is
// unaffected.
type confirmNowCtxKey struct{}

var confirmNowKey = confirmNowCtxKey{}

// confirmNow returns the instant this confirmation is being applied at: the one
// HandleAdminConfirm froze, or the live clock for any other caller (a direct
// handler call, or the confirmation PAGE's preview, which is necessarily
// rendered earlier than the confirmation it describes).
func (s *Service) confirmNow(ctx context.Context) int64 {
	at, _ := s.confirmApplyInstant(ctx)
	return at
}

// confirmApplyInstant additionally reports WHICH of those two callers is asking:
// true means HandleAdminConfirm froze this instant and the write is happening
// now, false means the clock was read speculatively — the confirmation PAGE,
// rendered at an instant that is NOT the one the write will use.
//
// That distinction is a correctness requirement, not a convenience. The page is
// rendered when the operator submits the form and the write happens when they
// pass the second factor, with an unbounded human delay in between; a page that
// printed an exact expiry computed from its own clock would state a timestamp
// that the write then contradicts by exactly that delay. Nothing may fix the
// discrepancy by freezing the page's instant and writing it later (that hands
// out less time than the operator asked for, and hands out a stale base for
// extend), so the page must instead describe the ARITHMETIC rather than assert a
// result — see adminGrantExpiryPromise, and beforeImageFor's AuditUserPlanGrant
// case for the one branch that separates the two.
func (s *Service) confirmApplyInstant(ctx context.Context) (int64, bool) {
	if at, ok := ctx.Value(confirmNowKey).(int64); ok {
		return at, true
	}
	return s.Now().Unix(), false
}

// errConfirmBadRequest marks a beforeImageFor failure that is the OPERATOR's
// input, not the server's fault — a duration outside its bounds, an unknown
// mode. Without it every such refusal renders as a 500, which is exactly the
// defect the plan route's 409 fix was written for: an operator reads "server
// error", concludes the console is broken, and retries a form that can never be
// accepted. RequireStepUp maps it to a 400 carrying the reason.
var errConfirmBadRequest = errors.New("account: the submitted form cannot be confirmed")

// RequireStepUp turns a high-risk write handler into "render a confirmation
// first, apply later". It intercepts the original POST, stashes the form in
// a session-bound pending action, and renders a page showing exactly what
// would change. The actual write only happens in HandleAdminConfirm, once
// that page's form is submitted back.
//
// Design point that must never regress: **the confirmation page always
// renders**, even when the session is inside the step-up grace window
// (stepUpFresh). The grace window only skips having to re-enter the second
// factor (see stepUpGraceSecs' doc comment in admin.go) — it must never skip
// showing the diff, because the diff view is the actual anti-misclick
// mechanism, not the factor prompt.
func (s *Service) RequireStepUp(action string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdminReq(r) {
			http.Redirect(w, r, "/admin", http.StatusFound)
			return
		}
		// A request forwarded by HandleAdminConfirm carries stepUpDoneKey and
		// must go straight to the real handler, not be re-intercepted.
		if r.Context().Value(stepUpDoneKey) != nil {
			next(w, r)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		c, _ := r.Cookie(adminCookie)
		// Carry the {id} path wildcard (empty for form-only actions) so the
		// confirmation POST, which lands on the id-less /admin/confirm route, can
		// re-apply it before forwarding to a path-scoped handler.
		tok, ok := s.putPending(r.Context(), c.Value, action, r.PathValue("id"), r.PostForm)
		if !ok {
			http.Error(w, "too many pending confirmations", http.StatusTooManyRequests)
			return
		}
		pathID := r.PathValue("id")
		before, after, target, err := s.beforeImageFor(r.Context(), action, pathID, r.PostForm)
		if err != nil {
			// An operator-input refusal must say what is wrong with the form; only
			// a real store/read failure is a 500. The pending token minted just
			// above is left to expire on its own TTL rather than being spent here.
			if errors.Is(err, errConfirmBadRequest) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// The warning banner for actions whose danger is a fact about the ACCOUNT
		// rather than about the submitted values — a membership grant landing on an
		// account that already has provider billing state. Computed here, next to
		// the diff, so the page and the operator's decision see the same evidence.
		notice, err := s.confirmNoticeFor(r.Context(), action, r.PostForm)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		// The two ladder-changing rollout actions state their blast radius in a
		// banner above the diff row: for both of them the fact that matters most
		// is not a field value but WHOSE machines, and WHICH guarantees are being
		// given up. Track and banner come from one call so they cannot disagree
		// — see confirmBlastFor and rolloutTrackLabel.
		track, blastNotice := confirmBlastFor(action, pathID)
		trackLabel := ""
		if track != "" {
			trackLabel = rolloutTrackLabel(track)
		}
		s.renderConfirmPage(w, confirmPageData{
			Lang:        adminLangFrom(r),
			Token:       tok,
			Action:      action,
			Target:      target,
			Track:       track,
			TrackLabel:  trackLabel,
			TrackNotice: blastNotice,
			Notice:      notice,
			Changes:     diffFields(before, after),
			// The grace window only ever affects NeedFactor, never whether
			// this page renders at all — see the doc comment above.
			NeedFactor: !s.stepUpFresh(r.Context(), c.Value),
			Factor:     s.availableStepUpFactor(r.Context()),
			Nonce:      CSPNonce(r),
		})
	}
}

// availableStepUpFactor picks the second factor to prompt for: passkey (no
// 30-second replay window, best UX) > TOTP > password re-entry.
//
// The last tier's security value is close to zero (it's the same password
// that was just used to establish the session), but it's still real friction
// against misclicks, and it keeps a self-hoster who has only ever configured
// a password from being locked out of high-risk admin actions entirely. The
// confirmation page nudges that operator to set up real 2FA instead.
func (s *Service) availableStepUpFactor(ctx context.Context) string {
	if s.AdminPasskeyCount(ctx) > 0 {
		return StepUpPasskey
	}
	if s.AdminTOTPEnabled() {
		return StepUpTOTP
	}
	return StepUpPassword
}

// renderConfirmPage draws the confirmation page (see adminConfirmTmpl in
// admin_templates.go), following the same render-into-ResponseWriter pattern
// as renderAdminLogin/handleAdminHome.
func (s *Service) renderConfirmPage(w http.ResponseWriter, data confirmPageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := adminConfirmTmpl.Execute(w, data); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}

// confirmHandlerFor maps a pending action name to the handler that actually
// applies it. This is an explicit map, not reflection: the set of
// confirmable actions is meant to be readable at a glance right next to the
// six RequireStepUp registrations in RegisterAdmin, and a typo in an action
// constant fails as an "unknown pending action" 500 instead of silently
// resolving to the wrong method via name-matching.
func (s *Service) confirmHandlerFor(action string) (http.HandlerFunc, bool) {
	m := map[string]http.HandlerFunc{
		AuditSettings:      s.handleAdminSettings,
		AuditVersionPolicy: s.handleAdminUpdateVersionPolicy,
		AuditPlanUpsert:    s.handleAdminUpsertPlan,
		AuditUserPlan:      s.handleAdminSetUserPlan,
		// The time-bounded membership grant. On this path for the same reason as
		// the permanent comp above, plus one the comp does not have: it is the one
		// admin write that is deliberately ALLOWED on an account with live payment
		// authority, so the confirmation page is where the operator is shown that
		// authority before deciding.
		AuditUserPlanGrant: s.handleAdminGrantUserPlan,
		AuditTokenMint:     s.handleAdminMintToken,
		AuditNodeDelete:    s.handleAdminDeleteNode,
		AuditPasskeyDelete: s.HandleAdminPasskeyDelete,
		// The App Store product catalog write. It is on this path for the reason
		// stated at its route: the row is read after the money has moved.
		AuditAppleProduct: s.handleAdminUpsertAppleProduct,
		// The global App Store purchase gate. On this path in both directions:
		// pausing stops every sale, resuming re-opens them.
		AuditApplePurchases: s.handleAdminApplePurchases,
		// Emergency release is the one that ships a build to every node of a
		// track at once, with no canary left to catch it.
		AuditRolloutEmergency: s.handleAdminRolloutEmergency,
		// The manual fast fleet push keeps the canary and the queue but drops
		// their waiting periods. It is behind step-up for a different reason
		// from the emergency release: not because nothing can catch a bad build
		// afterwards, but because deciding to skip ~14 hours of observation is a
		// judgement one click should not be able to make by accident.
		AuditRolloutFast: s.handleAdminRolloutFast,
		// The safe fast push keeps the canary's whole observation window and
		// drops only the soak after it. It is behind step-up for the narrower of
		// the reasons above: not "skip ~14 hours of observation", but "start a
		// fleet-wide rollout right now", which is still not a decision one
		// mis-click should be able to make — and keeping both fast actions on the
		// same confirmation path is what stops the safe one becoming the
		// unconfirmed shortcut that gets reached for under pressure.
		AuditRolloutFastCanary: s.handleAdminRolloutFastCanary,
	}
	h, ok := m[action]
	return h, ok
}

// verifyStepUpFactor checks the second factor a confirmation POST presents and
// returns which factor actually satisfied it — StepUpGrace/Passkey/TOTP/
// Password — so the audit trail can record the truth, or ("", false) when
// nothing valid was presented, in which case HandleAdminConfirm must NOT apply
// the pending action.
//
// The grace window is checked first and mirrors exactly the NeedFactor
// computation RequireStepUp did when it rendered this pending action's page: a
// recent successful step-up on this same session waves the factor. That path
// returns StepUpGrace, never a real factor name — the audit must not claim a
// factor was re-checked when it was let through (see StepUpGrace's doc comment).
//
// Which factor is demanded outside the grace window is availableStepUpFactor's
// call, not the caller's: the client cannot pick a weaker factor than the one
// the confirmation page offered by choosing which field to fill.
func (s *Service) verifyStepUpFactor(r *http.Request, pending pendingAction) (string, bool) {
	if s.stepUpFresh(r.Context(), pending.sessionTok) {
		return StepUpGrace, true
	}
	switch s.availableStepUpFactor(r.Context()) {
	case StepUpPasskey:
		if s.verifyStepUpPasskey(r) {
			return StepUpPasskey, true
		}
	case StepUpTOTP:
		// MatchAdminTOTPStep is crypto-only; ClaimTOTPStep atomically spends the
		// step so a code already used (at login or an earlier step-up, on ANY
		// instance) is refused. The claim IS the single-use lock now — a false
		// result (or a store error, failing closed) rejects the factor.
		if step, ok := s.MatchAdminTOTPStep(r.FormValue("factor_code")); ok {
			if claimed, err := s.store.ClaimTOTPStep(r.Context(), step); err == nil && claimed {
				return StepUpTOTP, true
			}
		}
	case StepUpPassword:
		// Password re-entry is the factor only when neither passkey nor TOTP is
		// configured, so TOTP is off and the code is irrelevant. The username is
		// implied — the session is already the admin — so only the password is
		// prompted; adminUser() feeds the constant-time compare its match half.
		if _, ok := s.verifyAdminCreds(s.adminUser(), r.FormValue("factor_code"), ""); ok {
			return StepUpPassword, true
		}
	}
	return "", false
}

// HandleAdminConfirm is the confirmation page's POST target. It takes the
// pending action (burning its token), verifies the second factor, restores the
// original form onto the request, marks it as step-up-done and forwards to the
// mapped handler via confirmHandlerFor, then records the audit entry and
// refreshes the grace window.
func (s *Service) HandleAdminConfirm(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	c, _ := r.Cookie(adminCookie)
	pending, ok := s.takePending(r.Context(), r.FormValue("confirm_token"), c.Value)
	if !ok {
		http.Error(w, "confirmation expired or invalid; go back and try again", http.StatusBadRequest)
		return
	}
	handler, ok := s.confirmHandlerFor(pending.action)
	if !ok {
		// Unreachable in practice: every action RequireStepUp can mint a
		// pending token for is registered in confirmHandlerFor. Fail closed
		// rather than silently dropping an operator-confirmed action.
		http.Error(w, "unknown pending action", http.StatusInternalServerError)
		return
	}
	factor, ok := s.verifyStepUpFactor(r, pending)
	if !ok {
		http.Error(w, "second-factor verification failed", http.StatusUnauthorized)
		return
	}

	form := pending.form
	// One confirmation, one instant. See confirmNowKey: an action whose written
	// value is derived from the clock (a grant's expiry) must not be described by
	// an image computed at a different second than the write it describes.
	ctx := context.WithValue(r.Context(), confirmNowKey, s.Now().Unix())
	// Capture the diff BEFORE the handler applies it: beforeImageFor's "before"
	// half reads the store's current row, so once the write lands it would
	// diff the new value against itself and record an empty change. target and
	// changes are resolved here and audited after the apply.
	before, after, target, diffErr := s.beforeImageFor(ctx, pending.action, pending.pathID, form)
	// A path-scoped action (node delete) has no target in the form — its id
	// lives in the path wildcard we stashed. Give the audit a real target
	// instead of "-", now that the id is recoverable here.
	//
	// The emergency release used to be patched in here the same way, which was
	// exactly the problem: the track reached the AUDIT but never the operator,
	// because the confirmation page is rendered from beforeImageFor's return
	// value long before this runs. It now comes from beforeImageFor itself, so
	// the page and the log necessarily name the same track.
	if pending.action == AuditNodeDelete && pending.pathID != "" {
		target = "node:" + pending.pathID
	}

	r.PostForm = form
	r.Form = form
	next := r.WithContext(context.WithValue(ctx, stepUpDoneKey, true))
	// Re-apply the original {id} wildcard: the confirm POST landed on the id-less
	// /admin/confirm route, so a path-scoped handler (handleAdminDeleteNode reads
	// r.PathValue("id")) would otherwise act on an empty id and no-op.
	if pending.pathID != "" {
		next.SetPathValue("id", pending.pathID)
	}
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	handler(rec, next)
	// Only treat the action as applied — refresh the grace window and record the
	// audit entry — when the handler actually succeeded (2xx/3xx). A rejected
	// write (validation 400, node-not-found 404, ...) has already written its own
	// error response; marking step-up fresh or logging a change that never landed
	// would corrupt the audit trail with actions that did not happen.
	if rec.status >= 400 {
		return
	}
	s.markStepUp(r.Context(), c.Value)
	// Record even if the diff could not be computed: a high-risk write that
	// applied must never be missing from the audit log. A beforeImageFor error
	// (e.g. a transient store read) costs only the field-level changes, not the
	// record that the action happened at all.
	var changes []ChangeField
	if diffErr == nil {
		changes = diffFields(before, after)
	}
	s.WriteAudit(r, pending.action, target, changes, factor)
}

// statusRecorder wraps a ResponseWriter to remember the first status code the
// wrapped handler emitted, so HandleAdminConfirm can tell an applied write from
// a rejected one. Defaults to 200: a handler that Writes without an explicit
// WriteHeader is a success.
type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wrote {
		r.status = code
		r.wrote = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	r.wrote = true // implicit 200 already recorded by the struct default
	return r.ResponseWriter.Write(b)
}
