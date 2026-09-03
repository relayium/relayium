// web/scripts/pages/content/legal/privacy.mjs
const en = {
  title: "Privacy Policy",
  description:
    "How Relayium handles files and ephemeral text: content is end-to-end encrypted, live message bodies are never stored by Relayium, and stored download links keep files zero-knowledge encrypted.",
  updatedLabel: "Last updated",
  updated: "2026-09-03",
  otherDocLabel: "Terms of Service",
  lead: [
    "Relayium is built so that your files and ephemeral text stay yours. Local browser sessions are direct; cross-network browser sessions may carry end-to-end encrypted ciphertext through TURN; CLI text is direct-only; and stored download links hold only zero-knowledge encrypted file ciphertext.",
    "This page explains the little data the service does handle, and the data it deliberately never sees.",
  ],
  sections: [
    {
      heading: "Local-network content is not stored",
      body: [
        "When you transfer files or exchange text between devices on the same network, no account is needed and Relayium does not store the content. The signaling service temporarily handles connection metadata such as IP addresses, room membership, device names, presence, capabilities, and WebRTC negotiation so the devices can connect directly.",
      ],
    },
    {
      heading: "What an account stores (only if you sign in)",
      body: [
        "Same-network (LAN) sessions need no account. To create a cross-network pairing code for a browser or CLI session, the code creator must sign in; the person joining with that code does not need an account. Creating a stored download link also requires signing in. If you sign in, we store the minimum needed to run an account:",
      ],
      bullets: [
        "Your email address and a display name.",
        "Which sign-in method you used (Sign in with Apple, Google, an email magic link, or email + password). Magic-link tokens are stored only as a hash, never in clear text; if you set a password, we store only its bcrypt hash, never the password itself. If you use Sign in with Apple with Apple's private email relay, we only ever see that relay address.",
        "A login session, kept in a secure, httpOnly cookie.",
        "Devices you register, as a random device id and a device name (e.g. your platform name).",
      ],
    },
    {
      heading: "Stored transfer (download links)",
      body: [
        "When you use the optional stored download-link mode, your files are encrypted with AES-256-GCM on your own device before they leave it. That is true of every client that can create or open one of these links: a browser, the command-line tool, and our native macOS and iOS apps all encrypt and decrypt locally, and none of them uploads anything the server could read. The decryption key exists only in the URL fragment — it is never sent to the server. This means:",
      ],
      bullets: [
        "The server stores only ciphertext. It cannot read your file contents, filenames, or keys.",
        "We record the ciphertext size and timestamps (upload time, expiry) for quota management and cleanup.",
        "Ciphertext is automatically deleted at expiry or on the first complete download (burn-after-read), whichever comes first.",
      ],
    },
    {
      heading: "Content we cannot read",
      body: ["Relayium servers never receive the following in plaintext and cannot decrypt them:"],
      bullets: [
        "The contents of your files.",
        "The names of your files.",
        "The bodies of your live text messages.",
        "Your encryption keys.",
      ],
    },
    {
      heading: "Cross-network relay (TURN)",
      body: [
        "Cross-network browser file and text sessions use a TURN server by design. TURN carries only end-to-end encrypted ciphertext and transport metadata. We attribute relayed-byte totals and timestamps to the code creator's account for quotas and abuse prevention, without inspecting message or file plaintext. CLI text is direct-only and does not use or count against TURN. Live text requires both participants to be online; Relayium provides no offline delivery or server-side message history, though either endpoint may copy or retain what it receives.",
      ],
    },
    {
      heading: "Usage metering and quotas",
      body: [
        "Paid plans mean the service has to count how much of it each account uses. While you are signed in, we keep a running per-account record of the bytes you upload and download through Relayium, the size of the ciphertext your stored links are holding, and the relayed-byte totals attributed to pairing codes you created. These counters outlive the transfer that produced them — we keep them as monthly per-account totals — because they are what enforces the usage, storage and relay quotas included in your plan, and what our billing and account records rest on. A paid subscription is a fixed price for a plan, not a per-byte charge.",
      ],
      bullets: [
        "What is recorded: byte volumes, stored-object sizes, and the times they were measured, linked to your account.",
        "What is not: your file contents, file names, and message bodies stay encrypted and unreadable to us. Separately from account metering, we retain three first-party, identifier-free monthly aggregate action counts for cross-network pairing: successful code mints, the first admitted socket for a live code, and the first transition to two admitted peers. Each aggregate contains only UTC month, one of those three fixed stages, and a nonnegative count—never an identifier, event row, exact timestamp, or content metadata.",
        "Those three product-interaction totals are bounded, best-effort lower-bound action counts, not unique users, a cohort, or an exact conversion rate. Any displayed ratio divides same-month action totals and is not cohort conversion. Our apps and website carry no advertising or third-party analytics SDK, and neither the aggregate nor the account meters are used to track you across other apps or websites.",
        "You can see your account-linked usage totals at any time on your account page, in the app or on the web. The identifier-free aggregate appears only in the administrator overview; the database does not store it against your account and contains no field linking it to an account.",
      ],
    },
    {
      heading: "Cookies and local storage",
      body: [
        "We use one session cookie to keep you signed in. In your browser's local storage we keep a random device id so a device you registered can be recognized. We do not use advertising or tracking cookies.",
      ],
    },
    {
      heading: "Third-party services",
      body: ["A few third parties are involved only when you choose to use them:"],
      bullets: [
        "Google, if you sign in with Google — we receive your email and basic profile to create the account.",
        "Apple, if you use Sign in with Apple — we receive a stable identifier and the email (or Apple's private relay address) you choose to share.",
        "Stripe, our payment processor for subscriptions purchased on the web — see Payments.",
        "Apple, for subscriptions purchased inside our macOS or iOS app via in-app purchase — see Payments.",
        "An email delivery provider, to send account emails such as magic-link sign-in and verification.",
      ],
    },
    {
      heading: "Payments",
      body: [
        "You only share payment data if you buy a paid plan. We never receive or store your full card number.",
      ],
      bullets: [
        "On the web, payments are handled by Stripe. Card details go to Stripe, not to us; we receive only a customer reference and the resulting subscription status.",
        "In our native apps, on macOS and on iOS alike, subscriptions are bought through Apple in-app purchase rather than from us. Apple processes the payment under your Apple ID, and we never see your payment method. The app sends us Apple's signed record of the transaction, and we keep what it says about the purchase: which subscription product you bought, Apple's identifier for that subscription, and its status, billing period, and renewal or expiry dates. We also generate a random token that ties an App Store purchase to your Relayium account; the app hands that token to Apple with the purchase and it comes back to us in the signed transaction, which is how the two records are matched without either side learning anything else about you.",
        "For your account we store only your current plan, subscription status, billing cycle, period dates, and your payment provider's reference for the subscription — never card data.",
      ],
    },
    {
      heading: "The Relayium apps for macOS and iOS",
      body: [
        "Our native apps handle a little device-level data that the website does not, and the two platforms do not handle the same data. Each item below says which platform it describes.",
      ],
      bullets: [
        "The label this device carries in your account. On macOS the app reads the computer name from your Mac's Sharing settings and uses it as that label — sent with an email-and-password sign-in so your account can tell your devices apart and you can sign one out, and announced to the other devices in the room when you pair over the same network. macOS often seeds that name from your full name, so renaming the Mac changes what is sent. On iOS the label is generic and is never a name you chose: the app reads the hardware model and sends the device family — \"iPhone\", \"iPad\" or \"iPod touch\" — and nothing else, in those same two places. No personal name reaches us from an iPhone or iPad this way.",
        "An installation identifier, on macOS only. It is 32 random bytes the app generates on that Mac and keeps in its keychain, sent when you sign in through your browser so that signing back in returns to the device entry this Mac already has instead of adding another. It is random and never derived from your hardware — no serial number, MAC address, or hostname — so it identifies an installation and nothing about the machine. The iOS app has no browser sign-in to continue, so it generates no such identifier: today it sends us no installation identifier and no identifier read from the device itself. The random device id in your account's device list is one we issue for your account, as described above, and is not derived from your phone.",
        "What these apps do not do. Neither registers a push token and neither receives push notifications: on macOS, a finished transfer or a new inbox delivery is announced by macOS on that Mac itself, and those banners deliberately carry no file names, links, or codes, while the iOS app has no push capability and registers nothing with Apple's push service. The iOS app asks for the camera for one purpose — reading the pairing QR code another device is showing, so you do not have to type its join code by hand — and that happens entirely on your device: the picture and the code in it are used on the spot to join that pairing, and nothing the camera sees is stored by the app or sent to us as camera data. The macOS app asks for no camera access at all, and neither app has access to your photo library: when you pick photos to send on iOS, the system's own picker runs outside the app and hands it only the items you chose. Neither app tracks you across other apps or websites, and neither contains advertising or third-party analytics SDKs.",
      ],
    },
    {
      heading: "Data retention and deletion",
      body: [
        "Account data is kept while your account exists. You can delete your account and its data at any time from your account settings, in the app or on the web. Deletion starts a 30-day grace period during which you can undo it by signing back in; after that, your account and personal data are permanently removed. Aggregate usage counters we must keep for billing and abuse-prevention are anonymized so they are no longer linked to you.",
      ],
    },
    {
      heading: "Your rights",
      body: [
        "You can access, correct, export, or delete your account data, and object to or restrict certain processing. Most of this you can do yourself in your account settings; for anything else, email support@relayium.com. We do not sell your personal data. Where the GDPR or similar laws apply, our basis for the little data we process is performing the service you asked for and our legitimate interest in keeping it secure and preventing abuse.",
      ],
    },
    {
      heading: "Children",
      body: [
        "Relayium is not directed to children. We do not knowingly collect personal data from anyone under 13, or under the minimum age of digital consent where you live. If you believe a child has given us data, contact support@relayium.com and we will delete it.",
      ],
    },
    {
      heading: "Changes to this policy",
      body: [
        "We may update this policy as the service evolves. When we do, we will change the \"Last updated\" date above.",
      ],
    },
    {
      heading: "Contact",
      body: ["Questions about privacy? Email support@relayium.com."],
    },
  ],
};

