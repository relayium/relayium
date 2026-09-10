//go:build windows

// The session's held state: one scope, a bounded set of open files.
//
// Every method here acts on a handle this session opened. The only name that
// ever reaches an NT call is one inert component, resolved relative to the
// staging handle — never a path, never anything a renderer could have chosen.
package updio

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"

	"golang.org/x/sys/windows"
)

type openFile struct {
	handle  windows.Handle
	name    string
	receipt string
}

// WindowsCustody holds the traversal chain and the files this session opened.
type WindowsCustody struct {
	// ancestors are every directory from the volume root down to the app root,
	// held for the session's lifetime. Holding them without FILE_SHARE_DELETE
	// is what stops a parent — including one ABOVE the app root — being renamed
	// out from under a full path.
	ancestors []windows.Handle
	staging   windows.Handle
	open      bool
	next      uint32
	files     map[uint32]*openFile

	// onLaunched, when set, is handed the process `install.run` created, before
	// its handles are closed. Nil in every shipped path — it exists so an
	// acceptance test can join the exact process by handle. It is an observer:
	// it cannot choose the image, the arguments or the environment, because
	// there is nothing to choose.
	onLaunched func(windows.ProcessInformation)

	// stdHandleForTest, when set, is the child's stdin instead of NUL. Nil in
	// every shipped path; it exists so an acceptance case can hold the launched
	// process alive while it checks what crossed the inheritance boundary.
	stdHandleForTest windows.Handle

	// shareForTest is appended to the inheritance allow-list. Empty in every
	// shipped path — see ShareForTest.
	shareForTest []windows.Handle
}

// UseStdInputForTest installs the seam described on `stdHandleForTest`.
func (c *WindowsCustody) UseStdInputForTest(handle windows.Handle) {
	c.stdHandleForTest = handle
}

// ShareForTest ADDS handles to the launch's inheritance allow-list.
//
// Only a test calls this, and only to prove that the probe which checks the
// boundary can actually see a handle cross it. It can add — never remove, and
// never widen inheritance beyond the explicit list — so the shipped path is the
// same code with an empty extra set.
func (c *WindowsCustody) ShareForTest(handles []windows.Handle) {
	c.shareForTest = handles
}

// ObserveLaunchesForTest installs the observer described on `onLaunched`.
func (c *WindowsCustody) ObserveLaunchesForTest(observe func(windows.ProcessInformation)) {
	c.onLaunched = observe
}

// NewWindowsCustody returns an unopened session.
func NewWindowsCustody() *WindowsCustody {
	return &WindowsCustody{files: map[uint32]*openFile{}}
}

func (c *WindowsCustody) Open(root, component string) error {
	if c.open {
		return Errf(CodeProtocol)
	}
	volume, components, err := openVolumeRoot(root)
	if err != nil {
		return err
	}
	c.ancestors = append(c.ancestors, volume)
	parent := volume
	for i, name := range components {
		// Each ancestor is opened, refused if it is a reparse point, and KEPT
		// open. A closed ancestor is an unpinned ancestor.
		//
		// Only the LAST one — the app's own data root — gets the right to create
		// a subdirectory, because that is where `updates` goes. Everything above
		// it is read and traversed and nothing more.
		access := uint32(ancestorAccess)
		if i == len(components)-1 {
			access = appRootAccess
		}
		next, err := openChildDirectory(parent, name, access, false)
		if err != nil {
			c.releaseAll()
			return err
		}
		c.ancestors = append(c.ancestors, next)
		parent = next
	}
	staging, err := openChildDirectory(parent, component, stagingAccess, true)
	if err != nil {
		c.releaseAll()
		return err
	}
	c.staging = staging
	c.open = true
	return nil
}

func (c *WindowsCustody) CreateExclusive(name string) (uint32, string, error) {
	if !c.open {
		return 0, "", Errf(CodeNoScope)
	}
	if len(c.files) >= MaxOpenHandles {
		return 0, "", Errf(CodeHandles)
	}
	handle, err := openChildFile(c.staging, name, stagedFileAccess, stagedFileShare, windows.FILE_CREATE)
	if err != nil {
		return 0, "", err
	}
	receipt, err := receiptOf(handle)
	if err != nil {
		// A file exists that no receipt describes, so the host could never ask
		// for it back. It was created exclusively a moment ago and is
		// unambiguously this session's, and the delete targets that exact
		// handle — so removing it is the safe direction here, unlike a refusal
		// whose cause is the directory itself.
		_ = deleteByHandle(handle)
		windows.CloseHandle(handle)
		return 0, "", err
	}
	c.next++
	c.files[c.next] = &openFile{handle: handle, name: name, receipt: receipt}
	return c.next, receipt, nil
}

