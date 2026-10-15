package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// durabilityNode starts a node blob handler over a DiskStore in dir. A second
// call on the same dir is the node after a restart: same bytes, empty record.
func durabilityNode(t *testing.T, dir string) (*httptest.Server, *storage.RemoteBlobStore) {
	t.Helper()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newBlobHandler(ds, "nodesecret", nil, nil, nil, nil))
	t.Cleanup(srv.Close)
	return srv, storage.NewRemoteBlobStore(srv.URL, "nodesecret", "", srv.Client())
}

func blobPath(dir, key string) string { return filepath.Join(dir, key[:2], key) }

// rawPatch sends a PATCH the way a LEGACY central does: no v1 header.
func rawPatch(t *testing.T, srv *httptest.Server, key string, offset string, body string, hdr map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/blob/"+key, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer nodesecret")
	req.Header.Set("X-Blob-Offset", offset)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

// leaveUncertifiedTail writes "abc" durably through the node, then appends
// "def" behind the node's back without a flush and restarts the node — the
// on-disk state a failed flush or a crash before one leaves.
func leaveUncertifiedTail(t *testing.T, key string) (dir string, srv *httptest.Server, rbs *storage.RemoteBlobStore) {
	t.Helper()
	dir = t.TempDir()
	_, first := durabilityNode(t, dir)
	if size, err := first.Append(context.Background(), key, 0, strings.NewReader("abc")); err != nil || size != 3 {
		t.Fatalf("setup append = %d, %v", size, err)
	}
	f, err := os.OpenFile(blobPath(dir, key), os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("def"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	srv, rbs = durabilityNode(t, dir)
	return dir, srv, rbs
}

func TestV1NodeReportsAnUncertifiedTailAsNotDurable(t *testing.T) {
	const key = "dd0001"
	dir, _, rbs := leaveUncertifiedTail(t, key)
	size, err := rbs.Append(context.Background(), key, 3, strings.NewReader(""))
	var nde *storage.NotDurableError
	if !errors.As(err, &nde) || size != 3 || nde.Durable != 3 || nde.Physical != 6 || nde.Written != 0 {
		t.Fatalf("v1 probe = %d, %v (%+v); want durable 3, physical 6", size, err, nde)
	}
	if info, _ := os.Stat(blobPath(dir, key)); info.Size() != 6 {
		t.Fatalf("a probe changed the blob: %d", info.Size())
	}
}

// A legacy central gets exactly what a pre-v1 node said: 409 with the physical
// size, no v1 echo, and no repair even if it sent a floor header.
func TestLegacyCentralGetsLegacyAnswersFromAV1Node(t *testing.T) {
	const key = "dd0002"
	dir, srv, _ := leaveUncertifiedTail(t, key)
	for _, hdr := range []map[string]string{nil, {storage.SettledThroughHeader: "6"}} {
		resp, out := rawPatch(t, srv, key, "3", "", hdr)
		if resp.StatusCode != http.StatusConflict || out["size"] != float64(6) {
			t.Fatalf("legacy probe = %d %v; want the legacy 409 with physical 6", resp.StatusCode, out)
		}
		if resp.Header.Get(storage.AppendDurabilityHeader) != "" {
			t.Fatal("a legacy request got a v1 attestation")
		}
		resp, _ = rawPatch(t, srv, key, "3", "ghi", hdr)
		if resp.StatusCode != http.StatusConflict {
			t.Fatalf("legacy append over the tail = %d; want 409 (no repair without v1)", resp.StatusCode)
		}
	}
	if info, _ := os.Stat(blobPath(dir, key)); info.Size() != 6 {
		t.Fatalf("legacy requests changed the blob: %d", info.Size())
	}
}

func TestV1NodeRepairsOnlyUnderACoveringSettledFloor(t *testing.T) {
	const key = "dd0003"
	dir, srv, rbs := leaveUncertifiedTail(t, key)
	ctx := context.Background()
	size, err := rbs.Append(storage.WithSettledThrough(ctx, 5), key, 3, strings.NewReader("def"))
	if !errors.Is(err, storage.ErrNotDurable) || size != 3 {
		t.Fatalf("short floor = %d, %v; want a not-durable refusal", size, err)
	}
	if info, _ := os.Stat(blobPath(dir, key)); info.Size() != 6 {
		t.Fatalf("a short floor destroyed evidence: %d", info.Size())
	}
	size, err = rbs.Append(storage.WithSettledThrough(ctx, 6), key, 3, strings.NewReader("def"))
	if err != nil || size != 6 {
		t.Fatalf("covering floor = %d, %v; want the replay to land durably", size, err)
	}
	if got, _ := os.ReadFile(blobPath(dir, key)); string(got) != "abcdef" {
		t.Fatalf("blob = %q; want the durable prefix plus the replay", got)
	}
	// Garbage floors are refused outright.
	resp, _ := rawPatch(t, srv, key, "6", "x", map[string]string{
		storage.AppendDurabilityHeader: storage.AppendDurabilityV1, storage.SettledThroughHeader: "-1",
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("negative floor = %d; want 400", resp.StatusCode)
	}
}

// The write-path not-durable outcome (a failed flush; DiskStore's seam is not
// reachable from here, so the mapping is driven directly).
func TestWriteAppendAnswerMapsAFailedFlushPerMode(t *testing.T) {
	nde := &storage.NotDurableError{Durable: 10, Physical: 30, Written: 20, Err: errors.New("EIO")}

	w := httptest.NewRecorder()
	w.Header().Set(storage.AppendDurabilityHeader, storage.AppendDurabilityV1)
	writeAppendAnswer(w, true, 10, nde)
	var body storage.NotDurableBody
	_ = json.NewDecoder(w.Body).Decode(&body)
	if w.Code != http.StatusInternalServerError || !body.NotDurable || body.Durable != 10 || body.Physical != 30 || body.Written != 20 {
		t.Fatalf("strict = %d %+v", w.Code, body)
	}

	w = httptest.NewRecorder()
	writeAppendAnswer(w, false, 10, nde)
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "notDurable") {
		t.Fatalf("legacy = %d %q; want the plain legacy 500", w.Code, w.Body.String())
	}
}
