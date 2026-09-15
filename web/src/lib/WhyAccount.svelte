<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import Help from "./ui/Help.svelte";

  // `compact` drops the eyebrow and trims padding for the /me gate, unchanged.
  // `collapsible` is what the two cross-network pages pass: there the block sits
  // below a working control, it is three paragraphs long, and it answers a
  // question ("why does this one need an account?") rather than stating a limit
  // the reader has to know before acting. So it folds, with `why.heading` as the
  // summary — the same words that were the eyebrow above it. The account gate
  // itself is NOT in here: it is stated on the control, by the control.
  let { compact = false, collapsible = false }: { compact?: boolean; collapsible?: boolean } = $props();
  const t = $derived<Messages>(messages[lang()]);
  // Language-prefixed guide URL so a non-English visitor lands on their locale's
  // prerendered article (en lives at the bare /guides/... path).
  const guideHref = $derived(
    lang() === "en" ? "/guides/bring-your-own-node" : `/${lang()}/guides/bring-your-own-node`
  );
</script>

{#snippet points()}
  <dl>
    <div class="point">
      <dt>{t.why.costTitle}</dt>
      <dd>{t.why.costBody}</dd>
    </div>
    <div class="point">
      <dt>{t.why.selfhostTitle}</dt>
      <dd>
        {t.why.selfhostBody}
        <a href={guideHref} target="_blank" rel="noopener">{t.why.selfhostCta} →</a>
      </dd>
    </div>
    <div class="point">
      <dt>{t.why.privacyTitle}</dt>
      <dd>{t.why.privacyBody}</dd>
    </div>
  </dl>
{/snippet}

{#if collapsible}
  <aside class="why folded">
    <Help summary={t.why.heading}>{@render points()}</Help>
  </aside>
{:else}
  <aside class="why" class:compact>
    {#if !compact}<p class="eyebrow">{t.why.heading}</p>{/if}
    {@render points()}
  </aside>
{/if}

<style>
  .why {
    max-width: 520px; margin: var(--space-4) auto 0; padding: var(--space-4);
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--social-bg);
    text-align: start;
  }
  .why.compact { margin-top: var(--space-3); padding: var(--space-3); background: none; }
  /* Folded: the disclosure brings its own surface, so this is spacing only. */
  .why.folded { max-width: 720px; padding: 0; border: 0; background: none; margin-top: var(--space-4); }
  .eyebrow {
    margin: 0 0 var(--space-3); font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--text); opacity: .65;
  }
  dl { margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .point { margin: 0; }
  dt { font-size: var(--fs-xs); font-weight: 600; color: var(--text-h); margin: 0 0 3px; }
  dd { margin: 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.55; }
  dd a { color: var(--accent-fg); white-space: nowrap; }
  dd a:hover { text-decoration: underline; }
</style>
