// Package sendtest is TEST SUPPORT for the Device Inbox sender: a real
// account.Service on in-memory SQLite and a real DiskStore, real device-code
// logins, and a fault-injecting middleware that sits IN FRONT of the real
// handlers. Nothing here replaces central's behaviour: a fault either lets the
// real handler run and then loses its answer, feeds it a truncated body, or
// answers in its place with a status the real server can also produce (a
// redirect, a reaped session). Positive claims come from the real handlers.
//
// It is imported only by tests.
package sendtest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/storage"
)

type noopMailer struct{}

func (noopMailer) SendMagicLink(context.Context, string, string) error     { return nil }
func (noopMailer) SendVerifyEmail(context.Context, string, string) error   { return nil }
func (noopMailer) SendPasswordReset(context.Context, string, string) error { return nil }
func (noopMailer) SendAccountDeletionConfirm(context.Context, string, string) error {
	return nil
}
func (noopMailer) SendAccountDeletionScheduled(context.Context, string, int64, string) error {
	return nil
}
func (noopMailer) SendAccountDeletionReminder(context.Context, string, int64, string) error {
	return nil
}
func (noopMailer) SendAccountDeleted(context.Context, string) error { return nil }

// Env is one real central behind a fault middleware.
type Env struct {
	T      testing.TB
	TS     *httptest.Server
	Svc    *account.Service
	Store  *account.SQLiteStore
	Faults *Faults
}

// New starts a real service. maxFile bounds one upload (the e2e service in
// cmd/relayium uses 1 MiB; multi-chunk tests need more).
func New(t testing.TB, maxFile int64) *Env {
	t.Helper()
	return newEnv(t, maxFile)
}

func newEnv(t testing.TB, maxFile int64) *Env {
	t.Helper()
	store, err := account.OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	svc := account.NewService(store, noopMailer{}, account.Config{
		BaseURL: "http://127.0.0.1", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		MaxFileSize: maxFile, DailyQuota: 16 * maxFile,
		DefaultTTL: 3600, MaxTTL: 7200, DefaultRetention: 1,
		DefaultMaxDownloads: 5, MaxMaxDownloads: 100,
	})
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("disk store: %v", err)
	}
	svc.SetBlobStore(disk)
	if err := svc.SeedSettings(context.Background()); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
	f := &Faults{hits: map[string]int{}}
	ts := httptest.NewServer(f.wrap(svc.Routes()))
	t.Cleanup(ts.Close)
	t.Cleanup(f.ReleaseAll)
	return &Env{T: t, TS: ts, Svc: svc, Store: store, Faults: f}
}

// User creates (or returns) an account.
func (e *Env) User(email string) string {
	e.T.Helper()
	u, err := e.Store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		e.T.Fatalf("upsert user: %v", err)
	}
	return u.ID
}

// Login runs the real device-code flow and returns a CLI bearer; each call is
// a new device row in the account.
func (e *Env) Login(userID, deviceName string) string {
	e.T.Helper()
	sess, err := e.Svc.IssueSession(context.Background(), userID)
	if err != nil {
		e.T.Fatalf("issue session: %v", err)
	}
	var start struct {
		UserCode   string `json:"user_code"`
		DeviceCode string `json:"device_code"`
	}
	e.post("/api/cli/device/start", nil, map[string]string{"device_name": deviceName}, &start)
	cookie := &http.Cookie{Name: "relayium_session", Value: sess.ID}
	e.post("/api/cli/device/approve", cookie, map[string]string{"user_code": start.UserCode}, nil)
	var poll struct {
		Status      string `json:"status"`
		AccessToken string `json:"access_token"`
	}
	e.post("/api/cli/device/poll", nil, map[string]string{"device_code": start.DeviceCode}, &poll)
	if poll.Status != "ok" || poll.AccessToken == "" {
		e.T.Fatalf("device poll: status %q", poll.Status)
	}
	return poll.AccessToken
}

