// The OS-entry pane's vocabulary, in the two maintained languages.
//
// The refusals are the careful ones. Windows hands this app whatever the user
// picked, and "that did not work" over a folder containing one symlink would
// leave somebody re-picking the same folder for ever.

import { lang } from "../i18n/index.svelte.js";

export const osEntryEn = {
  stagedTitle: "Ready to send",
  stagedOne: "1 file from {roots}",
  stagedMany: "{count} files from {roots}",
  stagedSize: "{size} in total",
  /** Staged, NOT sent. Said plainly so nobody thinks it already went. */
  stagedNote: "Nothing has been sent yet. Choose where to send it.",
  clear: "Clear",
  /** Visible, and counted. A refusal nobody sees is a silent replacement. */
  refusedHeldOne: "1 more selection was not taken, because these are still waiting. Clear these first.",
  refusedHeldMany: "{count} more selections were not taken, because these are still waiting. Clear these first.",

  refusedTooMany: "That is more than Relayium will take at once. Try fewer files or a smaller folder.",
  refusedUnsupported: "Some of that is not an ordinary file or folder, so Relayium did not take any of it.",
  refusedEscapes: "That contains a shortcut or link that points somewhere else, so Relayium did not take any of it.",
  refusedCollision: "Two of those would have the same name in the same place, so Relayium did not take any of it.",
  refusedUnreadable: "Relayium could not read that.",
  /**
   * Empty is not unreadable.
   *
   * Reached by right-clicking a folder with nothing in it. It used to fall
   * through to `refusedUnreadable`, which sends somebody to check permissions
   * on a folder whose only problem is that it is empty.
   */
  refusedEmpty: "There was nothing in that to send.",
  refusedUnavailable: "Relayium could not take that just now.",
  /** Refused ALL of it, never part. Stated because partial is the usual bug. */
  refusedNothingTaken: "Nothing was staged.",

  receivedDrag: "Drag to a folder",
} as const;

export type OsEntryMessageKey = keyof typeof osEntryEn;

export const osEntryZh: Record<OsEntryMessageKey, string> = {
  stagedTitle: "准备发送",
  stagedOne: "来自 {roots} 的 1 个文件",
  stagedMany: "来自 {roots} 的 {count} 个文件",
  stagedSize: "共 {size}",
  stagedNote: "还没有发送任何内容。请选择发送目标。",
  clear: "清除",
  refusedHeldOne: "还有 1 次选择没有被接收，因为这些内容仍在等待发送。请先清除。",
  refusedHeldMany: "还有 {count} 次选择没有被接收，因为这些内容仍在等待发送。请先清除。",

  refusedTooMany: "数量超出 Relayium 一次能处理的上限。请减少文件或选择更小的文件夹。",
  refusedUnsupported: "其中包含不是普通文件或文件夹的内容，因此 Relayium 没有接收任何内容。",
  refusedEscapes: "其中包含指向别处的快捷方式或链接，因此 Relayium 没有接收任何内容。",
  refusedCollision: "其中两项会出现在同一位置且同名，因此 Relayium 没有接收任何内容。",
  refusedUnreadable: "Relayium 无法读取该内容。",
  refusedEmpty: "其中没有可发送的内容。",
  refusedUnavailable: "Relayium 现在无法接收该内容。",
  refusedNothingTaken: "没有暂存任何内容。",

  receivedDrag: "拖到文件夹",
};

const CATALOGUES = { en: osEntryEn, zh: osEntryZh } as const;

/** One OS-entry string. Named `ot` so it cannot be confused with the app's `t`. */
export function ot(key: OsEntryMessageKey, values: Record<string, string | number> = {}): string {
  const catalogue = CATALOGUES[lang()] as Record<OsEntryMessageKey, string>;
  const template = catalogue[key] ?? osEntryEn[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
