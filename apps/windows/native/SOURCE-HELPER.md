# Source mode: reading a file the user chose

`relayium-io-helper.exe --source-mode` serves bounded, read-only ranges of a
local file, with every path component opened one at a time from the volume root.
It is the same executable as the receive helper and shares none of its policy.

Nothing here is wired into `SelectionReader` or `OsEntryService` yet. Those
remain read-only from the accepted OS-entry batch; the adapter is a separate
grant. This document is what that adapter will be written against.

## Why a mode and not a frame

The mode is chosen by one fixed argv literal, `--source-mode`, so the two
protocols are not reachable from one another. A helper started for reading
cannot be talked into writing by anything arriving on stdin, because the receive
dispatcher is never constructed. The literal carries no value — a
`--source-mode=<x>` form would put caller data in argv, where every process on
the machine can read it.

With no argument the program serves one receive lease, byte-for-byte as before.

## Protocol

Framing, frame kinds and the chunk header are `internal/wire`, unmodified. The
request grammar is `internal/sourceserve`, which is separate from the receive
grammar: adding these operations to the accepted validator would have widened it
for every receive lease that will never use them.

```
open-source   { id, path }                     -> { source, size, volumeSerial, fileId }
read-source   { id, source, offset, length }   -> [chunk frame] + { bytes, eof }
close-source  { id, source }                   -> { state: "closed" | "failed-close" }
```

One `source-ready` event (`protocol: 1`) precedes everything.

| bound | value | pinned against |
|---|---|---|
| read length | 192 KiB | `MAX_SELECTION_CHUNK`, `CHUNK_SIZE` |
| open sources | 8 | — |
| request frame | 64 KiB | — |
| path field | 32767 × 3 bytes | Windows path ceiling |

A read emits the chunk **before** its response, so the host can attribute bytes
to a request before that request settles. An empty read emits no chunk at all.
`eof` is what the read observed; it is never inferred from the size recorded at
open time, because the file may have been truncated or extended since.

### Identity is exact, nonzero, and never a number

`volumeSerial` is 16 hex characters and `fileId` is 32. Both are STRINGS in every
direction. They are 64- and 128-bit values, and the host is JavaScript, where a
JSON number above 2^53 is silently rounded — two different files would then
present the same identity.

`FILE_ID_INFO` that is unavailable or zero is `E_IDENTITY_UNAVAILABLE` and the
open is **refused**. This is deliberately stricter than the Node fallback, which
compares device and inode only when nonzero: that tolerance is right for a path
that claims nothing, and wrong for one whose whole purpose is to bind bytes to an
object.

**Known refusal:** a volume that does not report `FILE_ID_INFO` cannot be read in
source mode at all. That is a refusal the user sees, not a wrong answer, and
relaxing it would be a decision about the guarantee rather than an implementation
detail.

### What binds the bytes

The parent-handle walk excludes ancestor redirection. It does **not** by itself
bind the leaf across a reopen — a file replaced between two opens is a different
object under the same name. Two mechanisms, in order:

1. The helper holds the handle from `open-source` through every `read-source` to
   `close-source`. While it is held, the handle binds the bytes.
2. A caller that must reopen — an eviction under a handle cap — passes the
   identity captured at staging to `open(path, expected)`. A mismatch is
   **terminal for that entry**: refused, not retried, because a retry loops on
   whatever now occupies the name.

## The walk, and how it differs from receive

| | receive (`nt_windows.go`, unmodified) | source (`source_windows.go`) |
|---|---|---|
| root | `openRoot` FOLLOWS a junction, on purpose: the user picked that folder in a dialog | every component walked, **including the user-selected one**; no exception |
| disposition | `FILE_CREATE`, fallback `FILE_OPEN` | `FILE_OPEN` only; nothing can be created |
| access | `dirTraverseAccess｜DELETE` on created directories | `FILE_TRAVERSE｜FILE_READ_ATTRIBUTES`; leaf `FILE_READ_DATA`. No write bit, no `DELETE` |
| share | omits `FILE_SHARE_DELETE` | same omission — the one rule reused, as a pattern |
| ancestors | closed after use | **retained** for the source's lifetime |

Refused before any syscall, on the string alone: UNC, `\\?\`, `\\.\`, forward
slashes, `.`/`..`, empty or doubled components, alternate data streams, trailing
dot or space, wildcards, control characters, and a bare volume root. Refused
after: a non-fixed/removable drive, any reparse point, a volume-serial change
mid-walk, a directory, a non-`FILE_TYPE_DISK` object, and a delete-pending file.

**Not guaranteed:** the file's CONTENT does not stop changing. Share mode permits
other writers, because denying them would refuse every file another application
happens to have open. Identity binds *which object* is read, not that the object
stood still. Deleting or renaming it, however, is blocked while a handle is held.

## Host API

```ts
const provider = createNativeSourceProvider();     // null OFF Windows only
const handle = await provider.open(absolutePath, expectedIdentity?);
const { bytes, eof } = await handle.read(offset, length);   // length <= 192 KiB
await handle.close();                                       // "closed" | "failed-close"
const { leftover } = await provider.dispose();
```

On Windows the factory **never** returns `null`, even when the helper is missing:
that provider rejects every open. A `null` there would read as "use the other
path", and no other path can make this claim. Off Windows `null` means no native
guarantee exists on this platform at all, and the Node path stays as a disclosed
development and test path that reports no identity.

`leftover` counts handles this process did not get back — a failed close, or one
abandoned during teardown. The exit code says the same thing: `3` means handles
were left held, `2` a protocol violation, `5` a forced shutdown.

### Integration notes for the adapter

* Open at **staging** time, not at first read, so the identity that binds is the
  one captured when the user chose the file.
* Keep `provider.dispose()` on the same teardown path that already kills the
  helper; `leftover` is the number to report, not to assume away.
* A `SourceBindingError` is terminal for its entry. Do not retry it.
* A source path is main-held and appears in exactly one place: the `open-source`
  frame. Not in argv, not in an environment variable, not in any error, and never
  in a renderer message.

## Tests

Cross-platform, run everywhere (`go test ./internal/sourceserve/`,
`vitest test/unit/native-source*.test.ts`): the grammar, hostile frames, dispatch,
the handle table and its bounds, the ownership inventory, the shutdown bound, the
identity rules, fail-closed behaviour, and the framing — pinned against fixtures
captured from the Go encoder rather than against the TypeScript encoder itself.

Windows-only (`go test ./internal/winio/`): exact bytes from a real file, an
ancestor junction refused with the same file by its real path as the negative
control, the selected root junction refused where `openRoot` follows it, a
missing path creating nothing, hard-link identity, ancestor pinning proven by a
rename that fails and then succeeds after close, and the EOF/close lifecycle.
Mount-point crossing needs a second volume and skips honestly without one.

These have been cross-compiled and linked for `windows/amd64`, which proves they
build. It proves nothing about their behaviour: no claim about the walk holds
until they run on Windows.
