package account

import (
	"context"
	"log"
	"time"
)

// unbilledMeterBatch bounds one GC pass over the owed-bills outbox. The table is
// normally empty, and when it is not the rows are not going anywhere, so a batch
// keeps a backlog from holding the single writer for one long pass.
const unbilledMeterBatch = 256

// meterJournalBudget bounds the journal-fallback write. Its OWN budget, on its
// OWN detached context (see settleBlobBillingDurably): the direct settle may
// have failed precisely because the caller's context was cancelled or spent,
// and retrying the fallback on that same dead context would make the fallback a
// ritual rather than a second chance.
const meterJournalBudget = 5 * time.Second

// settleBlobBillingDurably makes the billing for a blob's observed size DURABLE
// before the caller is allowed to destroy the blob, and reports whether it
// managed to.
//
// WHY IT EXISTS. Almost every bill in this package is written in the same
// transaction as the state change it belongs to — an append's offset
// (CommitUploadProgress), a finalize's claim (ClaimUploadDone), a room's close
// (ClosePairRoom) — so the bill and the fact it describes cannot come apart.
// Two paths cannot do that, and they are the two most dangerous ones:
//
//   - settleReclaimedUpload bills what a partial blob turned out to hold, which
//     it learned by asking the node, and then deletes the blob;
//   - settleAppendIntoAVoidedRoom bills what its own append committed into a
//     room that was voided underneath it, and then deletes the blob.
//
// In both, the session row is already gone (the void deleted it, in the same
// transaction that billed everything then known and queued the delete intent
// that carries the OBLIGATION — see PendingNodeDelete.BillUserID), so the blob
// is the number's last evidence. Three rungs, each durable, each atomic:
//
//  1. SettleBlobBilling — meter increment + floor advance, one transaction.
//  2. JournalBlobBilling — owed-bills outbox row + floor advance, one
//     transaction, on a fresh DETACHED, BOUNDED context: the direct settle may
//     have died with the caller's context, and the outbox INSERT is far more
//     likely to survive whatever refused the meter (no aggregates, no rolling
//     window, no contention). GC drains it later (settleOwedBills).
//  3. Nothing could be written. The caller MUST NOT delete the blob: the bytes
//     are the bill now, the intent row queued at close is their durable owner,
//     and GC's drain settles the obligation — re-probing the blob for the
//     number — before it deletes anything (see GC.drainPending). false says so.
//
// The floor (billed_through) advancing in the same transaction as either write
// is what makes every path idempotent against every other: a crash after rung 1
// or 2 cannot double-charge, and GC re-learning the size from the blob bills
// only what no rung ever recorded.
//
// `through` is the blob's observed size clamped by the caller to the session's
// write budget; `now` is the CALLER's clock — these paths settle an event that
// already happened, and the meter is bucketed by month, so re-deriving the
// clock here could put the bill in the wrong period.
func (s *Service) settleBlobBillingDurably(ctx context.Context, blobKey, nodeID string, through, now int64, reason string) bool {
	billed, err := s.store.SettleBlobBilling(ctx, blobKey, nodeID, through, now)
	if err == nil {
		if billed > 0 {
			log.Printf("billed %d committed bytes no append recorded (%s)", billed, reason)
		}
		return true
	}
	log.Printf("billing blob %s through %d bytes (%s): %v; writing the residual down to be settled later",
		blobKey, through, reason, err)
	jctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), meterJournalBudget)
	defer cancel()
	owed, jerr := s.store.JournalBlobBilling(jctx, blobKey, nodeID, through, now, reason)
	if jerr != nil {
		// Both the meter and the note about the meter failed: nothing durable is
		// reachable from here, so the BLOB stays as the bill's evidence — the
		// caller keeps it, and GC settles the intent row's obligation before any
		// delete. Loud, with the number, because a growing count of these means
		// the database is refusing writes wholesale.
		log.Printf("UNSETTLED BILL: blob %s (%s) could be neither metered nor journaled: %v; keeping the blob until the obligation is durable",
			blobKey, reason, jerr)
		return false
	}
	if owed > 0 {
		log.Printf("journaled %d owed bytes for blob %s (%s); GC settles it", owed, blobKey, reason)
	}
	return true
}

// settleOwedBills is GC's retry of the bills billKnownBytes could not write.
// Normally settles nothing, because the table is normally empty.
func (g *GC) settleOwedBills(ctx context.Context) {
	settled, err := g.Store.SettleUnbilledMeter(ctx, unbilledMeterBatch)
	if settled > 0 {
		g.Log.Printf("gc: settled %d bill(s) that could not be metered when they were owed", settled)
	}
	if err != nil {
		g.Log.Printf("gc: settle owed bills: %v", err)
	}
}
