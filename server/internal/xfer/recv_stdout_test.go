package xfer

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stdoutPair connects a receiver and a sender over two pipes, like the stdio
// of an ssh child. Closing it unblocks both sides.
type stdoutPair struct {
	recv, send io.ReadWriter
	r1, r2     *io.PipeReader
	w1, w2     *io.PipeWriter
}

func newStdoutPair(t *testing.T) *stdoutPair {
	t.Helper()
	r1, w1 := io.Pipe() // sender -> receiver
	r2, w2 := io.Pipe() // receiver -> sender
	p := &stdoutPair{r1: r1, r2: r2, w1: w1, w2: w2}
	p.recv = struct {
		io.Reader
		io.Writer
	}{r1, w2}
	p.send = struct {
		io.Reader
		io.Writer
	}{r2, w1}
	t.Cleanup(p.close)
	return p
}

func (p *stdoutPair) close() {
	p.r1.Close()
	p.r2.Close()
	p.w1.Close()
	p.w2.Close()
}

// receiveStdout runs ReceiveToWriter against sender and bounds it: a receive
// that hangs is a failure, not a stuck test.
func receiveStdout(t *testing.T, p *stdoutPair, w io.Writer) (Report, error) {
	t.Helper()
	type res struct {
		rep Report
		err error
	}
	ch := make(chan res, 1)
	go func() {
		rep, err := ReceiveToWriter(p.recv, w, StdoutOpts{})
		ch <- res{rep, err}
	}()
	select {
	case r := <-ch:
		return r.rep, r.err
	case <-time.After(10 * time.Second):
		p.close()
		t.Fatal("ReceiveToWriter did not return within 10s")
		return Report{}, nil
	}
}

// sendReal runs the real v1 Send of src (as `__send src` would) in the
// background and returns its result channel.
func sendReal(t *testing.T, p *stdoutPair, src string) chan error {
	t.Helper()
	m, srcs, err := BuildManifest([]string{src})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		rep, err := Send(p.send, m, srcs, SendOpts{})
		if err == nil && len(rep.Failed) > 0 {
			err = errors.New("sender saw failed: " + strings.Join(rep.Failed, ","))
		}
		p.w1.Close()
		done <- err
	}()
	return done
}

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	// Make sure the bytes a text-mode path would mangle are present.
	special := []byte{0, '\r', '\n', 0xff, 0xfe}
	for i := 0; i < len(special) && i < n; i++ {
		b[i] = special[i]
	}
	return b
}

func TestReceiveToWriterExactBytes(t *testing.T) {
	for _, n := range []int{0, 1, 192<<10 - 1, 192 << 10, 192<<10 + 1, 5<<20 + 7} {
		payload := randomBytes(t, n)
		src := filepath.Join(t.TempDir(), "file.bin")
		if err := os.WriteFile(src, payload, 0o600); err != nil {
			t.Fatal(err)
		}
		p := newStdoutPair(t)
		sent := sendReal(t, p, src)
		var out bytes.Buffer
		var calls int
		var last int64
		rep, err := func() (Report, error) {
			type res struct {
				rep Report
				err error
			}
			ch := make(chan res, 1)
			go func() {
				rep, err := ReceiveToWriter(p.recv, &out, StdoutOpts{Progress: func(path string, done, total int64) {
					calls++
					last = done
					if path != "file.bin" || total != int64(n) {
						t.Errorf("progress(%q, %d, %d)", path, done, total)
					}
				}})
				ch <- res{rep, err}
			}()
			select {
			case r := <-ch:
				return r.rep, r.err
			case <-time.After(20 * time.Second):
				p.close()
				t.Fatal("timeout")
				return Report{}, nil
			}
		}()
		if err != nil {
			t.Fatalf("size %d: %v", n, err)
		}
		if serr := <-sent; serr != nil {
			t.Fatalf("size %d: sender: %v", n, serr)
		}
		if !bytes.Equal(out.Bytes(), payload) {
			t.Fatalf("size %d: stdout holds %d bytes that differ from the source", n, out.Len())
		}
		if rep.Files != 1 || rep.Bytes != int64(n) || len(rep.Failed) != 0 {
			t.Fatalf("size %d: report %+v", n, rep)
		}
		if n > 0 && (calls == 0 || last != int64(n)) {
			t.Fatalf("size %d: progress calls=%d last=%d", n, calls, last)
		}
	}
}

