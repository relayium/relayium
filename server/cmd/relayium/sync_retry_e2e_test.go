package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
)

func TestSyncReconnectsThroughTCPProxy(t *testing.T) {
	for _, fault := range []string{"reset", "black-hole", "reset-with-delete"} {
		t.Run(fault, func(t *testing.T) {
			setDuration(t, &transferIdleTimeout, 1500*time.Millisecond)
			setDuration(t, &daemonReadIdle, 350*time.Millisecond)
			setDuration(t, &syncReconnectInitial, 20*time.Millisecond)
			sender, receiver, dest := t.TempDir(), t.TempDir(), t.TempDir()
			src := filepath.Join(t.TempDir(), "tree")
			if err := os.Mkdir(src, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(filepath.Join(dest, "tree"), 0o700); err != nil {
				t.Fatal(err)
			}
			const size = 8 << 20
			files := map[string][]byte{
				"a-existing":  []byte("already verified"),
				"b-completed": []byte("installed by the first connection"),
				"z-large":     bytes.Repeat([]byte("copy"), size/4),
			}
			for name, body := range files {
				if err := os.WriteFile(filepath.Join(src, name), body, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(dest, "tree", "a-existing"), files["a-existing"], 0o600); err != nil {
				t.Fatal(err)
			}
			senderID, err := secure.LoadOrCreateIdentity(sender)
			if err != nil {
				t.Fatal(err)
			}
			id, err := secure.LoadOrCreateIdentity(receiver)
			if err != nil {
				t.Fatal(err)
			}
			listen := func() net.Listener {
				t.Helper()
				ln, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				return ln
			}
			ln, proxy := listen(), listen()
			ctx, cancel := context.WithCancel(context.Background())
			h := &serveHandler{
				id: id, allow: map[string]bool{senderID.Fingerprint: true}, dir: dest,
				cfgDir: receiver, allowDelete: true, stdout: io.Discard, stderr: io.Discard,
			}
			done := make(chan int, 1)
			go func() { done <- serveLoopCtx(ctx, ln, h, false, 0) }()
			t.Cleanup(func() {
				cancel()
				waitCode(t, done)
			})

			var retriedBytes, retained atomic.Int64
			var connections sync.WaitGroup
			proxyDone := make(chan struct{})
			go func() {
				defer close(proxyDone)
				for number := 0; ; number++ {
					client, err := proxy.Accept()
					if err != nil {
						return
					}
					connections.Go(func() {
						defer client.Close()
						upstream, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
						if err != nil {
							return
						}
						defer upstream.Close()
						stop := context.AfterFunc(ctx, func() { client.Close(); upstream.Close() })
						defer stop()
						responseDone := make(chan struct{})
						go func() {
							defer close(responseDone)
							_, _ = io.Copy(client, upstream)
						}()
						defer func() {
							_ = client.Close()
							_ = upstream.Close()
							<-responseDone
						}()
						if number != 0 {
							n, _ := io.Copy(upstream, client)
							retriedBytes.Add(n)
							return
						}
						// Cut near the end of the last file. Wait until the bytes
						// actually reached the private checkpoint before faulting.
						if _, err := io.CopyN(upstream, client, 7<<20); err != nil {
							return
						}
						deadline := time.Now().Add(time.Second)
						for time.Now().Before(deadline) {
							parts, _ := filepath.Glob(filepath.Join(receiver, "sync-*", "*.part"))
							if len(parts) == 1 {
								if st, err := os.Stat(parts[0]); err == nil && st.Size() > 6<<20 {
									retained.Store(st.Size())
									break
								}
							}
							time.Sleep(5 * time.Millisecond)
						}
						if fault != "black-hole" {
							_ = client.(*net.TCPConn).SetLinger(0)
							_ = upstream.(*net.TCPConn).SetLinger(0)
							return
						}
						// Discard subsequent sender data and leave the upstream
						// socket open even after the sender has timed out.
						_, _ = io.Copy(io.Discard, client)
						<-responseDone
					})
				}
			}()
			t.Cleanup(func() {
				cancel()
				_ = proxy.Close()
				<-proxyDone
				connections.Wait()
			})

			var stderr bytes.Buffer
			args := []string{"sync", "--checksum", "--config-dir", sender, src, "relayium://" + proxy.Addr().String()}
			stale := filepath.Join(dest, "tree", "stale")
			if fault == "reset-with-delete" {
				if err := os.WriteFile(stale, []byte("preserve on interruption"), 0o600); err != nil {
					t.Fatal(err)
				}
				args = append(args, "--delete")
			}
			code := Run(args, io.Discard, &stderr)
			connections.Wait()
			log := stderr.String()
			if fault == "reset-with-delete" {
				if code != 1 || !strings.Contains(log, "check the receiver's result before rerunning") ||
					strings.Contains(log, "Reconnecting") || retriedBytes.Load() != 0 {
					t.Fatalf("interrupted delete returned %d and sent %d retry bytes:\n%s", code, retriedBytes.Load(), log)
				}
				if _, err := os.Stat(stale); err != nil {
					t.Fatalf("interrupted delete removed the stale file: %v", err)
				}
				return
			}
			for _, want := range []string{"Receiver checking existing files: 0/3", "Receiver checking existing files: 3/3",
				"Reconnecting", "1 saved, 2 existing matched (SHA-256), 0 failed"} {
				if code != 0 || !strings.Contains(log, want) {
					t.Fatalf("sync exited %d, missing %q:\n%s", code, want, log)
				}
			}
			if fault == "black-hole" && !strings.Contains(log, "still using this sender's checkpoint") {
				t.Fatalf("expected contention before the old socket timed out:\n%s", log)
			}
			if retained.Load() <= 6<<20 || retriedBytes.Load() == 0 || retriedBytes.Load() >= 2<<20 {
				t.Fatalf("checkpoint bytes %d, retried wire bytes %d:\n%s", retained.Load(), retriedBytes.Load(), log)
			}
			t.Logf("retained %d bytes, sent %d wire bytes after reconnect", retained.Load(), retriedBytes.Load())
			for name, want := range files {
				body, err := os.ReadFile(filepath.Join(dest, "tree", name))
				if err != nil || sha256.Sum256(body) != sha256.Sum256(want) {
					t.Fatalf("destination %s did not match: %v", name, err)
				}
			}
		})
	}
}
