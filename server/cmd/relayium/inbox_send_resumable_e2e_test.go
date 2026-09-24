//go:build darwin || linux

package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// Stage R end to end: `inbox send --resumable` in a REAL child process that
// is SIGKILLed (no deferred code, no cleanup) at each request and each
// journal checkpoint boundary, then `inbox retry` in a new process image
// against the same real account.Service and the real CLI receiver.
//
// Checkpoint boundaries are bracketed by the request that follows each one:
// a held init (record planned), a held first PATCH (uploading recorded, no
// byte appended), a held later PATCH (mid-upload), a held finalize (finalizing
// recorded), a held create (finalized recorded).

// startSender runs `relayium <args>` in a child test process. extraEnv lets a
// test constrain the child (see TestInboxSendResumableHelperProcess).
func (s *sendEnv) startSender(extraEnv []string, args ...string) (*exec.Cmd, *bytes.Buffer) {
	s.t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestInboxSendResumableHelperProcess$", "-test.count=1")
	cmd.Env = append(append(os.Environ(), "RELAYIUM_INBOX_SEND_RHELPER=1",
		"RELAYIUM_INBOX_SEND_ARGS="+strings.Join(args, "\x1f")), extraEnv...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		s.t.Fatal(err)
	}
	return cmd, &out
}

// killResumableAt starts `inbox send --resumable`, waits for the held request
// to reach central, SIGKILLs the child and then lets the held request go.
func (s *sendEnv) killResumableAt(hold *sendtest.Rule, paths ...string) {
	s.t.Helper()
	args := append([]string{"inbox", "send", "--resumable", "--config-dir", s.senderCfg, "--to", s.recvID}, paths...)
	cmd, out := s.startSender(nil, args...)
	select {
	case <-hold.Hit:
	case <-time.After(90 * time.Second):
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		s.t.Fatalf("the child never reached the held request:\n%s", out.String())
	}
	if err := cmd.Process.Signal(syscall.SIGKILL); err != nil {
		s.t.Fatal(err)
	}
	_ = cmd.Wait()
	hold.Release()
}

// TestInboxSendResumableHelperProcess is a child process, not a test. With
// RELAYIUM_INBOX_SEND_FSIZE it runs under RLIMIT_FSIZE, so a file write past
// that size fails with the operating system's own EFBIG: a real write error.
func TestInboxSendResumableHelperProcess(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_RHELPER") != "1" {
		t.Skip("helper process only")
	}
	if v := os.Getenv("RELAYIUM_INBOX_SEND_FSIZE"); v != "" {
		n, _ := strconv.ParseUint(v, 10, 64)
		signal.Ignore(syscall.SIGXFSZ)
		if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &syscall.Rlimit{Cur: n, Max: n}); err != nil {
			os.Exit(99)
		}
	}
	args := strings.Split(os.Getenv("RELAYIUM_INBOX_SEND_ARGS"), "\x1f")
	os.Exit(Run(args, os.Stdout, os.Stderr))
}

// sendStateFiles lists everything in the sender's record directory except
// lock files.
func (s *sendEnv) sendStateFiles() []string {
	ents, _ := os.ReadDir(filepath.Join(s.senderCfg, "inbox-send"))
	var out []string
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".lock") {
			out = append(out, e.Name())
		}
	}
	return out
}

func (s *sendEnv) spoolOf(id string) string {
	return filepath.Join(s.senderCfg, "inbox-send", id+".spool")
}

