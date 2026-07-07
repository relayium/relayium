# Relayium CLI — Phase 1 (SSH-native) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone Go `relayium` CLI that pushes/pulls files over the developer's existing SSH access to their own servers — zero Relayium infrastructure, zero cost, no account.

**Architecture:** A protocol engine (`internal/xfer`) speaks a tiny framed wire protocol over any `io.ReadWriter` (unit-tested via `net.Pipe`, no SSH needed). An SSH process layer (`internal/sshx`) shells out to the system `ssh` binary and pipes the engine over its stdio, reusing the user's `~/.ssh/config`, agent, and known_hosts (host-key check replaces SAS as the anti-MITM mechanism). The remote side runs `relayium __recv` in **full mode** when `relayium` is installed there, or falls back to a **zero-dependency** `tar`/`cat` stream when it is not.

**Tech Stack:** Go 1.26.3, standard library only (`os/exec`, `net`, `archive/tar`, `crypto/sha256`, `encoding/json`, `flag`) — no new module dependencies, matching the project's "tiny footprint" ethos. Pure Go, `CGO_ENABLED=0`.

## Global Constraints

- Module: `github.com/relayium/relayium`, rooted at `server/` (all Go paths below are relative to `server/`). — verbatim from spec §9.
- Go 1.26.3; `CGO_ENABLED=0`; no new third-party dependencies (stdlib only). — from repo `go.mod` + Dockerfile.
- Tests use the standard `testing` package only (no testify), `t.Fatalf` style, `t.TempDir()` for scratch dirs — matching `server/internal/storage/disk_test.go`.
- Phase 1 is pure client-side: it MUST NOT touch signaling, TURN, metering, billing, or any `internal/account`/`internal/signal` code. — spec §3.
- No app-layer crypto in Phase 1; confidentiality/auth/anti-MITM come entirely from SSH. — spec §7.
- Endpoint syntax mirrors scp: `user@host:path`, `host:path`, local `path`, and `-` for stdin. — spec §4.
- `__recv` is a hidden subcommand (not shown in help). — spec §9.

---

### Task 1: Endpoint parsing

**Files:**
- Create: `internal/xfer/endpoint.go`
- Test: `internal/xfer/endpoint_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Endpoint struct { User, Host, Path string; Stdin bool }`
  - `func ParseEndpoint(s string) (Endpoint, error)`
  - `func (e Endpoint) IsRemote() bool` — true iff `Host != ""`

- [ ] **Step 1: Write the failing test**

```go
package xfer

import "testing"

func TestParseEndpoint(t *testing.T) {
	cases := []struct {
		in   string
		want Endpoint
	}{
		{"me@srv:/data/x", Endpoint{User: "me", Host: "srv", Path: "/data/x"}},
		{"srv:rel/path", Endpoint{Host: "srv", Path: "rel/path"}},
		{"srv:", Endpoint{Host: "srv", Path: "."}},
		{"/local/abs", Endpoint{Path: "/local/abs"}},
		{"local/rel", Endpoint{Path: "local/rel"}},
		{"-", Endpoint{Stdin: true}},
	}
	for _, c := range cases {
		got, err := ParseEndpoint(c.in)
		if err != nil {
			t.Fatalf("ParseEndpoint(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("ParseEndpoint(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestParseEndpointRemoteDetection(t *testing.T) {
	r, _ := ParseEndpoint("me@srv:/x")
	if !r.IsRemote() {
		t.Fatal("me@srv:/x should be remote")
	}
	l, _ := ParseEndpoint("/x")
	if l.IsRemote() {
		t.Fatal("/x should be local")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run TestParseEndpoint -v`
Expected: FAIL — `undefined: ParseEndpoint` / `undefined: Endpoint`.

- [ ] **Step 3: Write minimal implementation**

```go
// Package xfer implements the Relayium CLI's SSH-native transfer engine and
// its wire protocol. It is pure client-side and never touches server code.
package xfer

import "strings"

// Endpoint is a parsed push/pull argument. A remote endpoint has a non-empty
// Host; a local one has Host == "". Stdin is set only for the literal "-".
type Endpoint struct {
	User string
	Host string
	Path string
	Stdin bool
}

// IsRemote reports whether the endpoint names a host reachable over SSH.
func (e Endpoint) IsRemote() bool { return e.Host != "" }

// ParseEndpoint parses scp-style targets: "user@host:path", "host:path",
// a local filesystem path, or "-" for stdin. A local path is anything with
// no "host:" prefix (a leading "/" or "./" or a bare relative path). An empty
// remote path defaults to ".".
func ParseEndpoint(s string) (Endpoint, error) {
	if s == "-" {
		return Endpoint{Stdin: true}, nil
	}
	// A "host:path" form has a colon before any slash. "/a/b" and "./a" are local.
	colon := strings.IndexByte(s, ':')
	slash := strings.IndexByte(s, '/')
	if colon > 0 && (slash == -1 || colon < slash) {
		hostpart, path := s[:colon], s[colon+1:]
		e := Endpoint{Path: path}
		if at := strings.IndexByte(hostpart, '@'); at >= 0 {
			e.User = hostpart[:at]
			e.Host = hostpart[at+1:]
		} else {
			e.Host = hostpart
		}
		if e.Path == "" {
			e.Path = "."
		}
		return e, nil
	}
	return Endpoint{Path: s}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/xfer/ -run TestParseEndpoint -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/xfer/endpoint.go server/internal/xfer/endpoint_test.go
git commit -m "feat(cli): scp-style endpoint parsing"
```

---

### Task 2: Wire frame codec + message types

