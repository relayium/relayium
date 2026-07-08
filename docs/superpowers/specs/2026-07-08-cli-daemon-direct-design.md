# Relayium CLI — Daemon Direct Mode (Spec)

Date: 2026-07-08
Status: Implemented (2026-07-08). `serve` / `id` / `push relayium://…` shipped on
branch `cli-daemon-direct`; `internal/secure` persistent identity + `internal/trust`
added. See §8 tests: `internal/secure/identity_test.go`, `internal/trust/trust_test.go`,
`cmd/relayium/daemon_e2e_test.go`, `cmd/relayium/daemon_test.go`.

## 1. Motivation

Relayium's CLI has two transfer topologies today:

- **`push`/`pull` (SSH-native)** — bytes go over the user's own SSH; requires an
  account/SSH key on the remote.
- **`send`/`receive` (cross-net, Spec 1)** — peers meet via a short code in the
  `relayium.com` rendezvous, exchange TLS fingerprints via commit-reveal, race a
  direct TCP connection (free) and fall back to the metered `/relay`.

Neither covers the natural **server-to-server** case: two hosts the user
controls, both with known addresses, both running Relayium. For that case SSH is
unnecessary friction and the rendezvous round-trip through `relayium.com` is
pure overhead — the peers already know each other's address. **Daemon Direct
Mode** adds a third topology: one host listens, the other pushes straight to it,
with **zero traffic — control-plane or data-plane — through relayium.com**, no
SSH, no account, no short code.

This maps to README Roadmap **M3 (Protocol spec + multi-client)**.

## 2. Goals / Non-goals

**Goals**

- `relayium serve` — a listener that receives pushed files, long-running by
  default, `--once` for a single transfer.
- `relayium push <src...> relayium://host[:port]` — push straight to a listening
  peer over a pinned TLS 1.3 connection.
- Mutual authentication with **no shared secret**: both directions use public-key
  (certificate) pinning.
  - Push side trusts the listener via **TOFU** (like SSH `known_hosts`), with
    optional pre-pinning.
  - Listen side admits pushers via a pre-authorized fingerprint list (like SSH
    `authorized_keys`).
- Persistent identity so fingerprints are stable across sessions.
- `relayium id` — print this host's fingerprint for pasting to the peer.

**Non-goals (this spec)**

- `pull` / reverse direction. Push only.
- CLL↔browser interop (deliberately incompatible wire format; see Phase 2 spec).
- NAT hole-punching / rendezvous / relay fallback. Daemon mode assumes a
  reachable listener address; if the dial fails, it fails (no relay).
- Concurrent serve handling. Serve processes connections **serially** (accept →
  handle → accept). Multi-peer concurrency is deferred until a real need appears.
- Minting/auth against relayium.com (that is the separate Spec 2 work).

## 3. Architecture

Daemon mode is deliberately **simpler** than cross-net: it reuses the transfer
engine and the pinning primitives but drops the entire rendezvous + glare
control plane. It does **not** touch `internal/rzvous` or `internal/connect`.

| Location | Change |
|---|---|
| `cmd/relayium/serve.go` (new) | `relayium serve`: listen TCP, accept loop (`--once` = one), per-connection pinned-TLS server handshake + authorization → `xfer.Receive` |
| `cmd/relayium/push.go` (modified) | If `push` target begins with `relayium://`, dispatch to the daemon dialer; otherwise keep the existing SSH path unchanged |
| `cmd/relayium/dialdaemon.go` (new) | Daemon dialer: TCP dial → pinned-TLS client (known_hosts / TOFU) → `xfer.Send` |
| `cmd/relayium/id.go` (new) | `relayium id`: print this host's fingerprint |
| `internal/secure` (modified) | `LoadOrCreateIdentity(dir)` persistent identity; a server variant that admits a fingerprint **set**; a TOFU client variant that accepts any peer cert and reports its fingerprint |
| `internal/trust` (new) | Read/write + evaluate `known_hosts` and `authorized_fingerprints`; TOFU decision logic |

**Reuse.** The transfer engine `xfer.Send`/`xfer.Receive` is used verbatim — it
already runs over a pinned-TLS `net.Conn` (proven by the cross-net path) and its
`safeJoin` (`internal/xfer/recv.go`) already rejects `..`-escape and absolute
paths, so serve inherits path safety at zero cost.

## 4. Data flow

**serve**

