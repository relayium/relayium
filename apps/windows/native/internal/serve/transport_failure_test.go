// Regression tests for two confirmed defects found by root's independent review.
//
// SCOPE: portable transport behaviour only. Proves nothing about Windows
// filesystem semantics.
package serve

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// quietSink does nothing and never fails, so an exit code reflects the transport
// and nothing else.
type quietSink struct{ cleanups int }

func (s *quietSink) Open(string, *nameguard.Plan) error      { return nil }
func (s *quietSink) BeginFile(int) error                     { return nil }
func (s *quietSink) WriteChunk(_ int, p []byte) (int, error) { return len(p), nil }
func (s *quietSink) FinishFile(int) error                    { return nil }
func (s *quietSink) PublishOne(int) error                    { return nil }
func (s *quietSink) Cleanup() (session.Residue, error)       { s.cleanups++; return session.Residue{}, nil }

// A broken stream must never report a clean exit.
//
// The defect: the reader logged a malformed or truncated frame and then took the
// same path as a clean EOF, storing nothing. Every case below returned exit 0 —
// the helper told its parent the session finished normally while the transport
// had actually failed, and a parent trusting the exit code would have believed a
// transfer completed.
//
// The three byte sequences are the ones root's independent baseline used.
func TestBrokenStreamNeverReportsCleanExit(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
	}{
		// length 0xFFFFFFFF: past the frame ceiling, rejected from the header.
		{"oversized length prefix", []byte{0xff, 0xff, 0xff, 0xff, 0x01}},
		// two bytes: the header itself is cut.
		{"truncated length prefix", []byte{0x00, 0x00}},
		// length 8 promises a 7-byte payload; only one byte follows.
		{"truncated payload", []byte{0x00, 0x00, 0x00, 0x08, 0x01, 0x7b}},
		// length 0 is below the minimum: the kind byte is always counted.
		{"zero length", []byte{0x00, 0x00, 0x00, 0x00, 0x01}},
		// kind 99 is not a frame kind this protocol defines.
		{"unknown frame kind", []byte{0x00, 0x00, 0x00, 0x02, 0x63, 0x00}},
		// a response frame is helper-to-host only; receiving one is not our peer.
		{"peer sent a response frame", func() []byte {
			f, _ := wire.EncodeFrame(wire.KindResponse, []byte(`{"id":1,"ok":true}`))
			return f
		}()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sink := &quietSink{}
			code := Serve(Options{In: bytes.NewReader(c.raw), Out: io.Discard, Sink: sink,
				Grace: time.Second, DrainGrace: 100 * time.Millisecond, ForceExit: func(int) {}})
			if code == ExitClean {
				t.Fatalf("a broken stream reported ExitClean; the parent would believe the session finished normally")
			}
			if code != ExitProtocol {
				t.Fatalf("exit %d, want ExitProtocol", code)
			}
			if sink.cleanups == 0 {
				t.Fatal("a broken stream skipped cleanup")
			}
		})
	}
}

// The other half of the same rule: over-correcting must not turn an ordinary
// goodbye into a failure. A stream that ends at a frame boundary is the parent
// finishing with us.
func TestCleanEOFStaysClean(t *testing.T) {
	for _, c := range []struct {
		name string
		in   []byte
	}{
		{"empty stream", nil},
		{"after a complete request", func() []byte {
			var buf bytes.Buffer
			raw := []byte(`{"id":1,"op":"open","root":"C:\\d","manifest":[]}`)
			f, _ := wire.EncodeFrame(wire.KindRequest, raw)
			buf.Write(f)
			return buf.Bytes()
		}()},
	} {
		t.Run(c.name, func(t *testing.T) {
			code := Serve(Options{In: bytes.NewReader(c.in), Out: io.Discard, Sink: &quietSink{},
				Grace: time.Second, DrainGrace: 100 * time.Millisecond, ForceExit: func(int) {}})
			if code != ExitClean {
				t.Fatalf("clean EOF reported exit %d; ending at a frame boundary is not a failure", code)
			}
		})
	}
}

// lateFailWriter succeeds for `allowed` writes and then blocks forever, so the
// failure lands during the FINAL drain rather than while run() is still going.
type lateFailWriter struct {
	mu      sync.Mutex
	allowed int
}

func (w *lateFailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	remaining := w.allowed
	if remaining > 0 {
		w.allowed--
	}
	w.mu.Unlock()
	if remaining <= 0 {
		select {} // a full pipe whose reader has stopped
	}
	return len(p), nil
}

