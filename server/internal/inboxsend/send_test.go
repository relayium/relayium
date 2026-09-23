package inboxsend

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
	"github.com/relayium/relayium/internal/storecrypto"
)

// nonceRegistry is C1: every (sealer instance, seq) ever sealed. A repeat is a
// nonce reuse under one content key and fails the test that caused it.
type nonceRegistry struct {
	mu   sync.Mutex
	seen map[[2]uint64]int
}

func watchNonces(t *testing.T) *nonceRegistry {
	t.Helper()
	r := &nonceRegistry{seen: map[[2]uint64]int{}}
	sealObserver = func(inst, seq uint64) {
		r.mu.Lock()
		r.seen[[2]uint64{inst, seq}]++
		r.mu.Unlock()
	}
	t.Cleanup(func() {
		sealObserver = nil
		r.mu.Lock()
		defer r.mu.Unlock()
		for k, n := range r.seen {
			if n != 1 {
				t.Errorf("C1: sealer %d sealed seq %d %d times", k[0], k[1], n)
			}
		}
	})
	return r
}

// seals is how many units were sealed in total.
func (r *nonceRegistry) seals() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.seen)
}

func fastBackoff(t *testing.T) {
	old := uploadBackoff
	uploadBackoff = func(int) time.Duration { return time.Millisecond }
	t.Cleanup(func() { uploadBackoff = old })
}

func framesFor(sizes ...int) int {
	n := 0
	for _, s := range sizes {
		n += (s + storecrypto.ChunkSize - 1) / storecrypto.ChunkSize
	}
	return n
}

// assertBytesMatchFinalBlob is N4 observed on the wire: every byte of every
// PATCH ever sent equals the committed ciphertext at that offset, so nothing
// was re-encrypted differently for a replay.
func assertBytesMatchFinalBlob(t *testing.T, patches []sendtest.Patch, blob []byte) {
	t.Helper()
	for i, p := range patches {
		end := p.Start + int64(len(p.Body))
		if end > int64(len(blob)) || !bytes.Equal(blob[p.Start:end], p.Body) {
			t.Fatalf("N4: PATCH #%d at %d (%d bytes) differs from the committed ciphertext", i, p.Start, len(p.Body))
		}
	}
}

// keySpellings is every encoding of the content key a leak could take (C2).
func keySpellings(k []byte) []string {
	return []string{
		string(k), hex.EncodeToString(k), strings.ToUpper(hex.EncodeToString(k)),
		base64.StdEncoding.EncodeToString(k), base64.RawStdEncoding.EncodeToString(k),
		base64.URLEncoding.EncodeToString(k), base64.RawURLEncoding.EncodeToString(k),
		fmt.Sprint(k), fmt.Sprintf("%v", k), fmt.Sprintf("%x", k),
	}
}

func assertNoKey(t *testing.T, where string, text []byte, key []byte) {
	t.Helper()
	for _, s := range keySpellings(key) {
		if bytes.Contains(text, []byte(s)) {
			t.Fatalf("C2: content key found in %s", where)
		}
	}
}