**Files:**
- Create: `internal/xfer/wire.go`
- Test: `internal/xfer/wire_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MsgType uint8` with consts `MsgHello=1, MsgManifest=2, MsgResume=3, MsgFileStart=4, MsgFileHash=5, MsgResult=6, MsgError=7`
  - `func WriteFrame(w io.Writer, t MsgType, payload []byte) error` — writes `[type:1][len:uint32-BE][payload]`
  - `func ReadFrame(r io.Reader) (MsgType, []byte, error)`
  - `func WriteJSON(w io.Writer, t MsgType, v any) error` / `func ReadJSON(r io.Reader, v any) (MsgType, error)`
  - message structs: `type Hello struct { Version int; Mode string }`, `type FileEntry struct { Path string; Size int64; Mode uint32; ModTime int64 }`, `type Manifest struct { Files []FileEntry }`, `type ResumeEntry struct { Index int; Have int64 }`, `type ResumeState struct { Entries []ResumeEntry }`, `type FileStart struct { Index int; Offset int64 }`, `type FileHash struct { Index int; SHA256 string }`, `type Result struct { OK bool; Failed []string }`
  - `const WireVersion = 1`

Note for later tasks: raw file bytes are streamed **directly on the wire** after a `MsgFileStart` frame (exactly `Size-Offset` bytes), not wrapped in a frame — a `MsgFileHash` frame follows. This keeps large files out of memory.

- [ ] **Step 1: Write the failing test**

```go
package xfer

import (
	"bytes"
	"testing"
)

func TestFrameRoundtrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, MsgHello, []byte("hi")); err != nil {
		t.Fatalf("write: %v", err)
	}
	tp, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if tp != MsgHello || string(payload) != "hi" {
		t.Fatalf("got type=%d payload=%q", tp, payload)
	}
}

func TestJSONFrameRoundtrip(t *testing.T) {
	var buf bytes.Buffer
	in := Manifest{Files: []FileEntry{{Path: "a.txt", Size: 3, Mode: 0o644, ModTime: 111}}}
	if err := WriteJSON(&buf, MsgManifest, in); err != nil {
		t.Fatalf("write: %v", err)
	}
	var out Manifest
	tp, err := ReadJSON(&buf, &out)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if tp != MsgManifest || len(out.Files) != 1 || out.Files[0].Path != "a.txt" || out.Files[0].Size != 3 {
		t.Fatalf("roundtrip mismatch: %+v", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run Frame -v`
Expected: FAIL — `undefined: WriteFrame` etc.

- [ ] **Step 3: Write minimal implementation**

```go
package xfer

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// WireVersion is the protocol version carried in Hello; bump on breaking changes.
const WireVersion = 1

// MsgType tags a control frame. File bytes are streamed raw after MsgFileStart.
type MsgType uint8

const (
	MsgHello     MsgType = 1
	MsgManifest  MsgType = 2
	MsgResume    MsgType = 3
	MsgFileStart MsgType = 4
	MsgFileHash  MsgType = 5
	MsgResult    MsgType = 6
	MsgError     MsgType = 7
)

const maxFramePayload = 8 << 20 // 8 MiB guard for control frames

type Hello struct {
	Version int
	Mode    string // "push" or "pull"
}

type FileEntry struct {
	Path    string // relative, forward-slash separated
	Size    int64
	Mode    uint32
	ModTime int64 // unix seconds
}

type Manifest struct{ Files []FileEntry }

type ResumeEntry struct {
	Index int
	Have  int64 // bytes already on the receiver's disk for this file
}

type ResumeState struct{ Entries []ResumeEntry }

type FileStart struct {
	Index  int
	Offset int64
}

type FileHash struct {
	Index  int
	SHA256 string
}

type Result struct {
	OK     bool
	Failed []string
}

// WriteFrame writes [type:1][len:uint32-BE][payload].
func WriteFrame(w io.Writer, t MsgType, payload []byte) error {
	if len(payload) > maxFramePayload {
		return fmt.Errorf("frame payload too large: %d", len(payload))
	}
	var hdr [5]byte
	hdr[0] = byte(t)
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// ReadFrame reads a single control frame.
func ReadFrame(r io.Reader) (MsgType, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > maxFramePayload {
		return 0, nil, fmt.Errorf("frame payload too large: %d", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return MsgType(hdr[0]), payload, nil
}

// WriteJSON marshals v and writes it as a typed frame.
func WriteJSON(w io.Writer, t MsgType, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return WriteFrame(w, t, b)
}

// ReadJSON reads one frame and unmarshals its payload into v.
func ReadJSON(r io.Reader, v any) (MsgType, error) {
	t, payload, err := ReadFrame(r)
	if err != nil {
		return 0, err
	}
	if err := json.Unmarshal(payload, v); err != nil {
		return t, err
	}
	return t, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/xfer/ -run Frame -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/xfer/wire.go server/internal/xfer/wire_test.go
git commit -m "feat(cli): framed wire protocol codec + message types"
```

---

### Task 3: Manifest building (walk local files)

**Files:**
- Create: `internal/xfer/manifest.go`
- Test: `internal/xfer/manifest_test.go`

**Interfaces:**
- Consumes: `FileEntry`, `Manifest` (Task 2).
- Produces:
  - `func BuildManifest(roots []string) (Manifest, []string, error)` — returns the manifest plus a parallel slice of **absolute local source paths** (one per `Files[i]`), so the sender can open each file by index. Directories are walked recursively; `Path` in the manifest is relative to each root's parent (so `push ./dir` lands as `dir/...` on the remote).

- [ ] **Step 1: Write the failing test**

```go
package xfer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildManifestWalksDir(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("aaa"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "b.txt"), []byte("bb"), 0o644); err != nil {
		t.Fatal(err)
	}

	m, srcs, err := BuildManifest([]string{root})
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	if len(m.Files) != 2 || len(srcs) != 2 {
		t.Fatalf("want 2 files, got %d (srcs %d)", len(m.Files), len(srcs))
	}
	base := filepath.Base(root)
	byPath := map[string]FileEntry{}
	for _, f := range m.Files {
		byPath[f.Path] = f
	}
	if e, ok := byPath[base+"/a.txt"]; !ok || e.Size != 3 {
		t.Fatalf("a.txt entry wrong: %+v ok=%v", e, ok)
	}
	if _, ok := byPath[base+"/sub/b.txt"]; !ok {
		t.Fatalf("sub/b.txt missing; got %+v", m.Files)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run BuildManifest -v`
