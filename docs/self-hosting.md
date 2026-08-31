# Self-hosting Relayium

Run your own Relayium instance. Everything below uses example values — replace
`example.com` (and any secret) with your own.

## Quickest path — Docker

```bash
git clone https://github.com/relayium/relayium.git
cd relayium
RELAYIUM_TURN_SECRET=changeme docker compose up -d --build
```

This builds one self-contained image (Svelte SPA + Go signaling/account server,
`Dockerfile` at the repo root) and serves it on `http://localhost:8080`. The
SQLite database and any stored-transfer ciphertext persist in the named volume
`relayium-data`, mounted at `/data`.

> **Why `RELAYIUM_TURN_SECRET` even though you're not using TURN yet:**
> `docker-compose.yml` also defines an optional `coturn` service (see
> [Cross-network transfers](#cross-network-transfers)) that is gated behind
> the `relay` profile and off by default. Docker Compose still validates that
> service's required variable when parsing the file, even when its profile
> isn't active, so `docker compose up` fails without *some* value here. Any
> placeholder works until you actually enable the `relay` profile, at which
> point it becomes a real secret — see below.

Build and run without compose, if you'd rather:

```bash
docker build -t relayium .
docker run -d -p 8080:8080 -v relayium-data:/data relayium
```

## HTTPS is mandatory

The Web Crypto API and streaming-to-disk require a secure context. `localhost`
counts, but any real deployment must terminate TLS. Put a reverse proxy you
already trust in front (Caddy, nginx, Traefik, Cloudflare) and proxy
*everything* — `/`, `/api`, `/ws`, `/admin`, and `/healthz` — to port 8080.
There's no separate static-file server to configure: the Go server serves the
built SPA itself (`RELAYIUM_STATIC`) as well as those routes, so one catch-all
proxy block covers the whole app. Just make sure it passes `/ws` through as a
WebSocket upgrade rather than buffering it — a proxy that handles plain HTTP
fine but drops the `Upgrade`/`Connection` headers is the single most common
self-hosting breakage, and it fails silently: the page loads, but realtime
transfers never connect.

## Configuration

The container reads config from `./server/.env` (optional — copy from
[`server/.env.example`](../server/.env.example) as a starting template) plus
the `environment:` block in `docker-compose.yml`. Every setting is a
`RELAYIUM_*` environment variable with a matching CLI flag (env wins over the
built-in default; an explicit flag wins over env). `server/.env.example` is a
template, not a complete reference — it covers the common cases but omits
several real flags (stored-transfer quotas/retention, node-fleet settings,
the multi-relay TURN pool, and more); the authoritative list is the flag
definitions in [`server/main.go`](../server/main.go). The essentials:

| Variable | Purpose |
|---|---|
| `RELAYIUM_ADDR` | Listen address inside the container. Default `:8080`; leave it alone unless you changed the Dockerfile. |
| `RELAYIUM_BASE_URL` | Public URL of your instance, e.g. `https://relayium.example.com`. Used to build links (magic-link email, join links) and to decide whether session cookies get the `Secure` flag — set it to your real `https://` URL. |
| `RELAYIUM_MAIL_TRANSPORT` | How verification / password-reset / deletion emails leave the server: `auto` (default), `smtp`, or `dev-log-links`. See [Email delivery](#email-delivery) below — **set this to `smtp` on a real deployment** so a missing SMTP address fails the boot instead of silently sending nothing. |
| `RELAYIUM_SMTP_ADDR` / `RELAYIUM_SMTP_FROM` / `RELAYIUM_SMTP_USER` / `RELAYIUM_SMTP_PASS` | Your outbound SMTP relay. `host:port`, the From header, and optional credentials (leave user/pass empty for an unauthenticated local relay). See [Email delivery](#email-delivery). |
| `RELAYIUM_DB` | SQLite database path. The Docker image already points this at `/data/relayium.db` inside the persisted volume. |
| `RELAYIUM_BLOB_DIR` | Directory for stored-transfer ciphertext blobs. Docker image default: `/data/blobs`. |
| `RELAYIUM_STATIC` | Built SPA directory the Go server falls back to serving. Docker image default: `/app/web/dist`. |
| `RELAYIUM_STUN_URLS` | Comma-separated STUN URLs for cross-network NAT traversal. Empty is derived from `RELAYIUM_TURN_URLS` (a TURN server answers STUN on the same host:port); with neither set, no STUN is advertised and only same-LAN transfers work. |
| `RELAYIUM_TURN_URLS` / `RELAYIUM_TURN_SECRET` | Optional TURN relay for transfers where a direct P2P connection isn't possible (see [Cross-network transfers](#cross-network-transfers) below). With the bundled `relay` profile the secret must be set in **two** places — see that section; setting only one of them leaves TURN silently off. |
| `RELAYIUM_REDIS_ADDR` | Optional Redis `host:port` for TURN relay-byte metering. Empty disables metering entirely; transfers still work without it. |
| `RELAYIUM_ADMIN_USER` / `RELAYIUM_ADMIN_PASS` | Credentials for the `/admin` console (username defaults to `admin` if unset). It is a full mutating console, not a read-only viewer — see [Admin dashboard](#admin-dashboard-optional-and-not-read-only) below. Password empty (the default) disables `/admin` outright — it 404s and falls through to the SPA. |
| `RELAYIUM_ADMIN_TOTP_SECRET` | Optional TOTP 2FA on top of the admin login. See [Admin dashboard](#admin-dashboard-optional-and-not-read-only) below. |
| `RELAYIUM_RELEASE_CHECK` | On (`true`) by default: ask GitHub hourly for the newest release and offer it in `/admin`. See [Release check](#release-check-on-by-default) below. `false` disables it — no request is made at all. |
| `RELAYIUM_BIND` | Docker-compose only (not read by the server itself) — the host address the container's port 8080 is published on. Defaults to the loopback interface only, so a public host doesn't expose plaintext HTTP; set it to the wildcard address (all interfaces) for direct LAN access without a reverse proxy. |

`server/.env.example` also documents optional Google/Apple sign-in, Stripe
billing, App Store purchases (see
[App Store purchases](#app-store-purchases-off-by-default) below), and
multi-node fleet settings — none of those are required to run a basic
instance; leave them unset. If you do turn on `RELAYIUM_REDIS_ADDR`
and/or `RELAYIUM_STRIPE_SECRET_KEY`, see
[`docs/billing-transparency.md`](billing-transparency.md) for exactly what
that starts recording and metering, and what stays off when you leave them
unset.

Secrets belong in `server/.env` with mode `0600` — never on the command line,
where `ps` or `/proc/<pid>/environ` would expose them. `server/.env` is
git-ignored by default; never commit real secrets to your fork.

## Email delivery

Relayium sends email for four things: **email verification**, **password
reset**, **account-deletion confirmation**, and — if you turned it on —
**magic-link sign-in**. Every one of those messages carries a single-use link
whose token *is* a credential: whoever holds it can take over the account.

`RELAYIUM_MAIL_TRANSPORT` decides how those messages leave the server. The
resolved choice is printed on the first lines of the log at every startup, so
you never have to guess which one is live.

| Value | What happens |
|---|---|
| `auto` (default) | Uses SMTP when `RELAYIUM_SMTP_ADDR` is set. **With no SMTP address, no email is delivered at all** — the events go to the log with the recipient masked and the link reduced to its path, and the server warns you at boot. Your users cannot finish verification or a password reset. |
| `smtp` | Requires SMTP. When `RELAYIUM_SMTP_ADDR` is missing or empty **the server refuses to start**. Boot checks only that an address is present; it does not resolve, connect to or authenticate against the relay. |
| `dev-log-links` | Prints the full links, tokens included, to the log. Local development only — see the warning below. |

**Use `smtp` for anything real.** The difference matters the day the SMTP
address fails to load or is left unset: under `auto` the server comes up
healthy and quietly stops emailing anyone, and you find out from a user who
cannot reset their password. Under `smtp` that same empty address fails the
boot, which your process supervisor and your deployment both notice
immediately.

What `smtp` does **not** check is whether the relay works. Startup only
verifies that `RELAYIUM_SMTP_ADDR` is non-empty — nothing is resolved,
connected to or authenticated at boot. A host that is mistyped but still
non-empty, an unreachable port, a TLS failure or a wrong password therefore
surfaces on the first message that is actually sent, when that send fails. Send
yourself a verification or password-reset email after changing these settings,
or probe the relay separately (for example with `swaks`, or `openssl s_client
-starttls smtp -connect mail.example.com:587`), rather than reading a
successful boot as proof that mail is being delivered.

```
RELAYIUM_MAIL_TRANSPORT=smtp
RELAYIUM_SMTP_ADDR=mail.example.com:587
RELAYIUM_SMTP_FROM=noreply@example.com
RELAYIUM_SMTP_USER=noreply@example.com
RELAYIUM_SMTP_PASS=...
```

Go upgrades the connection with STARTTLS before sending credentials, so the
usual authenticated submission providers on port 587 work. Leave
`RELAYIUM_SMTP_USER` and `RELAYIUM_SMTP_PASS` empty for an unauthenticated
local relay such as `127.0.0.1:25`. Give `RELAYIUM_SMTP_FROM` a real address at
a domain you control with SPF/DKIM set up, or your mail lands in spam.

### What the log shows, and why

Outside `dev-log-links`, a mail event is recorded like this:

```
verify email for f***@example.com: link redacted (path /verify-email); ...
```

The local part of the address is masked, and the token — which lives in the
query string — is never written. That is deliberate: application logs get
shipped to aggregators, attached to bug reports and read by more people than
the mailbox itself, and a log line containing a live reset link is an account
takeover waiting to be found. An address or link that does not parse is
replaced outright rather than echoed, so nothing can forge log lines through it.

### `dev-log-links` — local development only

> **Warning.** `dev-log-links` prints complete sign-in, verification,
> password-reset and account-deletion links, tokens included, into the log.
> Anyone who can read that log can take over any account on the instance. Never
> use it on a shared, hosted or production instance.

Because that is so easy to leave switched on by accident, the server refuses it
unless **all three** of these hold at once:

1. you selected `dev-log-links` explicitly — no configuration reaches it by default;
2. no SMTP address is configured; and
3. `RELAYIUM_BASE_URL` points at a **literal** local address: `localhost`, or a
   loopback / private / link-local IP such as `127.0.0.1`, `[::1]`,
   `192.168.1.10` or `10.0.0.5`.

A *hostname* is refused even when it currently resolves to a local address —
the server does no name lookup, precisely so that no DNS answer can talk a
public deployment into printing credentials. If any condition fails, startup
fails with a message naming the one that did.

Relayium's own local harnesses (`scripts/start-device-inbox-v2-local.sh`, the
shared acceptance launcher, and the Device Inbox end-to-end run) pass
`-mail-transport dev-log-links` for exactly this reason: they read the
verification link back out of the log to stand in for a user clicking it.

## Admin dashboard (optional, and NOT read-only)

Setting `RELAYIUM_ADMIN_PASS` turns on an admin console at `/admin`. It is
**not** a read-only viewer: alongside the user list and a read-only audit
log, it can edit site-wide settings, create/edit billing plans, change a
user's plan, grant a user a time-bounded paid membership, mint and revoke
node bearer tokens, delete/restore/relabel nodes, and control
feature/version rollouts (target a track, pause, resume, roll back, or force
an emergency release). The higher-risk of these actions (settings, plan
edits, user-plan changes, membership grants, token minting, node deletion,
emergency rollout) render a confirmation page showing exactly what will
change before applying it, and re-check a second factor if one is
configured — but a leaked admin password alone is enough to reach and use
every route above.

A **timed membership grant** is deliberately a different thing from changing
a user's plan, and the difference matters if you self-host with billing on:

- Changing a user's plan rewrites the account's billing projection, so it is
  refused outright on any account already bound to Stripe or the App Store —
  a manual comp must never mask a channel that can still charge someone.
- A grant is an *entitlement overlay* instead: it raises the account's
  effective tier for a whole number of days (1–1000, either from now or
  extending an existing unexpired grant) and then simply stops. It writes no
  provider state at all, so it *is* allowed on a payment-bound account; the
  confirmation page warns you when provider state coexists, and the console
  never reports a payment authority as an active subscription. Provider
  events keep reconciling underneath, and when the grant expires the account
  falls back to whatever the provider record says at that moment, or to Free.
- The duration is counted from the moment you **confirm**, not from the
  moment the confirmation page was drawn, so a grant always hands over the
  full number of days you asked for however long you take over the second
  factor. That is why the page previews the rule ("30 whole days from
  successful confirmation") rather than a fixed timestamp; the exact expiry
  instant is computed once at confirmation and written to the audit log.
- A grant can only ever raise the effective tier, never lower it, so
  granting a smaller tier to a paying subscriber does nothing. There is no
  separate revoke: to cut a grant short, grant again with "from now" and a
  short duration, which replaces the old expiry.

Because of that blast radius, treat `/admin` credentials like production
secrets:

- Use a strong, unique `RELAYIUM_ADMIN_PASS` — never reuse a password from
  elsewhere.
- Enable TOTP 2FA. Generate a secret from inside the `server/` directory (or
  `docker compose exec server`):

  ```bash
  go run . -gen-admin-totp
  ```

  This prints a QR code and a base32 secret — scan the QR with any TOTP app
  (Google Authenticator, 1Password, …), then put the secret in
  `RELAYIUM_ADMIN_TOTP_SECRET` and restart the server. Leaving it unset keeps
  `/admin` on username/password only, with no second factor on the
  confirmation step above.
- Consider also restricting `/admin` at your reverse proxy (IP allowlist,
  VPN-only, or an additional auth layer) rather than relying solely on the
  application login.

Leaving `RELAYIUM_ADMIN_PASS` empty (the default) disables `/admin`
entirely — it 404s and falls through to the SPA.

## App Store purchases (off by default)

If you ship your own native macOS/iOS build, the server can verify the signed
transactions StoreKit hands it. **Leave this unset unless you do** — it is off
by default, and off means `POST /api/billing/apple/transaction` answers
`503 {"error":"verifier_unavailable"}` and nothing about your instance changes.

One variable turns it on:

```bash
RELAYIUM_APPLE_STORE_CONFIG_FILE=/etc/relayium/apple-store.json
```

It is entirely separate from Sign in with Apple — no Team ID, no Key ID, no
`.p8`, no client secret — and the file it points at holds no secrets either:

```json
{
  "environment": "Sandbox",
  "rootCertsFile": "/etc/relayium/apple-root-cas.pem",
  "apps": [
    {"bundleId": "com.example.app", "appAppleId": 0},
    {"bundleId": "com.example.mac", "appAppleId": 0}
  ]
}
```

| Field | Meaning |
|---|---|
| `environment` | `Sandbox` or `Production`, exactly — *your* answer to which App Store this deployment talks to, never read from the submitted transaction. Sandbox purchases are free, so a production deployment left on `Sandbox` hands out paid tiers. |
| `apps` | One entry per App Store record. A macOS build and an iOS build are two apps with two bundle ids, never one merged entry. `appAppleId` is the numeric App Store id ("Apple ID" in App Store Connect) and is **required** (non-zero) when `environment` is `Production`. |
| `rootCertsFile` | Absolute path to a PEM file holding the Apple root CA(s) you downloaded from Apple. **Roots only** — Apple publishes its intermediates on the same page, and an intermediate is a CA that would otherwise become a trust anchor in its own right, so anything that has not signed itself is refused at startup. These are the only trust anchors: the host's system root store is never used, and the certificate chain inside a submitted transaction is never allowed to anchor itself. |

Both files belong to the user the server runs as, mode `0600` (or `0640` if a
group needs to read them), and neither is committed to your fork. They must be
regular files — a symlink, a directory or a FIFO in either path is refused at
startup, as is a file that is empty, oversized, or not the material it claims
to be.

Running in Docker? Both paths are read *inside* the container, so both files
have to be mounted in — see
[Docker: mounting the two files](#docker-mounting-the-two-files) below.

**It fails closed, in both directions.** Unset, no verifier is built at all.
Set, the configuration must be complete and readable or **the server refuses to
start** — a mistyped path or a half-filled file is a failed boot rather than a
purchase path that looks live and answers 503 to every customer forever.

**Order matters.** This file says nothing about products. Which
bundle id + product id grants which plan and billing cycle lives in the
database (the Apple product catalog), and a verified transaction for a product
with no mapping is refused *after* the customer's money has already moved. So:
create the product mappings first, then set the variable, then restart, then
ship the client that can purchase.

**Rolling back has an order.** Unset the variable *first*: comment out or
delete `RELAYIUM_APPLE_STORE_CONFIG_FILE` in `server/.env`, then restart
(`docker compose up -d` to recreate the container). The endpoint returns to
`503` and nothing else in the server is affected — Stripe billing, existing
subscriptions and every other route are untouched either way.

Only **after** the variable is gone are the files inert and safe to delete, and
the bind mounts safe to drop from your compose file. Doing it the other way
round is the fatal case above, not a rollback: a variable that is still set
with the file missing is a server that refuses to start. Removing a bind mount
is deleting the file as far as the container can tell, so it belongs in the
same edit as unsetting the variable — never in an earlier one.

### Docker: mounting the two files

Both paths above are resolved **inside the container**, and `docker-compose.yml`
mounts nothing but the `relayium-data` volume at `/data`. A JSON file sitting at
`/etc/relayium/apple-store.json` on the *host* therefore does not exist as far
as the server is concerned — and because a path that is set but unreadable is a
fatal startup error, the container refuses to boot. Bind-mount both files
read-only at the same absolute paths they already have on the host, so the host
path, the container path and the `rootCertsFile` value inside the JSON are all
one string:

```yaml
services:
  server:
    volumes:
      - relayium-data:/data     # keep this line: SQLite DB + stored blobs
      - /etc/relayium/apple-store.json:/etc/relayium/apple-store.json:ro
      - /etc/relayium/apple-root-cas.pem:/etc/relayium/apple-root-cas.pem:ro
```

Either add the two `/etc/relayium/…` lines to the `server` service's existing
`volumes:` in `docker-compose.yml`, or — if you'd rather not edit a tracked
file — save the block above as `docker-compose.override.yml` beside it, which
Compose picks up automatically. It is a valid file on its own: the named volume
stays declared in the base file, so no top-level `volumes:` section is needed
here.

Keep `relayium-data:/data` in whichever file you edit. Replacing that list
rather than adding to it detaches the database and every stored transfer from
the volume that holds them, and the server will start perfectly happily on an
empty `/data`. (Compose merges a service's `volumes:` by container path, so
repeating the line in an override is a harmless no-op — and it keeps the mount
whichever way your Compose version merges.)

Two things that otherwise cost you a boot:

- **Create both files before `docker compose up -d`.** A bind-mount source that
  doesn't exist is created as an empty *directory* (Docker Desktop may instead
  refuse the mount outright), and the server refuses a path that is not a
  regular file — so a mistyped filename surfaces as a complaint about a
  directory, which is a confusing way to learn you mistyped it.
- **The image runs as the distroless `nonroot` user, uid/gid `65532`.** Mode
  `0600` files owned by `root` or by your login account are unreadable inside
  the container. Hand them to that uid on the host:
  `sudo chown 65532:65532 /etc/relayium/apple-store.json /etc/relayium/apple-root-cas.pem`.
  The `:ro` stops the container from writing to them regardless.

`RELAYIUM_APPLE_STORE_CONFIG_FILE` itself goes in `./server/.env` like every
other setting — the `server` service already reads that file. And when you roll
back, drop these two mounts in the same edit that unsets the variable, never in
an earlier one.

Plain `docker run` needs the same two mounts:

```bash
docker run -d -p 8080:8080 \
  -v relayium-data:/data \
  -v /etc/relayium/apple-store.json:/etc/relayium/apple-store.json:ro \
  -v /etc/relayium/apple-root-cas.pem:/etc/relayium/apple-root-cas.pem:ro \
  -e RELAYIUM_APPLE_STORE_CONFIG_FILE=/etc/relayium/apple-store.json \
  relayium
```

**Native deployments need none of this.** A binary run under systemd or by hand
reads `/etc/relayium/apple-store.json` and the PEM straight off the filesystem:
no bind mounts, no compose changes, nothing to keep in sync. Just make sure
both files are owned by the account in the unit's `User=` (or whatever user you
start the server as).

## Release check (on by default)

Once at startup and then every hour, the server asks GitHub's public API for
the newest release tag of
[`relayium/relayium`](https://github.com/relayium/relayium) — a plain
`GET https://api.github.com/repos/relayium/relayium/releases` — the same call
`relayium update --check` makes when you run it by hand. (`relayium-node update`
does not make it: a node installs the exact version central hands it, or the one
you name with `-to`.)

It reads the release *list* rather than `releases/latest` because that endpoint
is repository-wide, and this repository publishes more than one thing: the macOS
app is released under its own `macos-v*` tags. The check takes the highest
published `v<major>.<minor>.<patch>` release and ignores every other tag family,
along with drafts and pre-releases.

The startup check matters if you are counting requests or writing an egress
allowlist: a server that is restarted often (every deploy, every config change)
asks once per restart on top of the hourly tick, so the interval is an upper
bound on the gap between checks, not on their number. Each check is a single
request while the repository has fewer than 100 releases, and never more than
five — it pages until the list ends, and stops at five pages. If those 500
releases ever fail to reach the end of the list, the check reports an error and
no version rather than guessing from what it read: the unread page could hold a
newer release, or the only server release. That is a signal to raise the page
limit in the code, not a state you can be left silently stale in — nothing is
recorded, so `/admin` keeps showing the last version it did confirm. The host to
allow is `api.github.com` — `github.com` itself is only the download host and
this check never contacts it.

If that tag is newer than what your fleet track is targeting, `/admin` shows a
banner offering a one-click rollout to it (or, when a rollout on the fleet
track has not finished — still running, or paused with a node recorded in
flight — just names the new version without a button, since starting a new
rollout would discard where that one had got to; see
[Admin dashboard](#admin-dashboard-optional-and-not-read-only)).

Nothing about your instance is sent with that request — no version, no host,
no usage. What GitHub *can* observe is that some machine at your egress IP
asked, on a timer and at each restart, the same as it can for anyone's `curl`
cron job.
A failed check (offline, rate-limited, GitHub down) never overwrites the
last-known result and never claims the deployment is current — silence is
the only "nothing new" signal, and the panel prints when the last successful
check happened so that silence stays legible.

Set `RELAYIUM_RELEASE_CHECK=false` to turn it off. Once disabled, no request
is made at all, and the `/admin` panel shows none of this — no banner, no
last-checked line.

## Cross-network transfers

Same-LAN transfers (both devices on the same public IP) work out of the box —
no TURN, no account required. Transfers across different networks need STUN
for NAT traversal, and a TURN relay for the (fairly common) case where a
direct peer-to-peer connection still can't be established.

The compose file includes an optional `relay` profile that also starts
coturn and Redis.

**The secret has to go in two places, and the failure when it doesn't is
silent.** coturn gets it from Compose variable interpolation, which resolves
from the shell or the project-root `.env` — an `env_file:` like `server/.env`
is only injected into the container it is attached to and is never used for
interpolation. The *server* reads `RELAYIUM_TURN_SECRET` and
`RELAYIUM_TURN_URLS` from its own environment, and an empty `-turn-secret`
disables TURN outright. Set just the shell variable and you get a running
coturn that the server never issues credentials for: `docker compose ps` is
green, nothing is logged, and strict-NAT transfers keep failing exactly as
they did before.

Put both keys in `server/.env` (mode `0600`) so the server picks them up:

```bash
RELAYIUM_TURN_SECRET=<the same long random value>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349
```

then export that same file into the shell before starting the profile, so
Compose's interpolation sees the value coturn needs. Sourcing it keeps one
source of truth and, unlike `RELAYIUM_TURN_SECRET=… docker compose …`, keeps
the secret off the command line where `ps` would expose it:

```bash
set -a; . ./server/.env; set +a
docker compose --profile relay up -d --build
```

Confirm the server side actually came up with it — this is the check that
catches the silent case, because coturn being up proves nothing about the
server:

```bash
docker compose exec server env | grep RELAYIUM_TURN   # both keys, non-empty
```

A plain `docker compose up` does **not** start coturn or Redis — you must
pass `--profile relay` and set `RELAYIUM_TURN_SECRET` for it to come up (see
the `coturn:` and `redis:` service comments in `docker-compose.yml`). coturn
needs a real public IP and a wide open UDP port range for the TURN relay
ports; any standards-compliant TURN server works if you'd rather run your own
outside Docker — just point `RELAYIUM_TURN_URLS` / `RELAYIUM_TURN_SECRET` at
it and set matching credentials on the coturn side.

## Verify

```bash
curl -sS https://example.com/healthz     # → ok
```

Then open the page on two devices and send a file. On the same LAN it should
just work; across networks, use the pairing-code / QR flow (requires the
sender to sign in).
