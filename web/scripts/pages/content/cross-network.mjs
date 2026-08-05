// web/scripts/pages/content/cross-network.mjs — localized copy for the static
// /<lang>/cross-network landing pages (mode-template.mjs). English is the SPA
// route (/cross-network), so only the five non-English locales are generated
// here — see build-pages.mjs's buildModePages + gen-pages.mjs wiring.
//
// Terminology mirrors src/lib/i18n/*.ts (pairing code / SAS / relay
// wording) for consistency with the app UI.
//
// The English master is the `en` doc below — a real object, not a comment, so
// the per-route SPA shell (/cross-network etc. serve the app, not a static page)
// can render the same prose for crawlers. buildModePages still generates static
// pages for LANDING_LANGS only; `en` feeds scripts/pages/shells.mjs.

const en = {
  // title/description are byte-identical to titleCross/descCross in
  // src/lib/i18n/en.ts: the SPA rewrites the served <head> on boot, so the shell
  // and the app must agree or the URL has two different <head>s depending on who
  // is looking. shells.test.mjs asserts it.
  title: "Cross-network file and live text transfer — end-to-end encrypted | Relayium",
  description:
    "Send files and live ephemeral text across networks with a 6-digit code. The creator signs in; joining needs no account. TURN carries only end-to-end encrypted ciphertext.",
  hero: {
    h1: "Cross-network files and live text, end-to-end encrypted",
    pitch:
      "Two online devices on different networks pair with a 6-digit code (or its link/QR) to send files or ephemeral text. Browser sessions use Relayium's TURN relay by design, but it only ever sees ciphertext; text message bodies are never stored by Relayium.",
    cta: "Start a transfer",
  },
  how: {
    heading: "A transfer in four steps",
    steps: [
      "One person signs in and mints a 6-digit pairing code for a file or text session (or shares its join link / QR).",
      "The other person opens the link or enters the code — joining with a code needs no account.",
      "Optional (turn on advanced verification): both sides compare the same 6-digit verification code (SAS) out of band — a different value from the pairing code. A match confirms the X25519 endpoint public keys were not substituted, so the signaling service or TURN relay did not impersonate either endpoint or terminate the app-layer E2EE. TURN can still remain in the network path, carrying only ciphertext.",
      "With both devices online, files stream and live text messages move end-to-end encrypted through TURN. Relayium never stores message bodies; one message can contain up to 65,536 UTF-8 bytes.",
    ],
  },
  why: {
    heading: "Why transfer this way",
    items: [
      {
        title: "End-to-end encrypted",
        desc: "X25519 key exchange + per-chunk AES-256-GCM; keys are negotiated only between the two devices, so neither the relay nor the server can decrypt.",
      },
      {
        title: "Optional SAS anti-MITM check",
        desc: "Compare the 6-digit SAS out of band to confirm the X25519 endpoint public keys were not substituted. A match detects a signaling service or TURN relay impersonating an endpoint; it does not prove TURN is absent from the network path, where it carries only ciphertext.",
      },
      {
        title: "Relay sees only ciphertext",
        desc: "Cross-network browser transfers use a fast TURN relay by design for reliable connections across NAT — and it only ever carries ciphertext, never your keys or plaintext.",
      },
      {
        title: "Live, ephemeral text",
        desc: "Both devices must stay online. Relayium stores no message bodies or server-side history; a receiving endpoint can still copy or retain text. Each message supports up to 65,536 UTF-8 bytes.",
      },
      {
        title: "Cross-platform",
        desc: "Windows, macOS, Linux, Android, iOS — any modern browser, nothing to install.",
      },
      {
        title: "Free",
        desc: "Free to use within a monthly relay allowance; the person creating a file or text code signs in, while anyone joining with that code needs no account.",
      },
    ],
  },
  compare: {
    heading: "Compared with the alternatives",
    items: [
      {
        title: "vs AirDrop",
        body: "AirDrop is Apple-only and same-vicinity; Relayium connects Windows, Android, iPhone and Mac across different networks, end-to-end encrypted, with just a browser.",
      },
      {
        title: "vs Snapdrop / PairDrop",
        body: "Those are same-network only; Relayium adds cross-network pairing, app-layer E2E and an out-of-band SAS check for X25519 endpoint-key substitution. A compromised relay or signaling server cannot silently impersonate an endpoint or terminate that encryption; TURN still carries ciphertext in the network path.",
      },
    ],
  },
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do my files or messages go through a server?",
        a: "Cross-network browser sessions use Relayium's TURN relay by design, but files and messages are end-to-end encrypted, so it sees only ciphertext. Relayium does not store text message bodies.",
      },
      {
        q: "Is a code required?",
        a: "Yes: a 6-digit code (or its join link/QR), valid 5 minutes, pairs the two devices across networks. The server mints it uniformly at random from 0-9, so every digit is possible and a leading zero is ordinary — which also means you cannot invent one: only a code the server handed out will pair. It is not the same six digits as the verification code (SAS), which is derived from the two endpoint keys.",
      },
      {
        q: "Do I need an account?",
        a: "The person creating a pairing code for files or text signs in; anyone joining with that code needs no account.",
      },
      {
        q: "Is it end-to-end encrypted?",
        a: "Yes — X25519 + per-chunk AES-256-GCM. Comparing the SAS out of band confirms the endpoint public keys were not substituted, so the signaling service or TURN relay did not impersonate either endpoint or terminate the app-layer E2EE. TURN can still be in the network path, carrying only ciphertext.",
      },
      {
        q: "Can I send text as well as files?",
        a: "Yes. While both devices are online, send live ephemeral text up to 65,536 UTF-8 bytes per message. Relayium stores no message bodies or server-side history, although either endpoint can copy or retain received text.",
      },
    ],
  },
  learnHeading: "Learn more",
  footer: { privacy: "Privacy", terms: "Terms", security: "Security" },
};

