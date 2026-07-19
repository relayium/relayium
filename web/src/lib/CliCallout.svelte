<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, CLI_PATH } from "./router.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import { reveal } from "./reveal";
  const t = $derived<Messages>(messages[lang()]);
  const installCmd = "curl -fsSL https://relayium.com/install.sh | sh";
</script>

<section class="cli-callout reveal" use:reveal aria-label={t.cliCallout.heading}>
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
  <div class="cmd-wrap"><CommandBlock code={installCmd} title="install" /></div>
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
  .cmd-wrap {
    flex: 1 1 340px;
    /* min-width:0 alone doesn't let the terminal shrink: the command block's
       non-wrapping <pre> has a min-content wider than the column on narrow
       screens, so cap the flex item at the container width and let the <pre>
       scroll internally (fixes ~100px horizontal page overflow on mobile). */
    min-width: 0;
    max-width: 100%;
  }
  @media (max-width: 560px) {
    .cli-callout {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
