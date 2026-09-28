//go:build swiftinterop && !windows

package inboxlive

// TestSwiftLiveFinalizeCentral is the Go half of the Swift Device Inbox
// finalize-recovery acceptance (`InboxFinalizeRecoveryLiveTests`). Like
// TestSwiftLiveInteropCentral it never runs under `go test ./...` (build tag)
// and refuses to run without its interop directory.
//
// It hosts a REAL central — account.Service on a FILE-backed SQLite database, a
// DiskStore, real device logins, and a receiver that really enrols and
// registers an X25519 key — on 127.0.0.1 through sendtest, plus a second
// 127.0.0.1 control listener the Swift test drives:
//
//	POST /fault/drop-finalize?times=N   run the real finalize handler, then hang up (N times)
//	POST /fault/hold-finalize           run the real handler, withhold the answer until /release
//	POST /fault/lose-all-finalize       every finalize is dropped before central sees it, until
//	POST /fault/restore-finalize        retires it and reports how many were intercepted
//	POST /release                       release every held rule (its connection is then dropped)
//	POST /fault/pre-recovery            answer finalize as a server without recovery does
//	POST /fault/earlier-finalize-before?upload=ID&on=patch|finalize
//	                                    run an earlier build's body-less finalize of ID to
//	                                    completion just before the sender's next such request
//	GET  /fault/earlier-finalize-report whether it fired, session state before/after, its answer
//	POST /clock?advance=S               advance central's clock (Service.SetNow)
//	POST /gc                            one real account.GC sweep (with ReapPendingUploads)
//	POST /fault/blobs-unreadable?on=1   make the blob store unreadable (node unreachable); on=0 undoes it
//	POST /remove?id=ID                  Store.DeleteStoredFile — central's own removal
//	POST /probe?upload=ID               one opted-in finalize, bypassing faults and counters
//	GET  /counts                        what central committed, read from its database
//
// Every count is central's: the daily-quota ledger (`upload_events`), stored
// objects, monthly upload bytes, sessions, tasks, blobs on disk, and the
// request middleware's init/PATCH/finalize/status/create counters. Nothing
// here fakes a success: every fault runs, withholds or drops the REAL handler.
//
// The helper serves until stdin reaches EOF, a `stop` file appears, or its
// deadline passes.

import (
	"bufio"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/nacl/box"
	_ "modernc.org/sqlite"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxclient"
	"github.com/relayium/relayium/internal/inboxsend/sendtest"
	"github.com/relayium/relayium/internal/storage"
)

const finalizeLiveDeadline = 300 * time.Second

type bypassTransport struct{ env *sendtest.Env }

func (b bypassTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	b.env.Faults.Bypass(r)
	return http.DefaultTransport.RoundTrip(r)
}

