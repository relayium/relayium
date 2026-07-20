package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// The gauge must read the blob directory's real size. This test targets the
// node's reporting semantics: it used to report the whole volume's statfs
// usage, so the admin dashboard counted unrelated data on the system disk as
// relayium storage.
func TestBlobUsageRefreshReadsRealSize(t *testing.T) {
	ds, err := storage.NewDiskStore(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}
	u := &blobUsage{}

	if got := u.get(); got != 0 {
		t.Fatalf("get() = %d before any refresh, want 0", got)
	}

	if _, err := ds.Put(context.Background(), "deadbeef", strings.NewReader(strings.Repeat("z", 777))); err != nil {
		t.Fatalf("Put: %v", err)
	}
	// Still the stale value before refresh: this is the caching semantics by
	// design, the heartbeat reads whatever the last refresh produced.
	if got := u.get(); got != 0 {
		t.Fatalf("get() = %d before refresh, want the stale 0", got)
	}

	u.refresh(ds)
	if got := u.get(); got != 777 {
		t.Fatalf("get() = %d after refresh, want 777", got)
	}
}

// seedStore opens a DiskStore under dir and writes a single blob of n bytes.
func seedStore(t *testing.T, dir string, n int) *storage.DiskStore {
	t.Helper()
	ds, err := storage.NewDiskStore(dir)
	if err != nil {
		t.Fatalf("NewDiskStore: %v", err)
	}
	if n > 0 {
		if _, err := ds.Put(context.Background(), "deadbeef", strings.NewReader(strings.Repeat("z", n))); err != nil {
			t.Fatalf("Put: %v", err)
		}
	}
	return ds
}

// The heartbeat must carry the blob directory's own footprint, not the whole
// volume's occupancy. Reporting total-free counted the OS and every unrelated
// program on the host as relayium storage, which inflated the admin dashboard
// and made central's placement filter treat healthy nodes as out of quota.
//
// The two numbers are made unmistakably different on purpose: the store holds a
// few hundred bytes while any real volume running this test has gigabytes in
// use, so a regression to total-free cannot coincidentally pass.
func TestHeartbeatReportsBlobFootprintNotVolumeUsage(t *testing.T) {
	dir := t.TempDir()
	ds := seedStore(t, filepath.Join(dir, "blobs"), 777)
	gauge := &blobUsage{}
	gauge.refresh(ds)

	var got heartbeatBody
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/nodes/heartbeat" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode heartbeat body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(heartbeatResp{OK: true})
	}))
	defer central.Close()

	sendHeartbeat(newReporter(central.URL, "tok"), "node-1", newAllocRegistry(nil), dir, gauge, nil)

	if got.StoredBytes != 777 {
		t.Fatalf("storedBytes = %d, want the gauge's 777", got.StoredBytes)
	}
	volumeUsed := got.StorageTotal - got.StorageFree
	if volumeUsed <= 777 {
		t.Fatalf("test cannot discriminate: whole-volume used = %d, expected it to dwarf the 777-byte store", volumeUsed)
	}
	if got.StoredBytes == volumeUsed {
		t.Fatalf("storedBytes = %d equals whole-volume used: the heartbeat is back on the total-free reading", got.StoredBytes)
	}
}

