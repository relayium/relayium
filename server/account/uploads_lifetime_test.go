package account

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

// Sixth adversarial suite: HOW LONG one PATCH may live.
//
// A room's void deletes an upload's session row and its blob, and keeps a delete
// intent on the books for pairRoomBlobHold afterwards, because an append that
// read that row a moment earlier may still be streaming and will re-create the
// key when it lands. That is the crash net, and it is only a net if "still
// streaming" has an upper bound.
//
// It had none. The server sets no ReadTimeout (it must not — /ws is a hijacked,
// long-lived connection), DiskStore.Append copied its reader to completion
// without consulting a context, and a client that is merely SLOW never cancels
// the request context, so nothing anywhere in the path was counting. A
// drip-feeding sender could hold one append open past the hold, land its bytes
// on a key nothing points at any more, and leave ciphertext with no owner at
// all — the exact outcome the hold exists to make impossible.

// THE INVARIANT. Everything else in this file is a mechanism; this is the number
// the mechanism has to produce. If a future change lengthens an append or
// shortens the hold, this is what says so.
func TestAnAppendCannotOutliveTheHoldOnItsBlob(t *testing.T) {
	hold := time.Duration(pairRoomBlobHold) * time.Second
	worst := maxAppendLifetime + appendSettlementSlack
	if worst >= hold {
		t.Fatalf("one PATCH may live %s (%s of append + %s of settlement) but the delete intent covering its blob is retired after %s: an append can land on a key nothing owns",
			worst, maxAppendLifetime, appendSettlementSlack, hold)
	}
	// Not merely under it — under it by enough that scheduler delay, a slow
	// filesystem and a GC tick are not what the property rests on.
	if worst > hold/2 {
		t.Fatalf("the worst-case append (%s) leaves only %s of margin under the %s hold; that margin is what absorbs scheduler and sweep delay",
			worst, hold-worst, hold)
	}
}

// LAYER ONE: the connection read deadline, which is the only thing that can
// interrupt a body read that has stalled outright. A client opens a PATCH,
// promises a body and then sends nothing, forever.
func TestAStalledClientCannotHoldAnAppendOpenForever(t *testing.T) {
	h := newPairHarness(t)
	restore := maxAppendLifetime
	maxAppendLifetime = 300 * time.Millisecond
	t.Cleanup(func() { maxAppendLifetime = restore })

	h.mintCode("909090", "")
	status, uploadID, _ := h.initPairUpload(t, "909090", 4096, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}

	// A body that delivers a prefix and then goes silent without ever closing.
	// Nothing about this connection is cancelled: the client is alive, the socket
	// is open, and it is simply not sending.
	pr, pw := io.Pipe()
	silent := make(chan struct{})
	t.Cleanup(func() { close(silent); pw.Close() })
	go func() {
		_, _ = pw.Write(make([]byte, 512))
		<-silent // and never another byte
	}()

	req, _ := http.NewRequest("PATCH", h.ts.URL+"/api/uploads/"+uploadID, pr)
	req.Header.Set("Content-Range", "bytes 0-4095/4096")
	req.ContentLength = 4096
	req.AddCookie(h.cookie)

	done := make(chan *http.Response, 1)
	errc := make(chan error, 1)
	go func() {
		resp, err := h.ts.Client().Do(req)
		if err != nil {
			errc <- err
			return
		}
		done <- resp
	}()

	select {
	case resp := <-done:
		resp.Body.Close()
	case <-errc:
		// The transport reporting the aborted request is just as good an answer:
		// what is being asserted is that the SERVER let go.
	case <-time.After(20 * time.Second):
		t.Fatal("a client that sends nothing held an append open past its lifetime; nothing in the path was counting")
	}

	// The bytes that did land are not lost by the cut: they are recorded, so the
	// client resumes from them rather than restarting.
	sess := h.session(t, uploadID)
	if sess.Received != 512 {
		t.Fatalf("the session records %d bytes after the cut, want the 512 that landed", sess.Received)
	}
	if got := h.uploadMetered(t); got != 512 {
		t.Fatalf("billed %d, want the 512 bytes that crossed the wire before the cut", got)
	}
}

// CANCELLATION is the other end of the same path, and it must not be treated as
// the bound: a client that hangs up mid-append has still sent the bytes that
// landed, and the accounting for them runs on a detached context precisely so
// its own cancellation cannot take it down. The lifetime shortens an append; it
// never makes one free.
func TestAClientThatHangsUpMidAppendIsStillBilledForWhatLanded(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("949494", "")
	status, uploadID, _ := h.initPairUpload(t, "949494", 4096, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}

	pr, pw := io.Pipe()
	go func() {
		_, _ = pw.Write(make([]byte, 512))
		// Not a graceful close: the request body ends in an error, which is what a
		// dropped connection looks like to the handler.
		_ = pw.CloseWithError(io.ErrUnexpectedEOF)
	}()
	req, _ := http.NewRequest("PATCH", h.ts.URL+"/api/uploads/"+uploadID, pr)
	req.Header.Set("Content-Range", "bytes 0-4095/4096")
	req.ContentLength = 4096
	req.AddCookie(h.cookie)
	if resp, err := h.ts.Client().Do(req); err == nil {
		resp.Body.Close()
	}

	// Give the handler's detached commit a moment to land; it is deliberately not
	// on the request's context, so it outlives the connection.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if h.session(t, uploadID).Received == 512 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := h.session(t, uploadID).Received; got != 512 {
		t.Fatalf("the session records %d bytes after a hangup, want the 512 that landed", got)
	}
	if got := h.uploadMetered(t); got != 512 {
		t.Fatalf("billed %d after a hangup, want 512 — hanging up is not a discount", got)
	}
}

