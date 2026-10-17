package account

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

// The next request may arrive while its predecessor is being confirmed. A
// bounded volatile ciphertext buffer can overlap ingress with that confirmation.
// Neither blob layout nor upload settlement changes under this capability.
const uploadPipelineV1 = "ordered-v1"
const uploadPipelineHeader = "X-Relayium-Upload-Pipeline"
const uploadPipelineMaxWait = 30 * time.Second

func pipelineShare(row UploadSessionRow) bool {
	return row.PairRoomID == "" && (row.Purpose == StoredPurposeShare || row.Purpose == "")
}

func withUploadPipeline(body map[string]any, row UploadSessionRow) map[string]any {
	if pipelineShare(row) {
		body["uploadPipeline"] = uploadPipelineV1
	}
	return body
}

type uploadPipelineWaiter struct {
	changed  chan struct{}
	released chan struct{}
	start    int64
}

// Zero-safe and bounded to one waiter per owned session in this service.
// Entries disappear on every exit, including cancellation and failed reads.
// Another service's progress is discovered by the bounded polling fallback;
// this map is never the authority for offsets, ownership, lifetime or billing.
type uploadPipelineWaiters struct {
	mu      sync.Mutex
	waiting map[string]*uploadPipelineWaiter
	held    int64
	seen    map[string]uploadPipelineSeen
}

func pipelineKey(userID, uploadID string) string { return userID + "\x00" + uploadID }

func (p *uploadPipelineWaiters) acquire(userID, uploadID string, start int64) (*uploadPipelineWaiter, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := pipelineKey(userID, uploadID)
	if w := p.waiting[key]; w != nil {
		return w, false
	}
	if p.waiting == nil {
		p.waiting = make(map[string]*uploadPipelineWaiter)
	}
	w := &uploadPipelineWaiter{changed: make(chan struct{}, 1), released: make(chan struct{}), start: start}
	p.waiting[key] = w
	return w, true
}

func (p *uploadPipelineWaiters) release(userID, uploadID string, w *uploadPipelineWaiter) {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := pipelineKey(userID, uploadID)
	if p.waiting[key] == w {
		delete(p.waiting, key)
		close(w.released)
	}
}

func (p *uploadPipelineWaiters) notify(userID, uploadID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if w := p.waiting[pipelineKey(userID, uploadID)]; w != nil {
		select {
		case w.changed <- struct{}{}:
		default:
		}
	}
}

// awaitUploadOffset never renews a session. A timeout or an
// occupied waiting slot leaves the normal gap response intact. The request's
// original absolute read deadline and context remain in force throughout.
func (s *Service) awaitUploadOffset(ctx context.Context, row UploadSessionRow, start int64, request *http.Request) (UploadSessionRow, bool, error) {
	if !pipelineShare(row) || start <= row.Received || start > row.MaxSize || start-row.Received > maxAppendBytes {
		return row, true, nil
	}
	wait := s.uploadPipelineWaitTimeout
	if wait <= 0 || wait > uploadPipelineMaxWait {
		wait = uploadPipelineMaxWait
	}
	// A predecessor may already be current in SQLite before its waiting
	// goroutine is scheduled. Hand over that occupied slot instead of refusing
	// the next future body and making the client cancel a valid append.
	handover := time.Duration(0)
	w, acquired := s.uploadPipeline.acquire(row.UserID, row.ID, start)
	if !acquired && row.Received >= w.start {
		began := time.Now()
		timer := time.NewTimer(wait)
		select {
		case <-w.released:
			timer.Stop()
			w, acquired = s.uploadPipeline.acquire(row.UserID, row.ID, start)
		case <-ctx.Done():
			timer.Stop()
			return row, false, ctx.Err()
		case <-timer.C:
			return row, true, nil
		}
		handover = time.Since(began)
	}
	if !acquired {
		return row, true, nil
	}
	defer s.uploadPipeline.release(row.UserID, row.ID, w)
	if err := s.uploadPipeline.readAhead(ctx, row, start, request); err != nil {
		return row, false, err
	}
	// Read time is bounded by the original absolute deadline. All queuing,
	// including an occupied-but-current predecessor, shares one 30s budget.
	timer := time.NewTimer(max(0, wait-handover))
	defer timer.Stop()
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	for {
		// Register before the first read so a commit cannot be lost between
		// observing its old offset and beginning to wait for notification.
		fresh, found, err := s.store.GetUploadSession(ctx, row.ID, row.UserID)
		if err != nil {
			return row, false, err
		}
		if !found || fresh.Done {
			return fresh, false, nil
		}
		row = fresh
		if row.Received >= start {
			return row, true, nil
		}
		select {
		case <-ctx.Done():
			return row, false, ctx.Err()
		case <-timer.C:
			return row, true, nil
		case <-w.changed:
		case <-poll.C:
		}
	}
}

