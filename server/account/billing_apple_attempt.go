package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"log"

	"github.com/relayium/relayium/authx"
)

// The Apple purchase-attempt state machine.
//
// WHY THIS FILE EXISTS. Purchase dispatch permanently created a `dispatched`
// attempt BEFORE StoreKit ran. A genuine `.userCancelled` creates no
// transaction at all, so nothing ever arrived to resolve that attempt: the
// account could never buy again, having been charged nothing. Apple signs
// transactions; Apple does not sign the absence of one. There is therefore no
// provider artifact that proves a cancellation and none that establishes a
// complete pending horizon, so nothing here is released by a clock — only by
// evidence.
//
// WHAT AUTHORIZES A SECOND SHEET. While a sheet is armed or its outcome is
// ambiguous, only an exact replay may read the existing authority back; neither
// the account session nor the `appAccountToken` can open another sheet. After
// the exact current arm has reported `.userCancelled`, however, there is no
// StoreKit transaction and no sheet left that can charge. At that boundary the
// authenticated account may bind a fresh, pre-persisted continuation capability
// from another app instance. The cancelled->armed CAS replaces the old binding
// and the arm together, so the old instance becomes inert before the new sheet
// is authorized. The appAccountToken remains attribution only and is never
// sufficient on its own.
//
// WHICH SHEET A REPORT IS ABOUT. The capability identifies a client, and every
// part of it survives a resume unchanged. That is not enough on its own: a
// duplicate or delayed `.userCancelled` from an earlier arm would authenticate
// perfectly, and accepting it after a resume would drag a live armed attempt
// back to cancelled and buy a second sheet while the first could still charge.
// Each arm therefore also carries a client-chosen ARM IDENTITY, set by the
// initial arm and atomically replaced by each accepted resume; an outcome must
// present the current one. Every id an attempt has ever spent is also recorded
// durably, and an id may be armed exactly once, ever: comparing only against the
// arm that is open now would let an id from two or more arms ago be resurrected,
// which makes that old arm's delayed report match the current sheet again and
// re-opens the double-sheet path across a wider history. This is deliberately
// not a TTL: nothing here is released by a clock, only by a report that provably
// belongs to the open sheet.
//
// See docs/superpowers/specs/2026-08-22-apple-purchase-cancel-recovery-design.md.

// The continuation lifecycle, stored in billing_purchase_attempts.continuation_state.
//
// Deliberately NOT new values of billing_purchase_attempts.state: that column
// carries a CHECK constraint SQLite cannot alter, and extending it would force a
// full rebuild of the one table that gates money while having to preserve the
// partial unique index that enforces one unresolved attempt per generation. An
// attempt therefore stays `dispatched` for its whole unresolved life, and ” is
// exactly the legacy one-shot client — the safe default rather than something
// the new code has to remember to apply.
const (
	appleContinuationLegacy    = ""
	appleContinuationArmed     = "armed"
	appleContinuationCancelled = "cancelled"
	appleContinuationLocked    = "locked"
)

// The StoreKit outcomes a capability holder may report. Only an explicit
// cancellation is resumable; everything else — including no report at all —
// stays locked, because none of them proves Apple will not charge.
const (
	appleOutcomeUserCancelled = "userCancelled"
	appleOutcomePending       = "pending"
	appleOutcomeFailed        = "failed"
	appleOutcomeSuccess       = "success"
)

func validAppleOutcome(v string) bool {
	switch v {
	case appleOutcomeUserCancelled, appleOutcomePending, appleOutcomeFailed, appleOutcomeSuccess:
		return true
	}
	return false
}

// The refusal vocabulary. Every capability failure answers the SAME code so the
// endpoint is not an oracle for which particular fact was wrong.
const (
	// The unresolved attempt is ambiguous: it may still become a real charge, so
	// it must be reconciled through restore rather than re-armed.
	appleRefusalReconcile = "purchase_reconciliation_required"
	// The capability is valid but no StoreKit outcome has been reported yet.
	// Deliberately NOT worded as an active subscription: nothing has been charged.
	appleRefusalOutcome = "purchase_outcome_required"
	// Every capability failure, without distinguishing which fact was wrong.
	appleRefusalCapabilityCode = "continuation_invalid"
	// Only clients that adopt every authoritative dispatch attempt id may enter
	// paths where a stale local capability can receive a replacement attempt.
	appleContinuationProtocolAttemptIDV2 = "attempt-id-v2"
)

// appleContinuationSecretBytes is the raw entropy behind one capability.
const appleContinuationSecretBytes = 32

// appleContinuationIDMaxLen bounds the two client-authored identifiers. They are
// opaque to the server and are stored verbatim, so they are bounded rather than
// parsed.
const appleContinuationIDMaxLen = 128

