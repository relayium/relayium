package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// The App Store Server Notification ledger.
//
// It is TWO things in one table, and that is deliberate:
//
//  1. the durable idempotency record for `notificationUUID`, so a redelivery or
//     a concurrent duplicate cannot apply the same event twice; and
//  2. the replayable projection of a notification this server verified but
//     could not act on yet, so a delivery is never the only copy of a fact.
//
// WHY THEY ARE ONE TABLE. A separate "seen UUIDs" table and a separate "deferred
// work" table would need to be written in one transaction anyway — a UUID
// recorded without its projection is a delivery Apple will never send again and
// this server can no longer reconstruct. Keeping them in one row makes that
// impossible to get wrong: the row either exists with everything needed to
// replay it, or it does not exist.
//
// WHY IT IS NOT "RECORD, THEN APPLY". The obvious idempotency shape — write the
// UUID, apply the event, and treat any later delivery of that UUID as done — has
// a window that loses data permanently: a crash between the write and the apply
// leaves a UUID marked seen and an entitlement never granted, and every retry
// then short-circuits on the record. So the record is a CLAIM, not a completion:
// only appleNotificationApplied (and the two terminal states below) end the
// work, and any row that is not terminal is re-applied on the next delivery.
// Re-applying is safe because ApplySubscriptionSource is idempotent for a given
// event clock — see appleEventClock.
const (
	// appleNotificationReceived is the CLAIM. A row sitting here is a delivery
	// that was verified and then interrupted — by a crash, a storage failure, or
	// a still-running request. It is not evidence that anything was applied, and
	// the next delivery of the same UUID redoes the work.
	appleNotificationReceived = "received"
	// appleNotificationApplied is terminal success: the entitlement path ran and
	// committed. A redelivery is a no-op 200.
	appleNotificationApplied = "applied"
	// appleNotificationIgnored is terminal: a verified envelope for a configured
	// app that carried NO nested transaction at all — a summary-shaped
	// RENEWAL_EXTENSION, say. There is no entitlement fact in it and the
	// notification type is not permitted to supply one. It still leaves a row, so
	// "ignored" is something an operator can count and read rather than an
	// absence.
	appleNotificationIgnored = "ignored"
	// appleNotificationUnsupported is terminal: a fully verified transaction of a
	// kind this entitlement model does not represent — a consumable, a
	// non-renewing purchase, a family-shared subscription. Kept apart from
	// `ignored` because the two are different operator facts: one means Apple sent
	// no transaction, the other means Apple sent one and this server deliberately
	// declined to interpret it. Never drained, because draining it would be the
	// guess it exists to avoid.
	//
	// Ownership is deliberately NOT consulted before landing here. It could in
	// principle matter — a notification about a subscription this server already
	// grants for, in a shape it does not model, is one it cannot act on — but
	// inAppOwnershipType and type are properties of the purchase rather than
	// states a live subscription moves through, so a subscription that was
	// PURCHASED when it was granted does not later become FAMILY_SHARED. Spending
	// an ownership lookup on every such delivery would buy an unreachable case;
	// the row records original_transaction_id either way, so an operator who ever
	// does see one can join it against subscription_sources.
	appleNotificationUnsupported = "unsupported"
	// appleNotificationPending is a verified, actionable notification this server
	// has not applied: either no owner could be resolved — most often because
	// Apple's notification beat the purchasing client's own intake call — or the
	// purchase names a product with no live catalog mapping. The projection is
	// stored, and reconcileApplePendingNotifications replays it once the missing
	// piece exists.
	appleNotificationPending = "pending"
	// appleNotificationConflict is a verified notification whose subscription is
	// owned by a DIFFERENT Relayium account than its attribution token names.
	// That is a contradiction between Apple's record and ours; it grants nothing,
	// it is preserved rather than dropped, and its delivery is deliberately
	// failed so it stays visible in App Store Connect's notification history.
	appleNotificationConflict = "conflict"
)

