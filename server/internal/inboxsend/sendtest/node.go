package sendtest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/storage"
)

// Node is a fleet storage node for the remote-storage path: central places
// uploads on it and reads them back through the real account.RemoteBlobStore
// client. Its blob API is served by a real DiskStore behind a handler that
// mirrors cmd/relayium-node's /blob routes (PATCH offset append with a 409
// re-sync answer, GET through http.ServeContent for Range, idempotent DELETE).
// cmd/relayium-node is package main and cannot be imported; the storage
// semantics that matter here all live in the shared DiskStore.
type Node struct {
	ID    string
	Disk  *storage.DiskStore
	Dir   string
	TS    *httptest.Server
	down  atomic.Bool
	reads atomic.Int64
}

// SetDown makes every blob request fail at the transport (the connection is
// dropped before any answer), which is what central sees of a node that is
// offline or unreachable.
func (n *Node) SetDown(down bool) { n.down.Store(down) }

// Reads is how many blob GETs reached the node.
func (n *Node) Reads() int64 { return n.reads.Load() }

// NewWithNode is New with every upload placed on one fleet storage node
// instead of central's own disk: the remote-storage path end to end.
func NewWithNode(t testing.TB, maxFile int64) (*Env, *Node) {
	t.Helper()
	// Central refuses to dial loopback node URLs unless this is set (SSRF guard);
	// it is read once, when the service is built.
	t.Setenv("RELAYIUM_ALLOW_PRIVATE_NODE_URLS", "true")
	e := newEnv(t, maxFile)
	dir := t.TempDir()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("node disk store: %v", err)
	}
	const secret = "sendtest-node-secret"
	n := &Node{Disk: ds, Dir: dir}
	n.TS = httptest.NewServer(nodeBlobHandler(n, secret))
	t.Cleanup(n.TS.Close)
	node, err := e.Store.UpsertNode(context.Background(), account.Node{
		OwnerType: "fleet", StorageEnabled: true, StorageURL: n.TS.URL, StorageSecret: secret,
		StorageTotal: 1 << 40, StorageFree: 1 << 39, CreatedAt: 1, LastSeenAt: time.Now().Unix() + 3600,
	})
	if err != nil {
		t.Fatalf("register node: %v", err)
	}
	n.ID = node.ID
	return e, n
}

func nodeBlobHandler(n *Node, secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.down.Load() {
			panic(http.ErrAbortHandler) // drop the connection: an unreachable node
		}
		if r.Header.Get("Authorization") != "Bearer "+secret {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		ctx := r.Context()
		switch r.Method {
		case http.MethodPut:
			size, err := n.Disk.Put(ctx, key, r.Body)
			if err != nil {
				http.Error(w, "write failed", http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
		case http.MethodPatch:
			off, err := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
			if err != nil || off < 0 {
				http.Error(w, "bad offset", http.StatusBadRequest)
				return
			}
			size, err := n.Disk.Append(ctx, key, off, r.Body)
			if errors.Is(err, storage.ErrOffsetMismatch) {
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
				return
			}
			if err != nil {
				http.Error(w, "append failed", http.StatusInternalServerError)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
		case http.MethodGet:
			n.reads.Add(1)
			rc, err := n.Disk.Get(ctx, key)
			if errors.Is(err, storage.ErrNotFound) || errors.Is(err, storage.ErrInvalidKey) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			if err != nil {
				http.Error(w, "read failed", http.StatusInternalServerError)
				return
			}
			defer rc.Close()
			if rs, ok := rc.(io.ReadSeeker); ok {
				http.ServeContent(w, r, key, time.Time{}, rs)
				return
			}
			_, _ = io.Copy(w, rc)
		case http.MethodDelete:
			if err := n.Disk.Delete(ctx, key); err != nil && !errors.Is(err, storage.ErrInvalidKey) {
				http.Error(w, "delete failed", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method", http.StatusMethodNotAllowed)
		}
	})
}
