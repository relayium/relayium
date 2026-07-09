// web/scripts/pages/content/articles/compare-localsend.mjs
// Objective comparison: Relayium vs LocalSend. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n/en.ts and content/landing.mjs.

const en = {
  title: "Relayium vs LocalSend: which local file transfer to use",
  description:
    "An honest comparison of Relayium and LocalSend. LocalSend is a great open-source app installed on each device; Relayium does the same LAN transfer in the browser — no install — plus cross-network and a CLI.",
  updatedLabel: "Last updated",
  lead: [
    "LocalSend is a genuinely good, well-loved app: free, open source, cross-platform, and built to move files between devices on the same local network with no server and no account, ever. A lot of people rely on it as an AirDrop-like tool for Windows, Linux and Android.",
    "This article compares it fairly with Relayium, which tackles the same same-network problem a different way — no app to install, running right in your browser — and then goes further, reaching across networks and offering a command-line tool LocalSend doesn't have.",
  ],
  sections: [
    {
      heading: "What LocalSend does well",
      body: [
        "LocalSend is a free, open-source app for Windows, macOS, Linux, Android and iOS. Install it once on each device, and it automatically discovers other LocalSend instances on the same Wi-Fi or LAN using an encrypted local transport — no server anywhere, no internet connection required, no account.",
        "It supports drag-and-drop, sending whole folders, and an optional PIN for sending on networks you don't fully trust.",
      ],
      bullets: [
        "Cross-platform native apps for Windows, macOS, Linux, Android and iOS — install once, then it just works.",
        "Completely offline by design: no server, no internet connection, and no account, ever — it only needs devices on the same local network.",
        "Optional PIN protection for sending on untrusted networks, plus drag-and-drop and whole-folder transfers.",
        "A dedicated app icon and OS-level share-sheet integration, which a browser tab can't offer.",
      ],
    },
    {
      heading: "Where Relayium differs: nothing to install, right in the browser",
      body: [
        "Relayium takes the opposite approach to the same same-network problem: instead of installing an app on every device, you open relayium.com in a browser you already have. Two devices on the same network land in the same room automatically — the server derives the room from the shared network, with no pairing code and no account needed on either side.",
        "That LAN room supports any number of peers at once, not just a pair, and drag-and-drop or folder selection works the same way a native app would — just without the install step.",
      ],
    },
    {
      heading: "Beyond the LAN: cross-network transfer and a CLI",
      body: [
        "LocalSend is local-network only by design — it has no way to reach a device on a different network or across the internet. Relayium adds that: create a pairing code (or share the join link it generates), and the other side connects from anywhere, direct peer-to-peer whenever possible.",
        "Creating a cross-network pairing code requires the sender to sign in; the person receiving never needs an account. Every realtime transfer — LAN or cross-network — is encrypted end-to-end at the application layer: an X25519 key exchange derives a key used for AES-256-GCM, a 6-digit SAS code lets both sides confirm no server sits in the middle, and each file is verified with a SHA-256 hash. When a direct connection isn't possible, an encrypted TURN relay carries ciphertext it cannot read.",
        "For anyone scripting transfers to a server, there's also a CLI — push/pull over SSH or daemon-direct, incremental folder sync, and send/receive by pairing code — something a LAN-only app doesn't offer.",
      ],
    },
    {
      heading: "When LocalSend is the better pick",
      body: [
        "If you never want to open a browser at all — say, moving files on a network with genuinely no internet access, or you just want a permanent app icon and OS share-sheet integration — LocalSend's dedicated app is the better fit. It's mature, works fully offline in the strictest sense, and its PIN mode is a nice extra layer on networks you don't fully trust.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Install: LocalSend needs an app on every device; Relayium's same-network mode needs nothing beyond a browser.",
        "Network reach: LocalSend is local-network only; Relayium also connects across different networks with a pairing code.",
        "Encryption: LocalSend secures its local transport; Relayium adds an independent application-layer X25519 + AES-256-GCM channel with a SAS verification code, even on the LAN.",
        "Accounts: LocalSend never needs one; Relayium's LAN mode needs none either — only the sender signs in for cross-network transfers.",
        "Automation: Relayium ships a CLI for SSH push/pull, incremental sync, and an always-on receive service; LocalSend is app-only.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need to install anything to use Relayium on the same network?",
        a: "No. Open relayium.com in a browser on both devices while they're on the same network and they see each other automatically — no app, no account, no pairing code.",
      },
      {
        q: "Does LocalSend need an internet connection?",
        a: "No — that's one of its strengths. LocalSend works entirely over the local network with no server involved, so it keeps working even with no internet at all.",
      },
      {
        q: "Can Relayium send files to someone on a different network?",
        a: "Yes. Create a pairing code (or share the join link it generates) and the other device connects from anywhere, still peer-to-peer whenever possible. The sender needs to sign in for this; the recipient never does.",
      },
      {
        q: "Is Relayium open source?",
        a: "Yes, MIT-licensed, with the full protocol and code public at github.com/relayium/relayium — the same kind of openness that makes LocalSend trustworthy.",
      },
      {
        q: "Which one is more private?",
        a: "Both keep same-network transfers off a public server. LocalSend secures its local transport; Relayium adds an independent, application-layer encryption channel with a SAS code both sides can verify, on the LAN or across networks.",
      },
    ],
  },
  cta: {
    text: "See how a same-network transfer feels with nothing to install — just open the page on both devices.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 LocalSend：局域网传输该选哪个",
  description:
    "客观对比 Relayium 与 LocalSend。LocalSend 是一款优秀的开源应用，需要在每台设备上安装；Relayium 在浏览器里完成同样的局域网传输——无需安装——还支持跨网络与命令行工具。",
  updatedLabel: "最近更新",
  lead: [
    "LocalSend 是一款真正优秀、深受喜爱的应用：免费、开源、跨平台，专为在同一局域网设备间传输文件而生,始终无需服务器、无需账号。不少人把它当作 Windows、Linux、Android 上的 AirDrop 替代品来用。",
    "本文客观地把它和 Relayium 比一比。Relayium 用不同的方式解决同样的同网络传输问题——无需安装任何应用，直接在浏览器里运行——并且走得更远：能跨网络传输，还提供 LocalSend 没有的命令行工具。",
  ],
  sections: [
    {
      heading: "LocalSend 做得好的地方",
      body: [
        "LocalSend 是一款面向 Windows、macOS、Linux、Android 和 iOS 的免费开源应用。在每台设备上安装一次后，它就能通过加密的本地传输协议自动发现同一 Wi-Fi 或局域网里的其他 LocalSend 实例——不经过任何服务器，不需要联网，也不需要账号。",
        "它支持拖拽发送、整个文件夹发送，还能在不完全信任的网络上开启 PIN 码保护。",
      ],
      bullets: [
        "跨平台原生应用，覆盖 Windows、macOS、Linux、Android 和 iOS——装一次，之后就能直接用。",
        "设计上完全离线：始终无需服务器、无需联网、无需账号——只要设备在同一局域网即可。",
        "在不信任的网络上可开启 PIN 码保护，同时支持拖拽发送与整文件夹传输。",
        "有独立的应用图标和系统级分享菜单集成，这是浏览器标签页给不了的。",
      ],
    },
    {
      heading: "Relayium 的不同之处：无需安装，直接在浏览器里用",
      body: [
        "面对同样的同网络传输问题，Relayium 走了相反的路：不必在每台设备上装应用，直接用手头已有的浏览器打开 relayium.com 即可。同一网络下的两台设备会自动落入同一个房间——服务器根据共享的网络判定房间，双方都无需配对码、也无需账号。",
        "这个局域网房间可以容纳任意数量的设备，不只是一对一；拖拽或选择文件夹的体验和原生应用一样，只是省去了安装这一步。",
      ],
    },
    {
      heading: "走出局域网：跨网络传输与命令行工具",
      body: [
        "LocalSend 在设计上只面向局域网——它没有办法连到不同网络或跨互联网的设备。Relayium 补上了这一块：创建一个配对码（或分享它生成的加入链接），对方就能从任何地方连接进来，只要条件允许依然是点对点直连。",
        "创建跨网络配对码需要发送方登录；接收方始终无需账号。每一次实时传输——无论局域网还是跨网络——都在应用层做端到端加密：X25519 密钥交换协商出用于 AES-256-GCM 的密钥，双方还会显示同一个 6 位 SAS 校验码以确认没有服务器插在中间，每个文件都用 SHA-256 做校验。当无法直连时，加密数据会经由 TURN 中继转发，中继只能看到无法解读的密文。",
        "如果你需要把传输写进脚本发往服务器，Relayium 还提供命令行工具——通过 SSH 或直连方式 push/pull、增量同步文件夹、用配对码 send/receive——这些都是纯局域网应用做不到的。",
      ],
    },
    {
      heading: "什么时候 LocalSend 是更好的选择",
      body: [
        "如果你完全不想打开浏览器——比如在真正没有互联网接入的网络里传文件，或者就是想要一个常驻的应用图标和系统分享菜单集成——LocalSend 的专用应用会更合适。它足够成熟，在最严格意义上也能完全离线工作，而它的 PIN 模式在不完全信任的网络上也是不错的额外保障。",
      ],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "安装：LocalSend 需要在每台设备上装应用；Relayium 的同网络模式除了浏览器什么都不需要。",
        "网络覆盖：LocalSend 只能在局域网内使用；Relayium 还能用配对码连接不同网络。",
        "加密：LocalSend 保护的是本地传输通道；Relayium 即便在局域网内也会额外加一层独立的应用层 X25519 + AES-256-GCM 通道，并带 SAS 校验码。",
        "账号：LocalSend 从不需要账号；Relayium 的局域网模式同样无需账号——只有跨网络传输时才需要发送方登录。",
        "自动化：Relayium 提供命令行工具支持 SSH push/pull、增量同步和常驻接收服务；LocalSend 只有应用形态。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "在同一网络下使用 Relayium 需要安装什么吗？",
        a: "不需要。两台设备处于同一网络时，分别用浏览器打开 relayium.com，它们会自动互相看到——无需应用、无需账号、无需配对码。",
      },
      {
        q: "LocalSend 需要联网吗？",
        a: "不需要——这正是它的优势之一。LocalSend 完全通过局域网工作，不经过任何服务器，因此即使完全没有互联网连接也能正常使用。",
      },
      {
        q: "Relayium 能给不同网络的人发送文件吗？",
        a: "可以。创建一个配对码（或分享它生成的加入链接），对方就能从任何地方连接进来，只要条件允许依然是点对点直连。这需要发送方登录，接收方始终无需登录。",
      },
      {
        q: "Relayium 是开源的吗？",
        a: "是的，采用 MIT 许可证，完整的协议与代码都公开在 github.com/relayium/relayium——这正是让 LocalSend 值得信任的同一种开放。",
      },
      {
        q: "哪一个更私密？",
        a: "两者都能让同网络传输不经过公网服务器。LocalSend 保护的是它的本地传输通道；Relayium 则无论是在局域网还是跨网络，都额外加了一层独立的应用层加密通道，并带有双方可核对的 SAS 校验码。",
      },
    ],
  },
  cta: {
    text: "亲自体验一下同网络传输的感觉——什么都不用装，两台设备各打开一次页面就行。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と LocalSend の比較：ローカル転送はどちらを使う？",
  description:
    "Relayium と LocalSend を公平に比較。LocalSend は各端末にインストールする優れたオープンソースアプリ。Relayium は同じ LAN 転送をブラウザだけで実現し——インストール不要——さらにネットワークをまたぐ転送と CLI も備えます。",
  updatedLabel: "最終更新",
  lead: [
    "LocalSend は本当に優れた、愛用者の多いアプリです。無料でオープンソース、クロスプラットフォームで、同じローカルネットワーク上の端末間でファイルを転送するために作られており、サーバーもアカウントも一切必要ありません。Windows・Linux・Android 向けの AirDrop 的なツールとして頼りにしている人も多くいます。",
    "本記事はこれを Relayium と公平に比較します。Relayium は同じ「同一ネットワーク」という課題を別のやり方で解決します——アプリのインストールは不要で、ブラウザの中でそのまま動きます——そしてさらに一歩進んで、ネットワークをまたいだ転送や、LocalSend にはない CLI ツールも提供します。",
  ],
  sections: [
    {
      heading: "LocalSend が優れている点",
      body: [
        "LocalSend は Windows、macOS、Linux、Android、iOS 向けの無料オープンソースアプリです。各端末に一度インストールすれば、暗号化されたローカル転送を使って同じ Wi-Fi や LAN 上の他の LocalSend インスタンスを自動的に発見します——サーバーはどこにもなく、インターネット接続もアカウントも不要です。",
        "ドラッグ&ドロップ、フォルダ丸ごとの送信に対応し、完全には信頼できないネットワークで送る際には任意の PIN 保護も使えます。",
      ],
      bullets: [
        "Windows、macOS、Linux、Android、iOS 向けのクロスプラットフォームなネイティブアプリ——一度インストールすればそのまま使える。",
        "設計上完全にオフライン：サーバーなし、インターネット接続不要、アカウント不要——同じローカルネットワークにいる端末だけが条件。",
        "信頼できないネットワークで送る際の任意の PIN 保護に加え、ドラッグ&ドロップとフォルダ丸ごとの転送に対応。",
        "専用のアプリアイコンと OS レベルの共有シート統合があり、これはブラウザのタブでは得られない。",
      ],
    },
    {
      heading: "Relayium の違い：インストール不要、そのままブラウザで",
      body: [
        "Relayium は同じ「同一ネットワーク」の課題に正反対のアプローチを取ります。すべての端末にアプリをインストールする代わりに、すでに持っているブラウザで relayium.com を開くだけです。同じネットワーク上の2台の端末は自動的に同じルームに入ります——サーバーが共有ネットワークからルームを判定するため、どちらの側もペアリングコードもアカウントも不要です。",
        "この LAN ルームは一対一だけでなく何台でも同時に参加でき、ドラッグ&ドロップやフォルダ選択もネイティブアプリと同じように動作します——インストールという手順が省けるだけです。",
      ],
    },
    {
      heading: "LAN を越えて：ネットワークをまたぐ転送と CLI",
      body: [
        "LocalSend は設計上ローカルネットワーク限定です——異なるネットワークやインターネット越しの端末に届く手段がありません。Relayium はこれを補います。ペアリングコード（またはそれが生成する参加リンク）を作れば、相手はどこからでも接続でき、可能な限り引き続き P2P 直接接続になります。",
        "ネットワークをまたぐペアリングコードの作成には送信側のサインインが必要です。受信側はアカウント不要です。LAN でもネットワークをまたぐ場合でも、すべてのリアルタイム転送はアプリケーション層でエンドツーエンド暗号化されます。X25519 の鍵交換で AES-256-GCM 用の鍵を導出し、両端末が同じ6桁の SAS コードを表示して間にサーバーがいないことを確認でき、各ファイルは SHA-256 ハッシュで検証されます。直接接続が不可能なときは、暗号化された TURN リレーが読み取れない暗号文を中継します。",
        "サーバーへの転送をスクリプト化したい人向けに CLI もあります——SSH またはデーモン直結での push/pull、フォルダの増分同期、ペアリングコードによる送受信——これは LAN 専用アプリにはできないことです。",
      ],
    },
    {
      heading: "LocalSend の方が良い場合",
      body: [
        "そもそもブラウザを開きたくない場合——本当にインターネット接続のないネットワークでファイルを移動する、あるいは常駐するアプリアイコンや OS の共有シート統合が欲しいだけ、といった場合は、LocalSend の専用アプリの方が合っています。成熟しており、最も厳密な意味で完全にオフラインで動作し、その PIN モードは完全には信頼できないネットワークでの良い追加の保護層になります。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "インストール：LocalSend は各端末にアプリが必要。Relayium の同一ネットワークモードはブラウザ以外に何も要らない。",
        "ネットワークの到達範囲：LocalSend はローカルネットワーク限定。Relayium はペアリングコードで異なるネットワークにも接続できる。",
        "暗号化：LocalSend はローカル転送そのものを保護。Relayium は LAN 内でも独立したアプリケーション層の X25519 + AES-256-GCM チャネルと SAS 検証コードを追加する。",
        "アカウント：LocalSend は決して不要。Relayium の LAN モードも同様に不要——ネットワークをまたぐ転送のみ送信側のサインインが必要。",
        "自動化：Relayium は SSH push/pull、増分同期、常駐の受信サービス向けの CLI を提供。LocalSend はアプリのみ。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "同じネットワークで Relayium を使うのに何かインストールが必要ですか？",
        a: "いいえ。同じネットワーク上にある間に両方の端末のブラウザで relayium.com を開けば、自動的にお互いを見つけます——アプリ不要、アカウント不要、ペアリングコード不要です。",
      },
      {
        q: "LocalSend はインターネット接続が必要ですか？",
        a: "いいえ——それが強みの一つです。LocalSend はサーバーを一切介さずローカルネットワークだけで動作するため、インターネットが全くない環境でも動き続けます。",
      },
      {
        q: "Relayium は異なるネットワークの相手にファイルを送れますか？",
        a: "はい。ペアリングコード（またはそれが生成する参加リンク）を作れば、相手はどこからでも接続でき、可能な限り引き続き P2P 直接接続になります。これには送信側のサインインが必要で、受信側は常に不要です。",
      },
      {
        q: "Relayium はオープンソースですか？",
        a: "はい、MIT ライセンスで、プロトコルとコードの全体が github.com/relayium/relayium で公開されています——LocalSend を信頼できるものにしているのと同じ種類の開放性です。",
      },
      {
        q: "どちらがより秘匿性が高いですか？",
        a: "どちらも同一ネットワーク内の転送を公開サーバーの外に保ちます。LocalSend はローカル転送そのものを保護します。Relayium はさらに、LAN でもネットワークをまたいでも、両端末で確認できる SAS コード付きの独立したアプリケーション層暗号化チャネルを追加します。",
      },
    ],
  },
  cta: {
    text: "何もインストールせずに同一ネットワーク転送を体験してみましょう——両方の端末でページを開くだけです。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs LocalSend: 로컬 파일 전송, 무엇을 쓸까",
  description:
    "Relayium과 LocalSend를 공정하게 비교합니다. LocalSend는 각 기기에 설치하는 훌륭한 오픈소스 앱이고, Relayium은 같은 LAN 전송을 브라우저에서——설치 없이——해내며 네트워크를 넘나드는 전송과 CLI까지 제공합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "LocalSend는 정말 훌륭하고 사랑받는 앱입니다. 무료, 오픈소스, 크로스플랫폼이며 같은 로컬 네트워크의 기기 사이에서 파일을 옮기도록 만들어졌고, 서버도 계정도 전혀 필요 없습니다. Windows, Linux, Android용 AirDrop 같은 도구로 많은 사람이 의지하고 있습니다.",
    "이 글은 이를 Relayium과 공정하게 비교합니다. Relayium은 같은 '동일 네트워크' 문제를 다른 방식으로 풉니다——설치할 앱이 없고 브라우저 안에서 바로 동작합니다——그리고 한 걸음 더 나아가 네트워크를 넘나드는 전송과, LocalSend에는 없는 CLI 도구까지 제공합니다.",
  ],
  sections: [
    {
      heading: "LocalSend가 잘하는 것",
      body: [
        "LocalSend는 Windows, macOS, Linux, Android, iOS용 무료 오픈소스 앱입니다. 각 기기에 한 번 설치하면 암호화된 로컬 전송을 사용해 같은 Wi-Fi나 LAN에 있는 다른 LocalSend 인스턴스를 자동으로 찾습니다——어디에도 서버가 없고, 인터넷 연결도 계정도 필요 없습니다.",
        "드래그 앤 드롭, 폴더 통째 전송을 지원하며, 완전히 신뢰하지 않는 네트워크에서 보낼 때는 선택적 PIN 보호도 쓸 수 있습니다.",
      ],
      bullets: [
        "Windows, macOS, Linux, Android, iOS용 크로스플랫폼 네이티브 앱 — 한 번 설치하면 바로 쓸 수 있음.",
        "설계상 완전 오프라인: 서버 없음, 인터넷 연결 불필요, 계정 불필요 — 같은 로컬 네트워크의 기기만 있으면 됨.",
        "신뢰하지 않는 네트워크에서 보낼 때 선택적 PIN 보호, 드래그 앤 드롭과 폴더 통째 전송 지원.",
        "전용 앱 아이콘과 OS 수준 공유 시트 통합 — 브라우저 탭으로는 얻을 수 없는 부분.",
      ],
    },
    {
      heading: "Relayium의 차이: 설치 없이, 브라우저에서 바로",
      body: [
        "Relayium은 같은 '동일 네트워크' 문제에 정반대로 접근합니다. 모든 기기에 앱을 설치하는 대신, 이미 가지고 있는 브라우저로 relayium.com을 엽니다. 같은 네트워크의 두 기기는 자동으로 같은 방에 들어갑니다 — 서버가 공유 네트워크로부터 방을 판단하므로 양쪽 모두 페어링 코드도 계정도 필요 없습니다.",
        "이 LAN 방은 한 쌍뿐 아니라 몇 대든 동시에 수용하며, 드래그 앤 드롭이나 폴더 선택도 네이티브 앱과 똑같이 동작합니다 — 설치 단계만 없을 뿐입니다.",
      ],
    },
    {
      heading: "LAN을 넘어서: 네트워크 간 전송과 CLI",
      body: [
        "LocalSend는 설계상 로컬 네트워크 전용입니다 — 다른 네트워크나 인터넷 너머의 기기에 닿을 방법이 없습니다. Relayium은 이를 더합니다. 페어링 코드(또는 그것이 생성하는 참여 링크)를 만들면 상대는 어디서든 연결할 수 있고, 가능한 경우 여전히 P2P 직접 연결입니다.",
        "네트워크를 넘나드는 페어링 코드를 만들려면 보내는 쪽의 로그인이 필요합니다. 받는 쪽은 계정이 전혀 필요 없습니다. LAN이든 네트워크를 넘나들든 모든 실시간 전송은 애플리케이션 계층에서 종단간 암호화됩니다. X25519 키 교환으로 AES-256-GCM에 쓸 키를 유도하고, 양쪽 기기가 동일한 6자리 SAS 코드를 표시해 사이에 서버가 없음을 확인할 수 있으며, 각 파일은 SHA-256 해시로 검증됩니다. 직접 연결이 불가능할 때는 암호화된 TURN 릴레이가 읽을 수 없는 암호문을 중계합니다.",
        "서버로의 전송을 스크립트화하려는 사람을 위한 CLI도 있습니다 — SSH 또는 데몬 직결로 push/pull, 폴더 증분 동기화, 페어링 코드로 송수신 — LAN 전용 앱에는 없는 기능입니다.",
      ],
    },
    {
      heading: "LocalSend가 더 나은 선택일 때",
      body: [
        "브라우저를 아예 열고 싶지 않다면 — 예를 들어 정말로 인터넷 접속이 전혀 없는 네트워크에서 파일을 옮기거나, 그냥 상시 앱 아이콘과 OS 공유 시트 통합을 원한다면 — LocalSend의 전용 앱이 더 적합합니다. 성숙하고, 가장 엄격한 의미에서 완전히 오프라인으로 동작하며, PIN 모드는 완전히 신뢰하지 않는 네트워크에서 좋은 추가 보호층이 됩니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "설치: LocalSend는 모든 기기에 앱이 필요; Relayium의 동일 네트워크 모드는 브라우저 외에 아무것도 필요 없음.",
        "네트워크 도달 범위: LocalSend는 로컬 네트워크 전용; Relayium은 페어링 코드로 다른 네트워크에도 연결됨.",
        "암호화: LocalSend는 로컬 전송 자체를 보호; Relayium은 LAN에서도 독립적인 애플리케이션 계층 X25519 + AES-256-GCM 채널과 SAS 검증 코드를 추가함.",
        "계정: LocalSend는 절대 필요 없음; Relayium의 LAN 모드도 마찬가지 — 네트워크를 넘나드는 전송만 보내는 쪽 로그인이 필요.",
        "자동화: Relayium은 SSH push/pull, 증분 동기화, 상시 수신 서비스를 위한 CLI를 제공; LocalSend는 앱뿐임.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "같은 네트워크에서 Relayium을 쓰려면 뭔가 설치해야 하나요?",
        a: "아니요. 두 기기가 같은 네트워크에 있는 동안 양쪽 브라우저에서 relayium.com을 열면 자동으로 서로를 찾습니다 — 앱도, 계정도, 페어링 코드도 필요 없습니다.",
      },
      {
        q: "LocalSend는 인터넷 연결이 필요한가요?",
        a: "아니요 — 그것이 강점 중 하나입니다. LocalSend는 서버를 전혀 거치지 않고 로컬 네트워크만으로 동작하므로 인터넷이 전혀 없어도 계속 작동합니다.",
      },
      {
        q: "Relayium은 다른 네트워크에 있는 사람에게 파일을 보낼 수 있나요?",
        a: "네. 페어링 코드(또는 그것이 생성하는 참여 링크)를 만들면 상대는 어디서든 연결할 수 있고, 가능한 경우 여전히 P2P 직접 연결입니다. 이때 보내는 쪽은 로그인이 필요하고, 받는 쪽은 항상 필요 없습니다.",
      },
      {
        q: "Relayium은 오픈소스인가요?",
        a: "네, MIT 라이선스이며 프로토콜과 코드 전체가 github.com/relayium/relayium에 공개되어 있습니다 — LocalSend를 신뢰할 수 있게 만든 것과 같은 종류의 개방성입니다.",
      },
      {
        q: "어느 쪽이 더 사적인가요?",
        a: "둘 다 동일 네트워크 전송을 공개 서버 밖에 둡니다. LocalSend는 로컬 전송 자체를 보호합니다. Relayium은 LAN이든 네트워크를 넘나들든 양쪽에서 확인할 수 있는 SAS 코드가 붙은 독립적인 애플리케이션 계층 암호화 채널을 추가로 제공합니다.",
      },
    ],
  },
  cta: {
    text: "아무것도 설치하지 않고 동일 네트워크 전송이 어떤 느낌인지 직접 확인해 보세요 — 양쪽 기기에서 페이지만 열면 됩니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. LocalSend: welche lokale Dateiübertragung?",
  description:
    "Ein ehrlicher Vergleich von Relayium und LocalSend. LocalSend ist eine großartige Open-Source-App, die auf jedem Gerät installiert wird; Relayium erledigt dieselbe LAN-Übertragung im Browser — ohne Installation — plus netzwerkübergreifend und mit CLI.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "LocalSend ist eine wirklich gute, beliebte App: kostenlos, quelloffen, plattformübergreifend und dafür gebaut, Dateien zwischen Geräten im selben lokalen Netz zu übertragen — ganz ohne Server und ganz ohne Konto. Viele nutzen sie als AirDrop-ähnliches Werkzeug für Windows, Linux und Android.",
    "Dieser Artikel vergleicht sie fair mit Relayium, das dasselbe Problem — dieselbe Netzwerkverbindung — anders löst: keine App zu installieren, läuft direkt im Browser — und geht dann weiter, indem es netzwerkübergreifend funktioniert und ein Kommandozeilen-Tool bietet, das LocalSend nicht hat.",
  ],
  sections: [
    {
      heading: "Was LocalSend gut macht",
      body: [
        "LocalSend ist eine kostenlose Open-Source-App für Windows, macOS, Linux, Android und iOS. Einmal auf jedem Gerät installiert, entdeckt sie automatisch andere LocalSend-Instanzen im selben WLAN oder LAN über einen verschlüsselten lokalen Transport — kein Server irgendwo, keine Internetverbindung nötig, kein Konto.",
        "Sie unterstützt Drag-and-Drop, das Senden ganzer Ordner sowie einen optionalen PIN-Schutz beim Senden in Netzwerken, denen man nicht vollständig vertraut.",
      ],
      bullets: [
        "Plattformübergreifende native Apps für Windows, macOS, Linux, Android und iOS — einmal installiert, funktioniert es einfach.",
        "Von Grund auf offline: kein Server, keine Internetverbindung, kein Konto — nötig sind nur Geräte im selben lokalen Netz.",
        "Optionaler PIN-Schutz beim Senden in nicht vertrauenswürdigen Netzwerken, plus Drag-and-Drop und Übertragung ganzer Ordner.",
        "Ein eigenes App-Symbol und OS-seitige Share-Sheet-Integration, die ein Browser-Tab nicht bieten kann.",
      ],
    },
    {
      heading: "Worin sich Relayium unterscheidet: nichts zu installieren, direkt im Browser",
      body: [
        "Relayium geht das gleiche Netzwerkproblem genau umgekehrt an: Statt auf jedem Gerät eine App zu installieren, öffnest du relayium.com in einem Browser, den du bereits hast. Zwei Geräte im selben Netz landen automatisch im selben Raum — der Server leitet den Raum aus dem gemeinsamen Netzwerk ab, ganz ohne Pairing-Code und ohne Konto auf beiden Seiten.",
        "Dieser LAN-Raum fasst beliebig viele Geräte gleichzeitig, nicht nur ein Paar, und Drag-and-Drop oder Ordnerauswahl funktionieren genauso wie bei einer nativen App — nur ohne den Installationsschritt.",
      ],
    },
    {
      heading: "Über das LAN hinaus: netzwerkübergreifende Übertragung und eine CLI",
      body: [
        "LocalSend ist von Natur aus nur fürs lokale Netz gedacht — es gibt keine Möglichkeit, ein Gerät in einem anderen Netzwerk oder über das Internet zu erreichen. Relayium fügt das hinzu: Erstelle einen Pairing-Code (oder teile den daraus erzeugten Beitrittslink), und die Gegenseite verbindet sich von überall — nach Möglichkeit weiterhin direkt Peer-to-Peer.",
        "Für einen netzwerkübergreifenden Pairing-Code muss sich der Absender anmelden; die empfangende Person braucht nie ein Konto. Jede Echtzeitübertragung — im LAN oder netzwerkübergreifend — ist auf Anwendungsebene Ende-zu-Ende-verschlüsselt: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM ab, ein sechsstelliger SAS-Code lässt beide Seiten bestätigen, dass kein Server dazwischensitzt, und jede Datei wird per SHA-256-Hash geprüft. Ist eine Direktverbindung nicht möglich, transportiert ein verschlüsseltes TURN-Relay Chiffretext, den es nicht lesen kann.",
        "Für alle, die Übertragungen zu einem Server skripten wollen, gibt es außerdem eine CLI — push/pull über SSH oder direkt zum Daemon, inkrementelle Ordnersynchronisation und Senden/Empfangen per Pairing-Code — etwas, das eine reine LAN-App nicht bietet.",
      ],
    },
    {
      heading: "Wann LocalSend die bessere Wahl ist",
      body: [
        "Wenn du überhaupt keinen Browser öffnen willst — etwa weil du Dateien in einem Netz ohne jeglichen Internetzugang bewegst, oder du einfach ein dauerhaftes App-Symbol und OS-Share-Sheet-Integration möchtest — passt LocalSends eigene App besser. Sie ist ausgereift, funktioniert im striktesten Sinn vollständig offline, und ihr PIN-Modus ist eine nette zusätzliche Schicht in Netzwerken, denen du nicht vollständig vertraust.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Installation: LocalSend braucht eine App auf jedem Gerät; Relayiums Modus im selben Netz braucht nichts außer einem Browser.",
        "Netzwerkreichweite: LocalSend ist rein lokal; Relayium verbindet auch über verschiedene Netzwerke hinweg per Pairing-Code.",
        "Verschlüsselung: LocalSend sichert seinen lokalen Transport; Relayium fügt selbst im LAN einen unabhängigen Kanal auf Anwendungsebene mit X25519 + AES-256-GCM und einem SAS-Prüfcode hinzu.",
        "Konten: LocalSend braucht nie eines; Relayiums LAN-Modus ebenso wenig — nur bei netzwerkübergreifenden Übertragungen meldet sich der Absender an.",
        "Automatisierung: Relayium bietet eine CLI für SSH-push/pull, inkrementelle Synchronisation und einen dauerhaften Empfangsdienst; LocalSend gibt es nur als App.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss ich etwas installieren, um Relayium im selben Netz zu nutzen?",
        a: "Nein. Öffne relayium.com im Browser auf beiden Geräten, während sie im selben Netz sind — sie sehen sich automatisch, ohne App, ohne Konto, ohne Pairing-Code.",
      },
      {
        q: "Braucht LocalSend eine Internetverbindung?",
        a: "Nein — das ist eine seiner Stärken. LocalSend funktioniert vollständig über das lokale Netz, ganz ohne Server, und läuft daher auch ohne jeden Internetzugang weiter.",
      },
      {
        q: "Kann Relayium Dateien an jemanden in einem anderen Netzwerk senden?",
        a: "Ja. Erstelle einen Pairing-Code (oder teile den daraus erzeugten Beitrittslink), und das andere Gerät verbindet sich von überall — weiterhin nach Möglichkeit direkt Peer-to-Peer. Dafür muss sich der Absender anmelden, der Empfänger nie.",
      },
      {
        q: "Ist Relayium quelloffen?",
        a: "Ja, MIT-lizenziert, das vollständige Protokoll samt Code ist öffentlich unter github.com/relayium/relayium — dieselbe Art von Offenheit, die LocalSend vertrauenswürdig macht.",
      },
      {
        q: "Welches ist privater?",
        a: "Beide halten Übertragungen im selben Netz von einem öffentlichen Server fern. LocalSend sichert seinen lokalen Transport selbst. Relayium fügt zusätzlich, im LAN wie netzwerkübergreifend, einen unabhängigen Verschlüsselungskanal auf Anwendungsebene mit einem beidseitig prüfbaren SAS-Code hinzu.",
      },
    ],
  },
  cta: {
    text: "Erlebe, wie sich eine Übertragung im selben Netz ohne jede Installation anfühlt — öffne die Seite einfach auf beiden Geräten.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs LocalSend : quel transfert local choisir",
  description:
    "Un comparatif honnête de Relayium et LocalSend. LocalSend est une excellente application open source installée sur chaque appareil ; Relayium fait le même transfert local dans le navigateur — sans installation — plus entre réseaux et en CLI.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "LocalSend est une application vraiment bonne et appréciée : gratuite, open source, multiplateforme, conçue pour déplacer des fichiers entre appareils du même réseau local, sans jamais avoir besoin de serveur ni de compte. Beaucoup s'en servent comme d'un AirDrop pour Windows, Linux et Android.",
    "Cet article la compare équitablement à Relayium, qui aborde le même problème de réseau local autrement — rien à installer, ça tourne directement dans le navigateur — puis va plus loin en atteignant d'autres réseaux et en proposant un outil en ligne de commande que LocalSend n'a pas.",
  ],
  sections: [
    {
      heading: "Ce que LocalSend fait bien",
      body: [
        "LocalSend est une application gratuite et open source pour Windows, macOS, Linux, Android et iOS. Installée une fois sur chaque appareil, elle découvre automatiquement les autres instances de LocalSend sur le même Wi-Fi ou réseau local via un transport local chiffré — aucun serveur nulle part, aucune connexion internet requise, aucun compte.",
        "Elle prend en charge le glisser-déposer, l'envoi de dossiers entiers, et un code PIN optionnel pour envoyer sur des réseaux auxquels on ne fait pas entièrement confiance.",
      ],
      bullets: [
        "Applications natives multiplateformes pour Windows, macOS, Linux, Android et iOS — installée une fois, ça fonctionne simplement.",
        "Entièrement hors ligne par conception : aucun serveur, aucune connexion internet, aucun compte — il suffit que les appareils soient sur le même réseau local.",
        "Protection PIN optionnelle pour envoyer sur des réseaux non fiables, plus le glisser-déposer et le transfert de dossiers entiers.",
        "Une icône d'application dédiée et une intégration au partage natif du système, ce qu'un onglet de navigateur ne peut pas offrir.",
      ],
    },
    {
      heading: "Là où Relayium diffère : rien à installer, directement dans le navigateur",
      body: [
        "Relayium prend l'approche inverse pour le même problème de réseau local : au lieu d'installer une application sur chaque appareil, vous ouvrez relayium.com dans un navigateur que vous avez déjà. Deux appareils sur le même réseau se retrouvent automatiquement dans la même salle — le serveur déduit la salle du réseau partagé, sans code d'appairage ni compte des deux côtés.",
        "Cette salle locale accueille autant d'appareils que nécessaire, pas seulement une paire, et le glisser-déposer ou la sélection de dossier fonctionnent comme avec une application native — sans l'étape d'installation.",
      ],
    },
    {
      heading: "Au-delà du réseau local : transfert entre réseaux et CLI",
      body: [
        "LocalSend est conçu uniquement pour le réseau local — il n'a aucun moyen d'atteindre un appareil sur un autre réseau ou via internet. Relayium ajoute cela : créez un code d'appairage (ou partagez le lien de participation qu'il génère), et l'autre côté se connecte depuis n'importe où, en pair-à-pair direct chaque fois que possible.",
        "Créer un code d'appairage entre réseaux exige que l'expéditeur se connecte ; le destinataire n'a jamais besoin de compte. Chaque transfert en temps réel — sur le réseau local ou entre réseaux — est chiffré de bout en bout au niveau applicatif : un échange de clés X25519 dérive une clé utilisée pour AES-256-GCM, un code SAS à 6 chiffres permet aux deux parties de confirmer qu'aucun serveur ne s'intercale, et chaque fichier est vérifié par une empreinte SHA-256. Quand une connexion directe est impossible, un relais TURN chiffré transporte un texte chiffré qu'il ne peut pas lire.",
        "Pour qui veut scripter des transferts vers un serveur, il existe aussi une CLI — push/pull via SSH ou en direct vers le démon, synchronisation incrémentale de dossiers, envoi/réception par code d'appairage — ce qu'une application limitée au réseau local n'offre pas.",
      ],
    },
    {
      heading: "Quand LocalSend est le meilleur choix",
      body: [
        "Si vous ne voulez jamais ouvrir de navigateur — par exemple pour déplacer des fichiers sur un réseau réellement sans accès internet, ou si vous voulez simplement une icône d'application permanente et l'intégration au partage du système — l'application dédiée de LocalSend convient mieux. Elle est mature, fonctionne entièrement hors ligne au sens le plus strict, et son mode PIN est une bonne couche supplémentaire sur des réseaux auxquels vous ne faites pas entièrement confiance.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "Installation : LocalSend nécessite une application sur chaque appareil ; le mode même réseau de Relayium ne nécessite rien d'autre qu'un navigateur.",
        "Portée réseau : LocalSend est limité au réseau local ; Relayium se connecte aussi entre réseaux différents via un code d'appairage.",
        "Chiffrement : LocalSend sécurise son transport local ; Relayium ajoute, même sur le réseau local, un canal indépendant au niveau applicatif en X25519 + AES-256-GCM avec un code de vérification SAS.",
        "Comptes : LocalSend n'en demande jamais ; le mode réseau local de Relayium non plus — seul l'expéditeur se connecte pour les transferts entre réseaux.",
        "Automatisation : Relayium propose une CLI pour push/pull SSH, synchronisation incrémentale et un service de réception permanent ; LocalSend n'existe qu'en application.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je installer quelque chose pour utiliser Relayium sur le même réseau ?",
        a: "Non. Ouvrez relayium.com dans un navigateur sur les deux appareils pendant qu'ils sont sur le même réseau : ils se voient automatiquement — sans application, sans compte, sans code d'appairage.",
      },
      {
        q: "LocalSend a-t-il besoin d'une connexion internet ?",
        a: "Non — c'est l'une de ses forces. LocalSend fonctionne entièrement sur le réseau local sans aucun serveur impliqué, donc il continue de fonctionner même sans internet du tout.",
      },
      {
        q: "Relayium peut-il envoyer des fichiers à quelqu'un sur un réseau différent ?",
        a: "Oui. Créez un code d'appairage (ou partagez le lien de participation qu'il génère) et l'autre appareil se connecte depuis n'importe où, toujours en pair-à-pair direct chaque fois que possible. L'expéditeur doit se connecter pour cela ; le destinataire jamais.",
      },
      {
        q: "Relayium est-il open source ?",
        a: "Oui, sous licence MIT, avec l'intégralité du protocole et du code publique sur github.com/relayium/relayium — le même genre d'ouverture qui rend LocalSend digne de confiance.",
      },
      {
        q: "Lequel est le plus privé ?",
        a: "Les deux gardent les transferts sur le même réseau hors d'un serveur public. LocalSend sécurise son transport local. Relayium ajoute, sur le réseau local comme entre réseaux, un canal de chiffrement indépendant au niveau applicatif avec un code SAS vérifiable des deux côtés.",
      },
    ],
  },
  cta: {
    text: "Découvrez ce que donne un transfert sur le même réseau sans rien installer — ouvrez simplement la page sur les deux appareils.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "compare/localsend",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr },
};
