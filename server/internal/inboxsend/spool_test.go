//go:build darwin || linux

package inboxsend

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// Stage R (`inbox send --resumable`) against the REAL account.Service,
// SQLite and DiskStore. Faults sit in front of the real handlers; restarts are
// a fresh Session over the same configuration directory (the process-level
// SIGKILL cases live in cmd/relayium).

func sendResumable(t *testing.T, w *world, ctx context.Context, paths ...string) (Result, *Error) {
	t.Helper()
	res, err := w.session().Send(ctx, SendRequest{To: w.target.id, Paths: paths, Resumable: true})
	if err != nil {
		e := AsError(err)
		if e == nil {
			t.Fatalf("send: %v", err)
		}
		return res, e
	}
	return res, nil
}

func theRecord(t *testing.T, w *world) *Journal {
	t.Helper()
	st := newJournalStore(w.cfgDir)
	ids, err := st.ids()
	if err != nil || len(ids) != 1 {
		t.Fatalf("records = %v, %v; want exactly one", ids, err)
	}
	j, err := st.load(ids[0])
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func spoolBytes(t *testing.T, w *world, id string) []byte {
	t.Helper()
	b, err := os.ReadFile(newJournalStore(w.cfgDir).spoolPath(id))
	if err != nil {
		t.Fatalf("spool: %v", err)
	}
	return b
}

// assertJournalDirEmpty: nothing but lock files may remain once a send is done.
func assertNoSendState(t *testing.T, w *world) {
	t.Helper()
	for name := range w.journalFiles() {
		if !strings.HasSuffix(name, ".lock") {
			t.Fatalf("left behind in the send record directory: %s", name)
		}
	}
}

// contentKeyOf opens the record's wrapped key with the target's private key:
// the one way a test can learn the content key without a product hook.
func contentKeyOf(t *testing.T, w *world, j *Journal) []byte {
	t.Helper()
	sealed, err := base64.RawURLEncoding.Strict().DecodeString(j.WrappedKey)
	if err != nil {
		t.Fatal(err)
	}
	k, ok := box.OpenAnonymous(nil, sealed, w.target.pub[j.TargetKeyID], w.target.keys[j.TargetKeyID])
	if !ok {
		t.Fatal("wrapped key does not open")
	}
	return k
}

// assertKeyNowhere scans every file under the configuration directory (the
// record, the copy, the credential, locks) and the notices for the key.
func assertKeyNowhere(t *testing.T, w *world, key []byte, extra ...string) {
	t.Helper()
	_ = filepath.WalkDir(w.cfgDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		b, rerr := os.ReadFile(p)
		if rerr == nil {
			assertNoKey(t, p, b, key)
		}
		return nil
	})
	assertNoKey(t, "notices", w.notice.Bytes(), key)
	for _, s := range extra {
		assertNoKey(t, "an error message", []byte(s), key)
	}
}

// rewriteInPlace changes every byte of a file without changing its length,
// then puts its modification time back: the stat fingerprint is identical
// while the content is not (design §3.3, probe R2a).
func rewriteInPlace(t *testing.T, path string) {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := range b {
		b[i] ^= 0xa5
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt(b, 0); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := os.Chtimes(path, st.ModTime(), st.ModTime()); err != nil {
		t.Fatal(err)
	}
}

// cancelAt cancels the send's context when the matched request reaches
// central (the real handler still runs, so the chunk may or may not commit).
func cancelAt(w *world, at sendtest.Rule, skip int) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	r := at
	r.Skip, r.Action, r.Fn = skip, sendtest.Before, func(*http.Request) { cancel() }
	w.env.Faults.Add(&r)
	return ctx, cancel
}

