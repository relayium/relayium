package xfer

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestResumeSkipsAlreadyReceivedPrefix(t *testing.T) {
	// Source: one 10-byte file.
	srcRoot := t.TempDir()
	full := []byte("0123456789")
	if err := os.WriteFile(filepath.Join(srcRoot, "big.bin"), full, 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(srcRoot)

	// Destination already holds the correct first 4 bytes.
	dst := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dst, base), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, base, "big.bin"), full[:4], 0o644); err != nil {
		t.Fatal(err)
	}

	cSend, cRecv := net.Pipe()
	errc := make(chan error, 1)
	// Instrument the sender to record the offset it starts from.
	var sentTail int64
	go func() {
		_, err := Send(cSend, m, srcs, SendOpts{Progress: func(_ string, sent, _ int64) {
			sentTail = sent
		}})
		cSend.Close()
		errc <- err
	}()
	rep, err := Receive(cRecv, dst, RecvOpts{})
	cRecv.Close()
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("send: %v", serr)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("failures: %v", rep.Failed)
	}
	got, _ := os.ReadFile(filepath.Join(dst, base, "big.bin"))
	if string(got) != "0123456789" {
		t.Fatalf("resumed file wrong: %q", got)
	}
	// Progress should have started at offset 4 and ended at 10.
	if sentTail != 10 {
		t.Fatalf("final sent = %d, want 10", sentTail)
	}
}

// TestNoResumeForcesFullResend proves RecvOpts{NoResume:true} makes the
// receiver ignore an on-disk prefix and re-send from offset 0. The dest is
// pre-seeded with the WRONG 4 bytes; if resume were (incorrectly) honored the
// merged file would be "XXXX456789" and fail the SHA-256 check. A full resend
// truncates to 0 and yields the correct "0123456789".
func TestNoResumeForcesFullResend(t *testing.T) {
	srcRoot := t.TempDir()
	full := []byte("0123456789")
	if err := os.WriteFile(filepath.Join(srcRoot, "big.bin"), full, 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(srcRoot)

	// Destination holds 4 bytes of WRONG content.
	dst := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dst, base), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, base, "big.bin"), []byte("XXXX"), 0o644); err != nil {
		t.Fatal(err)
	}

	cSend, cRecv := net.Pipe()
	errc := make(chan error, 1)
	go func() {
		_, err := Send(cSend, m, srcs, SendOpts{})
		cSend.Close()
		errc <- err
	}()
	rep, err := Receive(cRecv, dst, RecvOpts{NoResume: true})
	cRecv.Close()
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("send: %v", serr)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("NoResume should re-send in full, but got failures: %v", rep.Failed)
	}
	got, _ := os.ReadFile(filepath.Join(dst, base, "big.bin"))
	if string(got) != "0123456789" {
		t.Fatalf("file after NoResume = %q, want %q", got, "0123456789")
	}
}

// TestResumeStateForDirect exercises resumeStateFor directly so a regression in
// the resume-offset logic fails a test (the end-to-end pipe test above can't:
// a full re-send of a sub-chunk file also ends byte-correct at sentTail==10).
func TestResumeStateForDirect(t *testing.T) {
	// One 10-byte file, built via the same path the real receiver uses.
	srcRoot := t.TempDir()
	full := []byte("0123456789")
	if err := os.WriteFile(filepath.Join(srcRoot, "big.bin"), full, 0o644); err != nil {
		t.Fatal(err)
	}
	m, _, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(srcRoot)

	// Partial (4 of 10 bytes) → exactly one entry {Index:0, Have:4}.
	partial := t.TempDir()
	if err := os.MkdirAll(filepath.Join(partial, base), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(partial, base, "big.bin"), full[:4], 0o644); err != nil {
		t.Fatal(err)
	}
	rs := resumeStateFor(partial, m)
	if len(rs.Entries) != 1 {
		t.Fatalf("partial: want 1 entry, got %d: %+v", len(rs.Entries), rs.Entries)
	}
	if rs.Entries[0].Index != 0 || rs.Entries[0].Have != 4 {
		t.Fatalf("partial: want {Index:0, Have:4}, got %+v", rs.Entries[0])
	}

	// Absent file (empty dest dir) → zero entries.
	if rsAbsent := resumeStateFor(t.TempDir(), m); len(rsAbsent.Entries) != 0 {
		t.Fatalf("absent: want 0 entries, got %+v", rsAbsent.Entries)
	}

	// Complete file (disk size == declared size) → zero entries.
	complete := t.TempDir()
	if err := os.MkdirAll(filepath.Join(complete, base), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(complete, base, "big.bin"), full, 0o644); err != nil {
		t.Fatal(err)
	}
	if rsComplete := resumeStateFor(complete, m); len(rsComplete.Entries) != 0 {
		t.Fatalf("complete: want 0 entries, got %+v", rsComplete.Entries)
	}
}
