package xfer

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// W-N26: a missing destination root. Since mkdirAllWithin moved the containment
// check ahead of directory creation, a push into a directory that did not exist
// yet failed every file as an "integrity" failure while both Send and Receive
// returned nil. RecvOpts.CreateDestDir restores the creation for the local
// callers that choose the root themselves, after every refusal has had its
// chance and before any other effect.

// rootTree writes a small nested source tree and returns its manifest. The
// nesting matters: the fix creates destDir itself, and the files under a
// subdirectory prove that mkdirAllWithin's containment path still runs inside
// the root it just created.
func rootTree(t *testing.T) (Manifest, []string, map[string][]byte) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "tree")
	want := map[string][]byte{
		"tree/top.bin":          []byte("top\x00\xff\r\n"),
		"tree/sub/deeper/b.txt": []byte("nested bytes"),
		"tree/sub/empty":        {},
	}
	for rel, body := range want {
		p := filepath.Join(filepath.Dir(src), filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m, srcs, err := BuildManifest([]string{src})
	if err != nil {
		t.Fatal(err)
	}
	return m, srcs, want
}

func assertTree(t *testing.T, root string, want map[string][]byte) {
	t.Helper()
	for rel, body := range want {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil || !bytes.Equal(got, body) {
			t.Fatalf("%s = %q (err %v), want %q", rel, got, err, body)
		}
	}
	var n int
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			n++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != len(want) {
		t.Fatalf("destination holds %d files, want exactly %d", n, len(want))
	}
}

// assertEmptyDir fails unless dir holds nothing at all: the parent of a root
// that must not have been created.
func assertEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("%s gained %q; nothing may be created here", dir, names)
	}
}

// T1: the defect itself. A real Send into a real Receive, root two levels deep
// and absent: every byte lands, the root is a real directory, no staging file
// is left, and nothing is reported failed.
func TestReceiveCreatesAMissingNestedRoot(t *testing.T) {
	m, srcs, want := rootTree(t)
	root := filepath.Join(t.TempDir(), "new", "nested")
	rep, _, serr, rerr := pipeTransfer(t, m, srcs, root, SendOpts{}, RecvOpts{CreateDestDir: true})
	if serr != nil || rerr != nil || len(rep.Failed) != 0 {
		t.Fatalf("missing root: send=%v recv=%v failed=%v", serr, rerr, rep.Failed)
	}
	if fi, err := os.Lstat(root); err != nil || !fi.IsDir() {
		t.Fatalf("root is not a real directory: %v %v", fi, err)
	}
	assertTree(t, root, want)
	if rep.Files != len(want) {
		t.Fatalf("report counted %d files, want %d", rep.Files, len(want))
	}
	if left := stagingFiles(t, filepath.Join(root, "tree")); len(left) != 0 {
		t.Fatalf("staging left behind: %v", left)
	}
}

// The `__recv` helper carries `sync` over SSH, so an authorized sync into a
// missing root must create it too.
func TestAuthorizedSyncCreatesAMissingRoot(t *testing.T) {
	m, srcs, want := rootTree(t)
	root := filepath.Join(t.TempDir(), "mirror")
	rep, _, serr, rerr := pipeTransfer(t, m, srcs, root, SendOpts{Sync: true}, RecvOpts{AllowSync: true, CreateDestDir: true})
	if serr != nil || rerr != nil || len(rep.Failed) != 0 {
		t.Fatalf("sync into a missing root: send=%v recv=%v failed=%v", serr, rerr, rep.Failed)
	}
	assertTree(t, root, want)
}

// T2: without the opt-in (serve's setting) a missing root is never created,
// whatever else happens to the transfer.
func TestReceiveWithoutOptInNeverCreatesTheRoot(t *testing.T) {
	m, srcs, _ := rootTree(t)
	parent := t.TempDir()
	root := filepath.Join(parent, "gone")
	_, _, _, _ = pipeTransfer(t, m, srcs, root, SendOpts{}, RecvOpts{})
	assertEmptyDir(t, parent)
}

