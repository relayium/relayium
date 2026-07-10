# SP2 — Node Storage (Distributed Blob) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered relay node store stored-transfer blobs on its own disk (central-proxy routing), so blob storage spreads across the fleet instead of piling onto the central volume; central keeps the metadata directory and proxies ciphertext to/from the node.

**Architecture:** The single `s.blobs storage.BlobStore` becomes a per-file lookup `s.blobFor(nodeID)` — the local `DiskStore` for `nodeID==""` (central, the first node) or a new `storage.RemoteBlobStore` (same `BlobStore` interface) that PUT/GET/DELETEs to a node's HTTP blob endpoint. The node runs an authenticated HTTP blob server backed by `storage.DiskStore`. Uploads pick an eligible node at random; the file's `node_id` is recorded. Downloads/deletes/GC route by `node_id`. E2E unchanged: nodes store ciphertext only.

**Tech Stack:** Go (module root `server/`, `github.com/relayium/relayium`, CGO off), `modernc.org/sqlite`, `net/http`, `github.com/pion/turn/v4` (already present), html/template (admin).

## Global Constraints

- Module root is `server/`; import paths `github.com/relayium/relayium/...`. Run `go` from `server/`.
- CGO off; the node stays a single static binary. No new external deps.
- E2E preserved: nodes store only ciphertext; central proxies ciphertext. Do not add server-side plaintext handling.
- Central→node blob transport is HTTP with `Authorization: Bearer <storageSecret>`, constant-time compared (`crypto/subtle.ConstantTimeCompare`). blob `key` stays an opaque unguessable token; `storage.DiskStore` already rejects invalid keys via its `validKey` regex (returns `storage.ErrInvalidKey`).
- Central-side `cappedReader` (`MaxFileSize`) stays the authoritative size cap. `errTooLarge` (account pkg) must remain matchable via `errors.Is` after an upload streamed through a node.
- Placement is uniform-random among eligible nodes; fallback to central local store. No replication (a file lives on exactly one node).
- `nodeOnlineWindow = 90 * time.Second` (defined in `internal/account/turn.go`, SP1) is the online cutoff — reuse it.
- New/changed columns use the existing idempotent-`ALTER` migration idiom (as `download_count` was added to `stored_files`), NOT edits to the SP1 `CREATE TABLE` bodies.

---

## File Structure

**New files:**
- `server/internal/storage/remote.go` (+ `remote_test.go`) — `RemoteBlobStore` (central-side `BlobStore` over HTTP).
- `server/cmd/relayium-node/storage.go` (+ `storage_test.go`) — node blob HTTP server (DiskStore-backed).
- `server/internal/account/sp2_store_test.go` — store-layer tests for the new persistence.
- `server/internal/account/blobfor.go` (+ `blobfor_test.go`) — `blobFor` resolver + `placeUpload`.

**Modified files:**
- `server/internal/account/store.go` — `Node` storage fields; `StoredFile.NodeID`; `PendingNodeDelete`; new Store-interface methods.
- `server/internal/account/sqlite.go` — schema ALTERs, `UpsertNode`/`TouchNode` extended, `StorageNodes`, `GetNode`, `stored_files.node_id` plumbing, `pending_node_deletes` methods.
- `server/internal/account/nodes.go` — register/heartbeat accept + persist storage fields.
- `server/internal/account/files.go` — upload placement + download/delete routing.
- `server/internal/account/gc.go` — per-file blob routing + orphan-queue drain.
- `server/internal/account/service.go` — `nodeHTTP *http.Client` field + wiring.
- `server/internal/account/admin.go` + `admin_templates.go` — storage columns in the Nodes section.
- `server/cmd/relayium-node/main.go` + `state.go` + `relay.go` — storage config, `storageSecret` in state, start blob server, report storage fields.
- `server/main.go` — wire `GC.BlobFor`.

---

## Task 1: `storage.RemoteBlobStore`

Central-side `BlobStore` that proxies to a node's HTTP blob endpoint. Standalone (no account dep).

**Files:**
- Create: `server/internal/storage/remote.go`
- Test: `server/internal/storage/remote_test.go`

**Interfaces:**
- Produces: `func NewRemoteBlobStore(baseURL, secret string, hc *http.Client) *RemoteBlobStore` implementing `BlobStore` (`Put(ctx,key,r)(int64,error)`, `Get`, `Delete`). On a reader error during `Put`, returns that reader's error verbatim (so a wrapped `errTooLarge` stays `errors.Is`-matchable). `Get` maps a node 404 to `storage.ErrNotFound`.

- [ ] **Step 1: Write the failing test**

`server/internal/storage/remote_test.go`:
```go
package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRemotePutGetDelete(t *testing.T) {
	var stored []byte
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		key := strings.TrimPrefix(r.URL.Path, "/blob/")
		if key == "" {
			w.WriteHeader(400)
			return
		}
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			stored = b
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"size":`+itoa(len(b))+`}`)
		case http.MethodGet:
			if stored == nil {
				w.WriteHeader(404)
				return
			}
			_, _ = w.Write(stored)
		case http.MethodDelete:
			stored = nil
			w.WriteHeader(204)
		}
	}))
	defer srv.Close()

	rbs := NewRemoteBlobStore(srv.URL, "sekret", srv.Client())
	ctx := context.Background()

	n, err := rbs.Put(ctx, "abc123", bytes.NewReader([]byte("ciphertext!")))
	if err != nil || n != 11 {
		t.Fatalf("put: n=%d err=%v", n, err)
	}
	if gotAuth != "Bearer sekret" {
		t.Fatalf("auth=%q", gotAuth)
	}
	rc, err := rbs.Get(ctx, "abc123")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "ciphertext!" {
		t.Fatalf("got %q", got)
	}
	if err := rbs.Delete(ctx, "abc123"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := rbs.Get(ctx, "abc123"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
}

// A reader that errors mid-stream must surface that exact error from Put (so a
// wrapped cappedReader errTooLarge stays errors.Is-matchable across the proxy).
func TestRemotePutSurfacesReaderError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = io.WriteString(w, `{"size":0}`)
	}))
	defer srv.Close()
	sentinel := errors.New("boom")
	rbs := NewRemoteBlobStore(srv.URL, "s", srv.Client())
	_, err := rbs.Put(context.Background(), "k", &erroringReader{after: 3, err: sentinel})
	if !errors.Is(err, sentinel) {
		t.Fatalf("want sentinel, got %v", err)
	}
}

type erroringReader struct {
	after int
	err   error
	n     int
}

func (e *erroringReader) Read(p []byte) (int, error) {
	if e.n >= e.after {
		return 0, e.err
	}
	e.n++
	p[0] = 'x'
	return 1, nil
}

