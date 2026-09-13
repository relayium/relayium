// The functions that decide whether the account screen tells the truth about a
// number, and the catalogue that decides whether it can say it in both
// languages.
//
// These are the smallest pieces and they carry the largest lie risk: a quota
// with no limit rendered as "100% full", a read that failed rendered as zero
// bytes, a timestamp the server never set rendered as 1 January 1970. Each of
// those is one line of arithmetic away, which is exactly why the arithmetic is
// in a pure module with its own cases.

import { describe, expect, it } from "vitest";
import {
  deviceKindLabel,
  deviceSuffix,
  durationOf,
  formatBytes,
  formatDate,
  formatDateTime,
  formatPercent,
  normalizeDeviceName,
  quotaOf,
  runeLength,
} from "../../src/renderer/account/format.js";
import { accountEn, accountZh } from "../../src/renderer/account/messages.js";
import { normalizeDeviceNameDefault } from "../../src/main/features/account-summary.js";
import { normalizeDeviceName as webNormalizeDeviceName } from "../../../../web/src/lib/device-identity.js";
import {
  ACCOUNT_SUMMARY_LOADING,
  isAccountExternalTarget,
  signedOutAccountView,
} from "../../src/shared/account-summary.js";

describe("a cap of zero is unlimited, and never full", () => {
  it("produces no fraction and no percentage", () => {
    const quota = quotaOf(9_999_999, 0);
    expect(quota).toEqual({ kind: "unlimited", used: 9_999_999 });
    expect(formatPercent(quota, "en")).toBeNull();
    // The failure this exists to prevent: dividing by the cap would give
    // Infinity, and clamping that gives 1 — a full bar over an unlimited quota.
    expect(quota).not.toHaveProperty("fraction");
  });

  it("is unlimited even when nothing has been used", () => {
    expect(quotaOf(0, 0)).toEqual({ kind: "unlimited", used: 0 });
  });
});

describe("a bounded quota", () => {
  it("reports the fraction actually used", () => {
    expect(quotaOf(250, 1000)).toEqual({ kind: "limited", used: 250, cap: 1000, fraction: 0.25 });
    expect(formatPercent(quotaOf(250, 1000), "en")).toBe("25%");
  });

  it("clamps over-quota to full rather than beyond it", () => {
    const quota = quotaOf(3000, 1000);
    if (quota.kind !== "limited") throw new Error("expected a bounded quota");
    expect(quota.fraction).toBe(1);
    expect(formatPercent(quota, "en")).toBe("100%");
  });

  it("refuses a value it cannot believe instead of rendering zero", () => {
    // Not `{ used: 0 }`: "you have used nothing" is a different claim from
    // "this number did not make sense", and only one of them is true.
    expect(quotaOf(-1, 1000)).toEqual({ kind: "unknown" });
    expect(quotaOf(Number.NaN, 1000)).toEqual({ kind: "unknown" });
    expect(quotaOf(10, -5)).toEqual({ kind: "unknown" });
    expect(quotaOf(10, Number.POSITIVE_INFINITY)).toEqual({ kind: "unknown" });
    expect(formatPercent(quotaOf(-1, 1000), "en")).toBeNull();
  });
});

describe("byte sizes", () => {
  it("uses the same thresholds and units as the web client", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(1023, "en")).toBe("1,023 B");
    expect(formatBytes(1024, "en")).toBe("1.0 KB");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 10, "en")).toBe("10 MB");
    expect(formatBytes(1024 ** 3, "en")).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4 * 5, "en")).toBe("5.0 TB");
    // Bigger than the largest unit still reads in that unit, not in scientific
    // notation.
    expect(formatBytes(1024 ** 5, "en")).toBe("1,024 TB");
  });

  it("formats in both maintained languages without throwing", () => {
    for (const lang of ["en", "zh"] as const) {
      expect(formatBytes(1536, lang)).toMatch(/KB$/);
      expect(formatBytes(0, lang)).toMatch(/B$/);
    }
  });

  it("renders an unusable number as a dash, never as zero", () => {
    expect(formatBytes(Number.NaN, "en")).toBe("—");
    expect(formatBytes(-1, "en")).toBe("—");
  });
});

describe("timestamps", () => {
  it("treats the server's zero as 'not set' rather than as 1970", () => {
    expect(formatDate(0, "en")).toBeNull();
    expect(formatDateTime(0, "en")).toBeNull();
  });

  it("reads the wire as UNIX SECONDS", () => {
    // 2026-09-11T00:00:00Z. Seconds, as `handlers.go` writes them; interpreting
    // this as milliseconds would land in January 1970.
    const rendered = formatDate(1_789_084_800, "en");
    expect(rendered).toContain("2026");
  });

  it("renders in both maintained languages", () => {
    expect(formatDate(1_789_084_800, "zh")).toContain("2026");
    expect(formatDateTime(1_789_084_800, "zh")).toContain("2026");
    // The two languages format differently; if they did not, the locale would
    // not actually be reaching `Intl`.
    expect(formatDate(1_789_084_800, "zh")).not.toBe(formatDate(1_789_084_800, "en"));
  });

  it("refuses a value it cannot turn into a date", () => {
    expect(formatDate(Number.NaN, "en")).toBeNull();
    expect(formatDate(-1, "en")).toBeNull();
    expect(formatDateTime(Number.MAX_SAFE_INTEGER, "en")).toBeNull();
  });
});

