import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import encryptionGuide from "./content/articles/guides-how-encryption-works.mjs";

// Three claims on this page were false in a way no generic "mentions SAS" check
// would catch, so each is pinned by the sentence that made it false rather than
// by the sentence that replaced it. Conditional rewordings stay free to change:
// what is banned is the claim, and what is required is stated in terms of which
// concepts must appear together, not in which words.

// 1. "advanced verification is off by default, and the protection described
//    below still applies in full." Encryption, commit-reveal and AEAD do still
//    apply; detecting a swapped key or an unintended peer does not — that needs
//    the setting ON and two people actually comparing the code out of band.
const bannedFullProtection = {
  en: /still applies to it in full/i,
  zh: /下面这套保护对它同样完整生效/,
  ja: /以下の保護はそのまま完全に働きます/,
  ko: /아래에 설명한 보호는 그대로 온전히 적용됩니다/,
  de: /der unten beschriebene Schutz gilt für sie trotzdem vollständig/i,
  fr: /la protection décrite ci-dessous s'y applique intégralement/i,
  ar: /وتظل الحماية الموضّحة أدناه سارية عليها بالكامل/u,
  es: /la protección descrita abajo se le aplica igualmente por completo/i,
  pt: /a proteção descrita abaixo continua valendo integralmente para ela/i,
};

// The concepts the replacement must keep together: the setting, and a real
// out-of-band comparison. Term-level so any accurate phrasing passes.
const verificationTerm = {
  en: /advanced verification/i,
  zh: /高级验证/,
  ja: /高度な検証/,
  ko: /고급 검증/,
  de: /erweiterte[nr]? Verifizierung/i,
  fr: /vérification avancée/i,
  ar: /التحقّق المتقدّم/u,
  es: /verificación avanzada/i,
  pt: /verificação avançada/i,
};

const comparisonTerm = {
  en: /compar/i,
  zh: /核对/,
  ja: /読み合わせ|照合/,
  ko: /맞춰|대조|비교/,
  de: /vergleich/i,
  fr: /compar/i,
  ar: /مقارنة|يقارن|قارن/u,
  es: /compar/i,
  pt: /compar/i,
};

// 2. "A visual SAS mismatch means the commit-then-reveal check failed." It does
//    not: a commitment/reveal mismatch fails the handshake before any code is
//    shown. Two different codes on screen mean the optional comparison caught
//    two different endpoint views — substitution, not a handshake failure.
const bannedMismatchCause = {
  en: /mismatch means the commit-then-reveal check failed/i,
  zh: /码不一致意味着「先承诺后揭示」的校验没有通过/,
  ja: /コミット後開示の検証が失敗したことを意味/,
  ko: /커밋 후 공개 검증이 실패했다는 뜻/,
  de: /Abweichung bedeutet, dass die Commit-dann-Offenlegen-Prüfung fehlgeschlagen/i,
  fr: /signifie que la vérification .{0,3}engagement puis révélation.{0,3} a échoué/i,
  ar: /عدم التطابق يعني أن فحص «الالتزام ثم الكشف» قد فشل/u,
  es: /significa que la comprobación de comprometer-y-luego-revelar falló/i,
  pt: /significa que a verificação de comprometer-e-depois-revelar falhou/i,
};

// The distinction has to survive, not just the false half of it: the answer
// must still name the commit-reveal handshake (as the separate, earlier
// failure) rather than dropping it.
const commitRevealTerm = {
  en: /commit-then-reveal/i,
  zh: /先承诺后揭示/,
  ja: /コミット後開示/,
  ko: /커밋 후 공개/,
  de: /Commit-dann-Offenlegen/i,
  fr: /engagement puis révélation/i,
  ar: /الالتزام ثم الكشف/u,
  es: /comprometer-y-luego-revelar/i,
  pt: /comprometer-e-depois-revelar/i,
};

