//go:build !windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
)

// strictFixture lays out the Root R2 probe's data: an identical keep.txt (same
// bytes, size and mtime) on both sides, a stale file only on the receiver, and
// a sibling outside the mirrored root.
func strictFixture(t *testing.T) (src, dst string) {
	t.Helper()
	src, dst = t.TempDir(), t.TempDir()
	tm := time.Unix(1_700_000_000, 0)
	for _, d := range []string{src, dst} {
		p := filepath.Join(d, "tree", "keep.txt")
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("same"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, tm, tm); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range map[string]string{"tree/stale.txt": "keep until capability confirmed", "sibling.txt": "outside"} {
		if err := os.WriteFile(filepath.Join(dst, filepath.FromSlash(name)), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return src, dst
}

// treeSnapshot is every path under dir with its bytes.
func treeSnapshot(t *testing.T, dir string) string {
	t.Helper()
	var b strings.Builder
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		b.WriteString(rel + "|" + info.Mode().String() + "|")
		if info.Mode().IsRegular() {
			c, _ := os.ReadFile(p)
			b.Write(c)
		}
		b.WriteString("\n")
		return nil
	})
	return b.String()
}

func strictSync(t *testing.T, sendCfg, src string, port int) (int, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run([]string{"sync", "--config-dir", sendCfg, "--delete", "--checksum", "--strict-delete",
		filepath.Join(src, "tree"), daemonScheme + "127.0.0.1:" + strconv.Itoa(port)}, &out, &errOut)
	return code, errOut.String()
}

// A CURRENT `serve --once --allow-delete` answers the preflight and runs the
// strict mirror on the same connection: the stale file goes, keep.txt and the
// sibling stay, and the listener's single transfer succeeds.
func TestE2EStrictSyncCurrentServeOnce(t *testing.T) {
	bin := buildCLIExe(t)
	sendCfg, recvCfg := t.TempDir(), t.TempDir()
	id, err := secure.LoadOrCreateIdentity(sendCfg)
	if err != nil {
		t.Fatal(err)
	}
	if o, e, code := runBounded(t, e2eToolTimeout, bin, []string{"authorize", "--config-dir", recvCfg, id.Fingerprint}, "", nil); code != 0 {
		t.Fatalf("authorize: %d %s %s", code, o, e)
	}
	src, dst := strictFixture(t)
	port, wait := startServeProcOnce(t, bin, "--dir", dst, "--config-dir", recvCfg, "--allow-delete", "--once")
	code, stderr := strictSync(t, sendCfg, src, port)
	if code != 0 {
		t.Fatalf("strict sync to a current listener: exit %d\n%s", code, stderr)
	}
	if serveCode, _ := wait(); serveCode != 0 {
		t.Fatalf("serve --once exited %d", serveCode)
	}
	if _, err := os.Stat(filepath.Join(dst, "tree", "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("the intended stale file survived")
	}
	for name, want := range map[string]string{"tree/keep.txt": "same", "sibling.txt": "outside"} {
		if b, _ := os.ReadFile(filepath.Join(dst, filepath.FromSlash(name))); string(b) != want {
			t.Fatalf("%s = %q", name, b)
		}
	}
}

// A REAL older listener (RELAYIUM_E2E_OLD_RELAYIUM, e.g. v0.27.0) cannot honour
// --checksum/--strict-delete: the command fails, and the receive directory is
// byte-for-byte unchanged -- the stale file the old listener would have deleted
// had it ever been sent Delete is still there. (Trust writes the protocol
// always makes -- the sender's known_hosts entry -- are not "receive
// directory" changes and are not asserted on.)
//
// It uses its own variable, RELAYIUM_E2E_OLD_SYNC: a release that predates
// content checking is not necessarily one that predates `push -`, so sharing
// RELAYIUM_E2E_OLD_RELAYIUM would turn on unrelated old-stdin cases.
func TestE2EStrictSyncOldListenerChangesNothing(t *testing.T) {
	for _, old := range oldSyncRelayiums(t) {
		t.Run(oldVersion(t, old), func(t *testing.T) {
			sendCfg, recvCfg := t.TempDir(), t.TempDir()
			id, err := secure.LoadOrCreateIdentity(sendCfg)
			if err != nil {
				t.Fatal(err)
			}
			if o, e, code := runBounded(t, e2eToolTimeout, old, []string{"authorize", "--config-dir", recvCfg, id.Fingerprint}, "", nil); code != 0 {
				t.Fatalf("authorize: %d %s %s", code, o, e)
			}
			src, dst := strictFixture(t)
			before := treeSnapshot(t, dst)
			port := startServeProc(t, old, "--dir", dst, "--config-dir", recvCfg, "--allow-delete")
			code, stderr := strictSync(t, sendCfg, src, port)
			t.Logf("exit %d stderr:\n%s", code, stderr)
			if code == 0 {
				t.Fatal("an older listener must refuse a strict sync")
			}
			if !strings.Contains(stderr, "no file in the receive directory was written or deleted") {
				t.Fatalf("stderr does not explain the refusal:\n%s", stderr)
			}
			time.Sleep(200 * time.Millisecond) // let the listener finish its side
			if after := treeSnapshot(t, dst); after != before {
				t.Fatalf("the older listener's directory changed:\nbefore:\n%s\nafter:\n%s", before, after)
			}
		})
	}
}

// oldSyncRelayiums lists RELAYIUM_E2E_OLD_SYNC: absolute paths of relayium
// releases that predate content-checked sync, colon-separated.
func oldSyncRelayiums(t *testing.T) []string {
	t.Helper()
	v := os.Getenv("RELAYIUM_E2E_OLD_SYNC")
	if v == "" {
		t.Skip("set RELAYIUM_E2E_OLD_SYNC to old relayium binaries that predate content-checked sync")
	}
	bins := strings.Split(v, ":")
	for _, b := range bins {
		if st, err := os.Stat(b); err != nil || st.IsDir() || !filepath.IsAbs(b) {
			t.Fatalf("RELAYIUM_E2E_OLD_SYNC entry %q is not an absolute path to a binary (%v)", b, err)
		}
	}
	return bins
}
