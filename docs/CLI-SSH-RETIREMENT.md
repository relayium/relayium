# Temporary retirement of CLI SSH transfers

Status: disabled in source on 2026-09-24, and first published in CLI v0.27.0
(tagged 2026-10-02). Already published binaries — v0.26.0 and earlier — are
unchanged and still carry SSH transfers.

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

Planned before the release, and done in source before v0.27.0 was tagged: the
English and Simplified Chinese CLI page, comparison tables, flags and guide
navigation describe the CLI without SSH; current tutorials carry no SSH
commands; and historical SSH tutorials (including archived translations) are
labelled as retired, with a pointer to the supported direct transfer. The
repository's README and `llms.txt` were corrected to name v0.27.0 as the
published release after it was published. After publication, the repository's
`install.sh` and `relayium update` were verified to install v0.27.0.

Relevant sources: `web/src/lib/cli-page-data.ts`, `CliPage.svelte`, maintained
locale strings, `web/scripts/pages/content/articles/cli-backup-server-ssh.mjs`
and other CLI/sync/backup articles, README and `llms.txt`.
`scripts/test/cli-public-truth-test.sh` keeps the generated pages free of SSH
commands. The website relayium.com serves changes only when it is next
deployed; this document does not record that deployment. Neither the CLI
release nor this note changes the reopening decision above, and neither
involves a fleet change.
