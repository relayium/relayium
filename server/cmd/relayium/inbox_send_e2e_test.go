//go:build !windows

// Server-only on Windows: this file drives the relay node/account server
// (account, internal/storage — syscall.Statfs), which is not released for
// Windows (.goreleaser.yaml). See the cli-windows job in .github/workflows/go.yml.

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
)

// End-to-end CLI Device Inbox SENDER against the REAL account.Service (SQLite +
// DiskStore) and the REAL CLI receiver (`relayium inbox enable` / `inbox run`).
// Two logins in one account: the sender is never enabled to receive.
//
// Fault injection sits in front of the real handlers (sendtest): it loses real
// answers or answers in the server's place with a status the server can also
// produce. Every positive claim below — queued, saved, bytes on disk — comes
// from the real server and the real receiver.

type sendEnv struct {
	t         *testing.T
	env       *sendtest.Env
	uid       string
	senderCfg string
	recvCfg   string
	recvDir   string
	senderID  string
	recvID    string
	recvTok   string
}

func newSendEnv(t *testing.T) *sendEnv {
	t.Helper()
	env := sendtest.New(t, 32<<20)
	s := &sendEnv{t: t, env: env, uid: env.User("owner@example.com"),
		senderCfg: t.TempDir(), recvCfg: t.TempDir(), recvDir: t.TempDir()}
	senderTok := env.Login(s.uid, "sender-laptop")
	s.recvTok = env.Login(s.uid, "receiver-server")
	s.save(s.senderCfg, senderTok)
	s.save(s.recvCfg, s.recvTok)
	s.senderID = s.currentID(senderTok)
	s.recvID = s.currentID(s.recvTok)
	s.mustCLI("enable", "--dir", s.recvDir, "--config-dir", s.recvCfg)
	return s
}

func (s *sendEnv) save(dir, tok string) {
	if err := cloud.Save(dir, cloud.Creds{Server: s.env.TS.URL, AccessToken: tok, AccountEmail: "owner@example.com"}); err != nil {
		s.t.Fatal(err)
	}
}

func (s *sendEnv) currentID(tok string) string {
	s.t.Helper()
	code, body := s.env.Do(tok, http.MethodGet, "/api/devices", nil)
	if code != 200 {
		s.t.Fatalf("devices: %d", code)
	}
	var out struct{ Devices []inboxclient.Device }
	_ = json.Unmarshal(body, &out)
	for _, d := range out.Devices {
		if d.Current {
			return d.ID
		}
	}
	s.t.Fatal("no current device")
	return ""
}

func (s *sendEnv) cli(args ...string) (int, string, string) {
	var o, e bytes.Buffer
	code := Run(append([]string{"inbox"}, args...), &o, &e)
	return code, o.String(), e.String()
}

func (s *sendEnv) mustCLI(args ...string) string {
	s.t.Helper()
	code, out, errOut := s.cli(args...)
	if code != 0 {
		s.t.Fatalf("relayium inbox %s = %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), code, out, errOut)
	}
	return out
}

// send runs `inbox send` as the sender.
func (s *sendEnv) send(args ...string) (int, string, string) {
	return s.cli(append([]string{"send", "--config-dir", s.senderCfg}, args...)...)
}

func (s *sendEnv) receiveOnce() {
	s.t.Helper()
	s.mustCLI("run", "--once", "--config-dir", s.recvCfg)
}

// task reads one task through the real API as the account.
func (s *sendEnv) task(id string) inboxclient.Task {
	s.t.Helper()
	code, body := s.env.Do(s.recvTok, http.MethodGet, "/api/devices/"+s.recvID+"/inbox/tasks/"+id, nil)
	if code != 200 {
		s.t.Fatalf("get task: %d %s", code, body)
	}
	var out struct{ Task inboxclient.Task }
	_ = json.Unmarshal(body, &out)
	return out.Task
}

func (s *sendEnv) taskCount() int {
	s.t.Helper()
	code, body := s.env.Do(s.recvTok, http.MethodGet, "/api/devices/"+s.recvID+"/inbox/tasks", nil)
	if code != 200 {
		s.t.Fatalf("list tasks: %d", code)
	}
	var out struct{ Tasks []inboxclient.Task }
	_ = json.Unmarshal(body, &out)
	return len(out.Tasks)
}

func (s *sendEnv) journalIDs() []string {
	ents, _ := os.ReadDir(filepath.Join(s.senderCfg, "inbox-send"))
	var ids []string
	for _, e := range ents {
		if n := e.Name(); strings.HasSuffix(n, ".json") && !strings.HasPrefix(n, ".") {
			ids = append(ids, strings.TrimSuffix(n, ".json"))
		}
	}
	return ids
}

func tree(t *testing.T, files map[string][]byte) string {
	t.Helper()
	root := t.TempDir()
	for name, data := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o755); err != nil { // executable on purpose: the receiver must not keep it
			t.Fatal(err)
		}
	}
	return root
}

