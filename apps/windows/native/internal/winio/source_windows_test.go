//go:build windows

// What the source walk refuses, on a real filesystem.
//
// Every positive claim here is paired with a negative control. "A junction
// ancestor is refused" proves nothing on its own — a walker that refused
// everything would pass it — so each refusal test also reads the SAME bytes by a
// path that should work.
package winio

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
	"golang.org/x/sys/windows"
)

func writeFile(t *testing.T, path string, contents []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, contents, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readAll(t *testing.T, src *Source) []byte {
	t.Helper()
	var out []byte
	buf := make([]byte, 64<<10)
	var off int64
	for {
		n, err := src.ReadAt(buf, off)
		out = append(out, buf[:n]...)
		off += int64(n)
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatalf("read at %d: %v", off, err)
		}
		if n == 0 {
			return out
		}
	}
}

func codeOf(t *testing.T, err error) wire.Code {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a refusal, got none")
	}
	return wire.CodeOf(err)
}

// The control every other test is measured against. If this fails, the fixture
// tree itself is not walkable — for instance a redirected TEMP — and the
// refusal tests below would pass for the wrong reason.
func TestReadsExactBytesFromAnOrdinaryFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deep", "nested", "payload.bin")
	want := bytes.Repeat([]byte("relayium"), 40000) // > one 192 KiB read
	writeFile(t, path, want)

	src, err := OpenSource(path)
	if err != nil {
		t.Fatalf("control read refused, so the fixture tree is unsuitable: %v", err)
	}
	defer src.Close()

	if src.Size() != int64(len(want)) {
		t.Fatalf("size = %d, want %d", src.Size(), len(want))
	}
	if got := readAll(t, src); !bytes.Equal(got, want) {
		t.Fatalf("bytes differ: got %d, want %d", len(got), len(want))
	}
}

// The load-bearing difference from the receive path, stated as a contrast.
//
// `openRoot` FOLLOWS a junction at the chosen root, correctly, because the user
// picked that folder in a native dialog. A source path carries no such
// authority: the folder may be a junction pointing somewhere the user cannot
// see. So the same directory that openRoot accepts must be refused here.
func TestSelectedRootJunctionIsFollowedByReceiveAndRefusedBySource(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	link := filepath.Join(dir, "link")
	writeFile(t, filepath.Join(real, "secret.txt"), []byte("contents"))
	if err := makeJunction(link, real); err != nil {
		t.Skipf("cannot create a junction here: %v", err)
	}
	defer removeJunction(link)

	// Receive: the junction is followed on purpose.
	h, err := openRoot(link)
	if err != nil {
		t.Fatalf("openRoot refused a junction it is supposed to follow: %v", err)
	}
	windows.CloseHandle(h)

	// Source: the same component is refused.
	_, err = OpenSource(filepath.Join(link, "secret.txt"))
	if got := codeOf(t, err); got != wire.CodeReparseComponent {
		t.Fatalf("code = %s, want %s", got, wire.CodeReparseComponent)
	}
	// Negative control: the identical bytes by the real path succeed, so the
	// refusal above is about the junction and not about the file.
	src, err := OpenSource(filepath.Join(real, "secret.txt"))
	if err != nil {
		t.Fatalf("the real path was also refused: %v", err)
	}
	defer src.Close()
	if got := readAll(t, src); string(got) != "contents" {
		t.Fatalf("bytes = %q", got)
	}
}

