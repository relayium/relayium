package account

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/relayium/relayium/internal/inbox"
)

// Device Inbox store errors. Each is a DISTINCT product outcome the handler
// turns into its own status code, rather than a generic 500 that would leave a
// device unable to tell "you replayed a stale rotation" from "central is down"
// — the two need opposite client behaviour (stop vs. retry).
var (
	// ErrDeviceInboxRevoked: the enrolment's active key was revoked. Terminal
	// for this enrolment — the device cannot heartbeat or register a new key
	// until the owner explicitly deletes the enrolment. This is the fail-safe
	// half of revocation: without it, a device whose key was revoked BECAUSE it
	// was stolen would simply register a fresh key with the bearer it still
	// holds and carry on receiving files.
	ErrDeviceInboxRevoked = errors.New("account: device inbox is revoked")
	// ErrDeviceInboxNotRegistered: a key operation arrived before enrolment.
	// Keys are refused until a protocol version has been negotiated, so no key
	// can exist for a version central never agreed to.
	ErrDeviceInboxNotRegistered = errors.New("account: device inbox is not registered")
	// ErrStaleKeyRotation: the rotation named a predecessor that is not the
	// current key (or named none while one exists). This is what makes a
	// replayed or reordered rotation fail instead of silently reinstating an
	// old key as current.
	ErrStaleKeyRotation = errors.New("account: stale device key rotation")
	// ErrDeviceKeyReused: the submitted public key already appears earlier in
	// this device's history. Rotating "forward" onto a key that was previously
	// rotated away from — or revoked — is a downgrade, not a rotation.
	ErrDeviceKeyReused = errors.New("account: device key already used")
	// ErrRevokedSelfClear: a REVOKED device tried to clear its own enrolment.
	// Decided inside the delete transaction rather than by a read-then-write in
	// the handler: a revoked device still holds a working bearer, so a
	// check-then-delete would leave it a race to win against the revocation it
	// is trying to escape.
	ErrRevokedSelfClear = errors.New("account: a revoked device cannot clear its own inbox")
)

const deviceInboxCols = `device_id, user_id, platform, app_version, protocol_version,
	capabilities, receive_capability, auto_accept, receive_dir_ready,
	last_heartbeat_at, presence_expires_at, registered_at, updated_at, revoked_at`

const deviceKeyCols = `id, device_id, user_id, algorithm, public_key, generation,
	created_at, superseded_at, revoked_at`

// capabilitySep joins the canonical capability list into the single TEXT column.
// A space is safe as a separator precisely because inbox.ValidateCapabilities
// rejects any token containing one — the split can never produce a token the
// validator would not have accepted.
const capabilitySep = " "

func encodeCapabilities(caps []string) string { return strings.Join(caps, capabilitySep) }

func decodeCapabilities(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, capabilitySep)
}

// rowScanner (sqlite.go) is reused so one scan helper serves both a QueryRow
// result and a *sql.Rows cursor.
func scanDeviceInbox(row rowScanner) (DeviceInbox, error) {
	var in DeviceInbox
	var caps string
	var ready int64
	err := row.Scan(&in.DeviceID, &in.UserID, &in.Platform, &in.AppVersion, &in.ProtocolVersion,
		&caps, &in.ReceiveCapability, &in.AutoAccept, &ready,
		&in.LastHeartbeatAt, &in.PresenceExpiresAt, &in.RegisteredAt, &in.UpdatedAt, &in.RevokedAt)
	if err != nil {
		return DeviceInbox{}, err
	}
	in.Capabilities = decodeCapabilities(caps)
	in.ReceiveDirReady = ready != 0
	return in, nil
}

func scanDeviceKey(row rowScanner) (DeviceKey, error) {
	var k DeviceKey
	err := row.Scan(&k.ID, &k.DeviceID, &k.UserID, &k.Algorithm, &k.PublicKey, &k.Generation,
		&k.CreatedAt, &k.SupersededAt, &k.RevokedAt)
	return k, err
}