func itoa(n int) string {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/storage/ -run TestRemote`
Expected: FAIL — `NewRemoteBlobStore` undefined.

- [ ] **Step 3: Implement `remote.go`**

`server/internal/storage/remote.go`:
```go
package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// RemoteBlobStore is a BlobStore that proxies to a relay node's HTTP blob
// endpoint (central-proxy storage). The payload is E2E ciphertext, so plain HTTP
// is acceptable; requests carry a bearer secret the node validates.
type RemoteBlobStore struct {
	baseURL string
	secret  string
	hc      *http.Client
}

func NewRemoteBlobStore(baseURL, secret string, hc *http.Client) *RemoteBlobStore {
	return &RemoteBlobStore{baseURL: strings.TrimRight(baseURL, "/"), secret: secret, hc: hc}
}

func (r *RemoteBlobStore) url(key string) string { return r.baseURL + "/blob/" + key }

// errCapturingReader records the first error the wrapped reader returns, so Put
// can surface it verbatim even when the HTTP transport masks it.
type errCapturingReader struct {
	r   io.Reader
	err error
}

func (e *errCapturingReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF && e.err == nil {
		e.err = err
	}
	return n, err
}

func (r *RemoteBlobStore) Put(ctx context.Context, key string, body io.Reader) (int64, error) {
	er := &errCapturingReader{r: body}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, r.url(key), er)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	resp, err := r.hc.Do(req)
	if er.err != nil {
		return 0, er.err // the source reader failed (e.g. cappedReader errTooLarge) — surface it verbatim
	}
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return 0, fmt.Errorf("remote blob put %s: status %d: %s", key, resp.StatusCode, string(b))
	}
	var out struct {
		Size int64 `json:"size"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.Size, nil
}

func (r *RemoteBlobStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url(key), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	resp, err := r.hc.Do(req)
	if err != nil {
		return nil, err // unreachable node — caller maps to 503
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("remote blob get %s: status %d", key, resp.StatusCode)
	}
	return resp.Body, nil // caller closes
}

func (r *RemoteBlobStore) Delete(ctx context.Context, key string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, r.url(key), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.secret)
	resp, err := r.hc.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("remote blob delete %s: status %d", key, resp.StatusCode)
	}
	return nil // 404 is success (idempotent)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/storage/ -run TestRemote`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/storage/remote.go server/internal/storage/remote_test.go
git commit -m "feat(storage): RemoteBlobStore — central-side blob proxy over HTTP"
```

---

## Task 2: SP2 persistence layer (nodes storage cols, stored_files.node_id, pending queue)

**Files:**
- Modify: `server/internal/account/store.go` (struct fields + interface methods)
- Modify: `server/internal/account/sqlite.go` (schema ALTERs + implementations)
- Test: `server/internal/account/sp2_store_test.go`

**Interfaces:**
- Produces:
  - `Node` gains: `StorageURL, StorageSecret string; StorageEnabled bool; StorageTotal, StorageFree int64`.
  - `StoredFile` gains: `NodeID string`.
  - `type PendingNodeDelete struct { BlobKey, NodeID string; EnqueuedAt int64 }`.
  - `UpsertNode` now also persists the storage fields (from `Node`). `TouchNode` signature becomes `TouchNode(ctx, id string, relayedBytes, storedBytes, storageTotal, storageFree, at int64) error` (keep-MAX bytes; SET storage_total/storage_free — they are not monotonic).
  - `GetNode(ctx, id string) (Node, bool, error)`.
  - `StorageNodes(ctx, since, minFree int64) ([]Node, error)` — `owner_type='fleet' AND storage_enabled=1 AND last_seen_at >= since AND storage_free >= minFree`.
  - `EnqueueNodeDelete(ctx, blobKey, nodeID string, at int64) error`, `ListPendingNodeDeletes(ctx) ([]PendingNodeDelete, error)`, `DeletePendingNodeDelete(ctx, blobKey, nodeID string) error`.
  - `CreateStoredFile`/`GetStoredFile`/`ListStoredFilesByUser`/`ListExpiredStoredFiles` round-trip `NodeID`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/sp2_store_test.go`:
```go
package account

import (
	"context"
	"testing"
)

func TestNodeStorageFieldsAndStorageNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	// Storage-enabled node with 10 GiB free.
	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		StorageEnabled: true, StorageURL: "http://1.2.3.4:8081", StorageSecret: "ss",
		StorageTotal: 20 << 30, StorageFree: 10 << 30, CreatedAt: 1, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, ok, err := st.GetNode(ctx, n.ID)
	if err != nil || !ok || got.StorageURL != "http://1.2.3.4:8081" || got.StorageSecret != "ss" || !got.StorageEnabled {
		t.Fatalf("getnode: %+v ok=%v err=%v", got, ok, err)
	}
	// TouchNode updates free/total (not monotonic) and keep-maxes stored_bytes.
	if err := st.TouchNode(ctx, n.ID, 0, 500, 20<<30, 8<<30, 2000); err != nil {
		t.Fatalf("touch: %v", err)
	}
	// Eligible: online since 1500, needs >= 4 GiB free (has 8).
	nodes, err := st.StorageNodes(ctx, 1500, 4<<30)
	if err != nil || len(nodes) != 1 || nodes[0].StorageFree != 8<<30 {
		t.Fatalf("storagenodes: %+v err=%v", nodes, err)
	}
	// Excluded when minFree too high.
	if got, _ := st.StorageNodes(ctx, 1500, 9<<30); len(got) != 0 {
		t.Fatal("node with 8GiB free must be excluded for minFree=9GiB")
	}
	// Excluded when offline.
	if got, _ := st.StorageNodes(ctx, 3000, 0); len(got) != 0 {
		t.Fatal("stale node must be excluded")
	}
}

func TestStoredFileNodeIDRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "u@x.com", "u")
	f := StoredFile{ID: "f1", UserID: u.ID, BlobKey: "bk", EncManifest: []byte("m"),
		Size: 10, CreatedAt: 1, ExpiresAt: 9999999999, NodeID: "node-7"}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := st.GetStoredFile(ctx, "f1")
	if err != nil || got.NodeID != "node-7" {
		t.Fatalf("got NodeID=%q err=%v", got.NodeID, err)
	}
	// A row created without NodeID reads back as "" (central-local).
	f2 := StoredFile{ID: "f2", UserID: u.ID, BlobKey: "bk2", EncManifest: []byte("m"), Size: 1, CreatedAt: 1, ExpiresAt: 9999999999}
	st.CreateStoredFile(ctx, f2)
	g2, _ := st.GetStoredFile(ctx, "f2")
	if g2.NodeID != "" {
		t.Fatalf("want empty NodeID, got %q", g2.NodeID)
	}
}

func TestPendingNodeDeletes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if err := st.EnqueueNodeDelete(ctx, "bk1", "node-7", 100); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	st.EnqueueNodeDelete(ctx, "bk2", "node-7", 101)
	list, err := st.ListPendingNodeDeletes(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("list: %+v err=%v", list, err)
	}
	if err := st.DeletePendingNodeDelete(ctx, "bk1", "node-7"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if list, _ := st.ListPendingNodeDeletes(ctx); len(list) != 1 || list[0].BlobKey != "bk2" {
		t.Fatalf("after delete: %+v", list)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'NodeStorage|StoredFileNodeID|PendingNodeDeletes'`
Expected: FAIL — new fields/methods undefined.

- [ ] **Step 3: Extend structs + interface (`store.go`)**

Add to the `Node` struct:
```go
	StorageURL     string
	StorageSecret  string
	StorageEnabled bool
	StorageTotal   int64
	StorageFree    int64
```
Add to the `StoredFile` struct:
```go
	NodeID string // "" = central-local blob; else the relay node holding the ciphertext
```
Add near the other row types:
```go
// PendingNodeDelete is a blob whose owning node was unreachable when its file
// expired/was deleted; GC retries the node DELETE each sweep until it succeeds,
// reclaiming the orphan under the no-replication model.
type PendingNodeDelete struct {
	BlobKey    string
	NodeID     string
	EnqueuedAt int64
}
```
In the `Store` interface, change the `TouchNode` line and add the new methods (near the SP1 node methods):
```go
	TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, storageTotal, storageFree, at int64) error
	GetNode(ctx context.Context, id string) (Node, bool, error)
	StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error)
	EnqueueNodeDelete(ctx context.Context, blobKey, nodeID string, at int64) error
	ListPendingNodeDeletes(ctx context.Context) ([]PendingNodeDelete, error)
	DeletePendingNodeDelete(ctx context.Context, blobKey, nodeID string) error
```

- [ ] **Step 4: Schema ALTERs + `stored_files.node_id` + `pending_node_deletes` (`sqlite.go`)**

In the idempotent-migration section (where `download_count` is added to `stored_files`), add (each ALTER wrapped in the same ignore-duplicate-column idiom the file already uses):
```sql
ALTER TABLE nodes ADD COLUMN storage_url TEXT
ALTER TABLE nodes ADD COLUMN storage_secret TEXT
ALTER TABLE nodes ADD COLUMN storage_enabled INTEGER NOT NULL DEFAULT 0
ALTER TABLE nodes ADD COLUMN storage_total INTEGER NOT NULL DEFAULT 0
ALTER TABLE nodes ADD COLUMN storage_free INTEGER NOT NULL DEFAULT 0
ALTER TABLE stored_files ADD COLUMN node_id TEXT
```
Add a new table to the `CREATE TABLE IF NOT EXISTS` schema block:
```sql
CREATE TABLE IF NOT EXISTS pending_node_deletes (
  blob_key    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (blob_key, node_id)
);
```

- [ ] **Step 5: Extend `UpsertNode`/`TouchNode`, add `GetNode`/`StorageNodes` (`sqlite.go`)**

Update the `queryNodes` SELECT column list and scan to include the 5 storage columns (append after the SP1 columns in a fixed order), and extend `UpsertNode` INSERT + `ON CONFLICT DO UPDATE` and `TouchNode`. Concretely, the node column list becomes:
```go
const nodeCols = `id, owner_type, owner_user_id, region, urls, turn_secret, version,
  relayed_bytes, stored_bytes, created_at, last_seen_at,
  storage_url, storage_secret, storage_enabled, storage_total, storage_free`
```
Use `nodeCols` in `UpsertNode` INSERT, `GetNode`, `StorageNodes`, `ListNodes`, `OnlineNodes` SELECTs, and have `queryNodes`/scan read all 16 columns (add `storage_enabled` via an int scan → bool). `UpsertNode`'s `ON CONFLICT(id) DO UPDATE SET` adds `storage_url=excluded.storage_url, storage_secret=excluded.storage_secret, storage_enabled=excluded.storage_enabled, storage_total=excluded.storage_total, storage_free=excluded.storage_free` (still NOT clobbering created_at / relayed_bytes / stored_bytes).
```go
func (s *SQLiteStore) TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, storageTotal, storageFree, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET last_seen_at=?,
		   relayed_bytes=MAX(relayed_bytes, ?), stored_bytes=MAX(stored_bytes, ?),
		   storage_total=?, storage_free=? WHERE id=?`,
		at, relayedBytes, storedBytes, storageTotal, storageFree, id)
	return err
}

