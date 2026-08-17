package account

import (
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inbox"
)

func installBrowser(t *testing.T, h *taskHarness, userID string) (*http.Cookie, string) {
	t.Helper()
	session := h.cookie(t, userID)
	resp := h.jsonDo(t, http.MethodPost, "/api/devices/browser-install", `{}`,
		func(r *http.Request) { r.AddCookie(session) })
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("install browser: got %d, want 201", resp.StatusCode)
	}
	if len(resp.Cookies()) != 1 {
		t.Fatalf("install browser set %d cookies, want 1", len(resp.Cookies()))
	}
	c := resp.Cookies()[0]
	if !c.HttpOnly || c.Secure != h.svc.CookieSecure() || c.SameSite != http.SameSiteStrictMode || c.Path != "/api/" {
		t.Fatalf("unsafe browser credential cookie: %+v", c)
	}
	body := decodeJSONBody(t, resp)
	if _, leaked := body["access_token"]; leaked {
		t.Fatal("browser credential leaked in response body")
	}
	return c, body["deviceId"].(string)
}

func TestBrowserSenderIdentityIsAuthenticatedStableAndRevocable(t *testing.T) {
	h := newTaskHarness(t)
	h.svc.cfg.BaseURL = "https://relayium.com"
	u := h.user(t, "browser-source@example.test")
	target := h.enrolTarget(t, u, "target", inbox.AutoAcceptAuto, true)
	session := h.cookie(t, u)
	deviceCookie, sourceID := installBrowser(t, h, u)
	withBrowser := func(r *http.Request) { r.AddCookie(session); r.AddCookie(deviceCookie) }

	fileID := h.storedObject(t, u, 64, time.Hour)
	created := h.createTask(t, target.deviceID, createOpts{idem: "browser-source-1", fileID: fileID,
		keyID: target.keyID, keyGen: target.keyGen, authMutate: withBrowser})
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d", created.StatusCode)
	}
	if got := decodeJSONBody(t, created)["task"].(map[string]any)["SourceDeviceID"]; got != sourceID {
		t.Fatalf("source = %v, want authenticated %s", got, sourceID)
	}
	claimed, _ := h.claimOne(t, target)
	if got := claimed["SourceDeviceID"]; got != sourceID {
		t.Fatalf("claim source = %v, want authenticated %s", got, sourceID)
	}
	otherSource := h.bearer(t, u, "other-source")
	conflict := h.createTask(t, target.deviceID, createOpts{idem: "browser-source-1", fileID: fileID,
		keyID: target.keyID, keyGen: target.keyGen, authMutate: withBearer(otherSource)})
	if conflict.StatusCode != http.StatusConflict || apiErrorCode(t, conflict) != "idempotency_key_conflict" {
		t.Fatalf("same idempotency from another source = %d", conflict.StatusCode)
	}
	if err := h.store.RenameDevice(created.Request.Context(), sourceID, u, "Renamed browser"); err != nil {
		t.Fatal(err)
	}
	fileID2 := h.storedObject(t, u, 64, time.Hour)
	replay := h.createTask(t, target.deviceID, createOpts{idem: "browser-source-2", fileID: fileID2,
		keyID: target.keyID, keyGen: target.keyGen, authMutate: withBrowser})
	if got := decodeJSONBody(t, replay)["task"].(map[string]any)["SourceDeviceID"]; got != sourceID {
		t.Fatalf("rename changed identity to %v", got)
	}

	if err := h.store.DeleteDevice(created.Request.Context(), sourceID, u); err != nil {
		t.Fatal(err)
	}
	fileID3 := h.storedObject(t, u, 64, time.Hour)
	refused := h.createTask(t, target.deviceID, createOpts{idem: "browser-source-3", fileID: fileID3,
		keyID: target.keyID, keyGen: target.keyGen, authMutate: withBrowser})
	if refused.StatusCode != http.StatusConflict || apiErrorCode(t, refused) != "sender_device_required" {
		t.Fatalf("revoked create = %d, want sender_device_required", refused.StatusCode)
	}
	installAgain := h.jsonDo(t, http.MethodPost, "/api/devices/browser-install", `{}`, withBrowser)
	if installAgain.StatusCode != http.StatusConflict || apiErrorCode(t, installAgain) != "browser_device_revoked" {
		t.Fatalf("revoked automatic reinstall = %d", installAgain.StatusCode)
	}
	if got := installAgain.Cookies(); len(got) != 1 || !got[0].Secure || got[0].Value != "" {
		t.Fatalf("production revocation cookie = %+v", got)
	}
	reinstalled, newSourceID := installBrowser(t, h, u)
	if reinstalled.Value == deviceCookie.Value || newSourceID == sourceID {
		t.Fatal("explicit reinstall reused a revoked credential or device identity")
	}
}

