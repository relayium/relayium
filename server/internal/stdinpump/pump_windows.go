//go:build windows

package stdinpump

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// passDeathPipe hands the helper the read end of the parent-death pipe as an
// inherited handle whose value travels in argv. os/exec does not support
// ExtraFiles on Windows; os.Pipe handles are created inheritable, and Go's
// Windows process creation passes an explicit handle list
// (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), so the helper inherits exactly this
// handle and its standard handles, and no other child inherits the write end.
func passDeathPipe(cmd *exec.Cmd, deathR *os.File) {
	h := syscall.Handle(deathR.Fd())
	cmd.SysProcAttr = &syscall.SysProcAttr{AdditionalInheritedHandles: []syscall.Handle{h}}
	cmd.Args = append(cmd.Args, DeathFlag, strconv.FormatUint(uint64(h), 10))
}
