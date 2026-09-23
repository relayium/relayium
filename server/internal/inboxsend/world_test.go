package inboxsend

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxmanifest"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
	"github.com/relayium/relayium/internal/storecrypto"
)

// world is one account on a real central with two logins: a sender that never
// enrols, and a target device enrolled through the real protocol with an
// X25519 key this test holds — so a delivery can be opened and checked byte
// for byte. (The real CLI receiver is exercised in cmd/relayium.)
type world struct {
	t      *testing.T
	env    *sendtest.Env
	uid    string
	cfgDir string
	target *device
	notice bytes.Buffer
}

type device struct {
	id     string
	token  string
	client *inboxclient.Client
	keys   map[string]*[32]byte // key id -> private key
	pub    map[string]*[32]byte
}

func newWorld(t *testing.T, maxFile int64) *world {
	t.Helper()
	return newWorldOn(t, sendtest.New(t, maxFile))
}

// newWorldOnNode is newWorld with every upload placed on a fleet storage node.
func newWorldOnNode(t *testing.T, maxFile int64) (*world, *sendtest.Node) {
	t.Helper()
	env, node := sendtest.NewWithNode(t, maxFile)
	return newWorldOn(t, env), node
}

// newFileWorld is newWorld on a file-backed SQLite database.
func newFileWorld(t *testing.T, maxFile int64) *world {
	t.Helper()
	return newWorldOn(t, sendtest.NewOn(t, maxFile, filepath.Join(t.TempDir(), "central.sqlite")))
}

func newWorldOn(t *testing.T, env *sendtest.Env) *world {
	t.Helper()
	w := &world{t: t, env: env, uid: env.User("sender@example.com"), cfgDir: t.TempDir()}
	tok := env.Login(w.uid, "sender-box")
	if err := cloud.Save(w.cfgDir, cloud.Creds{Server: env.TS.URL, AccessToken: tok, AccountEmail: "sender@example.com"}); err != nil {
		t.Fatalf("save creds: %v", err)
	}
	w.target = w.enrol("target-box")
	return w
}

// enrol logs a new device in and enrols it to receive with a fresh key.
func (w *world) enrol(name string) *device {
	w.t.Helper()
	ctx := context.Background()
	tok := w.env.Login(w.uid, name)
	c := inboxclient.NewClient(w.env.TS.URL, tok)
	c.HTTP = &http.Client{Transport: bypassTransport{w.env}}
	me, err := c.CurrentDevice(ctx)
	if err != nil {
		w.t.Fatalf("current device: %v", err)
	}
	c.DeviceID = me.ID
	if _, err := c.Enrol(ctx, inboxclient.EnrolRequest{
		Platform: inboxclient.Platform(), AppVersion: "test", ProtocolVersions: inboxclient.ProtocolVersions(),
		Capabilities: inboxclient.Capabilities(), AutoAccept: inbox.AutoAcceptAuto, ReceiveDirReady: true,
	}); err != nil {
		w.t.Fatalf("enrol: %v", err)
	}
	d := &device{id: me.ID, token: tok, client: c, keys: map[string]*[32]byte{}, pub: map[string]*[32]byte{}}
	d.rotate(w.t, "")
	return d
}

// rotate registers a new key (CAS on previous).
func (d *device) rotate(t *testing.T, previous string) string {
	t.Helper()
	pub, priv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	k, err := d.client.RegisterKey(context.Background(), inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(pub[:]), previous)
	if err != nil {
		t.Fatalf("register key: %v", err)
	}
	d.keys[k.ID], d.pub[k.ID] = priv, pub
	return k.ID
}

func (d *device) activeKeyID(t *testing.T) string {
	keys, err := d.client.ListKeys(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		if k.Active() {
			return k.ID
		}
	}
	t.Fatal("no active key")
	return ""
}

func (w *world) session() *Session {
	w.t.Helper()
	s, err := Open(w.cfgDir, nil)
	if err != nil {
		w.t.Fatalf("open session: %v", err)
	}
	s.Notice = &lockedBuf{b: &w.notice}
	return s
}

