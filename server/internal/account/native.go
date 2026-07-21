package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// issueBearer mints a long-lived hashed bearer token ("rlm_cli_…") bound to a
// fresh device row, for native app / API clients that authenticate with an
// Authorization: Bearer header instead of a session cookie. It reuses the CLI
// token table + RequireAuth validation path, so any RequireAuth-mounted
// endpoint works for these callers unchanged. The raw token is returned once
// and only its hash is stored.
func (s *Service) issueBearer(ctx context.Context, userID, deviceName string) (string, error) {
	if deviceName == "" {
		deviceName = "App"
	}
	raw := "rlm_cli_" + randToken()
	now := s.now().Unix()
	dev, err := s.store.UpsertDevice(ctx, Device{
		ID: newID(), UserID: userID, Name: deviceName, Kind: "app", CreatedAt: now,
	})
	if err != nil {
		return "", err
	}
	if err := s.store.CreateCLIToken(ctx, CLIToken{
		TokenHash: hashToken(raw), UserID: userID, DeviceID: dev.ID, CreatedAt: now,
	}); err != nil {
		return "", err
	}
	return raw, nil
}

// handleNativeLogin authenticates email+password and returns a bearer token for
// native (iOS/macOS) apps, instead of setting a session cookie. It routes every
// credential/verification/frozen decision through the same authenticate() path
// as the cookie login, and mirrors handlePasswordLogin's throttling and its
// unverified / pending-deletion responses so native and web behave identically.
func (s *Service) handleNativeLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email      string `json:"email"`
		Password   string `json:"password"`
		DeviceName string `json:"deviceName"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	key := normEmail(in.Email) + "|" + s.clientIP(r)
	if s.pwLogins.locked(key, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, try again later"})
		return
	}
	uid, err := s.authenticate(r.Context(), in.Email, in.Password)
	if errors.Is(err, ErrBadCredentials) {
		s.pwLogins.recordFail(key, s.now())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	if errors.Is(err, ErrEmailUnverified) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "email_unverified", "email": normEmail(in.Email)})
		return
	}
	var pd *PendingDeletionError
	if errors.As(err, &pd) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "pending_deletion",
			"purgeAfter":      pd.PurgeAfter,
			"reactivateToken": pd.ReactivateToken,
		})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.pwLogins.reset(key)
	s.finishNativeLogin(w, r, uid, in.DeviceName)
}

// finishNativeLogin mints a bearer for an already-authenticated user id and
// writes {token, user}. Shared by native password login and (when enabled) the
// native Sign in with Apple handler, so both hand back the same shape.
func (s *Service) finishNativeLogin(w http.ResponseWriter, r *http.Request, userID, deviceName string) {
	token, err := s.issueBearer(r.Context(), userID, deviceName)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	u, err := s.store.GetUserByID(r.Context(), userID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	hasPass, _ := s.store.HasPassword(r.Context(), u.ID)
	linked, _ := s.store.ListIdentityProviders(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"token": token,
		"user": map[string]any{
			"id": u.ID, "email": u.Email, "displayName": u.DisplayName,
			"hasPassword": hasPass, "emailVerified": u.EmailVerified,
			"linkedMethods": loginMethods(hasPass, linked),
		},
	})
}

// handleUnlinkIdentity removes one linked OAuth provider from the caller's
// account, refusing (409) if it would leave the account with no login method at
// all (no password and no other linked provider) — the user must set a password
// first. Session- or bearer-authed via RequireAuth.
func (s *Service) handleUnlinkIdentity(w http.ResponseWriter, r *http.Request, u User) {
	provider := r.PathValue("provider")
	// "password" is represented by HasPassword, not unlinked here; use the
	// change-password flow to manage it. Reject to avoid a confusing no-op.
	if provider == "" || provider == "password" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// The "would this orphan the account?" check and the delete must be atomic:
	// two concurrent unlinks of different providers could each see a method still
	// remaining and both delete, leaving zero login methods (lockout). The store
	// does the count-and-delete in one transaction.
	deleted, wouldOrphan, err := s.store.UnlinkIdentityIfSafe(r.Context(), provider, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if wouldOrphan {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "last_login_method"})
		return
	}
	if !deleted {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Return the fresh method set so the UI can update without a refetch.
	hasPass, err := s.store.HasPassword(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	linked, err := s.store.ListIdentityProviders(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	after := make([]string, 0, len(linked))
	for _, p := range linked {
		if p == "password" {
			continue
		}
		after = append(after, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"linkedMethods": loginMethods(hasPass, after)})
}

// loginMethods lists the ways this account can sign in: "password" (if set) plus
// each linked OAuth provider ("google"/"apple"/…). Used both for display and for
// the "keep at least one login method" unlink guard.
func loginMethods(hasPassword bool, providers []string) []string {
	out := make([]string, 0, len(providers)+1)
	if hasPassword {
		out = append(out, "password")
	}
	// The identities table stores "password" as a provider too; HasPassword is
	// authoritative for it, so skip it here to avoid a duplicate.
	for _, p := range providers {
		if p != "password" {
			out = append(out, p)
		}
	}
	return out
}
