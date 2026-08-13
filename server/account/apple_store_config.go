package account

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// The App Store transaction verifier's CONFIGURATION, read from a file the
// deployment owns.
//
// AppleStoreConfig (apple_transaction.go) is the injected trust boundary; this
// file is the one supported way to fill it in from outside the process, and it
// is deliberately the whole way. There is no env var that half-configures a
// verifier, because the failure mode being avoided is a deployment that looks
// configured and answers 503 to every purchase — or worse, one that is
// configured for the wrong App Store environment.
//
// WHAT IS IN THE FILE, and why it is a file rather than env vars:
//
//	{
//	  "environment": "Sandbox",
//	  "rootCertsFile": "/etc/relayium/apple-root-cas.pem",
//	  "apps": [{"bundleId": "com.example.app", "appAppleId": 0}]
//	}
//
// A deployment that must accept BOTH signed environments at once — the
// TestFlight/App Review case, where a reviewer's purchase is always Sandbox
// while customers are always Production — writes the plural key instead:
//
//	{
//	  "environments": ["Production", "Sandbox"],
//	  "rootCertsFile": "/etc/relayium/apple-root-cas.pem",
//	  "apps": [{"bundleId": "com.example.app", "appAppleId": 1234567890}]
//	}
//
// The two keys are ALTERNATIVES, never a merge: a file carrying both is refused
// (see LoadAppleStoreConfig). `"environment": "Sandbox"` means exactly
// `"environments": ["Sandbox"]`, so every existing file keeps its meaning
// unchanged and the plural key adds a shape rather than replacing one. What the
// plural key does NOT add is a wildcard — the set may hold only Apple's own two
// spellings, and an empty set configures no verifier at all.
//
// The app list is a list of PAIRS. Spelled as environment variables it would be
// two comma-separated lists that have to line up by index — a shape where one
// missing element silently pairs every bundle id with the wrong numeric App
// Store id. JSON says which id belongs to which bundle without a convention.
//
// WHAT IS NOT IN IT:
//
//   - No products. Which bundle+product grants which plan and cycle is the
//     database's answer (SQLiteStore.AppleProductPlan / UpsertAppleProduct) and
//     stays there: a catalog in two places is a catalog that disagrees with
//     itself, and this one would disagree on what a customer paid for. A
//     verified transaction for an unmapped product is refused, so the mappings
//     must exist BEFORE a client is allowed to purchase.
//   - No secrets. Bundle ids, App Store ids and Apple's root CAs are all public
//     material; nothing here is a credential, and nothing here is an App Store
//     Server API key. That is also why this file's contents may appear in a
//     startup error — the trust file's contents may not, and never do.
//
// EVERY refusal in here is a startup failure. A configuration that cannot be
// read, parsed or trusted leaves the deployment with no verifier at all, and
// the caller (server/apple_store.go) turns that into a refusal to boot rather
// than into an endpoint that answers 503 for reasons nobody will notice.

const (
	// appleStoreConfigMaxBytes bounds the JSON file. The real thing is a few
	// hundred bytes; this is the "somebody pointed it at a log file" guard, not
	// a growth limit.
	appleStoreConfigMaxBytes = 64 << 10
	// appleRootCertsMaxBytes bounds the PEM trust file. Apple publishes one
	// ~1 KiB root; a rotation window holding several is still far inside this.
	appleRootCertsMaxBytes = 128 << 10
	// appleMaxRootCerts caps how many anchors one deployment may trust. Trust
	// roots are counted in ones and twos — a file with dozens is a bundle of
	// public CAs, which is exactly what this verifier must never anchor on.
	appleMaxRootCerts = 8
	// appleMaxConfiguredApps caps the app list. Relayium ships two apps (macOS,
	// iOS); the bound is about keeping a mangled file from becoming a large map,
	// not about how many apps are reasonable.
	appleMaxConfiguredApps = 32
)

// appleStoreConfigFile is the on-disk shape, kept separate from
// AppleStoreConfig so the file format is a stated thing rather than whatever
// the in-memory struct happens to look like today.
type appleStoreConfigFile struct {
	// Environment is the original singular key: one environment, spelled
	// directly. Kept because every deployed file uses it and it means precisely a
	// one-element set.
	//
	// A POINTER so "the key is absent" and "the key is present and empty" stay
	// distinguishable. Top-level key presence is checked separately below because
	// encoding/json represents both an absent pointer field and an explicit null
	// as nil.
	Environment *string `json:"environment"`
	// Environments is the plural alternative, for a deployment that accepts both
	// signed environments. Decoded as a slice of strings so a scalar, an object
	// or a nested array is a decode error rather than a value coerced into a set.
	Environments  []string              `json:"environments"`
	RootCertsFile string                `json:"rootCertsFile"`
	Apps          []appleStoreConfigApp `json:"apps"`
}

