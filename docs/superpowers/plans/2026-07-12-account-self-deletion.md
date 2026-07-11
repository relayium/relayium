# Account Self-Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user delete their own account via the web: email double-opt-in → immediate purge of transient data → 30-day frozen-login grace with reactivation → GC hard-purge with anonymized usage retention.

**Architecture:** Extend `internal/account` (Go + SQLite). Add `users.deleted_at`/`purge_after`/`purge_reminder_sent` columns, a `usage_archive` table, and grace-day settings. New `deletion.go` holds the request/confirm/reactivate handlers and the transient-purge orchestration. Session-issuing login paths gain a `pending_deletion` branch. The existing GC `sweep()` gains reminder + hard-purge passes.

**Tech Stack:** Go stdlib, `database/sql` + SQLite, existing `email_tokens`/mailer/GC/settings infra.

## Global Constraints

- Deletion is soft: confirm sets `deleted_at=now`, `purge_after=now + graceDays*86400`; `deleted_at>0` ⇒ frozen. GC hard-purges when `purge_after>0 && purge_after<=now`.
- Confirmation is email double opt-in: `request` sends a `purpose="delete"` email token; `confirm` (token, no session) triggers the transient purge + starts the clock. Reactivation uses `purpose="reactivate"` tokens.
- On confirm, immediately purge: all sessions (incl. current), cli_tokens, cli_device_auth, devices, magic_tokens, the user's stored_files (+ enqueue blob deletes via `EnqueueNodeDelete`/`pending_node_deletes`), and the user's `nodes`(owner_user_id) + `node_tokens`. Keep only `users` + `identities` + usage rows for the grace window.
- Frozen login: password/OAuth/magic-link auth on a `deleted_at>0` user must NOT issue a session; surface a pending-deletion state carrying `purgeAfter` + a reactivate token.
- Reactivation clears `deleted_at`/`purge_after`/`purge_reminder_sent`; the account is empty (transient data is NOT restored). Same email cannot re-register during grace (registration treats a pending-delete email as taken).
- At purge: fold the user's `usage_monthly` into `usage_archive(period, upload_bytes, download_bytes)` (no user identity), then delete ALL user-linked rows + the `users` row; capture the email BEFORE deleting to send the final notice. Reminder fires once (`purge_reminder_sent`).
- Emails: (opt-in) confirm-deletion; (1) deletion-scheduled (purge date + reactivate link); (2) pre-purge reminder; (3) final deleted notice.
- Reuse existing helpers: `randToken`/`hashToken`/`newID`, `CreateEmailToken`/`UseEmailToken(purpose)`, `RevokeUserSessions`, `EnqueueNodeDelete`, `ListStoredFilesByUser`/`DeleteStoredFile`, settings `settingOr`/`SeedSettings`. `s.db` is the write pool; FKs enforced.
- Go module root is `server/`; run Go commands there. Web tests: `cd web && npx vitest run`.

## File Structure

- `internal/account/store.go` — `User.DeletedAt`/`PurgeAfter` fields; new interface methods (modify).
- `internal/account/sqlite.go` — column migrations, `usage_archive` table, method impls (modify).
- `internal/account/settings.go` — `account_grace_days`/`account_purge_reminder_days` keys + Settings fields + seed (modify).
- `internal/account/deletion.go` — request/confirm/reactivate handlers + service logic (new).
- `internal/account/deletion_test.go` — deletion flow tests (new).
- `internal/account/mailer.go` + the mailer impl — deletion-flow email methods (modify).
- `internal/account/handlers.go` — mount routes; register guard for pending-delete email (modify).
- `internal/account/service.go` / `oauth.go` — `ErrPendingDeletion` in `Login`/`VerifyMagicLink`/OAuth; handler pending-deletion branches (modify).
- `internal/account/gc.go` — reminder + purge passes in `sweep()` (modify).
- `internal/account/gc_test.go` — purge/reminder tests (modify/new).

---

## Task 1: Schema + user lifecycle columns + settings

