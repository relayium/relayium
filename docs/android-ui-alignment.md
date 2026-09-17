# Android alignment with macOS 1.4.0

Status: private engineering candidate, not a release. It builds on the
previously accepted Android reference UI (neutral page and card surfaces, 11dp
cards with a hairline edge, grouped rows) and the retained stored-recovery
change.

## What changed

- **Status head (`StatusHero` in `ui/Design.kt`).** The macOS 1.4.0 hero on a
  touch screen: a still brand radar, the current STATE as the title (a polite
  live region), a detail line, and full-width controls below. 14dp corner,
  hairline edge, and a wash from an opaque tint of the action colour to the card
  fill. Used by Device Inbox (receiving state, this device's name) and Nearby
  while active (discovery mode, with the hub caution inside it).
- **Device Inbox Check now.** A secondary action inside the status head, shown
  only while the loop is listening with no failure (or while a check is
  outstanding), disabled and labelled Checking… until answered, followed by one
  of three answers. It is not Retry, which still re-reads the device list.
- **Navigation names are unchanged.** "Cross-network" does not fit five even
  tabs at ordinary widths, so renaming Transfer is left for a navigation change
  that can be measured on its own.

## Check now runtime (`inbox/InboxRuntime.kt`)

- `checkNow()` is refused when there is no session, the surface is not live
  (Android receives only in the foreground), policy is Off, no loop is running,
  or the device key is not usable yet.
- The outstanding request is one atomic serial. The loop takes it at the START
  of a pass, so only a pass that begins after the press answers it; a press
  during a pass is served by the next pass, and the running pass (including a
  delivery in flight) is never cancelled.
- Waiting between passes is `nap`: the injected pause, cancelled early only by a
  wake that finds a request outstanding. The wake channel is conflated, so a
  press made just before the nap begins is not lost.
- Repeated presses coalesce into one request. Stopping the loop withdraws an
  outstanding request (`NONE`), and adopting another account resets the whole
  state, so no answer lands on another account.
- Answers: `NOTHING_NEW` (idle pass), `CHECKED` (pass worked a delivery),
  `FAILED` (pass threw or could not receive). None claims an arrival; under Ask
  nothing is accepted.

## Verification

- `InboxRuntimeTest`: eight Check now tests — idle wake, coalescing, a press
  during an in-flight pass, failure, refusal when off or not live, withdrawal on
  stop, account switch, and Ask. Two deliberate mutants (ignoring the wake;
  letting the in-flight pass answer) each fail the suite.
- `StatusHeroContrastTest`: `onSurface`, `onSurfaceVariant` and the accent text
  role clear 4.5:1 on both ends of the wash in light and dark; the radar glyph
  clears 4.5:1 on the action fill.
- `InboxScreenAcceptanceTest` (device): Check now offered and wired, disabled
  while checking, every answer shown, absent when off/stopped/failing, and Ask
  keeps held deliveries.
- `ReferenceLayoutAcceptanceTest` (device): EN/zh, day/night and font scale 2.
  Its host now provides the Scaffold's content colour, so captures no longer
  show the heading in black on a dark page.
- `:app:testDebugUnitTest`, `:protocol:test`, `:app:lintDebug`,
  `scripts/test/android-policy-test.mjs`.