// newAppleContinuationSecret mints the one-time capability secret.
//
// The raw value is returned to exactly one caller, once, and is never stored,
// echoed or logged. What is kept at rest is appleContinuationVerifier(secret).
func newAppleContinuationSecret() (string, error) {
	var b [appleContinuationSecretBytes]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func appleContinuationVerifier(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func validAppleContinuationSecret(secret string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(secret)
	return err == nil && len(decoded) == appleContinuationSecretBytes &&
		base64.RawURLEncoding.EncodeToString(decoded) == secret
}

// validAppleContinuationID accepts a bounded, printable, opaque client
// identifier. It imposes no format: the server never interprets these, and a
// format rule that is wrong would refuse a legitimate client.
func validAppleContinuationID(v string) bool {
	if v == "" || len(v) > appleContinuationIDMaxLen {
		return false
	}
	for _, r := range v {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

// AppleDispatchRequest is one client's ask for permission to open a StoreKit
// sheet. An empty AppInstanceID is a LEGACY request: it binds no capability and
// its retry stays a strict one-shot refusal, byte-for-byte the old behavior.
type AppleDispatchRequest struct {
	ProductID            string
	ContinuationProtocol string
	// CandidateToken is used only when a NEW attempt is created. A resume
	// deliberately reuses the attempt's existing attribution token and mints
	// nothing.
	CandidateToken string
	AppInstanceID  string
	// ArmRequestID names the logical arm this request is asking for. It is
	// client-generated and REQUIRED on every new-protocol dispatch -- the initial
	// arm as much as a resume -- because it is the identity a later StoreKit
	// outcome must present to prove it belongs to the sheet that is open now. It
	// doubles as the idempotency key for a LOST RESUME RESPONSE: repeating the
	// same id, with the same product, reads that response back without a second
	// logical arm.
	//
	// Current clients generate and persist the capability secret before the first
	// request, making the initial arm replayable too. Older clients omit it and
	// receive a server-minted secret in the response, preserving compatibility.
	ArmRequestID string
	// ContinuationSecret is presented on every current-protocol request. It may be
	// empty only for a compatible older client's initial arm.
	ContinuationSecret string
	Now                int64
}

// AppleDispatchOutcome is what the store decided. Exactly one of Armed,
// Resumed, Replayed or Refusal is meaningful.
type AppleDispatchOutcome struct {
	Attempt BillingPurchaseAttempt
	// Armed means a fresh attempt was created. Secret is non-empty only here,
	// and only for a new-protocol request.
	Armed bool
	// Resumed means an existing cancelled attempt was re-armed in place: same
	// attempt id, same attribution token, no new row.
	Resumed bool
	// Replayed means this exact ArmRequestID is already the attempt's current arm
	// FOR THE SAME PRODUCT, and the caller is reading that response back. Current
	// clients hold the secret before the initial request, so both initial and
	// resume responses are recoverable this way.
	Replayed bool
	// Refusal is one of the appleRefusal* codes, or "" on success.
	Refusal string
	Secret  string
}

// appleAttemptRow is the durable attempt plus its continuation binding.
type appleAttemptRow struct {
	BillingPurchaseAttempt
	ContinuationState    string
	ContinuationVerifier []byte
	AppInstanceID        string
	ClientOutcome        string
	// ArmRequestID is the identity of the arm that is currently open.
	ArmRequestID string
}

const appleAttemptCols = `id,user_id,provider,external_scope,product_id,state,provider_ref,provider_session_id,provider_subscription_id,apple_account_token,epoch,created_at,continuation_state,continuation_verifier,app_instance_id,client_outcome,arm_request_id`

func scanAppleAttempt(sc rowScanner) (appleAttemptRow, error) {
	var out appleAttemptRow
	err := sc.Scan(&out.ID, &out.UserID, &out.Provider, &out.ExternalScope, &out.ProductID,
		&out.State, &out.ProviderURL, &out.ProviderSessionID, &out.ProviderSubscriptionID,
		&out.AppleAccountToken, &out.Epoch, &out.CreatedAt,
		&out.ContinuationState, &out.ContinuationVerifier, &out.AppInstanceID,
		&out.ClientOutcome, &out.ArmRequestID)
	return out, err
}

// capabilityMatches proves the presented capability is the one bound to this
// attempt.
//
// Both halves are evaluated before either is branched on, and the secret is
// compared as a SHA-256 digest under crypto/subtle. The row is located by
// attempt id and user id and never by the verifier, so the lookup itself is not
// an oracle either.
func (a appleAttemptRow) capabilityMatches(instanceID, secret string) bool {
	instanceOK := a.AppInstanceID != "" &&
		subtle.ConstantTimeCompare([]byte(a.AppInstanceID), []byte(instanceID)) == 1
	secretOK := len(a.ContinuationVerifier) == sha256.Size && secret != "" &&
		subtle.ConstantTimeCompare(appleContinuationVerifier(secret), a.ContinuationVerifier) == 1
	return instanceOK && secretOK
}

// armMatches proves the caller is talking about the arm that is CURRENTLY open.
//
// capabilityMatches answers "is this the right client?"; this answers "is this
// the right sheet?". They are genuinely different questions, and conflating them
// is the defect this exists to close: (attempt, instance, secret) are stable
// across every resume, so on their own they cannot tell a live report from a
// duplicate of one issued two arms ago. A stale report that survived that gap
// could move an armed attempt back to cancelled and buy a second sheet while the
// first was still able to charge.
//
// It compares against the CURRENT arm only, which is correct for this question
// but is not on its own a guarantee that a previous arm's id stays stale: that
// holds only because an id can never be re-armed once spent. reserveAppleArmIDTx
// is what makes "a previous arm" a permanent statement rather than a temporary
// one, and neither guard is sufficient alone.
//
// An empty stored id is a legacy attempt and matches nothing.
func (a appleAttemptRow) armMatches(armRequestID string) bool {
	return a.ArmRequestID != "" && armRequestID != "" &&
		subtle.ConstantTimeCompare([]byte(a.ArmRequestID), []byte(armRequestID)) == 1
}

// reserveAppleArmIDTx spends one arm identity for one attempt, permanently.
//
// WHY A GLOBAL HISTORY AND NOT A COMPARISON. armMatches and the resume CAS both
// look only at arm_request_id, the arm that is open NOW. That refuses a replay
// of the CURRENT id and nothing else: an id from two or more arms ago compares
// unequal and was, before this, accepted again. The money-loss schedule is
// concrete -- arm A=X, cancel; resume B=Y, cancel; resume C reuses X and opens a
// real sheet; a delayed duplicate .userCancelled from arm A still names X, now
// matches the CURRENT arm, and drags live sheet C back to cancelled; resume D=Z
// is then authorized while sheet C can still charge. Two sheets, one of which
// the server has stopped tracking. That the same genuine capability holder
// causes it is not mitigation: these ids are client-generated, so the server may
// not assume one is never reused, by accident or on purpose.
//
// WHY THE INSERT IS THE CHECK. The reservation is an INSERT against a PRIMARY
// KEY, so asking "was this id ever spent?" and claiming it are one atomic act,
// in the caller's transaction, alongside the cancelled->armed replacement. A
// SELECT-then-INSERT would leave a window two concurrent resumes could both
// pass. OR IGNORE plus RowsAffected reads the answer from the statement itself
// rather than from a driver error string, so the fail-closed path does not
// depend on matching SQLite's constraint-violation text.
//
// Returns true only when the id was previously unspent for this attempt. A
// false is NOT an error: it is the uniform capability refusal, decided by the
// caller.
func reserveAppleArmIDTx(ctx context.Context, tx *sql.Tx, attemptID, userID, armRequestID string, now int64) (bool, error) {
	res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO apple_purchase_arm_ids
 (attempt_id,user_id,arm_request_id,armed_at) VALUES(?,?,?,?)`,
		attemptID, userID, armRequestID, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// DispatchAppleBillingPurchase is the legacy, capability-free entry point. It is
// preserved exactly: no app instance, no secret, so a retry is still a strict
// one-shot refusal.
func (s *SQLiteStore) DispatchAppleBillingPurchase(ctx context.Context, authority BillingAuthority, productID, candidateToken string, now int64) (BillingPurchaseAttempt, bool, error) {
	out, err := s.ArmAppleBillingPurchase(ctx, authority, AppleDispatchRequest{
		ProductID: productID, CandidateToken: candidateToken, Now: now,
	})
	if err != nil {
		return BillingPurchaseAttempt{}, false, err
	}
	return out.Attempt, out.Armed, nil
}

// ArmAppleBillingPurchase is the ONE place a StoreKit sheet is authorized.
//
// It creates at most one unresolved attempt per authority generation. An
// existing attempt can be re-armed only after its exact current arm explicitly
// reported `.userCancelled`: either by the capability that reported it, or by
// atomically replacing that now-zero-charge binding with a fresh capability
// already persisted by another authenticated app instance. Every other shape —
// legacy retry, capability mismatch while armed or locked, cross-app, stale
// generation, ambiguous outcome, silence, or an arm id that has already been
// spent — fails closed.
func (s *SQLiteStore) ArmAppleBillingPurchase(ctx context.Context, authority BillingAuthority, in AppleDispatchRequest) (AppleDispatchOutcome, error) {
	if authority.Provider != ProviderApple || !validAppAccountToken(in.CandidateToken) {
		return AppleDispatchOutcome{}, ErrBillingAuthorityConflict
	}
	newProtocol := in.AppInstanceID != ""
	supportsAttemptIDAdoption := in.ContinuationProtocol == appleContinuationProtocolAttemptIDV2
	if newProtocol {
		// The arm id is required on the INITIAL arm too, not only on a resume:
		// every arm must be nameable, or the first sheet's outcome would have no
		// identity to be bound to and the very first cancellation report could
		// still be replayed across a later resume.
		if (in.ContinuationProtocol != "" && !supportsAttemptIDAdoption) ||
			!validAppleContinuationID(in.AppInstanceID) || !validAppleContinuationID(in.ArmRequestID) ||
			(in.ContinuationSecret != "" && !validAppleContinuationSecret(in.ContinuationSecret)) {
			return AppleDispatchOutcome{}, ErrBillingAuthorityConflict
		}
	} else if in.ContinuationProtocol != "" || in.ArmRequestID != "" || in.ContinuationSecret != "" {
		// A legacy request carries neither. Presenting one without an instance is
		// malformed, and must not be quietly downgraded to a one-shot dispatch.
		return AppleDispatchOutcome{}, ErrBillingAuthorityConflict
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AppleDispatchOutcome{}, err
	}
	defer tx.Rollback()
	if frozen, err := billingUserFrozenTx(ctx, tx, authority.UserID, in.Now); err != nil || frozen {
		if err != nil {
			return AppleDispatchOutcome{}, err
		}
		return AppleDispatchOutcome{}, ErrBillingAuthorityConflict
	}
	var current BillingAuthority
	if err := tx.QueryRowContext(ctx, `SELECT user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at FROM billing_authorities WHERE user_id=?`, authority.UserID).
		Scan(&current.UserID, &current.Provider, &current.ExternalScope, &current.AppleEnvironment, &current.AppleAccountToken, &current.Epoch, &current.IntentID, &current.CreatedAt, &current.UpdatedAt); err != nil {
		return AppleDispatchOutcome{}, err
	}
	if current != authority {
		return AppleDispatchOutcome{}, ErrBillingAuthorityConflict
	}

	existing, err := scanAppleAttempt(tx.QueryRowContext(ctx, `SELECT `+appleAttemptCols+
		` FROM billing_purchase_attempts WHERE user_id=? AND epoch=? AND state IN ('prepared','dispatched')`,
		authority.UserID, authority.Epoch))
	switch {
	case err == nil:
		out, err := resumeAppleAttemptTx(ctx, tx, authority, existing, in, newProtocol)
		if err != nil {
			return AppleDispatchOutcome{}, err
		}
		if out.Refusal != "" {
			// Discarded without committing. This is no longer a strictly read-only
			// transaction -- the resume path may have written an arm-id backfill
			// and a reservation before deciding to refuse -- so the rollback is
			// load-bearing rather than incidental: it is what stops a refused
			// resume from burning the id it presented.
			return out, nil
		}
		return out, tx.Commit()
	case !errors.Is(err, sql.ErrNoRows):
		return AppleDispatchOutcome{}, err
	}
	// A pre-v2 continuation client does not adopt a replacement attempt id. If
	// its local capability is stale, creating a fresh row would let it open a
	// sheet and then report against the resolved old id, parking this new row at
	// `armed` account-wide. Refuse before creating any identity. Exact replay and
	// same-capability resume of an existing attempt remain compatible above.
	if newProtocol && !supportsAttemptIDAdoption {
		return AppleDispatchOutcome{Refusal: appleRefusalCapabilityCode}, nil
	}

	// A fresh attempt for this generation.
	out := AppleDispatchOutcome{Armed: true, Attempt: BillingPurchaseAttempt{
		ID: authx.NewID(), UserID: authority.UserID, Provider: ProviderApple,
		ExternalScope: authority.ExternalScope, ProductID: in.ProductID, State: "dispatched",
		AppleAccountToken: in.CandidateToken, Epoch: authority.Epoch, CreatedAt: in.Now,
	}}
	continuationState := appleContinuationLegacy
	// Non-nil: the column is NOT NULL, and a nil []byte binds as SQL NULL rather
	// than as the empty blob a legacy attempt must carry.
	verifier := []byte{}
	if newProtocol {
		secret := in.ContinuationSecret
		if secret == "" {
			var err error
			secret, err = newAppleContinuationSecret()
			if err != nil {
				return AppleDispatchOutcome{}, err
			}
			// Compatibility only: current clients already hold their secret and
			// the response never needs to carry it.
			out.Secret = secret
		}
		verifier = appleContinuationVerifier(secret)
		continuationState = appleContinuationArmed
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO billing_purchase_attempts
 (id,user_id,provider,external_scope,product_id,state,provider_ref,apple_account_token,epoch,created_at,
  continuation_state,continuation_verifier,app_instance_id,arm_request_id)
 VALUES(?,?,?,?,?,'dispatched','',?,?,?,?,?,?,?)`,
		out.Attempt.ID, out.Attempt.UserID, out.Attempt.Provider, out.Attempt.ExternalScope,
		out.Attempt.ProductID, out.Attempt.AppleAccountToken, out.Attempt.Epoch, out.Attempt.CreatedAt,
		continuationState, verifier, in.AppInstanceID, in.ArmRequestID); err != nil {
		return AppleDispatchOutcome{}, err
	}
	if newProtocol {
		// The INITIAL arm spends an id as much as a resume does. Recording only
		// resumes would leave the first id -- the one the original sheet's report
		// carries -- absent from the history and therefore resurrectable by a
		// later resume, which is precisely the arm-A schedule this closes.
		fresh, err := reserveAppleArmIDTx(ctx, tx, out.Attempt.ID, out.Attempt.UserID, in.ArmRequestID, in.Now)
		if err != nil {
			return AppleDispatchOutcome{}, err
		}
		if !fresh {
			// Unreachable: the attempt id was just minted by authx.NewID, so it
			// can own no history yet. Treated as fatal rather than ignored,
			// because reaching it would mean the reservation is not proving what
			// the rest of this file relies on it to prove.
			return AppleDispatchOutcome{}, ErrBillingAuthorityConflict
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO apple_billing_subjects(app_account_token,user_id,attempt_id,bundle_id,authority_epoch,created_at) VALUES(?,?,?,?,?,?)`,
		in.CandidateToken, out.Attempt.UserID, out.Attempt.ID, out.Attempt.ExternalScope, out.Attempt.Epoch, in.Now); err != nil {
		return AppleDispatchOutcome{}, err
	}
	return out, tx.Commit()
}

// ReplayAppleBillingPurchase returns only an exact read-back of an already
// armed request. It creates and mutates nothing. The HTTP handler calls this
// before catalog and manage-with-Apple gates so a client that lost the initial
// 200 can always recover that 200 even if eligibility changed meanwhile.
func (s *SQLiteStore) ReplayAppleBillingPurchase(ctx context.Context, authority BillingAuthority, in AppleDispatchRequest) (AppleDispatchOutcome, bool, error) {
	if authority.Provider != ProviderApple || in.AppInstanceID == "" ||
		(in.ContinuationProtocol != "" && in.ContinuationProtocol != appleContinuationProtocolAttemptIDV2) ||
		!validAppleContinuationID(in.AppInstanceID) ||
		!validAppleContinuationID(in.ArmRequestID) ||
		!validAppleContinuationSecret(in.ContinuationSecret) {
		return AppleDispatchOutcome{}, false, nil
	}
	current, exists, err := s.BillingAuthority(ctx, authority.UserID)
	if err != nil || !exists || current != authority {
		return AppleDispatchOutcome{}, false, err
	}
	row, err := scanAppleAttempt(s.reader().QueryRowContext(ctx, `SELECT `+appleAttemptCols+
		` FROM billing_purchase_attempts WHERE user_id=? AND epoch=? AND state='dispatched'`,
		authority.UserID, authority.Epoch))
	if errors.Is(err, sql.ErrNoRows) {
		return AppleDispatchOutcome{}, false, nil
	}
	if err != nil {
		return AppleDispatchOutcome{}, false, err
	}
	if row.ExternalScope != authority.ExternalScope ||
		row.ContinuationState != appleContinuationArmed ||
		row.ProductID != in.ProductID || !row.armMatches(in.ArmRequestID) ||
		!row.capabilityMatches(in.AppInstanceID, in.ContinuationSecret) {
		return AppleDispatchOutcome{}, false, nil
	}
	return AppleDispatchOutcome{Attempt: row.BillingPurchaseAttempt, Replayed: true}, true, nil
}

// resumeAppleAttemptTx decides what an EXISTING unresolved attempt may give this
// caller. It never creates a row and never mints an attribution token.
func resumeAppleAttemptTx(ctx context.Context, tx *sql.Tx, authority BillingAuthority, existing appleAttemptRow, in AppleDispatchRequest, newProtocol bool) (AppleDispatchOutcome, error) {
	out := AppleDispatchOutcome{Attempt: existing.BillingPurchaseAttempt}
	// A legacy request, or an attempt armed before this protocol existed, has no
	// capability to present or to check. Strict one-shot, unchanged.
	if !newProtocol || existing.ContinuationState == appleContinuationLegacy {
		out.Refusal = appleRefusalReconcile
		return out, nil
	}
	// Cross-app and stale-generation remain absolute refusals. A capability
	// mismatch is also absolute while a sheet is armed or locked; only the
	// explicitly-cancelled branch below may replace it.
	if existing.ExternalScope != authority.ExternalScope {
		out.Refusal = appleRefusalCapabilityCode
		return out, nil
	}
	capabilityMatches := existing.capabilityMatches(in.AppInstanceID, in.ContinuationSecret)
	switch existing.ContinuationState {
	case appleContinuationArmed:
		if !capabilityMatches {
			out.Refusal = appleRefusalCapabilityCode
			return out, nil
		}
		// Already authorized. The ONLY thing this may be is the same client
		// reading back the response for the id that armed it -- for the SAME
		// product. A different id here would be a second concurrent sheet, and a
		// different product under the CURRENT id is not a replay at all: it asks
		// to repoint a sheet that is already open, which this must never do.
		//
		// Both refusals are the SAME code, deliberately. `armed` answers
		// purchase_outcome_required for every non-replayable shape, and that
		// uniformity is load-bearing in two ways. It is truthful -- a sheet IS
		// open and the honest next step really is to report what StoreKit did,
		// after which a fresh id may re-arm on any eligible product. And it keeps
		// the endpoint from becoming an oracle: answering the capability code
		// here would let a caller learn whether an id it holds is the CURRENT arm
		// by deliberately naming a wrong product, which is exactly the leak the
		// non-current-id answer was already chosen to avoid. Answering
		// continuation_invalid would also tell an honest client its capability is
		// bad, and a client that discards it can never resume -- re-creating the
		// permanent deadlock this whole file exists to remove.
		if existing.armMatches(in.ArmRequestID) && existing.ProductID == in.ProductID {
			out.Replayed = true
			return out, nil
		}
		out.Refusal = appleRefusalOutcome
		return out, nil
	case appleContinuationLocked:
		if !capabilityMatches {
			out.Refusal = appleRefusalCapabilityCode
			return out, nil
		}
		// pending / error / unknown. The purchase may well be real, so this is a
		// reconciliation, not a zero-charge cancellation.
		out.Refusal = appleRefusalReconcile
		return out, nil
	case appleContinuationCancelled:
	default:
		out.Refusal = appleRefusalCapabilityCode
		return out, nil
	}

	// A different app instance may take over only at the one state that proves no
	// sheet can still charge: the exact current arm has already reported
	// `.userCancelled`. Current clients persist their own secret before the first
	// request, so the replacement binding is recoverable even if this response is
	// lost. An empty secret is the older server-minted compatibility shape; it is
	// refused here rather than creating a cross-install arm whose only copy of the
	// secret would be in a response that can disappear.
	newInstanceID := existing.AppInstanceID
	newVerifier := existing.ContinuationVerifier
	if !capabilityMatches {
		if in.ContinuationProtocol != appleContinuationProtocolAttemptIDV2 || in.ContinuationSecret == "" {
			out.Refusal = appleRefusalCapabilityCode
			return out, nil
		}
		newInstanceID = in.AppInstanceID
		newVerifier = appleContinuationVerifier(in.ContinuationSecret)
	}

	// Spend the id against EVERY arm this attempt has ever had, not merely the
	// one that is open now. See reserveAppleArmIDTx for the money-loss schedule
	// the current-arm-only comparison permitted.
	//
	// The backfill first: a row armed by a binary older than the history table
	// has no rows at all, so its CURRENT id would look unspent and could be
	// re-armed. Recording it here heals that row on first use, which is what
	// makes the new table additive rather than a data migration. It is
	// idempotent, so it costs one no-op statement on every already-healthy row.
	//
	// Both reservations are rolled back with the transaction on any refusal
	// below, so a refused resume burns nothing and the caller may retry with a
	// genuinely fresh id.
	if existing.ArmRequestID != "" {
		if _, err := reserveAppleArmIDTx(ctx, tx, existing.ID, existing.UserID, existing.ArmRequestID, in.Now); err != nil {
			return AppleDispatchOutcome{}, err
		}
	}
	fresh, err := reserveAppleArmIDTx(ctx, tx, existing.ID, existing.UserID, in.ArmRequestID, in.Now)
	if err != nil {
		return AppleDispatchOutcome{}, err
	}
	if !fresh {
		// A previously spent id -- the current one, or one from any earlier arm.
		// It answers the SAME uniform capability refusal as a wrong secret or a
		// wrong instance, so the endpoint stays a non-oracle: deliberately not a
		// 500 (this is a well-formed request being correctly refused) and
		// deliberately not purchase_outcome_required (which would imply a sheet
		// is open awaiting a report, and would tell the caller its id was the
		// interesting fact).
		out.Refusal = appleRefusalCapabilityCode
		return out, nil
	}

	// The atomic re-arm. One statement authorizes the new sheet, REPLACES the
	// current arm identity and REPOINTS THE ATTEMPT AT THE PRODUCT ACTUALLY BEING
	// BOUGHT. When another installation takes over, this same statement also
	// replaces the app-instance binding and verifier. From the instant it commits,
	// every outcome still naming a previous arm or capability is stale and cannot
	// move the row.
	//
	// WHY THE PRODUCT MOVES. A cancelled sheet is not a promise to buy the same
	// thing next: the honest path is Pro Monthly -> .userCancelled -> the user
	// picks Plus Monthly. Nothing about that is a downgrade attack, and the
	// handler has ALREADY gated this exact product through the catalog,
	// per-account eligibility and manage-with-Apple before the store is reached,
	// so what arrives here is a product this account may currently buy.
	//
	// Leaving product_id on the abandoned product was a money-side contract
	// defect, not a cosmetic one. Convergence in ApplyAuthorizedAppleSource is
	// EXACT on product (attemptProduct == ev.BillingProductID), so a Plus
	// purchase against a Pro-labelled attempt charges and grants correctly and
	// then never resolves: /transaction answers 409 purchase_reconciliation_required
	// forever, StoreKit redelivers, and the authority generation never advances.
	// The account is wedged after a real charge, which is strictly worse than the
	// zero-charge deadlock this file was written to fix.
	//
	// It moves in the SAME statement as the arm replacement rather than in a
	// second UPDATE: the product and the arm identity are one fact -- "this is
	// the sheet that is open" -- and a window in which they disagree is a window
	// in which a delayed report for the old product could resolve the new sheet.
	//
	// `arm_request_id<>?` is retained as defence in depth. The reservation above
	// already refuses the current id -- it is in the history by construction, and
	// backfilled if the row predates the history -- so this predicate is now
	// redundant for every reachable input. It stays because it costs nothing and
	// keeps the statement independently fail-closed: it must never again be the
	// ONLY thing spending an id, which is exactly the defect that made an id from
	// two arms ago reusable.
	res, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts
 SET continuation_state=?,product_id=?,arm_request_id=?,app_instance_id=?,continuation_verifier=?,resume_count=resume_count+1,client_outcome='',outcome_at=0
 WHERE id=? AND user_id=? AND provider=? AND epoch=? AND state='dispatched'
   AND external_scope=? AND app_instance_id=? AND continuation_state=?
	   AND arm_request_id=? AND arm_request_id<>?`,
		appleContinuationArmed, in.ProductID, in.ArmRequestID, newInstanceID, newVerifier,
		existing.ID, existing.UserID, ProviderApple, authority.Epoch,
		authority.ExternalScope, existing.AppInstanceID, appleContinuationCancelled,
		existing.ArmRequestID, in.ArmRequestID)
	if err != nil {
		return AppleDispatchOutcome{}, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return AppleDispatchOutcome{}, err
	}
	if n == 1 {
		// out.Attempt was copied from the row as it was BEFORE this statement, so
		// it still names the abandoned product. Carrying that back to the caller
		// would make the outcome disagree with what was just committed.
		out.Attempt.ProductID = in.ProductID
		out.Resumed = true
		return out, nil
	}
	// Lost the CAS. Re-read: a concurrent honest resume by the same request id is
	// this caller's own lost response; anything else fails closed.
	after, err := scanAppleAttempt(tx.QueryRowContext(ctx, `SELECT `+appleAttemptCols+
		` FROM billing_purchase_attempts WHERE id=? AND user_id=?`, existing.ID, existing.UserID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			out.Refusal = appleRefusalCapabilityCode
			return out, nil
		}
		return AppleDispatchOutcome{}, err
	}
	if after.ContinuationState == appleContinuationArmed &&
		after.capabilityMatches(in.AppInstanceID, in.ContinuationSecret) &&
		after.armMatches(in.ArmRequestID) {
		if after.ProductID == in.ProductID {
			out.Attempt = after.BillingPurchaseAttempt
			out.Replayed = true
			return out, nil
		}
		// The arm this caller named is current, but for a different product --
		// the same logical state the read-time branch above refuses, reached by
		// losing the race instead of by observing it. It answers the same code
		// there and here, so which of the two paths ran is not observable.
		out.Refusal = appleRefusalOutcome
		return out, nil
	}
	out.Refusal = appleRefusalCapabilityCode
	return out, nil
}

// AppleOutcomeRequest is one capability holder's report of what StoreKit did.
type AppleOutcomeRequest struct {
	UserID, AttemptID, BundleID, AppInstanceID, ContinuationSecret, Outcome string
	// ArmRequestID names the arm whose sheet produced this outcome. It must equal
	// the attempt's CURRENT arm identity; a report naming any previous arm is
	// stale by construction and is refused.
	ArmRequestID string
	Now          int64
}

// AppleOutcomeResult is what the report changed.
type AppleOutcomeResult struct {
	// Accepted is false for every capability failure, without distinguishing
	// which fact failed.
	Accepted bool
	// Resumable is true only after an explicit userCancelled. It is a statement
	// about this server's willingness to re-arm, never a claim that Apple
	// confirmed a cancellation — Apple signs transactions, not their absence.
	Resumable bool
}

// RecordAppleBillingPurchaseOutcome records a capability-authored StoreKit
// outcome.
//
// The report is trusted for exactly one thing: releasing a dispatch the SAME
// capability holder armed. It grants nothing, finishes nothing and prices
// nothing. `.userCancelled` becomes resumable; `pending`, an error and an
// unknown result become permanently locked, and so does silence, because none
// of them proves Apple will not charge.
func (s *SQLiteStore) RecordAppleBillingPurchaseOutcome(ctx context.Context, in AppleOutcomeRequest) (AppleOutcomeResult, error) {
	if in.UserID == "" || in.AttemptID == "" || !validAppleOutcome(in.Outcome) ||
		!validAppleContinuationID(in.AppInstanceID) || !validAppleContinuationID(in.ArmRequestID) {
		return AppleOutcomeResult{}, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AppleOutcomeResult{}, err
	}
	defer tx.Rollback()
	var authority BillingAuthority
	if err := tx.QueryRowContext(ctx, `SELECT user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at FROM billing_authorities WHERE user_id=?`, in.UserID).
		Scan(&authority.UserID, &authority.Provider, &authority.ExternalScope, &authority.AppleEnvironment, &authority.AppleAccountToken, &authority.Epoch, &authority.IntentID, &authority.CreatedAt, &authority.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AppleOutcomeResult{}, nil
		}
		return AppleOutcomeResult{}, err
	}
	attempt, err := scanAppleAttempt(tx.QueryRowContext(ctx, `SELECT `+appleAttemptCols+
		` FROM billing_purchase_attempts WHERE id=? AND user_id=?`, in.AttemptID, in.UserID))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AppleOutcomeResult{}, nil
		}
		return AppleOutcomeResult{}, err
	}
	// Same user, same app, same generation, same attempt, same instance, same
	// secret -- AND the same arm. A resolved attempt or a superseded generation is
	// not reportable.
	//
	// armMatches is what makes this report about a particular SHEET rather than
	// merely about a particular client. Every other fact here is stable across
	// resumes, so without it a duplicate or delayed report issued before an
	// earlier resume would still authenticate perfectly and could drag a live
	// armed attempt back to cancelled -- buying a second sheet while the first
	// was still able to charge. It is checked in the SAME uniform predicate as
	// every other capability fact so a stale arm is indistinguishable, to the
	// caller, from a wrong secret.
	if attempt.Provider != ProviderApple || attempt.State != "dispatched" ||
		attempt.Epoch != authority.Epoch || attempt.ExternalScope != authority.ExternalScope ||
		attempt.ExternalScope != in.BundleID ||
		!attempt.capabilityMatches(in.AppInstanceID, in.ContinuationSecret) ||
		!attempt.armMatches(in.ArmRequestID) {
		return AppleOutcomeResult{}, nil
	}
	if attempt.ContinuationState == appleContinuationLocked {
		// Terminal and idempotent: a later report can never unlock it, and
		// answering honestly beats making the client retry forever.
		return AppleOutcomeResult{Accepted: true, Resumable: false}, tx.Commit()
	}
	if attempt.ContinuationState != appleContinuationArmed && attempt.ContinuationState != appleContinuationCancelled {
		return AppleOutcomeResult{}, nil
	}
	next := appleContinuationLocked
	if in.Outcome == appleOutcomeUserCancelled {
		next = appleContinuationCancelled
	}
	// `arm_request_id=?` repeats the read-time check as a write-time predicate, so
	// a resume that commits between the read above and this statement makes the
	// update affect zero rows and fail closed, rather than the two racing on
	// isolation behaviour.
	res, err := tx.ExecContext(ctx, `UPDATE billing_purchase_attempts
 SET continuation_state=?,client_outcome=?,outcome_at=?
 WHERE id=? AND user_id=? AND provider=? AND epoch=? AND state='dispatched'
   AND external_scope=? AND app_instance_id=? AND arm_request_id=? AND continuation_state IN (?,?)`,
		next, in.Outcome, in.Now,
		attempt.ID, in.UserID, ProviderApple, authority.Epoch, authority.ExternalScope,
		in.AppInstanceID, in.ArmRequestID, appleContinuationArmed, appleContinuationCancelled)
	if err != nil {
		return AppleOutcomeResult{}, err
	}
	if n, err := res.RowsAffected(); err != nil || n != 1 {
		if err != nil {
			return AppleOutcomeResult{}, err
		}
		return AppleOutcomeResult{}, nil
	}
	return AppleOutcomeResult{Accepted: true, Resumable: next == appleContinuationCancelled}, tx.Commit()
}

// AppleBillingIncident is durable, non-secret evidence of a money-affecting
// state this server refused to act on.
type AppleBillingIncident struct {
	ID, UserID, Kind, BundleID, Environment string
	IncomingExternalID, ExistingExternalID  string
	IncomingProductID, AttemptID            string
	DetectedAt, LastSeenAt, Observations    int64
}

// appleIncidentSecondSubscription is the one kind this batch records: a SECOND
// distinct live Apple subscription reached one Relayium account.
const appleIncidentSecondSubscription = "second_live_apple_subscription"

// recordAppleBillingIncidentTx upserts one incident. Repeated deliveries of the
// same conflict increment the observation count instead of flooding the table.
func recordAppleBillingIncidentTx(ctx context.Context, tx *sql.Tx, in AppleBillingIncident) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO apple_billing_incidents
 (id,user_id,kind,bundle_id,environment,incoming_external_id,existing_external_id,incoming_product_id,attempt_id,detected_at,last_seen_at,observations)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,1)
 ON CONFLICT(user_id,kind,incoming_external_id,existing_external_id) DO UPDATE SET
   observations=apple_billing_incidents.observations+1,
   last_seen_at=excluded.last_seen_at,
   attempt_id=CASE WHEN apple_billing_incidents.attempt_id='' THEN excluded.attempt_id ELSE apple_billing_incidents.attempt_id END`,
		in.ID, in.UserID, in.Kind, in.BundleID, in.Environment, in.IncomingExternalID,
		in.ExistingExternalID, in.IncomingProductID, in.AttemptID, in.DetectedAt, in.DetectedAt)
	return err
}

// recordAppleSecondSubscriptionIncident writes the evidence for a refused second
// live subscription.
//
// It runs in its OWN transaction, deliberately: the apply that discovered the
// conflict is rolled back so entitlement stays unchanged, and evidence written
// inside that transaction would be rolled back with it.
//
// It is NOT a claim that Relayium reversed or prevented Apple's charge. Refusing
// the second subscription prevents a duplicate Relayium ENTITLEMENT; the
// customer may still have been charged, and this row exists so an operator can
// find that and act on it.
func (s *SQLiteStore) recordAppleSecondSubscriptionIncident(ctx context.Context, ev SourceEvent, environment, attemptID string) {
	var existingExternalID string
	if err := s.reader().QueryRowContext(ctx, `SELECT external_id FROM subscription_sources WHERE user_id=? AND provider=?`, ev.UserID, ProviderApple).
		Scan(&existingExternalID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		// Nothing is written, so the ONLY trace this incident ever happened would
		// be this line. Dropping it silently was the defect: an operator would
		// see a refused second subscription with no evidence anywhere. Every
		// failure path below therefore names the step that failed, so the log
		// distinguishes "could not read the existing binding" from "could not
		// write the evidence".
		//
		// The message carries the account, the step and the driver error and
		// NOTHING ELSE -- no signed payload, no attribution token, no
		// subscription identity, no product, no continuation material -- because
		// the sanitized-log rule applies to the failure paths exactly as it does
		// to the success path below. Only that success path can name the
		// incident id and kind; on these paths no row exists to name.
		log.Printf("billing: recording an apple financial incident for user %s failed: reading the existing apple subscription binding failed: %v", ev.UserID, err)
		return
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		log.Printf("billing: recording an apple financial incident for user %s failed: opening the evidence transaction failed: %v", ev.UserID, err)
		return
	}
	defer tx.Rollback()
	incidentID := authx.NewID()
	if err := recordAppleBillingIncidentTx(ctx, tx, AppleBillingIncident{
		ID: incidentID, UserID: ev.UserID, Kind: appleIncidentSecondSubscription,
		BundleID: ev.ExternalScope, Environment: environment,
		IncomingExternalID: ev.ExternalID, ExistingExternalID: existingExternalID,
		IncomingProductID: ev.BillingProductID, AttemptID: attemptID, DetectedAt: ev.Now,
	}); err != nil {
		log.Printf("billing: recording an apple financial incident for user %s failed: writing the evidence row failed: %v", ev.UserID, err)
		return
	}
	if err := tx.Commit(); err != nil {
		log.Printf("billing: recording an apple financial incident for user %s failed: committing the evidence failed: %v", ev.UserID, err)
		return
	}
	// One line an operator can act on, carrying the incident id and the account
	// and NO subscription identity, attribution token or signed material -- the
	// row holds those. It survives the hard purge that removes the row, which is
	// why it exists. It is NOT a claim that a charge was reversed or prevented.
	log.Printf("billing: apple financial incident %s for user %s (%s): a second distinct live apple subscription reached this account; entitlement unchanged and the transaction left unfinished",
		incidentID, ev.UserID, appleIncidentSecondSubscription)
}

// AppleBillingIncidents lists one account's incident evidence, newest first.
func (s *SQLiteStore) AppleBillingIncidents(ctx context.Context, userID string) ([]AppleBillingIncident, error) {
	rows, err := s.reader().QueryContext(ctx, `SELECT id,user_id,kind,bundle_id,environment,
 incoming_external_id,existing_external_id,incoming_product_id,attempt_id,detected_at,last_seen_at,observations
 FROM apple_billing_incidents WHERE user_id=? ORDER BY detected_at DESC,id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AppleBillingIncident
	for rows.Next() {
		var in AppleBillingIncident
		if err := rows.Scan(&in.ID, &in.UserID, &in.Kind, &in.BundleID, &in.Environment,
			&in.IncomingExternalID, &in.ExistingExternalID, &in.IncomingProductID,
			&in.AttemptID, &in.DetectedAt, &in.LastSeenAt, &in.Observations); err != nil {
			return nil, err
		}
		out = append(out, in)
	}
	return out, rows.Err()
}
