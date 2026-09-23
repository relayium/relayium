// web/scripts/pages/cli-backup-integrity-recovery.test.mjs — what the SSH backup
// guide may tell a reader to do after "N file(s) could not be verified or saved".
//
// ── The defect this exists for ──────────────────────────────────────────────
// The native push protocol writes each incoming file to a staged temp path,
// hashes it there, and installs it at the destination ONLY once the SHA-256
// matches and the install succeeds; a mismatch, or a file the receiver cannot
// write or install, removes the temp file and the target is never created
// (server/internal/xfer). The per-file result does not say which of those it
// was, so the CLI's line names neither. So after a per-file failure:
//
//   * THIS transfer did not install the failed path. There is no corrupt file
//     from it on the server to distrust.
//   * that is not proof the path is empty. The no-clobber install is a hard
//     link, and one reason it fails is that another writer created the path
//     after preflight. So the guide must not say "nothing there to delete", and
//     must say not to delete an existing file on the strength of this message.
//   * any SIBLINGS of that batch that succeeded DID install. If there is at
//     least one, re-running the whole push is refused up front by the collision
//     check — it sees them — and errors out before sending a byte. If every file
//     failed, nothing from the batch landed and a rerun is not refused, so the
//     refusal must be stated as conditional.
//   * the recovery is to check space, permissions and the path, then push the
//     failed path alone to the same intended destination.
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
//
// ── Why the output line is read out of run.go ──────────────────────────────
// The guide once quoted "N file(s) failed integrity check" after the CLI had
// stopped claiming that every failure was a hash mismatch. The guard located the
// item by that same hard-coded string, so a stale guide and a stale guard agreed
// with each other and both passed. The line is now taken from reportExit's own
// format string, and the guide's symptom and sample must reproduce it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

import cliBackupSsh from "./content/articles/cli-backup-server-ssh.mjs";
import { LANGS } from "./shared.mjs";

/**
 * reportExit's per-file failure format, e.g. "%d file(s) could not be verified
 * or saved: %v\n". Throws when the function or its Fprintf can no longer be
 * found, so a refactor fails this file instead of silently skipping it.
 */
function reportExitFormat(runGo) {
  const body = runGo.match(/\nfunc reportExit\([^)]*\) int \{\n([\s\S]*?)\n\}\n/);
  if (!body) throw new Error("reportExit not found in run.go");
  const fmt = body[1].match(/fmt\.Fprintf\(stderr, "(%d [^"]*: %v)\\n"/);
  if (!fmt) throw new Error("reportExit's failure Fprintf not found");
  return fmt[1];
}

/** The format with %d/%v filled in, as a regexp over one output line. */
function formatLine(fmt) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [head, tail] = fmt.split("%v");
  return new RegExp("^" + head.split("%d").map(esc).join("\\d+") + "\\[[^\\]]+\\]" + esc(tail) + "$");
}

const RUN_GO = readFileSync(resolve(process.cwd(), "..", "server/cmd/relayium/run.go"), "utf8");
const FORMAT = reportExitFormat(RUN_GO);

/**
 * The troubleshooting item this rule governs, found by its code block rather
 * than by its prose: the line is CLI output and is emitted untranslated, so the
 * same bytes locate the item in all nine locales.
 */
const FAILURE_OUTPUT = FORMAT.split(": %v")[0].replace(/^%d /, "");

function integrityItems(doc) {
  return (doc.sections || [])
    .flatMap((s) => s.troubleshooting?.items || [])
    .filter((i) => (i.code || []).join("\n").includes(FAILURE_OUTPUT));
}

// ── The three claims, per locale ───────────────────────────────────────────

/** 1. THIS transfer did not install the failed path. */
const NOT_INSTALLED = {
  en: /this transfer did not install/i,
  zh: /这次传输没有安装/,
  ja: /今回の転送はそのパスを設置していません/,
  ko: /이번 전송은 그 경로를 설치하지 않았/,
  de: /diese Übertragung hat den Pfad (?:also )?nicht installiert/i,
  fr: /ce transfert n'a (?:donc )?pas installé/i,
  ar: /لم يثبّت هذا النقل/,
  es: /esta transferencia no instaló/i,
  pt: /esta transferência não instalou/i,
};

/**
 * 1b. Do not delete an existing receiver file because of this message: another
 * writer may have created the path, and the message cannot tell.
 */
