package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/relayium/relayium/internal/termtext"
)

// ErrCodeNotSingleFile refuses a stream that is not exactly one regular file,
// sent by ReceiveToWriter in place of the resume state. Additive, like every
// MsgError code: an older sender that does not know it still stops, or (before
// v0.24.0) ignores it and keeps streaming, which the caller must end by
// aborting its transport.
const ErrCodeNotSingleFile = "not_single_file"

// StdoutOpts configures ReceiveToWriter.
type StdoutOpts struct {
	// Progress observes the body as it is written, exactly as RecvOpts.Progress
	// does for one file. It is observational only; nil means no reporting.
	Progress func(path string, written, total int64)
}

// OutputError is a failure of the local writer, not of the peer or the stream.
// The caller can tell it apart (a closed stdout pipe is the ordinary case) and
// report it without blaming the remote.
type OutputError struct{ Err error }

func (e *OutputError) Error() string { return "writing output: " + e.Err.Error() }
func (e *OutputError) Unwrap() error { return e.Err }

// ReceiveToWriter receives exactly one regular file from a v1 sender and writes
// its bytes to w as they arrive. It is the receiving half of `pull host:src -`
// and speaks the unchanged v1 protocol, so every released `__send` can be the
// peer.
//
// It never touches the filesystem. Everything the sender says is checked by
// frame TYPE as well as content, because nothing here may be mistaken for
// payload: a stream that is not one flat, non-negative-size manifest entry is
// refused with a MsgError instead of the resume state, so a conforming sender
// streams no body at all. The body is hashed as it is written and compared with
// the sender's hash at the end.
//
// Bytes already written cannot be taken back. On a truncated stream or a hash
// mismatch the returned error says the output is incomplete or unverified; the
// caller must exit non-zero. On ANY error the caller must also assume the peer
// may still be sending (senders before v0.24.0 ignore a refusal) and end its
// transport without waiting for the peer.
func ReceiveToWriter(rw io.ReadWriter, w io.Writer, opts StdoutOpts) (Report, error) {
	var hello Hello
	if err := readStrict(rw, MsgHello, &hello); err != nil {
		return Report{}, err
	}
	if hello.Version != WireVersion {
		return Report{}, fmt.Errorf("unsupported wire version %d", hello.Version)
	}
	var m Manifest
	if err := readStrict(rw, MsgManifest, &m); err != nil {
		return Report{}, err
	}
	// Refusals from here on are sent to an already-authorized peer (the user's
	// own SSH session started it), in place of the resume state.
	if hello.Sync || hello.Delete {
		return Report{}, refuse(rw, ErrCodeSyncNotAllowed,
			errors.New("the sender asked for sync or delete; writing to stdout accepts neither"))
	}
	if err := validateSingleFile(m); err != nil {
		return Report{}, refuse(rw, ErrCodeNotSingleFile, err)
	}
	f := m.Files[0]
	if err := WriteJSON(rw, MsgResume, ResumeState{}); err != nil {
		return Report{}, err
	}

	var fs FileStart
	if err := readStrict(rw, MsgFileStart, &fs); err != nil {
		return Report{}, err
	}
	if fs.Index != 0 || fs.Offset != 0 || fs.PrefixSHA256 != "" {
		return Report{}, fmt.Errorf("unexpected file start (index %d, offset %d) for a single-file stream", fs.Index, fs.Offset)
	}

	h := sha256.New()
	out := &countingWriter{w: w, path: f.Path, total: f.Size, progress: opts.Progress}
	n, err := io.CopyN(io.MultiWriter(out, h), rw, f.Size)
	if err != nil {
		if out.err != nil {
			return Report{}, &OutputError{Err: out.err}
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return Report{}, fmt.Errorf("the stream ended early: %d of %d bytes were written to stdout; discard that output", n, f.Size)
		}
		return Report{}, fmt.Errorf("the stream failed after %d of %d bytes were written to stdout; discard that output: %w", n, f.Size, err)
	}

	var fh FileHash
	if err := readStrict(rw, MsgFileHash, &fh); err != nil {
		return Report{}, fmt.Errorf("all %d bytes were written to stdout but could not be verified; discard that output: %w", f.Size, err)
	}
	if fh.Index != 0 || fh.SHA256 != hex.EncodeToString(h.Sum(nil)) {
		// Best-effort: let the sender finish with a definite answer.
		_ = WriteJSON(rw, MsgResult, Result{OK: false, Failed: []string{f.Path}})
		return Report{Failed: []string{f.Path}}, fmt.Errorf("the %d bytes written to stdout did not verify (SHA-256 mismatch); discard that output", f.Size)
	}
	// Every byte is out and verified. If the sender can no longer hear that,
	// the output is still complete and correct, so the answer is best-effort.
	_ = WriteJSON(rw, MsgResult, Result{OK: true})
	return Report{Files: 1, Bytes: f.Size}, nil
}