func TestInteriorJunctionAncestorIsRefused(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(dir, "outside")
	writeFile(t, filepath.Join(outside, "leaf.txt"), []byte("outside bytes"))
	root := filepath.Join(dir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	link := filepath.Join(root, "hop")
	if err := makeJunction(link, outside); err != nil {
		t.Skipf("cannot create a junction here: %v", err)
	}
	defer removeJunction(link)

	if got := codeOf(t, secondOf(OpenSource(filepath.Join(link, "leaf.txt")))); got != wire.CodeReparseComponent {
		t.Fatalf("code = %s", got)
	}
	src, err := OpenSource(filepath.Join(outside, "leaf.txt"))
	if err != nil {
		t.Fatalf("negative control refused: %v", err)
	}
	src.Close()
}

// Nothing in this walker can bring an object into existence, whatever it is
// handed. FILE_OPEN is the only disposition used.
func TestAMissingPathCreatesNothing(t *testing.T) {
	dir := t.TempDir()
	missingLeaf := filepath.Join(dir, "absent.txt")
	missingTree := filepath.Join(dir, "a", "b", "c.txt")

	if got := codeOf(t, secondOf(OpenSource(missingLeaf))); got != wire.CodeNotFound {
		t.Fatalf("code = %s", got)
	}
	if got := codeOf(t, secondOf(OpenSource(missingTree))); got != wire.CodeNotFound {
		t.Fatalf("code = %s", got)
	}
	for _, p := range []string{missingLeaf, filepath.Join(dir, "a")} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Fatalf("%s exists after a refused open", filepath.Base(p))
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("the refused opens left %d entries behind", len(entries))
	}
}

func TestDirectoryLeafIsRefused(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// FILE_NON_DIRECTORY_FILE refuses it at open time; either that refusal or
	// the explicit regular-file check is acceptable, but it must not succeed.
	if _, err := OpenSource(sub); err == nil {
		t.Fatalf("a directory was opened as a source")
	}
}

