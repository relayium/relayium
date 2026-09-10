//go:build windows

// Kill-barrier evidence for the quarantined on-close primitive.
//
// These tests exist to ANSWER the question sink_windows.go currently refuses to
// assume: does clearing the on-close disposition actually reverse it, and at
// which barriers does a killed process leave residue? Until they run green on a
// real Windows host, OnCloseDeletionEnabled stays false and no document claims
// zero hard-kill residue.
//
// They are written to fail loudly rather than skip, because a skipped test here
// would read as evidence that was never gathered.
package winio

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func openDirHandle(t *testing.T, path string) windows.Handle {
	t.Helper()
	h, err := openRoot(path)
	if err != nil {
		t.Fatalf("openRoot(%s): %v", filepath.Base(path), err)
	}
	t.Cleanup(func() { windows.CloseHandle(h) })
	return h
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// Barrier: set, then close. The object must be gone.
func TestOnCloseDeletionRemovesOnClose(t *testing.T) {
	root := t.TempDir()
	dir := openDirHandle(t, root)
	h, err := createStagedFile(dir, "victim.part")
	if err != nil {
		t.Fatalf("createStagedFile: %v", err)
	}
	if err := setOnCloseDeletion(h); err != nil {
		t.Fatalf("setOnCloseDeletion: %v", err)
	}
	if !exists(filepath.Join(root, "victim.part")) {
		t.Fatal("setting on-close deletion unlinked the file immediately; that is delete-now, not delete-on-close")
	}
	windows.CloseHandle(h)
	if exists(filepath.Join(root, "victim.part")) {
		t.Fatal("on-close deletion did not remove the file at close")
	}
}

// Barrier: set, clear, then close. The object must SURVIVE.
//
// This is the specific claim that was withdrawn from the design. If it fails,
// the primitive cannot be used for staged files at all and the current
// no-delete-on-close design is confirmed as the only correct one.
func TestOnCloseDeletionCanBeCleared(t *testing.T) {
	root := t.TempDir()
	dir := openDirHandle(t, root)
	h, err := createStagedFile(dir, "survivor.part")
	if err != nil {
		t.Fatalf("createStagedFile: %v", err)
	}
	if err := setOnCloseDeletion(h); err != nil {
		t.Fatalf("setOnCloseDeletion: %v", err)
	}
	if err := clearOnCloseDeletion(h); err != nil {
		t.Fatalf("clearOnCloseDeletion: %v", err)
	}
	windows.CloseHandle(h)
	if !exists(filepath.Join(root, "survivor.part")) {
		t.Fatal("clearing on-close deletion did not reverse it; the primitive is unusable for staged files")
	}
}

// Barrier: does the CREATE OPTION set the same state the EX class can clear?
//
// This is the distinction that made the original zero-residue claim unsound.
// FILE_DELETE_ON_CLOSE as a create option and FILE_DISPOSITION_ON_CLOSE as a
// disposition flag are historically separate pieces of state, and the answer
// determines whether a delete-on-close staging design is possible at all.
func TestCreateOptionDeleteOnCloseVersusDispositionClear(t *testing.T) {
	root := t.TempDir()
	dir := openDirHandle(t, root)

	name, err := windows.NewNTUnicodeString("createflag.part")
	if err != nil {
		t.Fatal(err)
	}
	oa := &windows.OBJECT_ATTRIBUTES{RootDirectory: dir, ObjectName: name}
	oa.Length = uint32(unsafe.Sizeof(*oa))

	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	var alloc int64
	if status := windows.NtCreateFile(&h, stagedFileAccess, oa, &iosb, &alloc,
		windows.FILE_ATTRIBUTE_NORMAL, stagedFileShare, windows.FILE_CREATE,
		stagedFileOptions|windows.FILE_DELETE_ON_CLOSE, 0, 0); status != nil {
		t.Fatalf("NtCreateFile with FILE_DELETE_ON_CLOSE: %v", status)
	}

	clearErr := clearOnCloseDeletion(h)
	windows.CloseHandle(h)
	survived := exists(filepath.Join(root, "createflag.part"))

	// Both outcomes are informative and both are recorded rather than asserted
	// into a preferred answer. What must NOT happen is a design that assumes the
	// clear works without this evidence.
	t.Logf("%s does clearOnCloseDeletion reverse the FILE_DELETE_ON_CLOSE create option? clear returned %v, file survived close = %v. Recording the platform's answer; correction A stands until it is read back and acted on.", openQuestionPrefix, clearErr, survived)
	if clearErr == nil && !survived {
		t.Fatal("clearOnCloseDeletion reported success but the file was still deleted; the create option sets state the EX class does not clear, exactly as suspected")
	}
}

// The default configuration must remain the one that needs no unproven primitive.
func TestOnCloseDeletionStaysDisabledWithoutRuntimeEvidence(t *testing.T) {
	if OnCloseDeletionEnabled {
		t.Fatal("OnCloseDeletionEnabled was turned on; that requires the kill-barrier evidence in this file to have run green on a real Windows host, and the checkpoint to have been updated to match")
	}
}