func decodeJSON(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	dec := json.NewDecoder(strings.NewReader(s))
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("stdout is not one JSON document: %v\n%s", err, s)
	}
	if dec.More() {
		t.Fatalf("stdout has more than one JSON document:\n%s", s)
	}
	return m
}

// E1: file + nested folder + zero-length file → queued (not saved) before the
// receiver runs; the real CLI receiver saves byte-exact, non-executable files;
// `inbox sent <id>` then reports saved. Nothing secret or identifying reaches
// stdout/stderr/JSON.
func TestInboxSendToTheRealCLIReceiver(t *testing.T) {
	s := newSendEnv(t)
	big := make([]byte, 700_000)
	_, _ = rand.Read(big)
	root := tree(t, map[string][]byte{"report.pdf": big, "photos/2026/a.jpg": []byte("jpeg-bytes"), "photos/empty.txt": {}})

	code, out, errOut := s.send("--to", s.recvID, "--json", filepath.Join(root, "report.pdf"), filepath.Join(root, "photos"))
	if code != 0 {
		t.Fatalf("send = %d\n%s\n%s", code, out, errOut)
	}
	doc := decodeJSON(t, out)
	taskID, _ := doc["taskId"].(string)
	if doc["state"] != "queued" || doc["created"] != true || taskID == "" || doc["targetDeviceId"] != s.recvID {
		t.Fatalf("send JSON = %v", doc)
	}
	if !strings.Contains(errOut, "It is not saved yet") {
		t.Fatalf("stderr must say queued is not saved:\n%s", errOut)
	}
	if _, err := os.Stat(filepath.Join(s.senderCfg, "inbox")); !os.IsNotExist(err) {
		t.Fatal("sending created receiver state on the sender")
	}

	s.receiveOnce()
	for name, want := range map[string][]byte{"report.pdf": big, "photos/2026/a.jpg": []byte("jpeg-bytes"), "photos/empty.txt": {}} {
		p := filepath.Join(s.recvDir, filepath.FromSlash(name))
		got, err := os.ReadFile(p)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s: received bytes differ (%v)", name, err)
		}
		if fi, _ := os.Stat(p); fi.Mode().Perm()&0o111 != 0 {
			t.Fatalf("%s: arrived executable (%v)", name, fi.Mode())
		}
	}

	code, sout, serr := s.cli("sent", taskID, "--json", "--config-dir", s.senderCfg)
	if code != 0 {
		t.Fatalf("sent = %d %s", code, serr)
	}
	st := decodeJSON(t, sout)["task"].(map[string]any)
	if st["state"] != "saved" || st["fromThisDevice"] != true {
		t.Fatalf("sent JSON = %v", st)
	}
	// Default listing is line-stable and filters to this device's sends.
	code, lout, _ := s.cli("sent", "--config-dir", s.senderCfg)
	if code != 0 || strings.TrimSpace(lout) != taskID+" "+s.recvID+" saved" {
		t.Fatalf("sent listing = %q", lout)
	}

	// Nothing secret or identifying leaks: not the stored object id, not the
	// idempotency key, not the upload id, not a local path or file name.
	tk := s.task(taskID)
	uploadID := s.env.Faults.Patches()[0].UploadID
	all := out + errOut + sout + serr + lout
	for label, secret := range map[string]string{
		"stored object id": tk.StoredFileID, "idempotency key": tk.IdempotencyKey, "upload id": uploadID,
		"file name": "report.pdf", "folder name": "photos", "local path": root,
	} {
		if secret != "" && strings.Contains(all, secret) {
			t.Fatalf("%s leaked into CLI output", label)
		}
	}
	for k := range doc {
		switch k {
		case "localSendId", "taskId", "targetDeviceId", "state", "errorCode", "created", "ciphertextBytes", "expiresAt", "savedAt":
		default:
			t.Fatalf("unexpected JSON field %q", k)
		}
	}
	if ids := s.journalIDs(); len(ids) != 0 {
		t.Fatalf("journal kept after success: %v", ids)
	}
}

