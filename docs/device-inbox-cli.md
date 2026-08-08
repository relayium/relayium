# `relayium inbox` — the CLI Device Inbox receiver

Status: **Phase 1C.** The receiving half is implemented and covered by tests. The
*sending* half is not: there is no Web "My Devices" drag-and-drop target yet
(Phase 1D), so today a task has to be queued through the API. This document
describes what exists, and says so where something does not.

Product source of truth: `DEVICE-INBOX-PRD.md` §7.1, §8, §9, §10.
Wire protocol: [`protocol/relayium-device-inbox-v1.md`](protocol/relayium-device-inbox-v1.md).
Implementation: `server/internal/inboxclient/`, `server/cmd/relayium/inbox.go`.

## What it does

A machine you have logged into with `relayium login` becomes a device in your
account. Once you explicitly enable its inbox and choose a directory, files sent
from your own account are downloaded, decrypted, verified and saved there
automatically — including files sent while the machine was offline, which queue
and land when it comes back.

Relayium never sees the plaintext, the file names, the directory structure, the
content key or this device's private key. The content key is sealed to a public
key this machine published; only this machine holds the other half.

## The commands

```text
relayium inbox enable --dir <folder>   turn on automatic receive into <folder>
relayium inbox run                     run the receiver in the foreground
relayium inbox status                  show local, credential and server state
relayium inbox pause                   stop receiving (keeps the enrolment and keys)
relayium inbox resume                  start receiving again
relayium inbox disable                 clear the server inbox, then delete local keys
relayium inbox service <kind>          print a service definition for this machine
```

All of them accept `--config-dir D` (default `~/.config/relayium`, or
`$XDG_CONFIG_HOME/relayium`).

If you use a non-default directory, log in to that same credential directory
first: `relayium login --config-dir D`. The system-service instructions print
both commands with one directory so the worker cannot start with missing
credentials.

### `enable --dir <folder>`

The opt-in. Automatic receive is **off** until you run this, and there is no way
for a sender, a share link or a task to turn it on — it is a decision made at
this machine.

It checks the directory is real and writable (by creating and removing a probe
file, not by reading permission bits), enrols the device with its protocol
version and capabilities, generates an X25519 key pair, **writes the private key
to disk before publishing the public half**, and records the configuration.

It never acquires privileges. Run as root it warns that received files will be
owned by root and points at the dedicated-account service instead.

### `run`

The resident worker, and the process a service supervises. It:

- heartbeats at the interval central advertises (30 s), reporting whether the
  receive directory is usable *right now*;
- polls for work on a jittered backoff (3 s → 60 s), so an idle fleet is cheap
  and a restarted fleet does not synchronise;
- claims exactly one task at a time and does not lease the next task until it can
  start it;
- renews its lease with progress reports well before the five-minute deadline;
- resumes an interrupted ciphertext stream from the last complete frame with a
  `Range` request;
- exits 0 on `SIGINT`/`SIGTERM`, reporting itself offline so senders are not left
  waiting out the presence TTL.

`--once` drains the queue and exits, for a cron-style single pass or a smoke test.

Only one worker may run per configuration directory; the second exits with an
error. The exclusion is an advisory file lock, so it is released by the kernel if
a worker is killed.

### `status`

