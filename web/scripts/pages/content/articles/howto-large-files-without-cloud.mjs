// web/scripts/pages/content/articles/howto-large-files-without-cloud.mjs
// How-to: send large files (multi-GB video / project archives) without the cloud.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "How to send large files without the cloud",
  description:
    "Send multi-gigabyte videos and project archives directly, browser to browser — no cloud upload, no size cap in realtime mode, with resumable transfers and per-file integrity checks.",
  updatedLabel: "Last updated",
  lead: [
    "A 20 GB video export or a heavy project archive is exactly where cloud storage feels slowest: you upload the whole file once, wait, then the other person downloads it again — two full transfers plus whatever your storage quota allows. For a one-time hand-off, that is a lot of copying and waiting for bytes that only ever needed to go from A to B.",
    "Relayium takes the direct route. The file streams straight from your browser to the recipient's over an encrypted peer-to-peer channel, so it never lands on a server in between. This guide shows how to move big files that way, and is honest about the two real limits: which browsers can handle unlimited sizes, and the fact that both people usually need to be online at the same time.",
  ],
  sections: [
    {
      heading: "Why direct transfer wins for big files",
      body: [
        "With cloud storage a large file crosses the network twice — up to the server, then back down to the recipient — and sits against a storage quota in between. A direct peer-to-peer transfer crosses the network once, from sender to receiver, with nothing stored in the middle.",
        "Relayium runs entirely in the browser, so there is nothing to install on either end. It works on Windows, macOS, Linux, Android and iOS, and realtime transfers need no account — you just open relayium.com on both devices and connect.",
      ],
    },
    {
      heading: "No size cap in realtime mode",
      body: [
        "Realtime transfers have no server-side size limit, because there is no server holding the file. The practical ceiling is set by the receiving browser, not by us.",
        "On Chrome and Edge the incoming file is streamed straight to disk as it arrives, so it never has to fit in memory — this is the combination to use for very large files, comfortably into the tens of gigabytes. A batch can hold up to 10 files, and each one is verified end-to-end with a SHA-256 hash, so what lands on disk is byte-for-byte what you sent.",
      ],
      bullets: [
        "Chrome or Edge on the receiving side: files stream to disk, so there is effectively no size cap.",
        "Firefox and Safari buffer the file in memory instead, so keep individual files under about 200 MB there.",
        "Up to 10 files per batch, each checked with its own SHA-256 hash on arrival.",
      ],
    },
    {
      heading: "Resume instead of restarting",
      body: [
        "Big transfers take time, and time is when Wi-Fi drops, laptops sleep, and phones switch networks. Relayium is built for that: if the connection breaks partway through, the transfer resumes from where it left off instead of starting the whole file over.",
        "Connectivity is handled the same way. The transfer goes directly peer-to-peer whenever possible; when two networks cannot reach each other directly, the encrypted stream falls back to a TURN relay. The relay only ever sees ciphertext, so even the fallback path stays end-to-end encrypted.",
      ],
    },
    {
      heading: "Send now, or leave a link for later",
      body: [
        "Realtime direct transfer needs both people online at the same time, which is ideal when you can coordinate — a call, a shared moment, a colleague at their desk. If the other person is not available right now, you can create a stored download link instead.",
        "A stored link is zero-knowledge: your browser encrypts the files with AES-256-GCM before upload and the decryption key lives only in the URL fragment, so the server keeps ciphertext it cannot read. Be aware of the trade-offs — creating a link requires the sender to sign in, links count against a storage quota, and they expire (or can burn after the first download). For the biggest files, when you can both be online, the realtime path stays the cleanest option.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "What is the largest file I can send?",
        a: "In realtime mode there is no server-side limit — the cap comes from the receiving browser. On Chrome or Edge the file streams to disk, so you can send tens of gigabytes without running out of memory. On Firefox or Safari the file is buffered in memory, so keep individual files under about 200 MB on those browsers.",
      },
      {
        q: "What happens if the transfer is interrupted?",
        a: "It resumes automatically. If the connection drops mid-transfer — a dropped Wi-Fi signal, a sleeping laptop, a network switch — Relayium picks up from where it stopped rather than restarting the whole file, so a long transfer is not lost to a brief hiccup.",
      },
      {
        q: "How is my privacy protected for large files?",
        a: "Realtime transfers are end-to-end encrypted with an X25519 key exchange and per-chunk AES-256-GCM, and that key never reaches any server. Both devices show a 6-digit verification code to confirm no one is in the middle, and each file is checked with a SHA-256 hash. Even when a TURN relay is needed, it only sees ciphertext.",
      },
    ],
  },
  cta: {
    text: "Move your next multi-gigabyte file the direct way — no install, and no account for realtime transfers.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何不用网盘传输大文件",
  description:
    "把几 GB 的视频和工程文件在浏览器之间直接互传——无需上传网盘，实时模式没有大小上限，支持断点续传和逐文件完整性校验。",
  updatedLabel: "最近更新",
  lead: [
    "一个 20 GB 的视频导出，或者一个沉重的工程压缩包，恰恰是网盘最慢的场景：你先把整个文件上传一遍、等待，然后对方再下载一遍——两次完整传输，还要受制于你的存储配额。对一次性的交付来说，只是想把字节从 A 送到 B，却要这样反复复制和等待。",
    "Relayium 走的是直连的路。文件通过加密的点对点通道从你的浏览器直接流向对方，中途从不落在任何服务器上。本文讲的就是这样传大文件的做法，同时也如实说明两个真实的限制：哪些浏览器能承受无上限的大小，以及双方通常需要同时在线这件事。",
  ],
  sections: [
    {
      heading: "大文件为什么直连更划算",
      body: [
        "用网盘时，一个大文件要两次跨越网络——先上传到服务器，再下载到对方——中间还占着存储配额。而点对点直连只跨越网络一次，从发送方直达接收方，中途什么都不存。",
        "Relayium 完全在浏览器里运行，两端都无需安装任何软件。它支持 Windows、macOS、Linux、Android 和 iOS，实时传输也无需账号——只要两台设备都打开 relayium.com 连上即可。",
      ],
    },
    {
      heading: "实时模式没有大小上限",
      body: [
        "实时传输没有服务器端的大小限制，因为根本没有服务器在保存文件。实际的上限由接收端的浏览器决定，而不是由我们决定。",
        "在 Chrome 和 Edge 上，进入的文件会随着到达即时流式写入磁盘，因此从不需要装进内存——这正是传超大文件该用的组合，轻松到几十 GB。每批最多可放 10 个文件，每个都用 SHA-256 做端到端校验，所以落到磁盘上的与你发出的逐字节一致。",
      ],
      bullets: [
        "接收端用 Chrome 或 Edge：文件流式写盘，因此实际上没有大小上限。",
        "Firefox 和 Safari 会改用内存缓冲，所以在这两个浏览器上，单个文件请控制在约 200 MB 以内。",
        "每批最多 10 个文件，每个到达时都用各自的 SHA-256 校验。",
      ],
    },
    {
      heading: "断点续传，而非重来",
      body: [
        "大文件传输耗时，而耗时正是 Wi-Fi 断线、笔记本休眠、手机切换网络最容易发生的时候。Relayium 就是为此而生：如果连接中途断开，传输会从中断处续传，而不是把整个文件从头再来。",
        "连通性也以同样的方式处理。只要条件允许，传输就点对点直连；当两个网络无法直接互达时，加密数据流会退回到 TURN 中继。中继只能看到密文，因此即便是兜底路径也保持端到端加密。",
      ],
    },
    {
      heading: "现在就传，或留个链接稍后取",
      body: [
        "实时直传需要双方同时在线，这在能协调的时候最理想——一通电话、一个共处的时刻、一位就在工位上的同事。如果对方此刻不在，你可以改为创建一个存储下载链接。",
        "存储链接是零知识的：浏览器在上传前用 AES-256-GCM 加密文件，解密密钥只存在于 URL 片段里，服务器只保存它读不懂的密文。也要清楚其中的取舍——生成链接需要发送方登录，链接会占用存储配额，并且会过期（也可以设置为首次下载后即焚）。对于最大的文件，只要双方都能在线，实时路径始终是最干净的选择。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "最大能传多大的文件？",
        a: "实时模式没有服务器端限制——上限来自接收端的浏览器。在 Chrome 或 Edge 上，文件会流式写入磁盘，因此可以传几十 GB 而不会耗尽内存。在 Firefox 或 Safari 上，文件会在内存中缓冲，所以在这两个浏览器上请把单个文件控制在约 200 MB 以内。",
      },
      {
        q: "传输中断了怎么办？",
        a: "会自动续传。如果传输中途断开——Wi-Fi 掉线、笔记本休眠、切换网络——Relayium 会从停下的地方接着传，而不是把整个文件从头再来，所以一次长传不会因短暂的波动而前功尽弃。",
      },
      {
        q: "传大文件时隐私如何保证？",
        a: "实时传输用 X25519 密钥交换加逐块 AES-256-GCM 做端到端加密，而这把密钥从不抵达任何服务器。两台设备会显示 6 位校验码以确认没有中间人，每个文件都用 SHA-256 校验。即便需要 TURN 中继，它也只能看到密文。",
      },
    ],
  },
  cta: {
    text: "用直连的方式传下一个几 GB 的大文件——无需安装，实时传输也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "クラウドを使わずに大きなファイルを送る方法",
  description:
    "数ギガバイトの動画やプロジェクトのアーカイブを、ブラウザからブラウザへ直接送信。クラウドへのアップロード不要、リアルタイムモードではサイズ上限なし、再開可能な転送とファイルごとの整合性チェック付き。",
  updatedLabel: "最終更新",
  lead: [
    "20 GB の動画書き出しや重いプロジェクトのアーカイブは、まさにクラウドストレージが最も遅く感じる場面です。ファイル全体を一度アップロードして待ち、相手がもう一度ダウンロードする——2回の完全な転送に加え、ストレージ容量の制限も受けます。一度きりの受け渡しなのに、A から B へ送るだけのバイトのために、これだけの複製と待ち時間がかかります。",
    "Relayium は直接の経路を取ります。ファイルは暗号化された P2P チャネルであなたのブラウザから相手のブラウザへ直接流れ、途中でサーバーに置かれることはありません。本ガイドではその方法で大きなファイルを送る手順を示し、2つの現実的な制限についても正直にお伝えします。どのブラウザが無制限のサイズに対応できるか、そして通常は双方が同時にオンラインである必要がある、という点です。",
  ],
  sections: [
    {
      heading: "大きなファイルで直接転送が有利な理由",
      body: [
        "クラウドストレージでは大きなファイルがネットワークを2回横断します——サーバーへアップロードし、相手へダウンロードで——その間ストレージ容量も消費します。P2P の直接転送はネットワークを1回だけ、送信者から受信者へ横断し、途中には何も保存しません。",
        "Relayium は完全にブラウザ内で動作するため、どちらの端末にもインストールは不要です。Windows、macOS、Linux、Android、iOS で動き、リアルタイム転送にアカウントは要りません——両方の端末で relayium.com を開いて接続するだけです。",
      ],
    },
    {
      heading: "リアルタイムモードにはサイズ上限がない",
      body: [
        "リアルタイム転送にはサーバー側のサイズ制限がありません。ファイルを保持するサーバーが存在しないからです。実際の上限は受信側のブラウザが決めるもので、私たちが決めるものではありません。",
        "Chrome と Edge では、届いたファイルは到着に合わせてそのままディスクへストリーミングされるため、メモリに収める必要がありません——これが非常に大きなファイルに使うべき組み合わせで、数十 GB まで余裕です。1バッチには最大10ファイルを入れられ、それぞれが SHA-256 ハッシュでエンドツーエンドに検証されるので、ディスクに残るものは送ったものとバイト単位で同一です。",
      ],
      bullets: [
        "受信側が Chrome または Edge：ファイルはディスクへストリーミングされるため、実質的にサイズ上限はありません。",
        "Firefox と Safari は代わりにファイルをメモリにバッファするため、そこでは個々のファイルを約 200 MB 以内に抑えてください。",
        "1バッチ最大10ファイル、それぞれ到着時に固有の SHA-256 ハッシュで検証されます。",
      ],
    },
    {
      heading: "最初からではなく再開する",
      body: [
        "大きな転送には時間がかかり、その時間こそ Wi-Fi が切れ、ノートPCがスリープし、スマホがネットワークを切り替える瞬間です。Relayium はそれに備えて作られています。途中で接続が切れても、転送はファイル全体をやり直すのではなく、止まった所から再開します。",
        "接続性も同じように扱われます。可能な限り転送は P2P で直接行われ、2つのネットワークが直接到達できないときは、暗号化ストリームが TURN リレーにフォールバックします。リレーが見るのは暗号文だけなので、フォールバックの経路でもエンドツーエンド暗号化のままです。",
      ],
    },
    {
      heading: "今すぐ送る、または後で取れるリンクを残す",
      body: [
        "リアルタイムの直接転送は双方が同時にオンラインであることが必要で、都合を合わせられるときに最適です——通話中、共有の瞬間、席にいる同僚。相手が今いない場合は、代わりに保存型のダウンロードリンクを作成できます。",
        "保存リンクはゼロ知識です。ブラウザがアップロード前に AES-256-GCM でファイルを暗号化し、復号鍵は URL フラグメントにだけ存在するため、サーバーは読めない暗号文を保持します。トレードオフも把握してください——リンクの作成には送信側のサインインが必要で、リンクはストレージ容量を消費し、有効期限があります(初回ダウンロード後に消去する設定も可能)。最大のファイルでは、双方がオンラインになれるなら、リアルタイムの経路が常に最もすっきりした選択肢です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "送れるファイルの最大サイズは？",
        a: "リアルタイムモードにサーバー側の制限はありません——上限は受信側のブラウザ次第です。Chrome や Edge ではファイルがディスクへストリーミングされるため、メモリを使い切らずに数十 GB を送れます。Firefox や Safari ではファイルがメモリにバッファされるので、それらのブラウザでは個々のファイルを約 200 MB 以内に抑えてください。",
      },
      {
        q: "転送が中断されたらどうなりますか？",
        a: "自動的に再開します。転送の途中で接続が切れても——Wi-Fi の切断、ノートPCのスリープ、ネットワークの切り替え——Relayium はファイル全体をやり直すのではなく止まった所から続けるので、長い転送が一瞬の不調で無駄になりません。",
      },
      {
        q: "大きなファイルでプライバシーはどう守られますか？",
        a: "リアルタイム転送は X25519 の鍵交換とブロックごとの AES-256-GCM でエンドツーエンドに暗号化され、その鍵はどのサーバーにも届きません。両方の端末が6桁の検証コードを表示して間に誰もいないことを確認し、各ファイルは SHA-256 ハッシュで検証されます。TURN リレーが必要な場合でも、それが見るのは暗号文だけです。",
      },
    ],
  },
  cta: {
    text: "次の数ギガバイトのファイルを直接の方法で送りましょう——インストール不要、リアルタイム転送はアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "클라우드 없이 대용량 파일 보내는 방법",
  description:
    "수 기가바이트의 동영상과 프로젝트 아카이브를 브라우저에서 브라우저로 직접 전송하세요. 클라우드 업로드 불필요, 실시간 모드에서는 크기 제한 없음, 재개 가능한 전송과 파일별 무결성 검사 포함.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "20 GB짜리 동영상 내보내기나 무거운 프로젝트 아카이브야말로 클라우드 스토리지가 가장 느리게 느껴지는 순간입니다. 파일 전체를 한 번 업로드하고 기다린 뒤, 상대가 다시 다운로드합니다——두 번의 완전한 전송에 스토리지 할당량 제한까지 받습니다. 한 번뿐인 전달인데, A에서 B로 보내기만 하면 되는 바이트를 위해 이렇게 복사하고 기다려야 합니다.",
    "Relayium은 직접 경로를 택합니다. 파일은 암호화된 P2P 채널로 당신의 브라우저에서 상대의 브라우저로 곧장 흐르며, 중간에 어떤 서버에도 놓이지 않습니다. 이 가이드는 그 방식으로 대용량 파일을 옮기는 방법을 보여주며, 두 가지 실제 제약도 솔직하게 밝힙니다. 어떤 브라우저가 무제한 크기를 감당할 수 있는지, 그리고 보통 양쪽이 동시에 온라인이어야 한다는 점입니다.",
  ],
  sections: [
    {
      heading: "대용량 파일에 직접 전송이 유리한 이유",
      body: [
        "클라우드 스토리지에서는 대용량 파일이 네트워크를 두 번 건넙니다——서버로 업로드, 다시 상대에게 다운로드——그 사이 스토리지 할당량도 차지합니다. P2P 직접 전송은 네트워크를 한 번만, 보내는 쪽에서 받는 쪽으로 건너며 중간에 아무것도 저장하지 않습니다.",
        "Relayium은 완전히 브라우저에서 동작하므로 양쪽 모두 설치할 것이 없습니다. Windows, macOS, Linux, Android, iOS에서 작동하고 실시간 전송에는 계정이 필요 없습니다——두 기기에서 relayium.com을 열어 연결하기만 하면 됩니다.",
      ],
    },
    {
      heading: "실시간 모드에는 크기 제한이 없다",
      body: [
        "실시간 전송에는 서버 측 크기 제한이 없습니다. 파일을 담아 두는 서버가 없기 때문입니다. 실질적인 상한은 받는 쪽 브라우저가 정하며, 우리가 정하는 것이 아닙니다.",
        "Chrome과 Edge에서는 들어오는 파일이 도착하는 대로 곧바로 디스크로 스트리밍되므로 메모리에 담을 필요가 없습니다——이것이 아주 큰 파일에 써야 할 조합이며, 수십 GB까지 여유롭습니다. 한 배치에 최대 10개 파일을 담을 수 있고, 각각 SHA-256 해시로 종단간 검증되므로 디스크에 남는 것은 보낸 것과 바이트 단위로 동일합니다.",
      ],
      bullets: [
        "받는 쪽이 Chrome 또는 Edge: 파일이 디스크로 스트리밍되므로 사실상 크기 제한이 없습니다.",
        "Firefox와 Safari는 대신 파일을 메모리에 버퍼링하므로, 그 브라우저에서는 개별 파일을 약 200 MB 이내로 유지하세요.",
        "배치당 최대 10개 파일, 각각 도착 시 고유한 SHA-256 해시로 검증됩니다.",
      ],
    },
    {
      heading: "처음부터가 아니라 이어서 재개",
      body: [
        "대용량 전송에는 시간이 걸리고, 그 시간이 바로 Wi-Fi가 끊기고 노트북이 절전에 들고 휴대폰이 네트워크를 바꾸는 때입니다. Relayium은 그에 대비해 만들어졌습니다. 도중에 연결이 끊겨도 전송은 파일 전체를 다시 시작하지 않고 멈춘 지점에서 이어집니다.",
        "연결성도 같은 방식으로 처리됩니다. 가능한 경우 전송은 P2P로 직접 이루어지고, 두 네트워크가 직접 도달하지 못할 때는 암호화된 스트림이 TURN 릴레이로 폴백합니다. 릴레이는 암호문만 볼 수 있으므로 폴백 경로에서도 종단간 암호화를 유지합니다.",
      ],
    },
    {
      heading: "지금 보내거나, 나중에 받을 링크를 남기거나",
      body: [
        "실시간 직접 전송은 양쪽이 동시에 온라인이어야 하며, 시간을 맞출 수 있을 때 가장 이상적입니다——통화 중, 함께하는 순간, 자리에 있는 동료. 상대가 지금 없다면 대신 저장형 다운로드 링크를 만들 수 있습니다.",
        "저장 링크는 영지식입니다. 브라우저가 업로드 전에 AES-256-GCM으로 파일을 암호화하고 복호화 키는 URL 프래그먼트에만 존재하므로, 서버는 읽을 수 없는 암호문을 보관합니다. 절충점도 알아두세요——링크 생성에는 보내는 쪽의 로그인이 필요하고, 링크는 스토리지 할당량을 차지하며, 만료됩니다(첫 다운로드 후 소각으로 설정할 수도 있습니다). 가장 큰 파일이라면, 양쪽이 온라인일 수 있을 때 실시간 경로가 언제나 가장 깔끔한 선택입니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "보낼 수 있는 파일 최대 크기는 얼마인가요?",
        a: "실시간 모드에는 서버 측 제한이 없습니다——상한은 받는 쪽 브라우저에 달렸습니다. Chrome이나 Edge에서는 파일이 디스크로 스트리밍되어 메모리가 바닥나지 않고 수십 GB를 보낼 수 있습니다. Firefox나 Safari에서는 파일이 메모리에 버퍼링되므로, 그 브라우저에서는 개별 파일을 약 200 MB 이내로 유지하세요.",
      },
      {
        q: "전송이 중단되면 어떻게 되나요?",
        a: "자동으로 재개됩니다. 전송 도중 연결이 끊겨도——Wi-Fi 끊김, 노트북 절전, 네트워크 전환——Relayium은 파일 전체를 다시 시작하지 않고 멈춘 지점에서 이어가므로, 긴 전송이 잠깐의 장애로 헛되지 않습니다.",
      },
      {
        q: "대용량 파일에서 개인정보는 어떻게 보호되나요?",
        a: "실시간 전송은 X25519 키 교환과 블록별 AES-256-GCM으로 종단간 암호화되며, 그 키는 어떤 서버에도 도달하지 않습니다. 두 기기가 6자리 검증 코드를 표시해 중간에 아무도 없음을 확인하고, 각 파일은 SHA-256 해시로 검사됩니다. TURN 릴레이가 필요할 때도 그것은 암호문만 봅니다.",
      },
    ],
  },
  cta: {
    text: "다음 수 기가바이트 파일을 직접 방식으로 보내세요 — 설치 불필요, 실시간 전송에는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Große Dateien ohne Cloud versenden",
  description:
    "Sende mehrere Gigabyte große Videos und Projektarchive direkt von Browser zu Browser — kein Cloud-Upload, in Echtzeit keine Größenbeschränkung, mit fortsetzbaren Übertragungen und Integritätsprüfung je Datei.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Ein 20 GB großer Videoexport oder ein schweres Projektarchiv ist genau der Fall, in dem Cloud-Speicher am langsamsten wirkt: Du lädst die ganze Datei einmal hoch, wartest, und die andere Person lädt sie erneut herunter — zwei vollständige Übertragungen, plus das, was dein Speicherkontingent zulässt. Für eine einmalige Übergabe ist das viel Kopieren und Warten für Bytes, die nur von A nach B mussten.",
    "Relayium nimmt den direkten Weg. Die Datei fließt über einen verschlüsselten Peer-to-Peer-Kanal direkt aus deinem Browser in den der empfangenden Person und landet dazwischen nie auf einem Server. Diese Anleitung zeigt, wie du große Dateien so bewegst, und ist ehrlich zu den zwei realen Grenzen: welche Browser unbegrenzte Größen verkraften und dass in der Regel beide gleichzeitig online sein müssen.",
  ],
  sections: [
    {
      heading: "Warum die Direktübertragung bei großen Dateien gewinnt",
      body: [
        "Bei Cloud-Speicher überquert eine große Datei das Netz zweimal — hoch zum Server, dann wieder herunter zur empfangenden Person — und belastet dazwischen ein Speicherkontingent. Eine direkte Peer-to-Peer-Übertragung überquert das Netz einmal, vom Absender zum Empfänger, ohne dass etwas dazwischen gespeichert wird.",
        "Relayium läuft vollständig im Browser, es gibt also auf keiner Seite etwas zu installieren. Es funktioniert unter Windows, macOS, Linux, Android und iOS, und Echtzeitübertragungen brauchen kein Konto — du öffnest einfach relayium.com auf beiden Geräten und verbindest sie.",
      ],
    },
    {
      heading: "Keine Größenbeschränkung im Echtzeitmodus",
      body: [
        "Echtzeitübertragungen haben keine serverseitige Größenbeschränkung, weil kein Server die Datei hält. Die praktische Obergrenze setzt der empfangende Browser, nicht wir.",
        "In Chrome und Edge wird die eingehende Datei beim Eintreffen direkt auf die Festplatte gestreamt, muss also nie in den Speicher passen — das ist die Kombination für sehr große Dateien, bequem bis in den zweistelligen Gigabyte-Bereich. Ein Stapel fasst bis zu 10 Dateien, und jede wird per SHA-256-Hash Ende-zu-Ende geprüft, sodass das, was auf der Festplatte landet, Byte für Byte dem entspricht, was du gesendet hast.",
      ],
      bullets: [
        "Chrome oder Edge auf der Empfangsseite: Dateien werden auf die Festplatte gestreamt, es gibt also praktisch keine Größenbeschränkung.",
        "Firefox und Safari puffern die Datei stattdessen im Speicher, halte dort einzelne Dateien unter etwa 200 MB.",
        "Bis zu 10 Dateien pro Stapel, jede beim Eintreffen mit ihrem eigenen SHA-256-Hash geprüft.",
      ],
    },
    {
      heading: "Fortsetzen statt neu beginnen",
      body: [
        "Große Übertragungen brauchen Zeit, und in dieser Zeit bricht WLAN ab, gehen Laptops in den Ruhezustand und wechseln Handys das Netz. Relayium ist dafür gebaut: Bricht die Verbindung mittendrin ab, wird die Übertragung dort fortgesetzt, wo sie aufgehört hat, statt die ganze Datei neu zu beginnen.",
        "Die Konnektivität wird ebenso gehandhabt. Die Übertragung läuft nach Möglichkeit direkt Peer-to-Peer; können sich zwei Netze nicht direkt erreichen, weicht der verschlüsselte Datenstrom auf ein TURN-Relay aus. Das Relay sieht nur Chiffretext, sodass auch der Ausweichpfad Ende-zu-Ende-verschlüsselt bleibt.",
      ],
    },
    {
      heading: "Jetzt senden oder einen Link für später hinterlassen",
      body: [
        "Die direkte Echtzeitübertragung setzt voraus, dass beide gleichzeitig online sind — ideal, wenn ihr euch abstimmen könnt: ein Anruf, ein gemeinsamer Moment, ein Kollege am Schreibtisch. Ist die andere Person gerade nicht verfügbar, kannst du stattdessen einen gespeicherten Download-Link erstellen.",
        "Ein gespeicherter Link ist Zero-Knowledge: Dein Browser verschlüsselt die Dateien vor dem Upload mit AES-256-GCM, und der Entschlüsselungsschlüssel liegt nur im URL-Fragment, sodass der Server Chiffretext behält, den er nicht lesen kann. Beachte die Kompromisse — das Erstellen eines Links erfordert die Anmeldung des Absenders, Links zählen gegen ein Speicherkontingent und laufen ab (oder können nach dem ersten Download verfallen). Für die größten Dateien bleibt der Echtzeitweg die sauberste Option, wenn ihr beide online sein könnt.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Wie groß darf die Datei sein, die ich sende?",
        a: "Im Echtzeitmodus gibt es keine serverseitige Grenze — die Obergrenze kommt vom empfangenden Browser. In Chrome oder Edge wird die Datei auf die Festplatte gestreamt, du kannst also zweistellige Gigabyte-Mengen senden, ohne dass der Speicher ausgeht. In Firefox oder Safari wird die Datei im Speicher gepuffert, halte dort einzelne Dateien unter etwa 200 MB.",
      },
      {
        q: "Was passiert, wenn die Übertragung unterbrochen wird?",
        a: "Sie wird automatisch fortgesetzt. Bricht die Verbindung mittendrin ab — ein abgerissenes WLAN-Signal, ein schlafender Laptop, ein Netzwechsel — nimmt Relayium dort wieder auf, wo es aufgehört hat, statt die ganze Datei neu zu starten, sodass eine lange Übertragung nicht an einem kurzen Aussetzer scheitert.",
      },
      {
        q: "Wie ist meine Privatsphäre bei großen Dateien geschützt?",
        a: "Echtzeitübertragungen sind mit einem X25519-Schlüsselaustausch und AES-256-GCM pro Block Ende-zu-Ende verschlüsselt, und dieser Schlüssel erreicht keinen Server. Beide Geräte zeigen einen sechsstelligen Prüfcode, um zu bestätigen, dass niemand dazwischensitzt, und jede Datei wird per SHA-256-Hash geprüft. Selbst wenn ein TURN-Relay nötig ist, sieht es nur Chiffretext.",
      },
    ],
  },
  cta: {
    text: "Bewege deine nächste mehrere Gigabyte große Datei auf dem direkten Weg — keine Installation und für Echtzeitübertragungen kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer de gros fichiers sans le cloud",
  description:
    "Envoyez des vidéos et des archives de projet de plusieurs gigaoctets directement, d'un navigateur à l'autre — sans envoi vers le cloud, sans limite de taille en temps réel, avec reprise des transferts et vérification d'intégrité par fichier.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Un export vidéo de 20 Go ou une lourde archive de projet, c'est justement là que le stockage cloud paraît le plus lent : vous téléversez tout le fichier une fois, vous attendez, puis l'autre personne le télécharge à nouveau — deux transferts complets, plus ce que votre quota de stockage autorise. Pour une remise unique, cela fait beaucoup de copies et d'attente pour des octets qui ne devaient aller que de A à B.",
    "Relayium prend la voie directe. Le fichier circule tout droit de votre navigateur vers celui du destinataire par un canal pair-à-pair chiffré, et n'atterrit jamais sur un serveur entre les deux. Ce guide montre comment déplacer de gros fichiers ainsi, et reste honnête sur les deux limites réelles : quels navigateurs supportent des tailles illimitées, et le fait que les deux personnes doivent généralement être en ligne en même temps.",
  ],
  sections: [
    {
      heading: "Pourquoi le transfert direct l'emporte pour les gros fichiers",
      body: [
        "Avec le stockage cloud, un gros fichier traverse le réseau deux fois — jusqu'au serveur, puis de nouveau vers le destinataire — et pèse sur un quota de stockage entre les deux. Un transfert pair-à-pair direct traverse le réseau une seule fois, de l'expéditeur au destinataire, sans rien stocker au milieu.",
        "Relayium fonctionne entièrement dans le navigateur, il n'y a donc rien à installer d'un côté ou de l'autre. Il marche sous Windows, macOS, Linux, Android et iOS, et les transferts en temps réel ne demandent aucun compte — il suffit d'ouvrir relayium.com sur les deux appareils et de les connecter.",
      ],
    },
    {
      heading: "Aucune limite de taille en mode temps réel",
      body: [
        "Les transferts en temps réel n'ont aucune limite de taille côté serveur, parce qu'aucun serveur ne détient le fichier. Le plafond pratique est fixé par le navigateur qui reçoit, pas par nous.",
        "Sur Chrome et Edge, le fichier entrant est diffusé directement sur le disque à mesure qu'il arrive, il n'a donc jamais à tenir en mémoire — c'est la combinaison à utiliser pour de très gros fichiers, aisément jusqu'à des dizaines de gigaoctets. Un lot peut contenir jusqu'à 10 fichiers, et chacun est vérifié de bout en bout par une empreinte SHA-256, de sorte que ce qui arrive sur le disque est identique octet pour octet à ce que vous avez envoyé.",
      ],
      bullets: [
        "Chrome ou Edge côté réception : les fichiers sont diffusés sur le disque, il n'y a donc pratiquement aucune limite de taille.",
        "Firefox et Safari mettent le fichier en mémoire tampon à la place, gardez-y les fichiers individuels sous environ 200 Mo.",
        "Jusqu'à 10 fichiers par lot, chacun vérifié à l'arrivée par sa propre empreinte SHA-256.",
      ],
    },
    {
      heading: "Reprendre plutôt que recommencer",
      body: [
        "Les gros transferts prennent du temps, et c'est pendant ce temps que le Wi-Fi lâche, que les ordinateurs se mettent en veille et que les téléphones changent de réseau. Relayium est conçu pour cela : si la connexion se rompt en cours de route, le transfert reprend là où il s'était arrêté au lieu de recommencer tout le fichier.",
        "La connectivité est gérée de la même façon. Le transfert se fait en pair-à-pair direct chaque fois que possible ; quand deux réseaux ne peuvent pas s'atteindre directement, le flux chiffré bascule vers un relais TURN. Le relais ne voit que du texte chiffré, si bien que même la voie de secours reste chiffrée de bout en bout.",
      ],
    },
    {
      heading: "Envoyer maintenant, ou laisser un lien pour plus tard",
      body: [
        "Le transfert direct en temps réel exige que les deux personnes soient en ligne en même temps, ce qui est idéal quand vous pouvez vous coordonner — un appel, un moment partagé, un collègue à son bureau. Si l'autre personne n'est pas disponible pour l'instant, vous pouvez créer un lien de téléchargement stocké à la place.",
        "Un lien stocké est à divulgation nulle : votre navigateur chiffre les fichiers en AES-256-GCM avant l'envoi et la clé de déchiffrement ne vit que dans le fragment de l'URL, de sorte que le serveur conserve un texte chiffré qu'il ne peut pas lire. Ayez les compromis en tête — créer un lien exige que l'expéditeur se connecte, les liens comptent dans un quota de stockage et expirent (ou peuvent s'autodétruire après le premier téléchargement). Pour les plus gros fichiers, quand vous pouvez tous deux être en ligne, la voie en temps réel reste l'option la plus nette.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Quelle est la taille maximale d'un fichier que je peux envoyer ?",
        a: "En mode temps réel, il n'y a aucune limite côté serveur — le plafond vient du navigateur qui reçoit. Sur Chrome ou Edge, le fichier est diffusé sur le disque, vous pouvez donc envoyer des dizaines de gigaoctets sans manquer de mémoire. Sur Firefox ou Safari, le fichier est mis en mémoire tampon, gardez-y les fichiers individuels sous environ 200 Mo.",
      },
      {
        q: "Que se passe-t-il si le transfert est interrompu ?",
        a: "Il reprend automatiquement. Si la connexion se coupe en cours de transfert — un signal Wi-Fi perdu, un ordinateur en veille, un changement de réseau — Relayium repart de là où il s'était arrêté au lieu de recommencer tout le fichier, de sorte qu'un long transfert n'est pas perdu pour un bref incident.",
      },
      {
        q: "Comment ma vie privée est-elle protégée pour les gros fichiers ?",
        a: "Les transferts en temps réel sont chiffrés de bout en bout par un échange de clés X25519 et un AES-256-GCM par bloc, et cette clé n'atteint jamais aucun serveur. Les deux appareils affichent un code de vérification à 6 chiffres pour confirmer que personne ne s'intercale, et chaque fichier est vérifié par une empreinte SHA-256. Même quand un relais TURN est nécessaire, il ne voit que du texte chiffré.",
      },
    ],
  },
  cta: {
    text: "Déplacez votre prochain fichier de plusieurs gigaoctets par la voie directe — sans installation, et sans compte pour les transferts en temps réel.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "how-to/send-large-files-without-cloud",
  updated: "2026-07-03",
  langs: { en, zh, ja, ko, de, fr },
};
