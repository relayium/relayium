// web/scripts/pages/content/apps.mjs — localized copy for the static
// /<lang>/apps landing pages (mode-template.mjs). English is the SPA route
// (/apps, the interactive platform-picker hub built in Tasks 1–7), so only the
// eight non-English locales are generated here — see build-pages.mjs's
// buildModePages + gen-pages.mjs wiring. This prerendered page is prose-only
// (the mode-template shape) for crawlers and no-JS first paint, exactly like
// /cross-network and /offline-transfer.
//
// Copy mirrors src/lib/i18n/*.ts (appsPage.* / cards.*) so the static page and
// the SPA hub stay consistent. The bundle id com.relayium.mac is kept verbatim.
//
// `en` and `zh` are the maintained pair and are the only two revised on
// 2026-08-28, when the iOS, Android and Windows platform copy was removed. The
// seven archived locales below keep the copy they were published with, exactly
// as maintained-frozen-split.mjs and apps-generated-twin.test.mjs require: they
// are archived translations carrying an archived-translation notice, not live
// product pages, and rewriting them would make them look maintained.
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
  title: "Get Relayium — Web, CLI and the macOS app",
  description:
    "Use Relayium in any modern browser, install the command-line client on macOS, Linux or Windows, or download the native macOS app. End-to-end encrypted file and ephemeral text transfer.",
  hero: {
    h1: "Get Relayium",
    pitch:
      "One end-to-end encrypted transfer for files and ephemeral text, everywhere you work. Pick your platform.",
    cta: "Open the web app",
  },
  how: {
    heading: "Which one should I use?",
    steps: [
      "Web app — zero-install file transfer and ephemeral text, in any modern browser on any OS.",
      "Command line — scriptable file transfers, folder sync, server backups and ephemeral text on macOS, Linux and Windows.",
      MAC_AVAILABLE
        ? "macOS app — download the signed and notarized native menu-bar app."
        : "macOS app — the native menu-bar app is an engineering build and is not publicly available yet.",
      "Everywhere else — iPhone, iPad, Android, Windows and Linux run the web app in the browser with nothing to install; Windows and Linux can also install the command line.",
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
          ? "A true native menu-bar app (com.relayium.mac): files and text with nearby devices or by pairing code, encrypted links to send and open, and account management — available as a signed and notarized download, and separately on the Mac App Store."
          : "A true native menu-bar app (com.relayium.mac): files and text with nearby devices or by pairing code, encrypted links to send and open, and account management. It is an engineering build and is not publicly available yet.",
      },
      {
        title: "Every other platform",
        desc: "iPhone, iPad, Android, Windows and Linux use Relayium through the browser — the same end-to-end encrypted transfer, with nothing to install. On Windows and Linux the command line adds scripting, folder sync and scheduled backups. Relayium publishes no app for those platforms.",
      },
    ],
  },
  // Mirrors the SPA's appsPage.chooser (src/lib/i18n/en.ts). Every macOS line
  // names a capability that ships in apps/mac and can be checked there: the
  // menu-bar app, the Share extension's file/image/video activation rule, the
  // CFBundleDocumentTypes "Open With" + Dock drop entry, the applinks
  // associated domain, and Device Inbox's chosen-folder residency. Speed,
  // background transfer and push are absent on purpose — none of them is true.
  // The Mac App Store IS named: that listing is public and recorded in
  // web/mac-app-store-release.json. TestFlight and Google Play are not.
  //
  // The third block used to describe the iOS app. It was removed on 2026-08-28
  // with the iOS, Android and Windows cards: iOS development is paused and has
  // no public listing, and apps/ contains no Android or Windows target to
  // describe at all. What replaces it is the answer a reader on one of those
  // platforms actually needs — the browser is the client.
  compare: {
    heading: "Web or a native app?",
    items: [
      {
        title: "Use the web app",
        body: "Nothing to install and nothing to update: open the page and transfer. It runs in any modern browser on any operating system, including the ones with no native app, which makes it the right choice for a one-off transfer, a borrowed computer, or a device you do not administer.",
      },
      {
        title: "Get the macOS app",
        body: "It lives in the menu bar, so it is one click away with no window or tab to keep track of. You can send from the Share menu in Finder, Photos and other apps — files, images and video go straight to Relayium — or use Open With in Finder, or drop files and folders on the Dock icon, to start a transfer from where the files already are. A relayium.com transfer link opens in the app instead of the browser. And with Device Inbox, files sent to this Mac from your own account are written into the folder you chose on it, and are only reported saved once they are on disk.",
      },
      {
        title: "On every other platform, the browser is the app",
        body: "iPhone, iPad, Android, Windows and Linux all open relayium.com and get the same end-to-end encrypted transfer, with nothing to install and nothing to update. On Windows and Linux the command line adds scripting, folder sync and scheduled backups. Relayium publishes no client for those platforms, so the web app is not a fallback there — it is the product.",
      },
    ],
  },
  learnHeading: "Learn more",
  footer: { privacy: "Privacy", terms: "Terms", security: "Security" },
};

