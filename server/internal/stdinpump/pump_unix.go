//go:build !windows

package stdinpump

import (
	"os"
	"os/exec"
	"strconv"
)

// passDeathPipe hands the helper the read end of the parent-death pipe as fd 3
// (the first ExtraFiles entry). os.Pipe descriptors are close-on-exec, so no
// other child this process starts inherits either end; the write end stays
// here alone.
func passDeathPipe(cmd *exec.Cmd, deathR *os.File) {
	cmd.ExtraFiles = []*os.File{deathR}
	cmd.Args = append(cmd.Args, DeathFlag, strconv.Itoa(3))
}
