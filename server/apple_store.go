package main

import (
	"fmt"
	"log"
	"strings"

	"github.com/relayium/relayium/account"
)

// The startup boundary for App Store purchase verification.
//
// THREE STATES, and only three:
//
//  1. UNCONFIGURED — no -apple-store-config-file / RELAYIUM_APPLE_STORE_CONFIG_FILE.
//     This is the shipping default and what every existing deployment is. No
//     verifier is built, none is installed, and both App Store routes keep
//     answering 503 exactly as they do today: POST /api/billing/apple/transaction
//     with `verifier_unavailable`, and Apple's own POST /api/apple/notifications
//     with a retryable refusal so no delivery is discarded while unconfigured.
//  2. CONFIGURED — the path names a readable, complete configuration. The
//     verifier is built during startup validation and installed once the account
//     service exists.
//  3. BROKEN — the path is set but the configuration is missing, unreadable,
//     incomplete or malformed. The server refuses to start.
//
// There is no fourth state where the deployment looks configured and answers
// 503. That is the whole point of (3): a mistyped path or a half-filled file is
// the case where a silent fallback to (1) would be indistinguishable, from the
// outside, from a purchase path that simply never works — and the discovery
// would be a customer whose money moved without their plan changing.
//
// Note the split between LOADING and INSTALLING. Loading happens with the other
// startup validation, before the database is opened, so a broken configuration
// fails on every boot rather than only on boots where SQLite happened to open.
// Installing happens after the service is constructed. Nothing is partially
// active in between: until installAppleTransactionVerifier runs, the service
// holds no verifier at all, and a failed load never reaches it.

// appleVerifierSink is the single method this wiring needs from the account
// service. Declared as an interface so the install step can be tested for what
// it does NOT do — an unconfigured deployment must leave the service untouched,
// which is a claim about a call that never happens.
type appleVerifierSink interface {
	SetAppleTransactionVerifier(*account.AppleTransactionVerifier)
}

// The real sink. Stated here so that a change to the service's signature breaks
// this build rather than leaving the interface satisfied only by the test's
// stand-in.
var _ appleVerifierSink = (*account.Service)(nil)

// appleStoreSetup is what startup learned from the configuration file. The zero
// value is state (1) above: nothing to install and nothing to say.
type appleStoreSetup struct {
	verifier  *account.AppleTransactionVerifier
	probeApps []account.AppleAppConfig
	// env and apps exist only so the boot log can state which App Store(s) this
	// deployment is now talking to. A deployment that is verifying SANDBOX
	// transactions in production would otherwise look identical to a working
	// one until somebody noticed the free subscriptions — and one that accepts
	// BOTH is a deliberate configuration an operator must be able to confirm
	// from the log rather than infer from the file.
	env  string
	apps int
}

// loadAppleStore reads and validates the App Store verifier configuration.
//
// An empty path is the default and is not an error: it returns the zero setup.
// Any other outcome is decided entirely here — the caller's only job is to stop
// on an error.
func loadAppleStore(path string) (appleStoreSetup, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return appleStoreSetup{}, nil
	}
	cfg, err := account.LoadAppleStoreConfig(path)
	if err != nil {
		return appleStoreSetup{}, err
	}
	v, err := account.NewAppleTransactionVerifier(cfg)
	if err != nil {
		// The verifier's own rules (supported environment, at least one app, no
		// duplicate bundle id, a production app that names its App Store id)
		// refused the file. Name the file: the message describes a rule, and the
		// operator needs to know which document broke it.
		return appleStoreSetup{}, fmt.Errorf("%w (from %s)", err, path)
	}
	probeApps := make([]account.AppleAppConfig, 0, len(cfg.Apps))
	for _, configured := range cfg.Apps {
		app, ok := v.ConfiguredApp(strings.TrimSpace(configured.BundleID))
		if !ok {
			return appleStoreSetup{}, fmt.Errorf("account: verified App Store app enumeration failed (from %s)", path)
		}
		probeApps = append(probeApps, app)
	}
	// From the VERIFIER, not from the file: what is reported is the closed set the
	// verifier actually accepts, after its own validation and normalization.
	return appleStoreSetup{verifier: v, probeApps: probeApps, env: strings.Join(v.Environments(), "+"), apps: len(probeApps)}, nil
}

// install wires the verifier into the account service, or does nothing at all.
//
// "Nothing at all" is not a no-op with a shrug: SetAppleTransactionVerifier(nil)
// would also leave the service unconfigured, but calling it would make this
// wiring look like it participates in every deployment. It does not — an
// unconfigured server never touches the field, and the 503 it answers is the
// service's own untouched default.
func (s appleStoreSetup) install(sink appleVerifierSink) {
	if s.verifier == nil {
		return
	}
	sink.SetAppleTransactionVerifier(s.verifier)
	// One line, no material: which store, how many apps. The configuration
	// holds no secrets, but a boot log is not the place to restate it either.
	log.Printf("app store: ENABLED (%s, %d app identity/identities) — POST /api/billing/apple/transaction now verifies submitted transactions, and POST /api/apple/notifications now verifies App Store Server Notifications V2. Which product grants which plan still comes from the Apple product catalog in the database; a verified transaction for a product with no mapping is refused on the intake and deferred for replay on a notification (see docs/apple-server-notifications.md)", s.env, s.apps)
}
