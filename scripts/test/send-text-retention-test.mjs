#!/usr/bin/env node
// Migrated from web/scripts/pages/send-text-retention.test.mjs with assertions preserved.
// Root documentation changes do not select web.yml; repo-hygiene.yml runs this
// dependency-free Node check on main pushes and through merge-gate on PRs. Inputs resolve from this module. Keep this as the sole owner of these tests.
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import article from "../../web/scripts/pages/content/articles/howto-send-text-between-devices.mjs";
import { LANGS } from "../../web/scripts/pages/shared.mjs";

// The README's text paragraph names three paths. The CLI one changed with the
// published CLI v0.27.0: its text joined the pairing-code relay rule, and
// direct-only became the limit of v0.26.0 and earlier and of an older CLI peer.
// Line breaks in the README are layout, so the checks read it with runs of
// whitespace collapsed.
const FIRST_RELAYED_CLI = [0, 27, 0];
const LAST_DIRECT_ONLY_CLI = "v0.26.0";
const flat = (text) => text.replace(/\s+/g, " ");
const atLeast = (version, floor) => {
  const v = version.split(".").map(Number);
  for (let i = 0; i < floor.length; i += 1) if (v[i] !== floor[i]) return v[i] > floor[i];
  return true;
};
/** The CLI clause that follows the browser cross-network clause, up to its full stop. */
function cliTextClause(readme) {
  const anchor = "cross-network browser sessions use TURN that carries only ciphertext; ";
  const at = readme.indexOf(anchor);
  if (at < 0) return null;
  const rest = readme.slice(at + anchor.length);
  return rest.slice(0, rest.search(/\.(?:\s|$)/) + 1);
}

const NO_SERVER_HISTORY = {
  en: /Relayium servers keep no message bodies or server-side history/i,
  zh: /Relayium 服务器不保存消息正文或服务端历史/,
  ja: /Relayium サーバーは本文やサーバー側履歴を保存しません/,
  ko: /Relayium 서버는 본문이나 서버 측 기록을 저장하지 않/,
  de: /Relayium-Server speichern weder Nachrichteninhalte noch serverseitigen Verlauf/i,
  fr: /serveurs Relayium ne gardent ni corps de message ni historique côté serveur/i,
  ar: /لا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم/,
  es: /servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor/i,
  pt: /servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor/i,
};

const ENDPOINT_RETENTION = {
  en: /either endpoint can (?:copy or )?retain received text/i,
  zh: /任一端都(?:能|可).*留存收到的文本/,
  ja: /各端末は受信テキストを(?:コピーまたは)?保持できます/,
  ko: /각 기기는 받은 텍스트를 (?:복사하거나 )?보관할 수 있습니다/,
  de: /beide Endpunkte können empfangenen Text (?:kopieren oder )?aufbewahren/i,
  fr: /chaque extrémité peut (?:copier ou )?conserver le texte reçu/i,
  ar: /يمكن لأي طرف (?:نسخ النص المستلم أو )?الاحتفاظ بالنص المستلم|يمكن لأي طرف الاحتفاظ بالنص المستلم/,
  es: /cualquiera de los extremos puede (?:copiar o )?conservar el texto recibido/i,
  pt: /qualquer ponta pode (?:copiar ou )?conservar o texto recebido/i,
};

const OLD_ABSOLUTE = {
  en: /\bnever stored\b|Relayium never stores them|never stored by Relayium/i,
  zh: /Relayium 从不存储/,
  ja: /Relayium は保存しません|内容.*保存されません/,
  ko: /Relayium은 저장하지 않습니다|내용.*저장되지 않습니다/,
  de: /nie von Relayium gespeichert|Inhalt.*wird nicht gespeichert/i,
  fr: /jamais stocké|ne sont jamais stockés|n'est jamais stocké/i,
  ar: /ولا يخزنها Relayium|المحتوى.*لا يُخزن/,
  es: /nunca almacenado|Relayium nunca los almacena|contenido.*nunca se almacena/i,
  pt: /nunca armazenado|nunca são armazenadas pelo Relayium|conteúdo.*nunca armazenado/i,
};

describe("text guide scopes storage claims to Relayium servers", () => {
  for (const lang of LANGS) {
    it(`${lang}: states the server boundary and endpoint retention`, () => {
      const doc = article.langs[lang];
      const leadAndFaq = [doc.description, ...doc.lead, ...doc.faq.items.map((item) => item.a)].join(" ");

      assert.match(leadAndFaq, NO_SERVER_HISTORY[lang]);
      assert.match(leadAndFaq, ENDPOINT_RETENTION[lang]);
      assert.doesNotMatch(leadAndFaq, OLD_ABSOLUTE[lang]);
    });
  }

  it("README distinguishes browser LAN, browser cross-network, and CLI text paths", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    assert.ok(readme.includes("opens an independent end-to-end encrypted connection"));
    assert.ok(readme.includes("On a LAN, browser messages move directly"));
    assert.ok(readme.includes("cross-network browser sessions use TURN that carries only ciphertext"));
    const r = flat(readme);
    const clause = cliTextClause(r);
    assert.ok(clause?.startsWith("CLI text "), "the CLI text clause no longer follows the browser cross-network clause");
    const current = /^CLI text follows the pairing-code relay rule\b[^.]*? in the published CLI \(v(\d+\.\d+\.\d+)\)/.exec(clause);
    assert.ok(current && atLeast(current[1], FIRST_RELAYED_CLI),
      `the published CLI's text is not stated to follow the pairing-code relay rule: ${clause}`);
    assert.ok(clause.includes(`direct-only in CLI ${LAST_DIRECT_ONLY_CLI} and earlier`),
      `CLI text's direct-only limit lost its historical version scope: ${clause}`);
    assert.ok(clause.includes("direct-only") && clause.slice(clause.indexOf("direct-only")).includes("with an older CLI peer"),
      `CLI text's direct-only limit no longer covers an older CLI peer: ${clause}`);
    for (const sentence of r.split(/(?<=[.!?])\s+/)) {
      if (/\bCLI text\b/.test(sentence) && /direct-only/.test(sentence)) {
        assert.ok(sentence.includes(`CLI ${LAST_DIRECT_ONLY_CLI} and earlier`), `unscoped CLI text direct-only claim: ${sentence}`);
      }
    }
    assert.ok(!readme.includes("a message session\nopens a peer-to-peer connection of its own"));
  });
});
