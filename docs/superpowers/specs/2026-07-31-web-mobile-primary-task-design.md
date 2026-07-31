# Web mobile navigation & primary-task hierarchy — batch 2

Date: 2026-07-31
Status: implementation spec for a bounded Web UI batch.
Scope owner: Web (`web/src`). No server, protocol, native, routing or i18n-copy changes.

## 1. Intent

At 390×844 the LAN landing page does not expose a send action in its first viewport.
The page spends that viewport on two navigation rows, a second large rendering of the
brand, a multi-line connection pill, an informational callout and a 300px radar. The
radar is not a useful selector when there are zero or one peers, yet it still consumes
the largest block of the page.

This batch makes the mobile page read as a focused tool while preserving the richer
desktop presentation and every existing transfer, peer-selection and navigation
semantic. It also fixes confirmed overlap between localized navigation labels.

## 2. Evidence

Production screenshots were captured before implementation at 320×844:

- Chinese: `.playwright-cli/page-2026-07-31T16-35-24-500Z.png`
- Korean: `.playwright-cli/page-2026-07-31T16-35-29-338Z.png`
- Arabic/RTL: `.playwright-cli/page-2026-07-31T16-35-33-777Z.png`

The Chinese and Korean screenshots confirm that the current five equal-width,
`white-space: nowrap` navigation chips paint over one another. In all three locales,
the first viewport ends within the empty radar and contains no empty-state action or
send action. An English connected-peer screenshot places the first peer action at
approximately y=1045 on a 844px-tall viewport.

The code explains the waste:

- `effectiveSelected` already selects the sole peer, so a one-peer radar has no
  selection work to perform.
- A zero-peer radar has no focusable blips and is followed by a second, separate empty
  state that repeats the same absence.
- `Nav` already renders the brand mark, then `Hero` repeats a 64px mark and wordmark.
- The text-availability note describes the message action but precedes both the peer
  selector and that action.

## 3. Scope and invariants

In scope:

- `web/src/lib/Nav.svelte`
- `web/src/lib/Hero.svelte`
- `web/src/lib/DeviceRadar.svelte`
- `web/src/lib/PeerLink.svelte` (new presentational component)
- `web/src/lib/CrossPage.svelte` (localized overflow guard only)
- `web/src/lib/CrossSell.svelte` (localized mobile CTA wrapping only)
- `web/src/App.svelte`
- focused tests for these contracts
- `web/e2e/lan-transfer.mjs` (zero/one-peer chooser contract assertions)
- this spec

Hard invariants:

- Keep all five destinations as real links with their current `href` and
  `aria-current="page"` behavior.
- Keep language, theme and conditional account controls available exactly where they
  are available today. This batch does **not** change account visibility or auth IA.
- Keep all nine existing locale strings unchanged and support document RTL.
- Keep `effectiveSelected`, transfer protocol, file inputs, drag/drop, peer capability
  gating and routing behavior unchanged.
- Add no runtime dependency and no new i18n key.
- Do not make the navigation sticky.

Non-goals: hamburger or bottom navigation, new account behavior, marketing/footer
redesign, typography-system cleanup, protocol/server/native work, or changing pages
other than incidental shared `Nav` and `Hero` rendering.

## 4. Exact design

### 4.1 Mobile navigation: honest two-row shell plus natural-width mode rail

The compact two-row navigation is retained at widths up to 1099px. Five destinations,
two utility selects
and nine languages cannot honestly fit on one 320px row. The defect is equal-width
compression, not the existence of the second row.

Row one remains brand mark plus the existing utility group. Row two becomes a
single-line, horizontally scrollable rail:

- tabs use their natural width (`flex: none`) with consistent inline padding;
- the rail uses `overflow-x: auto`, proximity scroll snap and logical inline
  properties so it behaves in RTL;
- hidden scrollbars and a subtle symmetric edge fade indicate overflow without adding
  controls;
- block padding protects the global focus outline from overflow clipping;
- `scroll-padding-inline` keeps focused/current chips off the faded edge;
- when the route changes and the rail actually overflows,
  `scrollIntoView({block: "nearest", inline: "nearest"})` exposes the current link
  without hand-calculating browser-specific RTL scrollLeft. It is never invoked in
  the non-overflowing desktop layout, so it adds no desktop scroll policy; mobile
  route changes already replace the page body and return to its top.

Both utility selects receive the same mobile logical-width bound. Native selects use
their longest option for intrinsic sizing (the Japanese theme labels are the limiting
case), so constraining only the language select would still force a third row at
390px. On routes that add Account, the utility group may wrap internally and the
account label receives its own mobile maximum; language/theme controls retain a
readable floor instead of being compressed into unusable slivers.

All five links remain in DOM and keyboard order. The page itself must never gain
horizontal overflow, including tablet and small-laptop widths where the former desktop
single-row layout overflowed. The single-row layout returns at 1100px, the first tested
width that also fits the longest locale plus a 200px signed-in account label.

### 4.2 Mobile Hero: masthead, not a miniature marketing hero

Desktop (>700px) keeps the batch-1 presentation. At <=700px:

- hide only the duplicate 64px visual mark; the visible `h1` and tagline remain;
- reduce top padding and use a 22–24px start-aligned heading;
- render the tagline as compact, start-aligned supporting copy;
- turn the status pill into a full-width compact status block;
- group the live connection sentence/device-name edit control, then place public IP
  as secondary metadata on its own deliberate row instead of allowing arbitrary
  three-line flex fragmentation;