const zh = {
  title: "隐私政策",
  description:
    "Relayium 如何处理文件与临时文本：内容采用端到端加密，Relayium 不存储实时消息正文，暂存下载链接中的文件保持零知识加密。",
  updatedLabel: "最后更新",
  updated: "2026-09-03",
  otherDocLabel: "服务条款",
  lead: [
    "Relayium 的设计宗旨是让你的文件与临时文本始终属于你。浏览器局域网会话直接连接；跨网络浏览器会话可能通过 TURN 传输端到端加密的密文；CLI 文本仅直连；暂存下载链接只保存零知识加密的文件密文。",
    "本页说明本服务确实会处理的少量数据，以及它刻意从不接触的数据。",
  ],
  sections: [
    {
      heading: "局域网内容不会被存储",
      body: [
        "在同一网络下的设备之间传输文件或交换文本时，无需账号，Relayium 也不会存储内容。为帮助设备直接连接，信令服务会临时处理 IP 地址、房间成员、设备名、在线状态、能力信息及 WebRTC 协商等连接元数据。",
      ],
    },
    {
      heading: "账号会存储什么（仅在你登录时）",
      body: ["同一网络（局域网）内的会话无需账号。为浏览器或 CLI 跨网络会话创建配对码时，创建端必须登录；持码加入的一端无需账号。创建暂存下载链接同样需要登录。如果你登录，我们只存储运行账号所必需的最少信息："],
      bullets: [
        "你的邮箱地址和显示名。",
        "你使用的登录方式（通过 Apple 登录、Google、邮箱魔法链接，或邮箱+密码）。魔法链接令牌只以哈希形式存储，绝不明文保存；如果你设置了密码，我们只存储其 bcrypt 哈希值，绝不存储密码本身。如果你使用「通过 Apple 登录」并选择 Apple 的私密邮件转发，我们只会看到该转发地址。",
        "登录会话，保存在安全的 httpOnly cookie 中。",
        "你注册的设备，以一个随机设备 id 和设备名（例如你的平台名称）的形式。",
      ],
    },
    {
      heading: "暂存传输（下载链接）",
      body: [
        "使用可选的暂存下载链接功能时，文件在离开你的设备之前就已在本机以 AES-256-GCM 加密。所有能创建或打开这类链接的客户端都是如此：浏览器、命令行工具，以及我们的 macOS 与 iOS 原生 App，都在本地完成加解密，没有任何一方会上传服务器可读的内容。解密密钥仅存在于链接的 URL 片段（# 部分）中，绝不发送至服务器。这意味着：",
      ],
      bullets: [
        "服务器仅存储密文，无法读取你的文件内容、文件名或密钥。",
        "我们记录密文大小和时间戳（上传时间、有效期）用于配额管理和清理。",
        "密文在到期或首次完整下载（阅后即焚）时自动删除，以较早发生者为准。",
      ],
    },
    {
      heading: "我们无法读取的内容",
      body: ["以下内容不会以明文到达 Relayium 服务器，服务器也无法解密："],
      bullets: ["你的文件内容。", "你的文件名。", "你的实时文本消息正文。", "你的加密密钥。"],
    },
    {
      heading: "跨网络中继（TURN）",
      body: [
        "浏览器的跨网络文件与文本会话按设计使用 TURN。TURN 只承载端到端加密的密文和传输元数据。为执行配额并防止滥用，我们把中继字节总量与时间戳归属到配对码创建端的账号，但不检查消息或文件明文。CLI 文本仅直连，不使用 TURN，也不计入 TURN 用量。实时文本要求双方同时在线；Relayium 不提供离线投递或服务器端消息历史，但任一端都可能复制或保留收到的内容。",
      ],
    },
    {
      heading: "用量计量与配额",
      body: [
        "有付费套餐，服务就必须统计每个账号用了多少。在你登录期间，我们会按账号持续记录你经由 Relayium 上传和下载的字节量、你的暂存链接当前占用的密文大小，以及归属到你所创建配对码的中继字节总量。这些计数会在产生它们的那次传输结束后继续保留——我们按月以账号为单位保存这些累计值——因为正是它们在执行你套餐所含的用量、存储与中继配额，也是我们计费与账户记录的依据。付费订阅按套餐收取固定价格，不是按字节计费。",
      ],
      bullets: [
        "会记录的：字节量、暂存对象大小，以及测量发生的时间，并与你的账号关联。",
        "不会记录的：你的文件内容、文件名与消息正文始终加密，我们无法读取。除账号用量计量外，我们还保存三项第一方、无标识符的跨网络配对月度聚合动作数：成功铸码、某个有效码首次接纳连接，以及首次变为两个已接纳端。每项聚合只包含 UTC 月份、上述三个固定阶段之一和非负整数计数，绝不包含标识符、事件明细、精确时间戳或内容元数据。",
        "这三项产品交互总数是有界、尽力写入的动作数下界，不是独立用户数、同期群或精确转化率。页面上的比率只用同月动作总数相除，并不是同期群转化。我们的 App 与网站不含任何广告或第三方分析 SDK；这些聚合与账号用量计数都绝不会用于跨其他 App 或网站追踪你。",
        "你随时可以在 App 或网页的账号页面查看与自己账号关联的用量。无标识符聚合只显示在管理员总览中；数据库不按账号保存这些聚合，也不含将其连接到账号的字段。",
      ],
    },
    {
      heading: "Cookie 与本地存储",
      body: [
        "我们使用一个会话 cookie 来保持你的登录状态。在你浏览器的本地存储中，我们保存一个随机设备 id，以便识别你注册过的设备。我们不使用广告或追踪 cookie。",
      ],
    },
    {
      heading: "第三方服务",
      body: ["只有在你选择使用时，才会涉及少数第三方："],
      bullets: [
        "Google——如果你用 Google 登录，我们会获取你的邮箱和基本资料以创建账号。",
        "Apple——如果你使用「通过 Apple 登录」，我们会获取一个稳定标识符，以及你选择分享的邮箱（或 Apple 的私密转发地址）。",
        "Stripe——我们在网页端订阅的支付处理方，详见「支付」。",
        "Apple——在我们的 macOS 或 iOS App 内通过应用内购买订阅时的处理方，详见「支付」。",
        "邮件发送服务商——用于发送账号邮件，如魔法链接登录与验证邮件。",
      ],
    },
    {
      heading: "支付",
      body: [
        "只有在你购买付费套餐时才会涉及支付数据。我们绝不接收或存储你的完整卡号。",
      ],
      bullets: [
        "在网页端，支付由 Stripe 处理。卡片信息提交给 Stripe，而非我们；我们只拿到一个客户标识和由此产生的订阅状态。",
        "在我们的原生 App 内——macOS 与 iOS 同样如此——订阅是通过 Apple 应用内购买完成的，而不是向我们购买。Apple 从你的 Apple ID 处理支付，我们绝不会看到你的支付方式。App 会把 Apple 签名的交易记录发给我们，我们保存其中关于这笔购买的内容：你购买的订阅商品、Apple 为该订阅分配的标识符，以及订阅状态、计费周期与续订或到期日期。我们还会生成一个随机令牌，把 App Store 购买与你的 Relayium 账号关联起来；App 在购买时把该令牌交给 Apple，它再随签名交易回到我们这里——两边的记录就此对上，而双方都不会因此多知道你的任何其他信息。",
        "就你的账号而言，我们只存储你当前的套餐、订阅状态、计费周期、周期起止日期，以及支付服务商为该订阅提供的引用标识——绝不存储卡片数据。",
      ],
    },
    {
      heading: "macOS 与 iOS 上的 Relayium App",
      body: [
        "我们的原生 App 会处理少量网站不涉及的设备级数据，而且两个平台处理的数据并不相同。下面每一条都写明它描述的是哪个平台。",
      ],
      bullets: [
        "本设备在你账号中显示的标签。在 macOS 上，App 会读取 Mac「共享」设置中的电脑名称并作为该标签——使用邮箱与密码登录时随请求发送，便于你在账号中区分各台设备并注销其中一台；在同一网络配对时，也会公布给同一房间内的其他设备。macOS 通常会以你的全名生成该名称，因此重命名这台 Mac 就会改变发送出去的内容。在 iOS 上，这个标签是通用的，绝不会是你自己起的名字：App 读取硬件型号后只发送设备族——「iPhone」「iPad」或「iPod touch」——除此之外别无内容，发送场合与上述两处相同。因此不会有任何个人姓名经由这条路径从 iPhone 或 iPad 到达我们。",
        "安装标识符，仅限 macOS。它是 App 在那台 Mac 上生成的 32 字节随机值，保存在本机钥匙串中，通过浏览器登录时发送，使你重新登录后回到这台 Mac 已有的设备条目，而不是新增一条。它是随机的，绝不由硬件推导——不含序列号、MAC 地址或主机名——因此它只标识某一次安装，而不透露这台机器的任何信息。iOS App 没有需要接续的浏览器登录流程，因此不会生成这样的标识符：目前它既不向我们发送安装标识符，也不发送任何从设备本身读取的标识符。你账号设备列表中的随机设备 id 是我们为你的账号签发的（见上文），并非由你的手机推导而来。",
        "这些 App 不做的事。两者都不注册推送令牌，也都不接收推送通知：在 macOS 上，传输完成或收件箱有新投递，都由 macOS 在那台 Mac 本地提示，且这些横幅刻意不含文件名、链接或配对码；而 iOS App 根本不具备推送能力，也不会向 Apple 的推送服务注册任何东西。iOS App 申请摄像头只有一个用途——读取另一台设备正在显示的配对二维码，免得你手动输入加入码——而且这完全发生在你的设备上：画面及其中的配对码当场用于加入这次配对，摄像头看到的任何内容都不会被 App 保存，也不会作为摄像头数据发送给我们。macOS App 完全不申请摄像头权限；两个 App 也都没有你相册的访问权限：在 iOS 上选择要发送的照片时，是系统自带的选择器在 App 之外运行，只把你选中的项目交给 App。两个 App 都不会跨其他 App 或网站追踪你，也都不含广告或第三方分析 SDK。",
      ],
    },
    {
      heading: "数据保留与删除",
      body: [
        "账号数据在你的账号存在期间保留。你可以随时在账号设置中（网页或 App 内）删除你的账号及其数据。删除会进入 30 天宽限期，期间你可重新登录撤销；之后你的账号及个人数据将被永久移除。因计费和防滥用而必须保留的汇总用量计数会被匿名化，不再与你关联。",
      ],
    },
    {
      heading: "你的权利",
      body: [
        "你可以访问、更正、导出或删除你的账号数据，并可反对或限制某些处理。其中大部分你可以自行在账号设置中完成；其他事项请发邮件至 support@relayium.com。我们不出售你的个人数据。在适用 GDPR 或类似法律的情况下，我们处理这少量数据的依据是履行你所请求的服务，以及我们在保障其安全、防止滥用方面的合法利益。",
      ],
    },
    {
      heading: "儿童",
      body: [
        "Relayium 并非面向儿童。我们不会在知情的情况下收集 13 岁以下（或你所在地数字同意最低年龄以下）任何人的个人数据。如果你认为有儿童向我们提供了数据，请联系 support@relayium.com，我们会将其删除。",
      ],
    },
    {
      heading: "本政策的变更",
      body: ["随着服务演进，我们可能会更新本政策。届时我们会更新上方的「最后更新」日期。"],
    },
    {
      heading: "联系我们",
      body: ["有隐私方面的疑问？请发邮件至 support@relayium.com。"],
    },
  ],
};

