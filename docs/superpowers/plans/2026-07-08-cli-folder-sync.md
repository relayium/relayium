# `relayium sync` — Incremental Folder Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `relayium sync` — a one-way incremental folder mirror over the existing SSH and daemon-direct transports: skip unchanged files (size+mtime), `--delete` to mirror, `--watch` for real-time re-sync.

**Architecture:** Additive protocol change (`Hello.Sync`/`Hello.Delete`, `ResumeState.Skip[]`; WireVersion unchanged). The `xfer` engine gains a sync mode; a new `sync` command reuses `push`'s transport wiring and runs `xfer.Send` with sync options. `--watch` wraps it in an fsnotify debounce loop.

**Tech Stack:** Go 1.26.3, existing `internal/xfer` engine + `internal/sshx` + the `relayium://` dialer, `github.com/fsnotify/fsnotify` (new).

## Global Constraints

- Protocol is **additive**: do NOT bump `WireVersion` (stays 1). New JSON fields on `Hello` and `ResumeState` only. push/pull and cross-version peers must keep working; new↔old degrades to a full transfer.
- Skip test is **size + mtime (unix seconds)**: `onDisk.Size()==entry.Size && onDisk.ModTime().Unix()==entry.ModTime`. Only sync mode preserves mtime on the receiver (`os.Chtimes`); push/pull is unchanged.
- `--delete` on the **daemon** side is honored only when `serve --allow-delete` is set; over SSH the remote `__recv` always allows it (the user owns the remote). Deletes are scoped under the destination dir via the existing `safeJoin`.
- `sync` requires the **native protocol** (relayium on the remote); it never uses the tar fallback. Over SSH, error clearly if the remote has no relayium.
- Go module rooted at `server/`; all commands run from `server/`. Model policy: no haiku.
- TDD, DRY, YAGNI, frequent commits.

---

### Task 1: Additive protocol fields

**Files:**
- Modify: `server/internal/xfer/wire.go`

**Interfaces:**
- Produces: `Hello.Sync bool`, `Hello.Delete bool`; `ResumeState.Skip []int`. All later tasks use them.

- [ ] **Step 1: Add the fields**

In `server/internal/xfer/wire.go`, extend the two structs (leave everything else, including `WireVersion = 1`, unchanged):

```go
type Hello struct {
	Version int
	Mode    string // "push" or "pull"
	Sync    bool   // sync mode: receiver may skip unchanged files and preserve mtime
	Delete  bool   // mirror: receiver may delete files not in the manifest (if permitted)
}
```

```go
type ResumeState struct {
	Entries []ResumeEntry
	Skip    []int // sync mode: manifest indices already present & identical (not sent)
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd server && go build ./internal/xfer/`
Expected: builds clean (fields are additive; JSON marshalling of the new fields is automatic).

- [ ] **Step 3: Commit**

```bash
git add server/internal/xfer/wire.go
git commit -m "feat(xfer): additive Hello.Sync/Delete + ResumeState.Skip (protocol unchanged otherwise)"
```

---

### Task 2: Receiver sync-mode (skip by size+mtime, preserve mtime)

**Files:**
- Modify: `server/internal/xfer/recv.go`
- Test: `server/internal/xfer/sync_test.go`

**Interfaces:**
- Consumes: `Hello.Sync`, `ResumeState.Skip` (Task 1).
- Produces: `RecvOpts.AllowDelete bool` field (used in Task 5; add it now so the struct is stable); `syncStateFor(destDir, m) ResumeState`; sync-aware `Receive`.

- [ ] **Step 1: Write the failing test**

Create `server/internal/xfer/sync_test.go`:

```go
package xfer

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFileMtime(t *testing.T, path, body string, mtime int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	tm := time.Unix(mtime, 0)
	if err := os.Chtimes(path, tm, tm); err != nil {
		t.Fatal(err)
	}
}

func TestSyncStateForSkipsUnchanged(t *testing.T) {
	dst := t.TempDir()
	// Manifest declares three files.
	m := Manifest{Files: []FileEntry{
		{Path: "a.txt", Size: 5, ModTime: 1000}, // identical on disk → skip
		{Path: "b.txt", Size: 9, ModTime: 2000}, // different content/size → send
		{Path: "c.txt", Size: 4, ModTime: 3000}, // absent on disk → send
	}}
	writeFileMtime(t, filepath.Join(dst, "a.txt"), "hello", 1000) // size 5, mtime 1000 → match
	writeFileMtime(t, filepath.Join(dst, "b.txt"), "old", 1500)   // size 3 != 9 → send

	rs := syncStateFor(dst, m)
	if len(rs.Skip) != 1 || rs.Skip[0] != 0 {
		t.Fatalf("Skip = %v, want [0] (a.txt unchanged)", rs.Skip)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run TestSyncStateForSkipsUnchanged`
