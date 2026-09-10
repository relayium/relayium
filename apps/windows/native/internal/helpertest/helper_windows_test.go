//go:build windows

// End-to-end tests against the REAL child executable.
//
// The serve package proves its shutdown ownership in-process against an
// in-memory sink. That is not the same as proving the shipped EXE cleans up when
// its parent closes the pipe or kills it outright, which is what the host
// actually depends on — so these build the helper and drive it as a child
// process over real pipes.
package helpertest

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/apps/windows/native/internal/serve"
	"github.com/relayium/relayium/apps/windows/native/internal/staging"
	"github.com/relayium/relayium/apps/windows/native/internal/wedgemark"
	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

// stderrObserver collects the child's stderr and signals when a watched marker
// arrives.
//
// The mutex is not decoration. os/exec copies a non-*os.File stderr on its own
// goroutine, so every String() from a test goroutine while the child is still
// running races that copier. The previous plain bytes.Buffer had exactly that
// race in each timeout path.
type stderrObserver struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	want  string
	seen  chan struct{}
	fired bool
}

func newStderrObserver(want string) *stderrObserver {
	return &stderrObserver{want: want, seen: make(chan struct{})}
}

func (o *stderrObserver) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	n, err := o.buf.Write(p)
	// Matched against the whole accumulated buffer, not this write, because a
	// marker may be split across two copies.
	if !o.fired && o.want != "" && strings.Contains(o.buf.String(), o.want) {
		o.fired = true
		close(o.seen)
	}
	return n, err
}

func (o *stderrObserver) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buf.String()
}

// await blocks until the marker is observed. The timeout is a BOUND on a
// failing test, never evidence that the state was reached.
func (o *stderrObserver) await(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case <-o.seen:
	case <-time.After(within):
		t.Fatalf("never observed %q on the helper's stderr within %s (stderr: %s)", o.want, within, o.String())
	}
}

// buildHelper compiles the shipped command for this host.
func buildHelper(t *testing.T) string { return buildHelperTagged(t, "") }

// buildHelperTagged builds the command, optionally with a test-only build tag.
func buildHelperTagged(t *testing.T, tags string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "relayium-io-helper.exe")
	args := []string{"build", "-o", out}
	if tags != "" {
		args = append(args, "-tags", tags)
	}
	args = append(args, "github.com/relayium/relayium/apps/windows/native/cmd/relayium-io-helper")
	cmd := exec.Command("go", args...)
	cmd.Dir = moduleRoot(t)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the helper failed: %v\n%s", err, output)
	}
	return out
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// internal/helpertest -> module root
	return filepath.Dir(filepath.Dir(wd))
}

type child struct {
	cmd     *exec.Cmd
	stdin   *os.File
	stdout  *os.File
	stderr  *stderrObserver
	frames  chan wire.Frame
	readErr chan error
}

func startHelper(t *testing.T, path string) *child {
	t.Helper()
	return startHelperWatching(t, path, "")
}

// startHelperWatching starts the helper and watches its stderr for a marker, so
// a test can wait for an observable state instead of sleeping for one.
func startHelperWatching(t *testing.T, path, marker string) *child {
	t.Helper()
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	c := &child{cmd: exec.Command(path), stderr: newStderrObserver(marker)}
	c.cmd.Stdin = inR
	c.cmd.Stdout = outW
	c.cmd.Stderr = c.stderr
	if err := c.cmd.Start(); err != nil {
		t.Fatalf("starting the helper: %v", err)
	}
	inR.Close()
	outW.Close()
	c.stdin, c.stdout = inW, outR

	// Frames are decoded on a goroutine rather than with a read deadline:
	// os.Pipe handles on Windows are not reliably pollable, so SetReadDeadline
	// can fail and would make these tests report a transport limitation as a
	// helper defect.
	c.frames = make(chan wire.Frame, 64)
	c.readErr = make(chan error, 1)
	go func() {
		r := wire.NewReader(c.stdout)
		for {
			frame, err := r.ReadFrame()
			if err != nil {
				c.readErr <- err
				close(c.frames)
				return
			}
			owned := wire.Frame{Kind: frame.Kind, Payload: append([]byte(nil), frame.Payload...)}
			c.frames <- owned
		}
	}()

	t.Cleanup(func() {
		c.stdin.Close()
		c.stdout.Close()
		if c.cmd.Process != nil {
			c.cmd.Process.Kill()
		}
	})
	return c
}