type appleStoreConfigApp struct {
	BundleID string `json:"bundleId"`
	// AppAppleID is decoded into int64 on purpose: "12345", 1.5 and 1e3 are all
	// decode errors rather than values rounded into an identity. Absent is 0,
	// which NewAppleTransactionVerifier accepts only outside production.
	AppAppleID int64 `json:"appAppleId"`
}

// LoadAppleStoreConfig reads one App Store verifier configuration from path.
//
// It returns a config to hand to NewAppleTransactionVerifier, which is what
// applies the trust-boundary rules (a supported environment, at least one app,
// no duplicate bundle id, a production app that names its App Store id, roots
// that parse into a pool). Those rules are NOT restated here — there is one
// place that decides what a verifier may be built from, and this is the reader
// that feeds it.
//
// What this function owns is everything that happens before that: the two files
// are bounded, ordinary and readable; the JSON is one unambiguous document; and
// the PEM really is certificate-authority material rather than a file that
// merely contains a certificate somewhere in it.
func LoadAppleStoreConfig(path string) (AppleStoreConfig, error) {
	raw, err := readAppleStoreFile(path, appleStoreConfigMaxBytes)
	if err != nil {
		return AppleStoreConfig{}, fmt.Errorf("account: apple store config %s: %w", path, err)
	}
	// The SAME strictness the signed payload gets (apple_jws.go): exactly one
	// JSON object, no duplicate keys at any depth, nothing trailing. Reused
	// rather than re-implemented because the hazard is identical — encoding/json
	// takes the LAST of two "environment" keys, so a file that says both
	// "Sandbox" and "Production" would quietly be one of them.
	if err := appleStrictJSONObject(raw); err != nil {
		return AppleStoreConfig{}, fmt.Errorf("account: apple store config %s is not one unambiguous JSON object (%s)",
			path, appleRejectionCode(err))
	}
	// The singular and plural keys are alternatives even when either value is
	// null. The typed decoder cannot prove that by itself: encoding/json maps an
	// absent pointer/slice and an explicit null to the same nil value.
	var topLevel map[string]json.RawMessage
	if err := json.Unmarshal(raw, &topLevel); err != nil {
		return AppleStoreConfig{}, fmt.Errorf("account: apple store config %s: %w", path, err)
	}
	_, singularPresent := topLevel["environment"]
	_, pluralPresent := topLevel["environments"]
	if singularPresent && pluralPresent {
		return AppleStoreConfig{}, fmt.Errorf(
			`account: apple store config %s sets both "environment" and "environments" — use one`, path)
	}
	var file appleStoreConfigFile
	dec := json.NewDecoder(bytes.NewReader(raw))
	// An unknown key is a typo in a file whose every key changes who gets paid
	// for what. "enviroment": "Sandbox" would otherwise leave Environment empty
	// and fail with a message about the wrong field.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return AppleStoreConfig{}, fmt.Errorf("account: apple store config %s: %w", path, err)
	}
	if len(file.Apps) > appleMaxConfiguredApps {
		return AppleStoreConfig{}, fmt.Errorf("account: apple store config %s lists %d apps (max %d)",
			path, len(file.Apps), appleMaxConfiguredApps)
	}
	// ONE key decides the environment set. Both present is an ambiguous document
	// in the same way two "environment" keys would be, and the same rule applies:
	// this reader refuses rather than choosing. Neither present leaves the set
	// empty, which NewAppleTransactionVerifier refuses — there is no default App
	// Store, and never has been.
	environments := file.Environments
	if file.Environment != nil {
		// The legacy shape, stated as what it always meant: a one-element set.
		// Whether the element is a supported spelling is the verifier's rule, so
		// an empty or misspelled value still fails with the message it always did.
		environments = []string{*file.Environment}
	}
	roots, err := loadAppleRootCerts(file.RootCertsFile)
	if err != nil {
		return AppleStoreConfig{}, fmt.Errorf("account: apple store config %s: %w", path, err)
	}
	cfg := AppleStoreConfig{
		Environments: environments,
		RootCertsPEM: roots,
		Apps:         make([]AppleAppConfig, 0, len(file.Apps)),
	}
	for _, app := range file.Apps {
		cfg.Apps = append(cfg.Apps, AppleAppConfig{BundleID: app.BundleID, AppAppleID: app.AppAppleID})
	}
	return cfg, nil
}