Expected: FAIL (`syncStateFor` undefined).

- [ ] **Step 3: Implement syncStateFor + sync-aware Receive**

In `server/internal/xfer/recv.go`:

Add `AllowDelete` to `RecvOpts`:

```go
type RecvOpts struct {
	NoResume    bool
	AllowDelete bool // sync mode: honor a Hello.Delete mirror request
}
```

Add `syncStateFor` (skip unchanged by size+mtime, resume partials):

```go
// syncStateFor is resumeStateFor plus skip detection: a manifest file whose
// on-disk copy matches by size and modification time is skipped (not sent).
func syncStateFor(destDir string, m Manifest) ResumeState {
	var rs ResumeState
	for i, f := range m.Files {
		dest, err := safeJoin(destDir, f.Path)
		if err != nil {
			continue
		}
		info, err := os.Stat(dest)
		if err != nil {
			continue // absent → full send
		}
		if info.Size() == f.Size && info.ModTime().Unix() == f.ModTime {
			rs.Skip = append(rs.Skip, i)
			continue
		}
		if info.Size() > 0 && info.Size() < f.Size {
			rs.Entries = append(rs.Entries, ResumeEntry{Index: i, Have: info.Size()})
		}
	}
	return rs
}
```

Now make `Receive` sync-aware. Replace the body from the `rs := ResumeState{}` block through the receive loop. The full new `Receive` (delete handling is Task 5 — leave the marked hook):

```go
func Receive(rw io.ReadWriter, destDir string, opts RecvOpts) (Report, error) {
	var hello Hello
	if _, err := ReadJSON(rw, &hello); err != nil {
		return Report{}, err
	}
	if hello.Version != WireVersion {
		return Report{}, fmt.Errorf("unsupported wire version %d", hello.Version)
	}
	var m Manifest
	if _, err := ReadJSON(rw, &m); err != nil {
		return Report{}, err
	}

	rs := ResumeState{}
	if hello.Sync {
		rs = syncStateFor(destDir, m)
	} else if !opts.NoResume {
		rs = resumeStateFor(destDir, m)
	}
	if err := WriteJSON(rw, MsgResume, rs); err != nil {
		return Report{}, err
	}

	skip := make(map[int]bool, len(rs.Skip))
	for _, i := range rs.Skip {
		skip[i] = true
	}

	var rep Report
	var res Result
	res.OK = true
	expected := len(m.Files) - len(rs.Skip)
	for k := 0; k < expected; k++ {
		var fs FileStart
		if _, err := ReadJSON(rw, &fs); err != nil {
			return rep, err
		}
		f := m.Files[fs.Index]
		dest, err := safeJoin(destDir, f.Path)
		if err != nil {
			return rep, err
		}
		sum, werr := writeFileBody(rw, dest, f, fs.Offset)
		if werr == nil && hello.Sync {
			// Preserve the source mtime so a later sync can skip this file.
			tm := time.Unix(f.ModTime, 0)
			_ = os.Chtimes(dest, tm, tm)
		}

		var fh FileHash
		if _, err := ReadJSON(rw, &fh); err != nil {
			return rep, err
		}
		if werr != nil || fh.SHA256 != sum {
			res.OK = false
			res.Failed = append(res.Failed, f.Path)
		} else {
			rep.Files++
			rep.Bytes += f.Size
		}
	}

	// (Task 5 will insert --delete handling here, before the Result write.)

	rep.Failed = res.Failed
	return rep, WriteJSON(rw, MsgResult, res)
}
```