func (c *child) send(t *testing.T, buf []byte) {
	t.Helper()
	if _, err := c.stdin.Write(buf); err != nil {
		t.Fatalf("writing to the helper: %v", err)
	}
}

func (c *child) request(t *testing.T, req wire.Request) {
	t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := wire.EncodeFrame(wire.KindRequest, raw)
	if err != nil {
		t.Fatal(err)
	}
	c.send(t, frame)
}

// awaitFrame returns the next frame or fails the test.
func (c *child) awaitFrame(t *testing.T) wire.Frame {
	t.Helper()
	select {
	case frame, ok := <-c.frames:
		if !ok {
			t.Fatalf("the helper closed stdout: %v (stderr: %s)", <-c.readErr, c.stderr.String())
		}
		return frame
	case <-time.After(20 * time.Second):
		t.Fatalf("timed out waiting for a frame (stderr: %s)", c.stderr.String())
		return wire.Frame{}
	}
}

// awaitResponse reads until a response with the given id, or fails.
func (c *child) awaitResponse(t *testing.T, id uint64) wire.Response {
	t.Helper()
	for {
		frame := c.awaitFrame(t)
		if frame.Kind != wire.KindResponse {
			continue
		}
		var resp wire.Response
		if err := json.Unmarshal(frame.Payload, &resp); err != nil {
			t.Fatalf("unparseable response: %v", err)
		}
		if resp.ID == id {
			return resp
		}
	}
}

func stagingDirs(t *testing.T, root string) []string {
	t.Helper()
	items, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read root: %v", err)
	}
	var out []string
	for _, item := range items {
		if item.IsDir() && staging.IsOwnedName(item.Name()) {
			out = append(out, item.Name())
		}
	}
	return out
}

// The helper must announce itself, so a launch or architecture mismatch settles
// the caller instead of hanging.
func TestHelperAnnouncesReady(t *testing.T) {
	c := startHelper(t, buildHelper(t))
	frame := c.awaitFrame(t)
	if frame.Kind != wire.KindEvent {
		t.Fatalf("first frame kind %d, want an event", frame.Kind)
	}
	var ev wire.Event
	if err := json.Unmarshal(frame.Payload, &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Event != "ready" || ev.Protocol != wire.ProtocolVersion {
		t.Fatalf("unexpected ready event: %+v", ev)
	}
}

// Parent closes the pipe mid-transfer. The child must exit and remove the
// unfinished file it owns.
func TestParentEOFCleansUnfinishedOwnedFiles(t *testing.T) {
	helper := buildHelper(t)
	root := t.TempDir()
	c := startHelper(t, helper)

	c.request(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: root,
		Manifest: []wire.ManifestEntry{{Name: "big.bin", Size: 1 << 20}}})
	if resp := c.awaitResponse(t, 1); !resp.OK {
		t.Fatalf("open failed: %+v", resp)
	}
	index := 0
	c.request(t, wire.Request{ID: 2, Op: wire.OpBegin, Index: &index})
	if resp := c.awaitResponse(t, 2); !resp.OK {
		t.Fatalf("begin failed: %+v", resp)
	}
	chunk, err := wire.EncodeChunk(wire.ChunkHeader{ID: 3, Index: 0}, make([]byte, 4096))
	if err != nil {
		t.Fatal(err)
	}
	c.send(t, chunk)
	if resp := c.awaitResponse(t, 3); !resp.OK {
		t.Fatalf("chunk failed: %+v", resp)
	}
	if dirs := stagingDirs(t, root); len(dirs) != 1 {
		t.Fatalf("expected staging mid-transfer, got %v", dirs)
	}

	// The parent goes away.
	c.stdin.Close()

	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatalf("the helper did not exit on pipe EOF (stderr: %s)", c.stderr.String())
	}

	if dirs := stagingDirs(t, root); len(dirs) != 0 {
		t.Fatalf("pipe EOF left staging residue: %v (stderr: %s)", dirs, c.stderr.String())
	}
	if _, err := os.Stat(filepath.Join(root, "big.bin")); err == nil {
		t.Fatal("an incomplete transfer was published")
	}
}