// appleNotificationTerminal reports whether a recorded state means the work is
// finished. Only these states short-circuit a redelivery; everything else is
// re-applied, which is what closes the record-before-apply window.
//
// `pending` and `conflict` are deliberately absent. Both are durable and both
// answer honestly, but neither is finished — a pending row is waiting for an
// owner and a conflicting one is waiting for a human, so a redelivery of either
// must re-run the decision rather than be told the work is over.
func appleNotificationTerminal(state string) bool {
	switch state {
	case appleNotificationApplied, appleNotificationIgnored, appleNotificationUnsupported:
		return true
	}
	return false
}

// AppleNotificationProjection is everything needed to derive this
// notification's entitlement event again, later, without Apple.
//
// It is the VERIFIED transaction reduced to exactly the inputs appleSourceEvent
// and the ownership lookups consume — and nothing else. In particular it holds
// no JWS, no certificate, no raw payload and no transaction id: none of them is
// needed to replay, and each would be a copy of signed material sitting in a
// database that does not need it.
type AppleNotificationProjection struct {
	BundleID              string
	ProductID             string
	OriginalTransactionID string
	// Environment is the signed environment the transaction belongs to. It is
	// part of the subscription's IDENTITY, not a label: originalTransactionId is
	// unique only within a store, so a replay that did not know which store this
	// row came from could apply a Sandbox event to a Production subscription.
	//
	// Rows written before this column existed carry ''. That is a genuine
	// unknown and is never guessed — see reconcileApplePendingNotifications,
	// which skips such a row and says so, rather than defaulting it to either
	// store. Only `pending` rows are ever replayed, and a deployment that had no
	// Apple configuration at all has none of those.
	Environment string
	// AppAccountToken is the attribution key, exactly as the transaction carried
	// it. Possession still authorizes nothing; it is the lookup, not the proof.
	AppAccountToken string
	PurchaseDateMS  int64
	ExpiresDateMS   int64
	// RevocationDateMS and IsUpgraded are what make a transaction TERMINAL, and
	// they are stored because appleEventClock's low bit depends on them: a
	// replayed projection that forgot them would order a refund as though it were
	// still live.
	RevocationDateMS int64
	IsUpgraded       bool
}

// appleNotificationProjection reduces a verified transaction to what a replay
// needs. Defined here, next to the columns, so the stored set and the replay set
// cannot drift apart.
func appleNotificationProjection(tx VerifiedAppleTransaction) AppleNotificationProjection {
	return AppleNotificationProjection{
		BundleID: tx.BundleID, ProductID: tx.ProductID,
		OriginalTransactionID: tx.OriginalTransactionID,
		Environment:           tx.Environment,
		AppAccountToken:       tx.AppAccountToken,
		PurchaseDateMS:        tx.PurchaseDateMS,
		ExpiresDateMS:         tx.ExpiresDateMS,
		RevocationDateMS:      tx.RevocationDateMS,
		IsUpgraded:            tx.IsUpgraded,
	}
}

// transaction rebuilds the subset of VerifiedAppleTransaction that
// appleSourceEvent reads.
//
// The returned value is deliberately NOT a full VerifiedAppleTransaction: the
// fields it leaves zero (transaction id, type, ownership type, signed date) are
// ones appleSourceEvent does not consult, and populating them with
// plausible-looking values would invite a future reader to trust a field this
// row never verified. Everything present here came out of a JWS that verified at
// the time it was recorded — including the environment, which appleSourceEvent
// DOES consult, because it is half of the subscription's external identity.
func (p AppleNotificationProjection) transaction() VerifiedAppleTransaction {
	return VerifiedAppleTransaction{
		BundleID: p.BundleID, ProductID: p.ProductID,
		OriginalTransactionID: p.OriginalTransactionID,
		Environment:           p.Environment,
		AppAccountToken:       p.AppAccountToken,
		PurchaseDateMS:        p.PurchaseDateMS,
		ExpiresDateMS:         p.ExpiresDateMS,
		RevocationDateMS:      p.RevocationDateMS,
		IsUpgraded:            p.IsUpgraded,
	}
}

