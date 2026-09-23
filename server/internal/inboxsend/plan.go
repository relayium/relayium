package inboxsend

import (
	"crypto/sha256"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxmanifest"
	"github.com/relayium/relayium/internal/storecrypto"
	"github.com/relayium/relayium/internal/termtext"
)

// Planning turns the paths a user named into the exact delivery a receiver
// will accept, BEFORE any network write. Every refusal here costs nothing; the
// same refusal on the receiver would cost an upload.
//
// A delivery is exactly what was named or a refusal — never a silently smaller
// tree:
//   - a symlink or special file INSIDE a named folder is a refusal, not a skip;
//   - an explicitly named top-level symlink is resolved once (like cp) and the
//     entry keeps the name the user typed;
//   - a name any receiver would refuse (inboxclient.CheckPortableName), or two
//     items whose names collide exactly or by case, is a refusal;
//   - an empty folder cannot be represented and is reported, not failed.

// frameOverhead is the ciphertext cost of one frame: the uint32 length prefix
// plus the 16-byte GCM tag.
const frameOverhead = 4 + 16

// planFile is one item and the source it must be read from.
type planFile struct {
	item inboxmanifest.Item
	path string
	// info is the Lstat/Stat of the planned regular file. The opened descriptor
	// must be the same file (os.SameFile), so a path replaced between planning
	// and reading cannot send a different file under this item's name.
	info os.FileInfo
}

// Plan is a validated delivery.
type Plan struct {
	files []planFile
	// manifest is the canonical encoded v3 manifest plaintext.
	manifest []byte
	// CiphertextBytes is the exact frame-stream size the upload will carry.
	CiphertextBytes int64
	// EmptyFolders are named folders (terminal-safe) that were not sent because
	// the manifest cannot represent an empty directory.
	EmptyFolders []string
}

// Items is how many files the delivery carries.
func (p *Plan) Items() int { return len(p.files) }

// ManifestSHA256 fingerprints the plan (integrity of the local record only).
func (p *Plan) ManifestSHA256() [32]byte { return sha256.Sum256(p.manifest) }

// cipherSize is the exact frame-stream length for a plaintext of size n,
// chunked per file at storecrypto.ChunkSize.
func cipherSize(n int64) int64 {
	frames := (n + storecrypto.ChunkSize - 1) / storecrypto.ChunkSize
	return n + frames*frameOverhead
}

// BuildPlan walks paths and validates the delivery. Every error is a
// ClassLocal *Error whose message may name a local path (terminal-escaped):
// the user has to be able to find what to fix, and it never leaves the machine.
func BuildPlan(paths []string) (*Plan, error) {
	if len(paths) == 0 {
		return nil, local(CodeNoFiles, "name at least one file or folder to send")
	}
	p := &Plan{}
	exact := map[string]string{}    // item name -> source, exact duplicates
	folded := map[string]string{}   // lower-cased item name -> source, case collisions
	topLevel := map[string]string{} // lower-cased top-level name -> argument
	for _, arg := range paths {
		if err := p.addArg(arg, exact, folded, topLevel); err != nil {
			return nil, err
		}
	}
	if len(p.files) == 0 {
		return nil, local(CodeNoFiles, "nothing to send: the named folders contain no files")
	}
	items := make([]inboxmanifest.Item, len(p.files))
	var total int64
	for i, f := range p.files {
		items[i] = f.item
		cs := cipherSize(f.item.Size)
		if total > storecrypto.MaxSafeInteger-cs {
			return nil, local(CodeUnsendableContent, "the delivery is too large to describe")
		}
		total += cs
	}
	if total == 0 {
		// Every file is empty, so the upload would carry no bytes and the server
		// would hold no ciphertext object for the receiver to fetch: central
		// queues the task and every receiver then fails it as unavailable.
		return nil, local(CodeUnsendableContent, "every file named is empty; a delivery must contain at least one byte")
	}
	m, err := inboxmanifest.NewFiles(items)
	if err != nil {
		return nil, localf(CodeUnsendableContent, "this delivery cannot be sent: %s", termtext.Safe(err.Error()))
	}
	enc, err := inboxmanifest.Encode(m)
	if err != nil {
		return nil, localf(CodeUnsendableContent, "this delivery cannot be sent: %s", termtext.Safe(err.Error()))
	}
	p.manifest = enc
	p.CiphertextBytes = total
	return p, nil
}

