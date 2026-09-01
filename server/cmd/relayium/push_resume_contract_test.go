package main

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/xfer"
)

// ── what "resume" actually means for push and pull ──────────────────────────
//
// push and pull help used to say the SSH path "behaves like scp with resume",
// and --no-resume is still described by the flag package as "disable resuming
// partial files". Both read as "an interrupted push continues where it left
// off". It does not, and it cannot: an ordinary (non-sync) receive refuses the
// whole batch up front if ANY destination path already exists, and a partial
// file IS an existing path — so the resume negotiation can never see one.
//
// That makes the honest recovery step "send the rest, or use sync", not "run it
// again". This test is the executable half of that claim: if someone ever makes
// push resume for real, it fails here and the help text gets corrected with it.

func TestOrdinaryPushRefusesAPartialDestinationInsteadOfResuming(t *testing.T) {
	srcRoot := t.TempDir()
	full := []byte("0123456789")
	if err := os.WriteFile(filepath.Join(srcRoot, "big.bin"), full, 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := xfer.BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(srcRoot)

	// The destination as an interrupted push would leave it: a short prefix.
	dst := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dst, base), 0o755); err != nil {
		t.Fatal(err)
	}
	partial := filepath.Join(dst, base, "big.bin")
	if err := os.WriteFile(partial, full[:4], 0o644); err != nil {
		t.Fatal(err)
	}

	cSend, cRecv := net.Pipe()
	errc := make(chan error, 1)
	go func() {
		// SendOpts{} — no Sync. This is exactly what `push` sends.
		_, err := xfer.Send(cSend, m, srcs, xfer.SendOpts{})
		cSend.Close()
		errc <- err
	}()
	rep, rerr := xfer.Receive(cRecv, dst, xfer.RecvOpts{})
	cRecv.Close()
	senderErr := <-errc

	if rerr == nil {
		t.Fatalf("an ordinary push onto a partial destination succeeded (report %+v); "+
			"if push can now resume, pushUsage and the top-level --no-resume note must say so", rep)
	}
	if !strings.Contains(rerr.Error(), "destination already exists") {
		t.Errorf("receiver refused with %q, want the destination-exists refusal", rerr)
	}
	if senderErr == nil || !strings.Contains(senderErr.Error(), "destination already exists") {
		t.Errorf("sender was told %v, want the receiver's destination-exists refusal", senderErr)
	}
	// Nothing was written: the partial file is untouched, not extended.
	got, err := os.ReadFile(partial)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(full[:4]) {
		t.Errorf("the partial destination changed to %q; a refused push must write nothing", got)
	}
}

// sync is the mode that does resume, which is what the corrected help points
// people at. Asserted here so "push does not resume" cannot be read as
// "resume does not exist".
//
// The discriminator is the same one internal/xfer uses: seed the destination
// with the WRONG prefix. If the on-disk bytes are reused (resume), the merged
// file cannot match the source SHA-256 and the file is reported failed; if they
// were ignored, the transfer would simply succeed. Counting sent bytes would
// not work — Progress reports the cumulative position, which ends at the file
// size either way.
func TestSyncResumesWherePushRefuses(t *testing.T) {
	full := []byte("0123456789")

	run := func(t *testing.T, prefix []byte) (xfer.Report, []byte) {
		t.Helper()
		srcRoot := t.TempDir()
		if err := os.WriteFile(filepath.Join(srcRoot, "big.bin"), full, 0o644); err != nil {
			t.Fatal(err)
		}
		m, srcs, err := xfer.BuildManifest([]string{srcRoot})
		if err != nil {
			t.Fatal(err)
		}
		base := filepath.Base(srcRoot)
		dst := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dst, base), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, base, "big.bin"), prefix, 0o644); err != nil {
			t.Fatal(err)
		}
		cSend, cRecv := net.Pipe()
		errc := make(chan error, 1)
		go func() {
			_, err := xfer.Send(cSend, m, srcs, xfer.SendOpts{Sync: true})
			cSend.Close()
			errc <- err
		}()
		rep, rerr := xfer.Receive(cRecv, dst, xfer.RecvOpts{})
		cRecv.Close()
		if rerr != nil {
			t.Fatalf("sync onto a partial destination: %v", rerr)
		}
		if serr := <-errc; serr != nil {
			t.Fatalf("sync sender: %v", serr)
		}
		got, err := os.ReadFile(filepath.Join(dst, base, "big.bin"))
		if err != nil {
			t.Fatal(err)
		}
		return rep, got
	}

	// A correct prefix: sync completes the file where push would have refused.
	t.Run("correct prefix completes", func(t *testing.T) {
		rep, got := run(t, full[:4])
		if len(rep.Failed) != 0 {
			t.Fatalf("sync reported failures: %v", rep.Failed)
		}
		if string(got) != string(full) {
			t.Errorf("sync produced %q, want %q", got, full)
		}
	})

	// A wrong prefix: the bytes on disk were reused, so verification fails.
	// That failure IS the proof that resume engaged.
	t.Run("wrong prefix is reused and then caught", func(t *testing.T) {
		rep, got := run(t, []byte("XXXX"))
		if len(rep.Failed) != 1 {
			t.Fatalf("sync reported %v failures, want exactly 1 — the on-disk prefix "+
				"was not reused, so resume did not engage", rep.Failed)
		}
		if string(got) != "XXXX" {
			t.Errorf("the destination is now %q; a file that fails verification must not be installed", got)
		}
	})
}

