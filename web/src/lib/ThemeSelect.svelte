<script lang="ts">
  import { theme, setTheme, type Theme } from "./theme.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  const options: Theme[] = ["system", "light", "dark"];
</script>

<select
  class="theme"
  aria-label={t.theme.label}
  value={theme()}
  onchange={(e) => setTheme((e.currentTarget as HTMLSelectElement).value as Theme)}
>
  {#each options as o (o)}
    <option value={o}>{t.theme[o]}</option>
  {/each}
</select>

<style>
  /* Matches the language <select> so the two sit together as one control group. */
  .theme {
    font: inherit; font-size: var(--fs-xs); padding: 5px 28px 5px 10px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .theme:hover { border-color: var(--accent-border); }
</style>
