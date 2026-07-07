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
