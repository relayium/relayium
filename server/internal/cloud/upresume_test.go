package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func preparedSpool(t *testing.T, server string, body []byte) (string, UpOperation, []byte, string) {
	t.Helper()
	dir := t.TempDir()
	source := filepath.Join(t.TempDir(), "data.bin")
	if err := os.WriteFile(source, body, 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := PrepareUpload([]string{source}, UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	op, err := NewUpOperation(p, server, "a@example.com", time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	if err = SpoolUpOperation(dir, &op, p); err != nil {
		t.Fatal(err)
	}
	if err = SaveUpOperation(dir, op); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(upSpoolPath(dir, op.ID))
	if err != nil {
		t.Fatal(err)
	}
	return dir, op, raw, source
}

func TestSpoolUpOperationRejectsInvalidRecordBeforeFilesystemWrites(t *testing.T) {
	source := filepath.Join(t.TempDir(), "data.bin")
	if err := os.WriteFile(source, []byte("private payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := PrepareUpload([]string{source}, UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	op, err := NewUpOperation(p, "https://example.test", "a@example.com", time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"../outside", "", "not-an-operation-id"} {
		t.Run(id, func(t *testing.T) {
			bad := op
			bad.ID = id
			dir := filepath.Join(t.TempDir(), "not-created")
			if err := SpoolUpOperation(dir, &bad, p); err != ErrUpOperationCorrupt {
				t.Fatalf("invalid record: %v", err)
			}
			if _, err := os.Lstat(dir); !os.IsNotExist(err) {
				t.Fatalf("invalid record touched filesystem: %v", err)
			}
		})
	}
}

func TestResumableUpSurvivesPartialAndLostFinalizeAcrossClients(t *testing.T) {
	var received []byte
	var partial = true
	var finalized bool
	patches, finalizes := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/uploads":
			_ = json.NewEncoder(w).Encode(map[string]any{"uploadId": "session1", "chunkSize": 1 << 20})
		case r.Method == "GET":
			_ = json.NewEncoder(w).Encode(map[string]int{"received": len(received)})
		case r.Method == "PATCH":
			patches++
			body, _ := io.ReadAll(r.Body)
			var from, to, total int
			_, err := fmt.Sscanf(r.Header.Get("Content-Range"), "bytes %d-%d/%d", &from, &to, &total)
			if err != nil || from != len(received) {
				t.Errorf("offset does not match durable prefix: %s", r.Header.Get("Content-Range"))
				http.Error(w, "bad range", 409)
				return
			}
			if partial {
				partial = false
				received = append(received, body[:len(body)/2]...)
				http.Error(w, "lost patch", 502)
				return
			}
			received = append(received, body...)
			_ = json.NewEncoder(w).Encode(map[string]int{"received": len(received)})
		case r.Method == "POST":
			finalizes++
			if !finalized {
				finalized = true
				http.Error(w, "lost finalize", 502)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "object1", "expiresAt": time.Now().Unix() + 300, "recovered": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	dir, op, raw, src := preparedSpool(t, srv.URL, bytes.Repeat([]byte("private payload"), 40000))
	c := NewClient(srv.URL)
	c.Token = "synthetic"
	if _, _, err := c.ResumeUpOperation(context.Background(), dir, &op); err == nil {
		t.Fatal("lost PATCH reported success")
	}
	if len(received) == 0 || op.Phase != "uploading" {
		t.Fatal("did not retain partial session")
	}
	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}
	op2, err := LoadUpOperation(dir, op.ID)
	if err != nil {
		t.Fatal(err)
	}
	c = NewClient(srv.URL)
	c.Token = "synthetic"
	if _, _, err = c.ResumeUpOperation(context.Background(), dir, &op2); err == nil {
		t.Fatal("lost finalize reported success")
	}
	if op2.Phase != "finalizing" || !bytes.Equal(received, raw[op.HeaderBytes:]) {
		t.Fatal("resume did not preserve exact ciphertext")
	}
	count := patches
	op3, err := LoadUpOperation(dir, op.ID)
	if err != nil {
		t.Fatal(err)
	}
	c = NewClient(srv.URL)
	c.Token = "synthetic"
	id, _, err := c.ResumeUpOperation(context.Background(), dir, &op3)
	if err != nil || id != "object1" || patches != count || finalizes != 2 {
		t.Fatalf("finalize replay uploaded or failed: %v", err)
	}
}

func TestResumableFinalizeRequiresUsableClaimID(t *testing.T) {
	for _, size := range []int{128, 129} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			id := strings.Repeat("a", size)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/uploads/session1/finalize" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "expiresAt": time.Now().Unix() + 300})
			}))
			defer srv.Close()
			dir, op, _, _ := preparedSpool(t, srv.URL, []byte("payload"))
			op.Phase, op.UploadID, op.ChunkSize = "finalizing", "session1", 1<<20
			if err := SaveUpOperation(dir, op); err != nil {
				t.Fatal(err)
			}
			got, _, err := NewClient(srv.URL).ResumeUpOperation(context.Background(), dir, &op)
			if size == 128 {
				if err != nil || got != id {
					t.Fatalf("valid claim ID rejected: %q %v", got, err)
				}
			} else {
				if err == nil || got != "" {
					t.Fatalf("unusable claim ID accepted: %q %v", got, err)
				}
				if _, err := LoadUpOperation(dir, op.ID); err != nil {
					t.Fatalf("recovery record lost: %v", err)
				}
				if _, err := os.Stat(upSpoolPath(dir, op.ID)); err != nil {
					t.Fatalf("recovery ciphertext lost: %v", err)
				}
			}
		})
	}
}

