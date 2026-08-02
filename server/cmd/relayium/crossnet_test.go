package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/rzvous"
)

func TestRunSendNeedsArgs(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run([]string{"send"}, &out, &errb)
	if code == 0 {
		t.Fatal("send with no args should exit non-zero")
	}
	if !strings.Contains(errb.String(), "send") {
		t.Fatalf("stderr should explain send usage, got %q", errb.String())
	}
}

func TestUsageListsSendReceive(t *testing.T) {
	var out, errb bytes.Buffer
	Run(nil, &out, &errb)
	combined := out.String() + errb.String()
	if !strings.Contains(combined, "send") || !strings.Contains(combined, "receive") {
		t.Fatalf("usage should list send/receive, got %q", combined)
	}
}

func TestSplitSendArgs(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(real, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A file whose name is also a well-formed pairing code. The file wins.
	coded := filepath.Join(dir, "K7M4XR")
	if err := os.WriteFile(coded, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name     string
		args     []string
		wantSrcs []string
		wantCode string
		wantErr  bool
	}{
		{"single source mints", []string{real}, []string{real}, "", false},
		{"trailing code is a code", []string{real, "K7M4XR"}, []string{real}, "K7M4XR", false},
		{"two sources mint", []string{real, real}, []string{real, real}, "", false},
		{"code-named file stays a source", []string{real, coded}, []string{real, coded}, "", false},
		{"neither file nor code errors", []string{real, "726122"}, nil, "", true},
		{"no arguments errors", nil, nil, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srcs, code, err := splitSendArgs(tc.args)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got srcs=%v code=%q", srcs, code)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if code != tc.wantCode {
				t.Errorf("code = %q, want %q", code, tc.wantCode)
			}
			if strings.Join(srcs, "|") != strings.Join(tc.wantSrcs, "|") {
				t.Errorf("srcs = %v, want %v", srcs, tc.wantSrcs)
			}
		})
	}
}

// runSendCross must check the sources (xfer.BuildManifest) before minting a
// code: a code starts its expiry clock (signal.CodeTTLSeconds) the instant it's
// minted, and a mistyped path shouldn't burn one. With no credentials on disk, minting
// would fail with the not-logged-in error — so if the mint moved ahead of
// the manifest check, a missing-file send would report "needs an account"
// instead of the missing file, and this test would catch it.
func TestRunSendChecksSourceBeforeMinting(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // no stored credentials
	var out, errb bytes.Buffer
	code := Run([]string{"send", "/nope/nope.zip"}, &out, &errb)
	if code == 0 {
		t.Fatal("send of a missing file should exit non-zero")
	}
	got := errb.String()
	if !strings.Contains(got, "no such file") {
		t.Fatalf("want the missing-file error, got %q", got)
	}
	if strings.Contains(got, "needs an account") {
		t.Fatalf("mint ran before the manifest check (not-logged-in error leaked through): %q", got)
	}
}

// Only "does not exist" makes the last argument a candidate pairing code. Any
// other stat failure means we could not tell, and guessing "code" there hands
// a real filename to the rendezvous while swallowing the error that actually
// stopped the user. Standing in a directory with no traverse bit makes a bare,
// code-shaped relative name fail with EACCES while the file is genuinely there.
func TestSplitSendArgsKeepsAnUnstatableArgumentAsASource(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the missing traverse bit, so os.Stat cannot be made to fail with EACCES here")
	}
	dir := t.TempDir()
	real := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(real, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(dir, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	// A real file that happens to be named like a well-formed code.
	if err := os.WriteFile(filepath.Join(work, "K7M4XR"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	prev, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })
	if err := os.Chmod(work, 0o000); err != nil {
		t.Fatal(err)
	}
	// LIFO: this restores the mode before the Chdir above is undone and before
	// t.TempDir's own cleanup tries to remove the tree.
	t.Cleanup(func() { _ = os.Chmod(work, 0o700) })

	// Precondition. If this platform (or this filesystem) still lets the stat
	// through, or reports plain ENOENT, there is nothing here to exercise.
	if _, statErr := os.Stat("K7M4XR"); statErr == nil || errors.Is(statErr, fs.ErrNotExist) {
		t.Skipf("os.Stat(K7M4XR) = %v; no non-ENOENT stat failure available here", statErr)
	}

	srcs, code, err := splitSendArgs([]string{real, "K7M4XR"})
	if err != nil {
		t.Fatalf("an unstatable argument must stay a source, got error: %v", err)
	}
	if code != "" {
		t.Errorf("code = %q, want none — a file we merely cannot stat is not a pairing code", code)
	}
	if strings.Join(srcs, "|") != strings.Join([]string{real, "K7M4XR"}, "|") {
		t.Errorf("srcs = %v, want both arguments kept as sources", srcs)
	}
}

// The user-visible bug that started this: a made-up numeric code must not
// degrade into "no such file", it must explain what a code is.
func TestSplitSendArgsExplainsAMadeUpCode(t *testing.T) {
	_, _, err := splitSendArgs([]string{"pando_uu.zip", "726122"})
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"726122", "pairing code", "relayium send"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

// modeCommand names a mode as the command the user typed, which is what the
// mismatch error has to say to be actionable. An unknown mode is reported as
// unknown rather than guessed at -- fail closed, and say so.
func TestModeCommandNamesTheCommand(t *testing.T) {
	if got := modeCommand(rzvous.ModeText); !strings.Contains(got, "relayium text") {
		t.Errorf("text mode = %q", got)
	}
	for _, m := range []string{rzvous.ModeFile, ""} {
		got := modeCommand(m)
		if !strings.Contains(got, "relayium send") || !strings.Contains(got, "relayium receive") {
			t.Errorf("file mode %q = %q", m, got)
		}
	}
	got := modeCommand("banana")
	if !strings.Contains(got, "does not know") || !strings.Contains(got, `"banana"`) {
		t.Errorf("unknown mode = %q; must say it is unknown and quote what it saw", got)
	}
}

// The refusal is a pure consequence of ModeCompatible, so pin the pairs the
// production path relies on: an older peer still works, a text peer does not.
func TestCrossnetModePairs(t *testing.T) {
	if !rzvous.ModeCompatible(rzvous.ModeFile, "") {
		t.Error("send/receive must still pair with a peer that predates the mode field")
	}
	if rzvous.ModeCompatible(rzvous.ModeFile, rzvous.ModeText) {
		t.Error("send/receive must refuse a text peer")
	}
	if rzvous.ModeCompatible(rzvous.ModeText, "") {
		t.Error("text must refuse a peer that predates the mode field")
	}
}
