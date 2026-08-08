package inboxclient

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

func testNow() time.Time { return time.Unix(1_800_000_000, 0) }

// TestKeyStorePersistsPrivateKeysPrivately is the file-permission half of
// "private keys are local secrets": 0600 inside a 0700 directory, with no window
// in which the bytes exist under looser permissions.
func TestKeyStorePersistsPrivateKeysPrivately(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inbox")
	ks := NewKeyStore(dir)
	kp, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if _, err := ks.Append(kp, testNow()); err != nil {
		t.Fatalf("append: %v", err)
	}
	fi, err := os.Stat(filepath.Join(dir, keysFile))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode = %v, want 0600", fi.Mode().Perm())
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("state directory mode = %v, want 0700", di.Mode().Perm())
	}

	// A pre-existing permissive directory must be tightened, not trusted: a
	// restored backup or a loose umask must not leave private keys readable.
	loose := filepath.Join(t.TempDir(), "loose")
	if err := os.MkdirAll(loose, 0o777); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := NewKeyStore(loose).Append(kp, testNow()); err != nil {
		t.Fatalf("append into a loose dir: %v", err)
	}
	di, _ = os.Stat(loose)
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("pre-existing directory kept mode %v; it must be tightened to 0700", di.Mode().Perm())
	}
}

// TestKeyStoreRetainsSupersededKeys is the reason a HISTORY exists. A task
// sealed before a rotation is still bound to the old key, so dropping it would
// silently strand every delivery already in the queue.
func TestKeyStoreRetainsSupersededKeys(t *testing.T) {
	ks := NewKeyStore(filepath.Join(t.TempDir(), "inbox"))
	first, _ := GenerateKeyPair()
	second, _ := GenerateKeyPair()
	if _, err := ks.Append(first, testNow()); err != nil {
		t.Fatalf("append 1: %v", err)
	}
	if err := ks.BindKeyID(EncodeKeyBytes(first.Public[:]), "key-1", 1); err != nil {
		t.Fatalf("bind 1: %v", err)
	}
	if _, err := ks.Append(second, testNow()); err != nil {
		t.Fatalf("append 2: %v", err)
	}
	if err := ks.BindKeyID(EncodeKeyBytes(second.Public[:]), "key-2", 2); err != nil {
		t.Fatalf("bind 2: %v", err)
	}

	got, found, err := ks.ByKeyID("key-1")
	if err != nil || !found {
		t.Fatalf("the superseded key was lost: found=%v err=%v", found, err)
	}
	if got.Private != first.Private {
		t.Fatal("ByKeyID returned the wrong private key for a superseded generation")
	}
	if got, found, _ := ks.ByKeyID("key-2"); !found || got.Private != second.Private {
		t.Fatal("ByKeyID returned the wrong private key for the current generation")
	}
}

// TestKeyStoreRefusesToReuseOrDoubleBind guards the two ways a history could
// become ambiguous: the same public key twice (a downgrade, which central also
// refuses), and two local records claiming one server key id (which would make
// ByKeyID hand out the wrong private key).
func TestKeyStoreRefusesToReuseOrDoubleBind(t *testing.T) {
	ks := NewKeyStore(filepath.Join(t.TempDir(), "inbox"))
	a, _ := GenerateKeyPair()
	b, _ := GenerateKeyPair()
	if _, err := ks.Append(a, testNow()); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := ks.Append(a, testNow()); err == nil {
		t.Fatal("the same public key was appended twice")
	}
	if err := ks.BindKeyID(EncodeKeyBytes(a.Public[:]), "key-1", 1); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if _, err := ks.Append(b, testNow()); err != nil {
		t.Fatalf("append b: %v", err)
	}
	if err := ks.BindKeyID(EncodeKeyBytes(b.Public[:]), "key-1", 2); err == nil {
		t.Fatal("two local keys were bound to one server key id")
	}
	if err := ks.BindKeyID(EncodeKeyBytes(b.Public[:]), "key-2", 2); err != nil {
		t.Fatalf("legitimate bind refused: %v", err)
	}
}

