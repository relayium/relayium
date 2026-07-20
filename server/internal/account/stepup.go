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
		tok, ok := s.putPending(c.Value, action, r.PostForm)
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
			NeedFactor: !s.stepUpFresh(c.Value),
			Factor:     s.availableStepUpFactor(r.Context()),
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
	}
	h, ok := m[action]
	return h, ok
}

// verifyStepUpFactor checks the second factor submitted alongside a pending
// confirmation (passkey assertion / TOTP code / password, per
// availableStepUpFactor — or, inside the grace window, nothing at all).
//
// STUB for Task 7: this is Task 8's job and, until that lands, MUST keep
// returning false unconditionally. handleAdminConfirm treats false as "not
// verified, do not apply" — that is what keeps the high-risk apply path
// unreachable through this task. Do NOT turn this into `return true` as a
// shortcut: doing so would let anyone who can reach POST /admin/confirm with
// a stolen pending-action token (i.e. anyone already holding the admin
// session cookie) execute the underlying high-risk write having presented no
// factor at all, which defeats step-up entirely — the confirmation page
// would still show the right diff, but nothing would stop it being submitted
// by whoever has the cookie, factor or not.
func (s *Service) verifyStepUpFactor(r *http.Request, pending pendingAction) bool {
	_ = r
	_ = pending
	// TODO(Task 8): verify r.PostForm's factor material against
	// s.availableStepUpFactor(r.Context()), and allow the grace window
	// (s.stepUpFresh(sessionTok)) to skip that check — mirroring the
	// NeedFactor computation requireStepUp already did when it rendered this
	// same pending action's confirmation page.
	return false
}

// handleAdminConfirm is the confirmation page's POST target. It takes the
// pending action (burning its token), and — once verifyStepUpFactor is real,
// in Task 8 — restores the original form onto the request, marks it as
// step-up-done, and forwards to the mapped handler via confirmHandlerFor,
// then records the audit entry and refreshes the grace window.
//
// In this task verifyStepUpFactor always returns false, so every request
// here ends at "not implemented yet" and the apply/markStepUp/writeAudit
// path below never runs. It's written now so Task 8 only has to replace the
// stub, not build the plumbing around it.
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
	pending, ok := s.takePending(r.FormValue("confirm_token"), c.Value)
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
	if !s.verifyStepUpFactor(r, pending) {
		http.Error(w, "step-up factor verification is not implemented yet", http.StatusNotImplemented)
		return
	}

	form := pending.form
	r.PostForm = form
	r.Form = form
	next := r.WithContext(context.WithValue(r.Context(), stepUpDoneKey, true))
	handler(w, next)
	s.markStepUp(c.Value)
	if before, after, target, err := s.beforeImageFor(r.Context(), pending.action, form); err == nil {
		s.writeAudit(r, pending.action, target, diffFields(before, after), s.availableStepUpFactor(r.Context()))
	}
}
