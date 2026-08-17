package account

import (
	"errors"
	"io"
	"net/http"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/inbox"
)

// Device Inbox HTTP surface (Phase 1A: identity, keys, capabilities, presence).
//
// AUTHORIZATION MODEL — the two halves are deliberately different, and which
// half an endpoint uses is the security decision on this file:
//
//   - DEVICE-SELF (deviceSelf): only the device itself may describe itself.
//     Enrolment, key registration/rotation, heartbeat and goodbye are all
//     assertions about a machine's own state and its own private key, so they
//     require a bearer BOUND TO THAT DEVICE ROW. A browser session cannot make
//     them — a cookie is account-wide and would let any signed-in tab fake a
//     server's presence or register a public key whose private half nobody
//     holds, which is the one way to make a queued task permanently
//     undecryptable.
//   - ACCOUNT-SCOPED (RequireAuth): revocation, key history and clearing an
//     enrolment. Revocation MUST work from a different device than the one being
//     revoked — that is the entire point of revoking a lost laptop — so it
//     cannot be device-self.
//
// Every store call is scoped by user id as well as device id, and a device that
// does not belong to the caller is reported as 404 rather than 403, so the API
// never confirms that some other account's device id exists.
//
// JSON casing: this subtree uses Go-default capitalization because it is carried
// INSIDE the device list (see deviceView), which has shipped that way since the
// web devices section was built. One response with two casing conventions would
// be worse than the repo-wide inconsistency; the key object in particular must
// have one spelling whether it is read from the device list or from the key
// history endpoint.

// deviceSelf reports whether this request was authenticated by the bearer bound
// to deviceID under this account.
//
// bearerDeviceID returns "" whenever a session cookie authenticated the request
// (see its doc comment), so this is false for every browser call by
// construction. That is intended: presence and key custody are claims only the
// machine holding the private key may make.
func (s *Service) deviceSelf(r *http.Request, userID, deviceID string) bool {
	if deviceID == "" {
		return false
	}
	return s.bearerDeviceID(r, userID) == deviceID
}

// deviceKeyView is one entry of a device's public-key history. It carries the
// PUBLIC key and nothing else; there is no field here, and no column behind it,
// that could hold a private key or a content key.
type deviceKeyView struct {
	ID         string `json:"ID"`
	Algorithm  string `json:"Algorithm"`
	PublicKey  string `json:"PublicKey"`
	Generation int64  `json:"Generation"`
	CreatedAt  int64  `json:"CreatedAt"`
	// SupersededAt != 0 means rotated away from: not used for new tasks, but
	// the device still holds the private key for tasks already sealed to it.
	SupersededAt int64 `json:"SupersededAt"`
	// RevokedAt != 0 means withdrawn: never usable again, for new or queued
	// tasks.
	RevokedAt int64 `json:"RevokedAt"`
}

func newDeviceKeyView(k DeviceKey) deviceKeyView {
	return deviceKeyView{
		ID: k.ID, Algorithm: k.Algorithm, PublicKey: k.PublicKey,
		Generation: k.Generation, CreatedAt: k.CreatedAt,
		SupersededAt: k.SupersededAt, RevokedAt: k.RevokedAt,
	}
}

// deviceInboxView is what a SENDER needs to decide whether and how to send.
//
// Presence and CanReceive are separate on purpose. An offline device that is
// properly enrolled CAN be sent to — the task queues and lands when it returns
// (PRD §7.3) — so collapsing them into one "available" flag would turn "offline"
// into "rejected" and remove the feature's whole reason to exist.
type deviceInboxView struct {
	// Presence is "online" or "offline", derived from PresenceExpiresAt at read
	// time. There is no third state and no stored boolean: a device that stops
	// heartbeating goes offline by itself.
	Presence          string `json:"Presence"`
	LastHeartbeatAt   int64  `json:"LastHeartbeatAt"`
	PresenceExpiresAt int64  `json:"PresenceExpiresAt"`
	// HeartbeatIntervalSeconds is what central expects; exposed so a UI can say
	// how stale "last seen" may legitimately be.
	HeartbeatIntervalSeconds int      `json:"HeartbeatIntervalSeconds"`
	ProtocolVersion          int      `json:"ProtocolVersion"`
	Capabilities             []string `json:"Capabilities"`
	ReceiveCapability        string   `json:"ReceiveCapability"`
	AutoAccept               string   `json:"AutoAccept"`
	ReceiveDirReady          bool     `json:"ReceiveDirReady"`
	Platform                 string   `json:"Platform"`
	AppVersion               string   `json:"AppVersion"`
	// Revoked marks an enrolment whose active key was revoked. Terminal until
	// the owner clears it.
	Revoked bool `json:"Revoked"`
	// CanReceive is the honest answer to "may I seal a task to this device":
	// enrolled, unrevoked, on a supported protocol version, and holding an
	// active public key.
	CanReceive   bool           `json:"CanReceive"`
	RegisteredAt int64          `json:"RegisteredAt"`
	Key          *deviceKeyView `json:"Key"` // active key; null when there is none
}

