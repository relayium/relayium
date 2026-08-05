// web/scripts/pages/content/landing.mjs — localized copy for the static landing
// pages at /<lang>/. English is the SPA at "/", so only these eight langs are here.
// Terminology mirrors src/lib/i18n.svelte.ts for consistency.

const zh = {
  title: "Relayium — 端到端加密的点对点文件与文本传输",
  description: "Relayium 是开源、无需安装的端到端加密文件与文本传输工具。文件在同一网络内直接传输；跨网络浏览器会按设计使用 TURN 中继，而中继只见端到端加密的密文。临时文本要求双方同时在线；Relayium 服务器不保存消息正文或服务端历史，但浏览器或接收端可以复制或留存文本。同一网络无需账号；创建跨网络配对码需登录，持码加入无需账号。",
  hero: {
    h1: "端到端加密的点对点文件与文本传输",
    pitch: "Relayium 是开源、无需安装的端到端加密文件与文本传输工具。文件在同一网络内直接传输；跨网络浏览器会按设计使用 TURN 中继，而中继只见端到端加密的密文。临时文本要求双方同时在线；Relayium 服务器不保存消息正文或服务端历史，但浏览器或接收端可以复制或留存文本。同一网络无需账号；创建跨网络配对码需登录，持码加入无需账号。",
    cta: "开始传输",
  },
  how: {
    heading: "四步完成一次传输",
    steps: [
      "两台设备用现代浏览器打开 relayium.com。",
      "一方选择或拖入要发送的文件（每批最多 1,000 个）；也可以改为发送一条文本消息。",
      "可选：打开「高级验证」后，双方屏幕会显示同一段 6 位校验码（SAS），再通过带外渠道核对。它默认关闭，而加密、承诺-揭示握手和完整性校验无论开关都照常运行。一致的校验码可检测 X25519 端点公钥是否被替换，或信令服务器是否冒充端点并终止应用层端到端加密；它不证明网络路径中没有服务器或 TURN 中继。",
      "文件逐块经 AES-256-GCM 加密传输，并以 SHA-256 校验完整性；临时文本使用独立的端到端加密会话。双方须同时在线，Relayium 服务器不保存消息正文或服务端历史，但端点可以留存文本。",
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
        title: "可选的 SAS 防中间人核对",
        desc: "打开「高级验证」（默认关闭）后，两边屏幕会显示同一段 6 位校验码；通过带外渠道核对它，可检测 X25519 端点公钥替换，或信令服务器冒充端点并终止应用层端到端加密。SAS 验证端点，不证明网络路径中没有服务器或 TURN 中继。",
      },
      {
        title: "临时加密文本",
        desc: "双方同时在线时，可发送链接、命令或多行代码。每条消息最多 65,536 字节（UTF-8）；Relayium 服务器不保存消息正文或服务端历史，但浏览器或接收端可以复制或留存文本。没有离线投递，更大的内容请作为文件发送。",
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
        body: "Snapdrop 与 PairDrop 是同类先驱。Relayium 在其基础上增加了应用层端到端加密与 SAS 校验码；经带外核对后，SAS 可检测 X25519 端点公钥替换，或恶意信令服务器冒充端点并终止应用层端到端加密，但不证明网络路径中没有服务器或 TURN 中继。",
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
        a: "实时传输采用流式传输，Relayium 本身不设硬性大小上限（桌面版 Chrome、Edge 直接流式落盘；Firefox、Safari 以及所有手机浏览器只能把文件攒在内存里，因此超过约 256 MB 时页面会先给出提示——这是一个刻意保守的估计值，不是实测出来的硬上限）。每批最多 1,000 个文件。",
      },
      {
        q: "能发文字，而不只是文件吗？",
        a: "双方同时在线时，可发送链接、命令或多行代码。每条消息最多 65,536 字节（UTF-8）；Relayium 服务器不保存消息正文或服务端历史，但浏览器或接收端可以复制或留存文本。没有离线投递，更大的内容请作为文件发送。",
      },
      {
        q: "和 Snapdrop 有什么区别？",
        a: "Relayium 在同类思路上增加了应用层端到端加密与 SAS 校验码。经带外核对后，SAS 可检测 X25519 端点公钥替换，或被入侵的信令服务器冒充端点并终止应用层端到端加密；它不证明网络路径中没有服务器或 TURN 中继。Relayium 还支持跨网络传输与可选的零知识下载链接。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "Relayium — エンドツーエンド暗号化のP2Pファイル・テキスト転送",
  description: "Relayiumはオープンソースでインストール不要の、エンドツーエンド暗号化されたファイル・テキスト転送ツールです。同じネットワークではファイルを直接転送し、ネットワークをまたぐブラウザは設計どおりTURNリレーを使います。リレーが見るのはエンドツーエンド暗号化された暗号文だけです。一時テキストは両端末がオンラインである必要があり、Relayiumサーバーは本文やサーバー側履歴を保存しませんが、ブラウザや受信端末はテキストをコピー・保持できます。同じネットワークではアカウント不要です。ネットワークをまたぐペアリングコードの作成にはサインインが必要ですが、コードでの参加には不要です。",
  hero: {
    h1: "エンドツーエンド暗号化のP2Pファイル・テキスト転送",
    pitch: "Relayiumはオープンソースでインストール不要の、エンドツーエンド暗号化されたファイル・テキスト転送ツールです。同じネットワークではファイルを直接転送し、ネットワークをまたぐブラウザは設計どおりTURNリレーを使います。リレーが見るのはエンドツーエンド暗号化された暗号文だけです。一時テキストは両端末がオンラインである必要があり、Relayiumサーバーは本文やサーバー側履歴を保存しませんが、ブラウザや受信端末はテキストをコピー・保持できます。同じネットワークではアカウント不要です。ネットワークをまたぐペアリングコードの作成にはサインインが必要ですが、コードでの参加には不要です。",
    cta: "転送を始める",
  },
  how: {
    heading: "4ステップで転送",
    steps: [
      "2台の端末でモダンブラウザから relayium.com を開きます。",
      "片方が送るファイルを選ぶかドラッグします（1回につき最大1,000個）。テキストメッセージを送ることもできます。",
      "任意：「高度な検証」をオンにすると両方の画面に同じ6桁の検証コード（SAS）が表示され、別の通信手段で照合できます。既定はオフで、暗号化・コミット後開示ハンドシェイク・完全性検証はオンオフに関わらず常に動作します。一致すれば、X25519エンドポイント公開鍵の差し替えや、シグナリングサーバーがエンドポイントになりすましてアプリケーション層のエンドツーエンド暗号化を終端する試みを検出できます。ネットワーク経路にサーバーやTURNリレーがないことを証明するものではありません。",
      "ファイルはAES-256-GCMでチャンクごとに暗号化し、SHA-256で完全性を検証します。一時テキストは独立したエンドツーエンド暗号化セッションを使います。両端末がオンラインで、サーバーは本文や履歴を保存しませんが、端末は保持できます。",
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
        title: "任意のSAS中間者攻撃チェック",
        desc: "「高度な検証」（既定はオフ）をオンにすると両画面に6桁のコードが表示され、別の通信手段で照合すると、X25519エンドポイント公開鍵の差し替えや、シグナリングサーバーによるエンドポイントのなりすましとアプリケーション層E2EEの終端を検出できます。SASはエンドポイントを認証するもので、経路上にサーバーやTURNリレーがないことの証明ではありません。",
      },
      {
        title: "一時的な暗号化テキスト",
        desc: "両端末がオンラインの間、リンク、コマンド、複数行コードを送れます。1件最大65,536バイト（UTF-8）。Relayiumサーバーは本文やサーバー側履歴を保存しませんが、ブラウザや受信端末はコピー・保持できます。オフライン配信はなく、より大きい内容はファイルで送ります。",
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
        body: "SnapdropとPairDropは同種の先駆けです。Relayiumはアプリケーション層のエンドツーエンド暗号化とSAS検証コードを追加しています。別の通信手段でSASを照合すれば、X25519エンドポイント公開鍵の差し替えや、悪意あるシグナリングサーバーによるエンドポイントのなりすましとアプリケーション層E2EEの終端を検出できますが、経路上にサーバーやTURNリレーがないことは証明しません。",
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
        a: "リアルタイム転送はストリーミングのため、Relayium 側で決めた硬いサイズ上限はありません（デスクトップ版の Chrome・Edge はディスクへ直接ストリーミング。Firefox・Safari とすべてのモバイルブラウザはメモリ上で組み立てるため、およそ256MBを超えると事前に警告が出ます——これは実測した上限ではなく、意図的に控えめに置いた見積もりです）。1回につき最大1,000ファイルです。",
      },
      {
        q: "ファイルだけでなくテキストも送れますか？",
        a: "両端末がオンラインの間、リンク、コマンド、複数行コードを送れます。1件最大65,536バイト（UTF-8）。Relayiumサーバーは本文やサーバー側履歴を保存しませんが、ブラウザや受信端末はコピー・保持できます。オフライン配信はなく、より大きい内容はファイルで送ります。",
      },
      {
        q: "Snapdropとの違いは？",
        a: "Relayiumはアプリケーション層のエンドツーエンド暗号化とSAS検証コードを追加しています。別の通信手段でSASを照合すれば、X25519エンドポイント公開鍵の差し替えや、侵害されたシグナリングサーバーによるエンドポイントのなりすましとアプリケーション層E2EEの終端を検出できます。SASは経路上にサーバーやTURNリレーがないことを証明しません。さらにネットワークをまたぐ転送や任意のゼロ知識ダウンロードリンクにも対応します。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "Relayium — 종단간 암호화 P2P 파일·텍스트 전송",
  description: "Relayium은 설치가 필요 없는 오픈 소스 종단간 암호화 파일·텍스트 전송 도구입니다. 같은 네트워크에서는 파일이 직접 전송되고, 네트워크를 넘는 브라우저는 설계상 TURN을 사용해 암호문만 중계합니다. 텍스트는 두 기기가 온라인이어야 하며 서버는 본문이나 기록을 저장하지 않지만 기기는 보관할 수 있습니다.",
  hero: {
    h1: "종단간 암호화 P2P 파일·텍스트 전송",
    pitch: "Relayium은 설치가 필요 없는 오픈 소스 종단간 암호화 파일·텍스트 전송 도구입니다. 같은 네트워크에서는 파일이 직접 전송되고, 네트워크를 넘는 브라우저는 설계상 TURN을 사용해 암호문만 중계합니다. 텍스트는 두 기기가 온라인이어야 하며 서버는 본문이나 기록을 저장하지 않지만 기기는 보관할 수 있습니다.",
    cta: "전송 시작",
  },
  how: {
    heading: "4단계로 전송",
    steps: [
      "두 기기에서 최신 브라우저로 relayium.com에 접속합니다.",
      "한쪽이 보낼 파일을 선택하거나 끌어다 놓습니다(한 번에 최대 1,000개). 대신 텍스트 메시지를 보낼 수도 있습니다.",
      "선택 사항: 고급 검증을 켜면 양쪽 화면에 동일한 6자리 검증 코드(SAS)가 표시되며 별도 채널로 대조할 수 있습니다. 기본값은 꺼짐이고, 암호화와 커밋 후 공개 핸드셰이크, 무결성 검증은 켜든 끄든 항상 동작합니다. 코드가 일치하면 X25519 끝점 공개 키 교체나 시그널링 서버가 끝점을 사칭해 애플리케이션 계층 종단간 암호화를 종료하려는 시도를 탐지할 수 있습니다. 네트워크 경로에 서버나 TURN 릴레이가 없음을 증명하지는 않습니다.",
      "파일은 AES-256-GCM으로 암호화하고 SHA-256으로 확인합니다. 텍스트는 별도 암호화 세션을 사용하며 두 기기가 온라인이어야 합니다. 서버는 본문이나 기록을 저장하지 않지만 기기는 보관할 수 있습니다.",
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
        title: "선택적 SAS 중간자 공격 확인",
        desc: "고급 검증(기본값 꺼짐)을 켜면 양쪽 화면에 6자리 코드가 표시되고, 이를 별도 채널로 대조하면 X25519 끝점 공개 키 교체나 시그널링 서버의 끝점 사칭 및 애플리케이션 계층 종단간 암호화 종료를 탐지할 수 있습니다. SAS는 끝점을 인증하며 네트워크 경로에 서버나 TURN 릴레이가 없음을 증명하지 않습니다.",
      },
      {
        title: "일회성 암호화 텍스트",
        desc: "두 기기가 온라인인 동안 최대 65,536바이트(UTF-8)의 텍스트를 보냅니다. 서버는 본문이나 기록을 저장하지 않지만 브라우저나 수신 기기는 복사·보관할 수 있습니다. 오프라인 전달은 없습니다.",
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
        body: "Snapdrop과 PairDrop은 같은 부류의 선구자입니다. Relayium은 애플리케이션 계층 종단간 암호화와 SAS 검증 코드를 더했습니다. 별도 채널로 SAS를 대조하면 X25519 끝점 공개 키 교체나 악의적인 시그널링 서버의 끝점 사칭 및 애플리케이션 계층 종단간 암호화 종료를 탐지할 수 있지만, 네트워크 경로에 서버나 TURN 릴레이가 없음을 증명하지는 않습니다.",
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
        a: "실시간 전송은 스트리밍 방식이라 Relayium이 정한 크기 상한은 없습니다(데스크톱 Chrome·Edge는 디스크로 바로 스트리밍하고, Firefox·Safari와 모든 모바일 브라우저는 파일을 메모리에서 조립하므로 약 256MB를 넘으면 미리 경고가 표시됩니다 — 실측한 한계가 아니라 일부러 보수적으로 잡은 추정값입니다). 한 번에 최대 1,000개 파일입니다.",
      },
      {
        q: "파일 말고 텍스트도 보낼 수 있나요?",
        a: "두 기기가 온라인인 동안 최대 65,536바이트(UTF-8)의 텍스트를 보냅니다. 서버는 본문이나 기록을 저장하지 않지만 브라우저나 수신 기기는 복사·보관할 수 있습니다. 오프라인 전달은 없습니다.",
      },
      {
        q: "Snapdrop과 무엇이 다른가요?",
        a: "Relayium은 애플리케이션 계층 종단간 암호화와 SAS 검증 코드를 추가합니다. 별도 채널로 SAS를 대조하면 X25519 끝점 공개 키 교체나 침해된 시그널링 서버의 끝점 사칭 및 애플리케이션 계층 종단간 암호화 종료를 탐지할 수 있습니다. SAS는 네트워크 경로에 서버나 TURN 릴레이가 없음을 증명하지 않습니다. 또한 네트워크를 넘는 전송과 선택적 영지식 다운로드 링크도 지원합니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Relayium — Ende-zu-Ende-verschlüsselte P2P-Datei- und Textübertragung",
  description: "Relayium ist quelloffen und installationsfrei. Dateien laufen im selben Netz direkt; netzwerkübergreifende Browser nutzen TURN bewusst und das Relay sieht nur Chiffretext. Text verlangt beide Geräte online. Server speichern weder Nachrichtentexte noch Verlauf, Endgeräte können Text behalten.",
  hero: {
    h1: "Ende-zu-Ende-verschlüsselte P2P-Datei- und Textübertragung",
    pitch: "Relayium ist quelloffen und installationsfrei. Dateien laufen im selben Netz direkt; netzwerkübergreifende Browser nutzen TURN bewusst und das Relay sieht nur Chiffretext. Text verlangt beide Geräte online. Server speichern weder Nachrichtentexte noch Verlauf, Endgeräte können Text behalten.",
    cta: "Übertragung starten",
  },
  how: {
    heading: "In vier Schritten übertragen",
    steps: [
      "Öffne relayium.com auf beiden Geräten in einem modernen Browser.",
      "Eine Seite wählt die zu sendenden Dateien aus oder zieht sie hinein (bis zu 1.000 pro Vorgang) — oder schickt stattdessen eine Textnachricht.",
      "Optional: Schalte die erweiterte Verifizierung ein, dann zeigen beide Bildschirme denselben 6-stelligen Verifizierungscode (SAS), den du über einen unabhängigen Kanal vergleichen kannst. Standardmäßig ist sie aus; Verschlüsselung, Commit-dann-Offenlegen-Handshake und Integritätsprüfung laufen so oder so. Eine Übereinstimmung erkennt ausgetauschte öffentliche X25519-Endpunktschlüssel oder einen Signalisierungsserver, der einen Endpunkt imitiert und die Ende-zu-Ende-Verschlüsselung der Anwendung beendet; sie beweist nicht, dass der Netzwerkpfad frei von Servern oder TURN-Relays ist.",
      "Dateien werden mit AES-256-GCM verschlüsselt und per SHA-256 geprüft. Text nutzt eine eigene verschlüsselte Sitzung; beide Geräte bleiben online. Server speichern weder Nachrichtentexte noch Verlauf, Endgeräte können Text behalten.",
    ],
  },
  why: {
    heading: "Warum Relayium",
    items: [
      {
        title: "Ende-zu-Ende-verschlüsselt",
        desc: "X25519-Schlüsselaustausch und AES-256-GCM pro Block; die Schlüssel werden ausschließlich zwischen den beiden Geräten ausgehandelt, der Server kann nicht entschlüsseln.",
      },
      {
        title: "Echtes Peer-to-Peer",
        desc: "Im selben Netz fließen Dateien über einen verschlüsselten WebRTC-Kanal direkt von Gerät zu Gerät und erreichen unsere Server nie; netzübergreifend läuft es über ein verschlüsseltes Relay, das ebenfalls nur Chiffretext sieht.",
      },
      {
        title: "Optionale SAS-Prüfung gegen Man-in-the-Middle",
        desc: "Mit eingeschalteter erweiterter Verifizierung (standardmäßig aus) zeigen beide Bildschirme einen 6-stelligen Code; sein Vergleich über einen unabhängigen Kanal erkennt ausgetauschte öffentliche X25519-Endpunktschlüssel oder einen Signalisierungsserver, der einen Endpunkt imitiert und die Ende-zu-Ende-Verschlüsselung der Anwendung beendet. SAS authentifiziert die Endpunkte; es beweist nicht, dass im Netzwerkpfad keine Server oder TURN-Relays liegen.",
      },
      {
        title: "Flüchtiger verschlüsselter Text",
        desc: "Sind beide Geräte online, lassen sich bis zu 65.536 Bytes (UTF-8) pro Nachricht senden. Server speichern weder Nachrichtentexte noch Verlauf, Browser oder Empfänger können Text kopieren oder behalten. Keine Offline-Zustellung.",
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
        body: "Snapdrop und PairDrop sind Vorreiter derselben Art. Relayium ergänzt Ende-zu-Ende-Verschlüsselung auf Anwendungsebene und einen Verifizierungscode (SAS). Über einen unabhängigen Kanal verglichen erkennt SAS ausgetauschte öffentliche X25519-Endpunktschlüssel oder einen bösartigen Signalisierungsserver, der einen Endpunkt imitiert und die Anwendungsverschlüsselung beendet; es beweist nicht, dass der Netzwerkpfad frei von Servern oder TURN-Relays ist.",
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
        a: "Im selben Netz erreichen Dateien der Echtzeit-Direktübertragung den Server nie; netzübergreifend laufen sie über ein verschlüsseltes Relay, das ebenfalls nur Chiffretext sieht. Nur wenn du den optionalen Download-Link nutzt, verschlüsselt der Browser sie vor dem Hochladen, und der Server behält lediglich Chiffretext, den er nicht entschlüsseln kann — der Schlüssel steckt nur im Link.",
      },
      {
        q: "Ist es Ende-zu-Ende-verschlüsselt?",
        a: "Ja. Es nutzt X25519-Schlüsselaustausch und AES-256-GCM pro Block; die Schlüssel werden nur zwischen den beiden Geräten ausgehandelt, sodass der Server nichts entschlüsseln kann.",
      },
      {
        q: "Funktioniert es systemübergreifend?",
        a: "Ja. Mit einem modernen Browser kannst du zwischen Windows, macOS, Linux, Android und iOS übertragen, ganz ohne App-Installation.",
      },
      {
        q: "Gibt es eine Größenbeschränkung?",
        a: "Die Echtzeitübertragung streamt die Daten, daher setzt Relayium keine harte Größengrenze (Chrome und Edge auf dem Desktop streamen direkt auf die Festplatte; Firefox, Safari und alle mobilen Browser setzen die Datei im Arbeitsspeicher zusammen, weshalb ab etwa 256 MB vorab gewarnt wird — ein bewusst konservativer Schätzwert, keine gemessene Obergrenze). Maximal 1.000 Dateien pro Vorgang.",
      },
      {
        q: "Kann ich auch Text schicken, nicht nur Dateien?",
        a: "Sind beide Geräte online, lassen sich bis zu 65.536 Bytes (UTF-8) pro Nachricht senden. Server speichern weder Nachrichtentexte noch Verlauf, Browser oder Empfänger können Text kopieren oder behalten. Keine Offline-Zustellung.",
      },
      {
        q: "Was ist der Unterschied zu Snapdrop?",
        a: "Relayium ergänzt Ende-zu-Ende-Verschlüsselung auf Anwendungsebene und einen Verifizierungscode (SAS). Über einen unabhängigen Kanal verglichen erkennt SAS ausgetauschte öffentliche X25519-Endpunktschlüssel oder einen kompromittierten Signalisierungsserver, der einen Endpunkt imitiert und die Anwendungsverschlüsselung beendet. Es beweist nicht, dass im Netzwerkpfad keine Server oder TURN-Relays liegen. Zudem unterstützt Relayium netzübergreifende Übertragungen und optionale Zero-Knowledge-Download-Links.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Relayium — Transfert P2P de fichiers et de texte chiffré de bout en bout",
  description:
    "Relayium est open source et sans installation. Sur le même réseau, les fichiers passent directement ; entre réseaux, le navigateur utilise TURN par conception et le relais ne voit que du chiffré. Le texte exige les deux appareils en ligne. Relayium ne conserve ni corps de message ni historique serveur, mais les appareils peuvent garder le texte.",
  hero: {
    h1: "Transfert P2P de fichiers et de texte chiffré de bout en bout",
    pitch:
      "Sur le réseau local, les fichiers passent directement ; entre réseaux, TURN transporte uniquement du chiffré. Les deux appareils restent en ligne pour le texte. Relayium ne conserve ni corps de message ni historique serveur, mais le navigateur ou le destinataire peut garder le texte.",
    cta: "Démarrer le transfert",
  },
  how: {
    heading: "Transférer en quatre étapes",
    steps: [
      "Ouvrez relayium.com sur les deux appareils dans un navigateur moderne.",
      "Un côté sélectionne ou glisse les fichiers à envoyer (jusqu'à 1 000 par lot) — ou envoie plutôt un message texte.",
      "Facultatif : activez la vérification avancée et les deux écrans affichent le même code de vérification à 6 chiffres (SAS), que vous pouvez comparer par un canal indépendant. Elle est désactivée par défaut ; le chiffrement, la poignée de main « engagement puis révélation » et le contrôle d'intégrité s'exécutent dans tous les cas. Une correspondance détecte le remplacement des clés publiques X25519 des extrémités, ou un serveur de signalisation qui usurpe une extrémité et termine le chiffrement applicatif de bout en bout ; elle ne prouve pas l'absence de serveur ou de relais TURN sur le chemin réseau.",
      "Les fichiers sont chiffrés en AES-256-GCM et vérifiés par SHA-256. Le texte utilise une session chiffrée distincte ; les deux appareils restent en ligne. Relayium ne conserve ni corps ni historique, mais les appareils peuvent garder le texte.",
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
        title: "Vérification SAS facultative contre l'homme du milieu",
        desc: "Avec la vérification avancée activée (désactivée par défaut), les deux écrans affichent un code à 6 chiffres ; le comparer par un canal indépendant détecte le remplacement des clés publiques X25519 des extrémités, ou un serveur de signalisation qui usurpe une extrémité et termine le chiffrement applicatif de bout en bout. Le SAS authentifie les extrémités ; il ne prouve pas l'absence de serveur ou de relais TURN sur le chemin réseau.",
      },
      {
        title: "Texte chiffré éphémère",
        desc: "Les deux appareils en ligne peuvent échanger jusqu'à 65 536 octets (UTF-8) par message. Relayium ne conserve ni corps ni historique serveur, mais les appareils peuvent garder le texte. Pas de remise hors ligne.",
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
        body: "Snapdrop et PairDrop sont des pionniers du même genre. Relayium ajoute un chiffrement de bout en bout au niveau applicatif et un code de vérification SAS. Comparé par un canal indépendant, le SAS détecte le remplacement des clés publiques X25519 des extrémités, ou un serveur de signalisation malveillant qui usurpe une extrémité et termine ce chiffrement ; il ne prouve pas l'absence de serveur ou de relais TURN sur le chemin réseau.",
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
        a: "Le transfert en temps réel diffuse les données en flux, Relayium n'impose donc aucune limite stricte de taille (Chrome et Edge sur ordinateur écrivent directement sur le disque ; Firefox, Safari et tous les navigateurs mobiles assemblent le fichier en mémoire, d'où un avertissement au-delà d'environ 256 Mo — un repère volontairement prudent, pas une limite mesurée). Jusqu'à 1 000 fichiers par lot.",
      },
      {
        q: "Puis-je envoyer du texte, et pas seulement des fichiers ?",
        a: "Oui. Les deux appareils en ligne peuvent échanger jusqu'à 65 536 octets (UTF-8) par message. Relayium ne conserve ni corps ni historique serveur, mais le destinataire peut garder le texte. Pas de remise hors ligne.",
      },
      {
        q: "Quelle différence avec Snapdrop ?",
        a: "Relayium ajoute un chiffrement de bout en bout au niveau applicatif et un code de vérification SAS. Comparé par un canal indépendant, le SAS détecte le remplacement des clés publiques X25519 des extrémités, ou un serveur de signalisation compromis qui usurpe une extrémité et termine ce chiffrement. Il ne prouve pas l'absence de serveur ou de relais TURN sur le chemin réseau. Relayium prend aussi en charge les transferts inter-réseaux et des liens de téléchargement optionnels à connaissance nulle.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

const ar = {
  title: "‏Relayium — نقل ملفات ونصوص P2P مُشفَّر من الطرف إلى الطرف",
  description:
    "‏Relayium مفتوح المصدر ولا يتطلب تثبيتًا. تنتقل الملفات مباشرةً محليًا؛ وعبر الشبكات يستخدم المتصفح TURN بحكم التصميم ولا يرى المُرحِّل سوى النص المشفَّر. يتطلب النص اتصال الجهازين. لا تحفظ خوادم Relayium أجسام الرسائل أو سجلها، لكن يمكن للطرفين الاحتفاظ بالنص.",
  hero: {
    h1: "نقل ملفات ونصوص من الند للند مُشفَّر من الطرف إلى الطرف",
    pitch:
      "تنتقل الملفات مباشرةً محليًا؛ وعبر الشبكات يحمل TURN نصًا مشفَّرًا فقط. يبقى الجهازان متصلين للنص. لا يحفظ Relayium أجسام الرسائل أو سجلها، لكن يمكن للمتصفح أو المستلم الاحتفاظ بالنص.",
    cta: "ابدأ النقل",
  },
  how: {
    heading: "انقل في أربع خطوات",
    steps: [
      "افتح relayium.com على كلا الجهازين في متصفح حديث.",
      "يختار أحد الطرفين الملفات المراد إرسالها أو يسحبها (حتى 1,000 لكل دفعة)، أو يرسل رسالة نصية بدلًا من ذلك.",
      "اختياري: فعِّل التحقّق المتقدّم لتعرض الشاشتان الرمز نفسه المكوّن من 6 أرقام (SAS)، ثم قارِنه عبر قناة مستقلة. وهو معطَّل افتراضيًا، بينما يعمل التشفير ومصافحة «الالتزام ثم الكشف» وفحص السلامة في الحالتين. يكشف التطابق استبدال مفاتيح X25519 العامة للطرفين، أو انتحال خادم الإشارة لأحد الطرفين وإنهاء التشفير من الطرف إلى الطرف على مستوى التطبيق؛ لكنه لا يثبت خلو مسار الشبكة من الخوادم أو مُرحِّلات TURN.",
      "تُشفَّر الملفات بـ AES-256-GCM وتُفحص بـ SHA-256. يستخدم النص جلسة مشفَّرة مستقلة ويبقى الجهازان متصلين. لا يحفظ Relayium أجسام الرسائل أو سجلها، لكن يمكن للطرفين الاحتفاظ بالنص.",
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
        title: "فحص SAS اختياري ضد هجوم الوسيط",
        desc: "عند تفعيل التحقّق المتقدّم (المعطَّل افتراضيًا) تعرض الشاشتان رمزًا من 6 أرقام، وتكشف مقارنته عبر قناة مستقلة استبدال مفاتيح X25519 العامة للطرفين، أو انتحال خادم الإشارة لأحد الطرفين وإنهاء التشفير من الطرف إلى الطرف على مستوى التطبيق. يصادق SAS على الطرفين، ولا يثبت خلو مسار الشبكة من الخوادم أو مُرحِّلات TURN.",
      },
      {
        title: "نص مُشفَّر عابر",
        desc: "مع اتصال الجهازين، أرسل حتى 65,536 بايت (UTF-8) لكل رسالة. لا يحفظ Relayium أجسام الرسائل أو سجلها، لكن يمكن للطرفين الاحتفاظ بالنص. لا تسليم دون اتصال.",
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
        body: "Snapdrop وPairDrop روّاد من النوع نفسه. يضيف Relayium تشفيرًا من الطرف إلى الطرف على مستوى التطبيق ورمز تحقق SAS. عند مقارنته عبر قناة مستقلة، يكشف SAS استبدال مفاتيح X25519 العامة للطرفين، أو انتحال خادم إشارة خبيث لأحد الطرفين وإنهاء تشفير التطبيق؛ لكنه لا يثبت خلو مسار الشبكة من الخوادم أو مُرحِّلات TURN.",
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
        a: "النقل الفوري يبثّ البيانات دفقًا، لذا لا يفرض Relayium أي حدّ صارم للحجم (Chrome وEdge على سطح المكتب يبثّان مباشرةً إلى القرص؛ أما Firefox وSafari وجميع متصفحات الهاتف فتجمّع الملف في الذاكرة، ولذلك يظهر تحذير عند تجاوز نحو 256 ميغابايت — وهو تقدير متحفّظ عن قصد، لا حدّ مقيس). حتى 1,000 ملف لكل دفعة.",
      },
      {
        q: "هل يمكنني إرسال نص لا ملفات فقط؟",
        a: "نعم. مع اتصال الجهازين، أرسل حتى 65,536 بايت (UTF-8) لكل رسالة. لا يحفظ Relayium أجسام الرسائل أو سجلها، لكن يمكن للمستلم الاحتفاظ بالنص. لا تسليم دون اتصال.",
      },
      {
        q: "ما الفرق عن Snapdrop؟",
        a: "يضيف Relayium تشفيرًا من الطرف إلى الطرف على مستوى التطبيق ورمز تحقق SAS. عند مقارنته عبر قناة مستقلة، يكشف SAS استبدال مفاتيح X25519 العامة للطرفين، أو انتحال خادم إشارة مخترَق لأحد الطرفين وإنهاء تشفير التطبيق. ولا يثبت خلو مسار الشبكة من الخوادم أو مُرحِّلات TURN. كما يدعم Relayium النقل عبر الشبكات وروابط تنزيل اختيارية بمعرفة صفرية.",
      },
    ],
  },
  learnHeading: "اعرف المزيد",
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

const es = {
  title: "Relayium — Transferencia P2P de archivos y texto cifrada de extremo a extremo",
  description:
    "Relayium es de código abierto y no requiere instalación. En la red local los archivos van directos; entre redes el navegador usa TURN por diseño y el retransmisor solo ve datos cifrados. El texto exige ambos dispositivos conectados. Relayium no guarda cuerpos ni historial, pero los extremos pueden conservar texto.",
  hero: {
    h1: "Transferencia P2P de archivos y texto cifrada de extremo a extremo",
    pitch:
      "En la red local los archivos van directos; entre redes TURN lleva solo datos cifrados. Ambos dispositivos siguen conectados para el texto. Relayium no guarda cuerpos ni historial, pero el navegador o destinatario puede conservarlo.",
    cta: "Iniciar transferencia",
  },
  how: {
    heading: "Transferir en cuatro pasos",
    steps: [
      "Abre relayium.com en ambos dispositivos con un navegador moderno.",
      "Un lado selecciona o arrastra los archivos a enviar (hasta 1.000 por lote), o envía un mensaje de texto en su lugar.",
      "Opcional: activa la verificación avanzada y ambas pantallas mostrarán el mismo código de verificación de 6 dígitos (SAS), que puedes comparar por un canal independiente. Está desactivada por omisión; el cifrado, el handshake de compromiso y revelación y la comprobación de integridad se ejecutan igualmente. Una coincidencia detecta la sustitución de claves públicas X25519 de los extremos, o que el servidor de señalización suplante un extremo y termine el cifrado de extremo a extremo de la aplicación; no demuestra que no haya servidores o relés TURN en la ruta de red.",
      "Los archivos se cifran con AES-256-GCM y se verifican con SHA-256. El texto usa una sesión cifrada independiente y ambos dispositivos siguen conectados. Relayium no guarda cuerpos ni historial, pero los extremos pueden conservarlo.",
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
        title: "Comprobación SAS opcional contra el intermediario",
        desc: "Con la verificación avanzada activada (desactivada por omisión), ambas pantallas muestran un código de 6 dígitos; compararlo por un canal independiente detecta la sustitución de claves públicas X25519 de los extremos, o que el servidor de señalización suplante un extremo y termine el cifrado de extremo a extremo de la aplicación. El SAS autentica los extremos; no demuestra que no haya servidores o relés TURN en la ruta de red.",
      },
      {
        title: "Texto cifrado efímero",
        desc: "Con ambos dispositivos conectados, envía hasta 65.536 bytes (UTF-8) por mensaje. Relayium no guarda cuerpos ni historial, pero los extremos pueden conservar texto. No hay entrega sin conexión.",
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
        body: "Snapdrop y PairDrop son pioneros del mismo tipo. Relayium añade cifrado de extremo a extremo a nivel de aplicación y un código de verificación SAS. Comparado por un canal independiente, el SAS detecta la sustitución de claves públicas X25519 de los extremos, o que un servidor de señalización malicioso suplante un extremo y termine el cifrado de la aplicación; no demuestra que no haya servidores o relés TURN en la ruta de red.",
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
        a: "La transferencia en tiempo real envía los datos en flujo, así que Relayium no impone ningún límite estricto de tamaño (Chrome y Edge de escritorio escriben directamente en el disco; Firefox, Safari y todos los navegadores móviles ensamblan el archivo en memoria, por lo que se avisa a partir de unos 256 MB — una estimación deliberadamente conservadora, no un límite medido). Hasta 1.000 archivos por lote.",
      },
      {
        q: "¿Puedo enviar texto y no solo archivos?",
        a: "Sí. Con ambos dispositivos conectados, envía hasta 65.536 bytes (UTF-8) por mensaje. Relayium no guarda cuerpos ni historial, pero el destinatario puede conservar texto. No hay entrega sin conexión.",
      },
      {
        q: "¿En qué se diferencia de Snapdrop?",
        a: "Relayium añade cifrado de extremo a extremo a nivel de aplicación y un código de verificación SAS. Comparado por un canal independiente, el SAS detecta la sustitución de claves públicas X25519 de los extremos, o que un servidor de señalización comprometido suplante un extremo y termine el cifrado de la aplicación. No demuestra que no haya servidores o relés TURN en la ruta de red. Relayium también admite transferencias entre redes y enlaces de descarga opcionales de conocimiento cero.",
      },
    ],
  },
  learnHeading: "Más información",
  footer: { privacy: "Privacidad", terms: "Términos del servicio", security: "Seguridad" },
};

const pt = {
  title: "Relayium — Transferência P2P de arquivos e texto com criptografia de ponta a ponta",
  description:
    "O Relayium é uma ferramenta de código aberto, sem instalação, para transferir arquivos e texto com criptografia de ponta a ponta. Na mesma rede os arquivos vão direto; entre redes o navegador usa TURN por projeto e o retransmissor só vê dados cifrados. O texto exige os dois dispositivos online. O Relayium não guarda corpo nem histórico no servidor, mas as pontas podem reter o texto. Criar um código entre redes exige login; entrar com ele não.",
  hero: {
    h1: "Transferência P2P de arquivos e texto com criptografia de ponta a ponta",
    pitch:
      "Transfira arquivos e texto com criptografia de ponta a ponta e sem instalação. Na mesma rede os arquivos vão direto; entre redes o navegador usa TURN por projeto e o retransmissor só vê dados cifrados. O texto exige os dois dispositivos online; o Relayium não guarda corpo nem histórico no servidor, mas as pontas podem retê-lo.",
    cta: "Iniciar transferência",
  },
  how: {
    heading: "Transferir em quatro passos",
    steps: [
      "Abra relayium.com nos dois dispositivos em um navegador moderno.",
      "Um lado seleciona ou arrasta os arquivos a enviar (até 1.000 por lote), ou envia uma mensagem de texto no lugar.",
      "Opcional: ative a verificação avançada e as duas telas mostrarão o mesmo código de verificação de 6 dígitos (SAS), que você pode comparar por um canal independente. Ela vem desligada; a criptografia, o handshake de compromisso e revelação e a verificação de integridade rodam de qualquer forma. A correspondência detecta a substituição das chaves públicas X25519 das pontas, ou o servidor de sinalização se passando por uma ponta e encerrando a criptografia de ponta a ponta da aplicação; ela não prova que não há servidores ou retransmissores TURN na rota de rede.",
      "Os arquivos são criptografados em blocos com AES-256-GCM e verificados com SHA-256; o texto usa uma sessão criptografada separada. Os dois dispositivos ficam online. O Relayium não guarda corpo nem histórico no servidor, mas as pontas podem reter texto.",
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
        title: "Verificação SAS opcional contra o intermediário",
        desc: "Com a verificação avançada ativada (desligada por padrão), as duas telas mostram um código de 6 dígitos; compará-lo por um canal independente detecta a substituição das chaves públicas X25519 das pontas, ou o servidor de sinalização se passando por uma ponta e encerrando a criptografia de ponta a ponta da aplicação. O SAS autentica as pontas; não prova que não há servidores ou retransmissores TURN na rota de rede.",
      },
      {
        title: "Texto criptografado efêmero",
        desc: "Com os dois dispositivos online, envie links, comandos e código em várias linhas, até 65.536 bytes (UTF-8) por mensagem. O Relayium não guarda corpo nem histórico no servidor, mas o navegador ou destinatário pode copiar ou reter o texto. Não há entrega offline; conteúdos maiores vão como arquivo.",
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
        body: "Snapdrop e PairDrop são pioneiros do mesmo tipo. O Relayium acrescenta criptografia de ponta a ponta na camada de aplicação e um código de verificação SAS. Comparado por um canal independente, o SAS detecta a substituição das chaves públicas X25519 das pontas, ou um servidor de sinalização malicioso se passando por uma ponta e encerrando a criptografia da aplicação; não prova que não há servidores ou retransmissores TURN na rota de rede.",
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
        a: "A transferência em tempo real envia os dados em fluxo, então o Relayium não impõe nenhum limite rígido de tamanho (Chrome e Edge no desktop gravam direto no disco; Firefox, Safari e todos os navegadores móveis montam o arquivo na memória, por isso há um aviso acima de cerca de 256 MB — uma estimativa deliberadamente conservadora, não um limite medido). Até 1.000 arquivos por lote.",
      },
      {
        q: "Dá para enviar texto, não só arquivos?",
        a: "Dá. Com os dois dispositivos online, envie links, comandos e código em várias linhas, até 65.536 bytes (UTF-8) por mensagem. O Relayium não guarda corpo nem histórico no servidor, mas o navegador ou destinatário pode copiar ou reter o texto. Não há entrega offline; para algo maior, envie um arquivo.",
      },
      {
        q: "Qual a diferença em relação ao Snapdrop?",
        a: "O Relayium acrescenta criptografia de ponta a ponta na camada de aplicação e um código de verificação SAS. Comparado por um canal independente, o SAS detecta a substituição das chaves públicas X25519 das pontas, ou um servidor de sinalização comprometido se passando por uma ponta e encerrando a criptografia da aplicação. Não prova que não há servidores ou retransmissores TURN na rota de rede. O Relayium também oferece transferências entre redes e links de download opcionais de conhecimento zero.",
      },
    ],
  },
  learnHeading: "Saiba mais",
  footer: { privacy: "Privacidade", terms: "Termos de Serviço", security: "Segurança" },
};

// Keep the repeated ephemeral-text privacy boundary identical across each
// product-level surface. File-specific copy above remains unchanged.
const TEXT_BOUNDARY = {
  zh: {
    summary: "Relayium 是开源、无需安装的端到端加密文件与文本传输工具。文件在同一网络内直接传输；跨网络浏览器会按设计使用 TURN 中继，而中继只见端到端加密的密文。临时文本要求双方同时在线；Relayium 服务器不保存消息正文或服务端历史，但浏览器或接收端可以复制或留存文本。同一网络无需账号；创建跨网络配对码需登录，持码加入无需账号。",
    step: "文件逐块经 AES-256-GCM 加密传输，并以 SHA-256 校验完整性；临时文本使用独立的端到端加密会话。双方须同时在线，Relayium 服务器不保存消息正文或服务端历史，但端点可以留存文本。",
    detail: "双方同时在线时，可发送链接、命令或多行代码。每条消息最多 65,536 字节（UTF-8）；Relayium 服务器不保存消息正文或服务端历史，但浏览器或接收端可以复制或留存文本。没有离线投递，更大的内容请作为文件发送。",
  },
  ja: {
    summary: "Relayiumはオープンソースでインストール不要の、エンドツーエンド暗号化されたファイル・テキスト転送ツールです。同じネットワークではファイルを直接転送し、ネットワークをまたぐブラウザは設計どおりTURNリレーを使います。リレーが見るのはエンドツーエンド暗号化された暗号文だけです。一時テキストは両端末がオンラインである必要があり、Relayiumサーバーは本文やサーバー側履歴を保存しませんが、ブラウザや受信端末はテキストをコピー・保持できます。同じネットワークではアカウント不要です。ネットワークをまたぐペアリングコードの作成にはサインインが必要ですが、コードでの参加には不要です。",
    step: "ファイルはAES-256-GCMでチャンクごとに暗号化し、SHA-256で完全性を検証します。一時テキストは独立したエンドツーエンド暗号化セッションを使います。両端末がオンラインで、サーバーは本文や履歴を保存しませんが、端末は保持できます。",
    detail: "両端末がオンラインの間、リンク、コマンド、複数行コードを送れます。1件最大65,536バイト（UTF-8）。Relayiumサーバーは本文やサーバー側履歴を保存しませんが、ブラウザや受信端末はコピー・保持できます。オフライン配信はなく、より大きい内容はファイルで送ります。",
  },
  ko: {
    summary: "Relayium은 설치가 필요 없는 오픈 소스 종단간 암호화 파일·텍스트 전송 도구입니다. 같은 네트워크에서는 파일을 직접 전송하고, 네트워크를 넘는 브라우저는 설계상 TURN 릴레이를 사용합니다. 릴레이에는 종단간 암호화된 암호문만 보입니다. 일회성 텍스트는 두 기기가 모두 온라인이어야 하며 Relayium 서버는 메시지 본문이나 서버 측 기록을 저장하지 않지만 브라우저나 수신 기기는 텍스트를 복사·보관할 수 있습니다. 같은 네트워크에서는 계정이 필요 없고, 네트워크 간 페어링 코드 생성에는 로그인이 필요하지만 코드로 참여할 때는 필요 없습니다.",
    step: "파일은 청크별 AES-256-GCM으로 암호화하고 SHA-256으로 무결성을 확인합니다. 일회성 텍스트는 별도의 종단간 암호화 세션을 사용합니다. 두 기기가 온라인이어야 하며 서버는 본문이나 기록을 저장하지 않지만 기기는 보관할 수 있습니다.",
    detail: "두 기기가 온라인인 동안 링크, 명령어, 여러 줄 코드를 보낼 수 있습니다. 메시지 하나는 최대 65,536바이트(UTF-8)입니다. Relayium 서버는 본문이나 서버 측 기록을 저장하지 않지만 브라우저나 수신 기기는 복사·보관할 수 있습니다. 오프라인 전달은 없으며 더 큰 내용은 파일로 보냅니다.",
  },
  de: {
    summary: "Relayium ist ein quelloffenes, installationsfreies Werkzeug für Ende-zu-Ende-verschlüsselte Datei- und Textübertragung. Im selben Netz laufen Dateien direkt; netzwerkübergreifende Browser-Sitzungen nutzen TURN bewusst und das Relay sieht nur Ende-zu-Ende-verschlüsselten Chiffretext. Flüchtiger Text verlangt beide Geräte online. Relayium-Server speichern weder Nachrichtentexte noch serverseitigen Verlauf, Browser oder Empfänger können Text jedoch kopieren oder behalten. Im selben Netz ist kein Konto nötig; das Erstellen eines netzwerkübergreifenden Codes erfordert eine Anmeldung, der Beitritt mit dem Code nicht.",
    step: "Dateien werden blockweise mit AES-256-GCM verschlüsselt und per SHA-256 geprüft; flüchtiger Text nutzt eine eigene Ende-zu-Ende-verschlüsselte Sitzung. Beide Geräte bleiben online. Der Server speichert weder Nachrichtentexte noch Verlauf, Endgeräte können Text behalten.",
    detail: "Sind beide Geräte online, lassen sich Links, Befehle und mehrzeiliger Code senden. Höchstens 65.536 Bytes (UTF-8) pro Nachricht. Relayium-Server speichern weder Nachrichtentexte noch serverseitigen Verlauf, Browser oder Empfänger können Text aber kopieren oder behalten. Keine Offline-Zustellung; Größeres geht als Datei.",
  },
  fr: {
    summary: "Relayium est un outil open source, sans installation, de transfert de fichiers et de texte chiffré de bout en bout. Sur le même réseau, les fichiers passent directement. Entre réseaux, le navigateur utilise TURN par conception et le relais ne voit que du chiffré de bout en bout. Le texte éphémère exige les deux appareils en ligne. Les serveurs Relayium ne conservent ni corps de message ni historique serveur, mais le navigateur ou le destinataire peut copier ou garder le texte. Aucun compte n'est requis sur le même réseau ; créer un code inter-réseaux exige une connexion, le rejoindre avec ce code non.",
    step: "Les fichiers sont chiffrés bloc par bloc en AES-256-GCM et vérifiés par SHA-256 ; le texte éphémère utilise une session chiffrée distincte. Les deux appareils restent en ligne. Le serveur ne conserve ni corps ni historique, mais les appareils peuvent garder le texte.",
    detail: "Avec les deux appareils en ligne, envoyez liens, commandes et code multiligne, jusqu'à 65 536 octets (UTF-8) par message. Les serveurs Relayium ne conservent ni corps de message ni historique serveur, mais le navigateur ou le destinataire peut copier ou garder le texte. Pas de remise hors ligne ; au-delà, envoyez un fichier.",
  },
  ar: {
    summary: "Relayium أداة مفتوحة المصدر ولا تتطلب تثبيتًا لنقل الملفات والنصوص بتشفير من الطرف إلى الطرف. تنتقل الملفات مباشرةً على الشبكة نفسها؛ وعبر الشبكات يستخدم المتصفح TURN بحكم التصميم، ولا يرى المُرحِّل سوى نص مشفَّر من الطرف إلى الطرف. يتطلب النص العابر اتصال الجهازين. لا تحفظ خوادم Relayium أجسام الرسائل أو سجلًا على الخادم، لكن يمكن للمتصفح أو المستلم نسخ النص أو الاحتفاظ به. لا يلزم حساب على الشبكة نفسها؛ يتطلب إنشاء رمز اقتران عبر الشبكات تسجيل الدخول، أما الانضمام بالرمز فلا يتطلب حسابًا.",
    step: "تُشفَّر الملفات كتلةً كتلة بـ AES-256-GCM وتُفحص بـ SHA-256؛ ويستخدم النص العابر جلسة مستقلة مشفَّرة من الطرف إلى الطرف. يبقى الجهازان متصلين. لا يحفظ الخادم أجسام الرسائل أو سجلها، لكن يمكن للطرفين الاحتفاظ بالنص.",
    detail: "حين يكون الجهازان متصلين، أرسِل الروابط والأوامر والشيفرة متعددة الأسطر، حتى 65,536 بايت (UTF-8) لكل رسالة. لا تحفظ خوادم Relayium أجسام الرسائل أو سجلًا على الخادم، لكن يمكن للمتصفح أو المستلم نسخ النص أو الاحتفاظ به. لا تسليم دون اتصال؛ وما زاد يُرسل ملفًا.",
  },
  es: {
    summary: "Relayium es una herramienta de código abierto, sin instalación, para transferir archivos y texto con cifrado de extremo a extremo. En la misma red, los archivos van directos. Entre redes, el navegador usa TURN por diseño y el retransmisor solo ve datos cifrados de extremo a extremo. El texto efímero exige ambos dispositivos conectados. Los servidores de Relayium no guardan cuerpos ni historial, pero el navegador o destinatario puede copiar o conservar el texto. En la misma red no hace falta cuenta; crear un código entre redes exige iniciar sesión, unirse con él no.",
    step: "Los archivos se cifran por bloques con AES-256-GCM y se verifican con SHA-256; el texto efímero usa una sesión cifrada independiente. Ambos dispositivos siguen conectados. El servidor no guarda cuerpos ni historial, pero los extremos pueden conservar el texto.",
    detail: "Con ambos dispositivos conectados, envía enlaces, comandos y código multilínea, hasta 65.536 bytes (UTF-8) por mensaje. Los servidores de Relayium no guardan cuerpos ni historial, pero el navegador o destinatario puede copiar o conservar el texto. No hay entrega sin conexión; lo más grande va como archivo.",
  },
  pt: {
    summary: "O Relayium é uma ferramenta de código aberto, sem instalação, para transferir arquivos e texto com criptografia de ponta a ponta. Na mesma rede, os arquivos vão direto. Entre redes, o navegador usa TURN por projeto e o retransmissor só vê dados criptografados de ponta a ponta. O texto efêmero exige os dois dispositivos online. Os servidores Relayium não guardam corpo nem histórico, mas o navegador ou destinatário pode copiar ou reter o texto. Na mesma rede não é preciso conta; criar um código entre redes exige login, entrar com ele não.",
    step: "Os arquivos são criptografados em blocos com AES-256-GCM e verificados com SHA-256; o texto efêmero usa uma sessão criptografada separada. Os dois dispositivos ficam online. O servidor não guarda corpo nem histórico, mas as pontas podem reter texto.",
    detail: "Com os dois dispositivos online, envie links, comandos e código em várias linhas, até 65.536 bytes (UTF-8) por mensagem. Os servidores Relayium não guardam corpo nem histórico, mas o navegador ou destinatário pode copiar ou reter o texto. Não há entrega offline; conteúdos maiores vão como arquivo.",
  },
};

const landingLangs = { zh, ja, ko, de, fr, ar, es, pt };
for (const [lang, doc] of Object.entries(landingLangs)) {
  const copy = TEXT_BOUNDARY[lang];
  doc.description = copy.summary;
  doc.hero.pitch = copy.summary;
  doc.how.steps[3] = copy.step;
  doc.why.items[3].desc = copy.detail;
  const textFaq = doc.faq.items[5];
  if (!textFaq?.a || !/65(?:,|\.| )536/.test(textFaq.a)) {
    throw new Error(`landing ${lang}: text FAQ moved or lost its byte limit`);
  }
  textFaq.a = copy.detail;
}

export default {
  updated: "2026-07-31",
  langs: landingLangs,
};