func (p *Plan) addArg(arg string, exact, folded, topLevel map[string]string) error {
	shown := termtext.Safe(arg)
	abs, err := filepath.Abs(arg)
	if err != nil {
		return localf(CodeUnsendableContent, "%s: cannot resolve this path", shown)
	}
	base := filepath.Base(abs)
	if base == string(filepath.Separator) || base == "." || base == "" {
		return localf(CodeUnsendableContent, "%s: has no name to send it under", shown)
	}
	lst, err := os.Lstat(abs)
	if err != nil {
		return localf(CodeUnsendableContent, "%s: %s", shown, errText(err))
	}
	src := abs
	info := lst
	if lst.Mode()&fs.ModeSymlink != 0 {
		// An explicitly named symlink is followed once, like cp. Walking then
		// happens under the resolved path, so nothing below it is followed.
		resolved, err := filepath.EvalSymlinks(abs)
		if err != nil {
			return localf(CodeUnsendableContent, "%s: %s", shown, errText(err))
		}
		src = resolved
		if info, err = os.Lstat(resolved); err != nil {
			return localf(CodeUnsendableContent, "%s: %s", shown, errText(err))
		}
	}
	key := strings.ToLower(base)
	if prev, dup := topLevel[key]; dup {
		return localf(CodeUnsendableContent, "%s and %s would arrive under the same name %q; rename one or send them separately",
			termtext.Safe(prev), shown, termtext.Safe(base))
	}
	topLevel[key] = arg

	switch {
	case info.Mode().IsRegular():
		return p.addFile(base, src, info, arg, exact, folded)
	case info.IsDir():
		return p.addDir(base, src, arg, exact, folded)
	default:
		return localf(CodeUnsendableContent, "%s: not a regular file or folder", shown)
	}
}

func (p *Plan) addDir(base, root, arg string, exact, folded map[string]string) error {
	hasFile := map[string]bool{} // dirs (relative) that contain a file somewhere below
	var dirs []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, werr error) error {
		shown := termtext.Safe(path)
		if werr != nil {
			return localf(CodeUnsendableContent, "%s: %s", shown, errText(werr))
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return localf(CodeUnsendableContent, "%s: cannot resolve this path", shown)
		}
		if d.IsDir() {
			dirs = append(dirs, rel)
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return localf(CodeUnsendableContent, "%s: is a symbolic link inside a folder being sent; it is refused rather than skipped or followed", shown)
		}
		if !d.Type().IsRegular() {
			return localf(CodeUnsendableContent, "%s: is not a regular file; it is refused rather than skipped", shown)
		}
		info, err := d.Info()
		if err != nil {
			return localf(CodeUnsendableContent, "%s: %s", shown, errText(err))
		}
		if len(p.files) >= inboxmanifest.MaxItems {
			return localf(CodeUnsendableContent, "too many files: one delivery carries at most %d", inboxmanifest.MaxItems)
		}
		name := base + "/" + filepath.ToSlash(rel)
		for dir := filepath.Dir(rel); ; dir = filepath.Dir(dir) {
			hasFile[dir] = true
			if dir == "." {
				break
			}
		}
		return p.addFile(name, path, info, path, exact, folded)
	})
	if err != nil {
		if e := AsError(err); e != nil {
			return e
		}
		return localf(CodeUnsendableContent, "%s: %s", termtext.Safe(arg), errText(err))
	}
	for _, d := range dirs {
		// Report only the outermost empty folder of a chain: one whose parent
		// does hold a file (or the named folder itself, when it holds none).
		if hasFile[d] || (d != "." && !hasFile[filepath.Dir(d)]) {
			continue
		}
		shown := base
		if d != "." {
			shown = base + "/" + filepath.ToSlash(d)
		}
		p.EmptyFolders = append(p.EmptyFolders, termtext.Safe(shown))
	}
	return nil
}