describe("durations", () => {
  it("reduces to the unit a person would say", () => {
    expect(durationOf(7 * 86_400)).toEqual({ unit: "day", value: 7 });
    expect(durationOf(90 * 86_400)).toEqual({ unit: "day", value: 90 });
    expect(durationOf(3 * 3_600)).toEqual({ unit: "hour", value: 3 });
    expect(durationOf(90 * 60)).toEqual({ unit: "hour", value: 1 });
    expect(durationOf(30)).toEqual({ unit: "minute", value: 1 });
  });

  it("says nothing for zero, which the caller renders as unlimited", () => {
    expect(durationOf(0)).toBeNull();
    expect(durationOf(-1)).toBeNull();
  });
});

describe("device identity helpers", () => {
  it("shortens an id enough to tell two same-named machines apart", () => {
    expect(deviceSuffix("dev-01234567")).toBe("4567");
    expect(deviceSuffix("abc")).toBe("");
    expect(deviceSuffix("--a--b--")).toBe("");
  });

  it("counts runes, not UTF-16 units", () => {
    expect(runeLength("😀")).toBe(1);
    expect("😀".length).toBe(2);
    expect(runeLength("abc")).toBe(3);
  });

  it("all three copies of the whitespace rule agree", () => {
    // The renderer's (for the counter), main's (before dispatch) and the web
    // client's (the authority). Three copies exist because neither of the first
    // two can import the third; this is the case that stops them drifting.
    const table = [
      "  prod   backup  ",
      "prod\nbackup",
      "   ",
      "prod‮kcab",
      "a\t\tb",
      " padded ",
      "😀   😀",
      "single",
      "",
    ];
    for (const input of table) {
      const web = webNormalizeDeviceName(input);
      expect(normalizeDeviceName(input)).toBe(web);
      expect(normalizeDeviceNameDefault(input)).toBe(web);
    }
  });
});

describe("device kinds render in the casing the platform uses", () => {
  it("brands the kinds this build knows", () => {
    expect(deviceKindLabel("windows")).toBe("Windows");
    expect(deviceKindLabel("macos")).toBe("macOS");
    expect(deviceKindLabel("ios")).toBe("iOS");
    // The two the server's own tests actually store.
    expect(deviceKindLabel("cli")).toBe("CLI");
    expect(deviceKindLabel("browser")).toBe("Browser");
  });

  it("passes an unknown kind through untouched", () => {
    // Not title-cased into something that looks like an official name: a
    // descriptor a client invented is worse than one it simply relays.
    expect(deviceKindLabel("quantum-toaster")).toBe("quantum-toaster");
    expect(deviceKindLabel("")).toBe("");
  });
});

describe("the contract's own constants", () => {
  it("starts loading, not empty", () => {
    expect(ACCOUNT_SUMMARY_LOADING.profile.kind).toBe("loading");
    expect(ACCOUNT_SUMMARY_LOADING.usage.kind).toBe("loading");
    expect(ACCOUNT_SUMMARY_LOADING.devices.kind).toBe("loading");
    expect(Object.isFrozen(ACCOUNT_SUMMARY_LOADING)).toBe(true);
  });

  it("renders signed out as a state, not as an empty account", () => {
    const view = signedOutAccountView(4);
    expect(view.epoch).toBe(4);
    expect(view.signedIn).toBe(false);
    for (const section of [view.profile, view.usage, view.devices]) {
      expect(section).toEqual({ kind: "failed", failure: { kind: "signed-out" } });
      // Deliberately NOT `ready` with empty values: an empty value is a claim
      // about an account, and there is no account.
      expect(section).not.toHaveProperty("value");
    }
  });

  it("admits exactly one external destination", () => {
    expect(isAccountExternalTarget("account-management")).toBe(true);
    expect(isAccountExternalTarget("https://evil.test")).toBe(false);
    expect(isAccountExternalTarget("")).toBe(false);
    expect(isAccountExternalTarget(undefined)).toBe(false);
  });
});

describe("the account catalogue covers both maintained languages", () => {
  const enKeys = Object.keys(accountEn).sort();
  const zhKeys = Object.keys(accountZh).sort();

  it("has the same key set in both", () => {
    expect(zhKeys).toEqual(enKeys);
  });

  it("has no empty string in either", () => {
    for (const key of enKeys) {
      expect(accountEn[key as keyof typeof accountEn].length).toBeGreaterThan(0);
      expect(accountZh[key as keyof typeof accountZh].length).toBeGreaterThan(0);
    }
  });

  it("uses the same placeholders in both, so neither renders a stray brace", () => {
    const holders = (template: string) =>
      [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of enKeys) {
      expect({ key, holders: holders(accountZh[key as keyof typeof accountZh]) }).toEqual({
        key,
        holders: holders(accountEn[key as keyof typeof accountEn]),
      });
    }
  });

  it("is not an English catalogue wearing a Chinese label", () => {
    // A spot check that the translation is real: these are the sentences a
    // person reads when something has gone wrong or when money is involved.
    for (const key of [
      "mutationUncertain",
      "deviceRevokeConfirmSelf",
      "capUnlimited",
      "usageEffectiveNote",
      "failedUnreadable",
      "statusActive",
      "statusPastDue",
      "statusUnrecognised",
    ] as const) {
      expect(accountZh[key]).not.toBe(accountEn[key]);
      expect(accountZh[key]).toMatch(/[一-鿿]/);
    }
  });
});
