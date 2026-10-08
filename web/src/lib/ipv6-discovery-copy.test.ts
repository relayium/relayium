// Same-network discovery puts code-less LAN clients in one room by the address
// the server observes: the exact address over IPv4, the address's /64 over IPv6
// (server/internal/signal/roomkey.go). Devices that will meet over IPv6 usually
// show DIFFERENT public addresses, so every maintained surface that used to say
// "two different public IPs mean two rooms" became wrong for them. These pin the
// corrected copy in English and Simplified Chinese, and the device card's note.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Hero from "./Hero.svelte";
import { loadLang, setLang, messages } from "./i18n.svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

let target: HTMLDivElement | undefined;
let app: unknown;

function renderHero(props: Record<string, unknown>) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Hero as never, {
    target,
    props: { connState: "ready", unsupported: false, selfName: "Mac-938", onRename: () => {}, ...props },
  });
  flushSync();
  return target;
}

beforeEach(async () => {
  await loadLang("en");
  await loadLang("zh");
  await setLang("en");
});

afterEach(async () => {
  if (app) unmount(app);
  app = undefined;
  target?.remove();
  await setLang("en");
});

// Visible-group arithmetic is wrong for compressed IPv6: "2001:db8::1" shows
// three groups, and its first four are 2001, db8, 0 and 0. The room is the
// address's first 64 bits, so no maintained surface may describe it as the
// "first four groups" a reader can see, and the device card asks the reader to
// compare nothing at all.
const MISLEADING: Record<"en" | "zh", RegExp[]> = {
  en: [/\bfirst (?:four|4) (?:visible )?groups\b/i, /\bfour groups\b/i],
  zh: [/前\s*(?:四|4)\s*组/],
};
const notMisleading = (lang: "en" | "zh", text: string) => {
  for (const re of MISLEADING[lang]) expect(text, String(re)).not.toMatch(re);
};

describe("the device card around an IPv6 address", () => {
  // Full, compressed, and compressed-with-embedded-zero spellings: the card
  // shows each exactly as observed, never a prefix, and the note is the same.
  for (const v6 of ["2001:db8:1234:5678:a1b2:c3d4:e5f6:789a", "2001:db8::1", "2001:db8:0:0:1::5"]) {
    it(`shows ${v6} exactly and explains IPv6 discovery without asking for a comparison`, () => {
      const hero = renderHero({ selfIP: v6 });
      expect(hero.querySelector(".ip")!.textContent).toBe(v6);
      expect(hero.textContent).not.toContain("/64");
      expect(hero.querySelector(".ip-note")!.textContent).toBe(messages.en.ipv6Note);
      notMisleading("en", hero.textContent!);
    });

    it(`translates the note with the page for ${v6}`, async () => {
      await setLang("zh");
      const hero = renderHero({ selfIP: v6 });
      expect(hero.querySelector(".ip")!.textContent).toBe(v6);
      expect(hero.querySelector(".ip-note")!.textContent).toBe(messages.zh.ipv6Note);
      notMisleading("zh", hero.textContent!);
    });
  }

  it("adds nothing for an IPv4 address, whose room is still that exact address", () => {
    const hero = renderHero({ selfIP: "203.0.113.9" });
    expect(hero.querySelector(".ip")!.textContent).toBe("203.0.113.9");
    expect(hero.querySelector(".ip-note")).toBeNull();
  });

  it("adds nothing before the connection is ready, when no address is shown", () => {
    const hero = renderHero({ selfIP: "2001:db8::1", connState: "reconnecting" });
    expect(hero.querySelector(".ip")).toBeNull();
    expect(hero.querySelector(".ip-note")).toBeNull();
  });
});

