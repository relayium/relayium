<!--
  One coherent line-icon set, drawn rather than imported.
  
  A stroked 24×24 grid with `currentColor`, so an icon inherits the row's colour
  in light mode, dark mode and high contrast without three assets. `aria-hidden`
  throughout: every icon here sits beside its own visible label, and announcing
  it again would make a screen reader say everything twice.
-->
<script lang="ts">
  let { name, size = 18 }: { name: "lan" | "pair" | "link" | "inbox" | "account" | "brand"; size?: number } =
    $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === "lan"}
    <!-- Two devices on one network. -->
    <rect x="2.5" y="5" width="8" height="6" rx="1.2" />
    <rect x="13.5" y="13" width="8" height="6" rx="1.2" />
    <path d="M6.5 11v3.5a1.5 1.5 0 0 0 1.5 1.5h5.5" />
  {:else if name === "pair"}
    <!-- A short code. -->
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M7.5 12h.01M12 12h.01M16.5 12h.01" />
  {:else if name === "link"}
    <path d="M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7.5" />
    <path d="M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5l1.5-1.5" />
  {:else if name === "inbox"}
    <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    <path d="M5.5 5h13l2.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4Z" />
  {:else if name === "account"}
    <circle cx="12" cy="9" r="3.5" />
    <path d="M5 19.5a7 7 0 0 1 14 0" />
  {:else}
    <!-- brand -->
    <path d="M12 3.5 20 8v8l-8 4.5L4 16V8Z" />
    <path d="M12 12v8.5M12 12 4 8M12 12l8-4" />
  {/if}
</svg>

<style>
  svg { flex: 0 0 auto; }
</style>
