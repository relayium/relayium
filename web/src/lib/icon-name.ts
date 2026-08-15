/**
 * Every mark `Icon.svelte` knows how to draw.
 *
 * It lives in a plain module rather than in the component's own `<script
 * module>` because non-component code needs to name these too, and not all of
 * that code is compiled by the Svelte project: `vite-plugin-pwa.ts` pulls in
 * `i18n/types.ts`, which reaches `device-inbox-platforms.ts`, so that data
 * module is type-checked by `tsconfig.node.json` as well. There a `.svelte`
 * import resolves to the ambient wildcard module, which exports a component and
 * nothing else — `import type { IconName } from "./Icon.svelte"` is a build
 * error in that project even though svelte-check accepts it.
 *
 * One union, both projects, and `Icon.svelte` still re-exports it so existing
 * `from "./Icon.svelte"` imports keep working.
 */
export type IconName =
  | "bolt" | "file" | "folder" | "message"
  | "link" | "pairing-code" | "lock" | "download" | "package"
  | "globe" | "clock" | "devices" | "network"
  | "nearby" | "shield" | "file-download" | "close" | "inbox"
  // Platform hardware. Deliberately form factors rather than OS logos: the
  // Device Inbox rows they decorate are named in prose beside them, and a rack
  // / workstation / laptop / window / phone / robot set stays legible at 21px
  // where a traced logo does not.
  | "server" | "desktop" | "laptop" | "window" | "phone" | "robot";