- use logical alignment so Arabic mirrors naturally;
- preserve the rename control, connection states and reduced-motion behavior.

The rename button must remain keyboard accessible and gain a coarse-pointer target
near 44px without changing its visual label.

### 4.3 Peer chooser: render selection UI only when selection exists

The chooser has one rule at every breakpoint: **a large selector appears only when
there are at least two choices.** This is intentionally consistent on desktop and
mobile and can be reverted without touching transfer behavior.

| Visible peers | Rendering |
|---|---|
| 0 | Existing empty-state card containing a compact (120px) no-peer `DeviceRadar` as the live scanning signal, followed by existing empty copy/CTA. No second large radar. |
| 1 | New compact `PeerLink`: a decorative self-to-peer connection line, followed immediately by the existing solo peer send card. It creates no button and no selection semantics. |
| >=2 | Existing full `DeviceRadar`, unchanged as the interactive peer selector. |

`DeviceRadar` receives a presentation-only `compact` prop defaulting to `false`.
Its default size, peer buttons, labels, pressed state, layout and callbacks remain
unchanged. `PeerLink` is `aria-hidden` because the following peer card already exposes
the actionable target and peer name; it must contain no focusable control.

When a user selects a blip in the multi-peer radar, the existing peer card is rendered
and scrolled instantly to `block: nearest`. Headed and headless Chrome testing found
that smooth `scrollIntoView` moved zero pixels on this page while the equivalent
instant call reliably revealed the card; the minimum-distance instant movement also
satisfies reduced motion unconditionally. Automatic single-peer selection must never
trigger page movement.

### 4.4 Content order

Within `transferSurface`, preserve decision/status priority, then render:

1. section heading and quota/status notices;
2. pending-share confirmation, if any;
3. the appropriate empty/link/radar chooser;
4. the existing selected peer card;
5. the neutral text-availability callout, only when at least one peer is visible.

The callout therefore sits next to the message action it explains and no longer blocks
the primary task. The same movement applies to the shared Cross transfer surface and
must be included in regression checks.

## 5. Accessibility and internationalization

- Navigation remains links, not tabs; no fake tab roles or hidden destinations.
- The rail must not clip `:focus-visible`, and keyboard focus must make an offscreen
  link visible.
- Logical properties and native `scrollIntoView` are required for RTL; no numeric
  `scrollLeft` calculations.
- Decorative PeerLink content is hidden as a unit from assistive technology; the
  adjacent peer card remains the single actionable representation.
- An empty compact radar is decorative (`aria-hidden`) because the adjacent heading
  and empty-state copy already expose its meaning. A compact radar combined with
  peers in a future call remains a labelled group so focusable blips are never hidden.
- Existing motion-reduction rules remain; programmatic peer-card scrolling is always
  instant, so reduced motion cannot accidentally depend on an animation branch.
- No label is truncated merely to make it fit. Horizontal scrolling is preferable to
  ellipsis for these five primary destinations.

## 6. Acceptance matrix

Automated:

- focused component/contract tests pass;
- full Vitest, `npm run check`, production build and LAN browser E2E pass;
- `DeviceRadar` default behavior and size contract remain covered;
- `PeerLink` renders both endpoint labels visually but contains zero buttons/links;
- nav has five real links and exactly one current link after route changes.

Browser evidence:

- widths: 320, 390, 768 and >=1280;
- locales: en plus zh, ko and ar (RTL); spot-check all remaining locales for nav
  overflow via computed geometry;
- themes: light and dark;
- states: zero, one and at least three visible peers; reduced motion; Cross page.

Quantitative gates:

- 390×844, one peer: at least one complete send action is visible without scrolling,
  with its top no lower than y=560;
- 390×844, zero peers: the empty-state CTA is fully visible without scrolling;
- 390×844, multi-peer: the peer selector (the primary task in that state) begins in
  the first viewport and every blip remains usable;
- 320 and 390: no page-level horizontal overflow in any locale, no chip text paints
  over another chip, and current chip is within rail bounds;
- 768: the tablet navigation rail also has no page-level horizontal overflow in any
  locale, including routes with Account;
- 320 and 390 LAN without Account: the brand/utilities plus mode rail remain two
  rows in every locale; routes with the extra Account control may wrap safely;
- focus rings are not clipped; mobile status content forms deliberate rows rather
  than broken fragments;
- desktop nav and Hero are visually unchanged; the expected desktop differences are
  limited to zero/one-peer chooser presentation and callout position.

## 7. Risks and rollback boundaries

The radar is visually distinctive, so replacing it for the common one-peer state is
the principal product judgment. The countervailing evidence is that it currently
delays the actual action by more than half a mobile viewport while providing no choice.
The rule is isolated in `transferSurface`: rollback restores the unconditional radar
without touching `DeviceRadar`, protocol state or the peer card.

A scroll rail can make later destinations less discoverable. Edge fades, natural chip
widths and auto-revealing the active/focused item mitigate this. If measured localized
rail width exceeds 1.6 times its viewport, the fallback is natural-width wrapping,
not truncation or a new menu.

Moving the availability note also affects Cross because it reuses the transfer
surface. Cross mobile and desktop are explicit acceptance cases.