```
load/create persistent identity (id.key/id.crt)
read authorized_fingerprints → allow-set (empty ⇒ warn: rejects all)
listen TCP :port
loop (once ⇒ single iteration):
    conn = accept
    tconn = secure.ServerSet(conn, id, allow-set)   # TLS1.3 + require client cert + fp ∈ set
        ├─ fp ∉ set → close conn, log "rejected unauthorized peer <fp> from <ip>", continue
        └─ ok       → xfer.Receive(tconn, dir)       # lands under --dir; safeJoin enforces no escape
    log: from <fp>, files, bytes
```

**push**

```
parse relayium://host[:port]                        # default port 9031
load/create persistent identity
dial TCP host:port
look up host:port in known_hosts:
    ├─ present & match → pin it, handshake (secure.Client)
    ├─ absent          → TOFU: handshake accepting any cert → write known_hosts → print "learned <fp>"
    └─ present & differ → refuse + warn (key rotation or MITM); DO NOT auto-overwrite
xfer.Send(tconn, manifest, paths)
```

## 5. Identity & trust files

Config dir: `$XDG_CONFIG_HOME/relayium/` (fallback `~/.config/relayium/`),
overridable with `--config-dir` (e.g. `/etc/relayium/` for a systemd serve).

| File | Owner side | Format | Semantics |
|---|---|---|---|
| `id.key` (0600) + `id.crt` | both | persistent self-signed cert | auto-generated on first use; **refuse to load if perms are not 0600**, print chmod hint (SSH behavior) |
| `known_hosts` | push side | `host:port <sha256hex>` per line | TOFU first-write; match ⇒ proceed; differ ⇒ refuse + warn, never auto-overwrite |
| `authorized_fingerprints` | serve side | `<sha256hex>  # optional comment` per line | only set members may push; empty file ⇒ reject all (startup warning) |

Fingerprint definition is **unchanged** from the existing pinning code: SHA-256
hex of the peer leaf certificate DER, exactly what `secure.pinCheck`
(`internal/secure/channel.go`) already compares. `relayium id` prints this
host's own value.

## 6. CLI surface

```
relayium serve [--dir <recv-dir>] [--port N] [--once] [--config-dir D]
    Listen for pushes. --dir defaults to the current directory. Long-running
    unless --once. Serves connections serially.

relayium push <src...> relayium://host[:port]
    Push to a listening peer. No remote subpath — landing location is entirely
    the serve side's --dir. Source relative structure is preserved by the
    manifest under --dir. Existing SSH push (target user@host:path) is unchanged.

relayium id [--config-dir D]
    Print this host's fingerprint, for pasting into the peer's known_hosts
    (push→serve trust) or authorized_fingerprints (serve→push trust).
```

Default port: **9031** (`--port` to change; a URL without a port uses it).

There is intentionally **no** `relayium://host:port/subpath` form: the serve side
alone decides where bytes land, which is both simpler and safer.

## 7. Error handling

- **push, fingerprint mismatch** — fatal. Print `expected X / got Y` and guidance
  (if this is an intentional key rotation, remove the `known_hosts` line or use
  `--pin`). Never silently overwrite.
- **serve, unauthorized peer** — pin fails, so the TLS handshake fails; close the
  connection, log `rejected unauthorized peer <fp> from <ip>`, reveal nothing
  extra to the peer.
- **serve, empty authorized list** — still starts (so a user can bring up serve
  before configuring), but warns and points at `relayium id`.
- **bad `id.key` perms** — refuse to load, print chmod hint. Generate at 0600.
- **dial timeout / port in use / TLS failure** — clear error, non-zero exit.
- **interrupted transfer** — reuses `xfer`'s SHA-256 resume; `--no-resume` opts out.

## 8. Testing

- `secure`: `LoadOrCreateIdentity` idempotent (second load = same fingerprint);
  generated key is 0600; bad perms rejected; `ServerSet` admits in-set / rejects
  out-of-set; TOFU client variant reports the peer fingerprint.
- `trust`: `known_hosts` three states (first-write / match / differ);
  `authorized_fingerprints` parsing (comments, blank lines, empty file).
- E2E (in-process, mirroring `crossnet_e2e_test.go`): serve `--once` + push ⇒
  file lands and SHA verifies; unauthorized pusher rejected; known_hosts mismatch
  rejected; TOFU first-connect writes known_hosts.
- push target dispatch: `relayium://…` → daemon, `user@host:` → SSH.

## 9. Open questions / future

- Binary distribution (release / `go install` / brew) — shared with the other
  CLI specs, still undecided.
- `authorize`/`revoke` subcommands to edit `authorized_fingerprints` without hand
  editing — deferred; hand-edit + `relayium id` is enough for v1.
- Concurrent serve, `pull`/reverse direction, systemd unit packaging — deferred.
