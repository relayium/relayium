// web/scripts/pages/content/apps.mjs — localized copy for the static
// /<lang>/apps landing pages (mode-template.mjs). English is the SPA route
// (/apps, the interactive platform-picker hub built in Tasks 1–7), so only the
// eight non-English locales are generated here — see build-pages.mjs's
// buildModePages + gen-pages.mjs wiring. This prerendered page is prose-only
// (the mode-template shape) for crawlers and no-JS first paint, exactly like
// /cross-network and /offline-transfer.
//
// Copy mirrors src/lib/i18n/*.ts (appsPage.* / cards.*) so the static page and
// the SPA hub stay consistent. Bundle ids com.relayium.mac / com.relayium.app
// are kept verbatim.
//
// The English master is the `en` doc below — a real object, not a comment, so
// the per-route SPA shell (/cross-network etc. serve the app, not a static page)
// can render the same prose for crawlers. buildModePages still generates static
// pages for LANDING_LANGS only; `en` feeds scripts/pages/shells.mjs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RELEASES = JSON.parse(
  readFileSync(resolve(process.cwd(), "native-releases.json"), "utf8"),
);
const MAC_AVAILABLE = RELEASES.macos.available === true;
const MAC_DOWNLOAD_URL = MAC_AVAILABLE ? RELEASES.macos.downloadUrl : null;

const en = {
  title: "Get Relayium — apps for web, CLI, macOS & iOS",
  description:
    "Download Relayium: use it in any browser, install the command-line tool, or choose a native app. End-to-end encrypted file transfer on every device, plus ephemeral text in the web app and the CLI.",
  hero: {
    h1: "Get Relayium",
    pitch:
      "One end-to-end encrypted file transfer, everywhere you work — plus ephemeral text in the web app and the CLI. Pick your platform.",
    cta: "Open the web app",
  },
  how: {
    heading: "Which one should I use?",
    steps: [
      "Web app — zero-install file transfer and ephemeral text, in any modern browser on any OS.",
      "Command line — scriptable file transfers, folder sync, server backups and ephemeral text on macOS, Linux and Windows.",
      MAC_AVAILABLE
        ? "macOS app — download the signed and notarized native menu-bar app."
        : "macOS app — the signed and notarized release candidate is not publicly downloadable yet.",
      "iOS app — a native iPhone & iPad app, coming to the App Store.",
    ],
  },
  why: {
    heading: "One transfer, every device",
    items: [
      {
        title: "Web app",
        desc: "Nothing to install. Open it in any modern browser on any OS to transfer files or send ephemeral text.",
      },
      {
        title: "Command line",
        desc: "Scriptable file transfers, folder sync, server-to-server backups and ephemeral text for macOS, Linux and Windows.",
      },
      {
        title: "macOS app",
        desc: MAC_AVAILABLE
          ? "A true native menu-bar app (com.relayium.mac), available as a signed and notarized download."
          : "A true native menu-bar app (com.relayium.mac). Its signed and notarized release candidate is still being prepared for public download.",
      },
      {
        title: "iOS app",
        desc: "A native iPhone & iPad app (com.relayium.app) with share-sheet sending. Coming to the App Store.",
      },
    ],
  },
  compare: {
    heading: "Native or browser?",
    items: [
      {
        title: "Use the web app",
        body: "Works everywhere today, nothing to install — just open your browser.",
      },
      {
        title: "Get a native app",
        body: "Deeper OS integration through the macOS client, with iOS planned.",
      },
    ],
  },
  learnHeading: "Learn more",
  footer: { privacy: "Privacy", terms: "Terms", security: "Security" },
};

