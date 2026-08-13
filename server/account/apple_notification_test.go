package account

import (
	"encoding/asn1"
	"strings"
	"testing"
	"time"
)

// App Store Server Notifications V2, at the verifier level.
//
// The property under test throughout is that TWO envelopes are verified
// INDEPENDENTLY. Almost every case below exists because a verifier that trusted
// the inner JWS on the strength of the outer one would pass the happy path and
// fail exactly here.
//
// Everything builds its own root, intermediate and leaf; no Apple certificate,
// key or network call is involved.

const testNotificationUUID = "9f0b2e3a-1c4d-4e5f-8a9b-0c1d2e3f4a5b"

// appleNotificationPayload is a well-formed DID_RENEW envelope wrapping txJWS.
func appleNotificationPayload(txJWS string, mut ...func(map[string]any)) map[string]any {
	p := map[string]any{
		"notificationType": "DID_RENEW",
		"subtype":          "",
		"notificationUUID": testNotificationUUID,
		"version":          "2.0",
		"signedDate":       time.Now().UnixMilli(),
		"data": map[string]any{
			"bundleId":              testBundleIOS,
			"bundleVersion":         "1",
			"environment":           "Sandbox",
			"status":                1,
			"signedTransactionInfo": txJWS,
		},
	}
	for _, m := range mut {
		m(p)
	}
	return p
}

// withAppleNotificationData mutates the nested `data` object.
func withAppleNotificationData(f func(map[string]any)) func(map[string]any) {
	return func(p map[string]any) { f(p["data"].(map[string]any)) }
}

// notify signs one envelope with this chain's leaf.
func (c *appleTestChain) notify(t *testing.T, txJWS string, mut ...func(map[string]any)) string {
	t.Helper()
	return c.sign(t, appleNotificationPayload(txJWS, mut...))
}

// mustVerifyNotification is the accepting path; every test that starts from a
// good notification goes through it so a regression there fails loudly once.
func mustVerifyNotification(t *testing.T, v *AppleTransactionVerifier, jws string) VerifiedAppleNotification {
	t.Helper()
	n, err := v.VerifyNotification(jws, time.Now())
	if err != nil {
		t.Fatalf("valid notification rejected: %v", err)
	}
	return n
}

// mustRejectNotification requires a specific fixed rejection code.
func mustRejectNotification(t *testing.T, v *AppleTransactionVerifier, jws, code string) {
	t.Helper()
	n, err := v.VerifyNotification(jws, time.Now())
	if err == nil {
		t.Fatalf("want %s, but the notification was accepted (uuid %q, hasTx %v)", code, n.UUID, n.HasTransaction)
	}
	if got := appleRejectionCode(err); got != code {
		t.Fatalf("want rejection %q, got %q (%v)", code, got, err)
	}
}

// ── The one accepting case ───────────────────────────────────────────────────

func TestAppleNotificationAcceptsValidEnvelopeAndTransaction(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	tx := c.sign(t, applePayload())

	n := mustVerifyNotification(t, v, c.notify(t, tx))

	if n.UUID != testNotificationUUID {
		t.Fatalf("uuid: want %q, got %q", testNotificationUUID, n.UUID)
	}
	if n.Type != "DID_RENEW" || n.Version != "2.0" {
		t.Fatalf("envelope fields: type=%q version=%q", n.Type, n.Version)
	}
	if !n.HasTransaction || !n.Supported {
		t.Fatalf("want a supported transaction, got hasTx=%v supported=%v", n.HasTransaction, n.Supported)
	}
	if n.Transaction.OriginalTransactionID != "2000000000000001" {
		t.Fatalf("nested transaction: %+v", n.Transaction)
	}
	if n.BundleID != testBundleIOS || n.Environment != appleEnvSandbox {
		t.Fatalf("envelope identity: bundle=%q env=%q", n.BundleID, n.Environment)
	}
	// The envelope's signedDate is recorded, and is NOT the ordering clock: that
	// comes from the transaction's own purchaseDate. A test that let them be the
	// same number would not notice a verifier that used the wrong one.
	if n.SignedDateMS <= 0 {
		t.Fatalf("signedDate not recorded: %d", n.SignedDateMS)
	}
	if got := appleEventClock(n.Transaction); got != n.Transaction.PurchaseDateMS*2 {
		t.Fatalf("event clock must derive from purchaseDate, got %d", got)
	}
	// The notificationUUID is normalized to lower case, so one delivery cannot
	// occupy two ledger rows by changing its own spelling.
	upper := c.notify(t, tx, func(p map[string]any) {
		p["notificationUUID"] = strings.ToUpper(testNotificationUUID)
	})
	if got := mustVerifyNotification(t, v, upper).UUID; got != testNotificationUUID {
		t.Fatalf("uuid case: want %q, got %q", testNotificationUUID, got)
	}
}

