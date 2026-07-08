package secure

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateIdentityIdempotent(t *testing.T) {
	dir := t.TempDir()
	id1, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	id2, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if id1.Fingerprint == "" {
		t.Fatal("empty fingerprint")
	}
	if id1.Fingerprint != id2.Fingerprint {
		t.Fatalf("fingerprint not stable: %s != %s", id1.Fingerprint, id2.Fingerprint)
	}
}

func TestCreatedKeyIs0600(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreateIdentity(dir); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "id.key"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("id.key perm = %04o, want 0600", perm)
	}
}

func TestBadKeyPermsRejected(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreateIdentity(dir); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, "id.key")
	if err := os.Chmod(keyPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateIdentity(dir); err == nil {
		t.Fatal("expected refusal to load a world-readable key")
	}
}

func TestServerAnyAndClientAnyReportFingerprints(t *testing.T) {
	client, _ := LoadOrCreateIdentity(t.TempDir())
	server, _ := LoadOrCreateIdentity(t.TempDir())

	c1, c2 := net.Pipe()
	srvFP := make(chan string, 1)
	go func() {
		s, fp, err := ServerAny(c2, server)
		if err == nil {
			s.Close()
		}
		srvFP <- fp
	}()
	c, gotServerFP, err := ClientAny(c1, client)
	if err != nil {
		t.Fatalf("ClientAny: %v", err)
	}
	c.Close()

	// ServerAny admits any client cert and reports its fingerprint...
	if got := <-srvFP; got != client.Fingerprint {
		t.Fatalf("ServerAny reported client fp %q, want %q", got, client.Fingerprint)
	}
	// ...and ClientAny reports the server's fingerprint.
	if gotServerFP != server.Fingerprint {
		t.Fatalf("ClientAny reported server fp %q, want %q", gotServerFP, server.Fingerprint)
	}
}