Add the `time` import to `recv.go` (`import ( ... "time" )`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/xfer/ -run TestSyncStateForSkipsUnchanged`
Expected: PASS.

- [ ] **Step 5: Verify existing xfer tests still pass (backward compat)**

Run: `cd server && go test ./internal/xfer/`
Expected: PASS (non-sync `Receive` path is unchanged: `expected == len(m.Files)`, no skips, no mtime change).

- [ ] **Step 6: Commit**

```bash
git add server/internal/xfer/recv.go server/internal/xfer/sync_test.go
git commit -m "feat(xfer): receiver sync mode — skip unchanged by size+mtime, preserve mtime"
```

---

### Task 3: Sender sync-mode (honor Skip) + round-trip test

**Files:**
- Modify: `server/internal/xfer/send.go`
- Test: `server/internal/xfer/sync_test.go`

**Interfaces:**
- Consumes: `ResumeState.Skip`, `Hello.Sync/Delete`.
- Produces: `SendOpts.Sync bool`, `SendOpts.Delete bool`; `Report.Skipped int`.

- [ ] **Step 1: Write the failing round-trip test**

Append to `server/internal/xfer/sync_test.go`:

```go
import (
	"net"
	"sync"
)

// (add "net" and "sync" to the existing import block)

func TestSyncRoundTripSkipsUnchanged(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	// Source: two files.
	writeFileMtime(t, filepath.Join(src, "d", "a.txt"), "hello", 1000)
	writeFileMtime(t, filepath.Join(src, "d", "b.txt"), "world!!", 2000)
	// Destination already has an identical a.txt (same size+mtime) → should be skipped.
	writeFileMtime(t, filepath.Join(dst, "d", "a.txt"), "hello", 1000)

	m, srcs, err := BuildManifest([]string{filepath.Join(src, "d")})
	if err != nil {
		t.Fatal(err)
	}

	c1, c2 := net.Pipe()
	var wg sync.WaitGroup
	wg.Add(1)
	var recvErr error
	var rep Report
	go func() {
		defer wg.Done()
		rep, recvErr = Receive(c2, dst, RecvOpts{})
		c2.Close()
	}()
	srep, serr := Send(c1, m, srcs, SendOpts{Sync: true})
	c1.Close()
	wg.Wait()
	if serr != nil || recvErr != nil {
		t.Fatalf("send=%v recv=%v", serr, recvErr)
	}
	// a.txt skipped, only b.txt sent.
	if srep.Skipped != 1 {
		t.Fatalf("Skipped = %d, want 1", srep.Skipped)
	}
	if rep.Files != 1 {
		t.Fatalf("received %d files, want 1 (only b.txt)", rep.Files)
	}
	got, _ := os.ReadFile(filepath.Join(dst, "d", "b.txt"))
	if string(got) != "world!!" {
		t.Fatalf("b.txt = %q", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run TestSyncRoundTrip`
Expected: FAIL (`SendOpts.Sync` / `Report.Skipped` undefined).

- [ ] **Step 3: Implement sender sync mode**

In `server/internal/xfer/send.go`:

Extend `SendOpts` and `Report`:

```go
type SendOpts struct {
	Progress func(path string, sent, total int64)
	Sync     bool // sync mode: set Hello.Sync and honor the receiver's Skip
	Delete   bool // mirror: set Hello.Delete
}
```

```go
type Report struct {
	Files   int
	Bytes   int64
	Skipped int // sync mode: files the receiver already had, not sent
	Failed  []string
}
```

In `Send`, set the Hello flags and honor `Skip`:

```go
func Send(rw io.ReadWriter, m Manifest, srcs []string, opts SendOpts) (Report, error) {
	if err := WriteJSON(rw, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: opts.Sync, Delete: opts.Delete}); err != nil {
		return Report{}, err
	}
	if err := WriteJSON(rw, MsgManifest, m); err != nil {
		return Report{}, err
	}

	var rs ResumeState
	if _, err := ReadJSON(rw, &rs); err != nil {
		return Report{}, err
	}
	offsets := make([]int64, len(m.Files))
	for _, e := range rs.Entries {
		if e.Index >= 0 && e.Index < len(offsets) {
			offsets[e.Index] = e.Have
		}
	}
	skip := make(map[int]bool, len(rs.Skip))
	for _, i := range rs.Skip {
		skip[i] = true
	}

	var rep Report
	for i, f := range m.Files {
		if skip[i] {
			rep.Skipped++
			continue
		}
		if err := sendFile(rw, i, f, srcs[i], offsets[i], opts); err != nil {
			return rep, err
		}
		rep.Files++
		rep.Bytes += f.Size
	}

	var res Result
	if _, err := ReadJSON(rw, &res); err != nil {
		return rep, err
	}
	rep.Failed = res.Failed
	return rep, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/xfer/ -run TestSyncRoundTrip`
Expected: PASS.

- [ ] **Step 5: Full xfer suite (backward compat)**

Run: `cd server && go test ./internal/xfer/`
Expected: PASS (non-sync Send sets `Sync:false`, receiver returns no Skip, behaves as before).

- [ ] **Step 6: Commit**

```bash
git add server/internal/xfer/send.go server/internal/xfer/sync_test.go
git commit -m "feat(xfer): sender sync mode — honor receiver Skip, report Skipped"
```

---

### Task 4: `relayium sync` command (incremental; daemon + SSH) — feature ①

**Files:**
- Create: `server/cmd/relayium/sync.go`
- Modify: `server/cmd/relayium/run.go` (dispatch + usage; `__recv` allows delete), `server/cmd/relayium/dialdaemon.go` (extract a reusable dialer)
- Test: `server/cmd/relayium/sync_e2e_test.go`

**Interfaces:**
- Consumes: `xfer.Send` with `SendOpts{Sync,Delete}`; the daemon dialer; `sshx`.
- Produces: `runSync`; `dialDaemon(target, configDir, stderr) (*tls.Conn, error)` extracted from `pushDaemon`.

- [ ] **Step 1: Extract a reusable daemon dialer**

In `server/cmd/relayium/dialdaemon.go`, refactor `pushDaemon` so the connection setup is a separate function both `push` and `sync` call. Add:

```go
// dialDaemon resolves a relayium:// target, loads this host's identity, dials,
// completes the pinned-TLS handshake (TOFU on first contact, pinned after), and
// returns the ready connection. It prints "learned …" on first contact and
// returns a fatal error on a fingerprint mismatch.
func dialDaemon(target, configDir string, stderr io.Writer) (*tls.Conn, error) {
	hostport, err := parseDaemonURL(target)
	if err != nil {
		return nil, err
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		return nil, err
	}
	id, err := secure.LoadOrCreateIdentity(cfgDir)
	if err != nil {
		return nil, err
	}
	pinned, found, err := trust.LookupHost(cfgDir, hostport)
	if err != nil {
		return nil, err
	}
	conn, err := net.DialTimeout("tcp", hostport, daemonDialTimeout)
	if err != nil {
		return nil, err
	}
	tconn, presented, err := secure.ClientAny(conn, id)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("TLS handshake with %s failed: %w", hostport, err)
	}
	if found {
		if presented != pinned {
			tconn.Close()
			return nil, fmt.Errorf("fingerprint mismatch for %s\n  expected %s\n  got      %s\n"+
				"If this is an intentional key rotation, remove the known_hosts line for %s and retry.",
				hostport, pinned, presented, hostport)
		}
	} else {
		if err := trust.AddHost(cfgDir, hostport, presented); err != nil {
			tconn.Close()
			return nil, err
		}
		fmt.Fprintf(stderr, "learned %s %s (added to known_hosts)\n", hostport, presented)
	}
	return tconn, nil
}
```

Then rewrite `pushDaemon`'s body to use it:

```go
func pushDaemon(target string, srcs []string, configDir string, noResume bool, stdout, stderr io.Writer) int {
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	tconn, err := dialDaemon(target, configDir, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer tconn.Close()
	rep, err := xfer.Send(tconn, m, paths, xfer.SendOpts{Progress: progressFn(stderr)})
	if err != nil {
		fmt.Fprintln(stderr, err)
		fmt.Fprintf(stderr, "hint: if the peer refused the connection, it may not have authorized this host.\n  run `relayium id` on this machine and add it on the peer.\n")
		return 1
	}
	return reportExit(rep, stderr)
}
```

Run: `cd server && go build ./cmd/relayium/ && go test ./cmd/relayium/ -run TestDaemon` — Expected: PASS (behaviour unchanged).

- [ ] **Step 2: Write the sync command**

Create `server/cmd/relayium/sync.go`:

```go
package main

import (
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

// runSync implements `relayium sync <src...> <dest> [--delete] [--watch]`: a
// one-way incremental mirror over the same transports as push. It always uses
// the native protocol (no tar fallback).
func runSync(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var identity, configDir string
	var port int
	var del, watch bool
	fs.StringVar(&identity, "i", "", "ssh identity file")
	fs.IntVar(&port, "p", 0, "ssh port")
	fs.BoolVar(&del, "delete", false, "delete files on the receiver that are gone from the source")
	fs.BoolVar(&watch, "watch", false, "keep running and re-sync on change")
	fs.StringVar(&configDir, "config-dir", "", "identity/trust directory (daemon)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) < 2 {
		fmt.Fprintln(stderr, "sync needs <src...> <dest>")
		return 2
	}
	dest := rest[len(rest)-1]
	srcs := rest[:len(rest)-1]

	once := func() int {
		return syncOnce(dest, srcs, syncFlags{identity: identity, port: port, del: del, configDir: configDir}, stdout, stderr)
	}
	if !watch {
		return once()
	}
	// Task 6 replaces this with the fsnotify watch loop.
	return once()
}

type syncFlags struct {
	identity  string
	port      int
	del       bool
	configDir string
}

// syncOnce runs a single incremental sync of srcs → dest.
func syncOnce(dest string, srcs []string, f syncFlags, stdout, stderr io.Writer) int {
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	opts := xfer.SendOpts{Sync: true, Delete: f.del, Progress: progressFn(stderr)}

	if strings.HasPrefix(dest, daemonScheme) {
		tconn, err := dialDaemon(dest, f.configDir, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		defer tconn.Close()
		rep, err := xfer.Send(tconn, m, paths, opts)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintf(stderr, "synced: %d sent, %d unchanged\n", rep.Files, rep.Skipped)
		return reportExit(rep, stderr)
	}

	// SSH transport: sync requires relayium on the remote (native protocol).
	ep, err := xfer.ParseEndpoint(dest)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !ep.IsRemote() {
		fmt.Fprintln(stderr, "sync destination must be remote (host:path or relayium://host)")
		return 2
	}
	sopts := sshx.Opts{IdentityFile: f.identity, Port: f.port}
	has, err := sshx.RemoteHasRelayium(ep, sopts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !has {
		fmt.Fprintln(stderr, "sync requires relayium installed on the remote (native protocol); install it there or use push")
		return 1
	}
	sess, err := sshx.Dial(ep, "relayium __recv -- "+sshx.ShellQuote(ep.Path), sopts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	rep, serr := xfer.Send(sess, m, paths, opts)
	cerr := sess.Close()
	if serr != nil {
		fmt.Fprintln(stderr, serr)
		return 1
	}
	if cerr != nil {
		fmt.Fprintln(stderr, cerr)
		return 1
	}
	fmt.Fprintf(stderr, "synced: %d sent, %d unchanged\n", rep.Files, rep.Skipped)
	return reportExit(rep, stderr)
}
```

- [ ] **Step 3: Dispatch + usage + `__recv` allows delete**

In `server/cmd/relayium/run.go`:

Add the dispatch case (next to `case "push"`):

```go
	case "sync":
		return runSync(args[1:], stdout, stderr)
```

Add to the `usage` string after the daemon push line:

```
  relayium sync <src...> <dest> [--delete] [--watch]   incremental one-way folder mirror
```

In `runRecv`, allow delete (the user owns the remote they SSH into) — change the `RecvOpts`:

```go
	rep, err := xfer.Receive(rw, fs.Arg(0), xfer.RecvOpts{NoResume: noResume, AllowDelete: true})
```

- [ ] **Step 4: Write the E2E test (incremental over in-process daemon)**

Create `server/cmd/relayium/sync_e2e_test.go`:

```go
package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/relayium/relayium/internal/secure"
)

func TestSyncIncrementalOverDaemon(t *testing.T) {
	pusherDir := t.TempDir()
	serverDir := t.TempDir()
	recvDir := t.TempDir()
	srcDir := t.TempDir()

	pusher, _ := secure.LoadOrCreateIdentity(pusherDir)
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil)

	// Two source files.
	os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("aaa"), 0o644)
	os.WriteFile(filepath.Join(srcDir, "b.txt"), []byte("bbb"), 0o644)

	// First sync: both files transfer.
	var o, e bytes.Buffer
	rc := Run([]string{"sync", "--config-dir", pusherDir, filepath.Join(srcDir, "a.txt"), filepath.Join(srcDir, "b.txt"), daemonTarget(port)}, &o, &e)
	if rc != 0 {
		t.Fatalf("first sync rc=%d: %s", rc, e.String())
	}
	waitCode(t, done)
	if b, _ := os.ReadFile(filepath.Join(recvDir, "a.txt")); string(b) != "aaa" {
		t.Fatalf("a.txt not synced: %q", b)
	}

	// Second sync (serve again): a.txt unchanged is skipped; change b.txt → only b transfers.
	os.WriteFile(filepath.Join(srcDir, "b.txt"), []byte("bbbCHANGED"), 0o644)
	port2, done2 := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil)
	var o2, e2 bytes.Buffer
	rc = Run([]string{"sync", "--config-dir", pusherDir, filepath.Join(srcDir, "a.txt"), filepath.Join(srcDir, "b.txt"), daemonTarget(port2)}, &o2, &e2)
	if rc != 0 {
		t.Fatalf("second sync rc=%d: %s", rc, e2.String())
	}
	waitCode(t, done2)
	if !bytes.Contains(e2.Bytes(), []byte("1 sent, 1 unchanged")) {
		t.Fatalf("expected 1 sent / 1 unchanged, got: %s", e2.String())
	}
	if b, _ := os.ReadFile(filepath.Join(recvDir, "b.txt")); string(b) != "bbbCHANGED" {
		t.Fatalf("b.txt not updated: %q", b)
	}
}
```

- [ ] **Step 5: Run tests**

Run: `cd server && go test ./cmd/relayium/ -run 'TestSync|TestDaemon'`
Expected: PASS.

- [ ] **Step 6: Real-binary smoke**

```bash
cd server && go build -o /tmp/relayium ./cmd/relayium
d=$(mktemp -d); mkdir -p $d/src $d/recv $d/scfg $d/pcfg
echo one > $d/src/a.txt; echo two > $d/src/b.txt
p=$(/tmp/relayium id --config-dir $d/pcfg); echo "$p" > $d/scfg/authorized_fingerprints
/tmp/relayium serve --once --config-dir $d/scfg --dir $d/recv --port 9171 </dev/null & sleep 0.6
/tmp/relayium sync --config-dir $d/pcfg $d/src/a.txt $d/src/b.txt relayium://127.0.0.1:9171
```
Expected: `synced: 2 sent, 0 unchanged`, files in `$d/recv`.

- [ ] **Step 7: Commit**

```bash
git add server/cmd/relayium/sync.go server/cmd/relayium/run.go server/cmd/relayium/dialdaemon.go server/cmd/relayium/sync_e2e_test.go
git commit -m "feat(cli): relayium sync — incremental one-way folder mirror (daemon + SSH)"
```

---

### Task 5: `--delete` mirror + `serve --allow-delete` — feature ②

**Files:**
- Modify: `server/internal/xfer/recv.go` (delete extras), `server/cmd/relayium/serve.go` (`--allow-delete` → `RecvOpts.AllowDelete`)
- Test: `server/internal/xfer/sync_test.go`, `server/cmd/relayium/sync_e2e_test.go`

**Interfaces:**
- Consumes: `Hello.Delete`, `RecvOpts.AllowDelete`.
- Produces: `deleteExtras(destDir string, m Manifest) (int, error)`; delete wired into `Receive`; serve `--allow-delete`.

- [ ] **Step 1: Write the failing test**

Append to `server/internal/xfer/sync_test.go`:

```go
func TestDeleteExtrasRemovesFilesNotInManifest(t *testing.T) {
	dst := t.TempDir()
	writeFileMtime(t, filepath.Join(dst, "keep.txt"), "k", 1000)
	writeFileMtime(t, filepath.Join(dst, "old", "gone.txt"), "g", 1000)
	m := Manifest{Files: []FileEntry{{Path: "keep.txt", Size: 1, ModTime: 1000}}}

	n, err := deleteExtras(dst, m)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("deleted %d, want 1", n)
	}
	if _, err := os.Stat(filepath.Join(dst, "keep.txt")); err != nil {
		t.Fatal("keep.txt must remain")
	}
	if _, err := os.Stat(filepath.Join(dst, "old", "gone.txt")); !os.IsNotExist(err) {
		t.Fatal("gone.txt must be deleted")
	}
	if _, err := os.Stat(filepath.Join(dst, "old")); !os.IsNotExist(err) {
		t.Fatal("emptied dir should be pruned")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run TestDeleteExtras`
Expected: FAIL (`deleteExtras` undefined).

- [ ] **Step 3: Implement deleteExtras + wire into Receive**

In `server/internal/xfer/recv.go`, add:

```go
// deleteExtras removes regular files under destDir whose relative path is not in
// the manifest, then prunes directories left empty. It stays within destDir
// (the same guarantee safeJoin gives the write path). Returns files removed.
func deleteExtras(destDir string, m Manifest) (int, error) {
	want := make(map[string]bool, len(m.Files))
	for _, f := range m.Files {
		want[filepath.Clean(filepath.FromSlash(f.Path))] = true
	}
	var files []string
	err := filepath.WalkDir(destDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(destDir, p)
		if err != nil {
			return err
		}
		if !want[rel] {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	n := 0
	for _, p := range files {
		if err := os.Remove(p); err != nil {
			return n, err
		}
		n++
	}
	pruneEmptyDirs(destDir)
	return n, nil
}

// pruneEmptyDirs removes empty subdirectories under root (root itself is kept).
func pruneEmptyDirs(root string) {
	var dirs []string
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	})
	// Deepest first so a parent can empty after its children go.
	for i := len(dirs) - 1; i >= 0; i-- {
		if dirs[i] == root {
			continue
		}
		os.Remove(dirs[i]) // fails harmlessly if not empty
	}
}
```

Add `"io/fs"` to recv.go's imports (it already imports `path/filepath`, `os`).

Wire it into `Receive` at the marked hook (after the receive loop, before `WriteJSON(rw, MsgResult, res)`):

```go
	if hello.Delete && opts.AllowDelete {
		// Best-effort mirror delete; a failure here doesn't undo the files that
		// already landed, so it does not fail the transfer.
		_, _ = deleteExtras(destDir, m)
	}
```

- [ ] **Step 4: Run test**

Run: `cd server && go test ./internal/xfer/ -run TestDeleteExtras`
Expected: PASS.

- [ ] **Step 5: serve `--allow-delete`**

In `server/cmd/relayium/serve.go`:

Add the flag to `serveFlags`:

```go
	allowDelete bool
```

Register it in `runServe`:

```go
	fs.BoolVar(&f.allowDelete, "allow-delete", false, "honor a sender's --delete (mirror) request")
```

Add `allowDelete` to `serveHandler` and pass it into `xfer.Receive`:

```go
// in serveHandler struct:
	allowDelete bool
// in runServe when building h:
	allowDelete: f.allowDelete,
// in (*serveHandler).serve, the Receive call:
	rep, err := xfer.Receive(tconn, h.dir, xfer.RecvOpts{NoResume: h.noResume, AllowDelete: h.allowDelete})
```

- [ ] **Step 6: E2E — `--delete` gated by `--allow-delete`**

Append to `server/cmd/relayium/sync_e2e_test.go` a test that: seeds an extra file in the recv dir, syncs `--delete` with a serve that has `AllowDelete:true` (extend `daemonServe` to accept it, or add a variant), asserts the extra is gone; and a second run with `AllowDelete:false` asserts the extra remains. (Extend the `daemonServe` helper with an `allowDelete bool` param, threading it into the `serveHandler`.)

Run: `cd server && go test ./cmd/relayium/ -run 'TestSync'`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/xfer/recv.go server/internal/xfer/sync_test.go server/cmd/relayium/serve.go server/cmd/relayium/sync_e2e_test.go
git commit -m "feat(cli): sync --delete mirror, gated by serve --allow-delete"
```

---

### Task 6: `--watch` (fsnotify, debounced) — feature ③

**Files:**
- Create: `server/internal/xfer/watch.go`
- Modify: `server/cmd/relayium/sync.go` (watch loop), `server/go.mod` (fsnotify)
- Test: `server/internal/xfer/watch_test.go`

**Interfaces:**
- Consumes: `syncOnce` (Task 4).
- Produces: `xfer.WatchDirs(ctx, roots []string, debounce time.Duration, onChange func()) error`.

- [ ] **Step 1: Add the dependency**

Run: `cd server && go get github.com/fsnotify/fsnotify@latest && go mod tidy`
Expected: `fsnotify` added to go.mod as a direct dependency.

- [ ] **Step 2: Write the watcher with a debounce test**

Create `server/internal/xfer/watch.go`:

```go
package xfer

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/fsnotify/fsnotify"
)

// WatchDirs watches every directory under each root and calls onChange, debounced
// by the given window, whenever a file or directory under a root changes. New
// subdirectories are watched as they appear. It blocks until ctx is cancelled.
func WatchDirs(ctx context.Context, roots []string, debounce time.Duration, onChange func()) error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer w.Close()

	addTree := func(root string) {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				_ = w.Add(p)
			}
			return nil
		})
	}
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			return err
		}
		addTree(abs)
	}

	fire := make(chan struct{}, 1)
	var timer *time.Timer
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-w.Events:
			// Watch newly-created subdirectories too.
			if ev.Op&fsnotify.Create != 0 {
				if fi, err := os.Stat(ev.Name); err == nil && fi.IsDir() {
					addTree(ev.Name)
				}
			}
			if timer != nil {
				timer.Stop()
			}
			timer = time.AfterFunc(debounce, func() {
				select {
				case fire <- struct{}{}:
				default:
				}
			})
		case <-fire:
			onChange()
		case <-w.Errors:
			// On a watcher error, coalesce into a change so the next sync self-heals.
			select {
			case fire <- struct{}{}:
			default:
			}
		}
	}
}
```

The debounce is the testable unit. Create `server/internal/xfer/watch_test.go`:

```go
package xfer

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestWatchDirsDebouncesAndFires(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var fires int32
	go WatchDirs(ctx, []string{dir}, 100*time.Millisecond, func() { atomic.AddInt32(&fires, 1) })
	time.Sleep(50 * time.Millisecond) // let the watcher start

	// A burst of writes should coalesce into (about) one fire.
	for i := 0; i < 5; i++ {
		os.WriteFile(filepath.Join(dir, "f.txt"), []byte{byte(i)}, 0o644)
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)
	if n := atomic.LoadInt32(&fires); n < 1 {
		t.Fatalf("expected at least one fire, got %d", n)
	}
	if n := atomic.LoadInt32(&fires); n > 3 {
		t.Fatalf("burst of writes should debounce, got %d fires", n)
	}
}
```

- [ ] **Step 3: Run the watcher test**

Run: `cd server && go test ./internal/xfer/ -run TestWatchDirs`
Expected: PASS.

- [ ] **Step 4: Wire `--watch` into the sync command**

In `server/cmd/relayium/sync.go`, replace the `if !watch { return once() } ... return once()` stub with a watch loop:

```go
	if !watch {
		return once()
	}
	// Watch mode: sync once, then re-sync (debounced) on any change under the sources.
	if code := once(); code != 0 {
		fmt.Fprintln(stderr, "initial sync failed; watching for changes anyway")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	err := xfer.WatchDirs(ctx, srcs, 800*time.Millisecond, func() {
		if code := once(); code != 0 {
			fmt.Fprintln(stderr, "sync failed; will retry on next change")
		}
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
```

Add imports to sync.go: `"context"`, `"os"`, `"os/signal"` (via `signal.NotifyContext`), `"time"`.

- [ ] **Step 5: Build + real-binary smoke**

Run: `cd server && go build ./... && go vet ./cmd/relayium/ ./internal/xfer/`
Then a manual smoke (optional): `relayium sync --watch ./src relayium://host` in one terminal, touch a file in `./src`, observe a re-sync line.

- [ ] **Step 6: Full suite + commit**

Run: `cd server && go test ./...`
Expected: PASS.

```bash
git add server/internal/xfer/watch.go server/internal/xfer/watch_test.go server/cmd/relayium/sync.go server/go.mod server/go.sum
git commit -m "feat(cli): sync --watch — real-time incremental re-sync via fsnotify"
```

---

### Task 7: Docs + v0.2.0 (gated on user)

**Files:**
- Modify: `web/scripts/pages/content/articles/cli-*.mjs` (mention sync), `web/src/lib/CliPage.svelte` (a sync line), README.
- Operational: tag `v0.2.0`.

- [ ] **Step 1: Document sync**

Add a short "Keep a folder mirrored" note to the server-to-server tutorial and a one-liner to the /cli page / README: `relayium sync ./dir relayium://host --delete --watch`. (Localize per the established process; keep code English.)

- [ ] **Step 2: Verify + release**

Run: `cd server && go test ./... && cd ../web && npm run check && npx vitest run && npm run build`. On green and after merge + deploy, cut `v0.2.0` (ask the user before pushing the tag, as with prior releases).

---

## Notes for the executor

- Every engine change is additive and must keep push/pull byte-compatible — run the full `internal/xfer` suite after Tasks 2, 3, 5.
- `sync` never uses the tar fallback; over SSH it requires relayium on the remote.
- `--delete` is honored by `serve` only with `--allow-delete`; by `__recv` always (the user owns the SSH remote).
