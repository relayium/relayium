<!-- web/src/lib/CrossSell.svelte -->
<script lang="ts">
  import { navigate, CROSS_PATH, OFFLINE_PATH } from "./router.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  // Directional cross-link between the two cross-network pages: target names the
  // page this card points TO (rendered on the other page).
  let { target }: { target: "realtime" | "offline" } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const copy = $derived(t.crossSell[target]);
  const route = $derived(target === "realtime" ? ("cross" as const) : ("offline" as const));
  const href = $derived(target === "realtime" ? CROSS_PATH : OFFLINE_PATH);
</script>

<aside class="xsell">
  <p>{copy.lead}</p>
  <a class="btn btn-ghost" {href} onclick={(e) => { e.preventDefault(); navigate(route); }}>{copy.cta}</a>
</aside>

<style>
  .xsell {
    margin: var(--space-5) auto 0; max-width: 640px;
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;
    padding: var(--space-4) var(--space-5); border-radius: var(--radius);
    border: 1px dashed var(--border); background: var(--surface-2);
  }
  .xsell p { margin: 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.55; flex: 1 1 300px; }
  .xsell .btn { white-space: nowrap; text-decoration: none; }
</style>
