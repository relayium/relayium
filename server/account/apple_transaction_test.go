package account

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

// The App Store transaction trust boundary, at the verifier level.
//
// Everything here builds its OWN root, intermediate and leaf and signs its own
// payloads: no Apple certificate, key or network call is involved, and no
// production trust root is seeded. That is the point of the injection — the
// adversarial cases below (a foreign root, a substituted algorithm, a
// re-signed payload, an out-of-window certificate) cannot be produced against
// a hard-wired root at all.

const (
	testBundleIOS = "com.relayium.app"
	testBundleMac = "com.relayium.mac"
	// A syntactically valid RFC 4122 v4 UUID; the account it belongs to is
	// decided by the store, never by the payload.
	testAppAccountToken = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
)

// appleTestChain is a throwaway Apple-shaped signing chain: a self-signed root,
// an intermediate it issued, and a digital-signature leaf the intermediate
// issued.
type appleTestChain struct {
	rootPEM  []byte
	rootKey  *ecdsa.PrivateKey
	rootDER  []byte
	interKey *ecdsa.PrivateKey
	interDER []byte
	leafKey  *ecdsa.PrivateKey
	leafDER  []byte
}

type certOpts struct {
	notBefore, notAfter time.Time
	keyUsage            x509.KeyUsage
	isCA                bool
	curve               elliptic.Curve
	// Marker extensions. nil uses Apple's real OID for that position; an
	// explicit empty slice omits the marker entirely, and any other value puts a
	// different OID there — the two ways a chain can be well-formed and still not
	// be an Apple transaction-signing chain.
	leafMarker  []asn1.ObjectIdentifier
	interMarker []asn1.ObjectIdentifier
}

// appleMarkerExtensions renders the marker extension for a position. Apple's
// markers carry an ASN.1 NULL body; only the OID is meaningful.
func appleMarkerExtensions(configured []asn1.ObjectIdentifier, fallback asn1.ObjectIdentifier) []pkix.Extension {
	oids := configured
	if oids == nil {
		oids = []asn1.ObjectIdentifier{fallback}
	}
	exts := make([]pkix.Extension, 0, len(oids))
	for _, oid := range oids {
		exts = append(exts, pkix.Extension{Id: oid, Value: []byte{0x05, 0x00}})
	}
	return exts
}

func newAppleTestChain(t *testing.T) *appleTestChain {
	t.Helper()
	return newAppleTestChainWithLeaf(t, certOpts{})
}

// newAppleTestChainWithLeaf builds a chain whose LEAF can be bent — a validity
// window outside the verification time, the wrong key usage, a CA leaf, the
// wrong curve — while root and intermediate stay ordinary.
func newAppleTestChainWithLeaf(t *testing.T, leaf certOpts) *appleTestChain {
	t.Helper()
	now := time.Now()
	if leaf.notBefore.IsZero() {
		leaf.notBefore = now.Add(-time.Hour)
	}
	if leaf.notAfter.IsZero() {
		leaf.notAfter = now.Add(24 * time.Hour)
	}
	if leaf.keyUsage == 0 {
		leaf.keyUsage = x509.KeyUsageDigitalSignature
	}
	if leaf.curve == nil {
		leaf.curve = elliptic.P256()
	}

	// Root and intermediate span both the leaf's window and the present, so a
	// test that moves the LEAF's validity is testing the leaf rather than
	// accidentally invalidating its issuers too.
	caBefore, caAfter := now.Add(-2*time.Hour), now.Add(48*time.Hour)
	if leaf.notBefore.Before(caBefore) {
		caBefore = leaf.notBefore.Add(-2 * time.Hour)
	}
	if leaf.notAfter.After(caAfter) {
		caAfter = leaf.notAfter.Add(48 * time.Hour)
	}

	rootKey := mustECKey(t, elliptic.P256())
	rootDER := mustCert(t, &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Apple Root CA"},
		NotBefore:             caBefore,
		NotAfter:              caAfter,
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}, nil, &rootKey.PublicKey, rootKey)
	root := mustParse(t, rootDER)

	interKey := mustECKey(t, elliptic.P256())
	interDER := mustCert(t, &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "Test Apple WWDR Intermediate"},
		NotBefore:             caBefore,
		NotAfter:              caAfter,
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		ExtraExtensions:       appleMarkerExtensions(leaf.interMarker, appleWWDRIntermediateOID),
	}, root, &interKey.PublicKey, rootKey)
	inter := mustParse(t, interDER)

	leafKey := mustECKey(t, leaf.curve)
	leafDER := mustCert(t, &x509.Certificate{
		SerialNumber:          big.NewInt(3),
		Subject:               pkix.Name{CommonName: "Test Apple Transaction Signing"},
		NotBefore:             leaf.notBefore,
		NotAfter:              leaf.notAfter,
		IsCA:                  leaf.isCA,
		KeyUsage:              leaf.keyUsage,
		BasicConstraintsValid: true,
		ExtraExtensions:       appleMarkerExtensions(leaf.leafMarker, appleReceiptSigningOID),
	}, inter, &leafKey.PublicKey, interKey)

	return &appleTestChain{
		rootPEM:  pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER}),
		rootKey:  rootKey,
		rootDER:  rootDER,
		interKey: interKey,
		interDER: interDER,
		leafKey:  leafKey,
		leafDER:  leafDER,
	}
}

func mustECKey(t *testing.T, curve elliptic.Curve) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return k
}

