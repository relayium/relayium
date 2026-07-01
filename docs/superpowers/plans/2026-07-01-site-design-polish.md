# Site Design Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every Relayium surface to a "professional, clean, trustworthy" completeness bar (Aura Share level) by adding a shared design-token/pattern foundation and applying it consistently — generous whitespace, clear typographic hierarchy, restrained color, standardized hover/focus/drag states.

**Architecture:** A foundation-first approach. Phase 0 adds a spacing scale, type scale, global `:focus-visible` ring, and a shared `.btn` system to the single global stylesheet (`web/src/app.css`). Phases 1–4 migrate each surface off scattered magic numbers onto those tokens/classes, raise section rhythm to the new whitespace scale, and remove per-component button duplication. No framework, no webfonts, no elaborate animation — only subtle 120–150ms transitions.

**Tech Stack:** Svelte 5 (runes), Vite 8, TypeScript, plain CSS custom properties (global `app.css` + per-component `<style>` scoped blocks). Backend admin UI is Go `html/template` in `server/internal/account/admin_templates.go`.

## Global Constraints

- No new runtime dependencies. No webfonts. Keep `system-ui` font stack.
- No elaborate/keyframe animation. Transitions only, `120–150ms`, on hover/focus/active/drag.
- Preserve light + dark mode parity — every new color/token must resolve in both `:root` and the `prefers-color-scheme: dark` block.
- Every change must keep `npx svelte-check --tsconfig ./tsconfig.app.json` at **0 errors, 0 warnings** and `npx vitest run` **fully green**, and `npm run build` succeeding.
- Radii come from `--radius` / `--radius-sm` only. Spacing comes from the `--space-*` scale. Font sizes come from the `--fs-*` scale. No new bare pixel magic numbers for these three properties.
- Accent color and gradient stay: `--accent` (`#aa3bff` light / `#c084fc` dark), gradient `linear-gradient(135deg, var(--accent), #6d28d9)`.
- All commands run from `web/` unless the file path is under `server/`.
- Work directory: `/Users/lily/code/relayium/relayium`.

**Standard verification block** (referenced as "run the standard checks" in later tasks):
```bash
npx svelte-check --tsconfig ./tsconfig.app.json   # expect: 0 ERRORS 0 WARNINGS
npx vitest run                                     # expect: all tests passed
npm run build                                      # expect: built in ...
```

---

## File Structure

- `web/src/app.css` — global tokens + base element styles + new `.btn` system and `:focus-visible`. **Foundation; touched only in Phase 0.**
- `web/src/lib/Hero.svelte`, `FeatureStrip.svelte`, `UseCases.svelte`, `Faq.svelte`, `HowItWorks.svelte`, `ModeCompare.svelte`, `App.svelte` — home/landing surface. **Phase 1.**
- `web/src/lib/Nav.svelte`, `CrossPage.svelte`, `CodePairing.svelte`, `CrossNetwork.svelte`, `StoredUpload.svelte`, `DownloadPage.svelte` — transfer surfaces. **Phase 2.**
- `web/src/lib/Account.svelte` — auth modal. **Phase 3.**
- `server/internal/account/admin_templates.go` — internal admin UI. **Phase 4.**
- `web/src/lib/Counter.svelte` — scaffolding leftover; **out of scope** (verify unused, do not restyle).

---

## Phase 0 — Foundation (`web/src/app.css`)

### Task 0: Design tokens, focus ring, and shared button system

**Files:**
- Modify: `web/src/app.css`

**Interfaces:**
- Produces (consumed by all later phases):
  - Spacing tokens `--space-1: 4px` … `--space-9: 96px`.
  - Section rhythm token `--section-gap` (64px desktop, 48px ≤1024px).
  - Type tokens `--fs-display: 56px`, `--fs-h2: 30px`, `--fs-h3: 18px`, `--fs-sm: 14px`, `--fs-xs: 13px`.
  - Global `:focus-visible` outline using `--accent`.
  - Global classes: `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-link` (all live in global `app.css`, so any component can apply them via `class="btn btn-primary"`).