// refusedByRealSender runs the real Send against ReceiveToWriter for a source
// the stdout mode must refuse, and checks: the refusal is an error, the sender
// saw a *RemoteError with code (so it got MsgError INSTEAD of a resume state and
// streamed nothing), and not one byte reached the writer.
func refusedByRealSender(t *testing.T, src, code string) {
	t.Helper()
	p := newStdoutPair(t)
	sent := sendReal(t, p, src)
	var out bytes.Buffer
	_, err := receiveStdout(t, p, &out)
	if err == nil {
		t.Fatalf("%s: accepted, want refused", src)
	}
	p.w2.Close() // the caller aborts the transport after a refusal
	serr := <-sent
	var re *RemoteError
	if !errors.As(serr, &re) || re.Code != code {
		t.Fatalf("%s: sender error = %v, want RemoteError %q", src, serr, code)
	}
	if out.Len() != 0 {
		t.Fatalf("%s: %d bytes reached stdout for a refused source", src, out.Len())
	}
}

func TestReceiveToWriterRefusesOneFileDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "only")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("inside a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	refusedByRealSender(t, dir, ErrCodeNotSingleFile)
}

func TestReceiveToWriterRefusesMultiFileDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "many")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"a", "b", "sub/c"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	refusedByRealSender(t, dir, ErrCodeNotSingleFile)
}