func TestBrowserInstallCookieSupportsLocalhostWithoutWeakeningHTTPS(t *testing.T) {
	h := newTaskHarness(t)
	h.svc.cfg.BaseURL = "http://localhost:8080"
	u := h.user(t, "browser-localhost@example.test")
	cookie, sourceID := installBrowser(t, h, u)
	if cookie.Secure {
		t.Fatal("localhost browser credential unexpectedly requires Secure")
	}
	if err := h.store.DeleteDevice(t.Context(), sourceID, u); err != nil {
		t.Fatal(err)
	}
	session := h.cookie(t, u)
	resp := h.jsonDo(t, http.MethodPost, "/api/devices/browser-install", `{}`,
		func(r *http.Request) { r.AddCookie(session); r.AddCookie(cookie) })
	if got := resp.Cookies(); len(got) != 1 || got[0].Secure || got[0].Value != "" {
		t.Fatalf("localhost revocation cookie = %+v", got)
	}
}

func TestConcurrentBrowserEnrollmentIsTransactionallyBounded(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "browser-cap@example.test")
	var wg sync.WaitGroup
	results := make(chan error, MaxBrowserDevicesPerAccount+8)
	for i := 0; i < cap(results); i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := h.store.RegisterBrowserDevice(t.Context(), BrowserDeviceRegistration{
				UserID: u, DeviceID: authx.NewID(), TokenHash: authx.HashToken(authx.RandToken()),
				Name: "Web browser", At: h.nowUnix(),
			})
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)
	created, limited := 0, 0
	for err := range results {
		switch {
		case err == nil:
			created++
		case errors.Is(err, ErrBrowserDeviceLimit):
			limited++
		default:
			t.Fatalf("registration error: %v", err)
		}
	}
	if created != MaxBrowserDevicesPerAccount || limited != 8 {
		t.Fatalf("created=%d limited=%d", created, limited)
	}
}

func TestBrowserSenderCannotCrossAccountsOrAssertSourceInBody(t *testing.T) {
	h := newTaskHarness(t)
	first := h.user(t, "browser-first@example.test")
	second := h.user(t, "browser-second@example.test")
	deviceCookie, firstSourceID := installBrowser(t, h, first)
	target := h.enrolTarget(t, second, "second-target", inbox.AutoAcceptAuto, true)
	secondSession := h.cookie(t, second)
	wrongAccount := func(r *http.Request) { r.AddCookie(secondSession); r.AddCookie(deviceCookie) }
	fileID := h.storedObject(t, second, 32, time.Hour)
	resp := h.createTask(t, target.deviceID, createOpts{idem: "cross-account-source", fileID: fileID,
		keyID: target.keyID, keyGen: target.keyGen, authMutate: wrongAccount})
	if resp.StatusCode != http.StatusConflict || apiErrorCode(t, resp) != "sender_device_required" {
		t.Fatalf("wrong-account browser credential = %d", resp.StatusCode)
	}
	separate := h.jsonDo(t, http.MethodPost, "/api/devices/browser-install", `{}`, wrongAccount)
	if separate.StatusCode != http.StatusCreated || decodeJSONBody(t, separate)["deviceId"] == firstSourceID {
		t.Fatal("account switch reused the prior account's device identity")
	}

	validCookie, _ := installBrowser(t, h, second)
	valid := func(r *http.Request) { r.AddCookie(secondSession); r.AddCookie(validCookie) }
	forged := h.createTask(t, target.deviceID, createOpts{idem: "forged-source", fileID: fileID,
		keyID: target.keyID, keyGen: target.keyGen, authMutate: valid,
		extraJSON: `,"sourceDeviceId":"attacker-chosen"`})
	if forged.StatusCode != http.StatusBadRequest {
		t.Fatalf("forged source field = %d, want 400", forged.StatusCode)
	}
}

