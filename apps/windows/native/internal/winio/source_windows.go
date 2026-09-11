//go:build windows

// Reading a file the user chose, without ever resolving a name the OS could
// redirect.
//
// ## Why this is not openRoot
//
// `openRoot` opens the destination FOLLOWING a reparse point, on purpose: the
// user picked that folder in a native dialog, so a junction there is authorised
// and pinning its target is the correct receive behaviour. `openOrCreateDirectory`
// likewise asks for FILE_CREATE and DELETE, because receiving creates things.
//
// Neither is usable here. A source path is read, not written, and nothing along
// it is authorised — including the folder the user clicked, which may itself be
// a junction pointing somewhere the user did not intend to send. So this file
// reuses the package's PRIMITIVES (relative opens by OBJECT_ATTRIBUTES, the
// handle-based reparse refusal, the NTSTATUS classifier) and none of its POLICY:
//
//	receive                                source
//	---------------------------------      ---------------------------------
//	root followed                          EVERY component walked, root included
//	FILE_CREATE, fallback FILE_OPEN        FILE_OPEN only; nothing is created
//	DELETE on created directories          no DELETE, no write bit anywhere
//	reparse refused below the root         reparse refused everywhere, no exception
//
// ## What the walk does and does not prove
//
// Every component is opened relative to a handle we already hold, one at a time,
// with FILE_OPEN_REPARSE_POINT. No component name is ever resolved by the OS on
// our behalf, so re-pointing a junction mid-walk cannot redirect us: we either
// already hold the real object or we refuse the reparse point we were handed.
// Ancestor handles are RETAINED for the lifetime of the source, without
// FILE_SHARE_DELETE, so an ancestor cannot be renamed or deleted out from under
// an open read either.
//
// The one name the OS does resolve is the drive letter, `\??\C:` — an Object
// Manager symlink to a device. That mapping is not a filesystem reparse point
// and is not user-writable at the file layer; it is the volume's name, and
// there is no walk that could avoid trusting it.
//
// This does NOT freeze the file's CONTENT. Share mode permits other writers, so
// a file being rewritten while it is read yields the new bytes. Denying writers
// would refuse every file another application happens to have open, which is
// most of the interesting ones. Identity binds WHICH OBJECT is read; it does not
// promise the object stopped changing.
package winio

import (
	"fmt"
	"io"
	"strings"
	"unsafe"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
	"golang.org/x/sys/windows"
)

// Codes this file adds. They are declared here rather than in wire/code.go so
// the accepted receive protocol is not modified; `wire.Code` is a string type,
// so these compose with it without touching it.
const (
	// CodeIdentityUnavailable means FILE_ID_INFO was missing or zero. It is a
	// REFUSAL, not a degradation: an identity that cannot be read cannot bind
	// bytes to an object, and a read that cannot be bound must not be served
	// while claiming it was.
	CodeIdentityUnavailable wire.Code = "E_IDENTITY_UNAVAILABLE"

	// CodeNotRegularFile covers a directory, a console, a pipe or a device
	// reached through the filesystem namespace.
	CodeNotRegularFile wire.Code = "E_NOT_REGULAR_FILE"

	// CodeSourcePath is a path this walker refuses on its shape alone, before
	// any syscall. Detail names the rule, never the path.
	CodeSourcePath wire.Code = "E_SOURCE_PATH"
)

const (
	// sourceDirAccess is traverse and stat, and nothing else. Notably NOT
	// FILE_LIST_DIRECTORY: this walker never enumerates, so it never asks for
	// the right to.
	sourceDirAccess = windows.FILE_TRAVERSE | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE

	// sourceFileAccess is read and stat. No write bit, no DELETE.
	sourceFileAccess = windows.FILE_READ_DATA | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE

	// sourceShare omits FILE_SHARE_DELETE, the same pin dirShare uses. Rename
	// requires DELETE access on the source object, so denying delete-sharing
	// denies rename too: an ancestor or the file itself cannot be moved away
	// while a read is outstanding.
	sourceShare = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE

	sourceDirOptions = windows.FILE_DIRECTORY_FILE | windows.FILE_SYNCHRONOUS_IO_NONALERT |
		windows.FILE_OPEN_REPARSE_POINT

	sourceFileOptions = windows.FILE_NON_DIRECTORY_FILE | windows.FILE_SYNCHRONOUS_IO_NONALERT |
		windows.FILE_OPEN_REPARSE_POINT

	// maxPathChars bounds the whole path before anything is allocated for it.
	maxPathChars = 32767

	// maxComponents bounds walk depth, and therefore the number of handles one
	// source retains.
	maxComponents = 256
)

