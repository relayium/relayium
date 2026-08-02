// web/scripts/pages/content/articles/howto-android-to-iphone.mjs
// How-to: transfer files from Android to iPhone. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "How to transfer files from Android to iPhone (no cable)",
  description:
    "A step-by-step guide to sending photos, videos and documents from Android to iPhone in a browser — no AirDrop, no cable, no cloud upload. Just open Relayium on both devices.",
  updatedLabel: "Last updated",
  lead: [
    "Android and iPhone do not share an AirDrop, so moving a few photos or a video between them usually means a USB cable, a chat app that compresses your images, or a round-trip through some cloud drive. All three are slower and more fiddly than they should be.",
    "Relayium skips all of that. Both phones open the same page: on the same LAN the end-to-end encrypted files travel directly, while across networks a TURN relay carries ciphertext it cannot read or decrypt and keeps no realtime content copy or history. No app is needed; the creator signs in for cross-network pairing, while the person joining never needs an account. This guide walks through it step by step.",
  ],
  sections: [
    {
      heading: "What you need before you start",
      body: [
        "Nothing to install. On the same network there is nothing to sign up for either — realtime transfers work straight from the browser on both devices.",
      ],
      bullets: [
        "An Android phone with Chrome (or any modern browser) and an iPhone with Safari — both up to date.",
        "For the fastest path, put both devices on the same Wi-Fi network. If you can't, that's fine — a pairing code works across different networks too.",
        "The files you want to send, up to 1,000 per batch.",
      ],
    },
    {
      heading: "Step by step: both devices on the same Wi-Fi",
      body: [
        "This is the simplest route. On the same network, the two phones discover each other automatically, so there is almost nothing to type.",
      ],
      bullets: [
        "On both the Android phone and the iPhone, open relayium.com in the browser.",
        "Each device shows up as a nearby device on the other. On the sending phone, tap the receiving one.",
        "Pick the files to send — up to 1,000 per batch — or just drag them in.",
        "If you turned on advanced verification (it is off by default), both screens also show the same 6-digit code — check that they match. A match confirms both phones joined the same end-to-end encrypted session; it does not prove which network path carries the ciphertext. Left off, there is no code to compare and the session is still encrypted.",
        "Accept on the receiving iPhone and the files transfer directly, then save to your device.",
      ],
    },
    {
      heading: "On different networks? Use a pairing code",
      body: [
        "You don't have to be on the same Wi-Fi. If the phones are on different networks — one on mobile data, the other on home Wi-Fi — Relayium can still connect them with a pairing code.",
        "The sending device shows a short pairing code; enter it on the other phone (or open the share link it generates). A transfer set up this way runs over an encrypted TURN relay rather than a direct link between the two phones — and that is deliberate: across two different networks a direct route usually can't be found at all, and trying for one first would stall the connection for around 20 seconds before landing on the relay anyway, so Relayium goes straight there and connects in a second or two. The relay only ever forwards ciphertext; the files are sealed end-to-end before they leave your phone, so it can never read them. If the connection drops mid-transfer, it can resume instead of starting over. Sending this way needs the sender to sign in — the person receiving never needs an account.",
      ],
    },
    {
      heading: "Other ways to move files between Android and iPhone",
      body: [
        "Relayium isn't the only option, and it's worth knowing the honest trade-offs of the alternatives:",
      ],
      bullets: [
        "Google's Quick Share and third-party apps like SHAREit move files quickly, but they need an install on both phones and Quick Share doesn't reach iPhones.",
        "A cloud drive (Google Drive, iCloud, Dropbox) works when the other person is offline, but you upload and then download the same file twice, it counts against your quota, and the provider holds a copy.",
        "Chat apps and email are everywhere, but they usually re-compress photos, cap attachment sizes, and are not end-to-end encrypted for file sharing.",
        "A USB cable is reliable but needs the right adapter between USB-C and Lightning, plus a computer in the middle for many file types.",
      ],
    },
    {
      heading: "Will my photos lose quality?",
      body: [
        "No. Unlike a messaging app, Relayium sends the original file byte-for-byte — no re-compression, no resizing. What lands on the iPhone is an exact copy of what left the Android phone.",
        "To prove it, each file is verified end-to-end with a SHA-256 hash, so a photo or video that arrives is guaranteed identical to the one you sent. Large files are handled well too: a browser with the File System Access API (Chrome or Edge on a desktop) writes the incoming file straight to disk, with no size cap. Firefox, Safari and phone browsers — an iPhone is always WebKit — don't have that API, so there the batch is assembled in memory instead, and Relayium warns you before you accept once it goes past roughly 256 MB. That number is a deliberately cautious estimate rather than a measured ceiling: where it actually breaks down depends on the device's memory, its OS and how many tabs are open.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need to install an app on either phone?",
        a: "No. Relayium runs entirely in the browser on both Android and iPhone. Open relayium.com on each device and you're ready — no download either way. On the same network a realtime transfer needs no account; pairing across networks just asks the sender to sign in. You can optionally add it to your home screen as a PWA, but that's just a shortcut.",
      },
      {
        q: "Do both phones have to be on the same Wi-Fi?",
        a: "No. The same network is the fastest path because the devices discover each other automatically, but a pairing code connects two phones across different networks — even one on mobile data and one on Wi-Fi. The transfer stays end-to-end encrypted in both cases, though pairing across networks requires the sender to sign in — the receiver never needs an account.",
      },
      {
        q: "Are the photos compressed or changed in any way?",
        a: "No. The original file is transferred byte-for-byte with no compression, and each file is checked end-to-end with a SHA-256 hash, so what arrives on the iPhone is bit-for-bit identical to what you sent from Android.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on both phones and send your first files across — no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何把文件从安卓传到 iPhone（无需数据线）",
  description:
    "一步步教你在浏览器里把照片、视频和文档从安卓传到 iPhone——不用 AirDrop、不用数据线、不用上传网盘。两台设备打开 Relayium 即可。",
  updatedLabel: "最近更新",
  lead: [
    "安卓和 iPhone 之间没有互通的 AirDrop，所以在两者间传几张照片或一段视频，往往只能靠 USB 数据线、会压缩画质的聊天软件，或者绕一圈网盘上传下载。三种方式都比本该有的更慢、更折腾。",
    "Relayium 把这些统统省掉。两台手机打开同一个网页：同一局域网内，端到端加密的文件会直接传输；跨网络时，TURN 中继只搬运它无法读取或解密的密文，也不保留实时内容副本或历史。无需安装应用；跨网络配对由创建者登录，加入者始终无需账号。本文一步步带你完成。",
  ],
  sections: [
    {
      heading: "开始前需要准备什么",
      body: [
        "不用安装。同一网络下也不用注册——实时传输在两台设备的浏览器里直接就能用。",
      ],
      bullets: [
        "一台装有 Chrome（或任意现代浏览器）的安卓手机，一台用 Safari 的 iPhone——都保持最新版本。",
        "想要最快的路径，就让两台设备连到同一个 Wi-Fi。如果做不到也没关系——配对码同样能跨越不同网络。",
        "你要发送的文件，每批最多 1,000 个。",
      ],
    },
    {
      heading: "分步操作：两台设备连同一 Wi-Fi",
      body: [
        "这是最简单的方式。在同一网络里，两台手机会自动发现彼此，几乎不用输入任何东西。",
      ],
      bullets: [
        "在安卓手机和 iPhone 上，都在浏览器里打开 relayium.com。",
        "每台设备都会作为附近的设备出现在另一台上。在发送方手机上，点击接收方那台。",
        "选择要发送的文件——每批最多 1,000 个——或者直接拖进去。",
        "如果你打开了高级验证（默认关闭），两边屏幕还会显示同一段 6 位校验码——核对它们是否一致。一致说明两台手机加入了同一个端到端加密会话，但并不证明密文走了哪条网络路径。不打开就没有可核对的码，会话依然是加密的。",
        "在接收方 iPhone 上确认接收，文件就会直接传过来，随后保存到设备里。",
      ],
    },
    {
      heading: "不在同一网络？用配对码",
      body: [
        "你不必连同一个 Wi-Fi。如果两台手机在不同网络——一台用移动数据，另一台用家里的 Wi-Fi——Relayium 依然能用配对码把它们连起来。",
        "发送方设备会显示一段简短的配对码，在另一台手机上输入即可（或打开它生成的分享链接）。这样建立的跨网络传输走的是加密 TURN 中继，而不是两台手机之间的直连——这是刻意的选择：跨越两个不同网络时往往根本找不到直连路径，先试直连只会让连接卡住二十秒左右，最后仍旧落到中继上，所以 Relayium 干脆直接走中继，一两秒就能连上。中继只转发密文；文件在离开你手机之前就已完成端到端加密，中继永远读不到内容。若中途连接断开，可以断点续传，而不必从头再来。这样发送需要发送方登录——接收方始终无需账号。",
      ],
    },
    {
      heading: "在安卓和 iPhone 间传文件的其他方式",
      body: [
        "Relayium 并不是唯一选择，了解各替代方案的取舍也很有必要：",
      ],
      bullets: [
        "谷歌的快速分享（Quick Share）以及 SHAREit 这类第三方 App 传得很快，但两台手机都要安装，而且快速分享无法覆盖 iPhone。",
        "网盘（Google Drive、iCloud、Dropbox）在对方不在线时也能用，但同一个文件要上传再下载两次，会占用你的配额，且服务商手里留有一份副本。",
        "聊天软件和邮件随处可用，但它们通常会重新压缩照片、限制附件大小，且文件分享并非端到端加密。",
        "USB 数据线很可靠，但需要 USB-C 与 Lightning 之间合适的转接头，很多文件类型还得靠中间一台电脑。",
      ],
    },
    {
      heading: "照片会掉画质吗？",
      body: [
        "不会。与聊天软件不同，Relayium 按原文件逐字节发送——不重新压缩、不缩放。落到 iPhone 上的，就是从安卓手机发出的那份的精确副本。",
        "为了证明这一点，每个文件都用 SHA-256 做端到端校验，所以收到的照片或视频保证与你发送的完全一致。大文件也处理得很好：支持 File System Access API 的浏览器（桌面版 Chrome、Edge）会把收到的文件直接流式写入磁盘，没有大小上限。Firefox、Safari 以及手机上的浏览器（iPhone 上一律是 WebKit）没有这个 API，这时整批文件只能先攒在内存里，因此一旦超过约 256 MB，Relayium 会在你点「接收」之前先提示一次。这个数字是刻意取的保守估计，而不是实测出来的硬上限：真正撑不住的临界点取决于设备内存、系统以及开了多少标签页。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "两台手机都要装 App 吗？",
        a: "不用。Relayium 在安卓和 iPhone 上都完全运行于浏览器里。在每台设备上打开 relayium.com 就绪了——无论哪种方式都无需下载。同一网络下实时传输无需账号；跨网络配对只需发送方登录一下。你也可以把它作为 PWA 添加到主屏幕，但那只是个快捷方式。",
      },
      {
        q: "两台手机必须在同一 Wi-Fi 上吗？",
        a: "不必。同一网络是最快的路径，因为设备会自动发现彼此；但配对码能把两台手机跨越不同网络连起来——哪怕一台用移动数据、一台用 Wi-Fi。两种情况下传输都保持端到端加密，不过跨网络配对需要发送方登录——接收方始终无需账号。",
      },
      {
        q: "照片会被压缩或改动吗？",
        a: "不会。原文件按逐字节传输、不做压缩，每个文件还用 SHA-256 做端到端校验，所以到达 iPhone 的内容与你从安卓发出的逐位一致。",
      },
    ],
  },
  cta: {
    text: "在两台手机上打开 Relayium，把第一批文件传过去吧——无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Android から iPhone へファイルを転送する方法（ケーブル不要）",
  description:
    "写真・動画・書類を Android から iPhone へブラウザで送る手順を解説。AirDrop もケーブルもクラウドへのアップロードも不要。両方の端末で Relayium を開くだけです。",
  updatedLabel: "最終更新",
  lead: [
    "Android と iPhone は AirDrop を共有していないため、写真を数枚や動画を1本やり取りするだけでも、USB ケーブル、画質を圧縮するチャットアプリ、あるいはクラウドドライブへのアップロードとダウンロードの往復に頼りがちです。どれも本来より遅く、面倒です。",
    "Relayium はそれをすべて省きます。2台のスマホで同じページを開くと、同じ LAN 内ではエンドツーエンド暗号化されたファイルが直接転送され、ネットワークをまたぐ場合は TURN リレーが読取りも復号もできない暗号文だけを運び、リアルタイム内容のコピーや履歴を残しません。アプリは不要で、ネットワーク越しのペアリングでは作成者がサインインし、参加者にはアカウントが不要です。本記事で手順を順に説明します。",
  ],
  sections: [
    {
      heading: "始める前に必要なもの",
      body: [
        "インストールは不要です。同じネットワークなら登録も不要です。リアルタイム転送は両方の端末のブラウザからそのまま使えます。",
      ],
      bullets: [
        "Chrome（または任意の最新ブラウザ）が入った Android 端末と、Safari を使う iPhone（どちらも最新の状態に）。",
        "最速の経路は、両方の端末を同じ Wi-Fi ネットワークに置くことです。無理でも大丈夫です。ペアリングコードは異なるネットワークをまたいでも機能します。",
        "送りたいファイル、1バッチあたり最大1,000個。",
      ],
    },
    {
      heading: "手順：両方の端末が同じ Wi-Fi の場合",
      body: [
        "これが最もシンプルな経路です。同じネットワークなら2台のスマホが自動的に互いを見つけるので、入力はほとんどありません。",
      ],
      bullets: [
        "Android 端末と iPhone の両方で、ブラウザから relayium.com を開きます。",
        "各端末はもう一方に近くの端末として表示されます。送信側のスマホで、受信側をタップします。",
        "送るファイルを選ぶか（1バッチ最大1,000個）、そのままドラッグして入れます。",
        "高度な検証をオンにしている場合（既定はオフ）、両方の画面に同じ6桁のコードも表示されます。一致するか確認してください。一致は2台が同じエンドツーエンド暗号化セッションに参加したことを確認するもので、暗号文が通るネットワーク経路を証明するものではありません。オフのままなら照合するコードは表示されませんが、セッションは変わらず暗号化されています。",
        "受信側の iPhone で承認するとファイルが直接転送され、端末に保存されます。",
      ],
    },
    {
      heading: "異なるネットワークの場合は？ ペアリングコードを使う",
      body: [
        "同じ Wi-Fi である必要はありません。スマホが別々のネットワーク（一方はモバイルデータ、もう一方は自宅の Wi-Fi）にあっても、Relayium はペアリングコードで両者を接続できます。",
        "送信側の端末が短いペアリングコードを表示するので、もう一方のスマホで入力します（または生成された共有リンクを開きます）。この方法で結ばれるネットワークをまたぐ転送は、端末同士の直接接続ではなく暗号化された TURN リレー経由で行われます。これは意図的な設計です。異なるネットワークの間では直接経路がそもそも見つからないことがほとんどで、先に直接接続を試すと 20 秒ほど接続が止まったあげく結局リレーに落ち着くため、Relayium は最初からリレーを使い、1〜2 秒で接続します。リレーが転送するのは暗号文だけで、ファイルはスマホを出る前にエンドツーエンドで封印されているため、リレーが中身を読むことはできません。途中で接続が切れても、最初からではなく再開できます。この方法で送るには送信側のサインインが必要です。受信側はアカウント不要です。",
      ],
    },
    {
      heading: "Android と iPhone の間でファイルを移す他の方法",
      body: [
        "Relayium だけが選択肢ではありません。代替手段の正直なトレードオフを知っておく価値があります。",
      ],
      bullets: [
        "Google のクイック共有や SHAREit のようなサードパーティ製アプリは高速ですが、両方のスマホにインストールが必要で、クイック共有は iPhone には届きません。",
        "クラウドドライブ（Google ドライブ、iCloud、Dropbox）は相手がオフラインでも使えますが、同じファイルをアップロードして再びダウンロードと2回動かすことになり、容量を消費し、提供元がコピーを保持します。",
        "チャットアプリやメールはどこにでもありますが、たいてい写真を再圧縮し、添付サイズを制限し、ファイル共有はエンドツーエンド暗号化されていません。",
        "USB ケーブルは確実ですが、USB-C と Lightning の間に適切なアダプターが必要で、多くのファイル形式では間にパソコンも要ります。",
      ],
    },
    {
      heading: "写真の画質は落ちますか？",
      body: [
        "落ちません。メッセージアプリと違い、Relayium は元のファイルをバイト単位でそのまま送ります。再圧縮もリサイズもしません。iPhone に届くのは、Android から出たものの正確なコピーです。",
        "それを裏づけるため、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるので、届いた写真や動画は送ったものと必ず同一です。大きなファイルもうまく扱えます。File System Access API を備えたブラウザ（パソコン版の Chrome や Edge）は、受信したファイルをサイズ上限なしでそのままディスクへ書き込みます。Firefox・Safari・スマホのブラウザ（iPhone は中身がすべて WebKit です）にはこの API がないため、そこでは受信分をいったんメモリに溜めることになり、およそ 256MB を超えると Relayium が受け取る前に警告を出します。この数値は実測した上限ではなく意図的に控えめに置いた目安で、実際に破綻する地点は端末のメモリ・OS・開いているタブの数によって変わります。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "どちらのスマホにもアプリのインストールは必要ですか？",
        a: "いいえ。Relayium は Android でも iPhone でもすべてブラウザで動作します。各端末で relayium.com を開けば準備完了です。どちらの方法でもダウンロードは不要です。同じネットワークならリアルタイム転送にアカウントは不要で、ネットワークをまたぐペアリングも送信側がサインインするだけです。任意で PWA としてホーム画面に追加できますが、それはショートカットにすぎません。",
      },
      {
        q: "両方のスマホが同じ Wi-Fi にある必要がありますか？",
        a: "いいえ。同じネットワークは端末が自動的に互いを見つけるため最速の経路ですが、ペアリングコードなら2台のスマホを異なるネットワークをまたいで接続できます。一方がモバイルデータ、もう一方が Wi-Fi でも大丈夫です。どちらの場合も転送はエンドツーエンド暗号化のままですが、ネットワークをまたぐペアリングには送信側のサインインが必要です。受信側はアカウント不要です。",
      },
      {
        q: "写真は圧縮されたり変更されたりしますか？",
        a: "いいえ。元のファイルは圧縮なしでバイト単位で転送され、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるため、iPhone に届くものは Android から送ったものとビット単位で同一です。",
      },
    ],
  },
  cta: {
    text: "両方のスマホで Relayium を開いて、最初のファイルを送ってみましょう。インストール不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "안드로이드에서 아이폰으로 파일 전송하는 방법 (케이블 없이)",
  description:
    "사진, 동영상, 문서를 안드로이드에서 아이폰으로 브라우저에서 보내는 단계별 안내. AirDrop도, 케이블도, 클라우드 업로드도 필요 없습니다. 두 기기에서 Relayium을 열기만 하면 됩니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "안드로이드와 아이폰은 AirDrop을 공유하지 않아, 사진 몇 장이나 동영상 하나를 옮기는 데도 보통 USB 케이블, 이미지를 압축하는 채팅 앱, 아니면 클라우드 드라이브를 오가는 업로드와 다운로드에 기대게 됩니다. 셋 다 마땅히 그래야 하는 것보다 느리고 번거롭습니다.",
    "Relayium은 그 모든 것을 건너뜁니다. 두 휴대폰에서 같은 페이지를 열면 같은 LAN에서는 종단간 암호화된 파일이 직접 전송되고, 네트워크를 넘을 때는 TURN 릴레이가 읽거나 복호화할 수 없는 암호문만 전달하며 실시간 콘텐츠 사본이나 기록을 남기지 않습니다. 앱은 필요 없고, 네트워크 간 페어링에서는 생성자가 로그인하며 참가자는 계정이 필요 없습니다. 이 글에서 단계별로 안내합니다.",
  ],
  sections: [
    {
      heading: "시작하기 전에 필요한 것",
      body: [
        "설치할 것이 없습니다. 같은 네트워크에서는 가입할 것도 없습니다 — 실시간 전송은 두 기기의 브라우저에서 바로 됩니다.",
      ],
      bullets: [
        "Chrome(또는 최신 브라우저 아무거나)이 있는 안드로이드 폰과 Safari를 쓰는 아이폰 — 둘 다 최신 상태로.",
        "가장 빠른 경로는 두 기기를 같은 Wi-Fi 네트워크에 두는 것입니다. 안 되어도 괜찮습니다 — 페어링 코드는 서로 다른 네트워크를 넘어서도 작동합니다.",
        "보내려는 파일, 배치당 최대 1,000개.",
      ],
    },
    {
      heading: "단계별: 두 기기가 같은 Wi-Fi에 있을 때",
      body: [
        "가장 간단한 방법입니다. 같은 네트워크에서는 두 휴대폰이 자동으로 서로를 찾으므로 입력할 것이 거의 없습니다.",
      ],
      bullets: [
        "안드로이드 폰과 아이폰 모두에서 브라우저로 relayium.com을 엽니다.",
        "각 기기는 상대에게 근처 기기로 나타납니다. 보내는 폰에서 받는 쪽을 탭합니다.",
        "보낼 파일을 고릅니다 — 배치당 최대 1,000개 — 또는 그냥 끌어다 놓습니다.",
        "고급 검증을 켰다면(기본값은 꺼짐) 양쪽 화면에 같은 6자리 코드도 표시됩니다. 일치하는지 확인하세요. 일치한다는 것은 두 휴대폰이 같은 종단간 암호화 세션에 참여했다는 뜻일 뿐, 암호문이 어떤 네트워크 경로로 이동하는지는 증명하지 않습니다. 꺼 두면 대조할 코드가 없을 뿐, 세션은 그대로 암호화됩니다.",
        "받는 아이폰에서 수락하면 파일이 직접 전송되고, 기기에 저장됩니다.",
      ],
    },
    {
      heading: "다른 네트워크라면? 페어링 코드를 쓰세요",
      body: [
        "같은 Wi-Fi일 필요는 없습니다. 휴대폰이 서로 다른 네트워크에 있어도 — 하나는 모바일 데이터, 다른 하나는 집 Wi-Fi — Relayium은 페어링 코드로 둘을 연결할 수 있습니다.",
        "보내는 기기가 짧은 페어링 코드를 표시하니, 다른 폰에서 입력하세요(또는 생성된 공유 링크를 여세요). 이렇게 맺어지는 네트워크 간 전송은 두 폰 사이의 직접 연결이 아니라 암호화된 TURN 릴레이를 통해 이루어집니다. 이는 의도된 설계입니다. 서로 다른 네트워크 사이에서는 직접 경로가 아예 없는 경우가 대부분이라, 직접 연결을 먼저 시도하면 20초쯤 멈춰 있다가 결국 릴레이로 넘어가게 됩니다. 그래서 Relayium은 곧장 릴레이를 써서 1~2초 만에 연결합니다. 릴레이는 암호문만 전달하며, 파일은 폰을 떠나기 전에 이미 종단간으로 봉인되므로 릴레이가 내용을 읽을 수는 없습니다. 전송 중 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다. 이 방식으로 보내려면 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "안드로이드와 아이폰 사이에서 파일을 옮기는 다른 방법",
      body: [
        "Relayium만이 선택지는 아니며, 대안의 솔직한 절충점을 알아 둘 가치가 있습니다:",
      ],
      bullets: [
        "구글의 퀵 셰어나 SHAREit 같은 서드파티 앱은 빠르게 옮기지만, 두 폰 모두에 설치가 필요하고 퀵 셰어는 아이폰에 닿지 않습니다.",
        "클라우드 드라이브(구글 드라이브, iCloud, Dropbox)는 상대가 오프라인일 때도 되지만, 같은 파일을 올렸다가 다시 내려받아 두 번 옮기게 되고, 용량을 차지하며, 제공자가 사본을 보관합니다.",
        "채팅 앱과 이메일은 어디에나 있지만, 대개 사진을 재압축하고 첨부 크기를 제한하며, 파일 공유는 종단간 암호화가 아닙니다.",
        "USB 케이블은 확실하지만 USB-C와 Lightning 사이에 맞는 어댑터가 필요하고, 많은 파일 형식은 중간에 컴퓨터까지 있어야 합니다.",
      ],
    },
    {
      heading: "사진 화질이 떨어지나요?",
      body: [
        "아니요. 메시징 앱과 달리 Relayium은 원본 파일을 바이트 단위 그대로 보냅니다 — 재압축도, 크기 조정도 없습니다. 아이폰에 도착하는 것은 안드로이드 폰에서 나간 것의 정확한 사본입니다.",
        "이를 증명하기 위해 각 파일은 SHA-256 해시로 종단간 검증되므로, 도착한 사진이나 동영상은 보낸 것과 반드시 동일합니다. 큰 파일도 잘 처리됩니다. File System Access API가 있는 브라우저(데스크톱 Chrome, Edge)는 들어오는 파일을 크기 제한 없이 곧바로 디스크에 씁니다. Firefox와 Safari, 그리고 휴대폰 브라우저(아이폰은 전부 WebKit입니다)에는 그 API가 없어서 받은 내용을 일단 메모리에 모으게 되며, 대략 256MB를 넘어서면 Relayium이 수락하기 전에 미리 경고합니다. 이 수치는 측정된 상한이 아니라 일부러 보수적으로 잡은 추정치이고, 실제로 무너지는 지점은 기기 메모리와 OS, 열어 둔 탭 수에 따라 달라집니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "두 폰 중 어느 쪽에든 앱을 설치해야 하나요?",
        a: "아니요. Relayium은 안드로이드와 아이폰 모두에서 전적으로 브라우저에서 동작합니다. 각 기기에서 relayium.com을 열면 준비 끝입니다 — 어느 쪽이든 다운로드는 필요 없습니다. 같은 네트워크에서는 실시간 전송에 계정이 필요 없고, 네트워크를 넘는 페어링도 보내는 쪽이 로그인만 하면 됩니다. 원하면 PWA로 홈 화면에 추가할 수 있지만, 그것은 바로가기일 뿐입니다.",
      },
      {
        q: "두 폰이 반드시 같은 Wi-Fi에 있어야 하나요?",
        a: "아니요. 같은 네트워크는 기기가 자동으로 서로를 찾기 때문에 가장 빠른 경로이지만, 페어링 코드로 두 폰을 서로 다른 네트워크를 넘어 연결할 수 있습니다 — 하나가 모바일 데이터, 다른 하나가 Wi-Fi여도 됩니다. 두 경우 모두 전송은 종단간 암호화를 유지하지만, 네트워크를 넘는 페어링에는 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 계정이 필요 없습니다.",
      },
      {
        q: "사진이 압축되거나 어떤 식으로든 바뀌나요?",
        a: "아니요. 원본 파일은 압축 없이 바이트 단위로 전송되고, 각 파일은 SHA-256 해시로 종단간 검증되므로, 아이폰에 도착하는 것은 안드로이드에서 보낸 것과 비트 단위로 동일합니다.",
      },
    ],
  },
  cta: {
    text: "두 폰에서 Relayium을 열고 첫 파일을 보내 보세요 — 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien von Android auf iPhone übertragen (ohne Kabel)",
  description:
    "Eine Schritt-für-Schritt-Anleitung, um Fotos, Videos und Dokumente im Browser von Android auf iPhone zu senden — ohne AirDrop, ohne Kabel, ohne Cloud-Upload. Öffne einfach Relayium auf beiden Geräten.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Android und iPhone teilen sich kein AirDrop, also bedeutet es, ein paar Fotos oder ein Video zu übertragen, meist ein USB-Kabel, eine Chat-App, die deine Bilder komprimiert, oder einen Umweg über irgendeine Cloud. Alle drei sind langsamer und umständlicher, als sie sein müssten.",
    "Relayium spart dir all das. Beide Handys öffnen dieselbe Seite: Im selben LAN werden die Ende-zu-Ende-verschlüsselten Dateien direkt übertragen; netzübergreifend transportiert ein TURN-Relay nur Chiffretext, den es weder lesen noch entschlüsseln kann, und behält weder Echtzeitinhalte noch einen Verlauf. Eine App ist nicht nötig; beim netzübergreifenden Pairing meldet sich der Ersteller an, die beitretende Person braucht nie ein Konto. Diese Anleitung führt dich Schritt für Schritt hindurch.",
  ],
  sections: [
    {
      heading: "Was du vorher brauchst",
      body: [
        "Nichts zu installieren. Im selben Netz gibt es auch nichts zu registrieren — Echtzeitübertragungen laufen direkt aus dem Browser auf beiden Geräten.",
      ],
      bullets: [
        "Ein Android-Handy mit Chrome (oder einem beliebigen modernen Browser) und ein iPhone mit Safari — beide auf dem neuesten Stand.",
        "Für den schnellsten Weg bring beide Geräte ins selbe WLAN. Geht das nicht, ist es kein Problem — ein Pairing-Code funktioniert auch über verschiedene Netzwerke hinweg.",
        "Die Dateien, die du senden willst, bis zu 1.000 pro Stapel.",
      ],
    },
    {
      heading: "Schritt für Schritt: beide Geräte im selben WLAN",
      body: [
        "Das ist der einfachste Weg. Im selben Netz erkennen sich die beiden Handys automatisch, sodass es fast nichts einzutippen gibt.",
      ],
      bullets: [
        "Öffne auf dem Android-Handy und dem iPhone jeweils relayium.com im Browser.",
        "Jedes Gerät erscheint beim anderen als Gerät in der Nähe. Tippe auf dem sendenden Handy das empfangende an.",
        "Wähle die Dateien zum Senden — bis zu 1.000 pro Stapel — oder zieh sie einfach hinein.",
        "Wenn du die erweiterte Verifizierung eingeschaltet hast (standardmäßig aus), zeigen beide Bildschirme zusätzlich denselben sechsstelligen Code — prüfe, ob sie übereinstimmen. Eine Übereinstimmung bestätigt, dass beide Handys derselben Ende-zu-Ende-verschlüsselten Sitzung beigetreten sind, nicht welchen Netzwerkweg der Chiffretext nimmt. Bleibt sie aus, gibt es keinen Code zum Vergleichen; verschlüsselt ist die Sitzung trotzdem.",
        "Bestätige auf dem empfangenden iPhone, dann werden die Dateien direkt übertragen und auf deinem Gerät gespeichert.",
      ],
    },
    {
      heading: "In verschiedenen Netzwerken? Nutze einen Pairing-Code",
      body: [
        "Ihr müsst nicht im selben WLAN sein. Sind die Handys in verschiedenen Netzwerken — eines im Mobilfunk, das andere im Heim-WLAN — kann Relayium sie trotzdem per Pairing-Code verbinden.",
        "Das sendende Gerät zeigt einen kurzen Pairing-Code; gib ihn auf dem anderen Handy ein (oder öffne den erzeugten Freigabelink). Eine so aufgebaute netzübergreifende Übertragung läuft über ein verschlüsseltes TURN-Relay statt über eine direkte Verbindung zwischen den beiden Handys — und das mit Absicht: Zwischen zwei verschiedenen Netzwerken lässt sich meist gar kein direkter Weg finden, ein Versuch würde den Verbindungsaufbau erst rund 20 Sekunden blockieren und am Ende doch beim Relay landen. Relayium nimmt deshalb gleich das Relay und steht in ein bis zwei Sekunden. Das Relay leitet ausschließlich Chiffretext weiter; die Dateien sind bereits Ende-zu-Ende versiegelt, bevor sie dein Handy verlassen, es kann sie also nie lesen. Bricht die Verbindung mittendrin ab, kann sie fortgesetzt statt neu gestartet werden. Für diesen Weg muss sich der Absender anmelden — der Empfänger braucht nie ein Konto.",
      ],
    },
    {
      heading: "Andere Wege, Dateien zwischen Android und iPhone zu bewegen",
      body: [
        "Relayium ist nicht die einzige Option, und es lohnt sich, die ehrlichen Kompromisse der Alternativen zu kennen:",
      ],
      bullets: [
        "Googles Quick Share und Drittanbieter-Apps wie SHAREit übertragen schnell, brauchen aber eine Installation auf beiden Handys, und Quick Share erreicht keine iPhones.",
        "Eine Cloud (Google Drive, iCloud, Dropbox) funktioniert, wenn die andere Person offline ist, aber du lädst dieselbe Datei zweimal hoch und wieder herunter, es zählt gegen dein Kontingent, und der Anbieter behält eine Kopie.",
        "Chat-Apps und E-Mail sind überall, komprimieren Fotos aber meist erneut, begrenzen die Anhangsgröße und sind beim Dateiaustausch nicht Ende-zu-Ende-verschlüsselt.",
        "Ein USB-Kabel ist zuverlässig, braucht aber den passenden Adapter zwischen USB-C und Lightning und für viele Dateitypen zusätzlich einen Computer dazwischen.",
      ],
    },
    {
      heading: "Verlieren meine Fotos an Qualität?",
      body: [
        "Nein. Anders als eine Messaging-App sendet Relayium die Originaldatei Byte für Byte — keine erneute Komprimierung, keine Größenänderung. Was auf dem iPhone ankommt, ist eine exakte Kopie dessen, was das Android-Handy verlassen hat.",
        "Zum Beleg wird jede Datei per SHA-256-Hash Ende-zu-Ende geprüft, sodass ein ankommendes Foto oder Video garantiert identisch mit dem gesendeten ist. Auch große Dateien werden gut gehandhabt: Ein Browser mit der File System Access API (Chrome oder Edge auf dem Desktop) schreibt die eingehende Datei ohne Größenbegrenzung direkt auf die Festplatte. Firefox, Safari und Handy-Browser — auf dem iPhone steckt immer WebKit dahinter — haben diese API nicht, dort sammelt sich der Empfang stattdessen im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium dich, bevor du annimmst. Dieser Wert ist eine bewusst vorsichtige Schätzung und keine gemessene Obergrenze: Wo es tatsächlich kippt, hängt vom Arbeitsspeicher des Geräts, vom Betriebssystem und von der Zahl der offenen Tabs ab.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss ich auf einem der Handys eine App installieren?",
        a: "Nein. Relayium läuft auf Android und iPhone vollständig im Browser. Öffne auf jedem Gerät relayium.com, und du bist startklar — einen Download braucht es so oder so nicht. Im selben Netz braucht eine Echtzeitübertragung kein Konto; Pairing über Netzwerke hinweg verlangt nur die Anmeldung des Absenders. Optional kannst du es als PWA zum Startbildschirm hinzufügen, aber das ist nur eine Verknüpfung.",
      },
      {
        q: "Müssen beide Handys im selben WLAN sein?",
        a: "Nein. Dasselbe Netz ist der schnellste Weg, weil sich die Geräte automatisch erkennen, aber ein Pairing-Code verbindet zwei Handys über verschiedene Netzwerke hinweg — auch eines im Mobilfunk und eines im WLAN. Die Übertragung bleibt in beiden Fällen Ende-zu-Ende-verschlüsselt, wobei Pairing über Netzwerke hinweg die Anmeldung des Absenders erfordert — der Empfänger braucht nie ein Konto.",
      },
      {
        q: "Werden die Fotos komprimiert oder irgendwie verändert?",
        a: "Nein. Die Originaldatei wird Byte für Byte ohne Komprimierung übertragen, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, sodass das, was auf dem iPhone ankommt, Bit für Bit identisch mit dem ist, was du von Android gesendet hast.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf beiden Handys und schick deine ersten Dateien hinüber — keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer des fichiers d'Android vers iPhone (sans câble)",
  description:
    "Un guide pas à pas pour envoyer photos, vidéos et documents d'Android vers iPhone dans le navigateur — sans AirDrop, sans câble, sans envoi vers le cloud. Ouvrez simplement Relayium sur les deux appareils.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Android et iPhone ne partagent pas d'AirDrop, donc déplacer quelques photos ou une vidéo entre eux passe le plus souvent par un câble USB, une messagerie qui compresse vos images, ou un aller-retour via un espace cloud. Les trois sont plus lents et plus pénibles qu'ils ne devraient l'être.",
    "Relayium fait l'impasse sur tout cela. Les deux téléphones ouvrent la même page : sur le même LAN, les fichiers chiffrés de bout en bout passent directement ; entre réseaux, un relais TURN ne transporte que du texte chiffré qu'il ne peut ni lire ni déchiffrer, sans conserver de copie ni d'historique du contenu en temps réel. Aucune application à installer ; pour l'appairage entre réseaux, le créateur se connecte et la personne qui rejoint n'a jamais besoin de compte. Ce guide vous accompagne pas à pas.",
  ],
  sections: [
    {
      heading: "Ce qu'il vous faut avant de commencer",
      body: [
        "Rien à installer. Sur le même réseau, rien à créer non plus — les transferts en temps réel fonctionnent directement depuis le navigateur sur les deux appareils.",
      ],
      bullets: [
        "Un téléphone Android avec Chrome (ou n'importe quel navigateur moderne) et un iPhone avec Safari — tous deux à jour.",
        "Pour la voie la plus rapide, placez les deux appareils sur le même réseau Wi-Fi. Si c'est impossible, pas de souci — un code d'appairage fonctionne aussi sur des réseaux différents.",
        "Les fichiers à envoyer, jusqu'à 1 000 par lot.",
      ],
    },
    {
      heading: "Pas à pas : les deux appareils sur le même Wi-Fi",
      body: [
        "C'est la voie la plus simple. Sur le même réseau, les deux téléphones se découvrent automatiquement, il n'y a donc presque rien à saisir.",
      ],
      bullets: [
        "Sur le téléphone Android et sur l'iPhone, ouvrez relayium.com dans le navigateur.",
        "Chaque appareil apparaît sur l'autre comme un appareil à proximité. Sur le téléphone qui envoie, touchez celui qui reçoit.",
        "Choisissez les fichiers à envoyer — jusqu'à 1 000 par lot — ou faites-les simplement glisser.",
        "Si vous avez activé la vérification avancée (désactivée par défaut), les deux écrans affichent aussi le même code à 6 chiffres : vérifiez qu'il concorde. Une correspondance confirme que les deux téléphones ont rejoint la même session chiffrée de bout en bout, pas le chemin réseau emprunté par le texte chiffré. Sans elle, il n'y a aucun code à comparer et la session reste chiffrée.",
        "Acceptez sur l'iPhone qui reçoit, les fichiers se transfèrent directement, puis enregistrez-les sur votre appareil.",
      ],
    },
    {
      heading: "Sur des réseaux différents ? Utilisez un code d'appairage",
      body: [
        "Vous n'avez pas besoin d'être sur le même Wi-Fi. Si les téléphones sont sur des réseaux différents — l'un en données mobiles, l'autre sur le Wi-Fi de la maison — Relayium peut quand même les connecter avec un code d'appairage.",
        "L'appareil qui envoie affiche un court code d'appairage ; saisissez-le sur l'autre téléphone (ou ouvrez le lien de partage qu'il génère). Un transfert établi ainsi entre deux réseaux passe par un relais TURN chiffré plutôt que par une liaison directe entre les deux téléphones — et c'est délibéré : entre deux réseaux différents, une voie directe est le plus souvent introuvable, et l'essayer d'abord bloquerait l'établissement de la connexion une vingtaine de secondes avant d'aboutir quand même au relais. Relayium y va donc d'emblée et se connecte en une ou deux secondes. Le relais ne transmet que du texte chiffré ; les fichiers sont scellés de bout en bout avant de quitter votre téléphone, il ne peut donc jamais les lire. Si la connexion se coupe en cours de route, il peut reprendre au lieu de tout recommencer. Envoyer ainsi exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte.",
      ],
    },
    {
      heading: "Autres façons de déplacer des fichiers entre Android et iPhone",
      body: [
        "Relayium n'est pas la seule option, et il vaut la peine de connaître les compromis honnêtes des solutions de rechange :",
      ],
      bullets: [
        "Le Partage rapide de Google et des applications tierces comme SHAREit transfèrent vite, mais exigent une installation sur les deux téléphones, et le Partage rapide n'atteint pas les iPhone.",
        "Un espace cloud (Google Drive, iCloud, Dropbox) fonctionne quand l'autre personne est hors ligne, mais vous téléversez puis téléchargez deux fois le même fichier, cela grignote votre quota, et le fournisseur en garde une copie.",
        "Les messageries et l'e-mail sont partout, mais elles recompressent souvent les photos, limitent la taille des pièces jointes et ne sont pas chiffrées de bout en bout pour le partage de fichiers.",
        "Un câble USB est fiable, mais demande le bon adaptateur entre USB-C et Lightning, plus un ordinateur au milieu pour beaucoup de types de fichiers.",
      ],
    },
    {
      heading: "Mes photos perdront-elles en qualité ?",
      body: [
        "Non. Contrairement à une messagerie, Relayium envoie le fichier d'origine octet par octet — aucune recompression, aucun redimensionnement. Ce qui arrive sur l'iPhone est une copie exacte de ce qui a quitté le téléphone Android.",
        "Pour le prouver, chaque fichier est vérifié de bout en bout par une empreinte SHA-256, si bien qu'une photo ou une vidéo qui arrive est garantie identique à celle que vous avez envoyée. Les gros fichiers sont bien gérés aussi : un navigateur doté de l'API File System Access (Chrome ou Edge sur ordinateur) écrit le fichier entrant directement sur le disque, sans limite de taille. Firefox, Safari et les navigateurs de téléphone — sur iPhone, tout est WebKit — n'ont pas cette API : la réception y est assemblée en mémoire, et Relayium vous avertit avant que vous acceptiez dès que l'on dépasse environ 256 Mo. Ce chiffre est une estimation volontairement prudente, pas un plafond mesuré : le point de rupture réel dépend de la mémoire de l'appareil, de son système et du nombre d'onglets ouverts.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je installer une application sur l'un des téléphones ?",
        a: "Non. Relayium fonctionne entièrement dans le navigateur, sur Android comme sur iPhone. Ouvrez relayium.com sur chaque appareil et vous êtes prêt — aucun téléchargement dans les deux cas. Sur le même réseau, un transfert en temps réel ne demande aucun compte ; s'appairer entre réseaux différents demande seulement que l'expéditeur se connecte. Vous pouvez au choix l'ajouter à l'écran d'accueil comme PWA, mais ce n'est qu'un raccourci.",
      },
      {
        q: "Les deux téléphones doivent-ils être sur le même Wi-Fi ?",
        a: "Non. Le même réseau est la voie la plus rapide car les appareils se découvrent automatiquement, mais un code d'appairage connecte deux téléphones sur des réseaux différents — même l'un en données mobiles et l'autre en Wi-Fi. Le transfert reste chiffré de bout en bout dans les deux cas, même si s'appairer entre réseaux différents exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte.",
      },
      {
        q: "Les photos sont-elles compressées ou modifiées d'une quelconque façon ?",
        a: "Non. Le fichier d'origine est transféré octet par octet sans compression, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256, si bien que ce qui arrive sur l'iPhone est identique bit pour bit à ce que vous avez envoyé depuis Android.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur les deux téléphones et envoyez vos premiers fichiers — sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "كيفية نقل الملفات من Android إلى iPhone (دون كابل)",
  description:
    "دليل إرشادي خطوة بخطوة لإرسال الصور ومقاطع الفيديو والمستندات من Android إلى iPhone في المتصفح — دون AirDrop ودون كابل ودون رفع إلى السحابة. ما عليك سوى فتح Relayium على الجهازين.",
  updatedLabel: "آخر تحديث",
  lead: [
    "لا يشترك Android وiPhone في AirDrop، لذا فإن نقل بضع صور أو مقطع فيديو بينهما يعني عادةً كابل USB، أو تطبيق محادثة يضغط صورك، أو رحلة ذهاب وإياب عبر أحد أقراص السحابة. والثلاثة جميعًا أبطأ وأكثر إزعاجًا مما ينبغي.",
    "يتخطى Relayium كل ذلك. يفتح الهاتفان الصفحة نفسها: داخل شبكة LAN نفسها تنتقل الملفات المشفَّرة من الطرف إلى الطرف مباشرةً، وعبر الشبكات ينقل مُرحِّل TURN نصًا مشفّرًا لا يستطيع قراءته أو فك تشفيره ولا يحتفظ بنسخة أو سجل للمحتوى الآني. لا حاجة إلى تطبيق؛ يسجّل منشئ الاقتران عبر الشبكات الدخول، ولا يحتاج المنضم إلى حساب. يرشدك هذا الدليل خطوة بخطوة.",
  ],
  sections: [
    {
      heading: "ما تحتاج إليه قبل أن تبدأ",
      body: [
        "لا شيء يُثبَّت. وعلى نفس الشبكة لا شيء يتطلب التسجيل كذلك — يعمل النقل الفوري مباشرةً من المتصفح على الجهازين.",
      ],
      bullets: [
        "هاتف Android مزوَّد بـ Chrome (أو أي متصفح حديث) وهاتف iPhone مزوَّد بـ Safari — كلاهما محدَّث.",
        "للحصول على أسرع مسار، ضع الجهازين على نفس شبكة Wi-Fi. وإن لم تستطع فلا بأس — رمز الاقتران يعمل عبر الشبكات المختلفة أيضًا.",
        "الملفات التي تريد إرسالها، حتى 1,000 ملف في كل دفعة.",
      ],
    },
    {
      heading: "خطوة بخطوة: كلا الجهازين على نفس شبكة Wi-Fi",
      body: [
        "هذا أبسط المسارات. على نفس الشبكة، يكتشف الهاتفان أحدهما الآخر تلقائيًا، فلا يكاد يوجد ما يُكتَب.",
      ],
      bullets: [
        "على كل من هاتف Android وiPhone، افتح relayium.com في المتصفح.",
        "يظهر كل جهاز على الآخر بوصفه جهازًا قريبًا. على الهاتف المُرسِل، انقر على الهاتف المُستقبِل.",
        "اختر الملفات المراد إرسالها — حتى 1,000 ملف في كل دفعة — أو اسحبها إلى الداخل ببساطة.",
        "إذا فعّلت التحقّق المتقدّم (وهو معطَّل افتراضيًا)، تعرض الشاشتان أيضًا رمز التحقق نفسه المكوَّن من 6 أرقام؛ تأكد من تطابقهما. التطابق يؤكد انضمام الهاتفين إلى جلسة واحدة مشفَّرة من الطرف إلى الطرف، ولا يثبت مسار الشبكة الذي يحمله النص المشفّر. وإن تركته معطَّلًا فلن يكون هناك رمز للمقارنة، وتظل الجلسة مشفَّرة كما هي.",
        "اقبل على iPhone المُستقبِل، فتُنقَل الملفات مباشرةً، ثم احفظها على جهازك.",
      ],
    },
    {
      heading: "على شبكتين مختلفتين؟ استخدم رمز اقتران",
      body: [
        "لست مضطرًا إلى أن تكون على نفس شبكة Wi-Fi. إذا كان الهاتفان على شبكتين مختلفتين — أحدهما على بيانات الهاتف المحمول والآخر على شبكة Wi-Fi المنزلية — فلا يزال بإمكان Relayium ربطهما برمز اقتران.",
        "يعرض الجهاز المُرسِل رمز اقتران قصيرًا؛ أدخله على الهاتف الآخر (أو افتح رابط المشاركة الذي يولّده). والنقل الذي يُبنى بهذه الطريقة عبر شبكتين مختلفتين يجري عبر مُرحِّل TURN مُشفَّر لا عبر اتصال مباشر بين الهاتفين — وهذا اختيار مقصود: فالمسار المباشر بين شبكتين مختلفتين يتعذّر إيجاده في الغالب، ومحاولته أولًا تُعطّل إنشاء الاتصال نحو عشرين ثانية ثم ينتهي الأمر بالمُرحِّل على أي حال، لذا يذهب Relayium إلى المُرحِّل مباشرةً فيتصل في ثانية أو ثانيتين. ولا يُمرِّر المُرحِّل سوى نص مُشفَّر؛ فالملفات مختومة من الطرف إلى الطرف قبل أن تغادر هاتفك، ولا يستطيع قراءتها أبدًا. وإن انقطع الاتصال أثناء النقل، أمكنه الاستئناف بدلًا من البدء من جديد. ويتطلب الإرسال بهذه الطريقة أن يسجّل المُرسِل الدخول — أما الشخص المُستقبِل فلا يحتاج إلى حساب مطلقًا.",
      ],
    },
    {
      heading: "طرق أخرى لنقل الملفات بين Android وiPhone",
      body: [
        "Relayium ليس الخيار الوحيد، ومن الجدير معرفة الموازنات الصريحة للبدائل:",
      ],
      bullets: [
        "تنقل خدمة Quick Share من Google والتطبيقات الخارجية مثل SHAREit الملفات بسرعة، لكنها تحتاج إلى تثبيت على الهاتفين، كما أن Quick Share لا يصل إلى أجهزة iPhone.",
        "يعمل قرص سحابي (Google Drive، iCloud، Dropbox) حين يكون الطرف الآخر غير متصل، لكنك ترفع الملف نفسه ثم تنزّله مرتين، وهو يُحتسب من حصتك، ويحتفظ المزوّد بنسخة منه.",
        "تطبيقات المحادثة والبريد الإلكتروني في كل مكان، لكنها عادةً تعيد ضغط الصور، وتحدّ من أحجام المرفقات، وليست مُشفَّرة من الطرف إلى الطرف لمشاركة الملفات.",
        "كابل USB موثوق لكنه يحتاج إلى المحوّل المناسب بين USB-C وLightning، إضافةً إلى حاسوب في المنتصف لكثير من أنواع الملفات.",
      ],
    },
    {
      heading: "هل ستفقد صوري جودتها؟",
      body: [
        "لا. بخلاف تطبيق المراسلة، يرسل Relayium الملف الأصلي بايتًا ببايت — دون إعادة ضغط ودون تغيير الحجم. وما يصل إلى iPhone نسخة طبق الأصل مما غادر هاتف Android.",
        "وإثباتًا لذلك، يُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256، فالصورة أو الفيديو الذي يصل مضمون أنه مطابق لما أرسلته. وتُعالَج الملفات الكبيرة جيدًا أيضًا: المتصفح الذي يدعم واجهة File System Access (‏Chrome أو Edge على الحاسوب) يكتب الملف الوارد مباشرةً إلى القرص دون حد للحجم. أما Firefox وSafari ومتصفحات الهواتف — وكل ما على iPhone هو WebKit — فلا تملك تلك الواجهة، فتُجمَّع الدفعة في الذاكرة بدلًا من ذلك، ولذلك ينبّهك Relayium قبل القبول متى تجاوزت نحو 256 ميغابايت. وهذا الرقم تقدير متحفّظ عن قصد لا سقف مقيس: فنقطة الانهيار الفعلية تتوقف على ذاكرة الجهاز ونظامه وعدد علامات التبويب المفتوحة.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى تثبيت تطبيق على أي من الهاتفين؟",
        a: "لا. يعمل Relayium بالكامل في المتصفح على كل من Android وiPhone. افتح relayium.com على كل جهاز وستكون جاهزًا — دون أي تنزيل في الحالتين. على نفس الشبكة لا يحتاج النقل الفوري إلى حساب؛ والاقتران عبر الشبكات يتطلب فقط أن يسجّل المُرسِل الدخول. ويمكنك اختياريًا إضافته إلى شاشتك الرئيسية بوصفه تطبيق ويب تقدمي (PWA)، لكن ذلك مجرد اختصار.",
      },
      {
        q: "هل يجب أن يكون الهاتفان على نفس شبكة Wi-Fi؟",
        a: "لا. نفس الشبكة هي أسرع مسار لأن الأجهزة تكتشف بعضها تلقائيًا، لكن رمز الاقتران يربط هاتفين عبر شبكات مختلفة — حتى لو كان أحدهما على بيانات الهاتف المحمول والآخر على Wi-Fi. يبقى النقل مُشفَّرًا من الطرف إلى الطرف في الحالتين، وإن كان الاقتران عبر الشبكات يتطلب أن يسجّل المُرسِل الدخول — أما المُستقبِل فلا يحتاج إلى حساب مطلقًا.",
      },
      {
        q: "هل تُضغَط الصور أو تتغير بأي شكل؟",
        a: "لا. يُنقَل الملف الأصلي بايتًا ببايت دون ضغط، ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256، فما يصل إلى iPhone مطابق بتة ببتة لما أرسلته من Android.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على الهاتفين وأرسل أول ملفاتك — دون تثبيت، ودون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Cómo transferir archivos de Android a iPhone (sin cable)",
  description:
    "Una guía paso a paso para enviar fotos, vídeos y documentos de Android a iPhone en un navegador — sin AirDrop, sin cable, sin subir a la nube. Solo abre Relayium en ambos dispositivos.",
  updatedLabel: "Última actualización",
  lead: [
    "Android y iPhone no comparten un AirDrop, así que mover unas fotos o un vídeo entre ellos suele implicar un cable USB, una app de chat que comprime tus imágenes, o un viaje de ida y vuelta por algún disco en la nube. Los tres son más lentos y engorrosos de lo que deberían.",
    "Relayium se salta todo eso. Ambos teléfonos abren la misma página: en la misma LAN los archivos cifrados de extremo a extremo viajan directamente; entre redes, un relé TURN solo transporta texto cifrado que no puede leer ni descifrar y no conserva copia ni historial del contenido en tiempo real. No hay app que instalar; en el emparejamiento entre redes inicia sesión el creador y quien se une nunca necesita cuenta. Esta guía lo explica paso a paso.",
  ],
  sections: [
    {
      heading: "Lo que necesitas antes de empezar",
      body: [
        "Nada que instalar. En la misma red tampoco hay nada que registrar — las transferencias en tiempo real funcionan directamente desde el navegador en ambos dispositivos.",
      ],
      bullets: [
        "Un teléfono Android con Chrome (o cualquier navegador moderno) y un iPhone con Safari — ambos actualizados.",
        "Para la vía más rápida, pon ambos dispositivos en la misma red Wi-Fi. Si no puedes, no pasa nada — un código de emparejamiento también funciona entre redes distintas.",
        "Los archivos que quieres enviar, hasta 1.000 por lote.",
      ],
    },
    {
      heading: "Paso a paso: ambos dispositivos en la misma Wi-Fi",
      body: [
        "Esta es la vía más sencilla. En la misma red, los dos teléfonos se descubren automáticamente, así que casi no hay nada que escribir.",
      ],
      bullets: [
        "Tanto en el teléfono Android como en el iPhone, abre relayium.com en el navegador.",
        "Cada dispositivo aparece como un dispositivo cercano en el otro. En el teléfono que envía, toca el que recibe.",
        "Elige los archivos a enviar — hasta 1.000 por lote — o simplemente arrástralos.",
        "Si has activado la verificación avanzada (desactivada por omisión), ambas pantallas muestran además el mismo código de 6 dígitos: comprueba que coinciden. Una coincidencia confirma que ambos teléfonos se unieron a la misma sesión cifrada de extremo a extremo, no la ruta de red que transporta el texto cifrado. Si la dejas desactivada no hay ningún código que comparar, y la sesión sigue igualmente cifrada.",
        "Acepta en el iPhone que recibe y los archivos se transfieren directamente, luego guárdalos en tu dispositivo.",
      ],
    },
    {
      heading: "¿En redes distintas? Usa un código de emparejamiento",
      body: [
        "No hace falta estar en la misma Wi-Fi. Si los teléfonos están en redes distintas — uno con datos móviles, el otro con la Wi-Fi de casa — Relayium aún puede conectarlos con un código de emparejamiento.",
        "El dispositivo que envía muestra un código de emparejamiento corto; introdúcelo en el otro teléfono (o abre el enlace para compartir que genera). Una transferencia montada así entre dos redes va por un retransmisor TURN cifrado, no por un enlace directo entre los dos teléfonos — y es a propósito: entre dos redes distintas casi nunca hay una ruta directa, e intentarla primero dejaría la conexión colgada unos veinte segundos antes de acabar igualmente en el retransmisor, así que Relayium va directo a él y conecta en uno o dos segundos. El retransmisor solo reenvía texto cifrado; los archivos salen sellados de extremo a extremo antes de dejar tu teléfono, así que nunca puede leerlos. Si la conexión se cae a mitad de la transferencia, puede reanudarse en lugar de empezar de nuevo. Enviar así necesita que el remitente inicie sesión — la persona que recibe nunca necesita una cuenta.",
      ],
    },
    {
      heading: "Otras formas de mover archivos entre Android y iPhone",
      body: [
        "Relayium no es la única opción, y vale la pena conocer las concesiones reales de las alternativas:",
      ],
      bullets: [
        "Quick Share de Google y apps de terceros como SHAREit mueven archivos rápido, pero necesitan instalación en ambos teléfonos y Quick Share no llega a los iPhone.",
        "Un disco en la nube (Google Drive, iCloud, Dropbox) funciona cuando la otra persona está desconectada, pero subes y luego descargas el mismo archivo dos veces, se descuenta de tu cuota y el proveedor guarda una copia.",
        "Las apps de chat y el correo están en todas partes, pero suelen recomprimir las fotos, limitar el tamaño de los adjuntos y no están cifradas de extremo a extremo para compartir archivos.",
        "Un cable USB es fiable pero necesita el adaptador adecuado entre USB-C y Lightning, además de un ordenador en medio para muchos tipos de archivo.",
      ],
    },
    {
      heading: "¿Mis fotos perderán calidad?",
      body: [
        "No. A diferencia de una app de mensajería, Relayium envía el archivo original byte a byte — sin recompresión, sin redimensionar. Lo que llega al iPhone es una copia exacta de lo que salió del teléfono Android.",
        "Para demostrarlo, cada archivo se verifica de extremo a extremo con un hash SHA-256, así que una foto o un vídeo que llega tiene garantizado ser idéntico al que enviaste. Los archivos grandes también se gestionan bien: un navegador con la API File System Access (Chrome o Edge de escritorio) escribe el archivo entrante directamente al disco, sin límite de tamaño. Firefox, Safari y los navegadores de móvil — en el iPhone todo es WebKit — no tienen esa API, así que ahí la recepción se acumula en memoria y Relayium te avisa antes de que aceptes en cuanto se pasa de unos 256 MB. Esa cifra es una estimación deliberadamente prudente, no un techo medido: dónde falla de verdad depende de la memoria del dispositivo, de su sistema y de cuántas pestañas tengas abiertas.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito instalar una app en alguno de los teléfonos?",
        a: "No. Relayium se ejecuta por completo en el navegador tanto en Android como en iPhone. Abre relayium.com en cada dispositivo y ya está — sin descarga de ningún tipo. En la misma red una transferencia en tiempo real no necesita cuenta; emparejar entre redes solo le pide al remitente que inicie sesión. Puedes, opcionalmente, añadirlo a tu pantalla de inicio como PWA, pero eso es solo un acceso directo.",
      },
      {
        q: "¿Los dos teléfonos tienen que estar en la misma Wi-Fi?",
        a: "No. La misma red es la vía más rápida porque los dispositivos se descubren automáticamente, pero un código de emparejamiento conecta dos teléfonos entre redes distintas — incluso uno con datos móviles y otro con Wi-Fi. La transferencia sigue cifrada de extremo a extremo en ambos casos, aunque emparejar entre redes requiere que el remitente inicie sesión — el destinatario nunca necesita una cuenta.",
      },
      {
        q: "¿Se comprimen o alteran las fotos de alguna forma?",
        a: "No. El archivo original se transfiere byte a byte sin compresión, y cada archivo se comprueba de extremo a extremo con un hash SHA-256, así que lo que llega al iPhone es idéntico bit a bit a lo que enviaste desde Android.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en ambos teléfonos y envía tus primeros archivos — sin instalación, y sin cuenta necesaria en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Como transferir arquivos do Android para o iPhone (sem cabo)",
  description:
    "Um guia passo a passo para enviar fotos, vídeos e documentos do Android para o iPhone no navegador — sem AirDrop, sem cabo, sem upload para a nuvem. Basta abrir o Relayium nos dois dispositivos.",
  updatedLabel: "Última atualização",
  lead: [
    "Android e iPhone não compartilham um AirDrop, então mover algumas fotos ou um vídeo entre eles geralmente significa um cabo USB, um app de conversa que comprime suas imagens, ou uma ida e volta por algum drive na nuvem. Os três são mais lentos e mais trabalhosos do que deveriam ser.",
    "O Relayium pula tudo isso. Os dois celulares abrem a mesma página: na mesma LAN os arquivos criptografados de ponta a ponta viajam diretamente; entre redes, um retransmissor TURN só transporta texto cifrado que não consegue ler nem descriptografar e não mantém cópia nem histórico do conteúdo em tempo real. Não há app para instalar; no emparelhamento entre redes o criador faz login e quem entra nunca precisa de conta. Este guia mostra passo a passo.",
  ],
  sections: [
    {
      heading: "O que você precisa antes de começar",
      body: [
        "Nada para instalar. Na mesma rede também não há nada para cadastrar — as transferências em tempo real funcionam direto do navegador nos dois dispositivos.",
      ],
      bullets: [
        "Um celular Android com Chrome (ou qualquer navegador moderno) e um iPhone com Safari — ambos atualizados.",
        "Para o caminho mais rápido, coloque os dois dispositivos na mesma rede Wi-Fi. Se não der, tudo bem — um código de emparelhamento funciona entre redes diferentes também.",
        "Os arquivos que você quer enviar, até 1.000 por lote.",
      ],
    },
    {
      heading: "Passo a passo: os dois dispositivos na mesma rede Wi-Fi",
      body: [
        "Este é o caminho mais simples. Na mesma rede, os dois celulares se descobrem automaticamente, então quase não há nada para digitar.",
      ],
      bullets: [
        "Tanto no celular Android quanto no iPhone, abra relayium.com no navegador.",
        "Cada dispositivo aparece como um dispositivo próximo no outro. No celular que envia, toque no que recebe.",
        "Escolha os arquivos a enviar — até 1.000 por lote — ou simplesmente arraste-os.",
        "Se você ativou a verificação avançada (desligada por padrão), as duas telas também mostram o mesmo código de 6 dígitos: confira se eles coincidem. A coincidência confirma que os dois celulares entraram na mesma sessão criptografada de ponta a ponta, não a rota de rede que transporta o texto cifrado. Se deixar desligada, não há código para comparar e a sessão continua criptografada do mesmo jeito.",
        "Aceite no iPhone que recebe e os arquivos são transferidos diretamente, depois salve-os no seu dispositivo.",
      ],
    },
    {
      heading: "Em redes diferentes? Use um código de emparelhamento",
      body: [
        "Você não precisa estar na mesma rede Wi-Fi. Se os celulares estão em redes diferentes — um em dados móveis, o outro na rede Wi-Fi de casa — o Relayium ainda consegue conectá-los com um código de emparelhamento.",
        "O dispositivo que envia mostra um código de emparelhamento curto; digite-o no outro celular (ou abra o link de compartilhamento que ele gera). Uma transferência montada assim entre duas redes passa por um retransmissor TURN criptografado, e não por uma ligação direta entre os dois celulares — de propósito: entre duas redes diferentes quase nunca existe um caminho direto, e tentá-lo primeiro travaria a conexão por uns vinte segundos antes de acabar no retransmissor mesmo assim, então o Relayium vai direto a ele e conecta em um ou dois segundos. O retransmissor só encaminha texto cifrado; os arquivos saem selados de ponta a ponta antes de deixar o seu celular, então ele nunca consegue lê-los. Se a conexão cair no meio da transferência, ela pode ser retomada em vez de recomeçar. Enviar assim exige que o remetente entre — a pessoa que recebe nunca precisa de conta.",
      ],
    },
    {
      heading: "Outras formas de mover arquivos entre Android e iPhone",
      body: [
        "O Relayium não é a única opção, e vale conhecer os trade-offs honestos das alternativas:",
      ],
      bullets: [
        "O Quick Share do Google e apps de terceiros como o SHAREit movem arquivos rápido, mas precisam de instalação nos dois celulares e o Quick Share não alcança iPhones.",
        "Um drive na nuvem (Google Drive, iCloud, Dropbox) funciona quando a outra pessoa está offline, mas você envia e depois baixa o mesmo arquivo duas vezes, ele conta na sua cota e o provedor guarda uma cópia.",
        "Apps de conversa e e-mail estão em toda parte, mas costumam recomprimir fotos, limitar o tamanho dos anexos e não são criptografados de ponta a ponta para compartilhamento de arquivos.",
        "Um cabo USB é confiável, mas precisa do adaptador certo entre USB-C e Lightning, além de um computador no meio para muitos tipos de arquivo.",
      ],
    },
    {
      heading: "Minhas fotos vão perder qualidade?",
      body: [
        "Não. Diferentemente de um app de mensagens, o Relayium envia o arquivo original byte a byte — sem recompressão, sem redimensionamento. O que chega ao iPhone é uma cópia exata do que saiu do celular Android.",
        "Para comprovar, cada arquivo é verificado de ponta a ponta com um hash SHA-256, então uma foto ou vídeo que chega é garantidamente idêntico ao que você enviou. Arquivos grandes também são bem tratados: um navegador com a API File System Access (Chrome ou Edge no computador) grava o arquivo recebido direto no disco, sem limite de tamanho. Firefox, Safari e navegadores de celular — no iPhone é tudo WebKit — não têm essa API, então neles o lote é montado na memória, e o Relayium avisa antes de você aceitar assim que passa de cerca de 256 MB. Esse número é uma estimativa propositalmente conservadora, não um teto medido: o ponto real de falha depende da memória do aparelho, do sistema e de quantas abas estão abertas.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso instalar um app em algum dos celulares?",
        a: "Não. O Relayium roda inteiramente no navegador tanto no Android quanto no iPhone. Abra relayium.com em cada dispositivo e você está pronto — sem download de qualquer forma. Na mesma rede uma transferência em tempo real não precisa de conta; emparelhar entre redes apenas pede que o remetente entre. Você pode, opcionalmente, adicioná-lo à tela inicial como um PWA, mas isso é só um atalho.",
      },
      {
        q: "Os dois celulares precisam estar na mesma rede Wi-Fi?",
        a: "Não. A mesma rede é o caminho mais rápido porque os dispositivos se descobrem automaticamente, mas um código de emparelhamento conecta dois celulares entre redes diferentes — mesmo um em dados móveis e outro em Wi-Fi. A transferência permanece criptografada de ponta a ponta nos dois casos, embora emparelhar entre redes exija que o remetente entre — o destinatário nunca precisa de conta.",
      },
      {
        q: "As fotos são comprimidas ou alteradas de alguma forma?",
        a: "Não. O arquivo original é transferido byte a byte sem compressão, e cada arquivo é verificado de ponta a ponta com um hash SHA-256, então o que chega ao iPhone é idêntico bit a bit ao que você enviou do Android.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium nos dois celulares e envie seus primeiros arquivos — sem instalação, e sem conta necessária na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/transfer-files-android-to-iphone",
  published: "2026-07-03",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
