// web/scripts/pages/content/articles/guides-what-is-p2p-file-transfer.mjs
// Guide: a plain-language explainer of peer-to-peer file transfer for a general reader.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Facts grounded in web/src/lib/webrtc.ts, ice.ts, transfer.ts and cross-checked
// against guides-how-encryption-works.mjs (tone sibling) for wording consistency.

const en = {
  title: "What is peer-to-peer file transfer?",
  description:
    "A plain-language explainer of P2P file transfer: how it differs from uploading to a server, how a direct WebRTC connection is found, and why it's private and fast.",
  updatedLabel: "Last updated",
  lead: [
    "\"Peer-to-peer\" gets used loosely, so here's what it actually means for a file transfer: your file goes straight from one device to the other, not up to a company's server and back down. No stop in the middle where a copy could sit.",
    "That sounds simple, but the internet isn't built for two random devices to just find each other and talk directly — most connections are hidden behind routers and firewalls that were never designed to be reached from outside. This page explains, in plain terms, how a direct connection actually gets made, when it can't be made, and what that means for your privacy and speed. Relayium is used as the concrete example throughout, since it's a working implementation of exactly this.",
  ],
  sections: [
    {
      heading: "P2P vs. the usual way: cutting out the middle stop",
      body: [
        "Most \"send a file\" tools work by uploading: your file goes from your device up to the company's server, gets stored there, and the other person downloads it back down. That's two hops, and for a while, a full copy of your file sits on someone else's storage — even if it's deleted later.",
        "Peer-to-peer transfer skips that stop. Once a connection is open between your device and the other person's, the file's bytes flow directly across that one hop and nowhere else. There's no server-side copy to store, to secure, or to eventually delete, because it was never uploaded in the first place.",
      ],
      bullets: [
        "Upload-based transfer: your device to a server to their device — two hops, a stored copy in between.",
        "Peer-to-peer transfer: your device straight to their device — one hop, nothing stored.",
        "In Relayium, this is realtime mode: open the site on both devices, connect, and the file streams directly, browser to browser.",
      ],
    },
    {
      heading: "How two devices actually find each other: STUN",
      body: [
        "Here's the part that isn't obvious: your device almost certainly doesn't know its own address as seen from the outside internet — it sits behind a home router or a mobile carrier's network address translation (NAT), which hides it behind a shared public IP and reassigns ports on the fly. The other device is in the same situation. Neither one can just \"dial\" the other directly without first figuring out what address would actually reach it.",
        "That's what STUN (Session Traversal Utilities for NAT) is for. Each device briefly asks a small, lightweight STUN server one question: \"what address and port do you see me coming from?\" The answer tells it its own public-facing address — not the file, not any content, just enough network information to describe a path back to it. Both devices exchange this information (via a signaling step that only carries connection-setup details, never file bytes) and then try to open a direct path to each other's address. In a large share of real-world cases — especially two devices on the same Wi-Fi, or NATs that behave predictably — this works, and a fully direct connection opens.",
      ],
      bullets: [
        "STUN only ever learns and shares network addresses — never file contents, filenames, or encryption keys.",
        "Relayium uses WebRTC for this, the same direct-connection technology built into every modern browser for video calls — repurposed here to move file bytes instead of video frames.",
        "Two devices on the same network (no code needed) typically connect the most directly of all, since there's often no NAT in the way at all.",
      ],
    },
    {
      heading: "When a direct path can't be found: the TURN relay",
      body: [
        "Sometimes STUN isn't enough. Some NATs — especially on stricter corporate networks or certain mobile carriers — are unpredictable enough that no direct path can be discovered from outside information alone. If both devices are behind that kind of NAT, a genuinely direct connection just isn't possible; something has to relay the traffic in between.",
        "That's what TURN (Traversal Using Relays around NAT) is: a fallback relay server that both devices connect to when a direct path fails. It's not a workaround or a compromise on privacy so much as a necessity of how some networks are built — but it's worth being precise about what it does and doesn't see. In Relayium, the file is already encrypted end-to-end before it reaches the relay, so the relay only ever forwards ciphertext — sealed data it has no key to open. It moves bytes; it cannot read them.",
      ],
      bullets: [
        "TURN is only used when a direct path genuinely can't be found — it's a fallback, not the default.",
        "The relay forwards ciphertext only; it never has the decryption key and can't read file contents, filenames, or anything else about what's inside.",
        "Whether a given transfer went direct or through a relay is visible in Relayium's connection diagnostics, for anyone curious to check.",
      ],
    },
    {
      heading: "Why this matters: privacy and speed",
      body: [
        "The privacy case is straightforward: when the file's bytes only ever cross one hop, straight between two devices, there's no server-side storage step where a copy could sit, get logged, or get accessed by anyone else — because it was never put there. That's a structurally different guarantee than \"we promise to delete it eventually.\"",
        "The speed case follows the same logic. An upload-then-download transfer has to cross the network twice — once up, once down — and often waits on the sending side to fully finish before the receiving side can start. A direct connection crosses the network once, and data can stream continuously between the two devices as fast as the slower connection allows, without a server in the middle limiting throughput or adding its own latency.",
      ],
    },
    {
      heading: "How Relayium puts this together",
      body: [
        "Open relayium.com on two devices on the same network and they typically find each other automatically — no account, no code, nothing to install; that's the LAN case where STUN often isn't even needed. Sending across the internet to someone on a different network uses a pairing code: the sender signs in, generates a code (or shares a link, with an optional QR code to scan), and once the other person joins, the same STUN-then-TURN-if-needed process runs to open a direct or relayed connection — the receiver never needs an account either way.",
        "Either way, once the connection is open, up to 1,000 files in a batch stream directly across it, each independently verified with a SHA-256 hash so you know what arrived matches exactly what was sent. If real-time isn't possible — say, the other person is offline — that's a genuinely different mode (a zero-knowledge stored link), not peer-to-peer, and worth understanding separately.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is peer-to-peer the same as end-to-end encrypted?",
        a: "They're related but not identical. P2P describes the network path — bytes going directly between two devices. Encryption describes whether those bytes are unreadable to anyone in between. Relayium's realtime transfers are both: a direct (or relayed-but-encrypted) path, with the file sealed end-to-end regardless of which path it takes.",
      },
      {
        q: "Does a P2P transfer ever touch a server at all?",
        a: "A small signaling server helps the two devices find each other's address — but it only ever sees connection-setup information, never file bytes. If a direct path can't be found, a TURN relay forwards the encrypted file data, but even then it only handles ciphertext it can't decrypt.",
      },
      {
        q: "Why would a direct connection fail in the first place?",
        a: "Some networks — often strict corporate firewalls or certain mobile carrier NATs — are built in a way that makes it impossible to discover a reachable address from outside information alone. That's rarer than it sounds, but when it happens, a relay is what keeps the transfer working instead of failing outright.",
      },
      {
        q: "Is P2P transfer slower when it falls back to a relay?",
        a: "It can add some latency, since the relay is an extra hop the data passes through and it's a shared server rather than a dedicated one. But it's still generally faster than an upload-then-download flow, since there's no wait for the file to fully land on a server before the download side can start.",
      },
      {
        q: "Do both people need an account for a P2P transfer?",
        a: "Two devices on the same network need no account at all. Sending across networks by pairing code needs the sender to sign in, but the person receiving never needs an account either way.",
      },
    ],
  },
  cta: {
    text: "Curious what it feels like? Open Relayium on two devices and watch a direct connection form in real time.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "什么是点对点（P2P）文件传输？",
  description:
    "用大白话讲清 P2P 文件传输：它和先上传到服务器有何不同、WebRTC 如何找到直连路径，以及它为什么更私密、更快。",
  updatedLabel: "最近更新",
  lead: [
    "「点对点」这个词经常被随意使用，但对文件传输来说，它的确切含义是：文件直接从一台设备到另一台设备，而不是先上传到某家公司的服务器再下载下来。中间没有一站可以停留、可能留下副本。",
    "这听起来很简单，但互联网原本并不是为了让两台随机设备直接找到彼此并对话而设计的——大多数连接都藏在路由器和防火墙后面，这些设备从一开始就没打算被外部直接访问到。本文用通俗的语言讲清直连究竟是怎么建立的、什么时候建立不了，以及这对隐私和速度意味着什么。全文会以 Relayium 作为具体例子，因为它正是这套机制的一个真实实现。",
  ],
  sections: [
    {
      heading: "P2P 与常见做法的区别：省掉中间那一站",
      body: [
        "大多数「发送文件」工具的工作方式是上传：文件从你的设备上传到公司的服务器，存放在那里，对方再从服务器下载下来。这是两跳，而且有一段时间，你文件的完整副本会存放在别人的存储上——即便之后会被删除。",
        "点对点传输省掉了这一站。一旦你的设备和对方设备之间建立起连接，文件的字节就直接经这一跳流动，不再经过别处。没有服务器端的副本需要存储、需要保护，也不需要日后再删除，因为它压根没有被上传过。",
      ],
      bullets: [
        "基于上传的传输：你的设备到服务器再到对方设备——两跳，中间有一份存储的副本。",
        "点对点传输：你的设备直接到对方设备——一跳，什么都不存储。",
        "在 Relayium 中，这就是实时模式：双方打开网站、建立连接，文件就在浏览器之间直接流动。",
      ],
    },
    {
      heading: "两台设备到底如何找到彼此：STUN",
      body: [
        "这里有一个不太直观的地方：你的设备几乎肯定不知道自己在公网上看起来是什么地址——它藏在家用路由器或运营商的网络地址转换（NAT）后面，这层机制会把它隐藏在一个共享的公网 IP 之后，并动态地重新分配端口。对方设备也处于同样的处境。双方都无法在不先弄清楚「什么地址才能真正连到对方」之前，直接「拨号」找到对方。",
        "这正是 STUN（NAT 会话穿越工具）的用途。每台设备会向一个轻量的 STUN 服务器简短地问一个问题：「你看到我是从哪个地址、哪个端口过来的？」答案告诉它自己对外可见的地址——不涉及文件，不涉及任何内容，只是足够描述一条能连回它的路径的网络信息。双方交换这些信息（通过一个只承载连接建立细节、从不承载文件字节的信令步骤），然后尝试直接打通到对方地址的路径。在很多真实场景中——尤其是同一个 Wi-Fi 下的两台设备，或者行为可预测的 NAT——这一步就能成功，从而建立起完全直连的连接。",
      ],
      bullets: [
        "STUN 始终只获取和交换网络地址——从不涉及文件内容、文件名或加密密钥。",
        "Relayium 用的是 WebRTC 来实现这一步，这正是现代浏览器内置用于视频通话的直连技术——这里被重新用来传输文件字节而非视频画面。",
        "同一网络下的两台设备（不需要配对码）通常连得最直接，因为往往根本没有 NAT 挡在中间。",
      ],
    },
    {
      heading: "找不到直连路径时：TURN 中继",
      body: [
        "有时 STUN 还不够。有些 NAT——尤其是较严格的企业网络或某些移动运营商——行为难以预测，仅凭外部信息根本无法找出一条直连路径。如果双方设备都处在这类 NAT 之后，真正意义上的直连就是不可能的；总得有什么东西居中转发流量。",
        "这正是 TURN（借助中继穿越 NAT）的作用：当直连路径失败时，双方设备都会连接到一个兜底的中继服务器。这与其说是一种权宜之计或对隐私的妥协，不如说是某些网络结构本身决定的必然情况——但值得说清楚它到底能看到什么、看不到什么。在 Relayium 中，文件在到达中继之前就已经端到端加密完毕，因此中继始终只转发密文——一段它没有钥匙打开的封装数据。它只负责搬运字节，无法读懂内容。",
      ],
      bullets: [
        "只有在真正找不到直连路径时才会用到 TURN——它是兜底方案，不是默认选项。",
        "中继只转发密文；它从不掌握解密密钥，无法读取文件内容、文件名或其中的任何其他信息。",
        "一次传输走的是直连还是中继，都能在 Relayium 的连接诊断信息里看到，供好奇的人自行核实。",
      ],
    },
    {
      heading: "为什么这很重要：隐私与速度",
      body: [
        "隐私方面的道理很直接：当文件的字节只经过一跳、直接在两台设备之间流动时，就不存在一个服务器端的存储环节，让副本可能停留、被记录，或被别人访问——因为它压根没被放在那里过。这与「我们承诺以后会删除」是结构上完全不同的保证。",
        "速度方面的道理也是一样。先上传再下载的传输需要两次穿越网络——上行一次，下行一次——而且经常需要等发送方完全上传完，接收方才能开始下载。而直连只穿越网络一次，数据可以在两台设备之间持续流动，速度取决于两端中较慢的那条连接，中间没有服务器限制吞吐量或增加额外延迟。",
      ],
    },
    {
      heading: "Relayium 是如何把这些拼起来的",
      body: [
        "在同一网络下的两台设备上打开 relayium.com，它们通常会自动找到彼此——不需要账号，不需要配对码，也无需安装任何东西；这就是局域网场景，很多时候甚至用不上 STUN。要跨网络发给不同网络上的人，则用配对码：发送方登录、生成一个配对码（或分享链接，也可选择扫描二维码），对方加入之后，同样是先 STUN、必要时再 TURN 的流程来建立直连或中继连接——无论走哪条路径，接收方都不需要账号。",
        "无论哪种方式，一旦连接建立，一批最多 1,000 个文件就会直接经这条连接流动，每个文件都独立用 SHA-256 哈希校验，确保到手的和发出的分毫不差。如果实时传输做不到——比如对方不在线——那就是一种确实不同的模式（零知识存储链接），不属于点对点，值得单独理解。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "点对点和端到端加密是一回事吗？",
        a: "两者相关但并不相同。P2P 描述的是网络路径——字节直接在两台设备之间流动。加密描述的是这些字节对中间任何人是否可读。Relayium 的实时传输两者兼具：无论走的是直连还是「经过中继但已加密」的路径，文件都是端到端封装的。",
      },
      {
        q: "P2P 传输会经过服务器吗？",
        a: "一个小型信令服务器会帮两台设备找到彼此的地址——但它只会看到连接建立所需的信息，从不涉及文件字节。如果找不到直连路径，TURN 中继会转发加密后的文件数据，但即便如此，它处理的也只是它无法解密的密文。",
      },
      {
        q: "直连为什么一开始就会失败？",
        a: "有些网络——常见于较严格的企业防火墙或某些移动运营商的 NAT——其构造方式使得仅凭外部信息根本无法找出一条可达的地址。这种情况比听起来要少见，但一旦发生，中继就是让传输继续进行而不是直接失败的关键。",
      },
      {
        q: "走中继时，P2P 传输会变慢吗？",
        a: "会增加一些延迟，因为中继是数据要经过的一跳额外路径，而且是共享服务器而非专用服务器。但总体上仍然比先上传再下载要快，因为不需要等文件完全落到服务器上，下载端才能开始。",
      },
      {
        q: "P2P 传输是否双方都需要账号？",
        a: "同一网络下的两台设备完全不需要账号。跨网络用配对码发送时，需要发送方登录，但无论哪种方式，接收方都不需要账号。",
      },
    ],
  },
  cta: {
    text: "想亲身感受一下？在两台设备上打开 Relayium，看着一条直连连接实时建立起来。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "P2P（ピアツーピア）ファイル転送とは？",
  description:
    "P2P ファイル転送を平易に解説。サーバーへのアップロードとの違い、WebRTC が直接接続を見つける仕組み、プライベートかつ高速である理由まで。",
  updatedLabel: "最終更新",
  lead: [
    "「ピアツーピア」という言葉はあいまいに使われがちですが、ファイル転送における本当の意味はこうです。ファイルは会社のサーバーに一度アップロードされてからダウンロードされるのではなく、一台のデバイスからもう一台へ直接送られます。途中にコピーが留まりうる寄り道はありません。",
    "簡単そうに聞こえますが、インターネットはもともと2台の見知らぬデバイスが勝手に見つけ合って直接話せるようには作られていません——ほとんどの接続はルーターやファイアウォールの内側に隠れていて、外部から到達されることを想定していないのです。このページでは、直接接続が実際にどう確立されるのか、確立できないときはどうなるのか、それがプライバシーと速度にとって何を意味するのかを平易な言葉で説明します。具体例として全編で Relayium を取り上げますが、これはまさにこの仕組みを実装したサービスだからです。",
  ],
  sections: [
    {
      heading: "P2P と一般的な方式の違い：中間の寄り道を省く",
      body: [
        "ほとんどの「ファイルを送る」ツールはアップロード方式で動きます。あなたのデバイスから会社のサーバーへファイルが送られ、そこに保存され、相手はそれをダウンロードします。これは2ホップであり、しばらくの間、あなたのファイルの完全なコピーが他者のストレージ上に存在します——後で削除されるとしてもです。",
        "ピアツーピア転送はこの寄り道を省きます。あなたのデバイスと相手のデバイスの間に接続が開けば、ファイルのバイトはその1ホップだけを直接流れ、他のどこも経由しません。保存すべきサーバー側のコピーも、守るべき対象も、いずれ削除すべきものもありません。そもそもアップロードされていないからです。",
      ],
      bullets: [
        "アップロード方式：あなたのデバイス → サーバー → 相手のデバイス——2ホップで、途中に保存されたコピーがある。",
        "ピアツーピア方式：あなたのデバイス → 相手のデバイス——1ホップで、何も保存されない。",
        "Relayium ではこれがリアルタイムモードにあたります。両方のデバイスでサイトを開いて接続すれば、ファイルはブラウザ間で直接ストリーミングされます。",
      ],
    },
    {
      heading: "2台のデバイスが実際にどう見つけ合うか：STUN",
      body: [
        "ここが直感的ではない部分です。あなたのデバイスは、外部インターネットからどう見えているかをほぼ確実に知りません——家庭用ルーターや通信キャリアのネットワークアドレス変換（NAT）の内側にあり、共有のグローバル IP の裏に隠され、ポートも動的に割り当てられます。相手のデバイスも同じ状況です。どちらも、実際に到達できるアドレスをまず知らなければ、相手に直接「電話」をかけることはできません。",
        "そこで使われるのが STUN（NAT 越え用セッション走査ユーティリティ）です。各デバイスは軽量な STUN サーバーに短く一つの質問をします。「私はどのアドレス・ポートから来ているように見えますか？」その答えが、自分の外部向けアドレスを教えてくれます——ファイルでも、コンテンツでもなく、そこへの経路を示すのに十分なネットワーク情報だけです。両デバイスはこの情報を（接続確立の詳細だけを運び、ファイルのバイトは一切運ばないシグナリングの手順を通じて）交換し、互いのアドレスへ直接経路を開こうとします。多くの現実のケース——特に同じ Wi-Fi 上の2台や、挙動が予測可能な NAT——では、これだけで成功し、完全な直接接続が開きます。",
      ],
      bullets: [
        "STUN が扱うのはネットワークアドレスの取得と交換のみです——ファイルの中身やファイル名、暗号鍵は一切扱いません。",
        "Relayium はこれに WebRTC を使います。現代のあらゆるブラウザにビデオ通話用として組み込まれている同じ直接接続技術を、映像フレームの代わりにファイルのバイトを運ぶために転用しています。",
        "同じネットワーク上の2台（コード不要）は、多くの場合そもそも間に NAT がないため、最も直接的につながる傾向があります。",
      ],
    },
    {
      heading: "直接経路が見つからないとき：TURN 中継",
      body: [
        "STUN だけでは足りないこともあります。一部の NAT——特に厳しい企業ネットワークや一部の通信キャリア——は挙動が予測できず、外部から得られる情報だけでは到達可能なアドレスを発見できないことがあります。両方のデバイスがそうした NAT の内側にある場合、本当の意味での直接接続は不可能で、何かが間でトラフィックを中継する必要があります。",
        "それが TURN（NAT 越えのための中継利用）です。直接経路が失敗したときに両デバイスが接続するフォールバック用の中継サーバーです。これは回避策やプライバシーの妥協というより、一部のネットワークの構造そのものが要求する必然と言えます——ただし、それが何を見て何を見ないのかは正確に説明する価値があります。Relayium では、ファイルは中継に届く前にすでにエンドツーエンドで暗号化されているため、中継が転送するのは常に暗号文だけです——開ける鍵を持たない封印されたデータです。バイトを運ぶだけで、読むことはできません。",
      ],
      bullets: [
        "TURN が使われるのは、本当に直接経路が見つからない場合だけです——既定ではなく、あくまでフォールバックです。",
        "中継は暗号文だけを転送します。復号鍵を持つことは決してなく、ファイルの中身もファイル名も、中に含まれる他の情報も読めません。",
        "ある転送が直接だったか中継経由だったかは、確認したい人であれば Relayium の接続診断情報から見ることができます。",
      ],
    },
    {
      heading: "なぜこれが重要か：プライバシーと速度",
      body: [
        "プライバシー面の理屈はシンプルです。ファイルのバイトが1ホップだけ、2台のデバイス間を直接横切るとき、コピーが留まったり記録されたり他人にアクセスされたりし得るサーバー側の保存段階そのものが存在しません——そもそもそこに置かれたことがないからです。これは「いずれ削除すると約束します」とは構造的にまったく異なる保証です。",
        "速度面の理屈も同じ論理です。アップロードしてからダウンロードする転送は、ネットワークを2回——上りと下り——横切らねばならず、送信側が完全に完了するまで受信側が開始できないこともよくあります。直接接続はネットワークを1回だけ横切り、間にスループットを制限したり独自の遅延を加えたりするサーバーがないまま、両デバイス間で遅い方の接続が許す速さでデータが連続的にストリーミングされます。",
      ],
    },
    {
      heading: "Relayium はこれをどう組み合わせているか",
      body: [
        "同じネットワーク上の2台で relayium.com を開くと、たいていは自動的に見つけ合います——アカウントもコードも不要、インストールするものも何もありません。これがローカルネットワークのケースで、多くの場合 STUN すら不要です。異なるネットワーク上の相手にインターネット越しに送る場合はペアリングコードを使います。送信者がサインインしてコードを生成する（または QR コードのオプション付きでリンクを共有する）と、相手が参加した時点で、同じく STUN、必要なら TURN という流れで直接または中継接続が開きます——どちらの経路でも受信者はアカウント不要です。",
        "いずれの場合も、接続が開けば最大1,000ファイルのバッチがその接続を直接流れ、それぞれが SHA-256 ハッシュで個別に検証されるので、届いたものが送られたものと正確に一致しているか分かります。リアルタイムが不可能な場合——たとえば相手がオフラインの場合——は、それは本当に別のモード（ゼロ知識の保存リンク）であり、ピアツーピアではないので、別に理解しておく価値があります。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ピアツーピアとエンドツーエンド暗号化は同じことですか？",
        a: "関連はしていますが同じではありません。P2P はネットワーク経路——バイトが2台のデバイス間を直接移動すること——を指します。暗号化は、そのバイトが途中の誰にとっても読めないかどうかを指します。Relayium のリアルタイム転送は両方を備えています。どちらの経路を取るかに関わらず、ファイルは直接（または中継経由だが暗号化された）経路上で、エンドツーエンドで封印されています。",
      },
      {
        q: "P2P 転送はそもそもサーバーに触れることがあるのですか？",
        a: "小さなシグナリングサーバーが2台のデバイスが互いのアドレスを見つけるのを助けますが、それが見るのは接続確立の情報だけで、ファイルのバイトは一切見ません。直接経路が見つからない場合は TURN 中継が暗号化されたファイルデータを転送しますが、それでも扱うのは復号できない暗号文だけです。",
      },
      {
        q: "そもそもなぜ直接接続が失敗することがあるのですか？",
        a: "一部のネットワーク——厳しい企業ファイアウォールや一部の通信キャリアの NAT に多い——は、外部から得られる情報だけでは到達可能なアドレスを発見できないような構造になっています。聞こえるほど頻繁ではありませんが、起きた場合には中継が転送を完全な失敗にせず継続させる役割を果たします。",
      },
      {
        q: "中継にフォールバックすると P2P 転送は遅くなりますか？",
        a: "中継はデータが通過する余分な1ホップであり、専用サーバーではなく共有サーバーであるため、多少の遅延は増える可能性があります。それでも一般には、アップロードしてからダウンロードする流れより速いです。ファイルが完全にサーバーに届くのを待たずにダウンロード側が開始できるからです。",
      },
      {
        q: "P2P 転送には双方ともアカウントが必要ですか？",
        a: "同じネットワーク上の2台であればアカウントはまったく不要です。ペアリングコードで異なるネットワーク間に送る場合は送信者のサインインが必要ですが、どちらの経路でも受信者はアカウント不要です。",
      },
    ],
  },
  cta: {
    text: "実際にどんな感じか気になりますか？2台のデバイスで Relayium を開いて、直接接続がリアルタイムに形成される様子を見てみてください。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "P2P(피어투피어) 파일 전송이란?",
  description:
    "P2P 파일 전송을 쉽게 설명합니다. 서버 업로드 방식과 무엇이 다른지, WebRTC가 직접 연결을 찾는 방법, 왜 사적이고 빠른지까지.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "\"피어투피어\"라는 말은 느슨하게 쓰이곤 하지만, 파일 전송에서 실제로 의미하는 바는 이렇습니다. 파일이 어느 회사의 서버로 올라갔다가 다시 내려오는 게 아니라, 한 기기에서 다른 기기로 곧장 이동한다는 뜻입니다. 중간에 사본이 머무를 수 있는 정거장이 없습니다.",
    "간단해 보이지만, 인터넷은 원래 임의의 두 기기가 서로를 알아서 찾아 직접 대화하도록 설계되지 않았습니다——대부분의 연결은 라우터와 방화벽 뒤에 숨어 있고, 이들은 애초에 외부에서 도달되도록 만들어지지 않았습니다. 이 페이지는 직접 연결이 실제로 어떻게 만들어지는지, 만들어지지 못할 때는 어떻게 되는지, 그것이 프라이버시와 속도에 어떤 의미인지를 쉬운 말로 설명합니다. 전체적으로 Relayium을 구체적인 예시로 사용하는데, 바로 이 메커니즘을 실제로 구현한 서비스이기 때문입니다.",
  ],
  sections: [
    {
      heading: "P2P와 일반적인 방식의 차이: 중간 정거장을 없애다",
      body: [
        "대부분의 \"파일 보내기\" 도구는 업로드 방식으로 동작합니다. 당신의 기기에서 회사 서버로 파일이 올라가 그곳에 저장되고, 상대방은 그것을 다시 다운로드합니다. 이는 두 번의 이동이며, 나중에 삭제되더라도 한동안은 당신 파일의 완전한 사본이 다른 누군가의 저장소에 존재합니다.",
        "피어투피어 전송은 이 정거장을 건너뜁니다. 당신의 기기와 상대방 기기 사이에 연결이 열리면, 파일의 바이트는 그 한 번의 이동만으로 직접 흐르고 다른 어디도 거치지 않습니다. 저장하거나 보호하거나 나중에 삭제해야 할 서버 측 사본이 없습니다. 애초에 업로드된 적이 없기 때문입니다.",
      ],
      bullets: [
        "업로드 기반 전송: 내 기기 → 서버 → 상대 기기——두 번의 이동, 그 사이에 저장된 사본.",
        "피어투피어 전송: 내 기기 → 상대 기기——한 번의 이동, 아무것도 저장되지 않음.",
        "Relayium에서는 이것이 실시간 모드입니다. 두 기기 모두에서 사이트를 열고 연결하면 파일이 브라우저 간에 직접 스트리밍됩니다.",
      ],
    },
    {
      heading: "두 기기가 실제로 서로를 찾는 방법: STUN",
      body: [
        "여기 직관적이지 않은 부분이 있습니다. 당신의 기기는 외부 인터넷에서 자신이 어떻게 보이는지 거의 확실히 알지 못합니다——가정용 라우터나 통신사의 네트워크 주소 변환(NAT) 뒤에 있어, 공유된 공인 IP 뒤에 숨겨지고 포트도 동적으로 재할당됩니다. 상대 기기도 같은 처지입니다. 어느 쪽도 실제로 도달 가능한 주소를 먼저 알아내지 않고서는 상대에게 곧바로 \"전화를 걸\" 수 없습니다.",
        "이때 쓰이는 것이 STUN(NAT 통과용 세션 순회 유틸리티)입니다. 각 기기는 가벼운 STUN 서버에 짧게 한 가지를 묻습니다. \"내가 어느 주소, 어느 포트에서 오는 것으로 보이나요?\" 그 답이 자신의 외부 주소를 알려줍니다——파일도, 어떤 콘텐츠도 아니고, 그곳으로 가는 경로를 설명하기에 충분한 네트워크 정보일 뿐입니다. 두 기기는 이 정보를(연결 설정 세부 사항만 전달하고 파일 바이트는 전혀 전달하지 않는 시그널링 단계를 통해) 교환한 뒤, 서로의 주소로 직접 경로를 열려고 시도합니다. 실제 상황의 상당수——특히 같은 Wi-Fi에 있는 두 기기나 예측 가능하게 동작하는 NAT——에서는 이것만으로 성공해 완전히 직접적인 연결이 열립니다.",
      ],
      bullets: [
        "STUN은 오직 네트워크 주소만 알아내고 주고받습니다——파일 내용, 파일 이름, 암호화 키는 절대 다루지 않습니다.",
        "Relayium은 이를 위해 WebRTC를 사용합니다. 모든 현대 브라우저에 화상 통화용으로 내장된 것과 같은 직접 연결 기술을, 영상 프레임 대신 파일 바이트를 옮기는 데 재사용한 것입니다.",
        "같은 네트워크에 있는 두 기기(코드 불필요)는 대개 그 사이에 NAT 자체가 없는 경우가 많아 가장 직접적으로 연결되는 경향이 있습니다.",
      ],
    },
    {
      heading: "직접 경로를 찾지 못할 때: TURN 중계",
      body: [
        "때로는 STUN만으로 부족합니다. 일부 NAT——특히 엄격한 기업 네트워크나 일부 이동통신사——는 예측하기 어렵게 동작해서, 외부 정보만으로는 도달 가능한 주소를 전혀 발견할 수 없는 경우가 있습니다. 두 기기 모두 그런 종류의 NAT 뒤에 있다면 진정한 의미의 직접 연결은 불가능하며, 무언가가 그 사이에서 트래픽을 중계해야 합니다.",
        "그것이 TURN(NAT 우회를 위한 중계 사용)입니다. 직접 경로가 실패했을 때 두 기기가 모두 연결하는 대체 중계 서버입니다. 이는 우회책이나 프라이버시 타협이라기보다, 일부 네트워크가 구축된 방식이 요구하는 필연에 가깝습니다——다만 그것이 무엇을 보고 무엇을 보지 못하는지는 정확히 짚어볼 가치가 있습니다. Relayium에서는 파일이 중계에 도달하기 전에 이미 종단간 암호화되어 있으므로, 중계는 항상 암호문만 전달합니다——열 수 있는 키가 없는 봉인된 데이터입니다. 바이트를 옮길 뿐, 읽을 수는 없습니다.",
      ],
      bullets: [
        "TURN은 직접 경로를 정말로 찾을 수 없을 때만 사용됩니다——기본값이 아니라 대체 수단입니다.",
        "중계는 암호문만 전달합니다. 복호화 키를 절대 갖지 않으며, 파일 내용도 파일 이름도 그 안의 다른 어떤 정보도 읽을 수 없습니다.",
        "특정 전송이 직접 연결이었는지 중계를 거쳤는지는 궁금한 사람이라면 Relayium의 연결 진단 정보에서 확인할 수 있습니다.",
      ],
    },
    {
      heading: "왜 중요한가: 프라이버시와 속도",
      body: [
        "프라이버시 측면의 논리는 단순합니다. 파일의 바이트가 두 기기 사이를 단 한 번만 직접 오갈 때, 사본이 머무르거나 기록되거나 다른 누군가에게 접근될 수 있는 서버 측 저장 단계 자체가 존재하지 않습니다——애초에 거기에 놓인 적이 없기 때문입니다. 이는 \"결국엔 삭제하겠다고 약속합니다\"와는 구조적으로 전혀 다른 보장입니다.",
        "속도 측면의 논리도 같은 맥락입니다. 업로드 후 다운로드하는 전송은 네트워크를 두 번——한 번 올리고, 한 번 내리고——가로질러야 하며, 종종 발신 측이 완전히 끝날 때까지 수신 측이 시작하지 못하고 기다립니다. 직접 연결은 네트워크를 한 번만 가로지르며, 처리량을 제한하거나 자체 지연을 더하는 서버가 중간에 없이, 둘 중 느린 쪽 연결이 허용하는 속도로 데이터가 두 기기 사이에서 끊임없이 스트리밍될 수 있습니다.",
      ],
    },
    {
      heading: "Relayium이 이를 어떻게 조합하는가",
      body: [
        "같은 네트워크에 있는 두 기기에서 relayium.com을 열면 보통 자동으로 서로를 찾습니다——계정도, 코드도 필요 없고, 설치할 것도 없습니다. 이것이 LAN 상황이며, 많은 경우 STUN조차 필요하지 않습니다. 다른 네트워크에 있는 사람에게 인터넷 너머로 보낼 때는 페어링 코드를 사용합니다. 발신자가 로그인해서 코드를 생성하면(또는 스캔할 수 있는 QR 코드 옵션과 함께 링크를 공유하면), 상대방이 참여하는 순간 마찬가지로 STUN 후 필요 시 TURN이라는 과정을 거쳐 직접 또는 중계 연결이 열립니다——어느 경로든 수신자는 계정이 필요 없습니다.",
        "어느 경우든 연결이 열리면 최대 1,000개 파일이 그 연결을 통해 직접 스트리밍되며, 각 파일은 개별적으로 SHA-256 해시로 검증되어 도착한 것이 보낸 것과 정확히 일치하는지 확인합니다. 실시간이 불가능한 경우——예를 들어 상대방이 오프라인인 경우——는 정말로 다른 모드(영지식 저장 링크)이지 피어투피어가 아니며, 별도로 이해할 가치가 있습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "피어투피어와 종단간 암호화는 같은 것인가요?",
        a: "관련은 있지만 같지는 않습니다. P2P는 네트워크 경로——바이트가 두 기기 사이를 직접 이동하는 것——를 가리킵니다. 암호화는 그 바이트가 중간의 누구에게도 읽히지 않는지를 가리킵니다. Relayium의 실시간 전송은 둘 다에 해당합니다. 어느 경로를 거치든, 파일은 종단간으로 봉인되어 있습니다.",
      },
      {
        q: "P2P 전송이 애초에 서버를 거치기는 하나요?",
        a: "작은 시그널링 서버가 두 기기가 서로의 주소를 찾도록 돕지만, 그것이 보는 것은 연결 설정 정보뿐이며 파일 바이트는 전혀 보지 않습니다. 직접 경로를 찾지 못하면 TURN 중계가 암호화된 파일 데이터를 전달하지만, 그때조차 다루는 것은 복호화할 수 없는 암호문뿐입니다.",
      },
      {
        q: "직접 연결은 애초에 왜 실패할 수 있나요?",
        a: "일부 네트워크——엄격한 기업 방화벽이나 일부 이동통신사 NAT에 흔함——는 외부 정보만으로는 도달 가능한 주소를 발견할 수 없도록 구성되어 있습니다. 들리는 것보다는 드물지만, 그런 일이 생기면 중계가 전송을 완전한 실패 대신 계속 작동하게 해줍니다.",
      },
      {
        q: "중계로 대체되면 P2P 전송이 느려지나요?",
        a: "중계는 데이터가 통과하는 추가적인 한 단계이고 전용 서버가 아닌 공유 서버이므로 약간의 지연이 더해질 수 있습니다. 그래도 파일이 서버에 완전히 도착할 때까지 기다리지 않고 다운로드 측이 시작할 수 있으므로, 업로드 후 다운로드하는 방식보다는 대체로 더 빠릅니다.",
      },
      {
        q: "P2P 전송에는 양쪽 모두 계정이 필요한가요?",
        a: "같은 네트워크에 있는 두 기기는 계정이 전혀 필요 없습니다. 페어링 코드로 다른 네트워크 간에 보낼 때는 발신자의 로그인이 필요하지만, 어느 경로든 수신자는 계정이 필요 없습니다.",
      },
    ],
  },
  cta: {
    text: "직접 느껴보고 싶으신가요? 두 기기에서 Relayium을 열고 직접 연결이 실시간으로 만들어지는 것을 지켜보세요.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Was ist Peer-to-Peer-Dateiübertragung?",
  description:
    "Eine verständliche Erklärung von P2P-Dateiübertragung: der Unterschied zum Hochladen auf einen Server, wie eine direkte WebRTC-Verbindung entsteht und warum sie privat und schnell ist.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "„Peer-to-Peer“ wird oft locker verwendet, aber bei einer Dateiübertragung bedeutet es konkret: Ihre Datei geht direkt von einem Gerät zum anderen — nicht auf den Server eines Unternehmens hoch und wieder herunter. Kein Zwischenstopp, an dem eine Kopie liegen bleiben könnte.",
    "Das klingt einfach, aber das Internet ist nicht dafür gebaut, dass zwei beliebige Geräte sich einfach finden und direkt miteinander sprechen — die meisten Verbindungen verstecken sich hinter Routern und Firewalls, die nie dafür ausgelegt waren, von außen erreicht zu werden. Diese Seite erklärt in einfachen Worten, wie eine direkte Verbindung tatsächlich zustande kommt, wann das nicht möglich ist und was das für Ihre Privatsphäre und Geschwindigkeit bedeutet. Relayium dient dabei durchgehend als konkretes Beispiel, denn es ist eine funktionierende Umsetzung genau dieses Mechanismus.",
  ],
  sections: [
    {
      heading: "P2P vs. der übliche Weg: den Zwischenstopp streichen",
      body: [
        "Die meisten „Datei senden“-Tools funktionieren per Upload: Ihre Datei geht von Ihrem Gerät auf den Server des Anbieters hoch, wird dort gespeichert, und die andere Person lädt sie wieder herunter. Das sind zwei Hops, und eine Weile lang liegt eine vollständige Kopie Ihrer Datei auf fremdem Speicher — auch wenn sie später gelöscht wird.",
        "Peer-to-Peer-Übertragung überspringt diesen Zwischenstopp. Sobald eine Verbindung zwischen Ihrem Gerät und dem der anderen Person offen ist, fließen die Bytes der Datei direkt über diesen einen Hop und nirgendwo sonst hin. Es gibt keine serverseitige Kopie, die gespeichert, gesichert oder irgendwann gelöscht werden müsste — denn sie wurde nie hochgeladen.",
      ],
      bullets: [
        "Upload-basierte Übertragung: Ihr Gerät zu einem Server zum Gerät der anderen Person — zwei Hops, dazwischen eine gespeicherte Kopie.",
        "Peer-to-Peer-Übertragung: Ihr Gerät direkt zum Gerät der anderen Person — ein Hop, nichts wird gespeichert.",
        "Bei Relayium ist das der Echtzeitmodus: Beide Geräte öffnen die Seite, verbinden sich, und die Datei streamt direkt von Browser zu Browser.",
      ],
    },
    {
      heading: "Wie zwei Geräte sich tatsächlich finden: STUN",
      body: [
        "Hier kommt der nicht offensichtliche Teil: Ihr Gerät kennt so gut wie sicher seine eigene Adresse, wie sie vom öffentlichen Internet aus gesehen wird, gar nicht — es sitzt hinter einem heimischen Router oder der Network Address Translation (NAT) eines Mobilfunkanbieters, die es hinter einer geteilten öffentlichen IP verbirgt und Ports laufend neu zuweist. Das andere Gerät befindet sich in derselben Lage. Keines von beiden kann das andere einfach „anwählen“, ohne vorher herauszufinden, welche Adresse es überhaupt erreichen würde.",
        "Genau dafür ist STUN (Session Traversal Utilities for NAT) da. Jedes Gerät stellt kurz einem schlanken STUN-Server eine Frage: „Von welcher Adresse und welchem Port aus siehst du mich kommen?“ Die Antwort verrät ihm seine eigene nach außen sichtbare Adresse — keine Datei, kein Inhalt, nur genug Netzwerkinformation, um einen Weg zurück zu ihm zu beschreiben. Beide Geräte tauschen diese Information aus (über einen Signalisierungsschritt, der ausschließlich Verbindungsaufbau-Details trägt, nie Dateibytes) und versuchen dann, einen direkten Pfad zur Adresse des jeweils anderen zu öffnen. In einem großen Teil realer Fälle — besonders bei zwei Geräten im selben WLAN oder bei NATs mit vorhersehbarem Verhalten — funktioniert das, und es öffnet sich eine vollständig direkte Verbindung.",
      ],
      bullets: [
        "STUN lernt und teilt ausschließlich Netzwerkadressen — nie Dateiinhalte, Dateinamen oder Verschlüsselungsschlüssel.",
        "Relayium nutzt dafür WebRTC, dieselbe Direktverbindungstechnologie, die in jedem modernen Browser für Videoanrufe eingebaut ist — hier zweckentfremdet, um Dateibytes statt Videobilder zu bewegen.",
        "Zwei Geräte im selben Netzwerk (kein Code nötig) verbinden sich meist am direktesten von allen, weil oft überhaupt kein NAT im Weg steht.",
      ],
    },
    {
      heading: "Wenn kein direkter Pfad gefunden werden kann: das TURN-Relay",
      body: [
        "Manchmal reicht STUN nicht aus. Manche NATs — besonders bei strengeren Unternehmensnetzwerken oder bestimmten Mobilfunkanbietern — verhalten sich so unvorhersehbar, dass sich allein aus außen zugänglichen Informationen kein direkter Pfad ermitteln lässt. Sitzen beide Geräte hinter dieser Art von NAT, ist eine wirklich direkte Verbindung schlicht nicht möglich; etwas muss den Verkehr dazwischen weiterleiten.",
        "Dafür gibt es TURN (Traversal Using Relays around NAT): einen Ausweich-Relay-Server, mit dem sich beide Geräte verbinden, wenn ein direkter Pfad scheitert. Das ist weniger ein Workaround oder ein Kompromiss bei der Privatsphäre als vielmehr eine Notwendigkeit, die sich daraus ergibt, wie manche Netzwerke aufgebaut sind — es lohnt sich aber, genau zu sagen, was es sieht und was nicht. Bei Relayium ist die Datei bereits Ende-zu-Ende verschlüsselt, bevor sie das Relay erreicht, sodass das Relay stets nur Chiffretext weiterleitet — versiegelte Daten, für die es keinen Schlüssel besitzt. Es transportiert Bytes; lesen kann es sie nicht.",
      ],
      bullets: [
        "TURN wird nur eingesetzt, wenn wirklich kein direkter Pfad gefunden werden kann — es ist ein Fallback, nicht der Standard.",
        "Das Relay leitet ausschließlich Chiffretext weiter; es besitzt nie den Entschlüsselungsschlüssel und kann weder Dateiinhalte noch Dateinamen noch sonst etwas über den Inhalt lesen.",
        "Ob eine bestimmte Übertragung direkt oder über ein Relay lief, ist in Relayiums Verbindungsdiagnose sichtbar, für alle, die es nachprüfen möchten.",
      ],
    },
    {
      heading: "Warum das wichtig ist: Privatsphäre und Geschwindigkeit",
      body: [
        "Das Argument für die Privatsphäre ist unkompliziert: Wenn die Bytes der Datei nur einen einzigen Hop überqueren, direkt zwischen zwei Geräten, gibt es keinen serverseitigen Speicherschritt, an dem eine Kopie liegen, protokolliert oder von jemand anderem eingesehen werden könnte — weil sie nie dort abgelegt wurde. Das ist eine strukturell andere Garantie als „wir versprechen, sie irgendwann zu löschen“.",
        "Das Geschwindigkeitsargument folgt derselben Logik. Eine Upload-dann-Download-Übertragung muss das Netzwerk zweimal überqueren — einmal hoch, einmal runter — und wartet oft, bis die Sendeseite vollständig fertig ist, bevor die Empfangsseite starten kann. Eine direkte Verbindung überquert das Netzwerk nur einmal, und Daten können kontinuierlich zwischen den beiden Geräten fließen, so schnell wie es die langsamere Verbindung erlaubt, ohne einen Server dazwischen, der den Durchsatz begrenzt oder eigene Latenz hinzufügt.",
      ],
    },
    {
      heading: "Wie Relayium das zusammenfügt",
      body: [
        "Öffnen zwei Geräte im selben Netzwerk relayium.com, finden sie sich meist automatisch — kein Konto, kein Code, nichts zu installieren; das ist der LAN-Fall, in dem STUN oft nicht einmal gebraucht wird. Für den Versand über das Internet an jemanden in einem anderen Netzwerk kommt ein Pairing-Code zum Einsatz: Der Absender meldet sich an, erzeugt einen Code (oder teilt einen Link, wahlweise mit QR-Code zum Scannen), und sobald die andere Person beitritt, läuft derselbe Ablauf — erst STUN, bei Bedarf TURN — um eine direkte oder über ein Relay geführte Verbindung zu öffnen. Der Empfänger braucht in beiden Fällen kein Konto.",
        "So oder so: Sobald die Verbindung steht, streamen bis zu 1.000 Dateien in einem Stapel direkt darüber, jede einzeln mit einem SHA-256-Hash geprüft, sodass Sie wissen, dass das Angekommene exakt dem Gesendeten entspricht. Ist Echtzeit nicht möglich — etwa weil die andere Person offline ist —, handelt es sich um einen wirklich anderen Modus (einen Zero-Knowledge-Speicherlink), nicht um Peer-to-Peer, und das ist es wert, separat verstanden zu werden.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist Peer-to-Peer dasselbe wie Ende-zu-Ende-Verschlüsselung?",
        a: "Beides hängt zusammen, ist aber nicht identisch. P2P beschreibt den Netzwerkpfad — Bytes, die direkt zwischen zwei Geräten fließen. Verschlüsselung beschreibt, ob diese Bytes für alle dazwischen unlesbar sind. Relayiums Echtzeitübertragungen sind beides: ein direkter (oder über ein Relay geführter, aber verschlüsselter) Pfad, bei dem die Datei unabhängig vom gewählten Pfad Ende-zu-Ende versiegelt ist.",
      },
      {
        q: "Berührt eine P2P-Übertragung überhaupt jemals einen Server?",
        a: "Ein kleiner Signalisierungsserver hilft den beiden Geräten, die Adresse des jeweils anderen zu finden — er sieht dabei aber nur Verbindungsaufbau-Informationen, nie Dateibytes. Lässt sich kein direkter Pfad finden, leitet ein TURN-Relay die verschlüsselten Dateidaten weiter, verarbeitet aber auch dann nur Chiffretext, den es nicht entschlüsseln kann.",
      },
      {
        q: "Warum sollte eine direkte Verbindung überhaupt scheitern?",
        a: "Manche Netzwerke — häufig strenge Unternehmensfirewalls oder bestimmte NATs von Mobilfunkanbietern — sind so aufgebaut, dass sich allein aus außen zugänglichen Informationen keine erreichbare Adresse ermitteln lässt. Das kommt seltener vor, als es klingt, aber wenn es passiert, sorgt ein Relay dafür, dass die Übertragung weiterläuft, statt komplett zu scheitern.",
      },
      {
        q: "Ist eine P2P-Übertragung langsamer, wenn sie auf ein Relay ausweicht?",
        a: "Es kann etwas Latenz hinzukommen, da das Relay ein zusätzlicher Hop ist, den die Daten durchlaufen, und es sich um einen geteilten statt einen dedizierten Server handelt. Trotzdem ist es meist noch schneller als ein Upload-dann-Download-Ablauf, da nicht gewartet werden muss, bis die Datei vollständig auf einem Server angekommen ist, bevor die Download-Seite starten kann.",
      },
      {
        q: "Brauchen bei einer P2P-Übertragung beide Seiten ein Konto?",
        a: "Zwei Geräte im selben Netzwerk brauchen überhaupt kein Konto. Beim Versand über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden, aber die empfangende Person braucht in beiden Fällen nie ein Konto.",
      },
    ],
  },
  cta: {
    text: "Neugierig, wie sich das anfühlt? Öffnen Sie Relayium auf zwei Geräten und beobachten Sie, wie sich eine direkte Verbindung in Echtzeit aufbaut.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Qu'est-ce que le transfert de fichiers pair à pair ?",
  description:
    "Une explication simple du transfert pair à pair : la différence avec l'envoi vers un serveur, comment WebRTC établit une connexion directe, et pourquoi c'est privé et rapide.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "« Pair à pair » est une expression employée un peu librement, alors voici ce qu'elle signifie vraiment pour un transfert de fichiers : votre fichier va directement d'un appareil à l'autre, pas vers le serveur d'une entreprise puis à nouveau vers le bas. Aucune étape intermédiaire où une copie pourrait rester.",
    "Cela paraît simple, mais Internet n'a pas été conçu pour que deux appareils quelconques se trouvent tout seuls et se parlent directement — la plupart des connexions se cachent derrière des routeurs et des pare-feu jamais prévus pour être atteints de l'extérieur. Cette page explique, en termes simples, comment une connexion directe s'établit réellement, quand elle ne le peut pas, et ce que cela signifie pour votre vie privée et la vitesse. Relayium sert d'exemple concret tout au long du texte, puisqu'il s'agit d'une implémentation fonctionnelle exactement de ce mécanisme.",
  ],
  sections: [
    {
      heading: "P2P contre la méthode habituelle : supprimer l'étape intermédiaire",
      body: [
        "La plupart des outils « envoyer un fichier » fonctionnent par téléversement : votre fichier part de votre appareil vers le serveur de l'entreprise, y est stocké, puis l'autre personne le télécharge à son tour. Cela fait deux sauts, et pendant un moment, une copie complète de votre fichier repose sur le stockage de quelqu'un d'autre — même si elle est supprimée par la suite.",
        "Le transfert pair à pair supprime cette étape. Une fois qu'une connexion est ouverte entre votre appareil et celui de l'autre personne, les octets du fichier circulent directement sur ce seul saut, et nulle part ailleurs. Il n'y a pas de copie côté serveur à stocker, à sécuriser ou à finir par supprimer, puisqu'elle n'a jamais été téléversée en premier lieu.",
      ],
      bullets: [
        "Transfert par téléversement : votre appareil vers un serveur vers l'appareil de l'autre — deux sauts, une copie stockée entre les deux.",
        "Transfert pair à pair : votre appareil directement vers l'appareil de l'autre — un seul saut, rien de stocké.",
        "Chez Relayium, c'est le mode temps réel : ouvrez le site sur les deux appareils, connectez-les, et le fichier circule directement, navigateur à navigateur.",
      ],
    },
    {
      heading: "Comment deux appareils se trouvent réellement : STUN",
      body: [
        "Voici la partie qui n'est pas évidente : votre appareil ne connaît presque certainement pas sa propre adresse telle qu'elle est vue depuis l'Internet public — il se trouve derrière un routeur domestique ou la traduction d'adresse réseau (NAT) d'un opérateur mobile, qui le dissimule derrière une adresse IP publique partagée et réattribue les ports à la volée. L'autre appareil est dans la même situation. Aucun des deux ne peut simplement « composer » l'autre directement sans d'abord déterminer quelle adresse permettrait réellement de l'atteindre.",
        "C'est à cela que sert STUN (Session Traversal Utilities for NAT). Chaque appareil pose brièvement une question à un serveur STUN léger : « depuis quelle adresse et quel port me vois-tu arriver ? » La réponse lui indique sa propre adresse visible de l'extérieur — ni fichier, ni contenu, juste assez d'information réseau pour décrire un chemin pour le rejoindre. Les deux appareils échangent cette information (via une étape de signalisation qui ne transporte que des détails d'établissement de connexion, jamais des octets de fichier), puis tentent d'ouvrir un chemin direct vers l'adresse de l'autre. Dans une large part des cas réels — en particulier deux appareils sur le même Wi-Fi, ou des NAT au comportement prévisible — cela fonctionne, et une connexion entièrement directe s'ouvre.",
      ],
      bullets: [
        "STUN n'apprend et ne partage jamais que des adresses réseau — jamais le contenu des fichiers, leurs noms, ni les clés de chiffrement.",
        "Relayium utilise WebRTC pour cela, la même technologie de connexion directe intégrée à tous les navigateurs modernes pour les appels vidéo — détournée ici pour déplacer des octets de fichier plutôt que des images vidéo.",
        "Deux appareils sur le même réseau (aucun code requis) se connectent généralement le plus directement de tous, car il n'y a souvent aucun NAT en travers du chemin.",
      ],
    },
    {
      heading: "Quand aucun chemin direct ne peut être trouvé : le relais TURN",
      body: [
        "Parfois, STUN ne suffit pas. Certains NAT — en particulier sur des réseaux d'entreprise plus stricts ou chez certains opérateurs mobiles — sont suffisamment imprévisibles pour qu'aucun chemin direct ne puisse être découvert à partir des seules informations externes. Si les deux appareils se trouvent derrière ce genre de NAT, une connexion réellement directe est tout simplement impossible ; quelque chose doit relayer le trafic entre les deux.",
        "C'est le rôle de TURN (Traversal Using Relays around NAT) : un serveur relais de secours auquel les deux appareils se connectent lorsqu'un chemin direct échoue. Ce n'est pas tant un contournement ou un compromis sur la vie privée qu'une nécessité liée à la façon dont certains réseaux sont construits — mais il vaut la peine d'être précis sur ce qu'il voit et ne voit pas. Chez Relayium, le fichier est déjà chiffré de bout en bout avant d'atteindre le relais, si bien que celui-ci ne transmet toujours que du chiffré — des données scellées dont il n'a pas la clé. Il déplace des octets ; il ne peut pas les lire.",
      ],
      bullets: [
        "TURN n'est utilisé que lorsqu'aucun chemin direct ne peut réellement être trouvé — c'est un repli, pas le comportement par défaut.",
        "Le relais ne transmet que du chiffré ; il ne possède jamais la clé de déchiffrement et ne peut lire ni le contenu des fichiers, ni leurs noms, ni rien d'autre à leur sujet.",
        "Le fait qu'un transfert donné soit passé en direct ou via un relais est visible dans les diagnostics de connexion de Relayium, pour qui souhaite vérifier.",
      ],
    },
    {
      heading: "Pourquoi cela compte : vie privée et vitesse",
      body: [
        "L'argument de la vie privée est simple : quand les octets du fichier ne traversent qu'un seul saut, directement entre deux appareils, il n'existe aucune étape de stockage côté serveur où une copie pourrait rester, être journalisée ou être consultée par quelqu'un d'autre — parce qu'elle n'y a jamais été déposée. C'est une garantie structurellement différente d'un « nous promettons de la supprimer un jour ».",
        "L'argument de la vitesse suit la même logique. Un transfert téléversement-puis-téléchargement doit traverser le réseau deux fois — une fois vers le haut, une fois vers le bas — et attend souvent que le côté émetteur ait entièrement terminé avant que le côté récepteur puisse commencer. Une connexion directe ne traverse le réseau qu'une seule fois, et les données peuvent circuler en continu entre les deux appareils, aussi vite que le permet la connexion la plus lente, sans serveur intermédiaire limitant le débit ou ajoutant sa propre latence.",
      ],
    },
    {
      heading: "Comment Relayium assemble tout cela",
      body: [
        "Ouvrez relayium.com sur deux appareils du même réseau et ils se trouvent généralement automatiquement — pas de compte, pas de code, rien à installer ; c'est le cas du réseau local, où STUN n'est souvent même pas nécessaire. Pour envoyer sur Internet vers quelqu'un sur un autre réseau, on utilise un code de jumelage : l'expéditeur se connecte, génère un code (ou partage un lien, avec en option un QR code à scanner), et dès que l'autre personne rejoint, le même processus — STUN puis TURN si nécessaire — s'exécute pour ouvrir une connexion directe ou relayée ; le destinataire n'a besoin d'aucun compte, quel que soit le chemin emprunté.",
        "Dans tous les cas, une fois la connexion ouverte, jusqu'à 1 000 fichiers d'un même lot circulent directement dessus, chacun vérifié indépendamment par un hachage SHA-256, afin que vous sachiez que ce qui est arrivé correspond exactement à ce qui a été envoyé. Si le temps réel n'est pas possible — par exemple si l'autre personne est hors ligne —, il s'agit d'un mode réellement différent (un lien stocké à connaissance nulle), pas de pair à pair, et cela vaut la peine d'être compris séparément.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Le pair à pair est-il la même chose que le chiffrement de bout en bout ?",
        a: "Les deux sont liés mais pas identiques. Le P2P décrit le chemin réseau — des octets circulant directement entre deux appareils. Le chiffrement décrit si ces octets sont illisibles pour quiconque se trouverait entre les deux. Les transferts en temps réel de Relayium réunissent les deux : un chemin direct (ou relayé mais chiffré), avec un fichier scellé de bout en bout quel que soit le chemin emprunté.",
      },
      {
        q: "Un transfert P2P touche-t-il quand même un serveur ?",
        a: "Un petit serveur de signalisation aide les deux appareils à trouver l'adresse l'un de l'autre — mais il ne voit jamais que des informations d'établissement de connexion, jamais les octets du fichier. Si aucun chemin direct ne peut être trouvé, un relais TURN transmet les données de fichier chiffrées, mais même alors il ne traite que du chiffré qu'il ne peut pas déchiffrer.",
      },
      {
        q: "Pourquoi une connexion directe échouerait-elle en premier lieu ?",
        a: "Certains réseaux — souvent des pare-feu d'entreprise stricts ou certains NAT d'opérateurs mobiles — sont construits de façon à rendre impossible la découverte d'une adresse joignable à partir des seules informations externes. C'est plus rare que ça n'en a l'air, mais quand cela arrive, un relais permet au transfert de continuer à fonctionner plutôt que d'échouer purement et simplement.",
      },
      {
        q: "Un transfert P2P est-il plus lent quand il bascule sur un relais ?",
        a: "Cela peut ajouter un peu de latence, puisque le relais est un saut supplémentaire que traversent les données, et qu'il s'agit d'un serveur partagé plutôt que dédié. Mais c'est généralement encore plus rapide qu'un flux téléversement-puis-téléchargement, car il n'y a pas d'attente que le fichier arrive entièrement sur un serveur avant que le côté téléchargement puisse démarrer.",
      },
      {
        q: "Les deux personnes ont-elles besoin d'un compte pour un transfert P2P ?",
        a: "Deux appareils sur le même réseau n'ont besoin d'aucun compte. Envoyer entre réseaux différents via un code de jumelage exige que l'expéditeur se connecte, mais la personne qui reçoit n'a jamais besoin de compte, quel que soit le chemin emprunté.",
      },
    ],
  },
  cta: {
    text: "Curieux de voir l'effet que ça fait ? Ouvrez Relayium sur deux appareils et observez une connexion directe se former en temps réel.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "ما هو نقل الملفات من الند للند؟",
  description:
    "شرح بلغة مبسّطة لنقل الملفات من الند للند (P2P): كيف يختلف عن الرفع إلى خادم، وكيف يُعثَر على اتصال WebRTC مباشر، ولماذا هو خاص وسريع.",
  updatedLabel: "آخر تحديث",
  lead: [
    "يُستخدم مصطلح «من الند للند» بشكل فضفاض، وإليك ما يعنيه فعليًا في نقل الملفات: ينتقل ملفك مباشرةً من جهاز إلى آخر، لا صعودًا إلى خادم شركة ونزولًا منه. لا محطة في المنتصف يمكن أن تستقر فيها نسخة.",
    "يبدو ذلك بسيطًا، لكن الإنترنت لم يُبنَ لكي يعثر جهازان عشوائيان على بعضهما ويتحادثا مباشرةً — فمعظم الاتصالات مخفية خلف موجّهات وجدران حماية لم تُصمَّم قط للوصول إليها من الخارج. تشرح هذه الصفحة، بعبارات مبسّطة، كيف يُنشأ الاتصال المباشر فعليًا، ومتى يتعذّر إنشاؤه، وماذا يعني ذلك لخصوصيتك وسرعتك. ويُستخدم Relayium بوصفه المثال الملموس في كل المقال، لأنه تطبيق عملي لهذا الأمر بالضبط.",
  ],
  sections: [
    {
      heading: "P2P مقابل الطريقة المعتادة: إلغاء المحطة الوسطى",
      body: [
        "تعمل معظم أدوات «إرسال ملف» بالرفع: يصعد ملفك من جهازك إلى خادم الشركة، ويُخزَّن هناك، ثم ينزّله الشخص الآخر منه. هذه قفزتان، ولبعض الوقت تستقر نسخة كاملة من ملفك على مساحة تخزين شخص آخر — حتى وإن حُذفت لاحقًا.",
        "يتخطى النقل من الند للند تلك المحطة. فما إن يُفتح اتصال بين جهازك وجهاز الشخص الآخر حتى تتدفق بايتات الملف مباشرةً عبر تلك القفزة الواحدة ولا شيء غيرها. لا توجد نسخة على جانب الخادم لتُخزَّن أو تُؤمَّن أو تُحذَف في نهاية المطاف، لأنها لم تُرفع أصلًا.",
      ],
      bullets: [
        "النقل القائم على الرفع: من جهازك إلى خادم إلى جهازهم — قفزتان، ونسخة مُخزَّنة بينهما.",
        "النقل من الند للند: من جهازك مباشرةً إلى جهازهم — قفزة واحدة، ولا شيء يُخزَّن.",
        "في Relayium، هذا هو الوضع الفوري: افتح الموقع على الجهازين، واتصل، ويُبَثّ الملف مباشرةً من متصفح إلى متصفح.",
      ],
    },
    {
      heading: "كيف يعثر جهازان على بعضهما فعليًا: STUN",
      body: [
        "إليك الجزء غير البديهي: يكاد يكون مؤكدًا أن جهازك لا يعرف عنوانه الخاص كما يُرى من الإنترنت الخارجي — فهو يقبع خلف موجّه منزلي أو خلف ترجمة عناوين الشبكة (NAT) لمشغّل الهاتف المحمول، التي تخفيه خلف عنوان IP عام مشترك وتعيد تخصيص المنافذ لحظيًا. والجهاز الآخر في الوضع نفسه. ولا يمكن لأي منهما أن «يتصل» بالآخر مباشرةً دون أن يعرف أولًا أي عنوان يصل إليه فعلًا.",
        "هذا هو الغرض من STUN (أدوات اجتياز الجلسة عبر NAT). يسأل كل جهاز خادم STUN صغيرًا خفيفًا سؤالًا واحدًا لوهلة: «من أي عنوان ومنفذ تراني قادمًا؟» فتخبره الإجابة بعنوانه المرئي للخارج — لا الملف، ولا أي محتوى، بل ما يكفي من معلومات الشبكة لوصف مسار العودة إليه. ويتبادل الجهازان هذه المعلومات (عبر خطوة إشارة لا تحمل سوى تفاصيل إعداد الاتصال، ولا تحمل بايتات الملف قط) ثم يحاولان فتح مسار مباشر إلى عنوان كل منهما. وفي حصة كبيرة من الحالات الواقعية — لا سيما جهازان على نفس شبكة Wi-Fi، أو أنواع NAT التي تتصرف على نحو متوقّع — ينجح ذلك، ويُفتح اتصال مباشر بالكامل.",
      ],
      bullets: [
        "لا يعرف STUN ويشارك سوى عناوين الشبكة — ولا يعرف قط محتويات الملفات أو أسماءها أو مفاتيح التشفير.",
        "يستخدم Relayium تقنية WebRTC لهذا الغرض، وهي تقنية الاتصال المباشر نفسها المدمجة في كل متصفح حديث لمكالمات الفيديو — أُعيد توظيفها هنا لنقل بايتات الملفات بدلًا من إطارات الفيديو.",
        "جهازان على نفس الشبكة (دون حاجة إلى رمز) يتصلان عادةً على النحو الأكثر مباشرةً بينها جميعًا، إذ لا يوجد غالبًا أي NAT يعترض الطريق.",
      ],
    },
    {
      heading: "حين يتعذّر العثور على مسار مباشر: مُرحِّل TURN",
      body: [
        "أحيانًا لا يكفي STUN. فبعض أنواع NAT — لا سيما على شبكات الشركات الأكثر صرامةً أو لدى بعض مشغّلي الهاتف المحمول — يصعب التنبؤ بها إلى حدٍّ يجعل من المستحيل اكتشاف مسار مباشر من المعلومات الخارجية وحدها. وإذا كان كلا الجهازين خلف هذا النوع من NAT، فإن الاتصال المباشر حقًا يكون ببساطة غير ممكن؛ ولا بد لشيء أن يُرحِّل حركة البيانات بينهما.",
        "هذا هو TURN (الاجتياز باستخدام المُرحِّلات حول NAT): خادم مُرحِّل احتياطي يتصل به الجهازان حين يفشل المسار المباشر. وهو ليس حيلة التفافية أو تنازلًا عن الخصوصية بقدر ما هو ضرورة تفرضها طريقة بناء بعض الشبكات — لكن من الجدير التدقيق في ما يراه وما لا يراه. في Relayium، يكون الملف مُشفَّرًا من الطرف إلى الطرف مسبقًا قبل أن يصل إلى المُرحِّل، فلا يُمرِّر المُرحِّل سوى نص مُشفَّر — بيانات مختومة لا يملك مفتاحًا لفتحها. إنه ينقل البايتات؛ ولا يستطيع قراءتها.",
      ],
      bullets: [
        "لا يُستخدم TURN إلا حين يتعذّر فعلًا العثور على مسار مباشر — فهو احتياطي، لا الخيار الافتراضي.",
        "يمرّر المُرحِّل نصًا مُشفَّرًا فقط؛ ولا يملك قط مفتاح فك التشفير ولا يستطيع قراءة محتويات الملفات أو أسمائها أو أي شيء آخر عمّا بداخلها.",
        "أما إن كان نقل معيّن قد جرى مباشرةً أم عبر مُرحِّل فيمكن رؤيته في تشخيصات الاتصال في Relayium، لكل من يرغب في التحقق.",
      ],
    },
    {
      heading: "لماذا يهم هذا: الخصوصية والسرعة",
      body: [
        "حجة الخصوصية واضحة ومباشرة: حين لا تعبر بايتات الملف سوى قفزة واحدة، مباشرةً بين جهازين، فلا توجد خطوة تخزين على جانب الخادم يمكن أن تستقر فيها نسخة أو تُسجَّل أو يصل إليها أي شخص آخر — لأنها لم تُوضَع هناك قط. وهذا ضمان مختلف بنيويًا عن «نَعِدُ بحذفه في نهاية المطاف».",
        "وحجة السرعة تتبع المنطق نفسه. فالنقل بالرفع ثم التنزيل عليه أن يعبر الشبكة مرتين — مرة صعودًا ومرة نزولًا — وكثيرًا ما ينتظر جانب الإرسال حتى ينتهي تمامًا قبل أن يستطيع جانب الاستقبال البدء. أما الاتصال المباشر فيعبر الشبكة مرة واحدة، ويمكن للبيانات أن تُبَثّ باستمرار بين الجهازين بأقصى سرعة يسمح بها الاتصال الأبطأ، دون خادم في المنتصف يحدّ من الإنتاجية أو يضيف زمن استجابته الخاص.",
      ],
    },
    {
      heading: "كيف يجمع Relayium هذا كله",
      body: [
        "افتح relayium.com على جهازين على نفس الشبكة فيعثر كل منهما على الآخر تلقائيًا في العادة — دون حساب ودون رمز ودون أي شيء يُثبَّت؛ تلك هي حالة الشبكة المحلية التي لا يكون STUN فيها ضروريًا غالبًا. أما الإرسال عبر الإنترنت إلى شخص على شبكة مختلفة فيستخدم رمز اقتران: يسجّل المُرسِل الدخول، ويولّد رمزًا (أو يشارك رابطًا، مع رمز QR اختياري للمسح)، وما إن ينضم الشخص الآخر حتى تعمل العملية نفسها — STUN ثم TURN عند الحاجة — لفتح اتصال مباشر أو عبر مُرحِّل — ولا يحتاج المُستقبِل إلى حساب في كلتا الحالتين.",
        "في كلتا الحالتين، ما إن يُفتح الاتصال حتى يُبَثّ ما يصل إلى 1000 ملف في دفعة واحدة مباشرةً عبره، ويُتحقَّق من كل منها على حدة بتجزئة SHA-256 كي تعرف أن ما وصل يطابق تمامًا ما أُرسل. وإذا تعذّر الوضع الفوري — كأن يكون الشخص الآخر غير متصل — فذلك وضع مختلف حقًا (رابط مُخزَّن بمعرفة صفرية)، لا نقل من الند للند، ويستحق أن يُفهَم على حدة.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل النقل من الند للند هو نفسه التشفير من الطرف إلى الطرف؟",
        a: "هما مترابطان لكنهما ليسا متطابقين. فـ P2P يصف مسار الشبكة — بايتات تنتقل مباشرةً بين جهازين. أما التشفير فيصف ما إذا كانت تلك البايتات غير قابلة للقراءة لأي أحد في المنتصف. والنقل الفوري في Relayium يجمع الاثنين: مسار مباشر (أو عبر مُرحِّل لكنه مُشفَّر)، مع ختم الملف من الطرف إلى الطرف بصرف النظر عن المسار الذي يسلكه.",
      },
      {
        q: "هل يمرّ النقل من الند للند بأي خادم على الإطلاق؟",
        a: "يساعد خادم إشارة صغير الجهازين على العثور على عنوان كل منهما — لكنه لا يرى سوى معلومات إعداد الاتصال، ولا يرى بايتات الملف قط. وإن تعذّر العثور على مسار مباشر، فإن مُرحِّل TURN يمرّر بيانات الملف المُشفَّرة، لكنه حتى حينئذٍ لا يتعامل إلا مع نص مُشفَّر لا يستطيع فك تشفيره.",
      },
      {
        q: "لماذا قد يفشل الاتصال المباشر من الأساس؟",
        a: "بعض الشبكات — غالبًا جدران الحماية الصارمة للشركات أو بعض أنواع NAT لدى مشغّلي الهاتف المحمول — مبنية على نحو يجعل من المستحيل اكتشاف عنوان يمكن الوصول إليه من المعلومات الخارجية وحدها. وهذا أندر مما يبدو، لكن حين يحدث يكون المُرحِّل هو ما يُبقي النقل عاملًا بدلًا من أن يفشل تمامًا.",
      },
      {
        q: "هل يكون النقل من الند للند أبطأ حين يتراجع إلى مُرحِّل؟",
        a: "قد يضيف بعض زمن الاستجابة، إذ إن المُرحِّل قفزة إضافية تمر بها البيانات وهو خادم مشترك لا خادم مخصَّص. لكنه يظل أسرع عمومًا من أسلوب الرفع ثم التنزيل، إذ لا انتظار لاستقرار الملف كاملًا على خادم قبل أن يبدأ جانب التنزيل.",
      },
      {
        q: "هل يحتاج الطرفان إلى حساب للنقل من الند للند؟",
        a: "جهازان على نفس الشبكة لا يحتاجان إلى حساب على الإطلاق. والإرسال عبر الشبكات برمز اقتران يتطلب أن يسجّل المُرسِل الدخول، أما الشخص المُستقبِل فلا يحتاج إلى حساب مطلقًا في كلتا الحالتين.",
      },
    ],
  },
  cta: {
    text: "أتتساءل كيف يبدو الأمر؟ افتح Relayium على جهازين وشاهد اتصالًا مباشرًا يتكوّن في الوقت الفوري.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

export default {
  slug: "guides/what-is-peer-to-peer-file-transfer",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar },
};
