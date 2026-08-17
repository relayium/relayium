package account

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type AppleSubscriptionCanonical struct {
	Transaction VerifiedAppleTransaction
	Renewal     VerifiedAppleRenewalInfo
}

type AppleSubscriptionIdentity struct{ OriginalTransactionID, Environment, BundleID string }

type AppleSubscriptionReconciler interface {
	CanonicalSubscription(context.Context, VerifiedAppleTransaction, time.Time) (AppleSubscriptionCanonical, error)
}

type AppleServerAPIConfig struct {
	IssuerID, KeyID           string
	PrivateKey                *ecdsa.PrivateKey
	HTTP                      *http.Client
	ProductionURL, SandboxURL string
}

type AppleServerAPIClient struct {
	cfg      AppleServerAPIConfig
	verifier *AppleTransactionVerifier
}

func NewAppleServerAPIClient(cfg AppleServerAPIConfig, verifier *AppleTransactionVerifier) (*AppleServerAPIClient, error) {
	if strings.TrimSpace(cfg.IssuerID) == "" || strings.TrimSpace(cfg.KeyID) == "" || cfg.PrivateKey == nil || verifier == nil {
		return nil, errors.New("account: complete App Store Server API credentials and verifier are required")
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 15 * time.Second}
	}
	if cfg.ProductionURL == "" {
		cfg.ProductionURL = "https://api.storekit.itunes.apple.com"
	}
	if cfg.SandboxURL == "" {
		cfg.SandboxURL = "https://api.storekit-sandbox.itunes.apple.com"
	}
	for _, raw := range []string{cfg.ProductionURL, cfg.SandboxURL} {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return nil, errors.New("account: App Store Server API URL must be absolute https")
		}
	}
	return &AppleServerAPIClient{cfg: cfg, verifier: verifier}, nil
}

func (c *AppleServerAPIClient) CanonicalSubscription(ctx context.Context, submitted VerifiedAppleTransaction, now time.Time) (AppleSubscriptionCanonical, error) {
	return c.CanonicalSubscriptionByIdentity(ctx, AppleSubscriptionIdentity{submitted.OriginalTransactionID, submitted.Environment, submitted.BundleID}, now)
}

func (c *AppleServerAPIClient) CanonicalSubscriptionByIdentity(ctx context.Context, identity AppleSubscriptionIdentity, now time.Time) (AppleSubscriptionCanonical, error) {
	base := c.cfg.ProductionURL
	if identity.Environment == appleEnvSandbox {
		base = c.cfg.SandboxURL
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": c.cfg.IssuerID, "iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(), "aud": "appstoreconnect-v1", "bid": identity.BundleID})
	tok.Header["kid"] = c.cfg.KeyID
	tok.Header["typ"] = "JWT"
	signed, err := tok.SignedString(c.cfg.PrivateKey)
	if err != nil {
		return AppleSubscriptionCanonical{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/inApps/v1/subscriptions/"+url.PathEscape(identity.OriginalTransactionID), nil)
	if err != nil {
		return AppleSubscriptionCanonical{}, err
	}
	req.Header.Set("Authorization", "Bearer "+signed)
	resp, err := c.cfg.HTTP.Do(req)
	if err != nil {
		return AppleSubscriptionCanonical{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return AppleSubscriptionCanonical{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return AppleSubscriptionCanonical{}, fmt.Errorf("app store status api: http %d", resp.StatusCode)
	}
	var out struct {
		Data []struct {
			LastTransactions []struct {
				SignedTransactionInfo string `json:"signedTransactionInfo"`
				SignedRenewalInfo     string `json:"signedRenewalInfo"`
			} `json:"lastTransactions"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &out) != nil {
		return AppleSubscriptionCanonical{}, errors.New("app store status api: invalid response")
	}
	var best AppleSubscriptionCanonical
	for _, g := range out.Data {
		for _, last := range g.LastTransactions {
			tx, e := c.verifier.verifyTransactionIdentity(last.SignedTransactionInfo, now)
			if e != nil || appleSubscriptionShape(tx) != nil {
				continue
			}
			if tx.OriginalTransactionID != identity.OriginalTransactionID || tx.BundleID != identity.BundleID || tx.Environment != identity.Environment {
				continue
			}
			ren, e := c.verifier.VerifyRenewalInfo(last.SignedRenewalInfo, tx, now)
			if e != nil {
				continue
			}
			if best.Transaction.SignedDateMS == 0 || tx.SignedDateMS > best.Transaction.SignedDateMS {
				best = AppleSubscriptionCanonical{tx, ren}
			}
		}
	}
	if best.Transaction.SignedDateMS == 0 {
		return AppleSubscriptionCanonical{}, errors.New("app store status api: no matching verified subscription")
	}
	return best, nil
}
