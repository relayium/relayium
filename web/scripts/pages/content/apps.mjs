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

const en = {
  title: "Get Relayium — apps for web, CLI, macOS & iOS",
  description:
    "Download Relayium: use it in any browser, install the command-line tool, or get the native macOS and iOS apps (coming soon). End-to-end encrypted file transfer on every device.",
  hero: {
    h1: "Get Relayium",
    pitch: "One end-to-end encrypted file transfer, everywhere you work. Pick your platform.",
    cta: "Open the web app",
  },
  how: {
    heading: "Which one should I use?",
    steps: [
      "Web app — zero-install, in any modern browser on any OS.",
      "Command line — scriptable transfers, folder sync and server backups on macOS, Linux and Windows.",
      "macOS app — a real native app, coming soon.",
      "iOS app — a native iPhone & iPad app, coming to the App Store.",
    ],
  },
  why: {
    heading: "One transfer, every device",
    items: [
      {
        title: "Web app",
        desc: "Nothing to install. Open it in any modern browser on any OS and start transferring.",
      },
      {
        title: "Command line",
        desc: "Scriptable transfers, folder sync and server-to-server backups for macOS, Linux and Windows.",
      },
      {
        title: "macOS app",
        desc: "A true native menu-bar app (com.relayium.mac). Signed & notarized for one-click install — in the works.",
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
        body: "Deeper OS integration. The macOS and iOS versions are coming soon.",
      },
    ],
  },
  learnHeading: "Learn more",
  footer: { privacy: "Privacy", terms: "Terms", security: "Security" },
};