// And the help must keep saying which is which.
func TestPushAndPullHelpDoNotPromiseResume(t *testing.T) {
	isolatedEnv(t)
	for _, cmd := range []string{"push", "pull"} {
		var stdout, stderr bytes.Buffer
		if rc := Run([]string{cmd, "-h"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("%s -h: rc = %d (%s)", cmd, rc, stderr.String())
		}
		flat := strings.Join(strings.Fields(stdout.String()), " ")
		for _, banned := range []string{
			"scp with resume",
			"Interrupted files resume",
			"interrupted file resumes",
			"resumes on the next run",
			"re-run to finish",
		} {
			if strings.Contains(strings.ToLower(flat), strings.ToLower(banned)) {
				t.Errorf("%s help promises resume (%q), which this mode cannot do:\n%s",
					cmd, banned, stdout.String())
			}
		}
		if !strings.Contains(flat, "does not resume") && !strings.Contains(flat, "not resume") {
			t.Errorf("%s help does not state that it cannot resume:\n%s", cmd, stdout.String())
		}
		// --no-resume is still accepted, so it must be documented as the no-op it is.
		if !strings.Contains(flat, "no-op") {
			t.Errorf("%s help does not say --no-resume is a no-op:\n%s", cmd, stdout.String())
		}
	}
}

// ── the zero-dependency runtime messages ────────────────────────────────────
//
// The tar fallback's two notes used to end at "install relayium on the remote
// for resume" / "for that", where "that" followed "nothing was resumed or
// verified". Both read as "installing relayium makes push resume". It does not:
// the native path is the one the test above puts on a partial destination, and
// it refuses. What installing relayium actually buys is verification, staging
// and an up-front collision report; resume is `sync`.
//
// Asserted on the constants rather than through runPush, which would need a
// real SSH remote lacking relayium.
func TestZeroDependencyNotesDoNotSellInstallingRelayiumAsResume(t *testing.T) {
	// A "sentence" here is what a reader takes as one claim: the split is on
	// terminators, so "install X. Use sync for resume." is two claims and
	// "install X for resume" is one.
	sentences := func(msg string) []string {
		return strings.FieldsFunc(strings.Join(strings.Fields(msg), " "), func(r rune) bool {
			return r == '.' || r == ';'
		})
	}
	for name, msg := range map[string]string{
		"zeroDepPushNote":        zeroDepPushNote,
		"zeroDepPushFailureNote": zeroDepPushFailureNote,
	} {
		for _, sentence := range sentences(msg) {
			low := strings.ToLower(sentence)
			if !strings.Contains(low, "install relayium") {
				continue
			}
			if strings.Contains(low, "resume") {
				t.Errorf("%s offers installing relayium as resume: %q\n"+
					"push does not resume even with relayium on the remote; point at sync instead", name, sentence)
			}
			// And it must say what installing actually gets you.
			for _, want := range []string{"sha-256", "collision"} {
				if !strings.Contains(low, want) {
					t.Errorf("%s: the install sentence %q omits %q", name, sentence, want)
				}
			}
		}
		low := strings.ToLower(msg)
		if !strings.Contains(low, "relayium sync") {
			t.Errorf("%s never names `relayium sync`, the mode that does resume:\n%s", name, msg)
		}
	}
}

// The failure path is where "just run it again" is worst: whatever landed is an
// existing path, and the remote's `tar -x -k` keeps it — including a truncated
// file — instead of replacing it. So the note must send the operator to the
// receiver, not back to the same command.
func TestZeroDependencyFailureNoteDoesNotAdviseABlindRerun(t *testing.T) {
	flat := strings.Join(strings.Fields(zeroDepPushFailureNote), " ")
	low := strings.ToLower(flat)

	for _, banned := range []string{
		"re-run after fixing",
		"re-run the push",
		"run it again",
		"simply retry",
		"just retry",
	} {
		if strings.Contains(low, banned) {
			t.Errorf("the failure note advises a blind re-run (%q):\n%s", banned, zeroDepPushFailureNote)
		}
	}
	// Every mention of re-running must be the one that warns against it.
	for _, sentence := range strings.Split(flat, ". ") {
		sl := strings.ToLower(sentence)
		if !strings.Contains(sl, "re-run") {
			continue
		}
		if !strings.Contains(sl, "do not") {
			t.Errorf("the failure note mentions re-running without warning against it: %q", sentence)
		}
	}
	// And it must name the recovery it does want.
	for _, want := range []string{"inspect", "remove or reconcile", "then retry"} {
		if !strings.Contains(low, want) {
			t.Errorf("the failure note omits %q, so it never says what to do instead:\n%s", want, zeroDepPushFailureNote)
		}
	}
	// The silent-keep mechanism is the reason; without it the advice reads as fussiness.
	for _, want := range []string{"tar -x -k", "truncated"} {
		if !strings.Contains(low, strings.ToLower(want)) {
			t.Errorf("the failure note omits %q, the reason a re-run is unsafe:\n%s", want, zeroDepPushFailureNote)
		}
	}
}
