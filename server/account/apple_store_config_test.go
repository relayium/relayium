package account

import (
	"bytes"
	"crypto/elliptic"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The configuration file is the ONLY way a deployment turns App Store purchase
// verification on, so every way of getting it wrong has to end in a refusal to
// build a verifier — never in a verifier that trusts something else.
//
// The positive case at the bottom is the one that ties this to reality: a
// verifier built from a file, installed on a live service, accepting exactly
// the transaction the hand-built verifier accepts and refusing the same
// material once the file names a different root.

// loadAppleStoreVerifier is what startup does, in one call: read the file
// (LoadAppleStoreConfig), then build the verifier from it
// (NewAppleTransactionVerifier). The two steps stay separate in production —
// see server/apple_store.go — so that the file can be validated before the
// database is opened and the verifier installed after the service exists.
func loadAppleStoreVerifier(path string) (*AppleTransactionVerifier, error) {
	cfg, err := LoadAppleStoreConfig(path)
	if err != nil {
		return nil, err
	}
	return NewAppleTransactionVerifier(cfg)
}

// appleStoreFiles is a throwaway config directory: a PEM trust file plus
// whatever config document a test wants to point at it.
type appleStoreFiles struct {
	dir       string
	rootsPath string
}

func newAppleStoreFiles(t *testing.T, rootPEM []byte) appleStoreFiles {
	t.Helper()
	dir := t.TempDir()
	f := appleStoreFiles{dir: dir, rootsPath: filepath.Join(dir, "roots.pem")}
	writeAppleStoreFile(t, f.rootsPath, rootPEM)
	return f
}

// config writes one config document and returns its path.
func (f appleStoreFiles) config(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(f.dir, "apple-store.json")
	writeAppleStoreFile(t, path, []byte(body))
	return path
}

// valid is a complete sandbox configuration for the two test bundles.
func (f appleStoreFiles) valid() string {
	return f.withApps(`[{"bundleId":"` + testBundleIOS + `"},{"bundleId":"` + testBundleMac + `"}]`)
}

// withApps keeps environment and roots fixed and bends only the app list.
func (f appleStoreFiles) withApps(apps string) string {
	return fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":%q,"apps":%s}`, f.rootsPath, apps)
}

func writeAppleStoreFile(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// mustNotLoad asserts a refusal and reports what was accepted instead.
func mustNotLoad(t *testing.T, path, why string) {
	t.Helper()
	v, err := loadAppleStoreVerifier(path)
	if err == nil {
		t.Fatalf("%s: built a verifier (%p) from configuration that should have been refused", why, v)
	}
	if v != nil {
		t.Fatalf("%s: refused with %v but still returned a verifier", why, err)
	}
}

// ── The file itself ──────────────────────────────────────────────────────────

// A path that names nothing is a typo, and a typo must not be quietly
// indistinguishable from "this deployment sells nothing".
func TestAppleStoreConfigMissingFileIsRefused(t *testing.T) {
	mustNotLoad(t, filepath.Join(t.TempDir(), "nope.json"), "missing file")
}

func TestAppleStoreConfigUnreadableFileIsRefused(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: file modes do not deny reads")
	}
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	path := f.config(t, f.valid())
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}
	mustNotLoad(t, path, "unreadable config file")

	// And the trust file, which is the half a deployment is most likely to get
	// the ownership wrong on.
	unreadable := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	if err := os.Chmod(unreadable.rootsPath, 0o000); err != nil {
		t.Fatal(err)
	}
	mustNotLoad(t, unreadable.config(t, unreadable.valid()), "unreadable trust file")
}

// Not a regular file: a directory and a symlink. Both are refused before any
// open, which is also what keeps a swapped-in FIFO from hanging startup on a
// read that never returns.
func TestAppleStoreConfigNonRegularFilesAreRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	real := f.config(t, f.valid())

	mustNotLoad(t, f.dir, "a directory")

	link := filepath.Join(t.TempDir(), "link.json")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	mustNotLoad(t, link, "a symlinked config")

	// The same rule on the trust file, which is the one that decides what is
	// trusted at all.
	rootsLink := filepath.Join(t.TempDir(), "roots-link.pem")
	if err := os.Symlink(f.rootsPath, rootsLink); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	mustNotLoad(t, f.config(t, fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":%q,"apps":[{"bundleId":%q}]}`,
		rootsLink, testBundleIOS)), "a symlinked trust file")
}