func (s *Service) newDeviceInboxView(in DeviceInbox, key DeviceKey, hasKey bool) *deviceInboxView {
	v := &deviceInboxView{
		Presence:                 inbox.Presence(in.PresenceExpiresAt, s.now().Unix(), in.RevokedAt != 0),
		LastHeartbeatAt:          in.LastHeartbeatAt,
		PresenceExpiresAt:        in.PresenceExpiresAt,
		HeartbeatIntervalSeconds: int(inbox.HeartbeatInterval.Seconds()),
		ProtocolVersion:          in.ProtocolVersion,
		Capabilities:             in.Capabilities,
		ReceiveCapability:        in.ReceiveCapability,
		AutoAccept:               in.AutoAccept,
		ReceiveDirReady:          in.ReceiveDirReady,
		Platform:                 in.Platform,
		AppVersion:               in.AppVersion,
		Revoked:                  in.RevokedAt != 0,
		CanReceive:               DeviceCanReceive(in, key, hasKey),
		RegisteredAt:             in.RegisteredAt,
	}
	if v.Capabilities == nil {
		v.Capabilities = []string{}
	}
	if hasKey && key.Active() {
		kv := newDeviceKeyView(key)
		v.Key = &kv
	}
	return v
}

// handleRegisterDeviceInbox (PUT /api/devices/{id}/inbox) enrols a device, or
// refreshes what an already-enrolled one announces.
//
// Negotiation is explicit and fails closed. A device whose protocol versions or
// receive capability central does not share is REFUSED and stores nothing, so a
// rolling fleet never ends up with a device that central silently assumed was
// v1. The response echoes what was agreed, which is what a rolling client needs
// to decide whether to proceed or report "please upgrade".
func (s *Service) handleRegisterDeviceInbox(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		// 404, not 403: a caller that is not this device must not learn whether
		// the id exists.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		Platform         string   `json:"platform"`
		AppVersion       string   `json:"appVersion"`
		ProtocolVersions []int    `json:"protocolVersions"`
		Capabilities     []string `json:"capabilities"`
		AutoAccept       string   `json:"autoAccept"`
		ReceiveDirReady  bool     `json:"receiveDirReady"`
	}
	if err := httpx.DecodeStrictJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	version, err := inbox.NegotiateProtocolVersion(in.ProtocolVersions)
	if err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	caps, err := inbox.ValidateCapabilities(in.Capabilities)
	if err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	receive, err := inbox.NegotiateReceiveCapability(caps)
	if err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	policy, err := inbox.ValidateAutoAccept(in.AutoAccept)
	if err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	if err := inbox.ValidateAutoAcceptCapability(policy, caps); err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	platform, err := inbox.ValidatePlatform(in.Platform)
	if err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	appVersion, err := inbox.ValidateAppVersion(in.AppVersion)
	if err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	now := s.now().Unix()
	saved, err := s.store.UpsertDeviceInbox(r.Context(), DeviceInbox{
		DeviceID: deviceID, UserID: u.ID,
		Platform: platform, AppVersion: appVersion,
		ProtocolVersion: version, Capabilities: caps, ReceiveCapability: receive,
		AutoAccept: policy, ReceiveDirReady: in.ReceiveDirReady,
		RegisteredAt: now, UpdatedAt: now,
	})
	if err != nil {
		s.writeDeviceInboxStoreError(w, err)
		return
	}
	key, hasKey, err := s.store.ActiveDeviceKey(r.Context(), deviceID, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"inbox": s.newDeviceInboxView(saved, key, hasKey),
		// Echoed at the top level as well so a client can read what was agreed
		// without parsing the whole view.
		"protocolVersion":   saved.ProtocolVersion,
		"receiveCapability": saved.ReceiveCapability,
		"keyAlgorithm":      inbox.KeyAlgX25519SealedBoxV1,
	})
}