// E6: the current device, enabled, explicitly named as target → saved.
func TestInboxSendToThisVeryDevice(t *testing.T) {
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"note.txt": []byte("to myself")})
	code, out, errOut := s.cli("send", "--config-dir", s.recvCfg, "--to", s.recvID, filepath.Join(root, "note.txt"))
	if code != 0 {
		t.Fatalf("send to self = %d\n%s", code, errOut)
	}
	taskID := strings.Fields(out)[0]
	s.receiveOnce()
	if got, _ := os.ReadFile(filepath.Join(s.recvDir, "note.txt")); string(got) != "to myself" {
		t.Fatal("self-delivery not saved")
	}
	if st := s.task(taskID); st.State != "saved" || st.SourceDeviceID != s.recvID {
		t.Fatalf("task = %+v", st)
	}
}

// E7: targets that cannot receive, cannot be named unambiguously, or are not
// in this account are refused BEFORE any upload opens.
func TestInboxSendRefusesUnusableTargetsBeforeUploading(t *testing.T) {
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"a.txt": []byte("a")})
	file := filepath.Join(root, "a.txt")

	// Another account's device.
	otherTok := s.env.Login(s.env.User("stranger@example.com"), "stranger")
	strangerID := s.currentID(otherTok)
	// A device of this account that never enabled receiving.
	idleID := s.currentID(s.env.Login(s.uid, "idle-box"))
	// Two devices with the same name.
	s.env.Login(s.uid, "twin")
	s.env.Login(s.uid, "twin")

	cases := []struct {
		name string
		to   string
		code int
		want string
	}{
		{"other account", strangerID, 2, "no device in this account"},
		{"ambiguous name", "twin", 2, "devices are named"},
		{"never enabled", idleID, 1, "has not turned on Device Inbox receiving"},
	}
	for _, tc := range cases {
		code, out, errOut := s.send("--to", tc.to, file)
		if code != tc.code || !strings.Contains(errOut, tc.want) || out != "" {
			t.Fatalf("%s: code %d stdout %q stderr %q", tc.name, code, out, errOut)
		}
	}
	// Receive turned off (re-enrol with policy off through the real API).
	c := inboxclient.NewClient(s.env.TS.URL, s.recvTok)
	c.DeviceID = s.recvID
	if _, err := c.Enrol(t.Context(), inboxclient.EnrolRequest{Platform: inboxclient.Platform(), AppVersion: "t",
		ProtocolVersions: inboxclient.ProtocolVersions(), Capabilities: inboxclient.Capabilities(), AutoAccept: "off", ReceiveDirReady: true}); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := s.send("--to", s.recvID, file); code != 1 || !strings.Contains(errOut, "automatic receive is turned off") {
		t.Fatalf("receive off: %d %s", code, errOut)
	}
	// Enrolment cleared by `inbox disable` on the receiver.
	s.mustCLI("disable", "--config-dir", s.recvCfg)
	if code, _, errOut := s.send("--to", s.recvID, file); code != 1 || !strings.Contains(errOut, "nothing was sent") {
		t.Fatalf("disabled: %d %s", code, errOut)
	}
	if n := s.env.Faults.Hits(sendtest.KeyInit); n != 0 {
		t.Fatalf("%d upload sessions were opened for refused targets", n)
	}
}

// E9: content a receiver would refuse, or that would silently shrink, is
// refused with exit 2 and NO request at all.
func TestInboxSendRefusesUnsendableContentWithoutTouchingTheNetwork(t *testing.T) {
	s := newSendEnv(t)
	var requests atomic.Int64
	s.env.Faults.SetObserve(func(string) { requests.Add(1) })
	withLink := tree(t, map[string][]byte{"d/a": []byte("a")})
	_ = os.Symlink("/etc/hosts", filepath.Join(withLink, "d", "hosts"))
	reserved := tree(t, map[string][]byte{"d/aux.txt": []byte("a")})
	dot := tree(t, map[string][]byte{"d/x.": []byte("a")})
	a, b := tree(t, map[string][]byte{"docs/1": []byte("1")}), tree(t, map[string][]byte{"docs/2": []byte("2")})
	for name, args := range map[string][]string{
		"symlink in tree":    {filepath.Join(withLink, "d")},
		"reserved name":      {filepath.Join(reserved, "d")},
		"trailing dot":       {filepath.Join(dot, "d")},
		"duplicate toplevel": {filepath.Join(a, "docs"), filepath.Join(b, "docs")},
	} {
		code, out, errOut := s.send(append([]string{"--to", s.recvID, "--json"}, args...)...)
		if code != 2 || decodeJSON(t, out)["outcome"] != "refused" || errOut == "" {
			t.Fatalf("%s: code %d stdout %q stderr %q", name, code, out, errOut)
		}
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("%d requests were made for content refused locally", n)
	}
}