// deviceOwned re-checks inside the transaction that this device exists and
// belongs to this user. Every Device Inbox write goes through it: a device id is
// a guessable opaque string, so ownership is a query result, never an inference
// from whatever credential got the caller through the door.
func deviceOwned(ctx context.Context, tx *sql.Tx, deviceID, userID string) error {
	var got string
	err := tx.QueryRowContext(ctx,
		`SELECT id FROM devices WHERE id = ? AND user_id = ?`, deviceID, userID).Scan(&got)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// UpsertDeviceInbox creates or updates a device's enrolment.
//
// It touches NO presence column. Registering says what a device can do, not that
// it is running — a client that registers and then crashes must not leave a
// sender believing it is online, so only a heartbeat may set presence.
// registered_at is likewise preserved across updates: it records first
// enrolment, and a routine capability refresh must not restate it.
func (s *SQLiteStore) UpsertDeviceInbox(ctx context.Context, in DeviceInbox) (DeviceInbox, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeviceInbox{}, err
	}
	defer tx.Rollback()
	if err := deviceOwned(ctx, tx, in.DeviceID, in.UserID); err != nil {
		return DeviceInbox{}, err
	}
	var revokedAt int64
	err = tx.QueryRowContext(ctx,
		`SELECT revoked_at FROM device_inbox WHERE device_id = ? AND user_id = ?`,
		in.DeviceID, in.UserID).Scan(&revokedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return DeviceInbox{}, err
	}
	if err == nil && revokedAt != 0 {
		return DeviceInbox{}, ErrDeviceInboxRevoked
	}
	ready := int64(0)
	if in.ReceiveDirReady {
		ready = 1
	}
	// The ON CONFLICT list is deliberately narrow. last_heartbeat_at,
	// presence_expires_at, registered_at and revoked_at are all ABSENT from it,
	// for the same reason UpsertNode omits label/draining: a routine
	// re-registration must not be able to clear state it does not own.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO device_inbox (`+deviceInboxCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0)
		 ON CONFLICT(device_id) DO UPDATE SET
		   platform = excluded.platform,
		   app_version = excluded.app_version,
		   protocol_version = excluded.protocol_version,
		   capabilities = excluded.capabilities,
		   receive_capability = excluded.receive_capability,
		   auto_accept = excluded.auto_accept,
		   receive_dir_ready = excluded.receive_dir_ready,
		   updated_at = excluded.updated_at
		 WHERE device_inbox.user_id = excluded.user_id`,
		in.DeviceID, in.UserID, in.Platform, in.AppVersion, in.ProtocolVersion,
		encodeCapabilities(in.Capabilities), in.ReceiveCapability, in.AutoAccept, ready,
		in.RegisteredAt, in.UpdatedAt); err != nil {
		return DeviceInbox{}, err
	}
	out, err := scanDeviceInbox(tx.QueryRowContext(ctx,
		`SELECT `+deviceInboxCols+` FROM device_inbox WHERE device_id = ? AND user_id = ?`,
		in.DeviceID, in.UserID))
	if err != nil {
		return DeviceInbox{}, err
	}
	return out, tx.Commit()
}

func (s *SQLiteStore) GetDeviceInbox(ctx context.Context, deviceID, userID string) (DeviceInbox, bool, error) {
	in, err := scanDeviceInbox(s.reader().QueryRowContext(ctx,
		`SELECT `+deviceInboxCols+` FROM device_inbox WHERE device_id = ? AND user_id = ?`,
		deviceID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return DeviceInbox{}, false, nil
	}
	if err != nil {
		return DeviceInbox{}, false, err
	}
	return in, true, nil
}

func (s *SQLiteStore) ListDeviceInboxes(ctx context.Context, userID string) (map[string]DeviceInbox, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+deviceInboxCols+` FROM device_inbox WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]DeviceInbox)
	for rows.Next() {
		in, err := scanDeviceInbox(rows)
		if err != nil {
			return nil, err
		}
		out[in.DeviceID] = in
	}
	return out, rows.Err()
}

