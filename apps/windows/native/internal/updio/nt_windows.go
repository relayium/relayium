//go:build windows

// The NT primitives. This file is where the invariants actually live.
//
// ## The one rule
//
//	Every effect targets an object we already hold a handle to. No operation is
//	preceded by a path check that a later step depends on.
//
// Traversal is handle-relative one component at a time via
// `OBJECT_ATTRIBUTES.RootDirectory`, starting from the volume root, so a
// component swapped after we opened it affects nothing. Deletion and publication
// target the handle the bytes were written through — there is no re-open by name
// for either.
//
// ## Delete sharing is the pinning mechanism
//
// Directory handles omit `FILE_SHARE_DELETE`. That is what makes the root and
// every traversed ancestor un-renameable and un-deletable while we hold them,
// which is what defeats an ancestor swap — including a swap of a parent ABOVE
// the app's own data directory, which is why the walk starts at the volume root
// rather than at the app root.
//
// ## Where this deliberately differs from the receive sink
//
// `internal/winio` publishes with `ReplaceIfExists = 0`, because overwriting a
// user's file is the outcome that design exists to prevent. The update journal
// is the opposite case: its whole purpose is to replace the previous record
// atomically, so `commit` sets `FILE_RENAME_REPLACE_IF_EXISTS`. That is a
// difference in what is being published, not a relaxation — the object renamed
// is still the exact object we wrote, proven by its file id.
//
// Primary sources:
// https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
// https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
package updio

