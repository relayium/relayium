package inboxsend

import (
	"strings"
	"testing"
)

// H3 for the messages the sender prints: no "within an hour" cleanup promise,
// no claim about bytes that were never sent, no exactly-once promise.
func TestSenderMessagesMakeNoCleanupOrChargePromise(t *testing.T) {
	outcomes := []string{}
	for _, o := range []string{outcomeFailed, outcomeExpired, outcomeRemoved} {
		outcomes = append(outcomes, finalizeOutcomeFailure(o, nil).Msg)
	}
	for _, s := range append([]string{msgOrphanPartial, msgOrphanObject, msgFinalizeRefused, msgUnknownOutcome, msgUnknownDelivery, msgStaleAfterRestart, msgSendAgain}, outcomes...) {
		low := strings.ToLower(s)
		for _, banned := range []string{"within 1 hour", "within an hour", "within one hour", "within 1 h",
			"charged for bytes not sent", "bytes that were not sent", "exactly once"} {
			if strings.Contains(low, banned) {
				t.Errorf("message says %q: %s", banned, s)
			}
		}
	}
	if !strings.Contains(msgOrphanPartial, "eligible after about an hour; cleanup runs periodically and can be delayed") ||
		!strings.Contains(msgOrphanPartial, msgMetered) {
		t.Error("orphan disclosure lost its precise wording")
	}
	// O-1: transfer (metered per append) and the daily upload quota (reserved
	// only by a finalize that succeeds) are different things, and neither is
	// the vague "your usage".
	if !strings.Contains(msgMetered, "count as transfer") || !strings.Contains(msgMetered, "only an upload the server completes uses the daily upload quota") {
		t.Errorf("metering sentence: %s", msgMetered)
	}
	for _, s := range []string{msgOrphanPartial, msgOrphanObject, msgFinalizeRefused} {
		if strings.Contains(s, "counted toward your usage") {
			t.Errorf("message blurs transfer and daily quota: %s", s)
		}
	}
	// A refused finalize may already have had its ciphertext discarded by the
	// server, or (refused before the handler) not: never assert either.
	if strings.Contains(msgFinalizeRefused, "The partial upload stays on the server") ||
		!strings.Contains(msgFinalizeRefused, "already discarded or stays on the server until cleanup removes it") {
		t.Errorf("finalize refusal copy: %s", msgFinalizeRefused)
	}
}
