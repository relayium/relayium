# Web desktop LAN workspace — batch 3

Date: 2026-07-31
Status: implemented and locally validated for a bounded Web UI batch.
Scope owner: Web (`web/src`). No server, protocol, native, routing or copy changes.

## 1. Intent

The desktop LAN landing page presents Relayium like a marketing page before it
presents the transfer tool. At 1440×900 the centered identity Hero occupies the page
through approximately y=440, the primary “Nearby devices” task begins at y=489, and
the zero-peer state stretches almost the full 1240px content width. The result is a
large amount of low-information whitespace and the recent-transfer control falls at
the bottom edge of the first viewport.

This batch turns only the wide LAN landing route into a task-first workspace. Device
identity and connection status become a compact supporting rail; peer selection and
all transfer activity remain together as the primary column. Tablet/mobile, Cross,
marketing content and all transfer semantics remain unchanged.

## 2. Evidence and product judgment

Production baseline at 1440×900:

- screenshot: `.playwright-cli/page-2026-07-31T19-13-25-769Z.png`;
- navigation ends near y=75;
- the 64px logo begins near y=172 and the connection status ends near y=438;
- “Nearby devices” starts near y=489;
- the empty state spans approximately x=93…1332 and y=520…813;
- recent transfers begins near y=814.

The batch-2 mobile masthead already solves the corresponding narrow-screen problem.
The remaining defect is therefore not a global Hero or typography problem: it is the
wide LAN route's composition. A broad type-system or marketing redesign would touch
many pages without moving the primary desktop task forward.

## 3. Scope and invariants

In scope:

- a LAN-only workspace wrapper in `web/src/App.svelte`;
- a wide-screen presentation mode for the existing `Hero`;
- wide-screen section rhythm and heading treatment inside that workspace;
- focused structure/geometry tests and browser evidence;
- this spec.

Hard invariants:

- preserve `transferSurface` as one ordered unit: chooser, incoming request,
  send/receive progress and text session;
- keep recent transfers with the task column;
- keep the below-workspace marketing sections and footer full width;
- do not change peer selection, file inputs, drag/drop, protocol state, navigation,
  account visibility, routing, strings or analytics;
- do not affect Cross, Offline, account, CLI, Apps or download routes;
- preserve the existing layout below the wide breakpoint, including the batch-2
  mobile masthead and zero/one/multi-peer chooser rules;
- support all nine locales, document RTL, both themes, long device names and a
  200px account label without page-level overflow;
- add no dependency and no i18n key.

## 4. Exact composition

### 4.1 DOM ownership

On the LAN route, wrap the existing Hero and the complete task stack in one
`.lan-workspace`:

```text
.lan-workspace
├── Hero
└── .lan-task
    ├── unsupported banner, or
    ├── transferSurface
    └── recent-transfer history
home marketing sections
footer
```

The toast remains fixed and need not participate in either column. Marketing and the
footer remain after the wrapper so their existing full-width layout is untouched.
Do not split activity panels out of `transferSurface`: an incoming decision, an active
progress card and a message session are continuations of the same task and require the
wider column.

### 4.2 Wide-screen grid

At `min-width: 1180px`, leaving 80px of safety after the navigation first returns to
its verified desktop row at 1100px:

- start the workspace `24px` below the navigation content;
- use `grid-template-columns: 340px minmax(0, 1fr)`;
- use a `48px` column gap and start alignment;
- remove the transfer section's old `48px` top margin inside the task column;
- keep the task column's `min-width: 0` so localized content cannot enlarge the grid;
- let CSS logical direction mirror column placement under RTL; do not manually swap
  DOM order or use physical left/right placement.

With the existing 1280px main maximum and 20px padding, the right column is about
852px at a 1440px viewport and about 737px at the 1180px boundary when a classic
15px scrollbar consumes layout width. That remains wider than the already-used Cross
task card and is a safe minimum for active progress metadata and message controls.

At widths below 1180px, `.lan-workspace` is layout-transparent and every current
Hero/section spacing rule remains in force.

### 4.3 Supporting identity rail

Only at the wide breakpoint, the Hero becomes a start-aligned identity/status rail.
The wide rail deliberately reuses the proven mobile masthead treatment because the
desktop navigation immediately above already contains the full logo and wordmark:

- remove its internal top padding because the workspace owns vertical rhythm;
- hide the duplicate 64px logo but retain the page's unique `h1`, reduced to the
  existing 23px masthead size;
- use a start-aligned tagline with a comfortable 1.5–1.6 line height and no forced
  truncation;
- render the status surface as a deliberate full-width block with connection text
  and IP metadata allowed to occupy separate rows;
