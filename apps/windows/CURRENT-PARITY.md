> Windows 0.0.6 unsigned x64 public preview was published on 2026-11-27 from
> `7409f16e9f6885169ac881e8f8c50dde1b3a908f`. Long Device Inbox messages fold independently.
> Copy preserves the full body with the message expanded or collapsed. Download:
> https://github.com/relayium/relayium/releases/tag/windows-v0.0.6
> Updates are manual. The Windows clipboard and installed-artifact tests passed.
> The earlier candidate records below retain their original scope.

# Windows candidate against macOS 1.5.2

Target: macOS 1.5.2 (50). This private development candidate retains Windows
source version 0.0.4. There is no public signed Windows release or enabled
public update channel. The [older ledger](DURABLE-PARITY.md) preserves historical
Windows execution; its September counts are not current acceptance.

| Area | Candidate behavior |
|---|---|
| Nearby and pairing | Files, folders and text, verification, explicit receive destination, progress and cancellation use the shared production protocol. Both roles have existing Windows acceptance. Real NAT/TURN needs separate network evidence. |
| Stored links | Complete encrypted preparation before upload; explicit pause, restart recovery and local discard; original key, manifest and ciphertext retained. Lost upload/finalize replies are reconciled without a second delivery. |
| Expiry | One hour, one day, three days, seven days and fourteen days; one day by default, subject to server-authoritative account limits. |
| Device Inbox | Per-device composer and incoming/outgoing timeline; files and exact text; protected history and remembered device names; unread markers and snapshot-bound local deletion. Legacy records without authenticated senders stay separate. |
| Inbox recovery | Durable preparation and restart, explicit resume/discard, original-task tracking and queued-task cancellation. Local history deletion does not cancel delivery or delete saved files. Claimed tasks refuse cancellation; saved tasks remain delivered. |
| Account | Sign-in/out, profile/usage, device rename/revoke, stored-file links/deletion and email-confirmed account deletion. Windows uses the account website for plans; StoreKit is Apple-specific. |
| Desktop | Tray residence, folder consent, notifications, Windows file/protocol entry, startup preference and quit safeguards. Personal-machine acceptance remains required. |
| Updates | Signature and publisher checks remain enforced. Certificate, expected publisher and public feed trust are unprovisioned; automatic installation stays disabled. |
| Interface | English/Chinese, theme, keyboard navigation, reduced motion and constrained window sizing. Narrator and actual display scaling require Windows acceptance. |

Local checks include portable unit tests, real Electron pages and resident
restart flows, and the real Go server with synthetic accounts. Server cases
verify full payload bytes, original-key recovery, task identity and exact
once-only ciphertext traffic. Portable encrypted-store fixtures do not prove
DPAPI or sudden-power-loss durability.

Acceptance stays open until the frozen candidate passes hosted Windows checks
and relevant [personal-machine tests](TESTING.md). Signing, publication and
physical/network acceptance are separate gates. An unpacked Windows folder is
a test artifact, not an installed or signed release.