// R1: the happy path. The whole send is encrypted into the copy before the
// upload opens; what goes on the wire is exactly the copy; nothing is left.
func TestResumableSendUploadsTheCopyAndLeavesNothing(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 64<<20)
	big := randomBytes(t, 9<<20+777)
	root := writeTree(t, map[string][]byte{"d/big.bin": big, "d/note.txt": []byte("note")})
	var sawCopyBeforeInit atomic.Bool
	w.env.Faults.SetObserve(func(kind string) {
		if kind != sendtest.KeyInit {
			return
		}
		for name := range w.journalFiles() {
			if strings.HasSuffix(name, spoolSuffix) {
				sawCopyBeforeInit.Store(true)
			}
		}
	})
	res, e := sendResumable(t, w, context.Background(), filepath.Join(root, "d"))
	if e != nil {
		t.Fatalf("send: %v", e)
	}
	if !sawCopyBeforeInit.Load() {
		t.Fatal("the upload was opened before the complete local copy existed")
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 || len(w.tasks()) != 1 {
		t.Fatalf("hits %+v tasks %d", h, len(w.tasks()))
	}
	got := w.receive(res.TaskID)
	if !bytes.Equal(got.files["d/big.bin"], big) || string(got.files["d/note.txt"]) != "note" {
		t.Fatal("delivered content differs")
	}
	assertBytesMatchFinalBlob(t, w.env.Faults.Patches(), got.blob)
	if want := framesFor(len(big), 4) + 1; reg.seals() != want {
		t.Fatalf("sealed %d units, want %d", reg.seals(), want)
	}
	assertNoSendState(t, w)
	assertKeyNowhere(t, w, got.contentKey)
}

// R2: interrupted mid-upload, the source rewritten in place with its stat
// fingerprint restored, then resumed by a new session: the upload continues
// at the server's offset with bytes from the copy — never the changed source
// — nothing is sealed again, and exactly one upload is completed and counted.
func TestResumableRetryContinuesFromTheCopyNotTheChangedSource(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 64<<20)
	orig := randomBytes(t, 17<<20+4321) // three 8 MiB server chunks
	root := writeTree(t, map[string][]byte{"big.bin": orig})
	src := filepath.Join(root, "big.bin")
	ctx, cancel := cancelAt(w, atPatch, 1)
	defer cancel()
	_, e := sendResumable(t, w, ctx, src)
	if e == nil || e.Class != ClassInterrupted || e.LocalSendID == "" {
		t.Fatalf("err = %v; want interrupted with the record kept", e)
	}
	if !strings.Contains(e.Msg, "inbox retry "+e.LocalSendID) {
		t.Fatalf("message does not say how to resume: %s", e.Msg)
	}
	j := theRecord(t, w)
	if j.Phase != PhaseUploading || !j.Spooled() || j.ChunkSize <= 0 {
		t.Fatalf("record = %+v", j)
	}
	copyBefore := spoolBytes(t, w, j.ID)
	key := contentKeyOf(t, w, j)
	assertKeyNowhere(t, w, key, e.Msg)

	rewriteInPlace(t, src)
	sealsBefore := reg.seals()
	patchesBefore := len(w.env.Faults.Patches())
	res, err := w.session().Retry(context.Background(), j.ID)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if reg.seals() != sealsBefore {
		t.Fatalf("N3: retry sealed %d units", reg.seals()-sealsBefore)
	}
	after := w.env.Faults.Patches()[patchesBefore:]
	if len(after) == 0 || after[0].Start == 0 {
		t.Fatalf("the retry did not continue at the server's offset (%d PATCHes after the restart)", len(after))
	}
	if h := hitsOf(w); h.init != 1 || h.finalize != 1 || h.create != 1 || len(w.tasks()) != 1 {
		t.Fatalf("hits %+v tasks %d; want one upload, one finalize, one task", h, len(w.tasks()))
	}
	got := w.receive(res.TaskID)
	if !bytes.Equal(got.files["big.bin"], orig) {
		t.Fatal("the delivery is not what was encrypted before the source changed")
	}
	if !bytes.Equal(copyBefore[j.HeaderBytes:], got.blob) {
		t.Fatal("the committed ciphertext is not the local copy")
	}
	assertBytesMatchFinalBlob(t, w.env.Faults.Patches(), got.blob)
	if !bytes.Equal(got.contentKey, key) {
		t.Fatal("a different key")
	}
	assertNoSendState(t, w)
	assertKeyNowhere(t, w, key)
}

