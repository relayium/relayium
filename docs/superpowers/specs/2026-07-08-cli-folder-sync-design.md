# Relayium CLI — `sync`: incremental folder sync (Spec)

Date: 2026-07-08
Status: Design approved, pending implementation plan

## 1. Motivation

The CLI can push a folder (`relayium push ./dir dest`), but each push re-sends
every file in full and overwrites the receiver by path — no delta, no delete of
files removed on the source, no continuous mode. For the natural
server-to-server use case (keep a folder mirrored on another machine you
control, on a cron or in real time), that is wasteful and incomplete.

`relayium sync` adds a one-way incremental mirror that reuses the existing
transport (SSH and daemon-direct) and transfer engine:

1. **Incremental** — only new/changed files are transferred (skip unchanged).
2. **`--delete`** — mirror: remove receiver files no longer on the source.
3. **`--watch`** — stay resident and re-sync on change (real time).

Combined with the daemon-direct approve-once trust, this becomes "set up trust
once, then automatically, incrementally mirror a folder between your servers" —
encrypted, integrity-checked, no third party.

## 2. Goals / Non-goals

**Goals**

- `relayium sync <src...> <dest>` — one-way incremental sync. `dest` is
  `[user@]host:path` (SSH) or `relayium://host[:port]` (daemon), exactly like
  `push`.
- Skip unchanged files by **size + modification time** (rsync's default quick
  check). Preserve mtime on the receiver so subsequent syncs match.
- `--delete` — remove files under the destination directory that are not in the
  source manifest (a true mirror).
- `--watch` — resident mode: watch the source tree with fsnotify and re-run an
  incremental sync (debounced) on any change.
- **Backward compatible**: the protocol change is additive; `push`/`pull` keep
  working, and a new client talking to an old peer (or vice versa) degrades to a
  full transfer rather than breaking.

**Non-goals (this spec)**

- Bidirectional / two-way merge and conflict resolution. `sync` is one-way
  (source → destination), like `rsync src dest`.
- Content-hash comparison (`--checksum`). Size+mtime is the v1 quick check;
  a `--checksum` flag is a future addition (it needs per-file hashes in the
  manifest).
- Block-level / rolling-hash delta *within* a file (rsync's algorithm). A
  changed file is re-sent in full (resume still applies to interrupted transfers).
- A persistent watch connection. Each sync run opens a fresh connection (like a
  cron run); connection reuse is a later optimization.
- Preserving ownership/uid/gid, xattrs, symlinks (the engine already skips
  non-regular files).

## 3. Architecture

`sync` is `push` with an incremental, mirror-aware transfer mode. It touches:

| Location | Change |
|---|---|
| `cmd/relayium/sync.go` (new) | `relayium sync` dispatch: parse flags, build/reuse the transport (SSH via `sshx`, daemon via the `relayium://` dialer), run `xfer.Send` in sync mode; `--watch` loop |
| `cmd/relayium/run.go` (mod) | dispatch `sync`; usage line |
| `cmd/relayium/serve.go` (mod) | `serve --allow-delete` flag; pass an "allow delete" capability into the receive |
| `internal/xfer/wire.go` (mod) | `Hello.Sync`, `Hello.Delete`; `ResumeState.Skip []int` (additive JSON fields; WireVersion unchanged) |
| `internal/xfer/send.go` (mod) | in sync mode: honor the receiver's `Skip` (don't send those); otherwise unchanged |
| `internal/xfer/recv.go` (mod) | in sync mode: compute `Skip` (size+mtime), preserve mtime on write, delete extras when permitted; otherwise exactly today's behavior |
| `internal/xfer/watch.go` (new) | fsnotify-based recursive watcher + debounce, yielding "sync now" ticks |
| `go.mod` | add `github.com/fsnotify/fsnotify` |

**Reuse.** The transport (SSH `sshx.Dial` / `RemoteHasRelayium`, and the
`relayium://` pinned-TLS dialer) and the `xfer` engine are reused verbatim;
`sync` only sets the sync/delete flags in `Hello` and loops for `--watch`.

## 4. Protocol (additive, WireVersion stays 1)

The wire protocol gains fields only; existing frames and their order are
unchanged, so old and new peers interoperate.

- `Hello` gains `Sync bool` and `Delete bool`. `push`/`pull` leave them false.
- `Manifest` is unchanged — it already carries `Size` and `ModTime` per file.
- `ResumeState` gains `Skip []int` — indices the receiver already has, identical
  by size+mtime, which the sender must not send.

**Sync-mode flow** (Hello.Sync = true):

