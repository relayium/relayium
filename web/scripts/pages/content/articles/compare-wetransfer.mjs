// web/scripts/pages/content/articles/compare-wetransfer.mjs
// Objective comparison: Relayium vs WeTransfer. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "Relayium vs WeTransfer: large realtime transfers without server-side file storage",
  description:
    "An honest comparison of Relayium and WeTransfer. WeTransfer is great for asynchronous link sharing; Relayium adds realtime transfers with no server-side file copy or history, plus zero-knowledge stored links.",
  updatedLabel: "Last updated",
  lead: [
    "WeTransfer made sending big files feel effortless: drop a file, get a link, and the recipient downloads whenever they are ready — even if they were offline when you sent it. That asynchronous, no-account-to-receive experience is genuinely good, and it is why so many people reach for it.",
    "This article compares the two fairly. WeTransfer's strength is polished, link-based sharing where the file waits on a server. Relayium's focus is different: realtime transfers with no server-side file copy or history, plus an optional stored link that stays zero-knowledge encrypted. On the same LAN the browsers connect directly; across networks they use TURN by design. Neither is simply better — they solve slightly different problems.",
  ],
  sections: [
    {
      heading: "What WeTransfer does well",
      body: [
        "WeTransfer's core idea is asynchronous: the sender uploads once, gets a link, and the recipient downloads later. The two people never have to be online at the same time, which is exactly what you want when you email a video to a client who will open it tomorrow.",
        "It is also mature and frictionless. There is nothing to install, the free tier lets you send without an account, and the interface is famously simple. For occasional link sharing within its size limit, it just works.",
      ],
    },
    {
      heading: "Where they differ: the file lives on a server",
      body: [
        "With WeTransfer, your file is uploaded to its servers, stored there for a while, and downloaded from there. The free tier caps each transfer at 2 GB, and the link points at a copy sitting on infrastructure you do not control. The transfer is encrypted in transit and at rest, but it is not zero-knowledge: the service holds the keys and could, in principle, read the file.",
        "Relayium's realtime mode does not keep a server-side file copy or transfer history, so there is no server-side size cap to hit. On the same LAN the browsers connect directly; across networks they use a TURN relay by design, which carries end-to-end encrypted ciphertext but cannot read or decrypt the plaintext. On top of WebRTC, Relayium adds its own layer: an X25519 key exchange derives a key for per-chunk AES-256-GCM, both devices compare a matching 6-digit verification code (SAS) out of band to detect substituted endpoint public keys or endpoint impersonation, and each file is checked end-to-end with a SHA-256 hash.",
      ],
    },
    {
      heading: "Realtime transfers with no size cap",
      body: [
        "Because realtime mode keeps no server-side file copy or history, the practical file-size limit comes from your own browser. In Chrome or Edge, Relayium streams incoming data straight to disk, so there is effectively no size cap — multi-gigabyte videos and project archives are fine.",
        "Firefox and Safari don't offer that same File System Access streaming, so when no streaming path applies the browser holds the file in memory instead; Relayium warns above roughly 256 MB, a deliberately conservative estimate rather than a measured hard limit. On the same LAN, realtime transfers need no account and the two devices connect directly: open relayium.com on both, pick up to 1,000 files, verify the code, and send. Across networks, whoever creates the pairing code signs in and the browser session uses an encrypted TURN relay by design; whoever joins with the code or link needs no account. TURN carries end-to-end encrypted ciphertext but cannot read or decrypt the plaintext. If a connection drops mid-way, the transfer resumes instead of starting over.",
      ],
    },
    {
      heading: "When the recipient is offline: zero-knowledge stored links",
      body: [
        "Realtime transfer needs both people present, which is the one thing WeTransfer's link model does better. So Relayium offers the same async convenience without giving up privacy: a stored download link.",
        "Your browser encrypts the files with AES-256-GCM before upload, and the decryption key lives only in the URL fragment — the part after the # that browsers never send to the server. The server therefore stores zero-knowledge ciphertext it cannot read, and the recipient does not need an account to download. Creating such a link requires the sender to sign in, and each link can be set to expire or to burn after the first download.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: [
        "The differences that matter most, side by side:",
      ],
      bullets: [
        "Size limit: WeTransfer's free tier caps transfers at 2 GB; Relayium realtime has no server-side cap (Chrome/Edge stream to disk; when the browser has to buffer in memory instead, Relayium warns above roughly 256 MB).",
        "Where files live: WeTransfer stores your file on its servers; Relayium realtime keeps no server-side file copy or history. Same-LAN browsers connect directly, while cross-network browser sessions use TURN by design to carry end-to-end encrypted ciphertext it cannot read or decrypt.",
        "Encryption: WeTransfer encrypts in transit and at rest but holds the keys; Relayium is end-to-end with a 6-digit SAS code, and stored links are zero-knowledge with the key only in the URL fragment.",
        "Offline recipient: both handle it — WeTransfer via its stored link, Relayium via a zero-knowledge stored download link with expiry or burn-after-download.",
        "Integrity and resume: Relayium verifies each file with SHA-256 and can resume an interrupted transfer instead of restarting.",
        "Cost and openness: Relayium is free and AGPL-3.0-licensed at github.com/relayium/relayium, and runs in the browser on Windows, macOS, Linux, Android and iOS with nothing to install.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is there really no file-size limit?",
        a: "In realtime mode there is no server-side cap because Relayium keeps no server-side file copy or history. Same-LAN browsers connect directly; cross-network browser sessions use TURN by design, carrying end-to-end encrypted ciphertext the relay cannot read or decrypt. In Chrome or Edge the download streams straight to disk, so multi-gigabyte files are fine. In Firefox or Safari, when no streaming path applies the browser buffers in memory instead, and Relayium warns above roughly 256 MB — a deliberately conservative estimate, not a hard limit. Stored download links have a quota tied to your account.",
      },
      {
        q: "What if the recipient isn't online?",
        a: "Use a stored download link. Your browser encrypts the files with AES-256-GCM, the key stays only in the URL fragment, and the server keeps zero-knowledge ciphertext the recipient can fetch later. Creating the link requires the sender to sign in, and you can set it to expire or burn after the first download.",
      },
      {
        q: "Is Relayium free?",
        a: "Yes. Relayium is free and open source under the AGPL-3.0 license, with the full protocol and code at github.com/relayium/relayium. There is no paid tier to unlock larger realtime transfers — the size headroom comes from streaming to disk in the browser, not from a subscription.",
      },
    ],
  },
  cta: {
    text: "Send a large file right now — no size cap, no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 WeTransfer：实时大文件不做服务端存储",
  description:
    "客观对比 Relayium 与 WeTransfer。WeTransfer 擅长异步链接分享；Relayium 的实时模式不在服务端保留文件副本或传输历史，另有零知识加密的存储下载链接。",
  updatedLabel: "最近更新",
  lead: [
    "WeTransfer 让发送大文件变得轻松：拖入文件、拿到链接，对方随时下载——哪怕你发送时对方并不在线。这种异步、收件方无需账号的体验确实很好，也正是许多人选择它的原因。",
    "本文客观对比这两者。WeTransfer 的长处是成熟的、基于链接的分享，文件在服务器上等待被下载。Relayium 的重点不同：实时传输不在服务端保留文件副本或传输历史；同一局域网内浏览器直连，跨网络浏览器则按设计使用 TURN。此外还有一个可选的、始终零知识加密的存储链接。两者并非谁更好，而是各自解决略有不同的问题。",
  ],
  sections: [
    {
      heading: "WeTransfer 做得好的地方",
      body: [
        "WeTransfer 的核心思路是异步：发送方上传一次、拿到链接，收件方稍后再下载。两个人不必同时在线——当你把一段视频发给明天才会打开它的客户时，这正是你想要的。",
        "它也成熟、顺滑。无需安装任何软件，免费档不用账号即可发送，界面以简洁著称。在大小上限之内做偶尔的链接分享，它确实好用。",
      ],
    },
    {
      heading: "差异所在：文件存在服务器上",
      body: [
        "用 WeTransfer 时，你的文件会上传到它的服务器、在那里存放一段时间，再从那里下载。免费档每次传输上限 2 GB，链接指向的是放在你无法掌控的基础设施上的一份副本。传输在通道内和静态存储时都有加密，但它不是零知识的：服务方持有密钥，原则上可以读取文件。",
        "Relayium 的实时模式不在服务端保留文件副本或传输历史，因此不存在服务端大小上限。同一局域网内浏览器直连；跨网络浏览器按设计使用 TURN 中继，TURN 承载端到端加密的密文，但无法读取或解密明文。在 WebRTC 传输之上，Relayium 再加一层：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密；两台设备通过带外渠道核对一致的 6 位校验码（SAS），以检测端点公钥替换或端点冒充；每个文件都用 SHA-256 做端到端校验。",
      ],
    },
    {
      heading: "无大小上限的实时传输",
      body: [
        "因为实时模式不在服务端保留文件副本或传输历史，实际的文件大小上限取决于你自己的浏览器。在 Chrome 或 Edge 中，Relayium 会把接收的数据直接流式写入磁盘，所以基本没有大小上限——几 GB 的视频和工程压缩包都没问题。",
        "Firefox 和 Safari 没有同样的 File System Access 流式下载，因此当所有流式写盘路径都不适用时，浏览器只能把文件攒在内存里；Relayium 会在超过约 256 MB 时给出提示，这是刻意取的保守估计，而不是实测出来的硬上限。同一局域网下实时传输无需账号，两台设备直连：在两台设备上打开 relayium.com，最多选 1,000 个文件，核对校验码，然后发送。跨网络时，创建配对码的一方登录，浏览器会话按设计使用加密 TURN 中继；使用配对码或链接加入者无需账号。TURN 承载端到端加密的密文，但无法读取或解密明文。若连接中途断开，传输会断点续传而非从头再来。",
      ],
    },
    {
      heading: "对方不在线时：零知识存储链接",
      body: [
        "实时传输需要双方都在场，而这恰是 WeTransfer 的链接模式做得更好的一点。所以 Relayium 提供了同样的异步便利，又不牺牲隐私：一个存储下载链接。",
        "你的浏览器会在上传前用 AES-256-GCM 加密文件，解密密钥只存在于 URL 片段里——也就是 # 之后、浏览器从不发送给服务器的那部分。因此服务器只保存无法解读的零知识密文，收件方也无需账号即可下载。生成这样的链接需要发送方登录，且每个链接都可设为到期失效或首次下载后即焚。",
      ],
    },
    {
      heading: "功能一览对比",
      body: [
        "把最关键的差别并排列出：",
      ],
      bullets: [
        "大小上限：WeTransfer 免费档每次传输上限 2 GB；Relayium 实时模式无服务器端上限（Chrome/Edge 流式写盘；浏览器只能攒内存时，Relayium 会在超过约 256 MB 时给出提示）。",
        "文件存放：WeTransfer 把文件存在它的服务器上；Relayium 实时模式不在服务端保留文件副本或传输历史。同一局域网内浏览器直连，跨网络浏览器按设计使用 TURN 承载其无法读取或解密的端到端密文。",
        "加密：WeTransfer 在传输与静态存储时加密，但密钥由它持有；Relayium 端到端加密并带 6 位 SAS 校验码，存储链接为零知识，密钥只在 URL 片段里。",
        "收件方离线：两者都能应对——WeTransfer 靠它的存储链接，Relayium 靠零知识存储下载链接，可设到期或下载后即焚。",
        "完整性与续传：Relayium 用 SHA-256 校验每个文件，并可在传输中断后续传而非重来。",
        "费用与开放：Relayium 免费且采用 AGPL-3.0 许可，代码在 github.com/relayium/relayium；在浏览器中运行，覆盖 Windows、macOS、Linux、Android 和 iOS，无需安装。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "真的没有文件大小限制吗？",
        a: "实时模式下没有服务端上限，因为 Relayium 不在服务端保留文件副本或传输历史。同一局域网内浏览器直连；跨网络浏览器按设计使用 TURN，承载中继无法读取或解密的端到端密文。在 Chrome 或 Edge 中，下载会直接流式写入磁盘，所以几 GB 的文件都没问题。在 Firefox 或 Safari 中，当所有流式写盘路径都不适用时，浏览器只能攒在内存里，Relayium 会在超过约 256 MB 时给出提示——这是刻意取的保守估计，不是硬上限。存储下载链接则有与账号绑定的配额。",
      },
      {
        q: "对方不在线怎么办？",
        a: "用存储下载链接。你的浏览器会用 AES-256-GCM 加密文件，密钥只留在 URL 片段里，服务器保存的是零知识密文，收件方稍后即可取回。生成链接需要发送方登录，并可设为到期失效或首次下载后即焚。",
      },
      {
        q: "Relayium 免费吗？",
        a: "免费。Relayium 采用 AGPL-3.0 许可，是免费开源软件，完整的协议与代码都在 github.com/relayium/relayium。没有付费档去解锁更大的实时传输——大文件的空间来自浏览器的流式写盘，而不是订阅。",
      },
    ],
  },
  cta: {
    text: "现在就发一个大文件——无大小上限、无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と WeTransfer の比較：サーバー側に保存せず大容量をリアルタイム転送",
  description:
    "Relayium と WeTransfer を公平に比較。WeTransfer は非同期のリンク共有が得意です。Relayium はサーバー側にファイルのコピーや転送履歴を残さないリアルタイム転送と、ゼロ知識の保存リンクを備えます。",
  updatedLabel: "最終更新",
  lead: [
    "WeTransfer は大きなファイルの送信を簡単にしました。ファイルをドロップしてリンクを受け取れば、相手は好きなときにダウンロードできます。送った時点で相手がオフラインでも大丈夫です。この非同期で、受け取りにアカウントが要らない体験は本当に優れており、多くの人が選ぶ理由です。",
    "本記事はこの2つを公平に比較します。WeTransfer の強みは、ファイルがサーバー上で待つ洗練されたリンクベースの共有です。Relayium のリアルタイム転送はサーバー側にファイルのコピーや転送履歴を残しません。同一 LAN ではブラウザ同士が直接接続し、ネットワークをまたぐ場合は設計上 TURN を使います。加えて、常にゼロ知識で暗号化される任意の保存リンクもあります。どちらが単純に優れているわけではなく、少し異なる問題を解いています。",
  ],
  sections: [
    {
      heading: "WeTransfer が優れている点",
      body: [
        "WeTransfer の中心的な発想は非同期です。送信側が一度アップロードしてリンクを受け取り、受信側は後でダウンロードします。2人が同時にオンラインである必要はなく、明日開く予定のクライアントに動画をメールで送るときにまさに欲しい形です。",
        "成熟していて摩擦もありません。インストールは不要、無料枠ではアカウントなしで送信でき、インターフェースは簡潔さで有名です。サイズ上限の範囲で時々リンク共有するだけなら、しっかり動きます。",
      ],
    },
    {
      heading: "違いはどこか：ファイルはサーバー上に置かれる",
      body: [
        "WeTransfer では、ファイルはそのサーバーにアップロードされ、しばらく保存され、そこからダウンロードされます。無料枠は1回の転送を 2 GB に制限し、リンクはあなたが管理できないインフラ上のコピーを指します。転送は通信中も保存時も暗号化されますが、ゼロ知識ではありません。サービス側が鍵を持ち、原理的にはファイルを読めます。",
        "Relayium のリアルタイムモードはサーバー側にファイルのコピーや転送履歴を残さないため、サーバー側のサイズ上限がありません。同一 LAN ではブラウザ同士が直接接続し、ネットワークをまたぐ場合は設計上 TURN リレーを使います。TURN はエンドツーエンド暗号化された暗号文を運びますが、平文を読んだり復号したりできません。WebRTC の上に、Relayium は X25519 鍵交換、チャンクごとの AES-256-GCM、6桁の検証コード（SAS）、ファイルごとの SHA-256 検証を重ねます。",
      ],
    },
    {
      heading: "サイズ上限のないリアルタイム転送",
      body: [
        "リアルタイムモードはサーバー側にファイルのコピーや転送履歴を残さないため、実用上のファイルサイズ上限は自分のブラウザ次第です。Chrome や Edge では、Relayium は受信データをそのままディスクにストリーミングするので、事実上サイズ上限はありません。数ギガバイトの動画やプロジェクトのアーカイブも問題ありません。",
        "Firefox と Safari は同じ File System Access のストリーミングを備えていないため、ストリーミングで書き出せる経路がどれも使えないときはファイルをメモリに保持します。Relayium は約 256 MB を超えると警告しますが、これは実測された上限ではなく、意図的に保守的な見積もりです。同一 LAN ではアカウント不要で、2台の端末は直接つながります。ネットワークをまたぐ場合はペアリングコードの作成者がサインインし、ブラウザセッションは設計上、暗号化された TURN リレーを経由します。コードまたはリンクで参加する側はアカウント不要です。TURN はエンドツーエンド暗号化された暗号文を運びますが、平文を読んだり復号したりできません。途中で接続が切れても、転送は最初からではなく再開します。",
      ],
    },
    {
      heading: "受信側がオフラインのとき：ゼロ知識の保存リンク",
      body: [
        "リアルタイム転送は双方が同席している必要があり、これは WeTransfer のリンク方式が優れている唯一の点です。そこで Relayium は、プライバシーを犠牲にせずに同じ非同期の便利さを提供します。保存型ダウンロードリンクです。",
        "ブラウザがアップロード前にファイルを AES-256-GCM で暗号化し、復号鍵は URL フラグメント（# の後の、ブラウザがサーバーに決して送らない部分）にだけ存在します。したがってサーバーは読めないゼロ知識の暗号文を保存し、受信側はアカウントなしでダウンロードできます。こうしたリンクの作成には送信側のサインインが必要で、各リンクは有効期限切れ、または最初のダウンロード後に消去するよう設定できます。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: [
        "最も重要な違いを並べて示します。",
      ],
      bullets: [
        "サイズ上限：WeTransfer の無料枠は転送を 2 GB に制限します。Relayium のリアルタイムはサーバー側の上限がありません（Chrome/Edge はディスクへストリーミング。ブラウザがメモリに溜めるしかない場合は約 256 MB を超えると警告します）。",
        "ファイルの置き場所：WeTransfer はファイルをサーバーに保存します。Relayium のリアルタイムはサーバー側にファイルのコピーや転送履歴を残しません。同一 LAN では直接接続し、ネットワークをまたぐ場合は設計上 TURN が読取・復号不能なエンドツーエンド暗号文を運びます。",
        "暗号化：WeTransfer は通信中も保存時も暗号化しますが、鍵はサービス側が保持します。Relayium は6桁の SAS コード付きのエンドツーエンド暗号化で、保存リンクは鍵が URL フラグメントだけにあるゼロ知識です。",
        "受信側がオフライン：どちらも対応します。WeTransfer は保存リンクで、Relayium は有効期限や閲覧後削除を設定できるゼロ知識の保存ダウンロードリンクで対応します。",
        "整合性と再開：Relayium は各ファイルを SHA-256 で検証し、中断した転送を最初からやり直さず再開できる。",
        "費用と開放性：Relayium は無料で AGPL-3.0 ライセンス、github.com/relayium/relayium にあり、ブラウザで Windows・macOS・Linux・Android・iOS で動作し、インストール不要。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "本当にファイルサイズの上限はないのですか？",
        a: "リアルタイムモードはサーバー側にファイルのコピーや転送履歴を残さないため、サーバー側の上限はありません。同一 LAN ではブラウザ同士が直接接続し、ネットワークをまたぐ場合は設計上 TURN が読取・復号不能なエンドツーエンド暗号文を運びます。Chrome や Edge ではダウンロードがそのままディスクにストリーミングされるので、数ギガバイトのファイルも問題ありません。Firefox や Safari では、ストリーミングで書き出せる経路がどれも使えないときにメモリへ溜めることになり、Relayium は約 256 MB を超えると警告します。これは意図的に保守的な見積もりであり、ハードな上限ではありません。保存型ダウンロードリンクにはアカウントに紐づく容量枠があります。",
      },
      {
        q: "受信側がオンラインでないときは？",
        a: "保存型ダウンロードリンクを使います。ブラウザがファイルを AES-256-GCM で暗号化し、鍵は URL フラグメントだけに残り、サーバーは受信側が後で取得できるゼロ知識の暗号文を保持します。リンクの作成には送信側のサインインが必要で、有効期限切れや最初のダウンロード後の消去を設定できます。",
      },
      {
        q: "Relayium は無料ですか？",
        a: "はい。Relayium は AGPL-3.0 ライセンスの無料オープンソースで、プロトコルとコードのすべてが github.com/relayium/relayium にあります。より大きなリアルタイム転送を解放する有料プランはありません。大容量の余裕はブラウザのディスクへのストリーミングから来るものであり、サブスクリプションからではありません。",
      },
    ],
  },
  cta: {
    text: "今すぐ大容量ファイルを送ってみてください。サイズ上限なし、インストール不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs WeTransfer: 서버 측 저장 없이 대용량 실시간 전송",
  description:
    "Relayium과 WeTransfer를 공정하게 비교합니다. WeTransfer는 비동기 링크 공유에 강하고, Relayium은 서버 측에 파일 사본이나 전송 기록을 남기지 않는 실시간 전송과 영지식 저장 링크를 제공합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "WeTransfer는 큰 파일 보내기를 손쉽게 만들었습니다. 파일을 끌어다 놓고 링크를 받으면 상대는 원할 때 다운로드합니다. 보낼 때 상대가 오프라인이어도 괜찮습니다. 이런 비동기적이고 받는 데 계정이 필요 없는 경험은 정말 훌륭하며, 많은 사람이 선택하는 이유입니다.",
    "이 글은 두 가지를 공정하게 비교합니다. WeTransfer의 강점은 파일이 서버에서 기다리는 세련된 링크 기반 공유입니다. Relayium의 실시간 전송은 서버 측에 파일 사본이나 전송 기록을 남기지 않습니다. 같은 LAN에서는 브라우저끼리 직접 연결하고, 네트워크를 넘을 때는 설계상 TURN을 사용합니다. 여기에 항상 영지식으로 암호화되는 선택적 저장 링크도 있습니다. 어느 하나가 단순히 낫다기보다, 조금 다른 문제를 풉니다.",
  ],
  sections: [
    {
      heading: "WeTransfer가 잘하는 것",
      body: [
        "WeTransfer의 핵심 발상은 비동기입니다. 보내는 쪽이 한 번 업로드해 링크를 받고, 받는 쪽은 나중에 다운로드합니다. 두 사람이 동시에 접속해 있을 필요가 없어, 내일 열어볼 클라이언트에게 동영상을 메일로 보낼 때 딱 원하는 방식입니다.",
        "성숙하고 마찰도 없습니다. 설치할 것이 없고, 무료 등급에서는 계정 없이 보낼 수 있으며, 인터페이스는 간결하기로 유명합니다. 크기 제한 안에서 가끔 링크로 공유하는 정도라면 잘 작동합니다.",
      ],
    },
    {
      heading: "차이가 나는 지점: 파일이 서버에 놓인다",
      body: [
        "WeTransfer에서는 파일이 그 서버에 업로드되어 한동안 저장되고 거기서 다운로드됩니다. 무료 등급은 전송 한 건을 2 GB로 제한하며, 링크는 직접 통제할 수 없는 인프라 위의 사본을 가리킵니다. 전송은 전송 중과 저장 시 모두 암호화되지만 영지식은 아닙니다. 서비스가 키를 쥐고 있어 원칙적으로 파일을 읽을 수 있습니다.",
        "Relayium의 실시간 모드는 서버 측에 파일 사본이나 전송 기록을 남기지 않으므로 서버 측 크기 제한이 없습니다. 같은 LAN에서는 브라우저끼리 직접 연결하고, 네트워크를 넘을 때는 설계상 TURN 릴레이를 사용합니다. TURN은 종단간 암호화된 암호문을 운반하지만 평문을 읽거나 복호화할 수 없습니다. WebRTC 위에 Relayium은 X25519 키 교환, 청크별 AES-256-GCM, 일치하는 6자리 검증 코드(SAS), 파일별 SHA-256 검증을 더합니다.",
      ],
    },
    {
      heading: "크기 제한 없는 실시간 전송",
      body: [
        "실시간 모드는 서버 측에 파일 사본이나 전송 기록을 남기지 않으므로, 실질적인 파일 크기 제한은 자신의 브라우저에서 옵니다. Chrome이나 Edge에서는 Relayium이 들어오는 데이터를 곧바로 디스크로 스트리밍하므로 사실상 크기 제한이 없습니다. 수 기가바이트의 동영상과 프로젝트 아카이브도 괜찮습니다.",
        "Firefox와 Safari에는 같은 File System Access 스트리밍이 없어, 디스크로 흘려보낼 경로가 하나도 적용되지 않으면 브라우저가 파일을 메모리에 담습니다. Relayium은 약 256 MB를 넘으면 경고하는데, 이는 측정된 하드 한계가 아니라 일부러 보수적으로 잡은 추정치입니다. 같은 LAN에서는 계정이 필요 없고 두 기기가 직접 연결됩니다. 네트워크를 넘을 때는 페어링 코드 생성자가 로그인하고 브라우저 세션은 설계상 암호화된 TURN 릴레이를 사용합니다. 코드나 링크로 참가하는 쪽은 계정이 필요 없습니다. TURN은 종단간 암호화된 암호문을 운반하지만 평문을 읽거나 복호화할 수 없습니다. 도중에 연결이 끊겨도 전송은 처음부터가 아니라 이어서 재개됩니다.",
      ],
    },
    {
      heading: "받는 쪽이 오프라인일 때: 영지식 저장 링크",
      body: [
        "실시간 전송은 양쪽이 함께 있어야 하는데, 이것이 WeTransfer의 링크 방식이 더 잘하는 유일한 점입니다. 그래서 Relayium은 프라이버시를 포기하지 않고 같은 비동기 편의를 제공합니다. 저장형 다운로드 링크입니다.",
        "브라우저가 업로드 전에 파일을 AES-256-GCM으로 암호화하고, 복호화 키는 URL 프래그먼트(# 뒤의, 브라우저가 서버로 결코 보내지 않는 부분)에만 존재합니다. 따라서 서버는 읽을 수 없는 영지식 암호문을 저장하고, 받는 쪽은 계정 없이 다운로드할 수 있습니다. 이런 링크 생성에는 보내는 쪽의 로그인이 필요하며, 각 링크는 만료되도록, 또는 열람 후 삭제로 첫 다운로드 뒤 사라지도록 설정할 수 있습니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: [
        "가장 중요한 차이를 나란히 정리하면:",
      ],
      bullets: [
        "크기 제한: WeTransfer 무료 등급은 전송을 2 GB로 제한합니다. Relayium 실시간은 서버 측 제한이 없습니다(Chrome/Edge는 디스크로 스트리밍하고, 브라우저가 메모리에 담을 수밖에 없을 때는 약 256 MB를 넘으면 경고합니다).",
        "파일이 놓이는 곳: WeTransfer는 파일을 서버에 저장합니다. Relayium 실시간은 서버 측에 파일 사본이나 전송 기록을 남기지 않습니다. 같은 LAN에서는 직접 연결하고, 네트워크를 넘을 때는 설계상 TURN이 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다.",
        "암호화: WeTransfer는 전송 중과 저장 시 암호화하지만 키를 보유합니다. Relayium은 6자리 SAS 코드가 있는 종단간 암호화이고, 저장 링크는 키가 URL 프래그먼트에만 있는 영지식입니다.",
        "받는 쪽 오프라인: 둘 다 대응합니다. WeTransfer는 저장 링크로, Relayium은 만료나 열람 후 삭제를 설정할 수 있는 영지식 저장 다운로드 링크로 대응합니다.",
        "무결성과 재개: Relayium은 각 파일을 SHA-256으로 검증하고 중단된 전송을 처음부터 다시 하지 않고 이어받을 수 있음.",
        "비용과 개방성: Relayium은 무료이며 AGPL-3.0 라이선스로 github.com/relayium/relayium에 있고, 브라우저에서 Windows·macOS·Linux·Android·iOS로 동작하며 설치가 필요 없음.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "정말 파일 크기 제한이 없나요?",
        a: "실시간 모드는 서버 측에 파일 사본이나 전송 기록을 남기지 않으므로 서버 측 제한이 없습니다. 같은 LAN에서는 브라우저끼리 직접 연결하고, 네트워크를 넘을 때는 설계상 TURN이 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다. Chrome이나 Edge에서는 다운로드가 곧바로 디스크로 스트리밍되어 수 기가바이트 파일도 괜찮습니다. Firefox나 Safari에서는 디스크로 흘려보낼 경로가 하나도 적용되지 않을 때 메모리에 담게 되며, Relayium이 약 256 MB를 넘으면 경고합니다 — 일부러 보수적으로 잡은 추정치이지 하드 한계가 아닙니다. 저장형 다운로드 링크에는 계정에 연결된 용량 한도가 있습니다.",
      },
      {
        q: "받는 쪽이 접속해 있지 않으면요?",
        a: "저장형 다운로드 링크를 쓰세요. 브라우저가 파일을 AES-256-GCM으로 암호화하고, 키는 URL 프래그먼트에만 남으며, 서버는 받는 쪽이 나중에 가져갈 수 있는 영지식 암호문을 보관합니다. 링크 생성에는 보내는 쪽의 로그인이 필요하며, 만료나 열람 후 삭제를 설정할 수 있습니다.",
      },
      {
        q: "Relayium은 무료인가요?",
        a: "네. Relayium은 AGPL-3.0 라이선스의 무료 오픈소스이며, 프로토콜과 코드 전체가 github.com/relayium/relayium에 있습니다. 더 큰 실시간 전송을 여는 유료 등급은 없습니다. 대용량 여유는 브라우저의 디스크 스트리밍에서 오는 것이지 구독에서 오는 것이 아닙니다.",
      },
    ],
  },
  cta: {
    text: "지금 대용량 파일을 보내보세요. 크기 제한 없이, 설치 없이, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. WeTransfer: große Echtzeitdateien ohne serverseitige Speicherung",
  description:
    "Ein ehrlicher Vergleich von Relayium und WeTransfer. WeTransfer glänzt beim asynchronen Teilen per Link; Relayium bietet Echtzeitübertragungen ohne serverseitige Dateikopie oder Übertragungsverlauf, plus Zero-Knowledge-Speicherlinks.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "WeTransfer hat das Versenden großer Dateien mühelos gemacht: Datei ablegen, Link erhalten, und der Empfänger lädt herunter, wann er bereit ist — selbst wenn er beim Senden offline war. Dieses asynchrone Erlebnis, bei dem man zum Empfangen kein Konto braucht, ist wirklich gut und der Grund, warum so viele darauf zurückgreifen.",
    "Dieser Artikel vergleicht die beiden fair. WeTransfers Stärke ist ausgereiftes, linkbasiertes Teilen, bei dem die Datei auf einem Server wartet. Relayiums Echtzeitübertragung behält keine serverseitige Dateikopie und keinen Übertragungsverlauf: Im selben LAN verbinden sich die Browser direkt, über Netzwerkgrenzen hinweg nutzen sie planmäßig TURN. Dazu kommt ein optionaler Zero-Knowledge-verschlüsselter Speicherlink. Keines ist einfach besser — sie lösen leicht unterschiedliche Probleme.",
  ],
  sections: [
    {
      heading: "Was WeTransfer gut macht",
      body: [
        "WeTransfers Grundidee ist asynchron: Der Absender lädt einmal hoch, erhält einen Link, und der Empfänger lädt später herunter. Beide müssen nie gleichzeitig online sein — genau das willst du, wenn du einem Kunden ein Video mailst, das er erst morgen öffnet.",
        "Es ist außerdem ausgereift und reibungslos. Es gibt nichts zu installieren, im kostenlosen Tarif kannst du ohne Konto senden, und die Oberfläche ist berühmt einfach. Für gelegentliches Teilen per Link innerhalb des Größenlimits funktioniert es einfach.",
      ],
    },
    {
      heading: "Worin sie sich unterscheiden: die Datei liegt auf einem Server",
      body: [
        "Bei WeTransfer wird deine Datei auf dessen Server hochgeladen, dort eine Weile gespeichert und von dort heruntergeladen. Der kostenlose Tarif begrenzt jede Übertragung auf 2 GB, und der Link verweist auf eine Kopie auf einer Infrastruktur, die du nicht kontrollierst. Die Übertragung ist beim Transport und im Ruhezustand verschlüsselt, aber nicht Zero-Knowledge: Der Dienst hält die Schlüssel und könnte die Datei im Prinzip lesen.",
        "Relayiums Echtzeitmodus behält keine serverseitige Dateikopie und keinen Übertragungsverlauf, daher gibt es kein serverseitiges Größenlimit. Im selben LAN verbinden sich die Browser direkt; über Netzwerkgrenzen hinweg nutzen sie planmäßig ein TURN-Relay. TURN transportiert Ende-zu-Ende-verschlüsselten Chiffretext, kann den Klartext aber weder lesen noch entschlüsseln. Über WebRTC fügt Relayium X25519-Schlüsselaustausch, AES-256-GCM pro Block, einen sechsstelligen SAS-Code und eine Ende-zu-Ende-Prüfung per SHA-256 hinzu.",
      ],
    },
    {
      heading: "Echtzeitübertragungen ohne Größenlimit",
      body: [
        "Da der Echtzeitmodus keine serverseitige Dateikopie und keinen Übertragungsverlauf behält, kommt die praktische Dateigrößengrenze von deinem eigenen Browser. In Chrome oder Edge streamt Relayium eingehende Daten direkt auf die Festplatte, sodass es faktisch kein Größenlimit gibt — mehrere Gigabyte große Videos und Projektarchive sind kein Problem.",
        "Firefox und Safari bieten dasselbe Streaming über die File System Access API nicht, dort hält der Browser die Datei im Arbeitsspeicher, wenn kein Streaming-Weg greift; Relayium warnt oberhalb von rund 256 MB, einer bewusst konservativen Schätzung und keiner gemessenen harten Grenze. Im selben LAN ist kein Konto nötig und die Geräte verbinden sich direkt. Über Netzwerkgrenzen hinweg meldet sich die Person an, die den Pairing-Code erstellt, und die Browsersitzung nutzt planmäßig ein verschlüsseltes TURN-Relay; wer per Code oder Link beitritt, braucht kein Konto. TURN transportiert Ende-zu-Ende-verschlüsselten Chiffretext, kann den Klartext aber weder lesen noch entschlüsseln. Bricht eine Verbindung mittendrin ab, wird die Übertragung fortgesetzt statt neu gestartet.",
      ],
    },
    {
      heading: "Wenn der Empfänger offline ist: Zero-Knowledge-Speicherlinks",
      body: [
        "Echtzeitübertragung setzt voraus, dass beide da sind — das eine, was WeTransfers Linkmodell besser macht. Also bietet Relayium denselben asynchronen Komfort, ohne die Privatsphäre aufzugeben: einen gespeicherten Download-Link.",
        "Dein Browser verschlüsselt die Dateien vor dem Hochladen mit AES-256-GCM, und der Entschlüsselungsschlüssel liegt nur im URL-Fragment — dem Teil nach dem #, den Browser nie an den Server senden. Der Server speichert daher Zero-Knowledge-Chiffretext, den er nicht lesen kann, und der Empfänger braucht zum Herunterladen kein Konto. Das Erstellen eines solchen Links erfordert die Anmeldung des Absenders, und jeder Link lässt sich so einstellen, dass er abläuft oder nach dem ersten Download vernichtet wird.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: [
        "Die wichtigsten Unterschiede nebeneinander:",
      ],
      bullets: [
        "Größenlimit: WeTransfers kostenloser Tarif begrenzt Übertragungen auf 2 GB; Relayium-Echtzeit hat kein serverseitiges Limit (Chrome/Edge streamen auf die Festplatte; muss der Browser stattdessen im Speicher puffern, warnt Relayium oberhalb von rund 256 MB).",
        "Wo Dateien liegen: WeTransfer speichert deine Datei auf seinen Servern; Relayium-Echtzeit behält keine serverseitige Dateikopie und keinen Übertragungsverlauf. Im selben LAN verbinden sich die Browser direkt, über Netzwerkgrenzen hinweg transportiert TURN planmäßig Ende-zu-Ende-Chiffretext, den es weder lesen noch entschlüsseln kann.",
        "Verschlüsselung: WeTransfer verschlüsselt beim Transport und im Ruhezustand, hält aber die Schlüssel; Relayium ist Ende-zu-Ende mit sechsstelligem SAS-Code, und Speicherlinks sind Zero-Knowledge mit dem Schlüssel nur im URL-Fragment.",
        "Empfänger offline: beide schaffen das — WeTransfer über seinen Speicherlink, Relayium über einen Zero-Knowledge-Download-Link mit Ablauf oder Burn-after-read.",
        "Integrität und Fortsetzen: Relayium prüft jede Datei mit SHA-256 und kann eine unterbrochene Übertragung fortsetzen statt neu zu beginnen.",
        "Kosten und Offenheit: Relayium ist kostenlos und AGPL-3.0-lizenziert unter github.com/relayium/relayium und läuft im Browser unter Windows, macOS, Linux, Android und iOS ohne Installation.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Gibt es wirklich kein Dateigrößenlimit?",
        a: "Im Echtzeitmodus gibt es kein serverseitiges Limit, weil Relayium keine serverseitige Dateikopie und keinen Übertragungsverlauf behält. Im selben LAN verbinden sich die Browser direkt; über Netzwerkgrenzen hinweg transportiert TURN planmäßig Ende-zu-Ende-Chiffretext, den es weder lesen noch entschlüsseln kann. In Chrome oder Edge streamt der Download direkt auf die Festplatte. Firefox oder Safari puffern im Arbeitsspeicher, wenn kein Streaming-Weg greift, und Relayium warnt oberhalb von rund 256 MB — eine bewusst konservative Schätzung, keine harte Grenze. Gespeicherte Download-Links haben ein an dein Konto gebundenes Kontingent.",
      },
      {
        q: "Was, wenn der Empfänger nicht online ist?",
        a: "Nutze einen gespeicherten Download-Link. Dein Browser verschlüsselt die Dateien mit AES-256-GCM, der Schlüssel bleibt nur im URL-Fragment, und der Server hält Zero-Knowledge-Chiffretext, den der Empfänger später abrufen kann. Das Erstellen des Links erfordert die Anmeldung des Absenders, und du kannst ihn auf Ablauf oder Vernichtung nach dem ersten Download einstellen.",
      },
      {
        q: "Ist Relayium kostenlos?",
        a: "Ja. Relayium ist kostenlos und quelloffen unter der AGPL-3.0-Lizenz, mit dem vollständigen Protokoll und Code unter github.com/relayium/relayium. Es gibt keinen Bezahltarif, um größere Echtzeitübertragungen freizuschalten — der Größenspielraum kommt vom Streaming auf die Festplatte im Browser, nicht von einem Abo.",
      },
    ],
  },
  cta: {
    text: "Sende jetzt eine große Datei — kein Größenlimit, keine Installation und im selben Netz kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs WeTransfer : gros fichiers en temps réel sans stockage côté serveur",
  description:
    "Un comparatif honnête de Relayium et WeTransfer. WeTransfer excelle au partage asynchrone par lien ; Relayium ajoute des transferts en temps réel sans copie de fichier ni historique côté serveur, et des liens stockés à divulgation nulle.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "WeTransfer a rendu l'envoi de gros fichiers sans effort : déposez un fichier, obtenez un lien, et le destinataire télécharge quand il est prêt — même s'il était hors ligne au moment de l'envoi. Cette expérience asynchrone, sans compte pour recevoir, est vraiment bonne, et c'est pourquoi tant de gens s'y fient.",
    "Cet article compare les deux équitablement. La force de WeTransfer est un partage soigné, basé sur des liens, où le fichier attend sur un serveur. Le temps réel de Relayium ne conserve ni copie du fichier ni historique côté serveur : sur le même LAN, les navigateurs se connectent directement ; entre réseaux, ils utilisent TURN par conception. S'y ajoute un lien stocké optionnel à divulgation nulle. Aucun n'est simplement meilleur — ils résolvent des problèmes légèrement différents.",
  ],
  sections: [
    {
      heading: "Ce que WeTransfer fait bien",
      body: [
        "L'idée centrale de WeTransfer est asynchrone : l'expéditeur téléverse une fois, obtient un lien, et le destinataire télécharge plus tard. Les deux n'ont jamais à être en ligne en même temps, exactement ce que vous voulez quand vous envoyez par e-mail une vidéo à un client qui l'ouvrira demain.",
        "Il est aussi mature et sans friction. Rien à installer, l'offre gratuite permet d'envoyer sans compte, et l'interface est réputée simple. Pour un partage occasionnel par lien dans la limite de taille, il fonctionne tout simplement.",
      ],
    },
    {
      heading: "Là où ils diffèrent : le fichier réside sur un serveur",
      body: [
        "Avec WeTransfer, votre fichier est téléversé sur ses serveurs, y est stocké un moment, puis téléchargé depuis là. L'offre gratuite plafonne chaque transfert à 2 Go, et le lien pointe vers une copie posée sur une infrastructure que vous ne contrôlez pas. Le transfert est chiffré en transit et au repos, mais il n'est pas à divulgation nulle : le service détient les clés et pourrait, en principe, lire le fichier.",
        "Le mode temps réel de Relayium ne conserve ni copie du fichier ni historique côté serveur, il n'y a donc aucune limite de taille côté serveur. Sur le même LAN, les navigateurs se connectent directement ; entre réseaux, ils utilisent un relais TURN par conception. TURN transporte le chiffré de bout en bout, mais ne peut ni lire ni déchiffrer le contenu en clair. Par-dessus WebRTC, Relayium ajoute X25519, AES-256-GCM par bloc, un code SAS à 6 chiffres et une vérification SHA-256 de bout en bout.",
      ],
    },
    {
      heading: "Des transferts en temps réel sans limite de taille",
      body: [
        "Comme le temps réel ne conserve ni copie du fichier ni historique côté serveur, la limite pratique de taille vient de votre propre navigateur. Dans Chrome ou Edge, Relayium diffuse les données entrantes directement sur le disque, il n'y a donc en pratique aucune limite de taille — des vidéos et archives de projet de plusieurs gigaoctets passent sans souci.",
        "Firefox et Safari n'offrent pas le même flux via l'API File System Access : quand aucun chemin d'écriture en flux ne s'applique, le navigateur garde le fichier en mémoire ; Relayium prévient au-delà d'environ 256 Mo, une estimation volontairement prudente et non une limite dure mesurée. Sur le même LAN, aucun compte n'est requis et les appareils se connectent directement. Entre réseaux, la personne qui crée le code d'appairage se connecte et la session navigateur utilise un relais TURN chiffré par conception ; celle qui rejoint avec le code ou le lien n'a pas besoin de compte. TURN transporte le chiffré de bout en bout, mais ne peut ni lire ni déchiffrer le contenu en clair. Si une connexion tombe en cours de route, le transfert reprend au lieu de recommencer.",
      ],
    },
    {
      heading: "Quand le destinataire est hors ligne : les liens stockés à divulgation nulle",
      body: [
        "Le transfert en temps réel exige que les deux soient présents, la seule chose que le modèle de lien de WeTransfer fait mieux. Alors Relayium offre le même confort asynchrone sans renoncer à la confidentialité : un lien de téléchargement stocké.",
        "Votre navigateur chiffre les fichiers en AES-256-GCM avant le téléversement, et la clé de déchiffrement ne vit que dans le fragment de l'URL — la partie après le #, que les navigateurs n'envoient jamais au serveur. Le serveur ne stocke donc qu'un texte chiffré à divulgation nulle qu'il ne peut pas lire, et le destinataire n'a pas besoin de compte pour télécharger. Créer un tel lien exige que l'expéditeur se connecte, et chaque lien peut être réglé pour expirer ou se détruire après le premier téléchargement.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: [
        "Les différences qui comptent le plus, côte à côte :",
      ],
      bullets: [
        "Limite de taille : l'offre gratuite de WeTransfer plafonne les transferts à 2 Go ; le temps réel de Relayium n'a aucune limite côté serveur (Chrome/Edge écrivent sur le disque ; quand le navigateur doit mettre en mémoire tampon, Relayium prévient au-delà d'environ 256 Mo).",
        "Où résident les fichiers : WeTransfer stocke votre fichier sur ses serveurs ; le temps réel de Relayium ne conserve ni copie du fichier ni historique côté serveur. Sur le même LAN, les navigateurs se connectent directement ; entre réseaux, TURN transporte par conception du chiffré de bout en bout qu'il ne peut ni lire ni déchiffrer.",
        "Chiffrement : WeTransfer chiffre en transit et au repos mais détient les clés ; Relayium est de bout en bout avec un code SAS à 6 chiffres, et les liens stockés sont à divulgation nulle avec la clé uniquement dans le fragment de l'URL.",
        "Destinataire hors ligne : les deux gèrent le cas — WeTransfer via son lien stocké, Relayium via un lien de téléchargement stocké à divulgation nulle avec autodestruction après lecture.",
        "Intégrité et reprise : Relayium vérifie chaque fichier par SHA-256 et peut reprendre un transfert interrompu au lieu de recommencer.",
        "Coût et ouverture : Relayium est gratuit et sous licence AGPL-3.0 sur github.com/relayium/relayium, et tourne dans le navigateur sur Windows, macOS, Linux, Android et iOS sans rien installer.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "N'y a-t-il vraiment aucune limite de taille de fichier ?",
        a: "En mode temps réel, il n'y a aucune limite côté serveur, car Relayium ne conserve ni copie du fichier ni historique côté serveur. Sur le même LAN, les navigateurs se connectent directement ; entre réseaux, TURN transporte par conception du chiffré de bout en bout qu'il ne peut ni lire ni déchiffrer. Dans Chrome ou Edge, le téléchargement s'écrit directement sur le disque. Dans Firefox ou Safari, le navigateur met en mémoire tampon quand aucun flux disque ne s'applique, et Relayium prévient au-delà d'environ 256 Mo — une estimation prudente, pas une limite dure. Les liens de téléchargement stockés ont un quota lié à votre compte.",
      },
      {
        q: "Que faire si le destinataire n'est pas en ligne ?",
        a: "Utilisez un lien de téléchargement stocké. Votre navigateur chiffre les fichiers en AES-256-GCM, la clé reste uniquement dans le fragment de l'URL, et le serveur conserve un texte chiffré à divulgation nulle que le destinataire pourra récupérer plus tard. Créer le lien exige que l'expéditeur se connecte, et vous pouvez le régler pour expirer ou se détruire après le premier téléchargement.",
      },
      {
        q: "Relayium est-il gratuit ?",
        a: "Oui. Relayium est gratuit et open source sous licence AGPL-3.0, avec l'intégralité du protocole et du code sur github.com/relayium/relayium. Il n'y a pas d'offre payante pour débloquer de plus gros transferts en temps réel — la marge de taille vient de la diffusion sur le disque dans le navigateur, pas d'un abonnement.",
      },
    ],
  },
  cta: {
    text: "Envoyez un gros fichier maintenant — sans limite de taille, sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل WeTransfer: نقل ملفات كبيرة فوريًا دون تخزينها على الخادم",
  description:
    "مقارنة صادقة بين Relayium وWeTransfer. WeTransfer رائع للمشاركة اللامتزامنة بالروابط؛ ويضيف Relayium نقلًا فوريًا بلا نسخة ملف أو سجل نقل على الخادم، وروابط مُخزَّنة بمعرفة صفرية.",
  updatedLabel: "آخر تحديث",
  lead: [
    "جعل WeTransfer إرسال الملفات الكبيرة يبدو بلا عناء: أفلِت ملفًا، واحصل على رابط، ويُنزّله المُستقبِل متى كان جاهزًا — حتى لو كان غير متصل حين أرسلته. هذه التجربة اللامتزامنة التي لا تتطلب حسابًا للاستقبال جيدة حقًا، وهي سبب لجوء كثير من الناس إليها.",
    "تقارن هذه المقالة الاثنين بإنصاف. قوة WeTransfer هي المشاركة المصقولة القائمة على الروابط، حيث ينتظر الملف على خادم. أما نقل Relayium الفوري فلا يحتفظ بنسخة من الملف أو سجل نقل على الخادم: تتصل المتصفحات مباشرةً على شبكة LAN نفسها، وتستخدم TURN بحكم التصميم عبر الشبكات. ويضيف أيضًا رابطًا مُخزَّنًا اختياريًا بمعرفة صفرية. لا أحدهما أفضل ببساطة — بل يحلّان مشكلتين مختلفتين قليلًا.",
  ],
  sections: [
    {
      heading: "ما يجيده WeTransfer",
      body: [
        "الفكرة الجوهرية لـ WeTransfer لامتزامنة: يرفع المُرسِل مرة واحدة، ويحصل على رابط، ويُنزّل المُستقبِل لاحقًا. لا يتعين على الشخصين أن يكونا متصلين في الوقت نفسه أبدًا، وهو بالضبط ما تريده حين ترسل فيديو بالبريد إلى عميل سيفتحه غدًا.",
        "وهو أيضًا ناضج وسلس. لا شيء لتثبيته، والفئة المجانية تتيح لك الإرسال دون حساب، والواجهة مشهورة ببساطتها. للمشاركة العارضة بالروابط ضمن حد حجمه، فإنه ببساطة يعمل.",
      ],
    },
    {
      heading: "أين يختلفان: الملف يعيش على خادم",
      body: [
        "مع WeTransfer، يُرفع ملفك إلى خوادمه، ويُخزَّن هناك مدة، ويُنزَّل من هناك. تحدّ الفئة المجانية كل نقل عند 2 GB، ويشير الرابط إلى نسخة موجودة على بنية تحتية لا تتحكم بها. النقل مُشفَّر أثناء العبور وفي حالة السكون، لكنه ليس بمعرفة صفرية: تحتفظ الخدمة بالمفاتيح ويمكنها، من حيث المبدأ، قراءة الملف.",
        "لا يحتفظ الوضع الفوري في Relayium بنسخة من الملف أو سجل نقل على الخادم، لذلك لا يوجد سقف حجم من جانب الخادم. تتصل المتصفحات مباشرةً على شبكة LAN نفسها؛ وعبر الشبكات تستخدم مُرحِّل TURN بحكم التصميم. يحمل TURN النص المشفَّر من الطرف إلى الطرف، لكنه لا يستطيع قراءة المحتوى الصريح أو فك تشفيره. وفوق WebRTC يضيف Relayium تبادل مفاتيح X25519 وAES-256-GCM لكل كتلة ورمز SAS من 6 أرقام وتحقق SHA-256 من الطرف إلى الطرف.",
      ],
    },
    {
      heading: "نقلات فورية بلا سقف حجم",
      body: [
        "لأن الوضع الفوري لا يحتفظ بنسخة من الملف أو سجل نقل على الخادم، فإن حد حجم الملف العملي يأتي من متصفحك أنت. في Chrome أو Edge، يبثّ Relayium البيانات الواردة مباشرةً إلى القرص، فلا سقف حجم فعليًا — فمقاطع الفيديو وأرشيفات المشاريع بحجم عدة غيغابايت لا مشكلة فيها.",
        "لا يقدّم Firefox وSafari البثّ نفسه عبر واجهة File System Access، فحين لا ينطبق أي مسار للكتابة التدفّقية يحتفظ المتصفح بالملف في الذاكرة؛ ويحذّر Relayium فوق نحو 256 MB، وهو تقدير متحفّظ عن قصد لا حدّ صلب مقيس. على شبكة LAN نفسها لا حاجة إلى حساب ويتصل الجهازان مباشرةً. وعبر الشبكات يسجّل منشئ رمز الاقتران الدخول، وتستخدم جلسة المتصفح مُرحِّل TURN مشفّرًا بحكم التصميم؛ ولا يحتاج من ينضم بالرمز أو الرابط إلى حساب. يحمل TURN النص المشفَّر من الطرف إلى الطرف، لكنه لا يستطيع قراءة المحتوى الصريح أو فك تشفيره. وإن سقط اتصال في منتصفه، يُستأنف النقل بدلًا من البدء من جديد.",
      ],
    },
    {
      heading: "عندما يكون المُستقبِل غير متصل: روابط مُخزَّنة بمعرفة صفرية",
      body: [
        "يتطلب النقل الفوري حضور الشخصين معًا، وهو الأمر الوحيد الذي يفعله نموذج روابط WeTransfer بشكل أفضل. لذا يقدّم Relayium الراحة اللامتزامنة نفسها دون التخلي عن الخصوصية: رابط تنزيل مُخزَّن.",
        "يشفّر متصفحك الملفات بـ AES-256-GCM قبل الرفع، ويعيش مفتاح فك التشفير في جزء الـ URL فقط — الجزء الذي يلي # والذي لا يرسله المتصفح إلى الخادم أبدًا. لذلك يخزّن الخادم نصًا مُشفَّرًا بمعرفة صفرية لا يستطيع قراءته، ولا يحتاج المُستقبِل إلى حساب للتنزيل. يتطلب إنشاء مثل هذا الرابط من المُرسِل تسجيل الدخول، ويمكن ضبط كل رابط لينتهي أو ليُحرَق بعد أول تنزيل.",
      ],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: [
        "أهم الفروق، جنبًا إلى جنب:",
      ],
      bullets: [
        "حد الحجم: تحدّ الفئة المجانية في WeTransfer النقلات عند 2 GB؛ بينما لا سقف من جانب الخادم للوضع الفوري في Relayium (يبثّ Chrome/Edge إلى القرص؛ وحين يضطر المتصفح إلى التخزين في الذاكرة يحذّر Relayium فوق نحو 256 MB).",
        "أين تعيش الملفات: يخزّن WeTransfer ملفك على خوادمه؛ أما الوضع الفوري في Relayium فلا يحتفظ بنسخة من الملف أو سجل نقل على الخادم. تتصل المتصفحات مباشرةً على شبكة LAN نفسها، وعبر الشبكات يحمل TURN بحكم التصميم نصًا مشفّرًا من الطرف إلى الطرف لا يستطيع قراءته أو فك تشفيره.",
        "التشفير: يشفّر WeTransfer أثناء العبور وفي حالة السكون لكنه يحتفظ بالمفاتيح؛ بينما Relayium من الطرف إلى الطرف برمز SAS من 6 أرقام، والروابط المُخزَّنة بمعرفة صفرية والمفتاح في جزء الـ URL فقط.",
        "المُستقبِل غير متصل: كلاهما يتعامل معها — WeTransfer عبر رابطه المُخزَّن، وRelayium عبر رابط تنزيل مُخزَّن بمعرفة صفرية مع انتهاء صلاحية أو حرق بعد التنزيل.",
        "السلامة والاستئناف: يتحقق Relayium من كل ملف بـ SHA-256 ويستطيع استئناف نقل منقطع بدلًا من إعادة البدء.",
        "التكلفة والانفتاح: Relayium مجاني ومرخّص بـ AGPL-3.0 على github.com/relayium/relayium، ويعمل في المتصفح على Windows وmacOS وLinux وAndroid وiOS دون أي شيء لتثبيته.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل لا يوجد حقًا حد لحجم الملف؟",
        a: "في الوضع الفوري لا يوجد سقف من جانب الخادم، لأن Relayium لا يحتفظ بنسخة من الملف أو سجل نقل على الخادم. تتصل المتصفحات مباشرةً على شبكة LAN نفسها؛ وعبر الشبكات يحمل TURN بحكم التصميم نصًا مشفّرًا من الطرف إلى الطرف لا يستطيع قراءته أو فك تشفيره. في Chrome أو Edge يُبثّ التنزيل مباشرةً إلى القرص. وفي Firefox أو Safari يخزّن المتصفح في الذاكرة حين لا يتاح البث إلى القرص، ويحذّر Relayium فوق نحو 256 MB — وهو تقدير متحفّظ، لا حدّ صلب. أما روابط التنزيل المُخزَّنة فلها حصة مرتبطة بحسابك.",
      },
      {
        q: "ماذا لو لم يكن المُستقبِل متصلًا؟",
        a: "استخدم رابط تنزيل مُخزَّن. يشفّر متصفحك الملفات بـ AES-256-GCM، ويبقى المفتاح في جزء الـ URL فقط، ويحتفظ الخادم بنص مُشفَّر بمعرفة صفرية يمكن للمُستقبِل جلبه لاحقًا. يتطلب إنشاء الرابط من المُرسِل تسجيل الدخول، ويمكنك ضبطه لينتهي أو ليُحرَق بعد أول تنزيل.",
      },
      {
        q: "هل Relayium مجاني؟",
        a: "نعم. Relayium مجاني ومفتوح المصدر بموجب ترخيص AGPL-3.0، مع البروتوكول والشيفرة كاملين على github.com/relayium/relayium. لا فئة مدفوعة لفتح نقلات فورية أكبر — فمتّسع الحجم يأتي من البث إلى القرص في المتصفح، لا من اشتراك.",
      },
    ],
  },
  cta: {
    text: "أرسل ملفًا كبيرًا الآن — بلا سقف حجم، وبلا تثبيت، وبلا حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium vs WeTransfer: archivos grandes en tiempo real sin almacenamiento en el servidor",
  description:
    "Una comparación honesta de Relayium y WeTransfer. WeTransfer es excelente para compartir enlaces de forma asíncrona; Relayium añade transferencias en tiempo real sin copia del archivo ni historial en el servidor, y enlaces almacenados de conocimiento cero.",
  updatedLabel: "Última actualización",
  lead: [
    "WeTransfer hizo que enviar archivos grandes pareciera sencillo: sueltas un archivo, obtienes un enlace y el destinatario descarga cuando esté listo, aunque estuviera desconectado cuando lo enviaste. Esa experiencia asíncrona, sin cuenta para recibir, es genuinamente buena, y es por lo que tanta gente recurre a ella.",
    "Este artículo compara ambos con justicia. La fuerza de WeTransfer es el uso compartido pulido, basado en enlaces, donde el archivo espera en un servidor. El tiempo real de Relayium no conserva copia del archivo ni historial en el servidor: en la misma LAN los navegadores se conectan directamente; entre redes usan TURN por diseño. También ofrece un enlace almacenado opcional de conocimiento cero. Ninguno es simplemente mejor: resuelven problemas ligeramente distintos.",
  ],
  sections: [
    {
      heading: "Qué hace bien WeTransfer",
      body: [
        "La idea central de WeTransfer es asíncrona: el remitente sube una vez, obtiene un enlace y el destinatario descarga más tarde. Las dos personas nunca tienen que estar en línea al mismo tiempo, que es exactamente lo que quieres cuando envías por correo un vídeo a un cliente que lo abrirá mañana.",
        "También es maduro y sin fricciones. No hay nada que instalar, el nivel gratuito te permite enviar sin cuenta y la interfaz es famosa por su sencillez. Para compartir enlaces de forma ocasional dentro de su límite de tamaño, simplemente funciona.",
      ],
    },
    {
      heading: "En qué se diferencian: el archivo vive en un servidor",
      body: [
        "Con WeTransfer, tu archivo se sube a sus servidores, se almacena allí un tiempo y se descarga desde allí. El nivel gratuito limita cada transferencia a 2 GB, y el enlace apunta a una copia alojada en una infraestructura que no controlas. La transferencia está cifrada en tránsito y en reposo, pero no es de conocimiento cero: el servicio guarda las claves y podría, en principio, leer el archivo.",
        "El modo en tiempo real de Relayium no conserva copia del archivo ni historial en el servidor, así que no hay un límite de tamaño del lado del servidor. En la misma LAN los navegadores se conectan directamente; entre redes usan un retransmisor TURN por diseño. TURN transporta texto cifrado de extremo a extremo, pero no puede leer ni descifrar el contenido en claro. Sobre WebRTC, Relayium añade X25519, AES-256-GCM por bloque, un código SAS de 6 dígitos y verificación SHA-256 de extremo a extremo.",
      ],
    },
    {
      heading: "Transferencias en tiempo real sin límite de tamaño",
      body: [
        "Como el tiempo real no conserva copia del archivo ni historial en el servidor, el límite práctico de tamaño viene de tu propio navegador. En Chrome o Edge, Relayium transmite los datos entrantes directamente al disco, así que prácticamente no hay límite de tamaño: vídeos de varios gigabytes y archivos comprimidos de proyectos van bien.",
        "Firefox y Safari no ofrecen ese mismo flujo mediante la API File System Access, así que cuando no se aplica ninguna vía de escritura en flujo el navegador guarda el archivo en memoria; Relayium avisa por encima de unos 256 MB, una estimación deliberadamente conservadora y no un límite duro medido. En la misma LAN no hace falta cuenta y los dispositivos se conectan directamente. Entre redes, quien crea el código de emparejamiento inicia sesión y la sesión del navegador usa un retransmisor TURN cifrado por diseño; quien se une con el código o enlace no necesita cuenta. TURN transporta texto cifrado de extremo a extremo, pero no puede leer ni descifrar el contenido en claro. Si una conexión se cae a mitad, la transferencia se reanuda en lugar de empezar de nuevo.",
      ],
    },
    {
      heading: "Cuando el destinatario está desconectado: enlaces almacenados de conocimiento cero",
      body: [
        "La transferencia en tiempo real necesita a ambas personas presentes, que es lo único que el modelo de enlaces de WeTransfer hace mejor. Así que Relayium ofrece la misma comodidad asíncrona sin renunciar a la privacidad: un enlace de descarga almacenado.",
        "Tu navegador cifra los archivos con AES-256-GCM antes de subirlos, y la clave de descifrado vive solo en el fragmento de la URL, la parte después del # que los navegadores nunca envían al servidor. Por tanto el servidor almacena texto cifrado de conocimiento cero que no puede leer, y el destinatario no necesita cuenta para descargar. Crear un enlace así exige que el remitente inicie sesión, y cada enlace puede configurarse para caducar o para autodestruirse tras la primera descarga.",
      ],
    },
    {
      heading: "Comparativa de funciones de un vistazo",
      body: [
        "Las diferencias que más importan, una al lado de la otra:",
      ],
      bullets: [
        "Límite de tamaño: el nivel gratuito de WeTransfer limita las transferencias a 2 GB; el tiempo real de Relayium no tiene límite del lado del servidor (Chrome/Edge escriben al disco; cuando el navegador tiene que almacenar en memoria, Relayium avisa por encima de unos 256 MB).",
        "Dónde viven los archivos: WeTransfer almacena tu archivo en sus servidores; el tiempo real de Relayium no conserva copia del archivo ni historial en el servidor. En la misma LAN los navegadores se conectan directamente; entre redes TURN transporta por diseño texto cifrado de extremo a extremo que no puede leer ni descifrar.",
        "Cifrado: WeTransfer cifra en tránsito y en reposo pero guarda las claves; Relayium es de extremo a extremo con un código SAS de 6 dígitos, y los enlaces almacenados son de conocimiento cero con la clave solo en el fragmento de la URL.",
        "Destinatario desconectado: ambos lo resuelven: WeTransfer con su enlace almacenado, Relayium con un enlace de descarga almacenado de conocimiento cero con destrucción tras la lectura o caducidad.",
        "Integridad y reanudación: Relayium verifica cada archivo con SHA-256 y puede reanudar una transferencia interrumpida en lugar de reiniciar.",
        "Coste y apertura: Relayium es gratis y está bajo licencia AGPL-3.0 en github.com/relayium/relayium, y se ejecuta en el navegador en Windows, macOS, Linux, Android e iOS sin nada que instalar.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿De verdad no hay límite de tamaño de archivo?",
        a: "En modo en tiempo real no hay límite del lado del servidor porque Relayium no conserva copia del archivo ni historial en el servidor. En la misma LAN los navegadores se conectan directamente; entre redes TURN transporta por diseño texto cifrado de extremo a extremo que no puede leer ni descifrar. En Chrome o Edge la descarga se escribe directamente al disco. En Firefox o Safari el navegador almacena en memoria cuando no hay flujo a disco, y Relayium avisa por encima de unos 256 MB: una estimación conservadora, no un límite duro. Los enlaces almacenados tienen una cuota ligada a tu cuenta.",
      },
      {
        q: "¿Qué pasa si el destinatario no está en línea?",
        a: "Usa un enlace de descarga almacenado. Tu navegador cifra los archivos con AES-256-GCM, la clave queda solo en el fragmento de la URL, y el servidor guarda texto cifrado de conocimiento cero que el destinatario puede recuperar más tarde. Crear el enlace exige que el remitente inicie sesión, y puedes configurarlo para que caduque o se autodestruya tras la primera descarga.",
      },
      {
        q: "¿Relayium es gratis?",
        a: "Sí. Relayium es gratis y de código abierto bajo la licencia AGPL-3.0, con el protocolo y el código completos en github.com/relayium/relayium. No hay nivel de pago para desbloquear transferencias en tiempo real más grandes: el margen de tamaño viene de transmitir al disco en el navegador, no de una suscripción.",
      },
    ],
  },
  cta: {
    text: "Envía un archivo grande ahora mismo: sin límite de tamaño, sin instalación y sin necesidad de cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs WeTransfer: arquivos grandes em tempo real sem armazenamento no servidor",
  description:
    "Uma comparação honesta de Relayium e WeTransfer. O WeTransfer é ótimo para compartilhar links de forma assíncrona; o Relayium adiciona transferências em tempo real sem cópia do arquivo nem histórico no servidor, e links armazenados de conhecimento zero.",
  updatedLabel: "Última atualização",
  lead: [
    "O WeTransfer fez o envio de arquivos grandes parecer sem esforço: solte um arquivo, receba um link e o destinatário baixa quando estiver pronto — mesmo que estivesse offline quando você enviou. Essa experiência assíncrona, sem conta para receber, é genuinamente boa, e é por isso que tanta gente recorre a ela.",
    "Este artigo compara os dois com justiça. A força do WeTransfer é o compartilhamento polido, baseado em links, em que o arquivo espera num servidor. O tempo real do Relayium não mantém cópia do arquivo nem histórico no servidor: na mesma LAN os navegadores se conectam diretamente; entre redes usam TURN por projeto. Há também um link armazenado opcional de conhecimento zero. Nenhum é simplesmente melhor — eles resolvem problemas ligeiramente diferentes.",
  ],
  sections: [
    {
      heading: "O que o WeTransfer faz bem",
      body: [
        "A ideia central do WeTransfer é assíncrona: o remetente envia uma vez, recebe um link e o destinatário baixa mais tarde. As duas pessoas nunca precisam estar online ao mesmo tempo, que é exatamente o que você quer quando manda por e-mail um vídeo a um cliente que vai abri-lo amanhã.",
        "Também é maduro e sem atrito. Não há nada para instalar, o nível gratuito permite enviar sem conta e a interface é famosa por ser simples. Para compartilhar links de vez em quando dentro do limite de tamanho, ele simplesmente funciona.",
      ],
    },
    {
      heading: "Onde eles diferem: o arquivo vive num servidor",
      body: [
        "Com o WeTransfer, seu arquivo é enviado para os servidores dele, armazenado ali por um tempo e baixado de lá. O nível gratuito limita cada transferência a 2 GB, e o link aponta para uma cópia hospedada numa infraestrutura que você não controla. A transferência é criptografada em trânsito e em repouso, mas não é de conhecimento zero: o serviço guarda as chaves e poderia, em princípio, ler o arquivo.",
        "O modo em tempo real do Relayium não mantém cópia do arquivo nem histórico no servidor, então não há limite de tamanho do lado do servidor. Na mesma LAN os navegadores se conectam diretamente; entre redes usam um retransmissor TURN por projeto. O TURN transporta texto cifrado de ponta a ponta, mas não consegue ler nem descriptografar o conteúdo em claro. Sobre o WebRTC, o Relayium adiciona X25519, AES-256-GCM por bloco, código SAS de 6 dígitos e verificação SHA-256 de ponta a ponta.",
      ],
    },
    {
      heading: "Transferências em tempo real sem limite de tamanho",
      body: [
        "Como o tempo real não mantém cópia do arquivo nem histórico no servidor, o limite prático de tamanho vem do seu navegador. No Chrome ou no Edge, o Relayium transmite os dados recebidos direto para o disco, então praticamente não há limite de tamanho — vídeos de vários gigabytes e arquivos compactados de projetos vão bem.",
        "Firefox e Safari não oferecem esse mesmo fluxo pela API File System Access, então, quando nenhum caminho de gravação em fluxo se aplica, o navegador guarda o arquivo na memória; o Relayium avisa acima de cerca de 256 MB, uma estimativa deliberadamente conservadora e não um limite rígido medido. Na mesma LAN não é preciso conta e os dispositivos se conectam diretamente. Entre redes, quem cria o código de emparelhamento faz login e a sessão do navegador usa um retransmissor TURN criptografado por projeto; quem participa com o código ou link não precisa de conta. O TURN transporta texto cifrado de ponta a ponta, mas não consegue ler nem descriptografar o conteúdo em claro. Se uma conexão cai no meio, a transferência retoma em vez de começar de novo.",
      ],
    },
    {
      heading: "Quando o destinatário está offline: links armazenados de conhecimento zero",
      body: [
        "A transferência em tempo real precisa das duas pessoas presentes, que é a única coisa que o modelo de links do WeTransfer faz melhor. Então o Relayium oferece a mesma comodidade assíncrona sem abrir mão da privacidade: um link de download armazenado.",
        "Seu navegador criptografa os arquivos com AES-256-GCM antes do envio, e a chave de descriptografia vive só no fragmento da URL — a parte depois do # que os navegadores nunca enviam ao servidor. O servidor, portanto, armazena texto cifrado de conhecimento zero que não consegue ler, e o destinatário não precisa de conta para baixar. Criar um link assim exige que o remetente entre, e cada link pode ser configurado para expirar ou para se autodestruir após o primeiro download.",
      ],
    },
    {
      heading: "Comparativo de recursos em resumo",
      body: [
        "As diferenças que mais importam, lado a lado:",
      ],
      bullets: [
        "Limite de tamanho: o nível gratuito do WeTransfer limita as transferências a 2 GB; o tempo real do Relayium não tem limite do lado do servidor (Chrome/Edge gravam no disco; quando o navegador precisa armazenar na memória, o Relayium avisa acima de cerca de 256 MB).",
        "Onde os arquivos vivem: o WeTransfer armazena seu arquivo nos servidores dele; o tempo real do Relayium não mantém cópia do arquivo nem histórico no servidor. Na mesma LAN os navegadores se conectam diretamente; entre redes o TURN transporta por projeto texto cifrado de ponta a ponta que não consegue ler nem descriptografar.",
        "Criptografia: o WeTransfer criptografa em trânsito e em repouso, mas guarda as chaves; o Relayium é de ponta a ponta com um código SAS de 6 dígitos, e os links armazenados são de conhecimento zero com a chave só no fragmento da URL.",
        "Destinatário offline: os dois lidam com isso — o WeTransfer via seu link armazenado, o Relayium via um link de download armazenado de conhecimento zero com expiração ou autodestruição após a leitura.",
        "Integridade e retomada: o Relayium verifica cada arquivo com SHA-256 e pode retomar uma transferência interrompida em vez de reiniciar.",
        "Custo e abertura: o Relayium é gratuito e licenciado sob AGPL-3.0 em github.com/relayium/relayium, e roda no navegador em Windows, macOS, Linux, Android e iOS sem nada para instalar.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Realmente não há limite de tamanho de arquivo?",
        a: "No modo em tempo real não há limite do lado do servidor porque o Relayium não mantém cópia do arquivo nem histórico no servidor. Na mesma LAN os navegadores se conectam diretamente; entre redes o TURN transporta por projeto texto cifrado de ponta a ponta que não consegue ler nem descriptografar. No Chrome ou no Edge o download é gravado direto no disco. No Firefox ou no Safari o navegador guarda na memória quando não há fluxo para o disco, e o Relayium avisa acima de cerca de 256 MB — uma estimativa conservadora, não um limite rígido. Os links armazenados têm uma cota ligada à sua conta.",
      },
      {
        q: "E se o destinatário não estiver online?",
        a: "Use um link de download armazenado. Seu navegador criptografa os arquivos com AES-256-GCM, a chave fica só no fragmento da URL, e o servidor guarda texto cifrado de conhecimento zero que o destinatário pode buscar depois. Criar o link exige que o remetente entre, e você pode configurá-lo para expirar ou se autodestruir após o primeiro download.",
      },
      {
        q: "O Relayium é gratuito?",
        a: "Sim. O Relayium é gratuito e de código aberto sob a licença AGPL-3.0, com o protocolo e o código completos em github.com/relayium/relayium. Não há nível pago para desbloquear transferências em tempo real maiores — a folga de tamanho vem da transmissão para o disco no navegador, não de uma assinatura.",
      },
    ],
  },
  cta: {
    text: "Envie um arquivo grande agora mesmo — sem limite de tamanho, sem instalação e sem precisar de conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/wetransfer",
  published: "2026-07-03",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