const ja = {
  title: "プライバシーポリシー",
  description:
    "Relayium がファイルと一時テキストを扱う方法：コンテンツはエンドツーエンド暗号化され、Relayium はライブメッセージ本文を保存せず、一時保存ダウンロードリンクのファイルはゼロ知識暗号化されます。",
  updatedLabel: "最終更新",
  updated: "2026-08-13",
  otherDocLabel: "利用規約",
  lead: [
    "Relayium はファイルと一時テキストがお客様のものであり続けるよう設計されています。ブラウザのローカルセッションは直接接続し、ネットワークをまたぐブラウザセッションは TURN 経由でエンドツーエンド暗号化された暗号文を運ぶ場合があります。CLI テキストは直接接続のみで、一時保存リンクにはゼロ知識暗号化されたファイル暗号文だけが保存されます。",
    "このページでは、本サービスが実際に扱う少量のデータと、意図的に取得しないデータについて説明します。",
  ],
  sections: [
    {
      heading: "ローカルネットワークのコンテンツは保存されません",
      body: [
        "同じネットワーク上でファイルを転送またはテキストを交換する場合、アカウントは不要で、Relayium はコンテンツを保存しません。デバイスを直接接続するため、シグナリングサービスは IP アドレス、ルーム参加、デバイス名、プレゼンス、機能、WebRTC 交渉などの接続メタデータを一時的に処理します。",
      ],
    },
    {
      heading: "アカウントに保存される情報（サインインした場合のみ）",
      body: [
        "同一ネットワーク（LAN）のセッションはアカウント不要です。ブラウザまたは CLI のクロスネットワークセッション用ペアリングコードを作成する側はサインインが必要ですが、コードで参加する側はアカウント不要です。保存型ダウンロードリンクの作成にもサインインが必要です。サインインした場合、アカウントの運用に必要な最小限の情報のみを保存します：",
      ],
      bullets: [
        "メールアドレスと表示名。",
        "使用したサインイン方法（Apple でサインイン、Google、メールマジックリンク、またはメール+パスワード）。マジックリンクのトークンはハッシュ値のみ保存され、平文では保存されません。パスワードを設定した場合も、その bcrypt ハッシュのみを保存し、パスワード自体は保存しません。Apple のプライベートメールリレーを使用して「Apple でサインイン」した場合、当社が把握するのはそのリレーアドレスのみです。",
        "ログインセッション。安全な httpOnly クッキーに保存されます。",
        "登録したデバイス。ランダムなデバイス ID とデバイス名（例：プラットフォーム名）で管理されます。",
      ],
    },
    {
      heading: "一時保存転送（ダウンロードリンク）",
      body: [
        "オプションの一時保存ダウンロードリンク機能を使用する場合、ファイルはデバイスから送信される前にブラウザで AES-256-GCM 暗号化されます。復号キーは URL フラグメント（# 部分）にのみ存在し、サーバーには送信されません。つまり、次のとおりです。",
      ],
      bullets: [
        "サーバーは暗号文のみを保存します。ファイルの内容、ファイル名、キーを読み取ることはできません。",
        "クォータ管理とクリーンアップのために、暗号文サイズとタイムスタンプ（アップロード時刻、有効期限）を記録します。",
        "暗号文は有効期限切れまたは最初の完全なダウンロード（閲覧後削除）のいずれか早い方で自動削除されます。",
      ],
    },
    {
      heading: "当社が読み取れないコンテンツ",
      body: ["以下は平文で Relayium サーバーに届かず、サーバーは復号できません："],
      bullets: [
        "ファイルの内容。",
        "ファイルの名前。",
        "ライブテキストメッセージの本文。",
        "暗号化キー。",
      ],
    },
    {
      heading: "クロスネットワーク中継（TURN）",
      body: [
        "ブラウザのクロスネットワークのファイルおよびテキストセッションは設計上 TURN を使用します。TURN が運ぶのはエンドツーエンド暗号化された暗号文と転送メタデータのみです。クォータと不正利用防止のため、中継バイト合計とタイムスタンプをコード作成者のアカウントに関連付けますが、メッセージやファイルの平文は検査しません。CLI テキストは直接接続のみで TURN を使用せず、TURN 使用量にも算入されません。ライブテキストには双方のオンラインが必要で、Relayium はオフライン配信やサーバー側履歴を提供しませんが、各端末は受信内容をコピーまたは保持できます。",
      ],
    },
    {
      heading: "利用量の計測とクォータ",
      body: [
        "有料プランがある以上、各アカウントがサービスをどれだけ使ったかを数える必要があります。サインイン中は、Relayium を通じてアップロード・ダウンロードしたバイト量、一時保存リンクが保持している暗号文のサイズ、そしてお客様が作成したペアリングコードに帰属する中継バイトの合計を、アカウント単位で継続的に記録します。これらのカウンターは、それを生んだ転送が終わったあとも月ごとのアカウント別合計として保持されます。プランに含まれる利用量・保存容量・中継のクォータを適用し、当社の請求とアカウントの記録が拠って立つのがこれらだからです。有料サブスクリプションはプランごとの定額であり、バイト単位の従量課金ではありません。",
      ],
      bullets: [
        "記録するもの：バイト量、一時保存オブジェクトのサイズ、そして計測された時刻で、いずれもお客様のアカウントに紐づきます。",
        "記録しないもの：ファイルの内容、ファイル名、メッセージ本文は暗号化されたままで当社は読み取れません。どの画面を開いたか、どの機能を使ったかも記録しません。",
        "これは計測であり、分析ではありません。当社のアプリとウェブサイトに広告や第三者の分析 SDK は含まれず、これらのカウンターを他のアプリやウェブサイトをまたぐ追跡に使うことは一切ありません。",
        "現在の利用量は、アプリまたはウェブのアカウントページでいつでも確認できます。",
      ],
    },
    {
      heading: "Cookie とローカルストレージ",
      body: [
        "サインイン状態を維持するために 1 つのセッション Cookie を使用します。ブラウザのローカルストレージには、登録済みデバイスを識別するためのランダムなデバイス ID を保存します。広告用または追跡用の Cookie は使用しません。",
      ],
    },
    {
      heading: "第三者サービス",
      body: ["お客様が利用を選択した場合にのみ、一部の第三者が関与します："],
      bullets: [
        "Google——Google でサインインする場合、アカウント作成のためにメールアドレスと基本プロフィール情報を受け取ります。",
        "Apple——「Apple でサインイン」を使用する場合、安定した識別子と、お客様が共有を選択したメールアドレス（または Apple のプライベートリレーアドレス）を受け取ります。",
        "Stripe——ウェブで購入したサブスクリプションの決済処理業者です。詳しくは「支払い」をご覧ください。",
        "Apple——iOS および macOS アプリ内でアプリ内課金により購入したサブスクリプションについて。詳しくは「支払い」をご覧ください。",
        "メール配信プロバイダー——マジックリンクのサインインや確認メールなど、アカウント関連メールの送信に使用します。",
      ],
    },
    {
      heading: "支払い",
      body: [
        "有料プランを購入した場合にのみ、支払いに関するデータが共有されます。当社がカード番号の全体を受け取ったり保存したりすることは一切ありません。",
      ],
      bullets: [
        "ウェブでは、支払いは Stripe が処理します。カード情報は当社ではなく Stripe に送られます。当社が受け取るのは顧客参照情報と、その結果としてのサブスクリプション状況のみです。",
        "iOS および macOS アプリでは、サブスクリプションは Apple のアプリ内課金を通じて購入されます。Apple がお客様の Apple ID のもとで支払いを処理し、当社がお支払い方法を見ることはありません。アプリは Apple が署名した取引記録を当社に送信し、当社はその購入について記載された内容——購入したサブスクリプション商品、そのサブスクリプションに対する Apple の識別子、状況、請求期間、更新日または有効期限——を保存します。また、App Store での購入をお客様の Relayium アカウントに結び付けるためのランダムなトークンを生成します。",
        "アカウントについて当社が保存するのは、現在のプラン、サブスクリプションの状況、請求サイクル、期間の日付、および決済事業者がそのサブスクリプションに付与する参照情報のみであり、カード情報は一切保存しません。",
      ],
    },
    {
      heading: "Relayium アプリ",
      body: [
        "当社のネイティブアプリは、ウェブサイトでは扱わない、デバイスレベルの小さなデータを扱います：",
      ],
      bullets: [
        "プッシュ通知：有効にした場合、デバイスに通知を配信できるよう、Apple Push Notification service（APNs）のデバイストークンを保存します。通知はいつでもデバイスの設定でオフにできます。",
        "カメラと写真：QR コードのスキャンや送信するファイルの選択のためにのみ、デバイス上で使用されます。お客様が意図的に転送を選んだファイル以外、カメラやライブラリから何も取得・アップロードされません。",
        "アプリは他のアプリやウェブサイトを横断してお客様を追跡することはなく、広告や第三者の分析 SDK も含まれていません。",
      ],
    },
    {
      heading: "データの保持と削除",
      body: [
        "アカウントデータはアカウントが存在する間保持されます。アカウントとそのデータは、アプリまたはウェブのアカウント設定からいつでもご自身で削除できます。削除を行うと 30 日間の猶予期間が始まり、その間に再度サインインすることで取り消すことができます。その後、アカウントと個人データは完全に削除されます。課金と不正利用防止のために保持が必要な集計利用カウンターは匿名化され、お客様と紐づかなくなります。",
      ],
    },
    {
      heading: "お客様の権利",
      body: [
        "お客様は、ご自身のアカウントデータへのアクセス、訂正、エクスポート、削除を求めることができ、また特定の処理に異議を唱えたり制限を求めたりすることもできます。その大半はアカウント設定でご自身で行えます。それ以外については support@relayium.com までメールでご連絡ください。当社はお客様の個人データを販売しません。GDPR または類似の法律が適用される場合、当社がこの少量のデータを処理する法的根拠は、お客様が依頼したサービスの提供、および安全性の確保と不正利用の防止という当社の正当な利益です。",
      ],
    },
    {
      heading: "子どもについて",
      body: [
        "Relayium は子ども向けのサービスではありません。当社は、13 歳未満、またはお住まいの地域におけるデジタル同意の最低年齢未満の方から、意図的に個人データを収集することはありません。お子様が当社にデータを提供したと思われる場合は、support@relayium.com までご連絡ください。速やかに削除します。",
      ],
    },
    {
      heading: "このポリシーの変更",
      body: [
        "サービスの進化に伴い、このポリシーを更新することがあります。更新した場合は、上記の「最終更新」日付を変更します。",
      ],
    },
    {
      heading: "お問い合わせ",
      body: ["プライバシーに関するご質問は、support@relayium.com までメールでお問い合わせください。"],
    },
  ],
};

const ko = {
  title: "개인정보 처리방침",
  description:
    "Relayium이 파일과 임시 텍스트를 처리하는 방식: 콘텐츠는 종단간 암호화되고, Relayium은 실시간 메시지 본문을 저장하지 않으며, 임시 다운로드 링크의 파일은 영지식 암호화됩니다.",
  updatedLabel: "최종 업데이트",
  updated: "2026-08-13",
  otherDocLabel: "이용약관",
  lead: [
    "Relayium은 파일과 임시 텍스트가 사용자의 것으로 남도록 설계되었습니다. 브라우저의 로컬 세션은 직접 연결되고, 네트워크 간 브라우저 세션은 TURN을 통해 종단간 암호화된 암호문을 전송할 수 있습니다. CLI 텍스트는 직접 연결만 사용하며, 임시 다운로드 링크에는 영지식 암호화된 파일 암호문만 저장됩니다.",
    "이 페이지에서는 서비스가 실제로 처리하는 소량의 데이터와 의도적으로 수집하지 않는 데이터를 설명합니다.",
  ],
  sections: [
    {
      heading: "로컬 네트워크 콘텐츠는 저장되지 않습니다",
      body: [
        "같은 네트워크에서 파일을 전송하거나 텍스트를 교환할 때는 계정이 필요 없고 Relayium은 콘텐츠를 저장하지 않습니다. 기기를 직접 연결하기 위해 시그널링 서비스는 IP 주소, 방 참여, 기기 이름, 접속 상태, 기능 및 WebRTC 협상 같은 연결 메타데이터를 일시적으로 처리합니다.",
      ],
    },
    {
      heading: "계정에 저장되는 정보(로그인한 경우에만)",
      body: [
        "동일 네트워크(LAN) 세션은 계정이 필요 없습니다. 브라우저 또는 CLI 네트워크 간 세션의 페어링 코드를 만드는 쪽은 로그인해야 하지만, 코드를 가지고 참여하는 쪽은 계정이 필요 없습니다. 저장형 다운로드 링크를 만드는 데도 로그인이 필요합니다. 로그인하면 계정 운영에 필요한 최소한의 정보만 저장합니다:",
      ],
      bullets: [
        "이메일 주소와 표시 이름.",
        "사용한 로그인 방식(Apple로 로그인, Google, 이메일 매직 링크, 또는 이메일+비밀번호). 매직 링크 토큰은 해시값으로만 저장되며 평문으로는 저장되지 않습니다. 비밀번호를 설정한 경우에도 bcrypt 해시값만 저장하며 비밀번호 자체는 저장하지 않습니다. Apple의 비공개 이메일 릴레이와 함께 ‘Apple로 로그인’을 사용하는 경우, 저희는 해당 릴레이 주소만 확인합니다.",
        "로그인 세션. 안전한 httpOnly 쿠키에 보관됩니다.",
        "등록한 기기. 임의 기기 ID와 기기 이름(예: 플랫폼 이름)으로 관리됩니다.",
      ],
    },
    {
      heading: "임시 보관 전송(다운로드 링크)",
      body: [
        "선택적 임시 보관 다운로드 링크 기능을 사용하면 파일이 기기를 떠나기 전에 브라우저에서 AES-256-GCM으로 암호화됩니다. 복호화 키는 URL 프래그먼트(# 부분)에만 존재하며 서버로 전송되지 않습니다. 이는 다음을 의미합니다:",
      ],
      bullets: [
        "서버는 암호문만 저장합니다. 파일 내용, 파일 이름, 키를 읽을 수 없습니다.",
        "할당량 관리 및 정리를 위해 암호문 크기와 타임스탬프(업로드 시간, 만료 시간)를 기록합니다.",
        "암호문은 만료 시 또는 첫 번째 완전한 다운로드(열람 후 삭제) 중 먼저 발생하는 시점에 자동 삭제됩니다.",
      ],
    },
    {
      heading: "저희가 읽을 수 없는 콘텐츠",
      body: ["다음 내용은 평문으로 Relayium 서버에 도달하지 않으며 서버는 이를 복호화할 수 없습니다:"],
      bullets: [
        "파일 내용.",
        "파일 이름.",
        "실시간 텍스트 메시지 본문.",
        "암호화 키.",
      ],
    },
    {
      heading: "크로스 네트워크 릴레이(TURN)",
      body: [
        "브라우저의 네트워크 간 파일 및 텍스트 세션은 설계상 TURN을 사용합니다. TURN은 종단간 암호화된 암호문과 전송 메타데이터만 운반합니다. 할당량 적용과 남용 방지를 위해 중계 바이트 합계와 타임스탬프를 코드 생성자의 계정에 연결하지만, 메시지나 파일 평문은 검사하지 않습니다. CLI 텍스트는 직접 연결만 사용하며 TURN을 사용하거나 TURN 사용량에 포함되지 않습니다. 실시간 텍스트에는 양쪽이 동시에 온라인이어야 하며 Relayium은 오프라인 전송이나 서버 측 메시지 기록을 제공하지 않지만, 각 엔드포인트는 받은 내용을 복사하거나 보관할 수 있습니다.",
      ],
    },
    {
      heading: "사용량 측정 및 할당량",
      body: [
        "유료 요금제가 있는 이상 각 계정이 서비스를 얼마나 사용했는지 집계해야 합니다. 로그인해 있는 동안 저희는 Relayium을 통해 업로드·다운로드한 바이트 양, 임시 보관 링크가 보유 중인 암호문의 크기, 그리고 귀하가 만든 페어링 코드에 귀속된 릴레이 바이트 총량을 계정 단위로 계속 기록합니다. 이 카운터는 이를 만들어낸 전송이 끝난 뒤에도 계정별 월간 합계로 보존됩니다. 요금제에 포함된 사용량·저장 용량·릴레이 할당량을 적용하고, 저희의 청구 및 계정 기록이 근거로 삼는 값이 바로 이것이기 때문입니다. 유료 구독은 요금제별 정액이며, 바이트 단위 종량 과금이 아닙니다.",
      ],
      bullets: [
        "기록하는 것: 바이트 양, 임시 보관 객체의 크기, 그리고 측정된 시각이며 모두 귀하의 계정에 연결됩니다.",
        "기록하지 않는 것: 파일 내용, 파일 이름, 메시지 본문은 암호화된 상태로 남아 저희가 읽을 수 없으며, 어떤 화면을 열었는지나 어떤 기능을 사용했는지도 기록하지 않습니다.",
        "이는 측정이지 분석이 아닙니다. 저희 앱과 웹사이트에는 광고나 제3자 분석 SDK가 없으며, 이 카운터를 다른 앱이나 웹사이트에서 귀하를 추적하는 데 사용하는 일은 없습니다.",
        "현재 사용량은 앱이나 웹의 계정 페이지에서 언제든지 확인할 수 있습니다.",
      ],
    },
    {
      heading: "쿠키 및 로컬 스토리지",
      body: [
        "로그인 상태를 유지하기 위해 세션 쿠키 하나를 사용합니다. 브라우저의 로컬 스토리지에는 등록된 기기를 식별하기 위한 임의 기기 ID를 저장합니다. 광고 또는 추적 쿠키는 사용하지 않습니다.",
      ],
    },
    {
      heading: "제3자 서비스",
      body: ["사용자가 선택하여 사용하는 경우에만 일부 제3자가 관여합니다:"],
      bullets: [
        "Google — Google로 로그인하는 경우, 계정 생성을 위해 이메일 주소와 기본 프로필 정보를 받습니다.",
        "Apple — ‘Apple로 로그인’을 사용하는 경우, 고정된 식별자와 사용자가 공유하기로 선택한 이메일(또는 Apple의 비공개 릴레이 주소)을 받습니다.",
        "Stripe — 웹에서 구매한 구독의 결제 처리업체입니다. 자세한 내용은 ‘결제’를 참고하세요.",
        "Apple — iOS 및 macOS 앱 내 인앱 구매로 구매한 구독에 대해서입니다. 자세한 내용은 ‘결제’를 참고하세요.",
        "이메일 발송 서비스 제공업체 — 매직 링크 로그인, 인증 등 계정 관련 이메일 전송에 사용됩니다.",
      ],
    },
    {
      heading: "결제",
      body: [
        "유료 플랜을 구매하는 경우에만 결제 데이터를 공유하게 됩니다. 저희는 카드 전체 번호를 받거나 저장하지 않습니다.",
      ],
      bullets: [
        "웹에서는 결제가 Stripe를 통해 처리됩니다. 카드 정보는 저희가 아닌 Stripe로 전달되며, 저희는 고객 참조 정보와 그 결과로 나온 구독 상태만 받습니다.",
        "iOS 및 macOS 앱에서는 Apple 인앱 구매를 통해 구독을 구매합니다. Apple이 사용자의 Apple ID로 결제를 처리하며, 저희는 결제 수단을 볼 수 없습니다. 앱은 Apple이 서명한 거래 기록을 저희에게 전송하고, 저희는 그 기록이 해당 구매에 대해 말하는 내용, 즉 구매한 구독 상품, 그 구독에 대한 Apple의 식별자, 상태, 결제 주기, 갱신일 또는 만료일을 보관합니다. 또한 App Store 구매를 사용자의 Relayium 계정에 연결하는 무작위 토큰을 생성합니다.",
        "계정과 관련하여 저희는 현재 플랜, 구독 상태, 결제 주기, 기간 날짜, 그리고 결제 제공업체가 해당 구독에 부여한 참조 값만 저장하며 카드 데이터는 절대 저장하지 않습니다.",
      ],
    },
    {
      heading: "Relayium 앱",
      body: [
        "저희 네이티브 앱은 웹사이트에서는 다루지 않는 소량의 기기 수준 데이터를 처리합니다:",
      ],
      bullets: [
        "푸시 알림: 활성화하면 기기에 알림을 전달할 수 있도록 Apple Push Notification service(APNs) 기기 토큰을 저장합니다. 알림은 언제든지 기기 설정에서 끌 수 있습니다.",
        "카메라 및 사진: QR 코드를 스캔하거나 전송할 파일을 선택하는 용도로만 기기에서 사용됩니다. 사용자가 의도적으로 전송을 선택한 파일을 제외하고는 카메라나 라이브러리에서 어떤 것도 캡처되거나 업로드되지 않습니다.",
        "앱은 다른 앱이나 웹사이트에서 사용자를 추적하지 않으며, 광고나 제3자 분석 SDK를 포함하지 않습니다.",
      ],
    },
    {
      heading: "데이터 보존 및 삭제",
      body: [
        "계정 데이터는 계정이 존재하는 동안 보존됩니다. 앱 또는 웹의 계정 설정에서 언제든지 직접 계정과 그 데이터를 삭제할 수 있습니다. 삭제를 시작하면 30일의 유예 기간이 시작되며, 이 기간 동안 다시 로그인하면 취소할 수 있습니다. 그 이후에는 계정과 개인 데이터가 영구적으로 제거됩니다. 청구 및 남용 방지를 위해 보관해야 하는 집계 사용량 카운터는 익명화되어 더 이상 사용자와 연결되지 않습니다.",
      ],
    },
    {
      heading: "귀하의 권리",
      body: [
        "귀하는 자신의 계정 데이터에 접근, 정정, 내보내기, 삭제를 요청할 수 있으며, 특정 처리에 반대하거나 제한을 요청할 수 있습니다. 대부분은 계정 설정에서 직접 하실 수 있으며, 그 외의 사항은 support@relayium.com으로 이메일을 보내주세요. 저희는 귀하의 개인정보를 판매하지 않습니다. GDPR 또는 유사 법률이 적용되는 경우, 저희가 이 소량의 데이터를 처리하는 근거는 귀하가 요청한 서비스를 제공하는 것과, 보안 유지 및 남용 방지에 대한 저희의 정당한 이익입니다.",
      ],
    },
    {
      heading: "아동",
      body: [
        "Relayium은 아동을 대상으로 하지 않습니다. 저희는 13세 미만이거나 거주 지역의 디지털 동의 최소 연령 미만인 사람의 개인정보를 고의로 수집하지 않습니다. 아동이 저희에게 정보를 제공했다고 생각되시면 support@relayium.com으로 연락해 주시면 삭제해 드리겠습니다.",
      ],
    },
    {
      heading: "이 방침의 변경",
      body: [
        "서비스가 발전함에 따라 이 방침을 업데이트할 수 있습니다. 업데이트 시 위의 ‘최종 업데이트’ 날짜를 변경합니다.",
      ],
    },
    {
      heading: "문의",
      body: ["개인정보에 관한 질문이 있으시면 support@relayium.com으로 이메일을 보내주세요."],
    },
  ],
};

