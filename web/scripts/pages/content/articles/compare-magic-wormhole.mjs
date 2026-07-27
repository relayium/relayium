// web/scripts/pages/content/articles/compare-magic-wormhole.mjs
// Fair CLI-vs-CLI comparison: Relayium's CLI vs magic-wormhole. English is the
// master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Command/code snippets stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Relayium vs magic-wormhole: CLI file transfer",
  description:
    "Both magic-wormhole and Relayium's CLI move files between terminals with a short code and end-to-end encryption. A fair comparison, including the one honest tradeoff worth knowing.",
  updatedLabel: "Last updated",
  lead: [
    "magic-wormhole has quietly earned a loyal following: run it, get a short human-readable code like 7-crossover-clockwork, read it to the other person, and the file arrives — encrypted the whole way, with no account and no server you have to think about. Relayium's CLI is built around a similar idea, a short code that pairs two computers directly and encrypts everything in between.",
    "They overlap a lot, and where they don't, it's worth being precise about it — including the one place magic-wormhole is genuinely more resilient than Relayium's CLI today.",
  ],
  sections: [
    {
      heading: "What they have in common",
      body: [
        "Both tools solve the same core problem the same honest way: no file staged on a server you don't control, and a short code as the only thing the two ends pass between them out of band. magic-wormhole needs no account at all; Relayium asks only the sender to sign in, so its server can mint that code, and the receiver still doesn't.",
      ],
      bullets: [
        "End-to-end encrypted: magic-wormhole derives a session key from the wormhole code itself using a PAKE (SPAKE2), so even its own rendezvous server never learns the key; Relayium's send/receive does an X25519 key exchange between the two ends directly and shows a short verification code (SAS) you can compare before any bytes move.",
        "No account to receive, on either tool — and none at all for magic-wormhole.",
        "Free and open source — read the code that touches your files.",
        "Cross-platform: macOS, Linux and Windows.",
      ],
    },
    {
      heading: "The one place magic-wormhole is more resilient: it has a relay",
      body: [
        "This is the honest tradeoff, and it's worth stating plainly rather than glossing over. magic-wormhole ships with a Transit Relay it can fall back to when the two ends can't open a direct connection to each other — for example, both sides sitting behind strict or symmetric NAT with no way to punch through. The relay only ever sees ciphertext, but because it's there, the transfer still completes.",
        "Relayium's send/receive is direct-only: it races a direct connection for a few seconds right after the handshake, and if it can't find one, the transfer fails outright rather than falling back to any relay — Relayium's servers never touch cross-network CLI file bytes at all, by design. In practice that's rare (most home and office networks allow a direct path), but if you're moving files between two machines that are both behind unusually strict NATs, magic-wormhole is more likely to just work. If a direct path can't be found and reliability matters more than avoiding a relay, that's the case for reaching for magic-wormhole — or for using Relayium's push/pull or daemon-direct against a server you can actually reach, which don't depend on that direct P2P hop at all.",
      ],
    },
    {
      heading: "SSH and daemon-direct: talking to a server you already run",
      body: [
        "Where Relayium's CLI adds real surface area is outside the one-off pairing-code case: two more ways to move files that lean on infrastructure you already have, which magic-wormhole doesn't attempt to cover.",
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
      heading: "Folder sync and a self-hostable server",
      body: [
        "magic-wormhole sends a batch of files (or a folder, zipped) and exits — send it again to update the other side, with no notion of what should be removed. Relayium's CLI adds relayium sync, an incremental one-way mirror over either transport above: it only moves what changed, --delete removes files on the destination that disappeared from the source (a daemon only honors it if it was started with --allow-delete, so a receiver has to opt in), and --watch keeps re-syncing in real time as files change, with no cron job needed.",
        "Relayium's server is also self-hostable as a single Docker container if you want to run the whole thing yourself rather than rely on relayium.com; point the CLI at it with --server.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "No direct path available: magic-wormhole's Transit Relay carries the encrypted stream so the transfer still completes; Relayium's send/receive is direct-only and fails in that case.",
        "Talking to a server: Relayium reuses your SSH access (push/pull) or a pinned-TLS daemon; magic-wormhole has no SSH integration — install it on both ends and share a code.",
        "Folder sync: relayium sync mirrors incrementally with --delete and --watch; magic-wormhole sends a batch (or a zipped folder) and exits, with no mirror or delete semantics.",
        "Verification: both are encrypted end to end; Relayium's send/receive additionally shows a short SAS code both sides compare before the transfer starts.",
        "Self-hosting: Relayium's server is a single Docker image you can run yourself, serving both the CLI and the browser app; the CLI's send/receive can point at it with --server.",
        "License and cost: both free and open source. magic-wormhole needs no account at all; Relayium needs one only for send, to mint the pairing code.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is Relayium's CLI free?",
        a: "Yes, completely. There's no paid tier and nothing to meter — every mode connects the two ends directly, and the CLI is open source.",
      },
      {
        q: "Does it need an account?",
        a: "send does, and so does cloud up. push/pull uses your own SSH access and daemon-direct uses pinned-TLS certificate trust between your machines, so neither touches a Relayium account. send/receive is the exception: only the server can mint a pairing code, and only for a signed-in account, so the sender runs relayium login once — a send given a code you were handed mints nothing and needs no login. Receiving never needs an account.",
      },
      {
        q: "What if I'm behind a strict NAT and there's no direct path?",
        a: "Relayium's send/receive is direct-only and will fail in that case — it doesn't fall back to a relay. magic-wormhole's Transit Relay can still carry the encrypted stream and complete the transfer. If you need it to work no matter what the network looks like, magic-wormhole handles that case today; Relayium's push/pull or daemon-direct against a server you can reach work too, since they don't depend on a direct P2P hop.",
      },
      {
        q: "Can I use the CLI's pairing code with Relayium's browser app?",
        a: "Not yet for a live paired transfer — the CLI's send/receive uses its own direct handshake, separate from the browser's WebRTC-based pairing flow, so the two don't interoperate today. To hand a file to someone using only a browser, use Relayium's stored download link or the browser app's own pairing-code mode.",
      },
      {
        q: "Can I self-host it?",
        a: "Yes. Relayium's server ships as a Docker image (docker compose up -d --build), and you can point the CLI's send/receive at your own instance with --server https://your-domain.",
      },
    ],
  },
  cta: {
    text: "Install the free Relayium CLI and try push, sync or send — free, and a code-based transfer as quick to start as magic-wormhole.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 magic-wormhole：命令行文件传输",
  description:
    "magic-wormhole 和 Relayium CLI 都能用一段简短口令在终端之间端到端加密传输文件。本文客观比较两者，也如实说明一处 Relayium 目前不如它的地方。",
  updatedLabel: "最近更新",
  lead: [
    "magic-wormhole 悄悄积累了一批忠实用户：运行它，得到一段像 7-crossover-clockwork 这样简短易读的口令，把口令念给对方听，文件就到了——全程加密，不需要账号，也不用操心什么服务器。Relayium CLI 的思路与之相似，用一段简短的配对码直接配对两台电脑，并加密两者之间传输的一切。",
    "两者重合之处不少，不重合的地方也值得说清楚——包括一处 magic-wormhole 今天确实比 Relayium CLI 更稳健的地方。",
  ],
  sections: [
    {
      heading: "两者的共同点",
      body: [
        "两个工具用同样老实的方式解决同一个核心问题：文件不会滞留在你无法掌控的服务器上，两端之间唯一需要线下传递的就是一段简短口令。magic-wormhole 完全不需要账号；Relayium 只在需要服务器签发配对码时要求发送方登录，接收方依然不用。",
      ],
      bullets: [
        "端到端加密：magic-wormhole 用一种 PAKE（SPAKE2）算法直接从 wormhole 口令本身推导出会话密钥，就连它自己的会合服务器也永远不会知道这个密钥；Relayium 的 send/receive 在两端之间直接做 X25519 密钥交换，并在任何字节移动之前展示一段简短的验证码（SAS）供双方核对。",
        "两者接收都不需要账号——magic-wormhole 更是完全不需要。",
        "免费开源——你可以阅读接触你文件的每一行代码。",
        "跨平台：macOS、Linux 和 Windows。",
      ],
    },
    {
      heading: "magic-wormhole 更稳健的一点：它有中继可退",
      body: [
        "这是需要老实说明的一处权衡，而不是含糊带过。magic-wormhole 自带一个 Transit Relay，当两端无法彼此建立直连时（比如双方都处在严格或对称 NAT 之后，怎么都打不通），传输可以退化到走这个中继。中继始终只能看到密文，但正因为它存在，传输依然能够完成。",
        "Relayium 的 send/receive 是纯直连的：在握手结束后它会花几秒钟尝试建立一条直连，如果找不到，传输会直接失败，而不会退回到任何中继——按设计，Relayium 的服务器完全不会碰跨网络 CLI 传输的文件字节。实际中这种情况并不常见（大多数家庭和办公网络都能打通直连路径），但如果你要在两台都处于异常严格 NAT 之后的机器之间传文件，magic-wormhole 更有可能直接成功。如果打不通直连路径，而可靠性比“避免中继”更重要，那正是该用 magic-wormhole 的场景——或者改用 Relayium 的 push/pull 或对一台你能真正连到的服务器做 daemon-direct，这两者根本不依赖那一跳点对点直连。",
      ],
    },
    {
      heading: "SSH 与 daemon-direct：对接你已有的服务器",
      body: [
        "Relayium CLI 真正多出来的能力，在一次性配对码传输之外：还有两种传输方式，用的是你本就已有的基础设施，这是 magic-wormhole 没有覆盖的场景。",
        "relayium push / pull 复用你现有的 SSH 权限，因此没有新增的信任关系，也无需分享任何配对码。push 甚至能在远程完全没装 relayium 的服务器上工作，退化为通过 SSH 连接传输一段普通的 tar 流——但这个兜底只属于 push；pull 始终需要远程装有 relayium，因为在那里它要充当发送方。",
        "relayium serve 能把你拥有的任何一台机器变成一个 daemon-direct 目标，通过锁定的 TLS 1.3 访问，无需 SSH，也无需配对码——信任建立在第一次连接时（可交互批准，或提前授权以支持无人值守），此后一直锁定，思路和 SSH 的 host key 一样。",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "文件夹同步，以及可自托管的服务器",
      body: [
        "magic-wormhole 发送一批文件（或打包成一个压缩包的文件夹）后就退出——要更新对方就得再发一次，也没有“该删除什么”的概念。Relayium CLI 增加了 relayium sync，在上面两种传输方式之上做增量单向镜像：只传发生变化的内容；--delete 会删除目标端上源端已经消失的文件（daemon 只有在以 --allow-delete 启动时才会执行，接收方必须自己选择开启）；--watch 会在文件变化时实时持续重新同步，不需要额外的定时任务。",
        "如果你不想依赖 relayium.com，Relayium 的服务器也可以以单个 Docker 容器的形式自行托管；用 --server 让 CLI 指向它。",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "无法直连时：magic-wormhole 的 Transit Relay 会承载加密数据流，传输依然能完成；Relayium 的 send/receive 是纯直连的，在这种情况下会失败。",
        "对接服务器：Relayium 复用你的 SSH 权限（push/pull）或锁定 TLS 的 daemon；magic-wormhole 没有 SSH 集成——需要两端都装好并共享一段口令。",
        "文件夹同步：relayium sync 支持 --delete 与 --watch 的增量镜像；magic-wormhole 发送一批（或打包的文件夹）后就退出，没有镜像或删除语义。",
        "验证：两者都端到端加密；Relayium 的 send/receive 额外会在传输开始前展示一段供双方核对的简短 SAS 验证码。",
        "自托管：Relayium 的服务器是一个可以自己运行的单一 Docker 镜像，同时服务 CLI 和浏览器版；CLI 的 send/receive 可以用 --server 指向它。",
        "许可证与费用：两者都免费开源。magic-wormhole 完全不需要账号；Relayium 只有 send 为了签发配对码才需要。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 的 CLI 免费吗？",
        a: "完全免费。没有付费档位，也没有什么可计量的——每种模式都是两端直接连接，CLI 开源。",
      },
      {
        q: "需要账号吗？",
        a: "send 需要，云端 up 也需要。push/pull 用你自己的 SSH 权限，daemon-direct 用你机器之间锁定的 TLS 证书信任，这两者都不涉及 Relayium 账号。send/receive 是例外：配对码只能由服务器签发，而且只签发给已登录的账号，所以发送方要先运行一次 relayium login——如果 send 用的是别人给你的码，它不生成新码，也就不需要登录。接收方始终不需要账号。",
      },
      {
        q: "如果我处在严格 NAT 之后又打不通直连怎么办？",
        a: "这种情况下 Relayium 的 send/receive 是纯直连的，会失败——它不会退回到任何中继。magic-wormhole 的 Transit Relay 依然可以承载加密数据流，完成传输。如果你需要不管网络环境如何都能成功，magic-wormhole 目前能处理这种情况；改用 Relayium 的 push/pull 或对一台你能连到的服务器做 daemon-direct 同样可行，因为它们不依赖那一跳点对点直连。",
      },
      {
        q: "CLI 的配对码能和 Relayium 的浏览器版互通吗？",
        a: "目前还不能实时配对传输——CLI 的 send/receive 用的是自己的直连握手协议，和浏览器基于 WebRTC 的配对流程不是一回事，两者暂不互通。如果只想用浏览器把文件交给对方，可以用 Relayium 的存储下载链接，或者浏览器版自己的配对码模式。",
      },
      {
        q: "可以自托管吗？",
        a: "可以。Relayium 的服务器以 Docker 镜像形式发布（docker compose up -d --build），你也可以用 --server https://your-domain 让 CLI 的 send/receive 指向你自己的实例。",
      },
    ],
  },
  cta: {
    text: "安装免费的 Relayium CLI，试试 push、sync 或 send——完全免费，基于配对码的传输上手速度不输 magic-wormhole。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と magic-wormhole の比較：CLI ファイル転送",
  description:
    "magic-wormhole と Relayium CLI はどちらも短いコードとエンドツーエンド暗号化でターミナル間のファイルを転送します。公平な比較と、知っておく価値のある正直なトレードオフを1つ紹介します。",
  updatedLabel: "最終更新",
  lead: [
    "magic-wormhole は静かに熱心な支持者を集めてきました。実行すると 7-crossover-clockwork のような短く読み上げやすいコードが得られ、それを相手に伝えるだけでファイルが届きます——全行程が暗号化され、アカウントも気にするサーバーも不要です。Relayium CLI も似た発想で作られており、短いコードで2台のコンピュータを直接ペアリングし、その間のすべてを暗号化します。",
    "両者にはかなりの重なりがあり、重ならない部分は正確に述べる価値があります——magic-wormhole が今日、実際に Relayium CLI より頑健な点も含めて。",
  ],
  sections: [
    {
      heading: "両者の共通点",
      body: [
        "どちらのツールも同じ核心的な課題を、同じ誠実な方法で解決しています。あなたが管理できないサーバーにファイルが留まることはなく、両端がオフバンドで受け渡すのは短いコードだけです。magic-wormhole はアカウントが一切不要で、Relayium はサーバーがそのコードを発行できるよう送信側にのみサインインを求め、受信側は依然として不要です。",
      ],
      bullets: [
        "エンドツーエンドで暗号化：magic-wormhole は PAKE（SPAKE2）を使って暗号コードそのものからセッション鍵を導出するため、自身のランデブーサーバーですらその鍵を知ることはありません。Relayium の send/receive は両端の間で直接 X25519 鍵交換を行い、バイトが動く前に双方が照合できる短い検証コード（SAS）を表示します。",
        "どちらのツールも受信にアカウントは不要。magic-wormhole は一切不要です。",
        "無料でオープンソース——ファイルに触れるソースコードを読むことができます。",
        "クロスプラットフォーム：macOS、Linux、Windows。",
      ],
    },
    {
      heading: "magic-wormhole がより頑健な1点：リレーを持っている",
      body: [
        "これは正直なトレードオフであり、ぼかさずはっきり述べる価値があります。magic-wormhole には Transit Relay が同梱されており、両端が互いに直接接続を開けない場合——たとえば両方とも厳格または対称 NAT の内側にいて経路を開通できない場合——にフォールバックできます。リレーが見るのは常に暗号文だけですが、それが存在するおかげで転送は完了します。",
        "Relayium の send/receive は直接接続専用です。ハンドシェイクの直後に数秒間だけ直接接続を試み、見つからなければリレーにフォールバックせずそのまま失敗します——設計上、Relayium のサーバーはネットワークをまたぐ CLI 転送のファイルバイトに一切触れません。実際にはこれは稀なケースです（ほとんどの家庭やオフィスのネットワークは直接経路を許可します）が、両方とも異常に厳格な NAT の内側にある2台のマシン間でファイルを移動する場合、magic-wormhole の方がそのまま動く可能性が高いです。直接経路が見つからず、リレーを避けることより確実性の方が重要なら、magic-wormhole を選ぶべき場面です——あるいは、直接 P2P ホップに依存しない Relayium の push/pull や、到達可能なサーバーへの daemon-direct を使うのも手です。",
      ],
    },
    {
      heading: "SSH と daemon-direct：すでに運用しているサーバーと話す",
      body: [
        "Relayium CLI が本当に付加価値を持つのは、一回限りのペアリングコードのケースの外側です——すでに持っているインフラを活かす、magic-wormhole がカバーしようとしていない2つの方法があります。",
        "relayium push / pull は既存の SSH アクセスを再利用するため、新しく信頼するものも共有するペアリングコードもありません。push は relayium がまったくインストールされていないサーバーに対しても動作し、SSH 接続上の単純な tar ストリームにフォールバックします——このフォールバックは push 専用です。pull は常にリモートに relayium が必要です。そこでは pull が送信側として動作するためです。",
        "relayium serve は、所有する任意のマシンを daemon-direct のターゲットに変え、ピン留めされた TLS 1.3 経由で、SSH もペアリングコードもなしにアクセスできます——信頼は最初の接続時に成立し（対話的に承認するか、無人運用向けに事前承認しておく）、以後はピン留めされます。SSH のホスト鍵と同じ考え方です。",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "フォルダ同期と、セルフホスト可能なサーバー",
      body: [
        "magic-wormhole はファイルのバッチ（またはフォルダを圧縮したもの）を送って終了します——相手側を更新するには再度送るしかなく、何を削除すべきかという概念もありません。Relayium CLI は relayium sync を追加し、上記どちらの転送方式の上でも動く増分の一方向ミラーリングを行います。変化した分だけを送り、--delete はソース側から消えたファイルを宛先側からも削除します（daemon は --allow-delete 付きで起動している場合のみこれに従うため、受信側が自らオプトインする必要があります）。--watch はファイルの変化に応じてリアルタイムに再同期し続け、cron ジョブは不要です。",
        "relayium.com に頼らず自分ですべてを運用したい場合、Relayium のサーバーは単一の Docker コンテナとしてセルフホストできます。--server で CLI をそこに向けてください。",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "直接経路がない場合：magic-wormhole の Transit Relay は暗号化ストリームを運ぶので転送は完了する；Relayium の send/receive は直接接続専用で、この場合は失敗します。",
        "サーバーとの対話：Relayium は SSH アクセス（push/pull）またはピン留めされた TLS の daemon を再利用；magic-wormhole には SSH との統合がなく、両端にインストールしてコードを共有する必要があります。",
        "フォルダ同期：relayium sync は --delete と --watch を伴う増分ミラーリングを行う；magic-wormhole はバッチ（または圧縮したフォルダ）を送って終了し、ミラーや削除の概念はありません。",
        "検証：どちらもエンドツーエンドで暗号化される；Relayium の send/receive はさらに、転送開始前に双方が照合する短い SAS コードを表示します。",
        "セルフホスト：Relayium のサーバーは自分で運用できる単一の Docker イメージで、CLI とブラウザ版の両方に対応します。CLI の send/receive も --server でそこを指定できます。",
        "ライセンスと費用：どちらも無料でオープンソースです。magic-wormhole はアカウントが一切不要、Relayium はペアリングコードを発行する send にだけ必要です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium の CLI は無料ですか？",
        a: "はい、完全に無料です。有料プランはなく、計測するものもありません——どのモードでも両端が直接つながり、CLI はオープンソースです。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "send と、クラウドの up で必要です。push/pull は自分の SSH アクセスを使い、daemon-direct はマシン間のピン留めされた TLS 証明書の信頼を使うので、どちらも Relayium アカウントには触れません。send/receive は例外です。ペアリングコードを発行できるのはサーバーだけで、しかもサインイン済みのアカウントに対してだけなので、送信側は一度 relayium login を実行します。相手から渡されたコードを指定した send は発行を行わないのでログインは不要です。受信側にアカウントは決して必要ありません。",
      },
      {
        q: "厳格な NAT の内側にいて直接経路がない場合はどうなりますか？",
        a: "その場合 Relayium の send/receive は直接接続専用のため失敗します——リレーにはフォールバックしません。magic-wormhole の Transit Relay は暗号化ストリームを運んで転送を完了させることができます。ネットワークの状況にかかわらず確実に動作させたい場合、magic-wormhole は今日その状況に対応します。到達可能なサーバーに対する Relayium の push/pull や daemon-direct も、直接 P2P ホップに依存しないため同様に動作します。",
      },
      {
        q: "CLI のペアリングコードは Relayium のブラウザ版と使えますか？",
        a: "現時点ではリアルタイムのペアリング転送はできません——CLI の send/receive は独自の直接ハンドシェイクを使っており、ブラウザの WebRTC ベースのペアリングフローとは別物なので、今は相互運用できません。ブラウザだけを使って相手にファイルを渡したい場合は、Relayium の保存型ダウンロードリンクか、ブラウザ版自体のペアリングコードモードを使ってください。",
      },
      {
        q: "セルフホストできますか？",
        a: "はい。Relayium のサーバーは Docker イメージとして配布されており（docker compose up -d --build）、CLI の send/receive も --server https://your-domain で自分のインスタンスを指定できます。",
      },
    ],
  },
  cta: {
    text: "無料の Relayium CLI をインストールして push、sync、send を試してみましょう——完全無料で、magic-wormhole と同じくらいすぐに始められるコードベースの転送です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs magic-wormhole: CLI 파일 전송",
  description:
    "magic-wormhole과 Relayium CLI는 둘 다 짧은 코드와 종단간 암호화로 터미널 사이에 파일을 전송합니다. 공정한 비교와, 알아둘 만한 솔직한 트레이드오프 하나를 소개합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "magic-wormhole은 조용히 충성도 높은 사용자층을 모아왔습니다. 실행하면 7-crossover-clockwork처럼 짧고 읽기 쉬운 코드가 나오고, 그것을 상대에게 말해주면 파일이 도착합니다 — 전 과정이 암호화되어 있고, 계정도 신경 쓸 서버도 없습니다. Relayium CLI도 비슷한 발상으로 만들어졌습니다. 짧은 코드로 두 컴퓨터를 직접 페어링하고 그 사이의 모든 것을 암호화합니다.",
    "둘은 겹치는 부분이 많고, 겹치지 않는 부분은 정확히 짚을 가치가 있습니다 — magic-wormhole이 오늘 실제로 Relayium CLI보다 더 견고한 지점 하나를 포함해서요.",
  ],
  sections: [
    {
      heading: "두 도구의 공통점",
      body: [
        "두 도구 모두 같은 핵심 문제를 같은 정직한 방식으로 해결합니다. 파일이 여러분이 통제할 수 없는 서버에 머물지 않으며, 양쪽이 별도 채널로 주고받는 것은 짧은 코드 하나뿐입니다. magic-wormhole은 계정이 전혀 필요 없고, Relayium은 서버가 그 코드를 발급할 수 있도록 보내는 쪽에만 로그인을 요구하며 받는 쪽은 여전히 필요 없습니다.",
      ],
      bullets: [
        "종단간 암호화: magic-wormhole은 PAKE(SPAKE2)를 사용해 워프홀 코드 자체에서 세션 키를 유도하므로, 자체 랑데부 서버조차 그 키를 알지 못합니다. Relayium의 send/receive는 양쪽 사이에서 직접 X25519 키 교환을 수행하고, 바이트가 움직이기 전에 양쪽이 대조할 수 있는 짧은 검증 코드(SAS)를 보여줍니다.",
        "두 도구 모두 받는 데 계정이 필요 없음 — magic-wormhole은 아예 필요 없습니다.",
        "무료 오픈소스 — 파일에 접근하는 소스 코드를 직접 읽어볼 수 있습니다.",
        "크로스 플랫폼: macOS, Linux, Windows.",
      ],
    },
    {
      heading: "magic-wormhole이 더 견고한 한 지점: 릴레이가 있다",
      body: [
        "이것은 솔직한 트레이드오프이며, 얼버무리지 않고 분명히 말할 가치가 있습니다. magic-wormhole은 Transit Relay를 함께 제공하며, 양쪽이 서로 직접 연결을 열 수 없을 때 — 예를 들어 양쪽 모두 엄격하거나 대칭적인 NAT 뒤에 있어 뚫을 방법이 없을 때 — 이 릴레이로 대체됩니다. 릴레이는 항상 암호문만 볼 뿐이지만, 그것이 있기 때문에 전송이 완료됩니다.",
        "Relayium의 send/receive는 직접 연결 전용입니다. 핸드셰이크 직후 몇 초 동안 직접 연결을 시도하고, 찾지 못하면 릴레이로 대체되지 않고 그대로 실패합니다 — 설계상 Relayium의 서버는 네트워크 간 CLI 전송의 파일 바이트를 전혀 건드리지 않습니다. 실제로는 이런 경우가 드뭅니다(대부분의 가정용·사무용 네트워크는 직접 경로를 허용합니다). 하지만 둘 다 유난히 엄격한 NAT 뒤에 있는 두 기기 사이에서 파일을 옮긴다면 magic-wormhole이 그냥 작동할 가능성이 더 높습니다. 직접 경로를 찾을 수 없고 릴레이를 피하는 것보다 신뢰성이 더 중요하다면, 그것이 바로 magic-wormhole을 써야 할 경우입니다 — 아니면 직접 P2P 홉에 의존하지 않는 Relayium의 push/pull이나, 실제로 도달 가능한 서버에 대한 daemon-direct를 사용해도 됩니다.",
      ],
    },
    {
      heading: "SSH와 daemon-direct: 이미 운영 중인 서버와 대화하기",
      body: [
        "Relayium CLI가 정말로 더 갖춘 부분은 일회성 페어링 코드 사례 바깥에 있습니다 — 이미 가진 인프라를 활용하는 두 가지 방식이 더 있으며, 이는 magic-wormhole이 다루려 하지 않는 영역입니다.",
        "relayium push / pull은 기존 SSH 접근 권한을 재사용하므로 새로 신뢰할 것도, 공유할 페어링 코드도 없습니다. push는 relayium이 전혀 설치되지 않은 서버에도 작동해, SSH 연결 위의 일반 tar 스트림으로 대체됩니다 — 이 대체 방식은 push에만 있습니다. pull은 항상 원격지에 relayium이 필요합니다. 그곳에서 pull이 송신자 역할을 하기 때문입니다.",
        "relayium serve는 소유한 어떤 기기든 daemon-direct 대상으로 바꿔주며, 고정된 TLS 1.3을 통해 SSH도 페어링 코드도 없이 접근할 수 있게 합니다 — 신뢰는 첫 연결에서 성립하고(대화식으로 승인하거나, 무인 운영을 위해 미리 승인해 둘 수 있음) 이후로는 고정됩니다. SSH의 host key와 같은 발상입니다.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "폴더 동기화, 그리고 자체 호스팅 가능한 서버",
      body: [
        "magic-wormhole은 파일 묶음(또는 압축된 폴더)을 보내고 종료합니다 — 상대 쪽을 갱신하려면 다시 보내야 하고, 무엇을 삭제해야 하는지에 대한 개념도 없습니다. Relayium CLI는 relayium sync를 더해, 위의 두 전송 방식 위에서 증분 단방향 미러링을 합니다. 변경된 것만 옮기고, --delete는 소스에서 사라진 파일을 대상에서도 삭제합니다(데몬은 --allow-delete로 시작된 경우에만 이를 따르므로, 수신 측이 직접 선택해야 합니다). --watch는 파일이 바뀔 때마다 실시간으로 계속 재동기화하며, cron 작업이 필요 없습니다.",
        "relayium.com에 의존하지 않고 직접 모든 것을 운영하고 싶다면, Relayium의 서버는 단일 Docker 컨테이너로 자체 호스팅할 수도 있습니다. --server로 CLI가 그곳을 가리키게 하세요.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "직접 경로가 없을 때: magic-wormhole의 Transit Relay는 암호화된 스트림을 실어 날라 전송이 완료됨; Relayium의 send/receive는 직접 연결 전용이라 이 경우 실패함.",
        "서버와의 대화: Relayium은 SSH 접근(push/pull) 또는 고정 TLS 데몬을 재사용; magic-wormhole은 SSH 통합이 없어 양쪽에 설치하고 코드를 공유해야 함.",
        "폴더 동기화: relayium sync는 --delete와 --watch로 증분 미러링; magic-wormhole은 묶음(또는 압축된 폴더)을 보내고 종료하며 미러나 삭제 개념이 없음.",
        "검증: 둘 다 종단간 암호화됨; Relayium의 send/receive는 추가로 전송 시작 전 양쪽이 대조하는 짧은 SAS 코드를 표시함.",
        "자체 호스팅: Relayium의 서버는 직접 운영할 수 있는 단일 Docker 이미지로, CLI와 브라우저 앱 둘 다에 사용됨; CLI의 send/receive도 --server로 그곳을 가리킬 수 있음.",
        "라이선스와 비용: 둘 다 무료 오픈소스. magic-wormhole은 계정이 전혀 필요 없고, Relayium은 페어링 코드를 발급하는 send에만 필요합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium의 CLI는 무료인가요?",
        a: "네, 완전히 무료입니다. 유료 등급이 없고 계량할 것도 없습니다 — 모든 모드가 양쪽을 직접 연결하며, CLI는 오픈소스입니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "send가 그렇고, 클라우드 up도 그렇습니다. push/pull은 자신의 SSH 접근을 사용하고 daemon-direct는 기기 간 고정된 TLS 인증서 신뢰를 사용하므로 둘 다 Relayium 계정을 건드리지 않습니다. send/receive가 예외입니다. 페어링 코드는 서버만, 그것도 로그인된 계정에만 발급할 수 있으므로 보내는 쪽이 relayium login을 한 번 실행합니다. 건네받은 코드를 지정한 send는 발급을 하지 않으므로 로그인이 필요 없습니다. 받는 데는 계정이 전혀 필요 없습니다.",
      },
      {
        q: "엄격한 NAT 뒤에 있어 직접 경로가 없다면 어떻게 되나요?",
        a: "이 경우 Relayium의 send/receive는 직접 연결 전용이라 실패합니다 — 릴레이로 대체되지 않습니다. magic-wormhole의 Transit Relay는 암호화된 스트림을 실어 날라 전송을 완료할 수 있습니다. 네트워크 상황과 무관하게 반드시 성공해야 한다면, magic-wormhole이 오늘 그 상황을 처리합니다. 도달 가능한 서버에 대한 Relayium의 push/pull이나 daemon-direct도 직접 P2P 홉에 의존하지 않으므로 마찬가지로 작동합니다.",
      },
      {
        q: "CLI의 페어링 코드를 Relayium 브라우저 앱과 함께 쓸 수 있나요?",
        a: "아직 실시간 페어링 전송은 안 됩니다 — CLI의 send/receive는 자체 직접 핸드셰이크를 사용하며, 브라우저의 WebRTC 기반 페어링 흐름과는 별개라 현재는 상호 운용되지 않습니다. 브라우저만으로 상대에게 파일을 전달하려면 Relayium의 저장형 다운로드 링크나 브라우저 앱 자체의 페어링 코드 모드를 사용하세요.",
      },
      {
        q: "자체 호스팅할 수 있나요?",
        a: "네. Relayium의 서버는 Docker 이미지로 배포되며(docker compose up -d --build), CLI의 send/receive도 --server https://your-domain으로 자신의 인스턴스를 가리키게 할 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "무료 Relayium CLI를 설치하고 push, sync, send를 써보세요 — 완전 무료로, magic-wormhole만큼 빠르게 시작할 수 있는 코드 기반 전송입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. magic-wormhole: Dateiübertragung per CLI",
  description:
    "magic-wormhole und die Relayium-CLI übertragen beide Dateien zwischen Terminals mit einem kurzen Code und Ende-zu-Ende-Verschlüsselung. Ein fairer Vergleich inklusive der einen ehrlichen Kompromiss, den man kennen sollte.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "magic-wormhole hat sich still und leise eine treue Anhängerschaft erarbeitet: starten, einen kurzen, gut vorlesbaren Code wie 7-crossover-clockwork erhalten, ihn der anderen Person nennen — und die Datei kommt an, durchgehend verschlüsselt, ohne Konto und ohne Server, um den man sich kümmern muss. Die Relayium CLI folgt einer ähnlichen Idee: ein kurzer Code koppelt zwei Rechner direkt und verschlüsselt alles dazwischen.",
    "Beide überschneiden sich stark, und wo nicht, lohnt es sich, präzise zu sein — auch bei dem einen Punkt, an dem magic-wormhole heute tatsächlich robuster ist als die Relayium-CLI.",
  ],
  sections: [
    {
      heading: "Was beide gemeinsam haben",
      body: [
        "Beide Tools lösen dasselbe Kernproblem auf dieselbe ehrliche Art: keine Datei, die auf einem Server liegen bleibt, den du nicht kontrollierst, und ein kurzer Code als einziges, was die beiden Enden außerhalb des Kanals austauschen. magic-wormhole braucht überhaupt kein Konto; Relayium verlangt nur vom Absender eine Anmeldung, damit sein Server diesen Code erzeugen kann — der Empfänger weiterhin nicht.",
      ],
      bullets: [
        "Ende-zu-Ende verschlüsselt: magic-wormhole leitet mit einem PAKE (SPAKE2) einen Sitzungsschlüssel direkt aus dem Wormhole-Code ab, sodass nicht einmal der eigene Rendezvous-Server je den Schlüssel erfährt. Relayiums send/receive führt einen direkten X25519-Schlüsselaustausch zwischen den beiden Enden durch und zeigt einen kurzen Prüfcode (SAS), den ihr vor der ersten übertragenen Bit vergleichen könnt.",
        "Kein Konto zum Empfangen, bei beiden Tools — und bei magic-wormhole überhaupt keines.",
        "Kostenlos und quelloffen — lies den Quellcode, der deine Dateien berührt.",
        "Plattformübergreifend: macOS, Linux und Windows.",
      ],
    },
    {
      heading: "Der eine Punkt, an dem magic-wormhole robuster ist: es hat ein Relay",
      body: [
        "Das ist der ehrliche Kompromiss, und er sollte klar benannt werden, statt beschönigt zu werden. magic-wormhole bringt ein Transit Relay mit, auf das es zurückgreifen kann, wenn die beiden Enden keine direkte Verbindung zueinander aufbauen können — etwa wenn beide Seiten hinter strengem oder symmetrischem NAT sitzen und sich keine Öffnung finden lässt. Das Relay sieht dabei immer nur Chiffretext, aber weil es existiert, wird die Übertragung trotzdem abgeschlossen.",
        "Relayiums send/receive ist rein direkt: Es versucht direkt nach dem Handshake für ein paar Sekunden eine direkte Verbindung aufzubauen, und findet es keine, schlägt die Übertragung schlicht fehl, statt auf ein Relay auszuweichen — Relayiums Server kommen laut Design nie mit den Dateibytes einer netzwerkübergreifenden CLI-Übertragung in Berührung. In der Praxis ist das selten (die meisten Heim- und Büronetzwerke erlauben einen direkten Pfad), aber wenn du Dateien zwischen zwei Maschinen bewegst, die beide hinter ungewöhnlich strengem NAT sitzen, funktioniert magic-wormhole eher einfach so. Wenn sich kein direkter Pfad finden lässt und Zuverlässigkeit wichtiger ist als die Vermeidung eines Relays, ist das der Fall, in dem sich magic-wormhole anbietet — oder Relayiums push/pull bzw. daemon-direct gegen einen tatsächlich erreichbaren Server, die überhaupt nicht von diesem direkten P2P-Hop abhängen.",
      ],
    },
    {
      heading: "SSH und daemon-direct: mit einem Server sprechen, den du bereits betreibst",
      body: [
        "Dort, wo die Relayium-CLI wirklich zusätzliche Fläche hinzufügt, liegt außerhalb des einmaligen Pairing-Code-Falls: zwei weitere Wege, Dateien zu bewegen, die sich auf Infrastruktur stützen, die du bereits hast — ein Bereich, den magic-wormhole gar nicht abzudecken versucht.",
        "relayium push / pull nutzt deinen bestehenden SSH-Zugang, also gibt es nichts Neues zu vertrauen und keinen Pairing-Code zu teilen. push funktioniert sogar gegen einen Server ohne installiertes relayium und fällt dann auf einen einfachen tar-Stream über die SSH-Verbindung zurück — dieser Fallback existiert nur bei push; pull braucht immer relayium auf der Gegenseite, da es dort als Absender agiert.",
        "relayium serve macht aus jeder Maschine, die dir gehört, ein daemon-direct-Ziel, erreichbar über gepinntes TLS 1.3, ohne SSH und ohne Pairing-Code — Vertrauen entsteht bei der ersten Verbindung (interaktiv bestätigt oder für unbeaufsichtigten Betrieb vorab autorisiert) und ist danach gepinnt, dieselbe Idee wie ein SSH-Host-Key.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Ordner-Sync und ein selbst hostbarer Server",
      body: [
        "magic-wormhole sendet eine Reihe von Dateien (oder einen gezippten Ordner) und beendet sich dann — um die Gegenseite zu aktualisieren, musst du erneut senden, ein Konzept, was gelöscht werden soll, gibt es nicht. Die Relayium CLI fügt relayium sync hinzu, einen inkrementellen Einweg-Spiegel über einen der beiden obigen Transportwege: Es bewegt nur, was sich geändert hat; --delete entfernt Dateien am Ziel, die auf der Quelle verschwunden sind (ein Daemon befolgt das nur, wenn er mit --allow-delete gestartet wurde, der Empfänger muss also selbst zustimmen); --watch synchronisiert bei Dateiänderungen laufend in Echtzeit neu, kein Cron-Job nötig.",
        "Wenn du dich nicht auf relayium.com verlassen, sondern alles selbst betreiben willst, lässt sich Relayiums Server auch als einzelner Docker-Container selbst hosten; richte die CLI mit --server darauf aus.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Kein direkter Pfad verfügbar: magic-wormholes Transit Relay trägt den verschlüsselten Datenstrom, sodass die Übertragung trotzdem abgeschlossen wird; Relayiums send/receive ist rein direkt und schlägt in diesem Fall fehl.",
        "Mit einem Server sprechen: Relayium nutzt deinen SSH-Zugang (push/pull) oder einen gepinnten TLS-Daemon; magic-wormhole hat keine SSH-Integration — installiere es auf beiden Seiten und teile einen Code.",
        "Ordner-Sync: relayium sync spiegelt inkrementell mit --delete und --watch; magic-wormhole sendet eine Reihe (oder einen gezippten Ordner) und beendet sich, ohne Spiegel- oder Löschsemantik.",
        "Verifikation: Beide sind Ende-zu-Ende verschlüsselt; Relayiums send/receive zeigt zusätzlich einen kurzen SAS-Code, den beide Seiten vor Übertragungsbeginn vergleichen.",
        "Selbst hosten: Relayiums Server ist ein einzelnes Docker-Image, das du selbst betreiben kannst und das sowohl der CLI als auch der Web-App dient; die send/receive-Funktion der CLI kann mit --server darauf zeigen.",
        "Lizenz und Kosten: beide kostenlos und quelloffen. magic-wormhole braucht überhaupt kein Konto; Relayium nur für send, um den Pairing-Code zu erzeugen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist Relayiums CLI kostenlos?",
        a: "Ja, vollständig. Es gibt keine bezahlte Stufe und nichts zu messen — jeder Modus verbindet die beiden Enden direkt, und die CLI ist quelloffen.",
      },
      {
        q: "Braucht sie ein Konto?",
        a: "send schon, und Cloud-up ebenfalls. push/pull nutzt deinen eigenen SSH-Zugang und daemon-direct nutzt gepinntes TLS-Zertifikatsvertrauen zwischen deinen Maschinen, beides berührt also kein Relayium-Konto. send/receive ist die Ausnahme: Einen Pairing-Code kann nur der Server erzeugen, und nur für ein angemeldetes Konto, also führt der Absender einmal relayium login aus — ein send mit einem Code, den man dir gegeben hat, erzeugt keinen und braucht keine Anmeldung. Zum Empfangen braucht es nie ein Konto.",
      },
      {
        q: "Was, wenn ich hinter strengem NAT sitze und es keinen direkten Pfad gibt?",
        a: "In diesem Fall ist Relayiums send/receive rein direkt und schlägt fehl — es weicht nicht auf ein Relay aus. magic-wormholes Transit Relay kann den verschlüsselten Datenstrom trotzdem tragen und die Übertragung abschließen. Wenn es unabhängig vom Netzwerk funktionieren muss, deckt magic-wormhole diesen Fall heute ab; Relayiums push/pull oder daemon-direct gegen einen erreichbaren Server funktionieren ebenfalls, da sie nicht von einem direkten P2P-Hop abhängen.",
      },
      {
        q: "Kann ich den Pairing-Code der CLI mit Relayiums Browser-App nutzen?",
        a: "Noch nicht für eine gekoppelte Live-Übertragung — send/receive der CLI nutzt einen eigenen, direkten Handshake, getrennt vom WebRTC-basierten Pairing-Ablauf des Browsers, sodass beide heute nicht zusammenarbeiten. Um jemandem nur per Browser eine Datei zu übergeben, nutze Relayiums gespeicherten Download-Link oder den eigenen Pairing-Code-Modus der Browser-App.",
      },
      {
        q: "Kann ich sie selbst hosten?",
        a: "Ja. Relayiums Server wird als Docker-Image ausgeliefert (docker compose up -d --build), und du kannst send/receive der CLI mit --server https://your-domain auf deine eigene Instanz zeigen lassen.",
      },
    ],
  },
  cta: {
    text: "Installiere die kostenlose Relayium CLI und probiere push, sync oder send — kostenlos, und eine codebasierte Übertragung genauso schnell startklar wie magic-wormhole.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs magic-wormhole : transfert de fichiers CLI",
  description:
    "magic-wormhole et la CLI Relayium déplacent tous deux des fichiers entre terminaux avec un code court et un chiffrement de bout en bout. Un comparatif honnête, avec le seul compromis à connaître.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "magic-wormhole s'est bâti discrètement un public fidèle : on le lance, on obtient un code court et facile à lire comme 7-crossover-clockwork, on le dicte à l'autre personne, et le fichier arrive — chiffré de bout en bout, sans compte ni serveur dont il faut se soucier. La CLI Relayium repose sur une idée similaire : un code court appaire directement deux ordinateurs et chiffre tout ce qui passe entre eux.",
    "Les deux se recoupent beaucoup, et là où ce n'est pas le cas, mieux vaut être précis — y compris sur le seul point où magic-wormhole est aujourd'hui réellement plus robuste que la CLI Relayium.",
  ],
  sections: [
    {
      heading: "Ce que les deux ont en commun",
      body: [
        "Les deux outils résolvent le même problème central de la même manière honnête : aucun fichier qui reste sur un serveur que vous ne contrôlez pas, et un court code comme seule chose que les deux extrémités se transmettent par un autre canal. magic-wormhole ne demande aucun compte ; Relayium n'en demande un qu'à l'expéditeur, pour que son serveur puisse générer ce code, et le destinataire toujours pas.",
      ],
      bullets: [
        "Chiffré de bout en bout : magic-wormhole dérive une clé de session directement à partir du code wormhole via un PAKE (SPAKE2), si bien que même son propre serveur de rendez-vous n'apprend jamais la clé. Le send/receive de Relayium effectue un échange de clés X25519 directement entre les deux extrémités et affiche un court code de vérification (SAS) à comparer avant que le moindre octet ne bouge.",
        "Aucun compte pour recevoir, sur les deux outils — et aucun du tout pour magic-wormhole.",
        "Gratuit et open source — lisez le code source qui touche à vos fichiers.",
        "Multiplateforme : macOS, Linux et Windows.",
      ],
    },
    {
      heading: "Le seul point où magic-wormhole est plus robuste : il a un relais",
      body: [
        "C'est le compromis honnête, et il vaut la peine de le dire clairement plutôt que de l'édulcorer. magic-wormhole embarque un Transit Relay sur lequel il peut basculer quand les deux extrémités ne parviennent pas à ouvrir une connexion directe entre elles — par exemple si les deux côtés sont derrière un NAT strict ou symétrique sans moyen de percer. Le relais ne voit jamais que du chiffré, mais parce qu'il existe, le transfert aboutit quand même.",
        "Le send/receive de Relayium est exclusivement direct : il tente une connexion directe pendant quelques secondes juste après la poignée de main, et s'il n'en trouve pas, le transfert échoue purement et simplement plutôt que de basculer vers un relais — par conception, les serveurs de Relayium ne touchent jamais aux octets d'un transfert CLI entre réseaux. En pratique, c'est rare (la plupart des réseaux domestiques et professionnels autorisent un chemin direct), mais si vous déplacez des fichiers entre deux machines toutes deux derrière un NAT inhabituellement strict, magic-wormhole a plus de chances de simplement fonctionner. Si aucun chemin direct ne se trouve et que la fiabilité compte plus que d'éviter un relais, c'est le cas où se tourner vers magic-wormhole — ou utiliser le push/pull ou le daemon-direct de Relayium contre un serveur réellement joignable, qui eux ne dépendent pas de ce saut P2P direct.",
      ],
    },
    {
      heading: "SSH et daemon-direct : parler à un serveur que vous exploitez déjà",
      body: [
        "Là où la CLI Relayium ajoute une réelle surface, c'est en dehors du cas ponctuel du code d'appairage : deux autres façons de déplacer des fichiers qui s'appuient sur une infrastructure que vous possédez déjà, un terrain que magic-wormhole ne cherche pas à couvrir.",
        "relayium push / pull réutilise votre accès SSH existant, donc rien de nouveau à faire confiance et aucun code d'appairage à partager. push fonctionne même contre un serveur sans relayium installé, en basculant sur un simple flux tar via la connexion SSH — ce repli n'existe que pour push ; pull a toujours besoin de relayium sur la machine distante, puisqu'il y joue le rôle d'expéditeur.",
        "relayium serve transforme n'importe quelle machine que vous possédez en cible daemon-direct, accessible via TLS 1.3 épinglé, sans SSH ni code d'appairage — la confiance s'établit à la première connexion (approuvée de façon interactive, ou pré-autorisée pour un usage sans surveillance) puis reste épinglée ensuite, la même idée qu'une clé d'hôte SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Synchronisation de dossiers et un serveur auto-hébergeable",
      body: [
        "magic-wormhole envoie un lot de fichiers (ou un dossier compressé) puis se termine — pour mettre à jour l'autre côté, il faut renvoyer, sans aucune notion de ce qui devrait être supprimé. La CLI Relayium ajoute relayium sync, un miroir incrémental à sens unique sur l'un ou l'autre des transports ci-dessus : il ne déplace que ce qui a changé ; --delete supprime sur la destination les fichiers disparus de la source (un daemon ne le respecte que s'il a été lancé avec --allow-delete, le destinataire doit donc explicitement l'accepter) ; --watch continue de resynchroniser en temps réel à chaque changement, sans tâche cron nécessaire.",
        "Si vous ne voulez pas dépendre de relayium.com et préférez tout exploiter vous-même, le serveur de Relayium peut aussi être auto-hébergé sous la forme d'un seul conteneur Docker ; pointez la CLI dessus avec --server.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "Aucun chemin direct disponible : le Transit Relay de magic-wormhole transporte le flux chiffré, si bien que le transfert aboutit quand même ; le send/receive de Relayium est exclusivement direct et échoue dans ce cas.",
        "Parler à un serveur : Relayium réutilise votre accès SSH (push/pull) ou un daemon TLS épinglé ; magic-wormhole n'a aucune intégration SSH — installez-le des deux côtés et partagez un code.",
        "Synchronisation de dossiers : relayium sync fait un miroir incrémental avec --delete et --watch ; magic-wormhole envoie un lot (ou un dossier compressé) puis se termine, sans sémantique de miroir ni de suppression.",
        "Vérification : les deux sont chiffrés de bout en bout ; le send/receive de Relayium affiche en plus un court code SAS que les deux parties comparent avant le début du transfert.",
        "Auto-hébergement : le serveur de Relayium est une seule image Docker que vous pouvez exploiter vous-même, servant à la fois la CLI et l'application web ; le send/receive de la CLI peut pointer dessus avec --server.",
        "Licence et coût : les deux sont gratuits et open source. magic-wormhole ne nécessite aucun compte ; Relayium n'en demande un que pour send, afin de générer le code d'appairage.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La CLI Relayium est-elle gratuite ?",
        a: "Oui, entièrement. Il n'y a aucun palier payant et rien à mesurer — chaque mode connecte directement les deux extrémités, et la CLI est open source.",
      },
      {
        q: "A-t-elle besoin d'un compte ?",
        a: "send oui, et le up cloud aussi. push/pull utilise votre propre accès SSH et daemon-direct utilise une confiance par certificat TLS épinglé entre vos machines, donc ni l'un ni l'autre ne touche un compte Relayium. send/receive fait exception : seul le serveur peut générer un code de jumelage, et seulement pour un compte connecté, donc l'expéditeur lance une fois relayium login — un send auquel vous passez un code qu'on vous a donné n'en génère aucun et ne demande pas de connexion. Recevoir ne nécessite jamais de compte.",
      },
      {
        q: "Que se passe-t-il si je suis derrière un NAT strict et qu'il n'y a aucun chemin direct ?",
        a: "Dans ce cas, le send/receive de Relayium est exclusivement direct et échouera — il ne bascule pas vers un relais. Le Transit Relay de magic-wormhole peut néanmoins transporter le flux chiffré et mener le transfert à bien. Si vous avez besoin que ça fonctionne quel que soit l'état du réseau, magic-wormhole gère ce cas aujourd'hui ; le push/pull ou le daemon-direct de Relayium contre un serveur joignable fonctionnent aussi, car ils ne dépendent pas d'un saut P2P direct.",
      },
      {
        q: "Puis-je utiliser le code d'appairage de la CLI avec l'application web de Relayium ?",
        a: "Pas encore pour un transfert appairé en direct — le send/receive de la CLI utilise sa propre poignée de main directe, distincte du flux d'appairage du navigateur basé sur WebRTC, donc les deux n'interopèrent pas aujourd'hui. Pour remettre un fichier à quelqu'un via un simple navigateur, utilisez le lien de téléchargement stocké de Relayium ou le mode par code d'appairage propre à l'application web.",
      },
      {
        q: "Puis-je l'auto-héberger ?",
        a: "Oui. Le serveur de Relayium est distribué sous forme d'image Docker (docker compose up -d --build), et vous pouvez pointer le send/receive de la CLI vers votre propre instance avec --server https://your-domain.",
      },
    ],
  },
  cta: {
    text: "Installez la CLI Relayium gratuite et essayez push, sync ou send — gratuit, avec un transfert à base de code tout aussi rapide à démarrer que magic-wormhole.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل magic-wormhole: نقل الملفات عبر CLI",
  description:
    "كلٌّ من magic-wormhole و CLI الخاص بـ Relayium ينقل الملفات بين الطرفيات برمز قصير وتشفير من الطرف إلى الطرف. مقارنة عادلة، بما في ذلك المفاضلة الصادقة الوحيدة التي يجدر معرفتها.",
  updatedLabel: "آخر تحديث",
  lead: [
    "اكتسب magic-wormhole بهدوء جمهوراً وفياً: شغّله، فتحصل على رمز قصير سهل القراءة مثل 7-crossover-clockwork، اقرأه للطرف الآخر فيصل الملف — مشفَّراً طوال الطريق، بدون حساب وبدون خادم عليك التفكير فيه. وقد بُني CLI الخاص بـ Relayium حول فكرة مشابهة: رمز قصير يقرن جهازي حاسوب مباشرة ويشفّر كل ما بينهما.",
    "يتداخل الاثنان كثيراً، وحيث لا يتداخلان يستحق الأمر الدقّة في وصفه — بما في ذلك الموضع الوحيد الذي يكون فيه magic-wormhole اليوم أكثر صموداً فعلاً من CLI الخاص بـ Relayium.",
  ],
  sections: [
    {
      heading: "ما هو مشترك بينهما",
      body: [
        "تحلّ الأداتان المشكلة الجوهرية نفسها بالطريقة الصادقة نفسها: لا ملف مُخزَّن على خادم لا تتحكم فيه، ورمز قصير هو الشيء الوحيد الذي يتناقله الطرفان خارج القناة. أما الحساب فلا تحتاجه magic-wormhole إطلاقاً، بينما يطلبه Relayium من المُرسِل وحده كي يُصدر خادمه ذلك الرمز، ويظل المُستقبِل بلا حاجة إليه.",
      ],
      bullets: [
        "مشفّر من الطرف إلى الطرف: يشتقّ magic-wormhole مفتاح الجلسة من رمز الـ wormhole نفسه باستخدام PAKE (SPAKE2)، بحيث لا يعرف المفتاح حتى خادم الالتقاء الخاص به؛ أما send/receive في Relayium فيجري تبادل مفاتيح X25519 مباشرة بين الطرفين ويعرض رمز تحقق قصير (SAS) يمكنك مقارنته قبل تحرّك أي بايت.",
        "لا حساب للاستقبال في كلتا الأداتين — ولا حساب إطلاقاً مع magic-wormhole.",
        "مجاني ومفتوح المصدر — اقرأ الشيفرة التي تلمس ملفاتك.",
        "متعدد المنصات: macOS و Linux و Windows.",
      ],
    },
    {
      heading: "الموضع الوحيد الذي يكون فيه magic-wormhole أكثر صموداً: لديه مُرحِّل",
      body: [
        "هذه هي المفاضلة الصادقة، ويجدر ذكرها بوضوح بدل التغاضي عنها. يأتي magic-wormhole مزوّداً بمُرحِّل Transit Relay يمكنه الرجوع إليه حين يتعذّر على الطرفين فتح اتصال مباشر بينهما — مثلاً حين يكون كلا الجانبين خلف NAT صارم أو متماثل بلا وسيلة للاختراق. لا يرى المُرحِّل سوى نص مُشفَّر دائماً، لكن لأنه موجود، تكتمل عملية النقل رغم ذلك.",
        "أما send/receive في Relayium فمباشر فقط: يتسابق على اتصال مباشر لبضع ثوانٍ مباشرة بعد المصافحة، وإن لم يجده يفشل النقل تماماً بدل الرجوع إلى أي مُرحِّل — فخوادم Relayium لا تلمس إطلاقاً بايتات ملفات CLI العابرة للشبكات، بحكم التصميم. هذا نادر عملياً (تسمح معظم الشبكات المنزلية والمكتبية بمسار مباشر)، لكن إن كنت تنقل ملفات بين جهازين كلاهما خلف NAT صارم على نحو غير معتاد، فمن الأرجح أن يعمل magic-wormhole ببساطة. إن تعذّر إيجاد مسار مباشر وكانت الموثوقية أهم من تجنّب المُرحِّل، فتلك هي الحالة التي تستدعي اللجوء إلى magic-wormhole — أو استخدام push/pull في Relayium أو daemon-direct مقابل خادم تستطيع فعلاً الوصول إليه، وهذه لا تعتمد على تلك القفزة المباشرة من الند للند أصلاً.",
      ],
    },
    {
      heading: "SSH و daemon-direct: التحدّث إلى خادم تشغّله أصلاً",
      body: [
        "حيث يضيف CLI الخاص بـ Relayium مساحة حقيقية هو خارج حالة رمز الاقتران لمرة واحدة: طريقتان إضافيتان لنقل الملفات تعتمدان على بنية تحتية تملكها أصلاً، وهو ما لا يحاول magic-wormhole تغطيته.",
        "يعيد relayium push / pull استخدام وصول SSH القائم لديك، فلا شيء جديد لتثق به ولا رمز اقتران لمشاركته. بل يعمل push حتى مقابل خادم لا يوجد فيه relayium مثبَّت إطلاقاً، بالرجوع إلى تدفّق tar عادي عبر اتصال SSH — وهذا الرجوع خاص بـ push فقط؛ أما pull فيحتاج دائماً إلى relayium على الطرف البعيد، إذ يعمل هناك بصفته المُرسِل.",
        "يحوّل relayium serve أي جهاز تملكه إلى هدف daemon-direct، يمكن الوصول إليه عبر TLS 1.3 مثبَّت بلا SSH وبلا رمز اقتران — تُبنى الثقة عند الاتصال الأول (يُوافَق عليه تفاعلياً، أو يُصرَّح به مسبقاً للاستخدام غير المراقَب) وتبقى مثبَّتة بعد ذلك، وهي الفكرة نفسها مثل مفتاح مضيف SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "مزامنة المجلدات وخادم قابل للاستضافة الذاتية",
      body: [
        "يرسل magic-wormhole دفعة من الملفات (أو مجلداً مضغوطاً) ثم يخرج — أرسِلها مجدداً لتحديث الطرف الآخر، بلا أي مفهوم لما ينبغي حذفه. يضيف CLI الخاص بـ Relayium الأمر relayium sync، وهو مرآة تزايدية أحادية الاتجاه فوق أيٍّ من النقلين أعلاه: ينقل فقط ما تغيّر، ويحذف --delete الملفات على الوجهة التي اختفت من المصدر (لا يحترم ذلك daemon إلا إن بُدئ بـ --allow-delete، فعلى المستقبِل أن يوافق صراحةً)، ويبقي --watch على إعادة المزامنة فوراً كلما تغيّرت الملفات، بلا حاجة إلى مهمة cron.",
        "خادم Relayium قابل أيضاً للاستضافة الذاتية كحاوية Docker واحدة إن أردت تشغيل كل شيء بنفسك بدل الاعتماد على relayium.com؛ وجّه إليه CLI باستخدام --server.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: ["أهمّ الفروق، جنباً إلى جنب:"],
      bullets: [
        "لا مسار مباشر متاح: يحمل مُرحِّل Transit Relay في magic-wormhole التدفّق المُشفَّر فتكتمل عملية النقل؛ أما send/receive في Relayium فمباشر فقط ويفشل في تلك الحالة.",
        "التحدّث إلى خادم: يعيد Relayium استخدام وصول SSH لديك (push/pull) أو daemon بـ TLS مثبَّت؛ أما magic-wormhole فلا تكامل SSH لديه — ثبّته على الطرفين وشارك رمزاً.",
        "مزامنة المجلدات: يعكس relayium sync تزايدياً مع --delete و --watch؛ أما magic-wormhole فيرسل دفعة (أو مجلداً مضغوطاً) ثم يخرج، بلا دلالات مرآة أو حذف.",
        "التحقق: كلاهما مشفَّر من الطرف إلى الطرف؛ ويعرض send/receive في Relayium إضافةً رمز SAS قصيراً يقارنه الطرفان قبل بدء النقل.",
        "الاستضافة الذاتية: خادم Relayium صورة Docker واحدة تستطيع تشغيلها بنفسك، تخدم CLI وتطبيق المتصفح معاً؛ ويمكن لـ send/receive في CLI التوجّه إليه بـ --server.",
        "الترخيص والتكلفة: كلاهما مجاني ومفتوح المصدر. لا يحتاج magic-wormhole حساباً إطلاقاً، أما Relayium فيحتاجه لـ send فقط، كي يُصدر رمز الاقتران.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل CLI الخاص بـ Relayium مجاني؟",
        a: "نعم، تماماً. لا توجد فئة مدفوعة ولا شيء يُقاس — كل وضع يوصل الطرفين مباشرة، و CLI مفتوح المصدر.",
      },
      {
        q: "هل يحتاج إلى حساب؟",
        a: "‏send نعم، وكذلك up السحابي. يستخدم push/pull وصول SSH الخاص بك، ويستخدم daemon-direct ثقة شهادة TLS المثبَّتة بين أجهزتك، فلا يلمس أيٌّ منهما حساب Relayium. أما send/receive فهو الاستثناء: لا يستطيع إصدار رمز الاقتران إلا الخادم، ولحساب مسجَّل الدخول فقط، لذا يشغّل المُرسِل relayium login مرة واحدة — أما send الذي تمرّر له رمزاً أعطاك إياه غيرك فلا يُصدر شيئاً ولا يحتاج تسجيل دخول. أما الاستقبال فلا يحتاج حساباً أبداً.",
      },
      {
        q: "ماذا لو كنت خلف NAT صارم ولا يوجد مسار مباشر؟",
        a: "send/receive في Relayium مباشر فقط وسيفشل في تلك الحالة — فهو لا يرجع إلى مُرحِّل. يستطيع مُرحِّل Transit Relay في magic-wormhole حمل التدفّق المُشفَّر وإتمام النقل رغم ذلك. إن احتجت أن يعمل مهما كان شكل الشبكة، فإن magic-wormhole يعالج هذه الحالة اليوم؛ كما يعمل push/pull في Relayium أو daemon-direct مقابل خادم تستطيع الوصول إليه، لأنهما لا يعتمدان على قفزة مباشرة من الند للند.",
      },
      {
        q: "هل أستطيع استخدام رمز الاقتران في CLI مع تطبيق متصفح Relayium؟",
        a: "ليس بعد لنقل مقترن حيّ — إذ يستخدم send/receive في CLI مصافحته المباشرة الخاصة، المنفصلة عن تدفّق الاقتران القائم على WebRTC في المتصفح، فلا يتوافق الاثنان اليوم. لتسليم ملف لشخص يستخدم المتصفح فقط، استخدم رابط التنزيل المُخزَّن في Relayium أو وضع رمز الاقتران الخاص بتطبيق المتصفح نفسه.",
      },
      {
        q: "هل أستطيع استضافته ذاتياً؟",
        a: "نعم. يُشحن خادم Relayium كصورة Docker (docker compose up -d --build)، ويمكنك توجيه send/receive في CLI إلى نسختك الخاصة بـ --server https://your-domain.",
      },
    ],
  },
  cta: {
    text: "ثبّت CLI المجاني الخاص بـ Relayium وجرّب push أو sync أو send — مجاناً تماماً، ونقل قائم على رمز يبدأ بالسرعة نفسها مثل magic-wormhole.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium vs magic-wormhole: transferencia de archivos por CLI",
  description:
    "Tanto magic-wormhole como la CLI de Relayium mueven archivos entre terminales con un código corto y cifrado de extremo a extremo. Una comparación justa, incluida la única concesión honesta que conviene conocer.",
  updatedLabel: "Última actualización",
  lead: [
    "magic-wormhole se ha ganado en silencio una base de seguidores fieles: lo ejecutas, obtienes un código corto y legible como 7-crossover-clockwork, se lo lees a la otra persona y el archivo llega — cifrado todo el trayecto, sin cuenta y sin ningún servidor en el que tengas que pensar. La CLI de Relayium se construye en torno a una idea similar: un código corto que empareja dos ordenadores directamente y cifra todo lo que pasa entre ellos.",
    "Se solapan mucho, y donde no lo hacen, vale la pena ser preciso al respecto — incluido el único punto en el que magic-wormhole es hoy genuinamente más resistente que la CLI de Relayium.",
  ],
  sections: [
    {
      heading: "Lo que tienen en común",
      body: [
        "Ambas herramientas resuelven el mismo problema central de la misma forma honesta: sin ningún archivo depositado en un servidor que no controlas, y un código corto como lo único que los dos extremos se pasan por otro canal. magic-wormhole no necesita cuenta alguna; Relayium solo se la pide a quien envía, para que su servidor pueda generar ese código, y quien recibe sigue sin necesitarla.",
      ],
      bullets: [
        "Cifrado de extremo a extremo: magic-wormhole deriva una clave de sesión del propio código wormhole usando un PAKE (SPAKE2), de modo que ni siquiera su propio servidor de encuentro llega a conocer la clave; el send/receive de Relayium hace un intercambio de claves X25519 directamente entre los dos extremos y muestra un código de verificación corto (SAS) que puedes comparar antes de que se mueva ningún byte.",
        "Sin cuenta para recibir, en ambas herramientas — y ninguna en absoluto para magic-wormhole.",
        "Gratis y de código abierto — lee el código fuente que toca tus archivos.",
        "Multiplataforma: macOS, Linux y Windows.",
      ],
    },
    {
      heading: "El único punto en que magic-wormhole es más resistente: tiene un retransmisor",
      body: [
        "Esta es la concesión honesta, y vale la pena decirla claramente en lugar de pasarla por alto. magic-wormhole incluye un Transit Relay al que puede recurrir cuando los dos extremos no pueden abrir una conexión directa entre sí — por ejemplo, ambos lados detrás de un NAT estricto o simétrico sin forma de atravesarlo. El retransmisor solo ve texto cifrado, pero como está ahí, la transferencia igualmente se completa.",
        "El send/receive de Relayium es solo directo: busca una conexión directa durante unos segundos justo después del apretón de manos, y si no encuentra ninguna, la transferencia falla sin más en lugar de recurrir a ningún retransmisor — los servidores de Relayium nunca tocan los bytes de archivos de una transferencia CLI entre redes, por diseño. En la práctica eso es poco frecuente (la mayoría de las redes domésticas y de oficina permiten un camino directo), pero si estás moviendo archivos entre dos máquinas que están ambas detrás de NAT inusualmente estrictos, es más probable que magic-wormhole simplemente funcione. Si no se puede encontrar un camino directo y la fiabilidad importa más que evitar un retransmisor, ese es el caso para recurrir a magic-wormhole — o para usar el push/pull o el daemon-direct de Relayium contra un servidor al que realmente puedas llegar, que no dependen en absoluto de ese salto P2P directo.",
      ],
    },
    {
      heading: "SSH y daemon-direct: hablar con un servidor que ya operas",
      body: [
        "Donde la CLI de Relayium añade superficie real es fuera del caso puntual del código de emparejamiento: dos formas más de mover archivos que se apoyan en infraestructura que ya tienes, algo que magic-wormhole no intenta cubrir.",
        "relayium push / pull reutiliza tu acceso SSH existente, así que no hay nada nuevo en lo que confiar ni ningún código de emparejamiento que compartir. push incluso funciona contra un servidor sin relayium instalado en absoluto, recurriendo a un simple flujo tar sobre la conexión SSH — ese respaldo es solo para push; pull siempre necesita relayium en el remoto, ya que actúa allí como remitente.",
        "relayium serve convierte cualquier máquina que poseas en un destino daemon-direct, accesible por TLS 1.3 fijado sin SSH ni código de emparejamiento — la confianza se establece en la primera conexión (aprobada de forma interactiva, o preautorizada para uso desatendido) y queda fijada a partir de entonces, la misma idea que una clave de host SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Sincronización de carpetas y un servidor autoalojable",
      body: [
        "magic-wormhole envía un lote de archivos (o una carpeta, comprimida) y termina — envíalo de nuevo para actualizar el otro lado, sin ninguna noción de qué debería eliminarse. La CLI de Relayium añade relayium sync, un espejo incremental de un solo sentido sobre cualquiera de los dos transportes anteriores: solo mueve lo que cambió, --delete elimina en el destino los archivos que desaparecieron del origen (un daemon solo lo respeta si se inició con --allow-delete, así que el receptor tiene que optar por ello), y --watch sigue resincronizando en tiempo real a medida que los archivos cambian, sin necesidad de ninguna tarea cron.",
        "El servidor de Relayium también es autoalojable como un único contenedor Docker si quieres ejecutar todo tú mismo en lugar de depender de relayium.com; apunta la CLI hacia él con --server.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Comparativa de funciones de un vistazo",
      body: ["Las diferencias que más importan, una al lado de la otra:"],
      bullets: [
        "Sin camino directo disponible: el Transit Relay de magic-wormhole transporta el flujo cifrado, así que la transferencia igualmente se completa; el send/receive de Relayium es solo directo y falla en ese caso.",
        "Hablar con un servidor: Relayium reutiliza tu acceso SSH (push/pull) o un daemon con TLS fijado; magic-wormhole no tiene integración con SSH — instálalo en ambos extremos y comparte un código.",
        "Sincronización de carpetas: relayium sync hace un espejo incremental con --delete y --watch; magic-wormhole envía un lote (o una carpeta comprimida) y termina, sin semántica de espejo ni de eliminación.",
        "Verificación: ambos están cifrados de extremo a extremo; el send/receive de Relayium muestra además un código SAS corto que ambos lados comparan antes de que empiece la transferencia.",
        "Autoalojamiento: el servidor de Relayium es una única imagen Docker que puedes ejecutar tú mismo, sirviendo tanto la CLI como la aplicación web; el send/receive de la CLI puede apuntar hacia él con --server.",
        "Licencia y coste: ambos gratis y de código abierto. magic-wormhole no requiere cuenta alguna; Relayium solo la requiere para send, para generar el código de emparejamiento.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Es gratis la CLI de Relayium?",
        a: "Sí, completamente. No hay un nivel de pago ni nada que medir — cada modo conecta los dos extremos directamente, y la CLI es de código abierto.",
      },
      {
        q: "¿Necesita una cuenta?",
        a: "send sí, y el up en la nube también. push/pull usa tu propio acceso SSH y daemon-direct usa la confianza de certificado TLS fijado entre tus máquinas, así que ninguno toca una cuenta de Relayium. send/receive es la excepción: solo el servidor puede generar un código de emparejamiento, y solo para una cuenta con sesión iniciada, así que quien envía ejecuta relayium login una vez; un send al que le pasas un código que te dieron no genera ninguno y no necesita inicio de sesión. Recibir nunca necesita cuenta.",
      },
      {
        q: "¿Qué pasa si estoy detrás de un NAT estricto y no hay camino directo?",
        a: "El send/receive de Relayium es solo directo y fallará en ese caso — no recurre a un retransmisor. El Transit Relay de magic-wormhole todavía puede transportar el flujo cifrado y completar la transferencia. Si necesitas que funcione sin importar cómo sea la red, magic-wormhole cubre ese caso hoy; el push/pull o el daemon-direct de Relayium contra un servidor al que puedas llegar también funcionan, ya que no dependen de un salto P2P directo.",
      },
      {
        q: "¿Puedo usar el código de emparejamiento de la CLI con la aplicación web de Relayium?",
        a: "Todavía no para una transferencia emparejada en vivo — el send/receive de la CLI usa su propio apretón de manos directo, separado del flujo de emparejamiento del navegador basado en WebRTC, así que los dos no interoperan hoy. Para entregar un archivo a alguien que solo usa un navegador, usa el enlace de descarga almacenado de Relayium o el propio modo de código de emparejamiento de la aplicación web.",
      },
      {
        q: "¿Puedo autoalojarlo?",
        a: "Sí. El servidor de Relayium se distribuye como imagen Docker (docker compose up -d --build), y puedes apuntar el send/receive de la CLI hacia tu propia instancia con --server https://your-domain.",
      },
    ],
  },
  cta: {
    text: "Instala la CLI gratuita de Relayium y prueba push, sync o send — totalmente gratis, y una transferencia basada en código tan rápida de empezar como magic-wormhole.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Relayium vs magic-wormhole: transferência de arquivos por CLI",
  description:
    "Tanto o magic-wormhole quanto a CLI do Relayium movem arquivos entre terminais com um código curto e criptografia de ponta a ponta. Uma comparação justa, incluindo a única concessão honesta que vale a pena conhecer.",
  updatedLabel: "Última atualização",
  lead: [
    "O magic-wormhole conquistou silenciosamente um público fiel: você o executa, recebe um código curto e legível como 7-crossover-clockwork, lê para a outra pessoa e o arquivo chega — criptografado o caminho todo, sem conta e sem nenhum servidor com que precise se preocupar. A CLI do Relayium foi construída em torno de uma ideia parecida: um código curto que emparelha dois computadores diretamente e criptografa tudo o que passa entre eles.",
    "Eles se sobrepõem bastante, e onde não se sobrepõem vale a pena ser preciso — incluindo o único ponto em que o magic-wormhole hoje é genuinamente mais resiliente que a CLI do Relayium.",
  ],
  sections: [
    {
      heading: "O que eles têm em comum",
      body: [
        "Ambas as ferramentas resolvem o mesmo problema central da mesma forma honesta: sem nenhum arquivo depositado em um servidor que você não controla, e um código curto como a única coisa que as duas pontas trocam por outro canal. O magic-wormhole não precisa de conta nenhuma; o Relayium pede login só a quem envia, para que o servidor dele possa gerar esse código, e quem recebe continua sem precisar.",
      ],
      bullets: [
        "Criptografado de ponta a ponta: o magic-wormhole deriva uma chave de sessão do próprio código wormhole usando um PAKE (SPAKE2), de modo que nem seu próprio servidor de encontro chega a conhecer a chave; o send/receive do Relayium faz uma troca de chaves X25519 diretamente entre as duas pontas e mostra um código de verificação curto (SAS) que você pode comparar antes de qualquer byte se mover.",
        "Sem conta para receber, em ambas as ferramentas — e nenhuma conta para o magic-wormhole.",
        "Gratuito e de código aberto — leia o código-fonte que toca seus arquivos.",
        "Multiplataforma: macOS, Linux e Windows.",
      ],
    },
    {
      heading: "O único ponto em que o magic-wormhole é mais resiliente: ele tem um retransmissor",
      body: [
        "Essa é a concessão honesta, e vale a pena dizê-la com clareza em vez de contorná-la. O magic-wormhole vem com um Transit Relay ao qual pode recorrer quando as duas pontas não conseguem abrir uma conexão direta entre si — por exemplo, ambos os lados atrás de um NAT rígido ou simétrico sem como atravessá-lo. O retransmissor só vê texto cifrado, mas, por existir, a transferência ainda assim se completa.",
        "O send/receive do Relayium é somente direto: ele tenta uma conexão direta por alguns segundos logo após o handshake e, se não encontra nenhuma, a transferência simplesmente falha em vez de recorrer a qualquer retransmissor — os servidores do Relayium nunca tocam os bytes de arquivos de uma transferência CLI entre redes, por design. Na prática isso é raro (a maioria das redes domésticas e de escritório permite um caminho direto), mas se você estiver movendo arquivos entre duas máquinas ambas atrás de NAT excepcionalmente rígidos, é mais provável que o magic-wormhole simplesmente funcione. Se não for possível encontrar um caminho direto e a confiabilidade importar mais do que evitar um retransmissor, esse é o caso para recorrer ao magic-wormhole — ou para usar o push/pull ou o daemon-direct do Relayium contra um servidor que você realmente consiga alcançar, que não dependem em nada desse salto P2P direto.",
      ],
    },
    {
      heading: "SSH e daemon-direct: falar com um servidor que você já opera",
      body: [
        "Onde a CLI do Relayium acrescenta superfície de verdade é fora do caso pontual do código de emparelhamento: mais duas formas de mover arquivos que se apoiam em infraestrutura que você já tem, algo que o magic-wormhole não tenta cobrir.",
        "O relayium push / pull reutiliza seu acesso SSH existente, então não há nada novo em que confiar nem nenhum código de emparelhamento a compartilhar. O push até funciona contra um servidor sem nenhum relayium instalado, recorrendo a um simples fluxo tar sobre a conexão SSH — esse recurso de reserva é só do push; o pull sempre precisa do relayium no remoto, já que ali ele atua como remetente.",
        "O relayium serve transforma qualquer máquina que você possua em um destino daemon-direct, acessível por TLS 1.3 fixado, sem SSH e sem código de emparelhamento — a confiança se estabelece na primeira conexão (aprovada de forma interativa, ou pré-autorizada para uso não supervisionado) e fica fixada a partir daí, a mesma ideia de uma chave de host SSH.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium serve --dir ~/incoming",
        "relayium push ./build relayium://your-server",
      ],
    },
    {
      heading: "Sincronização de pastas e um servidor auto-hospedável",
      body: [
        "O magic-wormhole envia um lote de arquivos (ou uma pasta, compactada) e encerra — envie de novo para atualizar o outro lado, sem nenhuma noção do que deveria ser removido. A CLI do Relayium acrescenta o relayium sync, um espelho incremental de sentido único sobre qualquer um dos dois transportes acima: ele só move o que mudou, o --delete remove no destino os arquivos que desapareceram da origem (um daemon só respeita isso se tiver sido iniciado com --allow-delete, então o receptor precisa optar por isso) e o --watch continua ressincronizando em tempo real conforme os arquivos mudam, sem necessidade de nenhuma tarefa cron.",
        "O servidor do Relayium também é auto-hospedável como um único contêiner Docker, caso você queira rodar tudo por conta própria em vez de depender do relayium.com; aponte a CLI para ele com --server.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Comparação de recursos num relance",
      body: ["As diferenças que mais importam, lado a lado:"],
      bullets: [
        "Sem caminho direto disponível: o Transit Relay do magic-wormhole carrega o fluxo criptografado, então a transferência ainda assim se completa; o send/receive do Relayium é somente direto e falha nesse caso.",
        "Falar com um servidor: o Relayium reutiliza seu acesso SSH (push/pull) ou um daemon com TLS fixado; o magic-wormhole não tem integração com SSH — instale-o nas duas pontas e compartilhe um código.",
        "Sincronização de pastas: o relayium sync faz um espelho incremental com --delete e --watch; o magic-wormhole envia um lote (ou uma pasta compactada) e encerra, sem semântica de espelho nem de exclusão.",
        "Verificação: ambos são criptografados de ponta a ponta; o send/receive do Relayium mostra ainda um código SAS curto que os dois lados comparam antes de a transferência começar.",
        "Auto-hospedagem: o servidor do Relayium é uma única imagem Docker que você pode rodar por conta própria, servindo tanto a CLI quanto o aplicativo web; o send/receive da CLI pode apontar para ele com --server.",
        "Licença e custo: ambos gratuitos e de código aberto. O magic-wormhole não exige conta nenhuma; o Relayium exige apenas para o send, para gerar o código de emparelhamento.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "A CLI do Relayium é gratuita?",
        a: "Sim, completamente. Não há nível pago nem nada a medir — cada modo conecta as duas pontas diretamente, e a CLI é de código aberto.",
      },
      {
        q: "Ela precisa de conta?",
        a: "O send sim, e o up na nuvem também. O push/pull usa seu próprio acesso SSH e o daemon-direct usa a confiança de certificado TLS fixado entre suas máquinas, então nenhum dos dois toca uma conta do Relayium. O send/receive é a exceção: só o servidor pode gerar um código de emparelhamento, e apenas para uma conta com login feito, então quem envia roda relayium login uma vez; um send ao qual você passa um código que lhe deram não gera nenhum e não precisa de login. Receber nunca precisa de conta.",
      },
      {
        q: "E se eu estiver atrás de um NAT rígido e não houver caminho direto?",
        a: "O send/receive do Relayium é somente direto e falhará nesse caso — ele não recorre a um retransmissor. O Transit Relay do magic-wormhole ainda pode carregar o fluxo criptografado e completar a transferência. Se você precisa que funcione não importa como seja a rede, o magic-wormhole cobre esse caso hoje; o push/pull ou o daemon-direct do Relayium contra um servidor que você consiga alcançar também funcionam, já que não dependem de um salto P2P direto.",
      },
      {
        q: "Posso usar o código de emparelhamento da CLI com o aplicativo web do Relayium?",
        a: "Ainda não para uma transferência emparelhada ao vivo — o send/receive da CLI usa seu próprio handshake direto, separado do fluxo de emparelhamento do navegador baseado em WebRTC, então os dois não interoperam hoje. Para entregar um arquivo a alguém que usa apenas um navegador, use o link de download armazenado do Relayium ou o próprio modo de código de emparelhamento do aplicativo web.",
      },
      {
        q: "Posso auto-hospedá-lo?",
        a: "Sim. O servidor do Relayium é distribuído como imagem Docker (docker compose up -d --build), e você pode apontar o send/receive da CLI para a sua própria instância com --server https://your-domain.",
      },
    ],
  },
  cta: {
    text: "Instale a CLI gratuita do Relayium e experimente push, sync ou send — totalmente gratuita, e uma transferência baseada em código tão rápida de começar quanto o magic-wormhole.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/magic-wormhole",
  published: "2026-07-09",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
