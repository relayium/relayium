// Portable state-machine tests.
//
// SCOPE — read this before citing a green run as evidence: these exercise the
// session against an IN-MEMORY sink. They prove ordering, length accounting and
// the shape of the publish receipt. They prove NOTHING about no-replace
// publication, reparse refusal, handle pinning, ancestor-swap resistance or
// cleanup, all of which live in internal/winio and are provable only on a real
// Windows host. A green result here is not Windows evidence.
package session

import (
	"testing"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

type memSink struct {
	plan      *nameguard.Plan
	data      map[int][]byte
	open      int
	published []int
	// failPublishAt makes PublishOne fail for one index, standing in for the
	// destination already existing.
	failPublishAt int
	cleanups      int
	// shortWriteBytes caps how much each WriteChunk accepts, so the caller's
	// loop over partial writes is exercised.
	shortWriteBytes int
}

func newMemSink() *memSink {
	return &memSink{data: map[int][]byte{}, open: -1, failPublishAt: -1}
}

func (m *memSink) Open(_ string, plan *nameguard.Plan) error { m.plan = plan; return nil }

func (m *memSink) BeginFile(index int) error {
	m.open = index
	m.data[index] = nil
	return nil
}

func (m *memSink) WriteChunk(index int, p []byte) (int, error) {
	n := len(p)
	if m.shortWriteBytes > 0 && n > m.shortWriteBytes {
		n = m.shortWriteBytes
	}
	m.data[index] = append(m.data[index], p[:n]...)
	return n, nil
}

func (m *memSink) FinishFile(int) error { m.open = -1; return nil }

func (m *memSink) PublishOne(index int) error {
	if index == m.failPublishAt {
		return wire.Errf(wire.CodeExists, "")
	}
	m.published = append(m.published, index)
	return nil
}

func (m *memSink) Cleanup() (Residue, error) { m.cleanups++; return Residue{}, nil }

func manifest(entries ...wire.ManifestEntry) []wire.ManifestEntry { return entries }

func openSession(t *testing.T, sink Sink, entries []wire.ManifestEntry) *Session {
	t.Helper()
	s := New(sink)
	if _, err := s.Open(`C:\dest`, entries); err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestHappyPathSequence(t *testing.T) {
	sink := newMemSink()
	s := openSession(t, sink, manifest(
		wire.ManifestEntry{Name: "a/b.bin", Size: 4},
		wire.ManifestEntry{Name: "empty.bin", Size: 0},
	))
	if err := s.BeginFile(0); err != nil {
		t.Fatalf("begin 0: %v", err)
	}
	if _, err := s.WriteChunk(0, []byte("data")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := s.FinishFile(0); err != nil {
		t.Fatalf("finish 0: %v", err)
	}
	// A zero-byte file is begun and finished with no chunk at all.
	if err := s.BeginFile(1); err != nil {
		t.Fatalf("begin 1: %v", err)
	}
	if _, err := s.FinishFile(1); err != nil {
		t.Fatalf("finish 1: %v", err)
	}
	result, err := s.Publish()
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if result.Status != "complete" || result.PublishedCount != 2 || result.Failed != nil {
		t.Fatalf("unexpected receipt: %+v", result)
	}
}

func TestOpenIsAcceptedOnlyOnce(t *testing.T) {
	s := openSession(t, newMemSink(), manifest(wire.ManifestEntry{Name: "a", Size: 1}))
	if _, err := s.Open(`C:\other`, manifest(wire.ManifestEntry{Name: "b", Size: 1})); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("second open: want E_SEQUENCE, got %v", err)
	}
}

func TestOrderingRefusals(t *testing.T) {
	entries := manifest(
		wire.ManifestEntry{Name: "a", Size: 2},
		wire.ManifestEntry{Name: "b", Size: 2},
	)
	t.Run("out of order begin", func(t *testing.T) {
		s := openSession(t, newMemSink(), entries)
		if err := s.BeginFile(1); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("want E_SEQUENCE, got %v", err)
		}
	})
	t.Run("duplicate begin", func(t *testing.T) {
		s := openSession(t, newMemSink(), entries)
		if err := s.BeginFile(0); err != nil {
			t.Fatal(err)
		}
		if err := s.BeginFile(0); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("want E_SEQUENCE, got %v", err)
		}
	})
	t.Run("chunk with no open file", func(t *testing.T) {
		s := openSession(t, newMemSink(), entries)
		if _, err := s.WriteChunk(0, []byte("x")); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("want E_SEQUENCE, got %v", err)
		}
	})
	t.Run("chunk for a different file", func(t *testing.T) {
		s := openSession(t, newMemSink(), entries)
		if err := s.BeginFile(0); err != nil {
			t.Fatal(err)
		}
		if _, err := s.WriteChunk(1, []byte("x")); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("want E_SEQUENCE, got %v", err)
		}
	})
	t.Run("publish before complete", func(t *testing.T) {
		s := openSession(t, newMemSink(), entries)
		if _, err := s.Publish(); wire.CodeOf(err) != wire.CodeSequence {
			t.Fatalf("want E_SEQUENCE, got %v", err)
		}
	})
}

