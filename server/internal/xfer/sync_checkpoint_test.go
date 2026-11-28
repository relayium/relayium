package xfer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inboxsend/sendlock"
)

func TestSyncCheckpointAcrossReceiverRestart(t *testing.T) {
	for _, tc := range []struct {
		name    string
		corrupt bool
	}{
		{name: "matching prefix"},
		{name: "corrupt prefix", corrupt: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := bytes.Repeat([]byte("checkpoint\n"), minSyncCheckpointSize/4)
			half := len(body) / 2
			sum := sha256.Sum256(body)
			entry := FileEntry{Path: "folder/file", Size: int64(len(body)), Mode: 0o640,
				SHA256: hex.EncodeToString(sum[:])}
			manifest := Manifest{Files: []FileEntry{entry}}
			dest, config := t.TempDir(), t.TempDir()
			opts := RecvOpts{AllowSync: true, CheckpointDir: config, CheckpointPeer: "authorized"}

			first, done := receiveCheckpointTest(t, dest, opts)
			hello := Hello{Version: WireVersion, Sync: true, Mode: "push", ContentCheck: true, ResumeProof: true}
			for _, msg := range []struct {
				tag MsgType
				v   any
			}{{MsgHello, hello}, {MsgManifest, manifest}} {
				if err := WriteJSON(first, msg.tag, msg.v); err != nil {
					t.Fatal(err)
				}
			}
			var state ResumeState
			if err := readSyncResponse(first, true, MsgResume, &state); err != nil {
				t.Fatal(err)
			}
			if err := WriteJSON(first, MsgFileStart, FileStart{}); err != nil {
				t.Fatal(err)
			}
			if _, err := first.Write(body[:half]); err != nil {
				t.Fatal(err)
			}
			_ = first.Close()
			if err := <-done; !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("interrupted receive: %v", err)
			}
			if _, err := os.Stat(filepath.Join(dest, entry.Path)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("partial escaped to the destination: %v", err)
			}

			checkpoint, err := openSyncCheckpoint(config, opts.CheckpointPeer, dest, manifest)
			if err != nil {
				t.Fatal(err)
			}
			defer checkpoint.close()
			if _, err := openSyncCheckpoint(config, opts.CheckpointPeer, dest, manifest); !errors.Is(err, sendlock.ErrLocked) {
				t.Fatalf("checkpoint lock was not exclusive: %v", err)
			}
			other, err := openSyncCheckpoint(config, "different-peer", dest, manifest)
			if err != nil {
				t.Fatal(err)
			}
			var unrelated ResumeState
			i := other.offer(manifest, &unrelated)
			other.close()
			if i != -1 || len(unrelated.Entries) > 0 {
				t.Fatal("checkpoint was shared with a different peer")
			}
			if tc.corrupt {
				file, err := os.OpenFile(filepath.Join(checkpoint.dir, checkpoint.active), os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.WriteAt([]byte("corrupt"), 0); err != nil {
					t.Fatal(err)
				}
				_ = file.Close()
			}
			checkpoint.close()
			source := filepath.Join(t.TempDir(), "source")
			if err := os.WriteFile(source, body, 0o600); err != nil {
				t.Fatal(err)
			}

			retry, done := receiveCheckpointTest(t, dest, opts)
			var sent int64
			rep, err := Send(retry, manifest, []string{source}, SendOpts{
				Sync: true, ContentCheck: true,
				TransferProgress: func(p TransferProgress) { sent = p.BytesDone },
			})
			_ = retry.Close()
			recvErr := <-done
			if err != nil || recvErr != nil || rep.Files != 1 || len(rep.Failed) != 0 {
				t.Fatalf("retry: %+v, sender=%v receiver=%v", rep, err, recvErr)
			}
			wantSent := len(body) - half
			if tc.corrupt {
				wantSent = len(body)
			}
			if sent != int64(wantSent) {
				t.Fatalf("retry sent %d bytes, want %d", sent, wantSent)
			}
			got, err := os.ReadFile(filepath.Join(dest, entry.Path))
			if err != nil || !bytes.Equal(got, body) {
				t.Fatalf("destination failed content check: %v", err)
			}
			left, err := filepath.Glob(filepath.Join(config, "sync-*", "*.part"))
			if err != nil || len(left) != 0 {
				t.Fatalf("checkpoint remains after commit: %v, %v", left, err)
			}
		})
	}
}

func receiveCheckpointTest(t *testing.T, dest string, opts RecvOpts) (net.Conn, <-chan error) {
	t.Helper()
	sender, receiver := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	_ = sender.SetDeadline(deadline)
	_ = receiver.SetDeadline(deadline)
	t.Cleanup(func() { _ = sender.Close() })
	done := make(chan error, 1)
	go func() {
		defer receiver.Close()
		_, err := Receive(receiver, dest, opts)
		done <- err
	}()
	return sender, done
}