**Files:** Modify `store.go`, `sqlite.go`, `settings.go`; Test `sqlite_test.go` or a new `deletion_store_test.go`.

**Interfaces:**
- Produces: `User.DeletedAt int64`, `User.PurgeAfter int64`; `usage_archive` table; settings `SettingAccountGraceDays="account_grace_days"` (default 30), `SettingAccountReminderDays="account_purge_reminder_days"` (default 3) with `Settings.AccountGraceDays`/`AccountReminderDays` int64 fields; store methods:
  - `SetAccountDeletion(ctx, userID string, deletedAt, purgeAfter int64) error`
  - `ClearAccountDeletion(ctx, userID string) error` (zeros all three lifecycle cols)
  - `MarkPurgeReminderSent(ctx, userID string, at int64) error`

- [ ] **Step 1: Failing test**

```go
func TestAccountDeletionColumns(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "a@example.com", "")
	if err := st.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatal(err)
	}
	got, _ := st.GetUserByID(ctx, u.ID)
	if got.DeletedAt != 100 || got.PurgeAfter != 100+30*86400 {
		t.Fatalf("deletion cols not persisted: %+v", got)
	}
	if err := st.ClearAccountDeletion(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	got2, _ := st.GetUserByID(ctx, u.ID)
	if got2.DeletedAt != 0 || got2.PurgeAfter != 0 {
		t.Fatalf("clear failed: %+v", got2)
	}
}
```

- [ ] **Step 2: Run → fail** — `cd server && go test ./internal/account/ -run TestAccountDeletionColumns -v` (undefined fields/methods).

- [ ] **Step 3: Implement**
  - `store.go`: add `DeletedAt int64` and `PurgeAfter int64` to `User`; add the three interface methods near the users section.
  - `sqlite.go`: migrations (follow the existing idempotent `ALTER TABLE … duplicate column name`-tolerant idiom):
    ```sql
    ALTER TABLE users ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN purge_after INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN purge_reminder_sent INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS usage_archive (
      period TEXT PRIMARY KEY,
      upload_bytes INTEGER NOT NULL DEFAULT 0,
      download_bytes INTEGER NOT NULL DEFAULT 0
    );
    ```
    Update the users SELECT column list + `scanUser` (or wherever `GetUserByID`/`UpsertUserByEmail` read users) to include `deleted_at, purge_after` IN LOCKSTEP (INSERT/SELECT order). Implement:
    ```go
    func (s *SQLiteStore) SetAccountDeletion(ctx context.Context, userID string, deletedAt, purgeAfter int64) error {
        _, err := s.db.ExecContext(ctx,
            `UPDATE users SET deleted_at=?, purge_after=?, purge_reminder_sent=0 WHERE id=?`,
            deletedAt, purgeAfter, userID)
        return err
    }
    func (s *SQLiteStore) ClearAccountDeletion(ctx context.Context, userID string) error {
        _, err := s.db.ExecContext(ctx,
            `UPDATE users SET deleted_at=0, purge_after=0, purge_reminder_sent=0 WHERE id=?`, userID)
        return err
    }
    func (s *SQLiteStore) MarkPurgeReminderSent(ctx context.Context, userID string, at int64) error {
        _, err := s.db.ExecContext(ctx, `UPDATE users SET purge_reminder_sent=? WHERE id=?`, at, userID)
        return err
    }
    ```
  - `settings.go`: add the two keys, `Settings.AccountGraceDays`/`AccountReminderDays`, read them in `resolveSettings` via `settingOr(ctx, key, s.cfg.X)` with new `Config` fields `AccountGraceDays`(default 30)/`AccountReminderDays`(default 3), and add both to `SeedSettings`. Add matching `main.go` flags mirroring the other settings flags.

- [ ] **Step 4: Run → pass**; then full `go test ./internal/account/`, `go build ./...`, `go vet ./internal/account/`, `gofmt -l` (blank).

- [ ] **Step 5: Commit** — `feat(account): user deletion lifecycle columns + usage_archive + grace settings`

---

## Task 2: `PurgeTransientUserData` store method