const DO_NOT_DELETE = {
  en: /do not delete[^.]*(?:just|merely|only) because of this message/i,
  zh: /不要仅仅因为这条消息就删除/,
  ja: /このメッセージだけを理由に[^。]*削除しないでください/,
  ko: /이 메시지만 보고[^.]*지우지 마세요/,
  de: /lösch[^.;]*nur wegen dieser Meldung/i,
  fr: /ne supprimez pas[^.]*à cause de ce seul message/i,
  ar: /لا تحذف[^.]*لمجرد هذه الرسالة/,
  es: /no borres[^.]*solo por este mensaje/i,
  pt: /não apague[^.]*só por causa desta mensagem/i,
};

/**
 * 0. The line covers a failed save or install as well as a hash mismatch, and
 * does not say which. Every locale already names SHA-256 for the mismatch half.
 */
const SAVE_FAILURE = {
  en: /could not save or install/i,
  zh: /没能保存或安装/,
  ja: /保存・設置できなかった/,
  ko: /저장하거나 설치하지 못했/,
  de: /nicht speichern oder installieren/i,
  fr: /pas pu enregistrer ou installer/i,
  ar: /لم يتمكن من حفظ الملف أو تثبيته/,
  es: /no pudo guardar o instalar/i,
  pt: /não conseguiu salvar ou instalar/i,
};

const DOES_NOT_SAY_WHICH = {
  en: /does not say which/i,
  zh: /不区分是哪一种/,
  ja: /どちらなのかを区別しません/,
  ko: /어느 쪽인지 구분하지 않/,
  de: /sagt nicht, welcher/i,
  fr: /ne dit pas lequel/i,
  ar: /لا تحدد أيهما/,
  es: /no dice cuál/i,
  pt: /não diz qual/i,
};

/**
 * 2. IF other files from the batch landed, re-running the whole batch is refused
 * by the collision check. The condition is part of the claim: each pattern
 * starts at the "if siblings landed" clause.
 */
