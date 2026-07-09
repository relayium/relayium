// web/scripts/pages/content/articles/compare-airdrop.mjs
// Objective comparison: Relayium vs AirDrop. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "Relayium vs AirDrop: a cross-platform AirDrop alternative",
  description:
    "An honest look at AirDrop and Relayium. AirDrop is excellent inside Apple's ecosystem; Relayium runs in any browser so a Windows, Android or Linux device can send to an iPhone or Mac, and back.",
  updatedLabel: "Last updated",
  lead: [
    "AirDrop is one of the best file-sharing experiences ever shipped. Between an iPhone, iPad and Mac it is fast, private, and effortlessly built into the system — Relayium does not pretend to beat it on Apple's home turf.",
    "The catch is the boundary: AirDrop only talks to other Apple devices. This article compares the two fairly, explains where AirDrop is genuinely better, and shows where Relayium helps — sending between an iPhone and a Windows PC, an Android phone and a Mac, or a Linux laptop and an iPad, straight from the browser.",
  ],
  sections: [
    {
      heading: "What AirDrop gets right",
      body: [
        "AirDrop uses Apple Wireless Direct Link to bring up a peer-to-peer Wi-Fi connection between two nearby devices, with Bluetooth handling discovery. The result is quick, direct, and works even when neither device is on a network — no router, no internet, no account.",
        "It is also deeply integrated: the share sheet is one tap away in every app, transfers are encrypted, and received files land in the right place automatically. For moving photos or documents around inside an all-Apple household, it is hard to beat.",
      ],
    },
    {
      heading: "The catch: AirDrop stays inside Apple's world",
      body: [
        "AirDrop simply does not exist for Windows, Android or Linux. There is no official client and no interoperability, so the moment one side of the transfer is not an Apple device, AirDrop is not an option at all.",
        "That is exactly the gap most people hit: an iPhone photo that needs to reach a Windows PC, an Android video going to a Mac, or files moving between a Linux workstation and an iPad. The usual workarounds — a cable, email to yourself, or a cloud upload and re-download — are slower and route your files through someone else's server.",
      ],
    },
    {
      heading: "How Relayium bridges the gap",
      body: [
        "Relayium runs entirely in a modern web browser with nothing to install, so any two devices that can open a web page can transfer to each other regardless of platform: Windows, macOS, Linux, Android and iOS all interoperate. On the same Wi-Fi, both devices open relayium.com and discover each other automatically; on different networks you connect with a short pairing code instead.",
        "The transfer itself goes directly peer-to-peer over WebRTC whenever possible, with a second, independent encryption layer on top: an X25519 key exchange derives a key used for per-chunk AES-256-GCM, and that key never reaches any server. Both devices show the same 6-digit verification code (a Short Authentication String) so you can confirm no one sits in the middle, and each file is checked end-to-end with a SHA-256 hash. You can send up to 1,000 files per batch; on the same network no account is needed, and sending across networks with a pairing code requires the sender to sign in — the receiver never needs an account. If the connection drops, the transfer can resume instead of restarting.",
      ],
    },
    {
      heading: "Honest limits on iPhone and iPad",
      body: [
        "This is the part to be upfront about: receiving large files in a mobile browser is not as smooth as native AirDrop. Safari and Firefox buffer the incoming file in memory, so on an iPhone or iPad it is best to keep transfers under about 200 MB to stay comfortably within what the browser can hold.",
        "On desktop the story is better: Chrome and Edge can stream directly to disk, which removes the size cap entirely, so large files flow without filling up memory. When a direct connection is impossible, the encrypted stream falls back to a TURN relay that only ever sees ciphertext, so it stays end-to-end encrypted. There is also an optional stored download-link mode — your browser encrypts the files with AES-256-GCM and the key lives only in the URL fragment, so the server holds zero-knowledge ciphertext it cannot read; creating such a link requires the sender to sign in, while realtime transfers do not.",
      ],
    },
    {
      heading: "AirDrop vs Relayium at a glance",
      body: [
        "The differences that matter most, side by side:",
      ],
      bullets: [
        "Platforms: AirDrop is Apple-only; Relayium works across Windows, macOS, Linux, Android and iOS in the browser.",
        "Install: AirDrop is built into Apple's system; Relayium needs no app or install, just a web page.",
        "Across networks: AirDrop is nearby-only; Relayium connects on the same Wi-Fi or across networks with a pairing code.",
        "Encryption: both are encrypted; Relayium adds X25519 + AES-256-GCM with a 6-digit code you verify and per-file SHA-256 checks.",
        "Large files on mobile: AirDrop is smoother; Relayium suggests keeping browser transfers under about 200 MB on iOS, while Chrome/Edge on desktop have no size cap.",
        "Account: AirDrop never needs one; Relayium needs no account on the same network, but the sender must sign in to pair across networks or to create a stored download link — the receiver never needs an account.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is there an AirDrop for Windows?",
        a: "No — AirDrop is exclusive to Apple devices and has no Windows client. Relayium is the cross-platform alternative: it runs in any browser, so a Windows PC can send to and receive from an iPhone or Mac just as easily as between two Apple devices.",
      },
      {
        q: "How do I send a file from an iPhone to a Windows PC?",
        a: "Open relayium.com in a browser on both devices. On the same Wi-Fi they discover each other automatically; otherwise enter the pairing code shown on one device into the other, which requires the sender to sign in. Pick up to 1,000 files, confirm the 6-digit verification code matches on both screens, and the transfer runs directly between them.",
      },
      {
        q: "Do I need to install an app?",
        a: "No. Relayium is a web page — there is nothing to install on either device, on any operating system. It is free and open source under the MIT license at github.com/relayium/relayium, so you can audit it or run your own instance.",
      },
    ],
  },
  cta: {
    text: "Send between Apple and everything else — no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 AirDrop：跨平台的隔空投送替代方案",
  description:
    "客观看待 AirDrop 与 Relayium。AirDrop 在 Apple 生态内体验出色；Relayium 在任意浏览器里运行，让 Windows、Android、Linux 设备也能与 iPhone、Mac 互传。",
  updatedLabel: "最近更新",
  lead: [
    "AirDrop 是有史以来最出色的文件分享体验之一。在 iPhone、iPad 与 Mac 之间，它快速、私密，又天然融入系统——Relayium 并不打算在 Apple 的主场上胜过它。",
    "问题在于边界：AirDrop 只能与其他 Apple 设备互通。本文客观对比两者，说明 AirDrop 真正更好的地方，也展示 Relayium 能帮上忙的场景——直接在浏览器里完成 iPhone 与 Windows 电脑、Android 手机与 Mac、或 Linux 笔记本与 iPad 之间的互传。",
  ],
  sections: [
    {
      heading: "AirDrop 做得好的地方",
      body: [
        "AirDrop 用 Apple Wireless Direct Link（AWDL）在两台就近设备之间建立点对点 Wi-Fi 直连，由蓝牙负责发现。结果是快速、直连，即便双方都不连网络也能用——不需要路由器、不需要联网、不需要账号。",
        "它还深度集成：每个 App 里的分享面板都触手可及，传输经过加密，收到的文件也会自动归位。在全 Apple 的家庭里搬运照片或文档，几乎无可匹敌。",
      ],
    },
    {
      heading: "问题所在：AirDrop 只活在 Apple 的世界里",
      body: [
        "AirDrop 在 Windows、Android 或 Linux 上根本不存在。没有官方客户端，也没有互通，所以只要传输一方不是 Apple 设备，AirDrop 就完全不是选项。",
        "而这正是多数人会撞上的空缺：iPhone 里的照片要发到 Windows 电脑、Android 视频要传给 Mac，或者文件要在 Linux 工作站与 iPad 之间往返。常见的绕路办法——数据线、给自己发邮件、或上传到网盘再下载——都更慢，而且要让文件经过别人的服务器。",
      ],
    },
    {
      heading: "Relayium 如何填补这道空缺",
      body: [
        "Relayium 完全运行在现代浏览器里，无需安装任何软件，因此只要两台设备都能打开网页，无论平台都能互传：Windows、macOS、Linux、Android 与 iOS 全部互通。在同一 Wi-Fi 下，两台设备打开 relayium.com 就能自动相互发现；不在同一网络时，则用一段配对码来连接。",
        "只要条件允许，传输本身会通过 WebRTC 点对点直连，并在其上叠加一层独立加密：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密，这把密钥从不发送给任何服务器。两台设备会显示同一段 6 位校验码（SAS），你可据此确认没有人插在中间；每个文件还会用 SHA-256 做端到端完整性校验。每批最多可发送 1,000 个文件；同一网络下无需账号，跨网络用配对码传输则需要发送方登录——接收方始终无需账号。若连接中断，传输还能断点续传而不必从头再来。",
      ],
    },
    {
      heading: "在 iPhone 和 iPad 上的诚实局限",
      body: [
        "这一点得坦诚说明：在移动端浏览器里接收大文件，不如原生 AirDrop 那样顺滑。Safari 与 Firefox 会把收到的文件缓冲在内存里，因此在 iPhone 或 iPad 上，最好把单次传输控制在约 200 MB 以内，留在浏览器能承载的范围内。",
        "在桌面端情况更好：Chrome 与 Edge 可以直接流式写入磁盘，从而彻底取消大小上限，大文件也能顺畅传输而不占满内存。当无法直连时，加密数据流会退回到 TURN 中继，而中继只能看到密文，因此始终保持端到端加密。此外还有可选的存储下载链接模式——浏览器先用 AES-256-GCM 加密文件，密钥只存在于 URL 片段里，服务器只保存无法解读的零知识密文；生成这样的链接需要发送方登录，而实时传输则不需要。",
      ],
    },
    {
      heading: "AirDrop 与 Relayium 一览对比",
      body: [
        "把最关键的差别并排列出：",
      ],
      bullets: [
        "平台：AirDrop 仅限 Apple；Relayium 在浏览器里横跨 Windows、macOS、Linux、Android 与 iOS。",
        "安装：AirDrop 内建于 Apple 系统；Relayium 无需 App、无需安装，一个网页即可。",
        "跨网络：AirDrop 只能就近；Relayium 在同一 Wi-Fi 或用配对码跨网络都能连。",
        "加密：两者都加密；Relayium 额外叠加 X25519 + AES-256-GCM，配以你亲自核对的 6 位校验码和逐文件 SHA-256 校验。",
        "移动端大文件：AirDrop 更顺滑；Relayium 建议在 iOS 浏览器上把单次传输控制在约 200 MB 以内，而桌面端 Chrome/Edge 无大小上限。",
        "账号：AirDrop 从不需要账号；Relayium 在同一网络下无需账号，但跨网络配对或生成存储下载链接时需要发送方登录——接收方始终无需账号。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Windows 有 AirDrop 吗？",
        a: "没有——AirDrop 是 Apple 设备专属，没有 Windows 客户端。Relayium 就是那条跨平台的替代路径：它在任意浏览器里运行，Windows 电脑与 iPhone 或 Mac 互发互收，和两台 Apple 设备之间一样轻松。",
      },
      {
        q: "iPhone 上的文件怎么传到 Windows 电脑？",
        a: "在两台设备的浏览器里都打开 relayium.com。同一 Wi-Fi 下它们会自动相互发现；否则把一台设备上显示的配对码输入到另一台，这需要发送方先登录。选好最多 1,000 个文件，核对两块屏幕上的 6 位校验码一致，传输就会在两者之间直接进行。",
      },
      {
        q: "需要安装 App 吗？",
        a: "不需要。Relayium 就是一个网页——在任何操作系统上、任何一台设备上都无需安装。它采用 MIT 许可，免费且开源，代码公开在 github.com/relayium/relayium，你可以审计它或自建实例。",
      },
    ],
  },
  cta: {
    text: "在 Apple 与其他一切设备之间互传——无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と AirDrop の比較：クロスプラットフォームな代替",
  description:
    "AirDrop と Relayium を公平に見ます。AirDrop は Apple エコシステム内で優秀ですが、Relayium はどのブラウザでも動くので、Windows・Android・Linux の端末が iPhone や Mac と相互に転送できます。",
  updatedLabel: "最終更新",
  lead: [
    "AirDrop はこれまでで最も優れたファイル共有体験の一つです。iPhone・iPad・Mac の間では速く、プライベートで、システムに自然に組み込まれています——Relayium は Apple のホームグラウンドでそれに勝とうとはしません。",
    "問題は境界です。AirDrop は他の Apple 端末としか通信しません。本記事は両者を公平に比較し、AirDrop が本当に優れている点を説明し、Relayium が役立つ場面を示します——iPhone と Windows PC、Android スマホと Mac、あるいは Linux ノートと iPad の間の転送を、ブラウザから直接行えます。",
  ],
  sections: [
    {
      heading: "AirDrop の優れている点",
      body: [
        "AirDrop は Apple Wireless Direct Link（AWDL）を使い、近くの2台の端末間に P2P の Wi-Fi 直接接続を張り、発見は Bluetooth が担います。結果として速く、直接的で、どちらの端末もネットワークに接続していなくても動きます——ルーターも、インターネットも、アカウントも不要です。",
        "深く統合されてもいます。共有シートはどのアプリでもワンタップで、転送は暗号化され、受け取ったファイルは自動的に適切な場所に収まります。すべて Apple の家庭で写真や書類を動かすなら、まず敵いません。",
      ],
    },
    {
      heading: "問題点：AirDrop は Apple の世界の中に留まる",
      body: [
        "AirDrop は Windows・Android・Linux には存在しません。公式クライアントも相互運用性もないため、転送の片方が Apple 端末でない瞬間に、AirDrop はそもそも選択肢になりません。",
        "そしてこれこそ多くの人がぶつかる空白です。iPhone の写真を Windows PC へ、Android の動画を Mac へ、あるいはファイルを Linux ワークステーションと iPad の間で行き来させる。よくある回避策——ケーブル、自分宛てのメール、クラウドへのアップロードと再ダウンロード——はどれも遅く、ファイルを誰かのサーバー経由にしてしまいます。",
      ],
    },
    {
      heading: "Relayium がその空白を埋める方法",
      body: [
        "Relayium は最新のブラウザだけで完全に動作し、インストールは不要です。ですからウェブページを開ける2台の端末なら、プラットフォームを問わず相互に転送できます。Windows・macOS・Linux・Android・iOS がすべて相互運用します。同じ Wi-Fi では両方が relayium.com を開けば自動的に相手を発見し、異なるネットワークでは代わりに短いペアリングコードで接続します。",
        "転送自体は可能な限り WebRTC で P2P 直接に行われ、その上に独立した2つ目の暗号化層を重ねます。X25519 の鍵交換で導出した鍵をブロックごとの AES-256-GCM に使い、その鍵はどのサーバーにも届きません。両方の端末が同じ6桁の検証コード（ショート認証文字列、SAS）を表示するので、間に誰もいないことを確認でき、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。1バッチで最大1,000ファイルを送れます。同じネットワークならアカウントは不要で、ネットワークをまたいでペアリングコードで送る場合は送信側のサインインが必要です——受信側はどちらの場合もアカウント不要です。接続が切れても最初からではなく再開できます。",
      ],
    },
    {
      heading: "iPhone・iPad での正直な限界",
      body: [
        "ここは率直に言うべき点です。モバイルブラウザで大きなファイルを受け取るのは、ネイティブの AirDrop ほど滑らかではありません。Safari と Firefox は受信ファイルをメモリにバッファするため、iPhone や iPad ではブラウザが保持できる範囲に収めるよう、転送を約 200 MB 以内に抑えるのが安全です。",
        "デスクトップでは事情がよくなります。Chrome と Edge はディスクへ直接ストリーミングでき、サイズ上限が完全になくなるので、大きなファイルもメモリを埋めずに流れます。直接接続が不可能なときは、暗号化ストリームが TURN リレーにフォールバックしますが、リレーが見るのは暗号文だけなので、エンドツーエンド暗号化のままです。任意の保存型ダウンロードリンクもあります——ブラウザが AES-256-GCM でファイルを暗号化し、鍵は URL フラグメントにだけ存在するため、サーバーは読めないゼロ知識の暗号文を保存します。こうしたリンクの作成には送信側のサインインが必要で、リアルタイム転送には不要です。",
      ],
    },
    {
      heading: "AirDrop と Relayium の一覧比較",
      body: [
        "最も重要な違いを並べて示します。",
      ],
      bullets: [
        "プラットフォーム：AirDrop は Apple 専用。Relayium はブラウザで Windows・macOS・Linux・Android・iOS をまたぐ。",
        "インストール：AirDrop は Apple のシステムに内蔵。Relayium はアプリもインストールも不要で、ウェブページだけ。",
        "ネットワーク越え：AirDrop は近接のみ。Relayium は同じ Wi-Fi でも、ペアリングコードでネットワークをまたいでも接続。",
        "暗号化：どちらも暗号化。Relayium はさらに X25519 + AES-256-GCM を重ね、あなたが照合する6桁コードとファイルごとの SHA-256 チェックを備える。",
        "モバイルの大きなファイル：AirDrop の方が滑らか。Relayium は iOS のブラウザ転送を約 200 MB 以内に抑えることを勧め、デスクトップの Chrome/Edge にはサイズ上限がない。",
        "アカウント：AirDrop は常に不要。Relayium は同じネットワークなら不要だが、ネットワークをまたぐペアリングや保存型ダウンロードリンクの作成には送信側のサインインが要る——受信側はどちらの場合もアカウント不要。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Windows 版の AirDrop はありますか？",
        a: "ありません——AirDrop は Apple 端末専用で、Windows クライアントはありません。Relayium がそのクロスプラットフォームな代替です。どのブラウザでも動くので、Windows PC と iPhone や Mac のやり取りが、2台の Apple 端末どうしと同じくらい手軽にできます。",
      },
      {
        q: "iPhone から Windows PC へファイルを送るには？",
        a: "両方の端末のブラウザで relayium.com を開きます。同じ Wi-Fi なら自動的に相手を発見し、そうでなければ一方に表示されたペアリングコードをもう一方に入力します（これには送信側のサインインが必要です）。最大1,000ファイルを選び、両画面の6桁の検証コードが一致するのを確認すれば、転送は両者の間で直接行われます。",
      },
      {
        q: "アプリのインストールは必要ですか？",
        a: "いいえ。Relayium はウェブページです——どの OS でも、どちらの端末にもインストールするものはありません。MIT ライセンスの無料オープンソースで、コードは github.com/relayium/relayium に公開されており、監査も自分のインスタンス運用も可能です。",
      },
    ],
  },
  cta: {
    text: "Apple とそれ以外のすべての間で転送——インストール不要、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs AirDrop: 크로스플랫폼 에어드롭 대안",
  description:
    "AirDrop과 Relayium을 공정하게 살펴봅니다. AirDrop은 Apple 생태계 안에서 훌륭하지만, Relayium은 어떤 브라우저에서도 동작해 Windows·Android·Linux 기기가 iPhone·Mac과 서로 전송할 수 있습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "AirDrop은 지금까지 나온 파일 공유 경험 중 최고에 속합니다. iPhone·iPad·Mac 사이에서 빠르고 사적이며 시스템에 자연스럽게 녹아 있습니다 — Relayium은 Apple의 홈그라운드에서 그것을 이기려 하지 않습니다.",
    "문제는 경계입니다. AirDrop은 다른 Apple 기기하고만 통신합니다. 이 글은 둘을 공정하게 비교하고, AirDrop이 진짜로 더 나은 점을 설명하며, Relayium이 도움이 되는 상황을 보여줍니다 — iPhone과 Windows PC, Android 폰과 Mac, 또는 Linux 노트북과 iPad 사이의 전송을 브라우저에서 바로 할 수 있습니다.",
  ],
  sections: [
    {
      heading: "AirDrop이 잘하는 점",
      body: [
        "AirDrop은 Apple Wireless Direct Link(AWDL)를 사용해 가까운 두 기기 사이에 P2P Wi-Fi 직접 연결을 세우고, 발견은 Bluetooth가 맡습니다. 그 결과 빠르고 직접적이며, 어느 기기도 네트워크에 연결되어 있지 않아도 동작합니다 — 공유기도, 인터넷도, 계정도 필요 없습니다.",
        "깊이 통합되어 있기도 합니다. 공유 시트는 어느 앱에서나 한 번의 탭이면 되고, 전송은 암호화되며, 받은 파일은 자동으로 알맞은 곳에 놓입니다. 전부 Apple로 이뤄진 가정에서 사진이나 문서를 옮기는 데는 좀처럼 당할 상대가 없습니다.",
      ],
    },
    {
      heading: "문제점: AirDrop은 Apple의 세계 안에 머문다",
      body: [
        "AirDrop은 Windows·Android·Linux에는 존재하지 않습니다. 공식 클라이언트도 상호 운용성도 없으므로, 전송의 한쪽이 Apple 기기가 아닌 순간 AirDrop은 아예 선택지가 아닙니다.",
        "그리고 이것이 바로 대부분의 사람이 부딪히는 빈틈입니다. iPhone 사진을 Windows PC로, Android 영상을 Mac으로, 또는 파일을 Linux 워크스테이션과 iPad 사이에서 오가게 하는 일. 흔한 우회책 — 케이블, 자기 자신에게 메일 보내기, 클라우드 업로드 후 다시 다운로드 — 은 모두 느리고, 파일을 남의 서버를 거치게 만듭니다.",
      ],
    },
    {
      heading: "Relayium이 그 빈틈을 메우는 방법",
      body: [
        "Relayium은 최신 브라우저에서 설치 없이 완전히 동작하므로, 웹 페이지를 열 수 있는 두 기기라면 플랫폼과 상관없이 서로 전송할 수 있습니다. Windows·macOS·Linux·Android·iOS가 모두 상호 운용됩니다. 같은 Wi-Fi에서는 두 기기가 relayium.com을 열면 자동으로 서로를 발견하고, 다른 네트워크에서는 대신 짧은 페어링 코드로 연결합니다.",
        "전송 자체는 가능한 경우 WebRTC로 P2P 직접 이루어지며, 그 위에 독립적인 두 번째 암호화 계층을 얹습니다. X25519 키 교환으로 도출한 키를 블록별 AES-256-GCM에 사용하고, 이 키는 어떤 서버에도 도달하지 않습니다. 두 기기가 동일한 6자리 검증 코드(짧은 인증 문자열, SAS)를 표시하므로 사이에 아무도 없음을 확인할 수 있고, 각 파일은 SHA-256 해시로 종단간 검증됩니다. 한 배치에 최대 1,000개 파일을 보낼 수 있습니다. 같은 네트워크에서는 계정이 필요 없고, 페어링 코드로 네트워크를 넘어 보낼 때는 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 어느 경우든 계정이 필요 없습니다. 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다.",
      ],
    },
    {
      heading: "iPhone과 iPad에서의 솔직한 한계",
      body: [
        "이 부분은 솔직히 말해야 합니다. 모바일 브라우저에서 큰 파일을 받는 것은 네이티브 AirDrop만큼 매끄럽지 않습니다. Safari와 Firefox는 들어오는 파일을 메모리에 버퍼링하므로, iPhone이나 iPad에서는 브라우저가 담을 수 있는 범위에 머물도록 전송을 약 200 MB 이내로 유지하는 것이 안전합니다.",
        "데스크톱에서는 사정이 낫습니다. Chrome과 Edge는 디스크로 직접 스트리밍할 수 있어 크기 상한이 완전히 사라지므로, 큰 파일도 메모리를 채우지 않고 흐릅니다. 직접 연결이 불가능할 때는 암호화된 스트림이 TURN 릴레이로 폴백하지만, 릴레이는 암호문만 보므로 종단간 암호화를 유지합니다. 선택적인 저장형 다운로드 링크 모드도 있습니다 — 브라우저가 AES-256-GCM으로 파일을 암호화하고 키는 URL 프래그먼트에만 존재하므로, 서버는 읽을 수 없는 영지식 암호문을 저장합니다. 이런 링크 생성에는 보내는 쪽의 로그인이 필요하고, 실시간 전송에는 필요 없습니다.",
      ],
    },
    {
      heading: "AirDrop vs Relayium 한눈에 비교",
      body: [
        "가장 중요한 차이를 나란히 정리하면:",
      ],
      bullets: [
        "플랫폼: AirDrop은 Apple 전용; Relayium은 브라우저에서 Windows·macOS·Linux·Android·iOS를 넘나든다.",
        "설치: AirDrop은 Apple 시스템에 내장; Relayium은 앱도 설치도 필요 없고 웹 페이지만 있으면 된다.",
        "네트워크 넘기: AirDrop은 근접만; Relayium은 같은 Wi-Fi에서도, 페어링 코드로 네트워크를 넘어서도 연결된다.",
        "암호화: 둘 다 암호화됨; Relayium은 그 위에 X25519 + AES-256-GCM을 더하고, 직접 대조하는 6자리 코드와 파일별 SHA-256 검사를 갖춘다.",
        "모바일의 큰 파일: AirDrop이 더 매끄럽다; Relayium은 iOS 브라우저 전송을 약 200 MB 이내로 유지하길 권하고, 데스크톱 Chrome/Edge에는 크기 상한이 없다.",
        "계정: AirDrop은 언제나 필요 없다; Relayium은 같은 네트워크에서는 필요 없지만, 네트워크를 넘는 페어링이나 저장형 다운로드 링크를 만들 때는 보내는 쪽의 로그인이 필요하다 — 받는 쪽은 어느 경우든 계정이 필요 없다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Windows용 AirDrop이 있나요?",
        a: "없습니다 — AirDrop은 Apple 기기 전용이며 Windows 클라이언트가 없습니다. Relayium이 그 크로스플랫폼 대안입니다. 어떤 브라우저에서도 동작하므로 Windows PC가 iPhone이나 Mac과 주고받는 일이 두 Apple 기기 사이만큼 손쉽습니다.",
      },
      {
        q: "iPhone에서 Windows PC로 파일을 보내려면?",
        a: "두 기기의 브라우저에서 relayium.com을 엽니다. 같은 Wi-Fi라면 자동으로 서로를 발견하고, 아니면 한 기기에 표시된 페어링 코드를 다른 기기에 입력합니다(이때 보내는 쪽의 로그인이 필요합니다). 최대 1,000개 파일을 고르고 두 화면의 6자리 검증 코드가 일치하는지 확인하면, 전송이 두 기기 사이에서 직접 이루어집니다.",
      },
      {
        q: "앱을 설치해야 하나요?",
        a: "아니요. Relayium은 웹 페이지입니다 — 어떤 OS에서도, 어느 기기에도 설치할 것이 없습니다. MIT 라이선스의 무료 오픈소스이며 코드는 github.com/relayium/relayium에 공개되어 있어 감사하거나 자체 인스턴스를 운영할 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "Apple과 그 밖의 모든 것 사이에서 전송하세요 — 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. AirDrop: eine plattformübergreifende Alternative",
  description:
    "Ein ehrlicher Blick auf AirDrop und Relayium. AirDrop ist im Apple-Ökosystem hervorragend; Relayium läuft in jedem Browser, sodass ein Windows-, Android- oder Linux-Gerät an ein iPhone oder Mac senden kann — und zurück.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "AirDrop ist eine der besten Datei-Sharing-Erfahrungen, die je ausgeliefert wurden. Zwischen iPhone, iPad und Mac ist es schnell, privat und mühelos ins System integriert — Relayium tut nicht so, als würde es das auf Apples Heimterrain schlagen.",
    "Der Haken ist die Grenze: AirDrop spricht nur mit anderen Apple-Geräten. Dieser Artikel vergleicht beide fair, erklärt, wo AirDrop wirklich besser ist, und zeigt, wo Relayium hilft — beim Senden zwischen einem iPhone und einem Windows-PC, einem Android-Handy und einem Mac oder einem Linux-Laptop und einem iPad, direkt aus dem Browser.",
  ],
  sections: [
    {
      heading: "Was AirDrop richtig macht",
      body: [
        "AirDrop nutzt Apple Wireless Direct Link (AWDL), um zwischen zwei nahen Geräten eine Peer-to-Peer-WLAN-Verbindung aufzubauen, während Bluetooth die Erkennung übernimmt. Das Ergebnis ist schnell, direkt und funktioniert selbst dann, wenn keines der Geräte in einem Netzwerk ist — kein Router, kein Internet, kein Konto.",
        "Es ist außerdem tief integriert: Das Teilen-Menü ist in jeder App einen Tipp entfernt, Übertragungen sind verschlüsselt, und empfangene Dateien landen automatisch am richtigen Ort. Um Fotos oder Dokumente in einem reinen Apple-Haushalt zu bewegen, ist es kaum zu schlagen.",
      ],
    },
    {
      heading: "Der Haken: AirDrop bleibt in Apples Welt",
      body: [
        "AirDrop existiert für Windows, Android oder Linux schlicht nicht. Es gibt keinen offiziellen Client und keine Interoperabilität, also ist AirDrop in dem Moment, in dem eine Seite der Übertragung kein Apple-Gerät ist, überhaupt keine Option.",
        "Genau diese Lücke trifft die meisten: ein iPhone-Foto, das zu einem Windows-PC muss, ein Android-Video, das zu einem Mac geht, oder Dateien, die zwischen einer Linux-Workstation und einem iPad wandern. Die üblichen Umwege — ein Kabel, eine E-Mail an sich selbst oder ein Cloud-Upload und erneuter Download — sind langsamer und leiten deine Dateien über den Server eines anderen.",
      ],
    },
    {
      heading: "Wie Relayium die Lücke schließt",
      body: [
        "Relayium läuft vollständig in einem modernen Webbrowser, ohne Installation, sodass zwei beliebige Geräte, die eine Webseite öffnen können, unabhängig von der Plattform miteinander übertragen: Windows, macOS, Linux, Android und iOS arbeiten alle zusammen. Im selben WLAN öffnen beide Geräte relayium.com und erkennen einander automatisch; in verschiedenen Netzwerken verbindest du dich stattdessen mit einem kurzen Pairing-Code.",
        "Die Übertragung selbst läuft nach Möglichkeit direkt Peer-to-Peer über WebRTC, mit einer zweiten, unabhängigen Verschlüsselungsschicht darüber: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, und dieser Schlüssel erreicht nie einen Server. Beide Geräte zeigen denselben sechsstelligen Prüfcode (einen Short Authentication String, SAS), sodass du bestätigen kannst, dass niemand dazwischensitzt, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft. Du kannst bis zu 1.000 Dateien pro Stapel senden. Im selben Netz ist kein Konto nötig; beim Senden über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden — der Empfänger braucht in beiden Fällen kein Konto. Bricht die Verbindung ab, kann die Übertragung fortgesetzt statt neu gestartet werden.",
      ],
    },
    {
      heading: "Ehrliche Grenzen auf iPhone und iPad",
      body: [
        "Das ist der Punkt, den man offen ansprechen sollte: Große Dateien in einem mobilen Browser zu empfangen, ist nicht so geschmeidig wie natives AirDrop. Safari und Firefox puffern die eingehende Datei im Arbeitsspeicher, daher hältst du Übertragungen auf einem iPhone oder iPad am besten unter etwa 200 MB, um bequem in dem zu bleiben, was der Browser fassen kann.",
        "Auf dem Desktop sieht es besser aus: Chrome und Edge können direkt auf die Festplatte streamen, was die Größenbegrenzung ganz aufhebt, sodass große Dateien fließen, ohne den Speicher zu füllen. Ist eine Direktverbindung unmöglich, weicht der verschlüsselte Datenstrom auf ein TURN-Relay aus, das nur Chiffretext sieht, sodass es Ende-zu-Ende-verschlüsselt bleibt. Es gibt außerdem einen optionalen Modus mit gespeichertem Download-Link — der Browser verschlüsselt die Dateien mit AES-256-GCM, und der Schlüssel liegt nur im URL-Fragment, sodass der Server Zero-Knowledge-Chiffretext hält, den er nicht lesen kann; das Erstellen eines solchen Links erfordert die Anmeldung des Absenders, Echtzeitübertragungen nicht.",
      ],
    },
    {
      heading: "AirDrop vs. Relayium auf einen Blick",
      body: [
        "Die wichtigsten Unterschiede nebeneinander:",
      ],
      bullets: [
        "Plattformen: AirDrop ist nur für Apple; Relayium funktioniert im Browser über Windows, macOS, Linux, Android und iOS hinweg.",
        "Installation: AirDrop ist in Apples System eingebaut; Relayium braucht keine App und keine Installation, nur eine Webseite.",
        "Netzwerkübergreifend: AirDrop nur in der Nähe; Relayium verbindet im selben WLAN oder über Netzwerke hinweg per Pairing-Code.",
        "Verschlüsselung: beide sind verschlüsselt; Relayium legt X25519 + AES-256-GCM darüber, mit einem sechsstelligen Code, den du prüfst, und SHA-256-Prüfungen je Datei.",
        "Große Dateien mobil: AirDrop ist geschmeidiger; Relayium empfiehlt, Browser-Übertragungen auf iOS unter etwa 200 MB zu halten, während Chrome/Edge auf dem Desktop keine Größenbegrenzung haben.",
        "Konto: AirDrop braucht nie eines; Relayium braucht im selben Netz keines, verlangt aber die Anmeldung des Absenders für Pairing über Netzwerke hinweg oder zum Erstellen eines gespeicherten Download-Links — der Empfänger braucht nie ein Konto.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Gibt es ein AirDrop für Windows?",
        a: "Nein — AirDrop ist Apple-Geräten vorbehalten und hat keinen Windows-Client. Relayium ist die plattformübergreifende Alternative: Es läuft in jedem Browser, sodass ein Windows-PC genauso leicht an ein iPhone oder Mac sendet und von ihm empfängt wie zwischen zwei Apple-Geräten.",
      },
      {
        q: "Wie sende ich eine Datei von einem iPhone an einen Windows-PC?",
        a: "Öffne relayium.com in einem Browser auf beiden Geräten. Im selben WLAN erkennen sie einander automatisch; sonst gibst du den auf einem Gerät angezeigten Pairing-Code im anderen ein — dafür muss sich der Absender anmelden. Wähle bis zu 1.000 Dateien, prüfe, ob der sechsstellige Code auf beiden Bildschirmen übereinstimmt, und die Übertragung läuft direkt zwischen ihnen.",
      },
      {
        q: "Muss ich eine App installieren?",
        a: "Nein. Relayium ist eine Webseite — auf keinem Gerät und keinem Betriebssystem ist etwas zu installieren. Es ist kostenlos und quelloffen unter der MIT-Lizenz auf github.com/relayium/relayium, sodass du es prüfen oder eine eigene Instanz betreiben kannst.",
      },
    ],
  },
  cta: {
    text: "Übertrage zwischen Apple und allem anderen — keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs AirDrop : une alternative multiplateforme",
  description:
    "Un regard honnête sur AirDrop et Relayium. AirDrop est excellent dans l'écosystème Apple ; Relayium tourne dans n'importe quel navigateur, pour qu'un appareil Windows, Android ou Linux envoie vers un iPhone ou un Mac, et inversement.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "AirDrop est l'une des meilleures expériences de partage de fichiers jamais livrées. Entre un iPhone, un iPad et un Mac, c'est rapide, privé et intégré au système sans effort — Relayium ne prétend pas le battre sur le terrain d'Apple.",
    "Le hic, c'est la frontière : AirDrop ne parle qu'à d'autres appareils Apple. Cet article compare les deux équitablement, explique où AirDrop est réellement meilleur, et montre où Relayium aide — pour envoyer entre un iPhone et un PC Windows, un téléphone Android et un Mac, ou un portable Linux et un iPad, directement depuis le navigateur.",
  ],
  sections: [
    {
      heading: "Ce qu'AirDrop réussit",
      body: [
        "AirDrop utilise Apple Wireless Direct Link (AWDL) pour établir une connexion Wi-Fi pair-à-pair entre deux appareils proches, le Bluetooth gérant la découverte. Le résultat est rapide, direct, et fonctionne même quand aucun des appareils n'est sur un réseau — pas de routeur, pas d'internet, pas de compte.",
        "Il est aussi profondément intégré : la feuille de partage est à une touche dans chaque app, les transferts sont chiffrés, et les fichiers reçus atterrissent automatiquement au bon endroit. Pour déplacer des photos ou des documents dans un foyer tout-Apple, difficile de faire mieux.",
      ],
    },
    {
      heading: "Le hic : AirDrop reste dans le monde d'Apple",
      body: [
        "AirDrop n'existe tout simplement pas pour Windows, Android ou Linux. Il n'y a ni client officiel ni interopérabilité, donc dès qu'un côté du transfert n'est pas un appareil Apple, AirDrop n'est pas une option du tout.",
        "C'est précisément le manque que rencontrent la plupart des gens : une photo d'iPhone qui doit rejoindre un PC Windows, une vidéo Android qui va vers un Mac, ou des fichiers qui circulent entre un poste Linux et un iPad. Les contournements habituels — un câble, un e-mail à soi-même, ou un envoi vers le cloud puis un nouveau téléchargement — sont plus lents et font transiter vos fichiers par le serveur de quelqu'un d'autre.",
      ],
    },
    {
      heading: "Comment Relayium comble le manque",
      body: [
        "Relayium fonctionne entièrement dans un navigateur moderne, sans rien à installer, si bien que deux appareils capables d'ouvrir une page web peuvent se transférer des fichiers quelle que soit la plateforme : Windows, macOS, Linux, Android et iOS s'entendent tous. Sur le même Wi-Fi, les deux appareils ouvrent relayium.com et se découvrent automatiquement ; sur des réseaux différents, vous vous connectez plutôt avec un court code d'appairage.",
        "Le transfert lui-même se fait directement en pair-à-pair via WebRTC chaque fois que possible, avec une seconde couche de chiffrement indépendante par-dessus : un échange de clés X25519 dérive une clé utilisée pour un AES-256-GCM par bloc, et cette clé n'atteint jamais aucun serveur. Les deux appareils affichent le même code de vérification à 6 chiffres (une chaîne d'authentification courte, SAS), ce qui vous permet de confirmer que personne ne s'intercale, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256. Vous pouvez envoyer jusqu'à 1 000 fichiers par lot. Sur le même réseau, aucun compte n'est nécessaire ; envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte. Si la connexion tombe, le transfert peut reprendre au lieu de recommencer.",
      ],
    },
    {
      heading: "Limites honnêtes sur iPhone et iPad",
      body: [
        "C'est le point à annoncer franchement : recevoir de gros fichiers dans un navigateur mobile n'est pas aussi fluide qu'AirDrop natif. Safari et Firefox mettent le fichier entrant en mémoire tampon, donc sur un iPhone ou un iPad, mieux vaut garder les transferts sous environ 200 Mo pour rester confortablement dans ce que le navigateur peut contenir.",
        "Sur ordinateur, c'est mieux : Chrome et Edge peuvent écrire directement sur le disque, ce qui supprime entièrement la limite de taille, si bien que les gros fichiers passent sans saturer la mémoire. Quand une connexion directe est impossible, le flux chiffré bascule vers un relais TURN qui ne voit que du texte chiffré, donc il reste chiffré de bout en bout. Il existe aussi un mode optionnel de lien de téléchargement stocké — le navigateur chiffre les fichiers en AES-256-GCM et la clé ne vit que dans le fragment de l'URL, si bien que le serveur ne détient qu'un texte chiffré à divulgation nulle qu'il ne peut pas lire ; créer un tel lien exige que l'expéditeur se connecte, pas les transferts en temps réel.",
      ],
    },
    {
      heading: "AirDrop vs Relayium en un coup d'œil",
      body: [
        "Les différences qui comptent le plus, côte à côte :",
      ],
      bullets: [
        "Plateformes : AirDrop est réservé à Apple ; Relayium fonctionne dans le navigateur entre Windows, macOS, Linux, Android et iOS.",
        "Installation : AirDrop est intégré au système d'Apple ; Relayium ne demande ni app ni installation, juste une page web.",
        "Entre réseaux : AirDrop est de proximité uniquement ; Relayium se connecte sur le même Wi-Fi ou entre réseaux avec un code d'appairage.",
        "Chiffrement : les deux sont chiffrés ; Relayium ajoute X25519 + AES-256-GCM par-dessus, avec un code à 6 chiffres que vous vérifiez et des contrôles SHA-256 par fichier.",
        "Gros fichiers sur mobile : AirDrop est plus fluide ; Relayium conseille de garder les transferts navigateur sous environ 200 Mo sur iOS, alors que Chrome/Edge sur ordinateur n'ont aucune limite de taille.",
        "Compte : AirDrop n'en a jamais besoin ; Relayium n'en demande pas sur le même réseau, mais l'expéditeur doit se connecter pour s'appairer entre réseaux différents ou pour créer un lien de téléchargement stocké — le destinataire n'a jamais besoin de compte.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Existe-t-il un AirDrop pour Windows ?",
        a: "Non — AirDrop est exclusif aux appareils Apple et n'a pas de client Windows. Relayium est l'alternative multiplateforme : il tourne dans n'importe quel navigateur, si bien qu'un PC Windows envoie vers un iPhone ou un Mac et reçoit d'eux aussi facilement qu'entre deux appareils Apple.",
      },
      {
        q: "Comment envoyer un fichier d'un iPhone vers un PC Windows ?",
        a: "Ouvrez relayium.com dans un navigateur sur les deux appareils. Sur le même Wi-Fi, ils se découvrent automatiquement ; sinon, saisissez le code d'appairage affiché sur un appareil dans l'autre — cela exige que l'expéditeur se connecte. Choisissez jusqu'à 1 000 fichiers, vérifiez que le code à 6 chiffres correspond sur les deux écrans, et le transfert s'effectue directement entre eux.",
      },
      {
        q: "Dois-je installer une application ?",
        a: "Non. Relayium est une page web — il n'y a rien à installer sur aucun appareil, quel que soit le système d'exploitation. C'est gratuit et open source sous licence MIT sur github.com/relayium/relayium, vous pouvez donc l'auditer ou faire tourner votre propre instance.",
      },
    ],
  },
  cta: {
    text: "Transférez entre Apple et tout le reste — sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "compare/airdrop",
  updated: "2026-07-03",
  langs: { en, zh, ja, ko, de, fr },
};
