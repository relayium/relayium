# Windows desktop client — parity with released macOS 1.3.10

**Full parity is not reached.** This file is the current inventory, not a
history. It describes the candidate as it stands; superseded narrative from the
foundation slice has been removed rather than annotated.

## Status vocabulary

* **`todo`** — not started.
* **`author-tested`** — implemented, covered by tests its author wrote. Not
  acceptance.
* **`reviewed`** — independently reviewed against frozen hashes on macOS.
* **`windows-observed`** — the behaviour has run on a real Windows runner.
* **`partial`** — a real slice exists and the remaining gap is named.

`windows-observed` is applied per row, from evidence. Several rows carry it;
several do not. There is no blanket.

## Where the code is

| | |
|---|---|
| Foundation | `b7d65457d` on `main` |
| Windows runs | 34448645493 (foundation), then candidates 34457162517, 34460496151, 34464477919, 34466025680, 34474334970 |
| In the candidate | Electron foundation, account authority, receive IO + native IO helper and client, installer and destination guard, realtime transport, DPAPI secret helper and `platformCipher` |
| Reviewed, not in a candidate | Resident surfaces (tray, first-close, login-item consent, notifications, deep-link routing, quit lifecycle) — frozen in an isolated tree, independently reviewed, not integrated |
| **In development**, not in a candidate | UI and Device Inbox, including the receiver. Actively being authored; **most of it is unreviewed**. Isolated build only. |

## Transport and protocol

| Capability | Status | Notes |
|---|---|---|
| Imported Web protocol modules | `reviewed`, `windows-observed` | Executed against the frozen cross-language fixtures in CI. |
| Realtime transport | `partial` | In the candidate. Peer checkpoints below. |
| Stored links (`#k=` upload/download) | `todo` | The key must never reach the server, nor a `relayium://` argv, nor Windows Error Reporting. |
| Device Inbox | `partial`, in development | Actively authored, largely unreviewed, isolated build only. |

### Against the real macOS 1.3.10 peer — ISOLATED UI BUILD, NOT THE CANDIDATE

These checkpoints were run from the **isolated UI build**. They say nothing
about the candidate, which has no transfer UI. Do not read a CP6 pass as a
shipping capability.

| Checkpoint | Result |
|---|---|
| CP3 — startup, both roles | **pass** |
| CP6 — **macOS creator** to Windows joiner, first send | **pass**, delivered exactly once |
| CP6 — disconnect | **pass** |
| CP8 — SAS confirmation, both ends | **pass** |
| CP8 — **Windows creator** to macOS joiner, first text | **pass**, delivered once |
| CP8 — 262 144-byte file | **pass**, SHA matches |
| CP8 — three-file Unicode folder | **pass**, SHA matches |
| History cap at 200 | **fixed** — the false send-failure is corrected and no longer reproduces |
| Windows as receiver | **pending** |
| TURN relay path | **pending** |

CP4 previously duplicated the first send; CP6 supersedes it. The
reverse-direction session that earlier hit the harness deadline is superseded by
CP8, which completed it. Windows-as-receiver and the TURN path remain unproven
and are listed as such — a pass in one direction is not evidence about the
other.

## Receive path

| Capability | Status | Notes |
|---|---|---|
| Manifest validation, Windows name safety | `author-tested` | Traversal, absolute, drive-relative, UNC/device, ADS, reserved names, trailing dot/space, control characters, over-length components. |
| Streaming receive, bounded, cancellable | `reviewed` | Staged under opaque names. |
| Native IO helper (`apps/windows/native`) | `partial`, `windows-observed` | `relayium-io-helper` — its Go suite passes and five TypeScript tests driving the real helper subprocess pass on Windows. Outstanding: full receive-path UI wiring is not integrated, and the experimental on-close behaviour is disabled. The unresolved tampered-blob case belongs to the SECRET helper, a different binary — see Secrets. |
| Publication with kernel-backed containment | `partial` | Handle-pinned no-replace publication is the helper's remit; staging is not containment. |

## Secrets

| Capability | Status | Notes |
|---|---|---|
| Encrypted at rest, fail closed | `partial` | **Direct user-scope DPAPI** via `relayium-secret-helper.exe`, which adds its own integrity record. Chromium `safeStorage` is **read-only** for `v10`/`v11` data and is never written again; a legacy blob is re-sealed in place on a successful read. No plaintext fallback. An unreadable secret is never reset. Stored under `%LOCALAPPDATA%`, never Roaming. |
| Durability across forced termination | `windows-observed` — **passes** | Both forced cells on run 34474334970: the kill was performed, and a fresh process read the value back. See below. |

**The failure this replaced.** On run 34466025680 two hard-kill cells ended with
the stored value unreadable: after a forced process termination Chromium's
`Local State` was absent, so the key that sealed the value never reached disk
while the ciphertext did.

**Fixed, and observed fixed.** On run 34474334970 both forced cells pass — the
kill is confirmed performed, and a fresh process reads the value back. `Local
State` is **still absent** in those cells, which is the point: the DPAPI helper's
key is the user's own, held by Windows, so it no longer depends on a Chromium
preference committed at a clean shutdown. The installed run agrees: a forced kill
both **without** a reinstall and **across** a same-version reinstall leaves the
store healthy.

The same run also showed a legacy `v10` blob read successfully and re-sealed to
`RLYM` in place, and an unknown envelope refused with its bytes untouched. The
build job succeeded with **494 of 494 unit tests passing and no skips**, and both
packaged helper binaries hashed equal to the ones built in that run. The helper's
own limits are in [`native/SECRET-HELPER.md`](native/SECRET-HELPER.md).

