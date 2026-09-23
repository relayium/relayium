package account

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// W-N40: an upload that carries zero ciphertext bytes. That is what every
// all-empty batch is — each empty file contributes no AEAD frame, so the frame
// stream is empty — and a resumable upload of it never sends a PATCH, so no
// blob is ever created on central's disk or on a node. The object's row is
// still real (manifest, retention, task binding), and its content is exactly
// its committed size of zero bytes. These tests pin that such an object is
// READABLE as the empty stream it is, wherever it was placed, and that it is
// quota-accounted exactly like every other object: one 64 KiB floor debit,
// once, never zero and never twice.

// landEmptyUpload opens a resumable upload and sends no bytes at all, which is
// exactly what the CLI, Web and Swift senders do for a zero-byte frame stream.
func landEmptyUpload(t *testing.T, ts *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	return initUpload(t, ts, cookie, []byte("EMPTY-BATCH-MANIFEST"), 0, 0)
}

func quotaUsed(t *testing.T, store *SQLiteStore, userID string) int64 {
	t.Helper()
	n, err := store.UserUploadedSince(context.Background(), userID, 0)
	if err != nil {
		t.Fatalf("quota: %v", err)
	}
	return n
}

func storedFileCount(t *testing.T, store *SQLiteStore, userID string) int {
	t.Helper()
	files, err := store.ListStoredFilesByUser(context.Background(), userID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return len(files)
}

// downloadFileResp fetches the public blob route and returns the response
// status, body and Content-Length header.
func downloadFileResp(t *testing.T, ts *httptest.Server, id string, hdr map[string]string) (int, []byte, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/files/"+id+"/blob", nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, resp.Header.Get("Content-Length")
}

// The original defect, on central's own disk: before W-N40 this download
// answered 404 (and the Device Inbox route 409 stored_object_unavailable,
// deleting the row on the way) because no blob existed.
func TestEmptyUploadIsAReadableEmptyObjectOnCentralDisk(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "empty-local@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "empty-local@example.com", "")

	uploadID := landEmptyUpload(t, ts, cookie)
	status, id := finalizeOnce(t, ts, cookie, uploadID)
	if status != http.StatusOK || id == "" {
		t.Fatalf("finalize = %d %q; want 200 and an object", status, id)
	}
	for i := 0; i < 3; i++ { // an unlimited share: every read is the same empty stream
		code, body, cl := downloadFileResp(t, ts, id, nil)
		if code != http.StatusOK || len(body) != 0 || cl != "0" {
			t.Fatalf("read %d: status %d, %d bytes, Content-Length %q; want 200, 0, \"0\"", i, code, len(body), cl)
		}
	}
	if n := storedFileCount(t, store, u.ID); n != 1 {
		t.Fatalf("stored objects = %d; reading must not heal away a live empty object", n)
	}
	// Money: one floor debit, zero metered traffic in either direction.
	if q := quotaUsed(t, store, u.ID); q != minBillableBytes {
		t.Fatalf("daily quota debit = %d; want exactly one %d floor", q, minBillableBytes)
	}
	if up := uploadedThisMonth(t, store, u.ID); up != 0 {
		t.Fatalf("metered upload bytes = %d; an empty upload moved none", up)
	}
	_, down, err := store.MonthlyUsage(context.Background(), u.ID, time.Now().UTC().Format("200601"))
	if err != nil || down != 0 {
		t.Fatalf("metered download bytes = %d; reading an empty object moves none", down)
	}
	// An explicit resume range has nothing to resume inside an empty object: the
	// public boundary keeps answering it 416, exactly as for any start >= size.
	if code, _, _ := downloadFileResp(t, ts, id, map[string]string{"Range": "bytes=0-"}); code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("Range bytes=0- on an empty object = %d; want 416", code)
	}
}

