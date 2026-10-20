# Documentation map

Reviewed against source on 2026-10-20. Documentation, source implementation,
installable releases and a live deployment are separate kinds of evidence.
A dated design, an unchecked task list or a passing test is not a release claim.

## Current starting points

| Question | Read |
| --- | --- |
| Product and public availability | [README](../README.md), [native apps](../apps/README.md) |
| Wire contracts | [protocol index](protocol/README.md) |
| Testing / actual execution boundaries | [TESTING](TESTING.md), [CI platform boundary](CI-PLATFORM-BOUNDARY.md) |
| Self-hosting and administrator access | [self-hosting](self-hosting.md), [Passkey-only admin](admin-passkeys.md) |
| Upload behavior | [ordered pipeline](upload-pipeline.md), [packing preference](upload-chunk-tuning.md), [CLI resume](cli-resumable-upload.md) |
| Channel submission history | [macOS](macos-app-store-submission.md), [iOS](ios-app-store-submission.md), [Android](android-development.md) |
| Security reporting / supported fixes | [SECURITY](../SECURITY.md) |

Public channel check on 2026-10-20: CLI `v0.27.2`, Mac direct `1.4.10`, Android
preview `0.3.2`; Apple's public Mac listing reports `1.4.7`. The latest recorded
iOS internal TestFlight is `0.5.2 (13)` (2026-10-18), not a public release or a
new live-provider read. Source version labels do not promote a channel.

## Historical material and plans

[superpowers/README.md](superpowers/README.md) classifies the dated plans and
specifications. They retain the decisions and constraints of their date; do
not turn their unchecked boxes into today's backlog or follow old rollout
commands without current-source validation. The `*-review-*`, `*-report.md`
and `optimization-requirements-2026-07.md` reports likewise carry dated
findings/corrections, not a fresh audit or a new task activation.

Windows documents describe development sources/candidates; they are not public
Windows application availability. The two maintained languages are English and
Simplified Chinese; localization archives are not active translations.
