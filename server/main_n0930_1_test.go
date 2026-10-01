package main

import (
	"context"
	"strings"
	"testing"

	"github.com/relayium/relayium/account"
)

// -billing-duplicate-list must show discovery and hold state (N-0930-1, FINAL
// §3): unknown liabilities as unknown, the hold reason, and its evidence.
func TestN0930_1DuplicateListPrintsDiscoveryAndHold(t *testing.T) {
	store, err := account.OpenSQLite(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.PutDuplicateRefund(context.Background(), account.DuplicateRefundPlan{UserID: "u", CustomerID: "cus", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_dup"}, false, 100); err != nil {
		t.Fatal(err)
	}
	evidence, err := account.ListDuplicateRefundEvidence(context.Background(), store, "sub_dup")
	if err != nil {
		t.Fatal(err)
	}
	line := formatDuplicateRefundEvidence(evidence)
	for _, want := range []string{"consecutive_failures=0", "resolution=liabilities_unknown", "discovered_at=0", "liabilities_unknown=true", "post_cancel_inspected=false", `cancel_hold=""`, "hold_evidence=[]"} {
		if !strings.Contains(line, want) {
			t.Fatalf("missing %q in %s", want, line)
		}
	}
	held := evidence
	held.DiscoveredAt, held.LiabilitiesUnknown, held.CancelHold = 150, false, "canonical_past_due"
	held.HoldEvidence = `[{"at":150,"reason":"canonical_past_due","path":"duplicate_cancel_authorization","actor":"system","canonical_seen":"past_due","binding_seen":"sub_keep","customer_seen":"cus"}]`
	line = formatDuplicateRefundEvidence(held)
	for _, want := range []string{"discovered_at=150", "liabilities_unknown=false", `cancel_hold="canonical_past_due"`, `hold_evidence=[{"at":150,"reason":"canonical_past_due"`} {
		if !strings.Contains(line, want) {
			t.Fatalf("missing %q in %s", want, line)
		}
	}
}
