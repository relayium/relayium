# CLI pairing codes — `relayium send` mints its own — design

Date: 2026-07-26
Status: approved (design), pending implementation plan

## Background

A user ran, against production:

```
$ relayium send pando_uu.zip 726122
rendezvous dial: failed to WebSocket dial: expected handshake response status code 101 but got 403
```

`726122` was never a code. Codes are 6 characters over `ACDEFHJKMNPRTWXY23456789`
(`server/internal/signal/pair.go:124-135`) — `0` and `1` are not in the alphabet —
so `/ws` rejected it on shape alone (`server/main.go:325`) before the registry was
even consulted.

Two fixes for that session already landed and are **not** part of this spec:

- `internal/rzvous`: validate the code's shape before dialing, and surface the
  server's refusal body (which `websocket.Dial` discards) instead of the raw
  handshake status.
- `relayium-ops`: nginx never proxied `GET /device`, so the CLI-login approval
  page 404'd in production while being correctly registered in Go.

What remains is the reason the user was inventing a code in the first place.

## The actual gap

A pairing code can only be minted by `POST /api/pair`, whose caller is resolved by
a hand-written cookie-only closure (`server/main.go:439-443` → `UserFromRequest`,
`server/account/service.go:437`, which reads `r.Cookie(sessionCookie)` and nothing
else). The CLI authenticates with a bearer token (`rlm_cli_…`) from device login.
**So a CLI user cannot obtain a valid code by any means** — not even after
`relayium login` succeeds. `relayium send <file> <code>` has no reachable happy path
for a CLI-only user.

The documentation filled the vacuum with fiction: `README.md:69` shows
`relayium send ./file.zip 123456`, and the site's `cli-send-to-someone` tutorial
states outright that the code is "any short string both sides type" (its example,
`428571`, also fails the format check). `docs/tutorial-content-optimization-report.md`
flagged this on 2026-07-26 and left the resolution open — "either fix the docs to
match the implementation, or let the server accept ad-hoc codes". This spec picks
the third option: let the CLI mint a real one.

## Scope

`send`/`receive` are **machine-to-machine** (CLI↔CLI). Machine-to-browser is
`relayium up`'s job and stays there.

That boundary is not a preference, it is protocol reality. The CLI speaks
commit-then-reveal over the signaling channel with TCP candidates and a pinned
TLS fingerprint (`internal/rzvous/handshake.go`); the browser speaks WebRTC
`{sdp}`/`{ice}` (`web/src/lib/webrtc-core.ts:195-201`). Both would join the same
2-peer room and fail to parse each other's frames. The transports disagree too:
the browser's cross-network path is `iceTransportPolicy: "relay"` (TURN only,
`web/src/lib/ice.ts:95`) while the CLI is direct-only and never relays file bytes
(`server/cmd/relayium/crossnet.go:26-28`). Bridging them means putting a WebRTC and
TURN stack in the CLI and retracting the "bytes never touch our servers" promise
the CLI currently keeps.

**Out of scope:** WebRTC in the CLI; a standalone `relayium pair` command;
minting from `receive`; any change to the browser's existing `#c=` flow.

### Why there is no share link

An earlier draft printed `https://relayium.com/cli#recv=<code>` — a landing page
that would tell the recipient what to run. It is cut. The CLI cannot consume a
URL (`receive` takes a code, not a link), so the link's only audience is a human
who has not installed the CLI — and in a server-to-server transfer that human is
already sitting at a terminal holding the command. It would be a second thing to
copy that resolves to a page repeating the first thing.

Recorded for whoever revisits this: the fragment key `#c=` is **not** available
for a CLI-oriented link. `routeFromLocation` checks `parseCodeParam(hash)` before
the pathname (`web/src/lib/router.svelte.ts:47`), so any URL carrying `#c=` lands
on the WebRTC cross-network page — the one the CLI cannot pair with.
`web/src/lib/router.test.ts:24` pins that behaviour.

## Design

### 1. Server — let `/api/pair` accept the CLI bearer

