// web/scripts/pages/archived-fact-errata.test.mjs — W-N50, W-N51, W-N52.
//
// Three factual errors survived the W-N47 pricing errata because they were not
// about price:
//
//   - W-N50, compare/croc (every locale, maintained en/zh included): the overlap
//     paragraph said both tools are open source "under a permissive license",
//     and the license/cost bullet said both are AGPL-3.0. croc is MIT
//     (github.com/schollz/croc LICENSE); the Relayium CLI lives in server/ and
//     is AGPL-3.0-only (root LICENSE index). Neither "both" is true.
//   - W-N51, guides/self-host-relayium (frozen locales): the TURN section said
//     the relay profile's Redis instance is there "for relay-byte metering".
//     server/main.go guardCoturnRedisMetering never starts that ingest, so
//     relayed bytes are not counted; maintained en/zh already say so.
//   - W-N52, guides/transfer-files-from-terminal (frozen locales): lead.1 said
//     bytes go direct "whichever way you use it", and the "do my files pass
//     through Relayium's servers?" answer opened with a bare "No. In every
//     mode…". up stores an encrypted copy under the account. The corrected text
//     scopes the claim to the direct modes and names up, as maintained en/zh do.
//     Maintained en/zh faq.items.3.a called up "the deliberate exception", but
//     the installable v0.26.0 CLI also ships `relayium inbox` — receive-only,
//     "There is no CLI sender for it" (run.go usage) — whose tasks central
//     holds as ciphertext until the device downloads them (internal/inbox).
//     That answer now names both server-held paths; it must not advertise the
//     source-only pair command or an inbox sender. The archived answers say
//     "up is different/not direct" (pinned by UP_NOT_DIRECT), never "the only".
//
// 2026-09-30 (DECISION-LOG item 2, settled with Codex): the maintained en/zh
// pages now describe the next CLI release, so the frozen W-N52 rows no longer
// keep their v0.26.0 NOT_RELEASED rule — the archived lead and FAQ carry the
// same pairing-relay and metering facts as a translated erratum. The block at
// the bottom of this file pins that wider CLI errata across the seven archived
// locales: transport and metering, interoperability, the Device Inbox and the
// retired SSH transport.
//
// For each passage and locale this pins: the old claim is gone from the source
// string and from the generated page (visible text and JSON-LD alike), the
// corrected fact is in the source string, and the generated page carries it.
// Frozen pages must also keep their archive notice linking the en/zh versions.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, globSync } from "node:fs";
import { resolve } from "node:path";

import { FROZEN_LANGS, MAINTAINED_LANGS } from "./shared.mjs";
import croc from "./content/articles/compare-croc.mjs";
import selfHost from "./content/articles/guides-self-host.mjs";
import cliStart from "./content/articles/cli-getting-started.mjs";
import cliSend from "./content/articles/cli-send-to-someone.mjs";
import cliServer from "./content/articles/cli-server-to-server.mjs";
import cliBackupSsh from "./content/articles/cli-backup-server-ssh.mjs";
import wormhole from "./content/articles/compare-magic-wormhole.mjs";
import localsend from "./content/articles/compare-localsend.mjs";
import scp from "./content/articles/compare-scp.mjs";
import receive from "./content/articles/guides-receive-from-cli.mjs";
import textHowto from "./content/articles/howto-send-text-between-devices.mjs";
import backups from "./content/articles/howto-automate-server-backups.mjs";
import privacy from "./content/legal/privacy.mjs";
import security from "./content/legal/security.mjs";
import { cliDirectFacts } from "./content/realtime-facts.mjs";
import { sshRetiredNotice } from "./content/archived-errata.mjs";

const publicDir = resolve(import.meta.dirname, "..", "..", "public");
const unesc = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const at = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const pagePath = (slug, lang) => resolve(publicDir, lang === "en" ? "" : lang, slug, "index.html");

// ── W-N50: the old "both" claims, verbatim per locale ────────────────────────
const BOTH_PERMISSIVE = {
  en: ["under a permissive license so"], zh: ["都以宽松许可证开源"], ja: ["寛容なライセンスでオープンソース化"],
  ko: ["둘 다 관대한 라이선스로"], de: ["unter einer freizügigen Lizenz quelloffen"], fr: ["open source sous une licence permissive"],
  ar: ["مفتوح المصدر برخصة متساهلة"], es: ["abierto bajo una licencia permisiva"], pt: ["aberto sob uma licença permissiva"],
};
const BOTH_AGPL = {
  en: ["both AGPL-3.0-licensed"], zh: ["都是 AGPL-3.0 许可"], ja: ["どちらも AGPL-3.0 ライセンス"],
  ko: ["둘 다 AGPL-3.0 라이선스"], de: ["Beide AGPL-3.0-lizenziert"], fr: ["les deux sous licence AGPL-3.0"],
  ar: ["كلاهما مرخّص بـ AGPL-3.0"], es: ["ambas con licencia AGPL-3.0"], pt: ["ambas licenciadas sob AGPL-3.0"],
};
// The corrected passage attributes MIT to croc and AGPL-3.0 to Relayium, in
// that order, within the one sentence.
const LICENSE_FACT = /croc[^.。]*MIT[^.。]*Relayium[^.。]*AGPL-3\.0/;

// ── W-N51: the old metering claim and the corrected "disabled" fact ─────────
const REDIS_OLD = {
  ja: ["リレーバイト計測用の小さな Redis"], ko: ["릴레이 바이트 계량용 소형 Redis"], de: ["Redis-Instanz für die Zählung der Relay-Bytes"],
  fr: ["Redis pour la mesure des octets relayés"], ar: ["Redis صغيرة لقياس بايتات الترحيل"],
  es: ["Redis para la medición de bytes retransmitidos"], pt: ["Redis para a medição de bytes retransmitidos"],
};
const DISABLED = {
  en: /currently disabled/, zh: /目前已停用/, ja: /現在無効/, ko: /현재 비활성화/, de: /derzeit deaktiviert/,
  fr: /actuellement désactivée/, ar: /معطَّل حاليًا/, es: /desactivada actualmente/, pt: /desativada no momento/,
};
const NOT_COUNTED = {
  en: /not counted/, zh: /不会被计入/, ja: /計上されません/, ko: /집계되지 않습니다/, de: /nicht gezählt/,
  fr: /ne sont pas comptés/, ar: /لا تُحتسب/, es: /no se contabilizan/, pt: /não são contabilizados/,
};

