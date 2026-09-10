# `apps/windows/native` — Windows receive IO core

An independent Go module producing `relayium-io-helper.exe`: the privileged
filesystem half of a Windows receive lease. It is the component that can do what
Node's `fs` cannot on Windows — publish a completed file without ever replacing
an existing one, and stay contained in the folder the user chose even while
directories are being swapped underneath it.

**Status: core only, first Windows runtime evidence in hand. Not integrated.**
There is no Electron adapter, no `electron-builder` packaging and no CI
registration here; those are a later, separately owned slice.

A real Windows runner has now executed this module's tests. **Every shipping
`internal/winio` invariant passed**, with no skips: no-replace publication and
the concurrent-publication conflict, existing-file and directory-type-conflict
preservation, interior-junction refusal, root-junction follow-once-then-pin
*including an actually-performed retarget* (reported
`PROVEN-INVARIANT: re-pointing a root junction cannot redirect writes`),
ancestor rename/delete refusal while pinned, cleanup by handle with unowned
content preserved, the staging sentinel, cancel at each barrier, and — against
the real executable — parent EOF, hard-kill residue bounds and the forced
five-second shutdown bound.

Two tests failed, both in the **quarantined experimental** on-close primitive
that no shipping path calls: `setOnCloseDeletion` is refused with
`STATUS_NOT_SUPPORTED` on that host. See the on-close section below; the
capability is one-directional there, `OnCloseDeletionEnabled` stays `false`, and
**hard-kill residue is still bounded-and-documented rather than zero.**

Still not verified: the module is unintegrated, so nothing here has run behind a
real Electron adapter or from a packaged install, and no host other than that
runner has been observed.

## The invariant everything else follows from

> Every write and every publication targets an object we already hold a handle
> to. No operation is preceded by a path check that a later step depends on.

There is no `lstat`-then-`rename` anywhere. Publication renames the very handle
the bytes were written through, so the object published is provably the object
that was written, rather than the object that happened to be at a pathname.

## How it works

1. **Open.** The host sends the user-selected root and the manifest. The root is
   opened once, following a reparse point if it is one — the user chose it, so it
   is authorised — and the resulting handle is held for the session **without
   `FILE_SHARE_DELETE`**. That omission is the pin: the root cannot be renamed or
   deleted while the lease is live. The manifest is re-validated here from
   scratch; nothing is trusted from the host.
2. **Stage.** The helper creates its own staging directory under the root with
   `FILE_CREATE`, so it provably made it rather than adopting something that was
   already there, and holds that handle too. Staged files are flat and
   index-named, so **no manifest-supplied byte reaches the filesystem before
   publication**.
3. **Stream.** Bounded chunks, exact declared lengths, accounted by what the OS
   reports taking. Each staged file's handle is retained from `begin`.
4. **Publish.** The destination directory chain is walked one component at a time
   from the pinned root, refusing any reparse point on the handle before creating
   anything beneath it, and holding every traversed handle. The staged handle is
   then renamed into place with `FILE_RENAME_INFORMATION.Flags = 0` — no replace,
   no POSIX semantics, no fallback.
5. **Settle.** Cancel, EOF, protocol failure and publish failure all delete owned
   staged objects **by handle** and remove the staging directory.

## Integrator contract

These are not suggestions; violating them is a terminal session error.

| Rule | Why |
|---|---|
| Launch the packaged EXE at a fixed resolved path, `shell:false`, **no arguments**. | The helper refuses any argv. Nothing identifying may sit where every process can read it. |
| Send the root from the **main process** only, from a native picker. Never a renderer-supplied path. | Destination authority stays privileged; the renderer only ever names a file by its index in a manifest the lease already validated. |
| **Drain stdout continuously**, on its own handler. | Replies fill a bounded outbox; a host that stops reading gets `E_HOST_BACKPRESSURE` and the session ends. |
| Keep at most **one request in flight**. The inbox tolerates 8. | Beyond that the session terminates rather than blocking its reader, which would hide a queued `cancel`. |
| Own a **deadline and a kill**. | The helper guarantees it will not hang forever; it cannot guarantee it can always finish. A write to a wedged volume is not interruptible from inside the process. |
| Treat premature exit as failure of every outstanding request. | Non-zero exit is itself a signal. |
| Wait for the `ready` event before `open`. | A launch or architecture mismatch then settles the caller instead of hanging. |

## Framing

Big-endian throughout.

```
frame  := u32 length            # bytes that follow; 1 <= length <= 8 MiB
          u8  kind              # 1 request(JSON) 2 chunk(binary) 3 response(JSON) 4 event(JSON)
          payload[length-1]

chunk  := u64 id | u32 index | data[...]      # data length is derived from `length`
```

Limits, all enforced before allocation: frame 8 MiB · `open` request 4 MiB ·
every other request 64 KiB · **response 4096 bytes, enforced on encode** · chunk
256 KiB (identical to `MAX_CHUNK_BYTES` in `src/main/io/receive-lease.ts`).