// R3: the answer to the upload's init is lost (central opened a session whose
// id never arrived). The record says planned — no byte was ever appended to
// any session — so the retry opens a new upload from the same copy. One
// upload is completed and counted, one task, the original content.
func TestResumableLostInitIsStartedAgainFromTheCopy(t *testing.T) {
	fastBackoff(t)
	reg := watchNonces(t)
	w := newWorld(t, 16<<20)
	orig := []byte("init answer lost; delivered from the copy")
	root := writeTree(t, map[string][]byte{"a.txt": orig})
	r := atInit
	r.Action, r.Times = sendtest.DropResponse, 1
	w.env.Faults.Add(&r)
	_, e := sendResumable(t, w, context.Background(), filepath.Join(root, "a.txt"))
	if e == nil || e.Code != CodeNetwork || e.LocalSendID == "" {
		t.Fatalf("err = %v; want network with the record kept", e)
	}
	j := theRecord(t, w)
	if j.Phase != PhasePlanned {
		t.Fatalf("phase = %s", j.Phase)
	}
	rewriteInPlace(t, filepath.Join(root, "a.txt"))
	seals := reg.seals()
	res, err := w.session().Retry(context.Background(), j.ID)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if reg.seals() != seals {
		t.Fatal("N3: retry sealed")
	}
	if h := hitsOf(w); h.init != 2 || h.finalize != 1 || h.create != 1 || len(w.tasks()) != 1 {
		t.Fatalf("hits %+v tasks %d", h, len(w.tasks()))
	}
	if got := w.receive(res.TaskID); !bytes.Equal(got.files["a.txt"], orig) {
		t.Fatal("content differs from what was encrypted")
	}
	assertNoSendState(t, w)
}

// R4: every checkpoint of a resumable send fails on a real filesystem error in
// turn. The record as it stood and the local copy are both kept (the copy is
// never removed while a record that may need it could not be written), and a
// new session finishes the send exactly once.
func TestResumableCheckpointFailureKeepsTheCopyAndRetryConverges(t *testing.T) {
	for _, tc := range []struct {
		name      string
		at        sendtest.Rule
		code      string
		phase     string
		wantInits int
	}{
		{"upload id not recorded", atInit, CodeJournalWrite, PhasePlanned, 2},
		{"finalizing not recorded", atPatch, CodeJournalWrite, PhaseUploading, 1},
		{"object not recorded", atFinalize, CodeJournalWrite, PhaseFinalizing, 1},
		{"record not removed after the create", atCreate, "", PhaseFinalized, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fastBackoff(t)
			watchNonces(t)
			w := newWorld(t, 4<<20)
			b := breakAt(w, tc.at)
			root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
			res, e := sendResumable(t, w, context.Background(), filepath.Join(root, "a.txt"))
			if tc.code != "" {
				if e == nil || e.Code != tc.code {
					t.Fatalf("err = %v; want %s", e, tc.code)
				}
			} else if e != nil || res.TaskID == "" {
				t.Fatalf("send = %+v, %v; want queued", res, e)
			}
			j := b.restore(w)
			if j.Phase != tc.phase {
				t.Fatalf("kept record phase = %s, want %s", j.Phase, tc.phase)
			}
			if _, err := os.Stat(newJournalStore(w.cfgDir).spoolPath(j.ID)); err != nil {
				t.Fatalf("the local copy was not kept with its record: %v", err)
			}
			quota := w.env.QuotaBytes(w.uid)
			rres, err := w.session().Retry(context.Background(), j.ID)
			if err != nil {
				t.Fatalf("retry: %v", err)
			}
			if h := hitsOf(w); h.init != tc.wantInits || len(w.tasks()) != 1 {
				t.Fatalf("hits %+v tasks %d", h, len(w.tasks()))
			}
			if tc.phase == PhaseFinalizing || tc.phase == PhaseFinalized {
				if q := w.env.QuotaBytes(w.uid); q != quota {
					t.Fatalf("quota %d -> %d: the completed upload was counted again", quota, q)
				}
			}
			if string(w.receive(rres.TaskID).files["a.txt"]) != payload {
				t.Fatal("content differs")
			}
			assertNoSendState(t, w)
		})
	}
}

