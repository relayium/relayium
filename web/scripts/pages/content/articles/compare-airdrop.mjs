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
        "On the same network the transfer runs directly between the two devices over WebRTC. The cross-network path is deliberately different: a pairing-code room forces relay-only ICE, so the stream travels through a TURN relay and the connection comes up in a second or two instead of spending some 20 seconds on direct-candidate checks that almost never succeed between two home networks. Either way a second, independent encryption layer sits on top: an X25519 key exchange derives a key used for per-chunk AES-256-GCM, and that key never reaches any server — so the relay only ever moves ciphertext it cannot read. With advanced verification on — it is off by default — both devices show the same 6-digit verification code (a Short Authentication String). Comparing it out of band confirms that the X25519 endpoint public keys were not replaced, detecting if the signaling service or a TURN relay impersonated either endpoint. It does not prove that TURN is absent from the network path: cross-network TURN remains in the data path but carries only ciphertext. Each file is also checked end-to-end with a SHA-256 hash. You can send up to 1,000 files per batch; on the same network no account is needed, and creating a pairing code to send across networks requires signing in — the person you send to never needs an account. If the connection drops, the transfer can resume instead of restarting.",
      ],
    },
    {
      heading: "Honest limits on iPhone and iPad",
      body: [
        "This is the part to be upfront about: receiving very large files in a mobile browser is not as smooth as native AirDrop. When no streaming path applies — typically several files arriving at once in a browser without the File System Access API, which means Firefox, Safari and everything on mobile, since every iOS browser is WebKit — the incoming data is held in memory instead. Relayium warns before starting a download it estimates will need more than roughly 256 MB of memory. That number is a deliberately conservative estimate rather than a measured hard limit: a roomy desktop may sail well past it, while a phone juggling other tabs can struggle sooner.",
        "There is more streaming available than that suggests. Chrome and Edge use the File System Access API: a single file goes through a Save As dialog straight to disk, and a whole batch streams into a folder you pick — no size ceiling, no memory pressure. Even without that API a single file can stream to disk through the service-worker download path, so Firefox and Safari are not stuck buffering across the board. That path is what the optional stored download-link mode uses — your browser encrypts the files with AES-256-GCM and the key lives only in the URL fragment, so the server holds zero-knowledge ciphertext it cannot read; creating such a link requires the sender to sign in, while a realtime transfer on the same network does not.",
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
        "Across networks: AirDrop is nearby-only; Relayium connects directly on the same Wi-Fi, or across networks with a pairing code over an encrypted relay.",
        "Encryption: both are encrypted; Relayium adds X25519 + AES-256-GCM with a 6-digit code you verify and per-file SHA-256 checks.",
        "Large files on mobile: AirDrop is smoother; Relayium warns above roughly 256 MB when the browser has to buffer in memory, while Chrome and Edge stream straight to disk with no such ceiling.",
        "Account: AirDrop never needs one; Relayium needs no account on the same network, but signing in is required to create a pairing code for a cross-network transfer or a stored download link — the person receiving never needs an account.",
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
        a: "Open relayium.com in a browser on both devices. On the same Wi-Fi they discover each other automatically; otherwise enter the pairing code shown on one device into the other, which requires whoever creates that code to sign in. Pick up to 1,000 files — and if advanced verification is on, confirm the 6-digit verification code matches on both screens — and the transfer runs between them end-to-end encrypted — directly on the same Wi-Fi, or over a relay that only ever sees ciphertext once you have paired across networks.",
      },
      {
        q: "Do I need to install an app?",
        a: "No. Relayium is a web page — there is nothing to install on either device, on any operating system. It is free and open source under the AGPL-3.0 license at github.com/relayium/relayium, so you can audit it or run your own instance.",
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
        "在同一网络下，传输在两台设备之间通过 WebRTC 直连完成。跨网络那条路则是刻意不同的：配对码房间会把 ICE 强制为 relay-only，数据流经由 TURN 中继传递，因此连接一两秒就能建立，而不必花上大约 20 秒去做那些在两个家庭网络之间几乎不可能成功的直连候选探测。无论走哪条路，上面都叠着第二层独立加密：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密，这把密钥从不发送给任何服务器——所以中继搬运的始终只是它读不懂的密文。打开「高级验证」（默认关闭）后，两台设备会显示同一段 6 位校验码（SAS）。通过带外方式核对一致，可确认 X25519 端点公钥未被替换，并检测信令服务或 TURN 中继是否冒充任一端点。这并不证明 TURN 不在网络路径中：跨网络传输时 TURN 仍在数据路径中，但只承载密文。每个文件还会用 SHA-256 做端到端完整性校验。每批最多可发送 1,000 个文件；同一网络下无需账号，而创建配对码以跨网络发送则需要登录——收件的一方始终无需账号。若连接中断，传输还能断点续传而不必从头再来。",
      ],
    },
    {
      heading: "iPhone 和 iPad 上确实存在的短板",
      body: [
        "这一点得坦诚说明：在移动端浏览器里接收很大的文件，不如原生 AirDrop 那样顺滑。当所有流式写盘路径都不适用时——典型情况是在没有 File System Access API 的浏览器里一次收下多个文件，也就是 Firefox、Safari 以及所有手机浏览器（iOS 上全是 WebKit）——收到的数据只能先攒在内存里。Relayium 会在预估内存峰值超过约 256 MB 时先给出提示。这个数字是刻意取的保守估计，而不是实测出来的硬上限：内存宽裕的桌面机可能远远超过它也没事，而同时开着一堆标签页的手机可能更早就撑不住。",
        "可用的流式写盘其实比这句话听起来多。Chrome 与 Edge 走 File System Access API：单个文件通过「另存为」对话框直接写入磁盘，整批文件则流式写入你选定的文件夹——没有大小上限，也不占内存。即便没有这套 API，单个文件仍可通过 service worker 的下载通道流式落盘，所以「Firefox 和 Safari 只能攒内存」并不是放之四海皆准的说法。可选的存储下载链接模式走的正是这条通道——浏览器先用 AES-256-GCM 加密文件，密钥只存在于 URL 片段里，服务器只保存无法解读的零知识密文；生成这样的链接需要发送方登录，而同一网络下的实时传输则不需要。",
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
        "跨网络：AirDrop 只能就近；Relayium 在同一 Wi-Fi 下直连，用配对码跨网络时则经由加密中继连接。",
        "加密：两者都加密；Relayium 额外叠加 X25519 + AES-256-GCM，配以你亲自核对的 6 位校验码和逐文件 SHA-256 校验。",
        "移动端大文件：AirDrop 更顺滑；Relayium 在浏览器只能攒内存时，会在超过约 256 MB 时给出提示，而 Chrome 与 Edge 直接流式写盘，没有这道门槛。",
        "账号：AirDrop 从不需要账号；Relayium 在同一网络下无需账号，但要创建跨网络配对码或生成存储下载链接就需要登录——收件的一方始终无需账号。",
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
        a: "在两台设备的浏览器里都打开 relayium.com。同一 Wi-Fi 下它们会自动相互发现；否则把一台设备上显示的配对码输入到另一台，这需要创建配对码的一方先登录。选好最多 1,000 个文件（若打开了高级验证，再核对两块屏幕上的 6 位校验码一致），传输就会在两者之间端到端加密地进行——同一 Wi-Fi 下是直连，跨网络配对时则经由只能看到密文的中继。",
      },
      {
        q: "需要安装 App 吗？",
        a: "不需要。Relayium 就是一个网页——在任何操作系统上、任何一台设备上都无需安装。它采用 AGPL-3.0 许可，免费且开源，代码公开在 github.com/relayium/relayium，你可以审计它或自建实例。",
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
    "AirDrop はこれまでで最も優れたファイル共有体験の一つです。iPhone・iPad・Mac の間では速く、プライベートで、システムに自然に組み込まれています。Relayium は Apple のホームグラウンドでそれに勝とうとはしません。",
    "問題は境界です。AirDrop は他の Apple 端末としか通信しません。本記事は両者を公平に比較し、AirDrop が本当に優れている点を説明し、Relayium が役立つ場面を示します。iPhone と Windows PC、Android スマホと Mac、あるいは Linux ノートと iPad の間の転送を、ブラウザから直接行えます。",
  ],
  sections: [
    {
      heading: "AirDrop の優れている点",
      body: [
        "AirDrop は Apple Wireless Direct Link（AWDL）を使い、近くの2台の端末間に P2P の Wi-Fi 直接接続を張り、発見は Bluetooth が担います。結果として速く、直接的で、どちらの端末もネットワークに接続していなくても動きます。ルーターも、インターネットも、アカウントも不要です。",
        "深く統合されてもいます。共有シートはどのアプリでもワンタップで、転送は暗号化され、受け取ったファイルは自動的に適切な場所に収まります。すべて Apple の家庭で写真や書類を動かすなら、まず敵いません。",
      ],
    },
    {
      heading: "問題点：AirDrop は Apple の世界の中に留まる",
      body: [
        "AirDrop は Windows・Android・Linux には存在しません。公式クライアントも相互運用性もないため、転送の片方が Apple 端末でない瞬間に、AirDrop はそもそも選択肢になりません。",
        "そしてこれこそ多くの人がぶつかる空白です。iPhone の写真を Windows PC へ、Android の動画を Mac へ、あるいはファイルを Linux ワークステーションと iPad の間で行き来させる。よくある回避策（ケーブル、自分宛てのメール、クラウドへのアップロードと再ダウンロード）はどれも遅く、ファイルを誰かのサーバー経由にしてしまいます。",
      ],
    },
    {
      heading: "Relayium がその空白を埋める方法",
      body: [
        "Relayium は最新のブラウザだけで完全に動作し、インストールは不要です。ですからウェブページを開ける2台の端末なら、プラットフォームを問わず相互に転送できます。Windows・macOS・Linux・Android・iOS がすべて相互運用します。同じ Wi-Fi では両方が relayium.com を開けば自動的に相手を発見し、異なるネットワークでは代わりに短いペアリングコードで接続します。",
        "同じネットワークでは、転送は2台の端末の間を WebRTC で直接つないで行われます。ネットワークをまたぐ経路はあえて別物です。ペアリングコードのルームでは ICE を relay 限定にするため、ストリームは TURN リレーを通り、家庭のネットワーク同士ではまず成功しない直接候補チェックに約20秒を費やす代わりに、1〜2秒で接続が確立します。どちらの経路でも、その上に独立した2つ目の暗号化層が重なります。X25519 の鍵交換で導出した鍵をチャンクごとの AES-256-GCM に使い、その鍵はどのサーバーにも届きません。ですからリレーが運ぶのは、それ自身には読めない暗号文だけです。「高度な検証」（既定はオフ）をオンにすると、両方の端末に同じ6桁の検証コード（ショート認証文字列、SAS）が表示されます。別の通信手段で照合すると、X25519 の端末公開鍵が置き換えられていないことを確認でき、シグナリングサービスや TURN リレーによる端末のなりすましを検出できます。ただし、TURN がネットワーク経路に存在しないことを証明するものではありません。ネットワークをまたぐ場合、TURN は引き続きデータ経路上にあり、運ぶのは暗号文だけです。各ファイルは SHA-256 ハッシュでもエンドツーエンドに検証されます。1バッチで最大1,000ファイルを送れます。同じネットワークならアカウントは不要で、ネットワークをまたいで送るためのペアリングコードの作成にはサインインが必要です。送る相手はどちらの場合もアカウント不要です。接続が切れても最初からではなく再開できます。",
      ],
    },
    {
      heading: "iPhone・iPad での正直な限界",
      body: [
        "ここは率直に言うべき点です。モバイルブラウザで非常に大きなファイルを受け取るのは、ネイティブの AirDrop ほど滑らかではありません。ストリーミングで書き出せる経路がどれも使えないとき、受信データはメモリに保持されます。典型的には、File System Access API のないブラウザ、つまり Firefox・Safari・モバイルのすべて（iOS のブラウザはすべて WebKit です）で複数ファイルを一度に受け取る場合です。Relayium は、必要なメモリが約 256 MB を超えると見積もったダウンロードの前に警告します。この数字は実測された上限ではなく、意図的に保守的な見積もりです。メモリに余裕のあるデスクトップならはるかに超えても平気なことがあり、他のタブを抱えたスマホならもっと早く苦しくなることもあります。",
        "実際に使えるストリーミングは、この話から受ける印象より多くあります。Chrome と Edge は File System Access API を使い、単一ファイルは「名前を付けて保存」ダイアログからそのままディスクへ、複数ファイルは選んだフォルダへストリーミングされます。サイズ上限もメモリ圧迫もありません。この API がなくても、単一ファイルなら service worker のダウンロード経路でディスクへストリーミングできるので、「Firefox と Safari は必ずメモリに溜める」は一律には当てはまりません。任意の保存型ダウンロードリンクはまさにこの経路を使います。ブラウザが AES-256-GCM でファイルを暗号化し、鍵は URL フラグメントにだけ存在するため、サーバーは読めないゼロ知識の暗号文を保存します。こうしたリンクの作成には送信側のサインインが必要で、同じネットワークでのリアルタイム転送には不要です。",
      ],
    },
    {
      heading: "AirDrop と Relayium の一覧比較",
      body: [
        "最も重要な違いを並べて示します。",
      ],
      bullets: [
        "プラットフォーム：AirDrop は Apple 専用です。Relayium はブラウザで Windows・macOS・Linux・Android・iOS をまたぎます。",
        "インストール：AirDrop は Apple のシステムに内蔵されています。Relayium はアプリもインストールも不要で、ウェブページだけで動きます。",
        "ネットワーク越え：AirDrop は近接のみです。Relayium は同じ Wi-Fi なら直接接続し、ペアリングコードでネットワークをまたぐ場合は暗号化されたリレー経由で接続します。",
        "暗号化：どちらも暗号化されます。Relayium はさらに X25519 + AES-256-GCM を重ね、照合できる6桁コードとファイルごとの SHA-256 チェックを備えます。",
        "モバイルの大きなファイル：AirDrop の方が滑らかです。Relayium はブラウザがメモリに溜めるしかない場合、約 256 MB を超えると警告します。Chrome と Edge はディスクへ直接ストリーミングするため、その線引きは不要です。",
        "アカウント：AirDrop は常に不要です。Relayium は同じネットワークなら不要ですが、ネットワークをまたぐためのペアリングコードや保存型ダウンロードリンクの作成にはサインインが要ります。受け取る側はどちらの場合もアカウント不要です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Windows 版の AirDrop はありますか？",
        a: "ありません。AirDrop は Apple 端末専用で、Windows クライアントはありません。Relayium がそのクロスプラットフォームな代替です。どのブラウザでも動くので、Windows PC と iPhone や Mac のやり取りが、2台の Apple 端末どうしと同じくらい手軽にできます。",
      },
      {
        q: "iPhone から Windows PC へファイルを送るには？",
        a: "両方の端末のブラウザで relayium.com を開きます。同じ Wi-Fi なら自動的に相手を発見し、そうでなければ一方に表示されたペアリングコードをもう一方に入力します（コードを作る側のサインインが必要です）。最大1,000ファイルを選びます（高度な検証がオンなら、両画面の6桁の検証コードが一致するのも確認します）。すると転送はエンドツーエンド暗号化されたまま両者の間で行われます。同じ Wi-Fi なら直接、ネットワークをまたぐペアリングなら暗号文しか見えないリレー経由です。",
      },
      {
        q: "アプリのインストールは必要ですか？",
        a: "いいえ。Relayium はウェブページです。どの OS でも、どちらの端末にもインストールするものはありません。AGPL-3.0 ライセンスの無料オープンソースで、コードは github.com/relayium/relayium に公開されており、監査も自分のインスタンス運用も可能です。",
      },
    ],
  },
  cta: {
    text: "Apple とそれ以外のすべての間で転送。インストール不要、同じネットワークならアカウントも不要です。",
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
        "같은 네트워크에서는 전송이 두 기기 사이에서 WebRTC로 직접 이루어집니다. 네트워크를 넘는 경로는 일부러 다릅니다. 페어링 코드 방은 ICE를 릴레이 전용으로 고정하므로 스트림이 TURN 릴레이를 지나가며, 가정용 네트워크 사이에서는 거의 성공하지 못하는 직접 후보 검사에 약 20초를 쓰는 대신 1~2초 만에 연결이 올라옵니다. 어느 경로든 그 위에 독립적인 두 번째 암호화 계층이 얹힙니다. X25519 키 교환으로 도출한 키를 블록별 AES-256-GCM에 사용하고, 이 키는 어떤 서버에도 도달하지 않습니다 — 그래서 릴레이가 나르는 것은 스스로 읽을 수 없는 암호문뿐입니다. 고급 검증(기본값 꺼짐)을 켜면 두 기기에 동일한 6자리 검증 코드(짧은 인증 문자열, SAS)가 표시됩니다. 별도 채널로 코드를 비교하면 X25519 엔드포인트 공개 키가 바뀌지 않았음을 확인하고, 시그널링 서비스나 TURN 릴레이가 어느 한쪽 엔드포인트를 사칭했는지 탐지할 수 있습니다. 이는 TURN이 네트워크 경로에 없음을 증명하지 않습니다. 네트워크를 넘을 때 TURN은 여전히 데이터 경로에 있지만 암호문만 운반합니다. 각 파일은 SHA-256 해시로도 종단간 검증됩니다. 한 배치에 최대 1,000개 파일을 보낼 수 있습니다. 같은 네트워크에서는 계정이 필요 없고, 네트워크를 넘어 보내기 위한 페어링 코드를 만들 때는 로그인이 필요합니다 — 받는 쪽은 어느 경우든 계정이 필요 없습니다. 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다.",
      ],
    },
    {
      heading: "iPhone과 iPad에서의 솔직한 한계",
      body: [
        "이 부분은 솔직히 말해야 합니다. 모바일 브라우저에서 아주 큰 파일을 받는 것은 네이티브 AirDrop만큼 매끄럽지 않습니다. 디스크로 흘려보낼 경로가 하나도 적용되지 않을 때 — 대표적으로 File System Access API가 없는 브라우저, 즉 Firefox·Safari와 모든 모바일 브라우저(iOS는 전부 WebKit입니다)에서 여러 파일을 한꺼번에 받을 때 — 들어오는 데이터는 메모리에 담깁니다. Relayium은 필요한 메모리가 약 256 MB를 넘을 것으로 추정되는 다운로드 전에 미리 경고합니다. 이 숫자는 측정된 하드 한계가 아니라 일부러 보수적으로 잡은 추정치입니다. 메모리가 넉넉한 데스크톱은 그보다 훨씬 넘겨도 멀쩡할 수 있고, 다른 탭을 잔뜩 띄운 폰은 더 일찍 버거워질 수 있습니다.",
        "실제로 쓸 수 있는 스트리밍은 그 말보다 많습니다. Chrome과 Edge는 File System Access API를 씁니다. 단일 파일은 다른 이름으로 저장 대화상자를 거쳐 곧바로 디스크에 쓰이고, 여러 파일은 고른 폴더로 스트리밍됩니다 — 크기 상한도, 메모리 압박도 없습니다. 그 API가 없어도 단일 파일은 서비스 워커 다운로드 경로로 디스크에 스트리밍할 수 있으므로 ‘Firefox와 Safari는 무조건 메모리에 담는다’는 말은 전부에 들어맞지 않습니다. 선택적인 저장형 다운로드 링크 모드가 바로 그 경로를 씁니다 — 브라우저가 AES-256-GCM으로 파일을 암호화하고 키는 URL 프래그먼트에만 존재하므로, 서버는 읽을 수 없는 영지식 암호문을 저장합니다. 이런 링크 생성에는 보내는 쪽의 로그인이 필요하고, 같은 네트워크에서의 실시간 전송에는 필요 없습니다.",
      ],
    },
    {
      heading: "AirDrop vs Relayium 한눈에 비교",
      body: [
        "가장 중요한 차이를 나란히 정리하면:",
      ],
      bullets: [
        "플랫폼: AirDrop은 Apple 전용. Relayium은 브라우저에서 Windows·macOS·Linux·Android·iOS를 넘나듦.",
        "설치: AirDrop은 Apple 시스템에 내장. Relayium은 앱도 설치도 필요 없고 웹 페이지만 있으면 됨.",
        "네트워크 넘기: AirDrop은 근접만 가능. Relayium은 같은 Wi-Fi에서는 직접 연결하고, 페어링 코드로 네트워크를 넘을 때는 암호화된 릴레이를 거쳐 연결됨.",
        "암호화: 둘 다 암호화됨. Relayium은 그 위에 X25519 + AES-256-GCM을 더하고, 직접 대조하는 6자리 코드와 파일별 SHA-256 검사를 갖춤.",
        "모바일의 큰 파일: AirDrop이 더 매끄러움. Relayium은 브라우저가 메모리에 담을 수밖에 없을 때 약 256 MB를 넘으면 경고하고, Chrome과 Edge는 디스크로 바로 스트리밍하므로 그런 선이 없음.",
        "계정: AirDrop은 언제나 필요 없음. Relayium은 같은 네트워크에서는 필요 없지만, 네트워크를 넘기 위한 페어링 코드나 저장형 다운로드 링크를 만들 때는 로그인이 필요함 — 받는 쪽은 어느 경우든 계정이 필요 없음.",
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
        a: "두 기기의 브라우저에서 relayium.com을 엽니다. 같은 Wi-Fi라면 자동으로 서로를 발견하고, 아니면 한 기기에 표시된 페어링 코드를 다른 기기에 입력합니다(코드를 만드는 쪽의 로그인이 필요합니다). 최대 1,000개 파일을 고르고(고급 검증이 켜져 있다면 두 화면의 6자리 검증 코드가 일치하는지도 확인하면), 전송이 종단간 암호화된 채로 두 기기 사이에서 이루어집니다 — 같은 Wi-Fi에서는 직접, 네트워크를 넘어 페어링했다면 암호문만 보이는 릴레이를 거쳐서요.",
      },
      {
        q: "앱을 설치해야 하나요?",
        a: "아니요. Relayium은 웹 페이지입니다 — 어떤 OS에서도, 어느 기기에도 설치할 것이 없습니다. AGPL-3.0 라이선스의 무료 오픈소스이며 코드는 github.com/relayium/relayium에 공개되어 있어 감사하거나 자체 인스턴스를 운영할 수 있습니다.",
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
        "Im selben Netz läuft die Übertragung über WebRTC direkt zwischen den beiden Geräten. Der netzwerkübergreifende Weg ist bewusst anders: Ein Raum mit Pairing-Code erzwingt reines Relay-ICE, der Datenstrom läuft also über ein TURN-Relay, und die Verbindung steht in ein bis zwei Sekunden, statt rund 20 Sekunden für Direktkandidaten-Prüfungen zu verbrauchen, die zwischen zwei Heimnetzen fast nie gelingen. In beiden Fällen liegt eine zweite, unabhängige Verschlüsselungsschicht darüber: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, und dieser Schlüssel erreicht nie einen Server — das Relay bewegt also ausschließlich Chiffretext, den es nicht lesen kann. Mit eingeschalteter erweiterter Verifizierung — standardmäßig aus — zeigen beide Geräte denselben sechsstelligen Verifizierungscode (einen Short Authentication String, SAS). Ein Abgleich über einen separaten Kanal bestätigt, dass die öffentlichen X25519-Schlüssel der Endpunkte nicht ausgetauscht wurden, und erkennt, wenn der Signalisierungsdienst oder ein TURN-Relay einen Endpunkt imitiert hat. Das beweist nicht, dass TURN außerhalb des Netzwerkpfads liegt: Bei netzwerkübergreifenden Übertragungen bleibt TURN im Datenpfad, transportiert aber nur Chiffretext. Jede Datei wird zusätzlich per SHA-256-Hash Ende-zu-Ende geprüft. Du kannst bis zu 1.000 Dateien pro Stapel senden. Im selben Netz ist kein Konto nötig; einen Pairing-Code fürs Senden über Netzwerke hinweg zu erstellen erfordert eine Anmeldung — wer empfängt, braucht nie ein Konto. Bricht die Verbindung ab, kann die Übertragung fortgesetzt statt neu gestartet werden.",
      ],
    },
    {
      heading: "Ehrliche Grenzen auf iPhone und iPad",
      body: [
        "Das ist der Punkt, den man offen ansprechen sollte: Sehr große Dateien in einem mobilen Browser zu empfangen, ist nicht so geschmeidig wie natives AirDrop. Wenn kein Streaming-Weg greift — typischerweise bei mehreren Dateien gleichzeitig in einem Browser ohne File System Access API, also Firefox, Safari und alles Mobile, denn auf iOS ist jeder Browser WebKit —, landen die eingehenden Daten stattdessen im Arbeitsspeicher. Relayium warnt vor einem Download, für den es mehr als rund 256 MB Speicher schätzt. Diese Zahl ist eine bewusst konservative Schätzung und keine gemessene harte Grenze: Ein Desktop mit viel RAM kommt womöglich weit darüber hinaus, während ein Handy mit vielen offenen Tabs schon früher ins Straucheln gerät.",
        "Es wird mehr gestreamt, als das nahelegt. Chrome und Edge nutzen die File System Access API: Eine einzelne Datei geht über einen „Speichern unter“-Dialog direkt auf die Festplatte, ein ganzer Stapel streamt in einen von dir gewählten Ordner — keine Größenobergrenze, kein Speicherdruck. Selbst ohne diese API lässt sich eine einzelne Datei über den Service-Worker-Downloadweg auf die Festplatte streamen; „Firefox und Safari müssen puffern“ gilt also nicht pauschal. Genau diesen Weg nutzt der optionale Modus mit gespeichertem Download-Link — der Browser verschlüsselt die Dateien mit AES-256-GCM, und der Schlüssel liegt nur im URL-Fragment, sodass der Server Zero-Knowledge-Chiffretext hält, den er nicht lesen kann; das Erstellen eines solchen Links erfordert die Anmeldung des Absenders, eine Echtzeitübertragung im selben Netz nicht.",
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
        "Netzwerkübergreifend: AirDrop nur in der Nähe; Relayium verbindet im selben WLAN direkt oder über Netzwerke hinweg per Pairing-Code über ein verschlüsseltes Relay.",
        "Verschlüsselung: beide sind verschlüsselt; Relayium legt X25519 + AES-256-GCM darüber, mit einem sechsstelligen Code, den du prüfst, und SHA-256-Prüfungen je Datei.",
        "Große Dateien mobil: AirDrop ist geschmeidiger; Relayium warnt oberhalb von rund 256 MB, wenn der Browser im Speicher puffern muss, während Chrome und Edge direkt auf die Festplatte streamen und diese Schwelle gar nicht kennen.",
        "Konto: AirDrop braucht nie eines; Relayium braucht im selben Netz keines, verlangt aber eine Anmeldung, um einen Pairing-Code für eine netzwerkübergreifende Übertragung oder einen gespeicherten Download-Link zu erstellen — wer empfängt, braucht nie ein Konto.",
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
        a: "Öffne relayium.com in einem Browser auf beiden Geräten. Im selben WLAN erkennen sie einander automatisch; sonst gibst du den auf einem Gerät angezeigten Pairing-Code im anderen ein — dafür muss sich anmelden, wer diesen Code erstellt. Wähle bis zu 1.000 Dateien, prüfe, ob der sechsstellige Code auf beiden Bildschirmen übereinstimmt, und die Übertragung läuft Ende-zu-Ende-verschlüsselt zwischen ihnen — im selben WLAN direkt, netzwerkübergreifend über ein Relay, das nur Chiffretext sieht.",
      },
      {
        q: "Muss ich eine App installieren?",
        a: "Nein. Relayium ist eine Webseite — auf keinem Gerät und keinem Betriebssystem ist etwas zu installieren. Es ist kostenlos und quelloffen unter der AGPL-3.0-Lizenz auf github.com/relayium/relayium, sodass du es prüfen oder eine eigene Instanz betreiben kannst.",
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
  title: "Relayium vs AirDrop : une alternative multiplateforme",
  description:
    "Un regard honnête sur AirDrop et Relayium. AirDrop est excellent dans l'écosystème Apple ; Relayium tourne dans n'importe quel navigateur, pour qu'un appareil Windows, Android ou Linux envoie vers un iPhone ou un Mac, et inversement.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "AirDrop est l'une des meilleures expériences de partage de fichiers jamais livrées. Entre un iPhone, un iPad et un Mac, c'est rapide, privé et intégré au système sans effort — Relayium ne prétend pas le battre sur le terrain d'Apple.",
    "Le hic, c'est la frontière : AirDrop ne parle qu'à d'autres appareils Apple. Cet article compare les deux équitablement, explique où AirDrop est réellement meilleur, et montre où Relayium aide — pour envoyer entre un iPhone et un PC Windows, un téléphone Android et un Mac, ou un portable Linux et un iPad, directement depuis le navigateur.",
  ],
  sections: [
    {
      heading: "Ce qu'AirDrop réussit",
      body: [
        "AirDrop utilise Apple Wireless Direct Link (AWDL) pour établir une connexion Wi-Fi pair-à-pair entre deux appareils proches, le Bluetooth gérant la découverte. Le résultat est rapide, direct, et fonctionne même quand aucun des appareils n'est sur un réseau — pas de routeur, pas d'internet, pas de compte.",
        "Il est aussi profondément intégré : la feuille de partage est à une touche dans chaque app, les transferts sont chiffrés, et les fichiers reçus atterrissent automatiquement au bon endroit. Pour déplacer des photos ou des documents dans un foyer tout-Apple, difficile de faire mieux.",
      ],
    },
    {
      heading: "Le hic : AirDrop reste dans le monde d'Apple",
      body: [
        "AirDrop n'existe tout simplement pas pour Windows, Android ou Linux. Il n'y a ni client officiel ni interopérabilité, donc dès qu'un côté du transfert n'est pas un appareil Apple, AirDrop n'est pas une option du tout.",
        "C'est précisément le manque que rencontrent la plupart des gens : une photo d'iPhone qui doit rejoindre un PC Windows, une vidéo Android qui va vers un Mac, ou des fichiers qui circulent entre un poste Linux et un iPad. Les contournements habituels — un câble, un e-mail à soi-même, ou un envoi vers le cloud puis un nouveau téléchargement — sont plus lents et font transiter vos fichiers par le serveur de quelqu'un d'autre.",
      ],
    },
    {
      heading: "Comment Relayium comble le manque",
      body: [
        "Relayium fonctionne entièrement dans un navigateur moderne, sans rien à installer, si bien que deux appareils capables d'ouvrir une page web peuvent se transférer des fichiers quelle que soit la plateforme : Windows, macOS, Linux, Android et iOS s'entendent tous. Sur le même Wi-Fi, les deux appareils ouvrent relayium.com et se découvrent automatiquement ; sur des réseaux différents, vous vous connectez plutôt avec un court code d'appairage.",
        "Sur le même réseau, le transfert se fait directement entre les deux appareils via WebRTC. Le trajet entre réseaux est volontairement différent : une salle ouverte par code d'appairage force un ICE en relais seul, le flux passe donc par un relais TURN et la connexion s'établit en une ou deux secondes au lieu de consacrer une vingtaine de secondes à des tests de candidats directs qui n'aboutissent presque jamais entre deux réseaux domestiques. Dans les deux cas, une seconde couche de chiffrement indépendante se superpose : un échange de clés X25519 dérive une clé utilisée pour un AES-256-GCM par bloc, et cette clé n'atteint jamais aucun serveur — le relais ne déplace donc que du texte chiffré qu'il ne peut pas lire. Avec la vérification avancée activée — désactivée par défaut — les deux appareils affichent le même code de vérification à 6 chiffres (une chaîne d'authentification courte, SAS). Le comparer par un canal distinct confirme que les clés publiques X25519 des appareils n'ont pas été remplacées et détecte si le service de signalisation ou un relais TURN s'est fait passer pour l'un des appareils. Cela ne prouve pas que TURN est absent du chemin réseau : entre réseaux, TURN reste bien sur le chemin des données, mais ne transporte que du texte chiffré. Chaque fichier est aussi vérifié de bout en bout par une empreinte SHA-256. Vous pouvez envoyer jusqu'à 1 000 fichiers par lot. Sur le même réseau, aucun compte n'est nécessaire ; créer un code d'appairage pour envoyer entre réseaux différents exige de se connecter — le destinataire n'a jamais besoin de compte. Si la connexion tombe, le transfert peut reprendre au lieu de recommencer.",
      ],
    },
    {
      heading: "Limites honnêtes sur iPhone et iPad",
      body: [
        "C'est le point à annoncer franchement : recevoir de très gros fichiers dans un navigateur mobile n'est pas aussi fluide qu'AirDrop natif. Quand aucun chemin d'écriture en flux ne s'applique — typiquement plusieurs fichiers reçus en même temps dans un navigateur sans l'API File System Access, c'est-à-dire Firefox, Safari et tout ce qui est mobile, puisque sur iOS tous les navigateurs sont WebKit —, les données entrantes sont gardées en mémoire. Relayium prévient avant un téléchargement dont il estime le besoin en mémoire à plus de 256 Mo environ. Ce chiffre est une estimation volontairement prudente, pas une limite dure mesurée : un ordinateur bien doté peut aller bien au-delà, tandis qu'un téléphone chargé d'autres onglets peinera plus tôt.",
        "Il y a plus d'écriture en flux que cela ne le laisse croire. Chrome et Edge utilisent l'API File System Access : un fichier unique passe par une boîte de dialogue « Enregistrer sous » directement vers le disque, et un lot entier s'écrit en flux dans un dossier que vous choisissez — aucune limite de taille, aucune pression sur la mémoire. Même sans cette API, un fichier unique peut être écrit en flux sur le disque via le chemin de téléchargement par service worker : « Firefox et Safari doivent forcément mettre en mémoire tampon » n'est donc pas vrai partout. C'est exactement ce chemin qu'emprunte le mode optionnel de lien de téléchargement stocké — le navigateur chiffre les fichiers en AES-256-GCM et la clé ne vit que dans le fragment de l'URL, si bien que le serveur ne détient qu'un texte chiffré à divulgation nulle qu'il ne peut pas lire ; créer un tel lien exige que l'expéditeur se connecte, un transfert en temps réel sur le même réseau non.",
      ],
    },
    {
      heading: "AirDrop vs Relayium en un coup d'œil",
      body: [
        "Les différences qui comptent le plus, côte à côte :",
      ],
      bullets: [
        "Plateformes : AirDrop est réservé à Apple ; Relayium fonctionne dans le navigateur entre Windows, macOS, Linux, Android et iOS.",
        "Installation : AirDrop est intégré au système d'Apple ; Relayium ne demande ni app ni installation, juste une page web.",
        "Entre réseaux : AirDrop est de proximité uniquement ; Relayium se connecte en direct sur le même Wi-Fi, ou entre réseaux avec un code d'appairage via un relais chiffré.",
        "Chiffrement : les deux sont chiffrés ; Relayium ajoute X25519 + AES-256-GCM par-dessus, avec un code à 6 chiffres que vous vérifiez et des contrôles SHA-256 par fichier.",
        "Gros fichiers sur mobile : AirDrop est plus fluide ; Relayium avertit au-delà d'environ 256 Mo quand le navigateur doit mettre en mémoire tampon, alors que Chrome et Edge écrivent en flux sur le disque et ne connaissent pas ce seuil.",
        "Compte : AirDrop n'en a jamais besoin ; Relayium n'en demande pas sur le même réseau, mais il faut se connecter pour créer un code d'appairage vers un autre réseau ou un lien de téléchargement stocké — le destinataire n'a jamais besoin de compte.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Existe-t-il un AirDrop pour Windows ?",
        a: "Non — AirDrop est exclusif aux appareils Apple et n'a pas de client Windows. Relayium est l'alternative multiplateforme : il tourne dans n'importe quel navigateur, si bien qu'un PC Windows envoie vers un iPhone ou un Mac et reçoit d'eux aussi facilement qu'entre deux appareils Apple.",
      },
      {
        q: "Comment envoyer un fichier d'un iPhone vers un PC Windows ?",
        a: "Ouvrez relayium.com dans un navigateur sur les deux appareils. Sur le même Wi-Fi, ils se découvrent automatiquement ; sinon, saisissez le code d'appairage affiché sur un appareil dans l'autre — cela exige que la personne qui crée ce code se connecte. Choisissez jusqu'à 1 000 fichiers, vérifiez que le code à 6 chiffres correspond sur les deux écrans, et le transfert s'effectue entre eux, chiffré de bout en bout : en direct sur le même Wi-Fi, ou via un relais qui ne voit que du texte chiffré si vous vous êtes appairés entre réseaux.",
      },
      {
        q: "Dois-je installer une application ?",
        a: "Non. Relayium est une page web — il n'y a rien à installer sur aucun appareil, quel que soit le système d'exploitation. C'est gratuit et open source sous licence AGPL-3.0 sur github.com/relayium/relayium, vous pouvez donc l'auditer ou faire tourner votre propre instance.",
      },
    ],
  },
  cta: {
    text: "Transférez entre Apple et tout le reste — sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل AirDrop: بديل AirDrop عبر المنصّات",
  description:
    "نظرة صادقة إلى AirDrop وRelayium. يتألّق AirDrop داخل منظومة Apple؛ أمّا Relayium فيعمل في أي متصفّح، فيتيح لجهاز Windows أو Android أو Linux الإرسال إلى iPhone أو Mac، والعكس.",
  updatedLabel: "آخر تحديث",
  lead: [
    "يُعدّ AirDrop من أفضل تجارب مشاركة الملفات التي صدرت على الإطلاق. فبين iPhone وiPad وMac هو سريع وخاص ومدمج في النظام بلا عناء — ولا يدّعي Relayium أنه يتفوّق عليه في عقر دار Apple.",
    "المشكلة هي الحدود: لا يتحدّث AirDrop إلا مع أجهزة Apple الأخرى. تقارن هذه المقالة بين الاثنين بإنصاف، وتوضّح أين يكون AirDrop أفضل حقًّا، وتُبيّن أين يساعد Relayium — في الإرسال بين iPhone وحاسوب Windows، أو هاتف Android وMac، أو حاسوب Linux محمول وiPad، مباشرةً من المتصفّح.",
  ],
  sections: [
    {
      heading: "ما الذي يُتقنه AirDrop",
      body: [
        "يستخدم AirDrop تقنية Apple Wireless Direct Link لإقامة اتصال Wi-Fi من الند للند بين جهازين قريبين، بينما يتولّى Bluetooth الاكتشاف. والنتيجة سريعة ومباشرة وتعمل حتى عندما لا يكون أيٌّ من الجهازين متصلًا بشبكة — بلا موجّه، ولا إنترنت، ولا حساب.",
        "وهو أيضًا مدمج بعمق: قائمة المشاركة على بُعد نقرة واحدة في كل تطبيق، والعمليات مُشفَّرة، والملفات المُستقبَلة تستقر في مكانها الصحيح تلقائيًّا. ولنقل الصور أو المستندات داخل بيت كله من أجهزة Apple، يصعب التفوّق عليه.",
      ],
    },
    {
      heading: "المشكلة: يظل AirDrop داخل عالم Apple",
      body: [
        "AirDrop ببساطة غير موجود على Windows أو Android أو Linux. لا يوجد عميل رسمي ولا أي قابلية للتشغيل البيني، فما إن يكون أحد طرفي النقل ليس جهاز Apple حتى يخرج AirDrop من المعادلة تمامًا.",
        "وهذه بالضبط الفجوة التي يصطدم بها معظم الناس: صورة على iPhone تحتاج أن تصل إلى حاسوب Windows، أو مقطع فيديو من Android يذهب إلى Mac، أو ملفات تنتقل بين محطة عمل Linux وiPad. أمّا الحلول الالتفافية المعتادة — كابل، أو رسالة بريد إلى نفسك، أو رفع إلى السحابة ثم تنزيل من جديد — فأبطأ وتُمرّر ملفاتك عبر خادم شخص آخر.",
      ],
    },
    {
      heading: "كيف يسدّ Relayium الفجوة",
      body: [
        "يعمل Relayium بالكامل داخل متصفّح ويب حديث دون أي تثبيت، فأيّ جهازين يستطيعان فتح صفحة ويب يمكنهما النقل بينهما بصرف النظر عن المنصّة: Windows وmacOS وLinux وAndroid وiOS تتفاهم جميعها. على نفس شبكة Wi-Fi، يفتح الجهازان relayium.com فيكتشف كلٌّ منهما الآخر تلقائيًّا؛ وعلى شبكات مختلفة تتّصل بدلًا من ذلك برمز اقتران قصير.",
        "على نفس الشبكة يجري النقل مباشرةً بين الجهازين عبر WebRTC. أمّا المسار العابر للشبكات فمختلف عن قصد: غرفة رمز الاقتران تفرض ICE عبر المُرحِّل وحده، فيمرّ التدفّق عبر مُرحِّل TURN وينعقد الاتصال خلال ثانية أو ثانيتين بدل إنفاق نحو 20 ثانية على فحص مرشّحات الاتصال المباشر التي لا تكاد تنجح بين شبكتين منزليتين. وفي الحالتين تعلوه طبقة تشفير ثانية مستقلّة: يشتقّ تبادل مفاتيح X25519 مفتاحًا يُستخدم لتشفير AES-256-GCM لكل جزء، وهذا المفتاح لا يصل إلى أي خادم أبدًا — فما ينقله المُرحِّل هو نص مُشفَّر لا يستطيع قراءته. وعند تفعيل «التحقّق المتقدّم» — المعطَّل افتراضيًا — يعرض الجهازان نفس رمز التحقق المكوّن من 6 أرقام (سلسلة مصادقة قصيرة، SAS). تؤكد مقارنته عبر قناة منفصلة أن المفاتيح العامة لطرفي X25519 لم تُستبدل، وتكشف ما إذا كان خادم الإشارات أو مُرحِّل TURN قد انتحل شخصية أي من الطرفين. ولا يثبت ذلك غياب TURN عن مسار الشبكة: فعند النقل عبر الشبكات يظل TURN ضمن مسار البيانات، لكنه لا يحمل سوى النص المشفّر. ويُتحقَّق أيضًا من كل ملف من الطرف إلى الطرف ببصمة SHA-256. يمكنك إرسال ما يصل إلى 1,000 ملف في الدفعة الواحدة؛ وعلى نفس الشبكة لا حاجة إلى حساب، أمّا إنشاء رمز اقتران للإرسال عبر الشبكات فيتطلّب تسجيل الدخول — ولا يحتاج المُستقبِل إلى حساب أبدًا. وإذا انقطع الاتصال، يمكن للنقل أن يُستأنف بدلًا من أن يبدأ من جديد.",
      ],
    },
    {
      heading: "حدود صادقة على iPhone وiPad",
      body: [
        "هذا هو الجزء الذي يجب أن نكون صريحين بشأنه: استقبال الملفات الكبيرة جدًّا في متصفّح جوّال ليس بسلاسة AirDrop الأصلي. فحين لا ينطبق أي مسار للكتابة التدفّقية على القرص — والحالة النموذجية هي استقبال عدة ملفات دفعةً واحدة في متصفّح بلا File System Access API، أي Firefox وSafari وكل متصفّحات الجوّال (فكل متصفّحات iOS مبنية على WebKit) — تُحفَظ البيانات الواردة في الذاكرة بدلًا من ذلك. ويحذّرك Relayium قبل أي تنزيل يقدّر أنه سيحتاج أكثر من نحو 256 ميغابايت من الذاكرة. وهذا الرقم تقدير متحفّظ عن قصد، وليس حدًّا صلبًا مقيسًا: فحاسوب مكتبي واسع الذاكرة قد يتجاوزه بمراحل، بينما قد يتعثّر هاتف مثقل بعلامات تبويب أخرى قبل ذلك بكثير.",
        "والكتابة التدفّقية متاحة أكثر ممّا يوحي به ذلك. يستخدم Chrome وEdge واجهة File System Access: الملف المفرد يمرّ عبر مربّع حوار «حفظ باسم» إلى القرص مباشرةً، والدفعة الكاملة تُكتب تدفّقيًّا داخل مجلد تختاره — بلا حدّ للحجم وبلا ضغط على الذاكرة. وحتى بدون هذه الواجهة يمكن كتابة ملف مفرد تدفّقيًّا على القرص عبر مسار التنزيل بواسطة service worker، فالقول إنّ «Firefox وSafari مضطران للتخزين في الذاكرة» ليس صحيحًا على إطلاقه. وهذا المسار بالذات هو ما يستخدمه وضع رابط التنزيل المُخزَّن الاختياري — يشفّر متصفّحك الملفات بـ AES-256-GCM ويبقى المفتاح فقط في مقطع الـ URL، فلا يحتفظ الخادم إلا بنص مُشفَّر بمعرفة صفرية لا يستطيع قراءته؛ ويتطلّب إنشاء مثل هذا الرابط أن يسجّل المُرسِل الدخول، بينما لا يتطلّب ذلك النقل الفوري على نفس الشبكة.",
      ],
    },
    {
      heading: "AirDrop مقابل Relayium في لمحة",
      body: [
        "أهمّ الفروق جنبًا إلى جنب:",
      ],
      bullets: [
        "المنصّات: AirDrop حصري لأجهزة Apple؛ أمّا Relayium فيعمل عبر Windows وmacOS وLinux وAndroid وiOS في المتصفّح.",
        "التثبيت: AirDrop مدمج في نظام Apple؛ أمّا Relayium فلا يحتاج تطبيقًا ولا تثبيتًا، مجرّد صفحة ويب.",
        "عبر الشبكات: AirDrop للأجهزة القريبة فقط؛ أمّا Relayium فيتّصل مباشرةً على نفس شبكة Wi-Fi، وعبر الشبكات برمز اقتران من خلال مُرحِّل مشفّر.",
        "التشفير: كلاهما مُشفَّر؛ ويضيف Relayium فوق ذلك X25519 + AES-256-GCM مع رمز من 6 أرقام تتحقّق منه وفحوص SHA-256 لكل ملف.",
        "الملفات الكبيرة على الجوّال: AirDrop أكثر سلاسة؛ ويحذّر Relayium فوق نحو 256 ميغابايت عندما يضطر المتصفّح إلى التخزين في الذاكرة، بينما يكتب Chrome وEdge تدفّقيًّا إلى القرص فلا يعرفان هذه العتبة أصلًا.",
        "الحساب: AirDrop لا يحتاج إليه أبدًا؛ أمّا Relayium فلا يحتاج حسابًا على نفس الشبكة، لكن يلزم تسجيل الدخول لإنشاء رمز اقتران لنقل عابر للشبكات أو لإنشاء رابط تنزيل مُخزَّن — ولا يحتاج المُستقبِل إلى حساب أبدًا.",
      ],
    },
  ],
  faq: {
    heading: "أسئلة شائعة",
    items: [
      {
        q: "هل يوجد AirDrop لنظام Windows؟",
        a: "لا — AirDrop حصري لأجهزة Apple وليس له عميل على Windows. وRelayium هو البديل عبر المنصّات: يعمل في أي متصفّح، فيستطيع حاسوب Windows أن يُرسل إلى iPhone أو Mac ويستقبل منهما بالسهولة نفسها كما بين جهازي Apple.",
      },
      {
        q: "كيف أُرسل ملفًّا من iPhone إلى حاسوب Windows؟",
        a: "افتح relayium.com في متصفّح على كلا الجهازين. على نفس شبكة Wi-Fi يكتشف كلٌّ منهما الآخر تلقائيًّا؛ وإلا فأدخِل رمز الاقتران المعروض على أحد الجهازين في الآخر، وهذا يتطلّب أن يسجّل مُنشئ الرمز الدخول. اختَر ما يصل إلى 1,000 ملف — وإن كان «التحقّق المتقدّم» مفعَّلًا فتأكّد من تطابق رمز التحقق المكوّن من 6 أرقام على الشاشتين — فيجري النقل بينهما مشفّرًا من الطرف إلى الطرف — مباشرةً على نفس شبكة Wi-Fi، أو عبر مُرحِّل لا يرى سوى نص مُشفَّر إن كان الاقتران عبر الشبكات.",
      },
      {
        q: "هل أحتاج إلى تثبيت تطبيق؟",
        a: "لا. Relayium صفحة ويب — لا شيء لتثبيته على أيٍّ من الجهازين، على أي نظام تشغيل. وهو مجاني ومفتوح المصدر بموجب رخصة AGPL-3.0 على github.com/relayium/relayium، فيمكنك تدقيقه أو تشغيل نسختك الخاصة.",
      },
    ],
  },
  cta: {
    text: "أرسِل بين Apple وكل ما عداها — بلا تثبيت، وبلا حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Relayium vs AirDrop: una alternativa a AirDrop multiplataforma",
  description:
    "Una mirada honesta a AirDrop y Relayium. AirDrop es excelente dentro del ecosistema de Apple; Relayium funciona en cualquier navegador, así que un dispositivo Windows, Android o Linux puede enviar a un iPhone o un Mac, y a la inversa.",
  updatedLabel: "Última actualización",
  lead: [
    "AirDrop es una de las mejores experiencias de compartir archivos jamás lanzadas. Entre un iPhone, un iPad y un Mac es rápido, privado y está integrado en el sistema sin esfuerzo — Relayium no pretende superarlo en el terreno propio de Apple.",
    "El inconveniente es la frontera: AirDrop solo se comunica con otros dispositivos Apple. Este artículo compara ambos con justicia, explica dónde AirDrop es realmente mejor y muestra dónde ayuda Relayium — al enviar entre un iPhone y un PC con Windows, un teléfono Android y un Mac, o un portátil Linux y un iPad, directamente desde el navegador.",
  ],
  sections: [
    {
      heading: "Lo que AirDrop hace bien",
      body: [
        "AirDrop usa Apple Wireless Direct Link para levantar una conexión Wi-Fi de igual a igual entre dos dispositivos cercanos, mientras Bluetooth se encarga del descubrimiento. El resultado es rápido, directo y funciona incluso cuando ninguno de los dispositivos está en una red — sin router, sin internet, sin cuenta.",
        "También está profundamente integrado: la hoja de compartir está a un toque en cada aplicación, las transferencias van cifradas y los archivos recibidos aterrizan automáticamente en el lugar correcto. Para mover fotos o documentos dentro de un hogar totalmente Apple, es difícil de superar.",
      ],
    },
    {
      heading: "El inconveniente: AirDrop se queda dentro del mundo de Apple",
      body: [
        "AirDrop sencillamente no existe para Windows, Android ni Linux. No hay cliente oficial ni interoperabilidad, así que en el momento en que un lado de la transferencia no es un dispositivo Apple, AirDrop deja de ser una opción por completo.",
        "Ese es justo el hueco con el que topa la mayoría: una foto del iPhone que necesita llegar a un PC con Windows, un vídeo de Android que va hacia un Mac, o archivos que se mueven entre una estación de trabajo Linux y un iPad. Los apaños habituales — un cable, un correo a ti mismo, o subir a la nube y volver a descargar — son más lentos y hacen pasar tus archivos por el servidor de otra persona.",
      ],
    },
    {
      heading: "Cómo Relayium tiende el puente",
      body: [
        "Relayium funciona por completo en un navegador web moderno sin nada que instalar, así que dos dispositivos cualesquiera que puedan abrir una página web pueden transferirse entre sí sin importar la plataforma: Windows, macOS, Linux, Android e iOS interoperan todos. En la misma Wi-Fi, ambos dispositivos abren relayium.com y se descubren automáticamente; en redes distintas te conectas con un breve código de emparejamiento en su lugar.",
        "En la misma red, la transferencia va directamente entre los dos dispositivos por WebRTC. El trayecto entre redes es distinto a propósito: una sala abierta con código de emparejamiento fuerza un ICE solo de retransmisión, así que el flujo pasa por un retransmisor TURN y la conexión se levanta en uno o dos segundos, en lugar de gastar unos 20 segundos en comprobaciones de candidatos directos que casi nunca prosperan entre dos redes domésticas. En ambos casos se superpone una segunda capa de cifrado independiente: un intercambio de claves X25519 deriva una clave que se usa para AES-256-GCM por fragmento, y esa clave nunca llega a ningún servidor, de modo que el retransmisor solo mueve texto cifrado que no puede leer. Con la verificación avanzada activada —desactivada por omisión— ambos dispositivos muestran el mismo código de verificación de 6 dígitos (una Short Authentication String). Compararlo por un canal independiente confirma que las claves públicas X25519 de los extremos no se han sustituido y detecta si el servidor de señalización o un retransmisor TURN ha suplantado a alguno de los extremos. Esto no demuestra que TURN esté fuera de la ruta de red: entre redes, TURN sigue estando en la ruta de los datos, pero solo transporta texto cifrado. Cada archivo también se verifica de extremo a extremo con un hash SHA-256. Puedes enviar hasta 1.000 archivos por lote; en la misma red no hace falta cuenta, y crear un código de emparejamiento para enviar entre redes requiere iniciar sesión — el destinatario nunca necesita cuenta. Si la conexión se cae, la transferencia puede reanudarse en lugar de empezar de nuevo.",
      ],
    },
    {
      heading: "Límites honestos en iPhone y iPad",
      body: [
        "Esta es la parte que conviene decir con franqueza: recibir archivos muy grandes en un navegador móvil no es tan fluido como el AirDrop nativo. Cuando no se aplica ninguna vía de escritura en flujo al disco —lo típico es recibir varios archivos a la vez en un navegador sin la API File System Access, es decir Firefox, Safari y todo lo móvil, ya que en iOS todos los navegadores son WebKit—, los datos entrantes se guardan en memoria. Relayium avisa antes de una descarga para la que estima más de unos 256 MB de memoria. Esa cifra es una estimación deliberadamente conservadora, no un límite duro medido: un escritorio con memoria de sobra puede superarla con holgura, mientras que un teléfono con otras pestañas abiertas puede sufrir antes.",
        "Se transmite en flujo más de lo que eso sugiere. Chrome y Edge usan la API File System Access: un solo archivo pasa por un diálogo de «Guardar como» directo al disco, y un lote entero se escribe en flujo en la carpeta que elijas, sin techo de tamaño ni presión de memoria. Incluso sin esa API, un solo archivo puede escribirse en flujo al disco por la vía de descarga del service worker, así que «Firefox y Safari tienen que almacenar en memoria» no vale como regla general. Esa vía es justo la que usa el modo opcional de enlace de descarga almacenado — tu navegador cifra los archivos con AES-256-GCM y la clave vive solo en el fragmento de la URL, así que el servidor guarda texto cifrado de conocimiento cero que no puede leer; crear un enlace así requiere que el remitente inicie sesión, mientras que una transferencia en tiempo real en la misma red no.",
      ],
    },
    {
      heading: "AirDrop vs Relayium de un vistazo",
      body: [
        "Las diferencias que más importan, una al lado de la otra:",
      ],
      bullets: [
        "Plataformas: AirDrop es solo para Apple; Relayium funciona en Windows, macOS, Linux, Android e iOS desde el navegador.",
        "Instalación: AirDrop está integrado en el sistema de Apple; Relayium no necesita ninguna app ni instalación, solo una página web.",
        "Entre redes: AirDrop es solo de proximidad; Relayium conecta directamente en la misma Wi-Fi, o entre redes con un código de emparejamiento a través de un retransmisor cifrado.",
        "Cifrado: ambos van cifrados; Relayium añade X25519 + AES-256-GCM con un código de 6 dígitos que verificas y comprobaciones SHA-256 por archivo.",
        "Archivos grandes en móvil: AirDrop es más fluido; Relayium avisa por encima de unos 256 MB cuando el navegador tiene que almacenar en memoria, mientras que Chrome y Edge escriben en flujo al disco y no conocen ese techo.",
        "Cuenta: AirDrop nunca necesita una; Relayium no necesita cuenta en la misma red, pero hay que iniciar sesión para crear un código de emparejamiento hacia otra red o un enlace de descarga almacenado — el destinatario nunca necesita cuenta.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Existe un AirDrop para Windows?",
        a: "No — AirDrop es exclusivo de los dispositivos Apple y no tiene cliente para Windows. Relayium es la alternativa multiplataforma: funciona en cualquier navegador, así que un PC con Windows puede enviar a un iPhone o un Mac y recibir de ellos con la misma facilidad que entre dos dispositivos Apple.",
      },
      {
        q: "¿Cómo envío un archivo de un iPhone a un PC con Windows?",
        a: "Abre relayium.com en un navegador en ambos dispositivos. En la misma Wi-Fi se descubren automáticamente; si no, introduce en el otro el código de emparejamiento que muestra un dispositivo, lo que requiere que quien crea ese código inicie sesión. Elige hasta 1.000 archivos y, si la verificación avanzada está activada, confirma que el código de verificación de 6 dígitos coincide en ambas pantallas; la transferencia se realiza entre ellos cifrada de extremo a extremo: directamente en la misma Wi-Fi, o a través de un retransmisor que solo ve texto cifrado si las dos partes se han emparejado entre redes.",
      },
      {
        q: "¿Necesito instalar una app?",
        a: "No. Relayium es una página web — no hay nada que instalar en ninguno de los dispositivos, en cualquier sistema operativo. Es gratis y de código abierto bajo la licencia AGPL-3.0 en github.com/relayium/relayium, así que puedes auditarlo o ejecutar tu propia instancia.",
      },
    ],
  },
  cta: {
    text: "Envía entre Apple y todo lo demás — sin instalación, y sin cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs AirDrop: uma alternativa ao AirDrop multiplataforma",
  description:
    "Um olhar honesto sobre o AirDrop e o Relayium. O AirDrop é excelente dentro do ecossistema da Apple; o Relayium roda em qualquer navegador, então um dispositivo Windows, Android ou Linux pode enviar para um iPhone ou Mac, e vice-versa.",
  updatedLabel: "Última atualização",
  lead: [
    "O AirDrop é uma das melhores experiências de compartilhamento de arquivos já lançadas. Entre um iPhone, um iPad e um Mac ele é rápido, privado e integrado ao sistema sem esforço — o Relayium não finge vencê-lo no território da própria Apple.",
    "O problema é a fronteira: o AirDrop só conversa com outros dispositivos Apple. Este artigo compara os dois de forma justa, explica onde o AirDrop é realmente melhor e mostra onde o Relayium ajuda — ao enviar entre um iPhone e um PC com Windows, um telefone Android e um Mac, ou um notebook Linux e um iPad, direto do navegador.",
  ],
  sections: [
    {
      heading: "O que o AirDrop faz bem",
      body: [
        "O AirDrop usa o Apple Wireless Direct Link para levantar uma conexão Wi-Fi ponto a ponto entre dois dispositivos próximos, com o Bluetooth cuidando da descoberta. O resultado é rápido, direto e funciona mesmo quando nenhum dos dispositivos está em uma rede — sem roteador, sem internet, sem conta.",
        "Ele também é profundamente integrado: a folha de compartilhamento está a um toque em todo aplicativo, as transferências são criptografadas e os arquivos recebidos vão automaticamente para o lugar certo. Para mover fotos ou documentos dentro de uma casa toda Apple, é difícil de superar.",
      ],
    },
    {
      heading: "O problema: o AirDrop permanece dentro do mundo da Apple",
      body: [
        "O AirDrop simplesmente não existe para Windows, Android ou Linux. Não há cliente oficial nem interoperabilidade, então no momento em que um lado da transferência não é um dispositivo Apple, o AirDrop deixa de ser uma opção por completo.",
        "É exatamente essa a lacuna com que a maioria das pessoas esbarra: uma foto do iPhone que precisa chegar a um PC com Windows, um vídeo do Android indo para um Mac, ou arquivos indo e voltando entre uma estação de trabalho Linux e um iPad. As soluções de contorno habituais — um cabo, um e-mail para si mesmo, ou um upload para a nuvem e novo download — são mais lentas e fazem seus arquivos passarem pelo servidor de outra pessoa.",
      ],
    },
    {
      heading: "Como o Relayium preenche a lacuna",
      body: [
        "O Relayium roda inteiramente em um navegador web moderno, sem nada para instalar, então dois dispositivos quaisquer que consigam abrir uma página web podem transferir entre si independentemente da plataforma: Windows, macOS, Linux, Android e iOS todos interoperam. Na mesma rede Wi-Fi, os dois dispositivos abrem relayium.com e se descobrem automaticamente; em redes diferentes, você se conecta com um curto código de emparelhamento.",
        "Na mesma rede, a transferência vai diretamente entre os dois dispositivos por WebRTC. O caminho entre redes é diferente de propósito: uma sala aberta com código de emparelhamento força um ICE somente de retransmissão, então o fluxo passa por um retransmissor TURN e a conexão sobe em um ou dois segundos, em vez de gastar cerca de 20 segundos em verificações de candidatos diretos que quase nunca dão certo entre duas redes domésticas. Nos dois casos há uma segunda camada de criptografia independente por cima: uma troca de chaves X25519 deriva uma chave usada para AES-256-GCM por bloco, e essa chave nunca chega a nenhum servidor — então o retransmissor só movimenta texto cifrado que ele não consegue ler. Os dois dispositivos mostram o mesmo código de verificação de 6 dígitos (uma Short Authentication String). Compará-lo por um canal separado confirma que as chaves públicas X25519 das pontas não foram substituídas e detecta se o servidor de sinalização ou um retransmissor TURN se passou por qualquer uma das pontas. Isso não prova que TURN esteja fora do caminho da rede: entre redes, TURN continua no caminho dos dados, mas só transporta texto cifrado. Cada arquivo também é verificado de ponta a ponta com um hash SHA-256. Você pode enviar até 1.000 arquivos por lote; na mesma rede não é preciso conta, e criar um código de emparelhamento para enviar entre redes exige login — o destinatário nunca precisa de conta. Se a conexão cair, a transferência pode ser retomada em vez de recomeçar.",
      ],
    },
    {
      heading: "Limites honestos no iPhone e no iPad",
      body: [
        "É aqui que é preciso ser honesto: receber arquivos muito grandes em um navegador móvel não é tão suave quanto o AirDrop nativo. Quando nenhum caminho de gravação em fluxo se aplica — o caso típico é receber vários arquivos de uma vez em um navegador sem a API File System Access, ou seja, Firefox, Safari e tudo no celular, já que no iOS todo navegador é WebKit —, os dados que chegam ficam na memória. O Relayium avisa antes de um download para o qual estima mais de cerca de 256 MB de memória. Esse número é uma estimativa deliberadamente conservadora, não um limite rígido medido: um desktop com memória sobrando pode ir muito além disso, enquanto um celular com outras abas abertas pode sofrer bem antes.",
        "Há mais gravação em fluxo do que isso sugere. Chrome e Edge usam a API File System Access: um único arquivo passa por uma caixa de diálogo “Salvar como” direto para o disco, e um lote inteiro é gravado em fluxo na pasta que você escolher — sem teto de tamanho e sem pressão de memória. Mesmo sem essa API, um único arquivo pode ser gravado em fluxo no disco pelo caminho de download via service worker, então “Firefox e Safari precisam armazenar na memória” não vale como regra geral. É justamente esse caminho que o modo opcional de link de download armazenado usa — seu navegador criptografa os arquivos com AES-256-GCM e a chave vive apenas no fragmento da URL, então o servidor guarda texto cifrado de conhecimento zero que não consegue ler; criar um link assim exige que o remetente faça login, enquanto uma transferência em tempo real na mesma rede não.",
      ],
    },
    {
      heading: "AirDrop vs Relayium em resumo",
      body: [
        "As diferenças que mais importam, lado a lado:",
      ],
      bullets: [
        "Plataformas: o AirDrop é só para Apple; o Relayium funciona em Windows, macOS, Linux, Android e iOS no navegador.",
        "Instalação: o AirDrop é integrado ao sistema da Apple; o Relayium não precisa de app nem instalação, apenas uma página web.",
        "Entre redes: o AirDrop é só de proximidade; o Relayium conecta diretamente na mesma rede Wi-Fi, ou entre redes com um código de emparelhamento através de um retransmissor criptografado.",
        "Criptografia: ambos são criptografados; o Relayium acrescenta X25519 + AES-256-GCM com um código de 6 dígitos que você verifica e checagens SHA-256 por arquivo.",
        "Arquivos grandes no celular: o AirDrop é mais suave; o Relayium avisa acima de cerca de 256 MB quando o navegador precisa armazenar na memória, enquanto Chrome e Edge gravam em fluxo direto no disco e não conhecem esse teto.",
        "Conta: o AirDrop nunca precisa de uma; o Relayium não precisa de conta na mesma rede, mas é preciso fazer login para criar um código de emparelhamento para outra rede ou um link de download armazenado — o destinatário nunca precisa de conta.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Existe um AirDrop para Windows?",
        a: "Não — o AirDrop é exclusivo dos dispositivos Apple e não tem cliente para Windows. O Relayium é a alternativa multiplataforma: roda em qualquer navegador, então um PC com Windows pode enviar para um iPhone ou Mac e receber deles com a mesma facilidade que entre dois dispositivos Apple.",
      },
      {
        q: "Como envio um arquivo de um iPhone para um PC com Windows?",
        a: "Abra relayium.com em um navegador nos dois dispositivos. Na mesma rede Wi-Fi eles se descobrem automaticamente; caso contrário, digite no outro o código de emparelhamento mostrado em um dispositivo, o que exige que quem cria esse código faça login. Escolha até 1.000 arquivos e, se a verificação avançada estiver ativada, confirme que o código de verificação de 6 dígitos coincide nas duas telas; a transferência ocorre entre eles criptografada de ponta a ponta: diretamente na mesma rede Wi-Fi, ou por um retransmissor que só vê texto cifrado se você emparelhou entre redes.",
      },
      {
        q: "Preciso instalar um aplicativo?",
        a: "Não. O Relayium é uma página web — não há nada para instalar em nenhum dos dispositivos, em qualquer sistema operacional. É gratuito e de código aberto sob a licença AGPL-3.0 em github.com/relayium/relayium, então você pode auditá-lo ou rodar sua própria instância.",
      },
    ],
  },
  cta: {
    text: "Envie entre a Apple e todo o resto — sem instalação, e sem conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/airdrop",
  published: "2026-07-03",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