Request payloads must be valid UTF-8. Go's JSON decoder silently substitutes
U+FFFD otherwise, which for a manifest name would create a file with a different
name than the sender declared.

## Operations

| Op | Request | Success result |
|---|---|---|
| *(event)* | — | `{"event":"ready","protocol":1}` |
| `open` | `{id, op, root, manifest:[{name,size}]}` | `{files, directories, longPath}` |
| `begin` | `{id, op, index}` | `{}` |
| *(chunk)* | binary frame | `{written, declared}` |
| `finish` | `{id, op, index}` | `{bytes}` |
| `publish` | `{id, op}` | `{status:"complete", publishedCount, total}` |
| `cancel` | `{id, op}` | `{removedFiles, residue}` |

`open` is accepted exactly once: **the process is the lease.**

### A failure reported by the filesystem ends the session

There are two kinds of error reply, and the difference matters for what the host
should do next:

* **Rejected before anything was touched** — a bad manifest, an unknown field, a
  bad index, an oversized request. The disk was never involved, so the session is
  still usable. A corrected `open` after an `E_MANIFEST` is accepted.
* **Reported by the filesystem** — anything that comes back from a write, a
  staged create, a flush or the destination root. The session is **terminal**.
  Every later operation returns `E_SEQUENCE`, and `publish` will not run.

**Do not retry an operation that failed with a filesystem error.** Send `cancel`
(or just close stdin) and start a new lease if the user retries.

The reason is specific. A write that fails may have moved some, all or none of
its bytes, and no count returned alongside an error is trustworthy enough to
resume from. If the session stayed writable, resending the same chunk would
APPEND rather than overwrite: the staged file would end up longer than declared
while the length accounting counted each byte exactly once, so it would satisfy
the exact-length check at `finish` and publish as complete. A four-byte file
would be published containing six bytes. The exact-length check cannot catch
this, because both numbers it compares are correct — the file is what is wrong.

`E_SHORT_WRITE` covers the two ways a sink can be broken rather than merely
unlucky: it accepted nothing without reporting an error, or it reported a count
outside the range it was offered. Both are terminal for the same reason.

A **clean** short write — a partial count with no error — is not a failure and is
handled normally: the helper loops until the chunk is fully written.

### Shutdown never starts a queued operation

Once shutdown is known — stdin EOF, an explicit `cancel`, a broken stdout, a
protocol failure — the helper will not START an operation that is still queued.
Specifically:

* An operation **already running** is allowed to finish. It holds a handle and
  may be mid-write, so abandoning it would be worse than completing it.
* An operation still **queued** is refused with `ok:false` and `E_CANCELLED`.
  It is refused rather than dropped, so every request you send is answered — but
  it is **not executed**.
* In particular **a queued `publish` never runs.** Publication renames staged
  files to their destinations, so running one during teardown would create
  user-visible files after you asked to stop, or after the reply channel had
  already broken and nothing could tell you what happened.

The practical rule for the host: **do not close stdin, or send `cancel`, while a
request you care about is still unanswered.** Wait for the reply. This is the
same one-request-in-flight discipline the contract already requires, and
`publish` is the operation where it matters most — as always, **only a confirmed
`publish` response means a successful save.**

### Requests are fully validated when they are read

The op and its required fields are checked at the framing boundary, not by the
dispatcher. An undefined op, or a `begin`/`finish` without an `index`, is a
**terminal** protocol failure (exit 2), the same as an unknown field, a zero id
or an oversized request — not a recoverable error reply.

This is what makes the shutdown rule above safe: a frame is judged when it is
read, so one still sitting in the queue at teardown can be refused without being
executed and without the protocol failure going unreported.

### The publish receipt

Publication runs in manifest order and stops at the first failure, so the
published set is always the prefix `0..publishedCount-1` and never needs
enumerating. That is what keeps the receipt O(1) and the 4096-byte response bound
real for a 1000-file manifest.

A partial batch is **never** `ok: true`, and the success shape carries no
`failed` field. There is no response that reports full receipt for a partial
batch:

```json
{"id":6,"ok":false,"code":"E_PARTIAL_PUBLICATION",
 "result":{"status":"partial","publishedCount":2,"total":5,
           "failed":{"index":2,"code":"E_EXISTS"},
           "unattempted":{"from":3,"to":4}}}
```

**Completed outputs 0..N-1 stay on disk.** There is no rollback mode. Rolling
back would destroy bytes the user already has in order to tidy up a conflict the
receipt already reports.

## Error codes

`E_PROTOCOL` `E_SEQUENCE` `E_CANCELLED` `E_HOST_BACKPRESSURE`
`E_RESPONSE_TOO_LARGE` `E_INTERNAL` `E_MANIFEST` `E_NAME_TOO_LONG` `E_ROOT`
`E_REPARSE_COMPONENT` `E_UNSUPPORTED_VOLUME` `E_EXISTS` `E_TYPE_CONFLICT`
`E_ACCESS` `E_SHARING` `E_NO_SPACE` `E_DELETE_PENDING` `E_NOT_FOUND` `E_IO`
`E_LENGTH_EXCEEDED` `E_LENGTH_SHORT` `E_SHORT_WRITE` `E_PARTIAL_PUBLICATION`

