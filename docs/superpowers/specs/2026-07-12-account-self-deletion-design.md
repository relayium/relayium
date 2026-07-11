# Account Self-Deletion with 30-Day Grace — Design

Date: 2026-07-12
Status: Approved (brainstorming), ready for implementation plan
Sub-project: **A** of the "CLI async sync + account deletion" batch. Sub-project **B**
(CLI cloud async transfer) shipped to origin/main (2026-07-11, bec5b1a).

## Goal

Let a user delete their own account. Deletion is a soft-delete that freezes the
account for a 30-day grace period during which the user can reactivate by logging
in; after the grace period a GC pass hard-purges the account. Transient/live data
is destroyed immediately at confirmation; only the account shell (email/identity)
survives the grace window so the email stays reserved and reactivation is possible.

## Key decisions (locked during brainstorming)

1. **Grace model = freeze login + reactivate-on-login.** During grace the account
   is frozen (no normal session issued); logging in surfaces a "scheduled for
   deletion — reactivate?" state with one-click reactivation. Like Google/GitHub.
2. **Deletion timing = purge transient data on confirmation, purge the shell after
   30 days.** At confirmation: revoke all sessions/CLI tokens, delete active share
   links + their cloud blobs, deregister SP3 self-hosted nodes, clear devices/magic
   tokens. Keep only the `users` row + `identities` (email reserved) + anonymized
   usage for the grace window. After 30 days: hard-delete the shell and all
   remnants.
3. **Post-purge retention = anonymized aggregate only.** At purge, the user's
   `usage_monthly` rows are folded into a `usage_archive` table keyed only by
   period (no user identity), for financial records; everything else is wiped.
4. **Trigger = web personal center only.** The CLI does not touch account
   lifecycle.
5. **Confirmation = email-link double opt-in.** Clicking "delete account" sends a
   confirmation email; clicking its link starts the 30-day clock and the immediate
   transient-data purge. Uniform across password/OAuth/magic-link accounts; reuses
   the existing `email_tokens` infra; resistant to a hijacked live session.
6. **Emails: 3 notifications + 1 opt-in.** (opt-in) confirm-deletion link;
   (1) deletion-scheduled (purge date + reactivate link); (2) pre-purge reminder
   (~3 days before); (3) final deleted notice (after purge).
7. **Reactivation yields an empty account** — files/links/nodes were destroyed at
   confirmation and are not restored. The email/identity and account row persist.

## Rejected alternatives (settled by the brainstorming answers)

- Immediate hard-delete (no grace) — rejected: no undo for mistakes/hijack.
- Retain everything until day 30 (fully reversible) — rejected: leaves live data
  and active share links during grace.

## What already exists (reused, not rebuilt)

- `email_tokens` table + `CreateEmailToken`/`UseEmailToken(purpose)` (verify +
  reset today) — add `purpose="delete"` and `purpose="reactivate"`.
- Mailer with `SendVerification`/`SendReset`/`SendMagicLink` (`internal/account/mailer.go`)
  — add deletion-flow templates.
- GC sweep (`internal/account/gc.go`) that periodically reclaims expired
  sessions/tokens/stored files and drains `pending_node_deletes` — extend it to
  purge due accounts and send reminders. Blob deletion via `deleteBlob` +
  `EnqueueNodeDelete`/`pending_node_deletes`.
- Admin-editable `settings` table (`internal/account/settings.go`) + `clampTTL`
  pattern — add grace/reminder-day settings.
- Session issuance/validation, `RequireSession`, login handlers (password/OAuth/
  magic) in `handlers.go`/`service.go`/`oauth.go`.
- User-linked tables to purge: `identities`, `sessions`, `magic_tokens`,
  `devices`, `usage_events`, `stored_files`, `upload_events`, `user_stats`,
  `usage_monthly`, `nodes`(owner_user_id), `node_tokens`, `cli_tokens`,
  `cli_device_auth`.

## Architecture / units

