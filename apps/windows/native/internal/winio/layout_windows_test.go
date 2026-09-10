//go:build windows

// Compile-time layout assertions for the structures x/sys does not declare.
//
// These prove offset arithmetic and nothing else. They prove no filesystem
// semantics, and must not be cited as if they did.
package winio

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Negative-length arrays: a false condition fails to compile. The pair of
// assertions per field pins the offset exactly rather than bounding it.
type (
	_ [unsafe.Offsetof(fileRenameInformation{}.RootDirectory) - ptrSize]byte
	_ [ptrSize - unsafe.Offsetof(fileRenameInformation{}.RootDirectory)]byte
	_ [unsafe.Offsetof(fileRenameInformation{}.FileNameLength) - 2*ptrSize]byte
	_ [2*ptrSize - unsafe.Offsetof(fileRenameInformation{}.FileNameLength)]byte
	_ [unsafe.Sizeof(fileAttributeTagInfo{}) - 8]byte
	_ [8 - unsafe.Sizeof(fileAttributeTagInfo{})]byte
	_ [unsafe.Sizeof(fileDispositionInformationEx{}) - 4]byte
	_ [4 - unsafe.Sizeof(fileDispositionInformationEx{})]byte
)

const ptrSize = unsafe.Sizeof(windows.Handle(0))

// FileName sits immediately after FileNameLength with no tail padding, because
// the buffer size is computed from its offset.
func TestRenameInformationFileNameOffset(t *testing.T) {
	var proto fileRenameInformation
	want := uintptr(2*ptrSize) + 4
	if got := unsafe.Offsetof(proto.FileName); got != want {
		t.Fatalf("FileName offset %d, want %d; the rename buffer size would be wrong", got, want)
	}
}

// The one flag value the whole design depends on.
func TestRenameFlagsAreNoReplace(t *testing.T) {
	var proto fileRenameInformation
	if proto.Flags != 0 {
		t.Fatal("zero value of Flags is not zero")
	}
	if windows.FILE_RENAME_REPLACE_IF_EXISTS == 0 {
		t.Fatal("FILE_RENAME_REPLACE_IF_EXISTS is zero, so setting Flags to 0 would no longer mean no-replace")
	}
}
