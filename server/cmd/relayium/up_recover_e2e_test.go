//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/cloud"
)

// faultCentral wraps a REAL account.Service. POST /api/files requests can be
// made to lose their answer after the real handler has run (committed, then a
// 502 or a malformed body), to be answered 502 without reaching the service at
// all (never committed), or to reach it with the Idempotency-Key stripped (a
// server that predates idempotent uploads).
//
// What the client actually put on the wire is measured at the TCP level
// (wireCountingListener), not by wrapping r.Body: replacing the request body would
// hide net/http's Expect: 100-continue reader from the server and change the
// very behaviour under test.
type faultCentral struct {
	mu    sync.Mutex
	mode  string // "", "commit-502", "commit-garbage", "drop-502", "strip-key"
	posts int
}

func (f *faultCentral) setMode(m string) {
	f.mu.Lock()
	f.mode = m
	f.mu.Unlock()
}

func (f *faultCentral) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/files" {
			next.ServeHTTP(w, r)
			return
		}
		f.mu.Lock()
		mode := f.mode
		f.posts++
		f.mu.Unlock()
		switch mode {
		case "commit-502", "commit-garbage":
			rec := httptest.NewRecorder()
			next.ServeHTTP(rec, r)
			if rec.Code != http.StatusOK {
				w.WriteHeader(rec.Code)
				_, _ = w.Write(rec.Body.Bytes())
				return
			}
			if mode == "commit-502" {
				http.Error(w, "bad gateway", http.StatusBadGateway)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{not json"))
		case "drop-502":
			_, _ = io.Copy(io.Discard, r.Body)
			http.Error(w, "bad gateway", http.StatusBadGateway)
		case "strip-key":
			r.Header.Del("Idempotency-Key")
			next.ServeHTTP(w, r)
		default:
			next.ServeHTTP(w, r)
		}
	})
}

func (f *faultCentral) postCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.posts
}

// wireCountingListener counts every byte the server reads from any connection.
type wireCountingListener struct {
	net.Listener
	n *atomic.Int64
}

func (l wireCountingListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return wireCountingConn{c, l.n}, nil
}

type wireCountingConn struct {
	net.Conn
	n *atomic.Int64
}

func (c wireCountingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.n.Add(int64(n))
	return n, err
}

type upEnv struct {
	t      *testing.T
	ts     *httptest.Server
	store  *account.SQLiteStore
	userID string
	token  string
	cfgDir string
	fault  *faultCentral
	wire   *atomic.Int64
	src    string
	body   string
}

func newUpEnv(t *testing.T) *upEnv {
	t.Helper()
	return newUpEnvSize(t, 5000)
}

// newUpEnvSize is newUpEnv with a source of lines repeats of an 18-byte line
// (5000 lines is ~90 KB, under net/http's 256 KiB post-handler drain limit).
func newUpEnvSize(t *testing.T, lines int) *upEnv {
	t.Helper()
	ts, svc, store := newE2EService(t)
	fault := &faultCentral{}
	// Serve the same service through the fault wrapper on a second listener
	// whose connections count the bytes the client sends.
	var wire atomic.Int64
	fts := httptest.NewUnstartedServer(fault.wrap(svc.Routes()))
	fts.Listener = wireCountingListener{fts.Listener, &wire}
	fts.Start()
	t.Cleanup(fts.Close)
	u, err := store.UpsertUserByEmail(context.Background(), "up@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	token := cliToken(t, ts, svc, u.ID)
	cfgDir := t.TempDir()
	if err := cloud.Save(cfgDir, cloud.Creds{Server: fts.URL, AccessToken: token, AccountEmail: "up@example.com"}); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "report.txt")
	body := strings.Repeat("quarterly numbers\n", lines)
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return &upEnv{t: t, ts: fts, store: store, userID: u.ID, token: token, cfgDir: cfgDir, fault: fault, wire: &wire, src: src, body: body}
}

func (e *upEnv) up(args ...string) (int, string, string) {
	e.t.Helper()
	var out, errOut bytes.Buffer
	code := runUp(append(args, "--config-dir", e.cfgDir), &out, &errOut)
	return code, out.String(), errOut.String()
}

