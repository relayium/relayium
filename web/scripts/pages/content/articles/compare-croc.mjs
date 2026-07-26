// web/scripts/pages/content/articles/compare-croc.mjs
// Fair CLI-vs-CLI comparison: Relayium's CLI vs croc (schollz/croc). English is
// the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Command/code snippets stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Relayium vs croc: encrypted file transfer from the terminal",
  description:
    "Relayium and croc are both free, open-source, encrypted CLI tools for peer-to-peer file transfer. A fair, honest comparison of where each one is the better fit.",
  updatedLabel: "Last updated",
  lead: [
    "croc is one of the best-loved tools for sending a file from one terminal to another: a short, memorable code phrase, a PAKE key exchange, and it just works. Relayium's CLI sets out to do the same job and is built the same way — free, open source, and encrypted end to end, with an account needed only so send can mint its pairing code.",
    "This isn't a takedown; croc earned its reputation. It's a straight comparison of what the two share, where Relayium's CLI does more because it also talks to servers you already run, and the case where croc is honestly the simpler pick.",
  ],
  sections: [
    {
      heading: "What Relayium and croc have in common",
      body: [
        "Start with the overlap, because it's substantial: both are single small binaries you install once, both are completely free with no paid tier, and both are open source under a permissive license so you can read every line that touches your files.",
      ],
      bullets: [
        "A short code known only to the two ends is enough for them to find each other and agree on a key. croc's code is made up on the spot; Relayium's is minted by its server for a signed-in sender, and the receiver still needs no account.",
        "Encrypted in transit end to end: the relay or rendezvous point in the middle never sees your file's contents.",
        "Interrupted transfers can pick back up instead of starting over, and both verify what arrived actually matches what was sent.",
        "Cross-platform: macOS, Linux and Windows.",
      ],
    },
    {
      heading: "SSH and daemon-direct: talking to a server you already run",
      body: [
        "This is the biggest practical difference. croc is built around a single flow — code phrase in, code phrase out. Relayium's CLI adds two more ways to move files that lean on infrastructure you already have.",
        "relayium push / pull reuses your existing SSH access, so there's nothing new to trust and no code to share. push even works against a server with no relayium installed at all, falling back to a plain tar stream over the SSH connection — that fallback is push-only; pull always needs relayium on the remote, since it acts as the sender there.",
        "relayium serve turns any machine you own into a daemon-direct target, reachable over pinned TLS 1.3 with no SSH and no code phrase — trust is on the first connection (approved interactively, or pre-authorized for unattended use) and pinned from then on, the same idea as an SSH host key.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Folder sync and a verification code you check twice",
      body: [
        "croc sends a batch of files and exits — send it again to update the other side, with no notion of what should be removed. Relayium's CLI adds relayium sync, an incremental one-way mirror over either transport above: it only moves what changed, --delete removes files on the destination that disappeared from the source (a daemon only honors it if it was started with --allow-delete, so a receiver has to opt in), and --watch keeps re-syncing in real time as files change, with no cron job needed.",
        "For a one-off cross-network transfer, relayium send / receive plays the same role as croc's code phrase, pairing two computers by a short code. It's direct peer-to-peer, and it prints a short verification code (a Short Authentication String) on both ends so you can visually confirm nobody sat in the middle before any bytes move — worth noting honestly: this mode is direct-only, so if the two ends can't find a direct path it fails rather than falling back to a relay.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "When croc is the simpler pick",
      body: [
        "There are real cases where croc is the better tool for the job, and it's worth saying so plainly.",
      ],
      bullets: [
        "You just want to hand one file to a friend right now with the fewest moving parts — no server to reach, nothing to set up on either end.",
        "You're behind a strict NAT with no way to open a direct path: croc's relay carries the encrypted stream regardless, so the transfer completes either way. Relayium's send / receive is direct-only and can fail in that situation (push/pull or daemon-direct to a reachable server still work, since those don't depend on a direct P2P hop).",
        "You don't need folder mirroring, SSH integration, or a long-running listener — croc is one ad hoc command per side and nothing else to think about.",
        "You already trust croc's large, established community and its years of real-world use.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Talking to a server: Relayium reuses your SSH access (push/pull) or a pinned-TLS daemon; croc has no SSH integration — install croc on both ends and share a code phrase.",
        "Folder sync: relayium sync mirrors incrementally with --delete and --watch; croc sends a batch and exits, with no mirror or delete semantics.",
        "No direct path available: croc's relay carries the encrypted stream so the transfer still completes; Relayium's send/receive is direct-only.",
        "Verification: both are encrypted end to end; Relayium's send/receive additionally prints a short code both sides compare before the transfer starts.",
        "Self-hosting: both are self-hostable — croc's relay is a small standalone binary; Relayium's server also runs the web app, and the CLI's send/receive can point at your own with --server.",
        "License and cost: both AGPL-3.0-licensed and both completely free. croc needs no account at all; Relayium needs one only for send, to mint the pairing code.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is Relayium's CLI free?",
        a: "Yes, completely. There's no paid tier and nothing to meter — every mode connects the two ends directly, and the CLI is AGPL-3.0-licensed and open source.",
      },
      {
        q: "Does it need an account?",
        a: "Only send does. push/pull uses your own SSH access and daemon-direct uses pinned-TLS certificate trust between your machines, so neither touches a Relayium account. send/receive is the exception: only the server can mint a pairing code, and only for a signed-in account, so the sender runs relayium login once. Receiving never needs an account.",
      },
      {
        q: "Can I use the CLI's pairing code with Relayium's browser app?",
        a: "Not yet for a live paired transfer — the CLI's send/receive uses its own direct handshake, separate from the browser's WebRTC-based pairing flow, so the two don't interoperate today. To hand a file to someone using only a browser, use Relayium's stored download link or the browser app's own pairing-code mode.",
      },
      {
        q: "Can I self-host it?",
        a: "Yes. Relayium's server ships as a Docker image (docker compose up -d --build), and you can point the CLI's send/receive at your own instance with --server https://your-domain — the same spirit as running your own croc relay.",
      },
    ],
  },
  cta: {
    text: "Install the free Relayium CLI and try push, sync or send — free, and just as quick to start as croc.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 croc：从终端加密传输文件",
  description:
    "Relayium 和 croc 都是免费、开源、加密的命令行点对点传输工具。本文客观对比两者，看看各自更适合什么场景。",
  updatedLabel: "最近更新",
  lead: [
    "croc 是最受欢迎的终端间传输文件工具之一：一个简短好记的暗号短语、一次 PAKE 密钥交换，就能直接用。Relayium CLI 想做的是同一件事，实现方式也相似——免费、开源、端到端加密，只有 send 为了签发配对码才需要账号。",
    "这不是一篇贬低文。croc 的口碑是实至名归的。本文客观对比两者的共同点、Relayium CLI 因为能对接你已有的服务器而多出的能力，以及 croc 老实说更简单的场景。",
  ],
  sections: [
    {
      heading: "Relayium 与 croc 的共同点",
      body: [
        "先说重合的部分，其实不少：两者都是安装一次就好的小型单一二进制文件，都完全免费、没有付费档位，都以宽松许可证开源，文件相关的每一行代码你都能读到。",
      ],
      bullets: [
        "一个只有两端知道的简短暗号，就足以让彼此找到对方并协商出密钥。croc 的暗号是当场随口定的；Relayium 的则由服务器签发给已登录的发送方，而接收方依然不需要账号。",
        "全程端到端加密：中间的中继或会合节点从不会看到你文件的内容。",
        "中断的传输可以接着传，而不必从头再来；两者也都会校验收到的内容确实和发出的一致。",
        "跨平台：macOS、Linux 和 Windows。",
      ],
    },
    {
      heading: "SSH 与 daemon-direct：对接你已有的服务器",
      body: [
        "这是两者在实际使用上最大的差别。croc 围绕单一流程构建——输入暗号、输出暗号。Relayium CLI 又加了两种传输方式，用的是你本就已有的基础设施。",
        "relayium push / pull 复用你现有的 SSH 权限，因此没有新增的信任关系，也无需分享任何暗号。push 甚至能在远程完全没装 relayium 的服务器上工作，退化为通过 SSH 连接传输一段普通的 tar 流——但这个兜底只属于 push；pull 始终需要远程装有 relayium，因为在那里它要充当发送方。",
        "relayium serve 能把你拥有的任何一台机器变成一个 daemon-direct 目标，通过锁定的 TLS 1.3 访问，无需 SSH、无需暗号——信任建立在第一次连接时（可交互批准，或提前授权以支持无人值守），此后一直锁定，思路和 SSH 的 host key 一样。",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "文件夹同步，以及一段你要核对两遍的验证码",
      body: [
        "croc 发送一批文件后就退出——要更新对方就得再发一次，而且没有“该删除什么”的概念。Relayium CLI 增加了 relayium sync，在上面两种传输方式之上做增量单向镜像：只传发生变化的内容；--delete 会删除目标端上源端已经消失的文件（daemon 只有在以 --allow-delete 启动时才会执行，接收方必须自己选择开启）；--watch 会在文件变化时实时持续重新同步，不需要额外的定时任务。",
        "对于一次性的跨网络传输，relayium send / receive 扮演的角色和 croc 的暗号短语一样，用一个简短的代码配对两台电脑。它是直连点对点的，并且会在两端都打印一段简短的验证码（Short Authentication String），你可以在传输开始前肉眼核对两边是否一致，确认没有人插在中间——需要老实说明的是：这个模式是纯直连的，如果两端找不到直连路径，传输会直接失败，而不会退回到中继。",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "croc 更简单的场景",
      body: ["确实存在 croc 更适合的场景，值得坦白说出来。"],
      bullets: [
        "你现在就想把一个文件发给朋友，环节越少越好——不需要能连到任何服务器，两端也不用配置任何东西。",
        "你处在严格的 NAT 后面，无法打通直连路径：croc 的中继无论如何都会承载加密数据流，传输依然能完成。Relayium 的 send / receive 是纯直连的，在这种情况下可能失败（push/pull 或对可达服务器的 daemon-direct 依然可用，因为它们不依赖点对点直连这一跳）。",
        "你不需要文件夹镜像、SSH 集成，也不想跑一个长期监听的进程——croc 每端只是一条临时命令，不必多想。",
        "你已经信任 croc 庞大成熟的社区以及它多年的实战积累。",
      ],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "对接服务器：Relayium 复用你的 SSH 权限（push/pull）或锁定 TLS 的 daemon；croc 没有 SSH 集成——需要两端都装好 croc 并共享暗号。",
        "文件夹同步：relayium sync 支持 --delete 与 --watch 的增量镜像；croc 发送一批后就退出，没有镜像或删除语义。",
        "无法直连时：croc 的中继会承载加密数据流，传输依然能完成；Relayium 的 send/receive 是纯直连的。",
        "验证：两者都端到端加密；Relayium 的 send/receive 额外会在传输开始前打印一段供双方核对的简短验证码。",
        "自托管：两者都可自托管——croc 的中继是一个小巧的独立二进制；Relayium 的服务器同时也运行着网页版，CLI 的 send/receive 也可以用 --server 指向你自己的实例。",
        "许可证与费用：都是 AGPL-3.0 许可，都完全免费。croc 完全不需要账号；Relayium 只有 send 为了签发配对码才需要。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 的 CLI 免费吗？",
        a: "完全免费。没有付费档位，也没有什么可计量的——每种模式都是两端直接连接，CLI 采用 AGPL-3.0 许可并开源。",
      },
      {
        q: "需要账号吗？",
        a: "只有 send 需要。push/pull 用你自己的 SSH 权限，daemon-direct 用你机器之间锁定的 TLS 证书信任，这两者都不涉及 Relayium 账号。send/receive 是例外：配对码只能由服务器签发，而且只签发给已登录的账号，所以发送方要先运行一次 relayium login。接收方始终不需要账号。",
      },
      {
        q: "CLI 的配对码能和 Relayium 的浏览器版互通吗？",
        a: "目前还不能实时配对传输——CLI 的 send/receive 用的是自己的直连握手协议，和浏览器基于 WebRTC 的配对流程不是一回事，两者暂不互通。如果只想用浏览器把文件交给对方，可以用 Relayium 的存储下载链接，或者浏览器版自己的配对码模式。",
      },
      {
        q: "可以自托管吗？",
        a: "可以。Relayium 的服务器以 Docker 镜像形式发布（docker compose up -d --build），你也可以用 --server https://your-domain 让 CLI 的 send/receive 指向你自己的实例——和自建 croc 中继是同样的思路。",
      },
    ],
  },
  cta: {
    text: "安装免费的 Relayium CLI，试试 push、sync 或 send——完全免费，上手速度不输 croc。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と croc の比較：ターミナルから暗号化転送",
  description:
    "Relayium と croc はどちらも無料・オープンソースで暗号化された CLI の P2P 転送ツールです。それぞれどこで優れているかを公平に比較します。",
  updatedLabel: "最終更新",
  lead: [
    "croc はターミナル間でファイルを送る、最も愛されているツールの一つです。短く覚えやすいコードフレーズ、PAKE による鍵交換、それだけでちゃんと動きます。Relayium CLI も同じ仕事を目指し、同じ考え方で作られています——無料、オープンソース、エンドツーエンドで暗号化されており、アカウントが要るのは send がペアリングコードを発行するときだけです。",
    "これは批判の記事ではありません。croc の評判はふさわしいものです。両者の共通点、Relayium CLI がすでに運用しているサーバーとも話せるために持つ追加の力、そして croc の方が正直シンプルな場合を、率直に比較します。",
  ],
  sections: [
    {
      heading: "Relayium と croc の共通点",
      body: [
        "まず重なる部分から。実はかなり多いです。どちらも一度インストールすれば済む小さな単一バイナリで、完全無料で有料プランはなく、寛容なライセンスでオープンソース化されているため、ファイルに触れるコードをすべて読むことができます。",
      ],
      bullets: [
        "両端しか知らない短いコードだけで、互いを見つけ鍵に合意できます。croc のコードはその場で決めるもの、Relayium のコードはサインイン済みの送信者のためにサーバーが発行するもので、受信側は依然としてアカウント不要です。",
        "転送中はエンドツーエンドで暗号化：間にあるリレーやランデブーポイントがファイルの中身を見ることは決してありません。",
        "中断した転送は最初からではなく続きから再開でき、届いたものが送ったものと一致することも両者とも検証します。",
        "クロスプラットフォーム：macOS、Linux、Windows。",
      ],
    },
    {
      heading: "SSH と daemon-direct：すでに運用しているサーバーと話す",
      body: [
        "ここが実用上いちばん大きな違いです。croc は一つの流れを中心に作られています——コードフレーズを入れて、コードフレーズを伝える。Relayium CLI は、すでに持っているインフラを活かす2つの方法をさらに追加しています。",
        "relayium push / pull は既存の SSH アクセスを再利用するため、新しく信頼するものも共有するコードもありません。push は relayium がまったくインストールされていないサーバーに対しても動作し、SSH 接続上の単純な tar ストリームにフォールバックします——このフォールバックは push 専用です。pull は常にリモートに relayium が必要です。そこでは pull が送信側として動作するためです。",
        "relayium serve は、所有する任意のマシンを daemon-direct のターゲットに変え、ピン留めされた TLS 1.3 経由で、SSH もコードフレーズもなしにアクセスできます——信頼は最初の接続時に成立し（対話的に承認するか、無人運用向けに事前承認しておく）、以後はピン留めされます。SSH のホスト鍵と同じ考え方です。",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "フォルダ同期と、二重に確認する検証コード",
      body: [
        "croc はファイルのバッチを送って終了します——相手側を更新するには再度送るしかなく、何を削除すべきかという概念もありません。Relayium CLI は relayium sync を追加し、上記どちらの転送方式の上でも動く増分の一方向ミラーリングを行います。変化した分だけを送り、--delete はソース側から消えたファイルを宛先側からも削除します（daemon は --allow-delete 付きで起動している場合のみこれに従うため、受信側が自らオプトインする必要があります）。--watch はファイルの変化に応じてリアルタイムに再同期し続け、cron ジョブは不要です。",
        "一回限りのネットワークをまたぐ転送では、relayium send / receive が croc のコードフレーズと同じ役割を果たし、短いコードで2台のコンピュータをペアリングします。直接の P2P で行われ、両端に短い検証コード（Short Authentication String）を表示するので、バイトが動き出す前に誰も間に入っていないことを目視で確認できます——正直に言うべき点として、このモードは直接接続専用なので、両端が直接経路を見つけられない場合はリレーにフォールバックせず、そのまま失敗します。",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "croc の方がシンプルな場合",
      body: ["croc の方がその仕事に向いている、本当のケースもあります。率直に述べる価値があります。"],
      bullets: [
        "今すぐ1つのファイルを友人に渡したいだけで、手間は最小限にしたい——到達すべきサーバーも不要で、両端で何かを設定する必要もありません。",
        "厳格な NAT の内側にいて直接経路を開く方法がない：croc のリレーはどのみち暗号化ストリームを運ぶので、転送はいずれにせよ完了します。Relayium の send / receive は直接接続専用で、その状況では失敗し得ます（push/pull や、到達可能なサーバーへの daemon-direct は直接 P2P のホップに依存しないため、引き続き使えます）。",
        "フォルダのミラーリングも SSH との統合も、長時間動き続けるリスナーも必要ない——croc は各端で1つの即席コマンドだけで、他に考えることはありません。",
        "croc の大きく成熟したコミュニティと長年の実運用実績をすでに信頼している。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "サーバーとの対話：Relayium は SSH アクセス（push/pull）またはピン留めされた TLS の daemon を再利用；croc には SSH との統合がなく、両端に croc をインストールしてコードフレーズを共有する必要があります。",
        "フォルダ同期：relayium sync は --delete と --watch を伴う増分ミラーリングを行う；croc はバッチを送って終了し、ミラーや削除の概念はありません。",
        "直接経路がない場合：croc のリレーは暗号化ストリームを運ぶので転送は完了する；Relayium の send/receive は直接接続専用です。",
        "検証：どちらもエンドツーエンドで暗号化される；Relayium の send/receive はさらに、転送開始前に双方が照合する短いコードを表示します。",
        "セルフホスト：どちらもセルフホスト可能——croc のリレーは小さな単独バイナリ；Relayium のサーバーはウェブアプリも動かしており、CLI の send/receive も --server で自分のインスタンスを指定できます。",
        "ライセンスと費用：どちらも AGPL-3.0 ライセンスで完全に無料です。croc はアカウントが一切不要、Relayium はペアリングコードを発行する send にだけ必要です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium の CLI は無料ですか？",
        a: "はい、完全に無料です。有料プランはなく、計測するものもありません——どのモードでも両端が直接つながり、CLI は AGPL-3.0 ライセンスでオープンソースです。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "send のときだけ必要です。push/pull は自分の SSH アクセスを使い、daemon-direct はマシン間のピン留めされた TLS 証明書の信頼を使うので、どちらも Relayium アカウントには触れません。send/receive は例外です。ペアリングコードを発行できるのはサーバーだけで、しかもサインイン済みのアカウントに対してだけなので、送信側は一度 relayium login を実行します。受信側にアカウントは決して必要ありません。",
      },
      {
        q: "CLI のペアリングコードは Relayium のブラウザ版と使えますか？",
        a: "現時点ではリアルタイムのペアリング転送はできません——CLI の send/receive は独自の直接ハンドシェイクを使っており、ブラウザの WebRTC ベースのペアリングフローとは別物なので、今は相互運用できません。ブラウザだけを使って相手にファイルを渡したい場合は、Relayium の保存型ダウンロードリンクか、ブラウザ版自体のペアリングコードモードを使ってください。",
      },
      {
        q: "セルフホストできますか？",
        a: "はい。Relayium のサーバーは Docker イメージとして配布されており（docker compose up -d --build）、CLI の send/receive も --server https://your-domain で自分のインスタンスを指定できます——自分で croc のリレーを運用するのと同じ発想です。",
      },
    ],
  },
  cta: {
    text: "無料の Relayium CLI をインストールして push、sync、send を試してみましょう——完全無料で、croc と同じくらいすぐに始められます。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs croc: 터미널에서 암호화 파일 전송",
  description:
    "Relayium과 croc은 둘 다 무료, 오픈소스, 암호화된 CLI P2P 전송 도구입니다. 각각 어디에서 더 나은지 공정하게 비교합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "croc은 터미널 사이에서 파일을 보내는 가장 사랑받는 도구 중 하나입니다. 짧고 기억하기 쉬운 코드 문구, PAKE 키 교환, 그리고 그것만으로 잘 작동합니다. Relayium CLI도 같은 일을 하려 하며, 만들어진 방식도 비슷합니다 — 무료, 오픈소스, 종단간 암호화되어 있으며 계정은 send가 페어링 코드를 발급할 때만 필요합니다.",
    "이 글은 깎아내리려는 것이 아닙니다. croc의 명성은 그럴 만합니다. 이 글은 두 도구가 공유하는 부분, Relayium CLI가 이미 운영 중인 서버와도 통신할 수 있어 더 갖춘 부분, 그리고 croc이 솔직히 더 단순한 선택인 경우를 있는 그대로 비교합니다.",
  ],
  sections: [
    {
      heading: "Relayium과 croc의 공통점",
      body: [
        "겹치는 부분부터 보면 상당히 많습니다. 둘 다 한 번만 설치하면 되는 작은 단일 바이너리이고, 둘 다 유료 등급 없이 완전히 무료이며, 둘 다 관대한 라이선스로 오픈소스이므로 파일과 관련된 모든 코드를 직접 읽어볼 수 있습니다.",
      ],
      bullets: [
        "양쪽만 아는 짧은 코드만으로 서로를 찾고 키에 합의하기에 충분합니다. croc의 코드는 그 자리에서 정하는 것이고, Relayium의 코드는 로그인한 보내는 쪽을 위해 서버가 발급하며, 받는 쪽은 여전히 계정이 필요 없습니다.",
        "전송 중 종단간 암호화: 중간의 릴레이나 랑데부 지점은 파일 내용을 절대 볼 수 없습니다.",
        "중단된 전송은 처음부터가 아니라 이어서 재개할 수 있고, 둘 다 도착한 내용이 보낸 것과 실제로 일치하는지 검증합니다.",
        "크로스 플랫폼: macOS, Linux, Windows.",
      ],
    },
    {
      heading: "SSH와 daemon-direct: 이미 운영 중인 서버와 대화하기",
      body: [
        "여기가 실용적으로 가장 큰 차이입니다. croc은 하나의 흐름을 중심으로 만들어졌습니다 — 코드 문구를 입력하고, 코드 문구를 전달하는 것. Relayium CLI는 여러분이 이미 가진 인프라를 활용하는 두 가지 방식을 더 제공합니다.",
        "relayium push / pull은 기존 SSH 접근 권한을 재사용하므로 새로 신뢰할 것도, 공유할 코드도 없습니다. push는 relayium이 전혀 설치되지 않은 서버에도 작동해, SSH 연결 위의 일반 tar 스트림으로 대체됩니다 — 이 대체 방식은 push에만 있습니다. pull은 항상 원격지에 relayium이 필요합니다. 그곳에서 pull이 송신자 역할을 하기 때문입니다.",
        "relayium serve는 소유한 어떤 기기든 daemon-direct 대상으로 바꿔주며, 고정된 TLS 1.3을 통해 SSH도 코드 문구도 없이 접근할 수 있게 합니다 — 신뢰는 첫 연결에서 성립하고(대화식으로 승인하거나, 무인 운영을 위해 미리 승인해 둘 수 있음) 이후로는 고정됩니다. SSH의 host key와 같은 발상입니다.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "폴더 동기화, 그리고 두 번 대조하는 검증 코드",
      body: [
        "croc은 파일 묶음을 보내고 종료합니다 — 상대 쪽을 갱신하려면 다시 보내야 하고, 무엇을 삭제해야 하는지에 대한 개념이 없습니다. Relayium CLI는 relayium sync를 더해, 위의 두 전송 방식 위에서 증분 단방향 미러링을 합니다. 변경된 것만 옮기고, --delete는 소스에서 사라진 파일을 대상에서도 삭제합니다(데몬은 --allow-delete로 시작된 경우에만 이를 따르므로, 수신 측이 직접 선택해야 합니다). --watch는 파일이 바뀔 때마다 실시간으로 계속 재동기화하며, cron 작업이 필요 없습니다.",
        "일회성 네트워크 간 전송에서는 relayium send / receive가 croc의 코드 문구와 같은 역할을 하며, 짧은 코드로 두 컴퓨터를 페어링합니다. 직접 P2P 방식이며, 바이트가 움직이기 전에 양쪽 모두에 짧은 검증 코드(Short Authentication String)를 표시해 중간에 아무도 없는지 눈으로 확인할 수 있게 합니다 — 솔직히 짚어야 할 점은, 이 모드는 직접 연결 전용이라 두 끝이 직접 경로를 찾지 못하면 릴레이로 대체되지 않고 그대로 실패한다는 것입니다.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "croc이 더 단순한 선택인 경우",
      body: ["croc이 실제로 그 일에 더 나은 도구인 경우도 있으며, 솔직히 말할 가치가 있습니다."],
      bullets: [
        "지금 당장 친구에게 파일 하나만 넘기고 싶고, 신경 쓸 것이 가장 적었으면 할 때 — 도달할 서버도 없고, 양쪽 어디에서도 설정할 것이 없습니다.",
        "엄격한 NAT 뒤에 있어 직접 경로를 열 방법이 없을 때: croc의 릴레이는 어쨌든 암호화된 스트림을 실어 나르므로 전송이 완료됩니다. Relayium의 send / receive는 직접 연결 전용이라 이런 상황에서 실패할 수 있습니다(push/pull이나 도달 가능한 서버로의 daemon-direct는 직접 P2P 홉에 의존하지 않으므로 여전히 작동합니다).",
        "폴더 미러링도, SSH 통합도, 계속 실행되는 리스너도 필요 없을 때 — croc은 각 쪽에서 즉석 명령어 하나면 충분하고 더 생각할 것이 없습니다.",
        "이미 croc의 크고 자리잡은 커뮤니티와 오랜 실사용 경험을 신뢰하고 있을 때.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "서버와의 대화: Relayium은 SSH 접근(push/pull) 또는 고정 TLS 데몬을 재사용; croc은 SSH 통합이 없어 양쪽에 croc을 설치하고 코드 문구를 공유해야 함.",
        "폴더 동기화: relayium sync는 --delete와 --watch로 증분 미러링; croc은 묶음을 보내고 종료하며 미러나 삭제 개념이 없음.",
        "직접 경로가 없을 때: croc의 릴레이는 암호화된 스트림을 실어 날라 전송이 여전히 완료됨; Relayium의 send/receive는 직접 연결 전용임.",
        "검증: 둘 다 종단간 암호화됨; Relayium의 send/receive는 추가로 전송 시작 전 양쪽이 대조하는 짧은 코드를 표시함.",
        "자체 호스팅: 둘 다 자체 호스팅 가능 — croc의 릴레이는 작은 독립 바이너리; Relayium의 서버는 웹 앱도 함께 운영하며, CLI의 send/receive도 --server로 자신의 인스턴스를 가리킬 수 있음.",
        "라이선스와 비용: 둘 다 AGPL-3.0 라이선스에 둘 다 완전 무료. croc은 계정이 전혀 필요 없고, Relayium은 페어링 코드를 발급하는 send에만 필요합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium의 CLI는 무료인가요?",
        a: "네, 완전히 무료입니다. 유료 등급이 없고 계량할 것도 없습니다 — 모든 모드가 양쪽을 직접 연결하며, CLI는 AGPL-3.0 라이선스로 오픈소스입니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "send만 그렇습니다. push/pull은 자신의 SSH 접근을 사용하고 daemon-direct는 기기 간 고정된 TLS 인증서 신뢰를 사용하므로 둘 다 Relayium 계정을 건드리지 않습니다. send/receive가 예외입니다. 페어링 코드는 서버만, 그것도 로그인된 계정에만 발급할 수 있으므로 보내는 쪽이 relayium login을 한 번 실행합니다. 받는 데는 계정이 전혀 필요 없습니다.",
      },
      {
        q: "CLI의 페어링 코드를 Relayium 브라우저 앱과 함께 쓸 수 있나요?",
        a: "아직 실시간 페어링 전송은 안 됩니다 — CLI의 send/receive는 자체 직접 핸드셰이크를 사용하며, 브라우저의 WebRTC 기반 페어링 흐름과는 별개라 현재는 상호 운용되지 않습니다. 브라우저만으로 상대에게 파일을 전달하려면 Relayium의 저장형 다운로드 링크나 브라우저 앱 자체의 페어링 코드 모드를 사용하세요.",
      },
      {
        q: "자체 호스팅할 수 있나요?",
        a: "네. Relayium의 서버는 Docker 이미지로 배포되며(docker compose up -d --build), CLI의 send/receive도 --server https://your-domain으로 자신의 인스턴스를 가리키게 할 수 있습니다 — 직접 croc 릴레이를 운영하는 것과 같은 발상입니다.",
      },
    ],
  },
  cta: {
    text: "무료 Relayium CLI를 설치하고 push, sync, send를 써보세요 — 완전 무료로, croc만큼 빠르게 시작할 수 있습니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. croc: verschlüsselte Dateiübertragung im Terminal",
  description:
    "Relayium und croc sind beide kostenlose, quelloffene, verschlüsselte CLI-Tools für Peer-to-Peer-Übertragung. Ein fairer, ehrlicher Vergleich, wo welches Tool besser passt.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "croc ist eines der beliebtesten Werkzeuge, um eine Datei von einem Terminal zum anderen zu schicken: eine kurze, einprägsame Code-Phrase, ein PAKE-Schlüsselaustausch, und es funktioniert einfach. Die Relayium CLI setzt sich dieselbe Aufgabe und ist ähnlich gebaut — kostenlos, quelloffen und Ende-zu-Ende verschlüsselt, wobei ein Konto nur nötig ist, damit send seinen Pairing-Code erzeugen kann.",
    "Das ist keine Abrechnung; croc hat sich seinen Ruf verdient. Dieser Artikel vergleicht ehrlich, was beide gemeinsam haben, wo die Relayium CLI mehr bietet, weil sie auch mit Servern spricht, die du bereits betreibst, und den Fall, in dem croc schlicht die einfachere Wahl ist.",
  ],
  sections: [
    {
      heading: "Was Relayium und croc gemeinsam haben",
      body: [
        "Beginnen wir mit der Überschneidung, denn sie ist erheblich: Beide sind kleine, einmal zu installierende Binaries, beide sind völlig kostenlos ohne bezahlte Stufe, und beide sind unter einer freizügigen Lizenz quelloffen, sodass du jede Zeile lesen kannst, die deine Dateien berührt.",
      ],
      bullets: [
        "Ein kurzer, nur den beiden Enden bekannter Code genügt, damit sie sich finden und auf einen Schlüssel einigen. crocs Code wird spontan ausgedacht; Relayiums wird von dessen Server für einen angemeldeten Absender erzeugt, und der Empfänger braucht weiterhin kein Konto.",
        "Ende-zu-Ende während der Übertragung verschlüsselt: Das Relay oder der Rendezvous-Punkt in der Mitte sieht nie den Inhalt deiner Datei.",
        "Unterbrochene Übertragungen können fortgesetzt statt neu gestartet werden, und beide prüfen, dass das Angekommene wirklich dem Gesendeten entspricht.",
        "Plattformübergreifend: macOS, Linux und Windows.",
      ],
    },
    {
      heading: "SSH und daemon-direct: mit einem Server sprechen, den du bereits betreibst",
      body: [
        "Das ist der größte praktische Unterschied. croc ist um einen einzigen Ablauf herum gebaut — Code-Phrase eingeben, Code-Phrase weitergeben. Die Relayium CLI fügt zwei weitere Wege hinzu, Dateien zu bewegen, die sich auf Infrastruktur stützen, die du bereits hast.",
        "relayium push / pull nutzt deinen bestehenden SSH-Zugang, also gibt es nichts Neues zu vertrauen und keinen Code zu teilen. push funktioniert sogar gegen einen Server ohne installiertes relayium und fällt dann auf einen einfachen tar-Stream über die SSH-Verbindung zurück — dieser Fallback existiert nur bei push; pull braucht immer relayium auf der Gegenseite, da es dort als Absender agiert.",
        "relayium serve macht aus jeder Maschine, die dir gehört, ein daemon-direct-Ziel, erreichbar über gepinntes TLS 1.3, ohne SSH und ohne Code-Phrase — Vertrauen entsteht bei der ersten Verbindung (interaktiv bestätigt oder für unbeaufsichtigten Betrieb vorab autorisiert) und ist danach gepinnt, dieselbe Idee wie ein SSH-Host-Key.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Ordner-Sync und ein Code, den du zweimal prüfst",
      body: [
        "croc sendet eine Reihe von Dateien und beendet sich dann — um die Gegenseite zu aktualisieren, musst du erneut senden, ein Konzept, was gelöscht werden soll, gibt es nicht. Die Relayium CLI fügt relayium sync hinzu, einen inkrementellen Einweg-Spiegel über einen der beiden obigen Transportwege: Es bewegt nur, was sich geändert hat; --delete entfernt Dateien am Ziel, die auf der Quelle verschwunden sind (ein Daemon befolgt das nur, wenn er mit --allow-delete gestartet wurde, der Empfänger muss also selbst zustimmen); --watch synchronisiert bei Dateiänderungen laufend in Echtzeit neu, kein Cron-Job nötig.",
        "Für eine einmalige netzwerkübergreifende Übertragung spielt relayium send / receive dieselbe Rolle wie crocs Code-Phrase und koppelt zwei Rechner über einen kurzen Code. Es ist direktes Peer-to-Peer und zeigt auf beiden Seiten einen kurzen Prüfcode (einen Short Authentication String), sodass du vor dem ersten übertragenen Byte visuell bestätigen kannst, dass niemand dazwischensitzt — ehrlich anzumerken: Dieser Modus ist rein direkt, findet er keinen direkten Pfad, schlägt die Übertragung fehl, statt auf ein Relay auszuweichen.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Wann croc die einfachere Wahl ist",
      body: ["Es gibt echte Fälle, in denen croc das bessere Werkzeug für die Aufgabe ist, und das sollte man klar sagen."],
      bullets: [
        "Du willst gerade nur einer Freundin oder einem Freund eine Datei zukommen lassen, mit möglichst wenigen beweglichen Teilen — kein Server, den du erreichen musst, nichts, das auf einer der beiden Seiten eingerichtet werden muss.",
        "Du sitzt hinter einem strengen NAT ohne Möglichkeit, einen direkten Pfad zu öffnen: crocs Relay trägt den verschlüsselten Datenstrom trotzdem, sodass die Übertragung so oder so abgeschlossen wird. Relayiums send / receive ist rein direkt und kann in dieser Situation fehlschlagen (push/pull oder daemon-direct zu einem erreichbaren Server funktionieren weiterhin, da sie nicht von einem direkten P2P-Hop abhängen).",
        "Du brauchst keine Ordnerspiegelung, keine SSH-Integration und keinen dauerhaft laufenden Listener — croc ist auf jeder Seite ein einziger Ad-hoc-Befehl, und sonst gibt es nichts zu bedenken.",
        "Du vertraust bereits crocs großer, etablierter Community und jahrelanger Praxiserfahrung.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Mit einem Server sprechen: Relayium nutzt deinen SSH-Zugang (push/pull) oder einen gepinnten TLS-Daemon; croc hat keine SSH-Integration — installiere croc auf beiden Seiten und teile eine Code-Phrase.",
        "Ordner-Sync: relayium sync spiegelt inkrementell mit --delete und --watch; croc sendet eine Reihe und beendet sich, ohne Spiegel- oder Löschsemantik.",
        "Kein direkter Pfad verfügbar: crocs Relay trägt den verschlüsselten Datenstrom, sodass die Übertragung trotzdem abgeschlossen wird; Relayiums send/receive ist rein direkt.",
        "Verifikation: Beide sind Ende-zu-Ende verschlüsselt; Relayiums send/receive zeigt zusätzlich einen kurzen Code, den beide Seiten vor Übertragungsbeginn vergleichen.",
        "Selbst hosten: Beide sind selbst hostbar — crocs Relay ist ein kleines eigenständiges Binary; Relayiums Server betreibt auch die Web-App, und die send/receive-Funktion der CLI kann mit --server auf deine eigene Instanz zeigen.",
        "Lizenz und Kosten: Beide AGPL-3.0-lizenziert und beide völlig kostenlos. croc braucht überhaupt kein Konto; Relayium nur für send, um den Pairing-Code zu erzeugen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist Relayiums CLI kostenlos?",
        a: "Ja, vollständig. Es gibt keine bezahlte Stufe und nichts zu messen — jeder Modus verbindet die beiden Enden direkt, und die CLI ist AGPL-3.0-lizenziert und quelloffen.",
      },
      {
        q: "Braucht sie ein Konto?",
        a: "Nur send. push/pull nutzt deinen eigenen SSH-Zugang und daemon-direct nutzt gepinntes TLS-Zertifikatsvertrauen zwischen deinen Maschinen, beides berührt also kein Relayium-Konto. send/receive ist die Ausnahme: Einen Pairing-Code kann nur der Server erzeugen, und nur für ein angemeldetes Konto, also führt der Absender einmal relayium login aus. Zum Empfangen braucht es nie ein Konto.",
      },
      {
        q: "Kann ich den Pairing-Code der CLI mit Relayiums Browser-App nutzen?",
        a: "Noch nicht für eine gekoppelte Live-Übertragung — send/receive der CLI nutzt einen eigenen, direkten Handshake, getrennt vom WebRTC-basierten Pairing-Ablauf des Browsers, sodass beide heute nicht zusammenarbeiten. Um jemandem nur per Browser eine Datei zu übergeben, nutze Relayiums gespeicherten Download-Link oder den eigenen Pairing-Code-Modus der Browser-App.",
      },
      {
        q: "Kann ich sie selbst hosten?",
        a: "Ja. Relayiums Server wird als Docker-Image ausgeliefert (docker compose up -d --build), und du kannst send/receive der CLI mit --server https://your-domain auf deine eigene Instanz zeigen lassen — derselbe Gedanke wie beim Betrieb eines eigenen croc-Relays.",
      },
    ],
  },
  cta: {
    text: "Installiere die kostenlose Relayium CLI und probiere push, sync oder send — kostenlos, und genauso schnell startklar wie croc.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs croc : transfert de fichiers chiffré en terminal",
  description:
    "Relayium et croc sont deux outils CLI gratuits, open source et chiffrés pour le transfert pair-à-pair. Un comparatif honnête de leurs forces respectives.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "croc est l'un des outils les plus appréciés pour envoyer un fichier d'un terminal à un autre : une courte phrase-code facile à retenir, un échange de clés PAKE, et ça marche tout simplement. La CLI Relayium vise le même objectif et est construite dans le même esprit — gratuite, open source, chiffrée de bout en bout, un compte n'étant requis que pour que send puisse générer son code d'appairage.",
    "Ceci n'est pas un dénigrement ; la réputation de croc est méritée. Cet article compare franchement ce que partagent les deux outils, là où la CLI Relayium fait plus parce qu'elle sait aussi parler à des serveurs que vous exploitez déjà, et le cas où croc est honnêtement le choix le plus simple.",
  ],
  sections: [
    {
      heading: "Ce que Relayium et croc ont en commun",
      body: [
        "Commençons par ce qui se recoupe, et c'est substantiel : les deux sont de petits binaires uniques à installer une fois, tous deux entièrement gratuits sans palier payant, et tous deux open source sous une licence permissive, si bien que vous pouvez lire chaque ligne qui touche à vos fichiers.",
      ],
      bullets: [
        "Un court code connu des deux seules extrémités suffit pour qu'elles se trouvent et s'accordent sur une clé. Celui de croc s'invente sur le moment ; celui de Relayium est généré par son serveur pour un expéditeur connecté, et le destinataire n'a toujours besoin d'aucun compte.",
        "Chiffré de bout en bout pendant le transfert : le relais ou le point de rendez-vous au milieu ne voit jamais le contenu de votre fichier.",
        "Les transferts interrompus peuvent reprendre au lieu de repartir de zéro, et les deux vérifient que ce qui est arrivé correspond bien à ce qui a été envoyé.",
        "Multiplateforme : macOS, Linux et Windows.",
      ],
    },
    {
      heading: "SSH et daemon-direct : parler à un serveur que vous exploitez déjà",
      body: [
        "C'est la plus grande différence pratique. croc est construit autour d'un seul flux — entrer la phrase-code, transmettre la phrase-code. La CLI Relayium ajoute deux autres façons de déplacer des fichiers qui s'appuient sur une infrastructure que vous possédez déjà.",
        "relayium push / pull réutilise votre accès SSH existant, donc rien de nouveau à faire confiance et aucun code à partager. push fonctionne même contre un serveur sans relayium installé, en basculant sur un simple flux tar via la connexion SSH — ce repli n'existe que pour push ; pull a toujours besoin de relayium sur la machine distante, puisqu'il y joue le rôle d'expéditeur.",
        "relayium serve transforme n'importe quelle machine que vous possédez en cible daemon-direct, accessible via TLS 1.3 épinglé, sans SSH ni phrase-code — la confiance s'établit à la première connexion (approuvée de façon interactive, ou pré-autorisée pour un usage sans surveillance) puis reste épinglée ensuite, la même idée qu'une clé d'hôte SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Synchronisation de dossiers, et un code de vérification à comparer deux fois",
      body: [
        "croc envoie un lot de fichiers puis se termine — pour mettre à jour l'autre côté, il faut renvoyer, sans aucune notion de ce qui devrait être supprimé. La CLI Relayium ajoute relayium sync, un miroir incrémental à sens unique sur l'un ou l'autre des transports ci-dessus : il ne déplace que ce qui a changé ; --delete supprime sur la destination les fichiers disparus de la source (un daemon ne le respecte que s'il a été lancé avec --allow-delete, le destinataire doit donc explicitement l'accepter) ; --watch continue de resynchroniser en temps réel à chaque changement, sans tâche cron nécessaire.",
        "Pour un transfert ponctuel entre réseaux différents, relayium send / receive joue le même rôle que la phrase-code de croc, en appairant deux ordinateurs par un court code. C'est du pair-à-pair direct, et un court code de vérification (un Short Authentication String) s'affiche des deux côtés pour confirmer visuellement, avant que le moindre octet ne bouge, que personne ne s'est glissé au milieu — à noter honnêtement : ce mode est exclusivement direct, donc si les deux extrémités ne trouvent pas de chemin direct, le transfert échoue plutôt que de basculer vers un relais.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Quand croc est le choix le plus simple",
      body: ["Il existe de vrais cas où croc est le meilleur outil pour la tâche, et il vaut la peine de le dire clairement."],
      bullets: [
        "Vous voulez juste remettre un fichier à un ami là, maintenant, avec le moins d'étapes possible — aucun serveur à joindre, rien à configurer d'un côté comme de l'autre.",
        "Vous êtes derrière un NAT strict sans moyen d'ouvrir un chemin direct : le relais de croc transporte quand même le flux chiffré, si bien que le transfert aboutit dans tous les cas. Le send / receive de Relayium est exclusivement direct et peut échouer dans cette situation (push/pull ou daemon-direct vers un serveur joignable fonctionnent toujours, car ils ne dépendent pas d'un saut P2P direct).",
        "Vous n'avez besoin ni de miroir de dossier, ni d'intégration SSH, ni d'un écouteur qui tourne en permanence — croc n'est qu'une commande ponctuelle de chaque côté, sans rien d'autre à gérer.",
        "Vous faites déjà confiance à la grande communauté établie de croc et à ses années d'usage réel.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "Parler à un serveur : Relayium réutilise votre accès SSH (push/pull) ou un daemon TLS épinglé ; croc n'a aucune intégration SSH — installez croc des deux côtés et partagez une phrase-code.",
        "Synchronisation de dossiers : relayium sync fait un miroir incrémental avec --delete et --watch ; croc envoie un lot puis se termine, sans sémantique de miroir ni de suppression.",
        "Aucun chemin direct disponible : le relais de croc transporte le flux chiffré, si bien que le transfert aboutit quand même ; le send/receive de Relayium est exclusivement direct.",
        "Vérification : les deux sont chiffrés de bout en bout ; le send/receive de Relayium affiche en plus un court code que les deux parties comparent avant le début du transfert.",
        "Auto-hébergement : les deux sont auto-hébergeables — le relais de croc est un petit binaire autonome ; le serveur de Relayium fait aussi tourner l'application web, et le send/receive de la CLI peut pointer vers votre propre instance avec --server.",
        "Licence et coût : les deux sous licence AGPL-3.0 et tous deux entièrement gratuits. croc ne nécessite aucun compte ; Relayium n'en demande un que pour send, afin de générer le code d'appairage.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La CLI Relayium est-elle gratuite ?",
        a: "Oui, entièrement. Il n'y a aucun palier payant et rien à mesurer — chaque mode connecte directement les deux extrémités, et la CLI est sous licence AGPL-3.0 et open source.",
      },
      {
        q: "A-t-elle besoin d'un compte ?",
        a: "Seul send. push/pull utilise votre propre accès SSH et daemon-direct utilise une confiance par certificat TLS épinglé entre vos machines, donc ni l'un ni l'autre ne touche un compte Relayium. send/receive fait exception : seul le serveur peut générer un code de jumelage, et seulement pour un compte connecté, donc l'expéditeur lance une fois relayium login. Recevoir ne nécessite jamais de compte.",
      },
      {
        q: "Puis-je utiliser le code d'appairage de la CLI avec l'application web de Relayium ?",
        a: "Pas encore pour un transfert appairé en direct — le send/receive de la CLI utilise sa propre poignée de main directe, distincte du flux d'appairage du navigateur basé sur WebRTC, donc les deux n'interopèrent pas aujourd'hui. Pour remettre un fichier à quelqu'un via un simple navigateur, utilisez le lien de téléchargement stocké de Relayium ou le mode par code d'appairage propre à l'application web.",
      },
      {
        q: "Puis-je l'auto-héberger ?",
        a: "Oui. Le serveur de Relayium est distribué sous forme d'image Docker (docker compose up -d --build), et vous pouvez pointer le send/receive de la CLI vers votre propre instance avec --server https://your-domain — le même esprit que faire tourner votre propre relais croc.",
      },
    ],
  },
  cta: {
    text: "Installez la CLI Relayium gratuite et essayez push, sync ou send — gratuit, et tout aussi rapide à démarrer que croc.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل croc: نقل ملفات مُشفَّر من الطرفية",
  description:
    "كلٌّ من Relayium وcroc أداتا سطر أوامر مجانيتان ومفتوحتا المصدر ومُشفَّرتان لنقل الملفات من الند للند. مقارنة منصفة وصادقة تُبيّن أين يكون كلٌّ منهما الأنسب.",
  updatedLabel: "آخر تحديث",
  lead: [
    "croc من أحبّ الأدوات لإرسال ملف من طرفية إلى أخرى: عبارة رمزية قصيرة يسهل تذكّرها، وتبادل مفاتيح PAKE، ثم يعمل ببساطة. وتضع واجهة Relayium على سطر الأوامر لنفسها المهمّة ذاتها وهي مبنية بالطريقة نفسها — مجانية ومفتوحة المصدر ومُشفَّرة من الطرف إلى الطرف، ولا يلزم الحساب إلا كي يُصدر send رمز الاقتران الخاص به.",
    "هذه ليست محاولة إسقاط؛ فقد استحقّ croc سمعته. إنها مقارنة مباشرة لِما يشترك فيه الاثنان، وأين تفعل واجهة Relayium أكثر لأنها تتحدّث أيضًا إلى خوادم تُشغّلها أصلاً، والحالة التي يكون فيها croc بصدق الخيار الأبسط.",
  ],
  sections: [
    {
      heading: "ما الذي يشترك فيه Relayium وcroc",
      body: [
        "لنبدأ بما يتقاطعان فيه، فهو كثير: كلاهما ملف تنفيذي صغير واحد تُثبّته مرّة واحدة، وكلاهما مجاني تمامًا بلا فئة مدفوعة، وكلاهما مفتوح المصدر برخصة متساهلة تتيح لك قراءة كل سطر يمسّ ملفاتك.",
      ],
      bullets: [
        "رمز قصير لا يعرفه إلا الطرفان يكفي كي يجد كلٌّ منهما الآخر ويتّفقا على مفتاح. رمز croc يُبتكَر في حينه، أما رمز Relayium فيُصدره خادمه لمُرسِل مسجَّل الدخول، ويظل المُستقبِل بلا حاجة إلى حساب.",
        "مُشفَّر أثناء النقل من الطرف إلى الطرف: لا يرى المُرحِّل أو نقطة اللقاء في المنتصف محتوى ملفك أبدًا.",
        "يمكن لعمليات النقل المنقطعة أن تُستأنف بدلاً من البدء من جديد، وكلاهما يتحقّق من أنّ ما وصل يطابق فعلاً ما أُرسل.",
        "متعدّد المنصّات: macOS وLinux وWindows.",
      ],
    },
    {
      heading: "SSH وdaemon-direct: التحدّث إلى خادم تُشغّله أصلاً",
      body: [
        "هذا هو الفرق العملي الأكبر. croc مبني حول تدفّق واحد — عبارة رمزية تدخل، وعبارة رمزية تخرج. وتضيف واجهة Relayium طريقتين أخريين لنقل الملفات تعتمدان على بنية تحتية لديك أصلاً.",
        "relayium push / pull تعيد استخدام وصول SSH الموجود لديك، فلا شيء جديد تثق به ولا رمز تشاركه. وتعمل push حتى مع خادم لا يوجد عليه relayium مثبّت على الإطلاق، متراجعةً إلى تدفّق tar عادي عبر اتصال SSH — وهذا التراجع خاص بـ push فقط؛ أمّا pull فتحتاج دائمًا إلى relayium على الجهاز البعيد، لأنها تعمل هناك بصفتها المُرسِل.",
        "relayium serve تحوّل أي جهاز تملكه إلى هدف daemon-direct، يمكن الوصول إليه عبر TLS 1.3 مثبّت دون SSH ودون عبارة رمزية — تُبنى الثقة عند الاتصال الأول (تُوافَق عليها تفاعليًّا، أو يُصرَّح بها مسبقًا للاستخدام دون إشراف) وتُثبَّت من حينها، وهي الفكرة ذاتها كمفتاح مضيف SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "مزامنة المجلدات ورمز تحقق تُدقّقه مرّتين",
      body: [
        "يُرسل croc دفعةً من الملفات ثم يخرج — أرسِلها ثانيةً لتحديث الطرف الآخر، دون أي مفهوم لما ينبغي حذفه. وتضيف واجهة Relayium أمر relayium sync، وهو مرآة تزايدية أحادية الاتجاه فوق أيٍّ من وسيلتَي النقل أعلاه: لا ينقل إلا ما تغيّر، و‏--delete يحذف من الوجهة الملفات التي اختفت من المصدر (لا يحترمه الـ daemon إلا إذا بدأ بـ --allow-delete، فعلى المُستقبِل أن يوافق صراحةً)، و‏--watch يُبقي المزامنة تتكرّر آنيًّا مع تغيّر الملفات، دون الحاجة إلى مهمّة cron.",
        "أمّا للنقل العابر للشبكات لمرّة واحدة، فإنّ relayium send / receive يؤدّي الدور نفسه الذي تؤدّيه عبارة croc الرمزية، إذ يقرن حاسوبين برمز قصير. وهو من الند للند مباشرةً، ويطبع رمز تحقق قصيرًا (سلسلة مصادقة قصيرة) على الطرفين كي تؤكّد بصريًّا أنّ لا أحد جلس في المنتصف قبل أن تتحرّك أي بايتات — ويجدر قول هذا بصدق: هذا الوضع مباشر فقط، فإذا لم يجد الطرفان مسارًا مباشرًا فشل بدلاً من التراجع إلى مُرحِّل.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "متى يكون croc الخيار الأبسط",
      body: [
        "هناك حالات حقيقية يكون فيها croc الأداة الأنسب للمهمّة، ويستحقّ الأمر أن يُقال بوضوح.",
      ],
      bullets: [
        "تريد فقط تسليم ملف واحد لصديق الآن بأقلّ قدر من الأجزاء المتحرّكة — لا خادم للوصول إليه، ولا شيء لإعداده على أي من الطرفين.",
        "أنت خلف NAT صارم دون سبيل لفتح مسار مباشر: يحمل مُرحِّل croc التدفّق المُشفَّر على أي حال، فيكتمل النقل في كلتا الحالتين. أمّا send / receive في Relayium فمباشر فقط وقد يفشل في هذا الموقف (push/pull أو daemon-direct إلى خادم يمكن الوصول إليه لا تزال تعمل، لأنها لا تعتمد على قفزة P2P مباشرة).",
        "لا تحتاج إلى مرآة مجلدات ولا تكامل SSH ولا مُستمِع طويل الأمد — croc أمر عابر واحد لكل طرف ولا شيء آخر تفكّر فيه.",
        "أنت تثق أصلاً بمجتمع croc الكبير الراسخ وسنوات استخدامه في الواقع العملي.",
      ],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: ["أهمّ الفروق جنبًا إلى جنب:"],
      bullets: [
        "التحدّث إلى خادم: يعيد Relayium استخدام وصول SSH لديك (push/pull) أو daemon بـ TLS مثبّت؛ أمّا croc فليس لديه تكامل SSH — ثبّت croc على الطرفين وشارِك عبارة رمزية.",
        "مزامنة المجلدات: relayium sync يعكس تزايديًّا مع --delete و--watch؛ أمّا croc فيُرسل دفعةً ثم يخرج، دون دلالات مرآة أو حذف.",
        "لا مسار مباشر متاح: يحمل مُرحِّل croc التدفّق المُشفَّر فيكتمل النقل رغم ذلك؛ أمّا send/receive في Relayium فمباشر فقط.",
        "التحقّق: كلاهما مُشفَّر من الطرف إلى الطرف؛ ويطبع send/receive في Relayium إضافةً إلى ذلك رمزًا قصيرًا يقارنه الطرفان قبل بدء النقل.",
        "الاستضافة الذاتية: كلاهما قابل للاستضافة الذاتية — مُرحِّل croc ملف تنفيذي مستقلّ صغير؛ وخادم Relayium يُشغّل أيضًا تطبيق الويب، ويمكن لِـ send/receive في الواجهة أن يشير إلى نسختك الخاصة بـ --server.",
        "الرخصة والتكلفة: كلاهما مرخّص بـ AGPL-3.0، وكلاهما مجاني تمامًا. لا يحتاج croc حسابًا إطلاقًا، أما Relayium فيحتاجه لـ send فقط، كي يُصدر رمز الاقتران.",
      ],
    },
  ],
  faq: {
    heading: "أسئلة شائعة",
    items: [
      {
        q: "هل واجهة Relayium على سطر الأوامر مجانية؟",
        a: "نعم، مجانية تمامًا. لا فئة مدفوعة ولا شيء يُقاس — كل وضع يوصل الطرفين مباشرةً، والواجهة مرخّصة بـ AGPL-3.0 ومفتوحة المصدر.",
      },
      {
        q: "هل تحتاج إلى حساب؟",
        a: "‏send وحده. push/pull تستخدم وصول SSH الخاص بك، وdaemon-direct يستخدم ثقة شهادة TLS المثبّتة بين أجهزتك، فلا يمسّ أيٌّ منهما حساب Relayium. أما send/receive فهو الاستثناء: لا يستطيع إصدار رمز الاقتران إلا الخادم، ولحساب مسجَّل الدخول فقط، لذا يشغّل المُرسِل relayium login مرة واحدة. أما الاستقبال فلا يحتاج حسابًا أبدًا.",
      },
      {
        q: "هل يمكنني استخدام رمز الاقتران في الواجهة مع تطبيق Relayium في المتصفّح؟",
        a: "ليس بعد لنقل مقترن مباشر — يستخدم send/receive في الواجهة مصافحته المباشرة الخاصة، منفصلةً عن تدفّق الاقتران في المتصفّح المبني على WebRTC، فلا يتفاهم الاثنان اليوم. ولتسليم ملف لشخص يستخدم المتصفّح فقط، استخدِم رابط التنزيل المُخزَّن في Relayium أو وضع رمز الاقتران الخاص بتطبيق المتصفّح.",
      },
      {
        q: "هل يمكنني استضافته ذاتيًّا؟",
        a: "نعم. يُوزَّع خادم Relayium كصورة Docker ‏(docker compose up -d --build)، ويمكنك توجيه send/receive في الواجهة إلى نسختك الخاصة بـ --server https://your-domain — بالروح نفسها لتشغيل مُرحِّل croc خاص بك.",
      },
    ],
  },
  cta: {
    text: "ثبّت واجهة Relayium المجانية على سطر الأوامر وجرّب push أو sync أو send — مجاناً تماماً، وبسرعة بدء لا تقلّ عن croc.",
    button: "احصل على الأداة",
    href: "/cli",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Relayium vs croc: transferencia de archivos cifrada desde la terminal",
  description:
    "Relayium y croc son herramientas CLI gratuitas, de código abierto y cifradas para la transferencia de archivos de igual a igual. Una comparación justa y honesta de dónde encaja mejor cada una.",
  updatedLabel: "Última actualización",
  lead: [
    "croc es una de las herramientas más queridas para enviar un archivo de una terminal a otra: una frase-código corta y fácil de recordar, un intercambio de claves PAKE, y simplemente funciona. La CLI de Relayium se propone hacer el mismo trabajo y está construida de la misma manera — gratis, de código abierto y cifrada de extremo a extremo, y solo hace falta cuenta para que send genere su código de emparejamiento.",
    "Esto no es un ataque; croc se ganó su reputación. Es una comparación directa de lo que ambas comparten, de dónde la CLI de Relayium hace más porque también habla con servidores que ya tienes en marcha, y del caso en que croc es, con honestidad, la opción más sencilla.",
  ],
  sections: [
    {
      heading: "Lo que Relayium y croc tienen en común",
      body: [
        "Empecemos por lo que se solapa, porque es considerable: ambas son un único binario pequeño que instalas una vez, ambas son completamente gratis sin ningún nivel de pago, y ambas son de código abierto bajo una licencia permisiva, así que puedes leer cada línea que toca tus archivos.",
      ],
      bullets: [
        "Un código corto que solo conocen los dos extremos basta para que se encuentren y acuerden una clave. El de croc se inventa en el momento; el de Relayium lo genera su servidor para un remitente con sesión iniciada, y el receptor sigue sin necesitar cuenta.",
        "Cifrado de extremo a extremo en tránsito: el retransmisor o punto de encuentro en medio nunca ve el contenido de tu archivo.",
        "Las transferencias interrumpidas pueden retomarse en lugar de empezar de nuevo, y ambas verifican que lo que llegó coincide realmente con lo que se envió.",
        "Multiplataforma: macOS, Linux y Windows.",
      ],
    },
    {
      heading: "SSH y daemon-direct: hablar con un servidor que ya tienes en marcha",
      body: [
        "Esta es la mayor diferencia práctica. croc está construido en torno a un único flujo — introduces la frase-código, entregas la frase-código. La CLI de Relayium añade dos formas más de mover archivos que se apoyan en infraestructura que ya tienes.",
        "relayium push / pull reutiliza tu acceso SSH existente, así que no hay nada nuevo en lo que confiar ni código que compartir. push funciona incluso contra un servidor sin relayium instalado en absoluto, recurriendo a un simple flujo tar sobre la conexión SSH — ese respaldo es solo para push; pull siempre necesita relayium en el remoto, ya que allí actúa como el remitente.",
        "relayium serve convierte cualquier máquina que poseas en un objetivo daemon-direct, accesible sobre TLS 1.3 fijado sin SSH ni frase-código — la confianza se establece en la primera conexión (aprobada de forma interactiva, o preautorizada para uso desatendido) y queda fijada a partir de entonces, la misma idea que una clave de host SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Sincronización de carpetas y un código de verificación que compruebas dos veces",
      body: [
        "croc envía un lote de archivos y termina — envíalo otra vez para actualizar el otro lado, sin ninguna noción de qué debería eliminarse. La CLI de Relayium añade relayium sync, un espejo incremental de un solo sentido sobre cualquiera de los dos transportes anteriores: solo mueve lo que cambió, --delete elimina en el destino los archivos que desaparecieron del origen (un daemon solo lo respeta si se inició con --allow-delete, así que un receptor tiene que optar por ello), y --watch mantiene la resincronización en tiempo real a medida que los archivos cambian, sin necesidad de una tarea cron.",
        "Para una transferencia puntual entre redes, relayium send / receive cumple el mismo papel que la frase-código de croc, emparejando dos ordenadores con un código corto. Es de igual a igual directo, e imprime un código de verificación corto (una Short Authentication String) en ambos extremos para que confirmes visualmente que nadie se interpuso antes de que se mueva ningún byte — vale la pena señalarlo con honestidad: este modo es solo directo, así que si los dos extremos no encuentran un camino directo, falla en lugar de recurrir a un retransmisor.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Cuándo croc es la opción más sencilla",
      body: [
        "Hay casos reales en los que croc es la mejor herramienta para el trabajo, y vale la pena decirlo claramente.",
      ],
      bullets: [
        "Solo quieres entregar un archivo a un amigo ahora mismo con las menos piezas móviles posibles — ningún servidor al que llegar, nada que configurar en ninguno de los dos extremos.",
        "Estás detrás de un NAT estricto sin forma de abrir un camino directo: el retransmisor de croc lleva el flujo cifrado de todos modos, así que la transferencia se completa igualmente. El send / receive de Relayium es solo directo y puede fallar en esa situación (push/pull o daemon-direct hacia un servidor accesible siguen funcionando, ya que no dependen de un salto P2P directo).",
        "No necesitas replicación de carpetas, integración con SSH ni un escuchador de larga duración — croc es un único comando ad hoc por cada extremo y nada más en lo que pensar.",
        "Ya confías en la comunidad grande y consolidada de croc y en sus años de uso en el mundo real.",
      ],
    },
    {
      heading: "Comparación de funciones de un vistazo",
      body: ["Las diferencias que más importan, una al lado de la otra:"],
      bullets: [
        "Hablar con un servidor: Relayium reutiliza tu acceso SSH (push/pull) o un daemon con TLS fijado; croc no tiene integración con SSH — instala croc en ambos extremos y comparte una frase-código.",
        "Sincronización de carpetas: relayium sync replica de forma incremental con --delete y --watch; croc envía un lote y termina, sin semántica de espejo ni de borrado.",
        "Sin camino directo disponible: el retransmisor de croc lleva el flujo cifrado, así que la transferencia se completa igualmente; el send/receive de Relayium es solo directo.",
        "Verificación: ambas van cifradas de extremo a extremo; el send/receive de Relayium además imprime un código corto que ambos lados comparan antes de que empiece la transferencia.",
        "Autoalojamiento: ambas son autoalojables — el retransmisor de croc es un pequeño binario independiente; el servidor de Relayium también ejecuta la aplicación web, y el send/receive de la CLI puede apuntar al tuyo propio con --server.",
        "Licencia y coste: ambas con licencia AGPL-3.0 y ambas completamente gratis. croc no requiere cuenta alguna; Relayium solo la requiere para send, para generar el código de emparejamiento.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿La CLI de Relayium es gratis?",
        a: "Sí, por completo. No hay ningún nivel de pago ni nada que medir — cada modo conecta los dos extremos directamente, y la CLI tiene licencia AGPL-3.0 y es de código abierto.",
      },
      {
        q: "¿Necesita cuenta?",
        a: "Solo send. push/pull usa tu propio acceso SSH y daemon-direct usa la confianza por certificado TLS fijado entre tus máquinas, así que ninguno toca una cuenta de Relayium. send/receive es la excepción: solo el servidor puede generar un código de emparejamiento, y solo para una cuenta con sesión iniciada, así que quien envía ejecuta relayium login una vez. Recibir nunca necesita cuenta.",
      },
      {
        q: "¿Puedo usar el código de emparejamiento de la CLI con la aplicación de navegador de Relayium?",
        a: "Todavía no para una transferencia emparejada en vivo — el send/receive de la CLI usa su propio apretón de manos directo, aparte del flujo de emparejamiento del navegador basado en WebRTC, así que hoy los dos no interoperan. Para entregar un archivo a alguien usando solo un navegador, usa el enlace de descarga almacenado de Relayium o el modo de código de emparejamiento propio de la aplicación de navegador.",
      },
      {
        q: "¿Puedo autoalojarlo?",
        a: "Sí. El servidor de Relayium se distribuye como imagen Docker (docker compose up -d --build), y puedes apuntar el send/receive de la CLI a tu propia instancia con --server https://your-domain — el mismo espíritu que ejecutar tu propio retransmisor de croc.",
      },
    ],
  },
  cta: {
    text: "Instala la CLI gratuita de Relayium y prueba push, sync o send — totalmente gratis, y tan rápida de empezar como croc.",
    button: "Consigue la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs croc: transferência de arquivos criptografada do terminal",
  description:
    "Relayium e croc são ferramentas de linha de comando gratuitas, de código aberto e criptografadas para transferência de arquivos ponto a ponto. Uma comparação justa e honesta de onde cada uma se encaixa melhor.",
  updatedLabel: "Última atualização",
  lead: [
    "croc é uma das ferramentas mais queridas para enviar um arquivo de um terminal a outro: uma frase-código curta e fácil de lembrar, uma troca de chaves PAKE, e simplesmente funciona. A CLI do Relayium se propõe a fazer o mesmo trabalho e é construída da mesma forma — gratuita, de código aberto e criptografada de ponta a ponta, e só é preciso conta para que o send gere o seu código de emparelhamento.",
    "Isto não é um ataque; croc conquistou sua reputação. É uma comparação direta do que as duas compartilham, de onde a CLI do Relayium faz mais porque também conversa com servidores que você já mantém, e do caso em que croc é, sinceramente, a escolha mais simples.",
  ],
  sections: [
    {
      heading: "O que Relayium e croc têm em comum",
      body: [
        "Comecemos pela sobreposição, porque ela é considerável: ambas são um único binário pequeno que você instala uma vez, ambas são completamente gratuitas sem nenhum nível pago, e ambas são de código aberto sob uma licença permissiva, então você pode ler cada linha que toca seus arquivos.",
      ],
      bullets: [
        "Um código curto conhecido apenas pelas duas pontas basta para que se encontrem e concordem em uma chave. O do croc é inventado na hora; o do Relayium é gerado pelo servidor dele para um remetente com login feito, e quem recebe continua sem precisar de conta.",
        "Criptografado de ponta a ponta em trânsito: o retransmissor ou ponto de encontro no meio nunca vê o conteúdo do seu arquivo.",
        "Transferências interrompidas podem retomar em vez de recomeçar, e ambas verificam que o que chegou realmente corresponde ao que foi enviado.",
        "Multiplataforma: macOS, Linux e Windows.",
      ],
    },
    {
      heading: "SSH e daemon-direct: conversar com um servidor que você já mantém",
      body: [
        "Esta é a maior diferença prática. croc é construído em torno de um único fluxo — frase-código entra, frase-código sai. A CLI do Relayium acrescenta mais duas formas de mover arquivos que se apoiam em infraestrutura que você já tem.",
        "relayium push / pull reutiliza seu acesso SSH existente, então não há nada novo em que confiar nem código para compartilhar. push funciona até contra um servidor sem nenhum relayium instalado, recorrendo a um simples fluxo tar sobre a conexão SSH — esse recurso de reserva é só para push; pull sempre precisa de relayium no remoto, já que ali ele atua como o remetente.",
        "relayium serve transforma qualquer máquina que você possua em um alvo daemon-direct, acessível por TLS 1.3 fixado, sem SSH e sem frase-código — a confiança se estabelece na primeira conexão (aprovada de forma interativa, ou pré-autorizada para uso sem supervisão) e fica fixada a partir de então, a mesma ideia de uma chave de host SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Sincronização de pastas e um código de verificação que você confere duas vezes",
      body: [
        "croc envia um lote de arquivos e sai — envie de novo para atualizar o outro lado, sem nenhuma noção do que deveria ser removido. A CLI do Relayium acrescenta relayium sync, um espelho incremental de mão única sobre qualquer um dos dois transportes acima: ele só move o que mudou, --delete remove no destino os arquivos que sumiram da origem (um daemon só o respeita se foi iniciado com --allow-delete, então um receptor precisa optar por isso), e --watch mantém a ressincronização em tempo real conforme os arquivos mudam, sem necessidade de uma tarefa cron.",
        "Para uma transferência pontual entre redes, relayium send / receive cumpre o mesmo papel que a frase-código do croc, emparelhando dois computadores por um código curto. É ponto a ponto direto, e imprime um código de verificação curto (uma Short Authentication String) nas duas pontas para você confirmar visualmente que ninguém se meteu no meio antes que qualquer byte se mova — vale registrar com honestidade: este modo é só direto, então se as duas pontas não encontrarem um caminho direto, ele falha em vez de recorrer a um retransmissor.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Quando croc é a escolha mais simples",
      body: [
        "Há casos reais em que croc é a melhor ferramenta para a tarefa, e vale a pena dizer isso com clareza.",
      ],
      bullets: [
        "Você só quer entregar um arquivo a um amigo agora mesmo com o mínimo de partes móveis — nenhum servidor a alcançar, nada para configurar em nenhuma das pontas.",
        "Você está atrás de um NAT rígido sem meio de abrir um caminho direto: o retransmissor do croc carrega o fluxo criptografado de qualquer forma, então a transferência se completa de todo jeito. O send / receive do Relayium é só direto e pode falhar nessa situação (push/pull ou daemon-direct para um servidor alcançável continuam funcionando, já que não dependem de um salto P2P direto).",
        "Você não precisa de espelhamento de pastas, integração com SSH nem de um escutador de longa duração — croc é um único comando ad hoc por ponta e nada mais em que pensar.",
        "Você já confia na comunidade grande e consolidada do croc e em seus anos de uso no mundo real.",
      ],
    },
    {
      heading: "Comparação de recursos num relance",
      body: ["As diferenças que mais importam, lado a lado:"],
      bullets: [
        "Conversar com um servidor: o Relayium reutiliza seu acesso SSH (push/pull) ou um daemon com TLS fixado; o croc não tem integração com SSH — instale croc nas duas pontas e compartilhe uma frase-código.",
        "Sincronização de pastas: relayium sync espelha de forma incremental com --delete e --watch; croc envia um lote e sai, sem semântica de espelho nem de exclusão.",
        "Nenhum caminho direto disponível: o retransmissor do croc carrega o fluxo criptografado, então a transferência ainda se completa; o send/receive do Relayium é só direto.",
        "Verificação: ambas são criptografadas de ponta a ponta; o send/receive do Relayium ainda imprime um código curto que os dois lados comparam antes de a transferência começar.",
        "Auto-hospedagem: ambas são auto-hospedáveis — o retransmissor do croc é um pequeno binário independente; o servidor do Relayium também roda o aplicativo web, e o send/receive da CLI pode apontar para o seu próprio com --server.",
        "Licença e custo: ambas licenciadas sob AGPL-3.0 e ambas completamente gratuitas. O croc não exige conta nenhuma; o Relayium exige apenas para o send, para gerar o código de emparelhamento.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "A CLI do Relayium é gratuita?",
        a: "Sim, completamente. Não há nível pago nem nada para medir — cada modo conecta as duas pontas diretamente, e a CLI é licenciada sob AGPL-3.0 e de código aberto.",
      },
      {
        q: "Ela precisa de conta?",
        a: "Só o send. O push/pull usa seu próprio acesso SSH e o daemon-direct usa a confiança por certificado TLS fixado entre suas máquinas, então nenhum dos dois toca uma conta do Relayium. O send/receive é a exceção: só o servidor pode gerar um código de emparelhamento, e apenas para uma conta com login feito, então quem envia roda relayium login uma vez. Receber nunca precisa de conta.",
      },
      {
        q: "Posso usar o código de emparelhamento da CLI com o aplicativo de navegador do Relayium?",
        a: "Ainda não para uma transferência emparelhada ao vivo — o send/receive da CLI usa seu próprio handshake direto, separado do fluxo de emparelhamento do navegador baseado em WebRTC, então os dois não interoperam hoje. Para entregar um arquivo a alguém usando apenas um navegador, use o link de download armazenado do Relayium ou o próprio modo de código de emparelhamento do aplicativo de navegador.",
      },
      {
        q: "Posso auto-hospedá-lo?",
        a: "Sim. O servidor do Relayium é distribuído como imagem Docker (docker compose up -d --build), e você pode apontar o send/receive da CLI para a sua própria instância com --server https://your-domain — o mesmo espírito de rodar seu próprio retransmissor do croc.",
      },
    ],
  },
  cta: {
    text: "Instale a CLI gratuita do Relayium e experimente push, sync ou send — totalmente gratuita, e tão rápida de começar quanto croc.",
    button: "Baixe a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/croc",
  published: "2026-07-09",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
