//go:build windows

// Kill-barrier evidence for the quarantined on-close primitive.
//
// These tests exist to ANSWER the question sink_windows.go refuses to assume:
// does clearing the on-close disposition actually reverse it, and at which
// barriers does a killed process leave residue? OnCloseDeletionEnabled stays
// false regardless of what they find; nothing here can enable it, and no
// document may claim zero hard-kill residue on their strength.
//
// ## What the first real Windows runner answered
//
// `setOnCloseDeletion` returned STATUS_NOT_SUPPORTED. The flag values make the
// shape of that answer precise:
//
//	set    DELETE|ON_CLOSE|IGNORE_READONLY  = 0x01|0x08|0x10 = 0x19  REFUSED
//	clear  DO_NOT_DELETE|ON_CLOSE           = 0x00|0x08      = 0x08  accepted
//	delete DELETE|POSIX|IGNORE_READONLY     = 0x01|0x02|0x10 = 0x13  accepted
//
// The last line matters: `deleteByHandle` uses the same information class and
// its tests pass, so FILE_DISPOSITION_INFORMATION_EX is supported on that host.
// What is refused is specifically ESTABLISHING delete-on-close through the
// disposition class. Clearing it works — the create-option probe below observed
// a file created with FILE_DELETE_ON_CLOSE survive its close after a clear.
//
// So the primitive is available in one direction only, which is worse than
// unproven for the withdrawn design: that design needed to SET the state on a
// staged file, and this host will not. Correction A's conclusion is
// strengthened rather than merely unrefuted.
//
// ## Unsupported is not failure, and it is not success either
//
// A disabled experimental capability that the platform declines must not be
// reported as a shipping failure — nothing in the shipped path calls these
// functions — and must not be reported as evidence that the primitive works.
// So the known STATUS_NOT_SUPPORTED case logs EXPERIMENT-UNSUPPORTED, asserts
// the capability is still disabled, and returns NORMALLY. It is deliberately
// not a skip: a skip would say the question was never asked, when in fact it
// was asked and answered. Any OTHER error still fails the test.
package winio

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// experimentUnsupportedPrefix marks a capability the platform declined. It is
// neither a proven invariant nor a failure, and the owning CI reads it back as
// its own category.
const experimentUnsupportedPrefix = "EXPERIMENT-UNSUPPORTED:"

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

// stagedForExperiment creates one staged file and returns it with a close
// function that is the SINGLE owner of the handle.
//
// ## Why ownership is centralised here
//
// The first Windows run turned two failures into four log lines: each test
// t.Fatal'd while still holding the staged handle, and `t.TempDir`'s own
// RemoveAll cleanup then failed because Windows refuses to unlink a file with
// an open handle. The real defect was reported twice and accompanied by noise
// about a temp directory.
//
// So the cleanup is registered IMMEDIATELY on success, before any assertion
// that can end the test. `close` is idempotent, so a test that closes the
// handle deliberately — which is the barrier several of these tests exist to
// exercise — does not double-close it. Closing a handle twice is not a harmless
// duplicate: the value is free for the kernel to reuse the moment the first
// close returns, so the second could shut an unrelated object.
//
// Ordering works out because t.Cleanup is LIFO and t.TempDir registered its
// RemoveAll first: this close runs before that removal.
func stagedForExperiment(t *testing.T, dir windows.Handle, name string) (windows.Handle, func()) {
	t.Helper()
	h, err := createStagedFile(dir, name)
	if err != nil {
		t.Fatalf("createStagedFile(%s): %v", name, err)
	}
	closed := false
	close := func() {
		if closed {
			return
		}
		closed = true
		windows.CloseHandle(h)
	}
	t.Cleanup(close)
	return h, close
}

// declinedByPlatform reports whether err is the platform REFUSING this flag
// combination rather than failing to carry it out.
//
// The status is compared against the named constant formatted exactly as
// classify formats an unrecognised one, so this cannot drift into matching a
// hand-written string that classify no longer produces.
func declinedByPlatform(err error) bool {
	return wire.CodeOf(err) == wire.CodeIO &&
		wire.DetailOf(err) == fmt.Sprintf("0x%08X", uint32(windows.STATUS_NOT_SUPPORTED))
}

// reportDeclined records the capability answer and asserts the only thing that
// matters about it: that nothing was enabled on the strength of a refusal.
//
// `flags` is the exact combination the refused call passed, and the message says
// only that. An earlier version described every refusal as "establishing
// delete-on-close is refused", which is wrong when the refused call is the
// CLEAR — that combination establishes nothing. A capability report that
// generalises past the one combination it tested is the same overclaim this file
// exists to avoid, just pointing the other way.
func reportDeclined(t *testing.T, call, flags string, err error) {
	t.Helper()
	t.Logf("%s %s returned %v on this host. The refused combination is exactly %s, and "+
		"that is the whole claim: FILE_DISPOSITION_INFORMATION_EX itself is supported here, "+
		"because deleteByHandle passes DELETE|POSIX|IGNORE_READONLY (0x13) through the same "+
		"class and its tests pass. This is NOT a claim about other flag combinations, about "+
		"set operations in general, or about other hosts. Not a shipping failure: no shipped "+
		"code path calls this. Not evidence the capability works either.",
		experimentUnsupportedPrefix, call, err, flags)
	if OnCloseDeletionEnabled {
		t.Fatal("OnCloseDeletionEnabled is true while the platform refuses the primitive it depends on")
	}
}

