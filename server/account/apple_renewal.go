package account

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

// VerifiedAppleRenewalInfo is future subscription intent independently signed
// by Apple. It never grants a tier by itself; it can only extend an already
// verified transaction through Apple's bounded billing grace period and state
// what product Apple will attempt to renew next.
type VerifiedAppleRenewalInfo struct {
	OriginalTransactionID string
	AutoRenewProductID    string
	Environment           string
	IsInBillingRetry      bool
	GracePeriodExpiresMS  int64
	RenewalDateMS         int64
	SignedDateMS          int64
}

func (v *AppleTransactionVerifier) VerifyRenewalInfo(jws string, tx VerifiedAppleTransaction, now time.Time) (VerifiedAppleRenewalInfo, error) {
	if v == nil || jws == "" || strings.TrimSpace(jws) != jws {
		return VerifiedAppleRenewalInfo{}, rejectApple("renewal_info")
	}
	raw, err := verifyAppleCompactJWS(jws, v.roots, now, appleMaxJWSBytes)
	if err != nil {
		return VerifiedAppleRenewalInfo{}, err
	}
	var p struct {
		OriginalTransactionID string          `json:"originalTransactionId"`
		AutoRenewProductID    string          `json:"autoRenewProductId"`
		Environment           string          `json:"environment"`
		IsInBillingRetry      json.RawMessage `json:"isInBillingRetryPeriod"`
		GracePeriodExpires    json.Number     `json:"gracePeriodExpiresDate"`
		RenewalDate           json.Number     `json:"renewalDate"`
		SignedDate            json.Number     `json:"signedDate"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return VerifiedAppleRenewalInfo{}, rejectApple("renewal_json")
	}
	if p.OriginalTransactionID == "" || len(p.OriginalTransactionID) > appleMaxIDLen ||
		p.AutoRenewProductID == "" || len(p.AutoRenewProductID) > appleMaxProductIDLen {
		return VerifiedAppleRenewalInfo{}, rejectApple("renewal_identity")
	}
	retry, err := appleOptionalBool(p.IsInBillingRetry, "renewal_retry")
	if err != nil {
		return VerifiedAppleRenewalInfo{}, rejectApple("renewal_retry")
	}
	grace, err := appleOptionalMillis(p.GracePeriodExpires, "grace_period_expires")
	if err != nil {
		return VerifiedAppleRenewalInfo{}, err
	}
	renewal, err := appleOptionalMillis(p.RenewalDate, "renewal_date")
	if err != nil {
		return VerifiedAppleRenewalInfo{}, err
	}
	signed, err := appleMillis(p.SignedDate, "signed_date")
	if err != nil || signed <= 0 {
		return VerifiedAppleRenewalInfo{}, rejectApple("signed_date")
	}
	if p.OriginalTransactionID != tx.OriginalTransactionID || p.Environment != tx.Environment || !v.acceptsEnvironment(p.Environment) {
		return VerifiedAppleRenewalInfo{}, rejectApple("renewal_mismatch")
	}
	return VerifiedAppleRenewalInfo{p.OriginalTransactionID, p.AutoRenewProductID, p.Environment,
		retry, grace, renewal, signed}, nil
}

func appleOptionalMillis(n json.Number, field string) (int64, error) {
	if n.String() == "" {
		return 0, nil
	}
	return appleMillis(n, field)
}

type AppleRenewalState struct {
	UserID, ExternalID, BundleID, CurrentProductID, AutoRenewProductID string
	IsInBillingRetry                                                   bool
	GraceUntil, RenewalAt, EventAt, UpdatedAt                          int64
}

func (r AppleRenewalState) graceActive(now time.Time) bool {
	return r.IsInBillingRetry && r.GraceUntil > now.Unix()
}

func appleRenewalState(userID string, tx VerifiedAppleTransaction, r VerifiedAppleRenewalInfo, now time.Time) AppleRenewalState {
	external, _ := appleSubscriptionKeyOf(tx).externalID()
	return AppleRenewalState{UserID: userID, ExternalID: external, BundleID: tx.BundleID,
		CurrentProductID: tx.ProductID, AutoRenewProductID: r.AutoRenewProductID,
		IsInBillingRetry: r.IsInBillingRetry, GraceUntil: appleSeconds(r.GracePeriodExpiresMS),
		RenewalAt: appleSeconds(r.RenewalDateMS), EventAt: appleSeconds(r.SignedDateMS), UpdatedAt: now.Unix()}
}