func mustCert(t *testing.T, tmpl, parent *x509.Certificate, pub *ecdsa.PublicKey, signer *ecdsa.PrivateKey) []byte {
	t.Helper()
	if parent == nil {
		parent = tmpl
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, pub, signer)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	return der
}

func mustParse(t *testing.T, der []byte) *x509.Certificate {
	t.Helper()
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	return c
}

// x5c is the header chain Apple sends: leaf, intermediate, root.
func (c *appleTestChain) x5c() []string {
	return []string{
		base64.StdEncoding.EncodeToString(c.leafDER),
		base64.StdEncoding.EncodeToString(c.interDER),
		base64.StdEncoding.EncodeToString(c.rootDER),
	}
}

func (c *appleTestChain) header() map[string]any {
	return map[string]any{"alg": "ES256", "x5c": c.x5c()}
}

// sign produces the compact JWS a client would submit.
func (c *appleTestChain) sign(t *testing.T, payload map[string]any) string {
	t.Helper()
	return c.signWith(t, c.leafKey, c.header(), payload)
}

func (c *appleTestChain) signWith(t *testing.T, key *ecdsa.PrivateKey, header, payload map[string]any) string {
	t.Helper()
	return signAppleJWSRaw(t, key, mustJSON(t, header), mustJSON(t, payload))
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

// signAppleJWSRaw signs arbitrary header/payload BYTES, so a test can hand the
// verifier JSON that json.Marshal would never produce (duplicate keys, trailing
// content, a float where a millisecond timestamp belongs).
func signAppleJWSRaw(t *testing.T, key *ecdsa.PrivateKey, headerJSON, payloadJSON []byte) string {
	t.Helper()
	h := base64.RawURLEncoding.EncodeToString(headerJSON)
	p := base64.RawURLEncoding.EncodeToString(payloadJSON)
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(rawECDSASignature(t, key, h+"."+p))
}

// rawECDSASignature is the JWS ES256 form: r‖s, each left-padded to the curve's
// byte size. Deliberately NOT the ASN.1 form crypto/ecdsa.SignASN1 emits — a
// verifier that accepts both has a second parser an attacker can aim at.
func rawECDSASignature(t *testing.T, key *ecdsa.PrivateKey, signingInput string) []byte {
	t.Helper()
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	size := (key.Curve.Params().BitSize + 7) / 8
	sig := make([]byte, 2*size)
	r.FillBytes(sig[:size])
	s.FillBytes(sig[size:])
	return sig
}

// applePayload is a well-formed auto-renewable subscription transaction.
func applePayload(mut ...func(map[string]any)) map[string]any {
	now := time.Now().UnixMilli()
	p := map[string]any{
		"transactionId":         "2000000000000001",
		"originalTransactionId": "2000000000000001",
		"webOrderLineItemId":    "1000000000000001",
		"bundleId":              testBundleIOS,
		"productId":             "com.relayium.app.pro.monthly",
		"type":                  "Auto-Renewable Subscription",
		"inAppOwnershipType":    "PURCHASED",
		"environment":           "Sandbox",
		"appAccountToken":       testAppAccountToken,
		"purchaseDate":          now - 1000,
		"originalPurchaseDate":  now - 1000,
		"expiresDate":           now + 30*24*60*60*1000,
		"signedDate":            now,
		"quantity":              1,
		"storefront":            "USA",
	}
	for _, m := range mut {
		m(p)
	}
	return p
}

// testVerifier is the sandbox verifier the chain's own root anchors.
func testVerifier(t *testing.T, c *appleTestChain) *AppleTransactionVerifier {
	t.Helper()
	v, err := NewAppleTransactionVerifier(AppleStoreConfig{
		Environment:  appleEnvSandbox,
		Apps:         []AppleAppConfig{{BundleID: testBundleIOS}, {BundleID: testBundleMac}},
		RootCertsPEM: c.rootPEM,
	})
	if err != nil {
		t.Fatalf("NewAppleTransactionVerifier: %v", err)
	}
	return v
}

// ── The one accepting case ───────────────────────────────────────────────────

func TestAppleVerifierAcceptsValidChainAndJWS(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	expires := time.Now().Add(30 * 24 * time.Hour).UnixMilli()
	jws := c.sign(t, applePayload(func(p map[string]any) { p["expiresDate"] = expires }))

	tx, err := v.Verify(jws, time.Now())
	if err != nil {
		t.Fatalf("valid transaction rejected: %v", err)
	}
	if tx.BundleID != testBundleIOS || tx.ProductID != "com.relayium.app.pro.monthly" {
		t.Fatalf("wrong identity: %+v", tx)
	}
	if tx.OriginalTransactionID != "2000000000000001" || tx.TransactionID != "2000000000000001" {
		t.Fatalf("wrong ids: %+v", tx)
	}
	if tx.AppAccountToken != testAppAccountToken {
		t.Fatalf("wrong app account token: %q", tx.AppAccountToken)
	}
	if tx.ExpiresDateMS != expires {
		t.Fatalf("expiresDate = %d, want %d", tx.ExpiresDateMS, expires)
	}
	if tx.RevocationDateMS != 0 {
		t.Fatalf("invented a revocation: %d", tx.RevocationDateMS)
	}
	if tx.Environment != appleEnvSandbox {
		t.Fatalf("environment = %q", tx.Environment)
	}
}

// The macOS and iOS apps are separate bundles; a verifier configured for both
// must keep them apart rather than merging them into one app.
func TestAppleVerifierKeepsBundlesDistinct(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	tx, err := v.Verify(c.sign(t, applePayload(func(p map[string]any) {
		p["bundleId"] = testBundleMac
		p["productId"] = "com.relayium.mac.pro.monthly"
	})), time.Now())
	if err != nil {
		t.Fatalf("macOS bundle rejected: %v", err)
	}
	if tx.BundleID != testBundleMac {
		t.Fatalf("bundle identity lost: %q", tx.BundleID)
	}
}

// ── Cryptographic rejection ──────────────────────────────────────────────────

func TestAppleVerifierRejectsForeignRoot(t *testing.T) {
	ours := newAppleTestChain(t)
	theirs := newAppleTestChain(t) // a complete, internally consistent chain
	v := testVerifier(t, ours)

	// The attacker's whole chain, root included, presented in x5c. Accepting the
	// header's own root is the classic x5c mistake: it makes the chain
	// self-asserting and the trust store decorative.
	jws := theirs.sign(t, applePayload())
	if _, err := v.Verify(jws, time.Now()); err == nil {
		t.Fatal("a self-rooted foreign chain was accepted")
	}
}

// A leaf that really is ours, with a signature made by a key that is not its
// own. The chain builds; only the signature check can catch this.
func TestAppleVerifierRejectsWrongSigner(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	other := mustECKey(t, elliptic.P256())
	jws := c.signWith(t, other, c.header(), applePayload())
	if _, err := v.Verify(jws, time.Now()); err == nil {
		t.Fatal("a payload signed by a foreign key was accepted")
	}
}

func TestAppleVerifierRejectsAlgorithmSubstitution(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	for _, alg := range []any{"none", "HS256", "ES384", "RS256", "es256", "", nil, 256} {
		hdr := c.header()
		if alg == nil {
			delete(hdr, "alg")
		} else {
			hdr["alg"] = alg
		}
		jws := c.signWith(t, c.leafKey, hdr, applePayload())
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("alg %v was accepted", alg)
		}
	}
}

