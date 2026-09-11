// Independent review probe: two sources held at once, reads interleaved.
//
// Written during the Claude single-agent review pass, not by the implementation
// author, and deliberately aimed at the one pattern the owning tests do not
// exercise: more than one source open at the same time. The OS-entry adapter
// will produce exactly this pattern, because a user selects several files.
//
// It pins three things that a single-source test cannot distinguish:
//
//   - the handle table is keyed by the requested source id, so a read is served
//     from the source it named and not from whichever handle is handy;
//   - the shared `scratch` buffer, reused by every read, does not let one read's
//     bytes reach another read's chunk — the chunk must own its payload by the
//     time it is queued, because the writer drains asynchronously;
//   - closing one source leaves the others readable and correctly identified.
//
// It also pins the documented EOF rule at the exact boundary: a read that
// consumes the final bytes, with n == length, reports eof=false. EOF is what a
// read OBSERVED, never what the size recorded at open time implies.
package sourceserve

import (
	"fmt"
	"testing"
)

func TestInterleavedSourcesKeepTheirOwnBytes(t *testing.T) {
	// Distinct content, so a mix-up is visible rather than plausible.
	a := newFake("AAAAAaaaaa")
	b := newFake("BBBBBbbbbb")
	// Distinct identities, so a swapped table entry is visible in the open
	// results too and not only in the bytes.
	b.vol = "00000000feedface"
	b.fid = "ffffffffeeeeeeeeddddddddcccccccc"

	opener := openerWith(map[string]*fakeSource{`C:\a.bin`: a, `C:\b.bin`: b})

	// Seven frames, deliberately under MaxInboxDepth, so admission can never
	// overflow and this probe tests dispatch rather than backpressure.
	got := run(t, opener, stream(t,
		`{"id":1,"op":"open-source","path":"C:\\a.bin"}`,
		`{"id":2,"op":"open-source","path":"C:\\b.bin"}`,
		`{"id":3,"op":"read-source","source":1,"offset":0,"length":5}`,
		`{"id":4,"op":"read-source","source":2,"offset":0,"length":5}`,
		`{"id":5,"op":"close-source","source":1}`,
		`{"id":6,"op":"read-source","source":2,"offset":5,"length":5}`,
		`{"id":7,"op":"close-source","source":2}`,
	))

	if got.exit != ExitClean {
		t.Fatalf("exit = %d, log = %q", got.exit, got.log)
	}
	if len(got.responses) != 7 {
		t.Fatalf("want 7 responses, got %d: %+v", len(got.responses), got.responses)
	}
	byID := map[uint64]int{}
	for i, r := range got.responses {
		byID[r.ID] = i
	}

	openA := result[OpenResult](t, got.responses[byID[1]])
	openB := result[OpenResult](t, got.responses[byID[2]])
	if openA.Source == openB.Source {
		t.Fatalf("two sources share id %d", openA.Source)
	}
	// Identity must follow the source it was opened for.
	if openA.VolumeSerial != a.vol || openA.FileID != a.fid {
		t.Errorf("source A identity = %s/%s", openA.VolumeSerial, openA.FileID)
	}
	if openB.VolumeSerial != b.vol || openB.FileID != b.fid {
		t.Errorf("source B identity = %s/%s", openB.VolumeSerial, openB.FileID)
	}

	// The heart of it: each chunk carries its own source's bytes.
	for _, want := range []struct {
		id    uint64
		bytes string
	}{
		{3, "AAAAA"},
		{4, "BBBBB"},
		{6, "bbbbb"},
	} {
		if got, ok := got.chunks[want.id]; !ok {
			t.Errorf("request %d produced no chunk", want.id)
		} else if string(got) != want.bytes {
			t.Errorf("request %d chunk = %q, want %q", want.id, got, want.bytes)
		}
	}

	// A read that lands exactly on the end reports what it observed: five bytes
	// and NOT eof, because this read never saw the end.
	last := result[ReadResult](t, got.responses[byID[6]])
	if last.Bytes != 5 || last.EOF {
		t.Errorf("boundary read = %+v, want {Bytes:5 EOF:false}", last)
	}

	// Closing A must not have disturbed B, and both must have been released
	// exactly once by the host rather than left to the teardown inventory.
	closeA := result[CloseResult](t, got.responses[byID[5]])
	closeB := result[CloseResult](t, got.responses[byID[7]])
	if closeA.State != StateClosed || closeB.State != StateClosed {
		t.Errorf("close states = %q/%q", closeA.State, closeB.State)
	}
	if a.closes != 1 || b.closes != 1 {
		t.Errorf("closes = %d/%d, want 1/1", a.closes, b.closes)
	}
	if msg := fmt.Sprintf("%s", got.log); msg != "" {
		t.Errorf("clean session logged %q", msg)
	}
}