// A hard kill is NOT claimed to be clean. This pins the bounded residue that is
// documented instead, so the documentation and the behaviour cannot drift apart:
// residue is confined to one staging directory and never appears at a
// destination pathname.
func TestHardKillResidueIsBoundedAndNeverAtDestination(t *testing.T) {
	helper := buildHelper(t)
	root := t.TempDir()
	c := startHelper(t, helper)

	c.request(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: root,
		Manifest: []wire.ManifestEntry{{Name: "target.bin", Size: 1 << 20}}})
	if resp := c.awaitResponse(t, 1); !resp.OK {
		t.Fatalf("open failed: %+v", resp)
	}
	index := 0
	c.request(t, wire.Request{ID: 2, Op: wire.OpBegin, Index: &index})
	if resp := c.awaitResponse(t, 2); !resp.OK {
		t.Fatalf("begin failed: %+v", resp)
	}
	chunk, err := wire.EncodeChunk(wire.ChunkHeader{ID: 3, Index: 0}, make([]byte, 4096))
	if err != nil {
		t.Fatal(err)
	}
	c.send(t, chunk)
	if resp := c.awaitResponse(t, 3); !resp.OK {
		t.Fatalf("chunk failed: %+v", resp)
	}

	if err := c.cmd.Process.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	c.cmd.Wait()

	// The destination name must be untouched. This is the part that matters.
	if _, err := os.Stat(filepath.Join(root, "target.bin")); err == nil {
		t.Fatal("a killed helper left a file at the destination pathname")
	}
	dirs := stagingDirs(t, root)
	if len(dirs) > 1 {
		t.Fatalf("residue is not bounded to a single staging directory: %v", dirs)
	}
	if len(dirs) == 1 {
		t.Logf("hard-kill residue as documented: %s (this is expected and is not a clean-exit claim)", dirs[0])
	}
}

// A malformed frame must produce a bounded failure and a non-zero exit, not a
// hang and not a partial write.
func TestMalformedFrameTerminatesWithNonZeroExit(t *testing.T) {
	c := startHelper(t, buildHelper(t))
	// A length prefix far beyond the ceiling.
	c.send(t, []byte{0xFF, 0xFF, 0xFF, 0xFF, wire.KindRequest})
	c.stdin.Close()

	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a malformed frame produced a clean exit")
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("the helper hung on a malformed frame (stderr: %s)", c.stderr.String())
	}
}

// Arguments are refused: nothing identifying may travel in argv.
func TestHelperRefusesArguments(t *testing.T) {
	cmd := exec.Command(buildHelper(t), "--root", `C:\somewhere`)
	err := cmd.Run()
	if err == nil {
		t.Fatal("the helper accepted command-line arguments")
	}
}

// Diagnostics must never carry user content.
func TestStderrCarriesNoPathsOrFilenames(t *testing.T) {
	helper := buildHelper(t)
	root := t.TempDir()
	c := startHelper(t, helper)

	secret := "SECRET-FILENAME-9f3a.bin"
	c.request(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: root,
		Manifest: []wire.ManifestEntry{{Name: "../" + secret, Size: 1}}})
	resp := c.awaitResponse(t, 1)
	if resp.OK {
		t.Fatal("a traversal manifest was accepted")
	}
	c.stdin.Close()
	c.cmd.Wait()

	log := c.stderr.String()
	if strings.Contains(log, secret) {
		t.Fatalf("stderr leaked a filename: %q", log)
	}
	if strings.Contains(log, root) {
		t.Fatalf("stderr leaked the destination root: %q", log)
	}
}

