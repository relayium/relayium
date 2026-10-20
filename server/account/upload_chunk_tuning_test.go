package account

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// Opt-in local fixture. Experimental chunk/append limits apply only to this
// test process; production defaults and safety tests remain unchanged.
type chunkTuningRecorder struct {
	*httptest.ResponseRecorder
	real http.ResponseWriter
}

func (w *chunkTuningRecorder) Unwrap() http.ResponseWriter { return w.real }

type chunkTuningBody struct {
	io.ReadCloser
	delay    time.Duration
	throttle *sync.Mutex
	bytes    int64
	corrupt  bool
}

func (b *chunkTuningBody) Read(dst []byte) (int, error) {
	if len(dst) > 64<<10 {
		dst = dst[:64<<10]
	}
	n, e := b.ReadCloser.Read(dst)
	if b.corrupt && b.bytes == 0 && n > 8 {
		dst[8] ^= 1
	}
	b.bytes += int64(n)
	if n > 0 && b.delay > 0 {
		b.throttle.Lock()
		time.Sleep(time.Duration(n) * b.delay / (64 << 10))
		b.throttle.Unlock()
	}
	return n, e
}

type chunkTuningStore struct {
	storage.BlobStore
	delay atomic.Int64
	nanos atomic.Int64
	calls atomic.Int64
}