const zh = {
  title: "跨网络文件与实时文本传输——端到端加密 | Relayium",
  description:
    "用 6 位数字配对码跨网络传输文件和实时临时文本。双方须同时在线；浏览器会按设计使用仅能看到密文的 TURN 中继。",
  hero: {
    h1: "跨网络传输文件与实时文本，端到端加密",
    pitch:
      "两台在线设备身处不同网络时，可用 6 位数字配对码（或其加入链接/二维码）传输文件或临时文本。浏览器会按设计使用 Relayium 的 TURN 中继，但中继只能看到密文；Relayium 从不存储文本正文。",
    cta: "开始传输",
  },
  how: {
    heading: "四步完成一次传输",
    steps: [
      "一方登录后为文件或文本会话生成一个 6 位数字配对码（也可分享其加入链接/二维码）。",
      "另一方打开链接或输入配对码即可——持码加入无需账号。",
      "可选（打开「高级验证」）：双方通过带外渠道核对同一段 6 位数字校验码（SAS，与配对码是两个不同的值）。一致表示 X25519 端点公钥未被替换，信令服务或 TURN 中继没有冒充任一端点或终止应用层端到端加密；TURN 仍可处于网络路径中，但只承载密文。",
      "双方同时在线时，文件流和实时文本均通过 TURN 端到端加密传输。Relayium 不存储消息正文；每条消息最多 65,536 个 UTF-8 字节。",
    ],
  },
  why: {
    heading: "为什么选择 Relayium",
    items: [
      {
        title: "端到端加密",
        desc: "X25519 密钥交换 + 每块 AES-256-GCM 加密，密钥只在两台设备间协商，中继与服务器均无法解密。",
      },
      {
        title: "可选的 SAS 防中间人核对",
        desc: "通过带外渠道核对 6 位 SAS，可确认 X25519 端点公钥未被替换，并检测信令服务或 TURN 中继冒充端点。它并不证明网络路径中没有 TURN；TURN 仍可能在路径中，但只承载密文。",
      },
      {
        title: "中继只经手密文",
        desc: "跨网络浏览器传输会按设计使用快速 TURN 中继，以在 NAT 环境下可靠连接——中继只经手密文，从不接触你的密钥或明文。",
      },
      {
        title: "实时临时文本",
        desc: "双方必须同时在线。Relayium 不存储消息正文或服务端历史；接收端仍可复制或保留文本。每条消息最多 65,536 个 UTF-8 字节。",
      },
      {
        title: "跨平台",
        desc: "Windows、macOS、Linux、Android、iOS——只要有现代浏览器，无需安装任何 App。",
      },
      {
        title: "免费",
        desc: "在每月中继流量额度内免费使用；创建文件或文本配对码的一方需登录，持码加入的一方无需账号。",
      },
    ],
  },
  compare: {
    heading: "与其他方式相比",
    items: [
      {
        title: "对比 AirDrop",
        body: "AirDrop 仅限 Apple 设备之间使用，且需彼此靠近；Relayium 能让 Windows、Android、iPhone 与 Mac 跨网络端到端加密互传，只需一个浏览器。",
      },
      {
        title: "对比 Snapdrop / PairDrop",
        body: "它们仅限同一网络内使用；Relayium 增加了跨网络配对、应用层端到端加密，以及通过带外 SAS 检测 X25519 端点公钥替换。被入侵的中继或信令服务器无法悄悄冒充端点或终止这层加密；TURN 仍在网络路径中承载密文。",
      },
    ],
  },
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "文件或消息会经过你们的服务器吗？",
        a: "跨网络浏览器会话会按设计使用 Relayium 的 TURN 中继，但文件和消息均为端到端加密，因此中继只能看到密文。Relayium 不存储文本正文。",
      },
      {
        q: "一定要用配对码吗？",
        a: "是的：6 位数字配对码（或其加入链接/二维码）有效期 5 分钟，用于让两台设备跨网络配对。配对码由服务器在 0-9 之间均匀随机签发，每一位数字都可能出现，前导零也是正常的——因此你无法自己编一个：只有服务器发出的码才能完成配对。它与校验码（SAS）不是同一组六位数字：后者由两端的密钥推导而来。",
      },
      {
        q: "需要注册账号吗？",
        a: "创建文件或文本配对码的一方需登录；任何持码加入的人都无需账号。",
      },
      {
        q: "是端到端加密的吗？",
        a: "是——采用 X25519 密钥交换 + 每块 AES-256-GCM 加密。通过带外渠道核对 SAS 可确认端点公钥未被替换，信令服务或 TURN 中继没有冒充任一端点或终止应用层端到端加密；TURN 仍可处于网络路径中，但只承载密文。",
      },
      {
        q: "除了文件，还能发送文本吗？",
        a: "可以。双方在线时，可发送实时临时文本，每条最多 65,536 个 UTF-8 字节。Relayium 不存储消息正文或服务端历史，但任一端点都可复制或保留收到的文本。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "ネットワークをまたぐファイルとライブテキスト転送——エンドツーエンド暗号化 | Relayium",
  description:
    "6 桁の数字ペアリングコードで、異なるネットワーク間のファイルと一時的なライブテキストを転送。両端末がオンラインで、ブラウザは暗号文しか見えないTURNリレーを設計どおり使用します。",
  hero: {
    h1: "ネットワークをまたぐファイルとライブテキスト、エンドツーエンド暗号化",
    pitch:
      "異なるネットワーク上のオンライン端末2台を 6 桁の数字コード（または参加リンク/QR）でペアリングし、ファイルや一時的なテキストを送ります。ブラウザは設計どおりRelayiumのTURNリレーを使いますが、リレーが見るのは暗号文だけで、Relayiumはメッセージ本文を保存しません。",
    cta: "転送を始める",
  },
  how: {
    heading: "4ステップで転送",
    steps: [
      "一方がサインインし、ファイルまたはテキスト用の 6 桁の数字ペアリングコードを発行します（参加リンク/QRの共有も可能）。",
      "もう一方はリンクを開くかコードを入力するだけ——コードでの参加にアカウントは不要です。",
      "任意（「高度な検証」をオンにした場合）：両端で6桁の検証コード（SAS。ペアリングコードとは別の値）を別経路で照合します。一致すればX25519エンドポイント公開鍵が置き換えられておらず、シグナリングサービスやTURNリレーが端末になりすましてアプリ層E2EEを終端していないことを確認できます。TURNはネットワーク経路上に残り、暗号文だけを運ぶ場合があります。",
      "両端末がオンラインの間、ファイルとライブテキストはTURN経由でエンドツーエンド暗号化されます。Relayiumは本文を保存せず、1件は最大65,536 UTF-8バイトです。",
    ],
  },
  why: {
    heading: "Relayiumが選ばれる理由",
    items: [
      {
        title: "エンドツーエンド暗号化",
        desc: "X25519鍵交換とチャンクごとのAES-256-GCM。鍵は2台の端末間だけでネゴシエートされ、リレーもサーバーも復号できません。",
      },
      {
        title: "SASによる任意の中間者攻撃チェック",
        desc: "6桁のSASを別経路で照合し、X25519エンドポイント公開鍵が置き換えられていないことを確認します。シグナリングサービスやTURNリレーによる端末のなりすましを検出しますが、ネットワーク経路にTURNがないことを証明するものではありません。TURNは暗号文だけを運びます。",
      },
      {
        title: "リレーは暗号文しか扱わない",
        desc: "ネットワークをまたぐブラウザ転送は、NAT越しでも確実につながるよう設計どおり高速TURNリレーを使います。リレーが扱うのは暗号文だけで、鍵や平文には触れません。",
      },
      {
        title: "一時的なライブテキスト",
        desc: "両端末がオンラインである必要があります。Relayiumは本文やサーバー側履歴を保存しませんが、受信端末はテキストをコピー・保持できます。1件は最大65,536 UTF-8バイトです。",
      },
      {
        title: "クロスプラットフォーム",
        desc: "Windows・macOS・Linux・Android・iOS——モダンブラウザさえあればインストール不要です。",
      },
      {
        title: "無料",
        desc: "月々の中継トラフィック枠内で無料です。ファイルまたはテキストのコードを作る側はサインインし、コードで参加する側はアカウント不要です。",
      },
    ],
  },
  compare: {
    heading: "他の方法との比較",
    items: [
      {
        title: "AirDropとの比較",
        body: "AirDropはApple製品同士、かつ近接している場合に限られます。RelayiumはブラウザだけでWindows・Android・iPhone・Macをネットワークをまたいでエンドツーエンド暗号化しながらペアリングできます。",
      },
      {
        title: "Snapdrop / PairDropとの比較",
        body: "それらは同一ネットワーク限定です。Relayiumはネットワークをまたぐペアリング、アプリ層E2EE、X25519エンドポイント公開鍵の置換を検出する別経路のSAS照合を備えます。侵害されたリレーやシグナリングサーバーが密かに端末になりすましてE2EEを終端することを防ぎ、TURNは経路上で暗号文だけを運びます。",
      },
    ],
  },
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ファイルやメッセージはRelayiumのサーバーを経由しますか？",
        a: "ネットワークをまたぐブラウザセッションは設計どおりTURNリレーを使いますが、ファイルもメッセージもエンドツーエンド暗号化され、リレーが見るのは暗号文だけです。Relayiumはメッセージ本文を保存しません。",
      },
      {
        q: "コードは必須ですか？",
        a: "はい。6 桁の数字コード（またはその参加リンク/QR）は 5 分間有効で、ネットワークをまたぐ2台の端末をペアリングします。コードはサーバーが 0-9 から一様ランダムに発行するため、どの数字も現れますし先頭が 0 になることもあります。自分で考えて作ることはできず、サーバーが発行したコードだけがペアリングできます。これは検証コード（SAS）の6桁とは別物で、SAS は両端の鍵から導出されます。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "ファイルまたはテキストのペアリングコードを作る側はサインインが必要ですが、コードで参加する側はアカウント不要です。",
      },
      {
        q: "エンドツーエンド暗号化されていますか？",
        a: "はい——X25519鍵交換とチャンクごとのAES-256-GCM暗号化を使います。SASを別経路で照合すると、エンドポイント公開鍵が置き換えられず、シグナリングサービスやTURNリレーが端末になりすましてアプリ層E2EEを終端していないことを確認できます。TURNは経路上に残る場合も暗号文だけを運びます。",
      },
      {
        q: "ファイルだけでなくテキストも送れますか？",
        a: "はい。両端末がオンラインの間、1件最大65,536 UTF-8バイトの一時的なライブテキストを送れます。Relayiumは本文やサーバー側履歴を保存しませんが、各端末は受信テキストをコピー・保持できます。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "네트워크를 넘는 파일 및 실시간 텍스트 전송 — 종단간 암호화 | Relayium",
  description:
    "6자리 숫자 페어링 코드로 서로 다른 네트워크 간 파일과 일시적인 실시간 텍스트를 전송합니다. 두 기기가 온라인이어야 하며 브라우저는 설계상 암호문만 보는 TURN 릴레이를 사용합니다.",
  hero: {
    h1: "네트워크를 넘는 파일과 실시간 텍스트, 종단간 암호화",
    pitch:
      "서로 다른 네트워크의 온라인 기기 두 대를 6자리 숫자 코드(또는 참여 링크/QR)로 연결해 파일이나 일시적인 텍스트를 보냅니다. 브라우저는 설계상 Relayium TURN 릴레이를 사용하지만 릴레이에는 암호문만 보이며, Relayium은 메시지 본문을 저장하지 않습니다.",
    cta: "전송 시작",
  },
  how: {
    heading: "4단계로 전송",
    steps: [
      "한쪽이 로그인해 파일 또는 텍스트 세션용 6자리 숫자 페어링 코드를 생성합니다(참여 링크/QR 공유도 가능).",
      "다른 쪽은 링크를 열거나 코드를 입력합니다 — 코드로 참여할 때는 계정이 필요 없습니다.",
      "선택 사항(«고급 검증»을 켠 경우): 양쪽이 별도 채널로 동일한 6자리 검증 코드(SAS, 페어링 코드와는 다른 값)를 대조합니다. 일치하면 X25519 끝점 공개 키가 바뀌지 않았고 시그널링 서비스나 TURN 릴레이가 어느 끝점도 사칭하거나 애플리케이션 계층 E2EE를 종료하지 않았음을 확인합니다. TURN은 네트워크 경로에 남아 암호문만 운반할 수 있습니다.",
      "두 기기가 온라인인 동안 파일과 실시간 텍스트는 TURN을 통해 종단간 암호화됩니다. Relayium은 메시지 본문을 저장하지 않으며 메시지 하나는 최대 65,536 UTF-8바이트입니다.",
    ],
  },
  why: {
    heading: "Relayium을 선택하는 이유",
    items: [
      {
        title: "종단간 암호화",
        desc: "X25519 키 교환과 청크별 AES-256-GCM. 키는 두 기기 사이에서만 협상되어 릴레이도 서버도 복호화할 수 없습니다.",
      },
      {
        title: "선택적 SAS 중간자 공격 확인",
        desc: "별도 채널로 6자리 SAS를 대조해 X25519 끝점 공개 키가 바뀌지 않았는지 확인합니다. 시그널링 서비스나 TURN 릴레이의 끝점 사칭을 탐지하지만, 네트워크 경로에 TURN이 없다는 뜻은 아닙니다. TURN은 암호문만 운반합니다.",
      },
      {
        title: "릴레이는 암호문만 전달",
        desc: "네트워크를 넘는 브라우저 전송은 NAT에서도 안정적으로 연결되도록 설계상 빠른 TURN 릴레이를 사용합니다. 릴레이는 암호문만 전달하며 키나 평문에는 접근하지 않습니다.",
      },
      {
        title: "일시적인 실시간 텍스트",
        desc: "두 기기가 모두 온라인이어야 합니다. Relayium은 메시지 본문이나 서버 측 기록을 저장하지 않지만 수신 기기는 텍스트를 복사하거나 보관할 수 있습니다. 메시지 하나는 최대 65,536 UTF-8바이트입니다.",
      },
      {
        title: "크로스 플랫폼",
        desc: "Windows, macOS, Linux, Android, iOS — 최신 브라우저만 있으면 설치가 필요 없습니다.",
      },
      {
        title: "무료",
        desc: "월별 릴레이 트래픽 한도 내에서 무료입니다. 파일 또는 텍스트 코드를 만드는 쪽은 로그인하고, 코드로 참여하는 쪽은 계정이 필요 없습니다.",
      },
    ],
  },
  compare: {
    heading: "다른 방식과 비교",
    items: [
      {
        title: "AirDrop과 비교",
        body: "AirDrop은 Apple 기기끼리, 그것도 가까운 거리에서만 가능합니다. Relayium은 브라우저만으로 Windows, Android, iPhone, Mac을 네트워크를 넘어 종단간 암호화로 페어링합니다.",
      },
      {
        title: "Snapdrop / PairDrop과 비교",
        body: "이들은 같은 네트워크에서만 동작합니다. Relayium은 네트워크 간 페어링, 애플리케이션 계층 E2EE, X25519 끝점 공개 키 교체를 탐지하는 별도 채널 SAS 확인을 제공합니다. 침해된 릴레이나 시그널링 서버가 몰래 끝점을 사칭해 E2EE를 종료할 수 없으며, TURN은 경로에서 암호문만 운반합니다.",
      },
    ],
  },
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "파일이나 메시지가 서버를 거치나요?",
        a: "네트워크를 넘는 브라우저 세션은 설계상 TURN 릴레이를 사용하지만 파일과 메시지는 종단간 암호화되어 릴레이에는 암호문만 보입니다. Relayium은 메시지 본문을 저장하지 않습니다.",
      },
      {
        q: "코드가 꼭 필요한가요?",
        a: "네. 6자리 숫자 코드(또는 참여 링크/QR)는 5분간 유효하며 네트워크를 넘는 두 기기를 페어링합니다. 코드는 서버가 0-9에서 균일 무작위로 발급하므로 모든 숫자가 나올 수 있고 앞자리 0도 정상입니다. 그래서 직접 지어낼 수 없고, 서버가 발급한 코드만 페어링됩니다. 이는 검증 코드(SAS)의 여섯 자리와 다른 값이며, SAS는 양쪽 끝점 키에서 도출됩니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "파일 또는 텍스트 페어링 코드를 만드는 쪽은 로그인해야 하지만 코드로 참여하는 쪽은 계정이 필요 없습니다.",
      },
      {
        q: "종단간 암호화인가요?",
        a: "네 — X25519 키 교환과 청크별 AES-256-GCM 암호화를 사용합니다. 별도 채널로 SAS를 대조하면 끝점 공개 키가 바뀌지 않았고 시그널링 서비스나 TURN 릴레이가 어느 끝점도 사칭하거나 애플리케이션 계층 E2EE를 종료하지 않았음을 확인합니다. TURN은 경로에 남아도 암호문만 운반합니다.",
      },
      {
        q: "파일뿐 아니라 텍스트도 보낼 수 있나요?",
        a: "네. 두 기기가 온라인인 동안 메시지 하나당 최대 65,536 UTF-8바이트의 일시적인 실시간 텍스트를 보낼 수 있습니다. Relayium은 본문이나 서버 측 기록을 저장하지 않지만 각 기기는 받은 텍스트를 복사하거나 보관할 수 있습니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Netzwerkübergreifende Datei- und Live-Textübertragung — Ende-zu-Ende-verschlüsselt | Relayium",
  description:
    "Übertrage Dateien und flüchtigen Live-Text mit einem 6-Zeichen-Code zwischen Netzwerken. Beide Geräte bleiben online; Browser nutzen absichtlich ein TURN-Relay, das nur Chiffretext sieht.",
  hero: {
    h1: "Dateien und Live-Text netzwerkübergreifend, Ende-zu-Ende-verschlüsselt",
    pitch:
      "Zwei Online-Geräte in unterschiedlichen Netzwerken koppeln sich per 6-Zeichen-Code (oder Beitrittslink/QR), um Dateien oder flüchtigen Text zu senden. Browser nutzen absichtlich Relayiums TURN-Relay, das nur Chiffretext sieht; Relayium speichert keine Nachrichtentexte.",
    cta: "Übertragung starten",
  },
  how: {
    heading: "In vier Schritten übertragen",
    steps: [
      "Eine Person meldet sich an und erzeugt einen 6-Zeichen-Pairing-Code für Dateien oder Text (oder teilt Beitrittslink/QR).",
      "Die andere öffnet den Link oder gibt den Code ein — zum Beitreten mit Code ist kein Konto nötig.",
      "Optional (erweiterte Verifizierung einschalten): Beide Seiten vergleichen denselben 6-stelligen Verifizierungscode (SAS — nicht den Pairing-Code) über einen unabhängigen Kanal. Eine Übereinstimmung bestätigt, dass die öffentlichen X25519-Endpunktschlüssel nicht ersetzt wurden und weder Signalisierungsdienst noch TURN-Relay einen Endpunkt imitiert oder die E2E-Verschlüsselung der Anwendung terminiert haben. TURN kann weiter im Netzwerkpfad liegen und transportiert dort nur Chiffretext.",
      "Solange beide Geräte online sind, laufen Dateien und Live-Text Ende-zu-Ende-verschlüsselt über TURN. Relayium speichert keine Nachrichtentexte; eine Nachricht umfasst höchstens 65.536 UTF-8-Bytes.",
    ],
  },
  why: {
    heading: "Warum Relayium",
    items: [
      {
        title: "Ende-zu-Ende-verschlüsselt",
        desc: "X25519-Schlüsselaustausch und AES-256-GCM pro Block; die Schlüssel werden ausschließlich zwischen den beiden Geräten ausgehandelt, weder das Relay noch der Server können entschlüsseln.",
      },
      {
        title: "Optionale SAS-Prüfung gegen Man-in-the-Middle",
        desc: "Der Abgleich des 6-stelligen SAS über einen unabhängigen Kanal bestätigt, dass die öffentlichen X25519-Endpunktschlüssel nicht ersetzt wurden. Er erkennt, wenn Signalisierungsdienst oder TURN-Relay einen Endpunkt imitieren, beweist aber nicht, dass TURN im Netzwerkpfad fehlt; dort transportiert es nur Chiffretext.",
      },
      {
        title: "Relay sieht nur Chiffretext",
        desc: "Netzwerkübergreifende Browser-Übertragungen nutzen absichtlich ein schnelles TURN-Relay für zuverlässige NAT-Verbindungen; es transportiert ausschließlich Chiffretext, nie Schlüssel oder Klartext.",
      },
      {
        title: "Flüchtiger Live-Text",
        desc: "Beide Geräte müssen online bleiben. Relayium speichert weder Nachrichtentexte noch serverseitigen Verlauf; ein Endgerät kann empfangenen Text dennoch kopieren oder behalten. Pro Nachricht sind 65.536 UTF-8-Bytes möglich.",
      },
      {
        title: "Plattformübergreifend",
        desc: "Windows, macOS, Linux, Android, iOS — ein moderner Browser genügt, keine Installation nötig.",
      },
      {
        title: "Kostenlos",
        desc: "Kostenlos im monatlichen Relay-Kontingent; wer einen Datei- oder Textcode erstellt, meldet sich an, zum Beitreten mit dem Code ist kein Konto nötig.",
      },
    ],
  },
  compare: {
    heading: "Im Vergleich",
    items: [
      {
        title: "Gegenüber AirDrop",
        body: "AirDrop funktioniert nur zwischen Apple-Geräten und nur in unmittelbarer Nähe; Relayium koppelt Windows, Android, iPhone und Mac netzwerkübergreifend, Ende-zu-Ende-verschlüsselt, mit nur einem Browser.",
      },
      {
        title: "Gegenüber Snapdrop / PairDrop",
        body: "Diese funktionieren nur im selben Netzwerk; Relayium ergänzt netzwerkübergreifendes Koppeln, E2E-Verschlüsselung auf Anwendungsebene und einen SAS-Abgleich über einen unabhängigen Kanal, der ersetzte öffentliche X25519-Endpunktschlüssel erkennt. Ein kompromittiertes Relay oder ein Signalisierungsserver kann so nicht unbemerkt einen Endpunkt imitieren und die E2E-Verschlüsselung terminieren; TURN bleibt mit Chiffretext im Netzwerkpfad.",
      },
    ],
  },
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Laufen meine Dateien oder Nachrichten über euren Server?",
        a: "Netzwerkübergreifende Browser-Sitzungen nutzen absichtlich Relayiums TURN-Relay. Dateien und Nachrichten sind Ende-zu-Ende-verschlüsselt, sodass es nur Chiffretext sieht. Relayium speichert keine Nachrichtentexte.",
      },
      {
        q: "Ist ein Code erforderlich?",
        a: "Ja: Ein 6-stelliger Zifferncode (oder dessen Beitrittslink/QR), 5 Minuten gültig, koppelt die beiden Geräte über Netzwerke hinweg. Der Server erzeugt ihn gleichverteilt zufällig aus 0-9, jede Ziffer kommt vor und eine führende Null ist ganz normal — du kannst dir also keinen ausdenken: nur ein vom Server ausgegebener Code koppelt. Es sind nicht dieselben sechs Ziffern wie beim Verifizierungscode (SAS), der aus den beiden Endpunktschlüsseln abgeleitet wird.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Wer einen Pairing-Code für Dateien oder Text erstellt, meldet sich an; wer mit dem Code beitritt, braucht kein Konto.",
      },
      {
        q: "Ist es Ende-zu-Ende-verschlüsselt?",
        a: "Ja — X25519 plus AES-256-GCM pro Block. Der SAS-Abgleich über einen unabhängigen Kanal bestätigt, dass die öffentlichen Endpunktschlüssel nicht ersetzt wurden und weder Signalisierungsdienst noch TURN-Relay einen Endpunkt imitiert oder die E2E-Verschlüsselung der Anwendung terminiert haben. TURN kann im Netzwerkpfad bleiben und transportiert nur Chiffretext.",
      },
      {
        q: "Kann ich neben Dateien auch Text senden?",
        a: "Ja. Solange beide Geräte online sind, kannst du flüchtigen Live-Text mit bis zu 65.536 UTF-8-Bytes pro Nachricht senden. Relayium speichert weder Nachrichtentexte noch serverseitigen Verlauf; beide Endgeräte können empfangenen Text kopieren oder behalten.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Transfert inter-réseaux de fichiers et de texte en direct — chiffré de bout en bout | Relayium",
  description:
    "Transférez fichiers et texte éphémère en direct entre réseaux avec un code à 6 chiffres. Les deux appareils restent en ligne ; le navigateur utilise volontairement un relais TURN qui ne voit que du chiffré.",
  hero: {
    h1: "Fichiers et texte en direct entre réseaux, chiffrés de bout en bout",
    pitch:
      "Deux appareils en ligne sur des réseaux différents s'appairent avec un code à 6 chiffres (ou son lien/QR) pour envoyer fichiers ou texte éphémère. Le navigateur utilise volontairement le relais TURN de Relayium, qui ne voit que du chiffré ; Relayium ne stocke aucun corps de message.",
    cta: "Démarrer le transfert",
  },
  how: {
    heading: "Transférer en quatre étapes",
    steps: [
      "Une personne se connecte et génère un code à 6 chiffres pour une session de fichiers ou de texte (ou partage son lien/QR).",
      "L'autre ouvre le lien ou saisit le code — rejoindre avec un code ne nécessite aucun compte.",
      "Facultatif (activez la vérification avancée) : les deux parties comparent le même code de vérification (SAS) à 6 chiffres — différent du code d'appairage — par un canal indépendant. S'il correspond, les clés publiques X25519 des terminaux n'ont pas été remplacées : ni le service de signalisation ni le relais TURN n'a usurpé un terminal ou terminé le chiffrement E2E applicatif. TURN peut rester sur le chemin réseau, où il ne transporte que du texte chiffré.",
      "Avec les deux appareils en ligne, fichiers et texte en direct passent par TURN, chiffrés de bout en bout. Relayium ne stocke aucun corps de message ; chacun peut contenir jusqu'à 65 536 octets UTF-8.",
    ],
  },
  why: {
    heading: "Pourquoi Relayium",
    items: [
      {
        title: "Chiffré de bout en bout",
        desc: "Échange de clés X25519 et AES-256-GCM par bloc ; les clés sont négociées uniquement entre les deux appareils, ni le relais ni le serveur ne peuvent donc déchiffrer.",
      },
      {
        title: "Vérification SAS facultative contre l'homme du milieu",
        desc: "Comparez le SAS à 6 chiffres par un canal indépendant pour confirmer que les clés publiques X25519 des terminaux n'ont pas été remplacées. Cela détecte l'usurpation d'un terminal par le service de signalisation ou le relais TURN, sans prouver l'absence de TURN sur le chemin réseau, où il ne transporte que du texte chiffré.",
      },
      {
        title: "Le relais ne voit que du chiffré",
        desc: "Les transferts inter-réseaux dans le navigateur utilisent volontairement un relais TURN rapide pour traverser les NAT ; il ne transporte que du chiffré, jamais vos clés ni du texte en clair.",
      },
      {
        title: "Texte éphémère en direct",
        desc: "Les deux appareils doivent rester en ligne. Relayium ne stocke ni corps de message ni historique serveur ; un appareil peut néanmoins copier ou conserver le texte reçu. Chaque message accepte 65 536 octets UTF-8.",
      },
      {
        title: "Multiplateforme",
        desc: "Windows, macOS, Linux, Android, iOS — un navigateur moderne suffit, rien à installer.",
      },
      {
        title: "Gratuit",
        desc: "Gratuit dans le quota mensuel du relais ; créer un code de fichier ou de texte exige une connexion, mais rejoindre avec ce code ne nécessite aucun compte.",
      },
    ],
  },
  compare: {
    heading: "En comparaison",
    items: [
      {
        title: "Face à AirDrop",
        body: "AirDrop est réservé aux appareils Apple et à la proximité immédiate ; Relayium appaire Windows, Android, iPhone et Mac entre réseaux différents, chiffré de bout en bout, avec un simple navigateur.",
      },
      {
        title: "Face à Snapdrop / PairDrop",
        body: "Ceux-ci ne fonctionnent que sur le même réseau ; Relayium ajoute l'appairage inter-réseaux, le chiffrement E2E applicatif et une comparaison SAS par canal indépendant qui détecte le remplacement des clés publiques X25519 des terminaux. Un relais ou serveur de signalisation compromis ne peut pas usurper silencieusement un terminal et terminer ce chiffrement ; TURN reste sur le chemin avec uniquement du texte chiffré.",
      },
    ],
  },
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Mes fichiers ou messages passent-ils par votre serveur ?",
        a: "Les sessions navigateur inter-réseaux utilisent volontairement le relais TURN de Relayium. Fichiers et messages sont chiffrés de bout en bout : il ne voit que du chiffré. Relayium ne stocke aucun corps de message.",
      },
      {
        q: "Un code est-il obligatoire ?",
        a: "Oui : un code à 6 chiffres (ou son lien d'accès/QR), valable 5 minutes, appaire les deux appareils entre réseaux différents. Le serveur le tire uniformément au hasard entre 0 et 9, tous les chiffres sont possibles et un zéro initial est ordinaire — vous ne pouvez donc pas en inventer un : seul un code délivré par le serveur appaire. Ce ne sont pas les six chiffres du code de vérification (SAS), lequel est dérivé des clés des deux extrémités.",
      },
      {
        q: "Faut-il un compte ?",
        a: "La personne qui crée un code pour fichiers ou texte se connecte ; rejoindre avec ce code ne nécessite aucun compte.",
      },
      {
        q: "Est-ce chiffré de bout en bout ?",
        a: "Oui — X25519 et AES-256-GCM par bloc. Comparer le SAS par un canal indépendant confirme que les clés publiques des terminaux n'ont pas été remplacées et que ni le service de signalisation ni le relais TURN n'a usurpé un terminal ou terminé le chiffrement E2E applicatif. TURN peut rester sur le chemin réseau, avec uniquement du texte chiffré.",
      },
      {
        q: "Puis-je envoyer du texte en plus des fichiers ?",
        a: "Oui. Tant que les deux appareils sont en ligne, envoyez du texte éphémère en direct, jusqu'à 65 536 octets UTF-8 par message. Relayium ne stocke ni corps de message ni historique serveur, mais chaque appareil peut copier ou conserver le texte reçu.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

const ar = {
  title: "نقل الملفات والنص المباشر عبر الشبكات — مُشفَّر من الطرف إلى الطرف | Relayium",
  description:
    "أرسل الملفات والنص المباشر المؤقت بين الشبكات برمز من 6 خانات. يجب بقاء الجهازين متصلين؛ يستخدم المتصفح مُرحِّل TURN عمدًا ولا يرى سوى النص المُشفَّر.",
  hero: {
    h1: "الملفات والنص المباشر عبر الشبكات، مُشفَّران من الطرف إلى الطرف",
    pitch:
      "يقترن جهازان متصلان على شبكتين مختلفتين برمز من 6 خانات (أو رابط/QR) لإرسال ملفات أو نص مؤقت. يستخدم المتصفح مُرحِّل TURN الخاص بـ Relayium عمدًا، لكنه لا يرى سوى النص المُشفَّر؛ ولا يخزن Relayium نصوص الرسائل.",
    cta: "ابدأ النقل",
  },
  how: {
    heading: "انقل في أربع خطوات",
    steps: [
      "يسجّل أحد الطرفين الدخول ويولّد رمزًا من 6 خانات لجلسة ملفات أو نص (أو يشارك رابط الانضمام/QR).",
      "يفتح الطرف الآخر الرابط أو يُدخل الرمز — لا يحتاج الانضمام بالرمز إلى حساب.",
      "اختياري (بتفعيل «التحقّق المتقدّم»): يقارن الطرفان رمز التحقق نفسه المكوّن من 6 أرقام (SAS، وهو غير رمز الاقتران) عبر قناة مستقلة. يؤكد التطابق أن مفاتيح X25519 العامة للطرفين لم تُستبدل، وأن خدمة الإشارة أو مُرحِّل TURN لم تنتحل شخصية أي طرف أو تُنهِ تشفير طبقة التطبيق من الطرف إلى الطرف. وقد يظل TURN ضمن مسار الشبكة، لكنه لا يحمل سوى النص المشفر.",
      "مع اتصال الجهازين، تنتقل الملفات والنصوص المباشرة مشفّرة من الطرف إلى الطرف عبر TURN. لا يخزن Relayium نص الرسالة؛ وحدّ الرسالة 65,536 بايت UTF-8.",
    ],
  },
  why: {
    heading: "لماذا Relayium",
    items: [
      {
        title: "التشفير من الطرف إلى الطرف",
        desc: "تبادل مفاتيح X25519 وتشفير AES-256-GCM لكل كتلة؛ تُتفاوض المفاتيح بين الجهازين فقط، لذا لا يستطيع المُرحِّل ولا الخادم فك التشفير.",
      },
      {
        title: "فحص SAS اختياري ضد هجوم الوسيط",
        desc: "قارن رمز SAS المكوّن من 6 أرقام عبر قناة مستقلة للتأكد من عدم استبدال مفاتيح X25519 العامة للطرفين. يكشف ذلك انتحال خدمة الإشارة أو مُرحِّل TURN لأي طرف، لكنه لا يثبت غياب TURN عن مسار الشبكة؛ فهو لا يحمل هناك سوى النص المشفر.",
      },
      {
        title: "المُرحِّل لا يرى سوى نص مُشفَّر",
        desc: "تستخدم عمليات المتصفح عبر الشبكات مُرحِّل TURN سريعًا عمدًا للاتصال الموثوق عبر NAT؛ ولا ينقل إلا نصًا مُشفَّرًا، لا المفاتيح ولا النص الصريح.",
      },
      {
        title: "نص مباشر ومؤقت",
        desc: "يجب أن يبقى الجهازان متصلين. لا يخزن Relayium نصوص الرسائل أو سجلًا على الخادم، لكن جهاز الاستقبال يستطيع نسخ النص أو الاحتفاظ به. الحد 65,536 بايت UTF-8 لكل رسالة.",
      },
      {
        title: "متعدد المنصات",
        desc: "Windows وmacOS وLinux وAndroid وiOS — يكفي متصفح حديث، لا شيء للتثبيت.",
      },
      {
        title: "مجاني",
        desc: "مجاني ضمن حصة المُرحِّل الشهرية؛ منشئ رمز الملفات أو النص يسجّل الدخول، ومن ينضم بالرمز لا يحتاج إلى حساب.",
      },
    ],
  },
  compare: {
    heading: "بالمقارنة",
    items: [
      {
        title: "مقابل AirDrop",
        body: "AirDrop مقتصر على أجهزة Apple وعلى القرب المباشر؛ أما Relayium فيقرن بين Windows وAndroid وiPhone وMac عبر شبكات مختلفة، مُشفَّرًا من الطرف إلى الطرف، بمجرد متصفح.",
      },
      {
        title: "مقابل Snapdrop / PairDrop",
        body: "هذان يعملان على الشبكة نفسها فقط؛ يضيف Relayium الاقتران عبر الشبكات وتشفير طبقة التطبيق من الطرف إلى الطرف ومقارنة SAS عبر قناة مستقلة لكشف استبدال مفاتيح X25519 العامة للطرفين. لا يستطيع مُرحِّل أو خادم إشارة مخترَق انتحال طرف بصمت وإنهاء هذا التشفير؛ ويظل TURN في المسار حاملًا النص المشفر فقط.",
      },
    ],
  },
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل تمر ملفاتي أو رسائلي عبر خادمكم؟",
        a: "تستخدم جلسات المتصفح عبر الشبكات مُرحِّل TURN عمدًا، لكن الملفات والرسائل مشفّرة من الطرف إلى الطرف، فلا يرى سوى النص المُشفَّر. ولا يخزن Relayium نصوص الرسائل.",
      },
      {
        q: "هل الرمز إلزامي؟",
        a: "نعم: رمز مكوّن من 6 أرقام (أو رابط الانضمام/رمز QR الخاص به)، صالح لمدة 5 دقائق، يقرن الجهازين عبر شبكات مختلفة. يُصدره الخادم عشوائيًا بتوزيع منتظم من 0 إلى 9، فكل رقم وارد والصفر في المقدمة أمر عادي — لذلك لا يمكنك اختلاق رمز من عندك: لا يقرن إلا رمز أصدره الخادم. وهو ليس الأرقام الستة نفسها لرمز التحقق (SAS) المشتقّ من مفتاحَي الطرفين.",
      },
      {
        q: "هل يلزم حساب؟",
        a: "يسجّل منشئ رمز اقتران الملفات أو النص الدخول؛ أما الانضمام بالرمز فلا يحتاج إلى حساب.",
      },
      {
        q: "هل هو مُشفَّر من الطرف إلى الطرف؟",
        a: "نعم — X25519 وAES-256-GCM لكل كتلة. تؤكد مقارنة SAS عبر قناة مستقلة أن المفاتيح العامة للطرفين لم تُستبدل وأن خدمة الإشارة أو مُرحِّل TURN لم تنتحل شخصية أي طرف أو تُنهِ تشفير طبقة التطبيق من الطرف إلى الطرف. وقد يبقى TURN في مسار الشبكة حاملًا النص المشفر فقط.",
      },
      {
        q: "هل يمكنني إرسال نص إلى جانب الملفات؟",
        a: "نعم. ما دام الجهازان متصلين، أرسل نصًا مباشرًا مؤقتًا حتى 65,536 بايت UTF-8 لكل رسالة. لا يخزن Relayium النص أو سجلًا على الخادم، لكن أي جهاز طرفي يمكنه نسخ النص المستلم أو الاحتفاظ به.",
      },
    ],
  },
  learnHeading: "اعرف المزيد",
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