describe("the maintained discovery copy", () => {
  it("says IPv6 addresses can differ, that listing is not trust, and to pair if missing", () => {
    const en = messages.en.ipv6Note;
    expect(en).toMatch(/IPv6/);
    expect(en).toMatch(/can show different public addresses and still find each other/);
    expect(en).toMatch(/does not make a device trusted/);
    expect(en).toMatch(/pairing code/);
    const zh = messages.zh.ipv6Note;
    expect(zh).toMatch(/IPv6/);
    expect(zh).toContain("可能显示不同的公网地址，仍能互相发现");
    expect(zh).toContain("不代表对方可信");
    expect(zh).toContain("配对码");
    // The card note asks the reader to compare no network identifier at all.
    for (const note of [en, zh]) expect(note).not.toMatch(/\/64|prefix|前缀|64 ?bits|64 ?位/i);
    notMisleading("en", en);
    notMisleading("zh", zh);
  });

  it("no longer says the room is exactly one shared public IP", () => {
    expect(messages.en.step1).not.toMatch(/sharing a public IP form/);
    expect(messages.en.step1).toMatch(/public IPv4 address, or an IPv6 network prefix/);
    expect(messages.zh.step1).not.toContain("同一公网 IP 归为");
    expect(messages.zh.step1).toContain("公网 IPv4 地址相同，或处在同一个 IPv6 网络前缀下");
    notMisleading("en", messages.en.step1);
    notMisleading("zh", messages.zh.step1);
  });

  // Discovery is the server's: AP/client isolation cannot hide a device from the
  // roster. What it can block is the direct path a LAN session needs (the LAN
  // room is issued no relay), so a listed device that will not connect is its
  // symptom.
  it("ties AP isolation to a listed device that cannot connect, not to discovery", () => {
    const enFaq = messages.en.faq.home.map((x) => x.a).join("\n");
    const zhFaq = messages.zh.faq.home.map((x) => x.a).join("\n");
    for (const text of [messages.en.hint, enFaq]) {
      expect(text).toMatch(/isolation/i);
      expect(text).not.toMatch(/isolation[^.]*(?:discover|see each other)/i);
      expect(text).not.toMatch(/can.t see each other[^.]*isolation/i);
      expect(text).toMatch(/direct connections between devices/);
    }
    expect(messages.en.hint).toMatch(/listed but cannot connect/);
    expect(messages.en.hint).toMatch(/pairing code/);
    expect(enFaq).toMatch(/listed but will not connect/);
    for (const text of [messages.zh.hint, zhFaq]) {
      expect(text).toContain("AP 隔离");
      expect(text).not.toMatch(/隔离[^。]*(?:发现|看不到)/);
      expect(text).not.toMatch(/看不到[^。]*隔离/);
      expect(text).toContain("设备之间的直连");
    }
    expect(messages.zh.hint).toContain("已列出却连不上");
    expect(zhFaq).toContain("已经列出却连不上");
  });

  it("names an IPv4/IPv6 mix as a sure miss and a VPN only as a possible one", () => {
    const enFaq = messages.en.faq.home.map((x) => x.a).join("\n");
    expect(enFaq).toMatch(/one device on IPv4 and the other on IPv6 land in different rooms/);
    expect(enFaq).toMatch(/a VPN may do the same/);
    expect(enFaq).not.toMatch(/VPN[^.]*will not/);
    const zhFaq = messages.zh.faq.home.map((x) => x.a).join("\n");
    expect(zhFaq).toContain("一台走 IPv4、另一台走 IPv6 会落在不同的房间");
    expect(zhFaq).toContain("也可能出现这种情况");
    notMisleading("en", enFaq);
    notMisleading("zh", zhFaq);
  });
});

