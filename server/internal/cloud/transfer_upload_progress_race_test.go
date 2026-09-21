package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// A server may refuse an upload before it has read it (413, 429). Upload then
// returns while the writer goroutine is still feeding the pipe -- and the caller
// clears its progress line the moment Upload returns. A Progress call that is
// still running, or that starts afterwards, repaints a bar over the error and
// races the caller on the bar's fields. Confirming was guarded against this when
// it was added; Progress needs the same guarantee.
func TestProgressNeverRunsOnceUploadHasReturned(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge) // without reading the body
	}))
	defer srv.Close()

	p := filepath.Join(t.TempDir(), "big.bin")
	if err := os.WriteFile(p, make([]byte, 8<<20), 0o644); err != nil {
		t.Fatal(err)
	}

	var returned, during, after atomic.Int32
	c := NewClient(srv.URL)
	c.Token = "t"
	c.Progress = func(done, total int64) {
		if returned.Load() == 1 {
			after.Add(1)
			return
		}
		// Slow on purpose: a caller's repaint is allowed to take time, and the
		// question is whether Upload can return underneath it.
		time.Sleep(20 * time.Millisecond)
		if returned.Load() == 1 {
			during.Add(1)
		}
	}
	_, _, _, err := c.Upload(context.Background(), []string{p}, UploadOpts{})
	returned.Store(1)
	if err == nil {
		t.Fatal("the refusal was lost")
	}
	time.Sleep(200 * time.Millisecond) // let a stray writer show itself
	if d, a := during.Load(), after.Load(); d != 0 || a != 0 {
		t.Fatalf("Progress ran underneath the caller: %d still running at return, %d started after it", d, a)
	}
}