// The shutdown bound, proven against the REAL executable.
//
// This is the test that was missing. The in-process tests inject a ForceExit
// observer, which proves the monitor fires but says nothing about whether the
// shipped binary wires one — and for a while it did not, so the promise that the
// helper "will not hang forever" was true only of the test harness.
//
// A sink that never returns cannot be induced from outside the process, so this
// builds the real command with the `relayiumwedgehook` tag. That tag is absent
// from every shipping build, so the wedging sink is not merely disabled in
// production, it is not compiled in at all.
func TestRealExecutableEnforcesShutdownBound(t *testing.T) {
	helper := buildHelperTagged(t, "relayiumwedgehook")
	root := t.TempDir()
	c := startHelperWatching(t, helper, wedgemark.Entered)

	c.request(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: root,
		Manifest: []wire.ManifestEntry{{Name: "wedged.bin", Size: 1 << 20}}})
	if resp := c.awaitResponse(t, 1); !resp.OK {
		t.Fatalf("open failed: %+v", resp)
	}
	index := 0
	c.request(t, wire.Request{ID: 2, Op: wire.OpBegin, Index: &index})
	if resp := c.awaitResponse(t, 2); !resp.OK {
		t.Fatalf("begin failed: %+v", resp)
	}

	// This chunk enters the sink and never comes back out.
	chunk, err := wire.EncodeChunk(wire.ChunkHeader{ID: 3, Index: 0}, make([]byte, 4096))
	if err != nil {
		t.Fatal(err)
	}
	c.send(t, chunk)

	// Wait for the sink to ANNOUNCE that it is inside the wedged write.
	//
	// This used to be time.Sleep(500ms) and an assumption. On a loaded runner
	// the cancel could arrive while the loop was still dispatching the chunk, in
	// which case the helper settles through the ordinary cancel path and exits
	// non-zero for a reason that has nothing to do with the shutdown bound — a
	// green result certifying an invariant it never exercised. Blocking on an
	// observable marker means the cancel is provably delivered to a loop that
	// cannot answer it.
	c.stderr.await(t, 20*time.Second)
	c.request(t, wire.Request{ID: 4, Op: wire.OpCancel})

	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()

	// The main loop cannot settle, so only the monitor can end this. Allowed
	// generously beyond serve.ShutdownGrace so a slow runner is not mistaken for
	// a missing bound.
	select {
	case err := <-done:
		exit, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatalf("the wedged helper exited cleanly (%v); the shutdown bound did not fire", err)
		}
		if exit.ExitCode() != serve.ExitShutdownTimeout {
			t.Fatalf("wedged helper exit %d, want %d (serve.ExitShutdownTimeout)", exit.ExitCode(), serve.ExitShutdownTimeout)
		}
	case <-time.After(serve.ShutdownGrace + 20*time.Second):
		t.Fatalf("the real executable hung on a wedged sink: no shutdown bound is wired (stderr: %s)", c.stderr.String())
	}

	// The destination is untouched: a forced exit still never publishes.
	if _, err := os.Stat(filepath.Join(root, "wedged.bin")); err == nil {
		t.Fatal("a force-exited helper left a file at the destination pathname")
	}
}

// The wedging sink must not exist in a shipping build. If the default build ever
// picks it up, this hangs rather than passing, which is the correct failure.
func TestShippedBuildHasNoWedgeHook(t *testing.T) {
	helper := buildHelper(t) // no tags
	root := t.TempDir()
	c := startHelper(t, helper)

	c.request(t, wire.Request{ID: 1, Op: wire.OpOpen, Root: root,
		Manifest: []wire.ManifestEntry{{Name: "ordinary.bin", Size: 4}}})
	if resp := c.awaitResponse(t, 1); !resp.OK {
		t.Fatalf("open failed: %+v", resp)
	}
	index := 0
	c.request(t, wire.Request{ID: 2, Op: wire.OpBegin, Index: &index})
	if resp := c.awaitResponse(t, 2); !resp.OK {
		t.Fatalf("begin failed: %+v", resp)
	}
	chunk, err := wire.EncodeChunk(wire.ChunkHeader{ID: 3, Index: 0}, []byte("data"))
	if err != nil {
		t.Fatal(err)
	}
	c.send(t, chunk)
	// A real sink answers; the wedging one never would.
	if resp := c.awaitResponse(t, 3); !resp.OK {
		t.Fatalf("chunk failed against the shipped build: %+v", resp)
	}
}
