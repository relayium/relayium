package inboxsend

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxmanifest"
	"github.com/relayium/relayium/internal/storecrypto"
)

// ---------------------------------------------------------------- sealer

// N2 against the fmt pitfall: printing the sealer — directly, inside a parent
// struct, or through any verb — must not print key bytes in any spelling.
func TestSealerNeverPrintsItsKey(t *testing.T) {
	s, err := newSealer()
	if err != nil {
		t.Fatal(err)
	}
	key := keyOf(t, s)
	type parent struct {
		name string
		s    *sealer
		v    sealer
	}
	p := parent{name: "x", s: s, v: *s}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
		for _, v := range []any{s, *s, p, &p} {
			out := fmt.Sprintf(verb, v)
			for _, spelling := range keySpellings(key) {
				if strings.Contains(out, spelling) {
					t.Fatalf("%s of %T printed the key: %q", verb, v, out)
				}
			}
		}
	}
}

// N1/N5 structurally: seq 0 once, frames strictly increasing, nothing after
// discard.
func TestSealerSealsEachSeqOnceInOrder(t *testing.T) {
	s, _ := newSealer()
	if _, err := s.frame([]byte("x")); err == nil {
		t.Fatal("a frame before the manifest must be refused")
	}
	m, err := s.sealManifest([]byte(`{"v":3}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.sealManifest([]byte(`{"v":3,"other":1}`)); err == nil {
		t.Fatal("the manifest must be sealable only once")
	}
	key := keyOf(t, s)
	if pt, err := storecrypto.OpenManifest(key, m); err != nil || string(pt) != `{"v":3}` {
		t.Fatal("manifest does not open at seq 0")
	}
	var stream []byte
	for i := 0; i < 3; i++ {
		f, err := s.frame([]byte{byte('a' + i)})
		if err != nil {
			t.Fatal(err)
		}
		stream = append(stream, f...)
	}
	var got []byte
	d := storecrypto.NewDecryptor(key)
	if err := d.Push(stream, func(p []byte) error { got = append(got, p...); return nil }); err != nil || string(got) != "abc" {
		t.Fatalf("frames are not at seq 1,2,3: %v %q", err, got)
	}
	s.discard()
	if _, err := s.frame([]byte("z")); err == nil {
		t.Fatal("a discarded sealer must not seal")
	}
	if _, err := s.wrapTo(inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(make([]byte, 32))); err == nil {
		t.Fatal("a discarded sealer must not wrap")
	}
}

func TestWrapToOpensOnlyWithTheDevicePrivateKey(t *testing.T) {
	s, _ := newSealer()
	pub, priv, _ := box.GenerateKey(rand.Reader)
	w, err := s.wrapTo(inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(pub[:]))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := base64.RawURLEncoding.Strict().DecodeString(w)
	if err != nil || len(sealed) != inbox.SealedBoxBytes {
		t.Fatalf("wrapped key is not %d raw-url bytes", inbox.SealedBoxBytes)
	}
	got, ok := box.OpenAnonymous(nil, sealed, pub, priv)
	if !ok || len(got) != 32 {
		t.Fatal("wrapped key does not open")
	}
	m, _ := s.sealManifest([]byte("m"))
	if pt, err := storecrypto.OpenManifest(got, m); err != nil || string(pt) != "m" {
		t.Fatal("the wrapped key is not the key the payload is sealed with")
	}
	// A low-order point is refused before anything is sealed to it.
	if _, err := s.wrapTo(inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(make([]byte, 32))); err == nil {
		t.Fatal("a low-order public key must be refused")
	}
	if _, err := s.wrapTo("rsa", inbox.EncodePublicKey(pub[:])); err == nil {
		t.Fatal("an unknown algorithm must be refused")
	}
}

// ---------------------------------------------------------------- plan

func TestPlanBuildsTheReceiverVisibleTree(t *testing.T) {
	root := writeTree(t, map[string][]byte{
		"proj/a.txt": []byte("a"), "proj/src/main.go": []byte("package main"), "proj/zero": {},
		"single.bin": bytes.Repeat([]byte{1}, storecrypto.ChunkSize+1),
	})
	if err := os.MkdirAll(filepath.Join(root, "proj", "empty", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	p, err := BuildPlan([]string{filepath.Join(root, "proj"), filepath.Join(root, "single.bin")})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range p.files {
		names = append(names, f.item.Name)
	}
	if strings.Join(names, ",") != "proj/a.txt,proj/src/main.go,proj/zero,single.bin" {
		t.Fatalf("items = %v", names)
	}
	if len(p.EmptyFolders) != 1 || p.EmptyFolders[0] != "proj/empty" {
		t.Fatalf("empty folders = %v; want only the outermost", p.EmptyFolders)
	}
	want := int64(1+20) + int64(12+20) + 0 + int64(storecrypto.ChunkSize+1+2*20)
	if p.CiphertextBytes != want {
		t.Fatalf("ciphertext size %d, want %d", p.CiphertextBytes, want)
	}
	m, err := inboxmanifest.Decode(p.manifest)
	if err != nil || len(m.Items) != 4 {
		t.Fatalf("manifest is not a canonical v3 document: %v", err)
	}
}

func TestPlanRefusesWhatAReceiverWouldRefuseOrWhatWouldSilentlyShrink(t *testing.T) {
	cases := map[string]func(t *testing.T) []string{
		"symlink inside a folder": func(t *testing.T) []string {
			root := writeTree(t, map[string][]byte{"d/a": []byte("a")})
			if err := os.Symlink("/etc/hosts", filepath.Join(root, "d", "link")); err != nil {
				t.Fatal(err)
			}
			return []string{filepath.Join(root, "d")}
		},
		"fifo inside a folder": func(t *testing.T) []string {
			root := writeTree(t, map[string][]byte{"d/a": []byte("a")})
			if err := mkfifo(filepath.Join(root, "d", "pipe")); err != nil {
				t.Skip(err)
			}
			return []string{filepath.Join(root, "d")}
		},
		"reserved device name": func(t *testing.T) []string {
			root := writeTree(t, map[string][]byte{"d/CON.txt": []byte("a")})
			return []string{filepath.Join(root, "d")}
		},
		"trailing dot": func(t *testing.T) []string {
			root := writeTree(t, map[string][]byte{"d/name.": []byte("a")})
			return []string{filepath.Join(root, "d")}
		},
		"backslash": func(t *testing.T) []string {
			root := writeTree(t, map[string][]byte{`d/a\b`: []byte("a")})
			return []string{filepath.Join(root, "d")}
		},
		"control character": func(t *testing.T) []string {
			root := writeTree(t, map[string][]byte{"d/a\x1b[31m": []byte("a")})
			return []string{filepath.Join(root, "d")}
		},
		"receiver staging name": func(t *testing.T) []string {
			root := writeTree(t, map[string][]byte{".relayium-incoming/x": []byte("a")})
			return []string{filepath.Join(root, ".relayium-incoming")}
		},
		"duplicate top-level names": func(t *testing.T) []string {
			a := writeTree(t, map[string][]byte{"docs/x": []byte("1")})
			b := writeTree(t, map[string][]byte{"docs/y": []byte("2")})
			return []string{filepath.Join(a, "docs"), filepath.Join(b, "docs")}
		},
		"names differing only by case": func(t *testing.T) []string {
			a := writeTree(t, map[string][]byte{"Readme": []byte("1")})
			b := writeTree(t, map[string][]byte{"README": []byte("2")})
			return []string{filepath.Join(a, "Readme"), filepath.Join(b, "README")}
		},
		"too deep for a receiver": func(t *testing.T) []string {
			parts := make([]string, 40)
			for i := range parts {
				parts[i] = "d"
			}
			root := writeTree(t, map[string][]byte{strings.Join(parts, "/") + "/f": []byte("a")})
			return []string{filepath.Join(root, "d")}
		},
		"only empty folders": func(t *testing.T) []string {
			root := t.TempDir()
			_ = os.MkdirAll(filepath.Join(root, "e", "f"), 0o755)
			return []string{filepath.Join(root, "e")}
		},
		"missing path":    func(t *testing.T) []string { return []string{filepath.Join(t.TempDir(), "nope")} },
		"filesystem root": func(t *testing.T) []string { return []string{"/"} },
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := BuildPlan(mk(t))
			e := AsError(err)
			if e == nil || e.Class != ClassLocal {
				t.Fatalf("err = %v; want a ClassLocal refusal", err)
			}
			if strings.ContainsAny(e.Msg, "\x1b\x07") {
				t.Fatalf("refusal message is not terminal-safe: %q", e.Msg)
			}
		})
	}
}

func TestPlanFollowsANamedTopLevelSymlinkOnceUnderItsOwnName(t *testing.T) {
	root := writeTree(t, map[string][]byte{"real/x.txt": []byte("x")})
	link := filepath.Join(root, "alias")
	if err := os.Symlink(filepath.Join(root, "real"), link); err != nil {
		t.Fatal(err)
	}
	p, err := BuildPlan([]string{link})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.files) != 1 || p.files[0].item.Name != "alias/x.txt" {
		t.Fatalf("items = %+v", p.files)
	}
}

// ---------------------------------------------------------------- journal

func TestJournalRoundTripsAndRejectsHostileRecords(t *testing.T) {
	st := newJournalStore(t.TempDir())
	j := validJournal()
	if err := st.save(j); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(st.path(j.ID))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("journal mode = %v, %v; want 0600", fi.Mode().Perm(), err)
	}
	if di, _ := os.Stat(st.dir); di.Mode().Perm() != 0o700 {
		t.Fatalf("journal dir mode = %v; want 0700", di.Mode().Perm())
	}
	got, err := st.load(j.ID)
	if err != nil || *got != *j {
		t.Fatalf("round trip: %v", err)
	}

	for _, id := range []string{"../../etc/passwd", "..", "", strings.Repeat("A", 32), strings.Repeat("a", 31), "a/b"} {
		if _, err := st.load(id); err == nil {
			t.Fatalf("id %q accepted", id)
		}
	}
	write := func(body string) string {
		id := strings.Repeat("c", 32)
		if err := os.WriteFile(st.path(id), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return id
	}
	good, _ := json.Marshal(j)
	mutate := func(f func(m map[string]any)) string {
		var m map[string]any
		_ = json.Unmarshal(good, &m)
		m["id"] = strings.Repeat("c", 32)
		f(m)
		b, _ := json.Marshal(m)
		return string(b)
	}
	for name, body := range map[string]string{
		"unknown field":     mutate(func(m map[string]any) { m["contentKey"] = "x" }),
		"server with query": mutate(func(m map[string]any) { m["server"] = "https://a.example/?x=1" }),
		"server not http":   mutate(func(m map[string]any) { m["server"] = "file:///etc" }),
		"userinfo":          mutate(func(m map[string]any) { m["server"] = "https://u:p@a.example" }),
		"traversal target":  mutate(func(m map[string]any) { m["targetDeviceId"] = "../x" }),
		"short wrapped key": mutate(func(m map[string]any) { m["wrappedKey"] = "AAAA" }),
		"bad idempotency":   mutate(func(m map[string]any) { m["idempotencyKey"] = "x" }),
		"phase w/o upload":  mutate(func(m map[string]any) { m["uploadId"] = "" }),
		"unknown phase":     mutate(func(m map[string]any) { m["phase"] = "done" }),
		"id mismatch":       strings.Replace(mutate(func(map[string]any) {}), strings.Repeat("c", 32), strings.Repeat("d", 32), 1),
		"trailing data":     mutate(func(map[string]any) {}) + "{}",
		"oversized":         strings.Repeat(" ", maxJournalBytes+1),
	} {
		id := write(body)
		if _, err := st.load(id); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	// A symlinked journal is not followed.
	id := strings.Repeat("e", 32)
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	_ = os.WriteFile(target, good, 0o600)
	if err := os.Symlink(target, st.path(id)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.load(id); err == nil {
		t.Fatal("a symlinked journal was followed")
	}
}

// The Journal type has no field that could hold a content key: every string
// field is accounted for here, so adding one forces this test to be revisited.
func TestJournalHasNoKeyField(t *testing.T) {
	b, _ := json.Marshal(validJournal())
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	allowed := map[string]bool{"v": true, "id": true, "phase": true, "server": true, "accountEmail": true,
		"sourceDeviceId": true, "targetDeviceId": true, "targetKeyId": true, "targetKeyGeneration": true,
		"wrappedKey": true, "idempotencyKey": true, "ttl": true, "ciphertextBytes": true, "manifestSha256": true,
		"uploadId": true, "storedFileId": true, "expiresAt": true, "createdAt": true}
	for k := range m {
		if !allowed[k] {
			t.Fatalf("new journal field %q: prove it carries no secret, then allow it here", k)
		}
	}
}

// ---------------------------------------------------------------- verdict

func TestEvaluateMatchesTheWebVerdict(t *testing.T) {
	pub, _, _ := box.GenerateKey(rand.Reader)
	good := func() inboxclient.Device {
		return inboxclient.Device{ID: "dev1", Inbox: &inboxclient.InboxView{
			Presence: "online", AutoAccept: "auto", ReceiveDirReady: true, CanReceive: true,
			ReceiveCapability: inbox.CapReceiveV3, RegisteredAt: 1,
			Key: &inboxclient.Key{ID: "k1", Algorithm: inbox.KeyAlgX25519SealedBoxV1,
				PublicKey: inbox.EncodePublicKey(pub[:]), Generation: 1},
		}}
	}
	cases := []struct {
		name  string
		edit  func(d *inboxclient.Device)
		block string
		cav   string
	}{
		{"sendable", func(*inboxclient.Device) {}, "", ""},
		{"bad id", func(d *inboxclient.Device) { d.ID = "a/b" }, BlockUnusableID, ""},
		{"no inbox", func(d *inboxclient.Device) { d.Inbox = nil }, BlockNotEnrolled, ""},
		{"unregistered", func(d *inboxclient.Device) { d.Inbox.RegisteredAt = 0 }, BlockNotEnrolled, ""},
		{"revoked", func(d *inboxclient.Device) { d.Inbox.Revoked = true }, BlockRevoked, ""},
		{"cannot receive", func(d *inboxclient.Device) { d.Inbox.CanReceive = false }, BlockCannotReceive, ""},
		{"v2 receiver", func(d *inboxclient.Device) { d.Inbox.ReceiveCapability = inbox.CapReceiveV2 }, BlockUnsupportedCapability, ""},
		{"no key", func(d *inboxclient.Device) { d.Inbox.Key = nil }, BlockUnsupportedKey, ""},
		{"superseded key", func(d *inboxclient.Device) { d.Inbox.Key.SupersededAt = 5 }, BlockUnsupportedKey, ""},
		{"low-order key", func(d *inboxclient.Device) { d.Inbox.Key.PublicKey = inbox.EncodePublicKey(make([]byte, 32)) }, BlockUnsupportedKey, ""},
		{"padded key", func(d *inboxclient.Device) { d.Inbox.Key.PublicKey += "=" }, BlockUnsupportedKey, ""},
		{"generation 0", func(d *inboxclient.Device) { d.Inbox.Key.Generation = 0 }, BlockUnsupportedKey, ""},
		{"unknown policy", func(d *inboxclient.Device) { d.Inbox.AutoAccept = "maybe" }, BlockUnknownPolicy, ""},
		{"off", func(d *inboxclient.Device) { d.Inbox.AutoAccept = "off" }, BlockReceiveOff, ""},
		{"ask", func(d *inboxclient.Device) { d.Inbox.AutoAccept = "ask" }, "", CaveatNeedsApproval},
		{"dir not ready", func(d *inboxclient.Device) { d.Inbox.ReceiveDirReady = false }, "", CaveatDirectoryNotReady},
		{"offline", func(d *inboxclient.Device) { d.Inbox.Presence = "offline" }, "", CaveatQueuedUntilOnline},
		{"current device is not blocked", func(d *inboxclient.Device) { d.Current = true }, "", ""},
	}
	for _, tc := range cases {
		d := good()
		tc.edit(&d)
		a := Evaluate(d)
		if a.Block != tc.block || a.Sendable != (tc.block == "") {
			t.Fatalf("%s: block = %q sendable=%v; want %q", tc.name, a.Block, a.Sendable, tc.block)
		}
		if tc.cav != "" && (len(a.Caveats) != 1 || a.Caveats[0] != tc.cav) {
			t.Fatalf("%s: caveats = %v; want [%s]", tc.name, a.Caveats, tc.cav)
		}
	}
}

func TestResolveTargetIsExactAndRefusesAmbiguity(t *testing.T) {
	devs := []inboxclient.Device{{ID: "id1", Name: "laptop"}, {ID: "id2", Name: "server"}, {ID: "id3", Name: "server"}, {ID: "id4", Name: "id1"}}
	if d, err := resolveTarget(devs, "id1"); err != nil || d.ID != "id1" {
		t.Fatal("an exact id wins over a name")
	}
	if d, err := resolveTarget(devs, "laptop"); err != nil || d.ID != "id1" {
		t.Fatal("a unique exact name resolves")
	}
	for _, to := range []string{"server", "Laptop", "lap", ""} {
		if _, err := resolveTarget(devs, to); AsError(err) == nil || AsError(err).Class != ClassLocal {
			t.Fatalf("%q: want a local refusal", to)
		}
	}
	_, err := resolveTarget(devs, "server")
	if e := AsError(err); e.Code != CodeAmbiguousTarget || !strings.Contains(e.Msg, "id2") || !strings.Contains(e.Msg, "id3") {
		t.Fatalf("ambiguity must list the candidate ids: %v", err)
	}
}

// ---------------------------------------------------------------- client

func TestClientBoundsBodiesAndNeverEchoesServerText(t *testing.T) {
	var mode string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch mode {
		case "huge":
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"devices":[`))
			_, _ = w.Write(bytes.Repeat([]byte(" "), maxListBody+10))
			_, _ = w.Write([]byte(`]}`))
		case "evil":
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"error":"\u001b[2Jpwned"}`))
		case "plain409":
			http.Error(w, "already finalized", http.StatusConflict)
		}
	}))
	defer srv.Close()
	c, err := NewClient(srv.URL, "tok", nil)
	if err != nil {
		t.Fatal(err)
	}
	mode = "huge"
	if _, err := c.ListDevices(context.Background()); !isTransport(err) {
		t.Fatalf("an oversized body must be refused, got %v", err)
	}
	mode = "evil"
	_, err = c.ListDevices(context.Background())
	if codeOf(err) != "" || strings.Contains(err.Error(), "pwned") {
		t.Fatalf("an unknown server token must not be repeated: %v", err)
	}
	mode = "plain409"
	_, _, _, err = c.Finalize(context.Background(), "up1")
	var ae *APIError
	if !asAPI(err, &ae) || ae.Status != 409 || !ae.Plain {
		t.Fatalf("plain-text 409 not recognised: %v", err)
	}
}

func TestTransportErrorsDoNotCarryTheURL(t *testing.T) {
	c, _ := NewClient("http://127.0.0.1:1", "tok", nil)
	_, _, _, err := c.Finalize(context.Background(), "SECRETUPLOADID")
	if err == nil || strings.Contains(err.Error(), "SECRETUPLOADID") {
		t.Fatalf("transport error leaks the request URL: %v", err)
	}
}

func asAPI(err error, out **APIError) bool {
	e, ok := err.(*APIError)
	*out = e
	return ok
}

// keyOf recovers a sealer's content key the only way anything outside it can:
// by wrapping it to a key pair this test holds and opening the box.
func keyOf(t *testing.T, s *sealer) []byte {
	t.Helper()
	pub, priv, _ := box.GenerateKey(rand.Reader)
	w, err := s.wrapTo(inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(pub[:]))
	if err != nil {
		t.Fatal(err)
	}
	sealed, _ := base64.RawURLEncoding.DecodeString(w)
	k, ok := box.OpenAnonymous(nil, sealed, pub, priv)
	if !ok {
		t.Fatal("cannot open own wrap")
	}
	return k
}

// The exported check is the receiver's planner rule, not a copy of it: for
// every name, CheckPortableName accepts exactly what PlanDestinations plans.
func TestCheckPortableNameAgreesWithTheReceiverPlanner(t *testing.T) {
	deep := strings.Repeat("d/", 32) + "f"
	for _, name := range []string{
		"a.txt", "dir/a.txt", ".bashrc", "日本語/ファイル.txt", "a b/c", deep, strings.Repeat("d/", 31) + "f",
		"CON", "con.txt", "lpt9.log", "x.", "x ", "a//b", "./a", "../a", "/abs", `a\b`, "C:x", "a\x00b", "a\x7fb",
		".relayium-incoming/x", ".relayium-inbox-probe", "", strings.Repeat("n", 1025),
	} {
		_, planErr := inboxclient.PlanDestinations(t.TempDir(), []inboxmanifest.Item{{Kind: inboxmanifest.KindFile, Name: name}},
			func(string) bool { return false })
		if (inboxclient.CheckPortableName(name) == nil) != (planErr == nil) {
			t.Errorf("%q: sender check and receiver planner disagree (planner: %v)", name, planErr)
		}
	}
}
