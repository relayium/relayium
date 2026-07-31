# Web peer action geometry — batch 4

Date: 2026-08-01
Status: implemented, reviewed, and production-validated.
Scope owner: Web (`web/src`, focused LAN E2E). No server, protocol, routing,
i18n-string or icon-system changes.

## 1. Intent

The shared peer action card is being treated as an auto-fill tile even though it
contains a device header and up to three real controls. In production Realtime at
1440×900, a 672px list becomes two roughly 328px tracks plus an orphan third row;
each action is about 97px and every English label wraps. At 390px the same actions
fall below 90px. The more severe hidden case is LAN between 700 and 1179px: after a
multi-peer radar selection, App renders one action card into an auto-fill grid and
the card can shrink to roughly 276px.

This batch makes the shared peer surface an action layout rather than an icon grid:
one stable card track, one clear file row, and adaptive secondary actions. It also
repairs the file picker's accessible name and focus ownership, which the stronger
visual hierarchy would otherwise make more misleading.

## 2. Evidence

- Production Realtime, three peers, 1440×900:
  `.playwright-cli/page-2026-07-31T20-35-09-226Z.png`.
- Production Realtime, three peers, 390×844:
  `.playwright-cli/page-2026-07-31T20-37-55-040Z.png`.
- At 1440 the Cross task card is 720px outside / 672px inside; peer cards form a
  2+1 grid and action slots are about 97px.
- At 390 the three cards stack, but action slots are about 81–87px and all English
  labels break into cramped two-line controls.
- `repeat(auto-fill, minmax(240px, 1fr))` also creates empty tracks around the one
  selected LAN card below Batch 3's 1180px workspace breakpoint.
- The Cross transfer section keeps the homepage `.peers { margin-top: 48px }` in
  addition to its parent `ui-stack` gap, leaving roughly 60px between the Realtime
  subtitle and the connected-device heading.

## 3. Scope and invariants

In scope:

- shared peer-list track geometry and action wrapping in `App.svelte`;
- Cross-specific transfer-section spacing and truthful LAN-overlap heading;
- file-input ownership, accessible name and focus-ring placement;
- focused E2E assertions and browser geometry;
- this spec.

Hard invariants:

- preserve peer selection, `effectiveSelected`, outbox interception, file/folder
  inputs, capability gating, drag/drop, `session.sendFiles`, text-session behavior,
  route state and every existing locale string;
- keep exactly one `<button>` inside `.peer-actions` when text is supported and none
  when it is not; the message E2E deliberately relies on this semantic distinction;
- keep LAN desktop selected cards at the Batch-3-verified 560px maximum;
- keep the first complete file action visible in the 390×844 one-peer LAN journey;
- do not change global `.btn` geometry or pages outside the peer surface;
- add no dependency or i18n key;
- defer icon replacement. A later icon batch must migrate the Realtime title,
  CodePairing actions, peer-card actions and adjacent availability callout together;
  changing only three emoji would make one workflow less consistent.

Known, deferred edge cases:

- duplicate device names remain ambiguous; a localized, protocol-aware identity
  treatment is larger than geometry and must not be improvised with an unexplained
  peer-id suffix;
- Cross with multiple LAN peers has no paste-selected target because
  `effectiveSelected` is empty without a radar selection; this is existing behavior;
- pairing-room capacity is currently two participants. If the server later permits
  group rooms, the Cross heading predicate must be revisited.

## 4. Exact design

### 4.1 One real peer-card track

Replace the peer list's auto-fill tracks with:

```css
.peers ul {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  max-inline-size: 560px;
}
```

Remove the now-redundant Batch-3 wide-LAN track override. The shared cap yields one
consistent LAN action measure in one-peer and selected-multi-peer states. At narrow
widths the list remains `inline-size:auto` and simply fills the available space. It
remains start-aligned: task headings, cards and controls share an edge.

Cross is already constrained by its 720px page card, so its list removes the 560px
cap and fills the 672px inner measure. This eliminates the 2+1 grid without creating
a new 112px dead edge and preserves the already-good Cross card width. Multi-peer
cards give each desktop secondary action roughly 318px; the common solo state keeps
its pre-existing 360px action-group cap and roughly 176px secondary actions.

Cross's `.peers` receives an explicit route class and `margin-top: 0`. Its parent
`ui-stack` already supplies the 12px separation from the Realtime subtitle; homepage
LAN keeps its 48/24px Hero-to-task rhythm.

### 4.2 Adaptive action hierarchy

The action group becomes a wrapping flex layout:

- every action uses `flex: 1 1 165px`;
- the file picker uses `.pa-files { flex-basis: 100% }`, so it always owns the first
  full row;
- folder and message share a row only when both can provide at least 165px; otherwise
  each becomes its own full row;
- capability combinations of one, two or three controls fill honestly without grid
  holes or `nth-child` assumptions;
- labels sit in `.pa-label` spans so real line geometry can be measured;
- existing emoji are wrapped in an `aria-hidden` span but remain visually unchanged
  until the complete icon-system batch.
- action controls receive a 36px desktop minimum height; coarse pointers retain the
  global 44px minimum.

The 165px basis is a starting measurement derived from French and Portuguese labels,
not an article of faith. Browser acceptance calibrates it with actual rendered fonts:
any label sharing a row must have exactly one client rect. A full-row action may wrap
only when the viewport itself cannot fit its unbroken localized content.

