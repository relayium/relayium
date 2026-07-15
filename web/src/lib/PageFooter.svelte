<script lang="ts">
  import { lang, legalUrl, messages, type Messages } from "./i18n.svelte";
  import { navigate, PRICING_PATH } from "./router.svelte";

  // Fineprint text differs per page (realtime E2E vs at-rest encryption story),
  // so it's passed in rather than read from a fixed i18n key.
  let { fineprint }: { fineprint: string } = $props();

  const t = $derived<Messages>(messages[lang()]);
</script>

<footer>
  <nav class="legal">
    <a href={PRICING_PATH} onclick={(e) => { e.preventDefault(); navigate("pricing"); }}>{t.pricingPage.navLink}</a>
    <a href={legalUrl("security", lang())}>{t.legal.security}</a>
    <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
    <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
    <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
  </nav>
  <span class="fineprint">{fineprint}</span>
</footer>

<style>
  footer {
    margin-top: var(--space-8); padding-top: var(--space-5); border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }
</style>
