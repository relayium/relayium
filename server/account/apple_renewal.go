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
	AppAccountToken       string
	Environment           string
	AutoRenewEnabled      bool
	IsInBillingRetry      bool
	GracePeriodExpiresMS  int64
	RenewalDateMS         int64
	SignedDateMS          int64
	ExpirationIntent      int64
	PriceIncreaseStatus   int64
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
		AppAccountToken       string          `json:"appAccountToken"`
		Environment           string          `json:"environment"`
		AutoRenewStatus       json.Number     `json:"autoRenewStatus"`
		IsInBillingRetry      json.RawMessage `json:"isInBillingRetryPeriod"`
		GracePeriodExpires    json.Number     `json:"gracePeriodExpiresDate"`
		RenewalDate           json.Number     `json:"renewalDate"`
		SignedDate            json.Number     `json:"signedDate"`
		ExpirationIntent      json.Number     `json:"expirationIntent"`
		PriceIncreaseStatus   json.Number     `json:"priceIncreaseStatus"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return VerifiedAppleRenewalInfo{}, rejectApple("renewal_json")
	}
	if p.OriginalTransactionID == "" || len(p.OriginalTransactionID) > appleMaxIDLen ||
		len(p.AutoRenewProductID) > appleMaxProductIDLen {
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
	if err != nil || signed < tx.PurchaseDateMS {
		return VerifiedAppleRenewalInfo{}, rejectApple("signed_date")
	}
	if p.OriginalTransactionID != tx.OriginalTransactionID || p.Environment != tx.Environment || !v.acceptsEnvironment(p.Environment) ||
		(p.AppAccountToken != "" && p.AppAccountToken != tx.AppAccountToken) {
		return VerifiedAppleRenewalInfo{}, rejectApple("renewal_mismatch")
	}
	autoRenew, err := appleOptionalAutoRenew(p.AutoRenewStatus)
	if err != nil {
		return VerifiedAppleRenewalInfo{}, err
	}
	expiration, err := appleOptionalMillis(p.ExpirationIntent, "expiration_intent")
	if err != nil {
		return VerifiedAppleRenewalInfo{}, err
	}
	price := int64(-1)
	if p.PriceIncreaseStatus.String() != "" {
		price, err = appleOptionalMillis(p.PriceIncreaseStatus, "price_increase_status")
	}
	if err != nil {
		return VerifiedAppleRenewalInfo{}, err
	}
	if !retry || grace == 0 || grace > tx.ExpiresDateMS+int64((28*24*time.Hour)/time.Millisecond) {
		grace = 0
	}
	return VerifiedAppleRenewalInfo{OriginalTransactionID: p.OriginalTransactionID, AutoRenewProductID: p.AutoRenewProductID,
		AppAccountToken: p.AppAccountToken, Environment: p.Environment, AutoRenewEnabled: autoRenew,
		IsInBillingRetry: retry, GracePeriodExpiresMS: grace, RenewalDateMS: renewal, SignedDateMS: signed,
		ExpirationIntent: expiration, PriceIncreaseStatus: price}, nil
}

func appleOptionalAutoRenew(n json.Number) (bool, error) {
	if n.String() == "" {
		return true, nil
	}
	v, err := n.Int64()
	if err != nil || (v != 0 && v != 1) {
		return false, rejectApple("auto_renew_status")
	}
	return v == 1, nil
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
	AutoRenewEnabled                                                   bool
	GraceUntil, RenewalAt, EventAt, UpdatedAt                          int64
	ExpirationIntent, PriceIncreaseStatus                              int64
}

func (r AppleRenewalState) graceActive(now time.Time) bool {
	return r.IsInBillingRetry && r.GraceUntil > now.Unix()
}

func appleRenewalState(userID string, tx VerifiedAppleTransaction, r VerifiedAppleRenewalInfo, now time.Time) AppleRenewalState {
	external, _ := appleSubscriptionKeyOf(tx).externalID()
	return AppleRenewalState{UserID: userID, ExternalID: external, BundleID: tx.BundleID,
		CurrentProductID: tx.ProductID, AutoRenewProductID: r.AutoRenewProductID,
		IsInBillingRetry: r.IsInBillingRetry, AutoRenewEnabled: r.AutoRenewEnabled,
		GraceUntil: appleSeconds(r.GracePeriodExpiresMS), RenewalAt: appleSeconds(r.RenewalDateMS),
		EventAt: appleSeconds(r.SignedDateMS), UpdatedAt: now.Unix(),
		ExpirationIntent: r.ExpirationIntent, PriceIncreaseStatus: r.PriceIncreaseStatus}
}