// The signature is r‖s over the curve size. An ASN.1 DER signature is a
// different encoding of the same numbers, and accepting it would mean the
// verifier is guessing at encodings.
func TestAppleVerifierRejectsMalformedSignature(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	hdr := base64.RawURLEncoding.EncodeToString(mustJSON(t, c.header()))
	pay := base64.RawURLEncoding.EncodeToString(mustJSON(t, applePayload()))
	good := rawECDSASignature(t, c.leafKey, hdr+"."+pay)

	digest := sha256.Sum256([]byte(hdr + "." + pay))
	der, err := ecdsa.SignASN1(rand.Reader, c.leafKey, digest[:])
	if err != nil {
		t.Fatal(err)
	}

	// zeropadded is the case the length check alone catches: r and s are
	// UNCHANGED, merely left-padded, so a verifier that split on the midpoint of
	// whatever it was given would recover the same two numbers and accept a
	// second encoding of one signature.
	zeropadded := append(append(append([]byte{}, good[:32]...), 0, 0), good[32:]...)

	for name, sig := range map[string][]byte{
		"asn1":       der,
		"short":      good[:len(good)-1],
		"long":       append(append([]byte{}, good...), 0),
		"empty":      {},
		"zeroed":     make([]byte, 64),
		"flipped":    flipLastBit(good),
		"halfonly":   good[:32],
		"zeropadded": zeropadded,
	} {
		jws := hdr + "." + pay + "." + base64.RawURLEncoding.EncodeToString(sig)
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("%s signature was accepted", name)
		}
	}
}

func flipLastBit(b []byte) []byte {
	out := append([]byte{}, b...)
	out[len(out)-1] ^= 1
	return out
}

