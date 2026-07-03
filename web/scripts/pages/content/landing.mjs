// web/scripts/pages/content/landing.mjs — localized copy for the static landing
// pages at /<lang>/. English is the SPA at "/", so only these five langs are here.
// Terminology mirrors src/lib/i18n.svelte.ts for consistency.

const zh = {
  title: "Relayium — 端到端加密的点对点文件传输",
  description:
    "Relayium 是开源、端到端加密的点对点文件传输工具。在浏览器里两台设备直连，文件不经过服务器，无需安装、无需账号即可实时传输。",
  hero: {
    h1: "端到端加密的点对点文件传输",
    pitch:
      "在浏览器里让两台设备直接相连，文件端到端加密、逐块传输，实时模式下根本不经过服务器。无需安装、无需注册，打开网页即可开始。",
    cta: "开始传输",
  },
  how: {
    heading: "四步完成一次传输",
    steps: [
      "两台设备用现代浏览器打开 relayium.com。",
      "一方选择或拖入要发送的文件（每批最多 10 个）。",
      "双方核对屏幕上同一段 6 位校验码（SAS），确认一致以排除中间人。",
      "建立点对点直连，文件逐块经 AES-256-GCM 加密传输，并对每个文件做 SHA-256 完整性校验。",
    ],
  },
  why: {
    heading: "为什么选择 Relayium",
    items: [
      {
        title: "端到端加密",
        desc: "X25519 密钥交换 + 每块 AES-256-GCM 加密，密钥只在两台设备间协商，服务器无从解密。",
      },
      {
        title: "真正点对点",
        desc: "实时模式下文件通过加密的 WebRTC 通道在设备之间直接流动，根本不经过我们的服务器。",
      },
      {
        title: "SAS 防中间人",
        desc: "两边屏幕显示同一段 6 位校验码，核对一致即可排除中间人窃听，即便信令服务器被入侵也无法冒充。",
      },
      {
        title: "跨平台",
        desc: "Windows、macOS、Linux、Android、iOS——只要有现代浏览器就能用，无需安装任何 App。",
      },
      {
        title: "免费开源",
        desc: "MIT 许可，协议与全部前后端代码都在 GitHub 公开；实时传输完全免登录。",
      },
    ],
  },
  compare: {
    heading: "与其他方式相比",
    items: [
      {
        title: "对比 AirDrop",
        body: "AirDrop 原生流畅，但仅限 Apple 设备之间。Relayium 跨平台——Windows、Android 与 iPhone、Mac 之间也能同样直连，只要一个浏览器。",
      },
      {
        title: "对比 Snapdrop / PairDrop",
        body: "Snapdrop 与 PairDrop 是同类先驱。Relayium 在其基础上加了应用层端到端加密与 SAS 校验码：即便信令服务器是恶意的，也无法对你发起中间人攻击。",
      },
      {
        title: "对比 WeTransfer / 网盘",
        body: "WeTransfer 与网盘异步方便，但免费版通常有 2GB 上限，且文件要先上传到它们的服务器。Relayium 实时模式没有大小上限，文件零服务器存储。",
      },
    ],
  },
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "免费吗？",
        a: "免费。Relayium 采用 MIT 许可开源，实时传输完全免登录、无任何费用。",
      },
      {
        q: "文件会上传到服务器吗？",
        a: "实时直传的文件根本不经过服务器；仅当你改用可选的下载链接时，浏览器会先加密再上传，服务器只保存无法解密的密文，密钥只存在于链接里。",
      },
      {
        q: "是端到端加密的吗？",
        a: "是。采用 X25519 密钥交换加每块 AES-256-GCM 加密，密钥只在两台设备之间协商，服务器无法解密任何内容。",
      },
      {
        q: "能跨系统传吗？",
        a: "能。只要有现代浏览器，Windows、macOS、Linux、Android、iOS 之间都能互传，无需安装 App。",
      },
      {
        q: "文件有大小限制吗？",
        a: "实时直传采用流式传输，理论上没有硬性大小上限（Chrome、Edge 直接流式落盘；Firefox、Safari 在内存中缓冲，建议单文件不超过约 200 MB）。每批最多 10 个文件。",
      },
      {
        q: "和 Snapdrop 有什么区别？",
        a: "Relayium 在同类思路上增加了应用层端到端加密与 SAS 校验码，即使信令服务器被入侵也无法窃听或冒充，并支持跨网络传输与可选的零知识下载链接。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "Relayium — エンドツーエンド暗号化のP2Pファイル転送",
  description:
    "Relayiumはオープンソースでエンドツーエンド暗号化のP2Pファイル転送ツールです。ブラウザで2台の端末を直結し、ファイルはサーバーを経由しません。インストールもアカウントも不要で、リアルタイムに転送できます。",
  hero: {
    h1: "エンドツーエンド暗号化のP2Pファイル転送",
    pitch:
      "ブラウザで2台の端末を直接つなぎ、ファイルはエンドツーエンド暗号化されチャンクごとに転送されます。リアルタイムモードではサーバーを一切経由しません。インストールも登録も不要、ウェブページを開くだけで始められます。",
    cta: "転送を始める",
  },
  how: {
    heading: "4ステップで転送",
    steps: [
      "2台の端末でモダンブラウザから relayium.com を開きます。",
      "片方が送るファイルを選ぶかドラッグします（1回につき最大10個）。",
      "両方の画面に表示される同じ6桁の検証コード（SAS）を照合し、一致を確認して中間者を排除します。",
      "P2P直結を確立し、ファイルはチャンクごとにAES-256-GCMで暗号化して転送、各ファイルはSHA-256で完全性を検証します。",
    ],
  },
  why: {
    heading: "Relayiumが選ばれる理由",
    items: [
      {
        title: "エンドツーエンド暗号化",
        desc: "X25519鍵交換とチャンクごとのAES-256-GCM。鍵は2台の端末間だけでネゴシエートされ、サーバーは復号できません。",
      },
      {
        title: "真のP2P",
        desc: "リアルタイムモードではファイルは暗号化されたWebRTCチャネルを通じて端末間を直接流れ、当社のサーバーを一切経由しません。",
      },
      {
        title: "SASで中間者攻撃を防止",
        desc: "両方の画面に同じ6桁の検証コードが表示されます。一致を確認すれば盗聴を狙う中間者を排除でき、シグナリングサーバーが侵害されてもなりすませません。",
      },
      {
        title: "クロスプラットフォーム",
        desc: "Windows・macOS・Linux・Android・iOS——モダンブラウザさえあればインストール不要で使えます。",
      },
      {
        title: "無料でオープンソース",
        desc: "MITライセンス。プロトコルとすべてのコードはGitHubで公開。リアルタイム転送はログイン不要です。",
      },
    ],
  },
  compare: {
    heading: "他の方法との比較",
    items: [
      {
        title: "AirDropとの比較",
        body: "AirDropはネイティブで滑らかですが、Apple製品同士に限られます。Relayiumはクロスプラットフォーム——WindowsやAndroidとiPhoneやMacの間でも、ブラウザさえあれば同じように直結できます。",
      },
      {
        title: "Snapdrop / PairDropとの比較",
        body: "SnapdropとPairDropは同種の先駆けです。Relayiumはその上にアプリケーション層のエンドツーエンド暗号化とSAS検証コードを追加。シグナリングサーバーが悪意を持っていても中間者攻撃はできません。",
      },
      {
        title: "WeTransfer / クラウドストレージとの比較",
        body: "WeTransferやクラウドストレージは非同期で便利ですが、無料枠は通常2GBまでで、ファイルは先方のサーバーへアップロードされます。Relayiumのリアルタイムモードにはサイズ上限がなく、サーバーへの保存もありません。",
      },
    ],
  },
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "無料ですか？",
        a: "無料です。RelayiumはMITライセンスのオープンソースで、リアルタイム転送はログイン不要、料金も一切かかりません。",
      },
      {
        q: "ファイルはサーバーにアップロードされますか？",
        a: "リアルタイム直接転送のファイルはサーバーを一切経由しません。任意のダウンロードリンクを使う場合のみ、ブラウザで暗号化してからアップロードし、サーバーは復号できない暗号文だけを保持します。鍵はリンクの中にしかありません。",
      },
      {
        q: "エンドツーエンド暗号化ですか？",
        a: "はい。X25519鍵交換とチャンクごとのAES-256-GCM暗号化を使い、鍵は2台の端末間だけでネゴシエートされるため、サーバーは何も復号できません。",
      },
      {
        q: "異なるOS間でも転送できますか？",
        a: "できます。モダンブラウザさえあれば、Windows・macOS・Linux・Android・iOSの間で相互に転送でき、アプリのインストールは不要です。",
      },
      {
        q: "ファイルサイズの制限はありますか？",
        a: "リアルタイム直接転送はストリーミングのため、実用上のサイズ上限はありません（Chrome・Edgeはディスクへ直接ストリーミング、Firefox・Safariはメモリにバッファするため1ファイル約200MBまでを推奨）。1回につき最大10ファイルです。",
      },
      {
        q: "Snapdropとの違いは？",
        a: "Relayiumはアプリケーション層のエンドツーエンド暗号化とSAS検証コードを追加しており、シグナリングサーバーが侵害されても盗聴やなりすましができません。さらにネットワークをまたぐ転送や任意のゼロ知識ダウンロードリンクにも対応します。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "Relayium — 종단간 암호화 P2P 파일 전송",
  description:
    "Relayium은 오픈소스이자 종단간 암호화된 P2P 파일 전송 도구입니다. 브라우저에서 두 기기를 직접 연결하며 파일은 서버를 거치지 않습니다. 설치나 계정 없이 실시간으로 전송할 수 있습니다.",
  hero: {
    h1: "종단간 암호화 P2P 파일 전송",
    pitch:
      "브라우저에서 두 기기를 직접 연결하고, 파일은 종단간 암호화되어 청크 단위로 전송됩니다. 실시간 모드에서는 서버를 전혀 거치지 않습니다. 설치도 가입도 필요 없이 웹 페이지만 열면 시작할 수 있습니다.",
    cta: "전송 시작",
  },
  how: {
    heading: "4단계로 전송",
    steps: [
      "두 기기에서 최신 브라우저로 relayium.com에 접속합니다.",
      "한쪽이 보낼 파일을 선택하거나 끌어다 놓습니다(한 번에 최대 10개).",
      "양쪽 화면에 표시되는 동일한 6자리 검증 코드(SAS)를 대조해 일치를 확인하고 중간자를 차단합니다.",
      "P2P 직접 연결을 맺고, 파일은 청크마다 AES-256-GCM으로 암호화되어 전송되며 각 파일은 SHA-256으로 무결성을 검증합니다.",
    ],
  },
  why: {
    heading: "Relayium을 선택하는 이유",
    items: [
      {
        title: "종단간 암호화",
        desc: "X25519 키 교환과 청크별 AES-256-GCM. 키는 두 기기 사이에서만 협상되며 서버는 복호화할 수 없습니다.",
      },
      {
        title: "진정한 P2P",
        desc: "실시간 모드에서 파일은 암호화된 WebRTC 채널을 통해 기기 간에 직접 전달되며 당사 서버를 전혀 거치지 않습니다.",
      },
      {
        title: "SAS로 중간자 공격 차단",
        desc: "양쪽 화면에 동일한 6자리 검증 코드가 표시됩니다. 서로 대조해 도청하는 중간자를 차단할 수 있으며, 시그널링 서버가 침해되어도 가장할 수 없습니다.",
      },
      {
        title: "크로스 플랫폼",
        desc: "Windows, macOS, Linux, Android, iOS — 최신 브라우저만 있으면 설치 없이 바로 사용할 수 있습니다.",
      },
      {
        title: "무료 오픈소스",
        desc: "MIT 라이선스로 프로토콜과 모든 코드가 GitHub에 공개되어 있으며, 실시간 전송은 로그인이 필요 없습니다.",
      },
    ],
  },
  compare: {
    heading: "다른 방식과 비교",
    items: [
      {
        title: "AirDrop과 비교",
        body: "AirDrop은 네이티브라 매끄럽지만 Apple 기기끼리만 됩니다. Relayium은 크로스 플랫폼이라 Windows나 Android와 iPhone, Mac 사이에서도 브라우저만 있으면 똑같이 직접 연결됩니다.",
      },
      {
        title: "Snapdrop / PairDrop과 비교",
        body: "Snapdrop과 PairDrop은 같은 부류의 선구자입니다. Relayium은 여기에 애플리케이션 계층의 종단간 암호화와 SAS 검증 코드를 더했습니다. 시그널링 서버가 악의적이어도 중간자 공격을 할 수 없습니다.",
      },
      {
        title: "WeTransfer / 클라우드 드라이브와 비교",
        body: "WeTransfer와 클라우드 드라이브는 비동기라 편리하지만 무료 요금제는 보통 2GB로 제한되고 파일이 그들의 서버에 업로드됩니다. Relayium 실시간 모드는 크기 제한이 없고 서버 저장도 없습니다.",
      },
    ],
  },
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "무료인가요?",
        a: "무료입니다. Relayium은 MIT 라이선스의 오픈소스이며, 실시간 전송은 로그인 없이 아무 비용 없이 사용할 수 있습니다.",
      },
      {
        q: "파일이 서버에 업로드되나요?",
        a: "실시간 직접 전송의 파일은 서버를 전혀 거치지 않습니다. 선택적인 다운로드 링크를 쓸 때만 브라우저에서 암호화한 뒤 업로드하며, 서버는 복호화할 수 없는 암호문만 보관하고 키는 링크 안에만 있습니다.",
      },
      {
        q: "종단간 암호화인가요?",
        a: "네. X25519 키 교환과 청크별 AES-256-GCM 암호화를 사용하며, 키는 두 기기 사이에서만 협상되므로 서버는 어떤 내용도 복호화할 수 없습니다.",
      },
      {
        q: "다른 운영체제 간에도 전송되나요?",
        a: "됩니다. 최신 브라우저만 있으면 Windows, macOS, Linux, Android, iOS 사이에서 서로 전송할 수 있으며 앱 설치가 필요 없습니다.",
      },
      {
        q: "파일 크기 제한이 있나요?",
        a: "실시간 직접 전송은 스트리밍 방식이라 실질적인 크기 상한이 없습니다(Chrome·Edge는 디스크로 바로 스트리밍하고, Firefox·Safari는 메모리에 버퍼링하므로 파일당 약 200MB 이하를 권장). 한 번에 최대 10개 파일입니다.",
      },
      {
        q: "Snapdrop과 무엇이 다른가요?",
        a: "Relayium은 애플리케이션 계층의 종단간 암호화와 SAS 검증 코드를 추가해, 시그널링 서버가 침해되어도 도청이나 위장을 할 수 없습니다. 또한 네트워크를 넘는 전송과 선택적 영지식 다운로드 링크도 지원합니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Relayium — Ende-zu-Ende-verschlüsselte P2P-Dateiübertragung",
  description:
    "Relayium ist ein quelloffenes, Ende-zu-Ende-verschlüsseltes Werkzeug für Peer-to-Peer-Dateiübertragung. Zwei Geräte verbinden sich direkt im Browser, Dateien erreichen nie den Server — ohne Installation, ohne Konto, in Echtzeit.",
  hero: {
    h1: "Ende-zu-Ende-verschlüsselte P2P-Dateiübertragung",
    pitch:
      "Verbinde zwei Geräte direkt im Browser; Dateien werden Ende-zu-Ende verschlüsselt und Chunk für Chunk übertragen. Im Echtzeitmodus erreichen sie nie den Server. Keine Installation, keine Registrierung — einfach die Webseite öffnen und loslegen.",
    cta: "Übertragung starten",
  },
  how: {
    heading: "In vier Schritten übertragen",
    steps: [
      "Öffne relayium.com auf beiden Geräten in einem modernen Browser.",
      "Eine Seite wählt die zu sendenden Dateien aus oder zieht sie hinein (bis zu 10 pro Vorgang).",
      "Vergleicht auf beiden Bildschirmen denselben 6-stelligen Prüfcode (SAS) und bestätigt die Übereinstimmung, um einen Mittelsmann auszuschließen.",
      "Eine direkte P2P-Verbindung wird aufgebaut; Dateien werden Chunk für Chunk mit AES-256-GCM verschlüsselt übertragen, jede Datei per SHA-256 auf Integrität geprüft.",
    ],
  },
  why: {
    heading: "Warum Relayium",
    items: [
      {
        title: "Ende-zu-Ende-verschlüsselt",
        desc: "X25519-Schlüsselaustausch und AES-256-GCM pro Chunk; die Schlüssel werden ausschließlich zwischen den beiden Geräten ausgehandelt, der Server kann nicht entschlüsseln.",
      },
      {
        title: "Echtes Peer-to-Peer",
        desc: "Im Echtzeitmodus fließen Dateien über einen verschlüsselten WebRTC-Kanal direkt von Gerät zu Gerät und erreichen unsere Server nie.",
      },
      {
        title: "SAS gegen Man-in-the-Middle",
        desc: "Beide Bildschirme zeigen denselben 6-stelligen Prüfcode; stimmt er überein, ist ein mithörender Mittelsmann ausgeschlossen — selbst ein kompromittierter Signalisierungsserver kann sich nicht ausgeben.",
      },
      {
        title: "Plattformübergreifend",
        desc: "Windows, macOS, Linux, Android, iOS — ein moderner Browser genügt, es ist keine Installation nötig.",
      },
      {
        title: "Kostenlos & Open Source",
        desc: "MIT-Lizenz; Protokoll und der gesamte Code liegen offen auf GitHub. Echtzeitübertragungen brauchen kein Konto.",
      },
    ],
  },
  compare: {
    heading: "Im Vergleich",
    items: [
      {
        title: "Gegenüber AirDrop",
        body: "AirDrop ist nativ und flüssig, aber auf Apple-Geräte beschränkt. Relayium ist plattformübergreifend — auch zwischen Windows oder Android und iPhone oder Mac verbindet es genauso direkt, es genügt ein Browser.",
      },
      {
        title: "Gegenüber Snapdrop / PairDrop",
        body: "Snapdrop und PairDrop sind Vorreiter derselben Art. Relayium ergänzt sie um Ende-zu-Ende-Verschlüsselung auf Anwendungsebene und einen SAS-Prüfcode: Selbst ein bösartiger Signalisierungsserver kann keinen Mittelsmann-Angriff durchführen.",
      },
      {
        title: "Gegenüber WeTransfer / Cloud-Speicher",
        body: "WeTransfer und Cloud-Speicher sind asynchron und bequem, doch das kostenlose Kontingent liegt meist bei 2 GB und Dateien werden auf deren Server hochgeladen. Der Echtzeitmodus von Relayium hat keine Größengrenze und speichert nichts auf dem Server.",
      },
    ],
  },
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist es kostenlos?",
        a: "Ja. Relayium ist Open Source unter der MIT-Lizenz; Echtzeitübertragungen sind ohne Anmeldung und ohne jede Gebühr nutzbar.",
      },
      {
        q: "Werden meine Dateien auf einen Server hochgeladen?",
        a: "Dateien der Echtzeit-Direktübertragung erreichen den Server nie. Nur wenn du den optionalen Download-Link nutzt, verschlüsselt der Browser sie vor dem Hochladen, und der Server behält lediglich Chiffretext, den er nicht entschlüsseln kann — der Schlüssel steckt nur im Link.",
      },
      {
        q: "Ist es Ende-zu-Ende-verschlüsselt?",
        a: "Ja. Es nutzt X25519-Schlüsselaustausch und AES-256-GCM pro Chunk; die Schlüssel werden nur zwischen den beiden Geräten ausgehandelt, sodass der Server nichts entschlüsseln kann.",
      },
      {
        q: "Funktioniert es systemübergreifend?",
        a: "Ja. Mit einem modernen Browser kannst du zwischen Windows, macOS, Linux, Android und iOS übertragen, ganz ohne App-Installation.",
      },
      {
        q: "Gibt es eine Größenbeschränkung?",
        a: "Die Echtzeit-Direktübertragung streamt die Daten, daher gibt es in der Praxis keine harte Größengrenze (Chrome und Edge streamen direkt auf die Festplatte; Firefox und Safari puffern im Speicher, daher werden ca. 200 MB pro Datei empfohlen). Maximal 10 Dateien pro Vorgang.",
      },
      {
        q: "Was ist der Unterschied zu Snapdrop?",
        a: "Relayium ergänzt Ende-zu-Ende-Verschlüsselung auf Anwendungsebene und einen SAS-Prüfcode, sodass selbst ein kompromittierter Signalisierungsserver weder mithören noch sich ausgeben kann. Zudem unterstützt es netzübergreifende Übertragungen und optionale Zero-Knowledge-Download-Links.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Relayium — Transfert de fichiers P2P chiffré de bout en bout",
  description:
    "Relayium est un outil open source de transfert de fichiers pair-à-pair chiffré de bout en bout. Deux appareils se connectent directement dans le navigateur, les fichiers ne passent jamais par le serveur — sans installation, sans compte, en temps réel.",
  hero: {
    h1: "Transfert de fichiers P2P chiffré de bout en bout",
    pitch:
      "Reliez deux appareils directement dans le navigateur ; les fichiers sont chiffrés de bout en bout et transférés bloc par bloc. En mode temps réel, ils ne passent jamais par le serveur. Aucune installation, aucune inscription — ouvrez la page web et commencez.",
    cta: "Démarrer le transfert",
  },
  how: {
    heading: "Transférer en quatre étapes",
    steps: [
      "Ouvrez relayium.com sur les deux appareils dans un navigateur moderne.",
      "Un côté sélectionne ou glisse les fichiers à envoyer (jusqu'à 10 par lot).",
      "Comparez sur les deux écrans le même code de vérification à 6 chiffres (SAS) et confirmez la correspondance pour écarter tout homme du milieu.",
      "Une connexion directe pair-à-pair s'établit ; les fichiers sont transférés bloc par bloc, chiffrés en AES-256-GCM, et chaque fichier est vérifié en intégrité via SHA-256.",
    ],
  },
  why: {
    heading: "Pourquoi Relayium",
    items: [
      {
        title: "Chiffré de bout en bout",
        desc: "Échange de clés X25519 et AES-256-GCM par bloc ; les clés sont négociées uniquement entre les deux appareils et le serveur ne peut pas déchiffrer.",
      },
      {
        title: "Véritable pair-à-pair",
        desc: "En mode temps réel, les fichiers circulent directement d'appareil à appareil via un canal WebRTC chiffré et ne passent jamais par nos serveurs.",
      },
      {
        title: "SAS contre l'homme du milieu",
        desc: "Les deux écrans affichent le même code de vérification à 6 chiffres ; s'il correspond, tout intercepteur est écarté — même un serveur de signalisation compromis ne peut pas se faire passer pour vous.",
      },
      {
        title: "Multiplateforme",
        desc: "Windows, macOS, Linux, Android, iOS — un navigateur moderne suffit, aucune installation requise.",
      },
      {
        title: "Gratuit et open source",
        desc: "Licence MIT ; le protocole et tout le code sont publics sur GitHub. Les transferts en temps réel ne nécessitent aucun compte.",
      },
    ],
  },
  compare: {
    heading: "En comparaison",
    items: [
      {
        title: "Face à AirDrop",
        body: "AirDrop est natif et fluide, mais limité aux appareils Apple. Relayium est multiplateforme — il relie tout aussi directement Windows ou Android à un iPhone ou un Mac, avec un simple navigateur.",
      },
      {
        title: "Face à Snapdrop / PairDrop",
        body: "Snapdrop et PairDrop sont des pionniers du même genre. Relayium y ajoute un chiffrement de bout en bout au niveau applicatif et un code de vérification SAS : même un serveur de signalisation malveillant ne peut pas monter d'attaque de l'homme du milieu.",
      },
      {
        title: "Face à WeTransfer / stockage en ligne",
        body: "WeTransfer et les stockages en ligne sont asynchrones et pratiques, mais l'offre gratuite plafonne souvent à 2 Go et les fichiers sont téléversés sur leurs serveurs. Le mode temps réel de Relayium n'a aucune limite de taille et ne stocke rien sur le serveur.",
      },
    ],
  },
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Est-ce gratuit ?",
        a: "Oui. Relayium est open source sous licence MIT ; les transferts en temps réel s'utilisent sans connexion et sans aucun frais.",
      },
      {
        q: "Mes fichiers sont-ils téléversés sur un serveur ?",
        a: "Les fichiers du transfert direct en temps réel ne passent jamais par le serveur. Uniquement si vous utilisez le lien de téléchargement optionnel, le navigateur les chiffre avant l'envoi et le serveur ne conserve que du chiffré qu'il ne peut pas déchiffrer — la clé reste dans le lien.",
      },
      {
        q: "Est-ce chiffré de bout en bout ?",
        a: "Oui. Il utilise l'échange de clés X25519 et le chiffrement AES-256-GCM par bloc ; les clés sont négociées uniquement entre les deux appareils, si bien que le serveur ne peut rien déchiffrer.",
      },
      {
        q: "Peut-on transférer entre systèmes différents ?",
        a: "Oui. Avec un navigateur moderne, vous pouvez transférer entre Windows, macOS, Linux, Android et iOS, sans installer d'application.",
      },
      {
        q: "Y a-t-il une limite de taille ?",
        a: "Le transfert direct en temps réel diffuse les données en flux, il n'y a donc en pratique aucune limite stricte de taille (Chrome et Edge écrivent directement sur le disque ; Firefox et Safari mettent en mémoire tampon, environ 200 Mo par fichier sont conseillés). Jusqu'à 10 fichiers par lot.",
      },
      {
        q: "Quelle différence avec Snapdrop ?",
        a: "Relayium ajoute un chiffrement de bout en bout au niveau applicatif et un code de vérification SAS, si bien qu'un serveur de signalisation compromis ne peut ni écouter ni usurper. Il prend aussi en charge les transferts inter-réseaux et des liens de téléchargement optionnels à connaissance nulle.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

export default {
  updated: "2026-07-03",
  langs: { zh, ja, ko, de, fr },
};