const zh = {
  title: "获取 Relayium——网页版、命令行、macOS 与 iOS 应用",
  description:
    "下载 Relayium：在任意浏览器中直接使用、安装命令行工具，或选择原生应用。端到端加密的文件传输覆盖你的每一台设备；临时文本可在网页版与命令行中收发。",
  hero: {
    h1: "获取 Relayium",
    pitch: "同一套端到端加密的文件传输，随处可用；临时文本可在网页版与命令行中收发。选择你的平台。",
    cta: "打开网页版",
  },
  how: {
    heading: "该用哪一个？",
    steps: [
      "网页版——零安装，任意操作系统的现代浏览器打开即用，传文件也传临时文本。",
      "命令行——可脚本化的文件传输、文件夹同步、服务器备份与临时文本，支持 macOS、Linux 与 Windows。",
      MAC_AVAILABLE
        ? "macOS 应用——下载已经签名并通过公证的原生菜单栏应用。"
        : "macOS 应用——已签名并通过公证的候选版本尚未开放公开下载。",
      "iOS 应用——原生 iPhone 与 iPad 应用，即将登陆 App Store。",
    ],
  },
  why: {
    heading: "一次传输，覆盖每台设备",
    items: [
      {
        title: "网页版",
        desc: "无需安装。在任意系统的现代浏览器中打开，即可传文件，也能发临时文本。",
      },
      {
        title: "命令行",
        desc: "可脚本化的文件传输、文件夹同步、服务器间备份与临时文本，支持 macOS、Linux 与 Windows。",
      },
      {
        title: "macOS 应用",
        desc: MAC_AVAILABLE
          ? "真正的原生菜单栏应用（com.relayium.mac），现已提供经过签名和公证的下载版本。"
          : "真正的原生菜单栏应用（com.relayium.mac）；已签名并通过公证的候选版本仍在准备公开下载。",
      },
      {
        title: "iOS 应用",
        desc: "原生 iPhone 与 iPad 应用（com.relayium.app），支持分享菜单发送。即将登陆 App Store。",
      },
    ],
  },
  compare: {
    heading: "原生还是浏览器？",
    items: [
      {
        title: "使用网页版",
        body: "今天就能在所有平台使用，无需安装任何东西——打开浏览器即可传输。",
      },
      {
        title: "获取原生应用",
        body: "macOS 客户端提供更深度的系统集成，iOS 版已列入后续计划。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "Relayium を入手 — ウェブ、CLI、macOS、iOS 向けアプリ",
  description:
    "Relayium をダウンロード：任意のブラウザで使う、コマンドラインツールをインストールする、またはネイティブアプリを選べます。エンドツーエンド暗号化のファイル転送はすべてのデバイスで、一時的なテキスト送信はウェブアプリと CLI で使えます。",
  hero: {
    h1: "Relayium を入手",
    pitch:
      "同じエンドツーエンド暗号化のファイル転送を、あらゆる場所で。一時的なテキスト送信はウェブアプリと CLI で使えます。プラットフォームを選んでください。",
    cta: "ウェブアプリを開く",
  },
  how: {
    heading: "どれを使えばいい？",
    steps: [
      "ウェブアプリ — インストール不要、どの OS の最新ブラウザでもファイル転送と一時的なテキスト送信がすぐに使えます。",
      "コマンドライン — スクリプト化できるファイル転送、フォルダー同期、サーバーバックアップ、一時的なテキスト送信。macOS、Linux、Windows で利用可能。",
      MAC_AVAILABLE
        ? "macOS アプリ — 署名・公証済みのネイティブなメニューバーアプリをダウンロード。"
        : "macOS アプリ — 署名・公証済みのリリース候補は、まだ一般公開されていません。",
      "iOS アプリ — ネイティブな iPhone・iPad アプリ、App Store に近日登場。",
    ],
  },
  why: {
    heading: "ひとつの転送を、すべてのデバイスで",
    items: [
      {
        title: "ウェブアプリ",
        desc: "インストール不要。どの OS でも最新のブラウザで開けば、ファイル転送も一時的なテキスト送信もすぐに始められます。",
      },
      {
        title: "コマンドライン",
        desc: "スクリプト化できるファイル転送、フォルダー同期、サーバー間バックアップ、一時的なテキスト送信に対応。macOS、Linux、Windows で利用可能。",
      },
      {
        title: "macOS アプリ",
        desc: MAC_AVAILABLE
          ? "本物のネイティブなメニューバーアプリ（com.relayium.mac）。署名・公証済みのダウンロード版を利用できます。"
          : "本物のネイティブなメニューバーアプリ（com.relayium.mac）。署名・公証済みのリリース候補を一般公開に向けて準備中です。",
      },
      {
        title: "iOS アプリ",
        desc: "共有シートからの送信に対応したネイティブな iPhone・iPad アプリ（com.relayium.app）。App Store に近日登場。",
      },
    ],
  },
  compare: {
    heading: "ネイティブ、それともブラウザ？",
    items: [
      {
        title: "ウェブアプリを使う",
        body: "今日すぐ、あらゆる環境で動作し、インストールは不要です — ブラウザを開くだけ。",
      },
      {
        title: "ネイティブアプリを入手",
        body: "macOS クライアントで OS と深く連携し、iOS 版も計画されています。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "Relayium 받기 — 웹, CLI, macOS 및 iOS 앱",
  description:
    "Relayium 다운로드: 어떤 브라우저에서든 바로 사용하거나, 명령줄 도구를 설치하거나, 네이티브 앱을 선택하세요. 종단간 암호화 파일 전송은 모든 기기에서, 임시 텍스트 전송은 웹 앱과 CLI에서.",
  hero: {
    h1: "Relayium 받기",
    pitch: "하나의 종단간 암호화 파일 전송을 어디서나. 임시 텍스트 전송은 웹 앱과 CLI에서 쓸 수 있습니다. 플랫폼을 선택하세요.",
    cta: "웹 앱 열기",
  },
  how: {
    heading: "어느 것을 써야 할까요?",
    steps: [
      "웹 앱 — 설치 불필요, 어떤 OS의 최신 브라우저에서든 파일 전송과 임시 텍스트 전송을 바로 사용.",
      "명령줄 — 스크립트로 자동화하는 파일 전송, 폴더 동기화, 서버 백업, 임시 텍스트 전송. macOS, Linux, Windows 지원.",
      MAC_AVAILABLE
        ? "macOS 앱 — 서명과 공증을 마친 네이티브 메뉴 막대 앱을 다운로드하세요."
        : "macOS 앱 — 서명과 공증을 마친 출시 후보는 아직 공개 다운로드할 수 없습니다.",
      "iOS 앱 — 네이티브 iPhone·iPad 앱, App Store에 곧 출시.",
    ],
  },
  why: {
    heading: "하나의 전송, 모든 기기에서",
    items: [
      {
        title: "웹 앱",
        desc: "설치 불필요. 어떤 OS의 최신 브라우저에서든 열어 파일 전송이나 임시 텍스트 전송을 바로 시작하세요.",
      },
      {
        title: "명령줄",
        desc: "스크립트로 자동화하는 파일 전송, 폴더 동기화, 서버 간 백업, 임시 텍스트 전송. macOS, Linux, Windows 지원.",
      },
      {
        title: "macOS 앱",
        desc: MAC_AVAILABLE
          ? "진짜 네이티브 메뉴 막대 앱(com.relayium.mac)으로, 서명과 공증을 마친 다운로드 버전을 제공합니다."
          : "진짜 네이티브 메뉴 막대 앱(com.relayium.mac)입니다. 서명과 공증을 마친 출시 후보를 공개 다운로드용으로 준비하고 있습니다.",
      },
      {
        title: "iOS 앱",
        desc: "공유 시트 전송을 지원하는 네이티브 iPhone·iPad 앱(com.relayium.app). App Store에 곧 출시됩니다.",
      },
    ],
  },
  compare: {
    heading: "네이티브냐 브라우저냐?",
    items: [
      {
        title: "웹 앱 사용하기",
        body: "오늘 당장 어디서나 동작하며 설치할 것이 없습니다 — 브라우저만 열면 됩니다.",
      },
      {
        title: "네이티브 앱 받기",
        body: "macOS 클라이언트로 운영체제와 더 깊이 통합하며, iOS 버전도 계획되어 있습니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Relayium holen — Apps für Web, CLI, macOS & iOS",
  description:
    "Relayium herunterladen: in jedem Browser nutzen, das Kommandozeilen-Tool installieren oder eine native App wählen. Ende-zu-Ende-verschlüsselte Dateiübertragung auf jedem Gerät, dazu flüchtiger Text in der Web-App und in der Kommandozeile.",
  hero: {
    h1: "Relayium holen",
    pitch:
      "Eine Ende-zu-Ende-verschlüsselte Dateiübertragung, überall wo du arbeitest — dazu flüchtiger Text in der Web-App und in der Kommandozeile. Wähle deine Plattform.",
    cta: "Web-App öffnen",
  },
  how: {
    heading: "Welche soll ich nehmen?",
    steps: [
      "Web-App — ohne Installation, in jedem modernen Browser auf jedem Betriebssystem: Dateien und flüchtiger Text.",
      "Kommandozeile — skriptbare Dateiübertragungen, Ordner-Sync, Server-Backups und flüchtiger Text für macOS, Linux und Windows.",
      MAC_AVAILABLE
        ? "macOS-App — die signierte und notarisierte native Menüleisten-App herunterladen."
        : "macOS-App — der signierte und notarisierte Release Candidate ist noch nicht öffentlich verfügbar.",
      "iOS-App — eine native iPhone- & iPad-App, kommt in den App Store.",
    ],
  },
  why: {
    heading: "Eine Übertragung, jedes Gerät",
    items: [
      {
        title: "Web-App",
        desc: "Nichts zu installieren. In jedem modernen Browser auf jedem Betriebssystem öffnen und Dateien oder flüchtigen Text übertragen.",
      },
      {
        title: "Kommandozeile",
        desc: "Skriptbare Dateiübertragungen, Ordner-Sync, Server-zu-Server-Backups und flüchtiger Text für macOS, Linux und Windows.",
      },
      {
        title: "macOS-App",
        desc: MAC_AVAILABLE
          ? "Eine echte native Menüleisten-App (com.relayium.mac), als signierter und notarisierter Download verfügbar."
          : "Eine echte native Menüleisten-App (com.relayium.mac). Der signierte und notarisierte Release Candidate wird noch für den öffentlichen Download vorbereitet.",
      },
      {
        title: "iOS-App",
        desc: "Eine native iPhone- & iPad-App (com.relayium.app) mit Versand über das Teilen-Menü. Kommt in den App Store.",
      },
    ],
  },
  compare: {
    heading: "Nativ oder Browser?",
    items: [
      {
        title: "Die Web-App nutzen",
        body: "Funktioniert schon heute überall, nichts zu installieren — einfach den Browser öffnen.",
      },
      {
        title: "Eine native App holen",
        body: "Tiefere Integration mit dem macOS-Client; eine iOS-Version ist geplant.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Obtenir Relayium — applis pour le web, le CLI, macOS et iOS",
  description:
    "Téléchargez Relayium : utilisez-le dans n'importe quel navigateur, installez l'outil en ligne de commande ou choisissez une appli native. Transfert de fichiers chiffré de bout en bout sur chaque appareil, et texte éphémère dans l'appli web et en ligne de commande.",
  hero: {
    h1: "Obtenir Relayium",
    pitch:
      "Un même transfert de fichiers chiffré de bout en bout, partout où vous travaillez — et du texte éphémère dans l'appli web et en ligne de commande. Choisissez votre plateforme.",
    cta: "Ouvrir l'appli web",
  },
  how: {
    heading: "Laquelle choisir ?",
    steps: [
      "Appli web — sans installation, dans n'importe quel navigateur moderne, sur n'importe quel OS : fichiers et texte éphémère.",
      "Ligne de commande — transferts de fichiers scriptables, synchronisation de dossiers, sauvegardes de serveur et texte éphémère pour macOS, Linux et Windows.",
      MAC_AVAILABLE
        ? "Appli macOS — téléchargez l'appli native de barre des menus, signée et notarisée."
        : "Appli macOS — la version candidate signée et notarisée n'est pas encore téléchargeable publiquement.",
      "Appli iOS — une appli native iPhone et iPad, bientôt sur l'App Store.",
    ],
  },
  why: {
    heading: "Un seul transfert, tous vos appareils",
    items: [
      {
        title: "Appli web",
        desc: "Rien à installer. Ouvrez-la dans n'importe quel navigateur moderne, sur n'importe quel OS, pour transférer des fichiers ou envoyer du texte éphémère.",
      },
      {
        title: "Ligne de commande",
        desc: "Transferts de fichiers scriptables, synchronisation de dossiers, sauvegardes de serveur à serveur et texte éphémère pour macOS, Linux et Windows.",
      },
      {
        title: "Appli macOS",
        desc: MAC_AVAILABLE
          ? "Une vraie appli native dans la barre de menus (com.relayium.mac), disponible en téléchargement signé et notarisé."
          : "Une vraie appli native dans la barre de menus (com.relayium.mac). Sa version candidate signée et notarisée est encore en préparation pour le téléchargement public.",
      },
      {
        title: "Appli iOS",
        desc: "Une appli native iPhone et iPad (com.relayium.app) avec envoi via la feuille de partage. Bientôt sur l'App Store.",
      },
    ],
  },
  compare: {
    heading: "Native ou navigateur ?",
    items: [
      {
        title: "Utiliser l'appli web",
        body: "Fonctionne partout dès aujourd'hui, rien à installer — ouvrez simplement votre navigateur.",
      },
      {
        title: "Obtenir une appli native",
        body: "Une intégration plus poussée avec le client macOS ; une version iOS est prévue.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

const ar = {
  title: "احصل على Relayium — تطبيقات للويب وسطر الأوامر وmacOS وiOS",
  description:
    "نزّل Relayium: استخدمه في أي متصفح، أو ثبّت أداة سطر الأوامر، أو اختر تطبيقًا أصليًا. نقل ملفات مُشفَّر من الطرف إلى الطرف على كل جهاز، ونصوص عابرة في تطبيق الويب وسطر الأوامر.",
  hero: {
    h1: "احصل على Relayium",
    pitch: "نقل ملفات واحد مُشفَّر من الطرف إلى الطرف، في كل مكان تعمل فيه — ونصوص عابرة في تطبيق الويب وسطر الأوامر. اختر منصّتك.",
    cta: "افتح تطبيق الويب",
  },
  how: {
    heading: "أيّها أستخدم؟",
    steps: [
      "تطبيق الويب — دون تثبيت، في أي متصفح حديث وعلى أي نظام تشغيل: ملفات ونصوص عابرة.",
      "سطر الأوامر — عمليات نقل ملفات قابلة للبرمجة، ومزامنة المجلدات، ونسخ احتياطي للخوادم، ونصوص عابرة على macOS وLinux وWindows.",
      MAC_AVAILABLE
        ? "تطبيق macOS — نزّل تطبيق شريط القوائم الأصلي الموقّع والموثّق."
        : "تطبيق macOS — النسخة المرشحة الموقّعة والموثّقة ليست متاحة للتنزيل العام بعد.",
      "تطبيق iOS — تطبيق أصلي لـ iPhone وiPad، قريبًا على App Store.",
    ],
  },
  why: {
    heading: "نقل واحد، لكل جهاز",
    items: [
      {
        title: "تطبيق الويب",
        desc: "لا شيء للتثبيت. افتحه في أي متصفح حديث على أي نظام تشغيل لنقل الملفات أو إرسال نصوص عابرة.",
      },
      {
        title: "سطر الأوامر",
        desc: "عمليات نقل ملفات قابلة للبرمجة، ومزامنة المجلدات، ونسخ احتياطي من خادم إلى خادم، ونصوص عابرة لأنظمة macOS وLinux وWindows.",
      },
      {
        title: "تطبيق macOS",
        desc: MAC_AVAILABLE
          ? "تطبيق أصلي حقيقي في شريط القوائم (com.relayium.mac)، متاح كتنزيل موقّع وموثّق."
          : "تطبيق أصلي حقيقي في شريط القوائم (com.relayium.mac). ما زالت نسخته المرشحة الموقّعة والموثّقة قيد الإعداد للتنزيل العام.",
      },
      {
        title: "تطبيق iOS",
        desc: "تطبيق أصلي لـ iPhone وiPad (com.relayium.app) مع الإرسال عبر ورقة المشاركة. قريبًا على App Store.",
      },
    ],
  },
  compare: {
    heading: "أصلي أم متصفح؟",
    items: [
      {
        title: "استخدم تطبيق الويب",
        body: "يعمل في كل مكان اليوم، دون أي تثبيت — ما عليك سوى فتح متصفحك.",
      },
      {
        title: "احصل على تطبيق أصلي",
        body: "تكامل أعمق مع نظام التشغيل عبر تطبيق macOS، مع التخطيط لإصدار iOS.",
      },
    ],
  },
  learnHeading: "اعرف المزيد",
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

const es = {
  title: "Consigue Relayium — apps para web, CLI, macOS e iOS",
  description:
    "Descarga Relayium: úsalo en cualquier navegador, instala la herramienta de línea de comandos o elige una app nativa. Transferencia de archivos cifrada de extremo a extremo en todos tus dispositivos, y texto efímero en la app web y en la línea de comandos.",
  hero: {
    h1: "Consigue Relayium",
    pitch:
      "Una misma transferencia de archivos cifrada de extremo a extremo, dondequiera que trabajes — y texto efímero en la app web y en la línea de comandos. Elige tu plataforma.",
    cta: "Abrir la app web",
  },
  how: {
    heading: "¿Cuál debería usar?",
    steps: [
      "App web — sin instalación, en cualquier navegador moderno y en cualquier sistema operativo: archivos y texto efímero.",
      "Línea de comandos — transferencias de archivos programables, sincronización de carpetas, copias de servidores y texto efímero para macOS, Linux y Windows.",
      MAC_AVAILABLE
        ? "App de macOS — descarga la app nativa de barra de menús, firmada y notarizada."
        : "App de macOS — la versión candidata firmada y notarizada aún no está disponible para descarga pública.",
      "App de iOS — una app nativa para iPhone y iPad, pronto en la App Store.",
    ],
  },
  why: {
    heading: "Una transferencia, todos tus dispositivos",
    items: [
      {
        title: "App web",
        desc: "Nada que instalar. Ábrela en cualquier navegador moderno, en cualquier sistema operativo, para transferir archivos o enviar texto efímero.",
      },
      {
        title: "Línea de comandos",
        desc: "Transferencias de archivos programables, sincronización de carpetas, copias de servidor a servidor y texto efímero para macOS, Linux y Windows.",
      },
      {
        title: "App de macOS",
        desc: MAC_AVAILABLE
          ? "Una auténtica app nativa en la barra de menús (com.relayium.mac), disponible como descarga firmada y notarizada."
          : "Una auténtica app nativa en la barra de menús (com.relayium.mac). Su versión candidata firmada y notarizada aún se está preparando para la descarga pública.",
      },
      {
        title: "App de iOS",
        desc: "Una app nativa para iPhone y iPad (com.relayium.app) con envío desde la hoja de compartir. Pronto en la App Store.",
      },
    ],
  },
  compare: {
    heading: "¿Nativa o navegador?",
    items: [
      {
        title: "Usa la app web",
        body: "Funciona en todas partes hoy mismo, sin nada que instalar — solo abre tu navegador.",
      },
      {
        title: "Consigue una app nativa",
        body: "Una integración más profunda con el cliente de macOS; la versión para iOS está planificada.",
      },
    ],
  },
  learnHeading: "Más información",
  footer: { privacy: "Privacidad", terms: "Términos del servicio", security: "Seguridad" },
};

const pt = {
  title: "Obtenha o Relayium — apps para web, CLI, macOS e iOS",
  description:
    "Baixe o Relayium: use em qualquer navegador, instale a ferramenta de linha de comando ou escolha um app nativo. Transferência de arquivos criptografada de ponta a ponta em todos os dispositivos, e texto efêmero no app web e na linha de comando.",
  hero: {
    h1: "Obtenha o Relayium",
    pitch:
      "Uma mesma transferência de arquivos criptografada de ponta a ponta, onde quer que você trabalhe — e texto efêmero no app web e na linha de comando. Escolha sua plataforma.",
    cta: "Abrir o app web",
  },
  how: {
    heading: "Qual devo usar?",
    steps: [
      "App web — sem instalação, em qualquer navegador moderno e em qualquer sistema operacional: arquivos e texto efêmero.",
      "Linha de comando — transferências de arquivos programáveis, sincronização de pastas, backups de servidores e texto efêmero para macOS, Linux e Windows.",
      MAC_AVAILABLE
        ? "App para macOS — baixe o app nativo de barra de menus, assinado e notarizado."
        : "App para macOS — a versão candidata assinada e notarizada ainda não está disponível para download público.",
      "App para iOS — um app nativo para iPhone e iPad, em breve na App Store.",
    ],
  },
  why: {
    heading: "Uma transferência, em todos os dispositivos",
    items: [
      {
        title: "App web",
        desc: "Nada para instalar. Abra em qualquer navegador moderno, em qualquer sistema, para transferir arquivos ou enviar texto efêmero.",
      },
      {
        title: "Linha de comando",
        desc: "Transferências de arquivos programáveis, sincronização de pastas, backups de servidor para servidor e texto efêmero para macOS, Linux e Windows.",
      },
      {
        title: "App para macOS",
        desc: MAC_AVAILABLE
          ? "Um verdadeiro app nativo na barra de menus (com.relayium.mac), disponível como download assinado e notarizado."
          : "Um verdadeiro app nativo na barra de menus (com.relayium.mac). Sua versão candidata assinada e notarizada ainda está sendo preparada para download público.",
      },
      {
        title: "App para iOS",
        desc: "Um app nativo para iPhone e iPad (com.relayium.app) com envio pela folha de compartilhamento. Em breve na App Store.",
      },
    ],
  },
  compare: {
    heading: "Nativo ou navegador?",
    items: [
      {
        title: "Use o app web",
        body: "Funciona em qualquer lugar hoje mesmo, nada para instalar — é só abrir o navegador.",
      },
      {
        title: "Obtenha um app nativo",
        body: "Uma integração mais profunda com o cliente para macOS; a versão para iOS está planejada.",
      },
    ],
  },
  learnHeading: "Saiba mais",
  footer: { privacy: "Privacidade", terms: "Termos de Serviço", security: "Segurança" },
};

const downloadLabels = {
  en: "Download for macOS",
  zh: "下载 macOS 版",
  ja: "macOS 版をダウンロード",
  ko: "macOS용 다운로드",
  de: "Für macOS herunterladen",
  fr: "Télécharger pour macOS",
  ar: "تنزيل لنظام macOS",
  es: "Descargar para macOS",
  pt: "Baixar para macOS",
};

const langs = { en, zh, ja, ko, de, fr, ar, es, pt };
if (MAC_DOWNLOAD_URL) {
  for (const [code, doc] of Object.entries(langs)) {
    doc.nativeDownload = { href: MAC_DOWNLOAD_URL, label: downloadLabels[code] };
  }
}

export default {
  updated: "2026-07-31",
  langs,
};
