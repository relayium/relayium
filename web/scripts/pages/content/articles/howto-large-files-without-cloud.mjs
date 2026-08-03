// web/scripts/pages/content/articles/howto-large-files-without-cloud.mjs
// How-to: send large files (multi-GB video / project archives) without the cloud.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "How to send large files without the cloud",
  description:
    "For large videos and project archives, create an end-to-end encrypted download link so the recipient can fetch later; realtime remains a live alternative when both sides can stay online.",
  updatedLabel: "Last updated",
  lead: [
    "A 20 GB video export or a heavy project archive is exactly where cloud storage feels slowest: you upload the whole file once, wait, then the other person downloads it again — two full transfers plus whatever your storage quota allows. For a one-time hand-off, that is a lot of copying and waiting for bytes that only ever needed to go from A to B.",
    "For a large file, Relayium's recommended path is an end-to-end encrypted stored download link: the recipient need not be online while you upload and can fetch it later. Keep the sender page open until upload completes; after that the link remains available until expiry. If both people can stay online, realtime is the live alternative: LAN WebRTC is direct, while cross-network browser sessions carry end-to-end ciphertext over TURN. Relayium stores no realtime content or history.",
  ],
  sections: [
    {
      heading: "Why a stored link is the default for big files",
      body: [
        "A Relayium download link stores only browser-encrypted ciphertext. The recipient can be offline during upload and fetch later; once upload completes, closing the sender page does not remove the link. The trade-offs are the displayed per-file limit, account quota and expiry.",
        "Realtime is the alternative when both sides are ready now. On the same LAN, WebRTC connects directly with no account; across networks, browsers use TURN to carry end-to-end encrypted ciphertext and the code creator signs in. Both pages must remain active, so this path is better suited to quick small-file and text handoff than long large-file delivery.",
      ],
    },
    {
      heading: "No size cap in realtime mode",
      body: [
        "Realtime transfers have no server-side storage-size limit because Relayium does not retain a content copy. A TURN relay may carry cross-network ciphertext while both sides are online, but it cannot read, decrypt, or retain it as transfer history. The practical ceiling is set by the receiving browser, not by us.",
        "On Chrome and Edge an incoming realtime file can stream straight to disk, so the protocol can technically carry tens of gigabytes. That capability is not the default recommendation for large files: the live session still needs both pages active. A batch can hold up to 1,000 files, and each one is verified end-to-end with a SHA-256 hash.",
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
        "A temporary transport drop can resume from a durable checkpoint while both live pages remain active. Closing or reloading either page, or ending the app session, is different: it ends the live transfer and requires a new handoff. This is another reason to prefer a stored link for large files.",
        "Connectivity is handled the same way. On one network the transfer goes directly device-to-device; across networks the encrypted stream travels over a TURN relay. The relay only ever sees ciphertext, so that path stays end-to-end encrypted too.",
      ],
    },
    {
      heading: "Send now, or leave a link for later",
      body: [
        "Realtime transfer needs both people online at the same time, which is ideal when you can coordinate — a call, a shared moment, a colleague at their desk. If the other person is not available right now, you can create a stored download link instead.",
        "A stored link is zero-knowledge: your browser encrypts the files with AES-256-GCM before upload and the decryption key lives only in the URL fragment, so the server keeps ciphertext it cannot read. Be aware of the trade-offs — creating a link requires the sender to sign in, links count against a storage quota, and they expire (or can burn after the first download). Its download page can stream a single file to disk through a service worker even in Firefox and Safari. For the biggest files, reach for the stored link first: the recipient need not be online during upload; keep the sender page open until upload completes, then the link remains available until expiry even after either side closes the laptop. Keep the live path for when you are both at your desks and want the bytes to land now.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "What is the largest file I can send?",
        a: "For large files, use a stored download link; its per-file limit and quota are shown before upload. Realtime has no server-side limit, and desktop Chrome or Edge can stream to disk, but both pages must stay active. Firefox and Safari assemble a realtime receive in memory and Relayium warns above roughly 256 MB — a conservative estimate, not a hard limit.",
      },
      {
        q: "What happens if the transfer is interrupted?",
        a: "A temporary connection drop can resume from a durable checkpoint while both pages remain active. Closing or reloading a page, or ending the app session, ends the live transfer. A stored link avoids requiring the recipient to remain online, but the sender must keep its page open until upload completes.",
      },
      {
        q: "How is my privacy protected for large files?",
        a: "Realtime transfers are end-to-end encrypted with an X25519 key exchange and per-chunk AES-256-GCM, and that key never reaches any server. With advanced verification on (off by default), both devices show a 6-digit verification code; each file is checked with a SHA-256 hash. LAN WebRTC is direct; cross-network browser sessions use TURN by design, and the relay carries only ciphertext it cannot read or decrypt.",
      },
    ],
  },
  cta: {
    text: "Move your next multi-gigabyte file without the cloud — leave an encrypted download link, or connect both devices and send it now. No install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何不用网盘传输大文件",
  description:
    "大视频和工程文件建议生成端到端加密下载链接，让接收方稍后再取；只有双方都能保持在线时，才把实时传输作为即时替代方案。",
  updatedLabel: "最近更新",
  lead: [
    "一个 20 GB 的视频导出，或者一个体积庞大的工程压缩包，恰恰是网盘最慢的场景：你先把整个文件上传一遍、等待，然后对方再下载一遍——两次完整传输，还要受制于你的存储配额。对一次性的交付来说，只是想把字节从 A 送到 B，却要这样反复复制和等待。",
    "大文件推荐使用 Relayium 的端到端加密下载链接：上传时接收方无需在线，之后可随时来取。发送方须保持页面打开直到上传完成；完成后链接会保留到过期。若双方都能保持在线，实时传输可用于即时交付：局域网 WebRTC 直连，跨网络浏览器经 TURN 承载端到端密文。实时模式不保留服务器端内容副本或历史。",
  ],
  sections: [
    {
      heading: "为什么大文件默认应使用下载链接",
      body: [
        "Relayium 下载链接只存浏览器加密后的密文。上传时接收方可以离线，之后再取；上传完成后，发送方关掉页面也不会移除链接。取舍是页面所示的单文件上限、账号额度与有效期。",
        "实时传输适合双方此刻都已就绪的场景。同一局域网内 WebRTC 免账号直连；跨网络浏览器经 TURN 承载端到端密文，配对码创建者登录。双方页面必须保持在线，因此它更适合快速递送小文件和文本，而不是耗时的大文件交付。",
      ],
    },
    {
      heading: "实时模式没有大小上限",
      body: [
        "实时传输没有服务器端存储大小限制，因为 Relayium 不保留内容副本。跨网络时 TURN 中继会在双方在线期间承载密文，但无法读取、解密或把它留作传输历史。实际的上限由接收端浏览器决定。",
        "在 Chrome 和 Edge 上，实时接收可随到随写磁盘，因此协议在技术上能承载几十 GB。不过实时会话仍要求双方页面保持在线；大文件默认走上面的下载链接。每批最多可放 1,000 个文件，每个都用 SHA-256 做端到端校验。",
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
        "双方实时页面仍在运行时，短暂的传输连接中断可从持久断点续传；但关闭或刷新任一页面、结束 App 会话会结束实时传输，需要重新发起。这也是大文件优先使用下载链接的原因。",
        "网络连通问题也是同样的处理思路。同一网络内传输在设备之间直连；跨网络时加密数据流经 TURN 中继转发。中继只能看到密文，因此这条路径同样保持端到端加密。",
      ],
    },
    {
      heading: "现在就传，或留个链接稍后取",
      body: [
        "实时传输需要双方同时在线，这在能协调的时候最理想——一通电话、一个共处的时刻、一位就在工位上的同事。如果对方此刻不在，你可以改为创建一个存储下载链接。",
        "存储链接是零知识的：浏览器在上传前用 AES-256-GCM 加密文件，解密密钥只存在于 URL 片段里，服务器只保存它读不懂的密文。也要清楚其中的取舍——生成链接需要发送方登录，链接会占用存储配额，并且会过期（也可以设置为首次下载后即焚）。下载页即使在 Firefox 和 Safari 上也能借助 Service Worker 把单个文件流式写入磁盘。文件越大越应该先考虑存储链接：上传时接收方无需在线；发送方保持页面打开直至上传完成，之后任一端合上电脑，链接仍会保留到过期。双方都在电脑前、希望文件立刻到位时，再走实时那条路。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "最大能传多大的文件？",
        a: "大文件请使用下载链接，页面会在上传前显示单文件上限与额度。实时模式没有服务器端上限，桌面版 Chrome 或 Edge 也能流式写盘，但双方页面必须保持在线。Firefox 和 Safari 会把实时接收内容放在内存中，超过约 256 MB 时 Relayium 会提示——这是保守估计而非硬上限。",
      },
      {
        q: "传输中断了怎么办？",
        a: "双方页面保持运行时，短暂连接中断可从持久断点续传；关闭或刷新页面、结束 App 会话会结束实时传输。下载链接不要求接收方保持在线，但发送方仍须保持页面打开直到上传完成。",
      },
      {
        q: "传大文件时隐私如何保证？",
        a: "实时传输用 X25519 密钥交换加逐块 AES-256-GCM 做端到端加密，密钥从不抵达任何服务器。打开高级验证（默认关闭）后两台设备会显示 6 位校验码；每个文件都用 SHA-256 校验。局域网 WebRTC 直连；跨网络浏览器按设计使用 TURN，中继只承载它无法读取或解密的密文。",
      },
    ],
  },
  cta: {
    text: "不用网盘也能搬走下一个几 GB 的大文件——留一条加密下载链接，或者让两台设备连上后立刻发送。无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "クラウドを使わずに大きなファイルを送る方法",
  description:
    "大きな動画やプロジェクトアーカイブにはエンドツーエンド暗号化ダウンロードリンクを作り、相手が後で取得できるようにします。双方がオンラインを保てる場合はリアルタイムも選べます。",
  updatedLabel: "最終更新",
  lead: [
    "20 GB の動画書き出しや重いプロジェクトのアーカイブは、まさにクラウドストレージが最も遅く感じる場面です。ファイル全体を一度アップロードして待ち、相手がもう一度ダウンロードします。2回の完全な転送に加え、ストレージ容量の制限も受けます。一度きりの受け渡しなのに、A から B へ送るだけのバイトのために、これだけの複製と待ち時間がかかります。",
    "大きなファイルでは、Relayium はエンドツーエンド暗号化された保存型ダウンロードリンクを推奨します。アップロード中に受信者がオンラインである必要はなく、後で取得できます。送信側はアップロード完了までページを開き、その後リンクは期限まで残ります。双方がオンラインを保てる場合、リアルタイムはライブの選択肢です。同じ LAN では WebRTC が直接接続し、ネットワーク間では TURN が暗号文を運びます。リアルタイム内容やサーバー側のコピーは残しません。",
  ],
  sections: [
    {
      heading: "大きなファイルで保存リンクを既定にする理由",
      body: [
        "Relayium のダウンロードリンクが保存するのはブラウザで暗号化された暗号文だけです。アップロード中に受信者はオフラインでもよく、後で取得できます。完了後に送信側がページを閉じても、リンクは期限まで残ります。制約は画面に表示される1ファイル上限、容量枠、有効期限です。",
        "リアルタイムは双方が今すぐ準備できる場合の選択肢です。同じ LAN ではアカウントなしで WebRTC が直接接続し、ネットワーク間では TURN がエンドツーエンド暗号文を運び、コード作成側がサインインします。双方のページを開いたままにする必要があるため、時間のかかる大容量転送より、小さなファイルやテキストの素早い受け渡しに向きます。",
      ],
    },
    {
      heading: "リアルタイムモードにはサイズ上限がない",
      body: [
        "Relayium は内容のコピーを保持しないため、リアルタイム転送にサーバー側ストレージのサイズ制限はありません。ネットワークをまたぐ際は TURN が両者のオンライン中に暗号文を運びますが、読み取りも復号もできず、転送履歴として保持しません。実際の上限は受信側ブラウザが決めます。",
        "Chrome と Edge ではリアルタイム受信をディスクへ直接流せるため、技術的には数十 GB も扱えます。ただし大きなファイルの既定として推奨する意味ではありません。ライブセッションでは双方のページを開いたままにする必要があります。1バッチ最大1,000ファイルで、それぞれ SHA-256 で検証されます。",
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
        "双方のライブページが動作中なら、一時的な通信切断は保存済みのチェックポイントから再開できます。一方、どちらかのページを閉じる／再読み込みする、または App セッションを終了するとライブ転送は終了し、新たな受け渡しが必要です。これも大きなファイルで保存リンクを優先する理由です。",
        "接続性も同じように扱われます。同一ネットワーク内では転送はデバイス間で直接行われ、ネットワークをまたぐ場合は暗号化ストリームが TURN リレーを経由します。リレーが見るのは暗号文だけなので、この経路でもエンドツーエンド暗号化のままです。",
      ],
    },
    {
      heading: "今すぐ送る、または後で取れるリンクを残す",
      body: [
        "リアルタイム転送は双方が同時にオンラインであることが必要で、都合を合わせられるときに最適です。相手が今いない場合は、代わりに保存型のダウンロードリンクを作成できます。",
        "保存リンクはゼロ知識です。ブラウザがアップロード前に AES-256-GCM で暗号化し、復号鍵は URL フラグメントにだけ存在します。作成には送信側のサインインが必要で、容量枠を使い、有効期限があります。ダウンロードページは Firefox や Safari でも Service Worker で単一ファイルをディスクへ流せます。大きなファイルほど保存リンクを先に選びます。アップロード中に受信者はオンライン不要ですが、送信側は完了までページを開きます。その後はどちらがノートPCを閉じても期限までリンクが残ります。ライブ経路は双方が机の前にいて、今すぐ届けたいときの手段です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "送れるファイルの最大サイズは？",
        a: "大きなファイルには保存型ダウンロードリンクを使ってください。1ファイル上限と容量枠はアップロード前に表示されます。リアルタイムにはサーバー側上限がなく、パソコン版 Chrome／Edge はディスクへ流せますが、双方のページを開いたままにする必要があります。Firefox／Safari のリアルタイム受信はメモリに保持され、約256 MBを超えると保守的な警告を表示します。",
      },
      {
        q: "転送が中断されたらどうなりますか？",
        a: "双方のページが動作中なら、一時的な接続切れは保存済みチェックポイントから再開できます。ページを閉じる／再読み込みする、または App セッションを終了するとライブ転送は終了します。保存リンクでは受信者のオンラインは不要ですが、送信側はアップロード完了までページを開く必要があります。",
      },
      {
        q: "大きなファイルでプライバシーはどう守られますか？",
        a: "リアルタイム転送は X25519 の鍵交換とチャンクごとの AES-256-GCM でエンドツーエンドに暗号化され、鍵はどのサーバーにも届きません。高度な検証（既定はオフ）をオンにすると両端末が6桁の検証コードを表示します。各ファイルは SHA-256 で検証します。同じ LAN の WebRTC は直接接続し、ネットワークをまたぐブラウザは設計上 TURN を使用します。リレーは暗号文を運ぶだけで読み取りも復号もできません。",
      },
    ],
  },
  cta: {
    text: "次の数ギガバイトのファイルをクラウドなしで。暗号化したダウンロードリンクを残すか、両方の端末をつないでいま送るか。インストール不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "클라우드 없이 대용량 파일 보내는 방법",
  description:
    "대용량 동영상과 프로젝트 아카이브는 종단간 암호화 다운로드 링크로 만들어 나중에 받게 하세요. 양쪽이 계속 온라인일 수 있을 때만 실시간을 즉시 전송 대안으로 사용합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "20 GB짜리 동영상 내보내기나 무거운 프로젝트 아카이브야말로 클라우드 스토리지가 가장 느리게 느껴지는 순간입니다. 파일 전체를 한 번 업로드하고 기다린 뒤, 상대가 다시 다운로드합니다. 두 번의 완전한 전송에 스토리지 할당량 제한까지 받습니다. 한 번뿐인 전달인데, A에서 B로 보내기만 하면 되는 바이트를 위해 이렇게 복사하고 기다려야 합니다.",
    "대용량 파일에는 Relayium의 종단간 암호화 저장형 다운로드 링크를 권장합니다. 업로드 중 수신자는 온라인일 필요가 없고 나중에 받을 수 있습니다. 보내는 쪽은 업로드 완료까지 페이지를 열어 두며, 이후 링크는 만료까지 남습니다. 양쪽이 계속 온라인일 수 있다면 실시간이 라이브 대안입니다. 같은 LAN에서는 WebRTC가 직접 연결하고 네트워크 간에는 TURN이 종단간 암호문을 운반합니다. 실시간 내용이나 서버 측 복사본을 남기지 않습니다.",
  ],
  sections: [
    {
      heading: "대용량 파일은 저장 링크가 기본인 이유",
      body: [
        "Relayium 다운로드 링크에는 브라우저에서 암호화한 암호문만 저장됩니다. 업로드 중 수신자는 오프라인이어도 되고 나중에 받습니다. 완료 후 보내는 쪽이 페이지를 닫아도 링크는 만료까지 남습니다. 화면에 표시되는 파일당 한도, 계정 할당량, 만료가 절충점입니다.",
        "실시간은 양쪽이 지금 준비되어 있을 때의 대안입니다. 같은 LAN에서는 계정 없이 WebRTC가 직접 연결하고, 네트워크 간에는 TURN이 종단간 암호문을 운반하며 코드 생성자가 로그인합니다. 두 페이지가 계속 활성 상태여야 하므로 오래 걸리는 대용량 전달보다 작은 파일과 텍스트를 빠르게 건네는 데 적합합니다.",
      ],
    },
    {
      heading: "실시간 모드에는 크기 제한이 없다",
      body: [
        "Relayium이 내용 복사본을 보관하지 않으므로 실시간 전송에는 서버 측 저장 크기 제한이 없습니다. 네트워크를 넘을 때 TURN은 양쪽이 온라인인 동안 암호문을 운반하지만 읽거나 복호화할 수 없고 전송 기록으로 보관하지 않습니다. 실질적인 상한은 받는 쪽 브라우저가 정합니다.",
        "Chrome과 Edge는 실시간 수신을 디스크로 직접 스트리밍하므로 기술적으로 수십 GB도 처리할 수 있습니다. 하지만 이는 대용량 파일의 기본 권장 사항이 아닙니다. 라이브 세션에서는 두 페이지가 계속 활성 상태여야 합니다. 한 배치에 최대 1,000개 파일을 담고 각각 SHA-256으로 검증합니다.",
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
        "두 라이브 페이지가 계속 실행 중이면 일시적인 전송 끊김은 저장된 체크포인트에서 재개할 수 있습니다. 한쪽 페이지를 닫거나 새로고침하거나 App 세션을 끝내면 라이브 전송이 종료되어 새로 시작해야 합니다. 대용량 파일에 저장 링크를 우선하는 또 다른 이유입니다.",
        "연결성도 같은 방식으로 처리됩니다. 같은 네트워크 안에서는 전송이 기기 간에 직접 이루어지고, 네트워크를 넘을 때는 암호화된 스트림이 TURN 릴레이를 거칩니다. 릴레이는 암호문만 볼 수 있으므로 그 경로에서도 종단간 암호화를 유지합니다.",
      ],
    },
    {
      heading: "지금 보내거나, 나중에 받을 링크를 남기거나",
      body: [
        "실시간 전송은 양쪽이 동시에 온라인이어야 하며, 시간을 맞출 수 있을 때 가장 이상적입니다. 상대가 지금 없다면 대신 저장형 다운로드 링크를 만들 수 있습니다.",
        "저장 링크는 영지식입니다. 브라우저가 업로드 전에 AES-256-GCM으로 암호화하고 복호화 키는 URL 프래그먼트에만 존재합니다. 생성에는 보내는 쪽 로그인이 필요하고 할당량을 사용하며 만료됩니다. 다운로드 페이지는 Firefox와 Safari에서도 서비스 워커로 단일 파일을 디스크에 스트리밍합니다. 파일이 클수록 저장 링크를 먼저 선택하세요. 업로드 중 수신자는 온라인일 필요가 없지만 보내는 쪽은 완료까지 페이지를 열어 둡니다. 이후에는 어느 쪽이 노트북을 덮어도 링크가 만료까지 남습니다. 둘 다 자리에 있어 지금 받기를 원할 때 라이브 경로를 쓰세요.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "보낼 수 있는 파일 최대 크기는 얼마인가요?",
        a: "대용량 파일에는 저장형 다운로드 링크를 사용하세요. 파일당 한도와 할당량은 업로드 전에 표시됩니다. 실시간에는 서버 측 한도가 없고 데스크톱 Chrome/Edge는 디스크로 스트리밍하지만 두 페이지가 계속 활성 상태여야 합니다. Firefox/Safari 실시간 수신은 메모리에 보관되며 약 256 MB를 넘으면 보수적인 경고가 표시됩니다.",
      },
      {
        q: "전송이 중단되면 어떻게 되나요?",
        a: "두 페이지가 실행 중이면 일시적인 연결 끊김은 저장된 체크포인트에서 재개할 수 있습니다. 페이지를 닫거나 새로고침하거나 App 세션을 끝내면 라이브 전송이 종료됩니다. 저장 링크에서는 수신자가 온라인일 필요가 없지만 보내는 쪽은 업로드가 끝날 때까지 페이지를 열어 둬야 합니다.",
      },
      {
        q: "대용량 파일에서 개인정보는 어떻게 보호되나요?",
        a: "실시간 전송은 X25519 키 교환과 블록별 AES-256-GCM으로 종단간 암호화되며 키는 어떤 서버에도 도달하지 않습니다. 고급 검증(기본값 꺼짐)을 켜면 두 기기가 6자리 검증 코드를 표시하며, 각 파일은 SHA-256으로 검사합니다. 같은 LAN의 WebRTC는 직접 연결하며, 네트워크를 넘는 브라우저는 설계상 TURN을 사용합니다. 릴레이는 읽거나 복호화할 수 없는 암호문만 운반합니다.",
      },
    ],
  },
  cta: {
    text: "다음 수 기가바이트 파일을 클라우드 없이 옮기세요 — 암호화된 다운로드 링크를 남기거나, 두 기기를 연결해 지금 보내세요. 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Große Dateien ohne Cloud versenden",
  description:
    "Erstelle für große Videos und Projektarchive einen Ende-zu-Ende verschlüsselten Download-Link zur späteren Abholung; Echtzeit bleibt die Live-Alternative, wenn beide Seiten online bleiben können.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Ein 20 GB großer Videoexport oder ein schweres Projektarchiv ist genau der Fall, in dem Cloud-Speicher am langsamsten wirkt: Du lädst die ganze Datei einmal hoch, wartest, und die andere Person lädt sie erneut herunter — zwei vollständige Übertragungen, plus das, was dein Speicherkontingent zulässt. Für eine einmalige Übergabe ist das viel Kopieren und Warten für Bytes, die nur von A nach B mussten.",
    "Für große Dateien empfiehlt Relayium einen Ende-zu-Ende verschlüsselten gespeicherten Download-Link: Die empfangende Person muss beim Upload nicht online sein und holt ihn später ab. Die Senderseite bleibt bis zum Upload-Ende offen; danach ist der Link bis zum Ablauf verfügbar. Wenn beide online bleiben können, ist Echtzeit die Live-Alternative: im LAN direkt per WebRTC, netzübergreifend als Ende-zu-Ende-Chiffretext über TURN. Echtzeit behält keine serverseitige Kopie und keine Echtzeithistorie.",
  ],
  sections: [
    {
      heading: "Warum ein gespeicherter Link bei großen Dateien Standard ist",
      body: [
        "Ein Relayium-Download-Link speichert nur im Browser verschlüsselten Chiffretext. Die empfangende Person kann beim Upload offline sein und später abholen; nach Abschluss entfernt das Schließen der Senderseite den Link nicht. Grenzen sind Dateilimit, Kontingent und Ablauf, die auf der Seite angezeigt werden.",
        "Echtzeit ist die Alternative, wenn beide jetzt bereit sind. Im selben LAN verbindet WebRTC ohne Konto direkt; netzübergreifend trägt TURN Ende-zu-Ende-Chiffretext und der Code-Ersteller meldet sich an. Beide Seiten müssen aktiv bleiben, daher eignet sich dieser Weg besser für kleine Dateien und Text als für lange große Übertragungen.",
      ],
    },
    {
      heading: "Keine Größenbeschränkung im Echtzeitmodus",
      body: [
        "Echtzeitübertragungen haben keine serverseitige Speichergrößenbeschränkung, weil Relayium keine Inhaltskopie behält. Ein TURN-Relay kann netzübergreifenden Chiffretext tragen, solange beide Seiten online sind, kann ihn aber weder lesen noch entschlüsseln oder als Übertragungshistorie behalten. Die praktische Obergrenze setzt der empfangende Browser.",
        "Chrome und Edge können eine eingehende Echtzeitdatei direkt auf die Festplatte streamen, sodass technisch zweistellige Gigabyte-Größen möglich sind. Das ist keine Standardempfehlung für große Dateien: Die Live-Sitzung braucht weiterhin beide aktiven Seiten. Ein Stapel fasst bis zu 1.000 Dateien, jede per SHA-256 geprüft.",
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
        "Ein kurzer Transportabbruch kann von einem beständigen Prüfpunkt fortgesetzt werden, solange beide Live-Seiten aktiv bleiben. Das Schließen oder Neuladen einer Seite beziehungsweise das Beenden der App-Sitzung beendet dagegen die Live-Übertragung. Auch deshalb ist für große Dateien der gespeicherte Link vorzuziehen.",
        "Die Konnektivität wird ebenso gehandhabt. Im selben Netz läuft die Übertragung direkt von Gerät zu Gerät; netzübergreifend läuft der verschlüsselte Datenstrom über ein TURN-Relay. Das Relay sieht nur Chiffretext, sodass auch dieser Pfad Ende-zu-Ende-verschlüsselt bleibt.",
      ],
    },
    {
      heading: "Jetzt senden oder einen Link für später hinterlassen",
      body: [
        "Die Echtzeitübertragung setzt voraus, dass beide gleichzeitig online sind — ideal, wenn ihr euch abstimmen könnt. Ist die andere Person gerade nicht verfügbar, kannst du stattdessen einen gespeicherten Download-Link erstellen.",
        "Ein gespeicherter Link ist Zero-Knowledge: Dein Browser verschlüsselt vor dem Upload mit AES-256-GCM, der Schlüssel liegt nur im URL-Fragment. Erstellen erfordert die Anmeldung, Links zählen gegen ein Kontingent und laufen ab. Die Download-Seite kann auch in Firefox und Safari auf die Festplatte streamen. Für die größten Dateien nimm zuerst den gespeicherten Link: Die empfangende Person muss beim Upload nicht online sein; die Senderseite bleibt bis zum Abschluss offen, danach bleibt der Link bis zum Ablauf verfügbar, auch wenn ein Laptop geschlossen wird. Den Live-Weg nimmst du, wenn beide am Schreibtisch sitzen und die Bytes jetzt ankommen sollen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Wie groß darf die Datei sein, die ich sende?",
        a: "Für große Dateien nimm den gespeicherten Download-Link; Dateilimit und Kontingent werden vor dem Upload angezeigt. Echtzeit hat keine serverseitige Grenze, und Chrome oder Edge können auf die Festplatte streamen, aber beide Seiten müssen aktiv bleiben. Firefox und Safari halten einen Echtzeitempfang im Speicher und warnen ab etwa 256 MB — eine vorsichtige Schätzung, keine harte Grenze.",
      },
      {
        q: "Was passiert, wenn die Übertragung unterbrochen wird?",
        a: "Ein kurzer Verbindungsabbruch kann von einem beständigen Prüfpunkt fortgesetzt werden, solange beide Seiten aktiv bleiben. Schließen oder Neuladen einer Seite oder das Beenden der App-Sitzung beendet die Live-Übertragung. Beim gespeicherten Link muss die empfangende Person nicht online sein; die Senderseite bleibt aber bis zum Upload-Ende offen.",
      },
      {
        q: "Wie ist meine Privatsphäre bei großen Dateien geschützt?",
        a: "Echtzeitübertragungen sind mit X25519 und AES-256-GCM pro Block Ende-zu-Ende verschlüsselt; der Schlüssel erreicht keinen Server. Mit eingeschalteter erweiterter Verifizierung (standardmäßig aus) zeigen beide Geräte einen sechsstelligen Verifizierungscode; jede Datei wird per SHA-256 geprüft. WebRTC ist im selben LAN direkt; netzübergreifende Browser nutzen TURN planmäßig, und das Relay transportiert nur Chiffretext, den es weder lesen noch entschlüsseln kann.",
      },
    ],
  },
  cta: {
    text: "Bewege deine nächste mehrere Gigabyte große Datei ohne Cloud — hinterlass einen verschlüsselten Download-Link oder verbinde beide Geräte und schick sie sofort. Keine Installation und im selben Netz kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer de gros fichiers sans le cloud",
  description:
    "Pour les grosses vidéos et archives, créez un lien de téléchargement chiffré de bout en bout à récupérer plus tard ; le temps réel reste l'option immédiate si les deux côtés restent en ligne.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Un export vidéo de 20 Go ou une lourde archive de projet, c'est justement là que le stockage cloud paraît le plus lent : vous téléversez tout le fichier une fois, vous attendez, puis l'autre personne le télécharge à nouveau — deux transferts complets, plus ce que votre quota de stockage autorise. Pour une remise unique, cela fait beaucoup de copies et d'attente pour des octets qui ne devaient aller que de A à B.",
    "Pour un gros fichier, Relayium recommande un lien de téléchargement stocké et chiffré de bout en bout : le destinataire n'a pas besoin d'être en ligne pendant l'envoi et récupère plus tard. Gardez la page d'envoi ouverte jusqu'à la fin ; ensuite le lien reste disponible jusqu'à expiration. Si les deux côtés restent en ligne, le temps réel est l'alternative immédiate : WebRTC direct sur le LAN, ou chiffré de bout en bout via TURN entre réseaux. Le temps réel ne conserve aucune copie de contenu ni historique côté serveur.",
  ],
  sections: [
    {
      heading: "Pourquoi le lien stocké est le choix par défaut pour les gros fichiers",
      body: [
        "Un lien Relayium ne stocke que le texte chiffré produit dans le navigateur. Le destinataire peut être hors ligne pendant l'envoi et récupérer plus tard ; après la fin du téléversement, fermer la page d'envoi ne supprime pas le lien. Les limites affichées sont la taille par fichier, le quota et l'expiration.",
        "Le temps réel est l'alternative si les deux côtés sont prêts maintenant. WebRTC est direct et sans compte sur le même LAN ; entre réseaux, TURN porte le chiffré de bout en bout et le créateur du code se connecte. Les deux pages doivent rester actives : ce mode convient mieux aux petits fichiers et au texte qu'à une longue livraison volumineuse.",
      ],
    },
    {
      heading: "Aucune limite de taille en mode temps réel",
      body: [
        "Les transferts en temps réel n'ont aucune limite de stockage côté serveur, car Relayium ne conserve aucune copie du contenu. Un relais TURN peut transporter le texte chiffré entre réseaux pendant que les deux côtés sont en ligne, mais ne peut ni le lire, ni le déchiffrer, ni le garder comme historique. Le plafond pratique vient du navigateur qui reçoit.",
        "Chrome et Edge peuvent diffuser un fichier temps réel directement sur le disque, donc le protocole peut techniquement transporter des dizaines de gigaoctets. Ce n'est pas la recommandation par défaut pour les gros fichiers : la session vivante exige toujours les deux pages actives. Un lot contient jusqu'à 1 000 fichiers, chacun vérifié par SHA-256.",
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
        "Une brève coupure de transport peut reprendre depuis un point durable tant que les deux pages vivantes restent actives. Fermer ou recharger une page, ou terminer la session de l'app, met fin au transfert vivant. C'est une raison supplémentaire de préférer le lien stocké pour les gros fichiers.",
        "La connectivité est gérée de la même façon. Sur un même réseau, le transfert se fait directement d'appareil à appareil ; entre réseaux, le flux chiffré passe par un relais TURN. Le relais ne voit que du texte chiffré, si bien que cette voie reste elle aussi chiffrée de bout en bout.",
      ],
    },
    {
      heading: "Envoyer maintenant, ou laisser un lien pour plus tard",
      body: [
        "Le transfert en temps réel exige que les deux personnes soient en ligne en même temps, ce qui est idéal quand vous pouvez vous coordonner. Si l'autre personne n'est pas disponible, vous pouvez créer un lien de téléchargement stocké.",
        "Un lien stocké est à divulgation nulle : le navigateur chiffre en AES-256-GCM avant l'envoi et la clé ne vit que dans le fragment de l'URL. Sa création exige une connexion, utilise un quota et le lien expire. La page de téléchargement peut diffuser un fichier sur le disque même dans Firefox et Safari. Pour les plus gros fichiers, choisissez d'abord le lien stocké : le destinataire n'a pas besoin d'être en ligne pendant l'envoi ; gardez la page d'envoi ouverte jusqu'à la fin, puis le lien reste disponible jusqu'à expiration même après fermeture d'un ordinateur. Gardez la voie vivante pour une remise immédiate quand vous êtes tous deux devant l'écran.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Quelle est la taille maximale d'un fichier que je peux envoyer ?",
        a: "Pour les gros fichiers, utilisez le lien stocké ; la taille maximale et le quota sont affichés avant l'envoi. Le temps réel n'a pas de limite côté serveur et Chrome/Edge peut diffuser sur le disque, mais les deux pages doivent rester actives. Firefox/Safari garde une réception temps réel en mémoire et avertit vers 256 Mo — une estimation prudente, pas une limite ferme.",
      },
      {
        q: "Que se passe-t-il si le transfert est interrompu ?",
        a: "Une brève coupure peut reprendre depuis un point durable tant que les deux pages restent actives. Fermer ou recharger une page, ou terminer la session de l'app, met fin au transfert vivant. Avec un lien stocké, le destinataire peut être hors ligne, mais la page d'envoi reste ouverte jusqu'à la fin du téléversement.",
      },
      {
        q: "Comment ma vie privée est-elle protégée pour les gros fichiers ?",
        a: "Les transferts en temps réel utilisent X25519 et AES-256-GCM par bloc de bout en bout ; la clé n'atteint aucun serveur. Avec la vérification avancée activée (désactivée par défaut), les deux appareils affichent un code à 6 chiffres, et chaque fichier est vérifié par SHA-256. WebRTC est direct sur le même LAN ; entre réseaux, les navigateurs utilisent TURN par conception, et le relais ne transporte que du texte chiffré qu'il ne peut ni lire ni déchiffrer.",
      },
    ],
  },
  cta: {
    text: "Déplacez votre prochain fichier de plusieurs gigaoctets sans le cloud — laissez un lien de téléchargement chiffré, ou connectez les deux appareils et envoyez-le tout de suite. Sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "كيفية إرسال الملفات الكبيرة دون سحابة",
  description:
    "للملفات الكبيرة أنشئ رابط تنزيل مشفّرًا من الطرف إلى الطرف ليستلمه الطرف الآخر لاحقًا؛ ويبقى النقل الفوري بديلًا مباشرًا عندما يستطيع الطرفان البقاء متصلين.",
  updatedLabel: "آخر تحديث",
  lead: [
    "تصدير فيديو بحجم 20 غيغابايت أو أرشيف مشروع ثقيل هو تحديدًا حيث يبدو تخزين السحابة أبطأ ما يكون: ترفع الملف كاملًا مرة، تنتظر، ثم ينزّله الطرف الآخر مجددًا — نقلتان كاملتان زائد ما تسمح به حصة التخزين لديك. لتسليم لمرة واحدة، هذا كمٌّ كبير من النسخ والانتظار لبايتات لم تكن بحاجة إلا للانتقال من أ إلى ب.",
    "للملف الكبير يوصي Relayium برابط تنزيل مخزّن ومشفّر من الطرف إلى الطرف: لا يلزم اتصال المستقبِل أثناء الرفع ويمكنه الاستلام لاحقًا. أبقِ صفحة المُرسِل مفتوحة حتى يكتمل الرفع؛ بعدها يبقى الرابط حتى انتهاء صلاحيته. وإذا أمكن للطرفين البقاء متصلين فالنقل الفوري بديل مباشر: WebRTC داخل LAN وTURN للنص المشفّر عبر الشبكات. ولا يحتفظ النقل الفوري بنسخة محتوى على الخادم أو بسجل.",
  ],
  sections: [
    {
      heading: "لماذا يكون الرابط المخزّن الخيار الافتراضي للملفات الكبيرة",
      body: [
        "لا يخزّن رابط Relayium إلا النص المشفّر في المتصفح. يمكن للمستقبِل أن يكون غير متصل أثناء الرفع وأن يستلم لاحقًا؛ وبعد اكتمال الرفع لا يؤدي إغلاق صفحة المُرسِل إلى حذف الرابط. الحدود المعروضة هي حجم الملف والحصة ومدة الصلاحية.",
        "النقل الفوري بديل عندما يكون الطرفان مستعدين الآن. يتصل WebRTC مباشرةً وبدون حساب داخل LAN؛ وعبر الشبكات يحمل TURN النص المشفّر ويسجّل منشئ الرمز الدخول. يجب إبقاء الصفحتين نشطتين، لذا يناسب الملفات الصغيرة والنص أكثر من تسليم ملف كبير طويل.",
      ],
    },
    {
      heading: "لا سقف للحجم في الوضع الفوري",
      body: [
        "لا يملك النقل الفوري حدًا لحجم التخزين على الخادم لأن Relayium لا يحتفظ بنسخة من المحتوى. قد يحمل مُرحِّل TURN النص المشفّر عبر الشبكات أثناء اتصال الطرفين، لكنه لا يستطيع قراءته أو فك تشفيره أو الاحتفاظ به كسجل نقل. السقف العملي يحدده المتصفح المستقبِل.",
        "يستطيع Chrome وEdge بث ملف فوري مباشرةً إلى القرص، لذا يمكن للبروتوكول تقنيًا حمل عشرات الغيغابايت. لكن ذلك ليس التوصية الافتراضية للملفات الكبيرة: ما زالت الجلسة الحية تحتاج الصفحتين نشطتين. تضم الدفعة حتى 1,000 ملف ويُفحَص كل ملف بـ SHA-256.",
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
        "يمكن استئناف انقطاع نقل قصير من نقطة محفوظة ما دامت الصفحتان الحيتان نشطتين. أما إغلاق أو تحديث أي صفحة أو إنهاء جلسة التطبيق فيُنهي النقل الحي ويتطلب بدء تسليم جديد. وهذا سبب آخر لتفضيل الرابط المخزّن للملفات الكبيرة.",
        "تُعالَج الاتصالية بالطريقة نفسها. داخل الشبكة الواحدة يجري النقل من الند للند مباشرةً؛ وعبر الشبكات يمرّ التدفق المشفَّر على مُرحِّل TURN. لا يرى المُرحِّل سوى نص مُشفَّر، فيبقى هذا المسار أيضًا مشفَّرًا من الطرف إلى الطرف.",
      ],
    },
    {
      heading: "أرسِل الآن، أو اترك رابطًا للاحقًا",
      body: [
        "يحتاج النقل الفوري إلى أن يكون الطرفان متصلين في الوقت نفسه، وهو مثالي حين يمكنك التنسيق. إذا لم يكن الطرف الآخر متاحًا الآن، يمكنك بدلًا من ذلك إنشاء رابط تنزيل مُخزَّن.",
        "الرابط المُخزَّن ذو معرفة صفرية: يشفّر المتصفح بـ AES-256-GCM قبل الرفع ولا يوجد المفتاح إلا في جزء URL. يتطلب الإنشاء تسجيل الدخول ويستهلك حصة وينتهي. ويمكن لصفحة التنزيل بث ملف إلى القرص حتى في Firefox وSafari. للملفات الأكبر اختر الرابط أولًا: لا يلزم اتصال المستقبِل أثناء الرفع؛ أبقِ صفحة المُرسِل مفتوحة حتى يكتمل، وبعدها يبقى الرابط حتى انتهاء صلاحيته حتى لو أُغلق حاسوب. استخدم المسار الحي عندما تكونان أمام الجهازين وتريدان الوصول الآن.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "ما أكبر ملف يمكنني إرساله؟",
        a: "للملفات الكبيرة استخدم رابط التنزيل المخزّن؛ تُعرض حدود الملف والحصة قبل الرفع. لا حد من جهة الخادم للنقل الفوري، ويستطيع Chrome وEdge البث إلى القرص، لكن يجب إبقاء الصفحتين نشطتين. يحتفظ Firefox وSafari بالاستقبال الفوري في الذاكرة ويظهر تحذير نحو 256 ميغابايت — تقدير متحفّظ لا حد صارم.",
      },
      {
        q: "ماذا يحدث إذا قُوطِع النقل؟",
        a: "يمكن استئناف انقطاع قصير من نقطة محفوظة ما دامت الصفحتان نشطتين. إغلاق أو تحديث صفحة أو إنهاء جلسة التطبيق ينهي النقل الحي. مع الرابط المخزّن لا يلزم اتصال المستقبِل، لكن يجب إبقاء صفحة المُرسِل مفتوحة حتى يكتمل الرفع.",
      },
      {
        q: "كيف تُحمى خصوصيتي للملفات الكبيرة؟",
        a: "النقل الفوري مشفّر من الطرف إلى الطرف عبر X25519 وAES-256-GCM لكل كتلة، ولا يصل المفتاح إلى أي خادم. وعند تفعيل التحقّق المتقدّم (المعطَّل افتراضيًا) يعرض الجهازان رمزًا من 6 أرقام، ويُفحص كل ملف بـ SHA-256. يتصل WebRTC مباشرةً داخل شبكة LAN نفسها؛ وعبر الشبكات تستخدم المتصفحات TURN حسب التصميم، ولا يحمل المُرحِّل إلا نصًا مشفّرًا لا يستطيع قراءته أو فك تشفيره.",
      },
    ],
  },
  cta: {
    text: "انقل ملفك التالي بحجم عدة غيغابايت دون سحابة — اترك رابط تنزيل مشفّرًا، أو اربط الجهازين وأرسِله الآن. دون تثبيت، ودون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Cómo enviar archivos grandes sin la nube",
  description:
    "Para vídeos y archivos grandes, crea un enlace de descarga cifrado de extremo a extremo para recoger más tarde; el tiempo real queda como alternativa inmediata si ambos lados siguen en línea.",
  updatedLabel: "Última actualización",
  lead: [
    "Una exportación de vídeo de 20 GB o un pesado archivo de proyecto es justo donde el almacenamiento en la nube se siente más lento: subes el archivo entero una vez, esperas y luego la otra persona lo descarga de nuevo — dos transferencias completas más lo que permita tu cuota de almacenamiento. Para una entrega única, es mucho copiar y esperar por bytes que solo tenían que ir de A a B.",
    "Para un archivo grande, Relayium recomienda un enlace almacenado y cifrado de extremo a extremo: quien recibe no necesita estar en línea durante la subida y lo recoge después. Mantén abierta la página de envío hasta que termine; luego el enlace queda disponible hasta caducar. Si ambos pueden seguir en línea, el tiempo real es la alternativa inmediata: WebRTC directo en LAN o texto cifrado por TURN entre redes. El tiempo real no conserva copia de contenido ni historial en el servidor.",
  ],
  sections: [
    {
      heading: "Por qué el enlace almacenado es la opción predeterminada para archivos grandes",
      body: [
        "Un enlace de Relayium almacena solo el texto cifrado creado en el navegador. Quien recibe puede estar desconectado durante la subida y recogerlo después; una vez terminada, cerrar la página de envío no elimina el enlace. Los límites mostrados son el máximo por archivo, la cuota y la caducidad.",
        "El tiempo real es la alternativa cuando ambos están listos ahora. WebRTC conecta directamente y sin cuenta en la misma LAN; entre redes TURN transporta el cifrado de extremo a extremo y quien crea el código inicia sesión. Ambas páginas deben seguir activas, así que sirve mejor para archivos pequeños y texto que para una entrega grande y larga.",
      ],
    },
    {
      heading: "Sin límite de tamaño en modo en tiempo real",
      body: [
        "Las transferencias en tiempo real no tienen límite de almacenamiento del lado del servidor porque Relayium no conserva una copia del contenido. Un retransmisor TURN puede transportar texto cifrado entre redes mientras ambos lados están conectados, pero no puede leerlo, descifrarlo ni guardarlo como historial. El tope práctico lo fija el navegador que recibe.",
        "Chrome y Edge pueden transmitir un archivo en tiempo real directamente al disco, así que el protocolo puede llevar técnicamente decenas de gigabytes. No es la recomendación predeterminada para archivos grandes: la sesión viva aún exige ambas páginas activas. Un lote admite hasta 1.000 archivos, cada uno verificado con SHA-256.",
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
        "Una caída breve del transporte puede reanudarse desde un punto guardado mientras ambas páginas vivas sigan activas. Cerrar o recargar una página, o terminar la sesión de la app, finaliza la transferencia viva. Es otra razón para preferir el enlace almacenado con archivos grandes.",
        "La conectividad se maneja de la misma forma. Dentro de una misma red la transferencia va directamente de dispositivo a dispositivo; entre redes, el flujo cifrado viaja por un retransmisor TURN. El retransmisor solo ve texto cifrado, así que esa vía también sigue cifrada de extremo a extremo.",
      ],
    },
    {
      heading: "Envía ahora, o deja un enlace para después",
      body: [
        "La transferencia en tiempo real necesita a ambas personas en línea al mismo tiempo, lo cual es ideal cuando puedes coordinarte. Si la otra persona no está disponible ahora mismo, puedes crear un enlace de descarga almacenado.",
        "Un enlace almacenado es de conocimiento cero: el navegador cifra con AES-256-GCM antes de subir y la clave solo vive en el fragmento de la URL. Crearlo exige iniciar sesión, consume cuota y caduca. La descarga puede transmitir al disco incluso en Firefox y Safari. Para los archivos más grandes elige primero el enlace: quien recibe no necesita estar en línea durante la subida; mantén abierta la página de envío hasta terminar y después el enlace queda disponible hasta caducar aunque se cierre un portátil. Usa la vía viva cuando ambos estén delante del ordenador y quieran recibir ya.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Cuál es el archivo más grande que puedo enviar?",
        a: "Para archivos grandes usa el enlace almacenado; el máximo y la cuota aparecen antes de subir. El tiempo real no tiene límite del lado del servidor y Chrome/Edge puede transmitir al disco, pero ambas páginas deben seguir activas. Firefox/Safari mantiene una recepción en tiempo real en memoria y avisa cerca de 256 MB — una estimación prudente, no un límite rígido.",
      },
      {
        q: "¿Qué pasa si la transferencia se interrumpe?",
        a: "Una caída breve puede reanudarse desde un punto guardado mientras ambas páginas sigan activas. Cerrar o recargar una página, o terminar la sesión de la app, finaliza la transferencia viva. Con el enlace almacenado quien recibe puede estar desconectado, pero la página de envío debe seguir abierta hasta que termine la subida.",
      },
      {
        q: "¿Cómo se protege mi privacidad con archivos grandes?",
        a: "Las transferencias en tiempo real usan X25519 y AES-256-GCM por bloque de extremo a extremo; la clave no llega a ningún servidor. Con la verificación avanzada activada (desactivada por omisión), ambos dispositivos muestran un código de 6 dígitos, y cada archivo se verifica con SHA-256. WebRTC es directo en la misma LAN; entre redes, los navegadores usan TURN por diseño y el retransmisor solo transporta texto cifrado que no puede leer ni descifrar.",
      },
    ],
  },
  cta: {
    text: "Mueve tu próximo archivo de varios gigabytes sin la nube — deja un enlace de descarga cifrado, o conecta ambos dispositivos y envíalo ahora. Sin instalación, y sin necesidad de cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Como enviar arquivos grandes sem a nuvem",
  description:
    "Para vídeos e arquivos grandes, crie um link de download criptografado de ponta a ponta para pegar depois; o tempo real fica como alternativa imediata se os dois lados permanecerem online.",
  updatedLabel: "Última atualização",
  lead: [
    "Uma exportação de vídeo de 20 GB ou um arquivo de projeto pesado é exatamente onde o armazenamento em nuvem parece mais lento: você faz upload do arquivo inteiro uma vez, espera e a outra pessoa faz o download de novo — duas transferências completas mais o que sua cota de armazenamento permitir. Para uma entrega única, é muita cópia e espera por bytes que só precisavam ir de A para B.",
    "Para um arquivo grande, o Relayium recomenda um link armazenado e criptografado de ponta a ponta: quem recebe não precisa estar online durante o upload e pega depois. Mantenha a página de envio aberta até terminar; depois o link fica disponível até expirar. Se os dois puderem continuar online, o tempo real é a alternativa imediata: WebRTC direto na LAN ou texto cifrado pelo TURN entre redes. O tempo real não mantém cópia de conteúdo nem histórico no servidor.",
  ],
  sections: [
    {
      heading: "Por que o link armazenado é o padrão para arquivos grandes",
      body: [
        "Um link do Relayium armazena apenas o texto cifrado criado no navegador. Quem recebe pode ficar offline durante o upload e pegar depois; quando o upload termina, fechar a página de envio não remove o link. Os limites mostrados são o máximo por arquivo, a cota e a validade.",
        "O tempo real é a alternativa quando os dois estão prontos agora. O WebRTC conecta direto e sem conta na mesma LAN; entre redes, o TURN transporta a criptografia de ponta a ponta e quem cria o código entra. As duas páginas precisam ficar ativas, então esse modo serve melhor para arquivos pequenos e texto do que para uma entrega grande e demorada.",
      ],
    },
    {
      heading: "Sem limite de tamanho no modo em tempo real",
      body: [
        "As transferências em tempo real não têm limite de armazenamento do lado do servidor porque o Relayium não mantém uma cópia do conteúdo. Um retransmissor TURN pode transportar texto cifrado entre redes enquanto os dois lados estão online, mas não consegue ler, descriptografar ou guardá-lo como histórico. O teto prático é definido pelo navegador que recebe.",
        "Chrome e Edge podem transmitir um arquivo em tempo real direto para o disco, então o protocolo pode carregar tecnicamente dezenas de gigabytes. Isso não é a recomendação padrão para arquivos grandes: a sessão ao vivo ainda exige as duas páginas ativas. Um lote aceita até 1.000 arquivos, cada um verificado com SHA-256.",
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
        "Uma queda breve do transporte pode retomar de um ponto salvo enquanto as duas páginas ao vivo continuam ativas. Fechar ou recarregar uma página, ou encerrar a sessão do app, termina a transferência ao vivo. É outro motivo para preferir o link armazenado em arquivos grandes.",
        "A conectividade é tratada da mesma forma. Dentro de uma mesma rede a transferência vai direto de dispositivo para dispositivo; entre redes, o fluxo criptografado viaja por um retransmissor TURN. O retransmissor só vê texto cifrado, então esse caminho também permanece criptografado de ponta a ponta.",
      ],
    },
    {
      heading: "Envie agora ou deixe um link para depois",
      body: [
        "A transferência em tempo real precisa das duas pessoas online ao mesmo tempo, o que é ideal quando dá para coordenar. Se a outra pessoa não estiver disponível agora, você pode criar um link de download armazenado.",
        "Um link armazenado é de conhecimento zero: o navegador criptografa com AES-256-GCM antes do upload e a chave só fica no fragmento da URL. Criá-lo exige login, usa cota e expira. O download pode transmitir ao disco até no Firefox e Safari. Para os maiores arquivos escolha primeiro o link: quem recebe não precisa estar online durante o upload; mantenha a página de envio aberta até terminar e depois o link fica disponível até expirar mesmo com um notebook fechado. Use o caminho ao vivo quando os dois estiverem diante do computador e quiserem receber agora.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Qual é o maior arquivo que posso enviar?",
        a: "Para arquivos grandes use o link armazenado; o máximo e a cota aparecem antes do upload. O tempo real não tem limite no servidor e Chrome/Edge pode transmitir ao disco, mas as duas páginas precisam continuar ativas. Firefox/Safari mantém uma recepção em tempo real na memória e avisa perto de 256 MB — uma estimativa conservadora, não um limite rígido.",
      },
      {
        q: "O que acontece se a transferência for interrompida?",
        a: "Uma queda breve pode retomar de um ponto salvo enquanto as duas páginas continuam ativas. Fechar ou recarregar uma página, ou encerrar a sessão do app, termina a transferência ao vivo. No link armazenado quem recebe pode ficar offline, mas a página de envio deve permanecer aberta até o upload terminar.",
      },
      {
        q: "Como minha privacidade é protegida em arquivos grandes?",
        a: "As transferências em tempo real usam X25519 e AES-256-GCM por bloco de ponta a ponta; a chave não chega a nenhum servidor. Com a verificação avançada ativada (desligada por padrão), os dois dispositivos mostram um código de 6 dígitos, e cada arquivo é verificado com SHA-256. O WebRTC é direto na mesma LAN; entre redes, os navegadores usam TURN por design e o retransmissor só transporta texto cifrado que não consegue ler nem descriptografar.",
      },
    ],
  },
  cta: {
    text: "Mova seu próximo arquivo de vários gigabytes sem a nuvem — deixe um link de download criptografado, ou conecte os dois aparelhos e envie agora. Sem instalação e sem precisar de conta na mesma rede.",
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