// flipEveryByte rewrites a source in place with its size and mtime restored.
func flipEveryByte(t *testing.T, path string) {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	for i := range b {
		b[i] ^= 0x5a
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt(b, 0); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := os.Chtimes(path, st.ModTime(), st.ModTime()); err != nil {
		t.Fatal(err)
	}
}

func randomData(t *testing.T, n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// E-R1: SIGKILL at every request/checkpoint boundary; the source is then
// rewritten in place with its stat fingerprint restored; `inbox retry` in a
// new process finishes the send: exactly one completed (counted) upload,
// exactly one task, the ORIGINAL bytes on the receiver, nothing left locally.
func TestInboxSendResumableSurvivesSIGKILLAtEveryBoundary(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_RHELPER") != "" {
		t.Skip("helper")
	}
	type want struct{ inits, finalizes int }
	for _, tc := range []struct {
		name string
		rule sendtest.Rule
		want want
		// resumedMidway: the retry's first PATCH must start past 0.
		resumedMidway bool
		// quotaAlreadyCounted: the killed process's finalize committed.
		quotaAlreadyCounted bool
		showCopyHint        bool
	}{
		{name: "init answered but lost (record planned)",
			rule: sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/uploads", PathSuffix: "/api/uploads", Action: sendtest.HoldResponse},
			want: want{inits: 2, finalizes: 1}},
		{name: "first PATCH never reached central (uploading recorded, nothing appended)",
			rule: sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Action: sendtest.HoldUnhandled},
			want: want{inits: 1, finalizes: 1}, showCopyHint: true},
		{name: "second PATCH never reached central (mid-upload)",
			rule: sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Skip: 1, Action: sendtest.HoldUnhandled},
			want: want{inits: 1, finalizes: 1}, resumedMidway: true, showCopyHint: true},
		{name: "finalize never reached central (finalizing recorded)",
			rule: sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.HoldUnhandled},
			want: want{inits: 1, finalizes: 2}},
		{name: "finalize committed, answer lost",
			rule: sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.HoldResponse},
			want: want{inits: 1, finalizes: 2}, quotaAlreadyCounted: true},
		{name: "create never reached central (finalized recorded)",
			rule: sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.HoldUnhandled},
			want: want{inits: 1, finalizes: 1}, quotaAlreadyCounted: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newSendEnv(t)
			orig := randomData(t, 9<<20+999) // two 8 MiB server chunks
			root := tree(t, map[string][]byte{"big.bin": orig})
			src := filepath.Join(root, "big.bin")
			r := tc.rule
			r.Hit = make(chan struct{})
			hold := s.env.Faults.Add(&r)
			s.killResumableAt(hold, src)

			ids := s.journalIDs()
			if len(ids) != 1 {
				t.Fatalf("records after SIGKILL = %v", ids)
			}
			id := ids[0]
			if _, err := os.Stat(s.spoolOf(id)); err != nil {
				t.Fatalf("the local copy did not survive the kill: %v", err)
			}
			code, listed, errOut := s.cli("sent", "--config-dir", s.senderCfg)
			if code != 0 {
				t.Fatalf("sent = %d %s", code, errOut)
			}
			if strings.Contains(listed, "occupy disk space") != tc.showCopyHint {
				t.Fatalf("copy hint for %s: %s", tc.name, listed)
			}
			if tc.showCopyHint && (!strings.Contains(listed, "relayium inbox retry "+id) || !strings.Contains(listed, "relayium inbox retry --discard "+id)) {
				t.Fatalf("missing actions: %s", listed)
			}
			code, listed, errOut = s.cli("sent", "--json", "--config-dir", s.senderCfg)
			if code != 0 {
				t.Fatalf("sent JSON = %d %s", code, errOut)
			}
			rows := decodeJSON(t, listed)["localSends"].([]any)
			if len(rows) != 1 || len(rows[0].(map[string]any)) != 5 || strings.Contains(listed, "occupy disk space") {
				t.Fatalf("JSON schema changed: %s", listed)
			}
			flipEveryByte(t, src)
			quotaBefore := s.env.QuotaBytes(s.uid)
			if tc.quotaAlreadyCounted == (quotaBefore == 0) {
				t.Fatalf("quota before retry = %d (already counted: %v)", quotaBefore, tc.quotaAlreadyCounted)
			}
			patchesBefore := len(s.env.Faults.Patches())

			code, out, errOut := s.cli("retry", id, "--json", "--config-dir", s.senderCfg)
			if code != 0 {
				t.Fatalf("retry = %d\n%s\n%s", code, out, errOut)
			}
			doc := decodeJSON(t, out)
			if doc["state"] != "queued" {
				t.Fatalf("retry JSON = %v", doc)
			}
			ciphertext := int64(doc["ciphertextBytes"].(float64))
			if got := s.env.Faults.Hits(sendtest.KeyInit); got != tc.want.inits {
				t.Fatalf("inits = %d, want %d", got, tc.want.inits)
			}
			if got := s.env.Faults.Hits(sendtest.KeyFinalize); got != tc.want.finalizes {
				t.Fatalf("finalizes = %d, want %d", got, tc.want.finalizes)
			}
			if tc.resumedMidway {
				after := s.env.Faults.Patches()[patchesBefore:]
				if len(after) == 0 || after[0].Start == 0 {
					t.Fatal("the retry did not continue at the server's offset")
				}
			}
			quota := s.env.QuotaBytes(s.uid)
			// Exactly one debit: the daily-quota sum is one ciphertext's worth.
			if quota != ciphertext || (tc.quotaAlreadyCounted && quota != quotaBefore) {
				t.Fatalf("quota %d -> %d; want exactly one completed upload counted", quotaBefore, quota)
			}
			if n := s.taskCount(); n != 1 {
				t.Fatalf("tasks = %d, want 1", n)
			}
			s.receiveOnce()
			got, err := os.ReadFile(filepath.Join(s.recvDir, "big.bin"))
			if err != nil || !bytes.Equal(got, orig) {
				t.Fatal("the receiver did not get the bytes encrypted before the source changed")
			}
			if left := s.sendStateFiles(); len(left) != 0 {
				t.Fatalf("left behind: %v", left)
			}
			// A second retry has nothing to do and uploads nothing.
			if code, _, _ := s.cli("retry", id, "--config-dir", s.senderCfg); code != 2 {
				t.Fatalf("second retry = %d, want 2 (no such send)", code)
			}
			if s.env.QuotaBytes(s.uid) != quota || s.taskCount() != 1 {
				t.Fatal("a second retry changed something")
			}
		})
	}
}

