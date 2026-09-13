// Regression tests for the uncertain-write contract, found by root's independent
// state-machine review.
//
// SCOPE — the same limit the rest of this package carries: these run against an
// in-memory sink and prove ordering and accounting only. They prove NOTHING
// about Windows filesystem semantics.
//
// ## The defect these exist to prevent
//
// Session.WriteChunk used to discard the count a failing sink returned and leave
// the session in stateWriting. A sink that took two bytes and then failed was
// reported as having taken none, so a host that resent the same four bytes
// appended them to the two already staged. `written` counted four, the manifest
// declared four, FinishFile's exact-length check passed, and a six-byte file
// published as complete. The receipt said so in as many words.
//
// The exact-length check cannot catch this on its own: it compares the manifest
// against what this process counted, and both numbers were right. What was wrong
// was the file. So the fix is not a better count, it is refusing to write to an
// object whose length is no longer known.
package session

import (
	"errors"
	"testing"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// countingSink records exactly what reached "disk" so a test can compare the
// staged length against the length the receipt claims. Each hook fails once.
type countingSink struct {
	disk map[int][]byte

	// takeThenFail makes the next WriteChunk accept this many bytes and then
	// report an error, the shape a disk filling up mid-write would produce.
	takeThenFail int
	failWrite    bool
	// writeCount overrides the returned count with a value the sink was never
	// offered, standing in for a sink that misreports its own behaviour.
	writeCount *int

	failBegin  bool
	failFinish bool
	failOpen   bool

	published []int
}

func newCountingSink() *countingSink { return &countingSink{disk: map[int][]byte{}} }

func (c *countingSink) Open(string, *nameguard.Plan) error {
	if c.failOpen {
		return errors.New("root unavailable")
	}
	return nil
}

func (c *countingSink) BeginFile(index int) error {
	if c.failBegin {
		return errors.New("staged create failed")
	}
	c.disk[index] = nil
	return nil
}

func (c *countingSink) WriteChunk(index int, p []byte) (int, error) {
	if c.writeCount != nil {
		return *c.writeCount, nil
	}
	if c.failWrite {
		c.failWrite = false
		take := c.takeThenFail
		if take > len(p) {
			take = len(p)
		}
		c.disk[index] = append(c.disk[index], p[:take]...)
		return take, errors.New("partial disk error")
	}
	c.disk[index] = append(c.disk[index], p...)
	return len(p), nil
}

func (c *countingSink) FinishFile(int) error {
	if c.failFinish {
		return errors.New("flush failed")
	}
	return nil
}

func (c *countingSink) PublishOne(index int) error {
	c.published = append(c.published, index)
	return nil
}

func (c *countingSink) Cleanup() (Residue, error) { return Residue{}, nil }

// Root's exact scenario, asserted on the mechanism rather than only the outcome.
//
// The outcome assertion — "a six-byte file must not publish as a complete
// four-byte file" — is the one that matters, but on its own it would also pass
// if publication failed for some unrelated reason. So each step is checked: the
// retry must be REFUSED, the file must never finish, and publish must never run.
func TestFailedWriteCannotBeRetriedIntoAWrongLengthFile(t *testing.T) {
	sink := newCountingSink()
	sink.failWrite = true
	sink.takeThenFail = 2

	s := openSession(t, sink, manifest(wire.ManifestEntry{Name: "a", Size: 4}))
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}

	if _, err := s.WriteChunk(0, []byte("abcd")); err == nil {
		t.Fatal("a failing sink write was reported as success")
	}
	if got := len(sink.disk[0]); got != 2 {
		t.Fatalf("sink staged %d bytes, want the 2 it said it took", got)
	}

	// The retry is where the corruption used to happen.
	if _, err := s.WriteChunk(0, []byte("abcd")); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("retry after a failed write returned %v, want E_SEQUENCE", err)
	}
	if got := len(sink.disk[0]); got != 2 {
		t.Fatalf("the retry appended to a file of unknown length: %d bytes staged", got)
	}
	if _, err := s.FinishFile(0); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("finish after a failed write returned %v, want E_SEQUENCE", err)
	}
	if _, err := s.Publish(); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("publish after a failed write returned %v, want E_SEQUENCE", err)
	}
	if len(sink.published) != 0 {
		t.Fatalf("published %v after a write whose result was unknown", sink.published)
	}
}

// The count a failing sink reports is kept, because it is the only evidence of
// how far the staged file advanced. It is safe to keep ONLY because the session
// is terminal; this test pins the accounting, the test above pins the safety.
func TestBytesTakenByAFailedWriteAreAccounted(t *testing.T) {
	sink := newCountingSink()
	sink.failWrite = true
	sink.takeThenFail = 2

	s := openSession(t, sink, manifest(wire.ManifestEntry{Name: "a", Size: 4}))
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteChunk(0, []byte("abcd")); err == nil {
		t.Fatal("expected the write to fail")
	}
	if s.written != 2 {
		t.Fatalf("accounted %d bytes for a write the sink said took 2", s.written)
	}
	if len(sink.disk[0]) != int(s.written) {
		t.Fatalf("accounting says %d bytes, sink holds %d", s.written, len(sink.disk[0]))
	}
}

