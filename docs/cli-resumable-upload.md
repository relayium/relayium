# CLI installation identity and resumable uploads

These options were first published in CLI v0.27.2. An older installed CLI does
not gain them from a source checkout or a newer server; run `relayium update`
(or reinstall) to get them, and `relayium version` to check which build you run.

## Installation identity

A capable CLI retains a random per-server identity under the configuration
directory's `cli-installations` directory, including after logout. The identity
is a lookup hint, never a credential. An approved login for the same account and
identity reuses its device row and rotates its bearer token atomically.

Copying or restoring this directory also copies that identity. Two machines
using the same copy represent one installation: approving a new login revokes
the other copy's old bearer. Use a separate `--config-dir` for an independent
installation. Relayium does not add a machine fingerprint to detect copies.
Malformed or unsafe identity files stop login without replacing them. Inspect
permissions and restore a trusted backup, or select a new configuration
directory; do not delete identity files while another login is running.

Deploy the new account server before distributing capable CLI clients. During a
mixed-server rollout, start and approve device authorization on the same server
version: an old server interprets any nonempty stored installation hint as an
app hint, including the new `cli.` namespace. Before rollback, stop admitting new
CLI device authorizations and let pending requests expire for their full
10-minute TTL. An approval already handled by an old server may leave a CLI row
classified as an app; do not rewrite device rows or credentials automatically.

## Resuming the same upload

`relayium up <path...> --resumable` creates one private encrypted local copy and
an operation record containing its recovery key before sending file data.
`relayium up --resume <operation>` validates that copy, account and server, then
continues the same named session with the same ciphertext. A missing session
does not start a replacement upload. A lost finalize answer can be recovered
without another PATCH. Unknown outcomes require checking the account file list
before sending again; local recovery material is kept.

The mode is opt-in: choose `--resumable` before the upload starts, because a
default upload stopped part-way cannot resume its bytes. The local copy needs
disk space for the complete encrypted transfer, and `--resume` never rereads or
re-encrypts the source files. Interrupted requests can already have consumed
traffic, so there is no zero-replay guarantee. Recovery stays with that
configuration directory, account and server: it does not move an upload to
another device, and it does not change how native apps or the browser recover
uploads.

`relayium up --discard <operation>` removes only local recovery
material. It does not cancel server cleanup, undo accepted traffic, or promise a
refund. A process crash between publishing the encrypted copy and saving its
record can leave an unlisted `.cipher` file without a saved key; no upload has
started at that point. There is no automatic orphan scanner: concurrent spool
creation must not be mistaken for an orphan and deleted.
