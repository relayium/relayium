//go:build windows && relayiumwedgehook

// A deliberately wedging sink, reachable ONLY under the `relayiumwedgehook`
// build tag.
//
// The shutdown bound is a promise about a sink that never returns — a write to a
// stalled volume — and that is not a state a test can induce from outside the
// process. Proving it therefore needs a build of the real executable, running
// the real serve loop, whose sink hangs on demand.
//
// It is a BUILD TAG and not a flag or an environment variable on purpose: the
// shipped binary is compiled without the tag, so this file is not merely
// disabled in production, it is not present. There is no runtime input that can
// reach it.
package main

import (
	"fmt"
	"os"

	"github.com/relayium/relayium/apps/windows/native/internal/nameguard"
	"github.com/relayium/relayium/apps/windows/native/internal/session"
	"github.com/relayium/relayium/apps/windows/native/internal/wedgemark"
)

type wedgeSink struct{}

func newSink() session.Sink { return wedgeSink{} }

func (wedgeSink) Open(string, *nameguard.Plan) error { return nil }
func (wedgeSink) BeginFile(int) error                { return nil }

// WriteChunk never returns, standing in for an uninterruptible write to a
// stalled volume.
//
// It announces itself on stderr FIRST. The test driving this needs to know that
// the serve loop is genuinely inside the wedged write before it sends cancel;
// it used to infer that from a 500ms sleep, which on a loaded runner could
// deliver the cancel while the loop was still dispatching and prove a different
// path entirely. os.Stderr is unbuffered, so the marker is observable by the
// parent the moment this returns from the write.
func (wedgeSink) WriteChunk(int, []byte) (int, error) {
	fmt.Fprintln(os.Stderr, wedgemark.Entered)
	select {}
}

func (wedgeSink) FinishFile(int) error              { return nil }
func (wedgeSink) PublishOne(int) error              { return nil }
func (wedgeSink) Cleanup() (session.Residue, error) { return session.Residue{}, nil }