// 3. "the code is shown only when that setting is on before the connection is
//    made." `verifyOn` and `shownSasCode` are reactive: switching the preference
//    on mid-session does put the already-derived SAS on screen. What is not
//    retroactive is a gate that was already passed — a confirmation skipped or
//    content already flowing cannot be un-skipped — which is why the advice is
//    still "turn it on first", but not because the flag is read once at connect
//    time.
const bannedReadAtConnect = {
  en: /only when that setting is on before the connection/i,
  zh: /只有在建立连接之前打开这个开关，才会显示校验码/,
  ja: /接続が確立する前にこの設定がオンになっている場合にのみ表示/,
  ko: /연결이 맺어지기 전에 이 설정이 켜져 있을 때만 표시/,
  de: /nur, wenn diese Einstellung schon vor dem Verbindungsaufbau aktiv ist/i,
  fr: /ne s'affiche que si ce réglage est actif avant l'établissement de la connexion/i,
  ar: /لا يظهر الرمز إلا إذا كان هذا الإعداد مفعَّلًا قبل إنشاء الاتصال/u,
  es: /el código solo aparece si ese ajuste está activo antes de establecer la conexión/i,
  pt: /o código só aparece se essa opção estiver ligada antes de a conexão ser estabelecida/i,
};

// What the CTA must say instead: turn the preference on BEFORE a new connection,
// so the comparison and the confirmation steps are in force from the start.
const beforeConnectingTerm = {
  en: /before you start a new connection/i,
  zh: /在开始新连接之前/,
  ja: /新しい接続を始める前に/,
  ko: /새 연결을 시작하기 전에/,
  de: /bevor du eine neue Verbindung startest/i,
  fr: /avant de lancer une nouvelle connexion/i,
  ar: /قبل بدء اتصال جديد/u,
  es: /antes de iniciar una nueva conexión/i,
  pt: /antes de iniciar uma nova conexão/i,
};

/** The FAQ answer about two codes that do not match, in one language.
 *
 * Located by content rather than by index so reordering the FAQ does not
 * silently point these assertions at some other answer. The mismatch item is
 * the only one that discusses the handshake; if a rewrite ever drops that, the
 * fallback returns the last item and the "still names the handshake" assertion
 * below fails loudly instead of the lookup passing on the wrong text. */
function mismatchAnswer(lang) {
  const items = encryptionGuide.langs[lang].faq.items;
  const item = items.find((i) => commitRevealTerm[lang].test(i.a));
  return (item ?? items[items.length - 1]).a;
}

describe("encryption guide: what verification does and does not cover", () => {
  it("does not claim the full protection applies with verification off, in any locale", () => {
    for (const lang of LANGS) {
      const body = encryptionGuide.langs[lang].sections[1].body.join(" ");
      expect(body, `${lang}: "protection applies in full" is false with the SAS off`).not.toMatch(
        bannedFullProtection[lang],
      );
    }
  });

  it("ties substitution detection to the setting AND a real out-of-band comparison", () => {
    for (const lang of LANGS) {
      const body = encryptionGuide.langs[lang].sections[1].body.join(" ");
      expect(body, `${lang}: names the preference`).toMatch(verificationTerm[lang]);
      expect(body, `${lang}: requires comparing the code`).toMatch(comparisonTerm[lang]);
    }
  });

  it("does not blame a visual code mismatch on the commit-then-reveal handshake", () => {
    for (const lang of LANGS) {
      const answer = mismatchAnswer(lang);
      expect(answer, `${lang}: a mismatch is not a commit/reveal failure`).not.toMatch(
        bannedMismatchCause[lang],
      );
      expect(answer, `${lang}: the handshake is still named as the other failure`).toMatch(
        commitRevealTerm[lang],
      );
    }
  });

  it("explains in English that a failed handshake aborts before any code is shown", () => {
    expect(mismatchAnswer("en")).toMatch(/before any code is shown/i);
  });

  it("does not promise a default user that a code will appear", () => {
    for (const lang of LANGS) {
      const cta = encryptionGuide.langs[lang].cta.text;
      expect(cta, `${lang}: the CTA must name the preference the code depends on`).toMatch(
        verificationTerm[lang],
      );
      expect(cta, `${lang}: the CTA must say to turn it on before connecting`).toMatch(
        beforeConnectingTerm[lang],
      );
      expect(cta, `${lang}: the preference is reactive, not read once at connect time`).not.toMatch(
        bannedReadAtConnect[lang],
      );
    }
    // The English CTA used to read "start a transfer, turn on advanced
    // verification, and watch the code appear". That ordering is still the wrong
    // advice — by then any gate that was going to be skipped already was — so it
    // stays banned, but for that reason, not for the one the previous rewrite
    // gave.
    expect(encryptionGuide.langs.en.cta.text).not.toMatch(
      /start a transfer,\s*turn on advanced verification/i,
    );
  });
});