const de = {
  title: "Datenschutzerklärung",
  description:
    "Wie Relayium Dateien und temporären Text behandelt: Inhalte sind Ende-zu-Ende-verschlüsselt, Relayium speichert keine Live-Nachrichtentexte und Dateien in Download-Links bleiben Zero-Knowledge-verschlüsselt.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-08-13",
  otherDocLabel: "Nutzungsbedingungen",
  lead: [
    "Relayium ist so konzipiert, dass Ihre Dateien und temporären Texte Ihnen gehören. Lokale Browsersitzungen sind direkt; netzwerkübergreifende Browsersitzungen können Ende-zu-Ende-verschlüsselten Chiffretext über TURN übertragen; CLI-Text ist ausschließlich direkt; Download-Links speichern nur Zero-Knowledge-verschlüsselten Datei-Chiffretext.",
    "Diese Seite erläutert, mit welchen wenigen Daten der Dienst tatsächlich umgeht und welche Daten er bewusst nie einsieht.",
  ],
  sections: [
    {
      heading: "Inhalte im lokalen Netzwerk werden nicht gespeichert",
      body: [
        "Wenn Sie im selben Netzwerk Dateien übertragen oder Text austauschen, ist kein Konto nötig und Relayium speichert die Inhalte nicht. Damit sich die Geräte direkt verbinden können, verarbeitet der Signalisierungsdienst vorübergehend Verbindungsmetadaten wie IP-Adressen, Raumteilnahme, Gerätenamen, Anwesenheit, Fähigkeiten und WebRTC-Aushandlung.",
      ],
    },
    {
      heading: "Was ein Konto speichert (nur wenn Sie angemeldet sind)",
      body: [
        "Sitzungen im selben Netzwerk (LAN) benötigen kein Konto. Wer einen Pairing-Code für eine netzwerkübergreifende Browser- oder CLI-Sitzung erstellt, muss sich anmelden; wer mit dem Code beitritt, benötigt kein Konto. Auch das Erstellen eines gespeicherten Download-Links erfordert eine Anmeldung. Bei einer Anmeldung speichern wir nur das für den Kontobetrieb notwendige Minimum:",
      ],
      bullets: [
        "Ihre E-Mail-Adresse und ein Anzeigename.",
        "Die verwendete Anmeldemethode (Anmelden mit Apple, Google, ein E-Mail-Magic-Link oder E-Mail + Passwort). Magic-Link-Tokens werden ausschließlich als Hash gespeichert, niemals im Klartext; falls Sie ein Passwort festlegen, speichern wir nur dessen bcrypt-Hash, niemals das Passwort selbst. Wenn Sie „Anmelden mit Apple“ mit Apples privater E-Mail-Weiterleitung nutzen, sehen wir ausschließlich diese Weiterleitungsadresse.",
        "Eine Anmeldesitzung, gespeichert in einem sicheren httpOnly-Cookie.",
        "Registrierte Geräte, bestehend aus einer zufälligen Geräte-ID und einem Gerätenamen (z. B. Ihr Plattformname).",
      ],
    },
    {
      heading: "Zwischengespeicherte Übertragung (Download-Links)",
      body: [
        "Wenn Sie den optionalen Modus für zwischengespeicherte Download-Links nutzen, verschlüsselt Ihr Browser die Dateien mit AES-256-GCM, bevor sie Ihr Gerät verlassen. Der Entschlüsselungsschlüssel befindet sich ausschließlich im URL-Fragment (nach dem #) und wird nie an den Server gesendet. Das bedeutet:",
      ],
      bullets: [
        "Der Server speichert ausschließlich Chiffretext. Er kann Ihre Dateiinhalte, Dateinamen oder Schlüssel nicht lesen.",
        "Wir erfassen die Chiffretextgröße und Zeitstempel (Upload-Zeitpunkt, Ablaufzeit) für Kontingentverwaltung und Bereinigung.",
        "Der Chiffretext wird automatisch gelöscht, wenn er abläuft oder beim ersten vollständigen Download (Burn-after-read) — je nachdem, was zuerst eintritt.",
      ],
    },
    {
      heading: "Inhalte, die wir nicht lesen können",
      body: ["Folgendes erreicht Relayium-Server nie im Klartext und kann von ihnen nicht entschlüsselt werden:"],
      bullets: [
        "Den Inhalt Ihrer Dateien.",
        "Die Namen Ihrer Dateien.",
        "Den Inhalt Ihrer Live-Textnachrichten.",
        "Ihre Verschlüsselungsschlüssel.",
      ],
    },
    {
      heading: "Netzwerkübergreifende Weiterleitung (TURN)",
      body: [
        "Netzwerkübergreifende Datei- und Textsitzungen im Browser verwenden konstruktionsbedingt TURN. TURN transportiert nur Ende-zu-Ende-verschlüsselten Chiffretext und Transportmetadaten. Für Kontingente und Missbrauchsschutz ordnen wir Gesamtzahl und Zeitstempel der weitergeleiteten Bytes dem Konto der Code-Erstellung zu, ohne Nachrichten- oder Datei-Klartext zu prüfen. CLI-Text ist ausschließlich direkt, verwendet kein TURN und zählt nicht zur TURN-Nutzung. Live-Text setzt voraus, dass beide Seiten online sind; Relayium bietet keine Offline-Zustellung oder serverseitige Nachrichtenhistorie, aber beide Endpunkte können empfangene Inhalte kopieren oder behalten.",
      ],
    },
    {
      heading: "Nutzungsmessung und Kontingente",
      body: [
        "Kostenpflichtige Tarife bedeuten, dass der Dienst zählen muss, wie viel jedes Konto von ihm nutzt. Solange Sie angemeldet sind, führen wir pro Konto eine laufende Aufzeichnung der Bytes, die Sie über Relayium hoch- und herunterladen, der Größe des Geheimtexts, den Ihre zwischengespeicherten Links halten, und der weitergeleiteten Bytes, die den von Ihnen erstellten Kopplungscodes zugerechnet werden. Diese Zähler überdauern die Übertragung, die sie erzeugt hat — wir bewahren sie als monatliche Summen pro Konto auf —, denn sie sind es, was die in Ihrem Tarif enthaltenen Kontingente für Nutzung, Speicher und Weiterleitung durchsetzt und worauf unsere Abrechnungs- und Kontounterlagen beruhen. Ein kostenpflichtiges Abonnement hat einen festen Tarifpreis und wird nicht nach Bytes abgerechnet.",
      ],
      bullets: [
        "Was erfasst wird: Byte-Mengen, Größen zwischengespeicherter Objekte und die Zeitpunkte der Messung, jeweils mit Ihrem Konto verknüpft.",
        "Was nicht: Ihre Dateiinhalte, Dateinamen und Nachrichtentexte bleiben verschlüsselt und für uns unlesbar, und wir erfassen nicht, welche Bildschirme Sie öffnen oder welche Funktionen Sie nutzen.",
        "Das ist Messung, keine Analyse. Unsere Apps und unsere Website enthalten kein Werbe- oder Drittanbieter-Analyse-SDK, und diese Zähler werden nie dazu verwendet, Sie über andere Apps oder Websites hinweg zu verfolgen.",
        "Ihre aktuellen Werte können Sie jederzeit auf Ihrer Kontoseite einsehen, in der App oder im Web.",
      ],
    },
    {
      heading: "Cookies und lokaler Speicher",
      body: [
        "Wir verwenden ein Sitzungs-Cookie, um Sie angemeldet zu halten. Im lokalen Speicher Ihres Browsers speichern wir eine zufällige Geräte-ID, damit ein von Ihnen registriertes Gerät wiedererkannt werden kann. Wir verwenden keine Werbe- oder Tracking-Cookies.",
      ],
    },
    {
      heading: "Drittanbieterdienste",
      body: ["Einige Drittanbieter sind nur dann beteiligt, wenn Sie sich entscheiden, sie zu nutzen:"],
      bullets: [
        "Google, wenn Sie sich mit Google anmelden — wir erhalten Ihre E-Mail-Adresse und Ihr Basisprofil, um das Konto zu erstellen.",
        "Apple, wenn Sie „Anmelden mit Apple“ nutzen — wir erhalten eine stabile Kennung sowie die E-Mail-Adresse (oder Apples private Weiterleitungsadresse), die Sie zu teilen wählen.",
        "Stripe, unser Zahlungsdienstleister für über das Web erworbene Abonnements — siehe Zahlungen.",
        "Apple, für Abonnements, die über In-App-Käufe in unseren iOS- und macOS-Apps erworben werden — siehe Zahlungen.",
        "Ein E-Mail-Versanddienstleister, um kontobezogene E-Mails wie Magic-Link-Anmeldungen und Verifizierungen zu versenden.",
      ],
    },
    {
      heading: "Zahlungen",
      body: [
        "Sie geben Zahlungsdaten nur weiter, wenn Sie einen kostenpflichtigen Plan kaufen. Wir erhalten oder speichern niemals Ihre vollständige Kartennummer.",
      ],
      bullets: [
        "Im Web werden Zahlungen von Stripe abgewickelt. Kartendaten gehen an Stripe, nicht an uns; wir erhalten nur eine Kundenreferenz und den daraus resultierenden Abonnementstatus.",
        "In unseren iOS- und macOS-Apps werden Abonnements über den In-App-Kauf von Apple erworben. Apple verarbeitet die Zahlung unter Ihrer Apple-ID, und wir sehen Ihr Zahlungsmittel niemals. Die App sendet uns Apples signierten Transaktionsdatensatz, und wir speichern, was er über den Kauf aussagt: welches Abonnementprodukt Sie gekauft haben, Apples Kennung für dieses Abonnement sowie dessen Status, Abrechnungszeitraum und Verlängerungs- bzw. Ablaufdaten. Außerdem erzeugen wir ein zufälliges Token, das einen App-Store-Kauf mit Ihrem Relayium-Konto verknüpft.",
        "Für Ihr Konto speichern wir nur Ihren aktuellen Plan, den Abonnementstatus, den Abrechnungszyklus, die Zeitraumdaten und die Referenz Ihres Zahlungsdienstleisters für das Abonnement — niemals Kartendaten.",
      ],
    },
    {
      heading: "Die Relayium-App",
      body: [
        "Unsere nativen Apps verarbeiten einige wenige geräteseitige Daten, die die Website nicht verarbeitet:",
      ],
      bullets: [
        "Push-Benachrichtigungen: Wenn Sie diese aktivieren, speichern wir ein Gerätetoken des Apple Push Notification service (APNs), damit wir Benachrichtigungen an Ihr Gerät zustellen können. Sie können Benachrichtigungen jederzeit in den Geräteeinstellungen deaktivieren.",
        "Kamera und Fotos: werden ausschließlich auf Ihrem Gerät verwendet, um einen QR-Code zu scannen oder Dateien zum Versenden auszuwählen. Aus der Kamera oder Ihrer Bibliothek wird nichts erfasst oder hochgeladen außer den Dateien, die Sie bewusst zum Übertragen auswählen.",
        "Die App verfolgt Sie nicht über andere Apps oder Websites hinweg und enthält keine Werbe- oder Drittanbieter-Analyse-SDKs.",
      ],
    },
    {
      heading: "Datenspeicherung und Löschung",
      body: [
        "Kontodaten werden gespeichert, solange Ihr Konto besteht. Sie können Ihr Konto und die zugehörigen Daten jederzeit selbst in den Kontoeinstellungen löschen, in der App oder im Web. Die Löschung startet eine 30-tägige Karenzzeit, innerhalb derer Sie sie durch erneutes Anmelden rückgängig machen können; danach werden Ihr Konto und Ihre personenbezogenen Daten dauerhaft entfernt. Aggregierte Nutzungszähler, die wir für Abrechnung und Missbrauchsprävention aufbewahren müssen, werden anonymisiert, sodass sie nicht mehr mit Ihnen verknüpft sind.",
      ],
    },
    {
      heading: "Ihre Rechte",
      body: [
        "Sie können auf Ihre Kontodaten zugreifen, sie berichtigen, exportieren oder löschen sowie bestimmten Verarbeitungen widersprechen oder deren Einschränkung verlangen. Das meiste davon können Sie selbst in Ihren Kontoeinstellungen erledigen; für alles andere schreiben Sie an support@relayium.com. Wir verkaufen Ihre personenbezogenen Daten nicht. Soweit die GDPR oder ähnliche Gesetze gelten, ist unsere Rechtsgrundlage für die wenigen Daten, die wir verarbeiten, die Erbringung des von Ihnen angefragten Dienstes sowie unser berechtigtes Interesse an dessen Sicherheit und der Verhinderung von Missbrauch.",
      ],
    },
    {
      heading: "Kinder",
      body: [
        "Relayium richtet sich nicht an Kinder. Wir erheben wissentlich keine personenbezogenen Daten von Personen unter 13 Jahren oder unter dem Mindestalter für die digitale Einwilligung in Ihrem Wohnsitzland. Wenn Sie glauben, dass ein Kind uns Daten übermittelt hat, kontaktieren Sie support@relayium.com und wir löschen sie.",
      ],
    },
    {
      heading: "Änderungen dieser Richtlinie",
      body: [
        "Wir können diese Richtlinie aktualisieren, wenn sich der Dienst weiterentwickelt. In diesem Fall ändern wir das oben genannte Datum „Zuletzt aktualisiert“.",
      ],
    },
    {
      heading: "Kontakt",
      body: ["Fragen zum Datenschutz? Schreiben Sie uns an support@relayium.com."],
    },
  ],
};