const es = {
  title: "Transferencia entre redes de archivos y texto en vivo — cifrada de extremo a extremo | Relayium",
  description:
    "Envía archivos y texto efímero en vivo entre redes con un código de 6 dígitos. Ambos dispositivos permanecen en línea; el navegador usa por diseño un retransmisor TURN que solo ve datos cifrados.",
  hero: {
    h1: "Archivos y texto en vivo entre redes, cifrados de extremo a extremo",
    pitch:
      "Dos dispositivos en línea en redes distintas se emparejan con un código de 6 dígitos (o su enlace/QR) para enviar archivos o texto efímero. El navegador usa por diseño el TURN de Relayium, que solo ve datos cifrados; Relayium no almacena el cuerpo de los mensajes.",
    cta: "Iniciar transferencia",
  },
  how: {
    heading: "Transferir en cuatro pasos",
    steps: [
      "Una persona inicia sesión y genera un código de 6 dígitos para archivos o texto (o comparte su enlace/QR).",
      "La otra abre el enlace o introduce el código — unirse con el código no requiere cuenta.",
      "Opcional (activa la verificación avanzada): ambas partes comparan el mismo código de verificación (SAS) de 6 dígitos —distinto del código de emparejamiento— por un canal independiente. Si coincide, confirma que las claves públicas X25519 de los extremos no fueron sustituidas y que ni el servicio de señalización ni el retransmisor TURN suplantaron un extremo o terminaron el E2EE de la aplicación. TURN puede seguir en la ruta de red, llevando solo datos cifrados.",
      "Con ambos dispositivos en línea, archivos y texto en vivo viajan cifrados de extremo a extremo por TURN. Relayium no almacena el cuerpo; cada mensaje admite hasta 65.536 bytes UTF-8.",
    ],
  },
  why: {
    heading: "Por qué Relayium",
    items: [
      {
        title: "Cifrado de extremo a extremo",
        desc: "Intercambio de claves X25519 y AES-256-GCM por bloque; las claves se negocian únicamente entre los dos dispositivos, de modo que ni el retransmisor ni el servidor pueden descifrar.",
      },
      {
        title: "Comprobación SAS opcional contra el intermediario",
        desc: "Compara el SAS de 6 dígitos por un canal independiente para confirmar que las claves públicas X25519 de los extremos no fueron sustituidas. Detecta la suplantación de un extremo por el servicio de señalización o TURN, pero no demuestra que TURN esté ausente de la ruta de red, donde solo lleva datos cifrados.",
      },
      {
        title: "El retransmisor solo ve texto cifrado",
        desc: "Las transferencias del navegador entre redes usan por diseño un TURN rápido para atravesar NAT; solo lleva datos cifrados, nunca claves ni texto en claro.",
      },
      {
        title: "Texto efímero en vivo",
        desc: "Ambos dispositivos deben seguir en línea. Relayium no almacena cuerpos ni historial en el servidor; un extremo sí puede copiar o conservar el texto recibido. Cada mensaje admite 65.536 bytes UTF-8.",
      },
      {
        title: "Multiplataforma",
        desc: "Windows, macOS, Linux, Android, iOS — basta un navegador moderno, nada que instalar.",
      },
      {
        title: "Gratis",
        desc: "Gratis dentro del cupo mensual; quien crea un código de archivos o texto inicia sesión, pero unirse con ese código no requiere cuenta.",
      },
    ],
  },
  compare: {
    heading: "En comparación",
    items: [
      {
        title: "Frente a AirDrop",
        body: "AirDrop se limita a los dispositivos Apple y a la cercanía inmediata; Relayium empareja Windows, Android, iPhone y Mac entre redes distintas, cifrado de extremo a extremo, con un simple navegador.",
      },
      {
        title: "Frente a Snapdrop / PairDrop",
        body: "Estos solo funcionan en la misma red; Relayium añade emparejamiento entre redes, E2EE de aplicación y una comparación SAS por un canal independiente que detecta la sustitución de claves públicas X25519 de los extremos. Un retransmisor o servidor de señalización comprometido no puede suplantar en silencio un extremo y terminar ese cifrado; TURN sigue en la ruta con datos cifrados.",
      },
    ],
  },
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Mis archivos o mensajes pasan por el servidor?",
        a: "Las sesiones del navegador entre redes usan por diseño el TURN de Relayium, pero archivos y mensajes están cifrados de extremo a extremo y solo ve datos cifrados. Relayium no almacena el cuerpo de los mensajes.",
      },
      {
        q: "¿Es obligatorio un código?",
        a: "Sí: un código de 6 dígitos (o su enlace de acceso/QR), válido 5 minutos, empareja los dos dispositivos entre redes distintas. El servidor lo genera uniformemente al azar entre 0 y 9, cualquier dígito puede salir y un cero inicial es normal — así que no puedes inventarte uno: solo empareja un código que haya emitido el servidor. No son los mismos seis dígitos que el código de verificación (SAS), derivado de las claves de ambos extremos.",
      },
      {
        q: "¿Necesito una cuenta?",
        a: "Quien crea un código para archivos o texto inicia sesión; unirse con ese código no requiere cuenta.",
      },
      {
        q: "¿Es cifrado de extremo a extremo?",
        a: "Sí — X25519 y AES-256-GCM por bloque. Comparar el SAS por un canal independiente confirma que las claves públicas de los extremos no fueron sustituidas y que ni el servicio de señalización ni TURN suplantaron un extremo o terminaron el E2EE de la aplicación. TURN puede seguir en la ruta de red, llevando solo datos cifrados.",
      },
      {
        q: "¿Puedo enviar texto además de archivos?",
        a: "Sí. Con ambos dispositivos en línea, envía texto efímero en vivo de hasta 65.536 bytes UTF-8 por mensaje. Relayium no almacena el cuerpo ni historial en el servidor, aunque cualquier extremo puede copiar o conservar el texto recibido.",
      },
    ],
  },
  learnHeading: "Más información",
  footer: { privacy: "Privacidad", terms: "Términos del servicio", security: "Seguridad" },
};