**Files:** Modify `store.go`, `sqlite.go`; Test `deletion_store_test.go`.

**Interfaces:**
- Consumes: existing per-user tables.
- Produces: `PurgeTransientUserData(ctx, userID string) (blobs []StoredFile, err error)` — deletes the user's sessions, cli_tokens, cli_device_auth (by user_id), devices, magic_tokens, stored_files rows, and nodes(owner_user_id='user')+their node_tokens; returns the deleted stored_files so the caller enqueues blob deletes. Runs in one transaction.

- [ ] **Step 1: Failing test**

```go
func TestPurgeTransientUserData(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "a@example.com", "")
	_ = st.CreateSession(ctx, Session{ID: newID(), UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40})
	dev, _ := st.UpsertDevice(ctx, Device{ID: newID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	_ = st.CreateCLIToken(ctx, CLIToken{TokenHash: hashToken("t"), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1})
	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1})

	blobs, err := st.PurgeTransientUserData(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blobs) != 1 || blobs[0].BlobKey != "bk" {
		t.Fatalf("expected 1 blob returned, got %+v", blobs)
	}
	if _, ok, _ := st.GetSession(ctx, ""); ok { /* nothing */ }
	files, _ := st.ListStoredFilesByUser(ctx, u.ID)
	devs, _ := st.ListDevices(ctx, u.ID)
	if _, _, ok, _ := st.GetCLITokenUser(ctx, hashToken("t")); ok {
		t.Fatal("cli token should be gone")
	}
	if len(files) != 0 || len(devs) != 0 {
		t.Fatalf("transient data survived: files=%d devs=%d", len(files), len(devs))
	}
	// the users row must still exist (shell survives grace)
	if _, err := st.GetUserByID(ctx, u.ID); err != nil {
		t.Fatalf("user shell should survive: %v", err)
	}
}
```

- [ ] **Step 2: Run → fail** — undefined method.

