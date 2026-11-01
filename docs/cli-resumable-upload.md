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

A recoverable `relayium up` creates one private encrypted local copy and an
operation record containing its recovery key before sending file data.
`relayium up --resume <operation>` validates that copy, account and server, then
continues the same named session with the same ciphertext. A missing session
does not start a replacement upload. A lost finalize answer can be recovered
without another PATCH. Unknown outcomes require checking the account file list
before sending again; local recovery material is kept.

In CLI v0.27.4, a complete encrypted request body larger than 1 MiB selects this
mode automatically, before any upload request. Smaller uploads require
`--resumable`, as did every upload on CLI v0.27.2 and v0.27.3. Earlier versions
must be upgraded first. A single-request upload stopped part-way cannot resume
its bytes. The local copy needs disk space for the complete encrypted transfer,
and `--resume` never rereads or
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

## 简体中文摘要

CLI v0.27.4 会为加密请求体超过 1 MiB 的上传自动启用分片续传；较小的上传仍可用
`--resumable` 显式启用。CLI v0.27.2 和 v0.27.3 需要显式添加参数；更早版本须先升级。
此模式会先创建完整的私有密文副本，因此需要足够的本地磁盘空间。中断后使用
`relayium up --resume <操作 ID>` 继续同一会话，不重新读取或加密原文件。
恢复仍绑定同一配置目录、账号和服务器；中断请求可能已消耗流量，不保证零重传。
`--discard` 只删除本地恢复材料，不取消远端对象，也不退还已消耗的流量。