const fr = {
  title: "Politique de confidentialité",
  description:
    "Comment Relayium traite les fichiers et le texte éphémère : le contenu est chiffré de bout en bout, Relayium ne stocke pas le corps des messages en direct et les liens de téléchargement conservent les fichiers chiffrés à divulgation nulle.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-08-13",
  otherDocLabel: "Conditions d'utilisation",
  lead: [
    "Relayium est conçu pour que vos fichiers et textes éphémères restent les vôtres. Les sessions locales du navigateur sont directes ; les sessions inter-réseaux du navigateur peuvent transporter du chiffré de bout en bout via TURN ; le texte CLI est uniquement direct ; les liens de téléchargement ne stockent que du chiffré de fichier à divulgation nulle.",
    "Cette page explique les quelques données que le service traite effectivement, et celles qu'il ne voit délibérément jamais.",
  ],
  sections: [
    {
      heading: "Le contenu du réseau local n'est pas stocké",
      body: [
        "Lorsque vous transférez des fichiers ou échangez du texte sur le même réseau, aucun compte n'est nécessaire et Relayium ne stocke pas le contenu. Pour connecter directement les appareils, le service de signalisation traite temporairement des métadonnées de connexion telles que les adresses IP, l'appartenance au salon, les noms d'appareils, la présence, les capacités et la négociation WebRTC.",
      ],
    },
    {
      heading: "Ce que stocke un compte (uniquement si vous vous connectez)",
      body: [
        "Les sessions sur le même réseau (local) ne nécessitent aucun compte. La personne qui crée un code d'appairage pour une session inter-réseaux du navigateur ou de la CLI doit se connecter ; celle qui rejoint avec ce code n'a pas besoin de compte. La création d'un lien de téléchargement stocké exige aussi une connexion. Nous stockons alors le strict minimum nécessaire au fonctionnement du compte :",
      ],
      bullets: [
        "Votre adresse e-mail et un nom d'affichage.",
        "La méthode de connexion utilisée (Se connecter avec Apple, Google, un lien magique par e-mail, ou e-mail + mot de passe). Les jetons de lien magique sont stockés uniquement sous forme de hachage, jamais en clair ; si vous définissez un mot de passe, nous ne stockons que son hachage bcrypt, jamais le mot de passe lui-même. Si vous utilisez « Se connecter avec Apple » avec le relais d'e-mail privé d'Apple, nous ne voyons jamais que cette adresse de relais.",
        "Une session de connexion, conservée dans un cookie sécurisé httpOnly.",
        "Les appareils que vous enregistrez, sous la forme d'un identifiant d'appareil aléatoire et d'un nom d'appareil (par ex. le nom de votre plateforme).",
      ],
    },
    {
      heading: "Transfert stocké (liens de téléchargement)",
      body: [
        "Lorsque vous utilisez le mode optionnel de liens de téléchargement stockés, votre navigateur chiffre vos fichiers avec AES-256-GCM avant qu'ils ne quittent votre appareil. La clé de déchiffrement n'existe que dans le fragment d'URL (après le #) et n'est jamais envoyée au serveur. Cela signifie :",
      ],
      bullets: [
        "Le serveur ne stocke que du chiffré. Il ne peut pas lire le contenu de vos fichiers, leurs noms ni les clés.",
        "Nous enregistrons la taille du chiffré et les horodatages (heure d'envoi, expiration) pour la gestion des quotas et le nettoyage.",
        "Le chiffré est automatiquement supprimé à l'expiration ou lors du premier téléchargement complet (lecture unique), selon ce qui survient en premier.",
      ],
    },
    {
      heading: "Le contenu que nous ne pouvons pas lire",
      body: ["Les éléments suivants n'atteignent jamais les serveurs Relayium en clair et ne peuvent pas être déchiffrés par eux :"],
      bullets: [
        "Le contenu de vos fichiers.",
        "Les noms de vos fichiers.",
        "Le corps de vos messages texte en direct.",
        "Vos clés de chiffrement.",
      ],
    },
    {
      heading: "Relais inter-réseau (TURN)",
      body: [
        "Les sessions de fichiers et de texte inter-réseaux du navigateur utilisent TURN par conception. TURN ne transporte que du chiffré de bout en bout et des métadonnées de transport. Pour les quotas et la prévention des abus, nous associons le total d'octets relayés et les horodatages au compte du créateur du code, sans inspecter le texte clair des messages ou fichiers. Le texte CLI est uniquement direct, n'utilise pas TURN et ne compte pas dans son usage. Le texte en direct exige que les deux personnes soient en ligne ; Relayium ne fournit ni livraison hors ligne ni historique serveur, mais chaque terminal peut copier ou conserver ce qu'il reçoit.",
      ],
    },
    {
      heading: "Mesure d'utilisation et quotas",
      body: [
        "Qui dit offres payantes dit compter ce que chaque compte consomme du service. Tant que vous êtes connecté, nous tenons par compte un relevé continu des octets que vous téléversez et téléchargez via Relayium, de la taille du chiffré que conservent vos liens stockés, et des totaux d'octets relayés attribués aux codes d'appairage que vous avez créés. Ces compteurs survivent au transfert qui les a produits — nous les conservons sous forme de totaux mensuels par compte — car ce sont eux qui font respecter les quotas d'usage, de stockage et de relais compris dans votre offre, et sur lesquels reposent nos registres de facturation et de compte. Un abonnement payant est un prix fixe par offre, et non une facturation à l'octet.",
      ],
      bullets: [
        "Ce qui est enregistré : des volumes d'octets, des tailles d'objets stockés et les moments où ils ont été mesurés, rattachés à votre compte.",
        "Ce qui ne l'est pas : le contenu de vos fichiers, leurs noms et le corps de vos messages restent chiffrés et illisibles pour nous, et nous n'enregistrons pas les écrans que vous ouvrez ni les fonctionnalités que vous utilisez.",
        "Il s'agit de mesure, pas d'analyse. Nos applications et notre site ne contiennent aucun SDK publicitaire ou d'analyse tiers, et ces compteurs ne servent jamais à vous suivre sur d'autres applications ou sites web.",
        "Vous pouvez consulter vos totaux actuels à tout moment sur la page de votre compte, dans l'application ou sur le web.",
      ],
    },
    {
      heading: "Cookies et stockage local",
      body: [
        "Nous utilisons un cookie de session pour maintenir votre connexion. Dans le stockage local de votre navigateur, nous conservons un identifiant d'appareil aléatoire afin qu'un appareil que vous avez enregistré puisse être reconnu. Nous n'utilisons pas de cookies publicitaires ou de suivi.",
      ],
    },
    {
      heading: "Services tiers",
      body: ["Quelques tiers interviennent uniquement lorsque vous choisissez de les utiliser :"],
      bullets: [
        "Google, si vous vous connectez avec Google — nous recevons votre adresse e-mail et votre profil de base pour créer le compte.",
        "Apple, si vous utilisez « Se connecter avec Apple » — nous recevons un identifiant stable et l'adresse e-mail (ou l'adresse de relais privée d'Apple) que vous choisissez de partager.",
        "Stripe, notre prestataire de paiement pour les abonnements achetés sur le web — voir Paiements.",
        "Apple, pour les abonnements achetés dans nos applications iOS et macOS via un achat intégré — voir Paiements.",
        "Un prestataire d'envoi d'e-mails, pour envoyer les e-mails liés au compte tels que la connexion par lien magique et la vérification.",
      ],
    },
    {
      heading: "Paiements",
      body: [
        "Vous ne partagez des données de paiement que si vous achetez une offre payante. Nous ne recevons ni ne stockons jamais votre numéro de carte complet.",
      ],
      bullets: [
        "Sur le web, les paiements sont traités par Stripe. Les détails de la carte vont à Stripe, pas à nous ; nous ne recevons qu'une référence client et le statut d'abonnement qui en résulte.",
        "Dans nos applications iOS et macOS, les abonnements sont achetés via l'achat intégré d'Apple. Apple traite le paiement sous votre identifiant Apple et nous ne voyons jamais votre moyen de paiement. L'application nous transmet l'enregistrement de transaction signé par Apple ; nous conservons ce que cet enregistrement indique sur l'achat, à savoir le produit d'abonnement acheté, l'identifiant Apple de cet abonnement, ainsi que son statut, sa période de facturation et ses dates de renouvellement ou d'expiration. Nous générons également un jeton aléatoire qui rattache un achat sur l'App Store à votre compte Relayium.",
        "Pour votre compte, nous ne stockons que votre offre actuelle, le statut de l'abonnement, le cycle de facturation, les dates de période et la référence de l'abonnement chez votre prestataire de paiement — jamais les données de carte.",
      ],
    },
    {
      heading: "L'application Relayium",
      body: [
        "Nos applications natives traitent quelques données au niveau de l'appareil que le site web ne traite pas :",
      ],
      bullets: [
        "Notifications push : si vous les activez, nous stockons un jeton d'appareil Apple Push Notification service (APNs) afin de pouvoir livrer des notifications à votre appareil. Vous pouvez désactiver les notifications à tout moment dans les réglages de votre appareil.",
        "Appareil photo et photos : utilisés uniquement sur votre appareil pour scanner un code QR ou choisir des fichiers à envoyer. Rien n'est capturé ni téléversé depuis l'appareil photo ou votre bibliothèque, à l'exception des fichiers que vous choisissez délibérément de transférer.",
        "L'application ne vous suit pas à travers d'autres applications ou sites web, et ne contient aucun SDK publicitaire ou d'analyse tiers.",
      ],
    },
    {
      heading: "Conservation et suppression des données",
      body: [
        "Les données du compte sont conservées tant que votre compte existe. Vous pouvez supprimer votre compte et ses données à tout moment depuis les paramètres de votre compte, dans l'application ou sur le web. La suppression déclenche un délai de grâce de 30 jours pendant lequel vous pouvez l'annuler en vous reconnectant ; passé ce délai, votre compte et vos données personnelles sont définitivement supprimés. Les compteurs d'utilisation agrégés que nous devons conserver pour la facturation et la prévention des abus sont anonymisés afin de ne plus être liés à vous.",
      ],
    },
    {
      heading: "Vos droits",
      body: [
        "Vous pouvez accéder à vos données de compte, les corriger, les exporter ou les supprimer, et vous opposer à certains traitements ou en demander la limitation. La plupart de ces actions sont possibles vous-même depuis les paramètres de votre compte ; pour le reste, écrivez à support@relayium.com. Nous ne vendons pas vos données personnelles. Lorsque le GDPR ou des lois similaires s'appliquent, notre base légale pour les quelques données que nous traitons est l'exécution du service que vous avez demandé, ainsi que notre intérêt légitime à en assurer la sécurité et à prévenir les abus.",
      ],
    },
    {
      heading: "Enfants",
      body: [
        "Relayium ne s'adresse pas aux enfants. Nous ne collectons pas sciemment de données personnelles auprès de toute personne de moins de 13 ans, ou en dessous de l'âge minimum de consentement numérique en vigueur là où vous résidez. Si vous pensez qu'un enfant nous a communiqué des données, contactez support@relayium.com et nous les supprimerons.",
      ],
    },
    {
      heading: "Modifications de cette politique",
      body: [
        "Nous pouvons mettre à jour cette politique au fur et à mesure de l'évolution du service. Dans ce cas, nous modifierons la date « Dernière mise à jour » ci-dessus.",
      ],
    },
    {
      heading: "Contact",
      body: ["Des questions sur la confidentialité ? Écrivez-nous à support@relayium.com."],
    },
  ],
};

