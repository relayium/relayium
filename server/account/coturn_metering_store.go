package account

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// coturnPurgeBindingsSQL is ArchiveAndPurgeUser's statement for the F02
// bindings of the purged user: each becomes a replay-denial tombstone keeping
// only the provider key and the owning relay. Every user-linked or traffic
// field is cleared: user id, username hash, ledger alloc id, receipt
// (seq, hash, cumulative, accepted, state) and timestamps.
const coturnPurgeBindingsSQL = `UPDATE coturn_metering_bindings
   SET user_id = NULL, username_hash = NULL, alloc_id = NULL, ledger = 'shadow',
       last_seq = 0, last_hash = '', last_cumulative = 0, accepted = 0,
       terminal = 1, last_state = 'purged', created_at = 0, updated_at = 0, purged = 1
 WHERE user_id = ?`

// coturnAllocIDPrefix starts every ledger alloc id central generates for a
// coturn binding. The rest is 128 random bits drawn when the binding is
// created, so no node report can predict, squat on or collide with it.
const coturnAllocIDPrefix = "coturn/"

// CoturnSnapshotApply is one validated bridge snapshot, ready for
// ApplyCoturnSnapshot. The relay id comes from authentication, never from the
// body; UserID/Token come from the username, already checked against the
// attribution guard by the caller.
type CoturnSnapshotApply struct {
	RelayID      string
	Snapshot     wire.Snapshot
	UsernameHash string
	UserID       string
	Token        string
	// Now is central's receive time: the month the bytes land in.
	Now int64
	// Billable is whether central's ingest is in billable mode right now;
	// BillableSince is the configured activation time. See ApplyCoturnSnapshot.
	Billable      bool
	BillableSince int64
}

// CoturnSnapshotOutcome is what central acknowledges for one snapshot.
type CoturnSnapshotOutcome struct {
	Status   string // wire.Ack* status
	Accepted int64  // the ledger (or shadow) high water after this snapshot
	Ledger   string // wire.LedgerBillable / wire.LedgerShadow
	Clamp    string // wire.Clamp*
	Reason   string
}

