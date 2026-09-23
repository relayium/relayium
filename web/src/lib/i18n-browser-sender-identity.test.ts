// web/src/lib/i18n-browser-sender-identity.test.ts
//
// The two refusals a browser can get when it tries to become a sender
// (POST /api/devices/browser-install, server/account/handlers.go), in every
// maintained language. Both copies are shown instead of a send, so each must say
// what actually happened and the one step that really helps:
//
//  * browser_device_revoked (shown via SendFailure "sender_device_required"):
//    central expires the stale cookie in the same response, so the NEXT send
//    mints a fresh identity on its own. No reload and no sign-in is needed, and
//    the copy must not send the person looking for one.
//
//  * browser_device_limit: central refuses the 21st browser row for an account
//    (MaxBrowserDevicesPerAccount, server/account/store.go). No client lists or
//    removes browser rows (device-list.ts filters them out; Apple's
//    holdsRevocableToken excludes them), so there is no self-service fix. The copy
//    must say so, name the number central enforces, point to the only real ways
//    forward (a browser that already sent from this account, or support), and
//    never suggest signing in again, which cannot free a place.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";

const storeGo = readFileSync(
  resolve(import.meta.dirname, "..", "..", "..", "server", "account", "store.go"),
  "utf8",
);
const limitMatch = storeGo.match(/const MaxBrowserDevicesPerAccount = (\d+)/);

const claims = {
  en: {
    nothingSent: "nothing was sent",
    automatic: "automatically",
    staleRemedies: [/reload/i, /refresh/i, /sign in/i, /enrol/i],
    limitCount: (n: string) => `maximum of ${n} browsers`,
    noSelfService: "can't yet be removed from the account yourself",
    previousBrowser: "a browser that has sent from this account before",
    support: "contact support",
    signInWontHelp: "Signing in again won't change this",
    signInAdvice: /\b(sign|log) in again (and|to|then)\b/i,
  },
  zh: {
    nothingSent: "没有发送任何内容",
    automatic: "自动",
    staleRemedies: [/刷新/, /重新登录/, /登录/],
    limitCount: (n: string) => `上限（${n} 个）`,
    noSelfService: "目前还不能自行从账户中移除",
    previousBrowser: "以前从此账户发送过的浏览器",
    support: "联系支持",
    signInWontHelp: "重新登录不会改变这一点",
    signInAdvice: /重新登录(后|再|即可|以)/,
  },
} as const;

describe("browser sender identity refusals", () => {
  it("reads the limit central enforces", () => {
    expect(limitMatch, "MaxBrowserDevicesPerAccount not found in store.go").not.toBeNull();
  });

  for (const [code, m] of Object.entries({ en, zh }) as ["en" | "zh", typeof en][]) {
    const c = claims[code];
    const revoked = m.deviceInbox.sendErrSenderIdentity;
    const limit = m.deviceInbox.sendErrBrowserDeviceLimit;

    it(`${code}: a revoked identity says the next send re-registers it`, () => {
      expect(revoked.toLowerCase()).toContain(c.nothingSent.toLowerCase());
      expect(revoked).toContain(c.automatic);
      for (const stale of c.staleRemedies) {
        expect(revoked, `${code}: suggests a step the next send does not need`).not.toMatch(stale);
      }
    });

    it(`${code}: the browser limit is honest about having no self-service fix`, () => {
      expect(limit.toLowerCase()).toContain(c.nothingSent.toLowerCase());
      expect(limit, `${code}: number differs from MaxBrowserDevicesPerAccount`).toContain(
        c.limitCount(limitMatch![1]),
      );
      expect(limit).toContain(c.noSelfService);
      expect(limit).toContain(c.previousBrowser);
      expect(limit).toContain(c.support);
      expect(limit).toContain(c.signInWontHelp);
      expect(limit, `${code}: advises signing in again`).not.toMatch(c.signInAdvice);
    });
  }
});