**One unresolved test, in `relayium-secret-helper`.** A tampered-blob case fails.
Observed, exactly: the test mutates byte 4 of the opaque protected blob, the
unprotect call did not refuse it, and 43 bytes were returned. Whether those bytes
equal the original plaintext is **not yet established**, and neither is what byte
4 holds — calling it "metadata" or concluding that an integrity check failed to
fire would both be inferences this run does not support. The test as written
demands that EVERY mutation of an opaque blob be refused, which may itself be too
strict an oracle. Diagnosis is pending; this is a known-failing gate on the
secret helper, and it does not bear on the IO helper above.

**Still not claimed.** Hardware power loss has not been tested. What is
demonstrated is forced termination of the process, against a synthetic fixture in
the durability harness and against the installation identity in the installed
run.

## Distribution

| Capability | Status | Notes |
|---|---|---|
| NSIS per-user installer, x64 | `partial`, `windows-observed` | Packaged and executed across candidates: silent install, same-version reinstall and uninstall, with a forced kill surviving both without and across a reinstall. Both packaged helper binaries hash-equal to the ones built in the same run. Not accepted: upgrade across versions is unexercised and the artifact is unsigned. |
| `relayium://` registration | `windows-observed` | The installer registers it and the uninstaller removes **its own** registration only; a foreign association written by another program survives an uninstall. The app never registers at runtime — `setAsDefaultProtocolClient` was removed, so there is exactly one writer. |
| Installation destination guard | `partial`, `windows-observed` | Refuses a destination equal to, enclosing, or enclosed by `%LOCALAPPDATA%\Relayium`, resolved through `GetFinalPathNameByHandleW`/`VOLUME_NAME_GUID` on every call. Junction and `subst` negatives are refused and their positives still install. Fail-closed on unresolvable paths; UNC rejected syntactically. Residual: TOCTOU between check and extraction, same Windows account. The enclosing-parent case is deliberately never executed. |
| ARM64 | `todo` | Tracked, not built. |
| Authenticode signing | `todo` | No certificate provisioned and no credential action authorized. Unsigned. |
| Public download surface | `todo` — deliberately untouched | `web/src/lib/apps-claim-rules.ts` bans claiming a Windows app exists; correct while none ships. |

## Shell and lifecycle

| Capability | Status | Notes |
|---|---|---|
| Tray residency, hide-to-tray | `reviewed`, not integrated | Show/Quit only. The macOS menu bar is a live control surface — resuming nearby receive and reaching the Inbox are **owed** once those exist here. |
| First-close explanation | `reviewed`, not integrated | Windows-specific: closing a window is expected to quit. Says the app keeps running, never that it is receiving. |
| Open at login | `reviewed`, not integrated | Three states from `openAtLogin` + `executableWillLaunchAtLogin`; a Task-Manager-disabled entry is never reported as on. Explicit consent required. |
| Notifications | `reviewed`, not integrated | Counts and closed codes; a filename is unrepresentable. Windows toasts additionally need an AUMID on a registered shortcut — unresolved. |
| Deep-link routing | `reviewed`, not integrated | Parses the real generated form (`/cross-network?mode=…#c=NNNNNN`), six digits carried as a string so leading zeros survive. Stored links are recognised and refused until that feature exists. |
| Graceful quit | `reviewed`, not integrated | Risk model, joined cleanup, actionable residue choice. |
| Update mechanism | `todo` | macOS uses Sparkle. No Windows support contract exists in `web/native-client-policy.json` — it has only a `macos` key — so a version gate would have nothing truthful to read. |

## Design tokens and UI

`partial`, not integrated. The Mac inherits macOS semantic colours that answer
Increase Contrast and Reduce Transparency for free; Windows has no equivalent and
that layer must be authored. Not parity yet.

## Owed outcomes — the acceptance requirements, kept explicit

These are full-product acceptance requirements; individual slices may already be
verified as recorded above.

| Area | Owed outcome |
|---|---|
| Account — authority | Sign in and out, device identity kept secret, and every transition fenced so a late response cannot resurrect a signed-out session. |
| Account — display | The signed-in account shown truthfully, including its plan. |
| Account — usage | Usage and quota visible and accurate, with honest loading, empty and error states. |
| Account — manage | Reachable management, without inventing surfaces the Web does not have. |
| Transfer — LAN | Nearby discovery and receive, resumable, with an honest reachable/not-reachable state. |
| Transfer — pairing | Cross-network pairing by code, both roles, including the SAS confirmation. |
| Transfer — files | Send and receive files with real progress, cancel, and bounded disk use. |
| Transfer — folders | Folder transfer preserving structure, with Windows name safety enforced. |
| Transfer — text | Send and receive text, including the unsent-text quit guard. |
| Localization | Complete EN and zh-Hans across every user-facing surface, main process included. |
| Motion | Honours reduced-motion; no animation that cannot be turned off. |
| Keyboard | Full keyboard reachability and visible focus on every interactive control. |
| Scaling | Correct at 100–300% Windows display scaling, no clipped or overlapping text. |
| Light and dark | Both themes, following the system setting, with adequate contrast in each. |

## What would still block a release

Full macOS parity, the secret helper's tampered-blob case, Windows-as-receiver,
the TURN relay path, the reverse-direction session actually completing,
stored links, Device Inbox, upgrade-across-versions, signing, and a truthful
public download surface.