// fileIDInfo is FILE_ID_INFO. x/sys v0.47.0 declares the info class
// (windows.FileIdInfo) but not the struct, so it is declared here.
//
// VolumeSerialNumber is 64 bits and FileID is 128; neither survives a float64,
// which is why Identity carries them as hex strings all the way to the host.
type fileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

// fileStandardInfo is FILE_STANDARD_INFO.
type fileStandardInfo struct {
	AllocationSize int64
	EndOfFile      int64
	NumberOfLinks  uint32
	DeletePending  byte
	Directory      byte
}

// Identity is an exact, nonzero FILE_ID_INFO rendered as lowercase hex.
//
// Strings, not integers, and the reason is not stylistic: the host is
// JavaScript, where both fields exceed the largest exactly representable
// integer. A volume serial delivered as a JSON number is silently rounded, and
// two different files then compare equal.
type Identity struct {
	VolumeSerial string // 16 hex chars
	FileID       string // 32 hex chars
}

// Source is one opened file plus every ancestor handle that proves how it was
// reached. Not safe for concurrent use; the helper serves one request at a time.
type Source struct {
	leaf windows.Handle
	// ancestors is volume-root first. Retained, not closed after the walk: an
	// ancestor closed early could be replaced, and the leaf handle alone cannot
	// testify to the path it was reached through.
	ancestors []windows.Handle
	size      int64
	identity  Identity
	closed    bool
}

// OpenSource walks `path` from its volume root and returns a bound read handle.
//
// `path` must be an ordinary local drive-letter path. Every refusal below
// happens before, or instead of, serving bytes; there is no partial success.
func OpenSource(path string) (*Source, error) {
	volumeRoot, components, err := splitLocalPath(path)
	if err != nil {
		return nil, err
	}
	if err := refuseNonLocalVolume(volumeRoot); err != nil {
		return nil, err
	}

	rootHandle, err := openVolumeRoot(volumeRoot)
	if err != nil {
		return nil, err
	}
	src := &Source{ancestors: []windows.Handle{rootHandle}}

	rootID, err := queryIdentity(rootHandle)
	if err != nil {
		src.releaseAncestors()
		return nil, err
	}

	// Every component, including the directory the user selected. The user's
	// choice authorises SENDING that file; it does not authorise following a
	// junction the user cannot see.
	for i, component := range components {
		last := i == len(components)-1
		h, err := openExistingChild(src.currentParent(), component, last)
		if err != nil {
			src.releaseAncestors()
			return nil, err
		}
		id, err := queryIdentity(h)
		if err != nil {
			windows.CloseHandle(h)
			src.releaseAncestors()
			return nil, err
		}
		// A mount point is a reparse point and openExistingChild already refused
		// it. This is the independent check: if any component somehow lives on a
		// different volume from the root, the walk did not stay where it started
		// and the result is refused rather than explained.
		if id.VolumeSerial != rootID.VolumeSerial {
			windows.CloseHandle(h)
			src.releaseAncestors()
			return nil, wire.Errf(wire.CodeUnsupportedVolume, fmt.Sprintf("component %d", i))
		}
		if !last {
			src.ancestors = append(src.ancestors, h)
			continue
		}
		size, err := describeRegularFile(h)
		if err != nil {
			windows.CloseHandle(h)
			src.releaseAncestors()
			return nil, err
		}
		src.leaf = h
		src.size = size
		src.identity = id
	}
	if src.leaf == 0 {
		// Unreachable: splitLocalPath guarantees at least one component. Stated
		// rather than assumed, because the alternative is returning a Source
		// whose Read would dereference handle zero.
		src.releaseAncestors()
		return nil, wire.Errf(wire.CodeInternal, "walk produced no leaf")
	}
	return src, nil
}

// Size is the length observed at open time, from the handle.
func (s *Source) Size() int64 { return s.size }