- [ ] **Step 1: Add the spacing scale + section-gap token to `:root`**

In `web/src/app.css`, inside `:root { … }`, replace the single `--space: 16px;` line with the full scale (keep `--space` as an alias so nothing breaks):

```css
  --space: 16px; /* legacy alias, prefer --space-4 */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --space-9: 96px;
  --section-gap: var(--space-8);
```

Then add, inside the existing `@media (max-width: 1024px) { :root { … } }` at the bottom of `:root` (the block that currently sets `font-size: 16px`), one extra line:

```css
    --section-gap: var(--space-7);
```

- [ ] **Step 2: Add the type scale tokens to `:root`**

Immediately after the `--radius-sm` line in `:root`, add:

```css
  --fs-display: 56px;
  --fs-h2: 30px;
  --fs-h3: 18px;
  --fs-sm: 14px;
  --fs-xs: 13px;
```

- [ ] **Step 3: Tighten body tracking and align headings to the scale**

In `:root`, change the body letter-spacing from `0.18px` to `0` (loose tracking is the current typography weakness):

```css
  letter-spacing: 0;
```

Update the global `h1` and `h2` rules to use the tokens and confident tracking:

```css
h1 {
  font-size: var(--fs-display);
  letter-spacing: -1.68px;
  line-height: 1.08;
  margin: var(--space-6) 0;
  @media (max-width: 1024px) {
    font-size: 36px;
    margin: var(--space-5) 0;
  }
}
h2 {
  font-size: var(--fs-h2);
  line-height: 1.15;
  letter-spacing: -0.4px;
  margin: 0 0 var(--space-2);
  @media (max-width: 1024px) {
    font-size: 24px;
  }
}
```

- [ ] **Step 4: Add the global focus ring**

At the end of `web/src/app.css`, add:

```css
/* Keyboard-focus ring — applies site-wide; the completeness gap vs. hover-only. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}
```

- [ ] **Step 5: Add the shared button system**

At the end of `web/src/app.css`, add:

```css
/* Shared button system. Components apply e.g. class="btn btn-primary" and drop
   their own bespoke button rules. Lives in global CSS so it crosses component
   scope boundaries. */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1;
  padding: 10px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-h);
  cursor: pointer;
  transition: border-color .13s, background .13s, box-shadow .13s, filter .13s, transform .05s;
}
.btn:hover { border-color: var(--accent-border); box-shadow: var(--shadow); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; transform: none; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { filter: brightness(1.07); box-shadow: var(--shadow); }
.btn-ghost { background: var(--social-bg); }
.btn-link {
  border: none; background: none; box-shadow: none;
  padding: var(--space-1); color: var(--text); text-decoration: underline;
}
.btn-link:hover { color: var(--text-h); box-shadow: none; border: none; }
```

- [ ] **Step 6: Run the standard checks**

```bash
npx svelte-check --tsconfig ./tsconfig.app.json   # 0 ERRORS 0 WARNINGS
npx vitest run                                     # all green
npm run build                                      # success
```

Expected: no errors. Visual regressions are expected/acceptable at this point (headings are now bigger site-wide); Phases 1–4 harmonize each surface.

- [ ] **Step 7: Visual smoke check (both themes)**

