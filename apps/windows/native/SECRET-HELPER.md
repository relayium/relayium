# `relayium-secret-helper` — integrator contract

**Status: implemented, portable gates green, Windows-unverified.**
Nothing in this document is a claim that DPAPI behaved as described on a real
host. The Windows tests compile for both architectures and have never run.

## Why it exists

Electron's `safeStorage` on Windows seals through a master key persisted in
`Local State`. Root's four-cell matrix showed the sealed bytes survive a forced
kill while that master key does not: the secret is then unrecoverable while
looking perfectly intact, and a normal quit passes, which is why it survived
testing. Root's reading of the pinned Electron/Chromium source established that
the async DPAPI key provider — which is *researched*, not what ships today —
reads the same pref and key, so switching to it would not help.

This helper calls `CryptProtectData`/`CryptUnprotectData` directly. There is no
master key of ours to lose: the key is the user's, held by the OS.

## Protocol

One request per process. The parent writes one frame, **closes stdin**, reads
one frame, and owns a deadline and a kill.

```
request    "RLSQ" | version u8 | op u8     | length u32be | payload
response   "RLSR" | version u8 | status u8 | length u32be | payload
```

Header is 10 bytes. Version is 1.

| | |
|---|---|
| `op` | `1` seal, `2` open. No other op exists. |
| `status` | `0` ok, `1` protocol, `2` refused, `3` internal |
| exit | status `0`→`0`, `1`→`2`, `2`→`3`, `3`→`4` |

### Bounds, per direction

| Operation | Request payload | Response payload |
|---|---|---|
| `seal` | ≤ 65536 (plaintext) | ≤ 69632 (blob) |
| `open` | ≤ 69632 (blob) | ≤ 65536 (plaintext) |

### Read order

1. Read the fixed **10-byte header**.
2. Validate magic, version, operation, and the declared length against that
   operation's bound.
3. Only then allocate **exactly** the declared size and read the payload.
4. One further read; anything present is a trailing-byte failure.

A declared length past its op's bound therefore consumes **no payload and
allocates nothing** — asserted by a counting reader, not asserted in prose. An
earlier implementation read the whole input first and validated afterwards,
which drained the reader and grew a buffer before the header was looked at.

Every owned buffer is wiped on every failure path, including a partial read: a
seal payload is plaintext, and a buffer that failed to fill still holds some of
it. Only the validated payload is transferred to the caller.

**Trailing bytes after the declared payload are a protocol failure** — a second
request smuggled into one process would otherwise sit unread, and a future
change that looped would execute it.

## Host rules

1. **One process per operation.** No reuse, no session.
2. **Close stdin after the single frame.** The helper reads to EOF to detect
   trailing bytes; a parent that never closes will block it.
3. **Own a deadline and a kill**, and join the process. The helper guarantees
   bounded work on bounded input, not that it can return if the pipe stays open.
4. **Pass no arguments.** Any argv is refused with exit 2.
5. **The blob is opaque.** The helper owns the raw DPAPI blob only; any
   application envelope or discriminator is the host's and lives outside this
   process. There is no "not our envelope" branch here.
6. **A refusal is a refusal.** `status 2` does not distinguish a tampered blob,
   a foreign blob and a wrong user, and the host must not present it as one of
   those specifically.

## What the helper guarantees

- **User scope only.** `CRYPTPROTECT_LOCAL_MACHINE` is never set.
- **`CRYPTPROTECT_UI_FORBIDDEN` always set.** A prompt in a background process is
  a hang.
- **No description, no optional entropy.** `szDataDescr` nil means the API
  allocates no string on unprotect, leaving exactly one buffer to free per call.
  Entropy would have to be stored somewhere as exposed as the blob itself, so it
  would add a way to lose the secret without addressing the threat user-scope
  DPAPI covers.
- **Every API allocation is wiped and freed on every path**, including paths that
  fail afterwards, and an over-bound result is released **without being copied**
  — the bound is checked before the copy, not after.
- **Plaintext is zeroed** after use, and never logged, echoed or placed in an
  error.
- **stderr is a closed set of words**: `protocol`, `oversize`, `trailing`,
  `refused`, `encode`, `write`. Never plaintext, never a blob, never a length,
  never a path.
- **No filesystem, no network, no environment, no argv.** The three standard
  handles are the only channels.

## Integrity does not rest on DPAPI

`CryptUnprotectData`'s documented remarks say a corrupted blob may fail with
varying error codes, and that **some corruption may succeed and return corrupted
output**:
<https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata>

So a successful unprotect is not evidence that the bytes are the bytes that were
sealed. Every blob carries an inner record **inside** the protected bytes:

```
domain "RLYMSEC1" (8) | version (1) | reserved (1) | length u32be (4) | sha256(payload) (32) | payload
```

46 bytes of overhead, inside the 69632 blob bound. On open, the domain, version,
reserved byte, exact length and digest are all verified — the digest in constant
time — **before a single plaintext byte is returned**. A valid DPAPI blob that is
not our record, including one written by Electron, is refused rather than
interpreted. This adds no key and no entropy: it is storage-integrity framing,
not wire crypto. The digest lives only inside the protected blob and is never
logged.

## Tests

```
go test ./internal/secretframe ./internal/secretserve        # portable
GOOS=windows GOARCH=amd64 go test -c ./internal/secretprotect ./internal/secrethelpertest
```

Portable tests prove framing, the record codec and dispatch. **They prove nothing
about DPAPI.** The Windows suites carry `PROVEN-INVARIANT:` /
`UNPROVEN-INVARIANT:` markers; run them with `-v` and read the markers back
rather than trusting the summary line.

The acceptance case is `TestSecretSurvivesAForcedKillOfTheSealingParent`.

It needs a real parent, because the helper runs ONE operation and exits: an
earlier version killed the helper after it had already written its response and
was exiting anyway, so the kill raced a natural exit and could pass without
terminating anything. It also read only until the header arrived, treating a
partial payload as complete.

The test now re-enters the TEST BINARY as a wrapper parent. That wrapper spawns
the real helper, seals, **joins** the helper so its exit cannot be confused with
anything later, hands the blob back, and then **proves it is alive by answering
a ping** — a round trip, not a timer. Only then is it killed, and the test
asserts the wrapper died by the kill rather than finishing on its own. A fresh
helper must open the blob.

The shipped helper gains no flag, no mode and no environment variable for any of
this; the wrapper switch is read by the test binary alone. Every real subprocess
runs under a context budget and is joined through `t.Cleanup`, so a failing test
cannot leave a child behind.

**Cross-user protection is reported UNPROVEN.** It is a real property of
user-scope DPAPI, but proving it needs a second real account that these tests
will not create, and inferring it from the flags passed would describe the
request rather than test the outcome.

## Not certified

OS-level power loss and profile/user reset are outside what these tests
establish. The forced-kill and tamper cases are the ones that must pass.
