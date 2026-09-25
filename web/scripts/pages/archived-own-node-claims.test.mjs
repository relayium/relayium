// web/scripts/pages/archived-own-node-claims.test.mjs — W-N47. The archived
// (frozen) translations of the own-node guide and three how-tos used to promise
// that a node you run yourself makes relay and storage free at any volume, and
// offered "your own node" as the way past a spent monthly allowance. Neither is
// true (server/account, see web/src/lib/own-node-copy.test.ts for the en/zh
// half): files stored on your node still count toward the storage cap, every
// download of them is carried by Relayium and metered, and once the allowance
// is spent no relay is offered on your own node either — only a direct path may
// still connect, and hosted uploads pause.
//
// These passages were corrected in place, in their own languages, without
// touching the rest of the archive. This file pins that: the old promises are
// gone from source and from every generated frozen page, the corrected facts
// are present in both, and the pages still carry their archive notice with
// links to the maintained English and Chinese versions.
import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FROZEN_LANGS } from "./shared.mjs";
import ownNode from "./content/articles/guides-own-node.mjs";
import largeFiles from "./content/articles/howto-large-files-without-cloud.mjs";
import sendFiles from "./content/articles/howto-send-files-between-computers.mjs";
import shareLink from "./content/articles/howto-share-file-expiring-link.mjs";

const publicDir = resolve(import.meta.dirname, "..", "..", "public");

/** Every string in a locale's article object. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Every troubleshooting `fix` in a locale's article object. */
function fixes(v, out = []) {
  if (Array.isArray(v)) for (const x of v) fixes(x, out);
  else if (v && typeof v === "object") {
    if (typeof v.fix === "string") out.push(v.fix);
    for (const x of Object.values(v)) fixes(x, out);
  }
  return out;
}

const unesc = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The promises as they were published, one exact phrase per claim.
const OLD = {
  ja: ["を無料で使う", "自分のノードを経由するので無料", "従量課金も請求も一切ありません", "使用量がどれだけ大きくても無料", "自動的にこのノードを優先", "または自分のノード", "自分のノードを動かす"],
  ko: ["무료로 사용하기", "노드를 통해 이루어지므로 무료", "종량 계측도 청구도 전혀 없습니다", "사용량이 아무리 커도 무료", "자동으로 이 노드를 우선", "자체 노드가 필요", "자체 노드를 돌리세요", "자체 노드를 써야"],
  de: ["Speicher von Relayium kostenlos nutzen", "sind also kostenlos", "nichts wird gemessen, nichts wird berechnet", "kostenlos, egal wie groß", "ihn automatisch", "oder einen eigenen Node", "betreib einen eigenen Node"],
  fr: ["utilisez gratuitement", "ils sont donc gratuits", "rien de mesuré, rien de facturé", "gratuite, quelle que soit son ampleur", "le préfèrent automatiquement", "ou votre propre nœud", "faites tourner votre propre nœud"],
  ar: ["وتخزين Relayium مجانًا", "فتصبح مجانية", "لا شيء يُحسَب، ولا شيء يُفوتَر", "استخدامك مجاني مهما كان كبيرًا", "تفضّلها عمليات النقل في حسابك تلقائيًا", "أو عقدة خاصة بك", "أو شغّل عقدتك الخاصة"],
  es: ["almacenamiento de Relayium gratis", "así que son gratis", "nada medido, nada facturado", "gratis por grande que sea", "lo prefieren automáticamente", "plan o tu propio nodo", "plan o a tu propio nodo", "levanta tu propio nodo"],
  pt: ["armazenamento do Relayium de graça", "então são gratuitas", "nada medido, nada faturado", "gratuito por maior que seja", "preferi-lo automaticamente", "ou do seu próprio nó", "ou o seu próprio nó", "rode o seu próprio nó"],
};