const zh = {
  title: "获取 Relayium——网页版、命令行与 macOS 应用",
  description:
    "在任意现代浏览器里使用 Relayium，在 macOS、Linux 或 Windows 上安装命令行工具，或下载原生 macOS 应用。端到端加密传输文件与临时文本。",
  hero: {
    h1: "获取 Relayium",
    pitch: "同一套端到端加密的传输，既传文件也发临时文本，随处可用。选择你的平台。",
    cta: "打开网页版",
  },
  how: {
    heading: "该用哪一个？",
    steps: [
      "网页版——零安装，任意操作系统的现代浏览器打开即用，传文件也传临时文本。",
      "命令行——可脚本化的文件传输、文件夹同步、服务器备份与临时文本，支持 macOS、Linux 与 Windows。",
      MAC_AVAILABLE
        ? "macOS 应用——下载已经签名并通过公证的原生菜单栏应用。"
        : "macOS 应用——原生菜单栏应用目前是工程版本，尚未开放公开下载。",
      "其他平台——iPhone、iPad、Android、Windows 与 Linux 都用浏览器打开网页版，无需安装；Windows 与 Linux 还可以另外装命令行工具。",
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
          ? "真正的原生菜单栏应用（com.relayium.mac）：与附近设备或用配对码互传文件和文本、收发加密链接、管理账号与设备。现已提供经过签名和公证的下载版本，也可从 Mac App Store 获取。"
          : "真正的原生菜单栏应用（com.relayium.mac）：与附近设备或用配对码互传文件和文本、收发加密链接、管理账号与设备。目前是工程版本，尚未开放公开下载。",
      },
      {
        title: "其他所有平台",
        desc: "iPhone、iPad、Android、Windows 与 Linux 都通过浏览器使用 Relayium——同一套端到端加密传输，无需安装。在 Windows 与 Linux 上，命令行工具还能做脚本化传输、文件夹同步与定时备份。Relayium 没有为这些平台发布任何客户端程序。",
      },
    ],
  },
  // 与 SPA 的 appsPage.chooser（src/lib/i18n/zh.ts）保持一致，逐条对应。
  // 2026-08-28：iOS / Android / Windows 三张卡片连同 iOS 段落一并移除——
  // apps/ 下没有 Android 或 Windows 目标，iOS 开发已暂停且没有公开上架。
  compare: {
    heading: "该用网页版还是原生应用？",
    items: [
      {
        title: "使用网页版",
        body: "不用安装，也不用更新：打开页面就能传。任意操作系统上的现代浏览器都能用，包括还没有原生应用的那些系统——临时传一次、用别人的电脑，或者在你没有管理权限的设备上，网页版最合适。",
      },
      {
        title: "装上 macOS 应用",
        body: "它常驻菜单栏，点一下就用，不必再去找某个窗口或某个标签页。你可以在访达、照片等应用里用「分享」菜单直接发送——文件、图片和视频都能交给 Relayium；也可以在访达里用「打开方式」，或者把文件和文件夹拖到程序坞图标上，就地开始传输。relayium.com 的传输链接会直接在应用里打开，而不是回到浏览器。用设备收件箱接收时，从你自己账户发到这台 Mac 的文件会写进你在这台机器上选定的文件夹，而且只有真正落盘之后才会报告为「已保存」。",
      },
      {
        title: "在其他平台上，浏览器就是那个应用",
        body: "iPhone、iPad、Android、Windows 与 Linux 打开 relayium.com，得到的就是同一套端到端加密传输，不用安装，也不用更新。在 Windows 与 Linux 上，命令行工具还能做脚本化传输、文件夹同步与定时备份。Relayium 没有为这些平台发布客户端，所以在那里网页版不是退而求其次的方案——它就是产品本身。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "Relayium を入手 — ウェブ、CLI、macOS、iOS 向けアプリ",
  description:
    "Relayium をダウンロード：任意のブラウザで使う、コマンドラインツールをインストールする、ネイティブアプリでできることを見る。エンドツーエンド暗号化のファイルと一時的なテキストの転送を、ウェブ・コマンドライン・macOS・iOS で。",
  hero: {
    h1: "Relayium を入手",
    pitch:
      "同じエンドツーエンド暗号化の転送を、ファイルにも一時的なテキストにも、あらゆる場所で。プラットフォームを選んでください。",
    cta: "ウェブアプリを開く",
  },
  how: {
    heading: "どれを使えばいい？",
    steps: [
      "ウェブアプリ — インストール不要、どの OS の最新ブラウザでもファイル転送と一時的なテキスト送信がすぐに使えます。",
      "コマンドライン — スクリプト化できるファイル転送、フォルダー同期、サーバーバックアップ、一時的なテキスト送信。macOS、Linux、Windows で利用可能。",
      MAC_AVAILABLE
        ? "macOS アプリ — 署名・公証済みのネイティブなメニューバーアプリをダウンロード。"
        : "macOS アプリ — ネイティブなメニューバーアプリはエンジニアリングビルドで、まだ一般公開されていません。",
      "iOS アプリ — ネイティブな iPhone・iPad アプリ。開いている間はファイルとテキストを転送でき、まだ一般公開されていません。",
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
          ? "本物のネイティブなメニューバーアプリ（com.relayium.mac）。近くのデバイスやペアリングコードでファイルとテキストをやり取りし、暗号化リンクの送受信やアカウント・デバイス管理にも対応。署名・公証済みのダウンロード版を利用できます。"
          : "本物のネイティブなメニューバーアプリ（com.relayium.mac）。近くのデバイスやペアリングコードでファイルとテキストをやり取りし、暗号化リンクの送受信やアカウント・デバイス管理にも対応。現在はエンジニアリングビルドで、まだ一般公開されていません。",
      },
      {
        title: "iOS アプリ",
        desc: "ネイティブな iPhone・iPad アプリ（com.relayium.app）。アカウントなしで暗号化リンクを開けるほか、近くのデバイスや 6 桁コードでファイルとテキストを送り、アカウントも管理できます — いずれもアプリを開いている間だけ動作します。",
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
        body: "macOS クライアントで OS と深く連携し、iOS アプリも開発中です。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "Relayium 받기 — 웹, CLI, macOS 및 iOS 앱",
  description:
    "Relayium 다운로드: 어떤 브라우저에서든 바로 사용하거나, 명령줄 도구를 설치하거나, 네이티브 앱이 무엇을 하는지 확인하세요. 종단간 암호화 파일·임시 텍스트 전송을 웹, 명령줄, macOS와 iOS에서.",
  hero: {
    h1: "Relayium 받기",
    pitch: "하나의 종단간 암호화 전송으로 파일도 임시 텍스트도, 어디서나. 플랫폼을 선택하세요.",
    cta: "웹 앱 열기",
  },
  how: {
    heading: "어느 것을 써야 할까요?",
    steps: [
      "웹 앱 — 설치 불필요, 어떤 OS의 최신 브라우저에서든 파일 전송과 임시 텍스트 전송을 바로 사용.",
      "명령줄 — 스크립트로 자동화하는 파일 전송, 폴더 동기화, 서버 백업, 임시 텍스트 전송. macOS, Linux, Windows 지원.",
      MAC_AVAILABLE
        ? "macOS 앱 — 서명과 공증을 마친 네이티브 메뉴 막대 앱을 다운로드하세요."
        : "macOS 앱 — 네이티브 메뉴 막대 앱은 엔지니어링 빌드이며, 아직 공개 배포되지 않았습니다.",
      "iOS 앱 — 네이티브 iPhone·iPad 앱. 앱이 열려 있는 동안 파일과 텍스트를 주고받으며, 아직 공개 배포되지 않았습니다.",
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
          ? "진짜 네이티브 메뉴 막대 앱(com.relayium.mac). 근처 기기나 페어링 코드로 파일과 텍스트를 주고받고, 암호화된 링크를 보내거나 열고, 계정과 기기를 관리합니다. 서명과 공증을 마친 다운로드 버전을 제공합니다."
          : "진짜 네이티브 메뉴 막대 앱(com.relayium.mac). 근처 기기나 페어링 코드로 파일과 텍스트를 주고받고, 암호화된 링크를 보내거나 열고, 계정과 기기를 관리합니다. 현재는 엔지니어링 빌드이며, 아직 공개 배포되지 않았습니다.",
      },
      {
        title: "iOS 앱",
        desc: "네이티브 iPhone·iPad 앱(com.relayium.app). 계정 없이 암호화된 링크를 열고, 근처 기기나 여섯 자리 코드로 파일과 텍스트를 보내고, 계정을 관리합니다 — 모두 앱이 열려 있는 동안에만.",
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
        body: "macOS 클라이언트로 운영체제와 더 깊이 통합하며, iOS 앱도 개발 중입니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Relayium holen — Apps für Web, CLI, macOS & iOS",
  description:
    "Relayium herunterladen: in jedem Browser nutzen, das Kommandozeilen-Tool installieren oder sehen, was die nativen Apps können. Ende-zu-Ende-verschlüsselte Übertragung von Dateien und flüchtigem Text — Web, Kommandozeile, macOS und iOS.",
  hero: {
    h1: "Relayium holen",
    pitch:
      "Eine Ende-zu-Ende-verschlüsselte Übertragung für Dateien und flüchtigen Text, überall wo du arbeitest. Wähle deine Plattform.",
    cta: "Web-App öffnen",
  },
  how: {
    heading: "Welche soll ich nehmen?",
    steps: [
      "Web-App — ohne Installation, in jedem modernen Browser auf jedem Betriebssystem: Dateien und flüchtiger Text.",
      "Kommandozeile — skriptbare Dateiübertragungen, Ordner-Sync, Server-Backups und flüchtiger Text für macOS, Linux und Windows.",
      MAC_AVAILABLE
        ? "macOS-App — die signierte und notarisierte native Menüleisten-App herunterladen."
        : "macOS-App — die native Menüleisten-App ist ein Entwicklungs-Build und noch nicht öffentlich verfügbar.",
      "iOS-App — eine native iPhone- & iPad-App: Dateien und Text, solange sie geöffnet ist; noch nicht öffentlich verfügbar.",
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
          ? "Eine echte native Menüleisten-App (com.relayium.mac): Dateien und Text mit Geräten in der Nähe oder per Pairing-Code, verschlüsselte Links senden und öffnen, Konto und Geräte verwalten. Als signierter und notarisierter Download verfügbar."
          : "Eine echte native Menüleisten-App (com.relayium.mac): Dateien und Text mit Geräten in der Nähe oder per Pairing-Code, verschlüsselte Links senden und öffnen, Konto und Geräte verwalten. Sie ist ein Entwicklungs-Build und noch nicht öffentlich verfügbar.",
      },
      {
        title: "iOS-App",
        desc: "Eine native iPhone- & iPad-App (com.relayium.app): verschlüsselte Links ohne Konto öffnen, Dateien und Text an Geräte in der Nähe oder per sechsstelligem Code senden, das Konto verwalten — solange die App geöffnet ist.",
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
        body: "Tiefere Integration mit dem macOS-Client; die iOS-App ist in Entwicklung.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Obtenir Relayium — applis pour le web, le CLI, macOS et iOS",
  description:
    "Téléchargez Relayium : utilisez-le dans n'importe quel navigateur, installez l'outil en ligne de commande ou découvrez ce que font les applis natives. Transfert chiffré de bout en bout de fichiers et de texte éphémère — web, ligne de commande, macOS et iOS.",
  hero: {
    h1: "Obtenir Relayium",
    pitch:
      "Un même transfert chiffré de bout en bout pour les fichiers et le texte éphémère, partout où vous travaillez. Choisissez votre plateforme.",
    cta: "Ouvrir l'appli web",
  },
  how: {
    heading: "Laquelle choisir ?",
    steps: [
      "Appli web — sans installation, dans n'importe quel navigateur moderne, sur n'importe quel OS : fichiers et texte éphémère.",
      "Ligne de commande — transferts de fichiers scriptables, synchronisation de dossiers, sauvegardes de serveur et texte éphémère pour macOS, Linux et Windows.",
      MAC_AVAILABLE
        ? "Appli macOS — téléchargez l'appli native de barre des menus, signée et notarisée."
        : "Appli macOS — l'appli native de barre des menus est une version d'ingénierie et n'est pas encore disponible publiquement.",
      "Appli iOS — une appli native iPhone et iPad : fichiers et texte tant qu'elle est ouverte ; pas encore disponible publiquement.",
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
          ? "Une vraie appli native dans la barre de menus (com.relayium.mac) : fichiers et texte avec les appareils à proximité ou par code d'appairage, envoi et ouverture de liens chiffrés, gestion du compte et des appareils. Disponible en téléchargement signé et notarisé."
          : "Une vraie appli native dans la barre de menus (com.relayium.mac) : fichiers et texte avec les appareils à proximité ou par code d'appairage, envoi et ouverture de liens chiffrés, gestion du compte et des appareils. C'est une version d'ingénierie, pas encore disponible publiquement.",
      },
      {
        title: "Appli iOS",
        desc: "Une appli native iPhone et iPad (com.relayium.app) : ouvrez un lien chiffré sans compte, envoyez fichiers et texte aux appareils à proximité ou par code à six chiffres, gérez votre compte — tant que l'appli est ouverte.",
      },
    ],
  },
  compare: {
    heading: "Native ou navigateur ?",
    items: [
      {
        title: "Utiliser l'appli web",
        body: "Fonctionne partout dès aujourd'hui, rien à installer — ouvrez simplement votre navigateur.",
      },
      {
        title: "Obtenir une appli native",
        body: "Une intégration plus poussée avec le client macOS ; l'appli iOS est en cours de développement.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

const ar = {
  title: "احصل على Relayium — تطبيقات للويب وسطر الأوامر وmacOS وiOS",
  description:
    "نزّل Relayium: استخدمه في أي متصفح، أو ثبّت أداة سطر الأوامر، أو تعرّف على ما تفعله التطبيقات الأصلية. نقل مُشفَّر من الطرف إلى الطرف للملفات والنصوص العابرة — في الويب وسطر الأوامر وتطبيقَي macOS وiOS.",
  hero: {
    h1: "احصل على Relayium",
    pitch: "نقل واحد مُشفَّر من الطرف إلى الطرف للملفات والنصوص العابرة، في كل مكان تعمل فيه. اختر منصّتك.",
    cta: "افتح تطبيق الويب",
  },
  how: {
    heading: "أيّها أستخدم؟",
    steps: [
      "تطبيق الويب — دون تثبيت، في أي متصفح حديث وعلى أي نظام تشغيل: ملفات ونصوص عابرة.",
      "سطر الأوامر — عمليات نقل ملفات قابلة للبرمجة، ومزامنة المجلدات، ونسخ احتياطي للخوادم، ونصوص عابرة على macOS وLinux وWindows.",
      MAC_AVAILABLE
        ? "تطبيق macOS — نزّل تطبيق شريط القوائم الأصلي الموقّع والموثّق."
        : "تطبيق macOS — تطبيق شريط القوائم الأصلي نسخة هندسية وليست متاحة للعامة بعد.",
      "تطبيق iOS — تطبيق أصلي لـ iPhone وiPad: ملفات ونصوص ما دام مفتوحًا؛ وليس متاحًا للعامة بعد.",
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
          ? "تطبيق أصلي حقيقي في شريط القوائم (com.relayium.mac): تبادل الملفات والنصوص مع الأجهزة القريبة أو برمز اقتران، وإرسال الروابط المشفّرة وفتحها، وإدارة الحساب والأجهزة. متاح كتنزيل موقّع وموثّق."
          : "تطبيق أصلي حقيقي في شريط القوائم (com.relayium.mac): تبادل الملفات والنصوص مع الأجهزة القريبة أو برمز اقتران، وإرسال الروابط المشفّرة وفتحها، وإدارة الحساب والأجهزة. وهو نسخة هندسية ليست متاحة للعامة بعد.",
      },
      {
        title: "تطبيق iOS",
        desc: "تطبيق أصلي لـ iPhone وiPad (com.relayium.app): افتح رابطًا مشفّرًا دون حساب، وأرسِل الملفات والنصوص إلى الأجهزة القريبة أو برمز من ستة أرقام، وأدِر حسابك — ما دام التطبيق مفتوحًا.",
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
        body: "تكامل أعمق مع نظام التشغيل عبر تطبيق macOS، وتطبيق iOS قيد التطوير.",
      },
    ],
  },
  learnHeading: "اعرف المزيد",
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

const es = {
  title: "Consigue Relayium — apps para web, CLI, macOS e iOS",
  description:
    "Descarga Relayium: úsalo en cualquier navegador, instala la herramienta de línea de comandos o descubre qué hacen las apps nativas. Transferencia cifrada de extremo a extremo de archivos y texto efímero — web, línea de comandos, macOS e iOS.",
  hero: {
    h1: "Consigue Relayium",
    pitch:
      "Una misma transferencia cifrada de extremo a extremo para archivos y texto efímero, dondequiera que trabajes. Elige tu plataforma.",
    cta: "Abrir la app web",
  },
  how: {
    heading: "¿Cuál debería usar?",
    steps: [
      "App web — sin instalación, en cualquier navegador moderno y en cualquier sistema operativo: archivos y texto efímero.",
      "Línea de comandos — transferencias de archivos programables, sincronización de carpetas, copias de servidores y texto efímero para macOS, Linux y Windows.",
      MAC_AVAILABLE
        ? "App de macOS — descarga la app nativa de barra de menús, firmada y notarizada."
        : "App de macOS — la app nativa de barra de menús es una versión de ingeniería y aún no está disponible públicamente.",
      "App de iOS — una app nativa para iPhone y iPad: archivos y texto mientras está abierta; aún no disponible públicamente.",
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
          ? "Una auténtica app nativa en la barra de menús (com.relayium.mac): archivos y texto con dispositivos cercanos o por código de emparejamiento, enlaces cifrados para enviar y abrir, y gestión de cuenta y dispositivos. Disponible como descarga firmada y notarizada."
          : "Una auténtica app nativa en la barra de menús (com.relayium.mac): archivos y texto con dispositivos cercanos o por código de emparejamiento, enlaces cifrados para enviar y abrir, y gestión de cuenta y dispositivos. Es una versión de ingeniería y aún no está disponible públicamente.",
      },
      {
        title: "App de iOS",
        desc: "Una app nativa para iPhone y iPad (com.relayium.app): abre un enlace cifrado sin cuenta, envía archivos y texto a dispositivos cercanos o con un código de seis dígitos, y gestiona tu cuenta — mientras la app está abierta.",
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
        body: "Una integración más profunda con el cliente de macOS; la app para iOS está en desarrollo.",
      },
    ],
  },
  learnHeading: "Más información",
  footer: { privacy: "Privacidad", terms: "Términos del servicio", security: "Seguridad" },
};

const pt = {
  title: "Obtenha o Relayium — apps para web, CLI, macOS e iOS",
  description:
    "Baixe o Relayium: use em qualquer navegador, instale a ferramenta de linha de comando ou veja o que os apps nativos já fazem. Transferência criptografada de ponta a ponta de arquivos e texto efêmero — web, linha de comando, macOS e iOS.",
  hero: {
    h1: "Obtenha o Relayium",
    pitch:
      "Uma mesma transferência criptografada de ponta a ponta para arquivos e texto efêmero, onde quer que você trabalhe. Escolha sua plataforma.",
    cta: "Abrir o app web",
  },
  how: {
    heading: "Qual devo usar?",
    steps: [
      "App web — sem instalação, em qualquer navegador moderno e em qualquer sistema operacional: arquivos e texto efêmero.",
      "Linha de comando — transferências de arquivos programáveis, sincronização de pastas, backups de servidores e texto efêmero para macOS, Linux e Windows.",
      MAC_AVAILABLE
        ? "App para macOS — baixe o app nativo de barra de menus, assinado e notarizado."
        : "App para macOS — o app nativo de barra de menus é uma versão de engenharia e ainda não está disponível publicamente.",
      "App para iOS — um app nativo para iPhone e iPad: arquivos e texto enquanto está aberto; ainda não disponível publicamente.",
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
          ? "Um verdadeiro app nativo na barra de menus (com.relayium.mac): arquivos e texto com dispositivos por perto ou por código de emparelhamento, links criptografados para enviar e abrir, e gestão de conta e dispositivos. Disponível como download assinado e notarizado."
          : "Um verdadeiro app nativo na barra de menus (com.relayium.mac): arquivos e texto com dispositivos por perto ou por código de emparelhamento, links criptografados para enviar e abrir, e gestão de conta e dispositivos. É uma versão de engenharia e ainda não está disponível publicamente.",
      },
      {
        title: "App para iOS",
        desc: "Um app nativo para iPhone e iPad (com.relayium.app): abra um link criptografado sem conta, envie arquivos e texto para dispositivos por perto ou com um código de seis dígitos, e gerencie sua conta — enquanto o app estiver aberto.",
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
        body: "Uma integração mais profunda com o cliente para macOS; o app para iOS está em desenvolvimento.",
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
  updated: "2026-08-04",
  langs,
};
