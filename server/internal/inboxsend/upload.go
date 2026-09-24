package inboxsend

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/relayium/relayium/internal/storecrypto"
)

// The upload loop (invariant N4). Ciphertext is produced exactly once, by one
// pass over the sources in item order through the sealer, into a packing buffer
// of one server chunk plus one frame. Bytes leave the buffer only when the
// server acknowledges them. A lost acknowledgement, a dropped connection or a
// 409 with the real offset is answered by re-sending bytes still in the buffer —
// a byte-identical copy — or, when the server's offset lies outside what the
// buffer holds, by failing. Nothing is ever re-read and re-sealed.

// frameSource yields the delivery's frames in order: each planned file is read
// once, in ChunkSize pieces, and each piece is sealed at the next seq as it is
// pulled. Only one source file is open at a time.
type frameSource struct {
	files []planFile
	s     *sealer
	idx   int
	cur   *sourceReader
	buf   []byte
}

func newFrameSource(files []planFile, s *sealer) *frameSource {
	return &frameSource{files: files, s: s, buf: make([]byte, storecrypto.ChunkSize)}
}

// next returns the next frame, or io.EOF once every file has been read.
func (g *frameSource) next() ([]byte, error) {
	for {
		if g.cur == nil {
			if g.idx >= len(g.files) {
				return nil, io.EOF
			}
			r, err := openSource(g.files[g.idx])
			if err != nil {
				return nil, err
			}
			g.idx++
			g.cur = r
		}
		pt, err := g.cur.read(g.buf)
		if err == io.EOF {
			g.cur.close()
			g.cur = nil
			continue
		}
		if err != nil {
			return nil, err
		}
		return g.s.frame(pt)
	}
}

// close releases an open source, if any.
func (g *frameSource) close() {
	if g.cur != nil {
		g.cur.close()
		g.cur = nil
	}
}

// uploadRetryBudget bounds consecutive failed attempts that made no progress.
const uploadRetryBudget = 6

// uploadBackoff is overridable by tests.
var uploadBackoff = func(attempt int) time.Duration {
	return min(250*time.Millisecond<<attempt, 5*time.Second)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ensureEmptyBlob sends one zero-byte append at offset 0 to an upload that
// has committed nothing, so its blob exists before finalize. Transport
// failures and 5xx are retried within uploadRetryBudget; a server that already
// holds bytes for it is a desync, a missing session is errUploadLost, and any
// other answer is definitive.
func ensureEmptyBlob(ctx context.Context, c *Client, uploadID string) error {
	for failures := 0; ; {
		got, err := c.Append(ctx, uploadID, 0, 0, nil)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		switch {
		case err == nil && got == 0:
			return nil
		case err == nil, statusOf(err) == http.StatusConflict:
			return errUploadDesync
		case statusOf(err) == http.StatusNotFound:
			return errUploadLost
		case isTransport(err) || statusOf(err) >= 500:
			failures++
			if failures > uploadRetryBudget {
				return err
			}
			if serr := sleepCtx(ctx, uploadBackoff(failures-1)); serr != nil {
				return serr
			}
		default:
			return err
		}
	}
}

// errUploadLost: the session is gone (reaped/expired) before finalize.
var errUploadLost = errors.New("upload session is gone")

// errUploadDesync: the server's offset is outside the bytes still held.
var errUploadDesync = errors.New("server offset outside the held ciphertext")

// streamUpload pushes the whole frame stream of total bytes into uploadID.
// next is pulled lazily as the buffer drains.
func streamUpload(ctx context.Context, c *Client, uploadID string, chunk, total int64, next func() ([]byte, error)) error {
	var (
		buf       []byte // ciphertext [bufStart, bufStart+len(buf))
		bufStart  int64
		exhausted bool
		failures  int
	)
	fill := func() error {
		for !exhausted && int64(len(buf)) < chunk {
			fr, err := next()
			if err == io.EOF {
				exhausted = true
				return nil
			}
			if err != nil {
				return err
			}
			if bufStart+int64(len(buf))+int64(len(fr)) > total {
				return errSourceChanged // more ciphertext than planned
			}
			buf = append(buf, fr...)
		}
		return nil
	}
	// adopt moves the acknowledged boundary to n, which must lie inside the
	// held window: anything else would need bytes already discarded or never
	// produced, and the only honest answer is to stop.
	adopt := func(n int64) error {
		if n < bufStart || n > bufStart+int64(len(buf)) {
			return errUploadDesync
		}
		progressed := n > bufStart
		buf = buf[n-bufStart:]
		bufStart = n
		if progressed {
			failures = 0
		}
		return nil
	}
	retryable := func(err error) error {
		failures++
		if failures > uploadRetryBudget {
			return err
		}
		if serr := sleepCtx(ctx, uploadBackoff(failures-1)); serr != nil {
			return serr
		}
		n, serr := c.UploadStatus(ctx, uploadID)
		switch {
		case serr == nil:
			return adopt(n)
		case statusOf(serr) == http.StatusNotFound:
			return errUploadLost
		case isTransport(serr) || statusOf(serr) >= 500:
			return nil // try the append again; the next failure asks again
		default:
			return serr
		}
	}

	if total == 0 {
		// An all-empty delivery has no frame to send, so no append would ever
		// create its blob. One zero-byte append creates it (every server build's
		// append opens the key at offset 0), so the object this upload becomes
		// is readable by every server build — including one that finalizes it,
		// or reads it, without W-N40's own materialization (a rollback). The
		// source is proven empty first: a frame here means the files changed.
		if err := fill(); err != nil {
			return err
		}
		if len(buf) != 0 {
			return errSourceChanged
		}
		if err := ensureEmptyBlob(ctx, c, uploadID); err != nil {
			return err
		}
	}
	for {
		if err := fill(); err != nil {
			return err
		}
		if bufStart == total && len(buf) == 0 {
			break
		}
		if len(buf) == 0 {
			// Every byte produced is acknowledged but fewer than planned exist.
			return errSourceChanged
		}
		n := min(int64(len(buf)), chunk)
		start := bufStart
		got, err := c.Append(ctx, uploadID, start, total, buf[:n])
		if ctx.Err() != nil {
			return ctx.Err()
		}
		switch {
		case err == nil:
			if aerr := adopt(got); aerr != nil {
				return aerr
			}
		case statusOf(err) == http.StatusConflict:
			var ae *APIError
			if !errors.As(err, &ae) || ae.Received < 0 {
				return err
			}
			if aerr := adopt(ae.Received); aerr != nil {
				return aerr
			}
		case statusOf(err) == http.StatusNotFound:
			return errUploadLost
		case isTransport(err) || statusOf(err) >= 500:
			if rerr := retryable(err); rerr != nil {
				return rerr
			}
			continue
		default:
			return err // 400/401/403/413/429/507/redirect: definitive
		}
		if bufStart == start {
			// An answer that acknowledged nothing new: counted, so a server that
			// keeps acknowledging nothing cannot hold the loop forever.
			if rerr := retryable(errors.New("the server acknowledged no progress")); rerr != nil {
				return rerr
			}
		}
	}
	// The asymmetric-truncation guard: the source must be provably exhausted.
	if !exhausted {
		if _, err := next(); err != io.EOF {
			if err == nil {
				return errSourceChanged
			}
			return err
		}
	}
	return nil
}