// ApplyCoturnSnapshot records one coturn bridge snapshot in a single write
// transaction: the binding (created on first sight), the receipt checks, and —
// for a billable binding — the usage ledger write through recordUsageTx, the
// same keep-max/clamp/month path every other relay report uses.
//
// Binding. (boot, pid, start ticks, raw session id) identifies one coturn
// allocation globally; the raw session id alone does not (coturn restarts it
// from zero and every host shares the space). The relay identity that first
// reports it owns the binding: the same provider allocation reported by a
// second relay identity (a misconfigured or duplicated bridge) is a conflict,
// so it can never become a second ledger row. The key is the table's primary
// key, so this holds even across concurrent writers. The first username seen
// is bound immutably by hash; a snapshot under the same key with another
// username is a conflict, never merged.
//
// Receipt. The binding keeps its latest receipt (seq, hash, cumulative):
//   - seq > last: the cumulative must not be lower than the last one, and no
//     snapshot may follow a terminal one — except the one monotone upgrade
//     ended_unfinalized → final: the bridge inferred an end from psd before
//     coturn's own final total arrived (coturn removes a session from its
//     listing and publishes the final asynchronously, unordered), so the true
//     final may follow. Nothing may follow a final or an epoch end. The
//     ledger is written (keep-max: only the remainder is added).
//   - seq == last: the hash must be the same (a lost-ACK retry); the ledger is
//     written again, which adds nothing unless the per-report rate clamp held
//     bytes back last time and has since accrued budget.
//   - seq < last: a reordered older snapshot; its cumulative must not exceed
//     the last one. Nothing is written; the current accepted value is acked.
//
// Ledger. A billable binding's bytes go to usage_events/usage_periods under
// the binding's random alloc id, node_id NULL, billable=1, in the month of
// Now. Keep-max means a replay or a reordered report adds nothing, so a
// replay can neither rebill nor move bytes to another month. Shadow never
// touches either table.
//
// Shadow → billable. A binding is created billable only when the ingest is
// billable now, Now ≥ BillableSince, and the bridge first observed the
// allocation at or after BillableSince. FirstObservedUnix 1 is the bridge's
// reserved "start unknown" value (no "new" status, no psd start), so such an
// allocation is shadow whatever BillableSince is, even 1: an unknown start is
// never billable. Any snapshot received while the ingest is in shadow mode
// demotes its binding to shadow permanently, so bytes of a shadow period are
// never billed later; a binding that already existed when central started
// non-billable was demoted then, even if it receives nothing in that period
// (DemoteCoturnBillableBindings). An existing binding is never promoted.
func (s *SQLiteStore) ApplyCoturnSnapshot(ctx context.Context, in CoturnSnapshotApply) (CoturnSnapshotOutcome, error) {
	snap := in.Snapshot
	if snap.Cumulative > wire.MaxCumulative || snap.StartTicks > wire.MaxCumulative || snap.Seq > wire.MaxCumulative {
		return CoturnSnapshotOutcome{Status: wire.AckRejected, Reason: "out of range"}, nil
	}
	cum := int64(snap.Cumulative)
	seq := int64(snap.Seq)
	terminal := wire.Terminal(snap.State)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CoturnSnapshotOutcome{}, err
	}
	defer tx.Rollback()

	var (
		owner, ledger, lastHash, lastState string
		usernameHash, allocID              sql.NullString
		lastSeq, lastCum, accepted         int64
		wasTerminal, purged                bool
	)
	exists := true
	switch err := tx.QueryRowContext(ctx,
		`SELECT relay_id, username_hash, alloc_id, ledger, last_seq, last_hash, last_cumulative, accepted, terminal, last_state, purged
		   FROM coturn_metering_bindings
		  WHERE boot_id = ? AND pid = ? AND start_ticks = ? AND session_id = ?`,
		snap.BootID, snap.PID, int64(snap.StartTicks), snap.SessionID).
		Scan(&owner, &usernameHash, &allocID, &ledger, &lastSeq, &lastHash, &lastCum, &accepted, &wasTerminal, &lastState, &purged); err {
	case nil:
	case sql.ErrNoRows:
		exists = false
	default:
		return CoturnSnapshotOutcome{}, err
	}

	// The owner was hard-purged: the tombstone refuses every report for this
	// provider allocation, from any relay, in any mode, and nothing is written.
	if exists && purged {
		return CoturnSnapshotOutcome{Status: wire.AckGone, Reason: "the allocation's owner account was deleted"}, nil
	}
	// Authoritative owner check on every snapshot, shadow and billable: no
	// binding is created or advanced for an account that does not exist.
	var userExists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE id = ?`, in.UserID).Scan(&userExists); err != nil {
		return CoturnSnapshotOutcome{}, err
	}
	if userExists == 0 {
		return CoturnSnapshotOutcome{Status: wire.AckGone, Reason: "owner account does not exist"}, nil
	}

	if exists {
		if owner != in.RelayID {
			// Nothing about the other relay's binding is disclosed in the ACK.
			return CoturnSnapshotOutcome{Status: wire.AckConflict, Reason: "provider allocation already reported by another relay identity"}, nil
		}
		if usernameHash.String != in.UsernameHash {
			return CoturnSnapshotOutcome{Status: wire.AckConflict, Accepted: accepted, Ledger: ledger, Reason: "username differs from the binding"}, nil
		}
		switch {
		case seq < lastSeq:
			if cum > lastCum {
				return CoturnSnapshotOutcome{Status: wire.AckConflict, Accepted: accepted, Ledger: ledger, Reason: "older seq with a higher cumulative"}, nil
			}
			return CoturnSnapshotOutcome{Status: wire.AckStale, Accepted: accepted, Ledger: ledger}, nil
		case seq == lastSeq:
			if snap.Hash != lastHash {
				return CoturnSnapshotOutcome{Status: wire.AckConflict, Accepted: accepted, Ledger: ledger, Reason: "same seq with a different hash"}, nil
			}
		default: // seq > lastSeq
			if wasTerminal && !(lastState == wire.StateEndedUnfinalized && snap.State == wire.StateFinal) {
				return CoturnSnapshotOutcome{Status: wire.AckConflict, Accepted: accepted, Ledger: ledger, Reason: "snapshot after a terminal snapshot"}, nil
			}
			if cum < lastCum {
				return CoturnSnapshotOutcome{Status: wire.AckConflict, Accepted: accepted, Ledger: ledger, Reason: "newer seq with a lower cumulative"}, nil
			}
		}
	} else {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return CoturnSnapshotOutcome{}, fmt.Errorf("coturn binding id: %w", err)
		}
		allocID = sql.NullString{String: coturnAllocIDPrefix + hex.EncodeToString(b), Valid: true}
		ledger = wire.LedgerShadow
		if in.Billable && in.BillableSince > 0 && in.Now >= in.BillableSince && snap.FirstObservedUnix > 1 && snap.FirstObservedUnix >= in.BillableSince {
			ledger = wire.LedgerBillable
		}
	}

	// A snapshot received in shadow mode demotes the binding for good: its
	// later cumulative includes shadow-period bytes, which must never be billed.
	if !in.Billable {
		ledger = wire.LedgerShadow
	}

	out := CoturnSnapshotOutcome{Status: wire.AckAccepted, Ledger: ledger}
	if ledger == wire.LedgerBillable {
		_, newCum, err := recordUsageTx(ctx, tx, UsageEvent{
			AllocID: allocID.String, Token: in.Token, UserID: in.UserID, RelayedBytes: cum,
			RecordedAt: in.Now, Billable: true,
		}, nil)
		if errors.Is(err, ErrUsageAllocOwnerMismatch) {
			return CoturnSnapshotOutcome{Status: wire.AckConflict, Accepted: accepted, Ledger: ledger, Reason: "ledger row owned by another user"}, nil
		}
		if err != nil {
			return CoturnSnapshotOutcome{}, err
		}
		out.Accepted = newCum
		if newCum < cum {
			out.Clamp = wire.ClampRate
			if newCum >= maxAllocRelayBytes {
				out.Clamp = wire.ClampCeiling
			}
		}
	} else {
		out.Accepted = max(accepted, cum)
	}

	if exists {
		newSeq, newHash, newCum, newTerminal, newState := lastSeq, lastHash, lastCum, wasTerminal, lastState
		if seq > lastSeq {
			newSeq, newHash, newCum, newTerminal, newState = seq, snap.Hash, cum, terminal, snap.State
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE coturn_metering_bindings
			    SET ledger = ?, updated_at = ?, last_seq = ?, last_hash = ?, last_cumulative = ?, accepted = ?, terminal = ?, last_state = ?
			  WHERE boot_id = ? AND pid = ? AND start_ticks = ? AND session_id = ? AND relay_id = ?`,
			ledger, in.Now, newSeq, newHash, newCum, out.Accepted, b2i(newTerminal), newState,
			snap.BootID, snap.PID, int64(snap.StartTicks), snap.SessionID, in.RelayID); err != nil {
			return CoturnSnapshotOutcome{}, err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO coturn_metering_bindings
			   (relay_id, boot_id, pid, start_ticks, session_id, user_id, username_hash, alloc_id, ledger,
			    created_at, updated_at, last_seq, last_hash, last_cumulative, accepted, terminal, last_state)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			in.RelayID, snap.BootID, snap.PID, int64(snap.StartTicks), snap.SessionID, in.UserID, in.UsernameHash, allocID, ledger,
			in.Now, in.Now, seq, snap.Hash, cum, out.Accepted, b2i(terminal), snap.State); err != nil {
			return CoturnSnapshotOutcome{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return CoturnSnapshotOutcome{}, err
	}
	return out, nil
}

