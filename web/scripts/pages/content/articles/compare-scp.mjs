// web/scripts/pages/content/articles/compare-scp.mjs
// Fair comparison: Relayium's push/pull CLI vs plain scp. English is the
// master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Command/code snippets stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Relayium vs scp: simpler file transfer over SSH",
  description:
    "scp is universal and preinstalled. Relayium's push/pull ride the same SSH but add resume, SHA-256 verification, progress, and a fallback for bare servers. A fair comparison.",
  updatedLabel: "Last updated",
  lead: [
    "scp has been the default way to move a file over SSH for decades: it's on almost every Unix-like machine already, everyone knows the syntax, and it just works. There's no reason to pretend otherwise — scp earned its place.",
    "Relayium's CLI doesn't replace SSH; it rides on top of the exact same SSH access you already have. push and pull use your SSH connection the same way scp does, but add a few things scp was never built to do: resuming a broken transfer, verifying every file with a checksum, showing real progress, and working even when the remote has nothing installed at all.",
  ],
  sections: [
    {
      heading: "Where scp is genuinely simpler",
      body: [
        "It's worth saying plainly: for a lot of jobs, scp is the right tool and adding anything else is overhead.",
      ],
      bullets: [
        "It's already installed — no binary to fetch, nothing to set up, on effectively every server you'll ever SSH into.",
        "It's battle-tested. Decades of use, well-understood behavior, and every sysadmin already knows the flags.",
        "For a genuine one-off — copy this one file, right now — typing scp file.txt user@host:path is less typing than installing anything.",
        "It's ideal for quick, throwaway scripting where you don't want a dependency beyond OpenSSH.",
      ],
    },
    {
      heading: "push / pull: the same SSH, with resume, checksums and progress",
      body: [
        "relayium push and relayium pull connect over the identical SSH access scp uses — same host, same key, same port. The difference is what happens once the connection is open.",
        "Every file is verified end to end with a SHA-256 hash after it arrives, so a transfer that looks done actually matches what was sent, byte for byte. If a transfer is interrupted — a dropped connection, a closed laptop lid — restarting the same command picks up from where it left off instead of resending everything, and you see real per-file progress the whole way, not a silent copy.",
        "The biggest practical difference is what happens when the remote doesn't have relayium installed. push checks for it automatically and, if it isn't there, falls back to streaming a plain tar archive over the same SSH connection into tar -x on the other end — so push still works against a completely bare server, nothing to install first. That fallback is push-only: pull always needs relayium already installed on the remote, because on a pull the remote machine is the one acting as the sender.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Beyond SSH: daemon-direct and cross-network pairing",
      body: [
        "scp only ever works where you have SSH access. Relayium's CLI adds two more ways to move files that scp has no equivalent for.",
        "relayium serve turns a machine you own into a daemon-direct target reachable over pinned TLS 1.3 — no SSH, no port 22, trust established on the first connection (approved interactively, or pre-authorized with relayium authorize for unattended use) and pinned from then on. Push straight to it with a relayium:// address.",
        "For sending to someone across the internet who you don't have SSH access to at all, relayium send / receive pairs two computers with a short code instead — direct peer-to-peer, with a short verification code (SAS) both sides check before any bytes move. scp has no answer for that case; you'd need SSH access first.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "Folder mirroring: sync vs re-running scp -r",
      body: [
        "Copying a whole directory again and again with scp -r means re-sending everything every time, with no notion of what changed or what should be removed. relayium sync builds an incremental one-way mirror on top of push/pull or daemon-direct: only changed files move, --delete removes files on the destination that disappeared from the source, and --watch keeps re-syncing in real time as files change locally — no cron job needed.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Availability: scp is preinstalled on virtually every server; Relayium's CLI is a single binary you install once with one command.",
        "Resume: scp restarts an interrupted transfer from scratch; push/pull resume from where they stopped.",
        "Integrity: scp doesn't verify contents after the fact; every Relayium transfer is checked with a per-file SHA-256 hash.",
        "Bare servers: scp needs nothing extra, and push works the same way via its tar fallback when relayium isn't installed remotely (pull needs relayium on the remote, no fallback).",
        "Beyond SSH: scp only works over SSH; Relayium also offers daemon-direct (pinned TLS, no SSH) and cross-network pairing-code transfers (send/receive) that need no SSH access at all.",
        "Folder mirroring: scp -r re-sends everything; relayium sync mirrors incrementally with --delete and --watch.",
        "Cost and license: both free; scp ships with OpenSSH, Relayium's CLI is AGPL-3.0-licensed and open source.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does Relayium's CLI need an account?",
        a: "No. push/pull uses your own SSH access exactly like scp does — no Relayium account, no sign-in, for any CLI mode.",
      },
      {
        q: "Does push work if the remote server doesn't have Relayium installed?",
        a: "Yes. push checks first and, if relayium isn't there, falls back to a plain tar stream over the same SSH connection so it still works against a bare server. That fallback is push-only — pull always needs relayium already installed on the remote, since the remote acts as the sender in a pull.",
      },
      {
        q: "Is it really as simple as scp to use?",
        a: "The commands look the same: relayium push src user@host:dest instead of scp -r src user@host:dest. The difference only shows up when something goes wrong — a dropped connection resumes instead of restarting, and every file is checksum-verified on arrival.",
      },
      {
        q: "When should I just use scp instead?",
        a: "For a genuine one-off copy where nothing needs to resume, nothing needs verifying, and you don't want any extra binary — scp is already there and is the simpler pick. It's also the safer default inside quick scripts where you don't want a new dependency.",
      },
      {
        q: "Is Relayium's CLI free?",
        a: "Yes, completely — no paid tier, AGPL-3.0-licensed and open source, and every mode connects the two ends directly.",
      },
    ],
  },
  cta: {
    text: "Install the free Relayium CLI and try push or pull over the SSH access you already have.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 scp：更简单的 SSH 文件传输",
  description:
    "scp 通用且预装在几乎所有系统上。Relayium 的 push/pull 走同一条 SSH，但增加了断点续传、SHA-256 校验、进度显示，以及针对裸机服务器的兜底方案。一次客观的对比。",
  updatedLabel: "最近更新",
  lead: [
    "几十年来，scp 一直是通过 SSH 传文件的默认方式：几乎装在你会用到的每一台类 Unix 机器上，人人都熟悉它的用法，而且一直很好用。没必要假装不是这样——scp 的地位是实至名归的。",
    "Relayium 的 CLI 并不是要取代 SSH，而是搭在你已经拥有的同一条 SSH 访问权限之上。push 和 pull 使用你的 SSH 连接的方式和 scp 一样，但补上了几件 scp 从未打算做的事：接续中断的传输、用校验和验证每个文件、显示真实进度，以及在远程什么都没安装的情况下依然能用。",
  ],
  sections: [
    {
      heading: "scp 确实更简单的场景",
      body: ["有必要坦白说：在很多任务里，scp 就是对的工具，加任何别的东西反而是负担。"],
      bullets: [
        "它已经装好了——不用下载任何二进制，不用做任何配置，几乎你会 SSH 进去的每台服务器上都有。",
        "它久经考验。几十年的使用积累、行为清晰可预期，每个系统管理员都已经熟悉它的参数。",
        "对于真正的一次性任务——现在就复制这一个文件——直接敲 scp file.txt user@host:path，比安装任何东西都省事。",
        "对于不想引入 OpenSSH 之外任何依赖的快速、一次性脚本，它是理想之选。",
      ],
    },
    {
      heading: "push / pull：同一条 SSH，加上断点续传、校验和进度",
      body: [
        "relayium push 和 relayium pull 走的是与 scp 完全相同的 SSH 访问——同一台主机、同一把密钥、同一个端口。区别在于连接建立之后发生了什么。",
        "每个文件到达后都会用 SHA-256 哈希做端到端校验，因此一个看起来完成了的传输，其内容确实和发出的一字不差。如果传输被打断——连接掉线、笔记本合上盖子——重新运行同一条命令会从中断处接着传，而不是全部重传，全程还能看到逐文件的真实进度，而不是悄无声息地拷贝。",
        "实际使用上最大的差别，是远程没装 relayium 时会发生什么。push 会自动检测，如果没装，就退化为通过同一条 SSH 连接把一个普通的 tar 归档流传到对端并执行 tar -x——因此 push 在完全裸机的服务器上依然可用，事先无需安装任何东西。这个兜底只属于 push：pull 始终需要远程已经装好 relayium，因为在 pull 里，远程机器才是充当发送方的一端。",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "超越 SSH：daemon-direct 与跨网络配对",
      body: [
        "scp 只能在你拥有 SSH 访问权限的地方使用。Relayium 的 CLI 又加了两种 scp 没有对应能力的传输方式。",
        "relayium serve 能把你拥有的一台机器变成一个 daemon-direct 目标，通过锁定的 TLS 1.3 访问——无需 SSH、无需 22 端口，信任建立在第一次连接时（可交互批准，或用 relayium authorize 提前授权以支持无人值守），此后一直锁定。用 relayium:// 地址直接向它 push。",
        "如果要发给一个你完全没有 SSH 访问权限、身处互联网另一端的人，relayium send / receive 则改用一个简短代码来配对两台电脑——直连点对点，并在两端都打印一段验证码（SAS），传输开始前双方核对确认。这种场景 scp 完全无解，你首先得有 SSH 访问权限才行。",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "文件夹镜像：sync 对比反复运行 scp -r",
      body: [
        "反复用 scp -r 拷贝整个目录，意味着每次都要重传所有内容，也没有“发生了什么变化”或“该删除什么”的概念。relayium sync 在 push/pull 或 daemon-direct 之上构建增量单向镜像：只传发生变化的文件；--delete 会删除目标端上源端已经消失的文件；--watch 会在本地文件变化时实时持续重新同步——不需要额外的定时任务。",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "可用性：scp 几乎预装在所有服务器上；Relayium 的 CLI 是单一二进制，一条命令安装一次即可。",
        "断点续传：scp 中断的传输要从头开始；push/pull 会从中断处继续。",
        "完整性：scp 事后不会校验内容；Relayium 的每次传输都会做逐文件的 SHA-256 校验。",
        "裸机服务器：scp 不需要任何额外东西；远程未装 relayium 时，push 通过 tar 兜底同样能用（pull 需要远程装有 relayium，没有兜底）。",
        "超越 SSH：scp 只能走 SSH；Relayium 还提供 daemon-direct（锁定 TLS，无需 SSH）以及完全不需要 SSH 访问权限的跨网络配对码传输（send/receive）。",
        "文件夹镜像：scp -r 每次都重传所有内容；relayium sync 支持 --delete 与 --watch 的增量镜像。",
        "费用与许可：两者都免费；scp 随 OpenSSH 一起提供，Relayium 的 CLI 采用 AGPL-3.0 许可并开源。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 的 CLI 需要账号吗？",
        a: "不需要。push/pull 使用你自己的 SSH 访问权限，方式和 scp 完全一样——CLI 的任何模式都不需要 Relayium 账号，也不需要登录。",
      },
      {
        q: "如果远程服务器没装 Relayium，push 还能用吗？",
        a: "可以。push 会先检测，如果 relayium 不在，就会退化为通过同一条 SSH 连接传输一段普通的 tar 流，因此在裸机服务器上依然可用。这个兜底只属于 push——pull 始终需要远程已经装好 relayium，因为在 pull 里远程要充当发送方。",
      },
      {
        q: "用起来真的和 scp 一样简单吗？",
        a: "命令形式很相近：relayium push src user@host:dest，对应 scp -r src user@host:dest。区别只会在出问题时体现出来——连接掉线时会续传而不是重来，且每个文件到达后都会做校验和验证。",
      },
      {
        q: "什么时候该直接用 scp？",
        a: "对于真正的一次性拷贝——不需要续传，不需要校验，也不想引入额外的二进制——scp 本来就在那里，是更简单的选择。它也是快速脚本里更稳妥的默认项，不想引入新依赖时尤其如此。",
      },
      {
        q: "Relayium 的 CLI 免费吗？",
        a: "完全免费——没有付费档位，AGPL-3.0 许可并开源，每种模式都是两端直接连接。",
      },
    ],
  },
  cta: {
    text: "安装免费的 Relayium CLI，在你已有的 SSH 访问权限上试试 push 或 pull。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と scp の比較：よりシンプルな SSH 転送",
  description:
    "scp は普遍的でほぼどこにでも入っています。Relayium の push/pull は同じ SSH 上で動きつつ、再開・SHA-256 検証・進捗表示・裸のサーバー向けのフォールバックを加えます。公平な比較です。",
  updatedLabel: "最終更新",
  lead: [
    "scp は何十年もの間、SSH 経由でファイルを移動する既定の手段でした。ほぼすべての Unix 系マシンにすでに入っており、誰もが使い方を知っていて、ちゃんと動きます。そうでないふりをする理由はありません——scp の地位はふさわしいものです。",
    "Relayium の CLI は SSH を置き換えるものではなく、すでに持っているのと同じ SSH アクセスの上に乗っています。push と pull は scp と同じ方法で SSH 接続を使いますが、scp が元々やるように作られていないいくつかのことを加えています。途切れた転送の再開、チェックサムによる各ファイルの検証、実際の進捗表示、そしてリモートに何もインストールされていない場合でも動作することです。",
  ],
  sections: [
    {
      heading: "scp が本当にシンプルな場面",
      body: ["率直に言う価値があります。多くの作業では scp が正しい選択で、他に何かを追加することがむしろ余計な負担になります。"],
      bullets: [
        "すでにインストール済み——バイナリを取ってくる必要も設定する必要もなく、SSH でログインするほぼすべてのサーバーに入っています。",
        "実戦で鍛え上げられている。何十年もの利用実績、よく理解された挙動で、どのシステム管理者もすでにフラグを知っています。",
        "本当に一度きりの作業——このファイル1つを今すぐコピーしたい——なら scp file.txt user@host:path と打つ方が、何かをインストールするより手数が少ないです。",
        "OpenSSH 以外の依存を増やしたくない、素早く使い捨てるスクリプトに最適です。",
      ],
    },
    {
      heading: "push / pull：同じ SSH に、再開・チェックサム・進捗を追加",
      body: [
        "relayium push と relayium pull は、scp が使うのとまったく同じ SSH アクセス——同じホスト、同じ鍵、同じポート——で接続します。違いは接続が開いた後に何が起きるかです。",
        "すべてのファイルは到着後に SHA-256 ハッシュでエンドツーエンド検証されるため、完了したように見える転送が、実際に送られたものとバイト単位で一致していることが分かります。転送が中断された場合——接続が切れた、ノートPCの蓋を閉じた——同じコマンドを再実行すれば全部を送り直すのではなく中断した所から再開し、その間ずっとサイレントなコピーではなく実際のファイル単位の進捗が見えます。",
        "実用上いちばん大きな違いは、リモートに relayium がインストールされていない場合に何が起きるかです。push は自動的に確認し、もしなければ同じ SSH 接続上で単純な tar アーカイブをストリームし、相手側の tar -x に流し込むフォールバックを行います——これにより push は完全に裸のサーバーに対しても動作し、事前に何もインストールする必要がありません。このフォールバックは push だけのものです。pull は常にリモートに relayium がインストールされている必要があります。pull では、リモートのマシンが送信側として動作するためです。",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "SSH の先へ：daemon-direct とネットワークをまたぐペアリング",
      body: [
        "scp は SSH アクセスがある場所でしか動作しません。Relayium の CLI は、scp に相当するものがない、さらに2つのファイル移動方法を加えています。",
        "relayium serve は、所有するマシンをピン留めされた TLS 1.3 経由で到達可能な daemon-direct のターゲットに変えます——SSH も 22 番ポートも不要で、信頼は最初の接続時に成立し（対話的に承認するか、無人運用向けに relayium authorize で事前承認）、以後はピン留めされます。relayium:// アドレスで直接そこへ push できます。",
        "SSH アクセスがまったくない、インターネットの向こう側にいる相手へ送る場合は、代わりに relayium send / receive が短いコードで2台のコンピュータをペアリングします——直接の P2P で、バイトが動く前に両端で短い検証コード（SAS）を確認します。この場合 scp には答えがなく、そもそも SSH アクセスが必要になります。",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "フォルダのミラーリング：sync 対 scp -r の繰り返し",
      body: [
        "scp -r でディレクトリ全体を繰り返しコピーすると、毎回すべてを送り直すことになり、何が変わったか、何を削除すべきかという概念がありません。relayium sync は push/pull または daemon-direct の上に増分の一方向ミラーを構築します。変化したファイルだけを移動し、--delete はソース側から消えたファイルを宛先側からも削除し、--watch はローカルのファイルが変化するたびにリアルタイムで再同期し続けます——cron ジョブは不要です。",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "可用性：scp はほぼすべてのサーバーに事前インストールされている；Relayium の CLI は1つのコマンドで一度インストールすればよい単一バイナリ。",
        "再開：scp は中断した転送を最初からやり直す；push/pull は中断した所から再開する。",
        "整合性：scp は事後に内容を検証しない；Relayium はすべての転送でファイル単位の SHA-256 検証を行う。",
        "裸のサーバー：scp は追加のものを何も必要としない；リモートに relayium がなくても push は tar フォールバックで同様に動作する（pull はリモートに relayium が必要で、フォールバックはない）。",
        "SSH の先：scp は SSH 経由でしか動作しない；Relayium は daemon-direct（ピン留めされた TLS、SSH 不要）や、SSH アクセスがまったく不要なネットワークをまたぐペアリングコード転送（send/receive）も提供する。",
        "フォルダのミラーリング：scp -r は毎回すべてを送り直す；relayium sync は --delete と --watch を伴う増分ミラーリングを行う。",
        "費用とライセンス：どちらも無料；scp は OpenSSH に付属し、Relayium の CLI は AGPL-3.0 ライセンスでオープンソース。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium の CLI にアカウントは必要ですか？",
        a: "いいえ。push/pull は scp とまったく同じように自分の SSH アクセスを使います——CLI のどのモードでも Relayium アカウントもサインインも不要です。",
      },
      {
        q: "リモートサーバーに Relayium がインストールされていなくても push は動きますか？",
        a: "はい。push はまず確認し、relayium がなければ同じ SSH 接続上で単純な tar ストリームにフォールバックするため、裸のサーバーに対しても動作します。このフォールバックは push だけのものです——pull では、リモートが送信側として動作するため、常にリモートに relayium がインストール済みである必要があります。",
      },
      {
        q: "使い方は本当に scp と同じくらいシンプルですか？",
        a: "コマンドは似ています：relayium push src user@host:dest は scp -r src user@host:dest に対応します。違いは何か問題が起きたときにだけ現れます——接続が切れても最初からではなく再開し、すべてのファイルが到着時にチェックサムで検証されます。",
      },
      {
        q: "どんなときに素直に scp を使うべきですか？",
        a: "何も再開する必要がなく、検証も不要で、余計なバイナリを増やしたくない、本当に一度きりのコピーなら——scp はすでにそこにあり、よりシンプルな選択です。新しい依存を増やしたくない、素早いスクリプトの中でもより安全な既定の選択肢です。",
      },
      {
        q: "Relayium の CLI は無料ですか？",
        a: "はい、完全に無料です——有料プランはなく、AGPL-3.0 ライセンスでオープンソース、どのモードでも両端が直接つながります。",
      },
    ],
  },
  cta: {
    text: "無料の Relayium CLI をインストールして、すでに持っている SSH アクセスで push や pull を試してみましょう。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs scp: 더 간단한 SSH 파일 전송",
  description:
    "scp는 보편적이고 거의 모든 곳에 이미 설치되어 있습니다. Relayium의 push/pull은 같은 SSH 위에서 동작하면서 재개, SHA-256 검증, 진행률, 그리고 아무것도 설치되지 않은 서버를 위한 대체 방식을 더합니다. 공정한 비교입니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "scp는 수십 년 동안 SSH로 파일을 옮기는 기본 방법이었습니다. 거의 모든 유닉스 계열 기기에 이미 설치되어 있고, 누구나 사용법을 알고 있으며, 그냥 잘 작동합니다. 그렇지 않은 척할 이유가 없습니다 — scp의 자리는 그럴 만합니다.",
    "Relayium의 CLI는 SSH를 대체하지 않습니다. 이미 가지고 있는 것과 똑같은 SSH 접근 위에서 동작할 뿐입니다. push와 pull은 scp와 같은 방식으로 SSH 연결을 사용하지만, scp가 애초에 하도록 만들어지지 않은 몇 가지를 더합니다: 끊긴 전송 재개, 체크섬으로 파일마다 검증, 실제 진행률 표시, 그리고 원격지에 아무것도 설치되지 않은 경우에도 동작하는 것입니다.",
  ],
  sections: [
    {
      heading: "scp가 진짜로 더 간단한 경우",
      body: ["솔직히 말할 가치가 있습니다: 많은 작업에서 scp가 옳은 도구이고, 다른 것을 더하는 건 오히려 부담입니다."],
      bullets: [
        "이미 설치되어 있습니다 — 받아올 바이너리도, 설정할 것도 없이, 여러분이 SSH로 접속할 거의 모든 서버에 들어 있습니다.",
        "실전에서 검증되었습니다. 수십 년의 사용 경험과 잘 이해된 동작 방식, 모든 시스템 관리자가 이미 옵션들을 알고 있습니다.",
        "진짜 일회성 작업이라면 — 지금 당장 이 파일 하나만 복사하고 싶다면 — scp file.txt user@host:path를 입력하는 편이 무언가를 설치하는 것보다 손이 덜 갑니다.",
        "OpenSSH 외에 아무 의존성도 원하지 않는 빠른 일회성 스크립트에 이상적입니다.",
      ],
    },
    {
      heading: "push / pull: 같은 SSH에 재개, 체크섬, 진행률을 더하다",
      body: [
        "relayium push와 relayium pull은 scp가 사용하는 것과 동일한 SSH 접근 — 같은 호스트, 같은 키, 같은 포트 — 으로 연결합니다. 차이는 연결이 열린 뒤에 무슨 일이 일어나느냐입니다.",
        "모든 파일은 도착 후 SHA-256 해시로 종단간 검증되므로, 끝난 것처럼 보이는 전송이 실제로 보낸 것과 바이트 단위로 일치함을 확인할 수 있습니다. 전송이 중단되면 — 연결이 끊기거나 노트북 덮개가 닫히거나 — 같은 명령을 다시 실행하면 전체를 다시 보내는 대신 멈춘 지점에서 이어서 진행하며, 조용히 복사만 되는 게 아니라 파일별 실제 진행률을 계속 볼 수 있습니다.",
        "실용적으로 가장 큰 차이는 원격지에 relayium이 설치되어 있지 않을 때 벌어지는 일입니다. push는 자동으로 확인하고, 없으면 같은 SSH 연결을 통해 일반 tar 아카이브를 스트리밍해 상대편의 tar -x로 흘려보내는 대체 방식으로 전환합니다 — 그래서 push는 완전히 아무것도 설치되지 않은 서버에서도 여전히 동작하며, 먼저 설치할 필요가 없습니다. 이 대체 방식은 push에만 있습니다. pull은 항상 원격지에 relayium이 이미 설치되어 있어야 합니다. pull에서는 원격 기기가 송신자 역할을 하기 때문입니다.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "SSH를 넘어서: daemon-direct와 네트워크를 넘나드는 페어링",
      body: [
        "scp는 SSH 접근 권한이 있는 곳에서만 동작합니다. Relayium의 CLI는 scp에 대응물이 없는 두 가지 파일 이동 방식을 더합니다.",
        "relayium serve는 소유한 기기를 고정된 TLS 1.3을 통해 도달 가능한 daemon-direct 대상으로 바꿉니다 — SSH도, 22번 포트도 필요 없고, 신뢰는 첫 연결에서 성립하며(대화식으로 승인하거나, 무인 운영을 위해 relayium authorize로 미리 승인) 이후 계속 고정됩니다. relayium:// 주소로 곧바로 push할 수 있습니다.",
        "SSH 접근 권한이 전혀 없는, 인터넷 건너편의 누군가에게 보내야 한다면 relayium send / receive가 대신 짧은 코드로 두 컴퓨터를 페어링합니다 — 직접 P2P이며, 바이트가 움직이기 전 양쪽에서 짧은 검증 코드(SAS)를 확인합니다. 이런 경우 scp는 답이 없습니다 — 애초에 SSH 접근 권한이 먼저 있어야 합니다.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "폴더 미러링: sync 대 scp -r 반복 실행",
      body: [
        "scp -r로 디렉터리 전체를 반복해서 복사하면 매번 모든 것을 다시 보내야 하고, 무엇이 바뀌었는지, 무엇을 삭제해야 하는지에 대한 개념이 없습니다. relayium sync는 push/pull이나 daemon-direct 위에 증분 단방향 미러를 구축합니다. 변경된 파일만 이동하고, --delete는 소스에서 사라진 파일을 대상에서도 삭제하며, --watch는 로컬 파일이 바뀔 때마다 실시간으로 계속 재동기화합니다 — cron 작업이 필요 없습니다.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "가용성: scp는 거의 모든 서버에 사전 설치되어 있음; Relayium의 CLI는 한 번 설치하면 되는 단일 바이너리.",
        "재개: scp는 중단된 전송을 처음부터 다시 시작함; push/pull은 멈춘 지점에서 재개함.",
        "무결성: scp는 사후에 내용을 검증하지 않음; Relayium의 모든 전송은 파일별 SHA-256 해시로 검사됨.",
        "아무것도 없는 서버: scp는 추가로 필요한 것이 없음; 원격지에 relayium이 없어도 push는 tar 대체 방식으로 동일하게 동작함(pull은 원격지에 relayium이 필요하며 대체 방식 없음).",
        "SSH를 넘어서: scp는 SSH로만 동작함; Relayium은 daemon-direct(고정 TLS, SSH 불필요)와 SSH 접근이 전혀 필요 없는 네트워크 간 페어링 코드 전송(send/receive)도 제공함.",
        "폴더 미러링: scp -r은 매번 모든 것을 다시 보냄; relayium sync는 --delete와 --watch로 증분 미러링을 함.",
        "비용과 라이선스: 둘 다 무료; scp는 OpenSSH와 함께 제공되고, Relayium의 CLI는 AGPL-3.0 라이선스로 오픈소스임.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium의 CLI에 계정이 필요한가요?",
        a: "아니요. push/pull은 scp와 완전히 똑같은 방식으로 자신의 SSH 접근을 사용합니다 — CLI의 어떤 모드도 Relayium 계정이나 로그인이 필요 없습니다.",
      },
      {
        q: "원격 서버에 Relayium이 설치되어 있지 않아도 push가 동작하나요?",
        a: "네. push는 먼저 확인하고, relayium이 없으면 같은 SSH 연결을 통해 일반 tar 스트림으로 대체하여 아무것도 설치되지 않은 서버에서도 동작합니다. 이 대체 방식은 push에만 있습니다 — pull은 원격지가 송신자 역할을 하므로 항상 원격지에 relayium이 이미 설치되어 있어야 합니다.",
      },
      {
        q: "사용법이 정말 scp만큼 간단한가요?",
        a: "명령어는 비슷해 보입니다: relayium push src user@host:dest는 scp -r src user@host:dest에 대응합니다. 차이는 무언가 잘못됐을 때만 드러납니다 — 연결이 끊겨도 처음부터가 아니라 이어서 재개하고, 모든 파일이 도착 시 체크섬으로 검증됩니다.",
      },
      {
        q: "언제 그냥 scp를 쓰는 게 좋나요?",
        a: "아무것도 재개할 필요가 없고, 검증도 필요 없고, 추가 바이너리도 원하지 않는 진짜 일회성 복사라면 — scp는 이미 거기 있고 더 간단한 선택입니다. 새 의존성을 원하지 않는 빠른 스크립트 안에서도 더 안전한 기본값입니다.",
      },
      {
        q: "Relayium의 CLI는 무료인가요?",
        a: "네, 완전히 무료입니다 — 유료 등급이 없고, AGPL-3.0 라이선스로 오픈소스이며, 모든 모드가 양쪽을 직접 연결합니다.",
      },
    ],
  },
  cta: {
    text: "무료 Relayium CLI를 설치하고, 이미 가지고 있는 SSH 접근으로 push나 pull을 써보세요.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. scp: einfachere Dateiübertragung über SSH",
  description:
    "scp ist universell und praktisch überall vorinstalliert. Relayium push/pull nutzen dasselbe SSH, ergänzen aber Wiederaufnahme, SHA-256-Prüfung, Fortschritt und einen Fallback für nackte Server. Ein fairer Vergleich.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "scp ist seit Jahrzehnten der Standardweg, eine Datei über SSH zu bewegen: schon auf praktisch jeder Unix-artigen Maschine installiert, jeder kennt die Syntax, und es funktioniert einfach. Es gibt keinen Grund, das kleinzureden — scp hat sich seinen Platz verdient.",
    "Die Relayium CLI ersetzt SSH nicht; sie nutzt genau denselben SSH-Zugang, den du bereits hast. push und pull verwenden deine SSH-Verbindung genauso wie scp, ergänzen aber ein paar Dinge, für die scp nie gebaut wurde: eine unterbrochene Übertragung fortsetzen, jede Datei mit einer Prüfsumme verifizieren, echten Fortschritt anzeigen, und funktionieren, selbst wenn auf der Gegenseite gar nichts installiert ist.",
  ],
  sections: [
    {
      heading: "Wo scp wirklich einfacher ist",
      body: ["Es lohnt sich, das klar zu sagen: Für viele Aufgaben ist scp das richtige Werkzeug, und alles andere ist unnötiger Overhead."],
      bullets: [
        "Es ist schon installiert — kein Binary zu holen, nichts einzurichten, auf praktisch jedem Server, in den du dich je per SSH einloggst.",
        "Es ist praxiserprobt. Jahrzehntelanger Einsatz, gut verstandenes Verhalten, und jeder Systemadministrator kennt die Flags bereits.",
        "Für einen echten Einzelfall — jetzt sofort diese eine Datei kopieren — ist scp file.txt user@host:path weniger Tipparbeit als irgendetwas zu installieren.",
        "Ideal für schnelle, wegwerfbare Skripte, bei denen du keine Abhängigkeit über OpenSSH hinaus willst.",
      ],
    },
    {
      heading: "push / pull: dasselbe SSH, mit Wiederaufnahme, Prüfsummen und Fortschritt",
      body: [
        "relayium push und relayium pull verbinden sich über exakt denselben SSH-Zugang, den auch scp nutzt — derselbe Host, derselbe Schlüssel, derselbe Port. Der Unterschied liegt darin, was passiert, sobald die Verbindung steht.",
        "Jede Datei wird nach der Ankunft Ende-zu-Ende mit einem SHA-256-Hash geprüft, sodass eine scheinbar fertige Übertragung wirklich Byte für Byte dem entspricht, was gesendet wurde. Wird eine Übertragung unterbrochen — Verbindungsabbruch, zugeklappter Laptop — nimmt ein erneuter Aufruf desselben Befehls dort weiter, wo aufgehört wurde, statt alles neu zu senden, und du siehst dabei echten dateiweisen Fortschritt statt einer stillen Kopie.",
        "Der größte praktische Unterschied zeigt sich, wenn auf der Gegenseite relayium nicht installiert ist. push prüft das automatisch und fällt, falls nicht vorhanden, auf einen einfachen tar-Archiv-Stream über dieselbe SSH-Verbindung zurück, der auf der anderen Seite in tar -x fließt — so funktioniert push auch gegen einen völlig nackten Server, ohne dass vorher irgendetwas installiert werden muss. Dieser Fallback existiert nur bei push: pull braucht immer relayium bereits auf der Gegenseite installiert, da bei einem pull die Gegenmaschine als Absender agiert.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Über SSH hinaus: daemon-direct und netzwerkübergreifendes Pairing",
      body: [
        "scp funktioniert nur dort, wo du SSH-Zugang hast. Die Relayium CLI fügt zwei weitere Wege hinzu, Dateien zu bewegen, für die scp kein Äquivalent hat.",
        "relayium serve macht aus einer dir gehörenden Maschine ein daemon-direct-Ziel, erreichbar über gepinntes TLS 1.3 — kein SSH, kein Port 22, Vertrauen entsteht bei der ersten Verbindung (interaktiv bestätigt oder mit relayium authorize für unbeaufsichtigten Betrieb vorab autorisiert) und ist danach gepinnt. Pushe direkt dorthin mit einer relayium://-Adresse.",
        "Um an jemanden über das Internet zu senden, bei dem du gar keinen SSH-Zugang hast, koppelt relayium send / receive stattdessen zwei Computer mit einem kurzen Code — direktes Peer-to-Peer, mit einem kurzen Prüfcode (SAS), den beide Seiten prüfen, bevor überhaupt Bytes fließen. Für diesen Fall hat scp keine Antwort; du bräuchtest zuerst SSH-Zugang.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "Ordnerspiegelung: sync statt scp -r wiederholt auszuführen",
      body: [
        "Ein ganzes Verzeichnis immer wieder mit scp -r zu kopieren bedeutet, jedes Mal alles neu zu senden, ohne ein Konzept dafür, was sich geändert hat oder gelöscht werden sollte. relayium sync baut auf push/pull oder daemon-direct einen inkrementellen Einweg-Spiegel auf: Nur geänderte Dateien werden bewegt, --delete entfernt Dateien am Ziel, die auf der Quelle verschwunden sind, und --watch synchronisiert laufend in Echtzeit neu, sobald sich lokale Dateien ändern — kein Cron-Job nötig.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Verfügbarkeit: scp ist praktisch auf jedem Server vorinstalliert; Relayiums CLI ist ein einzelnes Binary, das du einmal mit einem Befehl installierst.",
        "Wiederaufnahme: scp startet eine unterbrochene Übertragung von vorn; push/pull setzen dort fort, wo sie aufgehört haben.",
        "Integrität: scp verifiziert den Inhalt nicht im Nachhinein; jede Relayium-Übertragung wird mit einem dateiweisen SHA-256-Hash geprüft.",
        "Nackte Server: scp braucht nichts Zusätzliches; push funktioniert über seinen tar-Fallback genauso, wenn relayium remote nicht installiert ist (pull braucht relayium auf der Gegenseite, kein Fallback).",
        "Über SSH hinaus: scp funktioniert nur über SSH; Relayium bietet zusätzlich daemon-direct (gepinntes TLS, kein SSH) und netzwerkübergreifende Pairing-Code-Übertragungen (send/receive), die gar keinen SSH-Zugang benötigen.",
        "Ordnerspiegelung: scp -r sendet jedes Mal alles neu; relayium sync spiegelt inkrementell mit --delete und --watch.",
        "Kosten und Lizenz: beide kostenlos; scp wird mit OpenSSH ausgeliefert, Relayiums CLI ist AGPL-3.0-lizenziert und quelloffen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Braucht Relayiums CLI ein Konto?",
        a: "Nein. push/pull nutzt deinen eigenen SSH-Zugang genau wie scp — kein Relayium-Konto, keine Anmeldung, für keinen CLI-Modus.",
      },
      {
        q: "Funktioniert push, wenn auf dem entfernten Server kein Relayium installiert ist?",
        a: "Ja. push prüft zuerst und fällt, falls relayium nicht vorhanden ist, auf einen einfachen tar-Stream über dieselbe SSH-Verbindung zurück, sodass es auch gegen einen nackten Server funktioniert. Dieser Fallback existiert nur bei push — pull braucht immer relayium bereits auf der Gegenseite installiert, da die Gegenseite bei einem pull als Absender agiert.",
      },
      {
        q: "Ist es wirklich so einfach zu benutzen wie scp?",
        a: "Die Befehle sehen ähnlich aus: relayium push src user@host:dest statt scp -r src user@host:dest. Der Unterschied zeigt sich nur, wenn etwas schiefgeht — eine abgebrochene Verbindung wird fortgesetzt statt neu gestartet, und jede Datei wird bei Ankunft per Prüfsumme verifiziert.",
      },
      {
        q: "Wann sollte ich einfach scp verwenden?",
        a: "Für eine echte einmalige Kopie, bei der nichts fortgesetzt oder verifiziert werden muss und du kein zusätzliches Binary willst — scp ist schon da und die einfachere Wahl. Es ist auch die sicherere Standardwahl in schnellen Skripten, wenn du keine neue Abhängigkeit willst.",
      },
      {
        q: "Ist Relayiums CLI kostenlos?",
        a: "Ja, vollständig — keine bezahlte Stufe, AGPL-3.0-lizenziert und quelloffen, und jeder Modus verbindet die beiden Enden direkt.",
      },
    ],
  },
  cta: {
    text: "Installiere die kostenlose Relayium CLI und probiere push oder pull über den SSH-Zugang, den du bereits hast.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs scp : transfert plus simple par SSH",
  description:
    "scp est universel et préinstallé partout. Les commandes push/pull de Relayium utilisent le même SSH mais ajoutent la reprise, la vérification SHA-256, la progression et un repli pour les serveurs nus. Un comparatif honnête.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "scp est depuis des décennies le moyen par défaut de déplacer un fichier par SSH : déjà présent sur presque toutes les machines de type Unix, tout le monde connaît sa syntaxe, et ça marche tout simplement. Inutile de prétendre le contraire — la réputation de scp est méritée.",
    "La CLI Relayium ne remplace pas SSH ; elle s'appuie sur exactement le même accès SSH que vous avez déjà. push et pull utilisent votre connexion SSH de la même façon que scp, mais ajoutent quelques éléments que scp n'a jamais été conçu pour faire : reprendre un transfert interrompu, vérifier chaque fichier avec une somme de contrôle, afficher une vraie progression, et fonctionner même quand rien n'est installé côté distant.",
  ],
  sections: [
    {
      heading: "Là où scp est vraiment plus simple",
      body: ["Il faut le dire clairement : pour beaucoup de tâches, scp est le bon outil, et ajouter autre chose est un surcoût inutile."],
      bullets: [
        "Il est déjà installé — rien à télécharger, rien à configurer, sur pratiquement tous les serveurs sur lesquels vous vous connecterez un jour en SSH.",
        "Il est éprouvé. Des décennies d'usage, un comportement bien compris, et chaque administrateur système connaît déjà les options.",
        "Pour un vrai cas ponctuel — copier ce seul fichier, tout de suite — taper scp fichier.txt user@host:chemin demande moins d'efforts que d'installer quoi que ce soit.",
        "Idéal pour des scripts rapides et jetables où vous ne voulez aucune dépendance au-delà d'OpenSSH.",
      ],
    },
    {
      heading: "push / pull : le même SSH, avec reprise, sommes de contrôle et progression",
      body: [
        "relayium push et relayium pull se connectent via exactement le même accès SSH que celui utilisé par scp — même hôte, même clé, même port. La différence se joue dans ce qui se passe une fois la connexion ouverte.",
        "Chaque fichier est vérifié de bout en bout par une empreinte SHA-256 après son arrivée, si bien qu'un transfert qui semble terminé correspond réellement, octet pour octet, à ce qui a été envoyé. Si un transfert est interrompu — connexion coupée, capot d'ordinateur portable fermé — relancer la même commande reprend là où elle s'était arrêtée au lieu de tout renvoyer, avec une vraie progression par fichier visible tout du long, et non une copie silencieuse.",
        "La plus grande différence pratique concerne ce qui se passe quand la machine distante n'a pas Relayium installé. push le vérifie automatiquement et, si ce n'est pas le cas, bascule sur un simple flux tar transmis via la même connexion SSH vers un tar -x côté distant — push fonctionne donc même contre un serveur totalement nu, sans rien à installer au préalable. Ce repli n'existe que pour push : pull a toujours besoin de relayium déjà installé côté distant, car dans un pull, la machine distante joue le rôle d'expéditeur.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Au-delà de SSH : daemon-direct et appairage entre réseaux",
      body: [
        "scp ne fonctionne que là où vous avez un accès SSH. La CLI Relayium ajoute deux autres façons de déplacer des fichiers pour lesquelles scp n'a aucun équivalent.",
        "relayium serve transforme une machine que vous possédez en cible daemon-direct, accessible via TLS 1.3 épinglé — pas de SSH, pas de port 22, la confiance s'établit à la première connexion (approuvée de façon interactive, ou pré-autorisée avec relayium authorize pour un usage sans surveillance) puis reste épinglée ensuite. Poussez directement vers elle avec une adresse relayium://.",
        "Pour envoyer à quelqu'un sur Internet auprès de qui vous n'avez aucun accès SSH, relayium send / receive appaire à la place deux ordinateurs avec un court code — pair-à-pair direct, avec un court code de vérification (SAS) que les deux parties comparent avant que le moindre octet ne bouge. scp n'a aucune réponse à ce cas de figure ; il vous faudrait d'abord un accès SSH.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "Miroir de dossiers : sync contre scp -r relancé sans cesse",
      body: [
        "Copier un dossier entier encore et encore avec scp -r signifie tout renvoyer à chaque fois, sans aucune notion de ce qui a changé ou de ce qui devrait être supprimé. relayium sync construit un miroir incrémental à sens unique par-dessus push/pull ou daemon-direct : seuls les fichiers modifiés se déplacent, --delete supprime sur la destination les fichiers disparus de la source, et --watch continue de resynchroniser en temps réel dès qu'un fichier change localement — aucune tâche cron nécessaire.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "Disponibilité : scp est préinstallé sur pratiquement tous les serveurs ; la CLI Relayium est un binaire unique qui s'installe une fois en une commande.",
        "Reprise : scp relance une transmission interrompue depuis le début ; push/pull reprennent là où ils s'étaient arrêtés.",
        "Intégrité : scp ne vérifie pas le contenu après coup ; chaque transfert Relayium est vérifié par une empreinte SHA-256 par fichier.",
        "Serveurs nus : scp n'a besoin de rien de plus ; push fonctionne de la même façon via son repli tar quand relayium n'est pas installé côté distant (pull a besoin de relayium côté distant, sans repli).",
        "Au-delà de SSH : scp ne fonctionne que par SSH ; Relayium propose aussi le daemon-direct (TLS épinglé, sans SSH) et des transferts par code d'appairage entre réseaux différents (send/receive) qui ne nécessitent aucun accès SSH.",
        "Miroir de dossiers : scp -r renvoie tout à chaque fois ; relayium sync effectue un miroir incrémental avec --delete et --watch.",
        "Coût et licence : les deux sont gratuits ; scp est fourni avec OpenSSH, la CLI Relayium est sous licence AGPL-3.0 et open source.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La CLI Relayium a-t-elle besoin d'un compte ?",
        a: "Non. push/pull utilise votre propre accès SSH exactement comme scp — aucun compte Relayium, aucune connexion, pour aucun mode de la CLI.",
      },
      {
        q: "push fonctionne-t-il si le serveur distant n'a pas Relayium installé ?",
        a: "Oui. push vérifie d'abord et, si relayium n'est pas présent, bascule sur un simple flux tar via la même connexion SSH, ce qui fonctionne donc même contre un serveur nu. Ce repli n'existe que pour push — pull a toujours besoin de relayium déjà installé côté distant, puisque la machine distante joue le rôle d'expéditeur dans un pull.",
      },
      {
        q: "Est-ce vraiment aussi simple à utiliser que scp ?",
        a: "Les commandes se ressemblent : relayium push src user@host:dest au lieu de scp -r src user@host:dest. La différence n'apparaît que quand quelque chose tourne mal — une connexion coupée reprend au lieu de repartir de zéro, et chaque fichier est vérifié par somme de contrôle à l'arrivée.",
      },
      {
        q: "Quand devrais-je simplement utiliser scp ?",
        a: "Pour une copie ponctuelle réelle, où rien n'a besoin de reprendre, rien n'a besoin d'être vérifié, et où vous ne voulez aucun binaire supplémentaire — scp est déjà là et reste le choix le plus simple. C'est aussi le choix par défaut le plus sûr dans des scripts rapides où vous ne voulez pas d'une nouvelle dépendance.",
      },
      {
        q: "La CLI Relayium est-elle gratuite ?",
        a: "Oui, entièrement — aucun palier payant, sous licence AGPL-3.0 et open source, et chaque mode connecte directement les deux extrémités.",
      },
    ],
  },
  cta: {
    text: "Installez la CLI Relayium gratuite et essayez push ou pull avec l'accès SSH que vous avez déjà.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل scp: نقل ملفات أبسط عبر SSH",
  description:
    "scp عالمي ومثبَّت مسبقًا. أمرا push/pull في Relayium يستخدمان نفس SSH لكنهما يضيفان الاستئناف والتحقق بـ SHA-256 والتقدّم وحلًّا احتياطيًا للخوادم الخالية. مقارنة منصفة.",
  updatedLabel: "آخر تحديث",
  lead: [
    "ظل scp لعقود الطريقة الافتراضية لنقل ملف عبر SSH: فهو موجود سلفًا على كل جهاز شبيه بـ Unix تقريبًا، والجميع يعرف صيغته، وهو ببساطة يعمل. لا داعي للتظاهر بغير ذلك — فقد استحق scp مكانته عن جدارة.",
    "لا تحل واجهة Relayium السطرية محل SSH؛ بل تركب فوق نفس وصول SSH الذي تملكه أصلًا. يستخدم push وpull اتصال SSH الخاص بك بالطريقة نفسها التي يستخدمها scp، لكنهما يضيفان بضعة أمور لم يُبنَ scp أصلًا للقيام بها: استئناف نقل انقطع، والتحقق من كل ملف بمجموع تحقق، وإظهار تقدّم فعلي، والعمل حتى عندما لا يكون في الطرف البعيد أي شيء مثبَّت على الإطلاق.",
  ],
  sections: [
    {
      heading: "حيث يكون scp أبسط فعلًا",
      body: [
        "يستحق الأمر أن يُقال بصراحة: في كثير من المهام، scp هو الأداة الصحيحة، وإضافة أي شيء آخر تُعد عبئًا زائدًا.",
      ],
      bullets: [
        "إنه مثبَّت سلفًا — لا ملف تنفيذي لجلبه، ولا شيء لإعداده، على كل خادم ستسجّل الدخول إليه عبر SSH فعليًا.",
        "إنه مُختبَر في الميدان. عقود من الاستخدام، وسلوك مفهوم جيدًا، وكل مسؤول نظام يعرف أعلامه بالفعل.",
        "لمهمة عابرة حقيقية — انسخ هذا الملف الواحد، الآن — فإن كتابة scp file.txt user@host:path تتطلب حروفًا أقل من تثبيت أي شيء.",
        "إنه مثالي للسكربتات السريعة العابرة التي لا تريد فيها أي تبعية تتجاوز OpenSSH.",
      ],
    },
    {
      heading: "push / pull: نفس SSH، مع الاستئناف ومجاميع التحقق والتقدّم",
      body: [
        "يتصل relayium push وrelayium pull عبر نفس وصول SSH الذي يستخدمه scp تمامًا — نفس المضيف، ونفس المفتاح، ونفس المنفذ. الفرق هو ما يحدث بمجرد أن يُفتح الاتصال.",
        "يُتحقَّق من كل ملف من الطرف إلى الطرف عبر تجزئة SHA-256 بعد وصوله، بحيث إن النقل الذي يبدو مكتملًا يطابق فعلًا ما أُرسل، بايتًا ببايت. وإذا انقطع نقلٌ ما — اتصال سقط، أو غطاء حاسوب محمول أُغلق — فإن إعادة تشغيل الأمر نفسه تلتقط من حيث توقفت بدلًا من إعادة إرسال كل شيء، وترى تقدّمًا حقيقيًا لكل ملف طوال الطريق، لا نسخًا صامتًا.",
        "أكبر فرق عملي هو ما يحدث عندما لا يكون في الطرف البعيد relayium مثبَّتًا. يتحقق push من ذلك تلقائيًا، وإن لم يكن موجودًا، يتراجع إلى بث أرشيف tar بسيط عبر نفس اتصال SSH ليصب في tar -x على الطرف الآخر — فيظل push يعمل مقابل خادم خالٍ تمامًا، دون تثبيت أي شيء أولًا. هذا الحل الاحتياطي خاص بـ push فقط: يحتاج pull دائمًا إلى relayium مثبَّتًا سلفًا في الطرف البعيد، لأن الجهاز البعيد في عملية pull هو الذي يعمل كمُرسِل.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "ما وراء SSH: daemon-direct والاقتران عبر الشبكات",
      body: [
        "لا يعمل scp إلا حيث يكون لديك وصول SSH. تضيف واجهة Relayium السطرية طريقتين أخريين لنقل الملفات لا يملك scp ما يعادلهما.",
        "يحوّل relayium serve جهازًا تملكه إلى هدف daemon-direct يمكن الوصول إليه عبر TLS 1.3 مثبَّت — بلا SSH، ولا منفذ 22، تُنشأ الثقة عند أول اتصال (تُوافَق عليها تفاعليًا، أو تُصرَّح مسبقًا بـ relayium authorize للاستخدام دون إشراف) وتظل مثبَّتة بعد ذلك. ادفع إليه مباشرة بعنوان relayium://.",
        "للإرسال إلى شخص عبر الإنترنت لا تملك تجاهه أي وصول SSH على الإطلاق، يقرن relayium send / receive حاسوبين برمز قصير بدلًا من ذلك — من الند للند مباشرةً، مع رمز تحقق قصير (SAS) يتحقق منه الطرفان قبل أن تتحرك أي بايتات. لا جواب لدى scp لهذه الحالة؛ ستحتاج إلى وصول SSH أولًا.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "مزامنة المجلدات: sync مقابل إعادة تشغيل scp -r",
      body: [
        "نسخ مجلد كامل مرارًا وتكرارًا بـ scp -r يعني إعادة إرسال كل شيء في كل مرة، دون أي مفهوم لما تغيّر أو لما ينبغي إزالته. يبني relayium sync مرآة تزايدية أحادية الاتجاه فوق push/pull أو daemon-direct: تُنقل الملفات المتغيرة فقط، و--delete يزيل من الوجهة الملفات التي اختفت من المصدر، و--watch يواصل إعادة المزامنة في الوقت الفعلي كلما تغيّرت الملفات محليًا — دون الحاجة إلى مهمة cron.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: ["أهم الفروق، جنبًا إلى جنب:"],
      bullets: [
        "التوفّر: scp مثبَّت مسبقًا على كل خادم تقريبًا؛ واجهة Relayium السطرية ملف تنفيذي واحد تثبّته مرة واحدة بأمر واحد.",
        "الاستئناف: يعيد scp نقلًا منقطعًا من الصفر؛ بينما يستأنف push/pull من حيث توقفا.",
        "السلامة: لا يتحقق scp من المحتوى بعد الحدث؛ بينما يُفحص كل نقل في Relayium بتجزئة SHA-256 لكل ملف.",
        "الخوادم الخالية: لا يحتاج scp إلى أي شيء إضافي، ويعمل push بالطريقة نفسها عبر حله الاحتياطي بـ tar عندما لا يكون relayium مثبَّتًا عن بُعد (يحتاج pull إلى relayium في الطرف البعيد، بلا حل احتياطي).",
        "ما وراء SSH: يعمل scp عبر SSH فقط؛ بينما يقدّم Relayium أيضًا daemon-direct (TLS مثبَّت، بلا SSH) ونقلات برمز الاقتران عبر الشبكات (send/receive) لا تحتاج إلى أي وصول SSH على الإطلاق.",
        "مزامنة المجلدات: يعيد scp -r إرسال كل شيء؛ بينما يزامن relayium sync بشكل تزايدي مع --delete و--watch.",
        "التكلفة والترخيص: كلاهما مجاني؛ scp يأتي مع OpenSSH، وواجهة Relayium السطرية مرخّصة بـ AGPL-3.0 ومفتوحة المصدر.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل تحتاج واجهة Relayium السطرية إلى حساب؟",
        a: "لا. يستخدم push/pull وصول SSH الخاص بك تمامًا كما يفعل scp — بلا حساب Relayium، وبلا تسجيل دخول، لأي وضع من أوضاع الواجهة السطرية.",
      },
      {
        q: "هل يعمل push إذا لم يكن الخادم البعيد يحتوي على Relayium مثبَّتًا؟",
        a: "نعم. يتحقق push أولًا، وإن لم يكن relayium موجودًا، يتراجع إلى بث tar بسيط عبر نفس اتصال SSH فيظل يعمل مقابل خادم خالٍ. هذا الحل الاحتياطي خاص بـ push فقط — يحتاج pull دائمًا إلى relayium مثبَّتًا سلفًا في الطرف البعيد، لأن الطرف البعيد يعمل كمُرسِل في عملية pull.",
      },
      {
        q: "هل هو حقًا بسيط في الاستخدام كـ scp؟",
        a: "تبدو الأوامر متشابهة: relayium push src user@host:dest بدلًا من scp -r src user@host:dest. لا يظهر الفرق إلا عندما يسوء شيء ما — يُستأنف اتصال سقط بدلًا من إعادة البدء، ويُتحقق من كل ملف بمجموع تحقق عند الوصول.",
      },
      {
        q: "متى ينبغي أن أستخدم scp ببساطة بدلًا منه؟",
        a: "لنسخة عابرة حقيقية لا يحتاج فيها شيء إلى استئناف، ولا يحتاج شيء إلى تحقق، ولا تريد أي ملف تنفيذي إضافي — فإن scp موجود سلفًا وهو الخيار الأبسط. وهو أيضًا الخيار الافتراضي الأكثر أمانًا داخل السكربتات السريعة حيث لا تريد تبعية جديدة.",
      },
      {
        q: "هل واجهة Relayium السطرية مجانية؟",
        a: "نعم، بالكامل — لا فئة مدفوعة، مرخّصة بـ AGPL-3.0 ومفتوحة المصدر، وكل وضع يصل الطرفين مباشرةً.",
      },
    ],
  },
  cta: {
    text: "ثبّت واجهة Relayium السطرية المجانية وجرّب push أو pull عبر وصول SSH الذي تملكه أصلًا.",
    button: "احصل على الواجهة السطرية",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium vs scp: transferencia de archivos más sencilla por SSH",
  description:
    "scp es universal y viene preinstalado. Las órdenes push/pull de Relayium usan el mismo SSH pero añaden reanudación, verificación SHA-256, progreso y un plan de reserva para servidores desnudos. Una comparativa justa.",
  updatedLabel: "Última actualización",
  lead: [
    "scp ha sido durante décadas la forma predeterminada de mover un archivo por SSH: ya está en casi todas las máquinas de tipo Unix, todo el mundo conoce su sintaxis y simplemente funciona. No hay motivo para fingir lo contrario: scp se ha ganado su lugar.",
    "La CLI de Relayium no reemplaza a SSH; se apoya exactamente en el mismo acceso SSH que ya tienes. push y pull usan tu conexión SSH igual que scp, pero añaden algunas cosas para las que scp nunca se construyó: reanudar una transferencia interrumpida, verificar cada archivo con una suma de comprobación, mostrar progreso real y funcionar incluso cuando en el extremo remoto no hay nada instalado.",
  ],
  sections: [
    {
      heading: "Donde scp es realmente más sencillo",
      body: [
        "Conviene decirlo con claridad: para muchas tareas, scp es la herramienta adecuada y añadir cualquier otra cosa es una carga innecesaria.",
      ],
      bullets: [
        "Ya está instalado: no hay ningún binario que descargar ni nada que configurar, en prácticamente todos los servidores a los que jamás entrarás por SSH.",
        "Está probado en la práctica. Décadas de uso, un comportamiento bien entendido y todos los administradores de sistemas ya conocen sus opciones.",
        "Para un caso puntual de verdad —copiar este único archivo, ahora mismo— escribir scp file.txt user@host:path es menos teclear que instalar nada.",
        "Es ideal para scripts rápidos y desechables en los que no quieres ninguna dependencia más allá de OpenSSH.",
      ],
    },
    {
      heading: "push / pull: el mismo SSH, con reanudación, sumas de comprobación y progreso",
      body: [
        "relayium push y relayium pull se conectan a través del acceso SSH idéntico que usa scp: el mismo host, la misma clave, el mismo puerto. La diferencia está en lo que ocurre una vez abierta la conexión.",
        "Cada archivo se verifica de extremo a extremo con un hash SHA-256 tras su llegada, de modo que una transferencia que parece terminada coincide realmente, byte a byte, con lo que se envió. Si una transferencia se interrumpe —una conexión caída, la tapa de un portátil cerrada— volver a ejecutar la misma orden retoma justo donde se quedó en lugar de reenviarlo todo, y ves progreso real por archivo durante todo el proceso, no una copia silenciosa.",
        "La mayor diferencia práctica es lo que ocurre cuando el remoto no tiene relayium instalado. push lo comprueba automáticamente y, si no está, recurre a transmitir un simple archivo tar por la misma conexión SSH hacia un tar -x en el otro extremo, de modo que push sigue funcionando contra un servidor totalmente desnudo, sin nada que instalar antes. Ese plan de reserva es exclusivo de push: pull siempre necesita relayium ya instalado en el remoto, porque en un pull la máquina remota es la que actúa como remitente.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Más allá de SSH: daemon-direct y emparejamiento entre redes",
      body: [
        "scp solo funciona donde tienes acceso SSH. La CLI de Relayium añade dos formas más de mover archivos para las que scp no tiene equivalente.",
        "relayium serve convierte una máquina de tu propiedad en un destino daemon-direct accesible por TLS 1.3 fijado (pinned): sin SSH, sin puerto 22, la confianza se establece en la primera conexión (aprobada de forma interactiva, o preautorizada con relayium authorize para un uso desatendido) y queda fijada a partir de ahí. Haz push directamente hacia ella con una dirección relayium://.",
        "Para enviar por internet a alguien sobre quien no tienes ningún acceso SSH, relayium send / receive empareja en su lugar dos ordenadores con un código corto: de igual a igual directo, con un código de verificación corto (SAS) que ambas partes comparan antes de que se mueva un solo byte. scp no tiene respuesta para ese caso; primero necesitarías acceso SSH.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "Réplica de carpetas: sync frente a reejecutar scp -r",
      body: [
        "Copiar una carpeta entera una y otra vez con scp -r significa reenviarlo todo cada vez, sin ninguna noción de qué cambió o qué debería eliminarse. relayium sync construye una réplica incremental unidireccional sobre push/pull o daemon-direct: solo se mueven los archivos modificados, --delete elimina en el destino los archivos que desaparecieron del origen, y --watch sigue resincronizando en tiempo real cada vez que un archivo cambia localmente, sin necesidad de una tarea cron.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Comparativa de funciones de un vistazo",
      body: ["Las diferencias que más importan, una al lado de la otra:"],
      bullets: [
        "Disponibilidad: scp viene preinstalado en prácticamente todos los servidores; la CLI de Relayium es un único binario que instalas una vez con una sola orden.",
        "Reanudación: scp reinicia desde cero una transferencia interrumpida; push/pull reanudan desde donde se detuvieron.",
        "Integridad: scp no verifica el contenido a posteriori; cada transferencia de Relayium se comprueba con un hash SHA-256 por archivo.",
        "Servidores desnudos: scp no necesita nada extra, y push funciona igual mediante su reserva con tar cuando relayium no está instalado en el remoto (pull necesita relayium en el remoto, sin reserva).",
        "Más allá de SSH: scp solo funciona por SSH; Relayium ofrece además daemon-direct (TLS fijado, sin SSH) y transferencias por código de emparejamiento entre redes (send/receive) que no requieren ningún acceso SSH.",
        "Réplica de carpetas: scp -r reenvía todo cada vez; relayium sync replica de forma incremental con --delete y --watch.",
        "Coste y licencia: ambos gratis; scp viene con OpenSSH, la CLI de Relayium está bajo licencia AGPL-3.0 y es de código abierto.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿La CLI de Relayium necesita una cuenta?",
        a: "No. push/pull usa tu propio acceso SSH exactamente igual que scp: sin cuenta de Relayium, sin iniciar sesión, para cualquier modo de la CLI.",
      },
      {
        q: "¿Funciona push si el servidor remoto no tiene Relayium instalado?",
        a: "Sí. push lo comprueba primero y, si relayium no está, recurre a un simple flujo tar por la misma conexión SSH, de modo que sigue funcionando contra un servidor desnudo. Ese plan de reserva es exclusivo de push: pull siempre necesita relayium ya instalado en el remoto, ya que el remoto actúa como remitente en un pull.",
      },
      {
        q: "¿Es realmente tan sencillo de usar como scp?",
        a: "Las órdenes se parecen: relayium push src user@host:dest en lugar de scp -r src user@host:dest. La diferencia solo aparece cuando algo va mal: una conexión caída se reanuda en vez de reiniciar, y cada archivo se verifica con suma de comprobación al llegar.",
      },
      {
        q: "¿Cuándo debería usar simplemente scp?",
        a: "Para una copia puntual de verdad en la que nada necesita reanudarse, nada necesita verificarse y no quieres ningún binario extra, scp ya está ahí y es la opción más sencilla. También es la opción predeterminada más segura dentro de scripts rápidos en los que no quieres una nueva dependencia.",
      },
      {
        q: "¿La CLI de Relayium es gratis?",
        a: "Sí, por completo: sin nivel de pago, con licencia AGPL-3.0 y de código abierto, y cada modo conecta ambos extremos directamente.",
      },
    ],
  },
  cta: {
    text: "Instala la CLI gratuita de Relayium y prueba push o pull con el acceso SSH que ya tienes.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs scp: transferência de arquivos mais simples por SSH",
  description:
    "O scp é universal e vem pré-instalado. Os comandos push/pull do Relayium usam o mesmo SSH, mas acrescentam retomada, verificação SHA-256, progresso e um plano de reserva para servidores vazios. Um comparativo justo.",
  updatedLabel: "Última atualização",
  lead: [
    "Há décadas o scp é a forma padrão de mover um arquivo por SSH: já está em quase toda máquina do tipo Unix, todo mundo conhece a sintaxe e ele simplesmente funciona. Não há motivo para fingir o contrário — o scp conquistou seu lugar.",
    "A CLI do Relayium não substitui o SSH; ela se apoia exatamente no mesmo acesso SSH que você já tem. push e pull usam sua conexão SSH do mesmo jeito que o scp, mas acrescentam algumas coisas para as quais o scp nunca foi feito: retomar uma transferência interrompida, verificar cada arquivo com uma soma de verificação, mostrar progresso real e funcionar mesmo quando não há nada instalado do lado remoto.",
  ],
  sections: [
    {
      heading: "Onde o scp é realmente mais simples",
      body: [
        "Vale dizer com clareza: para muitas tarefas, o scp é a ferramenta certa e acrescentar qualquer outra coisa é peso extra.",
      ],
      bullets: [
        "Ele já está instalado — nenhum binário para baixar, nada para configurar, em praticamente todo servidor no qual você um dia entrará por SSH.",
        "É testado no campo. Décadas de uso, comportamento bem compreendido e todo administrador de sistemas já conhece as opções.",
        "Para um caso pontual de verdade — copiar este único arquivo, agora mesmo — digitar scp file.txt user@host:path dá menos trabalho do que instalar qualquer coisa.",
        "É ideal para scripts rápidos e descartáveis nos quais você não quer nenhuma dependência além do OpenSSH.",
      ],
    },
    {
      heading: "push / pull: o mesmo SSH, com retomada, somas de verificação e progresso",
      body: [
        "relayium push e relayium pull se conectam pelo acesso SSH idêntico ao que o scp usa — mesmo host, mesma chave, mesma porta. A diferença está no que acontece depois que a conexão é aberta.",
        "Cada arquivo é verificado de ponta a ponta com um hash SHA-256 após chegar, de modo que uma transferência que parece concluída realmente corresponde, byte a byte, ao que foi enviado. Se uma transferência é interrompida — uma conexão caída, a tampa de um notebook fechada — reexecutar o mesmo comando retoma de onde parou em vez de reenviar tudo, e você vê progresso real por arquivo o tempo todo, não uma cópia silenciosa.",
        "A maior diferença prática é o que acontece quando o remoto não tem o relayium instalado. push verifica isso automaticamente e, se não estiver, recorre a transmitir um simples arquivo tar pela mesma conexão SSH para um tar -x do outro lado — assim, push continua funcionando contra um servidor totalmente vazio, sem nada para instalar antes. Esse plano de reserva é exclusivo do push: pull sempre precisa do relayium já instalado no remoto, porque num pull a máquina remota é a que atua como remetente.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Além do SSH: daemon-direct e emparelhamento entre redes",
      body: [
        "O scp só funciona onde você tem acesso SSH. A CLI do Relayium acrescenta mais duas formas de mover arquivos para as quais o scp não tem equivalente.",
        "relayium serve transforma uma máquina sua num destino daemon-direct acessível por TLS 1.3 fixado (pinned) — sem SSH, sem porta 22, a confiança se estabelece na primeira conexão (aprovada de forma interativa, ou pré-autorizada com relayium authorize para uso sem supervisão) e fica fixada dali em diante. Faça push direto para ela com um endereço relayium://.",
        "Para enviar pela internet a alguém sobre quem você não tem nenhum acesso SSH, relayium send / receive emparelha, em vez disso, dois computadores com um código curto — ponto a ponto direto, com um código de verificação curto (SAS) que os dois lados comparam antes de qualquer byte se mover. O scp não tem resposta para esse caso; você precisaria antes de acesso SSH.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf ABCD-1234"],
    },
    {
      heading: "Espelhamento de pastas: sync versus reexecutar scp -r",
      body: [
        "Copiar uma pasta inteira repetidamente com scp -r significa reenviar tudo toda vez, sem nenhuma noção do que mudou ou do que deveria ser removido. relayium sync constrói um espelho incremental unidirecional sobre push/pull ou daemon-direct: só os arquivos alterados se movem, --delete remove no destino os arquivos que sumiram da origem, e --watch continua ressincronizando em tempo real sempre que um arquivo muda localmente — sem precisar de tarefa cron.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Comparativo de recursos num relance",
      body: ["As diferenças que mais importam, lado a lado:"],
      bullets: [
        "Disponibilidade: o scp vem pré-instalado em praticamente todo servidor; a CLI do Relayium é um único binário que você instala uma vez com um comando.",
        "Retomada: o scp reinicia do zero uma transferência interrompida; push/pull retomam de onde pararam.",
        "Integridade: o scp não verifica o conteúdo depois; cada transferência do Relayium é checada com um hash SHA-256 por arquivo.",
        "Servidores vazios: o scp não precisa de nada extra, e push funciona do mesmo jeito via sua reserva com tar quando o relayium não está instalado no remoto (pull precisa do relayium no remoto, sem reserva).",
        "Além do SSH: o scp só funciona por SSH; o Relayium também oferece daemon-direct (TLS fixado, sem SSH) e transferências por código de emparelhamento entre redes (send/receive) que não precisam de nenhum acesso SSH.",
        "Espelhamento de pastas: scp -r reenvia tudo toda vez; relayium sync espelha de forma incremental com --delete e --watch.",
        "Custo e licença: ambos gratuitos; o scp vem com o OpenSSH, a CLI do Relayium é licenciada sob AGPL-3.0 e de código aberto.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "A CLI do Relayium precisa de conta?",
        a: "Não. push/pull usa seu próprio acesso SSH exatamente como o scp — sem conta Relayium, sem fazer login, para qualquer modo da CLI.",
      },
      {
        q: "push funciona se o servidor remoto não tiver o Relayium instalado?",
        a: "Sim. push verifica primeiro e, se o relayium não estiver lá, recorre a um simples fluxo tar pela mesma conexão SSH, de modo que continua funcionando contra um servidor vazio. Esse plano de reserva é exclusivo do push — pull sempre precisa do relayium já instalado no remoto, já que o remoto atua como remetente num pull.",
      },
      {
        q: "É mesmo tão simples de usar quanto o scp?",
        a: "Os comandos se parecem: relayium push src user@host:dest em vez de scp -r src user@host:dest. A diferença só aparece quando algo dá errado — uma conexão caída é retomada em vez de reiniciar, e cada arquivo é verificado por soma de verificação na chegada.",
      },
      {
        q: "Quando devo simplesmente usar o scp?",
        a: "Para uma cópia pontual de verdade em que nada precisa ser retomado, nada precisa ser verificado e você não quer nenhum binário extra, o scp já está ali e é a escolha mais simples. Também é a opção padrão mais segura dentro de scripts rápidos em que você não quer uma nova dependência.",
      },
      {
        q: "A CLI do Relayium é gratuita?",
        a: "Sim, totalmente — sem nível pago, licenciada sob AGPL-3.0 e de código aberto, e cada modo conecta as duas pontas diretamente.",
      },
    ],
  },
  cta: {
    text: "Instale a CLI gratuita do Relayium e experimente push ou pull com o acesso SSH que você já tem.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/scp",
  published: "2026-07-09",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