// DeleteDeviceInbox removes the enrolment and the device's whole key history.
// This is the owner's deliberate re-enrolment path: a revoked device becomes
// eligible to register again only after a human decided it should be, never by
// the device's own retry.
//
// byDeviceItself says the caller's bearer is bound to THIS device row. When it
// is, a revoked enrolment is refused (ErrRevokedSelfClear). That decision is
// made HERE, inside the transaction that does the delete, not by the handler
// reading first: the revoked device still holds a working bearer, so a
// check-then-delete would give it a race to win against a revocation landing at
// the same moment — which is precisely the scenario revocation exists for.
func (s *SQLiteStore) DeleteDeviceInbox(ctx context.Context, deviceID, userID string, byDeviceItself bool) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var revokedAt int64
	err = tx.QueryRowContext(ctx,
		`SELECT revoked_at FROM device_inbox WHERE device_id = ? AND user_id = ?`,
		deviceID, userID).Scan(&revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if byDeviceItself && revokedAt != 0 {
		return false, ErrRevokedSelfClear
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM device_inbox WHERE device_id = ? AND user_id = ?`, deviceID, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	// Keys are deleted whether or not an enrolment row was present, so a
	// half-created state (keys with no enrolment, which cannot happen through
	// the API but would be unrecoverable if it did) still cleans up.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM device_keys WHERE device_id = ? AND user_id = ?`, deviceID, userID); err != nil {
		return false, err
	}
	return n > 0, tx.Commit()
}

