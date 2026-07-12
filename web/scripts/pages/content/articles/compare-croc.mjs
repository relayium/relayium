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
    "croc is one of the best-loved tools for sending a file from one terminal to another: a short, memorable code phrase, a PAKE key exchange, and it just works. Relayium's CLI sets out to do the same job and is built the same way — free, open source, and encrypted end to end, with no account required for any of it.",
    "This isn't a takedown; croc earned its reputation. It's a straight comparison of what the two share, where Relayium's CLI does more because it also talks to servers you already run, and the case where croc is honestly the simpler pick.",
  ],
  sections: [
    {
      heading: "What Relayium and croc have in common",
      body: [
        "Start with the overlap, because it's substantial: both are single small binaries you install once, both are completely free with no paid tier, and both are open source under a permissive license so you can read every line that touches your files.",
      ],
      bullets: [
        "No account for a transfer — a short code known only to the two ends is enough to find each other and agree on a key.",
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
        "License and cost: both MIT-licensed, both completely free, neither requires an account.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is Relayium's CLI free?",
        a: "Yes, completely. There's no paid tier and nothing to meter — every mode connects the two ends directly, and the CLI is MIT-licensed and open source.",
      },
      {
        q: "Does it need an account?",
        a: "No. push/pull uses your own SSH access, daemon-direct uses pinned-TLS certificate trust between your machines, and send/receive uses a short code you agree on out of band. None of it touches a Relayium account.",
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
    text: "Install the free Relayium CLI and try push, sync or send — no account, and just as quick to start as croc.",
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
    "croc 是最受欢迎的终端间传输文件工具之一：一个简短好记的暗号短语、一次 PAKE 密钥交换，就能直接用。Relayium CLI 想做的是同一件事，实现方式也相似——免费、开源、端到端加密，任何模式都不需要账号。",
    "这不是一篇贬低文。croc 的口碑是实至名归的。本文客观对比两者的共同点、Relayium CLI 因为能对接你已有的服务器而多出的能力，以及 croc 老实说更简单的场景。",
  ],
  sections: [
    {
      heading: "Relayium 与 croc 的共同点",
      body: [
        "先说重合的部分，其实不少：两者都是安装一次就好的小型单一二进制文件，都完全免费、没有付费档位，都以宽松许可证开源，文件相关的每一行代码你都能读到。",
      ],
      bullets: [
        "传输无需账号——一个只有两端知道的简短暗号，就足以让彼此找到对方并协商出密钥。",
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
        "许可证与费用：都是 MIT 许可，都完全免费，都不需要账号。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 的 CLI 免费吗？",
        a: "完全免费。没有付费档位，也没有什么可计量的——每种模式都是两端直接连接，CLI 采用 MIT 许可并开源。",
      },
      {
        q: "需要账号吗？",
        a: "不需要。push/pull 用你自己的 SSH 权限，daemon-direct 用你机器之间锁定的 TLS 证书信任，send/receive 用你们线下约定的一段简短代码。三者都不涉及 Relayium 账号。",
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
    text: "安装免费的 Relayium CLI，试试 push、sync 或 send——无需账号，上手速度不输 croc。",
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
    "croc はターミナル間でファイルを送る、最も愛されているツールの一つです。短く覚えやすいコードフレーズ、PAKE による鍵交換、それだけでちゃんと動きます。Relayium CLI も同じ仕事を目指し、同じ考え方で作られています——無料、オープンソース、エンドツーエンドで暗号化され、どのモードでもアカウントは不要です。",
    "これは批判の記事ではありません。croc の評判はふさわしいものです。両者の共通点、Relayium CLI がすでに運用しているサーバーとも話せるために持つ追加の力、そして croc の方が正直シンプルな場合を、率直に比較します。",
  ],
  sections: [
    {
      heading: "Relayium と croc の共通点",
      body: [
        "まず重なる部分から。実はかなり多いです。どちらも一度インストールすれば済む小さな単一バイナリで、完全無料で有料プランはなく、寛容なライセンスでオープンソース化されているため、ファイルに触れるコードをすべて読むことができます。",
      ],
      bullets: [
        "転送にアカウントは不要——両端しか知らない短いコードだけで、互いを見つけ鍵に合意できます。",
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
        "ライセンスと費用：どちらも MIT ライセンスで完全に無料、どちらもアカウント不要です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium の CLI は無料ですか？",
        a: "はい、完全に無料です。有料プランはなく、計測するものもありません——どのモードでも両端が直接つながり、CLI は MIT ライセンスでオープンソースです。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "いいえ。push/pull は自分の SSH アクセスを使い、daemon-direct はマシン間のピン留めされた TLS 証明書の信頼を使い、send/receive は事前に合意した短いコードを使います。いずれも Relayium アカウントには触れません。",
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
    text: "無料の Relayium CLI をインストールして push、sync、send を試してみましょう——アカウント不要で、croc と同じくらいすぐに始められます。",
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
    "croc은 터미널 사이에서 파일을 보내는 가장 사랑받는 도구 중 하나입니다. 짧고 기억하기 쉬운 코드 문구, PAKE 키 교환, 그리고 그것만으로 잘 작동합니다. Relayium CLI도 같은 일을 하려 하며, 만들어진 방식도 비슷합니다 — 무료, 오픈소스, 종단간 암호화되어 있고 어떤 모드도 계정이 필요 없습니다.",
    "이 글은 깎아내리려는 것이 아닙니다. croc의 명성은 그럴 만합니다. 이 글은 두 도구가 공유하는 부분, Relayium CLI가 이미 운영 중인 서버와도 통신할 수 있어 더 갖춘 부분, 그리고 croc이 솔직히 더 단순한 선택인 경우를 있는 그대로 비교합니다.",
  ],
  sections: [
    {
      heading: "Relayium과 croc의 공통점",
      body: [
        "겹치는 부분부터 보면 상당히 많습니다. 둘 다 한 번만 설치하면 되는 작은 단일 바이너리이고, 둘 다 유료 등급 없이 완전히 무료이며, 둘 다 관대한 라이선스로 오픈소스이므로 파일과 관련된 모든 코드를 직접 읽어볼 수 있습니다.",
      ],
      bullets: [
        "전송에 계정이 필요 없음 — 양쪽만 아는 짧은 코드만으로 서로를 찾고 키에 합의하기에 충분합니다.",
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
        "라이선스와 비용: 둘 다 MIT 라이선스, 둘 다 완전 무료, 둘 다 계정 불필요.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium의 CLI는 무료인가요?",
        a: "네, 완전히 무료입니다. 유료 등급이 없고 계량할 것도 없습니다 — 모든 모드가 양쪽을 직접 연결하며, CLI는 MIT 라이선스로 오픈소스입니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "아니요. push/pull은 자신의 SSH 접근을 사용하고, daemon-direct는 기기 간 고정된 TLS 인증서 신뢰를 사용하며, send/receive는 별도 채널로 미리 합의한 짧은 코드를 사용합니다. 어느 것도 Relayium 계정을 필요로 하지 않습니다.",
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
    text: "무료 Relayium CLI를 설치하고 push, sync, send를 써보세요 — 계정 없이, croc만큼 빠르게 시작할 수 있습니다.",
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
    "croc ist eines der beliebtesten Werkzeuge, um eine Datei von einem Terminal zum anderen zu schicken: eine kurze, einprägsame Code-Phrase, ein PAKE-Schlüsselaustausch, und es funktioniert einfach. Die Relayium CLI setzt sich dieselbe Aufgabe und ist ähnlich gebaut — kostenlos, quelloffen und Ende-zu-Ende verschlüsselt, ohne dass irgendein Modus ein Konto braucht.",
    "Das ist keine Abrechnung; croc hat sich seinen Ruf verdient. Dieser Artikel vergleicht ehrlich, was beide gemeinsam haben, wo die Relayium CLI mehr bietet, weil sie auch mit Servern spricht, die du bereits betreibst, und den Fall, in dem croc schlicht die einfachere Wahl ist.",
  ],
  sections: [
    {
      heading: "Was Relayium und croc gemeinsam haben",
      body: [
        "Beginnen wir mit der Überschneidung, denn sie ist erheblich: Beide sind kleine, einmal zu installierende Binaries, beide sind völlig kostenlos ohne bezahlte Stufe, und beide sind unter einer freizügigen Lizenz quelloffen, sodass du jede Zeile lesen kannst, die deine Dateien berührt.",
      ],
      bullets: [
        "Kein Konto für eine Übertragung — ein kurzer, nur den beiden Enden bekannter Code genügt, damit sie sich finden und auf einen Schlüssel einigen.",
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
        "Lizenz und Kosten: Beide MIT-lizenziert, beide völlig kostenlos, keines braucht ein Konto.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist Relayiums CLI kostenlos?",
        a: "Ja, vollständig. Es gibt keine bezahlte Stufe und nichts zu messen — jeder Modus verbindet die beiden Enden direkt, und die CLI ist MIT-lizenziert und quelloffen.",
      },
      {
        q: "Braucht sie ein Konto?",
        a: "Nein. push/pull nutzt deinen eigenen SSH-Zugang, daemon-direct nutzt gepinntes TLS-Zertifikatsvertrauen zwischen deinen Maschinen, und send/receive nutzt einen Code, den ihr außerhalb des Kanals vereinbart. Nichts davon berührt ein Relayium-Konto.",
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
    text: "Installiere die kostenlose Relayium CLI und probiere push, sync oder send — ohne Konto, und genauso schnell startklar wie croc.",
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
    "croc est l'un des outils les plus appréciés pour envoyer un fichier d'un terminal à un autre : une courte phrase-code facile à retenir, un échange de clés PAKE, et ça marche tout simplement. La CLI Relayium vise le même objectif et est construite dans le même esprit — gratuite, open source, chiffrée de bout en bout, sans compte requis pour aucun mode.",
    "Ceci n'est pas un dénigrement ; la réputation de croc est méritée. Cet article compare franchement ce que partagent les deux outils, là où la CLI Relayium fait plus parce qu'elle sait aussi parler à des serveurs que vous exploitez déjà, et le cas où croc est honnêtement le choix le plus simple.",
  ],
  sections: [
    {
      heading: "Ce que Relayium et croc ont en commun",
      body: [
        "Commençons par ce qui se recoupe, et c'est substantiel : les deux sont de petits binaires uniques à installer une fois, tous deux entièrement gratuits sans palier payant, et tous deux open source sous une licence permissive, si bien que vous pouvez lire chaque ligne qui touche à vos fichiers.",
      ],
      bullets: [
        "Aucun compte pour un transfert — un court code connu des deux seules extrémités suffit pour qu'elles se trouvent et s'accordent sur une clé.",
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
        "Licence et coût : les deux sous licence MIT, tous deux entièrement gratuits, aucun des deux ne nécessite de compte.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La CLI Relayium est-elle gratuite ?",
        a: "Oui, entièrement. Il n'y a aucun palier payant et rien à mesurer — chaque mode connecte directement les deux extrémités, et la CLI est sous licence MIT et open source.",
      },
      {
        q: "A-t-elle besoin d'un compte ?",
        a: "Non. push/pull utilise votre propre accès SSH, daemon-direct utilise une confiance par certificat TLS épinglé entre vos machines, et send/receive utilise un code que vous convenez par un autre canal. Rien de tout cela ne touche un compte Relayium.",
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
    text: "Installez la CLI Relayium gratuite et essayez push, sync ou send — sans compte, et tout aussi rapide à démarrer que croc.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "compare/croc",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr }),
};
