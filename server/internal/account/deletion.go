package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
)

// RequestAccountDeletion issues a short-lived, single-use "delete" email
// token and mails a confirm link. It never touches account state directly —
// the destructive work (transient-data purge + scheduling the hard purge)
// only happens once the link is used, via ConfirmAccountDeletion. Callers
// (handleDeleteRequest) are expected to rate-limit and always answer with a
// generic 200 regardless of the outcome here, matching the reset/verify flows'
// anti-enumeration contract.
func (s *Service) RequestAccountDeletion(ctx context.Context, userID, email string) error {
	raw := randToken()
	now := s.now()
	tok := EmailToken{
		TokenHash: hashToken(raw),
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
//     stored files + their blobs, ...) immediately, schedules the hard purge
//     AccountGraceDays (settings, in days) from now, and emails a
//     confirmation carrying a "reactivate" token that can undo the schedule
//     within the grace window.
func (s *Service) ConfirmAccountDeletion(ctx context.Context, rawToken string) error {
	now := s.now()
	tok, ok, err := s.store.UseEmailToken(ctx, hashToken(rawToken), "delete", now.Unix())
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

	st := s.resolveSettings(ctx)
	purgeAfter := now.Unix() + st.AccountGraceDays*86400

	files, err := s.store.PurgeTransientUserData(ctx, tok.UserID)
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
	for _, f := range files {
		if bs, berr := s.blobFor(cleanupCtx, f.NodeID); berr == nil {
			if derr := bs.Delete(cleanupCtx, f.BlobKey); derr != nil {
				_ = s.store.EnqueueNodeDelete(cleanupCtx, f.BlobKey, f.NodeID, now.Unix())
			}
		} else {
			_ = s.store.EnqueueNodeDelete(cleanupCtx, f.BlobKey, f.NodeID, now.Unix())
		}
	}

	if err := s.store.SetAccountDeletion(ctx, tok.UserID, now.Unix(), purgeAfter); err != nil {
		return err
	}

	// Issue a reactivate token good for the whole grace window, so the user can
	// cancel the pending deletion any time before the hard purge (Task 4).
	raw := randToken()
	if err := s.store.CreateEmailToken(ctx, EmailToken{
		TokenHash: hashToken(raw),
		UserID:    tok.UserID,
		Email:     u.Email,
		Purpose:   "reactivate",
		CreatedAt: now.Unix(),
		ExpiresAt: purgeAfter,
	}); err != nil {
		return err
	}
	reactivateLink := fmt.Sprintf("%s/account/reactivate?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
	return s.mailer.SendAccountDeletionScheduled(ctx, u.Email, purgeAfter, reactivateLink)
}

// handleDeleteRequest issues a delete-confirm email for the logged-in user.
// Rate-limited per user+IP and always a generic 200 (mirrors
// handleForgotPassword/handleResendVerification): the mailer send outcome is
// not observable to the caller, so a probe can't distinguish "sent" from
// "throttled".
func (s *Service) handleDeleteRequest(w http.ResponseWriter, r *http.Request, u User) {
	key := u.ID + "|" + s.clientIP(r)
	if !s.deleteRequests.locked(key, s.now()) {
		s.deleteRequests.recordFail(key, s.now())
		_ = s.RequestAccountDeletion(r.Context(), u.ID, u.Email)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// handleDeleteConfirm consumes the delete token from the request body. No
// session is required or checked: the token itself authorizes the action, and
// by the time a second confirm could race in, ConfirmAccountDeletion's
// already-pending check makes it idempotent.
func (s *Service) handleDeleteConfirm(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Token == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	err := s.ConfirmAccountDeletion(r.Context(), in.Token)
	if errors.Is(err, ErrInvalidToken) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_or_expired_token"})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