func TestAppleStoreConfigOversizedFilesAreRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	// Leading whitespace is valid JSON framing, so this is refused on size
	// alone — before a parser sees any of it.
	mustNotLoad(t, f.config(t, strings.Repeat(" ", appleStoreConfigMaxBytes+1)+f.valid()), "oversized config")

	big := newAppleStoreFiles(t, bytes.Repeat(appleStoreTestRootPEM(t), 400))
	if got := len(bytes.Repeat(appleStoreTestRootPEM(t), 400)); int64(got) <= appleRootCertsMaxBytes {
		t.Fatalf("test setup: %d bytes is inside the %d-byte cap", got, appleRootCertsMaxBytes)
	}
	mustNotLoad(t, big.config(t, big.valid()), "oversized trust file")
}

func TestAppleStoreConfigEmptyFileIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	mustNotLoad(t, f.config(t, ""), "an empty config file")
	writeAppleStoreFile(t, f.rootsPath, nil)
	mustNotLoad(t, f.config(t, f.valid()), "an empty trust file")
}

// ── The JSON ─────────────────────────────────────────────────────────────────

func TestAppleStoreConfigMalformedJSONIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	for _, tc := range []struct{ name, body string }{
		{"truncated", `{"environment":"Sandbox"`},
		{"not an object", `["Sandbox"]`},
		{"trailing document", f.valid() + `{"environment":"Production"}`},
		{"trailing junk", f.valid() + "garbage"},
		// encoding/json takes the LAST duplicate key: without the strict pass
		// this file would silently configure Production.
		{"duplicate key", fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":%q,"apps":[{"bundleId":%q}],"environment":"Production"}`,
			f.rootsPath, testBundleIOS)},
		{"duplicate key inside an app", fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":%q,"apps":[{"bundleId":%q,"bundleId":"com.attacker.app"}]}`,
			f.rootsPath, testBundleIOS)},
		// A misspelled key would otherwise leave its field at the zero value and
		// fail with a message about the wrong thing.
		{"unknown key", fmt.Sprintf(`{"enviroment":"Sandbox","rootCertsFile":%q,"apps":[{"bundleId":%q}]}`,
			f.rootsPath, testBundleIOS)},
		{"unknown key inside an app", fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":%q,"apps":[{"bundleId":%q,"planId":"max"}]}`,
			f.rootsPath, testBundleIOS)},
	} {
		t.Run(tc.name, func(t *testing.T) { mustNotLoad(t, f.config(t, tc.body), tc.name) })
	}
}