// scriptedRootPeer is the frame stream a hostile or broken peer could send up
// to and including its manifest.
func scriptedRootPeer(t *testing.T, hello Hello, m Manifest) *scriptedPeer {
	t.Helper()
	var in bytes.Buffer
	mustWrite(t, &in, MsgHello, hello)
	mustWrite(t, &in, MsgManifest, m)
	return &scriptedPeer{Reader: &in}
}

// T3/T4: every refusal that precedes the first frame the receiver sends back
// must also precede the root's creation. A refused transfer leaves no trace.
func TestRefusedTransferNeverCreatesTheRoot(t *testing.T) {
	many := make([]FileEntry, maxManifestFiles+1)
	for i := range many {
		many[i] = FileEntry{Path: fmt.Sprintf("f%d", i)}
	}
	cases := []struct {
		name  string
		hello Hello
		m     Manifest
		opts  RecvOpts
	}{
		{"wire version", Hello{Version: WireVersion + 1, Mode: "push"}, Manifest{Files: []FileEntry{{Path: "a"}}}, RecvOpts{}},
		{"duplicate path", Hello{Version: WireVersion, Mode: "push"}, Manifest{Files: []FileEntry{{Path: "a"}, {Path: "./a"}}}, RecvOpts{}},
		{"empty path", Hello{Version: WireVersion, Mode: "push"}, Manifest{Files: []FileEntry{{Path: ""}}}, RecvOpts{}},
		{"negative size", Hello{Version: WireVersion, Mode: "push"}, Manifest{Files: []FileEntry{{Path: "a", Size: -1}}}, RecvOpts{}},
		{"too many files", Hello{Version: WireVersion, Mode: "push"}, Manifest{Files: many}, RecvOpts{}},
		{"unauthorized sync", Hello{Version: WireVersion, Mode: "push", Sync: true}, Manifest{Files: []FileEntry{{Path: "a"}}}, RecvOpts{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "new", "root")
			c.opts.CreateDestDir = true
			if _, err := Receive(scriptedRootPeer(t, c.hello, c.m), root, c.opts); err == nil {
				t.Fatal("the transfer was accepted")
			}
			assertEmptyDir(t, parent)
		})
	}
}

// The same unauthorized sync through the real sender, so the refusal ordering
// is proven against the actual protocol rather than only a scripted one.
func TestUnauthorizedSyncThroughTheRealSenderCreatesNoRoot(t *testing.T) {
	m, srcs, _ := rootTree(t)
	parent := t.TempDir()
	_, _, _, rerr := pipeTransfer(t, m, srcs, filepath.Join(parent, "r"), SendOpts{Sync: true}, RecvOpts{CreateDestDir: true})
	if rerr == nil {
		t.Fatal("unauthorized sync was accepted")
	}
	assertEmptyDir(t, parent)
}

// T7: an empty manifest has nothing to put in a root, so it gets none.
func TestEmptyManifestCreatesNoRoot(t *testing.T) {
	for _, sync := range []bool{false, true} {
		t.Run(fmt.Sprintf("sync=%v", sync), func(t *testing.T) {
			parent := t.TempDir()
			peer := scriptedRootPeer(t, Hello{Version: WireVersion, Mode: "push", Sync: sync}, Manifest{})
			rep, err := Receive(peer, filepath.Join(parent, "r"), RecvOpts{AllowSync: true, CreateDestDir: true})
			if err != nil || len(rep.Failed) != 0 {
				t.Fatalf("empty manifest: err=%v failed=%v", err, rep.Failed)
			}
			assertEmptyDir(t, parent)
		})
	}
}

// T5: a dangling symlink in the root's place. MkdirAll must not create the
// directory it points at, and the link itself must be left as it was.
func TestDanglingSymlinkRootIsRefusedWithoutWritingItsTarget(t *testing.T) {
	m, srcs, _ := rootTree(t)
	base := t.TempDir()
	target := filepath.Join(base, "target")
	root := filepath.Join(base, "root")
	if err := os.Symlink(target, root); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	rep, _, serr, rerr := pipeTransfer(t, m, srcs, root, SendOpts{}, RecvOpts{CreateDestDir: true})
	assertCreateRootRefused(t, rep, serr, rerr)
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatalf("the dangling link's target was created (lstat err=%v)", err)
	}
	if got, err := os.Readlink(root); err != nil || got != target {
		t.Fatalf("root link changed: %q %v", got, err)
	}
}