// The write-admission path must be driven by the real gauge: PUTs are refused
// with 507 once the blob directory's actual size reaches the admin disk cap,
// and served below it. A whole-volume reading here would refuse writes on a
// nearly empty store that merely shares a busy disk.
func TestBlobHandlerEnforcesDiskCapFromRealGauge(t *testing.T) {
	ds := seedStore(t, filepath.Join(t.TempDir(), "blobs"), 0)
	gauge := &blobUsage{}
	gauge.refresh(ds)
	lim := &limits{}
	lim.sync(0, 0, 1000) // disk cap 1000 bytes
	// diskFull is nil: this test isolates the admin cap from the 80% reserve.
	h := newBlobHandler(ds, "s", lim, gauge.get, nil)

	put := func(key string, n int) int {
		r := httptest.NewRequest("PUT", "/blob/"+key, bytes.NewReader(bytes.Repeat([]byte("z"), n)))
		r.Header.Set("Authorization", "Bearer s")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}

	if code := put("aaaa1111", 400); code != http.StatusOK {
		t.Fatalf("empty store, cap 1000: PUT = %d, want 200", code)
	}
	gauge.refresh(ds) // 400 stored
	if got := gauge.get(); got != 400 {
		t.Fatalf("gauge = %d after first PUT, want 400", got)
	}
	if code := put("bbbb2222", 700); code != http.StatusOK {
		t.Fatalf("400 of 1000 used: PUT = %d, want 200", code)
	}
	gauge.refresh(ds) // 1100 stored, now past the cap
	if got := gauge.get(); got != 1100 {
		t.Fatalf("gauge = %d after second PUT, want 1100", got)
	}
	if code := put("cccc3333", 10); code != http.StatusInsufficientStorage {
		t.Fatalf("1100 of 1000 used: PUT = %d, want 507", code)
	}
}

// The write gate handed to the blob handler must be the gauge, not the volume.
// This pins the wiring itself, which is where the whole-volume reading kept
// creeping back in: the handler can only use the function it is given, so a
// test on the handler alone cannot see which one run() picked.
//
// Same discriminating trick as the heartbeat test: a few hundred bytes of blob
// against a volume with gigabytes in use, so the two readings cannot be
// confused for one another.
func TestBlobGatesUsedIsGaugeNotVolume(t *testing.T) {
	dir := t.TempDir()
	ds := seedStore(t, filepath.Join(dir, "blobs"), 777)
	gauge := &blobUsage{}
	gauge.refresh(ds)

	diskUsed, diskFull := blobGates(gauge, dir)

	if got := diskUsed(); got != 777 {
		t.Fatalf("diskUsed() = %d, want the gauge's 777", got)
	}
	total, free, err := storageReport(dir)
	if err != nil {
		t.Fatalf("storageReport: %v", err)
	}
	volumeUsed := total - free
	if volumeUsed <= 777 {
		t.Fatalf("test cannot discriminate: whole-volume used = %d, expected it to dwarf the 777-byte store", volumeUsed)
	}
	if got := diskUsed(); got == volumeUsed {
		t.Fatalf("diskUsed() = %d equals whole-volume used: the write gate is back on the total-free reading", got)
	}

	// diskFull answers the other question and must stay whole-volume: it is
	// true exactly when the host's own free space drops under 20%.
	if got, want := diskFull(), free*5 < total; got != want {
		t.Fatalf("diskFull() = %v, want %v for a volume with %d of %d free", got, want, free, total)
	}
}

// A failed walk must leave the last good reading in place. Zeroing the gauge
// would read as "plenty of room": the heartbeat would report an empty node and
// storage.go's `diskUsed() >= cap` could never fire, silently switching off the
// admin disk cap.
func TestBlobUsageRefreshKeepsLastValueOnError(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "vol")
	ds := seedStore(t, filepath.Join(parent, "blobs"), 777)
	u := &blobUsage{}
	u.refresh(ds)
	if got := u.get(); got != 777 {
		t.Fatalf("seed refresh: get() = %d, want 777", got)
	}

	// Break the walk by replacing the store's parent directory with a regular
	// file, so the walk root fails to stat with ENOTDIR. Deleting the tree would
	// not do it: UsedBytes deliberately treats ENOENT as an empty store, and
	// chmod 000 is a no-op for root, which CI may well be.
	if err := os.RemoveAll(parent); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, err := ds.UsedBytes(); err == nil {
		t.Fatal("UsedBytes unexpectedly succeeded; this test is not exercising the error path")
	}

	u.refresh(ds)
	if got := u.get(); got != 777 {
		t.Fatalf("get() = %d after a failed refresh, want the retained 777 (the gauge must never reset to 0 on error)", got)
	}
}
