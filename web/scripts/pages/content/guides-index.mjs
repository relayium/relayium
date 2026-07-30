// web/scripts/pages/content/guides-index.mjs — localized copy for the Guides hub page.
// English is the master; the other eight follow the identical shape.
const en = {
  title: "Guides · Relayium",
  description:
    "Step-by-step guides and comparisons for moving files with Relayium — plus ephemeral encrypted text when both devices are online.",
  heading: "Guides",
  intro:
    "Everything about moving files with Relayium — terminal how-tos, phone-to-phone transfers, and honest comparisons with other tools — plus the ephemeral encrypted text Relayium carries when both devices are online.",
  categories: { guides: "Guides", howTo: "How-to", compare: "Comparisons" },
};
const zh = {
  title: "使用指南 · Relayium",
  description:
    "用 Relayium 传输文件的分步指南与对比，以及双方在线时发送临时加密文本的方法。",
  heading: "使用指南",
  intro: "关于用 Relayium 传输文件的一切——终端操作、手机互传，以及与其他工具的坦诚对比；双方都在线时，Relayium 还能发送临时加密文本。",
  categories: { guides: "教程", howTo: "操作指南", compare: "对比" },
};
const ja = {
  title: "ガイド · Relayium",
  description:
    "Relayium でファイルを転送するための手順と比較に加え、両方の端末がオンライン時に一時的な暗号化テキストを送る方法。",
  heading: "ガイド",
  intro: "Relayium でのファイル転送のすべて——ターミナル操作、スマホ間転送、他ツールとの率直な比較。両方の端末がオンラインなら、Relayium は一時的な暗号化テキストも運びます。",
  categories: { guides: "ガイド", howTo: "ハウツー", compare: "比較" },
};
const ko = {
  title: "가이드 · Relayium",
  description:
    "Relayium으로 파일을 전송하는 단계별 가이드와 비교, 그리고 두 기기가 모두 온라인일 때 일회성 암호화 텍스트를 보내는 방법.",
  heading: "가이드",
  intro: "Relayium으로 파일을 전송하는 모든 것 — 터미널 사용법, 휴대폰 간 전송, 다른 도구와의 솔직한 비교. 두 기기가 모두 온라인이면 Relayium으로 일회성 암호화 텍스트도 보낼 수 있습니다.",
  categories: { guides: "가이드", howTo: "사용법", compare: "비교" },
};
const de = {
  title: "Anleitungen · Relayium",
  description:
    "Schritt-für-Schritt-Anleitungen und Vergleiche für Dateiübertragungen mit Relayium — plus flüchtiger verschlüsselter Text, wenn beide Geräte online sind.",
  heading: "Anleitungen",
  intro:
    "Alles zum Übertragen von Dateien mit Relayium — Terminal-Anleitungen, Handy-zu-Handy-Übertragungen und ehrliche Vergleiche mit anderen Tools — dazu der flüchtige verschlüsselte Text, den Relayium überträgt, wenn beide Geräte online sind.",
  categories: { guides: "Anleitungen", howTo: "How-to", compare: "Vergleiche" },
};
const fr = {
  // "Guides" is the same word in French and English, so this page and /guides/
  // shipped byte-identical <title>s — a duplicate title across two indexable
  // URLs. Qualified here rather than in English, where "Guides" is the term
  // people search for.
  title: "Guides et tutoriels · Relayium",
  description:
    "Guides et comparatifs pour transférer des fichiers avec Relayium — plus du texte chiffré éphémère quand les deux appareils sont en ligne.",
  heading: "Guides",
  intro:
    "Tout pour transférer des fichiers avec Relayium — tutoriels en terminal, transferts entre téléphones et comparatifs honnêtes avec d'autres outils — sans oublier le texte chiffré éphémère que Relayium transporte quand les deux appareils sont en ligne.",
  categories: { guides: "Guides", howTo: "Tutoriels", compare: "Comparatifs" },
};
const ar = {
  title: "الأدلة · Relayium",
  description:
    "أدلة ومقارنات لنقل الملفات باستخدام Relayium، إضافةً إلى النص المُشفَّر المؤقت حين يكون الجهازان متصلين.",
  heading: "الأدلة",
  intro:
    "كل ما يخص نقل الملفات باستخدام Relayium — شروحات الطرفية، والنقل بين الهواتف، ومقارنات صادقة مع الأدوات الأخرى — إضافةً إلى النص المُشفَّر العابر الذي ينقله Relayium حين يكون الجهازان متصلين.",
  categories: { guides: "الأدلة", howTo: "كيفية", compare: "المقارنات" },
};
const es = {
  title: "Guías · Relayium",
  description:
    "Guías y comparativas para transferir archivos con Relayium, además de texto cifrado efímero cuando ambos dispositivos están conectados.",
  heading: "Guías",
  intro:
    "Todo sobre transferir archivos con Relayium — tutoriales en la terminal, transferencias entre teléfonos y comparativas honestas con otras herramientas — además del texto cifrado efímero que lleva Relayium cuando ambos dispositivos están conectados.",
  categories: { guides: "Guías", howTo: "Cómo", compare: "Comparativas" },
};
const pt = {
  title: "Guias · Relayium",
  description:
    "Guias e comparativos para transferir arquivos com o Relayium, além de texto criptografado efêmero quando os dois dispositivos estão online.",
  heading: "Guias",
  intro:
    "Tudo sobre transferir arquivos com o Relayium — tutoriais no terminal, transferências entre celulares e comparativos honestos com outras ferramentas — além do texto criptografado efêmero que o Relayium leva quando os dois dispositivos estão online.",
  categories: { guides: "Guias", howTo: "Como", compare: "Comparativos" },
};

export default { slug: "guides", updated: "2026-07-30", langs: { en, zh, ja, ko, de, fr, ar, es, pt } };