func (c *WindowsCustody) file(id uint32) (*openFile, error) {
	f, ok := c.files[id]
	if !ok {
		return nil, Errf(CodeNoHandle)
	}
	return f, nil
}

func (c *WindowsCustody) Write(id uint32, chunk []byte) error {
	f, err := c.file(id)
	if err != nil {
		return err
	}
	for written := 0; written < len(chunk); {
		var n uint32
		if err := windows.WriteFile(f.handle, chunk[written:], &n, nil); err != nil {
			return Errf(CodeIO)
		}
		if n == 0 {
			return Errf(CodeIO)
		}
		written += int(n)
	}
	return nil
}

func (c *WindowsCustody) Sync(id uint32) error {
	f, err := c.file(id)
	if err != nil {
		return err
	}
	if err := windows.FlushFileBuffers(f.handle); err != nil {
		return Errf(CodeIO)
	}
	return nil
}

// Release closes a handle WITHOUT deleting. The object and its receipt survive.
func (c *WindowsCustody) Release(id uint32) error {
	f, err := c.file(id)
	if err != nil {
		return err
	}
	windows.CloseHandle(f.handle)
	delete(c.files, id)
	return nil
}

// Commit publishes the handle's file, through that same handle.
//
// The identity is re-read from the handle first. That is not belt and braces:
// it is the difference between "rename the thing I wrote" and "rename whatever
// is called that now".
func (c *WindowsCustody) Commit(id uint32, to string) error {
	f, err := c.file(id)
	if err != nil {
		return err
	}
	current, err := receiptOf(f.handle)
	if err != nil {
		return err
	}
	if current != f.receipt {
		return Errf(CodeIdentity)
	}
	if err := renameHeld(f.handle, c.staging, to); err != nil {
		return err
	}
	// The handle now names a different entry. Without this, a later discard
	// would confirm against the temp name the file no longer has — and would
	// report a stale absence as success.
	f.name = to
	return nil
}

// Discard deletes the handle's object and confirms the absence.
func (c *WindowsCustody) Discard(id uint32) (bool, error) {
	f, err := c.file(id)
	if err != nil {
		return false, err
	}
	current, receiptErr := receiptOf(f.handle)
	if receiptErr == nil && current != f.receipt {
		// Someone else's object now. Not deleted, and the handle is released so
		// the host can decide what to do with a receipt that no longer matches.
		windows.CloseHandle(f.handle)
		delete(c.files, id)
		return false, Errf(CodeIdentity)
	}
	deleteErr := deleteByHandle(f.handle)
	// Closed first: a pending deletion is not an absence, and this session's own
	// handle is one of the things that could keep it pending.
	windows.CloseHandle(f.handle)
	delete(c.files, id)
	if deleteErr != nil {
		return false, nil
	}
	// Confirmed, not assumed: the name must no longer resolve to anything. If
	// another process holds the object open with delete sharing, this reports
	// NOT gone and the host keeps owning the residue.
	_, present, err := c.Identity(f.name)
	if err != nil {
		return false, nil
	}
	return !present, nil
}

func (c *WindowsCustody) Identity(name string) (string, bool, error) {
	if !c.open {
		return "", false, Errf(CodeNoScope)
	}
	handle, err := openChildFile(
		c.staging, name, windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		windows.FILE_OPEN,
	)
	if err != nil {
		// Absent is not an error: the caller distinguishes "nothing there" from
		// "could not tell", and conflating them is how recovery decides about a
		// file it never saw.
		if IsCode(err, CodeNotFound) {
			return "", false, nil
		}
		return "", false, err
	}
	defer windows.CloseHandle(handle)
	receipt, err := receiptOf(handle)
	if err != nil {
		return "", false, err
	}
	return receipt, true, nil
}