// A reply that never reached the host must not be reported as a clean exit.
//
// The defect: run() computed the exit code before the outbox was flushed, so a
// write that failed or never completed during the final drain was invisible to
// it and Serve returned a stale zero. The host's rule is that only a confirmed
// publish response means a successful save; a stale zero here would have
// undermined the corroborating signal.
func TestUndeliveredFinalReplyIsNotACleanExit(t *testing.T) {
	var in bytes.Buffer
	raw := []byte(`{"id":1,"op":"open","root":"C:\\d","manifest":[]}`)
	frame, err := wire.EncodeFrame(wire.KindRequest, raw)
	if err != nil {
		t.Fatal(err)
	}
	in.Write(frame)
	// Stream then ends cleanly: run() alone would compute ExitClean.

	// One write allowed: the ready event goes out, the open reply is still
	// sitting in the outbox when run() returns.
	out := &lateFailWriter{allowed: 1}

	done := make(chan int, 1)
	go func() {
		done <- Serve(Options{In: &in, Out: out, Sink: &quietSink{},
			Grace: time.Second, DrainGrace: 150 * time.Millisecond, ForceExit: func(int) {}})
	}()

	select {
	case code := <-done:
		if code == ExitClean {
			t.Fatal("an undelivered final reply reported ExitClean")
		}
		if code != ExitProtocol {
			t.Fatalf("exit %d, want ExitProtocol", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return; the final drain is unbounded again")
	}
}

// Residue is more specific than an undelivered reply and must survive the
// reconcile: it names bytes left on the user's disk.
func TestResidueCodeSurvivesTheDrainReconcile(t *testing.T) {
	code := Serve(Options{In: bytes.NewReader(nil), Out: io.Discard, Sink: residueSink{},
		Grace: time.Second, DrainGrace: 100 * time.Millisecond, ForceExit: func(int) {}})
	if code != ExitCleanupIncomplete {
		t.Fatalf("exit %d, want ExitCleanupIncomplete", code)
	}
}

type residueSink struct{}

func (residueSink) Open(string, *nameguard.Plan) error  { return nil }
func (residueSink) BeginFile(int) error                 { return nil }
func (residueSink) WriteChunk(int, []byte) (int, error) { return 0, nil }
func (residueSink) FinishFile(int) error                { return nil }
func (residueSink) PublishOne(int) error                { return nil }
func (residueSink) Cleanup() (session.Residue, error) {
	return session.Residue{Left: true}, nil
}

// Cancel is handled out of band, which made it the one operation that could slip
// past the boundary: it was recognised with a bare json.Unmarshal, so an
// oversized, unknown-field or zero-id cancel was accepted where every other
// operation would have been refused. It now goes through the same strict bounded
// validator, and out-of-band cancellation is preserved.
func TestCancelIsHeldToTheSameBoundaryAsEveryOtherRequest(t *testing.T) {
	oversized := `{"id":1,"op":"cancel","root":"` + strings.Repeat("p", wire.MaxRequestBytes) + `"}`
	cases := map[string]string{
		"oversized cancel":     oversized,
		"unknown field cancel": `{"id":1,"op":"cancel","surprise":"x"}`,
		"zero id cancel":       `{"id":0,"op":"cancel"}`,
		"malformed cancel":     `{"id":1,"op":"cancel"`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			frame, err := wire.EncodeFrame(wire.KindRequest, []byte(payload))
			if err != nil {
				t.Fatal(err)
			}
			sink := &quietSink{}
			code := Serve(Options{In: bytes.NewReader(frame), Out: io.Discard, Sink: sink,
				Grace: time.Second, DrainGrace: 100 * time.Millisecond, ForceExit: func(int) {}})
			if code != ExitProtocol {
				t.Fatalf("exit %d, want ExitProtocol; an invalid cancel was accepted", code)
			}
			if sink.cleanups == 0 {
				t.Fatal("an invalid cancel skipped cleanup")
			}
		})
	}
}

// A well-formed cancel still works out of band, so the fix above did not turn
// cancellation into an error path.
func TestWellFormedCancelStillSettlesCleanly(t *testing.T) {
	frame, err := wire.EncodeFrame(wire.KindRequest, []byte(`{"id":77,"op":"cancel"}`))
	if err != nil {
		t.Fatal(err)
	}
	out := &syncBuffer{}
	sink := &quietSink{}
	code := Serve(Options{In: bytes.NewReader(frame), Out: out, Sink: sink,
		Grace: time.Second, DrainGrace: time.Second, ForceExit: func(int) {}})
	if code != ExitClean {
		t.Fatalf("exit %d, want clean", code)
	}
	if resp := findResponse(t, out.bytes(), 77); resp == nil || !resp.OK {
		t.Fatalf("well-formed cancel did not get a successful correlated reply: %+v", resp)
	}
	if sink.cleanups == 0 {
		t.Fatal("cancel did not run cleanup")
	}
}

