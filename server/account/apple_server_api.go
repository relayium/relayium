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
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

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
	IssuerID, KeyID             string
	PrivateKey                  *ecdsa.PrivateKey
	HTTP                        *http.Client
	ProductionURL, SandboxURL   string
	ProbeInterval, ProbeTimeout time.Duration
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
		cfg.ProductionURL = "https://api.storekit.apple.com"
	}
	if cfg.SandboxURL == "" {
		cfg.SandboxURL = "https://api.storekit-sandbox.apple.com"
	}
	if cfg.ProbeInterval <= 0 {
		cfg.ProbeInterval = 3 * time.Second
	}
	if cfg.ProbeTimeout <= 0 {
		cfg.ProbeTimeout = 105 * time.Second
	}
	for _, raw := range []string{cfg.ProductionURL, cfg.SandboxURL} {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return nil, errors.New("account: App Store Server API URL must be absolute https")
		}
	}
	return &AppleServerAPIClient{cfg: cfg, verifier: verifier}, nil
}

func (c *AppleServerAPIClient) authorization(bundleID string, now time.Time) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": c.cfg.IssuerID, "iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(), "aud": "appstoreconnect-v1", "bid": bundleID})
	tok.Header["kid"] = c.cfg.KeyID
	tok.Header["typ"] = "JWT"
	return tok.SignedString(c.cfg.PrivateKey)
}

func (c *AppleServerAPIClient) CanonicalSubscription(ctx context.Context, submitted VerifiedAppleTransaction, now time.Time) (AppleSubscriptionCanonical, error) {
	return c.CanonicalSubscriptionByIdentity(ctx, AppleSubscriptionIdentity{submitted.OriginalTransactionID, submitted.Environment, submitted.BundleID}, now)
}

func (c *AppleServerAPIClient) CanonicalSubscriptionByIdentity(ctx context.Context, identity AppleSubscriptionIdentity, now time.Time) (AppleSubscriptionCanonical, error) {
	base := c.cfg.ProductionURL
	if identity.Environment == appleEnvSandbox {
		base = c.cfg.SandboxURL
	}
	signed, err := c.authorization(identity.BundleID, now)
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
			candidate := AppleSubscriptionCanonical{tx, ren}
			switch {
			case best.Transaction.SignedDateMS == 0 || tx.SignedDateMS > best.Transaction.SignedDateMS:
				best = candidate
			case tx.SignedDateMS < best.Transaction.SignedDateMS:
				continue
			case tx != best.Transaction:
				return AppleSubscriptionCanonical{}, errors.New("app store status api: ambiguous canonical transaction")
			case ren.SignedDateMS > best.Renewal.SignedDateMS:
				best.Renewal = ren
			case ren.SignedDateMS == best.Renewal.SignedDateMS && ren != best.Renewal:
				return AppleSubscriptionCanonical{}, errors.New("app store status api: ambiguous canonical renewal")
			}
		}
	}
	if best.Transaction.SignedDateMS == 0 {
		return AppleSubscriptionCanonical{}, errors.New("app store status api: no matching verified subscription")
	}
	return best, nil
}

type appleTestNotificationStatus struct {
	SignedPayload string `json:"signedPayload"`
	SendAttempts  []struct {
		SendAttemptResult string `json:"sendAttemptResult"`
	} `json:"sendAttempts"`
}

// ProbeTestNotifications verifies credentials and TEST delivery without opening
// Relayium storage. Apple's remote delivery still reaches the configured normal
// notification URL and may create its ordinary TEST ledger row there.
type AppleProbeEnvironment string

const (
	AppleProbeAll        AppleProbeEnvironment = "all"
	AppleProbeProduction AppleProbeEnvironment = appleEnvProduction
	AppleProbeSandbox    AppleProbeEnvironment = appleEnvSandbox
)

func ParseAppleProbeEnvironment(raw string) (AppleProbeEnvironment, error) {
	switch AppleProbeEnvironment(raw) {
	case AppleProbeAll, AppleProbeProduction, AppleProbeSandbox:
		return AppleProbeEnvironment(raw), nil
	default:
		return "", errors.New("probe environment must be all, Production, or Sandbox")
	}
}

func (c *AppleServerAPIClient) ProbeTestNotifications(ctx context.Context, apps []AppleAppConfig, out io.Writer) error {
	return c.ProbeTestNotificationsFor(ctx, apps, AppleProbeAll, out)
}

