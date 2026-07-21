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

// While the shared brute-force breaker is OPEN, /api/ice must serve STUN-only
// even for a VALID code — no TURN credential, no relays — so it cannot be used
// as a validity oracle or a victim-billed credential tap during a flood.
func TestICEBreakerOpenServesStunOnly(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetPairCodeOwner(ownerResolver("owner-1", "424242"))
	svc.SetGuessBreaker(&fakeBreaker{open: true})

	resp, err := ts.Client().Get(ts.URL + "/api/ice?code=424242")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if hasTURN(iceServersFromBody(t, resp)) {
		t.Fatal("SECURITY: /api/ice handed out a TURN credential while the guess breaker was open")
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
