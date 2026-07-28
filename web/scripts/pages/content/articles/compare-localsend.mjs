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
        "LocalSend is local-network only by design — it has no way to reach a device on a different network or across the internet. Relayium adds that: create a pairing code (or share the join link it generates), and the other side connects from anywhere. In the browser, that cross-network hop deliberately runs over an encrypted TURN relay rather than hunting for a direct route — relay-only ICE brings the connection up in a second or two, instead of burning around 20 seconds on cross-NAT direct-candidate checks that would almost always fail anyway.",
        "Creating a cross-network pairing code requires the sender to sign in; the person receiving never needs an account. Every realtime transfer — LAN or cross-network — is encrypted end-to-end at the application layer: an X25519 key exchange derives a key used for AES-256-GCM, a 6-digit SAS code lets both sides confirm nobody has slipped into the key exchange, and each file is verified with a SHA-256 hash. Same-network transfers connect straight between the two devices; on the cross-network path the relay only ever forwards ciphertext, so it cannot read a byte of your file.",
        "For anyone scripting transfers to a server, there's also a CLI — push/pull over SSH or daemon-direct, incremental folder sync, and send/receive by pairing code — something a LAN-only app doesn't offer. The CLI always connects directly; it never uses a relay.",
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
        "Network reach: LocalSend is local-network only; Relayium also connects across different networks with a pairing code — in the browser that hop runs over an encrypted relay, while the CLI connects directly.",
        "Encryption: LocalSend secures its local transport; Relayium adds an independent application-layer X25519 + AES-256-GCM channel with a SAS verification code, even on the LAN.",
        "Accounts: LocalSend never needs one; Relayium's LAN mode needs none either — only the side that creates the pairing code signs in, and only to create it.",
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
        a: "Yes. Create a pairing code (or share the join link it generates) and the other device connects from anywhere. In the browser that cross-network connection is carried by an encrypted TURN relay by design, so it comes up in a second or two instead of waiting on direct-connection attempts that rarely succeed between two home networks; the relay forwards ciphertext and cannot read your files. Creating the code requires signing in; the person you hand it to never does.",
      },
      {
        q: "Is Relayium open source?",
        a: "Yes, AGPL-3.0-licensed, with the full protocol and code public at github.com/relayium/relayium — the same kind of openness that makes LocalSend trustworthy.",
      },
      {
        q: "Which one is more private?",
        a: "Both keep same-network transfers off a public server — on the LAN, Relayium's two devices talk directly to each other. LocalSend secures its local transport; Relayium adds an independent, application-layer encryption channel with a SAS code both sides can verify, on the LAN or across networks, which is why the relay on the cross-network path only ever sees ciphertext.",
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
    "LocalSend 是一款真正优秀、深受喜爱的应用：免费、开源、跨平台，专为在同一局域网设备间传输文件而生，始终无需服务器、无需账号。不少人把它当作 Windows、Linux、Android 上的 AirDrop 替代品来用。",
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
        "LocalSend 在设计上只面向局域网——它没有办法连到不同网络或跨互联网的设备。Relayium 补上了这一块：创建一个配对码（或分享它生成的加入链接），对方就能从任何地方连接进来。在浏览器里，这条跨网络通道是刻意走加密 TURN 中继的，而不是先去碰运气试直连：把 ICE 限定为 relay-only，连接一两秒就能建立，省下大约 20 秒——那段时间本来会耗在几乎注定失败的跨 NAT 直连候选探测上。",
        "创建跨网络配对码需要发送方登录；接收方始终无需账号。每一次实时传输——无论局域网还是跨网络——都在应用层做端到端加密：X25519 密钥交换协商出用于 AES-256-GCM 的密钥，双方还会显示同一个 6 位 SAS 校验码以确认没有人插手密钥交换，每个文件都用 SHA-256 做校验。同一网络内的传输是两台设备直连；跨网络这条路上的中继只转发密文，读不到文件里的任何一个字节。",
        "如果你需要把传输写进脚本发往服务器，Relayium 还提供命令行工具——通过 SSH 或 daemon 直连做 push/pull、增量同步文件夹、用配对码 send/receive——这些都是纯局域网应用做不到的。命令行工具始终直连，从不走中继。",
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
        "网络覆盖：LocalSend 只能在局域网内使用；Relayium 还能用配对码连接不同网络——浏览器里这一跳走的是加密中继，命令行工具则始终直连。",
        "加密：LocalSend 保护的是本地传输通道；Relayium 即便在局域网内也会额外加一层独立的应用层 X25519 + AES-256-GCM 通道，并带 SAS 校验码。",
        "账号：LocalSend 从不需要账号；Relayium 的局域网模式同样无需账号——只有创建配对码的一方需要登录，而且仅为创建配对码。",
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
        a: "可以。创建一个配对码（或分享它生成的加入链接），对方就能从任何地方连接进来。在浏览器里，这条跨网络连接刻意由加密 TURN 中继承载，因此一两秒就能接通，不必去等两个家庭网络之间很难成功的直连尝试；中继转发的是密文，读不到你的文件。创建配对码需要登录，拿到配对码的一方始终不需要。",
      },
      {
        q: "Relayium 是开源的吗？",
        a: "是的，采用 AGPL-3.0 许可证，完整的协议与代码都公开在 github.com/relayium/relayium——这正是让 LocalSend 值得信任的同一种开放。",
      },
      {
        q: "哪一个更私密？",
        a: "两者都能让同网络传输不经过公网服务器：在局域网内，Relayium 的两台设备是彼此直连的。LocalSend 保护的是它的本地传输通道；Relayium 则无论是在局域网还是跨网络，都额外加了一层独立的应用层加密通道，并带有双方可核对的 SAS 校验码——也正因如此，跨网络路径上的中继只能看到密文。",
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
    "Relayium と LocalSend を公平に比較。LocalSend は各端末にインストールする優れたオープンソースアプリ。Relayium は同じ LAN 転送をブラウザだけで実現し（インストール不要）、さらにネットワークをまたぐ転送と CLI も備えます。",
  updatedLabel: "最終更新",
  lead: [
    "LocalSend は本当に優れた、愛用者の多いアプリです。無料でオープンソース、クロスプラットフォームで、同じローカルネットワーク上の端末間でファイルを転送するために作られており、サーバーもアカウントも一切必要ありません。Windows・Linux・Android 向けの AirDrop 的なツールとして頼りにしている人も多くいます。",
    "本記事はこれを Relayium と公平に比較します。Relayium は同じ「同一ネットワーク」という課題を別のやり方で解決します。アプリのインストールは不要で、ブラウザの中でそのまま動きます。そしてさらに一歩進んで、ネットワークをまたいだ転送や、LocalSend にはない CLI ツールも提供します。",
  ],
  sections: [
    {
      heading: "LocalSend が優れている点",
      body: [
        "LocalSend は Windows、macOS、Linux、Android、iOS 向けの無料オープンソースアプリです。各端末に一度インストールすれば、暗号化されたローカル転送を使って同じ Wi-Fi や LAN 上の他の LocalSend インスタンスを自動的に発見します。サーバーはどこにもなく、インターネット接続もアカウントも不要です。",
        "ドラッグ&ドロップ、フォルダ丸ごとの送信に対応し、完全には信頼できないネットワークで送る際には任意の PIN 保護も使えます。",
      ],
      bullets: [
        "Windows、macOS、Linux、Android、iOS 向けのクロスプラットフォームなネイティブアプリです。一度インストールすればそのまま使えます。",
        "設計上完全にオフラインです。サーバーなし、インターネット接続不要、アカウント不要で、同じローカルネットワークにいる端末だけが条件です。",
        "信頼できないネットワークで送る際の任意の PIN 保護に加え、ドラッグ&ドロップとフォルダ丸ごとの転送に対応します。",
        "専用のアプリアイコンと OS レベルの共有シート統合があり、これはブラウザのタブでは得られません。",
      ],
    },
    {
      heading: "Relayium の違い：インストール不要、そのままブラウザで",
      body: [
        "Relayium は同じ「同一ネットワーク」の課題に正反対のアプローチを取ります。すべての端末にアプリをインストールする代わりに、すでに持っているブラウザで relayium.com を開くだけです。同じネットワーク上の2台の端末は自動的に同じルームに入ります。サーバーが共有ネットワークからルームを判定するため、どちらの側もペアリングコードもアカウントも不要です。",
        "この LAN ルームは一対一だけでなく何台でも同時に参加でき、ドラッグ&ドロップやフォルダ選択もネイティブアプリと同じように動作します。インストールという手順が省けるだけです。",
      ],
    },
    {
      heading: "LAN を越えて：ネットワークをまたぐ転送と CLI",
      body: [
        "LocalSend は設計上ローカルネットワーク限定です。異なるネットワークやインターネット越しの端末に届く手段がありません。Relayium はこれを補います。ペアリングコード（またはそれが生成する参加リンク）を作れば、相手はどこからでも接続できます。ブラウザでは、このネットワークをまたぐ経路は直接ルートを探しにいくのではなく、あえて暗号化された TURN リレー経由で運ばれます。ICE を relay 限定にすることで、ほぼ確実に失敗する NAT 越えの直接候補チェックに約20秒を費やす代わりに、1〜2秒で接続が確立します。",
        "ネットワークをまたぐペアリングコードの作成には送信側のサインインが必要です。受信側はアカウント不要です。LAN でもネットワークをまたぐ場合でも、すべてのリアルタイム転送はアプリケーション層でエンドツーエンド暗号化されます。X25519 の鍵交換で AES-256-GCM 用の鍵を導出し、両端末が同じ6桁の SAS コードを表示して鍵交換に誰も割り込んでいないことを確認でき、各ファイルは SHA-256 ハッシュで検証されます。同一ネットワーク内の転送は2台の端末が直接つながります。ネットワークをまたぐ経路のリレーが中継するのは暗号文だけなので、ファイルの中身は1バイトも読めません。",
        "サーバーへの転送をスクリプト化したい人向けに CLI もあります。SSH またはデーモン直結での push/pull、フォルダの増分同期、ペアリングコードによる送受信は、LAN 専用アプリにはできないことです。CLI は常に直接接続で、リレーは一切使いません。",
      ],
    },
    {
      heading: "LocalSend の方が良い場合",
      body: [
        "そもそもブラウザを開きたくない場合、たとえば本当にインターネット接続のないネットワークでファイルを移動する、あるいは常駐するアプリアイコンや OS の共有シート統合が欲しいだけ、といった場合は、LocalSend の専用アプリの方が合っています。成熟しており、最も厳密な意味で完全にオフラインで動作し、その PIN モードは完全には信頼できないネットワークでの良い追加の保護層になります。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "インストール：LocalSend は各端末にアプリが必要です。Relayium の同一ネットワークモードはブラウザ以外に何も要りません。",
        "ネットワークの到達範囲：LocalSend はローカルネットワーク限定です。Relayium はペアリングコードで異なるネットワークにも接続でき、ブラウザではその区間は暗号化されたリレー経由、CLI は常に直接接続です。",
        "暗号化：LocalSend はローカル転送そのものを保護します。Relayium は LAN 内でも独立したアプリケーション層の X25519 + AES-256-GCM チャネルと SAS 検証コードを追加します。",
        "アカウント：LocalSend は決して不要です。Relayium の LAN モードも同様に不要で、ペアリングコードを作る側だけが、作成のためにサインインします。",
        "自動化：Relayium は SSH push/pull、増分同期、常駐の受信サービス向けの CLI を提供します。LocalSend はアプリのみです。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "同じネットワークで Relayium を使うのに何かインストールが必要ですか？",
        a: "いいえ。同じネットワーク上にある間に両方の端末のブラウザで relayium.com を開けば、自動的にお互いを見つけます。アプリ不要、アカウント不要、ペアリングコード不要です。",
      },
      {
        q: "LocalSend はインターネット接続が必要ですか？",
        a: "いいえ。それが強みの一つです。LocalSend はサーバーを一切介さずローカルネットワークだけで動作するため、インターネットが全くない環境でも動き続けます。",
      },
      {
        q: "Relayium は異なるネットワークの相手にファイルを送れますか？",
        a: "はい。ペアリングコード（またはそれが生成する参加リンク）を作れば、相手はどこからでも接続できます。ブラウザでは、このネットワークをまたぐ接続は設計上、暗号化された TURN リレーが担います。そのため、家庭のネットワーク同士ではめったに成功しない直接接続の試行を待たずに、1〜2秒でつながります。リレーが中継するのは暗号文だけなので、ファイルを読むことはできません。コードの作成にはサインインが必要で、コードを受け取った相手は不要です。",
      },
      {
        q: "Relayium はオープンソースですか？",
        a: "はい、AGPL-3.0 ライセンスで、プロトコルとコードの全体が github.com/relayium/relayium で公開されています。LocalSend を信頼できるものにしているのと同じ種類の開放性です。",
      },
      {
        q: "どちらがより秘匿性が高いですか？",
        a: "どちらも同一ネットワーク内の転送を公開サーバーの外に保ちます。LAN では Relayium の2台の端末が直接やり取りします。LocalSend はローカル転送そのものを保護します。Relayium はさらに、LAN でもネットワークをまたいでも、両端末で確認できる SAS コード付きの独立したアプリケーション層暗号化チャネルを追加します。だからこそ、ネットワークをまたぐ経路のリレーには暗号文しか見えません。",
      },
    ],
  },
  cta: {
    text: "何もインストールせずに同一ネットワーク転送を体験してみましょう。両方の端末でページを開くだけです。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs LocalSend: 로컬 파일 전송, 무엇을 쓸까",
  description:
    "Relayium과 LocalSend를 공정하게 비교합니다. LocalSend는 각 기기에 설치하는 훌륭한 오픈소스 앱이고, Relayium은 같은 LAN 전송을 브라우저에서(설치 없이) 해내며 네트워크를 넘나드는 전송과 CLI까지 제공합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "LocalSend는 정말 훌륭하고 사랑받는 앱입니다. 무료, 오픈소스, 크로스플랫폼이며 같은 로컬 네트워크의 기기 사이에서 파일을 옮기도록 만들어졌고, 서버도 계정도 전혀 필요 없습니다. Windows, Linux, Android용 AirDrop 같은 도구로 많은 사람이 의지하고 있습니다.",
    "이 글은 이를 Relayium과 공정하게 비교합니다. Relayium은 같은 ‘동일 네트워크’ 문제를 다른 방식으로 풉니다. 설치할 앱이 없고 브라우저 안에서 바로 동작합니다. 그리고 한 걸음 더 나아가 네트워크를 넘나드는 전송과, LocalSend에는 없는 CLI 도구까지 제공합니다.",
  ],
  sections: [
    {
      heading: "LocalSend가 잘하는 것",
      body: [
        "LocalSend는 Windows, macOS, Linux, Android, iOS용 무료 오픈소스 앱입니다. 각 기기에 한 번 설치하면 암호화된 로컬 전송을 사용해 같은 Wi-Fi나 LAN에 있는 다른 LocalSend 인스턴스를 자동으로 찾습니다. 어디에도 서버가 없고, 인터넷 연결도 계정도 필요 없습니다.",
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
        "Relayium은 같은 ‘동일 네트워크’ 문제에 정반대로 접근합니다. 모든 기기에 앱을 설치하는 대신, 이미 가지고 있는 브라우저로 relayium.com을 엽니다. 같은 네트워크의 두 기기는 자동으로 같은 방에 들어갑니다 — 서버가 공유 네트워크로부터 방을 판단하므로 양쪽 모두 페어링 코드도 계정도 필요 없습니다.",
        "이 LAN 방은 한 쌍뿐 아니라 몇 대든 동시에 수용하며, 드래그 앤 드롭이나 폴더 선택도 네이티브 앱과 똑같이 동작합니다 — 설치 단계만 없을 뿐입니다.",
      ],
    },
    {
      heading: "LAN을 넘어서: 네트워크 간 전송과 CLI",
      body: [
        "LocalSend는 설계상 로컬 네트워크 전용입니다 — 다른 네트워크나 인터넷 너머의 기기에 닿을 방법이 없습니다. Relayium은 이를 더합니다. 페어링 코드(또는 그것이 생성하는 참여 링크)를 만들면 상대는 어디서든 연결할 수 있습니다. 브라우저에서 이 네트워크 간 경로는 직접 경로를 찾아 헤매는 대신 일부러 암호화된 TURN 릴레이를 거칩니다. ICE를 릴레이 전용으로 고정하면, 거의 실패할 수밖에 없는 NAT 너머 직접 후보 검사에 약 20초를 쓰는 대신 1~2초 만에 연결이 올라옵니다.",
        "네트워크를 넘나드는 페어링 코드를 만들려면 보내는 쪽의 로그인이 필요합니다. 받는 쪽은 계정이 전혀 필요 없습니다. LAN이든 네트워크를 넘나들든 모든 실시간 전송은 애플리케이션 계층에서 종단간 암호화됩니다. X25519 키 교환으로 AES-256-GCM에 쓸 키를 유도하고, 양쪽 기기가 동일한 6자리 SAS 코드를 표시해 키 교환에 끼어든 사람이 없음을 확인할 수 있으며, 각 파일은 SHA-256 해시로 검증됩니다. 같은 네트워크의 전송은 두 기기가 곧바로 연결됩니다. 네트워크 간 경로의 릴레이는 암호문만 전달하므로 파일 내용은 한 바이트도 읽지 못합니다.",
        "서버로의 전송을 스크립트화하려는 사람을 위한 CLI도 있습니다 — SSH 또는 데몬 다이렉트로 push/pull, 폴더 증분 동기화, 페어링 코드로 송수신 — LAN 전용 앱에는 없는 기능입니다. CLI는 항상 직접 연결하며 릴레이를 쓰지 않습니다.",
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
        "설치: LocalSend는 모든 기기에 앱이 필요함. Relayium의 동일 네트워크 모드는 브라우저 외에 아무것도 필요 없음.",
        "네트워크 도달 범위: LocalSend는 로컬 네트워크 전용임. Relayium은 페어링 코드로 다른 네트워크에도 연결됨 — 브라우저에서는 그 구간이 암호화된 릴레이를 거치고, CLI는 항상 직접 연결함.",
        "암호화: LocalSend는 로컬 전송 자체를 보호함. Relayium은 LAN에서도 독립적인 애플리케이션 계층 X25519 + AES-256-GCM 채널과 SAS 검증 코드를 추가함.",
        "계정: LocalSend는 절대 필요 없음. Relayium의 LAN 모드도 마찬가지 — 페어링 코드를 만드는 쪽만, 코드를 만들기 위해 로그인함.",
        "자동화: Relayium은 SSH push/pull, 증분 동기화, 상시 수신 서비스를 위한 CLI를 제공함. LocalSend는 앱뿐임.",
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
        a: "네. 페어링 코드(또는 그것이 생성하는 참여 링크)를 만들면 상대는 어디서든 연결할 수 있습니다. 브라우저에서 이 네트워크 간 연결은 설계상 암호화된 TURN 릴레이가 담당합니다. 덕분에 가정용 네트워크 사이에서는 좀처럼 성공하지 않는 직접 연결 시도를 기다리지 않고 1~2초 만에 연결됩니다. 릴레이는 암호문만 전달하므로 파일을 읽을 수 없습니다. 코드를 만들려면 로그인이 필요하고, 코드를 건네받은 쪽은 필요 없습니다.",
      },
      {
        q: "Relayium은 오픈소스인가요?",
        a: "네, AGPL-3.0 라이선스이며 프로토콜과 코드 전체가 github.com/relayium/relayium에 공개되어 있습니다 — LocalSend를 신뢰할 수 있게 만든 것과 같은 종류의 개방성입니다.",
      },
      {
        q: "어느 쪽이 더 사적인가요?",
        a: "둘 다 동일 네트워크 전송을 공개 서버 밖에 둡니다. LAN에서는 Relayium의 두 기기가 서로 직접 주고받습니다. LocalSend는 로컬 전송 자체를 보호합니다. Relayium은 LAN이든 네트워크를 넘나들든 양쪽에서 확인할 수 있는 SAS 코드가 붙은 독립적인 애플리케이션 계층 암호화 채널을 추가로 제공합니다 — 그래서 네트워크 간 경로의 릴레이에는 암호문만 보입니다.",
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
        "LocalSend ist von Grund auf nur fürs lokale Netz gedacht — es gibt keine Möglichkeit, ein Gerät in einem anderen Netzwerk oder über das Internet zu erreichen. Relayium fügt das hinzu: Erstelle einen Pairing-Code (oder teile den daraus erzeugten Beitrittslink), und die Gegenseite verbindet sich von überall. Im Browser läuft dieser netzwerkübergreifende Weg bewusst über ein verschlüsseltes TURN-Relay, statt nach einer Direktverbindung zu suchen: Auf reines Relay-ICE festgelegt, steht die Verbindung in ein bis zwei Sekunden, statt rund 20 Sekunden für Direktkandidaten-Prüfungen über NAT-Grenzen hinweg zu verbrauchen, die ohnehin fast immer scheitern.",
        "Für einen netzwerkübergreifenden Pairing-Code muss sich der Absender anmelden; die empfangende Person braucht nie ein Konto. Jede Echtzeitübertragung — im LAN oder netzwerkübergreifend — ist auf Anwendungsebene Ende-zu-Ende-verschlüsselt: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM ab, ein sechsstelliger SAS-Code lässt beide Seiten bestätigen, dass sich niemand in den Schlüsselaustausch geschoben hat, und jede Datei wird per SHA-256-Hash geprüft. Übertragungen im selben Netz laufen direkt zwischen den beiden Geräten; auf dem netzwerkübergreifenden Weg leitet das Relay ausschließlich Chiffretext weiter und kann kein Byte deiner Datei lesen.",
        "Für alle, die Übertragungen zu einem Server skripten wollen, gibt es außerdem eine CLI — push/pull über SSH oder daemon-direct, inkrementelle Ordnersynchronisation und Senden/Empfangen per Pairing-Code — etwas, das eine reine LAN-App nicht bietet. Die CLI verbindet sich immer direkt und nutzt nie ein Relay.",
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
        "Netzwerkreichweite: LocalSend ist rein lokal; Relayium verbindet auch über verschiedene Netzwerke hinweg per Pairing-Code — im Browser läuft diese Strecke über ein verschlüsseltes Relay, die CLI verbindet immer direkt.",
        "Verschlüsselung: LocalSend sichert seinen lokalen Transport; Relayium fügt selbst im LAN einen unabhängigen Kanal auf Anwendungsebene mit X25519 + AES-256-GCM und einem SAS-Verifizierungscode hinzu.",
        "Konten: LocalSend braucht nie eines; Relayiums LAN-Modus ebenso wenig — nur wer den Pairing-Code erstellt, meldet sich an, und auch nur dafür.",
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
        a: "Ja. Erstelle einen Pairing-Code (oder teile den daraus erzeugten Beitrittslink), und das andere Gerät verbindet sich von überall. Im Browser übernimmt diese netzwerkübergreifende Verbindung planmäßig ein verschlüsseltes TURN-Relay: Sie steht damit in ein bis zwei Sekunden, statt auf Direktverbindungsversuche zu warten, die zwischen zwei Heimnetzen selten gelingen. Das Relay leitet nur Chiffretext weiter und kann deine Dateien nicht lesen. Zum Erstellen des Codes musst du angemeldet sein; wer den Code bekommt, nie.",
      },
      {
        q: "Ist Relayium quelloffen?",
        a: "Ja, AGPL-3.0-lizenziert, das vollständige Protokoll samt Code ist öffentlich unter github.com/relayium/relayium — dieselbe Art von Offenheit, die LocalSend vertrauenswürdig macht.",
      },
      {
        q: "Welches ist privater?",
        a: "Beide halten Übertragungen im selben Netz von einem öffentlichen Server fern — im LAN sprechen Relayiums zwei Geräte direkt miteinander. LocalSend sichert seinen lokalen Transport selbst. Relayium fügt zusätzlich, im LAN wie netzwerkübergreifend, einen unabhängigen Verschlüsselungskanal auf Anwendungsebene mit einem beidseitig prüfbaren SAS-Code hinzu — deshalb sieht das Relay auf dem netzwerkübergreifenden Weg ausschließlich Chiffretext.",
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
  title: "Relayium vs LocalSend : quel transfert local choisir",
  description:
    "Un comparatif honnête de Relayium et LocalSend. LocalSend est une excellente application open source installée sur chaque appareil ; Relayium fait le même transfert local dans le navigateur — sans installation — plus entre réseaux et en CLI.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "LocalSend est une application vraiment bonne et appréciée : gratuite, open source, multiplateforme, conçue pour déplacer des fichiers entre appareils du même réseau local, sans jamais avoir besoin de serveur ni de compte. Beaucoup s'en servent comme d'un AirDrop pour Windows, Linux et Android.",
    "Cet article la compare équitablement à Relayium, qui aborde le même problème de réseau local autrement — rien à installer, cela tourne directement dans le navigateur — puis va plus loin en atteignant d'autres réseaux et en proposant un outil en ligne de commande que LocalSend n'a pas.",
  ],
  sections: [
    {
      heading: "Ce que LocalSend fait bien",
      body: [
        "LocalSend est une application gratuite et open source pour Windows, macOS, Linux, Android et iOS. Installée une fois sur chaque appareil, elle découvre automatiquement les autres instances de LocalSend sur le même Wi-Fi ou réseau local via un transport local chiffré — aucun serveur nulle part, aucune connexion internet requise, aucun compte.",
        "Elle prend en charge le glisser-déposer, l'envoi de dossiers entiers, et un code PIN optionnel pour envoyer sur des réseaux auxquels on ne fait pas entièrement confiance.",
      ],
      bullets: [
        "Applications natives multiplateformes pour Windows, macOS, Linux, Android et iOS — installée une fois, cela fonctionne simplement.",
        "Entièrement hors ligne par conception : aucun serveur, aucune connexion internet, aucun compte — il suffit que les appareils soient sur le même réseau local.",
        "Protection PIN optionnelle pour envoyer sur des réseaux non fiables, plus le glisser-déposer et le transfert de dossiers entiers.",
        "Une icône d'application dédiée et une intégration au partage natif du système, ce qu'un onglet de navigateur ne peut pas offrir.",
      ],
    },
    {
      heading: "Là où Relayium diffère : rien à installer, directement dans le navigateur",
      body: [
        "Relayium prend l'approche inverse pour le même problème de réseau local : au lieu d'installer une application sur chaque appareil, vous ouvrez relayium.com dans un navigateur que vous avez déjà. Deux appareils sur le même réseau se retrouvent automatiquement dans la même salle — le serveur déduit la salle du réseau partagé, sans code d'appairage ni compte des deux côtés.",
        "Cette salle locale accueille autant d'appareils que nécessaire, pas seulement une paire, et le glisser-déposer ou la sélection de dossier fonctionnent comme avec une application native — sans l'étape d'installation.",
      ],
    },
    {
      heading: "Au-delà du réseau local : transfert entre réseaux et CLI",
      body: [
        "LocalSend est conçu uniquement pour le réseau local — il n'a aucun moyen d'atteindre un appareil sur un autre réseau ou via internet. Relayium ajoute cela : créez un code d'appairage (ou partagez le lien de participation qu'il génère), et l'autre côté se connecte depuis n'importe où. Dans le navigateur, ce trajet entre réseaux passe volontairement par un relais TURN chiffré au lieu de chercher une route directe : en forçant un ICE en relais seul, la connexion s'établit en une ou deux secondes au lieu de consacrer une vingtaine de secondes à des tests de candidats directs à travers les NAT, qui échouent presque toujours.",
        "Créer un code d'appairage entre réseaux exige que l'expéditeur se connecte ; le destinataire n'a jamais besoin de compte. Chaque transfert en temps réel — sur le réseau local ou entre réseaux — est chiffré de bout en bout au niveau applicatif : un échange de clés X25519 dérive une clé utilisée pour AES-256-GCM, un code SAS à 6 chiffres permet aux deux parties de confirmer que personne ne s'est glissé dans l'échange de clés, et chaque fichier est vérifié par une empreinte SHA-256. Les transferts sur le même réseau relient les deux appareils en direct ; sur le trajet entre réseaux, le relais ne transporte que du texte chiffré et ne peut pas lire un seul octet de votre fichier.",
        "Pour qui veut scripter des transferts vers un serveur, il existe aussi une CLI — push/pull via SSH ou en daemon-direct, synchronisation incrémentale de dossiers, envoi/réception par code d'appairage — ce qu'une application limitée au réseau local n'offre pas. La CLI, elle, se connecte toujours en direct et n'utilise jamais de relais.",
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
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "Installation : LocalSend nécessite une application sur chaque appareil ; le mode même réseau de Relayium ne nécessite rien d'autre qu'un navigateur.",
        "Portée réseau : LocalSend est limité au réseau local ; Relayium se connecte aussi entre réseaux différents via un code d'appairage — dans le navigateur, ce trajet passe par un relais chiffré, tandis que la CLI se connecte toujours en direct.",
        "Chiffrement : LocalSend sécurise son transport local ; Relayium ajoute, même sur le réseau local, un canal indépendant au niveau applicatif en X25519 + AES-256-GCM avec un code de vérification SAS.",
        "Comptes : LocalSend n'en demande jamais ; le mode réseau local de Relayium non plus — seule la personne qui crée le code d'appairage se connecte, et uniquement pour le créer.",
        "Automatisation : Relayium propose une CLI pour push/pull SSH, synchronisation incrémentale et un service de réception permanent ; LocalSend n'existe qu'en application.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je installer quelque chose pour utiliser Relayium sur le même réseau ?",
        a: "Non. Ouvrez relayium.com dans un navigateur sur les deux appareils pendant qu'ils sont sur le même réseau : ils se voient automatiquement — sans application, sans compte, sans code d'appairage.",
      },
      {
        q: "LocalSend a-t-il besoin d'une connexion internet ?",
        a: "Non — c'est l'une de ses forces. LocalSend fonctionne entièrement sur le réseau local sans aucun serveur impliqué, donc il continue de fonctionner même sans internet du tout.",
      },
      {
        q: "Relayium peut-il envoyer des fichiers à quelqu'un sur un réseau différent ?",
        a: "Oui. Créez un code d'appairage (ou partagez le lien de participation qu'il génère) et l'autre appareil se connecte depuis n'importe où. Dans le navigateur, cette connexion entre réseaux passe par conception par un relais TURN chiffré : elle s'établit donc en une ou deux secondes, sans attendre des tentatives de connexion directe qui réussissent rarement entre deux réseaux domestiques. Le relais ne transporte que du texte chiffré et ne peut pas lire vos fichiers. Créer le code demande d'être connecté ; la personne à qui vous le remettez, jamais.",
      },
      {
        q: "Relayium est-il open source ?",
        a: "Oui, sous licence AGPL-3.0, avec l'intégralité du protocole et du code, publics sur github.com/relayium/relayium — le même genre d'ouverture qui rend LocalSend digne de confiance.",
      },
      {
        q: "Lequel est le plus privé ?",
        a: "Les deux gardent les transferts sur le même réseau hors d'un serveur public : sur le réseau local, les deux appareils Relayium se parlent en direct. LocalSend sécurise son transport local. Relayium ajoute, sur le réseau local comme entre réseaux, un canal de chiffrement indépendant au niveau applicatif avec un code SAS vérifiable des deux côtés — c'est pourquoi, sur le trajet entre réseaux, le relais ne voit que du texte chiffré.",
      },
    ],
  },
  cta: {
    text: "Découvrez ce que donne un transfert sur le même réseau sans rien installer — ouvrez simplement la page sur les deux appareils.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل LocalSend: أيّ نقل ملفات محلي تستخدم",
  description:
    "مقارنة صادقة بين Relayium وLocalSend. LocalSend تطبيق رائع مفتوح المصدر يُثبَّت على كل جهاز؛ أما Relayium فيؤدي النقل نفسه عبر الشبكة المحلية داخل المتصفح — دون تثبيت — إضافةً إلى النقل عبر الشبكات وواجهة سطر أوامر.",
  updatedLabel: "آخر تحديث",
  lead: [
    "LocalSend تطبيق جيد فعلًا ومحبوب: مجاني ومفتوح المصدر ومتعدد المنصات، ومبني لنقل الملفات بين الأجهزة على نفس الشبكة المحلية دون خادم ودون حساب على الإطلاق. يعتمد عليه كثيرون كأداة شبيهة بـ AirDrop لأنظمة Windows وLinux وAndroid.",
    "تقارنه هذه المقالة بإنصاف مع Relayium، الذي يعالج مشكلة نفس الشبكة ذاتها بطريقة مختلفة — لا تطبيق يُثبَّت، بل يعمل مباشرةً داخل متصفحك — ثم يذهب أبعد من ذلك، فيصل عبر الشبكات ويقدّم أداة سطر أوامر لا يملكها LocalSend.",
  ],
  sections: [
    {
      heading: "ما الذي يجيده LocalSend",
      body: [
        "LocalSend تطبيق مجاني مفتوح المصدر لأنظمة Windows وmacOS وLinux وAndroid وiOS. ثبّته مرة على كل جهاز، فيكتشف تلقائيًا مثيلات LocalSend الأخرى على نفس شبكة Wi-Fi أو الشبكة المحلية عبر ناقل محلي مشفّر — دون خادم في أي مكان، ودون حاجة إلى اتصال بالإنترنت، ودون حساب.",
        "يدعم السحب والإفلات، وإرسال مجلدات كاملة، ورمز PIN اختياريًا للإرسال على الشبكات التي لا تثق بها تمامًا.",
      ],
      bullets: [
        "تطبيقات أصلية متعددة المنصات لأنظمة Windows وmacOS وLinux وAndroid وiOS — ثبّته مرة، ثم يعمل ببساطة.",
        "غير متصل بالكامل بحكم التصميم: دون خادم، ودون اتصال بالإنترنت، ودون حساب على الإطلاق — كل ما يلزمه أجهزة على نفس الشبكة المحلية.",
        "حماية PIN اختيارية للإرسال على الشبكات غير الموثوقة، إضافةً إلى السحب والإفلات ونقل المجلدات الكاملة.",
        "أيقونة تطبيق مخصصة وتكامل مع قائمة المشاركة على مستوى نظام التشغيل، وهو ما لا يمكن لعلامة تبويب المتصفح تقديمه.",
      ],
    },
    {
      heading: "أين يختلف Relayium: لا شيء يُثبَّت، مباشرةً في المتصفح",
      body: [
        "يتّبع Relayium النهج المعاكس لمشكلة نفس الشبكة ذاتها: بدلًا من تثبيت تطبيق على كل جهاز، تفتح relayium.com في متصفح تملكه بالفعل. جهازان على نفس الشبكة يصلان تلقائيًا إلى الغرفة نفسها — يستنتج الخادم الغرفة من الشبكة المشتركة، دون رمز اقتران ودون حاجة إلى حساب من أي من الطرفين.",
        "تدعم غرفة الشبكة المحلية تلك أي عدد من الأقران في آنٍ واحد، لا زوجًا فقط، ويعمل السحب والإفلات أو اختيار المجلد بالطريقة نفسها التي يعمل بها تطبيق أصلي — لكن دون خطوة التثبيت.",
      ],
    },
    {
      heading: "أبعد من الشبكة المحلية: النقل عبر الشبكات وواجهة سطر أوامر",
      body: [
        "LocalSend مخصص للشبكة المحلية فقط بحكم التصميم — ليس لديه أي وسيلة للوصول إلى جهاز على شبكة مختلفة أو عبر الإنترنت. يضيف Relayium ذلك: أنشئ رمز اقتران (أو شارك رابط الانضمام الذي يولّده)، فيتصل الطرف الآخر من أي مكان. وفي المتصفح يمرّ هذا المسار العابر للشبكات عمدًا عبر مُرحِّل TURN مشفّر بدل البحث عن مسار مباشر: فقصر ICE على المُرحِّل وحده يرفع الاتصال خلال ثانية أو ثانيتين، بدل إنفاق نحو 20 ثانية على فحص مرشّحات الاتصال المباشر عبر NAT التي تفشل غالبًا على أي حال.",
        "يتطلب إنشاء رمز اقتران عبر الشبكات تسجيل دخول المُرسِل؛ أما الشخص المُستقبِل فلا يحتاج إلى حساب أبدًا. كل عملية نقل فوري — على الشبكة المحلية أو عبر الشبكات — مشفّرة من الطرف إلى الطرف على مستوى التطبيق: يشتقّ تبادل مفاتيح X25519 مفتاحًا يُستخدم لـ AES-256-GCM، ويتيح رمز SAS من 6 أرقام للطرفين تأكيد أن لا أحد تسلّل إلى تبادل المفاتيح، ويُتحقَّق من كل ملف بتجزئة SHA-256. عمليات النقل على نفس الشبكة تصل الجهازين مباشرةً؛ أما على المسار العابر للشبكات فالمُرحِّل لا ينقل سوى نص مُشفَّر ولا يستطيع قراءة بايت واحد من ملفك.",
        "لأي شخص يكتب سكربتات لنقل الملفات إلى خادم، توجد أيضًا واجهة سطر أوامر — push/pull عبر SSH أو عبر daemon direct، ومزامنة تزايدية للمجلدات، وإرسال/استقبال برمز اقتران — وهو ما لا يقدّمه تطبيق مقتصر على الشبكة المحلية. وواجهة سطر الأوامر تتصل دائمًا اتصالًا مباشرًا ولا تستخدم مُرحِّلًا أبدًا.",
      ],
    },
    {
      heading: "متى يكون LocalSend الخيار الأفضل",
      body: [
        "إن كنت لا تريد فتح متصفح البتة — كأن تنقل ملفات على شبكة بلا أي وصول إلى الإنترنت فعلًا، أو تريد فقط أيقونة تطبيق دائمة وتكاملًا مع قائمة المشاركة في نظام التشغيل — فإن تطبيق LocalSend المخصص أنسب. إنه ناضج، ويعمل غير متصل بالكامل بأدقّ معانيها، ووضع PIN فيه طبقة إضافية لطيفة على الشبكات التي لا تثق بها تمامًا.",
      ],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: ["الفروق الأهمّ، جنبًا إلى جنب:"],
      bullets: [
        "التثبيت: يحتاج LocalSend إلى تطبيق على كل جهاز؛ أما وضع نفس الشبكة في Relayium فلا يحتاج إلى شيء سوى المتصفح.",
        "مدى الشبكة: LocalSend مخصص للشبكة المحلية فقط؛ أما Relayium فيتصل أيضًا عبر الشبكات المختلفة برمز اقتران — وفي المتصفح يمرّ هذا المسار عبر مُرحِّل مشفّر، بينما تتصل واجهة سطر الأوامر مباشرةً دائمًا.",
        "التشفير: يؤمّن LocalSend ناقله المحلي؛ أما Relayium فيضيف قناة مستقلة على مستوى التطبيق بـ X25519 + AES-256-GCM مع رمز تحقق SAS، حتى على الشبكة المحلية.",
        "الحسابات: LocalSend لا يحتاج إلى حساب أبدًا؛ ووضع الشبكة المحلية في Relayium كذلك لا يحتاج إليه — الطرف الذي ينشئ رمز الاقتران وحده يسجّل الدخول، ولإنشائه فقط.",
        "الأتمتة: يوفّر Relayium واجهة سطر أوامر لـ push/pull عبر SSH، والمزامنة التزايدية، وخدمة استقبال دائمة التشغيل؛ أما LocalSend فتطبيق فقط.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى تثبيت أي شيء لاستخدام Relayium على نفس الشبكة؟",
        a: "لا. افتح relayium.com في متصفح على كلا الجهازين بينما هما على نفس الشبكة فيرى كلٌّ منهما الآخر تلقائيًا — دون تطبيق، ودون حساب، ودون رمز اقتران.",
      },
      {
        q: "هل يحتاج LocalSend إلى اتصال بالإنترنت؟",
        a: "لا — وهذه إحدى نقاط قوته. يعمل LocalSend بالكامل عبر الشبكة المحلية دون أي خادم، لذا يظل يعمل حتى بلا أي إنترنت على الإطلاق.",
      },
      {
        q: "هل يستطيع Relayium إرسال ملفات إلى شخص على شبكة مختلفة؟",
        a: "نعم. أنشئ رمز اقتران (أو شارك رابط الانضمام الذي يولّده) فيتصل الجهاز الآخر من أي مكان. وفي المتصفح يتولّى هذا الاتصالَ العابرَ للشبكات مُرحِّلُ TURN مشفّر بحكم التصميم، فينعقد خلال ثانية أو ثانيتين بدل انتظار محاولات اتصال مباشر نادرًا ما تنجح بين شبكتين منزليتين؛ والمُرحِّل ينقل نصًا مُشفَّرًا ولا يستطيع قراءة ملفاتك. إنشاء الرمز يتطلب تسجيل الدخول؛ أما من تسلّمه الرمز فلا يحتاج إليه أبدًا.",
      },
      {
        q: "هل Relayium مفتوح المصدر؟",
        a: "نعم، مرخّص بموجب AGPL-3.0، والبروتوكول والشيفرة بالكامل علنيان على github.com/relayium/relayium — النوع نفسه من الانفتاح الذي يجعل LocalSend جديرًا بالثقة.",
      },
      {
        q: "أيّهما أكثر خصوصية؟",
        a: "كلاهما يُبقي عمليات النقل على نفس الشبكة بعيدًا عن خادم عام: فعلى الشبكة المحلية يتخاطب جهازا Relayium مباشرةً. يؤمّن LocalSend ناقله المحلي. ويضيف Relayium قناة تشفير مستقلة على مستوى التطبيق مع رمز SAS يمكن للطرفين التحقق منه، على الشبكة المحلية أو عبر الشبكات — ولهذا لا يرى المُرحِّل على المسار العابر للشبكات سوى نص مُشفَّر.",
      },
    ],
  },
  cta: {
    text: "اطّلع على شعور النقل على نفس الشبكة دون أي شيء يُثبَّت — افتح الصفحة على كلا الجهازين فحسب.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium frente a LocalSend: qué transferencia local usar",
  description:
    "Una comparación honesta de Relayium y LocalSend. LocalSend es una gran aplicación de código abierto instalada en cada dispositivo; Relayium hace la misma transferencia por red local en el navegador —sin instalación—, más entre redes y con una CLI.",
  updatedLabel: "Última actualización",
  lead: [
    "LocalSend es una aplicación genuinamente buena y muy querida: gratis, de código abierto, multiplataforma y creada para mover archivos entre dispositivos de la misma red local sin servidor y sin cuenta, nunca. Mucha gente confía en ella como herramienta tipo AirDrop para Windows, Linux y Android.",
    "Este artículo la compara con justicia con Relayium, que aborda el mismo problema de la misma red de otra manera —sin ninguna aplicación que instalar, funcionando directamente en tu navegador— y luego va más allá, llegando entre redes y ofreciendo una herramienta de línea de comandos que LocalSend no tiene.",
  ],
  sections: [
    {
      heading: "Lo que LocalSend hace bien",
      body: [
        "LocalSend es una aplicación gratuita y de código abierto para Windows, macOS, Linux, Android e iOS. Instálala una vez en cada dispositivo y descubre automáticamente otras instancias de LocalSend en el mismo Wi-Fi o red local usando un transporte local cifrado: ningún servidor en ninguna parte, ninguna conexión a internet necesaria, ninguna cuenta.",
        "Admite arrastrar y soltar, el envío de carpetas enteras y un PIN opcional para enviar en redes en las que no confías del todo.",
      ],
      bullets: [
        "Aplicaciones nativas multiplataforma para Windows, macOS, Linux, Android e iOS: instálala una vez y funciona sin más.",
        "Completamente sin conexión por diseño: sin servidor, sin conexión a internet y sin cuenta, nunca; solo necesita dispositivos en la misma red local.",
        "Protección con PIN opcional para enviar en redes no confiables, además de arrastrar y soltar y transferencias de carpetas enteras.",
        "Un icono de aplicación propio e integración con el menú de compartir del sistema operativo, algo que una pestaña del navegador no puede ofrecer.",
      ],
    },
    {
      heading: "En qué se diferencia Relayium: nada que instalar, directo en el navegador",
      body: [
        "Relayium adopta el enfoque opuesto ante el mismo problema de la misma red: en lugar de instalar una aplicación en cada dispositivo, abres relayium.com en un navegador que ya tienes. Dos dispositivos en la misma red caen automáticamente en la misma sala: el servidor deriva la sala de la red compartida, sin código de emparejamiento y sin necesidad de cuenta por ninguna de las partes.",
        "Esa sala de red local admite cualquier número de pares a la vez, no solo una pareja, y arrastrar y soltar o seleccionar carpetas funciona igual que en una aplicación nativa, solo que sin el paso de instalación.",
      ],
    },
    {
      heading: "Más allá de la red local: transferencia entre redes y una CLI",
      body: [
        "LocalSend es solo para red local por diseño: no tiene forma de alcanzar un dispositivo en una red distinta o a través de internet. Relayium añade eso: crea un código de emparejamiento (o comparte el enlace de acceso que genera) y el otro lado se conecta desde cualquier parte. En el navegador, ese trayecto entre redes pasa a propósito por un retransmisor TURN cifrado en lugar de buscar una ruta directa: forzar un ICE solo de retransmisión levanta la conexión en uno o dos segundos, en vez de gastar unos 20 segundos en comprobaciones de candidatos directos a través de NAT que casi siempre fracasan.",
        "Crear un código de emparejamiento entre redes requiere que el remitente inicie sesión; la persona que recibe nunca necesita cuenta. Cada transferencia en tiempo real —en red local o entre redes— está cifrada de extremo a extremo en la capa de aplicación: un intercambio de claves X25519 deriva una clave usada para AES-256-GCM, un código SAS de 6 dígitos permite a ambos lados confirmar que nadie se ha colado en el intercambio de claves, y cada archivo se verifica con un hash SHA-256. Las transferencias en la misma red conectan directamente los dos dispositivos; en el trayecto entre redes, el retransmisor solo reenvía texto cifrado y no puede leer ni un byte de tu archivo.",
        "Para quien quiera automatizar transferencias hacia un servidor, también hay una CLI —push/pull por SSH o daemon directo, sincronización incremental de carpetas y envío/recepción por código de emparejamiento—, algo que una aplicación solo de red local no ofrece. La CLI siempre se conecta de forma directa y nunca usa un retransmisor.",
      ],
    },
    {
      heading: "Cuándo LocalSend es la mejor opción",
      body: [
        "Si nunca quieres abrir un navegador —por ejemplo, moviendo archivos en una red realmente sin acceso a internet, o simplemente quieres un icono de aplicación permanente e integración con el menú de compartir del sistema—, la aplicación propia de LocalSend encaja mejor. Es madura, funciona totalmente sin conexión en el sentido más estricto, y su modo PIN es una buena capa extra en redes en las que no confías del todo.",
      ],
    },
    {
      heading: "Comparación de funciones de un vistazo",
      body: ["Las diferencias que más importan, una al lado de la otra:"],
      bullets: [
        "Instalación: LocalSend necesita una aplicación en cada dispositivo; el modo de misma red de Relayium no necesita nada más que un navegador.",
        "Alcance de red: LocalSend es solo de red local; Relayium también conecta entre redes distintas con un código de emparejamiento: en el navegador ese trayecto va por un retransmisor cifrado, mientras que la CLI conecta siempre directamente.",
        "Cifrado: LocalSend asegura su transporte local; Relayium añade un canal independiente en la capa de aplicación con X25519 + AES-256-GCM y un código de verificación SAS, incluso en la red local.",
        "Cuentas: LocalSend nunca necesita ninguna; el modo de red local de Relayium tampoco; solo quien crea el código de emparejamiento inicia sesión, y únicamente para crearlo.",
        "Automatización: Relayium incluye una CLI para push/pull por SSH, sincronización incremental y un servicio de recepción siempre activo; LocalSend es solo aplicación.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito instalar algo para usar Relayium en la misma red?",
        a: "No. Abre relayium.com en un navegador en ambos dispositivos mientras están en la misma red y se ven automáticamente: sin aplicación, sin cuenta, sin código de emparejamiento.",
      },
      {
        q: "¿LocalSend necesita conexión a internet?",
        a: "No, y esa es una de sus fortalezas. LocalSend funciona por completo sobre la red local sin ningún servidor involucrado, así que sigue funcionando incluso sin nada de internet.",
      },
      {
        q: "¿Puede Relayium enviar archivos a alguien en una red distinta?",
        a: "Sí. Crea un código de emparejamiento (o comparte el enlace de acceso que genera) y el otro dispositivo se conecta desde cualquier parte. En el navegador, esa conexión entre redes la lleva por diseño un retransmisor TURN cifrado: así se establece en uno o dos segundos, sin esperar a intentos de conexión directa que rara vez funcionan entre dos redes domésticas. El retransmisor solo reenvía texto cifrado y no puede leer tus archivos. Crear el código exige iniciar sesión; quien lo recibe, nunca.",
      },
      {
        q: "¿Es Relayium de código abierto?",
        a: "Sí, bajo licencia AGPL-3.0, con el protocolo y el código completos públicos en github.com/relayium/relayium: el mismo tipo de apertura que hace confiable a LocalSend.",
      },
      {
        q: "¿Cuál es más privado?",
        a: "Ambos mantienen las transferencias de la misma red fuera de un servidor público: en la red local, los dos dispositivos de Relayium hablan directamente entre sí. LocalSend asegura su transporte local; Relayium añade un canal de cifrado independiente en la capa de aplicación con un código SAS que ambos lados pueden verificar, en la red local o entre redes, y por eso el retransmisor del trayecto entre redes solo ve texto cifrado.",
      },
    ],
  },
  cta: {
    text: "Comprueba cómo se siente una transferencia en la misma red sin nada que instalar: solo abre la página en ambos dispositivos.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs LocalSend: qual transferência local usar",
  description:
    "Uma comparação honesta entre Relayium e LocalSend. O LocalSend é um ótimo aplicativo de código aberto instalado em cada dispositivo; o Relayium faz a mesma transferência por rede local no navegador — sem instalação —, além de entre redes e com uma CLI.",
  updatedLabel: "Última atualização",
  lead: [
    "O LocalSend é um aplicativo genuinamente bom e muito querido: gratuito, de código aberto, multiplataforma e feito para mover arquivos entre dispositivos na mesma rede local sem servidor e sem conta, nunca. Muita gente conta com ele como uma ferramenta tipo AirDrop para Windows, Linux e Android.",
    "Este artigo o compara de forma justa com o Relayium, que resolve o mesmo problema da mesma rede de outra maneira — nenhum aplicativo para instalar, rodando direto no seu navegador — e depois vai além, alcançando outras redes e oferecendo uma ferramenta de linha de comando que o LocalSend não tem.",
  ],
  sections: [
    {
      heading: "O que o LocalSend faz bem",
      body: [
        "O LocalSend é um aplicativo gratuito e de código aberto para Windows, macOS, Linux, Android e iOS. Instale-o uma vez em cada dispositivo e ele descobre automaticamente outras instâncias do LocalSend no mesmo Wi-Fi ou rede local usando um transporte local criptografado — nenhum servidor em lugar nenhum, nenhuma conexão com a internet necessária, nenhuma conta.",
        "Ele oferece arrastar e soltar, o envio de pastas inteiras e um PIN opcional para enviar em redes em que você não confia totalmente.",
      ],
      bullets: [
        "Aplicativos nativos multiplataforma para Windows, macOS, Linux, Android e iOS — instale uma vez e ele simplesmente funciona.",
        "Totalmente offline por decisão de projeto: sem servidor, sem conexão com a internet e sem conta, nunca — ele só precisa de dispositivos na mesma rede local.",
        "Proteção por PIN opcional para enviar em redes não confiáveis, além de arrastar e soltar e transferências de pastas inteiras.",
        "Um ícone de aplicativo dedicado e integração com a folha de compartilhamento do sistema operacional, algo que uma aba do navegador não pode oferecer.",
      ],
    },
    {
      heading: "Onde o Relayium difere: nada para instalar, direto no navegador",
      body: [
        "O Relayium adota a abordagem oposta para o mesmo problema da mesma rede: em vez de instalar um aplicativo em cada dispositivo, você abre o relayium.com em um navegador que já tem. Dois dispositivos na mesma rede caem automaticamente na mesma sala — o servidor deriva a sala da rede compartilhada, sem código de emparelhamento e sem necessidade de conta de nenhum dos lados.",
        "Essa sala de rede local comporta qualquer número de pares ao mesmo tempo, não apenas uma dupla, e arrastar e soltar ou selecionar pastas funciona do mesmo jeito que em um aplicativo nativo — só que sem a etapa de instalação.",
      ],
    },
    {
      heading: "Além da rede local: transferência entre redes e uma CLI",
      body: [
        "O LocalSend é só para rede local por decisão de projeto — não tem como alcançar um dispositivo em uma rede diferente ou pela internet. O Relayium acrescenta isso: crie um código de emparelhamento (ou compartilhe o link de acesso que ele gera), e o outro lado se conecta de qualquer lugar. No navegador, esse caminho entre redes passa de propósito por um retransmissor TURN criptografado em vez de procurar uma rota direta: forçar um ICE somente de retransmissão levanta a conexão em um ou dois segundos, em vez de gastar cerca de 20 segundos em verificações de candidatos diretos através de NAT que quase sempre falham.",
        "Criar um código de emparelhamento entre redes exige que o remetente faça login; a pessoa que recebe nunca precisa de conta. Toda transferência em tempo real — na rede local ou entre redes — é criptografada de ponta a ponta na camada de aplicação: uma troca de chaves X25519 deriva uma chave usada para AES-256-GCM, um código SAS de 6 dígitos permite que os dois lados confirmem que ninguém se meteu na troca de chaves, e cada arquivo é verificado com um hash SHA-256. As transferências na mesma rede ligam os dois dispositivos diretamente; no caminho entre redes, o retransmissor só encaminha texto cifrado e não consegue ler um byte do seu arquivo.",
        "Para quem quiser automatizar transferências para um servidor, também há uma CLI — push/pull por SSH ou daemon direto, sincronização incremental de pastas e envio/recebimento por código de emparelhamento —, algo que um aplicativo só de rede local não oferece. A CLI sempre se conecta diretamente e nunca usa retransmissor.",
      ],
    },
    {
      heading: "Quando o LocalSend é a melhor escolha",
      body: [
        "Se você nunca quer abrir um navegador — digamos, movendo arquivos em uma rede realmente sem acesso à internet, ou você só quer um ícone de aplicativo permanente e integração com a folha de compartilhamento do sistema —, o aplicativo dedicado do LocalSend encaixa melhor. Ele é maduro, funciona totalmente offline no sentido mais estrito, e o modo PIN é uma boa camada extra em redes em que você não confia totalmente.",
      ],
    },
    {
      heading: "Comparação de recursos em resumo",
      body: ["As diferenças que mais importam, lado a lado:"],
      bullets: [
        "Instalação: o LocalSend precisa de um aplicativo em cada dispositivo; o modo de mesma rede do Relayium não precisa de nada além de um navegador.",
        "Alcance de rede: o LocalSend é só de rede local; o Relayium também conecta entre redes diferentes com um código de emparelhamento — no navegador esse trecho passa por um retransmissor criptografado, enquanto a CLI conecta sempre direto.",
        "Criptografia: o LocalSend protege seu transporte local; o Relayium acrescenta um canal independente na camada de aplicação com X25519 + AES-256-GCM e um código de verificação SAS, mesmo na rede local.",
        "Contas: o LocalSend nunca precisa de nenhuma; o modo de rede local do Relayium também não — só quem cria o código de emparelhamento faz login, e só para criá-lo.",
        "Automação: o Relayium traz uma CLI para push/pull por SSH, sincronização incremental e um serviço de recebimento sempre ativo; o LocalSend é apenas aplicativo.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso instalar algo para usar o Relayium na mesma rede?",
        a: "Não. Abra o relayium.com em um navegador nos dois dispositivos enquanto eles estão na mesma rede e eles se veem automaticamente — sem aplicativo, sem conta, sem código de emparelhamento.",
      },
      {
        q: "O LocalSend precisa de conexão com a internet?",
        a: "Não — essa é uma de suas forças. O LocalSend funciona inteiramente pela rede local sem nenhum servidor envolvido, então continua funcionando mesmo sem nada de internet.",
      },
      {
        q: "O Relayium pode enviar arquivos para alguém em uma rede diferente?",
        a: "Sim. Crie um código de emparelhamento (ou compartilhe o link de acesso que ele gera) e o outro dispositivo se conecta de qualquer lugar. No navegador, essa conexão entre redes é levada por decisão de projeto por um retransmissor TURN criptografado: ela sobe em um ou dois segundos, sem esperar tentativas de conexão direta que raramente dão certo entre duas redes domésticas. O retransmissor só encaminha texto cifrado e não consegue ler seus arquivos. Criar o código exige login; quem recebe o código, nunca.",
      },
      {
        q: "O Relayium é de código aberto?",
        a: "Sim, licenciado sob AGPL-3.0, com o protocolo e o código completos públicos em github.com/relayium/relayium — o mesmo tipo de abertura que torna o LocalSend confiável.",
      },
      {
        q: "Qual é mais privado?",
        a: "Ambos mantêm as transferências da mesma rede fora de um servidor público: na rede local, os dois dispositivos do Relayium falam diretamente entre si. O LocalSend protege seu transporte local. O Relayium acrescenta, na rede local ou entre redes, um canal de criptografia independente na camada de aplicação com um código SAS que os dois lados podem verificar — e é por isso que o retransmissor do caminho entre redes só vê texto cifrado.",
      },
    ],
  },
  cta: {
    text: "Veja como é uma transferência na mesma rede sem nada para instalar — basta abrir a página nos dois dispositivos.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/localsend",
  published: "2026-07-09",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
