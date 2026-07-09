# Abuse-Hardening — Account / Storage / Metering (TDD Plan)

- Date: 2026-07-09
- Spec: `docs/superpowers/specs/2026-07-09-abuse-surface-hardening-design.md` (items H1, H2, H3, M1, M2, M3)
- Out of scope (separate plan): C2, H4, M4, C1.

## Goal

Close the zero-cost abuse paths in the paid/metered surface owned by the `account`,
`storage`, and `metering` packages: rate-limit the two cost endpoints that are
currently un-limited (`/api/ice`, `/api/auth/register`), stop Sybil email
duplicates, use the trusted-proxy IP extractor for all account rate-limit keys,
cap per-account in-flight uploads, harden metering ingestion for restart/gap
resilience + observability, and add a minimum-billable upload size plus a global
disk soft cap.

## Architecture (decided — implement exactly)

- **H3 first (H1 depends on it):** `account.Service` gets an injectable
  `clientIP func(*http.Request) string` field, defaulting to the current
  package-level `clientIP` behavior. `main.go` injects `ipx.IP`. All five
  rate-limit keys (`pwLogins`, `magicRequests`, `verifyRequests`, `resetRequests`,
  `adminLogins`) switch from `clientIP(r)` to `s.clientIP(r)`.
- **H1/H2a limiters:** injected through a tiny **local** interface in the
  `account` package — `type rateLimiter interface{ Allow(string) bool }` — so the
  `account` package does **not** import `signal`. `main.go` constructs
  `*signal.RateLimiter` (which already has `Allow(string) bool`) and injects it.
  (Import decision rationale in the Self-Review; `account` currently does NOT
  import `signal`, only references it in a comment.)
- **H2b canonical dedupe:** new `canonicalEmail` helper + `canonical_email` column
  (idempotent ALTER + one-time Go backfill) + `UserByCanonicalEmail` store method.
  `normEmail` is untouched (login/identity stay exact).
- **M1:** per-account in-flight upload semaphore (`mutex + map[string]int`, max 5),
  acquired at the top of the upload handler.
- **M2:** ingestion is already cumulative-idempotent (`RecordUsage` keeps MAX per
  `alloc_id`); add a silent-pipe watchdog (last-event timestamp + warning log) and
  an optional injectable reconciliation pass; document the unrecoverable residual.
- **M3a:** bill `max(actualBytes, 64<<10)` against `DailyQuota`, store actual size.
- **M3b:** injectable disk-usage source (`func() (used, total uint64, err error)`)
  checked against a configurable high-water mark; over → 503.

## Tech Stack

- Go (module `github.com/relayium/relayium`, code under `server/`).
- Existing deps only: `modernc.org/sqlite`, `github.com/redis/go-redis/v9`,
  `github.com/coder/websocket`, `golang.org/x/crypto`. **No new external deps.**
- All Go commands run from `server/`.

## Global Constraints (verbatim)

- No new external deps (redis/go-redis already present).
- All thresholds are named consts/flags with comments: ICE 5/min, register 5/min,
  upload concurrency 5, min-billable 64 KiB, disk high-water configurable.
- Go commands run from `server/`.
- Do NOT change: `handleICE`'s pair-code→owner logic, the verified-email/quota
  guards already in `handleICE`, session/IDOR/admin auth (audit judged sound), or
  `normEmail`.
- Sequence so H3 (clientIP injection) lands before H1 (which uses `s.clientIP`).

---

### Task 1: H3 — inject trusted-proxy client-IP extractor into account rate limits

**Files:**
- Modify: `server/internal/account/service.go` (add field + setter + default wiring)
- Modify: `server/internal/account/handlers.go` (4 call sites)
- Modify: `server/internal/account/admin.go` (1 call site)
- Modify: `server/main.go` (inject `ipx.IP`)
- Test: `server/internal/account/clientip_inject_test.go` (new)

**Interfaces:**
- Consumes: `func(*http.Request) string` (the extractor, e.g. `(*signal.IPExtractor).IP`).
- Produces: `func (s *Service) SetClientIP(fn func(*http.Request) string)`;
  new struct field `clientIP func(*http.Request) string`.
- Default: `NewService` sets `svc.clientIP = clientIP` (the existing package func at
  `throttle.go:102`), so behavior is identical until injected.