// Exceeding the declared length must be refused at the boundary, not discovered
// afterwards: the length check is the only thing distinguishing a complete file
// from a corrupt one.
func TestLengthOverrunRefused(t *testing.T) {
	s := openSession(t, newMemSink(), manifest(wire.ManifestEntry{Name: "a", Size: 3}))
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteChunk(0, []byte("toolong")); wire.CodeOf(err) != wire.CodeLengthExceeded {
		t.Fatalf("want E_LENGTH_EXCEEDED, got %v", err)
	}
}

func TestShortFileIsNeverFinished(t *testing.T) {
	s := openSession(t, newMemSink(), manifest(wire.ManifestEntry{Name: "a", Size: 8}))
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WriteChunk(0, []byte("half")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishFile(0); wire.CodeOf(err) != wire.CodeLengthShort {
		t.Fatalf("want E_LENGTH_SHORT, got %v", err)
	}
	// Terminal: a session that disagreed with the sender about the transfer must
	// not go on to publish anything.
	if _, err := s.Publish(); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("publish after a short file: want E_SEQUENCE, got %v", err)
	}
}

// A sink that accepts fewer bytes than offered must be looped over, and the
// counter must follow what the sink actually took.
func TestPartialSinkWritesAreLooped(t *testing.T) {
	sink := newMemSink()
	sink.shortWriteBytes = 1
	s := openSession(t, sink, manifest(wire.ManifestEntry{Name: "a", Size: 5}))
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	result, err := s.WriteChunk(0, []byte("abcde"))
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if result.Written != 5 {
		t.Fatalf("accounted %d bytes, want 5", result.Written)
	}
	if string(sink.data[0]) != "abcde" {
		t.Fatalf("sink received %q", sink.data[0])
	}
	if _, err := s.FinishFile(0); err != nil {
		t.Fatalf("finish: %v", err)
	}
}

// A sink that accepts nothing must be reported, never retried: looping would
// spin forever, and trusting the requested length instead would advance the
// counter past bytes that are not on disk, letting a short file satisfy the
// exact-length check.
func TestZeroByteSinkWriteIsReported(t *testing.T) {
	s := New(zeroAcceptSink{})
	if _, err := s.Open(`C:\d`, manifest(wire.ManifestEntry{Name: "a", Size: 5})); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.WriteChunk(0, []byte("abcde"))
		done <- err
	}()
	select {
	case err := <-done:
		if wire.CodeOf(err) != wire.CodeShortWrite {
			t.Fatalf("want E_SHORT_WRITE, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a sink accepting zero bytes made the write loop spin forever")
	}
}

// zeroAcceptSink always reports that it took nothing.
type zeroAcceptSink struct{}

func (zeroAcceptSink) Open(string, *nameguard.Plan) error  { return nil }
func (zeroAcceptSink) BeginFile(int) error                 { return nil }
func (zeroAcceptSink) WriteChunk(int, []byte) (int, error) { return 0, nil }
func (zeroAcceptSink) FinishFile(int) error                { return nil }
func (zeroAcceptSink) PublishOne(int) error                { return nil }
func (zeroAcceptSink) Cleanup() (Residue, error)           { return Residue{}, nil }