func (b *chunkTuningStore) Append(ctx context.Context, key string, start int64, body io.Reader) (int64, error) {
	began := time.Now()
	n, e := b.BlobStore.Append(ctx, key, start, body)
	b.nanos.Add(time.Since(began).Nanoseconds())
	b.calls.Add(1)
	if e == nil && b.delay.Load() > 0 {
		select {
		case <-time.After(time.Duration(b.delay.Load())):
		case <-ctx.Done():
			return n, ctx.Err()
		}
	}
	return n, e
}
func TestUploadChunkTuningFixture(t *testing.T) {
	home := os.Getenv("RELAYIUM_CHUNK_TUNING_HOME")
	if home == "" {
		t.Skip("opt-in native upload tuning fixture")
	}
	h := newDurHarness(t)
	h.svc.cfg.MaxFileSize = 512 << 20
	h.svc.cfg.DailyQuota = 16 << 30
	bs := &chunkTuningStore{BlobStore: h.disk}
	h.svc.SetBlobStore(bs)
	backend := h.svc.Routes()
	oldLimit := maxAppendBytes
	t.Cleanup(func() { maxAppendBytes = oldLimit })
	var mu, throttle sync.Mutex
	chunk := 8 << 20
	bodyDelay := time.Duration(0)
	serial := false
	native := false
	trial := 0
	active, peak, inits, finals, patches := 0, 0, 0, 0, 0
	drops := 0
	var reads int64
	var statuses []int
	stop := make(chan struct{})
	var once sync.Once
	reply := func(w http.ResponseWriter, r *httptest.ResponseRecorder) {
		for k, v := range r.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(r.Code)
		_, _ = w.Write(r.Body.Bytes())
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bench/stop":
			once.Do(func() { close(stop) })
			w.WriteHeader(200)
			return
		case "/bench/reset":
			var opts struct {
				ChunkMiB int  `json:"chunkMiB"`
				BodyUS   int  `json:"bodyUS"`
				AckMS    int  `json:"ackMS"`
				Serial   bool `json:"serial"`
				Native   bool `json:"native"`
			}
			if json.NewDecoder(r.Body).Decode(&opts) != nil || (opts.ChunkMiB != 8 && opts.ChunkMiB != 16 && opts.ChunkMiB != 32) || opts.BodyUS < 0 || opts.BodyUS > 8000 || opts.AckMS < 0 || opts.AckMS > 1000 {
				http.Error(w, "bad experiment", 400)
				return
			}
			mu.Lock()
			if active != 0 {
				mu.Unlock()
				http.Error(w, "active requests", 409)
				return
			}
			trial++
			chunk = opts.ChunkMiB << 20
			maxAppendBytes = int64(2 * chunk)
			native = opts.Native
			if native {
				maxAppendBytes = oldLimit
			}
			serial = opts.Serial
			bodyDelay = time.Duration(opts.BodyUS) * time.Microsecond
			bs.delay.Store(int64(time.Duration(opts.AckMS) * time.Millisecond))
			bs.nanos.Store(0)
			bs.calls.Store(0)
			peak = 0
			inits = 0
			finals = 0
			patches = 0
			drops = 0
			reads = 0
			statuses = nil
			mu.Unlock()
			email := fmt.Sprintf("tuning-%d@example.test", trial)
			h.cookie = loginCookie(t, h.ts, h.svc.mailer.(*capturingMailer), email)
			user, e := h.st.UpsertUserByEmail(context.Background(), email, "")
			if e != nil {
				http.Error(w, "fixture user", 500)
				return
			}
			h.userID = user.ID
			_ = json.NewEncoder(w).Encode(map[string]any{"cookie": h.cookie.Name + "=" + h.cookie.Value, "trial": trial})
			return
		case "/bench/stats":
			mu.Lock()
			defer mu.Unlock()
			h.svc.uploadPipeline.mu.Lock()
			held := h.svc.uploadPipeline.held
			waiters := len(h.svc.uploadPipeline.waiting)
			h.svc.uploadPipeline.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"active": active, "peak": peak, "inits": inits, "finals": finals, "patches": patches, "bodyBytes": reads, "statuses": statuses, "meter": h.meter(t), "appendWallMs": float64(bs.nanos.Load()) / 1e6, "appendCalls": bs.calls.Load(), "heldBytes": held, "waiters": waiters, "chunkTarget": chunk, "appendLimit": maxAppendBytes, "droppedAnswers": drops})
			return
		}
		if r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/api/uploads/") {
			mu.Lock()
			active++
			if active > peak {
				peak = active
			}
			delay := bodyDelay
			mu.Unlock()
			body := &chunkTuningBody{ReadCloser: r.Body, delay: delay, throttle: &throttle, corrupt: r.Header.Get("X-Tuning-Fault") == "corrupt"}
			r.Body = body
			rec := &chunkTuningRecorder{ResponseRecorder: httptest.NewRecorder(), real: w}
			backend.ServeHTTP(rec, r)
			mu.Lock()
			active--
			patches++
			reads += body.bytes
			statuses = append(statuses, rec.Code)
			mu.Unlock()
			if r.Header.Get("X-Tuning-Fault") == "drop-ack" && strings.HasPrefix(r.Header.Get("Content-Range"), "bytes 0-") && rec.Code == 200 {
				conn, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					mu.Lock()
					drops++
					mu.Unlock()
					_ = conn.Close()
					return
				}
			}
			reply(w, rec.ResponseRecorder)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/api/uploads" {
			mu.Lock()
			negotiated := native
			mu.Unlock()
			if !negotiated {
				r.Header.Del("X-Relayium-Upload-Chunk")
			}
			rec := httptest.NewRecorder()
			backend.ServeHTTP(rec, r)
			mu.Lock()
			inits++
			selected := chunk
			noPipeline := serial
			mu.Unlock()
			if rec.Code != 200 {
				reply(w, rec)
				return
			}
			var body map[string]any
			if json.Unmarshal(rec.Body.Bytes(), &body) != nil {
				http.Error(w, "bad init", 500)
				return
			}
			if !negotiated {
				body["chunkSize"] = selected
			}
			mu.Lock()
			if negotiated {
				chunk = int(body["chunkSize"].(float64))
			} else {
				chunk = selected
			}
			mu.Unlock()
			if noPipeline {
				delete(body, "uploadPipeline")
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(body)
			return
		}
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/finalize") {
			mu.Lock()
			finals++
			mu.Unlock()
		}
		backend.ServeHTTP(w, r)
	}))
	defer ts.Close()
	if e := os.WriteFile(filepath.Join(home, "PORT.json"), []byte(fmt.Sprintf(`{"url":%q,"pid":%d}`, ts.URL, os.Getpid())), 0600); e != nil {
		t.Fatal(e)
	}
	select {
	case <-stop:
	case <-time.After(20 * time.Minute):
		t.Fatal("bounded fixture expired")
	}
}
