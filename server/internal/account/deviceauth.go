package account

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
	"time"
)

// deviceCodeTTL bounds how long an unclaimed device-code request stays valid
// (RFC 8628-style CLI login flow). devicePollInterval is the minimum seconds
// the CLI should wait between poll calls.
const (
	deviceCodeTTL      = 10 * time.Minute
	devicePollInterval = 5
)

// userCodeAlphabet avoids vowels and visually-ambiguous characters (0/O, 1/I)
// so a code read aloud or typed by hand is unambiguous.
const userCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"

// genUserCode returns a short human-friendly code like "WDJB-MJHT" for the
// user to type at the verification URL.
func genUserCode() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand.Read on the standard reader does not fail in practice;
		// panicking here would surface any platform-specific breakage loudly
		// rather than silently minting a weak/predictable code.
		panic(err)
	}
	out := make([]byte, 9)
	for i := 0; i < 4; i++ {
		out[i] = userCodeAlphabet[int(buf[i])%len(userCodeAlphabet)]
	}
	out[4] = '-'
	for i := 4; i < 8; i++ {
		out[i+1] = userCodeAlphabet[int(buf[i])%len(userCodeAlphabet)]
	}
	return string(out)
}

// handleDeviceStart mints a device-code login request (unauthenticated — this
// is the very first call the CLI makes, before it has any credential). The
// short user_code is what the human types at verification_uri; the opaque
// device_code is what the CLI polls with and is never shown to the human.
func (s *Service) handleDeviceStart(w http.ResponseWriter, r *http.Request) {
	// Unauthenticated by design (first call the CLI ever makes), so without a
	// throttle an anonymous caller can mint cli_device_auth rows without bound.
	if s.registerLimiter != nil && !s.registerLimiter.Allow(s.clientIP(r)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
		return
	}
	now := s.now().Unix()
	deviceCode := randToken()
	userCode := genUserCode()
	req := DeviceAuthRequest{
		UserCode:       userCode,
		DeviceCodeHash: hashToken(deviceCode),
		Status:         "pending",
		CreatedAt:      now,
		ExpiresAt:      now + int64(deviceCodeTTL.Seconds()),
	}
	if err := s.store.CreateDeviceAuth(r.Context(), req); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user_code":        userCode,
		"device_code":      deviceCode,
		"verification_uri": s.cfg.BaseURL + "/device",
		"interval":         devicePollInterval,
		"expires_in":       int(deviceCodeTTL.Seconds()),
	})
}

// handleDevicePoll is called repeatedly by the CLI (unauthenticated — it has
// no credential yet) until the human approves or the request expires/denies.
// The access token is handed back exactly once: ConsumeDeviceAuth blanks the
// pending token as part of the same atomic transition, so a retried or
// duplicated poll after the first "ok" cannot observe it again.
func (s *Service) handleDevicePoll(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DeviceCode string `json:"device_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.DeviceCode == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	now := s.now().Unix()
	req, ok, err := s.store.GetDeviceAuthByCodeHash(ctx, hashToken(in.DeviceCode))
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok || now >= req.ExpiresAt {
		writeJSON(w, http.StatusOK, map[string]string{"status": "expired"})
		return
	}
	switch req.Status {
	case "denied":
		writeJSON(w, http.StatusOK, map[string]string{"status": "denied"})
	case "pending":
		writeJSON(w, http.StatusOK, map[string]string{"status": "authorization_pending"})
	case "approved":
		raw, consumed, err := s.store.ConsumeDeviceAuth(ctx, hashToken(in.DeviceCode), now)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !consumed {
			// Already consumed by an earlier poll (or lost the race to one) —
			// the token was already handed out once and must not be re-sent.
			writeJSON(w, http.StatusOK, map[string]string{"status": "expired"})
			return
		}
		u, err := s.store.GetUserByID(ctx, req.UserID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"status":        "ok",
			"access_token":  raw,
			"account_email": u.Email,
		})
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": "expired"})
	}
}

// handleDeviceApprove is called by the logged-in web session when the human
// confirms the code shown by the CLI. It mints a new CLI device + long-lived
// bearer token and hands the raw token to ApproveDeviceAuth, which stashes it
// so the CLI's next poll (handleDevicePoll) can hand it back exactly once.
func (s *Service) handleDeviceApprove(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		UserCode string `json:"user_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.UserCode == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	now := s.now().Unix()
	// Validate-then-mint: settle the raw token + hash in memory only, then let
	// ApproveDeviceAuth gate on user_code FIRST. An ordinary expired/mistyped/
	// double-submitted code fails here having created no DB rows, so it can't
	// leave a phantom "CLI" device in the user's list or an orphaned cli_token.
	raw := "rlm_cli_" + randToken()
	h := hashToken(raw)
	ok, err := s.store.ApproveDeviceAuth(ctx, in.UserCode, u.ID, h, raw, now)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_or_expired_code"})
		return
	}
	// Only now that the code is validated do we persist the device + token. A
	// poll could observe pending_token in the microsecond window before these
	// commit; that's benign — the token row is created regardless, so a CLI
	// retry (5s poll interval) self-heals. No rollback machinery needed.
	dev, err := s.store.UpsertDevice(ctx, Device{
		ID: newID(), UserID: u.ID, Name: "CLI", Kind: "cli", CreatedAt: now,
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := s.store.CreateCLIToken(ctx, CLIToken{
		TokenHash: h, UserID: u.ID, DeviceID: dev.ID, CreatedAt: now,
	}); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "account_email": u.Email})
}
