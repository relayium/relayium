# Mac stored-link upload recovery

Source implementation candidate, 2026-10-20. This document does not claim that
an existing released 1.4.10 binary contains this feature. Independent financial
reviews and Git delivery remain required before shipping this change.

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

New uploads retain negotiated ordered two-request pipelining. Restarted sessions
use the durable offset and recorded cap through the serial recovery pump.
Uploading requires a running app; this feature adds no closed-app background
upload service.

Cancel pauses an adopted job. Account departure immediately hides the outgoing
job and cancels its attempt while retaining account-bound ciphertext and its
pending key. Signing back into that account offers explicit recovery; a different
account cannot see or resume it. Only an explicit Discard removes local pending
data and its pending key; it never deletes a published object. A final
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