// Retry after a lost answer and concurrent finalizes: one object, one debit.
// The adversarial double-charge path is N racers on the SAME empty session.
func TestEmptyUploadRacingFinalizesChargeOnce(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "empty-race@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "empty-race@example.com", "")

	uploadID := landEmptyUpload(t, ts, cookie)
	const racers = 8
	var wg sync.WaitGroup
	codes := make([]int, racers)
	ids := make([]string, racers)
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/uploads/"+uploadID+"/finalize", nil)
			req.AddCookie(cookie)
			resp, err := ts.Client().Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			defer resp.Body.Close()
			codes[i] = resp.StatusCode
			if resp.StatusCode == http.StatusOK {
				var out struct {
					ID string `json:"id"`
				}
				decodeJSON(t, resp, &out)
				ids[i] = out.ID
			}
		}(i)
	}
	close(start)
	wg.Wait()
	oks := 0
	var id string
	for i, c := range codes {
		switch c {
		case http.StatusOK:
			oks++
			id = ids[i]
		case http.StatusConflict:
		default:
			t.Fatalf("racer %d = %d; want 200 or 409", i, c)
		}
	}
	if oks != 1 {
		t.Fatalf("%d racers landed an object; want exactly 1", oks)
	}
	// Sequential retries after the race (a lost-response retry) change nothing.
	for i := 0; i < 3; i++ {
		if c, _ := finalizeOnce(t, ts, cookie, uploadID); c != http.StatusConflict {
			t.Fatalf("retry %d = %d; want 409", i, c)
		}
	}
	if n := storedFileCount(t, store, u.ID); n != 1 {
		t.Fatalf("stored objects = %d; want 1", n)
	}
	if q := quotaUsed(t, store, u.ID); q != minBillableBytes {
		t.Fatalf("daily quota debit = %d after %d racing finalizes and 3 retries; want exactly %d",
			q, racers, minBillableBytes)
	}
	if code, body, _ := downloadFileResp(t, ts, id, nil); code != http.StatusOK || len(body) != 0 {
		t.Fatalf("the one object: %d, %d bytes", code, len(body))
	}
}

// Adversarial money test: an empty object is NOT a free object. The init
// pre-check skips a declared size of 0, so the only thing standing between a
// client and unlimited zero-byte objects is the finalize-time floor debit. With
// less than one floor left, an empty finalize is refused 429 and leaves no row
// and no debit; below that, every empty object costs exactly one floor.
func TestEmptyUploadsAreNotFreeObjects(t *testing.T) {
	const floors = 3
	ts, _, store, mail := newFileServerWithQuota(t, floors*minBillableBytes+minBillableBytes/2, 1<<20)
	cookie := loginCookie(t, ts, mail, "empty-free@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "empty-free@example.com", "")

	for i := 0; i < floors; i++ {
		if c, id := finalizeOnce(t, ts, cookie, landEmptyUpload(t, ts, cookie)); c != http.StatusOK || id == "" {
			t.Fatalf("empty upload %d = %d; want 200 while a floor remains", i, c)
		}
	}
	if q := quotaUsed(t, store, u.ID); q != floors*minBillableBytes {
		t.Fatalf("debit after %d empty objects = %d; want %d", floors, q, floors*minBillableBytes)
	}
	// Half a floor remains: the next empty object must be refused, not granted.
	if c, _ := finalizeOnce(t, ts, cookie, landEmptyUpload(t, ts, cookie)); c != http.StatusTooManyRequests {
		t.Fatalf("empty upload past the quota = %d; want 429", c)
	}
	if q := quotaUsed(t, store, u.ID); q != floors*minBillableBytes {
		t.Fatalf("a refused empty finalize moved the debit to %d", q)
	}
	if n := storedFileCount(t, store, u.ID); n != floors {
		t.Fatalf("stored objects = %d; the refused one must not exist", n)
	}
}

// A burn-after-read empty share is consumed by its one read exactly like a
// non-empty one: the read completes (0 of 0 bytes), the slot is spent, the row
// goes, and a second read is 404.
func TestEmptyBurnShareIsConsumedByItsOneRead(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "empty-burn@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "empty-burn@example.com", "")

	var body bytes.Buffer
	body.Write([]byte{0, 0, 0, 5})
	body.WriteString("BURNM")
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/uploads?burnAfterRead=1&size=0", &body)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		UploadID string `json:"uploadId"`
	}
	decodeJSON(t, resp, &out)
	c, id := finalizeOnce(t, ts, cookie, out.UploadID)
	if c != http.StatusOK {
		t.Fatalf("finalize = %d", c)
	}
	sf, err := store.GetStoredFile(context.Background(), id)
	if err != nil || sf.MaxDownloads != 1 {
		t.Fatalf("not a burn object: %+v %v", sf, err)
	}
	if code, b, _ := downloadFileResp(t, ts, id, nil); code != http.StatusOK || len(b) != 0 {
		t.Fatalf("first read = %d, %d bytes", code, len(b))
	}
	if code, _, _ := downloadFileResp(t, ts, id, nil); code != http.StatusNotFound {
		t.Fatalf("second read = %d; want 404 — the one read must consume a burn share", code)
	}
	if n := storedFileCount(t, store, u.ID); n != 0 {
		t.Fatalf("stored objects = %d after the burn read", n)
	}
}