const BATCH_RERUN_REFUSED = {
  en: /If (?:any )?other files from that batch (?:did |already )?land\w*[^.]*whole batch[^.]*refused[^.]*collision/i,
  zh: /如果同一批里有其他文件已经落地[^。]*整批重跑[^。]*冲突检查[^。]*拒绝/,
  ja: /他のファイルがすでに設置されている場合[^。]*バッチ全体[^。]*衝突チェック[^。]*拒否/,
  ko: /다른 파일이 이미 설치되었다면[^.]*배치 전체[^.]*충돌 검사[^.]*거부/,
  de: /Wenn andere Dateien dieses Stapels bereits[^.]*Kollisionsprüfung[^.]*ganzen Stapels ab\b/i,
  fr: /Si d'autres fichiers de ce lot sont déjà arrivés[^.]*tout le lot[^.]*refusé/i,
  ar: /وإن كانت ملفات أخرى من تلك الدفعة[^.]*فحص التعارض[^.]*الدفعة كاملة/,
  es: /Si otros archivos de ese lote ya llegaron[^.]*lote entero[^.]*rechaz/i,
  pt: /Se outros arquivos daquele lote já chegaram[^.]*lote inteiro[^.]*recusad/i,
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

/** 3b. ...to the same intended destination, not somewhere else. */
const SAME_DESTINATION = {
  en: /same intended destination/i,
  zh: /原来打算的位置/,
  ja: /本来の保存先/,
  ko: /원래 의도한 대상 위치/,
  de: /selben vorgesehenen Ziel/i,
  fr: /même destination prévue/i,
  ar: /الوجهة المقصودة نفسها/,
  es: /mismo destino previsto/i,
  pt: /mesmo destino pretendido/i,
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

/**
 * The unqualified absence claim this guide carried until the final W-N28 pass:
 * "never written to the server, nothing to remove there". The failed transfer
 * proves only that IT did not install the file, not that the path is empty.
 */
const CLAIMS_NOTHING_THERE = {
  en: /never (?:written|installed)[^.]*server|nothing (?:to (?:remove|delete)|there to (?:remove|delete))/i,
  zh: /没写到服务器上|没有(?:东西|什么)需要删/,
  ja: /書き込まれて(?:おらず|いません)|削除すべきものはありません/,
  ko: /쓰인 적이 없|지울 것도 없/,
  de: /nie auf den Server geschrieben|nichts zu entfernen/i,
  fr: /jamais été écrit sur le serveur|rien à y supprimer/i,
  ar: /لم يُكتب|لا شيء هناك يحتاج إلى حذف/,
  es: /nunca se escribió en el servidor|nada que borrar/i,
  pt: /nunca foi escrito no servidor|nada para remover/i,
};

/**
 * The unconditional refusal the same text carried: "is still refused ...
 * because the other files already landed", which is false when every file of
 * the batch failed.
 */
const UNCONDITIONAL_REFUSAL = {
  en: /still refused by the collision check/i,
  zh: /整批重跑仍然会被冲突检查拒绝/,
  ja: /すでに設置済みなので、バッチ全体/,
  ko: /이미 자리에 설치되었기 때문에/,
  de: /Kollisionsprüfung weiterhin ab/i,
  fr: /reste refusé par le contrôle de collision/i,
  ar: /سيظل فحص التعارض يرفضها/,
  es: /lo sigue rechazando/i,
  pt: /continua sendo recusado/i,
};

const CLAIMS = [
  ["never says the file may have failed to save or install", SAVE_FAILURE],
  ["never says the output does not tell the two causes apart", DOES_NOT_SAY_WHICH],
  ["never says this transfer did not install the failed path", NOT_INSTALLED],
  ["never says not to delete an existing file because of this message", DO_NOT_DELETE],
  ["never says a whole-batch rerun is refused if other files landed", BATCH_RERUN_REFUSED],
  ["never says to push only that one path", ONLY_THAT_PATH],
  ["never says to push it to the same intended destination", SAME_DESTINATION],
];

const FORBIDDEN = [
  ["still calls the failed file on the server untrustworthy", CALLS_IT_UNTRUSTWORTHY],
  ["still claims nothing exists at the failed path", CLAIMS_NOTHING_THERE],
  ["still states the whole-batch refusal unconditionally", UNCONDITIONAL_REFUSAL],
];

/** Every complaint about one locale's recovery text. */
function recoveryComplaints(lang, fix) {
  const bad = [];
  for (const [what, table] of CLAIMS) {
    if (!table[lang].test(fix)) bad.push(`${lang}: ${what}`);
  }
  // Locale-invariant: the mismatch half is named by its hash.
  if (!/SHA-256/.test(fix)) bad.push(`${lang}: never names the SHA-256 mismatch`);
  // Locale-invariant: the command to re-run is named, in its own spelling.
  if (!/\bpush\b/.test(fix)) bad.push(`${lang}: never names push as the command to re-run`);
  for (const [what, table] of FORBIDDEN) {
    if (table[lang].test(fix)) bad.push(`${lang}: ${what}`);
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

  it("gives the cause and recovery accurately in all nine locales", () => {
    const bad = [];
    for (const lang of LANGS) bad.push(...recoveryComplaints(lang, integrityItems(cliBackupSsh.langs[lang])[0].fix));
    expect(bad).toEqual([]);
  });

  it("quotes reportExit's actual line in each locale's symptom and sample", () => {
    const line = formatLine(FORMAT);
    const symptom = FORMAT.replace("%d", "N").split(": %v")[0];
    const bad = [];
    for (const lang of LANGS) {
      const item = integrityItems(cliBackupSsh.langs[lang])[0];
      if (!item.symptom.includes(symptom)) bad.push(`${lang}: symptom does not quote "${symptom}"`);
      const out = item.code.join("\n").split("\n").filter((l) => l.startsWith("# ")).map((l) => l.slice(2));
      if (!out.some((l) => line.test(l))) bad.push(`${lang}: sample has no line in reportExit's format`);
      // runPush prints the ssh child's exit error after the remote's line.
      if (!out.includes("exit status 1")) bad.push(`${lang}: sample omits the ssh session's "exit status 1"`);
    }
    expect(bad).toEqual([]);
  });

  it("rejects a sample quoting the CLI's previous wording", () => {
    // Mutation proof for the run.go tie: reportExit's format before W-N28, and
    // the sample line every locale carried with it.
    const previous = reportExitFormat(
      'x\nfunc reportExit(rep xfer.Report, stderr io.Writer) int {\n\tfmt.Fprintf(stderr, "%d file(s) failed integrity check: %v\\n", len(rep.Failed), termtext.SafeAll(rep.Failed))\n}\n',
    );
    expect(previous).toBe("%d file(s) failed integrity check: %v");
    expect(formatLine(FORMAT).test("1 file(s) failed integrity check: [photos/IMG_0413.jpg]")).toBe(false);
    expect(formatLine(previous).test("1 file(s) failed integrity check: [photos/IMG_0413.jpg]")).toBe(true);
  });

  it("fails on the mismatch-only recovery text the guide carried before W-N28", () => {
    // Verbatim the English and Chinese recovery text shipped alongside the old
    // "failed integrity check" line: correct about recovery, but it presents a
    // hash mismatch as the only cause.
    const SHIPPED = {
      en: "The SHA-256 computed on arrival did not match the one sent, and the native protocol stages each file and installs it only once the hash matches — so that path was never written to the server, and there is nothing to remove there. Re-running the whole batch is still refused by the collision check, because the other files from that batch already landed, so push that one path on its own. If it fails again it is not a one-off transit error: look at the source file (something writing to it while it is read) and at the storage on either end.",
      zh: "落地时算出的 SHA-256 与发送时的不一致；原生协议会先把每个文件写到暂存区，只有校验一致才安装，所以那个路径根本没写到服务器上，接收端没有东西需要删。整批重跑仍然会被冲突检查拒绝——同一批里其他文件已经落地了——所以单独 push 那一个路径。如果它反复失败，就不是一次偶发的链路错误：去查源文件（读取时是否正被写入）和两端的存储。",
    };
    for (const [lang, shipped] of Object.entries(SHIPPED)) {
      const bad = recoveryComplaints(lang, shipped).join("\n");
      expect(bad, `${lang}: the missing save/install cause was not caught`).toMatch(/fail(?:ed)? to save or install/);
      expect(bad, `${lang}: the missing does-not-say-which was not caught`).toMatch(/does not tell the two causes apart/);
    }
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
      expect(bad.join("\n"), `${lang}: the missing not-installed claim was not caught`).toMatch(/did not install/);
    }
  });

  it("fails on the unqualified recovery text the first W-N28 pass wrote", () => {
    // Mutation proof for the final correction. Verbatim the English and Chinese
    // text that pass shipped in the working tree: right about the two causes,
    // but it said nothing can be at the failed path and that the whole-batch
    // rerun is always refused.
    const WRITTEN = {
      en: "Either the SHA-256 computed on arrival did not match the one sent, or relayium on the server could not save or install the file — no free space, no permission, or a destination path it cannot write to; the message does not say which. The first line is printed by relayium on the server and forwarded over SSH, and exit status 1 is that remote process's exit code. Either way, the native protocol stages each file and installs it only after its hash matches and it has been saved — so that path was never written to the server, and there is nothing to remove there. Re-running the whole batch is still refused by the collision check, because the other files from that batch already landed, so push that one path on its own. If it fails again it is not a one-off transit error: check free space, permissions and the destination path on the server, and look at the source file (something writing to it while it is read).",
      zh: "要么落地时算出的 SHA-256 与发送时的不一致，要么服务器上的 relayium 没能保存或安装这个文件（磁盘空间不足、没有权限，或目标路径无法写入）；这条消息不区分是哪一种。第一行由服务器上的 relayium 打印、经 SSH 转发过来，后面的 exit status 1 是那个远程进程的退出码。无论哪种，原生协议都会先把每个文件写到暂存区，只有校验一致并且保存成功才安装，所以那个路径根本没写到服务器上，接收端没有东西需要删。整批重跑仍然会被冲突检查拒绝——同一批里其他文件已经落地了——所以单独 push 那一个路径。如果它反复失败，就不是一次偶发的链路错误：检查服务器上的剩余空间、权限和目标路径，并查源文件（读取时是否正被写入）。",
    };
    for (const [lang, written] of Object.entries(WRITTEN)) {
      const bad = recoveryComplaints(lang, written).join("\n");
      expect(bad, `${lang}: the absence claim was not caught`).toMatch(/claims nothing exists/);
      expect(bad, `${lang}: the unconditional refusal was not caught`).toMatch(/refusal unconditionally/);
      expect(bad, `${lang}: the missing do-not-delete was not caught`).toMatch(/not to delete/);
      expect(bad, `${lang}: the missing conditional refusal was not caught`).toMatch(/refused if other files landed/);
      expect(bad, `${lang}: the missing same-destination was not caught`).toMatch(/same intended destination/);
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
