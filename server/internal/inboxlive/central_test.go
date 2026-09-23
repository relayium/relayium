//go:build swiftinterop && !windows

// Package inboxlive is the Go half of the live CLI-sender -> native-receiver
// acceptance (W-C1 Stage 1-S). It contains ONE test, which is never run by
// `go test ./...` (build tag) and refuses to run without its interop directory.
//
// The Swift test `InboxCLISenderLiveInteropTests` builds this package with
// `go test -c -tags swiftinterop` and executes the binary directly. The helper
// then hosts a REAL central — account.Service on in-memory SQLite, a DiskStore,
// real device-code logins — on 127.0.0.1 through sendtest, writes the CLI
// sender's credential directory, and publishes fixture metadata to a 0600
// ready.json inside the 0700 interop directory. The receiver is NOT enrolled
// here: the Swift engine's own prepare() does that against this central.
//
// It serves until its stdin reaches EOF (the parent closed the pipe; the kernel
// also closes it when the parent dies, but only the cooperative close is what
// the Swift test exercises), a `stop` file appears, or its own deadline passes.
//
// RELAYIUM_SWIFT_LIVE_FAULT selects one of:
//
//	""                   no fault
//	"final-tag"          flip the LAST byte of the uploaded object on the wire
//	                     (inside the final frame's AES-GCM tag) before central's
//	                     real PATCH handler stores it; sender, central and the
//	                     Swift receiver stay unmodified product code
//	"hang-pending"       hold the receiver's GET .../inbox/pending until the
//	                     CLIENT abandons the request, and record that it did —
//	                     the proof that the Swift harness deadline really tears
//	                     down the underlying request instead of racing a sleep
//	"exit-before-ready"  exit non-zero before publishing ready.json
//	"stuck-before-ready" never publish ready.json, ignore stdin EOF and SIGTERM,
//	                     so only the harness's SIGKILL escalation can end it
package inboxlive

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// swiftLiveDeadline bounds the helper's own life. The Swift parent is expected
// to finish well inside it; reaching it is a failure, not a normal exit.
const swiftLiveDeadline = 170 * time.Second

func TestSwiftLiveInteropCentral(t *testing.T) {
	dir := os.Getenv("RELAYIUM_SWIFT_LIVE_DIR")
	if dir == "" {
		t.Fatal("RELAYIUM_SWIFT_LIVE_DIR is required; this helper never runs by accident")
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0o700 {
		t.Fatalf("interop dir must be an existing 0700 directory (err=%v)", err)
	}
	fault := os.Getenv("RELAYIUM_SWIFT_LIVE_FAULT")
	switch fault {
	case "", "final-tag", "hang-pending":
	case "exit-before-ready":
		// Harness-control mode: a helper that dies before it is ready.
		os.Exit(3)
	case "stuck-before-ready":
		// Harness-control mode: deaf to the cooperative stop paths.
		signal.Ignore(syscall.SIGTERM)
		time.Sleep(swiftLiveDeadline)
		t.Fatal("stuck helper outlived its deadline: the parent never killed it")
	default:
		t.Fatalf("unknown RELAYIUM_SWIFT_LIVE_FAULT %q", fault)
	}

	env := sendtest.New(t, 8<<20)
	uid := env.User("owner@example.com")
	receiverTok := env.Login(uid, "swift-receiver")
	senderTok := env.Login(uid, "cli-sender")
	current := func(tok string) string {
		code, body := env.Do(tok, http.MethodGet, "/api/devices", nil)
		if code != http.StatusOK {
			t.Fatalf("GET /api/devices: %d", code)
		}
		var out struct{ Devices []inboxclient.Device }
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatalf("decode devices: %v", err)
		}
		for _, d := range out.Devices {
			if d.Current {
				return d.ID
			}
		}
		t.Fatal("no current device row for a bearer")
		return ""
	}
	receiverDevice, senderDevice := current(receiverTok), current(senderTok)
	if receiverDevice == "" || receiverDevice == senderDevice {
		t.Fatalf("device ids must be distinct and non-empty: %q %q", receiverDevice, senderDevice)
	}

	senderCfg := filepath.Join(dir, "sender-config")
	if err := os.Mkdir(senderCfg, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(senderCfg, cloud.Creds{Server: env.TS.URL, AccessToken: senderTok,
		AccountEmail: "owner@example.com"}); err != nil {
		t.Fatal(err)
	}

	var tampered, abandoned atomic.Int32
	switch fault {
	case "final-tag":
		env.Faults.Add(&sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Times: 1 << 20,
			Action: sendtest.Before, Fn: func(r *http.Request) {
				// Content-Range: bytes a-b/total. Only the PATCH carrying the
				// object's final byte is touched, and only that one byte: the
				// object is frames only, each uint32BE(len) || GCM(ct||tag), so
				// its last byte is always inside the final frame's tag.
				var a, b, total int64
				if _, err := fmt.Sscanf(r.Header.Get("Content-Range"), "bytes %d-%d/%d", &a, &b, &total); err != nil || b != total-1 {
					return
				}
				body, _ := io.ReadAll(r.Body)
				if len(body) == 0 {
					return
				}
				body[len(body)-1] ^= 0x01
				r.Body = io.NopCloser(bytes.NewReader(body))
				r.ContentLength = int64(len(body))
				tampered.Add(1)
			}})
	case "hang-pending":
		env.Faults.Add(&sendtest.Rule{Method: http.MethodGet, PathPrefix: "/api/devices/" + receiverDevice,
			PathSuffix: "/inbox/pending", Times: 1 << 20, Action: sendtest.Before, Fn: func(r *http.Request) {
				// Never answer on our own: only the client going away (or our
				// deadline) releases this request. Recording WHICH one happened
				// is the evidence the Swift side reads.
				select {
				case <-r.Context().Done():
					// Published at once (not only at exit) so the parent can
					// observe it while this helper is still serving.
					n := abandoned.Add(1)
					_ = os.WriteFile(filepath.Join(dir, "pending-abandoned"), []byte(fmt.Sprint(n)), 0o600)
				case <-time.After(swiftLiveDeadline):
				}
			}})
	}

	meta := map[string]string{
		"url":              env.TS.URL,
		"accountId":        uid,
		"receiverToken":    receiverTok,
		"receiverDeviceId": receiverDevice,
		"senderDeviceId":   senderDevice,
		"senderConfigDir":  senderCfg,
		"fault":            fault,
	}
	b, _ := json.Marshal(meta)
	tmp := filepath.Join(dir, "ready.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, "ready.json")); err != nil {
		t.Fatal(err)
	}

	eof := make(chan struct{})
	go func() {
		r := bufio.NewReader(os.Stdin)
		for {
			if _, err := r.ReadByte(); err != nil {
				close(eof)
				return
			}
		}
	}()
	stop := filepath.Join(dir, "stop")
	end := time.After(swiftLiveDeadline)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	exit := func(why string) {
		s := fmt.Sprintf("{\"exit\":%q,\"tamperedPatches\":%d,\"abandonedPending\":%d}\n",
			why, tampered.Load(), abandoned.Load())
		_ = os.WriteFile(filepath.Join(dir, "helper-exit.json"), []byte(s), 0o600)
		t.Log(strings.TrimSpace(s))
	}
	for {
		select {
		case <-eof:
			exit("stdin-eof")
			return
		case <-end:
			exit("deadline")
			t.Fatal("helper deadline reached before the Swift parent finished")
		case <-tick.C:
			if _, err := os.Stat(stop); err == nil {
				exit("stop-file")
				return
			}
		}
	}
}
