//go:build windows

package stdinpump

import (
	"errors"
	"syscall"
	"testing"
)

// On Windows a PID is gone when no process object can be opened for it, or
// when the object that can still be opened (another handle keeps it) has an
// exit code other than STILL_ACTIVE.
func init() {
	processGoneOS = func(pid int) bool {
		const stillActive = 259
		h, err := syscall.OpenProcess(syscall.PROCESS_QUERY_INFORMATION, false, uint32(pid))
		if err != nil {
			return true
		}
		defer syscall.CloseHandle(h)
		var code uint32
		if err := syscall.GetExitCodeProcess(h, &code); err != nil {
			return false
		}
		return code != stillActive
	}
}

// W-2: the pump on Windows, with a real inherited pipe and file as stdin: Stop
// releases a Read blocked on a silent pipe (Close cancels the pending ReadFile
// on the parent's end; the helper is TerminateProcess'd), the end marker is
// io.EOF, a killed helper is ErrHelperVanished, a read error is *StdinError,
// and the shared file position is untouched before Start and exact after a
// kill.
func TestPumpStopJoinsBlockedStdinWindows(t *testing.T) {
	t.Run("stop releases blocked read", testStopReleasesBlockedRead)
	t.Run("end marker is EOF", testEndMarkerIsEOF)
	t.Run("killed helper is not EOF", testKilledHelperIsNotEOF)
	t.Run("stdin read error", testStdinReadErrorIsStdinError)
	t.Run("shared file position", testSharedOffset)
	t.Run("process object gone after Stop", func(t *testing.T) {
		r, _ := silentPipe(t)
		p, err := StartWith(testHelper(r))
		if err != nil {
			t.Fatal(err)
		}
		if processGone(p.Pid()) {
			t.Fatal("helper reported gone while running")
		}
		if err := p.Stop(); err != nil {
			t.Fatal(err)
		}
		if _, err := p.Read(make([]byte, 1)); !errors.Is(err, ErrStopped) {
			t.Fatalf("Read after Stop = %v, want ErrStopped", err)
		}
		if !processGone(p.Pid()) {
			t.Fatalf("helper %d still active after Stop", p.Pid())
		}
	})
}

// W-7: a parent terminated with TerminateProcess (no cleanup of any kind) does
// not leave its helper reading stdin: the inherited death-pipe handle breaks
// and the helper exits while stdin stays silent and open.
func TestPumpHelperExitsOnParentDeathWindows(t *testing.T) {
	testHelperExitsOnParentDeath(t)
}
