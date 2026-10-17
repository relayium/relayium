package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestUploadPipelineHTTP2CancellationReleasesUnreadWaiter(t *testing.T) {
	h := newDurHarness(t)
	id := initUpload(t, h.ts, h.cookie, []byte("manifest"), 900, 0)
	var protocol atomic.Int32
	routes := h.svc.Routes()
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PATCH" {
			protocol.Store(int32(r.ProtoMajor))
		}
		routes.ServeHTTP(w, r)
	}))
	ts.EnableHTTP2 = true
	ts.StartTLS()
	defer ts.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	queued := pipelineRequest(ctx, ts, h.cookie, id, []byte("queued"), 400, true)
	waitPipelineWaiter(t, h.svc, 1)
	if protocol.Load() != 2 {
		t.Fatalf("test did not exercise HTTP/2: %d", protocol.Load())
	}
	cancel()
	if r := pipelineAnswer(t, queued); r.err == nil {
		t.Fatalf("cancelled request succeeded: %+v", r)
	}
	waitPipelineWaiter(t, h.svc, 0)
	if h.meter(t) != 0 || h.row(t, id).Received != 0 {
		t.Fatal("unread body was committed")
	}
}
