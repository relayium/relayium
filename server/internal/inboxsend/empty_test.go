package inboxsend

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// W-N40 end to end: all-empty and empty/non-empty deliveries through the real
// sender, the real account service (SQLite + DiskStore, or a fleet storage node)
// and the real task blob route, opened by a device holding the target key.
//
// An empty file contributes no AEAD frame, so an all-empty delivery is a
// zero-byte frame stream: the upload sends no PATCH, and no blob exists on
// central or on the node. The object is still real — its sealed manifest
// carries the tree — and must arrive as exactly that tree. Empty FOLDERS keep
// their existing semantics: the v3 manifest cannot represent one, so it is
// reported and not sent, whether or not the rest of the delivery is empty.

type emptyCase struct {
	name    string
	tree    map[string][]byte
	dirs    []string // extra empty folders under the sent root
	send    string   // the path under root that is named
	want    map[string]string
	notices []string
}

func emptyCases() []emptyCase {
	return []emptyCase{
		{
			name: "single empty file",
			tree: map[string][]byte{"a.txt": {}},
			send: "a.txt",
			want: map[string]string{"a.txt": ""},
		},
		{
			name:    "several empty files, nested, and an empty folder",
			tree:    map[string][]byte{"e/a": {}, "e/b/c": {}, "e/b/d/deep.txt": {}},
			dirs:    []string{"e/nothing/deeper"},
			send:    "e",
			want:    map[string]string{"e/a": "", "e/b/c": "", "e/b/d/deep.txt": ""},
			notices: []string{"not sent (empty folder): e/nothing"},
		},
		{
			name:    "empty and non-empty mixed",
			tree:    map[string][]byte{"m/x": {}, "m/y": []byte("1"), "m/sub/z": {}},
			dirs:    []string{"m/hollow"},
			send:    "m",
			want:    map[string]string{"m/x": "", "m/y": "1", "m/sub/z": ""},
			notices: []string{"not sent (empty folder): m/hollow"},
		},
	}
}

func runEmptyCase(t *testing.T, w *world, c emptyCase) (taskID string, quotaDelta int64) {
	t.Helper()
	root := writeTree(t, c.tree)
	for _, d := range c.dirs {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	before := w.env.QuotaBytes(w.uid)
	inits, fins := w.env.Faults.Hits(sendtest.KeyInit), w.env.Faults.Hits(sendtest.KeyFinalize)
	res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, c.send)}})
	if err != nil {
		t.Fatalf("send: %v\nnotices:\n%s", err, w.notice.String())
	}
	if res.State != "queued" || !res.Created || res.TaskID == "" {
		t.Fatalf("result = %+v; want a newly created queued task", res)
	}
	if w.env.Faults.Hits(sendtest.KeyInit)-inits != 1 || w.env.Faults.Hits(sendtest.KeyFinalize)-fins != 1 {
		t.Fatal("want exactly one upload and one finalize")
	}
	d := w.receive(res.TaskID)
	got := map[string]string{}
	for _, it := range d.manifest.Items {
		got[it.Name] = string(d.files[it.Name])
	}
	if len(got) != len(c.want) {
		t.Fatalf("delivered %v; want %v", keys(got), keys(c.want))
	}
	for name, body := range c.want {
		if g, ok := got[name]; !ok || g != body {
			t.Fatalf("%s: delivered %q (present %v); want %q", name, g, ok, body)
		}
	}
	if int64(len(d.blob)) != res.CiphertextBytes {
		t.Fatalf("ciphertext %d bytes, planned %d", len(d.blob), res.CiphertextBytes)
	}
	for _, n := range c.notices {
		if !strings.Contains(w.notice.String(), n) {
			t.Fatalf("missing notice %q in:\n%s", n, w.notice.String())
		}
	}
	return res.TaskID, w.env.QuotaBytes(w.uid) - before
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

const quotaFloor = 64 << 10 // account.minBillableBytes

func TestEmptyDeliveriesArriveAsTheExactTree(t *testing.T) {
	for _, placement := range []string{"central disk", "storage node"} {
		for _, c := range emptyCases() {
			t.Run(placement+"/"+c.name, func(t *testing.T) {
				var w *world
				var node *sendtest.Node
				if placement == "storage node" {
					w, node = newWorldOnNode(t, 4<<20)
				} else {
					w = newWorld(t, 4<<20)
				}
				_, delta := runEmptyCase(t, w, c)
				// One object, one debit: the 64 KiB floor for anything under it.
				if delta != quotaFloor {
					t.Fatalf("daily quota moved by %d; want exactly one %d floor", delta, quotaFloor)
				}
				if node != nil {
					entries := 0
					_ = filepath.Walk(node.Dir, func(_ string, fi os.FileInfo, _ error) error {
						if fi != nil && !fi.IsDir() {
							entries++
						}
						return nil
					})
					allEmpty := true
					for _, b := range c.want {
						if b != "" {
							allEmpty = false
						}
					}
					if allEmpty && entries != 0 {
						t.Fatalf("the node holds %d files for an all-empty delivery; nothing should be written", entries)
					}
					if !allEmpty && entries != 1 {
						t.Fatalf("the node holds %d files; want the one non-empty blob", entries)
					}
				}
			})
		}
	}
}