// E-R2: two retries of one interrupted send at once, in two processes. One
// works; the other is refused without a request; one task results.
func TestInboxSendResumableParallelRetriesDoNotDoubleSend(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_RHELPER") != "" {
		t.Skip("helper")
	}
	s := newSendEnv(t)
	orig := randomData(t, 9<<20+5)
	root := tree(t, map[string][]byte{"big.bin": orig})
	first := s.env.Faults.Add(&sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Skip: 1,
		Action: sendtest.HoldUnhandled, Hit: make(chan struct{})})
	s.killResumableAt(first, filepath.Join(root, "big.bin"))
	id := s.journalIDs()[0]

	// The retrying child is held at its PATCH, holding the send's lock.
	held := s.env.Faults.Add(&sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/",
		Action: sendtest.HoldResponse, Hit: make(chan struct{})})
	cmd, childOut := s.startSender(nil, "inbox", "retry", id, "--json", "--config-dir", s.senderCfg)
	select {
	case <-held.Hit:
	case <-time.After(90 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("child retry never reached its PATCH:\n%s", childOut.String())
	}
	patches := len(s.env.Faults.Patches())
	code, out, _ := s.cli("retry", id, "--json", "--config-dir", s.senderCfg)
	if code != 1 || decodeJSON(t, out)["error"] != "journal_busy" {
		t.Fatalf("concurrent retry = %d %s; want 1 journal_busy", code, out)
	}
	if len(s.env.Faults.Patches()) != patches {
		t.Fatal("the refused retry uploaded")
	}
	held.Release() // the child's PATCH answer is lost; it asks for status and continues
	if err := cmd.Wait(); err != nil {
		t.Fatalf("child retry: %v\n%s", err, childOut.String())
	}
	if s.taskCount() != 1 || s.env.Faults.Hits(sendtest.KeyInit) != 1 || s.env.Faults.Hits(sendtest.KeyFinalize) != 1 {
		t.Fatal("want one upload, one finalize, one task")
	}
	s.receiveOnce()
	if got, _ := os.ReadFile(filepath.Join(s.recvDir, "big.bin")); !bytes.Equal(got, orig) {
		t.Fatal("content differs")
	}
}

// E-R3: a real write failure while the local copy is written (RLIMIT_FSIZE
// in the child: EFBIG from the operating system) is a local refusal before
// any network write, and leaves no copy, no temporary file and no record.
func TestInboxSendResumableWriteFailureIsRefusedBeforeUploading(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_RHELPER") != "" {
		t.Skip("helper")
	}
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"big.bin": randomData(t, 3<<20)})
	cmd, out := s.startSender([]string{"RELAYIUM_INBOX_SEND_FSIZE=" + strconv.Itoa(1<<20)},
		"inbox", "send", "--resumable", "--json", "--config-dir", s.senderCfg, "--to", s.recvID, filepath.Join(root, "big.bin"))
	err := cmd.Wait()
	var ee *exec.ExitError
	if err == nil || !errors.As(err, &ee) || ee.ExitCode() != 2 {
		t.Fatalf("child = %v, want exit 2\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), `"error":"spool_unavailable"`) || !strings.Contains(out.String(), "file too large") {
		t.Fatalf("output does not report the write failure:\n%s", out.String())
	}
	if s.env.Faults.Hits(sendtest.KeyInit) != 0 || len(s.env.Faults.Patches()) != 0 {
		t.Fatal("a network write happened")
	}
	if left := s.sendStateFiles(); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
}