// E1/E2/C1/C2/N4: a multi-chunk delivery with a nested folder and a zero-length
// file survives a lost PATCH acknowledgement and a connection dropped
// mid-chunk: one upload, one quota reservation, byte-exact delivery, no nonce
// sealed twice, every re-sent byte identical, and the content key nowhere on
// disk or in the notices.
func TestSendSurvivesLostAckAndMidChunkDropWithoutResealing(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 64<<20)
	big := randomBytes(t, 9<<20+12345) // > one 8 MiB server chunk
	small := []byte("hello, device\n")
	root := writeTree(t, map[string][]byte{"docs/big.bin": big, "docs/sub/note.txt": small, "docs/empty.txt": {}})
	if err := os.MkdirAll(filepath.Join(root, "docs", "nothing-here"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Snapshot the journal directory at every request, so C2 sees each phase.
	var snaps [][]byte
	var smu sync.Mutex
	w.env.Faults.SetObserve(func(string) {
		smu.Lock()
		defer smu.Unlock()
		for _, b := range w.journalFiles() {
			snaps = append(snaps, b)
		}
	})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Action: sendtest.DropResponse})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Action: sendtest.TruncateAndDrop}) // sees PATCHes after the drop above

	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "docs")}})
	if err != nil {
		t.Fatalf("send: %v\nnotices:\n%s", err, w.notice.String())
	}
	if res.State != "queued" || !res.Created || res.TaskID == "" {
		t.Fatalf("result = %+v; want a newly created queued task", res)
	}
	if got := w.env.Faults.Hits(sendtest.KeyInit); got != 1 {
		t.Fatalf("inits = %d, want exactly 1", got)
	}
	if got := w.env.Faults.Hits(sendtest.KeyFinalize); got != 1 {
		t.Fatalf("finalizes = %d, want 1", got)
	}
	d := w.receive(res.TaskID)
	if !bytes.Equal(d.files["docs/big.bin"], big) || !bytes.Equal(d.files["docs/sub/note.txt"], small) ||
		len(d.files["docs/empty.txt"]) != 0 || len(d.manifest.Items) != 3 {
		t.Fatalf("delivered content differs: %d items", len(d.manifest.Items))
	}
	if int64(len(d.blob)) != res.CiphertextBytes {
		t.Fatalf("ciphertext %d bytes, planned %d", len(d.blob), res.CiphertextBytes)
	}
	if q := w.env.QuotaBytes(w.uid); q != res.CiphertextBytes {
		t.Fatalf("daily quota reserved %d, want exactly one upload's %d", q, res.CiphertextBytes)
	}
	if want := 1 + framesFor(len(big), len(small), 0); reg.seals() != want {
		t.Fatalf("C1: sealed %d units, want manifest + %d frames", reg.seals(), want-1)
	}
	assertBytesMatchFinalBlob(t, w.env.Faults.Patches(), d.blob)
	if len(w.env.Faults.Patches()) < 3 {
		t.Fatalf("expected replays after the injected faults, saw %d PATCHes", len(w.env.Faults.Patches()))
	}
	if len(snaps) == 0 {
		t.Fatal("no journal snapshot was taken")
	}
	for i, s := range snaps {
		assertNoKey(t, fmt.Sprintf("journal snapshot %d", i), s, d.contentKey)
	}
	assertNoKey(t, "notices", w.notice.Bytes(), d.contentKey)
	assertNoKey(t, "result", []byte(fmt.Sprintf("%+v %#v", res, res)), d.contentKey)
	if !strings.Contains(w.notice.String(), "not sent (empty folder): docs/nothing-here") {
		t.Fatalf("empty folder not reported:\n%s", w.notice.String())
	}
	if files := w.journalFiles(); len(files) > 1 { // only the lock file may remain
		t.Fatalf("journal not removed after success: %v", files)
	}
}

// E3: the device rotates its key after the upload; the create is refused
// stale_target_key; the SAME content key is re-wrapped once to the new key
// (no frame re-sealed, no second upload) and the delivery opens with it.
func TestStaleKeyAfterUploadRewrapsOnceWithoutReupload(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("rotate me")})
	old := w.target.activeKeyID(t)
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.Before,
		Fn: func(*http.Request) { w.target.rotate(t, old) }})
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	creates := w.env.Faults.Creates()
	if len(creates) != 2 || bytes.Equal(creates[0], creates[1]) {
		t.Fatalf("want exactly two distinct creates (stale, then re-wrapped), got %d", len(creates))
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 1 || w.env.Faults.Hits(sendtest.KeyFinalize) != 1 {
		t.Fatal("a stale key must not cause a second upload")
	}
	d := w.receive(res.TaskID)
	if d.keyID == old || string(d.files["a.txt"]) != "rotate me" {
		t.Fatalf("delivery was not sealed to the new key (key %s)", d.keyID)
	}
	if reg.seals() != 2 {
		t.Fatalf("C1: %d seals, want manifest + 1 frame (re-wrap seals nothing)", reg.seals())
	}
	if !strings.Contains(w.notice.String(), "receiving key changed") {
		t.Fatal("the re-wrap is not reported")
	}
}