const zh = {
  title: "获取 Relayium——网页版、命令行、macOS 与 iOS 应用",
  description:
    "下载 Relayium：在任意浏览器中直接使用、安装命令行工具，或获取原生 macOS 与 iOS 应用（即将推出）。端到端加密的文件传输，覆盖你的每一台设备。",
  hero: {
    h1: "获取 Relayium",
    pitch: "同一套端到端加密的文件传输，随处可用。选择你的平台。",
    cta: "打开网页版",
  },
  how: {
    heading: "该用哪一个？",
    steps: [
      "网页版——零安装，任意操作系统的现代浏览器打开即用。",
      "命令行——可脚本化的传输、文件夹同步与服务器备份，支持 macOS、Linux 与 Windows。",
      "macOS 应用——真正的原生应用，即将推出。",
      "iOS 应用——原生 iPhone 与 iPad 应用，即将登陆 App Store。",
    ],
  },
  why: {
    heading: "一次传输，覆盖每台设备",
    items: [
      {
        title: "网页版",
        desc: "无需安装。在任意系统的现代浏览器中打开即可开始传输。",
      },
      {
        title: "命令行",
        desc: "可脚本化的传输、文件夹同步与服务器间备份，支持 macOS、Linux 与 Windows。",
      },
      {
        title: "macOS 应用",
        desc: "真正的原生菜单栏应用（com.relayium.mac）。已签名并公证，一键安装——正在开发中。",
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
        body: "更深度的系统集成，macOS 与 iOS 版即将推出。",
      },
    ],
  },
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "Relayium を入手 — ウェブ、CLI、macOS、iOS 向けアプリ",
  description:
    "Relayium をダウンロード：任意のブラウザで使う、コマンドラインツールをインストールする、またはネイティブの macOS・iOS アプリ（近日公開）を入手。すべてのデバイスでエンドツーエンド暗号化のファイル転送を。",
  hero: {
    h1: "Relayium を入手",
    pitch: "同じエンドツーエンド暗号化のファイル転送を、あらゆる場所で。プラットフォームを選んでください。",
    cta: "ウェブアプリを開く",
  },
  how: {
    heading: "どれを使えばいい？",
    steps: [
      "ウェブアプリ — インストール不要、どの OS の最新ブラウザでもすぐに使えます。",
      "コマンドライン — スクリプト化できる転送、フォルダー同期、サーバーバックアップ。macOS、Linux、Windows で利用可能。",
      "macOS アプリ — 本物のネイティブアプリ、近日公開。",
      "iOS アプリ — ネイティブな iPhone・iPad アプリ、App Store に近日登場。",
    ],
  },
  why: {
    heading: "ひとつの転送を、すべてのデバイスで",
    items: [
      {
        title: "ウェブアプリ",
        desc: "インストール不要。どの OS でも最新のブラウザで開けばすぐに転送を開始できます。",
      },
      {
        title: "コマンドライン",
        desc: "スクリプト化できる転送、フォルダー同期、サーバー間バックアップに対応。macOS、Linux、Windows で利用可能。",
      },
      {
        title: "macOS アプリ",
        desc: "本物のネイティブなメニューバーアプリ（com.relayium.mac）。署名・公証済みでワンクリックインストール — 開発中です。",
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
        body: "より深い OS 連携。macOS・iOS 版が近日公開です。",
      },
    ],
  },
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "Relayium 받기 — 웹, CLI, macOS 및 iOS 앱",
  description:
    "Relayium 다운로드: 어떤 브라우저에서든 바로 사용하거나, 명령줄 도구를 설치하거나, 네이티브 macOS 및 iOS 앱(출시 예정)을 받으세요. 모든 기기에서 종단간 암호화 파일 전송을.",
  hero: {
    h1: "Relayium 받기",
    pitch: "하나의 종단간 암호화 파일 전송을 어디서나. 플랫폼을 선택하세요.",
    cta: "웹 앱 열기",
  },
  how: {
    heading: "어느 것을 써야 할까요?",
    steps: [
      "웹 앱 — 설치 불필요, 어떤 OS의 최신 브라우저에서든 바로 사용.",
      "명령줄 — 스크립트로 자동화하는 전송, 폴더 동기화, 서버 백업. macOS, Linux, Windows 지원.",
      "macOS 앱 — 진짜 네이티브 앱, 출시 예정.",
      "iOS 앱 — 네이티브 iPhone·iPad 앱, App Store에 곧 출시.",
    ],
  },
  why: {
    heading: "하나의 전송, 모든 기기에서",
    items: [
      {
        title: "웹 앱",
        desc: "설치 불필요. 어떤 OS의 최신 브라우저에서든 열어 바로 전송을 시작하세요.",
      },
      {
        title: "명령줄",
        desc: "스크립트로 자동화하는 전송, 폴더 동기화, 서버 간 백업. macOS, Linux, Windows 지원.",
      },
      {
        title: "macOS 앱",
        desc: "진짜 네이티브 메뉴 바 앱(com.relayium.mac). 서명 및 공증을 마쳐 한 번의 클릭으로 설치 — 개발 중입니다.",
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
        body: "더 깊은 OS 통합. macOS와 iOS 버전이 곧 출시됩니다.",
      },
    ],
  },
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Relayium holen — Apps für Web, CLI, macOS & iOS",
  description:
    "Relayium herunterladen: in jedem Browser nutzen, das Kommandozeilen-Tool installieren oder die nativen macOS- und iOS-Apps holen (in Kürze). Ende-zu-Ende-verschlüsselte Dateiübertragung auf jedem Gerät.",
  hero: {
    h1: "Relayium holen",
    pitch: "Eine Ende-zu-Ende-verschlüsselte Dateiübertragung, überall wo du arbeitest. Wähle deine Plattform.",
    cta: "Web-App öffnen",
  },
  how: {
    heading: "Welche soll ich nehmen?",
    steps: [
      "Web-App — ohne Installation, in jedem modernen Browser auf jedem Betriebssystem.",
      "Kommandozeile — skriptbare Übertragungen, Ordner-Sync und Server-Backups für macOS, Linux und Windows.",
      "macOS-App — eine echte native App, in Kürze.",
      "iOS-App — eine native iPhone- & iPad-App, kommt in den App Store.",
    ],
  },
  why: {
    heading: "Eine Übertragung, jedes Gerät",
    items: [
      {
        title: "Web-App",
        desc: "Nichts zu installieren. In jedem modernen Browser auf jedem Betriebssystem öffnen und loslegen.",
      },
      {
        title: "Kommandozeile",
        desc: "Skriptbare Übertragungen, Ordner-Sync und Server-zu-Server-Backups für macOS, Linux und Windows.",
      },
      {
        title: "macOS-App",
        desc: "Eine echte native Menüleisten-App (com.relayium.mac). Signiert & notarisiert für die Ein-Klick-Installation — in Arbeit.",
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
        body: "Tiefere Integration ins Betriebssystem. Die Versionen für macOS und iOS kommen bald.",
      },
    ],
  },
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Obtenir Relayium — applis pour le web, le CLI, macOS et iOS",
  description:
    "Téléchargez Relayium : utilisez-le dans n'importe quel navigateur, installez l'outil en ligne de commande ou obtenez les applis natives macOS et iOS (bientôt disponibles). Transfert de fichiers chiffré de bout en bout sur chaque appareil.",
  hero: {
    h1: "Obtenir Relayium",
    pitch: "Un même transfert de fichiers chiffré de bout en bout, partout où vous travaillez. Choisissez votre plateforme.",
    cta: "Ouvrir l'appli web",
  },
  how: {
    heading: "Laquelle choisir ?",
    steps: [
      "Appli web — sans installation, dans n'importe quel navigateur moderne, sur n'importe quel OS.",
      "Ligne de commande — transferts scriptables, synchronisation de dossiers et sauvegardes de serveur pour macOS, Linux et Windows.",
      "Appli macOS — une vraie appli native, bientôt disponible.",
      "Appli iOS — une appli native iPhone et iPad, bientôt sur l'App Store.",
    ],
  },
  why: {
    heading: "Un seul transfert, tous vos appareils",
    items: [
      {
        title: "Appli web",
        desc: "Rien à installer. Ouvrez-la dans n'importe quel navigateur moderne, sur n'importe quel OS, et commencez à transférer.",
      },
      {
        title: "Ligne de commande",
        desc: "Transferts scriptables, synchronisation de dossiers et sauvegardes de serveur à serveur pour macOS, Linux et Windows.",
      },
      {
        title: "Appli macOS",
        desc: "Une vraie appli native dans la barre de menus (com.relayium.mac). Signée et notarisée pour une installation en un clic — en cours de développement.",
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
        body: "Une intégration plus poussée au système. Les versions macOS et iOS arrivent bientôt.",
      },
    ],
  },
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

const ar = {
  title: "احصل على Relayium — تطبيقات للويب وسطر الأوامر وmacOS وiOS",
  description:
    "نزّل Relayium: استخدمه في أي متصفح، أو ثبّت أداة سطر الأوامر، أو احصل على تطبيقَي macOS وiOS الأصليين (قريبًا). نقل ملفات مشفّر من طرف إلى طرف على كل جهاز.",
  hero: {
    h1: "احصل على Relayium",
    pitch: "نقل ملفات واحد مشفّر من طرف إلى طرف، في كل مكان تعمل فيه. اختر منصّتك.",
    cta: "افتح تطبيق الويب",
  },
  how: {
    heading: "أيّها أستخدم؟",
    steps: [
      "تطبيق الويب — دون تثبيت، في أي متصفح حديث وعلى أي نظام تشغيل.",
      "سطر الأوامر — عمليات نقل قابلة للبرمجة، ومزامنة المجلدات، ونسخ احتياطي للخوادم على macOS وLinux وWindows.",
      "تطبيق macOS — تطبيق أصلي حقيقي، قريبًا.",
      "تطبيق iOS — تطبيق أصلي لـ iPhone وiPad، قريبًا على App Store.",
    ],
  },
  why: {
    heading: "نقل واحد، لكل جهاز",
    items: [
      {
        title: "تطبيق الويب",
        desc: "لا شيء للتثبيت. افتحه في أي متصفح حديث على أي نظام تشغيل وابدأ النقل.",
      },
      {
        title: "سطر الأوامر",
        desc: "عمليات نقل قابلة للبرمجة، ومزامنة المجلدات، ونسخ احتياطي من خادم إلى خادم لأنظمة macOS وLinux وWindows.",
      },
      {
        title: "تطبيق macOS",
        desc: "تطبيق أصلي حقيقي في شريط القوائم (com.relayium.mac). موقّع وموثّق للتثبيت بنقرة واحدة — قيد التطوير.",
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
        body: "تكامل أعمق مع نظام التشغيل. نسختا macOS وiOS قادمتان قريبًا.",
      },
    ],
  },
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

const es = {
  title: "Consigue Relayium — apps para web, CLI, macOS e iOS",
  description:
    "Descarga Relayium: úsalo en cualquier navegador, instala la herramienta de línea de comandos u obtén las apps nativas de macOS e iOS (próximamente). Transferencia de archivos cifrada de extremo a extremo en todos tus dispositivos.",
  hero: {
    h1: "Consigue Relayium",
    pitch: "Una misma transferencia de archivos cifrada de extremo a extremo, dondequiera que trabajes. Elige tu plataforma.",
    cta: "Abrir la app web",
  },
  how: {
    heading: "¿Cuál debería usar?",
    steps: [
      "App web — sin instalación, en cualquier navegador moderno y en cualquier sistema operativo.",
      "Línea de comandos — transferencias programables, sincronización de carpetas y copias de servidores para macOS, Linux y Windows.",
      "App de macOS — una auténtica app nativa, próximamente.",
      "App de iOS — una app nativa para iPhone y iPad, pronto en la App Store.",
    ],
  },
  why: {
    heading: "Una transferencia, todos tus dispositivos",
    items: [
      {
        title: "App web",
        desc: "Nada que instalar. Ábrela en cualquier navegador moderno, en cualquier sistema operativo, y empieza a transferir.",
      },
      {
        title: "Línea de comandos",
        desc: "Transferencias programables, sincronización de carpetas y copias de servidor a servidor para macOS, Linux y Windows.",
      },
      {
        title: "App de macOS",
        desc: "Una auténtica app nativa en la barra de menús (com.relayium.mac). Firmada y notarizada para instalarla con un clic — en desarrollo.",
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
        body: "Una integración más profunda con el sistema. Las versiones para macOS e iOS llegan pronto.",
      },
    ],
  },
  footer: { privacy: "Privacidad", terms: "Términos del servicio", security: "Seguridad" },
};

const pt = {
  title: "Obtenha o Relayium — apps para web, CLI, macOS e iOS",
  description:
    "Baixe o Relayium: use em qualquer navegador, instale a ferramenta de linha de comando ou obtenha os apps nativos para macOS e iOS (em breve). Transferência de arquivos criptografada de ponta a ponta em todos os dispositivos.",
  hero: {
    h1: "Obtenha o Relayium",
    pitch: "Uma mesma transferência de arquivos criptografada de ponta a ponta, onde quer que você trabalhe. Escolha sua plataforma.",
    cta: "Abrir o app web",
  },
  how: {
    heading: "Qual devo usar?",
    steps: [
      "App web — sem instalação, em qualquer navegador moderno e em qualquer sistema operacional.",
      "Linha de comando — transferências programáveis, sincronização de pastas e backups de servidores para macOS, Linux e Windows.",
      "App para macOS — um verdadeiro app nativo, em breve.",
      "App para iOS — um app nativo para iPhone e iPad, em breve na App Store.",
    ],
  },
  why: {
    heading: "Uma transferência, em todos os dispositivos",
    items: [
      {
        title: "App web",
        desc: "Nada para instalar. Abra em qualquer navegador moderno, em qualquer sistema, e comece a transferir.",
      },
      {
        title: "Linha de comando",
        desc: "Transferências programáveis, sincronização de pastas e backups de servidor para servidor para macOS, Linux e Windows.",
      },
      {
        title: "App para macOS",
        desc: "Um verdadeiro app nativo na barra de menus (com.relayium.mac). Assinado e notarizado para instalação com um clique — em desenvolvimento.",
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
        body: "Uma integração mais profunda com o sistema. As versões para macOS e iOS chegam em breve.",
      },
    ],
  },
  footer: { privacy: "Privacidade", terms: "Termos de Serviço", security: "Segurança" },
};

export default {
  updated: "2026-07-19",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
