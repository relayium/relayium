package account

import "testing"

func TestAppleCanonicalSelectionKeepsTransactionWhenRenewalIsUnavailable(t *testing.T) {
	tx := VerifiedAppleTransaction{TransactionID: "2000000000000001", OriginalTransactionID: "2000000000000001", SignedDateMS: 200}
	withoutRenewal := AppleSubscriptionCanonical{Transaction: tx}

	got, err := selectAppleCanonical(AppleSubscriptionCanonical{}, withoutRenewal)
	if err != nil || got.Transaction != tx || got.Renewal.OriginalTransactionID != "" {
		t.Fatalf("transaction without renewal was not selectable: got=%+v err=%v", got, err)
	}

	withRenewal := AppleSubscriptionCanonical{Transaction: tx, Renewal: VerifiedAppleRenewalInfo{OriginalTransactionID: tx.OriginalTransactionID, SignedDateMS: 300}}
	got, err = selectAppleCanonical(got, withRenewal)
	if err != nil || got.Renewal != withRenewal.Renewal {
		t.Fatalf("later valid renewal did not enrich the same transaction: got=%+v err=%v", got, err)
	}

	got, err = selectAppleCanonical(got, withoutRenewal)
	if err != nil || got.Renewal != withRenewal.Renewal {
		t.Fatalf("missing renewal erased a verified projection: got=%+v err=%v", got, err)
	}
}
