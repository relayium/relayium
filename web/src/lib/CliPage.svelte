<script lang="ts">
  import { onMount } from "svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, PRICING_PATH, DEVICE_INBOX_PATH } from "./router.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import ContentsRail from "./cli/ContentsRail.svelte";
  import InstallBand from "./cli/InstallBand.svelte";
  import TaskBranches from "./cli/TaskBranches.svelte";
  import ModeSection from "./cli/ModeSection.svelte";
  import ModeComparison from "./cli/ModeComparison.svelte";
  import GuideList from "./cli/GuideList.svelte";
  import FlagTable from "./cli/FlagTable.svelte";
  import FaqList from "./cli/FaqList.svelte";
  import {
    CLI_REPO,
    LATEST_RELEASE_URL,
    CLI_MODES,
    TRUST_FILES,
    SECTIONS,
    COMMANDS,
    copyProps,
    type SectionKey,
  } from "./cli-page-data";

  const t = $derived<Messages>(messages[lang()]);
  const cli = $derived(t.cliPage);

  const sectionId = Object.fromEntries(SECTIONS.map((s) => [s.key, s.id])) as Record<
    SectionKey,
    string
  >;
  const mode = Object.fromEntries(CLI_MODES.map((m) => [m.key, m])) as Record<
    (typeof CLI_MODES)[number]["key"],
    (typeof CLI_MODES)[number]
  >;

  // Land on the section the link named, not on the top of a long page — and take
  // focus with the scroll.
  //
  // The browser's own fragment handling cannot do the first part on load: the
  // SPA shell's <body> is empty when the document loads, so `#device-inbox` does
  // not exist at the moment Chrome looks for it, and it gives up. Verified in a
  // real browser (e2e/device-discovery.mjs) — before this, My Devices' "set up a
  // device inbox" link dropped the reader at the install instructions, which is
  // the same place they were already lost.
  //
  // It cannot do the second part at all. Scrolling alone leaves a keyboard or
  // screen-reader user at the document start while the sighted view has jumped:
  // the next Tab would go to the nav, not into what they asked to read.
  //
  // No smooth scrolling: `scrollIntoView` is left at its instant default, so
  // there is no motion to suppress under prefers-reduced-motion.
  function focusTarget(target: HTMLElement) {
    target.setAttribute("tabindex", "-1");
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }

  // In-page rail/branch clicks. The href stays a real "#id" so the link works
  // with no JavaScript and can be copied or opened in a new tab; this handler
  // only adds the focus move, and keeps the URL in step without pushing a
  // history entry per anchor click.
  function focusSection(event: MouseEvent, id: string) {
    const target = document.getElementById(id);
    if (!target) return; // let the browser try
    event.preventDefault();
    history.replaceState(history.state, "", `#${id}`);
    focusTarget(target);
  }

  onMount(() => {
    const id = location.hash.slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    focusTarget(target);
  });
</script>

