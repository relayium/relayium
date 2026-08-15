<script lang="ts" module>
  // The union itself lives in a plain module so non-component code can name it
  // in BOTH TypeScript projects — see icon-name.ts. Re-exported here so
  // `import { type IconName } from "./Icon.svelte"` keeps working.
  export type { IconName } from "./icon-name.js";
</script>

<script lang="ts">
  import type { IconName } from "./icon-name.js";

  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<!-- These icons are deliberately decorative. Their callers always provide a
     localized visible label, so a title/label API would create duplicate or
     untranslated accessible names.

     The six platform marks at the end of the chain (server…robot) are drawn to
     a common optical weight rather than a common bounding box: each is centred
     on x=12 and fills roughly the same area, which is what makes six different
     silhouettes read as one column in the Device Inbox list. Their literal
     widths differ on purpose — a phone that is as wide as a rack is not a phone.
     They also use the `h.01` dot idiom, which paints a 1.8px round cap and so
     needs no second fill colour to stay in step with the strokes. -->
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
  {:else if name === "close"}
    <path d="M6 6l12 12M18 6 6 18" />
  {:else if name === "inbox"}
    <!-- A receiving tray: sloped lid into the body, then the drop channel.
         Symmetric about x=12, so it needs no mirroring in RTL. -->
    <path d="M3 12.2 6.3 5.4a1.6 1.6 0 0 1 1.45-.9h8.5a1.6 1.6 0 0 1 1.45.9L21 12.2v6.1a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 18.3z" />
    <path d="M3 12.2h5l1.4 2.6h5.2l1.4-2.6h5" />
  {:else if name === "server"}
    <!-- Two rack units. The status lamps are what separate this from the
         `desktop` workstation: a machine that is watched, not used. -->
    <path d="M4 4.5h16v6H4z" />
    <path d="M4 13.5h16v6H4z" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  {:else if name === "desktop"}
    <!-- Workstation: screen on a stem and a foot. Narrow base, so its
         silhouette cannot be confused with `laptop`'s wide deck. -->
    <path d="M3.5 4.5h17v11H3.5z" />
    <path d="M12 15.5v3.5M8.5 19h7" />
  {:else if name === "laptop"}
    <path d="M5 5h14v10.5H5z" />
    <path d="M2.5 18.5h19" />
  {:else if name === "window"}
    <!-- Four panes on the true centre lines: symmetric about both axes, so it
         needs no mirroring in any direction. -->
    <path d="M4 4.5h16v15H4z" />
    <path d="M12 4.5v15M4 12h16" />
  {:else if name === "phone"}
    <!-- Held to the family's optical height rather than a real handset's
         proportions: drawn true to life it was the one mark that reached both
         the top and the bottom of the box and read a size larger than the five
         beside it. -->
    <path d="M7.6 4.2h8.8a1.6 1.6 0 0 1 1.6 1.6v12.4a1.6 1.6 0 0 1-1.6 1.6H7.6a1.6 1.6 0 0 1-1.6-1.6V5.8a1.6 1.6 0 0 1 1.6-1.6z" />
    <path d="M10.5 7h3" />
  {:else if name === "robot"}
    <!-- Dome, two antennae, two eyes — mirrored about x=12 to the decimal, and
         sized so the mass straddles the centre line. The first cut sat entirely
         in the upper half of the box, which at 21px read as a smaller icon than
         its five neighbours rather than as a different shape. -->
    <path d="M4.5 16.5a7.5 7.5 0 0 1 15 0" />
    <path d="M4.5 16.5h15" />
    <path d="M8.4 9.9 6.6 7.2M15.6 9.9l1.8-2.7" />
    <path d="M9.7 13h.01M14.3 13h.01" />
  {/if}
</svg>

<style>
  svg { display: block; flex: none; }
</style>