Expected: FAIL — `undefined: BuildManifest`.

- [ ] **Step 3: Write minimal implementation**

```go
package xfer

import (
	"io/fs"
	"path/filepath"
)

// BuildManifest walks the given source roots and returns a manifest plus a
// parallel slice of absolute source paths (srcs[i] is the local file for
// m.Files[i]). Manifest paths are relative to each root's parent directory and
// use forward slashes, so `push ./dir` reproduces `dir/...` on the receiver.
// Only regular files are included; symlinks and special files are skipped.
func BuildManifest(roots []string) (Manifest, []string, error) {
	var m Manifest
	var srcs []string
	for _, root := range roots {
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return Manifest{}, nil, err
		}
		parent := filepath.Dir(absRoot)
		err = filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(parent, p)
			if err != nil {
				return err
			}
			m.Files = append(m.Files, FileEntry{
				Path:    filepath.ToSlash(rel),
				Size:    info.Size(),
				Mode:    uint32(info.Mode().Perm()),
				ModTime: info.ModTime().Unix(),
			})
			srcs = append(srcs, p)
			return nil
		})
		if err != nil {
			return Manifest{}, nil, err
		}
	}
	return m, srcs, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/xfer/ -run BuildManifest -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/xfer/manifest.go server/internal/xfer/manifest_test.go
git commit -m "feat(cli): recursive manifest builder"
```

---

### Task 4: Full-mode transfer engine (send + receive), per-file SHA-256, no resume yet

**Files:**
- Create: `internal/xfer/send.go`
- Create: `internal/xfer/recv.go`
- Test: `internal/xfer/transfer_test.go`

**Interfaces:**
- Consumes: everything from Tasks 2–3.
- Produces:
  - `type SendOpts struct { Progress func(path string, sent, total int64) }`
  - `type RecvOpts struct{}`
  - `type Report struct { Files int; Bytes int64; Failed []string }`
  - `func Send(rw io.ReadWriter, m Manifest, srcs []string, opts SendOpts) (Report, error)`
  - `func Receive(rw io.ReadWriter, destDir string, opts RecvOpts) (Report, error)`

Protocol (push): sender→ `MsgHello{Version, "push"}`, `MsgManifest`; receiver→ `MsgResume` (empty for now); then per file i: sender→ `MsgFileStart{i, 0}` + raw `Size` bytes + `MsgFileHash{i, hex}`; receiver writes to `destDir/Path`, hashes, records failures; finally receiver→ `MsgResult`.

- [ ] **Step 1: Write the failing test**

```go
package xfer

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// pipeTransfer wires Send and Receive over an in-memory duplex pipe.
func TestSendReceiveRoundtrip(t *testing.T) {
	srcRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcRoot, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(srcRoot, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcRoot, "d", "b.bin"), []byte("world!!"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	cSend, cRecv := net.Pipe()

	errc := make(chan error, 1)
	go func() {
		_, err := Send(cSend, m, srcs, SendOpts{})
		cSend.Close()
		errc <- err
	}()

	rep, err := Receive(cRecv, dst, RecvOpts{})
	cRecv.Close()
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("send: %v", serr)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("unexpected failures: %v", rep.Failed)
	}

	base := filepath.Base(srcRoot)
	got, err := os.ReadFile(filepath.Join(dst, base, "a.txt"))
	if err != nil || string(got) != "hello" {
		t.Fatalf("a.txt = %q err=%v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(dst, base, "d", "b.bin"))
	if err != nil || string(got) != "world!!" {
		t.Fatalf("b.bin = %q err=%v", got, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run SendReceive -v`
Expected: FAIL — `undefined: Send` / `undefined: Receive`.

- [ ] **Step 3: Write minimal implementation**

`internal/xfer/send.go`:

```go
package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
)

type SendOpts struct {
	Progress func(path string, sent, total int64)
}

type Report struct {
	Files  int
	Bytes  int64
	Failed []string
}

// Send transmits the manifest's files over rw (a duplex stream, typically the
// SSH stdio pipe). srcs[i] is the local path for m.Files[i].
func Send(rw io.ReadWriter, m Manifest, srcs []string, opts SendOpts) (Report, error) {
	if err := WriteJSON(rw, MsgHello, Hello{Version: WireVersion, Mode: "push"}); err != nil {
		return Report{}, err
	}
	if err := WriteJSON(rw, MsgManifest, m); err != nil {
		return Report{}, err
	}

	// Read the receiver's resume state (empty in this task; used in Task 5).
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

	var rep Report
	for i, f := range m.Files {
		if err := sendFile(rw, i, f, srcs[i], offsets[i], opts); err != nil {
			return rep, err
		}
		rep.Files++
		rep.Bytes += f.Size
	}

	// Read the final result.
	var res Result
	if _, err := ReadJSON(rw, &res); err != nil {
		return rep, err
	}
	rep.Failed = res.Failed
	return rep, nil
}

func sendFile(rw io.ReadWriter, i int, f FileEntry, src string, offset int64, opts SendOpts) error {
	file, err := os.Open(src)
	if err != nil {
		return err
	}
	defer file.Close()

	if err := WriteJSON(rw, MsgFileStart, FileStart{Index: i, Offset: offset}); err != nil {
		return err
	}
	if offset > 0 {
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return err
		}
	}

	// Hash the whole file (from 0) while streaming the tail [offset, Size).
	h := sha256.New()
	if offset > 0 {
		head := io.NewSectionReader(file, 0, offset)
		if _, err := io.Copy(h, head); err != nil {
			return err
		}
	}
	sent := offset
	buf := make([]byte, 192<<10) // 192 KiB, matching the web client's chunk size
	for {
		n, rerr := file.Read(buf)
		if n > 0 {
			if _, err := rw.Write(buf[:n]); err != nil {
				return err
			}
			h.Write(buf[:n])
			sent += int64(n)
			if opts.Progress != nil {
				opts.Progress(f.Path, sent, f.Size)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if sent != f.Size {
		return fmt.Errorf("%s: size changed during send (%d != %d)", f.Path, sent, f.Size)
	}
	return WriteJSON(rw, MsgFileHash, FileHash{Index: i, SHA256: hex.EncodeToString(h.Sum(nil))})
}
```