func TestResumableFinalizeExplainsKnownOutcomesAndKeepsRecovery(t *testing.T) {
	for _, tc := range []struct {
		outcome, body, message string
		status                 int
	}{
		{"running", `{"error":"already_finalized","outcome":"running"}`, "retry later", 409},
		{"failed", `{"error":"already_finalized","outcome":"failed"}`, "account file list", 409},
		{"expired", `{"error":"already_finalized","outcome":"expired"}`, "expired", 409},
		{"removed", `{"error":"already_finalized","outcome":"removed"}`, "removed", 409},
		{"notfound", "not found", "does not prove", 404},
		{"untrusted", `{"error":"other","outcome":"running"}`, "unexpected status 409", 409},
	} {
		t.Run(tc.outcome, func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()
			dir, op, _, _ := preparedSpool(t, srv.URL, []byte("payload"))
			op.Phase, op.UploadID, op.ChunkSize = "finalizing", "session1", 1<<20
			if err := SaveUpOperation(dir, op); err != nil {
				t.Fatal(err)
			}
			id, _, err := NewClient(srv.URL).ResumeUpOperation(context.Background(), dir, &op)
			var httpErr *HTTPError
			if id != "" || err == nil || !strings.Contains(err.Error(), tc.message) || !errors.As(err, &httpErr) || httpErr.Status != tc.status {
				t.Fatalf("outcome not explained or HTTP identity lost: id=%q err=%v", id, err)
			}
			if calls.Load() != 1 {
				t.Fatal("finalize failure triggered another request")
			}
			if _, err := LoadUpOperation(dir, op.ID); err != nil {
				t.Fatalf("recovery record lost: %v", err)
			}
			if _, err := os.Stat(upSpoolPath(dir, op.ID)); err != nil {
				t.Fatalf("recovery ciphertext lost: %v", err)
			}
		})
	}
}

func TestResumableUpRefusesDamagedCopyOrKeyBeforeNetwork(t *testing.T) {
	for _, mode := range []string{"ciphertext", "key", "header", "summary"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; http.Error(w, "unexpected", 500) }))
			defer srv.Close()
			dir, op, raw, _ := preparedSpool(t, srv.URL, []byte("payload"))
			switch mode {
			case "ciphertext":
				raw[len(raw)-1] ^= 1
				if err := os.WriteFile(upSpoolPath(dir, op.ID), raw, 0o600); err != nil {
					t.Fatal(err)
				}
			case "key":
				op.ContentKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
			case "header":
				op.HeaderBytes++
			case "summary":
				op.TotalBytes--
			}
			c := NewClient(srv.URL)
			if _, _, err := c.ResumeUpOperation(context.Background(), dir, &op); err == nil || calls != 0 {
				t.Fatalf("damaged state reached network: %v calls%d", err, calls)
			}
		})
	}
}

