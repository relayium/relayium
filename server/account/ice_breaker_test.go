package account

import (
	"net/http"
	"testing"
)

type fakeBreaker struct {
	open        bool
	recordCalls int
}

func (b *fakeBreaker) IsOpen() bool { return b.open }
func (b *fakeBreaker) RecordInvalid() (bool, bool) {
	b.recordCalls++
	return b.open, false
}

// While the shared brute-force breaker is OPEN, /api/ice stays symmetric with
// /ws: a VALID code still gets its TURN credential (forcing valid codes to
// STUN-only turned a cheap guess-flood into a fleet-wide relay outage), while an
// invalid code gets STUN-only and feeds the breaker. An attacker only obtains a
// credential by actually guessing a live code, still bounded by the per-IP cap.
func TestICEBreakerOpenStillServesValidCodes(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetPairCodeOwner(ownerResolver("owner-1", "424242"))
	svc.SetGuessBreaker(&fakeBreaker{open: true})

	// Valid code while OPEN → TURN credential still issued (availability preserved).
	resp, err := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if !hasTURN(iceServersFromBody(t, resp)) {
		t.Fatal("a valid code must keep getting relay while the breaker is OPEN (no legit outage)")
	}

	// Invalid code while OPEN → STUN-only (no credential leaked to a guesser).
	svc.SetPairCodeOwner(func(string) (string, bool) { return "", false })
	resp2, err := ts.Client().Get(ts.URL + "/api/ice?code=999999")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if hasTURN(iceServersFromBody(t, resp2)) {
		t.Fatal("SECURITY: /api/ice handed a TURN credential to an INVALID code")
	}
}

// An invalid pairing code feeds the shared breaker so an /api/ice-targeted
// guessing flood trips it; a valid code does not.
func TestICEInvalidCodeFeedsBreaker(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")

	// Invalid code → RecordInvalid called.
	svc.SetPairCodeOwner(func(string) (string, bool) { return "", false })
	fb := &fakeBreaker{}
	svc.SetGuessBreaker(fb)
	resp, _ := ts.Client().Get(ts.URL + "/api/ice?code=000000")
	resp.Body.Close()
	if fb.recordCalls != 1 {
		t.Fatalf("invalid code: want 1 RecordInvalid call, got %d", fb.recordCalls)
	}

	// Valid code → breaker not fed.
	svc.SetPairCodeOwner(ownerResolver("owner-1", "424242"))
	fb2 := &fakeBreaker{}
	svc.SetGuessBreaker(fb2)
	resp, _ = ts.Client().Get(ts.URL + "/api/ice?code=424242")
	resp.Body.Close()
	if fb2.recordCalls != 0 {
		t.Fatalf("valid code: breaker must not be fed, got %d calls", fb2.recordCalls)
	}
}
