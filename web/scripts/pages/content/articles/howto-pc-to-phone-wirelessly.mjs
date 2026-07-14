// web/scripts/pages/content/articles/howto-pc-to-phone-wirelessly.mjs
// How-to: send files from a PC to a phone wirelessly, no cable or cloud login.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical
// facts. Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "Send files from PC to phone wirelessly, no cable or app",
  description:
    "A step-by-step guide to moving files between a computer and a phone over Wi-Fi — drag and drop, no USB cable, no cloud account, and end-to-end encrypted the whole way.",
  updatedLabel: "Last updated",
  lead: [
    "Getting a file from your laptop onto your phone should not mean hunting for the right cable, emailing yourself, or uploading to a cloud drive and downloading it again. Relayium moves the bytes straight from your computer to your phone over your own Wi-Fi, in the browser, with nothing to install on either side.",
    "This guide walks through the wireless way step by step — same network or across networks — then compares it honestly with the usual alternatives (USB, Bluetooth, chat apps and email) so you can pick the right tool for the job.",
  ],
  sections: [
    {
      heading: "Send from PC to phone on the same Wi-Fi",
      body: [
        "This is the fastest path: both devices are on the same network, so they connect directly and the transfer is bounded only by your Wi-Fi. You need nothing but a browser on each device.",
      ],
      bullets: [
        "On the computer, open relayium.com in any modern browser (Chrome, Edge, Firefox or Safari).",
        "On the phone, open relayium.com too. On the same network, the two devices discover each other automatically.",
        "On the computer, drag files straight onto the page, or click to pick them — up to 1,000 files per batch. You can drop a whole folder and Relayium keeps its structure.",
        "Pick the phone as the destination and start. Both devices show the same 6-digit verification code (SAS); glance at them, confirm they match, and the files fly over.",
        "On the phone, save the received files. No account is needed for a realtime transfer like this.",
      ],
    },
    {
      heading: "Not on the same network? Use a pairing code",
      body: [
        "Your phone is on mobile data and your PC is on home Wi-Fi? That is fine — Relayium is built to reach across networks, not only the same one.",
        "Instead of automatic discovery, the sender gets a short pairing code (or the join link it generates) and signs in to generate it — the person receiving never needs an account. Enter the code on the other device and the two connect directly, peer-to-peer, whenever the networks allow it. When a direct path is impossible, the encrypted stream falls back to a TURN relay — the relay only ever sees ciphertext, so the transfer stays end-to-end encrypted. If the connection drops mid-way, the transfer can resume instead of starting over.",
      ],
    },
    {
      heading: "Install it like an app (optional PWA)",
      body: [
        "Relayium is a website, so there is genuinely nothing to install. But if you send files often, you can add it to your home screen or desktop as a Progressive Web App: it then opens in its own window and launches like a native app, while still being just the web page under the hood.",
        "On the phone, use your browser's \"Add to Home Screen\" option; on the computer, use the install icon in the address bar. It stays free either way — Relayium is open source under the MIT license at github.com/relayium/relayium, and works on Windows, macOS, Linux, Android and iOS.",
      ],
    },
    {
      heading: "Big files: what your browser can handle",
      body: [
        "Because a realtime transfer never parks your files on a server, there is no upload quota to worry about. The practical limit is which browser is receiving.",
        "In Chrome or Edge, incoming data streams straight to disk, so there is effectively no size cap — multi-gigabyte videos are fine. Firefox and Safari buffer the file in memory instead, so on those keep a single file under roughly 200 MB. If you need to send something large to a Safari-based iPhone, receiving on a Chrome-based device avoids the limit entirely.",
      ],
    },
    {
      heading: "Other ways to move files PC to phone (and their limits)",
      body: [
        "Wireless in the browser is not the only option, and the honest answer is that each alternative has its place. Here is how the common ones compare:",
      ],
      bullets: [
        "USB cable: reliable and fast, but you need the right cable, and phone-to-PC file access can be fiddly (especially iPhone to Windows). It is wired, not wireless.",
        "Bluetooth: truly cable-free, but slow — sending a few large photos can take minutes, and it is impractical for videos or large batches.",
        "Chat apps or emailing yourself (WeChat, Telegram, mail): convenient if you already have them open, but most impose size limits, may re-compress photos, and route your files through a third-party server rather than keeping them private.",
        "Relayium: wireless, no install, no account needed on the same network (only the sender signs in to pair across networks), no re-compression (byte-for-byte with a per-file SHA-256 integrity check), and end-to-end encrypted with a verification code you can check yourself.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does this work with Mac and Android, not just Windows and iPhone?",
        a: "Yes. Relayium runs in the browser on Windows, macOS, Linux, Android and iOS, so any combination works — Windows to Android, Mac to iPhone, Linux to a phone, and back the other way. There is nothing to install on either device.",
      },
      {
        q: "How fast is the transfer?",
        a: "On the same Wi-Fi the two devices connect directly, so speed is bounded by your local network rather than by any server — usually as fast as your Wi-Fi allows. Across different networks it depends on both internet connections, and Relayium falls back to an encrypted relay only when a direct link is not possible.",
      },
      {
        q: "Is it secure to send files this way?",
        a: "Yes. On top of the browser's transport encryption, Relayium adds its own layer: an X25519 key exchange derives a key used for per-chunk AES-256-GCM, and that key never touches a server. Both devices show the same 6-digit code (SAS) so you can confirm no one is in the middle, and each file is verified end-to-end with a SHA-256 hash.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on your computer and your phone and send your first file wirelessly — no cable, no install, no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "电脑无线传文件到手机：不用数据线，不用装 App",
  description:
    "一步步教你在电脑和手机之间通过 Wi-Fi 传文件——拖拽即发，不用数据线，不用网盘账号，全程端到端加密。",
  updatedLabel: "最近更新",
  lead: [
    "把一个文件从笔记本弄到手机上，不该还得翻找合适的数据线、给自己发邮件，或者先上传到网盘再下载一遍。Relayium 通过你自己的 Wi-Fi，把文件字节直接从电脑传到手机，全程在浏览器里完成，两端都无需安装任何软件。",
    "本文一步步讲清无线传输的做法——同一网络或跨网络都行——再客观地和常见的几种替代方式（数据线、蓝牙、聊天软件和邮件）作对比，帮你为不同场景选对工具。",
  ],
  sections: [
    {
      heading: "同一 Wi-Fi 下，从电脑传到手机",
      body: [
        "这是最快的方式：两台设备在同一网络里，直接互连，传输速度只受你的 Wi-Fi 限制。除了浏览器，两边什么都不需要。",
      ],
      bullets: [
        "在电脑上用任意现代浏览器（Chrome、Edge、Firefox 或 Safari）打开 relayium.com。",
        "在手机上同样打开 relayium.com。在同一网络里，两台设备会自动发现彼此。",
        "在电脑上，把文件直接拖到页面上，或点击选择——每批最多 1,000 个文件。你也可以整个文件夹拖进去，Relayium 会保留其结构。",
        "选中手机作为目标并开始。两台设备会显示同一段 6 位校验码（SAS）；瞄一眼，确认一致，文件就飞过去了。",
        "在手机上保存收到的文件。像这样的实时传输无需账号。",
      ],
    },
    {
      heading: "不在同一网络？用配对码",
      body: [
        "手机用的是移动数据，电脑连的是家里的 Wi-Fi？没关系——Relayium 生来就支持跨网络，而不只是同一个网络。",
        "此时不再自动发现，而是发送方登录后拿到一个短配对码（或它生成的加入链接）——接收方始终无需账号。在另一台设备上输入这个码，两者就点对点直连，只要网络条件允许就直传。当无法直连时，加密数据流会退回到 TURN 中继——中继只能看到密文，因此传输始终保持端到端加密。若中途断开，传输可以断点续传，而不必从头再来。",
      ],
    },
    {
      heading: "像 App 一样安装（可选的 PWA）",
      body: [
        "Relayium 就是一个网站，所以确实没有什么要安装的。但如果你经常传文件，可以把它添加到主屏幕或桌面，作为渐进式网页应用（PWA）：它会在独立窗口中打开，像原生应用一样启动，而底层依然只是那张网页。",
        "在手机上用浏览器的\"添加到主屏幕\"；在电脑上用地址栏里的安装图标。无论哪种方式它都保持免费——Relayium 采用 MIT 许可开源，代码在 github.com/relayium/relayium，支持 Windows、macOS、Linux、Android 和 iOS。",
      ],
    },
    {
      heading: "大文件：你的浏览器能扛多大",
      body: [
        "由于实时传输从不把文件存到服务器上，所以不用担心任何上传配额。实际的上限取决于用哪个浏览器接收。",
        "在 Chrome 或 Edge 上，接收到的数据直接流式写入磁盘，因此几乎没有大小上限——几个 GB 的视频也没问题。Firefox 和 Safari 则是在内存里缓冲文件，所以在这两者上单个文件建议控制在约 200 MB 以内。如果你要把很大的文件发给基于 Safari 的 iPhone，改用基于 Chrome 的设备接收就能完全避开这个限制。",
      ],
    },
    {
      heading: "电脑传手机的其它方式（及其局限）",
      body: [
        "浏览器无线传输并不是唯一选择，而且说句实话，每种替代方式都有它的用武之地。常见的几种对比如下：",
      ],
      bullets: [
        "数据线：可靠又快，但你得有合适的线，而且手机到电脑的文件访问有时挺麻烦（尤其 iPhone 到 Windows）。它是有线的，不是无线。",
        "蓝牙：真正免线，但慢——发几张大照片就可能要好几分钟，传视频或大批文件很不现实。",
        "聊天软件或给自己发邮件（微信、Telegram、邮箱）：如果已经开着，用起来方便，但大多有大小限制、可能重新压缩照片，而且会把文件经由第三方服务器中转，而非保持私密。",
        "Relayium：无线、免安装、同一网络下免账号（跨网络配对仅需发送方登录）、不重新压缩（字节级传输并对每个文件做 SHA-256 完整性校验），且端到端加密，还带一个你能亲自核对的校验码。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Mac 和 Android 也行吗，不只是 Windows 和 iPhone？",
        a: "行。Relayium 在 Windows、macOS、Linux、Android 和 iOS 的浏览器里都能运行，所以任意组合都可以——Windows 传 Android、Mac 传 iPhone、Linux 传手机，反过来也一样。两端都无需安装任何东西。",
      },
      {
        q: "传输速度有多快？",
        a: "在同一 Wi-Fi 下，两台设备直接互连，所以速度由你的本地网络决定，而不受任何服务器限制——通常能跑满你的 Wi-Fi。跨网络时则取决于双方的网络，而且只有在无法直连时，Relayium 才会退回到加密中继。",
      },
      {
        q: "这样传文件安全吗？",
        a: "安全。在浏览器的传输加密之上，Relayium 再加了一层：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密，这把密钥从不接触服务器。两台设备会显示同一段 6 位校验码（SAS），你可以据此确认没有人插在中间；每个文件还会用 SHA-256 做端到端校验。",
      },
    ],
  },
  cta: {
    text: "在电脑和手机上同时打开 Relayium，无线发出你的第一个文件——不用数据线，不用安装，同一网络下也不用账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "PC からスマホへ無線でファイル転送：ケーブルもアプリも不要",
  description:
    "パソコンとスマホの間で Wi-Fi 経由でファイルを送る手順ガイド。ドラッグ＆ドロップだけ、USB ケーブル不要、クラウドのアカウント不要、しかも全行程がエンドツーエンド暗号化。",
  updatedLabel: "最終更新",
  lead: [
    "ノートPCのファイルをスマホに移すのに、合うケーブルを探したり、自分宛にメールしたり、クラウドにアップして再びダウンロードしたりする必要はないはずです。Relayium は自分の Wi-Fi を通じて、ファイルのバイトをパソコンからスマホへ直接送ります。すべてブラウザ内で完結し、どちらの端末にもインストールは要りません。",
    "本ガイドは無線での方法を段階的に説明します——同じネットワークでも、ネットワークをまたいでも。そのうえで、よくある代替手段（USB、Bluetooth、チャットアプリ、メール）と公平に比較し、用途に合った手段を選べるようにします。",
  ],
  sections: [
    {
      heading: "同じ Wi-Fi で PC からスマホへ送る",
      body: [
        "これが最速の方法です。2台が同じネットワークにあるので直接つながり、転送速度は Wi-Fi だけに左右されます。必要なのは各端末のブラウザだけです。",
      ],
      bullets: [
        "パソコンで、任意の最新ブラウザ（Chrome、Edge、Firefox、Safari）で relayium.com を開きます。",
        "スマホでも relayium.com を開きます。同じネットワークなら、2台は自動的に互いを発見します。",
        "パソコンで、ファイルをページ上に直接ドラッグするか、クリックして選びます——1バッチ最大1,000ファイル。フォルダごとドロップしても Relayium は構造を保ちます。",
        "宛先にスマホを選んで開始します。両方の端末が同じ6桁の検証コード（SAS）を表示します。ちらっと見て一致を確かめれば、ファイルが飛んでいきます。",
        "スマホで受け取ったファイルを保存します。このようなリアルタイム転送にアカウントは不要です。",
      ],
    },
    {
      heading: "同じネットワークにない？ペアリングコードを使う",
      body: [
        "スマホはモバイル通信、PC は自宅の Wi-Fi？大丈夫です——Relayium は同じネットワークだけでなく、ネットワークをまたいで届くように作られています。",
        "この場合は自動発見ではなく、送信側がサインインして短いペアリングコード（またはそれが生成する参加リンク）を受け取ります——受信側はアカウント不要です。もう一方の端末でそのコードを入力すると、ネットワークが許す限り2台は P2P で直接つながります。直接の経路が不可能なときは、暗号化ストリームが TURN リレーにフォールバックしますが、リレーが見るのは暗号文だけなので、転送はエンドツーエンド暗号化のままです。途中で切れても、転送は最初からではなく再開できます。",
      ],
    },
    {
      heading: "アプリのようにインストール（任意の PWA）",
      body: [
        "Relayium はウェブサイトなので、本当にインストールするものはありません。ただ、頻繁に送るなら、ホーム画面やデスクトップにプログレッシブウェブアプリ（PWA）として追加できます。独立したウィンドウで開き、ネイティブアプリのように起動しますが、中身はあくまでそのウェブページです。",
        "スマホではブラウザの「ホーム画面に追加」を、パソコンではアドレスバーのインストールアイコンを使います。どちらでも無料のままです——Relayium は MIT ライセンスのオープンソースで、コードは github.com/relayium/relayium にあり、Windows、macOS、Linux、Android、iOS で動作します。",
      ],
    },
    {
      heading: "大きなファイル：ブラウザが扱える上限",
      body: [
        "リアルタイム転送はファイルをサーバーに置かないため、アップロードの割り当てを気にする必要はありません。実際の上限は、どのブラウザで受信するかで決まります。",
        "Chrome や Edge では受信データがそのままディスクへストリーミングされるので、事実上サイズの上限はなく、数ギガバイトの動画でも問題ありません。Firefox と Safari はファイルをメモリにバッファするため、これらでは1ファイルを約 200 MB 以内に抑えてください。Safari ベースの iPhone に大きなものを送りたい場合は、Chrome ベースの端末で受信すればこの制限を完全に回避できます。",
      ],
    },
    {
      heading: "PC からスマホへ送る他の方法（とその限界）",
      body: [
        "ブラウザでの無線転送だけが選択肢ではなく、正直に言えば、どの代替手段にもそれぞれの出番があります。よくあるものの比較は次のとおりです。",
      ],
      bullets: [
        "USB ケーブル：信頼できて速いですが、合うケーブルが要り、スマホから PC へのファイルアクセスは面倒なこともあります（特に iPhone から Windows）。有線であって無線ではありません。",
        "Bluetooth：本当にケーブル不要ですが遅く——大きな写真を数枚送るだけで数分かかることもあり、動画や大量のバッチには非現実的です。",
        "チャットアプリや自分宛メール（LINE、Telegram、メール）：すでに開いていれば便利ですが、多くはサイズ制限があり、写真を再圧縮することもあり、しかもファイルを第三者のサーバー経由で送るため私的なまま保てません。",
        "Relayium：無線、インストール不要、同じネットワークならアカウント不要（ネットワークをまたぐペアリングは送信側のサインインのみ）、再圧縮なし（ファイルごとの SHA-256 整合性チェック付きでバイト単位）、そして自分で確認できる検証コード付きのエンドツーエンド暗号化。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Windows と iPhone だけでなく、Mac や Android でも使えますか？",
        a: "はい。Relayium は Windows、macOS、Linux、Android、iOS のブラウザで動作するので、どの組み合わせでも使えます——Windows から Android、Mac から iPhone、Linux からスマホ、その逆も同様です。どちらの端末にもインストールするものはありません。",
      },
      {
        q: "転送はどのくらい速いですか？",
        a: "同じ Wi-Fi では2台が直接つながるため、速度はサーバーではなくローカルネットワークで決まり、たいてい Wi-Fi の許す限りの速さです。ネットワークをまたぐ場合は双方の回線しだいで、直接リンクが不可能なときにだけ Relayium は暗号化リレーにフォールバックします。",
      },
      {
        q: "この方法でファイルを送っても安全ですか？",
        a: "はい。ブラウザの転送暗号化に加えて、Relayium は独自の層を重ねます。X25519 の鍵交換で導出した鍵をブロックごとの AES-256-GCM に使い、その鍵はサーバーに触れません。両方の端末が同じ6桁のコード（SAS）を表示するので、間に誰もいないことを確認でき、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。",
      },
    ],
  },
  cta: {
    text: "パソコンとスマホで Relayium を開き、最初のファイルを無線で送ってみてください——ケーブルもインストールも不要、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "PC에서 폰으로 무선 파일 전송: 케이블도 앱도 필요 없이",
  description:
    "컴퓨터와 휴대폰 사이에서 Wi-Fi로 파일을 옮기는 단계별 가이드 — 드래그 앤 드롭, USB 케이블 없이, 클라우드 계정 없이, 게다가 전 과정 종단간 암호화.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "노트북의 파일을 휴대폰으로 옮기는 데 맞는 케이블을 찾거나, 자신에게 메일을 보내거나, 클라우드에 올렸다가 다시 내려받을 필요는 없어야 합니다. Relayium은 자신의 Wi-Fi를 통해 파일 바이트를 컴퓨터에서 휴대폰으로 곧장 보냅니다. 모두 브라우저 안에서 끝나며, 양쪽 기기 어디에도 설치할 것이 없습니다.",
    "이 가이드는 무선 방식을 단계별로 설명합니다 — 같은 네트워크든 서로 다른 네트워크든. 그런 다음 흔한 대안(USB, 블루투스, 채팅 앱, 메일)과 공정하게 비교해, 상황에 맞는 도구를 고를 수 있게 합니다.",
  ],
  sections: [
    {
      heading: "같은 Wi-Fi에서 PC에서 폰으로 보내기",
      body: [
        "이것이 가장 빠른 방법입니다. 두 기기가 같은 네트워크에 있어 직접 연결되고, 전송 속도는 오직 Wi-Fi에만 좌우됩니다. 각 기기의 브라우저 외에는 아무것도 필요 없습니다.",
      ],
      bullets: [
        "컴퓨터에서 최신 브라우저(Chrome, Edge, Firefox 또는 Safari)로 relayium.com을 엽니다.",
        "휴대폰에서도 relayium.com을 엽니다. 같은 네트워크라면 두 기기가 자동으로 서로를 찾습니다.",
        "컴퓨터에서 파일을 페이지 위로 바로 드래그하거나 클릭해 고릅니다 — 배치당 최대 1,000개. 폴더째 드롭해도 Relayium이 구조를 유지합니다.",
        "대상으로 휴대폰을 고르고 시작합니다. 두 기기가 동일한 6자리 검증 코드(SAS)를 표시합니다. 힐끗 보고 일치를 확인하면 파일이 날아갑니다.",
        "휴대폰에서 받은 파일을 저장합니다. 이런 실시간 전송에는 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "같은 네트워크가 아니라면? 페어링 코드를 쓰세요",
      body: [
        "휴대폰은 모바일 데이터, PC는 집 Wi-Fi인가요? 괜찮습니다 — Relayium은 같은 네트워크뿐 아니라 네트워크를 넘나들며 닿도록 만들어졌습니다.",
        "이 경우 자동 탐색 대신 보내는 쪽이 로그인해서 짧은 페어링 코드(또는 그것이 생성하는 참여 링크)를 받습니다 — 받는 쪽은 계정이 필요 없습니다. 상대 기기에 그 코드를 입력하면 네트워크가 허락하는 한 두 기기가 P2P로 직접 연결됩니다. 직접 경로가 불가능할 때는 암호화된 스트림이 TURN 릴레이로 폴백하지만, 릴레이는 암호문만 보므로 전송은 종단간 암호화를 유지합니다. 도중에 끊겨도 전송은 처음부터가 아니라 이어서 재개할 수 있습니다.",
      ],
    },
    {
      heading: "앱처럼 설치하기 (선택적 PWA)",
      body: [
        "Relayium은 웹사이트라서 정말로 설치할 것이 없습니다. 다만 자주 보낸다면 홈 화면이나 바탕화면에 프로그레시브 웹 앱(PWA)으로 추가할 수 있습니다. 그러면 독립된 창에서 열리고 네이티브 앱처럼 실행되지만, 속은 여전히 그 웹 페이지입니다.",
        "휴대폰에서는 브라우저의 '홈 화면에 추가'를, 컴퓨터에서는 주소창의 설치 아이콘을 씁니다. 어느 쪽이든 무료 그대로입니다 — Relayium은 MIT 라이선스 오픈소스이며 코드는 github.com/relayium/relayium에 있고, Windows, macOS, Linux, Android, iOS에서 동작합니다.",
      ],
    },
    {
      heading: "큰 파일: 브라우저가 감당할 수 있는 크기",
      body: [
        "실시간 전송은 파일을 서버에 두지 않으므로 업로드 할당량을 걱정할 필요가 없습니다. 실제 상한은 어떤 브라우저로 받느냐에 달렸습니다.",
        "Chrome이나 Edge에서는 들어오는 데이터가 곧장 디스크로 스트리밍되어 사실상 크기 상한이 없어, 수 기가바이트 동영상도 괜찮습니다. Firefox와 Safari는 파일을 메모리에 버퍼링하므로 이들에서는 한 파일을 약 200 MB 이내로 두세요. Safari 기반 iPhone에 큰 것을 보내야 한다면 Chrome 기반 기기로 받으면 이 제한을 완전히 피할 수 있습니다.",
      ],
    },
    {
      heading: "PC에서 폰으로 옮기는 다른 방법 (그리고 그 한계)",
      body: [
        "브라우저 무선 전송만이 선택지는 아니며, 솔직히 말하면 각 대안마다 쓸모가 있습니다. 흔한 것들을 비교하면 다음과 같습니다.",
      ],
      bullets: [
        "USB 케이블: 믿음직하고 빠르지만 맞는 케이블이 필요하고, 휴대폰에서 PC로의 파일 접근이 번거로울 수 있습니다(특히 iPhone에서 Windows). 무선이 아니라 유선입니다.",
        "블루투스: 정말로 케이블이 없지만 느립니다 — 큰 사진 몇 장 보내는 데 몇 분이 걸리기도 하고, 동영상이나 대량 배치에는 비현실적입니다.",
        "채팅 앱이나 자신에게 메일(카카오톡, Telegram, 메일): 이미 열려 있으면 편하지만 대부분 크기 제한이 있고, 사진을 다시 압축하기도 하며, 파일을 제3자 서버를 거쳐 보내 사적으로 유지되지 않습니다.",
        "Relayium: 무선, 설치 불필요, 같은 네트워크에서는 계정 불필요(네트워크를 넘는 페어링은 보내는 쪽 로그인만 필요), 재압축 없음(파일별 SHA-256 무결성 검사와 함께 바이트 단위), 그리고 직접 확인할 수 있는 검증 코드가 있는 종단간 암호화.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Windows와 iPhone뿐 아니라 Mac과 Android에서도 되나요?",
        a: "네. Relayium은 Windows, macOS, Linux, Android, iOS의 브라우저에서 동작하므로 어떤 조합이든 됩니다 — Windows에서 Android로, Mac에서 iPhone으로, Linux에서 휴대폰으로, 그리고 그 반대도 마찬가지입니다. 양쪽 기기 어디에도 설치할 것이 없습니다.",
      },
      {
        q: "전송은 얼마나 빠른가요?",
        a: "같은 Wi-Fi에서는 두 기기가 직접 연결되어 속도가 서버가 아닌 로컬 네트워크로 결정되며, 보통 Wi-Fi가 허락하는 만큼 빠릅니다. 서로 다른 네트워크에서는 양쪽 인터넷 회선에 달렸고, 직접 연결이 불가능할 때만 Relayium이 암호화된 릴레이로 폴백합니다.",
      },
      {
        q: "이렇게 파일을 보내도 안전한가요?",
        a: "네. 브라우저의 전송 암호화 위에 Relayium은 자체 계층을 더합니다. X25519 키 교환으로 도출한 키를 블록별 AES-256-GCM에 쓰며, 이 키는 서버에 닿지 않습니다. 두 기기가 동일한 6자리 코드(SAS)를 표시해 중간에 아무도 없음을 확인할 수 있고, 각 파일은 SHA-256 해시로 종단간 검증됩니다.",
      },
    ],
  },
  cta: {
    text: "컴퓨터와 휴대폰에서 Relayium을 열고 첫 파일을 무선으로 보내 보세요 — 케이블도 설치도 필요 없고, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien vom PC drahtlos aufs Handy senden — ohne Kabel, ohne App",
  description:
    "Eine Schritt-für-Schritt-Anleitung, um Dateien per WLAN zwischen Computer und Handy zu bewegen — per Drag-and-drop, ohne USB-Kabel, ohne Cloud-Konto und durchgehend Ende-zu-Ende-verschlüsselt.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Eine Datei vom Laptop aufs Handy zu bekommen, sollte nicht bedeuten, das richtige Kabel zu suchen, sich selbst eine E-Mail zu schreiben oder etwas in eine Cloud hochzuladen und wieder herunterzuladen. Relayium bewegt die Bytes über dein eigenes WLAN direkt vom Computer aufs Handy, im Browser, ohne dass auf einer Seite etwas installiert werden muss.",
    "Diese Anleitung zeigt den drahtlosen Weg Schritt für Schritt — im selben Netz oder netzwerkübergreifend — und vergleicht ihn dann ehrlich mit den üblichen Alternativen (USB, Bluetooth, Chat-Apps und E-Mail), damit du das passende Werkzeug wählen kannst.",
  ],
  sections: [
    {
      heading: "Im selben WLAN vom PC aufs Handy senden",
      body: [
        "Das ist der schnellste Weg: Beide Geräte sind im selben Netz, verbinden sich also direkt, und die Übertragung ist nur durch dein WLAN begrenzt. Du brauchst nichts außer einem Browser auf jedem Gerät.",
      ],
      bullets: [
        "Öffne am Computer relayium.com in einem beliebigen modernen Browser (Chrome, Edge, Firefox oder Safari).",
        "Öffne relayium.com auch auf dem Handy. Im selben Netz erkennen sich die beiden Geräte automatisch.",
        "Ziehe am Computer Dateien direkt auf die Seite oder klicke, um sie auszuwählen — bis zu 1.000 Dateien pro Stapel. Du kannst einen ganzen Ordner ablegen, und Relayium behält dessen Struktur bei.",
        "Wähle das Handy als Ziel und starte. Beide Geräte zeigen denselben sechsstelligen Prüfcode (SAS); ein kurzer Blick, bestätige die Übereinstimmung, und die Dateien fliegen hinüber.",
        "Speichere die empfangenen Dateien auf dem Handy. Für eine solche Echtzeitübertragung ist kein Konto nötig.",
      ],
    },
    {
      heading: "Nicht im selben Netz? Nimm einen Pairing-Code",
      body: [
        "Das Handy ist im Mobilfunknetz und der PC im heimischen WLAN? Kein Problem — Relayium ist darauf ausgelegt, über Netzwerke hinweg zu reichen, nicht nur im selben.",
        "Statt automatischer Erkennung meldet sich der Absender an und erhält einen kurzen Pairing-Code (oder den erzeugten Beitrittslink) — der Empfänger braucht dabei nie ein Konto. Gib den Code auf dem anderen Gerät ein, und die beiden verbinden sich direkt Peer-to-Peer, sofern die Netzwerke es zulassen. Ist ein direkter Weg unmöglich, weicht der verschlüsselte Datenstrom auf ein TURN-Relay aus — das Relay sieht nur Chiffretext, sodass die Übertragung Ende-zu-Ende-verschlüsselt bleibt. Bricht die Verbindung mittendrin ab, kann die Übertragung fortgesetzt werden, statt neu zu beginnen.",
      ],
    },
    {
      heading: "Wie eine App installieren (optionale PWA)",
      body: [
        "Relayium ist eine Website, es gibt also wirklich nichts zu installieren. Wenn du aber oft Dateien sendest, kannst du sie als Progressive Web App (PWA) zum Startbildschirm oder Desktop hinzufügen: Sie öffnet sich dann in einem eigenen Fenster und startet wie eine native App, während sie im Kern weiterhin nur die Webseite ist.",
        "Nutze auf dem Handy die Option „Zum Startbildschirm hinzufügen“ deines Browsers; am Computer das Installationssymbol in der Adressleiste. Kostenlos bleibt es so oder so — Relayium ist quelloffen unter der MIT-Lizenz auf github.com/relayium/relayium und läuft unter Windows, macOS, Linux, Android und iOS.",
      ],
    },
    {
      heading: "Große Dateien: was dein Browser bewältigt",
      body: [
        "Da eine Echtzeitübertragung deine Dateien nie auf einem Server ablegt, musst du dich um kein Upload-Kontingent kümmern. Die praktische Grenze hängt davon ab, welcher Browser empfängt.",
        "In Chrome oder Edge streamen eingehende Daten direkt auf die Festplatte, es gibt also praktisch keine Größengrenze — Videos mit mehreren Gigabyte sind kein Problem. Firefox und Safari puffern die Datei stattdessen im Arbeitsspeicher, halte dort eine einzelne Datei also unter etwa 200 MB. Wenn du etwas Großes an ein Safari-basiertes iPhone senden musst, umgehst du die Grenze vollständig, indem du auf einem Chrome-basierten Gerät empfängst.",
      ],
    },
    {
      heading: "Andere Wege vom PC aufs Handy (und ihre Grenzen)",
      body: [
        "Drahtlos im Browser ist nicht die einzige Möglichkeit, und ehrlich gesagt hat jede Alternative ihren Platz. So schneiden die üblichen ab:",
      ],
      bullets: [
        "USB-Kabel: zuverlässig und schnell, aber du brauchst das richtige Kabel, und der Dateizugriff vom Handy zum PC kann fummelig sein (besonders iPhone zu Windows). Es ist kabelgebunden, nicht drahtlos.",
        "Bluetooth: wirklich kabellos, aber langsam — schon ein paar große Fotos können Minuten dauern, und für Videos oder große Stapel ist es unpraktisch.",
        "Chat-Apps oder E-Mail an sich selbst (WhatsApp, Telegram, Mail): praktisch, wenn schon geöffnet, aber die meisten haben Größenbeschränkungen, komprimieren Fotos womöglich neu und leiten deine Dateien über einen fremden Server, statt sie privat zu halten.",
        "Relayium: drahtlos, ohne Installation, im selben Netz ohne Konto (nur der Absender meldet sich für Pairing über Netzwerke hinweg an), ohne Neukomprimierung (byteweise mit SHA-256-Integritätsprüfung je Datei) und Ende-zu-Ende-verschlüsselt mit einem Prüfcode, den du selbst kontrollieren kannst.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Funktioniert das auch mit Mac und Android, nicht nur Windows und iPhone?",
        a: "Ja. Relayium läuft im Browser unter Windows, macOS, Linux, Android und iOS, jede Kombination funktioniert also — Windows zu Android, Mac zu iPhone, Linux zu einem Handy und umgekehrt. Auf keinem Gerät muss etwas installiert werden.",
      },
      {
        q: "Wie schnell ist die Übertragung?",
        a: "Im selben WLAN verbinden sich die beiden Geräte direkt, die Geschwindigkeit hängt also von deinem lokalen Netz ab und nicht von einem Server — meist so schnell, wie dein WLAN es erlaubt. Netzwerkübergreifend hängt es von beiden Internetverbindungen ab, und Relayium weicht nur dann auf ein verschlüsseltes Relay aus, wenn keine direkte Verbindung möglich ist.",
      },
      {
        q: "Ist es sicher, Dateien so zu senden?",
        a: "Ja. Zusätzlich zur Transportverschlüsselung des Browsers legt Relayium eine eigene Schicht darüber: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, und dieser Schlüssel erreicht nie einen Server. Beide Geräte zeigen denselben sechsstelligen Code (SAS), sodass du bestätigen kannst, dass niemand dazwischensitzt, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf deinem Computer und deinem Handy und sende deine erste Datei drahtlos — kein Kabel, keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer des fichiers du PC au téléphone sans fil, sans câble ni appli",
  description:
    "Un guide pas à pas pour déplacer des fichiers entre un ordinateur et un téléphone par Wi-Fi — glisser-déposer, sans câble USB, sans compte cloud, et chiffré de bout en bout tout du long.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Faire passer un fichier de votre ordinateur portable à votre téléphone ne devrait pas obliger à chercher le bon câble, à s'envoyer un e-mail à soi-même, ou à téléverser vers un cloud pour le retélécharger ensuite. Relayium déplace les octets directement de votre ordinateur vers votre téléphone via votre propre Wi-Fi, dans le navigateur, sans rien à installer d'un côté ou de l'autre.",
    "Ce guide détaille la méthode sans fil pas à pas — même réseau ou réseaux différents — puis la compare honnêtement aux solutions habituelles (USB, Bluetooth, applis de messagerie et e-mail), pour que vous choisissiez le bon outil selon le cas.",
  ],
  sections: [
    {
      heading: "Envoyer du PC au téléphone sur le même Wi-Fi",
      body: [
        "C'est la voie la plus rapide : les deux appareils sont sur le même réseau, ils se connectent donc directement et le transfert n'est limité que par votre Wi-Fi. Vous n'avez besoin que d'un navigateur sur chaque appareil.",
      ],
      bullets: [
        "Sur l'ordinateur, ouvrez relayium.com dans n'importe quel navigateur moderne (Chrome, Edge, Firefox ou Safari).",
        "Sur le téléphone, ouvrez relayium.com aussi. Sur le même réseau, les deux appareils se découvrent automatiquement.",
        "Sur l'ordinateur, glissez les fichiers directement sur la page, ou cliquez pour les choisir — jusqu'à 1 000 fichiers par lot. Vous pouvez déposer un dossier entier et Relayium en conserve la structure.",
        "Choisissez le téléphone comme destination et lancez. Les deux appareils affichent le même code de vérification à 6 chiffres (SAS) ; un coup d'œil, confirmez qu'ils concordent, et les fichiers filent.",
        "Sur le téléphone, enregistrez les fichiers reçus. Aucun compte n'est nécessaire pour un transfert en temps réel comme celui-ci.",
      ],
    },
    {
      heading: "Pas sur le même réseau ? Utilisez un code d'appairage",
      body: [
        "Votre téléphone est en données mobiles et votre PC sur le Wi-Fi de la maison ? Aucun souci — Relayium est conçu pour atteindre à travers les réseaux, pas seulement le même.",
        "Au lieu de la découverte automatique, l'expéditeur se connecte et obtient un court code d'appairage (ou le lien de participation qu'il génère) — le destinataire n'a jamais besoin de compte. Saisissez le code sur l'autre appareil et les deux se connectent directement, en pair-à-pair, chaque fois que les réseaux le permettent. Quand une voie directe est impossible, le flux chiffré bascule vers un relais TURN — le relais ne voit que du texte chiffré, donc le transfert reste chiffré de bout en bout. Si la connexion se coupe en cours de route, le transfert peut reprendre au lieu de tout recommencer.",
      ],
    },
    {
      heading: "L'installer comme une appli (PWA facultative)",
      body: [
        "Relayium est un site web, il n'y a donc vraiment rien à installer. Mais si vous envoyez souvent des fichiers, vous pouvez l'ajouter à votre écran d'accueil ou à votre bureau en tant qu'application web progressive (PWA) : elle s'ouvre alors dans sa propre fenêtre et se lance comme une appli native, tout en restant, au fond, la même page web.",
        "Sur le téléphone, utilisez l'option « Ajouter à l'écran d'accueil » de votre navigateur ; sur l'ordinateur, l'icône d'installation dans la barre d'adresse. Cela reste gratuit dans tous les cas — Relayium est open source sous licence MIT sur github.com/relayium/relayium et fonctionne sous Windows, macOS, Linux, Android et iOS.",
      ],
    },
    {
      heading: "Gros fichiers : ce que votre navigateur peut gérer",
      body: [
        "Comme un transfert en temps réel ne stocke jamais vos fichiers sur un serveur, aucun quota de téléversement à surveiller. La limite pratique dépend du navigateur qui reçoit.",
        "Dans Chrome ou Edge, les données entrantes sont écrites en flux directement sur le disque, il n'y a donc en pratique aucune limite de taille — des vidéos de plusieurs gigaoctets passent sans souci. Firefox et Safari mettent le fichier en mémoire tampon, alors sur ceux-ci gardez un fichier unique sous environ 200 Mo. Si vous devez envoyer quelque chose de volumineux vers un iPhone sous Safari, recevoir sur un appareil sous Chrome contourne entièrement la limite.",
      ],
    },
    {
      heading: "Autres façons de transférer du PC au téléphone (et leurs limites)",
      body: [
        "Le sans-fil dans le navigateur n'est pas la seule option, et honnêtement, chaque solution a sa place. Voici comment les plus courantes se comparent :",
      ],
      bullets: [
        "Câble USB : fiable et rapide, mais il faut le bon câble, et l'accès aux fichiers du téléphone vers le PC peut être capricieux (surtout iPhone vers Windows). C'est filaire, pas sans fil.",
        "Bluetooth : vraiment sans câble, mais lent — envoyer quelques grandes photos peut prendre des minutes, et c'est impraticable pour des vidéos ou de gros lots.",
        "Applis de messagerie ou e-mail à soi-même (WhatsApp, Telegram, mail) : pratique si c'est déjà ouvert, mais la plupart imposent des limites de taille, peuvent recompresser les photos, et font transiter vos fichiers par un serveur tiers au lieu de les garder privés.",
        "Relayium : sans fil, sans installation, sans compte sur le même réseau (l'expéditeur se connecte seulement pour s'appairer entre réseaux différents), sans recompression (octet pour octet avec une vérification d'intégrité SHA-256 par fichier), et chiffré de bout en bout avec un code de vérification que vous pouvez contrôler vous-même.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Est-ce que ça marche avec Mac et Android, pas seulement Windows et iPhone ?",
        a: "Oui. Relayium tourne dans le navigateur sous Windows, macOS, Linux, Android et iOS, donc toute combinaison fonctionne — Windows vers Android, Mac vers iPhone, Linux vers un téléphone, et inversement. Il n'y a rien à installer sur aucun des appareils.",
      },
      {
        q: "À quelle vitesse se fait le transfert ?",
        a: "Sur le même Wi-Fi, les deux appareils se connectent directement, la vitesse est donc limitée par votre réseau local et non par un serveur — en général aussi rapide que votre Wi-Fi le permet. Entre réseaux différents, cela dépend des deux connexions internet, et Relayium ne bascule sur un relais chiffré que lorsqu'une liaison directe est impossible.",
      },
      {
        q: "Est-ce sûr d'envoyer des fichiers ainsi ?",
        a: "Oui. Par-dessus le chiffrement de transport du navigateur, Relayium ajoute sa propre couche : un échange de clés X25519 dérive une clé utilisée pour un AES-256-GCM par bloc, et cette clé n'atteint jamais un serveur. Les deux appareils affichent le même code à 6 chiffres (SAS) pour confirmer que personne ne s'intercale, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur votre ordinateur et votre téléphone et envoyez votre premier fichier sans fil — sans câble, sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال الملفات من الحاسوب إلى الهاتف لاسلكيًا، دون كابل أو تطبيق",
  description:
    "دليل خطوة بخطوة لنقل الملفات بين الحاسوب والهاتف عبر Wi-Fi — بالسحب والإفلات، دون كابل USB، دون حساب سحابي، ومع التشفير من الطرف إلى الطرف طوال الطريق.",
  updatedLabel: "آخر تحديث",
  lead: [
    "نقل ملف من حاسوبك المحمول إلى هاتفك لا ينبغي أن يعني البحث عن الكابل المناسب، أو إرسال بريد إلكتروني إلى نفسك، أو الرفع إلى قرص سحابي ثم تنزيله من جديد. ينقل Relayium البايتات مباشرةً من حاسوبك إلى هاتفك عبر شبكة Wi-Fi الخاصة بك، داخل المتصفح، دون أي شيء لتثبيته على أي من الجهازين.",
    "يشرح هذا الدليل الطريقة اللاسلكية خطوة بخطوة — على نفس الشبكة أو عبر الشبكات — ثم يقارنها بصدق مع البدائل المعتادة (USB، بلوتوث، تطبيقات المحادثة والبريد الإلكتروني) حتى تختار الأداة المناسبة للمهمة.",
  ],
  sections: [
    {
      heading: "الإرسال من الحاسوب إلى الهاتف على نفس شبكة Wi-Fi",
      body: [
        "هذا هو المسار الأسرع: كلا الجهازين على نفس الشبكة، فيتصلان مباشرةً ولا يحدّ النقل سوى شبكة Wi-Fi لديك. لا تحتاج إلى شيء سوى متصفح على كل جهاز.",
      ],
      bullets: [
        "على الحاسوب، افتح relayium.com في أي متصفح حديث (Chrome أو Edge أو Firefox أو Safari).",
        "على الهاتف، افتح relayium.com أيضًا. على نفس الشبكة، يكتشف الجهازان أحدهما الآخر تلقائيًا.",
        "على الحاسوب، اسحب الملفات مباشرةً إلى الصفحة، أو انقر لاختيارها — حتى 1,000 ملف لكل دفعة. يمكنك إفلات مجلد كامل ويحافظ Relayium على بنيته.",
        "اختر الهاتف وجهةً وابدأ. يعرض كلا الجهازين رمز التحقق نفسه المكوَّن من 6 أرقام (SAS)؛ ألقِ نظرة عليهما، وتأكّد من تطابقهما، وتطير الملفات إلى الجانب الآخر.",
        "على الهاتف، احفظ الملفات المستلمة. لا يلزم أي حساب لنقل فوري كهذا.",
      ],
    },
    {
      heading: "لست على نفس الشبكة؟ استخدم رمز اقتران",
      body: [
        "هاتفك على بيانات الجوال وحاسوبك على شبكة Wi-Fi المنزلية؟ لا بأس بذلك — بُني Relayium ليصل عبر الشبكات، لا على نفس الشبكة فقط.",
        "بدلًا من الاكتشاف التلقائي، يحصل المُرسِل على رمز اقتران قصير (أو رابط الانضمام الذي يولّده) ويسجّل الدخول لتوليده — أما المُستقبِل فلا يحتاج إلى حساب أبدًا. أدخِل الرمز على الجهاز الآخر فيتصل الجهازان مباشرةً، من الند للند، متى سمحت الشبكات بذلك. وعندما يتعذّر المسار المباشر، يعود التدفق المُشفَّر إلى مُرحِّل TURN — ولا يرى المُرحِّل سوى نص مُشفَّر، فيبقى النقل مشفَّرًا من الطرف إلى الطرف. وإذا انقطع الاتصال في منتصف الطريق، يمكن استئناف النقل بدلًا من البدء من جديد.",
      ],
    },
    {
      heading: "ثبّته كتطبيق (تطبيق ويب تقدُّمي PWA اختياري)",
      body: [
        "Relayium موقع ويب، فلا يوجد فعلًا ما يُثبَّت. لكن إن كنت تُرسِل الملفات كثيرًا، فيمكنك إضافته إلى شاشتك الرئيسية أو سطح مكتبك كتطبيق ويب تقدُّمي (PWA): عندها يُفتح في نافذته الخاصة ويُطلَق كتطبيق أصلي، بينما يبقى في جوهره مجرد صفحة الويب نفسها.",
        "على الهاتف، استخدم خيار \"إضافة إلى الشاشة الرئيسية\" في متصفحك؛ وعلى الحاسوب، استخدم أيقونة التثبيت في شريط العنوان. يبقى مجانيًا في كلتا الحالتين — Relayium مفتوح المصدر بموجب رخصة MIT على github.com/relayium/relayium، ويعمل على Windows وmacOS وLinux وAndroid وiOS.",
      ],
    },
    {
      heading: "الملفات الكبيرة: ما يستطيع متصفحك تحمّله",
      body: [
        "لأن النقل الفوري لا يودِع ملفاتك أبدًا على خادم، فلا حصة رفع تقلق بشأنها. الحد العملي هو أي متصفح يستقبل.",
        "في Chrome أو Edge، تُبَثّ البيانات الواردة مباشرةً إلى القرص، فلا يوجد فعليًا حد للحجم — مقاطع الفيديو بحجم عدة غيغابايت لا مشكلة فيها. أما Firefox وSafari فيخزّنان الملف مؤقتًا في الذاكرة بدلًا من ذلك، فعليهما أبقِ الملف الواحد دون نحو 200 MB. وإن احتجت إلى إرسال شيء كبير إلى iPhone يعتمد Safari، فإن الاستقبال على جهاز يعتمد Chrome يتجنّب الحد تمامًا.",
      ],
    },
    {
      heading: "طرق أخرى لنقل الملفات من الحاسوب إلى الهاتف (وحدودها)",
      body: [
        "اللاسلكي في المتصفح ليس الخيار الوحيد، والجواب الصادق أن لكل بديل موضعه. إليك كيف تُقارَن البدائل الشائعة:",
      ],
      bullets: [
        "كابل USB: موثوق وسريع، لكنك تحتاج إلى الكابل المناسب، وقد يكون الوصول إلى ملفات الهاتف من الحاسوب مُربكًا (خاصةً من iPhone إلى Windows). إنه سلكي، لا لاسلكي.",
        "بلوتوث: خالٍ من الكابل حقًا، لكنه بطيء — قد يستغرق إرسال بضع صور كبيرة دقائق، وهو غير عملي للفيديوهات أو الدفعات الكبيرة.",
        "تطبيقات المحادثة أو إرسال بريد إلكتروني إلى نفسك (WeChat، Telegram، البريد): مريحة إن كانت مفتوحة لديك أصلًا، لكن معظمها يفرض حدود حجم، وقد يُعيد ضغط الصور، ويمرّر ملفاتك عبر خادم طرف ثالث بدلًا من إبقائها خاصة.",
        "Relayium: لاسلكي، بدون تثبيت، بدون حساب على نفس الشبكة (يسجّل المُرسِل الدخول فقط للاقتران عبر الشبكات)، بدون إعادة ضغط (بايتًا ببايت مع فحص سلامة SHA-256 لكل ملف)، ومشفَّر من الطرف إلى الطرف مع رمز تحقق يمكنك التأكد منه بنفسك.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يعمل هذا مع Mac وAndroid، لا مع Windows وiPhone فقط؟",
        a: "نعم. يعمل Relayium في المتصفح على Windows وmacOS وLinux وAndroid وiOS، فأي مزيج يعمل — من Windows إلى Android، ومن Mac إلى iPhone، ومن Linux إلى هاتف، والعكس أيضًا. لا يوجد ما يُثبَّت على أي من الجهازين.",
      },
      {
        q: "ما مدى سرعة النقل؟",
        a: "على نفس شبكة Wi-Fi يتصل الجهازان مباشرةً، فتتحدد السرعة بشبكتك المحلية لا بأي خادم — عادةً بأقصى سرعة تسمح بها شبكة Wi-Fi لديك. أما عبر شبكات مختلفة فتعتمد على كلا اتصالَي الإنترنت، ولا يعود Relayium إلى مُرحِّل مُشفَّر إلا عندما يتعذّر الاتصال المباشر.",
      },
      {
        q: "هل من الآمن إرسال الملفات بهذه الطريقة؟",
        a: "نعم. فوق تشفير النقل الذي يوفّره المتصفح، يضيف Relayium طبقته الخاصة: يشتقّ تبادل مفاتيح X25519 مفتاحًا يُستخدَم لتشفير AES-256-GCM لكل جزء، وهذا المفتاح لا يلمس خادمًا أبدًا. يعرض كلا الجهازين الرمز نفسه المكوَّن من 6 أرقام (SAS) لتتأكّد من عدم وجود أحد في المنتصف، ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على حاسوبك وهاتفك وأرسِل أول ملف لك لاسلكيًا — دون كابل، دون تثبيت، ودون حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

export default {
  slug: "how-to/send-files-pc-to-phone-wirelessly",
  updated: "2026-07-03",
  langs: { en, zh, ja, ko, de, fr, ar },
};
