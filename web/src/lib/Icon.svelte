<script lang="ts" module>
  export type IconName =
    | "bolt" | "file" | "folder" | "message"
    | "link" | "pairing-code" | "lock" | "download" | "package"
    | "globe" | "clock" | "devices" | "network"
    | "nearby" | "shield" | "file-download";
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
  {:else if name === "link"}
    <path d="M9.5 14.5 8 16a4 4 0 0 1-5.7-5.7l2.2-2.2a4 4 0 0 1 5.7 0" />
    <path d="m14.5 9.5 1.5-1.5a4 4 0 0 1 5.7 5.7l-2.2 2.2a4 4 0 0 1-5.7 0" />
    <path d="m8.5 15.5 7-7" />
  {:else if name === "pairing-code"}
    <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />
  {:else if name === "lock"}
    <path d="M7 10V7a5 5 0 0 1 10 0v3" />
    <path d="M5 10h14v10H5z" />
    <path d="M12 14v2" />
  {:else if name === "download"}
    <path d="M12 3v11m0 0-4-4m4 4 4-4" />
    <path d="M5 16v4h14v-4" />
  {:else if name === "package"}
    <path d="m4 7.5 8-4.5 8 4.5v9L12 21l-8-4.5z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.25l8 4.5" />
  {:else if name === "globe"}
    <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM3 12h18" />
    <path d="M12 3c2.6 2.5 4 5.5 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.5-4-9s1.4-6.5 4-9z" />
  {:else if name === "clock"}
    <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
    <path d="M12 7v5l3 2" />
  {:else if name === "devices"}
    <path d="M2 5h12v8.5H2zM6.5 17h5M9 13.5V17" />
    <path d="M15.5 8H22v11.5h-6.5zM18 17.5h1.5" />
  {:else if name === "network"}
    <path d="M12 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 17a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 17a2 2 0 1 1 0 4 2 2 0 0 1 0-4z" />
    <path d="M12 7v4m0 0-6 6m6-6 6 6" />
  {:else if name === "nearby"}
    <path d="M12 15.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z" fill="currentColor" stroke="none" />
    <path d="M8.4 14a5 5 0 0 1 7.2 0M5.6 11a9 9 0 0 1 12.8 0" />
  {:else if name === "shield"}
    <path d="M12 3l7 3v5c0 4.4-3 7.9-7 9.8C8 18.9 5 15.4 5 11V6zM9 12l2 2 4-4" />
  {:else if name === "file-download"}
    <path d="M7 3.5h6l4 4v12a.8.8 0 0 1-.8.8H7a.8.8 0 0 1-.8-.8V4.3A.8.8 0 0 1 7 3.5zM13 3.5v4h4" />
    <path d="M11.5 11v5.5m0 0-2-2m2 2 2-2" />
  {/if}
</svg>

<style>
  svg { display: block; flex: none; }
</style>
