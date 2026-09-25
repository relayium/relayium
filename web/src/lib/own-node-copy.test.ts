// What the product says about running your own node must match what the server
// meters (OA-053 Q3, A28 W-C21). Facts, all in server/account:
//  * relay bytes on an own node are not billable, and uploads placed on it skip
//    the traffic meter and daily quota (nodes.go, files.go);
//  * but those files still count in the account's live-storage sum, so they
//    occupy the storage cap (sqlite.go CurrentStorage has no node filter);
//  * relayium.com runs with direct downloads off (server/main.go
//    -direct-download default false), so every download of such a file is
//    carried by Relayium and metered;
//  * once the monthly allowance is spent, /api/ice withholds every relay, own
//    nodes included, while a direct path may still connect (turn.go).
// These tests pin the corrected sentences and keep the old promises out.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";

const contentDir = resolve(import.meta.dirname, "..", "..", "scripts", "pages", "content");
const pageSources = [
  resolve(contentDir, "..", "..", "..", "public", "llms.txt"),
  resolve(contentDir, "spa-pages.mjs"),
  ...readdirSync(resolve(contentDir, "articles")).map((f) => resolve(contentDir, "articles", f)),
].map((p) => [p, readFileSync(p, "utf8")] as const);

describe("own-node copy", () => {
  const ownNode = {
    en: [en.pricingPage.subtitle, en.pricingPage.selfhostBody, en.pricingPage.a4, en.why.selfhostBody],
    zh: [zh.pricingPage.subtitle, zh.pricingPage.selfhostBody, zh.pricingPage.a4, zh.why.selfhostBody],
  };

  it("says own-node files still count toward the storage cap", () => {
    for (const s of ownNode.en) expect(s).toMatch(/storage cap/i);
    for (const s of ownNode.zh) expect(s).toContain("存储上限");
  });

  it("does not promise free downloads straight from the node", () => {
    for (const s of [...ownNode.en, ...ownNode.zh]) {
      expect(s).not.toMatch(/straight from your node|直接从你的节点取/);
    }
  });

  it("does not offer a stored link or an own node as the way round a spent allowance", () => {
    for (const s of [en.crossnet.relayQuotaWarn, en.crossnet.relayQuotaFail]) {
      expect(s).not.toMatch(/stored download link|run your own node/i);
    }
    for (const s of [zh.crossnet.relayQuotaWarn, zh.crossnet.relayQuotaFail]) {
      expect(s).not.toMatch(/下载链接|运行自己的节点/);
    }
  });

  const banned: RegExp[] = [
    /at any volume/i,
    /free no matter how large/i,
    /nothing metered, nothing billed/i,
    /relay & storage for free/i,
    /prefer it automatically/i,
    /an upgrade, or your own node/i,
    /任意用量/,
    /无论用量多大都免费/,
    /不计量、不收费/,
    /免费使用 Relayium 的中继/,
    /或者用自己的节点/,
    /removes the (limits|metering)/i,
    /relay and storage traffic it carries/i,
    /它承载的中继与存储流量/,
  ];
  it.each(pageSources.map(([p, src]) => [p.split("/web/")[1], src]))("%s keeps the corrected own-node claims", (_name, src) => {
    for (const re of banned) expect(src).not.toMatch(re);
  });
});
