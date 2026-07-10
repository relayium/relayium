<!-- web/src/lib/WhyAccount.svelte
     Shared "why an account?" explainer for the two login-gated feature pages
     (/cross-network, /offline-transfer) and the /me login gate. Three points:
     why login costs us (free allowance then paid), the free self-host escape
     hatch (run your own node → traffic never touches us), and the privacy
     promise. `compact` drops the eyebrow + trims padding for the /me gate. -->
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";

  let { compact = false }: { compact?: boolean } = $props();
  const t = $derived<Messages>(messages[lang()]);
  // Language-prefixed guide URL so a non-English visitor lands on their locale's
  // prerendered article (en lives at the bare /guides/... path).
  const guideHref = $derived(
    lang() === "en" ? "/guides/bring-your-own-node" : `/${lang()}/guides/bring-your-own-node`
  );
</script>

<aside class="why" class:compact>
  {#if !compact}<p class="eyebrow">{t.why.heading}</p>{/if}
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
</aside>

<style>
  .why {
    max-width: 520px; margin: var(--space-4) auto 0; padding: var(--space-4);
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--social-bg);
    text-align: left;
  }
  .why.compact { margin-top: var(--space-3); padding: var(--space-3); background: none; }
  .eyebrow {
    margin: 0 0 var(--space-3); font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--text); opacity: .65;
  }
  dl { margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .point { margin: 0; }
  dt { font-size: var(--fs-xs); font-weight: 600; color: var(--text-h); margin: 0 0 3px; }
  dd { margin: 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.55; }
  dd a { color: var(--accent); white-space: nowrap; }
  dd a:hover { text-decoration: underline; }
</style>