// Compact serialization is exactly three canonical base64url segments. Padding,
// a fourth segment, an empty segment and whitespace are all somebody else's
// encoding.
func TestAppleVerifierRejectsNonCanonicalCompactForm(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	good := c.sign(t, applePayload())
	parts := strings.Split(good, ".")

	for name, jws := range map[string]string{
		"empty":            "",
		"one segment":      parts[0],
		"two segments":     parts[0] + "." + parts[1],
		"four segments":    good + "." + parts[2],
		"empty header":     "." + parts[1] + "." + parts[2],
		"empty payload":    parts[0] + ".." + parts[2],
		"empty signature":  parts[0] + "." + parts[1] + ".",
		"trailing dot":     good + ".",
		"leading space":    " " + good,
		"inner space":      parts[0] + ". " + parts[1] + "." + parts[2],
		"padded payload":   parts[0] + "." + parts[1] + "=." + parts[2],
		"non-base64 alpha": parts[0] + "." + parts[1] + "!." + parts[2],
	} {
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

// Segment decoding is the boundary between "the bytes Apple signed" and "some
// other bytes that decode to the same thing". Only one spelling of a segment is
// its own: padding, the standard alphabet and non-zero trailing bits are all
// alternative encodings, and a verifier that accepts them verifies a signature
// over material it did not reproduce.
func TestAppleCanonicalBase64Segment(t *testing.T) {
	raw := []byte{0x01, 0x02, 0x03, 0xfb, 0xff} // 5 bytes: 7 chars, 2 spare bits
	canonical := base64.RawURLEncoding.EncodeToString(raw)
	got, err := decodeCanonicalB64URL(canonical)
	if err != nil || string(got) != string(raw) {
		t.Fatalf("canonical segment rejected: %v", err)
	}

	// The same five bytes re-encoded with the standard alphabet: 0xfb produces a
	// '+'/'/' pair there and '-'/'_' here.
	std := base64.StdEncoding.WithPadding(base64.NoPadding).EncodeToString(raw)
	if std == canonical {
		t.Fatal("fixture no longer distinguishes the two alphabets")
	}
	// Flipping the last character's low bit leaves bits set that the decoded
	// bytes do not contain — a second spelling of the same five bytes.
	alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, canonical[len(canonical)-1])
	if last < 0 {
		t.Fatal("fixture is not base64url")
	}
	nonCanonical := canonical[:len(canonical)-1] + string(alphabet[last^1])

	for name, seg := range map[string]string{
		"empty":         "",
		"padded":        base64.URLEncoding.EncodeToString(raw),
		"standard":      std,
		"non-canonical": nonCanonical,
		"whitespace":    " " + canonical,
		"invalid char":  canonical[:len(canonical)-1] + "!",
	} {
		if _, err := decodeCanonicalB64URL(seg); err == nil {
			t.Fatalf("%s segment was accepted", name)
		}
	}
}

func TestAppleVerifierRejectsMalformedHeaderAndX5C(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	payload := mustJSON(t, applePayload())

	rawHeaders := map[string][]byte{
		"not json":         []byte("nope"),
		"not an object":    []byte(`["ES256"]`),
		"trailing json":    append(mustJSON(t, c.header()), '{', '}'),
		"duplicate alg":    []byte(`{"alg":"ES256","alg":"none","x5c":["` + c.x5c()[0] + `"]}`),
		"duplicate x5c":    []byte(`{"alg":"ES256","x5c":[],"x5c":` + string(mustJSON(t, c.x5c())) + `}`),
		"x5c not an array": []byte(`{"alg":"ES256","x5c":"` + c.x5c()[0] + `"}`),
	}
	for name, hdr := range rawHeaders {
		jws := signAppleJWSRaw(t, c.leafKey, hdr, payload)
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("header %q was accepted", name)
		}
	}

	junk := make([]string, 0, 8)
	junk = append(junk, "not base64!!")
	junk = append(junk, base64.StdEncoding.EncodeToString([]byte("not a certificate")))
	for name, x5c := range map[string][]string{
		"empty chain":          {},
		"leaf only":            {c.x5c()[0]},
		"unbounded":            repeatStr(c.x5c()[0], 32),
		"junk encoding":        {junk[0], c.x5c()[1], c.x5c()[2]},
		"junk der":             {junk[1], c.x5c()[1], c.x5c()[2]},
		"reordered":            {c.x5c()[2], c.x5c()[1], c.x5c()[0]},
		"missing intermediate": {c.x5c()[0], c.x5c()[2]},
	} {
		hdr := map[string]any{"alg": "ES256", "x5c": x5c}
		jws := c.signWith(t, c.leafKey, hdr, applePayload())
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("x5c %q was accepted", name)
		}
	}
}

func repeatStr(s string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = s
	}
	return out
}

// Certificate validity is checked at the PAYLOAD'S OWN signedDate, which is
// what Apple's offline SignedDataVerifier does — and it has to be: StoreKit
// restores present transactions Apple signed years ago, and Apple's signing
// certificate rotates. Validating those at receipt time would refuse every
// historical purchase the day its signing certificate expired.
func TestAppleVerifierValidatesTheChainAtSignedDate(t *testing.T) {
	now := time.Now()
	// A certificate that was valid two days ago and is expired NOW, signing a
	// transaction from when it was valid: the restored-purchase case.
	historical := newAppleTestChainWithLeaf(t, certOpts{
		notBefore: now.Add(-72 * time.Hour), notAfter: now.Add(-24 * time.Hour),
	})
	signedAt := now.Add(-48 * time.Hour)
	jws := historical.sign(t, applePayload(func(p map[string]any) {
		p["signedDate"] = signedAt.UnixMilli()
	}))
	tx, err := testVerifier(t, historical).Verify(jws, now)
	if err != nil {
		t.Fatalf("a historical transaction was refused at receipt time: %v", err)
	}
	if tx.SignedDateMS != signedAt.UnixMilli() {
		t.Fatalf("signedDate = %d, want %d", tx.SignedDateMS, signedAt.UnixMilli())
	}

	// The same chain, with a signedDate outside the leaf's window at BOTH ends.
	for name, when := range map[string]time.Time{
		"before notBefore": now.Add(-96 * time.Hour),
		"after notAfter":   now.Add(-time.Hour),
	} {
		bad := historical.sign(t, applePayload(func(p map[string]any) {
			p["signedDate"] = when.UnixMilli()
		}))
		if _, err := testVerifier(t, historical).Verify(bad, now); err == nil {
			t.Fatalf("a signedDate %s the leaf's validity window was accepted", name)
		}
	}
}

