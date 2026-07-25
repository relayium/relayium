// web/scripts/pages/content/articles/compare-wetransfer.mjs
// Objective comparison: Relayium vs WeTransfer. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "Relayium vs WeTransfer: send large files without the server",
  description:
    "An honest comparison of Relayium and WeTransfer. WeTransfer is great for asynchronous link sharing; Relayium adds size-cap-free realtime transfers that never touch a server and zero-knowledge stored links.",
  updatedLabel: "Last updated",
  lead: [
    "WeTransfer made sending big files feel effortless: drop a file, get a link, and the recipient downloads whenever they are ready — even if they were offline when you sent it. That asynchronous, no-account-to-receive experience is genuinely good, and it is why so many people reach for it.",
    "This article compares the two fairly. WeTransfer's strength is polished, link-based sharing where the file waits on a server. Relayium's focus is different: realtime transfers that go directly between devices with no size cap and never land on a server, plus an optional stored link that stays zero-knowledge encrypted. Neither is simply better — they solve slightly different problems.",
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
        "Relayium's realtime mode works the other way around. Bytes flow directly between the two devices over an encrypted peer-to-peer channel and are never parked on a server, so there is no server-side size cap to hit. On top of the WebRTC transport, Relayium adds its own layer: an X25519 key exchange derives a key for per-chunk AES-256-GCM, both devices show a matching 6-digit verification code (SAS) to rule out a man-in-the-middle, and each file is checked end-to-end with a SHA-256 hash.",
      ],
    },
    {
      heading: "Realtime transfers with no size cap",
      body: [
        "Because nothing is stored on a server, the practical file-size limit comes from your own browser. In Chrome or Edge, Relayium streams incoming data straight to disk, so there is effectively no size cap — multi-gigabyte videos and project archives are fine.",
        "Firefox and Safari do not yet offer the same streaming download, so there the browser buffers the file in memory; keep those transfers under about 200 MB for a smooth experience. On the same network, realtime transfers need no account: open relayium.com on both devices, pick up to 1,000 files, verify the code, and send. Sending across networks with a pairing code requires the sender to sign in — the recipient never needs an account. If a connection drops mid-way, the transfer resumes instead of starting over, and when a direct link is impossible it falls back to an encrypted TURN relay that only ever sees ciphertext.",
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
        "Size limit: WeTransfer's free tier caps transfers at 2 GB; Relayium realtime has no server-side cap (Chrome/Edge stream to disk; keep Firefox/Safari under ~200 MB).",
        "Where files live: WeTransfer stores your file on its servers; Relayium realtime never puts the file on a server at all.",
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
        a: "In realtime mode there is no server-side cap, because the file never touches a server. In Chrome or Edge the download streams straight to disk, so multi-gigabyte files are fine. Firefox and Safari buffer in memory instead, so keep those transfers under about 200 MB. Stored download links have a quota tied to your account.",
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
  title: "Relayium 对比 WeTransfer：不经服务器传大文件",
  description:
    "客观对比 Relayium 与 WeTransfer。WeTransfer 擅长异步链接分享；Relayium 的实时模式无大小上限、文件不落服务器，还有零知识加密的存储下载链接。",
  updatedLabel: "最近更新",
  lead: [
    "WeTransfer 让发送大文件变得轻松：拖入文件、拿到链接，对方随时下载——哪怕你发送时对方并不在线。这种异步、收件方无需账号的体验确实很好，也正是许多人选择它的原因。",
    "本文客观对比这两者。WeTransfer 的长处是成熟的、基于链接的分享，文件在服务器上等待被下载。Relayium 的重点不同：实时传输在设备之间直连，无大小上限、也从不落到服务器上；此外还有一个可选的、始终零知识加密的存储链接。两者并非谁更好，而是各自解决略有不同的问题。",
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
        "Relayium 的实时模式恰好相反。字节通过加密的点对点通道在两台设备之间直接流动，从不停留在服务器上，因此不存在服务器端的大小上限。在 WebRTC 传输之上，Relayium 再加一层：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密；两台设备显示一致的 6 位校验码（SAS）以排除中间人；每个文件都用 SHA-256 做端到端校验。",
      ],
    },
    {
      heading: "无大小上限的实时传输",
      body: [
        "因为不在服务器上存储任何东西，实际的文件大小上限取决于你自己的浏览器。在 Chrome 或 Edge 中，Relayium 会把接收的数据直接流式写入磁盘，所以基本没有大小上限——几 GB 的视频和工程压缩包都没问题。",
        "Firefox 和 Safari 目前还不支持同样的流式下载，因此浏览器会把文件缓冲在内存里；这类传输建议保持在约 200 MB 以内以获得顺滑体验。同一网络下实时传输无需账号：在两台设备上打开 relayium.com，最多选 1,000 个文件，核对校验码，然后发送。跨网络用配对码传输则需要发送方登录——接收方始终无需账号。若连接中途断开，传输会断点续传而非从头再来；当无法直连时，会退回到加密的 TURN 中继，而中继只能看到密文。",
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
        "大小上限：WeTransfer 免费档每次传输上限 2 GB；Relayium 实时模式无服务器端上限（Chrome/Edge 流式写盘；Firefox/Safari 建议保持在约 200 MB 以内）。",
        "文件存放：WeTransfer 把文件存在它的服务器上；Relayium 实时模式根本不把文件放到服务器上。",
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
        a: "实时模式下没有服务器端上限，因为文件从不经过服务器。在 Chrome 或 Edge 中，下载会直接流式写入磁盘，所以几 GB 的文件都没问题；Firefox 和 Safari 则会缓冲在内存里，因此建议这类传输保持在约 200 MB 以内。存储下载链接则有与账号绑定的配额。",
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
  title: "Relayium と WeTransfer の比較：サーバーを介さず大容量を送る",
  description:
    "Relayium と WeTransfer を公平に比較。WeTransfer は非同期のリンク共有が得意です。Relayium はサイズ上限のないリアルタイム転送でサーバーに置かず、ゼロ知識の保存リンクも備えます。",
  updatedLabel: "最終更新",
  lead: [
    "WeTransfer は大きなファイルの送信を簡単にしました。ファイルをドロップしてリンクを受け取れば、相手は好きなときにダウンロードできます——送った時点で相手がオフラインでも大丈夫です。この非同期で、受け取りにアカウントが要らない体験は本当に優れており、多くの人が選ぶ理由です。",
    "本記事はこの2つを公平に比較します。WeTransfer の強みは、ファイルがサーバー上で待つ洗練されたリンクベースの共有です。Relayium の焦点は異なります。端末間を直接つなぐリアルタイム転送はサイズ上限がなく、サーバーに置かれません。加えて、常にゼロ知識で暗号化される任意の保存リンクもあります。どちらが単純に優れているわけではなく、少し異なる問題を解いています。",
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
        "Relayium のリアルタイムモードは逆の仕組みです。バイトは暗号化された P2P チャネルを通じて2台の端末間を直接流れ、サーバーに置かれることはないため、サーバー側のサイズ上限は存在しません。WebRTC の転送の上に、Relayium は独自の層を加えます。X25519 の鍵交換でブロックごとの AES-256-GCM 用の鍵を導出し、両方の端末が一致する6桁の検証コード（SAS）を表示して中間者を排除し、各ファイルを SHA-256 ハッシュでエンドツーエンドに検証します。",
      ],
    },
    {
      heading: "サイズ上限のないリアルタイム転送",
      body: [
        "サーバーに何も保存しないため、実用上のファイルサイズ上限は自分のブラウザ次第です。Chrome や Edge では、Relayium は受信データをそのままディスクにストリーミングするので、事実上サイズ上限はありません——数ギガバイトの動画やプロジェクトのアーカイブも問題ありません。",
        "Firefox と Safari は同じストリーミングダウンロードにまだ対応していないため、ブラウザはファイルをメモリにバッファします。快適に使うにはそうした転送を約 200 MB 以内に抑えてください。同じネットワークならリアルタイム転送にアカウントは不要です。両方の端末で relayium.com を開き、最大1,000ファイルを選び、コードを照合して送ります。ネットワークをまたいでペアリングコードで送る場合は送信側のサインインが必要です——受信側はどちらの場合もアカウント不要です。途中で接続が切れても、転送は最初からではなく再開します。直接接続が不可能なときは暗号化された TURN リレーにフォールバックし、リレーは暗号文しか見ません。",
      ],
    },
    {
      heading: "受信側がオフラインのとき：ゼロ知識の保存リンク",
      body: [
        "リアルタイム転送は双方が同席している必要があり、これは WeTransfer のリンク方式が優れている唯一の点です。そこで Relayium は、プライバシーを犠牲にせずに同じ非同期の便利さを提供します。保存型ダウンロードリンクです。",
        "ブラウザがアップロード前にファイルを AES-256-GCM で暗号化し、復号鍵は URL フラグメント——# の後の、ブラウザがサーバーに決して送らない部分——にだけ存在します。したがってサーバーは読めないゼロ知識の暗号文を保存し、受信側はアカウントなしでダウンロードできます。こうしたリンクの作成には送信側のサインインが必要で、各リンクは有効期限切れ、または最初のダウンロード後に消去するよう設定できます。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: [
        "最も重要な違いを並べて示します。",
      ],
      bullets: [
        "サイズ上限：WeTransfer の無料枠は転送を 2 GB に制限；Relayium のリアルタイムはサーバー側の上限なし（Chrome/Edge はディスクへストリーミング、Firefox/Safari は約 200 MB 以内に）。",
        "ファイルの置き場所：WeTransfer はファイルをサーバーに保存；Relayium のリアルタイムはファイルをサーバーに一切置かない。",
        "暗号化：WeTransfer は通信中も保存時も暗号化するが鍵を保持；Relayium は6桁の SAS コード付きのエンドツーエンドで、保存リンクは鍵が URL フラグメントだけにあるゼロ知識。",
        "受信側がオフライン：どちらも対応——WeTransfer は保存リンク、Relayium は有効期限やダウンロード後消去付きのゼロ知識保存ダウンロードリンク。",
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
        a: "リアルタイムモードではサーバー側の上限はありません。ファイルがサーバーに一切触れないからです。Chrome や Edge ではダウンロードがそのままディスクにストリーミングされるので、数ギガバイトのファイルも問題ありません。Firefox と Safari はメモリにバッファするため、そうした転送は約 200 MB 以内に抑えてください。保存型ダウンロードリンクにはアカウントに紐づく容量枠があります。",
      },
      {
        q: "受信側がオンラインでないときは？",
        a: "保存型ダウンロードリンクを使います。ブラウザがファイルを AES-256-GCM で暗号化し、鍵は URL フラグメントだけに残り、サーバーは受信側が後で取得できるゼロ知識の暗号文を保持します。リンクの作成には送信側のサインインが必要で、有効期限切れや最初のダウンロード後の消去を設定できます。",
      },
      {
        q: "Relayium は無料ですか？",
        a: "はい。Relayium は AGPL-3.0 ライセンスの無料オープンソースで、プロトコルとコードのすべてが github.com/relayium/relayium にあります。より大きなリアルタイム転送を解放する有料プランはありません——大容量の余裕はブラウザのディスクへのストリーミングから来るものであり、サブスクリプションからではありません。",
      },
    ],
  },
  cta: {
    text: "今すぐ大容量ファイルを送ってみてください——サイズ上限なし、インストール不要、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs WeTransfer: 서버 없이 대용량 파일 보내기",
  description:
    "Relayium과 WeTransfer를 공정하게 비교합니다. WeTransfer는 비동기 링크 공유에 강하고, Relayium은 크기 제한 없이 서버를 거치지 않는 실시간 전송과 영지식 저장 링크를 제공합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "WeTransfer는 큰 파일 보내기를 손쉽게 만들었습니다. 파일을 끌어다 놓고 링크를 받으면 상대는 원할 때 다운로드합니다——보낼 때 상대가 오프라인이어도 괜찮습니다. 이런 비동기적이고 받는 데 계정이 필요 없는 경험은 정말 훌륭하며, 많은 사람이 선택하는 이유입니다.",
    "이 글은 두 가지를 공정하게 비교합니다. WeTransfer의 강점은 파일이 서버에서 기다리는 세련된 링크 기반 공유입니다. Relayium의 초점은 다릅니다. 기기 사이를 직접 잇는 실시간 전송은 크기 제한이 없고 서버에 놓이지 않습니다. 여기에 항상 영지식으로 암호화되는 선택적 저장 링크도 있습니다. 어느 하나가 단순히 낫다기보다, 조금 다른 문제를 풉니다.",
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
        "WeTransfer에서는 파일이 그 서버에 업로드되어 한동안 저장되고 거기서 다운로드됩니다. 무료 등급은 전송 한 건을 2 GB로 제한하며, 링크는 당신이 통제할 수 없는 인프라 위의 사본을 가리킵니다. 전송은 전송 중과 저장 시 모두 암호화되지만 영지식은 아닙니다. 서비스가 키를 쥐고 있어 원칙적으로 파일을 읽을 수 있습니다.",
        "Relayium의 실시간 모드는 그 반대입니다. 바이트는 암호화된 P2P 채널을 통해 두 기기 사이를 직접 흐르며 서버에 놓이지 않으므로, 서버 측 크기 제한이 존재하지 않습니다. WebRTC 전송 위에 Relayium은 자체 계층을 더합니다. X25519 키 교환으로 블록별 AES-256-GCM용 키를 도출하고, 두 기기가 일치하는 6자리 검증 코드(SAS)를 표시해 중간자를 배제하며, 각 파일을 SHA-256 해시로 종단간 검증합니다.",
      ],
    },
    {
      heading: "크기 제한 없는 실시간 전송",
      body: [
        "서버에 아무것도 저장하지 않기 때문에, 실질적인 파일 크기 제한은 자신의 브라우저에서 옵니다. Chrome이나 Edge에서는 Relayium이 들어오는 데이터를 곧바로 디스크로 스트리밍하므로 사실상 크기 제한이 없습니다——수 기가바이트의 동영상과 프로젝트 아카이브도 괜찮습니다.",
        "Firefox와 Safari는 아직 같은 스트리밍 다운로드를 제공하지 않아 브라우저가 파일을 메모리에 버퍼링합니다. 이런 전송은 원활한 경험을 위해 약 200 MB 이내로 유지하세요. 같은 네트워크에서는 실시간 전송에 계정이 필요 없습니다. 두 기기에서 relayium.com을 열고, 최대 1,000개 파일을 고르고, 코드를 대조한 뒤 보냅니다. 페어링 코드로 네트워크를 넘어 보낼 때는 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 어느 경우든 계정이 필요 없습니다. 도중에 연결이 끊겨도 전송은 처음부터가 아니라 이어서 재개됩니다. 직접 연결이 불가능할 때는 암호화된 TURN 릴레이로 폴백하며, 릴레이는 암호문만 봅니다.",
      ],
    },
    {
      heading: "받는 쪽이 오프라인일 때: 영지식 저장 링크",
      body: [
        "실시간 전송은 양쪽이 함께 있어야 하는데, 이것이 WeTransfer의 링크 방식이 더 잘하는 유일한 점입니다. 그래서 Relayium은 프라이버시를 포기하지 않고 같은 비동기 편의를 제공합니다. 저장형 다운로드 링크입니다.",
        "브라우저가 업로드 전에 파일을 AES-256-GCM으로 암호화하고, 복호화 키는 URL 프래그먼트——# 뒤의, 브라우저가 서버로 결코 보내지 않는 부분——에만 존재합니다. 따라서 서버는 읽을 수 없는 영지식 암호문을 저장하고, 받는 쪽은 계정 없이 다운로드할 수 있습니다. 이런 링크 생성에는 보내는 쪽의 로그인이 필요하며, 각 링크는 만료되거나 첫 다운로드 후 소각되도록 설정할 수 있습니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: [
        "가장 중요한 차이를 나란히 정리하면:",
      ],
      bullets: [
        "크기 제한: WeTransfer 무료 등급은 전송을 2 GB로 제한; Relayium 실시간은 서버 측 제한 없음(Chrome/Edge는 디스크로 스트리밍, Firefox/Safari는 약 200 MB 이내로).",
        "파일이 놓이는 곳: WeTransfer는 파일을 서버에 저장; Relayium 실시간은 파일을 서버에 전혀 두지 않음.",
        "암호화: WeTransfer는 전송 중과 저장 시 암호화하지만 키를 보유; Relayium은 6자리 SAS 코드가 있는 종단간 암호화이고, 저장 링크는 키가 URL 프래그먼트에만 있는 영지식.",
        "받는 쪽 오프라인: 둘 다 대응——WeTransfer는 저장 링크, Relayium은 만료나 다운로드 후 소각이 가능한 영지식 저장 다운로드 링크.",
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
        a: "실시간 모드에는 서버 측 제한이 없습니다. 파일이 서버에 전혀 닿지 않기 때문입니다. Chrome이나 Edge에서는 다운로드가 곧바로 디스크로 스트리밍되어 수 기가바이트 파일도 괜찮습니다. Firefox와 Safari는 메모리에 버퍼링하므로 이런 전송은 약 200 MB 이내로 유지하세요. 저장형 다운로드 링크에는 계정에 연결된 용량 한도가 있습니다.",
      },
      {
        q: "받는 쪽이 접속해 있지 않으면요?",
        a: "저장형 다운로드 링크를 쓰세요. 브라우저가 파일을 AES-256-GCM으로 암호화하고, 키는 URL 프래그먼트에만 남으며, 서버는 받는 쪽이 나중에 가져갈 수 있는 영지식 암호문을 보관합니다. 링크 생성에는 보내는 쪽의 로그인이 필요하며, 만료나 첫 다운로드 후 소각을 설정할 수 있습니다.",
      },
      {
        q: "Relayium은 무료인가요?",
        a: "네. Relayium은 AGPL-3.0 라이선스의 무료 오픈소스이며, 프로토콜과 코드 전체가 github.com/relayium/relayium에 있습니다. 더 큰 실시간 전송을 여는 유료 등급은 없습니다——대용량 여유는 브라우저의 디스크 스트리밍에서 오는 것이지 구독에서 오는 것이 아닙니다.",
      },
    ],
  },
  cta: {
    text: "지금 대용량 파일을 보내보세요——크기 제한 없이, 설치 없이, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. WeTransfer: große Dateien ohne Server senden",
  description:
    "Ein ehrlicher Vergleich von Relayium und WeTransfer. WeTransfer glänzt beim asynchronen Teilen per Link; Relayium bietet Echtzeitübertragungen ohne Größenlimit, ohne Server, plus Zero-Knowledge-Speicherlinks.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "WeTransfer hat das Versenden großer Dateien mühelos gemacht: Datei ablegen, Link erhalten, und der Empfänger lädt herunter, wann er bereit ist — selbst wenn er beim Senden offline war. Dieses asynchrone Erlebnis, bei dem man zum Empfangen kein Konto braucht, ist wirklich gut und der Grund, warum so viele darauf zurückgreifen.",
    "Dieser Artikel vergleicht die beiden fair. WeTransfers Stärke ist ausgereiftes, linkbasiertes Teilen, bei dem die Datei auf einem Server wartet. Relayiums Fokus ist ein anderer: Echtzeitübertragungen laufen direkt zwischen den Geräten, ohne Größenlimit, und landen nie auf einem Server; dazu kommt ein optionaler Speicherlink, der stets Zero-Knowledge-verschlüsselt bleibt. Keines ist einfach besser — sie lösen leicht unterschiedliche Probleme.",
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
        "Relayiums Echtzeitmodus funktioniert umgekehrt. Die Bytes fließen über einen verschlüsselten Peer-to-Peer-Kanal direkt zwischen den beiden Geräten und werden nie auf einem Server abgelegt, also gibt es kein serverseitiges Größenlimit. Über dem WebRTC-Transport fügt Relayium eine eigene Schicht hinzu: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, beide Geräte zeigen einen übereinstimmenden sechsstelligen Prüfcode (SAS), um einen Man-in-the-Middle auszuschließen, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft.",
      ],
    },
    {
      heading: "Echtzeitübertragungen ohne Größenlimit",
      body: [
        "Da nichts auf einem Server gespeichert wird, kommt die praktische Dateigrößengrenze von deinem eigenen Browser. In Chrome oder Edge streamt Relayium eingehende Daten direkt auf die Festplatte, sodass es faktisch kein Größenlimit gibt — mehrere Gigabyte große Videos und Projektarchive sind kein Problem.",
        "Firefox und Safari bieten denselben Streaming-Download noch nicht, dort puffert der Browser die Datei im Arbeitsspeicher; halte solche Übertragungen für ein flüssiges Erlebnis unter etwa 200 MB. Im selben Netz brauchen Echtzeitübertragungen kein Konto: Öffne relayium.com auf beiden Geräten, wähle bis zu 1.000 Dateien, prüfe den Code und sende. Beim Senden über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden — der Empfänger braucht in beiden Fällen kein Konto. Bricht eine Verbindung mittendrin ab, wird die Übertragung fortgesetzt statt neu gestartet, und ist eine Direktverbindung unmöglich, weicht sie auf ein verschlüsseltes TURN-Relay aus, das nur Chiffretext sieht.",
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
        "Größenlimit: WeTransfers kostenloser Tarif begrenzt Übertragungen auf 2 GB; Relayium-Echtzeit hat kein serverseitiges Limit (Chrome/Edge streamen auf die Festplatte; Firefox/Safari unter ~200 MB halten).",
        "Wo Dateien liegen: WeTransfer speichert deine Datei auf seinen Servern; Relayium-Echtzeit legt die Datei überhaupt nicht auf einem Server ab.",
        "Verschlüsselung: WeTransfer verschlüsselt beim Transport und im Ruhezustand, hält aber die Schlüssel; Relayium ist Ende-zu-Ende mit sechsstelligem SAS-Code, und Speicherlinks sind Zero-Knowledge mit dem Schlüssel nur im URL-Fragment.",
        "Empfänger offline: beide schaffen das — WeTransfer über seinen Speicherlink, Relayium über einen Zero-Knowledge-Download-Link mit Ablauf oder Vernichtung nach dem Download.",
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
        a: "Im Echtzeitmodus gibt es kein serverseitiges Limit, weil die Datei nie einen Server berührt. In Chrome oder Edge streamt der Download direkt auf die Festplatte, sodass mehrere Gigabyte große Dateien kein Problem sind. Firefox und Safari puffern stattdessen im Arbeitsspeicher, halte solche Übertragungen also unter etwa 200 MB. Gespeicherte Download-Links haben ein an dein Konto gebundenes Kontingent.",
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
  title: "Relayium vs WeTransfer : envoyer de gros fichiers sans serveur",
  description:
    "Un comparatif honnête de Relayium et WeTransfer. WeTransfer excelle au partage asynchrone par lien ; Relayium ajoute des transferts en temps réel sans limite de taille, sans serveur, et des liens stockés à divulgation nulle.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "WeTransfer a rendu l'envoi de gros fichiers sans effort : déposez un fichier, obtenez un lien, et le destinataire télécharge quand il est prêt — même s'il était hors ligne au moment de l'envoi. Cette expérience asynchrone, sans compte pour recevoir, est vraiment bonne, et c'est pourquoi tant de gens s'y fient.",
    "Cet article compare les deux équitablement. La force de WeTransfer est un partage soigné, basé sur des liens, où le fichier attend sur un serveur. Le focus de Relayium est différent : des transferts en temps réel qui vont directement entre les appareils, sans limite de taille, et qui n'atterrissent jamais sur un serveur ; s'y ajoute un lien stocké optionnel qui reste chiffré à divulgation nulle. Aucun n'est simplement meilleur — ils résolvent des problèmes légèrement différents.",
  ],
  sections: [
    {
      heading: "Ce que WeTransfer fait bien",
      body: [
        "L'idée centrale de WeTransfer est asynchrone : l'expéditeur téléverse une fois, obtient un lien, et le destinataire télécharge plus tard. Les deux n'ont jamais à être en ligne en même temps, exactement ce que vous voulez quand vous envoyez par e-mail une vidéo à un client qui l'ouvrira demain.",
        "Il est aussi mature et sans friction. Rien à installer, l'offre gratuite permet d'envoyer sans compte, et l'interface est réputée simple. Pour un partage occasionnel par lien dans la limite de taille, il fonctionne tout simplement.",
      ],
    },
    {
      heading: "Là où ils diffèrent : le fichier réside sur un serveur",
      body: [
        "Avec WeTransfer, votre fichier est téléversé sur ses serveurs, y est stocké un moment, puis téléchargé depuis là. L'offre gratuite plafonne chaque transfert à 2 Go, et le lien pointe vers une copie posée sur une infrastructure que vous ne contrôlez pas. Le transfert est chiffré en transit et au repos, mais il n'est pas à divulgation nulle : le service détient les clés et pourrait, en principe, lire le fichier.",
        "Le mode temps réel de Relayium fonctionne à l'inverse. Les octets circulent directement entre les deux appareils via un canal pair-à-pair chiffré et ne sont jamais garés sur un serveur, il n'y a donc aucune limite de taille côté serveur à atteindre. Par-dessus le transport WebRTC, Relayium ajoute sa propre couche : un échange de clés X25519 dérive une clé pour un AES-256-GCM par bloc, les deux appareils affichent un code de vérification à 6 chiffres identique (SAS) pour écarter un homme du milieu, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256.",
      ],
    },
    {
      heading: "Des transferts en temps réel sans limite de taille",
      body: [
        "Comme rien n'est stocké sur un serveur, la limite pratique de taille vient de votre propre navigateur. Dans Chrome ou Edge, Relayium diffuse les données entrantes directement sur le disque, il n'y a donc en pratique aucune limite de taille — des vidéos et archives de projet de plusieurs gigaoctets passent sans souci.",
        "Firefox et Safari n'offrent pas encore le même téléchargement en flux, si bien que le navigateur y met le fichier en mémoire tampon ; gardez ces transferts sous environ 200 Mo pour une expérience fluide. Sur le même réseau, les transferts en temps réel ne demandent aucun compte : ouvrez relayium.com sur les deux appareils, choisissez jusqu'à 1 000 fichiers, vérifiez le code, et envoyez. Envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte. Si une connexion tombe en cours de route, le transfert reprend au lieu de recommencer, et quand une liaison directe est impossible, il bascule vers un relais TURN chiffré qui ne voit que du texte chiffré.",
      ],
    },
    {
      heading: "Quand le destinataire est hors ligne : les liens stockés à divulgation nulle",
      body: [
        "Le transfert en temps réel exige que les deux soient présents, la seule chose que le modèle de lien de WeTransfer fait mieux. Alors Relayium offre le même confort asynchrone sans renoncer à la confidentialité : un lien de téléchargement stocké.",
        "Votre navigateur chiffre les fichiers en AES-256-GCM avant le téléversement, et la clé de déchiffrement ne vit que dans le fragment de l'URL — la partie après le #, que les navigateurs n'envoient jamais au serveur. Le serveur ne stocke donc qu'un texte chiffré à divulgation nulle qu'il ne peut pas lire, et le destinataire n'a pas besoin de compte pour télécharger. Créer un tel lien exige que l'expéditeur se connecte, et chaque lien peut être réglé pour expirer ou se détruire après le premier téléchargement.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: [
        "Les différences qui comptent le plus, côte à côte :",
      ],
      bullets: [
        "Limite de taille : l'offre gratuite de WeTransfer plafonne les transferts à 2 Go ; le temps réel de Relayium n'a aucune limite côté serveur (Chrome/Edge diffusent sur le disque ; gardez Firefox/Safari sous ~200 Mo).",
        "Où résident les fichiers : WeTransfer stocke votre fichier sur ses serveurs ; le temps réel de Relayium ne met jamais le fichier sur un serveur.",
        "Chiffrement : WeTransfer chiffre en transit et au repos mais détient les clés ; Relayium est de bout en bout avec un code SAS à 6 chiffres, et les liens stockés sont à divulgation nulle avec la clé uniquement dans le fragment de l'URL.",
        "Destinataire hors ligne : les deux gèrent le cas — WeTransfer via son lien stocké, Relayium via un lien de téléchargement stocké à divulgation nulle avec expiration ou destruction après téléchargement.",
        "Intégrité et reprise : Relayium vérifie chaque fichier par SHA-256 et peut reprendre un transfert interrompu au lieu de recommencer.",
        "Coût et ouverture : Relayium est gratuit et sous licence AGPL-3.0 sur github.com/relayium/relayium, et tourne dans le navigateur sur Windows, macOS, Linux, Android et iOS sans rien installer.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "N'y a-t-il vraiment aucune limite de taille de fichier ?",
        a: "En mode temps réel, il n'y a aucune limite côté serveur, car le fichier ne touche jamais un serveur. Dans Chrome ou Edge, le téléchargement se diffuse directement sur le disque, donc les fichiers de plusieurs gigaoctets passent sans souci. Firefox et Safari mettent en mémoire tampon à la place, gardez donc ces transferts sous environ 200 Mo. Les liens de téléchargement stockés ont un quota lié à votre compte.",
      },
      {
        q: "Que faire si le destinataire n'est pas en ligne ?",
        a: "Utilisez un lien de téléchargement stocké. Votre navigateur chiffre les fichiers en AES-256-GCM, la clé reste uniquement dans le fragment de l'URL, et le serveur conserve un texte chiffré à divulgation nulle que le destinataire pourra récupérer plus tard. Créer le lien exige que l'expéditeur se connecte, et vous pouvez le régler pour expirer ou se détruire après le premier téléchargement.",
      },
      {
        q: "Relayium est-il gratuit ?",
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
  title: "Relayium مقابل WeTransfer: أرسل ملفات كبيرة دون الخادم",
  description:
    "مقارنة صادقة بين Relayium وWeTransfer. WeTransfer رائع للمشاركة اللامتزامنة بالروابط؛ ويضيف Relayium نقلات فورية بلا سقف حجم لا تلمس خادمًا أبدًا وروابط مُخزَّنة بمعرفة صفرية.",
  updatedLabel: "آخر تحديث",
  lead: [
    "جعل WeTransfer إرسال الملفات الكبيرة يبدو بلا عناء: أفلِت ملفًا، واحصل على رابط، ويُنزّله المُستقبِل متى كان جاهزًا — حتى لو كان غير متصل حين أرسلته. هذه التجربة اللامتزامنة التي لا تتطلب حسابًا للاستقبال جيدة حقًا، وهي سبب لجوء كثير من الناس إليها.",
    "تقارن هذه المقالة الاثنين بإنصاف. قوة WeTransfer هي المشاركة المصقولة القائمة على الروابط، حيث ينتظر الملف على خادم. تركيز Relayium مختلف: نقلات فورية تجري مباشرةً بين الأجهزة بلا سقف حجم ولا تحطّ على خادم أبدًا، إضافةً إلى رابط مُخزَّن اختياري يظل مُشفَّرًا بمعرفة صفرية. لا أحدهما أفضل ببساطة — بل يحلّان مشكلتين مختلفتين قليلًا.",
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
        "يعمل الوضع الفوري في Relayium بالعكس. تتدفق البايتات مباشرةً بين الجهازين عبر قناة مُشفَّرة من الند للند ولا تُركَن على خادم أبدًا، فلا سقف حجم من جانب الخادم لتصطدم به. وفوق نقل WebRTC، يضيف Relayium طبقته الخاصة: يشتق تبادل مفاتيح X25519 مفتاحًا لـ AES-256-GCM لكل قطعة، ويعرض كلا الجهازين رمز تحقق متطابقًا من 6 أرقام (SAS) لاستبعاد وسيط، ويُتحقق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256.",
      ],
    },
    {
      heading: "نقلات فورية بلا سقف حجم",
      body: [
        "لأن لا شيء يُخزَّن على خادم، فإن حد حجم الملف العملي يأتي من متصفحك أنت. في Chrome أو Edge، يبثّ Relayium البيانات الواردة مباشرةً إلى القرص، فلا سقف حجم فعليًا — فمقاطع الفيديو وأرشيفات المشاريع بحجم عدة غيغابايت لا مشكلة فيها.",
        "لا يقدّم Firefox وSafari بعدُ التنزيل بالبث نفسه، فيخزّن المتصفح هناك الملف في الذاكرة مؤقتًا؛ فأبقِ تلك النقلات دون نحو 200 MB لتجربة سلسة. على نفس الشبكة، لا تحتاج النقلات الفورية إلى حساب: افتح relayium.com على الجهازين، واختر حتى 1,000 ملف، وتحقق من الرمز، وأرسِل. والإرسال عبر الشبكات برمز اقتران يتطلب من المُرسِل تسجيل الدخول — أما المُستقبِل فلا يحتاج أبدًا إلى حساب. وإن سقط اتصال في منتصفه، يُستأنف النقل بدلًا من البدء من جديد، وعندما يتعذّر الرابط المباشر يتراجع إلى مُرحِّل TURN مُشفَّر لا يرى سوى نص مُشفَّر.",
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
        "حد الحجم: تحدّ الفئة المجانية في WeTransfer النقلات عند 2 GB؛ بينما لا سقف من جانب الخادم للوضع الفوري في Relayium (يبثّ Chrome/Edge إلى القرص؛ أبقِ Firefox/Safari دون ~200 MB).",
        "أين تعيش الملفات: يخزّن WeTransfer ملفك على خوادمه؛ بينما لا يضع الوضع الفوري في Relayium الملف على خادم على الإطلاق.",
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
        a: "في الوضع الفوري لا يوجد سقف من جانب الخادم، لأن الملف لا يلمس خادمًا أبدًا. في Chrome أو Edge يُبثّ التنزيل مباشرةً إلى القرص، فالملفات بحجم عدة غيغابايت لا مشكلة فيها. أما Firefox وSafari فيخزّنان في الذاكرة مؤقتًا بدلًا من ذلك، فأبقِ تلك النقلات دون نحو 200 MB. أما روابط التنزيل المُخزَّنة فلها حصة مرتبطة بحسابك.",
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
  title: "Relayium vs WeTransfer: envía archivos grandes sin el servidor",
  description:
    "Una comparación honesta de Relayium y WeTransfer. WeTransfer es excelente para compartir enlaces de forma asíncrona; Relayium añade transferencias en tiempo real sin límite de tamaño que nunca tocan un servidor y enlaces almacenados de conocimiento cero.",
  updatedLabel: "Última actualización",
  lead: [
    "WeTransfer hizo que enviar archivos grandes pareciera sencillo: sueltas un archivo, obtienes un enlace y el destinatario descarga cuando esté listo, aunque estuviera desconectado cuando lo enviaste. Esa experiencia asíncrona, sin cuenta para recibir, es genuinamente buena, y es por lo que tanta gente recurre a ella.",
    "Este artículo compara ambos con justicia. La fuerza de WeTransfer es el uso compartido pulido, basado en enlaces, donde el archivo espera en un servidor. El foco de Relayium es distinto: transferencias en tiempo real que van directamente entre dispositivos sin límite de tamaño y que nunca aterrizan en un servidor, más un enlace almacenado opcional que permanece cifrado con conocimiento cero. Ninguno es simplemente mejor: resuelven problemas ligeramente distintos.",
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
        "El modo en tiempo real de Relayium funciona al revés. Los bytes fluyen directamente entre los dos dispositivos por un canal cifrado de igual a igual y nunca se aparcan en un servidor, así que no hay ningún límite de tamaño del lado del servidor con el que topar. Sobre el transporte WebRTC, Relayium añade su propia capa: un intercambio de claves X25519 deriva una clave para AES-256-GCM por fragmento, ambos dispositivos muestran un código de verificación coincidente de 6 dígitos (SAS) para descartar a un intermediario, y cada archivo se verifica de extremo a extremo con un hash SHA-256.",
      ],
    },
    {
      heading: "Transferencias en tiempo real sin límite de tamaño",
      body: [
        "Como nada se almacena en un servidor, el límite práctico de tamaño de archivo viene de tu propio navegador. En Chrome o Edge, Relayium transmite los datos entrantes directamente al disco, así que prácticamente no hay límite de tamaño: vídeos de varios gigabytes y archivos comprimidos de proyectos van bien.",
        "Firefox y Safari todavía no ofrecen la misma descarga en flujo, así que allí el navegador almacena el archivo en memoria; mantén esas transferencias por debajo de unos 200 MB para una experiencia fluida. En la misma red, las transferencias en tiempo real no necesitan cuenta: abre relayium.com en ambos dispositivos, elige hasta 1.000 archivos, verifica el código y envía. Enviar entre redes con un código de emparejamiento exige que el remitente inicie sesión; el destinatario nunca necesita cuenta. Si una conexión se cae a mitad, la transferencia se reanuda en lugar de empezar de nuevo, y cuando un enlace directo es imposible recurre a un retransmisor TURN cifrado que solo ve texto cifrado.",
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
        "Límite de tamaño: el nivel gratuito de WeTransfer limita las transferencias a 2 GB; el tiempo real de Relayium no tiene límite del lado del servidor (Chrome/Edge transmiten al disco; mantén Firefox/Safari por debajo de ~200 MB).",
        "Dónde viven los archivos: WeTransfer almacena tu archivo en sus servidores; el tiempo real de Relayium nunca pone el archivo en un servidor.",
        "Cifrado: WeTransfer cifra en tránsito y en reposo pero guarda las claves; Relayium es de extremo a extremo con un código SAS de 6 dígitos, y los enlaces almacenados son de conocimiento cero con la clave solo en el fragmento de la URL.",
        "Destinatario desconectado: ambos lo resuelven: WeTransfer con su enlace almacenado, Relayium con un enlace de descarga almacenado de conocimiento cero con caducidad o autodestrucción tras la descarga.",
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
        a: "En modo en tiempo real no hay límite del lado del servidor, porque el archivo nunca toca un servidor. En Chrome o Edge la descarga se transmite directamente al disco, así que los archivos de varios gigabytes van bien. Firefox y Safari almacenan en memoria en su lugar, así que mantén esas transferencias por debajo de unos 200 MB. Los enlaces de descarga almacenados tienen una cuota ligada a tu cuenta.",
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
  title: "Relayium vs WeTransfer: envie arquivos grandes sem o servidor",
  description:
    "Uma comparação honesta de Relayium e WeTransfer. O WeTransfer é ótimo para compartilhar links de forma assíncrona; o Relayium adiciona transferências em tempo real sem limite de tamanho que nunca tocam um servidor e links armazenados de conhecimento zero.",
  updatedLabel: "Última atualização",
  lead: [
    "O WeTransfer fez o envio de arquivos grandes parecer sem esforço: solte um arquivo, receba um link e o destinatário baixa quando estiver pronto — mesmo que estivesse offline quando você enviou. Essa experiência assíncrona, sem conta para receber, é genuinamente boa, e é por isso que tanta gente recorre a ela.",
    "Este artigo compara os dois com justiça. A força do WeTransfer é o compartilhamento polido, baseado em links, em que o arquivo espera num servidor. O foco do Relayium é diferente: transferências em tempo real que vão diretamente entre dispositivos sem limite de tamanho e que nunca pousam num servidor, além de um link armazenado opcional que permanece criptografado com conhecimento zero. Nenhum é simplesmente melhor — eles resolvem problemas ligeiramente diferentes.",
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
        "O modo em tempo real do Relayium funciona ao contrário. Os bytes fluem diretamente entre os dois dispositivos por um canal criptografado ponto a ponto e nunca são estacionados num servidor, então não há nenhum limite de tamanho do lado do servidor para esbarrar. Sobre o transporte WebRTC, o Relayium adiciona a própria camada: uma troca de chaves X25519 deriva uma chave para AES-256-GCM por bloco, ambos os dispositivos mostram um código de verificação coincidente de 6 dígitos (SAS) para descartar um intermediário, e cada arquivo é verificado de ponta a ponta com um hash SHA-256.",
      ],
    },
    {
      heading: "Transferências em tempo real sem limite de tamanho",
      body: [
        "Como nada é armazenado num servidor, o limite prático de tamanho de arquivo vem do seu próprio navegador. No Chrome ou no Edge, o Relayium transmite os dados recebidos direto para o disco, então praticamente não há limite de tamanho — vídeos de vários gigabytes e arquivos compactados de projetos vão bem.",
        "Firefox e Safari ainda não oferecem o mesmo download em fluxo, então lá o navegador guarda o arquivo na memória; mantenha essas transferências abaixo de cerca de 200 MB para uma experiência fluida. Na mesma rede, as transferências em tempo real não precisam de conta: abra relayium.com nos dois dispositivos, escolha até 1.000 arquivos, verifique o código e envie. Enviar entre redes com um código de emparelhamento exige que o remetente entre; o destinatário nunca precisa de conta. Se uma conexão cai no meio, a transferência retoma em vez de começar de novo, e quando um link direto é impossível ela recorre a um retransmissor TURN criptografado que só vê texto cifrado.",
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
      heading: "Comparativo de recursos num relance",
      body: [
        "As diferenças que mais importam, lado a lado:",
      ],
      bullets: [
        "Limite de tamanho: o nível gratuito do WeTransfer limita as transferências a 2 GB; o tempo real do Relayium não tem limite do lado do servidor (Chrome/Edge transmitem para o disco; mantenha Firefox/Safari abaixo de ~200 MB).",
        "Onde os arquivos vivem: o WeTransfer armazena seu arquivo nos servidores dele; o tempo real do Relayium nunca coloca o arquivo num servidor.",
        "Criptografia: o WeTransfer criptografa em trânsito e em repouso, mas guarda as chaves; o Relayium é de ponta a ponta com um código SAS de 6 dígitos, e os links armazenados são de conhecimento zero com a chave só no fragmento da URL.",
        "Destinatário offline: os dois lidam com isso — o WeTransfer via seu link armazenado, o Relayium via um link de download armazenado de conhecimento zero com expiração ou autodestruição após o download.",
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
        a: "No modo em tempo real não há limite do lado do servidor, porque o arquivo nunca toca um servidor. No Chrome ou no Edge o download é transmitido direto para o disco, então arquivos de vários gigabytes vão bem. Firefox e Safari guardam na memória em vez disso, então mantenha essas transferências abaixo de cerca de 200 MB. Os links de download armazenados têm uma cota ligada à sua conta.",
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
  updated: "2026-07-03",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
