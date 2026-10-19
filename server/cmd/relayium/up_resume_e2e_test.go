//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/cloud"
)

func TestResumableUpRealServerAndEmptyFiles(t *testing.T) {
	for _, lines := range []int{0, 5000} {
		t.Run(map[bool]string{true: "empty", false: "file"}[lines == 0], func(t *testing.T) {
			e := newUpEnvSize(t, lines)
			code, stdout, stderr := e.up("--resumable", "--json", e.src)
			if code != 0 {
				t.Fatalf("resumable up failed %d: %s %s", code, stdout, stderr)
			}
			doc := decodeUpDoc(t, stdout)
			if doc.Status != "uploaded" || e.objects() != 1 || e.records() != 0 {
				t.Fatal("upload did not finish with one object and no record")
			}
			if got := e.download(doc.Link); got != e.body {
				t.Fatal("full plaintext roundtrip mismatch")
			}
			if entries, err := os.ReadDir(cloud.UpJournalDir(e.cfgDir)); err != nil {
				t.Fatal(err)
			} else {
				for _, entry := range entries {
					if strings.HasSuffix(entry.Name(), ".cipher") {
						t.Fatal("finished encrypted copy left behind")
					}
				}
			}
			if strings.Contains(stderr, e.token) {
				t.Fatal("stderr exposes bearer")
			}
		})
	}
}

type heldPrefixBody struct {
	io.ReadCloser
	left    int64
	entered chan struct{}
	release <-chan struct{}
	once    sync.Once
}