- [ ] **Step 3: Implement** in `sqlite.go` using a transaction. First `SELECT` the user's stored_files (via the existing `storedFileSelectCols`/`scanStoredFile`) to return them, then delete rows. Delete order respects FKs (children before nothing references users deletion here — users row stays):
```go
func (s *SQLiteStore) PurgeTransientUserData(ctx context.Context, userID string) ([]StoredFile, error) {
    files, err := s.ListStoredFilesByUser(ctx, userID)
    if err != nil {
        return nil, err
    }
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()
    stmts := []string{
        `DELETE FROM sessions WHERE user_id=?`,
        `DELETE FROM cli_tokens WHERE user_id=?`,
        `DELETE FROM cli_device_auth WHERE user_id=?`,
        `DELETE FROM devices WHERE user_id=?`,
        `DELETE FROM magic_tokens WHERE user_id=?`,
        `DELETE FROM stored_files WHERE user_id=?`,
        `DELETE FROM node_tokens WHERE node_id IN (SELECT id FROM nodes WHERE owner_type='user' AND owner_user_id=?)`,
        `DELETE FROM nodes WHERE owner_type='user' AND owner_user_id=?`,
    }
    for _, q := range stmts {
        if _, err := tx.ExecContext(ctx, q, userID); err != nil {
            return nil, err
        }
    }
    if err := tx.Commit(); err != nil {
        return nil, err
    }
    return files, nil
}
```
> Verify the exact `node_tokens` FK column name against the schema (the brief's Task-5/SP2 tables). If `node_tokens` has no `node_id`, adapt the subquery to the actual owning column; grep `CREATE TABLE ... node_tokens`. If `cli_device_auth` has no `user_id` for pending (un-approved) rows, that's fine — the DELETE simply matches the approved ones; note it.

- [ ] **Step 4: Run → pass**; full package + build + vet + gofmt.

- [ ] **Step 5: Commit** — `feat(account): PurgeTransientUserData for deletion confirmation`

---

## Task 3: Request + Confirm flow (+ mailer templates + routes)

**Files:** Create `deletion.go`, `deletion_test.go`; modify `mailer.go` (+ impl), `handlers.go`.

**Interfaces:**
- Consumes: Task 1/2 methods, `CreateEmailToken`/`UseEmailToken`, `EnqueueNodeDelete`, `deleteBlob`-equivalent (the GC uses `g.deleteBlob`; the Service can delete via `s.blobFor(...).Delete` — mirror `handleDeleteFile` in files.go), `resolveSettings`.
- Produces:
  - `Mailer` gains `SendAccountDeletionConfirm(ctx, email, link string) error`, `SendAccountDeletionScheduled(ctx, email, purgeAt int64, reactivateLink string) error`, `SendAccountDeletionReminder(ctx, email, purgeAt int64, reactivateLink string) error`, `SendAccountDeleted(ctx, email string) error`.
  - `POST /api/account/delete/request` (`RequireSession`), `POST /api/account/delete/confirm` (token body).
  - Service methods `RequestAccountDeletion(ctx, userID, email string) error` and `ConfirmAccountDeletion(ctx, rawToken string) error`.

- [ ] **Step 1: Failing test** (drive request→confirm over `svc.Routes()`; reuse `newFileServer`-style setup — build your own e2e helper if needed, and a capturing mailer):

```go
func TestDeleteRequestThenConfirm(t *testing.T) {
	ts, svc, store, mail := newFileServer(t) // reuse existing helper (has blobs + capturing mailer)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "a@example.com", "")
	sess, _ := svc.IssueSession(ctx, u.ID)
	_ = store.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1})

	// request → sends a delete email token, no destructive action
	req := httptestPost(t, ts.URL+"/api/account/delete/request", "", withCookie(sess.ID))
	if req.StatusCode != 200 {
		t.Fatalf("request: %d", req.StatusCode)
	}
	rawToken := mail.lastDeleteToken(t) // capturing mailer exposes the token from the link it "sent"
	if u2, _ := store.GetUserByID(ctx, u.ID); u2.DeletedAt != 0 {
		t.Fatal("request must not set deleted_at")
	}

	// confirm → sets deleted_at/purge_after, purges transient data
	conf := httptestPostJSON(t, ts.URL+"/api/account/delete/confirm", map[string]string{"token": rawToken})
	if conf.StatusCode != 200 {
		t.Fatalf("confirm: %d", conf.StatusCode)
	}
	u3, _ := store.GetUserByID(ctx, u.ID)
	if u3.DeletedAt == 0 || u3.PurgeAfter <= u3.DeletedAt {
		t.Fatalf("confirm should schedule purge: %+v", u3)
	}
	if files, _ := store.ListStoredFilesByUser(ctx, u.ID); len(files) != 0 {
		t.Fatal("stored files should be purged on confirm")
	}
	if _, ok, _ := store.GetSession(ctx, sess.ID); ok {
		t.Fatal("sessions should be revoked on confirm")
	}
}
```
> Build small local test helpers (`httptestPost`, `withCookie`, capturing-mailer accessor) using the existing suite conventions if none exist; the account suite already has a capturing mailer (`capturingMailer`) — extend it to capture the deletion links/tokens.

- [ ] **Step 2: Run → fail** — routes/methods undefined.

- [ ] **Step 3: Implement**
  - `mailer.go`: add the four methods to the `Mailer` interface and implement them in the concrete mailer (mirror `SendPasswordReset`'s template style). Extend `capturingMailer` in tests to record them.
  - `deletion.go`:
    - `RequestAccountDeletion`: `raw := randToken()`; `CreateEmailToken(EmailToken{TokenHash: hashToken(raw), UserID, Email, Purpose:"delete", CreatedAt, ExpiresAt: now+deleteTokenTTL})`; `link := BaseURL + "/account/delete/confirm?token=" + url.QueryEscape(raw)`; `mailer.SendAccountDeletionConfirm(email, link)`. Rate-limit per user/IP (reuse an existing limiter/throttle; if none fits, reuse `registerLimiter` per IP — nil-safe).
    - `ConfirmAccountDeletion`: `tok, ok := UseEmailToken(hashToken(raw), "delete", now)`; `!ok` → `ErrInvalidToken`. If the user is already pending (`DeletedAt>0`) → return nil (idempotent). `st := resolveSettings(ctx)`; `purgeAfter := now + st.AccountGraceDays*86400`. `blobs, _ := PurgeTransientUserData(userID)`; for each blob delete it (mirror `handleDeleteFile`: `bs, err := s.blobFor(ctx, b.NodeID); bs.Delete(...)` else `EnqueueNodeDelete`). `SetAccountDeletion(userID, now, purgeAfter)`. Issue a reactivate token (`purpose="reactivate"`, TTL=grace window) and `mailer.SendAccountDeletionScheduled(email, purgeAfter, reactivateLink)`.
    - Handlers `handleDeleteRequest(w,r,u User)` and `handleDeleteConfirm(w,r)` (reads `{token}`), returning generic 200 / 400 `invalid_or_expired_token`.
  - `handlers.go` `routeMux()`: mount `POST /api/account/delete/request` under `RequireSession`, `POST /api/account/delete/confirm` unauthed. Add `deleteTokenTTL` const (e.g. 1h).

- [ ] **Step 4: Run → pass**; full package + build + vet + gofmt.

- [ ] **Step 5: Commit** — `feat(account): account-deletion request+confirm with transient purge`

---

## Task 4: Frozen login + reactivation + registration guard

**Files:** Modify `service.go` (`Login`, `VerifyMagicLink`), `oauth.go`, `handlers.go` (login handlers + register), `deletion.go` (reactivate); Test `deletion_test.go`.

**Interfaces:**
- Produces: `ErrPendingDeletion` (a sentinel error, optionally carrying `PurgeAfter`); `POST /api/account/reactivate` (token body) → clears deletion + issues a session; a reactivate-token issuer used by both the login pending-deletion branch and the scheduled email.
- The login handlers return, on a pending-delete user: password → JSON `{status:"pending_deletion", purgeAfter, reactivateToken}` (HTTP 200, NO session cookie); magic/OAuth → redirect to `/?account=pending_deletion&token=<reactivateToken>` (NO session cookie).

- [ ] **Step 1: Failing tests**

```go
func TestPasswordLoginFrozenWhenPendingDeletion(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	// create a password user (reuse the register/password path helper) then schedule deletion
	u := mustPasswordUser(t, svc, store, "a@example.com", "correct-horse")
	_ = store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400)
	resp := loginPassword(t, ts.URL, "a@example.com", "correct-horse")
	if resp.status != 200 {
		t.Fatalf("want 200 pending, got %d", resp.status)
	}
	if resp.json["status"] != "pending_deletion" || resp.json["reactivateToken"] == "" {
		t.Fatalf("want pending_deletion+token, got %+v", resp.json)
	}
	if resp.setCookie != "" {
		t.Fatal("no session cookie must be set for a frozen account")
	}
}

func TestReactivateRestoresLogin(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "a@example.com", "correct-horse")
	_ = store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400)
	pending := loginPassword(t, ts.URL, "a@example.com", "correct-horse")
	tok := pending.json["reactivateToken"].(string)
	r := httptestPostJSON(t, ts.URL+"/api/account/reactivate", map[string]string{"token": tok})
	if r.StatusCode != 200 {
		t.Fatalf("reactivate: %d", r.StatusCode)
	}
	if u2, _ := store.GetUserByID(ctx, u.ID); u2.DeletedAt != 0 || u2.PurgeAfter != 0 {
		t.Fatalf("reactivate should clear deletion: %+v", u2)
	}
	// a subsequent login now issues a real session
	ok := loginPassword(t, ts.URL, "a@example.com", "correct-horse")
	if ok.setCookie == "" || ok.json["status"] == "pending_deletion" {
		t.Fatal("login after reactivation should issue a session")
	}
}

func TestRegisterRefusesPendingDeletionEmail(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "a@example.com", "pw12345678")
	_ = store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400)
	resp := register(t, ts.URL, "a@example.com", "another12345")
	if resp.status == 200 {
		t.Fatal("registering a pending-delete email must be refused")
	}
}
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**
  - `service.go`: define `var ErrPendingDeletion = errors.New("account pending deletion")`. In `Login` (password), after credentials verify and the user is loaded but BEFORE `IssueSession`, if `u.DeletedAt > 0` return `ErrPendingDeletion` (do not create a session). Same guard in `VerifyMagicLink` (after resolving the user, before `IssueSession`) and in the OAuth callback (after `u` is resolved, before `IssueSession`).
  - Add a service helper `issueReactivateToken(ctx, userID, email string) (raw string, err error)` creating a `purpose="reactivate"` `email_tokens` row (TTL = grace window) and returning the raw token; and `reactivateLink(raw)` = `BaseURL + "/account/reactivate?token=" + raw`.
  - Handlers:
    - `handlePasswordLogin`: on `errors.Is(err, ErrPendingDeletion)`, load the user (by email→id), mint a reactivate token, and `writeJSON(200, {status:"pending_deletion", purgeAfter, reactivateToken})` with NO cookie.
    - `handleMagicVerify` / `handleGoogleCallback`: on `ErrPendingDeletion`, mint a reactivate token and `http.Redirect` to `/?account=pending_deletion&token=<raw>` (no cookie).
  - `deletion.go`: `handleReactivate(w,r)` reads `{token}`; `tok, ok := UseEmailToken(hashToken(raw), "reactivate", now)`; `!ok` → 400; `ClearAccountDeletion(tok.UserID)`; issue a normal session + `setSessionCookie`; return the user JSON (or `{status:"ok"}`). Idempotent if already active.
  - `handleRegister` / the dedupe path: before creating, if an existing user for that email/canonical has `DeletedAt>0`, refuse with a clear `{error:"account_pending_deletion"}` + hint. (Check in `handleRegister` after the canonical lookup, and/or make `InsertUserDedupedByCanonical` treat a pending-delete canonical as taken — pick the least-invasive spot and note it.)
  - Mount `POST /api/account/reactivate` (unauthed; token authorizes) in `routeMux()`.

- [ ] **Step 4: Run → pass**; full package + build + vet + gofmt.

- [ ] **Step 5: Commit** — `feat(account): frozen login + reactivation + register guard for pending-delete`

---

## Task 5: GC purge + pre-purge reminder + final email

**Files:** Modify `store.go`, `sqlite.go`, `gc.go`; Test `gc_test.go`.

**Interfaces:**
- Produces store methods:
  - `ListUsersToPurge(ctx, now int64) ([]User, error)` — `purge_after>0 AND purge_after<=now`.
  - `ListUsersToRemind(ctx, now, remindWindow int64) ([]User, error)` — `purge_after>0 AND purge_reminder_sent=0 AND purge_after<=now+remindWindow`.
  - `ArchiveAndPurgeUser(ctx, userID string) error` — one transaction: `INSERT INTO usage_archive(period, upload_bytes, download_bytes) SELECT period, upload_bytes, download_bytes FROM usage_monthly WHERE user_id=? ON CONFLICT(period) DO UPDATE SET upload_bytes=upload_bytes+excluded.upload_bytes, download_bytes=download_bytes+excluded.download_bytes;` then DELETE all user-linked rows (identities, sessions, magic_tokens, devices, cli_tokens, cli_device_auth, usage_events, stored_files, upload_events, user_stats, usage_monthly, nodes+node_tokens by owner) then `DELETE FROM users WHERE id=?`.
- `gc.go`: `sweep()` gains a reminder pass and a purge pass; `GC` needs access to the mailer + settings + BaseURL for reminder/final emails (extend the `GC` struct with a `Mailer`/reactivate-link builder, or pass a callback). The wiring in `main.go` that constructs the GC must supply them.

- [ ] **Step 1: Failing test**

```go
func TestGCPurgesDueAccountsAndArchives(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	due, _ := st.UpsertUserByEmail(ctx, "due@example.com", "")
	notyet, _ := st.UpsertUserByEmail(ctx, "later@example.com", "")
	_ = st.RecordMeter(ctx, due.ID, MeterUpload, 500, 1) // populates usage_monthly for a period
	_ = st.SetAccountDeletion(ctx, due.ID, 1, 100)        // purge_after=100
	_ = st.SetAccountDeletion(ctx, notyet.ID, 1, 1<<40)   // far future

	users, _ := st.ListUsersToPurge(ctx, 200)
	if len(users) != 1 || users[0].ID != due.ID {
		t.Fatalf("only the due user should be listed: %+v", users)
	}
	if err := st.ArchiveAndPurgeUser(ctx, due.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetUserByID(ctx, due.ID); err == nil {
		t.Fatal("purged user should be gone")
	}
	if _, err := st.GetUserByID(ctx, notyet.ID); err != nil {
		t.Fatal("not-yet user must survive")
	}
	up, _ := st.ArchivedUsage(ctx) // small test-only reader OR query usage_archive directly
	if up < 500 {
		t.Fatalf("usage should be archived, got %d", up)
	}
}
```
> If a `usage_archive` reader isn't otherwise needed, query the table directly in the test via the store's `*sql.DB` test accessor or add a tiny `ArchivedUsage` test helper — do not add production API just for the test.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** the three store methods (FK-safe delete order; the archive upsert first). Extend `sweep()`:
```go
// pre-purge reminders (once each)
st := ... // resolve grace/reminder settings; remindWindow = reminderDays*86400
toRemind, err := g.Store.ListUsersToRemind(ctx, now, remindWindow)
// for each: g.Mailer.SendAccountDeletionReminder(...); g.Store.MarkPurgeReminderSent(u.ID, now)
// purge due accounts
toPurge, err := g.Store.ListUsersToPurge(ctx, now)
for _, u := range toPurge {
    email := u.Email // capture BEFORE delete
    if err := g.Store.ArchiveAndPurgeUser(ctx, u.ID); err != nil {
        g.Log.Printf("gc: purge user %s: %v", u.ID, err); continue
    }
    _ = g.Mailer.SendAccountDeleted(ctx, email)
}
```
Wire the GC's new dependencies (mailer, settings source, BaseURL for the reminder's reactivate link) in `main.go` where the GC is constructed. Reminder email needs a fresh reactivate link — reuse the same reactivate-token issuer (the GC can call a small closure/service method to mint one).

- [ ] **Step 4: Run → pass**; then FULL suite: `cd server && go build ./... && go vet ./... && go test ./...` and `cd ../web && npx vitest run`. All green.

- [ ] **Step 5: Commit** — `feat(account): GC hard-purge due accounts + pre-purge reminders + usage archive`

---

## Self-Review Notes

- **Spec coverage:** Schema/lifecycle → Task 1. Transient purge → Task 2 (+ blob deletes in Task 3). Request/confirm + double opt-in + scheduled email → Task 3. Frozen login (all 3 auth methods) + reactivation + register guard → Task 4. GC purge + reminder + final email + anonymized archive → Task 5. Email templates → Task 3 (confirm/scheduled) + Task 5 (reminder/final).
- **Type consistency:** `SetAccountDeletion(userID, deletedAt, purgeAfter)` / `ClearAccountDeletion(userID)` / `MarkPurgeReminderSent(userID, at)` used identically in Tasks 1/3/4/5. `User.DeletedAt`/`PurgeAfter` read by login guards (Task 4) are the columns added in Task 1. `PurgeTransientUserData` returns `[]StoredFile` whose blobs Task 3 deletes. `ArchiveAndPurgeUser` (Task 5) deletes the same tables `PurgeTransientUserData` (Task 2) does PLUS identities/usage/user_stats/users.
- **Verify before coding each task:** confirm the exact `node_tokens` owning column and the users SELECT column list in `sqlite.go` before editing (lockstep). Confirm the concrete mailer type name to extend.
- **Out of scope (unchanged from spec):** CLI-initiated deletion, admin deletion/visibility, subscription cancellation, transient-data restore on reactivation, data export.