// ── Two envelopes, two independent verifications ─────────────────────────────

// The case the whole design exists for: a GENUINE envelope, signed by the real
// chain, carrying a transaction signed by somebody else. A verifier that
// decoded the inner JWS because the outer one verified would grant on it.
func TestAppleNotificationRejectsForeignInnerRoot(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	foreign := newAppleTestChain(t)

	// The inner JWS is well-formed, correctly signed, and self-consistent — it is
	// simply signed by a chain this deployment does not trust.
	foreignTx := foreign.sign(t, applePayload())
	mustRejectNotification(t, v, c.notify(t, foreignTx), "chain")

	// The mirror image: a genuine transaction inside a foreign envelope. The
	// inner JWS would verify perfectly on its own, which is exactly why the outer
	// one has to be checked first and on its own evidence.
	mustRejectNotification(t, v, foreign.notify(t, c.sign(t, applePayload())), "chain")
}

// An unsigned inner payload — the shape an attacker reaches for once they learn
// the outer envelope is checked.
func TestAppleNotificationRejectsUnsignedInnerPayload(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	// Same chain, but the signature is over different bytes: sign one payload,
	// then swap in another.
	honest := c.sign(t, applePayload())
	tampered := c.sign(t, applePayload(func(p map[string]any) { p["productId"] = "com.relayium.app.max.yearly" }))
	parts := strings.Split(honest, ".")
	swapped := parts[0] + "." + strings.Split(tampered, ".")[1] + "." + parts[2]
	mustRejectNotification(t, v, c.notify(t, swapped), "signature")

	// And a transaction that is not a JWS at all.
	for _, bad := range []string{"not-a-jws", "a.b", "a.b.c.d", ""} {
		n, err := v.VerifyNotification(c.notify(t, bad), time.Now())
		if bad == "" {
			// An absent transaction is a different fact from a malformed one: there
			// is nothing to verify, and nothing to refuse either.
			if err != nil || n.HasTransaction {
				t.Fatalf("empty signedTransactionInfo: err=%v hasTx=%v", err, n.HasTransaction)
			}
			continue
		}
		if err == nil {
			t.Fatalf("malformed inner JWS %q was accepted", bad)
		}
	}
}

// Algorithm substitution, at BOTH layers. `alg` is pinned rather than
// negotiated; a verifier that read it from the header would accept "none".
func TestAppleNotificationRejectsAlgorithmSubstitutionAtBothLayers(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	inner := c.signWith(t, c.leafKey,
		map[string]any{"alg": "none", "x5c": c.x5c()}, applePayload())
	mustRejectNotification(t, v, c.notify(t, inner), "alg")

	outer := c.signWith(t, c.leafKey,
		map[string]any{"alg": "ES384", "x5c": c.x5c()},
		appleNotificationPayload(c.sign(t, applePayload())))
	mustRejectNotification(t, v, outer, "alg")
}

