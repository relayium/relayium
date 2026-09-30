package account

import (
	"fmt"
	"strings"
	"testing"
)

// N-0930-8 (small parts): bytes the A-M8 budget drops are accounted for in the
// log beyond the once-per-window budget warning, and the implausibility
// threshold's position relative to one bucket is pinned.

const n0930DropText = "dropped over the owed cap in the last"

// A flood that overflows the owed cap: every dropped byte is reported, summed
// per pair, once the interval has passed — not per heartbeat, and not only the
// report that happened to trigger the window's single budget warning.
func TestN0930_8_DroppedBytesAreLoggedPerPairPerInterval(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node, quiet := e.fleetNode(), e.fleetNode()
	victim := e.user("victim@n0930-8.test")
	const beats = 40
	e.set(a_m8Base)
	for i := 0; i < beats; i++ {
		e.heartbeat(node, forgedBatch(fmt.Sprintf("n8-%d", i), victim))
	}
	claimed := int64(beats) * maxAllocsPerUser * maxFirstReportBytes
	wantDropped := claimed - 2*a_m8Capacity // one bucket recorded, one owed
	if got := e.recorded(victim, ""); got != a_m8Capacity {
		t.Fatalf("setup: recorded %d, want one bucket %d", got, a_m8Capacity)
	}
	if owed := e.owed(node, victim); owed != a_m8Capacity {
		t.Fatalf("setup: owed %d, want one bucket %d", owed, a_m8Capacity)
	}
	if wantDropped <= 0 {
		t.Fatalf("setup: the flood does not overflow the owed cap (%d)", wantDropped)
	}
	if c := strings.Count(logs.String(), a_m8WarnText); c != 1 {
		t.Fatalf("budget warnings %d, want the existing single one per window", c)
	}
	if strings.Contains(logs.String(), n0930DropText) {
		t.Fatalf("dropped bytes were logged before the interval passed (per-heartbeat spam):\n%s", logs)
	}

	// Another node's heartbeat after the interval reports the whole sum once.
	e.set(a_m8Base + relayAttribDropLogEvery)
	e.heartbeat(quiet, nil)
	want := fmt.Sprintf("node %s had %d bytes for user %s %s %ds", node, wantDropped, victim, n0930DropText, relayAttribDropLogEvery)
	if c := strings.Count(logs.String(), n0930DropText); c != 1 || !strings.Contains(logs.String(), want) {
		t.Fatalf("want exactly one drop line %q, got %d:\n%s", want, c, logs)
	}
	// Flushed: later heartbeats with no new drops say nothing more.
	e.set(a_m8Base + 3*relayAttribDropLogEvery)
	e.heartbeat(quiet, nil)
	if c := strings.Count(logs.String(), n0930DropText); c != 1 {
		t.Fatalf("drop line repeated without new drops (%d)", c)
	}
	// Accounting unchanged by the log: still one bucket recorded before drains.
	if e.recorded(victim, node) < a_m8Capacity {
		t.Fatal("the drop log changed what was recorded")
	}
}

// A pair that never overflows the owed cap produces no drop line.
func TestN0930_8_NoDropsNoDropLine(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("quiet@n0930-8.test")
	e.set(a_m8Base)
	for i := 0; i < 4; i++ { // 4 x 64 x ~3.2 GiB < two buckets: deferred, never dropped
		e.heartbeat(node, forgedBatch(fmt.Sprintf("q-%d", i), victim))
	}
	e.set(a_m8Base + relayAttribDropLogEvery)
	e.heartbeat(node, nil)
	if strings.Contains(logs.String(), n0930DropText) {
		t.Fatalf("a drop line without dropped bytes:\n%s", logs)
	}
}

// The threshold sits above the legitimate per-heartbeat cadence, below one
// forged heartbeat of fresh allocs, and below one bucket (so it is reachable:
// one heartbeat can never record more than a bucket).
func TestN0930_8_ImplausibleThresholdSitsBetweenCadenceAndForgery(t *testing.T) {
	cadence := int64(relayAttribAllocs) * (int64(maxRelayBytesPerSec)*nodeHeartbeatInterval + relayReportSlack)
	forgedFresh := int64(maxAllocsPerUser) * maxFirstReportBytes
	if !(cadence < implausiblePerHeartbeat) {
		t.Fatalf("legit cadence %d would trip the %d threshold", cadence, int64(implausiblePerHeartbeat))
	}
	if !(implausiblePerHeartbeat < forgedFresh) {
		t.Fatalf("one forged heartbeat (%d) does not trip the %d threshold", forgedFresh, int64(implausiblePerHeartbeat))
	}
	if !(implausiblePerHeartbeat < a_m8Capacity) {
		t.Fatalf("threshold %d is not below one bucket %d: the warning could never fire", int64(implausiblePerHeartbeat), a_m8Capacity)
	}
}

// The case the sub-bucket threshold exists for: a forger's first heartbeat on a
// fresh pair fits in the bucket, so the budget withholds nothing and stays
// silent — only the implausibility warning names it.
func TestN0930_8_ForgersFirstBucketIsFlaggedOnlyByImplausibility(t *testing.T) {
	logs := a_m8CaptureLog(t)
	e := newA_M8Env(t)
	node := e.fleetNode()
	victim := e.user("first@n0930-8.test")
	e.set(a_m8Base)
	e.heartbeat(node, forgedBatch("first", victim))
	if got, want := e.recorded(victim, ""), int64(maxAllocsPerUser)*maxFirstReportBytes; got != want {
		t.Fatalf("recorded %d, want the whole fresh batch %d (fits in the bucket)", got, want)
	}
	if strings.Contains(logs.String(), a_m8WarnText) {
		t.Fatalf("setup: the budget warned although it withheld nothing:\n%s", logs)
	}
	if !strings.Contains(logs.String(), "attributed") || !strings.Contains(logs.String(), "implausible for a") {
		t.Fatalf("the forger's first bucket went unflagged:\n%s", logs)
	}
}