func (e *Env) post(path string, cookie *http.Cookie, body, out any) {
	e.T.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, e.TS.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	e.Faults.Bypass(req)
	resp, err := e.TS.Client().Do(req)
	if err != nil {
		e.T.Fatalf("POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		e.T.Fatalf("POST %s: %d %s", path, resp.StatusCode, rb)
	}
	if out != nil {
		if err := json.Unmarshal(rb, out); err != nil {
			e.T.Fatalf("POST %s decode: %v", path, err)
		}
	}
}

// Do is a direct bearer request to the real service, bypassing faults.
func (e *Env) Do(token, method, path string, body []byte) (int, []byte) {
	e.T.Helper()
	req, _ := http.NewRequest(method, e.TS.URL+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	e.Faults.Bypass(req)
	resp, err := e.TS.Client().Do(req)
	if err != nil {
		e.T.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, rb
}

// QuotaBytes is the daily-quota total the account has reserved (every
// finalized upload's billed bytes).
func (e *Env) QuotaBytes(userID string) int64 {
	e.T.Helper()
	n, err := e.Store.UserUploadedSince(context.Background(), userID, 0)
	if err != nil {
		e.T.Fatalf("quota: %v", err)
	}
	return n
}

// ---------------------------------------------------------------- faults

// Action is what a Rule does to the request it matches.
type Action int

const (
	// DropResponse runs the real handler to completion, then closes the
	// connection instead of answering: the write happened, the answer is lost.
	DropResponse Action = iota
	// TruncateAndDrop feeds the real handler only the first half of the body,
	// then drops the answer: a connection that died mid-chunk.
	TruncateAndDrop
	// Redirect answers 307 to Location without reaching the handler.
	Redirect
	// HoldResponse runs the handler, then withholds the answer until Release
	// (or the test ends), then drops the connection. Hit is signalled first.
	HoldResponse
	// Before runs Fn, then the real handler normally.
	Before
	// Status answers Code without reaching the handler.
	Status
	// HoldUnhandled withholds the request from central entirely until Release,
	// then hangs up: the write never happened and its answer never came.
	HoldUnhandled
)

// Rule is one injected fault.
type Rule struct {
	Method string
	// PathPrefix/PathSuffix select the request path.
	PathPrefix, PathSuffix string
	// Skip lets that many matching requests through before firing.
	Skip int
	// Times is how many requests it fires on (0 = once).
	Times    int
	Action   Action
	Location string
	Code     int
	Fn       func(r *http.Request)
	// Hit is closed when the rule first fires (HoldResponse, optional).
	Hit     chan struct{}
	release chan struct{}
	fired   int
	seen    int
}

// Faults is the middleware.
type Faults struct {
	legacy  atomic.Bool
	mu      sync.Mutex
	rules   []*Rule
	hits    map[string]int
	patches []Patch
	creates [][]byte
	observe func(kind string)
}

// SetObserve installs fn, called with the request class before any rule for
// every non-bypass request (tests snapshot local state with it).
func (f *Faults) SetObserve(fn func(kind string)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.observe = fn
}

// Creates returns every create-task body seen, in order.
func (f *Faults) Creates() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.creates...)
}

// Patch is one PATCH body as it reached the middleware (before any fault).
type Patch struct {
	UploadID string
	Start    int64
	Body     []byte
}

const bypassHeader = "X-Sendtest-Bypass"

// Bypass marks a harness request so it is neither counted nor faulted.
func (f *Faults) Bypass(r *http.Request) { r.Header.Set(bypassHeader, "1") }

// Add installs a rule and returns it.
func (f *Faults) Add(r *Rule) *Rule {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Times == 0 {
		r.Times = 1
	}
	if r.Action == HoldResponse || r.Action == HoldUnhandled {
		r.release = make(chan struct{})
	}
	f.rules = append(f.rules, r)
	return r
}

// Release lets a held response go (it is then dropped).
func (r *Rule) Release() {
	if r.release != nil {
		select {
		case <-r.release:
		default:
			close(r.release)
		}
	}
}

// ReleaseAll releases every held response.
func (f *Faults) ReleaseAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.rules {
		r.Release()
	}
}

// Hits counts requests by "METHOD /first/path/segments" key (see key).
func (f *Faults) Hits(k string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits[k]
}

// Patches returns every PATCH body seen.
func (f *Faults) Patches() []Patch {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Patch(nil), f.patches...)
}

// Key classes counted by Hits.
const (
	KeyInit     = "init"
	KeyPatch    = "patch"
	KeyFinalize = "finalize"
	KeyStatus   = "status"
	KeyCreate   = "create"
)

func classify(r *http.Request) string {
	p := r.URL.Path
	switch {
	case r.Method == http.MethodPost && p == "/api/uploads":
		return KeyInit
	case r.Method == http.MethodPatch && strings.HasPrefix(p, "/api/uploads/"):
		return KeyPatch
	case r.Method == http.MethodPost && strings.HasPrefix(p, "/api/uploads/") && strings.HasSuffix(p, "/finalize"):
		return KeyFinalize
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/api/uploads/"):
		return KeyStatus
	case r.Method == http.MethodPost && strings.HasSuffix(p, "/inbox/tasks"):
		return KeyCreate
	}
	return r.Method + " " + p
}