// signedDate is read out of an untrusted payload to choose that validation
// time, so it is bounded on both sides before it is used: a future value would
// pick a moment at which an expiry has not yet happened.
func TestAppleVerifierRejectsUnusableSignedDate(t *testing.T) {
	now := time.Now()
	c := newAppleTestChainWithLeaf(t, certOpts{
		notBefore: now.Add(-time.Hour), notAfter: now.Add(365 * 24 * time.Hour),
	})
	v := testVerifier(t, c)

	for name, mut := range map[string]func(map[string]any){
		"absent":       func(p map[string]any) { delete(p, "signedDate") },
		"zero":         func(p map[string]any) { p["signedDate"] = 0 },
		"negative":     func(p map[string]any) { p["signedDate"] = -1 },
		"overflowing":  func(p map[string]any) { p["signedDate"] = json.Number("92233720368547758070") },
		"out of range": func(p map[string]any) { p["signedDate"] = json.Number("253402300800001") },
		"fractional":   func(p map[string]any) { p["signedDate"] = json.Number("1.5") },
		"far future":   func(p map[string]any) { p["signedDate"] = now.Add(48 * time.Hour).UnixMilli() },
	} {
		if _, err := v.Verify(c.sign(t, applePayload(mut)), now); err == nil {
			t.Fatalf("signedDate %q was accepted", name)
		}
	}
	// Ordinary clock drift between Apple's signer and this host is not a forgery.
	inSkew := c.sign(t, applePayload(func(p map[string]any) {
		p["signedDate"] = now.Add(time.Minute).UnixMilli()
	}))
	if _, err := v.Verify(inSkew, now); err != nil {
		t.Fatalf("a signedDate one minute ahead was refused: %v", err)
	}
}

// The chain is Apple's exact shape: three certificates, an Apple
// transaction-signing leaf, an Apple WWDR intermediate. Path validation alone
// would accept any leaf issued under the same root, which is why Apple's own
// ChainVerifier checks these markers and so does this one.
func TestAppleVerifierRequiresAppleChainShapeAndMarkers(t *testing.T) {
	now := time.Now()
	good := newAppleTestChain(t)

	// Two and four certificates: neither is the shape Apple sends.
	for name, x5c := range map[string][]string{
		"two certificates":  {good.x5c()[0], good.x5c()[1]},
		"four certificates": {good.x5c()[0], good.x5c()[1], good.x5c()[2], good.x5c()[2]},
	} {
		jws := good.signWith(t, good.leafKey, map[string]any{"alg": "ES256", "x5c": x5c}, applePayload())
		if _, err := testVerifier(t, good).Verify(jws, now); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}

	// A chain that path-validates perfectly and carries the wrong markers.
	other := asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 6, 1, 2}
	for name, opts := range map[string]certOpts{
		"no leaf marker":         {leafMarker: []asn1.ObjectIdentifier{}},
		"no intermediate marker": {interMarker: []asn1.ObjectIdentifier{}},
		"foreign leaf marker":    {leafMarker: []asn1.ObjectIdentifier{other}},
		"foreign intermediate":   {interMarker: []asn1.ObjectIdentifier{other}},
		"markers swapped": {
			leafMarker:  []asn1.ObjectIdentifier{appleWWDRIntermediateOID},
			interMarker: []asn1.ObjectIdentifier{appleReceiptSigningOID},
		},
	} {
		chain := newAppleTestChainWithLeaf(t, opts)
		if _, err := testVerifier(t, chain).Verify(chain.sign(t, applePayload()), now); err == nil {
			t.Fatalf("a chain with %s was accepted", name)
		}
	}

	// The unmodified chain still verifies, so the refusals above are the markers
	// and the count rather than something incidental about the fixture.
	if _, err := testVerifier(t, good).Verify(good.sign(t, applePayload()), now); err != nil {
		t.Fatalf("the reference chain failed: %v", err)
	}
}