// AppleNotificationRecord is one ledger row.
type AppleNotificationRecord struct {
	UUID  string
	State string
	// Type is Apple's notificationType, recorded for operators ONLY. Nothing
	// reads it to decide anything — see apple_notification.go's file comment.
	Type       string
	ReceivedAt int64
	UpdatedAt  int64
	// Supported records whether the verified nested transaction was a shape the
	// subscription model accepts. It must survive a failed terminal-state write:
	// otherwise a retry of an unsupported transaction would reconstruct only its
	// entitlement fields and accidentally treat it as supported.
	Supported  bool
	Projection AppleNotificationProjection
}

// appleNotificationCols is the full column list. `environment` is LAST because
// ALTER TABLE appends, so this list matches the physical order in a migrated
// database as well as in a freshly created one. Every statement here names its
// columns explicitly, which is what lets an older binary — whose list does not
// include this column — keep reading and writing the same table; the column's
// NOT NULL default is what makes its INSERT still land.
const appleNotificationCols = `notification_uuid, state, notification_type, received_at, updated_at,
	supported, bundle_id, product_id, original_transaction_id, app_account_token,
	purchase_date_ms, expires_date_ms, revocation_date_ms, is_upgraded, environment`

func scanAppleNotification(sc rowScanner) (AppleNotificationRecord, error) {
	var r AppleNotificationRecord
	var supported, upgraded int64
	err := sc.Scan(&r.UUID, &r.State, &r.Type, &r.ReceivedAt, &r.UpdatedAt,
		&supported,
		&r.Projection.BundleID, &r.Projection.ProductID, &r.Projection.OriginalTransactionID,
		&r.Projection.AppAccountToken, &r.Projection.PurchaseDateMS, &r.Projection.ExpiresDateMS,
		&r.Projection.RevocationDateMS, &upgraded, &r.Projection.Environment)
	r.Projection.IsUpgraded = upgraded != 0
	r.Supported = supported != 0
	return r, err
}