`account/auth.go` already resolves cookie-**or**-bearer, with a frozen-account
guard (`DeletedAt == 0`) mirroring the cookie path; 10 endpoints use it. It is
only shaped as a wrapper (`RequireAuth`), so a caller needing `(User, bool)` cannot
reuse it.

Extract the resolution into an exported `func (s *Service) UserFromAuth(r *http.Request) (User, bool)`
and reimplement `RequireAuth` on top of it — behaviour-preserving for all 10
existing call sites. Then replace the closure at `server/main.go:439-443` with it.

Everything else about minting is unchanged: owner attribution, the 5-minute TTL,
the 10/min/IP limiter. A CLI-minted code is the same code, on the same books, as a
browser-minted one.

### 2. CLI — `send` mints when no code is given

Positional rule for `runSendCross` (`cmd/relayium/crossnet.go:86-118`): the last
argument is a code **iff** it passes `signal.ValidCodeFormat` **and** does not
exist on disk. Otherwise it is a source path and a code is minted.

Both conditions are load-bearing. Shape alone breaks `send a.zip b.zip` (two files,
no code). Existence alone breaks nothing today but would misread a file literally
named `K7M4XR`, which the disk check resolves in the file's favour.

Minting goes through `internal/cloud`'s client, which already sends
`Authorization: Bearer` (`internal/cloud/transfer.go:166`). Its base URL is derived
from crossnet's existing `--server` by swapping the scheme (`wss://`→`https://`,
`ws://`→`http://`) so self-hosters keep passing one flag, and the stored
credentials are checked against it with `sameServer` (`cmd/relayium/cloud.go:22-25`)
before the token is sent anywhere.

Output on mint:

```
Code: K7M4XR   (valid 5 minutes)
On the other machine:  relayium receive K7M4XR
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
```

Self-contained: one block to paste into a chat window or another machine's SSH
session. (`https://relayium.com/install.sh` verified live, 200.)

`receive` is unchanged and still requires a code. The receiver needs no account —
that asymmetry is the existing capability model, not an oversight.

### 3. Not logged in

`relayium send ./f.zip` with no code and no credentials prints that minting needs
an account (sender only; the receiver never signs in), points at `relayium login`,
and exits non-zero.

It must **not** start a device-login flow. The target environment is servers and
scripts, where blocking on "open this URL in a browser and approve" hangs a job
that had every reason to expect a fast failure.

The message also names `relayium up` as the route to take when the recipient is a
person with a browser rather than a machine — the two paths stay technically
separate and meet only in the error copy.

## Error handling

| Condition | Behaviour |
|---|---|
| No credentials, no code | Explain, point at `relayium login`, exit 1. No network call. |
| Credentials for a different server | `sameServer` mismatch → re-login prompt; token never sent. |
| `/api/pair` 401 (expired/revoked token) | Same copy as "no credentials". |
| `/api/pair` 429 | Report rate limiting, suggest retry in a minute. |
| `/api/pair` 503 (code space exhausted) | Surface the server's message verbatim. |
| Trailing argument is neither a file nor a code | Name both readings and show the mint form; do not guess. |
| Code given but malformed, on `receive` | Existing pre-dial format error (already shipped). |
| Peer never joins | Existing 10-minute context timeout; the code expires in 5. |

## Testing

**`server/account`** — bearer mints; cookie still mints; neither present → 401;
frozen account (`DeletedAt > 0`) → 401 on both paths. The last one is the
regression that matters: it is the guard `RequireAuth` has today and the
extraction must not drop it.

**`cmd/relayium`** — the four last-argument cases (valid-shape code that is not a
file → code; valid-shape name that *is* a file → source, mint; malformed → source,
mint; single source → mint); the not-logged-in message and exit code; the printed
block's exact shape.

**No web tests** — the web is untouched.

## What ships

- `server/account/auth.go` — extract `UserFromAuth`, rebuild `RequireAuth` on it
- `server/main.go` — `/api/pair` uses it
- `server/internal/cloud` — a `Pair()` client method
- `server/cmd/relayium/crossnet.go` — argument rule, mint path, output block
- `README.md:69` and the affected site tutorials — codes are minted, not invented;
  6 characters from a restricted alphabet; 5-minute TTL
