// web/scripts/pages/cli-backup-integrity-recovery.test.mjs — what the SSH backup
// guide may tell a reader to do after "N file(s) failed integrity check".
//
// ── The defect this exists for ──────────────────────────────────────────────
// The native push protocol writes each incoming file to a staged temp path,
// hashes it there, and installs it at the destination ONLY once the SHA-256
// matches; a mismatch removes the temp file and the target is never created
// (server/internal/xfer). So after a per-file integrity failure:
//
//   * the failed path was NOT installed. There is no corrupt file on the server
//     to distrust, and nothing at that path to delete.
//   * the SIBLINGS of that batch DID install. They exist at the destination now.
//   * re-running the whole push is therefore refused up front by the collision
//     check — it sees those siblings. The rerun does not "try again", it errors
//     out before sending a byte.
//
// Seven archived translations shipped the exact inverse of all three: that the
// file on the server could not be trusted, and that the fix was to rerun the
// whole push and re-read the exit code. A reader following that either hunts
// for a file that was never written, or runs a command that cannot succeed and
// reads its collision error as a second, unrelated failure.
//
// ── Why this one runs in all nine locales ──────────────────────────────────
// cli-guide-resume-truth.mjs keeps its claim rules English-only, on the grounds
// that a claim SHAPE in nine languages is nine guesses. That reasoning does not
// transfer here, because this is not a shape being guessed at: it is a recovery
// PROCEDURE, and a reader in any locale acts on it. A frozen translation that
// still says "rerun the whole push" is a broken instruction in that locale even
// though nobody maintains its prose.
//
// So the rule runs everywhere, and pays for that with an explicit per-locale
// term table rather than translation equality. Each claim lists the alternatives
// that locale may use; nothing requires the nine sentences to correspond word
// for word, and rewording within a locale's alternatives is free. One anchor IS
// locale-invariant and is asserted as such: `push` is the command name and is
// the same bytes in all nine.
import { describe, it, expect } from "vitest";

import cliBackupSsh from "./content/articles/cli-backup-server-ssh.mjs";
import { LANGS } from "./shared.mjs";

/**
 * The troubleshooting item this rule governs, found by its code block rather
 * than by its prose: `N file(s) failed integrity check` is CLI output and is
 * emitted untranslated, so the same bytes locate the item in all nine locales.
 */
const FAILURE_OUTPUT = "file(s) failed integrity check";

function integrityItems(doc) {
  return (doc.sections || [])
    .flatMap((s) => s.troubleshooting?.items || [])
    .filter((i) => (i.code || []).join("\n").includes(FAILURE_OUTPUT));
}

// ── The three claims, per locale ───────────────────────────────────────────

/** 1. The failed path was never installed; there is nothing on the server. */
const NOT_INSTALLED = {
  en: /never (?:written|installed)[^.]*server|nothing to remove/i,
  zh: /没写到服务器上|没有(?:东西|什么)需要删/,
  ja: /書き込まれて(?:おらず|いません)|削除すべきものはありません/,
  ko: /쓰인 적이 없|지울 것도 없/,
  de: /nie auf den Server geschrieben|nichts zu entfernen/i,
  fr: /jamais été écrit sur le serveur|rien à y supprimer/i,
  ar: /لم يُكتب|لا شيء هناك يحتاج إلى حذف/,
  es: /nunca se escribió en el servidor|nada que borrar/i,
  pt: /nunca foi escrito no servidor|nada para remover/i,
};

/** 2. Re-running the whole batch is refused by the collision check. */
const BATCH_RERUN_REFUSED = {
  en: /whole batch[^.]*refused[^.]*collision|collision check[^.]*refus/i,
  zh: /整批重跑[^。]*冲突检查[^。]*拒绝|冲突检查[^。]*拒绝/,
  ja: /バッチ全体[^。]*衝突チェック[^。]*拒否/,
  ko: /배치 전체[^.]*충돌 검사[^.]*거부/,
  de: /ganzen Stapel[^.]*Kollisionsprüfung[^.]*ab\b/i,
  fr: /tout le lot[^.]*(?:refusé|contrôle de collision)/i,
  ar: /الدفعة كاملة[^.]*(?:فحص التعارض|يرفضها)/,
  es: /lote entero[^.]*(?:rechaz|colisiones)/i,
  pt: /lote inteiro[^.]*(?:recusad|colis)/i,
};

/** 3. Push only that one path again. */
const ONLY_THAT_PATH = {
  en: /that one path on its own|only that path/i,
  zh: /单独 push 那一个路径|只 push/,
  ja: /そのパスだけ/,
  ko: /그 경로 하나만/,
  de: /nur für genau diesen einen Pfad|nur diesen (?:einen )?Pfad/i,
  fr: /ce seul chemin/i,
  ar: /ذلك المسار وحده/,
  es: /solo con esa ruta|solo esa ruta/i,
  pt: /só naquele caminho|só aquele caminho/i,
};

/**
 * The claim the seven archived locales shipped and must not carry again: that
 * the file sitting on the server is not to be trusted. It cannot be there.
 */
const CALLS_IT_UNTRUSTWORTHY = {
  en: /not (?:be )?trust\w*|untrustworthy|unreliable/i,
  zh: /不可信|不可靠|不能信任/,
  ja: /信頼できません|信用できません/,
  ko: /믿을 수 없|신뢰할 수 없/,
  de: /nicht vertrauenswürdig|nicht zuverlässig/i,
  fr: /pas fiable|non fiable/i,
  ar: /غير موثوق/,
  es: /no es de fiar|no es fiable/i,
  pt: /não é confiável|não confiável/i,
};