// Identity is the exact nonzero FILE_ID_INFO of the leaf.
func (s *Source) Identity() (volumeSerial, fileID string) {
	return s.identity.VolumeSerial, s.identity.FileID
}

// ReadAt fills p from off, returning io.EOF at or past end of file.
//
// The offset is explicit in the OVERLAPPED rather than carried in the handle's
// file pointer. On a synchronous handle that is defined behaviour, and it means
// a read never depends on where a previous read happened to leave the pointer.
func (s *Source) ReadAt(p []byte, off int64) (int, error) {
	if s.closed {
		return 0, wire.Errf(wire.CodeSequence, "source is closed")
	}
	if off < 0 {
		return 0, wire.Errf(wire.CodeProtocol, "negative offset")
	}
	if len(p) == 0 {
		return 0, nil
	}
	var ov windows.Overlapped
	ov.Offset = uint32(uint64(off) & 0xFFFFFFFF)
	ov.OffsetHigh = uint32(uint64(off) >> 32)

	var done uint32
	err := windows.ReadFile(s.leaf, p, &done, &ov)
	if err != nil {
		// Reading at or past the end is an outcome, not a fault. Windows reports
		// it either way depending on how far past the end the offset is, so both
		// forms settle as EOF.
		if err == windows.ERROR_HANDLE_EOF {
			return 0, io.EOF
		}
		return 0, classifySyscall(err)
	}
	if done == 0 {
		return 0, io.EOF
	}
	return int(done), nil
}

// Close releases the leaf and every retained ancestor, leaf first.
//
// A close that fails is REPORTED, not swallowed and not retried: the handle is
// still held by this process, and a caller that was told "closed" would stop
// accounting for it. The source is marked closed regardless so no further read
// can be served through a handle whose state is now unknown.
func (s *Source) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	var first error
	if s.leaf != 0 {
		if err := windows.CloseHandle(s.leaf); err != nil {
			first = wire.Errf(wire.CodeIO, "leaf close failed")
		}
		s.leaf = 0
	}
	if err := s.releaseAncestors(); err != nil && first == nil {
		first = err
	}
	return first
}

// currentParent is the deepest ancestor opened so far.
func (s *Source) currentParent() windows.Handle {
	return s.ancestors[len(s.ancestors)-1]
}

// releaseAncestors closes retained handles deepest first and reports whether any
// close failed. Every handle is attempted even after one fails; stopping early
// would leak the rest to make the error report tidier.
func (s *Source) releaseAncestors() error {
	var first error
	for i := len(s.ancestors) - 1; i >= 0; i-- {
		if s.ancestors[i] == 0 {
			continue
		}
		if err := windows.CloseHandle(s.ancestors[i]); err != nil && first == nil {
			first = wire.Errf(wire.CodeIO, "ancestor close failed")
		}
		s.ancestors[i] = 0
	}
	return first
}