// A count outside the range that was offered is a broken sink, not a short
// write. Trusting it would advance the counter past bytes that were never
// offered, let alone written.
func TestImpossibleWriteCountIsRefusedAndTerminal(t *testing.T) {
	for name, count := range map[string]int{"negative": -1, "more than offered": 9} {
		t.Run(name, func(t *testing.T) {
			sink := newCountingSink()
			n := count
			sink.writeCount = &n

			s := openSession(t, sink, manifest(wire.ManifestEntry{Name: "a", Size: 4}))
			if err := s.BeginFile(0); err != nil {
				t.Fatal(err)
			}
			_, err := s.WriteChunk(0, []byte("abcd"))
			if wire.CodeOf(err) != wire.CodeShortWrite {
				t.Fatalf("write count %d returned %v, want E_SHORT_WRITE", count, err)
			}
			if _, err := s.WriteChunk(0, []byte("abcd")); wire.CodeOf(err) != wire.CodeSequence {
				t.Fatalf("session still accepted writes after an impossible count: %v", err)
			}
		})
	}
}

// Every failure the SINK reports is terminal, because each one leaves an object
// whose state this process cannot establish. A rejection decided before the sink
// is called is not terminal, and that distinction is asserted here too so the
// rule is pinned from both sides.
func TestSinkFailuresAreTerminalAndProtocolRejectionsAreNot(t *testing.T) {
	t.Run("open", func(t *testing.T) {
		sink := newCountingSink()
		sink.failOpen = true
		s := New(sink)
		if _, err := s.Open(`C:\dest`, manifest(wire.ManifestEntry{Name: "a", Size: 1})); err == nil {
			t.Fatal("expected the sink open to fail")
		}
		sink.failOpen = false
		if _, err := s.Open(`C:\dest`, manifest(wire.ManifestEntry{Name: "a", Size: 1})); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("a second lease was accepted after a failed open: %v", err)
		}
	})

	t.Run("begin", func(t *testing.T) {
		sink := newCountingSink()
		sink.failBegin = true
		s := openSession(t, sink, manifest(wire.ManifestEntry{Name: "a", Size: 1}))
		if err := s.BeginFile(0); err == nil {
			t.Fatal("expected the sink begin to fail")
		}
		sink.failBegin = false
		if err := s.BeginFile(0); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("begin was retried after a failed staged create: %v", err)
		}
	})

	t.Run("finish", func(t *testing.T) {
		sink := newCountingSink()
		sink.failFinish = true
		s := openSession(t, sink, manifest(wire.ManifestEntry{Name: "a", Size: 4}))
		if err := s.BeginFile(0); err != nil {
			t.Fatal(err)
		}
		if _, err := s.WriteChunk(0, []byte("abcd")); err != nil {
			t.Fatal(err)
		}
		if _, err := s.FinishFile(0); err == nil {
			t.Fatal("expected the flush to fail")
		}
		sink.failFinish = false
		if _, err := s.FinishFile(0); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("the flush was retried after it failed: %v", err)
		}
		if _, err := s.Publish(); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("published a file whose flush failed: %v", err)
		}
	})

	// The contrast case: a manifest is refused before the sink is touched, so
	// nothing on disk is in doubt and a corrected manifest is still accepted.
	t.Run("manifest rejection stays recoverable", func(t *testing.T) {
		sink := newCountingSink()
		s := New(sink)
		if _, err := s.Open(`C:\dest`, manifest(wire.ManifestEntry{Name: `a\..\..\b`, Size: 1})); wire.CodeOf(err) != wire.CodeManifest {
			t.Fatalf("want E_MANIFEST, got %v", err)
		}
		if _, err := s.Open(`C:\dest`, manifest(wire.ManifestEntry{Name: "a", Size: 1})); err != nil {
			t.Fatalf("a corrected manifest was refused after a pre-sink rejection: %v", err)
		}
	})
}

// A sink that accepts nothing without reporting an error is broken in the same
// way, and the session must not keep offering it bytes.
func TestZeroAcceptIsTerminal(t *testing.T) {
	s := New(zeroAcceptSink{})
	if _, err := s.Open(`C:\d`, manifest(wire.ManifestEntry{Name: "a", Size: 5})); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteChunk(0, []byte("abcde")); wire.CodeOf(err) != wire.CodeShortWrite {
		t.Fatalf("want E_SHORT_WRITE, got %v", err)
	}
	if _, err := s.WriteChunk(0, []byte("abcde")); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("session kept writing to a sink that accepts nothing: %v", err)
	}
}
