package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A request in flight when shutdown starts must be allowed to finish, not cut
// off — an update restarts the node, and cutting live downloads on every
// rollout is exactly what graceful shutdown exists to prevent.
func TestGracefulShutdownLetsInFlightRequestFinish(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(200 * time.Millisecond) // simulate a download still streaming
		fmt.Fprint(w, "done")
	}))
	srv.Start()
	defer srv.Close()

	body := make(chan string, 1)
	go func() {
		resp, err := http.Get(srv.URL)
		if err != nil {
			body <- "ERR:" + err.Error()
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		body <- string(b)
	}()

	<-started
	if err := gracefulShutdown([]*http.Server{srv.Config}, 5*time.Second); err != nil {
		t.Fatalf("gracefulShutdown: %v", err)
	}

	select {
	case got := <-body:
		if got != "done" {
			t.Errorf("in-flight request got %q, want %q", got, "done")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight request never completed")
	}
}

// A request that outlives the grace period must not hold shutdown open
// forever; the updater is waiting on this process to exit.
func TestGracefulShutdownGivesUpAfterDeadline(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
	}))
	srv.Start()
	defer srv.Close()

	go http.Get(srv.URL) //nolint:errcheck // the client side is expected to fail here
	time.Sleep(50 * time.Millisecond)

	start := time.Now()
	err := gracefulShutdown([]*http.Server{srv.Config}, 300*time.Millisecond)
	elapsed := time.Since(start)

	if err == nil {
		t.Error("want a deadline error when a request outlives the grace period, got nil")
	}
	if elapsed > 2*time.Second {
		t.Errorf("gracefulShutdown blocked %v, want it to give up near the 300ms deadline", elapsed)
	}
}