// The remote-storage path. The upload is placed on a fleet node; an empty one
// never PATCHes, so the node never creates the key. Its read must not depend
// on the node at all — which also means a node that is down cannot make an
// empty object unreadable — while a non-empty object on the same downed node
// keeps its existing 503 (its bytes really are there and really are offline).
func TestEmptyUploadOnAStorageNodeIsReadableAndNeedsNoNodeIO(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "empty-node@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "empty-node@example.com", "")

	nodeDisk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var down, gets, patches, puts int64
	var mu sync.Mutex
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		isDown := down == 1
		switch r.Method {
		case http.MethodGet:
			gets++
		case http.MethodPatch:
			patches++
		case http.MethodPut:
			puts++
		}
		mu.Unlock()
		if isDown {
			panic(http.ErrAbortHandler)
		}
		key := r.URL.Path[len("/blob/"):]
		switch r.Method {
		case http.MethodPatch:
			var off int64
			fmt.Sscan(r.Header.Get("X-Blob-Offset"), &off)
			n, err := nodeDisk.Append(r.Context(), key, off, r.Body)
			if err == storage.ErrOffsetMismatch {
				w.WriteHeader(http.StatusConflict)
				fmt.Fprintf(w, `{"size":%d}`, n)
				return
			}
			fmt.Fprintf(w, `{"size":%d}`, n)
		case http.MethodGet:
			rc, err := nodeDisk.Get(r.Context(), key)
			if err != nil {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			defer rc.Close()
			io.Copy(w, rc)
		case http.MethodDelete:
			_ = nodeDisk.Delete(r.Context(), key)
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(node.Close)
	if _, err := store.UpsertNode(context.Background(), Node{
		ID: "emptynode", OwnerType: "fleet", StorageEnabled: true, StorageURL: node.URL, StorageSecret: "s",
		StorageTotal: 1 << 40, StorageFree: 1 << 39, CreatedAt: 1, LastSeenAt: svc.now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}

	emptyID := func() string {
		c, id := finalizeOnce(t, ts, cookie, landEmptyUpload(t, ts, cookie))
		if c != http.StatusOK {
			t.Fatalf("finalize empty = %d", c)
		}
		return id
	}()
	blob := bytes.Repeat([]byte("N"), 700)
	fullID := func() string {
		c, id := finalizeOnce(t, ts, cookie, landOneUpload(t, ts, cookie, blob))
		if c != http.StatusOK {
			t.Fatalf("finalize non-empty = %d", c)
		}
		return id
	}()
	for _, id := range []string{emptyID, fullID} {
		sf, err := store.GetStoredFile(context.Background(), id)
		if err != nil || sf.NodeID != "emptynode" {
			t.Fatalf("object %s not placed on the node: %+v %v", id, sf, err)
		}
	}
	mu.Lock()
	gets = 0
	mu.Unlock()
	if code, b, cl := downloadFileResp(t, ts, emptyID, nil); code != http.StatusOK || len(b) != 0 || cl != "0" {
		t.Fatalf("empty read via node = %d, %d bytes, CL %q", code, len(b), cl)
	}
	if code, b, _ := downloadFileResp(t, ts, fullID, nil); code != http.StatusOK || !bytes.Equal(b, blob) {
		t.Fatalf("non-empty read via node = %d, %d bytes", code, len(b))
	}
	mu.Lock()
	if gets != 1 {
		mu.Unlock()
		t.Fatalf("node GETs = %d; want 1 (only the non-empty object reads the node)", gets)
	}
	down = 1
	mu.Unlock()
	if code, b, _ := downloadFileResp(t, ts, emptyID, nil); code != http.StatusOK || len(b) != 0 {
		t.Fatalf("empty read with the node down = %d; an empty object has no bytes to be offline", code)
	}
	if code, _, _ := downloadFileResp(t, ts, fullID, nil); code != http.StatusServiceUnavailable {
		t.Fatalf("non-empty read with the node down = %d; want the unchanged 503", code)
	}
	if n := storedFileCount(t, store, u.ID); n != 2 {
		t.Fatalf("stored objects = %d; a node outage must not delete either", n)
	}
	if q := quotaUsed(t, store, u.ID); q != 2*minBillableBytes {
		t.Fatalf("debit = %d; want two floors", q)
	}
}

// The BYO own-node direct route redirects a native client to the node's public
// /dl/{key}. An empty object has no key on the node, so a redirect would end in
// the node's 404; it is answered in place instead, as the empty stream, while
// a non-empty object on the same node keeps its redirect.
func TestEmptyObjectOnAByoNodeIsNotRedirectedToAMissingKey(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	svc.SetDirectDownload(true)
	ctx := context.Background()
	owner, _ := store.UpsertUserByEmail(ctx, "byo-empty@example.com", "")
	if _, err := store.UpsertNode(ctx, Node{
		ID: "byoempty", OwnerType: "user", OwnerUserID: owner.ID, StorageEnabled: true,
		StorageURL: "https://internal.byo", StorageSecret: "bs",
		DownloadURL: "https://mynode.example.com", CreatedAt: 1, LastSeenAt: time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	for id, size := range map[string]int64{"emptybyo": 0, "fullbyo": 500} {
		if err := store.CreateStoredFile(ctx, StoredFile{
			ID: id, UserID: owner.ID, BlobKey: "k" + id, EncManifest: []byte("m"), Size: size,
			NodeID: "byoempty", CreatedAt: 1, ExpiresAt: time.Now().Add(time.Hour).Unix(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	get := func(id string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/files/"+id+"/blob", nil)
		req.Header.Set("X-Relayium-Direct-Download", "1")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}
	if resp := get("emptybyo"); resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Length") != "0" {
		t.Fatalf("empty BYO object = %d (Location %q); want 200 with an empty body",
			resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp := get("fullbyo"); resp.StatusCode != http.StatusFound {
		t.Fatalf("non-empty BYO object = %d; want the unchanged 302", resp.StatusCode)
	}
}

// Cleanup of an empty object whose key never existed on its node: expiry
// removes the row; with the node down the delete is queued, and once the node
// answers, its idempotent 404 for the never-created key discharges the queue
// row. Nothing is billed along the way and nothing is left behind.
func TestEmptyObjectExpiryCleanupTerminatesAcrossANodeOutage(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "empty-gc@example.com", "")
	n, err := store.UpsertNode(ctx, Node{ID: "gcnode", OwnerType: "fleet", StorageEnabled: true,
		StorageURL: "http://127.0.0.1:1", StorageSecret: "ss", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{ID: "emptygc", UserID: u.ID, BlobKey: "never-created",
		EncManifest: []byte("m"), Size: 0, NodeID: n.ID, CreatedAt: 1, ExpiresAt: 2}); err != nil {
		t.Fatal(err)
	}
	nodeURL := "http://127.0.0.1:1" // nothing listens: the node is down
	blobFor := func(context.Context, string) (storage.BlobStore, error) {
		return storage.NewRemoteBlobStore(nodeURL, "ss", "", http.DefaultClient), nil
	}
	g := &GC{Store: store, Now: func() int64 { return 1000000 }, Log: log.New(io.Discard, "", 0), BlobFor: blobFor}
	g.sweep(ctx)
	if _, err := store.GetStoredFile(ctx, "emptygc"); err != ErrNotFound {
		t.Fatalf("expired empty object not removed: %v", err)
	}
	if pend, _ := store.ListPendingNodeDeletes(ctx); len(pend) != 1 {
		t.Fatalf("pending deletes with the node down = %+v; want the one queued delete", pend)
	}
	srv := fakeNode(t, map[string][]byte{}) // back up, and it never held the key
	defer srv.Close()
	nodeURL = srv.URL
	g.sweep(ctx)
	if pend, _ := store.ListPendingNodeDeletes(ctx); len(pend) != 0 {
		t.Fatalf("pending deletes after the node returned = %+v; a never-created key must discharge", pend)
	}
	if q := quotaUsed(t, store, u.ID); q != 0 {
		t.Fatalf("cleanup debited %d", q)
	}
	if up := uploadedThisMonth(t, store, u.ID); up != 0 {
		t.Fatalf("cleanup metered %d upload bytes", up)
	}
}
