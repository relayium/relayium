# The update custody helper

`relayium-update-helper.exe` is the third native binary, alongside the receive
helper and the secret helper. It owns everything the update core does to disk on
Windows: creating, writing, publishing, deleting, reading and verifying staged
files.

It is a separate binary and a separate protocol on purpose. The receive and
secret protocols are mature and index-based; widening either to carry update
operations would put churn into code that has stopped changing.

## Why it exists

Node cannot express the invariants this needs. There is no handle-relative
create, no reparse-refusing open, no delete-by-handle and no handle-relative
rename. Every one of those is the difference between "operate on the object I
hold" and "operate on whatever answers to this name right now", and the second
is how update code deletes files it never created.

So on Windows the update core FAILS CLOSED without this helper — no staging
directory, no journal, no download — rather than falling back to path calls that
look equivalent and are not.

## The invariants

* **The chain is walked, not resolved.** Traversal starts at the physical volume
  root and opens one component at a time, handle-relative
  (`OBJECT_ATTRIBUTES.RootDirectory`), with `FILE_OPEN_REPARSE_POINT` and an
  explicit reparse refusal at every level. A junction anywhere in the supplied
  path — including above the app root — is refused. Resolving the path first
  would follow those junctions and leave nothing to refuse.
* **A mapped drive letter is refused.** `QueryDosDeviceW` on the letter AS
  SUPPLIED must answer `\Device\…`. A `subst`ed letter answers `\??\C:\…` and is
  a directory wearing a drive letter: anchoring on it pins nothing above the
  directory it points at, while the launch path resolves through exactly those
  ancestors.
* **Ancestors are held, with least rights.** Every directory handle is kept for
  the session and opened WITHOUT `FILE_SHARE_DELETE`, which is what makes them
  un-renameable and un-deletable while held. They are opened with read, traverse
  and attributes only — a per-user update has no business holding create rights
  on `C:\` or `C:\Users`. Only the app root may create a subdirectory, and only
  the staging directory may create files.
* **Ownership is an object, not a name.** Every create returns a receipt —
  `FILE_ID_INFO`, a volume serial plus a 128-bit file id. Deleting, publishing,
  hashing and verifying all re-read that identity through the handle and refuse a
  mismatch. A record that names a slot proves nothing about what is in it.
* **Publication renames the handle that wrote the bytes**
  (`FileRenameInfo`, `RootDirectory` = the staging handle), so the object
  published is provably the object written. `FILE_RENAME_REPLACE_IF_EXISTS` is
  set here — unlike the receive sink, where overwriting is the outcome to
  prevent — because atomically replacing the previous record is the journal's
  entire purpose.
* **`gone` is confirmed.** A deletion by handle is not an absence: without POSIX
  semantics it stays pending while any handle is open, including another
  process's. The handle is closed and the name re-checked, and anything still
  there is reported as residue the host keeps owning.
* **Trust is `WinVerifyTrust` returning 0**, on a file held with write and delete
  denied and `FILE_SHARE_READ` only — the loader must be able to map the image,
  nothing may modify it. The publisher is the X.500 subject of the certificate
  that was actually validated (`WTHelperGetProvSignerFromChain`), compared
  exactly. Never the first subject in the file's certificate collection, and
  never a display name.
* **The subject has ONE canonical encoding: the .NET one.** `CertGetNameString`
  is called with `CERT_NAME_RDN_TYPE`, `CERT_X500_NAME_STR` **and**
  `CERT_NAME_STR_REVERSE_FLAG`. The reverse flag is not the default —
  `CertNameToStr` renders RDNs forward without it — while
  `X500DistinguishedName.Name`, and therefore
  `(Get-AuthenticodeSignature x).SignerCertificate.Subject`, decodes them
  reversed. Since that PowerShell value is what anyone configuring
  `expectedPublisher` will paste, the helper renders the same order. Without the
  flag a multi-RDN publisher would be refused despite a perfectly valid
  signature. `TestTheSubjectEncodingIsPinnedNotIncidental` asserts both
  directions: the canonical order verifies and the reversed order is refused as
  a publisher mismatch.
* **`unavailable` is not `unsigned`.** A check that could not run is a different
  answer from a check that found nothing, and both are refusals.
* **No pin, no install.** An empty publisher is `no-expected-publisher`. Consent
  must be exactly `granted`; anything else refuses.

## The protocol

Length-prefixed frames on stdin/stdout: four bytes big-endian, one kind byte,
then the payload. `J` carries a JSON control message (16 KiB max); `B` carries
bytes — a write payload (1 MiB max) or a journal record (512 KiB max, matching
the core's `MAX_JOURNAL_BYTES`, because a record of legitimate size does not fit
in a control frame and JSON escaping would only expand it).

One request at a time, no read-ahead, replies in order. `custody.write` and
`scope.read` are the two-frame operations: a control frame announcing `bytes`,
then exactly that many. A client that pipelines simply blocks on the pipe.

`scope.open` may be sent once. It is the only request carrying a directory, and
the helper TRUSTS the one it is given — it cannot know where the app's data
lives. A compromised main process can therefore point it elsewhere, and nothing
here prevents that; the guarantee is that no LATER request can name a path at
all, only a component inside the held scope or a handle the helper issued.

Errors are a closed set of codes. No path, no digest, no publisher, no OS error
text: stderr carries nothing at all.

## What it does not do

It accepts no command-line arguments, opens no port, reads no environment
variable, and writes no log. `install.verify` performs the entire verification
and returns without creating a process; only `install.run` launches, and only
with an exact consent token, a pinned publisher, a matching receipt, size and
digest.

## Testing

`serve_test.go` and `path_test.go` run anywhere and cover the protocol, the
bounds, the handle lifetime and the path splitting. `layout_windows_test.go`
asserts the SDK structure offsets at compile time. `acceptance_windows_test.go`
is the part only Windows can answer: junctions at staging, at the leaf and at an
intermediate ancestor; `subst` refused and the physical path accepted; a
non-writable ancestor still traversable; rename and delete refused on held
ancestors including a parent of the app root; a swapped file refused; a pending
deletion not reported as gone; commit-then-discard using the published name; a
real journal round-trip at the core's budget; and the trust matrix, whose signed
positive uses the runner's own signed binary copied into owned staging. No
certificate, key or trust setting is created or modified anywhere.
