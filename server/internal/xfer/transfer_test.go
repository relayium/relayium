package xfer

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// pipeTransfer wires Send and Receive over an in-memory duplex pipe.
func TestSendReceiveRoundtrip(t *testing.T) {
	srcRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcRoot, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(srcRoot, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcRoot, "d", "b.bin"), []byte("world!!"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	cSend, cRecv := net.Pipe()

	errc := make(chan error, 1)
	go func() {
		_, err := Send(cSend, m, srcs, SendOpts{})
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
		t.Fatalf("unexpected failures: %v", rep.Failed)
	}

	base := filepath.Base(srcRoot)
	got, err := os.ReadFile(filepath.Join(dst, base, "a.txt"))
	if err != nil || string(got) != "hello" {
		t.Fatalf("a.txt = %q err=%v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(dst, base, "d", "b.bin"))
	if err != nil || string(got) != "world!!" {
		t.Fatalf("b.bin = %q err=%v", got, err)
	}
}
