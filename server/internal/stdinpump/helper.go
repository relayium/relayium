package stdinpump

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"syscall"
)

// RunHelper is the body of `__pump-stdin`. args are the arguments after the
// subcommand; the only accepted form is `--death-fd N`. It returns the process
// exit code; the caller exits with it.
//
// It reads fd 0 in reads of at most HelperChunk bytes and writes each read to
// fd 1 as one frame; at end of file it writes the end marker and returns 0, on
// a read error an error frame and returns 1. It never touches the filesystem
// or the network, and it takes no signal as a reason to stop: an interrupt sent
// to the whole terminal's process group reaches it too, and it must not end a
// transfer as if the input had ended. Its parent ends it, by the exact PID.
func RunHelper(args []string) int {
	return runHelper(args, os.Stdin, os.Stdout, os.Stderr)
}

func runHelper(args []string, in io.Reader, out, errOut io.Writer) int {
	if len(args) != 2 || args[0] != DeathFlag {
		fmt.Fprintf(errOut, "usage: %s %s N (internal; started by relayium itself)\n", HelperArg, DeathFlag)
		return exitUsage
	}
	n, err := strconv.ParseUint(args[1], 10, 64)
	if err != nil {
		fmt.Fprintf(errOut, "%s: invalid %s value\n", HelperArg, DeathFlag)
		return exitUsage
	}
	death := os.NewFile(uintptr(n), "parent-death")
	if death == nil {
		fmt.Fprintf(errOut, "%s: invalid %s value\n", HelperArg, DeathFlag)
		return exitUsage
	}

	// Notify, not Ignore: on Windows an ignored console interrupt falls through
	// to the default handler, which ends the process. Delivered signals are
	// dropped. SIGPIPE is included so that a write to a closed fd 1 returns
	// EPIPE here (exit 3) instead of killing the process silently.
	sigs := make(chan os.Signal, 8)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGPIPE)
	go func() {
		for range sigs {
		}
	}()

	// The parent holds the only write end. This read returns only when that
	// end is closed — by Stop, or by the parent's death however it died — or
	// when the value was not a readable pipe at all. Every case means no one
	// is left to relay stdin to, so exit, even while the main loop is blocked
	// in a read of fd 0.
	go func() {
		var b [1]byte
		_, _ = death.Read(b[:])
		os.Exit(exitParentDeath)
	}()

	return pumpLoop(in, out)
}

// pumpLoop is the relay: fd 0 in, frames out.
func pumpLoop(in io.Reader, out io.Writer) int {
	buf := make([]byte, 4+HelperChunk)
	for {
		n, err := in.Read(buf[4:])
		if n > 0 {
			binary.BigEndian.PutUint32(buf[:4], uint32(n))
			if _, werr := out.Write(buf[:4+n]); werr != nil {
				return exitOutputGone
			}
		}
		if errors.Is(err, io.EOF) {
			var end [4]byte // frameEnd
			if _, werr := out.Write(end[:]); werr != nil {
				return exitOutputGone
			}
			return exitEOF
		}
		if err != nil {
			msg := []byte(err.Error())
			if len(msg) > maxErrMsgBytes {
				msg = msg[:maxErrMsgBytes]
			}
			frame := make([]byte, 8+len(msg))
			binary.BigEndian.PutUint32(frame[:4], frameErr)
			binary.BigEndian.PutUint32(frame[4:8], uint32(len(msg)))
			copy(frame[8:], msg)
			if _, werr := out.Write(frame); werr != nil {
				return exitOutputGone
			}
			return exitStdinError
		}
	}
}