func TestSwiftLiveFinalizeCentral(t *testing.T) {
	dir := os.Getenv("RELAYIUM_SWIFT_FINALIZE_DIR")
	if dir == "" {
		t.Fatal("RELAYIUM_SWIFT_FINALIZE_DIR is required; this helper never runs by accident")
	}
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0o700 {
		t.Fatalf("interop dir must be an existing 0700 directory (err=%v)", err)
	}
	dbPath := filepath.Join(dir, "central.sqlite")
	blobDir := filepath.Join(dir, "blobs")
	if err := os.MkdirAll(blobDir, 0o700); err != nil {
		t.Fatal(err)
	}
	env := sendtest.NewAt(t, 8<<20, dbPath, blobDir)
	uid := env.User("owner@example.com")
	senderTok := env.Login(uid, "swift-sender")
	otherUID := env.User("other@example.com")
	otherTok := env.Login(otherUID, "other-account")

	ctx := context.Background()
	recvTok := env.Login(uid, "receiver-box")
	rc := inboxclient.NewClient(env.TS.URL, recvTok)
	rc.HTTP = &http.Client{Transport: bypassTransport{env}}
	me, err := rc.CurrentDevice(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rc.DeviceID = me.ID
	if _, err := rc.Enrol(ctx, inboxclient.EnrolRequest{
		Platform: inboxclient.Platform(), AppVersion: "test", ProtocolVersions: inboxclient.ProtocolVersions(),
		Capabilities: inboxclient.Capabilities(), AutoAccept: inbox.AutoAcceptAuto, ReceiveDirReady: true,
	}); err != nil {
		t.Fatalf("enrol: %v", err)
	}
	pub, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rc.RegisterKey(ctx, inbox.KeyAlgX25519SealedBoxV1, inbox.EncodePublicKey(pub[:]), ""); err != nil {
		t.Fatalf("register key: %v", err)
	}

	ro, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer ro.Close()

	var clockMu sync.Mutex
	var offset time.Duration
	clock := func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return time.Now().Add(offset) }
	env.Svc.SetNow(clock)

	one := func(q string, args ...any) int64 {
		var n sql.NullInt64
		if err := ro.QueryRow(q, args...).Scan(&n); err != nil {
			return -1
		}
		return n.Int64
	}
	ids := func(q string, args ...any) []string {
		out := []string{}
		rows, err := ro.Query(q, args...)
		if err != nil {
			return out
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			_ = rows.Scan(&id)
			out = append(out, id)
		}
		return out
	}
	counts := func(user string) map[string]any {
		patchBytes := 0
		for _, p := range env.Faults.Patches() {
			patchBytes += len(p.Body)
		}
		bodies := []string{}
		for _, b := range env.Faults.FinalizeBodies() {
			bodies = append(bodies, string(b))
		}
		blobs := 0
		_ = filepath.Walk(blobDir, func(_ string, fi os.FileInfo, err error) error {
			if err == nil && !fi.IsDir() {
				blobs++
			}
			return nil
		})
		return map[string]any{
			"hitsInit":           env.Faults.Hits(sendtest.KeyInit),
			"hitsPatch":          env.Faults.Hits(sendtest.KeyPatch),
			"hitsFinalize":       env.Faults.Hits(sendtest.KeyFinalize),
			"hitsStatus":         env.Faults.Hits(sendtest.KeyStatus),
			"hitsCreate":         env.Faults.Hits(sendtest.KeyCreate),
			"patchBodyBytes":     patchBytes,
			"finalizeBodies":     bodies,
			"quotaBytes":         env.QuotaBytes(user),
			"uploadEventRows":    one(`SELECT COUNT(*) FROM upload_events WHERE user_id = ?`, user),
			"storedFiles":        one(`SELECT COUNT(*) FROM stored_files WHERE user_id = ?`, user),
			"storedFileIds":      ids(`SELECT id FROM stored_files WHERE user_id = ? ORDER BY created_at, id`, user),
			"storedFileBytes":    one(`SELECT SUM(size) FROM stored_files WHERE user_id = ?`, user),
			"monthlyUploadBytes": one(`SELECT SUM(upload_bytes) FROM usage_monthly WHERE user_id = ?`, user),
			"uploadSessions":     one(`SELECT COUNT(*) FROM upload_sessions WHERE user_id = ?`, user),
			"inboxTasks":         one(`SELECT COUNT(*) FROM inbox_tasks WHERE user_id = ?`, user),
			"taskStoredFileIds":  ids(`SELECT stored_file_id FROM inbox_tasks WHERE user_id = ? ORDER BY created_at`, user),
			"blobFiles":          blobs,
		}
	}

	var ruleMu sync.Mutex
	var held []*sendtest.Rule
	finalizeRule := func(action sendtest.Action, times int) *sendtest.Rule {
		return &sendtest.Rule{Method: http.MethodPost, PathPrefix: "/api/uploads/", PathSuffix: "/finalize",
			Times: times, Action: action}
	}
	ctl := http.NewServeMux()
	ctl.HandleFunc("GET /counts", func(w http.ResponseWriter, r *http.Request) {
		user := uid
		if r.URL.Query().Get("as") == "other" {
			user = otherUID
		}
		_ = json.NewEncoder(w).Encode(counts(user))
	})
	ctl.HandleFunc("POST /fault/drop-finalize", func(w http.ResponseWriter, r *http.Request) {
		n := 1
		fmt.Sscanf(r.URL.Query().Get("times"), "%d", &n)
		env.Faults.Add(finalizeRule(sendtest.DropResponse, n))
	})
	ctl.HandleFunc("POST /fault/hold-finalize", func(w http.ResponseWriter, r *http.Request) {
		ruleMu.Lock()
		defer ruleMu.Unlock()
		held = append(held, env.Faults.Add(finalizeRule(sendtest.HoldResponse, 1)))
	})
	// "The finalize never reached central", for a WHOLE attempt: one rule,
	// armed before the attempt starts and retired only after it has returned,
	// that hangs up every finalize without handing it to central (it is
	// released up front, so each request is dropped at once instead of held).
	// No per-request re-arming, so no request can slip through a gap between
	// rules. Every finalize the middleware sees while armed is counted, and
	// the retire answer reports that count plus central's own proof that
	// nothing was finalized (no done session, no object, no task).
	var loseMu sync.Mutex
	var loseRule *sendtest.Rule
	loseSeen := 0
	env.Faults.SetObserve(func(kind string) {
		if kind != sendtest.KeyFinalize {
			return
		}
		loseMu.Lock()
		if loseRule != nil {
			loseSeen++
		}
		loseMu.Unlock()
	})
	ctl.HandleFunc("POST /fault/lose-all-finalize", func(w http.ResponseWriter, r *http.Request) {
		loseMu.Lock()
		defer loseMu.Unlock()
		if loseRule != nil {
			http.Error(w, "already armed", http.StatusConflict)
			return
		}
		rule := env.Faults.Add(finalizeRule(sendtest.HoldUnhandled, 1<<30))
		rule.Release()
		loseRule, loseSeen = rule, 0
	})
	ctl.HandleFunc("POST /fault/restore-finalize", func(w http.ResponseWriter, r *http.Request) {
		loseMu.Lock()
		defer loseMu.Unlock()
		if loseRule == nil {
			http.Error(w, "not armed", http.StatusConflict)
			return
		}
		env.Faults.Retire(loseRule)
		loseRule = nil
		_ = json.NewEncoder(w).Encode(map[string]any{
			"intercepted":  loseSeen,
			"doneSessions": one(`SELECT COUNT(*) FROM upload_sessions WHERE user_id = ? AND done = 1`, uid),
			"storedFiles":  one(`SELECT COUNT(*) FROM stored_files WHERE user_id = ?`, uid),
			"inboxTasks":   one(`SELECT COUNT(*) FROM inbox_tasks WHERE user_id = ?`, uid),
		})
	})
	ctl.HandleFunc("POST /release", func(w http.ResponseWriter, r *http.Request) {
		ruleMu.Lock()
		defer ruleMu.Unlock()
		for _, h := range held {
			h.Release()
		}
		held = nil
	})
	ctl.HandleFunc("POST /fault/pre-recovery", func(w http.ResponseWriter, r *http.Request) {
		env.Faults.EmulatePreRecoveryServer()
	})
	// An earlier build's body-less finalize of `upload`, executed to
	// COMPLETION (its response fully read — the handler has committed or
	// refused) inside the Before hook of the new sender's next request of the
	// given kind for that session: `on=patch` (a continuation of an open
	// session) or `on=finalize` (the new sender's own finalize). The new
	// sender's request then runs the real handler against whatever the earlier
	// finalize left. No timer: the barrier is the earlier request's completed
	// response. The report records that it fired, what state the session was
	// in immediately before and after, and the earlier finalize's answer.
	var earlierMu sync.Mutex
	earlier := map[string]any{"fired": false}
	ctl.HandleFunc("POST /fault/earlier-finalize-before", func(w http.ResponseWriter, r *http.Request) {
		upload := r.URL.Query().Get("upload")
		method, suffix := http.MethodPatch, ""
		if r.URL.Query().Get("on") == "finalize" {
			method, suffix = http.MethodPost, "/finalize"
		}
		sessionState := func() map[string]int64 {
			return map[string]int64{
				"done":     one(`SELECT done FROM upload_sessions WHERE id = ?`, upload),
				"received": one(`SELECT received FROM upload_sessions WHERE id = ?`, upload),
			}
		}
		env.Faults.Add(&sendtest.Rule{Method: method, PathPrefix: "/api/uploads/" + upload, PathSuffix: suffix,
			Action: sendtest.Before, Fn: func(req *http.Request) {
				before := sessionState()
				fr, _ := http.NewRequest(http.MethodPost, env.TS.URL+"/api/uploads/"+upload+"/finalize", nil)
				fr.Header.Set("Authorization", "Bearer "+senderTok)
				env.Faults.Bypass(fr)
				status, body := 0, ""
				if resp, err := http.DefaultClient.Do(fr); err == nil {
					b, _ := io.ReadAll(resp.Body)
					resp.Body.Close()
					status, body = resp.StatusCode, string(b)
				}
				earlierMu.Lock()
				earlier = map[string]any{"fired": true, "triggeredBy": req.Method + " " + req.URL.Path,
					"sessionBefore": before, "earlierStatus": status, "earlierBody": body,
					"sessionAfter": sessionState()}
				earlierMu.Unlock()
			}})
	})
	ctl.HandleFunc("GET /fault/earlier-finalize-report", func(w http.ResponseWriter, r *http.Request) {
		earlierMu.Lock()
		defer earlierMu.Unlock()
		_ = json.NewEncoder(w).Encode(earlier)
	})
	ctl.HandleFunc("POST /clock", func(w http.ResponseWriter, r *http.Request) {
		var n int64
		fmt.Sscanf(r.URL.Query().Get("advance"), "%d", &n)
		clockMu.Lock()
		offset += time.Duration(n) * time.Second
		clockMu.Unlock()
	})
	ctl.HandleFunc("POST /gc", func(w http.ResponseWriter, r *http.Request) {
		disk, err := storage.NewDiskStore(blobDir)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		g := &account.GC{Store: env.Store, Blobs: disk, Now: func() int64 { return clock().Unix() },
			Log: log.New(io.Discard, "", 0), ReapSessions: env.Svc.ReapPendingUploads}
		gctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer cancel()
		g.Run(gctx, time.Hour) // one real sweep, then idle until the timeout
	})
	// Make the blob store unreadable (or readable again): what the reaper sees
	// when a node cannot be reached, which it records as "unresolved" — the
	// state a recovery then answers as outcome "failed".
	ctl.HandleFunc("POST /fault/blobs-unreadable", func(w http.ResponseWriter, r *http.Request) {
		mode := os.FileMode(0o700)
		if r.URL.Query().Get("on") == "1" {
			mode = 0
		}
		if err := os.Chmod(blobDir, mode); err != nil {
			http.Error(w, err.Error(), 500)
		}
	})
	t.Cleanup(func() { _ = os.Chmod(blobDir, 0o700) })
	ctl.HandleFunc("POST /remove", func(w http.ResponseWriter, r *http.Request) {
		if err := env.Store.DeleteStoredFile(context.Background(), r.URL.Query().Get("id"), clock().Unix()); err != nil {
			http.Error(w, err.Error(), 500)
		}
	})
	ctl.HandleFunc("POST /probe", func(w http.ResponseWriter, r *http.Request) {
		req, _ := http.NewRequest(http.MethodPost, env.TS.URL+"/api/uploads/"+r.URL.Query().Get("upload")+"/finalize",
			strings.NewReader(`{"recoverFinalized":true}`))
		req.Header.Set("Authorization", "Bearer "+senderTok)
		req.Header.Set("Content-Type", "application/json")
		env.Faults.Bypass(req)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": resp.StatusCode, "body": string(b)})
	})
	ctlTS := httptest.NewServer(ctl)
	defer ctlTS.Close()
	t.Cleanup(env.Faults.ReleaseAll)

	meta := map[string]string{
		"url": env.TS.URL, "control": ctlTS.URL, "accountId": uid, "senderToken": senderTok,
		"otherAccountId": otherUID, "otherToken": otherTok, "receiverDeviceId": me.ID,
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
	end := time.After(finalizeLiveDeadline)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-eof:
			return
		case <-end:
			t.Fatal("helper deadline reached before the Swift parent finished")
		case <-tick.C:
			if _, err := os.Stat(stop); err == nil {
				return
			}
		}
	}
}