const ar = {
  title: "سياسة الخصوصية",
  description:
    "كيف تتعامل Relayium مع الملفات والنص المؤقت: يُشفَّر المحتوى من الطرف إلى الطرف، ولا تخزّن Relayium نصوص الرسائل المباشرة، وتبقى ملفات روابط التنزيل مُشفَّرة بمعرفة صفرية.",
  updatedLabel: "آخر تحديث",
  updated: "2026-08-13",
  otherDocLabel: "شروط الخدمة",
  lead: [
    "صُمِّمت Relayium بحيث تظل ملفاتك ونصوصك المؤقتة مِلكًا لك. جلسات المتصفح المحلية مباشرة؛ وقد تحمل جلسات المتصفح عبر الشبكات نصًا مُشفَّرًا من الطرف إلى الطرف عبر TURN؛ ونص CLI مباشر فقط؛ ولا تحتفظ روابط التنزيل إلا بنص ملفات مُشفَّر بمعرفة صفرية.",
    "توضّح هذه الصفحة البيانات القليلة التي تتعامل معها الخدمة فعلًا، والبيانات التي لا تراها عن قصد أبدًا.",
  ],
  sections: [
    {
      heading: "لا يُخزَّن محتوى الشبكة المحلية",
      body: [
        "عند نقل الملفات أو تبادل النص بين أجهزة على الشبكة نفسها، لا حاجة إلى حساب ولا تخزّن Relayium المحتوى. ولمساعدة الأجهزة على الاتصال مباشرة، تعالج خدمة الإشارة مؤقتًا بيانات اتصال وصفية مثل عناوين IP وعضوية الغرفة وأسماء الأجهزة والحضور والقدرات وتفاوض WebRTC.",
      ],
    },
    {
      heading: "ما الذي يخزّنه الحساب (فقط في حال تسجيل الدخول)",
      body: [
        "لا تتطلب الجلسات على الشبكة المحلية أي حساب. يجب على من ينشئ رمز اقتران لجلسة متصفح أو CLI عبر الشبكات تسجيل الدخول؛ ولا يحتاج من ينضم بالرمز إلى حساب. كما يتطلب إنشاء رابط تنزيل مُخزَّن تسجيل الدخول. إذا سجّلت الدخول، فإننا نخزّن الحد الأدنى اللازم لتشغيل الحساب:",
      ],
      bullets: [
        "عنوان بريدك الإلكتروني واسم عرض.",
        "طريقة تسجيل الدخول التي استخدمتها (تسجيل الدخول عبر Apple، أو Google، أو رابط تسجيل الدخول عبر البريد الإلكتروني، أو البريد الإلكتروني + كلمة المرور). تُخزَّن رموز رابط تسجيل الدخول على هيئة تجزئة فقط، ولا تُخزَّن أبدًا كنص صريح؛ وإذا ضبطت كلمة مرور، فإننا نخزّن تجزئة bcrypt الخاصة بها فقط، ولا نخزّن كلمة المرور نفسها أبدًا. إذا استخدمت «تسجيل الدخول عبر Apple» مع خدمة إخفاء البريد الإلكتروني الخاصة بـ Apple، فإننا لا نرى سوى عنوان الترحيل ذاك.",
        "جلسة تسجيل دخول، محفوظة في ملف تعريف ارتباط آمن من نوع httpOnly.",
        "الأجهزة التي تسجّلها، على هيئة مُعرِّف جهاز عشوائي واسم جهاز (مثل اسم منصّتك).",
      ],
    },
    {
      heading: "النقل المُخزَّن (روابط التنزيل)",
      body: [
        "عندما تستخدم وضع رابط التنزيل المُخزَّن الاختياري، يُشفِّر متصفحك ملفاتك باستخدام AES-256-GCM قبل أن تغادر جهازك. ولا يوجد مفتاح فك التشفير إلا في جزء URL (المقطع الذي يلي #) — ولا يُرسَل أبدًا إلى الخادم. وهذا يعني:",
      ],
      bullets: [
        "لا يخزّن الخادم سوى النص المُشفَّر. ولا يمكنه قراءة محتويات ملفاتك أو أسماءها أو مفاتيحك.",
        "نسجّل حجم النص المُشفَّر والطوابع الزمنية (وقت الرفع، وقت انتهاء الصلاحية) لأغراض إدارة الحصة والتنظيف.",
        "يُحذَف النص المُشفَّر تلقائيًا عند انتهاء الصلاحية أو عند أول تنزيل كامل (الحذف بعد القراءة)، أيهما يقع أولًا.",
      ],
    },
    {
      heading: "المحتوى الذي لا نستطيع قراءته",
      body: ["لا يصل ما يلي إلى خوادم Relayium كنص صريح ولا تستطيع الخوادم فك تشفيره:"],
      bullets: [
        "محتويات ملفاتك.",
        "أسماء ملفاتك.",
        "نصوص رسائلك المباشرة.",
        "مفاتيح التشفير الخاصة بك.",
      ],
    },
    {
      heading: "المُرحِّل عبر الشبكات (TURN)",
      body: [
        "تستخدم جلسات الملفات والنص عبر الشبكات في المتصفح TURN بحكم التصميم. لا يحمل TURN سوى النص المُشفَّر من الطرف إلى الطرف وبيانات النقل الوصفية. ولأغراض الحصص ومنع الإساءة، نربط إجمالي البايتات المُرحَّلة وطوابعها الزمنية بحساب منشئ الرمز، من دون فحص النص الصريح للرسائل أو الملفات. نص CLI مباشر فقط ولا يستخدم TURN أو يُحتسب ضمنه. يتطلب النص المباشر اتصال الطرفين بالإنترنت؛ ولا توفر Relayium تسليمًا دون اتصال أو سجل رسائل على الخادم، لكن يمكن لأي طرف نسخ ما يستلمه أو الاحتفاظ به.",
      ],
    },
    {
      heading: "قياس الاستخدام والحصص",
      body: [
        "وجود خطط مدفوعة يعني أن على الخدمة أن تحصي مقدار ما يستهلكه كل حساب منها. أثناء تسجيل دخولك، نحتفظ لكل حساب بسجل جارٍ لعدد البايتات التي ترفعها وتنزّلها عبر Relayium، ولحجم النص المشفَّر الذي تحتفظ به روابطك المُخزَّنة، ولإجماليات البايتات المُرحَّلة المنسوبة إلى رموز الاقتران التي أنشأتها. تبقى هذه العدادات بعد انتهاء عملية النقل التي أنتجتها — إذ نحفظها كإجماليات شهرية لكل حساب — لأنها هي ما يفرض حصة خطتك من الاستخدام والتخزين والترحيل، وما تستند إليه سجلات الفوترة والحساب لدينا. الاشتراك المدفوع سعره ثابت حسب الخطة، وليس احتسابًا لكل بايت.",
      ],
      bullets: [
        "ما يُسجَّل: أحجام البايتات، وأحجام الكائنات المُخزَّنة، وأوقات قياسها، مرتبطةً بحسابك.",
        "وما لا يُسجَّل: محتويات ملفاتك وأسماؤها ونصوص رسائلك تبقى مشفَّرة ولا يمكننا قراءتها، ولا نسجّل أي الشاشات تفتح ولا أي الميزات تستخدم.",
        "هذا قياس وليس تحليلات. لا تتضمن تطبيقاتنا ولا موقعنا أي حزمة إعلانات أو تحليلات من طرف ثالث، ولا تُستخدم هذه العدادات مطلقًا لتتبعك عبر تطبيقات أو مواقع أخرى.",
        "يمكنك الاطلاع على إجمالياتك الحالية في أي وقت من صفحة حسابك، في التطبيق أو على الويب.",
      ],
    },
    {
      heading: "ملفات تعريف الارتباط والتخزين المحلي",
      body: [
        "نستخدم ملف تعريف ارتباط جلسة واحدًا لإبقائك مُسجّل الدخول. ونحتفظ في التخزين المحلي لمتصفحك بمُعرِّف جهاز عشوائي حتى يمكن التعرّف على جهاز سجّلته. ولا نستخدم ملفات تعريف ارتباط للإعلانات أو التتبّع.",
      ],
    },
    {
      heading: "خدمات الطرف الثالث",
      body: ["لا يشارك سوى عدد قليل من الأطراف الثالثة وذلك فقط عندما تختار استخدامها:"],
      bullets: [
        "Google، إذا سجّلت الدخول باستخدام Google — نتلقّى بريدك الإلكتروني وملفك التعريفي الأساسي لإنشاء الحساب.",
        "Apple، إذا استخدمت «تسجيل الدخول عبر Apple» — نتلقّى مُعرِّفًا ثابتًا والبريد الإلكتروني (أو عنوان ترحيل Apple الخاص) الذي تختار مشاركته.",
        "Stripe، مُعالِج المدفوعات الخاص بنا للاشتراكات التي تُشترى عبر الويب — راجع «المدفوعات».",
        "Apple، للاشتراكات التي تُشترى داخل تطبيقَي iOS وmacOS عبر الشراء داخل التطبيق — راجع «المدفوعات».",
        "مزوّد لتوصيل البريد الإلكتروني، لإرسال رسائل الحساب مثل رابط تسجيل الدخول والتحقق.",
      ],
    },
    {
      heading: "المدفوعات",
      body: [
        "لا تشارك بيانات الدفع إلا إذا اشتريت خطة مدفوعة. ولا نتلقّى أو نخزّن أبدًا رقم بطاقتك الكامل.",
      ],
      bullets: [
        "على الويب، تُعالَج المدفوعات بواسطة Stripe. تذهب تفاصيل البطاقة إلى Stripe وليس إلينا؛ ولا نتلقّى سوى مرجع للعميل وحالة الاشتراك الناتجة عنه.",
        "في تطبيقَي iOS وmacOS، تُشترى الاشتراكات عبر الشراء داخل التطبيق من Apple. تُعالِج Apple الدفع باستخدام معرّف Apple الخاص بك، ولا نرى وسيلة الدفع الخاصة بك أبدًا. يرسل إلينا التطبيق سجل المعاملة الموقَّع من Apple، ونحتفظ بما يذكره عن عملية الشراء: منتج الاشتراك الذي اشتريته، ومُعرِّف Apple لذلك الاشتراك، وحالته ودورة فوترته وتواريخ التجديد أو انتهاء الصلاحية. كما نولّد رمزًا عشوائيًا يربط عملية شراء من App Store بحسابك في Relayium.",
        "بخصوص حسابك، لا نخزّن سوى خطتك الحالية وحالة اشتراكك ودورة الفوترة وتواريخ الفترة والمرجع الذي يمنحه مزوّد الدفع لهذا الاشتراك — ولا نخزّن أبدًا بيانات البطاقة.",
      ],
    },
    {
      heading: "تطبيق Relayium",
      body: [
        "تتعامل تطبيقاتنا الأصلية مع قدر ضئيل من البيانات على مستوى الجهاز لا يتعامل معها الموقع الإلكتروني:",
      ],
      bullets: [
        "الإشعارات الفورية: إذا فعّلتها، فإننا نخزّن رمز جهاز خاص بخدمة Apple Push Notification (APNs) حتى نتمكّن من إرسال الإشعارات إلى جهازك. يمكنك إيقاف الإشعارات في أي وقت من إعدادات جهازك.",
        "الكاميرا والصور: تُستخدَم فقط على جهازك لمسح رمز QR أو اختيار ملفات لإرسالها. لا يُلتقَط أو يُرفَع أي شيء من الكاميرا أو مكتبتك باستثناء الملفات التي تختار عمدًا نقلها.",
        "لا يتتبّعك التطبيق عبر تطبيقات أو مواقع أخرى، ولا يحتوي على إعلانات أو أدوات تحليل من أطراف ثالثة.",
      ],
    },
    {
      heading: "الاحتفاظ بالبيانات وحذفها",
      body: [
        "يُحتفَظ ببيانات الحساب طوال وجود حسابك. يمكنك حذف حسابك وبياناته في أي وقت بنفسك من إعدادات حسابك، سواء في التطبيق أو على الويب. يبدأ الحذف فترة سماح مدتها 30 يومًا يمكنك خلالها التراجع عنه بتسجيل الدخول مجددًا؛ وبعد ذلك، تُزال بياناتك الشخصية وحسابك بشكل دائم. تُخفى هوية عدادات الاستخدام الإجمالية التي يتعيّن علينا الاحتفاظ بها لأغراض الفوترة ومنع إساءة الاستخدام، بحيث لم تعد مرتبطة بك.",
      ],
    },
    {
      heading: "حقوقك",
      body: [
        "يمكنك الوصول إلى بيانات حسابك أو تصحيحها أو تصديرها أو حذفها، والاعتراض على معالجات معيّنة أو طلب تقييدها. يمكنك القيام بمعظم ذلك بنفسك من إعدادات حسابك؛ وبالنسبة لأي شيء آخر، راسِلنا على support@relayium.com. نحن لا نبيع بياناتك الشخصية. وحيثما تُطبَّق GDPR أو قوانين مماثلة، فإن أساسنا القانوني لمعالجة هذا القدر الضئيل من البيانات هو تقديم الخدمة التي طلبتها ومصلحتنا المشروعة في الحفاظ على أمنها ومنع إساءة استخدامها.",
      ],
    },
    {
      heading: "الأطفال",
      body: [
        "لا تستهدف Relayium الأطفال. ولا نجمع عن علم بيانات شخصية من أي شخص دون سن 13 عامًا، أو دون الحد الأدنى لسن الموافقة الرقمية في مكان إقامتك. إذا كنت تعتقد أن طفلًا قد زوّدنا ببيانات، فتواصل معنا على support@relayium.com وسنقوم بحذفها.",
      ],
    },
    {
      heading: "التغييرات على هذه السياسة",
      body: [
        "قد نُحدِّث هذه السياسة مع تطوّر الخدمة. وعندما نفعل ذلك، سنغيّر تاريخ «آخر تحديث» أعلاه.",
      ],
    },
    {
      heading: "التواصل",
      body: ["هل لديك أسئلة عن الخصوصية؟ راسِلنا على support@relayium.com."],
    },
  ],
};

