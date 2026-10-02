package main

import (
	"fmt"
	"sort"
	"sync"
	"testing"
)

// logRecorder is the injected logger the deterministic hook writes through.
// Each test owns one, so nothing here touches the process-wide `log` output.
type logRecorder struct {
	mu    sync.Mutex
	lines []string
}

func (r *logRecorder) logf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, fmt.Sprintf(format, args...))
}

func (r *logRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.lines...)
}

// The six-id schedule the Android interop acceptance uses: browser responder,
// initiator, responder across three rounds of two sockets each.
const sixIDs = "f111111111111111,0111111111111111,0222222222222222,f222222222222222,f333333333333333,0333333333333333"

var sixIDList = []string{
	"f111111111111111", "0111111111111111",
	"0222222222222222", "f222222222222222",
	"f333333333333333", "0333333333333333",
}

func TestAcceptancePeerIDGeneratorDefaultsToRandomIDs(t *testing.T) {
	rec := &logRecorder{}
	gen, err := acceptancePeerIDGenerator("", ":8080", "auto", true, rec.logf)
	if err != nil {
		t.Fatal(err)
	}
	first := gen()
	if len(first) != 16 {
		t.Fatalf("generated id length = %d, want 16", len(first))
	}
	for range 32 {
		if got := gen(); got == first {
			t.Fatalf("the default generator repeated %q; it must stay random", got)
		}
	}
	if lines := rec.snapshot(); len(lines) != 0 {
		t.Fatalf("the default (production) generator logged %d line(s): %q", len(lines), lines)
	}
}

// Every real server passes a logger; the default branch must ignore it even
// when it is absent, so production never depends on the hook's plumbing.
func TestAcceptancePeerIDGeneratorDefaultNeedsNoLogger(t *testing.T) {
	gen, err := acceptancePeerIDGenerator("  ", "127.0.0.1:0", mailTransportDevLogLinks, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := gen(); len(got) != 16 {
		t.Fatalf("generated id length = %d, want 16", len(got))
	}
}

func TestAcceptancePeerIDGeneratorCyclesDeterministicIDsLocally(t *testing.T) {
	rec := &logRecorder{}
	gen, err := acceptancePeerIDGenerator(
		"ffffffffffffffff, 0000000000000000",
		"127.0.0.1:0",
		mailTransportDevLogLinks,
		false,
		rec.logf,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ffffffffffffffff", "0000000000000000", "ffffffffffffffff"}
	for i, expected := range want {
		if got := gen(); got != expected {
			t.Fatalf("id %d = %q, want %q", i, got, expected)
		}
	}
	wantLines := []string{
		"relayium-acceptance-peer-id seq=1 id=ffffffffffffffff",
		"relayium-acceptance-peer-id seq=2 id=0000000000000000",
		"relayium-acceptance-peer-id seq=3 id=ffffffffffffffff",
	}
	if got := rec.snapshot(); fmt.Sprint(got) != fmt.Sprint(wantLines) {
		t.Fatalf("logged %q, want %q", got, wantLines)
	}
}

// The id list cycles, so the ids alone cannot tell six sockets from twelve.
// The sequence must keep counting through every wrap — a seventh socket is
// seq=7 even though it receives the first id again.
func TestAcceptancePeerIDGeneratorSequenceSurvivesTheCycle(t *testing.T) {
	for _, calls := range []int{6, 7, 12} {
		t.Run(fmt.Sprintf("%d invocations", calls), func(t *testing.T) {
			rec := &logRecorder{}
			gen, err := acceptancePeerIDGenerator(sixIDs, "127.0.0.1:0", mailTransportDevLogLinks, false, rec.logf)
			if err != nil {
				t.Fatal(err)
			}
			for i := range calls {
				if got, want := gen(), sixIDList[i%len(sixIDList)]; got != want {
					t.Fatalf("invocation %d returned %q, want %q", i+1, got, want)
				}
			}
			lines := rec.snapshot()
			if len(lines) != calls {
				t.Fatalf("logged %d line(s) for %d invocations", len(lines), calls)
			}
			for i, line := range lines {
				want := fmt.Sprintf("relayium-acceptance-peer-id seq=%d id=%s", i+1, sixIDList[i%len(sixIDList)])
				if line != want {
					t.Fatalf("line %d = %q, want %q", i+1, line, want)
				}
			}
		})
	}
}

// Concurrent accepts may log out of order, but the sequence numbers are the
// counter's own values: every one of 1..N exactly once.
func TestAcceptancePeerIDGeneratorConcurrentSequenceIsUnique(t *testing.T) {
	rec := &logRecorder{}
	gen, err := acceptancePeerIDGenerator(sixIDs, "127.0.0.1:0", mailTransportDevLogLinks, false, rec.logf)
	if err != nil {
		t.Fatal(err)
	}
	const n = 64
	var wg sync.WaitGroup
	for range n {
		wg.Go(func() { _ = gen() })
	}
	wg.Wait()
	lines := rec.snapshot()
	if len(lines) != n {
		t.Fatalf("logged %d line(s) for %d invocations", len(lines), n)
	}
	seqs := make([]int, 0, n)
	for _, line := range lines {
		var seq int
		var id string
		if _, err := fmt.Sscanf(line, "relayium-acceptance-peer-id seq=%d id=%s", &seq, &id); err != nil {
			t.Fatalf("unparseable line %q: %v", line, err)
		}
		if want := sixIDList[(seq-1)%len(sixIDList)]; id != want {
			t.Fatalf("seq %d carried %q, want %q", seq, id, want)
		}
		seqs = append(seqs, seq)
	}
	sort.Ints(seqs)
	for i, seq := range seqs {
		if seq != i+1 {
			t.Fatalf("sorted sequence %v is not exactly 1..%d", seqs, n)
		}
	}
}

func TestAcceptancePeerIDGeneratorRefusesUnsafeConfiguration(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		addr      string
		transport string
		release   bool
	}{
		{"public listener", "ffffffffffffffff,0000000000000000", ":8080", mailTransportDevLogLinks, false},
		{"release check", "ffffffffffffffff,0000000000000000", "127.0.0.1:0", mailTransportDevLogLinks, true},
		{"normal mail", "ffffffffffffffff,0000000000000000", "127.0.0.1:0", "auto", false},
		{"malformed id", "not-hex,0000000000000000", "127.0.0.1:0", mailTransportDevLogLinks, false},
		{"one id", "0000000000000000", "127.0.0.1:0", mailTransportDevLogLinks, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := &logRecorder{}
			if _, err := acceptancePeerIDGenerator(tt.raw, tt.addr, tt.transport, tt.release, rec.logf); err == nil {
				t.Fatal("accepted unsafe deterministic peer-id configuration")
			}
			if lines := rec.snapshot(); len(lines) != 0 {
				t.Fatalf("a refused configuration logged %q", lines)
			}
		})
	}
}

// A deterministic schedule whose sequence nobody can see is the six-versus-
// twelve ambiguity again, so a missing logger is a refusal, not a silent hook.
func TestAcceptancePeerIDGeneratorRefusesDeterministicIDsWithoutALogger(t *testing.T) {
	if _, err := acceptancePeerIDGenerator(sixIDs, "127.0.0.1:0", mailTransportDevLogLinks, false, nil); err == nil {
		t.Fatal("accepted a deterministic schedule with no logger for its sequence")
	}
}