func (e *upEnv) objects() int {
	e.t.Helper()
	files, err := e.store.ListStoredFilesByUser(context.Background(), e.userID)
	if err != nil {
		e.t.Fatal(err)
	}
	return len(files)
}

func (e *upEnv) uploadedBytes() int64 {
	e.t.Helper()
	up, _, err := e.store.MonthlyUsage(context.Background(), e.userID, time.Now().UTC().Format("200601"))
	if err != nil {
		e.t.Fatal(err)
	}
	return up
}

func (e *upEnv) records() int {
	list, err := cloud.ListUpOperations(e.cfgDir)
	if err != nil {
		e.t.Fatal(err)
	}
	return len(list)
}

// maxProbeWire bounds what one recovery may put on the wire: request line and
// headers only. The fixture's upload body is ~90 KB, so any part of it shows.
const maxProbeWire = 4 << 10

func decodeUpDoc(t *testing.T, s string) upDoc {
	t.Helper()
	var d upDoc
	dec := json.NewDecoder(strings.NewReader(s))
	if err := dec.Decode(&d); err != nil || dec.More() {
		t.Fatalf("not one JSON document (%v):\n%s", err, s)
	}
	return d
}

// assertNoSecret checks that neither the content key of operation id nor the
// bearer token appears in s.
func (e *upEnv) assertNoSecret(s, opID string) {
	e.t.Helper()
	if strings.Contains(s, e.token) {
		e.t.Fatalf("output carries the bearer token:\n%s", s)
	}
	if opID != "" {
		if op, err := cloud.LoadUpOperation(e.cfgDir, opID); err == nil && strings.Contains(s, op.ContentKey) {
			e.t.Fatalf("output carries the content key:\n%s", s)
		}
	}
}