// E4/N6: the create's answer is lost after central committed it. The replay
// is byte-identical and converges on the one task.
func TestLostCreateResponseReplaysIdenticalBytesAndConverges(t *testing.T) {
	fastBackoff(t)
	watchNonces(t)
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("once only")})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.DropResponse})
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	creates := w.env.Faults.Creates()
	if len(creates) != 2 || !bytes.Equal(creates[0], creates[1]) {
		t.Fatalf("want two byte-identical creates, got %d", len(creates))
	}
	if res.Created {
		t.Fatal("the converged replay must report created=false")
	}
	if n := len(w.tasks()); n != 1 {
		t.Fatalf("tasks on the device = %d, want 1", n)
	}
}

// Ambiguity first, explicit refusal second: an ambiguous create is replayed
// with the SAME bytes before anything changes; only the explicit
// stale_target_key that follows licenses a re-wrap.
func TestAmbiguousCreateIsReplayedBeforeAnyRewrap(t *testing.T) {
	fastBackoff(t)
	watchNonces(t)
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("x")})
	old := w.target.activeKeyID(t)
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.Status, Code: http.StatusBadGateway})
	// Rules are consulted in order, so this one sees only the requests after
	// the 502 above has fired.
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.Before,
		Fn: func(*http.Request) { w.target.rotate(t, old) }})
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	c := w.env.Faults.Creates()
	if len(c) != 3 || !bytes.Equal(c[0], c[1]) || bytes.Equal(c[1], c[2]) {
		t.Fatalf("want [A, A, B]: replay first, re-wrap only after stale; got %d creates", len(c))
	}
	if d := w.receive(res.TaskID); d.keyID == old {
		t.Fatal("not sealed to the rotated key")
	}
}

// E5/N5: the finalize answer is lost against today's server (no recovery). The
// outcome is unknown, the record is kept, and nothing is uploaded again — not
// by the command and not by `retry`. Quota holds exactly the one upload.
func TestLostFinalizeIsUnknownAndNeverUploadsAgain(t *testing.T) {
	fastBackoff(t)
	watchNonces(t)
	w := newWorld(t, 4<<20)
	// A server without finalize recovery (every server before Stage 0).
	w.env.Faults.EmulatePreRecoveryServer()
	root := writeTree(t, map[string][]byte{"a.bin": randomBytes(t, 300_000)})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.DropResponse})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.bin")}})
	e := AsError(err)
	if e == nil || e.Class != ClassUnknown || e.Code != CodeUnknownOutcome || e.LocalSendID == "" {
		t.Fatalf("err = %v; want ClassUnknown unknown_outcome with a local send id", err)
	}
	quota := w.env.QuotaBytes(w.uid)
	if quota == 0 {
		t.Fatal("the first finalize should have committed")
	}
	if !strings.Contains(e.Msg, "Nothing will be uploaded again automatically") {
		t.Fatalf("message: %s", e.Msg)
	}
	j, lerr := newJournalStore(w.cfgDir).load(e.LocalSendID)
	if lerr != nil || j.Phase != PhaseFinalizing {
		t.Fatalf("journal = %+v, %v; want kept in phase finalizing", j, lerr)
	}

	_, err = w.session().Retry(context.Background(), e.LocalSendID)
	if re := AsError(err); re == nil || re.Class != ClassUnknown {
		t.Fatalf("retry err = %v; want unknown again (this server cannot confirm)", err)
	}
	if got := w.env.Faults.Hits(sendtest.KeyInit); got != 1 {
		t.Fatalf("inits = %d; a lost finalize must never start another upload", got)
	}
	if got := w.env.QuotaBytes(w.uid); got != quota {
		t.Fatalf("quota moved %d -> %d without a new upload", quota, got)
	}
	if n := len(w.tasks()); n != 0 {
		t.Fatalf("tasks = %d, want none", n)
	}
}

