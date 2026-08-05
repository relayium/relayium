# Web UI primitives & surface tokens — batch 1

Date: 2026-07-31
Status: design + implementation spec for a bounded first batch of the Web visual-system refresh.
Scope owner: web (`web/src`). No server, protocol, macOS or i18n copy changes.

## 1. Intent

Relayium's Web app has three visual layers that drifted apart:

- `app.css` owns a *partial* global system (`--accent`, `.btn`, `.progress-*`, focus ring).
- `App.svelte` owns a second, component-scoped copy of "card", "sas", "path badge",
  "action button" — invisible to any child component.
- `CrossPage` / `OfflinePage` each own a third, byte-for-byte duplicated copy of
  "card / badge / card-head / card-sub / page-head".

The result is that the same concept renders differently depending on which file
happened to draw it, and one concept (`MessagePanel`'s card) renders as nothing at
all. This batch establishes **one** set of surface/control tokens and a small set of
truly global class primitives, then migrates the four affected components onto them.

Non-goal: a redesign. Every change here should read as "the same product, drawn
consistently and legibly", not as a new look.

## 2. Evidence (confirmed defects)

| # | Defect | Location |
|---|--------|----------|
| D1 | `.card` is defined in `App.svelte`'s scoped `<style>`, so `MessagePanel.svelte`'s `<section class="card">` gets **no** card styling: no border, no background, no padding. Its `<h2>` falls through to the global 30px marketing `h2`. | `App.svelte:1056`, `MessagePanel.svelte:85` |
| D2 | `MessagePanel` renders `<span class="path path-lan"><i class="dot">` but defines no `.path`/`.dot` rules — the dot has no size/colour and the badge is plain text. Same markup in `App.svelte` is styled. | `MessagePanel.svelte:102` vs `App.svelte:1125` |
| D3 | `.card`, `.cardsub`, `.mhead`, `.badge`, `.cn-head` are duplicated verbatim between `CrossPage.svelte` and `OfflinePage.svelte`. | `CrossPage.svelte:106-119`, `OfflinePage.svelte:81-93` |
| D4 | `CrossPage` styles `.badge.ok` under `@media (prefers-color-scheme: dark)`, but the app's theme is an explicit `data-theme` attribute on `<html>`. A user on a dark OS who forces light gets the dark badge, and a user on a light OS who forces dark does not get it. | `CrossPage.svelte:121-123` |
| D5 | The connected-peer action controls (`.act-btn`: *Send file / Send folder / Message*) are transparent with a `var(--border)` outline. In dark that border is **1.36:1** against the page background — the controls are effectively invisible. They also do not share `.btn`'s hover/active/disabled/focus behaviour. | `App.svelte:1183` |
| D6 | `.history-keep` sets `color: var(--muted)` — a variable that does not exist, so the label inherits an unintended colour. | `App.svelte:1084` |
| D7 | State/border/focus colours are ad hoc: `#2ecc71`, `#1f9d55`, `#4ade80`, `#16a34a`, `#2563eb`, `#d97706`, `rgba(46,204,113,…)` are literal in three files; several fail 4.5:1 for text in one of the two themes (`#16a34a` 3.30:1 on white, `#d97706` 3.19:1 on white, `#2563eb` 3.46:1 on dark, `#1f9d55` 3.49:1 on white). | `App.svelte`, `CrossPage.svelte` |
| D8 | `.btn`'s resting border is `var(--border)`: 1.27:1 in light, 1.36:1 in dark — below the 3:1 WCAG 1.4.11 floor for control boundaries. | `app.css:188` |
| D9 | The global `:focus-visible` rule sets `border-radius: 3px` on the *element*, squaring off rounded controls while they are focused. | `app.css:169-173` |
| D10 | `CrossPage` renders `class="card focus"`, but no `.focus` rule exists anywhere — a dead state class on the page's primary surface. | `CrossPage.svelte:55,64` |

## 3. Scope

**In scope (the only files this batch may touch):**

- `web/src/app.css`
- `web/src/App.svelte`
- `web/src/lib/CrossPage.svelte`
- `web/src/lib/OfflinePage.svelte`
- `web/src/lib/MessagePanel.svelte`
- focused web tests, only if needed
- this spec

**Out of scope (batch 1 constraints):** typography reset, navigation redesign, icon
replacement, `main` container-width redesign, macOS/native changes, i18n copy
changes, protocol/behaviour changes, unrelated cleanup. Pages outside the list above
(`AppsPage`, `PricingPage`, `MePage`, `CliPage`, `Account`, legal/static pages…) are
**not** migrated in this batch. The existing global `.btn` contract is intentionally
strengthened for every consumer, so those pages receive its clearer control border,
disabled-state guards and coarse-pointer target floor without adopting the new surface
primitives. Representative shared-button consumers are included in visual regression.

## 4. Naming rule for globals

`AppsPage.svelte`, `PricingPage.svelte`, `PlanCard.svelte` and `HowToSteps.svelte`
already use the bare class names `.card` and `.badge` with *different* meanings, and
they are outside this batch's permitted files. Introducing global `.card` / `.badge`
would silently restyle them.

Therefore:

1. **New** global primitives take a `ui-` prefix: `.ui-card`, `.ui-card-raised`,
   `.ui-badge`, `.ui-callout`, `.ui-page-head`, `.ui-card-head`, `.ui-card-sub`.
   The prefix is the contract — nothing gets these styles by accident.
2. **Existing** global names keep their names (`.btn*`, `.progress-*`,
   `.file-pick-input`), because they are already an established contract.
3. Two names are promoted to global *without* a prefix, `.sas` and `.path`, because
   `MessagePanel.test.ts` and `web/e2e/lan-transfer.mjs` select on them and renaming
   would break the test contract. Both were grepped: `App.svelte` and
   `MessagePanel.svelte` are their only users in the repo.
4. `.dot` is **not** promoted — `Hero`, `MePage` and `CliPage` use `.dot` for
   unrelated things. The rule is written as `.path .dot`, bound to its parent.
5. State classes are only ever written compounded — `.ui-card.active`,
   `.ui-card.ok`, `.ui-card.bad`, `.btn.is-disabled` — never bare. `ok` / `bad`
   keep their short spellings because `App.svelte` already emits them and
   `web/e2e/lan-transfer.mjs` selects `.xfer.bad`; compounding is what makes the
   short names safe.
6. No new bare element selectors. The only element rules added are bound to a
   `ui-` contract, and the ones that could reach into a *child component* are
   bound to a direct child: `.ui-card > h2`, `.ui-card-head > h2`, `.sas code`,
   `.ui-page-head h1`.

## 5. Tokens (`app.css`)

All tokens are declared in the light `:root` block and overridden in **both** dark
blocks (`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and
`:root[data-theme="dark"]`), matching the file's existing "keep the two in sync"
contract. Purple brand (`--accent`, `--accent-deep`, `--grad-accent`) is unchanged.
No runtime dependencies are added.

### 5.1 Control surfaces

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `--control-bg` | `#faf9f6` | `#23252f` | Resting fill of a neutral control (`.btn`, textarea). |
| `--control-border` | `#8b8792` | `#6b7280` | Resting boundary of an interactive control. |
| `--control-border-hover` | `var(--accent)` | `var(--accent)` | Hover/active boundary. |

Measured non-text contrast (WCAG 1.4.11 floor 3:1):

- light `#8b8792` vs `#ffffff` = **3.51:1**; vs `--surface-2` `#faf9f6` = **3.34:1**
- dark `#6b7280` vs `#16171d` = **3.70:1**; vs `--surface` `#1c1d25` = **3.47:1**
- hover: light `#aa3bff` vs white = **4.40:1**; dark `#c084fc` vs `#16171d` = **6.31:1**

`--border` keeps its current value and its current job: **non-interactive** dividers,
card edges, table rules. It is deliberately *not* raised to 3:1 — card edges are
decorative and raising it would change every page in the app.

### 5.2 Surfaces

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `--callout-bg` | `var(--surface-2)` | `var(--surface-2)` | Neutral inset note. |
| `--callout-border` | `var(--border)` | `var(--border)` | Its edge. |
| `--shadow-card` | `0 1px 2px rgb(0 0 0 / .04), 0 10px 24px -18px rgb(0 0 0 / .30)` | `0 1px 2px rgb(0 0 0 / .30), 0 10px 24px -18px rgb(0 0 0 / .60)` | `.ui-card-raised` elevation. Neutral — replaces the accent-tinted shadow. |

### 5.3 Focus

| Token | Value | Purpose |
|-------|-------|---------|
| `--focus` | `var(--accent)` | Ring colour, both themes. |
| `--focus-width` | `2px` | |
| `--focus-offset` | `2px` | |

The global `:focus-visible` rule keeps its 2px solid ring and 2px offset (D9's stray
`border-radius: 3px` is dropped so the ring follows each control's own radius).

### 5.4 Status

| Token | Light | Dark |
|-------|-------|------|
| `--ok` | `#15803d` (5.01:1 on white; 4.53:1 on the composited `--ok-bg` badge fill) | `#4ade80` (10.3:1 on `#16171d`) |
| `--ok-bg` | `rgb(34 197 94 / .12)` | `rgb(74 222 128 / .14)` |
| `--ok-border` | `rgb(21 128 61 / .45)` | `rgb(74 222 128 / .42)` |
| `--danger` | `#c0392b` (5.44:1 on white) — unchanged | `#ff6b6b` (6.44:1) — unchanged |
| `--danger-bg` | `rgb(192 57 43 / .10)` | `rgb(255 107 107 / .14)` |
| `--danger-border` | `rgb(192 57 43 / .45)` | `rgb(255 107 107 / .45)` |
| `--path-lan` | `#15803d` (5.01:1) | `#4ade80` (10.3:1) |
| `--path-p2p` | `#2563eb` (5.17:1) | `#60a5fa` (7.03:1) |
| `--path-relay` | `#b45309` (5.02:1) | `#fbbf24` (10.7:1) |

Every status colour used as **text** now clears 4.5:1 in the theme it applies to;
the previous literals failed in one theme each (D7).

## 6. Primitives (`app.css`)

### 6.1 Cards

```
.ui-card          border 1px var(--border), radius var(--radius),
                  background var(--surface), padding var(--space-4) var(--space-5)
.ui-card > h2     font-size var(--fs-h3); margin 0        (direct child only)
.ui-card-raised   padding var(--space-5); box-shadow var(--shadow-card)
.ui-stack         flex column, gap var(--space-3)          (content-card rhythm)
.ui-card.active   border-color var(--accent-border)        ← replaces dead `.focus` (D10)
.ui-card.ok       border-color var(--ok)
.ui-card.bad      border-color var(--danger-border)
```

`.ui-stack` is separate from `.ui-card` because App's status cards lay themselves
out and only the page-level content cards (Cross, Offline, MessagePanel) want the
vertical stack.

`.ui-card` carries **no margin** — spacing is the caller's layout concern (grid gap
on Cross/Offline, a stacked `margin-block-end` in App/MessagePanel).

Restraint rule (requirement 7): a card's default is neutral. Accent appears only on
`.active` (the live session card) and on the incoming-request card, which asks for
a decision. The previous accent-tinted drop shadow on *every* Cross/Offline card is
removed.

### 6.2 Buttons

Existing `.btn` / `.btn-primary` / `.btn-ghost` / `.btn-link` keep their names and
roles. Changes and additions:

```
.btn              background var(--control-bg); border 1px var(--control-border)   ← D8
.btn:not(:disabled):not(.is-disabled):not(.disabled):hover
                                  border-color var(--control-border-hover); box-shadow var(--shadow)
.btn:not(:disabled):not(.is-disabled):not(.disabled):active
                                  transform translateY(1px)
.btn:disabled,
.btn.is-disabled,
.btn.disabled     opacity .55; cursor not-allowed; no hover/active/variant effect
.btn-secondary    explicit alias of the neutral control (same as bare .btn)
.btn-sm           font-size var(--fs-xs); padding 7px 10px
.btn-block        flex 1 1 auto; inline-size 100%
@media (pointer: coarse) { .btn { min-block-size: 44px } }
```

`.is-disabled` exists because two of the three peer action controls are `<label>`
elements (they wrap a hidden file input) and `:disabled` never matches a label.

The coarse-pointer 44px rule moves from two component copies to one global rule, so
every `.btn` — including ones added later — satisfies the touch-target minimum.

### 6.3 Badges

```
.ui-badge      pill; font-size 11.5px; color var(--text);
               background var(--code-bg); border 1px var(--border)
.ui-badge-ok   color var(--ok); background var(--ok-bg); border-color var(--ok-border)
```

Theme-aware via tokens only — no `prefers-color-scheme` block (D4).

### 6.4 Callouts

```
.ui-callout          radius var(--radius-sm); padding var(--space-2) var(--space-3);
                     background var(--callout-bg); border 1px var(--callout-border);
                     color var(--text); font-size var(--fs-xs); line-height 1.5
.ui-callout-accent   background var(--accent-bg); border-color var(--accent-border)
.ui-callout-danger   background var(--danger-bg); border-color var(--danger-border);
                     color var(--text-h)
```

Assignment:

| Message | Treatment | Why |
|---------|-----------|-----|
| text availability / privacy hint | `.ui-callout` (neutral) | Passive information — requirement 7 says this one is the shared callout, and accent is reserved for state. |
| queued-share pending | `.ui-callout` | Informational. |
| confirm-before-send bar | `.ui-callout .ui-callout-accent` | Demands a decision — a state. |
| relay-quota failure note | `.ui-callout` | Explanatory body inside an already-failed card. |
| unsupported-browser banner | `.ui-callout .ui-callout-danger` | A hard failure; was accent-tinted, which read as an ad. |

### 6.5 Verification code (`.sas`) and connection path (`.path`)

```
.sas          font-size var(--fs-sm); padding var(--space-2) var(--space-3);
              radius var(--radius-sm); background var(--accent-bg);
              border 1px var(--accent-border)
.sas code     mono; 16px; weight 700; letter-spacing .1em; transparent background
.path         inline-flex; gap 5px; white-space nowrap
.path .dot    7px circle, currentColor, dot-pulse animation
.path-lan/-p2p/-relay   color: var(--path-*)
```

SAS is accent-tinted in both places now (it *is* a security state, and the panel copy
previously rendered as plain body text). `dot-pulse` is disabled under
`prefers-reduced-motion`, as it already was.

### 6.6 Page/card header helpers (kills D3)

```
.ui-page-head            text-align center; padding-block var(--space-3) var(--space-5)
.ui-page-head h1         34px; margin 0 0 var(--space-2); letter-spacing -1px
.ui-page-head .tagline   var(--fs-body); max-inline-size 44ch; margin-inline auto
.ui-page-head .pitch     var(--fs-xs); max-inline-size 52ch; line-height 1.55
.ui-card-head            flex row, wrap, title + trailing badge
.ui-card-head > h2       var(--fs-h3); margin 0; margin-inline-end auto
.ui-card-sub             var(--fs-xs); var(--text); line-height 1.5
```

## 7. Migration map

### `App.svelte`
- `class="card request|xfer|history"` → `class="ui-card …"`; local `.card` block deleted.
- `.card.ok/.bad` → `.ui-card.ok/.bad` (global); `#2ecc71` → `var(--ok)`; the
  success pulse animation stays local (it is App's, not the primitive's).
- `.act-btn` → `class="btn btn-secondary btn-sm btn-block"` + `class:is-disabled={busy}`;
  the whole `.act-btn` / `button.act-btn` block is deleted (D5).
- `button.x` (close / cancel) → `class="btn btn-sm x"`; `.x` keeps only its
  `margin-inline-start` and the cancel hover accent.
- `.text-availability`, `.share-pending`, `.quota-note` → `.ui-callout`;
  `.confirm-send` → `.ui-callout .ui-callout-accent`; `.banner.error` →
  `.ui-callout .ui-callout-danger`. Local rules keep only margin/layout.
- `.sas`, `.path`, `.path .dot`, `.path-*` local blocks deleted (now global).
- `.history-keep` `var(--muted)` → `var(--text)` (D6).
- `.peer` dashed drop target: `var(--border)` → `var(--control-border)` (it is an
  interactive target); `.empty` keeps `var(--border)` (it is a container).
- `.history-clear` drops its bespoke size in favour of `.btn-sm`.
- The component-scoped coarse-pointer block is removed entirely: all affected controls
  are `.btn`, so the global 44px minimum replaces it. The former extra horizontal
  padding on transfer close/cancel controls is intentionally not retained; target height
  remains 44px without widening compact controls.

### `MessagePanel.svelte`
- `class="card msgpanel"` → `class="ui-card ui-stack msgpanel"`; gains a real card, a
  correctly sized `<h2>`, a styled `.sas`, and a working `.path` dot (D1, D2).
- Local `.sas`, `.sas code` and the coarse-pointer block are deleted (global now).
- `textarea` border → `var(--control-border)`. A failed message keeps a solid
  `var(--danger)` edge and gains the localized `t.status.sendFail` label, so failure
  is not conveyed by colour alone.
- Keeps: `.msgpanel` flex layout, `.msg` grid, `.msg-body` `pre-wrap` /
  `overflow-wrap: anywhere`, `.byte-count`, `.sr-only`, and every class name the tests
  and e2e select on (`.msg`, `.msg-body`, `.byte-count`, `.sas code`, `.path`,
  `.path-lan`, `.state`, `.bad`, `button.send`, `button.copy`, `.act`, `.msgpanel`).

### `CrossPage.svelte`
- `.cn-head` → `.ui-page-head`; `.card` → `.ui-card .ui-card-raised .ui-stack`;
  `class="card focus"` → `class="ui-card ui-card-raised ui-stack active"` (D10);
  `.cardsub` → `.ui-card-sub`; `.mhead` → `.ui-card-head`;
  `.badge ok` → `.ui-badge .ui-badge-ok`.
- The `@media (prefers-color-scheme: dark)` block is deleted (D4).
- `.startover` → `class="btn btn-ghost btn-sm startover"`, local rule keeps only
  `align-self: center`.
- Keeps: `.cards` grid, `.foot`.

### `OfflinePage.svelte`
- Same header/card/badge migration; `.signin` and `.cli-note` layout kept.

## 8. Accessibility

- **Non-text contrast (1.4.11 ≥ 3:1):** control boundaries via `--control-border`
  (3.34–3.70:1 measured across both themes and all three surfaces). Focus ring
  4.40:1 (light) / 6.31:1 (dark) against the page background.
- **Text contrast (1.4.3 ≥ 4.5:1):** all status text tokens measured in §5.4;
  `--text` on `--surface`/`--control-bg` is unchanged (5.7:1 light, 7.0:1 dark).
- **Focus visible (2.4.7):** global `:focus-visible` retained; the ring now follows
  each control's radius. `label:has(> .file-pick-input:focus-visible)` retained
  verbatim — it is the only keyboard path to the file pickers.
- **Target size:** one global `@media (pointer: coarse) { .btn { min-block-size: 44px } }`
  replaces two component copies. Peer-action labels are `.btn`, so they grow under the
  same rule without a component-local exception.
- **Reduced motion:** existing `prefers-reduced-motion` blocks are preserved for
  `.reveal`, `.page-enter`, `.theme-anim`, `.progress-fill`, `.path .dot`,
  `.ui-card.ok`'s pop, and `.dropzone-inner`.
- **DOM semantics unchanged:** no element type, `role`, `aria-*`, `id`, `for`,
  `aria-describedby` or accessible name changes. Only `class` attributes move.
- **State is never colour-only:** the transfer card's ok/bad border accompanies an
  existing `aria-live` status string; a failed message shows `t.status.sendFail` in
  addition to its danger edge; the path badge's colour accompanies its label.

## 9. Responsive & RTL

- No breakpoint changes. `main`'s max width, the `.cards` 720px column and the peer
  grid's `minmax(240px, 1fr)` are untouched.
- Every declaration that this batch **adds or rewrites** uses logical properties
  (`padding-inline`, `margin-inline`, `inline-size`, `min-block-size`,
  `margin-block-end`, `border-inline-start`). Untouched declarations keep their
  existing form — rewriting them is out of scope for this batch.
- `dir="auto"` on message bodies and `dir(lang())` on `<html>` are untouched.

## 10. Acceptance matrix

| # | Check | How |
|---|-------|-----|
| A1 | `MessagePanel` renders as a real card (border, surface, padding, `--fs-h3` title). | Visual + `.ui-card` present in markup. |
| A2 | The path badge in `MessagePanel` shows a coloured pulsing dot identical to `App`'s. | `MessagePanel.test.ts` asserts `.path.path-lan` **and** that the badge contains a `.dot` (new assertion). |
| A2b | `MessagePanel`'s shell opts into the shared card. | New `MessagePanel.test.ts` case: root carries `.ui-card` and still renders an `<h2>`. |
| A3 | No `.card`, `.badge`, `.cardsub`, `.mhead`, `.cn-head`, `.sas`, `.path` rule remains duplicated in more than one file. | `grep` over the four components. |
| A4 | No `prefers-color-scheme` rule remains in `CrossPage`. | `grep`. |
| A5 | No `var(--muted)` remains anywhere in the four files. | `grep`. |
| A6 | Peer action controls are visible in dark: border ≥ 3:1, hover/active/disabled/focus identical to `.btn`. | Visual + token math in §5.1. |
| A7 | `svelte-check` passes with no new errors. | `cd web && npm run check` |
| A8 | Unit tests pass. | `cd web && npm test -- --run` |
| A9 | Production build succeeds. | `cd web && npm run build` |
| A10 | E2E selector contract intact: `.peer-actions button`, `.msgpanel .act button.btn-primary`, `.msgpanel .sas code`, `.msgpanel button.send`. | `grep` of `web/e2e/lan-transfer.mjs` selectors against the new markup. |
| A11 | New surface primitives do not leak into unrelated pages; the intentional global `.btn` change remains usable on representative shared consumers. | Confirm no unrelated source files changed; visually inspect `/pricing`, `/me`, `/cli`, and the Account surface in light/dark. |

Visual acceptance is explicitly **not** claimed here; browser regression is run
independently.

## 11. Non-goals / deferred

- Migrating `AppsPage`, `PricingPage`, `MePage`, `CliPage`, `Account`, `PlanCard`,
  `HowToSteps` onto `.ui-card` / `.ui-badge` (they keep their local `.card` / `.badge`
  until a later batch can verify them).

  > **Verified 2026-08-05 — migrate `AppsPage` and `PricingPage` only; the rest stay.**
  > Those two did adopt `.ui-card` and are the whole of the intended migration. Checking
  > the other five one rule at a time, the shared name is the only thing they share:
  >
  > - `HowToSteps .badge` is a 46×46 accent step marker with a hover transform;
  >   `PlanCard .badge` is an accent-tinted pill. `.ui-badge` is a neutral status chip
  >   (`--code-bg` on `--text`) with only an `-ok` variant — adopting it would repaint both.
  > - `MePage` and `Account` matched a grep for `border` + `border-radius`, not the card
  >   contract: a device row, a kind chip, a delete-status strip, a stat tile on
  >   `--social-bg`, a file row, a link button, a popover menu, an input, a toast.
  > - `CliPage .pick-card` / `.guide-card` are the closest — same border, radius and
  >   `--surface` — but they set `padding: var(--space-4)` where `.ui-card` sets
  >   `padding-inline: var(--space-5)`. On a card capped at 300px that is 16px of content
  >   width, so the swap is a layout change, not a cleanup.
  >
  > Do not re-open this as a mechanical cleanup. If `.ui-card`'s inline padding is ever
  > revisited, `.pick-card` and `.guide-card` are the two that would then fit it exactly.
- Raising `--border` itself to 3:1 (would repaint every page).
- Typography scale, nav, icons, container width, spacing scale.
- A form-control primitive (input/select/textarea) beyond the one textarea touched here.
- Deleting `--social-bg` / `--surface-2` duplication.

## 12. Reversibility

Every runtime change is CSS class movement plus additive tokens across six Web files;
the seventh file is this spec. No data, storage, protocol or API surface is involved.
