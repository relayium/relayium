<script lang="ts" module>
  // Gradient defs need document-unique ids; nav + hero can both mount one.
  let instances = 0;
</script>

<script lang="ts">
  // The Relayium mark: two arrows passing each other — files relayed both ways.
  // Drawn as strokes (not a text glyph) so it renders identically everywhere,
  // and kept in sync with /favicon.svg, which carries the same artwork.
  let { size = 28 }: { size?: number } = $props();
  const uid = `logo-g${++instances}`;
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 64 64"
  fill="none"
  aria-hidden="true"
  focusable="false"
>
  <defs>
    <linearGradient id={uid} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#a94bff" />
      <stop offset="1" stop-color="#635bff" />
    </linearGradient>
    <linearGradient id="{uid}-sheen" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity=".22" />
      <stop offset=".55" stop-color="#fff" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#{uid})" />
  <rect width="64" height="64" rx="15" fill="url(#{uid}-sheen)" />
  <path
    d="M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5"
    stroke="#fff"
    stroke-width="5.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
