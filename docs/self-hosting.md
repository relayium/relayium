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
billing, and multi-node fleet settings — none of those are required to run a
basic instance; leave them unset. If you do turn on `RELAYIUM_REDIS_ADDR`
and/or `RELAYIUM_STRIPE_SECRET_KEY`, see
[`docs/billing-transparency.md`](billing-transparency.md) for exactly what
that starts recording and metering, and what stays off when you leave them
unset.

Secrets belong in `server/.env` with mode `0600` — never on the command line,
where `ps` or `/proc/<pid>/environ` would expose them. `server/.env` is
git-ignored by default; never commit real secrets to your fork.

## Admin dashboard (optional, and NOT read-only)

Setting `RELAYIUM_ADMIN_PASS` turns on an admin console at `/admin`. It is
**not** a read-only viewer: alongside the user list and a read-only audit
log, it can edit site-wide settings, create/edit billing plans, change a
user's plan, mint and revoke node bearer tokens, delete/restore/relabel
nodes, and control feature/version rollouts (target a track, pause, resume,
roll back, or force an emergency release). The higher-risk of these actions
(settings, plan edits, user-plan changes, token minting, node deletion,
emergency rollout) render a confirmation page showing exactly what will
change before applying it, and re-check a second factor if one is
configured — but a leaked admin password alone is enough to reach and use
every route above.

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
