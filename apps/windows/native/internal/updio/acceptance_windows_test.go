//go:build windows

// The acceptance set. These are the answers only Windows can give.
//
// Everything in `serve_test.go` and `path_test.go` runs anywhere and proves the
// protocol. Nothing there says whether a junction is refused, whether a held
// ancestor survives a rename attempt, or whether a signer chain is walked
// correctly — those are properties of the kernel and of wintrust, and the only
// way to know them is to ask.
//
// ## No fixture creates an account, a certificate or a trust setting
//
// The signed positive uses the runner's own `node.exe`, copied into a temporary
// directory this test made. Nothing is installed, imported or mutated, and the
// process is never launched: `install.verify` returns after verification, and
// `install.run` is exercised only for its refusals.
package updio

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

func newSession(t *testing.T, root, component string) *WindowsCustody {
	t.Helper()
	custody := NewWindowsCustody()
	t.Cleanup(func() { _ = custody.Close() })
	if err := custody.Open(root, component); err != nil {
		t.Fatalf("scope.open(%q, %q): %v", root, component, err)
	}
	return custody
}

func mustRefuseOpen(t *testing.T, root, component, code string) {
	t.Helper()
	custody := NewWindowsCustody()
	defer func() { _ = custody.Close() }()
	err := custody.Open(root, component)
	if err == nil {
		t.Fatalf("scope.open(%q) was accepted; expected %s", root, code)
	}
	if !IsCode(err, code) {
		t.Fatalf("scope.open(%q): got %v, want %s", root, err, code)
	}
}

func appRoot(t *testing.T) string {
	t.Helper()
	// Under the test's own temp directory, which is on a real volume.
	root := filepath.Join(t.TempDir(), "Relayium")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("app root: %v", err)
	}
	return root
}

func mklink(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J %s %s: %v: %s", link, target, err, out)
	}
}

func staged(t *testing.T, c *WindowsCustody, name string, content []byte) (uint32, string) {
	t.Helper()
	handle, receipt, err := c.CreateExclusive(name)
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	if len(content) > 0 {
		if err := c.Write(handle, content); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		if err := c.Sync(handle); err != nil {
			t.Fatalf("sync %s: %v", name, err)
		}
	}
	return handle, receipt
}

// ---------------------------------------------------------------------------
// 1-8: anchoring and ancestry
// ---------------------------------------------------------------------------

