// web/scripts/pages/content/articles/howto-airdrop-for-windows-android.mjs
// How-to: the AirDrop-equivalent experience for Windows, Linux and Android
// (and mixed Apple/non-Apple fleets). English is the master; zh/ja/ko/de/fr
// follow the same structure with identical facts. Terminology mirrors
// src/lib/i18n/en.ts and content/landing.mjs. Distinct from compare/airdrop
// (a head-to-head comparison) — this is the "AirDrop equivalent for X" intent,
// so it cross-links that piece instead of repeating its comparison table.

const en = {
  title: "AirDrop for Windows, Linux and Android",
  description:
    "There is no official AirDrop for Windows, Linux or Android — here is the closest thing: instant same-Wi-Fi sharing in the browser, no account, no install, plus a way to reach across the internet AirDrop can't.",
  updatedLabel: "Last updated",
  lead: [
    "AirDrop only exists inside Apple's world, which leaves everyone else — Windows, Linux, Android, and any household with a mix of devices — without a built-in equivalent. This guide shows the closest thing to AirDrop for non-Apple devices: open a web page on both ends and the file just moves.",
    "It works the same way regardless of platform, so it also covers the case AirDrop never handles well: a Windows laptop, a Linux desktop and an Android phone all in the same room, or all three plus an iPhone thrown in.",
  ],
  sections: [
    {
      heading: "The AirDrop-like flow: same Wi-Fi, in the browser",
      body: [
        "This is the everyday case AirDrop is built for, and Relayium matches it without needing an app from any store.",
      ],
      bullets: [
        "On each device, open relayium.com in any modern browser — Chrome or Edge on Windows, Firefox or Chrome on Linux, Chrome on Android.",
        "On the same Wi-Fi, the devices find each other automatically — no code, no account, no pairing step, just like AirDrop discovering nearby devices.",
        "Drag files onto the page (or a whole folder — up to 1,000 files per batch), pick the other device, and confirm the matching 6-digit code shown on both screens.",
        "The transfer runs directly, peer-to-peer, over your own network — nothing is uploaded to a server in between.",
      ],
    },
    {
      heading: "Across the internet: something AirDrop can't do",
      body: [
        "AirDrop is nearby-only — walk out of Bluetooth/Wi-Fi range and it stops working. Relayium's second mode covers exactly that gap: two devices on completely different networks, anywhere in the world.",
        "The sender signs in and gets a short pairing code (with a join link and a QR code); the receiver enters it, or scans the QR, or opens the link — and never needs an account. That cross-network connection runs over an encrypted TURN relay rather than a direct link, and it does so by design: between two unrelated networks a direct path usually can't be found at all, and trying for one first would leave the connection hanging for about 20 seconds before ending up on the relay regardless. The files are sealed end-to-end before they leave the sender, so the relay only ever forwards ciphertext it has no key to open — the whole route stays end-to-end encrypted. A dropped connection can resume instead of restarting from zero.",
      ],
    },
    {
      heading: "What's actually protecting the file",
      body: [
        "Both modes above are realtime transfers, and both use the same encryption: an X25519 key exchange derives a key used for per-chunk AES-256-GCM, negotiated only between the two devices. Both sides display the same 6-digit verification code (a Short Authentication String) so you can confirm no one is sitting in the middle, and each file is checked end-to-end with a SHA-256 hash.",
        "Nothing is stored on a server in this mode — it exists only for the duration of the transfer. Relayium is open source under the AGPL-3.0 license at github.com/relayium/relayium, so the mechanics are auditable rather than a black box.",
      ],
    },
    {
      heading: "The practical limits, honestly",
      body: [
        "Because the file never lands on a server, there's no upload quota — the real limit is which browser is receiving. A desktop browser with the File System Access API (Chrome or Edge on Windows or Linux) streams incoming data straight to disk, so multi-gigabyte files are fine. Firefox, Safari and every phone browser — Chrome on Android included — don't have that API, so there the batch is assembled in memory instead, and Relayium warns the receiver before they accept once it passes roughly 256 MB. Read that as a deliberately cautious estimate rather than a hard ceiling: where it actually gives out depends on the device's memory, its OS and how many tabs are open.",
        "Folders work too: pick a folder on desktop (not iOS) and relative paths are preserved. If the receiving browser can write straight to a chosen directory (desktop Chrome or Edge) files land in place; otherwise (Firefox, Safari, any phone browser) the whole folder arrives as one .zip that unpacks to the same structure.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is there an official AirDrop app for Windows or Android?",
        a: "No — AirDrop is exclusive to Apple devices and Apple has never shipped a Windows or Android client. Relayium is a browser-based equivalent: open relayium.com on both devices and it works the same way regardless of platform, including mixed Apple/non-Apple pairs.",
      },
      {
        q: "Do I need an account?",
        a: "Not for the same-Wi-Fi flow — open the page on both devices and they discover each other, no sign-in at all. Sending across different networks with a pairing code requires the sender to sign in; the person receiving never needs an account, on either network mode.",
      },
      {
        q: "Do I need to install anything?",
        a: "No. It's a web page on every platform — Windows, Linux, macOS, Android and iOS — so there's nothing to download from a store and nothing to keep updated.",
      },
      {
        q: "How is this different from the Relayium vs AirDrop comparison?",
        a: "That article is a head-to-head look at where AirDrop is genuinely better (pure-Apple households) and where it falls short. This guide is the how-to for actually getting the AirDrop-like experience when at least one device isn't an Apple one.",
      },
      {
        q: "Can it send to a group, like AirDrop can?",
        a: "On the same network, yes — the local room isn't limited to two devices, so more than one nearby device can receive at once. The pairing-code mode for across-the-internet sending joins exactly two devices, over an encrypted relay.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on your Windows, Linux or Android device and the one you're sending to — no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Windows、Linux、Android 的隔空投送替代方案",
  description:
    "Windows、Linux、Android 都没有官方版 AirDrop——这是最接近的做法：在浏览器里同一 Wi-Fi 即时互传，无需账号、无需安装，还能做到 AirDrop 做不到的跨网络传输。",
  updatedLabel: "最近更新",
  lead: [
    "AirDrop 只活在 Apple 的世界里，这让 Windows、Linux、Android 用户，以及任何混用多种设备的家庭都没有对应的内置方案。本文展示非 Apple 设备最接近 AirDrop 的做法：两端各打开一个网页，文件就传过去了。",
    "这种方式不区分平台，因此也覆盖了 AirDrop 一向处理不好的场景：同一个房间里有 Windows 笔记本、Linux 台式机和 Android 手机，或者这三者再加一台 iPhone。",
  ],
  sections: [
    {
      heading: "类 AirDrop 流程：同一 Wi-Fi，浏览器内完成",
      body: [
        "这正是 AirDrop 为之设计的日常场景，而 Relayium 无需从任何应用商店下载 App 就能做到同样效果。",
      ],
      bullets: [
        "在每台设备上，用任意现代浏览器打开 relayium.com——Windows 上用 Chrome 或 Edge，Linux 上用 Firefox 或 Chrome，Android 上用 Chrome。",
        "在同一 Wi-Fi 下，设备会自动互相发现——不需要配对码、不需要账号、也没有配对步骤，就像 AirDrop 发现附近设备一样。",
        "把文件拖到页面上（也可以整个文件夹拖入，每批最多 1,000 个文件），选中另一台设备，核对两块屏幕上显示的同一段 6 位校验码。",
        "传输会直接点对点地经由你自己的网络进行——中间不会上传到任何服务器。",
      ],
    },
    {
      heading: "跨越互联网：AirDrop 做不到的事",
      body: [
        "AirDrop 只能就近使用——走出蓝牙/Wi-Fi 范围就失灵了。Relayium 的第二种模式正好补上这个空缺：两台设备处在完全不同的网络里，无论在世界的哪个角落。",
        "发送方登录后会拿到一段短配对码（附带加入链接和二维码）；接收方输入这个码，或扫描二维码，或直接打开链接——始终无需账号。这条跨网络的连接走的是加密 TURN 中继，而不是两端直连，这是有意为之：在两个互不相干的网络之间，直连路径通常根本找不到，先去试一遍只会让连接悬着二十秒左右，最后照样落到中继上。文件在离开发送方之前就已完成端到端加密，因此中继全程只转发它无法解开的密文——整条路径依旧是端到端加密的。若连接中断，传输可以断点续传，不必从头再来。",
      ],
    },
    {
      heading: "真正保护文件的是什么",
      body: [
        "上面两种模式都是实时传输，用的是同一套加密：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密，只在两台设备之间协商完成。两端会显示同一段 6 位校验码（SAS），你可据此确认没有人插在中间；每个文件还会用 SHA-256 做端到端校验。",
        "这种模式下服务器不会保存任何东西——一切只在传输期间存在。Relayium 采用 AGPL-3.0 许可开源，代码公开在 github.com/relayium/relayium，机制可审计，而非黑箱。",
      ],
    },
    {
      heading: "诚实说说实际限制",
      body: [
        "因为文件从不落到服务器上，所以没有上传配额——真正的限制取决于用哪个浏览器接收。桌面端支持 File System Access API 的浏览器（Windows 或 Linux 上的 Chrome、Edge）会把收到的数据直接流式写入磁盘，几个 GB 的文件也没问题。Firefox、Safari 以及所有手机浏览器（包括 Android 上的 Chrome）都没有这个 API，这时整批文件只能先攒在内存里，因此一旦超过约 256 MB，Relayium 会在接收方点「接收」之前先提示一次。这个数字要当成刻意取的保守估计，而不是硬上限：真正撑不住的临界点取决于设备内存、系统以及开了多少标签页。",
        "文件夹也支持：在桌面端（非 iOS）选择一个文件夹，相对路径会被保留。如果接收方浏览器能直接写入选定目录（桌面版 Chrome、Edge），文件会各就各位；否则（Firefox、Safari 以及手机浏览器）整个文件夹会作为一个 .zip 到达，解压后结构不变。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Windows 或 Android 有官方版 AirDrop 吗？",
        a: "没有——AirDrop 是 Apple 设备专属，Apple 从未推出过 Windows 或 Android 客户端。Relayium 是基于浏览器的替代方案：在两台设备上打开 relayium.com，无论平台组合如何都能一样使用，包括 Apple 与非 Apple 混搭的情况。",
      },
      {
        q: "需要账号吗？",
        a: "同一 Wi-Fi 下的流程不需要——两端打开网页就能互相发现，完全无需登录。跨不同网络用配对码发送时需要发送方登录；无论哪种网络模式，接收方都始终无需账号。",
      },
      {
        q: "需要安装什么吗？",
        a: "不需要。它在每个平台上都是一个网页——Windows、Linux、macOS、Android 和 iOS——所以不用从应用商店下载，也不用操心更新。",
      },
      {
        q: "这和「Relayium 对比 AirDrop」那篇有什么不同？",
        a: "那篇文章是客观的正面对比，讲清 AirDrop 真正更好的地方（纯 Apple 家庭）以及它的短板。本文则是操作指南，教你在至少一台设备不是 Apple 产品时，如何真正获得类似 AirDrop 的体验。",
      },
      {
        q: "能像 AirDrop 一样发给一群人吗？",
        a: "在同一网络下可以——本地房间不限于两台设备，因此附近不止一台设备可以同时接收。而跨网络的配对码模式只连接两台设备，且经由加密中继完成。",
      },
    ],
  },
  cta: {
    text: "在你的 Windows、Linux 或 Android 设备，以及要发送到的那台设备上打开 Relayium——同一网络下无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Windows・Linux・Android 向け AirDrop 代替",
  description:
    "Windows・Linux・Android には公式の AirDrop がありません。最も近い方法はこちらです：ブラウザで同じ Wi-Fi 内なら即共有、アカウントもインストールも不要、さらに AirDrop にはできないインターネット越しの共有も可能。",
  updatedLabel: "最終更新",
  lead: [
    "AirDrop は Apple の世界の中だけに存在するため、Windows・Linux・Android のユーザー、そして複数の種類の端末が混在する家庭には、内蔵の代替手段がありません。本ガイドは、Apple 以外の端末で AirDrop に最も近い体験を得る方法を示します：両端でウェブページを開くだけで、ファイルが移動します。",
    "この方法はプラットフォームを問わず同じように動作するため、AirDrop がうまく扱えない場面（同じ部屋に Windows ノート、Linux デスクトップ、Android スマホがある、あるいはそれに iPhone まで加わる）もカバーします。",
  ],
  sections: [
    {
      heading: "AirDrop 風の流れ：同じ Wi-Fi で、ブラウザ内完結",
      body: [
        "これはまさに AirDrop が想定する日常的なケースであり、Relayium はどのストアからもアプリを入れることなく同じ体験を実現します。",
      ],
      bullets: [
        "各端末で、任意の最新ブラウザで relayium.com を開きます。Windows なら Chrome か Edge、Linux なら Firefox か Chrome、Android なら Chrome。",
        "同じ Wi-Fi では、端末どうしが自動的に見つけ合います。コードもアカウントもペアリング操作も不要で、AirDrop が近くの端末を発見するのと同じです。",
        "ファイルをページにドラッグします（フォルダごとでも可、1バッチ最大1,000ファイル）。相手の端末を選び、両方の画面に表示された同じ6桁コードを確認します。",
        "転送は自分のネットワーク上で直接ピアツーピアに行われます。途中でどこかのサーバーにアップロードされることはありません。",
      ],
    },
    {
      heading: "インターネット越し：AirDrop にはできないこと",
      body: [
        "AirDrop は近接専用です。Bluetooth や Wi-Fi の範囲外に出ると動かなくなります。Relayium の2つ目のモードはまさにその空白を埋めます：まったく異なるネットワーク上の2台の端末を、世界中どこにいても。",
        "送信側がサインインすると短いペアリングコード（参加リンクと QR コード付き）を受け取ります。受信側はそれを入力するか、QR を読み取るか、リンクを開きます。アカウントは一切不要です。このネットワークをまたぐ接続は、端末同士の直接接続ではなく暗号化された TURN リレー経由で行われます。これは設計上の選択です。無関係な2つのネットワークの間では直接経路がそもそも見つからないことがほとんどで、先に試すと接続が20秒ほど宙づりになったあげく結局リレーに落ち着くからです。ファイルは送信側を出る前にエンドツーエンドで封印されているため、リレーが転送するのは鍵を持たない暗号文だけで、経路全体がエンドツーエンド暗号化のままです。接続が切れても、最初からではなく再開できます。",
      ],
    },
    {
      heading: "実際にファイルを守っているもの",
      body: [
        "上記どちらのモードもリアルタイム転送で、同じ暗号化方式を使います：X25519 の鍵交換で導出した鍵をチャンクごとの AES-256-GCM に使い、2台の端末の間だけで協議されます。両端が同じ6桁の検証コード（ショート認証文字列、SAS）を表示するので、間に誰もいないことを確認でき、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。",
        "このモードではサーバーに何も保存されません。存在するのは転送中の間だけです。Relayium は AGPL-3.0 ライセンスのオープンソースで、コードは github.com/relayium/relayium にあり、ブラックボックスではなく仕組みを検証できます。",
      ],
    },
    {
      heading: "正直に言う実際の制限",
      body: [
        "ファイルがサーバーに置かれることはないため、アップロードの割り当てはありません。実際の上限は、どのブラウザで受信するかで決まります。File System Access API を備えたデスクトップのブラウザ（Windows や Linux の Chrome・Edge）なら、受信データはそのままディスクへストリーミングされるので、数ギガバイトのファイルでも問題ありません。Firefox・Safari・スマホのブラウザ（Android の Chrome も含みます）にはこの API がないため、そこでは受信分をいったんメモリに溜めることになり、およそ 256 MB を超えると Relayium が受信側の承認前に警告を出します。この数値は実測した上限ではなく意図的に控えめに置いた目安と考えてください。実際に立ち行かなくなる地点は、端末のメモリ・OS・開いているタブの数によって変わります。",
        "フォルダにも対応しています。デスクトップ（iOS を除く）でフォルダを選ぶと、相対パスが保たれます。受信側のブラウザが選んだディレクトリへ直接書き込めるなら（デスクトップの Chrome、Edge）ファイルはそのまま収まり、そうでなければ（Firefox、Safari、スマホのブラウザ）フォルダ全体が1つの .zip として届き、展開すると同じ構造になります。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Windows や Android 向けの公式 AirDrop はありますか？",
        a: "ありません。AirDrop は Apple 端末専用で、Apple は Windows や Android 向けクライアントを一度も出していません。Relayium はブラウザベースの代替です。両方の端末で relayium.com を開けば、Apple と非 Apple が混在する組み合わせも含め、プラットフォームを問わず同じように動作します。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "同じ Wi-Fi での流れでは不要です。両端でページを開けば互いを発見し、サインインは一切要りません。異なるネットワークをまたいでペアリングコードで送る場合は送信側のサインインが必要ですが、どちらのネットワークモードでも受信側はアカウント不要です。",
      },
      {
        q: "何かインストールする必要はありますか？",
        a: "いいえ。Windows・Linux・macOS・Android・iOS のどれでもウェブページなので、ストアからダウンロードする必要も、更新し続ける必要もありません。",
      },
      {
        q: "「Relayium と AirDrop の比較」記事とは何が違いますか？",
        a: "あの記事は、AirDrop が本当に優れている点（純 Apple の家庭）とその限界を正面から比較したものです。本ガイドは、少なくとも1台が Apple 端末でないときに、実際に AirDrop 風の体験を得るための手順書です。",
      },
      {
        q: "AirDrop のように複数人へ送れますか？",
        a: "同じネットワーク上でなら可能です。ローカルの部屋は2台に限定されないため、近くの複数端末が同時に受信できます。インターネット越しのペアリングコードモードは、暗号化リレーを介した2台の端末どうしの接続です。",
      },
    ],
  },
  cta: {
    text: "お使いの Windows・Linux・Android 端末と、送り先の端末で Relayium を開いてください。同じネットワークならアカウントは不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Windows·Linux·Android용 AirDrop 대안",
  description:
    "Windows·Linux·Android에는 공식 AirDrop이 없습니다 — 가장 가까운 방법은 이것입니다: 브라우저에서 같은 Wi-Fi로 즉시 공유, 계정도 설치도 불필요, 게다가 AirDrop이 못 하는 인터넷 너머 전송까지.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "AirDrop은 Apple의 세계 안에만 존재하므로, Windows·Linux·Android 사용자와 여러 종류의 기기가 섞인 가정에는 내장된 대안이 없습니다. 이 가이드는 Apple이 아닌 기기에서 AirDrop과 가장 가까운 경험을 얻는 방법을 보여줍니다 — 양쪽에서 웹 페이지를 열면 파일이 옮겨집니다.",
    "이 방식은 플랫폼과 상관없이 똑같이 동작하므로, AirDrop이 잘 다루지 못하는 상황도 다룹니다 — 같은 방에 Windows 노트북, Linux 데스크톱, Android 폰이 함께 있거나, 여기에 iPhone까지 더해진 경우요.",
  ],
  sections: [
    {
      heading: "AirDrop 같은 흐름: 같은 Wi-Fi, 브라우저 안에서",
      body: [
        "이것이 바로 AirDrop이 위해 만들어진 일상적인 상황이며, Relayium은 어느 스토어에서도 앱을 받지 않고 같은 결과를 냅니다.",
      ],
      bullets: [
        "각 기기에서 최신 브라우저로 relayium.com을 엽니다 — Windows는 Chrome이나 Edge, Linux는 Firefox나 Chrome, Android는 Chrome.",
        "같은 Wi-Fi에서는 기기가 자동으로 서로를 찾습니다 — 코드도, 계정도, 페어링 단계도 필요 없이, AirDrop이 근처 기기를 발견하는 것과 같습니다.",
        "파일을 페이지에 끌어다 놓습니다(폴더째로도 가능 — 배치당 최대 1,000개). 상대 기기를 고르고, 두 화면에 표시된 동일한 6자리 코드를 확인합니다.",
        "전송은 여러분 자신의 네트워크를 통해 직접, 피어투피어로 이루어집니다 — 중간에 어떤 서버로도 업로드되지 않습니다.",
      ],
    },
    {
      heading: "인터넷 너머로: AirDrop이 할 수 없는 것",
      body: [
        "AirDrop은 근접 전용입니다 — Bluetooth/Wi-Fi 범위를 벗어나면 작동을 멈춥니다. Relayium의 두 번째 모드가 정확히 그 빈틈을 메웁니다: 완전히 다른 네트워크에 있는 두 기기를, 세계 어디에서든.",
        "보내는 쪽이 로그인하면 짧은 페어링 코드(참여 링크와 QR 코드 포함)를 받습니다. 받는 쪽은 그 코드를 입력하거나, QR을 스캔하거나, 링크를 열면 됩니다 — 계정은 전혀 필요 없습니다. 이 네트워크 간 연결은 기기 사이의 직접 연결이 아니라 암호화된 TURN 릴레이를 거칩니다. 의도된 설계입니다. 서로 무관한 두 네트워크 사이에서는 직접 경로가 아예 없는 경우가 대부분이고, 그것을 먼저 시도하면 연결이 20초쯤 붕 떠 있다가 결국 릴레이로 가게 되기 때문입니다. 파일은 보내는 쪽을 떠나기 전에 종단간으로 봉인되므로 릴레이가 나르는 것은 열 열쇠가 없는 암호문뿐이고, 경로 전체가 종단간 암호화를 유지합니다. 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다.",
      ],
    },
    {
      heading: "실제로 파일을 지키는 것",
      body: [
        "위 두 모드 모두 실시간 전송이며, 같은 암호화 방식을 씁니다: X25519 키 교환으로 도출한 키를 블록별 AES-256-GCM에 사용하며, 오직 두 기기 사이에서만 협상됩니다. 양쪽이 동일한 6자리 검증 코드(짧은 인증 문자열, SAS)를 표시하므로 사이에 아무도 없음을 확인할 수 있고, 각 파일은 SHA-256 해시로 종단간 검증됩니다.",
        "이 모드에서는 서버에 아무것도 저장되지 않습니다 — 전송이 이루어지는 동안만 존재합니다. Relayium은 AGPL-3.0 라이선스로 오픈소스이며 코드는 github.com/relayium/relayium에 있어, 블랙박스가 아니라 검증 가능한 구조입니다.",
      ],
    },
    {
      heading: "솔직한 실제 한계",
      body: [
        "파일이 서버에 놓이는 일이 없으므로 업로드 할당량이 없습니다 — 실제 한계는 어떤 브라우저로 받느냐에 달렸습니다. File System Access API를 갖춘 데스크톱 브라우저(Windows나 Linux의 Chrome, Edge)는 들어오는 데이터를 곧장 디스크로 스트리밍해 수 기가바이트 파일도 괜찮습니다. Firefox와 Safari, 그리고 모든 휴대폰 브라우저(Android의 Chrome 포함)에는 그 API가 없어서 받은 내용을 일단 메모리에 모으게 되며, 대략 256 MB를 넘어서면 Relayium이 받는 쪽이 수락하기 전에 미리 경고합니다. 이 수치는 측정된 상한이 아니라 일부러 보수적으로 잡은 추정치로 보세요. 실제로 버티지 못하는 지점은 기기 메모리와 OS, 열어 둔 탭 수에 따라 달라집니다.",
        "폴더도 지원됩니다: 데스크톱(iOS 제외)에서 폴더를 고르면 상대 경로가 유지됩니다. 받는 쪽 브라우저가 선택한 디렉터리에 바로 쓸 수 있으면(데스크톱 Chrome, Edge) 파일이 그대로 자리를 잡고, 그렇지 않으면(Firefox, Safari, 휴대폰 브라우저) 폴더 전체가 하나의 .zip으로 도착해 풀면 같은 구조가 됩니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Windows나 Android용 공식 AirDrop이 있나요?",
        a: "없습니다 — AirDrop은 Apple 기기 전용이며 Apple은 Windows나 Android용 클라이언트를 낸 적이 없습니다. Relayium은 브라우저 기반 대안입니다. 두 기기에서 relayium.com을 열면, Apple과 비Apple이 섞인 조합을 포함해 플랫폼과 상관없이 똑같이 동작합니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "같은 Wi-Fi 흐름에서는 필요 없습니다 — 양쪽에서 페이지를 열면 서로를 찾고, 로그인이 전혀 필요 없습니다. 다른 네트워크를 넘어 페어링 코드로 보낼 때는 보내는 쪽의 로그인이 필요하지만, 어느 네트워크 모드든 받는 쪽은 계정이 필요 없습니다.",
      },
      {
        q: "뭔가 설치해야 하나요?",
        a: "아니요. Windows·Linux·macOS·Android·iOS 어디서나 웹 페이지이므로 스토어에서 내려받을 것도, 계속 업데이트할 것도 없습니다.",
      },
      {
        q: "'Relayium vs AirDrop' 비교 글과는 무엇이 다른가요?",
        a: "그 글은 AirDrop이 실제로 더 나은 부분(순수 Apple 가정)과 부족한 부분을 정면으로 비교한 글입니다. 이 가이드는 적어도 한 기기가 Apple 제품이 아닐 때 실제로 AirDrop 같은 경험을 얻는 방법을 알려주는 실전 가이드입니다.",
      },
      {
        q: "AirDrop처럼 여러 명에게 보낼 수 있나요?",
        a: "같은 네트워크에서는 가능합니다 — 로컬 방은 두 기기로 제한되지 않으므로 근처의 여러 기기가 동시에 받을 수 있습니다. 인터넷 너머의 페어링 코드 모드는 암호화된 릴레이를 거쳐 두 기기만 잇습니다.",
      },
    ],
  },
  cta: {
    text: "여러분의 Windows·Linux·Android 기기와 보낼 대상 기기에서 Relayium을 여세요 — 같은 네트워크에서는 계정이 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "AirDrop-Alternative für Windows, Linux, Android",
  description:
    "Es gibt kein offizielles AirDrop für Windows, Linux oder Android — hier die nächste Alternative: sofortiges Teilen im selben WLAN im Browser, ohne Konto, ohne Installation, plus eine Möglichkeit übers Internet, die AirDrop nicht kann.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "AirDrop existiert nur in Apples Welt, was allen anderen — Windows, Linux, Android und jedem Haushalt mit gemischten Geräten — kein eingebautes Äquivalent lässt. Diese Anleitung zeigt die nächste Alternative zu AirDrop für Nicht-Apple-Geräte: eine Webseite auf beiden Seiten öffnen, und die Datei bewegt sich einfach.",
    "Es funktioniert unabhängig von der Plattform gleich, deckt also auch den Fall ab, den AirDrop nie gut behandelt: ein Windows-Laptop, ein Linux-Desktop und ein Android-Handy im selben Raum — oder alle drei plus ein iPhone dazu.",
  ],
  sections: [
    {
      heading: "Der AirDrop-ähnliche Ablauf: selbes WLAN, im Browser",
      body: [
        "Das ist der Alltagsfall, für den AirDrop gebaut ist, und Relayium erreicht dasselbe ohne App aus irgendeinem Store.",
      ],
      bullets: [
        "Öffne auf jedem Gerät relayium.com in einem beliebigen modernen Browser — Chrome oder Edge unter Windows, Firefox oder Chrome unter Linux, Chrome unter Android.",
        "Im selben WLAN finden sich die Geräte automatisch — kein Code, kein Konto, kein Pairing-Schritt, genau wie AirDrop nahe Geräte erkennt.",
        "Ziehe Dateien auf die Seite (oder einen ganzen Ordner — bis zu 1.000 Dateien pro Stapel), wähle das andere Gerät und bestätige den übereinstimmenden 6-stelligen Code auf beiden Bildschirmen.",
        "Die Übertragung läuft direkt, Peer-to-Peer, über dein eigenes Netzwerk — dazwischen wird nichts auf einen Server hochgeladen.",
      ],
    },
    {
      heading: "Übers Internet: etwas, das AirDrop nicht kann",
      body: [
        "AirDrop funktioniert nur in der Nähe — verlässt man die Bluetooth-/WLAN-Reichweite, ist Schluss. Der zweite Modus von Relayium schließt genau diese Lücke: zwei Geräte in völlig unterschiedlichen Netzwerken, überall auf der Welt.",
        "Der Absender meldet sich an und erhält einen kurzen Pairing-Code (mit Beitrittslink und QR-Code); der Empfänger gibt ihn ein, scannt den QR-Code oder öffnet den Link — und braucht dabei nie ein Konto. Diese netzübergreifende Verbindung läuft über ein verschlüsseltes TURN-Relay statt direkt zwischen den Geräten, und das ist so gewollt: Zwischen zwei fremden Netzwerken lässt sich meist gar kein direkter Weg finden, und der Versuch würde die Verbindung erst rund 20 Sekunden in der Schwebe lassen, bevor sie ohnehin beim Relay landet. Die Dateien sind versiegelt, bevor sie den Absender verlassen, also leitet das Relay nur Chiffretext weiter, für den es keinen Schlüssel hat — die gesamte Strecke bleibt Ende-zu-Ende-verschlüsselt. Eine abgebrochene Verbindung kann fortgesetzt statt neu gestartet werden.",
      ],
    },
    {
      heading: "Was die Datei tatsächlich schützt",
      body: [
        "Beide obigen Modi sind Echtzeitübertragungen und nutzen dieselbe Verschlüsselung: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, ausgehandelt nur zwischen den beiden Geräten. Beide Seiten zeigen denselben sechsstelligen Verifizierungscode (einen Short Authentication String), sodass du bestätigen kannst, dass niemand dazwischensitzt, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft.",
        "In diesem Modus wird nichts auf einem Server gespeichert — es existiert nur für die Dauer der Übertragung. Relayium ist quelloffen unter der AGPL-3.0-Lizenz auf github.com/relayium/relayium, die Mechanik ist also prüfbar statt eine Blackbox.",
      ],
    },
    {
      heading: "Die praktischen Grenzen, ehrlich gesagt",
      body: [
        "Da die Datei nie auf einem Server landet, gibt es kein Upload-Kontingent — die echte Grenze hängt davon ab, welcher Browser empfängt. Ein Desktop-Browser mit der File System Access API (Chrome oder Edge unter Windows oder Linux) streamt eingehende Daten direkt auf die Festplatte, mehrere Gigabyte große Dateien sind also kein Problem. Firefox, Safari und sämtliche Handy-Browser — Chrome unter Android eingeschlossen — haben diese API nicht, dort sammelt sich der Empfang stattdessen im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium den Empfänger, bevor er annimmt. Versteh diesen Wert als bewusst vorsichtige Schätzung und nicht als harte Obergrenze: Wo es tatsächlich versagt, hängt vom Arbeitsspeicher des Geräts, vom Betriebssystem und von der Zahl der offenen Tabs ab.",
        "Ordner funktionieren ebenfalls: Wähle am Desktop (nicht unter iOS) einen Ordner, relative Pfade bleiben erhalten. Kann der empfangende Browser direkt in ein gewähltes Verzeichnis schreiben (Chrome oder Edge am Desktop), landen die Dateien dort; sonst (Firefox, Safari, jeder Handy-Browser) kommt der gesamte Ordner als eine .zip-Datei an, die sich zur selben Struktur entpackt.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Gibt es eine offizielle AirDrop-App für Windows oder Android?",
        a: "Nein — AirDrop ist Apple-Geräten vorbehalten, und Apple hat nie einen Windows- oder Android-Client herausgebracht. Relayium ist eine browserbasierte Alternative: Öffne relayium.com auf beiden Geräten, und es funktioniert unabhängig von der Plattform gleich, auch bei gemischten Apple-/Nicht-Apple-Paaren.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Für den Ablauf im selben WLAN nicht — öffne die Seite auf beiden Geräten, und sie erkennen sich, ganz ohne Anmeldung. Das Senden über verschiedene Netzwerke mit einem Pairing-Code erfordert die Anmeldung des Absenders; der Empfänger braucht in keinem der beiden Netzwerkmodi je ein Konto.",
      },
      {
        q: "Muss ich etwas installieren?",
        a: "Nein. Es ist auf jeder Plattform eine Webseite — Windows, Linux, macOS, Android und iOS —, es gibt also nichts aus einem Store herunterzuladen und nichts aktuell zu halten.",
      },
      {
        q: "Wie unterscheidet sich das vom Vergleich Relayium vs. AirDrop?",
        a: "Jener Artikel ist ein direkter Vergleich, wo AirDrop wirklich besser ist (reine Apple-Haushalte) und wo es an Grenzen stößt. Diese Anleitung ist die Schritt-für-Schritt-Version, um tatsächlich das AirDrop-ähnliche Erlebnis zu bekommen, wenn mindestens ein Gerät kein Apple-Gerät ist.",
      },
      {
        q: "Kann ich, wie bei AirDrop, an mehrere gleichzeitig senden?",
        a: "Im selben Netzwerk ja — der lokale Raum ist nicht auf zwei Geräte begrenzt, sodass mehr als ein nahes Gerät gleichzeitig empfangen kann. Der Pairing-Code-Modus fürs Senden übers Internet verbindet genau zwei Geräte, und zwar über ein verschlüsseltes Relay.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf deinem Windows-, Linux- oder Android-Gerät und auf dem Zielgerät — im selben Netz ist kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "AirDrop pour Windows, Linux et Android",
  description:
    "Il n'existe pas d'AirDrop officiel pour Windows, Linux ou Android — voici ce qui s'en rapproche le plus : partage instantané sur le même Wi-Fi dans le navigateur, sans compte, sans installation, plus une façon de traverser internet qu'AirDrop ne sait pas faire.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "AirDrop n'existe que dans le monde d'Apple, ce qui laisse tous les autres — Windows, Linux, Android, et tout foyer avec des appareils mélangés — sans équivalent intégré. Ce guide montre ce qui se rapproche le plus d'AirDrop pour les appareils non-Apple : ouvrir une page web des deux côtés, et le fichier se déplace tout simplement.",
    "Cela fonctionne de la même façon quelle que soit la plateforme, couvrant donc aussi le cas qu'AirDrop ne gère jamais bien : un portable Windows, un poste Linux et un téléphone Android dans la même pièce — ou les trois plus un iPhone en plus.",
  ],
  sections: [
    {
      heading: "Le flux façon AirDrop : même Wi-Fi, dans le navigateur",
      body: [
        "C'est le cas quotidien pour lequel AirDrop est conçu, et Relayium l'égale sans nécessiter d'appli d'aucune boutique.",
      ],
      bullets: [
        "Sur chaque appareil, ouvrez relayium.com dans n'importe quel navigateur moderne — Chrome ou Edge sous Windows, Firefox ou Chrome sous Linux, Chrome sous Android.",
        "Sur le même Wi-Fi, les appareils se trouvent automatiquement — pas de code, pas de compte, pas d'étape d'appairage, tout comme AirDrop découvre les appareils proches.",
        "Glissez des fichiers sur la page (ou tout un dossier — jusqu'à 1 000 fichiers par lot), choisissez l'autre appareil et confirmez le code à 6 chiffres identique affiché sur les deux écrans.",
        "Le transfert s'effectue directement, en pair-à-pair, sur votre propre réseau — rien n'est envoyé sur un serveur entre les deux.",
      ],
    },
    {
      heading: "À travers internet : ce qu'AirDrop ne sait pas faire",
      body: [
        "AirDrop fonctionne uniquement à proximité — sortez de la portée Bluetooth/Wi-Fi et il s'arrête. Le second mode de Relayium comble exactement ce manque : deux appareils sur des réseaux totalement différents, n'importe où dans le monde.",
        "L'expéditeur se connecte et obtient un court code d'appairage (avec un lien de participation et un QR code) ; le destinataire le saisit, scanne le QR code, ou ouvre le lien — sans jamais avoir besoin de compte. Cette connexion entre réseaux passe par un relais TURN chiffré plutôt que par une liaison directe, et c'est voulu : entre deux réseaux étrangers l'un à l'autre, une voie directe est généralement introuvable, et la chercher d'abord laisserait la connexion en suspens une vingtaine de secondes avant d'aboutir malgré tout au relais. Les fichiers sont scellés de bout en bout avant de quitter l'expéditeur : le relais ne transmet donc que du texte chiffré qu'aucune clé ne lui permet d'ouvrir, et tout le trajet reste chiffré de bout en bout. Une connexion coupée peut reprendre au lieu de repartir de zéro.",
      ],
    },
    {
      heading: "Ce qui protège réellement le fichier",
      body: [
        "Les deux modes ci-dessus sont des transferts en temps réel et utilisent le même chiffrement : un échange de clés X25519 dérive une clé utilisée pour un AES-256-GCM par bloc, négocié uniquement entre les deux appareils. Les deux côtés affichent le même code de vérification à 6 chiffres (une chaîne d'authentification courte), ce qui vous permet de confirmer que personne ne s'intercale, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256.",
        "Rien n'est stocké sur un serveur dans ce mode — il n'existe que pour la durée du transfert. Relayium est open source sous licence AGPL-3.0 sur github.com/relayium/relayium, la mécanique est donc auditable plutôt qu'une boîte noire.",
      ],
    },
    {
      heading: "Les limites pratiques, en toute franchise",
      body: [
        "Comme le fichier n'atterrit jamais sur un serveur, il n'y a pas de quota de téléversement — la vraie limite dépend du navigateur qui reçoit. Un navigateur de bureau doté de l'API File System Access (Chrome ou Edge sous Windows ou Linux) écrit les données entrantes en flux directement sur le disque, donc les fichiers de plusieurs gigaoctets passent sans souci. Firefox, Safari et tous les navigateurs de téléphone — Chrome sous Android compris — n'ont pas cette API : la réception y est assemblée en mémoire, et Relayium prévient le destinataire avant qu'il accepte dès que l'on dépasse environ 256 Mo. À prendre comme une estimation volontairement prudente, pas comme un plafond mesuré : le point où cela lâche vraiment dépend de la mémoire de l'appareil, de son système et du nombre d'onglets ouverts.",
        "Les dossiers fonctionnent aussi : choisissez un dossier sur ordinateur (pas sous iOS) et les chemins relatifs sont conservés. Si le navigateur qui reçoit peut écrire directement dans un répertoire choisi (Chrome ou Edge sur ordinateur), les fichiers s'y placent ; sinon (Firefox, Safari, tout navigateur de téléphone) tout le dossier arrive sous forme d'un seul .zip qui se décompresse en gardant la même structure.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Existe-t-il une appli AirDrop officielle pour Windows ou Android ?",
        a: "Non — AirDrop est exclusif aux appareils Apple, et Apple n'a jamais publié de client Windows ou Android. Relayium est une alternative basée sur le navigateur : ouvrez relayium.com sur les deux appareils, et cela fonctionne de la même façon quelle que soit la plateforme, y compris pour des paires Apple/non-Apple mélangées.",
      },
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Pas pour le flux sur le même Wi-Fi — ouvrez la page sur les deux appareils et ils se découvrent, sans aucune connexion. Envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte ; le destinataire n'a jamais besoin de compte, dans aucun des deux modes réseau.",
      },
      {
        q: "Dois-je installer quelque chose ?",
        a: "Non. C'est une page web sur chaque plateforme — Windows, Linux, macOS, Android et iOS — donc rien à télécharger depuis une boutique et rien à maintenir à jour.",
      },
      {
        q: "En quoi est-ce différent de la comparaison Relayium vs AirDrop ?",
        a: "Cet article-là est une comparaison frontale montrant où AirDrop est réellement meilleur (foyers tout-Apple) et où il atteint ses limites. Ce guide-ci est le mode d'emploi pour obtenir concrètement l'expérience façon AirDrop quand au moins un appareil n'est pas Apple.",
      },
      {
        q: "Puis-je envoyer à un groupe, comme avec AirDrop ?",
        a: "Sur le même réseau, oui — la salle locale n'est pas limitée à deux appareils, donc plusieurs appareils proches peuvent recevoir en même temps. Le mode par code d'appairage pour l'envoi à travers internet relie exactement deux appareils, via un relais chiffré.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur votre appareil Windows, Linux ou Android et sur celui de destination — sans compte nécessaire sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "AirDrop لأنظمة Windows وLinux وAndroid",
  description:
    "لا يوجد AirDrop رسمي لأنظمة Windows أو Linux أو Android — وهذا أقرب بديل: مشاركة فورية على نفس شبكة Wi-Fi من داخل المتصفح، دون حساب ودون تثبيت، بالإضافة إلى طريقة للوصول عبر الإنترنت لا يقدر عليها AirDrop.",
  updatedLabel: "آخر تحديث",
  lead: [
    "لا يوجد AirDrop إلا داخل عالم Apple، ما يترك الجميع عداه — Windows وLinux وAndroid وأي منزل يجمع بين أجهزة متنوعة — دون بديل مدمج. يعرض هذا الدليل أقرب بديل لـ AirDrop للأجهزة غير التابعة لـ Apple: افتح صفحة ويب على الطرفين، وينتقل الملف من تلقاء نفسه.",
    "يعمل بالطريقة نفسها بصرف النظر عن المنصة، لذا فهو يغطي أيضًا الحالة التي لم يُحسن AirDrop التعامل معها قط: حاسوب محمول بنظام Windows وحاسوب مكتبي بنظام Linux وهاتف Android في الغرفة نفسها، أو الثلاثة جميعًا مع إضافة iPhone.",
  ],
  sections: [
    {
      heading: "الأسلوب الشبيه بـ AirDrop: نفس شبكة Wi-Fi، من داخل المتصفح",
      body: [
        "هذه هي الحالة اليومية التي صُمم AirDrop من أجلها، وRelayium يضاهيها دون الحاجة إلى تطبيق من أي متجر.",
      ],
      bullets: [
        "على كل جهاز، افتح relayium.com في أي متصفح حديث — Chrome أو Edge على Windows، وFirefox أو Chrome على Linux، وChrome على Android.",
        "على نفس شبكة Wi-Fi، تعثر الأجهزة على بعضها تلقائيًا — دون رمز ودون حساب ودون خطوة اقتران، تمامًا كما يكتشف AirDrop الأجهزة القريبة.",
        "اسحب الملفات إلى الصفحة (أو مجلدًا كاملًا — حتى 1,000 ملف في كل دفعة)، واختر الجهاز الآخر، وأكِّد رمز التحقق المكوَّن من 6 أرقام المتطابق المعروض على الشاشتين.",
        "يجري النقل مباشرةً، من الند للند (P2P)، عبر شبكتك الخاصة — دون رفع أي شيء إلى خادم في المنتصف.",
      ],
    },
    {
      heading: "عبر الإنترنت: أمر لا يقدر عليه AirDrop",
      body: [
        "يعمل AirDrop في النطاق القريب فقط — إذا خرجت عن نطاق Bluetooth/Wi-Fi توقف عن العمل. يسد الوضع الثاني في Relayium هذه الثغرة بالضبط: جهازان على شبكتين مختلفتين تمامًا، في أي مكان في العالم.",
        "يسجّل المُرسِل الدخول ويحصل على رمز اقتران قصير (مع رابط انضمام ورمز QR)؛ ويُدخله المُستقبِل، أو يمسح رمز QR، أو يفتح الرابط — دون أن يحتاج إلى حساب مطلقًا. وهذا الاتصال عبر الشبكات يجري عبر مُرحِّل TURN مُشفَّر لا عبر وصلة مباشرة بين الجهازين، وذلك بحكم التصميم: فبين شبكتين لا صلة بينهما يتعذّر في الغالب إيجاد مسار مباشر، ومحاولته أولًا تترك الاتصال معلّقًا نحو عشرين ثانية قبل أن ينتهي إلى المُرحِّل على أي حال. والملفات مختومة من الطرف إلى الطرف قبل أن تغادر المُرسِل، فلا يُمرِّر المُرحِّل سوى نص مُشفَّر لا يملك مفتاحه — ويبقى المسار كله مُشفَّرًا من الطرف إلى الطرف. ويمكن للاتصال المنقطع أن يستأنف بدلًا من البدء من الصفر.",
      ],
    },
    {
      heading: "ما الذي يحمي الملف فعليًا",
      body: [
        "كلا الوضعين أعلاه نقل فوري، وكلاهما يستخدم التشفير نفسه: تبادل مفاتيح X25519 يشتق مفتاحًا يُستخدم في AES-256-GCM لكل كتلة، ويُتفاوض عليه بين الجهازين فقط. ويعرض الطرفان رمز التحقق نفسه المكوَّن من 6 أرقام (سلسلة مصادقة قصيرة، SAS) كي تتأكد من عدم وجود أحد في المنتصف، ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256.",
        "لا يُخزَّن أي شيء على خادم في هذا الوضع — فهو لا يوجد إلا طوال مدة النقل. وRelayium مفتوح المصدر بموجب رخصة AGPL-3.0 على github.com/relayium/relayium، فآليته قابلة للتدقيق وليست صندوقًا أسود.",
      ],
    },
    {
      heading: "الحدود العملية، بكل صراحة",
      body: [
        "بما أن الملف لا يستقر على خادم أبدًا، فلا توجد حصة رفع — الحد الحقيقي هو المتصفح الذي يستقبل. متصفح حاسوب مكتبي يدعم واجهة File System Access (‏Chrome أو Edge على Windows أو Linux) يبثّ البيانات الواردة مباشرةً إلى القرص، فالملفات التي تبلغ عدة غيغابايت لا مشكلة فيها. أما Firefox وSafari وكل متصفحات الهواتف — بما فيها Chrome على Android — فلا تملك تلك الواجهة، فتُجمَّع الدفعة في الذاكرة بدلًا من ذلك، وينبّه Relayium المُستقبِل قبل القبول متى تجاوزت نحو 256 ميغابايت. واعتبر ذلك تقديرًا متحفّظًا عن قصد لا سقفًا مقيسًا: فالنقطة التي ينهار عندها فعلًا تتوقف على ذاكرة الجهاز ونظامه وعدد علامات التبويب المفتوحة.",
        "المجلدات تعمل أيضًا: اختر مجلدًا على الحاسوب المكتبي (لا على iOS) وتُحفَظ المسارات النسبية. إذا كان المتصفح المُستقبِل قادرًا على الكتابة مباشرةً في دليل مُختار (‏Chrome أو Edge على الحاسوب المكتبي) فإن الملفات تستقر في مكانها؛ وإلا (Firefox، Safari، وأي متصفح هاتف) يصل المجلد بأكمله في ملف .zip واحد يُفَك إلى البنية نفسها.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يوجد تطبيق AirDrop رسمي لنظام Windows أو Android؟",
        a: "لا — AirDrop حصري لأجهزة Apple، ولم تُطلق Apple قط عميلًا لـ Windows أو Android. وRelayium بديل يعمل في المتصفح: افتح relayium.com على الجهازين وسيعمل بالطريقة نفسها بصرف النظر عن المنصة، بما في ذلك الأزواج المختلطة من أجهزة Apple وغير Apple.",
      },
      {
        q: "هل أحتاج إلى حساب؟",
        a: "ليس في أسلوب نفس شبكة Wi-Fi — افتح الصفحة على الجهازين فيكتشف كل منهما الآخر، دون أي تسجيل دخول. أما الإرسال عبر شبكات مختلفة برمز اقتران فيتطلب من المُرسِل تسجيل الدخول؛ والشخص المُستقبِل لا يحتاج إلى حساب مطلقًا في أي من وضعي الشبكة.",
      },
      {
        q: "هل أحتاج إلى تثبيت أي شيء؟",
        a: "لا. إنه صفحة ويب على كل منصة — Windows وLinux وmacOS وAndroid وiOS — فلا شيء يُنزَّل من متجر ولا شيء يحتاج إلى تحديث مستمر.",
      },
      {
        q: "بمَ يختلف هذا عن مقارنة Relayium مقابل AirDrop؟",
        a: "ذلك المقال نظرة مباشرة تُقارِن بين ما يتفوق فيه AirDrop حقًا (المنازل التي تقتصر على أجهزة Apple) وما يقصّر فيه. أما هذا الدليل فهو الشرح العملي للحصول فعليًا على تجربة شبيهة بـ AirDrop حين لا يكون جهاز واحد على الأقل من أجهزة Apple.",
      },
      {
        q: "هل يمكنه الإرسال إلى مجموعة، كما يستطيع AirDrop؟",
        a: "على نفس الشبكة، نعم — الغرفة المحلية ليست مقصورة على جهازين، فيمكن لأكثر من جهاز قريب أن يستقبل في آنٍ واحد. أما وضع رمز الاقتران للإرسال عبر الإنترنت فيصل بين جهازين اثنين فقط، عبر مُرحِّل مُشفَّر.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على جهازك بنظام Windows أو Linux أو Android وعلى الجهاز الذي تُرسِل إليه — دون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "AirDrop para Windows, Linux y Android",
  description:
    "No existe un AirDrop oficial para Windows, Linux ni Android — esto es lo más parecido: compartir al instante en la misma Wi-Fi desde el navegador, sin cuenta, sin instalación, además de una forma de llegar a través de internet que AirDrop no puede.",
  updatedLabel: "Última actualización",
  lead: [
    "AirDrop solo existe dentro del mundo de Apple, lo que deja a todos los demás — Windows, Linux, Android y cualquier hogar con una mezcla de dispositivos — sin un equivalente integrado. Esta guía muestra lo más parecido a AirDrop para dispositivos que no son de Apple: abre una página web en ambos extremos y el archivo simplemente se mueve.",
    "Funciona igual sea cual sea la plataforma, así que también cubre el caso que AirDrop nunca gestiona bien: un portátil con Windows, un ordenador de escritorio con Linux y un teléfono Android todos en la misma habitación, o los tres más un iPhone añadido.",
  ],
  sections: [
    {
      heading: "El flujo tipo AirDrop: misma Wi-Fi, en el navegador",
      body: [
        "Este es el caso cotidiano para el que se creó AirDrop, y Relayium lo iguala sin necesidad de una app de ninguna tienda.",
      ],
      bullets: [
        "En cada dispositivo, abre relayium.com en cualquier navegador moderno — Chrome o Edge en Windows, Firefox o Chrome en Linux, Chrome en Android.",
        "En la misma Wi-Fi, los dispositivos se encuentran automáticamente — sin código, sin cuenta, sin paso de emparejamiento, igual que AirDrop descubre los dispositivos cercanos.",
        "Arrastra archivos a la página (o una carpeta entera — hasta 1.000 archivos por lote), elige el otro dispositivo y confirma el código de 6 dígitos coincidente que se muestra en ambas pantallas.",
        "La transferencia se ejecuta directamente, de igual a igual, por tu propia red — nada se sube a un servidor en medio.",
      ],
    },
    {
      heading: "A través de internet: algo que AirDrop no puede hacer",
      body: [
        "AirDrop es solo de cercanía — sal del alcance de Bluetooth/Wi-Fi y deja de funcionar. El segundo modo de Relayium cubre exactamente ese hueco: dos dispositivos en redes completamente distintas, en cualquier parte del mundo.",
        "El remitente inicia sesión y obtiene un código de emparejamiento corto (con un enlace para unirse y un código QR); el destinatario lo introduce, escanea el QR o abre el enlace — y nunca necesita una cuenta. Esa conexión entre redes va por un retransmisor TURN cifrado en lugar de por un enlace directo, y es así por diseño: entre dos redes ajenas la una a la otra casi nunca hay una ruta directa, e intentarla primero dejaría la conexión en el aire unos veinte segundos antes de acabar igualmente en el retransmisor. Los archivos van sellados de extremo a extremo antes de salir del remitente, así que el retransmisor solo reenvía texto cifrado que no tiene clave para abrir — todo el trayecto sigue cifrado de extremo a extremo. Una conexión caída puede reanudarse en lugar de empezar de cero.",
      ],
    },
    {
      heading: "Qué protege realmente el archivo",
      body: [
        "Ambos modos anteriores son transferencias en tiempo real, y ambos usan el mismo cifrado: un intercambio de claves X25519 deriva una clave que se usa para AES-256-GCM por bloque, negociada solo entre los dos dispositivos. Ambos lados muestran el mismo código de verificación de 6 dígitos (una Short Authentication String) para que puedas confirmar que nadie está en medio, y cada archivo se comprueba de extremo a extremo con un hash SHA-256.",
        "En este modo no se almacena nada en un servidor — existe solo durante la transferencia. Relayium es de código abierto bajo la licencia AGPL-3.0 en github.com/relayium/relayium, así que su mecánica es auditable en lugar de una caja negra.",
      ],
    },
    {
      heading: "Los límites prácticos, con honestidad",
      body: [
        "Como el archivo nunca llega a un servidor, no hay cuota de subida — el límite real es qué navegador está recibiendo. Un navegador de escritorio con la API File System Access (Chrome o Edge en Windows o Linux) transmite los datos entrantes directamente al disco, así que los archivos de varios gigabytes no dan problema. Firefox, Safari y todos los navegadores de móvil — incluido Chrome en Android — no tienen esa API, así que ahí la recepción se acumula en memoria y Relayium avisa a quien recibe antes de que acepte en cuanto se pasa de unos 256 MB. Tómalo como una estimación deliberadamente prudente, no como un techo medido: dónde cede de verdad depende de la memoria del dispositivo, de su sistema y de cuántas pestañas haya abiertas.",
        "Las carpetas también funcionan: elige una carpeta en el escritorio (no en iOS) y se conservan las rutas relativas. Si el navegador receptor puede escribir directamente en un directorio elegido (Chrome o Edge de escritorio) los archivos se colocan en su sitio; si no (Firefox, Safari, cualquier navegador de móvil) toda la carpeta llega como un único .zip que se descomprime con la misma estructura.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Hay una app oficial de AirDrop para Windows o Android?",
        a: "No — AirDrop es exclusivo de los dispositivos de Apple y Apple nunca ha lanzado un cliente para Windows ni Android. Relayium es un equivalente basado en navegador: abre relayium.com en ambos dispositivos y funciona igual sea cual sea la plataforma, incluidas las parejas mixtas de Apple y no Apple.",
      },
      {
        q: "¿Necesito una cuenta?",
        a: "No para el flujo en la misma Wi-Fi — abre la página en ambos dispositivos y se descubren, sin ningún inicio de sesión. Enviar entre redes distintas con un código de emparejamiento requiere que el remitente inicie sesión; la persona que recibe nunca necesita una cuenta, en ninguno de los dos modos de red.",
      },
      {
        q: "¿Necesito instalar algo?",
        a: "No. Es una página web en todas las plataformas — Windows, Linux, macOS, Android e iOS — así que no hay nada que descargar de una tienda ni nada que mantener actualizado.",
      },
      {
        q: "¿En qué se diferencia esto de la comparativa Relayium frente a AirDrop?",
        a: "Ese artículo es un análisis frente a frente de dónde AirDrop es genuinamente mejor (hogares puramente de Apple) y dónde se queda corto. Esta guía es el tutorial para conseguir de verdad la experiencia tipo AirDrop cuando al menos un dispositivo no es de Apple.",
      },
      {
        q: "¿Puede enviar a un grupo, como hace AirDrop?",
        a: "En la misma red, sí — la sala local no se limita a dos dispositivos, así que más de un dispositivo cercano puede recibir a la vez. El modo con código de emparejamiento para enviar a través de internet une exactamente a dos dispositivos, a través de un retransmisor cifrado.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en tu dispositivo Windows, Linux o Android y en aquel al que envías — sin cuenta necesaria en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "AirDrop para Windows, Linux e Android",
  description:
    "Não existe um AirDrop oficial para Windows, Linux ou Android — aqui está o mais próximo: compartilhamento instantâneo na mesma rede Wi-Fi pelo navegador, sem conta, sem instalação, além de um jeito de alcançar pela internet que o AirDrop não consegue.",
  updatedLabel: "Última atualização",
  lead: [
    "O AirDrop só existe dentro do mundo da Apple, o que deixa todos os demais — Windows, Linux, Android e qualquer casa com uma mistura de dispositivos — sem um equivalente embutido. Este guia mostra o mais próximo do AirDrop para dispositivos que não são da Apple: abra uma página web nas duas pontas e o arquivo simplesmente se move.",
    "Funciona da mesma forma independentemente da plataforma, então também cobre o caso que o AirDrop nunca lida bem: um notebook com Windows, um desktop com Linux e um celular Android todos na mesma sala, ou os três mais um iPhone incluído.",
  ],
  sections: [
    {
      heading: "O fluxo estilo AirDrop: mesma rede Wi-Fi, no navegador",
      body: [
        "Este é o caso do dia a dia para o qual o AirDrop foi feito, e o Relayium o iguala sem precisar de um app de nenhuma loja.",
      ],
      bullets: [
        "Em cada dispositivo, abra relayium.com em qualquer navegador moderno — Chrome ou Edge no Windows, Firefox ou Chrome no Linux, Chrome no Android.",
        "Na mesma rede Wi-Fi, os dispositivos se encontram automaticamente — sem código, sem conta, sem etapa de emparelhamento, assim como o AirDrop descobre dispositivos próximos.",
        "Arraste arquivos para a página (ou uma pasta inteira — até 1.000 arquivos por lote), escolha o outro dispositivo e confirme o código de 6 dígitos correspondente exibido nas duas telas.",
        "A transferência ocorre diretamente, ponto a ponto, pela sua própria rede — nada é enviado para um servidor no meio.",
      ],
    },
    {
      heading: "Pela internet: algo que o AirDrop não consegue fazer",
      body: [
        "O AirDrop é só de proximidade — saia do alcance de Bluetooth/Wi-Fi e ele para de funcionar. O segundo modo do Relayium cobre exatamente essa lacuna: dois dispositivos em redes completamente diferentes, em qualquer lugar do mundo.",
        "O remetente entra e recebe um código de emparelhamento curto (com um link de entrada e um código QR); o destinatário o digita, escaneia o QR ou abre o link — e nunca precisa de conta. Essa conexão entre redes passa por um retransmissor TURN criptografado em vez de uma ligação direta, e isso é proposital: entre duas redes sem relação uma com a outra quase nunca existe caminho direto, e tentá-lo primeiro deixaria a conexão pendurada por uns vinte segundos antes de terminar no retransmissor mesmo assim. Os arquivos saem selados de ponta a ponta antes de deixar o remetente, então o retransmissor só encaminha texto cifrado que não tem chave para abrir — o trajeto inteiro continua criptografado de ponta a ponta. Uma conexão caída pode ser retomada em vez de recomeçar do zero.",
      ],
    },
    {
      heading: "O que realmente protege o arquivo",
      body: [
        "Ambos os modos acima são transferências em tempo real, e ambos usam a mesma criptografia: uma troca de chaves X25519 deriva uma chave usada para AES-256-GCM por bloco, negociada apenas entre os dois dispositivos. Os dois lados exibem o mesmo código de verificação de 6 dígitos (uma Short Authentication String) para que você possa confirmar que ninguém está no meio, e cada arquivo é verificado de ponta a ponta com um hash SHA-256.",
        "Nesse modo, nada é armazenado em um servidor — existe apenas durante a transferência. O Relayium é de código aberto sob a licença AGPL-3.0 em github.com/relayium/relayium, então a mecânica é auditável em vez de uma caixa-preta.",
      ],
    },
    {
      heading: "Os limites práticos, com honestidade",
      body: [
        "Como o arquivo nunca aterrissa em um servidor, não há cota de upload — o limite real é qual navegador está recebendo. Um navegador de computador com a API File System Access (Chrome ou Edge no Windows ou Linux) grava os dados que chegam direto no disco, então arquivos de vários gigabytes não são problema. Firefox, Safari e todos os navegadores de celular — Chrome no Android incluído — não têm essa API, então neles o lote é montado na memória, e o Relayium avisa quem recebe antes de aceitar assim que passa de cerca de 256 MB. Encare esse número como uma estimativa propositalmente conservadora, não como um teto medido: o ponto em que realmente cede depende da memória do aparelho, do sistema e de quantas abas estão abertas.",
        "Pastas também funcionam: escolha uma pasta no desktop (não no iOS) e os caminhos relativos são preservados. Se o navegador receptor puder gravar direto em um diretório escolhido (Chrome ou Edge no computador), os arquivos ficam em seus lugares; caso contrário (Firefox, Safari, qualquer navegador de celular), a pasta inteira chega como um único .zip que se descompacta com a mesma estrutura.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Existe um app oficial do AirDrop para Windows ou Android?",
        a: "Não — o AirDrop é exclusivo dos dispositivos da Apple e a Apple nunca lançou um cliente para Windows ou Android. O Relayium é um equivalente baseado em navegador: abra relayium.com nos dois dispositivos e ele funciona da mesma forma independentemente da plataforma, inclusive em pares mistos de Apple e não Apple.",
      },
      {
        q: "Preciso de uma conta?",
        a: "Não para o fluxo na mesma rede Wi-Fi — abra a página nos dois dispositivos e eles se descobrem, sem nenhum login. Enviar entre redes diferentes com um código de emparelhamento exige que o remetente entre; a pessoa que recebe nunca precisa de conta, em nenhum dos dois modos de rede.",
      },
      {
        q: "Preciso instalar alguma coisa?",
        a: "Não. É uma página web em toda plataforma — Windows, Linux, macOS, Android e iOS — então não há nada para baixar de uma loja nem nada para manter atualizado.",
      },
      {
        q: "Qual a diferença entre isto e a comparação Relayium versus AirDrop?",
        a: "Aquele artigo é uma análise frente a frente de onde o AirDrop é genuinamente melhor (casas puramente Apple) e onde ele fica aquém. Este guia é o tutorial para de fato obter a experiência estilo AirDrop quando pelo menos um dispositivo não é da Apple.",
      },
      {
        q: "Dá para enviar para um grupo, como o AirDrop faz?",
        a: "Na mesma rede, sim — a sala local não se limita a dois dispositivos, então mais de um dispositivo próximo pode receber ao mesmo tempo. O modo por código de emparelhamento para envio pela internet liga exatamente dois dispositivos, por um retransmissor criptografado.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium no seu dispositivo Windows, Linux ou Android e naquele para o qual está enviando — sem conta necessária na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/airdrop-for-windows-and-android",
  published: "2026-07-09",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
