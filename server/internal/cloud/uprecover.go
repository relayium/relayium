package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// RecoverState is a definitive recovery answer.
type RecoverState int

const (
	// RecoveredCommitted: the server holds the upload made under this key; ID
	// and ExpiresAt are its own.
	RecoveredCommitted RecoverState = iota + 1
	// RecoveredGone: the server did store it, and it no longer exists (expired,
	// deleted, or its download limit was used). It is never created again.
	RecoveredGone
	// RecoveredConflict: the server knows the key for a DIFFERENT request
	// (other retention parameters or length) -- the record does not describe
	// what was sent under it.
	RecoveredConflict
)

// RecoverResult is RecoverUpload's definitive answer.
type RecoverResult struct {
	State     RecoverState
	ID        string
	ExpiresAt int64
}

// UploadRecoveryUnknownError means recovery could not establish the outcome.
// It never means "the upload does not exist": a request for the body, a
// timeout or an unexpected status only says the server did not CONFIRM the
// upload to a probe that sends no data. The server may hold it (a proxy or an
// older server may still have asked for the body), may never have received
// all of it, or the original request may still be in flight.
type UploadRecoveryUnknownError struct {
	// BodyRequested: the body was asked for before any answer arrived. That
	// is not proof the upload is absent. The body was not sent.
	BodyRequested bool
	Status        int
	Err           error
}

func (e *UploadRecoveryUnknownError) Error() string {
	switch {
	case e.BodyRequested && e.Status == 0:
		return "the server did not confirm this upload without being sent the data again -- it may hold it, may never have received all of it, " +
			"the original upload may still be in progress, or the server may not support recovering uploads. Nothing was uploaded again"
	case e.Status != 0:
		return fmt.Sprintf("the server answered HTTP %d instead of the outcome of this upload; nothing was uploaded again", e.Status)
	case e.Err != nil:
		return "the server could not be asked about this upload (" + e.Err.Error() + "); nothing was uploaded again"
	default:
		return "the outcome of this upload is still unknown; nothing was uploaded again"
	}
}

func (e *UploadRecoveryUnknownError) Unwrap() error { return e.Err }

// errProbeBodyRequested is what the probe body returns when it is read.
var errProbeBodyRequested = errors.New("recovery probe: the server asked for the upload body")

// probeBody is the recovery request's body. It never yields a byte. When the
// transport asks for it -- after an early "100 Continue", which a proxy may send
// on its own before the origin has decided anything -- it records the request
// and then BLOCKS until the request ends (Close) or the recovery's bounded
// context is done. Blocking instead of failing at once leaves the connection
// open for the origin's own answer: a replayed confirmation can still arrive
// while the body is "being written", and no byte of it ever is.
type probeBody struct {
	requested *atomic.Bool
	ctx       context.Context
	done      chan struct{}
	once      *sync.Once
}

func newProbeBody(ctx context.Context, requested *atomic.Bool) probeBody {
	return probeBody{requested: requested, ctx: ctx, done: make(chan struct{}), once: &sync.Once{}}
}

func (b probeBody) Read([]byte) (int, error) {
	b.requested.Store(true)
	select {
	case <-b.done:
	case <-b.ctx.Done():
	}
	return 0, errProbeBodyRequested
}

func (b probeBody) Close() error {
	b.once.Do(func() { close(b.done) })
	return nil
}

// recoverTimeout bounds a whole recovery probe: connect, the wait for an answer
// while the (refused) body is pending, and reading the answer. A server that
// never answers without the body -- no completed upload yet, or one that
// predates idempotent uploads -- ends here as UNKNOWN, with the record kept.
var recoverTimeout = 30 * time.Second

// recoverExpectContinueWait is how long a recovery waits for the server's
// answer before the transport would start sending the body (which the probe
// body then refuses). Generous: an answer that arrives later is still read.
var recoverExpectContinueWait = 30 * time.Second

// RecoverUpload asks the server for the outcome of the upload made under opKey
// with these retention options and this exact body length, without sending a
// body. It relies on the server answering a key it has committed BEFORE it
// reads the body: the request carries "Expect: 100-continue", and a server
// that wants the body instead gets a body that refuses to be read.
//
// Only a 200 marked Idempotent-Replay, a 410 or a 422 is definitive; anything
// else, including a request for the body, is an UploadRecoveryUnknownError.
func (c *Client) RecoverUpload(ctx context.Context, opKey string, opts UploadOpts, bodyLength int64) (RecoverResult, error) {
	if err := checkSecureServer(c.Server); err != nil {
		return RecoverResult{}, err
	}
	if !upOpKeyPattern.MatchString(opKey) || bodyLength <= 0 {
		return RecoverResult{}, errors.New("recover: invalid operation")
	}
	ctx, cancel := context.WithTimeout(ctx, recoverTimeout)
	defer cancel()
	var requested atomic.Bool
	reqURL := c.Server + "/api/files"
	if q := uploadQuery(opts); q != "" {
		reqURL += "?" + q
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, nil)
	if err != nil {
		return RecoverResult{}, err
	}
	body := newProbeBody(ctx, &requested)
	defer body.Close()
	req.Body = body
	req.GetBody = nil // never replayable: no transport-level retry of the body
	req.ContentLength = bodyLength
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Idempotency-Key", opKey)
	req.Header.Set("Expect", "100-continue")

	resp, err := c.recoverClient().Do(req)
	if err != nil {
		// No answer at all. If the body was asked for, that is the likely
		// reason (nothing completed under this key yet, or a server that
		// ignores the key); either way the outcome is unknown.
		return RecoverResult{}, &UploadRecoveryUnknownError{BodyRequested: requested.Load(), Err: err}
	}
	defer resp.Body.Close()
	// An answer arrived. The probe body never yields a byte, so whatever the
	// transport did with it, nothing was uploaded: a definitive answer below
	// counts even if the body was asked for first (an early 100 Continue from
	// a proxy, or from the origin itself).
	switch {
	case resp.StatusCode == http.StatusOK && resp.Header.Get("Idempotent-Replay") == "true":
		var out struct {
			ID        string `json:"id"`
			ExpiresAt int64  `json:"expiresAt"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, maxConfirmBody)).Decode(&out); err != nil || !usableID.MatchString(out.ID) {
			return RecoverResult{}, &UploadRecoveryUnknownError{Status: resp.StatusCode, Err: errors.New("unreadable answer")}
		}
		return RecoverResult{State: RecoveredCommitted, ID: out.ID, ExpiresAt: out.ExpiresAt}, nil
	case resp.StatusCode == http.StatusGone:
		return RecoverResult{State: RecoveredGone}, nil
	case resp.StatusCode == http.StatusUnprocessableEntity:
		return RecoverResult{State: RecoveredConflict}, nil
	default:
		return RecoverResult{}, &UploadRecoveryUnknownError{Status: resp.StatusCode, BodyRequested: requested.Load()}
	}
}

// recoverClient is the HTTP client for a recovery probe: the upload transport
// with a long Expect-Continue wait. A caller that replaced HTTP keeps it.
func (c *Client) recoverClient() *http.Client {
	if c.HTTP != nil && c.HTTP != c.stdHTTP {
		return c.HTTP
	}
	if c.recoverHTTP != nil {
		return c.recoverHTTP
	}
	return http.DefaultClient
}

// SetRecoverTimeoutForTest replaces recoverTimeout and returns the old value.
// Tests only.
func SetRecoverTimeoutForTest(d time.Duration) time.Duration {
	old := recoverTimeout
	recoverTimeout = d
	return old
}
