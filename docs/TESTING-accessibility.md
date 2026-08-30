# Accessibility — automated coverage and the manual matrix

**Execution status key** (same convention as `TESTING.md`):

- `[AUTOMATED]` — runs in CI or in a repeatable local command; failures are red.
- `[MANUAL — NOT YET RUN]` — needs a real screen reader on real hardware. Written
  down here so it can be run; **no result below has been recorded yet.**

---

## 1. What is automated `[AUTOMATED]`

| Command | Scope |
|---|---|
| `npm test` | Unit contracts: token contrast maths, landmark structure, dialog naming, role placement, focusability, i18n completeness for every accessible name. |
| `npm run test:a11y` | axe-core 4.13.0 in real headless Chrome over the **built** site: 14 targets covering all six static template types (two representative pages are RTL), the SPA in light/desktop and dark/mobile, four SPA routes, and the account dialog. Runs in CI right after `npm run build`. |
| `npm run test:e2e:mixed` | The same axe engine at the states only two real peers can reach, on the default build's unified `link/1` workspace in the LAN room: workspace header, text consent card and 40-file consent card at 390px, both lanes live after text consent, the **live** `role="progressbar"` inside an in-flight transfer card, the workspace at each viewport variant, and the chooser restored after an explicit disconnect. Separate command because it needs a Go toolchain and its own server port. |
| `npm run test:e2e:code-room` | The same engine in a **pairing-code** room: unified workspace at 390px in English and in Chinese, the file consent card at 390px, and the pre-link send confirmation. |
| `npm run test:e2e:page-shell` | Page-shell contrast, focus order and touch geometry on the auth landing, `/apps`, `/pricing` and the insecure-context fallback. |

Scope of the rule set: **WCAG 2.0 / 2.1 / 2.2, levels A and AA**, plus ten
named best-practice rules. The allowlist (`web/e2e/a11y-allowlist.json`) is
empty and should stay that way; see `web/e2e/README.md` for its policy.

### One row was removed from that table, and it was overstating coverage

This table used to carry a fifth command, the LAN runner `lan-transfer.mjs`, and
credited it with four live states: the file consent card, an in-flight transfer's
`role="progressbar"`, post-drop-resume completion, and a message session's
`role="log"`. That row was listed under `[AUTOMATED]`, and it should not have
been. The script stopped being able to reach any of those states when the legacy
per-peer transfer controls were removed from the product in `d175f863`
(2026-08-27); from then until its deletion it could not exit zero, and it was
never a CI gate. Every state it claimed was therefore claimed by a run that was
not happening — the exact failure mode the status key at the top of
[TESTING.md](TESTING.md) exists to make visible.

What is true after the correction, state by state:

- **File consent card** — really automated, twice: `mixed-link.mjs` scans it at
  390px with a 40-file manifest, and `code-room.mjs` scans it again in a
  pairing-code room. Both run in hosted CI.
- **Live `role="progressbar"`** — really automated, in `mixed-link.mjs`. It is
  scanned in the one window where the subject exists: after two durable chunks
  have landed and before the forced transport gap closes the connections. The
  bar is proved present before axe is pointed at it, because a scoped `axe.run`
  over a context that matches nothing reports zero violations for ever.
- **Message session** — the workspace is scanned with **both lanes live** after
  text consent, so the message surface is inside the scanned document. What is
  *not* separately asserted is a message-session-only scope.
- **Post-drop-resume completion** — **not** scanned by any runner today. The
  resume itself is proved byte-exact in `mixed-link.mjs`; its terminal card is
  not put through axe. This is a real gap, and it is stated here rather than
  inherited from a row that was never running.

## 2. What automation cannot decide

axe reads the DOM and computed styles. It cannot hear anything. Specifically it
does **not** tell us:

- **what a screen reader actually says**, or in what order;
- **how many times** a live region announces — a correct `aria-live` and a region
  that fires three times per chunk look identical to a static check;
- **where focus goes** after a dialog closes, a transfer completes, or a
  connection drops and resumes;
- whether an announcement arrives **in time to act on** — consent decisions are
  time-boxed by the peer;
- whether the reading order matches the visual order under RTL.

It also leaves some things explicitly undecided (`incomplete`): contrast over the
brand gradient and the peer file picker's two labels. Those are listed as
`[MANUAL — NOT YET RUN]` below rather than treated as passes.

## 3. Manual assistive-technology matrix `[MANUAL — NOT YET RUN]`

Columns: **VO/mac** VoiceOver + Safari (macOS) · **VO/iOS** VoiceOver + Safari
(iOS) · **NVDA** NVDA + Firefox (Windows) · **KB** keyboard only, any browser.

Two devices are required for every transfer row — this is a peer-to-peer product
and the interesting states do not exist with one tab.

| # | Scenario | Expected | VO/mac | VO/iOS | NVDA | KB |
|---|---|---|---|---|---|---|
| 1 | Incoming file consent | Polite region announces sender, file count, size; verification code read **once** | | | | |
| 2 | Second link in one mixed workspace | Code is **not** read again — it is still on screen in the header (`activity-announcement.ts` contract) | | | | |
| 3 | Accept → save dialog | Focus is somewhere predictable when the OS dialog returns; nothing is silently focused for the user | | | | |
| 4 | Transfer in progress | Progress reported **on demand** as "Sending to <peer>", not announced per chunk | | | | |
| 5 | Connection drops mid-transfer | The interruption is announced; the resumed transfer does not re-announce from zero | | | | |
| 6 | Message panel | Each new message announced once; the body is not read twice | | | | |
| 7 | Account dialog, all five submodes | Name matches the mode on screen (sign in / create account / reset password / verify email / account) | | | | |
| 8 | Any dialog close | Focus returns to the control that opened it | | | | |
| 9 | 40-file consent manifest | Reachable and scrollable by keyboard; announced as a list with its item count | | | | |
| 10 | Full send flow, keyboard only | Completable end to end; focus ring visible at every stop; no traps | | | | |
| 11 | Switch to `ar` | `dir=rtl` honoured; reading order matches visual order; the language select announces itself | | | | |
| 12 | 200% zoom / 320px width | No horizontal scrolling; the next decision stays in the first viewport | | | | |
| 13 | `prefers-reduced-motion` | The reveal scroll does not move focus or hijack the viewport | | | | |
| 14 | Gradient CTA buttons | White label legible against the button in both themes (axe returns `incomplete` here) | | | | |
| 15 | Close-icon buttons | Announced as "Close"; reachable by voice control saying "Close" | | | | |

### Recording results

Append one row per run. Do not mark a cell green from reasoning — only from an
observed run.

| Date | Build (git sha) | Tester | AT + OS | Rows run | Result / notes |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

## 4. Known manual checks and scanner incompletes

- **Brand-gradient contrast on decorative marks.** `--grad-accent` still paints
  the generated-page header marks, CLI hero glyph, and download-page logo mark.
  None carries information and each is hidden from the accessibility tree, so
  this is deliberate; axe still reports the visible glyph contrast as
  `incomplete`. Row 14 is instead about the readable action gradient.
- **Close buttons** use an `aria-hidden` SVG with a localized `aria-label`, which
  gives axe a deterministic accessible name. Row 15 still checks the part a DOM
  scanner cannot: whether voice control and the real screen reader expose it well.
- **Peer file picker has two labels** (a wrapping `<label>` and the peer card's
  `for=`). `aria-labelledby` decides the name, but axe reports
  `form-field-multiple-labels` as `incomplete`; row 10 covers it.