const uploadPipelineBufferBudget int64 = 64 << 20
const uploadPipelineSeenLimit = 4096
const uploadPipelineSeenTTL = time.Hour

type uploadPipelineSeen struct {
	start int64
	at    time.Time
}

// Admission remembers failed/cancelled staging too: a client cannot repeatedly
// consume a free chunk of ingress without first advancing a meaningful prefix.
func (p *uploadPipelineWaiters) reserve(row UploadSessionRow, start, size int64, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if start-row.Received < uploadChunkSize || size <= 0 || size > uploadPipelineBufferBudget-p.held {
		return false
	}
	key := pipelineKey(row.UserID, row.ID)
	for k, v := range p.seen {
		if now.Sub(v.at) >= uploadPipelineSeenTTL {
			delete(p.seen, k)
		}
	}
	if old, ok := p.seen[key]; ok && row.Received < old.start {
		return false
	}
	if p.seen == nil {
		p.seen = make(map[string]uploadPipelineSeen)
	}
	if _, exists := p.seen[key]; !exists && len(p.seen) >= uploadPipelineSeenLimit {
		return false
	}
	p.seen[key] = uploadPipelineSeen{start: start, at: now}
	p.held += size
	return true
}
func (p *uploadPipelineWaiters) unreserve(size int64) {
	p.mu.Lock()
	p.held -= size
	p.mu.Unlock()
}

// pipelineReadAhead owns ciphertext only. Read and Close serialize so borrowed
// reader references cannot retain data after its budget reservation is released.
// Constructed ONLY after the ORIGINAL network body returned EOF.
type pipelineReadAhead struct {
	mu          sync.Mutex
	reader      bytes.Reader
	original    io.ReadCloser
	pool        *uploadPipelineWaiters
	reservation int64
	closed      bool
}

func (b *pipelineReadAhead) Read(dst []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return 0, io.ErrClosedPipe
	}
	return b.reader.Read(dst)
}
func (b *pipelineReadAhead) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return nil
	}
	b.closed = true
	b.reader.Reset(nil)
	err := b.original.Close()
	b.original = nil
	b.pool.unreserve(b.reservation)
	return err
}
func (p *uploadPipelineWaiters) readAhead(ctx context.Context, row UploadSessionRow, start int64, request *http.Request) error {
	limit := min(maxAppendBytes, row.MaxSize-start)
	if limit <= 0 {
		return nil
	}
	if request.ContentLength > limit {
		return errTooLarge
	}
	reserve := limit + 1
	if request.ContentLength >= 0 {
		reserve = request.ContentLength + 1
	}
	if !p.reserve(row, start, reserve, time.Now()) {
		return nil
	}
	handedOff := false
	defer func() {
		if !handedOff {
			p.unreserve(reserve)
		}
	}()
	data := make([]byte, int(reserve))
	n := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		count, err := request.Body.Read(data[n:])
		n += count
		if int64(n) > limit || n == len(data) {
			return errTooLarge
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				return err
			}
			if request.ContentLength >= 0 && int64(n) != request.ContentLength {
				return io.ErrUnexpectedEOF
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			request.Body = &pipelineReadAhead{reader: *bytes.NewReader(data[:n]), original: request.Body, pool: p, reservation: reserve}
			handedOff = true
			return nil
		}
	}
}