// R5: before anything is encrypted or any request is made, a copy that would
// not fit, that exceeds the cap, or that would live somewhere unsafe is
// refused (exit 2) and leaves nothing behind.
func TestResumableRefusesWhereNoSafeCopyFits(t *testing.T) {
	check := func(t *testing.T, w *world, e *Error) {
		t.Helper()
		if e == nil || e.Class != ClassLocal || e.Code != CodeSpoolUnavailable || !strings.Contains(e.Msg, "othing was sent") {
			t.Fatalf("err = %v; want a local spool_unavailable refusal", e)
		}
		if n := len(w.env.Faults.Patches()) + w.env.Faults.Hits(sendtest.KeyInit) +
			w.env.Faults.Hits("GET /api/devices"); n != 0 {
			t.Fatalf("%d requests were made", n)
		}
		for name := range w.journalFiles() {
			t.Fatalf("left behind: %s", name)
		}
	}
	root := writeTree(t, map[string][]byte{"a.txt": randomBytes(t, 4096)})
	src := filepath.Join(root, "a.txt")

	t.Run("disk full", func(t *testing.T) {
		old := freeDiskBytes
		freeDiskBytes = func(string) (uint64, error) { return spoolReserve + 100, nil }
		t.Cleanup(func() { freeDiskBytes = old })
		w := newWorld(t, 4<<20)
		_, e := sendResumable(t, w, context.Background(), src)
		check(t, w, e)
		if !strings.Contains(e.Msg, "free disk space") {
			t.Fatalf("message: %s", e.Msg)
		}
	})
	t.Run("free space unknown", func(t *testing.T) {
		old := freeDiskBytes
		freeDiskBytes = func(string) (uint64, error) { return 0, errors.New("statfs failed") }
		t.Cleanup(func() { freeDiskBytes = old })
		w := newWorld(t, 4<<20)
		_, e := sendResumable(t, w, context.Background(), src)
		check(t, w, e)
	})
	t.Run("over the cap", func(t *testing.T) {
		old := maxSpoolBytes
		maxSpoolBytes = 1000
		t.Cleanup(func() { maxSpoolBytes = old })
		w := newWorld(t, 4<<20)
		_, e := sendResumable(t, w, context.Background(), src)
		check(t, w, e)
	})
	t.Run("record directory is a symlink", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		elsewhere := t.TempDir()
		if err := os.Symlink(elsewhere, filepath.Join(w.cfgDir, journalDirName)); err != nil {
			t.Fatal(err)
		}
		_, e := sendResumable(t, w, context.Background(), src)
		if e == nil || e.Code != CodeSpoolUnavailable {
			t.Fatalf("err = %v", e)
		}
		if ents, _ := os.ReadDir(elsewhere); len(ents) != 0 {
			t.Fatal("wrote through the symlink")
		}
	})
	t.Run("configuration directory writable by others", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		if err := os.Chmod(w.cfgDir, 0o777); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(w.cfgDir, 0o700) })
		_, e := sendResumable(t, w, context.Background(), src)
		if e == nil || e.Code != CodeSpoolUnavailable || !strings.Contains(e.Msg, "writable by other users") {
			t.Fatalf("err = %v", e)
		}
	})
	t.Run("an existing record directory open to others is closed", func(t *testing.T) {
		w := newWorld(t, 4<<20)
		dir := filepath.Join(w.cfgDir, journalDirName)
		if err := os.Mkdir(dir, 0o750); err != nil {
			t.Fatal(err)
		}
		if _, e := sendResumable(t, w, context.Background(), src); e != nil {
			t.Fatalf("send: %v", e)
		}
		if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
			t.Fatalf("mode = %v", fi.Mode().Perm())
		}
	})
}