- preserve inline device rename, focus behavior, coarse-pointer target and all
  connection states;
- preserve entrance and reduced-motion behavior.

Constrain the inline editor to the rail width in addition to the existing connection
sentence and device-name wrapping guards. This rail is supporting context, not a
second card and not sticky. The task heading must visually win the initial scan.

### 4.4 Primary task column

- Keep the LAN “Nearby devices” heading at its current 20px application-section size;
  its top placement and adjacent task surface provide the priority without inflating
  another display heading.
- Keep the existing zero-peer empty state, one-peer link/card and multi-peer radar
  contents unchanged. Cap the LAN workspace empty surface at 640px so a 120px scanning
  signal does not sit inside an 852px banner-like box.
- In the LAN workspace only, make the selected-peer list a single track capped at
  560px. Today the multi-peer state renders one selected card into an `auto-fill`
  grid, shrinking it to roughly 252px at 1440px; the one-peer state correctly uses a
  full track. Cross retains its multi-card grid.
- Keep incoming, progress, message and history cards at the full task-column width.
- Preserve existing vertical gaps between activity cards and history.
- Unsupported browsers do not enter the two-column grid or its compact identity-rail
  Hero mode; the existing centered single-column Hero and full-width hard-failure
  banner remain the only content.

## 5. Accessibility, internationalization and state traps

- DOM heading order remains one `h1` followed by the task `h2`; visual columns must
  not require duplicated or visually hidden headings.
- RTL mirrors the two columns while reading/keyboard order remains Hero then task.
- The rename control must remain reachable and its focus ring must not be clipped by
  the identity column.
- Long Portuguese, Spanish, French, German and Arabic taglines wrap within 340px;
  no line clamp or ellipsis is allowed.
- Long device names may wrap inside the status block without widening the grid.
- `min-width: 0` is required on the task grid child; progress filenames,
  rate/path metadata, SAS codes and message contents are explicit overflow probes.
- Empty, one-peer and multi-peer states can change live without changing grid
  ownership or causing the Hero to jump columns.
- Incoming and transfer cards can coexist and make the right column taller; the left
  rail must remain top-aligned rather than vertically centered or sticky.
- The full-screen drag overlay retains viewport positioning and must not become
  constrained to the task column.
- Every chooser/layout override must be anchored under the LAN workspace. The scoped
  `transferSurface` styles also apply when that snippet renders inside CrossPage, so
  an unanchored `.peers`, `.empty` or `.peers ul` rule would silently change Cross.
- Reduced-motion behavior and theme contrast are unchanged.

## 6. Acceptance matrix

Automated:

- focused Hero/workspace contract tests;
- full Vitest, `npm run check`, production build and LAN browser E2E;
- existing zero/one-peer chooser and exact-byte transfer assertions remain green.

Browser evidence:

- widths: 320, 390, 768, 1099, 1179, 1180, 1280 and 1440;
- locales: all nine geometry probes, with visual review of en, pt, de and ar/RTL;
- themes: light and dark;
- states: connecting, ready, unsupported, zero/one/multiple peers, incoming request,
  active send/receive, completed/failed transfer, open text session and history;
- navigation with a simulated 200px account label at 1179 and 1180.

Quantitative gates:

- at 1440×900, the task heading starts no lower than y=180 and the complete zero-peer
  CTA plus recent-transfer summary are visible in the first viewport;
- at 1180px the task column is at least 735px wide with a classic scrollbar;
- at 1179px the former single-column composition remains active; at 1180px both
  columns are top-aligned with no breakpoint flicker or horizontal overflow;
- in a multi-peer LAN state the one selected action card is no wider than 560px and
  does not collapse into an `auto-fill` orphan track;
- every tested width/locale/theme has `scrollWidth === clientWidth` at page level;
- no tagline, device name, filename, transfer metadata, message action, select or nav
  label overlaps or paints outside its owning surface;
- Cross screenshots and computed geometry are unchanged apart from unrelated live
  connection data;
- keyboard order, focus visibility, rename commit/cancel and peer actions remain
  functional.

## 7. Risks and rollback boundary

The main product risk is making a familiar centered brand presentation feel too much
like an application shell. Retaining the title, trust statement and status in a
340px identity rail preserves context while avoiding a third rendering of the brand
immediately below the desktop nav. The breakpoint deliberately excludes tablets and
small laptops until there is enough width for a roughly 737px activity column.

The implementation is reversible at the `.lan-workspace` wrapper and one wide Hero
media rule. No state or protocol code is moved. If browser evidence shows the task
column is too narrow at 1180px, raise the breakpoint; do not split transfer activity
between columns or truncate localized content.
