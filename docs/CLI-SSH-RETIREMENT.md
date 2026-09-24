# Temporary retirement of CLI SSH transfers

Status: disabled in source, 2026-09-24. This does not modify already published
binaries or authorize a new release.

The CLI rejects SSH targets for `push` and `sync`, the `pull` command, and the
former `__recv` / `__send` remote helpers with exit code 2 and a migration hint.
Rejection occurs before source-file access, stdin consumption, destination
creation or an SSH connection. `sync --watch` also returns immediately.
There is no supported configuration flag to re-enable SSH transfers.

Use `relayium serve --dir <existing-directory>` on the receiver and
`relayium push <files> relayium://host` or `relayium sync <sources>
relayium://host` on the sender. Existing fingerprint approval and pinning still
apply. To reverse direction, reverse the sender and listener roles; there is no
daemon `pull` command. Pairing, cloud download links and Device Inbox remain
separate supported transfer paths. Daemon stdin uploads remain supported.

## Reopening

This is a temporary product scope decision, not an irreversible protocol removal.
Remote-to-remote SSH transfer design is closed for now. Reopening requires an
explicit product decision; elapsed time or dormant code is not a trigger.

The last pre-retirement implementation and SSH acceptance cases are available at
Git commit `d0c41408716d26719a05bb7dbe518792ab1f2182`. Some dormant engines and
shared test fixtures remain in source. Their unit tests are not evidence that
SSH is available through the CLI.

Before reopening, recheck host identity verification, two-end credential
isolation (for remote-to-remote), data routing, exact destination ownership,
source/receiver failure, cancellation and process cleanup. Restore and run the
real private-sshd tests, old-peer matrix and Windows transport checks against the
new candidate; do not simply delete the retirement guard. Reconcile help,
installation guides and the feature's billing/privacy claims at the same time.

## Release coordination

The public website currently documents the published CLI. Before a release that
contains this change, update the English and Simplified Chinese CLI page,
comparison tables, flags and guide navigation; remove SSH command examples from
current tutorials, and label historical SSH tutorials (including archived
translations) with their version scope and a link to the supported direct
transfer guide. Update generated pages and crawler metadata together.

Relevant sources: `web/src/lib/cli-page-data.ts`, `CliPage.svelte`, maintained
locale strings, `web/scripts/pages/content/articles/cli-backup-server-ssh.mjs`
and other CLI/sync/backup articles, README and `llms.txt`. Verify the installer
resolves the release containing this change before claiming the retirement is
live. No public release, website deployment or fleet change is part of this
source-only delivery.