// ── W-N52: the old totalizing transport claims and the scoped replacement ───
const EVERY_WAY = {
  ja: ["どの方法を使っても"], ko: ["어떤 방식을 쓰든"], de: ["Egal welchen Weg du nutzt"], fr: ["Quelle que soit la méthode utilisée"],
  ar: ["أيًا كانت الطريقة التي تستخدمها بها"], es: ["Sea cual sea la forma en que la uses"], pt: ["Seja qual for a forma que você usar"],
};
const EVERY_MODE = {
  ja: ["どのモードでも"], ko: ["어떤 모드에서든"], de: ["In jedem Modus"], fr: ["Dans tous les modes"],
  ar: ["في كل وضع"], es: ["En todos los modos"], pt: ["Em todos os modos"],
};
const BARE_NO = { ja: "いいえ", ko: "아니요", de: "Nein", fr: "Non", ar: "لا.", es: "No.", pt: "Não." };
const UP_NOT_DIRECT = {
  ja: /up は(直結ではありません|異なります)/, ko: /up은 (직접 연결이 아닙니다|다릅니다)/, de: /up ist (nicht direkt|anders)/,
  fr: /up (n'est pas direct|est différent)/, ar: /up (فليس مباشرًا|فمختلف)/, es: /up (no es directo|es distinto)/, pt: /O up (não é direto|é diferente)/,
};
const ENCRYPTED = { ja: /暗号化/, ko: /암호화/, de: /verschlüsselte/, fr: /chiffrée/, ar: /مُشفَّرة/, es: /cifrada/, pt: /criptografada/ };
// Until 2026-09-30 the frozen rows also refused anything not in the installable
// v0.26.0 CLI (pair, inbox). The maintained pages now describe the next CLI
// release (/cli, help.go), and the archived errata follow them, so that rule is
// retired. What the frozen rows pin instead: the direct-mode list that put
// pull and send / receive among the direct, unmetered modes is gone, and the
// daemon-direct scope and the relayed-pairing metering are stated.
const OLD_DIRECT_MODES_LIST = {
  ja: ["直結モード（push、pull、sync、daemon 直結、send / receive、text）", "push、pull、daemon 直結、send / receive では"],
  ko: ["직접 연결 모드(push, pull, sync, daemon 다이렉트, send / receive, text)", "push, pull, daemon 다이렉트, send / receive에서는"],
  de: ["push, pull, sync, daemon-direct, send / receive und text", "Bei push, pull, daemon-direct und send / receive"],
  fr: ["push, pull, sync, daemon-direct, send / receive et text", "Avec push, pull, daemon-direct et send / receive"],
  ar: ["push وpull وsync وdaemon direct وsend / receive وtext", "مع push وpull وdaemon direct وsend / receive"],
  es: ["push, pull, sync, daemon directo, send / receive y text", "Con push, pull, daemon directo y send / receive"],
  pt: ["push, pull, sync, daemon direto, send / receive e text", "Com push, pull, daemon direto e send / receive"],
};
// A relayed pairing-code session counts toward the allowance of the account
// that minted the code (help.go linkRelayPolicy), in each archived locale.
const METERED = {
  ja: /コードを発行したアカウントの(?:月間)?転送量の枠/, ko: /코드를 발급한 계정의 (?:월간 )?전송량 한도/,
  de: /(?:monatlichen )?Datenvolumen des Kontos, das den Code erzeugt hat/, fr: /quota (?:mensuel )?de trafic du compte qui a généré le code/,
  ar: /حصة حركة البيانات (?:الشهرية )?للحساب الذي أنشأ الرمز/, es: /cuota (?:mensual )?de tráfico de la cuenta que generó el código/,
  pt: /cota (?:mensal )?de tráfego da conta que gerou o código/,
};
const DAEMON_DIRECT = {
  ja: /デーモン直結/, ko: /데몬 다이렉트/, de: /daemon-direct/, fr: /daemon-direct/, ar: /daemon direct/, es: /daemon directo/, pt: /daemon direto/,
};

// Maintained en/zh FAQ: both server-held paths named, no sole-exception claim.
// 2026-09-30: the maintained guide now describes the next CLI release, like
// /cli (help.go): the CLI sends into a Device Inbox (inbox send), and a
// pairing-code session relays every byte whenever the server issues a relay.
// The frozen rows above keep their v0.26.0 NOT_RELEASED rule; the maintained
// answer must no longer call the inbox receive-only or the pairing path direct.
const SOLE_EXCEPTION = {
  en: ["up is the deliberate exception", "the only exception", "sole exception", "receive-only in the CLI",
    "contact our servers only for a small rendezvous handshake, never for the content"],
  zh: ["up 是有意为之的例外", "唯一的例外", "唯一例外", "在 CLI 中只有接收侧", "只有 send / receive 会联系服务器做一次很小的会合握手"],
};
const TWO_EXCEPTIONS = {
  en: [/Two modes hold data server-side on purpose/, /server holds only ciphertext it cannot read/,
    /up uploads an encrypted copy to your account's storage/,
    /Device Inbox — relayium inbox send from the CLI, or a browser or native app — queues an encrypted copy/,
    /whenever the server issues a TURN relay for the code, every byte of the session travels through that relay/],
  zh: [/有两种模式会有意在服务器上保存数据/, /只保存无法读取的密文/, /up 会把加密副本上传到你账号的存储里/,
    /设备收件箱（CLI 里用 relayium inbox send，也可以用浏览器或原生应用）/, /加密副本排队存着/,
    /只要服务器为这个码签发了 TURN 中继，会话的每个字节都经这条中继传输/],
};
const POST_V026 = /\bpair\b|配对会话|inbox send|CLI (sender|command that sends)|SSH transfers are (currently )?disabled|SSH 传输/;

const CASES = [
  ...["sections.0.body.0", "sections.5.bullets.5"].map((path) => ({
    task: "W-N50", page: croc, slug: "compare/croc", path, langs: FROZEN_LANGS,
    old: (l) => [...BOTH_PERMISSIVE[l], ...BOTH_AGPL[l]],
    facts: () => [LICENSE_FACT],
  })),
  {
    task: "W-N50", page: croc, slug: "compare/croc", path: "lead.1", langs: MAINTAINED_LANGS,
    old: (l) => [...BOTH_PERMISSIVE[l], ...BOTH_AGPL[l]],
    facts: () => [LICENSE_FACT],
  },
  {
    task: "W-N51", page: selfHost, slug: "guides/self-host-relayium", path: "sections.2.body.1", langs: [...MAINTAINED_LANGS, ...FROZEN_LANGS],
    old: (l) => REDIS_OLD[l] ?? [],
    facts: (l) => [/Redis/, DISABLED[l], NOT_COUNTED[l]],
  },
  {
    task: "W-N52", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "lead.1", langs: FROZEN_LANGS,
    old: (l) => [...EVERY_WAY[l], ...OLD_DIRECT_MODES_LIST[l]],
    facts: (l) => [DAEMON_DIRECT[l], METERED[l], UP_NOT_DIRECT[l], ENCRYPTED[l]],
  },
  {
    task: "W-N52", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "faq.items.3.a", langs: FROZEN_LANGS,
    old: (l) => [...EVERY_MODE[l], ...OLD_DIRECT_MODES_LIST[l]],
    facts: (l) => [DAEMON_DIRECT[l], /TURN/, METERED[l], UP_NOT_DIRECT[l], ENCRYPTED[l]],
    bareNo: true,
  },
  {
    task: "W-N52", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "faq.items.3.a", langs: MAINTAINED_LANGS,
    old: (l) => SOLE_EXCEPTION[l],
    facts: (l) => [/push\/sync|push\/sync daemon/, ...TWO_EXCEPTIONS[l]],
  },
];

const rows = CASES.flatMap((c) => c.langs.map((lang) => [`${c.task} ${c.slug} ${c.path} ${lang}`, c, lang]));

describe("archived factual errata (W-N50/W-N51/W-N52)", () => {
  it.each(rows)("source %s: old claim gone, corrected fact stated", (_n, c, lang) => {
    const s = at(c.page.langs[lang], c.path);
    expect(typeof s, c.path).toBe("string");
    for (const old of c.old(lang)) expect(s, `old: ${old}`).not.toContain(old);
    for (const re of c.facts(lang)) expect(s, `fact ${re}`).toMatch(re);
    if (c.bareNo) expect(s.startsWith(BARE_NO[lang]), `opens with a bare "${BARE_NO[lang]}"`).toBe(false);
    if (c.postV026) expect(s).not.toMatch(POST_V026);
  });

  it.each(rows)("generated %s: carries the corrected string, not the old one", (_n, c, lang) => {
    const html = readFileSync(pagePath(c.slug, lang), "utf8");
    const text = unesc(html);
    expect(text, "generated page carries the corrected source string").toContain(at(c.page.langs[lang], c.path));
    for (const old of c.old(lang)) expect(text, `old: ${old}`).not.toContain(old);
    if (FROZEN_LANGS.includes(lang)) {
      expect(html).toMatch(/<aside class="archived"/);
      expect(html).toContain(`<a href="/${c.slug}/" lang="en"`);
      expect(html).toContain(`<a href="/zh/${c.slug}/" lang="zh-Hans"`);
    } else {
      expect(html).not.toMatch(/<aside class="archived"/);
    }
  });
});
const OLD_CLI_CLAIMS = {
  ja: [
    "Relayium CLI の send/receive と text は P2P 直接接続専用です。",
    "両端とも CLI である必要があります。",
    "どちらの端も相手に届かず、CLI にはファイルのバイトを通すリレー経路が設計上ありません。",
    "CLI は設計上リレーへのフォールバックを持ちません。",
    "Relayium の send / receive は直接接続専用で、その状況では失敗し得ます（push/pull や、到達可能なサーバーへの デーモン直結 は直接 P2P のホップに依存しないため、引き続き使えます）。",
    "Relayium の send/receive は直接接続専用です。",
    "CLI の send/receive は独自の直接ハンドシェイクを使っており、ブラウザの WebRTC ベースのペアリングフローとは別物なので、今は相互運用できません。",
    "CLI は常に直接接続で、リレーは一切使いません。",
    "Relayium はペアリングコードで異なるネットワークにも接続でき、ブラウザではその区間は暗号化されたリレー経由、CLI は常に直接接続です。",
    "一方、Relayium の send/receive は直接接続専用で、この場合は失敗します。",
    "その場合 Relayium の send/receive は直接接続専用のため失敗します。",
    "相手側も CLI であること。",
    "send と同じく直接接続のみのルールです。",
    "これは CLI 独自のペアリングコード・プロトコルです——CLI のコードは CLI 同士でしかペアリングできません。",
    "CLI のペアリング経路は設計上ダイレクト専用で、直接の経路が見つからないときはファイルをリレー経由にせず失敗します。",
    "CLI text は直結専用で、ブラウザ版の TURN リレーは使いません。",
    "同じ LAN のブラウザは WebRTC 直結、ネットワーク間ブラウザは設計上 TURN、CLI は直接接続専用です。",
    "CLI コードは 5 分有効で CLI 同士専用です。",
    "ブラウザ同士、または CLI 同士で使ってください。",
    "CLI テキストは直接接続のみで、一時保存リンクにはゼロ知識暗号化されたファイル暗号文だけが保存されます。",
    "CLI テキストは直接接続のみで TURN を使用せず、TURN 使用量にも算入されません。",
    "CLI のファイルとテキスト転送は TURN を使わず、直接接続のみで、直接の経路が見つからなければ失敗します。",
    "ファイルやメッセージのバイトを TURN やその他の Relayium サーバーで中継することはありません。",
  ],
  ko: [
    "Relayium CLI의 send/receive와 text는 P2P 직접 연결 전용입니다.",
    "양쪽 모두 CLI여야 합니다.",
    "양쪽 어느 쪽도 상대에 닿지 못했고, CLI에는 파일 바이트를 위한 릴레이 경로가 설계상 없습니다.",
    "CLI는 설계상 릴레이 폴백이 없습니다.",
    "Relayium의 send / receive는 직접 연결 전용이라 이런 상황에서 실패할 수 있습니다(push/pull이나 도달 가능한 서버로의 데몬 다이렉트는 직접 P2P 홉에 의존하지 않으므로 여전히 작동합니다).",
    "Relayium의 send/receive는 직접 연결 전용임.",
    "아직 실시간 페어링 전송은 안 됩니다 — CLI의 send/receive는 자체 직접 핸드셰이크를 사용하며, 브라우저의 WebRTC 기반 페어링 흐름과는 별개라 현재는 상호 운용되지 않습니다.",
    "CLI는 항상 직접 연결하며 릴레이를 쓰지 않습니다.",
    "Relayium은 페어링 코드로 다른 네트워크에도 연결됨 — 브라우저에서는 그 구간이 암호화된 릴레이를 거치고, CLI는 항상 직접 연결함.",
    "Relayium의 send/receive는 직접 연결 전용입니다.",
    "Relayium의 send/receive는 직접 연결 전용이라 이 경우 실패합니다.",
    "이 경우 Relayium의 send/receive는 직접 연결 전용이라 실패합니다 — 릴레이로 대체되지 않습니다.",
    "상대편도 CLI여야 합니다.",
    "send와 동일하게 직접 연결만 지원합니다.",
    "이것은 CLI 자체의 페어링 코드 프로토콜입니다——CLI 코드는 CLI끼리만 페어링됩니다.",
    "CLI text는 직접 연결 전용이며 브라우저의 TURN 릴레이를 사용하지 않습니다.",
    "같은 LAN 브라우저는 WebRTC 직접 연결, 네트워크 간 브라우저는 설계상 TURN, CLI는 직접 연결 전용입니다.",
    "브라우저 두 개를 쓰거나 양쪽 모두 CLI를 쓰세요.",
    "CLI 코드는 5분 동안 유효하고 CLI끼리만 연결합니다.",
    "CLI 텍스트는 직접 연결만 사용하며, 임시 다운로드 링크에는 영지식 암호화된 파일 암호문만 저장됩니다.",
    "CLI 텍스트는 직접 연결만 사용하며 TURN을 사용하거나 TURN 사용량에 포함되지 않습니다.",
    "CLI 파일과 텍스트 전송은 TURN을 사용하지 않으며 직접 연결만 쓰고, 직접 경로를 찾지 못하면 실패합니다.",
    "브라우저의 X25519/AES 메시지 프레이밍이나 TURN을 사용하지 않으며, 직접 경로를 만들 수 없으면 실패합니다.",
    "파일이나 메시지 바이트를 TURN 또는 다른 Relayium 서버로 릴레이하지 않습니다.",
  ],
  de: [
    "Relayium CLI send/receive und text sind direct-only P2P: Datei- oder Nachrichtenbytes werden weder über TURN noch über einen anderen Relayium-Server weitergeleitet.",
    "Beide Enden müssen die CLI sein — ein Browser kann einem CLI-Pairing-Code nicht beitreten.",
    "Keine der beiden Seiten hat die andere erreicht, und die CLI hat von Grund auf keinen Relay-Weg für Dateibytes.",
    "Stehen beide Enden hinter strengem NAT ohne erreichbare Adresse, kann die direkte Verbindung nicht hergestellt werden und die Übertragung schlägt fehl — die CLI hat absichtlich kein Relay-Fallback.",
    "Relayiums send / receive ist rein direkt und kann in dieser Situation fehlschlagen (push/pull oder daemon-direct zu einem erreichbaren Server funktionieren weiterhin, da sie nicht von einem direkten P2P-Hop abhängen).",
    "Relayiums send/receive ist rein direkt.",
    "Noch nicht für eine gekoppelte Live-Übertragung — send/receive der CLI nutzt einen eigenen, direkten Handshake, getrennt vom WebRTC-basierten Pairing-Ablauf des Browsers, sodass beide heute nicht zusammenarbeiten.",
    "Die CLI verbindet sich immer direkt und nutzt nie ein Relay.",
    "Relayium verbindet auch über verschiedene Netzwerke hinweg per Pairing-Code — im Browser läuft diese Strecke über ein verschlüsseltes Relay, die CLI verbindet immer direkt.",
    "Relayiums send/receive ist rein direkt: Es versucht direkt nach dem Handshake für ein paar Sekunden eine direkte Verbindung aufzubauen, und findet es keine, schlägt die Übertragung schlicht fehl, statt auf ein Relay auszuweichen — Relayiums Server kommen von Grund auf nie mit den Dateibytes einer netzwerkübergreifenden CLI-Übertragung in Berührung.",
    "Relayiums send/receive ist rein direkt und schlägt in diesem Fall fehl.",
    "In diesem Fall ist Relayiums send/receive rein direkt und schlägt fehl — es weicht nicht auf ein Relay aus.",
    "Das ist das eigene Pairing-Code-Protokoll der CLI — CLI-Codes koppeln CLI mit CLI.",
    "Der CLI-Pairing-Pfad ist bewusst nur direkt: gibt es keine direkte Route, scheitert er, statt deine Datei über ein Relay zu schicken.",
    "CLI text ist rein direkt und nutzt nicht das TURN-Relay der Web-App.",
    "Diese Seite erklärt zuerst allgemeines WebRTC/ICE, bei dem TURN als Ausweichweg dienen kann, und trennt dann Relayiums Umsetzung: Browser-WebRTC ist im selben LAN direkt, netzübergreifend wird TURN planmäßig genutzt, und die CLI ist direct-only.",
    "CLI-Codes gelten fünf Minuten und verbinden nur CLI mit CLI;",
    "Browser und CLI sind nicht interoperabel.",
    "CLI-Text ist ausschließlich direkt;",
    "CLI-Text ist ausschließlich direkt, verwendet kein TURN und zählt nicht zur TURN-Nutzung.",
    "Datei- und Textübertragungen der CLI verwenden nie TURN;",
    "CLI-Text nutzt ein anderes, ausschließlich direktes Protokoll über TLS 1.",
  ],
  fr: [
    "Les commandes send/receive et text du CLI Relayium sont P2P et direct-only : aucun octet de fichier ou de message ne transite par TURN ni par un autre serveur Relayium.",
    "Les deux extrémités doivent être la CLI — un navigateur ne peut pas rejoindre un code d'appairage CLI.",
    "Aucune des deux extrémités n'a pu atteindre l'autre, et la CLI n'a, par conception, aucune voie de relais pour les octets d'un fichier.",
    "Si les deux extrémités sont derrière un NAT strict sans adresse joignable, la connexion directe ne peut pas être établie et le transfert échoue — la CLI n'a volontairement aucun repli par relais.",
    "Le send / receive de Relayium est exclusivement direct et peut échouer dans cette situation (push/pull ou daemon-direct vers un serveur joignable fonctionnent toujours, car ils ne dépendent pas d'un saut P2P direct).",
    "le send/receive de Relayium est exclusivement direct.",
    "Pas encore pour un transfert appairé en direct — le send/receive de la CLI utilise sa propre poignée de main directe, distincte du flux d'appairage du navigateur basé sur WebRTC, donc les deux n'interopèrent pas aujourd'hui.",
    "La CLI, elle, se connecte toujours en direct et n'utilise jamais de relais.",
    "Relayium se connecte aussi entre réseaux différents via un code d'appairage — dans le navigateur, ce trajet passe par un relais chiffré, tandis que la CLI se connecte toujours en direct.",
    "Le send/receive de Relayium est exclusivement direct : il tente une connexion directe pendant quelques secondes juste après la poignée de main, et s'il n'en trouve pas, le transfert échoue purement et simplement plutôt que de basculer vers un relais — par conception, les serveurs de Relayium ne touchent jamais aux octets d'un transfert CLI entre réseaux.",
    "le send/receive de Relayium est exclusivement direct et échoue dans ce cas.",
    "Dans ce cas, le send/receive de Relayium est exclusivement direct et échouera — il ne bascule pas vers un relais.",
    "Le text de la CLI est exclusivement direct et n'utilise pas le relais TURN de l'appli web.",
    "Cette page explique d'abord le WebRTC/ICE général, où TURN peut servir de secours, puis distingue l'implémentation de Relayium : WebRTC navigateur est direct sur le même LAN, TURN est utilisé par conception entre réseaux, et le CLI est direct-only.",
    "Les codes CLI durent cinq minutes et relient uniquement deux CLI ;",
    "navigateur et CLI ne sont pas interopérables.",
    "le texte CLI est uniquement direct ;",
    "Le texte CLI est uniquement direct, n'utilise pas TURN et ne compte pas dans son usage.",
    "Les transferts CLI de fichiers et de texte n'utilisent jamais TURN : ils sont uniquement directs et échouent sans trajet direct.",
    "Le texte CLI utilise un protocole différent, exclusivement direct, sur TLS 1.",
  ],
  ar: [
    "تعمل أوامر send/receive وtext في Relayium CLI باتصال P2P مباشر فقط: فلا تُمرَّر بايتات الملفات أو الرسائل عبر TURN أو أي خادم Relayium آخر.",
    "يجب أن يكون الطرفان كلاهما على واجهة CLI — فالمتصفح لا يستطيع الانضمام إلى رمز اقتران خاص بـ CLI.",
    "لم يستطع أي من الطرفين الوصول إلى الآخر، ولا تملك واجهة CLI أي مسار عبر مُرحِّل لبايتات الملفات، وهذا بحكم التصميم.",
    "إذا كان الطرفان خلف NAT صارم بلا عنوان يمكن الوصول إليه، فلا يمكن إنشاء الاتصال المباشر ويفشل النقل — فواجهة CLI لا تملك احتياطيًا عبر مُرحِّل، وهذا بحكم التصميم.",
    "أمّا send / receive في Relayium فمباشر فقط وقد يفشل في هذا الموقف (push/pull أو daemon direct إلى خادم يمكن الوصول إليه لا تزال تعمل، لأنها لا تعتمد على قفزة P2P مباشرة).",
    "لا مسار مباشر متاح: يحمل مُرحِّل croc التدفّق المُشفَّر فيكتمل النقل رغم ذلك؛ أمّا send/receive في Relayium فمباشر فقط.",
    "ليس بعد لنقل مقترن مباشر — يستخدم send/receive في الواجهة مصافحته المباشرة، منفصلةً عن تدفّق الاقتران في المتصفّح المبني على WebRTC، فلا يتفاهم الاثنان اليوم.",
    "أما send/receive في Relayium فمباشر فقط: يتسابق على اتصال مباشر لبضع ثوانٍ مباشرة بعد المصافحة، وإن لم يجده يفشل النقل تمامًا بدل الرجوع إلى أي مُرحِّل — فخوادم Relayium لا تلمس إطلاقًا بايتات ملفات CLI العابرة للشبكات، بحكم التصميم.",
    "لا مسار مباشر متاح: يحمل مُرحِّل Transit Relay في magic-wormhole التدفّق المُشفَّر فتكتمل عملية النقل؛ أما send/receive في Relayium فمباشر فقط ويفشل في تلك الحالة.",
    "send/receive في Relayium مباشر فقط وسيفشل في تلك الحالة — فهو لا يرجع إلى مُرحِّل.",
    "ليس بعد لنقل مقترن حيّ — إذ يستخدم send/receive في CLI مصافحته المباشرة الخاصة، المنفصلة عن تدفّق الاقتران القائم على WebRTC في المتصفح، فلا يتوافق الاثنان اليوم.",
    "القاعدة نفسها كما في send، الاتصال المباشر فقط: إن لم يُعثر على مسار مباشر بين الشبكتين، يفشل النقل بدل توجيهه عبر مُرحِّل.",
    "لا يتوافق اليوم مع رمز اقتران المتصفح أو تدفق QR في relayium.",
    "مسار الاقتران في الـ CLI مباشر فقط بحكم التصميم: فحين لا يوجد طريق مباشر يفشل بدل أن يمرّر ملفك عبر مُرحِّل.",
    "text في CLI مباشر فقط ولا يستخدم مُرحِّل TURN الخاص بتطبيق الويب.",
    "تشرح الصفحة أولًا WebRTC/ICE العام حيث يمكن أن يكون TURN احتياطيًا، ثم تميّز تنفيذ Relayium: WebRTC في المتصفح مباشر داخل شبكة LAN نفسها، وTURN مستخدم حسب التصميم عبر الشبكات، وCLI مباشرة فقط.",
    "رمز CLI صالح لخمس دقائق ويربط CLI بـ CLI فقط؛ لا يتوافق المتصفح مع CLI.",
    "جلسات المتصفح المحلية مباشرة؛ وقد تحمل جلسات المتصفح عبر الشبكات نصًا مُشفَّرًا من الطرف إلى الطرف عبر TURN؛ ونص CLI مباشر فقط؛ ولا تحتفظ روابط التنزيل إلا بنص ملفات مُشفَّر بمعرفة صفرية.",
    "نص CLI مباشر فقط ولا يستخدم TURN أو يُحتسب ضمنه.",
    "ولا تستخدم عمليات ملفات أو نصوص CLI بروتوكول TURN إطلاقًا: فهي مباشرة فقط وتفشل إن لم يوجد مسار مباشر.",
    "يستخدم نص CLI بروتوكولًا مختلفًا ومباشرًا فقط عبر TLS 1.",
  ],
  es: [
    "send/receive y text del CLI de Relayium son P2P y direct-only: nunca retransmiten bytes de archivos o mensajes mediante TURN ni ningún otro servidor de Relayium.",
    "Ambos extremos tienen que ser la CLI: un navegador no puede unirse a un código de emparejamiento de la CLI.",
    "Ningún extremo pudo alcanzar al otro, y la CLI no tiene, por diseño, ninguna vía de retransmisor para los bytes de un archivo.",
    "El send / receive de Relayium es solo directo y puede fallar en esa situación (push/pull o daemon directo hacia un servidor accesible siguen funcionando, ya que no dependen de un salto P2P directo).",
    "el send/receive de Relayium es solo directo.",
    "Todavía no para una transferencia emparejada en vivo — el send/receive de la CLI usa su propio handshake directo, aparte del flujo de emparejamiento del navegador basado en WebRTC, así que hoy los dos no interoperan.",
    "La CLI siempre se conecta de forma directa y nunca usa un retransmisor.",
    "Relayium también conecta entre redes distintas con un código de emparejamiento: en el navegador ese trayecto va por un retransmisor cifrado, mientras que la CLI conecta siempre directamente.",
    "El send/receive de Relayium es solo directo: busca una conexión directa durante unos segundos justo después del handshake, y si no encuentra ninguna, la transferencia falla sin más en lugar de recurrir a ningún retransmisor — los servidores de Relayium nunca tocan los bytes de archivos de una transferencia CLI entre redes, por diseño.",
    "el send/receive de Relayium es solo directo y falla en ese caso.",
    "El send/receive de Relayium es solo directo y fallará en ese caso — no recurre a un retransmisor.",
    "Todavía no para una transferencia emparejada en vivo — el send/receive de la CLI usa su propio handshake directo, separado del flujo de emparejamiento del navegador basado en WebRTC, así que los dos no interoperan hoy.",
    "La misma regla de solo directo que send: si no puede hallarse ninguna ruta directa entre las dos redes, la transferencia falla en lugar de enrutarse por un retransmisor.",
    "text en la CLI es solo directo y no usa el relé TURN de la app web.",
    "Esta página explica primero WebRTC/ICE en general, donde TURN puede ser una vía de reserva, y luego separa la implementación de Relayium: WebRTC del navegador es directo en la misma LAN, TURN se usa por diseño entre redes y el CLI es direct-only.",
    "Los códigos CLI duran cinco minutos y solo conectan CLI con CLI;",
    "navegador y CLI no son interoperables.",
    "el texto CLI es solo directo;",
    "El texto CLI es solo directo, no usa TURN ni cuenta en su consumo.",
    "Los archivos y textos de la CLI nunca usan TURN: son solo directos y fallan sin una ruta directa.",
    "El texto de la CLI utiliza un protocolo distinto, exclusivamente directo, sobre TLS 1.",
  ],
  pt: [
    "send/receive e text da CLI do Relayium são P2P e direct-only: nunca retransmitem bytes de arquivos ou mensagens por TURN nem por qualquer outro servidor Relayium.",
    "As duas pontas precisam ser a CLI — um navegador não consegue entrar em um código de emparelhamento da CLI.",
    "Nenhuma das pontas conseguiu alcançar a outra, e a CLI não tem, por decisão de projeto, nenhum caminho por retransmissor para os bytes de um arquivo.",
    "Se ambas as pontas estiverem atrás de um NAT estrito sem endereço alcançável, a conexão direta não pode ser feita e a transferência falha — a CLI não tem retorno por retransmissor, por decisão de projeto.",
    "O send / receive do Relayium é só direto e pode falhar nessa situação (push/pull ou daemon direto para um servidor alcançável continuam funcionando, já que não dependem de um salto P2P direto).",
    "o send/receive do Relayium é só direto.",
    "Ainda não para uma transferência emparelhada ao vivo — o send/receive da CLI usa seu próprio handshake direto, separado do fluxo de emparelhamento do navegador baseado em WebRTC, então os dois não interoperam hoje.",
    "A CLI sempre se conecta diretamente e nunca usa retransmissor.",
    "o Relayium também conecta entre redes diferentes com um código de emparelhamento — no navegador esse trecho passa por um retransmissor criptografado, enquanto a CLI conecta sempre direto.",
    "O send/receive do Relayium é somente direto: ele tenta uma conexão direta por alguns segundos logo após o handshake e, se não encontra nenhuma, a transferência simplesmente falha em vez de recorrer a qualquer retransmissor — os servidores do Relayium nunca tocam os bytes de arquivos de uma transferência CLI entre redes, por decisão de projeto.",
    "o send/receive do Relayium é somente direto e falha nesse caso.",
    "O send/receive do Relayium é somente direto e falhará nesse caso — ele não recorre a um retransmissor.",
    "A mesma regra de somente direto que o send: se nenhum caminho direto puder ser encontrado entre as duas redes, a transferência falha em vez de ser roteada por um retransmissor.",
    "text na CLI é apenas direto e não usa o retransmissor TURN do app web.",
    "Esta página explica primeiro WebRTC/ICE em geral, onde o TURN pode ser uma rota de reserva, e depois separa a implementação do Relayium: o WebRTC do navegador é direto na mesma LAN, o TURN é usado por design entre redes e a CLI é direct-only.",
    "Códigos CLI duram cinco minutos e conectam apenas CLI com CLI;",
    "navegador e CLI não são interoperáveis.",
    "o texto da CLI é somente direto;",
    "O texto da CLI é somente direto, não usa TURN nem conta em seu uso.",
    "Arquivos e textos da CLI nunca usam TURN: são apenas diretos e falham sem caminho direto.",
    "O texto da CLI usa um protocolo diferente, exclusivamente direto, sobre TLS 1.",
  ],
};

// ── 2026-09-30: CLI transport, metering, interoperability, Inbox and SSH ─────
//
// DECISION-LOG 2026-09-30 item 2 (settled with Codex): the seven archived
// locales get minimal translated factual errata for the CLI claims the
// maintained en/zh pages retracted on 2026-09-30 — pairing-code sessions
// (send / receive, text, pair) relay whenever the server issues a TURN relay
// and count toward the minting account's allowance; the other end can be an
// app or the web page; the CLI sends into a Device Inbox; SSH transfers are
// retired. Obsolete SSH instruction sections became a translated historical
// notice (content/archived-errata.mjs) pointing at the maintained en/zh page,
// which every archived page links from its archive notice. URLs, notices and
// indexability are unchanged.
//
// OLD_CLI_CLAIMS above is every sentence of the archived corpus, verbatim per
// locale, that carried one of those claims before this pass (direct-only,
// never relayed, CLI-to-CLI only, not interoperable with the browser). None
// may come back, in the source or on any generated archived page. The SSH half
// is structural rather than a phrase list: no archived code block may run the
// retired transport, and archived prose may name push/pull or relayium pull
// only next to the locale's word for "retired".

const RETIRED = {
  ja: /廃止/, ko: /폐지/, de: /eingestellt/, fr: /retiré/, ar: /أُوقف|أوقف|موقوف/, es: /retirad/, pt: /descontinu/,
};
// …or next to the refusal the current CLI gives them.
const REFUSED = {
  ja: /拒否/, ko: /거부/, de: /lehnt[^.]*ab/, fr: /refuse/, ar: /يرفض/, es: /rechaza/, pt: /recusa/,
};
// A runnable command on the retired transport: an SSH destination, pull, or
// the SSH-only -i / -p on push or sync.
const SSH_CMD = /\brelayium\s+(?:push|sync|pull)\b[^\n]*\s\S+@\S+:|\brelayium\s+pull\b|\brelayium\s+(?:push|sync)\b[^\n]*\s-[ip]\s/;
// Prose that names the SSH-era commands.
const SSH_PROSE = /relayium pull|push ?\/ ?pull/;
// The CLI Device Inbox is not receive-only (relayium inbox send). No archived
// page ever said so — the corpus predates the inbox — so this is preventive.
const INBOX = /inbox|Inbox|受信箱|수신함|Posteingang|boîte de réception|صندوق الوارد|bandeja de entrada|caixa de entrada/;
const RECEIVE_ONLY = {
  ja: /受信側(?:のみ|だけ)|受信専用/, ko: /수신 전용|받는 쪽만/, de: /nur (?:die )?Empfangsseite|nur empfangen/,
  fr: /uniquement (?:le côté )?réception|réception seulement/, ar: /الاستقبال فقط/, es: /solo (?:el lado de )?recepción/,
  pt: /(?:só|apenas) (?:o lado de )?recebimento/,
};

const leavesOf = (o, p = "", out = []) => {
  if (typeof o === "string") out.push([p, o]);
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) leavesOf(v, p ? `${p}.${k}` : k, out);
  return out;
};
const contentDir = resolve(import.meta.dirname, "content");
const CONTENT_FILES = [
  ...readdirSync(resolve(contentDir, "articles")).map((f) => `articles/${f}`),
  ...readdirSync(resolve(contentDir, "legal")).map((f) => `legal/${f}`),
].filter((f) => f.endsWith(".mjs") && !f.includes(".test."));
const MODULES = await Promise.all(CONTENT_FILES.map(async (f) => [f, (await import(`./content/${f}`)).default]));

