package sourceserve

import "testing"

// A pipe can reach EOF between the dispatcher's empty poll and its blocking
// select. Requests already admitted before EOF still need their replies and
// their handles closed. Repetition exercises the actual reader/dispatcher
// goroutines rather than a second implementation of their selection logic.
func TestEOFDrainsAdmittedRequestsAndClosesSources(t *testing.T) {
	for iteration := 0; iteration < 1000; iteration++ {
		src := newFake("complete source")
		op := openerWith(map[string]*fakeSource{`C:\f`: src})
		got := run(t, op, stream(t,
			`{"id":1,"op":"open-source","path":"C:\\f"}`,
			`{"id":2,"op":"close-source","source":1}`,
		))
		if len(got.responses) != 2 {
			t.Fatalf("iteration %d: responses=%d, exit=%d, log=%q", iteration, len(got.responses), got.exit, got.log)
		}
		for index, response := range got.responses {
			if response.ID != uint64(index+1) || !response.OK {
				t.Fatalf("iteration %d: response %d = %+v", iteration, index, response)
			}
		}
		if got.exit != ExitClean || src.closes != 1 || op.openCount() != 1 {
			t.Fatalf("iteration %d: exit=%d opens=%d closes=%d log=%q", iteration, got.exit, op.openCount(), src.closes, got.log)
		}
	}
}