func (s *SQLiteStore) GetNode(ctx context.Context, id string) (Node, bool, error) {
	nodes, err := s.queryNodes(ctx, `SELECT `+nodeCols+` FROM nodes WHERE id = ?`, id)
	if err != nil {
		return Node{}, false, err
	}
	if len(nodes) == 0 {
		return Node{}, false, nil
	}
	return nodes[0], true, nil
}

func (s *SQLiteStore) StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes
		   WHERE owner_type='fleet' AND storage_enabled=1 AND last_seen_at >= ? AND storage_free >= ?
		   ORDER BY last_seen_at DESC`, since, minFree)
}
```
(Update `queryNodes`'s scan to read the 5 new columns; `storage_enabled` scans into an `int` → `n.StorageEnabled = v != 0`. `storage_url`/`storage_secret` are `TEXT` — scan via `sql.NullString` and assign `.String`, since older rows may be NULL.)

- [ ] **Step 6: `stored_files.node_id` plumbing (`sqlite.go`)**

Add `node_id` to `storedFileCols` (append after `downloaded_at`):
```go
const storedFileCols = `id, user_id, blob_key, enc_manifest, size, burn_after_read, created_at, expires_at, downloaded_at, node_id`
```
(so `storedFileSelectCols` = that + `, download_count`). Update `scanStoredFile` to scan `node_id` between `downloaded_at` and `download_count`, via `sql.NullString` (older rows are NULL → `""`):
```go
func scanStoredFile(sc rowScanner) (StoredFile, error) {
	var f StoredFile
	var burn int
	var nodeID sql.NullString
	err := sc.Scan(&f.ID, &f.UserID, &f.BlobKey, &f.EncManifest, &f.Size,
		&burn, &f.CreatedAt, &f.ExpiresAt, &f.DownloadedAt, &nodeID, &f.DownloadCount)
	f.BurnAfterRead = burn != 0
	f.NodeID = nodeID.String
	return f, err
}
```
Update `CreateStoredFile` INSERT to 10 value placeholders and pass `nullStr(f.NodeID)` as the last value (`nullStr` from SP1 stores "" as NULL).

- [ ] **Step 7: `pending_node_deletes` methods (`sqlite.go`)**

```go
func (s *SQLiteStore) EnqueueNodeDelete(ctx context.Context, blobKey, nodeID string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pending_node_deletes (blob_key, node_id, enqueued_at) VALUES (?,?,?)
		 ON CONFLICT(blob_key, node_id) DO NOTHING`, blobKey, nodeID, at)
	return err
}