// C3: the session is reaped before finalize. The send fails definitively, no
// second session is opened, and no seq is sealed again.
func TestReapedSessionFailsWithoutReinitOrReseal(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 32<<20)
	data := randomBytes(t, 9<<20)
	root := writeTree(t, map[string][]byte{"a.bin": data})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Skip: 1, Action: sendtest.Before,
		Fn: func(r *http.Request) {
			id := strings.TrimPrefix(r.URL.Path, "/api/uploads/")
			if err := w.env.Store.DeleteUploadSession(context.Background(), id); err != nil {
				t.Errorf("reap: %v", err)
			}
		}})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.bin")}})
	e := AsError(err)
	if e == nil || e.Class != ClassFailed || e.Code != CodeUploadLost {
		t.Fatalf("err = %v; want upload_lost", err)
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 1 || w.env.Faults.Hits(sendtest.KeyFinalize) != 0 {
		t.Fatal("a reaped session must not be re-initialised or finalized")
	}
	if want := 1 + framesFor(len(data)); reg.seals() > want {
		t.Fatalf("C1: %d seals for a %d-frame file", reg.seals(), want-1)
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatalf("a definitive failure left a journal: %v", ids)
	}
}

// E8: the source grows, shrinks or is replaced between planning and reading:
// source_changed, no finalize.
func TestSourceChangeStopsBeforeFinalize(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(t *testing.T, path string)
	}{
		{"grows", func(t *testing.T, p string) { appendFile(t, p, []byte("more")) }},
		{"shrinks", func(t *testing.T, p string) {
			if err := os.Truncate(p, 10); err != nil {
				t.Fatal(err)
			}
		}},
		{"replaced by another file of the same size", func(t *testing.T, p string) {
			other := p + ".new"
			if err := os.WriteFile(other, bytes.Repeat([]byte("Z"), 200_000), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(other, p); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fastBackoff(t)
			w := newWorld(t, 4<<20)
			root := writeTree(t, map[string][]byte{"a.bin": randomBytes(t, 200_000)})
			p := filepath.Join(root, "a.bin")
			w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/uploads", PathSuffix: "/api/uploads",
				Action: sendtest.Before, Fn: func(*http.Request) { tc.mutate(t, p) }})
			_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{p}})
			if e := AsError(err); e == nil || e.Code != CodeSourceChanged {
				t.Fatalf("err = %v; want source_changed", err)
			}
			if w.env.Faults.Hits(sendtest.KeyFinalize) != 0 {
				t.Fatal("a changed source reached finalize")
			}
		})
	}
}

// A path swapped for a FIFO after planning must fail, not hang in open(2).
func TestSourceSwappedForFIFODoesNotHang(t *testing.T) {
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.bin": []byte("regular")})
	p := filepath.Join(root, "a.bin")
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/uploads", PathSuffix: "/api/uploads",
		Action: sendtest.Before, Fn: func(*http.Request) {
			_ = os.Remove(p)
			if err := mkfifo(p); err != nil {
				t.Skipf("mkfifo: %v", err)
			}
		}})
	done := make(chan error, 1)
	go func() {
		_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{p}})
		done <- err
	}()
	select {
	case err := <-done:
		if e := AsError(err); e == nil || e.Code != CodeSourceChanged {
			t.Fatalf("err = %v; want source_changed", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the send hung opening a FIFO")
	}
}

// E10: a 307 on init or on PATCH is refused; the redirect target never sees a
// request, so neither the bearer nor ciphertext reaches it.
func TestRedirectsAreRefusedAndNothingReachesTheTarget(t *testing.T) {
	for _, tc := range []struct {
		name string
		rule sendtest.Rule
	}{
		{"init", sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/uploads", PathSuffix: "/api/uploads"}},
		{"patch", sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/"}},
		{"create", sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fastBackoff(t)
			var elsewhere atomic.Int64
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				elsewhere.Add(1)
				w.WriteHeader(http.StatusOK)
			}))
			defer other.Close()
			w := newWorld(t, 4<<20)
			root := writeTree(t, map[string][]byte{"a.txt": []byte("secret")})
			rule := tc.rule
			rule.Action, rule.Location = sendtest.Redirect, other.URL+"/steal"
			w.env.Faults.Add(&rule)
			_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
			if n := elsewhere.Load(); n != 0 {
				t.Fatalf("the redirect target received %d requests", n)
			}
			if e := AsError(err); e == nil || e.Code != CodeRedirectRefused {
				t.Fatalf("err = %v; want redirect_refused", err)
			}
		})
	}
}