// A partially supplied configuration is refused rather than completed from
// defaults. There is no default App Store environment, no default app and no
// default set of trust roots — each missing one would be a guess about who gets
// charged for what.
func TestAppleStoreConfigPartialConfigurationIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	for _, tc := range []struct{ name, body string }{
		{"nothing at all", `{}`},
		{"environment only", `{"environment":"Sandbox"}`},
		{"no environment", fmt.Sprintf(`{"rootCertsFile":%q,"apps":[{"bundleId":%q}]}`, f.rootsPath, testBundleIOS)},
		{"no apps", fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":%q}`, f.rootsPath)},
		{"empty app list", f.withApps(`[]`)},
		{"no trust file", fmt.Sprintf(`{"environment":"Sandbox","apps":[{"bundleId":%q}]}`, testBundleIOS)},
		{"empty trust file path", fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":"","apps":[{"bundleId":%q}]}`, testBundleIOS)},
	} {
		t.Run(tc.name, func(t *testing.T) { mustNotLoad(t, f.config(t, tc.body), tc.name) })
	}
}

func TestAppleStoreConfigMalformedIdentityIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	for _, tc := range []struct{ name, apps string }{
		{"bundle id is not a string", `[{"bundleId":12345}]`},
		{"empty bundle id", `[{"bundleId":""}]`},
		{"blank bundle id", `[{"bundleId":"   "}]`},
		{"app is not an object", `["com.relayium.app"]`},
		// A quoted, fractional or exponential App Store id is not an identity
		// that was typed on purpose.
		{"quoted app apple id", `[{"bundleId":"com.relayium.app","appAppleId":"123456789"}]`},
		{"fractional app apple id", `[{"bundleId":"com.relayium.app","appAppleId":1.5}]`},
		{"exponential app apple id", `[{"bundleId":"com.relayium.app","appAppleId":1e3}]`},
		{"negative app apple id", `[{"bundleId":"com.relayium.app","appAppleId":-1}]`},
		// The macOS and iOS builds are two App Store records; one bundle id
		// listed twice is a file whose author meant two different things.
		{"duplicate bundle id", `[{"bundleId":"com.relayium.app"},{"bundleId":"com.relayium.app","appAppleId":7}]`},
	} {
		t.Run(tc.name, func(t *testing.T) { mustNotLoad(t, f.config(t, f.withApps(tc.apps)), tc.name) })
	}

	// More apps than any deployment has: a bound, so a mangled file cannot turn
	// into a large map.
	apps := make([]string, 0, appleMaxConfiguredApps+1)
	for i := range appleMaxConfiguredApps + 1 {
		apps = append(apps, fmt.Sprintf(`{"bundleId":"com.relayium.app%d"}`, i))
	}
	mustNotLoad(t, f.config(t, f.withApps("["+strings.Join(apps, ",")+"]")), "too many apps")
}

// The environment is the server's own answer to "which App Store is this", and
// there are exactly two of them. A near-miss spelling is not a third.
func TestAppleStoreConfigUnsupportedEnvironmentIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	for _, env := range []string{"production", "SANDBOX", "sandbox", "Prod", "Staging", "", " "} {
		t.Run(fmt.Sprintf("%q", env), func(t *testing.T) {
			mustNotLoad(t, f.config(t, fmt.Sprintf(`{"environment":%q,"rootCertsFile":%q,"apps":[{"bundleId":%q}]}`,
				env, f.rootsPath, testBundleIOS)), "environment "+env)
		})
	}
}

// Production must be able to say WHICH App Store record each bundle id is, so
// there is something to compare against the day a payload carries one.
func TestAppleStoreConfigProductionRequiresAppAppleID(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	body := func(apps string) string {
		return fmt.Sprintf(`{"environment":"Production","rootCertsFile":%q,"apps":%s}`, f.rootsPath, apps)
	}
	mustNotLoad(t, f.config(t, body(`[{"bundleId":"`+testBundleIOS+`"}]`)), "production app with no appAppleId")
	mustNotLoad(t, f.config(t, body(`[{"bundleId":"`+testBundleIOS+`","appAppleId":0}]`)), "production app with appAppleId 0")
	// One complete app does not excuse the other.
	mustNotLoad(t, f.config(t, body(`[{"bundleId":"`+testBundleIOS+`","appAppleId":123},{"bundleId":"`+testBundleMac+`"}]`)),
		"one production app missing its appAppleId")

	// Complete, and therefore accepted.
	if _, err := loadAppleStoreVerifier(f.config(t, body(
		`[{"bundleId":"`+testBundleIOS+`","appAppleId":123},{"bundleId":"`+testBundleMac+`","appAppleId":456}]`))); err != nil {
		t.Fatalf("a complete production configuration was refused: %v", err)
	}
}

// ── The trust material ───────────────────────────────────────────────────────

// The path is required, absolute and never derived from anything but the
// configuration file: trust material found relative to whatever directory the
// server started in is trust material nobody can point at.
func TestAppleStoreConfigRelativeTrustPathIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	for _, p := range []string{"roots.pem", "./roots.pem", "../roots.pem"} {
		mustNotLoad(t, f.config(t, fmt.Sprintf(`{"environment":"Sandbox","rootCertsFile":%q,"apps":[{"bundleId":%q}]}`,
			p, testBundleIOS)), "relative trust path "+p)
	}
}

func TestAppleStoreConfigMissingTrustFileIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestRootPEM(t))
	if err := os.Remove(f.rootsPath); err != nil {
		t.Fatal(err)
	}
	mustNotLoad(t, f.config(t, f.valid()), "missing trust file")
}