// Chain substitution at the outer layer: a decoy carrying the WWDR marker at
// x5c[1] while the path that actually validates runs through x5c[2]. The
// transaction verifier already refuses this; the envelope must too, because it
// is the same verifier and the same three-certificate shape.
func TestAppleNotificationRejectsChainSubstitutionAtTheOuterLayer(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	tx := c.sign(t, applePayload())

	// A leaf with no Apple receipt-signing marker: path-valid, but not a
	// transaction-signing certificate.
	unmarked := newAppleTestChainWithLeaf(t, certOpts{leafMarker: []asn1.ObjectIdentifier{}})
	unmarkedV := testVerifier(t, unmarked)
	mustRejectNotification(t, unmarkedV, unmarked.notify(t, unmarked.sign(t, applePayload())), "leaf_marker")

	// A four-certificate x5c, and a two-certificate one. Apple sends exactly
	// three; a range would be an invitation to present another arrangement.
	for _, x5c := range [][]string{
		append(c.x5c(), c.x5c()[2]),
		c.x5c()[:2],
	} {
		bad := c.signWith(t, c.leafKey,
			map[string]any{"alg": "ES256", "x5c": x5c},
			appleNotificationPayload(tx))
		mustRejectNotification(t, v, bad, "x5c_count")
	}
}

// ── Cross-layer identity ─────────────────────────────────────────────────────

// The substitution that both signatures are individually happy with: a genuine
// envelope for one CONFIGURED app carrying a genuine transaction from ANOTHER
// configured app. Only the cross-layer comparison catches it, and without it a
// macOS purchase could be presented as an iOS one.
func TestAppleNotificationRejectsCrossLayerAppSubstitution(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	macTx := c.sign(t, applePayload(func(p map[string]any) { p["bundleId"] = testBundleMac }))
	// Both bundles are configured, so neither layer refuses on its own.
	if _, err := v.Verify(macTx, time.Now()); err != nil {
		t.Fatalf("the macOS transaction must be valid on its own: %v", err)
	}
	mustRejectNotification(t, v, c.notify(t, macTx), "notification_layer_mismatch")
}

// An envelope naming an app this deployment is not configured for. Apple signs
// every developer's notifications with the same chain, so "it verified" narrows
// the sender to Apple and not to us.
func TestAppleNotificationRejectsUnconfiguredAppAndEnvironment(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	tx := c.sign(t, applePayload())

	mustRejectNotification(t, v, c.notify(t, tx, withAppleNotificationData(func(d map[string]any) {
		d["bundleId"] = "com.attacker.app"
	})), "bundle")

	mustRejectNotification(t, v, c.notify(t, tx, withAppleNotificationData(func(d map[string]any) {
		d["environment"] = appleEnvProduction
	})), "environment")

	// The envelope's identity is checked even when there is no transaction to
	// act on, so a foreign app cannot deposit ledger rows here.
	mustRejectNotification(t, v, c.notify(t, "", withAppleNotificationData(func(d map[string]any) {
		d["bundleId"] = "com.attacker.app"
	})), "bundle")
}

// appAppleId names the App Store RECORD. Apple's notification verifier requires
// an exact configured value in Production and does not use it in Sandbox.
func TestAppleNotificationEnforcesProductionAppAppleID(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	tx := c.sign(t, applePayload())

	// Sandbox ignores this production-only identity field, matching Apple's
	// official verifier rather than the separate transaction-intake rules.
	mustVerifyNotification(t, v, c.notify(t, tx, withAppleNotificationData(func(d map[string]any) {
		d["appAppleId"] = 6001234567
	})))

	// A production deployment that declares one: a DIFFERENT id is refused and
	// the configured id is accepted.
	prod, err := NewAppleTransactionVerifier(AppleStoreConfig{
		Environment:  appleEnvProduction,
		Apps:         []AppleAppConfig{{BundleID: testBundleIOS, AppAppleID: 6001234567}},
		RootCertsPEM: c.rootPEM,
	})
	if err != nil {
		t.Fatalf("NewAppleTransactionVerifier: %v", err)
	}
	prodTx := c.sign(t, applePayload(func(p map[string]any) { p["environment"] = appleEnvProduction }))
	prodEnv := func(d map[string]any) { d["environment"] = appleEnvProduction }

	mustRejectNotification(t, prod, c.notify(t, prodTx, withAppleNotificationData(prodEnv)), "app_apple_id")

	mustRejectNotification(t, prod, c.notify(t, prodTx, withAppleNotificationData(func(d map[string]any) {
		prodEnv(d)
		d["appAppleId"] = 6009999999
	})), "app_apple_id")

	n := mustVerifyNotification(t, prod, c.notify(t, prodTx, withAppleNotificationData(func(d map[string]any) {
		prodEnv(d)
		d["appAppleId"] = 6001234567
	})))
	if n.AppAppleID != 6001234567 {
		t.Fatalf("appAppleId: got %d", n.AppAppleID)
	}

	// A transaction that carries its own appAppleId is pinned to the CONFIGURED
	// record, not merely to the envelope's copy of it. Apple does not normally
	// populate the field there, which is precisely why it must not be accepted
	// unchecked when it appears — and pinning to configuration is what makes the
	// two layers agree without ever comparing them to each other.
	mismatched := c.sign(t, applePayload(func(p map[string]any) {
		p["environment"] = appleEnvProduction
		p["appAppleId"] = 6009999999
	}))
	mustRejectNotification(t, prod, c.notify(t, mismatched, withAppleNotificationData(func(d map[string]any) {
		prodEnv(d)
		d["appAppleId"] = 6001234567
	})), "app_apple_id")
}