// E7 (package level): a target the verdict refuses costs nothing — no upload
// session is opened.
func TestRefusedTargetOpensNoUpload(t *testing.T) {
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("x")})
	// receive off on the target
	if _, err := w.target.client.Enrol(context.Background(), enrolWith("off")); err != nil {
		t.Fatalf("re-enrol off: %v", err)
	}
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	if e := AsError(err); e == nil || e.Code != CodeTargetUnavailable || !strings.Contains(e.Msg, "turned off") {
		t.Fatalf("err = %v; want target_unavailable (receive off)", err)
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 0 {
		t.Fatal("an upload was opened for a refused target")
	}
	if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
		t.Fatal("a refused send left a journal")
	}
}

// Interrupted while the finalize answer is in flight, then `retry` from the
// journal: without server recovery it is still unknown, and it never uploads.
// Interrupted while the create answer is in flight (finalize known): `retry`
// replays the journalled create and converges on one task.
func TestInterruptThenRetryByPhase(t *testing.T) {
	t.Run("finalizing (server without finalize recovery)", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		w.env.Faults.EmulatePreRecoveryServer()
		root := writeTree(t, map[string][]byte{"a.txt": []byte("x")})
		hold := w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
		id := interruptAt(t, w, hold, filepath.Join(root, "a.txt"))
		_, err := w.session().Retry(context.Background(), id)
		if e := AsError(err); e == nil || e.Class != ClassUnknown {
			t.Fatalf("retry = %v; want unknown", err)
		}
		if w.env.Faults.Hits(sendtest.KeyInit) != 1 || len(w.tasks()) != 0 {
			t.Fatal("retry must not upload or invent a task")
		}
	})
	t.Run("finalizing (finalize recovery)", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		root := writeTree(t, map[string][]byte{"a.txt": []byte("held finalize")})
		hold := w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
		id := interruptAt(t, w, hold, filepath.Join(root, "a.txt"))
		res := assertRetryConverges(t, w, id, w.env.QuotaBytes(w.uid))
		if string(w.receive(res.TaskID).files["a.txt"]) != "held finalize" {
			t.Fatal("content differs")
		}
	})
	t.Run("finalized", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		root := writeTree(t, map[string][]byte{"a.txt": []byte("finish me")})
		hold := w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
		id := interruptAt(t, w, hold, filepath.Join(root, "a.txt"))
		res, err := w.session().Retry(context.Background(), id)
		if err != nil {
			t.Fatalf("retry: %v", err)
		}
		if res.Created {
			t.Fatal("the held create had landed; retry must converge on it")
		}
		c := w.env.Faults.Creates()
		if len(c) != 2 || !bytes.Equal(c[0], c[1]) {
			t.Fatal("retry must replay the journalled create byte for byte")
		}
		if len(w.tasks()) != 1 || w.env.Faults.Hits(sendtest.KeyInit) != 1 {
			t.Fatal("want one task and one upload")
		}
		if string(w.receive(res.TaskID).files["a.txt"]) != "finish me" {
			t.Fatal("content differs")
		}
		if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
			t.Fatal("journal kept after completion")
		}
	})
	t.Run("create landed, then the device key changed", func(t *testing.T) {
		fastBackoff(t)
		w := newWorld(t, 4<<20)
		root := writeTree(t, map[string][]byte{"a.txt": []byte("x")})
		hold := w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
		id := interruptAt(t, w, hold, filepath.Join(root, "a.txt"))
		// The held create DID land. After a rotation a replay still converges:
		// central answers an existing idempotency key before it checks the key.
		w.target.rotate(t, w.target.activeKeyID(t))
		if _, err := w.session().Retry(context.Background(), id); err != nil {
			t.Fatalf("retry after the landed create: %v", err)
		}
		if len(w.tasks()) != 1 {
			t.Fatal("want exactly one task")
		}
	})
}