// loadAppleRootCerts reads the explicitly trusted Apple root CA(s).
//
// The path is required and must be ABSOLUTE. Trust material resolved against
// whatever directory the server happened to start in is trust material nobody
// can point at with certainty, and "it worked under systemd but not by hand" is
// not a failure mode this file may have.
//
// Nothing about the file's CONTENTS reaches an error message. A malformed trust
// file produces "does not hold a certificate", never the bytes that were in it.
func loadAppleRootCerts(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New(`needs "rootCertsFile" — the PEM file holding the Apple root CA(s) this deployment trusts`)
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("rootCertsFile %s must be an absolute path", path)
	}
	raw, err := readAppleStoreFile(path, appleRootCertsMaxBytes)
	if err != nil {
		return nil, fmt.Errorf("rootCertsFile %s: %w", path, err)
	}
	if err := checkAppleRootCertsPEM(raw); err != nil {
		return nil, fmt.Errorf("rootCertsFile %s %w", path, err)
	}
	return raw, nil
}

// checkAppleRootCertsPEM requires the file to be PEM certificate blocks and
// NOTHING else.
//
// x509.CertPool.AppendCertsFromPEM — which the verifier itself then calls — is
// deliberately forgiving: it skips anything it cannot parse and reports success
// if it found at least one certificate anywhere in the input. That is the right
// behaviour for a system bundle and the wrong one here, where the input is a
// short file an operator assembled by hand: half a paste, a private key left in
// by accident, or an intermediate mistaken for a root would all "work" while
// anchoring the deployment on something other than what its author meant.
func checkAppleRootCertsPEM(raw []byte) error {
	rest := raw
	count := 0
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			// A PRIVATE KEY block here is the one that matters: it would mean the
			// operator pointed this at key material, and this file is world-readable
			// public trust material by design.
			return errors.New("holds a non-certificate PEM block")
		}
		if len(block.Headers) != 0 {
			return errors.New("holds a certificate with PEM headers")
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return errors.New("holds an unparsable certificate")
		}
		// A trust ANCHOR. A leaf or a cross-signed non-CA certificate pasted in
		// here would be added to the pool and could then terminate a path.
		if !cert.IsCA {
			return errors.New("holds a certificate that is not a CA")
		}
		// A ROOT, not merely a CA. Everything handed to x509.CertPool becomes an
		// anchor, so an intermediate pasted in here would be trusted as one — and
		// the chain above it, including the root that really signed it, would stop
		// being verified at all. Apple publishes its intermediates beside its
		// roots, which is exactly how the wrong one gets downloaded.
		//
		// Two things make a root, and the second is the one that matters: it names
		// itself as its own issuer, AND that self-signature verifies under its own
		// key. Name equality alone is a claim anyone can write.
		if !bytes.Equal(cert.RawIssuer, cert.RawSubject) {
			return errors.New("holds a CA certificate that is not self-issued (an intermediate is not a root)")
		}
		// CheckSignatureFrom(cert) is the self-signature check, and it also
		// re-applies the CA constraints to the SIGNING side: basic constraints
		// present and asserted, and a key usage that permits certificate signing.
		if err := cert.CheckSignatureFrom(cert); err != nil {
			return errors.New("holds a self-issued CA certificate whose own signature does not verify")
		}
		count++
		if count > appleMaxRootCerts {
			return fmt.Errorf("holds more than %d certificates", appleMaxRootCerts)
		}
	}
	if count == 0 {
		return errors.New("does not hold a certificate")
	}
	// Trailing material: pem.Decode stops at the first thing that is not a block
	// and hands back the remainder. Whitespace is ordinary; anything else means
	// the file holds something this reader did not look at.
	if len(bytes.TrimSpace(rest)) != 0 {
		return errors.New("holds trailing non-PEM material")
	}
	return nil
}

// readAppleStoreFile reads at most max bytes of an ordinary configuration file.
//
// The checks are in this order for a reason:
//
//   - Lstat FIRST, so a symlink, FIFO, socket, device or directory is refused
//     BEFORE any open. Opening a FIFO blocks until a writer appears, which for a
//     path read during startup means a boot that hangs instead of failing.
//   - Stat again through the OPEN DESCRIPTOR, because the first check described
//     a path and this one describes the file actually being read.
//   - A size check and a LimitReader, because a size read before the copy is a
//     claim about the file and the limit is the thing that holds if it grows
//     underneath us.
//
// The paths involved come from the server's own configuration — a flag or an
// environment variable read at startup. No request-derived value reaches here,
// and nothing in this package builds one.
func readAppleStoreFile(path string, max int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, appleFileErr(err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("is not a regular file (%s)", info.Mode().Type())
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, appleFileErr(err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, appleFileErr(err)
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("is not a regular file (%s)", st.Mode().Type())
	}
	if st.Size() > max {
		return nil, fmt.Errorf("is larger than %d bytes", max)
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, appleFileErr(err)
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("is larger than %d bytes", max)
	}
	if len(data) == 0 {
		return nil, errors.New("is empty")
	}
	return data, nil
}

// appleFileErr drops the path an os error carries. Every caller here has
// already named the file it was reading, and a boot failure that repeats the
// same path three times is harder to read, not more precise.
func appleFileErr(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