// The marker check is positional, and path building is free to ignore
// certificates it was offered. Those two facts combine into a hole: put a
// marked DECOY at x5c[1] and the real issuing intermediate at x5c[2], and a
// verifier that only asks "do the markers sit in the right slots" and "does
// some path exist" is answering about two different chains. The decoy is never
// used, the real path runs leaf → x5c[2] → a configured root that was never in
// the header at all, and both the positional marker check and the announced
// three-certificate shape become decorative.
//
// The submitted chain must therefore BE the validated chain.
func TestAppleVerifierRejectsAMarkedButUnusedDecoyIntermediate(t *testing.T) {
	now := time.Now()
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	// A CA nobody issued anything with, carrying the WWDR marker so it satisfies
	// a positional check, and self-signed so it cannot be part of any real path.
	decoyKey := mustECKey(t, elliptic.P256())
	decoyDER := mustCert(t, &x509.Certificate{
		SerialNumber:          big.NewInt(99),
		Subject:               pkix.Name{CommonName: "Decoy WWDR Intermediate"},
		NotBefore:             now.Add(-2 * time.Hour),
		NotAfter:              now.Add(48 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		ExtraExtensions:       appleMarkerExtensions(nil, appleWWDRIntermediateOID),
	}, nil, &decoyKey.PublicKey, decoyKey)
	decoy := base64.StdEncoding.EncodeToString(decoyDER)

	// [genuine leaf, marked decoy, the intermediate that actually issued the
	// leaf]. The configured root completes the path and is absent from x5c.
	smuggled := c.signWith(t, c.leafKey, map[string]any{
		"alg": "ES256",
		"x5c": []string{c.x5c()[0], decoy, c.x5c()[1]},
	}, applePayload())
	if _, err := v.Verify(smuggled, now); err == nil {
		t.Fatal("a marked decoy at x5c[1] was accepted while the path ran through x5c[2]")
	}

	// The same shape without the marker, to show the refusal is the chain
	// identity rather than only the marker: real leaf, real intermediate, and a
	// third element that is not the root the path terminates at.
	wrongAnchor := c.signWith(t, c.leafKey, map[string]any{
		"alg": "ES256",
		"x5c": []string{c.x5c()[0], c.x5c()[1], decoy},
	}, applePayload())
	if _, err := v.Verify(wrongAnchor, now); err == nil {
		t.Fatal("a chain whose x5c[2] is not the anchor it validated to was accepted")
	}

	// And the honest [leaf, intermediate, root] still verifies.
	if _, err := v.Verify(c.sign(t, applePayload()), now); err != nil {
		t.Fatalf("the reference chain failed: %v", err)
	}
}

func TestAppleVerifierRejectsInappropriateLeaf(t *testing.T) {
	now := time.Now()
	noSigning := newAppleTestChainWithLeaf(t, certOpts{keyUsage: x509.KeyUsageKeyEncipherment})
	if _, err := testVerifier(t, noSigning).Verify(noSigning.sign(t, applePayload()), now); err == nil {
		t.Fatal("a leaf with no digitalSignature key usage was accepted")
	}
	caLeaf := newAppleTestChainWithLeaf(t, certOpts{
		isCA: true, keyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
	})
	if _, err := testVerifier(t, caLeaf).Verify(caLeaf.sign(t, applePayload()), now); err == nil {
		t.Fatal("a CA certificate was accepted as a transaction signer")
	}
	wrongCurve := newAppleTestChainWithLeaf(t, certOpts{curve: elliptic.P384()})
	if _, err := testVerifier(t, wrongCurve).Verify(wrongCurve.sign(t, applePayload()), now); err == nil {
		t.Fatal("a P-384 leaf was accepted for ES256")
	}
}

// ── Payload rejection (only reached after the signature verifies) ────────────

func TestAppleVerifierRejectsMalformedPayload(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	header := mustJSON(t, c.header())
	good := mustJSON(t, applePayload())

	for name, raw := range map[string][]byte{
		"not json":      []byte("nope"),
		"not an object": []byte(`"transaction"`),
		"trailing json": append(append([]byte{}, good...), []byte(`{"bundleId":"com.evil"}`)...),
		"trailing junk": append(append([]byte{}, good...), 'x'),
		"duplicate bundle": []byte(`{"bundleId":"` + testBundleIOS + `","bundleId":"com.evil",` +
			`"productId":"p","transactionId":"1","originalTransactionId":"1","type":"Auto-Renewable Subscription",` +
			`"environment":"Sandbox","appAccountToken":"` + testAppAccountToken + `","purchaseDate":1,"expiresDate":99999999999}`),
		"duplicate expiry": []byte(`{"bundleId":"` + testBundleIOS + `","productId":"p","transactionId":"1",` +
			`"originalTransactionId":"1","type":"Auto-Renewable Subscription","environment":"Sandbox",` +
			`"appAccountToken":"` + testAppAccountToken + `","purchaseDate":1,"expiresDate":1,"expiresDate":99999999999}`),
	} {
		jws := signAppleJWSRaw(t, c.leafKey, header, raw)
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("payload %q was accepted", name)
		}
	}
}

func TestAppleVerifierRejectsImpossibleTimestamps(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	header := mustJSON(t, c.header())

	for name, mut := range map[string]func(map[string]any){
		"negative purchase":   func(p map[string]any) { p["purchaseDate"] = -1 },
		"negative expiry":     func(p map[string]any) { p["expiresDate"] = -1 },
		"zero purchase":       func(p map[string]any) { p["purchaseDate"] = 0 },
		"missing expiry":      func(p map[string]any) { delete(p, "expiresDate") },
		"missing purchase":    func(p map[string]any) { delete(p, "purchaseDate") },
		"overflowing expiry":  func(p map[string]any) { p["expiresDate"] = json.Number("9223372036854775807") },
		"overflowing beyond":  func(p map[string]any) { p["expiresDate"] = json.Number("92233720368547758070") },
		"negative revocation": func(p map[string]any) { p["revocationDate"] = -5 },
	} {
		jws := signAppleJWSRaw(t, c.leafKey, header, mustJSON(t, applePayload(mut)))
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("timestamp case %q was accepted", name)
		}
	}
	// A fractional millisecond is not an Apple timestamp either; it cannot be
	// produced through json.Marshal of an int, so it is written raw.
	raw := []byte(`{"bundleId":"` + testBundleIOS + `","productId":"p","transactionId":"1","originalTransactionId":"1",` +
		`"type":"Auto-Renewable Subscription","environment":"Sandbox","appAccountToken":"` + testAppAccountToken + `",` +
		`"purchaseDate":1.5,"expiresDate":99999999999}`)
	if _, err := v.Verify(signAppleJWSRaw(t, c.leafKey, header, raw), time.Now()); err == nil {
		t.Fatal("a fractional millisecond timestamp was accepted")
	}
}

func TestAppleVerifierRejectsMissingIdentity(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	for name, mut := range map[string]func(map[string]any){
		"no transaction id":          func(p map[string]any) { delete(p, "transactionId") },
		"no original transaction id": func(p map[string]any) { delete(p, "originalTransactionId") },
		"no product id":              func(p map[string]any) { delete(p, "productId") },
		"no bundle id":               func(p map[string]any) { delete(p, "bundleId") },
		"no type":                    func(p map[string]any) { delete(p, "type") },
		"consumable":                 func(p map[string]any) { p["type"] = "Consumable" },
		"family shared":              func(p map[string]any) { p["inAppOwnershipType"] = "FAMILY_SHARED" },
		// Absence is a refusal too: this intake does not model Family Sharing, and
		// "no ownership type" is exactly where a default of PURCHASED would grant
		// one.
		"no ownership type":  func(p map[string]any) { delete(p, "inAppOwnershipType") },
		"blank ownership":    func(p map[string]any) { p["inAppOwnershipType"] = "" },
		"lowercase purchase": func(p map[string]any) { p["inAppOwnershipType"] = "purchased" },
		"absurd id":          func(p map[string]any) { p["originalTransactionId"] = strings.Repeat("9", 4096) },
	} {
		if _, err := v.Verify(c.sign(t, applePayload(mut)), time.Now()); err == nil {
			t.Fatalf("payload %q was accepted", name)
		}
	}
}