Launch the app (`/run` skill, or `npm run dev`) and load the home page in light and dark mode. Confirm: headings render larger, no layout breakage, focus ring appears when tabbing to a button/link. This is a smoke check, not the polish pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/app.css
git commit -m "feat(web): design foundation — spacing/type scales, focus ring, .btn system"
```

---

## Phase 1 — Home / landing surface

Apply the foundation to the marketing + home page. The goal per component: adopt `--section-gap` between sections, replace hardcoded font sizes with `--fs-*`, replace hardcoded margins/paddings with `--space-*`, replace bespoke button rules with `.btn` classes, and apply the restraint principle (not every block boxed).

### Task 1: `App.svelte` home layout rhythm + buttons

**Files:**
- Modify: `web/src/lib/App.svelte` (styles block ~lines 598–744; markup buttons at `.crosscta` ~line 578, request/xfer actions ~lines 504–505, 516)

**Interfaces:**
- Consumes: `--section-gap`, `--space-*`, `--fs-*`, `.btn`/`.btn-primary`/`.btn-ghost` from Task 0.

- [ ] **Step 1: Raise section rhythm.** In the `<style>` block, change the top-level section spacings to the token. Specifically: `.guide { margin: var(--section-gap) 0 var(--space-5); }`, `.crosscta { margin: var(--section-gap) 0 var(--space-2); … }`, `.peers { margin-top: var(--space-7); }`. Keep internal paddings but convert bare px to nearest `--space-*` (e.g. `.crosscta` padding `22px 24px` → `var(--space-5) var(--space-6)`).

- [ ] **Step 2: Convert marketing button.** The `.crosscta` CTA and the request card actions currently use scoped `button.primary` / `.ghost`. In the markup, change `<button class="primary" …>` → `<button class="btn btn-primary" …>` and `<button class="ghost" …>` → `<button class="btn btn-ghost" …>` for the crosscta CTA (line ~578), the request accept/decline (lines ~504–505). Leave the transfer-progress close `✕` button as a small bespoke control but give it `:focus-visible` coverage (already global).

- [ ] **Step 3: Remove now-dead scoped button rules.** Delete the scoped `button`, `button:hover`, `button:active`, `button.primary`, `button.primary:hover` rules (App.svelte lines ~664–672) **only if** no remaining markup uses bare `class="primary"`. Grep first: `grep -n 'class="primary"\|class="ghost"' web/src/lib/App.svelte`. Keep `button.x` (the close control) scoped.

- [ ] **Step 4: Normalize section heading sizes.** Remove local `h2` font-size overrides that fight the new global `--fs-h2` where a marketing-level heading is intended (e.g. `.peers h2 { font-size: 20px; }` can stay as a deliberately smaller sub-heading — that is fine; the rule is *intentional* sizing, not removing all overrides). Convert any remaining bare px font-sizes in this block to `--fs-*` or an explicit intentional value with a comment.

- [ ] **Step 5: Run the standard checks.** Expect 0 errors, green, build ok.

- [ ] **Step 6: Visual check.** `/run`; load home in light+dark. Confirm sections breathe more, buttons consistent, hover + focus states work.

- [ ] **Step 7: Commit.**
```bash
git add web/src/lib/App.svelte
git commit -m "polish(web): home layout rhythm + shared buttons"
```

### Task 2: `Hero.svelte`

**Files:**
- Modify: `web/src/lib/Hero.svelte`

- [ ] **Step 1: Adopt tokens.** Convert `.hero { padding-top: 44px; }` → `padding-top: var(--space-9);` (desktop breathing room) and the `@media` override to `var(--space-7)`. Convert `.tagline { font-size: 15.5px; }` → `font-size: var(--fs-body, 17px);` (use `--fs-sm` if 14 is intended — pick 17 for a confident tagline), `margin` bare px → `--space-*`. Convert `.statusbar { font-size: 14px; margin-top: 18px; padding: 6px 14px; }` → `font-size: var(--fs-sm); margin-top: var(--space-4); padding: var(--space-2) var(--space-4);`.
- [ ] **Step 2: Keep the gradient logo tile and 46px H1** (Hero H1 is a scoped override of the global — intentional, leave it, but confirm it reads well next to the new global scale). If it now looks small vs. global `--fs-display`, bump to `var(--fs-display)` on desktop.
- [ ] **Step 3: Run the standard checks.**
- [ ] **Step 4: Visual check** (light+dark).
- [ ] **Step 5: Commit.**
```bash
git add web/src/lib/Hero.svelte
git commit -m "polish(web): hero spacing + type tokens"
```

### Task 3: Marketing sections — `FeatureStrip.svelte`, `UseCases.svelte`, `Faq.svelte`, `HowItWorks.svelte`, `ModeCompare.svelte`

**Files:**
- Modify: `web/src/lib/FeatureStrip.svelte`, `web/src/lib/UseCases.svelte`, `web/src/lib/Faq.svelte`, `web/src/lib/HowItWorks.svelte`, `web/src/lib/ModeCompare.svelte`

**Interfaces:**
- Consumes: `--section-gap`, `--space-*`, `--fs-*`.

Apply the same mechanical transformation to each file (they share the `.wrap { margin } / .head { h2 + sub } / grid of cards` shape seen in `FeatureStrip.svelte`):

- [ ] **Step 1: Section outer margin.** Change each section's outer wrapper margin (e.g. FeatureStrip `.wrap { margin: 40px 0 8px; }`) → `margin: var(--section-gap) 0 var(--space-2);`.
- [ ] **Step 2: Heading + sub.** Change `.head h2 { font-size: 22px; }` → remove the override so it inherits global `--fs-h2` (30px) **or** set `font-size: var(--fs-h2)` explicitly. Change `.head { margin-bottom: 18px; }` → `var(--space-5)`. Change `.head .sub { font-size: 14px; }` → `var(--fs-sm)`; keep `max-width: 60ch`.
- [ ] **Step 3: Card grid gap + padding.** Change card `gap: 12px` → `var(--space-3)` (or `var(--space-4)` for more air), card `padding: 16px 18px` → `var(--space-4) var(--space-5)`, card `border-radius` bare px → `var(--radius)`. Card `h3 { font-size: 15px }` → `var(--fs-sm)` or keep 15 intentionally; card `p { font-size: 13.5px }` → `var(--fs-xs)`.
- [ ] **Step 4: Restraint pass.** For sections that currently box every item AND sit adjacent to another boxed section, consider dropping the card border on one (e.g. FAQ items as border-bottom dividers instead of full boxes) to reduce visual noise. Judgement call per section; document the choice in the commit message. Do not over-flatten — keep enough structure to scan.
- [ ] **Step 5: Repeat Steps 1–4 for all five files.**
- [ ] **Step 6: Run the standard checks.**
- [ ] **Step 7: Visual check** — scroll the whole home page in light+dark; confirm consistent section rhythm and heading scale top-to-bottom.
- [ ] **Step 8: Commit.**
```bash
git add web/src/lib/FeatureStrip.svelte web/src/lib/UseCases.svelte web/src/lib/Faq.svelte web/src/lib/HowItWorks.svelte web/src/lib/ModeCompare.svelte
git commit -m "polish(web): marketing sections — rhythm, type scale, restraint"
```

---

## Phase 2 — Transfer surfaces

### Task 4: `Nav.svelte`

**Files:**
- Modify: `web/src/lib/Nav.svelte`

- [ ] **Step 1:** Convert `.topnav { padding: 14px 0 10px; }` → `var(--space-4) 0 var(--space-3)`. Convert `.tab { font-size: 14px; padding: 7px 14px; }` → `font-size: var(--fs-sm); padding: var(--space-2) var(--space-4);`. Convert `.lang { font-size: 13px; padding: 5px 28px 5px 10px; }` → `font-size: var(--fs-xs);` keep the asymmetric padding for the select chevron.
- [ ] **Step 2:** The `.tab.active` and `.lang` already hover; global `:focus-visible` now covers keyboard focus. No extra work.
- [ ] **Step 3: Run the standard checks.**
- [ ] **Step 4: Commit.**
```bash
git add web/src/lib/Nav.svelte
git commit -m "polish(web): nav spacing + type tokens"
```

### Task 5: `CrossPage.svelte`, `CodePairing.svelte`, `CrossNetwork.svelte`, `StoredUpload.svelte`

**Files:**
- Modify: `web/src/lib/CrossPage.svelte`, `web/src/lib/CodePairing.svelte`, `web/src/lib/CrossNetwork.svelte`, `web/src/lib/StoredUpload.svelte`

**Interfaces:**
- Consumes: `.btn` system, `--space-*`, `--fs-*`, `--radius*`.

- [ ] **Step 1: Buttons.** In each file, replace bespoke button classes with `.btn` variants: primary action → `class="btn btn-primary"`, secondary → `class="btn btn-ghost"`, text button → `class="btn-link"`. Then delete the now-unused scoped `.primary/.ghost/button {…}` rules in that file (grep the file for the old class before deleting). `StoredUpload.svelte` copy/link buttons and `.pick` dropzone: keep `.pick` (it is a file-drop affordance, not a button) but convert its bare px to tokens.
- [ ] **Step 2: Spacing + type.** Convert bare px `font-size`/`margin`/`padding`/`border-radius` to `--fs-*` / `--space-*` / `--radius*` throughout each `<style>` block. Keep intentional one-off sizes (e.g. the pairing-code display `code` size) with an explanatory comment.
- [ ] **Step 3: StoredUpload `.expiry`** (added in prior work) — align to `--fs-xs` and `--space-*`.
- [ ] **Step 4: Run the standard checks.**
- [ ] **Step 5: Visual check** — open the cross-network page, generate a pairing code and a download link; confirm buttons/spacing consistent, focus rings present, light+dark ok.
- [ ] **Step 6: Commit.**
```bash
git add web/src/lib/CrossPage.svelte web/src/lib/CodePairing.svelte web/src/lib/CrossNetwork.svelte web/src/lib/StoredUpload.svelte
git commit -m "polish(web): cross-network surfaces — shared buttons + tokens"
```

### Task 6: `DownloadPage.svelte` alignment

**Files:**
- Modify: `web/src/lib/DownloadPage.svelte`

- [ ] **Step 1:** Convert the button `button.primary` (scoped) → markup `class="btn btn-primary"` and delete the scoped `button.primary` rule. Convert bare px in `.dlnav`, `.dl`, `.trust`, `.burn`, `.expiry`, `.sendcta`, `footer` to `--space-*` / `--fs-*` / `--radius*`. The `.trust`/`.burn` callout boxes: keep their accent/code backgrounds, standardize padding to `var(--space-3) var(--space-4)` and radius to `var(--radius-sm)`.
- [ ] **Step 2: Run the standard checks.**
- [ ] **Step 3: Visual check** — load a download link (light+dark), confirm the page matches the rest of the site's rhythm.
- [ ] **Step 4: Commit.**
```bash
git add web/src/lib/DownloadPage.svelte
git commit -m "polish(web): download page — align to foundation"
```

---

## Phase 3 — Account modal

### Task 7: `Account.svelte`

**Files:**
- Modify: `web/src/lib/Account.svelte`

**Interfaces:**
- Consumes: `.btn` system, `--space-*`, `--fs-*`, `--radius*`.

- [ ] **Step 1: Buttons.** Replace the scoped `.menu .primary`, `.menu .ghost`, `.menu .link` with `.btn btn-primary`, `.btn btn-ghost`, `.btn-link` in markup (lines ~137–172). NOTE: the current `.primary` uses `background: var(--text-h)` (dark on light) — switching to `.btn-primary` makes it accent-purple, unifying it with the rest of the site. Confirm this is desired (it is, per the design direction). Delete the dead scoped button rules.
- [ ] **Step 2: Inputs + spacing.** Convert `.menu input { padding: 8px 10px; border-radius: 8px; }` → `padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);`. Add a focus style relying on global `:focus-visible` (inputs already get it). Convert `.modal { padding: 22px 20px 20px; border-radius: 16px; }` → `padding: var(--space-5); border-radius: var(--radius);`. Convert `.menu { gap: 8px }` → `var(--space-2)` (or `--space-3` for more air).
- [ ] **Step 3: Error color token.** The `.err { color: #c00 }` is an un-tokenized magic color. Add a `--danger` token to `app.css` `:root` (`--danger: #c0392b;`) and its dark-mode value (`--danger: #ff6b6b;`), then use `color: var(--danger)`. (This is a small addendum to Phase 0's file — acceptable as it is discovered during Account work; commit it with this task.)
- [ ] **Step 4: Run the standard checks.**
- [ ] **Step 5: Visual check** — open the account modal signed-out (login/register) and signed-in (change password / logout), light+dark. Confirm buttons match site, focus rings on inputs/buttons, modal spacing comfortable.
- [ ] **Step 6: Commit.**
```bash
git add web/src/lib/Account.svelte web/src/app.css
git commit -m "polish(web): account modal — unified buttons, tokens, --danger"
```

---

## Phase 4 — Admin (internal)

### Task 8: `admin_templates.go` clean utilitarian pass

**Files:**
- Modify: `server/internal/account/admin_templates.go`

**Interfaces:**
- This is a standalone Go `html/template` document with its own inline `<style>` (it does not import `app.css`). Goal is a clean, consistent internal tool — not full brand parity. Mirror the *values* (spacing rhythm, restrained borders, one accent) rather than importing the SPA tokens.

- [ ] **Step 1: Read the file** to see the current inline styles and structure (dashboard cards + user table + settings form).
- [ ] **Step 2: Introduce a small inline token block** at the top of the template `<style>`: a few CSS variables (`--adm-space`, `--adm-border`, `--adm-accent: #aa3bff`, radius) and apply them for consistent padding, borders, and a single accent on primary actions/headings.
- [ ] **Step 3: Table + form polish.** Consistent cell padding, zebra or bottom-border rows, aligned numeric columns (metric cards), comfortable form control sizing, a clear primary submit button. No JS, no animation.
- [ ] **Step 4: Build the server** to ensure the template still parses and renders:
```bash
cd server && go build ./... && go test ./internal/account/ 2>&1 | tail -5
```
Expect: build ok, admin tests pass.
- [ ] **Step 5: Visual check.** Run the server, load the admin dashboard + user list + settings; confirm it reads as a clean internal tool. (Admin login required — see existing admin test/setup for credentials.)
- [ ] **Step 6: Commit.**
```bash
git add server/internal/account/admin_templates.go
git commit -m "polish(admin): consistent spacing, tokens, table/form styling"
```

---

## Final integration

### Task 9: Whole-site pass + merge

- [ ] **Step 1: Full-site visual review.** With the app running, walk every surface in **both** light and dark: home (all sections), cross-network (pairing + download-link generation), a download link page, account modal (all states), admin. Check the six rubric dimensions: hierarchy, color, typography, whitespace, interaction feedback (hover+focus+drag), mobile (resize to ~380px width). Note any inconsistency and fix inline (small follow-up commits).
- [ ] **Step 2: Run the full standard checks one final time.** 0 errors, green, build ok.
- [ ] **Step 3: Merge to main.** Per repo convention, work happened on a branch; merge with `--no-ff` and push:
```bash
git checkout main
git merge --no-ff <feature-branch> -m "Merge: site-wide design polish to completeness bar"
git push origin main
```

---

## Self-Review

**Spec coverage:**
- Whitespace ⭐ target → Phase 0 `--section-gap` + Phases 1–3 apply it. ✅
- Typography → Phase 0 `--fs-*` scale + tracking fix; applied per surface. ✅
- Color/restraint → tokens kept; Task 3 Step 4 restraint pass; `--danger` token added. ✅
- Interaction feedback (hover/focus/drag) → Phase 0 `:focus-visible` + `.btn` states; drag states already exist and are preserved. ✅
- Mobile → Task 9 Step 1 explicit 380px check; existing breakpoints preserved. ✅
- Whole-site scope incl. account + admin → Phases 3 + 4. ✅

**Placeholder scan:** Phase 0 contains exact CSS. Phases 1–4 give exact token/class mappings and per-file transformation rules; where pixel-exact values require judgement (restraint pass, intentional one-off sizes), the rule and decision-recording are specified rather than left as "TBD". Verification commands are exact.

**Type/name consistency:** Token names (`--space-1..9`, `--section-gap`, `--fs-display/h2/h3/sm/xs`, `--danger`) and class names (`.btn`, `.btn-primary`, `.btn-ghost`, `.btn-link`) are defined in Task 0 (and `--danger` in Task 7 Step 3) and referenced identically throughout. ✅

**Note on granularity:** CSS/design tasks are verified by typecheck + test-suite-stays-green + build + visual inspection rather than new unit tests (no new logic is introduced; the one pure helper `formatRemaining` already has tests). This is a deliberate, documented deviation from the TDD step pattern, appropriate for a styling-only plan.