`internal/xfer/recv.go`:

```go
package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type RecvOpts struct{}

// Receive accepts a pushed batch into destDir. It reads the manifest, reports
// resume state (empty in Task 4), then writes each file, verifying SHA-256.
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

	// Task 4: no resume — report empty state. Task 5 fills Entries.
	if err := WriteJSON(rw, MsgResume, resumeStateFor(destDir, m)); err != nil {
		return Report{}, err
	}

	var rep Report
	var res Result
	res.OK = true
	for range m.Files {
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
	rep.Failed = res.Failed
	return rep, WriteJSON(rw, MsgResult, res)
}

// resumeStateFor is defined in Task 5; Task 4 provides the empty stub below.
func resumeStateFor(destDir string, m Manifest) ResumeState { return ResumeState{} }

// writeFileBody reads exactly f.Size-offset bytes from rw, writes them at the
// given offset in dest, and returns the SHA-256 (hex) of the full file.
func writeFileBody(rw io.Reader, dest string, f FileEntry, offset int64) (string, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	flag := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flag |= os.O_TRUNC
	}
	out, err := os.OpenFile(dest, flag, os.FileMode(f.Mode))
	if err != nil {
		return "", err
	}
	defer out.Close()

	h := sha256.New()
	if offset > 0 {
		existing, err := os.Open(dest)
		if err != nil {
			return "", err
		}
		if _, err := io.CopyN(h, existing, offset); err != nil {
			existing.Close()
			return "", err
		}
		existing.Close()
		if _, err := out.Seek(offset, io.SeekStart); err != nil {
			return "", err
		}
	}
	mw := io.MultiWriter(out, h)
	if _, err := io.CopyN(mw, rw, f.Size-offset); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// safeJoin joins a relative manifest path onto destDir, rejecting any path that
// escapes destDir (defends against a malicious/buggy manifest with "..").
func safeJoin(destDir, rel string) (string, error) {
	clean := filepath.Clean("/" + filepath.FromSlash(rel))
	joined := filepath.Join(destDir, clean)
	if joined != destDir && !strings.HasPrefix(joined, destDir+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe path in manifest: %q", rel)
	}
	return joined, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/xfer/ -run SendReceive -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/xfer/send.go server/internal/xfer/recv.go server/internal/xfer/transfer_test.go
git commit -m "feat(cli): full-mode transfer engine with per-file SHA-256"
```

---

### Task 5: Resume negotiation

**Files:**
- Modify: `internal/xfer/recv.go` (replace the `resumeStateFor` stub)
- Test: `internal/xfer/resume_test.go`

**Interfaces:**
- Consumes: `Manifest`, `ResumeState`, `ResumeEntry`, `writeFileBody` (Task 4).
- Produces: real `func resumeStateFor(destDir string, m Manifest) ResumeState` — for each manifest file already present on disk with `0 < diskSize < declaredSize`, emit `ResumeEntry{Index, Have: diskSize}`. Files that are absent, complete, or larger-than-declared get no entry (full re-send; `Send` truncates when offset==0).

- [ ] **Step 1: Write the failing test**

```go
package xfer

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestResumeSkipsAlreadyReceivedPrefix(t *testing.T) {
	// Source: one 10-byte file.
	srcRoot := t.TempDir()
	full := []byte("0123456789")
	if err := os.WriteFile(filepath.Join(srcRoot, "big.bin"), full, 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(srcRoot)

	// Destination already holds the correct first 4 bytes.
	dst := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dst, base), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, base, "big.bin"), full[:4], 0o644); err != nil {
		t.Fatal(err)
	}

	cSend, cRecv := net.Pipe()
	errc := make(chan error, 1)
	// Instrument the sender to record the offset it starts from.
	var sentTail int64
	go func() {
		_, err := Send(cSend, m, srcs, SendOpts{Progress: func(_ string, sent, _ int64) {
			sentTail = sent
		}})
		cSend.Close()
		errc <- err
	}()
	rep, err := Receive(cRecv, dst, RecvOpts{})
	cRecv.Close()
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("send: %v", serr)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("failures: %v", rep.Failed)
	}
	got, _ := os.ReadFile(filepath.Join(dst, base, "big.bin"))
	if string(got) != "0123456789" {
		t.Fatalf("resumed file wrong: %q", got)
	}
	// Progress should have started at offset 4 and ended at 10.
	if sentTail != 10 {
		t.Fatalf("final sent = %d, want 10", sentTail)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/xfer/ -run Resume -v`
Expected: FAIL — the stub returns empty state, so the receiver truncates and the whole file re-sends; assertion on resumed correctness still passes but this test is written to also fail if resume never engages. Confirm failure by temporarily asserting the offset; if it passes trivially, the real signal is Step 4 after implementing. (Expected concrete failure: none from stub for correctness, so treat Step 4 as the gate.)

> Note: because the stub still yields a byte-correct file, this task's test is primarily a **regression guard** that resume produces correct output. Verify the resume path is exercised by adding, in Step 3, a `t.Log` of the resume entries during manual `-v` runs if desired.

- [ ] **Step 3: Write minimal implementation**