// The combinations these tests pass, named once so a log cannot describe one
// call using another's flags. Values are from x/sys v0.47.0 types_windows.go.
const (
	setFlagsDescription   = "DELETE|ON_CLOSE|IGNORE_READONLY (0x19)"
	clearFlagsDescription = "DO_NOT_DELETE|ON_CLOSE (0x08)"
)

// Barrier: set, then close. The object must be gone.
func TestOnCloseDeletionRemovesOnClose(t *testing.T) {
	root := t.TempDir()
	dir := openDirHandle(t, root)
	h, closeHandle := stagedForExperiment(t, dir, "victim.part")
	victim := filepath.Join(root, "victim.part")

	if err := setOnCloseDeletion(h); err != nil {
		if declinedByPlatform(err) {
			reportDeclined(t, "setOnCloseDeletion", setFlagsDescription, err)
			return
		}
		t.Fatalf("setOnCloseDeletion: %v", err)
	}

	// Supported host: the full assertions, unweakened.
	if !exists(victim) {
		t.Fatal("setting on-close deletion unlinked the file immediately; that is delete-now, not delete-on-close")
	}
	closeHandle()
	if exists(victim) {
		t.Fatal("on-close deletion did not remove the file at close")
	}
}

// Barrier: set, clear, then close. The object must SURVIVE.
//
// This is the specific claim that was withdrawn from the design. A host that
// refuses the set cannot answer it, and says so rather than passing quietly.
func TestOnCloseDeletionCanBeCleared(t *testing.T) {
	root := t.TempDir()
	dir := openDirHandle(t, root)
	h, closeHandle := stagedForExperiment(t, dir, "survivor.part")
	survivor := filepath.Join(root, "survivor.part")

	if err := setOnCloseDeletion(h); err != nil {
		if declinedByPlatform(err) {
			reportDeclined(t, "setOnCloseDeletion", setFlagsDescription, err)
			return
		}
		t.Fatalf("setOnCloseDeletion: %v", err)
	}
	if err := clearOnCloseDeletion(h); err != nil {
		if declinedByPlatform(err) {
			reportDeclined(t, "clearOnCloseDeletion", clearFlagsDescription, err)
			return
		}
		t.Fatalf("clearOnCloseDeletion: %v", err)
	}
	closeHandle()
	if !exists(survivor) {
		t.Fatal("clearing on-close deletion did not reverse it; the primitive is unusable for staged files")
	}
}

// Barrier: does the CREATE OPTION set the same state the EX class can clear?
//
// This is the distinction that made the original zero-residue claim unsound.
// FILE_DELETE_ON_CLOSE as a create option and FILE_DISPOSITION_ON_CLOSE as a
// disposition flag are historically separate pieces of state.
//
// The first real runner answered: clear returned nil and the file survived, so
// the create option's state IS reversible through the EX class there. That is
// recorded and not celebrated — it does not make the withdrawn design available,
// because the same host refuses to SET the state on a staged file at all. Half a
// primitive is not a primitive.
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
	// Single owner, registered before anything that can end the test. The file
	// may or may not survive the close, which is the whole question, so the
	// path is not asserted to exist during cleanup.
	closed := false
	closeHandle := func() {
		if closed {
			return
		}
		closed = true
		windows.CloseHandle(h)
	}
	t.Cleanup(closeHandle)

	clearErr := clearOnCloseDeletion(h)
	closeHandle()
	survived := exists(filepath.Join(root, "createflag.part"))

	if clearErr != nil {
		if declinedByPlatform(clearErr) {
			reportDeclined(t, "clearOnCloseDeletion", clearFlagsDescription, clearErr)
			return
		}
		// An unexpected error still fails, here as in the two tests above.
		//
		// This branch was missing, and its absence was not visible: the survival
		// assertion below is guarded on `clearErr == nil`, so any error other
		// than the known refusal fell through the log and PASSED. The test would
		// have reported an access denial or a torn call as a recorded platform
		// answer.
		t.Fatalf("clearOnCloseDeletion: %v", clearErr)
	}

	// The clear succeeded. Two outcomes remain, both informative, so the answer
	// is RECORDED rather than asserted into a preferred one. What must NOT
	// happen is a design that assumes the clear works without this evidence.
	t.Logf("%s does clearOnCloseDeletion reverse the FILE_DELETE_ON_CLOSE create option? "+
		"clear succeeded with %s, file survived close = %v. Reversal alone does not make "+
		"the withdrawn delete-on-close staging design usable; that also needs "+
		"setOnCloseDeletion, which this class of host may refuse. Correction A stands.",
		openQuestionPrefix, clearFlagsDescription, survived)
	if !survived {
		t.Fatal("clearOnCloseDeletion reported success but the file was still deleted; the create option sets state the EX class does not clear, exactly as suspected")
	}
}

// The default configuration must remain the one that needs no unproven
// primitive. Nothing in this file may change that, whatever it observes.
func TestOnCloseDeletionStaysDisabledWithoutRuntimeEvidence(t *testing.T) {
	if OnCloseDeletionEnabled {
		t.Fatal("OnCloseDeletionEnabled was turned on; that requires the kill-barrier evidence in this file to have run green on a real Windows host, and the checkpoint to have been updated to match")
	}
}