describe("the same-network how-to guides", () => {
  // Loaded at run time, not imported: a static import would pull the untyped
  // page-generator modules into the app's type-checked graph.
  const names = [
    "howto-same-wifi",
    "howto-pc-to-phone-wirelessly",
    "howto-android-to-iphone",
    "howto-mac-to-windows",
    "howto-airdrop-for-windows-android",
    "howto-send-text-between-devices",
  ];
  const articles = resolve(import.meta.dirname, "..", "..", "scripts", "pages", "content", "articles");
  const load = async (name: string): Promise<{ langs: Record<string, unknown> }> =>
    (await import(/* @vite-ignore */ pathToFileURL(resolve(articles, `${name}.mjs`)).href)).default;
  // Claim shapes that are false for an IPv6 network: two devices there usually
  // show two different addresses and still share a room.
  const retired: Record<"en" | "zh", RegExp[]> = {
    en: [
      /two different public IP addresses mean/i,
      /two different addresses mean two/i,
      // Unqualified only: "Over IPv4, one shared address is what…" is correct.
      /(?<!over IPv4, (?:a )?)\b(?:one shared|a matching|matching) address(?:es)? (?:is what|put)/i,
      /share (?:a|one|the same) public IP\b(?! ?v)/i,
      /sharing a public IP\b(?! ?v)/i,
      /IPv6 has no NAT|never (?:uses? )?NAT/i,
      /isolation[^.]*(?:stops|prevents)[^.]*discover/i,
    ],
    zh: [
      /两个不同的公网 IP 就是/,
      /两个不同地址就是/,
      /共享同一个公网 IP(?!v)/,
      /共享同一个地址/,
      // Unqualified: an IPv4-scoped "走 IPv4 时，地址相同才…" is the corrected form.
      /[。：]地址(?:一致|相同)才/,
      /隔离[^。]*阻止[^。]*发现/,
    ],
  };
  type Item = { symptom?: string; fix?: string };
  const items = (node: unknown, out: Item[] = []): Item[] => {
    if (Array.isArray(node)) node.forEach((n) => items(n, out));
    else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.symptom === "string" && typeof o.fix === "string") out.push(o as Item);
      Object.values(o).forEach((v) => items(v, out));
    }
    return out;
  };

  // Same-network grouping is a discovery heuristic: it neither authenticates
  // anyone nor makes a peer trusted, and a LAN room is bounded by the server's
  // room and connection limits. The same-Wi-Fi guide used to say the opposite of
  // both, so the old clauses are rejected and the replacements are pinned.
  describe("howto-same-wifi on accounts, trust and room size", () => {
    const retiredTrust: Record<"en" | "zh", RegExp[]> = {
      en: [
        /same trusted network/i,
        /(?:does not|doesn't) need sign-in to know who should be allowed/i,
        /holds however many devices/i,
        /\b(?:lists|holds) every device\b/i,
        /\bevery device that opened the page\b/i,
        /a classroom of phones can all see each other/i,
      ],
      zh: [
        /可信网络/,
        /不需要靠登录来判断谁能连谁/,
        /有多少[^。]*就能容纳多少/,
        /凡是从该网络打开页面的设备/,
        /的每台设备都会列在房间里/,
      ],
    };
    for (const lang of ["en", "zh"] as const) {
      it(`[${lang}] rejects the trusted-network and unlimited-room clauses`, async () => {
        const text = JSON.stringify((await load("howto-same-wifi")).langs[lang]);
        for (const re of retiredTrust[lang]) expect(text, String(re)).not.toMatch(re);
      });
    }

    it("[en] states the account policy, discovery-not-trust, and a bounded room", async () => {
      const text = JSON.stringify((await load("howto-same-wifi")).langs.en);
      expect(text).toMatch(/sending and receiving on the same network work without sign-in/);
      expect(text).toMatch(/That is an account policy, not a judgement about who is on the network/);
      expect(text).toMatch(/does not identify the people behind them or make a device trustworthy/);
      expect(text).toMatch(/anyone else on that network can appear in the list under a name they chose themselves/);
      expect(text).toMatch(/read what an incoming request says before accepting files/);
      expect(text).toMatch(/turn on advanced verification/);
      expect(text).toMatch(/not capped at two participants/);
      expect(text).toMatch(/The server does limit how many devices one room holds and how many connections it accepts/);
      expect(text).toMatch(/up to the server's limit on how many devices one room holds/);
      // No blanket consent claim for messages, and no promise of authenticating a hostile peer.
      expect(text).not.toMatch(/every (?:message|text)[^.]{0,40}(?:accept|approv|consent)/i);
      expect(text).not.toMatch(/(?:proves|guarantees|verifies) (?:who|the identity)/i);
    });

    it("[zh] states the account policy, discovery-not-trust, and a bounded room", async () => {
      const text = JSON.stringify((await load("howto-same-wifi")).langs.zh);
      expect(text).toContain("在同一网络里收发都无需登录");
      expect(text).toContain("这是账号方面的规定，并不是对网络里有谁的判断");
      expect(text).toContain("它既不识别设备背后是谁，也不会让设备变得可信");
      expect(text).toContain("同一网络里的其他人同样可能出现在列表里，名字也是他们自己起的");
      expect(text).toContain("接收文件前看清请求里写的内容");
      expect(text).toContain("「高级验证」");
      expect(text).toContain("这个房间不限于两个人");
      expect(text).toContain("服务器对一个房间能容纳的设备数和接受的连接数都有上限");
      expect(text).toContain("上限是服务器对一个房间能容纳设备数的限制");
      expect(text).not.toMatch(/每条(?:消息|文本)[^。]{0,20}(?:接受|同意|确认)/);
      expect(text).not.toMatch(/(?:证明|保证|验证)(?:对方)?(?:是谁|身份)/);
    });
  });

  // The same unbounded-room claim lived in two device-pair guides. A room lists
  // several devices, but the server caps room size and connections.
  describe("device-pair guides keep the room bounded", () => {
    const cases = {
      "howto-pc-to-phone-wirelessly": {
        en: { old: /room holds every device that opened the page/i, now: "A same-network room can list several devices that opened the page from that network, up to the server's limits on room size and connections" },
        zh: { old: /同网络房间会容纳所有从该网络打开页面的设备/, now: "同网络房间可以同时列出多台从该网络打开页面的设备（以服务器对房间人数和连接数的上限为限）" },
      },
      "howto-airdrop-for-windows-android": {
        en: { old: /every nearby device that opened the page is listed at once/i, now: "several nearby devices that opened the page can be listed at once, up to the server's limits on room size and connections" },
        zh: { old: /从该网络打开页面的每台设备都会同时列出来/, now: "从该网络打开页面的多台设备可以同时列出来（以服务器对房间人数和连接数的上限为限）" },
      },
    } as const;
    for (const [name, byLang] of Object.entries(cases)) {
      for (const lang of ["en", "zh"] as const) {
        it(`${name} [${lang}] lists several devices within the server's limits, not every device`, async () => {
          const text = JSON.stringify((await load(name)).langs[lang]);
          expect(text).not.toMatch(byLang[lang].old);
          expect(text).toContain(byLang[lang].now);
          // Still more than a pair: the multi-device statement is kept, not removed.
          expect(text).toMatch(lang === "en" ? /several (?:nearby )?devices/ : /多台/);
        });
      }
    }
  });

  for (const name of names) {
    for (const lang of ["en", "zh"] as const) {
      it(`${name} [${lang}] states the IPv4/IPv6 rule and no retired or misleading claim`, async () => {
        const guide = await load(name);
        expect(guide.langs[lang]).toBeTruthy();
        const text = JSON.stringify(guide.langs[lang]);
        for (const re of retired[lang]) expect(text, String(re)).not.toMatch(re);
        notMisleading(lang, text);
        expect(text).toMatch(/IPv6/);
        if (/公网 IP|public IP/.test(text)) expect(text).toMatch(/IPv4/);
      });

      it(`${name} [${lang}] files AP isolation under a listed device that will not connect`, async () => {
        const guide = await load(name);
        const iso = items(guide.langs[lang]).filter((i) => /AP isolation|AP 隔离/.test(i.fix!));
        // Every device-pair guide has such an entry; none may pass by having none.
        expect(iso.length).toBe(name === "howto-send-text-between-devices" ? 0 : 1);
        for (const i of iso) {
          // The device IS listed; what fails is the connection. The fix quotes the
          // shipped workspace labels, so the reading is an exact on-screen one.
          // (The labels stay out of the symptom on purpose: the tutorial
          // validator's "names nothing concrete" mutation proof relies on this
          // symptom carrying nothing concrete by itself.)
          expect(i.symptom).toMatch(lang === "en" ? /are listed, but opening the workspace never connects/ : /都列出来了，但打开工作区后始终连不上/);
          expect(i.symptom).not.toMatch(lang === "en" ? /cards? [^.]*appear/i : /不出现/);
          expect(i.fix).toContain(messages[lang].workspace.stateConnecting);
          expect(i.fix).toContain(messages[lang].workspace.stateFailed);
          expect(i.fix).toMatch(lang === "en" ? /\bmay be separating\b/ : /可能是.{0,4}把自己的客户端隔开/);
          expect(i.fix).toMatch(/cross-network/);
        }
      });
    }
  }
});

