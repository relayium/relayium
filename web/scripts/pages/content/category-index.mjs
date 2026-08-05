// web/scripts/pages/content/category-index.mjs — copy for the two category root
// pages, /how-to/ and /compare/.
//
// These exist because 37 published articles sit under URL segments that answered
// a hard 404 in all nine languages: a reader who truncated
// /how-to/send-a-folder/ to /how-to/ got an error page, and so did a crawler
// following the same instinct. Generating a real index.html is also what makes
// the fix land in production without an ops change — nginx resolves
// `try_files $uri $uri.html $uri/ =404` and never reaches the Go handler, so a
// server-side redirect would have been dead code.
//
// Only title/description/intro live here. The HEADING is deliberately absent:
// the page reuses `categories.howTo` / `categories.compare` from
// guides-index.mjs, so the two indexes cannot drift into calling one category
// two different things.
const howTo = {
  en: {
    title: "How-to · Relayium",
    description:
      "Twelve step-by-step how-tos for moving files, folders and text between phones, computers and servers with Relayium — end-to-end encrypted.",
    intro:
      "Twelve practical walkthroughs: phone to computer, Mac to Windows, a whole folder, a QR code, a download link that expires, an automated encrypted server backup. On the same network, files and live text need no account.",
  },
  zh: {
    title: "操作指南 · Relayium",
    description:
      "12 篇分步操作指南：用 Relayium 在手机、电脑和服务器之间传输文件、整个文件夹和文本，全程端到端加密。",
    intro:
      "12 篇实操教程：手机传电脑、Mac 与 Windows 互传、整个文件夹、扫码传输、会过期的下载链接，以及自动执行的加密服务器备份。在同一网络下，传文件和实时文本都无需登录。",
  },
  ja: {
    title: "ハウツー · Relayium",
    description:
      "スマホ、パソコン、サーバーの間でファイル・フォルダ・テキストを Relayium で送る、エンドツーエンド暗号化された12本の手順ガイド。",
    intro:
      "12本の実践ガイド——スマホからパソコンへ、Mac と Windows の間で、フォルダごと、QR コードで、期限切れになるダウンロードリンクで、自動化した暗号化サーバーバックアップまで。同一ネットワークなら、ファイル転送もリアルタイムのテキストもアカウントなしで使えます。",
  },
  ko: {
    title: "사용법 · Relayium",
    description:
      "휴대폰과 컴퓨터, 서버 사이에서 파일과 폴더, 텍스트를 Relayium으로 주고받는 종단간 암호화 단계별 안내 12편.",
    intro:
      "실전 가이드 12편 — 휴대폰에서 컴퓨터로, Mac과 Windows 사이로, 폴더 통째로, QR 코드로, 만료되는 다운로드 링크로, 자동화한 암호화 서버 백업까지. 같은 네트워크에서는 파일 전송도 실시간 텍스트도 로그인이 필요 없습니다.",
  },
  de: {
    // Not "How-to · Relayium": the German category LABEL is literally "How-to",
    // so the English and German roots would ship one title on two indexable
    // URLs — the exact duplicate-title defect site-graph.test.mjs fails on, and
    // the one the French Guides hub title was already fixed for. The h1 still
    // reads "How-to", from the shared category label.
    title: "How-to-Anleitungen · Relayium",
    description:
      "Zwölf Schritt-für-Schritt-Anleitungen, um Dateien, ganze Ordner und Text mit Relayium zwischen Handy, Rechner und Server zu übertragen — Ende-zu-Ende-verschlüsselt.",
    intro:
      "Zwölf Anleitungen aus der Praxis — vom Handy an den Rechner, zwischen Mac und Windows, ein ganzer Ordner, per QR-Code, über einen ablaufenden Download-Link, bis zum automatisierten verschlüsselten Server-Backup. Im selben Netzwerk brauchst du für Dateien und Live-Text kein Konto.",
  },
  fr: {
    title: "Tutoriels · Relayium",
    description:
      "Douze tutoriels pas à pas pour transférer fichiers, dossiers et texte avec Relayium entre téléphone, ordinateur et serveur, chiffrés de bout en bout.",
    intro:
      "Douze tutoriels concrets : du téléphone vers l'ordinateur, entre Mac et Windows, un dossier entier, par QR code, via un lien de téléchargement qui expire, jusqu'à la sauvegarde de serveur chiffrée et automatisée. Sur le même réseau, les fichiers et le texte en direct ne demandent aucun compte.",
  },
  ar: {
    title: "كيفية · Relayium",
    description:
      "اثنا عشر دليلًا خطوة بخطوة لنقل الملفات والمجلدات والنصوص عبر Relayium بين الهاتف والحاسوب والخادم، مُشفَّرة من الطرف إلى الطرف.",
    intro:
      "اثنا عشر شرحًا عمليًا — من الهاتف إلى الحاسوب، وبين Mac وWindows، ومجلد كامل، وعبر رمز QR، وبرابط تنزيل ينتهي أجله، وصولًا إلى نسخة احتياطية مُشفَّرة وتلقائية للخادم. على الشبكة نفسها لا يحتاج نقل الملفات ولا النص المباشر إلى تسجيل الدخول.",
  },
  es: {
    title: "Cómo · Relayium",
    description:
      "Doce guías paso a paso para transferir archivos, carpetas y texto con Relayium entre el móvil, el ordenador y un servidor, cifrado de extremo a extremo.",
    intro:
      "Doce guías prácticas: del móvil al ordenador, entre Mac y Windows, una carpeta entera, con un código QR, mediante un enlace de descarga que caduca y hasta una copia de seguridad del servidor cifrada y automatizada. En la misma red, los archivos y el texto en directo no necesitan cuenta.",
  },
  pt: {
    title: "Como · Relayium",
    description:
      "Doze guias passo a passo para transferir arquivos, pastas e texto com o Relayium entre celular, computador e servidor, com criptografia de ponta a ponta.",
    intro:
      "Doze guias práticos: do celular para o computador, entre Mac e Windows, uma pasta inteira, por código QR, com um link de download que expira e até um backup de servidor criptografado e automatizado. Na mesma rede, arquivos e texto ao vivo não exigem conta.",
  },
};