// splitLocalPath validates the shape of a path and splits it, with no syscall.
//
// Everything refused here is refused on the STRING, before the filesystem is
// touched at all, so a hostile shape costs one comparison rather than an open.
func splitLocalPath(path string) (volumeRoot string, components []string, err error) {
	if len(path) > maxPathChars {
		return "", nil, wire.Errf(CodeSourcePath, "path too long")
	}
	// A forward slash is a path separator to Win32 and an ordinary character to
	// the NT namespace this walker uses. Accepting it would mean the component
	// split here and the object actually opened could disagree, so it is refused
	// rather than translated.
	if strings.ContainsRune(path, '/') {
		return "", nil, wire.Errf(CodeSourcePath, "forward slash")
	}
	// `\\?\`, `\\.\`, `\\server\share` and every other rooted device form. The
	// walker's guarantee starts at a drive letter; a path that starts anywhere
	// else is not a path it can make a claim about.
	if len(path) < 3 || path[1] != ':' || path[2] != '\\' || !isDriveLetter(path[0]) {
		return "", nil, wire.Errf(CodeSourcePath, "not a drive-letter path")
	}
	volumeRoot = strings.ToUpper(path[:1]) + `:\`
	rest := path[3:]
	if rest == "" {
		return "", nil, wire.Errf(CodeSourcePath, "volume root is not a file")
	}
	parts := strings.Split(rest, `\`)
	if len(parts) > maxComponents {
		return "", nil, wire.Errf(CodeSourcePath, "too many components")
	}
	for _, c := range parts {
		if err := refuseComponent(c); err != nil {
			return "", nil, err
		}
	}
	return volumeRoot, parts, nil
}

func isDriveLetter(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

// refuseComponent rejects one path segment on shape alone.
func refuseComponent(c string) error {
	switch c {
	case "":
		// Covers a doubled separator and a trailing separator. Either means the
		// caller's split and ours differ, which is exactly the ambiguity this
		// refuses to guess about.
		return wire.Errf(CodeSourcePath, "empty component")
	case ".", "..":
		return wire.Errf(CodeSourcePath, "relative component")
	}
	// A colon is an alternate data stream, or a second drive specification. Both
	// name something other than the file the caller appears to have named.
	if strings.ContainsRune(c, ':') {
		return wire.Errf(CodeSourcePath, "stream or drive in component")
	}
	// Win32 strips trailing dots and spaces; the NT namespace does not. Such a
	// name therefore identifies a DIFFERENT object here than at the caller, and
	// the objects Win32 cannot address are not ones a send should reach.
	if strings.HasSuffix(c, ".") || strings.HasSuffix(c, " ") {
		return wire.Errf(CodeSourcePath, "trailing dot or space")
	}
	for _, r := range c {
		switch r {
		case '*', '?', '"', '<', '>', '|':
			return wire.Errf(CodeSourcePath, "wildcard or reserved character")
		}
		if r < 0x20 {
			return wire.Errf(CodeSourcePath, "control character")
		}
	}
	return nil
}

// refuseNonLocalVolume rejects anything but a fixed or removable local drive.
//
// A network drive defeats every guarantee above it: the identity comes from a
// server this process cannot authenticate, and the ancestor pin binds handles on
// a redirector rather than on a volume. Refusing is honest; serving it while
// claiming the same guarantee would not be.
func refuseNonLocalVolume(volumeRoot string) error {
	name, err := windows.UTF16PtrFromString(volumeRoot)
	if err != nil {
		return wire.Errf(CodeSourcePath, "volume root not representable")
	}
	switch windows.GetDriveType(name) {
	case windows.DRIVE_FIXED, windows.DRIVE_REMOVABLE:
		return nil
	case windows.DRIVE_REMOTE:
		return wire.Errf(wire.CodeUnsupportedVolume, "remote")
	case windows.DRIVE_NO_ROOT_DIR:
		return wire.Errf(wire.CodeNotFound, "no such volume")
	default:
		return wire.Errf(wire.CodeUnsupportedVolume, "drive type")
	}
}

// openVolumeRoot opens `X:\` itself, read-only.
func openVolumeRoot(volumeRoot string) (windows.Handle, error) {
	name, err := windows.NewNTUnicodeString(`\??\` + volumeRoot)
	if err != nil {
		return 0, wire.Errf(CodeSourcePath, "volume root not representable")
	}
	oa := &windows.OBJECT_ATTRIBUTES{ObjectName: name}
	oa.Length = uint32(unsafe.Sizeof(*oa))

	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	var alloc int64
	status := windows.NtCreateFile(&h, sourceDirAccess, oa, &iosb, &alloc, 0,
		sourceShare, windows.FILE_OPEN, sourceDirOptions, 0, 0)
	if status != nil {
		coded := classify(status)
		return 0, wire.Errf(wire.CodeRoot, string(coded.Code)+" "+coded.Detail)
	}
	// A volume root is not expected to be a reparse point, and the check is run
	// anyway. "Expected" is not a guarantee, and this is one syscall.
	if err := refuseReparse(h); err != nil {
		windows.CloseHandle(h)
		return 0, err
	}
	return h, nil
}

// openExistingChild opens one component relative to parent. FILE_OPEN only:
// nothing here can bring an object into existence, whatever the caller sends.
func openExistingChild(parent windows.Handle, component string, leaf bool) (windows.Handle, error) {
	name, err := windows.NewNTUnicodeString(component)
	if err != nil {
		return 0, wire.Errf(wire.CodeNameTooLong, "component not representable")
	}
	oa := &windows.OBJECT_ATTRIBUTES{RootDirectory: parent, ObjectName: name}
	oa.Length = uint32(unsafe.Sizeof(*oa))

	access := uint32(sourceDirAccess)
	options := uint32(sourceDirOptions)
	if leaf {
		access = sourceFileAccess
		options = sourceFileOptions
	}

	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	var alloc int64
	status := windows.NtCreateFile(&h, access, oa, &iosb, &alloc, 0, sourceShare,
		windows.FILE_OPEN, options, 0, 0)
	if status != nil {
		return 0, classify(status)
	}
	// On the handle just obtained and before it is returned, so no caller can
	// read through a component that was never checked. This is the same rule
	// openOrCreateDirectory applies below the root; here it applies at the root
	// too, because here the root is not authorised.
	if err := refuseReparse(h); err != nil {
		windows.CloseHandle(h)
		return 0, err
	}
	return h, nil
}

// queryIdentity reads FILE_ID_INFO and refuses anything short of an exact,
// nonzero answer.
//
// The rule is deliberately stricter than the Node fallback's, which compares
// device and inode only when they are nonzero so that a volume reporting zeroes
// is not refused outright. That tolerance is correct for a path that CLAIMS
// nothing. It is wrong here: this path exists to make a binding claim, and an
// identity that cannot be read cannot bind anything.
func queryIdentity(h windows.Handle) (Identity, error) {
	var info fileIDInfo
	err := windows.GetFileInformationByHandleEx(h, windows.FileIdInfo,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		return Identity{}, wire.Errf(CodeIdentityUnavailable, "query failed")
	}
	if info.VolumeSerialNumber == 0 {
		return Identity{}, wire.Errf(CodeIdentityUnavailable, "zero volume serial")
	}
	var any bool
	for _, b := range info.FileID {
		if b != 0 {
			any = true
			break
		}
	}
	if !any {
		return Identity{}, wire.Errf(CodeIdentityUnavailable, "zero file id")
	}
	return Identity{
		VolumeSerial: fmt.Sprintf("%016x", info.VolumeSerialNumber),
		FileID:       fmt.Sprintf("%x", info.FileID),
	}, nil
}

// describeRegularFile refuses anything that is not an ordinary on-disk file and
// returns its length.
func describeRegularFile(h windows.Handle) (int64, error) {
	// FILE_NON_DIRECTORY_FILE already excluded a directory at open time. This
	// excludes what that flag does not: a console, a pipe or a character device
	// reached through the filesystem namespace.
	kind, err := windows.GetFileType(h)
	if err != nil {
		return 0, wire.Errf(wire.CodeIO, "file type query failed")
	}
	if kind != windows.FILE_TYPE_DISK {
		return 0, wire.Errf(CodeNotRegularFile, fmt.Sprintf("type %d", kind))
	}
	var info fileStandardInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStandardInfo,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return 0, wire.Errf(wire.CodeIO, "standard info query failed")
	}
	if info.Directory != 0 {
		return 0, wire.Errf(CodeNotRegularFile, "directory")
	}
	// A file already marked for deletion will vanish the moment the last other
	// handle closes. Reading it would produce bytes for an object that no longer
	// exists by the time anything is done with them.
	if info.DeletePending != 0 {
		return 0, wire.Errf(wire.CodeDeletePending, "")
	}
	if info.EndOfFile < 0 {
		return 0, wire.Errf(wire.CodeIO, "negative length")
	}
	return info.EndOfFile, nil
}

// classifySyscall maps a Win32 error from a read. `classify` takes NTSTATUS and
// would report every Win32 error as "non-status", which would be a wrong cause
// stated confidently.
func classifySyscall(err error) error {
	errno, ok := err.(windows.Errno)
	if !ok {
		return wire.Errf(wire.CodeIO, "read failed")
	}
	switch errno {
	case windows.ERROR_ACCESS_DENIED:
		return wire.Errf(wire.CodeAccess, "")
	case windows.ERROR_SHARING_VIOLATION:
		return wire.Errf(wire.CodeSharing, "")
	case windows.ERROR_FILE_NOT_FOUND, windows.ERROR_PATH_NOT_FOUND:
		return wire.Errf(wire.CodeNotFound, "")
	default:
		return wire.Errf(wire.CodeIO, fmt.Sprintf("0x%08X", uint32(errno)))
	}
}