// ── The envelope's own fields ────────────────────────────────────────────────

// notificationUUID becomes a database primary key and the idempotency key. Its
// shape is checked before it can be written anywhere.
func TestAppleNotificationRequiresAWellFormedUUID(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	tx := c.sign(t, applePayload())

	for _, bad := range []any{
		"", "not-a-uuid", "9f0b2e3a1c4d4e5f8a9b0c1d2e3f4a5b",
		"9f0b2e3a-1c4d-4e5f-8a9b-0c1d2e3f4a5b0", "9f0b2e3a-1c4d-4e5f-8a9b-0c1d2e3f4a5",
		"9f0b2e3a-1c4d-4e5f-8a9b-0c1d2e3f4azz", "9f0b2e3a_1c4d_4e5f_8a9b_0c1d2e3f4a5b",
		strings.Repeat("a", 36),
	} {
		mustRejectNotification(t, v, c.notify(t, tx, func(p map[string]any) {
			p["notificationUUID"] = bad
		}), "notification_uuid")
	}

	// Deliberately NOT version-4-pinned, unlike the token this server mints:
	// Apple promises a UUID and no particular version, so pinning one would
	// refuse every real delivery the day Apple's generator changed.
	v1 := "9f0b2e3a-1c4d-1e5f-ca9b-0c1d2e3f4a5b"
	if got := mustVerifyNotification(t, v, c.notify(t, tx, func(p map[string]any) {
		p["notificationUUID"] = v1
	})).UUID; got != v1 {
		t.Fatalf("non-v4 uuid: got %q", got)
	}
	if validAppAccountToken(v1) {
		t.Fatal("the account-token check must stay stricter than the notification one")
	}
}

// A notification with no `data` object cannot be matched against a configured
// app at all, so it is refused rather than recorded.
func TestAppleNotificationRequiresAnIdentifiableDataObject(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	tx := c.sign(t, applePayload())

	mustRejectNotification(t, v, c.sign(t, map[string]any{
		"notificationType": "TEST",
		"notificationUUID": testNotificationUUID,
		"version":          "2.0",
		"signedDate":       time.Now().UnixMilli(),
	}), "notification_data")

	mustRejectNotification(t, v, c.notify(t, tx, withAppleNotificationData(func(d map[string]any) {
		delete(d, "bundleId")
	})), "notification_bundle")

	// Oversized descriptive strings are refused before they reach the database.
	for _, field := range []string{"notificationType", "subtype", "version"} {
		mustRejectNotification(t, v, c.notify(t, tx, func(p map[string]any) {
			p[field] = strings.Repeat("x", appleMaxNotificationFieldLen+1)
		}), "notification_fields")
	}
	// A padded signedTransactionInfo is malformed, not untidy: normalizing it
	// would mean the bytes verified are not the bytes Apple signed in.
	mustRejectNotification(t, v, c.notify(t, " "+tx), "notification_transaction_info")
}