// validateSingleFile accepts exactly one flat manifest entry with a
// non-negative size. `__send` builds its manifest relative to the source's
// PARENT, so a directory source always yields paths with a separator (even a
// directory holding a single file), and a symlink or special-file source yields
// no entries at all. One entry with a bare name therefore means one regular
// file was sent — with one exception this cannot see: a filesystem root whose
// whole tree is one top-level file. The CLI refuses root-shaped source
// arguments before connecting.
func validateSingleFile(m Manifest) error {
	if len(m.Files) != 1 {
		return fmt.Errorf("`pull ... -` needs exactly one regular file; the source has %d (a directory, a symlink, a special file or several files)", len(m.Files))
	}
	f := m.Files[0]
	p := f.Path
	if p == "" || len([]byte(p)) > maxManifestPathBytes || p == "." || p == ".." ||
		strings.ContainsAny(p, "/\\") || strings.ContainsRune(p, 0) {
		return errors.New("`pull ... -` needs exactly one regular file; the source is a directory or not a plain file name")
	}
	if f.Size < 0 {
		return errors.New("invalid manifest size for a single-file stream")
	}
	return nil
}

// readStrict reads one frame, requires its type to be want, and decodes it. A
// MsgError from the peer becomes a *RemoteError. Unlike ReadJSON it never
// decodes a frame of another type as the awaited message, so garbage on the
// channel (a remote shell's start-up output, say) fails before any payload.
func readStrict(r io.Reader, want MsgType, v any) error {
	t, payload, err := ReadFrame(r)
	if err != nil {
		return err
	}
	if t == MsgError {
		// No released sender sends one; if a future one does, show its words
		// (terminal-safe) rather than mislabel them as a receiver's refusal.
		var we WireError
		if err := json.Unmarshal(payload, &we); err != nil || (we.Msg == "" && we.Code == "") {
			return errors.New("the sender reported an error (unreadable error frame)")
		}
		msg := we.Msg
		if msg == "" {
			msg = we.Code
		}
		return errors.New("the sender reported an error: " + termtext.Safe(msg))
	}
	if t != want {
		return fmt.Errorf("protocol error: expected message type %d, got %d", want, t)
	}
	if err := json.Unmarshal(payload, v); err != nil {
		return fmt.Errorf("protocol error: malformed message type %d: %w", want, err)
	}
	return nil
}

// countingWriter forwards to w, remembers w's first error (so the caller can
// tell an output failure from a stream failure) and reports progress.
type countingWriter struct {
	w        io.Writer
	path     string
	total    int64
	written  int64
	err      error
	progress func(path string, written, total int64)
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	if err == nil && n < len(p) {
		err = io.ErrShortWrite
	}
	c.written += int64(n)
	if err != nil {
		c.err = err
		return n, err
	}
	if c.progress != nil && n > 0 {
		c.progress(c.path, c.written, c.total)
	}
	return n, nil
}