Expected behavior:

- 320/360/390 LAN or Cross: files, folder and message become three full-width rows;
- approximately 430px LAN, every 560px LAN card and desktop Cross: file row plus a two-column secondary
  row, with French/Portuguese labels unbroken;
- capability-gated two-control states: the one secondary control fills its row;
- RTL mirrors the row naturally; no `row-reverse` rule.

### 4.3 File-input semantics and focus

Today the file input is nested in the card header while a second external label points
at it. The browser therefore paints the `:has(input:focus-visible)` ring around the
header, not the visible “Send files” action, and associated labels can concatenate
into an excessively long accessible name.

Move the input into the `.pa-files` action label. Make the card header a `for=` label
for the same input, preserving card-wide click-to-pick behavior. Keep the outbox click
interception and change handler on the input. Point `aria-labelledby` at the visible
localized “Send files” span, so the visible label is the accessible name, and point
`aria-describedby` at the existing target text. This preserves target context without
violating WCAG 2.5.3 Label in Name or adding a tenth set of strings.

Add `position: relative` to `.peer`; the 1px absolutely positioned input then belongs
to its own card rather than stacking at the positioned `main` origin. Keyboard order
remains file input → optional folder input → optional message button, and the existing
global `label:has(> .file-pick-input:focus-visible)` rule now paints on the visible
file action.

### 4.4 Heading truth

In a Cross pairing room (`roomCode` present), the server's two-participant room cap
means the active target is singular, so keep `crossPeersTitle`. Cross without a room
is the LAN auto-surface and uses `peersTitle` (“Nearby devices”), including the real
multi-device state. LAN continues to use `peersTitle`.

No new plural strings are introduced. Leave a source comment tying this decision to
the room-capacity invariant so a future group-room change cannot silently inherit it.

## 5. Accessibility and interaction traps

- The file header and visible action remain labels for the same input;
  `aria-labelledby` makes the visible action text its name and `aria-describedby`
  supplies the peer context without concatenating both labels into the name.
- Hidden inputs remain enabled/disabled exactly with `busy`; label disabled styling
  continues through `.is-disabled` because `:disabled` does not apply to labels.
- SVG/icon work is out of scope. Emoji spans are decorative and cannot become the
  only control content.
- Do not introduce another button into `.peer-actions`; folder/file remain labels
  around native file inputs and text remains the single button.
- Moving the input must not change outbox immediate-send behavior or the user's file
  picker gesture.
- Flex must handle folder unsupported, text capability late arrival and old peers
  without empty columns.
- Full-screen multi-peer drag remains “choose a card”; card drop targets become larger,
  and only the hovered card receives its drag state.
- Logical margins and normal document direction provide RTL behavior.

## 6. Acceptance

Automated:

- focused component/source contracts for the file input/action ownership and label
  spans where practical;
- full Vitest, `npm run check`, build and complete real LAN E2E;
- E2E proves the file input lives directly under `.pa-files`, is named by its visible
  localized label, receives real keyboard `:focus-visible` in the visible action, and transfer bytes,
  resume, message and old-peer capability behavior remain exact;
- the same E2E emulates a coarse pointer at 390×844 and checks every locale for
  three distinct rows, the 44px floor, single-line labels, zero overflow and the
  first complete file action inside the viewport;
- at 430×844 it checks every locale again at the shared-row threshold, including
  both secondary widths at or above 165px and one rendered line per label;
- Batch 3's 500–561px selected-card assertion remains unchanged and green.

Browser geometry:

- widths 320, 360, 390, 430, 768, 1024, 1179, 1180, 1280 and 1440;
- LAN and Cross; zero, one, two and three peers where the state is meaningful;
- all nine locales geometrically; visual review en, fr/pt, de and ar/RTL;
- light/dark and keyboard focus.

Quantitative gates:

- every `.peer` is a single vertical track; LAN cards cap at 560px and Cross cards
  fill, but never exceed, their 672px task measure;
- Cross three-peer cards have three distinct top coordinates, equal widths and no
  2+1 orphan row;
- any secondary actions sharing a row are at least 165px wide and every shared-row
  `.pa-label` has one client rect;
- no page-level horizontal overflow at any tested width/locale;
- Realtime's subtitle-to-peer-heading gap is the parent stack gap, not an additional
  48px homepage margin;
- at 390×844 the complete file action remains visible in the first viewport for the
  first peer;
- LAN at 1180/1440 remains 560px, matching Batch 3;
- focus ring is visible on `.pa-files`, keyboard order is unchanged, and action counts
  reflect folder/text capability gates.

Negative controls:

- the i18n key sets and all protocol/session paths are unchanged;
- Offline, download, account, CLI, Apps and Pricing receive no CSS match from the new
  rules;
- global `.btn`, `.btn-sm` and `.btn-block` rules do not change;
- Cross solo remains at its established full task width;
- deleting the shared single-track rule must reproduce a sub-300px LAN card at 1179
  or a 2+1 Cross layout; deleting the wrapping basis must reproduce a shared-row label
  below its measured safe width.

## 7. Rollback and follow-up

Rollback is limited to the peer list/action CSS, one route-class/title expression and
the file input's position in existing markup; no state moves. Batch 4b should establish
one code-native line-icon component and replace every file/folder/message/bolt emoji
in the realtime workflow in one pass. Duplicate-name disambiguation and Cross
multi-LAN paste targeting remain separately framed product work.