// R6: a copy that is damaged, truncated, replaced by a symlink or missing is
// never uploaded from; the record and whatever is there are left as they are
// for the user to discard.
func TestResumableRefusesADamagedCopyAndKeepsTheEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		damage func(t *testing.T, path string)
	}{
		{"one byte flipped", func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			b[len(b)/2] ^= 1
			if err := os.WriteFile(p, b, 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{"truncated", func(t *testing.T, p string) {
			if err := os.Truncate(p, 100); err != nil {
				t.Fatal(err)
			}
		}},
		{"replaced by a symlink to an identical copy", func(t *testing.T, p string) {
			b, _ := os.ReadFile(p)
			other := filepath.Join(t.TempDir(), "copy")
			if err := os.WriteFile(other, b, 0o600); err != nil {
				t.Fatal(err)
			}
			os.Remove(p)
			if err := os.Symlink(other, p); err != nil {
				t.Fatal(err)
			}
		}},
		{"missing", func(t *testing.T, p string) { os.Remove(p) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fastBackoff(t)
			w := newWorld(t, 64<<20)
			root := writeTree(t, map[string][]byte{"big.bin": randomBytes(t, 9<<20)})
			ctx, cancel := cancelAt(w, atPatch, 1)
			defer cancel()
			if _, e := sendResumable(t, w, ctx, filepath.Join(root, "big.bin")); e == nil {
				t.Fatal("want interrupted")
			}
			j := theRecord(t, w)
			p := newJournalStore(w.cfgDir).spoolPath(j.ID)
			tc.damage(t, p)
			before := w.journalFiles()
			h := hitsOf(w)
			_, err := w.session().Retry(context.Background(), j.ID)
			if e := AsError(err); e == nil || e.Code != CodeSpoolCorrupt || !strings.Contains(e.Msg, "--discard "+j.ID) {
				t.Fatalf("retry = %v; want spool_corrupt pointing at --discard", err)
			}
			if got := hitsOf(w); got.init != h.init || got.patch != h.patch || got.finalize != 0 {
				t.Fatalf("hits %+v -> %+v: uploaded from a damaged copy", h, got)
			}
			after := w.journalFiles()
			for name, b := range before {
				if !strings.HasSuffix(name, ".lock") && !bytes.Equal(after[name], b) {
					t.Fatalf("%s was changed or removed", name)
				}
			}
			r, derr := Discard(w.cfgDir, j.ID)
			if derr != nil || r.Phase != PhaseUploading || !strings.Contains(r.Message, "partial upload") {
				t.Fatalf("discard = %+v, %v", r, derr)
			}
			if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("discard left the copy")
			}
			if ids, _ := newJournalStore(w.cfgDir).ids(); len(ids) != 0 {
				t.Fatal("discard left the record")
			}
		})
	}
}

// R7: a retry under another account, or from another device of the same
// account, is refused before any request that could upload, and touches
// neither the record nor the copy; back on the right login it finishes.
func TestResumableRetryUnderAnotherLoginIsRefusedSafely(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 64<<20)
	orig := randomBytes(t, 9<<20)
	root := writeTree(t, map[string][]byte{"big.bin": orig})
	ctx, cancel := cancelAt(w, atPatch, 1)
	defer cancel()
	if _, e := sendResumable(t, w, ctx, filepath.Join(root, "big.bin")); e == nil {
		t.Fatal("want interrupted")
	}
	j := theRecord(t, w)
	mine, ok, err := cloud.Load(w.cfgDir)
	if err != nil || !ok {
		t.Fatal(err)
	}
	for _, other := range []cloud.Creds{
		{Server: w.env.TS.URL, AccessToken: w.env.Login(w.env.User("someone-else@example.com"), "x"), AccountEmail: "someone-else@example.com"},
		{Server: w.env.TS.URL, AccessToken: w.env.Login(w.uid, "sender-box-again"), AccountEmail: "sender@example.com"},
	} {
		if err := cloud.Save(w.cfgDir, other); err != nil {
			t.Fatal(err)
		}
		before := w.journalFiles()
		h := hitsOf(w)
		_, err := w.session().Retry(context.Background(), j.ID)
		if e := AsError(err); e == nil || e.Code != CodeJournalMismatch {
			t.Fatalf("retry as %s = %v; want journal_mismatch", other.AccountEmail, err)
		}
		if got := hitsOf(w); got != h {
			t.Fatalf("hits %+v -> %+v", h, got)
		}
		after := w.journalFiles()
		for name, b := range before {
			if !strings.HasSuffix(name, ".lock") && !bytes.Equal(after[name], b) {
				t.Fatalf("%s was changed or removed", name)
			}
		}
	}
	if err := cloud.Save(w.cfgDir, mine); err != nil {
		t.Fatal(err)
	}
	res, err := w.session().Retry(context.Background(), j.ID)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !bytes.Equal(w.receive(res.TaskID).files["big.bin"], orig) || len(w.tasks()) != 1 {
		t.Fatal("not delivered exactly once")
	}
}

