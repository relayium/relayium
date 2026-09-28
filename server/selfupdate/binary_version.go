package selfupdate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// binaryVersionTimeout bounds how long the freshly extracted binary may take
// to answer `version`. A real build answers in milliseconds; anything that
// hangs is not something to install.
const binaryVersionTimeout = 15 * time.Second

// binaryVersionOutputLimit caps what is read from the probe. The CLI prints
// one short line; a binary that floods stdout is refused, not buffered.
const binaryVersionOutputLimit = 256

// verifyBinaryVersionHook is what Update calls. It is a var only so the legacy
// download/replace tests, whose "binaries" are plain text, can run without an
// executable payload (see TestMain); production never reassigns it.
var verifyBinaryVersionHook = runBinaryVersionCheck

func verifyBinaryVersion(ctx context.Context, path, tag string) error {
	return verifyBinaryVersionHook(ctx, path, tag)
}

// runBinaryVersionCheck runs `<path> version` and requires the printed version
// to be the tag being installed. `relayium version` has printed exactly
// main.version (goreleaser's {{ .Version }}, the tag without its "v") on one
// line since v0.1.0, so every release this updater may install answers it.
//
// This is what binds the installed bytes to the tag: the signature covers
// checksums.txt, and neither it nor the asset names carry a version, so an old
// but validly signed archive re-served under a newer tag would otherwise pass
// the version floor and the downgrade check, which only ever see the tag.
func runBinaryVersionCheck(ctx context.Context, path, tag string) error {
	ctx, cancel := context.WithTimeout(ctx, binaryVersionTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	out := &cappedBuffer{limit: binaryVersionOutputLimit}
	cmd.Stdout = out
	cmd.Stderr = nil // discarded
	cmd.Stdin = nil  // /dev/null
	cmd.WaitDelay = time.Second
	runErr := cmd.Run()
	if out.overflow {
		return fmt.Errorf("%w: the downloaded binary printed more than %d bytes for `version` — refusing to install %s",
			ErrVerify, binaryVersionOutputLimit, tag)
	}
	if runErr != nil {
		if ctx.Err() != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("%w: the downloaded binary did not answer `version` within %s — refusing to install %s",
				ErrVerify, binaryVersionTimeout, tag)
		}
		return fmt.Errorf("%w: could not run the downloaded binary's `version` command (%v) — refusing to install %s",
			ErrVerify, runErr, tag)
	}
	got := strings.TrimSpace(out.String())
	if i := strings.IndexByte(got, '\n'); i >= 0 {
		got = strings.TrimSpace(got[:i])
	}
	if got == "" || !SameVersion(got, tag) {
		return fmt.Errorf("%w: release %s contains a binary that reports version %q — refusing to install "+
			"(an older build served under a newer tag); the current binary is untouched", ErrVerify, tag, got)
	}
	return nil
}

// cappedBuffer keeps at most limit bytes and records whether more arrived. It
// reports every write as fully consumed so the child is never blocked on a
// full pipe; the overflow flag is what refuses the result.
type cappedBuffer struct {
	bytes.Buffer
	limit    int
	overflow bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	room := c.limit - c.Len()
	if len(p) > room {
		c.overflow = true
		if room > 0 {
			c.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return c.Buffer.Write(p)
}
