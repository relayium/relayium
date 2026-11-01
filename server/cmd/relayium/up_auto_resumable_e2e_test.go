//go:build !windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/cloud"
)

// A gateway can reject a long single-request upload before it commits.
// Ordinary large uploads must use the existing bounded-request protocol before
// sending any file data; they must not first try and then replay a failed POST.
func TestRunUpLargeAutomaticallyUsesResumableThroughGateway(t *testing.T) {
	e := newUpEnvSize(t, 1000000)
	// The generic CLI fixture defaults to a 1MiB file cap and 8MiB quota.
	// Both paths in this comparison use these same explicit 64MiB/128MiB
	// fixture limits, so the fault premise measures the gateway, not quota.
	for key, value := range map[string]int64{account.SettingMaxFileSize: 64 << 20, account.SettingDailyQuota: 128 << 20} {
		if err := e.store.SetSetting(context.Background(), key, value, time.Now().Unix()); err != nil {
			t.Fatal(err)
		}
	}
	upstream, _ := url.Parse(e.ts.URL)
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	var wholePosts, patches, largestPatch atomic.Int64
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/files" {
			wholePosts.Add(1)
			_, _ = io.CopyN(io.Discard, r.Body, 64<<10)
			w.Header().Set("Connection", "close")
			w.WriteHeader(524)
			return
		}
		if r.Method == http.MethodPatch {
			patches.Add(1)
			for {
				old := largestPatch.Load()
				if old >= r.ContentLength || largestPatch.CompareAndSwap(old, r.ContentLength) {
					break
				}
			}
			if r.ContentLength > 1<<20 {
				t.Error("resumable request exceeded 1MiB")
				w.WriteHeader(413)
				return
			}
		}
		proxy.ServeHTTP(w, r)
	}))
	defer edge.Close()
	if err := cloud.Save(e.cfgDir, cloud.Creds{Server: edge.URL, AccessToken: e.token, AccountEmail: "up@example.com"}); err != nil {
		t.Fatal(err)
	}
	code, out, stderr := e.up("--json", e.src)
	if code != 0 {
		t.Fatalf("resumable failed: %d %s %s", code, out, stderr)
	}
	d := decodeUpDoc(t, out)
	if d.Status != "uploaded" || e.objects() != 1 || e.records() != 0 || patches.Load() < 2 || wholePosts.Load() != 0 {
		t.Fatalf("unexpected result: %+v objects=%d records=%d patches=%d", d, e.objects(), e.records(), patches.Load())
	}
	got := e.download(d.Link)
	if sha256.Sum256([]byte(got)) != sha256.Sum256([]byte(e.body)) {
		t.Fatal("download hash mismatch")
	}
	t.Logf("gateway524 singlePOSTs=%d; resumablePATCHes=%d maxPATCH=%d plaintextBytes=%d fullSHA256=PASS objects=1 records=0", wholePosts.Load(), patches.Load(), largestPatch.Load(), len(e.body))
}