// interruptAt starts a send, waits until hold's request reached central, then
// cancels the command and returns the kept local send id.
func interruptAt(t *testing.T, w *world, hold *sendtest.Rule, path string) string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := w.session().Send(ctx, SendRequest{To: w.target.id, Paths: []string{path}})
		errc <- err
	}()
	select {
	case <-hold.Hit:
	case <-time.After(30 * time.Second):
		t.Fatal("the held request never arrived")
	}
	cancel()
	err := <-errc
	hold.Release()
	e := AsError(err)
	if e == nil || e.Class != ClassInterrupted || e.LocalSendID == "" {
		t.Fatalf("interrupt = %v; want ClassInterrupted with a kept local send id", err)
	}
	return e.LocalSendID
}

// Retry refuses a record made under another login or server before any
// request carries the bearer anywhere.
func TestRetryRefusesAForeignRecord(t *testing.T) {
	w := newWorld(t, 4<<20)
	st := newJournalStore(w.cfgDir)
	j := validJournal()
	j.Server = "https://elsewhere.example"
	if err := st.save(j); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int64
	w.env.Faults.SetObserve(func(string) { hits.Add(1) })
	_, err := w.session().Retry(context.Background(), j.ID)
	if e := AsError(err); e == nil || e.Code != CodeJournalMismatch {
		t.Fatalf("err = %v; want journal_mismatch", err)
	}
	if hits.Load() != 0 {
		t.Fatal("a foreign record caused a request")
	}
	// Same server, but a different source device (a re-login).
	j2 := validJournal()
	j2.ID = strings.Repeat("b", 32)
	j2.Server = w.session().client.Server()
	j2.AccountEmail = "sender@example.com"
	if err := st.save(j2); err != nil {
		t.Fatal(err)
	}
	_, err = w.session().Retry(context.Background(), j2.ID)
	if e := AsError(err); e == nil || e.Code != CodeJournalMismatch {
		t.Fatalf("err = %v; want journal_mismatch for another device", err)
	}
	if w.env.Faults.Hits(sendtest.KeyFinalize)+w.env.Faults.Hits(sendtest.KeyCreate) != 0 {
		t.Fatal("a foreign record reached finalize/create")
	}
}

// Self-target: the current device, enrolled, explicitly named, is a working
// target (no invented self ban).
func TestCurrentDeviceIsAValidTarget(t *testing.T) {
	w := newWorld(t, 4<<20)
	// Make the SENDER login the enrolled target by pointing the credential at
	// the target device's own bearer.
	saveCreds(t, w.cfgDir, w.env.TS.URL, w.target.token)
	root := writeTree(t, map[string][]byte{"self.txt": []byte("note to self")})
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "self.txt")}})
	if err != nil {
		t.Fatalf("send to self: %v", err)
	}
	if string(w.receive(res.TaskID).files["self.txt"]) != "note to self" {
		t.Fatal("content differs")
	}
	tasks := w.tasks()
	if len(tasks) != 1 || tasks[0].SourceDeviceID != w.target.id {
		t.Fatal("central should record the device as its own source")
	}
}

func appendFile(t *testing.T, p string, b []byte) {
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
		t.Fatal(err)
	}
}

func validJournal() *Journal {
	return &Journal{
		V: journalVersion, ID: strings.Repeat("a", 32), Phase: PhaseFinalized,
		Server: "http://127.0.0.1:1", AccountEmail: "x@example.com",
		SourceDeviceID: "src", TargetDeviceID: "dst", TargetKeyID: "k1", TargetKeyGeneration: 1,
		WrappedKey:     base64.RawURLEncoding.EncodeToString(make([]byte, 80)),
		IdempotencyKey: "cli-" + strings.Repeat("0", 32), CiphertextBytes: 10,
		ManifestSHA256: strings.Repeat("0", 64), UploadID: "up1", StoredFileID: "sf1",
		ExpiresAt: 99, CreatedAt: time.Now().Unix(),
	}
}

