<!--
  The help that ends every screen — one control, and six answers behind it.

  ## Why it is a button and not a bare disclosure triangle

  The whole row is the target, at the same height as every other control in the
  app. A triangle beside caption text is about a dozen pixels square, reads as
  decoration in a column of grey text, and is the one weak affordance on
  otherwise consistent screens — aimed, of all people, at whoever understands
  the screen least.

  Closed by default. A reader who already knows how the screen works should not
  have to scroll past an essay to reach the controls; one who does not should
  not have to leave the app to find out.
-->
<script lang="ts">
  import { lang, t } from "../i18n/index.svelte.js";
  import { HELP_GUIDES } from "../../shared/help-guides.js";
  import { HELP } from "./help-content.js";
  import { openGuide } from "./guide-link.js";
  import type { Page } from "./navigation.svelte.js";

  let { page }: { page: Page } = $props();

  const content = $derived(HELP[page]);
  // Only where a maintained document exists. An invented "learn more" pointing
  // at a page that does not answer the question is worse than no link at all,
  // so the Account screen renders nothing here rather than something generic.
  const guide = $derived(HELP_GUIDES[page]);
  let open = $state(false);
  /**
   * WHICH screen could not be opened, rather than whether one could.
   *
   * The component is reused as the reader moves between screens, so a plain
   * boolean would leave "could not open your browser" sitting under the help of
   * a screen whose link was never touched. A failure belongs to the screen it
   * happened on, and stops being true the moment that is no longer the screen.
   */
  let failedFor = $state<Page | null>(null);
  const failed = $derived(failedFor === page);

  async function readGuide(): Promise<void> {
    const asked = page;
    failedFor = null;
    const ok = await openGuide(asked, lang());
    // A slow refusal must not land on a screen the reader has since left.
    if (asked !== page) return;
    failedFor = ok ? null : asked;
  }
</script>

<section class="help" data-test="help" data-page={page}>
  <button
    type="button"
    class="toggle"
    data-test="help-toggle"
    aria-expanded={open}
    aria-controls="help-body"
    aria-describedby="help-hint"
    onclick={() => (open = !open)}
  >
    <span class="rows">
      <span class="heading">{t("helpHeading")}</span>
      <!-- The one sentence that is always on screen, so it is the one that has
           to earn its line. The Mac carries it here for a reason worth copying:
           somebody who has not worked out what the screen IS cannot use its
           first step, and a row saying only "Help" tells them nothing about
           whether opening it will answer their question. -->
      <span class="purpose" data-test="help-purpose">{t(content.purpose)}</span>
    </span>
    <!-- The chevron says which way it will go. The accessible state is on the
         button itself, so a screen reader is told without reading the glyph. -->
    <span class="chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
  </button>
  <!-- What opening this will get you, for a reader who cannot see the row's
       second line as a preview. `aria-expanded` already says which way the
       control will go; this says what is behind it. The Mac carries the same
       thing as an accessibility hint. -->
  <span id="help-hint" class="sr-only">{t(open ? "helpHide" : "helpShow")}</span>
  <!-- Present in the tree either way, so `aria-controls` always resolves. -->
  <div id="help-body" hidden={!open} data-test="help-body">
    <h3>{t("helpStepsHeading")}</h3>
    <ol data-test="help-steps">
      {#each content.steps as step (step)}
        <li>{t(step)}</li>
      {/each}
    </ol>

    <h3>{t("helpBoundaryHeading")}</h3>
    <p data-test="help-boundary">{t(content.boundary)}</p>

    <h3>{t("helpWhereHeading")}</h3>
    <p data-test="help-where">{t(content.where)}</p>

    <h3>{t("helpTroubleHeading")}</h3>
    <p data-test="help-failure">{t(content.failure)}</p>
    <p data-test="help-recovery">{t(content.recovery)}</p>

    {#if guide !== null}
      <!-- A button, not an anchor: there is no address in this document to put
           in an href, and a renderer that could navigate is the thing the main
           process refuses. -->
      <button type="button" class="guide" data-test="help-guide" onclick={readGuide}>
        {t("helpGuideLink")}
      </button>
      {#if failed}
        <p class="guide-failed" data-test="help-guide-failed" role="status">
          {t("helpGuideLinkFailed")}
        </p>
      {/if}
    {/if}
  </div>
</section>

<style>
  .help {
    margin-top: var(--gap-lg, 24px);
  }
  .toggle {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--gap, 12px);
    width: 100%;
    text-align: start;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .heading {
    font-weight: 600;
  }
  .purpose {
    color: var(--dim, inherit);
    font-size: 0.95em;
    font-weight: 400;
  }
  .chevron {
    opacity: 0.7;
    flex: 0 0 auto;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  #help-body {
    padding: var(--gap, 12px) 0 0;
  }
  #help-body h3 {
    margin: var(--gap, 12px) 0 4px;
    font-size: 0.95em;
  }
  #help-body p,
  #help-body li {
    color: var(--dim, inherit);
    font-size: 0.95em;
  }
  #help-body ol {
    margin: 0;
    padding-inline-start: 1.4em;
  }
  .guide {
    margin-top: var(--gap, 12px);
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent, inherit);
    font: inherit;
    font-size: 0.95em;
    text-align: start;
    text-decoration: underline;
    cursor: pointer;
  }
  .guide-failed {
    margin: 4px 0 0;
  }
</style>