- **`internal/account/deletion.go`** (new): the three HTTP handlers
  (`request`/`confirm`/`reactivate`), the confirmation/reactivation token issuing,
  and the "immediate transient purge" orchestration. Depends on the store + mailer.
- **`internal/account/store.go` + `sqlite.go`**: `users.deleted_at`/`purge_after`
  columns, `usage_archive` table, and the store methods below.
- **`internal/account/gc.go`**: extend `sweep()` to send pre-purge reminders and
  hard-purge due accounts.
- **`internal/account/mailer.go`**: deletion-flow email templates.
- **`internal/account/handlers.go` + login paths**: mount routes; add the
  `pending_deletion` branch to session-issuing login flows.

## Schema changes

- `users`: add `deleted_at INTEGER NOT NULL DEFAULT 0` (0 = active; else the
  confirmation timestamp) and `purge_after INTEGER NOT NULL DEFAULT 0` (0 =
  active; else the epoch after which GC hard-purges). Add
  `purge_reminder_sent INTEGER NOT NULL DEFAULT 0` (0 = not sent) so the reminder
  fires once.
- `usage_archive`: `period TEXT PRIMARY KEY, upload_bytes INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0` — anonymized period totals, no user
  linkage.
- `settings`: `account_grace_days` (default 30), `account_purge_reminder_days`
  (default 3).
- `email_tokens`: no schema change; new `purpose` values `"delete"`, `"reactivate"`.

## Store methods (new)

- `RequestAccountDeletion` is handler-level; the store primitive is
  `SetAccountDeletion(ctx, userID string, deletedAt, purgeAfter int64) error`
  (sets the columns; also used with zeros to reactivate) — pair with
  `ClearAccountDeletion(ctx, userID) error` for reactivation clarity.
- `PurgeTransientUserData(ctx, userID string) ([]StoredFile, error)` — deletes
  sessions, cli_tokens, cli_device_auth (by user), devices, magic_tokens, the
  user's stored_files rows (returning them so the caller enqueues blob deletes),
  and the user's nodes + node_tokens. Runs in one transaction where practical.
- `ListUsersToPurge(ctx, now int64) ([]User, error)` — `purge_after>0 AND purge_after<=now`.
- `ListUsersToRemind(ctx, remindBefore, now int64) ([]User, error)` —
  `purge_after>0 AND purge_reminder_sent=0 AND purge_after<=now+remindWindow`.
- `MarkPurgeReminderSent(ctx, userID string, at int64) error`.
- `ArchiveAndPurgeUser(ctx, userID string) error` — in one transaction: fold the
  user's `usage_monthly` into `usage_archive` (period-keyed accumulate), then
  delete ALL user-linked rows in FK-safe order and the `users` row.
- `AccountDeletionState(ctx, userID) (deletedAt, purgeAfter int64, err error)` (or
  extend the `User` struct with the two fields so existing loads carry them).

## Flow 1 — Request (web personal center)

`POST /api/account/delete/request` (`RequireSession`):
1. Look up the session user's email.
2. Issue an `email_tokens` row `purpose="delete"` (short TTL, e.g. 1h) and email
   the confirmation link (`{BaseURL}/account/delete/confirm?token=…`).
3. Respond 200 (generic) — no destructive action yet.
4. Rate-limit per user/IP (reuse the existing limiter/throttle pattern) so it
   can't be used to spam a mailbox.

## Flow 2 — Confirm

`POST /api/account/delete/confirm` (body `{token}`, no session required — the
token authorizes):
1. `UseEmailToken(hash, "delete", now)` → resolves the user; invalid/expired → 400.
2. If already pending-delete → idempotent 200.
3. Compute `graceDays`/`purgeAfter = now + graceDays*86400` from settings.
4. `PurgeTransientUserData(userID)` → for each returned stored file, delete its
   blob (`deleteBlob`, else `EnqueueNodeDelete`).