/** Every [where, string] of one archived locale, cliDirectFacts included. */
function archivedLeaves(lang) {
  const out = [[`realtime-facts:cliDirectFacts.${lang}`, cliDirectFacts[lang]]];
  for (const [f, mod] of MODULES) for (const [k, s] of leavesOf(mod?.langs?.[lang])) out.push([`${f}:${k}`, s]);
  return out;
}

/** What a locale's archived source must not say, as a list of complaints. */
function cliErrataComplaints(lang, leaves) {
  const bad = [];
  for (const [where, s] of leaves) {
    for (const old of OLD_CLI_CLAIMS[lang]) if (s.includes(old)) bad.push(`${where}: retired claim ${JSON.stringify(old.slice(0, 50))}`);
    const isCode = /\.code\.|\.code$/.test(where);
    if (isCode && SSH_CMD.test(s)) bad.push(`${where}: runnable retired SSH command`);
    if (!isCode && SSH_PROSE.test(s) && !RETIRED[lang].test(s) && !REFUSED[lang].test(s)) bad.push(`${where}: names push/pull or relayium pull as current`);
    if (INBOX.test(s) && RECEIVE_ONLY[lang].test(s)) bad.push(`${where}: calls the Device Inbox receive-only`);
  }
  return bad;
}

const archivedPages = (lang) => globSync(`${lang}/**/index.html`, { cwd: publicDir }).map((p) => [p, readFileSync(resolve(publicDir, p), "utf8")]);
const codeBlocksOf = (html) => [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unesc(m[1]));