// LAYER TWO: the context on the blob store, which is the only thing that reaches
// a NODE that takes the whole body and then goes quiet. The read deadline cannot
// fire here — central is blocked writing to the node, not reading from the
// client — so without this the append waits as long as the node feels like.
func TestANodeThatNeverAnswersCannotHoldAnAppendOpenForever(t *testing.T) {
	h := newPairHarness(t)
	restore := maxAppendLifetime
	maxAppendLifetime = 300 * time.Millisecond
	t.Cleanup(func() { maxAppendLifetime = restore })

	node := newHeldPatchNode(t)
	node.hold = make(chan struct{})
	node.started = make(chan struct{})
	// Released only at teardown: httptest.Server.Close waits for its handlers, and
	// the point of the test is that CENTRAL gives up while the node never does.
	t.Cleanup(func() { close(node.hold) })
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "919191")

	blob := make([]byte, 4096)
	status := make(chan int, 1)
	started := time.Now()
	go func() { status <- h.patch(t, uploadID, blob, 0, len(blob), len(blob)) }()

	select {
	case <-node.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the append never reached the node")
	}
	select {
	case got := <-status:
		if got != 500 {
			t.Fatalf("an append cut off at its lifetime answered %d, want 500", got)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("a node that never answers held an append open past its lifetime")
	}
	if elapsed := time.Since(started); elapsed > 20*time.Second {
		t.Fatalf("the append took %s to be cut", elapsed)
	}
}

// A CONFORMING client is not cut. The lifetime is a ceiling on pathology, and a
// test that only proved things get cut would be satisfied by a server that cut
// everything.
func TestAnOrdinaryAppendIsNotCutByTheLifetime(t *testing.T) {
	h := newPairHarness(t)
	restore := maxAppendLifetime
	maxAppendLifetime = 5 * time.Second
	t.Cleanup(func() { maxAppendLifetime = restore })

	h.mintCode("929292", "")
	blob := make([]byte, 8192)
	for i := range blob {
		blob[i] = byte(i)
	}
	status, uploadID, _ := h.initPairUpload(t, "929292", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	for start := 0; start < len(blob); start += 2048 {
		if got := h.patch(t, uploadID, blob, start, start+2048, len(blob)); got != 200 {
			t.Fatalf("chunk at %d: %d", start, got)
		}
	}
	if got, _ := h.finalize(t, uploadID); got != 200 {
		t.Fatalf("finalize: %d", got)
	}
	if got := h.uploadMetered(t); got != int64(len(blob)) {
		t.Fatalf("billed %d for an ordinary upload, want %d", got, len(blob))
	}
}

// The bound has to hold from AUTHORISATION, not from the first byte of the body:
// the deadline is set before the session is even read, so time spent resolving
// the session and its room is inside it rather than added to it.
func TestTheLifetimeIsSetBeforeTheSessionIsResolved(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	restore := maxAppendLifetime
	maxAppendLifetime = 200 * time.Millisecond
	t.Cleanup(func() { maxAppendLifetime = restore })

	h.mintCode("939393", "")
	status, uploadID, _ := h.initPairUpload(t, "939393", 4096, "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	// A store that takes longer than the whole lifetime to answer the very first
	// question the handler asks. If the deadline started later, this would be time
	// the append got for free.
	slow := &slowSessionStore{Store: h.store, delay: 2 * maxAppendLifetime}
	h.svc.store = slow
	t.Cleanup(func() { h.svc.store = h.store })

	body := make([]byte, 64)
	done := make(chan int, 1)
	started := time.Now()
	go func() { done <- h.patch(t, uploadID, body, 0, len(body), 4096) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("a slow authorisation is not inside the append's lifetime")
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("the request took %s", elapsed)
	}
	// Nothing was written past the deadline: the session is untouched.
	sess, ok, err := h.store.GetUploadSession(ctx, uploadID, h.userID)
	if err != nil || !ok {
		t.Fatalf("session: ok=%v err=%v", ok, err)
	}
	if sess.Received != 0 {
		t.Fatalf("an append whose authorisation alone outran the lifetime still committed %d bytes", sess.Received)
	}
}

// slowSessionStore delays the session lookup, so a test can spend the whole
// append lifetime before the handler has decided anything at all.
type slowSessionStore struct {
	Store
	delay time.Duration
}

func (s *slowSessionStore) GetUploadSession(ctx context.Context, id, userID string) (UploadSessionRow, bool, error) {
	select {
	case <-time.After(s.delay):
	case <-ctx.Done():
		return UploadSessionRow{}, false, ctx.Err()
	}
	return s.Store.GetUploadSession(ctx, id, userID)
}
