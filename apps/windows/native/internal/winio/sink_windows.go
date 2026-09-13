//go:build windows

package winio

import (
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/staging"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// Sink is the Windows implementation of session.Sink.
//
// ## Staging is owned here, never supplied from outside
//
// The sink creates its own staging directory as a child of the pinned root and
// keeps the handle for the session. An externally supplied staging path would be
// a trust claim this process cannot verify, so the API does not accept one:
// staging and publication are owned together or the ownership argument collapses.
//
// Staged files are flat and index-named, so no manifest-supplied byte reaches the
// filesystem before publication. During the entire streaming phase there is
// nothing on disk for a reserved device name, an alternate data stream, a case
// collision or a trailing dot to act on — the validated names live in memory and
// are applied only at the rename.
//
// ## Bounded hard-kill residue, stated exactly
//
// Graceful cancel, stdin EOF, protocol failure and publish failure all remove
// every staged file by handle and then the staging directory. A hard kill
// (TerminateProcess) is different and is NOT claimed to be clean: it leaves at
// most one directory `<root>\.relayium-incoming-<32 hex>` containing at most N
// `<index>.part` files. That residue is never at a destination pathname, never
// overwrites anything, and is never adopted or swept by a later session —
// sweeping would mean deleting objects another live lease may own.
type Sink struct {
	root    windows.Handle
	staging windows.Handle
	plan    *nameguard.Plan

	// staged handles by file index, retained from BeginFile until publication or
	// cleanup. Publication renames these exact handles, which is what makes the
	// published object provably the object that was written.
	staged  map[int]windows.Handle
	current int

	// dirs caches one handle per distinct destination directory, keyed by
	// collision key. Handles are held for the whole of publication so no ancestor
	// can be renamed underneath a pending rename.
	dirs map[string]windows.Handle
	// owned marks directories this process created, and is the only set cleanup
	// may remove. Pre-existing directories are opened without DELETE access, so
	// this is belt and braces over a structural guarantee.
	owned []windows.Handle

	closed bool
}

// fileNameNormalizedDOS is FILE_NAME_NORMALIZED | VOLUME_NAME_DOS, both of which
// are zero. x/sys does not name them; the value is spelled out here rather than
// passing a bare 0 whose meaning would be unrecoverable.
const fileNameNormalizedDOS = 0x0

func NewSink() *Sink {
	return &Sink{staged: map[int]windows.Handle{}, dirs: map[string]windows.Handle{}, current: -1}
}

// Open pins the root, refuses unsupported volumes, and creates staging.
func (s *Sink) Open(root string, plan *nameguard.Plan) error {
	h, err := openRoot(root)
	if err != nil {
		return err
	}
	if err := s.refuseUnsupportedVolume(h); err != nil {
		windows.CloseHandle(h)
		return err
	}
	s.root = h
	s.plan = plan

	staging, err := s.createStagingDirectory()
	if err != nil {
		windows.CloseHandle(h)
		s.root = 0
		return err
	}
	s.staging = staging
	return nil
}

// refuseUnsupportedVolume declines network destinations for now.
//
// This is a CAPABILITY LIMIT, not a claim about SMB. No-replace rename and POSIX
// deletion semantics have not been demonstrated on a redirected volume by this
// project, and promising behaviour that has not been observed is the failure this
// codebase avoids elsewhere. It is expected to be lifted once a real Windows plus
// SMB host produces evidence either way.
//
// The final path is read for CLASSIFICATION ONLY. Nothing about containment
// depends on it — containment is the pinned handle — so this is not a
// check-then-use.
func (s *Sink) refuseUnsupportedVolume(h windows.Handle) error {
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), fileNameNormalizedDOS)
	if err != nil || n == 0 {
		// Unable to classify. Refusing here would break local volumes for a
		// diagnostic call, so the pinned handle stands on its own.
		return nil
	}
	if n > uint32(len(buf)) {
		return nil
	}
	final := windows.UTF16ToString(buf[:n])
	if strings.HasPrefix(final, `\\?\UNC\`) || strings.HasPrefix(final, `\\UNC\`) {
		return wire.Errf(wire.CodeUnsupportedVolume, "network destination")
	}
	return nil
}

// createStagingDirectory makes a directory this process provably owns.
//
// FILE_CREATE fails if the name exists, so the directory was MADE here and never
// adopted — which is a claim about origin, not about access. Any process running
// as this user can still open it and the random name is not a secret; what it
// buys is that no pre-existing junction or hostile entry becomes our staging root.
// The handle is held for the session without FILE_SHARE_DELETE, so it cannot be
// deleted or renamed underneath us.
func (s *Sink) createStagingDirectory() (windows.Handle, error) {
	name, err := staging.NewName()
	if err != nil {
		return 0, wire.Errf(wire.CodeInternal, "staging name entropy unavailable")
	}

	nameStr, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, wire.Errf(wire.CodeInternal, "staging name not representable")
	}
	oa := &windows.OBJECT_ATTRIBUTES{RootDirectory: s.root, ObjectName: nameStr}
	oa.Length = uint32(unsafe.Sizeof(*oa))

	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	var alloc int64
	status := windows.NtCreateFile(&h, dirTraverseAccess|windows.DELETE|windows.FILE_READ_ATTRIBUTES,
		oa, &iosb, &alloc, windows.FILE_ATTRIBUTE_HIDDEN, dirShare, windows.FILE_CREATE,
		uint32(dirOptions|windows.FILE_OPEN_REPARSE_POINT), 0, 0)
	if status != nil {
		coded := classify(status)
		return 0, wire.Errf(wire.CodeRoot, "staging unavailable: "+string(coded.Code)+" "+coded.Detail)
	}
	return h, nil
}

func (s *Sink) BeginFile(index int) error {
	h, err := createStagedFile(s.staging, fmt.Sprintf("%d.part", index))
	if err != nil {
		return err
	}
	s.staged[index] = h
	s.current = index
	return nil
}

// WriteChunk returns the count the operating system actually took.
//
// ## The count travels WITH the error
//
// A failing WriteFile has still set lpNumberOfBytesWritten, and a write that
// fills the volume is the ordinary case where that count is non-zero. Reporting
// zero alongside the error would be a claim this function cannot support — that
// the staged file did not move — and the session's length accounting would then
// describe a file that is longer than it thinks.
//
// The session treats any error here as terminal for exactly that reason, so this
// count is diagnostic rather than something to resume from. It is reported
// truthfully anyway: a caller deciding what to do with a failed write should not
// have to know that this function rounds its answer down to zero.
func (s *Sink) WriteChunk(index int, p []byte) (int, error) {
	h, ok := s.staged[index]
	if !ok {
		return 0, wire.Errf(wire.CodeSequence, "no staged handle")
	}
	if len(p) == 0 {
		return 0, nil
	}
	// Zero-initialised, so a call that fails before the kernel touches it reports
	// no progress rather than a stale count.
	var done uint32
	if err := windows.WriteFile(h, p, &done, nil); err != nil {
		// Defensive: the session refuses a count outside the offered range, and
		// a driver reporting one must not be the thing that decides the file is
		// unrecoverable. Clamping keeps the error the reported cause.
		n := int(done)
		if n < 0 || n > len(p) {
			n = 0
		}
		if status, isStatus := err.(windows.NTStatus); isStatus {
			return n, classify(status)
		}
		if errno, isErrno := err.(windows.Errno); isErrno && errno == windows.ERROR_DISK_FULL {
			return n, wire.Errf(wire.CodeNoSpace, "")
		}
		return n, wire.Errf(wire.CodeIO, "write failed")
	}
	return int(done), nil
}

// FinishFile flushes and retains the handle for publication.
func (s *Sink) FinishFile(index int) error {
	h, ok := s.staged[index]
	if !ok {
		return wire.Errf(wire.CodeSequence, "no staged handle")
	}
	if err := windows.FlushFileBuffers(h); err != nil {
		return wire.Errf(wire.CodeIO, "flush failed")
	}
	s.current = -1
	return nil
}

// PublishOne moves one staged handle to its destination without replacing
// anything.
func (s *Sink) PublishOne(index int) error {
	h, ok := s.staged[index]
	if !ok {
		return wire.Errf(wire.CodeSequence, "no staged handle")
	}
	file := s.plan.Files[index]

	parent, err := s.destinationDirectory(file)
	if err != nil {
		return err
	}
	leaf := file.Segments[len(file.Segments)-1]
	if err := renameNoReplace(h, parent, leaf); err != nil {
		return err
	}
	// Published. The handle is released and the object is the user's; cleanup
	// never touches it again.
	windows.CloseHandle(h)
	delete(s.staged, index)
	return nil
}

// destinationDirectory walks to the file's parent, one validated component at a
// time from the pinned root, opening each distinct directory exactly once.
//
// Deduplication by collision key is what keeps the handle count at the distinct
// directory total the plan already bounded, rather than one chain per file.
func (s *Sink) destinationDirectory(file nameguard.PlannedFile) (windows.Handle, error) {
	parent := s.root
	for depth := 1; depth < len(file.Segments); depth++ {
		key := file.DirectoryKeys[depth-1]
		if cached, ok := s.dirs[key]; ok {
			parent = cached
			continue
		}
		h, created, err := openOrCreateDirectory(parent, file.Segments[depth-1])
		if err != nil {
			return 0, err
		}
		s.dirs[key] = h
		if created {
			s.owned = append(s.owned, h)
		}
		parent = h
	}
	return parent, nil
}

// Cleanup removes only objects this sink owns.
//
// Order matters: staged files first (by handle), then the staging directory,
// then owned destination directories innermost-first. Published files are never
// touched.
func (s *Sink) Cleanup() (session.Residue, error) {
	var residue session.Residue
	if s.closed {
		return residue, nil
	}
	s.closed = true

	for index, h := range s.staged {
		if err := deleteByHandle(h); err != nil {
			residue.Left = true
		} else {
			residue.RemovedFiles++
		}
		windows.CloseHandle(h)
		delete(s.staged, index)
	}

	if s.staging != 0 {
		// Removed only if empty. A foreign file planted inside means the removal
		// fails, and that is reported rather than resolved: recursively deleting
		// content this process did not create is exactly the unowned deletion the
		// design forbids.
		if err := deleteByHandle(s.staging); err != nil {
			residue.Left = true
		}
		windows.CloseHandle(s.staging)
		s.staging = 0
	}

	// Directories this process created and that are still empty. A non-empty one
	// holds published files and must stay; that status is expected, not an error.
	for i := len(s.owned) - 1; i >= 0; i-- {
		deleteByHandle(s.owned[i])
	}
	for _, h := range s.dirs {
		windows.CloseHandle(h)
	}
	s.dirs = map[string]windows.Handle{}
	s.owned = nil

	if s.root != 0 {
		windows.CloseHandle(s.root)
		s.root = 0
	}
	return residue, nil
}

var _ session.Sink = (*Sink)(nil)