// Remove deletes `name` only while it is still the object `receipt` describes.
func (c *WindowsCustody) Remove(name, receipt string) (bool, error) {
	if !c.open {
		return false, Errf(CodeNoScope)
	}
	handle, err := openChildFile(
		c.staging, name, windows.DELETE|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		windows.FILE_OPEN,
	)
	if err != nil {
		// Nothing there is a confirmed absence.
		if IsCode(err, CodeNotFound) {
			return true, nil
		}
		return false, err
	}
	current, receiptErr := receiptOf(handle)
	if receiptErr != nil {
		windows.CloseHandle(handle)
		return false, receiptErr
	}
	if current != receipt {
		windows.CloseHandle(handle)
		return false, Errf(CodeIdentity)
	}
	deleteErr := deleteByHandle(handle)
	// Closed BEFORE the confirmation, and the confirmation is a real one.
	// `deleteByHandle` returning success is not absence: without POSIX
	// semantics the deletion is PENDING until every handle closes, and another
	// process may hold one with delete sharing. So the name is re-checked, and
	// anything still there is reported as not gone — residue the host keeps
	// owning rather than a cleanup this claims to have finished.
	windows.CloseHandle(handle)
	if deleteErr != nil {
		return false, nil
	}
	_, present, err := c.Identity(name)
	if err != nil {
		return false, nil
	}
	return !present, nil
}

func (c *WindowsCustody) ReadBounded(name string, max int) ([]byte, bool, error) {
	if !c.open {
		return nil, false, Errf(CodeNoScope)
	}
	handle, err := openChildFile(
		c.staging, name, windows.FILE_GENERIC_READ,
		windows.FILE_SHARE_READ, windows.FILE_OPEN,
	)
	if err != nil {
		if IsCode(err, CodeNotFound) {
			return nil, false, nil
		}
		return nil, false, err
	}
	defer windows.CloseHandle(handle)
	size, err := sizeOf(handle)
	if err != nil {
		return nil, false, err
	}
	// Checked THROUGH the handle and before any read, so an oversized document
	// is refused rather than read into memory first. An oversized record is an
	// ERROR, never an absence.
	if size > int64(max) {
		return nil, false, Errf(CodeTooLarge)
	}
	buffer := make([]byte, size)
	if err := readFull(handle, buffer); err != nil {
		return nil, false, err
	}
	return buffer, true, nil
}

func (c *WindowsCustody) HashOwned(name, receipt string, size int64) (string, bool, error) {
	if !c.open {
		return "", false, Errf(CodeNoScope)
	}
	handle, err := openChildFile(
		c.staging, name, windows.FILE_GENERIC_READ,
		windows.FILE_SHARE_READ, windows.FILE_OPEN,
	)
	if err != nil {
		if IsCode(err, CodeNotFound) {
			return "", false, nil
		}
		return "", false, err
	}
	defer windows.CloseHandle(handle)
	current, err := receiptOf(handle)
	if err != nil {
		return "", false, err
	}
	actual, err := sizeOf(handle)
	if err != nil {
		return "", false, err
	}
	// Identity first: a different object of the right length would otherwise be
	// hashed and reported as this candidate's bytes.
	if current != receipt || actual != size {
		return "", false, nil
	}
	digest := sha256.New()
	if err := streamInto(handle, digest); err != nil {
		return "", false, err
	}
	return hex.EncodeToString(digest.Sum(nil)), true, nil
}

// Close releases every handle this session holds. Called on every exit.
func (c *WindowsCustody) Close() error {
	c.releaseAll()
	return nil
}

func (c *WindowsCustody) releaseAll() {
	for id, f := range c.files {
		windows.CloseHandle(f.handle)
		delete(c.files, id)
	}
	if c.staging != 0 {
		windows.CloseHandle(c.staging)
		c.staging = 0
	}
	for i := len(c.ancestors) - 1; i >= 0; i-- {
		windows.CloseHandle(c.ancestors[i])
	}
	c.ancestors = nil
	c.open = false
}

func sizeOf(h windows.Handle) (int64, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return 0, Errf(CodeIO)
	}
	return int64(info.FileSizeHigh)<<32 | int64(info.FileSizeLow), nil
}

func readFull(h windows.Handle, into []byte) error {
	for read := 0; read < len(into); {
		var n uint32
		if err := windows.ReadFile(h, into[read:], &n, nil); err != nil {
			return Errf(CodeIO)
		}
		if n == 0 {
			return Errf(CodeIO)
		}
		read += int(n)
	}
	return nil
}

func streamInto(h windows.Handle, sink io.Writer) error {
	buffer := make([]byte, 1<<20)
	for {
		var n uint32
		err := windows.ReadFile(h, buffer, &n, nil)
		if err != nil {
			if errors.Is(err, windows.ERROR_HANDLE_EOF) {
				return nil
			}
			return Errf(CodeIO)
		}
		if n == 0 {
			return nil
		}
		if _, err := sink.Write(buffer[:n]); err != nil {
			return Errf(CodeIO)
		}
	}
}
