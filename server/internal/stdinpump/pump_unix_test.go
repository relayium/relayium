//go:build unix

package stdinpump

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// Neither this process nor the helper changes O_NONBLOCK, or any other status
// flag, of the stdin open file description, which is shared with the shell
// and whatever reads the same descriptor after relayium. The stdin *os.File
// is made with os.NewFile, the way os.Stdin is; the flags are read before,
// while the helper is relaying, and after Stop, for a blocking pipe, a pipe
// that was already non-blocking, and a regular file.
func TestPumpLeavesStdinFlagsUntouched(t *testing.T) {
	type source func(t *testing.T) (fd int, feed func(), want []byte)
	pipe := func(nonblock bool) source {
		return func(t *testing.T) (int, func(), []byte) {
			var p [2]int
			if err := syscall.Pipe(p[:]); err != nil {
				t.Fatal(err)
			}
			// Like every descriptor Go opens: the helper inherits the read
			// end only as the stdin it is given, and never the write end
			// (which would keep its read from ever reaching end of file).
			syscall.CloseOnExec(p[0])
			syscall.CloseOnExec(p[1])
			if nonblock {
				if err := unix.SetNonblock(p[0], true); err != nil {
					t.Fatal(err)
				}
			}
			data := bytes.Repeat([]byte("n"), 5000)
			return p[0], func() { _, _ = unix.Write(p[1], data); _ = unix.Close(p[1]) }, data
		}
	}
	file := func(t *testing.T) (int, func(), []byte) {
		data := bytes.Repeat([]byte("f"), 700000)
		name := filepath.Join(t.TempDir(), "in")
		if err := os.WriteFile(name, data, 0o600); err != nil {
			t.Fatal(err)
		}
		fd, err := unix.Open(name, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		return fd, func() {}, data
	}
	for _, c := range []struct {
		name string
		src  source
	}{{"blocking pipe", pipe(false)}, {"non-blocking pipe", pipe(true)}, {"regular file", file}} {
		t.Run(c.name, func(t *testing.T) {
			fd, feed, want := c.src(t)
			stdin := os.NewFile(uintptr(fd), "stdin")
			defer stdin.Close()
			flags := func() int {
				v, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
				if err != nil {
					t.Fatal(err)
				}
				return v
			}
			before := flags()
			p, err := StartWith(testHelper(stdin))
			if err != nil {
				t.Fatal(err)
			}
			feed()
			got := make([]byte, 1)
			if _, err := io.ReadFull(p, got); err != nil {
				t.Fatal(err)
			}
			during := flags() // the helper has read fd 0 at least once
			rest, err := io.ReadAll(p)
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Stop(); err != nil {
				t.Fatal(err)
			}
			after := flags()
			got = append(got, rest...)
			t.Logf("flags before=%#x during=%#x after=%#x (O_NONBLOCK=%#x); relayed %d bytes", before, during, after, unix.O_NONBLOCK, len(got))
			if during != before || after != before {
				t.Fatalf("stdin status flags changed: before=%#x during=%#x after=%#x", before, during, after)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("relayed %d bytes, want %d", len(got), len(want))
			}
		})
	}
}
