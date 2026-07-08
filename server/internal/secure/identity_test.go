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

func TestServerSetAdmitsInSetRejectsOutOfSet(t *testing.T) {
	client, _ := LoadOrCreateIdentity(t.TempDir())
	server, _ := LoadOrCreateIdentity(t.TempDir())

	// In-set: server admits the client.
	if !roundtripServerSet(t, client, server, map[string]bool{client.Fingerprint: true}) {
		t.Fatal("in-set client was rejected")
	}
	// Out-of-set: server rejects (empty allow-list).
	if roundtripServerSet(t, client, server, map[string]bool{}) {
		t.Fatal("out-of-set client was admitted")
	}
}

// roundtripServerSet dials ClientAny → ServerSet over a pipe and reports whether
// the server accepted (handshake succeeded).
func roundtripServerSet(t *testing.T, client, server *Identity, allow map[string]bool) bool {
	t.Helper()
	c1, c2 := net.Pipe()
	srvOK := make(chan bool, 1)
	go func() {
		s, fp, err := ServerSet(c2, server, allow)
		if err == nil {
			s.Close()
		}
		// fp is always reported, even on rejection.
		if fp != client.Fingerprint {
			t.Errorf("ServerSet reported fp %q, want %q", fp, client.Fingerprint)
		}
		srvOK <- err == nil
	}()
	c, _, err := ClientAny(c1, client)
	if err == nil {
		c.Close()
	}
	return <-srvOK
}

func TestClientAnyReportsPeerFingerprint(t *testing.T) {
	client, _ := LoadOrCreateIdentity(t.TempDir())
	server, _ := LoadOrCreateIdentity(t.TempDir())

	c1, c2 := net.Pipe()
	go func() {
		s, _, err := ServerSet(c2, server, map[string]bool{client.Fingerprint: true})
		if err == nil {
			s.Close()
		}
	}()
	c, gotFP, err := ClientAny(c1, client)
	if err != nil {
		t.Fatalf("ClientAny: %v", err)
	}
	c.Close()
	if gotFP != server.Fingerprint {
		t.Fatalf("ClientAny reported peer fp %q, want %q", gotFP, server.Fingerprint)
	}
}
