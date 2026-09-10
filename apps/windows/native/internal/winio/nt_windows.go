//go:build windows

// The NT primitives. This file is where the security invariants actually live.
//
// ## The one rule
//
//	Every write and every publication targets an object we already hold a handle
//	to. No operation is preceded by a path check that a later step depends on.
//
// Everything below follows from that. Directory traversal is handle-relative one
// component at a time via OBJECT_ATTRIBUTES.RootDirectory, so a component that is
// swapped after we opened it affects nothing. Publication renames the very handle
// the bytes were written through, so the object published is provably the object
// we wrote — there is no re-open by name anywhere in this package.
//
// ## Delete sharing is the pinning mechanism
//
// Directory handles are opened WITHOUT FILE_SHARE_DELETE. That is not an
// oversight to be tidied up later: it is what makes the root and every traversed
// ancestor un-renameable and un-deletable for as long as we hold them, which is
// what defeats an ancestor swap during streaming or publication.
//
// ## What is deliberately NOT copied from upstream
//
// golang.org/x/sys/windows syscall_windows_test.go:1125 demonstrates this exact
// technique but sets FILE_RENAME_REPLACE_IF_EXISTS|FILE_RENAME_POSIX_SEMANTICS.
// This package sets those flags to zero. Replacing an existing file is the single
// outcome the whole design exists to prevent.
//
// Primary sources:
// https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
package winio

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// fileRenameInformation is FILE_RENAME_INFORMATION.
//
// x/sys v0.47.0 declares the FILE_RENAME_* flags but NOT this structure, so it
// is declared here. The C definition is a union of BOOLEAN ReplaceIfExists and
// ULONG Flags, then HANDLE RootDirectory, ULONG FileNameLength, WCHAR
// FileName[1]. On 64-bit the HANDLE forces eight-byte alignment, giving offsets
// 0/8/16/20; on 386 they are 0/4/8/12. This Go declaration reproduces both,
// which is asserted at compile time in layout_windows_test.go rather than
// assumed here.
type fileRenameInformation struct {
	Flags          uint32
	RootDirectory  windows.Handle
	FileNameLength uint32
	FileName       [1]uint16
}

// fileDispositionInformationEx is FILE_DISPOSITION_INFORMATION_EX.
type fileDispositionInformationEx struct {
	Flags uint32
}

// fileAttributeTagInfo is FILE_ATTRIBUTE_TAG_INFO, used to detect a reparse
// point on a handle we are already holding rather than on a name we would have
// to re-resolve.
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// Access masks. FILE_ADD_FILE and FILE_ADD_SUBDIRECTORY are not named by x/sys;
// they are the directory-object meanings of the same bits as FILE_WRITE_DATA and
// FILE_APPEND_DATA.
const (
	fileAddFile         = 0x0002
	fileAddSubdirectory = 0x0004

	// dirTraverseAccess is enough to walk and to create beneath, and nothing
	// more. Notably it does NOT include DELETE — see openOrCreateDirectory.
	dirTraverseAccess = windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE |
		fileAddFile | fileAddSubdirectory | windows.SYNCHRONIZE

	// dirShare omits FILE_SHARE_DELETE on purpose. This is the pin.
	dirShare = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE

	dirOptions = windows.FILE_DIRECTORY_FILE | windows.FILE_SYNCHRONOUS_IO_NONALERT

	// stagedFileAccess needs DELETE for two reasons: the rename at publication
	// requires it on the source handle, and cleanup deletes by handle.
	stagedFileAccess = windows.FILE_GENERIC_WRITE | windows.DELETE | windows.SYNCHRONIZE

	// stagedFileShare is zero: nothing else may open a staged file at all.
	stagedFileShare = 0

	stagedFileOptions = windows.FILE_NON_DIRECTORY_FILE | windows.FILE_SYNCHRONOUS_IO_NONALERT
)

// classify maps an NTSTATUS to a stable host-visible code.
//
// Unrecognised statuses become E_IO with the raw value in hex. Guessing a
// filesystem meaning from an unknown status is how a helper reports a wrong
// cause with confidence, so it deliberately does not try.
func classify(err error) *wire.Error {
	status, ok := err.(windows.NTStatus)
	if !ok {
		return wire.Errf(wire.CodeIO, "non-status error")
	}
	switch status {
	case windows.STATUS_OBJECT_NAME_COLLISION:
		return wire.Errf(wire.CodeExists, "")
	case windows.STATUS_OBJECT_NAME_NOT_FOUND, windows.STATUS_OBJECT_PATH_NOT_FOUND:
		return wire.Errf(wire.CodeNotFound, "")
	case windows.STATUS_NOT_A_DIRECTORY, windows.STATUS_FILE_IS_A_DIRECTORY:
		return wire.Errf(wire.CodeTypeConflict, "")
	case windows.STATUS_ACCESS_DENIED:
		return wire.Errf(wire.CodeAccess, "")
	case windows.STATUS_SHARING_VIOLATION:
		return wire.Errf(wire.CodeSharing, "")
	case windows.STATUS_DISK_FULL:
		return wire.Errf(wire.CodeNoSpace, "")
	case windows.STATUS_DELETE_PENDING:
		return wire.Errf(wire.CodeDeletePending, "")
	case windows.STATUS_NAME_TOO_LONG, windows.STATUS_OBJECT_NAME_INVALID:
		return wire.Errf(wire.CodeNameTooLong, "")
	default:
		return wire.Errf(wire.CodeIO, fmt.Sprintf("0x%08X", uint32(status)))
	}
}