// TouchDeviceInboxPresence records a heartbeat. The `revoked_at = 0` term in the
// WHERE clause is the load-bearing part: a revoked device presenting a still-valid
// bearer must not be able to put itself back on a sender's list.
func (s *SQLiteStore) TouchDeviceInboxPresence(ctx context.Context, deviceID, userID string, now, expiresAt int64, receiveDirReady bool) (bool, error) {
	ready := int64(0)
	if receiveDirReady {
		ready = 1
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE device_inbox
		    SET last_heartbeat_at = ?, presence_expires_at = ?, receive_dir_ready = ?, updated_at = ?
		  WHERE device_id = ? AND user_id = ? AND revoked_at = 0`,
		now, expiresAt, ready, now, deviceID, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ExpireDeviceInboxPresence is the graceful goodbye a shutting-down device
// sends. last_heartbeat_at is left alone — it is the honest record of when the
// device was last heard from, and rewriting it here would make a clean shutdown
// indistinguishable from a live device in the UI's "last seen" column.
func (s *SQLiteStore) ExpireDeviceInboxPresence(ctx context.Context, deviceID, userID string, now int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE device_inbox SET presence_expires_at = 0, updated_at = ?
		  WHERE device_id = ? AND user_id = ? AND revoked_at = 0`,
		now, deviceID, userID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RotateDeviceKey installs a device's first key or replaces its current one, as
// a compare-and-swap against previousKeyID.
//
// The CAS is what makes rotation replay-safe. Every rotation must name the key
// it replaces:
//
//   - previousKeyID == "" means "I have no key yet", and is refused if one
//     exists. A captured first-registration request replayed after two
//     rotations therefore fails instead of installing a key the device may no
//     longer hold.
//   - previousKeyID == X is refused unless X is the CURRENT key. A captured
//     A→B rotation replayed once the device is on C fails, because A is no
//     longer current.
//
// Retrying the SAME rotation is still safe: if the submitted key is already the
// current one, the existing row is returned unchanged (idempotent), so a client
// that lost the response to a successful rotation converges rather than
// deadlocking against its own CAS.
func (s *SQLiteStore) RotateDeviceKey(ctx context.Context, k DeviceKey, previousKeyID string) (DeviceKey, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return DeviceKey{}, err
	}
	defer tx.Rollback()
	if err := deviceOwned(ctx, tx, k.DeviceID, k.UserID); err != nil {
		return DeviceKey{}, err
	}
	// Keys require a negotiated enrolment: no key may exist for a protocol
	// version central never agreed to.
	var revokedAt int64
	err = tx.QueryRowContext(ctx,
		`SELECT revoked_at FROM device_inbox WHERE device_id = ? AND user_id = ?`,
		k.DeviceID, k.UserID).Scan(&revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DeviceKey{}, ErrDeviceInboxNotRegistered
	}
	if err != nil {
		return DeviceKey{}, err
	}
	if revokedAt != 0 {
		return DeviceKey{}, ErrDeviceInboxRevoked
	}

	current, err := scanDeviceKey(tx.QueryRowContext(ctx,
		`SELECT `+deviceKeyCols+` FROM device_keys
		  WHERE device_id = ? AND superseded_at = 0
		  ORDER BY generation DESC LIMIT 1`, k.DeviceID))
	hasCurrent := true
	if errors.Is(err, sql.ErrNoRows) {
		hasCurrent = false
	} else if err != nil {
		return DeviceKey{}, err
	}

	// Idempotent retry: the submitted key IS already the current key. Checked
	// before the CAS on purpose — a retry of a rotation whose response was lost
	// carries the OLD previousKeyID, which the CAS would (correctly) reject.
	if hasCurrent && current.Algorithm == k.Algorithm && current.PublicKey == k.PublicKey {
		if current.RevokedAt != 0 {
			return DeviceKey{}, ErrDeviceInboxRevoked
		}
		return current, nil
	}
	// A key that appears ANYWHERE else in this device's history is refused.
	// Rotating onto a superseded key undoes a rotation; rotating onto a revoked
	// key reinstates something a human withdrew.
	var reused int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM device_keys WHERE device_id = ? AND algorithm = ? AND public_key = ?`,
		k.DeviceID, k.Algorithm, k.PublicKey).Scan(&reused); err != nil {
		return DeviceKey{}, err
	}
	if reused > 0 {
		return DeviceKey{}, ErrDeviceKeyReused
	}

	switch {
	case !hasCurrent && previousKeyID != "":
		return DeviceKey{}, ErrStaleKeyRotation
	case hasCurrent && previousKeyID == "":
		return DeviceKey{}, ErrStaleKeyRotation
	case hasCurrent && previousKeyID != current.ID:
		return DeviceKey{}, ErrStaleKeyRotation
	}

	k.Generation = 1
	if hasCurrent {
		if current.RevokedAt != 0 {
			// The current key was revoked but the enrolment somehow was not.
			// Refuse rather than rotate away from a withdrawn key, which would
			// quietly restore the device to service.
			return DeviceKey{}, ErrDeviceInboxRevoked
		}
		// Conditional on superseded_at = 0 so a concurrent rotation that already
		// superseded this row loses here instead of forking the history. The
		// UNIQUE(device_id, generation) index is the second guard: two writers
		// cannot both land generation N.
		res, err := tx.ExecContext(ctx,
			`UPDATE device_keys SET superseded_at = ? WHERE id = ? AND superseded_at = 0`,
			k.CreatedAt, current.ID)
		if err != nil {
			return DeviceKey{}, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return DeviceKey{}, ErrStaleKeyRotation
		}
		k.Generation = current.Generation + 1
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO device_keys (`+deviceKeyCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
		k.ID, k.DeviceID, k.UserID, k.Algorithm, k.PublicKey, k.Generation, k.CreatedAt); err != nil {
		return DeviceKey{}, err
	}
	k.SupersededAt = 0
	k.RevokedAt = 0
	return k, tx.Commit()
}