func (s *SQLiteStore) ListPendingNodeDeletes(ctx context.Context) ([]PendingNodeDelete, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT blob_key, node_id, enqueued_at FROM pending_node_deletes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingNodeDelete
	for rows.Next() {
		var p PendingNodeDelete
		if err := rows.Scan(&p.BlobKey, &p.NodeID, &p.EnqueuedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) DeletePendingNodeDelete(ctx context.Context, blobKey, nodeID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE blob_key=? AND node_id=?`, blobKey, nodeID)
	return err
}
```

- [ ] **Step 8: Fix SP1 call sites for the new `TouchNode` signature**

The SP1 heartbeat handler and `TestTouchNodeKeepMaxAndOnline` call the old 5-arg `TouchNode`. Update them to the new 7-arg form. In `TestTouchNodeKeepMaxAndOnline` (SP1 `nodes_store_test.go`), pass `0, 0` for the two new storage args, e.g. `st.TouchNode(ctx, n.ID, 500, 0, 0, 0, 2000)`. (The heartbeat handler is updated in Task 3.)

- [ ] **Step 9: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'NodeStorage|StoredFileNodeID|PendingNodeDeletes|TouchNode' && go build ./...`
Expected: PASS + clean build (interface + impl in sync).

- [ ] **Step 10: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sp2_store_test.go server/internal/account/nodes_store_test.go
git commit -m "feat(account): SP2 persistence — node storage cols, stored_files.node_id, pending-delete queue"
```

---

## Task 3: central register/heartbeat storage fields

**Files:**
- Modify: `server/internal/account/nodes.go`
- Test: `server/internal/account/nodes_test.go` (extend)

**Interfaces:**
- Consumes: `Node` storage fields, extended `TouchNode` (Task 2).
- Produces: `nodeRegisterReq` gains `StorageURL, StorageSecret string; StorageTotal, StorageFree int64` and uses `Capabilities` to set `StorageEnabled`; `nodeHeartbeatReq` gains `StorageTotal, StorageFree int64` (it already has `StoredBytes`).

- [ ] **Step 1: Write the failing test**

Add to `server/internal/account/nodes_test.go`:
```go
func TestNodeRegisterStorageFields(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)
	body, _ := json.Marshal(nodeRegisterReq{
		TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Capabilities: []string{"relay", "storage"},
		StorageURL: "http://1.2.3.4:8081", StorageSecret: "ss", StorageTotal: 20 << 30, StorageFree: 10 << 30,
	})
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register: %d", w.Code)
	}
	var resp nodeRegisterResp
	json.Unmarshal(w.Body.Bytes(), &resp)
	got, ok, _ := s.store.GetNode(context.Background(), resp.NodeID)
	if !ok || !got.StorageEnabled || got.StorageURL != "http://1.2.3.4:8081" || got.StorageFree != 10<<30 {
		t.Fatalf("persisted node = %+v ok=%v", got, ok)
	}
}
```
(Add `"context"` to the test imports if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestNodeRegisterStorage`
Expected: FAIL — fields not persisted / struct fields missing.

- [ ] **Step 3: Extend request structs + handlers**

In `nodes.go`, add to `nodeRegisterReq`:
```go
	StorageURL    string `json:"storageURL"`
	StorageSecret string `json:"storageSecret"`
	StorageTotal  int64  `json:"storageTotal"`
	StorageFree   int64  `json:"storageFree"`
```
Add to `nodeHeartbeatReq`:
```go
	StorageTotal int64 `json:"storageTotal"`
	StorageFree  int64 `json:"storageFree"`
```
In `handleNodeRegister`, set the storage fields on the `Node` and derive `StorageEnabled`:
```go
	n := Node{
		ID: req.NodeID, OwnerType: "fleet", Region: req.Region, URLs: req.URLs,
		TURNSecret: req.TURNSecret, Version: req.Version, CreatedAt: now, LastSeenAt: now,
		StorageURL: req.StorageURL, StorageSecret: req.StorageSecret,
		StorageEnabled: containsCap(req.Capabilities, "storage"),
		StorageTotal:   req.StorageTotal, StorageFree: req.StorageFree,
	}
```
Add the helper:
```go
func containsCap(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}
```
In `handleNodeHeartbeat`, pass the new args to `TouchNode`:
```go
	if err := s.store.TouchNode(r.Context(), req.NodeID, req.RelayedTotal, req.StoredBytes, req.StorageTotal, req.StorageFree, now); err != nil {
```

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./internal/account/ -run TestNode && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/nodes.go server/internal/account/nodes_test.go
git commit -m "feat(account): node register/heartbeat carry storage URL/secret/free/total"
```

---

## Task 4: `blobFor` resolver + `placeUpload`

**Files:**
- Create: `server/internal/account/blobfor.go`
- Test: `server/internal/account/blobfor_test.go`
- Modify: `server/internal/account/service.go` (add `nodeHTTP *http.Client`, `pickN func(int) int`)

**Interfaces:**
- Consumes: `storage.NewRemoteBlobStore` (Task 1); `store.GetNode`, `store.StorageNodes` (Task 2); existing `s.blobs` (local DiskStore).
- Produces:
  - `func (s *Service) blobFor(ctx context.Context, nodeID string) (storage.BlobStore, error)` — `nodeID==""` → `s.blobs`; else `GetNode`; missing/disabled node → error; else `RemoteBlobStore`.
  - `func (s *Service) placeUpload(ctx context.Context) (nodeID string, bs storage.BlobStore)` — pick a random eligible `StorageNodes` node (headroom = `MaxFileSize`); none → `("", s.blobs)`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/blobfor_test.go`:
```go
package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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

	// No storage nodes -> central fallback ("", local blobs).
	id, _ := s.placeUpload(ctx)
	if id != "" {
		t.Fatalf("want central fallback, got node %q", id)
	}

	// One eligible node -> chosen.
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: "http://x:8081", StorageSecret: "ss", StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: 1000})
	id, _ = s.placeUpload(ctx)
	if id != n.ID {
		t.Fatalf("want node %q, got %q", n.ID, id)
	}
}
```
NOTE: delete the bogus `itoaAcct` line above and just use `intToStr` in `fakeNode` (the reviewer will catch dead code — write `io.WriteString(w, `{"size":`+intToStr(len(b))+`}`)` directly). Keep only `intToStr`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'BlobFor|PlaceUpload'`
Expected: FAIL — `blobFor`/`placeUpload`/`nodeHTTP`/`pickN` undefined.

- [ ] **Step 3: Add Service fields + defaults (`service.go`)**

Add fields to `Service`:
```go
	nodeHTTP *http.Client        // central→node blob calls
	pickN    func(int) int       // random index in [0,n); injectable for tests
```
In `NewService`, initialize defaults (after the struct is built):
```go
	s.nodeHTTP = &http.Client{Transport: &http.Transport{
		ResponseHeaderTimeout: 15 * time.Second,
		// no total timeout: blob bodies are large streams
	}}
	s.pickN = func(n int) int {
		if n <= 0 {
			return 0
		}
		b := make([]byte, 8)
		_, _ = rand.Read(b)
		return int(binary.BigEndian.Uint64(b) % uint64(n))
	}
```
(Ensure `crypto/rand` as `rand` and `encoding/binary` and `net/http`/`time` are imported in service.go; if `rand` already refers to something, alias as `crand`.)

- [ ] **Step 4: Implement `blobfor.go`**

```go
package account

import (
	"context"
	"fmt"

	"github.com/relayium/relayium/internal/storage"
)

// blobFor returns the blob store holding (or to hold) a file with the given
// node_id: the local DiskStore for "" (central-local), else a RemoteBlobStore
// pointed at the node's storage endpoint.
func (s *Service) blobFor(ctx context.Context, nodeID string) (storage.BlobStore, error) {
	if nodeID == "" {
		return s.blobs, nil
	}
	n, ok, err := s.store.GetNode(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	if !ok || !n.StorageEnabled || n.StorageURL == "" {
		return nil, fmt.Errorf("node %s has no storage endpoint", nodeID)
	}
	return storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP), nil
}

// placeUpload chooses where a new upload's ciphertext should land: a random
// eligible storage node, or central-local ("") when none is available. Headroom
// is one MaxFileSize so a near-full node is not chosen.
func (s *Service) placeUpload(ctx context.Context) (string, storage.BlobStore) {
	minFree := s.resolveSettings(ctx).MaxFileSize
	since := s.now().Add(-nodeOnlineWindow).Unix()
	nodes, err := s.store.StorageNodes(ctx, since, minFree)
	if err != nil {
		log.Printf("placeUpload: StorageNodes read failed: %v (using central)", err)
	}
	if len(nodes) == 0 {
		return "", s.blobs
	}
	n := nodes[s.pickN(len(nodes))]
	return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP)
}
```

- [ ] **Step 5: Run tests + build** (fix the `intToStr`/`itoaAcct` dead-code note in the test first)

Run: `cd server && go test ./internal/account/ -run 'BlobFor|PlaceUpload' && go build ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/blobfor.go server/internal/account/blobfor_test.go server/internal/account/service.go
git commit -m "feat(account): blobFor resolver + random placeUpload node selection"
```

> Test helpers `fakeNode(t, map)` and `intToStr` defined in `blobfor_test.go` are reused by Tasks 5 and 6 (same package) — do NOT redefine them there.

---

## Task 5: upload routing through the placed node

**Files:**
- Modify: `server/internal/account/files.go` (`handleUploadFile`)
- Test: `server/internal/account/files_upload_test.go`

**Interfaces:**
- Consumes: `placeUpload` (Task 4); `StoredFile.NodeID` (Task 2).

- [ ] **Step 1: Write the failing test**

`server/internal/account/files_upload_test.go` — reuse the existing file-test harness
(`newFileServerWithQuota`, `loginCookie`, `postUpload`, `uploadBody`, `decodeJSON` in
`files_test.go`/`files_minbill_test.go`) plus `fakeNode` from `blobfor_test.go`. Register a
single online storage node whose `StorageURL` is a fake node; since it is the only eligible
node, `placeUpload` picks it deterministically (`pickN(1)==0`). Assert the upload's
`StoredFile.NodeID` is that node and the ciphertext reached the fake node's map:
```go
package account

import (
	"context"
	"testing"
	"time"
)

func TestUploadRoutesToNode(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 1<<20, 1<<20)
	ctx := context.Background()

	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	n, _ := store.UpsertNode(ctx, Node{
		OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss",
		StorageFree: 100 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	})

	cookie := loginCookie(t, ts, mail, "up@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("ciphertext")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	sf, err := store.GetStoredFile(ctx, up.ID)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if sf.NodeID != n.ID {
		t.Fatalf("StoredFile.NodeID = %q, want node %q", sf.NodeID, n.ID)
	}
	if string(nodeStore[sf.BlobKey]) != "ciphertext" {
		t.Fatalf("node did not receive ciphertext under key %q: %q", sf.BlobKey, nodeStore[sf.BlobKey])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUploadRoutesToNode`
Expected: FAIL — upload still writes to local `s.blobs`.

- [ ] **Step 3: Decide placement early; gate the central-disk cap on local placement**

The M3b global-disk-cap check (files.go ~71-78) protects the CENTRAL volume; it must NOT block an upload that will be routed to a node (which never touches central disk). So decide placement first and apply the M3b check only when the file lands centrally.

Move the placement decision to just after the `uploadSem` acquire/defer (top of the handler, before the M3b block):
```go
	nodeID, bs := s.placeUpload(r.Context())
```
Wrap the existing M3b `if s.diskUsage != nil && s.blobDiskMax > 0 { ... }` block in a local-placement guard:
```go
	if nodeID == "" && s.diskUsage != nil && s.blobDiskMax > 0 {
		// central-local placement only: node-routed uploads don't touch central disk
		... existing M3b body ...
	}
```
Then change the blob write from `s.blobs.Put` to the placed store:
```go
	blobKey := randToken()
	capped := &cappedReader{r: br, max: st.MaxFileSize}
	size, err := bs.Put(r.Context(), blobKey, capped)
```
Change every rollback `s.blobs.Delete(r.Context(), blobKey)` in this handler (the ReserveUpload-failed and CreateStoredFile-failed paths) to `bs.Delete(r.Context(), blobKey)`. Set `NodeID: nodeID` on the `StoredFile` literal:
```go
	sf := StoredFile{
		ID: id, UserID: u.ID, BlobKey: blobKey, EncManifest: encManifest,
		Size: size, BurnAfterRead: burn, CreatedAt: now, ExpiresAt: now + ttl, NodeID: nodeID,
	}
```
The `errors.Is(err, errTooLarge)` check after `Put` is unchanged — `RemoteBlobStore.Put` surfaces the reader's `errTooLarge` verbatim (Task 1). Keep the top `if s.blobs == nil { 503 }` guard: `placeUpload` falls back to `s.blobs` (possibly nil) only when no nodes exist, and the guard already rejects that no-storage-at-all case before this point. (A deployment with nil local store but live storage nodes is out of scope for v1 — central always has a local blob dir in practice.)

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'Upload|TestICE' && go build ./...`
Expected: PASS (upload routing + no regression to other file tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/files.go server/internal/account/files_upload_test.go
git commit -m "feat(account): route uploads to a placed storage node, record node_id"
```

---

## Task 6: download + delete routing

**Files:**
- Modify: `server/internal/account/files.go` (`handleFileBlob`, `handleDeleteFile`)
- Test: `server/internal/account/files_download_test.go`

**Interfaces:**
- Consumes: `blobFor` (Task 4); `EnqueueNodeDelete` (Task 2); `storage.ErrNotFound`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/files_download_test.go` — reuse `newFileServerWithQuota` + `fakeNode`.
Cover: (a) a remote-node file downloads (200, bytes match); (b) node offline (a fake node that
was `Close()`d → connection refused) → **503**, not 404; (c) a burn file on an offline node is
NOT consumed (row still present after the 503). Seed rows directly via `CreateStoredFile` and
the node via `UpsertNode`; drive the public `GET /api/files/{id}/blob` route through the test
server:
```go
package account

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

func getBlob(t *testing.T, ts *httptest.Server, id string) *http.Response {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/files/" + id + "/blob")
	if err != nil {
		t.Fatalf("get blob: %v", err)
	}
	return resp
}

func TestDownloadRoutesAndOffline(t *testing.T) {
	ts, _, store, _ := newFileServerWithQuota(t, 1<<20, 1<<20)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "dl@example.com", "")

	// (a) reachable node serves the blob.
	nodeStore := map[string][]byte{"bk1": []byte("plainish-ciphertext")}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	n, _ := store.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss", StorageFree: 1 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix()})
	store.CreateStoredFile(ctx, StoredFile{ID: "f1", UserID: u.ID, BlobKey: "bk1", EncManifest: []byte("m"),
		Size: int64(len(nodeStore["bk1"])), CreatedAt: 1, ExpiresAt: time.Now().Unix() + 3600, NodeID: n.ID})
	resp := getBlob(t, ts, "f1")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "plainish-ciphertext" {
		t.Fatalf("reachable download: %d %q", resp.StatusCode, body)
	}

	// (b)+(c) offline node -> 503, and a burn file is NOT consumed.
	off := fakeNode(t, map[string][]byte{})
	offURL := off.URL
	off.Close() // now unreachable
	no, _ := store.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:y:3478"}, TURNSecret: "t",
		StorageEnabled: true, StorageURL: offURL, StorageSecret: "ss", StorageFree: 1 << 30, CreatedAt: 1, LastSeenAt: time.Now().Unix()})
	store.CreateStoredFile(ctx, StoredFile{ID: "f2", UserID: u.ID, BlobKey: "bk2", EncManifest: []byte("m"),
		Size: 5, BurnAfterRead: true, CreatedAt: 1, ExpiresAt: time.Now().Unix() + 3600, NodeID: no.ID})
	r2 := getBlob(t, ts, "f2")
	r2.Body.Close()
	if r2.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("offline node: want 503, got %d", r2.StatusCode)
	}
	if _, err := store.GetStoredFile(ctx, "f2"); err != nil {
		t.Fatalf("burn file on offline node must NOT be consumed, but row is gone: %v", err)
	}
}
```
(Add `"net/http/httptest"` to the imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestDownloadRoutesAndOffline`
Expected: FAIL — still reads local `s.blobs`.