func TestReceiveToWriterRefusesEmptyDirectoryAndSymlink(t *testing.T) {
	empty := filepath.Join(t.TempDir(), "empty")
	if err := os.Mkdir(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	refusedByRealSender(t, empty, ErrCodeNotSingleFile)

	target := filepath.Join(t.TempDir(), "target.bin")
	if err := os.WriteFile(target, []byte("behind a link"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link.bin")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	refusedByRealSender(t, link, ErrCodeNotSingleFile)
}

// ── scripted senders: every frame the receiver must reject ─────────────────

type frame struct {
	t   MsgType
	v   any    // JSON payload, or
	raw []byte // raw bytes written as-is (body, garbage), or
	eof bool   // end the sender's stream here
}

// script plays frames as a sender and records every frame type the receiver
// sends back. After the frames it keeps the write side open (a peer that has
// not hung up) until the pair is closed.
func script(t *testing.T, p *stdoutPair, frames []frame) (replies func() []MsgType) {
	t.Helper()
	got := make(chan MsgType, 16)
	go func() {
		for {
			ty, _, err := ReadFrame(p.send)
			if err != nil {
				close(got)
				return
			}
			got <- ty
		}
	}()
	go func() {
		for _, f := range frames {
			var err error
			switch {
			case f.eof:
				err = p.w1.Close()
			case f.raw != nil:
				_, err = p.send.Write(f.raw)
			default:
				err = WriteJSON(p.send, f.t, f.v)
			}
			if err != nil {
				return
			}
		}
	}()
	return func() []MsgType {
		p.close()
		var ts []MsgType
		for ty := range got {
			ts = append(ts, ty)
		}
		return ts
	}
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

var goodHello = frame{t: MsgHello, v: Hello{Version: 1, Mode: "push", ResumeProof: true}}

func oneFile(size int64) frame {
	return frame{t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: "f.bin", Size: size, Mode: 0o644}}}}
}

func TestReceiveToWriterRejectsBadStreams(t *testing.T) {
	body := []byte("0123456789")
	start := frame{t: MsgFileStart, v: FileStart{Index: 0, Offset: 0}}
	cases := []struct {
		name    string
		frames  []frame
		refused bool   // a MsgError must be the only reply (no resume state)
		want    string // substring of the error
		outOK   bool   // body bytes may legitimately have reached the writer
	}{
		{"hello wrong type", []frame{{t: MsgManifest, v: Hello{Version: 1}}}, false, "expected message type 1", false},
		{"hello wrong version", []frame{{t: MsgHello, v: Hello{Version: 2}}}, false, "unsupported wire version", false},
		{"hello malformed", []frame{{t: MsgHello, v: "not an object"}}, false, "malformed", false},
		{"garbage before hello (rc noise)", []frame{{raw: []byte("Welcome to host\nLast login: yesterday\n")}}, false, "", false},
		{"manifest wrong type", []frame{goodHello, {t: MsgFileStart, v: Manifest{}}}, false, "expected message type 2", false},
		{"sync hello", []frame{{t: MsgHello, v: Hello{Version: 1, Sync: true}}, oneFile(1)}, true, "sync", false},
		{"delete hello", []frame{{t: MsgHello, v: Hello{Version: 1, Delete: true}}, oneFile(1)}, true, "sync or delete", false},
		{"empty manifest", []frame{goodHello, {t: MsgManifest, v: Manifest{}}}, true, "exactly one regular file", false},
		{"two entries", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: "a", Size: 1}, {Path: "b", Size: 1}}}}}, true, "exactly one", false},
		{"path with slash", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: "dir/a", Size: 1}}}}}, true, "directory", false},
		{"path with backslash", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: `dir\a`, Size: 1}}}}}, true, "directory", false},
		{"path dot", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: ".", Size: 1}}}}}, true, "directory", false},
		{"path dotdot", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: "..", Size: 1}}}}}, true, "directory", false},
		{"path empty", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: "", Size: 1}}}}}, true, "directory", false},
		{"path NUL", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: "a\x00b", Size: 1}}}}}, true, "directory", false},
		{"path too long", []frame{goodHello, {t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: strings.Repeat("a", maxManifestPathBytes+1), Size: 1}}}}}, true, "directory", false},
		{"negative size", []frame{goodHello, oneFile(-1)}, true, "size", false},
		{"filestart wrong type", []frame{goodHello, oneFile(10), {t: MsgFileHash, v: FileStart{}}}, false, "expected message type 4", false},
		{"filestart index 1", []frame{goodHello, oneFile(10), {t: MsgFileStart, v: FileStart{Index: 1}}}, false, "unexpected file start", false},
		{"filestart index -1", []frame{goodHello, oneFile(10), {t: MsgFileStart, v: FileStart{Index: -1}}}, false, "unexpected file start", false},
		{"filestart offset", []frame{goodHello, oneFile(10), {t: MsgFileStart, v: FileStart{Offset: 3}}}, false, "unexpected file start", false},
		{"filestart proof", []frame{goodHello, oneFile(10), {t: MsgFileStart, v: FileStart{PrefixSHA256: sum(nil)}}}, false, "unexpected file start", false},
		{"truncated body", []frame{goodHello, oneFile(10), start, {raw: body[:4]}, {eof: true}}, false, "4 of 10 bytes", true},
		{"hash wrong type", []frame{goodHello, oneFile(10), start, {raw: body}, {t: MsgResult, v: FileHash{SHA256: sum(body)}}}, false, "could not be verified", true},
		{"hash mismatch", []frame{goodHello, oneFile(10), start, {raw: body}, {t: MsgFileHash, v: FileHash{SHA256: sum([]byte("other"))}}}, false, "did not verify", true},
		{"hash wrong index", []frame{goodHello, oneFile(10), start, {raw: body}, {t: MsgFileHash, v: FileHash{Index: 1, SHA256: sum(body)}}}, false, "did not verify", true},
		{"sender error frame", []frame{{t: MsgError, v: WireError{Code: "x", Msg: "remote \x1b[31mboom"}}}, false, "sender reported an error", false},
		{"oversize frame header", []frame{{raw: []byte{1, 0xff, 0xff, 0xff, 0xff}}}, false, "too large", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := newStdoutPair(t)
			replies := script(t, p, c.frames)
			var out bytes.Buffer
			_, err := receiveStdout(t, p, &out)
			if err == nil {
				t.Fatal("accepted, want an error")
			}
			if c.want != "" && !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %q does not contain %q", err, c.want)
			}
			if strings.ContainsRune(err.Error(), 0x1b) {
				t.Fatalf("error carries a raw escape: %q", err)
			}
			got := replies()
			if c.refused {
				if len(got) != 1 || got[0] != MsgError {
					t.Fatalf("receiver replied %v, want exactly one MsgError (no resume state)", got)
				}
			} else {
				for _, ty := range got {
					if ty == MsgError {
						t.Fatalf("receiver replied %v", got)
					}
				}
			}
			if !c.outOK && out.Len() != 0 {
				t.Fatalf("%d bytes reached stdout", out.Len())
			}
			if c.name == "hash mismatch" {
				if len(got) != 2 || got[0] != MsgResume || got[1] != MsgResult {
					t.Fatalf("receiver replied %v, want resume then a failed result", got)
				}
			}
		})
	}
}