// Node failure: a storage node that is down cannot make an all-empty delivery
// unreadable (it holds no bytes of it), while a non-empty delivery on the same
// node is answered with the transient 503 — never the terminal
// stored_object_unavailable, and never by deleting the object.
func TestEmptyDeliveryNeedsNoNodeAndNodeOutageStaysTransientForBytes(t *testing.T) {
	w, node := newWorldOnNode(t, 4<<20)
	root := writeTree(t, map[string][]byte{"e/a": {}, "e/b": {}, "f/x": []byte("payload")})
	s := w.session()
	emptyRes, err := s.Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "e")}})
	if err != nil {
		t.Fatal(err)
	}
	fullRes, err := s.Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "f")}})
	if err != nil {
		t.Fatal(err)
	}
	node.SetDown(true)
	ds, _, err := w.target.client.Claim(context.Background(), 8)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, d := range ds {
		br, berr := w.target.client.Blob(context.Background(), d.ID, d.ClaimToken, 0)
		switch d.ID {
		case emptyRes.TaskID:
			seen++
			if berr != nil {
				t.Fatalf("empty delivery with the node down: %v", berr)
			}
			b, _ := io.ReadAll(br.Body)
			br.Body.Close()
			if len(b) != 0 {
				t.Fatalf("empty delivery served %d bytes", len(b))
			}
		case fullRes.TaskID:
			seen++
			if berr == nil {
				br.Body.Close()
				t.Fatal("a non-empty delivery was served from a node that is down")
			}
			if strings.Contains(berr.Error(), "stored_object_unavailable") || !strings.Contains(berr.Error(), "503") {
				t.Fatalf("non-empty delivery with the node down: %v; want a transient 503", berr)
			}
		}
	}
	if seen != 2 {
		t.Fatalf("claimed %d of the 2 deliveries", seen)
	}
	for _, id := range []string{emptyRes.TaskID, fullRes.TaskID} {
		for _, tk := range w.tasks() {
			if tk.ID == id && tk.ErrorCode == "stored_object_unavailable" {
				t.Fatalf("task %s failed terminally during a node outage", id)
			}
		}
	}
	node.SetDown(false)
}

// A lost finalize answer on an all-empty delivery: the sender exits with the
// unknown outcome and never uploads again; the one object and its one floor
// debit are all there is.
func TestEmptyDeliveryLostFinalizeNeverDoubleCharges(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	root := writeTree(t, map[string][]byte{"e/a": {}, "e/b": {}})
	w.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.DropResponse})
	s := w.session()
	_, err := s.Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "e")}})
	if err == nil {
		t.Fatal("a lost finalize answer was reported as a success")
	}
	// The sender may ask finalize again (and hear 409); it must never open a
	// second upload.
	if w.env.Faults.Hits(sendtest.KeyInit) != 1 {
		t.Fatalf("inits=%d; want 1", w.env.Faults.Hits(sendtest.KeyInit))
	}
	if q := w.env.QuotaBytes(w.uid); q != quotaFloor {
		t.Fatalf("quota = %d; want one floor for the one object the lost finalize stored", q)
	}
	// Retrying through the journal re-finalizes the same upload: 409, never a
	// second upload or a second debit.
	for _, id := range journalIDsIn(t, w) {
		_, _ = s.Retry(context.Background(), id)
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 1 {
		t.Fatalf("a retry opened a second upload (%d inits)", w.env.Faults.Hits(sendtest.KeyInit))
	}
	if q := w.env.QuotaBytes(w.uid); q != quotaFloor {
		t.Fatalf("quota after retry = %d; want %d", q, quotaFloor)
	}
}

func journalIDsIn(t *testing.T, w *world) []string {
	t.Helper()
	var ids []string
	for name := range w.journalFiles() {
		if strings.HasSuffix(name, ".json") && !strings.HasPrefix(name, ".") {
			ids = append(ids, strings.TrimSuffix(name, ".json"))
		}
	}
	return ids
}