// A notification carrying no transaction is VERIFIED, not refused: there is
// nothing to derive an entitlement from, and the notification type is not
// permitted to supply one.
func TestAppleNotificationWithoutATransactionIsVerifiedNotRefused(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	n := mustVerifyNotification(t, v, c.notify(t, "", func(p map[string]any) {
		p["notificationType"] = "RENEWAL_EXTENSION"
	}))
	if n.HasTransaction || n.Supported {
		t.Fatalf("want no transaction, got hasTx=%v supported=%v", n.HasTransaction, n.Supported)
	}
	if n.Type != "RENEWAL_EXTENSION" {
		t.Fatalf("type: %q", n.Type)
	}
}

// Apple uses identity carriers other than `data` for several genuine V2
// notifications. They carry no subscription transaction, but the envelope is
// still ours only after the carrier's app identity is checked. Keep this in
// lockstep with Apple's official SignedDataVerifier fallback order.
func TestAppleNotificationVerifiesEveryOfficialIdentityCarrier(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	cases := []struct {
		name    string
		carrier string
		value   map[string]any
	}{
		{"summary", "summary", map[string]any{"bundleId": testBundleIOS, "environment": "Sandbox"}},
		{"external purchase token", "externalPurchaseToken", map[string]any{"bundleId": testBundleIOS, "externalPurchaseId": "SANDBOX-token"}},
		{"app data", "appData", map[string]any{"bundleId": testBundleIOS, "environment": "Sandbox"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			jws := c.notify(t, "", func(p map[string]any) {
				delete(p, "data")
				p[tc.carrier] = tc.value
			})
			n := mustVerifyNotification(t, v, jws)
			if n.HasTransaction || n.BundleID != testBundleIOS || n.Environment != appleEnvSandbox {
				t.Fatalf("unexpected verified projection: %+v", n)
			}

			bad := c.notify(t, "", func(p map[string]any) {
				delete(p, "data")
				copy := map[string]any{}
				for k, value := range tc.value {
					copy[k] = value
				}
				copy["bundleId"] = "com.other.app"
				p[tc.carrier] = copy
			})
			mustRejectNotification(t, v, bad, "bundle")
		})
	}
}

// A verified transaction of a kind this model does not represent is reported as
// UNSUPPORTED rather than refused. The two are different facts: one is "not
// from Apple", the other is "from Apple, about something we do not grant for".
func TestAppleNotificationReportsUnsupportedShapesWithoutRefusing(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	for _, mut := range []func(map[string]any){
		func(p map[string]any) { p["type"] = "Consumable" },
		func(p map[string]any) { p["type"] = "Non-Renewing Subscription" },
		func(p map[string]any) { p["inAppOwnershipType"] = "FAMILY_SHARED" },
	} {
		tx := c.sign(t, applePayload(mut))
		// The intake refuses it outright — that behaviour is unchanged.
		if _, err := v.Verify(tx, time.Now()); err == nil {
			t.Fatal("the intake must still refuse an unsupported shape")
		}
		n := mustVerifyNotification(t, v, c.notify(t, tx))
		if !n.HasTransaction {
			t.Fatal("the transaction verified, so it must be reported")
		}
		if n.Supported {
			t.Fatalf("want unsupported, got supported for %+v", n.Transaction)
		}
	}
}

// A transaction with no appAccountToken at all is verified for the notification
// path and still refused by the intake. A MALFORMED one is refused by both: an
// absent claim is not a broken claim.
func TestAppleNotificationToleratesAbsentAttributionButNotAMalformedOne(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	absent := c.sign(t, applePayload(func(p map[string]any) { delete(p, "appAccountToken") }))
	n := mustVerifyNotification(t, v, c.notify(t, absent))
	if !n.Supported || n.Transaction.AppAccountToken != "" {
		t.Fatalf("want a supported unattributed transaction, got %+v", n.Transaction)
	}
	// Unchanged for the submission path, whose whole ownership decision is the
	// token: same refusal, same fixed code as a malformed one.
	if _, err := v.Verify(absent, time.Now()); appleRejectionCode(err) != "app_account_token" {
		t.Fatalf("intake must refuse an unattributed transaction: %v", err)
	}

	malformed := c.sign(t, applePayload(func(p map[string]any) { p["appAccountToken"] = "nope" }))
	mustRejectNotification(t, v, c.notify(t, malformed), "app_account_token")
	if _, err := v.Verify(malformed, time.Now()); appleRejectionCode(err) != "app_account_token" {
		t.Fatalf("intake must refuse a malformed token: %v", err)
	}
}