func (b *heldPrefixBody) Read(p []byte) (int, error) {
	if b.left == 0 {
		b.once.Do(func() { close(b.entered) })
		<-b.release
		return 0, io.ErrUnexpectedEOF
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	n, err := b.ReadCloser.Read(p)
	b.left -= int64(n)
	return n, err
}

// Actual CLI process -> real HTTP proxy -> real account.Service/SQLite/disk.
// The proxy forwards a strict prefix of the first PATCH then holds its body.
// SIGKILL destroys the client before the rest reaches the service. The next
// process resumes the server's durable prefix from the encrypted local copy.
func TestResumableUpSIGKILLMidBodyAcrossActualCLIProcesses(t *testing.T) {
	e := newUpEnvSize(t, 30000)
	target, _ := url.Parse(e.ts.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "controlled interrupted upstream body", http.StatusBadGateway)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	var intercept atomic.Bool
	intercept.Store(true)
	proxied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch && intercept.CompareAndSwap(true, false) {
			r.Body = &heldPrefixBody{ReadCloser: r.Body, left: 64 << 10, entered: entered, release: release}
		}
		proxy.ServeHTTP(w, r)
	}))
	defer proxied.Close()
	defer unblock()
	if err := cloud.Save(e.cfgDir, cloud.Creds{Server: proxied.URL, AccountEmail: "up@example.com", AccessToken: e.token}); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "relayium-candidate")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", bin, "./cmd/relayium")
	build.Dir = "../.."
	if log, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build actual CLI: %v %s", err, log)
	}
	var firstOut, firstErr bytes.Buffer
	first := exec.Command(bin, "up", "--resumable", "--json", "--config-dir", e.cfgDir, e.src)
	first.Stdout = &firstOut
	first.Stderr = &firstErr
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- first.Wait() }()
	t.Cleanup(func() {
		unblock()
		if first.ProcessState == nil {
			_ = first.Process.Kill()
			<-waited
		}
	})
	select {
	case <-entered:
	case err := <-waited:
		t.Fatalf("CLI stopped before mid-body hold: %v %s", err, firstErr.String())
	case <-time.After(20 * time.Second):
		t.Fatal("actual PATCH prefix was not observed")
	}
	pending, err := cloud.ListUpOperations(e.cfgDir)
	if err != nil || len(pending) != 1 {
		t.Fatal("missing pre-PATCH checkpoint", err)
	}
	op, err := cloud.LoadUpOperation(e.cfgDir, pending[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if op.Phase != "uploading" || op.UploadID == "" {
		t.Fatal("body started before session checkpoint")
	}
	if err = first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-waited
	unblock()
	// A status request may initially race the handler's final EOF settlement.
	// Poll the actual durable row (bounded) rather than sleeping a guessed delay.
	deadline := time.Now().Add(5 * time.Second)
	var durable int64
	for time.Now().Before(deadline) {
		row, ok, err := e.store.GetUploadSession(context.Background(), op.UploadID, e.userID)
		if err != nil {
			t.Fatal(err)
		}
		if ok && row.Received > 0 {
			durable = row.Received
			break
		}
		runtime.Gosched()
	}
	if durable <= 0 || durable >= op.BodyLength-op.HeaderBytes {
		t.Fatalf("not a true partial durable body: %d/%d", durable, op.BodyLength-op.HeaderBytes)
	}
	t.Logf("MIDBODY: first actual CLI killed, durable prefix=%d of %d ciphertext bytes", durable, op.BodyLength-op.HeaderBytes)
	if err = os.Remove(e.src); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	second := exec.Command(bin, "up", "--resume", op.ID, "--json", "--config-dir", e.cfgDir)
	second.Stdout = &out
	second.Stderr = &errOut
	if err = second.Run(); err != nil {
		t.Fatalf("second CLI failed: %v %s %s", err, out.String(), errOut.String())
	}
	var doc upDoc
	if err = json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Status != "uploaded" || e.objects() != 1 || e.records() != 0 {
		t.Fatal("second process did not finish exactly one object")
	}
	if got := e.download(doc.Link); got != e.body {
		t.Fatal("resumed real object plaintext mismatch")
	}
	if got := e.uploadedBytes(); got != op.BodyLength-op.HeaderBytes {
		t.Fatalf("resumed upload not accounted exactly once: %d vs%d", got, op.BodyLength-op.HeaderBytes)
	}
	t.Logf("RESUMED: new actual CLI, source removed, full plaintext verified, one object, metered=%d bytes", e.uploadedBytes())
	if strings.Contains(firstErr.String()+errOut.String(), e.token) || strings.Contains(firstErr.String()+errOut.String(), op.ContentKey) {
		t.Fatal("error output exposed credentials or content key")
	}
}

func TestResumableUpLostFinalizeRealServerSettlesOnce(t *testing.T) {
	e := newUpEnv(t)
	target, _ := url.Parse(e.ts.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	var lost atomic.Bool
	var appended atomic.Int64
	proxy.ModifyResponse = func(resp *http.Response) error {
		if strings.HasSuffix(resp.Request.URL.Path, "/finalize") && resp.StatusCode == 200 && lost.CompareAndSwap(false, true) {
			_ = resp.Body.Close()
			resp.Body = io.NopCloser(strings.NewReader("controlled lost finalize"))
			resp.StatusCode = 502
			resp.ContentLength = int64(len("controlled lost finalize"))
			resp.Header.Set("Content-Length", fmt.Sprint(resp.ContentLength))
		}
		return nil
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			appended.Add(r.ContentLength)
		}
		proxy.ServeHTTP(w, r)
	}))
	defer ts.Close()
	if err := cloud.Save(e.cfgDir, cloud.Creds{Server: ts.URL, AccessToken: e.token, AccountEmail: "up@example.com"}); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := e.up("--resumable", "--json", e.src)
	if code != exitUpUnknown {
		t.Fatalf("lost finalize not retained: %d %s %s", code, stdout, stderr)
	}
	doc := decodeUpDoc(t, stdout)
	op, err := cloud.LoadUpOperation(e.cfgDir, doc.Operation)
	if err != nil {
		t.Fatal(err)
	}
	if op.Phase != "finalizing" || e.objects() != 1 {
		t.Fatal("lost finalize did not preserve completion checkpoint")
	}
	bytesBefore, meterBefore := appended.Load(), e.uploadedBytes()
	if err = os.Remove(e.src); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr = e.up("--resume", doc.Operation, "--json")
	if code != 0 {
		t.Fatalf("finalize recovery failed: %d %s %s", code, stdout, stderr)
	}
	completed := decodeUpDoc(t, stdout)
	if e.objects() != 1 || e.records() != 0 || e.uploadedBytes() != meterBefore || appended.Load() != bytesBefore {
		t.Fatal("lost finalize recovery duplicated bytes/object/meter")
	}
	if got := e.download(completed.Link); got != e.body {
		t.Fatal("recovered object content mismatch")
	}
	t.Logf("FINALIZE_RECOVERY: one object, zero replay bytes, same %d metered bytes", meterBefore)
}