const es = {
  title: "Política de privacidad",
  description:
    "Cómo Relayium gestiona archivos y texto efímero: el contenido se cifra de extremo a extremo, Relayium no almacena el cuerpo de los mensajes en directo y los enlaces de descarga mantienen los archivos cifrados con conocimiento cero.",
  updatedLabel: "Última actualización",
  updated: "2026-08-13",
  otherDocLabel: "Términos del servicio",
  lead: [
    "Relayium está diseñado para que tus archivos y textos efímeros sigan siendo tuyos. Las sesiones locales del navegador son directas; las sesiones entre redes pueden transportar texto cifrado de extremo a extremo por TURN; el texto CLI es solo directo; y los enlaces de descarga solo almacenan archivos cifrados con conocimiento cero.",
    "Esta página explica los pocos datos que el servicio sí gestiona, y los datos que deliberadamente nunca ve.",
  ],
  sections: [
    {
      heading: "El contenido de la red local no se almacena",
      body: [
        "Al transferir archivos o intercambiar texto entre dispositivos de la misma red, no necesitas cuenta y Relayium no almacena el contenido. Para conectar los dispositivos directamente, el servicio de señalización trata temporalmente metadatos de conexión como direcciones IP, miembros de la sala, nombres de dispositivo, presencia, capacidades y negociación WebRTC.",
      ],
    },
    {
      heading: "Qué almacena una cuenta (solo si inicias sesión)",
      body: [
        "Las sesiones en la misma red local no necesitan cuenta. Quien crea un código de emparejamiento para una sesión entre redes del navegador o CLI debe iniciar sesión; quien se une con el código no necesita cuenta. Crear un enlace de descarga almacenado también requiere iniciar sesión. Si inicias sesión, almacenamos lo mínimo necesario para gestionar una cuenta:",
      ],
      bullets: [
        "Tu dirección de correo electrónico y un nombre para mostrar.",
        "Qué método de inicio de sesión usaste (Iniciar sesión con Apple, Google, un enlace mágico por correo electrónico, o correo electrónico + contraseña). Los tokens de enlace mágico se almacenan solo como un hash, nunca en texto en claro; si estableces una contraseña, almacenamos solo su hash bcrypt, nunca la contraseña en sí. Si usas Iniciar sesión con Apple con la retransmisión de correo privada de Apple, solo vemos esa dirección de retransmisión.",
        "Una sesión de inicio de sesión, guardada en una cookie segura httpOnly.",
        "Los dispositivos que registras, como un id de dispositivo aleatorio y un nombre de dispositivo (p. ej., el nombre de tu plataforma).",
      ],
    },
    {
      heading: "Transferencia almacenada (enlaces de descarga)",
      body: [
        "Cuando usas el modo opcional de enlace de descarga almacenado, tu navegador cifra tus archivos con AES-256-GCM antes de que salgan de tu dispositivo. La clave de descifrado existe únicamente en el fragmento de la URL: nunca se envía al servidor. Esto significa:",
      ],
      bullets: [
        "El servidor solo almacena texto cifrado. No puede leer el contenido de tus archivos, sus nombres ni las claves.",
        "Registramos el tamaño del texto cifrado y marcas de tiempo (hora de subida, caducidad) para la gestión de cuotas y la limpieza.",
        "El texto cifrado se elimina automáticamente al caducar o en la primera descarga completa (destrucción tras la lectura), lo que ocurra primero.",
      ],
    },
    {
      heading: "Contenido que no podemos leer",
      body: ["Lo siguiente nunca llega en texto claro a los servidores de Relayium y estos no pueden descifrarlo:"],
      bullets: [
        "El contenido de tus archivos.",
        "Los nombres de tus archivos.",
        "El cuerpo de tus mensajes de texto en directo.",
        "Tus claves de cifrado.",
      ],
    },
    {
      heading: "Retransmisión entre redes (TURN)",
      body: [
        "Las sesiones de archivos y texto entre redes del navegador usan TURN por diseño. TURN solo transporta texto cifrado de extremo a extremo y metadatos de transporte. Para las cuotas y la prevención de abusos, asociamos el total de bytes retransmitidos y sus marcas de tiempo a la cuenta que creó el código, sin inspeccionar el texto claro de mensajes o archivos. El texto CLI es solo directo, no usa TURN ni cuenta en su consumo. El texto en directo requiere que ambas partes estén conectadas; Relayium no ofrece entrega sin conexión ni historial de mensajes en el servidor, aunque cada extremo puede copiar o conservar lo recibido.",
      ],
    },
    {
      heading: "Medición de uso y cuotas",
      body: [
        "Tener planes de pago obliga al servicio a contar cuánto usa cada cuenta. Mientras tienes la sesión iniciada, mantenemos por cuenta un registro continuo de los bytes que subes y descargas a través de Relayium, del tamaño del texto cifrado que retienen tus enlaces almacenados y de los totales de bytes retransmitidos atribuidos a los códigos de emparejamiento que creaste. Estos contadores sobreviven a la transferencia que los generó — los conservamos como totales mensuales por cuenta — porque son lo que aplica las cuotas de uso, almacenamiento y retransmisión incluidas en tu plan, y aquello en lo que se apoyan nuestros registros de facturación y de cuenta. Una suscripción de pago tiene un precio fijo por plan, no un cobro por byte.",
      ],
      bullets: [
        "Qué se registra: volúmenes de bytes, tamaños de los objetos almacenados y los momentos en que se midieron, vinculados a tu cuenta.",
        "Qué no: el contenido de tus archivos, sus nombres y el cuerpo de tus mensajes siguen cifrados e ilegibles para nosotros, y no registramos qué pantallas abres ni qué funciones usas.",
        "Esto es medición, no analítica. Nuestras apps y nuestro sitio no incluyen ningún SDK publicitario ni de analítica de terceros, y estos contadores nunca se usan para rastrearte en otras apps o sitios web.",
        "Puedes consultar tus totales actuales en cualquier momento en la página de tu cuenta, en la app o en la web.",
      ],
    },
    {
      heading: "Cookies y almacenamiento local",
      body: [
        "Usamos una cookie de sesión para mantener tu sesión iniciada. En el almacenamiento local de tu navegador guardamos un id de dispositivo aleatorio para que un dispositivo que hayas registrado pueda ser reconocido. No usamos cookies de publicidad ni de seguimiento.",
      ],
    },
    {
      heading: "Servicios de terceros",
      body: ["Solo intervienen un par de terceros cuando eliges usarlos:"],
      bullets: [
        "Google, si inicias sesión con Google: recibimos tu correo electrónico y tu perfil básico para crear la cuenta.",
        "Apple, si usas Iniciar sesión con Apple: recibimos un identificador estable y el correo electrónico (o la dirección de retransmisión privada de Apple) que elijas compartir.",
        "Stripe, nuestro procesador de pagos para las suscripciones compradas en la web; consulta Pagos.",
        "Apple, para las suscripciones compradas dentro de nuestras apps de iOS y macOS mediante compra dentro de la app; consulta Pagos.",
        "Un proveedor de envío de correo electrónico, para enviar correos de la cuenta como el inicio de sesión con enlace mágico y la verificación.",
      ],
    },
    {
      heading: "Pagos",
      body: [
        "Solo compartes datos de pago si compras un plan de pago. Nunca recibimos ni almacenamos tu número de tarjeta completo.",
      ],
      bullets: [
        "En la web, los pagos los gestiona Stripe. Los datos de la tarjeta van a Stripe, no a nosotros; solo recibimos una referencia de cliente y el estado de suscripción resultante.",
        "En nuestras apps de iOS y macOS, las suscripciones se compran mediante la compra dentro de la app de Apple. Apple procesa el pago con tu Apple ID y nunca vemos tu método de pago. La app nos envía el registro de la transacción firmado por Apple y conservamos lo que dice sobre la compra: qué producto de suscripción compraste, el identificador de Apple para esa suscripción y su estado, período de facturación y fechas de renovación o vencimiento. También generamos un token aleatorio que vincula una compra en la App Store con tu cuenta de Relayium.",
        "Para tu cuenta solo almacenamos tu plan actual, el estado de la suscripción, el ciclo de facturación, las fechas del período y la referencia de la suscripción en tu proveedor de pagos, nunca los datos de la tarjeta.",
      ],
    },
    {
      heading: "La app de Relayium",
      body: [
        "Nuestras apps nativas gestionan algunos datos a nivel de dispositivo que el sitio web no gestiona:",
      ],
      bullets: [
        "Notificaciones push: si las activas, almacenamos un token de dispositivo del Apple Push Notification service (APNs) para poder enviar notificaciones a tu dispositivo. Puedes desactivar las notificaciones en cualquier momento en los ajustes de tu dispositivo.",
        "Cámara y fotos: se usan solo en tu dispositivo para escanear un código QR o elegir archivos que enviar. No se captura ni se sube nada de la cámara ni de tu biblioteca, salvo los archivos que decidas transferir deliberadamente.",
        "La app no te rastrea a través de otras apps o sitios web, y no contiene publicidad ni SDK de análisis de terceros.",
      ],
    },
    {
      heading: "Conservación y eliminación de datos",
      body: [
        "Los datos de la cuenta se conservan mientras exista tu cuenta. Puedes eliminar tu cuenta y sus datos en cualquier momento desde los ajustes de tu cuenta, en la app o en la web. La eliminación inicia un período de gracia de 30 días durante el cual puedes deshacerla volviendo a iniciar sesión; después de eso, tu cuenta y tus datos personales se eliminan de forma permanente. Los contadores de uso agregados que debemos conservar para la facturación y la prevención de abusos se anonimizan para que ya no estén vinculados a ti.",
      ],
    },
    {
      heading: "Tus derechos",
      body: [
        "Puedes acceder, corregir, exportar o eliminar los datos de tu cuenta, y oponerte a ciertos tratamientos o solicitar su limitación. La mayor parte de esto puedes hacerlo tú mismo en los ajustes de tu cuenta; para cualquier otra cosa, escribe a support@relayium.com. No vendemos tus datos personales. Cuando se aplique el GDPR u otras leyes similares, nuestra base para tratar la escasa cantidad de datos que procesamos es la prestación del servicio que solicitaste y nuestro interés legítimo en mantenerlo seguro y prevenir abusos.",
      ],
    },
    {
      heading: "Menores",
      body: [
        "Relayium no está dirigido a menores. No recopilamos a sabiendas datos personales de nadie menor de 13 años, ni por debajo de la edad mínima de consentimiento digital de tu lugar de residencia. Si crees que un menor nos ha proporcionado datos, contacta con support@relayium.com y los eliminaremos.",
      ],
    },
    {
      heading: "Cambios en esta política",
      body: [
        "Podemos actualizar esta política a medida que el servicio evolucione. Cuando lo hagamos, cambiaremos la fecha de «Última actualización» anterior.",
      ],
    },
    {
      heading: "Contacto",
      body: ["¿Preguntas sobre privacidad? Escribe a support@relayium.com."],
    },
  ],
};

