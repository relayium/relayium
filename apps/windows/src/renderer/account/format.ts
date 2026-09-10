// Turning account numbers into something a person can read, without ever
// inventing one.
//
// Everything here is pure and synchronous, which is deliberate: these are the
// functions that decide whether a screen says "unlimited" or "100% full", and
// that decision has to be testable without a component, a bridge or a clock.
//
// ## The rule that everything else follows from
//
// **`0` is unlimited.** Not "none", not "zero left", not "full". It comes
// straight through from the server and `src/shared/account-summary.ts` states
// it; here it means a quota with no bar, no percentage and no fraction — because
// a progress bar needs a denominator and there isn't one.
//
// The companion rule is the reason the `unknown` case exists at all: a read that
// FAILED must never arrive here. A failed section is rendered as a failure by
// the component, so nothing in this file is ever asked to format a number that
// was not actually read. `unknown` exists for the narrower case of a value that
// arrived and is not usable — a negative, a NaN — and it renders as "—", never
// as zero.

import type { AccountCap } from "../../shared/account-summary.js";

/** en, or Simplified Chinese. The two maintained languages. */
export type FormatLang = "en" | "zh";

const LOCALE: Record<FormatLang, string> = { en: "en", zh: "zh-Hans" };

/**
 * How full something is.
 *
 * Three cases, and the third is not a failure — it is a number that arrived and
 * cannot be believed. Keeping it separate from `limited` is what stops a
 * malformed `used` becoming a bar at 0%, which reads as "you have used nothing"
 * rather than as "this did not make sense".
 */
export type Quota =
  | { readonly kind: "unlimited"; readonly used: number }
  | {
      readonly kind: "limited";
      readonly used: number;
      readonly cap: number;
      /** 0…1, clamped. Over-quota renders as full, never as more than full. */
      readonly fraction: number;
    }
  | { readonly kind: "unknown" };

const usable = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * A used/cap pair, judged.
 *
 * `cap === 0` short-circuits BEFORE any division, which is the whole point: the
 * division that would produce `Infinity` or `NaN` never happens, so there is no
 * path by which an unlimited quota acquires a percentage.
 */
export function quotaOf(used: number, cap: AccountCap): Quota {
  if (!usable(used) || !usable(cap)) return { kind: "unknown" };
  if (cap === 0) return { kind: "unlimited", used };
  return { kind: "limited", used, cap, fraction: Math.min(1, used / cap) };
}

/**
 * Human byte size — binary units, one decimal below 10.
 *
 * The thresholds and the unit labels are `web/src/lib/format.ts`'s, because a
 * person who has seen "3.7 MB" in the browser should see the same string here.
 * What is added is the LOCALE: the numeral is formatted with `Intl` rather than
 * `toFixed`, so a language whose decimal separator or digits differ is rendered
 * correctly rather than in en-US by accident.
 */
export function formatBytes(bytes: number, lang: FormatLang): string {
  if (!usable(bytes)) return "—";
  const locale = LOCALE[lang];
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${units[index]}`;
}

/** A whole percentage for a bounded quota, and nothing for an unbounded one. */
export function formatPercent(quota: Quota, lang: FormatLang): string | null {
  if (quota.kind !== "limited") return null;
  return new Intl.NumberFormat(LOCALE[lang], {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(quota.fraction);
}

/**
 * A server timestamp, in the reader's locale.
 *
 * The wire carries UNIX SECONDS — `handlers.go` writes `time.Unix()` values —
 * so the multiplication happens here, once, rather than in four call sites where
 * one of them would eventually forget and render 1970.
 *
 * `0` is the server's "never"/"not set" and returns `null` rather than the epoch.
 * A screen showing "1 January 1970" for a device that has never been seen is
 * worse than a screen showing nothing.
 */
export function formatDateTime(unixSeconds: number, lang: FormatLang): string | null {
  if (!usable(unixSeconds) || unixSeconds === 0) return null;
  const at = new Date(unixSeconds * 1000);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat(LOCALE[lang], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}

/** The same, without the time. For a renewal or a period reset. */
export function formatDate(unixSeconds: number, lang: FormatLang): string | null {
  if (!usable(unixSeconds) || unixSeconds === 0) return null;
  const at = new Date(unixSeconds * 1000);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: "medium" }).format(at);
}

/**
 * A span in seconds, reduced to one unit a person would actually say.
 *
 * Structured rather than a string so the wording stays in the catalogue: "7
 * days" and "7 天" are not the same sentence with a different word swapped in,
 * and building them by concatenation here would put half of a translation in a
 * formatting module.
 */
export type Duration = { readonly unit: "day" | "hour" | "minute"; readonly value: number };

export function durationOf(seconds: number): Duration | null {
  if (!usable(seconds) || seconds === 0) return null;
  if (seconds >= 86_400) return { unit: "day", value: Math.floor(seconds / 86_400) };
  if (seconds >= 3_600) return { unit: "hour", value: Math.floor(seconds / 3_600) };
  return { unit: "minute", value: Math.max(1, Math.floor(seconds / 60)) };
}

/**
 * The last few characters of a device id, as a disambiguator.
 *
 * `web/src/lib/device-identity.ts`'s rule, for its reason: two of a person's
 * machines can honestly be called "Laptop", and a confirmation that cannot tell
 * them apart is a confirmation of nothing. Returns "" when the id carries too
 * little to shorten, which callers render as no badge rather than an empty one.
 */
export function deviceSuffix(id: string): string {
  const usableChars = id.replace(/[^0-9A-Za-z]/g, "");
  if (usableChars.length < 6) return "";
  return usableChars.slice(-4);
}

/**
 * Trimmed, with internal whitespace runs collapsed.
 *
 * The renderer's copy, and it is only ever used for the character counter and
 * for disabling a Save button over an empty field. MAIN re-normalises with its
 * own copy before anything is sent and the SERVER decides — the control
 * character, bidi and length rules live in `internal/devicelabel` and are
 * deliberately not restated in any client.
 *
 * `account-summary-view.test.ts` runs this, main's copy and the web module over
 * one table and requires all three to agree, so "three copies" is a fact the
 * board checks rather than a comment nobody reads.
 */
export function normalizeDeviceName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * A device kind, in the casing the platform actually spells itself.
 *
 * The server stores a lowercase token (`cli` and `browser` are the two its own
 * tests exercise) and the wire carries it verbatim. Rendering that token raw put
 * "windows" on screen beside "Windows" everywhere else in the product, which
 * reads as a typo rather than as data.
 *
 * Brand names, so there is nothing to translate: "macOS" is macOS in both
 * maintained languages. A kind this build has never heard of is returned
 * UNCHANGED rather than title-cased into something that looks official — a
 * descriptor invented by a client is worse than one it simply passes through.
 */
const DEVICE_KINDS: Readonly<Record<string, string>> = {
  cli: "CLI",
  browser: "Browser",
  web: "Web",
  windows: "Windows",
  macos: "macOS",
  mac: "macOS",
  darwin: "macOS",
  ios: "iOS",
  ipados: "iPadOS",
  android: "Android",
  linux: "Linux",
};

export function deviceKindLabel(kind: string): string {
  return DEVICE_KINDS[kind.toLowerCase()] ?? kind;
}

/** Code points, not UTF-16 units. The server counts runes; so does this. */
export const runeLength = (value: string): number => [...value].length;