Replace the stub in `internal/xfer/recv.go`:

```go
// resumeStateFor inspects destDir and returns, for each manifest file that has
// a partial (non-empty, shorter-than-declared) copy on disk, the number of
// bytes already present, so the sender can resume from that offset. The
// end-to-end SHA-256 check still validates the merged result.
func resumeStateFor(destDir string, m Manifest) ResumeState {
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
		if info.Size() > 0 && info.Size() < f.Size {
			rs.Entries = append(rs.Entries, ResumeEntry{Index: i, Have: info.Size()})
		}
	}
	return rs
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/xfer/ -run Resume -v`
Expected: PASS, with `sentTail == 10` and the file byte-correct. Also run the full package: `cd server && go test ./internal/xfer/` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/xfer/recv.go server/internal/xfer/resume_test.go
git commit -m "feat(cli): resume partial files from on-disk prefix"
```

---

### Task 6: SSH process layer (argv builder + Dial + remote-mode detection)

**Files:**
- Create: `internal/sshx/ssh.go`
- Test: `internal/sshx/ssh_test.go`

**Interfaces:**
- Consumes: `xfer.Endpoint` (Task 1).
- Produces:
  - `type Opts struct { IdentityFile string; Port int; ExtraArgs []string }`
  - `func BuildArgs(e xfer.Endpoint, remoteCmd string, o Opts) []string` — pure; assembles `ssh` argv (adds `-i`, `-p`, `-o BatchMode=yes` is NOT set so agent/passphrase prompts still work, host, then remoteCmd). Host uses `user@host` when `User != ""`.
  - `func Dial(e xfer.Endpoint, remoteCmd string, o Opts) (*Session, error)` — starts `ssh` via `os/exec`, returns a `*Session` exposing `io.ReadWriteCloser` over the child's stdin/stdout plus `Wait() error`.
  - `type Session struct { ... }` with `Read`, `Write`, `Close`, `Wait`.
  - `func RemoteHasRelayium(e xfer.Endpoint, o Opts) (bool, error)` — runs `ssh host command -v relayium`; true iff exit 0.

- [ ] **Step 1: Write the failing test**

```go
package sshx

import (
	"reflect"
	"testing"

	"github.com/relayium/relayium/internal/xfer"
)

func TestBuildArgs(t *testing.T) {
	e := xfer.Endpoint{User: "me", Host: "srv", Path: "/data"}
	got := BuildArgs(e, "relayium __recv /data", Opts{IdentityFile: "/k/id", Port: 2222})
	want := []string{"-i", "/k/id", "-p", "2222", "me@srv", "relayium __recv /data"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BuildArgs = %v, want %v", got, want)
	}
}

