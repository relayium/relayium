package account

import (
	"context"
	"net/http"
)

// stepUpCtxKey is the unexported context-key type stepUpDoneKey is built
// from. An unexported struct type (rather than a bare string) means no other
// package — and no accidental second definition in this one — can ever
// collide with it via context.WithValue, since context keys compare by
// (dynamic type, value).
type stepUpCtxKey struct{}

// stepUpDoneKey marks a request that handleAdminConfirm has already resolved
// (pending action taken, original form restored onto the request) and is now
// forwarding to the real handler. requireStepUp checks for this and, when
// present, lets the request straight through instead of intercepting it
// again — without it, the forwarded POST would just mint a second pending
// action and re-render the confirm page instead of ever applying anything.
var stepUpDoneKey = stepUpCtxKey{}

// requireStepUp turns a high-risk write handler into "render a confirmation
// first, apply later". It intercepts the original POST, stashes the form in
// a session-bound pending action, and renders a page showing exactly what
// would change. The actual write only happens in handleAdminConfirm, once
// that page's form is submitted back.
//
// Design point that must never regress: **the confirmation page always
// renders**, even when the session is inside the step-up grace window
// (stepUpFresh). The grace window only skips having to re-enter the second
// factor (see stepUpGraceSecs' doc comment in admin.go) — it must never skip
// showing the diff, because the diff view is the actual anti-misclick
// mechanism, not the factor prompt.
func (s *Service) requireStepUp(action string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdminReq(r) {
			http.Redirect(w, r, "/admin", http.StatusFound)
			return
		}
		// A request forwarded by handleAdminConfirm carries stepUpDoneKey and
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
		before, after, target, err := s.beforeImageFor(r.Context(), action, r.PostForm)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		s.renderConfirmPage(w, confirmPageData{
			Token:   tok,
			Action:  action,
			Target:  target,
			Changes: diffFields(before, after),
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
	if s.adminPasskeyCount(ctx) > 0 {
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
// six requireStepUp registrations in RegisterAdmin, and a typo in an action
// constant fails as an "unknown pending action" 500 instead of silently
// resolving to the wrong method via name-matching.
func (s *Service) confirmHandlerFor(action string) (http.HandlerFunc, bool) {
	m := map[string]http.HandlerFunc{
		AuditSettings:      s.handleAdminSettings,
		AuditPlanUpsert:    s.handleAdminUpsertPlan,
		AuditUserPlan:      s.handleAdminSetUserPlan,
		AuditTokenMint:     s.handleAdminMintToken,
		AuditNodeDelete:    s.handleAdminDeleteNode,
		AuditPasskeyDelete: s.handleAdminPasskeyDelete,
		// Emergency release is the only rollout control behind step-up: it is
		// the one that ships a build to every node of a track at once, with no
		// canary left to catch it.
		AuditRolloutEmergency: s.handleAdminRolloutEmergency,
	}
	h, ok := m[action]
	return h, ok
}

// verifyStepUpFactor checks the second factor a confirmation POST presents and
// returns which factor actually satisfied it — StepUpGrace/Passkey/TOTP/
// Password — so the audit trail can record the truth, or ("", false) when
// nothing valid was presented, in which case handleAdminConfirm must NOT apply
// the pending action.
//
// The grace window is checked first and mirrors exactly the NeedFactor
// computation requireStepUp did when it rendered this pending action's page: a
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
		// matchAdminTOTPStep is crypto-only; ClaimTOTPStep atomically spends the
		// step so a code already used (at login or an earlier step-up, on ANY
		// instance) is refused. The claim IS the single-use lock now — a false
		// result (or a store error, failing closed) rejects the factor.
		if step, ok := s.matchAdminTOTPStep(r.FormValue("factor_code")); ok {
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

// handleAdminConfirm is the confirmation page's POST target. It takes the
// pending action (burning its token), verifies the second factor, restores the
// original form onto the request, marks it as step-up-done and forwards to the
// mapped handler via confirmHandlerFor, then records the audit entry and
// refreshes the grace window.
func (s *Service) handleAdminConfirm(w http.ResponseWriter, r *http.Request) {
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
		// Unreachable in practice: every action requireStepUp can mint a
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
	// Capture the diff BEFORE the handler applies it: beforeImageFor's "before"
	// half reads the store's current row, so once the write lands it would
	// diff the new value against itself and record an empty change. target and
	// changes are resolved here and audited after the apply.
	before, after, target, diffErr := s.beforeImageFor(r.Context(), pending.action, form)
	// A path-scoped action (node delete) has no target in the form — its id
	// lives in the path wildcard we stashed. Give the audit a real target
	// instead of "-", now that the id is recoverable here.
	if pending.action == AuditNodeDelete && pending.pathID != "" {
		target = "node:" + pending.pathID
	}
	// Same story for the emergency release: WHICH TRACK was released is the
	// single most important fact about it, and it lives in the path wildcard.
	if pending.action == AuditRolloutEmergency && pending.pathID != "" {
		target = "rollout:" + pending.pathID
	}

	r.PostForm = form
	r.Form = form
	next := r.WithContext(context.WithValue(r.Context(), stepUpDoneKey, true))
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
	s.writeAudit(r, pending.action, target, changes, factor)
}

// statusRecorder wraps a ResponseWriter to remember the first status code the
// wrapped handler emitted, so handleAdminConfirm can tell an applied write from
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