5. `SetAccountDeletion(userID, now, purgeAfter)`.
6. Send the **deletion-scheduled** email (purge date + reactivate link:
   `email_tokens` `purpose="reactivate"`, TTL = grace window).
7. Respond 200. (The user's current session was just revoked, so the web logs out.)

## Flow 3 — Grace period: frozen login + reactivation

- Every session-issuing login path (password login, OAuth callback, magic-link
  verify) checks the resolved user's `deleted_at`. If `>0`:
  - Do NOT issue a normal session. Instead return `{status:"pending_deletion",
    purgeAfter, reactivateToken}` where `reactivateToken` is a fresh one-time
    token (an `email_tokens` `purpose="reactivate"` row, or an in-memory
    equivalent) — the successful credential check IS the authorization.
- `POST /api/account/reactivate` (body `{token}`): `UseEmailToken(hash,
  "reactivate", now)` → `ClearAccountDeletion(userID)` → issue a normal session →
  respond ok. The reactivate link in the scheduled email hits the same endpoint.
- Registration guard: `POST /api/auth/register` (and the dedupe path) must treat
  an email whose user is pending-delete as taken, returning a hint to log in and
  reactivate rather than silently creating/colliding.

## Flow 4 — Purge + reminder (GC sweep extension)

In `sweep(ctx)`, after the existing reclamation:
1. **Reminder:** `ListUsersToRemind(remindWindow, now)` → for each, send the
   pre-purge reminder email and `MarkPurgeReminderSent`.
2. **Purge:** `ListUsersToPurge(now)` → for each: capture the email first, then
   `ArchiveAndPurgeUser(userID)` (fold usage into `usage_archive`, delete all
   user-linked rows + the user), then send the final **deleted** email.
   A blob still referenced by the user's stored files was already deleted at
   confirmation; any straggler goes through `pending_node_deletes` as usual.

## Error handling

- request: unverified/absent email → still 200 generic (don't leak), but skip the
  send; mail send failure logged, not surfaced.
- confirm: bad/expired/wrong-purpose token → 400 `invalid_or_expired_token`;
  already pending → idempotent ok.
- reactivate: bad/expired token → 400; already active → idempotent ok.
- login pending-deletion branch must be reached for ALL auth methods, else a
  frozen account could still get a live session — covered by tests per method.
- purge is best-effort per user: a failure on one user logs and continues to the
  next (don't wedge the whole sweep).

## Testing

- request → confirm happy path: confirm sets deleted_at/purge_after, revokes
  sessions, deletes stored_files + enqueues blob deletes, deregisters nodes,
  clears cli_tokens/devices; a confirmation email was sent.
- Token discipline: delete/reactivate tokens are single-use, purpose-scoped,
  expiring; a `delete` token can't reactivate and vice-versa.
- Frozen login: password, OAuth, and magic-link logins on a pending-delete user
  return `pending_deletion` (no session cookie set) — one test per method.
- Reactivation: clears deleted_at/purge_after, restores normal login, and a
  subsequent login issues a real session.
- Registration guard: registering a pending-delete email is refused with the
  reactivate hint; email is not re-created.
- GC purge: a user with `purge_after<=now` is fully removed (assert every
  user-linked table has no rows for that id) and `usage_archive` gained the
  period totals; a user with `purge_after>now` is untouched.
- GC reminder: fires once within the window, sets `purge_reminder_sent`, not
  re-sent on the next sweep.
- Grace boundary: `purge_after` exactly at `now` purges; just after does not.
- Idempotency/races: double-confirm, confirm-then-reactivate-then-purge-skip.

## Out of scope (this spec)

- CLI-initiated deletion.
- Admin-initiated deletion / admin view of pending-delete accounts (the admin
  user-management write surface remains deferred).
- Canceling an active paid subscription before deletion (billing is not live yet;
  add a subscription check here when charging goes live).
- Restoring purged transient data on reactivation (by design: not restored).
- Data export / "download my data before deletion" (possible future addition).