// x509.CertPool.AppendCertsFromPEM would accept most of these — it skips what
// it cannot parse and succeeds if it found one certificate anywhere. For a
// short hand-assembled file that forgiveness is how a deployment ends up
// anchored on something other than what its author pasted in.
func TestAppleStoreConfigInvalidRootPEMIsRefused(t *testing.T) {
	root := appleStoreTestRootPEM(t)
	for _, tc := range []struct {
		name  string
		roots []byte
	}{
		{"junk", []byte("this is not a certificate\n")},
		{"header without a body", []byte("-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n")},
		{"base64 that is not DER", []byte("-----BEGIN CERTIFICATE-----\naGVsbG8gd29ybGQ=\n-----END CERTIFICATE-----\n")},
		{"a private key block", []byte("-----BEGIN EC PRIVATE KEY-----\naGVsbG8=\n-----END EC PRIVATE KEY-----\n")},
		{"a certificate with a private key appended", append(append([]byte{}, root...),
			[]byte("-----BEGIN EC PRIVATE KEY-----\naGVsbG8=\n-----END EC PRIVATE KEY-----\n")...)},
		{"trailing non-PEM material", append(append([]byte{}, root...), []byte("and one more thing\n")...)},
		{"a leaf certificate rather than a CA", appleStoreTestLeafPEM(t)},
		{"more anchors than a deployment has", bytes.Repeat(root, appleMaxRootCerts+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppleStoreFiles(t, tc.roots)
			mustNotLoad(t, f.config(t, f.valid()), tc.name)
		})
	}
}

// An INTERMEDIATE is the near-miss this file is most likely to contain: it is a
// CA, it parses, it came from Apple, and it is one download away from the root
// on the same page. Anything added to an x509.CertPool becomes an anchor, so an
// intermediate pasted in here would be trusted as a root — and the chain above
// it, including the root that actually signed it, would stop being checked at
// all. Whoever holds that intermediate's key then decides what this deployment
// accepts.
//
// Being a CA is not being a root. The evidence for a root is that it signed
// ITSELF: issuer and subject are the same name AND the signature verifies under
// the certificate's own key.
func TestAppleStoreConfigIntermediateCAIsNotAcceptedAsARoot(t *testing.T) {
	// A genuine intermediate from the same builder the transaction tests use:
	// IsCA, KeyUsageCertSign, well-formed, issued by a root — everything a root
	// has except having signed itself.
	chain := newAppleTestChain(t)
	inter := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: chain.interDER})

	f := newAppleStoreFiles(t, inter)
	mustNotLoad(t, f.config(t, f.valid()), "an intermediate CA mistaken for a root")

	// And it stays refused when a real root is sitting right next to it: the
	// rule is about every certificate in the file, not about whether the file
	// contains at least one acceptable one.
	both := newAppleStoreFiles(t, append(append([]byte{}, chain.rootPEM...), inter...))
	mustNotLoad(t, both.config(t, both.valid()), "a root with an intermediate appended")
}

// Name equality is a CLAIM; the self-signature is the evidence. A certificate
// that names itself as its own issuer but carries a signature made by some
// other key must not become an anchor on the strength of the name alone.
func TestAppleStoreConfigForgedSelfIssuedRootIsRefused(t *testing.T) {
	f := newAppleStoreFiles(t, appleStoreTestForgedRootPEM(t))
	mustNotLoad(t, f.config(t, f.valid()), "a self-issued certificate whose signature is another key's")
}

// ── The positive case ────────────────────────────────────────────────────────

