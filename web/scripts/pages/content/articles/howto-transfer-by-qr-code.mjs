// web/scripts/pages/content/articles/howto-transfer-by-qr-code.mjs
// How-to: transfer files by scanning a QR code (the cross-network pairing flow).
// English is the master; zh/ja/ko/de/fr follow the same structure with identical
// facts. Terminology mirrors src/lib/i18n.svelte.ts, CodePairing.svelte and
// content/landing.mjs.

const en = {
  title: "Transfer files by scanning a QR code",
  description:
    "Send files by scanning a QR code from a pairing session — the transfer connects directly, end-to-end encrypted. No app or account needed for the person scanning.",
  updatedLabel: "Last updated",
  lead: [
    "Typing a six-digit code is fast, but scanning is faster still — point a phone camera at the screen and the transfer is set up before you'd have finished typing. Relayium's pairing flow shows a QR code alongside every pairing code for exactly this reason.",
    "This is the cross-network flow: it works whether both devices are on the same Wi-Fi or on opposite sides of the planet. The QR is just a shortcut into that flow — the code and the link underneath it work exactly the same way if scanning isn't convenient.",
  ],
  sections: [
    {
      heading: "Create a code, get a QR",
      body: [
        "On the sending device, open relayium.com and sign in — creating a pairing code is the one place Relayium asks for an account, because the code has to belong to someone. Pick a file, a folder, or just connect without files queued yet.",
        "Relayium mints a short numeric code and, right next to it, renders a QR code. The QR doesn't encode anything new — it's the same join link the \"copy link\" button gives you, just rendered as a scannable square instead of text. Whoever opens that link lands straight in your pairing room.",
      ],
    },
    {
      heading: "Scan it — no app, no account",
      body: [
        "On the other device, open the camera app (or any QR scanner) and point it at the screen. Tapping the notification that pops up opens the link in a browser, which joins the room automatically — no typing, no relayium.com account for the person scanning, and nothing to install.",
        "If a camera isn't handy, the same link works pasted into any browser, and the six-digit code works typed into the \"enter code\" box on relayium.com. The QR is a convenience layered on top of both, not a separate mechanism — pick whichever is easiest in the moment.",
      ],
    },
    {
      heading: "What happens after the scan",
      body: [
        "Scanning only gets the two devices into the same room; the transfer itself is unchanged from any other pairing-code session. The devices negotiate a direct peer-to-peer connection and derive a shared key with an X25519 key exchange, then encrypt every chunk with AES-256-GCM.",
        "Both screens show the same short verification code (SAS) — glance at both and confirm they match before trusting the connection; it's how you catch a malicious relay standing in the middle. When a direct path isn't possible across the two networks, the encrypted stream falls back to a TURN relay, which only ever sees ciphertext, never your files. Each file is checked end-to-end with a SHA-256 hash, and a dropped connection can resume instead of restarting.",
      ],
    },
    {
      heading: "If scanning doesn't work",
      body: [
        "Cameras misfire, lighting is bad, or one device just doesn't have a camera handy — none of that should block the transfer. The pairing card on the sending device also shows copy buttons for the raw code and the link (and a share-sheet button on devices that support it), plus a countdown until the code expires.",
        "Retype the code, paste the link, or use the share sheet to send it another way (chat, AirDrop, whatever's fastest) — every path lands in the same room and gets the same direct, encrypted connection. The QR is one entry point among several, never a requirement.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the person scanning the QR need a Relayium account?",
        a: "No. Only the sender signs in to create the pairing code and its QR. Whoever scans it just joins the room that was already created — no account, no sign-up, nothing to install.",
      },
      {
        q: "What does the QR code actually contain?",
        a: "The same join link the \"copy link\" button copies — a relayium.com URL with the pairing code baked in. Scanning it just opens that link in the browser, which joins the room automatically.",
      },
      {
        q: "Is scanning the QR as secure as typing the code?",
        a: "Yes, it's the identical connection either way. Both devices still negotiate an X25519 key exchange, encrypt with AES-256-GCM, and show a matching SAS verification code you should check before trusting the transfer. The QR only changes how you get into the room, not how the transfer is secured.",
      },
      {
        q: "What if the QR won't scan?",
        a: "Nothing is lost — the same pairing card shows the raw code and a copyable link, and a share-sheet button on supported devices. Any of them opens the same room as the QR.",
      },
      {
        q: "Does this work across different networks, like phone data to home Wi-Fi?",
        a: "Yes. This is the cross-network pairing flow, so it works whether both devices share a network or not. Relayium connects them directly when it can, and only falls back to an encrypted relay when a direct path isn't possible.",
      },
    ],
  },
  cta: {
    text: "Open Relayium, create a code, and try scanning the QR with another device — no app, no account needed for the person scanning.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "扫描二维码传输文件",
  description:
    "如何用 Relayium 扫二维码传文件：先创建配对码，再扫描出现的二维码，传输就会直连并端到端加密——扫码那一方不用装 App，也不用账号。",
  updatedLabel: "最近更新",
  lead: [
    "打六位数字码很快，但扫码更快——手机摄像头对准屏幕一扫，往往比你把码打完还快。Relayium 的配对流程会在每个配对码旁边同时显示一个二维码，就是为了这个。",
    "这是跨网络流程：无论两台设备是不是同一个 Wi-Fi，甚至身处地球两端，都能用。二维码只是这个流程的一条捷径——如果扫码不方便，下面的配对码和链接同样能用，效果完全一样。",
  ],
  sections: [
    {
      heading: "创建配对码，就会拿到二维码",
      body: [
        "在发送端设备上打开 relayium.com 并登录——创建配对码是 Relayium 唯一要求账号的地方，因为这个码得归属于某个人。选一个文件、一个文件夹，或者先不排队文件直接连接。",
        "Relayium 会生成一个短数字码，紧挨着它渲染出一个二维码。二维码本身并没有编码什么新东西——它就是\"复制链接\"按钮给你的那条加入链接，只是渲染成了可扫描的方块而不是文字。谁打开那条链接，谁就会直接进入你的配对房间。",
      ],
    },
    {
      heading: "扫一下——不用装 App，不用账号",
      body: [
        "在另一台设备上打开相机 App（或任何二维码扫描工具），对准屏幕。点一下弹出的通知，会在浏览器里打开那条链接，并自动加入房间——扫码那一方不用打字，不用注册 relayium.com 账号，也没有任何东西要安装。",
        "如果手边没有摄像头，同一条链接粘贴到任意浏览器里也能用，六位数字码打进 relayium.com 的\"输入配对码\"框里也一样能用。二维码只是叠加在两者之上的一层便利，不是另一套机制——哪个方便用哪个。",
      ],
    },
    {
      heading: "扫码之后发生了什么",
      body: [
        "扫码只是让两台设备进到同一个房间；传输本身和其它任何配对码会话完全一样。两台设备会协商建立点对点直连，用 X25519 密钥交换协商出共享密钥，再用 AES-256-GCM 对每个数据块加密。",
        "两块屏幕会显示同一段简短的校验码（SAS）——扫一眼两边，确认一致后再信任这条连接；这正是发现中间人恶意中继的办法。当两边网络之间无法直连时，加密数据流会退回到 TURN 中继，而中继始终只能看到密文，看不到你的文件内容。每个文件都会用 SHA-256 哈希做端到端校验，中途断开也能续传而不必重来。",
      ],
    },
    {
      heading: "扫码失败怎么办",
      body: [
        "摄像头没对好焦、光线不好，或者某台设备手边没有摄像头——这些都不该挡住传输。发送端的配对卡片同时也提供原始配对码和链接的复制按钮（支持的设备上还有系统分享按钮），以及配对码的失效倒计时。",
        "重新输一遍码、粘贴链接，或者用系统分享把它发到别的地方（聊天软件、隔空传送，怎么快怎么来）——每条路径都会进到同一个房间，得到同样直连、同样加密的连接。二维码只是众多入口之一，从来不是必需品。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "扫二维码的一方需要 Relayium 账号吗？",
        a: "不需要。只有发送方需要登录来创建配对码和它的二维码。扫码的一方只是加入一个已经建好的房间——不用账号，不用注册，也没有任何东西要安装。",
      },
      {
        q: "二维码里到底存的是什么？",
        a: "和\"复制链接\"按钮复制出来的那条加入链接一模一样——一个内嵌了配对码的 relayium.com 网址。扫一下，就是在浏览器里打开那条链接，然后自动加入房间。",
      },
      {
        q: "扫二维码和手动输码一样安全吗？",
        a: "一样，两种方式建立的是完全相同的连接。都会协商 X25519 密钥交换、用 AES-256-GCM 加密，并显示一致的 SAS 校验码供你确认后再信任传输。二维码只改变了你进入房间的方式，不改变传输的安全机制。",
      },
      {
        q: "如果二维码扫不出来怎么办？",
        a: "不会有任何损失——同一张配对卡片上也有原始配对码和可复制的链接，支持的设备上还有系统分享按钮。用哪一个都能进到二维码指向的同一个房间。",
      },
      {
        q: "跨网络也能用吗，比如手机用移动数据、电脑连家里 Wi-Fi？",
        a: "可以。这本来就是跨网络配对流程，所以无论两台设备是否同一网络都能用。能直连时 Relayium 会直接连接，只有在无法直连时才会退回到加密中继。",
      },
    ],
  },
  cta: {
    text: "打开 Relayium，创建一个配对码，用另一台设备试着扫一下二维码——扫码那一方不用装 App，也不用账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "QR コードをスキャンしてファイルを転送する",
  description:
    "Relayium で QR コードをスキャンしてファイルを送る方法。ペアリングコードを作成し、表示された QR をスキャンするだけで、直接かつエンドツーエンド暗号化された転送が始まります。スキャンする側はアプリもアカウントも不要です。",
  updatedLabel: "最終更新",
  lead: [
    "6桁のコードを入力するのも速いですが、スキャンならさらに速いです。スマホのカメラを画面に向けるだけで、コードを入力し終える前に転送の準備が整います。Relayium のペアリング画面がペアリングコードと並べて QR コードを表示するのは、まさにこのためです。",
    "これはネットワークをまたぐ転送方式で、同じ Wi-Fi でも、地球の反対側同士でも動作します。QR コードはこの方式への近道にすぎません——スキャンが不便なら、その下にあるコードやリンクもまったく同じように使えます。",
  ],
  sections: [
    {
      heading: "コードを作ると QR も表示される",
      body: [
        "送信側の端末で relayium.com を開いてサインインします——ペアリングコードの作成は、Relayium が唯一アカウントを求める場面です。コードは誰かに帰属している必要があるからです。ファイル、フォルダを選ぶか、ファイルなしでまず接続だけ済ませることもできます。",
        "Relayium は短い数字コードを発行し、その隣に QR コードを描画します。QR コードは何か新しい情報を含んでいるわけではなく、「リンクをコピー」ボタンで得られるのと同じ参加リンクを、テキストではなくスキャン可能な四角形として表示しているだけです。そのリンクを開いた人は、そのままペアリングルームに入ります。",
      ],
    },
    {
      heading: "スキャンするだけ——アプリもアカウントも不要",
      body: [
        "もう一方の端末でカメラアプリ（または任意の QR スキャナー）を開き、画面に向けます。表示された通知をタップするとブラウザでリンクが開き、自動的にルームに参加します——スキャンする側は入力も relayium.com のアカウントも不要で、インストールするものも何もありません。",
        "カメラが使えない場合も、同じリンクを任意のブラウザに貼り付ければ使えますし、6桁のコードを relayium.com の「コードを入力」欄に打ち込んでも同様に使えます。QR コードはこの両方の上に重ねられた利便性にすぎず、別の仕組みではありません——その場でやりやすい方を選んでください。",
      ],
    },
    {
      heading: "スキャン後に起きること",
      body: [
        "スキャンは2台の端末を同じルームに入れるだけで、転送そのものは他のペアリングコードのセッションと変わりません。両端末は直接の P2P 接続をネゴシエートし、X25519 鍵交換で共有鍵を導出したうえで、各チャンクを AES-256-GCM で暗号化します。",
        "両方の画面に同じ短い検証コード（SAS）が表示されるので、両方を見比べて一致を確認してから接続を信頼してください——これが、間に悪意あるリレーが入り込んでいないかを見抜く方法です。2つのネットワーク間で直接経路が取れない場合、暗号化ストリームは TURN リレーにフォールバックしますが、リレーが見るのは常に暗号文だけで、ファイルの中身を見ることはありません。各ファイルは SHA-256 ハッシュでエンドツーエンドに検証され、接続が切れても最初からではなく再開できます。",
      ],
    },
    {
      heading: "スキャンできないときは",
      body: [
        "カメラのピントが合わない、照明が悪い、あるいは片方の端末にそもそもカメラがない——そうした事情で転送が止まる必要はありません。送信側のペアリングカードには、生のコードとリンクをコピーするボタン（対応端末では共有シートのボタンも）に加えて、コードの失効までのカウントダウンも表示されます。",
        "コードを打ち直す、リンクを貼り付ける、あるいは共有シートで別の方法（チャットや AirDrop など、いちばん速いもの）で送る——どの経路をたどっても同じルームに入り、同じ直接かつ暗号化された接続が得られます。QR コードは複数ある入口の一つにすぎず、必須ではありません。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "QR コードをスキャンする側にも Relayium のアカウントが必要ですか？",
        a: "いいえ。ペアリングコードとその QR コードを作成するのは送信側だけがサインインすれば済みます。スキャンする側はすでに作られたルームに参加するだけで、アカウントもサインアップも、インストールするものも何もありません。",
      },
      {
        q: "QR コードには実際には何が入っていますか？",
        a: "「リンクをコピー」ボタンでコピーされるのと同じ参加リンクです——ペアリングコードが埋め込まれた relayium.com の URL です。スキャンするとブラウザでそのリンクが開き、自動的にルームに参加します。",
      },
      {
        q: "QR コードのスキャンはコードを入力するのと同じくらい安全ですか？",
        a: "はい、どちらの方法でも接続はまったく同一です。両端末は依然として X25519 鍵交換をネゴシエートし、AES-256-GCM で暗号化し、転送を信頼する前に確認すべき一致した SAS 検証コードを表示します。QR コードが変えるのはルームへの入り方だけで、転送の安全性は変わりません。",
      },
      {
        q: "QR コードがスキャンできない場合は？",
        a: "何も失われません——同じペアリングカードに生のコードとコピー可能なリンクが表示され、対応端末では共有シートのボタンもあります。どれを使っても QR コードと同じルームに入れます。",
      },
      {
        q: "スマホがモバイル通信、PC が自宅 Wi-Fi のように、異なるネットワーク間でも使えますか？",
        a: "はい。これはもともとネットワークをまたぐペアリング方式なので、2台が同じネットワークであってもなくても動作します。可能なときは Relayium が直接接続し、直接経路が取れないときだけ暗号化されたリレーにフォールバックします。",
      },
    ],
  },
  cta: {
    text: "Relayium を開いてコードを作成し、別の端末で QR コードのスキャンを試してみてください——スキャンする側はアプリもアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "QR 코드를 스캔해서 파일 전송하기",
  description:
    "Relayium에서 QR 코드를 스캔해 파일을 보내는 방법. 페어링 코드를 만들고 나타난 QR을 스캔하면 직접 연결되고 종단간 암호화된 전송이 시작됩니다. 스캔하는 쪽은 앱도 계정도 필요 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "6자리 코드를 입력하는 것도 빠르지만, 스캔은 더 빠릅니다. 휴대폰 카메라를 화면에 대기만 하면 코드를 다 입력하기도 전에 전송 준비가 끝납니다. Relayium의 페어링 화면이 페어링 코드 옆에 QR 코드를 함께 보여주는 이유가 바로 이것입니다.",
    "이것은 네트워크를 넘나드는 방식이라, 두 기기가 같은 Wi-Fi에 있든 지구 반대편에 있든 동작합니다. QR 코드는 그 방식으로 들어가는 지름길일 뿐입니다 — 스캔이 불편하면 그 아래의 코드나 링크도 똑같이 작동합니다.",
  ],
  sections: [
    {
      heading: "코드를 만들면 QR도 함께 생깁니다",
      body: [
        "보내는 쪽 기기에서 relayium.com을 열고 로그인합니다 — 페어링 코드를 만드는 것이 Relayium이 계정을 요구하는 유일한 순간인데, 코드는 누군가에게 귀속되어야 하기 때문입니다. 파일이나 폴더를 고르거나, 파일 없이 우선 연결만 시작할 수도 있습니다.",
        "Relayium은 짧은 숫자 코드를 발급하고 바로 옆에 QR 코드를 그립니다. QR 코드는 새로운 정보를 담고 있는 게 아니라, '링크 복사' 버튼으로 얻는 것과 같은 참여 링크를 텍스트 대신 스캔 가능한 사각형으로 표시할 뿐입니다. 그 링크를 여는 사람은 곧바로 당신의 페어링 방으로 들어갑니다.",
      ],
    },
    {
      heading: "스캔만 하면 됩니다 — 앱도 계정도 필요 없이",
      body: [
        "다른 기기에서 카메라 앱(또는 아무 QR 스캐너)을 열고 화면에 대세요. 뜨는 알림을 탭하면 브라우저에서 링크가 열리며 자동으로 방에 참여합니다 — 스캔하는 쪽은 입력할 것도, relayium.com 계정도 필요 없고, 설치할 것도 전혀 없습니다.",
        "카메라를 쓰기 어렵다면 같은 링크를 아무 브라우저에 붙여 넣어도 되고, 6자리 코드를 relayium.com의 '코드 입력' 칸에 쳐 넣어도 마찬가지로 작동합니다. QR 코드는 이 둘 위에 얹힌 편의 기능일 뿐, 별개의 메커니즘이 아닙니다 — 그때그때 편한 쪽을 고르세요.",
      ],
    },
    {
      heading: "스캔 후 일어나는 일",
      body: [
        "스캔은 두 기기를 같은 방에 넣어줄 뿐, 전송 자체는 다른 페어링 코드 세션과 다르지 않습니다. 두 기기는 직접 P2P 연결을 협상하고 X25519 키 교환으로 공유 키를 도출한 뒤, 각 청크를 AES-256-GCM으로 암호화합니다.",
        "두 화면 모두 같은 짧은 검증 코드(SAS)를 보여주므로, 둘 다 확인해 일치하는지 본 뒤에 연결을 신뢰하세요 — 이것이 중간에 악의적인 릴레이가 끼어들었는지 잡아내는 방법입니다. 두 네트워크 사이에 직접 경로를 잡을 수 없을 때는 암호화된 스트림이 TURN 릴레이로 폴백하지만, 릴레이는 항상 암호문만 볼 뿐 파일 내용은 절대 보지 못합니다. 각 파일은 SHA-256 해시로 종단간 검증되며, 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다.",
      ],
    },
    {
      heading: "스캔이 안 될 때는",
      body: [
        "카메라 초점이 안 맞거나, 조명이 나쁘거나, 한쪽 기기에 카메라가 마땅치 않을 수도 있습니다 — 그렇다고 전송이 막힐 필요는 없습니다. 보내는 쪽의 페어링 카드에는 원본 코드와 링크를 복사하는 버튼(지원 기기에서는 공유 시트 버튼도)과, 코드 만료까지의 카운트다운도 함께 표시됩니다.",
        "코드를 다시 입력하거나, 링크를 붙여 넣거나, 공유 시트로 다른 방법(채팅, 에어드롭 등 가장 빠른 것)으로 보내세요 — 어떤 경로든 같은 방으로 들어가서 똑같이 직접적이고 암호화된 연결을 얻습니다. QR 코드는 여러 입구 중 하나일 뿐, 필수가 아닙니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "QR 코드를 스캔하는 쪽도 Relayium 계정이 필요한가요?",
        a: "아니요. 페어링 코드와 그 QR을 만드는 것은 보내는 쪽만 로그인하면 됩니다. 스캔하는 쪽은 이미 만들어진 방에 참여할 뿐, 계정도 가입도, 설치할 것도 전혀 없습니다.",
      },
      {
        q: "QR 코드에는 실제로 무엇이 들어 있나요?",
        a: "'링크 복사' 버튼으로 복사되는 것과 같은 참여 링크입니다 — 페어링 코드가 담긴 relayium.com URL입니다. 스캔하면 브라우저에서 그 링크가 열리고 자동으로 방에 참여합니다.",
      },
      {
        q: "QR 코드를 스캔하는 것이 코드를 입력하는 것만큼 안전한가요?",
        a: "네, 어느 쪽이든 연결은 동일합니다. 두 기기는 여전히 X25519 키 교환을 협상하고 AES-256-GCM으로 암호화하며, 전송을 신뢰하기 전에 확인해야 할 일치하는 SAS 검증 코드를 보여줍니다. QR 코드는 방에 들어가는 방식만 바꿀 뿐, 전송의 보안 방식은 바뀌지 않습니다.",
      },
      {
        q: "QR 코드가 스캔되지 않으면 어떻게 하나요?",
        a: "아무것도 잃지 않습니다 — 같은 페어링 카드에 원본 코드와 복사 가능한 링크가 표시되고, 지원 기기에서는 공유 시트 버튼도 있습니다. 무엇을 쓰든 QR 코드와 같은 방으로 들어갑니다.",
      },
      {
        q: "휴대폰은 모바일 데이터, PC는 집 Wi-Fi처럼 서로 다른 네트워크에서도 되나요?",
        a: "네. 이것은 원래 네트워크를 넘나드는 페어링 방식이라, 두 기기가 같은 네트워크에 있든 아니든 동작합니다. 가능할 때는 Relayium이 직접 연결하고, 직접 경로가 불가능할 때만 암호화된 릴레이로 폴백합니다.",
      },
    ],
  },
  cta: {
    text: "Relayium을 열어 코드를 만들고, 다른 기기로 QR 코드 스캔을 시도해 보세요 — 스캔하는 쪽은 앱도 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien per QR-Code-Scan übertragen",
  description:
    "Dateien per QR-Code-Scan senden: Der QR gehört zu einem Pairing-Code, die Übertragung verbindet direkt, Ende-zu-Ende-verschlüsselt. Keine App, kein Konto für die scannende Person.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Einen sechsstelligen Code einzutippen geht schnell, doch Scannen geht noch schneller — die Handykamera aufs Display richten, und die Übertragung steht, bevor man den Code fertig eingetippt hätte. Genau deshalb zeigt Relayiums Pairing-Ansicht neben jedem Pairing-Code auch einen QR-Code an.",
    "Das ist der netzwerkübergreifende Ablauf: Er funktioniert, egal ob beide Geräte im selben WLAN oder auf entgegengesetzten Seiten der Welt sind. Der QR-Code ist nur eine Abkürzung in diesen Ablauf hinein — der Code und der Link darunter funktionieren genauso, wenn Scannen gerade unpraktisch ist.",
  ],
  sections: [
    {
      heading: "Code erstellen, QR erhalten",
      body: [
        "Öffne auf dem sendenden Gerät relayium.com und melde dich an — das Erstellen eines Pairing-Codes ist die einzige Stelle, an der Relayium ein Konto verlangt, weil der Code jemandem gehören muss. Wähle eine Datei, einen Ordner oder verbinde dich zunächst ganz ohne eingereihte Dateien.",
        "Relayium erzeugt einen kurzen Zahlencode und rendert direkt daneben einen QR-Code. Der QR-Code kodiert nichts Neues — es ist derselbe Beitrittslink, den auch der Button „Link kopieren“ liefert, nur als scanbares Quadrat statt als Text dargestellt. Wer diesen Link öffnet, landet direkt in deinem Pairing-Raum.",
      ],
    },
    {
      heading: "Einfach scannen — keine App, kein Konto",
      body: [
        "Öffne auf dem anderen Gerät die Kamera-App (oder einen beliebigen QR-Scanner) und richte sie aufs Display. Ein Tipp auf die erscheinende Benachrichtigung öffnet den Link im Browser, der automatisch dem Raum beitritt — die scannende Person braucht nichts einzutippen, kein relayium.com-Konto und nichts zu installieren.",
        "Ist gerade keine Kamera griffbereit, funktioniert derselbe Link ebenso, in einen beliebigen Browser eingefügt, und der sechsstellige Code funktioniert genauso, in das Feld „Code eingeben“ auf relayium.com getippt. Der QR-Code ist eine Annehmlichkeit obendrauf, kein eigener Mechanismus — nimm, was gerade am einfachsten ist.",
      ],
    },
    {
      heading: "Was nach dem Scannen passiert",
      body: [
        "Scannen bringt die beiden Geräte lediglich in denselben Raum; die Übertragung selbst unterscheidet sich nicht von jeder anderen Pairing-Code-Sitzung. Die Geräte handeln eine direkte Peer-to-Peer-Verbindung aus und leiten mit einem X25519-Schlüsselaustausch einen gemeinsamen Schlüssel ab, bevor jeder Block mit AES-256-GCM verschlüsselt wird.",
        "Beide Bildschirme zeigen denselben kurzen Prüfcode (SAS) — vergleicht beide und bestätigt die Übereinstimmung, bevor ihr der Verbindung vertraut; so entlarvt man ein böswilliges Relay in der Mitte. Ist zwischen den beiden Netzwerken kein direkter Weg möglich, weicht der verschlüsselte Datenstrom auf ein TURN-Relay aus, das stets nur Chiffretext sieht, niemals eure Dateien. Jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, und eine unterbrochene Verbindung kann fortgesetzt statt neu gestartet werden.",
      ],
    },
    {
      heading: "Wenn das Scannen nicht klappt",
      body: [
        "Die Kamera fokussiert nicht, das Licht ist schlecht, oder ein Gerät hat gerade keine Kamera griffbereit — nichts davon sollte die Übertragung aufhalten. Die Pairing-Karte auf dem sendenden Gerät zeigt zusätzlich Kopier-Buttons für den rohen Code und den Link (sowie einen Teilen-Button auf unterstützten Geräten) sowie einen Countdown bis zum Ablauf des Codes.",
        "Tippe den Code neu ein, füge den Link ein, oder verschicke ihn über die Teilen-Funktion auf einem anderen Weg (Chat, AirDrop, was auch immer gerade am schnellsten ist) — jeder Weg führt in denselben Raum und ergibt dieselbe direkte, verschlüsselte Verbindung. Der QR-Code ist einer von mehreren Einstiegspunkten, nie eine Voraussetzung.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Braucht die scannende Person ein Relayium-Konto?",
        a: "Nein. Nur der Absender meldet sich an, um den Pairing-Code und dessen QR zu erstellen. Wer ihn scannt, tritt lediglich dem bereits erstellten Raum bei — kein Konto, keine Anmeldung, nichts zu installieren.",
      },
      {
        q: "Was steckt eigentlich im QR-Code?",
        a: "Derselbe Beitrittslink, den auch der Button „Link kopieren“ liefert — eine relayium.com-URL mit dem eingebetteten Pairing-Code. Scannen öffnet einfach diesen Link im Browser, der automatisch dem Raum beitritt.",
      },
      {
        q: "Ist das Scannen des QR-Codes genauso sicher wie das Eintippen des Codes?",
        a: "Ja, die Verbindung ist in beiden Fällen identisch. Beide Geräte handeln weiterhin einen X25519-Schlüsselaustausch aus, verschlüsseln mit AES-256-GCM und zeigen einen übereinstimmenden SAS-Prüfcode, den ihr vor dem Vertrauen kontrollieren solltet. Der QR-Code ändert nur, wie ihr in den Raum kommt, nicht wie die Übertragung abgesichert ist.",
      },
      {
        q: "Was, wenn sich der QR-Code nicht scannen lässt?",
        a: "Nichts geht verloren — dieselbe Pairing-Karte zeigt den rohen Code und einen kopierbaren Link, auf unterstützten Geräten zusätzlich einen Teilen-Button. Jeder davon führt in denselben Raum wie der QR-Code.",
      },
      {
        q: "Funktioniert das auch über unterschiedliche Netzwerke hinweg, etwa Handy mit Mobilfunk und PC im heimischen WLAN?",
        a: "Ja. Das ist von Grund auf der netzwerkübergreifende Pairing-Ablauf, er funktioniert also unabhängig davon, ob beide Geräte im selben Netz sind. Relayium verbindet sie direkt, wann immer möglich, und weicht nur dann auf ein verschlüsseltes Relay aus, wenn kein direkter Weg möglich ist.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium, erstelle einen Code und scanne den QR-Code mit einem anderen Gerät — die scannende Person braucht keine App und kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer des fichiers en scannant un code QR",
  description:
    "Envoyez des fichiers en scannant un QR lié à un code d'appairage : transfert direct, chiffré de bout en bout. Sans appli ni compte pour la personne qui scanne.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Taper un code à six chiffres est rapide, mais scanner l'est encore plus : pointez la caméra du téléphone vers l'écran, et le transfert est prêt avant même d'avoir fini de taper le code. C'est exactement pour cela que l'écran d'appairage de Relayium affiche un code QR juste à côté de chaque code d'appairage.",
    "C'est le mode d'appairage entre réseaux différents : il fonctionne que les deux appareils soient sur le même Wi-Fi ou aux antipodes l'un de l'autre. Le QR n'est qu'un raccourci vers ce mode — le code et le lien qu'il contient fonctionnent exactement de la même façon si scanner n'est pas pratique.",
  ],
  sections: [
    {
      heading: "Créez un code, obtenez un QR",
      body: [
        "Sur l'appareil expéditeur, ouvrez relayium.com et connectez-vous — créer un code d'appairage est le seul moment où Relayium demande un compte, car le code doit appartenir à quelqu'un. Choisissez un fichier, un dossier, ou connectez-vous simplement sans fichier en attente.",
        "Relayium génère un court code numérique et affiche juste à côté un code QR. Ce QR n'encode rien de nouveau : c'est le même lien de participation que fournit le bouton « copier le lien », simplement représenté sous forme de carré scannable plutôt qu'en texte. Quiconque ouvre ce lien atterrit directement dans votre salon d'appairage.",
      ],
    },
    {
      heading: "Il suffit de scanner — sans appli, sans compte",
      body: [
        "Sur l'autre appareil, ouvrez l'appli appareil photo (ou n'importe quel scanner QR) et pointez-la vers l'écran. Toucher la notification qui apparaît ouvre le lien dans un navigateur, qui rejoint automatiquement le salon — la personne qui scanne n'a rien à taper, pas besoin de compte relayium.com, et rien à installer.",
        "Si une caméra n'est pas à portée de main, le même lien fonctionne collé dans n'importe quel navigateur, et le code à six chiffres fonctionne tout aussi bien tapé dans le champ « saisir le code » de relayium.com. Le code QR est une commodité ajoutée par-dessus les deux, pas un mécanisme distinct — choisissez ce qui est le plus simple sur le moment.",
      ],
    },
    {
      heading: "Ce qui se passe après le scan",
      body: [
        "Scanner ne fait qu'amener les deux appareils dans le même salon ; le transfert lui-même ne diffère en rien de n'importe quelle autre session par code d'appairage. Les appareils négocient une connexion pair-à-pair directe et dérivent une clé partagée via un échange de clés X25519, puis chiffrent chaque bloc avec AES-256-GCM.",
        "Les deux écrans affichent le même code de vérification court (SAS) — comparez-les et confirmez qu'ils concordent avant de faire confiance à la connexion ; c'est ainsi qu'on repère un relais malveillant placé au milieu. Quand aucune voie directe n'est possible entre les deux réseaux, le flux chiffré bascule vers un relais TURN, qui ne voit toujours que du texte chiffré, jamais vos fichiers. Chaque fichier est vérifié de bout en bout par une empreinte SHA-256, et une connexion interrompue peut reprendre au lieu de tout recommencer.",
      ],
    },
    {
      heading: "Si le scan ne fonctionne pas",
      body: [
        "La caméra a du mal à faire le point, l'éclairage est mauvais, ou l'un des appareils n'a tout simplement pas de caméra sous la main — rien de tout cela ne devrait bloquer le transfert. La carte d'appairage sur l'appareil expéditeur affiche aussi des boutons pour copier le code brut et le lien (plus un bouton de partage sur les appareils qui le prennent en charge), ainsi qu'un compte à rebours jusqu'à l'expiration du code.",
        "Retapez le code, collez le lien, ou utilisez le partage pour l'envoyer autrement (messagerie, AirDrop, ce qui est le plus rapide) — chaque chemin mène au même salon et obtient la même connexion directe et chiffrée. Le code QR n'est qu'un point d'entrée parmi d'autres, jamais une obligation.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La personne qui scanne le QR a-t-elle besoin d'un compte Relayium ?",
        a: "Non. Seul l'expéditeur se connecte pour créer le code d'appairage et son QR. Celui qui le scanne ne fait que rejoindre le salon déjà créé — pas de compte, pas d'inscription, rien à installer.",
      },
      {
        q: "Que contient exactement le code QR ?",
        a: "Le même lien de participation que copie le bouton « copier le lien » — une URL relayium.com contenant le code d'appairage. Le scanner ouvre simplement ce lien dans le navigateur, qui rejoint automatiquement le salon.",
      },
      {
        q: "Scanner le QR est-il aussi sûr que taper le code ?",
        a: "Oui, la connexion est strictement identique dans les deux cas. Les deux appareils négocient toujours un échange de clés X25519, chiffrent avec AES-256-GCM et affichent un code de vérification SAS concordant à contrôler avant de faire confiance au transfert. Le QR ne change que la façon d'entrer dans le salon, pas la façon dont le transfert est sécurisé.",
      },
      {
        q: "Et si le code QR ne veut pas se scanner ?",
        a: "Rien n'est perdu — la même carte d'appairage affiche le code brut et un lien copiable, plus un bouton de partage sur les appareils compatibles. N'importe lequel des deux mène au même salon que le QR.",
      },
      {
        q: "Est-ce que ça marche entre réseaux différents, par exemple téléphone en données mobiles et PC sur le Wi-Fi de la maison ?",
        a: "Oui. C'est par nature le mode d'appairage entre réseaux différents, donc il fonctionne que les deux appareils partagent un réseau ou non. Relayium les connecte directement quand c'est possible, et ne bascule sur un relais chiffré que lorsqu'aucune voie directe n'est possible.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium, créez un code, et essayez de scanner le QR avec un autre appareil — la personne qui scanne n'a besoin ni d'appli ni de compte.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "how-to/transfer-files-by-scanning-a-qr-code",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr },
};