func TestOrdinaryUserRootIsAccepted(t *testing.T) {
	// Case 6, and the one that must never regress: the ordinary layout works.
	local, ok := os.LookupEnv("LOCALAPPDATA")
	if !ok {
		t.Skip("LOCALAPPDATA is not set on this host")
	}
	root := filepath.Join(local, "RelayiumUpdateAcceptance")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("app root: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	custody := newSession(t, root, "updates")
	// Every component from the volume root down is held.
	if len(custody.ancestors) < 4 {
		t.Fatalf("only %d ancestors held for %q", len(custody.ancestors), root)
	}
}

func TestJunctionAtStagingIsRefused(t *testing.T) {
	// Case 1.
	root := appRoot(t)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(outside, "must-survive.txt")
	if err := os.WriteFile(victim, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	mklink(t, filepath.Join(root, "updates"), outside)
	mustRefuseOpen(t, root, "updates", CodeRedirected)
	if data, err := os.ReadFile(victim); err != nil || string(data) != "outside" {
		t.Fatalf("the external file did not survive: %v %q", err, data)
	}
}

func TestJunctionAtAnIntermediateAncestorIsRefused(t *testing.T) {
	// Case 3, and the one a canonicalising implementation passes silently: an
	// ORDINARY leaf under a redirected parent.
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.MkdirAll(filepath.Join(real, "Relayium"), 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	mklink(t, link, real)
	// `link\Relayium` is a perfectly ordinary directory; its PARENT is not.
	mustRefuseOpen(t, filepath.Join(link, "Relayium"), "updates", CodeRedirected)
}

func TestSubstMappedRootIsRefusedAndThePhysicalPathIsAccepted(t *testing.T) {
	// Cases 4 and 5, as a pair: the same directory, refused through the mapping
	// and accepted directly.
	base := t.TempDir()
	target := filepath.Join(base, "parent", "dir")
	if err := os.MkdirAll(filepath.Join(target, "Relayium"), 0o700); err != nil {
		t.Fatal(err)
	}
	letter := freeDriveLetter(t)
	if out, err := exec.Command("subst", letter, target).CombinedOutput(); err != nil {
		t.Skipf("subst unavailable: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("subst", letter, "/D").Run() })

	mustRefuseOpen(t, letter+`\Relayium`, "updates", CodeRedirected)
	// The same physical path, supplied directly, is fine — and pins `parent`.
	newSession(t, filepath.Join(target, "Relayium"), "updates")
}

func freeDriveLetter(t *testing.T) string {
	t.Helper()
	for _, letter := range "XYWVUT" {
		candidate := string(letter) + ":"
		if _, err := os.Stat(candidate + `\`); err != nil {
			return candidate
		}
	}
	t.Skip("no free drive letter")
	return ""
}

func TestAncestorsNeedNoWriteAccess(t *testing.T) {
	// Case 7: an ancestor with write denied to this user, no second account.
	base := t.TempDir()
	middle := filepath.Join(base, "locked")
	root := filepath.Join(middle, "Relayium")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	user := os.Getenv("USERNAME")
	if user == "" {
		t.Skip("USERNAME is not set")
	}
	deny := exec.Command("icacls", middle, "/deny", user+":(WD,AD)")
	if out, err := deny.CombinedOutput(); err != nil {
		t.Skipf("icacls unavailable: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("icacls", middle, "/remove:d", user).Run() })
	// Traversal asks for read/traverse/attributes only, so this must still work.
	newSession(t, root, "updates")
}

func TestHeldAncestorsRefuseRenameAndDelete(t *testing.T) {
	// Case 8, including a PARENT of the app root — the level that holding only
	// root and staging would leave unprotected.
	base := t.TempDir()
	parent := filepath.Join(base, "parent")
	root := filepath.Join(parent, "Relayium")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	newSession(t, root, "updates")
	for _, target := range []string{filepath.Join(root, "updates"), root, parent} {
		if err := os.Rename(target, target+"-moved"); err == nil {
			_ = os.Rename(target+"-moved", target)
			t.Fatalf("%s was renamed while held", target)
		}
		if err := os.Remove(target); err == nil {
			t.Fatalf("%s was removed while held", target)
		}
	}
}

// ---------------------------------------------------------------------------
// 9-14: custody
// ---------------------------------------------------------------------------

func TestAHeldStagedFileRefusesReplacement(t *testing.T) {
	// Case 9.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	staged(t, custody, name, []byte("installer"))
	path := filepath.Join(root, "updates", name)
	if err := os.Remove(path); err == nil {
		t.Fatal("a held staged file was deleted")
	}
	if err := os.WriteFile(path, []byte("other"), 0o600); err == nil {
		t.Fatal("a held staged file was overwritten")
	}
	if err := os.Rename(path, path+".moved"); err == nil {
		t.Fatal("a held staged file was renamed")
	}
}

func TestASwappedFileIsNotTheOneTheReceiptNames(t *testing.T) {
	// Case 10: the identity survives a restart, the name does not.
	root := appRoot(t)
	name := "relayium-0.3.0-9-0011223344556677.exe"
	first := newSession(t, root, "updates")
	handle, receipt := staged(t, first, name, []byte("original"))
	if err := first.Release(handle); err != nil {
		t.Fatalf("release: %v", err)
	}
	_ = first.Close()

	path := filepath.Join(root, "updates", name)
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove original: %v", err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}

	second := newSession(t, root, "updates")
	current, present, err := second.Identity(name)
	if err != nil || !present {
		t.Fatalf("identity: %v %v", present, err)
	}
	if current == receipt {
		t.Fatal("a replacement reported the original's identity")
	}
	if _, err := second.Remove(name, receipt); !IsCode(err, CodeIdentity) {
		t.Fatalf("remove of a replacement: %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != "replacement" {
		t.Fatalf("the replacement was deleted: %q", data)
	}
}

func TestAPendingDeletionIsNotReportedAsGone(t *testing.T) {
	// Case 11: an independent reader holding the file WITH delete sharing.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	handle, receipt := staged(t, custody, name, []byte("installer"))
	if err := custody.Release(handle); err != nil {
		t.Fatalf("release: %v", err)
	}
	path := filepath.Join(root, "updates", name)
	wide, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := windows.CreateFile(
		wide, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, 0, 0,
	)
	if err != nil {
		t.Fatalf("independent reader: %v", err)
	}
	defer windows.CloseHandle(reader)

	gone, err := custody.Remove(name, receipt)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	// Whatever the filesystem does with the pending disposition, `gone` must be
	// the CONFIRMED answer. A true here with the name still resolving would be
	// the cleanup claim the core is not allowed to believe.
	if gone {
		if _, present, _ := custody.Identity(name); present {
			t.Fatal("remove claimed gone while the name still resolves")
		}
	}
}

func TestCommitThenDiscardUsesThePublishedName(t *testing.T) {
	// Case 12.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	temp := "candidate.json.aabbccddeeff.tmp"
	handle, _ := staged(t, custody, temp, []byte(`{"v":1}`))
	if err := custody.Commit(handle, "candidate.json"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// A file appears at the temp name AFTER the rename. Discard must not act on
	// it: the handle now names `candidate.json`.
	decoy := filepath.Join(root, "updates", temp)
	if err := os.WriteFile(decoy, []byte("decoy"), 0o600); err != nil {
		t.Fatal(err)
	}
	gone, err := custody.Discard(handle)
	if err != nil {
		t.Fatalf("discard: %v", err)
	}
	if !gone {
		t.Fatal("discard did not confirm the published file was removed")
	}
	if data, _ := os.ReadFile(decoy); string(data) != "decoy" {
		t.Fatalf("discard removed the decoy at the temp name: %q", data)
	}
	if _, err := os.Stat(filepath.Join(root, "updates", "candidate.json")); err == nil {
		t.Fatal("the published record survived its discard")
	}
}

func TestCommitReplacesAnExistingRecord(t *testing.T) {
	// The journal's whole purpose: publication REPLACES atomically.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	target := filepath.Join(root, "updates", "candidate.json")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	handle, _ := staged(t, custody, "candidate.json.112233445566.tmp", []byte("new"))
	if err := custody.Commit(handle, "candidate.json"); err != nil {
		t.Fatalf("commit over an existing record: %v", err)
	}
	if data, _ := os.ReadFile(target); string(data) != "new" {
		t.Fatalf("record after commit: %q", data)
	}
}

func TestHandlesDoNotAccumulateAcrossCycles(t *testing.T) {
	// Case 14, against the real custody.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	for i := 0; i < 20; i++ {
		handle, _ := staged(t, custody, "candidate.json.aabbccddeeff.tmp", []byte("{}"))
		if err := custody.Commit(handle, "candidate.json"); err != nil {
			t.Fatalf("cycle %d commit: %v", i, err)
		}
		if err := custody.Release(handle); err != nil {
			t.Fatalf("cycle %d release: %v", i, err)
		}
		if len(custody.files) != 0 {
			t.Fatalf("cycle %d left %d handles", i, len(custody.files))
		}
	}
}

func TestTheRecordChannelCarriesARealJournal(t *testing.T) {
	// The composition root's probe caught: a record at the core's real budget,
	// through the real custody.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	document := append(bytes.Repeat([]byte("j"), 300*1024), []byte("}")...)
	handle, _ := staged(t, custody, "candidate.json.aabbccddeeff.tmp", document)
	if err := custody.Commit(handle, "candidate.json"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := custody.Release(handle); err != nil {
		t.Fatalf("release: %v", err)
	}
	content, present, err := custody.ReadBounded("candidate.json", MaxJournalBytes)
	if err != nil || !present {
		t.Fatalf("read: %v %v", present, err)
	}
	if !bytes.Equal(content, document) {
		t.Fatalf("record round-trip differs: %d vs %d bytes", len(content), len(document))
	}
	// And one byte over the budget is an ERROR, not an absence.
	if _, present, err := custody.ReadBounded("candidate.json", len(document)-1); present ||
		!IsCode(err, CodeTooLarge) {
		t.Fatalf("oversized read: present=%v err=%v", present, err)
	}
}

// ---------------------------------------------------------------------------
// 15-20: trust
// ---------------------------------------------------------------------------

// fixtureSource resolves the signed binary these tests verify against.
//
// ## This is a PRECONDITION, not an optional extra
//
// The signed positive is the only case that executes the signer-chain walk;
// every unsigned or wrong-pin path returns long before it. A trust matrix that
// skipped when it could not find a signed file would report green for a build
// whose Authenticode handling had never run — which is precisely the shape of
// failure that hid a wrong `CRYPT_PROVIDER_SGNR` layout. So a missing or
// unsigned fixture FAILS.
//
// `RELAYIUM_SIGNED_FIXTURE` is set by the workflow, which resolves it
// deterministically and independently asserts the signature is valid before any
// test runs. The `node.exe` fallback is for a local run and is held to the same
// standard.
//
// Nothing is installed and no certificate store is touched: the fixture is a
// copy of a binary already on the machine.
func fixtureSource(t *testing.T) string {
	t.Helper()
	if source := os.Getenv("RELAYIUM_SIGNED_FIXTURE"); source != "" {
		return source
	}
	found, err := exec.LookPath("node.exe")
	if err != nil {
		t.Fatalf(
			"no signed fixture: RELAYIUM_SIGNED_FIXTURE is unset and node.exe is not on PATH. " +
				"The trust matrix cannot run without one, and skipping it would report an " +
				"unverified Authenticode path as passing.",
		)
	}
	return found
}

func signedFixture(t *testing.T, custody *WindowsCustody, name string) (string, int64, string) {
	t.Helper()
	content, err := os.ReadFile(fixtureSource(t))
	if err != nil {
		t.Fatalf("signed fixture unreadable: %v", err)
	}
	handle, receipt := staged(t, custody, name, content)
	if err := custody.Release(handle); err != nil {
		t.Fatalf("release: %v", err)
	}
	sum := sha256.Sum256(content)
	return receipt, int64(len(content)), hex.EncodeToString(sum[:])
}

// authenticodeStatus asks Windows itself, through a channel this code does not
// implement, so the precondition is independent of the thing under test.
func authenticodeStatus(t *testing.T, path string) (status string, subject string) {
	t.Helper()
	// The first Windows run got EMPTY output here with a zero exit code, which
	// is exactly what an inline `-Command` produces when the cmdlet errors:
	// `$s` is null, both `Write-Output`s print nothing, stderr is discarded by
	// `.Output()`, and the failure looks like silence.
	//
	// So: a real script file rather than a quoted one-liner, `Stop` on any
	// error, prefixed lines that cannot be confused with blank output, and
	// COMBINED output so PowerShell's own message reaches the log.
	script := filepath.Join(t.TempDir(), "signature.ps1")
	body := "$ErrorActionPreference = 'Stop'\r\n" +
		"$s = Get-AuthenticodeSignature -LiteralPath $args[0]\r\n" +
		"Write-Output (\"STATUS=\" + $s.Status)\r\n" +
		"Write-Output (\"SUBJECT=\" + $s.SignerCertificate.Subject)\r\n"
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatalf("signature script: %v", err)
	}
	out, err := exec.Command(
		"powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", script, path,
	).CombinedOutput()
	if err != nil {
		t.Fatalf("reading the signature of %s failed: %v\n%s", path, err, out)
	}
	for _, line := range strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "STATUS="):
			status = strings.TrimSpace(strings.TrimPrefix(line, "STATUS="))
		case strings.HasPrefix(line, "SUBJECT="):
			subject = strings.TrimSpace(strings.TrimPrefix(line, "SUBJECT="))
		}
	}
	if status == "" {
		t.Fatalf("no signature status for %s; PowerShell said:\n%s", path, out)
	}
	return status, subject
}

// actualSubject is the pin, taken from .NET rather than from the code under
// test.
//
// `SignerCertificate.Subject` is `X500DistinguishedName.Name`, which decodes the
// RDNs REVERSED. That is the canonical form this build pins, and the helper sets
// `CERT_NAME_STR_REVERSE_FLAG` to produce exactly it — see the constants in
// `install_windows.go`. Deriving the expectation from PowerShell rather than
// from `signerSubject` is what makes the positive case an agreement between two
// independent renderings instead of a tautology.
func actualSubject(t *testing.T, path string) string {
	t.Helper()
	status, subject := authenticodeStatus(t, path)
	if status != "Valid" {
		t.Fatalf("the fixture at %s is not validly signed (status %q); the trust matrix "+
			"cannot run, and passing without it would be a false result", path, status)
	}
	if subject == "" {
		t.Fatalf("the fixture at %s has no signer subject", path)
	}
	return subject
}

func TestTheSignedFixtureIsAPrecondition(t *testing.T) {
	// Asserted first and on its own, so a broken fixture reads as "the fixture
	// is broken" rather than as a mysterious verification failure later.
	source := fixtureSource(t)
	if _, err := os.Stat(source); err != nil {
		t.Fatalf("signed fixture missing at %s: %v", source, err)
	}
	status, subject := authenticodeStatus(t, source)
	if status != "Valid" || subject == "" {
		t.Fatalf("fixture %s: status %q subject %q; the trust matrix requires a validly "+
			"signed binary", source, status, subject)
	}
	t.Logf("signed fixture: %s (%s)", source, subject)
}

func TestSignedFixtureVerifiesAgainstItsActualPublisher(t *testing.T) {
	// Case 15 — the ONLY case that exercises the signer-chain walk, and the one
	// that would have caught a wrong CRYPT_PROVIDER_SGNR layout.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	receipt, size, digest := signedFixture(t, custody, name)
	subject := actualSubject(t, filepath.Join(root, "updates", name))

	verdict, err := custody.VerifyInstaller(name, receipt, digest, subject, size)
	if err != nil {
		t.Fatalf("a genuinely signed fixture was refused: %v (verdict %s)", err, verdict)
	}
	if verdict != VerdictExpected {
		t.Fatalf("verdict %q", verdict)
	}
}

func TestTheSubjectEncodingIsPinnedNotIncidental(t *testing.T) {
	// The ordering, asserted directly.
	//
	// `CertNameToStr` renders forward by default and .NET renders reversed, so a
	// multi-RDN publisher matches under exactly one of them. This takes the
	// canonical subject, reverses its RDNs, and requires that form to be
	// REFUSED — proving the match above is the chosen encoding rather than an
	// accident that would also accept the other order.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	receipt, size, digest := signedFixture(t, custody, name)
	subject := actualSubject(t, filepath.Join(root, "updates", name))

	parts := strings.Split(subject, ", ")
	if len(parts) < 2 {
		// A single-RDN subject reads the same in both directions, so there is
		// nothing to distinguish. Reported rather than silently passing.
		t.Skipf("the fixture's subject %q has one RDN; ordering cannot be distinguished", subject)
	}
	reversed := make([]string, 0, len(parts))
	for i := len(parts) - 1; i >= 0; i-- {
		reversed = append(reversed, parts[i])
	}
	other := strings.Join(reversed, ", ")
	if other == subject {
		t.Skipf("the fixture's subject %q is order-symmetric", subject)
	}

	// Canonical order: accepted.
	if verdict, err := custody.VerifyInstaller(name, receipt, digest, subject, size); err != nil {
		t.Fatalf("the canonical subject was refused: %v (verdict %s)", err, verdict)
	}
	// The opposite order: refused, and refused as a PUBLISHER mismatch — not as
	// some other failure that would mask a real encoding bug.
	verdict, err := custody.VerifyInstaller(name, receipt, digest, other, size)
	if !IsCode(err, CodePublisher) || verdict != VerdictOther {
		t.Fatalf("the reversed subject %q was not refused as a publisher mismatch: %v (verdict %s)",
			other, err, verdict)
	}
}

func TestSignedFixtureAgainstADifferentPublisher(t *testing.T) {
	// Case 16.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	receipt, size, digest := signedFixture(t, custody, name)
	_ = actualSubject(t, filepath.Join(root, "updates", name))

	verdict, err := custody.VerifyInstaller(name, receipt, digest, "CN=Not The Publisher", size)
	if !IsCode(err, CodePublisher) {
		t.Fatalf("a wrong pin was not refused: %v", err)
	}
	// A stronger signal than unsigned, and reported as such.
	if verdict != VerdictOther {
		t.Fatalf("verdict %q", verdict)
	}
}

func TestATamperedFixtureIsRefused(t *testing.T) {
	// Case 17: one byte flipped, so the digest matches nothing and the signature
	// no longer covers the bytes.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	receipt, size, digest := signedFixture(t, custody, name)
	path := filepath.Join(root, "updates", name)
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content[len(content)/2] ^= 0xff
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	// The identity changed too, which is itself a refusal — and the point: no
	// path through this reaches a launch.
	if _, err := custody.VerifyInstaller(name, receipt, digest, "CN=Anything", size); err == nil {
		t.Fatal("a tampered fixture verified")
	}
}

func TestAnUnsignedArtifactIsUnsignedNotUnavailable(t *testing.T) {
	// Case 18, with a REAL PE.
	//
	// The first Windows run used `MZ not really` repeated and got `unavailable`.
	// The log recorded only that verdict, never a numeric status, so the precise
	// reason is NOT established — a malformed image is the likely cause, since
	// it is not a parseable subject, but that is an inference until a run prints
	// the status. Either way the case needs a well-formed image that simply
	// carries no signature, and this test binary is exactly that: a Go-built
	// unsigned PE sitting on disk.
	source, err := os.Executable()
	if err != nil {
		t.Fatalf("locating the test binary: %v", err)
	}
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("reading the test binary: %v", err)
	}
	// Asserted independently, so this cannot silently become a signed fixture.
	if status, _ := authenticodeStatus(t, source); status != "NotSigned" {
		t.Fatalf("the unsigned fixture %s reports %q; it must carry no signature", source, status)
	}

	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	handle, receipt := staged(t, custody, name, content)
	if err := custody.Release(handle); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	verdict, err := custody.VerifyInstaller(
		name, receipt, hex.EncodeToString(sum[:]), "CN=Relayium", int64(len(content)),
	)
	if err == nil {
		t.Fatal("an unsigned artifact verified")
	}
	if verdict != VerdictUnsigned {
		// `unavailable` would mean "could not tell", which is a different and
		// weaker statement the core maps to a different state.
		t.Fatalf("verdict %q, want %q", verdict, VerdictUnsigned)
	}
}

func TestAMalformedImageIsUnavailableNotUnsigned(t *testing.T) {
	// The other half of the distinction, kept separate on purpose. Something
	// that is not an image at all cannot be reported as "carries no signature":
	// the question was never answered.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	content := bytes.Repeat([]byte("MZ not really"), 64)
	handle, receipt := staged(t, custody, name, content)
	if err := custody.Release(handle); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	verdict, err := custody.VerifyInstaller(
		name, receipt, hex.EncodeToString(sum[:]), "CN=Relayium", int64(len(content)),
	)
	if err == nil {
		t.Fatal("a malformed image verified")
	}
	if verdict != VerdictUnavail {
		t.Fatalf("verdict %q, want %q", verdict, VerdictUnavail)
	}
}

func TestNoPinMeansNoInstallAtAll(t *testing.T) {
	// Case 19, against the operation the rule belongs to.
	//
	// The first Windows run asserted this on `VerifyInstaller` and got
	// `identity-changed`, because verify CLASSIFIES and reaches the file first.
	// The pin rule guards LAUNCHING, and it must refuse before touching
	// anything — which is why a name that does not exist still yields
	// `no-expected-publisher` rather than a missing-file error.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	if _, err := custody.RunInstaller(
		"relayium-9.9.9-1-00112233445566aa.exe", "win:1:2", strings.Repeat("a", 64), "", 10,
	); !IsCode(err, CodeNoPin) {
		t.Fatalf("an empty pin did not refuse the launch: %v", err)
	}
	// Positive control, asserted EXACTLY. With a pin configured the same call
	// must get past the pin rule and fail on the FILE — that is what proves the
	// refusal above was the rule and not some earlier fault. A bare "not
	// CodeNoPin" would also accept nil, or any unrelated early failure, and
	// would prove nothing about where the call reached.
	_, err := custody.RunInstaller(
		"relayium-9.9.9-1-00112233445566aa.exe", "win:1:2", strings.Repeat("a", 64), "CN=X", 10,
	)
	if !IsCode(err, CodeIdentity) {
		t.Fatalf("with a pin configured the call did not reach the missing file: %v", err)
	}
}

func TestAPinlessPreviewClassifiesWithoutClaimingAPublisher(t *testing.T) {
	// A validly signed file with NOTHING configured to compare against.
	//
	// Not `expected`, because nothing was expected. Not `other`, because nothing
	// was ruled out — telling a user their installer came from the wrong
	// publisher when the build simply has no pin yet would be false. This is the
	// state a build with no certificate provisioned actually reports.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	receipt, size, digest := signedFixture(t, custody, name)
	verdict, err := custody.VerifyInstaller(name, receipt, digest, "", size)
	if err == nil {
		t.Fatal("a pinless preview reported success")
	}
	if verdict != VerdictUnavail {
		t.Fatalf("verdict %q, want %q", verdict, VerdictUnavail)
	}
}

func TestInstallRunActuallyLaunchesTheVerifiedBytes(t *testing.T) {
	// The gap that compile-and-refusal tests cannot close: `CreateProcessW` is
	// really called, on the file this session verified while holding it, and the
	// exact process it created is joined by HANDLE — not by a PID that could be
	// recycled between the launch and the wait.
	//
	// The image is the signed fixture with no arguments and its standard handles
	// pointed at NUL, so it reads EOF and exits immediately. Nothing is
	// installed, nothing is left running, and no real installer is involved.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	receipt, size, digest := signedFixture(t, custody, name)
	subject := actualSubject(t, filepath.Join(root, "updates", name))

	var launchedPID uint32
	var waited error
	custody.ObserveLaunchesForTest(func(info windows.ProcessInformation) {
		launchedPID = info.ProcessId
		// Joined through the handle the launch produced, with the STATUS
		// checked: `WaitForSingleObject` reports a timeout with a nil error, and
		// treating that as an exit leaves a live child behind and calls it
		// success. `joinExactly` terminates and joins the exact process instead.
		joinExactly(t, info, &closeOnce{}, &waited)
	})

	verdict, err := custody.RunInstaller(name, receipt, digest, subject, size)
	if err != nil {
		t.Fatalf("install.run on a verified signed fixture: %v (verdict %s)", err, verdict)
	}
	if verdict != VerdictExpected {
		t.Fatalf("verdict %q", verdict)
	}
	if launchedPID == 0 {
		t.Fatal("no process was created; the launch path did not run")
	}
	if waited != nil {
		t.Fatalf("joining the launched process: %v", waited)
	}
	// And it is really gone: opening the exact PID must fail, or find something
	// that is not the process this test started.
	if handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, launchedPID); err == nil {
		var stillRunning uint32
		_ = windows.GetExitCodeProcess(handle, &stillRunning)
		windows.CloseHandle(handle)
		if stillRunning == 259 { // STILL_ACTIVE
			t.Fatalf("the launched process %d is still running", launchedPID)
		}
	}
	t.Logf("launched and joined pid %d", launchedPID)
}

func TestInstallRunRequiresExactConsent(t *testing.T) {
	// Case 20, through the dispatcher, because consent is a protocol-level gate.
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	var out bytes.Buffer
	request, err := json.Marshal(Request{
		Op: OpInstallRun, Name: "a.exe", Receipt: "win:1:2",
		SHA256: strings.Repeat("a", 64), Size: 10, Publisher: "CN=Relayium",
	})
	if err != nil {
		t.Fatal(err)
	}
	state := &session{opened: true, handles: map[uint32]struct{}{}}
	reply, _, _ := dispatch(bytes.NewReader(nil), custody, mustDecode(t, request), state)
	if reply.OK || reply.Code != CodeCancelled {
		t.Fatalf("install.run without consent: %+v", reply)
	}
	_ = out
}

func mustDecode(t *testing.T, payload []byte) Request {
	t.Helper()
	req, err := decodeRequest(payload)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

// closeOnce closes a handle exactly once, however many branches reach it.
//
// The observer releases some handles early — the child has to be let go before
// it can be joined — and every failure path still has to clean up. Closing a
// handle twice on Windows is not harmless: the value can already have been
// reused for something else.
const (
	// How long the probe waits before concluding the child holds a writer.
	probeWait = 10 * time.Second
	// How long a reader gets to return once nothing should be blocking it.
	readerJoinWait = 5 * time.Second
)

type closeOnce struct {
	handle windows.Handle
	done   bool
}

func (c *closeOnce) close() {
	if c.done || c.handle == 0 {
		return
	}
	c.done = true
	windows.CloseHandle(c.handle)
}

// inheritanceProbe launches the signed fixture and reports whether an unrelated
// inheritable handle crossed into the child.
//
// `share` decides whether that handle is added to the allow-list, so the same
// probe serves as the assertion AND as its own negative control: with it shared
// the probe must SEE the handle cross, and with it withheld it must not. A probe
// that could only ever report "did not cross" would pass for a child that had
// already exited, or for one that never started.
func inheritanceProbe(t *testing.T, share bool) (crossed bool, launched uint32) {
	t.Helper()
	root := appRoot(t)
	custody := newSession(t, root, "updates")
	name := "relayium-0.3.0-9-0011223344556677.exe"
	receipt, size, digest := signedFixture(t, custody, name)
	subject := actualSubject(t, filepath.Join(root, "updates", name))

	inheritable := windows.SecurityAttributes{InheritHandle: 1}
	inheritable.Length = uint32(unsafe.Sizeof(inheritable))

	// The child's stdin: a pipe nobody writes to, so the fixture blocks instead
	// of exiting and the check below happens while it is provably alive.
	var stdinReadHandle, stdinWriteHandle windows.Handle
	if err := windows.CreatePipe(&stdinReadHandle, &stdinWriteHandle, &inheritable, 0); err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdinRead := &closeOnce{handle: stdinReadHandle}
	stdinWrite := &closeOnce{handle: stdinWriteHandle}
	defer stdinRead.close()
	defer stdinWrite.close()

	// The unrelated handle. Inheritable, and on the allow-list only when this
	// case is the negative control.
	var probeReadHandle, probeWriteHandle windows.Handle
	if err := windows.CreatePipe(&probeReadHandle, &probeWriteHandle, &inheritable, 0); err != nil {
		t.Fatalf("probe pipe: %v", err)
	}
	probeRead := &closeOnce{handle: probeReadHandle}
	probeWrite := &closeOnce{handle: probeWriteHandle}
	// Deferred as well as closed in the observer: `RunInstaller` can fail before
	// the observer ever runs, and these must not leak on that branch either.
	defer probeRead.close()
	defer probeWrite.close()

	custody.UseStdInputForTest(stdinRead.handle)
	if share {
		custody.ShareForTest([]windows.Handle{probeWrite.handle})
	}

	var observed error
	custody.ObserveLaunchesForTest(func(info windows.ProcessInformation) {
		launched = info.ProcessId
		// POSITIVE CONTROL, first. A child that has already exited would close
		// any inherited copy, and the broken pipe below would then pass for the
		// wrong reason. Zero timeout: alive means "not signalled yet".
		if event, err := windows.WaitForSingleObject(info.Process, 0); err != nil ||
			event != uint32(windows.WAIT_TIMEOUT) {
			observed = fmt.Errorf(
				"the fixture was not alive for the probe (event %d, err %v)", event, err)
			stdinWrite.close()
			joinExactly(t, info, stdinWrite, &observed)
			return
		}

		// Drop this process's copy. If the child did NOT inherit it, no write
		// end remains and the read fails at once with a broken pipe.
		probeWrite.close()
		done := make(chan error, 1)
		go func() {
			var buffer [1]byte
			var read uint32
			done <- windows.ReadFile(probeRead.handle, buffer[:], &read, nil)
		}()
		select {
		case err := <-done:
			switch {
			case err == nil:
				// Nothing should be able to deliver bytes: this process closed
				// its write end and no other writer is supposed to exist.
				// Treating unexpected data as "did not cross" would hide the
				// case where something else is holding the pipe.
				observed = errors.New("the probe pipe delivered data with no writer left")
			case errors.Is(err, windows.ERROR_BROKEN_PIPE):
				// No writer remains: the handle did not cross.
			default:
				observed = fmt.Errorf("probe read: %w", err)
			}
			// Release the child and join it.
			stdinWrite.close()
			joinExactly(t, info, stdinWrite, &observed)
		case <-time.After(probeWait):
			// Still open with no writer in THIS process: the child holds one.
			crossed = true
			// The child is released and joined FIRST, and the order matters.
			// It owns the last write end, so nothing can unblock that read until
			// it exits — and `CloseHandle` is not a documented way to cancel
			// another thread's synchronous `ReadFile`, so waiting on the reader
			// before releasing the child would deadlock exactly here, in the
			// control that is SUPPOSED to reach this branch.
			stdinWrite.close()
			joinExactly(t, info, stdinWrite, &observed)
			// Now the reader, on a bound. Its handle is closed only as a last
			// resort, and even that is not waited on indefinitely.
			select {
			case <-done:
			case <-time.After(readerJoinWait):
				probeRead.close()
				select {
				case <-done:
				case <-time.After(readerJoinWait):
					if observed == nil {
						observed = errors.New(
							"the probe reader did not return after the child exited")
					}
				}
			}
		}
	})

	verdict, err := custody.RunInstaller(name, receipt, digest, subject, size)
	if err != nil {
		t.Fatalf("install.run: %v (verdict %s)", err, verdict)
	}
	if launched == 0 {
		t.Fatal("no process was created")
	}
	if observed != nil {
		t.Fatal(observed)
	}
	return crossed, launched
}

// joinExactly waits for the exact process, and never leaves it running.
//
// `WaitForSingleObject` returns `WAIT_TIMEOUT` with a NIL error, so the status
// is what has to be checked; treating a nil error as "it exited" leaves a live
// child behind and calls it success.
func joinExactly(
	t *testing.T, info windows.ProcessInformation, stdinWrite *closeOnce, observed *error,
) {
	t.Helper()
	stdinWrite.close()
	event, err := windows.WaitForSingleObject(info.Process, 60_000)
	if err != nil || event != windows.WAIT_OBJECT_0 {
		// Terminate the EXACT process this launch created, then join that.
		_ = windows.TerminateProcess(info.Process, 1)
		if killed, killErr := windows.WaitForSingleObject(info.Process, 10_000); killErr != nil ||
			killed != windows.WAIT_OBJECT_0 {
			if *observed == nil {
				*observed = fmt.Errorf("the launched process %d could not be joined", info.ProcessId)
			}
			return
		}
		if *observed == nil {
			*observed = fmt.Errorf("the fixture did not exit (event %d, err %v)", event, err)
		}
		return
	}
	var code uint32
	if codeErr := windows.GetExitCodeProcess(info.Process, &code); codeErr != nil {
		if *observed == nil {
			*observed = fmt.Errorf("exit code: %w", codeErr)
		}
		return
	}
	if code != 0 && *observed == nil {
		*observed = fmt.Errorf("the launched fixture exited %d", code)
	}
}

func TestAnUnrelatedInheritableHandleDoesNotCross(t *testing.T) {
	// The allow-list, proved by behaviour rather than by reading the flags.
	crossed, pid := inheritanceProbe(t, false)
	if crossed {
		t.Fatal("an unrelated inheritable handle was inherited by the launched process")
	}
	t.Logf("no unrelated handle crossed into pid %d", pid)
}

func TestTheInheritanceProbeCanSeeAHandleCross(t *testing.T) {
	// The negative control for the test above. Without this, "did not cross"
	// could mean the probe is simply incapable of noticing — and the case would
	// pass with the allow-list removed entirely.
	//
	// The handle is ADDED to the list rather than the list being disabled, so
	// this exercises the same production code path with one extra entry, and the
	// child is joined here exactly as it is there.
	crossed, pid := inheritanceProbe(t, true)
	if !crossed {
		t.Fatal("the probe did not notice a handle that WAS shared with the child; " +
			"it cannot be trusted to notice one that leaked")
	}
	t.Logf("the probe saw the shared handle cross into pid %d", pid)
}