// DemoteCoturnBillableBindings demotes every billable coturn binding to shadow
// for good and returns how many it demoted. Central calls it at a startup in
// which the ingest is not billable (shadow mode, or the ingest disabled),
// before the handler exists: a billable binding that receives no snapshot
// during that period would otherwise bill the bytes relayed in it once
// billable mode returns, since its next cumulative includes them. It covers
// every billable binding, whatever relay owns it (also one no longer
// configured) and whatever its state (an ended_unfinalized binding can still
// grow to its final; a final one cannot, so demoting it forgoes at most a
// rate-clamp catch-up).
//
// It changes only the ledger column: no receipt, counter, owner, alloc id or
// timestamp, and no usage_events/usage_periods row, so nothing already billed
// is refunded, reset or billed again. It runs in an explicit transaction that
// is committed only after the update and its row count succeed: any error
// rolls every row back (a lone autocommit UPDATE is not enough — a row error
// raised with FAIL semantics keeps the rows already changed by the statement).
// Running it again demotes nothing; no path re-promotes a shadow binding.
//
// It protects bindings that exist when it runs. An allocation central has
// never seen is decided when its first snapshot arrives, by the creation rule
// above: a later billable startup needs a fresh BillableSince, after the
// non-billable period, for that allocation to stay unbilled.
func (s *SQLiteStore) DemoteCoturnBillableBindings(ctx context.Context) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE coturn_metering_bindings SET ledger = 'shadow' WHERE ledger = 'billable'`)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

// CoturnBinding is one coturn_metering_bindings row, for tests and evidence.
type CoturnBinding struct {
	RelayID, BootID, SessionID string
	UserID, UsernameHash       string // "" once purged
	PID                        int
	StartTicks                 int64
	AllocID, Ledger            string // AllocID "" once purged
	LastSeq, LastCumulative    int64
	Accepted                   int64
	Terminal                   bool
	LastState                  string
	CreatedAt, UpdatedAt       int64
	Purged                     bool
}

// CoturnBindings lists every coturn binding (evidence/reconciliation reads).
func (s *SQLiteStore) CoturnBindings(ctx context.Context) ([]CoturnBinding, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT relay_id, boot_id, pid, start_ticks, session_id, COALESCE(user_id, ''), COALESCE(username_hash, ''), COALESCE(alloc_id, ''),
		        ledger, last_seq, last_cumulative, accepted, terminal, last_state, created_at, updated_at, purged
		   FROM coturn_metering_bindings ORDER BY created_at, relay_id, boot_id, pid, start_ticks, session_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CoturnBinding
	for rows.Next() {
		var b CoturnBinding
		if err := rows.Scan(&b.RelayID, &b.BootID, &b.PID, &b.StartTicks, &b.SessionID, &b.UserID, &b.UsernameHash, &b.AllocID,
			&b.Ledger, &b.LastSeq, &b.LastCumulative, &b.Accepted, &b.Terminal, &b.LastState, &b.CreatedAt, &b.UpdatedAt, &b.Purged); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