func TestAppleVerifierRejectsMissingOrMalformedAccountToken(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)
	for name, mut := range map[string]func(map[string]any){
		"absent":     func(p map[string]any) { delete(p, "appAccountToken") },
		"empty":      func(p map[string]any) { p["appAccountToken"] = "" },
		"not a uuid": func(p map[string]any) { p["appAccountToken"] = "not-a-uuid" },
		"v1 uuid":    func(p map[string]any) { p["appAccountToken"] = "3f2504e0-4f89-11d3-9a0c-0305e82c3301" },
		"padded":     func(p map[string]any) { p["appAccountToken"] = " " + testAppAccountToken + " " },
	} {
		if _, err := v.Verify(c.sign(t, applePayload(mut)), time.Now()); err == nil {
			t.Fatalf("app account token %q was accepted", name)
		}
	}
	// Apple's UUIDs may arrive upper-case; the same identifier must resolve.
	up := c.sign(t, applePayload(func(p map[string]any) {
		p["appAccountToken"] = strings.ToUpper(testAppAccountToken)
	}))
	tx, err := v.Verify(up, time.Now())
	if err != nil {
		t.Fatalf("an upper-case UUID was rejected: %v", err)
	}
	if tx.AppAccountToken != testAppAccountToken {
		t.Fatalf("token not normalized: %q", tx.AppAccountToken)
	}
}