func (c *AppleServerAPIClient) ProbeTestNotificationsFor(ctx context.Context, apps []AppleAppConfig, selected AppleProbeEnvironment, out io.Writer) error {
	if len(apps) == 0 {
		return errors.New("stage A: no configured apps")
	}
	targets, err := c.probeTargets(selected)
	if err != nil {
		return err
	}
	var failures []error
	for _, app := range apps {
		for _, target := range targets {
			if err := c.probeTestNotification(ctx, target.name, target.base, app, out); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

type appleProbeTarget struct{ name, base string }

func (c *AppleServerAPIClient) probeTargets(selected AppleProbeEnvironment) ([]appleProbeTarget, error) {
	if _, err := ParseAppleProbeEnvironment(string(selected)); err != nil {
		return nil, err
	}
	environments := c.verifier.Environments()
	if len(environments) == 0 {
		return nil, errors.New("stage A: no configured environments")
	}
	targets := make([]appleProbeTarget, 0, len(environments))
	for _, environment := range environments {
		if selected != AppleProbeAll && string(selected) != environment {
			continue
		}
		switch environment {
		case appleEnvProduction:
			targets = append(targets, appleProbeTarget{environment, c.cfg.ProductionURL})
		case appleEnvSandbox:
			targets = append(targets, appleProbeTarget{environment, c.cfg.SandboxURL})
		default:
			return nil, fmt.Errorf("stage A: unsupported configured environment %q", environment)
		}
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("stage A: selected %s environment is not configured", selected)
	}
	return targets, nil
}

func (c *AppleServerAPIClient) probeTestNotification(ctx context.Context, environment, base string, app AppleAppConfig, out io.Writer) error {
	auth, err := c.authorization(app.BundleID, time.Now())
	if err != nil {
		return errors.New("stage A: JWT construction failed")
	}
	endpoint := strings.TrimRight(base, "/") + "/inApps/v1/notifications/test"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return errors.New("stage A: request construction failed")
	}
	req.Header.Set("Authorization", "Bearer "+auth)
	resp, err := c.cfg.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("stage A: %s %s API request failed", environment, app.BundleID)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if readErr != nil {
		return fmt.Errorf("stage A: %s %s API returned an invalid response", environment, app.BundleID)
	}
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("stage B: %s %s TEST delivery is not configured (HTTP 404)", environment, app.BundleID)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("stage A: %s %s API returned HTTP %d", environment, app.BundleID, resp.StatusCode)
	}
	var created struct {
		Token string `json:"testNotificationToken"`
	}
	if json.Unmarshal(body, &created) != nil || !validAppleTestToken(created.Token) {
		return fmt.Errorf("stage A: %s %s returned an invalid token", environment, app.BundleID)
	}
	fmt.Fprintf(out, "apple probe stage A ok: %s %s\n", environment, app.BundleID)
	deadline := time.Now().Add(c.cfg.ProbeTimeout)
	rateLimited := false
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return fmt.Errorf("stage B: %s %s timed out", environment, app.BundleID)
		case <-time.After(c.cfg.ProbeInterval):
		}
		auth, err = c.authorization(app.BundleID, time.Now())
		if err != nil {
			return errors.New("stage B: JWT construction failed")
		}
		statusURL := endpoint + "/" + url.PathEscape(created.Token)
		req, _ = http.NewRequestWithContext(ctx, http.MethodGet, statusURL, nil)
		req.Header.Set("Authorization", "Bearer "+auth)
		resp, err = c.cfg.HTTP.Do(req)
		if err != nil {
			return fmt.Errorf("stage B: %s %s delivery status failed", environment, app.BundleID)
		}
		body, readErr = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("stage B: %s %s invalid status response", environment, app.BundleID)
		}
		if resp.StatusCode == http.StatusNotFound {
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			if rateLimited {
				return fmt.Errorf("stage B: %s %s rate limited", environment, app.BundleID)
			}
			rateLimited = true
			delay, parseErr := appleRetryAfterDelay(resp.Header.Get("Retry-After"), time.Now(), deadline)
			if parseErr != nil {
				return fmt.Errorf("stage B: %s %s invalid Retry-After", environment, app.BundleID)
			}
			select {
			case <-ctx.Done():
				return fmt.Errorf("stage B: %s %s timed out", environment, app.BundleID)
			case <-time.After(delay):
			}
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("stage B: %s %s API returned HTTP %d", environment, app.BundleID, resp.StatusCode)
		}
		var status appleTestNotificationStatus
		if json.Unmarshal(body, &status) != nil {
			return fmt.Errorf("stage B: %s %s invalid status response", environment, app.BundleID)
		}
		success := false
		explicitFailure := false
		for _, attempt := range status.SendAttempts {
			if attempt.SendAttemptResult == "SUCCESS" {
				success = true
			} else if attempt.SendAttemptResult != "" {
				explicitFailure = true
			}
		}
		if !success {
			if explicitFailure {
				return fmt.Errorf("stage B: %s %s TEST delivery failed", environment, app.BundleID)
			}
			continue
		}
		if status.SignedPayload == "" {
			return fmt.Errorf("stage B: %s %s missing signed payload", environment, app.BundleID)
		}
		verified, verifyErr := c.verifier.VerifyNotification(status.SignedPayload, time.Now())
		if verifyErr != nil || verified.Type != "TEST" || verified.Environment != environment || verified.BundleID != app.BundleID || (environment == appleEnvProduction && verified.AppAppleID != app.AppAppleID) {
			return fmt.Errorf("stage B: %s %s signed TEST verification failed", environment, app.BundleID)
		}
		fmt.Fprintf(out, "apple probe stage B ok: %s %s\n", environment, app.BundleID)
		return nil
	}
	return fmt.Errorf("stage B: %s %s timed out", environment, app.BundleID)
}

func validAppleTestToken(token string) bool {
	if token == "" || len(token) > 1024 || !utf8.ValidString(token) {
		return false
	}
	for _, r := range token {
		if r == 0 || (r >= 0 && r < 0x20) || r == 0x7f {
			return false
		}
	}
	return true
}

func appleRetryAfterDelay(raw string, now, deadline time.Time) (time.Duration, error) {
	millis, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	retryAt := time.UnixMilli(millis)
	if !retryAt.After(now) || retryAt.After(deadline) {
		return 0, errors.New("retry instant is outside the probe deadline")
	}
	return retryAt.Sub(now), nil
}
