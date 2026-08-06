// web/scripts/pages/content/articles/howto-transfer-by-qr-code.mjs
// How-to: transfer files by scanning a QR code (the cross-network pairing flow).
// English is the master; zh/ja/ko/de/fr follow the same structure with identical
// facts. Terminology mirrors src/lib/i18n.svelte.ts, CodePairing.svelte and
// content/landing.mjs.

const en = {
  title: "Transfer files by scanning a QR code",
  description:
    "Send files by scanning a QR code from a pairing session — the transfer is end-to-end encrypted the whole way. No app or account needed for the person scanning.",
  updatedLabel: "Last updated",
  lead: [
    "Typing a six-digit code is fast, but scanning is faster still — point a phone camera at the screen and the transfer is set up before you'd have finished typing. Relayium's pairing flow shows a QR code alongside every pairing code for exactly this reason.",
    "This is the cross-network flow: it works whether both devices are on the same Wi-Fi or on opposite sides of the planet. The QR is just a shortcut into that flow — the code and the link underneath it work exactly the same way if scanning isn't convenient.",
  ],
  sections: [
    {
      heading: "Create a code, get a QR",
      prereqs: {
        label: "Before you start",
        items: [
          "A signed-in account on the sending device only. Creating a pairing code needs one — so does creating an async download link — while the person who scans never signs in.",
          "A verified email address on that account, because relay for a cross-network session is only issued to verified accounts and the pairing card says so when it refuses.",
          "A camera or any QR scanner on the receiving device, and both of you present at the same time — the code lives five minutes.",
          "An agreement about who creates the code: the QR is rendered only on that device, so the other one does the scanning. That settles who joins whom, not which way files can travel once both are in the room.",
        ],
      },
      body: [
        "On the sending device, open relayium.com and sign in — creating a pairing code needs an account, because the code has to belong to someone, and creating an async download link needs one for the same reason. Joining is the part that never does: the person who scans stays signed out throughout. Pick a file, a folder, or just connect without files queued yet.",
        "Relayium mints a short pairing code — six decimal digits, so a phone can offer its numeric keypad and the code can be read aloud without spelling anything out — and, right next to it, renders a QR code. The code is good for five minutes; after that you generate a fresh one. The QR doesn't encode anything new — it's the same join link the \"copy link\" button gives you, just rendered as a scannable square instead of text. Whoever opens that link lands straight in your pairing room.",
      ],
    },
    {
      heading: "Scan it — no app, no account",
      body: [
        "On the other device, open the camera app (or any QR scanner) and point it at the screen. Tapping the notification that pops up opens the link in a browser, which joins the room automatically — no typing, no relayium.com account for the person scanning, and nothing to install. Joining is all a scan does; it moves no files. An incoming batch still waits on the receiving screen until someone presses “Accept”.",
        "If a camera isn't handy, the same link works pasted into any browser, and the six-digit code works typed into the \"enter code\" box on relayium.com. The QR is a convenience layered on top of both, not a separate mechanism — pick whichever is easiest in the moment.",
      ],
      steps: [
        {
          text: "On the sending device, open the realtime transfer page and sign in.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Create the pairing code. The card then shows the six digits, the QR square under them, and a countdown.",
          code: ["Your pairing code — read it to the other person\n483920\nor have them scan / open the link to join\npairing code expires in 4:52"],
        },
        {
          text: "On the other device, open the camera app or any QR scanner and point it at that square. Tap the link notification it offers.",
        },
        {
          text: "The link opens in a browser and joins the room on its own — nothing to type, and no account on this side. It is the same address the “Copy link” button puts on your clipboard.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "Back on the sending device, choose the files to send if you did not queue any before creating the code. Nothing moves until the receiving side presses “Accept”, so answer that prompt there, then leave both tabs open until the file counter reaches the end.",
        },
      ],
      success: {
        label: "What a successful scan looks like",
        body: [
          "On the sending device the QR and the “Waiting for the other device to join…” line give way to the connected card, and the path badge on it reads “Relayed” — the expected value for a pairing-code session, which takes the encrypted TURN relay by design.",
          "The file counter then runs to the last file on both screens. Nothing about the transfer differs from a typed-in code: scanning only decided how the second device got into the room.",
        ],
        code: ["Relayed\nFile 1/1"],
      },
    },
    {
      heading: "What happens after the scan",
      body: [
        "Scanning only gets the two devices into the same room; the transfer itself is unchanged from any other pairing-code session. Whoever created the code owns the room and whoever scanned joined it, but that is a fact about the rendezvous rather than about direction: once both are in, either side can be the one sending, and every incoming batch is still gated by “Accept” on the receiving screen. The room is also its own, older surface — a pairing code puts you in a separate two-device room rather than the shared workspace same-network devices open, and it is relay-only by design. The two browsers derive a shared key with an X25519 key exchange and encrypt every chunk with AES-256-GCM, then send those chunks over a WebRTC channel carried by a TURN relay.",
        "With advanced verification on (it is off by default), both screens show the same six-digit verification code (SAS) — glance at both and confirm they match before trusting the connection. A match confirms the keys weren't replaced: a server or relay has not impersonated either endpoint or terminated the application-layer end-to-end encryption. A pairing-code transfer always takes that relay route rather than hunting for a direct path first, so it does not depend on discovering a direct path through the NATs and firewalls between the two networks, which can prevent one. The relay only ever forwards ciphertext — it holds no key, so it never sees your files. Each file is checked end-to-end with a SHA-256 hash, and a dropped connection can resume instead of restarting.",
      ],
    },
    {
      heading: "If scanning doesn't work",
      body: [
        "Cameras misfire, lighting is bad, or one device just doesn't have a camera handy — none of that should block the transfer. The pairing card on the sending device also shows copy buttons for the raw code and the link (and a share-sheet button on devices that support it), plus a countdown until the code expires.",
        "Retype the code, paste the link, or use the share sheet to send it another way (chat, AirDrop, whatever's fastest) — every path lands in the same room and gets the same encrypted connection. The QR is one entry point among several, never a requirement.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The scan opens the page and it says the pairing code is invalid or expired.",
            code: ["https://relayium.com/cross-network   # the sender's card shows the live countdown"],
            fix: "The five minutes ran out, and a QR of a dead code stays a dead link no matter how often it is scanned. Create a fresh code on the sending device — the card renders a new QR with it — and scan that one straight away.",
          },
          {
            symptom: "The camera recognises the square but never offers to open anything.",
            code: ["https://relayium.com/cross-network   # the “Enter a pairing code” box takes the six digits"],
            fix: "Some scanners only copy the text instead of handing it to a browser. Paste what it copied into the address bar, or skip the QR entirely: open the page on the receiving device, type the six digits into the “Enter a pairing code” box and press “Connect”.",
          },
          {
            symptom: "Both of you are looking for a QR to scan and neither screen has one.",
            code: ["https://relayium.com/cross-network   # only the card that minted the code renders a QR"],
            fix: "The QR belongs to the device that created the code, so one of you has to create first and the other scans. Decide which side creates — either of you can send once both are in the room — press “Create a pairing code” there, and point the other device's camera at that screen.",
          },
          {
            symptom: "The link was forwarded through a chat app and the page opens with no code in it.",
            code: ["https://relayium.com/cross-network#c=483920   # everything after #c= is the code"],
            fix: "The code travels in the URL fragment, and a link rewriter or preview service can drop everything after the #. Read the six digits out instead, or paste the link into the address bar yourself so nothing between you and the browser rewrites it.",
          },
          {
            symptom: "The scan joins the room and then the card says relay is only issued to verified accounts.",
            code: ["https://relayium.com/cross-network   # the pairing card names the reason it was refused"],
            fix: "The sending account's email address is not verified yet, and that is checked when the session asks for a relay rather than when the code is minted. Verify the address from the account panel, then create a new pairing code and scan its QR — same-network transfers are unaffected by this.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the person scanning the QR need a Relayium account?",
        a: "No. Only the side creating the pairing code and its QR signs in — the same requirement an async download link carries. Whoever scans just joins the room that was already created: no account, no sign-up, nothing to install.",
      },
      {
        q: "What does the QR code actually contain?",
        a: "The same join link the \"copy link\" button copies — a relayium.com URL with the pairing code baked in. Scanning it just opens that link in the browser, which joins the room automatically. Joining is where it stops: no file is picked and none is sent, and whatever is sent afterwards still has to be accepted on the receiving device.",
      },
      {
        q: "Is scanning the QR as secure as typing the code?",
        a: "Yes, it's the identical connection either way. Both devices still negotiate an X25519 key exchange, encrypt with AES-256-GCM, and — if advanced verification is on — show a matching SAS verification code you can check before trusting the transfer. The QR only changes how you get into the room, not how the transfer is secured.",
      },
      {
        q: "What if the QR won't scan?",
        a: "Nothing is lost — the same pairing card shows the raw code and a copyable link, and a share-sheet button on supported devices. Any of them opens the same room as the QR.",
      },
      {
        q: "Does this work across different networks, like phone data to home Wi-Fi?",
        a: "Yes. This is the cross-network pairing flow, so it works whether both devices share a network or not. A pairing code always connects the two through an encrypted TURN relay — the route that does not depend on finding a way through the NATs and firewalls between the networks, which can prevent a direct connection — and that relay only ever carries ciphertext. Connecting directly is what devices on the same network do when they find each other without a code.",
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
    "如何用 Relayium 扫二维码传文件：先创建配对码，再扫描出现的二维码，传输全程端到端加密——扫码那一方不用装 App，也不用账号。",
  updatedLabel: "最近更新",
  lead: [
    "输入六位数字的配对码很快，但扫码更快——手机摄像头对准屏幕一扫，往往比你把码打完还快。Relayium 的配对流程会在每个配对码旁边同时显示一个二维码，就是为了这个。",
    "这是跨网络流程：无论两台设备是不是同一个 Wi-Fi，甚至身处地球两端，都能用。二维码只是这个流程的一条捷径——如果扫码不方便，下面的配对码和链接同样能用，效果完全一样。",
  ],
  sections: [
    {
      heading: "创建配对码，就会拿到二维码",
      prereqs: {
        label: "开始之前",
        items: [
          "只有发送方设备需要已登录账号。生成配对码需要账号——创建异步下载链接同样需要——而扫码的那一方全程不用登录。",
          "该账号的邮箱已验证，因为跨网络会话的中继只发给已验证的账号，被拒时配对卡片会明确写出来。",
          "接收方设备上有摄像头或任意二维码扫描工具，而且两个人同时在场——配对码有效期 5 分钟。",
          "先说好由谁来创建：二维码只会显示在创建配对码的那台设备上，所以扫码的是另一台。这只决定了谁加入谁的房间，并不决定两台都进来之后文件能往哪个方向传。",
        ],
      },
      body: [
        "在发送端设备上打开 relayium.com 并登录——创建配对码需要账号，因为这个码得归属于某个人；创建异步下载链接也是同样的道理。真正不需要账号的是「加入」这一侧：扫码的那个人自始至终都不用登录。选一个文件、一个文件夹，或者先不排队文件直接连接。",
        "Relayium 会生成一段简短的配对码——六位十进制数字，所以手机可以直接弹出数字键盘，念出来也不用逐个拼字母——并紧挨着它渲染出一个二维码。配对码有效期五分钟，过期后重新生成一个即可。二维码本身并没有编码什么新东西——它就是「复制链接」按钮给你的那条加入链接，只是渲染成了可扫描的方块而不是文字。谁打开那条链接，谁就会直接进入你的配对房间。",
      ],
    },
    {
      heading: "扫一下——不用装 App，不用账号",
      body: [
        "在另一台设备上打开相机 App（或任何二维码扫描工具），对准屏幕。点一下弹出的通知，会在浏览器里打开那条链接，并自动加入房间——扫码那一方不用打字，不用注册 relayium.com 账号，也没有任何东西要安装。扫码只做「加入」这一件事，它不会搬动任何文件：送过来的一批文件仍然会停在接收端的屏幕上，等人按下「接收」。",
        "如果手边没有摄像头，同一条链接粘贴到任意浏览器里也能用，那六位数字的配对码打进 relayium.com 的「输入配对码」框里也一样能用。二维码只是叠加在两者之上的一层便利，不是另一套机制——哪个方便用哪个。",
      ],
      steps: [
        {
          text: "在发送方设备上打开实时传输页面并登录。",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "生成配对码。卡片上会显示这六位数字、下方的二维码方块，以及一个倒计时。",
          code: ["你的配对码 —— 念给对方\n483920\n或让对方扫码 / 打开链接加入\n配对码 4:52 后失效"],
        },
        {
          text: "在另一台设备上打开相机 App 或任意二维码扫描工具，对准那个方块，点一下它给出的链接通知。",
        },
        {
          text: "链接会在浏览器里打开并自动加入房间——不用打字，这一侧也不需要账号。它和「复制链接」按钮放进剪贴板的是同一个地址。",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "回到发送方设备：如果创建配对码之前还没排上文件，现在选好要发送的文件。在接收方按下「接收」之前什么都不会开始，所以请在那一侧回应这个提示，然后让两个标签页都开着，直到文件计数走完。",
        },
      ],
      success: {
        label: "扫码成功时是什么样",
        body: [
          "发送方设备上，二维码和那行「等待对方加入…」会让位给已连接的卡片，卡片上的路径标签显示「中继」——这正是配对码会话的预期值，它刻意走加密的 TURN 中继。",
          "随后两块屏幕上的文件计数都会走到最后一个文件。传输本身和手工输码没有任何差别：扫码只是决定了第二台设备用什么方式进的房间。",
        ],
        code: ["中继\n文件 1/1"],
      },
    },
    {
      heading: "扫码之后发生了什么",
      body: [
        "扫码只是让两台设备进到同一个房间；传输本身和其他任何配对码会话完全一样。创建配对码的一方拥有这个房间，扫码的一方加入进来——但这说的是「谁加入谁」，不是方向：两台都进来之后，哪一侧都可以当发送方，而每一批送过来的文件仍然要在接收端按「接收」才会开始。这个房间也是一套更早的、独立的界面：配对码把你们放进一个单独的两台设备房间，而不是同网络设备打开的那个共享工作区，并且按设计只走中继。两边浏览器用 X25519 密钥交换协商出共享密钥，用 AES-256-GCM 对每个数据块加密，再把这些数据块通过架在 TURN 中继上的 WebRTC 通道发出去。",
        "打开「高级验证」（默认关闭）后，两块屏幕会显示同一段六位数字校验码（SAS）——扫一眼两边，确认一致后再信任这条连接。校验码一致能确认密钥未被替换：服务器或中继没有冒充任一端，也没有终止应用层端到端加密。配对码传输一律走这条中继路径，而不是先去试直连，因此它不依赖在两个网络之间的 NAT 和防火墙里探测出一条直连路径——它们可能挡住这样的路径。中继只转发密文——它没有密钥，永远看不到你的文件内容。每个文件都会用 SHA-256 哈希做端到端完整性校验，中途断开也能续传而不必重来。",
      ],
    },
    {
      heading: "扫码失败怎么办",
      body: [
        "摄像头没对好焦、光线不好，或者某台设备手边没有摄像头——这些都不该挡住传输。发送端的配对卡片同时也提供原始配对码和链接的复制按钮（支持的设备上还有系统分享按钮），以及配对码的失效倒计时。",
        "重新输一遍码、粘贴链接，或者用系统分享把它发到别的地方（聊天软件、隔空传送，怎么快怎么来）——每条路径都会进到同一个房间，得到同样加密的连接。二维码只是众多入口之一，从来不是必需品。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "扫码打开了页面，但提示配对码无效或已过期。",
            code: ["https://relayium.com/cross-network   # 发送方卡片上有实时倒计时"],
            fix: "5 分钟已经走完了，而一个失效配对码的二维码扫多少次都还是失效的链接。请在发送方设备上重新生成一个配对码——卡片会随之画出新的二维码——然后立刻扫这一个。",
          },
          {
            symptom: "相机认出了那个方块，却始终不给出任何可以打开的东西。",
            code: ["https://relayium.com/cross-network   # 「输入配对码」框接受这六位数字"],
            fix: "有些扫描工具只把文本复制下来，而不会交给浏览器。把它复制到的内容粘贴进地址栏；或者干脆不用二维码：在接收方设备上打开页面，把六位数字打进「输入配对码」框，然后按「连接」。",
          },
          {
            symptom: "两个人都在找二维码想扫，可是两块屏幕上都没有。",
            code: ["https://relayium.com/cross-network   # 只有生成配对码的那张卡片才会画二维码"],
            fix: "二维码属于创建配对码的那台设备，所以必须有一方先创建、另一方来扫。先定好哪一侧创建——两台都进房间之后，谁都可以发送——在那台设备上按「生成配对码」，再把另一台设备的摄像头对准那块屏幕。",
          },
          {
            symptom: "链接经过聊天软件转发后，打开的页面里没有配对码。",
            code: ["https://relayium.com/cross-network#c=483920   # #c= 之后的部分就是配对码"],
            fix: "配对码是放在 URL 片段里传的，而链接改写器或预览服务可能会把 # 之后的部分整个丢掉。请改成把六位数字念给对方，或者自己把链接粘进地址栏，这样中间就没有人再改写它。",
          },
          {
            symptom: "扫码已经进了房间，随后卡片提示中继只发给已验证的账号。",
            code: ["https://relayium.com/cross-network   # 配对卡片会写明被拒的原因"],
            fix: "发送账号的邮箱地址还没有验证，而这项检查发生在会话申请中继时，而不是生成配对码时。请在账户面板里完成邮箱验证，然后重新生成配对码并扫它的二维码——同网络传输不受此影响。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "扫二维码的一方需要 Relayium 账号吗？",
        a: "不需要。只有创建配对码和它二维码的那一侧需要登录——异步下载链接也是同样的要求。扫码的一方只是加入一个已经建好的房间：不用账号，不用注册，也没有任何东西要安装。",
      },
      {
        q: "二维码里到底存的是什么？",
        a: "和「复制链接」按钮复制出来的那条加入链接一模一样——一个内嵌了配对码的 relayium.com 网址。扫一下，就是在浏览器里打开那条链接，然后自动加入房间。到这里就结束了：它不会替你挑文件，也不会发送任何东西；之后发过去的内容，仍然要在接收设备上确认接收。",
      },
      {
        q: "扫二维码和手动输码一样安全吗？",
        a: "一样，两种方式建立的是完全相同的连接。都会协商 X25519 密钥交换、用 AES-256-GCM 加密，并在打开高级验证时显示一致的 SAS 校验码，供你确认后再信任传输。二维码只改变了你进入房间的方式，不改变传输的安全机制。",
      },
      {
        q: "如果二维码扫不出来怎么办？",
        a: "不会有任何损失——同一张配对卡片上也有原始配对码和可复制的链接，支持的设备上还有系统分享按钮。用哪一个都能进到二维码指向的同一个房间。",
      },
      {
        q: "跨网络也能用吗，比如手机用移动数据、电脑连家里 Wi-Fi？",
        a: "可以。这本来就是跨网络配对流程，所以无论两台设备是否同一网络都能用。配对码总是通过加密的 TURN 中继把两端连起来——这条路不依赖在两个网络之间的 NAT 和防火墙里找出一条通路，而它们可能挡住直连——而中继只经手密文。真正直连的是同一网络下无需配对码、自动发现彼此的那种情况。",
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
    "Relayium で QR コードをスキャンしてファイルを送る方法。ペアリングコードを作成し、表示された QR をスキャンするだけで、全区間エンドツーエンド暗号化された転送が始まります。スキャンする側はアプリもアカウントも不要です。",
  updatedLabel: "最終更新",
  lead: [
    "6 桁の数字コードを入力するのも速いですが、スキャンならさらに速いです。スマホのカメラを画面に向けるだけで、コードを入力し終える前に転送の準備が整います。Relayium のペアリング画面がペアリングコードと並べて QR コードを表示するのは、まさにこのためです。",
    "これはネットワークをまたぐ転送方式で、同じ Wi-Fi でも、地球の反対側同士でも動作します。QR コードはこの方式への近道にすぎません。スキャンが不便なら、その下にあるコードやリンクもまったく同じように使えます。",
  ],
  sections: [
    {
      heading: "コードを作ると QR も表示される",
      prereqs: {
        label: "始める前に",
        items: [
          "サインイン済みのアカウントが必要なのは送信側の端末だけです。ペアリングコードの作成にはアカウントが要り、非同期のダウンロードリンクの作成にも同じく必要です。スキャンする側は最後までサインインしません。",
          "そのアカウントのメールアドレスが確認済みであること。ネットワークをまたぐセッションのリレーは確認済みアカウントにのみ発行され、断られた場合はペアリングカードにそう表示されます。",
          "受信側の端末にカメラか任意の QR スキャナーがあり、2人が同時にその場にいること。コードの寿命は5分です。",
          "どちらがコードを作るかを先に決めておくこと。QR はコードを作成した端末にだけ描画されるので、もう一方がスキャンする側になります。これで決まるのは誰が誰のルームに入るかであって、2台が入ったあとファイルがどちら向きに流れるかではありません。",
        ],
      },
      body: [
        "送信側の端末で relayium.com を開いてサインインします。ペアリングコードの作成にはアカウントが必要です。コードは誰かに帰属している必要があるからで、非同期のダウンロードリンクの作成も同じ理由でアカウントを求めます。アカウントがいらないのは参加する側で、スキャンする人は最後までサインアウトのままです。ファイル、フォルダを選ぶか、ファイルなしでまず接続だけ済ませることもできます。",
        "Relayium は短いペアリングコードを発行し、その隣に QR コードを描画します。コードは 6 桁の十進数字なので、スマホは数字キーパッドを出せますし、読み上げるときに一字ずつ綴る必要もありません。有効期間は 5 分で、切れたら新しいものを発行し直します。QR コードは何か新しい情報を含んでいるわけではなく、「リンクをコピー」ボタンで得られるのと同じ参加リンクを、テキストではなくスキャン可能な四角形として表示しているだけです。そのリンクを開いた人は、そのままペアリングルームに入ります。",
      ],
    },
    {
      heading: "スキャンするだけ、アプリもアカウントも不要",
      body: [
        "もう一方の端末でカメラアプリ（または任意の QR スキャナー）を開き、画面に向けます。表示された通知をタップするとブラウザでリンクが開き、自動的にルームに参加します。スキャンする側は入力も relayium.com のアカウントも不要で、インストールするものも何もありません。スキャンがするのは参加だけで、ファイルは動きません。届いたファイルの一式は、受信側の画面で誰かが「受信」を押すまで待ったままです。",
        "カメラが使えない場合も、同じリンクを任意のブラウザに貼り付ければ使えますし、6 桁の数字コードを relayium.com の「コードを入力」欄に打ち込んでも同様に使えます。QR コードはこの両方の上に重ねられた利便性にすぎず、別の仕組みではありません。その場でやりやすい方を選んでください。",
      ],
      steps: [
        {
          text: "送信側の端末でリアルタイム転送のページを開き、サインインします。",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "ペアリングコードを作成します。カードには 6 桁の数字、その下の QR の四角、そしてカウントダウンが表示されます。",
          code: ["ペアリングコード — 相手に伝えてください\n483920\nまたは相手にQRを読み取ってもらう / リンクを開いて参加\nペアリングコードは 4:52 で失効"],
        },
        {
          text: "もう一方の端末でカメラアプリか任意の QR スキャナーを開き、その四角に向けて、表示されたリンクの通知をタップします。",
        },
        {
          text: "リンクがブラウザで開き、そのままルームに参加します。入力は不要で、こちら側にアカウントもいりません。これは「リンクをコピー」ボタンがクリップボードに入れるのと同じアドレスです。",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "送信側の端末に戻り、コード作成前にファイルを積んでいなければここで送るファイルを選びます。受信側が「受信」を押すまで何も動かないので、その端末でその案内に応えてから、ファイルカウンターが終わるまで両方のタブを開いたままにします。",
        },
      ],
      success: {
        label: "スキャンが成功したときの画面",
        body: [
          "送信側の端末では、QR と「相手の参加を待っています…」の行が接続済みのカードに置き換わり、その経路バッジは「中継」と表示されます。これは暗号化された TURN リレーを設計上通るペアリングコードのセッションにとって期待どおりの値です。",
          "その後、両方の画面でファイルカウンターが最後のファイルまで進みます。転送そのものは手入力のコードと何も変わりません。スキャンが決めたのは、2台目がどうやってルームに入ったかだけです。",
        ],
        code: ["中継\nファイル 1/1"],
      },
    },
    {
      heading: "スキャン後に起きること",
      body: [
        "スキャンは2台の端末を同じルームに入れるだけで、転送そのものは他のペアリングコードのセッションと変わりません。コードを作った側がルームの持ち主で、スキャンした側が参加者ですが、それは待ち合わせの話であって向きの話ではありません。2台が入ってしまえば送る側はどちらでもよく、届くファイルの一式は受信側の画面の「受信」で必ずゲートされます。このルーム自体も、より古い独立した画面です。ペアリングコードは、同一ネットワークの端末が開く共有ワークスペースではなく2台だけの別のルームに入れるもので、設計上リレー経由のみです。両端末は X25519 鍵交換で共有鍵を導出し、各チャンクを AES-256-GCM で暗号化したうえで、TURN リレー上に張られた WebRTC チャネルで送り出します。",
        "「高度な検証」（既定はオフ）をオンにすると、両方の画面に同じ6桁の検証コード（SAS）が表示されるので、両方を見比べて一致を確認してから接続を信頼してください。一致すれば鍵が差し替えられておらず、サーバーやリレーがどちらかの端末になりすましたり、アプリケーション層のエンドツーエンド暗号化を終端したりしていないことを確認できます。ペアリングコードによる転送は、まず直接経路を探すのではなく必ずこのリレー経由で行われます。そのため、接続の成立は、2 つのネットワークの間にある NAT やファイアウォールを越える直接の経路を見つけられるかどうかに左右されません。NAT やファイアウォールが直接の経路を塞ぐこともあります。リレーが転送するのは暗号文だけで、鍵を持たないためファイルの中身を見ることはありません。各ファイルは SHA-256 ハッシュでエンドツーエンドに検証され、接続が切れても最初からではなく再開できます。",
      ],
    },
    {
      heading: "スキャンできないときは",
      body: [
        "カメラのピントが合わない、照明が悪い、あるいは片方の端末にそもそもカメラがない。そうした事情で転送が止まる必要はありません。送信側のペアリングカードには、生のコードとリンクをコピーするボタン（対応端末では共有シートのボタンも）に加えて、コードの失効までのカウントダウンも表示されます。",
        "コードを打ち直す、リンクを貼り付ける、あるいは共有シートで別の方法（チャットや AirDrop など、いちばん速いもの）で送る。どの経路をたどっても同じルームに入り、同じ暗号化された接続が得られます。QR コードは複数ある入口の一つにすぎず、必須ではありません。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "スキャンでページは開くが、ペアリングコードが無効か期限切れだと出る。",
            code: ["https://relayium.com/cross-network   # 送信側のカードに実時間のカウントダウンが出る"],
            fix: "5分が過ぎており、失効したコードの QR は何度読み取っても失効したリンクのままです。送信側の端末で新しいコードを作成すると、カードはそれに合わせて新しい QR を描画します。その QR をすぐに読み取ってください。",
          },
          {
            symptom: "カメラは四角を認識するのに、開くものを何も提示してこない。",
            code: ["https://relayium.com/cross-network   # 「ペアリングコードを入力」欄が 6 桁の数字を受け付ける"],
            fix: "スキャナーによってはテキストをコピーするだけで、ブラウザに渡しません。コピーされた内容をアドレス欄に貼り付けるか、QR を使わずに済ませてください。受信側の端末でページを開き、6 桁の数字を「ペアリングコードを入力」欄に打ち込んで「接続」を押します。",
          },
          {
            symptom: "2人とも読み取る QR を探しているのに、どちらの画面にもない。",
            code: ["https://relayium.com/cross-network   # QR を描画するのはコードを発行したカードだけ"],
            fix: "QR はコードを作成した端末のものなので、片方が先に作成し、もう片方が読み取る必要があります。どちらが作成するかを決め（2台がルームに入れば、送るのはどちらでもかまいません）、その端末で「ペアリングコードを生成」を押し、もう一方の端末のカメラをその画面に向けてください。",
          },
          {
            symptom: "チャットアプリ経由で転送されたリンクを開くと、ページにコードが入っていない。",
            code: ["https://relayium.com/cross-network#c=483920   # #c= の後ろがコードそのもの"],
            fix: "コードは URL のフラグメントで運ばれるため、リンク書き換えやプレビューのサービスが # 以降をまるごと落とすことがあります。代わりに 6 桁の数字を読み上げるか、リンクを自分でアドレス欄に貼り付けて、途中で書き換えられないようにしてください。",
          },
          {
            symptom: "スキャンでルームには入れたのに、リレーは確認済みアカウントにのみ発行されるとカードに出る。",
            code: ["https://relayium.com/cross-network   # ペアリングカードが拒否の理由を示す"],
            fix: "送信側アカウントのメールアドレスがまだ確認されていません。これはコード発行時ではなく、セッションがリレーを要求する時点で確認されます。アカウントパネルでアドレスを確認し、新しいペアリングコードを作成してその QR を読み取ってください。同一ネットワークの転送はこの影響を受けません。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "QR コードをスキャンする側にも Relayium のアカウントが必要ですか？",
        a: "いいえ。サインインが必要なのはペアリングコードとその QR コードを作成する側だけで、非同期のダウンロードリンクにも同じ条件が付きます。スキャンする側はすでに作られたルームに参加するだけで、アカウントもサインアップも、インストールするものも何もありません。",
      },
      {
        q: "QR コードには実際には何が入っていますか？",
        a: "「リンクをコピー」ボタンでコピーされるのと同じ参加リンクです。ペアリングコードが埋め込まれた relayium.com の URL です。スキャンするとブラウザでそのリンクが開き、自動的にルームに参加します。参加はそこで終わりで、ファイルが選ばれることも送られることもありません。そのあとに送られるものも、受信側の端末で承認される必要があります。",
      },
      {
        q: "QR コードのスキャンはコードを入力するのと同じくらい安全ですか？",
        a: "はい、どちらの方法でも接続はまったく同一です。両端末は依然として X25519 鍵交換をネゴシエートし、AES-256-GCM で暗号化し、高度な検証がオンなら、転送を信頼する前に確認できる一致した SAS 検証コードも表示します。QR コードが変えるのはルームへの入り方だけで、転送の安全性は変わりません。",
      },
      {
        q: "QR コードがスキャンできない場合は？",
        a: "何も失われません。同じペアリングカードに生のコードとコピー可能なリンクが表示され、対応端末では共有シートのボタンもあります。どれを使っても QR コードと同じルームに入れます。",
      },
      {
        q: "スマホがモバイル通信、PC が自宅 Wi-Fi のように、異なるネットワーク間でも使えますか？",
        a: "はい。これはもともとネットワークをまたぐペアリング方式なので、2台が同じネットワークであってもなくても動作します。ペアリングコードでの接続は常に暗号化された TURN リレーを経由します。ネットワークの間にある NAT やファイアウォールを越える通り道を見つけられるかどうかに左右されない経路で（NAT やファイアウォールが直接接続を塞ぐこともあります）、リレーが運ぶのは暗号文だけです。直接つながるのは、コードなしで互いを見つけ合う同一ネットワークの場合です。",
      },
    ],
  },
  cta: {
    text: "Relayium を開いてコードを作成し、別の端末で QR コードのスキャンを試してみてください。スキャンする側はアプリもアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "QR 코드를 스캔해서 파일 전송하기",
  description:
    "Relayium에서 QR 코드를 스캔해 파일을 보내는 방법. 페어링 코드를 만들고 나타난 QR을 스캔하면 처음부터 끝까지 종단간 암호화된 전송이 시작됩니다. 스캔하는 쪽은 앱도 계정도 필요 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "여섯 자리 숫자 코드를 입력하는 것도 빠르지만, 스캔은 더 빠릅니다. 휴대폰 카메라를 화면에 대기만 하면 코드를 다 입력하기도 전에 전송 준비가 끝납니다. Relayium의 페어링 화면이 페어링 코드 옆에 QR 코드를 함께 보여주는 이유가 바로 이것입니다.",
    "이것은 네트워크를 넘나드는 방식이라, 두 기기가 같은 Wi-Fi에 있든 지구 반대편에 있든 동작합니다. QR 코드는 그 방식으로 들어가는 지름길일 뿐입니다 — 스캔이 불편하면 그 아래의 코드나 링크도 똑같이 작동합니다.",
  ],
  sections: [
    {
      heading: "코드를 만들면 QR도 함께 생깁니다",
      prereqs: {
        label: "시작하기 전에",
        items: [
          "로그인한 계정은 보내는 기기에만 필요합니다. 페어링 코드를 만들려면 계정이 있어야 하고, 비동기 다운로드 링크를 만들 때도 마찬가지입니다. 스캔하는 사람은 끝까지 로그인하지 않습니다.",
          "그 계정의 이메일 주소가 인증되어 있어야 합니다. 네트워크를 넘는 세션의 릴레이는 인증된 계정에만 발급되며, 거절될 때 페어링 카드가 그렇게 알려줍니다.",
          "받는 기기에 카메라나 아무 QR 스캐너가 있고, 두 사람이 같은 시간에 함께 있어야 합니다 — 코드는 5분 동안만 삽니다.",
          "누가 코드를 만들지 시작 전에 정해 두세요. QR은 코드를 만든 기기에만 그려지므로 스캔하는 쪽은 다른 기기입니다. 이것으로 정해지는 것은 누가 누구의 방에 들어가느냐일 뿐, 둘 다 들어온 뒤 파일이 어느 방향으로 갈 수 있느냐가 아닙니다.",
        ],
      },
      body: [
        "보내는 쪽 기기에서 relayium.com을 열고 로그인합니다 — 페어링 코드를 만들려면 계정이 필요한데, 코드는 누군가에게 귀속되어야 하기 때문이고, 비동기 다운로드 링크를 만들 때도 같은 이유로 계정이 필요합니다. 계정이 필요 없는 쪽은 참여하는 쪽이라, 스캔하는 사람은 끝까지 로그아웃 상태로 있습니다. 파일이나 폴더를 고르거나, 파일 없이 우선 연결만 시작할 수도 있습니다.",
        "Relayium은 짧은 페어링 코드를 발급하고 바로 옆에 QR 코드를 그립니다. 코드는 여섯 자리 십진 숫자라 휴대폰이 숫자 키패드를 띄울 수 있고, 소리 내어 읽을 때 철자를 부를 필요도 없습니다. 유효 시간은 5분이며, 지나면 새로 만들면 됩니다. QR 코드는 새로운 정보를 담고 있는 게 아니라, '링크 복사' 버튼으로 얻는 것과 같은 참여 링크를 텍스트 대신 스캔 가능한 사각형으로 표시할 뿐입니다. 그 링크를 여는 사람은 곧바로 페어링 방으로 들어갑니다.",
      ],
    },
    {
      heading: "스캔만 하면 됩니다 — 앱도 계정도 필요 없이",
      body: [
        "다른 기기에서 카메라 앱(또는 아무 QR 스캐너)을 열고 화면에 대세요. 뜨는 알림을 탭하면 브라우저에서 링크가 열리며 자동으로 방에 참여합니다 — 스캔하는 쪽은 입력할 것도, relayium.com 계정도 필요 없고, 설치할 것도 전혀 없습니다. 스캔이 하는 일은 참여뿐이고 파일을 옮기지는 않습니다. 들어온 파일 묶음은 받는 화면에서 누군가 “받기”를 누를 때까지 그대로 기다립니다.",
        "카메라를 쓰기 어렵다면 같은 링크를 아무 브라우저에 붙여 넣어도 되고, 여섯 자리 숫자 코드를 relayium.com의 '코드 입력' 칸에 쳐 넣어도 마찬가지로 작동합니다. QR 코드는 이 둘 위에 얹힌 편의 기능일 뿐, 별개의 메커니즘이 아닙니다 — 그때그때 편한 쪽을 고르세요.",
      ],
      steps: [
        {
          text: "보내는 기기에서 실시간 전송 페이지를 열고 로그인합니다.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "페어링 코드를 만듭니다. 그러면 카드에 여섯 자리 숫자, 그 아래 QR 사각형, 그리고 남은 시간이 표시됩니다.",
          code: ["내 페어링 코드 — 상대에게 알려주세요\n483920\n또는 상대가 QR을 스캔하거나 링크를 열어 참여\n페어링 코드는 4:52 후 만료"],
        },
        {
          text: "다른 기기에서 카메라 앱이나 아무 QR 스캐너를 열어 그 사각형에 대고, 떠오르는 링크 알림을 탭합니다.",
        },
        {
          text: "링크가 브라우저에서 열리며 알아서 방에 참여합니다 — 입력할 것도 없고 이쪽에는 계정도 없습니다. “링크 복사” 버튼이 클립보드에 넣는 것과 같은 주소입니다.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "보내는 기기로 돌아와, 코드를 만들기 전에 파일을 올려 두지 않았다면 지금 보낼 파일을 고릅니다. 받는 쪽에서 “받기”를 누르기 전에는 아무것도 움직이지 않으니 그 기기에서 안내에 답한 다음, 파일 카운터가 끝날 때까지 두 탭을 열어 두세요.",
        },
      ],
      success: {
        label: "스캔이 잘됐을 때의 화면",
        body: [
          "보내는 기기에서 QR과 “상대 기기의 참여를 기다리는 중…” 줄이 연결된 카드로 바뀌고, 그 경로 배지는 “릴레이”를 가리킵니다 — 설계상 암호화된 TURN 릴레이를 지나는 페어링 코드 세션에서는 그것이 예상된 값입니다.",
          "그다음 두 화면의 파일 카운터가 마지막 파일까지 갑니다. 전송 자체는 코드를 직접 입력했을 때와 아무 차이가 없습니다. 스캔은 두 번째 기기가 어떻게 방에 들어왔는지만 정했을 뿐입니다.",
        ],
        code: ["릴레이\n파일 1/1"],
      },
    },
    {
      heading: "스캔 후 일어나는 일",
      body: [
        "스캔은 두 기기를 같은 방에 넣어줄 뿐, 전송 자체는 다른 페어링 코드 세션과 다르지 않습니다. 코드를 만든 쪽이 방의 주인이고 스캔한 쪽이 참여자이지만, 그것은 만남에 대한 이야기이지 방향에 대한 이야기가 아닙니다. 둘 다 들어오고 나면 보내는 쪽은 어느 쪽이든 될 수 있고, 들어오는 파일 묶음은 여전히 받는 화면의 “받기”로 통제됩니다. 이 방 자체도 더 오래된 별도의 화면입니다. 페어링 코드는 같은 네트워크의 기기들이 여는 공유 작업 공간이 아니라 두 기기만의 별도 방으로 들여보내며, 설계상 릴레이만 사용합니다. 두 기기는 X25519 키 교환으로 공유 키를 도출하고 각 청크를 AES-256-GCM으로 암호화한 뒤, TURN 릴레이 위에 놓인 WebRTC 채널로 내보냅니다.",
        "고급 검증(기본값 꺼짐)을 켜면 두 화면 모두 같은 6자리 숫자 검증 코드(SAS)를 보여주므로, 둘 다 확인해 일치하는지 본 뒤에 연결을 신뢰하세요. 코드가 일치하면 키가 바뀌지 않았으며 서버나 릴레이가 어느 한쪽 끝점으로 위장하거나 애플리케이션 계층 종단간 암호화를 종료하지 않았음을 확인할 수 있습니다. 페어링 코드 전송은 직접 경로를 먼저 찾아보는 대신 언제나 이 릴레이를 거칩니다. 그래서 연결이 두 네트워크 사이의 NAT와 방화벽을 통과하는 직접 경로를 찾아내는 데 의존하지 않습니다. NAT나 방화벽이 그런 경로를 막을 수도 있습니다. 릴레이는 암호문만 전달하고 키를 갖지 않으므로 파일 내용은 절대 보지 못합니다. 각 파일은 SHA-256 해시로 종단간 검증되며, 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다.",
      ],
    },
    {
      heading: "스캔이 안 될 때는",
      body: [
        "카메라 초점이 안 맞거나, 조명이 나쁘거나, 한쪽 기기에 카메라가 마땅치 않을 수도 있습니다 — 그렇다고 전송이 막힐 필요는 없습니다. 보내는 쪽의 페어링 카드에는 원본 코드와 링크를 복사하는 버튼(지원 기기에서는 공유 시트 버튼도)과, 코드 만료까지의 카운트다운도 함께 표시됩니다.",
        "코드를 다시 입력하거나, 링크를 붙여 넣거나, 공유 시트로 다른 방법(채팅, 에어드롭 등 가장 빠른 것)으로 보내세요 — 어떤 경로든 같은 방으로 들어가서 똑같이 암호화된 연결을 얻습니다. QR 코드는 여러 입구 중 하나일 뿐, 필수가 아닙니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "스캔으로 페이지는 열리는데 페어링 코드가 잘못되었거나 만료되었다고 나옵니다.",
            code: ["https://relayium.com/cross-network   # 보내는 쪽 카드에 실시간 남은 시간이 보인다"],
            fix: "5분이 지났고, 죽은 코드의 QR은 몇 번을 스캔해도 죽은 링크입니다. 보내는 기기에서 새 코드를 만들면 카드가 그에 맞는 새 QR을 그려 주니, 그것을 곧바로 스캔하세요.",
          },
          {
            symptom: "카메라가 사각형은 알아보는데 열 수 있는 것을 아무것도 내놓지 않습니다.",
            code: ["https://relayium.com/cross-network   # “페어링 코드 입력” 칸이 여섯 자리 숫자를 받는다"],
            fix: "어떤 스캐너는 텍스트만 복사하고 브라우저에 넘기지 않습니다. 복사된 것을 주소창에 붙여 넣거나, QR을 아예 건너뛰세요. 받는 기기에서 페이지를 열고 여섯 자리 숫자를 “페어링 코드 입력” 칸에 친 다음 “연결”을 누르면 됩니다.",
          },
          {
            symptom: "두 사람 다 스캔할 QR을 찾는데 어느 화면에도 없습니다.",
            code: ["https://relayium.com/cross-network   # 코드를 만든 카드만 QR을 그린다"],
            fix: "QR은 코드를 만든 기기의 것이므로 한쪽이 먼저 만들고 다른 쪽이 스캔해야 합니다. 어느 쪽이 만들지 정하고 — 둘 다 방에 들어오면 보내는 쪽은 누구든 될 수 있습니다 — 그 기기에서 “페어링 코드 생성”을 누른 뒤, 다른 기기의 카메라를 그 화면에 대세요.",
          },
          {
            symptom: "링크를 채팅 앱으로 전달했더니 페이지에 코드가 없는 채로 열립니다.",
            code: ["https://relayium.com/cross-network#c=483920   # #c= 뒤가 곧 코드다"],
            fix: "코드는 URL 프래그먼트에 실려 가는데, 링크 재작성기나 미리보기 서비스가 # 뒤를 통째로 날릴 수 있습니다. 대신 여섯 자리 숫자를 불러 주거나, 링크를 직접 주소창에 붙여 넣어 중간에서 아무도 고쳐 쓰지 못하게 하세요.",
          },
          {
            symptom: "스캔으로 방에는 들어갔는데, 릴레이는 인증된 계정에만 발급된다고 카드에 나옵니다.",
            code: ["https://relayium.com/cross-network   # 페어링 카드가 거절 이유를 알려준다"],
            fix: "보내는 계정의 이메일 주소가 아직 인증되지 않았고, 이 확인은 코드를 만들 때가 아니라 세션이 릴레이를 요청하는 시점에 이루어집니다. 계정 패널에서 주소를 인증한 뒤 새 페어링 코드를 만들어 그 QR을 스캔하세요 — 같은 네트워크 전송은 이 영향을 받지 않습니다.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "QR 코드를 스캔하는 쪽도 Relayium 계정이 필요한가요?",
        a: "아니요. 로그인이 필요한 쪽은 페어링 코드와 그 QR을 만드는 쪽뿐이고, 비동기 다운로드 링크에도 같은 조건이 붙습니다. 스캔하는 쪽은 이미 만들어진 방에 참여할 뿐, 계정도 가입도, 설치할 것도 전혀 없습니다.",
      },
      {
        q: "QR 코드에는 실제로 무엇이 들어 있나요?",
        a: "'링크 복사' 버튼으로 복사되는 것과 같은 참여 링크입니다 — 페어링 코드가 담긴 relayium.com URL입니다. 스캔하면 브라우저에서 그 링크가 열리고 자동으로 방에 참여합니다. 거기까지가 전부입니다. 파일이 골라지지도 보내지지도 않고, 그 뒤에 보내는 것도 받는 기기에서 수락해야 합니다.",
      },
      {
        q: "QR 코드를 스캔하는 것이 코드를 입력하는 것만큼 안전한가요?",
        a: "네, 어느 쪽이든 연결은 동일합니다. 두 기기는 여전히 X25519 키 교환을 협상하고 AES-256-GCM으로 암호화하며, 고급 검증이 켜져 있으면 전송을 신뢰하기 전에 확인할 수 있는 일치하는 SAS 검증 코드도 보여줍니다. QR 코드는 방에 들어가는 방식만 바꿀 뿐, 전송의 보안 방식은 바뀌지 않습니다.",
      },
      {
        q: "QR 코드가 스캔되지 않으면 어떻게 하나요?",
        a: "아무것도 잃지 않습니다 — 같은 페어링 카드에 원본 코드와 복사 가능한 링크가 표시되고, 지원 기기에서는 공유 시트 버튼도 있습니다. 무엇을 쓰든 QR 코드와 같은 방으로 들어갑니다.",
      },
      {
        q: "휴대폰은 모바일 데이터, PC는 집 Wi-Fi처럼 서로 다른 네트워크에서도 되나요?",
        a: "네. 이것은 원래 네트워크를 넘나드는 페어링 방식이라, 두 기기가 같은 네트워크에 있든 아니든 동작합니다. 페어링 코드는 언제나 암호화된 TURN 릴레이를 통해 둘을 연결합니다 — 네트워크 사이의 NAT와 방화벽을 통과하는 길을 찾아내는 데 의존하지 않는 경로이고(NAT나 방화벽이 직접 연결을 막을 수도 있습니다), 릴레이가 나르는 것은 암호문뿐입니다. 직접 연결되는 쪽은 코드 없이 서로를 찾아내는 같은 네트워크의 기기들입니다.",
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
    "Dateien per QR-Code-Scan senden: Der QR gehört zu einem Pairing-Code, die Übertragung ist durchgehend Ende-zu-Ende-verschlüsselt. Keine App, kein Konto für die scannende Person.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Einen sechsstelligen Zifferncode einzutippen geht schnell, doch Scannen geht noch schneller — die Handykamera aufs Display richten, und die Übertragung steht, bevor man den Code fertig eingetippt hätte. Genau deshalb zeigt Relayiums Pairing-Ansicht neben jedem Pairing-Code auch einen QR-Code an.",
    "Das ist der netzwerkübergreifende Ablauf: Er funktioniert, egal ob beide Geräte im selben WLAN oder auf entgegengesetzten Seiten der Welt sind. Der QR-Code ist nur eine Abkürzung in diesen Ablauf hinein — der Code und der Link darunter funktionieren genauso, wenn Scannen gerade unpraktisch ist.",
  ],
  sections: [
    {
      heading: "Code erstellen, QR erhalten",
      prereqs: {
        label: "Bevor du anfängst",
        items: [
          "Ein angemeldetes Konto nur auf dem sendenden Gerät. Einen Pairing-Code zu erstellen verlangt eines — einen asynchronen Download-Link zu erstellen ebenso —, und wer scannt, meldet sich nie an.",
          "Eine bestätigte E-Mail-Adresse auf diesem Konto, denn ein Relay für eine netzübergreifende Sitzung geht nur an bestätigte Konten, und die Pairing-Karte sagt das, wenn sie es verweigert.",
          "Eine Kamera oder ein beliebiger QR-Scanner auf dem empfangenden Gerät, und ihr beide gleichzeitig anwesend — der Code lebt fünf Minuten.",
          "Eine Absprache, wer den Code erstellt: Der QR-Code wird nur auf diesem Gerät gezeichnet, das andere ist also das scannende. Das legt fest, wer wem beitritt, nicht in welche Richtung Dateien laufen können, sobald beide im Raum sind.",
        ],
      },
      body: [
        "Öffne auf dem sendenden Gerät relayium.com und melde dich an — das Erstellen eines Pairing-Codes verlangt ein Konto, weil der Code jemandem gehören muss, und für einen asynchronen Download-Link gilt aus demselben Grund dasselbe. Ohne Konto geht das Beitreten: Wer scannt, bleibt durchgehend abgemeldet. Wähle eine Datei, einen Ordner oder verbinde dich zunächst ganz ohne eingereihte Dateien.",
        "Relayium erzeugt einen kurzen Pairing-Code — sechs Dezimalziffern, damit ein Handy seine Zifferntastatur anbieten kann und der Code vorgelesen werden kann, ohne etwas zu buchstabieren — und rendert direkt daneben einen QR-Code. Der Code gilt fünf Minuten; danach erzeugst du einfach einen neuen. Der QR-Code kodiert nichts Neues — es ist derselbe Beitrittslink, den auch der Button „Link kopieren“ liefert, nur als scanbares Quadrat statt als Text dargestellt. Wer diesen Link öffnet, landet direkt in deinem Pairing-Raum.",
      ],
    },
    {
      heading: "Einfach scannen — keine App, kein Konto",
      body: [
        "Öffne auf dem anderen Gerät die Kamera-App (oder einen beliebigen QR-Scanner) und richte sie aufs Display. Ein Tipp auf die erscheinende Benachrichtigung öffnet den Link im Browser, der automatisch dem Raum beitritt — die scannende Person braucht nichts einzutippen, kein relayium.com-Konto und nichts zu installieren. Mehr als Beitreten tut ein Scan nicht; er bewegt keine Dateien. Ein eingehender Stapel wartet weiterhin auf dem empfangenden Bildschirm, bis dort jemand „Annehmen“ drückt.",
        "Ist gerade keine Kamera griffbereit, funktioniert derselbe Link ebenso, in einen beliebigen Browser eingefügt, und der sechsstellige Zifferncode funktioniert genauso, in das Feld „Code eingeben“ auf relayium.com getippt. Der QR-Code ist eine Annehmlichkeit obendrauf, kein eigener Mechanismus — nimm, was gerade am einfachsten ist.",
      ],
      steps: [
        {
          text: "Öffne auf dem sendenden Gerät die Seite für Echtzeitübertragung und melde dich an.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Erstelle den Pairing-Code. Die Karte zeigt danach die sechs Ziffern, darunter das QR-Quadrat und einen Countdown.",
          code: ["Dein Pairing-Code — sag ihn der anderen Person\n483920\noder die andere Person scannt den QR / öffnet den Link\nPairing-Code läuft in 4:52 ab"],
        },
        {
          text: "Öffne auf dem anderen Gerät die Kamera-App oder einen beliebigen QR-Scanner, richte sie auf dieses Quadrat und tippe auf die Link-Benachrichtigung, die dabei erscheint.",
        },
        {
          text: "Der Link öffnet sich im Browser und tritt dem Raum von selbst bei — nichts einzutippen, und auf dieser Seite kein Konto. Es ist dieselbe Adresse, die der Knopf „Link kopieren“ in die Zwischenablage legt.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "Zurück auf dem sendenden Gerät: Wähle die Dateien, falls du vor dem Erstellen des Codes keine eingereiht hast. Nichts bewegt sich, bis die Empfangsseite „Annehmen“ drückt — beantworte die Abfrage also dort und lass dann beide Tabs offen, bis der Dateizähler durch ist.",
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Scan aus",
        body: [
          "Auf dem sendenden Gerät weichen der QR-Code und die Zeile „Warte darauf, dass das andere Gerät beitritt…“ der verbundenen Karte, und deren Pfad-Abzeichen zeigt „Über Relay“ — der erwartete Wert für eine Pairing-Code-Sitzung, die von Grund auf über das verschlüsselte TURN-Relay läuft.",
          "Danach läuft der Dateizähler auf beiden Bildschirmen bis zur letzten Datei. An der Übertragung selbst ändert sich gegenüber einem eingetippten Code nichts: Das Scannen hat nur entschieden, wie das zweite Gerät in den Raum kam.",
        ],
        code: ["Über Relay\nDatei 1/1"],
      },
    },
    {
      heading: "Was nach dem Scannen passiert",
      body: [
        "Scannen bringt die beiden Geräte lediglich in denselben Raum; die Übertragung selbst unterscheidet sich nicht von jeder anderen Pairing-Code-Sitzung. Wer den Code erstellt hat, dem gehört der Raum, und wer gescannt hat, ist beigetreten — das ist eine Aussage über das Treffen, nicht über die Richtung: Sind beide drin, kann jede Seite die sendende sein, und jeder eingehende Stapel bleibt durch „Annehmen“ auf dem empfangenden Bildschirm abgesichert. Auch der Raum selbst ist eine eigene, ältere Oberfläche: Ein Pairing-Code setzt euch in einen separaten Raum für zwei Geräte statt in den gemeinsamen Arbeitsbereich, den Geräte im selben Netz öffnen, und er läuft von Grund auf nur über Relay. Die beiden Browser leiten mit einem X25519-Schlüsselaustausch einen gemeinsamen Schlüssel ab, verschlüsseln jeden Block mit AES-256-GCM und schicken ihn über einen WebRTC-Kanal, der auf einem TURN-Relay aufsetzt.",
        "Mit eingeschalteter erweiterter Verifizierung (standardmäßig aus) zeigen beide Bildschirme denselben sechsstelligen Verifizierungscode (SAS) — vergleiche beide und bestätige die Übereinstimmung, bevor du der Verbindung vertraust. Eine Übereinstimmung bestätigt, dass die Schlüssel nicht ausgetauscht wurden: Ein Server oder Relay hat sich weder als einer der Endpunkte ausgegeben noch die Ende-zu-Ende-Verschlüsselung der Anwendungsschicht beendet. Eine Übertragung per Pairing-Code nimmt immer diesen Relay-Weg, statt zuerst nach einem direkten Pfad zu suchen, und hängt damit nicht davon ab, einen direkten Pfad durch die NATs und Firewalls zwischen den beiden Netzwerken zu finden — die einen solchen Pfad verhindern können. Das Relay leitet ausschließlich Chiffretext weiter — es besitzt keinen Schlüssel und sieht deine Dateien nie. Jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, und eine unterbrochene Verbindung kann fortgesetzt statt neu gestartet werden.",
      ],
    },
    {
      heading: "Wenn das Scannen nicht klappt",
      body: [
        "Die Kamera fokussiert nicht, das Licht ist schlecht, oder ein Gerät hat gerade keine Kamera griffbereit — nichts davon sollte die Übertragung aufhalten. Die Pairing-Karte auf dem sendenden Gerät zeigt zusätzlich Kopier-Buttons für den rohen Code und den Link (sowie einen Teilen-Button auf unterstützten Geräten) sowie einen Countdown bis zum Ablauf des Codes.",
        "Tippe den Code neu ein, füge den Link ein, oder verschicke ihn über die Teilen-Funktion auf einem anderen Weg (Chat, AirDrop, was auch immer gerade am schnellsten ist) — jeder Weg führt in denselben Raum und ergibt dieselbe verschlüsselte Verbindung. Der QR-Code ist einer von mehreren Einstiegspunkten, nie eine Voraussetzung.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Der Scan öffnet die Seite, und dort steht, der Pairing-Code sei ungültig oder abgelaufen.",
            code: ["https://relayium.com/cross-network   # die Karte des Senders zeigt den laufenden Countdown"],
            fix: "Die fünf Minuten sind abgelaufen, und der QR-Code eines toten Codes bleibt ein toter Link, so oft man ihn auch scannt. Erstelle auf dem sendenden Gerät einen frischen Code — die Karte zeichnet dazu einen neuen QR — und scanne gleich diesen.",
          },
          {
            symptom: "Die Kamera erkennt das Quadrat, bietet aber nie etwas zum Öffnen an.",
            code: ["https://relayium.com/cross-network   # das Feld „Pairing-Code eingeben“ nimmt die sechs Ziffern"],
            fix: "Manche Scanner kopieren den Text nur, statt ihn an einen Browser zu geben. Füge das Kopierte in die Adresszeile ein, oder lass den QR ganz weg: Öffne die Seite auf dem empfangenden Gerät, tippe die sechs Ziffern in das Feld „Pairing-Code eingeben“ und drücke „Verbinden“.",
          },
          {
            symptom: "Ihr sucht beide nach einem QR zum Scannen, und auf keinem Bildschirm ist einer.",
            code: ["https://relayium.com/cross-network   # nur die Karte, die den Code erzeugt hat, zeichnet einen QR"],
            fix: "Der QR gehört dem Gerät, das den Code erstellt hat, also muss eine Seite erst erstellen und die andere scannen. Entscheidet, wer erstellt — senden kann danach jede von euch beiden, sobald ihr im selben Raum seid —, drückt dort „Pairing-Code erstellen“ und richtet die Kamera des anderen Geräts auf diesen Bildschirm.",
          },
          {
            symptom: "Der Link wurde über eine Chat-App weitergeleitet, und die Seite öffnet sich ohne Code darin.",
            code: ["https://relayium.com/cross-network#c=483920   # alles nach #c= ist der Code"],
            fix: "Der Code reist im URL-Fragment, und ein Link-Umschreiber oder Vorschaudienst kann alles nach dem # verwerfen. Lies stattdessen die sechs Ziffern vor, oder füge den Link selbst in die Adresszeile ein, damit zwischen dir und dem Browser nichts daran herumschreibt.",
          },
          {
            symptom: "Der Scan tritt dem Raum bei, und dann sagt die Karte, ein Relay gehe nur an bestätigte Konten.",
            code: ["https://relayium.com/cross-network   # die Pairing-Karte nennt den Grund der Absage"],
            fix: "Die E-Mail-Adresse des sendenden Kontos ist noch nicht bestätigt, und geprüft wird das, wenn die Sitzung ein Relay anfordert, nicht beim Erzeugen des Codes. Bestätige die Adresse im Kontobereich, erstelle dann einen neuen Pairing-Code und scanne dessen QR — Übertragungen im selben Netz sind davon unberührt.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Braucht die scannende Person ein Relayium-Konto?",
        a: "Nein. Anmelden muss sich nur die Seite, die den Pairing-Code und dessen QR erstellt — dieselbe Anforderung trägt auch ein asynchroner Download-Link. Wer scannt, tritt lediglich dem bereits erstellten Raum bei: kein Konto, keine Anmeldung, nichts zu installieren.",
      },
      {
        q: "Was steckt eigentlich im QR-Code?",
        a: "Derselbe Beitrittslink, den auch der Button „Link kopieren“ liefert — eine relayium.com-URL mit dem eingebetteten Pairing-Code. Scannen öffnet einfach diesen Link im Browser, der automatisch dem Raum beitritt. Dabei bleibt es auch: Es wird keine Datei ausgewählt und keine gesendet, und was danach gesendet wird, muss auf dem empfangenden Gerät weiterhin angenommen werden.",
      },
      {
        q: "Ist das Scannen des QR-Codes genauso sicher wie das Eintippen des Codes?",
        a: "Ja, die Verbindung ist in beiden Fällen identisch. Beide Geräte handeln weiterhin einen X25519-Schlüsselaustausch aus, verschlüsseln mit AES-256-GCM und zeigen bei eingeschalteter erweiterter Verifizierung einen übereinstimmenden SAS-Verifizierungscode, den du vor dem Vertrauen kontrollieren kannst. Der QR-Code ändert nur, wie du in den Raum kommst, nicht wie die Übertragung abgesichert ist.",
      },
      {
        q: "Was, wenn sich der QR-Code nicht scannen lässt?",
        a: "Nichts geht verloren — dieselbe Pairing-Karte zeigt den rohen Code und einen kopierbaren Link, auf unterstützten Geräten zusätzlich einen Teilen-Button. Jeder davon führt in denselben Raum wie der QR-Code.",
      },
      {
        q: "Funktioniert das auch über unterschiedliche Netzwerke hinweg, etwa Handy mit Mobilfunk und PC im heimischen WLAN?",
        a: "Ja. Das ist von Grund auf der netzwerkübergreifende Pairing-Ablauf, er funktioniert also unabhängig davon, ob beide Geräte im selben Netz sind. Ein Pairing-Code verbindet die beiden immer über ein verschlüsseltes TURN-Relay — der Weg, der nicht davon abhängt, einen Durchgang durch die NATs und Firewalls zwischen den Netzen zu finden, die eine direkte Verbindung verhindern können —, und dieses Relay trägt ausschließlich Chiffretext. Direkt verbinden sich Geräte im selben Netz, die sich ganz ohne Code finden.",
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
    "Envoyez des fichiers en scannant un code QR lié à un code d'appairage : transfert chiffré de bout en bout sur tout le trajet. Sans appli ni compte pour la personne qui scanne.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Taper un code de six chiffres est rapide, mais scanner l'est encore plus : pointez la caméra du téléphone vers l'écran, et le transfert est prêt avant même d'avoir fini de taper le code. C'est exactement pour cela que l'écran d'appairage de Relayium affiche un code QR juste à côté de chaque code d'appairage.",
    "C'est le mode d'appairage entre réseaux différents : il fonctionne que les deux appareils soient sur le même Wi-Fi ou aux antipodes l'un de l'autre. Le code QR n'est qu'un raccourci vers ce mode — le code et le lien qu'il contient fonctionnent exactement de la même façon si scanner n'est pas pratique.",
  ],
  sections: [
    {
      heading: "Créez un code, obtenez un code QR",
      prereqs: {
        label: "Avant de commencer",
        items: [
          "Un compte connecté sur le seul appareil qui envoie. Créer un code d'appairage en exige un — créer un lien de téléchargement asynchrone aussi — tandis que la personne qui scanne ne se connecte jamais.",
          "Une adresse e-mail vérifiée sur ce compte, car le relais d'une session entre réseaux n'est délivré qu'aux comptes vérifiés, ce que la carte d'appairage indique lorsqu'elle refuse.",
          "Une caméra ou n'importe quel lecteur de code QR sur l'appareil qui reçoit, et vous deux présents en même temps, car le code vit cinq minutes.",
          "Une entente sur qui crée le code : le code QR n'est dessiné que sur cet appareil, donc l'autre est celui qui scanne. Cela règle qui rejoint qui, pas le sens dans lequel les fichiers pourront circuler une fois que vous êtes tous les deux dans la salle.",
        ],
      },
      body: [
        "Sur l'appareil expéditeur, ouvrez relayium.com et connectez-vous — créer un code d'appairage demande un compte, car le code doit appartenir à quelqu'un, et créer un lien de téléchargement asynchrone en demande un pour la même raison. Ce qui n'en demande jamais, c'est de rejoindre : la personne qui scanne reste déconnectée du début à la fin. Choisissez un fichier, un dossier, ou connectez-vous simplement sans fichier en attente.",
        "Relayium génère un court code d'appairage — six chiffres décimaux, pour qu'un téléphone puisse ouvrir son pavé numérique et que le code se dicte sans rien épeler — et affiche juste à côté un code QR. Le code reste valable cinq minutes ; passé ce délai, il suffit d'en générer un autre. Ce code QR n'encode rien de nouveau : c'est le même lien de participation que fournit le bouton « copier le lien », simplement représenté sous forme de carré scannable plutôt qu'en texte. Quiconque ouvre ce lien atterrit directement dans votre salle d'appairage.",
      ],
    },
    {
      heading: "Il suffit de scanner — sans appli, sans compte",
      body: [
        "Sur l'autre appareil, ouvrez l'appli appareil photo (ou n'importe quel lecteur de code QR) et pointez-la vers l'écran. Toucher la notification qui apparaît ouvre le lien dans un navigateur, qui rejoint automatiquement la salle — la personne qui scanne n'a rien à taper, pas besoin de compte relayium.com, et rien à installer. Un scan ne fait que rejoindre, il ne déplace aucun fichier. Un lot entrant attend toujours sur l'écran qui reçoit que quelqu'un appuie sur « Accepter ».",
        "Si une caméra n'est pas à portée de main, le même lien fonctionne collé dans n'importe quel navigateur, et le code de six chiffres fonctionne tout aussi bien tapé dans le champ « saisir le code » de relayium.com. Le code QR est une commodité ajoutée par-dessus les deux, pas un mécanisme distinct — choisissez ce qui est le plus simple sur le moment.",
      ],
      steps: [
        {
          text: "Sur l'appareil qui envoie, ouvrez la page de transfert en temps réel et connectez-vous.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Créez le code d'appairage. La carte affiche alors les six chiffres, le carré QR en dessous et un compte à rebours.",
          code: ["Votre code d'appairage — communiquez-le à l'autre personne\n483920\nou faites scanner le QR / ouvrir le lien à l'autre personne\nle code d'appairage expire dans 4:52"],
        },
        {
          text: "Sur l'autre appareil, ouvrez l'appli appareil photo ou n'importe quel lecteur de code QR, pointez-la vers ce carré et touchez la notification de lien qu'elle propose.",
        },
        {
          text: "Le lien s'ouvre dans un navigateur et rejoint la salle de lui-même, sans rien à taper et sans compte de ce côté. C'est la même adresse que le bouton « Copier le lien » place dans le presse-papiers.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "De retour sur l'appareil qui envoie, choisissez les fichiers si vous n'en aviez pas mis en attente avant de créer le code. Rien ne bouge tant que le côté qui reçoit n'a pas appuyé sur « Accepter », alors répondez à cette invite là-bas, puis laissez les deux onglets ouverts jusqu'à la fin du compteur de fichiers.",
        },
      ],
      success: {
        label: "À quoi ressemble un scan réussi",
        body: [
          "Sur l'appareil qui envoie, le code QR et la ligne « En attente de l'autre appareil… » cèdent la place à la carte connectée, dont le badge de chemin indique « Relais », la valeur attendue pour une session par code d'appairage, qui emprunte délibérément le relais TURN chiffré.",
          "Le compteur de fichiers va ensuite jusqu'au dernier fichier sur les deux écrans. Rien du transfert ne diffère d'un code saisi à la main, car le scan n'a décidé que de la manière dont le second appareil est entré dans la salle.",
        ],
        code: ["Relais\nFichier 1/1"],
      },
    },
    {
      heading: "Ce qui se passe après le scan",
      body: [
        "Scanner ne fait qu'amener les deux appareils dans la même salle ; le transfert lui-même ne diffère en rien de n'importe quelle autre session par code d'appairage. Celui qui a créé le code possède la salle et celui qui a scanné l'a rejointe, mais cela décrit le rendez-vous, pas le sens du transfert : une fois tous les deux entrés, l'un comme l'autre peut être l'expéditeur, et chaque lot entrant reste conditionné à « Accepter » sur l'écran qui reçoit. La salle est elle aussi une surface distincte et plus ancienne : un code d'appairage vous place dans une salle séparée à deux appareils plutôt que dans l'espace de travail partagé qu'ouvrent les appareils d'un même réseau, et il passe uniquement par le relais, par conception. Les deux navigateurs dérivent une clé partagée via un échange de clés X25519, chiffrent chaque bloc avec AES-256-GCM, puis les envoient sur un canal WebRTC porté par un relais TURN.",
        "Avec la vérification avancée activée (désactivée par défaut), les deux écrans affichent le même code de vérification à six chiffres (SAS) — comparez-les et confirmez qu'il concorde avant de faire confiance à la connexion. Une concordance confirme que les clés n'ont pas été substituées : aucun serveur ou relais ne s'est fait passer pour l'un des terminaux ni n'a terminé le chiffrement de bout en bout de la couche applicative. Un transfert par code d'appairage emprunte toujours cette voie du relais au lieu de chercher d'abord un chemin direct : il ne dépend donc pas d'en trouver un à travers les NAT et pare-feu situés entre les deux réseaux, qui peuvent l'empêcher. Le relais ne transmet que du texte chiffré — il ne détient aucune clé et ne voit jamais vos fichiers. Chaque fichier est vérifié de bout en bout par une empreinte SHA-256, et une connexion interrompue peut reprendre au lieu de tout recommencer.",
      ],
    },
    {
      heading: "Si le scan ne fonctionne pas",
      body: [
        "La caméra a du mal à faire le point, l'éclairage est mauvais, ou l'un des appareils n'a tout simplement pas de caméra sous la main — rien de tout cela ne devrait bloquer le transfert. La carte d'appairage sur l'appareil expéditeur affiche aussi des boutons pour copier le code brut et le lien (plus un bouton de partage sur les appareils qui le prennent en charge), ainsi qu'un compte à rebours jusqu'à l'expiration du code.",
        "Retapez le code, collez le lien, ou utilisez le partage pour l'envoyer autrement (messagerie, AirDrop, ce qui est le plus rapide) — chaque chemin mène à la même salle et obtient la même connexion chiffrée. Le code QR n'est qu'un point d'entrée parmi d'autres, jamais une obligation.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Le scan ouvre la page et celle-ci indique que le code d'appairage est invalide ou expiré.",
            code: ["https://relayium.com/cross-network   # la carte de l'expéditeur affiche le décompte en direct"],
            fix: "Les cinq minutes sont écoulées, et le QR d'un code mort reste un lien mort, quel que soit le nombre de scans. Créez un code neuf sur l'appareil qui envoie, la carte en dessine aussitôt un nouveau QR, et scannez celui-là tout de suite.",
          },
          {
            symptom: "La caméra reconnaît le carré mais ne propose jamais d'ouvrir quoi que ce soit.",
            code: ["https://relayium.com/cross-network   # le champ « Saisir un code d'appairage » accepte les six chiffres"],
            fix: "Certains lecteurs se contentent de copier le texte au lieu de le confier à un navigateur. Collez ce qu'il a copié dans la barre d'adresse, ou passez-vous du QR : ouvrez la page sur l'appareil qui reçoit, tapez les six chiffres dans le champ « Saisir un code d'appairage » et appuyez sur « Connecter ».",
          },
          {
            symptom: "Vous cherchez tous les deux un QR à scanner et aucun écran n'en affiche.",
            code: ["https://relayium.com/cross-network   # seule la carte qui a créé le code dessine un QR"],
            fix: "Le QR appartient à l'appareil qui a créé le code, il faut donc que l'un crée d'abord et que l'autre scanne. Décidez qui crée — l'un comme l'autre pourra ensuite envoyer, une fois que vous êtes tous les deux dans la salle — puis appuyez sur« Créer un code d'appairage » sur cet appareil, et pointez la caméra de l'autre vers cet écran.",
          },
          {
            symptom: "Le lien a été transmis via une messagerie et la page s'ouvre sans code dedans.",
            code: ["https://relayium.com/cross-network#c=483920   # tout ce qui suit #c= est le code"],
            fix: "Le code voyage dans le fragment de l'URL, et un réécrivain de liens ou un service d'aperçu peut supprimer tout ce qui suit le #. Lisez plutôt les six chiffres à voix haute, ou collez vous-même le lien dans la barre d'adresse pour que rien ne le réécrive entre vous et le navigateur.",
          },
          {
            symptom: "Le scan rejoint la salle, puis la carte indique que le relais n'est délivré qu'aux comptes vérifiés.",
            code: ["https://relayium.com/cross-network   # la carte d'appairage nomme la raison du refus"],
            fix: "L'adresse e-mail du compte émetteur n'est pas encore vérifiée, et cela est contrôlé au moment où la session demande un relais, pas à la création du code. Vérifiez l'adresse depuis le panneau du compte, créez ensuite un nouveau code d'appairage et scannez son QR. Les transferts sur le même réseau n'en dépendent pas.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La personne qui scanne le code QR a-t-elle besoin d'un compte Relayium ?",
        a: "Non. Seul le côté qui crée le code d'appairage et son code QR se connecte, une exigence que porte aussi un lien de téléchargement asynchrone. Celui qui le scanne ne fait que rejoindre la salle déjà créée — pas de compte, pas d'inscription, rien à installer.",
      },
      {
        q: "Que contient exactement le code QR ?",
        a: "Le même lien de participation que copie le bouton « copier le lien » — une URL relayium.com contenant le code d'appairage. Le scanner ouvre simplement ce lien dans le navigateur, qui rejoint automatiquement la salle. Et cela s'arrête là : aucun fichier n'est choisi ni envoyé, et ce qui est envoyé ensuite doit encore être accepté sur l'appareil qui reçoit.",
      },
      {
        q: "Scanner le code QR est-il aussi sûr que taper le code ?",
        a: "Oui, la connexion est strictement identique dans les deux cas. Les deux appareils négocient toujours un échange de clés X25519, chiffrent avec AES-256-GCM et, si la vérification avancée est activée, affichent un code de vérification SAS concordant à contrôler avant de faire confiance au transfert. Le code QR ne change que la façon d'entrer dans la salle, pas la façon dont le transfert est sécurisé.",
      },
      {
        q: "Et si le code QR ne veut pas se scanner ?",
        a: "Rien n'est perdu — la même carte d'appairage affiche le code brut et un lien copiable, plus un bouton de partage sur les appareils compatibles. N'importe lequel des deux mène à la même salle que le code QR.",
      },
      {
        q: "Est-ce que cela marche entre réseaux différents, par exemple téléphone en données mobiles et PC sur le Wi-Fi de la maison ?",
        a: "Oui. C'est par nature le mode d'appairage entre réseaux différents, donc il fonctionne que les deux appareils partagent un réseau ou non. Un code d'appairage relie toujours les deux via un relais TURN chiffré — la voie qui ne dépend pas de la découverte d'un passage à travers les NAT et pare-feu situés entre les réseaux, qui peuvent empêcher une liaison directe — et ce relais ne transporte que du texte chiffré. Ce sont les appareils d'un même réseau, qui se trouvent sans code, qui se connectent directement.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium, créez un code, et essayez de scanner le code QR avec un autre appareil — la personne qui scanne n'a besoin ni d'appli ni de compte.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "نقل الملفات بمسح رمز QR ضوئيًا",
  description:
    "أرسل الملفات بمسح رمز QR من جلسة اقتران ضوئيًا — النقل مشفَّر من الطرف إلى الطرف طوال الطريق. لا حاجة إلى تطبيق أو حساب للشخص الذي يمسح.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إدخال رمز من ستة أرقام سريع، لكن المسح الضوئي أسرع — وجّه كاميرا الهاتف نحو الشاشة ويُهيَّأ النقل قبل أن تنتهي من الكتابة. تُظهر عملية اقتران Relayium رمز QR إلى جانب كل رمز اقتران لهذا السبب بالضبط.",
    "هذا هو مسار النقل عبر الشبكات: فهو يعمل سواء أكان الجهازان على نفس شبكة Wi-Fi أم على طرفي الكوكب المتقابلين. رمز QR ليس سوى اختصار إلى ذلك المسار — فالرمز والرابط الكامنان تحته يعملان بالطريقة نفسها تمامًا إن لم يكن المسح مناسبًا.",
  ],
  sections: [
    {
      heading: "أنشئ رمزًا، واحصل على QR",
      prereqs: {
        label: "قبل أن تبدأ",
        items: [
          "حساب مسجَّل الدخول على جهاز الإرسال وحده. إنشاء رمز الاقتران يتطلب حسابًا — وكذلك إنشاء رابط تنزيل غير متزامن — أما من يمسح الرمز فلا يسجّل الدخول أبدًا.",
          "بريد إلكتروني موثَّق في ذلك الحساب، فمُرحِّل الجلسة عبر الشبكات لا يُمنَح إلا للحسابات الموثَّقة، وتقول بطاقة الاقتران ذلك عند الرفض.",
          "كاميرا أو أي ماسح QR على جهاز الاستقبال، وحضوركما معًا في الوقت نفسه، فالرمز يعيش خمس دقائق.",
          "اتفاق على من يُنشئ الرمز: لا يُرسَم رمز QR إلا على ذلك الجهاز، فيكون الجهاز الآخر هو الماسح. وهذا يحدّد من ينضم إلى غرفة من، لا الاتجاه الذي يمكن للملفات أن تسير فيه بعد دخولكما معًا.",
        ],
      },
      body: [
        "على جهاز الإرسال، افتح relayium.com وسجّل الدخول — إنشاء رمز اقتران يتطلب حسابًا لأن الرمز يجب أن يعود لشخص ما، وإنشاء رابط تنزيل غير متزامن يتطلبه للسبب نفسه. أما ما لا يتطلب حسابًا أبدًا فهو الانضمام: من يمسح الرمز يبقى غير مسجَّل الدخول من البداية إلى النهاية. اختر ملفًا أو مجلدًا، أو اتصل فقط دون ملفات في الانتظار بعد.",
        "يُنشئ Relayium رمز اقتران قصيرًا — ستة أرقام عشرية، حتى يتمكّن الهاتف من إظهار لوحة الأرقام ويمكن نطق الرمز دون تهجئة أي حرف — وإلى جانبه مباشرةً، يعرض رمز QR. ويبقى الرمز صالحًا خمس دقائق، وبعدها تُنشئ رمزًا جديدًا. لا يحمل رمز QR أي شيء جديد — إنه رابط الانضمام نفسه الذي يمنحك إياه زر «نسخ الرابط»، معروضًا على هيئة مربع قابل للمسح بدلًا من نص. من يفتح ذلك الرابط يصل مباشرةً إلى غرفة الاقتران لديك.",
      ],
    },
    {
      heading: "امسحه ضوئيًا — لا تطبيق، لا حساب",
      body: [
        "على الجهاز الآخر، افتح تطبيق الكاميرا (أو أي ماسح QR) ووجّهه نحو الشاشة. النقر على الإشعار الذي يظهر يفتح الرابط في متصفح، فينضم إلى الغرفة تلقائيًا — لا كتابة، ولا حساب relayium.com للشخص الذي يمسح، ولا شيء يُثبَّت. والمسح لا يفعل سوى الانضمام؛ فهو لا ينقل أي ملف. ودفعة الملفات الواردة تظل تنتظر على شاشة الاستقبال حتى يضغط أحدهم «قبول».",
        "إن لم تكن الكاميرا في المتناول، يعمل الرابط نفسه ملصوقًا في أي متصفح، ويعمل الرمز المؤلف من ستة أرقام مكتوبًا في خانة «أدخل الرمز» على relayium.com. رمز QR وسيلة راحة مضافة فوق كليهما، لا آلية منفصلة — اختر أيهما أسهل في اللحظة.",
      ],
      steps: [
        {
          text: "على جهاز الإرسال، افتح صفحة النقل الفوري وسجّل الدخول.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "أنشِئ رمز الاقتران. تعرض البطاقة عندئذٍ الأرقام الستة، ومربّع QR تحتها، وعدًّا تنازليًا.",
          code: ["رمز اقترانك — اقرأه للطرف الآخر\n483920\nأو اطلب منهم مسح / فتح الرابط للانضمام\nتنتهي صلاحية رمز الاقتران خلال 4:52"],
        },
        {
          text: "على الجهاز الآخر، افتح تطبيق الكاميرا أو أي ماسح QR ووجّهه إلى ذلك المربّع، ثم انقر إشعار الرابط الذي يعرضه.",
        },
        {
          text: "يُفتح الرابط في متصفح وينضم إلى الغرفة من تلقاء نفسه — لا كتابة، ولا حساب على هذا الطرف. وهو العنوان نفسه الذي يضعه زر «نسخ الرابط» في الحافظة.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "عُد إلى جهاز الإرسال: إن لم تكن قد صففت ملفات قبل إنشاء الرمز، فاختر الملفات الآن. ولا يتحرك شيء حتى يضغط جهاز الاستقبال «قبول»، فاستجب لذلك الطلب هناك، ثم اترك التبويبين مفتوحين حتى ينتهي عدّاد الملفات.",
        },
      ],
      success: {
        label: "كيف يبدو المسح الناجح",
        body: [
          "على جهاز الإرسال يفسح رمز QR وسطر «في انتظار انضمام الجهاز الآخر…» المجالَ لبطاقة الاتصال، ويقرأ وسم المسار عليها «مُرحَّل» — وهي القيمة المتوقَّعة لجلسة برمز اقتران، إذ تسلك بحكم التصميم مُرحِّل TURN المشفَّر.",
          "ثم يمضي عدّاد الملفات إلى آخر ملف على الشاشتين. ولا يختلف النقل في شيء عن رمز أُدخِل يدويًا: فالمسح لم يقرّر سوى الطريقة التي دخل بها الجهاز الثاني إلى الغرفة.",
        ],
        code: ["مُرحَّل\nالملف 1/1"],
      },
    },
    {
      heading: "ما يحدث بعد المسح",
      body: [
        "المسح يُدخل الجهازين إلى الغرفة نفسها فحسب؛ أما النقل نفسه فلا يتغير عن أي جلسة رمز اقتران أخرى. ومن أنشأ الرمز يملك الغرفة ومن مسحه انضم إليها، لكن هذا حديث عن اللقاء لا عن الاتجاه: فبعد دخولكما معًا، يمكن لأي طرف أن يكون المُرسِل، وتظل كل دفعة واردة محكومة بزر «قبول» على شاشة الاستقبال. والغرفة نفسها واجهة مستقلة وأقدم: فرمز الاقتران يضعكما في غرفة منفصلة لجهازين، لا في مساحة العمل المشتركة التي يفتحها جهازان على الشبكة نفسها، وهي بحكم التصميم عبر المُرحِّل وحده. يشتقّ المتصفحان مفتاحًا مشتركًا بتبادل مفاتيح X25519، ويشفّران كل جزء بـ AES-256-GCM، ثم يرسلانه عبر قناة WebRTC محمولة على مُرحِّل TURN.",
        "عند تفعيل «التحقّق المتقدّم» (المعطَّل افتراضيًا) تعرض الشاشتان نفس رمز التحقق المؤلف من ست خانات رقمية (SAS) — ألقِ نظرة على كليهما وأكّد تطابقهما قبل أن تثق بالاتصال. يؤكد التطابق أن المفاتيح لم تُستبدل: فلم ينتحل خادم أو مُرحِّل شخصية أي من الطرفين ولم يُنهِ التشفير من الطرف إلى الطرف على مستوى التطبيق. والنقل عبر رمز اقتران يسلك دائمًا طريق المُرحِّل هذا بدل البحث أولًا عن مسار مباشر: فهو بذلك لا يعتمد على إيجاد مسار مباشر عبر ما بين الشبكتين من شبكات NAT وجدران حماية، وهي قد تمنع مثل هذا المسار. ولا يُمرِّر المُرحِّل سوى نص مُشفَّر — فهو بلا مفتاح، ولا يرى ملفاتك أبدًا. يُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256، ويمكن للاتصال المنقطع أن يُستأنف بدلًا من البدء من جديد.",
      ],
    },
    {
      heading: "إن لم يعمل المسح",
      body: [
        "قد تخطئ الكاميرات، أو تكون الإضاءة سيئة، أو لا يكون لدى أحد الجهازين كاميرا في المتناول — لا ينبغي لأي من ذلك أن يعطّل النقل. تعرض بطاقة الاقتران على جهاز الإرسال أيضًا أزرار نسخ للرمز الخام وللرابط (وزر ورقة مشاركة على الأجهزة التي تدعمها)، إضافةً إلى عدّ تنازلي حتى انتهاء صلاحية الرمز.",
        "أعد كتابة الرمز، أو الصق الرابط، أو استخدم ورقة المشاركة لإرساله بطريقة أخرى (محادثة، AirDrop، أيًا كان الأسرع) — كل مسار يصل إلى الغرفة نفسها ويحصل على الاتصال المشفَّر نفسه. رمز QR واحد من عدة مداخل، وليس شرطًا أبدًا.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "يفتح المسح الصفحة فتقول إن رمز الاقتران غير صالح أو منتهي الصلاحية.",
            code: ["https://relayium.com/cross-network   # بطاقة المُرسِل تعرض العدّ التنازلي الحي"],
            fix: "انقضت الدقائق الخمس، ويظل رمز QR لرمز ميت رابطًا ميتًا مهما تكرّر مسحه. أنشِئ رمزًا جديدًا على جهاز الإرسال — فترسم البطاقة معه رمز QR جديدًا — وامسح ذلك فورًا.",
          },
          {
            symptom: "تتعرّف الكاميرا على المربّع لكنها لا تعرض شيئًا يمكن فتحه.",
            code: ["https://relayium.com/cross-network   # خانة «أدخِل رمز اقتران» تقبل الأرقام الستة"],
            fix: "بعض المواسح تكتفي بنسخ النص بدل تسليمه إلى متصفح. الصق ما نسخته في شريط العنوان، أو استغنِ عن رمز QR كليًا: افتح الصفحة على جهاز الاستقبال، واكتب الأرقام الستة في خانة «أدخِل رمز اقتران» ثم اضغط «اتصال».",
          },
          {
            symptom: "كلاكما يبحث عن رمز QR لمسحه ولا تعرضه أي من الشاشتين.",
            code: ["https://relayium.com/cross-network   # البطاقة التي أنشأت الرمز وحدها ترسم QR"],
            fix: "رمز QR يخصّ الجهاز الذي أنشأ الرمز، فلا بد أن ينشئ أحدكما أولًا ويمسح الآخر. قرّرا أي طرف سيُنشئ — وأي طرف يمكنه الإرسال بعد دخولكما معًا إلى الغرفة — واضغط «إنشاء رمز اقتران» على ذلك الجهاز، ثم وجّه كاميرا الجهاز الآخر إلى تلك الشاشة.",
          },
          {
            symptom: "أُعيد إرسال الرابط عبر تطبيق محادثة فانفتحت الصفحة بلا رمز فيها.",
            code: ["https://relayium.com/cross-network#c=483920   # كل ما بعد ‎#c=‎ هو الرمز"],
            fix: "ينتقل الرمز داخل جزء المرجع في العنوان، وقد تحذف خدمات إعادة كتابة الروابط أو المعاينة كل ما يلي علامة #. اقرأ الأرقام الستة بصوت عالٍ بدلًا من ذلك، أو الصق الرابط بنفسك في شريط العنوان حتى لا يعيد أحد كتابته بينك وبين المتصفح.",
          },
          {
            symptom: "ينضم المسح إلى الغرفة ثم تقول البطاقة إن المُرحِّل لا يُمنَح إلا للحسابات الموثَّقة.",
            code: ["https://relayium.com/cross-network   # بطاقة الاقتران تسمّي سبب الرفض"],
            fix: "بريد حساب الإرسال لم يُوثَّق بعد، ويجري هذا الفحص عندما تطلب الجلسة مُرحِّلًا لا عند إنشاء الرمز. وثِّق العنوان من لوحة الحساب، ثم أنشِئ رمز اقتران جديدًا وامسح رمز QR الخاص به — ولا يتأثر بذلك النقل على نفس الشبكة.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يحتاج الشخص الذي يمسح رمز QR إلى حساب Relayium؟",
        a: "لا. الجهة التي تُنشئ رمز الاقتران ورمز QR الخاص به هي وحدها التي تسجّل الدخول — وهو الشرط نفسه الذي يحمله رابط التنزيل غير المتزامن. ومن يمسحه ينضم فقط إلى الغرفة التي أُنشئت بالفعل: لا حساب، لا تسجيل، ولا شيء يُثبَّت.",
      },
      {
        q: "ماذا يحتوي رمز QR فعلًا؟",
        a: "رابط الانضمام نفسه الذي ينسخه زر «نسخ الرابط» — عنوان URL على relayium.com برمز الاقتران مضمّنًا فيه. مسحه ضوئيًا يفتح ذلك الرابط في المتصفح فحسب، فينضم إلى الغرفة تلقائيًا. وعند هذا الحد يقف الأمر: فلا يُختار ملف ولا يُرسَل شيء، وما يُرسَل بعد ذلك يظل بحاجة إلى قبول على جهاز الاستقبال.",
      },
      {
        q: "هل مسح رمز QR آمن بقدر إدخال الرمز؟",
        a: "نعم، إنه الاتصال ذاته في كلتا الحالتين. لا يزال الجهازان يتفاوضان على تبادل مفاتيح X25519، ويشفّران بـ AES-256-GCM، ويعرضان رمز تحقق SAS متطابقًا — عند تفعيل التحقّق المتقدّم — يمكنك التحقق منه قبل أن تثق بالنقل. رمز QR يغير فقط كيف تدخل الغرفة، لا كيف يُؤمَّن النقل.",
      },
      {
        q: "ماذا لو لم يُمسح رمز QR؟",
        a: "لا شيء يُفقد — تعرض بطاقة الاقتران نفسها الرمز الخام ورابطًا قابلًا للنسخ، وزر ورقة مشاركة على الأجهزة المدعومة. أي منها يفتح الغرفة نفسها التي يفتحها رمز QR.",
      },
      {
        q: "هل يعمل هذا عبر شبكات مختلفة، مثل بيانات الهاتف مع شبكة Wi-Fi المنزلية؟",
        a: "نعم. هذا هو مسار الاقتران عبر الشبكات، لذا فهو يعمل سواء أكان الجهازان يتشاركان شبكة أم لا. ورمز الاقتران يصل بينهما دائمًا عبر مُرحِّل TURN مشفَّر — وهو المسار الذي لا يعتمد على إيجاد منفذ عبر ما بين الشبكتين من شبكات NAT وجدران حماية، وهي قد تمنع الاتصال المباشر — ولا يحمل ذلك المُرحِّل إلا نصًا مُشفَّرًا. أما الاتصال المباشر فهو ما يحدث بين أجهزة على الشبكة نفسها يعثر بعضها على بعض دون رمز.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium، وأنشئ رمزًا، وجرّب مسح رمز QR بجهاز آخر — لا حاجة إلى تطبيق أو حساب للشخص الذي يمسح.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Transferir archivos escaneando un código QR",
  description:
    "Envía archivos escaneando un código QR de una sesión de emparejamiento — la transferencia va cifrada de extremo a extremo todo el camino. Sin app ni cuenta para quien escanea.",
  updatedLabel: "Última actualización",
  lead: [
    "Escribir un código de seis dígitos es rápido, pero escanear lo es aún más — apunta la cámara del teléfono a la pantalla y la transferencia queda lista antes de que hubieras terminado de escribir. El flujo de emparejamiento de Relayium muestra un código QR junto a cada código de emparejamiento precisamente por esto.",
    "Este es el flujo entre redes: funciona tanto si ambos dispositivos están en la misma Wi-Fi como si están en lados opuestos del planeta. El QR es solo un atajo hacia ese flujo — el código y el enlace que hay debajo funcionan exactamente igual si escanear no es cómodo.",
  ],
  sections: [
    {
      heading: "Crea un código, obtén un QR",
      prereqs: {
        label: "Antes de empezar",
        items: [
          "Una cuenta conectada solo en el dispositivo que envía. Crear un código de emparejamiento exige una — crear un enlace de descarga asíncrono también — mientras que quien escanea no inicia sesión nunca.",
          "Una dirección de correo verificada en esa cuenta, porque el retransmisor de una sesión entre redes solo se entrega a cuentas verificadas y la tarjeta de emparejamiento lo dice cuando lo rechaza.",
          "Una cámara o cualquier escáner de QR en el dispositivo que recibe, y los dos presentes a la vez, porque el código vive cinco minutos.",
          "Un acuerdo sobre quién crea el código: el QR solo se dibuja en ese dispositivo, así que el otro es el que escanea. Eso zanja quién se une a quién, no en qué sentido podrán viajar los archivos una vez que los dos estáis en la sala.",
        ],
      },
      body: [
        "En el dispositivo que envía, abre relayium.com e inicia sesión — crear un código de emparejamiento pide una cuenta porque el código tiene que pertenecer a alguien, y crear un enlace de descarga asíncrono la pide por la misma razón. Lo que nunca la pide es unirse: quien escanea sigue sin sesión de principio a fin. Elige un archivo, una carpeta, o simplemente conéctate sin archivos en cola todavía.",
        "Relayium genera un código de emparejamiento corto — seis dígitos decimales, para que un teléfono pueda abrir su teclado numérico y el código se pueda dictar sin deletrear nada — y, justo al lado, representa un código QR. El código vale cinco minutos; pasados esos, generas otro. El QR no codifica nada nuevo — es el mismo enlace de unión que te da el botón «copiar enlace», solo que representado como un cuadrado escaneable en lugar de texto. Quien abra ese enlace llega directamente a tu sala de emparejamiento.",
      ],
    },
    {
      heading: "Escanéalo — sin app, sin cuenta",
      body: [
        "En el otro dispositivo, abre la app de la cámara (o cualquier escáner de QR) y apúntala a la pantalla. Tocar la notificación que aparece abre el enlace en un navegador, que se une a la sala automáticamente — sin escribir nada, sin cuenta de relayium.com para quien escanea, y sin nada que instalar. Escanear solo une; no mueve ningún archivo. Un lote entrante sigue esperando en la pantalla que recibe hasta que alguien pulsa «Aceptar».",
        "Si no tienes una cámara a mano, el mismo enlace funciona pegado en cualquier navegador, y el código de seis dígitos funciona escrito en el cuadro de «introducir código» de relayium.com. El QR es una comodidad añadida sobre ambos, no un mecanismo aparte — elige lo que sea más fácil en el momento.",
      ],
      steps: [
        {
          text: "En el dispositivo que envía, abre la página de transferencia en tiempo real e inicia sesión.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Crea el código de emparejamiento. La tarjeta muestra entonces los seis dígitos, el cuadrado del QR debajo y una cuenta atrás.",
          code: ["Tu código de emparejamiento — léeselo a la otra persona\n483920\no pídeles que escaneen / abran el enlace para unirse\nel código de emparejamiento caduca en 4:52"],
        },
        {
          text: "En el otro dispositivo, abre la app de la cámara o cualquier escáner de QR, apúntala a ese cuadrado y toca la notificación de enlace que ofrezca.",
        },
        {
          text: "El enlace se abre en un navegador y se une a la sala por su cuenta, sin escribir nada y sin cuenta en este lado. Es la misma dirección que el botón «Copiar enlace» deja en el portapapeles.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "De vuelta en el dispositivo que envía, elige los archivos si no habías dejado ninguno en cola antes de crear el código. Nada se mueve hasta que el lado que recibe pulsa «Aceptar», así que responde ahí a ese aviso y deja luego las dos pestañas abiertas hasta que el contador de archivos llegue al final.",
        },
      ],
      success: {
        label: "Qué se ve cuando el escaneo sale bien",
        body: [
          "En el dispositivo que envía, el QR y la línea «Esperando a que el otro dispositivo se una…» dejan paso a la tarjeta conectada, cuya etiqueta de ruta marca «Retransmitido», el valor esperado en una sesión por código de emparejamiento, que pasa por el retransmisor TURN cifrado por diseño.",
          "El contador de archivos llega después al último archivo en las dos pantallas. Nada de la transferencia cambia respecto a un código escrito a mano: el escaneo solo decidió cómo entró el segundo dispositivo en la sala.",
        ],
        code: ["Retransmitido\nArchivo 1/1"],
      },
    },
    {
      heading: "Qué ocurre tras el escaneo",
      body: [
        "Escanear solo mete a los dos dispositivos en la misma sala; la transferencia en sí no cambia respecto a cualquier otra sesión con código de emparejamiento. Quien creó el código es dueño de la sala y quien escaneó se unió a ella, pero eso habla del encuentro, no del sentido: una vez dentro los dos, cualquiera de los lados puede ser el que envía, y todo lote entrante sigue pasando por «Aceptar» en la pantalla que recibe. La sala también es una superficie propia y más antigua: un código de emparejamiento os mete en una sala aparte de dos dispositivos, no en el espacio de trabajo compartido que abren los dispositivos de una misma red, y va solo por retransmisor por diseño. Los dos navegadores derivan una clave compartida con un intercambio de claves X25519, cifran cada fragmento con AES-256-GCM y lo envían por un canal WebRTC que se apoya en un retransmisor TURN.",
        "Con la verificación avanzada activada (desactivada por omisión), ambas pantallas muestran el mismo código de verificación de seis dígitos (SAS) — echa un vistazo a los dos y confirma que coinciden antes de confiar en la conexión. Una coincidencia confirma que las claves no se sustituyeron: ningún servidor o retransmisor se hizo pasar por uno de los extremos ni terminó el cifrado de extremo a extremo de la capa de aplicación. Una transferencia con código de emparejamiento toma siempre esa vía del retransmisor en lugar de buscar antes una ruta directa: así que no depende de encontrar una ruta directa a través de los NAT y cortafuegos que hay entre las dos redes, que pueden impedirla. El retransmisor solo reenvía texto cifrado — no tiene ninguna clave y nunca ve tus archivos. Cada archivo se verifica de extremo a extremo con un hash SHA-256, y una conexión caída puede reanudarse en lugar de reiniciarse.",
      ],
    },
    {
      heading: "Si el escaneo no funciona",
      body: [
        "Las cámaras fallan, la iluminación es mala, o un dispositivo simplemente no tiene una cámara a mano — nada de eso debería bloquear la transferencia. La tarjeta de emparejamiento en el dispositivo que envía también muestra botones para copiar el código en bruto y el enlace (y un botón de compartir en los dispositivos que lo admiten), además de una cuenta atrás hasta que el código caduca.",
        "Vuelve a escribir el código, pega el enlace, o usa el menú de compartir para enviarlo de otra forma (chat, AirDrop, lo que sea más rápido) — cada vía llega a la misma sala y obtiene la misma conexión cifrada. El QR es uno de varios puntos de entrada, nunca un requisito.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El escaneo abre la página y esta dice que el código de emparejamiento no es válido o ha caducado.",
            code: ["https://relayium.com/cross-network   # la tarjeta del remitente muestra la cuenta atrás en vivo"],
            fix: "Los cinco minutos se agotaron, y el QR de un código muerto sigue siendo un enlace muerto por más veces que se escanee. Crea un código nuevo en el dispositivo que envía — la tarjeta dibuja con él un QR nuevo — y escanea ese enseguida.",
          },
          {
            symptom: "La cámara reconoce el cuadrado pero nunca ofrece abrir nada.",
            code: ["https://relayium.com/cross-network   # el cuadro «Introduce un código de emparejamiento» acepta los seis dígitos"],
            fix: "Algunos escáneres solo copian el texto en vez de entregarlo a un navegador. Pega lo que copió en la barra de direcciones, o prescinde del QR: abre la página en el dispositivo que recibe, escribe los seis dígitos en el cuadro «Introduce un código de emparejamiento» y pulsa «Conectar».",
          },
          {
            symptom: "Los dos buscáis un QR que escanear y ninguna pantalla lo muestra.",
            code: ["https://relayium.com/cross-network   # solo la tarjeta que creó el código dibuja un QR"],
            fix: "El QR pertenece al dispositivo que creó el código, así que uno tiene que crear primero y el otro escanear. Decidid qué lado crea — enviar podrá cualquiera de los dos en cuanto estéis los dos en la sala —, pulsad «Crear un código de emparejamiento» en ese dispositivo y apuntad la cámara del otro a esa pantalla.",
          },
          {
            symptom: "El enlace se reenvió por un chat y la página se abre sin código dentro.",
            code: ["https://relayium.com/cross-network#c=483920   # todo lo que sigue a #c= es el código"],
            fix: "El código viaja en el fragmento de la URL, y un reescritor de enlaces o un servicio de vista previa puede tirar todo lo que va tras el #. Lee en voz alta los seis dígitos, o pega tú mismo el enlace en la barra de direcciones para que nada lo reescriba entre tú y el navegador.",
          },
          {
            symptom: "El escaneo entra en la sala y luego la tarjeta dice que el retransmisor solo se entrega a cuentas verificadas.",
            code: ["https://relayium.com/cross-network   # la tarjeta de emparejamiento nombra el motivo del rechazo"],
            fix: "La dirección de correo de la cuenta que envía no está verificada, y eso se comprueba cuando la sesión pide un retransmisor, no al crear el código. Verifica la dirección desde el panel de la cuenta, crea después un código nuevo y escanea su QR; las transferencias en la misma red no dependen de esto.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿La persona que escanea el QR necesita una cuenta de Relayium?",
        a: "No. Solo inicia sesión el lado que crea el código de emparejamiento y su QR — el mismo requisito que lleva un enlace de descarga asíncrono. Quien lo escanea simplemente se une a la sala que ya se creó: sin cuenta, sin registro, nada que instalar.",
      },
      {
        q: "¿Qué contiene en realidad el código QR?",
        a: "El mismo enlace de unión que copia el botón «copiar enlace» — una URL de relayium.com con el código de emparejamiento incorporado. Escanearlo simplemente abre ese enlace en el navegador, que se une a la sala automáticamente. Y ahí se detiene: no se elige ningún archivo ni se envía ninguno, y lo que se envíe después todavía tiene que aceptarse en el dispositivo que recibe.",
      },
      {
        q: "¿Escanear el QR es tan seguro como escribir el código?",
        a: "Sí, es la misma conexión en ambos casos. Los dos dispositivos siguen negociando un intercambio de claves X25519, cifran con AES-256-GCM y, si la verificación avanzada está activada, muestran un código de verificación SAS coincidente que puedes comprobar antes de confiar en la transferencia. El QR solo cambia cómo entras en la sala, no cómo se protege la transferencia.",
      },
      {
        q: "¿Y si el QR no se escanea?",
        a: "No se pierde nada — la misma tarjeta de emparejamiento muestra el código en bruto y un enlace que se puede copiar, y un botón de compartir en los dispositivos compatibles. Cualquiera de ellos abre la misma sala que el QR.",
      },
      {
        q: "¿Funciona entre redes distintas, como datos del teléfono y la Wi-Fi de casa?",
        a: "Sí. Este es el flujo de emparejamiento entre redes, así que funciona tanto si los dos dispositivos comparten red como si no. Un código de emparejamiento los conecta siempre a través de un retransmisor TURN cifrado — la vía que no depende de encontrar un paso a través de los NAT y cortafuegos que hay entre las redes, que pueden impedir una conexión directa — y ese retransmisor solo transporta texto cifrado. Lo que conecta de forma directa son los dispositivos de una misma red que se encuentran sin código.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium, crea un código y prueba a escanear el QR con otro dispositivo — sin app ni cuenta para quien escanea.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Transferir arquivos escaneando um código QR",
  description:
    "Envie arquivos escaneando um código QR de uma sessão de emparelhamento — a transferência é criptografada de ponta a ponta o caminho todo. Sem app nem conta para quem escaneia.",
  updatedLabel: "Última atualização",
  lead: [
    "Digitar um código de seis dígitos é rápido, mas escanear é ainda mais rápido — aponte a câmera do celular para a tela e a transferência fica pronta antes de você terminar de digitar. O fluxo de emparelhamento do Relayium mostra um código QR ao lado de cada código de emparelhamento exatamente por isso.",
    "Este é o fluxo entre redes: funciona tanto se os dois dispositivos estiverem no mesmo Wi-Fi como em lados opostos do planeta. O QR é só um atalho para esse fluxo — o código e o link abaixo dele funcionam exatamente da mesma forma se escanear não for conveniente.",
  ],
  sections: [
    {
      heading: "Crie um código, obtenha um QR",
      prereqs: {
        label: "Antes de começar",
        items: [
          "Uma conta conectada só no dispositivo que envia. Criar um código de emparelhamento exige uma — criar um link de download assíncrono também — enquanto quem escaneia nunca faz login.",
          "Um e-mail verificado nessa conta, porque o retransmissor de uma sessão entre redes só é entregue a contas verificadas, e o cartão de emparelhamento diz isso quando recusa.",
          "Uma câmera ou qualquer leitor de QR no dispositivo que recebe, e os dois presentes ao mesmo tempo, porque o código vive cinco minutos.",
          "Um acordo sobre quem cria o código: o QR só é desenhado nesse dispositivo, então o outro é quem escaneia. Isso resolve quem entra na sala de quem, não em que sentido os arquivos poderão viajar depois que os dois estiverem dentro.",
        ],
      },
      body: [
        "No dispositivo que envia, abra relayium.com e faça login — criar um código de emparelhamento pede uma conta porque o código precisa pertencer a alguém, e criar um link de download assíncrono pede pelo mesmo motivo. O que nunca pede é entrar: quem escaneia continua deslogado do começo ao fim. Escolha um arquivo, uma pasta, ou apenas conecte sem arquivos na fila ainda.",
        "O Relayium gera um código de emparelhamento curto — seis dígitos decimais, para que um celular possa abrir o teclado numérico e o código possa ser ditado sem soletrar nada — e, logo ao lado, renderiza um código QR. O código vale cinco minutos; depois disso, basta gerar outro. O QR não codifica nada de novo — é o mesmo link de entrada que o botão “copiar link” oferece, apenas renderizado como um quadrado escaneável em vez de texto. Quem abrir esse link chega direto à sua sala de emparelhamento.",
      ],
    },
    {
      heading: "Escaneie — sem app, sem conta",
      body: [
        "No outro dispositivo, abra o app da câmera (ou qualquer leitor de QR) e aponte para a tela. Tocar na notificação que aparece abre o link em um navegador, que entra na sala automaticamente — sem digitar nada, sem conta relayium.com para quem escaneia, e nada para instalar. Escanear só faz entrar; não move arquivo nenhum. Um lote que chega continua esperando na tela de quem recebe até alguém apertar “Aceitar”.",
        "Se não houver uma câmera à mão, o mesmo link funciona colado em qualquer navegador, e o código de seis dígitos funciona digitado na caixa “inserir código” de relayium.com. O QR é uma comodidade sobreposta aos dois, não um mecanismo separado — escolha o que for mais fácil no momento.",
      ],
      steps: [
        {
          text: "No dispositivo que envia, abra a página de transferência em tempo real e faça login.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Crie o código de emparelhamento. O cartão então mostra os seis dígitos, o quadrado do QR abaixo deles e uma contagem regressiva.",
          code: ["Seu código de emparelhamento — leia-o para a outra pessoa\n483920\nou peça que escaneie / abra o link para entrar\no código de emparelhamento expira em 4:52"],
        },
        {
          text: "No outro dispositivo, abra o app da câmera ou qualquer leitor de QR, aponte para esse quadrado e toque na notificação de link que ele oferecer.",
        },
        {
          text: "O link abre em um navegador e entra na sala por conta própria, sem digitar nada e sem conta deste lado. É o mesmo endereço que o botão “Copiar link” coloca na área de transferência.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "De volta ao dispositivo que envia, escolha os arquivos se você não tinha colocado nenhum na fila antes de criar o código. Nada se move até o lado que recebe apertar “Aceitar”, então responda a esse aviso lá e depois deixe as duas abas abertas até o contador de arquivos terminar.",
        },
      ],
      success: {
        label: "Como é um escaneamento bem-sucedido",
        body: [
          "No dispositivo que envia, o QR e a linha “Aguardando o outro dispositivo entrar…” dão lugar ao cartão conectado, e o selo de caminho nele indica “Retransmitido” — o valor esperado em uma sessão por código de emparelhamento, que passa pelo retransmissor TURN criptografado por decisão de projeto.",
          "O contador de arquivos vai então até o último arquivo nas duas telas. Nada da transferência muda em relação a um código digitado: o escaneamento só decidiu como o segundo dispositivo entrou na sala.",
        ],
        code: ["Retransmitido\nArquivo 1/1"],
      },
    },
    {
      heading: "O que acontece depois do escaneamento",
      body: [
        "Escanear apenas coloca os dois dispositivos na mesma sala; a transferência em si não muda em relação a qualquer outra sessão com código de emparelhamento. Quem criou o código é dono da sala e quem escaneou entrou nela, mas isso fala do encontro, não do sentido: com os dois lá dentro, qualquer um dos lados pode ser o que envia, e todo lote que chega continua passando pelo “Aceitar” na tela de quem recebe. A sala também é uma superfície própria e mais antiga: um código de emparelhamento coloca os dois dispositivos numa sala separada, e não na área de trabalho compartilhada que os dispositivos da mesma rede abrem, e ela vai só por retransmissor por decisão de projeto. Os dois navegadores derivam uma chave compartilhada com uma troca de chaves X25519, criptografam cada bloco com AES-256-GCM e o enviam por um canal WebRTC apoiado em um retransmissor TURN.",
        "Com a verificação avançada ativada (desligada por padrão), as duas telas mostram o mesmo código de verificação de seis dígitos (SAS) — olhe os dois e confirme que coincidem antes de confiar na conexão. A coincidência confirma que as chaves não foram substituídas: nenhum servidor ou retransmissor se fez passar por uma das pontas nem encerrou a criptografia de ponta a ponta da camada de aplicação. Uma transferência por código de emparelhamento segue sempre por esse retransmissor em vez de procurar antes um caminho direto: então ela não depende de encontrar uma rota direta através dos NATs e firewalls que existem entre as duas redes, que podem impedi-la. O retransmissor só encaminha texto cifrado — não tem chave nenhuma e nunca vê seus arquivos. Cada arquivo é verificado de ponta a ponta com um hash SHA-256, e uma conexão interrompida pode ser retomada em vez de recomeçar.",
      ],
    },
    {
      heading: "Se o escaneamento não funcionar",
      body: [
        "As câmeras falham, a iluminação está ruim, ou um dispositivo simplesmente não tem uma câmera à mão — nada disso deveria bloquear a transferência. O cartão de emparelhamento no dispositivo que envia também mostra botões para copiar o código bruto e o link (e um botão de compartilhamento nos dispositivos que o suportam), além de uma contagem regressiva até o código expirar.",
        "Digite o código de novo, cole o link, ou use o menu de compartilhamento para enviá-lo de outra forma (chat, AirDrop, o que for mais rápido) — cada caminho chega à mesma sala e obtém a mesma conexão criptografada. O QR é um entre vários pontos de entrada, nunca uma exigência.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O escaneamento abre a página e ela diz que o código de emparelhamento é inválido ou expirou.",
            code: ["https://relayium.com/cross-network   # o cartão de quem envia mostra a contagem ao vivo"],
            fix: "Os cinco minutos acabaram, e o QR de um código morto continua sendo um link morto por mais vezes que seja escaneado. Crie um código novo no dispositivo que envia — o cartão desenha um QR novo junto — e escaneie esse na hora.",
          },
          {
            symptom: "A câmera reconhece o quadrado mas nunca oferece abrir nada.",
            code: ["https://relayium.com/cross-network   # a caixa “Inserir um código de emparelhamento” aceita os seis dígitos"],
            fix: "Alguns leitores apenas copiam o texto em vez de entregá-lo a um navegador. Cole o que ele copiou na barra de endereços, ou dispense o QR: abra a página no dispositivo que recebe, digite os seis dígitos na caixa “Inserir um código de emparelhamento” e clique em “Conectar”.",
          },
          {
            symptom: "Os dois estão procurando um QR para escanear e nenhuma tela mostra um.",
            code: ["https://relayium.com/cross-network   # só o cartão que criou o código desenha um QR"],
            fix: "O QR pertence ao dispositivo que criou o código, então um precisa criar primeiro e o outro escanear. Decidam qual lado cria — enviar, depois que os dois estiverem na sala, pode ser qualquer um —, cliquem em “Criar um código de emparelhamento” nesse dispositivo e aponte a câmera do outro para aquela tela.",
          },
          {
            symptom: "O link foi repassado por um app de chat e a página abre sem código nenhum.",
            code: ["https://relayium.com/cross-network#c=483920   # tudo depois de #c= é o código"],
            fix: "O código viaja no fragmento da URL, e um reescritor de links ou serviço de prévia pode descartar tudo depois do #. Leia os seis dígitos em voz alta, ou cole você mesmo o link na barra de endereços para que nada o reescreva entre você e o navegador.",
          },
          {
            symptom: "O escaneamento entra na sala e depois o cartão diz que o retransmissor só é entregue a contas verificadas.",
            code: ["https://relayium.com/cross-network   # o cartão de emparelhamento nomeia o motivo da recusa"],
            fix: "O e-mail da conta que envia ainda não foi verificado, e isso é checado quando a sessão pede um retransmissor, não na criação do código. Verifique o endereço no painel da conta, crie então um código novo e escaneie o QR dele; transferências na mesma rede não dependem disso.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Quem escaneia o QR precisa de uma conta Relayium?",
        a: "Não. Só faz login o lado que cria o código de emparelhamento e o seu QR — a mesma exigência que um link de download assíncrono carrega. Quem escaneia apenas entra na sala que já foi criada: sem conta, sem cadastro, nada para instalar.",
      },
      {
        q: "O que o código QR contém de fato?",
        a: "O mesmo link de entrada que o botão “copiar link” copia — uma URL relayium.com com o código de emparelhamento embutido. Escaneá-lo apenas abre esse link no navegador, que entra na sala automaticamente. E para por aí: nenhum arquivo é escolhido nem enviado, e o que for enviado depois ainda precisa ser aceito no dispositivo que recebe.",
      },
      {
        q: "Escanear o QR é tão seguro quanto digitar o código?",
        a: "Sim, é a conexão idêntica de qualquer jeito. Os dois dispositivos ainda negociam uma troca de chaves X25519, criptografam com AES-256-GCM e, se a verificação avançada estiver ativada, mostram um código de verificação SAS coincidente que você pode conferir antes de confiar na transferência. O QR só muda como você entra na sala, não como a transferência é protegida.",
      },
      {
        q: "E se o QR não escanear?",
        a: "Nada se perde — o mesmo cartão de emparelhamento mostra o código bruto e um link copiável, e um botão de compartilhamento nos dispositivos compatíveis. Qualquer um deles abre a mesma sala que o QR.",
      },
      {
        q: "Isso funciona entre redes diferentes, como dados do celular e o Wi-Fi de casa?",
        a: "Sim. Este é o fluxo de emparelhamento entre redes, então funciona tanto se os dois dispositivos compartilharem uma rede como se não. Um código de emparelhamento sempre liga os dois por um retransmissor TURN criptografado — o caminho que não depende de encontrar uma passagem através dos NATs e firewalls que existem entre as redes, que podem impedir uma conexão direta — e esse retransmissor só carrega texto cifrado. Quem conecta diretamente são os dispositivos de uma mesma rede que se encontram sem código.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium, crie um código e tente escanear o QR com outro dispositivo — sem app nem conta para quem escaneia.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/transfer-files-by-scanning-a-qr-code",
  published: "2026-07-09",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
