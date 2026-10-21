# Mac stored-link upload recovery

Source implementation, 2026-10-21. An existing released 1.4.10 binary does not
contain this feature. Distributing this implementation requires a separately
qualified app release; source delivery is not an app release.

The Mac app owns recovery for ordinary **Share a link** uploads, separately from
Device Inbox. It observes the signed-in account for the whole app lifetime,
including when its windows are closed. Restarting offers **Resume upload** and
**Discard saved copy**; it never starts network work automatically.

Before opening a server session, the app stages the selection into a private
Application Support job, saves its content key in Keychain, seals the entire
ciphertext stream, and commits the encrypted manifest, stream length, SHA-256
and key-authenticated spool identity. It never sends until both key and spool
exist. After that commit it removes the
plaintext staging copies. Preparation requires temporary disk space for both
copies. It uses bounded buffers; a file is never loaded whole to prepare it.

Recovery replays the saved ciphertext. Moving, changing or deleting the original
files does not require a new sandbox bookmark and cannot cause a frame nonce to
seal changed plaintext. A modified spool or wrong key is refused before network
work. `PendingUploads.StoredShareSpools` is a sibling of the old pending root,
so an older binary cannot sweep it or re-encode away its session phases.

The app records the server session and negotiated chunk cap before sending
bytes, and records `finalizing` before each completion request. A lost completion
response is checked using `recoverFinalized: true` for the same session. A
missing recorded uploading session is retained and refused rather than silently
opening another upload. Old-server conflicts and uncertain results keep the
recovery data. Expired or removed completed objects cannot be recovered; a new
send requires the user's choice and counts as a new upload.

The reviewed server retains a Share finalize-recovery record for about one hour
of idleness (`pendingUploadTTL = 3600`); recovery reads do not extend that window.
The encrypted object can outlive its recovery record. A later 404 therefore
cannot prove that the object was never created or metered, and does not permit
an automatic replacement upload.

New uploads retain negotiated ordered two-request pipelining. Restarted sessions
use the durable offset and recorded cap through the serial recovery pump.
Uploading requires a running app; this feature adds no closed-app background
upload service.

Cancel pauses an adopted job. Account departure immediately hides the outgoing
job and cancels its attempt while retaining account-bound ciphertext and its
pending key. Signing back into that account offers explicit recovery; a different
account cannot see or resume it. Only a confirmed Discard removes local pending data and its pending key. The
confirmation explains that losing the only recovery key can permanently lose
access to an already-completed upload, and does not delete the server object
or refund usage. Cancelling the dialog preserves recovery without any request.
The confirmation is bound to one model, account, job and operation generation;
a resume or account change invalidates an earlier confirmation. A final
link already on screen survives an account change. After success, the pending
key is removed only after the final link key is proven saved; a locked Keychain
keeps a finalized salvage record for a later local retry. Disk cleanup failures
are shown as warnings.

Validation includes exact ciphertext/decryption tests, all-empty uploads,
account transitions, missing sessions, finalize-state persistence failure,
old-server refusal, final-key salvage, bounded two-request overlap, and private
SIGKILL/fresh-process tests against the actual HTTP handlers with file-backed
SQLite and DiskStore. Source-bound receipts are kept in the workspace task
artifacts; they are not published with the repositories.

These tests cover app/process termination, not system power loss. Phase records
use Foundation atomic writes; full disk and directory flush durability after a
power failure has not been established. A force quit during preparation can
also leave private plaintext staging in a directory without a readable plan;
the conservative recovery sweep retains unexplained directories. Confirmed Discard of a finalizing job removes local recovery inputs even if a
server completion cannot yet be confirmed. This requires the explicit warning
and confirmation above; it is not a server cancellation or refund.

If a recovery-state write fails before a completion request, the app states
that this request was not sent, without claiming an earlier request could not
have completed. Resume checks the same upload rather than opening another.
