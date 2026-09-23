package inboxsend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inboxsend/sendlock"
)

// ---------------------------------------------------------------- F1 formatting

// N2's sibling for the account credential: no fmt verb applied to a Client or
// a Session — pointer or value, directly or inside a parent struct — prints
// the bearer. The sealer's own key is covered by TestSealerNeverPrintsItsKey,
// including its value form.
func TestCredentialHoldersNeverPrintTheBearer(t *testing.T) {
	const dummy = "DUMMY-BEARER-NOT-A-REAL-CREDENTIAL"
	dir := t.TempDir()
	saveCreds(t, dir, "https://example.invalid", dummy)
	s, err := Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := s.client
	type parent struct {
		name string
		c    *Client
		cv   Client
		s    *Session
		sv   Session
	}
	p := parent{name: "x", c: c, cv: *c, s: s, sv: *s}
	values := map[string]any{
		"client-pointer": c, "client-value": *c,
		"session-pointer": s, "session-value": *s,
		"parent-value": p, "parent-pointer": &p,
	}
	spellings := []string{dummy, base64.StdEncoding.EncodeToString([]byte(dummy)), fmt.Sprintf("%x", dummy)}
	for name, v := range values {
		for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
			out := fmt.Sprintf(verb, v)
			for _, sp := range spellings {
				if strings.Contains(out, sp) {
					t.Errorf("%s %s printed the bearer: %q", name, verb, out)
				}
			}
		}
	}
	// And the bearer still reaches the server it belongs to.
	var got string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.Write([]byte(`{"devices":[]}`))
	}))
	defer ts.Close()
	c2, err := NewClient(ts.URL, dummy, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c2.ListDevices(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got != "Bearer "+dummy {
		t.Fatalf("Authorization = %q", got)
	}
}

// ---------------------------------------------------------------- F2 strict record

// The record must be the whole file: a valid document followed by anything
// but whitespace is refused, including a closing delimiter that Decoder.More
// does not report.
func TestJournalRefusesAnythingAfterTheRecord(t *testing.T) {
	st := newJournalStore(t.TempDir())
	if err := st.ensure(); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	j := Journal{V: journalVersion, ID: id, Phase: PhasePlanned, Server: "https://example.invalid",
		AccountEmail: "dummy@example.invalid", SourceDeviceID: id, TargetDeviceID: id, TargetKeyID: id,
		TargetKeyGeneration: 1, WrappedKey: base64.RawURLEncoding.EncodeToString(make([]byte, 80)),
		IdempotencyKey: "cli-" + id, ManifestSHA256: strings.Repeat("a", 64), CreatedAt: 1}
	b, err := json.Marshal(j)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		suffix string
		ok     bool
	}{
		{"", true}, {"\n", true}, {" \t\r\n ", true},
		{"]", false}, {"}", false}, {",", false}, {"x", false}, {"{}", false}, {"null", false},
		{"\n]", false}, {string(b), false}, {"\x00", false},
	} {
		if err := os.WriteFile(st.path(id), append(append([]byte(nil), b...), tc.suffix...), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := st.load(id)
		if tc.ok && err != nil {
			t.Errorf("suffix %q: valid record refused: %v", tc.suffix, err)
		}
		if !tc.ok && err == nil {
			t.Errorf("suffix %q: malformed record accepted", tc.suffix)
		}
	}
}

// ---------------------------------------------------------------- F4 wait deadline

func fastPoll(t *testing.T, d time.Duration) {
	old := pollDelays
	pollDelays.min, pollDelays.max = d, d
	t.Cleanup(func() { pollDelays = old })
}

// heldBodyServer answers every request with 200 headers, then keeps the body
// open until the request is cancelled or the test ends.
func heldBodyServer(t *testing.T) (*httptest.Server, chan struct{}) {
	hit := make(chan struct{}, 16)
	release := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		select {
		case hit <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(func() { close(release); ts.Close() })
	return ts, hit
}

func waitSession(t *testing.T, server string) *Session {
	c, err := NewClient(server, "dummy", nil)
	if err != nil {
		t.Fatal(err)
	}
	return &Session{client: c, now: time.Now}
}

// The wait's own duration bounds a status read whose body never finishes: it
// ends as ErrWaitTimeout with the last state it knew, not as an interruption,
// and long before the transport's own header timeout could matter.
func TestWaitDeadlineCancelsAHeldStatusBody(t *testing.T) {
	fastPoll(t, time.Millisecond)
	ts, hit := heldBodyServer(t)
	s := waitSession(t, ts.URL)
	start := time.Now()
	type out struct {
		st  SentTask
		err error
	}
	done := make(chan out, 1)
	go func() {
		st, err := s.Wait(context.Background(), "target", "task", 150*time.Millisecond, "queued")
		done <- out{st, err}
	}()
	select {
	case <-hit:
	case <-time.After(5 * time.Second):
		t.Fatal("no status read reached the server")
	}
	select {
	case o := <-done:
		if !errors.Is(o.err, ErrWaitTimeout) {
			t.Fatalf("err = %v; want ErrWaitTimeout", o.err)
		}
		if o.st.State != "queued" {
			t.Fatalf("state = %q; want the last known state", o.st.State)
		}
		if el := time.Since(start); el > 2*time.Second {
			t.Fatalf("Wait(150ms) took %s", el)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Wait(150ms) is still blocked in a held response body after 3s")
	}
}

// A sleep between polls is bounded by the same deadline.
func TestWaitDeadlineCutsTheSleepShort(t *testing.T) {
	fastPoll(t, time.Hour)
	s := waitSession(t, "http://127.0.0.1:9") // never contacted
	start := time.Now()
	st, err := s.Wait(context.Background(), "target", "task", 100*time.Millisecond, "notified")
	if !errors.Is(err, ErrWaitTimeout) || st.State != "notified" {
		t.Fatalf("Wait = %+v, %v; want ErrWaitTimeout with state notified", st, err)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("Wait(100ms) slept %s", el)
	}
}

// The user's interrupt — the caller's context — is an interruption, never a
// timeout, whether it lands in a held request or in a sleep.
func TestWaitInterruptIsNotATimeout(t *testing.T) {
	for _, held := range []bool{true, false} {
		t.Run(fmt.Sprint("held=", held), func(t *testing.T) {
			var s *Session
			var hit chan struct{}
			if held {
				fastPoll(t, time.Millisecond)
				var ts *httptest.Server
				ts, hit = heldBodyServer(t)
				s = waitSession(t, ts.URL)
			} else {
				fastPoll(t, time.Hour)
				s = waitSession(t, "http://127.0.0.1:9")
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() {
				_, err := s.Wait(ctx, "target", "task", time.Hour, "queued")
				done <- err
			}()
			if held {
				<-hit
			} else {
				time.Sleep(20 * time.Millisecond)
			}
			cancel()
			select {
			case err := <-done:
				e := AsError(err)
				if errors.Is(err, ErrWaitTimeout) || e == nil || e.Class != ClassInterrupted {
					t.Fatalf("err = %v; want an interruption", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("cancellation did not release Wait")
			}
		})
	}
}

// ---------------------------------------------------------------- lock

// While another holder has a send's lock, retry refuses without a request.
// (Exclusion between separate PROCESSES, on Unix and Windows, is proven in
// package sendlock.)
func TestRetryRefusesARecordAnotherCommandHolds(t *testing.T) {
	requests := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++ }))
	defer ts.Close()
	dir := t.TempDir()
	saveCreds(t, dir, ts.URL, "dummy")
	s, err := Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("b", 32)
	if err := s.store.ensure(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.store.path(id), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	held, err := sendlock.Acquire(filepath.Join(dir, journalDirName, "."+id+".lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	_, err = s.Retry(context.Background(), id)
	if e := AsError(err); e == nil || e.Code != CodeJournalBusy {
		t.Fatalf("retry = %v; want journal_busy", err)
	}
	if requests != 0 {
		t.Fatalf("%d requests while another command held the record", requests)
	}
}
