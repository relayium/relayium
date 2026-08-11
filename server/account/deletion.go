package account

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
)

// RequestAccountDeletion issues a short-lived, single-use "delete" email
// token and mails a confirm link. It never touches account state directly —
// the destructive work (transient-data purge + scheduling the hard purge)
// only happens once the link is used, via ConfirmAccountDeletion. Callers
// (handleDeleteRequest) are expected to rate-limit and always answer with a
// generic 200 regardless of the outcome here, matching the reset/verify flows'
// anti-enumeration contract.
func (s *Service) RequestAccountDeletion(ctx context.Context, userID, email string) error {
	raw := authx.RandToken()
	now := s.now()
	tok := EmailToken{
		TokenHash: authx.HashToken(raw),
		UserID:    userID,
		Email:     email,
		Purpose:   "delete",
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(deleteTokenTTL).Unix(),
	}
	if err := s.store.CreateEmailToken(ctx, tok); err != nil {
		return err
	}
	link := fmt.Sprintf("%s/account/delete/confirm?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
	return s.mailer.SendAccountDeletionConfirm(ctx, email, link)
}

// ConfirmAccountDeletion consumes a "delete" email token (the token itself is
// the authorization — no session is required or expected, since a prior
// confirm may already have revoked the caller's session) and:
//  1. no-ops (idempotently, nil error) if the account is already pending
//     deletion — a stale duplicate confirm (e.g. the link opened twice, or an
//     email client prefetching it) must not re-run the purge or re-send mail;
//  2. otherwise purges the user's transient/live data (sessions, devices,
//     stored files and unfinished uploads + their blobs, ...) immediately,
//     schedules the hard purge AccountGraceDays (settings, in days) from now,
//     and emails a
//     confirmation carrying a "reactivate" token that can undo the schedule
//     within the grace window.
func (s *Service) ConfirmAccountDeletion(ctx context.Context, rawToken string) error {
	now := s.now()
	tok, ok, err := s.store.UseEmailToken(ctx, authx.HashToken(rawToken), "delete", now.Unix())
	if err != nil {
		return err
	}
	if !ok {
		return ErrInvalidToken
	}
	u, err := s.store.GetUserByID(ctx, tok.UserID)
	if err != nil {
		return err
	}
	if u.DeletedAt > 0 {
		// Already pending: idempotent no-op, per the doc comment above.
		return nil
	}

	st := s.ResolveSettings(ctx)
	purgeAfter := now.Unix() + st.AccountGraceDays*86400

	// Issue the reactivate token BEFORE the account becomes pending, so the
	// moment SetAccountDeletion commits there is guaranteed to be a usable
	// reactivate token in email_tokens — even if the scheduled-deletion email
	// send below fails. Minting it for a not-yet-pending account is harmless
	// (reactivation is idempotent, and the token is bounded to the grace window).
	raw, err := s.issueReactivateToken(ctx, tok.UserID, u.Email)
	if err != nil {
		return err
	}

	// Every blob the purge orphaned: finalized stored files AND the partial blob
	// of every chunked upload the account had open or half-finished. They are one
	// list because they are one job — ciphertext with no row left to reach it —
	// and the store has already deduplicated the case where a stored file and a
	// stale session name the same blob.
	blobs, err := s.store.PurgeTransientUserData(ctx, tok.UserID)
	if err != nil {
		return err
	}
	// Blob deletes are best-effort cleanup, not part of the account-state
	// transaction: a node being unreachable must not block scheduling the
	// deletion (the orphaned blob is queued for GC's retry instead). Derive
	// from ctx but strip cancellation so an early-closing HTTP response (or a
	// deadline sized for the request, not this cleanup fan-out) can't cut the
	// deletes short — mirrors handleDeleteFile's per-file delete-or-enqueue.
	cleanupCtx := context.WithoutCancel(ctx)
	for _, b := range blobs {
		if bs, berr := s.blobFor(cleanupCtx, b.NodeID); berr == nil {
			if derr := bs.Delete(cleanupCtx, b.BlobKey); derr != nil {
				_ = s.store.EnqueueNodeDelete(cleanupCtx, b.BlobKey, b.NodeID, now.Unix())
			}
		} else {
			_ = s.store.EnqueueNodeDelete(cleanupCtx, b.BlobKey, b.NodeID, now.Unix())
		}
	}

	if err := s.store.SetAccountDeletion(ctx, tok.UserID, now.Unix(), purgeAfter); err != nil {
		return err
	}

	// The scheduled-deletion email is best-effort: the deletion is genuinely
	// scheduled and a reactivate token already exists (issued above), plus the
	// user can always mint a fresh one by logging in during the grace window
	// (Task 4). A transient SMTP hiccup must not 500 nor leave the account in an
	// inconsistent "purged but not scheduled" state — mirror the other handlers'
	// treatment of mail sends as fire-and-forget.
	link := s.reactivateLink(raw)
	if err := s.mailer.SendAccountDeletionScheduled(ctx, u.Email, purgeAfter, link); err != nil {
		log.Printf("account deletion: scheduled-email send failed for user %s (deletion still scheduled, purge_after=%d): %v", tok.UserID, purgeAfter, err)
	}
	return nil
}

// issueReactivateToken mints a fresh "reactivate" email_tokens row for userID,
// valid for a full grace window (Settings.AccountGraceDays, in days) from
// now, and returns the raw token. Shared by ConfirmAccountDeletion's
// scheduled-deletion email and every frozen-login guard (Task 4:
// password/magic/OAuth) — each pending-deletion login attempt hands back its
// own independently-expiring token rather than depending on the original
// confirm email having survived or still being at hand.
func (s *Service) issueReactivateToken(ctx context.Context, userID, email string) (string, error) {
	raw := authx.RandToken()
	now := s.now()
	st := s.ResolveSettings(ctx)
	tok := EmailToken{
		TokenHash: authx.HashToken(raw),
		UserID:    userID,
		Email:     email,
		Purpose:   "reactivate",
		CreatedAt: now.Unix(),
		ExpiresAt: now.Unix() + st.AccountGraceDays*86400,
	}
	if err := s.store.CreateEmailToken(ctx, tok); err != nil {
		return "", err
	}
	return raw, nil
}

// reactivateLink builds the reactivation URL for a raw reactivate token.
func (s *Service) reactivateLink(raw string) string {
	return fmt.Sprintf("%s/account/reactivate?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
}

// IssueReactivateLink mints a fresh reactivate token for userID/email and
// returns its full URL. Exported for GC's pre-purge reminder email (Task 5),
// which needs an independently-expiring link each time it fires — mirrors
// every frozen-login guard's (Task 4) use of the same issue+link pair.
func (s *Service) IssueReactivateLink(ctx context.Context, userID, email string) (string, error) {
	raw, err := s.issueReactivateToken(ctx, userID, email)
	if err != nil {
		return "", err
	}
	return s.reactivateLink(raw), nil
}

// handleReactivate consumes a "reactivate" email token. Unauthenticated by
// design, mirroring handleDeleteConfirm: the token itself is the
// authorization, since a frozen account has no live session to authenticate
// with in the first place (every login path refuses to issue one). On
// success it clears the pending-deletion state and immediately logs the user
// in — "click the link, you're back in" — so the response carries a fresh
// session cookie plus the user JSON, mirroring handleResetPassword. It only
// works while the account is actually pending deletion (DeletedAt>0): a token
// presented against an already-active account is rejected (400) rather than
// minting a session, so a leftover reactivate token can't serve as a
// passwordless login after recovery. Reactivation also revokes the user's other
// unused reactivate tokens (see ClearAccountDeletion).
func (s *Service) handleReactivate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil || in.Token == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	tok, ok, err := s.store.UseEmailToken(r.Context(), authx.HashToken(in.Token), "reactivate", s.now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_or_expired_token"})
		return
	}
	u, err := s.store.GetUserByID(r.Context(), tok.UserID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// A reactivate token authorizes UNDOING a pending deletion — not a general
	// passwordless login. If the account is no longer pending (already recovered),
	// a leftover token must NOT mint a session: otherwise any one of the several
	// tokens minted across the grace window stays a 30-day backdoor login that
	// survives recovery and a password change. The token is already burned above,
	// so a leaked one is now spent. Same generic error as a bad token (no
	// enumeration of account state).
	if u.DeletedAt == 0 {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_or_expired_token"})
		return
	}
	if err := s.store.ClearAccountDeletion(r.Context(), tok.UserID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Re-read so the returned user JSON reflects the now-active (non-pending) state.
	u, err = s.store.GetUserByID(r.Context(), tok.UserID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	sess, err := s.IssueSession(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.setSessionCookie(w, sess)
	s.writeUser(r.Context(), w, http.StatusOK, u)
}

// handleDeleteRequest issues a delete-confirm email for the logged-in user.
// Rate-limited per user+IP and always a generic 200 (mirrors
// handleForgotPassword/handleResendVerification): the mailer send outcome is
// not observable to the caller, so a probe can't distinguish "sent" from
// "throttled".
//
// The caller is whoever RequireAuth resolved — a browser session or a native
// app's bearer — and `u` is the ONE user that resolution produced. The address
// the link goes to is read off that user, never off the request, so no caller
// can aim the email anywhere but at their own account's address.
func (s *Service) handleDeleteRequest(w http.ResponseWriter, r *http.Request, u User) {
	key := u.ID + "|" + s.clientIP(r)
	if !s.deleteRequests.locked(key, s.now()) {
		s.deleteRequests.recordFail(key, s.now())
		_ = s.RequestAccountDeletion(r.Context(), u.ID, u.Email)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// handleDeleteConfirm consumes the delete token from the request body. No
// session is required or checked: the token itself authorizes the action, and
// by the time a second confirm could race in, ConfirmAccountDeletion's
// already-pending check makes it idempotent.
func (s *Service) handleDeleteConfirm(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := httpx.DecodeJSONBody(w, r, &in); err != nil || in.Token == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	err := s.ConfirmAccountDeletion(r.Context(), in.Token)
	if errors.Is(err, ErrInvalidToken) {
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_or_expired_token"})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