// Corrected facts, per passage: what each rewritten sentence must now say. The
// Latin tokens are command names and the product's own strings, identical in
// every locale; METERED is the per-locale metering phrase.
const pair = /relayium pair/, update = /relayium update/, disabled = /SSH transfers are currently disabled/;
const FIX_CASES = [
  { page: cliSend, slug: "guides/send-a-file-to-someone", path: "lead.1", facts: (l) => [/TURN/, METERED[l]] },
  { page: cliSend, slug: "guides/send-a-file-to-someone", path: "sections.1.bullets.2", facts: () => [pair, /relayium receive/] },
  { page: cliStart, slug: "guides/transfer-files-from-terminal", path: "sections.3.bullets.2", facts: (l) => [/relayium pull/, RETIRED[l]] },
  { page: cliStart, slug: "guides/transfer-files-from-terminal", path: "sections.3.steps.2.code.0", facts: () => [/relayium push \.\/photos relayium:\/\/receiver\.example/] },
  { page: cliServer, slug: "guides/server-to-server-transfers", path: "faq.items.0.a", facts: () => [disabled] },
  { page: croc, slug: "compare/croc", path: "faq.items.0.a", facts: (l) => [METERED[l]] },
  { page: croc, slug: "compare/croc", path: "faq.items.2.a", facts: () => [update, /relayium send/, /relayium receive/] },
  { page: croc, slug: "compare/croc", path: "sections.2.body.1", facts: (l) => [new RegExp(escapeRe(sshRetiredNotice[l]))] },
  { page: wormhole, slug: "compare/magic-wormhole", path: "sections.1.body.1", facts: (l) => [/TURN/, METERED[l]] },
  { page: wormhole, slug: "compare/magic-wormhole", path: "faq.items.3.a", facts: () => [update] },
  { page: wormhole, slug: "compare/magic-wormhole", path: "sections.3.body.1", facts: (l) => [new RegExp(escapeRe(sshRetiredNotice[l]))] },
  { page: localsend, slug: "compare/localsend", path: "sections.2.body.2", facts: (l) => [METERED[l]] },
  { page: scp, slug: "compare/scp", path: "lead.0", facts: (l) => [disabled, RETIRED[l]] },
  { page: cliBackupSsh, slug: "guides/back-up-a-server-over-ssh", path: "lead.0", facts: (l) => [disabled, RETIRED[l]] },
  { page: receive, slug: "guides/receive-files-from-the-command-line", path: "sections.1.bullets.2", facts: (l) => [METERED[l]] },
  { page: receive, slug: "guides/receive-files-from-the-command-line", path: "sections.1.bullets.3", facts: () => [/relayium send/, /relayium\.com/] },
  { page: receive, slug: "guides/receive-files-from-the-command-line", path: "faq.items.1.a", facts: () => [/relayium send/, /relayium receive/] },
  { page: receive, slug: "guides/receive-files-from-the-command-line", path: "sections.4.body.0", facts: (l) => [new RegExp(escapeRe(sshRetiredNotice[l]))] },
  { page: selfHost, slug: "guides/self-host-relayium", path: "faq.items.1.a", facts: (l) => [METERED[l]] },
  { page: textHowto, slug: "how-to/send-text-between-devices", path: "sections.2.bullets.0", facts: (l) => [pair, METERED[l]] },
  { page: textHowto, slug: "how-to/send-text-between-devices", path: "faq.items.1.a", facts: () => [update] },
  { page: backups, slug: "how-to/automate-server-backups", path: "sections.5.troubleshooting.items.1.fix", facts: () => [/relayium:\/\/backup-server/] },
  { page: privacy, slug: "privacy", path: "sections.4.body.0", facts: () => [/TURN/, /pair/] },
  { page: security, slug: "security", path: "sections.3.body.0", facts: () => [/TURN/, /pair/, /push/] },
];
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const fixRows = FIX_CASES.flatMap((c) => FROZEN_LANGS.map((l) => [`${c.slug} ${c.path} ${l}`, c, l]));