// ActiveDeviceKey returns the key a NEW task must be sealed to. Superseded and
// revoked keys are excluded by the query, so a caller cannot accidentally reach
// for one.
func (s *SQLiteStore) ActiveDeviceKey(ctx context.Context, deviceID, userID string) (DeviceKey, bool, error) {
	k, err := scanDeviceKey(s.reader().QueryRowContext(ctx,
		`SELECT `+deviceKeyCols+` FROM device_keys
		  WHERE device_id = ? AND user_id = ? AND superseded_at = 0 AND revoked_at = 0
		  ORDER BY generation DESC LIMIT 1`, deviceID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return DeviceKey{}, false, nil
	}
	if err != nil {
		return DeviceKey{}, false, err
	}
	return k, true, nil
}

func (s *SQLiteStore) ActiveDeviceKeys(ctx context.Context, userID string) (map[string]DeviceKey, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+deviceKeyCols+` FROM device_keys
		  WHERE user_id = ? AND superseded_at = 0 AND revoked_at = 0`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]DeviceKey)
	for rows.Next() {
		k, err := scanDeviceKey(rows)
		if err != nil {
			return nil, err
		}
		out[k.DeviceID] = k
	}
	return out, rows.Err()
}

func (s *SQLiteStore) ListDeviceKeys(ctx context.Context, deviceID, userID string) ([]DeviceKey, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+deviceKeyCols+` FROM device_keys
		  WHERE device_id = ? AND user_id = ? ORDER BY generation DESC`, deviceID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DeviceKey
	for rows.Next() {
		k, err := scanDeviceKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// RevokeDeviceKey marks one key permanently unusable.
//
// Revoking the ACTIVE key revokes the enrolment and expires presence in the SAME
// transaction. Doing it in one step is the point: any gap in which the device
// has no usable key but still reports as an online, enrolled send target is a
// window where the UI offers a destination that cannot receive.
//
// Idempotent — revoking an already-revoked key reports the same outcome rather
// than failing, so a retried revoke (the panicked "revoke it again" click) is
// harmless.
func (s *SQLiteStore) RevokeDeviceKey(ctx context.Context, deviceID, userID, keyID string, now int64) (bool, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, false, err
	}
	defer tx.Rollback()
	k, err := scanDeviceKey(tx.QueryRowContext(ctx,
		`SELECT `+deviceKeyCols+` FROM device_keys WHERE id = ? AND device_id = ? AND user_id = ?`,
		keyID, deviceID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	wasActive := k.SupersededAt == 0
	if k.RevokedAt == 0 {
		if _, err := tx.ExecContext(ctx,
			`UPDATE device_keys SET revoked_at = ? WHERE id = ? AND revoked_at = 0`, now, keyID); err != nil {
			return false, false, err
		}
	}
	if wasActive {
		if _, err := tx.ExecContext(ctx,
			`UPDATE device_inbox SET revoked_at = ?, presence_expires_at = 0, updated_at = ?
			  WHERE device_id = ? AND user_id = ? AND revoked_at = 0`,
			now, now, deviceID, userID); err != nil {
			return false, false, err
		}
	}
	return wasActive, true, tx.Commit()
}

// DeviceCanReceive reports whether a device is a legitimate target for a NEW encrypted
// task: enrolled, not revoked, on a protocol version central still supports, and
// holding an active public key to seal the content key to.
//
// Deliberately independent of presence. An offline device that satisfies all of
// this CAN be sent to — the task queues and lands when it comes back (PRD §7.3),
// which is the whole reason the queue exists. Conflating the two would make
// "offline" mean "rejected".
func DeviceCanReceive(in DeviceInbox, key DeviceKey, hasKey bool) bool {
	return in.DeviceID != "" &&
		in.RevokedAt == 0 &&
		in.ProtocolVersion >= inbox.MinProtocolVersion &&
		in.ProtocolVersion <= inbox.MaxProtocolVersion &&
		in.ReceiveCapability == inbox.CapReceiveV1 &&
		hasKey && key.Active()
}