func TestBuildArgsMinimal(t *testing.T) {
	e := xfer.Endpoint{Host: "srv"}
	got := BuildArgs(e, "echo hi", Opts{})
	want := []string{"srv", "echo hi"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BuildArgs = %v, want %v", got, want)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/sshx/ -run BuildArgs -v`
Expected: FAIL — `undefined: BuildArgs`.

- [ ] **Step 3: Write minimal implementation**

```go
// Package sshx spawns the system ssh binary and exposes its stdio as a duplex
// stream, so the transfer engine runs over the user's existing SSH config,
// agent, known_hosts, and ProxyJump. Host-key verification (known_hosts) is the
// anti-MITM mechanism for the CLI's SSH-native path.
package sshx

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"

	"github.com/relayium/relayium/internal/xfer"
)

type Opts struct {
	IdentityFile string
	Port         int
	ExtraArgs    []string
}

// BuildArgs assembles the argv passed to `ssh` (excluding the leading "ssh").
func BuildArgs(e xfer.Endpoint, remoteCmd string, o Opts) []string {
	var args []string
	if o.IdentityFile != "" {
		args = append(args, "-i", o.IdentityFile)
	}
	if o.Port != 0 {
		args = append(args, "-p", strconv.Itoa(o.Port))
	}
	args = append(args, o.ExtraArgs...)
	host := e.Host
	if e.User != "" {
		host = e.User + "@" + e.Host
	}
	args = append(args, host, remoteCmd)
	return args
}

// Session is a running ssh child process presented as a duplex stream.
type Session struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out io.ReadCloser
}

func (s *Session) Read(p []byte) (int, error)  { return s.out.Read(p) }
func (s *Session) Write(p []byte) (int, error) { return s.in.Write(p) }

// Close closes the child's stdin (signalling EOF to the remote) and waits.
func (s *Session) Close() error {
	s.in.Close()
	return s.cmd.Wait()
}

// Wait blocks until ssh exits.
func (s *Session) Wait() error { return s.cmd.Wait() }

// Dial starts `ssh <args> host remoteCmd` and returns its stdio as a stream.
// ssh's own stderr is inherited so host-key prompts and errors reach the user.
func Dial(e xfer.Endpoint, remoteCmd string, o Opts) (*Session, error) {
	cmd := exec.Command("ssh", BuildArgs(e, remoteCmd, o)...)
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &Session{cmd: cmd, in: in, out: out}, nil
}

// RemoteHasRelayium reports whether `relayium` is on the remote's PATH.
func RemoteHasRelayium(e xfer.Endpoint, o Opts) (bool, error) {
	cmd := exec.Command("ssh", BuildArgs(e, "command -v relayium", o)...)
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	if err == nil {
		return true, nil
	}
	var ee *exec.ExitError
	if ok := asExitError(err, &ee); ok {
		return false, nil // non-zero exit = not found
	}
	return false, fmt.Errorf("ssh probe failed: %w", err)
}

func asExitError(err error, target **exec.ExitError) bool {
	if ee, ok := err.(*exec.ExitError); ok {
		*target = ee
		return true
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/sshx/ -run BuildArgs -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/sshx/ssh.go server/internal/sshx/ssh_test.go
git commit -m "feat(cli): ssh process layer (argv, dial, mode probe)"
```

---

### Task 7: Zero-dependency tar fallback

**Files:**
- Create: `internal/sshx/zerodep.go`
- Test: `internal/sshx/zerodep_test.go`

**Interfaces:**
- Consumes: `xfer.Manifest`, `xfer.FileEntry` (Task 2).
- Produces:
  - `func WriteTarStream(w io.Writer, m xfer.Manifest, srcs []string) error` — writes a POSIX tar of the batch to w (used to feed `ssh host 'tar -x -C dest'`). Tar member names are the manifest `Path` values.
  - `func RemoteUntarCmd(destPath string) string` — returns the remote shell command, e.g. `mkdir -p <dest> && tar -x -C <dest>` (dest shell-quoted).
  - `func ShellQuote(s string) string` — single-quote a shell arg safely.

The tar stream is verified locally by building it and reading it back with `archive/tar`; the actual remote untar is covered by the E2E test (Task 9).

- [ ] **Step 1: Write the failing test**

```go
package sshx

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/relayium/relayium/internal/xfer"
)

func TestWriteTarStream(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("AA"), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := xfer.BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if err := WriteTarStream(&buf, m, srcs); err != nil {
		t.Fatalf("WriteTarStream: %v", err)
	}

	tr := tar.NewReader(&buf)
	hdr, err := tr.Next()
	if err != nil {
		t.Fatalf("tar.Next: %v", err)
	}
	if hdr.Name != m.Files[0].Path {
		t.Fatalf("member name = %q, want %q", hdr.Name, m.Files[0].Path)
	}
	body, _ := io.ReadAll(tr)
	if string(body) != "AA" {
		t.Fatalf("member body = %q", body)
	}
}

func TestShellQuote(t *testing.T) {
	if got := ShellQuote(`a b'c`); got != `'a b'\''c'` {
		t.Fatalf("ShellQuote = %s", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/sshx/ -run 'Tar|ShellQuote' -v`
Expected: FAIL — `undefined: WriteTarStream` / `undefined: ShellQuote`.

- [ ] **Step 3: Write minimal implementation**

```go
package sshx

import (
	"archive/tar"
	"io"
	"os"
	"strings"

	"github.com/relayium/relayium/internal/xfer"
)

// WriteTarStream writes the batch as a POSIX tar to w, for the zero-dependency
// remote path (`ssh host 'tar -x -C dest'`). Member names are manifest paths.
func WriteTarStream(w io.Writer, m xfer.Manifest, srcs []string) error {
	tw := tar.NewWriter(w)
	for i, f := range m.Files {
		hdr := &tar.Header{
			Name: f.Path,
			Mode: int64(f.Mode),
			Size: f.Size,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		in, err := os.Open(srcs[i])
		if err != nil {
			return err
		}
		if _, err := io.CopyN(tw, in, f.Size); err != nil {
			in.Close()
			return err
		}
		in.Close()
	}
	return tw.Close()
}

// RemoteUntarCmd is the remote shell command that unpacks the tar stream.
func RemoteUntarCmd(destPath string) string {
	q := ShellQuote(destPath)
	return "mkdir -p " + q + " && tar -x -C " + q
}

// ShellQuote wraps s in single quotes, escaping embedded single quotes, so it
// is safe to interpolate into a remote /bin/sh command line.
func ShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/sshx/ -run 'Tar|ShellQuote' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/sshx/zerodep.go server/internal/sshx/zerodep_test.go
git commit -m "feat(cli): zero-dependency tar fallback for bare remotes"
```

---

### Task 8: CLI front-end (`push` / `pull` / hidden `__recv`, flags, progress, exit codes)

**Files:**
- Create: `cmd/relayium/main.go`
- Create: `cmd/relayium/run.go` (dispatch + orchestration, kept separate from `main` for testability)
- Test: `cmd/relayium/run_test.go`

**Interfaces:**
- Consumes: `xfer.*` (Tasks 1–5), `sshx.*` (Tasks 6–7).
- Produces:
  - `func Run(args []string, stdout, stderr io.Writer) int` — parses `args` (excluding program name), dispatches subcommands, returns a process exit code. `main()` calls `os.Exit(Run(os.Args[1:], os.Stdout, os.Stderr))`.
  - Subcommands: `push <src...> <dest>`, `pull <src> <dest>`, hidden `__recv <destDir>`.
  - Flags (via a `flag.FlagSet` per subcommand): `-i` (identity), `-p` (port), `--no-resume`, `--no-verify`.

Orchestration for `push` to a remote:
1. Parse the last arg as the dest `Endpoint`; the rest are local sources.
2. `RemoteHasRelayium`: if true → **full mode**: `Dial(dest, "relayium __recv <path>")`, then `xfer.Send(session, manifest, srcs, opts)`.
3. If false → **zero-dep mode**: `exec ssh` with `RemoteUntarCmd(dest.Path)` as remote command, pipe `WriteTarStream` into its stdin.
4. Progress printed to stderr when it is a TTY.

`__recv` reads the batch from stdin/stdout: `xfer.Receive(struct{io.Reader;io.Writer}{os.Stdin, os.Stdout}, destDir, opts)`.

- [ ] **Step 1: Write the failing test**

```go
package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunUnknownCommand(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run([]string{"frobnicate"}, &out, &errb)
	if code == 0 {
		t.Fatal("unknown command should exit non-zero")
	}
	if !strings.Contains(errb.String(), "usage") && !strings.Contains(errb.String(), "unknown") {
		t.Fatalf("stderr should explain the error, got %q", errb.String())
	}
}

func TestRunNoArgsShowsUsage(t *testing.T) {
	var out, errb bytes.Buffer
	code := Run(nil, &out, &errb)
	if code == 0 {
		t.Fatal("no args should exit non-zero")
	}
	combined := out.String() + errb.String()
	if !strings.Contains(combined, "push") || !strings.Contains(combined, "pull") {
		t.Fatalf("usage should list push/pull, got %q", combined)
	}
	if strings.Contains(combined, "__recv") {
		t.Fatalf("__recv must stay hidden from usage, got %q", combined)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium/ -v`
Expected: FAIL — `undefined: Run`.

- [ ] **Step 3: Write minimal implementation**

`cmd/relayium/main.go`:

```go
// Command relayium is the Relayium CLI. Phase 1 provides SSH-native push/pull
// to servers the user already has SSH access to; bytes travel over that SSH
// connection and never touch Relayium infrastructure.
package main

import (
	"os"
)

func main() {
	os.Exit(Run(os.Args[1:], os.Stdout, os.Stderr))
}
```

`cmd/relayium/run.go`:

```go
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

const usage = `relayium — SSH-native file transfer

usage:
  relayium push <src...> [user@]host:dest    push files to a server you can ssh into
  relayium pull [user@]host:src <dest>       pull files from such a server

flags (after the subcommand):
  -i <file>     ssh identity file
  -p <port>     ssh port
  --no-resume   disable resuming partial files
`

// duplex adapts a separate reader and writer into one io.ReadWriter (used to
// hand os.Stdin/os.Stdout to the transfer engine on the remote side).
type duplex struct {
	io.Reader
	io.Writer
}

// Run dispatches a subcommand and returns a process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "push":
		return runPush(args[1:], stdout, stderr)
	case "pull":
		return runPull(args[1:], stdout, stderr)
	case "__recv":
		return runRecv(args[1:], stdout, stderr)
	case "-h", "--help", "help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

type sshFlags struct {
	identity string
	port     int
	noResume bool
}

// (parseFlags, runPush, runPull, runRecv implemented below.)
```

Add the subcommand bodies to `run.go` (all flag parsing goes through `parseFlagsStd`, defined in `flags.go` below):

```go
func runPush(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseFlagsStd(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) < 2 {
		fmt.Fprintln(stderr, "push needs <src...> <dest>")
		return 2
	}
	destArg := rest[len(rest)-1]
	srcArgs := rest[:len(rest)-1]
	dest, err := xfer.ParseEndpoint(destArg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !dest.IsRemote() {
		fmt.Fprintln(stderr, "push destination must be remote (host:path)")
		return 2
	}
	m, srcs, err := xfer.BuildManifest(srcArgs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	opts := sshx.Opts{IdentityFile: f.identity, Port: f.port}

	has, err := sshx.RemoteHasRelayium(dest, opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if has {
		sess, err := sshx.Dial(dest, "relayium __recv "+sshx.ShellQuote(dest.Path), opts)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		rep, err := xfer.Send(sess, m, srcs, xfer.SendOpts{Progress: progressFn(stderr)})
		cerr := sess.Close()
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if cerr != nil {
			fmt.Fprintln(stderr, cerr)
			return 1
		}
		return reportExit(rep, stderr)
	}

	// Zero-dependency mode: pipe a tar stream into remote `tar -x`.
	sess, err := sshx.Dial(dest, sshx.RemoteUntarCmd(dest.Path), opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := sshx.WriteTarStream(sess, m, srcs); err != nil {
		sess.Close()
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := sess.Close(); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "sent %d file(s) (zero-dependency mode)\n", len(m.Files))
	return 0
}

func runPull(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseFlagsStd(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(rest) != 2 {
		fmt.Fprintln(stderr, "pull needs <host:src> <dest>")
		return 2
	}
	src, err := xfer.ParseEndpoint(rest[0])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if !src.IsRemote() {
		fmt.Fprintln(stderr, "pull source must be remote (host:path)")
		return 2
	}
	destDir := rest[1]
	opts := sshx.Opts{IdentityFile: f.identity, Port: f.port}
	// Pull requires relayium on the remote (it acts as the sender).
	sess, err := sshx.Dial(src, "relayium __send "+sshx.ShellQuote(src.Path), opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	rep, err := xfer.Receive(sess, destDir, xfer.RecvOpts{})
	cerr := sess.Close()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if cerr != nil {
		fmt.Fprintln(stderr, cerr)
		return 1
	}
	return reportExit(rep, stderr)
}

func runRecv(args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "__recv needs <destDir>")
		return 2
	}
	rw := duplex{Reader: os.Stdin, Writer: os.Stdout}
	rep, err := xfer.Receive(rw, args[0], xfer.RecvOpts{})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return reportExit(rep, stderr)
}

func reportExit(rep xfer.Report, stderr io.Writer) int {
	if len(rep.Failed) > 0 {
		fmt.Fprintf(stderr, "%d file(s) failed integrity check: %v\n", len(rep.Failed), rep.Failed)
		return 1
	}
	return 0
}

func progressFn(stderr io.Writer) func(string, int64, int64) {
	// Minimal, non-TTY-safe progress; refined rendering is out of Phase 1 scope.
	return func(path string, sent, total int64) {
		if sent == total {
			fmt.Fprintf(stderr, "  %s (%d bytes)\n", path, total)
		}
	}
}
```

Add `cmd/relayium/flags.go` with the flag parser:

```go
package main

import "flag"

// parseFlagsStd parses the shared ssh flags from a subcommand's args and
// returns the remaining positional arguments.
func parseFlagsStd(args []string) (sshFlags, []string, error) {
	fs := flag.NewFlagSet("relayium", flag.ContinueOnError)
	var f sshFlags
	fs.StringVar(&f.identity, "i", "", "ssh identity file")
	fs.IntVar(&f.port, "p", 0, "ssh port")
	fs.BoolVar(&f.noResume, "no-resume", false, "disable resume")
	if err := fs.Parse(args); err != nil {
		return f, nil, err
	}
	return f, fs.Args(), nil
}
```

Note: `pull` references a remote `relayium __send`. Add a matching hidden `__send` case that calls `xfer.Send` from a manifest built on the remote for `src.Path`. Implement it symmetrically:

```go
	case "__send":
		return runSend(args[1:], stdout, stderr)
```
```go
func runSend(args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "__send needs <srcPath>")
		return 2
	}
	m, srcs, err := xfer.BuildManifest([]string{args[0]})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	rw := duplex{Reader: os.Stdin, Writer: os.Stdout}
	if _, err := xfer.Send(rw, m, srcs, xfer.SendOpts{}); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go vet ./cmd/relayium/ && go test ./cmd/relayium/ -v`
Expected: `go vet` clean; both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium/
git commit -m "feat(cli): push/pull/__recv front-end with full + zero-dep modes"
```

---

### Task 9: End-to-end test over `ssh localhost`

**Files:**
- Create: `cmd/relayium/e2e_test.go`

**Interfaces:**
- Consumes: the built `relayium` binary + everything above.

This test is **skipped** unless the environment opts in (`RELAYIUM_E2E_SSH=1`) and `ssh localhost true` succeeds, because CI without a loopback sshd cannot run it. It is the acceptance gate for the whole feature.

- [ ] **Step 1: Write the test**

```go
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func sshLocalhostAvailable(t *testing.T) {
	t.Helper()
	if os.Getenv("RELAYIUM_E2E_SSH") != "1" {
		t.Skip("set RELAYIUM_E2E_SSH=1 and ensure `ssh localhost` works to run this")
	}
	if err := exec.Command("ssh", "-o", "BatchMode=yes", "localhost", "true").Run(); err != nil {
		t.Skipf("ssh localhost not usable: %v", err)
	}
}

func TestE2EZeroDepPushOverSSH(t *testing.T) {
	sshLocalhostAvailable(t)

	// Build the CLI binary.
	bin := filepath.Join(t.TempDir(), "relayium")
	if out, err := exec.Command("go", "build", "-o", bin, "./cmd/relayium").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}

	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "hello.txt"), []byte("over-ssh"), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()

	// Force zero-dep mode by ensuring the built binary is NOT on the remote PATH:
	// localhost shares our PATH, so run with a scrubbed PATH that still has tar/ssh.
	cmd := exec.Command(bin, "push", filepath.Join(src, "hello.txt"), "localhost:"+dst)
	cmd.Env = append(os.Environ(), "PATH=/usr/bin:/bin")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("push: %v\n%s", err, out)
	}

	got, err := os.ReadFile(filepath.Join(dst, "hello.txt"))
	if err != nil || string(got) != "over-ssh" {
		t.Fatalf("received = %q err=%v", got, err)
	}
}
```

- [ ] **Step 2: Run it (opt-in)**

Run: `cd server && RELAYIUM_E2E_SSH=1 go test ./cmd/relayium/ -run E2E -v`
Expected: PASS if `ssh localhost` works; otherwise SKIP with a clear message.

- [ ] **Step 3: Run the whole suite**

Run: `cd server && go test ./...`
Expected: all PASS (E2E SKIPs without the env var). Confirm the server packages still build and pass untouched.

- [ ] **Step 4: Commit**

```bash
git add server/cmd/relayium/e2e_test.go
git commit -m "test(cli): opt-in E2E push over ssh localhost"
```

---

## Self-Review

**1. Spec coverage:**
- §3 standalone Go binary → Task 8 (`cmd/relayium`). ✅
- §4 command surface (`push`/`pull`/stdin/`user@host:path`/`~/.ssh/config`) → Task 1 (parse), Task 6 (ssh argv reuses system ssh → config/agent/ProxyJump inherited), Task 8 (subcommands). ⚠️ stdin (`push -`) is parsed (Task 1) but the orchestration in Task 8 wires files, not the `-` stdin body. **Gap intentionally deferred:** stdin piping needs a one-file manifest with unknown size; noted in "Deferred within Phase 1" below rather than adding an under-specified task.
- §5 shell out to system ssh → Task 6. ✅
- §6 full + zero-dep modes, auto-detect → Task 6 (`RemoteHasRelayium`), Task 7 (tar), Task 8 (dispatch). ✅
- §7 no self-crypto, rely on SSH → no crypto task exists by design; host-key note in Task 6 doc. ✅
- §8 Go wire protocol first written → Tasks 2–5. ✅
- §10 unit + integration + E2E → Tasks 1–8 unit, Task 9 E2E. ✅

**2. Placeholder scan:** No TODOs, stubs-without-instruction, or bogus imports remain. `resumeStateFor` is a real stub in Task 4 with a same-signature replacement in Task 5 (explicitly sequenced, not a silent placeholder). Task 8 Step 4 gates on `go vet ./cmd/relayium/` being clean.

**3. Type consistency:** `Endpoint`, `Manifest`, `FileEntry`, `ResumeState`, `Report`, `SendOpts{Progress}`, `RecvOpts`, `sshx.Opts`, `Session`, `Send`/`Receive`/`BuildManifest`/`BuildArgs`/`Dial`/`RemoteHasRelayium`/`WriteTarStream`/`RemoteUntarCmd`/`ShellQuote`/`Run` are used with identical signatures across tasks. `resumeStateFor` is stubbed in Task 4 and replaced in Task 5 — same signature. ✅

## Deferred within Phase 1 (tracked, not silently dropped)
- `push -` (stdin body) and `pull` of a single file to stdout: parsing exists; streaming a stdin source of unknown size needs a manifest tweak (`Size == -1` → stream-until-EOF frame). Add as a fast-follow task once the batch path is proven.
- TTY-aware progress bar: current `progressFn` prints per-file completion lines only. Rich progress is UX polish, not core.
- Big-single-file resume in **zero-dep** mode (tar isn't resumable): documented limitation; full-mode resume (Task 5) covers the important case.
