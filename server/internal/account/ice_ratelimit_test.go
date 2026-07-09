package account

import (
	"net/http"
	"testing"
)

// fakeLimiter is a minimal test double for the rateLimiter interface.
type fakeLimiter struct{ n, limit int }

func (f *fakeLimiter) Allow(string) bool {
	f.n++
	return f.n <= f.limit
}

func TestICERateLimited(t *testing.T) {
	ts, svc, _ := newICEServer(t, "secret")
	svc.SetICELimiter(&fakeLimiter{limit: 5})

	for i := 0; i < 5; i++ {
		resp, err := http.Get(ts.URL + "/api/ice")
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("request %d: got status %d, want 200", i, resp.StatusCode)
		}
	}

	resp, err := http.Get(ts.URL + "/api/ice")
	if err != nil {
		t.Fatalf("6th request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("6th request: got status %d, want %d", resp.StatusCode, http.StatusTooManyRequests)
	}
}

func TestICENoLimiterUnaffected(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret")

	for i := 0; i < 10; i++ {
		resp, err := http.Get(ts.URL + "/api/ice")
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("request %d: got status %d, want 200", i, resp.StatusCode)
		}
	}
}