```
sender  → Hello{Version:1, Mode:"push", Sync:true, Delete:d}
sender  → Manifest{Files:[{Path,Size,Mode,ModTime}...]}
receiver: for each file i:
            stat dest(i):
              absent                    → send full (offset 0)
              size==Size && mtime==ModTime → Skip += i
              0 < size < Size           → Resume{i, size}
              else (size differs)       → send full (offset 0)
receiver → ResumeState{Skip:[...], Entries:[...]}
sender  : for i not in Skip: FileStart{i, offset} → bytes → FileHash{i}
receiver: expect len(Files)-len(Skip) files; write each, chtimes to ModTime,
          verify SHA-256
receiver: if Delete && allowed: remove files under dest-dir not in manifest
receiver → Result{OK, Failed, (Deleted count in a log line)}
```

**Backward compatibility**

- New sender ↔ old receiver: old receiver ignores `Hello.Sync`, sends a plain
  `ResumeState` (no `Skip`); the sender sees no skips → sends everything (full
  transfer). Correct, just not incremental.
- Old sender ↔ new receiver: the receiver only computes `Skip` / changes its
  expected-file count when `Hello.Sync` is true. An old sender never sets it, so
  the receiver uses today's behavior. No desync.
- The receiver drives its receive-count from the same `Skip` set it reported, so
  sender and receiver always agree on which files flow.

## 5. Incremental (feature ①)

- **Skip test**: `onDisk.Size == entry.Size && onDisk.ModTime == entry.ModTime`
  (seconds). Only Stat is needed — unchanged files are never read.
- **mtime preservation**: after writing a file, the receiver calls
  `os.Chtimes(dest, ModTime, ModTime)` so the on-disk mtime equals the source's,
  making it skippable next time. (push/pull mode does not preserve mtime — only
  sync does, to avoid changing push behavior.)
- First sync: everything is new/mismatched → full transfer, mtimes set. Second
  sync of an unchanged tree: every file skipped, near-zero bytes.

## 6. `--delete` mirror (feature ②)

- The sender sets `Hello.Delete`. After receiving, a permitted receiver walks the
  destination directory and removes any regular file whose relative path is not
  in the manifest's path set (scoped by `safeJoin`, so nothing outside dest-dir
  is touched). Empty directories left behind are also pruned.
- **Safety gate (daemon)**: `relayium serve` honors delete only when started with
  `--allow-delete`. Without it, a delete-sync still transfers but does not delete,
  and serve logs a one-line warning. This stops an authorized-but-mistaken (or
  compromised) pusher from wiping the inbox.
- **SSH push/pull**: the receiver is `relayium __recv` spawned over the user's own
  SSH, so `--delete` is honored (you already own the remote). `sync` passes the
  delete intent through to `__recv`.

## 7. `--watch` (feature ③)

- `relayium sync --watch <src...> <dest>`: run one sync immediately, then watch
  the source tree with `fsnotify` and re-run an incremental sync on change.
- **Recursive**: fsnotify watches single directories, so the watcher adds a watch
  per directory under each source root and adds watches for newly-created
  subdirectories as they appear.
- **Debounce**: changes are coalesced over a short window (default ~800ms) so a
  burst of writes triggers one sync, not many.
- **Resilient**: a failed sync run (peer unreachable) is logged; watching
  continues and the next change (or a change after the peer returns) re-syncs.
- Each run opens a fresh transport connection. `Ctrl-C` stops.

## 8. Error handling

- **Delete requested but receiver disallows** — transfer proceeds, nothing is
  deleted, a warning is printed on both ends. Not a failure.
- **Old peer (no incremental)** — degrades to a full transfer silently (§4).
- **mtime chtimes fails** — logged, non-fatal; the file is still written and
  verified.
- **Integrity failure on a synced file** — reported in `Result.Failed` as today;
  the run exits non-zero.
- **watch: sync run fails** — logged; the watcher keeps running.
- **watch: fsnotify queue overflow / dropped events** — on overflow, fall back to
  a full re-sync (which is safe and, being incremental, cheap).

## 9. Testing

- `xfer` (unit, `net.Pipe` or temp dirs): unchanged file skipped; changed file
  (size or mtime differs) transferred; new file transferred; mtime preserved on
  write; `--delete` removes a receiver file absent from the manifest and prunes
  emptied dirs; a delete request without permission leaves files intact.
- Backward-compat: `Hello.Sync=false` → byte-for-byte old behavior; a receiver
  reporting no `Skip` makes the sender send everything.
- `serve --allow-delete` gating (delete honored only with the flag).
- `watch` (unit): the debounce coalesces a burst into one tick; a created
  subdirectory gets watched. (Full fsnotify E2E is covered by a focused
  integration test that writes a file and asserts a sync fires.)
- E2E (in-process, mirroring the daemon E2E): sync a dir; modify one file;
  re-sync transfers only that file (assert via a byte counter or received set);
  add an extra file on the receiver and sync `--delete` removes it.

## 10. Rollout

Ship as **v0.2.0** (new capability). The three features are independently
useful and land in order — ① incremental, ② `--delete`, ③ `--watch` — each with
its own tests, behind the single `sync` command. `push`/`pull`/`serve`/daemon
behavior is unchanged except for the additive protocol fields and the new
`serve --allow-delete` flag.
