package selfupdate

import (
	"context"
	"errors"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// withRealVersionCheck restores the production version probe for one test
// (TestMain stubs it out for the plain-text legacy fixtures).
func withRealVersionCheck(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("self-update is Unix-only; the stubs are shell scripts")
	}
	prev := verifyBinaryVersionHook
	verifyBinaryVersionHook = runBinaryVersionCheck
	t.Cleanup(func() { verifyBinaryVersionHook = prev })
}

// stubCLI is a "relayium" that answers `version` the way goreleaser builds do
// (bare version, no "v") and anything else with a marker.
func stubCLI(printed string) string {
	return "#!/bin/sh\nif [ \"$1\" = version ]; then echo '" + printed + "'; exit 0; fi\necho not-version; exit 3\n"
}

// A v0.21 build (validly signed, it was a real release) re-served under the
// newer tag v0.30.0: the tag passes the floor and the downgrade check, so only
// the binary's own answer can catch it.
func TestUpdateRefusesOldBinaryUnderNewTag(t *testing.T) {
	withRealVersionCheck(t)
	fr := &fakeRelease{tag: "v0.30.0", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, stubCLI("0.21.0"))}
	srv := fr.server(t)
	defer srv.Close()

	target := writeTarget(t, "CURRENT")
	o := baseOpts(srv, target)
	o.CurrentVersion = "v0.25.0"
	_, _, changed, err := Update(context.Background(), o, io.Discard)
	if err == nil || changed {
		t.Fatalf("an old binary under a new tag must be refused, got changed=%v err=%v", changed, err)
	}
	if !errors.Is(err, ErrVerify) || !strings.Contains(err.Error(), `"0.21.0"`) {
		t.Fatalf("want an ErrVerify naming the reported version, got %v", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "CURRENT" {
		t.Fatalf("binary must be untouched, got %q", got)
	}
	assertNoUpdateTemps(t, target)
}

func TestUpdateAcceptsBinaryMatchingTag(t *testing.T) {
	withRealVersionCheck(t)
	for _, printed := range []string{"0.30.0", "v0.30.0"} {
		body := stubCLI(printed)
		fr := &fakeRelease{tag: "v0.30.0", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, body)}
		srv := fr.server(t)
		target := writeTarget(t, "CURRENT")
		o := baseOpts(srv, target)
		o.CurrentVersion = "v0.25.0"
		if _, _, changed, err := Update(context.Background(), o, io.Discard); err != nil || !changed {
			srv.Close()
			t.Fatalf("printed %q: changed=%v err=%v", printed, changed, err)
		}
		srv.Close()
		if got, _ := os.ReadFile(target); string(got) != body {
			t.Fatalf("printed %q: target not replaced", printed)
		}
	}
}

// --force is a rollback lever for the tag, not a waiver of what the tag's
// archive contains.
func TestUpdateForceStillChecksBinaryVersion(t *testing.T) {
	withRealVersionCheck(t)
	fr := &fakeRelease{tag: "v0.30.0", asset: AssetName(runtime.GOOS, runtime.GOARCH), archive: tarGzWith(t, stubCLI("0.21.0"))}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "CURRENT")
	o := baseOpts(srv, target)
	o.Force = true
	if _, _, _, err := Update(context.Background(), o, io.Discard); !errors.Is(err, ErrVerify) {
		t.Fatalf("want ErrVerify, got %v", err)
	}
	if got, _ := os.ReadFile(target); string(got) != "CURRENT" {
		t.Fatalf("binary must be untouched, got %q", got)
	}
}

func TestBinaryVersionCheckFailures(t *testing.T) {
	withRealVersionCheck(t)
	dir := t.TempDir()
	write := func(name, body string) string {
		p := dir + "/" + name
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	cases := map[string]string{
		"no-version-command": "#!/bin/sh\necho unknown command >&2\nexit 2\n",
		"empty":              "#!/bin/sh\nexit 0\n",
		"dev":                "#!/bin/sh\necho dev\n",
		"flood":              "#!/bin/sh\nhead -c 4096 /dev/zero | tr '\\0' 'x'\n",
		"not-executable":     "\x7fELF-garbage",
	}
	for name, body := range cases {
		err := runBinaryVersionCheck(context.Background(), write(name, body), "v0.30.0")
		if !errors.Is(err, ErrVerify) {
			t.Errorf("%s: want ErrVerify, got %v", name, err)
		}
	}
}

func TestBinaryVersionCheckIsBounded(t *testing.T) {
	withRealVersionCheck(t)
	p := t.TempDir() + "/relayium"
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexec sleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := runBinaryVersionCheck(ctx, p, "v0.30.0")
	if !errors.Is(err, ErrVerify) {
		t.Fatalf("want ErrVerify, got %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("probe was not bounded: took %s", d)
	}
}

// The node's binary is never executed as a probe: an old relayium-node given an
// unknown argument starts the relay (as root, under the updater). Its version
// binding is the post-restart health check (waitHealthy requires the new
// process to report the target version, else rollback + blacklist).
func TestUpdateDoesNotExecNodeBinary(t *testing.T) {
	withRealVersionCheck(t)
	asset := AssetNameFor("relayium-node", runtime.GOOS, runtime.GOARCH)
	fr := &fakeRelease{tag: "v0.30.0", asset: asset, archive: tarGzNamed(t, "relayium-node", "NODE-BINARY-NOT-EXECUTABLE")}
	srv := fr.server(t)
	defer srv.Close()
	target := writeTarget(t, "OLD")
	o := baseOpts(srv, target)
	o.AssetPrefix, o.BinaryName = "relayium-node", "relayium-node"
	if _, _, changed, err := Update(context.Background(), o, io.Discard); err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
}

func assertNoUpdateTemps(t *testing.T, target string) {
	t.Helper()
	entries, err := os.ReadDir(dirOf(target))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".relayium-update-") {
			t.Fatalf("left a temp file behind: %s", e.Name())
		}
	}
}

func dirOf(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return "."
}