const CLAIMS = [
  ["never says the failed path was not installed", NOT_INSTALLED],
  ["never says a whole-batch rerun is refused by the collision check", BATCH_RERUN_REFUSED],
  ["never says to push only that one path", ONLY_THAT_PATH],
];

/** Every complaint about one locale's recovery text. */
function recoveryComplaints(lang, fix) {
  const bad = [];
  for (const [what, table] of CLAIMS) {
    if (!table[lang].test(fix)) bad.push(`${lang}: ${what}`);
  }
  // Locale-invariant: the command to re-run is named, in its own spelling.
  if (!/\bpush\b/.test(fix)) bad.push(`${lang}: never names push as the command to re-run`);
  if (CALLS_IT_UNTRUSTWORTHY[lang].test(fix)) {
    bad.push(`${lang}: still calls the failed file on the server untrustworthy`);
  }
  return bad;
}

describe("the SSH backup guide's integrity-failure recovery", () => {
  it("has exactly one integrity-failure item in each of the nine locales", () => {
    // Guards the guard. If the item is renamed, moved or dropped, every rule
    // below would pass over an empty string instead of failing.
    for (const lang of LANGS) {
      expect(integrityItems(cliBackupSsh.langs[lang]), `${lang}: integrity item missing or duplicated`).toHaveLength(1);
    }
  });

  it("tells the reader the failed path was not installed, in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS) bad.push(...recoveryComplaints(lang, integrityItems(cliBackupSsh.langs[lang])[0].fix));
    expect(bad).toEqual([]);
  });

  it("fails on the recovery text the seven archived locales actually shipped", () => {
    // Mutation proof. A guard nobody has watched fail is decoration, and each of
    // these is verbatim what that locale said before this pass. All seven make
    // the same two errors: the file on the server is untrustworthy, and the fix
    // is to rerun the whole push.
    const SHIPPED = {
      ja: "到着時に計算した SHA-256 が送信時のものと一致しなかったので、サーバー上のそのファイルは信頼できません。push をやり直して終了コードをもう一度確認してください。同じファイルが繰り返し失敗するなら、そのファイルだけを push して、元データの問題か回線の問題かを切り分けます。",
      ko: "도착 시 계산한 SHA-256이 보낸 값과 달랐으므로 서버의 그 파일은 믿을 수 없습니다. push를 다시 실행하고 종료 코드를 한 번 더 확인하세요. 같은 파일이 계속 실패한다면 그 파일만 따로 push해서 원본 문제인지 회선 문제인지를 갈라내세요.",
      de: "Der beim Eintreffen berechnete SHA-256 stimmte nicht mit dem gesendeten überein, diese Datei ist auf dem Server also nicht vertrauenswürdig. Wiederhol den push und sieh dir den Exit-Code erneut an. Scheitert dieselbe Datei immer wieder, push sie einzeln, um eine kaputte Quelle von einer kaputten Leitung zu trennen.",
      fr: "Le SHA-256 calculé à l'arrivée ne correspondait pas à celui envoyé, ce fichier n'est donc pas fiable sur le serveur. Relancez le push et regardez à nouveau le code de sortie. Si le même fichier échoue systématiquement, poussez-le seul pour distinguer une source abîmée d'un lien abîmé.",
      ar: "قيمة SHA-256 المحسوبة عند الوصول لم تطابق المُرسَلة، فذلك الملف غير موثوق على الخادم. أعِد تشغيل push وانظر إلى رمز الخروج مرة أخرى. وإن ظل الملف نفسه يفشل، ادفعه وحده للتمييز بين مصدر تالف ووصلة تالفة.",
      es: "El SHA-256 calculado al llegar no coincidió con el enviado, así que ese archivo no es de fiar en el servidor. Repite el push y vuelve a mirar el código de salida. Si el mismo archivo falla una y otra vez, súbelo solo para separar un origen dañado de un enlace dañado.",
      pt: "O SHA-256 calculado na chegada não bateu com o enviado, então aquele arquivo não é confiável no servidor. Rode o push de novo e olhe o código de saída outra vez. Se o mesmo arquivo continuar falhando, envie só ele para separar uma origem estragada de um enlace estragado.",
    };
    for (const [lang, shipped] of Object.entries(SHIPPED)) {
      const bad = recoveryComplaints(lang, shipped);
      expect(bad, `${lang}: the shipped recovery text was not caught`).not.toEqual([]);
      // Specifically: both halves of the defect, not just one incidental miss.
      expect(bad.join("\n"), `${lang}: the untrustworthy-file claim was not caught`).toMatch(/untrustworthy/);
      expect(bad.join("\n"), `${lang}: the missing not-installed claim was not caught`).toMatch(/not installed/);
    }
  });

  it("does not reach the item through any other guide's troubleshooting box", () => {
    // The locator is a code-block substring, so it would silently pick up a
    // second item if one were added elsewhere in this document. Pinned to the
    // section that owns it.
    const owning = (cliBackupSsh.langs.en.sections || []).filter((s) =>
      (s.troubleshooting?.items || []).some((i) => (i.code || []).join("\n").includes(FAILURE_OUTPUT)),
    );
    expect(owning).toHaveLength(1);
  });
});
