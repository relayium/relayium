# Deploying Relayium (web + signaling/account server + nginx)

This guide describes a single-host production deployment:

```
            ┌──────────────────────── your server ────────────────────────┐
  browser → │  nginx (TLS :443)                                            │
            │    ├─ location /api/    → proxy → Go server 127.0.0.1:8080   │  accounts, auth, ice, transfers
            │    ├─ location /admin   → proxy → Go server 127.0.0.1:8080   │  read-only admin dashboard
            │    ├─ location /ws      → proxy → Go server 127.0.0.1:8080   │  WebRTC signaling
            │    ├─ location /healthz → proxy → Go server 127.0.0.1:8080   │  health check
            │    └─ location /        → static files in web/dist           │  SPA + the 12 legal pages
            └──────────────────────────────────────────────────────────────┘
```

**The single most common breakage** (and the cause of "login does nothing"): nginx
proxies `/ws` but is **missing the `/api/` proxy block**, so every `/api/*` request
falls through to the static SPA and returns `index.html` instead of reaching the Go
server. The browser's `fetch("/api/me")` then receives HTML, the Google button just
reloads the SPA, and magic-link requests never hit the backend. See
[Step 4](#step-4--nginx) and [Verify](#verify).

---

## Prerequisites

- A Linux host with a public IP and a domain (`relayium.com` below — substitute yours).
- Go ≥ 1.23 and Node ≥ 20 to build (or build elsewhere and copy the artifacts).
- nginx with a TLS certificate (e.g. via certbot/Let's Encrypt).
- Optional: coturn for cross-network TURN relay — see [coturn.md](coturn.md).

---

## Step 1 — Build the web frontend

The build also generates the 12 static legal pages into `web/dist` (privacy/terms × 6
languages) via the `gen:legal` prebuild step.

```bash
cd web
npm ci
npm run build        # runs gen-legal.mjs, then vite build → web/dist
```

`web/dist/` now contains `index.html`, hashed JS/CSS, and `privacy/`, `terms/`,
`zh/privacy/`, … plus `sitemap.xml`, `robots.txt`. nginx serves this directory directly.

---

## Step 2 — Build the Go server

```bash
cd server
go build -o relayium .
# produces ./server/relayium
```

### Server flags (from `server/main.go`)

| Flag | Default | Purpose |
|------|---------|---------|
| `-addr` | `:8080` | Listen address. Keep it on localhost in production (`127.0.0.1:8080`) and let nginx face the internet. |
| `-static` | `../web/dist` | Static dir. In production nginx serves static, so this only matters as a fallback — set it to the absolute `web/dist` path anyway. |
| `-db` | `relayium.db` | SQLite path. Use an absolute path on a persistent disk. |
| `-base-url` | `http://localhost:8080` | **Must be `https://relayium.com` in production.** Drives magic-link URLs and the OAuth redirect, and makes session cookies `Secure` (the code sets `Secure` only when base-url starts with `https://`). |
| `-google-id` | `""` | Google OAuth client ID. Empty ⇒ Google sign-in is broken. |
| `-google-secret` | `""` | Google OAuth client secret. |
| `-smtp-addr` | `""` | SMTP `host:port`. **Empty ⇒ magic links are only printed to the server log, never emailed.** See [Step 5](#step-5--email-magic-links). |
| `-smtp-from` | `no-reply@relayium.com` | From / envelope sender for magic-link mail. |
| `-smtp-user` | `""` | SMTP username. Set with `-smtp-pass` for authenticated providers (Gmail/SES/…). Empty = unauthenticated relay. |
| `-smtp-pass` | `""` | SMTP password (used with `-smtp-user`). |
| `-turn-secret` | `""` | coturn `static-auth-secret`. Empty disables TURN (cross-network relay). |
| `-turn-urls` | `""` | Comma-separated TURN URLs, e.g. `turn:relay.relayium.com:3478,turns:relay.relayium.com:5349`. |
| `-stun-urls` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs. |
| `-redis-addr` | `""` | Redis `host:port` for coturn relay-byte metering. Empty disables. See [coturn.md](coturn.md). |
| `-admin-user` | `admin` | Username for the read-only `/admin` dashboard. |
| `-admin-pass` | `""` | Password for `/admin`. **Empty ⇒ the dashboard is disabled and `/admin` 404s** (falls through to the SPA). Set it to enable the admin user list. |
| `-enable-google` | `false` | Enable Google OAuth login. Off by default; needs `-google-id`/`-google-secret`. |
| `-enable-magic` | `false` | Enable email magic-link login. Off by default; needs SMTP (Step 5). |

> Every flag also reads a `RELAYIUM_*` environment variable (e.g.
> `RELAYIUM_ADMIN_PASS`), and the server loads an optional `.env` file from its
> working directory at startup. Precedence: **CLI flag > env var > `.env` file >
> default**. Keep secrets in `.env` (mode 0600, git-ignored) or the systemd unit,
> not in shell history. See `server/.env.example`.

### systemd unit

`/etc/systemd/system/relayium.service`:

```ini
[Unit]
Description=Relayium signaling + account server
After=network.target

[Service]
# Put real values here. Keep this file mode 0600 — it holds secrets.
ExecStart=/opt/relayium/server/relayium \
  -addr 127.0.0.1:8080 \
  -static /opt/relayium/web/dist \
  -db /var/lib/relayium/relayium.db \
  -base-url https://relayium.com \
  -google-id YOUR_GOOGLE_CLIENT_ID \
  -google-secret YOUR_GOOGLE_CLIENT_SECRET \
  -smtp-addr 127.0.0.1:25 \
  -smtp-from "no-reply@relayium.com" \
  -stun-urls stun:stun.l.google.com:19302 \
  -admin-user admin \
  -admin-pass YOUR_ADMIN_PASSWORD
# add -turn-secret / -turn-urls / -redis-addr if you run coturn (see coturn.md)
# omit -admin-pass to keep the /admin dashboard disabled
# add -enable-google / -enable-magic to turn those login methods back on
WorkingDirectory=/opt/relayium/server
Restart=on-failure
RestartSec=2
# hardening
DynamicUser=yes
StateDirectory=relayium
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/relayium
sudo systemctl daemon-reload
sudo systemctl enable --now relayium
sudo systemctl status relayium
curl -s http://127.0.0.1:8080/healthz        # → ok
curl -i http://127.0.0.1:8080/api/me          # → 401 + JSON (NOT html)
```

> If `127.0.0.1:8080/api/me` already returns HTML, the Go server isn't the one
> answering — check `-static`/`-addr` and that nothing else holds port 8080.

---

## Step 3 — DNS & TLS

Point `relayium.com` at the host and obtain a certificate, e.g.:

```bash
sudo certbot --nginx -d relayium.com
```

---

## Step 4 — nginx

The decisive part. `/api/`, `/ws`, and `/healthz` are **proxied to the Go server**;
everything else is **served statically** from `web/dist`.

`/etc/nginx/sites-available/relayium.conf`:

```nginx
server {
    listen 443 ssl http2;
    server_name relayium.com;

    ssl_certificate     /etc/letsencrypt/live/relayium.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relayium.com/privkey.pem;

    root /opt/relayium/web/dist;
    index index.html;

    # ── API → Go backend ────────────────────────────────────────────────
    # THIS is the block whose absence breaks login. A prefix location like
    # /api/ takes precedence over the static `location /` below.
    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # ── Admin dashboard → Go backend ────────────────────────────────────
    # Read-only /admin user list. Without this block /admin matches the static
    # `location /` below and try_files falls back to /index.html — so you get
    # the SPA homepage instead of the admin login form. A prefix location
    # /admin also covers /admin/login and /admin/logout.
    location /admin {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # ── WebRTC signaling (WebSocket) → Go backend ───────────────────────
    location /ws {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 1h;        # keep long-lived signaling sockets open
    }

    # ── Health check → Go backend ───────────────────────────────────────
    location = /healthz {
        proxy_pass http://127.0.0.1:8080;
    }

    # ── Everything else: static SPA + the 12 legal pages ────────────────
    # try_files serves /privacy → /privacy/ (its index.html) via an INTERNAL
    # rewrite, so the browser URL stays slash-less (matching the page's
    # canonical https://relayium.com/privacy). Unknown routes fall back to the
    # SPA so client-side state works.
    location / {
        try_files $uri $uri/ /index.html;
    }
}

# optional: redirect http → https
server {
    listen 80;
    server_name relayium.com;
    return 301 https://relayium.com$request_uri;
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/relayium.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Step 5 — Email (magic links)

The magic-link mailer (`server/internal/account/mailer.go`) calls Go's
`smtp.SendMail` with **no authentication** (the server wires `SMTPMailer{Addr, From}`
with a `nil` Auth; there is no `-smtp-user`/`-smtp-pass` flag today). So you have two
options:

### Option A — local unauthenticated relay (works with the code as-is)

Run a local MTA bound to `127.0.0.1:25` that accepts mail from localhost and relays it
out (optionally to a smarthost that does the authenticating). Then:

```
-smtp-addr 127.0.0.1:25
```

Example with Postfix using an authenticated smarthost (Gmail/SES/etc.) lives in the
MTA config, not in Relayium — Relayium just hands the message to `127.0.0.1:25`.

### Option B — authenticated SMTP provider directly

To use `smtp.gmail.com:587`, SES, SendGrid, Mailgun, etc., pass credentials with the
`-smtp-user` / `-smtp-pass` flags:

```
-smtp-addr smtp.gmail.com:587 \
-smtp-user apikey-or-username \
-smtp-pass YOUR_SMTP_PASSWORD \
-smtp-from "no-reply@relayium.com"
```

When `-smtp-user` is set the server attaches SMTP `PlainAuth` bound to the host from
`-smtp-addr`. Go's `smtp.SendMail` performs STARTTLS before sending the credentials, so
use a STARTTLS port (commonly `587`). Leave `-smtp-user` empty for an unauthenticated
local relay (Option A).

### Verifying without email (any option)

Until SMTP is configured, magic links are **logged**, not sent. You can still test the
full login flow by reading the link from the server log:

```bash
journalctl -u relayium -f | grep "magic link"
# → "magic link for you@example.com: https://relayium.com/api/auth/magic/verify?token=…"
```

Open that URL in the browser; you'll be logged in. This confirms everything except the
email transport.

---

## Step 6 — Google OAuth setup

In the [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services →
Credentials → your OAuth 2.0 Client ID:

- **Authorized redirect URI** must be exactly:
  `https://relayium.com/api/auth/google/callback`
  (the server derives this from `-base-url` + `/api/auth/google/callback`).
- Authorized JavaScript origins: `https://relayium.com`.

Put the client ID/secret into the systemd unit (`-google-id` / `-google-secret`) and
restart the service.

---

## Verify

Run these from anywhere after deploying. The point is to confirm `/api/*` reaches Go
(not the static SPA):

```bash
# Health (Go): plain-text "ok"
curl -s https://relayium.com/healthz                       # → ok

# Session check (Go): 401 + JSON when logged out.
# If this returns 200 text/html, nginx is NOT proxying /api → fix Step 4.
curl -i https://relayium.com/api/me 2>&1 | head -n 3
#   HTTP/2 401
#   content-type: application/json

# Google start (Go): 302 redirect to accounts.google.com.
# If this returns 200 text/html, same /api proxy problem.
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://relayium.com/api/auth/google/start
#   302 https://accounts.google.com/o/oauth2/auth?...

# ICE servers (Go): JSON with iceServers
curl -s https://relayium.com/api/ice | head -c 80          # → {"iceServers":[...]}

# A legal page (static): slash-less URL serves the page, no 301
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://relayium.com/privacy
#   200 text/html

# Admin dashboard (Go): the login form, NOT the SPA homepage.
# If this prints "Relayium — End-to-end…" the /admin proxy block is missing
# (nginx served index.html); if it 404s, -admin-pass isn't set on the server.
curl -s https://relayium.com/admin | grep -o '管理员账号\|Relayium 后台'
#   管理员账号
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Login does nothing; Google button just reloads the page; no magic-link email | nginx not proxying `/api/` — `curl -i https://…/api/me` returns **200 text/html** instead of 401 JSON | Add the `location /api/` block (Step 4), `nginx -t && systemctl reload nginx` |
| `/api/me` returns 401 JSON ✓ but no magic-link email arrives | `-smtp-addr` empty (links only logged) or unauthenticated-relay limitation | Step 5: set up a local relay, or add SMTP-auth flags (Option B) |
| Google button reaches Google but it shows "invalid client" / redirect_uri mismatch | `-google-id/-secret` empty, or redirect URI not registered | Step 6: set creds and register `https://relayium.com/api/auth/google/callback` |
| Logs in, but reload shows logged-out | Session cookie not `Secure`/`SameSite` viable, usually because `-base-url` is `http://…` while the site is https | Set `-base-url https://relayium.com` and restart |
| Cross-network transfer can't connect; LAN works | `/api/ice` not proxied (returns HTML) or TURN not configured | Fix `/api/` proxy; configure `-turn-*` (see coturn.md) |
| `/privacy` 301-redirects to `/privacy/` | a stricter location forces trailing slash | Rely on `try_files $uri $uri/ /index.html`; don't add a trailing-slash redirect for legal paths (their canonical is slash-less) |
| `/admin` shows the normal homepage instead of a login form | nginx not proxying `/admin` — it matched `location /` and `try_files` served `index.html`. `curl -s https://…/admin \| grep -o 'End-to-end'` matches | Add the `location /admin` proxy block (Step 4), `nginx -t && systemctl reload nginx` |
| `/admin` returns 404 | `-admin-pass` not set, so the dashboard is disabled, **or** the running binary predates the admin feature | Set `-admin-pass` (and optionally `-admin-user`) in the systemd unit or `.env`, rebuild, `systemctl restart relayium` |

---

## Redeploying

```bash
git pull
cd web && npm ci && npm run build          # refresh dist + regenerate legal pages
cd ../server && go build -o relayium .
sudo systemctl restart relayium
# static is served directly from web/dist; nginx needs no reload unless its config changed
```
