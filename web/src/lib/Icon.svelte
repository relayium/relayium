<script lang="ts" module>
  export type IconName = "bolt" | "file" | "folder" | "message";
</script>

<script lang="ts">
  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<!-- These icons are deliberately decorative. Their callers always provide a
     localized visible label, so a title/label API would create duplicate or
     untranslated accessible names. -->
<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === "bolt"}
    <path d="M13.5 3 6 13.5h4.8L10.5 21 18 10.5h-4.8z" />
  {:else if name === "file"}
    <path d="M7 3.5h6l4 4v12a.8.8 0 0 1-.8.8H7a.8.8 0 0 1-.8-.8V4.3A.8.8 0 0 1 7 3.5z" />
    <path d="M13 3.5v4h4" />
  {:else if name === "folder"}
    <path d="M3.5 7.2a1 1 0 0 1 1-1h4l2 2.2h9a1 1 0 0 1 1 1v9.1a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
  {:else if name === "message"}
    <!-- Centred tail keeps the glyph direction-neutral in RTL. -->
    <path d="M5 5.2h14a1.8 1.8 0 0 1 1.8 1.8v8.2A1.8 1.8 0 0 1 19 17H14l-2 3-2-3H5a1.8 1.8 0 0 1-1.8-1.8V7A1.8 1.8 0 0 1 5 5.2z" />
  {/if}
</svg>

<style>
  svg { display: block; flex: none; }
</style>