// E5 at the CLI: a lost finalize answer against today's server exits 3 with
// the local id, never uploads again (not even through retry), and `sent`
// shows the unfinished local send.
func TestInboxSendLostFinalizeExitsUnknownAndNeverReuploads(t *testing.T) {
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"a.bin": bytes.Repeat([]byte("q"), 200_000)})
	s.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.DropResponse})
	code, out, errOut := s.send("--to", s.recvID, "--json", filepath.Join(root, "a.bin"))
	if code != 3 {
		t.Fatalf("send = %d, want 3\n%s", code, errOut)
	}
	doc := decodeJSON(t, out)
	id, _ := doc["localSendId"].(string)
	if doc["outcome"] != "unknown" || doc["error"] != "unknown_outcome" || id == "" {
		t.Fatalf("JSON = %v", doc)
	}
	if !strings.Contains(errOut, "Nothing will be uploaded again automatically") || !strings.Contains(errOut, "relayium inbox retry "+id) {
		t.Fatalf("stderr:\n%s", errOut)
	}
	quota := s.env.QuotaBytes(s.uid)
	if code, lout, _ := s.cli("sent", "--config-dir", s.senderCfg); code != 0 || !strings.Contains(lout, "local "+id+" finalizing") {
		t.Fatalf("sent does not list the unfinished send:\n%s", lout)
	}
	if code, _, _ := s.cli("retry", id, "--config-dir", s.senderCfg); code != 3 {
		t.Fatalf("retry = %d, want 3", code)
	}
	if n := s.env.Faults.Hits(sendtest.KeyInit); n != 1 {
		t.Fatalf("inits = %d; a lost finalize must never upload again", n)
	}
	if q := s.env.QuotaBytes(s.uid); q != quota {
		t.Fatalf("quota %d -> %d", quota, q)
	}
}

// E10 at the CLI: a redirect on init is refused; the redirect target sees
// nothing.
func TestInboxSendRefusesARedirect(t *testing.T) {
	s := newSendEnv(t)
	var elsewhere atomic.Int64
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { elsewhere.Add(1) }))
	defer other.Close()
	s.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/uploads", PathSuffix: "/api/uploads",
		Action: sendtest.Redirect, Location: other.URL + "/api/uploads"})
	root := tree(t, map[string][]byte{"a.txt": []byte("x")})
	code, out, _ := s.send("--to", s.recvID, "--json", filepath.Join(root, "a.txt"))
	if code != 1 || decodeJSON(t, out)["error"] != "redirect_refused" || elsewhere.Load() != 0 {
		t.Fatalf("code %d out %s elsewhere %d", code, out, elsewhere.Load())
	}
}