// A protocol violation must be reported even when shutdown races it.
//
// ## The two rules this sits between
//
// Shutdown must not execute a queued operation, and a malformed frame must
// produce a non-zero exit. Those conflict if the only way to notice a violation
// is to dispatch it — which is why wire.DecodeRequest judges every request when
// it is READ. This test pins the result: the violation is reported whether or
// not the main loop ever reaches the frame.
//
// An earlier attempt satisfied it by DRAINING the queue at shutdown. Root's
// independent review rejected that: it executed real filesystem work during
// teardown, and a queued publication started after a known EOF, after a writer
// failure, and after an explicit cancel. The invariant below is unchanged; only
// the mechanism that upholds it moved, from the dispatcher to the reader.
//
// ## Why this test repeats itself
//
// The failure mode was a coin flip, not a hang: `select` chooses uniformly at
// random among ready cases, so a single-iteration test passes half the time —
// worse than no test, because it would have been recorded as evidence. Each case
// runs many times and every iteration must report ExitProtocol.
//
// ## Why every case is prefixed with a valid `open`
//
// The race needs BOTH select cases ready at the same moment. Sent on its own, a
// violation frame is usually handed straight to a loop already parked in the
// select, with the EOF signal arriving afterwards — no coin flip, so the test
// passes even when the defect is present. An earlier version did exactly that
// and two of its three cases passed against a deliberately reverted fix. The
// leading `open` occupies the loop while the reader admits the violation and
// signals EOF.
func TestProtocolViolationIsReportedEvenWhenShutdownRacesIt(t *testing.T) {
	const repeats = 200

	openFrame := requestFrame(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: `C:\dest`,
		Manifest: []wire.ManifestEntry{{Name: "a.bin", Size: 4}}})

	cases := map[string][]byte{
		// Helper-to-host only. The host may not send it at all.
		"a response frame": func() []byte {
			f, err := wire.EncodeFrame(wire.KindResponse, []byte(`{"id":2,"ok":true}`))
			if err != nil {
				t.Fatal(err)
			}
			return f
		}(),
		// Parses as a request and fails on its op, so unlike the frame kind
		// above it can only be caught by judging the op at read time.
		"an unknown op": requestFrame(t, wire.Request{ID: 2, Op: "nonsense"}),
		// A chunk carrying an unanswerable correlation id. ReadFrame validates
		// chunk LENGTH but not the id, so this one reached the queue; the
		// shutdown refusal path then answers on the id, found zero, and dropped
		// the frame with no reply and no protocol failure recorded. Root found
		// this gap after the request-shape correction.
		"a zero-id chunk": func() []byte {
			f, err := wire.EncodeChunk(wire.ChunkHeader{ID: 0, Index: 0}, []byte("data"))
			if err != nil {
				t.Fatal(err)
			}
			return f
		}(),
	}
	// A short chunk frame is deliberately absent. The reader already enforces
	// payloadLen >= ChunkHeaderBytes, and DecodeChunk fails on exactly that same
	// condition, so dispatch's chunk-decode failure is unreachable defensive
	// code rather than a path a host can drive. Including it as a case looked
	// like coverage but tested the reader's length check twice — it passed
	// against a reverted drain, which is how it was caught.

	for name, violation := range cases {
		t.Run(name, func(t *testing.T) {
			var stream bytes.Buffer
			stream.Write(openFrame)
			stream.Write(violation)
			raw := stream.Bytes()

			for i := 0; i < repeats; i++ {
				sink := &quietSink{}
				code := Serve(Options{In: bytes.NewReader(raw), Out: io.Discard,
					Sink: sink, Grace: time.Second, DrainGrace: 100 * time.Millisecond,
					ForceExit: func(int) {}})
				if code != ExitProtocol {
					t.Fatalf("iteration %d of %d: exit %d, want ExitProtocol. "+
						"Shutdown raced the admitted frame and the violation went unreported",
						i+1, repeats, code)
				}
				if sink.cleanups == 0 {
					t.Fatalf("iteration %d: cleanup was skipped", i+1)
				}
			}
		})
	}
}