// ClaimAppleNotification records a delivery and reports whether this caller is
// the one that created the row.
//
// The insert is the claim. `fresh` is true only for the caller whose INSERT
// actually landed; every other caller — a redelivery hours later, or a second
// concurrent POST of the same UUID — gets fresh=false and the row as it stands.
//
// It NEVER overwrites an existing row. A redelivery must not be able to replace
// a recorded projection with a different one: the UUID is Apple's identity for
// one event, so a second body claiming the same UUID with different contents is
// either a bug or an attack, and the first verified copy is the one that counts.
// (Both copies are Apple-signed by the time they reach here, so this is about
// determinism rather than about trust.)
//
// The returned record is always the row now in force, so a caller can act on it
// without a second read.
func (s *SQLiteStore) ClaimAppleNotification(ctx context.Context, rec AppleNotificationRecord) (AppleNotificationRecord, bool, error) {
	if rec.UUID == "" {
		return AppleNotificationRecord{}, false, errors.New("account: apple notification needs a uuid")
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO apple_notifications (`+appleNotificationCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(notification_uuid) DO NOTHING`,
		rec.UUID, appleNotificationReceived, rec.Type, rec.ReceivedAt, rec.ReceivedAt, b2i(rec.Supported),
		rec.Projection.BundleID, rec.Projection.ProductID, rec.Projection.OriginalTransactionID,
		rec.Projection.AppAccountToken, rec.Projection.PurchaseDateMS, rec.Projection.ExpiresDateMS,
		rec.Projection.RevocationDateMS, b2i(rec.Projection.IsUpgraded), rec.Projection.Environment)
	if err != nil {
		return AppleNotificationRecord{}, false, err
	}
	if n, err := res.RowsAffected(); err == nil && n > 0 {
		rec.State = appleNotificationReceived
		rec.UpdatedAt = rec.ReceivedAt
		return rec, true, nil
	}
	existing, ok, err := s.GetAppleNotification(ctx, rec.UUID)
	if err != nil {
		return AppleNotificationRecord{}, false, err
	}
	if !ok {
		// The row was there for the INSERT and gone for the SELECT. Retention can
		// delete an old terminal row concurrently, so this is rare but possible;
		// report an error and let Apple retry. The retry then creates a fresh claim,
		// which is safer than treating an unreadable ledger as an empty one here.
		return AppleNotificationRecord{}, false, fmt.Errorf("account: apple notification %s vanished between claim and read", rec.UUID)
	}
	return existing, false, nil
}

// GetAppleNotification reads one ledger row.
func (s *SQLiteStore) GetAppleNotification(ctx context.Context, uuid string) (AppleNotificationRecord, bool, error) {
	if uuid == "" {
		return AppleNotificationRecord{}, false, nil
	}
	rec, err := scanAppleNotification(s.reader().QueryRowContext(ctx,
		`SELECT `+appleNotificationCols+` FROM apple_notifications WHERE notification_uuid = ?`, uuid))
	if err == sql.ErrNoRows {
		return AppleNotificationRecord{}, false, nil
	}
	if err != nil {
		return AppleNotificationRecord{}, false, err
	}
	return rec, true, nil
}

// SetAppleNotificationState moves a ledger row to its outcome.
//
// It deliberately refuses to move a row OUT of a terminal state. Nothing in the
// current code tries to, and that is exactly why the guard belongs here: an
// applied notification being reset to pending by some later path would make the
// same entitlement event eligible to be replayed against a newer one.
func (s *SQLiteStore) SetAppleNotificationState(ctx context.Context, uuid, state string, now int64) error {
	switch state {
	case appleNotificationApplied, appleNotificationIgnored, appleNotificationUnsupported,
		appleNotificationPending, appleNotificationConflict:
	default:
		return fmt.Errorf("account: %q is not an apple notification state", state)
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE apple_notifications SET state = ?, updated_at = ?
		  WHERE notification_uuid = ? AND state NOT IN (?, ?, ?)`,
		state, now, uuid,
		appleNotificationApplied, appleNotificationIgnored, appleNotificationUnsupported)
	return err
}

// PendingAppleNotificationsFor returns the deferred notifications for one
// original transaction id, in EVERY environment, oldest generation first.
//
// The environment is deliberately not a parameter. The partial index behind
// this query is cut on (original_transaction_id, purchase_date_ms), and
// CREATE INDEX IF NOT EXISTS will not re-cut an index that already exists under
// the same name — so adding the column to the WHERE clause would leave existing
// deployments on the old plan while new ones got the new one. The caller
// (reconcileApplePendingNotifications) partitions by environment instead, which
// is also where a row that records no environment can be reported rather than
// silently dropped.
//
// Ordered by the transaction's own purchaseDate rather than by arrival, so a
// drain applies generations in the order they happened. The event clock would
// make an out-of-order drain converge anyway — a later generation beats an
// earlier one whatever order they arrive in — but replaying them in order means
// the intermediate states an observer could see are real ones.
func (s *SQLiteStore) PendingAppleNotificationsFor(ctx context.Context, originalTransactionID string) ([]AppleNotificationRecord, error) {
	if originalTransactionID == "" {
		// Every row with no recorded id would match. There is no question this
		// could be answering.
		return nil, nil
	}
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+appleNotificationCols+` FROM apple_notifications
		  WHERE state = ? AND original_transaction_id = ?
		  ORDER BY purchase_date_ms, notification_uuid`,
		appleNotificationPending, originalTransactionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AppleNotificationRecord
	for rows.Next() {
		rec, err := scanAppleNotification(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// CountAppleNotificationsByState reports how many rows sit in each state.
//
// Operator visibility for the one population that needs it: a growing `pending`
// or any `conflict` at all is a real condition — a subscription Apple believes
// in that no Relayium account can be given — and it is invisible in the
// entitlement tables by construction, because nothing was granted.
func (s *SQLiteStore) CountAppleNotificationsByState(ctx context.Context) (map[string]int64, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT state, COUNT(*) FROM apple_notifications GROUP BY state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var state string
		var n int64
		if err := rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		out[state] = n
	}
	return out, rows.Err()
}

// PruneTerminalAppleNotifications deletes only outcomes whose work is finished.
// The strict cutoff keeps a row exactly at the retention boundary, matching the
// other age ledgers. No timer is allowed to erase an unfinished delivery.
func (s *SQLiteStore) PruneTerminalAppleNotifications(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM apple_notifications
		  WHERE updated_at < ? AND state IN (?, ?, ?)`,
		before, appleNotificationApplied, appleNotificationIgnored, appleNotificationUnsupported)
	return err
}