// handleDeleteDeviceInbox (DELETE /api/devices/{id}/inbox) removes an enrolment
// and its whole key history, so the device may enrol again from scratch.
//
// A REVOKED enrolment may not be cleared by the revoked device itself. Without
// that rule key revocation would be theatre: the device whose key was revoked
// because it was stolen still holds a working account bearer, and could simply
// clear its own revocation and register a fresh key. Clearing therefore requires
// a browser session or another device's credential. The complete remedy for a
// lost device remains DELETE /api/devices/{id}, which also destroys its bearer.
func (s *Service) handleDeleteDeviceInbox(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	// Whether the caller IS this device is resolved here; whether that makes the
	// delete legal is decided inside the store transaction, so a revoked device
	// cannot win a race against the revocation it is trying to escape.
	deleted, err := s.store.DeleteDeviceInbox(r.Context(), deviceID, u.ID, s.deviceSelf(r, u.ID, deviceID), s.now().Unix())
	if errors.Is(err, ErrRevokedSelfClear) {
		httpx.WriteJSON(w, http.StatusForbidden, map[string]string{
			"error": "revoked_device_cannot_clear_itself",
		})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !deleted {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleRegisterDeviceKey (POST /api/devices/{id}/inbox/keys) registers a
// device's first end-to-end public key or rotates to a new one.
//
// The request carries a PUBLIC key and the id of the key it replaces. There is
// no field for a private key or a content key, and adding one would be a
// zero-knowledge regression, not a feature: central's entire role here is to
// publish a key senders wrap to.
//
// previousKeyId is mandatory for a rotation and must name the CURRENT key. That
// compare-and-swap is what makes a captured registration request useless on
// replay — see SQLiteStore.RotateDeviceKey.
func (s *Service) handleRegisterDeviceKey(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		Algorithm     string `json:"algorithm"`
		PublicKey     string `json:"publicKey"`
		PreviousKeyID string `json:"previousKeyId"`
	}
	if err := httpx.DecodeStrictJSONBody(w, r, &in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if _, err := inbox.ValidatePublicKey(in.Algorithm, in.PublicKey); err != nil {
		s.writeInboxNegotiationError(w, err)
		return
	}
	saved, err := s.store.RotateDeviceKey(r.Context(), DeviceKey{
		ID: authx.NewID(), DeviceID: deviceID, UserID: u.ID,
		Algorithm: in.Algorithm, PublicKey: in.PublicKey, CreatedAt: s.now().Unix(),
	}, in.PreviousKeyID)
	if err != nil {
		s.writeDeviceInboxStoreError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"key": newDeviceKeyView(saved)})
}

// handleListDeviceKeys (GET /api/devices/{id}/inbox/keys) returns the device's
// full public-key history, newest first.
//
// Account-scoped rather than device-self: the point of the history is that
// ANOTHER of the account's surfaces (the web devices page) can see which key is
// current, which were rotated away from, and which were revoked.
func (s *Service) handleListDeviceKeys(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	// Gate on the enrolment: keys cannot exist without one, so this is also the
	// "does this device exist under this account" check, without leaking the
	// difference between "not yours" and "not enrolled".
	if _, found, err := s.store.GetDeviceInbox(r.Context(), deviceID, u.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	} else if !found {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	keys, err := s.store.ListDeviceKeys(r.Context(), deviceID, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]deviceKeyView, 0, len(keys))
	for _, k := range keys {
		out = append(out, newDeviceKeyView(k))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"keys": out})
}

// handleRevokeDeviceKey (POST /api/devices/{id}/inbox/keys/{keyId}/revoke)
// permanently withdraws one public key.
//
// Account-scoped by necessity: revoking the key of a lost laptop has to be
// possible FROM SOMETHING ELSE. Revoking the ACTIVE key also revokes the
// enrolment and expires presence in the same transaction, so the device stops
// being a send target immediately rather than at the next TTL boundary.
func (s *Service) handleRevokeDeviceKey(w http.ResponseWriter, r *http.Request, u User) {
	deviceID, keyID := r.PathValue("id"), r.PathValue("keyId")
	revokedActive, ok, err := s.store.RevokeDeviceKey(r.Context(), deviceID, u.ID, keyID, s.now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		// True when the revoked key was the current one, which also revoked the
		// enrolment: the caller's UI must stop offering this device as a target.
		"revokedActiveKey": revokedActive,
		"deviceRevoked":    revokedActive,
	})
}

// handleDeviceInboxHeartbeat (POST /api/devices/{id}/inbox/heartbeat) refreshes
// presence for inbox.PresenceTTL.
//
// Device-self only. A browser session must not be able to assert that a server
// is online — presence exists so a sender knows whether their file lands now or
// waits, and a claim made by anything other than the machine itself is a guess
// dressed as a fact.
func (s *Service) handleDeviceInboxHeartbeat(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		ReceiveDirReady bool `json:"receiveDirReady"`
	}
	// An empty body is a valid heartbeat (receiveDirReady defaults to false).
	// Check the decoder's EOF result rather than ContentLength: HTTP/2 and
	// chunked requests legitimately use -1 even when their body is empty.
	if err := httpx.DecodeStrictJSONBody(w, r, &in); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	now := s.now()
	expires := inbox.PresenceExpiry(now)
	ok, err := s.store.TouchDeviceInboxPresence(r.Context(), deviceID, u.ID, now.Unix(), expires, in.ReceiveDirReady)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		// The UPDATE matched nothing: either there is no enrolment, or it is
		// revoked. Both are terminal for this device until something changes on
		// the account side, so tell the client which it is instead of leaving it
		// to retry forever.
		s.writeInboxUnavailable(w, r, u, deviceID)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"presence":                 inbox.PresenceOnline,
		"presenceExpiresAt":        expires,
		"heartbeatIntervalSeconds": int(inbox.HeartbeatInterval.Seconds()),
	})
}

