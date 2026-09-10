// Regression tests for shutdown ordering, found by root's independent review of
// a fix of mine that was wrong.
//
// SCOPE: portable transport behaviour only. Proves nothing about Windows
// filesystem semantics.
//
// ## What went wrong, because the shape of the mistake is the lesson
//
// A queued protocol violation was being silently dropped when shutdown won a
// race against it, so Serve reported exit 0 for a session that had failed. I
// fixed that by DRAINING the queue on shutdown — executing the frames that were
// already admitted.
//
// That traded a wrong exit code for a much worse bug. Draining runs real
// filesystem work during teardown, and root's finish-gated review showed a
// queued `publish` starting after a known EOF, after a writer failure, and after
// an explicit cancel. Publication renames staged files to their destinations, so
// that created user-visible files after the host had asked to stop, or after the
// reply channel was already broken and nothing could report what happened. It
// also broke the rule that only a confirmed publish response means a save.
//
// The rules that actually hold:
//
//   - An operation ALREADY inside the sink settles. It holds a handle and may be
//     mid-write; abandoning it would be worse than finishing it.
//   - An operation still QUEUED never starts once shutdown is known.
//   - A queued request is still ANSWERED — refused, not dropped — so the host is
//     not left waiting on a promise nothing will settle.
//   - A protocol violation is judged when the frame is READ, so dropping a
//     queued frame cannot lose the failure.
package serve

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// gateSink holds FinishFile open until released, so a test can arrange for
// shutdown to arrive while an operation is genuinely in flight.
type gateSink struct {
	entered   chan struct{}
	release   chan struct{}
	finished  int
	published int
}

func newGateSink() *gateSink {
	return &gateSink{entered: make(chan struct{}), release: make(chan struct{})}
}

func (g *gateSink) Open(string, *nameguard.Plan) error { return nil }
func (g *gateSink) BeginFile(int) error                { return nil }

func (g *gateSink) WriteChunk(_ int, p []byte) (int, error) { return len(p), nil }

func (g *gateSink) FinishFile(int) error {
	close(g.entered)
	<-g.release
	g.finished++
	return nil
}

func (g *gateSink) PublishOne(int) error {
	g.published++
	return nil
}

func (g *gateSink) Cleanup() (session.Residue, error) { return session.Residue{}, nil }

// The load-bearing test. Shutdown arrives while `finish` is inside the sink and
// a `publish` is already queued behind it.
//
// Repeated because the failure was a coin flip: `select` cannot rank its ready
// cases, so a single iteration passed about half the time even with the defect
// present.
func TestShutdownNeverStartsAQueuedOperation(t *testing.T) {
	const iterations = 64

	for _, reason := range []string{"EOF", "writer failure", "cancel"} {
		t.Run(reason, func(t *testing.T) {
			for i := 0; i < iterations; i++ {
				sink := newGateSink()
				down := newShutdown()
				frames := make(chan reqFrame, 8)
				outbox := make(chan []byte, MaxOutboxDepth)
				exit := make(chan int, 1)
				index := 0

				frames <- reqFrame{kind: wire.KindRequest, req: wire.Request{ID: 1,
					Op: wire.OpOpen, Root: `C:\dest`,
					Manifest: []wire.ManifestEntry{{Name: "a.bin", Size: 0}}}}
				frames <- reqFrame{kind: wire.KindRequest, req: wire.Request{ID: 2,
					Op: wire.OpBegin, Index: &index}}
				frames <- reqFrame{kind: wire.KindRequest, req: wire.Request{ID: 3,
					Op: wire.OpFinish, Index: &index}}

				go func() { exit <- run(Options{Sink: sink}, frames, outbox, down) }()

				select {
				case <-sink.entered:
				case <-time.After(5 * time.Second):
					t.Fatalf("iteration %d: the finish barrier was never entered", i+1)
				}

				// Queued while the loop is held inside the sink.
				frames <- reqFrame{kind: wire.KindRequest, req: wire.Request{ID: 4, Op: wire.OpPublish}}

				switch reason {
				case "cancel":
					down.cancelled.Store(true)
				case "writer failure":
					down.writeFail.Store(true)
				}
				down.signal()
				close(sink.release)

				select {
				case <-exit:
				case <-time.After(5 * time.Second):
					t.Fatalf("iteration %d: the loop never settled", i+1)
				}

				if sink.published != 0 {
					t.Fatalf("iteration %d of %d: a queued publication STARTED after a known %s. "+
						"Publication renames staged files to their destinations, so this created "+
						"user-visible files during teardown", i+1, iterations, reason)
				}
				// The other half of the rule: the in-flight operation was NOT
				// abandoned. Without this, refusing everything would pass.
				if sink.finished != 1 {
					t.Fatalf("iteration %d: the in-flight finish was abandoned (finished=%d); "+
						"an operation already inside the sink must be allowed to settle",
						i+1, sink.finished)
				}
				close(frames)
				if id, code := firstRefusal(t, outbox); id != 4 || code != wire.CodeCancelled {
					t.Fatalf("iteration %d: the queued publish was answered with id=%d code=%q, "+
						"want id=4 E_CANCELLED. A dropped request leaves the host waiting on a "+
						"promise nothing will settle", i+1, id, code)
				}
			}
		})
	}
}

// firstRefusal returns the id and code of the first ok:false response in the
// outbox, or (0, "") if there is none.
func firstRefusal(t *testing.T, outbox chan []byte) (uint64, wire.Code) {
	t.Helper()
	for {
		select {
		case buf := <-outbox:
			r := wire.NewReader(bytes.NewReader(buf))
			frame, err := r.ReadFrame()
			if err != nil || frame.Kind != wire.KindResponse {
				continue
			}
			var resp wire.Response
			if err := json.Unmarshal(frame.Payload, &resp); err != nil {
				continue
			}
			if !resp.OK {
				return resp.ID, resp.Code
			}
		default:
			return 0, ""
		}
	}
}