// Positive control for the scripted harness: the same frames as the cases
// above, all correct, are accepted.
func TestReceiveToWriterScriptedGoodStream(t *testing.T) {
	body := []byte("0123456789")
	p := newStdoutPair(t)
	replies := script(t, p, []frame{goodHello, oneFile(10), {t: MsgFileStart, v: FileStart{}}, {raw: body},
		{t: MsgFileHash, v: FileHash{SHA256: sum(body)}}})
	var out bytes.Buffer
	if _, err := receiveStdout(t, p, &out); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), body) {
		t.Fatalf("stdout %q", out.Bytes())
	}
	if got := replies(); len(got) != 2 || got[0] != MsgResume || got[1] != MsgResult {
		t.Fatalf("replies %v", got)
	}
}

// A sender from before v0.24.0 ignores the refusal and streams the whole body
// anyway. The receiver must return at once, write nothing, and leave the
// transport for its caller to abort — it must not read (or wait for) the body.
func TestReceiveToWriterReturnsOnRefusalWhileOldSenderKeepsStreaming(t *testing.T) {
	p := newStdoutPair(t)
	big := make([]byte, 8<<20)
	replies := script(t, p, []frame{
		goodHello,
		{t: MsgManifest, v: Manifest{Files: []FileEntry{{Path: "dir/big", Size: int64(len(big))}}}},
		{t: MsgFileStart, v: FileStart{}},
		{raw: big},
	})
	var out bytes.Buffer
	_, err := receiveStdout(t, p, &out)
	if err == nil || !strings.Contains(err.Error(), "exactly one regular file") {
		t.Fatalf("err = %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("%d bytes reached stdout", out.Len())
	}
	if got := replies(); len(got) != 1 || got[0] != MsgError {
		t.Fatalf("replies %v", got)
	}
}

type failingWriter struct {
	n   int
	err error
}

func (w *failingWriter) Write(p []byte) (int, error) {
	if w.n <= 0 {
		return 0, w.err
	}
	if len(p) > w.n {
		k := w.n
		w.n = 0
		return k, w.err
	}
	w.n -= len(p)
	return len(p), nil
}

// A closed stdout (EPIPE) or full disk: the receiver returns promptly with an
// OutputError while the sender still has most of the body to send.
func TestReceiveToWriterOutputFailureReturnsPromptly(t *testing.T) {
	p := newStdoutPair(t)
	big := make([]byte, 64<<20)
	replies := script(t, p, []frame{goodHello, oneFile(int64(len(big))), {t: MsgFileStart, v: FileStart{}}, {raw: big}})
	w := &failingWriter{n: 1000, err: errors.New("broken pipe")}
	_, err := receiveStdout(t, p, w)
	var oe *OutputError
	if !errors.As(err, &oe) || !strings.Contains(err.Error(), "broken pipe") {
		t.Fatalf("err = %v, want OutputError(broken pipe)", err)
	}
	if got := replies(); len(got) != 1 || got[0] != MsgResume {
		t.Fatalf("replies %v, want only the resume state", got)
	}
}
