//go:build !windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// W-N40 through the real binaries' code paths: `relayium inbox send` (the real
// CLI sender) -> real account.Service (SQLite + DiskStore) -> `relayium inbox
// run --once` (the real CLI receiver). An all-empty delivery arrives as the
// exact tree of empty files; an empty folder beside them is reported, not sent.
func TestInboxSendAllEmptyToTheRealCLIReceiver(t *testing.T) {
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"e/a.txt": {}, "e/b/c.txt": {}, "e/b/d/deep": {}})
	if err := os.MkdirAll(filepath.Join(root, "e", "nothing"), 0o755); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := s.send("--to", s.recvID, "--json", filepath.Join(root, "e"))
	if code != 0 {
		t.Fatalf("send = %d\n%s\n%s", code, out, errOut)
	}
	doc := decodeJSON(t, out)
	taskID, _ := doc["taskId"].(string)
	if doc["state"] != "queued" || taskID == "" || doc["ciphertextBytes"] != float64(0) {
		t.Fatalf("send JSON = %v", doc)
	}
	s.receiveOnce()
	for _, name := range []string{"e/a.txt", "e/b/c.txt", "e/b/d/deep"} {
		fi, err := os.Stat(filepath.Join(s.recvDir, filepath.FromSlash(name)))
		if err != nil || !fi.Mode().IsRegular() || fi.Size() != 0 {
			t.Fatalf("%s: %v %v", name, fi, err)
		}
	}
	if _, err := os.Stat(filepath.Join(s.recvDir, "e", "nothing")); !os.IsNotExist(err) {
		t.Fatalf("an empty folder was created on the receiver: %v", err)
	}
	code, sout, serr := s.cli("sent", taskID, "--json", "--config-dir", s.senderCfg)
	if code != 0 {
		t.Fatalf("sent = %d %s", code, serr)
	}
	var st struct{ Task map[string]any }
	_ = json.Unmarshal([]byte(sout), &st)
	if st.Task["state"] != "saved" {
		t.Fatalf("sent JSON = %s", sout)
	}
	if q := s.env.QuotaBytes(s.uid); q != 64<<10 {
		t.Fatalf("daily quota = %d; want one 64 KiB floor", q)
	}
	if n := s.taskCount(); n != 1 {
		t.Fatalf("tasks = %d; want 1", n)
	}
}

// The same CLI against a server that predates W-N40 (no zero-length-object
// capability on the device list): the all-empty send is refused before any
// upload, exit 2 "refused", and nothing is charged or queued.
func TestInboxSendAllEmptyRefusedByAnOldServer(t *testing.T) {
	s := newSendEnv(t)
	s.env.Faults.SetLegacyServer(true)
	root := tree(t, map[string][]byte{"e/a.txt": {}, "e/b/c.txt": {}})
	code, out, errOut := s.send("--to", s.recvID, "--json", filepath.Join(root, "e"))
	if code != 2 || decodeJSON(t, out)["outcome"] != "refused" || !strings.Contains(errOut, "every file named is empty") {
		t.Fatalf("send = %d\nstdout %s\nstderr %s", code, out, errOut)
	}
	if n := s.env.Faults.Hits(sendtest.KeyInit); n != 0 {
		t.Fatalf("%d upload(s) opened", n)
	}
	if q := s.env.QuotaBytes(s.uid); q != 0 {
		t.Fatalf("daily quota = %d", q)
	}
	if n := s.taskCount(); n != 0 {
		t.Fatalf("tasks = %d", n)
	}
}