What is actually true, in four layers: local configuration and directory, the
credential, whether a worker holds the lock, and what central says (presence,
policy, protocol, whether the published key's private half is held here).

After fixing a blocker that needs a person—such as a destination-name race—run
`relayium inbox resume`. Besides clearing a pause, it explicitly re-queues this
device's locally blocked tasks. It never accepts a task waiting under the `ask`
policy.

It prints no key material and no token — a generation number is what you can act
on; a public key is not.

### `pause` / `resume`

Durable local scheduling state. Paused, the worker stops claiming **and** stops
heartbeating, so senders see the device as offline and their files queue rather
than appearing about to land. Nothing on the server changes, no key is touched
and no queued task is lost, so resuming costs nothing. A running worker picks the
change up within a few seconds — no restart needed.

This is deliberately not `disable`.

### `disable`

The teardown, in a fixed order:

1. Turn off automatic receive locally. Non-destructive, cannot fail, so it
   happens first — a running worker stops.
2. Clear the enrolment on the server, which removes the published keys and
   terminalises any queued task as `revoked`, so the sender is told the truth
   instead of watching a delivery that will never happen.
3. **Only then** delete the local private keys and task receipts.

If step 2 fails, the private keys are **kept** and the command exits non-zero
saying so. Deleting them first would destroy the only thing that can decrypt
tasks still sitting in the queue — a reversible "turn it off" becoming permanent
data loss.

`--local-only` skips steps 2 and 3 entirely and says exactly what it did not do.

`disable` is not `logout`: the account credential is untouched.

## Where files go, and what is never done to them

- Received files land in the directory chosen with `--dir`, using the names in
  the sender's manifest.
- **An existing file is never overwritten, merged, deleted, opened, executed or
  extracted.** A name that is already taken gets a deterministic safe rename:
  `report.pdf` → `report (2).pdf` → `report (3).pdf`, with the extension
  preserved (including `.tar.gz`).
- Absolute paths, `..`, backslash separators, control bytes, empty or dot
  components, names ending in a dot or space, Windows reserved device names, and
  two entries differing only by case are all refused. The manifest authenticates,
  which proves who wrote it — not that its names are safe to act on.
- A symlink, socket, FIFO or device node occupying a destination name counts as
  occupied: the delivery is renamed around it, never written through it. A
  symlinked or non-directory component in a destination *path* stops the
  delivery.
- Received files are `0600` and directories `0700`, set explicitly rather than
  inherited from the umask, so the result does not depend on how the service was
  launched. **No executable bit is ever set.**
- Free space is checked before anything is downloaded, and a manifest declaring
  more plaintext than its ciphertext could possibly contain is refused.

### How a crash cannot duplicate or lie

Each task gets a private staging directory *inside* the receive directory
(`.relayium-incoming/<task>`), so the final commit is a same-filesystem operation.
Nothing is placed outside staging until the entire authenticated stream has been
consumed and its total length checked.

The commit uses `link(2)`, not `rename(2)`. `rename` replaces its destination
silently, so every "check then rename" has a window in which a file created
meanwhile is destroyed with no error. `link` fails if the name is taken by
anything at all, and the kernel makes the test and the creation one operation.

A durable journal records the plan before the first destination exists, and each
placement before its staged source is removed. That gives every crash boundary an
answer:

| Crash after | On restart |
|---|---|
| the plan is journalled | staging is discarded and the task re-downloads into the same plan |
| a file is linked, before it is journalled | the staged source still exists and shares an inode with the destination, which proves the link was ours — the journal catches up |
| a file is journalled, before the source is unlinked | the entry is skipped and the stale source is cleaned |
| the whole commit, before `saved` was reported | the task is re-claimed, the receipt is recognised, `saved` is re-reported **without re-downloading or re-committing** |

If a destination exists and is *not* our staged inode, the task stops as
`attention_required`/`name_conflict`. Nothing is overwritten and nothing is
guessed at.

### What failures mean

A device reports a code from a closed set — there is no free-text field, so a
file name cannot reach central even when explaining exactly why saving failed.

| Situation | Reported | Why |
|---|---|---|
| a frame fails authentication, or the sealed key does not open | `failed_terminal` / `decrypt_failed` | the ciphertext will not change; retrying eight times cannot help |
| the stream ends early or over-runs | `failed_retryable` / `verify_failed` | that is what a truncated *transfer* looks like |
| a hostile or invalid manifest | `failed_terminal` / `verify_failed` | the same bytes will be refused the same way |
| out of space | `attention_required` / `disk_full` | only a person can free space |
| the directory is unwritable or gone | `attention_required` / `permission_denied`, `directory_unavailable` | likewise |
| a destination was taken after the plan | `attention_required` / `name_conflict` | a person should look |
| network or storage failure fetching ciphertext | `failed_retryable` / `download_failed` | transient by nature |

When a local blocker clears — space returns, the directory comes back — the
worker re-queues the tasks *it* parked for that reason, and only those. A task
held because the policy is `ask` is waiting for a person and is never
auto-accepted.

## Running it as a service

`relayium inbox run` is a plain foreground process. It never forks, writes no pid
file, logs to stdout/stderr, and exits 0 on `SIGTERM` — which is what systemd,
launchd and a container entrypoint all want.

`relayium inbox service <kind>` prints a definition **for this machine**: the
running executable's real path, this config directory, this receive directory. It
prints install instructions to stderr and the definition to stdout, so
`relayium inbox service systemd-user > relayium-inbox.service` does the right
thing.

| Kind | What you get |
|---|---|
| `systemd-user` | a user unit; `systemctl --user enable --now`, plus `loginctl enable-linger` so it survives logout |
| `systemd-system` | a system unit running as a dedicated unprivileged account |
| `launchd` | a per-user LaunchAgent (not a root LaunchDaemon) |
| `container` | notes for using `inbox run` as an entrypoint |

The system-wide install requires root — creating the account, writing to
`/etc/systemd/system`, reloading systemd. **The CLI does not do any of it.** It
prints the exact `sudo` commands for a human to run, including enrolling *as the
service account* so the credential and the private key belong to the user that
will run the worker.

There is **no official Relayium container image**. An image is a supply-chain
artifact needing its own signing, SBOM and provenance; publishing an unsigned one
would be worse than publishing none. Phase 4 owns it.

## What is deliberately not here yet

- **No Web sender.** Phase 1D adds the My Devices presence display and the
  click/drop encrypted send. Until then a task must be queued through
  `POST /api/devices/{id}/inbox/tasks`.
- **No `ask` policy in the CLI.** `enable` announces `auto`. There is no
  interactive per-task prompt, so a device that would need one is not offered.
- **Cross-restart resume is per task, not per byte.** An interrupted download
  resumes from the last complete frame *within a run*; a restarted process
  re-downloads the unfinished task from the start. It never re-commits, and never
  duplicates.
- **A separate filesystem mounted inside the receive directory** is refused with
  `directory_unavailable` rather than degrading the atomic commit to a copy.