func TestInboxTaskSchemaRejectsNewLegacyEmptySource(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "source-schema@example.test")
	target := h.enrolTarget(t, u, "target", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 32, time.Hour)
	_, _, err := h.store.CreateInboxTask(t.Context(), InboxTask{ID: "empty-source", UserID: u,
		TargetDeviceID: target.deviceID, StoredFileID: fileID, IdempotencyKey: "empty-source",
		WrapAlgorithm: inbox.KeyAlgX25519SealedBoxV1, WrappedKey: sealedKey("empty-source"),
		TargetKeyID: target.keyID, TargetKeyGeneration: target.keyGen, CreatedAt: h.nowUnix()})
	if err == nil {
		t.Fatal("new task with an empty source was stored")
	}
	if _, err := h.store.db.Exec(`INSERT INTO inbox_tasks
		(id,user_id,target_device_id,source_device_id,idempotency_key,stored_file_id,enc_manifest,
		 wrap_algorithm,wrapped_key,target_key_id,target_key_generation,ciphertext_bytes,state,
		 created_at,updated_at,expires_at)
		 VALUES ('foreign-source',?,?,?,?,?,?,?,?,?,?,0,'queued',?,?,?)`,
		u, target.deviceID, "another-account-device", "foreign-source", fileID, []byte("opaque"),
		inbox.KeyAlgX25519SealedBoxV1, sealedKey("foreign"), target.keyID, target.keyGen,
		h.nowUnix(), h.nowUnix(), h.nowUnix()+3600); err == nil {
		t.Fatal("database accepted a source device not owned by the task account")
	}
	// Simulate the migration boundary: an old empty-source row already exists
	// before the v3 guards are installed. Creating the guards must preserve it,
	// while every later empty-source insert remains impossible.
	for _, name := range []string{"inbox_tasks_source_required_insert", "inbox_tasks_source_immutable_update",
		"inbox_tasks_source_owned_insert"} {
		if _, err := h.store.db.Exec(`DROP TRIGGER ` + name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.store.db.Exec(`INSERT INTO inbox_tasks
		(id,user_id,target_device_id,source_device_id,idempotency_key,stored_file_id,enc_manifest,
		 wrap_algorithm,wrapped_key,target_key_id,target_key_generation,ciphertext_bytes,state,
		 created_at,updated_at,expires_at)
		 VALUES ('legacy-empty',?,?, '',?,?,?,?,?,?,?,0,'queued',?,?,?)`,
		u, target.deviceID, "legacy-empty", fileID, []byte("opaque"), inbox.KeyAlgX25519SealedBoxV1,
		sealedKey("legacy"), target.keyID, target.keyGen, h.nowUnix(), h.nowUnix(), h.nowUnix()+3600); err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}
	guards := []string{
		`CREATE TRIGGER inbox_tasks_source_required_insert BEFORE INSERT ON inbox_tasks
		 WHEN NEW.source_device_id = '' BEGIN SELECT RAISE(ABORT, 'inbox task source device required'); END`,
		`CREATE TRIGGER inbox_tasks_source_immutable_update BEFORE UPDATE OF source_device_id ON inbox_tasks
		 WHEN NEW.source_device_id <> OLD.source_device_id
		 BEGIN SELECT RAISE(ABORT, 'inbox task source device immutable'); END`,
		`CREATE TRIGGER inbox_tasks_source_owned_insert BEFORE INSERT ON inbox_tasks WHEN NOT EXISTS
		 (SELECT 1 FROM devices WHERE id = NEW.source_device_id AND user_id = NEW.user_id)
		 BEGIN SELECT RAISE(ABORT, 'inbox task source device not owned'); END`,
	}
	for _, guard := range guards {
		if _, err := h.store.db.Exec(guard); err != nil {
			t.Fatal(err)
		}
	}
	var kept int
	if err := h.store.db.QueryRow(`SELECT count(*) FROM inbox_tasks WHERE id='legacy-empty' AND source_device_id=''`).Scan(&kept); err != nil || kept != 1 {
		t.Fatalf("legacy row was not preserved: count=%d err=%v", kept, err)
	}
	other := h.bearer(t, u, "other-source-mutation")
	var otherID string
	for _, d := range decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(other))) {
		if d.Current {
			otherID = d.ID
		}
	}
	validFileID := h.storedObject(t, u, 32, time.Hour)
	if _, _, err := h.store.CreateInboxTask(t.Context(), InboxTask{ID: "immutable-source", UserID: u,
		TargetDeviceID: target.deviceID, SourceDeviceID: otherID, StoredFileID: validFileID,
		IdempotencyKey: "immutable-source", WrapAlgorithm: inbox.KeyAlgX25519SealedBoxV1,
		WrappedKey: sealedKey("immutable-source"), TargetKeyID: target.keyID,
		TargetKeyGeneration: target.keyGen, CreatedAt: h.nowUnix()}); err != nil {
		t.Fatalf("create immutable source fixture: %v", err)
	}
	for _, source := range []string{"", target.deviceID, "another-account-device"} {
		if _, err := h.store.db.Exec(`UPDATE inbox_tasks SET source_device_id=? WHERE id='immutable-source'`, source); err == nil {
			t.Fatalf("source identity mutated to %q", source)
		}
	}
	if _, err := h.store.db.Exec(`UPDATE inbox_tasks SET updated_at=updated_at+1 WHERE id='immutable-source'`); err != nil {
		t.Fatalf("unrelated task state update blocked: %v", err)
	}
	claimed, _, err := h.store.ClaimInboxTasks(t.Context(), target.deviceID, u, h.nowUnix(), 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range claimed {
		if task.ID == "legacy-empty" || task.SourceDeviceID == "" {
			t.Fatalf("v3 claim exposed legacy unauthenticated source: %+v", task)
		}
	}
}