const compare = {
  en: {
    title: "Comparisons · Relayium",
    description:
      "Twelve even-handed comparisons of Relayium with AirDrop, LocalSend, croc, rsync, Dropbox, WeTransfer and other ways to move files.",
    intro:
      "Twelve comparisons with the tools people already use — AirDrop, LocalSend, Snapdrop, croc, magic-wormhole, rsync, scp, Dropbox, Nextcloud, WeTransfer and what to reach for now that Firefox Send is gone. Each one says plainly when the other tool is the better choice.",
  },
  zh: {
    title: "对比 · Relayium",
    description:
      "12 篇公允对比：Relayium 与 AirDrop、LocalSend、croc、rsync、Dropbox、WeTransfer 等文件传输方式的取舍。",
    intro:
      "12 篇与常用工具的对比——AirDrop、LocalSend、Snapdrop、croc、magic-wormhole、rsync、scp、Dropbox、Nextcloud、WeTransfer，以及 Firefox Send 停用后可以改用什么。每一篇都会直说：什么场景下另一个工具更合适。",
  },
  ja: {
    title: "比較 · Relayium",
    description:
      "AirDrop、LocalSend、croc、rsync、Dropbox、WeTransfer など実際に使われているツールと Relayium を公平に比べた12本の記事。",
    intro:
      "よく使われるツールとの12本の比較——AirDrop、LocalSend、Snapdrop、croc、magic-wormhole、rsync、scp、Dropbox、Nextcloud、WeTransfer、そして Firefox Send 亡きあとの選択肢まで。相手のツールのほうが向いている場面も、はっきり書いています。",
  },
  ko: {
    title: "비교 · Relayium",
    description:
      "AirDrop, LocalSend, croc, rsync, Dropbox, WeTransfer 등 실제로 쓰이는 도구와 Relayium을 균형 있게 비교한 12편.",
    intro:
      "많이 쓰는 도구와의 비교 12편 — AirDrop, LocalSend, Snapdrop, croc, magic-wormhole, rsync, scp, Dropbox, Nextcloud, WeTransfer, 그리고 Firefox Send가 사라진 뒤의 대안까지. 상대 도구가 더 나은 상황이면 그렇다고 분명히 밝힙니다.",
  },
  de: {
    title: "Vergleiche · Relayium",
    description:
      "Zwölf faire Vergleiche von Relayium mit AirDrop, LocalSend, croc, rsync, Dropbox, WeTransfer und anderen Wegen, Dateien zu übertragen.",
    intro:
      "Zwölf Vergleiche mit den Tools, die du wahrscheinlich schon nutzt — AirDrop, LocalSend, Snapdrop, croc, magic-wormhole, rsync, scp, Dropbox, Nextcloud, WeTransfer und der Frage, was nach dem Aus von Firefox Send bleibt. Jeder sagt auch, wann das andere Tool die bessere Wahl ist.",
  },
  fr: {
    title: "Comparatifs · Relayium",
    description:
      "Douze comparatifs impartiaux entre Relayium et AirDrop, LocalSend, croc, rsync, Dropbox, WeTransfer et d'autres façons de transférer des fichiers.",
    intro:
      "Douze comparatifs avec les outils que vous utilisez déjà : AirDrop, LocalSend, Snapdrop, croc, magic-wormhole, rsync, scp, Dropbox, Nextcloud, WeTransfer, sans oublier l'après-Firefox Send. Chacun dit aussi dans quels cas l'autre outil est le meilleur choix.",
  },
  ar: {
    title: "المقارنات · Relayium",
    description:
      "اثنتا عشرة مقارنة منصفة بين Relayium وأدوات مثل AirDrop وLocalSend وcroc وrsync وDropbox وWeTransfer لنقل الملفات.",
    intro:
      "اثنتا عشرة مقارنة مع الأدوات المستخدمة فعلًا — AirDrop وLocalSend وSnapdrop وcroc وmagic-wormhole وrsync وscp وDropbox وNextcloud وWeTransfer، وما يمكن اللجوء إليه بعد توقف Firefox Send. وكل مقارنة تذكر بوضوح متى تكون الأداة الأخرى هي الخيار الأفضل.",
  },
  es: {
    title: "Comparativas · Relayium",
    description:
      "Doce comparativas imparciales entre Relayium y AirDrop, LocalSend, croc, rsync, Dropbox, WeTransfer y otras formas de mover archivos.",
    intro:
      "Doce comparativas con las herramientas que ya usas: AirDrop, LocalSend, Snapdrop, croc, magic-wormhole, rsync, scp, Dropbox, Nextcloud, WeTransfer y qué queda tras el cierre de Firefox Send. Cada una dice también cuándo la otra herramienta es la mejor opción.",
  },
  pt: {
    title: "Comparativos · Relayium",
    description:
      "Doze comparativos honestos entre o Relayium e AirDrop, LocalSend, croc, rsync, Dropbox, WeTransfer e outros jeitos de transferir arquivos.",
    intro:
      "Doze comparativos com as ferramentas que você já usa: AirDrop, LocalSend, Snapdrop, croc, magic-wormhole, rsync, scp, Dropbox, Nextcloud, WeTransfer e o que sobrou depois do fim do Firefox Send. Cada um também diz quando a outra ferramenta é a melhor escolha.",
  },
};

/** `group` is the key into the article groups the Guides hub already computes. */
export const CATEGORY_HUBS = [
  { slug: "how-to", group: "howTo", updated: "2026-08-05", langs: howTo },
  { slug: "compare", group: "compare", updated: "2026-08-05", langs: compare },
];

export default { howTo, compare };