func (f *Faults) take(r *http.Request) *Rule {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, rule := range f.rules {
		if rule.fired >= rule.Times {
			continue
		}
		if rule.Method != "" && rule.Method != r.Method {
			continue
		}
		if !strings.HasPrefix(r.URL.Path, rule.PathPrefix) || !strings.HasSuffix(r.URL.Path, rule.PathSuffix) {
			continue
		}
		rule.seen++
		if rule.seen <= rule.Skip {
			continue
		}
		rule.fired++
		return rule
	}
	return nil
}

// swallow runs a handler without letting its answer reach the client, while
// still exposing the real connection to http.ResponseController (the upload
// handler sets a read deadline on it).
type swallow struct {
	http.ResponseWriter
	hdr http.Header
}

func (s *swallow) Header() http.Header         { return s.hdr }
func (s *swallow) WriteHeader(int)             {}
func (s *swallow) Write(b []byte) (int, error) { return len(b), nil }
func (s *swallow) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func hangUp(w http.ResponseWriter) {
	if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
		conn.Close()
	}
}

// SetLegacyServer emulates a server that predates W-N40 (or one rolled back
// to such a build) on the sender's path: GET /api/devices answers without
// serverCapabilities, exactly the response shape those builds produced.
// Everything else is still the real handler.
func (f *Faults) SetLegacyServer(on bool) { f.legacy.Store(on) }

func (f *Faults) legacyDevices(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !f.legacy.Load() || r.Method != http.MethodGet || r.URL.Path != "/api/devices" {
			h.ServeHTTP(w, r)
			return
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		body := rec.Body.Bytes()
		if rec.Code == http.StatusOK {
			var m map[string]json.RawMessage
			if err := json.Unmarshal(body, &m); err == nil {
				delete(m, "serverCapabilities")
				body, _ = json.Marshal(m)
			}
		}
		for k, v := range rec.Header() {
			if k != "Content-Length" {
				w.Header()[k] = v
			}
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(body)
	})
}

func (f *Faults) wrap(inner http.Handler) http.Handler {
	h := f.legacyDevices(inner)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(bypassHeader) != "" {
			r.Header.Del(bypassHeader)
			h.ServeHTTP(w, r)
			return
		}
		k := classify(r)
		if k == KeyPatch {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(body))
			var start int64
			if cr := r.Header.Get("Content-Range"); strings.HasPrefix(cr, "bytes ") {
				s, _, _ := strings.Cut(strings.TrimPrefix(cr, "bytes "), "-")
				for _, c := range s {
					start = start*10 + int64(c-'0')
				}
			}
			f.mu.Lock()
			f.patches = append(f.patches, Patch{UploadID: strings.TrimPrefix(r.URL.Path, "/api/uploads/"), Start: start, Body: body})
			f.mu.Unlock()
		}
		if k == KeyCreate {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(body))
			f.mu.Lock()
			f.creates = append(f.creates, body)
			f.mu.Unlock()
		}
		f.mu.Lock()
		f.hits[k]++
		obs := f.observe
		f.mu.Unlock()
		if obs != nil {
			obs(k)
		}
		rule := f.take(r)
		if rule == nil {
			h.ServeHTTP(w, r)
			return
		}
		if rule.Hit != nil {
			defer func() {
				select {
				case <-rule.Hit:
				default:
					close(rule.Hit)
				}
			}()
		}
		switch rule.Action {
		case DropResponse:
			h.ServeHTTP(&swallow{ResponseWriter: w, hdr: http.Header{}}, r)
			hangUp(w)
		case TruncateAndDrop:
			body, _ := io.ReadAll(r.Body)
			half := body[:len(body)/2]
			r.Body = io.NopCloser(bytes.NewReader(half))
			r.ContentLength = int64(len(half))
			h.ServeHTTP(&swallow{ResponseWriter: w, hdr: http.Header{}}, r)
			hangUp(w)
		case Redirect:
			w.Header().Set("Location", rule.Location)
			w.WriteHeader(http.StatusTemporaryRedirect)
		case HoldResponse:
			h.ServeHTTP(&swallow{ResponseWriter: w, hdr: http.Header{}}, r)
			if rule.Hit != nil {
				select {
				case <-rule.Hit:
				default:
					close(rule.Hit)
				}
			}
			<-rule.release
			hangUp(w)
		case Before:
			if rule.Fn != nil {
				rule.Fn(r)
			}
			h.ServeHTTP(w, r)
		case Status:
			w.WriteHeader(rule.Code)
		case HoldUnhandled:
			if rule.Hit != nil {
				select {
				case <-rule.Hit:
				default:
					close(rule.Hit)
				}
			}
			<-rule.release
			hangUp(w)
		}
	})
}
