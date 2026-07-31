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
    "That sounds simple, but routes differ in practice. This page first explains generic WebRTC/ICE, where TURN can be a fallback, then separates Relayium's actual choices: LAN browser WebRTC is direct, cross-network browser sessions use TURN by design, and the CLI is direct-only.",
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
        "Relayium's realtime browser mode has two paths: WebRTC is direct on the same LAN, while cross-network sessions use TURN by design to carry end-to-end encrypted ciphertext without keeping a server-side content copy or history.",
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
        "Relayium uses WebRTC directly for same-LAN browser sessions. Its cross-network browser path is deliberately relayed, while the CLI remains direct-only and fails rather than relaying file bytes.",
        "Two devices on the same network (no code needed) typically connect the most directly of all, since there's often no NAT in the way at all.",
      ],
    },
    {
      heading: "When a direct path can't be found: the TURN relay",
      body: [
        "Sometimes STUN isn't enough. Some NATs — especially on stricter corporate networks or certain mobile carriers — are unpredictable enough that no direct path can be discovered from outside information alone. If both devices are behind that kind of NAT, a genuinely direct connection just isn't possible; something has to relay the traffic in between.",
        "In a general WebRTC/ICE design, TURN (Traversal Using Relays around NAT) can be the fallback relay when a direct path fails. Relayium's browser app makes a more deliberate choice: same-LAN sessions use direct WebRTC, while every cross-network session uses TURN from the start. The file is encrypted end-to-end before reaching the relay, so it carries only ciphertext and cannot read or decrypt the content.",
      ],
      bullets: [
        "On the same network Relayium connects devices directly; across networks it uses the TURN relay by default, because a direct path so often can't be found there.",
        "The relay forwards ciphertext only; it never has the decryption key and can't read file contents, filenames, or anything else about what's inside.",
        "Relayium CLI transfers are a separate direct-only path: they never relay file bytes and fail if a direct connection cannot be made.",
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
        "Open relayium.com on two devices on the same network and they typically find each other automatically — no account, no code, nothing to install; that's the LAN case where STUN often isn't even needed. Sending across the internet to someone on a different network uses a pairing code: the sender signs in, generates a code (or shares a link, with an optional QR code to scan), and once the other person joins, the transfer runs over an encrypted TURN relay — the reliable path across unpredictable NATs, and it only ever carries ciphertext — while the receiver never needs an account.",
        "Once the realtime path is open, up to 1,000 files stream continuously over the selected route, each independently verified with a SHA-256 hash. Relayium keeps no server-side realtime content copy or transfer history. If the other person is offline, a zero-knowledge stored link is a genuinely different mode, not a realtime P2P session.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is peer-to-peer the same as end-to-end encrypted?",
        a: "They're related but not identical. P2P describes communication between endpoints, but it does not guarantee that every network hop is direct; TURN may carry the traffic. Encryption describes whether intermediaries can read it. Relayium uses direct WebRTC on the same LAN and end-to-end encrypted TURN across networks, where the relay cannot read or decrypt the content.",
      },
      {
        q: "Does a P2P transfer ever touch a server at all?",
        a: "A small signaling server helps the two devices find each other's address — but it only ever sees connection-setup information, never file bytes. Across networks in the browser, a TURN relay forwards the encrypted file data as a matter of design, but even then it only handles ciphertext it can't decrypt.",
      },
      {
        q: "Why would a direct connection fail in the first place?",
        a: "Some networks — often strict corporate firewalls or certain mobile carrier NATs — are built in a way that makes it impossible to discover a reachable address from outside information alone. Rather than spend twenty-odd seconds finding that out on every transfer, Relayium's browser app sends all cross-network transfers over the relay from the start — so a relay, not a failed direct attempt, is what carries them.",
      },
      {
        q: "Is P2P transfer slower when it goes over a relay?",
        a: "It can add some latency, since the relay is an extra hop the data passes through and it's a shared server rather than a dedicated one. But it's still generally faster than an upload-then-download flow, since there's no wait for the file to fully land on a server before the download side can start.",
      },
      {
        q: "Do both people need an account for a P2P transfer?",
        a: "Two devices on the same network need no account at all. Sending across networks by pairing code needs the sender to sign in, but the person receiving never needs an account either way.",
      },
    ],
  },
  cta: {
    text: "Curious what it feels like? Open Relayium on two devices and start an encrypted realtime session.",
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
    "听起来很简单，但实际路径并不相同。本文先解释通用 WebRTC/ICE 中 TURN 可作为后备的概念，再明确区分 Relayium 的实现：局域网浏览器 WebRTC 直连、跨网络浏览器按设计使用 TURN、CLI 仅直连。",
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
        "Relayium 的实时浏览器模式有两条路径：同一局域网内 WebRTC 直连；跨网络则按设计使用 TURN 承载端到端加密的密文，并且不保留服务器端内容副本或历史。",
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
        "Relayium 在同一局域网的浏览器会话中直接使用 WebRTC；跨网络浏览器路径则有意使用中继。CLI 是另一条仅直连路径，无法直连时会失败，而不会中继文件字节。",
        "同一网络下的两台设备（不需要配对码）通常连得最直接，因为往往根本没有 NAT 挡在中间。",
      ],
    },
    {
      heading: "找不到直连路径时：TURN 中继",
      body: [
        "有时 STUN 还不够。有些 NAT——尤其是较严格的企业网络或某些移动运营商——行为难以预测，仅凭外部信息根本无法找出一条直连路径。如果双方设备都处在这类 NAT 之后，真正意义上的直连就是不可能的；总得有什么东西居中转发流量。",
        "在通用 WebRTC/ICE 设计里，TURN 可以在直连失败时作为后备中继。Relayium 浏览器端的选择更明确：同一局域网使用 WebRTC 直连，所有跨网络会话从一开始就使用 TURN。文件到达中继前已端到端加密，因此中继只承载密文，无法读取或解密内容。",
      ],
      bullets: [
        "同一网络下 Relayium 让设备直连；跨网络时默认走 TURN 中继，因为那种场景下直连路径往往根本找不到。",
        "中继只转发密文；它从不掌握解密密钥，无法读取文件内容、文件名或其中的任何其他信息。",
        "Relayium CLI 是独立的仅直连路径：它从不中继文件字节，无法建立直连时会直接失败。",
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
        "在同一网络下的两台设备上打开 relayium.com，它们通常会自动找到彼此——不需要账号，不需要配对码，也无需安装任何东西；这就是局域网场景，很多时候甚至用不上 STUN。要跨网络发给不同网络上的人，则用配对码：发送方登录、生成一个配对码（或分享链接，也可选择扫描二维码），对方加入之后，传输经加密 TURN 中继完成——这是穿透难以预测的 NAT 最可靠的一条路，中继也只经手密文；接收方始终不需要账号。",
        "实时路径建立后，每批最多 1,000 个文件会沿选定路径持续流动，每个文件都独立用 SHA-256 校验。Relayium 不保留服务器端实时内容副本或传输历史。对方离线时使用的零知识存储链接是另一种模式，并非实时 P2P 会话。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "点对点和端到端加密是一回事吗？",
        a: "两者相关但并不相同。P2P 描述端点之间的通信，并不保证每一跳都直连；TURN 也可能承载流量。加密描述中间方能否读取。Relayium 在同一局域网使用 WebRTC 直连，跨网络使用端到端加密的 TURN，中继无法读取或解密内容。",
      },
      {
        q: "P2P 传输会经过服务器吗？",
        a: "一个小型信令服务器会帮两台设备找到彼此的地址——但它只会看到连接建立所需的信息，从不涉及文件字节。在浏览器里跨网络传输时，TURN 中继会按设计转发加密后的文件数据，但即便如此，它处理的也只是它无法解密的密文。",
      },
      {
        q: "直连为什么一开始就会失败？",
        a: "有些网络——常见于较严格的企业防火墙或某些移动运营商的 NAT——其构造方式使得仅凭外部信息根本无法找出一条可达的地址。与其在每次传输时都花二十来秒把这件事试出来，Relayium 的浏览器端干脆让所有跨网络传输一开始就走中继——所以承载它们的是中继，而不是一次失败的直连尝试。",
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
    text: "想亲身体验？在两台设备上打开 Relayium，开始一次加密的实时会话。",
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
    "「P2P」という言葉はあいまいに使われがちですが、ファイル転送における本当の意味はこうです。ファイルは会社のサーバーに一度アップロードされてからダウンロードされるのではなく、一台のデバイスからもう一台へ直接送られます。途中にコピーが留まりうる寄り道はありません。",
    "単純に聞こえますが、実際の経路は同じではありません。このページではまず TURN が予備になり得る一般的な WebRTC/ICE を説明し、そのうえで Relayium の実装を区別します。同じ LAN のブラウザは WebRTC 直結、ネットワーク間ブラウザは設計上 TURN、CLI は直接接続専用です。",
  ],
  sections: [
    {
      heading: "P2P と一般的な方式の違い：中間の寄り道を省く",
      body: [
        "ほとんどの「ファイルを送る」ツールはアップロード方式で動きます。手元のデバイスから会社のサーバーへファイルが送られ、そこに保存され、相手はそれをダウンロードします。これは2ホップであり、しばらくの間、そのファイルの完全なコピーが他者のストレージ上に存在します——後で削除されるとしてもです。",
        "P2P 転送はこの寄り道を省きます。手元のデバイスと相手のデバイスの間に接続が開けば、ファイルのバイトはその1ホップだけを直接流れ、他のどこも経由しません。保存すべきサーバー側のコピーも、守るべき対象も、いずれ削除すべきものもありません。そもそもアップロードされていないからです。",
      ],
      bullets: [
        "アップロード方式：手元のデバイス → サーバー → 相手のデバイス——2ホップで、途中に保存されたコピーがある。",
        "P2P 方式：手元のデバイス → 相手のデバイス——1ホップで、何も保存されない。",
        "Relayium のリアルタイムブラウザモードには2つの経路があります。同じ LAN では WebRTC が直接接続し、ネットワークをまたぐ場合は設計上 TURN でエンドツーエンド暗号文を運び、サーバー側の内容コピーや履歴は残しません。",
      ],
    },
    {
      heading: "2台のデバイスが実際にどう見つけ合うか：STUN",
      body: [
        "ここが直感的ではない部分です。手元のデバイスは、外部インターネットから自分がどう見えているかをほぼ確実に知りません——家庭用ルーターや通信キャリアのネットワークアドレス変換（NAT）の内側にあり、共有のグローバル IP の裏に隠され、ポートも動的に割り当てられます。相手のデバイスも同じ状況です。どちらも、実際に到達できるアドレスをまず知らなければ、相手に直接「電話」をかけることはできません。",
        "そこで使われるのが STUN（NAT 越え用セッション走査ユーティリティ）です。各デバイスは軽量な STUN サーバーに短く一つの質問をします。「私はどのアドレス・ポートから来ているように見えますか？」その答えが、自分の外部向けアドレスを教えてくれます——ファイルでも、コンテンツでもなく、そこへの経路を示すのに十分なネットワーク情報だけです。両デバイスはこの情報を（接続確立の詳細だけを運び、ファイルのバイトは一切運ばないシグナリングの手順を通じて）交換し、互いのアドレスへ直接経路を開こうとします。多くの現実のケース——特に同じ Wi-Fi 上の2台や、挙動が予測可能な NAT——では、これだけで成功し、完全な直接接続が開きます。",
      ],
      bullets: [
        "STUN が扱うのはネットワークアドレスの取得と交換のみです——ファイルの中身やファイル名、暗号鍵は一切扱いません。",
        "Relayium は同じ LAN のブラウザセッションで WebRTC を直接使用します。ネットワークをまたぐブラウザ経路は意図的にリレーされます。一方 CLI は直接接続のみで、接続できなければファイルをリレーせず失敗します。",
        "同じネットワーク上の2台（コード不要）は、多くの場合そもそも間に NAT がないため、最も直接的につながる傾向があります。",
      ],
    },
    {
      heading: "直接経路が見つからないとき：TURN リレー",
      body: [
        "STUN だけでは足りないこともあります。一部の NAT——特に厳しい企業ネットワークや一部の通信キャリア——は挙動が予測できず、外部から得られる情報だけでは到達可能なアドレスを発見できないことがあります。両方のデバイスがそうした NAT の内側にある場合、本当の意味での直接接続は不可能で、何かが間でトラフィックを中継する必要があります。",
        "一般的な WebRTC/ICE では、TURN は直接経路が失敗した際の予備リレーになり得ます。Relayium のブラウザアプリはより明示的で、同じ LAN は WebRTC で直接、ネットワークをまたぐ全セッションは最初から TURN を使います。ファイルはリレー到達前にエンドツーエンド暗号化されるため、リレーは暗号文だけを運び、読み取りも復号もできません。",
      ],
      bullets: [
        "同一ネットワークでは Relayium はデバイス同士を直接つなぎます。ネットワークをまたぐ場合は、直接経路が見つからないことが多いため、既定で TURN リレーを使います。",
        "リレーは暗号文だけを転送します。復号鍵を持つことは決してなく、ファイルの中身もファイル名も、中に含まれる他の情報も読めません。",
        "Relayium CLI は別の直接接続専用経路です。ファイルのバイトをリレーせず、直接接続できなければ失敗します。",
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
        "同じネットワーク上の2台で relayium.com を開くと、たいていは自動的に見つけ合います——アカウントもコードも不要、インストールするものも何もありません。これがローカルネットワークのケースで、多くの場合 STUN すら不要です。異なるネットワーク上の相手にインターネット越しに送る場合はペアリングコードを使います。送信者がサインインしてコードを生成する（または QR コードのオプション付きでリンクを共有する）と、相手が参加した時点で、転送は暗号化 TURN リレー経由で行われます——予測しづらい NAT を越える最も確実な経路で、リレーが扱うのは暗号文だけです。受信者はアカウント不要のままです。",
        "リアルタイム経路が開けば、最大1,000ファイルが選択された経路を継続的に流れ、各ファイルを SHA-256 で検証します。Relayium はサーバー側のリアルタイム内容コピーや転送履歴を保持しません。相手がオフラインなら、ゼロ知識の保存リンクという別モードを使います。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "P2P とエンドツーエンド暗号化は同じことですか？",
        a: "関連はしていますが同じではありません。P2P は端点間の通信を表し、全ホップが直接とは限りません。TURN がトラフィックを運ぶこともあります。暗号化は中間者が読めるかを表します。Relayium は同じ LAN で WebRTC 直結、ネットワークをまたぐ場合はエンドツーエンド暗号化 TURN を使い、リレーは読み取りも復号もできません。",
      },
      {
        q: "P2P 転送はそもそもサーバーに触れることがあるのですか？",
        a: "小さなシグナリングサーバーが2台のデバイスが互いのアドレスを見つけるのを助けますが、それが見るのは接続確立の情報だけで、ファイルのバイトは一切見ません。ブラウザでネットワークをまたぐ場合は、設計上つねに TURN リレーが暗号化されたファイルデータを転送しますが、それでも扱うのは復号できない暗号文だけです。",
      },
      {
        q: "そもそもなぜ直接接続が失敗することがあるのですか？",
        a: "一部のネットワーク——厳しい企業ファイアウォールや一部の通信キャリアの NAT に多い——は、外部から得られる情報だけでは到達可能なアドレスを発見できないような構造になっています。それを毎回20秒前後かけて確かめるより、Relayium のブラウザ版はネットワークをまたぐ転送を最初からすべてリレー経由にしています——つまりそれらを運ぶのは、失敗した直接接続の試行ではなくリレーです。",
      },
      {
        q: "リレーを経由すると P2P 転送は遅くなりますか？",
        a: "リレーはデータが通過する余分な1ホップであり、専用サーバーではなく共有サーバーであるため、多少の遅延は増える可能性があります。それでも一般には、アップロードしてからダウンロードする流れより速いです。ファイルが完全にサーバーに届くのを待たずにダウンロード側が開始できるからです。",
      },
      {
        q: "P2P 転送には双方ともアカウントが必要ですか？",
        a: "同じネットワーク上の2台であればアカウントはまったく不要です。ペアリングコードで異なるネットワーク間に送る場合は送信者のサインインが必要ですが、どちらの経路でも受信者はアカウント不要です。",
      },
    ],
  },
  cta: {
    text: "実際に試してみませんか？2台のデバイスで Relayium を開き、暗号化されたリアルタイムセッションを始めてください。",
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
    "\"P2P\"라는 말은 느슨하게 쓰이곤 하지만, 파일 전송에서 실제로 의미하는 바는 이렇습니다. 파일이 어느 회사의 서버로 올라갔다가 다시 내려오는 게 아니라, 한 기기에서 다른 기기로 곧장 이동한다는 뜻입니다. 중간에 사본이 머무를 수 있는 정거장이 없습니다.",
    "단순해 보이지만 실제 경로는 서로 다릅니다. 이 페이지는 먼저 TURN이 대체 경로가 될 수 있는 일반 WebRTC/ICE 개념을 설명한 뒤 Relayium의 구현을 구분합니다. 같은 LAN 브라우저는 WebRTC 직접 연결, 네트워크 간 브라우저는 설계상 TURN, CLI는 직접 연결 전용입니다.",
  ],
  sections: [
    {
      heading: "P2P와 일반적인 방식의 차이: 중간 정거장을 없애다",
      body: [
        "대부분의 \"파일 보내기\" 도구는 업로드 방식으로 동작합니다. 내 기기에서 회사 서버로 파일이 올라가 그곳에 저장되고, 상대방은 그것을 다시 다운로드합니다. 이는 두 번의 이동이며, 나중에 삭제되더라도 한동안은 내 파일의 완전한 사본이 다른 누군가의 저장소에 존재합니다.",
        "P2P 전송은 이 정거장을 건너뜁니다. 내 기기와 상대방 기기 사이에 연결이 열리면, 파일의 바이트는 그 한 번의 이동만으로 직접 흐르고 다른 어디도 거치지 않습니다. 저장하거나 보호하거나 나중에 삭제해야 할 서버 측 사본이 없습니다. 애초에 업로드된 적이 없기 때문입니다.",
      ],
      bullets: [
        "업로드 기반 전송: 내 기기 → 서버 → 상대 기기. 두 번의 이동, 그 사이에 저장된 사본.",
        "P2P 전송: 내 기기 → 상대 기기. 한 번의 이동, 아무것도 저장되지 않음.",
        "Relayium의 실시간 브라우저 모드에는 두 경로가 있습니다. 같은 LAN에서는 WebRTC가 직접 연결하고, 네트워크를 넘을 때는 설계상 TURN으로 종단간 암호문을 운반하며 서버 측 내용 복사본이나 기록을 남기지 않습니다.",
      ],
    },
    {
      heading: "두 기기가 실제로 서로를 찾는 방법: STUN",
      body: [
        "여기 직관적이지 않은 부분이 있습니다. 내 기기는 외부 인터넷에서 자신이 어떻게 보이는지 거의 확실히 알지 못합니다. 가정용 라우터나 통신사의 네트워크 주소 변환(NAT) 뒤에 있어, 공유된 공인 IP 뒤에 숨겨지고 포트도 동적으로 재할당되기 때문입니다. 상대 기기도 같은 처지입니다. 어느 쪽도 실제로 도달 가능한 주소를 먼저 알아내지 않고서는 상대에게 곧바로 \"전화를 걸\" 수 없습니다.",
        "이때 쓰이는 것이 STUN(NAT 통과용 세션 순회 유틸리티)입니다. 각 기기는 가벼운 STUN 서버에 짧게 한 가지를 묻습니다. \"내가 어느 주소, 어느 포트에서 오는 것으로 보이나요?\" 그 답이 자신의 외부 주소를 알려줍니다. 파일도 아니고 어떤 콘텐츠도 아니며, 그곳으로 가는 경로를 설명하기에 충분한 네트워크 정보일 뿐입니다. 두 기기는 이 정보를(연결 설정 세부 사항만 전달하고 파일 바이트는 전혀 전달하지 않는 시그널링 단계를 통해) 교환한 뒤, 서로의 주소로 직접 경로를 열려고 시도합니다. 실제 상황의 상당수에서는 이것만으로 성공해 완전히 직접적인 연결이 열립니다. 특히 같은 Wi-Fi에 있는 두 기기나 예측 가능하게 동작하는 NAT이라면 그렇습니다.",
      ],
      bullets: [
        "STUN은 오직 네트워크 주소만 알아내고 주고받습니다. 파일 내용이나 파일 이름, 암호화 키는 절대 다루지 않습니다.",
        "Relayium은 같은 LAN의 브라우저 세션에서 WebRTC를 직접 사용합니다. 네트워크를 넘는 브라우저 경로는 의도적으로 릴레이됩니다. CLI는 직접 연결 전용이며 연결할 수 없으면 파일 바이트를 릴레이하지 않고 실패합니다.",
        "같은 네트워크에 있는 두 기기(코드 불필요)는 대개 그 사이에 NAT 자체가 없는 경우가 많아 가장 직접적으로 연결되는 경향이 있습니다.",
      ],
    },
    {
      heading: "직접 경로를 찾지 못할 때: TURN 릴레이",
      body: [
        "때로는 STUN만으로 부족합니다. 일부 NAT은 예측하기 어렵게 동작해서, 외부 정보만으로는 도달 가능한 주소를 전혀 발견할 수 없는 경우가 있습니다. 특히 엄격한 기업 네트워크나 일부 이동통신사가 그렇습니다. 두 기기 모두 그런 종류의 NAT 뒤에 있다면 진정한 의미의 직접 연결은 불가능하며, 무언가가 그 사이에서 트래픽을 중계해야 합니다.",
        "일반 WebRTC/ICE 설계에서 TURN은 직접 경로가 실패할 때 대체 릴레이가 될 수 있습니다. Relayium 브라우저 앱은 더 명확하게 같은 LAN은 WebRTC로 직접 연결하고, 네트워크를 넘는 모든 세션은 처음부터 TURN을 사용합니다. 파일은 릴레이 전에 종단간 암호화되므로 릴레이는 암호문만 운반하며 읽거나 복호화할 수 없습니다.",
      ],
      bullets: [
        "같은 네트워크에서는 Relayium이 기기를 직접 연결합니다. 네트워크를 넘을 때는 직접 경로를 찾지 못하는 경우가 워낙 많아 기본적으로 TURN 릴레이를 사용합니다.",
        "릴레이는 암호문만 전달합니다. 복호화 키를 절대 갖지 않으며, 파일 내용도 파일 이름도 그 안의 다른 어떤 정보도 읽을 수 없습니다.",
        "Relayium CLI는 별도의 직접 연결 전용 경로입니다. 파일 바이트를 릴레이하지 않으며 직접 연결할 수 없으면 실패합니다.",
      ],
    },
    {
      heading: "왜 중요한가: 프라이버시와 속도",
      body: [
        "프라이버시 측면의 논리는 단순합니다. 파일의 바이트가 두 기기 사이를 단 한 번만 직접 오갈 때, 사본이 머무르거나 기록되거나 다른 누군가에게 접근될 수 있는 서버 측 저장 단계 자체가 존재하지 않습니다. 애초에 거기에 놓인 적이 없기 때문입니다. 이는 \"결국엔 삭제하겠다고 약속합니다\"와는 구조적으로 전혀 다른 보장입니다.",
        "속도 측면의 논리도 같은 맥락입니다. 업로드 후 다운로드하는 전송은 네트워크를 두 번 가로질러야 합니다. 한 번은 올리고, 한 번은 내립니다. 게다가 종종 발신 측이 완전히 끝날 때까지 수신 측이 시작하지 못하고 기다립니다. 직접 연결은 네트워크를 한 번만 가로지르며, 처리량을 제한하거나 자체 지연을 더하는 서버가 중간에 없이, 둘 중 느린 쪽 연결이 허용하는 속도로 데이터가 두 기기 사이에서 끊임없이 스트리밍될 수 있습니다.",
      ],
    },
    {
      heading: "Relayium이 이를 어떻게 조합하는가",
      body: [
        "같은 네트워크에 있는 두 기기에서 relayium.com을 열면 보통 자동으로 서로를 찾습니다. 계정도, 코드도 필요 없고, 설치할 것도 없습니다. 이것이 LAN 상황이며, 많은 경우 STUN조차 필요하지 않습니다. 다른 네트워크에 있는 사람에게 인터넷 너머로 보낼 때는 페어링 코드를 사용합니다. 발신자가 로그인해서 코드를 생성하면(또는 스캔할 수 있는 QR 코드 옵션과 함께 링크를 공유하면), 상대방이 참여하는 순간 전송은 암호화된 TURN 릴레이를 통해 이뤄집니다. 이는 예측하기 어려운 NAT을 넘는 가장 확실한 경로이며, 릴레이는 암호문만 나릅니다. 수신자는 여전히 계정이 필요 없습니다.",
        "실시간 경로가 열리면 최대 1,000개 파일이 선택된 경로를 따라 계속 흐르고 각 파일을 SHA-256으로 검증합니다. Relayium은 서버 측 실시간 내용 복사본이나 전송 기록을 보관하지 않습니다. 상대가 오프라인이면 영지식 저장 링크라는 별도 모드를 사용합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "P2P와 종단간 암호화는 같은 것인가요?",
        a: "관련은 있지만 같지는 않습니다. P2P는 끝점 간 통신을 뜻하며 모든 네트워크 홉이 직접이라는 보장은 없습니다. TURN이 트래픽을 운반할 수도 있습니다. 암호화는 중간자가 읽을 수 있는지를 뜻합니다. Relayium은 같은 LAN에서 WebRTC로 직접 연결하고, 네트워크를 넘을 때는 종단간 암호화 TURN을 사용하며 릴레이는 읽거나 복호화할 수 없습니다.",
      },
      {
        q: "P2P 전송이 애초에 서버를 거치기는 하나요?",
        a: "작은 시그널링 서버가 두 기기가 서로의 주소를 찾도록 돕지만, 그것이 보는 것은 연결 설정 정보뿐이며 파일 바이트는 전혀 보지 않습니다. 브라우저에서 네트워크를 넘을 때는 설계상 TURN 릴레이가 암호화된 파일 데이터를 전달하지만, 그때조차 다루는 것은 복호화할 수 없는 암호문뿐입니다.",
      },
      {
        q: "직접 연결은 애초에 왜 실패할 수 있나요?",
        a: "일부 네트워크는 외부 정보만으로는 도달 가능한 주소를 발견할 수 없도록 구성되어 있습니다. 엄격한 기업 방화벽이나 일부 이동통신사 NAT에서 흔한 일입니다. 전송할 때마다 20초 남짓을 들여 그것을 확인하는 대신, Relayium의 브라우저 앱은 네트워크 간 전송을 처음부터 모두 릴레이로 보냅니다. 그것들을 나르는 것은 실패한 직접 연결 시도가 아니라 릴레이입니다.",
      },
      {
        q: "릴레이를 거치면 P2P 전송이 느려지나요?",
        a: "릴레이는 데이터가 통과하는 추가적인 한 단계이고 전용 서버가 아닌 공유 서버이므로 약간의 지연이 더해질 수 있습니다. 그래도 파일이 서버에 완전히 도착할 때까지 기다리지 않고 다운로드 측이 시작할 수 있으므로, 업로드 후 다운로드하는 방식보다는 대체로 더 빠릅니다.",
      },
      {
        q: "P2P 전송에는 양쪽 모두 계정이 필요한가요?",
        a: "같은 네트워크에 있는 두 기기는 계정이 전혀 필요 없습니다. 페어링 코드로 다른 네트워크 간에 보낼 때는 발신자의 로그인이 필요하지만, 어느 경로든 수신자는 계정이 필요 없습니다.",
      },
    ],
  },
  cta: {
    text: "직접 사용해 보세요. 두 기기에서 Relayium을 열고 암호화된 실시간 세션을 시작하세요.",
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
    "„Peer-to-Peer“ wird oft locker verwendet, aber bei einer Dateiübertragung bedeutet es konkret: Deine Datei geht direkt von einem Gerät zum anderen — nicht auf den Server eines Unternehmens hoch und wieder herunter. Kein Zwischenstopp, an dem eine Kopie liegen bleiben könnte.",
    "Das klingt einfach, doch die tatsächlichen Pfade unterscheiden sich. Diese Seite erklärt zuerst allgemeines WebRTC/ICE, bei dem TURN als Ausweichweg dienen kann, und trennt dann Relayiums Umsetzung: Browser-WebRTC ist im selben LAN direkt, netzübergreifend wird TURN planmäßig genutzt, und die CLI ist direct-only.",
  ],
  sections: [
    {
      heading: "P2P vs. der übliche Weg: den Zwischenstopp streichen",
      body: [
        "Die meisten „Datei senden“-Tools funktionieren per Upload: Deine Datei geht von deinem Gerät auf den Server des Anbieters hoch, wird dort gespeichert, und die andere Person lädt sie wieder herunter. Das sind zwei Hops, und eine Weile lang liegt eine vollständige Kopie deiner Datei auf fremdem Speicher — auch wenn sie später gelöscht wird.",
        "Peer-to-Peer-Übertragung überspringt diesen Zwischenstopp. Sobald eine Verbindung zwischen deinem Gerät und dem der anderen Person offen ist, fließen die Bytes der Datei direkt über diesen einen Hop und nirgendwo sonst hin. Es gibt keine serverseitige Kopie, die gespeichert, gesichert oder irgendwann gelöscht werden müsste — denn sie wurde nie hochgeladen.",
      ],
      bullets: [
        "Upload-basierte Übertragung: dein Gerät zu einem Server zum Gerät der anderen Person — zwei Hops, dazwischen eine gespeicherte Kopie.",
        "Peer-to-Peer-Übertragung: dein Gerät direkt zum Gerät der anderen Person — ein Hop, nichts wird gespeichert.",
        "Relayiums Echtzeit-Browsermodus hat zwei Pfade: Im selben LAN verbindet WebRTC direkt; netzübergreifend transportiert TURN planmäßig Ende-zu-Ende-Chiffretext, ohne eine serverseitige Inhaltskopie oder Historie zu behalten.",
      ],
    },
    {
      heading: "Wie zwei Geräte sich tatsächlich finden: STUN",
      body: [
        "Hier kommt der nicht offensichtliche Teil: Dein Gerät kennt so gut wie sicher seine eigene Adresse, wie sie vom öffentlichen Internet aus gesehen wird, gar nicht — es sitzt hinter einem heimischen Router oder der Network Address Translation (NAT) eines Mobilfunkanbieters, die es hinter einer geteilten öffentlichen IP verbirgt und Ports laufend neu zuweist. Das andere Gerät befindet sich in derselben Lage. Keines von beiden kann das andere einfach „anwählen“, ohne vorher herauszufinden, welche Adresse es überhaupt erreichen würde.",
        "Genau dafür ist STUN (Session Traversal Utilities for NAT) da. Jedes Gerät stellt kurz einem schlanken STUN-Server eine Frage: „Von welcher Adresse und welchem Port aus siehst du mich kommen?“ Die Antwort verrät ihm seine eigene nach außen sichtbare Adresse — keine Datei, kein Inhalt, nur genug Netzwerkinformation, um einen Weg zurück zu ihm zu beschreiben. Beide Geräte tauschen diese Information aus (über einen Signalisierungsschritt, der ausschließlich Verbindungsaufbau-Details trägt, nie Dateibytes) und versuchen dann, einen direkten Pfad zur Adresse des jeweils anderen zu öffnen. In einem großen Teil realer Fälle — besonders bei zwei Geräten im selben WLAN oder bei NATs mit vorhersehbarem Verhalten — funktioniert das, und es öffnet sich eine vollständig direkte Verbindung.",
      ],
      bullets: [
        "STUN lernt und teilt ausschließlich Netzwerkadressen — nie Dateiinhalte, Dateinamen oder Verschlüsselungsschlüssel.",
        "Relayium nutzt WebRTC direkt für Browser-Sitzungen im selben LAN. Der netzübergreifende Browserpfad wird bewusst über ein Relay geführt. Die CLI bleibt direct-only und scheitert, statt Dateibytes weiterzuleiten.",
        "Zwei Geräte im selben Netzwerk (kein Code nötig) verbinden sich meist am direktesten von allen, weil oft überhaupt kein NAT im Weg steht.",
      ],
    },
    {
      heading: "Wenn kein direkter Pfad gefunden werden kann: das TURN-Relay",
      body: [
        "Manchmal reicht STUN nicht aus. Manche NATs — besonders bei strengeren Unternehmensnetzwerken oder bestimmten Mobilfunkanbietern — verhalten sich so unvorhersehbar, dass sich allein aus außen zugänglichen Informationen kein direkter Pfad ermitteln lässt. Sitzen beide Geräte hinter dieser Art von NAT, ist eine wirklich direkte Verbindung schlicht nicht möglich; etwas muss den Verkehr dazwischen weiterleiten.",
        "In einem allgemeinen WebRTC/ICE-Design kann TURN das Ausweich-Relay sein, wenn ein direkter Pfad scheitert. Relayiums Browser-App entscheidet bewusster: Im selben LAN läuft WebRTC direkt, alle netzübergreifenden Sitzungen nutzen TURN von Anfang an. Die Datei ist vorher Ende-zu-Ende verschlüsselt; das Relay transportiert nur Chiffretext und kann den Inhalt weder lesen noch entschlüsseln.",
      ],
      bullets: [
        "Im selben Netz verbindet Relayium die Geräte direkt; netzübergreifend nutzt es standardmäßig das TURN-Relay, weil sich dort so oft kein direkter Pfad finden lässt.",
        "Das Relay leitet ausschließlich Chiffretext weiter; es besitzt nie den Entschlüsselungsschlüssel und kann weder Dateiinhalte noch Dateinamen noch sonst etwas über den Inhalt lesen.",
        "Relayiums CLI ist ein separater direct-only Pfad: Sie leitet niemals Dateibytes weiter und scheitert, wenn keine direkte Verbindung möglich ist.",
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
        "Öffnen zwei Geräte im selben Netzwerk relayium.com, finden sie sich meist automatisch — kein Konto, kein Code, nichts zu installieren; das ist der LAN-Fall, in dem STUN oft nicht einmal gebraucht wird. Für den Versand über das Internet an jemanden in einem anderen Netzwerk kommt ein Pairing-Code zum Einsatz: Der Absender meldet sich an, erzeugt einen Code (oder teilt einen Link, wahlweise mit QR-Code zum Scannen), und sobald die andere Person beitritt, läuft die Übertragung über ein verschlüsseltes TURN-Relay — der zuverlässige Weg durch unvorhersehbare NATs, und es trägt ausschließlich Chiffretext. Der Empfänger braucht weiterhin kein Konto.",
        "Sobald der Echtzeitpfad steht, streamen bis zu 1.000 Dateien fortlaufend über die gewählte Route, jede per SHA-256 geprüft. Relayium behält keine serverseitige Echtzeit-Inhaltskopie oder Übertragungshistorie. Ist die andere Person offline, ist ein Zero-Knowledge-Speicherlink ein eigener Modus.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist Peer-to-Peer dasselbe wie Ende-zu-Ende-Verschlüsselung?",
        a: "Beides hängt zusammen, ist aber nicht identisch. P2P beschreibt die Kommunikation zwischen Endpunkten, garantiert aber nicht, dass jeder Netzwerk-Hop direkt ist; TURN kann den Verkehr tragen. Verschlüsselung bestimmt, ob Vermittler ihn lesen können. Relayium nutzt im selben LAN direktes WebRTC und netzübergreifend Ende-zu-Ende-verschlüsseltes TURN, das der Relay weder lesen noch entschlüsseln kann.",
      },
      {
        q: "Berührt eine P2P-Übertragung überhaupt jemals einen Server?",
        a: "Ein kleiner Signalisierungsserver hilft den beiden Geräten, die Adresse des jeweils anderen zu finden — er sieht dabei aber nur Verbindungsaufbau-Informationen, nie Dateibytes. Netzübergreifend leitet im Browser konstruktionsbedingt ein TURN-Relay die verschlüsselten Dateidaten weiter, verarbeitet aber auch dann nur Chiffretext, den es nicht entschlüsseln kann.",
      },
      {
        q: "Warum sollte eine direkte Verbindung überhaupt scheitern?",
        a: "Manche Netzwerke — häufig strenge Unternehmensfirewalls oder bestimmte NATs von Mobilfunkanbietern — sind so aufgebaut, dass sich allein aus außen zugänglichen Informationen keine erreichbare Adresse ermitteln lässt. Statt das bei jeder Übertragung gut zwanzig Sekunden lang herauszufinden, schickt Relayiums Browser-App alle netzwerkübergreifenden Übertragungen von vornherein über das Relay — es ist also das Relay und kein gescheiterter Direktversuch, das sie trägt.",
      },
      {
        q: "Ist eine P2P-Übertragung langsamer, wenn sie über ein Relay läuft?",
        a: "Es kann etwas Latenz hinzukommen, da das Relay ein zusätzlicher Hop ist, den die Daten durchlaufen, und es sich um einen geteilten statt einen dedizierten Server handelt. Trotzdem ist es meist noch schneller als ein Upload-dann-Download-Ablauf, da nicht gewartet werden muss, bis die Datei vollständig auf einem Server angekommen ist, bevor die Download-Seite starten kann.",
      },
      {
        q: "Brauchen bei einer P2P-Übertragung beide Seiten ein Konto?",
        a: "Zwei Geräte im selben Netzwerk brauchen überhaupt kein Konto. Beim Versand über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden, aber die empfangende Person braucht in beiden Fällen nie ein Konto.",
      },
    ],
  },
  cta: {
    text: "Neugierig? Öffne Relayium auf zwei Geräten und starte eine verschlüsselte Echtzeitsitzung.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Qu'est-ce que le transfert de fichiers pair à pair ?",
  description:
    "Une explication simple du transfert pair-à-pair : la différence avec l'envoi vers un serveur, comment WebRTC établit une connexion directe, et pourquoi c'est privé et rapide.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "« Pair-à-pair » est une expression employée un peu librement, alors voici ce qu'elle signifie vraiment pour un transfert de fichiers : votre fichier va directement d'un appareil à l'autre, et non vers le serveur d'une entreprise avant d'en redescendre. Aucune étape intermédiaire où une copie pourrait rester.",
    "Cela paraît simple, mais les chemins réels diffèrent. Cette page explique d'abord le WebRTC/ICE général, où TURN peut servir de secours, puis distingue l'implémentation de Relayium : WebRTC navigateur est direct sur le même LAN, TURN est utilisé par conception entre réseaux, et le CLI est direct-only.",
  ],
  sections: [
    {
      heading: "P2P contre la méthode habituelle : supprimer l'étape intermédiaire",
      body: [
        "La plupart des outils « envoyer un fichier » fonctionnent par téléversement : votre fichier part de votre appareil vers le serveur de l'entreprise, y est stocké, puis l'autre personne le télécharge à son tour. Cela fait deux sauts, et pendant un moment, une copie complète de votre fichier repose sur le stockage de quelqu'un d'autre — même si elle est supprimée par la suite.",
        "Le transfert pair-à-pair supprime cette étape. Une fois qu'une connexion est ouverte entre votre appareil et celui de l'autre personne, les octets du fichier circulent directement sur ce seul saut, et nulle part ailleurs. Il n'y a pas de copie côté serveur à stocker, à sécuriser ou à finir par supprimer, puisqu'elle n'a jamais été téléversée en premier lieu.",
      ],
      bullets: [
        "Transfert par téléversement : votre appareil vers un serveur vers l'appareil de l'autre — deux sauts, une copie stockée entre les deux.",
        "Transfert pair-à-pair : votre appareil directement vers l'appareil de l'autre — un seul saut, rien de stocké.",
        "Le mode navigateur temps réel de Relayium a deux voies : WebRTC est direct sur le même LAN ; entre réseaux, TURN transporte par conception du texte chiffré de bout en bout, sans copie ni historique de contenu côté serveur.",
      ],
    },
    {
      heading: "Comment deux appareils se trouvent réellement : STUN",
      body: [
        "Voici la partie qui n'est pas évidente : votre appareil ne connaît presque certainement pas sa propre adresse telle qu'elle est vue depuis l'Internet public — il se trouve derrière un routeur domestique ou la traduction d'adresse réseau (NAT) d'un opérateur mobile, qui le dissimule derrière une adresse IP publique partagée et réattribue les ports à la volée. L'autre appareil est dans la même situation. Aucun des deux ne peut simplement « composer » l'autre directement sans d'abord déterminer quelle adresse permettrait réellement de l'atteindre.",
        "C'est à cela que sert STUN (Session Traversal Utilities for NAT). Chaque appareil pose brièvement une question à un serveur STUN léger : « depuis quelle adresse et quel port me voyez-vous arriver ? » La réponse lui indique sa propre adresse visible de l'extérieur — ni fichier, ni contenu, juste assez d'information réseau pour décrire un chemin pour le rejoindre. Les deux appareils échangent cette information (via une étape de signalisation qui ne transporte que des détails d'établissement de connexion, jamais des octets de fichier), puis tentent d'ouvrir un chemin direct vers l'adresse de l'autre. Dans une large part des cas réels — en particulier deux appareils sur le même Wi-Fi, ou des NAT au comportement prévisible — cela fonctionne, et une connexion entièrement directe s'ouvre.",
      ],
      bullets: [
        "STUN n'apprend et ne partage jamais que des adresses réseau — jamais le contenu des fichiers, leurs noms, ni les clés de chiffrement.",
        "Relayium utilise WebRTC directement pour les sessions navigateur sur le même LAN. La voie navigateur entre réseaux est délibérément relayée. Le CLI reste direct-only et échoue au lieu de relayer les octets du fichier.",
        "Deux appareils sur le même réseau (aucun code requis) se connectent généralement le plus directement de tous, car il n'y a souvent aucun NAT en travers du chemin.",
      ],
    },
    {
      heading: "Quand aucun chemin direct ne peut être trouvé : le relais TURN",
      body: [
        "Parfois, STUN ne suffit pas. Certains NAT — en particulier sur des réseaux d'entreprise plus stricts ou chez certains opérateurs mobiles — sont suffisamment imprévisibles pour qu'aucun chemin direct ne puisse être découvert à partir des seules informations externes. Si les deux appareils se trouvent derrière ce genre de NAT, une connexion réellement directe est tout simplement impossible ; quelque chose doit relayer le trafic entre les deux.",
        "Dans une conception WebRTC/ICE générale, TURN peut être le relais de secours lorsqu'un chemin direct échoue. L'application navigateur Relayium choisit explicitement WebRTC direct sur le même LAN et TURN dès le départ pour toutes les sessions entre réseaux. Le fichier est déjà chiffré de bout en bout : le relais ne transporte que du texte chiffré et ne peut ni lire ni déchiffrer le contenu.",
      ],
      bullets: [
        "Sur le même réseau, Relayium relie les appareils directement ; entre réseaux, il utilise le relais TURN par défaut, car un chemin direct y est si souvent introuvable.",
        "Le relais ne transmet que du texte chiffré ; il ne possède jamais la clé de déchiffrement et ne peut lire ni le contenu des fichiers, ni leurs noms, ni rien d'autre à leur sujet.",
        "Le CLI Relayium est une voie direct-only distincte : il ne relaie jamais les octets du fichier et échoue si aucune connexion directe n'est possible.",
      ],
    },
    {
      heading: "Pourquoi cela compte : vie privée et vitesse",
      body: [
        "L'argument de la vie privée est simple : quand les octets du fichier ne traversent qu'un seul saut, directement entre deux appareils, il n'existe aucune étape de stockage côté serveur où une copie pourrait rester, être journalisée ou être consultée par quelqu'un d'autre — parce qu'elle n'y a jamais été déposée. C'est une garantie structurellement différente d'un « nous promettons de la supprimer un jour ».",
        "L'argument de la vitesse suit la même logique. Un transfert téléversement-puis-téléchargement doit traverser le réseau deux fois — une fois vers le haut, une fois vers le bas — et attend souvent que le côté émetteur ait entièrement terminé avant que le côté récepteur puisse commencer. Une connexion directe ne traverse le réseau qu'une seule fois, et les données peuvent circuler en continu entre les deux appareils, aussi vite que le permet la connexion la plus lente, sans serveur intermédiaire limitant le débit ou ajoutant sa propre latence.",
      ],
    },
    {
      heading: "Comment Relayium assemble tout cela",
      body: [
        "Ouvrez relayium.com sur deux appareils du même réseau et ils se trouvent généralement automatiquement — pas de compte, pas de code, rien à installer ; c'est le cas du réseau local, où STUN n'est souvent même pas nécessaire. Pour envoyer sur Internet vers quelqu'un sur un autre réseau, on utilise un code d'appairage : l'expéditeur se connecte, génère un code (ou partage un lien, avec en option un QR code à scanner), et dès que l'autre personne rejoint, le transfert passe par un relais TURN chiffré — la voie fiable à travers des NAT imprévisibles, et il ne transporte que du texte chiffré ; le destinataire n'a toujours besoin d'aucun compte.",
        "Une fois la voie temps réel ouverte, jusqu'à 1 000 fichiers circulent en continu sur la route choisie, chacun vérifié par SHA-256. Relayium ne conserve aucune copie de contenu ni aucun historique temps réel côté serveur. Si l'autre personne est hors ligne, le lien stocké à divulgation nulle est un mode distinct.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Le pair-à-pair est-il la même chose que le chiffrement de bout en bout ?",
        a: "Les deux sont liés mais pas identiques. Le P2P décrit la communication entre terminaux sans garantir que chaque saut réseau soit direct ; TURN peut transporter le trafic. Le chiffrement détermine si un intermédiaire peut le lire. Relayium utilise WebRTC direct sur le même LAN et TURN chiffré de bout en bout entre réseaux, que le relais ne peut ni lire ni déchiffrer.",
      },
      {
        q: "Un transfert P2P touche-t-il quand même un serveur ?",
        a: "Un petit serveur de signalisation aide les deux appareils à trouver l'adresse l'un de l'autre — mais il ne voit jamais que des informations d'établissement de connexion, jamais les octets du fichier. Entre réseaux différents, dans le navigateur, un relais TURN transmet par conception les données de fichier chiffrées, mais même alors il ne traite que du texte chiffré qu'il ne peut pas déchiffrer.",
      },
      {
        q: "Pourquoi une connexion directe échouerait-elle en premier lieu ?",
        a: "Certains réseaux — souvent des pare-feu d'entreprise stricts ou certains NAT d'opérateurs mobiles — sont construits de façon à rendre impossible la découverte d'une adresse joignable à partir des seules informations externes. Plutôt que de passer une vingtaine de secondes à le découvrir à chaque transfert, l'application web de Relayium fait passer d'emblée tous les transferts entre réseaux par le relais — c'est donc le relais, et non une tentative directe échouée, qui les achemine.",
      },
      {
        q: "Un transfert P2P est-il plus lent quand il passe par un relais ?",
        a: "Cela peut ajouter un peu de latence, puisque le relais est un saut supplémentaire que traversent les données, et qu'il s'agit d'un serveur partagé plutôt que dédié. Mais c'est généralement encore plus rapide qu'un flux téléversement-puis-téléchargement, car il n'y a pas d'attente que le fichier arrive entièrement sur un serveur avant que le côté téléchargement puisse démarrer.",
      },
      {
        q: "Les deux personnes ont-elles besoin d'un compte pour un transfert P2P ?",
        a: "Deux appareils sur le même réseau n'ont besoin d'aucun compte. Envoyer entre réseaux différents via un code d'appairage exige que l'expéditeur se connecte, mais la personne qui reçoit n'a jamais besoin de compte, quel que soit le chemin emprunté.",
      },
    ],
  },
  cta: {
    text: "Curieux ? Ouvrez Relayium sur deux appareils et démarrez une session temps réel chiffrée.",
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
    "يبدو ذلك بسيطًا، لكن المسارات الفعلية تختلف. تشرح الصفحة أولًا WebRTC/ICE العام حيث يمكن أن يكون TURN احتياطيًا، ثم تميّز تنفيذ Relayium: WebRTC في المتصفح مباشر داخل شبكة LAN نفسها، وTURN مستخدم حسب التصميم عبر الشبكات، وCLI مباشرة فقط.",
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
        "لوضع Relayium الفوري في المتصفح مساران: يتصل WebRTC مباشرةً داخل شبكة LAN نفسها؛ وعبر الشبكات يحمل TURN حسب التصميم نصًا مشفّرًا من الطرف إلى الطرف بلا نسخة محتوى أو سجل فوري على الخادم.",
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
        "يستخدم Relayium تقنية WebRTC مباشرةً لجلسات المتصفح داخل شبكة LAN نفسها. أما مسار المتصفح عبر الشبكات فيُرحّل عمدًا. وتظل CLI مباشرة فقط، فتفشل بدلًا من ترحيل بايتات الملف.",
        "جهازان على الشبكة نفسها (دون حاجة إلى رمز) يتصلان عادةً على النحو الأكثر مباشرةً بينها جميعًا، إذ لا يوجد غالبًا أي NAT يعترض الطريق.",
      ],
    },
    {
      heading: "حين يتعذّر العثور على مسار مباشر: مُرحِّل TURN",
      body: [
        "أحيانًا لا يكفي STUN. فبعض أنواع NAT — لا سيما على شبكات الشركات الأكثر صرامةً أو لدى بعض مشغّلي الهاتف المحمول — يصعب التنبؤ بها إلى حدٍّ يجعل من المستحيل اكتشاف مسار مباشر من المعلومات الخارجية وحدها. وإذا كان كلا الجهازين خلف هذا النوع من NAT، فإن الاتصال المباشر حقًا يكون ببساطة غير ممكن؛ ولا بد لشيء أن يُرحِّل حركة البيانات بينهما.",
        "في تصميم WebRTC/ICE عام، يمكن أن يكون TURN مُرحِّلًا احتياطيًا عند فشل المسار المباشر. أما تطبيق Relayium في المتصفح فيختار بوضوح WebRTC المباشر داخل شبكة LAN نفسها وTURN منذ البداية لكل الجلسات عبر الشبكات. يُشفّر الملف من الطرف إلى الطرف قبل وصوله، فلا يحمل المُرحِّل إلا نصًا مشفّرًا ولا يستطيع قراءة المحتوى أو فك تشفيره.",
      ],
      bullets: [
        "على الشبكة نفسها يصل Relayium بين الأجهزة مباشرةً؛ أمّا عبر الشبكات فيستخدم مُرحِّل TURN افتراضيًّا، لأن المسار المباشر كثيرًا ما يتعذّر إيجاده هناك.",
        "يمرّر المُرحِّل نصًا مُشفَّرًا فقط؛ ولا يملك قط مفتاح فك التشفير ولا يستطيع قراءة محتويات الملفات أو أسمائها أو أي شيء آخر عمّا بداخلها.",
        "CLI في Relayium مسار منفصل مباشر فقط: لا يرحّل بايتات الملف أبدًا ويفشل إن تعذّر إنشاء اتصال مباشر.",
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
        "افتح relayium.com على جهازين على الشبكة نفسها فيعثر كل منهما على الآخر تلقائيًا في العادة — دون حساب ودون رمز ودون أي شيء يُثبَّت؛ تلك هي حالة الشبكة المحلية التي لا يكون STUN فيها ضروريًا غالبًا. أما الإرسال عبر الإنترنت إلى شخص على شبكة مختلفة فيستخدم رمز اقتران: يسجّل المُرسِل الدخول، ويولّد رمزًا (أو يشارك رابطًا، مع رمز QR اختياري للمسح)، وما إن ينضم الشخص الآخر حتى يجري النقل عبر مُرحِّل TURN مشفَّر — وهو المسار الموثوق عبر شبكات NAT التي يصعب التنبؤ بها، ولا يحمل إلا نصًا مُشفَّرًا — ويبقى المُستقبِل بلا حاجة إلى حساب.",
        "عند فتح المسار الفوري، يتدفق ما يصل إلى 1000 ملف باستمرار عبر الطريق المختار ويُفحص كل ملف بـ SHA-256. لا يحتفظ Relayium بنسخة محتوى فورية أو سجل نقل على الخادم. وإذا كان الطرف الآخر غير متصل، فالرابط المُخزّن بمعرفة صفرية وضع منفصل.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل النقل من الند للند هو نفسه التشفير من الطرف إلى الطرف؟",
        a: "هما مترابطان لكنهما ليسا متطابقين. يصف P2P الاتصال بين النهايات ولا يضمن أن تكون كل قفزة مباشرة؛ فقد يحمل TURN الحركة. ويحدد التشفير إن كان الوسيط يستطيع قراءتها. يستخدم Relayium WebRTC مباشرةً داخل شبكة LAN نفسها وTURN مشفّرًا من الطرف إلى الطرف عبر الشبكات، ولا يستطيع المُرحِّل قراءته أو فك تشفيره.",
      },
      {
        q: "هل يمرّ النقل من الند للند بأي خادم على الإطلاق؟",
        a: "يساعد خادم إشارة صغير الجهازين على العثور على عنوان كل منهما — لكنه لا يرى سوى معلومات إعداد الاتصال، ولا يرى بايتات الملف قط. وعبر الشبكات في المتصفح، يمرّر مُرحِّل TURN بيانات الملف المُشفَّرة بحكم التصميم، لكنه حتى حينئذٍ لا يتعامل إلا مع نص مُشفَّر لا يستطيع فك تشفيره.",
      },
      {
        q: "لماذا قد يفشل الاتصال المباشر من الأساس؟",
        a: "بعض الشبكات — غالبًا جدران الحماية الصارمة للشركات أو بعض أنواع NAT لدى مشغّلي الهاتف المحمول — مبنية على نحو يجعل من المستحيل اكتشاف عنوان يمكن الوصول إليه من المعلومات الخارجية وحدها. وبدل إنفاق نحو عشرين ثانية لاكتشاف ذلك في كل عملية نقل، يُمرِّر تطبيق Relayium في المتصفح كل عمليات النقل عبر الشبكات على المُرحِّل من البداية — فالذي يحملها هو المُرحِّل، لا محاولة اتصال مباشر فاشلة.",
      },
      {
        q: "هل يكون النقل من الند للند أبطأ حين يمرّ عبر مُرحِّل؟",
        a: "قد يضيف بعض زمن الاستجابة، إذ إن المُرحِّل قفزة إضافية تمر بها البيانات وهو خادم مشترك لا خادم مخصَّص. لكنه يظل أسرع عمومًا من أسلوب الرفع ثم التنزيل، إذ لا انتظار لاستقرار الملف كاملًا على خادم قبل أن يبدأ جانب التنزيل.",
      },
      {
        q: "هل يحتاج الطرفان إلى حساب للنقل من الند للند؟",
        a: "جهازان على الشبكة نفسها لا يحتاجان إلى حساب على الإطلاق. والإرسال عبر الشبكات برمز اقتران يتطلب أن يسجّل المُرسِل الدخول، أما الشخص المُستقبِل فلا يحتاج إلى حساب مطلقًا في كلتا الحالتين.",
      },
    ],
  },
  cta: {
    text: "هل تريد التجربة؟ افتح Relayium على جهازين وابدأ جلسة فورية مشفّرة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "¿Qué es la transferencia de archivos de igual a igual?",
  description:
    "Una explicación en lenguaje sencillo de la transferencia de archivos P2P: en qué se diferencia de subir a un servidor, cómo se encuentra una conexión WebRTC directa y por qué es privada y rápida.",
  updatedLabel: "Última actualización",
  lead: [
    "«De igual a igual» se usa de forma imprecisa, así que esto es lo que realmente significa para una transferencia de archivos: tu archivo va directamente de un dispositivo al otro, no sube al servidor de una empresa y vuelve a bajar. No hay parada intermedia donde pueda quedarse una copia.",
    "Suena sencillo, pero las rutas reales difieren. Esta página explica primero WebRTC/ICE en general, donde TURN puede ser una vía de reserva, y luego separa la implementación de Relayium: WebRTC del navegador es directo en la misma LAN, TURN se usa por diseño entre redes y el CLI es direct-only.",
  ],
  sections: [
    {
      heading: "P2P frente a la forma habitual: eliminar la parada intermedia",
      body: [
        "La mayoría de las herramientas para «enviar un archivo» funcionan por subida: tu archivo va desde tu dispositivo hasta el servidor de la empresa, se almacena allí y la otra persona lo descarga de vuelta. Son dos saltos y, durante un tiempo, una copia completa de tu archivo reside en el almacenamiento de otra persona, aunque se elimine después.",
        "La transferencia de igual a igual se salta esa parada. Una vez que hay una conexión abierta entre tu dispositivo y el de la otra persona, los bytes del archivo fluyen directamente por ese único salto y por ningún otro sitio. No hay copia del lado del servidor que almacenar, proteger ni acabar eliminando, porque nunca se subió en primer lugar.",
      ],
      bullets: [
        "Transferencia basada en subida: de tu dispositivo a un servidor y luego a su dispositivo — dos saltos, una copia almacenada en medio.",
        "Transferencia de igual a igual: de tu dispositivo directamente a su dispositivo — un salto, nada almacenado.",
        "El modo en tiempo real del navegador de Relayium tiene dos vías: WebRTC es directo en la misma LAN; entre redes, TURN transporta por diseño texto cifrado de extremo a extremo sin conservar copia ni historial de contenido del lado del servidor.",
      ],
    },
    {
      heading: "Cómo se encuentran realmente dos dispositivos: STUN",
      body: [
        "Aquí está la parte que no es obvia: tu dispositivo casi con toda seguridad no conoce su propia dirección tal como se ve desde la internet pública — está detrás de un router doméstico o de la traducción de direcciones de red (NAT) de un operador móvil, que lo oculta tras una IP pública compartida y reasigna los puertos sobre la marcha. El otro dispositivo está en la misma situación. Ninguno de los dos puede simplemente «marcarle» al otro directamente sin averiguar antes qué dirección lo alcanzaría de verdad.",
        "Para eso sirve STUN (Session Traversal Utilities for NAT). Cada dispositivo le hace brevemente una pregunta a un pequeño y ligero servidor STUN: «¿desde qué dirección y puerto me ves llegar?». La respuesta le dice su propia dirección visible desde el exterior — ni el archivo, ni ningún contenido, solo la información de red suficiente para describir un camino de vuelta hacia él. Ambos dispositivos intercambian esta información (mediante un paso de señalización que solo transporta detalles de establecimiento de la conexión, nunca bytes del archivo) y luego intentan abrir un camino directo hacia la dirección del otro. En una gran parte de los casos reales — especialmente dos dispositivos en la misma Wi-Fi, o NAT que se comportan de forma predecible — esto funciona y se abre una conexión totalmente directa.",
      ],
      bullets: [
        "STUN solo llega a conocer y compartir direcciones de red — nunca el contenido de los archivos, sus nombres ni las claves de cifrado.",
        "Relayium usa WebRTC directamente para sesiones del navegador en la misma LAN. La vía del navegador entre redes se retransmite deliberadamente. El CLI sigue siendo direct-only y falla en vez de retransmitir bytes del archivo.",
        "Dos dispositivos en la misma red (sin necesidad de código) suelen conectarse de la forma más directa de todas, ya que a menudo no hay ningún NAT de por medio.",
      ],
    },
    {
      heading: "Cuando no se encuentra un camino directo: el retransmisor TURN",
      body: [
        "A veces STUN no basta. Algunos NAT — especialmente en redes corporativas más estrictas o en ciertos operadores móviles — son lo bastante impredecibles como para que no pueda descubrirse ningún camino directo solo con la información externa. Si ambos dispositivos están detrás de ese tipo de NAT, una conexión genuinamente directa simplemente no es posible; algo tiene que retransmitir el tráfico en medio.",
        "En un diseño WebRTC/ICE general, TURN puede ser el retransmisor de reserva cuando falla una vía directa. La aplicación web de Relayium elige explícitamente WebRTC directo en la misma LAN y TURN desde el inicio para todas las sesiones entre redes. El archivo ya está cifrado de extremo a extremo, así que el retransmisor solo transporta texto cifrado y no puede leer ni descifrar el contenido.",
      ],
      bullets: [
        "En la misma red, Relayium conecta los dispositivos directamente; entre redes usa el retransmisor TURN por defecto, porque allí muy a menudo no hay ninguna ruta directa.",
        "El retransmisor solo reenvía texto cifrado; nunca tiene la clave de descifrado y no puede leer el contenido de los archivos, sus nombres ni ninguna otra cosa sobre lo que hay dentro.",
        "El CLI de Relayium es una vía direct-only separada: nunca retransmite bytes del archivo y falla si no puede establecer una conexión directa.",
      ],
    },
    {
      heading: "Por qué esto importa: privacidad y velocidad",
      body: [
        "El argumento de la privacidad es sencillo: cuando los bytes del archivo solo cruzan un único salto, directamente entre dos dispositivos, no hay ningún paso de almacenamiento del lado del servidor donde una copia pudiera quedarse, registrarse o ser accedida por otra persona — porque nunca se colocó ahí. Esa es una garantía estructuralmente distinta de un «prometemos borrarlo en algún momento».",
        "El argumento de la velocidad sigue la misma lógica. Una transferencia de subida y luego descarga tiene que cruzar la red dos veces — una de subida, otra de bajada — y a menudo espera a que el lado emisor termine por completo antes de que el lado receptor pueda empezar. Una conexión directa cruza la red una sola vez, y los datos pueden fluir de forma continua entre los dos dispositivos tan rápido como lo permita la conexión más lenta, sin un servidor en medio que limite el rendimiento o añada su propia latencia.",
      ],
    },
    {
      heading: "Cómo lo junta todo Relayium",
      body: [
        "Abre relayium.com en dos dispositivos de la misma red y normalmente se encuentran automáticamente — sin cuenta, sin código, nada que instalar; ese es el caso de la red local, donde a menudo ni siquiera hace falta STUN. Para enviar a través de internet a alguien en una red distinta se usa un código de emparejamiento: el remitente inicia sesión, genera un código (o comparte un enlace, con un código QR opcional para escanear) y, en cuanto la otra persona se une, la transferencia va por un retransmisor TURN cifrado: la vía fiable a través de NAT impredecibles, y solo transporta texto cifrado; el destinatario sigue sin necesitar cuenta.",
        "Una vez abierta la vía en tiempo real, hasta 1.000 archivos fluyen continuamente por la ruta elegida y cada uno se verifica con SHA-256. Relayium no conserva copia de contenido ni historial en tiempo real del lado del servidor. Si la otra persona está desconectada, el enlace almacenado de conocimiento cero es un modo separado.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Es lo mismo de igual a igual que cifrado de extremo a extremo?",
        a: "Están relacionados, pero no son idénticos. P2P describe la comunicación entre extremos sin garantizar que cada salto de red sea directo; TURN puede transportar el tráfico. El cifrado determina si un intermediario puede leerlo. Relayium usa WebRTC directo en la misma LAN y TURN cifrado de extremo a extremo entre redes, que el retransmisor no puede leer ni descifrar.",
      },
      {
        q: "¿Una transferencia P2P llega a tocar algún servidor?",
        a: "Un pequeño servidor de señalización ayuda a los dos dispositivos a encontrar la dirección del otro — pero solo ve información de establecimiento de la conexión, nunca bytes del archivo. Entre redes, en el navegador, un retransmisor TURN reenvía por diseño los datos cifrados del archivo, pero incluso entonces solo maneja texto cifrado que no puede descifrar.",
      },
      {
        q: "¿Por qué fallaría una conexión directa en primer lugar?",
        a: "Algunas redes — a menudo cortafuegos corporativos estrictos o ciertos NAT de operadores móviles — están construidas de forma que hacen imposible descubrir una dirección alcanzable solo con la información externa. En lugar de gastar unos veinte segundos en averiguarlo en cada transferencia, la aplicación web de Relayium envía de entrada todas las transferencias entre redes por el retransmisor: lo que las lleva es el retransmisor, no un intento directo fallido.",
      },
      {
        q: "¿Es más lenta la transferencia P2P cuando pasa por un retransmisor?",
        a: "Puede añadir algo de latencia, ya que el retransmisor es un salto extra por el que pasan los datos y es un servidor compartido en lugar de uno dedicado. Pero suele seguir siendo más rápido que un flujo de subida y luego descarga, porque no hay que esperar a que el archivo aterrice por completo en un servidor antes de que el lado de la descarga pueda empezar.",
      },
      {
        q: "¿Ambas personas necesitan una cuenta para una transferencia P2P?",
        a: "Dos dispositivos en la misma red no necesitan cuenta alguna. Enviar entre redes distintas mediante un código de emparejamiento requiere que el remitente inicie sesión, pero la persona que recibe nunca necesita cuenta, sea cual sea el camino.",
      },
    ],
  },
  cta: {
    text: "¿Quieres probarlo? Abre Relayium en dos dispositivos e inicia una sesión cifrada en tiempo real.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "O que é transferência de arquivos ponto a ponto?",
  description:
    "Uma explicação em linguagem simples da transferência de arquivos P2P: como ela difere de enviar para um servidor, como uma conexão WebRTC direta é encontrada e por que é privada e rápida.",
  updatedLabel: "Última atualização",
  lead: [
    "“Ponto a ponto” é usado de forma imprecisa, então aqui está o que realmente significa para uma transferência de arquivos: seu arquivo vai direto de um dispositivo para o outro, e não sobe para o servidor de uma empresa e desce de volta. Não há parada no meio onde uma cópia poderia ficar.",
    "Parece simples, mas os caminhos reais diferem. Esta página explica primeiro WebRTC/ICE em geral, onde o TURN pode ser uma rota de reserva, e depois separa a implementação do Relayium: o WebRTC do navegador é direto na mesma LAN, o TURN é usado por design entre redes e a CLI é direct-only.",
  ],
  sections: [
    {
      heading: "P2P versus a forma habitual: eliminar a parada intermediária",
      body: [
        "A maioria das ferramentas de “enviar arquivo” funciona por upload: seu arquivo vai do seu dispositivo para o servidor da empresa, fica armazenado lá e a outra pessoa baixa de volta. São dois saltos e, por um tempo, uma cópia completa do seu arquivo fica no armazenamento de outra pessoa — mesmo que seja excluída depois.",
        "A transferência ponto a ponto pula essa parada. Assim que há uma conexão aberta entre o seu dispositivo e o da outra pessoa, os bytes do arquivo fluem diretamente por esse único salto e por nenhum outro lugar. Não há cópia do lado do servidor para armazenar, proteger ou acabar excluindo, porque ela nunca foi enviada em primeiro lugar.",
      ],
      bullets: [
        "Transferência baseada em upload: do seu dispositivo para um servidor e depois para o dispositivo dela — dois saltos, uma cópia armazenada no meio.",
        "Transferência ponto a ponto: do seu dispositivo direto para o dispositivo dela — um salto, nada armazenado.",
        "O modo em tempo real do navegador do Relayium tem dois caminhos: o WebRTC é direto na mesma LAN; entre redes, o TURN transporta por design texto cifrado de ponta a ponta sem manter cópia nem histórico de conteúdo no servidor.",
      ],
    },
    {
      heading: "Como dois dispositivos realmente se encontram: STUN",
      body: [
        "Aqui está a parte que não é óbvia: seu dispositivo quase com certeza não conhece o próprio endereço tal como visto da internet externa — ele fica atrás de um roteador doméstico ou da tradução de endereços de rede (NAT) de uma operadora móvel, que o esconde atrás de um IP público compartilhado e reatribui as portas dinamicamente. O outro dispositivo está na mesma situação. Nenhum dos dois pode simplesmente “discar” para o outro diretamente sem antes descobrir qual endereço realmente o alcançaria.",
        "É para isso que serve o STUN (Session Traversal Utilities for NAT). Cada dispositivo faz brevemente uma pergunta a um pequeno e leve servidor STUN: “de qual endereço e porta você me vê chegando?”. A resposta lhe informa o próprio endereço visível de fora — nem o arquivo, nem qualquer conteúdo, apenas informação de rede suficiente para descrever um caminho de volta até ele. Ambos os dispositivos trocam essa informação (por meio de uma etapa de sinalização que só transporta detalhes de estabelecimento da conexão, nunca bytes do arquivo) e então tentam abrir um caminho direto até o endereço um do outro. Em grande parte dos casos reais — especialmente dois dispositivos na mesma Wi-Fi, ou NATs que se comportam de forma previsível — isso funciona e uma conexão totalmente direta se abre.",
      ],
      bullets: [
        "O STUN só chega a conhecer e compartilhar endereços de rede — nunca o conteúdo dos arquivos, seus nomes ou as chaves de criptografia.",
        "O Relayium usa WebRTC diretamente para sessões do navegador na mesma LAN. O caminho do navegador entre redes é retransmitido de propósito. A CLI continua direct-only e falha em vez de retransmitir bytes do arquivo.",
        "Dois dispositivos na mesma rede (sem necessidade de código) costumam se conectar da forma mais direta de todas, já que muitas vezes não há nenhum NAT no caminho.",
      ],
    },
    {
      heading: "Quando um caminho direto não pode ser encontrado: o retransmissor TURN",
      body: [
        "Às vezes o STUN não basta. Alguns NATs — especialmente em redes corporativas mais rígidas ou em certas operadoras móveis — são imprevisíveis o suficiente para que nenhum caminho direto possa ser descoberto apenas com a informação externa. Se ambos os dispositivos estiverem atrás desse tipo de NAT, uma conexão genuinamente direta simplesmente não é possível; algo tem que retransmitir o tráfego no meio.",
        "Em um projeto WebRTC/ICE geral, o TURN pode ser o retransmissor de reserva quando um caminho direto falha. O aplicativo web do Relayium escolhe explicitamente WebRTC direto na mesma LAN e TURN desde o início para todas as sessões entre redes. O arquivo já está criptografado de ponta a ponta, então o retransmissor só transporta texto cifrado e não consegue ler nem descriptografar o conteúdo.",
      ],
      bullets: [
        "Na mesma rede, o Relayium conecta os dispositivos diretamente; entre redes ele usa o retransmissor TURN por padrão, porque ali muitas vezes não há caminho direto.",
        "O retransmissor só encaminha texto cifrado; ele nunca tem a chave de descriptografia e não pode ler o conteúdo dos arquivos, seus nomes nem qualquer outra coisa sobre o que há dentro.",
        "A CLI do Relayium é um caminho direct-only separado: nunca retransmite bytes do arquivo e falha se não conseguir estabelecer uma conexão direta.",
      ],
    },
    {
      heading: "Por que isso importa: privacidade e velocidade",
      body: [
        "O argumento da privacidade é simples: quando os bytes do arquivo só cruzam um único salto, diretamente entre dois dispositivos, não há nenhuma etapa de armazenamento do lado do servidor onde uma cópia pudesse ficar, ser registrada ou ser acessada por outra pessoa — porque ela nunca foi colocada ali. Essa é uma garantia estruturalmente diferente de um “prometemos excluir em algum momento”.",
        "O argumento da velocidade segue a mesma lógica. Uma transferência de upload e depois download precisa cruzar a rede duas vezes — uma de subida, uma de descida — e muitas vezes espera o lado remetente terminar por completo antes de o lado receptor poder começar. Uma conexão direta cruza a rede apenas uma vez, e os dados podem fluir continuamente entre os dois dispositivos tão rápido quanto a conexão mais lenta permitir, sem um servidor no meio limitando a taxa de transferência ou acrescentando sua própria latência.",
      ],
    },
    {
      heading: "Como o Relayium junta tudo isso",
      body: [
        "Abra relayium.com em dois dispositivos na mesma rede e normalmente eles se encontram automaticamente — sem conta, sem código, nada para instalar; esse é o caso da rede local, em que muitas vezes o STUN nem é necessário. Para enviar pela internet a alguém em outra rede, usa-se um código de emparelhamento: o remetente entra, gera um código (ou compartilha um link, com um código QR opcional para escanear) e, assim que a outra pessoa entra, a transferência corre por um retransmissor TURN criptografado: o caminho confiável através de NATs imprevisíveis, e ele só carrega texto cifrado; o destinatário continua sem precisar de conta.",
        "Uma vez aberto o caminho em tempo real, até 1.000 arquivos fluem continuamente pela rota escolhida e cada um é verificado com SHA-256. O Relayium não mantém cópia de conteúdo nem histórico em tempo real no servidor. Se a outra pessoa estiver offline, o link armazenado de conhecimento zero é um modo separado.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Ponto a ponto é a mesma coisa que criptografia de ponta a ponta?",
        a: "Estão relacionados, mas não são idênticos. P2P descreve a comunicação entre pontas sem garantir que cada salto de rede seja direto; o TURN pode transportar o tráfego. A criptografia determina se um intermediário consegue lê-lo. O Relayium usa WebRTC direto na mesma LAN e TURN criptografado de ponta a ponta entre redes, que o retransmissor não consegue ler nem descriptografar.",
      },
      {
        q: "Uma transferência P2P chega a tocar em algum servidor?",
        a: "Um pequeno servidor de sinalização ajuda os dois dispositivos a encontrar o endereço um do outro — mas ele só vê informação de estabelecimento da conexão, nunca bytes do arquivo. Entre redes, no navegador, um retransmissor TURN encaminha por projeto os dados criptografados do arquivo, mas mesmo assim só lida com texto cifrado que não consegue descriptografar.",
      },
      {
        q: "Por que uma conexão direta falharia em primeiro lugar?",
        a: "Algumas redes — muitas vezes firewalls corporativos rígidos ou certos NATs de operadoras móveis — são construídas de forma a tornar impossível descobrir um endereço alcançável apenas com a informação externa. Em vez de gastar uns vinte segundos descobrindo isso a cada transferência, o aplicativo web do Relayium envia de saída todas as transferências entre redes pelo retransmissor — o que as carrega é o retransmissor, não uma tentativa direta que falhou.",
      },
      {
        q: "A transferência P2P fica mais lenta quando passa por um retransmissor?",
        a: "Pode acrescentar alguma latência, já que o retransmissor é um salto extra pelo qual os dados passam e é um servidor compartilhado em vez de dedicado. Mas ainda costuma ser mais rápido que um fluxo de upload e depois download, porque não é preciso esperar o arquivo aterrissar por completo em um servidor antes de o lado do download poder começar.",
      },
      {
        q: "As duas pessoas precisam de conta para uma transferência P2P?",
        a: "Dois dispositivos na mesma rede não precisam de conta alguma. Enviar entre redes diferentes por código de emparelhamento exige que o remetente entre, mas a pessoa que recebe nunca precisa de conta, seja qual for o caminho.",
      },
    ],
  },
  cta: {
    text: "Quer experimentar? Abra o Relayium em dois dispositivos e inicie uma sessão criptografada em tempo real.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/what-is-peer-to-peer-file-transfer",
  published: "2026-07-09",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
