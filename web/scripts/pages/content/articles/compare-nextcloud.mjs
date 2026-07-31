// web/scripts/pages/content/articles/compare-nextcloud.mjs
// Objective comparison: Relayium vs Nextcloud. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "Relayium vs Nextcloud for sending files",
  description:
    "An honest comparison of Relayium and Nextcloud. Nextcloud is a full self-hosted cloud platform for durable storage; Relayium is a focused transfer tool with no server-side realtime content copy — LAN direct, cross-network browser TURN with unreadable end-to-end ciphertext — or a zero-knowledge expiring link.",
  updatedLabel: "Last updated",
  lead: [
    "Nextcloud turned self-hosting into a real alternative to Google Drive or Dropbox: your own files, your own sync across every device, your own calendar and contacts, all under a domain you control. It's genuinely powerful software, and if what you want is a permanent home for your files, Nextcloud is the right tool for the job.",
    "This article compares the two fairly. Nextcloud is built to store and sync data indefinitely, with a web server, database, PHP runtime, and ongoing updates. Relayium solves the narrower hand-off: realtime transfer keeps no server-side content copy, using a direct browser path on a LAN or encrypted TURN across networks, while an optional zero-knowledge link expires. For durable cloud storage Nextcloud fits better; for moving a file Relayium is lighter.",
  ],
  sections: [
    {
      heading: "What Nextcloud does well",
      body: [
        "Nextcloud is a complete self-hosted cloud suite: file storage with desktop and mobile sync clients, calendars, contacts, an office suite, chat, and a large app ecosystem on top. Once it's running, it behaves like a private Google Workspace — files live there permanently, sync automatically across devices, and stay available whenever you need them.",
        "That's a genuinely different job than sending a file. Nextcloud is the right choice when you want a permanent, shared home for your data: a team drive, a photo library, a place your household or company keeps files long-term.",
      ],
    },
    {
      heading: "Where they differ: a storage platform vs a transfer tool",
      body: [
        "Because Nextcloud does so much, running it means running a real application platform: a web server, a database (MySQL, PostgreSQL, or SQLite), a PHP runtime, scheduled cron jobs, and periodic updates to the core and whichever apps you've installed. That's a fair trade for everything you get, but it's ongoing work, and you're the one planning storage capacity for everything you keep there.",
        "Relayium doesn't try to be a storage platform. Realtime transfer keeps no server-side content copy: browser files move directly on a LAN and use TURN by design across networks, where the relay cannot read or decrypt the end-to-end ciphertext. Its self-hosted server remains one Go container with SQLite and unreadable encrypted blobs for stored links; an optional profile adds TURN. That is much less to run when the job is only A to B.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Realtime transfer, no server-side content copy",
      body: [
        "Relayium's realtime mode keeps no server-side content copy. Browser files move directly on a LAN; across networks, TURN carries end-to-end ciphertext the relay cannot read or decrypt. Nextcloud has no equivalent because every share uses your server. Relayium derives AES-256-GCM keys with X25519, shows a matching 6-digit SAS, and checks each file with SHA-256.",
        "On the same network this needs no account at all: open relayium.com on both devices, pick up to 1,000 files, verify the code, and send. Sending across networks with a pairing code requires the sender to sign in — the recipient never needs an account. If a connection drops mid-transfer it resumes instead of restarting. On the same network the files go straight between the two devices; across networks the transfer runs over an encrypted TURN relay by design — it forwards ciphertext only and never holds the key.",
      ],
    },
    {
      heading: "When the recipient is offline: zero-knowledge stored links",
      body: [
        "Realtime transfer needs both people online at once, which is where Nextcloud's always-on server has a real edge. Relayium covers that case too, without giving up privacy: your browser generates a random AES-256-GCM key, encrypts the files with it before anything leaves your device, and the key lives only in the URL fragment — the part after the # that browsers never send to a server. The server stores ciphertext it cannot decrypt.",
        "Creating a stored link requires the sender to sign in; the recipient needs no account to download. Each link can be set to expire after 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or to burn after the first complete download — it isn't meant to be a permanent home for the file like a Nextcloud share, it's meant to disappear.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Purpose: Nextcloud is durable synced storage; Relayium is focused on realtime transfer without a server-side content copy, or an expiring link.",
        "Where files live: Nextcloud keeps files on the server; Relayium realtime is LAN-direct or cross-network TURN ciphertext without server-side content history, while stored links expire or burn.",
        "Self-host footprint: Nextcloud needs a web server, database, PHP runtime, and ongoing app updates; Relayium's self-host is a single container (docker compose up -d --build) plus an optional TURN relay for cross-network transfers.",
        "Accounts: Nextcloud needs an account for every user who accesses it; Relayium needs none for same-network transfers, only the sender signs in for cross-network pairing or stored links, and recipients never need one.",
        "Encryption: Relayium realtime is end-to-end with a 6-digit SAS — LAN content travels directly, while cross-network browser TURN forwards ciphertext it cannot read or decrypt; signaling metadata is still handled. Stored links are zero-knowledge. Nextcloud shares use your server, TLS, and your configured at-rest encryption.",
        "Cost and openness: Relayium is free and AGPL-3.0-licensed at github.com/relayium/relayium; Nextcloud's server software is also free and open source (AGPL), with paid hosting and support available from Nextcloud GmbH and partners.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Should I use Nextcloud instead of Relayium?",
        a: "If you want a permanent, synced home for your files — photos, documents, a shared team drive — yes, that's exactly what Nextcloud is built for. Relayium isn't a replacement for that; it's for the narrower job of getting a file from one person to another, quickly and privately.",
      },
      {
        q: "Does Relayium store my files the way Nextcloud does?",
        a: "No server-side content copy or history is kept in realtime mode. Browser files are LAN-direct or cross-network TURN ciphertext the relay cannot read or decrypt. Stored links keep zero-knowledge ciphertext only until expiry or burn-after-read, not indefinitely like Nextcloud.",
      },
      {
        q: "Do I need an account?",
        a: "On the same network, no. Sending across networks with a pairing code, or creating a stored link, requires the sender to sign in; the recipient never needs an account. Nextcloud requires an account (or a share link from one) for every user who accesses it.",
      },
      {
        q: "Can I self-host Relayium too?",
        a: "Yes. Unlike Nextcloud's multi-service stack, Relayium's server is a single container: one docker compose command runs the whole thing, with an optional TURN relay profile for cross-network NAT traversal.",
      },
      {
        q: "Is Relayium free?",
        a: "Yes — free and open source under the AGPL-3.0 license, with no paid tier. Nextcloud's core server software is also free and open source; some hosting and support options from Nextcloud GmbH are paid.",
      },
    ],
  },
  cta: {
    text: "Send a file by realtime transfer, or share an expiring zero-knowledge link — no cloud storage account required on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 Nextcloud：发送文件该选谁",
  description:
    "客观对比 Relayium 与 Nextcloud。Nextcloud 是适合长期存储的完整自托管云平台；Relayium 专注传输，不保存实时内容的服务端副本——局域网直连，跨网浏览器 TURN 只承载不可读的端到端密文——或使用零知识到期链接。",
  updatedLabel: "最近更新",
  lead: [
    "Nextcloud 把自托管变成了 Google Drive 或 Dropbox 真正意义上的替代品：自己的文件、跨所有设备的同步、自己的日历和联系人，一切都在你自己掌控的域名下运行。这是货真价实的强大软件——如果你想要的是文件的长期归宿，Nextcloud 就是对的工具。",
    "本文客观对比这两者。Nextcloud 长期存储并同步数据，需要 Web、数据库、PHP 与持续维护。Relayium 解决更窄的交接：实时传输不保存服务端内容副本，浏览器在局域网直连、跨网经加密 TURN；可选零知识链接会到期。持久云存储选 Nextcloud，只传文件时 Relayium 更轻。",
  ],
  sections: [
    {
      heading: "Nextcloud 做得好的地方",
      body: [
        "Nextcloud 是一整套自托管云套件：文件存储、桌面和移动端同步客户端、日历、联系人、办公套件、聊天，再加上庞大的应用生态。一旦搭建起来，它的使用体验就像私有的 Google Workspace——文件长期留在那里，跨设备自动同步，随时可用。",
        "这和「发送一个文件」是完全不同的任务。当你想要的是数据的长期共享归宿——团队共享盘、相册库、家庭或公司长期存放文件的地方——Nextcloud 正是对的选择。",
      ],
    },
    {
      heading: "差异所在：存储平台 vs 传输工具",
      body: [
        "正因为 Nextcloud 做的事情很多，运行它就意味着要运行一整个应用平台：一台 Web 服务器、一个数据库（MySQL、PostgreSQL 或 SQLite）、一个 PHP 运行时、定时的 cron 任务，以及对核心程序和你安装的每个应用的持续更新。考虑到它带来的一切，这是合理的代价，但确实是持续的运维工作，而且你存放的所有内容的存储容量也要由你自己规划。",
        "Relayium 不试图成为存储平台。实时传输不保存服务端内容副本：浏览器在局域网直连，跨网络按设计使用 TURN，中继无法读取或解密端到端密文。自托管服务端仍是单一 Go 容器，带 SQLite 和无法读取的存储链接密文；可选 profile 增加 TURN。只做 A 到 B 时维护量更小。",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "实时传输，不保存服务端内容副本",
      body: [
        "Relayium 实时模式不保存服务端内容副本。浏览器文件在局域网直连；跨网络时 TURN 只承载中继无法读取或解密的端到端密文。Nextcloud 分享则经你的服务器。Relayium 用 X25519 派生 AES-256-GCM 密钥，显示一致的 6 位 SAS，并用 SHA-256 校验文件。",
        "同一网络下完全无需账号：在两台设备上打开 relayium.com，最多选 1,000 个文件，核对校验码，然后发送。跨网络用配对码发送则需要发送方登录——接收方始终无需账号。若连接中途断开，传输会断点续传而非从头再来。同一网络下文件在两台设备之间直接传输；跨网络时刻意经由加密的 TURN 中继转发——中继只转发密文，从不持有密钥。",
      ],
    },
    {
      heading: "对方不在线时：零知识存储链接",
      body: [
        "实时传输需要双方同时在线，这正是 Nextcloud 那台常驻服务器真正占优的地方。Relayium 同样能应对这种情况，且不牺牲隐私：你的浏览器会生成一个随机的 AES-256-GCM 密钥，在任何数据离开你的设备之前就用它加密文件，密钥只存在于 URL 片段里——也就是 # 之后、浏览器从不发送给服务器的那部分。服务器只保存它无法解密的密文。",
        "生成这样的存储链接需要发送方登录；收件方下载无需任何账号。每个链接都可设为 1 小时、1 天、3 天、7 天或最长 14 天后过期（上限取决于套餐），或者首次完整下载后即焚——它不是像 Nextcloud 分享那样的永久归宿，它本来就是为了消失而存在的。",
      ],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "用途：Nextcloud 是持久同步存储平台；Relayium 专注不保存服务端内容副本的实时传输或到期链接。",
        "文件存放：Nextcloud 长期保存文件；Relayium 实时内容在局域网直连或跨网以 TURN 密文流动，不保留服务端历史；存储链接会到期或即焚。",
        "自托管成本：Nextcloud 需要 Web 服务器、数据库、PHP 运行时以及持续的应用更新；Relayium 的自托管是单一容器（docker compose up -d --build），再加一个用于跨网络传输的可选 TURN 中继。",
        "账号：Nextcloud 的每个使用者都需要账号；Relayium 在同网络传输中无需账号，跨网络配对或存储链接只要求发送方登录，接收方始终无需账号。",
        "加密：Relayium 实时模式端到端加密并带 6 位 SAS；局域网内容直连，跨网浏览器 TURN 只转发中继无法读取或解密的密文，信令仍处理元数据。存储链接为零知识；Nextcloud 分享经你的服务器、TLS 与自定静态加密。",
        "费用与开放：Relayium 免费且采用 AGPL-3.0 许可，代码在 github.com/relayium/relayium；Nextcloud 的服务端软件同样免费开源（AGPL 许可），Nextcloud GmbH 及其合作伙伴也提供付费的托管与支持服务。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我该用 Nextcloud 而不是 Relayium 吗？",
        a: "如果你想要的是文件的长期同步归宿——照片、文档、团队共享盘——没错，这正是 Nextcloud 生来要做的事。Relayium 不是要替代它，而是解决一个更窄的问题：快速、私密地把文件从一个人传给另一个人。",
      },
      {
        q: "Relayium 会像 Nextcloud 那样存储我的文件吗？",
        a: "实时模式不保存服务端内容副本或历史。浏览器文件在局域网直连，跨网时 TURN 只承载中继无法读取或解密的密文。存储链接仅保存零知识密文直到到期或即焚，不像 Nextcloud 那样长期保存。",
      },
      {
        q: "我需要账号吗？",
        a: "同一网络下不需要。用配对码跨网络发送，或生成存储链接，都需要发送方登录；接收方始终无需账号。而 Nextcloud 的每一位使用者都需要账号（或由账号持有者生成的分享链接）。",
      },
      {
        q: "Relayium 也能自托管吗？",
        a: "可以。与 Nextcloud 的多服务组合不同，Relayium 的服务端是单一容器：一条 docker compose 命令就能跑起整个系统，还有一个用于跨网络 NAT 穿透的可选 TURN 中继 profile。",
      },
      {
        q: "Relayium 免费吗？",
        a: "免费——采用 AGPL-3.0 许可的免费开源软件，没有付费档位。Nextcloud 的核心服务端软件同样免费开源；Nextcloud GmbH 提供的部分托管与支持服务是收费的。",
      },
    ],
  },
  cta: {
    text: "通过实时传输发送文件，或分享会到期的零知识链接——同一网络下无需云存储账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と Nextcloud の比較：ファイル送信にどちらを選ぶか",
  description:
    "Relayium と Nextcloud を公平に比較。Nextcloud は長期保存向けのセルフホスト型クラウド、Relayium はサーバー側のリアルタイム内容コピーを保存しない転送ツールです。LAN は直接、ネットワーク間ブラウザは読めない E2E 暗号文を TURN で運び、期限付きゼロ知識リンクも使えます。",
  updatedLabel: "最終更新",
  lead: [
    "Nextcloud は、セルフホストを Google Drive や Dropbox の本物の代替にしました。自分のファイル、あらゆる端末をまたぐ同期、自分のカレンダーと連絡先。そのすべてが自分の管理するドメインの下で動きます。これは正真正銘、強力なソフトウェアであり、ファイルの恒久的な置き場所が欲しいなら、Nextcloud はまさに適した道具です。",
    "Nextcloud は Web、DB、PHP と継続保守を伴う長期保存・同期基盤です。Relayium は受け渡しに絞り、リアルタイムではサーバー側内容コピーを保存せず、ブラウザは LAN で直接、ネットワーク間で暗号化 TURN を使います。期限付きゼロ知識リンクも選べます。永続保存は Nextcloud、移動だけなら Relayium が軽量です。",
  ],
  sections: [
    {
      heading: "Nextcloud が優れている点",
      body: [
        "Nextcloud は完結したセルフホスト型クラウドスイートです。デスクトップとモバイルの同期クライアントを備えたファイルストレージ、カレンダー、連絡先、オフィススイート、チャット、その上に大規模なアプリエコシステムが乗っています。一度立ち上げれば、プライベートな Google Workspace のように動作します。ファイルはそこに恒久的に置かれ、端末間で自動同期され、いつでも利用できます。",
        "これは「ファイルを送る」こととは根本的に違う仕事です。データの恒久的で共有された置き場所（チーム共有ドライブ、写真ライブラリ、家庭や会社が長期的にファイルを保管する場所）が欲しいなら、Nextcloud が正しい選択です。",
      ],
    },
    {
      heading: "違いはどこか：ストレージ基盤 vs 転送ツール",
      body: [
        "Nextcloud は多くのことをこなす分、それを運用するということは本格的なアプリケーション基盤を運用することを意味します。Web サーバー、データベース（MySQL、PostgreSQL、または SQLite）、PHP ランタイム、定期実行される cron ジョブ、そしてコア本体とインストールした各アプリへの継続的なアップデートです。得られるものを考えれば妥当な対価ですが、それは継続的な作業であり、保管するすべてのもののストレージ容量計画も自分で行うことになります。",
        "Relayium はストレージ基盤ではありません。リアルタイムではサーバー側内容コピーを保存せず、LAN は直接、ネットワーク間はリレーが読取り・復号できない E2E 暗号文の TURN です。セルフホストは SQLite と読めない保存リンク暗号文を持つ単一 Go コンテナで、任意の TURN profile を追加できます。",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "リアルタイム転送、サーバー側内容コピーなし",
      body: [
        "Relayium リアルタイムはサーバー側内容コピーを保存しません。LAN は直接、ネットワーク間 TURN は読取り・復号できない E2E 暗号文だけを運びます。Nextcloud 共有はサーバーを使います。Relayium は X25519/AES-256-GCM、6桁 SAS、SHA-256 を使います。",
        "同一ネットワークならアカウントは一切不要です。両方の端末で relayium.com を開き、最大1,000ファイルを選び、コードを照合して送ります。ペアリングコードでネットワークをまたいで送る場合は送信側のサインインが必要です。受信側はどちらの場合もアカウント不要です。途中で接続が切れても、転送は最初からではなく再開されます。同一ネットワークならファイルは2台の端末のあいだを直接流れ、ネットワークをまたぐ場合は設計上、暗号化された TURN リレーを経由します。リレーが中継するのは暗号文だけで、鍵は持ちません。",
      ],
    },
    {
      heading: "受信側がオフラインのとき：ゼロ知識の保存リンク",
      body: [
        "リアルタイム転送には双方が同時にオンラインである必要があり、ここは Nextcloud の常駐サーバーが本当に優れている点です。Relayium もこのケースをカバーします。プライバシーを犠牲にせずにです。ブラウザがランダムな AES-256-GCM 鍵を生成し、何も端末から出ていく前にそれでファイルを暗号化し、鍵は URL フラグメント（# の後の、ブラウザがサーバーに決して送らない部分）にだけ存在します。サーバーは復号できない暗号文だけを保存します。",
        "こうした保存リンクの作成には送信側のサインインが必要です。受信側はダウンロードにアカウントが要りません。各リンクは1時間、1日、3日、7日、最長14日（プランによる）で期限切れになるよう設定でき、あるいは最初の完全なダウンロード後に消去するよう設定できます。Nextcloud の共有のような恒久的な置き場所ではなく、消えることを前提としています。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "目的：Nextcloud は永続同期ストレージ、Relayium はサーバー側内容コピーなしのリアルタイム転送または期限付きリンク。",
        "置き場所：Nextcloud はサーバー保存。Relayium は LAN 直接またはネットワーク間 TURN 暗号文で、サーバー側履歴なし。保存リンクは期限切れか即焚です。",
        "セルフホストの重さ：Nextcloud は Web サーバー、データベース、PHP ランタイム、継続的なアプリ更新が必要です。Relayium のセルフホストは単一コンテナ（docker compose up -d --build）に加え、ネットワークをまたぐ転送用の任意の TURN リレーだけで済みます。",
        "アカウント：Nextcloud はアクセスするすべてのユーザーにアカウントが必要です。Relayium は同一ネットワークの転送にはアカウント不要で、ネットワークをまたぐペアリングや保存リンクは送信側のサインインだけが必要、受信側は決して不要です。",
        "暗号化：Relayium は E2E と6桁 SAS。LAN 内容は直接、ネットワーク間 TURN は読取り・復号不能な暗号文で、信号メタデータは処理されます。保存リンクはゼロ知識。Nextcloud は自分のサーバー、TLS、設定した保存時暗号化を使います。",
        "費用と開放性：Relayium は無料で AGPL-3.0 ライセンス、github.com/relayium/relayium にあります。Nextcloud のサーバーソフトウェアも無料でオープンソース（AGPL）ですが、Nextcloud GmbH やパートナーによる有料のホスティングとサポートも利用できます。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium ではなく Nextcloud を使うべきですか？",
        a: "写真、文書、チーム共有ドライブなど、ファイルの恒久的で同期された置き場所が欲しいなら、はい、それこそまさに Nextcloud が作られた目的です。Relayium はその代替品ではなく、1人から別の1人へ素早く、プライベートにファイルを渡すという、より狭い仕事のためのものです。",
      },
      {
        q: "Relayium は Nextcloud のようにファイルを保存しますか？",
        a: "リアルタイムではサーバー側内容コピーや履歴を保存しません。LAN は直接、ネットワーク間 TURN は読取り・復号不能な暗号文です。保存リンクは期限切れまたは即焚までのゼロ知識暗号文で、Nextcloud のような無期限保存ではありません。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "同一ネットワークなら不要です。ペアリングコードでネットワークをまたいで送る場合や、保存リンクを作成する場合は送信側のサインインが必要です。受信側はどちらの場合もアカウント不要です。一方 Nextcloud は、アクセスするすべてのユーザーにアカウント（またはアカウント保有者が作成した共有リンク）が必要です。",
      },
      {
        q: "Relayium もセルフホストできますか？",
        a: "できます。Nextcloud の複数サービスから成る構成とは違い、Relayium のサーバーは単一のコンテナです。1つの docker compose コマンドだけでシステム全体が起動し、ネットワークをまたぐ NAT 越え用の任意の TURN リレープロファイルもあります。",
      },
      {
        q: "Relayium は無料ですか？",
        a: "はい。AGPL-3.0 ライセンスの無料オープンソースで、有料プランはありません。Nextcloud のコアサーバーソフトウェアも無料でオープンソースですが、Nextcloud GmbH による一部のホスティングとサポートは有料です。",
      },
    ],
  },
  cta: {
    text: "リアルタイムでファイルを送るか、期限付きゼロ知識リンクを共有しましょう。同じネットワークならクラウドアカウント不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs Nextcloud: 파일 전송에는 무엇을 써야 할까",
  description:
    "Relayium과 Nextcloud 비교. Nextcloud는 장기 저장용 자체 호스팅 클라우드이고, Relayium은 서버 측 실시간 내용 사본을 저장하지 않는 전송 도구입니다. LAN은 직접, 네트워크 간 브라우저는 읽을 수 없는 E2E 암호문을 TURN으로 운반하며 만료 영지식 링크도 제공합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Nextcloud는 자체 호스팅을 Google Drive나 Dropbox의 진짜 대안으로 만들었습니다. 자신의 파일, 모든 기기에 걸친 동기화, 자신의 캘린더와 연락처까지 — 모두 자신이 통제하는 도메인 아래에서 돌아갑니다. 이는 정말로 강력한 소프트웨어이며, 파일의 영구적인 보금자리를 원한다면 Nextcloud가 딱 맞는 도구입니다.",
    "Nextcloud는 웹, DB, PHP와 지속 관리가 필요한 장기 저장·동기화 플랫폼입니다. Relayium은 전달에 집중해 실시간 서버 측 내용 사본을 저장하지 않고, LAN은 직접, 네트워크 간은 암호화 TURN을 사용하며 만료 영지식 링크도 선택할 수 있습니다.",
  ],
  sections: [
    {
      heading: "Nextcloud가 잘하는 것",
      body: [
        "Nextcloud는 완결된 자체 호스팅 클라우드 스위트입니다. 데스크톱과 모바일 동기화 클라이언트를 갖춘 파일 저장소, 캘린더, 연락처, 오피스 스위트, 채팅, 그리고 그 위에 방대한 앱 생태계까지 있습니다. 일단 구동되면 개인용 Google Workspace처럼 동작합니다 — 파일은 그곳에 영구히 머물고, 기기 간 자동으로 동기화되며, 언제든 접근할 수 있습니다.",
        "이는 \"파일 하나 보내기\"와는 근본적으로 다른 일입니다. 데이터의 영구적이고 공유된 보금자리 — 팀 공유 드라이브, 사진 라이브러리, 가정이나 회사가 장기간 파일을 보관하는 곳 — 를 원한다면 Nextcloud가 옳은 선택입니다.",
      ],
    },
    {
      heading: "차이가 나는 지점: 저장 플랫폼 vs 전송 도구",
      body: [
        "Nextcloud는 하는 일이 많은 만큼, 이를 운영한다는 것은 진짜 애플리케이션 플랫폼을 운영한다는 뜻입니다. 웹 서버, 데이터베이스(MySQL, PostgreSQL, 또는 SQLite), PHP 런타임, 예약된 cron 작업, 그리고 코어와 설치한 각 앱에 대한 주기적인 업데이트가 필요합니다. 얻는 것을 생각하면 합당한 대가지만, 이는 지속적인 작업이며 보관하는 모든 것의 저장 용량 계획도 직접 해야 합니다.",
        "Relayium은 저장 플랫폼이 아닙니다. 실시간은 서버 측 내용 사본 없이 LAN 직접 또는 네트워크 간 TURN 암호문으로 이동하며 릴레이는 읽거나 복호화할 수 없습니다. 자체 호스팅은 SQLite와 읽을 수 없는 저장 링크 블롭을 가진 단일 Go 컨테이너이고 TURN profile은 선택 사항입니다.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "실시간 전송, 서버 측 내용 사본 없음",
      body: [
        "Relayium 실시간은 서버 측 내용 사본을 저장하지 않습니다. LAN은 직접, 네트워크 간 TURN은 읽거나 복호화할 수 없는 E2E 암호문만 운반합니다. Nextcloud 공유는 서버를 사용합니다. Relayium은 X25519/AES-256-GCM, 6자리 SAS, SHA-256을 사용합니다.",
        "같은 네트워크에서는 계정이 전혀 필요 없습니다. 두 기기에서 relayium.com을 열고, 최대 1,000개 파일을 고르고, 코드를 대조한 뒤 보냅니다. 페어링 코드로 네트워크를 넘어 보낼 때는 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 어느 경우든 계정이 필요 없습니다. 도중에 연결이 끊겨도 전송은 처음부터가 아니라 이어서 재개됩니다. 같은 네트워크에서는 파일이 두 기기 사이를 직접 오가고, 네트워크를 넘을 때는 설계상 암호화된 TURN 릴레이를 거칩니다 — 릴레이는 암호문만 전달하며 키는 갖지 않습니다.",
      ],
    },
    {
      heading: "받는 쪽이 오프라인일 때: 영지식 저장 링크",
      body: [
        "실시간 전송은 양쪽이 동시에 접속해 있어야 하는데, 이 지점에서는 Nextcloud의 상시 구동 서버가 실질적으로 유리합니다. Relayium도 프라이버시를 포기하지 않고 이 경우를 처리합니다. 브라우저가 무작위 AES-256-GCM 키를 생성해, 무엇이든 기기를 떠나기 전에 그 키로 파일을 암호화하고, 키는 URL 프래그먼트 — # 뒤의, 브라우저가 서버로 결코 보내지 않는 부분 — 에만 존재합니다. 서버는 복호화할 수 없는 암호문만 저장합니다.",
        "이런 저장 링크 생성에는 보내는 쪽의 로그인이 필요합니다. 받는 쪽은 다운로드에 계정이 필요 없습니다. 각 링크는 1시간, 1일, 3일, 7일, 최대 14일(요금제에 따라 다름) 뒤 만료되도록 설정하거나, 열람 후 삭제로 첫 완전한 다운로드 뒤 사라지도록 설정할 수 있습니다. Nextcloud 공유처럼 영구적인 보금자리가 아니라, 사라지는 것이 원래 목적입니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "목적: Nextcloud는 지속 동기화 저장, Relayium은 서버 측 내용 사본 없는 실시간 전송 또는 만료 링크.",
        "위치: Nextcloud는 서버 저장. Relayium 실시간은 LAN 직접 또는 네트워크 간 TURN 암호문이며 서버 측 기록이 없습니다. 저장 링크는 만료 또는 즉시 삭제됩니다.",
        "자체 호스팅 부담: Nextcloud는 웹 서버, 데이터베이스, PHP 런타임, 지속적인 앱 업데이트가 필요합니다. Relayium의 자체 호스팅은 단일 컨테이너(docker compose up -d --build)에 네트워크 간 전송용 선택적 TURN 릴레이만 더하면 됩니다.",
        "계정: Nextcloud는 접근하는 모든 사용자에게 계정이 필요합니다. Relayium은 같은 네트워크 전송에는 계정이 필요 없고, 네트워크 간 페어링이나 저장 링크는 보내는 쪽의 로그인만 필요하며, 받는 쪽은 결코 필요 없습니다.",
        "암호화: Relayium은 E2E와 6자리 SAS를 사용합니다. LAN 내용은 직접, 네트워크 간 TURN은 읽거나 복호화할 수 없는 암호문이며 시그널링 메타데이터는 처리됩니다. 저장 링크는 영지식이고 Nextcloud는 자체 서버, TLS, 설정한 저장 암호화를 사용합니다.",
        "비용과 개방성: Relayium은 무료이며 AGPL-3.0 라이선스로 github.com/relayium/relayium에 있습니다. Nextcloud의 서버 소프트웨어도 무료 오픈소스(AGPL)이지만, Nextcloud GmbH와 파트너사가 제공하는 유료 호스팅과 지원도 이용할 수 있습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium 대신 Nextcloud를 써야 하나요?",
        a: "사진, 문서, 팀 공유 드라이브처럼 파일의 영구적이고 동기화된 보금자리를 원한다면, 네, 그것이 바로 Nextcloud가 만들어진 목적입니다. Relayium은 그것의 대체품이 아니라, 한 사람에게서 다른 사람에게 빠르고 사적으로 파일을 전달하는 더 좁은 일을 위한 것입니다.",
      },
      {
        q: "Relayium도 Nextcloud처럼 파일을 저장하나요?",
        a: "실시간은 서버 측 내용 사본이나 기록을 저장하지 않습니다. LAN은 직접, 네트워크 간 TURN은 읽거나 복호화할 수 없는 암호문입니다. 저장 링크는 만료 또는 즉시 삭제까지 영지식 암호문만 보관합니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "같은 네트워크에서는 필요 없습니다. 페어링 코드로 네트워크를 넘어 보내거나 저장 링크를 만들 때는 보내는 쪽의 로그인이 필요합니다. 받는 쪽은 어느 경우든 계정이 필요 없습니다. 반면 Nextcloud는 접근하는 모든 사용자에게 계정(또는 계정 보유자가 만든 공유 링크)이 필요합니다.",
      },
      {
        q: "Relayium도 자체 호스팅할 수 있나요?",
        a: "네. Nextcloud의 여러 서비스로 이루어진 구성과 달리, Relayium의 서버는 단일 컨테이너입니다. docker compose 명령 하나로 전체 시스템이 구동되며, 네트워크 간 NAT 통과용 선택적 TURN 릴레이 프로필도 있습니다.",
      },
      {
        q: "Relayium은 무료인가요?",
        a: "네 — AGPL-3.0 라이선스의 무료 오픈소스이며 유료 등급이 없습니다. Nextcloud의 코어 서버 소프트웨어도 무료 오픈소스이지만, Nextcloud GmbH가 제공하는 일부 호스팅과 지원은 유료입니다.",
      },
    ],
  },
  cta: {
    text: "실시간으로 파일을 보내거나 만료 영지식 링크를 공유하세요. 같은 네트워크에서는 클라우드 계정이 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. Nextcloud: Dateien versenden",
  description:
    "Ein ehrlicher Vergleich von Relayium und Nextcloud. Nextcloud ist eine vollwertige selbstgehostete Cloud für dauerhaften Speicher; Relayium überträgt in Echtzeit ohne serverseitige Inhaltskopie — im LAN direkt, netzwerkübergreifend per TURN, das Ende-zu-Ende-Chiffretext weder lesen noch entschlüsseln kann — oder per ablaufendem Zero-Knowledge-Link.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Nextcloud hat Selbsthosting zu einer echten Alternative zu Google Drive oder Dropbox gemacht: eigene Dateien, Synchronisation über alle Geräte hinweg, eigener Kalender und Kontakte, alles unter einer Domain, die du kontrollierst. Das ist wirklich leistungsfähige Software, und wenn du ein dauerhaftes Zuhause für deine Dateien willst, ist Nextcloud das richtige Werkzeug.",
    "Dieser Artikel vergleicht die beiden fair. Nextcloud speichert und synchronisiert Daten dauerhaft; dafür betreibst du Webserver, Datenbank, PHP und laufende Updates. Relayium löst die engere Aufgabe der Übertragung: Echtzeit ohne serverseitige Inhaltskopie oder ein ablaufender Zero-Knowledge-Link. Im LAN fließen Inhalte direkt, netzwerkübergreifend leitet TURN nur Ende-zu-Ende-Chiffretext weiter, den es nicht lesen oder entschlüsseln kann. Für dauerhaften Cloud-Speicher ist Nextcloud die bessere Wahl; für eine Übertragung ist Relayium leichter.",
  ],
  sections: [
    {
      heading: "Was Nextcloud gut macht",
      body: [
        "Nextcloud ist eine vollständige selbstgehostete Cloud-Suite: Dateispeicher mit Desktop- und Mobil-Sync-Clients, Kalender, Kontakte, eine Office-Suite, Chat und darüber hinaus ein großes App-Ökosystem. Einmal aufgesetzt, verhält es sich wie ein privates Google Workspace — Dateien bleiben dauerhaft dort, synchronisieren sich automatisch über Geräte hinweg und stehen jederzeit zur Verfügung.",
        "Das ist eine grundlegend andere Aufgabe als eine Datei zu senden. Nextcloud ist die richtige Wahl, wenn du ein dauerhaftes, geteiltes Zuhause für deine Daten willst: ein Team-Laufwerk, eine Fotobibliothek, einen Ort, an dem dein Haushalt oder Unternehmen Dateien langfristig aufbewahrt.",
      ],
    },
    {
      heading: "Worin sie sich unterscheiden: Speicherplattform vs. Übertragungstool",
      body: [
        "Weil Nextcloud so viel leistet, bedeutet es zu betreiben, eine echte Anwendungsplattform zu betreiben: einen Webserver, eine Datenbank (MySQL, PostgreSQL oder SQLite), eine PHP-Laufzeitumgebung, geplante Cron-Jobs und regelmäßige Updates für den Kern und jede installierte App. Das ist ein fairer Preis für alles, was du bekommst, aber es ist laufende Arbeit, und die Speicherkapazität für alles, was du dort ablegst, musst du selbst planen.",
        "Relayium versucht nicht, eine Speicherplattform zu sein. Echtzeitübertragungen erzeugen keine serverseitige Inhaltskopie oder Historie: im LAN laufen Inhalte direkt, netzwerkübergreifend per TURN. Der selbst gehostete Server ist ein einzelner Go-Container mit kleiner SQLite-Datenbank; gespeicherte Links sind verschlüsselte Blobs, die er nicht lesen kann. Ein optionales Profil ergänzt TURN für netzwerkübergreifendes NAT-Traversal.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Echtzeitübertragung ohne serverseitige Inhaltskopie",
      body: [
        "Relayiums Echtzeitmodus hält keine serverseitige Inhaltskopie oder Übertragungshistorie. Im LAN laufen Dateien direkt zwischen den Browsern; netzwerkübergreifend nutzen Browser konstruktionsbedingt TURN, das nur Ende-zu-Ende-Chiffretext weiterleitet und ihn weder lesen noch entschlüsseln kann. Nextcloud speichert Freigaben dagegen auf deinem Server. X25519, AES-256-GCM, ein übereinstimmender sechsstelliger SAS und SHA-256 sichern die Übertragung.",
        "Im selben Netzwerk braucht das überhaupt kein Konto: Öffne relayium.com auf beiden Geräten, wähle bis zu 1.000 Dateien, prüfe den Code und sende. Beim Senden über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden — der Empfänger braucht in beiden Fällen kein Konto. Bricht eine Verbindung mittendrin ab, wird die Übertragung fortgesetzt statt neu gestartet. Im selben Netzwerk laufen die Dateien direkt zwischen den beiden Geräten; über Netzwerkgrenzen hinweg läuft die Übertragung von Grund auf über ein verschlüsseltes TURN-Relay — es leitet nur Chiffretext weiter und besitzt nie den Schlüssel.",
      ],
    },
    {
      heading: "Wenn der Empfänger offline ist: Zero-Knowledge-Speicherlinks",
      body: [
        "Echtzeitübertragung setzt voraus, dass beide gleichzeitig online sind — hier hat Nextclouds ständig laufender Server einen echten Vorteil. Relayium deckt auch diesen Fall ab, ohne die Privatsphäre aufzugeben: Dein Browser erzeugt einen zufälligen AES-256-GCM-Schlüssel, verschlüsselt die Dateien damit, bevor irgendetwas dein Gerät verlässt, und der Schlüssel lebt nur im URL-Fragment — dem Teil nach dem #, den Browser nie an einen Server senden. Der Server speichert nur Chiffretext, den er nicht entschlüsseln kann.",
        "Das Erstellen eines gespeicherten Links erfordert die Anmeldung des Absenders; der Empfänger braucht zum Herunterladen kein Konto. Jeder Link lässt sich so einstellen, dass er nach 1 Stunde, 1 Tag, 3 Tagen, 7 Tagen oder bis zu 14 Tagen je nach Tarif abläuft, oder dass er nach dem ersten vollständigen Download vernichtet wird — er ist nicht als dauerhaftes Zuhause für die Datei gedacht wie eine Nextcloud-Freigabe, sondern soll verschwinden.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Zweck: Nextcloud ist eine Cloud-Plattform für dauerhaften, synchronisierten Speicher; Relayium bietet Echtzeitübertragung ohne serverseitige Inhaltskopie oder einen ablaufenden Link.",
        "Wo Dateien liegen: Nextcloud hält Dateien auf dem Server. Relayium speichert im Echtzeitmodus keine serverseitige Inhaltskopie oder Historie: LAN direkt, netzwerkübergreifend als TURN-Chiffretext. Gespeicherte Links laufen ab oder werden nach einem Download vernichtet.",
        "Selfhosting-Aufwand: Nextcloud braucht einen Webserver, eine Datenbank, eine PHP-Laufzeitumgebung und laufende App-Updates; Relayiums Selfhosting ist ein einziger Container (docker compose up -d --build) plus ein optionales TURN-Relay für netzwerkübergreifende Übertragungen.",
        "Konten: Nextcloud braucht für jeden zugreifenden Nutzer ein Konto; Relayium braucht keines für Übertragungen im selben Netzwerk, nur der Absender muss sich für netzwerkübergreifendes Pairing oder gespeicherte Links anmelden, und Empfänger brauchen nie eines.",
        "Verschlüsselung: Relayiums Echtzeitmodus ist Ende-zu-Ende mit sechsstelligem SAS-Code. LAN-Inhalte fließen direkt; netzwerkübergreifendes TURN kann den Chiffretext weder lesen noch entschlüsseln, während Signalisierungsmetadaten verarbeitet werden. Gespeicherte Links sind Zero-Knowledge, der Schlüssel bleibt im URL-Fragment. Nextcloud-Freigaben liegen auf deinem Server und werden durch TLS sowie deine konfigurierte Speicherverschlüsselung geschützt.",
        "Kosten und Offenheit: Relayium ist kostenlos und AGPL-3.0-lizenziert unter github.com/relayium/relayium; Nextclouds Server-Software ist ebenfalls kostenlos und quelloffen (AGPL), mit bezahltem Hosting und Support von Nextcloud GmbH und Partnern.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Sollte ich Nextcloud statt Relayium verwenden?",
        a: "Wenn du ein dauerhaftes, synchronisiertes Zuhause für deine Dateien willst — Fotos, Dokumente, ein geteiltes Team-Laufwerk —, ja, genau dafür wurde Nextcloud gebaut. Relayium ist kein Ersatz dafür; es ist für die engere Aufgabe gedacht, eine Datei schnell und privat von einer Person zu einer anderen zu bringen.",
      },
      {
        q: "Speichert Relayium meine Dateien wie Nextcloud?",
        a: "Nicht im Echtzeitmodus: Es gibt keine serverseitige Inhaltskopie oder Historie. Im LAN fließen Inhalte direkt; netzwerkübergreifendes TURN sieht nur Chiffretext, den es weder lesen noch entschlüsseln kann. Gespeicherte Links halten Zero-Knowledge-Chiffretext nur bis zum Ablauf oder einmaligen Download, nicht dauerhaft wie Nextcloud.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Im selben Netzwerk nicht. Beim Senden über Netzwerke hinweg per Pairing-Code oder beim Erstellen eines gespeicherten Links muss sich der Absender anmelden; der Empfänger braucht nie ein Konto. Nextcloud verlangt hingegen für jeden zugreifenden Nutzer ein Konto (oder einen Freigabe-Link davon).",
      },
      {
        q: "Kann ich Relayium auch selbst hosten?",
        a: "Ja. Anders als Nextclouds Stack aus mehreren Diensten ist Relayiums Server ein einziger Container: ein einziger docker-compose-Befehl startet das gesamte System, mit einem optionalen TURN-Relay-Profil für netzwerkübergreifendes NAT-Traversal.",
      },
      {
        q: "Ist Relayium kostenlos?",
        a: "Ja — kostenlos und Open Source unter der AGPL-3.0-Lizenz, ohne bezahlten Tarif. Nextclouds Kern-Server-Software ist ebenfalls kostenlos und quelloffen; manche Hosting- und Support-Optionen von Nextcloud GmbH sind kostenpflichtig.",
      },
    ],
  },
  cta: {
    text: "Übertrage Dateien in Echtzeit oder teile einen ablaufenden Zero-Knowledge-Link — im selben Netzwerk ohne Cloud-Speicher-Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs Nextcloud pour l'envoi de fichiers",
  description:
    "Un comparatif honnête de Relayium et Nextcloud. Nextcloud est un cloud auto-hébergé complet pour le stockage durable ; Relayium transfère en temps réel sans copie du contenu côté serveur — directement sur le LAN, ou entre réseaux via TURN, qui ne peut ni lire ni déchiffrer le texte chiffré de bout en bout — ou par lien à divulgation nulle qui expire.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Nextcloud a fait de l'auto-hébergement une vraie alternative à Google Drive ou Dropbox : vos propres fichiers, une synchronisation sur tous vos appareils, votre propre calendrier et vos contacts, le tout sous un domaine que vous contrôlez. C'est un logiciel véritablement puissant, et si ce que vous voulez, c'est un foyer permanent pour vos fichiers, Nextcloud est le bon outil.",
    "Cet article compare les deux équitablement. Nextcloud stocke et synchronise durablement les données, avec serveur web, base de données, PHP et mises à jour continues. Relayium répond au besoin plus étroit du transfert : temps réel sans copie du contenu côté serveur, ou lien à divulgation nulle qui expire. Sur le LAN, le contenu passe directement ; entre réseaux, TURN ne relaie que du texte chiffré de bout en bout qu'il ne peut ni lire ni déchiffrer. Pour un stockage cloud durable, choisissez Nextcloud ; pour transférer, Relayium est plus léger.",
  ],
  sections: [
    {
      heading: "Ce que Nextcloud fait bien",
      body: [
        "Nextcloud est une suite cloud auto-hébergée complète : stockage de fichiers avec des clients de synchronisation sur ordinateur et mobile, calendrier, contacts, une suite bureautique, un chat, et par-dessus tout cela un vaste écosystème d'applications. Une fois en place, il se comporte comme un Google Workspace privé — les fichiers y restent en permanence, se synchronisent automatiquement entre appareils, et restent disponibles à tout moment.",
        "C'est un travail fondamentalement différent d'envoyer un fichier. Nextcloud est le bon choix quand vous voulez un foyer permanent et partagé pour vos données : un lecteur d'équipe, une photothèque, un endroit où votre foyer ou votre entreprise conserve des fichiers sur le long terme.",
      ],
    },
    {
      heading: "Là où ils diffèrent : plateforme de stockage vs outil de transfert",
      body: [
        "Comme Nextcloud fait tant de choses, le faire tourner signifie exploiter une véritable plateforme applicative : un serveur web, une base de données (MySQL, PostgreSQL ou SQLite), un environnement PHP, des tâches cron planifiées, et des mises à jour périodiques du cœur et de chaque application installée. C'est un prix raisonnable pour tout ce que vous obtenez, mais c'est un travail continu, et c'est à vous de planifier la capacité de stockage pour tout ce que vous y conservez.",
        "Relayium n'essaie pas d'être une plateforme de stockage. Le temps réel ne crée ni copie du contenu ni historique côté serveur : le contenu passe directement sur le LAN et via TURN entre réseaux. Le serveur auto-hébergé tient dans un seul conteneur Go avec une petite base SQLite ; les liens stockés sont des blobs chiffrés qu'il ne peut pas lire. Un profil optionnel ajoute TURN pour traverser le NAT entre réseaux.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Transfert en temps réel sans copie du contenu côté serveur",
      body: [
        "Le mode temps réel de Relayium ne conserve ni copie du contenu ni historique côté serveur. Sur le LAN, les fichiers passent directement entre navigateurs ; entre réseaux, les navigateurs utilisent TURN par conception, qui ne relaie que du texte chiffré de bout en bout et ne peut ni le lire ni le déchiffrer. Nextcloud stocke au contraire les partages sur votre serveur. X25519, AES-256-GCM, un SAS identique à 6 chiffres et SHA-256 sécurisent le transfert.",
        "Sur le même réseau, cela ne demande aucun compte du tout : ouvrez relayium.com sur les deux appareils, choisissez jusqu'à 1 000 fichiers, vérifiez le code, et envoyez. Envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte. Si une connexion tombe en cours de route, le transfert reprend au lieu de recommencer. Sur le même réseau, les fichiers passent directement d'un appareil à l'autre ; entre réseaux différents, le transfert emprunte par conception un relais TURN chiffré — il ne fait transiter que du texte chiffré et ne détient jamais la clé.",
      ],
    },
    {
      heading: "Quand le destinataire est hors ligne : les liens stockés à divulgation nulle",
      body: [
        "Le transfert en temps réel exige que les deux soient en ligne en même temps, et c'est là que le serveur toujours actif de Nextcloud a un vrai avantage. Relayium couvre aussi ce cas, sans renoncer à la confidentialité : votre navigateur génère une clé AES-256-GCM aléatoire, chiffre les fichiers avec avant que quoi que ce soit ne quitte votre appareil, et la clé ne vit que dans le fragment de l'URL — la partie après le #, que les navigateurs n'envoient jamais à un serveur. Le serveur ne stocke qu'un texte chiffré qu'il ne peut pas déchiffrer.",
        "Créer un lien stocké exige que l'expéditeur se connecte ; le destinataire n'a besoin d'aucun compte pour télécharger. Chaque lien peut être réglé pour expirer après 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre, ou pour se détruire après le premier téléchargement complet — ce n'est pas un foyer permanent pour le fichier comme un partage Nextcloud, il est fait pour disparaître.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "But : Nextcloud est une plateforme cloud pour un stockage durable et synchronisé ; Relayium propose un transfert en temps réel sans copie du contenu côté serveur, ou un lien qui expire.",
        "Où résident les fichiers : Nextcloud conserve les fichiers sur le serveur. En temps réel, Relayium ne garde ni copie du contenu ni historique côté serveur : LAN direct, ou texte chiffré relayé par TURN entre réseaux. Les liens stockés expirent ou se détruisent après un téléchargement.",
        "Empreinte d'auto-hébergement : Nextcloud a besoin d'un serveur web, d'une base de données, d'un environnement PHP et de mises à jour d'applications continues ; l'auto-hébergement de Relayium est un seul conteneur (docker compose up -d --build) plus un relais TURN optionnel pour les transferts entre réseaux différents.",
        "Comptes : Nextcloud exige un compte pour chaque utilisateur qui y accède ; Relayium n'en exige aucun pour les transferts sur le même réseau, seul l'expéditeur se connecte pour l'appairage entre réseaux différents ou les liens stockés, et les destinataires n'en ont jamais besoin.",
        "Chiffrement : le temps réel de Relayium est de bout en bout avec un SAS à 6 chiffres. Le contenu passe directement sur le LAN ; entre réseaux, TURN ne peut ni lire ni déchiffrer le texte chiffré, tandis que les métadonnées de signalisation sont traitées. Les liens stockés sont à divulgation nulle, avec la clé dans le fragment de l'URL. Les partages Nextcloud résident sur votre serveur, protégés par TLS et le chiffrement au repos configuré.",
        "Coût et ouverture : Relayium est gratuit et sous licence AGPL-3.0 sur github.com/relayium/relayium ; le logiciel serveur de Nextcloud est lui aussi gratuit et open source (AGPL), avec de l'hébergement et du support payants disponibles auprès de Nextcloud GmbH et de partenaires.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Devrais-je utiliser Nextcloud plutôt que Relayium ?",
        a: "Si vous voulez un foyer permanent et synchronisé pour vos fichiers — photos, documents, un lecteur d'équipe partagé —, oui, c'est exactement pour cela que Nextcloud a été conçu. Relayium ne le remplace pas ; il sert la tâche plus étroite de faire passer un fichier d'une personne à une autre, rapidement et en privé.",
      },
      {
        q: "Relayium stocke-t-il mes fichiers comme Nextcloud ?",
        a: "Pas en temps réel : aucune copie du contenu ni aucun historique n'est conservé côté serveur. Le contenu passe directement sur le LAN ; entre réseaux, TURN ne voit que du texte chiffré qu'il ne peut ni lire ni déchiffrer. Les liens stockés conservent du texte chiffré à divulgation nulle seulement jusqu'à expiration ou téléchargement unique, pas durablement comme Nextcloud.",
      },
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Sur le même réseau, non. Envoyer entre réseaux différents avec un code d'appairage, ou créer un lien stocké, exige que l'expéditeur se connecte ; le destinataire n'a jamais besoin de compte. Nextcloud exige quant à lui un compte (ou un lien de partage créé par un compte) pour chaque utilisateur qui y accède.",
      },
      {
        q: "Puis-je aussi auto-héberger Relayium ?",
        a: "Oui. Contrairement à la pile multi-services de Nextcloud, le serveur de Relayium est un seul conteneur : une seule commande docker compose fait tourner tout le système, avec un profil de relais TURN optionnel pour le NAT traversal entre réseaux différents.",
      },
      {
        q: "Relayium est-il gratuit ?",
        a: "Oui — gratuit et open source sous licence AGPL-3.0, sans offre payante. Le logiciel serveur cœur de Nextcloud est lui aussi gratuit et open source ; certaines options d'hébergement et de support de Nextcloud GmbH sont payantes.",
      },
    ],
  },
  cta: {
    text: "Transférez des fichiers en temps réel ou partagez un lien à divulgation nulle qui expire — sans compte de stockage cloud sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل Nextcloud لإرسال الملفات",
  description:
    "مقارنة صادقة بين Relayium و Nextcloud. إن Nextcloud سحابة كاملة ذاتية الاستضافة للتخزين الدائم؛ أما Relayium فينقل آنيًا بلا نسخة محتوى على الخادم — مباشرة داخل LAN، أو عبر TURN بين الشبكات حيث لا يستطيع قراءة النص المشفّر من الطرف إلى الطرف أو فكّه — أو برابط معرفة صفرية ينتهي.",
  updatedLabel: "آخر تحديث",
  lead: [
    "حوّل Nextcloud الاستضافة الذاتية إلى بديل حقيقي عن Google Drive أو Dropbox: ملفاتك أنت، ومزامنتك أنت عبر كل جهاز، وتقويمك وجهات اتصالك أنت، كلها تحت نطاق تتحكم فيه. إنه برنامج قوي فعلًا، وإن كان ما تريده بيتًا دائمًا لملفاتك، فإن Nextcloud هو الأداة المناسبة للمهمة.",
    "يقارن هذا المقال الاثنين بإنصاف. يخزّن Nextcloud البيانات ويزامنها دائمًا، مع خادم ويب وقاعدة بيانات وPHP وتحديثات مستمرة. يحلّ Relayium مهمة النقل الأضيق: نقل آني بلا نسخة محتوى على الخادم، أو رابط معرفة صفرية ينتهي. يمر المحتوى مباشرة داخل LAN؛ وبين الشبكات لا يمرر TURN إلا نصًا مشفّرًا من الطرف إلى الطرف لا يستطيع قراءته أو فكّه. للتخزين السحابي الدائم اختر Nextcloud؛ وللنقل Relayium أخف.",
  ],
  sections: [
    {
      heading: "ما يبرع فيه Nextcloud",
      body: [
        "إن Nextcloud حزمة سحابية ذاتية الاستضافة كاملة: تخزين ملفات مع عملاء مزامنة لسطح المكتب والجوال، وتقاويم، وجهات اتصال، وحزمة مكتبية، ودردشة، ومنظومة تطبيقات واسعة فوق ذلك. متى شُغِّل، تصرّف كأنه Google Workspace خاص — تعيش الملفات هناك بشكل دائم، وتتزامن تلقائيًا عبر الأجهزة، وتبقى متاحة متى احتجتها.",
        "هذه مهمة مختلفة فعلًا عن إرسال ملف. إن Nextcloud هو الخيار الصحيح حين تريد بيتًا دائمًا ومشتركًا لبياناتك: قرص فريق، أو مكتبة صور، أو مكان يحتفظ فيه بيتك أو شركتك بالملفات على المدى الطويل.",
      ],
    },
    {
      heading: "أين يختلفان: منصة تخزين مقابل أداة نقل",
      body: [
        "لأن Nextcloud يفعل الكثير، فإن تشغيله يعني تشغيل منصة تطبيقات حقيقية: خادم ويب، وقاعدة بيانات (MySQL أو PostgreSQL أو SQLite)، وبيئة تشغيل PHP، ومهام cron مجدولة، وتحديثات دورية للنواة ولأي تطبيقات ثبّتها. هذا ثمن عادل مقابل كل ما تحصل عليه، لكنه عمل مستمر، وأنت من يخطّط لسعة التخزين لكل ما تحتفظ به هناك.",
        "لا يحاول Relayium أن يكون منصة تخزين. لا ينشئ النقل الآني نسخة محتوى أو سجلًا على الخادم: المحتوى مباشر داخل LAN وعبر TURN بين الشبكات. الخادم ذاتي الاستضافة حاوية Go واحدة مع قاعدة SQLite صغيرة؛ والروابط المُخزَّنة كتل مشفّرة لا يستطيع قراءتها. يضيف ملف اختياري TURN لاجتياز NAT بين الشبكات.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "نقل آني بلا نسخة محتوى على الخادم",
      body: [
        "لا يحتفظ الوضع الفوري في Relayium بنسخة محتوى أو سجل على الخادم. داخل LAN تمر الملفات مباشرة بين المتصفحات؛ وبين الشبكات تستخدم المتصفحات TURN بحكم التصميم، فلا يمرر إلا نصًا مشفّرًا من الطرف إلى الطرف ولا يستطيع قراءته أو فكّه. أما Nextcloud فيخزّن المشاركات على خادمك. ويحمي النقل X25519 وAES-256-GCM ورمز SAS متطابق من 6 أرقام وSHA-256.",
        "على نفس الشبكة لا يحتاج هذا حسابًا إطلاقًا: افتح relayium.com على الجهازين، واختر حتى 1000 ملف، وتحقّق من الرمز، وأرسِل. أما الإرسال عبر الشبكات برمز اقتران فيتطلب من المُرسِل تسجيل الدخول — ولا يحتاج المُستقبِل حسابًا أبدًا. إن انقطع اتصال في منتصف النقل استُؤنف بدل البدء من جديد. وعلى نفس الشبكة تنتقل الملفات مباشرةً بين الجهازين؛ أما عبر الشبكات فيمرّ النقل بحكم التصميم عبر مُرحِّل TURN مُشفَّر — لا يُمرِّر سوى نص مُشفَّر ولا يملك المفتاح أبدًا.",
      ],
    },
    {
      heading: "حين يكون المُستقبِل غير متصل: روابط مُخزَّنة بمعرفة صفرية",
      body: [
        "يحتاج النقل الفوري إلى وجود الطرفين متصلين في آنٍ واحد، وهنا يتفوّق خادم Nextcloud الدائم التشغيل تفوّقًا حقيقيًا. يغطّي Relayium هذه الحالة أيضًا، دون التخلّي عن الخصوصية: يولّد متصفحك مفتاح AES-256-GCM عشوائيًا، ويشفّر به الملفات قبل أن يغادر أي شيء جهازك، ويعيش المفتاح في جزء الـ URL فقط — الجزء بعد # الذي لا ترسله المتصفحات أبدًا إلى خادم. يخزّن الخادم نصًا مُشفَّرًا لا يستطيع فكّه.",
        "يتطلب إنشاء رابط مُخزَّن من المُرسِل تسجيل الدخول؛ ولا يحتاج المُستقبِل حسابًا للتنزيل. يمكن ضبط كل رابط لينتهي بعد ساعة واحدة أو يوم واحد أو 3 أيام أو 7 أيام أو حتى 14 يومًا حسب خطتك، أو ليُحرَق بعد أول تنزيل كامل — فهو ليس بيتًا دائمًا للملف مثل مشاركة Nextcloud، بل قُصِد له أن يختفي.",
      ],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: ["أهمّ الفروق، جنبًا إلى جنب:"],
      bullets: [
        "الغرض: إن Nextcloud منصة سحابية لتخزين دائم ومتزامن؛ أما Relayium فيقدم نقلًا آنيًا بلا نسخة محتوى على الخادم أو رابطًا ينتهي.",
        "أين تعيش الملفات: يبقي Nextcloud الملفات على الخادم. أما Relayium فلا يحتفظ في الوضع الفوري بنسخة محتوى أو سجل على الخادم: LAN مباشر أو نص مشفّر يمر عبر TURN بين الشبكات. وتنتهي الروابط المُخزَّنة أو تُحرَق بعد تنزيل واحد.",
        "أثر الاستضافة الذاتية: يحتاج Nextcloud إلى خادم ويب وقاعدة بيانات وبيئة تشغيل PHP وتحديثات تطبيقات مستمرة؛ أما الاستضافة الذاتية في Relayium فحاوية واحدة (docker compose up -d --build) إضافةً إلى مُرحِّل TURN اختياري للنقل عبر الشبكات.",
        "الحسابات: يحتاج Nextcloud إلى حساب لكل مستخدم يصل إليه؛ أما Relayium فلا يحتاج أيًا منها للنقل على نفس الشبكة، ولا يسجّل الدخول إلا المُرسِل للاقتران عبر الشبكات أو للروابط المُخزَّنة، ولا يحتاج المُستقبِلون حسابًا أبدًا.",
        "التشفير: الوضع الفوري في Relayium من الطرف إلى الطرف برمز SAS من 6 أرقام. المحتوى مباشر داخل LAN؛ وبين الشبكات لا يستطيع TURN قراءة النص المشفّر أو فكّه، مع معالجة بيانات الإشارة الوصفية. الروابط المُخزَّنة بمعرفة صفرية ومفتاحها في جزء URL. أما مشاركات Nextcloud فتقيم على خادمك وتحميها TLS وأي تشفير سكون تضبطه.",
        "التكلفة والانفتاح: إن Relayium مجاني ومرخَّص بـ AGPL-3.0 على github.com/relayium/relayium؛ وبرنامج خادم Nextcloud مجاني ومفتوح المصدر أيضًا (AGPL)، مع استضافة ودعم مدفوعين متاحين من Nextcloud GmbH وشركائها.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل ينبغي أن أستخدم Nextcloud بدل Relayium؟",
        a: "إن أردت بيتًا دائمًا ومتزامنًا لملفاتك — صور، مستندات، قرص فريق مشترك — فنعم، هذا بالضبط ما بُني له Nextcloud. ليس Relayium بديلًا عن ذلك؛ فهو للمهمة الأضيق المتمثّلة في إيصال ملف من شخص إلى آخر، بسرعة وبخصوصية.",
      },
      {
        q: "هل يخزّن Relayium ملفاتي كما يفعل Nextcloud؟",
        a: "ليس في الوضع الفوري: لا توجد نسخة محتوى أو سجل على الخادم. المحتوى مباشر داخل LAN؛ وبين الشبكات لا يرى TURN إلا نصًا مشفّرًا لا يستطيع قراءته أو فكّه. تحتفظ الروابط المُخزَّنة بنص معرفة صفرية مشفّر حتى الانتهاء أو التنزيل الواحد فقط، لا دائمًا مثل Nextcloud.",
      },
      {
        q: "هل أحتاج إلى حساب؟",
        a: "على نفس الشبكة، لا. أما الإرسال عبر الشبكات برمز اقتران، أو إنشاء رابط مُخزَّن، فيتطلب من المُرسِل تسجيل الدخول؛ ولا يحتاج المُستقبِل حسابًا أبدًا. أما Nextcloud فيتطلب حسابًا (أو رابط مشاركة من حساب) لكل مستخدم يصل إليه.",
      },
      {
        q: "هل أستطيع استضافة Relayium ذاتيًا أيضًا؟",
        a: "نعم. خلافًا لحزمة الخدمات المتعددة في Nextcloud، خادم Relayium حاوية واحدة: أمر docker compose واحد يشغّل كل شيء، مع ملف تعريف مُرحِّل TURN اختياري لاجتياز NAT عبر الشبكات.",
      },
      {
        q: "هل Relayium مجاني؟",
        a: "نعم — مجاني ومفتوح المصدر بموجب ترخيص AGPL-3.0، بلا فئة مدفوعة. وبرنامج خادم Nextcloud الأساسي مجاني ومفتوح المصدر أيضًا؛ لكن بعض خيارات الاستضافة والدعم من Nextcloud GmbH مدفوعة.",
      },
    ],
  },
  cta: {
    text: "انقل الملفات آنيًا أو شارك رابط معرفة صفرية ينتهي — بلا حساب تخزين سحابي على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium vs Nextcloud para enviar archivos",
  description:
    "Una comparación honesta de Relayium y Nextcloud. Nextcloud es una nube autoalojada completa para almacenamiento duradero; Relayium transfiere en tiempo real sin copia de contenido en el servidor — directo en la LAN, o entre redes mediante TURN, que no puede leer ni descifrar el texto cifrado de extremo a extremo — o mediante un enlace de conocimiento cero que expira.",
  updatedLabel: "Última actualización",
  lead: [
    "Nextcloud convirtió el autoalojamiento en una alternativa real a Google Drive o Dropbox: tus propios archivos, tu propia sincronización en cada dispositivo, tu propio calendario y contactos, todo bajo un dominio que controlas. Es software genuinamente potente, y si lo que quieres es un hogar permanente para tus archivos, Nextcloud es la herramienta adecuada para ese trabajo.",
    "Este artículo compara ambos de forma justa. Nextcloud almacena y sincroniza datos de forma duradera, con servidor web, base de datos, PHP y actualizaciones continuas. Relayium resuelve la tarea más estrecha de transferir: tiempo real sin copia de contenido en el servidor, o un enlace de conocimiento cero que expira. En la LAN el contenido va directo; entre redes TURN solo retransmite texto cifrado de extremo a extremo que no puede leer ni descifrar. Para almacenamiento duradero elige Nextcloud; para transferir, Relayium es más ligero.",
  ],
  sections: [
    {
      heading: "Lo que Nextcloud hace bien",
      body: [
        "Nextcloud es una suite de nube autoalojada completa: almacenamiento de archivos con clientes de sincronización de escritorio y móvil, calendarios, contactos, una suite ofimática, chat y un gran ecosistema de aplicaciones encima. Una vez en marcha, se comporta como un Google Workspace privado — los archivos viven ahí de forma permanente, se sincronizan automáticamente entre dispositivos y siguen disponibles siempre que los necesites.",
        "Ese es un trabajo genuinamente distinto de enviar un archivo. Nextcloud es la elección correcta cuando quieres un hogar permanente y compartido para tus datos: una unidad de equipo, una fototeca, un lugar donde tu hogar o tu empresa guarda archivos a largo plazo.",
      ],
    },
    {
      heading: "En qué se diferencian: una plataforma de almacenamiento vs una herramienta de transferencia",
      body: [
        "Como Nextcloud hace tanto, ejecutarlo significa ejecutar una verdadera plataforma de aplicaciones: un servidor web, una base de datos (MySQL, PostgreSQL o SQLite), un entorno de ejecución PHP, tareas cron programadas y actualizaciones periódicas del núcleo y de cualquier aplicación que hayas instalado. Es un precio justo por todo lo que obtienes, pero es trabajo continuo, y eres tú quien planifica la capacidad de almacenamiento para todo lo que guardas ahí.",
        "Relayium no intenta ser una plataforma de almacenamiento. El tiempo real no crea copia de contenido ni historial en el servidor: el contenido va directo en la LAN y mediante TURN entre redes. El servidor autoalojado es un solo contenedor Go con una pequeña base SQLite; los enlaces almacenados son blobs cifrados que no puede leer. Un perfil opcional añade TURN para atravesar NAT entre redes.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Transferencia en tiempo real sin copia de contenido en el servidor",
      body: [
        "El modo en tiempo real de Relayium no conserva copia de contenido ni historial en el servidor. En la LAN los archivos van directamente entre navegadores; entre redes los navegadores usan TURN por diseño, que solo retransmite texto cifrado de extremo a extremo y no puede leerlo ni descifrarlo. Nextcloud, en cambio, almacena los recursos compartidos en tu servidor. X25519, AES-256-GCM, un SAS coincidente de 6 dígitos y SHA-256 protegen la transferencia.",
        "En la misma red esto no necesita cuenta alguna: abre relayium.com en ambos dispositivos, elige hasta 1.000 archivos, verifica el código y envía. Enviar entre redes con un código de emparejamiento requiere que el remitente inicie sesión — el destinatario nunca necesita cuenta. Si una conexión se cae a mitad de la transferencia, se reanuda en lugar de reiniciarse. En la misma red los archivos viajan directamente entre los dos dispositivos; entre redes distintas la transferencia pasa por diseño por un retransmisor TURN cifrado — solo reenvía texto cifrado y nunca tiene la clave.",
      ],
    },
    {
      heading: "Cuando el destinatario está desconectado: enlaces almacenados de conocimiento cero",
      body: [
        "La transferencia en tiempo real necesita que ambas personas estén conectadas a la vez, y ahí es donde el servidor siempre activo de Nextcloud tiene una ventaja real. Relayium cubre ese caso también, sin renunciar a la privacidad: tu navegador genera una clave AES-256-GCM aleatoria, cifra los archivos con ella antes de que nada salga de tu dispositivo, y la clave vive solo en el fragmento de la URL — la parte después del # que los navegadores nunca envían a un servidor. El servidor almacena texto cifrado que no puede descifrar.",
        "Crear un enlace almacenado requiere que el remitente inicie sesión; el destinatario no necesita cuenta para descargar. Cada enlace puede configurarse para expirar tras 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o para destruirse tras la primera descarga completa — no pretende ser un hogar permanente para el archivo como un recurso compartido de Nextcloud, está pensado para desaparecer.",
      ],
    },
    {
      heading: "Comparativa de funciones de un vistazo",
      body: ["Las diferencias que más importan, una al lado de la otra:"],
      bullets: [
        "Propósito: Nextcloud es una plataforma de nube para almacenamiento duradero y sincronizado; Relayium ofrece transferencia en tiempo real sin copia de contenido en el servidor, o un enlace que expira.",
        "Dónde viven los archivos: Nextcloud mantiene los archivos en el servidor. En tiempo real, Relayium no conserva copia de contenido ni historial en el servidor: LAN directa, o texto cifrado retransmitido por TURN entre redes. Los enlaces almacenados expiran o se destruyen tras una descarga.",
        "Huella de autoalojamiento: Nextcloud necesita un servidor web, una base de datos, un entorno de ejecución PHP y actualizaciones continuas de aplicaciones; el autoalojamiento de Relayium es un solo contenedor (docker compose up -d --build) más un retransmisor TURN opcional para transferencias entre redes.",
        "Cuentas: Nextcloud necesita una cuenta para cada usuario que accede a él; Relayium no necesita ninguna para transferencias en la misma red, solo el remitente inicia sesión para el emparejamiento entre redes o los enlaces almacenados, y los destinatarios nunca necesitan una.",
        "Cifrado: el tiempo real de Relayium es de extremo a extremo con SAS de 6 dígitos. El contenido va directo en la LAN; entre redes TURN no puede leer ni descifrar el texto cifrado, mientras se procesan metadatos de señalización. Los enlaces almacenados son de conocimiento cero y la clave queda en el fragmento de URL. Los recursos de Nextcloud residen en tu servidor, protegidos por TLS y el cifrado en reposo configurado.",
        "Coste y apertura: Relayium es gratis y con licencia AGPL-3.0 en github.com/relayium/relayium; el software de servidor de Nextcloud también es gratis y de código abierto (AGPL), con alojamiento y soporte de pago disponibles de Nextcloud GmbH y socios.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Debería usar Nextcloud en lugar de Relayium?",
        a: "Si quieres un hogar permanente y sincronizado para tus archivos — fotos, documentos, una unidad de equipo compartida —, sí, eso es exactamente para lo que se construyó Nextcloud. Relayium no lo reemplaza; es para el trabajo más estrecho de llevar un archivo de una persona a otra, de forma rápida y privada.",
      },
      {
        q: "¿Almacena Relayium mis archivos como lo hace Nextcloud?",
        a: "No en tiempo real: no se guarda copia de contenido ni historial en el servidor. En la LAN el contenido va directo; entre redes TURN solo ve texto cifrado que no puede leer ni descifrar. Los enlaces almacenados conservan texto cifrado de conocimiento cero solo hasta expirar o descargarse una vez, no de forma duradera como Nextcloud.",
      },
      {
        q: "¿Necesito una cuenta?",
        a: "En la misma red, no. Enviar entre redes con un código de emparejamiento, o crear un enlace almacenado, requiere que el remitente inicie sesión; el destinatario nunca necesita cuenta. Nextcloud, en cambio, requiere una cuenta (o un enlace para compartir creado por una) para cada usuario que accede a él.",
      },
      {
        q: "¿Puedo autoalojar Relayium también?",
        a: "Sí. A diferencia de la pila multiservicio de Nextcloud, el servidor de Relayium es un solo contenedor: un único comando docker compose ejecuta todo el sistema, con un perfil de retransmisor TURN opcional para atravesar NAT entre redes.",
      },
      {
        q: "¿Es gratis Relayium?",
        a: "Sí — gratis y de código abierto bajo la licencia AGPL-3.0, sin nivel de pago. El software de servidor central de Nextcloud también es gratis y de código abierto; algunas opciones de alojamiento y soporte de Nextcloud GmbH son de pago.",
      },
    ],
  },
  cta: {
    text: "Transfiere archivos en tiempo real o comparte un enlace de conocimiento cero que expira — sin cuenta de almacenamiento en la nube en la misma red.",
    button: "Probar Relayium ahora",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Relayium vs Nextcloud para enviar arquivos",
  description:
    "Uma comparação honesta entre Relayium e Nextcloud. O Nextcloud é uma nuvem auto-hospedada completa para armazenamento duradouro; o Relayium transfere em tempo real sem cópia de conteúdo no servidor — direto na LAN, ou entre redes via TURN, que não consegue ler nem descriptografar o texto cifrado de ponta a ponta — ou por um link de conhecimento zero que expira.",
  updatedLabel: "Última atualização",
  lead: [
    "O Nextcloud transformou a auto-hospedagem em uma alternativa de verdade ao Google Drive ou ao Dropbox: seus próprios arquivos, sua própria sincronização em todos os dispositivos, seu próprio calendário e contatos, tudo sob um domínio que você controla. É um software genuinamente poderoso, e se o que você quer é um lar permanente para seus arquivos, o Nextcloud é a ferramenta certa para o trabalho.",
    "Este artigo compara os dois de forma justa. O Nextcloud armazena e sincroniza dados de forma duradoura, com servidor web, banco de dados, PHP e atualizações contínuas. O Relayium resolve a tarefa mais estreita da transferência: tempo real sem cópia de conteúdo no servidor, ou um link de conhecimento zero que expira. Na LAN o conteúdo vai direto; entre redes o TURN só retransmite texto cifrado de ponta a ponta que não consegue ler nem descriptografar. Para armazenamento duradouro escolha o Nextcloud; para transferir, o Relayium é mais leve.",
  ],
  sections: [
    {
      heading: "O que o Nextcloud faz bem",
      body: [
        "O Nextcloud é uma suíte de nuvem auto-hospedada completa: armazenamento de arquivos com clientes de sincronização para desktop e celular, calendários, contatos, uma suíte de escritório, chat e um grande ecossistema de aplicativos por cima. Uma vez em funcionamento, ele se comporta como um Google Workspace privado — os arquivos vivem ali permanentemente, sincronizam automaticamente entre dispositivos e ficam disponíveis sempre que você precisar.",
        "Esse é um trabalho genuinamente diferente de enviar um arquivo. O Nextcloud é a escolha certa quando você quer um lar permanente e compartilhado para seus dados: um drive de equipe, uma biblioteca de fotos, um lugar onde sua casa ou empresa guarda arquivos a longo prazo.",
      ],
    },
    {
      heading: "Onde eles diferem: uma plataforma de armazenamento vs uma ferramenta de transferência",
      body: [
        "Como o Nextcloud faz tanta coisa, executá-lo significa executar uma verdadeira plataforma de aplicativos: um servidor web, um banco de dados (MySQL, PostgreSQL ou SQLite), um ambiente de execução PHP, tarefas cron agendadas e atualizações periódicas do núcleo e de cada aplicativo que você instalou. É um preço justo por tudo o que você recebe, mas é um trabalho contínuo, e é você quem planeja a capacidade de armazenamento para tudo o que guarda ali.",
        "O Relayium não tenta ser uma plataforma de armazenamento. O tempo real não cria cópia de conteúdo nem histórico no servidor: o conteúdo vai direto na LAN e via TURN entre redes. O servidor auto-hospedado é um único contêiner Go com um pequeno SQLite; os links armazenados são blobs criptografados que ele não consegue ler. Um perfil opcional adiciona TURN para travessia de NAT entre redes.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Transferência em tempo real sem cópia de conteúdo no servidor",
      body: [
        "O modo em tempo real do Relayium não mantém cópia de conteúdo nem histórico no servidor. Na LAN os arquivos vão direto entre navegadores; entre redes os navegadores usam TURN por projeto, que só retransmite texto cifrado de ponta a ponta e não consegue lê-lo nem descriptografá-lo. O Nextcloud, por outro lado, armazena os compartilhamentos no seu servidor. X25519, AES-256-GCM, um SAS idêntico de 6 dígitos e SHA-256 protegem a transferência.",
        "Na mesma rede isso não precisa de conta alguma: abra o relayium.com nos dois dispositivos, escolha até 1.000 arquivos, verifique o código e envie. Enviar entre redes com um código de emparelhamento exige que o remetente faça login — o destinatário nunca precisa de conta. Se uma conexão cai no meio da transferência, ela retoma em vez de recomeçar. Na mesma rede os arquivos vão direto entre os dois dispositivos; entre redes diferentes a transferência passa, por decisão de projeto, por um retransmissor TURN criptografado — ele só encaminha texto cifrado e nunca detém a chave.",
      ],
    },
    {
      heading: "Quando o destinatário está offline: links armazenados de conhecimento zero",
      body: [
        "A transferência em tempo real precisa que as duas pessoas estejam online ao mesmo tempo, e é aí que o servidor sempre ativo do Nextcloud tem uma vantagem real. O Relayium também cobre esse caso, sem abrir mão da privacidade: seu navegador gera uma chave AES-256-GCM aleatória, criptografa os arquivos com ela antes que qualquer coisa saia do seu dispositivo, e a chave vive apenas no fragmento da URL — a parte depois do # que os navegadores nunca enviam a um servidor. O servidor armazena texto cifrado que não consegue descriptografar.",
        "Criar um link armazenado exige que o remetente faça login; o destinatário não precisa de conta para baixar. Cada link pode ser configurado para expirar após 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou para se autodestruir após o primeiro download completo — ele não pretende ser um lar permanente para o arquivo como um compartilhamento do Nextcloud, ele foi feito para desaparecer.",
      ],
    },
    {
      heading: "Comparação de recursos em resumo",
      body: ["As diferenças que mais importam, lado a lado:"],
      bullets: [
        "Propósito: o Nextcloud é uma plataforma de nuvem para armazenamento duradouro e sincronizado; o Relayium oferece transferência em tempo real sem cópia de conteúdo no servidor, ou um link que expira.",
        "Onde os arquivos ficam: o Nextcloud mantém os arquivos no servidor. Em tempo real, o Relayium não guarda cópia de conteúdo nem histórico no servidor: LAN direta, ou texto cifrado retransmitido por TURN entre redes. Os links armazenados expiram ou se autodestroem após um download.",
        "Pegada de auto-hospedagem: o Nextcloud precisa de um servidor web, um banco de dados, um ambiente de execução PHP e atualizações contínuas de aplicativos; a auto-hospedagem do Relayium é um único contêiner (docker compose up -d --build) mais um retransmissor TURN opcional para transferências entre redes.",
        "Contas: o Nextcloud precisa de uma conta para cada usuário que o acessa; o Relayium não precisa de nenhuma para transferências na mesma rede, só o remetente faz login para o emparelhamento entre redes ou os links armazenados, e os destinatários nunca precisam de uma.",
        "Criptografia: o tempo real do Relayium é de ponta a ponta com SAS de 6 dígitos. O conteúdo vai direto na LAN; entre redes o TURN não consegue ler nem descriptografar o texto cifrado, enquanto metadados de sinalização são processados. Links armazenados são de conhecimento zero e a chave fica no fragmento da URL. Compartilhamentos do Nextcloud residem no seu servidor, protegidos por TLS e pela criptografia em repouso configurada.",
        "Custo e abertura: o Relayium é gratuito e licenciado sob AGPL-3.0 em github.com/relayium/relayium; o software de servidor do Nextcloud também é gratuito e de código aberto (AGPL), com hospedagem e suporte pagos disponíveis pela Nextcloud GmbH e parceiros.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Devo usar o Nextcloud em vez do Relayium?",
        a: "Se você quer um lar permanente e sincronizado para seus arquivos — fotos, documentos, um drive de equipe compartilhado —, sim, é exatamente para isso que o Nextcloud foi construído. O Relayium não é um substituto para isso; ele é para o trabalho mais estreito de levar um arquivo de uma pessoa a outra, de forma rápida e privada.",
      },
      {
        q: "O Relayium armazena meus arquivos do jeito que o Nextcloud faz?",
        a: "Não em tempo real: não há cópia de conteúdo nem histórico no servidor. Na LAN o conteúdo vai direto; entre redes o TURN só vê texto cifrado que não consegue ler nem descriptografar. Os links armazenados mantêm texto cifrado de conhecimento zero apenas até expirar ou baixar uma vez, não de forma duradoura como o Nextcloud.",
      },
      {
        q: "Preciso de uma conta?",
        a: "Na mesma rede, não. Enviar entre redes com um código de emparelhamento, ou criar um link armazenado, exige que o remetente faça login; o destinatário nunca precisa de conta. O Nextcloud, por outro lado, exige uma conta (ou um link de compartilhamento criado por uma) para cada usuário que o acessa.",
      },
      {
        q: "Também posso auto-hospedar o Relayium?",
        a: "Sim. Diferente da pilha multisserviço do Nextcloud, o servidor do Relayium é um único contêiner: um único comando docker compose executa o sistema inteiro, com um perfil de retransmissor TURN opcional para travessia de NAT entre redes.",
      },
      {
        q: "O Relayium é gratuito?",
        a: "Sim — gratuito e de código aberto sob a licença AGPL-3.0, sem nível pago. O software de servidor central do Nextcloud também é gratuito e de código aberto; algumas opções de hospedagem e suporte da Nextcloud GmbH são pagas.",
      },
    ],
  },
  cta: {
    text: "Transfira arquivos em tempo real ou compartilhe um link de conhecimento zero que expira — sem conta de armazenamento em nuvem na mesma rede.",
    button: "Experimentar o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/nextcloud",
  published: "2026-07-09",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