const pt = {
  title: "Política de Privacidade",
  description:
    "Como a Relayium lida com arquivos e texto temporário: o conteúdo é criptografado de ponta a ponta, a Relayium não armazena o corpo das mensagens ao vivo e os links de download mantêm os arquivos criptografados com conhecimento zero.",
  updatedLabel: "Última atualização",
  updated: "2026-08-13",
  otherDocLabel: "Termos de Serviço",
  lead: [
    "A Relayium foi criada para que seus arquivos e textos temporários continuem sendo seus. As sessões locais do navegador são diretas; sessões entre redes podem transportar texto cifrado de ponta a ponta por TURN; o texto da CLI é somente direto; e os links de download guardam apenas arquivos cifrados com conhecimento zero.",
    "Esta página explica os poucos dados que o serviço de fato processa e os dados que ele deliberadamente nunca vê.",
  ],
  sections: [
    {
      heading: "O conteúdo da rede local não é armazenado",
      body: [
        "Ao transferir arquivos ou trocar texto entre dispositivos na mesma rede, você não precisa de conta e a Relayium não armazena o conteúdo. Para conectar os dispositivos diretamente, o serviço de sinalização processa temporariamente metadados de conexão como endereços IP, participação na sala, nomes de dispositivos, presença, recursos e negociação WebRTC.",
      ],
    },
    {
      heading: "O que uma conta armazena (somente se você fizer login)",
      body: [
        "As sessões na mesma rede local não precisam de conta. Quem cria um código de emparelhamento para uma sessão entre redes do navegador ou da CLI deve fazer login; quem entra com o código não precisa de conta. Criar um link de download armazenado também exige login. Se você fizer login, armazenamos o mínimo necessário para operar uma conta:",
      ],
      bullets: [
        "Seu endereço de e-mail e um nome de exibição.",
        "Qual método de login você usou (Entrar com a Apple, Google, um link mágico por e-mail ou e-mail + senha). Os tokens de link mágico são armazenados apenas como um hash, nunca em texto claro; se você definir uma senha, armazenamos apenas o hash bcrypt dela, nunca a senha em si. Se você usar o Entrar com a Apple com o serviço de retransmissão de e-mail privado da Apple, veremos apenas esse endereço de retransmissão.",
        "Uma sessão de login, mantida em um cookie seguro httpOnly.",
        "Os dispositivos que você registra, como um id de dispositivo aleatório e um nome de dispositivo (por exemplo, o nome da sua plataforma).",
      ],
    },
    {
      heading: "Transferência armazenada (links de download)",
      body: [
        "Quando você usa o modo opcional de link de download armazenado, seu navegador criptografa seus arquivos com AES-256-GCM antes de eles saírem do seu dispositivo. A chave de descriptografia existe apenas no fragmento da URL — ela nunca é enviada ao servidor. Isso significa:",
      ],
      bullets: [
        "O servidor armazena apenas texto cifrado. Ele não consegue ler o conteúdo dos seus arquivos, os nomes deles nem as chaves.",
        "Registramos o tamanho do texto cifrado e marcas de tempo (hora do envio, expiração) para gerenciamento de cota e limpeza.",
        "O texto cifrado é excluído automaticamente na expiração ou no primeiro download completo (destruição após leitura), o que ocorrer primeiro.",
      ],
    },
    {
      heading: "Conteúdo que não podemos ler",
      body: ["O seguinte nunca chega em texto claro aos servidores da Relayium e não pode ser descriptografado por eles:"],
      bullets: [
        "O conteúdo dos seus arquivos.",
        "Os nomes dos seus arquivos.",
        "O corpo das suas mensagens de texto ao vivo.",
        "Suas chaves de criptografia.",
      ],
    },
    {
      heading: "Retransmissão entre redes (TURN)",
      body: [
        "As sessões de arquivos e texto entre redes no navegador usam TURN por projeto. O TURN transporta apenas texto cifrado de ponta a ponta e metadados de transporte. Para cotas e prevenção de abusos, associamos o total de bytes retransmitidos e os horários à conta de quem criou o código, sem inspecionar o texto claro de mensagens ou arquivos. O texto da CLI é somente direto, não usa TURN nem conta em seu uso. O texto ao vivo exige que ambas as partes estejam online; a Relayium não oferece entrega offline nem histórico no servidor, embora qualquer ponta possa copiar ou guardar o que recebeu.",
      ],
    },
    {
      heading: "Medição de uso e cotas",
      body: [
        "Ter planos pagos significa que o serviço precisa contar quanto cada conta usa dele. Enquanto você está conectado, mantemos por conta um registro contínuo dos bytes que você envia e baixa pelo Relayium, do tamanho do texto cifrado que seus links armazenados guardam e dos totais de bytes retransmitidos atribuídos aos códigos de pareamento que você criou. Esses contadores sobrevivem à transferência que os gerou — nós os mantemos como totais mensais por conta — porque são eles que aplicam as cotas de uso, armazenamento e retransmissão incluídas no seu plano, e aquilo em que se apoiam nossos registros de cobrança e de conta. Uma assinatura paga tem preço fixo por plano, não é uma cobrança por byte.",
      ],
      bullets: [
        "O que é registrado: volumes de bytes, tamanhos dos objetos armazenados e os momentos em que foram medidos, vinculados à sua conta.",
        "O que não é: o conteúdo dos seus arquivos, os nomes deles e o corpo das suas mensagens continuam cifrados e ilegíveis para nós, e não registramos quais telas você abre nem quais recursos você usa.",
        "Isto é medição, não análise. Nossos aplicativos e nosso site não contêm nenhum SDK de publicidade ou de análise de terceiros, e esses contadores nunca são usados para rastrear você em outros aplicativos ou sites.",
        "Você pode ver seus totais atuais a qualquer momento na página da sua conta, no aplicativo ou na web.",
      ],
    },
    {
      heading: "Cookies e armazenamento local",
      body: [
        "Usamos um cookie de sessão para manter você conectado. No armazenamento local do seu navegador, guardamos um id de dispositivo aleatório para que um dispositivo que você registrou possa ser reconhecido. Não usamos cookies de publicidade ou de rastreamento.",
      ],
    },
    {
      heading: "Serviços de terceiros",
      body: ["Alguns poucos terceiros só entram em cena quando você opta por usá-los:"],
      bullets: [
        "O Google, se você fizer login com o Google — recebemos seu e-mail e seu perfil básico para criar a conta.",
        "A Apple, se você usar o Entrar com a Apple — recebemos um identificador estável e o e-mail (ou o endereço de retransmissão privado da Apple) que você optar por compartilhar.",
        "A Stripe, nossa processadora de pagamentos para assinaturas compradas na web — veja Pagamentos.",
        "A Apple, para assinaturas compradas dentro dos nossos apps de iOS e macOS via compra no app — veja Pagamentos.",
        "Um provedor de envio de e-mail, para enviar e-mails da conta como login por link mágico e verificação.",
      ],
    },
    {
      heading: "Pagamentos",
      body: [
        "Você só compartilha dados de pagamento se comprar um plano pago. Nunca recebemos nem armazenamos o número completo do seu cartão.",
      ],
      bullets: [
        "Na web, os pagamentos são processados pela Stripe. Os dados do cartão vão para a Stripe, não para nós; recebemos apenas uma referência de cliente e o status de assinatura resultante.",
        "Nos nossos apps de iOS e macOS, as assinaturas são compradas por meio da compra no app da Apple. A Apple processa o pagamento usando seu Apple ID, e nunca vemos sua forma de pagamento. O app nos envia o registro da transação assinado pela Apple, e guardamos o que ele diz sobre a compra: qual produto de assinatura você comprou, o identificador da Apple para essa assinatura e seu status, período de cobrança e datas de renovação ou expiração. Também geramos um token aleatório que vincula uma compra na App Store à sua conta Relayium.",
        "Para sua conta, armazenamos apenas seu plano atual, o status da assinatura, o ciclo de cobrança, as datas do período e a referência da assinatura no seu provedor de pagamento — nunca dados de cartão.",
      ],
    },
    {
      heading: "O aplicativo Relayium",
      body: [
        "Nossos aplicativos nativos lidam com alguns dados no nível do dispositivo que o site não trata:",
      ],
      bullets: [
        "Notificações push: se você as ativar, armazenamos um token de dispositivo do Apple Push Notification service (APNs) para podermos entregar notificações ao seu dispositivo. Você pode desativar as notificações a qualquer momento nas configurações do seu dispositivo.",
        "Câmera e fotos: usadas apenas no seu dispositivo para escanear um código QR ou escolher arquivos para enviar. Nada é capturado ou enviado da câmera ou da sua biblioteca, exceto os arquivos que você escolhe deliberadamente transferir.",
        "O aplicativo não rastreia você em outros aplicativos ou sites, e não contém publicidade nem SDKs de análise de terceiros.",
      ],
    },
    {
      heading: "Retenção e exclusão de dados",
      body: [
        "Os dados da conta são mantidos enquanto sua conta existir. Você pode excluir sua conta e seus dados a qualquer momento nas configurações da conta, no app ou na web. A exclusão inicia um período de carência de 30 dias durante o qual você pode desfazê-la fazendo login novamente; depois disso, sua conta e seus dados pessoais são removidos permanentemente. Os contadores agregados de uso que precisamos manter para cobrança e prevenção de abusos são anonimizados para que não fiquem mais vinculados a você.",
      ],
    },
    {
      heading: "Seus direitos",
      body: [
        "Você pode acessar, corrigir, exportar ou excluir os dados da sua conta, e se opor a determinados processamentos ou solicitar sua restrição. A maior parte disso você pode fazer sozinho nas configurações da sua conta; para o restante, envie um e-mail para support@relayium.com. Não vendemos seus dados pessoais. Quando o GDPR ou leis semelhantes se aplicarem, nossa base para os poucos dados que processamos é a execução do serviço que você solicitou e nosso interesse legítimo em mantê-lo seguro e prevenir abusos.",
      ],
    },
    {
      heading: "Crianças",
      body: [
        "A Relayium não é direcionada a crianças. Não coletamos intencionalmente dados pessoais de ninguém com menos de 13 anos, ou abaixo da idade mínima de consentimento digital do seu local de residência. Se você acredita que uma criança nos forneceu dados, entre em contato pelo support@relayium.com e nós os excluiremos.",
      ],
    },
    {
      heading: "Alterações nesta política",
      body: [
        "Podemos atualizar esta política à medida que o serviço evolui. Quando o fizermos, alteraremos a data de \"Última atualização\" acima.",
      ],
    },
    {
      heading: "Contato",
      body: ["Dúvidas sobre privacidade? Envie um e-mail para support@relayium.com."],
    },
  ],
};

export default { slug: "privacy", langs: { en, zh, ja, ko, de, fr, ar, es, pt } };