// requestFrame encodes one request as a frame, failing the test rather than
// returning an error nobody would check.
func requestFrame(t *testing.T, req wire.Request) []byte {
	t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := wire.EncodeFrame(wire.KindRequest, raw)
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

// A cancel must not execute frames the host already sent. See also
// TestShutdownNeverStartsAQueuedOperation, which drives the same rule against a
// real Session with an operation held open mid-flight.
func TestCancelStillPreemptsQueuedFrames(t *testing.T) {
	var in bytes.Buffer
	in.Write(requestFrame(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: `C:\dest`,
		Manifest: []wire.ManifestEntry{{Name: "a.bin", Size: 4}}}))
	in.Write(requestFrame(t, wire.Request{ID: 2, Op: wire.OpCancel}))
	// An unknown op queued BEHIND the cancel. The reader stops at the cancel, so
	// this frame is never admitted and its violation is never reported: the exit
	// stays clean. That is the intended asymmetry with the test above.
	in.Write(requestFrame(t, wire.Request{ID: 3, Op: "nonsense"}))

	sink := &quietSink{}
	code := Serve(Options{In: &in, Out: io.Discard, Sink: sink,
		Grace: time.Second, DrainGrace: 100 * time.Millisecond, ForceExit: func(int) {}})
	if code != ExitClean {
		t.Fatalf("a cancel settled with exit %d; frames queued behind a cancel must not be executed or reported", code)
	}
	if sink.cleanups == 0 {
		t.Fatal("cancel did not run cleanup")
	}
}

// Diagnostics must never echo host-supplied text. The op is arbitrary: it can be
// enormous and it can be made to look like a path, and stderr is a crash
// surface that ships.
//
// ## Why the payload is built with json.Marshal
//
// An earlier version of this test embedded the marker RAW into a JSON string
// literal. `\U`, `\v`, `\D` and `\S` are not valid JSON escapes, so
// DecodeRequest rejected the payload at the UTF-8/JSON gate and never reached
// the size-limit branch this test is named after. It passed while proving
// nothing, and restoring the echo it forbids did not fail it. Deriving the
// escaping from json.Marshal means the op field decodes to exactly `marker`
// rather than to whatever a hand-written literal happens to mean.
//
// ## Why each case asserts a POSITIVE log line
//
// A "must not contain" assertion is satisfied by a log that was never written,
// so absence alone cannot distinguish "the branch ran and stayed quiet" from
// "the branch never ran". wantLog pins the specific diagnostic each case is
// supposed to provoke, which is what makes the negative assertions load-bearing.
func TestDiagnosticsNeverEchoHostSuppliedText(t *testing.T) {
	const marker = `C:\Users\victim\Documents\SECRET-MARKER-4f21.txt`
	op, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string]struct {
		payload string
		// wantLog is the diagnostic proving the intended branch was reached.
		wantLog string
	}{
		"unknown op containing a path": {
			payload: `{"id":1,"op":` + string(op) + `}`,
			// wire.DecodeRequest refuses an undefined op at read time, so this is
			// the reader's diagnostic rather than the dispatcher's. That move is
			// deliberate — it is what lets the main loop drop a queued frame
			// during shutdown without losing the protocol failure — and the
			// privacy requirement is identical either way.
			wantLog: "does not define",
		},
		"oversized unknown op": {
			// Over MaxRequestBytes but under MaxOpenRequestBytes, so the blanket
			// length gate does not fire and the op-specific limit chosen from the
			// probe does — the branch that used to interpolate probe.Op.
			payload: `{"id":1,"op":` + string(op[:len(op)-1]) + strings.Repeat("x", wire.MaxRequestBytes) + `"}`,
			// The bound is MaxRequestBytes, not MaxOpenRequestBytes: that number
			// is what distinguishes the op-specific limit from the blanket one.
			wantLog: fmt.Sprintf("exceeds %d", wire.MaxRequestBytes),
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if len(tc.payload) > wire.MaxOpenRequestBytes {
				t.Fatalf("payload of %d bytes would trip the blanket gate instead", len(tc.payload))
			}
			frame, err := wire.EncodeFrame(wire.KindRequest, []byte(tc.payload))
			if err != nil {
				t.Fatal(err)
			}
			var log bytes.Buffer
			code := Serve(Options{In: bytes.NewReader(frame), Out: io.Discard, Log: &log,
				Sink: &quietSink{}, Grace: time.Second, DrainGrace: 100 * time.Millisecond,
				ForceExit: func(int) {}})
			if code != ExitProtocol {
				t.Fatalf("exit %d, want ExitProtocol", code)
			}
			if !strings.Contains(log.String(), tc.wantLog) {
				t.Fatalf("never reached the branch under test: want %q in %q", tc.wantLog, log.String())
			}
			if strings.Contains(log.String(), "SECRET-MARKER") {
				t.Fatalf("stderr echoed host-supplied text: %q", log.String())
			}
			if strings.Contains(log.String(), `C:\`) {
				t.Fatalf("stderr echoed a path-like literal: %q", log.String())
			}
		})
	}
}
