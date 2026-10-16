# CLI repair release record (v0.27.1)

Status: released on 2026-10-16 as [v0.27.1](https://github.com/relayium/relayium/releases/tag/v0.27.1),
from commit `e46dc8e18945596abc72ed6a4a78a663006a41c6`. The central
backend is deployed from the same commit. The release includes the repairs
below; the deferred work remains deferred.

## What changed

| Area | Change |
|---|---|
| `login` | Refused before any request when `--config-dir` already holds a credential (same or other server), or holds an unreadable one. Nothing in the directory changes. Switching is `logout` then `login`. |
| `sync` | "Unchanged" is decided by content: the sender puts each file's SHA-256 in the manifest (new omitempty fields, only with a new `Hello.ContentCheck` flag); a new receiver skips only size+digest-equal files, installs a received file only when it matches the manifest digest, and echoes support. `--checksum` refuses an older receiver before any file body. `--strict-delete` (with `--delete`) exits 1 unless the receiver confirms the delete ran in full, and refuses an older receiver before any file body. |
| direct client (`push`/`sync` to `relayium://`) | Handshake has its own deadline (30 s); the transfer is bounded per read (10 min) and per write (2 min, at most 16 KiB per deadline) rather than by a total time. SIGINT/SIGTERM abort a one-shot transfer at once; `sync --watch` gets a 30 s drain. Digests are computed before dialing and stop on a signal. |
| `serve` | SIGINT/SIGTERM: stop accepting, drain 30 s, abort remaining transfers by closing the raw connection, exit 0 if nothing was aborted else 1 (`--once`: 0 only if its transfer completed). Replies are write-deadline bounded. |
| `up` (R3) | Recovery probe body never yields a byte and blocks (bounded, 30 s) instead of failing on an early `100 Continue`, so a proxy's early continue no longer hides the origin's replay; recovery offers HTTP/1.1 only via ALPN (verification unchanged). Records keep a file-count/byte summary (no names), are size-bounded identically on save and load, strict single-value JSON. A recorded upload cancelled after its body was sent is reported unknown, never as a plain cancellation. |
| `sync` strict (R3) | `--checksum` / `--strict-delete` first send a preflight (`Hello.Preflight`, sync+content check, no Delete, empty manifest). A current receiver echoes support and continues on the same connection (works with `serve --once`); an older receiver sees an empty sync that writes and deletes nothing, and the sender stops before the real Delete request. |
| `up` | Each upload is recorded privately (operation key + content key) before the request and sent with `Idempotency-Key` and an exact `Content-Length`. A lost answer exits 3 and keeps the record; `up --recover <id>` asks the server with `Expect: 100-continue` and a body that refuses to be read, so nothing is uploaded or counted again. `--json`, `--pending`. |
| `inbox status` | `--check` (0 ready / 3 not ready / 1 query failed) requires local enablement, usable directory, worker lock, readable keys, and server-side enrolment, not revoked, presence online, policy `auto`, directory ready, a supported protocol/capability and the active key held. `--json` prints one document on success and failure. |
| `whoami`, `update --check` | `--json`; `update --json` without `--check` is refused. |
| `up`/`down` input | `--max-downloads` < 0 refused before credentials/files/network; 0 means the server's default policy (not necessarily unlimited). `down -` reads the link from stdin (8 KiB, one line, not a terminal). Claim-parse errors never repeat the input. The `up` stderr hint no longer repeats the link. |

The release also classifies a recorded upload as unknown once the HTTP
transport has consumed its complete advertised body, even when the producer
is still blocked in its final progress callback. A lost response or HTTP 502
after commit keeps the recovery journal and key; a headers-only recovery
returns the existing object without another upload or debit. The signed released v0.27.1 CLI was checked against a private central
upgrade that preserved an object uploaded by the signed v0.27.0 CLI.

## Compatibility

- Wire: every new field is `omitempty` and sent only when the new flag is set,
  so a sender without content checking produces byte-identical frames
  (`stream_golden_test.go` unchanged). An old receiver ignores the new
  fields and is detected by the missing echo; it is never trusted.
- Old receiver, default sync: falls back to size+mtime with an explicit
  warning — the defect persists against old receivers until they are updated.
- Old sender → new receiver: unchanged behaviour.
- `up` recovery against a server without idempotent uploads: the server asks
  for the body, nothing is sent, the outcome stays unknown (exit 3).

## Known limits and deferred work

- **A2 deferred**: stable CLI installation identity (re-login landing on the
  same device) needs a server-side client-kind field and a central release.
- **D2 deferred**: true mid-body resumable `up` (chunked `/api/uploads`). An
  upload stopped part-way is not resumed.
- Content checking reads every source file once per sync, and the receiver
  hashes same-size copies; large trees cost CPU/IO, not bandwidth.
- Upload recovery is a joint client + origin repair, released in v0.27.1 and the same deployed central commit: the
  CLI probe sends no byte and waits (bounded) past a proxy's early
  `100 Continue`; the origin (`account` answerUploadOperation) marks every
  answer it gives from a key `Connection: close`, so net/http does not first
  try to drain up to 256 KiB of the unread body. Verified through a private
  nginx 1.31.3 (HTTP/1.1 and HTTP/2 fronts) for empty, tiny, ~90 KB and
  ~360 KB uploads: same object, unchanged meter, ~335 bytes on the wire.
  Against an origin without that change, recoveries of uploads up to 256 KiB
  behind such a proxy end UNKNOWN (safely: no byte sent, record kept).
- A recovery that is not confirmed is reported as "not confirmed", never as
  "absent".
- The upload journal fails closed: if its directory cannot be opened or
  fsynced, no record is kept and nothing is sent. On Windows the directory
  rename is not fsynced (not supported); no power-loss guarantee is claimed
  there, and power loss was not tested on any platform.
- HTTP/1.1-only recovery is defence in depth: with the blocking probe the
  nginx HTTP/2 front also worked in tests.
- Upload records on Windows are protected only by the configuration
  directory's inherited profile ACL (no owner-SID/ACL check, no ACL change);
  Windows behaviour is cross-compiled only, not runtime-verified.
- `inbox status --check` on a platform without the worker lock reports
  `worker_unknown` (never ready).
- Dry-run, include/exclude rules and trust-management commands remain
  proposals, not part of this repair.