func (p *Plan) addFile(name, path string, info os.FileInfo, shownPath string, exact, folded map[string]string) error {
	shown := termtext.Safe(shownPath)
	if len(p.files) >= inboxmanifest.MaxItems {
		return localf(CodeUnsendableContent, "too many files: one delivery carries at most %d", inboxmanifest.MaxItems)
	}
	if err := inboxclient.CheckPortableName(name); err != nil {
		return localf(CodeUnsendableContent, "%s: its name %q is one a receiving device refuses (%s)",
			shown, termtext.Safe(name), portableReason(err))
	}
	if prev, dup := exact[name]; dup {
		return localf(CodeUnsendableContent, "%s and %s would arrive under the same name", termtext.Safe(prev), shown)
	}
	lower := strings.ToLower(name)
	if prev, dup := folded[lower]; dup {
		return localf(CodeUnsendableContent, "%s and %s have names that differ only by case, which a receiver refuses",
			termtext.Safe(prev), shown)
	}
	exact[name] = shownPath
	folded[lower] = shownPath
	p.files = append(p.files, planFile{
		item: inboxmanifest.Item{Kind: inboxmanifest.KindFile, Name: name, Size: info.Size()},
		path: path, info: info,
	})
	return nil
}

func portableReason(err error) string {
	s := err.Error()
	if i := strings.LastIndex(s, ": "); i >= 0 {
		s = s[i+2:]
	}
	return termtext.Safe(s)
}

func errText(err error) string {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		err = pe.Err
	}
	return termtext.Safe(err.Error())
}

// errSourceChanged marks a source that did not read back as planned.
var errSourceChanged = errors.New("source changed")

// sourceReader reads one planned file exactly once, in order. open proves the
// descriptor is the planned regular file; read hands out its planned size in
// pieces; the final read proves nothing followed and nothing changed on the
// open descriptor. Any deviation — a different file at the path, a size
// change, a short read, extra bytes — is errSourceChanged.
//
// This is best-effort DELIVERY CONSISTENCY ("the recipient gets what was
// read"), not a cryptographic property: nothing here ever licenses sealing
// anything a second time.
type sourceReader struct {
	fh        *os.File
	before    os.FileInfo
	remaining int64
}

func openSource(f planFile) (*sourceReader, error) {
	fh, err := openRegular(f.path)
	if err != nil {
		return nil, errSourceChanged
	}
	before, err := fh.Stat()
	if err != nil || !before.Mode().IsRegular() || !os.SameFile(before, f.info) || before.Size() != f.item.Size {
		fh.Close()
		return nil, errSourceChanged
	}
	return &sourceReader{fh: fh, before: before, remaining: f.item.Size}, nil
}

// read returns the next piece (at most len(buf) bytes), or io.EOF once the
// planned size has been read and verified complete.
func (r *sourceReader) read(buf []byte) ([]byte, error) {
	if r.remaining == 0 {
		var one [1]byte
		if n, _ := r.fh.Read(one[:]); n != 0 {
			return nil, errSourceChanged
		}
		after, err := r.fh.Stat()
		if err != nil || after.Size() != r.before.Size() || !after.ModTime().Equal(r.before.ModTime()) {
			return nil, errSourceChanged
		}
		return nil, io.EOF
	}
	n := min(int64(len(buf)), r.remaining)
	if _, err := io.ReadFull(r.fh, buf[:n]); err != nil {
		return nil, errSourceChanged
	}
	r.remaining -= n
	return buf[:n], nil
}

func (r *sourceReader) close() { _ = r.fh.Close() }
