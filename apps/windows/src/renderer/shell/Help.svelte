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
  import { t } from "../i18n/index.svelte.js";
  import { HELP } from "./help-content.js";
  import type { Page } from "./navigation.svelte.js";

  let { page }: { page: Page } = $props();

  const content = $derived(HELP[page]);
  let open = $state(false);
</script>

<section class="help" data-test="help" data-page={page}>
  <button
    type="button"
    class="toggle"
    data-test="help-toggle"
    aria-expanded={open}
    aria-controls="help-body"
    onclick={() => (open = !open)}
  >
    <span>{t("helpHeading")}</span>
    <!-- The chevron says which way it will go. The accessible state is on the
         button itself, so a screen reader is told without reading the glyph. -->
    <span class="chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
  </button>
  <!-- Present in the tree either way, so `aria-controls` always resolves. -->
  <div id="help-body" hidden={!open} data-test="help-body">
    <p data-test="help-purpose">{t(content.purpose)}</p>

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
  </div>
</section>

<style>
  .help {
    margin-top: var(--gap-lg, 24px);
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    text-align: start;
  }
  .chevron {
    opacity: 0.7;
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
</style>
