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
    "Relayium skips all of that. Both phones open the same web page, find each other, and the files travel directly between them — end-to-end encrypted, no app to install. On the same network no account is needed; sending across networks with a pairing code just asks the sender to sign in. This guide walks through it step by step.",
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
        "Both screens show the same 6-digit code. Check that they match; this is the verification code that proves no server has slipped in between you.",
        "Accept on the receiving iPhone and the files transfer directly, then save to your device.",
      ],
    },
    {
      heading: "On different networks? Use a pairing code",
      body: [
        "You don't have to be on the same Wi-Fi. If the phones are on different networks — one on mobile data, the other on home Wi-Fi — Relayium can still connect them with a pairing code.",
        "The sending device shows a short pairing code; enter it on the other phone (or open the share link it generates). The transfer still goes directly peer-to-peer whenever possible, and when a direct path isn't available it falls back to an encrypted TURN relay that only ever sees ciphertext — so the transfer stays end-to-end encrypted either way. If the connection drops mid-transfer, it can resume instead of starting over. Sending this way needs the sender to sign in — the person receiving never needs an account.",
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
        "To prove it, each file is verified end-to-end with a SHA-256 hash, so a photo or video that arrives is guaranteed identical to the one you sent. Large files are handled well too: in Chrome and Edge the download streams straight to disk with no size cap, while Firefox and Safari buffer in memory, so on those keep a single transfer under about 200 MB.",
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
    "Relayium 把这些统统省掉。两台手机打开同一个网页，彼此发现，文件就在它们之间直接传输——端到端加密、无需安装应用。同一网络下无需账号；跨网络用配对码传输只需发送方登录一下。本文一步步带你完成。",
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
        "两边屏幕会显示同一段 6 位校验码。核对它们是否一致；这段校验码证明没有服务器插在你们中间。",
        "在接收方 iPhone 上确认接收，文件就会直接传过来，随后保存到设备里。",
      ],
    },
    {
      heading: "不在同一网络？用配对码",
      body: [
        "你不必连同一个 Wi-Fi。如果两台手机在不同网络——一台用移动数据，另一台用家里的 Wi-Fi——Relayium 依然能用配对码把它们连起来。",
        "发送方设备会显示一段简短的配对码，在另一台手机上输入即可（或打开它生成的分享链接）。只要条件允许，传输仍然点对点直连；当无法直连时，会退回到加密的 TURN 中继，而中继只能看到密文——所以无论哪种方式，传输都保持端到端加密。若中途连接断开，可以断点续传，而不必从头再来。这样发送需要发送方登录——接收方始终无需账号。",
      ],
    },
    {
      heading: "在安卓和 iPhone 间传文件的其他方式",
      body: [
        "Relayium 并不是唯一选择，了解各备选方案诚实的取舍也很有必要：",
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
        "为了证明这一点，每个文件都用 SHA-256 做端到端校验，所以收到的照片或视频保证与你发送的完全一致。大文件也处理得很好：在 Chrome 和 Edge 里，下载会直接流式写入磁盘，没有大小上限；而 Firefox 和 Safari 在内存中缓冲，所以在这两者上单次传输建议控制在约 200 MB 以内。",
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
    "Relayium はそれをすべて省きます。2台のスマホが同じ Web ページを開き、互いを見つけ、ファイルは端末間で直接転送されます——エンドツーエンド暗号化、アプリのインストール不要。同じネットワークならアカウントも不要で、ネットワークをまたいでペアリングコードで送る場合も送信側がサインインするだけです。本記事で手順を順に説明します。",
  ],
  sections: [
    {
      heading: "始める前に必要なもの",
      body: [
        "インストールは不要です。同じネットワークなら登録も不要——リアルタイム転送は両方の端末のブラウザからそのまま使えます。",
      ],
      bullets: [
        "Chrome（または任意の最新ブラウザ）が入った Android 端末と、Safari を使う iPhone——どちらも最新の状態に。",
        "最速の経路は、両方の端末を同じ Wi-Fi ネットワークに置くことです。無理でも大丈夫——ペアリングコードは異なるネットワークをまたいでも機能します。",
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
        "送るファイルを選びます——1バッチ最大1,000個——またはそのままドラッグして入れます。",
        "両方の画面に同じ6桁のコードが表示されます。一致するか確認してください。これは、間にサーバーが入り込んでいないことを示す検証コードです。",
        "受信側の iPhone で承認するとファイルが直接転送され、端末に保存されます。",
      ],
    },
    {
      heading: "異なるネットワークの場合は？ ペアリングコードを使う",
      body: [
        "同じ Wi-Fi である必要はありません。スマホが別々のネットワーク——一方はモバイルデータ、もう一方は自宅の Wi-Fi——にあっても、Relayium はペアリングコードで両者を接続できます。",
        "送信側の端末が短いペアリングコードを表示するので、もう一方のスマホで入力します（または生成された共有リンクを開きます）。可能な限り転送は P2P で直接行われ、直接の経路が使えないときは暗号化された TURN リレーにフォールバックしますが、リレーが見るのは暗号文だけです——どちらの場合も転送はエンドツーエンド暗号化のままです。途中で接続が切れても、最初からではなく再開できます。この方法で送るには送信側のサインインが必要です——受信側はアカウント不要です。",
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
        "落ちません。メッセージアプリと違い、Relayium は元のファイルをバイト単位でそのまま送ります——再圧縮もリサイズもしません。iPhone に届くのは、Android から出たものの正確なコピーです。",
        "それを裏づけるため、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるので、届いた写真や動画は送ったものと必ず同一です。大きなファイルもうまく扱えます。Chrome と Edge ではダウンロードがサイズ上限なしでそのままディスクにストリーミングされ、Firefox と Safari はメモリにバッファするため、その2つでは1回の転送を約200MB以内に抑えてください。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "どちらのスマホにもアプリのインストールは必要ですか？",
        a: "いいえ。Relayium は Android でも iPhone でもすべてブラウザで動作します。各端末で relayium.com を開けば準備完了です——どちらの方法でもダウンロードは不要です。同じネットワークならリアルタイム転送にアカウントは不要で、ネットワークをまたぐペアリングも送信側がサインインするだけです。任意で PWA としてホーム画面に追加できますが、それはショートカットにすぎません。",
      },
      {
        q: "両方のスマホが同じ Wi-Fi にある必要がありますか？",
        a: "いいえ。同じネットワークは端末が自動的に互いを見つけるため最速の経路ですが、ペアリングコードなら2台のスマホを異なるネットワークをまたいで接続できます——一方がモバイルデータ、もう一方が Wi-Fi でも大丈夫です。どちらの場合も転送はエンドツーエンド暗号化のままですが、ネットワークをまたぐペアリングには送信側のサインインが必要です——受信側はアカウント不要です。",
      },
      {
        q: "写真は圧縮されたり変更されたりしますか？",
        a: "いいえ。元のファイルは圧縮なしでバイト単位で転送され、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるため、iPhone に届くものは Android から送ったものとビット単位で同一です。",
      },
    ],
  },
  cta: {
    text: "両方のスマホで Relayium を開いて、最初のファイルを送ってみましょう——インストール不要、同じネットワークならアカウントも不要です。",
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
    "Relayium은 그 모든 것을 건너뜁니다. 두 휴대폰이 같은 웹 페이지를 열고 서로를 찾으면 파일이 기기 사이에서 직접 전송됩니다 — 종단간 암호화, 앱 설치 불필요. 같은 네트워크에서는 계정도 필요 없고, 페어링 코드로 네트워크를 넘어 보낼 때도 보내는 쪽이 로그인만 하면 됩니다. 이 글에서 단계별로 안내합니다.",
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
        "양쪽 화면에 같은 6자리 코드가 표시됩니다. 일치하는지 확인하세요. 이 코드는 사이에 서버가 끼어들지 않았음을 증명하는 검증 코드입니다.",
        "받는 아이폰에서 수락하면 파일이 직접 전송되고, 기기에 저장됩니다.",
      ],
    },
    {
      heading: "다른 네트워크라면? 페어링 코드를 쓰세요",
      body: [
        "같은 Wi-Fi일 필요는 없습니다. 휴대폰이 서로 다른 네트워크에 있어도 — 하나는 모바일 데이터, 다른 하나는 집 Wi-Fi — Relayium은 페어링 코드로 둘을 연결할 수 있습니다.",
        "보내는 기기가 짧은 페어링 코드를 표시하니, 다른 폰에서 입력하세요(또는 생성된 공유 링크를 여세요). 가능한 경우 전송은 여전히 P2P로 직접 이루어지고, 직접 경로가 없을 때는 암호화된 TURN 릴레이로 폴백하지만 릴레이는 암호문만 봅니다 — 어느 경우든 전송은 종단간 암호화를 유지합니다. 전송 중 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다. 이 방식으로 보내려면 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "안드로이드와 아이폰 사이에서 파일을 옮기는 다른 방법",
      body: [
        "Relayium만이 선택지는 아니며, 대안들의 솔직한 절충점을 알아 둘 가치가 있습니다:",
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
        "이를 증명하기 위해 각 파일은 SHA-256 해시로 종단간 검증되므로, 도착한 사진이나 동영상은 보낸 것과 반드시 동일합니다. 큰 파일도 잘 처리됩니다. Chrome과 Edge에서는 다운로드가 크기 제한 없이 곧바로 디스크로 스트리밍되고, Firefox와 Safari는 메모리에 버퍼링하므로 그 둘에서는 한 번의 전송을 약 200MB 이내로 유지하세요.",
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
    "Android und iPhone teilen sich kein AirDrop, also bedeutet das Übertragen ein paar Fotos oder eines Videos meist ein USB-Kabel, eine Chat-App, die deine Bilder komprimiert, oder einen Umweg über irgendeine Cloud. Alle drei sind langsamer und umständlicher, als sie sein müssten.",
    "Relayium spart dir all das. Beide Handys öffnen dieselbe Webseite, finden sich und die Dateien wandern direkt zwischen ihnen — Ende-zu-Ende-verschlüsselt, keine App zu installieren. Im selben Netz ist kein Konto nötig; beim Senden über Netzwerke hinweg per Pairing-Code muss sich nur der Absender anmelden. Diese Anleitung führt dich Schritt für Schritt hindurch.",
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
        "Beide Bildschirme zeigen denselben sechsstelligen Code. Prüfe, ob sie übereinstimmen; das ist der Prüfcode, der belegt, dass sich kein Server dazwischengeschoben hat.",
        "Bestätige auf dem empfangenden iPhone, dann werden die Dateien direkt übertragen und auf deinem Gerät gespeichert.",
      ],
    },
    {
      heading: "In verschiedenen Netzwerken? Nutze einen Pairing-Code",
      body: [
        "Ihr müsst nicht im selben WLAN sein. Sind die Handys in verschiedenen Netzwerken — eines im Mobilfunk, das andere im Heim-WLAN — kann Relayium sie trotzdem per Pairing-Code verbinden.",
        "Das sendende Gerät zeigt einen kurzen Pairing-Code; gib ihn auf dem anderen Handy ein (oder öffne den erzeugten Freigabelink). Die Übertragung läuft nach Möglichkeit weiterhin direkt Peer-to-Peer, und wenn kein direkter Weg verfügbar ist, weicht sie auf ein verschlüsseltes TURN-Relay aus, das nur Chiffretext sieht — so bleibt die Übertragung in beiden Fällen Ende-zu-Ende-verschlüsselt. Bricht die Verbindung mittendrin ab, kann sie fortgesetzt statt neu gestartet werden. Für diesen Weg muss sich der Absender anmelden — der Empfänger braucht nie ein Konto.",
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
        "Zum Beleg wird jede Datei per SHA-256-Hash Ende-zu-Ende geprüft, sodass ein ankommendes Foto oder Video garantiert identisch mit dem gesendeten ist. Auch große Dateien werden gut gehandhabt: In Chrome und Edge streamt der Download ohne Größenbegrenzung direkt auf die Festplatte, während Firefox und Safari im Speicher puffern — halte dort eine einzelne Übertragung also unter etwa 200 MB.",
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
    "Relayium fait l'impasse sur tout cela. Les deux téléphones ouvrent la même page web, se trouvent, et les fichiers voyagent directement entre eux — chiffrés de bout en bout, aucune application à installer. Sur le même réseau, aucun compte n'est nécessaire ; pour envoyer entre réseaux différents avec un code d'appairage, l'expéditeur n'a qu'à se connecter. Ce guide vous accompagne pas à pas.",
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
        "Les fichiers à envoyer, jusqu'à 1 000 par lot.",
      ],
    },
    {
      heading: "Pas à pas : les deux appareils sur le même Wi-Fi",
      body: [
        "C'est la voie la plus simple. Sur le même réseau, les deux téléphones se découvrent automatiquement, il n'y a donc presque rien à saisir.",
      ],
      bullets: [
        "Sur le téléphone Android et sur l'iPhone, ouvrez relayium.com dans le navigateur.",
        "Chaque appareil apparaît sur l'autre comme un appareil à proximité. Sur le téléphone qui envoie, touchez celui qui reçoit.",
        "Choisissez les fichiers à envoyer — jusqu'à 1 000 par lot — ou faites-les simplement glisser.",
        "Les deux écrans affichent le même code à 6 chiffres. Vérifiez qu'ils concordent ; c'est le code de vérification qui prouve qu'aucun serveur ne s'est intercalé entre vous.",
        "Acceptez sur l'iPhone qui reçoit, les fichiers se transfèrent directement, puis enregistrez-les sur votre appareil.",
      ],
    },
    {
      heading: "Sur des réseaux différents ? Utilisez un code d'appairage",
      body: [
        "Vous n'avez pas besoin d'être sur le même Wi-Fi. Si les téléphones sont sur des réseaux différents — l'un en données mobiles, l'autre sur le Wi-Fi de la maison — Relayium peut quand même les connecter avec un code d'appairage.",
        "L'appareil qui envoie affiche un court code d'appairage ; saisissez-le sur l'autre téléphone (ou ouvrez le lien de partage qu'il génère). Le transfert reste en pair-à-pair direct chaque fois que possible, et quand aucune voie directe n'est disponible, il bascule vers un relais TURN chiffré qui ne voit que du texte chiffré — le transfert reste donc chiffré de bout en bout dans les deux cas. Si la connexion se coupe en cours de route, il peut reprendre au lieu de tout recommencer. Envoyer ainsi exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte.",
      ],
    },
    {
      heading: "Autres façons de déplacer des fichiers entre Android et iPhone",
      body: [
        "Relayium n'est pas la seule option, et il vaut la peine de connaître les compromis honnêtes des solutions de rechange :",
      ],
      bullets: [
        "Le Partage rapide de Google et des applications tierces comme SHAREit transfèrent vite, mais exigent une installation sur les deux téléphones, et le Partage rapide n'atteint pas les iPhone.",
        "Un espace cloud (Google Drive, iCloud, Dropbox) fonctionne quand l'autre personne est hors ligne, mais vous téléversez puis téléchargez deux fois le même fichier, cela grignote votre quota, et le fournisseur en garde une copie.",
        "Les messageries et l'e-mail sont partout, mais elles recompressent souvent les photos, limitent la taille des pièces jointes et ne sont pas chiffrées de bout en bout pour le partage de fichiers.",
        "Un câble USB est fiable, mais demande le bon adaptateur entre USB-C et Lightning, plus un ordinateur au milieu pour beaucoup de types de fichiers.",
      ],
    },
    {
      heading: "Mes photos perdront-elles en qualité ?",
      body: [
        "Non. Contrairement à une messagerie, Relayium envoie le fichier d'origine octet par octet — aucune recompression, aucun redimensionnement. Ce qui arrive sur l'iPhone est une copie exacte de ce qui a quitté le téléphone Android.",
        "Pour le prouver, chaque fichier est vérifié de bout en bout par une empreinte SHA-256, si bien qu'une photo ou une vidéo qui arrive est garantie identique à celle que vous avez envoyée. Les gros fichiers sont bien gérés aussi : dans Chrome et Edge, le téléchargement est écrit directement sur le disque sans limite de taille, tandis que Firefox et Safari tamponnent en mémoire — sur ceux-là, gardez donc un transfert unique sous environ 200 Mo.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je installer une application sur l'un des téléphones ?",
        a: "Non. Relayium fonctionne entièrement dans le navigateur, sur Android comme sur iPhone. Ouvrez relayium.com sur chaque appareil et vous êtes prêt — aucun téléchargement dans les deux cas. Sur le même réseau, un transfert en temps réel ne demande aucun compte ; s'appairer entre réseaux différents demande seulement que l'expéditeur se connecte. Vous pouvez au choix l'ajouter à l'écran d'accueil comme PWA, mais ce n'est qu'un raccourci.",
      },
      {
        q: "Les deux téléphones doivent-ils être sur le même Wi-Fi ?",
        a: "Non. Le même réseau est la voie la plus rapide car les appareils se découvrent automatiquement, mais un code d'appairage connecte deux téléphones sur des réseaux différents — même l'un en données mobiles et l'autre en Wi-Fi. Le transfert reste chiffré de bout en bout dans les deux cas, même si s'appairer entre réseaux différents exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte.",
      },
      {
        q: "Les photos sont-elles compressées ou modifiées d'une quelconque façon ?",
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

export default {
  slug: "how-to/transfer-files-android-to-iphone",
  updated: "2026-07-03",
  langs: { en, zh, ja, ko, de, fr },
};