- [ ] **Step 3: Route download; 503 on offline; open-then-claim for burn**

Rewrite the body of `handleFileBlob` after `sf` is fetched so it resolves the store, opens the reader FIRST, maps errors, then does the burn claim:
```go
	bs, err := s.blobFor(r.Context(), sf.NodeID)
	if err != nil {
		http.Error(w, "storage node unavailable", http.StatusServiceUnavailable)
		return
	}
	rc, err := bs.Get(r.Context(), sf.BlobKey)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		// Node exists but is unreachable: the file's single copy is offline.
		http.Error(w, "storage node offline, try again later", http.StatusServiceUnavailable)
		return
	}
	defer rc.Close()

	// Burn-after-read: claim the single download only AFTER the blob opened, so an
	// offline node never burns the shot. Concurrent GETs race on ClaimBurnDownload;
	// only the winner streams, the rest 404.
	if sf.BurnAfterRead {
		claimed, cerr := s.store.ClaimBurnDownload(r.Context(), sf.ID, s.now().Unix())
		if cerr != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !claimed {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(sf.Size, 10))
	n, err := io.Copy(w, rc)
	if err != nil || n != sf.Size {
		return
	}
	_ = s.store.AddDownloadStat(r.Context(), sf.UserID, sf.Size)
	_ = s.store.RecordMeter(r.Context(), sf.UserID, MeterDownload, sf.Size, s.now().Unix())
	if sf.BurnAfterRead {
		_ = bs.Delete(r.Context(), sf.BlobKey)
		_ = s.store.DeleteStoredFile(r.Context(), sf.ID)
	} else {
		_ = s.store.IncDownloadCount(r.Context(), sf.ID)
	}
```
Add `"errors"` and the `storage` import to files.go if not present. (The top `if s.blobs == nil` guard stays.)