// E11: the sender process is SIGKILLed (no cleanup, no deferred code) at two
// points, then `inbox retry` finishes from the journal alone.
func TestInboxSendSurvivesSIGKILLAndRetryFinishesFromTheJournal(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_HELPER") != "" {
		t.Skip("helper")
	}
	t.Run("killed while finalize is in flight: unknown, no upload", func(t *testing.T) {
		s := newSendEnv(t)
		hold := s.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/finalize", Action: sendtest.HoldResponse, Hit: make(chan struct{})})
		root := tree(t, map[string][]byte{"a.txt": []byte("x")})
		s.killSenderAt(hold, "--to", s.recvID, filepath.Join(root, "a.txt"))
		ids := s.journalIDs()
		if len(ids) != 1 {
			t.Fatalf("journals = %v", ids)
		}
		if code, _, errOut := s.cli("retry", ids[0], "--config-dir", s.senderCfg); code != 3 {
			t.Fatalf("retry = %d, want 3 (the server cannot confirm)\n%s", code, errOut)
		}
		if s.env.Faults.Hits(sendtest.KeyInit) != 1 || s.taskCount() != 0 {
			t.Fatal("retry uploaded or invented a task")
		}
	})
	t.Run("killed before the create reached central: retry creates it", func(t *testing.T) {
		s := newSendEnv(t)
		hold := s.env.Faults.Add(&sendtest.Rule{Method: http.MethodPost, PathSuffix: "/inbox/tasks", Action: sendtest.HoldUnhandled, Hit: make(chan struct{})})
		root := tree(t, map[string][]byte{"a.txt": []byte("finished by retry")})
		s.killSenderAt(hold, "--to", s.recvID, filepath.Join(root, "a.txt"))
		ids := s.journalIDs()
		if len(ids) != 1 {
			t.Fatalf("journals = %v", ids)
		}
		code, out, errOut := s.cli("retry", ids[0], "--json", "--config-dir", s.senderCfg)
		if code != 0 {
			t.Fatalf("retry = %d\n%s", code, errOut)
		}
		if doc := decodeJSON(t, out); doc["state"] != "queued" || doc["created"] != true {
			t.Fatalf("retry JSON = %v", doc)
		}
		if s.env.Faults.Hits(sendtest.KeyInit) != 1 || s.taskCount() != 1 {
			t.Fatal("want one upload and one task")
		}
		s.receiveOnce()
		if got, _ := os.ReadFile(filepath.Join(s.recvDir, "a.txt")); string(got) != "finished by retry" {
			t.Fatal("not saved")
		}
		if len(s.journalIDs()) != 0 {
			t.Fatal("journal kept after retry completed")
		}
	})
}

// killSenderAt runs `inbox send` in a child process, waits until the held
// request reached the middleware, and SIGKILLs the child.
func (s *sendEnv) killSenderAt(hold *sendtest.Rule, args ...string) {
	s.t.Helper()
	full := append([]string{"inbox", "send", "--config-dir", s.senderCfg}, args...)
	cmd := exec.Command(os.Args[0], "-test.run=^TestInboxSendHelperProcess$", "-test.count=1")
	cmd.Env = append(os.Environ(), "RELAYIUM_INBOX_SEND_HELPER=1", "RELAYIUM_INBOX_SEND_ARGS="+strings.Join(full, "\x1f"))
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		s.t.Fatal(err)
	}
	select {
	case <-hold.Hit:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		s.t.Fatalf("the child never reached the held request:\n%s", out.String())
	}
	if err := cmd.Process.Kill(); err != nil { // SIGKILL on unix
		s.t.Fatal(err)
	}
	_ = cmd.Wait()
	hold.Release()
}

// TestInboxSendHelperProcess is the child of killSenderAt, not a test.
func TestInboxSendHelperProcess(t *testing.T) {
	if os.Getenv("RELAYIUM_INBOX_SEND_HELPER") != "1" {
		t.Skip("helper process only")
	}
	args := strings.Split(os.Getenv("RELAYIUM_INBOX_SEND_ARGS"), "\x1f")
	os.Exit(Run(args, os.Stdout, os.Stderr))
}

// E12: cancel a queued delivery (ciphertext gone with it); a delivery the
// device is receiving right now is reported and left intact; `sent` filters to
// this device's sends unless --all.
func TestInboxCancelAndSentFilters(t *testing.T) {
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"a.txt": []byte("a"), "b.txt": []byte("b")})
	_, out, _ := s.send("--to", s.recvID, filepath.Join(root, "a.txt"))
	queued := strings.Fields(out)[0]
	_, out, _ = s.send("--to", s.recvID, filepath.Join(root, "b.txt"))
	busy := strings.Fields(out)[0]

	if code, cout, _ := s.cli("cancel", queued, "--config-dir", s.senderCfg); code != 0 || strings.TrimSpace(cout) != queued+" cancelled" {
		t.Fatalf("cancel = %d %q", code, cout)
	}
	if code, _ := s.env.Do(s.recvTok, http.MethodGet, "/api/devices/"+s.recvID+"/inbox/tasks/"+queued, nil); code != 404 {
		t.Fatalf("cancelled task still readable: %d", code)
	}

	// Put the other task into `downloading` with a real claim by the device.
	if code, body := s.env.Do(s.recvTok, http.MethodPost, "/api/devices/"+s.recvID+"/inbox/claim", []byte(`{"max":8}`)); code != 200 {
		t.Fatalf("claim: %d %s", code, body)
	}
	code, cout, cerr := s.cli("cancel", busy, "--to", s.recvID, "--json", "--config-dir", s.senderCfg)
	if code != 1 || decodeJSON(t, cout)["error"] != "task_in_progress" || !strings.Contains(cerr, "receiving it now") {
		t.Fatalf("cancel in progress = %d %s %s", code, cout, cerr)
	}
	if st := s.task(busy); st.State != "downloading" {
		t.Fatalf("in-progress task was touched: %s", st.State)
	}

	// A delivery another device sent (the receiver to itself) is shown only
	// with --all.
	_, selfOut, _ := s.cli("send", "--config-dir", s.recvCfg, "--to", s.recvID, filepath.Join(root, "a.txt"))
	other := strings.Fields(selfOut)[0]
	_, def, _ := s.cli("sent", "--config-dir", s.senderCfg)
	_, all, _ := s.cli("sent", "--all", "--config-dir", s.senderCfg)
	if strings.Contains(def, other) || !strings.Contains(all, other) || !strings.Contains(def, busy) {
		t.Fatalf("default:\n%s\nall:\n%s", def, all)
	}
}

