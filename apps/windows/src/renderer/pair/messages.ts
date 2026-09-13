// The handoff's vocabulary, in the two maintained languages.
//
// A local catalogue on the existing `lang()`. `zh` is typed as the same key set
// as `en`, so a missing translation is a compile error.

import { lang } from "../i18n/index.svelte.js";

export const pairEn = {
  scanHint: "Scan this with the other device's camera.",
  /** Shown when the encoder was unavailable. The code still works. */
  qrUnavailable: "A QR code could not be drawn on this PC. The code and link below still work.",
  qrAlt: "QR code for the join link",
  qrRendering: "Drawing the code…",
  linkLabel: "Join link",
  copyLink: "Copy link",
  copied: "Copied",
  copyExpired: "That code has expired. Create a new one to share it.",
  copyFailed: "The link could not be copied.",
  /** The fragment rule, said once so a person knows why the link looks odd. */
  linkNote: "The code travels in the part of the link after #, so it is not sent to our servers.",
  idle: "Create a pairing code to show a QR code and a join link.",
} as const;

export type PairMessageKey = keyof typeof pairEn;

export const pairZh: Record<PairMessageKey, string> = {
  scanHint: "用另一台设备的相机扫描。",
  qrUnavailable: "这台电脑无法绘制二维码。下面的配对码和链接仍然可用。",
  qrAlt: "加入链接的二维码",
  qrRendering: "正在生成二维码…",
  linkLabel: "加入链接",
  copyLink: "复制链接",
  copied: "已复制",
  copyExpired: "这个配对码已过期。请重新生成后再分享。",
  copyFailed: "无法复制链接。",
  linkNote: "配对码放在链接 # 之后的部分，因此不会发送到我们的服务器。",
  idle: "先创建配对码，才会显示二维码和加入链接。",
};

const CATALOGUES = { en: pairEn, zh: pairZh } as const;

/** One handoff string. Named `pt` so it cannot be confused with the app's `t`. */
export function pt(key: PairMessageKey, values: Record<string, string | number> = {}): string {
  const catalogue = CATALOGUES[lang()] as Record<PairMessageKey, string>;
  const template = catalogue[key] ?? pairEn[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