- [ ] **Step 4: Route delete; enqueue on unreachable node**

In `handleDeleteFile`, replace `s.blobs.Delete` with the routed store, enqueuing an orphan-retry when the node can't be reached:
```go
	if bs, berr := s.blobFor(r.Context(), sf.NodeID); berr == nil {
		if derr := bs.Delete(r.Context(), sf.BlobKey); derr != nil {
			// Node unreachable: record the orphan so GC retries; still remove the row.
			_ = s.store.EnqueueNodeDelete(r.Context(), sf.BlobKey, sf.NodeID, s.now().Unix())
		}
	} else {
		_ = s.store.EnqueueNodeDelete(r.Context(), sf.BlobKey, sf.NodeID, s.now().Unix())
	}
	if err := s.store.DeleteStoredFile(r.Context(), sf.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
```
(A `nodeID==""` local delete never errors on unreachability; a local Delete error still enqueues but with `node_id=""`, which GC's drain will retry harmlessly against the local store.)

- [ ] **Step 5: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'Download|Delete|Upload' && go build ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/files.go server/internal/account/files_download_test.go
git commit -m "feat(account): route download/delete by node_id; 503 on offline; open-then-claim burn"
```

---

## Task 7: GC per-file routing + orphan-queue drain

**Files:**
- Modify: `server/internal/account/gc.go`
- Modify: `server/main.go` (wire `GC.BlobFor`)
- Test: `server/internal/account/gc_nodes_test.go`

**Interfaces:**
- Consumes: `blobFor` (Task 4); `EnqueueNodeDelete`/`ListPendingNodeDeletes`/`DeletePendingNodeDelete` (Task 2).
- Produces: `GC.BlobFor func(ctx, nodeID) (storage.BlobStore, error)` field.

- [ ] **Step 1: Write the failing test**

`server/internal/account/gc_nodes_test.go` — an expired file on an offline node: `sweep` enqueues a `pending_node_deletes` row and deletes the `stored_files` row; then with the node reachable (fake node), a second `sweep` drains the queue (node DELETE succeeds → `pending_node_deletes` empty). Build a `GC` with `Store`, `Now`, `Log`, and a `BlobFor` that returns a `RemoteBlobStore` for the node (or an error/unreachable store when "offline").

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestGCOrphanQueue`
Expected: FAIL — `GC.BlobFor` / drain undefined.

- [ ] **Step 3: Add `BlobFor` to GC and route deletes + drain**

In `gc.go`, add the field to the `GC` struct:
```go
	// BlobFor resolves the blob store for a file's node_id (central-local or a
	// remote node). When nil, GC falls back to Blobs (SP1 behavior).
	BlobFor func(ctx context.Context, nodeID string) (storage.BlobStore, error)
```
In `sweep`, replace the expired-file delete loop and add a drain pass:
```go
	for _, f := range expired {
		if err := g.deleteBlob(ctx, f.NodeID, f.BlobKey); err != nil {
			_ = g.Store.EnqueueNodeDelete(ctx, f.BlobKey, f.NodeID, now)
		}
		if err := g.Store.DeleteStoredFile(ctx, f.ID); err != nil {
			g.Log.Printf("gc: delete file %s: %v", f.ID, err)
		}
	}
	g.drainPending(ctx)
```
Add the helpers:
```go
func (g *GC) deleteBlob(ctx context.Context, nodeID, blobKey string) error {
	if g.BlobFor != nil {
		bs, err := g.BlobFor(ctx, nodeID)
		if err != nil {
			return err
		}
		return bs.Delete(ctx, blobKey)
	}
	if g.Blobs != nil {
		return g.Blobs.Delete(ctx, blobKey) // SP1 fallback
	}
	return nil
}

// drainPending retries orphaned node deletes recorded when a node was
// unreachable at expiry; each success clears its row, each failure stays queued.
func (g *GC) drainPending(ctx context.Context) {
	pend, err := g.Store.ListPendingNodeDeletes(ctx)
	if err != nil {
		g.Log.Printf("gc: list pending node deletes: %v", err)
		return
	}
	for _, p := range pend {
		if err := g.deleteBlob(ctx, p.NodeID, p.BlobKey); err != nil {
			continue // node still unreachable; retry next sweep
		}
		if err := g.Store.DeletePendingNodeDelete(ctx, p.BlobKey, p.NodeID); err != nil {
			g.Log.Printf("gc: clear pending delete %s@%s: %v", p.BlobKey, p.NodeID, err)
		}
	}
}
```
Add the `storage` and `context` imports to gc.go if not present, and the `Store` interface used by GC must include the pending methods (it embeds `account.Store`, which Task 2 extended — verify GC's `Store` field type carries them).

- [ ] **Step 4: Wire `GC.BlobFor` in `main.go`**

Where the `GC` is constructed (`gc := &account.GC{...}`), add:
```go
		BlobFor: acct.BlobForPublic,
```
and expose a public wrapper in `blobfor.go` (GC lives in the same package, so it can call `blobFor` directly — prefer that; only add a public wrapper if `main.go` needs it). Since `GC` is in the `account` package, set `BlobFor: acct.blobFor` is not accessible from main (unexported). Simplest: in `main.go` the GC is already built inside the account-aware block; set the field with a closure `func(ctx context.Context, nodeID string) (storage.BlobStore, error) { return acct.blobFor(ctx, nodeID) }` — but `blobFor` is unexported and `main` is a different package. Therefore add ONE exported method in `blobfor.go`:
```go
// BlobForNode is the exported resolver GC (wired from main) uses.
func (s *Service) BlobForNode(ctx context.Context, nodeID string) (storage.BlobStore, error) {
	return s.blobFor(ctx, nodeID)
}
```
and in `main.go`: `BlobFor: acct.BlobForNode,`.

- [ ] **Step 5: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'GC' && go build ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/gc.go server/internal/account/blobfor.go server/internal/account/gc_nodes_test.go server/main.go
git commit -m "feat(account): GC routes blob deletes by node_id + drains orphan retry queue"
```

---

## Task 8: node blob HTTP server

**Files:**
- Create: `server/cmd/relayium-node/storage.go`
- Test: `server/cmd/relayium-node/storage_test.go`
- Modify: `server/cmd/relayium-node/main.go` (storage config), `server/cmd/relayium-node/state.go` (`storageSecret`)

**Interfaces:**
- Consumes: `storage.DiskStore`, `storage.ErrNotFound`, `storage.ErrInvalidKey`.
- Produces: `func newBlobHandler(ds *storage.DiskStore, secret string) http.Handler` serving `PUT/GET/DELETE /blob/{key}` with bearer auth; `config` gains `StorageDir string; StoragePort int`; `nodeState` gains `StorageSecret string` (generated on first load alongside `TURNSecret`).

- [ ] **Step 1: Write the failing test**

`server/cmd/relayium-node/storage_test.go`:
```go
package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

func TestBlobHandlerRoundTripAndAuth(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatalf("diskstore: %v", err)
	}
	h := newBlobHandler(ds, "nodesecret")
	srv := httptest.NewServer(h)
	defer srv.Close()

	put := func(auth string) int {
		req, _ := http.NewRequest("PUT", srv.URL+"/blob/abc123", bytes.NewReader([]byte("cipher")))
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, _ := http.DefaultClient.Do(req)
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if code := put(""); code != http.StatusUnauthorized {
		t.Fatalf("no auth: %d", code)
	}
	if code := put("Bearer wrong"); code != http.StatusUnauthorized {
		t.Fatalf("wrong auth: %d", code)
	}
	if code := put("Bearer nodesecret"); code != http.StatusOK {
		t.Fatalf("good auth put: %d", code)
	}

	req, _ := http.NewRequest("GET", srv.URL+"/blob/abc123", nil)
	req.Header.Set("Authorization", "Bearer nodesecret")
	resp, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "cipher" {
		t.Fatalf("get: %d %q", resp.StatusCode, body)
	}

	// Path-traversal / invalid key rejected (DiskStore.validKey).
	bad, _ := http.NewRequest("GET", srv.URL+"/blob/..%2f..%2fetc", nil)
	bad.Header.Set("Authorization", "Bearer nodesecret")
	br, _ := http.DefaultClient.Do(bad)
	br.Body.Close()
	if br.StatusCode == 200 {
		t.Fatalf("traversal key must not 200")
	}

	// DELETE is idempotent.
	del, _ := http.NewRequest("DELETE", srv.URL+"/blob/abc123", nil)
	del.Header.Set("Authorization", "Bearer nodesecret")
	dr, _ := http.DefaultClient.Do(del)
	dr.Body.Close()
	if dr.StatusCode != 204 {
		t.Fatalf("delete: %d", dr.StatusCode)
	}
	gone, _ := http.NewRequest("GET", srv.URL+"/blob/abc123", nil)
	gone.Header.Set("Authorization", "Bearer nodesecret")
	gr, _ := http.DefaultClient.Do(gone)
	gr.Body.Close()
	if gr.StatusCode != 404 {
		t.Fatalf("get after delete: %d", gr.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium-node/ -run TestBlobHandler`
Expected: FAIL — `newBlobHandler` undefined.

- [ ] **Step 3: Implement `storage.go`**

`server/cmd/relayium-node/storage.go`:
```go
package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/relayium/relayium/internal/storage"
)

// newBlobHandler serves PUT/GET/DELETE /blob/{key} backed by a local DiskStore,
// authenticated by a bearer secret (constant-time). The DiskStore's own key
// validation (validKey regex) rejects path-traversal keys.
func newBlobHandler(ds *storage.DiskStore, secret string) http.Handler {
	mux := http.NewServeMux()
	authed := func(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(tok), []byte(secret)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			key := strings.TrimPrefix(r.URL.Path, "/blob/")
			h(w, r, key)
		}
	}
	mux.HandleFunc("PUT /blob/{key}", authed(func(w http.ResponseWriter, r *http.Request, key string) {
		n, err := ds.Put(r.Context(), key, r.Body)
		if errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "bad key", http.StatusBadRequest)
			return
		}
		if err != nil {
			http.Error(w, "write failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"size": n})
	}))
	mux.HandleFunc("GET /blob/{key}", authed(func(w http.ResponseWriter, r *http.Request, key string) {
		rc, err := ds.Get(r.Context(), key)
		if errors.Is(err, storage.ErrNotFound) || errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		defer rc.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.Copy(w, rc)
	}))
	mux.HandleFunc("DELETE /blob/{key}", authed(func(w http.ResponseWriter, r *http.Request, key string) {
		if err := ds.Delete(r.Context(), key); err != nil && !errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent) // idempotent
	}))
	return mux
}
```

- [ ] **Step 4: Add storage config + `storageSecret` state**

In `main.go`'s `config` struct add `StorageDir string` and `StoragePort int`; in `parseConfig` add flags:
```go
	flag.StringVar(&c.StorageDir, "storage-dir", env("RELAYIUM_NODE_STORAGE_DIR", ""), "blob storage dir; empty disables node storage")
	flag.IntVar(&c.StoragePort, "storage-port", 8081, "TCP port for the node blob HTTP server")
```
In `state.go`, add `StorageSecret string` to `nodeState` (json tag `storageSecret`) and generate it on first load alongside `TURNSecret` (same 32-byte crypto/rand → 64 hex):
```go
	st := nodeState{TURNSecret: hex.EncodeToString(secret)}
	sk := make([]byte, 32)
	if _, rerr := rand.Read(sk); rerr != nil {
		return nodeState{}, rerr
	}
	st.StorageSecret = hex.EncodeToString(sk)
```
(Update `state_test.go`'s expectations only if it asserts exact field set; add an assertion that `StorageSecret` is 64 hex if you extend it.)

- [ ] **Step 5: Run tests + build**

Run: `cd server && go test ./cmd/relayium-node/ && CGO_ENABLED=0 go build ./cmd/relayium-node/`
Expected: PASS + static build.

- [ ] **Step 6: Commit**

```bash
git add server/cmd/relayium-node/storage.go server/cmd/relayium-node/storage_test.go server/cmd/relayium-node/main.go server/cmd/relayium-node/state.go
git commit -m "feat(node): DiskStore-backed blob HTTP server + storage config/secret"
```

---

## Task 9: node reporting wiring (start server + register/heartbeat storage fields)

**Files:**
- Modify: `server/cmd/relayium-node/relay.go`
- Test: manual smoke (documented) + `relay_test.go` unit for the storage-URL/DiskUsage helpers if extracted.

**Interfaces:**
- Consumes: `newBlobHandler` (Task 8); `storage.NewDiskStore`, `storage.DiskUsage`; register/heartbeat wire fields (Task 3).

- [ ] **Step 1: Write the failing test**

Add a small unit to `server/cmd/relayium-node/relay_test.go` for a pure helper `storageReport(dir string) (total, free int64, err error)` that wraps `storage.DiskUsage` (returns the node's blob-dir capacity for register/heartbeat):
```go
func TestStorageReport(t *testing.T) {
	total, free, err := storageReport(t.TempDir())
	if err != nil {
		t.Fatalf("storageReport: %v", err)
	}
	if total == 0 || free == 0 || free > total {
		t.Fatalf("implausible total=%d free=%d", total, free)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium-node/ -run TestStorageReport`
Expected: FAIL — `storageReport` undefined.

- [ ] **Step 3: Wire storage into `run` (`relay.go`)**

Add the helper and start the blob server + populate register/heartbeat when `c.StorageDir != ""`:
```go
func storageReport(dir string) (total, free int64, err error) {
	used, tot, err := storage.DiskUsage(dir) // used, total, err
	if err != nil {
		return 0, 0, err
	}
	return int64(tot), int64(tot - used), nil
}
```
(Confirm `storage.DiskUsage` return order against its signature — SP1 used `DiskUsage(path) (used, total uint64, err error)`; adapt the arithmetic to whatever it actually returns.)

In `run`, after loading state and BEFORE `register`, when storage is enabled:
```go
	var storageURL, storageSecret string
	var storTotal, storFree int64
	if c.StorageDir != "" {
		ds, derr := storage.NewDiskStore(c.StorageDir)
		if derr != nil {
			return fmt.Errorf("open storage dir %s: %w", c.StorageDir, derr)
		}
		storageSecret = st.StorageSecret
		blobSrv := &http.Server{Addr: fmt.Sprintf(":%d", c.StoragePort), Handler: newBlobHandler(ds, storageSecret)}
		go func() {
			if err := blobSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("relayium-node: blob server exited: %v", err)
			}
		}()
		defer blobSrv.Close()
		storageURL = fmt.Sprintf("http://%s:%d", publicIP, c.StoragePort)
		if t, f, uerr := storageReport(c.StorageDir); uerr == nil {
			storTotal, storFree = t, f
		}
		log.Printf("relayium-node: storage enabled, serving blobs on %s", storageURL)
	}
```
Extend the `register` call's `registerBody` with `StorageURL: storageURL, StorageSecret: storageSecret, StorageTotal: storTotal, StorageFree: storFree` and add `"storage"` to `Capabilities` when `storageURL != ""`. Extend `registerBody`/`heartbeatBody` in `report.go` with the storage json fields matching Task 3's central tags (`storageURL`,`storageSecret`,`storageTotal`,`storageFree`). In `sendHeartbeat`, include `StoredBytes` (the blob-dir used bytes) and refreshed `StorageTotal`/`StorageFree` from `storageReport` (compute inside the heartbeat, or pass the dir in).

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./cmd/relayium-node/ && CGO_ENABLED=0 go build ./cmd/relayium-node/`
Expected: PASS + static build.

- [ ] **Step 5: Manual smoke (documented, not CI)**

Document in the commit body: on a host with a public IP, run with `-storage-dir /var/lib/relayium-node/blobs` → node registers with `capabilities:["relay","storage"]`; an upload lands on the node's disk; download works; admin shows its stored/free bytes.

- [ ] **Step 6: Commit**

```bash
git add server/cmd/relayium-node/relay.go server/cmd/relayium-node/report.go server/cmd/relayium-node/relay_test.go
git commit -m "feat(node): start blob server + report storage URL/secret/free/total"
```

---

## Task 10: admin storage telemetry

**Files:**
- Modify: `server/internal/account/admin.go` (`adminNodeView` + `nodeViews`)
- Modify: `server/internal/account/admin_templates.go` (Nodes table columns)
- Test: `server/internal/account/admin_nodes_test.go` (extend)

**Interfaces:**
- Consumes: `Node` storage fields (Task 2).

- [ ] **Step 1: Write the failing test**

Extend `TestNodeViewsOnlineFlag` (or add `TestNodeViewsStorage`) asserting `nodeViews` copies `StorageEnabled`, `StorageTotal`, `StorageFree` into the view:
```go
func TestNodeViewsStorage(t *testing.T) {
	now := time.Unix(10000, 0)
	views := nodeViews([]Node{{ID: "n", LastSeenAt: now.Unix(), StorageEnabled: true, StorageTotal: 20 << 30, StorageFree: 5 << 30, StoredBytes: 3 << 30}}, now)
	if !views[0].StorageEnabled || views[0].StorageFree != 5<<30 || views[0].StoredBytes != 3<<30 {
		t.Fatalf("view=%+v", views[0])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestNodeViewsStorage`
Expected: FAIL — view has no storage fields.

- [ ] **Step 3: Add storage fields to the view + builder**

In `admin.go`, add to `adminNodeView`: `StorageEnabled bool; StorageTotal, StorageFree int64` (StoredBytes already present via SP1? if not, add `StoredBytes int64`). In `nodeViews`, copy them from each `Node`.

- [ ] **Step 4: Show them in the template**

In `admin_templates.go`, add columns to the Nodes table header and row (using the existing `bytes` func):
```html
<th>存储</th><th>剩余/总量</th>
...
<td>{{if .StorageEnabled}}{{bytes .StoredBytes}}{{else}}—{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StorageFree}} / {{bytes .StorageTotal}}{{else}}—{{end}}</td>
```
(Replace the SP1 single `stored_bytes` cell if it duplicates; keep the table coherent.)

- [ ] **Step 5: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'NodeViews|Admin' && go build ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/admin_nodes_test.go
git commit -m "feat(admin): show node storage used/free/total in the Nodes section"
```

---

## Self-Review Notes

**Spec coverage:** RemoteBlobStore → T1; node blob server → T8; register/schema (nodes storage cols, StorageNodes, GetNode, stored_files.node_id, pending_node_deletes) → T2; register/heartbeat storage fields → T3+T9; blobFor + placeUpload random placement → T4; upload routing → T5; download 503 + remote-burn open-then-claim + delete enqueue → T6; GC routing + orphan drain → T7; node reporting wiring → T9; admin telemetry → T10. No replication / direct-to-node / capacity-weighting correctly absent (out of scope).

**Cross-task type consistency:** node↔central storage wire tags (`storageURL`,`storageSecret`,`storageTotal`,`storageFree`) defined in T3 (central `nodeRegisterReq`/`nodeHeartbeatReq`) and T9 (node `registerBody`/`heartbeatBody`) — must match byte-for-byte (call this out to the T9 implementer/reviewer as in SP1). `TouchNode` new 7-arg signature (T2) consumed by T3 heartbeat + fixed in the SP1 test (T2 step 8). `Node`/`StoredFile` fields (T2) consumed by T3/T4/T5/T6/T10. `blobFor`/`BlobForNode` (T4) consumed by T5/T6/T7. `nodeOnlineWindow` reused from SP1.

**Known follow-ups (non-blocking, note for final review):** TLS-pinning on the central↔node hop; capacity-weighted placement; node-side proactive reconcile. The upload/download routing tests reuse the existing file-test harness (`newFileServerWithQuota`, `loginCookie`, `postUpload`, `uploadBody`, `decodeJSON`) plus `fakeNode`/`intToStr` from `blobfor_test.go` — verified those helpers exist; the T5/T6 test code is concrete.

**Cross-task hazard for reviewers:** T2 changes `TouchNode`'s signature (5→7 args) and adds columns to the shared `nodeCols`/`storedFileCols` scan lists — any SP1 test or call site that scans nodes or calls `TouchNode` must be updated in lockstep (T2 step 8 covers the known one; `go build ./...` + full `go test ./internal/account/` in T2 step 9 catches the rest).
