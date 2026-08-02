// web/scripts/pages/content/articles/howto-large-files-without-cloud.mjs
// How-to: send large files (multi-GB video / project archives) without the cloud.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "How to send large files without the cloud",
  description:
    "Send multi-gigabyte videos and project archives live between browsers — LAN WebRTC is direct, cross-network browser sessions carry end-to-end ciphertext over TURN, and realtime mode keeps no server-side content copy or history.",
  updatedLabel: "Last updated",
  lead: [
    "A 20 GB video export or a heavy project archive is exactly where cloud storage feels slowest: you upload the whole file once, wait, then the other person downloads it again — two full transfers plus whatever your storage quota allows. For a one-time hand-off, that is a lot of copying and waiting for bytes that only ever needed to go from A to B.",
    "Relayium streams the file live instead of uploading it for later download. On the same LAN, WebRTC connects directly; across networks, browser sessions use TURN by design to carry end-to-end encrypted ciphertext that the relay cannot read or decrypt. Relayium stores no realtime content or transfer history. This guide also covers the two practical limits: which browsers can handle unlimited sizes, and why both people usually need to be online at the same time.",
  ],
  sections: [
    {
      heading: "Why direct transfer wins for big files",
      body: [
        "With cloud storage a large file is uploaded for storage and later downloaded, consuming a quota in between. Relayium's realtime path streams continuously instead: WebRTC is direct on the same LAN, while cross-network browsers use TURN to forward end-to-end encrypted ciphertext. In either case Relayium keeps no server-side content copy or realtime history.",
        "Relayium runs entirely in the browser, so there is nothing to install on either end. It works on Windows, macOS, Linux, Android and iOS. On the same network realtime transfers need no account; sending across networks with a pairing code just asks the sender to sign in — you just open relayium.com on both devices and connect.",
      ],
    },
    {
      heading: "No size cap in realtime mode",
      body: [
        "Realtime transfers have no server-side storage-size limit because Relayium does not retain a content copy. A TURN relay may carry cross-network ciphertext while both sides are online, but it cannot read, decrypt, or retain it as transfer history. The practical ceiling is set by the receiving browser, not by us.",
        "On Chrome and Edge the incoming file is streamed straight to disk as it arrives, so it never has to fit in memory — this is the combination to use for very large files, comfortably into the tens of gigabytes. A batch can hold up to 1,000 files, and each one is verified end-to-end with a SHA-256 hash, so what lands on disk is byte-for-byte what you sent.",
      ],
      bullets: [
        "Chrome or Edge on the receiving desktop: files stream straight to disk, so there is effectively no size cap.",
        "Firefox and Safari have no File System Access API, so a realtime batch is held in memory there — Relayium warns above roughly 256 MB, a deliberately cautious estimate rather than a hard limit.",
        "Up to 1,000 files per batch, each checked with its own SHA-256 hash on arrival.",
      ],
    },
    {
      heading: "Resume instead of restarting",
      body: [
        "Big transfers take time, and time is when Wi-Fi drops, laptops sleep, and phones switch networks. Relayium is built for that: if the connection breaks partway through, the transfer resumes from where it left off instead of starting the whole file over.",
        "Connectivity is handled the same way. On one network the transfer goes directly device-to-device; across networks the encrypted stream travels over a TURN relay. The relay only ever sees ciphertext, so that path stays end-to-end encrypted too.",
      ],
    },
    {
      heading: "Send now, or leave a link for later",
      body: [
        "Realtime transfer needs both people online at the same time, which is ideal when you can coordinate — a call, a shared moment, a colleague at their desk. If the other person is not available right now, you can create a stored download link instead.",
        "A stored link is zero-knowledge: your browser encrypts the files with AES-256-GCM before upload and the decryption key lives only in the URL fragment, so the server keeps ciphertext it cannot read. Be aware of the trade-offs — creating a link requires the sender to sign in, links count against a storage quota, and they expire (or can burn after the first download). One thing the link path does better: its download page can stream a single file to disk through a service worker even in Firefox and Safari, so the receiving browser's memory is not the constraint there. For the biggest files, when you can both be online, the realtime path stays the cleanest option.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "What is the largest file I can send?",
        a: "In realtime mode there is no server-side limit — the cap comes from the receiving browser. On a desktop Chrome or Edge the file streams to disk, so you can send tens of gigabytes without running out of memory. Firefox and Safari lack the File System Access API, so what they receive is assembled in memory instead, and Relayium warns above roughly 256 MB — a conservative estimate rather than a measured ceiling, since the real one depends on the device's memory, its OS and what else is open.",
      },
      {
        q: "What happens if the transfer is interrupted?",
        a: "It resumes automatically. If the connection drops mid-transfer — a dropped Wi-Fi signal, a sleeping laptop, a network switch — Relayium picks up from where it stopped rather than restarting the whole file, so a long transfer is not lost to a brief hiccup.",
      },
      {
        q: "How is my privacy protected for large files?",
        a: "Realtime transfers are end-to-end encrypted with an X25519 key exchange and per-chunk AES-256-GCM, and that key never reaches any server. With advanced verification on (off by default), both devices show a 6-digit verification code; each file is checked with a SHA-256 hash. LAN WebRTC is direct; cross-network browser sessions use TURN by design, and the relay carries only ciphertext it cannot read or decrypt.",
      },
    ],
  },
  cta: {
    text: "Move your next multi-gigabyte file in realtime — no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何不用网盘传输大文件",
  description:
    "在浏览器之间实时传输几 GB 的视频和工程文件——局域网 WebRTC 直连，跨网络浏览器通过 TURN 承载端到端密文，实时模式不保留服务器端内容副本或历史。",
  updatedLabel: "最近更新",
  lead: [
    "一个 20 GB 的视频导出，或者一个体积庞大的工程压缩包，恰恰是网盘最慢的场景：你先把整个文件上传一遍、等待，然后对方再下载一遍——两次完整传输，还要受制于你的存储配额。对一次性的交付来说，只是想把字节从 A 送到 B，却要这样反复复制和等待。",
    "Relayium 会实时流式传输文件，而不是先上传留待下载。同一局域网内 WebRTC 直连；跨网络浏览器按设计使用 TURN 承载端到端加密的密文，中继无法读取或解密。Relayium 不存储实时内容或传输历史。本文也说明两个实际限制：哪些浏览器能承受无上限的大小，以及双方通常需要同时在线。",
  ],
  sections: [
    {
      heading: "大文件为什么直连更划算",
      body: [
        "用网盘时，大文件先上传存储、之后再下载，中间还占着配额。Relayium 的实时路径改为持续流式传输：同一局域网内 WebRTC 直连，跨网络浏览器经 TURN 转发端到端加密的密文。两种情况下 Relayium 都不保留服务器端内容副本或实时历史。",
        "Relayium 完全在浏览器里运行，两端都无需安装任何软件。它支持 Windows、macOS、Linux、Android 和 iOS。同一网络下实时传输无需账号；跨网络用配对码传输只需发送方登录一下——只要两台设备都打开 relayium.com 连上即可。",
      ],
    },
    {
      heading: "实时模式没有大小上限",
      body: [
        "实时传输没有服务器端存储大小限制，因为 Relayium 不保留内容副本。跨网络时 TURN 中继会在双方在线期间承载密文，但无法读取、解密或把它留作传输历史。实际的上限由接收端浏览器决定。",
        "在 Chrome 和 Edge 上，进入的文件会随着到达即时流式写入磁盘，因此从不需要装进内存——这正是传超大文件该用的组合，轻松到几十 GB。每批最多可放 1,000 个文件，每个都用 SHA-256 做端到端校验，所以落到磁盘上的与你发出的逐字节一致。",
      ],
      bullets: [
        "接收端用桌面版 Chrome 或 Edge：文件直接流式写盘，因此实际上没有大小上限。",
        "Firefox 和 Safari 没有 File System Access API，实时接收的一批文件只能放在内存里——超过约 256 MB 时 Relayium 会提示你，这是刻意取的保守估计，而不是硬性上限。",
        "每批最多 1,000 个文件，每个到达时都用各自的 SHA-256 校验。",
      ],
    },
    {
      heading: "断点续传，而非重来",
      body: [
        "大文件传输耗时，而耗时正是 Wi-Fi 断线、笔记本休眠、手机切换网络最容易发生的时候。Relayium 就是为此而生：如果连接中途断开，传输会从中断处续传，而不是把整个文件从头再来。",
        "网络连通问题也是同样的处理思路。同一网络内传输在设备之间直连；跨网络时加密数据流经 TURN 中继转发。中继只能看到密文，因此这条路径同样保持端到端加密。",
      ],
    },
    {
      heading: "现在就传，或留个链接稍后取",
      body: [
        "实时传输需要双方同时在线，这在能协调的时候最理想——一通电话、一个共处的时刻、一位就在工位上的同事。如果对方此刻不在，你可以改为创建一个存储下载链接。",
        "存储链接是零知识的：浏览器在上传前用 AES-256-GCM 加密文件，解密密钥只存在于 URL 片段里，服务器只保存它读不懂的密文。也要清楚其中的取舍——生成链接需要发送方登录，链接会占用存储配额，并且会过期（也可以设置为首次下载后即焚）。链接这条路有一点更强：它的下载页即使在 Firefox 和 Safari 上，也能借助 Service Worker 把单个文件流式写入磁盘，所以那里的瓶颈不是浏览器内存。对于最大的文件，只要双方都能在线，实时路径始终是最干净的选择。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "最大能传多大的文件？",
        a: "实时模式没有服务器端限制——上限来自接收端的浏览器。在桌面版 Chrome 或 Edge 上，文件会流式写入磁盘，因此可以传几十 GB 而不会耗尽内存。Firefox 和 Safari 没有 File System Access API，它们收到的内容只能先攒进内存，因此超过约 256 MB 时 Relayium 会先提示——这是保守估计而非实测出的天花板，真正的上限取决于设备内存、系统以及还开着什么。",
      },
      {
        q: "传输中断了怎么办？",
        a: "会自动续传。如果传输中途断开——Wi-Fi 掉线、笔记本休眠、切换网络——Relayium 会从停下的地方接着传，而不是把整个文件从头再来，所以一次长传不会因短暂的波动而前功尽弃。",
      },
      {
        q: "传大文件时隐私如何保证？",
        a: "实时传输用 X25519 密钥交换加逐块 AES-256-GCM 做端到端加密，密钥从不抵达任何服务器。打开高级验证（默认关闭）后两台设备会显示 6 位校验码；每个文件都用 SHA-256 校验。局域网 WebRTC 直连；跨网络浏览器按设计使用 TURN，中继只承载它无法读取或解密的密文。",
      },
    ],
  },
  cta: {
    text: "实时传输下一个几 GB 的大文件——无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "クラウドを使わずに大きなファイルを送る方法",
  description:
    "数ギガバイトの動画やプロジェクトアーカイブをブラウザ間でライブ転送。同じ LAN の WebRTC は直接接続し、ネットワークをまたぐブラウザは TURN でエンドツーエンド暗号文を運び、リアルタイム内容のサーバー側コピーや履歴は残しません。",
  updatedLabel: "最終更新",
  lead: [
    "20 GB の動画書き出しや重いプロジェクトのアーカイブは、まさにクラウドストレージが最も遅く感じる場面です。ファイル全体を一度アップロードして待ち、相手がもう一度ダウンロードします。2回の完全な転送に加え、ストレージ容量の制限も受けます。一度きりの受け渡しなのに、A から B へ送るだけのバイトのために、これだけの複製と待ち時間がかかります。",
    "Relayium は後でダウンロードするためにアップロードするのではなく、ファイルをライブでストリーミングします。同じ LAN では WebRTC が直接接続し、ネットワークをまたぐブラウザセッションは設計上 TURN を使って、リレーが読み取りも復号もできないエンドツーエンド暗号文を運びます。Relayium はリアルタイム内容や転送履歴を保存しません。本ガイドでは、ブラウザごとのサイズ上限と双方が通常同時にオンラインである必要も説明します。",
  ],
  sections: [
    {
      heading: "大きなファイルで直接転送が有利な理由",
      body: [
        "クラウドストレージでは大きなファイルを保存用にアップロードし、後でダウンロードするため、その間ストレージ容量も消費します。Relayium のリアルタイム経路は継続的にストリーミングします。同じ LAN では WebRTC が直接接続し、ネットワークをまたぐブラウザは TURN でエンドツーエンド暗号文を転送します。どちらでもサーバー側の内容コピーやリアルタイム履歴は残りません。",
        "Relayium は完全にブラウザ内で動作するため、どちらの端末にもインストールは不要です。Windows、macOS、Linux、Android、iOS で動きます。同じネットワークならリアルタイム転送にアカウントは要りません。ネットワークをまたいでペアリングコードで送る場合も送信側がサインインするだけです。両方の端末で relayium.com を開いて接続するだけです。",
      ],
    },
    {
      heading: "リアルタイムモードにはサイズ上限がない",
      body: [
        "Relayium は内容のコピーを保持しないため、リアルタイム転送にサーバー側ストレージのサイズ制限はありません。ネットワークをまたぐ際は TURN が両者のオンライン中に暗号文を運びますが、読み取りも復号もできず、転送履歴として保持しません。実際の上限は受信側ブラウザが決めます。",
        "Chrome と Edge では、届いたファイルは到着に合わせてそのままディスクへストリーミングされるため、メモリに収める必要がありません。これが非常に大きなファイルに使うべき組み合わせで、数十 GB まで余裕です。1バッチには最大1,000ファイルを入れられ、それぞれが SHA-256 ハッシュでエンドツーエンドに検証されるので、ディスクに残るものは送ったものとバイト単位で同一です。",
      ],
      bullets: [
        "受信側がパソコン版の Chrome または Edge：ファイルはそのままディスクへストリーミングされるため、実質的にサイズ上限はありません。",
        "Firefox と Safari には File System Access API がないため、リアルタイム受信の1バッチはメモリに保持されます。およそ 256 MB を超えると Relayium が警告します。これは硬い上限ではなく、意図的に控えめに置いた目安です。",
        "1バッチ最大1,000ファイル、それぞれ到着時に固有の SHA-256 ハッシュで検証されます。",
      ],
    },
    {
      heading: "最初からではなく再開する",
      body: [
        "大きな転送には時間がかかり、その時間こそ Wi-Fi が切れ、ノートPCがスリープし、スマホがネットワークを切り替える瞬間です。Relayium はそれに備えて作られています。途中で接続が切れても、転送はファイル全体をやり直すのではなく、止まった所から再開します。",
        "接続性も同じように扱われます。同一ネットワーク内では転送はデバイス間で直接行われ、ネットワークをまたぐ場合は暗号化ストリームが TURN リレーを経由します。リレーが見るのは暗号文だけなので、この経路でもエンドツーエンド暗号化のままです。",
      ],
    },
    {
      heading: "今すぐ送る、または後で取れるリンクを残す",
      body: [
        "リアルタイム転送は双方が同時にオンラインであることが必要で、都合を合わせられるときに最適です。相手が今いない場合は、代わりに保存型のダウンロードリンクを作成できます。",
        "保存リンクはゼロ知識です。ブラウザがアップロード前に AES-256-GCM でファイルを暗号化し、復号鍵は URL フラグメントにだけ存在するため、サーバーは読めない暗号文を保持します。トレードオフも把握してください。リンクの作成には送信側のサインインが必要で、リンクはストレージ容量を消費し、有効期限があります（初回ダウンロード後に消去する設定も可能）。リンク経由には利点もあります。そのダウンロードページは Firefox や Safari でも Service Worker を使って単一ファイルをディスクへストリーミングできるため、受信側ブラウザのメモリが制約になりません。最大のファイルでは、双方がオンラインになれるなら、リアルタイムの経路が常に最もすっきりした選択肢です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "送れるファイルの最大サイズは？",
        a: "リアルタイムモードにサーバー側の制限はありません。上限は受信側のブラウザ次第です。パソコン版の Chrome や Edge ではファイルがディスクへストリーミングされるため、メモリを使い切らずに数十 GB を送れます。Firefox と Safari には File System Access API がないため、受け取った分はメモリに溜められることになり、およそ 256 MB を超えると Relayium が警告します。これは実測した天井ではなく控えめな見積もりで、本当の限界は端末のメモリ・OS・ほかに何を開いているかで決まります。",
      },
      {
        q: "転送が中断されたらどうなりますか？",
        a: "自動的に再開します。転送の途中で接続が切れても（Wi-Fi の切断、ノートPCのスリープ、ネットワークの切り替えなど）、Relayium はファイル全体をやり直すのではなく止まった所から続けるので、長い転送が一瞬の不調で無駄になりません。",
      },
      {
        q: "大きなファイルでプライバシーはどう守られますか？",
        a: "リアルタイム転送は X25519 の鍵交換とチャンクごとの AES-256-GCM でエンドツーエンドに暗号化され、鍵はどのサーバーにも届きません。高度な検証（既定はオフ）をオンにすると両端末が6桁の検証コードを表示します。各ファイルは SHA-256 で検証します。同じ LAN の WebRTC は直接接続し、ネットワークをまたぐブラウザは設計上 TURN を使用します。リレーは暗号文を運ぶだけで読み取りも復号もできません。",
      },
    ],
  },
  cta: {
    text: "次の数ギガバイトのファイルをリアルタイムで送りましょう。インストール不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "클라우드 없이 대용량 파일 보내는 방법",
  description:
    "수 기가바이트의 동영상과 프로젝트 아카이브를 브라우저 사이에서 실시간 전송하세요. 같은 LAN의 WebRTC는 직접 연결하고, 네트워크를 넘는 브라우저는 TURN으로 종단간 암호문을 운반하며, 실시간 내용의 서버 측 복사본이나 기록은 남지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "20 GB짜리 동영상 내보내기나 무거운 프로젝트 아카이브야말로 클라우드 스토리지가 가장 느리게 느껴지는 순간입니다. 파일 전체를 한 번 업로드하고 기다린 뒤, 상대가 다시 다운로드합니다. 두 번의 완전한 전송에 스토리지 할당량 제한까지 받습니다. 한 번뿐인 전달인데, A에서 B로 보내기만 하면 되는 바이트를 위해 이렇게 복사하고 기다려야 합니다.",
    "Relayium은 나중에 다운로드하도록 업로드하는 대신 파일을 실시간 스트리밍합니다. 같은 LAN에서는 WebRTC가 직접 연결하고, 네트워크를 넘는 브라우저 세션은 설계상 TURN을 사용해 릴레이가 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다. Relayium은 실시간 내용이나 전송 기록을 저장하지 않습니다. 이 가이드는 브라우저별 크기 한계와 보통 양쪽이 동시에 온라인이어야 한다는 점도 설명합니다.",
  ],
  sections: [
    {
      heading: "대용량 파일에 직접 전송이 유리한 이유",
      body: [
        "클라우드 스토리지는 대용량 파일을 저장용으로 업로드한 뒤 나중에 다운로드하며 그 사이 할당량도 차지합니다. Relayium의 실시간 경로는 계속 스트리밍합니다. 같은 LAN에서는 WebRTC가 직접 연결하고, 네트워크를 넘는 브라우저는 TURN으로 종단간 암호문을 전달합니다. 어느 쪽이든 서버 측 내용 복사본이나 실시간 기록은 남지 않습니다.",
        "Relayium은 완전히 브라우저에서 동작하므로 양쪽 모두 설치할 것이 없습니다. Windows, macOS, Linux, Android, iOS에서 작동합니다. 같은 네트워크에서는 실시간 전송에 계정이 필요 없고, 페어링 코드로 네트워크를 넘어 보낼 때도 보내는 쪽이 로그인만 하면 됩니다. 두 기기에서 relayium.com을 열어 연결하기만 하면 됩니다.",
      ],
    },
    {
      heading: "실시간 모드에는 크기 제한이 없다",
      body: [
        "Relayium이 내용 복사본을 보관하지 않으므로 실시간 전송에는 서버 측 저장 크기 제한이 없습니다. 네트워크를 넘을 때 TURN은 양쪽이 온라인인 동안 암호문을 운반하지만 읽거나 복호화할 수 없고 전송 기록으로 보관하지 않습니다. 실질적인 상한은 받는 쪽 브라우저가 정합니다.",
        "Chrome과 Edge에서는 들어오는 파일이 도착하는 대로 곧바로 디스크로 스트리밍되므로 메모리에 담을 필요가 없습니다. 이것이 아주 큰 파일에 써야 할 조합이며, 수십 GB까지 여유롭습니다. 한 배치에 최대 1,000개 파일을 담을 수 있고, 각각 SHA-256 해시로 종단간 검증되므로 디스크에 남는 것은 보낸 것과 바이트 단위로 동일합니다.",
      ],
      bullets: [
        "받는 쪽이 데스크톱 Chrome 또는 Edge: 파일이 곧장 디스크로 스트리밍되므로 사실상 크기 제한이 없습니다.",
        "Firefox와 Safari에는 File System Access API가 없어 실시간으로 받은 묶음이 메모리에 담깁니다 — 대략 256 MB를 넘으면 Relayium이 경고하며, 이는 고정된 한계가 아니라 일부러 보수적으로 잡은 추정치입니다.",
        "배치당 최대 1,000개 파일, 각각 도착 시 고유한 SHA-256 해시로 검증됩니다.",
      ],
    },
    {
      heading: "처음부터가 아니라 이어서 재개",
      body: [
        "대용량 전송에는 시간이 걸리고, 그 시간이 바로 Wi-Fi가 끊기고 노트북이 절전에 들고 휴대폰이 네트워크를 바꾸는 때입니다. Relayium은 그에 대비해 만들어졌습니다. 도중에 연결이 끊겨도 전송은 파일 전체를 다시 시작하지 않고 멈춘 지점에서 이어집니다.",
        "연결성도 같은 방식으로 처리됩니다. 같은 네트워크 안에서는 전송이 기기 간에 직접 이루어지고, 네트워크를 넘을 때는 암호화된 스트림이 TURN 릴레이를 거칩니다. 릴레이는 암호문만 볼 수 있으므로 그 경로에서도 종단간 암호화를 유지합니다.",
      ],
    },
    {
      heading: "지금 보내거나, 나중에 받을 링크를 남기거나",
      body: [
        "실시간 전송은 양쪽이 동시에 온라인이어야 하며, 시간을 맞출 수 있을 때 가장 이상적입니다. 상대가 지금 없다면 대신 저장형 다운로드 링크를 만들 수 있습니다.",
        "저장 링크는 영지식입니다. 브라우저가 업로드 전에 AES-256-GCM으로 파일을 암호화하고 복호화 키는 URL 프래그먼트에만 존재하므로, 서버는 읽을 수 없는 암호문을 보관합니다. 절충점도 알아두세요. 링크 생성에는 보내는 쪽의 로그인이 필요하고, 링크는 스토리지 할당량을 차지하며, 만료됩니다(첫 다운로드 후 소각으로 설정할 수도 있습니다). 링크 쪽이 더 나은 점도 있습니다. 그 다운로드 페이지는 Firefox와 Safari에서도 서비스 워커를 통해 단일 파일을 디스크로 스트리밍할 수 있어, 거기서는 받는 브라우저의 메모리가 제약이 되지 않습니다. 가장 큰 파일이라면, 양쪽이 온라인일 수 있을 때 실시간 경로가 언제나 가장 깔끔한 선택입니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "보낼 수 있는 파일 최대 크기는 얼마인가요?",
        a: "실시간 모드에는 서버 측 제한이 없습니다. 상한은 받는 쪽 브라우저에 달렸습니다. 데스크톱 Chrome이나 Edge에서는 파일이 디스크로 스트리밍되어 메모리가 바닥나지 않고 수십 GB를 보낼 수 있습니다. Firefox와 Safari에는 File System Access API가 없어 받은 내용이 메모리에 모이며, 대략 256 MB를 넘으면 Relayium이 경고합니다. 측정된 천장이 아니라 보수적으로 잡은 추정치이고, 진짜 한계는 기기 메모리와 OS, 그 밖에 열어 둔 것에 달려 있습니다.",
      },
      {
        q: "전송이 중단되면 어떻게 되나요?",
        a: "자동으로 재개됩니다. 전송 도중 연결이 끊겨도(Wi-Fi 끊김, 노트북 절전, 네트워크 전환) Relayium은 파일 전체를 다시 시작하지 않고 멈춘 지점에서 이어가므로, 긴 전송이 잠깐의 장애로 헛되지 않습니다.",
      },
      {
        q: "대용량 파일에서 개인정보는 어떻게 보호되나요?",
        a: "실시간 전송은 X25519 키 교환과 블록별 AES-256-GCM으로 종단간 암호화되며 키는 어떤 서버에도 도달하지 않습니다. 고급 검증(기본값 꺼짐)을 켜면 두 기기가 6자리 검증 코드를 표시하며, 각 파일은 SHA-256으로 검사합니다. 같은 LAN의 WebRTC는 직접 연결하며, 네트워크를 넘는 브라우저는 설계상 TURN을 사용합니다. 릴레이는 읽거나 복호화할 수 없는 암호문만 운반합니다.",
      },
    ],
  },
  cta: {
    text: "다음 수 기가바이트 파일을 실시간으로 보내세요 — 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Große Dateien ohne Cloud versenden",
  description:
    "Sende mehrere Gigabyte große Videos und Projektarchive live zwischen Browsern: WebRTC ist im selben LAN direkt, netzübergreifend transportiert TURN Ende-zu-Ende-Chiffretext, und Echtzeitinhalte hinterlassen keine serverseitige Kopie oder Historie.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Ein 20 GB großer Videoexport oder ein schweres Projektarchiv ist genau der Fall, in dem Cloud-Speicher am langsamsten wirkt: Du lädst die ganze Datei einmal hoch, wartest, und die andere Person lädt sie erneut herunter — zwei vollständige Übertragungen, plus das, was dein Speicherkontingent zulässt. Für eine einmalige Übergabe ist das viel Kopieren und Warten für Bytes, die nur von A nach B mussten.",
    "Relayium streamt die Datei live, statt sie für einen späteren Download hochzuladen. Im selben LAN verbindet WebRTC direkt; netzübergreifende Browser-Sitzungen nutzen planmäßig TURN für Ende-zu-Ende-Chiffretext, den das Relay weder lesen noch entschlüsseln kann. Relayium speichert keine Echtzeitinhalte oder Übertragungshistorie. Diese Anleitung erklärt außerdem Browser-Größenlimits und warum beide meist gleichzeitig online sein müssen.",
  ],
  sections: [
    {
      heading: "Warum die Direktübertragung bei großen Dateien gewinnt",
      body: [
        "Cloud-Speicher lädt eine große Datei zur Aufbewahrung hoch und später wieder herunter; dazwischen belegt sie ein Kontingent. Relayiums Echtzeitpfad streamt fortlaufend: WebRTC ist im selben LAN direkt, netzübergreifende Browser leiten Ende-zu-Ende-Chiffretext über TURN weiter. In beiden Fällen bleibt keine serverseitige Inhaltskopie oder Echtzeithistorie.",
        "Relayium läuft vollständig im Browser, es gibt also auf keiner Seite etwas zu installieren. Es funktioniert unter Windows, macOS, Linux, Android und iOS. Im selben Netz brauchen Echtzeitübertragungen kein Konto; beim Senden über Netzwerke hinweg per Pairing-Code muss sich nur der Absender anmelden — du öffnest einfach relayium.com auf beiden Geräten und verbindest sie.",
      ],
    },
    {
      heading: "Keine Größenbeschränkung im Echtzeitmodus",
      body: [
        "Echtzeitübertragungen haben keine serverseitige Speichergrößenbeschränkung, weil Relayium keine Inhaltskopie behält. Ein TURN-Relay kann netzübergreifenden Chiffretext tragen, solange beide Seiten online sind, kann ihn aber weder lesen noch entschlüsseln oder als Übertragungshistorie behalten. Die praktische Obergrenze setzt der empfangende Browser.",
        "In Chrome und Edge wird die eingehende Datei beim Eintreffen direkt auf die Festplatte gestreamt, muss also nie in den Speicher passen — das ist die Kombination für sehr große Dateien, bequem bis in den zweistelligen Gigabyte-Bereich. Ein Stapel fasst bis zu 1.000 Dateien, und jede wird per SHA-256-Hash Ende-zu-Ende geprüft, sodass das, was auf der Festplatte landet, Byte für Byte dem entspricht, was du gesendet hast.",
      ],
      bullets: [
        "Chrome oder Edge am empfangenden Desktop: Dateien werden direkt auf die Festplatte gestreamt, es gibt also praktisch keine Größenbeschränkung.",
        "Firefox und Safari haben keine File System Access API, dort liegt ein in Echtzeit empfangener Stapel im Arbeitsspeicher — ab etwa 256 MB warnt Relayium, ein bewusst vorsichtiger Schätzwert und keine harte Grenze.",
        "Bis zu 1.000 Dateien pro Stapel, jede beim Eintreffen mit ihrem eigenen SHA-256-Hash geprüft.",
      ],
    },
    {
      heading: "Fortsetzen statt neu beginnen",
      body: [
        "Große Übertragungen brauchen Zeit, und in dieser Zeit bricht WLAN ab, gehen Laptops in den Ruhezustand und wechseln Handys das Netz. Relayium ist dafür gebaut: Bricht die Verbindung mittendrin ab, wird die Übertragung dort fortgesetzt, wo sie aufgehört hat, statt die ganze Datei neu zu beginnen.",
        "Die Konnektivität wird ebenso gehandhabt. Im selben Netz läuft die Übertragung direkt von Gerät zu Gerät; netzübergreifend läuft der verschlüsselte Datenstrom über ein TURN-Relay. Das Relay sieht nur Chiffretext, sodass auch dieser Pfad Ende-zu-Ende-verschlüsselt bleibt.",
      ],
    },
    {
      heading: "Jetzt senden oder einen Link für später hinterlassen",
      body: [
        "Die Echtzeitübertragung setzt voraus, dass beide gleichzeitig online sind — ideal, wenn ihr euch abstimmen könnt. Ist die andere Person gerade nicht verfügbar, kannst du stattdessen einen gespeicherten Download-Link erstellen.",
        "Ein gespeicherter Link ist Zero-Knowledge: Dein Browser verschlüsselt die Dateien vor dem Upload mit AES-256-GCM, und der Entschlüsselungsschlüssel liegt nur im URL-Fragment, sodass der Server Chiffretext behält, den er nicht lesen kann. Beachte die Kompromisse — das Erstellen eines Links erfordert die Anmeldung des Absenders, Links zählen gegen ein Speicherkontingent und laufen ab (oder können nach dem ersten Download verfallen). Eines kann der Link-Weg besser: Seine Download-Seite kann eine einzelne Datei selbst in Firefox und Safari über einen Service Worker auf die Festplatte streamen, der Arbeitsspeicher des empfangenden Browsers ist dort also nicht der Engpass. Für die größten Dateien bleibt der Echtzeitweg die sauberste Option, wenn ihr beide online sein könnt.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Wie groß darf die Datei sein, die ich sende?",
        a: "Im Echtzeitmodus gibt es keine serverseitige Grenze — die Obergrenze kommt vom empfangenden Browser. In Chrome oder Edge auf dem Desktop wird die Datei auf die Festplatte gestreamt, du kannst also zweistellige Gigabyte-Mengen senden, ohne dass der Speicher ausgeht. Firefox und Safari fehlt die File System Access API, dort sammelt sich das Empfangene im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium — eine vorsichtige Schätzung statt einer gemessenen Obergrenze, denn die echte hängt vom Arbeitsspeicher des Geräts, vom Betriebssystem und davon ab, was sonst offen ist.",
      },
      {
        q: "Was passiert, wenn die Übertragung unterbrochen wird?",
        a: "Sie wird automatisch fortgesetzt. Bricht die Verbindung mittendrin ab — ein abgerissenes WLAN-Signal, ein schlafender Laptop, ein Netzwechsel — nimmt Relayium dort wieder auf, wo es aufgehört hat, statt die ganze Datei neu zu starten, sodass eine lange Übertragung nicht an einem kurzen Aussetzer scheitert.",
      },
      {
        q: "Wie ist meine Privatsphäre bei großen Dateien geschützt?",
        a: "Echtzeitübertragungen sind mit X25519 und AES-256-GCM pro Block Ende-zu-Ende verschlüsselt; der Schlüssel erreicht keinen Server. Mit eingeschalteter erweiterter Verifizierung (standardmäßig aus) zeigen beide Geräte einen sechsstelligen Verifizierungscode; jede Datei wird per SHA-256 geprüft. WebRTC ist im selben LAN direkt; netzübergreifende Browser nutzen TURN planmäßig, und das Relay transportiert nur Chiffretext, den es weder lesen noch entschlüsseln kann.",
      },
    ],
  },
  cta: {
    text: "Bewege deine nächste mehrere Gigabyte große Datei in Echtzeit — keine Installation und im selben Netz kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer de gros fichiers sans le cloud",
  description:
    "Envoyez en direct des vidéos et archives de plusieurs gigaoctets entre navigateurs : WebRTC est direct sur le même LAN, TURN transporte le texte chiffré de bout en bout entre réseaux, sans copie ni historique de contenu temps réel côté serveur.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Un export vidéo de 20 Go ou une lourde archive de projet, c'est justement là que le stockage cloud paraît le plus lent : vous téléversez tout le fichier une fois, vous attendez, puis l'autre personne le télécharge à nouveau — deux transferts complets, plus ce que votre quota de stockage autorise. Pour une remise unique, cela fait beaucoup de copies et d'attente pour des octets qui ne devaient aller que de A à B.",
    "Relayium diffuse le fichier en direct au lieu de le téléverser pour un téléchargement ultérieur. Sur le même LAN, WebRTC se connecte directement ; entre réseaux, les navigateurs utilisent TURN par conception pour transporter un texte chiffré de bout en bout que le relais ne peut ni lire ni déchiffrer. Relayium ne stocke aucun contenu ni historique temps réel. Ce guide couvre aussi les limites de taille des navigateurs et la nécessité d'être généralement en ligne ensemble.",
  ],
  sections: [
    {
      heading: "Pourquoi le transfert direct l'emporte pour les gros fichiers",
      body: [
        "Le stockage cloud téléverse un gros fichier pour le conserver puis le retélécharge, en occupant un quota. Le chemin temps réel de Relayium diffuse en continu : WebRTC est direct sur le même LAN, tandis que les navigateurs entre réseaux transmettent du texte chiffré de bout en bout via TURN. Dans les deux cas, aucune copie de contenu ni aucun historique temps réel ne reste côté serveur.",
        "Relayium fonctionne entièrement dans le navigateur, il n'y a donc rien à installer d'un côté ou de l'autre. Il marche sous Windows, macOS, Linux, Android et iOS. Sur le même réseau, les transferts en temps réel ne demandent aucun compte ; envoyer entre réseaux différents avec un code d'appairage exige seulement que l'expéditeur se connecte — il suffit d'ouvrir relayium.com sur les deux appareils et de les connecter.",
      ],
    },
    {
      heading: "Aucune limite de taille en mode temps réel",
      body: [
        "Les transferts en temps réel n'ont aucune limite de stockage côté serveur, car Relayium ne conserve aucune copie du contenu. Un relais TURN peut transporter le texte chiffré entre réseaux pendant que les deux côtés sont en ligne, mais ne peut ni le lire, ni le déchiffrer, ni le garder comme historique. Le plafond pratique vient du navigateur qui reçoit.",
        "Sur Chrome et Edge, le fichier entrant est diffusé directement sur le disque à mesure qu'il arrive, il n'a donc jamais à tenir en mémoire — c'est la combinaison à utiliser pour de très gros fichiers, aisément jusqu'à des dizaines de gigaoctets. Un lot peut contenir jusqu'à 1 000 fichiers, et chacun est vérifié de bout en bout par une empreinte SHA-256, de sorte que ce qui arrive sur le disque est identique octet pour octet à ce que vous avez envoyé.",
      ],
      bullets: [
        "Chrome ou Edge sur l'ordinateur qui reçoit : les fichiers sont diffusés directement sur le disque, il n'y a donc pratiquement aucune limite de taille.",
        "Firefox et Safari n'ont pas l'API File System Access : un lot reçu en temps réel y tient en mémoire — Relayium prévient au-delà d'environ 256 Mo, une estimation volontairement prudente et non une limite ferme.",
        "Jusqu'à 1 000 fichiers par lot, chacun vérifié à l'arrivée par sa propre empreinte SHA-256.",
      ],
    },
    {
      heading: "Reprendre plutôt que recommencer",
      body: [
        "Les gros transferts prennent du temps, et c'est pendant ce temps que le Wi-Fi lâche, que les ordinateurs se mettent en veille et que les téléphones changent de réseau. Relayium est conçu pour cela : si la connexion se rompt en cours de route, le transfert reprend là où il s'était arrêté au lieu de recommencer tout le fichier.",
        "La connectivité est gérée de la même façon. Sur un même réseau, le transfert se fait directement d'appareil à appareil ; entre réseaux, le flux chiffré passe par un relais TURN. Le relais ne voit que du texte chiffré, si bien que cette voie reste elle aussi chiffrée de bout en bout.",
      ],
    },
    {
      heading: "Envoyer maintenant, ou laisser un lien pour plus tard",
      body: [
        "Le transfert en temps réel exige que les deux personnes soient en ligne en même temps, ce qui est idéal quand vous pouvez vous coordonner. Si l'autre personne n'est pas disponible, vous pouvez créer un lien de téléchargement stocké.",
        "Un lien stocké est à divulgation nulle : votre navigateur chiffre les fichiers en AES-256-GCM avant l'envoi et la clé de déchiffrement ne vit que dans le fragment de l'URL, de sorte que le serveur conserve un texte chiffré qu'il ne peut pas lire. Ayez les compromis en tête — créer un lien exige que l'expéditeur se connecte, les liens comptent dans un quota de stockage et expirent (ou peuvent s'autodétruire après le premier téléchargement). Un point où la voie du lien fait mieux : sa page de téléchargement peut diffuser un fichier unique sur le disque via un service worker, même dans Firefox et Safari, si bien que la mémoire du navigateur qui reçoit n'y est pas la contrainte. Pour les plus gros fichiers, quand vous pouvez tous deux être en ligne, la voie en temps réel reste l'option la plus nette.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Quelle est la taille maximale d'un fichier que je peux envoyer ?",
        a: "En mode temps réel, il n'y a aucune limite côté serveur — le plafond vient du navigateur qui reçoit. Sur un Chrome ou Edge de bureau, le fichier est diffusé sur le disque, vous pouvez donc envoyer des dizaines de gigaoctets sans manquer de mémoire. Firefox et Safari n'ont pas l'API File System Access : ce qu'ils reçoivent est assemblé en mémoire, et Relayium prévient au-delà d'environ 256 Mo — une estimation prudente plutôt qu'un plafond mesuré, le vrai dépendant de la mémoire de l'appareil, de son système et de ce qui est ouvert par ailleurs.",
      },
      {
        q: "Que se passe-t-il si le transfert est interrompu ?",
        a: "Il reprend automatiquement. Si la connexion se coupe en cours de transfert — un signal Wi-Fi perdu, un ordinateur en veille, un changement de réseau — Relayium repart de là où il s'était arrêté au lieu de recommencer tout le fichier, de sorte qu'un long transfert n'est pas perdu pour un bref incident.",
      },
      {
        q: "Comment ma vie privée est-elle protégée pour les gros fichiers ?",
        a: "Les transferts en temps réel utilisent X25519 et AES-256-GCM par bloc de bout en bout ; la clé n'atteint aucun serveur. Avec la vérification avancée activée (désactivée par défaut), les deux appareils affichent un code à 6 chiffres, et chaque fichier est vérifié par SHA-256. WebRTC est direct sur le même LAN ; entre réseaux, les navigateurs utilisent TURN par conception, et le relais ne transporte que du texte chiffré qu'il ne peut ni lire ni déchiffrer.",
      },
    ],
  },
  cta: {
    text: "Déplacez votre prochain fichier de plusieurs gigaoctets en temps réel — sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "كيفية إرسال الملفات الكبيرة دون سحابة",
  description:
    "أرسِل مقاطع فيديو وأرشيفات بحجم عدة غيغابايت حيًا بين المتصفحات: يتصل WebRTC مباشرةً داخل شبكة LAN نفسها، ويحمل TURN النص المشفّر من الطرف إلى الطرف عبر الشبكات، بلا نسخة محتوى أو سجل فوري على الخادم.",
  updatedLabel: "آخر تحديث",
  lead: [
    "تصدير فيديو بحجم 20 غيغابايت أو أرشيف مشروع ثقيل هو تحديدًا حيث يبدو تخزين السحابة أبطأ ما يكون: ترفع الملف كاملًا مرة، تنتظر، ثم ينزّله الطرف الآخر مجددًا — نقلتان كاملتان زائد ما تسمح به حصة التخزين لديك. لتسليم لمرة واحدة، هذا كمٌّ كبير من النسخ والانتظار لبايتات لم تكن بحاجة إلا للانتقال من أ إلى ب.",
    "يبث Relayium الملف حيًا بدل رفعه لتنزيله لاحقًا. داخل شبكة LAN نفسها يتصل WebRTC مباشرةً؛ وعبر الشبكات تستخدم جلسات المتصفح TURN حسب التصميم لنقل نص مشفّر من الطرف إلى الطرف لا يستطيع المُرحِّل قراءته أو فك تشفيره. لا يخزن Relayium محتوى فوريًا أو سجل نقل. ويشرح هذا الدليل أيضًا حدود أحجام المتصفحات وضرورة اتصال الطرفين عادةً في الوقت نفسه.",
  ],
  sections: [
    {
      heading: "لماذا يفوز النقل المباشر للملفات الكبيرة",
      body: [
        "يرفع التخزين السحابي الملف الكبير للاحتفاظ به ثم يُنزّله لاحقًا، ويستهلك حصة تخزين. أما مسار Relayium الفوري فيبث باستمرار: يتصل WebRTC مباشرةً داخل شبكة LAN نفسها، وعبر الشبكات تنقل المتصفحات النص المشفّر من الطرف إلى الطرف عبر TURN. وفي الحالتين لا تبقى نسخة محتوى أو سجل فوري على الخادم.",
        "يعمل Relayium كليًا داخل المتصفح، فلا شيء لتثبيته على أي من الطرفين. يعمل على Windows وmacOS وLinux وAndroid وiOS. على نفس الشبكة لا يحتاج النقل الفوري إلى حساب؛ والإرسال عبر الشبكات برمز اقتران يطلب من المُرسِل فقط تسجيل الدخول — ما عليك إلا فتح relayium.com على كلا الجهازين والاتصال.",
      ],
    },
    {
      heading: "لا سقف للحجم في الوضع الفوري",
      body: [
        "لا يملك النقل الفوري حدًا لحجم التخزين على الخادم لأن Relayium لا يحتفظ بنسخة من المحتوى. قد يحمل مُرحِّل TURN النص المشفّر عبر الشبكات أثناء اتصال الطرفين، لكنه لا يستطيع قراءته أو فك تشفيره أو الاحتفاظ به كسجل نقل. السقف العملي يحدده المتصفح المستقبِل.",
        "على Chrome وEdge يُبَثّ الملف الوارد مباشرةً إلى القرص فور وصوله، فلا يحتاج أبدًا إلى أن يتّسع له في الذاكرة — هذه هي التركيبة التي تُستخدَم للملفات الكبيرة جدًا، وصولًا بأريحية إلى عشرات الغيغابايت. يمكن أن تضم الدفعة حتى 1,000 ملف، ويُتحقَّق من كلٍّ منها من الطرف إلى الطرف بتجزئة SHA-256، فما يحطّ على القرص مطابق بايتًا ببايت لما أرسلته.",
      ],
      bullets: [
        "Chrome أو Edge على حاسوب الطرف المستقبِل: تُبَثّ الملفات مباشرةً إلى القرص، فلا يوجد عمليًا سقف للحجم.",
        "أما Firefox وSafari فلا تملكان واجهة File System Access، فتبقى الدفعة المستلمة فوريًا في الذاكرة — وينبّهك Relayium فوق نحو 256 ميغابايت، وهو تقدير متحفّظ عن قصد لا حدٌّ صارم.",
        "حتى 1,000 ملف لكل دفعة، يُفحَص كلٌّ منها بتجزئة SHA-256 خاصة به عند الوصول.",
      ],
    },
    {
      heading: "الاستئناف بدلًا من البدء من جديد",
      body: [
        "النقلات الكبيرة تستغرق وقتًا، والوقت هو حين ينقطع Wi-Fi، وتخلد الحواسيب المحمولة إلى السكون، وتبدّل الهواتف الشبكات. صُمِّم Relayium لذلك: إذا انقطع الاتصال في منتصف الطريق، يستأنف النقل من حيث توقف بدلًا من إعادة الملف كاملًا من البداية.",
        "تُعالَج الاتصالية بالطريقة نفسها. داخل الشبكة الواحدة يجري النقل من الند للند مباشرةً؛ وعبر الشبكات يمرّ التدفق المشفَّر على مُرحِّل TURN. لا يرى المُرحِّل سوى نص مُشفَّر، فيبقى هذا المسار أيضًا مشفَّرًا من الطرف إلى الطرف.",
      ],
    },
    {
      heading: "أرسِل الآن، أو اترك رابطًا للاحقًا",
      body: [
        "يحتاج النقل الفوري إلى أن يكون الطرفان متصلين في الوقت نفسه، وهو مثالي حين يمكنك التنسيق. إذا لم يكن الطرف الآخر متاحًا الآن، يمكنك بدلًا من ذلك إنشاء رابط تنزيل مُخزَّن.",
        "الرابط المُخزَّن ذو معرفة صفرية: يشفّر متصفحك الملفات بـ AES-256-GCM قبل الرفع، ويعيش مفتاح فك التشفير في جزء الـ URL فقط، فيحتفظ الخادم بنص مُشفَّر لا يمكنه قراءته. كن واعيًا للمقايضات — إنشاء رابط يتطلب من المُرسِل تسجيل الدخول، والروابط تُحتسَب على حصة تخزين، وتنتهي صلاحيتها (أو يمكن أن تُمحى بعد أول تنزيل). ولمسار الرابط ميزة واحدة يتفوق بها: صفحة التنزيل الخاصة به تستطيع بثّ ملف واحد إلى القرص عبر عامل خدمة (service worker) حتى في Firefox وSafari، فلا تكون ذاكرة المتصفح المستقبِل هي القيد هناك. أما لأكبر الملفات، حين يمكنكما أن تكونا متصلين معًا، فيبقى المسار الفوري الخيار الأنظف.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "ما أكبر ملف يمكنني إرساله؟",
        a: "في الوضع الفوري لا يوجد حد من جهة الخادم — يأتي السقف من المتصفح المستقبِل. على Chrome أو Edge في الحاسوب يُبَثّ الملف إلى القرص، فيمكنك إرسال عشرات الغيغابايت دون نفاد الذاكرة. أما Firefox وSafari فتنقصهما واجهة File System Access، فيُجمَّع ما يستقبلانه في الذاكرة، وينبّهك Relayium فوق نحو 256 ميغابايت — وهو تقدير متحفّظ لا سقف مقيس، إذ يتوقف السقف الحقيقي على ذاكرة الجهاز ونظامه وما هو مفتوح غير ذلك.",
      },
      {
        q: "ماذا يحدث إذا قُوطِع النقل؟",
        a: "يستأنف تلقائيًا. إذا انقطع الاتصال في منتصف النقل — إشارة Wi-Fi متقطعة، حاسوب محمول نائم، تبديل شبكة — يلتقط Relayium من حيث توقف بدلًا من إعادة الملف كاملًا، فلا يضيع نقل طويل بسبب عثرة عابرة.",
      },
      {
        q: "كيف تُحمى خصوصيتي للملفات الكبيرة؟",
        a: "النقل الفوري مشفّر من الطرف إلى الطرف عبر X25519 وAES-256-GCM لكل كتلة، ولا يصل المفتاح إلى أي خادم. وعند تفعيل التحقّق المتقدّم (المعطَّل افتراضيًا) يعرض الجهازان رمزًا من 6 أرقام، ويُفحص كل ملف بـ SHA-256. يتصل WebRTC مباشرةً داخل شبكة LAN نفسها؛ وعبر الشبكات تستخدم المتصفحات TURN حسب التصميم، ولا يحمل المُرحِّل إلا نصًا مشفّرًا لا يستطيع قراءته أو فك تشفيره.",
      },
    ],
  },
  cta: {
    text: "انقل ملفك التالي بحجم عدة غيغابايت في الوقت الفعلي — دون تثبيت، ودون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Cómo enviar archivos grandes sin la nube",
  description:
    "Envía en vivo vídeos y archivos de varios gigabytes entre navegadores: WebRTC es directo en la misma LAN, TURN transporta texto cifrado de extremo a extremo entre redes, sin copia ni historial de contenido en tiempo real del lado del servidor.",
  updatedLabel: "Última actualización",
  lead: [
    "Una exportación de vídeo de 20 GB o un pesado archivo de proyecto es justo donde el almacenamiento en la nube se siente más lento: subes el archivo entero una vez, esperas y luego la otra persona lo descarga de nuevo — dos transferencias completas más lo que permita tu cuota de almacenamiento. Para una entrega única, es mucho copiar y esperar por bytes que solo tenían que ir de A a B.",
    "Relayium transmite el archivo en vivo en vez de subirlo para descargarlo después. En la misma LAN, WebRTC conecta directamente; entre redes, los navegadores usan TURN por diseño para transportar texto cifrado de extremo a extremo que el retransmisor no puede leer ni descifrar. Relayium no almacena contenido ni historial en tiempo real. Esta guía también cubre los límites de tamaño del navegador y por qué ambas personas suelen necesitar estar en línea a la vez.",
  ],
  sections: [
    {
      heading: "Por qué la transferencia directa gana con archivos grandes",
      body: [
        "El almacenamiento en la nube sube un archivo grande para guardarlo y lo descarga después, ocupando una cuota. La vía en tiempo real de Relayium transmite de forma continua: WebRTC es directo en la misma LAN, mientras que entre redes los navegadores pasan texto cifrado de extremo a extremo por TURN. En ambos casos no queda copia de contenido ni historial en tiempo real del lado del servidor.",
        "Relayium funciona por completo en el navegador, así que no hay nada que instalar en ninguno de los dos extremos. Funciona en Windows, macOS, Linux, Android e iOS. En la misma red las transferencias en tiempo real no necesitan cuenta; enviar entre redes con un código de emparejamiento solo pide al remitente iniciar sesión — basta con abrir relayium.com en ambos dispositivos y conectar.",
      ],
    },
    {
      heading: "Sin límite de tamaño en modo en tiempo real",
      body: [
        "Las transferencias en tiempo real no tienen límite de almacenamiento del lado del servidor porque Relayium no conserva una copia del contenido. Un retransmisor TURN puede transportar texto cifrado entre redes mientras ambos lados están conectados, pero no puede leerlo, descifrarlo ni guardarlo como historial. El tope práctico lo fija el navegador que recibe.",
        "En Chrome y Edge el archivo entrante se transmite directamente al disco a medida que llega, así que nunca tiene que caber en memoria — esta es la combinación que conviene usar para archivos muy grandes, cómodamente hasta decenas de gigabytes. Un lote puede contener hasta 1.000 archivos, y cada uno se verifica de extremo a extremo con un hash SHA-256, así que lo que llega al disco es byte por byte lo que enviaste.",
      ],
      bullets: [
        "Chrome o Edge en el ordenador que recibe: los archivos se transmiten directamente al disco, así que prácticamente no hay límite de tamaño.",
        "Firefox y Safari no tienen la API File System Access, así que ahí un lote recibido en tiempo real se mantiene en memoria — Relayium avisa por encima de unos 256 MB, una estimación deliberadamente prudente y no un límite duro.",
        "Hasta 1.000 archivos por lote, cada uno verificado con su propio hash SHA-256 al llegar.",
      ],
    },
    {
      heading: "Reanudar en lugar de empezar de nuevo",
      body: [
        "Las transferencias grandes llevan tiempo, y el tiempo es cuando se cae el Wi-Fi, los portátiles se suspenden y los teléfonos cambian de red. Relayium está hecho para eso: si la conexión se rompe a mitad de camino, la transferencia se reanuda desde donde quedó en lugar de empezar el archivo entero de nuevo.",
        "La conectividad se maneja de la misma forma. Dentro de una misma red la transferencia va directamente de dispositivo a dispositivo; entre redes, el flujo cifrado viaja por un retransmisor TURN. El retransmisor solo ve texto cifrado, así que esa vía también sigue cifrada de extremo a extremo.",
      ],
    },
    {
      heading: "Envía ahora, o deja un enlace para después",
      body: [
        "La transferencia en tiempo real necesita a ambas personas en línea al mismo tiempo, lo cual es ideal cuando puedes coordinarte. Si la otra persona no está disponible ahora mismo, puedes crear un enlace de descarga almacenado.",
        "Un enlace almacenado es de conocimiento cero: tu navegador cifra los archivos con AES-256-GCM antes de subirlos y la clave de descifrado vive solo en el fragmento de la URL, así que el servidor guarda texto cifrado que no puede leer. Ten presentes las concesiones — crear un enlace requiere que el remitente inicie sesión, los enlaces se descuentan de una cuota de almacenamiento y caducan (o pueden autodestruirse tras la primera descarga). Hay algo que la vía del enlace hace mejor: su página de descarga puede transmitir un solo archivo al disco mediante un service worker incluso en Firefox y Safari, así que ahí la memoria del navegador que recibe no es la restricción. Para los archivos más grandes, cuando ambos lados pueden estar en línea, la vía en tiempo real sigue siendo la opción más limpia.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Cuál es el archivo más grande que puedo enviar?",
        a: "En modo en tiempo real no hay límite del lado del servidor — el tope viene del navegador que recibe. En un Chrome o Edge de escritorio el archivo se transmite al disco, así que puedes enviar decenas de gigabytes sin quedarte sin memoria. Firefox y Safari carecen de la API File System Access, así que lo que reciben se acumula en memoria y Relayium avisa por encima de unos 256 MB — una estimación prudente más que un techo medido, ya que el real depende de la memoria del dispositivo, de su sistema y de qué más esté abierto.",
      },
      {
        q: "¿Qué pasa si la transferencia se interrumpe?",
        a: "Se reanuda automáticamente. Si la conexión se cae a mitad de la transferencia — una señal Wi-Fi perdida, un portátil suspendido, un cambio de red — Relayium retoma desde donde se detuvo en vez de reiniciar el archivo entero, así que una transferencia larga no se pierde por un breve tropiezo.",
      },
      {
        q: "¿Cómo se protege mi privacidad con archivos grandes?",
        a: "Las transferencias en tiempo real usan X25519 y AES-256-GCM por bloque de extremo a extremo; la clave no llega a ningún servidor. Con la verificación avanzada activada (desactivada por omisión), ambos dispositivos muestran un código de 6 dígitos, y cada archivo se verifica con SHA-256. WebRTC es directo en la misma LAN; entre redes, los navegadores usan TURN por diseño y el retransmisor solo transporta texto cifrado que no puede leer ni descifrar.",
      },
    ],
  },
  cta: {
    text: "Mueve tu próximo archivo de varios gigabytes en tiempo real — sin instalación, y sin necesidad de cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Como enviar arquivos grandes sem a nuvem",
  description:
    "Envie ao vivo vídeos e arquivos de vários gigabytes entre navegadores: o WebRTC é direto na mesma LAN, o TURN transporta texto cifrado de ponta a ponta entre redes, sem cópia nem histórico de conteúdo em tempo real no servidor.",
  updatedLabel: "Última atualização",
  lead: [
    "Uma exportação de vídeo de 20 GB ou um arquivo de projeto pesado é exatamente onde o armazenamento em nuvem parece mais lento: você faz upload do arquivo inteiro uma vez, espera e a outra pessoa faz o download de novo — duas transferências completas mais o que sua cota de armazenamento permitir. Para uma entrega única, é muita cópia e espera por bytes que só precisavam ir de A para B.",
    "O Relayium transmite o arquivo ao vivo em vez de fazer upload para download posterior. Na mesma LAN, o WebRTC conecta diretamente; entre redes, os navegadores usam TURN por design para transportar texto cifrado de ponta a ponta que o retransmissor não consegue ler nem descriptografar. O Relayium não armazena conteúdo nem histórico em tempo real. Este guia também cobre os limites de tamanho do navegador e por que as duas pessoas normalmente precisam estar online juntas.",
  ],
  sections: [
    {
      heading: "Por que a transferência direta vence para arquivos grandes",
      body: [
        "O armazenamento em nuvem envia um arquivo grande para guardá-lo e o baixa depois, ocupando uma cota. O caminho em tempo real do Relayium transmite continuamente: o WebRTC é direto na mesma LAN, enquanto entre redes os navegadores passam texto cifrado de ponta a ponta pelo TURN. Nos dois casos não fica cópia de conteúdo nem histórico em tempo real no servidor.",
        "O Relayium roda inteiramente no navegador, então não há nada para instalar em nenhuma das pontas. Funciona no Windows, macOS, Linux, Android e iOS. Na mesma rede, as transferências em tempo real não precisam de conta; enviar entre redes com um código de emparelhamento só pede que o remetente faça login — basta abrir o relayium.com nos dois dispositivos e conectar.",
      ],
    },
    {
      heading: "Sem limite de tamanho no modo em tempo real",
      body: [
        "As transferências em tempo real não têm limite de armazenamento do lado do servidor porque o Relayium não mantém uma cópia do conteúdo. Um retransmissor TURN pode transportar texto cifrado entre redes enquanto os dois lados estão online, mas não consegue ler, descriptografar ou guardá-lo como histórico. O teto prático é definido pelo navegador que recebe.",
        "No Chrome e no Edge, o arquivo que chega é transmitido direto para o disco à medida que chega, então nunca precisa caber na memória — essa é a combinação a usar para arquivos muito grandes, tranquilamente na casa das dezenas de gigabytes. Um lote pode conter até 1.000 arquivos, e cada um é verificado de ponta a ponta com um hash SHA-256, então o que pousa no disco é byte a byte o que você enviou.",
      ],
      bullets: [
        "Chrome ou Edge no computador que recebe: os arquivos são transmitidos direto para o disco, então praticamente não há limite de tamanho.",
        "Firefox e Safari não têm a API File System Access, então neles um lote recebido em tempo real fica na memória — o Relayium avisa acima de cerca de 256 MB, uma estimativa propositalmente conservadora e não um limite rígido.",
        "Até 1.000 arquivos por lote, cada um conferido com seu próprio hash SHA-256 na chegada.",
      ],
    },
    {
      heading: "Retomar em vez de recomeçar",
      body: [
        "Transferências grandes levam tempo, e o tempo é quando o Wi-Fi cai, os notebooks entram em suspensão e os celulares trocam de rede. O Relayium foi feito para isso: se a conexão se romper no meio do caminho, a transferência retoma de onde parou em vez de recomeçar o arquivo inteiro.",
        "A conectividade é tratada da mesma forma. Dentro de uma mesma rede a transferência vai direto de dispositivo para dispositivo; entre redes, o fluxo criptografado viaja por um retransmissor TURN. O retransmissor só vê texto cifrado, então esse caminho também permanece criptografado de ponta a ponta.",
      ],
    },
    {
      heading: "Envie agora ou deixe um link para depois",
      body: [
        "A transferência em tempo real precisa das duas pessoas online ao mesmo tempo, o que é ideal quando dá para coordenar. Se a outra pessoa não estiver disponível agora, você pode criar um link de download armazenado.",
        "Um link armazenado é de conhecimento zero: seu navegador criptografa os arquivos com AES-256-GCM antes do upload e a chave de descriptografia vive apenas no fragmento da URL, então o servidor guarda texto cifrado que não consegue ler. Tenha em mente as concessões — criar um link exige que o remetente faça login, os links contam contra uma cota de armazenamento e expiram (ou podem se autodestruir após o primeiro download). Há algo em que o caminho do link é melhor: sua página de download consegue transmitir um único arquivo para o disco por meio de um service worker mesmo no Firefox e no Safari, então ali a memória do navegador que recebe não é a restrição. Para os maiores arquivos, quando os dois conseguem ficar online, o caminho em tempo real continua sendo a opção mais limpa.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Qual é o maior arquivo que posso enviar?",
        a: "No modo em tempo real não há limite do lado do servidor — o teto vem do navegador que recebe. Em um Chrome ou Edge de computador o arquivo é transmitido para o disco, então você pode enviar dezenas de gigabytes sem ficar sem memória. Firefox e Safari não têm a API File System Access, então o que eles recebem é montado na memória, e o Relayium avisa acima de cerca de 256 MB — uma estimativa conservadora e não um teto medido, já que o real depende da memória do aparelho, do sistema e do que mais estiver aberto.",
      },
      {
        q: "O que acontece se a transferência for interrompida?",
        a: "Ela retoma automaticamente. Se a conexão cair no meio da transferência — um sinal de Wi-Fi perdido, um notebook em suspensão, uma troca de rede — o Relayium retoma de onde parou em vez de reiniciar o arquivo inteiro, então uma transferência longa não se perde por causa de um tropeço rápido.",
      },
      {
        q: "Como minha privacidade é protegida em arquivos grandes?",
        a: "As transferências em tempo real usam X25519 e AES-256-GCM por bloco de ponta a ponta; a chave não chega a nenhum servidor. Com a verificação avançada ativada (desligada por padrão), os dois dispositivos mostram um código de 6 dígitos, e cada arquivo é verificado com SHA-256. O WebRTC é direto na mesma LAN; entre redes, os navegadores usam TURN por design e o retransmissor só transporta texto cifrado que não consegue ler nem descriptografar.",
      },
    ],
  },
  cta: {
    text: "Mova seu próximo arquivo de vários gigabytes em tempo real — sem instalação e sem precisar de conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/send-large-files-without-cloud",
  published: "2026-07-03",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