// The cutoff is the complete encrypted request, including its manifest and
// frame overhead. Small requests retain their streaming behaviour, while the
// first byte above the cutoff is never attempted as a long POST.
func TestRunUpAutomaticResumableRequestBoundary(t *testing.T) {
	for _, target := range []int64{(1 << 20) - 1, 1 << 20, (1 << 20) + 1} {
		t.Run(fmt.Sprint(target), func(t *testing.T) {
			src := filepath.Join(t.TempDir(), "payload.bin")
			if err := os.WriteFile(src, make([]byte, target), 0o600); err != nil {
				t.Fatal(err)
			}
			for tries := 0; tries < 5; tries++ {
				p, err := cloud.PrepareUpload([]string{src}, cloud.UploadOpts{})
				if err != nil {
					t.Fatal(err)
				}
				if p.BodyLength == target {
					break
				}
				st, err := os.Stat(src)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Truncate(src, st.Size()+target-p.BodyLength); err != nil {
					t.Fatal(err)
				}
			}
			p, err := cloud.PrepareUpload([]string{src}, cloud.UploadOpts{})
			if err != nil || p.BodyLength != target {
				t.Fatalf("body length premise: %v, %v", p, err)
			}
			var whole, sessions atomic.Int64
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				switch r.URL.Path {
				case "/api/files":
					whole.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "boundary", "expiresAt": time.Now().Add(time.Hour).Unix()})
				case "/api/uploads":
					sessions.Add(1)
					w.WriteHeader(http.StatusServiceUnavailable)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer srv.Close()
			cfg := t.TempDir()
			if err := cloud.Save(cfg, cloud.Creds{Server: srv.URL, AccessToken: "boundary-token", AccountEmail: "boundary@example.com"}); err != nil {
				t.Fatal(err)
			}
			var stdout, stderr strings.Builder
			code := runUp([]string{"--config-dir", cfg, "--json", src}, &stdout, &stderr)
			doc := decodeUpDoc(t, stdout.String())
			if target <= 1<<20 {
				if code != 0 || doc.Status != "uploaded" || whole.Load() != 1 || sessions.Load() != 0 {
					t.Fatalf("small route: code=%d whole=%d sessions=%d %s", code, whole.Load(), sessions.Load(), stderr.String())
				}
			} else {
				if code != exitUpUnknown || doc.Status != "paused" || doc.Operation == "" || whole.Load() != 0 || sessions.Load() != 1 {
					t.Fatalf("large route: code=%d whole=%d sessions=%d %s", code, whole.Load(), sessions.Load(), stderr.String())
				}
				op, err := cloud.LoadUpOperation(cfg, doc.Operation)
				if err != nil || op.Version != 2 {
					t.Fatalf("recovery record not kept: %v", err)
				}
			}
		})
	}
}

// Losing the final gateway response must retain the automatically selected
// operation. Resuming it recovers the same object without another data PATCH
// or another upload-traffic charge.
func TestRunUpAutomaticResumableLostFinalize(t *testing.T) {
	e := newUpEnvSize(t, 90000)
	if err := e.store.SetSetting(context.Background(), account.SettingMaxFileSize, 4<<20, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	upstream, _ := url.Parse(e.ts.URL)
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	var patches atomic.Int64
	var drop atomic.Bool
	drop.Store(true)
	proxy.ModifyResponse = func(r *http.Response) error {
		if strings.HasSuffix(r.Request.URL.Path, "/finalize") && r.StatusCode == 200 && drop.CompareAndSwap(true, false) {
			r.Body.Close()
			r.Body = http.NoBody
			r.StatusCode = 524
			r.Status = "524 Controlled Gateway Timeout"
			r.ContentLength = 0
			r.Header.Del("Content-Length")
		}
		return nil
	}
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			patches.Add(1)
		}
		if r.URL.Path == "/api/files" {
			t.Error("large upload attempted single POST")
			w.WriteHeader(524)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	defer edge.Close()
	if err := cloud.Save(e.cfgDir, cloud.Creds{Server: edge.URL, AccessToken: e.token, AccountEmail: "up@example.com"}); err != nil {
		t.Fatal(err)
	}
	code, out, stderr := e.up("--json", e.src)
	d := decodeUpDoc(t, out)
	if code != exitUpUnknown || d.Status != "paused" || d.Operation == "" || e.objects() != 1 || e.records() != 1 {
		t.Fatalf("lost-finalize premise: code=%d objects=%d records=%d %s %s", code, e.objects(), e.records(), out, stderr)
	}
	beforePatches, beforeMeter := patches.Load(), e.uploadedBytes()
	code, out, stderr = e.up("--resume", d.Operation, "--json")
	d = decodeUpDoc(t, out)
	if code != 0 || d.Status != "uploaded" || e.objects() != 1 || e.records() != 0 || patches.Load() != beforePatches || e.uploadedBytes() != beforeMeter {
		t.Fatalf("resume changed settled upload: code=%d %s %s", code, out, stderr)
	}
	if got := e.download(d.Link); sha256.Sum256([]byte(got)) != sha256.Sum256([]byte(e.body)) {
		t.Fatal("recovered download hash mismatch")
	}
}