// openRoot pins the user-selected destination.
//
// The root is opened FOLLOWING a reparse point: the user picked it in a native
// dialog, so it is authorised, and after this call we hold the target directory
// object itself. Re-pointing the junction afterwards cannot redirect a single
// byte, because nothing downstream ever resolves the name again. That is what
// "pinned safely" means, and it is the property root asked to see tested.
//
// Interior components are handled by openOrCreateDirectory, which refuses
// reparse points outright.
func openRoot(path string) (windows.Handle, error) {
	name, err := windows.NewNTUnicodeString(`\??\` + path)
	if err != nil {
		return 0, wire.Errf(wire.CodeRoot, "root path is not representable")
	}
	oa := &windows.OBJECT_ATTRIBUTES{ObjectName: name}
	oa.Length = uint32(unsafe.Sizeof(*oa))

	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	var alloc int64
	status := windows.NtCreateFile(&h, dirTraverseAccess|windows.FILE_READ_ATTRIBUTES, oa, &iosb,
		&alloc, 0, dirShare, windows.FILE_OPEN, dirOptions, 0, 0)
	if status != nil {
		coded := classify(status)
		return 0, wire.Errf(wire.CodeRoot, string(coded.Code)+" "+coded.Detail)
	}
	return h, nil
}

// openOrCreateDirectory returns a handle to one component beneath parent, and
// reports whether this process created it.
//
// ## Why two calls instead of FILE_OPEN_IF
//
// FILE_OPEN_IF would answer in one syscall, but it produces one access mask for
// two different ownership outcomes. Cleanup needs DELETE on directories we
// created, and must NOT hold DELETE on directories that were already there.
// Splitting the call lets the access mask carry the ownership decision:
//
//   - FILE_CREATE succeeding means we made it, and we asked for DELETE.
//   - The collision fallback opens WITHOUT DELETE, so this process is
//     structurally incapable of removing a pre-existing directory. "Never delete
//     what you did not create" is enforced by the access mask rather than by a
//     rule someone has to remember at every call site.
//
// Both calls are atomic. A directory another process creates in between is
// simply pre-existing from our perspective, which is the correct outcome.
//
// The reparse check happens on the handle we just obtained and BEFORE the handle
// is returned, so no caller can create anything beneath an unchecked component.
func openOrCreateDirectory(parent windows.Handle, component string) (h windows.Handle, created bool, err error) {
	name, nErr := windows.NewNTUnicodeString(component)
	if nErr != nil {
		return 0, false, wire.Errf(wire.CodeNameTooLong, "component not representable")
	}
	oa := &windows.OBJECT_ATTRIBUTES{RootDirectory: parent, ObjectName: name}
	oa.Length = uint32(unsafe.Sizeof(*oa))

	var iosb windows.IO_STATUS_BLOCK
	var alloc int64

	// FILE_OPEN_REPARSE_POINT on both paths: if the name is a junction we want
	// the junction itself so we can refuse it, never the thing it points at.
	options := uint32(dirOptions | windows.FILE_OPEN_REPARSE_POINT)

	status := windows.NtCreateFile(&h, dirTraverseAccess|windows.DELETE|windows.FILE_READ_ATTRIBUTES,
		oa, &iosb, &alloc, 0, dirShare, windows.FILE_CREATE, options, 0, 0)
	if status == nil {
		created = true
	} else if status == windows.STATUS_OBJECT_NAME_COLLISION {
		status = windows.NtCreateFile(&h, dirTraverseAccess|windows.FILE_READ_ATTRIBUTES,
			oa, &iosb, &alloc, 0, dirShare, windows.FILE_OPEN, options, 0, 0)
		if status != nil {
			return 0, false, classify(status)
		}
	} else {
		return 0, false, classify(status)
	}

	if rErr := refuseReparse(h); rErr != nil {
		windows.CloseHandle(h)
		return 0, false, rErr
	}
	return h, created, nil
}

// refuseReparse rejects a handle that names a reparse point.
//
// Checked on the handle, not on the path, so there is no window between the
// decision and its use. Containment to the folder the user actually chose is the
// product promise, and an interior junction breaks it.
//
// The rejected alternative was to follow interior junctions and verify the
// resolved target is still under the root. That verification is
// GetFinalPathNameByHandle plus a string comparison — precisely the
// check-then-use pattern this package exists to avoid.
func refuseReparse(h windows.Handle) error {
	var info fileAttributeTagInfo
	err := windows.GetFileInformationByHandleEx(h, windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		return wire.Errf(wire.CodeIO, "attribute query failed")
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return wire.Errf(wire.CodeReparseComponent, fmt.Sprintf("tag 0x%08X", info.ReparseTag))
	}
	return nil
}

// createStagedFile creates one opaque staged file inside the staging directory.
//
// Share mode zero: no other process can open it at all while we hold it. The
// handle is retained until publication or cleanup, because publication renames
// this handle.
//
// FILE_DELETE_ON_CLOSE is NOT used here. See onclose_windows.go for why that
// primitive is isolated and disabled rather than relied upon.
func createStagedFile(staging windows.Handle, name string) (windows.Handle, error) {
	nameStr, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, wire.Errf(wire.CodeInternal, "staged name not representable")
	}
	oa := &windows.OBJECT_ATTRIBUTES{RootDirectory: staging, ObjectName: nameStr}
	oa.Length = uint32(unsafe.Sizeof(*oa))

	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	var alloc int64
	status := windows.NtCreateFile(&h, stagedFileAccess, oa, &iosb, &alloc,
		windows.FILE_ATTRIBUTE_NORMAL, stagedFileShare, windows.FILE_CREATE,
		stagedFileOptions|windows.FILE_OPEN_REPARSE_POINT, 0, 0)
	if status != nil {
		return 0, classify(status)
	}
	return h, nil
}

// renameNoReplace moves an open handle to `name` beneath `parent` and fails if
// anything is already there.
//
// Flags is zero. Not FILE_RENAME_REPLACE_IF_EXISTS, not
// FILE_RENAME_POSIX_SEMANTICS. An existing destination — in any case, since NTFS
// folds — returns STATUS_OBJECT_NAME_COLLISION, which becomes E_EXISTS. The
// existing file is never opened, never truncated and never replaced, and there
// is no fallback rename and no suffix retry.
//
// When two helpers publish the same destination concurrently, the first rename
// wins and the loser gets E_EXISTS with its own bytes still staged.
func renameNoReplace(file windows.Handle, parent windows.Handle, name string) error {
	utf16Name, err := windows.UTF16FromString(name)
	if err != nil {
		return wire.Errf(wire.CodeNameTooLong, "destination name not representable")
	}
	// UTF16FromString appends a NUL terminator; FileNameLength counts bytes and
	// excludes it.
	nameBytes := (len(utf16Name) - 1) * 2

	var proto fileRenameInformation
	size := int(unsafe.Offsetof(proto.FileName)) + nameBytes
	buf := make([]byte, size)
	info := (*fileRenameInformation)(unsafe.Pointer(&buf[0]))
	info.Flags = 0
	info.RootDirectory = parent
	info.FileNameLength = uint32(nameBytes)
	copy(unsafe.Slice((*uint16)(unsafe.Pointer(&info.FileName[0])), nameBytes/2), utf16Name[:len(utf16Name)-1])

	var iosb windows.IO_STATUS_BLOCK
	if status := windows.NtSetInformationFile(file, &iosb, &buf[0], uint32(size),
		windows.FileRenameInformation); status != nil {
		return classify(status)
	}
	return nil
}

// deleteByHandle removes the exact object the handle names.
//
// This is the mechanism behind "cleanup touches only objects it owns". A handle
// names one object; a file another process plants at a pathname we previously
// used is a different object that we hold no handle to, so it cannot be reached
// from here. Deletion by name could not make that distinction.
//
// FILE_DISPOSITION_INFORMATION_EX with POSIX semantics is preferred because it
// unlinks the name immediately rather than deferring to last-handle-close. The
// classic class is the fallback for filesystems that reject the newer one.
func deleteByHandle(h windows.Handle) error {
	info := fileDispositionInformationEx{
		Flags: windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_POSIX_SEMANTICS |
			windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE,
	}
	var iosb windows.IO_STATUS_BLOCK
	status := windows.NtSetInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)), windows.FileDispositionInformationEx)
	if status == nil {
		return nil
	}
	// FILE_DISPOSITION_INFORMATION_EX needs Windows 10 1709 and an NTFS volume.
	// The legacy class defers the unlink to handle close, which is still correct
	// for our purposes because we close immediately afterwards.
	var legacy struct{ DeleteFile uint8 }
	legacy.DeleteFile = 1
	if status2 := windows.NtSetInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&legacy)),
		uint32(unsafe.Sizeof(legacy)), windows.FileDispositionInformation); status2 != nil {
		return classify(status2)
	}
	return nil
}
