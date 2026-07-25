// web/scripts/pages/content/landing.mjs — localized copy for the static landing
// pages at /<lang>/. English is the SPA at "/", so only these five langs are here.
// Terminology mirrors src/lib/i18n.svelte.ts for consistency.

const zh = {
  title: "Relayium — 端到端加密的点对点文件传输",
  description:
    "Relayium 是开源、端到端加密的文件传输工具。在浏览器里实时直传：同一网络下两台设备直连、文件不经过服务器，跨网络则经加密中继转发（中继只见密文）。无需安装，同一网络下无需账号，跨网络配对时仅发送方需登录。",
  hero: {
    h1: "端到端加密的点对点文件传输",
    pitch:
      "在浏览器里让两台设备直接相连，文件端到端加密、逐块传输；同一网络下根本不经过服务器，跨网络则经加密中继转发（中继只见密文）。无需安装、无需注册，打开网页即可开始。",
    cta: "开始传输",
  },
  how: {
    heading: "四步完成一次传输",
    steps: [
      "两台设备用现代浏览器打开 relayium.com。",
      "一方选择或拖入要发送的文件（每批最多 1,000 个）。",
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
        desc: "同一网络下文件通过加密的 WebRTC 通道在设备之间直接流动、根本不经过我们的服务器；跨网络时经加密中继转发，中继也只能看到密文。",
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
        desc: "AGPL-3.0 许可，协议与全部前后端代码都在 GitHub 公开；同一网络下实时传输免登录，跨网络配对码传输仅发送方需登录。",
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
        a: "免费。Relayium 采用 AGPL-3.0 许可开源，完全无任何费用；同一网络下实时传输无需登录，跨网络配对码传输仅发送方需登录，接收方始终无需账号。",
      },
      {
        q: "文件会上传到服务器吗？",
        a: "同一网络下实时直传的文件根本不经过服务器；跨网络时经加密中继转发，中继也只能看到密文。仅当你改用可选的下载链接时，浏览器会先加密再上传，服务器只保存无法解密的密文，密钥只存在于链接里。",
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
        a: "实时直传采用流式传输，理论上没有硬性大小上限（Chrome、Edge 直接流式落盘；Firefox、Safari 在内存中缓冲，建议单文件不超过约 200 MB）。每批最多 1,000 个文件。",
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
    "Relayiumはオープンソースでエンドツーエンド暗号化のファイル転送ツールです。ブラウザでのリアルタイム転送では、同じネットワークなら2台の端末が直結しファイルはサーバーを経由せず、ネットワークをまたぐ場合は暗号化されたリレー経由になります（リレーは暗号文しか扱いません）。インストール不要、同じネットワークならアカウントも不要です（ネットワークをまたぐペアリングは送信側のサインインのみ必要）。",
  hero: {
    h1: "エンドツーエンド暗号化のP2Pファイル転送",
    pitch:
      "ブラウザで2台の端末を直接つなぎ、ファイルはエンドツーエンド暗号化されチャンクごとに転送されます。同じネットワークではサーバーを一切経由せず、ネットワークをまたぐ場合は暗号化されたリレー経由になります（リレーは暗号文のみ）。インストールも登録も不要、ウェブページを開くだけで始められます。",
    cta: "転送を始める",
  },
  how: {
    heading: "4ステップで転送",
    steps: [
      "2台の端末でモダンブラウザから relayium.com を開きます。",
      "片方が送るファイルを選ぶかドラッグします（1回につき最大1,000個）。",
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
        desc: "同じネットワークではファイルは暗号化されたWebRTCチャネルを通じて端末間を直接流れ、当社のサーバーを一切経由しません。ネットワークをまたぐ場合は暗号化されたリレーを経由しますが、リレーも暗号文しか見えません。",
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
        desc: "AGPL-3.0ライセンス。プロトコルとすべてのコードはGitHubで公開。同じネットワークならリアルタイム転送はログイン不要、ネットワークをまたぐペアリングコードでの転送は送信側のみサインインが必要です。",
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
        a: "無料です。RelayiumはAGPL-3.0ライセンスのオープンソースで、料金は一切かかりません。同じネットワークならリアルタイム転送はログイン不要で、ネットワークをまたぐペアリングコードでの転送は送信側のみサインインが必要です。受信側はどちらの場合もアカウント不要です。",
      },
      {
        q: "ファイルはサーバーにアップロードされますか？",
        a: "同じネットワークでのリアルタイム直接転送では、ファイルはサーバーを一切経由しません。ネットワークをまたぐ場合は暗号化されたリレーを経由しますが、リレーも暗号文しか見えません。任意のダウンロードリンクを使う場合のみ、ブラウザで暗号化してからアップロードし、サーバーは復号できない暗号文だけを保持します。鍵はリンクの中にしかありません。",
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
        a: "リアルタイム直接転送はストリーミングのため、実用上のサイズ上限はありません（Chrome・Edgeはディスクへ直接ストリーミング、Firefox・Safariはメモリにバッファするため1ファイル約200MBまでを推奨）。1回につき最大1,000ファイルです。",
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
    "Relayium은 오픈소스이자 종단간 암호화된 파일 전송 도구입니다. 브라우저 실시간 전송에서는 같은 네트워크일 때 두 기기가 직접 연결되어 파일이 서버를 거치지 않고, 네트워크를 넘을 때는 암호화된 릴레이를 거칩니다(릴레이는 암호문만 봅니다). 설치가 필요 없고, 같은 네트워크에서는 계정도 필요 없습니다(네트워크를 넘는 페어링은 보내는 쪽 로그인만 필요).",
  hero: {
    h1: "종단간 암호화 P2P 파일 전송",
    pitch:
      "브라우저에서 두 기기를 직접 연결하고, 파일은 종단간 암호화되어 청크 단위로 전송됩니다. 같은 네트워크에서는 서버를 전혀 거치지 않고, 네트워크를 넘을 때는 암호화된 릴레이를 거칩니다(릴레이는 암호문만 봅니다). 설치도 가입도 필요 없이 웹 페이지만 열면 시작할 수 있습니다.",
    cta: "전송 시작",
  },
  how: {
    heading: "4단계로 전송",
    steps: [
      "두 기기에서 최신 브라우저로 relayium.com에 접속합니다.",
      "한쪽이 보낼 파일을 선택하거나 끌어다 놓습니다(한 번에 최대 1,000개).",
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
        desc: "같은 네트워크에서 파일은 암호화된 WebRTC 채널을 통해 기기 간에 직접 전달되며 당사 서버를 전혀 거치지 않습니다. 네트워크를 넘을 때는 암호화된 릴레이를 거치지만 릴레이도 암호문만 볼 수 있습니다.",
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
        desc: "AGPL-3.0 라이선스로 프로토콜과 모든 코드가 GitHub에 공개되어 있습니다. 같은 네트워크에서는 실시간 전송에 로그인이 필요 없고, 네트워크를 넘는 페어링 코드 전송은 보내는 쪽만 로그인하면 됩니다.",
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
        a: "무료입니다. Relayium은 AGPL-3.0 라이선스의 오픈소스이며 비용은 전혀 들지 않습니다. 같은 네트워크에서는 실시간 전송에 로그인이 필요 없고, 네트워크를 넘는 페어링 코드 전송은 보내는 쪽만 로그인하면 됩니다 — 받는 쪽은 어느 경우든 계정이 필요 없습니다.",
      },
      {
        q: "파일이 서버에 업로드되나요?",
        a: "같은 네트워크에서의 실시간 직접 전송에서는 파일이 서버를 전혀 거치지 않습니다. 네트워크를 넘을 때는 암호화된 릴레이를 거치지만 릴레이도 암호문만 볼 수 있습니다. 선택적인 다운로드 링크를 쓸 때만 브라우저에서 암호화한 뒤 업로드하며, 서버는 복호화할 수 없는 암호문만 보관하고 키는 링크 안에만 있습니다.",
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
        a: "실시간 직접 전송은 스트리밍 방식이라 실질적인 크기 상한이 없습니다(Chrome·Edge는 디스크로 바로 스트리밍하고, Firefox·Safari는 메모리에 버퍼링하므로 파일당 약 200MB 이하를 권장). 한 번에 최대 1,000개 파일입니다.",
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
    "Relayium ist ein quelloffenes, Ende-zu-Ende-verschlüsseltes Werkzeug zur Dateiübertragung. Bei der Echtzeitübertragung im Browser verbinden sich im selben Netz zwei Geräte direkt und Dateien erreichen nie den Server; netzübergreifend läuft es über einen verschlüsselten Relay, der nur Chiffretext sieht. Ohne Installation; im selben Netz ist kein Konto nötig, für Pairing über Netzwerke hinweg meldet sich nur der Absender an.",
  hero: {
    h1: "Ende-zu-Ende-verschlüsselte P2P-Dateiübertragung",
    pitch:
      "Verbinde zwei Geräte direkt im Browser; Dateien werden Ende-zu-Ende verschlüsselt und Chunk für Chunk übertragen. Im selben Netz erreichen sie nie den Server, netzübergreifend laufen sie über einen verschlüsselten Relay, der nur Chiffretext sieht. Keine Installation, keine Registrierung — einfach die Webseite öffnen und loslegen.",
    cta: "Übertragung starten",
  },
  how: {
    heading: "In vier Schritten übertragen",
    steps: [
      "Öffne relayium.com auf beiden Geräten in einem modernen Browser.",
      "Eine Seite wählt die zu sendenden Dateien aus oder zieht sie hinein (bis zu 1.000 pro Vorgang).",
      "Vergleiche auf beiden Bildschirmen denselben 6-stelligen Prüfcode (SAS) und bestätige die Übereinstimmung, um einen Mittelsmann auszuschließen.",
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
        desc: "Im selben Netz fließen Dateien über einen verschlüsselten WebRTC-Kanal direkt von Gerät zu Gerät und erreichen unsere Server nie; netzübergreifend läuft es über einen verschlüsselten Relay, der ebenfalls nur Chiffretext sieht.",
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
        desc: "AGPL-3.0-Lizenz; Protokoll und der gesamte Code liegen offen auf GitHub. Im selben Netz brauchen Echtzeitübertragungen kein Konto; für Pairing über Netzwerke hinweg meldet sich nur der Absender an.",
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
        a: "Ja. Relayium ist Open Source unter der AGPL-3.0-Lizenz und ohne jede Gebühr nutzbar. Im selben Netz sind Echtzeitübertragungen ohne Anmeldung möglich; für Pairing über Netzwerke hinweg meldet sich nur der Absender an — der Empfänger braucht in beiden Fällen kein Konto.",
      },
      {
        q: "Werden meine Dateien auf einen Server hochgeladen?",
        a: "Im selben Netz erreichen Dateien der Echtzeit-Direktübertragung den Server nie; netzübergreifend laufen sie über einen verschlüsselten Relay, der ebenfalls nur Chiffretext sieht. Nur wenn du den optionalen Download-Link nutzt, verschlüsselt der Browser sie vor dem Hochladen, und der Server behält lediglich Chiffretext, den er nicht entschlüsseln kann — der Schlüssel steckt nur im Link.",
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
        a: "Die Echtzeit-Direktübertragung streamt die Daten, daher gibt es in der Praxis keine harte Größengrenze (Chrome und Edge streamen direkt auf die Festplatte; Firefox und Safari puffern im Speicher, daher werden ca. 200 MB pro Datei empfohlen). Maximal 1.000 Dateien pro Vorgang.",
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
    "Relayium est un outil open source de transfert de fichiers chiffré de bout en bout. Lors d'un transfert en temps réel dans le navigateur, sur le même réseau deux appareils se connectent directement et les fichiers ne passent jamais par le serveur ; entre réseaux différents, cela passe par un relais chiffré qui ne voit que du chiffré. Sans installation ; sur le même réseau aucun compte n'est nécessaire, et pour s'appairer entre réseaux différents, seul l'expéditeur se connecte.",
  hero: {
    h1: "Transfert de fichiers P2P chiffré de bout en bout",
    pitch:
      "Reliez deux appareils directement dans le navigateur ; les fichiers sont chiffrés de bout en bout et transférés bloc par bloc. Sur le même réseau, ils ne passent jamais par le serveur ; entre réseaux différents, ils transitent par un relais chiffré qui ne voit que du chiffré. Aucune installation, aucune inscription — ouvrez la page web et commencez.",
    cta: "Démarrer le transfert",
  },
  how: {
    heading: "Transférer en quatre étapes",
    steps: [
      "Ouvrez relayium.com sur les deux appareils dans un navigateur moderne.",
      "Un côté sélectionne ou glisse les fichiers à envoyer (jusqu'à 1 000 par lot).",
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
        desc: "Sur le même réseau, les fichiers circulent directement d'appareil à appareil via un canal WebRTC chiffré et ne passent jamais par nos serveurs ; entre réseaux différents, ils transitent par un relais chiffré qui, lui aussi, ne voit que du chiffré.",
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
        desc: "Licence AGPL-3.0 ; le protocole et tout le code sont publics sur GitHub. Sur le même réseau, les transferts en temps réel ne nécessitent aucun compte ; pour s'appairer entre réseaux différents, seul l'expéditeur se connecte.",
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
        a: "Oui. Relayium est open source sous licence AGPL-3.0 et s'utilise sans aucun frais. Sur le même réseau, les transferts en temps réel ne demandent aucune connexion ; pour s'appairer entre réseaux différents, seul l'expéditeur doit se connecter — le destinataire n'a jamais besoin de compte.",
      },
      {
        q: "Mes fichiers sont-ils téléversés sur un serveur ?",
        a: "Sur le même réseau, les fichiers du transfert direct en temps réel ne passent jamais par le serveur ; entre réseaux différents, ils transitent par un relais chiffré qui, lui aussi, ne voit que du chiffré. Uniquement si vous utilisez le lien de téléchargement optionnel, le navigateur les chiffre avant l'envoi et le serveur ne conserve que du chiffré qu'il ne peut pas déchiffrer — la clé reste dans le lien.",
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
        a: "Le transfert direct en temps réel diffuse les données en flux, il n'y a donc en pratique aucune limite stricte de taille (Chrome et Edge écrivent directement sur le disque ; Firefox et Safari mettent en mémoire tampon, environ 200 Mo par fichier sont conseillés). Jusqu'à 1 000 fichiers par lot.",
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

const ar = {
  title: "Relayium — نقل ملفات P2P مُشفَّر من الطرف إلى الطرف",
  description:
    "Relayium أداة مفتوحة المصدر لنقل الملفات مُشفَّرة من الطرف إلى الطرف. أثناء النقل الفوري في المتصفح، يتصل جهازان على نفس الشبكة مباشرةً ولا تمر الملفات أبدًا عبر الخادم؛ أما عبر الشبكات المختلفة فتمر عبر مُرحِّل مُشفَّر لا يرى سوى نص مُشفَّر. بدون تثبيت؛ على نفس الشبكة لا حاجة لأي حساب، وللاقتران عبر الشبكات المختلفة يسجّل المُرسِل وحده الدخول.",
  hero: {
    h1: "نقل ملفات من الند للند مُشفَّر من الطرف إلى الطرف",
    pitch:
      "اربط جهازين مباشرةً في المتصفح؛ تُشفَّر الملفات من الطرف إلى الطرف وتُنقل كتلةً كتلة. على نفس الشبكة لا تمر أبدًا عبر الخادم؛ وعبر الشبكات المختلفة تمر عبر مُرحِّل مُشفَّر لا يرى سوى نص مُشفَّر. بدون تثبيت ولا تسجيل — افتح صفحة الويب وابدأ.",
    cta: "ابدأ النقل",
  },
  how: {
    heading: "انقل في أربع خطوات",
    steps: [
      "افتح relayium.com على كلا الجهازين في متصفح حديث.",
      "يختار أحد الطرفين الملفات المراد إرسالها أو يسحبها (حتى 1,000 لكل دفعة).",
      "قارِن على الشاشتين رمز التحقق نفسه المكوّن من 6 أرقام (SAS) وأكّد تطابقه لاستبعاد أي هجوم وسيط.",
      "يُنشأ اتصال مباشر من الند للند؛ تُنقل الملفات كتلةً كتلة مُشفَّرة بـ AES-256-GCM، ويُتحقق من سلامة كل ملف عبر SHA-256.",
    ],
  },
  why: {
    heading: "لماذا Relayium",
    items: [
      {
        title: "التشفير من الطرف إلى الطرف",
        desc: "تبادل مفاتيح X25519 وتشفير AES-256-GCM لكل كتلة؛ تُتفاوض المفاتيح بين الجهازين فقط، ولا يستطيع الخادم فك التشفير.",
      },
      {
        title: "من الند للند حقيقي",
        desc: "على نفس الشبكة تنتقل الملفات مباشرةً من جهاز إلى جهاز عبر قناة WebRTC مُشفَّرة ولا تمر أبدًا عبر خوادمنا؛ وعبر الشبكات المختلفة تمر عبر مُرحِّل مُشفَّر لا يرى هو الآخر سوى نص مُشفَّر.",
      },
      {
        title: "SAS ضد هجوم الوسيط",
        desc: "تعرض الشاشتان رمز التحقق نفسه المكوّن من 6 أرقام؛ فإن تطابق استُبعد أي متنصّت — حتى خادم الإشارة المخترَق لا يستطيع انتحال شخصيتك.",
      },
      {
        title: "متعدد المنصات",
        desc: "Windows وmacOS وLinux وAndroid وiOS — يكفي متصفح حديث، دون الحاجة إلى أي تثبيت.",
      },
      {
        title: "مجاني ومفتوح المصدر",
        desc: "رخصة AGPL-3.0؛ البروتوكول وكامل الشيفرة منشوران علنًا على GitHub. على نفس الشبكة لا يتطلب النقل الفوري أي حساب؛ وللاقتران عبر الشبكات المختلفة يسجّل المُرسِل وحده الدخول.",
      },
    ],
  },
  compare: {
    heading: "بالمقارنة",
    items: [
      {
        title: "مقابل AirDrop",
        body: "AirDrop أصلي وسلس لكنه مقتصر على أجهزة Apple. أما Relayium فمتعدد المنصات — يربط بالمثل ومباشرةً بين Windows أو Android وبين iPhone أو Mac، بمجرد متصفح.",
      },
      {
        title: "مقابل Snapdrop / PairDrop",
        body: "Snapdrop وPairDrop روّاد من النوع نفسه. يضيف Relayium فوقهما تشفيرًا من الطرف إلى الطرف على مستوى التطبيق ورمز تحقق SAS: حتى خادم الإشارة الخبيث لا يستطيع شنّ هجوم وسيط.",
      },
      {
        title: "مقابل WeTransfer / التخزين السحابي",
        body: "WeTransfer والتخزين السحابي غير متزامنة ومريحة، لكن الباقة المجانية غالبًا ما تتوقف عند 2 غيغابايت وتُرفع الملفات إلى خوادمها. أما الوضع الفوري في Relayium فلا حدّ لحجمه ولا يخزّن شيئًا على الخادم.",
      },
    ],
  },
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل هو مجاني؟",
        a: "نعم. Relayium مفتوح المصدر برخصة AGPL-3.0 ويُستخدم دون أي رسوم. على نفس الشبكة لا يتطلب النقل الفوري أي تسجيل دخول؛ وللاقتران عبر الشبكات المختلفة يسجّل المُرسِل وحده الدخول — ولا يحتاج المُستقبِل إلى حساب أبدًا.",
      },
      {
        q: "هل تُرفع ملفاتي إلى خادم؟",
        a: "على نفس الشبكة لا تمر ملفات النقل المباشر الفوري أبدًا عبر الخادم؛ وعبر الشبكات المختلفة تمر عبر مُرحِّل مُشفَّر لا يرى هو الآخر سوى نص مُشفَّر. وفقط إذا استخدمت رابط التنزيل الاختياري، يشفّرها المتصفح قبل الإرسال ولا يحتفظ الخادم إلا بنص مُشفَّر لا يستطيع فك تشفيره — ويبقى المفتاح في الرابط.",
      },
      {
        q: "هل هو مُشفَّر من الطرف إلى الطرف؟",
        a: "نعم. يستخدم تبادل مفاتيح X25519 وتشفير AES-256-GCM لكل كتلة؛ وتُتفاوض المفاتيح بين الجهازين فقط، بحيث لا يستطيع الخادم فك تشفير أي شيء.",
      },
      {
        q: "هل يمكن النقل بين أنظمة مختلفة؟",
        a: "نعم. بمتصفح حديث يمكنك النقل بين Windows وmacOS وLinux وAndroid وiOS، دون تثبيت أي تطبيق.",
      },
      {
        q: "هل هناك حدّ للحجم؟",
        a: "النقل المباشر الفوري يبثّ البيانات دفقًا، لذا لا يوجد عمليًا أي حدّ صارم للحجم (Chrome وEdge يبثّان مباشرةً إلى القرص؛ Firefox وSafari يخزّنان مؤقتًا في الذاكرة، لذا يُنصح بنحو 200 ميغابايت لكل ملف). حتى 1,000 ملف لكل دفعة.",
      },
      {
        q: "ما الفرق عن Snapdrop؟",
        a: "يضيف Relayium تشفيرًا من الطرف إلى الطرف على مستوى التطبيق ورمز تحقق SAS، بحيث لا يستطيع خادم إشارة مخترَق التنصّت ولا الانتحال. كما يدعم النقل عبر الشبكات وروابط تنزيل اختيارية بمعرفة صفرية.",
      },
    ],
  },
  learnHeading: "اعرف المزيد",
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

const es = {
  title: "Relayium — Transferencia de archivos P2P cifrada de extremo a extremo",
  description:
    "Relayium es una herramienta de código abierto para transferir archivos con cifrado de extremo a extremo. En una transferencia en tiempo real dentro del navegador, en la misma red dos dispositivos se conectan directamente y los archivos nunca pasan por el servidor; entre redes distintas, todo va por un retransmisor cifrado que solo ve texto cifrado. Sin instalación; en la misma red no hace falta ninguna cuenta, y para emparejar entre redes distintas solo el remitente inicia sesión.",
  hero: {
    h1: "Transferencia de archivos P2P cifrada de extremo a extremo",
    pitch:
      "Conecta dos dispositivos directamente en el navegador; los archivos se cifran de extremo a extremo y se transfieren bloque a bloque. En la misma red nunca pasan por el servidor; entre redes distintas van por un retransmisor cifrado que solo ve texto cifrado. Sin instalación, sin registro — abre la página web y empieza.",
    cta: "Iniciar transferencia",
  },
  how: {
    heading: "Transferir en cuatro pasos",
    steps: [
      "Abre relayium.com en ambos dispositivos con un navegador moderno.",
      "Un lado selecciona o arrastra los archivos a enviar (hasta 1.000 por lote).",
      "Comparad en las dos pantallas el mismo código de verificación de 6 dígitos (SAS) y confirmad la coincidencia para descartar cualquier intermediario.",
      "Se establece una conexión directa de igual a igual; los archivos se transfieren bloque a bloque, cifrados con AES-256-GCM, y se verifica la integridad de cada archivo mediante SHA-256.",
    ],
  },
  why: {
    heading: "Por qué Relayium",
    items: [
      {
        title: "Cifrado de extremo a extremo",
        desc: "Intercambio de claves X25519 y AES-256-GCM por bloque; las claves se negocian únicamente entre los dos dispositivos y el servidor no puede descifrar.",
      },
      {
        title: "Verdadero de igual a igual",
        desc: "En la misma red, los archivos circulan directamente de dispositivo a dispositivo por un canal WebRTC cifrado y nunca llegan a nuestros servidores; entre redes distintas van por un retransmisor cifrado que, también él, solo ve texto cifrado.",
      },
      {
        title: "SAS contra el ataque de intermediario",
        desc: "Las dos pantallas muestran el mismo código de verificación de 6 dígitos; si coincide, se descarta cualquier interceptor — ni siquiera un servidor de señalización comprometido puede hacerse pasar por ti.",
      },
      {
        title: "Multiplataforma",
        desc: "Windows, macOS, Linux, Android, iOS — basta un navegador moderno, sin necesidad de instalar nada.",
      },
      {
        title: "Gratis y de código abierto",
        desc: "Licencia AGPL-3.0; el protocolo y todo el código son públicos en GitHub. En la misma red, las transferencias en tiempo real no requieren cuenta; para emparejar entre redes distintas solo el remitente inicia sesión.",
      },
    ],
  },
  compare: {
    heading: "En comparación",
    items: [
      {
        title: "Frente a AirDrop",
        body: "AirDrop es nativo y fluido, pero se limita a los dispositivos Apple. Relayium es multiplataforma — conecta igual de directamente Windows o Android con un iPhone o un Mac, con un simple navegador.",
      },
      {
        title: "Frente a Snapdrop / PairDrop",
        body: "Snapdrop y PairDrop son pioneros del mismo tipo. Relayium les añade cifrado de extremo a extremo a nivel de aplicación y un código de verificación SAS: incluso un servidor de señalización malicioso no puede montar un ataque de intermediario.",
      },
      {
        title: "Frente a WeTransfer / almacenamiento en la nube",
        body: "WeTransfer y el almacenamiento en la nube son asíncronos y cómodos, pero el plan gratuito suele toparse en 2 GB y los archivos se suben a sus servidores. El modo en tiempo real de Relayium no tiene límite de tamaño y no almacena nada en el servidor.",
      },
    ],
  },
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Es gratis?",
        a: "Sí. Relayium es de código abierto bajo licencia AGPL-3.0 y se usa sin coste alguno. En la misma red, las transferencias en tiempo real no requieren iniciar sesión; para emparejar entre redes distintas solo el remitente debe iniciar sesión — el destinatario nunca necesita cuenta.",
      },
      {
        q: "¿Se suben mis archivos a un servidor?",
        a: "En la misma red, los archivos de la transferencia directa en tiempo real nunca pasan por el servidor; entre redes distintas van por un retransmisor cifrado que, también él, solo ve texto cifrado. Solo si usas el enlace de descarga opcional, el navegador los cifra antes de subirlos y el servidor conserva únicamente texto cifrado que no puede descifrar — la clave queda en el enlace.",
      },
      {
        q: "¿Es cifrado de extremo a extremo?",
        a: "Sí. Usa intercambio de claves X25519 y cifrado AES-256-GCM por bloque; las claves se negocian únicamente entre los dos dispositivos, de modo que el servidor no puede descifrar nada.",
      },
      {
        q: "¿Se puede transferir entre sistemas distintos?",
        a: "Sí. Con un navegador moderno puedes transferir entre Windows, macOS, Linux, Android e iOS, sin instalar ninguna aplicación.",
      },
      {
        q: "¿Hay un límite de tamaño?",
        a: "La transferencia directa en tiempo real envía los datos en flujo, así que en la práctica no hay un límite estricto de tamaño (Chrome y Edge escriben directamente en el disco; Firefox y Safari almacenan en memoria, por lo que se recomiendan unos 200 MB por archivo). Hasta 1.000 archivos por lote.",
      },
      {
        q: "¿En qué se diferencia de Snapdrop?",
        a: "Relayium añade cifrado de extremo a extremo a nivel de aplicación y un código de verificación SAS, de modo que un servidor de señalización comprometido no puede escuchar ni suplantar. Además admite transferencias entre redes y enlaces de descarga opcionales de conocimiento cero.",
      },
    ],
  },
  learnHeading: "Más información",
  footer: { privacy: "Privacidad", terms: "Términos del servicio", security: "Seguridad" },
};

const pt = {
  title: "Relayium — Transferência de arquivos P2P com criptografia de ponta a ponta",
  description:
    "O Relayium é uma ferramenta de código aberto para transferir arquivos com criptografia de ponta a ponta. Em uma transferência em tempo real no navegador, na mesma rede dois dispositivos se conectam diretamente e os arquivos nunca passam pelo servidor; entre redes diferentes, tudo passa por um retransmissor criptografado que só vê texto cifrado. Sem instalação; na mesma rede não é preciso nenhuma conta, e para emparelhar entre redes diferentes só o remetente faz login.",
  hero: {
    h1: "Transferência de arquivos P2P com criptografia de ponta a ponta",
    pitch:
      "Conecte dois dispositivos diretamente no navegador; os arquivos são criptografados de ponta a ponta e transferidos bloco a bloco. Na mesma rede nunca passam pelo servidor; entre redes diferentes passam por um retransmissor criptografado que só vê texto cifrado. Sem instalação, sem cadastro — abra a página web e comece.",
    cta: "Iniciar transferência",
  },
  how: {
    heading: "Transferir em quatro passos",
    steps: [
      "Abra relayium.com nos dois dispositivos em um navegador moderno.",
      "Um lado seleciona ou arrasta os arquivos a enviar (até 1.000 por lote).",
      "Comparem nas duas telas o mesmo código de verificação de 6 dígitos (SAS) e confirmem a correspondência para descartar qualquer intermediário.",
      "Uma conexão direta ponto a ponto é estabelecida; os arquivos são transferidos bloco a bloco, criptografados com AES-256-GCM, e a integridade de cada arquivo é verificada por SHA-256.",
    ],
  },
  why: {
    heading: "Por que o Relayium",
    items: [
      {
        title: "Criptografia de ponta a ponta",
        desc: "Troca de chaves X25519 e AES-256-GCM por bloco; as chaves são negociadas apenas entre os dois dispositivos e o servidor não consegue descriptografar.",
      },
      {
        title: "Verdadeiramente ponto a ponto",
        desc: "Na mesma rede, os arquivos circulam diretamente de dispositivo a dispositivo por um canal WebRTC criptografado e nunca chegam aos nossos servidores; entre redes diferentes passam por um retransmissor criptografado que, também ele, só vê texto cifrado.",
      },
      {
        title: "SAS contra o ataque de intermediário",
        desc: "As duas telas mostram o mesmo código de verificação de 6 dígitos; se coincidir, qualquer interceptador é descartado — nem mesmo um servidor de sinalização comprometido consegue se passar por você.",
      },
      {
        title: "Multiplataforma",
        desc: "Windows, macOS, Linux, Android, iOS — basta um navegador moderno, sem precisar instalar nada.",
      },
      {
        title: "Gratuito e de código aberto",
        desc: "Licença AGPL-3.0; o protocolo e todo o código são públicos no GitHub. Na mesma rede, as transferências em tempo real não exigem conta; para emparelhar entre redes diferentes só o remetente faz login.",
      },
    ],
  },
  compare: {
    heading: "Em comparação",
    items: [
      {
        title: "Comparado ao AirDrop",
        body: "O AirDrop é nativo e fluido, mas restrito aos dispositivos Apple. O Relayium é multiplataforma — conecta igualmente direto Windows ou Android a um iPhone ou um Mac, com um simples navegador.",
      },
      {
        title: "Comparado ao Snapdrop / PairDrop",
        body: "Snapdrop e PairDrop são pioneiros do mesmo tipo. O Relayium acrescenta a eles criptografia de ponta a ponta na camada de aplicação e um código de verificação SAS: mesmo um servidor de sinalização malicioso não consegue montar um ataque de intermediário.",
      },
      {
        title: "Comparado ao WeTransfer / armazenamento na nuvem",
        body: "WeTransfer e o armazenamento na nuvem são assíncronos e práticos, mas o plano gratuito costuma parar em 2 GB e os arquivos são enviados aos servidores deles. O modo em tempo real do Relayium não tem limite de tamanho e não armazena nada no servidor.",
      },
    ],
  },
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "É gratuito?",
        a: "Sim. O Relayium é de código aberto sob licença AGPL-3.0 e é usado sem custo algum. Na mesma rede, as transferências em tempo real não exigem login; para emparelhar entre redes diferentes só o remetente precisa fazer login — o destinatário nunca precisa de conta.",
      },
      {
        q: "Meus arquivos são enviados para um servidor?",
        a: "Na mesma rede, os arquivos da transferência direta em tempo real nunca passam pelo servidor; entre redes diferentes passam por um retransmissor criptografado que, também ele, só vê texto cifrado. Apenas se você usar o link de download opcional, o navegador os criptografa antes de enviar e o servidor guarda somente texto cifrado que não consegue descriptografar — a chave fica no link.",
      },
      {
        q: "É criptografia de ponta a ponta?",
        a: "Sim. Usa troca de chaves X25519 e criptografia AES-256-GCM por bloco; as chaves são negociadas apenas entre os dois dispositivos, de modo que o servidor não consegue descriptografar nada.",
      },
      {
        q: "Dá para transferir entre sistemas diferentes?",
        a: "Sim. Com um navegador moderno você pode transferir entre Windows, macOS, Linux, Android e iOS, sem instalar nenhum aplicativo.",
      },
      {
        q: "Há um limite de tamanho?",
        a: "A transferência direta em tempo real envia os dados em fluxo, então na prática não há um limite rígido de tamanho (Chrome e Edge gravam direto no disco; Firefox e Safari armazenam em memória, por isso recomendam-se cerca de 200 MB por arquivo). Até 1.000 arquivos por lote.",
      },
      {
        q: "Qual a diferença em relação ao Snapdrop?",
        a: "O Relayium acrescenta criptografia de ponta a ponta na camada de aplicação e um código de verificação SAS, de modo que um servidor de sinalização comprometido não consegue espionar nem se passar por outro. Além disso, oferece transferências entre redes e links de download opcionais de conhecimento zero.",
      },
    ],
  },
  learnHeading: "Saiba mais",
  footer: { privacy: "Privacidade", terms: "Termos de Serviço", security: "Segurança" },
};

export default {
  updated: "2026-07-03",
  langs: { zh, ja, ko, de, fr, ar, es, pt },
};