import (
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileRenameInformation is FILE_RENAME_INFORMATION.
//
// x/sys declares the FILE_RENAME_* flags but not this structure. The C
// definition is a union of BOOLEAN ReplaceIfExists and ULONG Flags, then HANDLE
// RootDirectory, ULONG FileNameLength, WCHAR FileName[1].
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

// fileAttributeTagInfo is FILE_ATTRIBUTE_TAG_INFO: a reparse check on a handle
// we already hold, rather than on a name that would have to be re-resolved.
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// fileIdInfo is FILE_ID_INFO. x/sys v0.47.0 declares the info CLASS
// (`FileIdInfo`) but not the structure, so it is declared here: a volume serial
// and a 128-bit file id, which together are the durable identity a receipt
// compares against.
type fileIdInfo struct {
	VolumeSerialNumber uint64
	FileId             [16]byte
}

const (
	fileAddFile         = 0x0002
	fileAddSubdirectory = 0x0004

	// ancestorAccess is what walking through a directory needs and NOTHING more.
	//
	// Read, traverse, attributes. No create rights: a per-user update has no
	// business asking to add files to `C:\` or `C:\Users`, and on a machine
	// where those are locked down, asking would turn a legitimate install into
	// a failure. The pin comes from the SHARE mode, not from the access mask.
	ancestorAccess = windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE |
		windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE

	// appRootAccess adds the one creation right actually needed: the staging
	// subdirectory is created inside the app's own data root.
	appRootAccess = ancestorAccess | fileAddSubdirectory

	// stagingAccess adds file creation, in the directory this helper owns.
	stagingAccess = ancestorAccess | fileAddFile

	// dirShare omits FILE_SHARE_DELETE on purpose. This is the pin.
	dirShare = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE

	dirOptions = windows.FILE_DIRECTORY_FILE | windows.FILE_SYNCHRONOUS_IO_NONALERT

	// stagedFileAccess needs DELETE for two reasons: the rename at commit
	// requires it on the source handle, and discard deletes by handle.
	stagedFileAccess = windows.FILE_GENERIC_WRITE | windows.FILE_GENERIC_READ |
		windows.DELETE | windows.SYNCHRONIZE

	// stagedFileShare is zero while we are writing: nothing else may open it.
	stagedFileShare = 0

	// installShare allows READ only. The image loader must be able to map the
	// file for CreateProcess; write and delete stay denied, which is what keeps
	// the verified bytes the launched bytes.
	installShare = windows.FILE_SHARE_READ

	fileOptions = windows.FILE_NON_DIRECTORY_FILE | windows.FILE_SYNCHRONOUS_IO_NONALERT
)

// classify maps an NTSTATUS to one closed-set code.
//
// An unrecognised status becomes `io`. Guessing a filesystem meaning from an
// unknown status is how a helper reports a wrong cause with confidence.
func classify(err error) error {
	status, ok := err.(windows.NTStatus)
	if !ok {
		return Errf(CodeIO)
	}
	switch status {
	case windows.STATUS_OBJECT_NAME_COLLISION:
		return Errf(CodeExists)
	case windows.STATUS_OBJECT_NAME_NOT_FOUND, windows.STATUS_OBJECT_PATH_NOT_FOUND:
		return Errf(CodeNotFound)
	case windows.STATUS_ACCESS_DENIED, windows.STATUS_SHARING_VIOLATION:
		return Errf(CodeIO)
	case windows.STATUS_NOT_A_DIRECTORY:
		return Errf(CodeNotDir)
	case windows.STATUS_IO_REPARSE_TAG_NOT_HANDLED:
		return Errf(CodeRedirected)
	}
	return Errf(CodeIO)
}

// refuseReparse rejects a handle that names a reparse point.
//
// Asked of the HANDLE, not of the name: by the time this runs the object is
// already open, so the answer cannot be invalidated by a swap. `FILE_OPEN_
// REPARSE_POINT` on the open is what makes the handle name the link itself
// rather than its target, and this is what then refuses it.
func refuseReparse(h windows.Handle) error {
	var info fileAttributeTagInfo
	err := windows.GetFileInformationByHandleEx(
		h,
		windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		return Errf(CodeIO)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return Errf(CodeRedirected)
	}
	return nil
}

// receiptOf reads the durable identity of an open object.
//
// Volume serial plus the 128-bit file id. This is what a receipt compares
// against after a restart: a name can be given to a different object, an id
// cannot.
func receiptOf(h windows.Handle) (string, error) {
	var info fileIdInfo
	err := windows.GetFileInformationByHandleEx(
		h,
		windows.FileIdInfo,
		(*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		return "", Errf(CodeIO)
	}
	var id strings.Builder
	for _, b := range info.FileId {
		fmt.Fprintf(&id, "%02x", b)
	}
	return fmt.Sprintf("win:%x:%s", info.VolumeSerialNumber, id.String()), nil
}

// openVolumeRoot opens `C:\` (or whatever volume `path` names) by full NT path.
//
// This is the ONE open by name, and it is the anchor. Everything below it is
// handle-relative. Opening the app root directly instead would leave its own
// parents unpinned, and a rename of one of those still changes what a full path
// resolves to.
func openVolumeRoot(path string) (windows.Handle, []string, error) {
	// The SUPPLIED components, not a resolved form of them.
	//
	// An earlier revision opened the app root, took its final path, and walked
	// that. It looked stronger and was weaker: `GetFinalPathNameByHandleW`
	// resolves every junction on the way, so a redirected ancestor became an
	// ordinary-looking chain with nothing left to refuse. The per-component
	// reparse check could never fire, and redirected storage was accepted
	// silently — the opposite of the requirement.
	//
	// So the original path is walked as given. A junction anywhere in it is
	// refused when its component is opened, and that refusal is the evidence.
	volume, components, err := SplitPhysical(path)
	if err != nil {
		return 0, nil, err
	}
	// The DRIVE LETTER AS SUPPLIED. A `subst`ed letter is refused here rather
	// than canonicalised away: resolving first would check whatever physical
	// volume it lands on and report a mapped root as fine.
	if err := assertRealVolume(volume); err != nil {
		return 0, nil, err
	}
	name, err := windows.NewNTUnicodeString(`\??\` + volume + `\`)
	if err != nil {
		return 0, nil, Errf(CodeBadName)
	}
	var handle windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	oa := &windows.OBJECT_ATTRIBUTES{ObjectName: name}
	oa.Length = uint32(unsafe.Sizeof(*oa))
	status := windows.NtCreateFile(
		&handle, ancestorAccess, oa, &iosb, nil, 0, dirShare,
		windows.FILE_OPEN, dirOptions|windows.FILE_OPEN_REPARSE_POINT, 0, 0,
	)
	if status != nil {
		return 0, nil, classify(status)
	}
	if err := refuseReparse(handle); err != nil {
		windows.CloseHandle(handle)
		return 0, nil, err
	}
	return handle, components, nil
}

// openChildDirectory opens one component beneath a held directory, optionally
// creating it. The handle it returns is refused if it is a reparse point.
func openChildDirectory(
	parent windows.Handle, component string, access uint32, create bool,
) (windows.Handle, error) {
	name, err := windows.NewNTUnicodeString(component)
	if err != nil {
		return 0, Errf(CodeBadName)
	}
	oa := &windows.OBJECT_ATTRIBUTES{RootDirectory: parent, ObjectName: name}
	oa.Length = uint32(unsafe.Sizeof(*oa))
	disposition := uint32(windows.FILE_OPEN)
	if create {
		disposition = windows.FILE_OPEN_IF
	}
	var handle windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	status := windows.NtCreateFile(
		&handle, access, oa, &iosb, nil, 0, dirShare,
		disposition, dirOptions|windows.FILE_OPEN_REPARSE_POINT, 0, 0,
	)
	if status != nil {
		return 0, classify(status)
	}
	if err := refuseReparse(handle); err != nil {
		windows.CloseHandle(handle)
		return 0, err
	}
	return handle, nil
}

// openChildFile opens one file beneath a held directory, handle-relative.
func openChildFile(
	parent windows.Handle, name string, access uint32, share uint32, disposition uint32,
) (windows.Handle, error) {
	unicode, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return 0, Errf(CodeBadName)
	}
	oa := &windows.OBJECT_ATTRIBUTES{RootDirectory: parent, ObjectName: unicode}
	oa.Length = uint32(unsafe.Sizeof(*oa))
	var handle windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	status := windows.NtCreateFile(
		&handle, access, oa, &iosb, nil, windows.FILE_ATTRIBUTE_NORMAL, share,
		disposition, fileOptions|windows.FILE_OPEN_REPARSE_POINT, 0, 0,
	)
	if status != nil {
		return 0, classify(status)
	}
	if err := refuseReparse(handle); err != nil {
		windows.CloseHandle(handle)
		return 0, err
	}
	return handle, nil
}

// assertRealVolume refuses a drive letter that is a mapping, not a volume.
//
// `QueryDosDeviceW` answers `\Device\HarddiskVolumeN` for a real volume and
// `\??\C:\parent\dir` for a `subst`. The second is a directory wearing a
// drive letter: anchoring on it pins nothing above the directory it points at,
// while the launch path resolves through those very ancestors.
//
// Asked of the letter the CALLER supplied, before anything is resolved.
func assertRealVolume(volume string) error {
	name, err := windows.UTF16PtrFromString(volume)
	if err != nil {
		return Errf(CodeBadName)
	}
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.QueryDosDevice(name, &buffer[0], uint32(len(buffer)))
	if err != nil || n == 0 {
		return Errf(CodeIO)
	}
	if !strings.HasPrefix(windows.UTF16ToString(buffer[:n]), `\Device\`) {
		return Errf(CodeRedirected)
	}
	return nil
}

// renameHeld publishes the object `file` names as `to`, beneath `parent`.
//
// The handle is the subject: no name is re-resolved, so the object published is
// provably the object written. `FILE_RENAME_REPLACE_IF_EXISTS` is deliberate —
// see the file header.
func renameHeld(file windows.Handle, parent windows.Handle, to string) error {
	encoded, err := windows.UTF16FromString(to)
	if err != nil {
		return Errf(CodeBadName)
	}
	// Drop the terminating NUL: FileNameLength counts bytes of characters.
	encoded = encoded[:len(encoded)-1]
	size := int(unsafe.Sizeof(fileRenameInformation{})) + (len(encoded)-1)*2
	buffer := make([]byte, size)
	info := (*fileRenameInformation)(unsafe.Pointer(&buffer[0]))
	info.Flags = windows.FILE_RENAME_REPLACE_IF_EXISTS
	info.RootDirectory = parent
	info.FileNameLength = uint32(len(encoded) * 2)
	copy(
		unsafe.Slice((*uint16)(unsafe.Pointer(&info.FileName[0])), len(encoded)),
		encoded,
	)
	if err := windows.SetFileInformationByHandle(
		file, windows.FileRenameInfoEx, &buffer[0], uint32(size),
	); err != nil {
		return Errf(CodeIO)
	}
	return nil
}

// deleteByHandle removes the exact object the handle names.
func deleteByHandle(h windows.Handle) error {
	info := fileDispositionInformationEx{
		Flags: windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_POSIX_SEMANTICS,
	}
	if err := windows.SetFileInformationByHandle(
		h, windows.FileDispositionInfoEx,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)),
	); err != nil {
		return Errf(CodeIO)
	}
	return nil
}
