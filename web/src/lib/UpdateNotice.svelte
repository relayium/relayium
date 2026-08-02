<script lang="ts">
  // The global "a newer build is deployed — refresh when you're ready" bar.
  //
  // It is deliberately persistent and NOT dismissible: the failure mode it
  // exists for is a tab that silently keeps running an old build (a page left
  // open on v0.13 still rejecting the digits 0 and 1 in a pairing code long
  // after v0.14.0 made codes six-digit decimal), and a dismiss button would put
  // that state back one click away with nothing left on screen to say so. It
  // costs one slim bar and goes away on refresh.
  //
  // It also never refreshes by itself — see app-update.svelte.ts. A reload kills
  // live links, in-flight transfers and the queued outbox, so the choice, and
  // the timing, are the user's.
  //
  // Scope note: this bar can only ever appear on a page that is already running
  // THIS build. Tabs still executing an older build have no such component to
  // render, which is why the incident that motivated it needed a manual refresh.
  import { appUpdateVisible, applyAppUpdate, refreshBlocked } from "./app-update.svelte";
  import { outbox } from "./outbox.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  // The workspace half of "a reload would destroy this": warnsOnLeave — a live
  // link, an in-flight transfer, an open message session. It is App's to know,
  // so it comes in as a prop.
  let { busy = false }: { busy?: boolean } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const visible = $derived(appUpdateVisible());
  // Four reasons the action can be unavailable, combined in app-update so the
  // button and applyAppUpdate() cannot disagree: the update has installed but
  // has not taken control yet (a streaming download is holding it back), the
  // workspace warns on leave, files are still queued, or a local stored
  // upload/download holds the guard. The queue is a global store, so read it
  // here rather than making every caller remember it.
  //
  // All four inputs are reactive, which is the point — the action enables
  // itself the moment the download finishes, the transfer ends or the queue
  // drains, with no second event to catch.
  const queued = $derived(outbox().length);
  const blocked = $derived(refreshBlocked(busy, queued));
</script>

<!-- Two separate things, deliberately not nested.
     1. A polite live region, mounted unconditionally and starting empty (a
        region and its first message appearing in the same update is not
        announced reliably; the same pattern, and reason, as the activity
        announcer in App). It holds ONE fixed catalogue string and nothing else:
        no interactive content to announce as unreachable prose, no busy line
        that would re-announce every time a transfer starts or stops, and
        nothing protected — no file names, no message bodies, no verification
        code ever reaches it.
     2. The visible banner, with the real keyboard-reachable button. Screen
        readers reach it by browsing like any other content; it is not inside
        the live region, so the button is announced once, where it is. -->
<div class="update-live" role="status" aria-live="polite" aria-atomic="true">
  {#if visible}{t.appUpdate.ready}{/if}
</div>

{#if visible}
  <div class="update-bar ui-callout ui-callout-accent">
    <p class="update-text">
      {t.appUpdate.ready}
      {#if blocked}<span class="update-busy">{t.appUpdate.busy}</span>{/if}
    </p>
    <button type="button" class="btn btn-primary btn-sm" disabled={blocked} onclick={() => applyAppUpdate(busy, queued)}>
      {t.appUpdate.refresh}
    </button>
  </div>
{/if}

<style>
  /* Clipped, not hidden: display:none and visibility:hidden take a live region
     out of the accessibility tree, which stops it announcing at all. Same
     technique as App's .activity-announcement. */
  .update-live {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Pinned to the bottom rather than in flow: an open tab can be scrolled
     anywhere when a deploy lands, and the notice has to be findable from there.
     Logical insets, so RTL needs no separate rule. */
  .update-bar {
    position: fixed;
    inset-block-end: 0;
    inset-inline: 0;
    /* Above page content, deliberately below the toast (30) and below every
       modal backdrop (40+): an update is never urgent enough to float over a
       dialog the user is answering. It comes back when the dialog closes. */
    z-index: 25;
    margin-inline: auto;
    max-inline-size: min(640px, calc(100vw - 2 * var(--space-3)));
    margin-block-end: calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding-block: var(--space-3);
    box-shadow: var(--shadow);
    /* --accent-bg is a 10–15% tint, which is fine for a callout sitting in the
       flow and unreadable for one floating over scrolling text. Same tint, laid
       over the opaque callout surface. */
    background-color: var(--surface-2);
    background-image: linear-gradient(var(--accent-bg), var(--accent-bg));
  }

  .update-text {
    margin: 0;
    flex: 1 1 12rem;
    min-inline-size: 0;
    color: var(--text-h);
  }
  /* Second sentence on its own line: it explains why the button is dead, and it
     must not read as a continuation of the headline. */
  .update-busy { display: block; color: var(--text); }

  /* On a phone the button owns the second row instead of squeezing the text. */
  @media (max-width: 480px) {
    .update-text { flex-basis: 100%; }
  }
</style>
