package account

import "testing"

// TestDiskCapOverThreshold: once the injected usage source reports used >=
// maxBytes, new uploads are refused with 503 — the global backstop against
// "per-account quota × unbounded accounts is still unbounded" (M3b).
func TestDiskCapOverThreshold(t *testing.T) {
	ts, svc, _, mail := newFileServer(t)
	svc.SetDiskGuard(func() (uint64, uint64, error) { return 200, 100, nil }, 100)
	cookie := loginCookie(t, ts, mail, "over@example.com")

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("x")))
	if resp.StatusCode != 503 {
		t.Fatalf("upload over disk cap: want 503, got %d", resp.StatusCode)
	}
}

// TestDiskCapUnderThreshold: usage below the high-water mark leaves uploads
// unaffected.
func TestDiskCapUnderThreshold(t *testing.T) {
	ts, svc, _, mail := newFileServer(t)
	svc.SetDiskGuard(func() (uint64, uint64, error) { return 10, 100, nil }, 100)
	cookie := loginCookie(t, ts, mail, "under@example.com")

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("x")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload under disk cap: want 200, got %d", resp.StatusCode)
	}
}

// TestDiskCapDisabledByDefault: no SetDiskGuard call means the default nil
// usage func / zero max leaves existing upload behavior unchanged.
func TestDiskCapDisabledByDefault(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "default@example.com")

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("x")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload with disk cap disabled: want 200, got %d", resp.StatusCode)
	}
}

// TestDiskCapUsageErrorFailsOpen: a Statfs (or injected) error must not block
// every upload on one transient blip — log and allow.
func TestDiskCapUsageErrorFailsOpen(t *testing.T) {
	ts, svc, _, mail := newFileServer(t)
	svc.SetDiskGuard(func() (uint64, uint64, error) { return 0, 0, errStatfsFake }, 100)
	cookie := loginCookie(t, ts, mail, "err@example.com")

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("x")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload with usage-error (fail-open): want 200, got %d", resp.StatusCode)
	}
}

var errStatfsFake = &fakeStatfsErr{}

type fakeStatfsErr struct{}

func (*fakeStatfsErr) Error() string { return "fake statfs error" }