// A verifier built from a configuration FILE, installed on a live service, and
// accepting exactly what the hand-built verifier in newAppleTxFixture accepts.
// Nothing about the endpoint's answer comes from anywhere but that file and the
// database's product mapping.
func TestAppleStoreConfigFileVerifierIsInstalledAndAccepts(t *testing.T) {
	f := newAppleTxFixture(t)
	files := newAppleStoreFiles(t, f.chain.rootPEM)
	v, err := loadAppleStoreVerifier(files.config(t, files.valid()))
	if err != nil {
		t.Fatalf("a complete configuration was refused: %v", err)
	}
	// From here the endpoint answers with the file's verifier, not the fixture's.
	f.svc.SetAppleTransactionVerifier(v)

	expires := time.Now().Add(30 * 24 * time.Hour).UnixMilli()
	got, _ := f.mustAccept(t, f.chain.sign(t, f.payload(func(p map[string]any) { p["expiresDate"] = expires })))
	if !got.Applied || got.PlanID != "pro" || got.Status != "active" || got.Provider != ProviderApple {
		t.Fatalf("unexpected result: %+v", got)
	}
	if got.ExpiresAt != expires/1000 {
		t.Fatalf("expiresAt = %d, want %d", got.ExpiresAt, expires/1000)
	}
	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple || u.BillingCycle != "monthly" {
		t.Fatalf("entitlement not applied through the file-built verifier: %+v", u)
	}
}

// The same submission, against a configuration whose trust file names a
// different root: refused. This is what proves the anchors came out of the file
// rather than out of the chain the client presented — the JWS carries its own
// self-signed root in x5c[2] and is still refused.
func TestAppleStoreConfigFileDecidesWhichRootIsTrusted(t *testing.T) {
	f := newAppleTxFixture(t)
	stranger := newAppleTestChain(t)
	files := newAppleStoreFiles(t, stranger.rootPEM)
	v, err := loadAppleStoreVerifier(files.config(t, files.valid()))
	if err != nil {
		t.Fatalf("a complete configuration was refused: %v", err)
	}
	f.svc.SetAppleTransactionVerifier(v)

	f.mustReject(t, f.chain.sign(t, f.payload()), http.StatusBadRequest, "invalid_transaction")
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("a transaction anchored on an unconfigured root changed an account: %+v", u)
	}
	if _, ok := f.appleSource(t); ok {
		t.Fatal("a transaction anchored on an unconfigured root created a source row")
	}
}

// ── Certificates for the trust-file tests ────────────────────────────────────

// appleStoreTestRootPEM is a self-signed CA — the shape a real Apple root has,
// and all these tests need of it.
func appleStoreTestRootPEM(t *testing.T) []byte {
	t.Helper()
	return appleStoreTestCertPEM(t, true)
}

// appleStoreTestLeafPEM is the same certificate without CA basic constraints:
// well-formed, parsable, and not a trust anchor.
func appleStoreTestLeafPEM(t *testing.T) []byte {
	t.Helper()
	return appleStoreTestCertPEM(t, false)
}

// appleStoreTestForgedRootPEM is a certificate whose issuer and subject are the
// same name — so it LOOKS self-issued — but whose signature was made by a key
// that is not the one the certificate attests to. Only verifying the signature
// tells the two apart.
func appleStoreTestForgedRootPEM(t *testing.T) []byte {
	t.Helper()
	name := pkix.Name{CommonName: "Test Apple Store Config CA"}
	subjectKey := mustECKey(t, elliptic.P256())
	impostorKey := mustECKey(t, elliptic.P256())
	// The parent template supplies the ISSUER NAME only; it carries no public
	// key, so the signature below comes from impostorKey while the certificate
	// attests to subjectKey.
	issuer := &x509.Certificate{
		SerialNumber:          big.NewInt(12),
		Subject:               name,
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}
	der := mustCert(t, &x509.Certificate{
		SerialNumber:          big.NewInt(13),
		Subject:               name,
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}, issuer, &subjectKey.PublicKey, impostorKey)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func appleStoreTestCertPEM(t *testing.T, isCA bool) []byte {
	t.Helper()
	key := mustECKey(t, elliptic.P256())
	usage := x509.KeyUsageDigitalSignature
	if isCA {
		usage = x509.KeyUsageCertSign | x509.KeyUsageCRLSign
	}
	der := mustCert(t, &x509.Certificate{
		SerialNumber:          big.NewInt(11),
		Subject:               pkix.Name{CommonName: "Test Apple Store Config CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  isCA,
		KeyUsage:              usage,
		BasicConstraintsValid: true,
	}, nil, &key.PublicKey, key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
