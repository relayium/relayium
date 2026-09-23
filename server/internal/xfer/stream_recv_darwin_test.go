//go:build darwin

package xfer

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// denyDelete makes the filesystem refuse to unlink path, with a real macOS
// ACL entry for the current user, and proves it with an unlink that must
// fail. The ACL is removed before the test's temporary directory is.
func denyDelete(t *testing.T, path string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("running as root: the ACL would not stop an unlink")
	}
	u, err := exec.Command("id", "-un").Output()
	if err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("chmod", "+a", strings.TrimSpace(string(u))+" deny delete", path).CombinedOutput(); err != nil {
		t.Fatalf("chmod +a: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("chmod", "-N", path).Run() })
	if err := os.Remove(path); err == nil {
		t.Fatal("the fault is not in place: unlink was allowed")
	}
}

func stagedName(t *testing.T, g *StageGuard) string {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stage == "" {
		t.Fatal("nothing staged")
	}
	return g.stage
}

func residualClause(stage string) string {
	return "the staging directory " + stage + " could not be removed ("
}

// Root F2: the filesystem refuses to remove the staged data. No path claims
// the staging was removed; each names the directory left behind, and the
// staged bytes are still there. An installed destination is kept.
func TestStreamRecvDeniedCleanupIsReported(t *testing.T) {
	t.Run("watchdog, sender silent", func(t *testing.T) {
		dir := t.TempDir()
		w := startWatchdogRecv(t, dir, StreamRecvOpts{Idle: 700 * time.Millisecond})
		w.accept()
		w.h.send(MsgStreamData, []byte("must retain a truthful cleanup status"))
		stage := stagedName(t, w.g)
		data := filepath.Join(dir, stage, "data")
		denyDelete(t, data)
		w.waitExit(t)
		w.h.done()
		if _, err := os.Stat(data); err != nil {
			t.Fatalf("the staged file is gone after all: %v", err)
		}
		got := w.diag.String()
		t.Logf("diagnostic %q", got)
		prefix := "relayium: no data from the sender within the idle limit; nothing was installed, but " + residualClause(stage)
		if !strings.HasPrefix(got, prefix) || !strings.HasSuffix(got, "); remove it by hand\n") || strings.Contains(got, "was removed") {
			t.Fatalf("diagnostic %q, want %q...); remove it by hand", got, prefix)
		}
		if out := w.g.Abandon(); out.Installed || out.Residual != stage || out.Err == nil {
			t.Fatalf("guard outcome %+v", out)
		}
		if _, err := os.Stat(filepath.Join(dir, "out.bin")); err == nil {
			t.Fatal("something was installed")
		}
	})

	t.Run("refusal after a failed verification", func(t *testing.T) {
		dir := t.TempDir()
		g := NewStageGuard()
		h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{Guard: g})
		body := []byte("bytes that will not verify")
		h.send(MsgStreamData, body)
		stage := stagedName(t, g)
		denyDelete(t, filepath.Join(dir, stage, "data"))
		e := endFor(body)
		e.Size++
		go h.send(MsgStreamEnd, e)
		var we WireError
		if err := json.Unmarshal(h.expect(MsgError), &we); err != nil || we.Code != ErrCodeProtocol {
			t.Fatalf("refusal %+v %v", we, err)
		}
		h.c.Close()
		r := h.done()
		t.Logf("refusal %q; local %v", we.Msg, r.err)
		want := "; nothing was installed; " + residualClause(stage)
		if !strings.Contains(we.Msg, want) || !strings.HasSuffix(we.Msg, "); remove it by hand") {
			t.Fatalf("refusal message %q, want it to contain %q", we.Msg, want)
		}
		if r.err == nil || r.err.Error() != we.Msg || r.rep.Installed {
			t.Fatalf("local %+v %v, want the refusal's text", r.rep, r.err)
		}
		if _, err := os.Stat(filepath.Join(dir, "out.bin")); err == nil {
			t.Fatal("something was installed")
		}
	})

	t.Run("installed, staging left, confirmation sent", func(t *testing.T) {
		dir := t.TempDir()
		g := NewStageGuard()
		h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{Guard: g})
		body := []byte("installed although the staging stays")
		h.send(MsgStreamData, body)
		stage := stagedName(t, g)
		denyDelete(t, filepath.Join(dir, stage, "data"))
		e := endFor(body)
		go h.send(MsgStreamEnd, e)
		var res StreamResult
		if err := json.Unmarshal(h.expect(MsgStreamResult), &res); err != nil || res.Challenge != e.Challenge {
			t.Fatalf("result %+v %v", res, err)
		}
		r := h.done()
		if r.err != nil || !r.rep.Installed || len(r.rep.Notes) != 1 ||
			!strings.HasPrefix(r.rep.Notes[0], "out.bin was installed, but "+residualClause(stage)) {
			t.Fatalf("receiver %+v %v", r.rep, r.err)
		}
		if b, err := os.ReadFile(filepath.Join(dir, "out.bin")); err != nil || !bytes.Equal(b, body) {
			t.Fatalf("destination %q %v", b, err)
		}
	})

	t.Run("installed, staging left, confirmation blocked", func(t *testing.T) {
		dir := t.TempDir()
		w := startWatchdogRecv(t, dir, StreamRecvOpts{Idle: 5 * time.Second, WriteTimeout: 100 * time.Millisecond})
		w.accept()
		body := []byte("installed; staging stays; nobody reads the result")
		w.h.send(MsgStreamData, body)
		stage := stagedName(t, w.g)
		denyDelete(t, filepath.Join(dir, stage, "data"))
		w.h.send(MsgStreamEnd, endFor(body))
		w.waitExit(t)
		w.h.done()
		if b, err := os.ReadFile(filepath.Join(dir, "out.bin")); err != nil || !bytes.Equal(b, body) {
			t.Fatalf("destination %q %v", b, err)
		}
		got := w.diag.String()
		t.Logf("diagnostic %q", got)
		prefix := "relayium: the sender stopped reading; out.bin was installed with the verified bytes and is kept; the sender may not have received the confirmation; " + residualClause(stage)
		if !strings.HasPrefix(got, prefix) || !strings.HasSuffix(got, "); remove it by hand\n") {
			t.Fatalf("diagnostic %q, want %q...", got, prefix)
		}
	})
}