// R8: the upload session is gone when the retry comes (reaped). The retry
// never replaces it with a new upload: it fails, says a new send is a new,
// counted upload, and removes the record and the copy.
func TestResumableLostSessionIsNeverUploadedAgain(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 64<<20)
	root := writeTree(t, map[string][]byte{"big.bin": randomBytes(t, 9<<20)})
	ctx, cancel := cancelAt(w, atPatch, 1)
	defer cancel()
	if _, e := sendResumable(t, w, ctx, filepath.Join(root, "big.bin")); e == nil {
		t.Fatal("want interrupted")
	}
	j := theRecord(t, w)
	r := atStatus
	r.Action, r.Code = sendtest.Status, http.StatusNotFound
	w.env.Faults.Add(&r)
	h := hitsOf(w)
	_, err := w.session().Retry(context.Background(), j.ID)
	e := AsError(err)
	if e == nil || e.Code != CodeUploadLost || !strings.Contains(e.Msg, "new upload and is counted again") {
		t.Fatalf("retry = %v", err)
	}
	if got := hitsOf(w); got.init != h.init || got.patch != h.patch || got.finalize != 0 || len(w.tasks()) != 0 {
		t.Fatalf("hits %+v -> %+v: uploaded again", h, got)
	}
	assertNoSendState(t, w)
}

// R9: a retry while another command holds the send is refused, whatever it is
// doing; nothing is requested.
func TestResumableRetryRefusesARecordAnotherCommandHolds(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 64<<20)
	root := writeTree(t, map[string][]byte{"big.bin": randomBytes(t, 9<<20)})
	ctx, cancel := cancelAt(w, atPatch, 1)
	defer cancel()
	if _, e := sendResumable(t, w, ctx, filepath.Join(root, "big.bin")); e == nil {
		t.Fatal("want interrupted")
	}
	j := theRecord(t, w)
	lk, err := newJournalStore(w.cfgDir).lock(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	h := hitsOf(w)
	_, rerr := w.session().Retry(context.Background(), j.ID)
	if e := AsError(rerr); e == nil || e.Code != CodeJournalBusy {
		t.Fatalf("retry = %v; want journal_busy", rerr)
	}
	if _, derr := Discard(w.cfgDir, j.ID); AsError(derr) == nil || AsError(derr).Code != CodeJournalBusy {
		t.Fatalf("discard = %v; want journal_busy", derr)
	}
	if got := hitsOf(w); got != h {
		t.Fatalf("hits %+v -> %+v", h, got)
	}
	lk.release()
	if _, err := w.session().Retry(context.Background(), j.ID); err != nil {
		t.Fatalf("retry after release: %v", err)
	}
	if len(w.tasks()) != 1 {
		t.Fatal("want exactly one task")
	}
}