// E-R4: a damaged copy after a kill: retry refuses (exit 1, spool_corrupt)
// without uploading and without removing anything; `retry --discard` removes
// the record and the copy and says what the server still holds.
func TestInboxSendResumableDamagedCopyThenDiscard(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_RHELPER") != "" {
		t.Skip("helper")
	}
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"big.bin": randomData(t, 9<<20)})
	hold := s.env.Faults.Add(&sendtest.Rule{Method: http.MethodPatch, PathPrefix: "/api/uploads/", Skip: 1,
		Action: sendtest.HoldUnhandled, Hit: make(chan struct{})})
	s.killResumableAt(hold, filepath.Join(root, "big.bin"))
	id := s.journalIDs()[0]
	b, _ := os.ReadFile(s.spoolOf(id))
	b[len(b)-1] ^= 1
	if err := os.WriteFile(s.spoolOf(id), b, 0o600); err != nil {
		t.Fatal(err)
	}
	patches := len(s.env.Faults.Patches())
	code, out, errOut := s.cli("retry", id, "--json", "--config-dir", s.senderCfg)
	if code != 1 || decodeJSON(t, out)["error"] != "spool_corrupt" || !strings.Contains(errOut, "--discard "+id) {
		t.Fatalf("retry = %d %s %s", code, out, errOut)
	}
	if len(s.env.Faults.Patches()) != patches || s.env.Faults.Hits(sendtest.KeyFinalize) != 0 {
		t.Fatal("uploaded from a damaged copy")
	}
	if got, _ := os.ReadFile(s.spoolOf(id)); !bytes.Equal(got, b) {
		t.Fatal("the damaged copy was changed or removed")
	}
	code, out, errOut = s.cli("retry", "--discard", id, "--json", "--config-dir", s.senderCfg)
	if code != 0 || decodeJSON(t, out)["result"] != "discarded" || !strings.Contains(errOut, "partial upload") {
		t.Fatalf("discard = %d %s %s", code, out, errOut)
	}
	if left := s.sendStateFiles(); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
	if s.taskCount() != 0 || s.env.QuotaBytes(s.uid) != 0 {
		t.Fatal("discard queued or completed something")
	}
}

// E-R5: default sends do not spool; --resumable is refused cleanly where no
// copy fits (exit 2, JSON error), before any network request.
func TestInboxSendDefaultStreamsAndResumableHelpIsHonest(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_RHELPER") != "" {
		t.Skip("helper")
	}
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"a.txt": []byte("streamed")})
	var sawCopy bool
	s.env.Faults.SetObserve(func(string) {
		for _, n := range s.sendStateFiles() {
			if strings.Contains(n, ".spool") {
				sawCopy = true
			}
		}
	})
	if code, _, errOut := s.send("--to", s.recvID, filepath.Join(root, "a.txt")); code != 0 {
		t.Fatalf("send = %d %s", code, errOut)
	}
	if sawCopy {
		t.Fatal("a default send wrote a local copy")
	}
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"inbox", "send", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatal(rc)
	}
	flat := strings.Join(strings.Fields(stdout.String()), " ")
	for _, n := range []string{"--resumable", "never written to disk", "rather than being uploaded again",
		"changing them afterwards changes nothing that is sent"} {
		if !strings.Contains(flat, n) {
			t.Errorf("send help omits %q", n)
		}
	}
}

// E-R6 (review r2 finding 2): `inbox sent`, both forms, proves the local
// record directory safe before ANY request.
func TestInboxSentChecksTheRecordDirectoryBeforeAnyRequest(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_RHELPER") != "" {
		t.Skip("helper")
	}
	s := newSendEnv(t)
	dir := filepath.Join(s.senderCfg, "inbox-send")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	for _, args := range [][]string{
		{"sent", "--json", "--config-dir", s.senderCfg},
		{"sent", "0123456789abcdef0123456789abcdef", "--json", "--config-dir", s.senderCfg},
	} {
		before := s.env.Faults.Hits("GET /api/devices")
		code, out, errOut := s.cli(args...)
		if code != 1 || decodeJSON(t, out)["error"] != "local_state" || !strings.Contains(errOut, "writable by other users") {
			t.Fatalf("%v = %d %s %s", args, code, out, errOut)
		}
		if s.env.Faults.Hits("GET /api/devices") != before {
			t.Fatalf("%v made a request before refusing", args)
		}
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := s.cli("sent", "--config-dir", s.senderCfg); code != 0 {
		t.Fatalf("sent on a safe directory = %d %s", code, errOut)
	}
}