// ── Bounds ───────────────────────────────────────────────────────────────────

// The two layers are bounded SEPARATELY. A shared bound would have to be the
// larger of the two, which would quietly hand a transaction submitter four
// times the parser exposure they need.
func TestAppleNotificationBoundsEachLayerSeparately(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	// The bounds really are different, and the envelope's is the larger.
	if appleMaxNotificationJWSBytes <= appleMaxJWSBytes {
		t.Fatalf("the envelope bound (%d) must exceed the transaction bound (%d)",
			appleMaxNotificationJWSBytes, appleMaxJWSBytes)
	}

	// An inner transaction over the TRANSACTION bound, inside an envelope
	// comfortably under its own. Only a separate inner bound catches this.
	fat := c.sign(t, applePayload(func(p map[string]any) {
		p["storefront"] = strings.Repeat("A", appleMaxJWSBytes)
	}))
	if len(fat) <= appleMaxJWSBytes {
		t.Fatalf("fixture too small: %d", len(fat))
	}
	envelope := c.notify(t, fat)
	if len(envelope) > appleMaxNotificationJWSBytes {
		t.Fatalf("fixture envelope %d exceeds its own bound %d", len(envelope), appleMaxNotificationJWSBytes)
	}
	mustRejectNotification(t, v, envelope, "jws_size")

	// And an envelope over its own bound.
	huge := c.notify(t, c.sign(t, applePayload()), func(p map[string]any) {
		p["subtype"] = ""
		p["padding"] = strings.Repeat("A", appleMaxNotificationJWSBytes)
	})
	if len(huge) <= appleMaxNotificationJWSBytes {
		t.Fatalf("fixture too small: %d", len(huge))
	}
	mustRejectNotification(t, v, huge, "jws_size")

	// A transaction that is comfortably inside its bound still verifies, so the
	// test above is measuring the bound rather than the fixture.
	mustVerifyNotification(t, v, c.notify(t, c.sign(t, applePayload())))
}

// An unconfigured deployment verifies nothing. The nil receiver is the shipping
// default, and it must refuse rather than panic or accept.
func TestAppleNotificationRequiresAConfiguredVerifier(t *testing.T) {
	c := newAppleTestChain(t)
	var absent *AppleTransactionVerifier
	if _, err := absent.VerifyNotification(c.notify(t, c.sign(t, applePayload())), time.Now()); appleRejectionCode(err) != "verifier_absent" {
		t.Fatalf("want verifier_absent, got %v", err)
	}
}

// A refusal may not quote what it refused. A log line outlives the request that
// made it, and these lines are written for every rejected delivery.
func TestAppleNotificationErrorsCarryNoMaterial(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	foreign := newAppleTestChain(t)

	secretToken := "11111111-2222-4333-8444-555555555555"
	tx := foreign.sign(t, applePayload(func(p map[string]any) { p["appAccountToken"] = secretToken }))
	jws := c.notify(t, tx)

	_, err := v.VerifyNotification(jws, time.Now())
	if err == nil {
		t.Fatal("expected a refusal")
	}
	msg := err.Error()
	for _, secret := range []string{
		jws, tx, secretToken, testNotificationUUID,
		c.x5c()[0], foreign.x5c()[0], "com.relayium",
	} {
		if strings.Contains(msg, secret) {
			t.Fatalf("rejection message leaked material: %q", msg)
		}
	}
	// And the code that IS logged is a fixed token from the closed set.
	if code := appleRejectionCode(err); code == "" || strings.ContainsAny(code, " \t\n\"") {
		t.Fatalf("rejection code is not a fixed token: %q", code)
	}
}