// Only empty folders is still nothing to send (unchanged): the manifest cannot
// carry a folder, so there is no delivery to make.
func TestOnlyEmptyFoldersIsStillNothingToSend(t *testing.T) {
	w := newWorld(t, 4<<20)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "d", "e"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "d")}})
	if e := AsError(err); e == nil || e.Class != ClassLocal || e.Code != CodeNoFiles {
		t.Fatalf("err = %v; want the local no-files refusal", err)
	}
	if w.env.Faults.Hits(sendtest.KeyInit) != 0 {
		t.Fatal("an upload was opened for a delivery with no files")
	}
}

// W-N40 compatibility gate. Only a server that advertises
// capZeroLengthStoredObject on the device list serves an empty object; a
// server that predates it (or was rolled back) would store and debit an
// all-empty upload and then fail every receiver's fetch. Against such a
// server the all-empty send is the old local refusal, judged on the fresh read
// right before the first write: no upload, no debit, no task, no journal.
func TestAllEmptySendRequiresTheServerCapability(t *testing.T) {
	refusedCleanly := func(t *testing.T, w *world, err error, initsBefore int) {
		t.Helper()
		e := AsError(err)
		if e == nil || e.Class != ClassLocal || e.Code != CodeUnsendableContent ||
			!strings.Contains(e.Error(), "every file named is empty") {
			t.Fatalf("err = %v; want the local all-empty refusal", err)
		}
		if n := w.env.Faults.Hits(sendtest.KeyInit) - initsBefore; n != 0 {
			t.Fatalf("%d upload(s) opened against a server without the capability", n)
		}
		if n := w.env.Faults.Hits(sendtest.KeyCreate); n != 0 && initsBefore == 0 {
			t.Fatalf("%d task create(s)", n)
		}
		for name := range w.journalFiles() {
			if strings.HasSuffix(name, ".json") {
				t.Fatalf("a refused send left a journal %s", name)
			}
		}
	}

	t.Run("current server advertises it", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		c, err := NewClient(w.env.TS.URL, w.target.token, nil)
		if err != nil {
			t.Fatal(err)
		}
		c.hc.Transport = bypassTransport{w.env}
		_, caps, err := c.listDevicesWithCaps(context.Background())
		if err != nil || !hasCap(caps, capZeroLengthStoredObject) {
			t.Fatalf("real server capabilities = %v (%v); want %q", caps, err, capZeroLengthStoredObject)
		}
	})

	t.Run("old server refuses locally, mixed still sends", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		w.env.Faults.SetLegacyServer(true)
		root := writeTree(t, map[string][]byte{"e/a": {}, "e/b/c": {}, "m/x": {}, "m/y": []byte("1")})
		_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "e")}})
		refusedCleanly(t, w, err, 0)
		if q := w.env.QuotaBytes(w.uid); q != 0 {
			t.Fatalf("quota = %d after a local refusal", q)
		}
		res, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "m")}})
		if err != nil {
			t.Fatalf("a mixed delivery must not need the capability: %v", err)
		}
		if d := w.receive(res.TaskID); string(d.files["m/y"]) != "1" || len(d.files["m/x"]) != 0 {
			t.Fatal("mixed delivery differs")
		}
	})

	t.Run("rollback between the two reads is caught", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		root := writeTree(t, map[string][]byte{"e/a": {}})
		// The first device-list read sees the current server; the server is
		// rolled back before the fresh read that precedes the first write.
		w.env.Faults.Add(&sendtest.Rule{Method: http.MethodGet, PathSuffix: "/api/devices", Skip: 1, Action: sendtest.Before,
			Fn: func(*http.Request) { w.env.Faults.SetLegacyServer(true) }})
		_, err := w.session().Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "e")}})
		refusedCleanly(t, w, err, 0)
		if q := w.env.QuotaBytes(w.uid); q != 0 {
			t.Fatalf("quota = %d", q)
		}
	})

	t.Run("promote, roll back, promote again", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		root := writeTree(t, map[string][]byte{"e/a": {}, "f/b": {}, "g/c": {}})
		s := w.session()
		if _, err := s.Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "e")}}); err != nil {
			t.Fatalf("send on the current server: %v", err)
		}
		w.env.Faults.SetLegacyServer(true)
		inits := w.env.Faults.Hits(sendtest.KeyInit)
		_, err := s.Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "f")}})
		refusedCleanly(t, w, err, inits)
		if q := w.env.QuotaBytes(w.uid); q != quotaFloor {
			t.Fatalf("quota = %d; only the send before the rollback may be charged", q)
		}
		w.env.Faults.SetLegacyServer(false)
		if _, err := s.Send(context.Background(), SendRequest{To: w.target.id, Paths: []string{filepath.Join(root, "g")}}); err != nil {
			t.Fatalf("send after promoting again: %v", err)
		}
		if q := w.env.QuotaBytes(w.uid); q != 2*quotaFloor {
			t.Fatalf("quota = %d; want two floors", q)
		}
	})
}