describe("archived CLI errata (2026-09-30): transport, metering, interop, Inbox, SSH", () => {
  it.each(FROZEN_LANGS)("source %s: no archived passage repeats a retired CLI claim", (lang) => {
    expect(OLD_CLI_CLAIMS[lang].length, "the retired-claim table for this locale is empty").toBeGreaterThan(15);
    expect(cliErrataComplaints(lang, archivedLeaves(lang))).toEqual([]);
  });

  it.each(FROZEN_LANGS)("generated %s: no archived page repeats a retired CLI claim or runs SSH", (lang) => {
    const pages = archivedPages(lang);
    expect(pages.length, "no generated archived pages found").toBeGreaterThan(40);
    const bad = [];
    for (const [path, html] of pages) {
      const text = unesc(html);
      for (const old of OLD_CLI_CLAIMS[lang]) if (text.includes(old)) bad.push(`${path}: ${JSON.stringify(old.slice(0, 50))}`);
      for (const code of codeBlocksOf(html)) if (SSH_CMD.test(code)) bad.push(`${path}: runnable retired SSH command ${JSON.stringify(code.slice(0, 80))}`);
    }
    expect(bad).toEqual([]);
  });

  it.each(fixRows)("source %s: states the corrected fact", (_n, c, lang) => {
    const s = at(c.page.langs[lang], c.path);
    expect(typeof s, c.path).toBe("string");
    for (const re of c.facts(lang)) expect(s, `fact ${re}`).toMatch(re);
  });

  it.each(fixRows)("generated %s: carries it, archived and linked to the maintained twins", (_n, c, lang) => {
    const html = readFileSync(pagePath(c.slug, lang), "utf8");
    expect(unesc(html)).toContain(at(c.page.langs[lang], c.path));
    expect(html).toMatch(/<aside class="archived"/);
    expect(html).toContain(`<a href="/${c.slug}/" lang="en"`);
    expect(html).toContain(`<a href="/zh/${c.slug}/" lang="zh-Hans"`);
    expect(html, "archived pages stay indexable").not.toMatch(/<meta name="robots" content="[^"]*noindex/);
  });

  it("keeps the SSH notice one shared, translated fragment", () => {
    expect(Object.keys(sshRetiredNotice).sort()).toEqual([...FROZEN_LANGS].sort());
    for (const lang of FROZEN_LANGS) {
      expect(sshRetiredNotice[lang]).toMatch(disabled);
      expect(sshRetiredNotice[lang]).toMatch(RETIRED[lang]);
      expect(sshRetiredNotice[lang]).toMatch(/relayium serve/);
      expect(sshRetiredNotice[lang]).toMatch(/relayium:\/\/host/);
      expect(sshRetiredNotice[lang], "the notice must not itself show a command line").not.toMatch(/\brelayium\s+(?:push|sync)\s+\S+\s+\S+@\S+:/);
    }
  });

  // Mutation proofs: each rule has to reject the text it exists for.
  it("fails on a retired claim, a runnable SSH command, current push/pull prose and a receive-only inbox", () => {
    for (const lang of FROZEN_LANGS) {
      const shipped = [
        ["x:lead.0", OLD_CLI_CLAIMS[lang][0]],
        ["x:sections.0.code.0", "relayium push ./photos user@your-server:backups/"],
        ["x:sections.0.steps.1.code.0", "relayium pull user@host:/path/to/files ./local-dest"],
        ["x:sections.1.code.0", "0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/"],
        ["x:sections.1.bullets.0", "push/pull"],
      ];
      const bad = cliErrataComplaints(lang, shipped);
      expect(bad.filter((b) => b.includes("retired claim")), `${lang}: old claim not caught`).toHaveLength(1);
      expect(bad.filter((b) => b.includes("SSH command")), `${lang}: SSH commands not caught`).toHaveLength(3);
      expect(bad.filter((b) => b.includes("as current")), `${lang}: push/pull prose not caught`).toHaveLength(1);
    }
    expect(cliErrataComplaints("ja", [["x:a", "Device Inbox は CLI では受信側のみです"]])).toHaveLength(1);
    expect(cliErrataComplaints("de", [["x:a", "Die Device Inbox ist in der CLI nur die Empfangsseite"]])).toHaveLength(1);
  });
});