// Shape refusals cost one comparison and no syscall, so a hostile path never
// reaches the filesystem at all.
func TestShapesAreRefusedBeforeTheFilesystem(t *testing.T) {
	cases := []struct {
		name string
		path string
	}{
		{"unc", `\\server\share\file.txt`},
		{"extended length", `\\?\C:\file.txt`},
		{"device namespace", `\\.\C:\file.txt`},
		{"bare device", `\\.\PhysicalDrive0`},
		{"forward slash", `C:/Users/x/file.txt`},
		{"relative", `file.txt`},
		{"drive relative", `C:file.txt`},
		{"parent traversal", `C:\a\..\b.txt`},
		{"current directory", `C:\a\.\b.txt`},
		{"doubled separator", `C:\a\\b.txt`},
		{"trailing separator", `C:\a\b\`},
		{"volume root only", `C:\`},
		{"alternate data stream", `C:\a\b.txt:stream`},
		{"trailing dot", `C:\a\b.`},
		{"trailing space", `C:\a\b `},
		{"wildcard", `C:\a\*.txt`},
		{"control character", "C:\\a\\b\x01.txt"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := OpenSource(c.path)
			got := codeOf(t, err)
			if got != CodeSourcePath && got != wire.CodeUnsupportedVolume {
				t.Fatalf("code = %s, want a shape refusal", got)
			}
		})
	}
}

// Identity is exact, nonzero and string-encoded. The hardlink case is the proof
// that it identifies the FILE rather than the name used to reach it.
func TestIdentityIsExactNonzeroAndPerFile(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.txt")
	b := filepath.Join(dir, "b.txt")
	writeFile(t, a, []byte("a"))
	writeFile(t, b, []byte("b"))

	srcA, err := OpenSource(a)
	if err != nil {
		t.Fatalf("open a: %v", err)
	}
	defer srcA.Close()
	volA, idA := srcA.Identity()
	if len(volA) != 16 || len(idA) != 32 {
		t.Fatalf("identity is not fixed-width hex: %q %q", volA, idA)
	}
	if strings.Trim(volA, "0") == "" || strings.Trim(idA, "0") == "" {
		t.Fatalf("identity is zero: %q %q", volA, idA)
	}
	if strings.ToLower(volA) != volA || strings.ToLower(idA) != idA {
		t.Fatalf("identity is not lowercase hex: %q %q", volA, idA)
	}

	srcB, err := OpenSource(b)
	if err != nil {
		t.Fatalf("open b: %v", err)
	}
	defer srcB.Close()
	_, idB := srcB.Identity()
	if idA == idB {
		t.Fatalf("two different files share a file id: %q", idA)
	}

	link := filepath.Join(dir, "hardlink.txt")
	if err := os.Link(a, link); err != nil {
		t.Skipf("hard links unavailable here: %v", err)
	}
	srcLink, err := OpenSource(link)
	if err != nil {
		t.Fatalf("open hardlink: %v", err)
	}
	defer srcLink.Close()
	volLink, idLink := srcLink.Identity()
	if volLink != volA || idLink != idA {
		t.Fatalf("a hard link to the same file reported a different identity: %q/%q vs %q/%q",
			volLink, idLink, volA, idA)
	}
}

// Ancestor handles are RETAINED, without FILE_SHARE_DELETE. A rename needs
// DELETE access on the object, so an ancestor cannot be moved away while a read
// is outstanding — and the negative control proves Close really lets go.
func TestAncestorsArePinnedUntilCloseAndReleasedByIt(t *testing.T) {
	dir := t.TempDir()
	ancestor := filepath.Join(dir, "pinned")
	writeFile(t, filepath.Join(ancestor, "leaf.txt"), []byte("bytes"))

	src, err := OpenSource(filepath.Join(ancestor, "leaf.txt"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	moved := filepath.Join(dir, "moved")
	if err := os.Rename(ancestor, moved); err == nil {
		src.Close()
		t.Fatalf("an ancestor was renamed while a source was open")
	}
	if err := src.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Negative control: the same rename succeeds once the source is closed, so
	// the refusal above was the pin and not an unrelated failure.
	if err := os.Rename(ancestor, moved); err != nil {
		t.Fatalf("the ancestor was still pinned after Close: %v", err)
	}
}

func TestEOFAndCloseLifecycle(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "small.txt")
	writeFile(t, path, []byte("12345"))

	src, err := OpenSource(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	buf := make([]byte, 8)

	n, err := src.ReadAt(buf, 0)
	if n != 5 || err != nil {
		t.Fatalf("short read at start: n=%d err=%v", n, err)
	}
	if n, err := src.ReadAt(buf, 5); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("read at EOF: n=%d err=%v", n, err)
	}
	if n, err := src.ReadAt(buf, 1<<30); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("read far past EOF: n=%d err=%v", n, err)
	}
	if _, err := src.ReadAt(buf, -1); codeOf(t, err) != wire.CodeProtocol {
		t.Fatalf("a negative offset was accepted")
	}

	if err := src.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Idempotent, and a read through a released handle is refused rather than
	// attempted.
	if err := src.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := src.ReadAt(buf, 0); codeOf(t, err) != wire.CodeSequence {
		t.Fatalf("a read after close was attempted")
	}
}

// A mount point is a reparse point, so the crossing is refused by the same rule
// that refuses a junction. Skipped rather than faked when no second volume is
// mounted: a test that quietly passes without exercising the case would be
// worse than an honest skip.
func TestMountPointCrossingIsRefused(t *testing.T) {
	dir := t.TempDir()
	mount := filepath.Join(dir, "mounted")
	if err := os.Mkdir(mount, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	volume := os.Getenv("RELAYIUM_TEST_SECOND_VOLUME")
	if volume == "" {
		t.Skip("set RELAYIUM_TEST_SECOND_VOLUME to a volume GUID path to exercise mount-point crossing")
	}
	if err := setMountPoint(mount, volume); err != nil {
		t.Skipf("cannot mount here: %v", err)
	}
	defer removeMountPoint(mount)
	if got := codeOf(t, secondOf(OpenSource(filepath.Join(mount, "anything.txt")))); got != wire.CodeReparseComponent {
		t.Fatalf("code = %s", got)
	}
}

func secondOf(_ *Source, err error) error { return err }

// setMountPoint mounts a volume at an empty directory. Both arguments must end
// in a backslash; SetVolumeMountPointW rejects them otherwise.
func setMountPoint(dir, volumeGUID string) error {
	return windows.SetVolumeMountPoint(mustUTF16(withTrailingSeparator(dir)),
		mustUTF16(withTrailingSeparator(volumeGUID)))
}

func removeMountPoint(dir string) error {
	return windows.DeleteVolumeMountPoint(mustUTF16(withTrailingSeparator(dir)))
}

func withTrailingSeparator(p string) string {
	if strings.HasSuffix(p, `\`) {
		return p
	}
	return p + `\`
}
