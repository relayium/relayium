<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, CLI_PATH } from "./router.svelte";
  const t = $derived<Messages>(messages[lang()]);
  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";
</script>

<section class="cli-callout" aria-label={t.cliCallout.heading}>
  <div class="text">
    <h2>{t.cliCallout.heading}</h2>
    <p>{t.cliCallout.blurb}</p>
    <a
      class="cta"
      href={CLI_PATH}
      onclick={(e) => {
        e.preventDefault();
        navigate("cli");
      }}>{t.cliCallout.cta}</a
    >
  </div>
  <pre class="cmd"><code>{installCmd}</code></pre>
</section>

<style>
  .cli-callout {
    margin: var(--section-gap) 0 var(--space-2);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    flex-wrap: wrap;
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--social-bg);
  }
  .text {
    flex: 1 1 260px;
    min-width: 0;
  }
  .text h2 {
    font-size: var(--fs-h2);
    margin: 0 0 var(--space-2);
  }
  .text p {
    color: var(--text);
    font-size: var(--fs-sm);
    margin: 0 0 var(--space-4);
    max-width: 48ch;
  }
  .cta {
    display: inline-flex;
    align-items: center;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: 1px solid var(--accent);
    padding: var(--space-2) var(--space-4);
    border-radius: 999px;
    text-decoration: none;
  }
  .cta:hover {
    filter: brightness(1.05);
  }
  .cmd {
    flex: 1 1 320px;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    overflow-x: auto;
    margin: 0;
  }
  .cmd code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fs-sm);
    color: var(--text-h);
    white-space: pre;
  }
  @media (max-width: 560px) {
    .cli-callout {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