Steps:
- [ ] Write failing test `clientip_inject_test.go`:
      - `TestClientIPDefaultsToPackageFunc`: build `svc := NewService(newTestStore(t), &capturingMailer{}, Config{})`; craft
        `r := httptest.NewRequest("GET","/",nil); r.RemoteAddr = "203.0.113.9:1234"`;
        assert `svc.clientIP(r) == "203.0.113.9"` and that with header
        `r.Header.Set("X-Forwarded-For","1.2.3.4")` it returns `"1.2.3.4"` (mirrors the
        current trust-XFF default so existing throttle tests are unchanged).
      - `TestClientIPInjectedExtractorIsUsed`: build a `signal.NewIPExtractor(nil)`
        (loopback-only trust), `svc.SetClientIP(ipx.IP)`; with `r.RemoteAddr =
        "203.0.113.9:1234"` and `X-Forwarded-For: 1.2.3.4`, assert
        `svc.clientIP(r) == "203.0.113.9"` (untrusted peer's XFF ignored); then with
        `r.RemoteAddr = "127.0.0.1:9"` + same XFF assert `== "1.2.3.4"` (loopback
        trusted). Import `github.com/relayium/relayium/internal/signal`.
- [ ] Run to fail: `cd server && go test ./internal/account/ -run TestClientIP` (compile error: no `clientIP` field / `SetClientIP`).
- [ ] Implement in `service.go`:
      - Add field to `Service` struct (below `pairCodeOwner`):
        ```go
        // clientIP resolves the request's rate-limit key IP. Defaults to the
        // package clientIP (trusts XFF's left entry — legacy behavior kept so
        // existing tests are unchanged); main.go injects signal.IPExtractor.IP,
        // which only trusts XFF from configured/loopback proxies (H3).
        clientIP func(*http.Request) string
        ```
      - In `NewService`, after building `svc`, add `svc.clientIP = clientIP` (before
        `svc.fetchGoogleUser = ...`).
      - Add setter:
        ```go
        // SetClientIP overrides how per-IP rate-limit keys are derived. main.go
        // injects the trusted-proxy-aware signal.IPExtractor.IP so a forged
        // X-Forwarded-For from an untrusted peer can't dodge the throttles (H3).
        func (s *Service) SetClientIP(fn func(*http.Request) string) {
            if fn != nil {
                s.clientIP = fn
            }
        }
        ```
- [ ] Replace call sites: `handlers.go` lines 208, 363, 427, 449 and `admin.go` line
      121 change `clientIP(r)` → `s.clientIP(r)`. (Leave `throttle.go`'s package func
      `clientIP` in place — it is now the default implementation.)
- [ ] In `main.go`, immediately after `acct.SetPairCodeOwner(pairReg.OwnerOf)` add:
      `acct.SetClientIP(ipx.IP) // H3: trusted-proxy-aware rate-limit keys`
- [ ] Run to pass: `cd server && go test ./internal/account/ && go build ./...`
- [ ] Run the full existing throttle suite to prove no regression:
      `cd server && go test ./internal/account/ -run 'Throttle|ClientIP|Admin'`
- [ ] Commit: `H3: inject trusted-proxy client-IP extractor into account rate limits`

---

### Task 2: H1 — rate-limit `/api/ice` (5/min/IP)

**Files:**
- Modify: `server/internal/account/service.go` (limiter field + setter + local interface)
- Modify: `server/internal/account/turn.go` (check at top of `handleICE`)
- Modify: `server/main.go` (construct + inject + Run)
- Test: `server/internal/account/ice_ratelimit_test.go` (new)

**Interfaces:**
- Produces: `type rateLimiter interface { Allow(key string) bool }` (unexported,
  package `account`); field `iceLimiter rateLimiter`; setter
  `func (s *Service) SetICELimiter(rl rateLimiter)`.
- Consumes: `*signal.RateLimiter` from `main.go` (already satisfies `Allow(string) bool`).

Steps:
- [ ] Write failing test `ice_ratelimit_test.go`:
      - Fake limiter `type fakeLimiter struct{ n, limit int }` with
        `func (f *fakeLimiter) Allow(string) bool { f.n++; return f.n <= f.limit }`.
      - `TestICERateLimited`: `_, svc, _ := newICEServer(t, "secret")`;
        `svc.SetICELimiter(&fakeLimiter{limit: 5})`; issue 5 GETs to `/api/ice`
        (expect 200), 6th expect `http.StatusTooManyRequests`.
      - `TestICENoLimiterUnaffected`: default `newICEServer` (no limiter set); 10 GETs
        all 200 (proves nil-limiter path unchanged).
- [ ] Run to fail: `cd server && go test ./internal/account/ -run TestICE` (no `SetICELimiter`).
- [ ] Implement in `service.go`:
      ```go
      // rateLimiter is the minimal per-key limiter account needs; *signal.RateLimiter
      // satisfies it. Declared locally so the account package need not import signal.
      type rateLimiter interface{ Allow(key string) bool }
      ```
      Add fields to `Service`: `iceLimiter rateLimiter` and `registerLimiter rateLimiter`
      (the latter used by Task 3). Add setters:
      ```go
      // SetICELimiter caps /api/ice at N/window/IP (H1: 5/min). nil = unlimited.
      func (s *Service) SetICELimiter(rl rateLimiter) { s.iceLimiter = rl }
      // SetRegisterLimiter caps POST /api/auth/register per IP (H2a: 5/min). nil = unlimited.
      func (s *Service) SetRegisterLimiter(rl rateLimiter) { s.registerLimiter = rl }
      ```
- [ ] Implement in `turn.go` — at the very top of `handleICE`, BEFORE any existing
      logic (do not touch the pair-code/owner/quota code below):
      ```go
      func (s *Service) handleICE(w http.ResponseWriter, r *http.Request) {
          // H1: brute-forcing the 6-digit pairing code (10^6 space, 15-min TTL) would
          // steal a victim's TURN credentials; cap per-IP attempts. 5/min/IP.
          if s.iceLimiter != nil && !s.iceLimiter.Allow(s.clientIP(r)) {
              writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
              return
          }
          servers := s.stunServers()
          // ...unchanged...
      ```
- [ ] In `main.go`, near the other limiters (after `wsCodeLimiter`), add:
      ```go
      // H1: /api/ice pairing-code → TURN-credential endpoint. 5/min/IP.
      iceLimiter := signal.NewRateLimiter(5, time.Minute, func() int64 { return time.Now().Unix() })
      go iceLimiter.Run(context.Background(), time.Minute)
      ```
      and inside the `else` (DB-available) block, right after `acct.SetClientIP(ipx.IP)`:
      `acct.SetICELimiter(iceLimiter)`
- [ ] Run to pass: `cd server && go test ./internal/account/ -run TestICE && go build ./...`
- [ ] Commit: `H1: rate-limit /api/ice at 5/min/IP`

---

### Task 3: H2a — rate-limit `POST /api/auth/register` (5/min/IP)

**Files:**
- Modify: `server/internal/account/handlers.go` (`handleRegister` top check)
- Modify: `server/main.go` (construct + inject)
- Test: `server/internal/account/register_ratelimit_test.go` (new)
- (Reuses `registerLimiter` field + `SetRegisterLimiter` added in Task 2.)

**Interfaces:**
- Consumes: `rateLimiter` (`*signal.RateLimiter`, 5/min).
- Produces: 429 response before decoding the body / sending any email.

Steps:
- [ ] Write failing test `register_ratelimit_test.go`:
      - `TestRegisterRateLimited`: build a server via `newTestServer(t)` variant that
        exposes the `*Service` (use the existing pattern:
        `store := newTestStore(t); mail := &capturingMailer{}; svc := NewService(store, mail, Config{BaseURL:"http://example.test", SessionTTL: time.Hour}); svc.SetRegisterLimiter(&fakeLimiter{limit:5}); ts := httptest.NewServer(svc.Routes())`).
        POST 5 distinct valid registrations (expect non-429), 6th POST expect
        `http.StatusTooManyRequests`, and assert `mail` recorded no send for the 6th.
      - `TestRegisterNoLimiterUnaffected`: no limiter set; 6 registrations proceed
        (subject only to normal validation).
      - Reuse `fakeLimiter` from Task 2 (same package).
- [ ] Run to fail: `cd server && go test ./internal/account/ -run TestRegister`.
- [ ] Implement in `handlers.go` — first lines of `handleRegister`, before
      `json.NewDecoder(...).Decode(&in)`:
      ```go
      // H2a: POST /api/auth/register sends one verification email per new address,
      // so an un-limited endpoint is an email bomb + Sybil mint. 5/min/IP.
      if s.registerLimiter != nil && !s.registerLimiter.Allow(s.clientIP(r)) {
          writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests"})
          return
      }
      ```
- [ ] In `main.go`, alongside `iceLimiter`:
      ```go
      // H2a: register endpoint (email-bomb + Sybil surface). 5/min/IP.
      registerLimiter := signal.NewRateLimiter(5, time.Minute, func() int64 { return time.Now().Unix() })
      go registerLimiter.Run(context.Background(), time.Minute)
      ```
      and after `acct.SetICELimiter(iceLimiter)`: `acct.SetRegisterLimiter(registerLimiter)`
- [ ] Run to pass: `cd server && go test ./internal/account/ -run TestRegister && go build ./...`
- [ ] Commit: `H2a: rate-limit POST /api/auth/register at 5/min/IP`

---

### Task 4: H2b — anti-Sybil canonical-email dedupe on register

**Files:**
- Create: `server/internal/account/canonical.go` (`canonicalEmail` helper)
- Modify: `server/internal/account/sqlite.go` (schema col, ALTER + backfill migration,
  set canonical on insert, new `UserByCanonicalEmail`)
- Modify: `server/internal/account/store.go` (add `UserByCanonicalEmail` to `Store`)
- Modify: `server/internal/account/password.go` (`Register` dup-check)
- Test: `server/internal/account/canonical_test.go` (new)
- Test: `server/internal/account/register_dedupe_test.go` (new)

**Interfaces:**
- Produces: `func canonicalEmail(email string) string`;
  `func (s *SQLiteStore) UserByCanonicalEmail(ctx context.Context, canonical string) (User, bool, error)`;
  `Store.UserByCanonicalEmail(ctx, canonical) (User, bool, error)`.
- Consumes (in `Register`): `s.store.UserByCanonicalEmail` returning `ok=true` →
  reject with the existing `ErrEmailTaken` (same anti-enum path, same 409 response).

Steps:
- [ ] Write failing unit test `canonical_test.go` for the pure helper:
      ```
      a@gmail.com          -> a@gmail.com
      a+x@gmail.com        -> a@gmail.com
      a.b@gmail.com        -> ab@gmail.com
      ab@gmail.com         -> ab@gmail.com
      A.B+tag@GoogleMail.com -> ab@googlemail.com   (dots stripped for googlemail too)
      a.b@example.com      -> a.b@example.com        (non-gmail: dots NOT merged)
      a+x@example.com      -> a@example.com          (all domains: +tag stripped)
      "  A@B.com  "        -> a@b.com                 (trim + lowercase)
      notanemail           -> notanemail             (no '@': lowercased, returned as-is)
      ```
- [ ] Run to fail: `cd server && go test ./internal/account/ -run TestCanonicalEmail` (undefined `canonicalEmail`).
- [ ] Implement `canonical.go`:
      ```go
      package account

      import "strings"

      // canonicalEmail folds an address to the form used ONLY for anti-Sybil
      // register dedupe (NOT for login/identity — normEmail stays exact). It lowercases
      // and trims, strips a "+tag" suffix from the local part for ALL domains, and for
      // gmail.com / googlemail.com additionally removes dots from the local part
      // (Gmail treats "a.b" and "ab" as the same mailbox). Input without '@' is just
      // lowercased+trimmed and returned unchanged.
      func canonicalEmail(email string) string {
          e := strings.ToLower(strings.TrimSpace(email))
          at := strings.LastIndex(e, "@")
          if at < 0 {
              return e
          }
          local, domain := e[:at], e[at+1:]
          if i := strings.IndexByte(local, '+'); i >= 0 {
              local = local[:i]
          }
          if domain == "gmail.com" || domain == "googlemail.com" {
              local = strings.ReplaceAll(local, ".", "")
          }
          return local + "@" + domain
      }
      ```
- [ ] Add `canonical_email` column to the `users` table. In `sqlite.go`:
      - Append to the `users` CREATE TABLE a trailing column so fresh DBs have it:
        `  canonical_email TEXT NOT NULL DEFAULT ''` (add before the closing `)` of the
        `users` table in the `schema` const).
      - In `OpenSQLite`, after the `email_verified` migration block, add an idempotent
        ALTER + one-time Go backfill (mirrors the existing `email_verified` pattern):
        ```go
        // canonical_email backs the anti-Sybil register dedupe (H2b). Freshly added
        // (err==nil) → backfill every existing row's canonical form once; duplicate
        // column name → already migrated, skip.
        if _, err := db.ExecContext(context.Background(),
            `ALTER TABLE users ADD COLUMN canonical_email TEXT NOT NULL DEFAULT ''`); err != nil {
            if !strings.Contains(err.Error(), "duplicate column name") {
                db.Close()
                return nil, err
            }
        } else if err := backfillCanonicalEmail(context.Background(), db); err != nil {
            db.Close()
            return nil, err
        }
        ```
      - Add the backfill helper (reads id+email, writes canonical) in `sqlite.go`:
        ```go
        // backfillCanonicalEmail populates canonical_email for pre-existing rows the
        // one time the column is created. Runs on a freshly-migrated legacy DB only.
        func backfillCanonicalEmail(ctx context.Context, db *sql.DB) error {
            rows, err := db.QueryContext(ctx, `SELECT id, email FROM users`)
            if err != nil {
                return err
            }
            type ue struct{ id, email string }
            var all []ue
            for rows.Next() {
                var u ue
                if err := rows.Scan(&u.id, &u.email); err != nil {
                    rows.Close()
                    return err
                }
                all = append(all, u)
            }
            if err := rows.Err(); err != nil {
                rows.Close()
                return err
            }
            rows.Close()
            for _, u := range all {
                if _, err := db.ExecContext(ctx,
                    `UPDATE users SET canonical_email = ? WHERE id = ?`,
                    canonicalEmail(u.email), u.id); err != nil {
                    return err
                }
            }
            return nil
        }
        ```
      - Set canonical on insert in `UpsertUserByEmail` (the only user-INSERT path;
        used by register + magic + oauth upsert):
        ```go
        u = User{ID: newID(), Email: email, DisplayName: displayName, CreatedAt: time.Now().Unix()}
        _, err = s.db.ExecContext(ctx,
            `INSERT INTO users (id, email, display_name, created_at, canonical_email) VALUES (?, ?, ?, ?, ?)`,
            u.ID, u.Email, u.DisplayName, u.CreatedAt, canonicalEmail(email))
        return u, err
        ```
      - Add the lookup method:
        ```go
        // UserByCanonicalEmail finds any existing account whose canonical_email matches
        // (H2b register dedupe). Multiple legacy exact-emails may share a canonical form,
        // so this returns the first match only — enough to answer "does one exist".
        func (s *SQLiteStore) UserByCanonicalEmail(ctx context.Context, canonical string) (User, bool, error) {
            var u User
            err := s.db.QueryRowContext(ctx,
                `SELECT id, email, display_name, created_at, email_verified
                   FROM users WHERE canonical_email = ? LIMIT 1`, canonical,
            ).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified)
            if err == sql.ErrNoRows {
                return User{}, false, nil
            }
            if err != nil {
                return User{}, false, err
            }
            return u, true, nil
        }
        ```
- [ ] Add to the `Store` interface (`store.go`, in the users block):
      `UserByCanonicalEmail(ctx context.Context, canonical string) (User, bool, error)`
- [ ] Modify `Register` (`password.go`) — after the existing `GetCredentials` dup
      check, before `UpsertUserByEmail`, add the canonical dedupe using the SAME
      `ErrEmailTaken` path:
      ```go
      // H2b: reject a new registration whose canonical form (strip +tag; gmail dot-fold)
      // already belongs to an account, defeating "a+1@gmail / a.b@gmail" Sybil mint.
      // Same ErrEmailTaken → identical 409 response as an exact-duplicate, so existence
      // is not leaked any differently.
      if u, ok, err := s.store.UserByCanonicalEmail(ctx, canonicalEmail(email)); err != nil {
          return User{}, err
      } else if ok && u.ID != "" {
          return User{}, ErrEmailTaken
      }
      ```
- [ ] Write failing integration test `register_dedupe_test.go`:
      - `a@gmail.com` registers (via `Register`), then `a+x@gmail.com` → `ErrEmailTaken`.
      - `a.b@gmail.com` registers, then `ab@gmail.com` → `ErrEmailTaken`.
      - `a.b@example.com` registers, then `a.c@example.com` → NOT taken (different local),
        and `a.b+tag@example.com` → `ErrEmailTaken` (same after +strip, dots preserved).
      - Login path unchanged: register+verify `a.b@gmail.com`, then `Login("a.b@gmail.com", pw)`
        succeeds while `Login("ab@gmail.com", pw)` → `ErrBadCredentials` (identity stays exact).
      - Migration backfill: open a store, insert a legacy user row directly with empty
        `canonical_email` via a second ALTER-free path — simpler: use `newTestStore`,
        `UpsertUserByEmail(ctx,"legacy+tag@gmail.com","")`, then assert
        `UserByCanonicalEmail(ctx,"legacy@gmail.com")` returns ok (proves insert sets
        canonical; backfill logic itself is covered by the ALTER path in a fresh legacy DB).
- [ ] Run to fail then implement then pass:
      `cd server && go test ./internal/account/ -run 'TestCanonicalEmail|TestRegisterDedupe|TestRegisterCanonical'`
- [ ] Run full account + build: `cd server && go test ./internal/account/ && go build ./...`
- [ ] Commit: `H2b: anti-Sybil canonical-email dedupe on register (col + backfill + lookup)`

---

### Task 5: M1 — per-account in-flight upload concurrency cap (5)

**Files:**
- Create: `server/internal/account/uploadsem.go` (the semaphore primitive)
- Modify: `server/internal/account/service.go` (`uploadSem` field + init in `NewService`)
- Modify: `server/internal/account/files.go` (`handleUploadFile` acquire/release)
- Test: `server/internal/account/uploadsem_test.go` (new — unit-tests the primitive)

**Interfaces:**
- Produces:
  ```go
  type uploadSem struct { mu sync.Mutex; inflight map[string]int; max int }
  func newUploadSem(max int) *uploadSem
  func (s *uploadSem) acquire(userID string) bool  // false when at max
  func (s *uploadSem) release(userID string)       // prunes entry at zero
  ```
- Consumes: `u.ID` in `handleUploadFile`.

Steps:
- [ ] Write failing test `uploadsem_test.go` (tests the primitive directly, per spec):
      - `TestUploadSemAcquireReleaseAndCap`: `s := newUploadSem(5)`; acquire 5 times for
        `"u1"` all true; 6th `acquire("u1")` false; `release("u1")`; next `acquire("u1")` true.
      - `TestUploadSemIsolatesAccounts`: fill `"u1"` to max, then `acquire("u2")` true.
      - `TestUploadSemPrunesAtZero`: acquire+release once for `"u3"`; assert
        `len(s.inflight) == 0` (map entry removed at zero so it can't grow unbounded).
      - `TestUploadSemConcurrent`: 50 goroutines acquire/release on one key with the
        real `sync.Mutex`; assert never exceeds `max` (track a peak counter) and ends at 0.
- [ ] Run to fail: `cd server && go test ./internal/account/ -run TestUploadSem`.
- [ ] Implement `uploadsem.go`:
      ```go
      package account

      import "sync"

      // maxConcurrentUploadsPerUser caps in-flight POST /api/files per account (M1).
      // 500 parallel uploads each writing up to MaxFileSize before the quota refuses
      // them is tens of GB of instantaneous disk pressure; 5 is ample for a real user.
      const maxConcurrentUploadsPerUser = 5

      // uploadSem is a per-userID in-flight counter. Entries are pruned at zero so the
      // map is bounded by the set of currently-uploading accounts.
      type uploadSem struct {
          mu       sync.Mutex
          inflight map[string]int
          max      int
      }

      func newUploadSem(max int) *uploadSem {
          return &uploadSem{inflight: map[string]int{}, max: max}
      }

      // acquire reserves an upload slot for userID, returning false if already at max.
      func (s *uploadSem) acquire(userID string) bool {
          s.mu.Lock()
          defer s.mu.Unlock()
          if s.inflight[userID] >= s.max {
              return false
          }
          s.inflight[userID]++
          return true
      }

      // release frees a slot; the map entry is deleted once it hits zero.
      func (s *uploadSem) release(userID string) {
          s.mu.Lock()
          defer s.mu.Unlock()
          if s.inflight[userID] <= 1 {
              delete(s.inflight, userID)
              return
          }
          s.inflight[userID]--
      }
      ```
- [ ] Wire the field in `service.go`: add `uploadSem *uploadSem` to `Service`, and in
      `NewService` set `uploadSem: newUploadSem(maxConcurrentUploadsPerUser)` in the
      struct literal.
- [ ] Guard `handleUploadFile` (`files.go`) — first lines, after the `s.blobs == nil`
      check:
      ```go
      // M1: cap concurrent uploads per account so a burst of parallel writes can't
      // pile MaxFileSize each onto disk before the quota refuses them.
      if !s.uploadSem.acquire(u.ID) {
          w.Header().Set("Retry-After", "1")
          http.Error(w, "too many concurrent uploads", http.StatusTooManyRequests)
          return
      }
      defer s.uploadSem.release(u.ID)
      ```
- [ ] Run to pass: `cd server && go test ./internal/account/ -run 'TestUploadSem|TestUpload' && go build ./...`
- [ ] Commit: `M1: per-account in-flight upload concurrency cap (5)`

---

### Task 6: M2 — metering ingestion robustness (idempotent-verify + observability + reconciliation)

Verification finding (baked into this task): **`RecordUsage` (sqlite.go) already
keeps `MAX(relayed_bytes)` per `alloc_id` (PRIMARY KEY)**, and `UserUsageTotal` /
`UserRelayedSince` SUM across distinct `alloc_id` rows. coturn `--redis-statsdb`
publishes the allocation's **cumulative** `total_traffic` (rcvb+sentb) possibly
multiple times per allocation; keeping the max per alloc is therefore already
idempotent and cumulative — **there is no additive double-count to fix.** M2's real
gaps are (a) silent pipe / restart blindness and (b) events lost while the app is
down. This task adds observability + optional reconciliation and documents the residual.

> IMPLEMENTATION-TIME VERIFICATION ITEM (carry into the code review): confirm on the
> deployed coturn version that (1) `total_traffic` payloads are cumulative-per-allocation
> (the parse in `redis.go` assumes rcvb/sentb are running totals) and (2) whether a live
> allocation list is readable for reconciliation (redis-statsdb is publish-only; the
> coturn CLI/telnet `ps` command is the likely source and is version-dependent). If (1)
> proves to be per-interval deltas instead of cumulative, the keep-max upsert MUST change
> to additive — flag before merging.

**Files:**
- Modify: `server/internal/metering/metering.go` (Worker: last-event tracking + watchdog + reconcile hook)
- Test: `server/internal/metering/watchdog_test.go` (new)
- Test: `server/internal/metering/metering_test.go` (add out-of-order idempotency case)
- Modify: `server/main.go` (start the watchdog goroutine when metering is enabled)
- Docs: `server/internal/metering/metering.go` package/Worker doc note on the residual.

**Interfaces:**
- Produces on `Worker`:
  ```go
  // atomic last-received-event unix seconds + count
  func (w *Worker) LastEventUnix() int64
  func (w *Worker) EventCount() int64
  // Watchdog logs a warning if metering is enabled but no event arrives within silence.
  func (w *Worker) Watchdog(ctx context.Context, check, silence time.Duration)
  ```
- Reconciliation (optional, injectable, no live-Redis dependency in unit tests):
  ```go
  // AllocationLister yields the CURRENT cumulative totals of live coturn allocations,
  // used to fill pub/sub gaps. Implemented over the coturn CLI in a follow-up if the
  // version supports it; nil disables reconciliation.
  type AllocationLister interface {
      LiveAllocations(ctx context.Context) ([]UsageEvent, error)
  }
  func (w *Worker) Reconcile(ctx context.Context, lister AllocationLister) error
  func (w *Worker) ReconcileLoop(ctx context.Context, lister AllocationLister, every time.Duration)
  ```

Steps:
- [ ] Add an out-of-order idempotency test to `metering_test.go` proving no double-count:
      `TestWorkerOutOfOrderKeepsMax`: feed `{a1,1000:tok,999}` then `{a1,1000:tok,100}`;
      assert one record with `RelayedBytes == 999` (the `fakeSink` already mirrors the
      real MAX upsert). This pins the verified cumulative-idempotent behavior.
- [ ] Write failing `watchdog_test.go`:
      - Fake clock: `var clk int64` with `now := func() int64 { return atomic.LoadInt64(&clk) }`.
      - `TestWorkerRecordsLastEvent`: `w` with `Now: now`; `w.handle(...)` a valid event;
        assert `w.LastEventUnix() == <clk>` and `w.EventCount() == 1`.
      - `TestWatchdogWarnsOnSilence`: capture logs via `log.New(buf,...)`; set
        `w.Now` so that "now" is far past the last event (or never any event); run
        `Watchdog` once past `silence`; assert the buffer contains a "no metering events"
        warning. Drive one tick deterministically (call an unexported `w.checkSilence(now, silence)`
        helper directly rather than sleeping) — assert warns when silent, does NOT warn
        right after an event.
      - `TestReconcileFeedsGaps`: fake `AllocationLister` returning
        `[]UsageEvent{{AllocID:"a9", Username:"1:owner.code", RelayedBytes:5000}}`;
        `w.Reconcile(ctx, lister)`; assert the sink recorded `a9` (reconcile routes
        through the same `handle`, so keep-max + attribution are reused).
- [ ] Run to fail: `cd server && go test ./internal/metering/ -run 'TestWorkerRecordsLastEvent|TestWatchdog|TestReconcile|TestWorkerOutOfOrder'`.
- [ ] Implement in `metering.go`:
      - Add atomic fields to `Worker`:
        ```go
        type Worker struct {
            Sink Sink
            Now  func() int64
            Log  *log.Logger
            lastEventUnix atomic.Int64
            eventCount    atomic.Int64
        }
        func (w *Worker) LastEventUnix() int64 { return w.lastEventUnix.Load() }
        func (w *Worker) EventCount() int64    { return w.eventCount.Load() }
        ```
        (import `sync/atomic`, `time`.)
      - In `handle`, on a successfully-recorded event (after `w.Sink.RecordUsage`
        succeeds), set `w.lastEventUnix.Store(rec.RecordedAt)` and
        `w.eventCount.Add(1)`.
      - Add silence check + watchdog:
        ```go
        // checkSilence warns once when metering is wired but has gone quiet for longer
        // than silence — the common blinding case (routine restart / reconnect window),
        // which UserRelayedSince would otherwise under-count with no signal.
        func (w *Worker) checkSilence(now int64, silence time.Duration) {
            last := w.lastEventUnix.Load()
            if last == 0 {
                // No event ever; only warn once the process has been up past the window
                // (caller passes a monotonic "now"; here we treat 0-last as "warn").
                w.Log.Printf("metering: WARNING no relay events received yet (pipe may be down)")
                return
            }
            if now-last > int64(silence.Seconds()) {
                w.Log.Printf("metering: WARNING no relay events for %ds (last=%d); coturn→redis pipe may be down", now-last, last)
            }
        }

        // Watchdog periodically flags a silent metering pipe until ctx is cancelled.
        func (w *Worker) Watchdog(ctx context.Context, check, silence time.Duration) {
            t := time.NewTicker(check)
            defer t.Stop()
            for {
                select {
                case <-ctx.Done():
                    return
                case <-t.C:
                    w.checkSilence(w.Now(), silence)
                }
            }
        }
        ```
      - Add reconciliation hook (routes through existing `handle` for keep-max reuse):
        ```go
        type AllocationLister interface {
            LiveAllocations(ctx context.Context) ([]UsageEvent, error)
        }

        // Reconcile pulls current cumulative totals for live allocations and records
        // them (keep-max upsert dedupes against pub/sub events), filling gaps where a
        // total_traffic message was missed. Best-effort: a lister error is returned to
        // the loop, which logs and retries next tick.
        func (w *Worker) Reconcile(ctx context.Context, lister AllocationLister) error {
            evs, err := lister.LiveAllocations(ctx)
            if err != nil {
                return err
            }
            for _, ev := range evs {
                w.handle(ctx, ev)
            }
            return nil
        }

        func (w *Worker) ReconcileLoop(ctx context.Context, lister AllocationLister, every time.Duration) {
            t := time.NewTicker(every)
            defer t.Stop()
            for {
                select {
                case <-ctx.Done():
                    return
                case <-t.C:
                    if err := w.Reconcile(ctx, lister); err != nil {
                        w.Log.Printf("metering: reconcile pass failed: %v", err)
                    }
                }
            }
        }
        ```
      - Add a package/Worker doc note documenting the residual: "If the app is down for
        an allocation's ENTIRE lifetime AND that allocation closes during the outage, its
        bytes are unrecoverable — pub/sub is fire-and-forget and no closed-allocation
        history is queryable. The reconcile pass only covers allocations still live when
        it runs."
- [ ] Wire the watchdog in `main.go` inside the `if *redisAddr != ""` block, after the
      worker goroutine is launched:
      ```go
      // M2: warn if metering is enabled but the coturn→redis pipe goes silent
      // (routine restart / reconnect gap is the common blinding case).
      const meterSilenceWarn = 5 * time.Minute
      go worker.Watchdog(context.Background(), time.Minute, meterSilenceWarn)
      ```
      (Reconciliation is left wired-but-disabled: no `AllocationLister` is constructed
      until the coturn-version verification item is resolved; document this in the
      commit body.)
- [ ] Run to pass: `cd server && go test ./internal/metering/ && go build ./...`
- [ ] Commit: `M2: metering observability watchdog + reconcile hook; verify cumulative keep-max idempotency`

---

### Task 7: M3a — minimum billable upload size (64 KiB) against DailyQuota

**Files:**
- Modify: `server/internal/account/files.go` (`handleUploadFile` billing)
- Test: `server/internal/account/files_minbill_test.go` (new)

**Interfaces:**
- Produces: quota debit of `max(actualSize, minBillableBytes)` via
  `ReserveUpload(UploadEvent{Bytes: billed, ...})`; `StoredFile.Size` stays actual.
- Consumes: `const minBillableBytes = 64 << 10`.

Steps:
- [ ] Write failing test `files_minbill_test.go` (uses `newFileServer` — note its
      `DailyQuota: 4096`; raise to a known value in a local server build so 64 KiB math
      is clean, e.g. build a service with `DailyQuota: 130 * 1024` ≈ two 64 KiB slots):
      - `TestMinBillableDebitsFloor`: upload a 1-byte ciphertext; then query
        `store.UserUploadedSince(ctx, uid, now-dayWindow)` (or `/api/usage`-adjacent)
        and assert the debit is `65536`, while `/api/files` list / `StoredFile.Size`
        reports `1` (actual stored bytes).
      - `TestMinBillableLargeUsesActual`: upload a 100 KiB ciphertext; assert debit
        `== 102400` (actual, since ≥ 64 KiB).
      - `TestMinBillableCapsCount`: with `DailyQuota` set to `128<<10`, two 1-byte
        uploads succeed (2×64 KiB = quota) and a third returns
        `http.StatusTooManyRequests` (proves small objects are indirectly count-capped).
- [ ] Run to fail: `cd server && go test ./internal/account/ -run TestMinBillable`.
- [ ] Implement in `files.go` — add the const near the top (`maxManifestBytes` block):
      ```go
      // minBillableBytes floors each upload's quota debit (M3a). A near-zero object
      // still costs 64 KiB of the DailyQuota, which caps object COUNT (~DailyQuota/64KiB
      // per day) without a separate hard row limit; actual stored size is unaffected.
      const minBillableBytes = 64 << 10
      ```
      Before the `ReserveUpload` call (after `size` is known from `s.blobs.Put`), compute:
      ```go
      billed := size
      if billed < minBillableBytes {
          billed = minBillableBytes
      }
      ```
      Change the `ReserveUpload` event to bill `billed` while `StoredFile.Size` keeps
      `size`:
      ```go
      ok, err := s.store.ReserveUpload(r.Context(),
          UploadEvent{ID: newID(), UserID: u.ID, Bytes: billed, UploadedAt: now},
          now-dayWindow, st.DailyQuota)
      ```
      Leave `sf.Size = size`, `AddUploadStat(..., size)`, `RecordMeter(..., size, ...)`
      unchanged (stats/display remain actual bytes; only the rolling-24h quota ledger is
      billed at the floor).
      (The cheap Content-Length pre-check at lines 81–93 stays as-is — it is fast-fail
      only and never admits; the authoritative debit is `ReserveUpload` with `billed`.)
- [ ] Run to pass: `cd server && go test ./internal/account/ -run 'TestMinBillable|TestUpload' && go build ./...`
- [ ] Commit: `M3a: minimum billable upload size (64 KiB) against DailyQuota`

---

### Task 8: M3b — global disk soft cap (503 over high-water mark)

**Files:**
- Create: `server/internal/storage/usage.go` (`DiskUsage` via `syscall.Statfs`)
- Modify: `server/internal/account/service.go` (`diskUsage` func field + `blobDiskMax` + setters)
- Modify: `server/internal/account/settings.go`/`service.go` Config: add `BlobDiskMax int64`
  (or accept via setter — see below)
- Modify: `server/internal/account/files.go` (`handleUploadFile` soft-cap check)
- Modify: `server/main.go` (flag `RELAYIUM_BLOB_DISK_MAX`, inject statfs func + max)
- Test: `server/internal/account/files_diskcap_test.go` (new — injects a fake usage source)
- Test: `server/internal/storage/usage_test.go` (new — smoke test on a real temp dir)

**Interfaces:**
- Produces:
  - `func DiskUsage(path string) (used, total uint64, err error)` (storage package).
  - On `Service`: `diskUsage func() (used, total uint64, err error)`; `blobDiskMax int64`;
    setter `func (s *Service) SetDiskGuard(usage func() (used, total uint64, err error), maxBytes int64)`.
- Consumes: injected `func() (used, total uint64, err error)` (real one from `main.go`
  wraps `storage.DiskUsage(blobDir)`); `maxBytes` high-water (0 = disabled).

Steps:
- [ ] Write failing `files_diskcap_test.go`:
      - `TestDiskCapOverThreshold`: build a file server; inject
        `svc.SetDiskGuard(func()(uint64,uint64,error){ return 200, 100, nil }, 100)`
        (used 200 ≥ max 100) → upload returns `http.StatusServiceUnavailable`.
      - `TestDiskCapUnderThreshold`: `SetDiskGuard(func()(uint64,uint64,error){ return 10, 100, nil }, 100)`
        → upload succeeds (200).
      - `TestDiskCapDisabledByDefault`: no `SetDiskGuard` (nil func or max 0) → upload
        succeeds (proves default path unaffected).
      - `TestDiskCapUsageErrorFailsOpen`: usage func returns an error → upload proceeds
        (a Statfs failure must not block all uploads; log-and-allow).
- [ ] Write failing `usage_test.go`: `DiskUsage(t.TempDir())` returns `total > 0`,
      `used <= total`, `err == nil`.
- [ ] Run to fail: `cd server && go test ./internal/account/ -run TestDiskCap && go test ./internal/storage/ -run TestDiskUsage`.
- [ ] Implement `storage/usage.go`:
      ```go
      package storage

      import "syscall"

      // DiskUsage reports used and total bytes of the filesystem backing path, via
      // statfs. used = total - available-to-unprivileged; total = all blocks. Used for
      // the global blob-volume soft cap (account layer decides the threshold).
      func DiskUsage(path string) (used, total uint64, err error) {
          var st syscall.Statfs_t
          if err := syscall.Statfs(path, &st); err != nil {
              return 0, 0, err
          }
          bsize := uint64(st.Bsize)
          total = st.Blocks * bsize
          avail := st.Bavail * bsize
          if avail > total {
              avail = total
          }
          return total - avail, total, nil
      }
      ```
      (Note in commit body: `syscall.Statfs`/`Statfs_t.Bsize` are Unix/darwin+linux —
      matches the deployment target; a `//go:build unix` guard + a fallback file can be
      added if a Windows build is ever needed.)
- [ ] Implement Service wiring in `service.go`:
      - Add fields: `diskUsage func() (used, total uint64, err error)` and `blobDiskMax int64`.
      - Add setter:
        ```go
        // SetDiskGuard enables the global blob-volume soft cap (M3b): when usage reports
        // used >= maxBytes, new uploads are refused with 503. maxBytes<=0 or a nil usage
        // func disables the guard. usage errors fail open (log + allow).
        func (s *Service) SetDiskGuard(usage func() (used, total uint64, err error), maxBytes int64) {
            s.diskUsage = usage
            s.blobDiskMax = maxBytes
        }
        ```
- [ ] Implement the check in `handleUploadFile` (`files.go`), after the M1 semaphore
      acquire (so a rejected upload still releases its slot via the earlier `defer`),
      before reading the manifest:
      ```go
      // M3b: global blob-volume soft cap. Per-account quota × unbounded accounts is
      // still unbounded, so refuse new uploads once the volume crosses the high-water
      // mark. A usage read error fails open (never block every upload on one Statfs blip).
      if s.diskUsage != nil && s.blobDiskMax > 0 {
          if used, _, err := s.diskUsage(); err != nil {
              log.Printf("disk-usage check failed: %v (fail-open, accepting upload)", err)
          } else if used >= uint64(s.blobDiskMax) {
              http.Error(w, "storage temporarily full", http.StatusServiceUnavailable)
              return
          }
      }
      ```
      (Add `"log"` to the `files.go` imports.)
- [ ] Wire `main.go`:
      - Add flag near `blobDir`:
        ```go
        blobDiskMax := flag.Int64("blob-disk-max", envInt64("RELAYIUM_BLOB_DISK_MAX", 0),
            "global blob-volume high-water mark in bytes; new uploads 503 once used >= this (0 disables the global soft cap)")
        ```
      - In the blob-store success branch (after `acct.SetBlobStore(disk)`), add:
        ```go
        // M3b: global disk soft cap over the blob volume (0 = disabled).
        if *blobDiskMax > 0 {
            blobPath := *blobDir
            acct.SetDiskGuard(func() (uint64, uint64, error) { return storage.DiskUsage(blobPath) }, *blobDiskMax)
            log.Printf("global blob-disk soft cap: 503 once %d bytes used on %s volume", *blobDiskMax, blobPath)
        }
        ```
- [ ] Run to pass: `cd server && go test ./internal/account/ -run 'TestDiskCap|TestUpload|TestMinBillable' && go test ./internal/storage/ && go build ./...`
- [ ] Commit: `M3b: global blob-volume disk soft cap (configurable high-water → 503)`

---

## Final verification

- [ ] `cd server && go build ./... && go vet ./... && go test ./...`
- [ ] Manual smoke (optional, gated by env): start with `-redis-addr`, `-blob-disk-max`,
      `-trusted-proxies` set; confirm boot logs show the H3 IP line, the metering
      watchdog is armed, and the disk soft-cap line.

## Self-Review — spec coverage & type consistency

Coverage:
- **H1** (`/api/ice` 5/min) — Task 2. Check at top of `handleICE`; keyed by
  `s.clientIP(r)` (so it inherits H3); default nil-limiter leaves behavior unchanged;
  6th/min → 429. Pair-code/owner/quota logic below is untouched. ✅
- **H2** — register 5/min (Task 3) + canonical dedupe (Task 4). Register limiter checked
  before body decode / email send; canonical dedupe rejects via the SAME `ErrEmailTaken`
  → identical 409 (no differential existence leak); `normEmail` untouched; migration adds
  `canonical_email` with idempotent ALTER + one-time backfill; gmail/googlemail dot-fold,
  +tag strip for all domains, non-gmail dots preserved; login stays exact. ✅
- **H3** (trusted-proxy IP) — Task 1, sequenced FIRST. `Service.clientIP` field defaults
  to the package `clientIP` (existing tests unchanged); `main.go` injects `ipx.IP`; all
  five keys (`pwLogins`/`magicRequests`/`verifyRequests`/`resetRequests`/`adminLogins`)
  switch to `s.clientIP(r)`. H1 & H2a reuse `s.clientIP` — dependency respected. ✅
- **M1** (upload concurrency 5) — Task 5. `uploadSem` primitive unit-tested directly
  (acquire/release/isolation/prune/concurrency); acquired at handler top with
  `Retry-After` + 429; entries pruned at zero. ✅
- **M2** (metering robustness) — Task 6. Verified finding: `RecordUsage` already
  keep-max-per-alloc → cumulative-idempotent, NO additive double-count (tested
  repeat + out-of-order). Adds last-event tracking + silence watchdog (warns on silent
  pipe) + injectable reconcile hook; residual (app down across an allocation's whole
  lifetime) documented; cumulative-vs-delta coturn semantics flagged as an
  implementation-time verification item. ✅
- **M3** — min-bill 64 KiB (Task 7) + global disk soft cap (Task 8). Quota billed
  `max(actual,64KiB)`, actual stored/displayed; small-object count indirectly capped;
  disk usage source injectable (`func()(used,total uint64,error)`) so the 503 path is
  unit-tested without real disk; over → 503, under → accepted, default disabled,
  usage-error fails open. ✅

Type consistency:
- `rateLimiter interface{ Allow(string) bool }` is satisfied by `*signal.RateLimiter`
  (`Allow(key string) bool`); `account` does not import `signal` (interface is local),
  so no import cycle and no new coupling. Setters take the interface; `main.go` passes
  the concrete `*signal.RateLimiter`.
- `clientIP` field type `func(*http.Request) string` matches both the package
  `clientIP` (default) and `(*signal.IPExtractor).IP`.
- `diskUsage` field `func() (used, total uint64, err error)` matches
  `storage.DiskUsage(path)` wrapped in a closure; `blobDiskMax int64` compared to
  `uint64(used)` via explicit conversion.
- New `Store` method `UserByCanonicalEmail(ctx, string) (User, bool, error)` follows the
  existing `GetUserByIdentity` shape; `SQLiteStore` implements it; test fakes (if any)
  must add it — the codebase uses `SQLiteStore` directly in account tests, so no separate
  fake needs updating.
- `AllocationLister.LiveAllocations` returns `[]UsageEvent` (metering's own type),
  reused by `Worker.handle`, so attribution + keep-max are shared with the pub/sub path.
