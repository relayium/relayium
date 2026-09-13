//go:build windows

// Junction helpers for the reparse-point tests.
//
// A junction is created directly rather than by shelling out to mklink: the
// tests must be able to run on a Windows CI runner without depending on cmd.exe
// being available or on its output format.
package winio

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// mountPointReparseBuffer is REPARSE_DATA_BUFFER specialised for
// IO_REPARSE_TAG_MOUNT_POINT. x/sys does not declare it.
//
// https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/ca069dad-ed16-42aa-b057-b6b207f447cc
type mountPointReparseBuffer struct {
	ReparseTag           uint32
	ReparseDataLength    uint16
	Reserved             uint16
	SubstituteNameOffset uint16
	SubstituteNameLength uint16
	PrintNameOffset      uint16
	PrintNameLength      uint16
	PathBuffer           [1]uint16
}

// makeJunction creates a directory junction at link pointing at target.
func makeJunction(link, target string) error {
	if err := os.Mkdir(link, 0o755); err != nil {
		return err
	}
	handle, err := openReparsePointDirectory(link)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)

	substitute, err := windows.UTF16FromString(`\??\` + target)
	if err != nil {
		return err
	}
	printName, err := windows.UTF16FromString(target)
	if err != nil {
		return err
	}
	// Both names are stored NUL-terminated, with the lengths excluding the
	// terminators.
	subBytes := (len(substitute) - 1) * 2
	printBytes := (len(printName) - 1) * 2
	pathBytes := subBytes + 2 + printBytes + 2

	var proto mountPointReparseBuffer
	headerBytes := int(unsafe.Offsetof(proto.PathBuffer))
	buf := make([]byte, headerBytes+pathBytes)
	rb := (*mountPointReparseBuffer)(unsafe.Pointer(&buf[0]))
	rb.ReparseTag = windows.IO_REPARSE_TAG_MOUNT_POINT
	// ReparseDataLength counts everything after the 8-byte common header.
	rb.ReparseDataLength = uint16(len(buf) - 8)
	rb.SubstituteNameOffset = 0
	rb.SubstituteNameLength = uint16(subBytes)
	rb.PrintNameOffset = uint16(subBytes + 2)
	rb.PrintNameLength = uint16(printBytes)

	path := unsafe.Slice((*uint16)(unsafe.Pointer(&rb.PathBuffer[0])), pathBytes/2)
	copy(path, substitute)
	copy(path[len(substitute):], printName)

	var returned uint32
	return windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT,
		&buf[0], uint32(len(buf)), nil, 0, &returned, nil)
}

// removeJunction deletes the reparse point, then the (now ordinary) directory.
//
// ## One close owner
//
// The handle must be released BEFORE os.Remove, so the close cannot simply be
// deferred — but an earlier version deferred it AND closed it explicitly, which
// closed the same handle twice. That is not a harmless duplicate: once the first
// close returns, the value is free for the kernel to hand to the next open in
// this process, so the second close can shut an unrelated object belonging to
// another test's sink. Failures from that are arbitrary and land far from here.
//
// `closed` makes the deferred close a fallback for the error paths only, so
// exactly one close happens on every path.
func removeJunction(link string) error {
	handle, err := openReparsePointDirectory(link)
	if err != nil {
		return fmt.Errorf("opening the junction: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			windows.CloseHandle(handle)
		}
	}()

	var header struct {
		ReparseTag        uint32
		ReparseDataLength uint16
		Reserved          uint16
	}
	header.ReparseTag = windows.IO_REPARSE_TAG_MOUNT_POINT
	var returned uint32
	if err := windows.DeviceIoControl(handle, windows.FSCTL_DELETE_REPARSE_POINT,
		(*byte)(unsafe.Pointer(&header)), uint32(unsafe.Sizeof(header)), nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("deleting the reparse point: %w", err)
	}
	// Errors are propagated rather than dropped: a close that fails here means
	// the directory below is unlikely to be removable either, and the caller is
	// deciding whether an attack step actually happened.
	closed = true
	if err := windows.CloseHandle(handle); err != nil {
		return fmt.Errorf("closing the junction handle: %w", err)
	}
	if err := os.Remove(link); err != nil {
		return fmt.Errorf("removing the junction directory: %w", err)
	}
	return nil
}

// junctionTarget reports where a junction currently resolves to, so a test can
// verify that a retarget it attempted ACTUALLY took effect rather than assuming
// it from a nil error.
func junctionTarget(link string) (string, error) {
	handle, err := windows.CreateFile(mustUTF16(link), windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(handle, &buf[0], uint32(len(buf)), fileNameNormalizedDOS)
	if err != nil {
		return "", err
	}
	if n == 0 || n > uint32(len(buf)) {
		return "", fmt.Errorf("final path length %d out of range", n)
	}
	return windows.UTF16ToString(buf[:n]), nil
}

func mustUTF16(s string) *uint16 {
	p, err := windows.UTF16PtrFromString(s)
	if err != nil {
		// Only reachable with an embedded NUL, which no test path produces.
		panic(err)
	}
	return p
}

func openReparsePointDirectory(path string) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}
