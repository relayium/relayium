// web/scripts/pages/content/articles/guides-receive-from-cli.mjs
// Guide: the receiving side of the Relayium CLI — receive, serve, and pull.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

const en = {
  title: "Receive files from the command line",
  description:
    "Three ways to receive a file with the Relayium CLI: receive a cross-network pairing-code send, serve as a listening drop box for daemon-direct pushes, or pull from a server you can already ssh into. Free, no account.",
  updatedLabel: "Last updated",
  lead: [
    "Sending is only half the story — sooner or later you're on the receiving end: a colleague wants to hand you a file across the internet, one of your own machines wants to hand off to another, or you want to reach out and grab something from a server you administer. The Relayium CLI covers all three with a different command for each, and none of them need an account.",
    "Pick receive when someone else is pushing to you by pairing code, serve when you want a standing inbox that trusted machines can push to any time, and pull when you're the one reaching out to a server you can already ssh into.",
  ],
  sections: [
    {
      heading: "Three ways to receive, and when each applies",
      body: [
        "Which command you run depends on who's starting the transfer and how the two machines know each other:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — someone sends to you across networks using a pairing code their CLI minted and passed to you out of band. Direct peer-to-peer, verified with a SAS code.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — this machine listens for daemon-direct relayium:// pushes, on port 9031 by default.",
        "relayium pull [user@]host:src <dest> — you reach out over SSH to a server you can already log into and fetch files back.",
      ],
    },
    {
      heading: "receive: someone sends you a file across networks",
      body: [
        "This is the receiving half of relayium send. The other person runs relayium send <path> on their end (after relayium login); their CLI mints a 6-character code, good for 5 minutes, and prints it. They tell you what it is over any channel you both trust — a call, a chat message. You run receive with that code:",
      ],
      code: [
        `relayium receive K7M4XR

# or into a specific directory
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "The connection is direct, peer-to-peer, and end-to-end encrypted; both terminals print the same SAS (short authentication string) once connected. Compare it out of band to confirm that the pinned TLS certificate fingerprints were not substituted and the rendezvous service did not impersonate either endpoint. The SAS authenticates the endpoints; it does not prove every network hop.",
        "No destination given: files land in the current directory.",
        "Same direct-only rule as send: if no direct path can be found between the two networks, the transfer fails rather than routing through a relay.",
        "This is the CLI's own pairing-code protocol — CLI codes pair CLI to CLI. It doesn't interoperate with the browser's pairing code or QR flow at relayium.com today; that's a possible future addition, not something you can rely on yet. If you only have a browser, ask the sender for a relayium up download link instead.",
        "The receiver never needs an account, on any network. Only the sender signs in, so their CLI can mint the code.",
      ],
    },
    {
      heading: "serve: turn this machine into a listening drop box",
      body: [
        "serve works the other way around: instead of you reaching out, other machines push straight to you over relayium:// — built for machines you already trust, like your own laptop pushing to a NAS, or a build server dropping artifacts on a box you own — over a pinned TLS 1.3 connection, no SSH, no rendezvous.",
      ],
      code: [
        `relayium serve

# a specific directory, port, and allowing delete requests
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "The first time a new machine pushes to you, serve (running in a terminal) shows its address and fingerprint and asks you to approve it once; after that, pushes from the same fingerprint go through silently.",
        "Without a terminal — a systemd service, a script with no TTY — there's no one to ask, so an unrecognized pusher is rejected outright. Pre-authorize it instead, using the fingerprint the pusher prints with relayium id:",
      ],
    },
    {
      heading: "Pre-authorize for unattended serve",
      body: [
        "For a serve that runs unattended (systemd, a background script), have the pusher run relayium id to print its fingerprint, then approve it ahead of time from the receiving side:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir sets where files land (default the current directory); --once accepts a single transfer and exits; --allow-delete lets an incoming --delete (mirror) request actually remove files here, and is off by default.",
        "--config-dir (default ~/.config/relayium) is where this host's identity and its authorized-fingerprints list live — override it if you're running serve as a dedicated service.",
      ],
    },
    {
      heading: "pull: reach out and fetch from a server you can ssh into",
      body: [
        "pull is the mirror of push: instead of waiting for someone to send you something, you reach out over your existing SSH access and fetch files back.",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "Unlike push, pull always needs relayium already installed on the remote — there's no tar fallback for pulling from a bare server. If the remote doesn't have it yet, install it there first with curl -fsSL https://relayium.com/install.sh | sh.",
        "Files are verified with a per-file SHA-256 check and resume automatically if interrupted (add --no-resume to disable).",
        "-i and -p behave like ssh's own -i/-p, for a specific identity file or port.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account to receive files?",
        a: "No. All three ways — receive, serve, and pull — are completely free and need no Relayium account on your side. The one sign-in anywhere is the sender's in receive mode, so their CLI can mint the pairing code.",
      },
      {
        q: "Does relayium receive interoperate with the browser's pairing code?",
        a: "No. The CLI's pairing-code protocol is separate from the browser's join-link and QR flow at relayium.com — they use different handshakes and don't talk to each other today, so a CLI code only pairs with another CLI. That's on the roadmap, not something you can rely on yet. Until then, a browser recipient wants a relayium up link rather than a code.",
      },
      {
        q: "What happens if an unknown machine pushes to my serve listener?",
        a: "In a terminal, you're prompted to approve it by address and fingerprint on its first push, and the approval is remembered. Without a terminal — a systemd service, a cron job — there's no one to ask, so an unrecognized pusher is rejected; pre-authorize it first with relayium authorize <fingerprint>.",
      },
      {
        q: "Can I pull from a server that doesn't have relayium installed?",
        a: "No. pull always needs relayium on the remote end; there's no tar fallback the way there is for push. Install relayium there first.",
      },
      {
        q: "Where does relayium keep my identity and trusted peers?",
        a: "In ~/.config/relayium by default — override the location with --config-dir on any command that touches identity or trust.",
      },
    ],
  },
  cta: {
    text: "Ready to receive your first transfer? Install the CLI and pick receive, serve, or pull.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "在命令行接收文件",
  description:
    "用 Relayium CLI 接收文件的三种方式：receive 接收跨网络的配对码发送，serve 作为监听收件箱接收 daemon 直连推送，或者 pull 从你已能 SSH 登录的服务器取回文件。免费，无需账号。",
  updatedLabel: "最近更新",
  lead: [
    "发送只是故事的一半——迟早你也会是接收方：同事想跨网络给你一个文件，你自己的一台机器想把东西交给另一台，或者你想主动从你管理的服务器上取点东西回来。Relayium CLI 用三个不同的命令覆盖这三种情形，而且都不需要账号。",
    "对方用配对码推给你时用 receive；想要一个常驻收件箱、让受信任的机器随时可以推送过来时用 serve；而你主动去连接一台已能 SSH 登录的服务器取文件时用 pull。",
  ],
  sections: [
    {
      heading: "三种接收方式，各自适用于什么场景",
      body: ["用哪个命令，取决于谁在发起传输，以及两台机器是怎么互相认识的："],
      bullets: [
        "relayium receive <code> [destdir] ——对方跨网络发给你：他的 CLI 先生成一个配对码，再线下转告你。直接点对点，用 SAS 码验证。",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] ——这台机器监听 daemon 直连的 relayium:// 推送，默认端口 9031。",
        "relayium pull [user@]host:src <dest> ——你主动通过 SSH 连接到一台你已能登录的服务器，把文件取回来。",
      ],
    },
    {
      heading: "receive：对方跨网络把文件发给你",
      body: [
        "这是 relayium send 的接收端。对方在自己那边运行 relayium send <path>（事先 relayium login 过），CLI 会生成一个 6 位、5 分钟内有效的码并打印出来。然后对方通过你们都信任的渠道告诉你——打个电话、发条消息。你则用这个码运行 receive：",
      ],
      code: [
        `relayium receive K7M4XR

# 或者放进指定的目录
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "连接是直接点对点、端到端加密的；一旦连上，两边的终端会打印出同一个 SAS（简短认证串）。通过带外方式与发送方核对，可以确认固定的 TLS 证书指纹没有被替换、会合服务没有冒充任一端。SAS 认证的是端点，并不证明网络路径上的每一跳。",
        "不指定目标目录时，文件会落到当前目录。",
        "和 send 一样只走直连：如果两个网络之间找不到直连路径，传输会失败，而不会经中继转发。",
        "这是 CLI 自己的配对码协议——CLI 的码只能和 CLI 配对。目前和 relayium.com 浏览器端的配对码或二维码流程互不通用；未来也许会支持，但现在还不能指望。如果你手上只有浏览器，请让发送方改用 relayium up 给你一个下载链接。",
        "接收方无论在哪个网络上，都不需要账号。只有发送方需要登录，好让发送端的 CLI 生成配对码。",
      ],
    },
    {
      heading: "serve：把这台机器变成一个监听收件箱",
      body: [
        "serve 的方向正相反：不是你去连别人，而是其他机器通过 relayium:// 直接推送给你——专为你已经信任的机器设计，比如你自己的笔记本推给一台 NAS，或者构建服务器把产物投递到你的机器上——走的是证书固定的 TLS 1.3 连接，无需 SSH，无需会合。",
      ],
      code: [
        `relayium serve

# 指定目录和端口，并允许删除请求
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "新机器第一次向你推送时，serve（在终端中运行时）会显示它的地址和指纹，并请你批准一次；之后同一指纹的推送会静默通过。",
        "没有终端时——比如作为 systemd 服务、无 TTY 的脚本——没有人来回应提示，未知推送方会被直接拒绝。这种情况下应改为预先授权，用推送方通过 relayium id 打印出的指纹：",
      ],
    },
    {
      heading: "为无人值守的 serve 预先授权",
      body: [
        "对于无人值守运行的 serve（systemd、后台脚本），让推送方运行 relayium id 打印出它的指纹，然后在接收方这边提前批准它：",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir 设置文件落地的位置（默认为当前目录）；--once 只接受一次传输就退出；--allow-delete 允许推送方的 --delete（镜像）请求真正在这里删除文件，默认关闭。",
        "--config-dir（默认 ~/.config/relayium）指向一个位置：这台主机的身份和已授权指纹列表都存放在那里——如果把 serve 作为专用服务运行，可以覆盖它。",
      ],
    },
    {
      heading: "pull：主动从你能 SSH 登录的服务器取文件",
      body: [
        "pull 是 push 的镜像：不是等别人发东西给你，而是你通过已有的 SSH 权限主动连过去，把文件取回来。",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "和 push 不同，pull 始终需要远程已经装有 relayium——从裸机服务器 pull 没有 tar 兜底方案。如果远程还没装，先在那边用 curl -fsSL https://relayium.com/install.sh | sh 安装。",
        "文件会用逐文件 SHA-256 校验，中断后会自动续传（加 --no-resume 可以禁用）。",
        "-i 和 -p 的行为和 ssh 自己的 -i/-p 一样，用于指定身份文件或端口。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "接收文件需要账号吗？",
        a: "不需要。三种方式——receive、serve、pull——都完全免费，你这一端不需要 Relayium 账号。整个过程里唯一需要登录的，是 receive 模式下的发送方，好让发送端的 CLI 生成配对码。",
      },
      {
        q: "relayium receive 和浏览器的配对码互通吗？",
        a: "不互通。CLI 的配对码协议和 relayium.com 浏览器端的加入链接、二维码流程是分开的——它们的握手方式不同，目前也无法互相通信，所以 CLI 的码只能和另一个 CLI 配对。这是路线图上的事，现在还不能指望。在此之前，用浏览器接收的人需要的是一个 relayium up 链接，而不是配对码。",
      },
      {
        q: "如果一台未知机器向我的 serve 监听端推送会怎样？",
        a: "在终端中，会在它首次推送时提示你按地址和指纹批准，批准结果会被记住。没有终端时——比如作为 systemd 服务或 cron 任务——没有人来回应，未知推送方会被拒绝；应先用 relayium authorize <fingerprint> 预先授权。",
      },
      {
        q: "能从一台没装 relayium 的服务器 pull 吗？",
        a: "不能。pull 始终需要远程装有 relayium；不像 push 那样有 tar 兜底方案。请先在远程安装 relayium。",
      },
      {
        q: "relayium 把我的身份和受信任的对端存在哪里？",
        a: "默认在 ~/.config/relayium 中——在任何涉及身份或信任的命令上，都可以用 --config-dir 覆盖这个位置。",
      },
    ],
  },
  cta: {
    text: "准备好接收第一次传输了吗？装上 CLI，选择 receive、serve 或 pull。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "コマンドラインでファイルを受信する",
  description:
    "Relayium CLI でファイルを受信する3つの方法: ネットワークを越えたペアリングコード送信を receive で受け取る、デーモン直結のプッシュを待ち受ける serve、すでに SSH でログインできるサーバーから取り込む pull。無料、アカウント不要。",
  updatedLabel: "最終更新",
  lead: [
    "送信は話の半分にすぎません——いずれ受け取る側になります。同僚がインターネット越しにファイルを渡したいとき、自分のマシン同士で受け渡ししたいとき、あるいは自分が管理するサーバーから何かを取りに行きたいとき。Relayium CLI はそれぞれに異なるコマンドで、この3つすべてに対応しています。どれもアカウントは不要です。",
    "相手がペアリングコードでこちらへプッシュしてくるなら receive、信頼できるマシンがいつでもプッシュできる常設の受信箱が欲しいなら serve、そして自分からすでに SSH でログインできるサーバーへ出向くなら pull を選びます。",
  ],
  sections: [
    {
      heading: "受信の3つの方法と、それぞれが当てはまる場面",
      body: [
        "どのコマンドを使うかは、誰が転送を始めるのか、そして2台のマシンがどう互いを知っているかによって決まります:",
      ],
      bullets: [
        "relayium receive <code> [destdir] ——相手の CLI が発行し、帯域外で伝えられたペアリングコードを使って、相手がネットワークを越えて送ってきます。直接ピアツーピアで、SAS コードで検証します。",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] ——このマシンがデーモン直結の relayium:// プッシュを待ち受けます。デフォルトのポートは 9031 です。",
        "relayium pull [user@]host:src <dest> ——自分からすでにログインできるサーバーへ SSH で出向き、ファイルを取り込みます。",
      ],
    },
    {
      heading: "receive: 相手がネットワークを越えてファイルを送ってくる",
      body: [
        "これは relayium send の受信側です。相手は自分の側で relayium send <path> を実行します（事前に relayium login 済み）。相手の CLI が5分間有効な6文字のコードを発行して表示するので、通話やチャットなど二人が信頼できる手段でそれを伝えてもらいます。受け取ったコードで receive を実行します:",
      ],
      code: [
        `relayium receive K7M4XR

# 特定のディレクトリに受け取る場合
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "接続は直接のピアツーピアでエンドツーエンドに暗号化されています。接続後、両方のターミナルに同じ SAS（short authentication string）が表示されます。送信側と帯域外で照合すると、固定された TLS 証明書フィンガープリントが差し替えられておらず、ランデブーサービスがどちらのエンドポイントにもなりすましていないことを確認できます。SAS はエンドポイントを認証するもので、ネットワーク経路上のすべてのホップを証明するものではありません。",
        "宛先を指定しない場合、ファイルはカレントディレクトリに置かれます。",
        "send と同じく直接接続のみのルールです。2つのネットワークの間に直接の経路が見つからなければ、リレー経由で送るのではなく転送が失敗します。",
        "これは CLI 独自のペアリングコード・プロトコルです——CLI のコードは CLI 同士でしかペアリングできません。現時点では relayium.com のブラウザ側のペアリングコードや QR フローとは相互運用しません。将来追加される可能性はありますが、今はまだ頼れるものではありません。ブラウザしかない場合は、代わりに relayium up のダウンロードリンクを送ってもらってください。",
        "受信側はどのネットワークにいても、アカウントは一切不要です。サインインするのは送信側だけで、その CLI がコードを発行できるようにするためです。",
      ],
    },
    {
      heading: "serve: このマシンを待ち受け型の受信箱にする",
      body: [
        "serve は逆方向に動作します。こちらから出向くのではなく、他のマシンが relayium:// 経由で直接プッシュしてきます——自分のノート PC が NAS へプッシュする、ビルドサーバーが成果物を自分のマシンへ落とすなど、すでに信頼しているマシン向けです。証明書ピンニング付き TLS 1.3 接続で、SSH もランデブーも不要です。",
      ],
      code: [
        `relayium serve

# ディレクトリとポートを指定し、削除要求を許可する場合
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "新しいマシンが初めてプッシュしてくると、serve は（ターミナルで実行している場合）そのアドレスとフィンガープリントを表示し、一度だけ承認するよう求めます。以降、同じフィンガープリントからのプッシュは黙って通過します。",
        "ターミナルがない場合——systemd サービスや TTY のないスクリプト——確認する相手がいないため、未知のプッシュ側はそのまま拒否されます。代わりに、プッシュ側が relayium id で表示するフィンガープリントを使って事前に承認してください:",
      ],
    },
    {
      heading: "無人稼働の serve のために事前承認する",
      body: [
        "無人で動作する serve（systemd、バックグラウンドスクリプト）では、プッシュ側に relayium id を実行させてフィンガープリントを表示させ、受信側であらかじめそれを承認しておきます:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir はファイルの置き場所を設定します（デフォルトはカレントディレクトリ）。--once は1回の転送だけ受け入れて終了します。--allow-delete は受信した --delete（ミラー）要求によって実際にここでファイルを削除できるようにするもので、デフォルトでは無効です。",
        "--config-dir（デフォルト ~/.config/relayium）は、このホストのアイデンティティと承認済みフィンガープリントのリストが置かれる場所です——serve を専用サービスとして動かす場合は上書きしてください。",
      ],
    },
    {
      heading: "pull: すでに SSH でログインできるサーバーから取り込む",
      body: [
        "pull は push の鏡像です。誰かが何かを送ってくるのを待つのではなく、すでに持っている SSH アクセスを使って自分から出向き、ファイルを取り込みます。",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "push と異なり、pull は常にリモート側にすでに relayium がインストールされている必要があります——素のサーバーから pull するための tar フォールバックはありません。リモートにまだ入っていない場合は、先に curl -fsSL https://relayium.com/install.sh | sh でインストールしてください。",
        "ファイルはファイルごとの SHA-256 チェックで検証され、中断しても自動的に再開します（--no-resume で無効化できます）。",
        "-i と -p は ssh 自体の -i/-p と同様に、特定のアイデンティティファイルやポートを指定するために使えます。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ファイルを受信するのにアカウントは必要ですか？",
        a: "いいえ。receive、serve、pull の3つすべてが完全に無料で、受信側に Relayium アカウントは不要です。どこかでサインインが要るのは receive モードの送信側だけで、その CLI がペアリングコードを発行できるようにするためです。",
      },
      {
        q: "relayium receive はブラウザのペアリングコードと相互運用しますか？",
        a: "しません。CLI のペアリングコード・プロトコルは、relayium.com のブラウザ側の参加リンクや QR フローとは別物です——ハンドシェイクの方式が異なり、現時点では互いに通信しないので、CLI のコードは別の CLI としかペアリングできません。それはロードマップ上の話であり、今はまだ頼れるものではありません。それまでは、ブラウザで受け取る相手にはコードではなく relayium up のリンクを渡します。",
      },
      {
        q: "未知のマシンが自分の serve リスナーへプッシュしてきたらどうなりますか？",
        a: "ターミナルでは、初回のプッシュ時にアドレスとフィンガープリントを見せて承認するかどうか尋ねられ、その承認は記憶されます。ターミナルがない場合——systemd サービスや cron ジョブ——確認する相手がいないため、未知のプッシュ側は拒否されます。先に relayium authorize <fingerprint> で事前承認してください。",
      },
      {
        q: "relayium がインストールされていないサーバーから pull できますか？",
        a: "できません。pull は常にリモート側に relayium が必要です——push にあるような tar フォールバックはありません。先にリモートへ relayium をインストールしてください。",
      },
      {
        q: "relayium は自分のアイデンティティと信頼済みの相手をどこに保存しますか？",
        a: "デフォルトでは ~/.config/relayium にあります——アイデンティティや信頼に関わるどのコマンドでも --config-dir でこの場所を上書きできます。",
      },
    ],
  },
  cta: {
    text: "最初の受信をしてみましょう。CLI をインストールして、receive、serve、pull のいずれかを選んでください。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "명령줄에서 파일 받기",
  description:
    "Relayium CLI로 파일을 받는 세 가지 방법: 네트워크를 넘어온 페어링 코드 전송을 receive로 받거나, 데몬 다이렉트 푸시를 대기하는 serve, 이미 SSH로 접속 가능한 서버에서 가져오는 pull. 무료이며 계정이 필요 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "보내는 것은 이야기의 절반일 뿐입니다——언젠가는 받는 쪽이 됩니다. 동료가 인터넷 너머로 파일을 건네주고 싶을 때, 내 기기 하나가 다른 기기에게 넘겨주고 싶을 때, 또는 본인이 관리하는 서버에서 무언가를 직접 가져오고 싶을 때. Relayium CLI는 이 세 가지 각각에 서로 다른 명령으로 대응하며, 어느 쪽도 계정이 필요 없습니다.",
    "상대가 페어링 코드로 푸시해 올 때는 receive를, 신뢰하는 기기들이 언제든 푸시할 수 있는 상시 수신함이 필요할 때는 serve를, 그리고 이미 SSH로 접속 가능한 서버로 직접 다가갈 때는 pull을 선택하세요.",
  ],
  sections: [
    {
      heading: "받는 세 가지 방법과 각각이 적용되는 상황",
      body: ["어떤 명령을 실행할지는 누가 전송을 시작하는지, 그리고 두 기기가 서로 어떻게 아는 사이인지에 따라 달라집니다:"],
      bullets: [
        "relayium receive <code> [destdir] — 상대의 CLI가 발급해 대역 외로 알려준 페어링 코드를 사용해 상대가 네트워크를 넘어 보내옵니다. 직접적인 피어투피어이며 SAS 코드로 검증됩니다.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — 이 기기가 데몬 다이렉트 relayium:// 푸시를 대기합니다. 기본 포트는 9031입니다.",
        "relayium pull [user@]host:src <dest> — 이미 로그인할 수 있는 서버로 SSH를 통해 직접 다가가 파일을 가져옵니다.",
      ],
    },
    {
      heading: "receive: 상대가 네트워크를 넘어 파일을 보낼 때",
      body: [
        "이것은 relayium send의 받는 쪽입니다. 상대는 자기 쪽에서 relayium send <path>를 실행합니다(미리 relayium login을 해 둔 상태로). 그러면 상대의 CLI가 5분간 유효한 6자 코드를 발급해 출력하고, 상대는 통화나 채팅 등 서로 신뢰하는 채널로 그것을 알려줍니다. 받는 쪽에서는 그 코드로 receive를 실행합니다:",
      ],
      code: [
        `relayium receive K7M4XR

# 특정 디렉터리로 받으려면
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "연결은 직접적인 피어투피어이며 종단간 암호화됩니다. 연결되면 양쪽 터미널에 동일한 SAS(짧은 인증 문자열)가 출력됩니다. 발신자와 대역 외로 비교하면 고정된 TLS 인증서 지문이 바뀌지 않았고 랑데부 서비스가 어느 끝점도 사칭하지 않았음을 확인할 수 있습니다. SAS는 끝점을 인증하는 것이지 네트워크 경로의 모든 홉을 증명하는 것은 아닙니다.",
        "목적지를 지정하지 않으면 파일은 현재 디렉터리에 저장됩니다.",
        "send와 동일하게 직접 연결만 지원합니다. 두 네트워크 사이에 직접 경로를 찾을 수 없으면 릴레이를 거치는 대신 전송이 실패합니다.",
        "이것은 CLI 자체의 페어링 코드 프로토콜입니다——CLI 코드는 CLI끼리만 페어링됩니다. 현재 relayium.com 브라우저 쪽의 페어링 코드나 QR 흐름과는 상호 운용되지 않습니다. 향후 추가될 수는 있지만 지금은 기대할 수 없습니다. 브라우저밖에 없다면 보내는 쪽에 relayium up 다운로드 링크를 대신 요청하세요.",
        "받는 쪽은 어느 네트워크에 있든 계정이 전혀 필요하지 않습니다. 로그인하는 쪽은 보내는 사람뿐이며, 그 CLI가 코드를 발급할 수 있도록 하기 위해서입니다.",
      ],
    },
    {
      heading: "serve: 이 기기를 대기형 수신함으로 만들기",
      body: [
        "serve는 반대 방향으로 동작합니다. 이쪽에서 다가가는 대신, 다른 기기가 relayium://를 통해 곧바로 푸시해 옵니다——이미 신뢰하는 기기, 예를 들어 자신의 노트북이 NAS로 푸시하거나 빌드 서버가 산출물을 내 기기에 떨어뜨리는 경우를 위한 것입니다. 인증서 고정 TLS 1.3 연결로, SSH도 랑데부도 필요 없습니다.",
      ],
      code: [
        `relayium serve

# 디렉터리와 포트를 지정하고 삭제 요청을 허용하려면
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "새 기기가 처음 푸시해 오면, serve는(터미널에서 실행 중일 때) 그 주소와 핑거프린트를 보여주고 한 번 승인해 달라고 요청합니다. 이후 같은 핑거프린트의 푸시는 조용히 통과합니다.",
        "터미널이 없을 때——systemd 서비스, TTY 없는 스크립트——물어볼 사람이 없으므로 알 수 없는 푸시하는 쪽은 그대로 거부됩니다. 대신 푸시하는 쪽이 relayium id로 출력하는 핑거프린트를 이용해 미리 승인하세요:",
      ],
    },
    {
      heading: "무인 실행되는 serve를 위해 미리 승인하기",
      body: [
        "무인으로 실행되는 serve(systemd, 백그라운드 스크립트)의 경우, 푸시하는 쪽이 relayium id를 실행해 핑거프린트를 출력하게 한 다음, 받는 쪽에서 미리 승인해 두세요:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir는 파일이 저장될 위치를 설정합니다(기본값은 현재 디렉터리). --once는 한 번의 전송만 받고 종료합니다. --allow-delete는 들어오는 --delete(미러) 요청이 실제로 이곳의 파일을 삭제할 수 있게 하며, 기본값은 꺼짐입니다.",
        "--config-dir(기본값 ~/.config/relayium)는 이 호스트의 신원과 승인된 핑거프린트 목록이 저장되는 위치입니다——serve를 전용 서비스로 실행한다면 재정의하세요.",
      ],
    },
    {
      heading: "pull: 이미 SSH로 접속 가능한 서버에서 직접 가져오기",
      body: [
        "pull은 push의 거울상입니다. 누군가 무언가를 보내오기를 기다리는 대신, 이미 가진 SSH 접근 권한으로 직접 다가가 파일을 가져옵니다.",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "push와 달리, pull은 항상 원격 쪽에 relayium이 이미 설치되어 있어야 합니다——맨 서버에서 pull할 때 사용할 tar 대체 방식은 없습니다. 원격에 아직 없다면 먼저 curl -fsSL https://relayium.com/install.sh | sh로 설치하세요.",
        "파일은 파일별 SHA-256 검사로 검증되며, 중단되면 자동으로 재개됩니다(--no-resume으로 비활성화 가능).",
        "-i와 -p는 ssh 자체의 -i/-p처럼 동작하며, 특정 신원 파일이나 포트를 지정하는 데 사용합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "파일을 받는 데 계정이 필요한가요?",
        a: "아니요. receive, serve, pull 세 가지 모두 완전히 무료이며 받는 쪽에는 Relayium 계정이 필요 없습니다. 전체 과정에서 유일하게 로그인하는 쪽은 receive 모드의 보내는 사람이며, 그 CLI가 페어링 코드를 발급할 수 있도록 하기 위해서입니다.",
      },
      {
        q: "relayium receive는 브라우저의 페어링 코드와 상호 운용되나요?",
        a: "아니요. CLI의 페어링 코드 프로토콜은 relayium.com 브라우저 쪽의 참여 링크 및 QR 흐름과 별개입니다——핸드셰이크 방식이 다르며 현재는 서로 통신하지 않으므로, CLI 코드는 다른 CLI와만 페어링됩니다. 이는 로드맵에 있는 사항이며 지금은 기대할 수 없습니다. 그때까지 브라우저로 받는 사람에게는 코드가 아니라 relayium up 링크를 주세요.",
      },
      {
        q: "알 수 없는 기기가 내 serve 리스너로 푸시하면 어떻게 되나요?",
        a: "터미널에서는 첫 푸시 시 주소와 핑거프린트로 승인 여부를 묻고, 그 승인은 기억됩니다. 터미널이 없을 때——systemd 서비스나 cron 작업——물어볼 사람이 없으므로 알 수 없는 푸시하는 쪽은 거부됩니다. 먼저 relayium authorize <fingerprint>로 미리 승인하세요.",
      },
      {
        q: "relayium이 설치되지 않은 서버에서 pull할 수 있나요?",
        a: "아니요. pull은 항상 원격 쪽에 relayium이 필요합니다——push처럼 tar 대체 방식이 없습니다. 먼저 원격에 relayium을 설치하세요.",
      },
      {
        q: "relayium은 내 신원과 신뢰하는 상대를 어디에 저장하나요?",
        a: "기본적으로 ~/.config/relayium에 저장됩니다——신원이나 신뢰와 관련된 모든 명령에서 --config-dir로 이 위치를 재정의할 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "첫 전송을 받을 준비가 되셨나요? CLI를 설치하고 receive, serve, pull 중 하나를 선택하세요.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien über die Kommandozeile empfangen",
  description:
    "Drei Wege, mit der Relayium CLI eine Datei zu empfangen: receive für einen netzwerkübergreifenden Pairing-Code-Versand, serve als lauschender Eingangskorb für Daemon-Direct-Pushes, oder pull von einem Server, in den du dich schon per SSH einloggen kannst. Kostenlos, kein Konto.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Senden ist nur die halbe Geschichte — früher oder später bist du auf der Empfängerseite: Ein Kollege will dir eine Datei über das Internet übergeben, eine deiner eigenen Maschinen will sie an eine andere weiterreichen, oder du willst selbst etwas von einem Server holen, den du verwaltest. Die Relayium CLI deckt alle drei Fälle mit jeweils einem eigenen Befehl ab, und keiner davon braucht ein Konto.",
    "Wähle receive, wenn jemand anderes per Pairing-Code zu dir pusht, serve, wenn du einen dauerhaften Eingangskorb willst, zu dem vertrauenswürdige Maschinen jederzeit pushen können, und pull, wenn du selbst zu einem Server greifst, in den du dich schon per SSH einloggen kannst.",
  ],
  sections: [
    {
      heading: "Drei Wege zu empfangen, und wann welcher passt",
      body: [
        "Welchen Befehl du nutzt, hängt davon ab, wer die Übertragung startet und wie sich die beiden Maschinen kennen:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — jemand sendet dir netzwerkübergreifend mit einem Pairing-Code, den dessen CLI erzeugt und dir außerhalb des Kanals mitgeteilt hat. Direkt peer-to-peer, verifiziert mit einem SAS-Code.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — diese Maschine lauscht auf Daemon-Direct-Pushes über relayium://, standardmäßig auf Port 9031.",
        "relayium pull [user@]host:src <dest> — du greifst per SSH auf einen Server zu, in den du dich schon einloggen kannst, und holst Dateien zurück.",
      ],
    },
    {
      heading: "receive: jemand sendet dir eine Datei über Netzwerke hinweg",
      body: [
        "Das ist die Empfangsseite von relayium send. Die andere Person führt auf ihrer Seite relayium send <path> aus (nach relayium login); ihre CLI erzeugt einen Code aus 6 Zeichen, gültig für 5 Minuten, und gibt ihn aus. Sie teilt ihn dir über einen Kanal mit, dem ihr beide vertraut — ein Anruf, eine Chatnachricht. Du führst receive mit diesem Code aus:",
      ],
      code: [
        `relayium receive K7M4XR

# oder in ein bestimmtes Verzeichnis
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "Die Verbindung ist direkt, peer-to-peer und Ende-zu-Ende verschlüsselt; sobald sie steht, geben beide Terminals denselben SAS (Short Authentication String) aus. Vergleiche ihn außerhalb des Kanals mit dem Sender, um zu bestätigen, dass die angehefteten TLS-Zertifikatsfingerabdrücke nicht ausgetauscht wurden und der Rendezvous-Dienst keinen Endpunkt imitiert hat. Der SAS authentifiziert die Endpunkte; er beweist nicht jeden Netzwerk-Hop.",
        "Ohne angegebenes Ziel landen die Dateien im aktuellen Verzeichnis.",
        "Dieselbe Nur-direkt-Regel wie bei send: Findet sich kein direkter Pfad zwischen den beiden Netzwerken, schlägt die Übertragung fehl, statt über ein Relay geleitet zu werden.",
        "Das ist das eigene Pairing-Code-Protokoll der CLI — CLI-Codes koppeln CLI mit CLI. Es arbeitet heute nicht mit dem Pairing-Code oder QR-Ablauf des Browsers auf relayium.com zusammen. Das könnte irgendwann kommen, ist aber momentan nicht etwas, worauf du dich verlassen kannst. Hast du nur einen Browser, bitte den Absender stattdessen um einen Download-Link via relayium up.",
        "Der Empfänger braucht auf keinem Netzwerk je ein Konto. Nur der Absender meldet sich an, damit dessen CLI den Code erzeugen kann.",
      ],
    },
    {
      heading: "serve: diese Maschine zu einem lauschenden Eingangskorb machen",
      body: [
        "serve funktioniert umgekehrt: Statt dass du selbst aktiv wirst, pushen andere Maschinen direkt zu dir über relayium:// — gebaut für Maschinen, denen du schon vertraust, etwa dein eigener Laptop, der zu einem NAS pusht, oder ein Build-Server, der Artefakte auf einer Maschine ablegt, die dir gehört — über eine TLS-1.3-Verbindung mit Pinning, ohne SSH, ohne Rendezvous.",
      ],
      code: [
        `relayium serve

# ein bestimmtes Verzeichnis, ein bestimmter Port, Löschanfragen erlaubt
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "Wenn eine neue Maschine zum ersten Mal zu dir pusht, zeigt dir serve (in einem Terminal laufend) ihre Adresse und ihren Fingerprint und bittet dich, sie einmalig zu genehmigen; danach laufen Pushes vom selben Fingerprint stillschweigend durch.",
        "Ohne Terminal — ein systemd-Dienst, ein Skript ohne TTY — gibt es niemanden, den man fragen könnte, also wird ein unbekannter Pusher rundheraus abgelehnt. Genehmige ihn stattdessen im Voraus, mit dem Fingerprint, den der Pusher via relayium id ausgibt:",
      ],
    },
    {
      heading: "Vorab genehmigen für unbeaufsichtigtes serve",
      body: [
        "Für ein serve, das unbeaufsichtigt läuft (systemd, ein Hintergrundskript), lass den Pusher relayium id ausführen, um seinen Fingerprint auszugeben, und genehmige ihn dann von der Empfängerseite aus im Voraus:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir legt fest, wo Dateien landen (Standard: das aktuelle Verzeichnis); --once nimmt eine einzelne Übertragung an und beendet sich; --allow-delete erlaubt es einer eingehenden --delete-Anfrage (Spiegelung), hier tatsächlich Dateien zu löschen, und ist standardmäßig aus.",
        "--config-dir (Standard ~/.config/relayium) ist der Ort, an dem die Identität dieses Hosts und seine Liste genehmigter Fingerprints liegen — überschreibe ihn, wenn du serve als dedizierten Dienst betreibst.",
      ],
    },
    {
      heading: "pull: selbst auf einen Server zugreifen, in den du dich per SSH einloggen kannst",
      body: [
        "pull ist das Spiegelbild von push: Statt darauf zu warten, dass dir jemand etwas sendet, greifst du über deinen bestehenden SSH-Zugang zu und holst Dateien zurück.",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "Anders als push braucht pull immer relayium, das auf der Gegenseite bereits installiert ist — es gibt keinen tar-Fallback für das Pullen von einem blanken Server. Ist relayium dort noch nicht vorhanden, installiere es zuerst mit curl -fsSL https://relayium.com/install.sh | sh.",
        "Dateien werden mit einer SHA-256-Prüfung pro Datei verifiziert und setzen bei Unterbrechung automatisch fort (mit --no-resume deaktivierbar).",
        "-i und -p verhalten sich wie die eigenen -i/-p von ssh, für eine bestimmte Identitätsdatei oder einen bestimmten Port.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Brauche ich ein Konto, um Dateien zu empfangen?",
        a: "Nein. Alle drei Wege — receive, serve und pull — sind vollständig kostenlos und brauchen auf deiner Seite kein Relayium-Konto. Die einzige Anmeldung überhaupt ist die des Absenders im receive-Fall, damit dessen CLI den Pairing-Code erzeugen kann.",
      },
      {
        q: "Arbeitet relayium receive mit dem Pairing-Code des Browsers zusammen?",
        a: "Nein. Das Pairing-Code-Protokoll der CLI ist getrennt vom Join-Link- und QR-Ablauf des Browsers auf relayium.com — sie verwenden unterschiedliche Handshakes und sprechen heute nicht miteinander, ein CLI-Code koppelt also nur mit einer anderen CLI. Das steht auf der Roadmap, ist aber noch nichts, worauf du dich verlassen kannst. Bis dahin will ein Empfänger im Browser einen Link aus relayium up statt eines Codes.",
      },
      {
        q: "Was passiert, wenn eine unbekannte Maschine zu meinem serve-Listener pusht?",
        a: "In einem Terminal wirst du bei ihrem ersten Push aufgefordert, sie anhand von Adresse und Fingerprint zu genehmigen, und die Genehmigung wird gespeichert. Ohne Terminal — ein systemd-Dienst, ein Cron-Job — gibt es niemanden, den man fragen könnte, also wird ein unbekannter Pusher abgelehnt; genehmige ihn vorher mit relayium authorize <fingerprint>.",
      },
      {
        q: "Kann ich von einem Server pullen, auf dem relayium nicht installiert ist?",
        a: "Nein. pull braucht immer relayium auf der Gegenseite; es gibt keinen tar-Fallback wie bei push. Installiere relayium dort zuerst.",
      },
      {
        q: "Wo speichert relayium meine Identität und vertrauenswürdige Gegenstellen?",
        a: "Standardmäßig in ~/.config/relayium — überschreibe den Ort mit --config-dir bei jedem Befehl, der mit Identität oder Vertrauen zu tun hat.",
      },
    ],
  },
  cta: {
    text: "Bereit für deine erste Übertragung? Installiere die CLI und wähle receive, serve oder pull.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Recevoir des fichiers depuis la ligne de commande",
  description:
    "Trois façons de recevoir un fichier avec la CLI Relayium : receive pour un envoi par code de jumelage entre réseaux, serve comme boîte de réception à l'écoute des envois en daemon direct, ou pull depuis un serveur où vous pouvez déjà vous connecter en SSH. Gratuit, sans compte.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Envoyer n'est que la moitié de l'histoire — tôt ou tard, c'est vous qui recevez : un collègue veut vous remettre un fichier par Internet, l'une de vos machines veut le transmettre à une autre, ou vous voulez aller chercher quelque chose sur un serveur que vous administrez. La CLI Relayium couvre ces trois cas avec une commande différente pour chacun, et aucune ne nécessite de compte.",
    "Choisissez receive quand quelqu'un d'autre vous envoie via un code de jumelage, serve quand vous voulez une boîte de réception permanente vers laquelle des machines de confiance peuvent envoyer à tout moment, et pull quand c'est vous qui allez chercher sur un serveur où vous pouvez déjà vous connecter en SSH.",
  ],
  sections: [
    {
      heading: "Trois façons de recevoir, et quand utiliser chacune",
      body: [
        "La commande à exécuter dépend de qui déclenche le transfert et de la façon dont les deux machines se connaissent :",
      ],
      bullets: [
        "relayium receive <code> [destdir] — quelqu'un vous envoie à travers les réseaux avec un code de jumelage que sa CLI a généré et vous a communiqué hors bande. Pair-à-pair direct, vérifié par un code SAS.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — cette machine écoute les envois en daemon direct via relayium://, sur le port 9031 par défaut.",
        "relayium pull [user@]host:src <dest> — vous allez chercher, via SSH, sur un serveur où vous pouvez déjà vous connecter, et vous récupérez des fichiers.",
      ],
    },
    {
      heading: "receive : quelqu'un vous envoie un fichier à travers les réseaux",
      body: [
        "C'est le pendant côté réception de relayium send. L'autre personne exécute relayium send <path> de son côté (après relayium login) ; sa CLI génère un code de 6 caractères, valable 5 minutes, et l'affiche. Elle vous le communique par un canal auquel vous faites tous deux confiance — un appel, un message. Vous exécutez receive avec ce code :",
      ],
      code: [
        `relayium receive K7M4XR

# ou vers un répertoire précis
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "La connexion est directe, pair-à-pair et chiffrée de bout en bout ; une fois connectés, les deux terminaux affichent le même SAS (short authentication string). Comparez-le hors bande avec l'expéditeur pour confirmer que les empreintes des certificats TLS épinglés n'ont pas été substituées et que le service de rendez-vous n'a usurpé aucune extrémité. Le SAS authentifie les extrémités ; il ne prouve pas chaque saut réseau.",
        "Sans destination indiquée, les fichiers atterrissent dans le répertoire courant.",
        "Même règle de connexion directe uniquement que pour send : si aucun chemin direct n'est trouvé entre les deux réseaux, le transfert échoue plutôt que de transiter par un relais.",
        "C'est le protocole de code de jumelage propre à la CLI — un code CLI ne se jumelle qu'avec une autre CLI. Il n'est pas interopérable aujourd'hui avec le code de jumelage ou le flux QR du navigateur sur relayium.com ; c'est un ajout possible à l'avenir, pas encore quelque chose sur quoi compter. Si vous n'avez qu'un navigateur, demandez plutôt à l'expéditeur un lien de téléchargement relayium up.",
        "Le destinataire n'a jamais besoin de compte, quel que soit le réseau. Seul l'expéditeur se connecte, pour que sa CLI puisse générer le code.",
      ],
    },
    {
      heading: "serve : transformer cette machine en boîte de réception à l'écoute",
      body: [
        "serve fonctionne dans l'autre sens : au lieu que vous alliez chercher, d'autres machines vous envoient directement via relayium:// — conçu pour des machines en qui vous avez déjà confiance, comme votre propre ordinateur portable qui envoie vers un NAS, ou un serveur de build qui dépose des artefacts sur une machine qui vous appartient — via une connexion TLS 1.3 avec épinglage, sans SSH, sans rendez-vous.",
      ],
      code: [
        `relayium serve

# un répertoire et un port précis, en autorisant les requêtes de suppression
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "La première fois qu'une nouvelle machine vous envoie quelque chose, serve (exécuté dans un terminal) affiche son adresse et son empreinte et vous demande de l'approuver une fois ; ensuite, les envois de la même empreinte passent silencieusement.",
        "Sans terminal — un service systemd, un script sans TTY — il n'y a personne à qui demander, donc un émetteur inconnu est rejeté d'emblée. Autorisez-le plutôt à l'avance, en utilisant l'empreinte que l'émetteur affiche avec relayium id :",
      ],
    },
    {
      heading: "Autoriser à l'avance pour un serve sans surveillance",
      body: [
        "Pour un serve qui tourne sans surveillance (systemd, un script en arrière-plan), demandez à l'émetteur d'exécuter relayium id pour afficher son empreinte, puis approuvez-la à l'avance côté récepteur :",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir définit où les fichiers atterrissent (par défaut le répertoire courant) ; --once accepte un seul transfert puis s'arrête ; --allow-delete permet à une requête --delete (miroir) entrante de réellement supprimer des fichiers ici, et est désactivé par défaut.",
        "--config-dir (par défaut ~/.config/relayium) est l'endroit où se trouvent l'identité de cet hôte et sa liste d'empreintes autorisées — surchargez-le si vous exécutez serve comme service dédié.",
      ],
    },
    {
      heading: "pull : aller chercher sur un serveur où vous pouvez déjà vous connecter en SSH",
      body: [
        "pull est le miroir de push : au lieu d'attendre que quelqu'un vous envoie quelque chose, vous allez chercher via votre accès SSH existant et récupérez des fichiers.",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "Contrairement à push, pull a toujours besoin de relayium déjà installé sur la machine distante — il n'y a pas de repli tar pour un pull depuis un serveur nu. Si relayium n'y est pas encore, installez-le d'abord avec curl -fsSL https://relayium.com/install.sh | sh.",
        "Les fichiers sont vérifiés par un contrôle SHA-256 par fichier et reprennent automatiquement en cas d'interruption (ajoutez --no-resume pour désactiver).",
        "-i et -p se comportent comme les -i/-p de ssh lui-même, pour un fichier d'identité ou un port spécifique.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Ai-je besoin d'un compte pour recevoir des fichiers ?",
        a: "Non. Les trois méthodes — receive, serve et pull — sont entièrement gratuites et ne nécessitent aucun compte Relayium de votre côté. La seule connexion où que ce soit est celle de l'expéditeur en mode receive, pour que sa CLI puisse générer le code de jumelage.",
      },
      {
        q: "relayium receive est-il interopérable avec le code de jumelage du navigateur ?",
        a: "Non. Le protocole de code de jumelage de la CLI est distinct du flux de lien de participation et de QR code du navigateur sur relayium.com — ils utilisent des poignées de main différentes et ne communiquent pas entre eux aujourd'hui, donc un code CLI ne se jumelle qu'avec une autre CLI. C'est sur la feuille de route, mais ce n'est pas encore quelque chose sur quoi compter. En attendant, un destinataire sur navigateur veut un lien relayium up plutôt qu'un code.",
      },
      {
        q: "Que se passe-t-il si une machine inconnue envoie vers mon processus serve à l'écoute ?",
        a: "Dans un terminal, on vous demande de l'approuver par son adresse et son empreinte lors de son premier envoi, et l'approbation est mémorisée. Sans terminal — un service systemd, une tâche cron — il n'y a personne à qui demander, donc un émetteur inconnu est rejeté ; autorisez-le d'abord avec relayium authorize <fingerprint>.",
      },
      {
        q: "Puis-je faire un pull depuis un serveur où relayium n'est pas installé ?",
        a: "Non. pull a toujours besoin de relayium côté distant ; il n'y a pas de repli tar comme pour push. Installez d'abord relayium là-bas.",
      },
      {
        q: "Où relayium conserve-t-il mon identité et les pairs de confiance ?",
        a: "Par défaut dans ~/.config/relayium — surchargez cet emplacement avec --config-dir sur toute commande touchant à l'identité ou à la confiance.",
      },
    ],
  },
  cta: {
    text: "Prêt à recevoir votre premier transfert ? Installez la CLI et choisissez receive, serve ou pull.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "استقبال الملفات من سطر الأوامر",
  description:
    "ثلاث طرق لاستقبال ملف باستخدام Relayium CLI: استقبال إرسال برمز اقتران عبر الشبكات باستخدام receive، أو العمل كصندوق وارد مُستمِع لعمليات الدفع daemon direct باستخدام serve، أو السحب من خادم يمكنك أصلًا تسجيل الدخول إليه عبر ssh باستخدام pull. مجاني، بلا حساب.",
  updatedLabel: "آخر تحديث",
  lead: [
    "الإرسال نصف القصة فقط — عاجلًا أم آجلًا ستكون أنت في الطرف المُستقبِل: زميل يريد أن يسلّمك ملفًا عبر الإنترنت، أو أحد أجهزتك يريد أن يمرّره إلى آخر، أو تريد أن تمدّ يدك وتجلب شيئًا من خادم تديره. يغطي Relayium CLI الحالات الثلاث بأمر مختلف لكلٍّ منها، ولا واحدة منها تحتاج حسابًا.",
    "اختر receive حين يدفع إليك شخص آخر برمز اقتران، وserve حين تريد صندوق وارد دائمًا تستطيع الأجهزة الموثوقة الدفع إليه في أي وقت، وpull حين تكون أنت من يمدّ يده إلى خادم يمكنك أصلًا تسجيل الدخول إليه عبر ssh.",
  ],
  sections: [
    {
      heading: "ثلاث طرق للاستقبال، ومتى تنطبق كل منها",
      body: [
        "الأمر الذي تشغّله يعتمد على من يبدأ النقل وكيف يعرف الجهازان أحدهما الآخر:",
      ],
      bullets: [
        "‏‎relayium receive <code> [destdir]‎ — يرسل إليك شخص عبر الشبكات باستخدام رمز اقتران أصدرته واجهة CLI لديه ثم أبلغك به خارج القناة. من الند للند مباشرةً، مُتحقَّق منه برمز SAS.",
        "‏‎relayium serve [--dir D] [--port N] [--once] [--allow-delete]‎ — يستمع هذا الجهاز لعمليات الدفع daemon direct عبر relayium://، على المنفذ 9031 افتراضيًا.",
        "‏‎relayium pull [user@]host:src <dest>‎ — تمدّ يدك عبر SSH إلى خادم يمكنك أصلًا تسجيل الدخول إليه وتجلب الملفات.",
      ],
    },
    {
      heading: "receive: شخص يرسل إليك ملفًا عبر الشبكات",
      body: [
        "هذا هو نصف الاستقبال من relayium send. يشغّل الطرف الآخر ‎relayium send <path>‎ من جهته (بعد relayium login)، فتُصدر واجهة CLI لديه رمزًا من 6 محارف صالحًا لـ 5 دقائق وتطبعه. ثم يخبرك به عبر أي قناة تثقان بها كلاكما — مكالمة، رسالة محادثة. تشغّل أنت receive بذلك الرمز:",
      ],
      code: [
        `relayium receive K7M4XR

# أو إلى مجلد محدد
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "الاتصال مباشر ومن الند للند ومشفَّر من الطرف إلى الطرف؛ يطبع الطرفان الرمز SAS نفسه (سلسلة المصادقة القصيرة) بمجرد الاتصال. قارنه مع المُرسِل خارج القناة لتأكيد أن بصمات شهادات TLS المثبّتة لم تُستبدل وأن خدمة الالتقاء لم تنتحل شخصية أي طرف. يصادق SAS على الطرفين؛ ولا يثبت كل قفزة في مسار الشبكة.",
        "بلا وجهة محددة: تصل الملفات إلى المجلد الحالي.",
        "القاعدة نفسها كما في send، الاتصال المباشر فقط: إن لم يُعثر على مسار مباشر بين الشبكتين، يفشل النقل بدل توجيهه عبر مُرحِّل.",
        "هذا هو بروتوكول رمز الاقتران في الـ CLI — ورموز CLI تقترن بـ CLI فقط. لا يتوافق اليوم مع رمز اقتران المتصفح أو تدفق QR في relayium.com؛ ذلك إضافة مستقبلية محتملة، لا شيء تعتمد عليه بعد. إن لم يكن لديك سوى متصفح، اطلب من المُرسِل رابط تنزيل عبر relayium up بدلًا من ذلك.",
        "المُستقبِل لا يحتاج حسابًا أبدًا، على أي شبكة. المُرسِل وحده هو من يسجّل الدخول، كي تتمكن واجهة CLI لديه من إصدار الرمز.",
      ],
    },
    {
      heading: "serve: حوّل هذا الجهاز إلى صندوق وارد مُستمِع",
      body: [
        "يعمل serve بالعكس: بدل أن تمدّ يدك أنت، تدفع أجهزة أخرى إليك مباشرةً عبر relayium:// — مصمَّم للأجهزة التي تثق بها أصلًا، مثل حاسوبك المحمول يدفع إلى NAS، أو خادم بناء يُسقط منتجاته على جهاز تملكه — عبر اتصال TLS 1.3 مثبَّت، بلا SSH وبلا تعارف.",
      ],
      code: [
        `relayium serve

# مجلد ومنفذ محددان، مع السماح بطلبات الحذف
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "أول مرة يدفع إليك جهاز جديد، يعرض serve (عند تشغيله في طرفية) عنوانه وبصمته ويطلب منك الموافقة عليه مرة واحدة؛ بعد ذلك تمر عمليات الدفع من البصمة نفسها بصمت.",
        "بلا طرفية — خدمة systemd، برنامج نصي بلا TTY — لا أحد ليُسأل، فيُرفض الطرف الدافع غير المعروف فورًا. بدلًا من ذلك، امنحه الإذن مسبقًا باستخدام البصمة التي يطبعها الطرف الدافع بـ relayium id:",
      ],
    },
    {
      heading: "منح الإذن مسبقًا لـ serve دون إشراف",
      body: [
        "لتشغيل serve دون إشراف (systemd، برنامج نصي في الخلفية)، اجعل الطرف الدافع يشغّل relayium id لطباعة بصمته، ثم امنحها الإذن مسبقًا من جهة الاستقبال:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "‏--dir يحدّد أين تصل الملفات (الافتراضي هو المجلد الحالي)؛ ‏--once يقبل نقلًا واحدًا ثم يخرج؛ ‏--allow-delete يتيح لطلب --delete (المرآة) الوارد أن يزيل الملفات فعلًا هنا، وهو معطّل افتراضيًا.",
        "‏--config-dir (الافتراضي ~/.config/relayium) هو مكان هوية هذا المضيف وقائمة بصماته المُصرَّح بها — تجاوزه إن كنت تشغّل serve كخدمة مخصّصة.",
      ],
    },
    {
      heading: "pull: مدّ يدك واجلب من خادم يمكنك تسجيل الدخول إليه عبر ssh",
      body: [
        "‏pull هو مرآة push: بدل انتظار أن يرسل إليك أحد شيئًا، تمدّ يدك عبر وصول SSH الموجود لديك وتجلب الملفات.",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "على عكس push، يحتاج pull دائمًا إلى relayium مثبَّتًا أصلًا على الجهاز البعيد — لا يوجد بديل tar للسحب من خادم عارٍ. إن لم يكن موجودًا هناك بعد، ثبّته أولًا بـ curl -fsSL https://relayium.com/install.sh | sh.",
        "تُتحقَّق الملفات بفحص SHA-256 لكل ملف وتستأنف تلقائيًا إذا انقطعت (أضف --no-resume لتعطيل ذلك).",
        "‏-i و -p تتصرفان مثل -i/-p الخاصتين بـ ssh نفسه، لملف هوية أو منفذ محدد.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج حسابًا لاستقبال الملفات؟",
        a: "لا. الطرق الثلاث جميعها — receive وserve وpull — مجانية تمامًا ولا تحتاج حساب Relayium من جهتك. وتسجيل الدخول الوحيد في كل هذا هو تسجيل المُرسِل في وضع receive، كي تتمكن واجهة CLI لديه من إصدار رمز الاقتران.",
      },
      {
        q: "هل يتوافق relayium receive مع رمز اقتران المتصفح؟",
        a: "لا. بروتوكول رمز الاقتران في الـ CLI منفصل عن تدفق رابط الانضمام وQR في المتصفح على relayium.com — يستخدمان مصافحات مختلفة ولا يتحدثان أحدهما إلى الآخر اليوم، فرمز الـ CLI لا يقترن إلا بواجهة CLI أخرى. ذلك على خارطة الطريق، لا شيء تعتمد عليه بعد. وإلى أن يحدث ذلك، من يستقبل عبر متصفح يحتاج رابط relayium up لا رمزًا.",
      },
      {
        q: "ماذا يحدث إذا دفع جهاز غير معروف إلى مُستمِع serve لديّ؟",
        a: "في الطرفية، يُطلب منك الموافقة عليه بعنوانه وبصمته عند أول دفعة، وتُحفَظ الموافقة. بلا طرفية — خدمة systemd، مهمة cron — لا أحد ليُسأل، فيُرفض الطرف الدافع غير المعروف؛ امنحه الإذن مسبقًا أولًا بـ ‎relayium authorize <fingerprint>‎.",
      },
      {
        q: "هل يمكنني السحب من خادم لا يوجد فيه relayium مثبَّتًا؟",
        a: "لا. يحتاج pull دائمًا إلى relayium على الطرف البعيد؛ لا يوجد بديل tar كما في push. ثبّت relayium هناك أولًا.",
      },
      {
        q: "أين يحفظ relayium هويتي والأقران الموثوقين؟",
        a: "في ~/.config/relayium افتراضيًا — تجاوز الموقع بـ --config-dir في أي أمر يمسّ الهوية أو الثقة.",
      },
    ],
  },
  cta: {
    text: "مستعد لاستقبال نقلك الأول؟ ثبّت الـ CLI واختر receive أو serve أو pull.",
    button: "احصل على الـ CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Recibir archivos desde la línea de comandos",
  description:
    "Tres formas de recibir un archivo con la CLI de Relayium: recibir un envío entre redes por código de emparejamiento, actuar como buzón a la escucha para envíos en daemon directo, o hacer un pull desde un servidor al que ya puedes conectarte por ssh. Gratis, sin cuenta.",
  updatedLabel: "Última actualización",
  lead: [
    "Enviar es solo la mitad de la historia — tarde o temprano estás en el extremo receptor: un colega quiere entregarte un archivo por internet, una de tus propias máquinas quiere pasárselo a otra, o quieres ir a buscar algo en un servidor que administras. La CLI de Relayium cubre los tres casos con un comando distinto para cada uno, y ninguno necesita cuenta.",
    "Elige receive cuando alguien te envía por código de emparejamiento, serve cuando quieres un buzón permanente al que máquinas de confianza puedan enviar en cualquier momento, y pull cuando eres tú quien va a buscar en un servidor al que ya puedes conectarte por ssh.",
  ],
  sections: [
    {
      heading: "Tres formas de recibir, y cuándo aplica cada una",
      body: [
        "Qué comando ejecutas depende de quién inicia la transferencia y de cómo se conocen las dos máquinas:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — alguien te envía entre redes usando un código de emparejamiento que generó su CLI y te comunicó fuera de banda. Directo de igual a igual, verificado con un código SAS.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — esta máquina escucha envíos en daemon directo por relayium://, en el puerto 9031 por defecto.",
        "relayium pull [user@]host:src <dest> — vas a buscar por SSH a un servidor al que ya puedes conectarte y recuperas archivos.",
      ],
    },
    {
      heading: "receive: alguien te envía un archivo entre redes",
      body: [
        "Esta es la mitad receptora de relayium send. La otra persona ejecuta relayium send <path> en su extremo (tras relayium login); su CLI genera un código de 6 caracteres, válido 5 minutos, y lo imprime. Te dice cuál es por cualquier canal en el que ambos confíen — una llamada, un mensaje de chat. Tú ejecutas receive con ese código:",
      ],
      code: [
        `relayium receive K7M4XR

# o dentro de un directorio concreto
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "La conexión es directa, de igual a igual y cifrada de extremo a extremo; ambos terminales imprimen el mismo SAS (cadena de autenticación corta) una vez conectados. Compáralo fuera de banda con el remitente para confirmar que las huellas de los certificados TLS fijados no fueron sustituidas y que el servicio de encuentro no suplantó a ninguno de los extremos. El SAS autentica los extremos; no demuestra cada salto de la ruta de red.",
        "Sin destino indicado: los archivos caen en el directorio actual.",
        "La misma regla de solo directo que send: si no puede hallarse ninguna ruta directa entre las dos redes, la transferencia falla en lugar de enrutarse por un retransmisor.",
        "Este es el propio protocolo de código de emparejamiento de la CLI — un código de la CLI solo se empareja con otra CLI. Hoy no interopera con el código de emparejamiento del navegador ni con el flujo de QR en relayium.com; eso es una posible adición futura, no algo en lo que puedas confiar todavía. Si solo tienes navegador, pídele al remitente un enlace de descarga de relayium up.",
        "El receptor nunca necesita una cuenta, en ninguna red. Solo el remitente inicia sesión, para que su CLI pueda generar el código.",
      ],
    },
    {
      heading: "serve: convierte esta máquina en un buzón a la escucha",
      body: [
        "serve funciona al revés: en lugar de que seas tú quien va a buscar, otras máquinas te envían directamente por relayium:// — pensado para máquinas en las que ya confías, como tu propio portátil enviando a un NAS, o un servidor de compilación dejando artefactos en una máquina que es tuya — por una conexión TLS 1.3 con anclaje, sin SSH, sin punto de encuentro.",
      ],
      code: [
        `relayium serve

# un directorio y un puerto concretos, permitiendo peticiones de borrado
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "La primera vez que una máquina nueva te envía algo, serve (ejecutándose en un terminal) muestra su dirección y su huella y te pide que la apruebes una vez; después, los envíos de la misma huella pasan en silencio.",
        "Sin terminal — un servicio systemd, un script sin TTY — no hay a quién preguntar, así que un emisor no reconocido se rechaza de plano. En su lugar, autorízalo por adelantado usando la huella que el emisor imprime con relayium id:",
      ],
    },
    {
      heading: "Autorizar por adelantado para un serve desatendido",
      body: [
        "Para un serve que corre desatendido (systemd, un script en segundo plano), haz que el emisor ejecute relayium id para imprimir su huella, y luego apruébala de antemano desde el lado receptor:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir fija dónde caen los archivos (por defecto el directorio actual); --once acepta una única transferencia y sale; --allow-delete deja que una petición --delete (espejo) entrante realmente elimine archivos aquí, y está desactivado por defecto.",
        "--config-dir (por defecto ~/.config/relayium) es donde viven la identidad de este host y su lista de huellas autorizadas — anúlalo si ejecutas serve como un servicio dedicado.",
      ],
    },
    {
      heading: "pull: ve a buscar y recupera de un servidor al que puedes conectarte por ssh",
      body: [
        "pull es el espejo de push: en lugar de esperar a que alguien te envíe algo, vas a buscar por tu acceso SSH existente y recuperas archivos.",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "A diferencia de push, pull siempre necesita relayium ya instalado en el remoto — no hay respaldo con tar para hacer pull desde un servidor pelado. Si el remoto aún no lo tiene, instálalo allí primero con curl -fsSL https://relayium.com/install.sh | sh.",
        "Los archivos se verifican con una comprobación SHA-256 por archivo y se reanudan automáticamente si se interrumpen (añade --no-resume para desactivarlo).",
        "-i y -p se comportan como los propios -i/-p de ssh, para un archivo de identidad o un puerto específico.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito una cuenta para recibir archivos?",
        a: "No. Las tres formas — receive, serve y pull — son completamente gratis y no necesitan una cuenta de Relayium por tu parte. El único inicio de sesión en todo esto es el del remitente en modo receive, para que su CLI pueda generar el código de emparejamiento.",
      },
      {
        q: "¿relayium receive interopera con el código de emparejamiento del navegador?",
        a: "No. El protocolo de código de emparejamiento de la CLI está separado del flujo de enlace de unión y QR del navegador en relayium.com — usan handshakes distintos y hoy no se hablan entre sí, así que un código de la CLI solo se empareja con otra CLI. Eso está en la hoja de ruta, no es algo en lo que puedas confiar todavía. Hasta entonces, quien reciba desde un navegador quiere un enlace de relayium up, no un código.",
      },
      {
        q: "¿Qué pasa si una máquina desconocida envía a mi proceso serve a la escucha?",
        a: "En un terminal, se te pide aprobarla por dirección y huella en su primer envío, y la aprobación se recuerda. Sin terminal — un servicio systemd, una tarea cron — no hay a quién preguntar, así que un emisor no reconocido se rechaza; autorízalo primero con relayium authorize <fingerprint>.",
      },
      {
        q: "¿Puedo hacer pull desde un servidor que no tiene relayium instalado?",
        a: "No. pull siempre necesita relayium en el extremo remoto; no hay respaldo con tar como lo hay para push. Instala relayium allí primero.",
      },
      {
        q: "¿Dónde guarda relayium mi identidad y los pares de confianza?",
        a: "En ~/.config/relayium por defecto — anula la ubicación con --config-dir en cualquier comando que toque la identidad o la confianza.",
      },
    ],
  },
  cta: {
    text: "¿Listo para recibir tu primera transferencia? Instala la CLI y elige receive, serve o pull.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Receber arquivos pela linha de comando",
  description:
    "Três formas de receber um arquivo com a CLI do Relayium: receber um envio entre redes por código de emparelhamento, atuar como caixa de entrada à escuta para envios em daemon direto, ou fazer um pull de um servidor ao qual você já consegue se conectar por ssh. Gratuito, sem conta.",
  updatedLabel: "Última atualização",
  lead: [
    "Enviar é só metade da história — mais cedo ou mais tarde você está na ponta receptora: um colega quer te entregar um arquivo pela internet, uma das suas próprias máquinas quer repassá-lo a outra, ou você quer buscar algo em um servidor que administra. A CLI do Relayium cobre os três casos com um comando diferente para cada um, e nenhum precisa de conta.",
    "Escolha receive quando outra pessoa está te enviando por código de emparelhamento, serve quando você quer uma caixa de entrada permanente para a qual máquinas confiáveis possam enviar a qualquer momento, e pull quando é você quem vai buscar em um servidor ao qual você já consegue se conectar por ssh.",
  ],
  sections: [
    {
      heading: "Três formas de receber, e quando cada uma se aplica",
      body: [
        "Qual comando você executa depende de quem inicia a transferência e de como as duas máquinas se conhecem:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — alguém envia para você entre redes usando um código de emparelhamento que a CLI dessa pessoa gerou e repassou a você fora de banda. Direto ponto a ponto, verificado com um código SAS.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — esta máquina fica à escuta de envios em daemon direto por relayium://, na porta 9031 por padrão.",
        "relayium pull [user@]host:src <dest> — você vai buscar por SSH em um servidor ao qual já consegue se conectar e recupera arquivos.",
      ],
    },
    {
      heading: "receive: alguém envia um arquivo para você entre redes",
      body: [
        "Esta é a metade receptora do relayium send. A outra pessoa executa relayium send <path> do lado dela (depois de relayium login); a CLI dela gera um código de 6 caracteres, válido por 5 minutos, e o exibe. Ela te diz qual é por qualquer canal em que ambos confiem — uma ligação, uma mensagem de chat. Você executa receive com esse código:",
      ],
      code: [
        `relayium receive K7M4XR

# ou para um diretório específico
relayium receive K7M4XR ./downloads`,
      ],
      bullets: [
        "A conexão é direta, ponto a ponto e criptografada de ponta a ponta; ambos os terminais imprimem o mesmo SAS (cadeia de autenticação curta) assim que conectados. Compare-o fora de banda com quem envia para confirmar que as impressões digitais dos certificados TLS fixados não foram substituídas e que o serviço de encontro não se passou por nenhuma das pontas. O SAS autentica as pontas; não prova cada salto da rota de rede.",
        "Sem destino indicado: os arquivos caem no diretório atual.",
        "A mesma regra de somente direto que o send: se nenhum caminho direto puder ser encontrado entre as duas redes, a transferência falha em vez de ser roteada por um retransmissor.",
        "Este é o protocolo de código de emparelhamento próprio da CLI — um código da CLI só emparelha com outra CLI. Hoje ele não interopera com o código de emparelhamento do navegador nem com o fluxo de QR em relayium.com; isso é uma possível adição futura, não algo com que você possa contar ainda. Se você só tem navegador, peça a quem envia um link de download do relayium up.",
        "O receptor nunca precisa de conta, em nenhuma rede. Só quem envia faz login, para que a CLI dele possa gerar o código.",
      ],
    },
    {
      heading: "serve: transforme esta máquina em uma caixa de entrada à escuta",
      body: [
        "serve funciona ao contrário: em vez de você ir buscar, outras máquinas enviam diretamente para você por relayium:// — feito para máquinas em que você já confia, como seu próprio notebook enviando para um NAS, ou um servidor de compilação despejando artefatos em uma máquina que é sua — por uma conexão TLS 1.3 com fixação, sem SSH, sem encontro.",
      ],
      code: [
        `relayium serve

# um diretório e uma porta específicos, permitindo requisições de exclusão
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "Na primeira vez que uma máquina nova envia para você, o serve (rodando em um terminal) mostra o endereço e a impressão digital dela e pede que você a aprove uma vez; depois disso, os envios da mesma impressão digital passam silenciosamente.",
        "Sem terminal — um serviço systemd, um script sem TTY — não há a quem perguntar, então um emissor não reconhecido é rejeitado de imediato. Em vez disso, autorize-o com antecedência usando a impressão digital que o emissor imprime com relayium id:",
      ],
    },
    {
      heading: "Autorizar com antecedência para um serve desassistido",
      body: [
        "Para um serve que roda desassistido (systemd, um script em segundo plano), faça o emissor executar relayium id para imprimir sua impressão digital, e então aprove-a de antemão do lado receptor:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir define onde os arquivos caem (padrão o diretório atual); --once aceita uma única transferência e sai; --allow-delete permite que uma requisição --delete (espelho) recebida realmente remova arquivos aqui, e está desligado por padrão.",
        "--config-dir (padrão ~/.config/relayium) é onde ficam a identidade deste host e sua lista de impressões digitais autorizadas — substitua-o se você executa serve como um serviço dedicado.",
      ],
    },
    {
      heading: "pull: vá buscar e recupere de um servidor ao qual você consegue se conectar por ssh",
      body: [
        "pull é o espelho do push: em vez de esperar que alguém envie algo para você, você vai buscar pelo seu acesso SSH existente e recupera arquivos.",
      ],
      code: ["relayium pull user@host:/path/to/files ./local-dest"],
      bullets: [
        "Ao contrário do push, o pull sempre precisa do relayium já instalado no remoto — não há alternativa com tar para fazer pull de um servidor pelado. Se o remoto ainda não o tem, instale-o lá primeiro com curl -fsSL https://relayium.com/install.sh | sh.",
        "Os arquivos são verificados com uma checagem SHA-256 por arquivo e retomam automaticamente se interrompidos (adicione --no-resume para desativar).",
        "-i e -p se comportam como os próprios -i/-p do ssh, para um arquivo de identidade ou porta específicos.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso de uma conta para receber arquivos?",
        a: "Não. As três formas — receive, serve e pull — são completamente gratuitas e não precisam de conta do Relayium do seu lado. O único login em tudo isso é o de quem envia no modo receive, para que a CLI dele possa gerar o código de emparelhamento.",
      },
      {
        q: "O relayium receive interopera com o código de emparelhamento do navegador?",
        a: "Não. O protocolo de código de emparelhamento da CLI é separado do fluxo de link de entrada e QR do navegador em relayium.com — eles usam handshakes diferentes e hoje não se comunicam entre si, então um código da CLI só emparelha com outra CLI. Isso está no roteiro, não é algo com que você possa contar ainda. Até lá, quem recebe pelo navegador quer um link do relayium up, não um código.",
      },
      {
        q: "O que acontece se uma máquina desconhecida enviar para o meu processo serve à escuta?",
        a: "Em um terminal, você é solicitado a aprová-la por endereço e impressão digital no primeiro envio dela, e a aprovação é lembrada. Sem terminal — um serviço systemd, uma tarefa cron — não há a quem perguntar, então um emissor não reconhecido é rejeitado; autorize-o primeiro com relayium authorize <fingerprint>.",
      },
      {
        q: "Posso fazer pull de um servidor que não tem o relayium instalado?",
        a: "Não. O pull sempre precisa do relayium na ponta remota; não há alternativa com tar como há para o push. Instale o relayium lá primeiro.",
      },
      {
        q: "Onde o relayium guarda minha identidade e os pares confiáveis?",
        a: "Em ~/.config/relayium por padrão — substitua o local com --config-dir em qualquer comando que toque a identidade ou a confiança.",
      },
    ],
  },
  cta: {
    text: "Pronto para receber sua primeira transferência? Instale a CLI e escolha receive, serve ou pull.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/receive-files-from-the-command-line",
  published: "2026-07-09",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
