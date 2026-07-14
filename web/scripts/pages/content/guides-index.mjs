// web/scripts/pages/content/guides-index.mjs — localized copy for the Guides hub page.
// English is the master; the other five follow the identical shape.
const en = {
  title: "Guides · Relayium",
  description:
    "Step-by-step guides and comparisons for moving files with Relayium — from the terminal, between phones, server to server, and versus other tools.",
  heading: "Guides",
  intro:
    "Everything about moving files with Relayium — terminal how-tos, phone-to-phone transfers, and honest comparisons with other tools.",
  categories: { guides: "Guides", howTo: "How-to", compare: "Comparisons" },
};
const zh = {
  title: "使用指南 · Relayium",
  description:
    "用 Relayium 传输文件的分步指南与对比：从终端、手机之间、服务器到服务器，以及与其它工具的对比。",
  heading: "使用指南",
  intro: "关于用 Relayium 传输文件的一切——终端操作、手机互传，以及与其它工具的坦诚对比。",
  categories: { guides: "教程", howTo: "操作指南", compare: "对比" },
};
const ja = {
  title: "ガイド · Relayium",
  description:
    "Relayium でファイルを転送するためのステップバイステップのガイドと比較。ターミナル、スマホ間、サーバー間、他ツールとの比較まで。",
  heading: "ガイド",
  intro: "Relayium でのファイル転送のすべて——ターミナル操作、スマホ間転送、他ツールとの率直な比較。",
  categories: { guides: "ガイド", howTo: "ハウツー", compare: "比較" },
};
const ko = {
  title: "가이드 · Relayium",
  description:
    "Relayium으로 파일을 전송하는 단계별 가이드와 비교. 터미널, 휴대폰 간, 서버 간, 다른 도구와의 비교까지.",
  heading: "가이드",
  intro: "Relayium으로 파일을 전송하는 모든 것 — 터미널 사용법, 휴대폰 간 전송, 다른 도구와의 솔직한 비교.",
  categories: { guides: "가이드", howTo: "사용법", compare: "비교" },
};
const de = {
  title: "Anleitungen · Relayium",
  description:
    "Schritt-für-Schritt-Anleitungen und Vergleiche zum Übertragen von Dateien mit Relayium — vom Terminal, zwischen Handys, Server zu Server und im Vergleich zu anderen Tools.",
  heading: "Anleitungen",
  intro:
    "Alles zum Übertragen von Dateien mit Relayium — Terminal-Anleitungen, Handy-zu-Handy-Übertragungen und ehrliche Vergleiche mit anderen Tools.",
  categories: { guides: "Anleitungen", howTo: "How-to", compare: "Vergleiche" },
};
const fr = {
  title: "Guides · Relayium",
  description:
    "Guides pas à pas et comparatifs pour transférer des fichiers avec Relayium — depuis le terminal, entre téléphones, de serveur à serveur, et face aux autres outils.",
  heading: "Guides",
  intro:
    "Tout pour transférer des fichiers avec Relayium — tutoriels en terminal, transferts entre téléphones et comparatifs honnêtes avec d'autres outils.",
  categories: { guides: "Guides", howTo: "Tutoriels", compare: "Comparatifs" },
};
const ar = {
  title: "الأدلة · Relayium",
  description:
    "أدلة إرشادية خطوة بخطوة ومقارنات لنقل الملفات باستخدام Relayium — من الطرفية، وبين الهواتف، ومن خادم إلى خادم، ومقارنةً بالأدوات الأخرى.",
  heading: "الأدلة",
  intro:
    "كل ما يخص نقل الملفات باستخدام Relayium — شروحات الطرفية، والنقل بين الهواتف، ومقارنات صادقة مع الأدوات الأخرى.",
  categories: { guides: "الأدلة", howTo: "كيفية", compare: "المقارنات" },
};
const es = {
  title: "Guías · Relayium",
  description:
    "Guías paso a paso y comparativas para transferir archivos con Relayium — desde la terminal, entre teléfonos, de servidor a servidor y frente a otras herramientas.",
  heading: "Guías",
  intro:
    "Todo sobre transferir archivos con Relayium — tutoriales en la terminal, transferencias entre teléfonos y comparativas honestas con otras herramientas.",
  categories: { guides: "Guías", howTo: "Cómo", compare: "Comparativas" },
};
const pt = {
  title: "Guias · Relayium",
  description:
    "Guias passo a passo e comparativos para transferir arquivos com o Relayium — do terminal, entre celulares, de servidor a servidor e frente a outras ferramentas.",
  heading: "Guias",
  intro:
    "Tudo sobre transferir arquivos com o Relayium — tutoriais no terminal, transferências entre celulares e comparativos honestos com outras ferramentas.",
  categories: { guides: "Guias", howTo: "Como", compare: "Comparativos" },
};

export default { slug: "guides", updated: "2026-07-09", langs: { en, zh, ja, ko, de, fr, ar, es, pt } };