// The receipt must be O(1) in the manifest size and must never let a partial
// batch read as a full one.
func TestPartialPublishReceiptIsTruthfulAndBounded(t *testing.T) {
	sink := newMemSink()
	sink.failPublishAt = 2
	entries := manifest(
		wire.ManifestEntry{Name: "a", Size: 0},
		wire.ManifestEntry{Name: "b", Size: 0},
		wire.ManifestEntry{Name: "c", Size: 0},
		wire.ManifestEntry{Name: "d", Size: 0},
	)
	s := openSession(t, sink, entries)
	for i := range entries {
		if err := s.BeginFile(i); err != nil {
			t.Fatal(err)
		}
		if _, err := s.FinishFile(i); err != nil {
			t.Fatal(err)
		}
	}
	result, err := s.Publish()
	if err == nil {
		t.Fatal("a failed batch reported success")
	}
	if wire.CodeOf(err) != wire.CodePartialPublication {
		t.Fatalf("want E_PARTIAL_PUBLICATION, got %v", err)
	}
	if result.Status != "partial" {
		t.Fatalf("status %q, want partial", result.Status)
	}
	if result.PublishedCount != 2 {
		t.Fatalf("published %d, want 2", result.PublishedCount)
	}
	if result.Failed == nil || result.Failed.Index != 2 || result.Failed.Code != wire.CodeExists {
		t.Fatalf("failure not reported truthfully: %+v", result.Failed)
	}
	if result.Unattempted == nil || result.Unattempted.From != 3 || result.Unattempted.To != 3 {
		t.Fatalf("unattempted range wrong: %+v", result.Unattempted)
	}
	// Completed outputs are kept, not rolled back.
	if len(sink.published) != 2 {
		t.Fatalf("published %v, want the first two kept", sink.published)
	}
}

// The receipt for a 1000-file manifest must fit the enforced response bound,
// which is the whole reason publication is reported as a prefix count.
func TestReceiptFitsResponseBoundAtMaxFiles(t *testing.T) {
	entries := make([]wire.ManifestEntry, nameguard.MaxFiles)
	for i := range entries {
		entries[i] = wire.ManifestEntry{Name: "dir/f" + itoa(i) + ".bin", Size: 0}
	}
	sink := newMemSink()
	sink.failPublishAt = 500
	s := openSession(t, sink, entries)
	for i := range entries {
		if err := s.BeginFile(i); err != nil {
			t.Fatal(err)
		}
		if _, err := s.FinishFile(i); err != nil {
			t.Fatal(err)
		}
	}
	result, _ := s.Publish()
	buf, err := wire.EncodeResponse(wire.Response{ID: 1, OK: false, Code: wire.CodePartialPublication, Result: mustJSON(t, result)})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(buf) > wire.MaxResponseBytes {
		t.Fatalf("1000-file receipt is %d bytes, over the enforced bound", len(buf))
	}
}

func TestPublishIsTerminalAndSingular(t *testing.T) {
	s := openSession(t, newMemSink(), manifest(wire.ManifestEntry{Name: "a", Size: 0}))
	if err := s.BeginFile(0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishFile(0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Publish(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Publish(); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("second publish: want E_SEQUENCE, got %v", err)
	}
}

// Repeated cancels must join one settled result rather than racing a second
// teardown.
func TestCleanupIsIdempotent(t *testing.T) {
	sink := newMemSink()
	s := openSession(t, sink, manifest(wire.ManifestEntry{Name: "a", Size: 4}))
	first := s.Cleanup()
	second := s.Cleanup()
	if sink.cleanups != 1 {
		t.Fatalf("sink cleaned %d times, want 1", sink.cleanups)
	}
	if first != second {
		t.Fatalf("repeated cancel returned different results: %+v then %+v", first, second)
	}
	if err := s.BeginFile(0); wire.CodeOf(err) != wire.CodeSequence {
		t.Fatalf("operation after cleanup: want E_SEQUENCE, got %v", err)
	}
}

// The manifest is re-decided here, independently of whatever the host validated.
func TestManifestIsIndependentlyRefused(t *testing.T) {
	for _, name := range []string{`..\escape`, "../escape", "CON", "a:b", "trailing."} {
		s := New(newMemSink())
		if _, err := s.Open(`C:\d`, manifest(wire.ManifestEntry{Name: name, Size: 1})); wire.CodeOf(err) != wire.CodeManifest {
			t.Errorf("%q: want E_MANIFEST, got %v", name, err)
		}
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
