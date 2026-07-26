package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A fake node blob server for routing tests.
func fakeNode(t *testing.T, store map[string][]byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			store[key] = b
			io.WriteString(w, `{"size":`+intToStr(len(b))+`}`)
		case http.MethodPatch:
			// Chunked append, mirroring the real node handler: X-Blob-Offset must
			// equal the current size, and the new size comes back as JSON.
			off, _ := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
			cur := int64(len(store[key]))
			if off != cur {
				w.WriteHeader(http.StatusConflict)
				io.WriteString(w, `{"size":`+intToStr(int(cur))+`}`)
				return
			}
			b, _ := io.ReadAll(r.Body)
			store[key] = append(store[key], b...)
			io.WriteString(w, `{"size":`+intToStr(len(store[key]))+`}`)
		case http.MethodGet:
			b, ok := store[key]
			if !ok {
				w.WriteHeader(404)
				return
			}
			w.Write(b)
		case http.MethodDelete:
			delete(store, key)
			w.WriteHeader(204)
		}
	}))
}

// intToStr avoids strconv just to keep this helper self-contained; reused by the
// SP2 upload/download routing tests (same package).
func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func TestBlobForLocalAndRemote(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(1000, 0) }, nodeHTTP: http.DefaultClient}

	// nodeID "" -> local blobs. With s.blobs nil, blobFor returns it (nil) w/o error.
	bs, err := s.blobFor(ctx, "")
	if err != nil {
		t.Fatalf("local blobFor err: %v", err)
	}
	_ = bs

	// A registered storage node -> RemoteBlobStore that reaches the fake node.
	nodeStore := map[string][]byte{}
	srv := fakeNode(t, nodeStore)
	defer srv.Close()
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: srv.URL, StorageSecret: "ss", StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1000})
	rbs, err := s.blobFor(ctx, n.ID)
	if err != nil {
		t.Fatalf("remote blobFor: %v", err)
	}
	if _, err := rbs.Put(ctx, "k1", strings.NewReader("hello")); err != nil {
		t.Fatalf("remote put: %v", err)
	}
	if string(nodeStore["k1"]) != "hello" {
		t.Fatalf("node did not receive blob: %q", nodeStore["k1"])
	}

	// Unknown node -> error.
	if _, err := s.blobFor(ctx, "nope"); err == nil {
		t.Fatal("expected error for unknown node")
	}
}

func TestPlaceUploadPicksNodeOrFallsBack(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	s := &Service{store: st, now: func() time.Time { return time.Unix(1000, 0) },
		nodeHTTP: http.DefaultClient, cfg: Config{MaxFileSize: 1 << 20},
		pickN: func(n int) int { return 0 }}

	// No storage nodes -> central fallback ("", local blobs, billable).
	id, _, billable, err := s.placeUpload(ctx, "nobody", 1<<10)
	if id != "" || !billable || err != nil {
		t.Fatalf("want central fallback billable, got node %q billable=%v err=%v", id, billable, err)
	}

	// One eligible fleet node -> chosen (billable, since it's not the user's own).
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://x:8081", StorageSecret: "ss", StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1000})
	id, _, billable, err = s.placeUpload(ctx, "nobody", 1<<10)
	if id != n.ID || !billable || err != nil {
		t.Fatalf("want node %q billable, got %q billable=%v err=%v", n.ID, id, billable, err)
	}
}