// isUpgraded is optional in Apple's payload, so absence is the documented
// false. Anything that is present but not a boolean is a refusal rather than a
// truthiness guess — this flag decides whether a transaction still grants.
func TestAppleVerifierParsesIsUpgradedStrictly(t *testing.T) {
	c := newAppleTestChain(t)
	v := testVerifier(t, c)

	absent, err := v.Verify(c.sign(t, applePayload()), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if absent.IsUpgraded {
		t.Fatal("an absent isUpgraded became true")
	}
	explicit, err := v.Verify(c.sign(t, applePayload(func(p map[string]any) { p["isUpgraded"] = true })), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !explicit.IsUpgraded {
		t.Fatal("isUpgraded=true was lost")
	}
	if got, err := v.Verify(c.sign(t, applePayload(func(p map[string]any) { p["isUpgraded"] = false })), time.Now()); err != nil || got.IsUpgraded {
		t.Fatalf("isUpgraded=false: %+v err=%v", got.IsUpgraded, err)
	}
	// `null` is the one that has to be spelled out: it is a PRESENT value of the
	// wrong type, and the obvious *bool decode turns it into the same nil an
	// absent field produces — silently reading "not a boolean" as false.
	for _, bad := range []any{nil, "true", "false", 1, 0, []any{true}, map[string]any{}} {
		jws := c.sign(t, applePayload(func(p map[string]any) { p["isUpgraded"] = bad }))
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("isUpgraded=%v (%T) was accepted", bad, bad)
		}
	}
}

// ── Server-configured identity ───────────────────────────────────────────────

func TestAppleVerifierEnforcesConfiguredEnvironment(t *testing.T) {
	c := newAppleTestChain(t)
	sandbox := testVerifier(t, c)
	for _, env := range []any{"Production", "", "sandbox", "SANDBOX", "Xcode", nil} {
		jws := c.sign(t, applePayload(func(p map[string]any) {
			if env == nil {
				delete(p, "environment")
				return
			}
			p["environment"] = env
		}))
		if _, err := sandbox.Verify(jws, time.Now()); err == nil {
			t.Fatalf("environment %v was accepted by a Sandbox verifier", env)
		}
	}

	prod, err := NewAppleTransactionVerifier(AppleStoreConfig{
		Environment:  appleEnvProduction,
		Apps:         []AppleAppConfig{{BundleID: testBundleIOS, AppAppleID: 6791918822}},
		RootCertsPEM: c.rootPEM,
	})
	if err != nil {
		t.Fatalf("production verifier: %v", err)
	}
	if _, err := prod.Verify(c.sign(t, applePayload()), time.Now()); err == nil {
		t.Fatal("a Sandbox transaction was accepted by a Production verifier")
	}
	if _, err := prod.Verify(c.sign(t, applePayload(func(p map[string]any) {
		p["environment"] = appleEnvProduction
	})), time.Now()); err != nil {
		t.Fatalf("a Production transaction was rejected by a Production verifier: %v", err)
	}
}

func TestAppleVerifierEnforcesConfiguredBundle(t *testing.T) {
	c := newAppleTestChain(t)
	v, err := NewAppleTransactionVerifier(AppleStoreConfig{
		Environment:  appleEnvSandbox,
		Apps:         []AppleAppConfig{{BundleID: testBundleIOS}},
		RootCertsPEM: c.rootPEM,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, bundle := range []string{testBundleMac, "com.relayium.app.share", "com.evil.app", " com.relayium.app", ""} {
		jws := c.sign(t, applePayload(func(p map[string]any) { p["bundleId"] = bundle }))
		if _, err := v.Verify(jws, time.Now()); err == nil {
			t.Fatalf("bundle %q was accepted", bundle)
		}
	}
}

func TestAppleVerifierEnforcesProductionAppAppleID(t *testing.T) {
	c := newAppleTestChain(t)
	const appleID = 6791918822

	// Production without the app's App Store id is not a verifier at all.
	if _, err := NewAppleTransactionVerifier(AppleStoreConfig{
		Environment:  appleEnvProduction,
		Apps:         []AppleAppConfig{{BundleID: testBundleIOS}},
		RootCertsPEM: c.rootPEM,
	}); err == nil {
		t.Fatal("a production verifier was built without an appAppleId")
	}

	prod, err := NewAppleTransactionVerifier(AppleStoreConfig{
		Environment:  appleEnvProduction,
		Apps:         []AppleAppConfig{{BundleID: testBundleIOS, AppAppleID: appleID}},
		RootCertsPEM: c.rootPEM,
	})
	if err != nil {
		t.Fatal(err)
	}
	production := func(mut func(map[string]any)) string {
		return c.sign(t, applePayload(func(p map[string]any) {
			p["environment"] = appleEnvProduction
			mut(p)
		}))
	}
	if _, err := prod.Verify(production(func(p map[string]any) { p["appAppleId"] = appleID + 1 }), time.Now()); err == nil {
		t.Fatal("a foreign appAppleId was accepted")
	}
	if _, err := prod.Verify(production(func(p map[string]any) { p["appAppleId"] = appleID }), time.Now()); err != nil {
		t.Fatalf("the configured appAppleId was rejected: %v", err)
	}
	// A sandbox verifier declares no App Store id, so a payload that carries one
	// has nothing to agree with and is refused rather than waved through.
	sandbox := testVerifier(t, c)
	if _, err := sandbox.Verify(c.sign(t, applePayload(func(p map[string]any) { p["appAppleId"] = appleID })), time.Now()); err == nil {
		t.Fatal("an unmatchable appAppleId was accepted")
	}
}

// The verifier cannot be built without explicit trust roots, and a nil verifier
// verifies nothing — the two halves of failing closed with no configuration.
func TestAppleVerifierRequiresExplicitConfiguration(t *testing.T) {
	c := newAppleTestChain(t)
	for name, cfg := range map[string]AppleStoreConfig{
		"no roots":     {Environment: appleEnvSandbox, Apps: []AppleAppConfig{{BundleID: testBundleIOS}}},
		"junk roots":   {Environment: appleEnvSandbox, Apps: []AppleAppConfig{{BundleID: testBundleIOS}}, RootCertsPEM: []byte("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n")},
		"no apps":      {Environment: appleEnvSandbox, RootCertsPEM: c.rootPEM},
		"empty bundle": {Environment: appleEnvSandbox, Apps: []AppleAppConfig{{BundleID: "  "}}, RootCertsPEM: c.rootPEM},
		"dup bundle":   {Environment: appleEnvSandbox, Apps: []AppleAppConfig{{BundleID: testBundleIOS}, {BundleID: testBundleIOS}}, RootCertsPEM: c.rootPEM},
		"no env":       {Apps: []AppleAppConfig{{BundleID: testBundleIOS}}, RootCertsPEM: c.rootPEM},
		"unknown env":  {Environment: "Xcode", Apps: []AppleAppConfig{{BundleID: testBundleIOS}}, RootCertsPEM: c.rootPEM},
		"negative id":  {Environment: appleEnvSandbox, Apps: []AppleAppConfig{{BundleID: testBundleIOS, AppAppleID: -1}}, RootCertsPEM: c.rootPEM},
	} {
		if _, err := NewAppleTransactionVerifier(cfg); err == nil {
			t.Fatalf("configuration %q built a verifier", name)
		}
	}

	var absent *AppleTransactionVerifier
	if _, err := absent.Verify(c.sign(t, applePayload()), time.Now()); err == nil {
		t.Fatal("a nil verifier verified a transaction")
	}

	// The same refusal one level down, where it is a different hazard:
	// x509.VerifyOptions reads a nil root pool as "use the host's root store", so
	// a caller that reached this function without anchors would silently trust
	// every public CA. NewAppleTransactionVerifier cannot produce that state,
	// which is exactly why the check needs a test of its own.
	if _, err := verifyAppleCompactJWS(c.sign(t, applePayload()), nil, time.Now()); err == nil {
		t.Fatal("a nil trust pool verified a transaction")
	}
}

// Nothing the verifier says about a refusal may quote the material it refused:
// a log line that outlives the request must not carry the JWS, the token or the
// decoded payload.
func TestAppleVerifierErrorsCarryNoMaterial(t *testing.T) {
	c := newAppleTestChain(t)
	other := newAppleTestChain(t)
	v := testVerifier(t, c)
	jws := other.sign(t, applePayload())
	_, err := v.Verify(jws, time.Now())
	if err == nil {
		t.Fatal("expected a rejection")
	}
	msg := err.Error()
	for _, secret := range []string{jws, testAppAccountToken, "2000000000000001", base64.StdEncoding.EncodeToString(other.leafDER)} {
		if strings.Contains(msg, secret) {
			t.Fatalf("rejection quoted submitted material: %q", msg)
		}
	}
	if appleRejectionCode(err) == "" {
		t.Fatalf("rejection has no stable code: %q", msg)
	}
}