// R10: copies no record owns (a send killed between writing its copy and
// recording it) are collected — but never one whose send still holds its lock.
func TestOrphanCopiesAreCollectedOnlyUnderTheirLock(t *testing.T) {
	w := newWorld(t, 4<<20)
	st := newJournalStore(w.cfgDir)
	if err := st.ensurePrivate(); err != nil {
		t.Fatal(err)
	}
	orphan, busy := strings.Repeat("a", 32), strings.Repeat("b", 32)
	for _, name := range []string{orphan + spoolSuffix, "." + orphan + spoolSuffix + ".tmp-123", busy + spoolSuffix, "." + busy + spoolSuffix + ".tmp-9"} {
		if err := os.WriteFile(filepath.Join(st.dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	lk, err := st.lock(busy)
	if err != nil {
		t.Fatal(err)
	}
	defer lk.release()
	_ = w.session().LocalSends()
	files := w.journalFiles()
	for _, name := range []string{orphan + spoolSuffix, "." + orphan + spoolSuffix + ".tmp-123"} {
		if _, ok := files[name]; ok {
			t.Fatalf("orphan %s was kept", name)
		}
	}
	for _, name := range []string{busy + spoolSuffix, "." + busy + spoolSuffix + ".tmp-9"} {
		if _, ok := files[name]; !ok {
			t.Fatalf("%s was removed while its send held the lock", name)
		}
	}
}

// R11: expiry. A record that still needed its copy goes with it; a record
// already past its upload loses only the copy and can still be finished.
func TestSpooledRecordsExpire(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 64<<20)
	// One stopped mid-upload…
	root := writeTree(t, map[string][]byte{"big.bin": randomBytes(t, 9<<20)})
	ctx, cancel := cancelAt(w, atPatch, 1)
	defer cancel()
	if _, e := sendResumable(t, w, ctx, filepath.Join(root, "big.bin")); e == nil {
		t.Fatal("want interrupted")
	}
	uploading := theRecord(t, w).ID
	// …and one whose create answer was held until the command was stopped.
	root2 := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
	ctx2, cancel2 := cancelAt(w, atCreate, 0)
	defer cancel2()
	if _, e := sendResumable(t, w, ctx2, filepath.Join(root2, "a.txt")); e == nil {
		t.Fatal("want interrupted")
	}
	st := newJournalStore(w.cfgDir)
	var finalized string
	ids, _ := st.ids()
	for _, id := range ids {
		if id != uploading {
			finalized = id
		}
	}
	if j, err := st.load(finalized); err != nil || j.Phase != PhaseFinalized {
		t.Fatalf("second record = %+v, %v", j, err)
	}

	s := w.session()
	s.now = func() time.Time { return time.Now().Add(spoolMaxAge + time.Minute) }
	locals := s.LocalSends()
	if len(locals) != 1 || locals[0].LocalSendID != finalized || !locals[0].Resumable {
		t.Fatalf("locals = %+v", locals)
	}
	for _, id := range []string{uploading, finalized} {
		if _, err := os.Lstat(st.spoolPath(id)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("copy of %s not expired", id)
		}
	}
	if !strings.Contains(w.notice.String(), "can no longer be resumed") {
		t.Fatalf("notice: %s", w.notice.String())
	}
	// The finalized record needs no copy to finish.
	if _, err := w.session().Retry(context.Background(), finalized); err != nil {
		t.Fatalf("retry of the finalized record: %v", err)
	}
	if len(w.tasks()) != 1 {
		t.Fatal("want exactly one task")
	}
}

// R12: the record format. A spooled record must carry a consistent copy
// description; an ordinary record must carry none; a v1 binary's strict
// decoder refuses a v2 record rather than treating it as an ordinary send.
func TestSpooledRecordValidation(t *testing.T) {
	base := Journal{V: journalVersionSpooled, ID: strings.Repeat("c", 32), Phase: PhaseUploading,
		Server: "https://relayium.example", SourceDeviceID: "dev1", TargetDeviceID: "dev2", TargetKeyID: "key1",
		TargetKeyGeneration: 1, WrappedKey: base64.RawURLEncoding.EncodeToString(make([]byte, 80)),
		IdempotencyKey: "cli-" + strings.Repeat("d", 32), CiphertextBytes: 100, ManifestSHA256: strings.Repeat("e", 64),
		UploadID: "up1", CreatedAt: 1, SpoolBytes: 150, SpoolSHA256: strings.Repeat("f", 64), HeaderBytes: 50, ChunkSize: 8 << 20}
	if err := base.validate(); err != nil {
		t.Fatalf("valid record refused: %v", err)
	}
	for name, mut := range map[string]func(j *Journal){
		"size mismatch":         func(j *Journal) { j.SpoolBytes++ },
		"no hash":               func(j *Journal) { j.SpoolSHA256 = "" },
		"tiny header":           func(j *Journal) { j.HeaderBytes, j.SpoolBytes = 4, 104 },
		"no chunk while upload": func(j *Journal) { j.ChunkSize = 0 },
		"chunk while planned":   func(j *Journal) { j.Phase, j.UploadID = PhasePlanned, "" },
		"v1 with a copy":        func(j *Journal) { j.V = journalVersion },
		"unknown version":       func(j *Journal) { j.V = 3 },
	} {
		j := base
		mut(&j)
		if j.validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// R13: once the copy is complete the sealer can still wrap its key to a
// rotated device key (while the first process runs) but can seal nothing.
func TestSealerRefusesToSealAfterTheCopyIsComplete(t *testing.T) {
	sl, err := newSealer()
	if err != nil {
		t.Fatal(err)
	}
	defer sl.discard()
	if _, err := sl.sealManifest([]byte("m")); err != nil {
		t.Fatal(err)
	}
	if _, err := sl.frame([]byte("a")); err != nil {
		t.Fatal(err)
	}
	sl.closeSealing()
	if _, err := sl.frame([]byte("b")); err == nil {
		t.Fatal("sealed a frame after the copy was complete")
	}
	if _, err := sl.sealManifest([]byte("m")); err == nil {
		t.Fatal("sealed a manifest after the copy was complete")
	}
	pub, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sl.wrapTo(inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(pub[:])); err != nil {
		t.Fatalf("cannot re-wrap after the copy: %v", err)
	}
}

// R4b: the ORDER of removal. When the record cannot be removed, its copy is
// not removed either: the fault makes only the record's removal fail (its
// path becomes a non-empty directory), so a copy removed first or regardless
// would be observed gone.
func TestResumableCopyOutlivesARecordThatCouldNotBeRemoved(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	st := newJournalStore(w.cfgDir)
	var id string
	var saved []byte
	r := atCreate
	r.Action, r.Fn = sendtest.Before, func(*http.Request) {
		ids, _ := st.ids()
		if len(ids) != 1 {
			return
		}
		id = ids[0]
		saved, _ = os.ReadFile(st.path(id))
		os.Remove(st.path(id))
		os.MkdirAll(filepath.Join(st.path(id), "blocker"), 0o700)
	}
	w.env.Faults.Add(&r)
	root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
	res, e := sendResumable(t, w, context.Background(), filepath.Join(root, "a.txt"))
	if e != nil || res.TaskID == "" || id == "" {
		t.Fatalf("send = %+v, %v (id %q)", res, e, id)
	}
	if !strings.Contains(w.notice.String(), "cannot remove the local send record") {
		t.Fatalf("the failed removal was not reported: %s", w.notice.String())
	}
	if _, err := os.Stat(st.spoolPath(id)); err != nil {
		t.Fatalf("the copy was removed although its record could not be: %v", err)
	}
	// Restore the record as it was: a retry converges and then removes both.
	os.RemoveAll(st.path(id))
	if err := os.WriteFile(st.path(id), saved, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.session().Retry(context.Background(), id); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if len(w.tasks()) != 1 {
		t.Fatal("want exactly one task")
	}
	assertNoSendState(t, w)
}

// R14: every byte already acknowledged when the command stopped: the retry
// asks the server first and needs nothing from the copy, so even a damaged
// copy does not stop the send from being completed (without uploading).
func TestResumableFullyUploadedSendNeedsNoCopy(t *testing.T) {
	fastBackoff(t)
	w := newWorld(t, 4<<20)
	b := breakAt(w, atPatch)
	root := writeTree(t, map[string][]byte{"a.txt": []byte(payload)})
	if _, e := sendResumable(t, w, context.Background(), filepath.Join(root, "a.txt")); e == nil || e.Code != CodeJournalWrite {
		t.Fatalf("err = %v", e)
	}
	j := b.restore(w)
	if j.Phase != PhaseUploading {
		t.Fatalf("phase = %s", j.Phase)
	}
	if err := os.WriteFile(newJournalStore(w.cfgDir).spoolPath(j.ID), []byte("damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	patches := len(w.env.Faults.Patches())
	res, err := w.session().Retry(context.Background(), j.ID)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if len(w.env.Faults.Patches()) != patches || hitsOf(w).init != 1 {
		t.Fatal("uploaded again")
	}
	if string(w.receive(res.TaskID).files["a.txt"]) != payload {
		t.Fatal("content differs")
	}
	assertNoSendState(t, w)
}
