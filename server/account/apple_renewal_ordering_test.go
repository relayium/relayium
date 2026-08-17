package account

import (
	"testing"
	"time"
)

func TestAppleRenewalOrderingRetainsSignedDateMilliseconds(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	tx := VerifiedAppleTransaction{BundleID: "com.relayium.mac", ProductID: "pro.monthly", OriginalTransactionID: "original", Environment: appleEnvProduction}
	base := VerifiedAppleRenewalInfo{OriginalTransactionID: "original", AutoRenewProductID: "pro.monthly", SignedDateMS: 1_700_000_000_100}
	first := appleRenewalState("user", tx, base, now)
	base.SignedDateMS++
	second := appleRenewalState("user", tx, base, now)
	if first.EventAt != 1_700_000_000_100 || second.EventAt != first.EventAt+1 {
		t.Fatalf("millisecond ordering lost: first=%d second=%d", first.EventAt, second.EventAt)
	}
}