func recordedResumableUp(t *testing.T, e *upEnv) cloud.UpOperation {
	t.Helper()
	p, err := cloud.PrepareUpload([]string{e.src}, cloud.UploadOpts{})
	if err != nil {
		t.Fatal(err)
	}
	op, err := cloud.NewUpOperation(p, e.ts.URL, "up@example.com", time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.SpoolUpOperation(e.cfgDir, &op, p); err != nil {
		t.Fatal(err)
	}
	if err := cloud.SaveUpOperation(e.cfgDir, op); err != nil {
		t.Fatal(err)
	}
	return op
}

func TestResumableUpCLIRefusesOtherCredentialsBeforeNetwork(t *testing.T) {
	for _, mode := range []string{"account", "server", "logged-out"} {
		t.Run(mode, func(t *testing.T) {
			e := newUpEnv(t)
			op := recordedResumableUp(t, e)
			creds := cloud.Creds{Server: e.ts.URL, AccountEmail: "up@example.com", AccessToken: e.token}
			var otherHits atomic.Int32
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				otherHits.Add(1)
				http.Error(w, "unexpected", 500)
			}))
			defer other.Close()
			switch mode {
			case "account":
				creds.AccountEmail = "other@example.com"
			case "server":
				creds.Server = other.URL
			}
			if err := cloud.Save(e.cfgDir, creds); err != nil {
				t.Fatal(err)
			}
			if mode == "logged-out" {
				if err := cloud.Clear(e.cfgDir); err != nil {
					t.Fatal(err)
				}
			}
			before := e.wire.Load()
			code, stdout, stderr := e.up("--resume", op.ID, "--json")
			doc := decodeUpDoc(t, stdout)
			want := "different_account"
			if mode == "logged-out" {
				want = "not_logged_in"
			}
			if code == 0 || doc.Error != want || e.wire.Load() != before || otherHits.Load() != 0 {
				t.Fatalf("credential boundary failed: code=%d error=%s", code, doc.Error)
			}
			restored, err := cloud.LoadUpOperation(e.cfgDir, op.ID)
			if err != nil || restored != op {
				t.Fatal("refusal changed the recovery record", err)
			}
			if e.records() != 1 || e.objects() != 0 || e.uploadedBytes() != 0 {
				t.Fatal("refusal changed remote or local upload state")
			}
			if strings.Contains(stdout+stderr, op.ContentKey) || strings.Contains(stdout+stderr, e.token) {
				t.Fatal("refusal exposed recovery secrets")
			}
		})
	}
}

func TestResumableUpCLIConflictingOptionsLeaveStateUntouched(t *testing.T) {
	e := newUpEnv(t)
	op := recordedResumableUp(t, e)
	for _, extra := range [][]string{
		{"--discard", op.ID}, {"--resumable"}, {"--recover", op.ID},
		{"--pending"}, {"--burn"}, {"--ttl", "1d"},
		{"--max-downloads", "1"}, {"--server", e.ts.URL}, {e.src},
	} {
		before, wire := dirDigest(t, e.cfgDir), e.wire.Load()
		args := append([]string{"--resume", op.ID}, extra...)
		code, _, _ := e.up(args...)
		if code != 2 || dirDigest(t, e.cfgDir) != before || e.wire.Load() != wire {
			t.Fatalf("conflicting options changed state: %v code=%d", extra, code)
		}
	}
}

func TestResumableUpCLIDiscardNeedsNoCredentialAndMakesNoRequest(t *testing.T) {
	e := newUpEnv(t)
	op := recordedResumableUp(t, e)
	if err := cloud.Clear(e.cfgDir); err != nil {
		t.Fatal(err)
	}
	wire := e.wire.Load()
	code, stdout, stderr := e.up("--discard", op.ID, "--json")
	if code != 0 || decodeUpDoc(t, stdout).Status != "discarded" || e.records() != 0 || e.wire.Load() != wire {
		t.Fatalf("local discard failed: code=%d stderr=%s", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(cloud.UpJournalDir(e.cfgDir), op.ID+".cipher")); !os.IsNotExist(err) {
		t.Fatal("discard retained ciphertext", err)
	}
	if e.objects() != 0 || e.uploadedBytes() != 0 {
		t.Fatal("local discard changed remote state")
	}
	if body, err := os.ReadFile(e.src); err != nil || string(body) != e.body {
		t.Fatal("discard changed the original source", err)
	}
}
