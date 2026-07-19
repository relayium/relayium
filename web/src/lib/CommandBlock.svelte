<script lang="ts">
  // A terminal-window styled code block with a copy-to-clipboard button.
  let { code, title = "" }: { code: string; title?: string } = $props();
  let copied = $state(false);
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
    {#if title}<span class="title">{title}</span>{/if}
    <button class="copy" class:copied onclick={copy} aria-label="Copy to clipboard">
      {copied ? "Copied ✓" : "Copy"}
    </button>
  </div>
  <pre><code>{code}</code></pre>
</div>

<style>
  .term {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--code-bg);
    box-shadow: var(--shadow);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
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
  .title {
    font-size: var(--fs-xs);
    color: var(--text);
    font-family: var(--mono);
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
  /* Success flash: the label pops and greens for its brief "Copied ✓" window. */
  .copy.copied {
    color: #2ecc71;
    border-color: #2ecc71;
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