type lockedBuf struct {
	mu sync.Mutex
	b  *bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

// delivered is what the target could open.
type delivered struct {
	manifest   inboxmanifest.Manifest
	files      map[string][]byte
	contentKey []byte
	blob       []byte
	keyID      string
}

// receive claims the task as the target and opens it completely.
func (w *world) receive(taskID string) delivered {
	w.t.Helper()
	ctx := context.Background()
	ds, _, err := w.target.client.Claim(ctx, 8)
	if err != nil {
		w.t.Fatalf("claim: %v", err)
	}
	for _, d := range ds {
		if d.ID != taskID {
			continue
		}
		sealed, err := base64.RawURLEncoding.Strict().DecodeString(d.WrappedKey)
		if err != nil {
			w.t.Fatal(err)
		}
		priv, ok := w.target.keys[d.TargetKeyID]
		if !ok {
			w.t.Fatalf("task sealed to unknown key %s", d.TargetKeyID)
		}
		key, ok := box.OpenAnonymous(nil, sealed, w.target.pub[d.TargetKeyID], priv)
		if !ok {
			w.t.Fatal("wrapped key does not open with the target's private key")
		}
		enc, err := inboxclient.DecodeEncManifest(d.EncManifest)
		if err != nil {
			w.t.Fatal(err)
		}
		pt, err := storecrypto.OpenManifest(key, enc)
		if err != nil {
			w.t.Fatalf("open manifest: %v", err)
		}
		m, err := inboxmanifest.Decode(pt)
		if err != nil {
			w.t.Fatalf("decode manifest: %v", err)
		}
		br, err := w.target.client.Blob(ctx, d.ID, d.ClaimToken, 0)
		if err != nil {
			w.t.Fatalf("blob: %v", err)
		}
		blob, _ := io.ReadAll(br.Body)
		br.Body.Close()
		var plain bytes.Buffer
		dec := storecrypto.NewDecryptor(key)
		if err := dec.Push(blob, func(p []byte) error { plain.Write(p); return nil }); err != nil {
			w.t.Fatalf("decrypt: %v", err)
		}
		if err := dec.End(m.TotalSize()); err != nil {
			w.t.Fatalf("decrypt end: %v", err)
		}
		files := map[string][]byte{}
		all := plain.Bytes()
		for _, it := range m.Items {
			files[it.Name] = all[:it.Size]
			all = all[it.Size:]
		}
		return delivered{manifest: m, files: files, contentKey: key, blob: blob, keyID: d.TargetKeyID}
	}
	w.t.Fatalf("task %s was not claimable", taskID)
	return delivered{}
}

// tasks lists the target's tasks.
func (w *world) tasks() []inboxclient.Task {
	w.t.Helper()
	c, err := NewClient(w.env.TS.URL, w.target.token, nil)
	if err != nil {
		w.t.Fatal(err)
	}
	c.hc.Transport = bypassTransport{w.env}
	ts, err := c.ListTasks(context.Background(), w.target.id, 500)
	if err != nil {
		w.t.Fatal(err)
	}
	return ts
}

type bypassTransport struct{ env *sendtest.Env }

func (b bypassTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	b.env.Faults.Bypass(r)
	return http.DefaultTransport.RoundTrip(r)
}

// journalFiles returns the contents of every file in the journal directory.
func (w *world) journalFiles() map[string][]byte {
	out := map[string][]byte{}
	dir := filepath.Join(w.cfgDir, journalDirName)
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err == nil {
			out[e.Name()] = b
		}
	}
	return out
}

// writeTree creates files under a fresh temp dir and returns its path.
func writeTree(t *testing.T, files map[string][]byte) string {
	t.Helper()
	root := t.TempDir()
	for name, data := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func randomBytes(t *testing.T, n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// assertRetryConverges is `inbox retry` against a server with finalize
// recovery, from a record whose finalize committed but whose object id was
// never learned: the server returns the object that finalize stored, and the
// retry queues it — one task, no second upload, the daily quota unchanged, the
// record removed.
func assertRetryConverges(t *testing.T, w *world, id string, quota int64) Result {
	t.Helper()
	res, err := w.session().Retry(context.Background(), id)
	if err != nil {
		t.Fatalf("retry against a recovering server: %v", err)
	}
	if res.TaskID == "" || !res.Created {
		t.Fatalf("retry = %+v; want the delivery queued now", res)
	}
	if n := len(w.tasks()); n != 1 {
		t.Fatalf("tasks = %d, want exactly one", n)
	}
	if got := w.env.Faults.Hits(sendtest.KeyInit); got != 1 {
		t.Fatalf("inits = %d; recovery must never upload again", got)
	}
	if got := w.env.QuotaBytes(w.uid); got != quota {
		t.Fatalf("daily quota %d -> %d; recovery must not count the upload again", quota, got)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("record kept after completion: %v", ids)
	}
	if !strings.Contains(w.notice.String(), "already completed this upload") {
		t.Fatalf("notice does not say the upload was recovered: %s", w.notice.String())
	}
	return res
}