// T6: a regular file where the root, or one of its parents, should be. The
// file keeps its bytes and the transfer fails as a whole. An ordinary push is
// already stopped by the no-clobber preflight (ENOTDIR below a file); sync has
// no preflight, so it is the case that actually reaches the root step.
func TestFileInTheRootsPlaceIsRefusedUnchanged(t *testing.T) {
	for _, c := range []struct {
		name         string
		sync, nested bool
	}{{"push", false, false}, {"sync", true, false}, {"sync nested", true, true}} {
		t.Run(c.name, func(t *testing.T) {
			m, srcs, _ := rootTree(t)
			file := filepath.Join(t.TempDir(), "occupied")
			if err := os.WriteFile(file, []byte("keep me"), 0o600); err != nil {
				t.Fatal(err)
			}
			root := file
			if c.nested {
				root = filepath.Join(file, "below")
			}
			rep, _, serr, rerr := pipeTransfer(t, m, srcs, root, SendOpts{Sync: c.sync}, RecvOpts{AllowSync: true, CreateDestDir: true})
			if c.sync {
				assertCreateRootRefused(t, rep, serr, rerr)
			} else if rerr == nil || serr == nil || len(rep.Failed) != 0 {
				t.Fatalf("push into a file: send=%v recv=%v failed=%v", serr, rerr, rep.Failed)
			}
			if got, _ := os.ReadFile(file); string(got) != "keep me" {
				t.Fatalf("the file in the root's place changed: %q", got)
			}
		})
	}
}

// A creation failure is the transfer's error, surfaced locally: not a per-file
// "integrity" verdict, and not a wire frame telling the peer anything new about
// this filesystem. The sender learns only that the stream ended.
func assertCreateRootRefused(t *testing.T, rep Report, serr, rerr error) {
	t.Helper()
	if rerr == nil || !strings.Contains(rerr.Error(), "create destination directory") {
		t.Fatalf("receiver error = %v, want the root creation failure", rerr)
	}
	if len(rep.Failed) != 0 || rep.Files != 0 {
		t.Fatalf("a root failure was reported per file: files=%d failed=%v", rep.Files, rep.Failed)
	}
	if serr == nil {
		t.Fatal("the sender believed the transfer succeeded")
	}
}

func TestRootFailureSendsNoFrameToThePeer(t *testing.T) {
	file := filepath.Join(t.TempDir(), "occupied")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	peer := scriptedRootPeer(t, Hello{Version: WireVersion, Mode: "push", Sync: true}, Manifest{Files: []FileEntry{{Path: "a"}}})
	if _, err := Receive(peer, file, RecvOpts{AllowSync: true, CreateDestDir: true}); err == nil {
		t.Fatal("receive into a file accepted")
	}
	if peer.out.Len() != 0 {
		t.Fatalf("the receiver wrote %d byte(s) back to the peer", peer.out.Len())
	}
}

// An existing root reached through a symlink the user chose stays a valid
// root: creation is a no-op there and files land in the link's target.
func TestSymlinkToAnExistingRootStillReceives(t *testing.T) {
	m, srcs, want := rootTree(t)
	base := t.TempDir()
	target := filepath.Join(base, "real")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "link")
	if err := os.Symlink(target, root); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	rep, _, serr, rerr := pipeTransfer(t, m, srcs, root, SendOpts{}, RecvOpts{CreateDestDir: true})
	if serr != nil || rerr != nil || len(rep.Failed) != 0 {
		t.Fatalf("symlinked existing root: send=%v recv=%v failed=%v", serr, rerr, rep.Failed)
	}
	assertTree(t, target, want)
}
