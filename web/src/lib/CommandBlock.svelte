<script lang="ts">
  // A terminal-window styled code block with a copy-to-clipboard button.
  //
  // The labels are props with the previous hard-coded English as defaults: the
  // CLI page renders inside an English-only layout, but the download page shows
  // this to whoever the sender sent the link to, in either maintained language.
  // Passing them in beats a second component, and beats making every existing
  // call site pass strings it has no reason to have.
  let {
    code,
    title = "",
    copyLabel = "Copy",
    copiedLabel = "Copied ✓",
    copyAria = "Copy to clipboard",
  }: {
    code: string;
    title?: string;
    copyLabel?: string;
    copiedLabel?: string;
    /** Accessible name of the copy button. Several blocks can share a page, so
     *  callers should name WHICH command this one copies. */
    copyAria?: string;
  } = $props();
  let copied = $state(false);
  // Ties the scrollable <pre> to the visible title as its accessible name. $props.id()
  // keeps it unique when a page renders several command blocks.
  const uid = $props.id();
  const titleId = `cmdblock-title-${uid}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — no-op.
    }
  }
</script>

<div class="term">
  <div class="bar">
    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
    {#if title}<span class="title" id={titleId}>{title}</span>{/if}
    <button class="copy" class:copied onclick={copy} aria-label={copyAria}>
      {copied ? copiedLabel : copyLabel}
    </button>
  </div>
  <!-- The block scrolls sideways (overflow-x on <pre>), and a region that can
       scroll but cannot be focused is unreachable to anyone driving the page from
       the keyboard: there is nothing to put the caret on, so the hidden end of a
       long command simply cannot be read. tabindex="0" makes it a stop; the
       global :focus-visible outline makes that stop visible. The name is the
       terminal title that is already on screen — no invented, untranslated copy,
       and no second string that could drift from the visible one.
       svelte-ignore fires because <pre> is non-interactive; that rule exists to
       stop fake buttons, and this is the opposite case — WCAG 2.1.1 requires a
       scrollable region to be reachable by keyboard.

       dir="ltr" because a shell command is not prose: in Arabic the page is
       laid out RTL, and a bidi-reordered `relayium down '…' .` is a command the
       reader cannot retype and cannot check against what they are pasting. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre tabindex="0" dir="ltr" role={title ? "group" : undefined} aria-labelledby={title ? titleId : undefined}><code>{code}</code></pre>
</div>

<style>
  /* min-inline-size: 0 so this box never reports a floor of its own to a flex
     or grid parent. `overflow: hidden` here rounds the corners over the bar and
     the <pre> and nothing more; it must never be what keeps the block inside
     the page, because a clipped block is one whose right-hand side the reader
     cannot reach by any means. The <pre> below owns the sideways scroll. */
  .term {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    min-inline-size: 0;
    background: var(--code-bg);
    box-shadow: var(--shadow);
  }
  /* Wrapping is a guard here, not the overflow fix. Measured in a real browser
     at both 390px and 320px, the current dots + title + button row still fits
     on one line; what made this block wider than the phone was the <pre>, via
     an `auto` grid track that floored at its min-content (see InstallBand).
     The guard is worth its three declarations because .term CLIPS: were a
     longer title ever to push this row past the block, the end of it would
     silently disappear rather than overflow visibly — and that title is also
     the accessible name of the command below it. Wrapped, it takes a second
     line and stays whole. page-shell.mjs measures this bar's own overflow, so
     the clip cannot hide a regression here. */
  .bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    min-inline-size: 0;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }
  .dots {
    display: inline-flex;
    gap: 6px;
  }
  .dots i {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--border);
  }
  .dots i:nth-child(1) {
    background: #ff5f57;
  }
  .dots i:nth-child(2) {
    background: #febc2e;
  }
  .dots i:nth-child(3) {
    background: #28c840;
  }
  /* The other half of that guard. These titles are command names, so their
     longest unbreakable run can be nearly the whole string — `inbox-server-
     install.sh` has no space in it at all. min-inline-size: 0 stops this flex
     item flooring at that run, and overflow-wrap: anywhere gives the run a
     break point, so a long title wraps rather than widening the block or being
     cut off by .term's clip. Wrapped, not ellipsised: this title is the <pre>'s
     accessible name, and an ellipsis would shorten what a screen reader
     announces for the command as well as what is on screen. */
  .title {
    font-size: var(--fs-xs);
    color: var(--text);
    font-family: var(--mono);
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
  .copy {
    margin-inline-start: auto;
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    cursor: pointer;
    transition:
      color 0.13s,
      border-color 0.13s;
  }
  .copy:hover {
    color: var(--text-h);
    border-color: var(--accent-border);
  }
  /* On a phone this is the only control in the block, and 3px of vertical
     padding is a ~22px target — half the 44px minimum. The bar has room. */
  @media (max-width: 720px) {
    .copy {
      min-block-size: 44px;
      min-inline-size: 44px;
    }
  }
  /* Success flash: the label pops and greens for its brief "Copied ✓" window. */
  /* --ok, not another private green: #2ecc71 was ~2:1 on this bar in light mode,
     i.e. the success message was the least readable text in the component. */
  .copy.copied {
    color: var(--ok);
    border-color: var(--ok-border);
    animation: pop-in .3s ease;
  }
  @media (prefers-reduced-motion: reduce) { .copy.copied { animation: none; } }
  pre {
    margin: 0;
    padding: var(--space-4);
    overflow-x: auto;
  }
  code {
    font-family: var(--mono);
    font-size: var(--fs-sm);
    color: var(--text-h);
    white-space: pre;
    line-height: 1.6;
  }
</style>