func TestResumableUpRefusesReplacedSourceBeforeEncryption(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	if err := os.WriteFile(src, []byte("AAAA"), 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := PrepareUpload([]string{src}, UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	op, err := NewUpOperation(p, "https://relayium.test", "a@example.com", time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(src)
	if err != nil {
		t.Fatal(err)
	}
	replacement := src + ".new"
	if err = os.WriteFile(replacement, []byte("BBBB"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(replacement, src); err != nil {
		t.Fatal(err)
	}
	if err = SpoolUpOperation(t.TempDir(), &op, p); err == nil {
		t.Fatal("equal size/time replacement accepted")
	}
}

func TestResumableUpDoesNotReplaceDeadSessionOrTrustInvalidOffset(t *testing.T) {
	for _, mode := range []string{"missing", "negative", "past-end", "missing-offset"} {
		t.Run(mode, func(t *testing.T) {
			gets, mutations := 0, 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					mutations++
					http.Error(w, "unexpected mutation", 500)
					return
				}
				gets++
				switch mode {
				case "missing":
					http.Error(w, "reaped", 404)
				case "negative":
					fmt.Fprint(w, `{"received":-1}`)
				case "past-end":
					fmt.Fprint(w, `{"received":999999}`)
				default:
					fmt.Fprint(w, `{}`)
				}
			}))
			defer srv.Close()
			dir, op, raw, _ := preparedSpool(t, srv.URL, []byte("payload"))
			op.Phase, op.UploadID, op.ChunkSize = "uploading", "session1", 1024
			if err := SaveUpOperation(dir, op); err != nil {
				t.Fatal(err)
			}
			if _, _, err := NewClient(srv.URL).ResumeUpOperation(context.Background(), dir, &op); err == nil {
				t.Fatal("unusable session accepted")
			}
			restored, err := LoadUpOperation(dir, op.ID)
			got, copyErr := os.ReadFile(upSpoolPath(dir, op.ID))
			if gets != 1 || mutations != 0 || err != nil || restored.UploadID != "session1" || restored.ContentKey != op.ContentKey || copyErr != nil || !bytes.Equal(raw, got) {
				t.Fatalf("dead/invalid session replaced or forgotten: gets=%d mutations=%d load=%v copy=%v", gets, mutations, err, copyErr)
			}
		})
	}
}

func TestResumableRequestNeverFollowsCredentialRedirect(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1); fmt.Fprint(w, `{}`) }))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer origin.Close()
	c := NewClient(origin.URL)
	c.Token = "synthetic-secret"
	var result map[string]any
	if err := c.resumeJSON(context.Background(), "PATCH", "/api/uploads/session1", []byte("payload"), "", &result); err == nil || forwarded.Load() != 0 {
		t.Fatalf("redirect followed: %v forwards=%d", err, forwarded.Load())
	}
}

func TestResumableRequestWaitsForSlowLinkAndBoundsSilentAnswer(t *testing.T) {
	t.Run("healthy slow HTTP2 link", func(t *testing.T) {
		const rate = 1 << 20
		srv := slowReaderServer(t, rate)
		c := newClientWith(srv.URL, srv.Client().Transport.(*http.Transport), clientTimeouts{responseHeader: 30 * time.Millisecond, confirmBase: 100 * time.Millisecond, confirmMinRate: rate / 4})
		c.idleTimeout = time.Second
		var result struct {
			ID string `json:"id"`
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := c.resumeJSON(ctx, "PATCH", "/api/uploads/session1", make([]byte, 4<<20), "", &result); err != nil || result.ID != "slow1" {
			t.Fatalf("healthy link failed: %v", err)
		}
	})
	t.Run("silent confirmation", func(t *testing.T) {
		release := make(chan struct{})
		var requests atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			_, _ = io.Copy(io.Discard, r.Body)
			<-release
		}))
		defer srv.Close()
		defer close(release)
		c := newClientWith(srv.URL, http.DefaultTransport.(*http.Transport), clientTimeouts{responseHeader: time.Minute, confirmBase: 40 * time.Millisecond, confirmMinRate: 1 << 20})
		c.idleTimeout = time.Second
		var result map[string]any
		started := time.Now()
		if err := c.resumeJSON(context.Background(), "PATCH", "/api/uploads/session1", []byte("payload"), "", &result); err == nil {
			t.Fatal("silent peer reported success")
		}
		if time.Since(started) > time.Second || requests.Load() != 1 {
			t.Fatal("silent peer unbounded or retried")
		}
	})
}