// llms.txt is hand-maintained (not page-generated) and is what crawlers and
// assistants quote. Read at run time so the test adds nothing to the type graph.
describe("llms.txt describes same-network grouping truthfully", () => {
  const llms = readFileSync(resolve(import.meta.dirname, "..", "..", "public", "llms.txt"), "utf8");
  const sameNetwork = llms.split("\n").find((l) => l.startsWith("- **Same-network (default):**")) ?? "";

  it("no longer says a room is one shared public IP", () => {
    expect(sameNetwork).not.toBe("");
    expect(llms).not.toMatch(/by shared public IP\b/i);
    expect(llms).not.toMatch(/\bshar(?:e|ing) (?:a|one|the same) public IP\b(?! ?v)/i);
  });

  it("states exact IPv4, IPv6 /64, discovery-not-trust and the pairing-code fallback", () => {
    expect(sameNetwork).toMatch(/by the exact public IPv4 address/);
    expect(sameNetwork).toMatch(/by the IPv6 \/64 prefix/);
    expect(sameNetwork).toMatch(/a discovery heuristic, not proof of trust/);
    expect(sameNetwork).toMatch(/different address families or prefixes may need a pairing code/);
    for (const re of [/\bfirst (?:four|4) (?:visible )?groups\b/i, /IPv6 has no NAT/i]) expect(llms).not.toMatch(re);
  });
});
