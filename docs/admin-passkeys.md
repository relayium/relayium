# Admin console: Passkey-only sign-in

The `/admin` console accepts **passkeys only**. There is no admin password, no
TOTP code and no fallback: sign-in and every high-risk confirmation need a
registered passkey. Passkeys are added, approved and revoked **only on the
server**, with the local `relayium-server admin` command. No browser — not even
one already signed in to `/admin` — can add or remove an admin passkey.

This page is the operator runbook. Configuration reference lives in
[self-hosting.md](self-hosting.md#admin-dashboard-optional-and-not-read-only).

## Turning the console on

```bash
RELAYIUM_ADMIN_ENABLED=true     # or -admin-enabled=true
RELAYIUM_ADMIN_USER=admin       # display name / audit actor only
```

The console is off by default (`/admin` 404s). `RELAYIUM_ADMIN_ENABLED=false`
turns it off even when a legacy password is still configured.

**Migration from password/TOTP.** An existing host config that only sets the
old `RELAYIUM_ADMIN_PASS` keeps the console enabled: while
`RELAYIUM_ADMIN_ENABLED` is unset, a non-empty legacy password is treated purely
as an "on" switch and the server logs a warning. The password is **never** used
to sign in or to confirm anything, and its value is never printed (not even by
`relayium-server -h`). `RELAYIUM_ADMIN_TOTP_SECRET` is ignored entirely (not
even parsed, so an invalid value no longer affects boot). Replace both with
`RELAYIUM_ADMIN_ENABLED=true` and delete them. `-gen-admin-totp` was removed.

Existing passkeys keep working unchanged: they live in the same
`admin_credentials` table, with the same user handle. No re-enrollment is
needed. Every session that existed before the upgrade (password- or
passkey-established) is invalid after it; sign in again with a passkey.

## The admin command

Run it **on the server, as the user that owns the database** (the service
user). It opens the server's SQLite file directly, touches only the admin
tables, starts nothing, listens on nothing, and exits. It refuses a database
path that does not exist (it never creates one) and, on Unix, a database owned
by a different user — a root-run command could otherwise leave root-owned
`-wal`/`-shm` files that lock the service out.

`--db` defaults to `$RELAYIUM_DB` and `--base-url` to `$RELAYIUM_BASE_URL`;
neither has a built-in default. When the service gets them from its unit file,
pass them explicitly. The production shape is:

```bash
sudo -u relayium /opt/relayium/server/relayium-server admin \
  --db /var/lib/relayium/relayium.db --base-url https://relayium.com <command>
```

(Below, `ADMIN` stands for that prefix.)

| Command | What it does |
|---|---|
| `ADMIN status` | counts of passkeys, live sessions, open enrollments |
| `ADMIN enroll start --name "MacBook" [--ttl 15m]` | print a one-time link that creates a **pending** passkey (TTL 1m–1h, default 15m) |
| `ADMIN enroll list` | recent enrollments and their state |
| `ADMIN enroll status ID` | one enrollment, with its pending fingerprint |
| `ADMIN enroll approve ID --fingerprint FP` | activate the pending passkey whose fingerprint is exactly `FP` |
| `ADMIN enroll cancel ID` | cancel an issued or pending enrollment |
| `ADMIN credentials list` | registered passkeys: ID, name, fingerprint, added, last used |
| `ADMIN credentials revoke ID [--allow-last]` | delete a passkey and end every session it opened |
| `ADMIN sessions list` | live admin sessions (no tokens) |
| `ADMIN sessions revoke-all` | end every session, pending confirmation and in-flight passkey challenge, and cancel every open enrollment |

Every **mutating** terminal action (enroll start/approve/cancel, credential
revoke, revoke-all) is written to the same audit log the console shows,
with auth `cli`, IP `local` and the OS user as actor. No secret is recorded.
Read-only commands (`status`, `list`, `enroll status`) are not audited.

## Adding a computer (or a hardware key)

1. On the server: `ADMIN enroll start --name "Work laptop"`. The command prints
   a link of the form `https://<host>/admin/enroll#<grant>` **once**, only to a
   terminal (it refuses to write it into a pipe or file unless you pass
   `--allow-non-terminal`). The grant is a single-use secret valid for 15
   minutes; only its hash is stored. Do not paste the link into chat, tickets
   or shared notes.
2. Open the link in a browser **on the device that will hold the passkey**.
   The grant sits after `#`, which browsers never send to a server; the page
   removes it from the address bar immediately and sends it only in request
   bodies. Press *Create a passkey on this device* and complete the platform
   prompt (user verification is required).
3. The page shows a fingerprint, e.g. `3F2A-91BC-04DE-77A1-5C0E`, and the
   approve command. The new passkey is **pending**: it cannot sign in yet.
4. On the server, compare and approve:

   ```bash
   ADMIN enroll status <ID>      # shows the same fingerprint
   ADMIN enroll approve <ID> --fingerprint 3F2A-91BC-04DE-77A1-5C0E
   ```

   Approval fails if the fingerprint differs, the enrollment expired, was
   already approved or cancelled, was issued for a different `--base-url`, or
   the passkey is already registered. Concurrent approvals of one enrollment
   succeed exactly once.

If the browser shows a fingerprint you did not expect, or anything finished
the enrollment before you did, **do not approve**: `ADMIN enroll cancel <ID>`.

### Which devices to enroll

- Enroll **at least two independent authenticators**, and keep one of them a
  **hardware security key** stored offline as a backup.
- A **synced passkey** (iCloud Keychain, Google Password Manager, 1Password …)
  is *one* credential that appears on every device of that account. It is
  convenient, but it is not two independent devices: losing or compromising
  that account loses or exposes all of them at once. Enrolling a second
  device of the same sync account usually adds nothing — the authenticator
  already holds the credential and the enrollment page says so.
- "Exactly two devices" is not enforced: the console accepts any number of
  approved passkeys. Review `ADMIN credentials list` periodically; a passkey
  that is "never used" deserves a look.

## Sessions

- A session is created only by a passkey sign-in and is bound to that passkey.
- It ends after **30 minutes without an authenticated admin request**, or **12
  hours** after sign-in regardless of activity. Pages you merely leave open do
  not keep it alive; only your own requests do.
- High-risk actions (settings, plans, user plans and grants, App Store
  catalog/purchase gate, token minting, node deletion, emergency/fast
  rollouts) always show a confirmation page and require a passkey assertion.
  After a successful passkey confirmation there is a 60-second grace window in
  the same session so two consecutive confirmations do not need two prompts;
  the confirmation page itself always renders.
- Revocation is immediate and also covers work already in flight:
  - `credentials revoke ID` deletes that passkey, its sessions and their
    pending confirmations, and ends cached step-up grace on **every**
    session.
  - `sessions revoke-all` deletes every session, pending confirmation and
    passkey challenge, and cancels every open enrollment (the rows stay, in
    state `cancelled`, so their grants and pending passkeys can never be used).
    Registered passkeys stay; a fresh sign-in works immediately.
  - Both advance a durable revocation generation in the same transaction. A
    sign-in or step-up challenge issued before the revocation can no longer
    produce a session or confirm an action afterwards — even one whose
    passkey signature had already been verified when the revocation landed.
    (A sign-in in progress during *any* revocation simply has to be retried.)
  - The point a confirmation is authorized is a single check right before the
    action is applied; a revocation committed after that check is ordered
    after the action.

## Incident response

**A session cookie may have leaked:** `ADMIN sessions revoke-all`, then sign in
again. Review the audit log.

**A device was lost or stolen:** find its passkey in `ADMIN credentials list`
and `ADMIN credentials revoke <ID>`. If unsure which, revoke every suspect key
and re-enroll the devices you still hold.

**All admin devices are lost:** the browser has no way back in, by design.
Recovery needs shell access to the server:

```bash
ADMIN status                               # confirm what is registered
ADMIN sessions revoke-all                  # end anything still alive
ADMIN credentials revoke <ID> --allow-last # for each lost key
ADMIN enroll start --name "Recovery key"   # then enroll and approve as above
```

The command can always enroll a new passkey, so revoking the last one is safe
for whoever has the server shell — and only for them.

## Rollout and rollback

Rollout (no re-enrollment, no customer-data change):

1. Before upgrading, record the existing passkey IDs **read-only**, e.g.
   `sqlite3 -readonly /var/lib/relayium/relayium.db 'SELECT id, name FROM admin_credentials'`
   (do not run the new admin command against the old deployment: it applies
   the additive admin-table migration).
2. Deploy. The first boot adds admin-only columns/tables (`admin_enrollments`,
   `admin_auth_state`, session age/idle/credential columns); every old admin
   session becomes invalid.
3. Sign in with an existing passkey; run `ADMIN status` and
   `ADMIN credentials list` and confirm the same IDs.
4. Set `RELAYIUM_ADMIN_ENABLED=true`, remove `RELAYIUM_ADMIN_PASS` and
   `RELAYIUM_ADMIN_TOTP_SECRET`, restart.

Rollback to an older binary is schema-compatible (all changes are additive and
the older binary ignores the new columns and tables), but it brings back the
older password/TOTP sign-in and browser credential management. Keep
`RELAYIUM_ADMIN_PASS` available until the new version is confirmed if you need
that rollback path; remove it afterwards. Passkeys approved on the new version
are ordinary `admin_credentials` rows and keep working on the older binary.

Cloudflare, reverse-proxy or IP allowlists are independent of this change and
remain a good additional layer for `/admin`.