Stable strings — the renderer maps them to copy, so renaming one is a breaking
change. `E_IO` carries the raw NTSTATUS in hex in `detail`. **No code or detail
ever carries a path or a filename.**

Exit codes: `0` clean · `2` protocol violation · `3` cleanup incomplete, residue
reported · `4` internal · `5` shutdown grace exceeded.

## Deliberate limitations

* **Network / UNC destinations are refused** at `open` with
  `E_UNSUPPORTED_VOLUME`. This is a **capability limit pending evidence**, not a
  claim that SMB lacks atomic rename — no-replace rename and POSIX deletion have
  simply not been demonstrated on a redirected volume by this project yet.
* **A hard kill leaves bounded residue.** Graceful cancel and EOF clean up
  completely. `TerminateProcess` leaves at most one
  `<root>\.relayium-incoming-<32 hex>` directory containing at most N `.part`
  files. Residue is never at a destination pathname, never overwrites anything,
  and is never adopted or swept by a later session — sweeping would mean deleting
  objects another live lease may own. The primitive that could shrink this to
  zero is quarantined; the section below records what a real host said about it.
* **Interior reparse points are refused**, including ones the user created
  legitimately. Containment to the chosen subtree is the product promise, and the
  alternative — resolving and string-comparing against the root — is the
  check-then-use pattern this module exists to avoid.
* **Destinations longer than 260 characters are allowed** (everything is
  handle-relative, so `MAX_PATH` does not apply) and reported via
  `longPath: true` so the UI can warn that some Win32 applications will struggle.
* **SETTING delete-on-close through the disposition class is refused, not
  merely unproven** — the clear direction is accepted, so this is a statement
  about one flag combination and not about the class or about all hosts. The
  withdrawn zero-residue design needed to SET delete-on-close on a staged file
  through `FILE_DISPOSITION_INFORMATION_EX`. On the first real runner that call
  returned `STATUS_NOT_SUPPORTED`:

  | Flags | Value | Result |
  |---|---|---|
  | `DELETE\|ON_CLOSE\|IGNORE_READONLY` (set) | `0x19` | **refused** |
  | `DO_NOT_DELETE\|ON_CLOSE` (clear) | `0x08` | accepted |
  | `DELETE\|POSIX\|IGNORE_READONLY` (`deleteByHandle`) | `0x13` | accepted |

  The third row is why this is a statement about the flag combination and not
  about the information class: `deleteByHandle` uses the same class and its
  tests pass. Clearing works — a file created with the `FILE_DELETE_ON_CLOSE`
  create option survived its close after a clear — so the primitive is
  available in ONE direction. That is not enough to build the design on, and
  half a primitive is not a primitive. `OnCloseDeletionEnabled` stays `false`,
  `setOnCloseDeletion` has no caller, and bounded hard-kill residue above
  remains the shipped and documented behaviour.
* **The native manifest bounds are stricter than the TypeScript planner's**:
  1 MiB aggregate name bytes and 4096 distinct directories, neither of which
  exists in `src/main/io/plan.ts`. Both bound resources this process holds. They
  refuse explicitly and never truncate; main should pre-check them so the user
  sees a better message than a boundary refusal.

## Tests

```
go test ./...                                     # portable: protocol, naming, state machine
GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./internal/winio ./internal/helpertest
```

`go build ./...` does **not** compile `_test.go` files, so it never demonstrates
that the Windows tests compile — use `go test -c` for that.

**Portable tests prove no filesystem invariant.** They run against an in-memory
sink and cannot establish no-replace publication, reparse refusal, handle
pinning, ancestor-swap resistance or cleanup. Every portable test file says so in
its header. Those claims rest entirely on `internal/winio` and
`internal/helpertest`, which run only on Windows.

### Run the Windows suite with -v and read the markers back

Some Windows invariants need a setup step the environment may refuse — creating a
junction needs privilege, and re-pointing one can be blocked. `go test` reports a
package whose tests SKIPPED as `ok`, so **a green summary line does not mean the
invariants in this module were established.** Read the markers:

| Marker | Meaning |
|---|---|
| `PROVEN-INVARIANT:` | the attack step actually ran and the invariant held |
| `UNPROVEN-INVARIANT:` | this run did NOT establish the named claim |
| `EXPERIMENT-UNSUPPORTED:` | the platform DECLINED a disabled experimental capability. Not a shipping failure, and not evidence the capability works |
| `OPEN-QUESTION:` | a platform answer was recorded, not an invariant asserted |

```
GOOS=windows GOARCH=amd64 go test -v ./internal/winio ./internal/helpertest
```

Any `UNPROVEN-INVARIANT:` line in a run is a gap in that run's evidence,
regardless of the exit code. Treat the retarget and interior-junction claims as
unproven until a run reports them proven.