// The corrected facts, in each language's own wording.
const OWN_NODE_FACTS = {
  // storage cap, downloads carried and metered, relay pauses on your node too
  ja: ["ストレージ上限には数えられます", "ダウンロードはすべて Relayium が中継して計量", "自分のノード上でもリセットまで停止"],
  ko: ["저장 용량 한도에 포함", "모든 다운로드는 Relayium이 중계하므로 계측", "내 노드에서도 초기화될 때까지 멈춥니다"],
  de: ["weiterhin zu deinem Speicherlimit", "jeder Download davon wird von Relayium getragen und zählt", "pausiert netzübergreifendes Relaying auch auf deinem eigenen Node"],
  fr: ["comptent toujours dans votre limite de stockage", "chaque téléchargement de ces fichiers est acheminé par Relayium et compté", "se met en pause sur votre propre nœud aussi"],
  ar: ["تبقى محتسبة ضمن حدّ التخزين", "وكل تنزيل لها يحمله Relayium ويُحتسب", "يتوقف الترحيل عبر الشبكات على عقدتك الخاصة أيضًا"],
  es: ["siguen contando para tu límite de almacenamiento", "cada descarga de ellos la lleva Relayium y cuenta", "se pausa también en tu propio nodo"],
  pt: ["continuam contando para o seu limite de armazenamento", "cada download deles é carregado pelo Relayium e conta", "pausa também no seu próprio nó"],
};
// A spent allowance: only a direct path may connect, hosted uploads pause.
const SEND_FACTS = {
  ja: ["直接つながる場合にしか", "アップロードも停止"],
  ko: ["직접 연결될 수 있을 때만", "업로드도 멈춥니다"],
  de: ["einander direkt erreichen", "Uploads in den gehosteten Speicher pausieren"],
  fr: ["se joindre directement", "stockage hébergé sont suspendus"],
  ar: ["الوصول أحدهما إلى الآخر مباشرة", "ويتوقف الرفع إلى التخزين المُستضاف"],
  es: ["alcanzarse directamente", "almacenamiento alojado también se pausan"],
  pt: ["se alcançar diretamente", "armazenamento hospedado também pausam"],
};
// Only a same-network transfer bypasses a spent allowance.
const SAME_NETWORK = {
  ja: "同じネットワーク上の2台の端末間の転送",
  ko: "같은 네트워크에 있는 두 기기 간 전송",
  de: "zwei Geräten im selben Netz",
  fr: "deux appareils du même réseau",
  ar: "النقل بين جهازين على نفس الشبكة",
  es: "dos dispositivos de la misma red",
  pt: "dois dispositivos na mesma rede",
};
// "Your own node" named in a troubleshooting fix is the old way-round claim.
const OWN_NODE_WORD = {
  ja: /ノード/, ko: /노드/, de: /\bNode\b/, fr: /nœud/, ar: /عقدت|عقدة/, es: /\bnodo\b/, pt: /(?<!\p{L})nó(?!\p{L})/u,
};

const PAGES = {
  "guides/bring-your-own-node": ownNode,
  "how-to/send-large-files-without-cloud": largeFiles,
  "how-to/send-files-between-two-computers-over-the-internet": sendFiles,
  "how-to/share-a-file-with-an-expiring-link": shareLink,
};

describe.each(FROZEN_LANGS)("archived %s own-node claims", (lang) => {
  it("has an old-claim list and fact lists for this locale", () => {
    expect(OLD[lang]?.length).toBeGreaterThan(5);
    expect(OWN_NODE_FACTS[lang]).toHaveLength(3);
  });

  it("source: no old promise in the four articles", () => {
    for (const article of Object.values(PAGES)) {
      const text = strings(article.langs[lang]).join("\n");
      for (const old of OLD[lang]) expect(text, `${article.slug}: ${old}`).not.toContain(old);
    }
  });

  it("source: the own-node guide states the storage-cap, download and pause facts", () => {
    const text = strings(ownNode.langs[lang]).join("\n");
    for (const fact of OWN_NODE_FACTS[lang]) expect(text).toContain(fact);
  });

  it("source: no how-to fix offers an own node, and the facts are stated", () => {
    for (const article of [largeFiles, sendFiles, shareLink]) {
      for (const fix of fixes(article.langs[lang])) expect(fix, article.slug).not.toMatch(OWN_NODE_WORD[lang]);
    }
    // The spent-allowance fix no longer offers a stored link either: hosted
    // uploads pause with the allowance.
    const send = fixes(sendFiles.langs[lang]).find((f) => f.includes(SEND_FACTS[lang][0]));
    expect(send, "no spent-allowance fix with the direct-path fact").toBeDefined();
    for (const fact of SEND_FACTS[lang]) expect(send).toContain(fact);
    expect(send).not.toContain("offline-transfer");
    expect(fixes(largeFiles.langs[lang]).join("\n")).toContain(SAME_NETWORK[lang]);
  });

  it.each(Object.keys(PAGES))("generated %s: corrected, archived, linked to the maintained versions", (slug) => {
    const html = readFileSync(resolve(publicDir, lang, slug, "index.html"), "utf8");
    const text = unesc(html);
    for (const old of OLD[lang]) expect(text, old).not.toContain(old);
    expect(html).toMatch(/<aside class="archived"/);
    expect(html).toContain(`<a href="/${slug}/" lang="en"`);
    expect(html).toContain(`<a href="/zh/${slug}/" lang="zh-Hans"`);
    if (slug === "guides/bring-your-own-node") for (const fact of OWN_NODE_FACTS[lang]) expect(text).toContain(fact);
    if (slug.includes("between-two-computers")) for (const fact of SEND_FACTS[lang]) expect(text).toContain(fact);
    if (slug.includes("large-files")) expect(text).toContain(SAME_NETWORK[lang]);
  });

  it("generated: no page of this archive repeats an old promise", () => {
    const files = globSync(`${lang}/**/*.html`, { cwd: publicDir });
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = unesc(readFileSync(resolve(publicDir, f), "utf8"));
      for (const old of OLD[lang]) expect(text, `${f}: ${old}`).not.toContain(old);
    }
  });
});