func (e *upEnv) download(link string) string {
	e.t.Helper()
	server, id, key, err := cloud.ParseClaim(link)
	if err != nil {
		e.t.Fatal(err)
	}
	c := cloud.NewClient(server)
	dest := e.t.TempDir()
	if _, err := c.Download(context.Background(), id, key, dest); err != nil {
		e.t.Fatalf("download: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dest, "report.txt"))
	if err != nil {
		e.t.Fatal(err)
	}
	return string(b)
}

// The answer to a committed upload is lost (502, then a malformed body): `up`
// exits 3 and keeps the operation; `up --recover` gets the SAME object back
// without sending a body, rebuilds a working link with the recorded key, and
// the account has one object and was metered once.
func TestUpLostAnswerRecoversSameObjectOnceE2E(t *testing.T) {
	for _, mode := range []string{"commit-502", "commit-garbage"} {
		t.Run(mode, func(t *testing.T) {
			e := newUpEnv(t)
			e.fault.setMode(mode)
			code, stdout, stderr := e.up("--json", e.src)
			if code != exitUpUnknown {
				t.Fatalf("first up: code %d, want %d\nstdout=%s\nstderr=%s", code, exitUpUnknown, stdout, stderr)
			}
			doc := decodeUpDoc(t, stdout)
			if doc.Status != "unknown" || doc.Operation == "" || doc.Link != "" {
				t.Fatalf("unknown doc: %+v", doc)
			}
			e.assertNoSecret(stdout+stderr, doc.Operation)
			if e.records() != 1 || e.objects() != 1 {
				t.Fatalf("after lost answer: records=%d objects=%d, want 1/1", e.records(), e.objects())
			}
			metered := e.uploadedBytes()
			if metered <= 0 {
				t.Fatalf("the committed upload was not metered (%d)", metered)
			}
			posts := e.fault.postCount()
			wire0 := e.wire.Load()

			e.fault.setMode("")
			code, stdout, stderr = e.up("--recover", doc.Operation, "--json")
			sent := e.wire.Load() - wire0
			if code != 0 {
				t.Fatalf("recover: code %d\nstdout=%s\nstderr=%s", code, stdout, stderr)
			}
			rd := decodeUpDoc(t, stdout)
			if rd.Status != "uploaded" || rd.Link == "" || rd.Operation != doc.Operation {
				t.Fatalf("recover doc: %+v", rd)
			}
			if e.fault.postCount() != posts+1 || sent > maxProbeWire {
				t.Fatalf("recovery sent %d bytes over %d request(s); it must send no body", sent, e.fault.postCount()-posts)
			}
			if got := e.download(rd.Link); got != e.body {
				t.Fatalf("recovered link opened %d bytes, want the original", len(got))
			}
			if e.objects() != 1 || e.uploadedBytes() != metered || e.records() != 0 {
				t.Fatalf("after recovery: objects=%d metered=%d (was %d) records=%d", e.objects(), e.uploadedBytes(), metered, e.records())
			}
			if strings.Contains(stderr, rd.Link[strings.Index(rd.Link, "#"):]) {
				t.Fatal("stderr carries the link's key")
			}
		})
	}
}

// The original never completed on the server: the probe is asked for the body,
// sends none, and reports UNKNOWN -- record and key kept, nothing created.
func TestUpRecoverBodyRequestedStaysUnknownE2E(t *testing.T) {
	recoverTimeoutForTest(t, 2*time.Second)
	e := newUpEnv(t)
	e.fault.setMode("drop-502")
	code, stdout, stderr := e.up("--json", e.src)
	if code != exitUpUnknown {
		t.Fatalf("first up: code %d\n%s\n%s", code, stdout, stderr)
	}
	op := decodeUpDoc(t, stdout).Operation
	if e.objects() != 0 {
		t.Fatalf("drop-502 created %d object(s)", e.objects())
	}
	before, _ := os.ReadFile(filepath.Join(cloud.UpJournalDir(e.cfgDir), op+".json"))

	e.fault.setMode("")
	wire0 := e.wire.Load()
	code, stdout, stderr = e.up("--recover", op, "--json")
	sent := e.wire.Load() - wire0
	if code != exitUpUnknown {
		t.Fatalf("recover: code %d\n%s\n%s", code, stdout, stderr)
	}
	if d := decodeUpDoc(t, stdout); d.Status != "unknown" || d.Link != "" {
		t.Fatalf("recover doc %+v", d)
	}
	e.assertNoSecret(stdout+stderr, op)
	// Not confirmed is not absent: the message must not claim the server holds
	// nothing.
	if strings.Contains(stderr, "holds no") || !strings.Contains(stderr, "did not confirm") {
		t.Fatalf("unknown recovery wording overclaims absence:\n%s", stderr)
	}
	if sent > maxProbeWire || e.objects() != 0 {
		t.Fatalf("probe sent %d bytes, objects=%d", sent, e.objects())
	}
	after, _ := os.ReadFile(filepath.Join(cloud.UpJournalDir(e.cfgDir), op+".json"))
	if len(before) == 0 || !bytes.Equal(before, after) {
		t.Fatal("an unknown recovery changed or removed the operation record")
	}
}

// A server that ignores the Idempotency-Key (one that predates idempotent
// uploads) asks for the body even for a committed upload: unknown, nothing
// uploaded, no second object, record kept.
func TestUpRecoverAgainstLegacyServerUploadsNothingE2E(t *testing.T) {
	recoverTimeoutForTest(t, 2*time.Second)
	e := newUpEnv(t)
	e.fault.setMode("commit-502")
	code, stdout, _ := e.up("--json", e.src)
	if code != exitUpUnknown {
		t.Fatalf("first up: code %d", code)
	}
	op := decodeUpDoc(t, stdout).Operation
	metered := e.uploadedBytes()

	e.fault.setMode("strip-key")
	wire0 := e.wire.Load()
	code, stdout, stderr := e.up("--recover", op)
	sent := e.wire.Load() - wire0
	if code != exitUpUnknown {
		t.Fatalf("legacy recover: code %d\n%s\n%s", code, stdout, stderr)
	}
	if sent > maxProbeWire || e.objects() != 1 || e.uploadedBytes() != metered || e.records() != 1 {
		t.Fatalf("legacy probe: sent=%d objects=%d metered=%d (was %d) records=%d",
			sent, e.objects(), e.uploadedBytes(), metered, e.records())
	}
}

// Proven gone (410): reported, record removed, never re-created.
func TestUpRecoverGoneE2E(t *testing.T) {
	e := newUpEnv(t)
	e.fault.setMode("commit-502")
	code, stdout, _ := e.up("--json", e.src)
	if code != exitUpUnknown {
		t.Fatalf("first up: code %d", code)
	}
	op := decodeUpDoc(t, stdout).Operation
	files, _ := e.store.ListStoredFilesByUser(context.Background(), e.userID)
	if err := e.store.DeleteStoredFile(context.Background(), files[0].ID, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	e.fault.setMode("")
	wire0 := e.wire.Load()
	code, stdout, stderr := e.up("--recover", op, "--json")
	sent := e.wire.Load() - wire0
	if code != 1 || decodeUpDoc(t, stdout).Status != "gone" {
		t.Fatalf("gone: code %d\n%s\n%s", code, stdout, stderr)
	}
	if e.objects() != 0 || e.records() != 0 || sent > maxProbeWire {
		t.Fatalf("gone: objects=%d records=%d sent=%d", e.objects(), e.records(), sent)
	}
}

// Recovery is refused, with no request and the record kept, for another
// account, another server, a missing record, and a busy operation.
func TestUpRecoverRefusalsE2E(t *testing.T) {
	e := newUpEnv(t)
	e.fault.setMode("commit-502")
	code, stdout, _ := e.up("--json", e.src)
	if code != exitUpUnknown {
		t.Fatalf("first up: code %d", code)
	}
	op := decodeUpDoc(t, stdout).Operation
	e.fault.setMode("")
	posts := e.fault.postCount()
	good, _, _ := cloud.Load(e.cfgDir)

	for _, c := range []cloud.Creds{
		{Server: good.Server, AccessToken: good.AccessToken, AccountEmail: "someone-else@example.com"},
		{Server: "https://other.example.test", AccessToken: good.AccessToken, AccountEmail: good.AccountEmail},
	} {
		if err := cloud.Save(e.cfgDir, c); err != nil {
			t.Fatal(err)
		}
		code, stdout, stderr := e.up("--recover", op, "--json")
		if code != 1 || decodeUpDoc(t, stdout).Error != "different_account" {
			t.Fatalf("creds %+v: code %d\n%s\n%s", c.AccountEmail+" "+c.Server, code, stdout, stderr)
		}
	}
	if err := cloud.Save(e.cfgDir, good); err != nil {
		t.Fatal(err)
	}
	if code, stdout, _ := e.up("--recover", "0123456789abcdef0123456789abcdef", "--json"); code != 1 || decodeUpDoc(t, stdout).Error != "no_such_operation" {
		t.Fatalf("missing: code %d %s", code, stdout)
	}
	lock, err := cloud.LockUpOperation(e.cfgDir, op)
	if err != nil {
		t.Fatal(err)
	}
	code, stdout, _ = e.up("--recover", op, "--json")
	lock.Release()
	if code != 1 || decodeUpDoc(t, stdout).Error != "operation_busy" {
		t.Fatalf("busy: code %d %s", code, stdout)
	}
	if e.fault.postCount() != posts || e.records() != 1 {
		t.Fatalf("refusals sent %d request(s); records=%d", e.fault.postCount()-posts, e.records())
	}
	// And with everything right again it recovers.
	if code, _, stderr := e.up("--recover", op); code != 0 {
		t.Fatalf("final recover: code %d %s", code, stderr)
	}
}

// A definite failure (refused before anything could be stored) removes the
// record; a success removes it after the link was printed.
func TestUpRecordLifecycleE2E(t *testing.T) {
	e := newUpEnv(t)
	code, stdout, stderr := e.up(e.src)
	if code != 0 || !strings.Contains(stdout, "/d/") || e.records() != 0 || e.objects() != 1 {
		t.Fatalf("plain up: code %d records=%d\n%s\n%s", code, e.records(), stdout, stderr)
	}
	big := filepath.Join(t.TempDir(), "big.bin")
	if err := os.WriteFile(big, make([]byte, 2<<20), 0o644); err != nil { // over the 1 MiB fixture limit
		t.Fatal(err)
	}
	code, _, stderr = e.up(big)
	if code != 1 || e.records() != 0 {
		t.Fatalf("refused up: code %d records=%d\n%s", code, e.records(), stderr)
	}
}