// TestKeyStoreRefusesAnUnknownFormat: a future on-disk layout must fail loudly
// rather than be parsed optimistically into a history that is missing keys.
func TestKeyStoreRefusesAnUnknownFormat(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inbox")
	if err := ensureSecretDir(dir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, keysFile), []byte(`{"version":99,"keys":[]}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := NewKeyStore(dir).Load(); err == nil {
		t.Fatal("a future key-history version was accepted")
	}
}

// TestEnsureUsableKeyPersistsBeforePublishing is invariant 2, asserted against
// the ordering rather than the outcome: at the moment central is asked to
// publish a key, the private half must ALREADY be on disk. If the process died
// exactly then, the key must be recoverable — the alternative is a published
// public key nobody holds the private half of, which makes every task sealed to
// it permanently undecryptable.
func TestEnsureUsableKeyPersistsBeforePublishing(t *testing.T) {
	f := newFixture(t)
	ks := f.store.Keys()

	// Wrap the client so the durability check runs inside the registration call.
	var onDiskAtPublish bool
	f.client.HTTP = roundTripFunc(f.fc.server.Client(), func(path string) {
		if path == "/api/devices/"+f.fc.deviceID+"/inbox/keys" {
			keys, err := ks.Load()
			onDiskAtPublish = err == nil && len(keys) > 0
		}
	})

	res, err := f.client.Enrol(context.Background(), EnrolRequest{
		Platform: "test", AppVersion: "test",
		ProtocolVersions: ProtocolVersions(), Capabilities: Capabilities(),
		AutoAccept: inbox.AutoAcceptAuto, ReceiveDirReady: true,
	})
	if err != nil {
		t.Fatalf("enrol: %v", err)
	}
	key, err := EnsureUsableKey(context.Background(), f.client, ks, res.Inbox.Key, testNow())
	if err != nil {
		t.Fatalf("EnsureUsableKey: %v", err)
	}
	if !onDiskAtPublish {
		t.Fatal("the private key was not durable when its public half was published")
	}
	if _, found, err := ks.ByKeyID(key.ID); err != nil || !found {
		t.Fatalf("the published key id was not bound locally: found=%v err=%v", found, err)
	}
}

// TestEnsureUsableKeyReconcilesALostRegistrationResponse: the key was registered
// and the response was lost. The repair is to ASK which id it got — minting a
// second key would abandon the first and could strand tasks sealed to it.
func TestEnsureUsableKeyReconcilesALostRegistrationResponse(t *testing.T) {
	f := newFixture(t)
	ks := f.store.Keys()
	ctx := context.Background()
	res, err := f.client.Enrol(ctx, EnrolRequest{
		Platform: "test", AppVersion: "test",
		ProtocolVersions: ProtocolVersions(), Capabilities: Capabilities(),
		AutoAccept: inbox.AutoAcceptAuto, ReceiveDirReady: true,
	})
	if err != nil {
		t.Fatalf("enrol: %v", err)
	}
	if _, err := EnsureUsableKey(ctx, f.client, ks, res.Inbox.Key, testNow()); err != nil {
		t.Fatalf("first: %v", err)
	}

	// Simulate the lost response: the private key stays, the server id is
	// forgotten, exactly as if the process had died after Append.
	keys, err := ks.Load()
	if err != nil || len(keys) != 1 {
		t.Fatalf("unexpected history: %v %v", keys, err)
	}
	before := keys[0].PrivateKey
	keys[0].KeyID, keys[0].Generation = "", 0
	if err := ks.save(keys); err != nil {
		t.Fatalf("save: %v", err)
	}

	f.fc.mu.Lock()
	active := *f.fc.activeKeyLocked()
	f.fc.mu.Unlock()
	got, err := EnsureUsableKey(ctx, f.client, ks, &active, testNow())
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got.ID != active.ID {
		t.Fatalf("reconciled onto key %q, want the existing %q", got.ID, active.ID)
	}
	after, _ := ks.Load()
	if len(after) != 1 {
		t.Fatalf("reconciliation minted a second key: %d records", len(after))
	}
	if after[0].PrivateKey != before {
		t.Fatal("reconciliation replaced the private key instead of binding the existing one")
	}
}

// TestEnsureUsableKeyRotatesWhenCentralsKeyIsNotLocallyUsable is the recovery
// path for a wiped or restored state directory. Central holds a key this device
// cannot open; the device must compare-and-swap onto one it holds rather than
// advertising a device that silently cannot decrypt anything.
func TestEnsureUsableKeyRotatesWhenCentralsKeyIsNotLocallyUsable(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.enrol()
	f.fc.mu.Lock()
	orphan := *f.fc.activeKeyLocked()
	f.fc.mu.Unlock()

	// Wipe the local history: the published key is now unusable here.
	if err := f.store.Keys().Destroy(); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	got, err := EnsureUsableKey(ctx, f.client, f.store.Keys(), &orphan, testNow())
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if got.ID == orphan.ID {
		t.Fatal("the device kept a key it cannot use")
	}
	if _, found, err := f.store.Keys().ByKeyID(got.ID); err != nil || !found {
		t.Fatal("the rotated-onto key is not held locally")
	}
	f.fc.mu.Lock()
	active := f.fc.activeKeyLocked()
	f.fc.mu.Unlock()
	if active == nil || active.ID != got.ID {
		t.Fatal("central's active key is not the one the device rotated onto")
	}
	if active.Generation <= orphan.Generation {
		t.Fatalf("generation did not advance: %d -> %d", orphan.Generation, active.Generation)
	}
}

// TestKeyStoreDestroyRemovesEverything backs `inbox disable`'s final step.
func TestKeyStoreDestroyRemovesEverything(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inbox")
	ks := NewKeyStore(dir)
	kp, _ := GenerateKeyPair()
	if _, err := ks.Append(kp, testNow()); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := ks.Destroy(); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, keysFile)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the key file survived Destroy: %v", err)
	}
	if err := ks.Destroy(); err != nil {
		t.Fatalf("Destroy must be idempotent: %v", err)
	}
	keys, err := ks.Load()
	if err != nil || len(keys) != 0 {
		t.Fatalf("history after destroy: %v %v", keys, err)
	}
}

// roundTripFunc lets a test observe the path of each request as it is made,
// which is how the persist-before-publish ordering is checked from outside.
func roundTripFunc(base *http.Client, observe func(path string)) *http.Client {
	return &http.Client{Transport: observerTransport{base.Transport, observe}}
}

type observerTransport struct {
	next    http.RoundTripper
	observe func(string)
}

func (o observerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	o.observe(r.URL.Path)
	next := o.next
	if next == nil {
		next = http.DefaultTransport
	}
	return next.RoundTrip(r)
}
