// web/scripts/pages/content/articles/howto-same-wifi.mjs
// How-to: send files between any devices on the same Wi-Fi / local network —
// the generic LAN-mode explainer (distinct from the PC-to-phone, Mac-Windows,
// and AirDrop-for-Windows/Android device-pair how-tos, which it cross-links to).
// English is the master; zh/ja/ko/de/fr follow the same structure with identical
// facts. Terminology mirrors src/lib/i18n and other articles in this folder.

const en = {
  title: "Send files between devices on the same Wi-Fi",
  description:
    "How to send files between any devices on the same Wi-Fi or local network — no account, no pairing code, just open relayium.com on both and transfer directly, end-to-end encrypted.",
  updatedLabel: "Last updated",
  lead: [
    "If two or more devices are on the same Wi-Fi or local network, sending a file between them should not require an account, a code, or a trip through the cloud. Relayium detects when devices share a network and lets them connect directly, in the browser, with nothing to sign up for.",
    "This guide covers the generic same-network case — any devices, any operating systems, even more than two at once. If you have a specific device pair in mind, see the dedicated guides for PC to phone, Mac to Windows, or an AirDrop-style flow for Windows/Linux/Android linked at the end.",
  ],
  sections: [
    {
      heading: "How same-network detection works",
      body: [
        "Relayium does not ask you to type anything to find nearby devices. When your browser opens relayium.com without a pairing code, the server places you in a room based on the network you are connecting from — in practice, devices that share the same public IP address (the same home, office, or campus Wi-Fi, or the same mobile hotspot) land in the same room automatically.",
        "That room is not capped at two participants: it holds however many devices open the site from that network, so a whole desk of laptops or a classroom of phones can all see each other at once, not just a single pair.",
      ],
    },
    {
      heading: "Step by step",
      body: [
        "The whole flow happens in the browser — no app to install on any device.",
      ],
      bullets: [
        "Connect every device you want to use to the same Wi-Fi or local network.",
        "On each device, open relayium.com in a modern browser (Chrome, Edge, Firefox or Safari).",
        "The devices on that network appear to each other automatically — no code, no login, no account on either side.",
        "Pick a file or a whole folder (up to 1,000 files per batch) and choose which device on the list should receive it.",
        "Both devices show the same short verification code (SAS). Glance at it on each screen, confirm it matches, and the transfer starts.",
        "Files move straight from one device to the other; save them when they land.",
      ],
    },
    {
      heading: "Why it is fast: no server in the middle",
      body: [
        "Because both devices are already on the same network, Relayium connects them peer-to-peer directly — the bytes travel from one device to the other over your local Wi-Fi and never make a round trip to a Relayium server. There is nothing to upload and nothing to wait on downloading; speed is bounded only by your local network, which is usually much faster than an internet connection in either direction.",
        "This is also why no account is involved on either side: with everyone already on the same trusted network, Relayium does not need sign-in to know who should be allowed to connect to whom.",
      ],
    },
    {
      heading: "Still end-to-end encrypted",
      body: [
        "Being on the same network does not mean the transfer is sent in the clear. Relayium negotiates an X25519 key exchange between the two devices and encrypts every chunk with AES-256-GCM; that key is never seen by any server, including Relayium's own signaling server, which only helps the devices find each other. The short verification code (SAS) both screens display lets you visually confirm the connection is genuinely between your two devices, and each file is checked end to end with a SHA-256 hash so you know it arrived byte-for-byte intact.",
      ],
    },
    {
      heading: "If a device is on a different network",
      body: [
        "Same-network mode only works when the devices actually share a network — a phone on mobile data, a laptop on a different Wi-Fi, or a device behind a different router will not show up automatically. For that case, Relayium also supports connecting across networks with a short pairing code: the sender signs in to generate the code (or a QR code / link), the receiver never needs an account, and the transfer still connects directly, peer-to-peer, whenever the networks allow it — falling back to an encrypted relay only when a direct path is not possible.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account to send files on the same Wi-Fi?",
        a: "No. Same-network transfers need no account and no pairing code on either side — just open relayium.com on each device.",
      },
      {
        q: "How does Relayium know which devices are on my network?",
        a: "Devices that connect from the same network typically share the same public IP address, and Relayium groups devices with a matching public IP into the same room automatically, with no code required.",
      },
      {
        q: "Can more than two devices see each other at once?",
        a: "Yes. Same-network rooms are not limited to a pair — every device that opens relayium.com from that network can appear and receive files, useful for sharing with several people in the same room or office.",
      },
      {
        q: "Is the transfer still encrypted if it never leaves my network?",
        a: "Yes. Every same-network transfer uses the same X25519 key exchange and AES-256-GCM encryption as a cross-network one, with a verification code you can check yourself and a SHA-256 integrity check per file.",
      },
      {
        q: "What if one device is on Wi-Fi and the other is on mobile data?",
        a: "They are not on the same network, so automatic discovery will not connect them. Use a pairing code instead — the sender signs in to create it, the receiver does not need an account, and the two devices still connect directly.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on any two (or more) devices on the same Wi-Fi and send your first file — no account, no code needed.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "同一 Wi-Fi 下的设备之间互传文件",
  description:
    "如何在同一 Wi-Fi 或局域网下的任意设备之间传文件——无需账号，无需配对码，两端都打开 relayium.com 即可直传，全程端到端加密。",
  updatedLabel: "最近更新",
  lead: [
    "如果两台或多台设备在同一个 Wi-Fi 或局域网里，它们之间传文件本不该需要账号、验证码，或绕道云端。Relayium 能识别设备是否处于同一网络，并让它们在浏览器里直接互连，什么都不用注册。",
    "本文讲的是通用的同网络场景——任意设备、任意操作系统，甚至可以同时超过两台。如果你心里想的是某个具体设备组合，可以看文末链接的专门指南：电脑传手机、Mac 传 Windows，或面向 Windows/Linux/Android 的 AirDrop 式方案。",
  ],
  sections: [
    {
      heading: "同网络是怎么被识别的",
      body: [
        "Relayium 不需要你输入任何东西来发现附近的设备。当你的浏览器不带配对码打开 relayium.com 时，服务器会根据你所连接的网络把你放进一个房间——实际上，共享同一个公网 IP 的设备（比如同一个家庭、办公室、校园 Wi-Fi，或同一个手机热点）会自动落入同一个房间。",
        "这个房间不限于两个人：从该网络打开网站的设备有多少，房间里就能容纳多少台，所以一整桌笔记本电脑，或一个教室的手机，都能同时互相看见，不只是一对一。",
      ],
    },
    {
      heading: "分步操作",
      body: [
        "整个流程都在浏览器里完成——任何设备都不用装 App。",
      ],
      bullets: [
        "把你要用到的每台设备都连接到同一个 Wi-Fi 或局域网。",
        "在每台设备上用现代浏览器（Chrome、Edge、Firefox 或 Safari）打开 relayium.com。",
        "同网络下的设备会自动互相出现——两端都无需验证码，无需登录，无需账号。",
        "选好文件或整个文件夹（每批最多 1,000 个文件），再从列表里选出要接收的那台设备。",
        "两台设备会显示同一段简短的校验码（SAS）。分别瞄一眼，确认一致，传输就开始了。",
        "文件直接从一台设备传到另一台；到达后保存即可。",
      ],
    },
    {
      heading: "为什么这么快：中间没有服务器",
      body: [
        "由于两台设备本来就在同一网络里，Relayium 会让它们直接点对点连接——字节在你本地 Wi-Fi 上从一台设备流向另一台，从不绕道 Relayium 的服务器往返。没有什么要上传，也没有什么要等下载；速度只受你本地网络的限制，通常比任何方向的公网连接快得多。",
        "这也是为什么两端都不需要账号：既然大家已经在同一个可信网络里，Relayium 不需要靠登录来判断谁能连谁。",
      ],
    },
    {
      heading: "依然是端到端加密",
      body: [
        "在同一网络下不代表传输就是明文的。Relayium 会在两台设备之间协商 X25519 密钥交换，并用 AES-256-GCM 对每个数据块加密；这把密钥不会被任何服务器看到，包括 Relayium 自己的信令服务器——它只负责帮设备找到彼此。两块屏幕显示的同一段简短校验码（SAS）能让你亲眼确认这条连接确实建立在你的两台设备之间，而每个文件还会用 SHA-256 做端到端校验，让你确信它是逐字节完整到达的。",
      ],
    },
    {
      heading: "如果某台设备在别的网络上",
      body: [
        "同网络模式只在设备真正共享同一网络时才生效——用移动数据的手机、连着另一个 Wi-Fi 的笔记本，或在另一台路由器后面的设备，都不会自动出现。这种情况下，Relayium 也支持用一个短配对码跨网络连接：发送方登录后生成配对码（或二维码/链接），接收方始终无需账号，只要网络条件允许，传输依然是点对点直连——只有在无法直连时才会退回到加密中继。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "在同一 Wi-Fi 下传文件需要账号吗？",
        a: "不需要。同网络传输两端都无需账号，也无需配对码——每台设备打开 relayium.com 就行。",
      },
      {
        q: "Relayium 怎么知道哪些设备在我的网络里？",
        a: "同网络下的设备通常共享同一个公网 IP，Relayium 会自动把公网 IP 相同的设备归到同一个房间里，无需任何验证码。",
      },
      {
        q: "能不能同时有两台以上的设备互相看见？",
        a: "可以。同网络房间不限于一对一——从该网络打开 relayium.com 的每台设备都能出现并接收文件，适合同一个房间或办公室里给多个人分享。",
      },
      {
        q: "如果传输从未离开我的网络，还是加密的吗？",
        a: "是的。每一次同网络传输都使用和跨网络传输一样的 X25519 密钥交换与 AES-256-GCM 加密，有你能亲自核对的校验码，还有逐文件的 SHA-256 完整性校验。",
      },
      {
        q: "如果一台设备用 Wi-Fi，另一台用移动数据怎么办？",
        a: "那它们就不在同一网络，自动发现连不上。改用配对码：发送方登录后创建配对码，接收方无需账号，两台设备依然可以直接连接。",
      },
    ],
  },
  cta: {
    text: "在同一 Wi-Fi 下的任意两台（或更多）设备上打开 Relayium，发出你的第一个文件——无需账号，无需验证码。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "同じ Wi-Fi 上の端末間でファイルを送る",
  description:
    "同じ Wi-Fi やローカルネットワーク上のどの端末同士でもファイルを送る方法。アカウント不要、ペアリングコード不要、両方で relayium.com を開くだけで直接転送、エンドツーエンド暗号化。",
  updatedLabel: "最終更新",
  lead: [
    "2台以上の端末が同じ Wi-Fi やローカルネットワークにあるなら、その間でファイルを送るのにアカウントもコードもクラウド経由も要らないはずです。Relayium は端末が同じネットワークを共有しているかを検出し、ブラウザの中で直接つなぎます。登録するものは何もありません。",
    "本ガイドは汎用的な同一ネットワークのケースを扱います——どんな端末・OS でも、同時に2台以上でも構いません。特定の端末の組み合わせを想定しているなら、末尾にリンクした PC からスマホへ、Mac から Windows へ、あるいは Windows/Linux/Android 向けの AirDrop 的な手順の専用ガイドを参照してください。",
  ],
  sections: [
    {
      heading: "同一ネットワークの検出の仕組み",
      body: [
        "Relayium は近くの端末を見つけるのに何かを入力させることはありません。ペアリングコードなしでブラウザが relayium.com を開くと、サーバーは接続元のネットワークをもとにあなたを部屋へ割り当てます——実際には、同じグローバル IP アドレスを共有する端末（同じ自宅・オフィス・キャンパスの Wi-Fi、同じモバイルホットスポットなど）が自動的に同じ部屋に入ります。",
        "その部屋は2人までに限られません。そのネットワークから relayium.com を開いた端末はいくつでも入れるので、机を並べたノートPCの一群や教室のスマホ全員が、1対1に限らず一度に互いを見つけられます。",
      ],
    },
    {
      heading: "手順",
      body: [
        "すべてブラウザの中で完結します——どの端末にもインストールするものはありません。",
      ],
      bullets: [
        "使いたいすべての端末を同じ Wi-Fi またはローカルネットワークに接続します。",
        "各端末で最新のブラウザ（Chrome、Edge、Firefox、Safari）で relayium.com を開きます。",
        "そのネットワーク上の端末は自動的に互いに表示されます——両側ともコードもログインもアカウントも不要です。",
        "ファイルまたはフォルダ全体（1バッチ最大1,000ファイル）を選び、一覧から受信させたい端末を選びます。",
        "両方の端末が同じ短い検証コード（SAS）を表示します。それぞれの画面でちらっと見て一致を確認すれば、転送が始まります。",
        "ファイルは1台からもう1台へ直接移動します。届いたら保存してください。",
      ],
    },
    {
      heading: "なぜ速いのか：間にサーバーが挟まらない",
      body: [
        "両方の端末がすでに同じネットワークにあるため、Relayium はそれらを P2P で直接つなぎます——バイトはローカル Wi-Fi 上を1台からもう1台へ流れ、Relayium のサーバーへ往復することは決してありません。アップロードするものも、ダウンロードを待つものもなく、速度はローカルネットワークだけに左右されます。これは通常、どちら向きのインターネット接続よりもずっと速いものです。",
        "これがどちら側にもアカウントが要らない理由でもあります。全員がすでに同じ信頼できるネットワーク上にいるので、誰が誰につないでよいかを知るのにサインインは必要ありません。",
      ],
    },
    {
      heading: "それでもエンドツーエンド暗号化",
      body: [
        "同じネットワーク上にあるからといって、転送が平文で送られるわけではありません。Relayium は2台の端末間で X25519 鍵交換を行い、すべてのチャンクを AES-256-GCM で暗号化します。その鍵は、端末同士が互いを見つける手助けをするだけの Relayium 自身のシグナリングサーバーを含め、いかなるサーバーにも見えません。両方の画面が表示する短い検証コード（SAS）で、接続が本当にあなたの2台の端末間であることを目視で確認でき、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるので、バイト単位で無事に届いたことがわかります。",
      ],
    },
    {
      heading: "端末が別のネットワークにある場合",
      body: [
        "同一ネットワークモードは端末が実際にネットワークを共有しているときだけ働きます——モバイル通信のスマホ、別の Wi-Fi のノートPC、別のルーターの背後にある端末は自動的には現れません。その場合、Relayium は短いペアリングコードでネットワークをまたいで接続することもサポートしています。送信側がサインインしてコード（または QR コード／リンク）を生成し、受信側はアカウント不要で、ネットワークが許す限り転送は直接 P2P でつながります。直接の経路が不可能なときだけ暗号化リレーにフォールバックします。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "同じ Wi-Fi でファイルを送るのにアカウントは必要ですか？",
        a: "いいえ。同一ネットワークでの転送はどちら側にもアカウントもペアリングコードも不要です——各端末で relayium.com を開くだけです。",
      },
      {
        q: "Relayium はどの端末が自分のネットワークにあると分かるのですか？",
        a: "同一ネットワーク上の端末は通常同じグローバル IP アドレスを共有しており、Relayium はグローバル IP が一致する端末を自動的に同じ部屋にまとめます。コードは不要です。",
      },
      {
        q: "3台以上の端末が同時に互いを見られますか？",
        a: "はい。同一ネットワークの部屋は2台に限られません。そのネットワークから relayium.com を開いた端末はすべて表示されファイルを受け取れるので、同じ部屋やオフィスの複数人と共有するのに便利です。",
      },
      {
        q: "ネットワークの外に出ない転送でも暗号化されていますか？",
        a: "はい。同一ネットワークの転送もネットワークをまたぐ転送と同じ X25519 鍵交換と AES-256-GCM 暗号化を使い、自分で確認できる検証コードと、ファイルごとの SHA-256 整合性チェックがあります。",
      },
      {
        q: "片方が Wi-Fi、もう片方がモバイル通信の場合は？",
        a: "それは同じネットワークではないので、自動発見ではつながりません。代わりにペアリングコードを使ってください。送信側がサインインしてコードを作成し、受信側はアカウント不要で、2台は依然として直接つながります。",
      },
    ],
  },
  cta: {
    text: "同じ Wi-Fi 上の任意の2台（またはそれ以上）で Relayium を開き、最初のファイルを送ってみてください——アカウントもコードも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "같은 Wi-Fi에 있는 기기끼리 파일 보내기",
  description:
    "같은 Wi-Fi나 로컬 네트워크에 있는 어떤 기기끼리도 파일을 보내는 방법 — 계정도, 페어링 코드도 필요 없이 양쪽에서 relayium.com만 열면 직접 전송되며 종단간 암호화됩니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "두 대 이상의 기기가 같은 Wi-Fi나 로컬 네트워크에 있다면, 그 사이에 파일을 보내는 데 계정도, 코드도, 클라우드를 거칠 필요도 없어야 합니다. Relayium은 기기들이 같은 네트워크를 공유하는지 감지해 브라우저 안에서 곧바로 연결해 줍니다. 가입할 것도 없습니다.",
    "이 가이드는 일반적인 같은 네트워크 상황을 다룹니다 — 어떤 기기든, 어떤 운영체제든, 심지어 동시에 두 대 이상이어도 됩니다. 특정 기기 조합을 염두에 두고 있다면 끝에 링크된 PC에서 폰으로, Mac에서 Windows로, 또는 Windows/Linux/Android용 AirDrop 방식 전용 가이드를 참고하세요.",
  ],
  sections: [
    {
      heading: "같은 네트워크 감지는 어떻게 되나",
      body: [
        "Relayium은 근처 기기를 찾기 위해 무언가를 입력하라고 하지 않습니다. 브라우저가 페어링 코드 없이 relayium.com을 열면 서버는 접속한 네트워크를 기준으로 방에 배치합니다 — 실제로는 같은 공인 IP 주소를 공유하는 기기들(같은 집, 사무실, 캠퍼스 Wi-Fi, 또는 같은 모바일 핫스팟)이 자동으로 같은 방에 들어갑니다.",
        "그 방은 두 명으로 제한되지 않습니다. 그 네트워크에서 사이트를 연 기기가 몇 대든 방에 들어갈 수 있어서, 책상 가득한 노트북들이나 교실의 휴대폰들이 한 쌍뿐 아니라 한꺼번에 서로를 볼 수 있습니다.",
      ],
    },
    {
      heading: "단계별 안내",
      body: [
        "전 과정이 브라우저 안에서 이루어집니다 — 어느 기기에도 설치할 앱이 없습니다.",
      ],
      bullets: [
        "사용하려는 모든 기기를 같은 Wi-Fi 또는 로컬 네트워크에 연결합니다.",
        "각 기기에서 최신 브라우저(Chrome, Edge, Firefox 또는 Safari)로 relayium.com을 엽니다.",
        "그 네트워크에 있는 기기들이 자동으로 서로에게 나타납니다 — 양쪽 다 코드도, 로그인도, 계정도 필요 없습니다.",
        "파일이나 폴더 전체(배치당 최대 1,000개)를 고르고, 목록에서 받을 기기를 선택합니다.",
        "두 기기가 동일한 짧은 검증 코드(SAS)를 표시합니다. 각 화면에서 힐끗 보고 일치하는지 확인하면 전송이 시작됩니다.",
        "파일이 한 기기에서 다른 기기로 곧장 이동합니다. 도착하면 저장하세요.",
      ],
    },
    {
      heading: "왜 빠른가: 중간에 서버가 없다",
      body: [
        "두 기기가 이미 같은 네트워크에 있으므로 Relayium은 이들을 P2P로 직접 연결합니다 — 바이트가 로컬 Wi-Fi를 통해 한 기기에서 다른 기기로 이동하며, Relayium 서버를 왕복하는 일이 전혀 없습니다. 업로드할 것도, 다운로드를 기다릴 것도 없어서 속도는 오직 로컬 네트워크에만 좌우되며, 보통 어느 방향의 인터넷 연결보다 훨씬 빠릅니다.",
        "이것이 양쪽 다 계정이 필요 없는 이유이기도 합니다. 모두가 이미 같은 신뢰할 수 있는 네트워크에 있으니, 누가 누구에게 연결해도 되는지 알기 위해 로그인이 필요하지 않습니다.",
      ],
    },
    {
      heading: "그래도 종단간 암호화",
      body: [
        "같은 네트워크에 있다고 해서 전송이 평문으로 이루어지는 것은 아닙니다. Relayium은 두 기기 사이에서 X25519 키 교환을 협상하고 모든 청크를 AES-256-GCM으로 암호화합니다. 그 키는 기기들이 서로를 찾도록 돕기만 하는 Relayium 자체 시그널링 서버를 포함해 어떤 서버에도 보이지 않습니다. 두 화면이 표시하는 동일한 짧은 검증 코드(SAS)로 연결이 정말로 당신의 두 기기 사이에서 이루어졌는지 눈으로 확인할 수 있고, 각 파일은 SHA-256 해시로 종단간 검증되어 바이트 단위로 온전히 도착했음을 알 수 있습니다.",
      ],
    },
    {
      heading: "기기가 다른 네트워크에 있다면",
      body: [
        "같은 네트워크 모드는 기기들이 실제로 네트워크를 공유할 때만 작동합니다 — 모바일 데이터를 쓰는 휴대폰, 다른 Wi-Fi에 있는 노트북, 다른 공유기 뒤에 있는 기기는 자동으로 나타나지 않습니다. 이런 경우 Relayium은 짧은 페어링 코드로 네트워크를 넘나드는 연결도 지원합니다. 보내는 쪽이 로그인해 코드(또는 QR 코드/링크)를 생성하고, 받는 쪽은 계정이 필요 없으며, 네트워크가 허락하는 한 전송은 여전히 P2P로 직접 연결됩니다 — 직접 경로가 불가능할 때만 암호화된 릴레이로 폴백합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "같은 Wi-Fi에서 파일을 보내려면 계정이 필요한가요?",
        a: "아니요. 같은 네트워크에서의 전송은 양쪽 다 계정도, 페어링 코드도 필요 없습니다 — 각 기기에서 relayium.com만 열면 됩니다.",
      },
      {
        q: "Relayium은 어떤 기기가 내 네트워크에 있는지 어떻게 아나요?",
        a: "같은 네트워크에 있는 기기들은 보통 같은 공인 IP 주소를 공유하며, Relayium은 공인 IP가 일치하는 기기들을 자동으로 같은 방에 묶습니다. 코드는 필요 없습니다.",
      },
      {
        q: "두 대보다 많은 기기가 동시에 서로를 볼 수 있나요?",
        a: "네. 같은 네트워크 방은 한 쌍으로 제한되지 않습니다. 그 네트워크에서 relayium.com을 연 모든 기기가 나타나 파일을 받을 수 있어서, 같은 방이나 사무실의 여러 사람과 공유할 때 유용합니다.",
      },
      {
        q: "전송이 내 네트워크를 벗어나지 않아도 여전히 암호화되나요?",
        a: "네. 같은 네트워크 전송도 네트워크를 넘는 전송과 동일한 X25519 키 교환과 AES-256-GCM 암호화를 사용하며, 직접 확인할 수 있는 검증 코드와 파일별 SHA-256 무결성 검사가 있습니다.",
      },
      {
        q: "한쪽은 Wi-Fi, 다른 쪽은 모바일 데이터라면 어떻게 하나요?",
        a: "그러면 같은 네트워크가 아니므로 자동 탐색으로는 연결되지 않습니다. 대신 페어링 코드를 사용하세요 — 보내는 쪽이 로그인해 코드를 만들고, 받는 쪽은 계정이 필요 없으며, 두 기기는 여전히 직접 연결됩니다.",
      },
    ],
  },
  cta: {
    text: "같은 Wi-Fi에 있는 아무 두 대(또는 그 이상)의 기기에서 Relayium을 열고 첫 파일을 보내 보세요 — 계정도 코드도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien zwischen Geräten im selben WLAN senden",
  description:
    "So sendest du Dateien zwischen beliebigen Geräten im selben WLAN oder lokalen Netz — kein Konto, kein Pairing-Code, einfach relayium.com auf beiden öffnen und direkt übertragen, Ende-zu-Ende-verschlüsselt.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Wenn zwei oder mehr Geräte im selben WLAN oder lokalen Netz sind, sollte eine Dateiübertragung zwischen ihnen kein Konto, keinen Code und keinen Umweg über die Cloud erfordern. Relayium erkennt, wenn Geräte sich ein Netzwerk teilen, und lässt sie direkt im Browser verbinden, ohne dass irgendwo eine Anmeldung nötig ist.",
    "Diese Anleitung behandelt den allgemeinen Fall im selben Netz — beliebige Geräte, beliebige Betriebssysteme, sogar mehr als zwei gleichzeitig. Wenn du ein bestimmtes Gerätepaar im Sinn hast, findest du am Ende Links zu den eigenen Anleitungen für PC zu Handy, Mac zu Windows oder einen AirDrop-ähnlichen Ablauf für Windows/Linux/Android.",
  ],
  sections: [
    {
      heading: "Wie die Erkennung im selben Netz funktioniert",
      body: [
        "Relayium verlangt keine Eingabe, um Geräte in der Nähe zu finden. Öffnet dein Browser relayium.com ohne Pairing-Code, weist dich der Server anhand des Netzwerks, über das du verbunden bist, einem Raum zu — in der Praxis landen Geräte, die dieselbe öffentliche IP-Adresse teilen (dasselbe WLAN zu Hause, im Büro, auf dem Campus, oder derselbe mobile Hotspot), automatisch im selben Raum.",
        "Dieser Raum ist nicht auf zwei Teilnehmer begrenzt: Er fasst so viele Geräte, wie von diesem Netzwerk aus die Seite öffnen, sodass ein ganzer Schreibtisch voller Laptops oder ein Klassenzimmer voller Handys sich alle gleichzeitig sehen können, nicht nur ein einzelnes Paar.",
      ],
    },
    {
      heading: "Schritt für Schritt",
      body: [
        "Der gesamte Ablauf findet im Browser statt — auf keinem Gerät ist etwas zu installieren.",
      ],
      bullets: [
        "Verbinde jedes Gerät, das du nutzen möchtest, mit demselben WLAN oder lokalen Netz.",
        "Öffne auf jedem Gerät relayium.com in einem modernen Browser (Chrome, Edge, Firefox oder Safari).",
        "Die Geräte in diesem Netz erscheinen einander automatisch — kein Code, kein Login, kein Konto auf beiden Seiten.",
        "Wähle eine Datei oder einen ganzen Ordner (bis zu 1.000 Dateien pro Stapel) und bestimme, welches Gerät aus der Liste sie empfangen soll.",
        "Beide Geräte zeigen denselben kurzen Prüfcode (SAS). Ein Blick auf jeden Bildschirm, bestätige die Übereinstimmung, und die Übertragung beginnt.",
        "Dateien wandern direkt von einem Gerät zum anderen; speichere sie, sobald sie ankommen.",
      ],
    },
    {
      heading: "Warum es schnell ist: kein Server dazwischen",
      body: [
        "Da beide Geräte bereits im selben Netz sind, verbindet Relayium sie direkt Peer-to-Peer — die Bytes wandern über dein lokales WLAN von einem Gerät zum anderen und machen nie den Umweg zu einem Relayium-Server. Es gibt nichts hochzuladen und nichts herunterzuladen, worauf man warten müsste; die Geschwindigkeit ist nur durch dein lokales Netz begrenzt, das meist deutlich schneller ist als eine Internetverbindung in beide Richtungen.",
        "Das ist auch der Grund, warum auf keiner Seite ein Konto beteiligt ist: Da alle bereits im selben vertrauenswürdigen Netz sind, braucht Relayium keine Anmeldung, um zu wissen, wer sich mit wem verbinden darf.",
      ],
    },
    {
      heading: "Trotzdem Ende-zu-Ende-verschlüsselt",
      body: [
        "Im selben Netz zu sein bedeutet nicht, dass die Übertragung im Klartext erfolgt. Relayium handelt zwischen den beiden Geräten einen X25519-Schlüsselaustausch aus und verschlüsselt jeden Chunk mit AES-256-GCM; diesen Schlüssel bekommt kein Server zu sehen, auch nicht Relayiums eigener Signaling-Server, der den Geräten nur hilft, einander zu finden. Der kurze Prüfcode (SAS), den beide Bildschirme anzeigen, lässt dich visuell bestätigen, dass die Verbindung wirklich zwischen deinen beiden Geräten besteht, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, damit du weißt, dass sie byte-genau angekommen ist.",
      ],
    },
    {
      heading: "Wenn ein Gerät in einem anderen Netz ist",
      body: [
        "Der Modus für dasselbe Netz funktioniert nur, wenn die Geräte tatsächlich ein Netzwerk teilen — ein Handy im Mobilfunknetz, ein Laptop in einem anderen WLAN oder ein Gerät hinter einem anderen Router erscheint nicht automatisch. Für diesen Fall unterstützt Relayium auch die Verbindung über Netzwerke hinweg mit einem kurzen Pairing-Code: Der Absender meldet sich an, um den Code (oder einen QR-Code / Link) zu erzeugen, der Empfänger braucht dabei nie ein Konto, und die Übertragung verbindet sich weiterhin direkt Peer-to-Peer, sofern die Netzwerke es zulassen — nur wenn kein direkter Weg möglich ist, weicht sie auf ein verschlüsseltes Relay aus.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Brauche ich ein Konto, um Dateien im selben WLAN zu senden?",
        a: "Nein. Übertragungen im selben Netz brauchen auf keiner Seite ein Konto oder einen Pairing-Code — öffne einfach relayium.com auf jedem Gerät.",
      },
      {
        q: "Woher weiß Relayium, welche Geräte in meinem Netzwerk sind?",
        a: "Geräte, die sich mit demselben Netzwerk verbinden, teilen sich in der Regel dieselbe öffentliche IP-Adresse, und Relayium gruppiert Geräte mit übereinstimmender öffentlicher IP automatisch in denselben Raum, ganz ohne Code.",
      },
      {
        q: "Können mehr als zwei Geräte einander gleichzeitig sehen?",
        a: "Ja. Räume im selben Netz sind nicht auf ein Paar begrenzt: Jedes Gerät, das relayium.com aus diesem Netz öffnet, kann erscheinen und Dateien empfangen — nützlich, um mit mehreren Personen im selben Raum oder Büro zu teilen.",
      },
      {
        q: "Ist die Übertragung immer noch verschlüsselt, wenn sie mein Netz nie verlässt?",
        a: "Ja. Jede Übertragung im selben Netz nutzt denselben X25519-Schlüsselaustausch und dieselbe AES-256-GCM-Verschlüsselung wie eine netzübergreifende, mit einem Prüfcode, den du selbst kontrollieren kannst, und einer SHA-256-Integritätsprüfung pro Datei.",
      },
      {
        q: "Was, wenn ein Gerät im WLAN und das andere im Mobilfunknetz ist?",
        a: "Dann sind sie nicht im selben Netz, und die automatische Erkennung verbindet sie nicht. Nutze stattdessen einen Pairing-Code — der Absender meldet sich an, um ihn zu erstellen, der Empfänger braucht kein Konto, und die beiden Geräte verbinden sich weiterhin direkt.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf zwei (oder mehr) beliebigen Geräten im selben WLAN und sende deine erste Datei — kein Konto, kein Code nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer des fichiers entre appareils sur le même Wi-Fi",
  description:
    "Comment envoyer des fichiers entre n'importe quels appareils sur le même Wi-Fi ou réseau local — sans compte, sans code d'appairage, ouvrez simplement relayium.com sur les deux et transférez directement, chiffré de bout en bout.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Si deux appareils ou plus sont sur le même Wi-Fi ou réseau local, envoyer un fichier entre eux ne devrait exiger ni compte, ni code, ni détour par le cloud. Relayium détecte quand des appareils partagent un réseau et les laisse se connecter directement, dans le navigateur, sans rien à créer nulle part.",
    "Ce guide couvre le cas générique du même réseau — n'importe quels appareils, n'importe quels systèmes d'exploitation, même plus de deux à la fois. Si vous avez en tête une paire d'appareils précise, consultez les guides dédiés pour PC vers téléphone, Mac vers Windows, ou un flux façon AirDrop pour Windows/Linux/Android, liés à la fin.",
  ],
  sections: [
    {
      heading: "Comment fonctionne la détection du même réseau",
      body: [
        "Relayium ne vous demande rien à saisir pour trouver les appareils à proximité. Quand votre navigateur ouvre relayium.com sans code d'appairage, le serveur vous place dans une salle basée sur le réseau depuis lequel vous vous connectez — en pratique, les appareils qui partagent la même adresse IP publique (le même Wi-Fi à la maison, au bureau, sur un campus, ou le même point d'accès mobile) atterrissent automatiquement dans la même salle.",
        "Cette salle n'est pas limitée à deux participants : elle contient autant d'appareils qu'il y en a à ouvrir le site depuis ce réseau, si bien qu'un bureau entier d'ordinateurs portables ou une salle de classe de téléphones peuvent tous se voir en même temps, pas seulement une paire.",
      ],
    },
    {
      heading: "Étape par étape",
      body: [
        "Tout le flux se déroule dans le navigateur — rien à installer sur aucun appareil.",
      ],
      bullets: [
        "Connectez chaque appareil que vous voulez utiliser au même Wi-Fi ou réseau local.",
        "Sur chaque appareil, ouvrez relayium.com dans un navigateur moderne (Chrome, Edge, Firefox ou Safari).",
        "Les appareils de ce réseau apparaissent automatiquement les uns aux autres — aucun code, aucune connexion, aucun compte d'aucun côté.",
        "Choisissez un fichier ou un dossier entier (jusqu'à 1 000 fichiers par lot) et sélectionnez, dans la liste, l'appareil qui doit le recevoir.",
        "Les deux appareils affichent le même code de vérification court (SAS). Un coup d'œil sur chaque écran, confirmez qu'ils concordent, et le transfert démarre.",
        "Les fichiers passent directement d'un appareil à l'autre ; enregistrez-les une fois arrivés.",
      ],
    },
    {
      heading: "Pourquoi c'est rapide : aucun serveur au milieu",
      body: [
        "Comme les deux appareils sont déjà sur le même réseau, Relayium les connecte directement en pair-à-pair — les octets voyagent sur votre Wi-Fi local d'un appareil à l'autre et ne font jamais l'aller-retour par un serveur Relayium. Rien à téléverser, rien à attendre en téléchargement ; la vitesse n'est limitée que par votre réseau local, généralement bien plus rapide qu'une connexion internet dans un sens ou dans l'autre.",
        "C'est aussi pourquoi aucun compte n'intervient d'aucun côté : tout le monde étant déjà sur le même réseau de confiance, Relayium n'a pas besoin d'une connexion pour savoir qui peut se connecter à qui.",
      ],
    },
    {
      heading: "Toujours chiffré de bout en bout",
      body: [
        "Être sur le même réseau ne veut pas dire que le transfert circule en clair. Relayium négocie un échange de clés X25519 entre les deux appareils et chiffre chaque bloc avec AES-256-GCM ; cette clé n'est jamais vue par aucun serveur, y compris le propre serveur de signalisation de Relayium, qui aide seulement les appareils à se trouver. Le code de vérification court (SAS) affiché sur les deux écrans vous permet de confirmer visuellement que la connexion est bien entre vos deux appareils, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256, pour savoir qu'il est arrivé intact, octet pour octet.",
      ],
    },
    {
      heading: "Si un appareil est sur un réseau différent",
      body: [
        "Le mode même réseau ne fonctionne que quand les appareils partagent réellement un réseau — un téléphone en données mobiles, un ordinateur portable sur un autre Wi-Fi, ou un appareil derrière un autre routeur n'apparaîtra pas automatiquement. Dans ce cas, Relayium prend aussi en charge la connexion entre réseaux différents avec un court code d'appairage : l'expéditeur se connecte pour générer le code (ou un QR code / lien), le destinataire n'a jamais besoin de compte, et le transfert se connecte toujours directement, en pair-à-pair, chaque fois que les réseaux le permettent — ne basculant vers un relais chiffré que lorsqu'une voie directe est impossible.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Ai-je besoin d'un compte pour envoyer des fichiers sur le même Wi-Fi ?",
        a: "Non. Les transferts sur le même réseau ne nécessitent ni compte ni code d'appairage d'aucun côté — ouvrez simplement relayium.com sur chaque appareil.",
      },
      {
        q: "Comment Relayium sait-il quels appareils sont sur mon réseau ?",
        a: "Les appareils connectés au même réseau partagent généralement la même adresse IP publique, et Relayium regroupe automatiquement les appareils dont l'IP publique correspond dans la même salle, sans code requis.",
      },
      {
        q: "Plus de deux appareils peuvent-ils se voir en même temps ?",
        a: "Oui. Les salles du même réseau ne sont pas limitées à une paire : tout appareil qui ouvre relayium.com depuis ce réseau peut apparaître et recevoir des fichiers, pratique pour partager avec plusieurs personnes dans la même pièce ou le même bureau.",
      },
      {
        q: "Le transfert est-il quand même chiffré s'il ne quitte jamais mon réseau ?",
        a: "Oui. Chaque transfert sur le même réseau utilise le même échange de clés X25519 et le même chiffrement AES-256-GCM qu'un transfert entre réseaux différents, avec un code de vérification que vous pouvez contrôler vous-même et une vérification d'intégrité SHA-256 par fichier.",
      },
      {
        q: "Et si un appareil est en Wi-Fi et l'autre en données mobiles ?",
        a: "Ils ne sont alors pas sur le même réseau, et la découverte automatique ne les connectera pas. Utilisez plutôt un code d'appairage — l'expéditeur se connecte pour le créer, le destinataire n'a pas besoin de compte, et les deux appareils se connectent quand même directement.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur deux appareils (ou plus) sur le même Wi-Fi et envoyez votre premier fichier — sans compte, sans code nécessaire.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال الملفات بين الأجهزة على نفس شبكة Wi-Fi",
  description:
    "كيفية إرسال الملفات بين أي أجهزة على نفس شبكة Wi-Fi أو الشبكة المحلية — دون حساب، دون رمز اقتران، فقط افتح relayium.com على كليهما وانقُل مباشرةً، مشفَّرًا من الطرف إلى الطرف.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إذا كان جهازان أو أكثر على نفس شبكة Wi-Fi أو الشبكة المحلية، فإن إرسال ملف بينها لا ينبغي أن يتطلب حسابًا، أو رمزًا، أو مرورًا عبر السحابة. يكتشف Relayium متى تتشارك الأجهزة شبكةً ويتيح لها الاتصال مباشرةً، داخل المتصفح، دون أي تسجيل.",
    "يغطّي هذا الدليل الحالة العامة لنفس الشبكة — أي أجهزة، وأي أنظمة تشغيل، بل وأكثر من جهازين في آنٍ واحد. وإن كان لديك زوج أجهزة محدد في ذهنك، فراجع الأدلة المخصصة للحاسوب إلى الهاتف، أو Mac إلى Windows، أو تدفّق بأسلوب AirDrop لـ Windows/Linux/Android، المرتبطة في النهاية.",
  ],
  sections: [
    {
      heading: "كيف يعمل اكتشاف نفس الشبكة",
      body: [
        "لا يطلب منك Relayium كتابة أي شيء للعثور على الأجهزة القريبة. عندما يفتح متصفحك relayium.com دون رمز اقتران، يضعك الخادم في غرفة بناءً على الشبكة التي تتصل منها — عمليًا، تدخل الأجهزة التي تتشارك نفس عنوان IP العام (نفس شبكة Wi-Fi في المنزل أو المكتب أو الحرم الجامعي، أو نفس نقطة اتصال الجوال) في نفس الغرفة تلقائيًا.",
        "هذه الغرفة ليست محدودة بمشاركَين اثنين: فهي تسع مهما بلغ عدد الأجهزة التي تفتح الموقع من تلك الشبكة، حتى يستطيع مكتب كامل من الحواسيب المحمولة أو صف دراسي من الهواتف رؤية بعضها في آنٍ واحد، لا مجرد زوج واحد.",
      ],
    },
    {
      heading: "خطوة بخطوة",
      body: [
        "يجري التدفّق كله في المتصفح — لا تطبيق لتثبيته على أي جهاز.",
      ],
      bullets: [
        "اربط كل جهاز تريد استخدامه بنفس شبكة Wi-Fi أو الشبكة المحلية.",
        "على كل جهاز، افتح relayium.com في متصفح حديث (Chrome أو Edge أو Firefox أو Safari).",
        "تظهر الأجهزة الموجودة على تلك الشبكة لبعضها تلقائيًا — لا رمز، لا تسجيل دخول، لا حساب على أي من الجانبين.",
        "اختر ملفًا أو مجلدًا كاملًا (حتى 1,000 ملف لكل دفعة) وحدّد أي جهاز في القائمة ينبغي أن يستقبله.",
        "يعرض كلا الجهازين رمز التحقق القصير نفسه (SAS). ألقِ نظرة عليه على كل شاشة، وتأكّد من تطابقه، فيبدأ النقل.",
        "تنتقل الملفات مباشرةً من جهاز إلى آخر؛ احفظها عند وصولها.",
      ],
    },
    {
      heading: "لماذا هو سريع: لا خادم في المنتصف",
      body: [
        "لأن كلا الجهازين على نفس الشبكة أصلًا، يربطهما Relayium من الند للند مباشرةً — تنتقل البايتات من جهاز إلى آخر عبر شبكة Wi-Fi المحلية لديك ولا تقوم أبدًا برحلة ذهاب وإياب إلى خادم Relayium. لا شيء لرفعه ولا شيء لانتظار تنزيله؛ وتتحدد السرعة بشبكتك المحلية فقط، وهي عادةً أسرع كثيرًا من اتصال الإنترنت في أي من الاتجاهين.",
        "وهذا أيضًا سبب عدم إشراك أي حساب على أي جانب: فما دام الجميع على نفس الشبكة الموثوقة، لا يحتاج Relayium إلى تسجيل الدخول ليعرف مَن يُسمح له بالاتصال بمَن.",
      ],
    },
    {
      heading: "ما يزال مشفَّرًا من الطرف إلى الطرف",
      body: [
        "الوجود على نفس الشبكة لا يعني أن النقل يُرسَل بنص صريح. يتفاوض Relayium على تبادل مفاتيح X25519 بين الجهازين ويشفّر كل جزء بـ AES-256-GCM؛ ولا يرى هذا المفتاح أي خادم، بما في ذلك خادم الإشارة الخاص بـ Relayium نفسه، الذي لا يفعل سوى مساعدة الجهازين على العثور على بعضهما. ويتيح لك رمز التحقق القصير (SAS) الذي تعرضه الشاشتان أن تؤكّد بصريًا أن الاتصال قائم حقًا بين جهازيك، ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256 لتعلم أنه وصل سليمًا بايتًا ببايت.",
      ],
    },
    {
      heading: "إذا كان جهاز على شبكة مختلفة",
      body: [
        "لا يعمل وضع نفس الشبكة إلا عندما تتشارك الأجهزة شبكةً بالفعل — فالهاتف على بيانات الجوال، أو الحاسوب المحمول على شبكة Wi-Fi مختلفة، أو جهاز خلف موجّه مختلف لن يظهر تلقائيًا. لتلك الحالة، يدعم Relayium أيضًا الاتصال عبر الشبكات برمز اقتران قصير: يسجّل المُرسِل الدخول لتوليد الرمز (أو رمز QR / رابط)، ولا يحتاج المُستقبِل أبدًا إلى حساب، ويبقى النقل متصلًا مباشرةً، من الند للند، متى سمحت الشبكات بذلك — ولا يعود إلى مُرحِّل مُشفَّر إلا عندما يتعذّر المسار المباشر.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى حساب لإرسال الملفات على نفس شبكة Wi-Fi؟",
        a: "لا. لا تحتاج عمليات النقل على نفس الشبكة إلى حساب ولا رمز اقتران على أي من الجانبين — فقط افتح relayium.com على كل جهاز.",
      },
      {
        q: "كيف يعرف Relayium أي الأجهزة على شبكتي؟",
        a: "تتشارك الأجهزة التي تتصل من نفس الشبكة عادةً نفس عنوان IP العام، ويجمع Relayium الأجهزة ذات عنوان IP العام المتطابق في نفس الغرفة تلقائيًا، دون الحاجة إلى أي رمز.",
      },
      {
        q: "هل يمكن لأكثر من جهازين رؤية بعضها في آنٍ واحد؟",
        a: "نعم. غرف نفس الشبكة ليست محدودة بزوج — فكل جهاز يفتح relayium.com من تلك الشبكة يمكن أن يظهر ويستقبل الملفات، وهو مفيد للمشاركة مع عدة أشخاص في نفس الغرفة أو المكتب.",
      },
      {
        q: "هل يبقى النقل مشفَّرًا إن لم يغادر شبكتي أبدًا؟",
        a: "نعم. يستخدم كل نقل على نفس الشبكة نفس تبادل مفاتيح X25519 وتشفير AES-256-GCM المستخدَمَين في النقل عبر الشبكات، مع رمز تحقق يمكنك التأكد منه بنفسك وفحص سلامة SHA-256 لكل ملف.",
      },
      {
        q: "ماذا لو كان جهاز على Wi-Fi والآخر على بيانات الجوال؟",
        a: "عندئذ لا يكونان على نفس الشبكة، فلن يربطهما الاكتشاف التلقائي. استخدم رمز اقتران بدلًا من ذلك — يسجّل المُرسِل الدخول لإنشائه، ولا يحتاج المُستقبِل إلى حساب، ويبقى الجهازان متصلين مباشرةً.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على أي جهازين (أو أكثر) على نفس شبكة Wi-Fi وأرسِل أول ملف لك — دون حساب، دون رمز.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Enviar archivos entre dispositivos en la misma Wi-Fi",
  description:
    "Cómo enviar archivos entre cualquier dispositivo en la misma Wi-Fi o red local — sin cuenta, sin código de emparejamiento, solo abre relayium.com en ambos y transfiere directamente, cifrado de extremo a extremo.",
  updatedLabel: "Última actualización",
  lead: [
    "Si dos o más dispositivos están en la misma Wi-Fi o red local, enviar un archivo entre ellos no debería requerir una cuenta, un código ni un rodeo por la nube. Relayium detecta cuándo los dispositivos comparten una red y les permite conectarse directamente, en el navegador, sin nada que registrar.",
    "Esta guía cubre el caso genérico de la misma red — cualquier dispositivo, cualquier sistema operativo, incluso más de dos a la vez. Si tienes en mente una pareja de dispositivos concreta, consulta las guías dedicadas para PC a teléfono, Mac a Windows, o un flujo estilo AirDrop para Windows/Linux/Android, enlazadas al final.",
  ],
  sections: [
    {
      heading: "Cómo funciona la detección en la misma red",
      body: [
        "Relayium no te pide teclear nada para encontrar dispositivos cercanos. Cuando tu navegador abre relayium.com sin un código de emparejamiento, el servidor te coloca en una sala según la red desde la que te conectas — en la práctica, los dispositivos que comparten la misma dirección IP pública (la misma Wi-Fi de casa, la oficina o el campus, o el mismo punto de acceso móvil) van a parar automáticamente a la misma sala.",
        "Esa sala no está limitada a dos participantes: acoge tantos dispositivos como abran el sitio desde esa red, así que toda una mesa de portátiles o un aula de teléfonos pueden verse todos a la vez, no solo una única pareja.",
      ],
    },
    {
      heading: "Paso a paso",
      body: [
        "Todo el proceso ocurre en el navegador — ninguna app que instalar en ningún dispositivo.",
      ],
      bullets: [
        "Conecta cada dispositivo que quieras usar a la misma Wi-Fi o red local.",
        "En cada dispositivo, abre relayium.com en un navegador moderno (Chrome, Edge, Firefox o Safari).",
        "Los dispositivos de esa red aparecen entre sí automáticamente — sin código, sin inicio de sesión, sin cuenta en ninguno de los lados.",
        "Elige un archivo o una carpeta entera (hasta 1.000 archivos por lote) y selecciona qué dispositivo de la lista debe recibirlo.",
        "Ambos dispositivos muestran el mismo código de verificación corto (SAS). Échale un vistazo en cada pantalla, confirma que coincide, y la transferencia empieza.",
        "Los archivos pasan directamente de un dispositivo al otro; guárdalos cuando lleguen.",
      ],
    },
    {
      heading: "Por qué es rápido: sin servidor en medio",
      body: [
        "Como ambos dispositivos ya están en la misma red, Relayium los conecta directamente de igual a igual — los bytes viajan de un dispositivo al otro por tu Wi-Fi local y nunca hacen un viaje de ida y vuelta a un servidor de Relayium. No hay nada que subir ni nada que esperar al descargar; la velocidad solo está limitada por tu red local, que suele ser mucho más rápida que una conexión a internet en cualquier sentido.",
        "Esta es también la razón por la que no interviene cuenta alguna en ningún lado: con todos ya en la misma red de confianza, Relayium no necesita inicio de sesión para saber quién debería poder conectarse con quién.",
      ],
    },
    {
      heading: "Sigue siendo cifrado de extremo a extremo",
      body: [
        "Estar en la misma red no significa que la transferencia se envíe en claro. Relayium negocia un intercambio de claves X25519 entre los dos dispositivos y cifra cada bloque con AES-256-GCM; esa clave nunca la ve ningún servidor, incluido el propio servidor de señalización de Relayium, que solo ayuda a los dispositivos a encontrarse. El código de verificación corto (SAS) que ambas pantallas muestran te permite confirmar visualmente que la conexión es realmente entre tus dos dispositivos, y cada archivo se comprueba de extremo a extremo con un hash SHA-256 para que sepas que llegó intacto byte a byte.",
      ],
    },
    {
      heading: "Si un dispositivo está en una red distinta",
      body: [
        "El modo de la misma red solo funciona cuando los dispositivos comparten realmente una red — un teléfono con datos móviles, un portátil en otra Wi-Fi o un dispositivo detrás de otro router no aparecerán automáticamente. Para ese caso, Relayium también admite conectar entre redes con un código de emparejamiento corto: el remitente inicia sesión para generar el código (o un código QR / enlace), quien recibe nunca necesita una cuenta, y la transferencia sigue conectando directamente, de igual a igual, siempre que las redes lo permitan — recurriendo a un retransmisor cifrado solo cuando no es posible una ruta directa.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito una cuenta para enviar archivos en la misma Wi-Fi?",
        a: "No. Las transferencias en la misma red no necesitan cuenta ni código de emparejamiento en ninguno de los lados — solo abre relayium.com en cada dispositivo.",
      },
      {
        q: "¿Cómo sabe Relayium qué dispositivos están en mi red?",
        a: "Los dispositivos que se conectan desde la misma red suelen compartir la misma dirección IP pública, y Relayium agrupa automáticamente en la misma sala los dispositivos con una IP pública coincidente, sin necesidad de código.",
      },
      {
        q: "¿Pueden verse más de dos dispositivos a la vez?",
        a: "Sí. Las salas de la misma red no se limitan a una pareja — cada dispositivo que abra relayium.com desde esa red puede aparecer y recibir archivos, útil para compartir con varias personas en la misma sala u oficina.",
      },
      {
        q: "¿Sigue cifrada la transferencia aunque nunca salga de mi red?",
        a: "Sí. Cada transferencia en la misma red usa el mismo intercambio de claves X25519 y el mismo cifrado AES-256-GCM que una entre redes, con un código de verificación que puedes comprobar tú mismo y una comprobación de integridad SHA-256 por archivo.",
      },
      {
        q: "¿Y si un dispositivo está en Wi-Fi y el otro en datos móviles?",
        a: "No están en la misma red, así que el descubrimiento automático no los conectará. Usa en su lugar un código de emparejamiento — el remitente inicia sesión para crearlo, quien recibe no necesita cuenta, y los dos dispositivos aún se conectan directamente.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en dos (o más) dispositivos cualesquiera en la misma Wi-Fi y envía tu primer archivo — sin cuenta, sin código.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Enviar arquivos entre dispositivos na mesma Wi-Fi",
  description:
    "Como enviar arquivos entre quaisquer dispositivos na mesma Wi-Fi ou rede local — sem conta, sem código de emparelhamento, é só abrir relayium.com nos dois e transferir diretamente, criptografado de ponta a ponta.",
  updatedLabel: "Última atualização",
  lead: [
    "Se dois ou mais dispositivos estão na mesma Wi-Fi ou rede local, enviar um arquivo entre eles não deveria exigir uma conta, um código nem um desvio pela nuvem. O Relayium detecta quando os dispositivos compartilham uma rede e permite que se conectem diretamente, no navegador, sem nada para cadastrar.",
    "Este guia cobre o caso genérico da mesma rede — quaisquer dispositivos, quaisquer sistemas operacionais, até mais de dois ao mesmo tempo. Se você tem em mente um par de dispositivos específico, veja os guias dedicados para PC para celular, Mac para Windows, ou um fluxo no estilo AirDrop para Windows/Linux/Android, com links no fim.",
  ],
  sections: [
    {
      heading: "Como funciona a detecção na mesma rede",
      body: [
        "O Relayium não pede que você digite nada para encontrar dispositivos próximos. Quando seu navegador abre relayium.com sem um código de emparelhamento, o servidor coloca você em uma sala com base na rede pela qual você está se conectando — na prática, dispositivos que compartilham o mesmo endereço IP público (a mesma Wi-Fi de casa, do escritório ou do campus, ou o mesmo ponto de acesso móvel) vão parar automaticamente na mesma sala.",
        "Essa sala não é limitada a dois participantes: ela comporta quantos dispositivos abrirem o site a partir daquela rede, então uma mesa inteira de notebooks ou uma sala de aula de celulares podem se ver todos ao mesmo tempo, não apenas um único par.",
      ],
    },
    {
      heading: "Passo a passo",
      body: [
        "Todo o fluxo acontece no navegador — nenhum app para instalar em qualquer dispositivo.",
      ],
      bullets: [
        "Conecte cada dispositivo que você quer usar à mesma Wi-Fi ou rede local.",
        "Em cada dispositivo, abra relayium.com em um navegador moderno (Chrome, Edge, Firefox ou Safari).",
        "Os dispositivos daquela rede aparecem uns para os outros automaticamente — sem código, sem login, sem conta em nenhum dos lados.",
        "Escolha um arquivo ou uma pasta inteira (até 1.000 arquivos por lote) e escolha qual dispositivo da lista deve recebê-lo.",
        "Ambos os dispositivos mostram o mesmo código de verificação curto (SAS). Dê uma olhada em cada tela, confirme que coincide, e a transferência começa.",
        "Os arquivos passam direto de um dispositivo para o outro; salve-os quando chegarem.",
      ],
    },
    {
      heading: "Por que é rápido: nenhum servidor no meio",
      body: [
        "Como os dois dispositivos já estão na mesma rede, o Relayium os conecta diretamente ponto a ponto — os bytes viajam de um dispositivo para o outro pela sua Wi-Fi local e nunca fazem uma ida e volta a um servidor do Relayium. Não há nada para enviar e nada para esperar baixando; a velocidade é limitada apenas pela sua rede local, que normalmente é muito mais rápida do que uma conexão de internet em qualquer sentido.",
        "É também por isso que nenhuma conta está envolvida em nenhum dos lados: com todos já na mesma rede confiável, o Relayium não precisa de login para saber quem deve poder se conectar a quem.",
      ],
    },
    {
      heading: "Ainda criptografado de ponta a ponta",
      body: [
        "Estar na mesma rede não significa que a transferência é enviada às claras. O Relayium negocia uma troca de chaves X25519 entre os dois dispositivos e criptografa cada bloco com AES-256-GCM; essa chave nunca é vista por nenhum servidor, incluindo o próprio servidor de sinalização do Relayium, que apenas ajuda os dispositivos a se encontrarem. O código de verificação curto (SAS) que ambas as telas exibem permite confirmar visualmente que a conexão é realmente entre os seus dois dispositivos, e cada arquivo é verificado de ponta a ponta com um hash SHA-256 para você saber que chegou intacto, byte a byte.",
      ],
    },
    {
      heading: "Se um dispositivo estiver em uma rede diferente",
      body: [
        "O modo da mesma rede só funciona quando os dispositivos realmente compartilham uma rede — um celular no dados móveis, um notebook em outra Wi-Fi ou um dispositivo atrás de outro roteador não aparecerá automaticamente. Para esse caso, o Relayium também oferece conexão entre redes com um código de emparelhamento curto: o remetente faz login para gerar o código (ou um código QR / link), quem recebe nunca precisa de conta, e a transferência ainda se conecta diretamente, ponto a ponto, sempre que as redes permitirem — recorrendo a um retransmissor criptografado apenas quando um caminho direto não é possível.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso de uma conta para enviar arquivos na mesma Wi-Fi?",
        a: "Não. Transferências na mesma rede não precisam de conta nem de código de emparelhamento em nenhum dos lados — é só abrir relayium.com em cada dispositivo.",
      },
      {
        q: "Como o Relayium sabe quais dispositivos estão na minha rede?",
        a: "Dispositivos que se conectam a partir da mesma rede normalmente compartilham o mesmo endereço IP público, e o Relayium agrupa automaticamente na mesma sala os dispositivos com IP público correspondente, sem exigir código.",
      },
      {
        q: "Mais de dois dispositivos podem se ver ao mesmo tempo?",
        a: "Sim. As salas da mesma rede não são limitadas a um par — todo dispositivo que abrir relayium.com a partir daquela rede pode aparecer e receber arquivos, útil para compartilhar com várias pessoas na mesma sala ou escritório.",
      },
      {
        q: "A transferência continua criptografada mesmo que nunca saia da minha rede?",
        a: "Sim. Toda transferência na mesma rede usa a mesma troca de chaves X25519 e a mesma criptografia AES-256-GCM de uma entre redes, com um código de verificação que você mesmo pode conferir e uma verificação de integridade SHA-256 por arquivo.",
      },
      {
        q: "E se um dispositivo estiver na Wi-Fi e o outro no dados móveis?",
        a: "Então eles não estão na mesma rede, e a descoberta automática não vai conectá-los. Use um código de emparelhamento em vez disso — o remetente faz login para criá-lo, quem recebe não precisa de conta, e os dois dispositivos ainda se conectam diretamente.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium em dois (ou mais) dispositivos quaisquer na mesma Wi-Fi e envie seu primeiro arquivo — sem conta, sem código.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/send-files-on-the-same-wifi",
  published: "2026-07-09",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