// handleDeviceInboxOffline (POST /api/devices/{id}/inbox/offline) is the
// graceful goodbye of a device shutting down: it expires its own presence now
// instead of leaving senders to wait out the TTL believing it is still there.
func (s *Service) handleDeviceInboxOffline(w http.ResponseWriter, r *http.Request, u User) {
	deviceID := r.PathValue("id")
	if !s.deviceSelf(r, u.ID, deviceID) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	ok, err := s.store.ExpireDeviceInboxPresence(r.Context(), deviceID, u.ID, s.now().Unix())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		s.writeInboxUnavailable(w, r, u, deviceID)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"presence": inbox.PresenceOffline})
}

// writeInboxUnavailable distinguishes "never enrolled" (404) from "revoked"
// (409) after a presence write matched no row. A device that keeps retrying a
// heartbeat it can never satisfy is a client bug central can prevent by saying
// which of the two happened.
func (s *Service) writeInboxUnavailable(w http.ResponseWriter, r *http.Request, u User, deviceID string) {
	existing, found, err := s.store.GetDeviceInbox(r.Context(), deviceID, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if found && existing.RevokedAt != 0 {
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "device_inbox_revoked"})
		return
	}
	http.Error(w, "not found", http.StatusNotFound)
}

// writeInboxNegotiationError maps a protocol/validation failure to a status and
// a machine-readable code.
//
// A failed NEGOTIATION is 409, not 400: the request was well-formed, the two
// sides simply do not overlap, and the client's correct response is to upgrade
// or stop — not to fix its JSON. The supported sets are echoed so a rolling
// client can say something actionable instead of "registration failed".
func (s *Service) writeInboxNegotiationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, inbox.ErrUnsupportedProtocol):
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":              "unsupported_protocol_version",
			"supportedProtocols": inbox.SupportedProtocolVersions(),
		})
	case errors.Is(err, inbox.ErrUnsupportedCapability):
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":                        "unsupported_capability",
			"supportedReceiveCapabilities": inbox.SupportedReceiveCapabilities(),
		})
	case errors.Is(err, inbox.ErrUnsupportedAutoAcceptCapability):
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":                "unsupported_auto_accept_capability",
			"requiredCapabilities": []string{inbox.CapAutoAcceptV1},
		})
	case errors.Is(err, inbox.ErrUnknownKeyAlgorithm):
		httpx.WriteJSON(w, http.StatusConflict, map[string]any{
			"error":               "unsupported_key_algorithm",
			"supportedAlgorithms": []string{inbox.KeyAlgX25519SealedBoxV1},
		})
	case errors.Is(err, inbox.ErrUnusablePublicKey):
		// Distinct from "malformed": the key parsed fine and is exactly the
		// wrong thing — a low-order point, to which every wrap is public.
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unusable_public_key"})
	case errors.Is(err, inbox.ErrMalformedPublicKey):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "malformed_public_key"})
	case errors.Is(err, inbox.ErrMalformedCapability), errors.Is(err, inbox.ErrTooManyCapabilities):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_capabilities"})
	case errors.Is(err, inbox.ErrTooManyProtocolVer):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_protocol_versions"})
	case errors.Is(err, inbox.ErrInvalidAutoAccept):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_auto_accept"})
	case errors.Is(err, inbox.ErrInvalidPlatform), errors.Is(err, inbox.ErrInvalidAppVersion):
		httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_device_metadata"})
	default:
		http.Error(w, "bad request", http.StatusBadRequest)
	}
}

// writeDeviceInboxStoreError maps the store's distinct outcomes to status codes.
// Each one implies different client behaviour, which is why they are not
// collapsed: "stale rotation" means stop and re-read the current key, "revoked"
// means stop entirely and ask a human, "not registered" means enrol first.
func (s *Service) writeDeviceInboxStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, ErrDeviceInboxRevoked):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "device_inbox_revoked"})
	case errors.Is(err, ErrDeviceInboxNotRegistered):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "device_inbox_not_registered"})
	case errors.Is(err, ErrStaleKeyRotation):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "stale_key_rotation"})
	case errors.Is(err, ErrDeviceKeyReused):
		httpx.WriteJSON(w, http.StatusConflict, map[string]string{"error": "device_key_reused"})
	default:
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}