const pt = {
  title: "Transferência entre redes de arquivos e texto ao vivo — criptografia de ponta a ponta | Relayium",
  description:
    "Envie arquivos e texto efêmero ao vivo entre redes com um código de 6 dígitos. Os dois dispositivos ficam online; o navegador usa por projeto um retransmissor TURN que só vê dados cifrados.",
  hero: {
    h1: "Arquivos e texto ao vivo entre redes, criptografados de ponta a ponta",
    pitch:
      "Dois dispositivos online em redes diferentes se emparelham com um código de 6 dígitos (ou link/QR) para enviar arquivos ou texto efêmero. O navegador usa por projeto o TURN do Relayium, que só vê dados cifrados; o Relayium não armazena o corpo das mensagens.",
    cta: "Iniciar transferência",
  },
  how: {
    heading: "Transferir em quatro passos",
    steps: [
      "Uma pessoa faz login e gera um código de 6 dígitos para arquivos ou texto (ou compartilha seu link/QR).",
      "A outra abre o link ou digita o código — entrar com o código não exige conta.",
      "Opcional (ligue a verificação avançada): as duas partes comparam o mesmo código de verificação (SAS) de 6 dígitos — diferente do código de emparelhamento — por um canal independente. Se coincidir, confirma que as chaves públicas X25519 das pontas não foram substituídas e que nem o serviço de sinalização nem o retransmissor TURN se passaram por uma ponta ou terminaram a E2EE da aplicação. O TURN pode continuar no caminho de rede, levando apenas dados cifrados.",
      "Com os dois dispositivos online, arquivos e texto ao vivo passam criptografados de ponta a ponta pelo TURN. O Relayium não armazena o corpo; cada mensagem aceita até 65.536 bytes UTF-8.",
    ],
  },
  why: {
    heading: "Por que o Relayium",
    items: [
      {
        title: "Criptografia de ponta a ponta",
        desc: "Troca de chaves X25519 e AES-256-GCM por bloco; as chaves são negociadas apenas entre os dois dispositivos, de modo que nem o retransmissor nem o servidor conseguem descriptografar.",
      },
      {
        title: "Verificação SAS opcional contra o intermediário",
        desc: "Compare o SAS de 6 dígitos por um canal independente para confirmar que as chaves públicas X25519 das pontas não foram substituídas. Isso detecta quando o serviço de sinalização ou o TURN se passa por uma ponta, mas não prova que o TURN esteja ausente do caminho de rede, onde só leva dados cifrados.",
      },
      {
        title: "O retransmissor só vê texto cifrado",
        desc: "Transferências do navegador entre redes usam por projeto um TURN rápido para atravessar NAT; ele só leva dados cifrados, nunca chaves nem texto em claro.",
      },
      {
        title: "Texto efêmero ao vivo",
        desc: "Os dois dispositivos devem ficar online. O Relayium não armazena corpos nem histórico no servidor; um dispositivo pode copiar ou guardar o texto recebido. Cada mensagem aceita 65.536 bytes UTF-8.",
      },
      {
        title: "Multiplataforma",
        desc: "Windows, macOS, Linux, Android, iOS — basta um navegador moderno, nada a instalar.",
      },
      {
        title: "Gratuito",
        desc: "Gratuito dentro da cota mensal; quem cria um código de arquivos ou texto faz login, mas entrar com esse código não exige conta.",
      },
    ],
  },
  compare: {
    heading: "Em comparação",
    items: [
      {
        title: "Comparado ao AirDrop",
        body: "O AirDrop se restringe aos dispositivos Apple e à proximidade imediata; o Relayium emparelha Windows, Android, iPhone e Mac entre redes diferentes, com criptografia de ponta a ponta, usando apenas um navegador.",
      },
      {
        title: "Comparado ao Snapdrop / PairDrop",
        body: "Esses só funcionam na mesma rede; o Relayium acrescenta emparelhamento entre redes, E2EE da aplicação e uma comparação SAS por canal independente que detecta a substituição das chaves públicas X25519 das pontas. Um retransmissor ou servidor de sinalização comprometido não pode se passar silenciosamente por uma ponta e terminar essa criptografia; o TURN continua no caminho com dados cifrados.",
      },
    ],
  },
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Meus arquivos ou mensagens passam pelo servidor?",
        a: "Sessões do navegador entre redes usam por projeto o TURN do Relayium, mas arquivos e mensagens são criptografados de ponta a ponta e ele só vê dados cifrados. O Relayium não armazena o corpo das mensagens.",
      },
      {
        q: "Um código é obrigatório?",
        a: "Sim: um código de 6 dígitos (ou seu link de acesso/QR), válido por 5 minutos, empareja os dois dispositivos entre redes diferentes. O servidor o gera uniformemente ao acaso entre 0 e 9, qualquer dígito pode sair e um zero à esquerda é normal — então você não pode inventar um: só emparelha um código que o servidor tenha emitido. Não são os mesmos seis dígitos do código de verificação (SAS), derivado das chaves das duas pontas.",
      },
      {
        q: "Preciso de uma conta?",
        a: "Quem cria um código para arquivos ou texto faz login; entrar com esse código não exige conta.",
      },
      {
        q: "É criptografia de ponta a ponta?",
        a: "Sim — X25519 e AES-256-GCM por bloco. Comparar o SAS por um canal independente confirma que as chaves públicas das pontas não foram substituídas e que nem o serviço de sinalização nem o TURN se passaram por uma ponta ou terminaram a E2EE da aplicação. O TURN pode continuar no caminho de rede, levando apenas dados cifrados.",
      },
      {
        q: "Posso enviar texto além de arquivos?",
        a: "Sim. Com os dois dispositivos online, envie texto efêmero ao vivo de até 65.536 bytes UTF-8 por mensagem. O Relayium não armazena o corpo nem histórico no servidor, embora cada dispositivo possa copiar ou guardar o texto recebido.",
      },
    ],
  },
  learnHeading: "Saiba mais",
  footer: { privacy: "Privacidade", terms: "Termos de Serviço", security: "Segurança" },
};

export default {
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
