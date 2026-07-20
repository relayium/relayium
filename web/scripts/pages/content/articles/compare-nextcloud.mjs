// web/scripts/pages/content/articles/compare-nextcloud.mjs
// Objective comparison: Relayium vs Nextcloud. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "Relayium vs Nextcloud for sending files",
  description:
    "An honest comparison of Relayium and Nextcloud. Nextcloud is a full self-hosted cloud platform for durable storage; Relayium is a focused transfer tool — direct P2P or a zero-knowledge expiring link, with a lightweight single-container self-host.",
  updatedLabel: "Last updated",
  lead: [
    "Nextcloud turned self-hosting into a real alternative to Google Drive or Dropbox: your own files, your own sync across every device, your own calendar and contacts, all under a domain you control. It's genuinely powerful software, and if what you want is a permanent home for your files, Nextcloud is the right tool for the job.",
    "This article compares the two fairly. Nextcloud is built to store your data indefinitely and keep it in sync — that scope is its strength, and it comes with real setup and maintenance: a web server, a database, a PHP runtime, and ongoing updates for the platform and its apps. Relayium solves a narrower problem: getting a file from one person to another, either directly with nothing stored at all, or through a link that expires. If you need durable cloud storage, Nextcloud is the better fit. If you just need to move a file, Relayium is lighter.",
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
        "Relayium doesn't try to be a storage platform. It's scoped to moving files from one place to another — realtime peer-to-peer, or a link that expires. Its self-hosted server is a single container: one Go binary that serves the app and keeps a small SQLite database plus, for stored links, encrypted blobs it cannot read. That command is the whole setup; an optional profile adds a TURN relay for cross-network NAT traversal. If all you need is to get a file from A to B, that's a lot less to run and keep updated.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Direct P2P transfers, nothing stored",
      body: [
        "Relayium's realtime mode sends files straight between two devices over an encrypted peer-to-peer channel — Nextcloud has no equivalent, since every Nextcloud share is uploaded to and downloaded from your server. An X25519 key exchange derives a key for AES-256-GCM, both devices show a matching 6-digit verification code (SAS) to rule out a man-in-the-middle, and each file is checked end-to-end with a SHA-256 hash.",
        "On the same network this needs no account at all: open relayium.com on both devices, pick up to 1,000 files, verify the code, and send. Sending across networks with a pairing code requires the sender to sign in — the recipient never needs an account. If a connection drops mid-transfer it resumes instead of restarting, and when a direct path isn't possible it falls back to an encrypted TURN relay that only ever sees ciphertext.",
      ],
    },
    {
      heading: "When the recipient is offline: zero-knowledge stored links",
      body: [
        "Realtime transfer needs both people online at once, which is where Nextcloud's always-on server has a real edge. Relayium covers that case too, without giving up privacy: your browser generates a random AES-256-GCM key, encrypts the files with it before anything leaves your device, and the key lives only in the URL fragment — the part after the # that browsers never send to a server. The server stores ciphertext it cannot decrypt.",
        "Creating a stored link requires the sender to sign in; the recipient needs no account to download. Each link can be set to expire after 1 hour, 1 day, 3 days, or up to 7 days depending on your plan, or to burn after the first complete download — it isn't meant to be a permanent home for the file like a Nextcloud share, it's meant to disappear.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Purpose: Nextcloud is a full cloud platform for durable, synced storage; Relayium is a focused tool for direct transfer or an expiring link.",
        "Where files live: Nextcloud keeps your files on the server for as long as you want; Relayium's realtime mode never stores them at all, and stored links expire or burn after one download.",
        "Self-host footprint: Nextcloud needs a web server, database, PHP runtime, and ongoing app updates; Relayium's self-host is a single container (docker compose up -d --build) plus an optional TURN relay for cross-network transfers.",
        "Accounts: Nextcloud needs an account for every user who accesses it; Relayium needs none for same-network transfers, only the sender signs in for cross-network pairing or stored links, and recipients never need one.",
        "Encryption: Relayium's realtime mode is end-to-end with a 6-digit SAS code and never touches a server; stored links are zero-knowledge with a random key that never leaves the URL fragment. Nextcloud shares are uploaded to and downloaded from your server, protected by TLS in transit and whatever encryption-at-rest you configure.",
        "Cost and openness: Relayium is free and MIT-licensed at github.com/relayium/relayium; Nextcloud's server software is also free and open source (AGPL), with paid hosting and support available from Nextcloud GmbH and partners.",
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
        a: "No. In realtime mode nothing is stored anywhere — the file goes directly between devices. Stored links keep zero-knowledge ciphertext only until they expire (1 hour up to 7 days, depending on your plan) or are downloaded once with burn-after-read, not indefinitely like a Nextcloud share.",
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
        a: "Yes — free and open source under the MIT license, with no paid tier. Nextcloud's core server software is also free and open source; some hosting and support options from Nextcloud GmbH are paid.",
      },
    ],
  },
  cta: {
    text: "Send a file directly, or share a zero-knowledge link that expires — no cloud storage account required on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 Nextcloud：发送文件该选谁",
  description:
    "客观对比 Relayium 与 Nextcloud。Nextcloud 是功能完整的自托管云平台，适合长期存储；Relayium 专注于文件传输本身——点对点直连，或零知识加密的到期链接，并提供轻量的单容器自托管方案。",
  updatedLabel: "最近更新",
  lead: [
    "Nextcloud 把自托管变成了 Google Drive 或 Dropbox 真正意义上的替代品：自己的文件、跨所有设备的同步、自己的日历和联系人，一切都在你自己掌控的域名下运行。这是货真价实的强大软件——如果你想要的是文件的长期归宿，Nextcloud 就是对的工具。",
    "本文客观对比这两者。Nextcloud 的定位是长期存储数据并保持同步——这个定位本身就是它的优势，也意味着实打实的搭建与维护成本：一台 Web 服务器、一个数据库、一个 PHP 运行时，以及对核心程序和已安装应用持续不断的更新。Relayium 要解决的是一个更窄的问题：把文件从一个人传给另一个人，要么直接传输、什么都不存储，要么生成一个会过期的链接。如果你需要的是持久的云存储，Nextcloud 更合适；如果你只是想传个文件，Relayium 更轻。",
  ],
  sections: [
    {
      heading: "Nextcloud 做得好的地方",
      body: [
        "Nextcloud 是一整套自托管云套件：文件存储、桌面和移动端同步客户端、日历、联系人、办公套件、聊天，再加上庞大的应用生态。一旦搭建起来，它的使用体验就像私有的 Google Workspace——文件长期留在那里，跨设备自动同步，随时可用。",
        "这和“发送一个文件”是完全不同的任务。当你想要的是数据的长期共享归宿——团队共享盘、相册库、家庭或公司长期存放文件的地方——Nextcloud 正是对的选择。",
      ],
    },
    {
      heading: "差异所在：存储平台 vs 传输工具",
      body: [
        "正因为 Nextcloud 做的事情很多，运行它就意味着要运行一整个应用平台：一台 Web 服务器、一个数据库（MySQL、PostgreSQL 或 SQLite）、一个 PHP 运行时、定时的 cron 任务，以及对核心程序和你安装的每个应用的持续更新。考虑到它带来的一切，这是合理的代价，但确实是持续的运维工作，而且你存放的所有内容的存储容量也要由你自己规划。",
        "Relayium 并不试图成为一个存储平台。它的目标很窄：把文件从一处送到另一处——实时点对点传输，或一个会过期的链接。它的自托管服务端是单一容器：一个提供应用服务的 Go 二进制文件，附带一个小型 SQLite 数据库，以及（针对存储链接）它自己也无法读取的加密数据块。这条命令就是全部的搭建工作；一个可选的 profile 会加上用于跨网络 NAT 穿透的 TURN 中继。如果你只是想把文件从 A 传到 B，需要运行和维护的东西要少得多。",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "点对点直连传输，什么都不存储",
      body: [
        "Relayium 的实时模式通过加密的点对点通道直接在两台设备之间发送文件——Nextcloud 没有对应的功能，因为每一次 Nextcloud 分享都要先上传到你的服务器、再从服务器下载。X25519 密钥交换协商出用于 AES-256-GCM 的密钥，两台设备会显示一致的 6 位校验码（SAS）以排除中间人，每个文件都用 SHA-256 哈希做端到端校验。",
        "同一网络下完全无需账号：在两台设备上打开 relayium.com，最多选 1,000 个文件，核对校验码，然后发送。跨网络用配对码发送则需要发送方登录——接收方始终无需账号。若连接中途断开，传输会断点续传而非从头再来；当无法直连时，会退回到加密的 TURN 中继，中继只能看到密文。",
      ],
    },
    {
      heading: "对方不在线时：零知识存储链接",
      body: [
        "实时传输需要双方同时在线，这正是 Nextcloud 那台常驻服务器真正占优的地方。Relayium 同样能应对这种情况，且不牺牲隐私：你的浏览器会生成一个随机的 AES-256-GCM 密钥，在任何数据离开你的设备之前就用它加密文件，密钥只存在于 URL 片段里——也就是 # 之后、浏览器从不发送给服务器的那部分。服务器只保存它无法解密的密文。",
        "生成这样的存储链接需要发送方登录；收件方下载无需任何账号。每个链接都可设为 1 小时、1 天、3 天或最长 7 天后过期（上限取决于套餐），或者首次完整下载后即焚——它不是像 Nextcloud 分享那样的永久归宿，它本来就是为了消失而存在的。",
      ],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "用途：Nextcloud 是面向持久、同步存储的完整云平台；Relayium 是专注于直接传输或到期链接的工具。",
        "文件存放：Nextcloud 会把文件保存在服务器上，只要你愿意就能一直存着；Relayium 的实时模式根本不存储文件，存储链接则会过期或首次下载后即焚。",
        "自托管成本：Nextcloud 需要 Web 服务器、数据库、PHP 运行时以及持续的应用更新；Relayium 的自托管是单一容器（docker compose up -d --build），再加一个用于跨网络传输的可选 TURN 中继。",
        "账号：Nextcloud 的每个使用者都需要账号；Relayium 在同网络传输中无需账号，跨网络配对或存储链接只要求发送方登录，接收方始终无需账号。",
        "加密：Relayium 的实时模式端到端加密并带 6 位 SAS 校验码，且从不经过服务器；存储链接是零知识的，密钥只存在于 URL 片段里。Nextcloud 的分享要先上传到、再从你的服务器下载，传输过程受 TLS 保护，静态存储的加密取决于你自己的配置。",
        "费用与开放：Relayium 免费且采用 MIT 许可，代码在 github.com/relayium/relayium；Nextcloud 的服务端软件同样免费开源（AGPL 许可），Nextcloud GmbH 及其合作伙伴也提供付费的托管与支持服务。",
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
        a: "不会。实时模式下什么都不会被存储在任何地方——文件在设备之间直接传输。存储链接只会保留无法解读的零知识密文，直到它过期（1 小时到最长 7 天，取决于套餐）或被下载一次后即焚，而不是像 Nextcloud 分享那样无限期保存。",
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
        a: "免费——采用 MIT 许可的免费开源软件，没有付费档位。Nextcloud 的核心服务端软件同样免费开源；Nextcloud GmbH 提供的部分托管与支持服务是收费的。",
      },
    ],
  },
  cta: {
    text: "直接发送文件，或分享一个会过期的零知识链接——同一网络下无需云存储账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と Nextcloud の比較：ファイル送信にどちらを選ぶか",
  description:
    "Relayium と Nextcloud を公平に比較。Nextcloud は長期保存に向く本格的な自己ホスト型クラウド基盤、Relayium は転送そのものに特化したツールです——P2P 直送、またはゼロ知識で暗号化される期限付きリンク、加えて軽量な単一コンテナのセルフホストも用意しています。",
  updatedLabel: "最終更新",
  lead: [
    "Nextcloud は、セルフホストを Google Drive や Dropbox の本物の代替にしました。自分のファイル、あらゆる端末をまたぐ同期、自分のカレンダーと連絡先——すべてが自分の管理するドメインの下で動きます。これは正真正銘、強力なソフトウェアであり、ファイルの恒久的な置き場所が欲しいなら、Nextcloud はまさに適した道具です。",
    "本記事はこの2つを公平に比較します。Nextcloud はデータを長期的に保存し同期し続けるために作られており、その守備範囲こそが強みですが、その分、実際のセットアップと運用コストも伴います。Web サーバー、データベース、PHP ランタイム、そしてコア本体とインストール済みアプリへの継続的なアップデートです。Relayium が解決するのはもっと狭い問題です。ファイルを1人から別の1人へ渡すこと——直接転送で何も保存しないか、期限付きのリンクを使うかのどちらかです。永続的なクラウドストレージが必要なら Nextcloud の方が向いています。ファイルを移動したいだけなら、Relayium の方が軽量です。",
  ],
  sections: [
    {
      heading: "Nextcloud が優れている点",
      body: [
        "Nextcloud は完結したセルフホスト型クラウドスイートです。デスクトップとモバイルの同期クライアントを備えたファイルストレージ、カレンダー、連絡先、オフィススイート、チャット、その上に大規模なアプリエコシステムが乗っています。一度立ち上げれば、プライベートな Google Workspace のように動作します——ファイルはそこに恒久的に置かれ、端末間で自動同期され、いつでも利用できます。",
        "これは「ファイルを送る」こととは根本的に違う仕事です。データの恒久的で共有された置き場所——チーム共有ドライブ、写真ライブラリ、家庭や会社が長期的にファイルを保管する場所——が欲しいなら、Nextcloud が正しい選択です。",
      ],
    },
    {
      heading: "違いはどこか：ストレージ基盤 vs 転送ツール",
      body: [
        "Nextcloud は多くのことをこなす分、それを運用するということは本格的なアプリケーション基盤を運用することを意味します。Web サーバー、データベース（MySQL、PostgreSQL、または SQLite）、PHP ランタイム、定期実行される cron ジョブ、そしてコア本体とインストールした各アプリへの継続的なアップデートです。得られるものを考えれば妥当な対価ですが、それは継続的な作業であり、保管するすべてのもののストレージ容量計画も自分で行うことになります。",
        "Relayium はストレージ基盤になろうとはしません。ファイルを一箇所から別の場所へ移動すること——リアルタイムのピアツーピア、あるいは期限付きのリンク——に範囲を絞っています。セルフホスト時のサーバー側は単一のコンテナです。アプリを提供する1つの Go バイナリが、小さな SQLite データベースと、保存型リンクについては自身も読めない暗号化ブロブを保持します。このコマンドがセットアップのすべてで、任意のプロファイルを追加すればネットワークをまたぐ NAT 越え用の TURN リレーも加わります。ファイルを A から B へ渡すことだけが目的なら、運用し続けるものはずっと少なくて済みます。",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "P2P 直送、何も保存されない",
      body: [
        "Relayium のリアルタイムモードは暗号化されたピアツーピアのチャネルを通じてファイルを2台の端末間で直接送ります——Nextcloud にはこれに相当する機能がありません。すべての Nextcloud の共有は、まず自分のサーバーにアップロードされ、そこからダウンロードされるからです。X25519 の鍵交換が AES-256-GCM 用の鍵を導出し、両方の端末が一致する6桁の検証コード（SAS）を表示して中間者を排除し、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。",
        "同一ネットワークならアカウントは一切不要です。両方の端末で relayium.com を開き、最大1,000ファイルを選び、コードを照合して送ります。ペアリングコードでネットワークをまたいで送る場合は送信側のサインインが必要です——受信側はどちらの場合もアカウント不要です。途中で接続が切れても、転送は最初からではなく再開されます。直接接続が不可能なときは暗号化された TURN リレーにフォールバックし、リレーは暗号文しか見ません。",
      ],
    },
    {
      heading: "受信側がオフラインのとき：ゼロ知識の保存リンク",
      body: [
        "リアルタイム転送には双方が同時にオンラインである必要があり、ここは Nextcloud の常駐サーバーが本当に優れている点です。Relayium もこのケースをカバーします。プライバシーを犠牲にせずにです。ブラウザがランダムな AES-256-GCM 鍵を生成し、何も端末から出ていく前にそれでファイルを暗号化し、鍵は URL フラグメント——# の後の、ブラウザがサーバーに決して送らない部分——にだけ存在します。サーバーは復号できない暗号文だけを保存します。",
        "こうした保存リンクの作成には送信側のサインインが必要です。受信側はダウンロードにアカウントが要りません。各リンクは1時間、1日、3日、最長7日（プランによる）で期限切れになるよう設定でき、あるいは最初の完全なダウンロード後に消去するよう設定できます——Nextcloud の共有のような恒久的な置き場所ではなく、消えることを前提としています。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "目的：Nextcloud は永続的で同期されたストレージのための完全なクラウド基盤、Relayium は直接転送や期限付きリンクに特化したツール。",
        "ファイルの置き場所：Nextcloud は望む限りファイルをサーバーに保管する；Relayium のリアルタイムモードは何も保存せず、保存リンクは期限切れになるか1回のダウンロード後に消去される。",
        "セルフホストの重さ：Nextcloud は Web サーバー、データベース、PHP ランタイム、継続的なアプリ更新が必要；Relayium のセルフホストは単一コンテナ（docker compose up -d --build）に加え、ネットワークをまたぐ転送用の任意の TURN リレー。",
        "アカウント：Nextcloud はアクセスするすべてのユーザーにアカウントが必要；Relayium は同一ネットワークの転送にはアカウント不要で、ネットワークをまたぐペアリングや保存リンクは送信側のサインインだけが必要、受信側は決して不要。",
        "暗号化：Relayium のリアルタイムモードは6桁の SAS コード付きのエンドツーエンドで、サーバーに一切触れない；保存リンクはランダムな鍵が URL フラグメントだけに存在するゼロ知識。Nextcloud の共有は自分のサーバーへのアップロードとそこからのダウンロードを経由し、通信中は TLS で、保存時の暗号化は自分の設定次第で保護される。",
        "費用と開放性：Relayium は無料で MIT ライセンス、github.com/relayium/relayium にある；Nextcloud のサーバーソフトウェアも無料でオープンソース（AGPL）だが、Nextcloud GmbH やパートナーによる有料のホスティングとサポートも利用できる。",
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
        a: "いいえ。リアルタイムモードでは何もどこにも保存されません——ファイルは端末間を直接移動します。保存リンクは、期限切れ（1時間から最長7日、プランによる）になるか、バーン・アフター・リードで1回ダウンロードされるまでの間だけゼロ知識の暗号文を保持し、Nextcloud の共有のように無期限には保存されません。",
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
        a: "はい——MIT ライセンスの無料オープンソースで、有料プランはありません。Nextcloud のコアサーバーソフトウェアも無料でオープンソースですが、Nextcloud GmbH による一部のホスティングとサポートは有料です。",
      },
    ],
  },
  cta: {
    text: "ファイルを直接送るか、期限付きのゼロ知識リンクを共有しましょう——同じネットワークならクラウドストレージのアカウントは不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs Nextcloud: 파일 전송에는 무엇을 써야 할까",
  description:
    "Relayium과 Nextcloud를 공정하게 비교합니다. Nextcloud는 장기 저장에 적합한 완전한 자체 호스팅 클라우드 플랫폼이고, Relayium은 전송 자체에 집중한 도구입니다 — 직접 P2P 전송 또는 영지식으로 암호화된 만료 링크, 그리고 가벼운 단일 컨테이너 셀프 호스팅 옵션까지 제공합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Nextcloud는 셀프 호스팅을 Google Drive나 Dropbox의 진짜 대안으로 만들었습니다. 자신의 파일, 모든 기기에 걸친 동기화, 자신의 캘린더와 연락처까지 — 모두 자신이 통제하는 도메인 아래에서 돌아갑니다. 이는 정말로 강력한 소프트웨어이며, 파일의 영구적인 보금자리를 원한다면 Nextcloud가 딱 맞는 도구입니다.",
    "이 글은 두 가지를 공정하게 비교합니다. Nextcloud는 데이터를 무기한 저장하고 동기화 상태로 유지하도록 만들어졌습니다 — 그 범위 자체가 강점이지만, 그만큼 실제 설치와 유지보수 비용도 따릅니다. 웹 서버, 데이터베이스, PHP 런타임, 그리고 코어와 설치한 앱들에 대한 지속적인 업데이트가 필요합니다. Relayium이 푸는 문제는 더 좁습니다. 파일을 한 사람에게서 다른 사람에게 전달하는 것 — 아무것도 저장하지 않는 직접 전송이거나, 만료되는 링크입니다. 지속적인 클라우드 저장이 필요하다면 Nextcloud가 더 맞고, 그냥 파일을 옮기고 싶다면 Relayium이 더 가볍습니다.",
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
        "Relayium은 저장 플랫폼이 되려고 하지 않습니다. 파일을 한 곳에서 다른 곳으로 옮기는 것 — 실시간 P2P이거나 만료되는 링크 — 에 범위를 좁혔습니다. 셀프 호스팅 시 서버 쪽은 단일 컨테이너입니다. 앱을 제공하는 하나의 Go 바이너리가 작은 SQLite 데이터베이스와, 저장형 링크를 위해 자신도 읽을 수 없는 암호화된 블롭을 보관합니다. 이 명령이 설치 작업의 전부이며, 선택적인 프로필을 추가하면 네트워크 간 NAT 통과용 TURN 릴레이도 붙습니다. 파일을 A에서 B로 옮기는 것만이 목적이라면, 운영하고 계속 업데이트할 것이 훨씬 적습니다.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "P2P 직접 전송, 아무것도 저장되지 않음",
      body: [
        "Relayium의 실시간 모드는 암호화된 P2P 채널을 통해 두 기기 사이로 파일을 곧바로 보냅니다 — Nextcloud에는 이에 상응하는 기능이 없습니다. 모든 Nextcloud 공유는 먼저 서버에 업로드된 뒤 그곳에서 다운로드되기 때문입니다. X25519 키 교환이 AES-256-GCM용 키를 도출하고, 두 기기가 일치하는 6자리 검증 코드(SAS)를 표시해 중간자를 배제하며, 각 파일은 SHA-256 해시로 종단간 검증됩니다.",
        "같은 네트워크에서는 계정이 전혀 필요 없습니다. 두 기기에서 relayium.com을 열고, 최대 1,000개 파일을 고르고, 코드를 대조한 뒤 보냅니다. 페어링 코드로 네트워크를 넘어 보낼 때는 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 어느 경우든 계정이 필요 없습니다. 도중에 연결이 끊겨도 전송은 처음부터가 아니라 이어서 재개됩니다. 직접 연결이 불가능할 때는 암호화된 TURN 릴레이로 폴백하며, 릴레이는 암호문만 봅니다.",
      ],
    },
    {
      heading: "받는 쪽이 오프라인일 때: 영지식 저장 링크",
      body: [
        "실시간 전송은 양쪽이 동시에 접속해 있어야 하는데, 이 지점에서는 Nextcloud의 상시 구동 서버가 실질적으로 유리합니다. Relayium도 프라이버시를 포기하지 않고 이 경우를 처리합니다. 브라우저가 무작위 AES-256-GCM 키를 생성해, 무엇이든 기기를 떠나기 전에 그 키로 파일을 암호화하고, 키는 URL 프래그먼트 — # 뒤의, 브라우저가 서버로 결코 보내지 않는 부분 — 에만 존재합니다. 서버는 복호화할 수 없는 암호문만 저장합니다.",
        "이런 저장 링크 생성에는 보내는 쪽의 로그인이 필요합니다. 받는 쪽은 다운로드에 계정이 필요 없습니다. 각 링크는 1시간, 1일, 3일, 최대 7일(요금제에 따라 다름) 뒤 만료되도록 설정하거나, 첫 완전한 다운로드 후 소각되도록 설정할 수 있습니다 — Nextcloud 공유처럼 영구적인 보금자리가 아니라, 사라지는 것이 원래 목적입니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "목적: Nextcloud는 지속적이고 동기화된 저장을 위한 완전한 클라우드 플랫폼; Relayium은 직접 전송이나 만료 링크에 집중한 도구.",
        "파일이 놓이는 곳: Nextcloud는 원하는 만큼 파일을 서버에 보관; Relayium의 실시간 모드는 아무것도 저장하지 않고, 저장 링크는 만료되거나 한 번 다운로드된 후 소각됨.",
        "셀프 호스팅 부담: Nextcloud는 웹 서버, 데이터베이스, PHP 런타임, 지속적인 앱 업데이트가 필요; Relayium의 셀프 호스팅은 단일 컨테이너(docker compose up -d --build)에, 네트워크 간 전송용 선택적 TURN 릴레이만 추가.",
        "계정: Nextcloud는 접근하는 모든 사용자에게 계정이 필요; Relayium은 같은 네트워크 전송에는 계정이 필요 없고, 네트워크 간 페어링이나 저장 링크는 보내는 쪽의 로그인만 필요하며, 받는 쪽은 결코 필요 없음.",
        "암호화: Relayium의 실시간 모드는 6자리 SAS 코드가 있는 종단간 암호화이며 서버를 전혀 거치지 않음; 저장 링크는 키가 URL 프래그먼트에만 존재하는 영지식. Nextcloud 공유는 서버에 업로드되고 서버에서 다운로드되며, 전송 중에는 TLS로, 저장 시 암호화는 직접 설정한 대로 보호됨.",
        "비용과 개방성: Relayium은 무료이며 MIT 라이선스로 github.com/relayium/relayium에 있음; Nextcloud의 서버 소프트웨어도 무료 오픈소스(AGPL)이지만, Nextcloud GmbH와 파트너사가 제공하는 유료 호스팅과 지원도 이용할 수 있음.",
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
        a: "아니요. 실시간 모드에서는 아무것도 어디에도 저장되지 않습니다 — 파일은 기기 사이를 직접 이동합니다. 저장 링크는 만료되거나(1시간~최대 7일, 요금제에 따라 다름) 소각형 다운로드로 한 번 받아질 때까지만 영지식 암호문을 보관하며, Nextcloud 공유처럼 무기한 보관되지 않습니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "같은 네트워크에서는 필요 없습니다. 페어링 코드로 네트워크를 넘어 보내거나 저장 링크를 만들 때는 보내는 쪽의 로그인이 필요합니다. 받는 쪽은 어느 경우든 계정이 필요 없습니다. 반면 Nextcloud는 접근하는 모든 사용자에게 계정(또는 계정 보유자가 만든 공유 링크)이 필요합니다.",
      },
      {
        q: "Relayium도 셀프 호스팅할 수 있나요?",
        a: "네. Nextcloud의 여러 서비스로 이루어진 구성과 달리, Relayium의 서버는 단일 컨테이너입니다. docker compose 명령 하나로 전체 시스템이 구동되며, 네트워크 간 NAT 통과용 선택적 TURN 릴레이 프로필도 있습니다.",
      },
      {
        q: "Relayium은 무료인가요?",
        a: "네 — MIT 라이선스의 무료 오픈소스이며 유료 등급이 없습니다. Nextcloud의 코어 서버 소프트웨어도 무료 오픈소스이지만, Nextcloud GmbH가 제공하는 일부 호스팅과 지원은 유료입니다.",
      },
    ],
  },
  cta: {
    text: "파일을 직접 보내거나, 만료되는 영지식 링크를 공유하세요 — 같은 네트워크에서는 클라우드 저장소 계정이 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. Nextcloud zum Versenden von Dateien",
  description:
    "Ein ehrlicher Vergleich von Relayium und Nextcloud. Nextcloud ist eine vollwertige selbstgehostete Cloud-Plattform für dauerhafte Speicherung; Relayium ist ein fokussiertes Übertragungstool — direktes P2P oder ein Zero-Knowledge-Link mit Ablauf, plus eine schlanke Ein-Container-Selfhosting-Option.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Nextcloud hat Selbsthosting zu einer echten Alternative zu Google Drive oder Dropbox gemacht: eigene Dateien, Synchronisation über alle Geräte hinweg, eigener Kalender und Kontakte, alles unter einer Domain, die du kontrollierst. Das ist wirklich leistungsfähige Software, und wenn du ein dauerhaftes Zuhause für deine Dateien willst, ist Nextcloud das richtige Werkzeug.",
    "Dieser Artikel vergleicht die beiden fair. Nextcloud ist darauf ausgelegt, deine Daten dauerhaft zu speichern und synchron zu halten — dieser Umfang ist seine Stärke, und er bringt echten Aufwand für Aufbau und Wartung mit sich: einen Webserver, eine Datenbank, eine PHP-Laufzeitumgebung und laufende Updates für den Kern und die installierten Apps. Relayium löst ein engeres Problem: eine Datei von einer Person zu einer anderen zu bringen, entweder direkt, ohne dass irgendetwas gespeichert wird, oder über einen Link, der abläuft. Wenn du dauerhaften Cloud-Speicher brauchst, ist Nextcloud die bessere Wahl. Willst du nur eine Datei bewegen, ist Relayium leichtgewichtiger.",
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
        "Relayium versucht nicht, eine Speicherplattform zu sein. Es ist darauf beschränkt, Dateien von einem Ort zum anderen zu bewegen — Echtzeit-Peer-to-Peer oder ein ablaufender Link. Der selbst gehostete Server ist ein einziger Container: ein Go-Binary, das die App ausliefert und eine kleine SQLite-Datenbank sowie, für gespeicherte Links, verschlüsselte Blobs hält, die es selbst nicht lesen kann. Dieser Befehl ist die gesamte Einrichtung; ein optionales Profil fügt ein TURN-Relay für netzwerkübergreifendes NAT-Traversal hinzu. Willst du nur eine Datei von A nach B bringen, gibt es damit deutlich weniger zu betreiben und aktuell zu halten.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Direkte P2P-Übertragungen, nichts wird gespeichert",
      body: [
        "Relayiums Echtzeitmodus sendet Dateien direkt zwischen zwei Geräten über einen verschlüsselten Peer-to-Peer-Kanal — dafür gibt es bei Nextcloud kein Äquivalent, weil jede Nextcloud-Freigabe zuerst auf deinen Server hoch- und von dort heruntergeladen wird. Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM ab, beide Geräte zeigen einen übereinstimmenden sechsstelligen Prüfcode (SAS), um einen Man-in-the-Middle auszuschließen, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft.",
        "Im selben Netzwerk braucht das überhaupt kein Konto: Öffne relayium.com auf beiden Geräten, wähle bis zu 1.000 Dateien, prüfe den Code und sende. Beim Senden über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden — der Empfänger braucht in beiden Fällen kein Konto. Bricht eine Verbindung mittendrin ab, wird die Übertragung fortgesetzt statt neu gestartet, und ist eine Direktverbindung unmöglich, weicht sie auf ein verschlüsseltes TURN-Relay aus, das nur Chiffretext sieht.",
      ],
    },
    {
      heading: "Wenn der Empfänger offline ist: Zero-Knowledge-Speicherlinks",
      body: [
        "Echtzeitübertragung setzt voraus, dass beide gleichzeitig online sind — hier hat Nextclouds ständig laufender Server einen echten Vorteil. Relayium deckt auch diesen Fall ab, ohne die Privatsphäre aufzugeben: Dein Browser erzeugt einen zufälligen AES-256-GCM-Schlüssel, verschlüsselt die Dateien damit, bevor irgendetwas dein Gerät verlässt, und der Schlüssel lebt nur im URL-Fragment — dem Teil nach dem #, den Browser nie an einen Server senden. Der Server speichert nur Chiffretext, den er nicht entschlüsseln kann.",
        "Das Erstellen eines gespeicherten Links erfordert die Anmeldung des Absenders; der Empfänger braucht zum Herunterladen kein Konto. Jeder Link lässt sich so einstellen, dass er nach 1 Stunde, 1 Tag, 3 Tagen oder bis zu 7 Tagen je nach Tarif abläuft, oder dass er nach dem ersten vollständigen Download vernichtet wird — er ist nicht als dauerhaftes Zuhause für die Datei gedacht wie eine Nextcloud-Freigabe, sondern soll verschwinden.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Zweck: Nextcloud ist eine vollständige Cloud-Plattform für dauerhaften, synchronisierten Speicher; Relayium ist ein fokussiertes Tool für direkte Übertragung oder einen ablaufenden Link.",
        "Wo Dateien liegen: Nextcloud hält deine Dateien so lange auf dem Server, wie du willst; Relayiums Echtzeitmodus speichert sie überhaupt nicht, und gespeicherte Links laufen ab oder werden nach einem Download vernichtet.",
        "Selfhosting-Aufwand: Nextcloud braucht einen Webserver, eine Datenbank, eine PHP-Laufzeitumgebung und laufende App-Updates; Relayiums Selfhosting ist ein einziger Container (docker compose up -d --build) plus ein optionales TURN-Relay für netzwerkübergreifende Übertragungen.",
        "Konten: Nextcloud braucht für jeden zugreifenden Nutzer ein Konto; Relayium braucht keines für Übertragungen im selben Netzwerk, nur der Absender muss sich für netzwerkübergreifendes Pairing oder gespeicherte Links anmelden, und Empfänger brauchen nie eines.",
        "Verschlüsselung: Relayiums Echtzeitmodus ist Ende-zu-Ende mit sechsstelligem SAS-Code und berührt nie einen Server; gespeicherte Links sind Zero-Knowledge mit einem Schlüssel, der nur im URL-Fragment existiert. Nextcloud-Freigaben werden auf deinen Server hoch- und von dort heruntergeladen, geschützt durch TLS beim Transport und die Verschlüsselung im Ruhezustand, die du selbst konfigurierst.",
        "Kosten und Offenheit: Relayium ist kostenlos und MIT-lizenziert unter github.com/relayium/relayium; Nextclouds Server-Software ist ebenfalls kostenlos und quelloffen (AGPL), mit bezahltem Hosting und Support von Nextcloud GmbH und Partnern.",
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
        a: "Nein. Im Echtzeitmodus wird nirgendwo etwas gespeichert — die Datei wandert direkt zwischen den Geräten. Gespeicherte Links halten Zero-Knowledge-Chiffretext nur so lange, bis er abläuft (1 Stunde bis zu 7 Tage, je nach Tarif) oder mit Burn-after-Read einmal heruntergeladen wird, nicht dauerhaft wie eine Nextcloud-Freigabe.",
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
        a: "Ja — kostenlos und Open Source unter der MIT-Lizenz, ohne bezahlten Tarif. Nextclouds Kern-Server-Software ist ebenfalls kostenlos und quelloffen; manche Hosting- und Support-Optionen von Nextcloud GmbH sind kostenpflichtig.",
      },
    ],
  },
  cta: {
    text: "Sende eine Datei direkt oder teile einen ablaufenden Zero-Knowledge-Link — im selben Netzwerk ohne Cloud-Speicher-Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs Nextcloud pour l'envoi de fichiers",
  description:
    "Un comparatif honnête de Relayium et Nextcloud. Nextcloud est une plateforme cloud auto-hébergée complète pour un stockage durable ; Relayium est un outil focalisé sur le transfert — P2P direct ou lien à divulgation nulle qui expire, avec une option d'auto-hébergement légère en un seul conteneur.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Nextcloud a fait de l'auto-hébergement une vraie alternative à Google Drive ou Dropbox : vos propres fichiers, une synchronisation sur tous vos appareils, votre propre calendrier et vos contacts, le tout sous un domaine que vous contrôlez. C'est un logiciel véritablement puissant, et si ce que vous voulez, c'est un foyer permanent pour vos fichiers, Nextcloud est le bon outil.",
    "Cet article compare les deux équitablement. Nextcloud est conçu pour stocker vos données indéfiniment et les garder synchronisées — cette portée est sa force, et elle s'accompagne d'une vraie mise en place et d'une vraie maintenance : un serveur web, une base de données, un environnement PHP, et des mises à jour continues pour le cœur et les applications installées. Relayium résout un problème plus étroit : faire passer un fichier d'une personne à une autre, soit directement sans rien stocker du tout, soit via un lien qui expire. Si vous avez besoin d'un stockage cloud durable, Nextcloud convient mieux. Si vous voulez juste déplacer un fichier, Relayium est plus léger.",
  ],
  sections: [
    {
      heading: "Ce que Nextcloud fait bien",
      body: [
        "Nextcloud est une suite cloud auto-hébergée complète : stockage de fichiers avec des clients de synchronisation sur ordinateur et mobile, calendrier, contacts, une suite bureautique, un chat, et par-dessus tout cela un vaste écosystème d'applications. Une fois en place, il se comporte comme un Google Workspace privé — les fichiers y restent en permanence, se synchronisent automatiquement entre appareils, et restent disponibles à tout moment.",
        "C'est un travail fondamentalement différent d'envoyer un fichier. Nextcloud est le bon choix quand vous voulez un foyer permanent et partagé pour vos données : un lecteur d'équipe, une photothèque, un endroit où votre foyer ou votre entreprise conserve des fichiers sur le long terme.",
      ],
    },
    {
      heading: "Là où ils diffèrent : plateforme de stockage vs outil de transfert",
      body: [
        "Comme Nextcloud fait tant de choses, le faire tourner signifie exploiter une véritable plateforme applicative : un serveur web, une base de données (MySQL, PostgreSQL ou SQLite), un environnement PHP, des tâches cron planifiées, et des mises à jour périodiques du cœur et de chaque application installée. C'est un prix raisonnable pour tout ce que vous obtenez, mais c'est un travail continu, et c'est à vous de planifier la capacité de stockage pour tout ce que vous y conservez.",
        "Relayium n'essaie pas d'être une plateforme de stockage. Il se limite à déplacer des fichiers d'un endroit à un autre — pair-à-pair en temps réel, ou un lien qui expire. Son serveur auto-hébergé est un seul conteneur : un binaire Go qui sert l'application et conserve une petite base SQLite plus, pour les liens stockés, des blobs chiffrés qu'il ne peut pas lire lui-même. Cette commande constitue toute l'installation ; un profil optionnel ajoute un relais TURN pour le NAT traversal entre réseaux différents. Si tout ce dont vous avez besoin, c'est de faire passer un fichier de A à B, il y a beaucoup moins à faire tourner et à maintenir à jour.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Transferts P2P directs, rien n'est stocké",
      body: [
        "Le mode temps réel de Relayium envoie les fichiers directement entre deux appareils via un canal pair-à-pair chiffré — Nextcloud n'a pas d'équivalent, puisque chaque partage Nextcloud est d'abord téléversé sur votre serveur puis téléchargé depuis celui-ci. Un échange de clés X25519 dérive une clé pour AES-256-GCM, les deux appareils affichent un code de vérification à 6 chiffres identique (SAS) pour écarter un homme du milieu, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256.",
        "Sur le même réseau, cela ne demande aucun compte du tout : ouvrez relayium.com sur les deux appareils, choisissez jusqu'à 1 000 fichiers, vérifiez le code, et envoyez. Envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte. Si une connexion tombe en cours de route, le transfert reprend au lieu de recommencer, et quand une liaison directe est impossible, il bascule vers un relais TURN chiffré qui ne voit que du texte chiffré.",
      ],
    },
    {
      heading: "Quand le destinataire est hors ligne : les liens stockés à divulgation nulle",
      body: [
        "Le transfert en temps réel exige que les deux soient en ligne en même temps, et c'est là que le serveur toujours actif de Nextcloud a un vrai avantage. Relayium couvre aussi ce cas, sans renoncer à la confidentialité : votre navigateur génère une clé AES-256-GCM aléatoire, chiffre les fichiers avec avant que quoi que ce soit ne quitte votre appareil, et la clé ne vit que dans le fragment de l'URL — la partie après le #, que les navigateurs n'envoient jamais à un serveur. Le serveur ne stocke qu'un texte chiffré qu'il ne peut pas déchiffrer.",
        "Créer un lien stocké exige que l'expéditeur se connecte ; le destinataire n'a besoin d'aucun compte pour télécharger. Chaque lien peut être réglé pour expirer après 1 heure, 1 jour, 3 jours ou jusqu'à 7 jours selon votre offre, ou pour se détruire après le premier téléchargement complet — ce n'est pas un foyer permanent pour le fichier comme un partage Nextcloud, il est fait pour disparaître.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "But : Nextcloud est une plateforme cloud complète pour un stockage durable et synchronisé ; Relayium est un outil focalisé sur le transfert direct ou un lien qui expire.",
        "Où résident les fichiers : Nextcloud garde vos fichiers sur le serveur aussi longtemps que vous le voulez ; le mode temps réel de Relayium ne les stocke jamais du tout, et les liens stockés expirent ou se détruisent après un téléchargement.",
        "Empreinte d'auto-hébergement : Nextcloud a besoin d'un serveur web, d'une base de données, d'un environnement PHP et de mises à jour d'applications continues ; l'auto-hébergement de Relayium est un seul conteneur (docker compose up -d --build) plus un relais TURN optionnel pour les transferts entre réseaux différents.",
        "Comptes : Nextcloud exige un compte pour chaque utilisateur qui y accède ; Relayium n'en exige aucun pour les transferts sur le même réseau, seul l'expéditeur se connecte pour l'appairage entre réseaux différents ou les liens stockés, et les destinataires n'en ont jamais besoin.",
        "Chiffrement : le mode temps réel de Relayium est de bout en bout avec un code SAS à 6 chiffres et ne touche jamais un serveur ; les liens stockés sont à divulgation nulle avec une clé qui ne quitte jamais le fragment de l'URL. Les partages Nextcloud sont téléversés sur votre serveur puis téléchargés depuis celui-ci, protégés par TLS en transit et par le chiffrement au repos que vous configurez vous-même.",
        "Coût et ouverture : Relayium est gratuit et sous licence MIT sur github.com/relayium/relayium ; le logiciel serveur de Nextcloud est lui aussi gratuit et open source (AGPL), avec de l'hébergement et du support payants disponibles auprès de Nextcloud GmbH et de partenaires.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Devrais-je utiliser Nextcloud plutôt que Relayium ?",
        a: "Si vous voulez un foyer permanent et synchronisé pour vos fichiers — photos, documents, un lecteur d'équipe partagé —, oui, c'est exactement pour cela que Nextcloud a été conçu. Relayium ne le remplace pas ; il sert la tâche plus étroite de faire passer un fichier d'une personne à une autre, rapidement et en privé.",
      },
      {
        q: "Relayium stocke-t-il mes fichiers comme Nextcloud ?",
        a: "Non. En mode temps réel, rien n'est stocké nulle part — le fichier va directement d'un appareil à l'autre. Les liens stockés ne conservent un texte chiffré à divulgation nulle que jusqu'à leur expiration (1 heure à 7 jours maximum, selon votre offre) ou jusqu'à un unique téléchargement avec destruction après lecture, pas indéfiniment comme un partage Nextcloud.",
      },
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Sur le même réseau, non. Envoyer entre réseaux différents avec un code d'appairage, ou créer un lien stocké, exige que l'expéditeur se connecte ; le destinataire n'a jamais besoin de compte. Nextcloud exige quant à lui un compte (ou un lien de partage créé par un compte) pour chaque utilisateur qui y accède.",
      },
      {
        q: "Puis-je aussi auto-héberger Relayium ?",
        a: "Oui. Contrairement à la pile multi-services de Nextcloud, le serveur de Relayium est un seul conteneur : une seule commande docker compose fait tourner tout le système, avec un profil de relais TURN optionnel pour le NAT traversal entre réseaux différents.",
      },
      {
        q: "Relayium est-il gratuit ?",
        a: "Oui — gratuit et open source sous licence MIT, sans offre payante. Le logiciel serveur cœur de Nextcloud est lui aussi gratuit et open source ; certaines options d'hébergement et de support de Nextcloud GmbH sont payantes.",
      },
    ],
  },
  cta: {
    text: "Envoyez un fichier directement, ou partagez un lien à divulgation nulle qui expire — sans compte de stockage cloud sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل Nextcloud لإرسال الملفات",
  description:
    "مقارنة صادقة بين Relayium و Nextcloud. إن Nextcloud منصة سحابية كاملة ذاتية الاستضافة للتخزين الدائم؛ أما Relayium فأداة نقل مركّزة — نقل مباشر من الند للند أو رابط معرفة صفرية ينتهي، مع استضافة ذاتية خفيفة بحاوية واحدة.",
  updatedLabel: "آخر تحديث",
  lead: [
    "حوّل Nextcloud الاستضافة الذاتية إلى بديل حقيقي عن Google Drive أو Dropbox: ملفاتك أنت، ومزامنتك أنت عبر كل جهاز، وتقويمك وجهات اتصالك أنت، كلها تحت نطاق تتحكم فيه. إنه برنامج قوي فعلاً، وإن كان ما تريده بيتاً دائماً لملفاتك، فإن Nextcloud هو الأداة المناسبة للمهمة.",
    "يقارن هذا المقال الاثنين بإنصاف. بُني Nextcloud لتخزين بياناتك إلى أجل غير مسمى وإبقائها متزامنة — هذا النطاق هو قوّته، ويأتي بإعداد وصيانة حقيقيين: خادم ويب، وقاعدة بيانات، وبيئة تشغيل PHP، وتحديثات مستمرة للمنصة وتطبيقاتها. يحلّ Relayium مشكلة أضيق: إيصال ملف من شخص إلى آخر، إما مباشرة بلا تخزين أي شيء إطلاقاً، أو عبر رابط ينتهي. إن كنت بحاجة إلى تخزين سحابي دائم، فإن Nextcloud أنسب. وإن كنت تريد فقط نقل ملف، فإن Relayium أخفّ.",
  ],
  sections: [
    {
      heading: "ما يبرع فيه Nextcloud",
      body: [
        "إن Nextcloud حزمة سحابية ذاتية الاستضافة كاملة: تخزين ملفات مع عملاء مزامنة لسطح المكتب والجوال، وتقاويم، وجهات اتصال، وحزمة مكتبية، ودردشة، ومنظومة تطبيقات واسعة فوق ذلك. متى شُغِّل، تصرّف كأنه Google Workspace خاص — تعيش الملفات هناك بشكل دائم، وتتزامن تلقائياً عبر الأجهزة، وتبقى متاحة متى احتجتها.",
        "هذه مهمة مختلفة فعلاً عن إرسال ملف. إن Nextcloud هو الخيار الصحيح حين تريد بيتاً دائماً ومشتركاً لبياناتك: قرص فريق، أو مكتبة صور، أو مكان يحتفظ فيه بيتك أو شركتك بالملفات على المدى الطويل.",
      ],
    },
    {
      heading: "أين يختلفان: منصة تخزين مقابل أداة نقل",
      body: [
        "لأن Nextcloud يفعل الكثير، فإن تشغيله يعني تشغيل منصة تطبيقات حقيقية: خادم ويب، وقاعدة بيانات (MySQL أو PostgreSQL أو SQLite)، وبيئة تشغيل PHP، ومهام cron مجدولة، وتحديثات دورية للنواة ولأي تطبيقات ثبّتها. هذا ثمن عادل مقابل كل ما تحصل عليه، لكنه عمل مستمر، وأنت من يخطّط لسعة التخزين لكل ما تحتفظ به هناك.",
        "لا يحاول Relayium أن يكون منصة تخزين. نطاقه محصور في نقل الملفات من مكان إلى آخر — من الند للند فوري، أو رابط ينتهي. خادمه ذاتي الاستضافة حاوية واحدة: ثنائي Go واحد يخدم التطبيق ويحتفظ بقاعدة بيانات SQLite صغيرة، إضافةً إلى كتل مُشفَّرة لا يستطيع قراءتها من أجل الروابط المُخزَّنة. هذا الأمر هو الإعداد كله؛ ويضيف ملف تعريف اختياري مُرحِّل TURN لاجتياز NAT عبر الشبكات. إن كان كل ما تحتاجه هو إيصال ملف من A إلى B، فهذا أقل بكثير لتشغيله وإبقائه محدَّثاً.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "نقل مباشر من الند للند، بلا تخزين أي شيء",
      body: [
        "يرسل الوضع الفوري في Relayium الملفات مباشرة بين جهازين عبر قناة مشفَّرة من الند للند — لا يوجد لدى Nextcloud ما يعادله، إذ يُرفَع كل مشاركة في Nextcloud إلى خادمك ثم يُنزَّل منه. يشتقّ تبادل مفاتيح X25519 مفتاحاً لـ AES-256-GCM، ويعرض الجهازان رمز تحقق مطابقاً من 6 أرقام (SAS) لاستبعاد هجوم الوسيط، ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256.",
        "على نفس الشبكة لا يحتاج هذا حساباً إطلاقاً: افتح relayium.com على الجهازين، واختر حتى 1000 ملف، وتحقّق من الرمز، وأرسِل. أما الإرسال عبر الشبكات برمز اقتران فيتطلب من المُرسِل تسجيل الدخول — ولا يحتاج المُستقبِل حساباً أبداً. إن انقطع اتصال في منتصف النقل استُؤنف بدل البدء من جديد، وحين يتعذّر مسار مباشر يرجع إلى مُرحِّل TURN مُشفَّر لا يرى سوى نص مُشفَّر.",
      ],
    },
    {
      heading: "حين يكون المُستقبِل غير متصل: روابط مُخزَّنة بمعرفة صفرية",
      body: [
        "يحتاج النقل الفوري إلى وجود الطرفين متصلين في آنٍ واحد، وهنا يتفوّق خادم Nextcloud الدائم التشغيل تفوّقاً حقيقياً. يغطّي Relayium هذه الحالة أيضاً، دون التخلّي عن الخصوصية: يولّد متصفحك مفتاح AES-256-GCM عشوائياً، ويشفّر به الملفات قبل أن يغادر أي شيء جهازك، ويعيش المفتاح في جزء الـ URL فقط — الجزء بعد # الذي لا ترسله المتصفحات أبداً إلى خادم. يخزّن الخادم نصاً مُشفَّراً لا يستطيع فكّه.",
        "يتطلب إنشاء رابط مُخزَّن من المُرسِل تسجيل الدخول؛ ولا يحتاج المُستقبِل حساباً للتنزيل. يمكن ضبط كل رابط لينتهي بعد ساعة واحدة أو يوم واحد أو 3 أيام أو حتى 7 أيام حسب خطتك، أو ليُحرَق بعد أول تنزيل كامل — فهو ليس بيتاً دائماً للملف مثل مشاركة Nextcloud، بل قُصِد له أن يختفي.",
      ],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: ["أهمّ الفروق، جنباً إلى جنب:"],
      bullets: [
        "الغرض: إن Nextcloud منصة سحابية كاملة لتخزين دائم ومتزامن؛ أما Relayium فأداة مركّزة للنقل المباشر أو رابط ينتهي.",
        "أين تعيش الملفات: يبقي Nextcloud ملفاتك على الخادم ما دمت تريد؛ أما الوضع الفوري في Relayium فلا يخزّنها إطلاقاً، والروابط المُخزَّنة تنتهي أو تُحرَق بعد تنزيل واحد.",
        "أثر الاستضافة الذاتية: يحتاج Nextcloud إلى خادم ويب وقاعدة بيانات وبيئة تشغيل PHP وتحديثات تطبيقات مستمرة؛ أما الاستضافة الذاتية في Relayium فحاوية واحدة (docker compose up -d --build) إضافةً إلى مُرحِّل TURN اختياري للنقل عبر الشبكات.",
        "الحسابات: يحتاج Nextcloud إلى حساب لكل مستخدم يصل إليه؛ أما Relayium فلا يحتاج أياً منها للنقل على نفس الشبكة، ولا يسجّل الدخول إلا المُرسِل للاقتران عبر الشبكات أو للروابط المُخزَّنة، ولا يحتاج المُستقبِلون حساباً أبداً.",
        "التشفير: الوضع الفوري في Relayium من الطرف إلى الطرف برمز SAS من 6 أرقام ولا يلمس خادماً أبداً؛ والروابط المُخزَّنة بمعرفة صفرية بمفتاح عشوائي لا يغادر جزء الـ URL أبداً. أما مشاركات Nextcloud فتُرفَع إلى خادمك وتُنزَّل منه، محميّة بـ TLS أثناء النقل وبأي تشفير في السكون تضبطه أنت.",
        "التكلفة والانفتاح: إن Relayium مجاني ومرخَّص بـ MIT على github.com/relayium/relayium؛ وبرنامج خادم Nextcloud مجاني ومفتوح المصدر أيضاً (AGPL)، مع استضافة ودعم مدفوعين متاحين من Nextcloud GmbH وشركائها.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل ينبغي أن أستخدم Nextcloud بدل Relayium؟",
        a: "إن أردت بيتاً دائماً ومتزامناً لملفاتك — صور، مستندات، قرص فريق مشترك — فنعم، هذا بالضبط ما بُني له Nextcloud. ليس Relayium بديلاً عن ذلك؛ فهو للمهمة الأضيق المتمثّلة في إيصال ملف من شخص إلى آخر، بسرعة وبخصوصية.",
      },
      {
        q: "هل يخزّن Relayium ملفاتي كما يفعل Nextcloud؟",
        a: "لا. في الوضع الفوري لا يُخزَّن شيء في أي مكان — يذهب الملف مباشرة بين الأجهزة. تحتفظ الروابط المُخزَّنة بنص مُشفَّر بمعرفة صفرية فقط حتى تنتهي (من ساعة إلى 7 أيام كحدٍّ أقصى، حسب خطتك) أو تُنزَّل مرة واحدة مع الحرق بعد القراءة، لا إلى أجل غير مسمى كمشاركة Nextcloud.",
      },
      {
        q: "هل أحتاج إلى حساب؟",
        a: "على نفس الشبكة، لا. أما الإرسال عبر الشبكات برمز اقتران، أو إنشاء رابط مُخزَّن، فيتطلب من المُرسِل تسجيل الدخول؛ ولا يحتاج المُستقبِل حساباً أبداً. أما Nextcloud فيتطلب حساباً (أو رابط مشاركة من حساب) لكل مستخدم يصل إليه.",
      },
      {
        q: "هل أستطيع استضافة Relayium ذاتياً أيضاً؟",
        a: "نعم. خلافاً لحزمة الخدمات المتعددة في Nextcloud، خادم Relayium حاوية واحدة: أمر docker compose واحد يشغّل كل شيء، مع ملف تعريف مُرحِّل TURN اختياري لاجتياز NAT عبر الشبكات.",
      },
      {
        q: "هل Relayium مجاني؟",
        a: "نعم — مجاني ومفتوح المصدر بموجب ترخيص MIT، بلا فئة مدفوعة. وبرنامج خادم Nextcloud الأساسي مجاني ومفتوح المصدر أيضاً؛ لكن بعض خيارات الاستضافة والدعم من Nextcloud GmbH مدفوعة.",
      },
    ],
  },
  cta: {
    text: "أرسِل ملفاً مباشرة، أو شارك رابط معرفة صفرية ينتهي — بلا حساب تخزين سحابي على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium vs Nextcloud para enviar archivos",
  description:
    "Una comparación honesta de Relayium y Nextcloud. Nextcloud es una plataforma de nube autoalojada completa para almacenamiento duradero; Relayium es una herramienta de transferencia enfocada — P2P directo o un enlace de conocimiento cero que expira, con un autoalojamiento ligero de un solo contenedor.",
  updatedLabel: "Última actualización",
  lead: [
    "Nextcloud convirtió el autoalojamiento en una alternativa real a Google Drive o Dropbox: tus propios archivos, tu propia sincronización en cada dispositivo, tu propio calendario y contactos, todo bajo un dominio que controlas. Es software genuinamente potente, y si lo que quieres es un hogar permanente para tus archivos, Nextcloud es la herramienta adecuada para ese trabajo.",
    "Este artículo compara ambos de forma justa. Nextcloud está hecho para almacenar tus datos indefinidamente y mantenerlos sincronizados — ese alcance es su fortaleza, y viene con una instalación y un mantenimiento reales: un servidor web, una base de datos, un entorno de ejecución PHP y actualizaciones continuas de la plataforma y sus aplicaciones. Relayium resuelve un problema más estrecho: llevar un archivo de una persona a otra, ya sea directamente sin almacenar nada en absoluto, o mediante un enlace que expira. Si necesitas almacenamiento en la nube duradero, Nextcloud encaja mejor. Si solo necesitas mover un archivo, Relayium es más ligero.",
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
        "Relayium no intenta ser una plataforma de almacenamiento. Se limita a mover archivos de un lugar a otro — de igual a igual en tiempo real, o un enlace que expira. Su servidor autoalojado es un solo contenedor: un binario Go que sirve la aplicación y mantiene una pequeña base de datos SQLite más, para los enlaces almacenados, blobs cifrados que no puede leer. Ese comando es toda la instalación; un perfil opcional añade un retransmisor TURN para atravesar NAT entre redes. Si todo lo que necesitas es llevar un archivo de A a B, hay mucho menos que ejecutar y mantener actualizado.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Transferencias P2P directas, nada almacenado",
      body: [
        "El modo en tiempo real de Relayium envía archivos directamente entre dos dispositivos por un canal de igual a igual cifrado — Nextcloud no tiene equivalente, ya que cada recurso compartido de Nextcloud se sube a tu servidor y se descarga desde él. Un intercambio de claves X25519 deriva una clave para AES-256-GCM, ambos dispositivos muestran un código de verificación de 6 dígitos coincidente (SAS) para descartar un ataque de intermediario, y cada archivo se comprueba de extremo a extremo con un hash SHA-256.",
        "En la misma red esto no necesita cuenta alguna: abre relayium.com en ambos dispositivos, elige hasta 1.000 archivos, verifica el código y envía. Enviar entre redes con un código de emparejamiento requiere que el remitente inicie sesión — el destinatario nunca necesita cuenta. Si una conexión se cae a mitad de la transferencia, se reanuda en lugar de reiniciarse, y cuando no es posible un camino directo recurre a un retransmisor TURN cifrado que solo ve texto cifrado.",
      ],
    },
    {
      heading: "Cuando el destinatario está desconectado: enlaces almacenados de conocimiento cero",
      body: [
        "La transferencia en tiempo real necesita que ambas personas estén conectadas a la vez, y ahí es donde el servidor siempre activo de Nextcloud tiene una ventaja real. Relayium cubre ese caso también, sin renunciar a la privacidad: tu navegador genera una clave AES-256-GCM aleatoria, cifra los archivos con ella antes de que nada salga de tu dispositivo, y la clave vive solo en el fragmento de la URL — la parte después del # que los navegadores nunca envían a un servidor. El servidor almacena texto cifrado que no puede descifrar.",
        "Crear un enlace almacenado requiere que el remitente inicie sesión; el destinatario no necesita cuenta para descargar. Cada enlace puede configurarse para expirar tras 1 hora, 1 día, 3 días o hasta 7 días según tu plan, o para destruirse tras la primera descarga completa — no pretende ser un hogar permanente para el archivo como un recurso compartido de Nextcloud, está pensado para desaparecer.",
      ],
    },
    {
      heading: "Comparativa de funciones de un vistazo",
      body: ["Las diferencias que más importan, una al lado de la otra:"],
      bullets: [
        "Propósito: Nextcloud es una plataforma de nube completa para almacenamiento duradero y sincronizado; Relayium es una herramienta enfocada en la transferencia directa o un enlace que expira.",
        "Dónde viven los archivos: Nextcloud mantiene tus archivos en el servidor todo el tiempo que quieras; el modo en tiempo real de Relayium no los almacena en absoluto, y los enlaces almacenados expiran o se destruyen tras una descarga.",
        "Huella de autoalojamiento: Nextcloud necesita un servidor web, una base de datos, un entorno de ejecución PHP y actualizaciones continuas de aplicaciones; el autoalojamiento de Relayium es un solo contenedor (docker compose up -d --build) más un retransmisor TURN opcional para transferencias entre redes.",
        "Cuentas: Nextcloud necesita una cuenta para cada usuario que accede a él; Relayium no necesita ninguna para transferencias en la misma red, solo el remitente inicia sesión para el emparejamiento entre redes o los enlaces almacenados, y los destinatarios nunca necesitan una.",
        "Cifrado: el modo en tiempo real de Relayium es de extremo a extremo con un código SAS de 6 dígitos y nunca toca un servidor; los enlaces almacenados son de conocimiento cero con una clave aleatoria que nunca sale del fragmento de la URL. Los recursos compartidos de Nextcloud se suben a tu servidor y se descargan de él, protegidos por TLS en tránsito y por el cifrado en reposo que configures.",
        "Coste y apertura: Relayium es gratis y con licencia MIT en github.com/relayium/relayium; el software de servidor de Nextcloud también es gratis y de código abierto (AGPL), con alojamiento y soporte de pago disponibles de Nextcloud GmbH y socios.",
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
        a: "No. En modo en tiempo real no se almacena nada en ningún lado — el archivo va directamente entre dispositivos. Los enlaces almacenados conservan texto cifrado de conocimiento cero solo hasta que expiran (de 1 hora a 7 días como máximo, según tu plan) o se descargan una vez con destrucción tras la lectura, no indefinidamente como un recurso compartido de Nextcloud.",
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
        a: "Sí — gratis y de código abierto bajo la licencia MIT, sin nivel de pago. El software de servidor central de Nextcloud también es gratis y de código abierto; algunas opciones de alojamiento y soporte de Nextcloud GmbH son de pago.",
      },
    ],
  },
  cta: {
    text: "Envía un archivo directamente, o comparte un enlace de conocimiento cero que expira — sin cuenta de almacenamiento en la nube en la misma red.",
    button: "Probar Relayium ahora",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Relayium vs Nextcloud para enviar arquivos",
  description:
    "Uma comparação honesta entre Relayium e Nextcloud. O Nextcloud é uma plataforma de nuvem auto-hospedada completa para armazenamento duradouro; o Relayium é uma ferramenta de transferência focada — P2P direto ou um link de conhecimento zero que expira, com uma auto-hospedagem leve de um único contêiner.",
  updatedLabel: "Última atualização",
  lead: [
    "O Nextcloud transformou a auto-hospedagem em uma alternativa de verdade ao Google Drive ou ao Dropbox: seus próprios arquivos, sua própria sincronização em todos os dispositivos, seu próprio calendário e contatos, tudo sob um domínio que você controla. É um software genuinamente poderoso, e se o que você quer é um lar permanente para seus arquivos, o Nextcloud é a ferramenta certa para o trabalho.",
    "Este artigo compara os dois de forma justa. O Nextcloud foi feito para armazenar seus dados indefinidamente e mantê-los sincronizados — esse escopo é a sua força, e vem com instalação e manutenção reais: um servidor web, um banco de dados, um ambiente de execução PHP e atualizações contínuas da plataforma e de seus aplicativos. O Relayium resolve um problema mais estreito: levar um arquivo de uma pessoa a outra, seja diretamente sem armazenar nada, seja por um link que expira. Se você precisa de armazenamento em nuvem duradouro, o Nextcloud encaixa melhor. Se você só precisa mover um arquivo, o Relayium é mais leve.",
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
        "O Relayium não tenta ser uma plataforma de armazenamento. Ele se limita a mover arquivos de um lugar para outro — ponto a ponto em tempo real, ou um link que expira. Seu servidor auto-hospedado é um único contêiner: um binário Go que serve o aplicativo e mantém um pequeno banco de dados SQLite mais, para os links armazenados, blobs criptografados que ele não consegue ler. Esse comando é toda a instalação; um perfil opcional adiciona um retransmissor TURN para travessia de NAT entre redes. Se tudo o que você precisa é levar um arquivo de A a B, há muito menos para executar e manter atualizado.",
      ],
      code: ["docker compose up -d --build"],
    },
    {
      heading: "Transferências P2P diretas, nada armazenado",
      body: [
        "O modo em tempo real do Relayium envia arquivos diretamente entre dois dispositivos por um canal ponto a ponto criptografado — o Nextcloud não tem equivalente, já que todo compartilhamento do Nextcloud é enviado para o seu servidor e baixado dele. Uma troca de chaves X25519 deriva uma chave para AES-256-GCM, ambos os dispositivos mostram um código de verificação de 6 dígitos idêntico (SAS) para descartar um ataque de intermediário, e cada arquivo é verificado de ponta a ponta com um hash SHA-256.",
        "Na mesma rede isso não precisa de conta alguma: abra o relayium.com nos dois dispositivos, escolha até 1.000 arquivos, verifique o código e envie. Enviar entre redes com um código de emparelhamento exige que o remetente faça login — o destinatário nunca precisa de conta. Se uma conexão cai no meio da transferência, ela retoma em vez de recomeçar, e quando um caminho direto não é possível ela recorre a um retransmissor TURN criptografado que só vê texto cifrado.",
      ],
    },
    {
      heading: "Quando o destinatário está offline: links armazenados de conhecimento zero",
      body: [
        "A transferência em tempo real precisa que as duas pessoas estejam online ao mesmo tempo, e é aí que o servidor sempre ativo do Nextcloud tem uma vantagem real. O Relayium também cobre esse caso, sem abrir mão da privacidade: seu navegador gera uma chave AES-256-GCM aleatória, criptografa os arquivos com ela antes que qualquer coisa saia do seu dispositivo, e a chave vive apenas no fragmento da URL — a parte depois do # que os navegadores nunca enviam a um servidor. O servidor armazena texto cifrado que não consegue descriptografar.",
        "Criar um link armazenado exige que o remetente faça login; o destinatário não precisa de conta para baixar. Cada link pode ser configurado para expirar após 1 hora, 1 dia, 3 dias ou até 7 dias conforme o seu plano, ou para se autodestruir após o primeiro download completo — ele não pretende ser um lar permanente para o arquivo como um compartilhamento do Nextcloud, ele foi feito para desaparecer.",
      ],
    },
    {
      heading: "Comparação de recursos num relance",
      body: ["As diferenças que mais importam, lado a lado:"],
      bullets: [
        "Propósito: o Nextcloud é uma plataforma de nuvem completa para armazenamento duradouro e sincronizado; o Relayium é uma ferramenta focada em transferência direta ou um link que expira.",
        "Onde os arquivos ficam: o Nextcloud mantém seus arquivos no servidor pelo tempo que você quiser; o modo em tempo real do Relayium não os armazena de forma alguma, e os links armazenados expiram ou se autodestroem após um download.",
        "Pegada de auto-hospedagem: o Nextcloud precisa de um servidor web, um banco de dados, um ambiente de execução PHP e atualizações contínuas de aplicativos; a auto-hospedagem do Relayium é um único contêiner (docker compose up -d --build) mais um retransmissor TURN opcional para transferências entre redes.",
        "Contas: o Nextcloud precisa de uma conta para cada usuário que o acessa; o Relayium não precisa de nenhuma para transferências na mesma rede, só o remetente faz login para o emparelhamento entre redes ou os links armazenados, e os destinatários nunca precisam de uma.",
        "Criptografia: o modo em tempo real do Relayium é de ponta a ponta com um código SAS de 6 dígitos e nunca toca um servidor; os links armazenados são de conhecimento zero com uma chave aleatória que nunca sai do fragmento da URL. Os compartilhamentos do Nextcloud são enviados para o seu servidor e baixados dele, protegidos por TLS em trânsito e pela criptografia em repouso que você configurar.",
        "Custo e abertura: o Relayium é gratuito e licenciado sob MIT em github.com/relayium/relayium; o software de servidor do Nextcloud também é gratuito e de código aberto (AGPL), com hospedagem e suporte pagos disponíveis pela Nextcloud GmbH e parceiros.",
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
        a: "Não. No modo em tempo real nada é armazenado em lugar algum — o arquivo vai diretamente entre os dispositivos. Os links armazenados mantêm texto cifrado de conhecimento zero apenas até expirarem (de 1 hora a até 7 dias, conforme o seu plano) ou serem baixados uma vez com autodestruição após a leitura, não indefinidamente como um compartilhamento do Nextcloud.",
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
        a: "Sim — gratuito e de código aberto sob a licença MIT, sem nível pago. O software de servidor central do Nextcloud também é gratuito e de código aberto; algumas opções de hospedagem e suporte da Nextcloud GmbH são pagas.",
      },
    ],
  },
  cta: {
    text: "Envie um arquivo diretamente, ou compartilhe um link de conhecimento zero que expira — sem conta de armazenamento em nuvem na mesma rede.",
    button: "Experimentar o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/nextcloud",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