<div class="cli page-enter">
  <header class="hero">
    <h1>Relayium CLI</h1>
    <p class="support">{cli.heroSupport}</p>
  </header>

  <div class="layout">
    <ContentsRail
      labels={cli.sections}
      ariaLabel={cli.contentsLabel}
      onNavigate={focusSection}
    />

    <!-- A <div>, not a <main>: App.svelte's shell already owns this page's one
         <main>, so a second one here nested two "main" landmarks — axe's
         landmark-unique, and a reader with two indistinguishable "skip to the
         content" targets. This element is layout only (it carries the grid
         column's `min-inline-size: 0`); every section inside it keeps its own
         <section>/heading, so nothing that was announced stops being announced. -->
    <div class="body">
      <InstallBand {cli} id={sectionId.install} />

      <TaskBranches {cli} id={sectionId.tasks} onNavigate={focusSection} />

      <section class="band" id={sectionId.modes} aria-labelledby="cli-modes-h">
        <h2 id="cli-modes-h">{cli.sections.modes}</h2>
        <ModeComparison {cli} />
        <p class="lead spaced">{cli.modesIntro}</p>

        <ModeSection {cli} lang={lang()} mode={mode.cloud}>
          <CommandBlock
            code={COMMANDS.cloudLogin.code}
            title={COMMANDS.cloudLogin.name}
            {...copyProps(cli.copy, COMMANDS.cloudLogin.name)}
          />
          <CommandBlock
            code={COMMANDS.cloudUp.code}
            title={COMMANDS.cloudUp.name}
            {...copyProps(cli.copy, COMMANDS.cloudUp.name)}
          />
          <CommandBlock
            code={COMMANDS.cloudDown.code}
            title={COMMANDS.cloudDown.name}
            {...copyProps(cli.copy, COMMANDS.cloudDown.name)}
          />
        </ModeSection>

        <ModeSection {cli} lang={lang()} mode={mode.inbox} featured>
          <h4>{cli.inbox.stepsLabel}</h4>
          <ol class="steps">
            {#each cli.inbox.steps as step, i (step.label)}
              <li>
                <strong>{step.label}</strong>
                {step.body}
                {#if i === 0}
                  <CommandBlock
                    code={COMMANDS.inboxUpdate.code}
                    title={COMMANDS.inboxUpdate.name}
                    {...copyProps(cli.copy, COMMANDS.inboxUpdate.name)}
                  />
                {:else if i === 1}
                  <CommandBlock
                    code={COMMANDS.inboxLogin.code}
                    title={COMMANDS.inboxLogin.name}
                    {...copyProps(cli.copy, COMMANDS.inboxLogin.name)}
                  />
                {:else if i === 2}
                  <CommandBlock
                    code={COMMANDS.inboxEnable.code}
                    title={COMMANDS.inboxEnable.name}
                    {...copyProps(cli.copy, COMMANDS.inboxEnable.name)}
                  />
                {:else}
                  <!-- /device-inbox, not /me: the send controls are on the
                       Device Inbox page itself, and My Devices is where a
                       credential is renamed or revoked. Sending someone to /me
                       to send a file would be one more hop to reach the thing
                       this step is describing. -->
                  <p class="cta">
                    <a
                      href={DEVICE_INBOX_PATH}
                      onclick={(e) => {
                        e.preventDefault();
                        navigate("device-inbox");
                      }}
                    >
                      {cli.inbox.cta}
                    </a>
                  </p>
                  <p class="hint">{cli.inbox.ctaHint}</p>
                {/if}
              </li>
            {/each}
          </ol>
          <CommandBlock
            code={COMMANDS.inboxService.code}
            title={COMMANDS.inboxService.name}
            {...copyProps(cli.copy, COMMANDS.inboxService.name)}
          />
        </ModeSection>

        <ModeSection {cli} lang={lang()} mode={mode.text}>
          <CommandBlock
            code={COMMANDS.textPair.code}
            title={COMMANDS.textPair.name}
            {...copyProps(cli.copy, COMMANDS.textPair.name)}
          />
          <CommandBlock
            code={COMMANDS.textPipe.code}
            title={COMMANDS.textPipe.name}
            {...copyProps(cli.copy, COMMANDS.textPipe.name)}
          />
        </ModeSection>

        <ModeSection {cli} lang={lang()} mode={mode.sendReceive}>
          <CommandBlock
            code={COMMANDS.sendReceive.code}
            title={COMMANDS.sendReceive.name}
            {...copyProps(cli.copy, COMMANDS.sendReceive.name)}
          />
        </ModeSection>

        <ModeSection {cli} lang={lang()} mode={mode.pushPull}>
          <CommandBlock
            code={COMMANDS.pushPull.code}
            title={COMMANDS.pushPull.name}
            {...copyProps(cli.copy, COMMANDS.pushPull.name)}
          />
        </ModeSection>

        <ModeSection {cli} lang={lang()} mode={mode.serve}>
          <CommandBlock
            code={COMMANDS.serveListen.code}
            title={COMMANDS.serveListen.name}
            {...copyProps(cli.copy, COMMANDS.serveListen.name)}
          />
          <CommandBlock
            code={COMMANDS.servePush.code}
            title={COMMANDS.servePush.name}
            {...copyProps(cli.copy, COMMANDS.servePush.name)}
          />
          <CommandBlock
            code={COMMANDS.serveAuthorize.code}
            title={COMMANDS.serveAuthorize.name}
            {...copyProps(cli.copy, COMMANDS.serveAuthorize.name)}
          />
        </ModeSection>

        <ModeSection {cli} lang={lang()} mode={mode.sync}>
          <CommandBlock
            code={COMMANDS.sync.code}
            title={COMMANDS.sync.name}
            {...copyProps(cli.copy, COMMANDS.sync.name)}
          />
        </ModeSection>
      </section>

      <section class="band" id={sectionId.guides} aria-labelledby="cli-guides-h">
        <h2 id="cli-guides-h">{cli.sections.guides}</h2>
        <GuideList {cli} lang={lang()} />
      </section>

      <section class="band" id={sectionId.reference} aria-labelledby="cli-ref-h">
        <h2 id="cli-ref-h">{cli.sections.reference}</h2>
        <FlagTable {cli} />
        <p class="note">{cli.advertiseNote}</p>
        <p class="note">{cli.helpNote}</p>
      </section>

      <section class="band" id={sectionId.security} aria-labelledby="cli-security-h">
        <h2 id="cli-security-h">{cli.sections.security}</h2>
        <p class="lead">{cli.securityIntro}</p>
        <ul class="points">
          {#each cli.securityPoints as point (point)}
            <li>{point}</li>
          {/each}
        </ul>

        <h3>{cli.trustH3}</h3>
        <p class="lead">{cli.trustIntro}</p>
        <ul class="files">
          {#each TRUST_FILES as file (file.key)}
            <li><code dir="ltr">{file.name}</code> — {cli.trustFiles[file.key]}</li>
          {/each}
        </ul>
      </section>

      <section class="band" id={sectionId.faq} aria-labelledby="cli-faq-h">
        <h2 id="cli-faq-h">{cli.sections.faq}</h2>
        <FaqList {cli} />
      </section>

      <footer>
        <a href={CLI_REPO}>{cli.footerSource}</a>
        <span class="dot" aria-hidden="true">·</span>
        <a href={LATEST_RELEASE_URL}>{cli.footerReleases}</a>
        <span class="dot" aria-hidden="true">·</span>
        <a
          href={PRICING_PATH}
          onclick={(e) => {
            e.preventDefault();
            navigate("pricing");
          }}>{t.pricingPage.navLink}</a
        >
        <span class="dot" aria-hidden="true">·</span>
        <span class="muted">{cli.footerBrowser}</span>
      </footer>
    </div>
  </div>
</div>

<style>
  .cli {
    max-width: 1180px;
    margin: 0 auto;
    padding: var(--space-4) 0 var(--space-9);
    /* Nothing on this page may push the document sideways. Every wide surface
       here (both tables, every command block, the mobile anchor row) scrolls
       inside its own box. */
    overflow-x: clip;
  }

  /* ── Hero ────────────────────────────────────────────────────────────────
     Compact and install-first: a heading, one supporting line, and then the
     install band. No eyebrow, no badge row, no gradient mark — the reader came
     for a command, and each of those pushes it below the fold. */
  .hero {
    padding-block: var(--space-6) var(--space-5);
    border-block-end: 1px solid var(--border);
  }
  .hero h1 {
    font-size: var(--fs-display);
    letter-spacing: -1.2px;
    line-height: 1.05;
    color: var(--text-h);
    margin: 0 0 var(--space-3);
  }
  .support {
    color: var(--text);
    font-size: var(--fs-body);
    line-height: 1.6;
    margin: 0;
    max-inline-size: 56ch;
    text-wrap: pretty;
  }

  /* ── Layout ──────────────────────────────────────────────────────────────
     One column with a sticky anchor row above the content; at 1024px the rail
     moves into a gutter beside it. minmax(0, 1fr) rather than 1fr so a wide
     table inside a grid item cannot stretch the column. */
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  @media (min-width: 1024px) {
    .layout {
      grid-template-columns: 190px minmax(0, 1fr);
      column-gap: var(--space-7);
      align-items: start;
      padding-block-start: var(--space-6);
    }
  }

  .body {
    min-inline-size: 0;
  }

  /* Bands, not cards: each section is separated by air and (where it helps) a
     single hairline. Their internal rhythm varies on purpose — the install band
     is two columns, task branches are three, guides are grouped lists, the
     modes are rows — so the page does not read as one repeated tile. */
  .band {
    margin-block-start: var(--space-9);
  }
  .band > h2 {
    font-size: var(--fs-h2);
    color: var(--text-h);
    letter-spacing: -0.4px;
    margin: 0 0 var(--space-4);
  }
  .band h3 {
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: var(--space-6) 0 var(--space-2);
  }

  .lead {
    color: var(--text);
    line-height: 1.65;
    margin: 0 0 var(--space-4);
    max-inline-size: 68ch;
  }
  .spaced {
    margin-block-start: var(--space-7);
  }
  .note {
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.7;
    margin: var(--space-4) 0 0;
    max-inline-size: 72ch;
  }

  h4 {
    font-size: var(--fs-sm);
    color: var(--text);
    font-weight: 600;
    margin: 0 0 var(--space-3);
  }
  .steps {
    margin: 0 0 var(--space-4);
    padding-inline-start: 1.3em;
    max-inline-size: 72ch;
  }
  .steps li {
    color: var(--text);
    line-height: 1.65;
    margin-block-end: var(--space-4);
  }
  .steps strong {
    color: var(--text-h);
  }
  .steps :global(.term) {
    margin-block-start: var(--space-2);
  }

  /* The emphasis is on the LINK, not on the paragraph around it. A bolded <p>
     followed by ordinary text is what axe's p-as-heading rule flags, and it is
     right to: a screen-reader user gets a visual hierarchy that is not in the
     document. Giving the anchor a button's affordance says "this is the action"
     without pretending to be a heading. */
  .cta {
    margin: var(--space-3) 0 var(--space-2);
  }
  .cta a {
    display: inline-flex;
    align-items: center;
    min-block-size: 44px;
    color: var(--accent-fg);
    text-decoration: none;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    padding-inline: var(--space-4);
    transition: background-color 0.13s;
  }
  .cta a:hover {
    background: var(--social-bg);
  }
  .cta a:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: var(--focus-offset);
  }
  @media (prefers-reduced-motion: reduce) {
    .cta a {
      transition: none;
    }
  }
  .hint {
    font-size: var(--fs-sm);
    line-height: 1.65;
    margin: var(--space-2) 0 0;
  }

  .points,
  .files {
    margin: 0;
    padding-inline-start: 1.15em;
    max-inline-size: 72ch;
  }
  .points li,
  .files li {
    color: var(--text);
    line-height: 1.7;
    margin-block-end: var(--space-3);
  }
  .points li::marker,
  .files li::marker {
    color: var(--border);
  }
  .files code {
    font-family: var(--mono);
    font-size: 0.9em;
    color: var(--text-h);
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
  }

  a {
    color: var(--accent-fg);
  }

  footer {
    margin-block-start: var(--space-8);
    padding-block-start: var(--space-4);
    border-block-start: 1px solid var(--border);
    font-size: var(--fs-sm);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  footer .dot,
  .muted {
    color: var(--text);
  }
</style>