// `inbox devices` lists every device with its verdict and marks this one.
func TestInboxDevicesListsVerdicts(t *testing.T) {
	s := newSendEnv(t)
	code, out, _ := s.cli("devices", "--json", "--config-dir", s.senderCfg)
	if code != 0 {
		t.Fatalf("devices = %d", code)
	}
	rows := decodeJSON(t, out)["devices"].([]any)
	seen := map[string]map[string]any{}
	for _, r := range rows {
		m := r.(map[string]any)
		seen[m["id"].(string)] = m
	}
	if r := seen[s.recvID]; r["sendable"] != true || r["current"] != false {
		t.Fatalf("receiver row = %v", r)
	}
	if r := seen[s.senderID]; r["sendable"] != false || r["block"] != "not_enrolled" || r["current"] != true {
		t.Fatalf("sender row = %v", r)
	}
	code, table, _ := s.cli("devices", "--config-dir", s.senderCfg)
	if code != 0 || !strings.Contains(table, "* "+s.senderID) || !strings.Contains(table, s.recvID) {
		t.Fatalf("table:\n%s", table)
	}
	if _, err := os.Stat(filepath.Join(s.senderCfg, "inbox-send")); !os.IsNotExist(err) {
		t.Fatal("devices created sender state")
	}
}

// --wait reports saved only when the device earned it; a wait that ends first
// is exit 4 with the state it saw.
func TestInboxSendWaitTimesOutHonestly(t *testing.T) {
	s := newSendEnv(t)
	root := tree(t, map[string][]byte{"a.txt": []byte("a")})
	code, out, errOut := s.send("--to", s.recvID, "--wait=1s", "--json", filepath.Join(root, "a.txt"))
	if code != 4 {
		t.Fatalf("wait = %d, want 4\n%s", code, errOut)
	}
	if doc := decodeJSON(t, out); doc["state"] == "saved" || doc["taskId"] == "" {
		t.Fatalf("JSON = %v", doc)
	}
}

// --wait's duration bounds a status read that never answers: the command ends
// at its own deadline with exit 4 (not saved) and the last known state — not
// 130, which is reserved for the user's interrupt — instead of sitting on the
// held request until some transport timeout.
func TestInboxSendWaitDeadlineCoversAHeldStatusRead(t *testing.T) {
	s := newSendEnv(t)
	hold := s.env.Faults.Add(&sendtest.Rule{Method: http.MethodGet, PathPrefix: "/api/devices/" + s.recvID + "/inbox/tasks/",
		Action: sendtest.HoldResponse, Hit: make(chan struct{})})
	defer hold.Release()
	root := tree(t, map[string][]byte{"a.txt": []byte("a")})
	start := time.Now()
	code, out, errOut := s.send("--to", s.recvID, "--wait=3s", "--json", filepath.Join(root, "a.txt"))
	elapsed := time.Since(start)
	select {
	case <-hold.Hit:
	default:
		t.Fatal("no status read was held; the test proved nothing")
	}
	if code != 4 {
		t.Fatalf("wait = %d, want 4\n%s", code, errOut)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("--wait=3s returned after %s", elapsed)
	}
	if !strings.Contains(errOut, "Stopped waiting after 3s") {
		t.Fatalf("stderr: %s", errOut)
	}
	if doc := decodeJSON(t, out); doc["state"] != "queued" || doc["taskId"] == "" {
		t.Fatalf("JSON = %v", doc)
	}
}