func enrolWith(policy string) inboxclient.EnrolRequest {
	return inboxclient.EnrolRequest{
		Platform: inboxclient.Platform(), AppVersion: "test", ProtocolVersions: inboxclient.ProtocolVersions(),
		Capabilities: inboxclient.Capabilities(), AutoAccept: policy, ReceiveDirReady: true,
	}
}

func saveCreds(t *testing.T, dir, server, token string) {
	t.Helper()
	if err := cloud.Save(dir, cloud.Creds{Server: server, AccessToken: token, AccountEmail: "sender@example.com"}); err != nil {
		t.Fatal(err)
	}
}

// The verdict is re-derived from a FRESH device read immediately before the
// first write: a device that turns receiving off after --to was resolved costs
// nothing (no upload is opened).
func TestFreshReadBeforeFirstWriteCatchesALateTurnOff(t *testing.T) {
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("x")})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodGet, PathPrefix: "/api/devices", PathSuffix: "/api/devices", Skip: 1,
		Action: sendtest.Before, Fn: func(*http.Request) {
			if _, err := w.target.client.Enrol(context.Background(), enrolWith("off")); err != nil {
				t.Errorf("turn off: %v", err)
			}
		}})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	if e := AsError(err); e == nil || e.Code != CodeTargetUnavailable {
		t.Fatalf("err = %v; want target_unavailable from the fresh read", err)
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 0 {
		t.Fatal("an upload was opened although the device had turned receiving off")
	}
}

// Only zero-length files: the upload would carry no bytes, the server keeps no
// ciphertext object, and a receiver's fetch answers stored_object_unavailable
// (observed against the real handlers while writing this). So it is refused
// locally, before any request; a mix with one non-empty file is fine.
func TestAllEmptyDeliveryIsRefusedLocally(t *testing.T) {
	w := newWorld(t, 4<<20)
	var requests atomic.Int64
	w.env.Faults.SetObserve(func(string) { requests.Add(1) })
	root := writeTree(t, map[string][]byte{"e/a": {}, "e/b/c": {}, "m/x": {}, "m/y": []byte("1")})
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "e")}})
	if e := AsError(err); e == nil || e.Class != ClassLocal || e.Code != CodeUnsendableContent {
		t.Fatalf("err = %v; want a local refusal", err)
	}
	if requests.Load() != 0 {
		t.Fatal("an all-empty delivery reached the network")
	}
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "m")}})
	if err != nil {
		t.Fatalf("mixed send: %v", err)
	}
	d := w.receive(res.TaskID)
	if len(d.files["m/x"]) != 0 || string(d.files["m/y"]) != "1" {
		t.Fatal("mixed delivery differs")
	}
}

// A delivery to a device that later cleared its inbox is still listed (as
// revoked), not silently dropped from `sent`.
func TestSentStillShowsDeliveriesToADisabledDevice(t *testing.T) {
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"a.txt": []byte("x")})
	s := w.session()
	res, err := s.Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "a.txt")}})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.target.client.ClearInbox(context.Background()); err != nil {
		t.Fatal(err)
	}
	tasks, err := s.Sent(context.Background(), "", false, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].TaskID != res.TaskID || tasks[0].State != "revoked" {
		t.Fatalf("sent = %+v; want the revoked delivery", tasks)
	}
}

// Asking `retry` about an id with no record creates nothing on disk.
func TestRetryOfAnUnknownIDLeavesNothing(t *testing.T) {
	w := newWorld(t, 4<<20)
	_, err := w.session().Retry(context.Background(), strings.Repeat("f", 32))
	if e := AsError(err); e == nil || e.Code != CodeNoSuchSend || e.Class != ClassLocal {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(w.cfgDir, journalDirName)); !os.IsNotExist(err) {
		t.Fatal("retry of an unknown id created the journal directory")
	}
}
