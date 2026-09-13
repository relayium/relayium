//go:build windows

// The on-close deletion primitive, isolated and DISABLED.
//
// ## Why this is quarantined instead of used
//
// An earlier design opened staged files with FILE_DELETE_ON_CLOSE so that a hard
// kill at any moment would leave no residue, clearing the flag just before the
// publishing rename. That claim was wrong twice over, and the corrections are
// worth keeping written down:
//
//  1. Clearing before the rename opens a window. A kill between the clear and the
//     rename leaves an orphan .part with nothing scheduled to remove it.
//     Reordering to rename-then-clear moves the window rather than closing it.
//
//  2. More fundamentally, it is NOT established that
//     FILE_DISPOSITION_INFORMATION with DeleteFile = FALSE clears the on-close
//     state set by the FILE_DELETE_ON_CLOSE *create option*. Those are
//     historically distinct pieces of state.
//     FILE_DISPOSITION_INFORMATION_EX documents a dedicated
//     FILE_DISPOSITION_ON_CLOSE flag for setting and clearing on-close deletion,
//     which is itself evidence that the plain class does not cover it:
//     https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex
//
// So the shipped design does not depend on this at all. Graceful cancel, stdin
// EOF, protocol failure and publish failure all delete by handle, which is
// testable and is where the zero-residue guarantee actually lives. A hard kill
// leaves the bounded residue documented in sink_windows.go.
//
// These functions exist so the primitive can be PROVEN on a real Windows runner
// — at kill barriers before-set, after-set, before-rename, after-rename and
// after-close — before anything is allowed to rely on it. Until that evidence
// exists, OnCloseDeletionEnabled is false and no checkpoint claims zero
// hard-kill residue.

package winio

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// OnCloseDeletionEnabled gates the primitive. It stays false until a real
// Windows runner has demonstrated setAndClearOnClose survives every kill
// barrier. Flipping it without that evidence would reintroduce the exact claim
// that was withdrawn above.
const OnCloseDeletionEnabled = false

// setOnCloseDeletion asks for the object to be removed when its last handle
// closes, using the explicit ON_CLOSE flag rather than the create option.
func setOnCloseDeletion(h windows.Handle) error {
	return setDisposition(h, windows.FILE_DISPOSITION_DELETE|
		windows.FILE_DISPOSITION_ON_CLOSE|
		windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE)
}

// clearOnCloseDeletion cancels it. Whether this actually reverses the create
// option is the open question; against setOnCloseDeletion it should be
// symmetric, which is what the Windows tests must establish.
func clearOnCloseDeletion(h windows.Handle) error {
	return setDisposition(h, windows.FILE_DISPOSITION_DO_NOT_DELETE|windows.FILE_DISPOSITION_ON_CLOSE)
}

func setDisposition(h windows.Handle, flags uint32) error {
	info := fileDispositionInformationEx{Flags: flags}
	var iosb windows.IO_STATUS_BLOCK
	if status := windows.NtSetInformationFile(h, &iosb, (*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)), windows.FileDispositionInformationEx); status != nil {
		return classify(status)
	}
	return nil
}
