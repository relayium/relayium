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
already trust in front (Caddy, nginx, Traefik, Cloudflare) and proxy `/api`,
`/ws`, `/admin`, and `/healthz` to port 8080 — a proxy that forwards `/ws` but
forgets `/api` is the single most common self-hosting breakage: `fetch`s to
`/api/*` fall through to the SPA's `index.html` instead of reaching the Go
server, and login silently does nothing.

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
| `RELAYIUM_TURN_URLS` / `RELAYIUM_TURN_SECRET` | Optional TURN relay for transfers where a direct P2P connection isn't possible (see [Cross-network transfers](#cross-network-transfers) below). |
| `RELAYIUM_REDIS_ADDR` | Optional Redis `host:port` for TURN relay-byte metering. Empty disables metering entirely; transfers still work without it. |
| `RELAYIUM_ADMIN_USER` / `RELAYIUM_ADMIN_PASS` | Credentials for the `/admin` console (username defaults to `admin` if unset). It is a full mutating console, not a read-only viewer — see [Admin dashboard](#admin-dashboard-optional-and-not-read-only) below. Password empty (the default) disables `/admin` outright — it 404s and falls through to the SPA. |
| `RELAYIUM_ADMIN_TOTP_SECRET` | Optional TOTP 2FA on top of the admin login. See [Admin dashboard](#admin-dashboard-optional-and-not-read-only) below. |
| `RELAYIUM_BIND` | Docker-compose only (not read by the server itself) — the host address the container's port 8080 is published on. Defaults to the loopback interface only, so a public host doesn't expose plaintext HTTP; set it to the wildcard address (all interfaces) for direct LAN access without a reverse proxy. |

`server/.env.example` also documents optional Google/Apple sign-in, Stripe
billing, and multi-node fleet settings — none of those are required to run a
basic instance; leave them unset.

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

## Cross-network transfers

Same-LAN transfers (both devices on the same public IP) work out of the box —
no TURN, no account required. Transfers across different networks need STUN
for NAT traversal, and a TURN relay for the (fairly common) case where a
direct peer-to-peer connection still can't be established.

The compose file includes an optional `relay` profile that also starts
coturn and Redis:

```bash
RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build
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
