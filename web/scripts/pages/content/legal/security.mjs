// web/scripts/pages/content/legal/security.mjs
const en = {
  title: "Security & Threat Model",
  description:
    "How Relayium protects your files and temporary text: per-session keys, authenticated encryption, SAS verification, direct and relayed paths, zero-knowledge download links, and an honest account of what we do and do not defend against.",
  updatedLabel: "Last updated",
  updated: "2026-08-02",
  otherDocLabel: "Privacy Policy",
  lead: [
    "Relayium is built so that the people transferring files or temporary text — not the server — hold the keys. This page describes exactly what is protected, how it works, and the limits of that protection.",
    "The short version: on the same network, realtime files and messages move directly between devices; across networks, browser sessions use a relay that carries only end-to-end encrypted ciphertext and holds no content key. Fresh session keys are always used; an optional out-of-band verification code lets the two people also detect signaling interception. The detail follows.",
  ],
  sections: [
    {
      heading: "Browser realtime file encryption (X25519 + AES-256-GCM)",
      body: [
        "For realtime file transfers in the browser, each transfer generates a fresh, ephemeral X25519 key pair on each device. The two browsers perform a key exchange to derive a shared AES-256-GCM key. Every file chunk is encrypted under that key with a unique nonce, so the signaling server — and any relay — sees ciphertext rather than file plaintext. CLI transfers use a different direct TLS 1.3 protocol described below.",
      ],
      bullets: [
        "Keys are ephemeral and per-transfer — nothing is reused across sessions.",
        "The shared key is derived on the two devices; it is never sent to, or stored on, any server.",
        "Encryption is applied at the application layer, on top of WebRTC's own transport security, so it holds even if the transport layer is compromised.",
      ],
    },
    {
      heading: "The verification code (SAS) — detecting a malicious server",
      body: [
        "WebRTC's built-in encryption (DTLS) exchanges key fingerprints through the signaling server, so a dishonest server could sit in the middle and swap keys. To catch this, Relayium derives a 6-digit Short Authentication String (SAS) from both sides' public keys and can show it on both screens. Matching codes provide the strongest interception check only when the two people compare them out of band. Showing that code and stopping to compare it is a preference — “advanced verification”, off by default, and `--verify` in the CLI. Turning it off changes what is displayed and which steps pause for confirmation; it does not change the encryption. The commit-then-reveal handshake below still runs on every connection and still refuses one whose reveal does not match, keys are still generated on your device and never sent to us, the relay still carries only ciphertext, and in the browser, receiving files still asks you before anything is saved — the native macOS app writes into its configured destination (Downloads by default) instead of asking. That prompt is about unsolicited writes to your disk, not about who is on the other end; only comparing the code establishes that.",
        "A plain 6-digit code (about 20 bits) could in principle be brute-forced by a relay racing to force a matching code. Relayium closes that gap with a commit-then-reveal handshake: each side first commits to its key by sending a hash, and only reveals the key after receiving the other side's commitment. CLI transfers use a separate SAS derived through a commit-then-reveal exchange of the pinned TLS certificate fingerprints; it too detects nothing unless someone actually compares it out of band, which is what `--verify` stops for.",
      ],
      bullets: [
        "For the strongest guarantee, turn on advanced verification and compare the code out of band — in person or over a voice call.",
        "If the two codes differ, stop the transfer: someone may be intercepting the connection.",
      ],
    },
    {
      heading: "Plaintext the server cannot see or decrypt",
      body: [
        "The service is designed so that our servers cannot see or decrypt the following plaintext:",
        "In browser realtime mode on the same network, file and message bytes flow directly between the two devices. Across networks they pass through TURN as ciphertext, and the relay holds no content key. The signaling service still handles connection-setup data and can see metadata such as public IP addresses, room membership, timing, a chosen device nickname, and presence.",
      ],
      bullets: [
        "The contents of your files.",
        "The names of your files.",
        "The plaintext of your text messages.",
        "Your encryption keys.",
      ],
    },
    {
      heading: "When browser files and text are relayed (TURN)",
      body: [
        "Browser file and text transfers across networks — pairing-code sessions, including their join links — run through a TURN server by design, not as a fallback. Restrictive NATs and firewalls make a genuinely direct path unlikely there, so the app forces the relay route outright. Same-network browser sessions receive no relay credentials and connect directly. CLI file and text transfers never use TURN: they are direct-only and fail if no direct path can be found.",
      ],
      bullets: [
        "The relay forwards only ciphertext — it cannot read your files or messages, which stay end-to-end encrypted.",
        "We record the number of relayed bytes per account, to enforce a monthly relay allowance and prevent abuse — we never inspect what is relayed, only the byte count.",
        "We never inspect relayed content.",
      ],
    },
    {
      heading: "Temporary text transfer",
      body: [
        "Browser text sessions use the Web protocol: the peers perform an ephemeral X25519 exchange and derive direction-separated AES-256-GCM subkeys in a domain separate from file-transfer keys. Each valid UTF-8 message is authenticated and encrypted as its own frame. Across networks, browser sessions use TURN by design; the relay carries ciphertext and has no message key. With advanced verification on, comparing the SAS out of band also detects signaling interception.",
        "CLI text is a different, direct-only protocol over pinned TLS 1.3. It does not use the browser X25519/AES message framing or TURN, and it fails when no direct path can be established. Message bodies are not stored by Relayium, but either endpoint can copy, log, screenshot, or otherwise retain text after receiving it.",
      ],
      bullets: [
        "Both people must be online; Relayium provides no offline text delivery or server-side message history.",
        "Servers necessarily handle connection metadata such as IP addresses, room membership, timing, device nickname and presence for browser sessions, and the account association used to create a pairing code where applicable.",
        "For TURN sessions, Relayium may record relayed byte counts for allowance enforcement and abuse prevention, but does not inspect message plaintext.",
      ],
    },
    {
      heading: "Stored download links — the key never leaves your browser",
      body: [
        "The optional download-link mode is for when the recipient is not online. Your browser encrypts the files with AES-256-GCM before anything is uploaded, and the decryption key is placed only in the URL fragment — the part after the # — which browsers never send to the server.",
      ],
      bullets: [
        "The server stores only ciphertext, plus the ciphertext size and timestamps for quota and cleanup — never plaintext, filenames, or keys.",
        "Anyone with the full link can decrypt, so treat the link like the file itself and share it over a trusted channel.",
        "Links can be set to expire (from 1 hour up to 14 days, depending on your plan) or to burn after the first complete download.",
      ],
    },
    {
      heading: "File integrity (SHA-256)",
      body: [
        "Beyond confidentiality, each file's integrity is verified. Every chunk carries an AES-GCM authentication tag, and a per-file SHA-256 hash is checked end-to-end on the receiving side, so a corrupted or tampered file is detected rather than silently accepted.",
      ],
    },
    {
      heading: "What Relayium does not protect against",
      body: [
        "End-to-end encryption protects data in transit between two honest endpoints. It cannot, by design, protect against:",
      ],
      bullets: [
        "A compromised device or browser on either end — malware, a hostile browser extension, or someone reading the screen.",
        "Metadata the server necessarily handles: session timing, relayed byte counts, and — for a stored download link or a pairing-code session — the account that created the link or code.",
        "A recipient choosing to retain, copy, or forward files or messages after receiving them.",
        "Sharing a download link over an untrusted channel, since the decryption key travels inside the link.",
      ],
    },
    {
      heading: "Browser support and its limits",
      body: [
        "Relayium runs in any modern browser with WebRTC over HTTPS. A few capabilities differ by browser:",
      ],
      bullets: [
        "Desktop Chrome and Edge have the File System Access API and stream large files straight to disk, with no practical memory ceiling.",
        "Firefox, Safari and every mobile browser (on iOS every browser is WebKit) lack that API and assemble the file in memory on the realtime path, so the app warns above roughly 256 MB — a deliberately conservative estimate, not a measured hard limit. For files that size, prefer desktop Chrome/Edge, or use the download-link mode, whose download page can additionally stream to disk through a service worker.",
        "WebRTC requires a secure context (HTTPS); the app will not connect over plain HTTP.",
      ],
    },
    {
      heading: "Open source and reporting issues",
      body: [
        "The protocol design and all client and server code are public on GitHub, so anyone can audit the cryptography, run their own server, or contribute. If you find a security issue, please report it privately through GitHub's vulnerability reporting on the repository, rather than opening a public issue.",
      ],
    },
  ],
};

const zh = {
  title: "安全与威胁模型",
  description:
    "Relayium 如何保护你的文件与临时文本：每次会话独立的密钥、认证加密、SAS 校验、直连与中继路径、零知识下载链接，以及对我们能防和不能防什么的坦诚说明。",
  updatedLabel: "最后更新",
  updated: "2026-08-02",
  otherDocLabel: "隐私政策",
  lead: [
    "Relayium 的设计宗旨是：掌握密钥的是传输文件或临时文本的双方，而不是服务器。本页说明究竟保护了什么、如何保护，以及这份保护的边界。",
    "一句话概括：同一网络中的实时文件与消息在设备间直接传输；跨网络浏览器会话使用只承载端到端加密密文且不持有内容密钥的中继。每次会话都会使用新密钥；此外还有一个可选的校验码，双方带外核对它就能发现信令拦截。以下是细节。",
  ],
  sections: [
    {
      heading: "浏览器实时文件加密（X25519 + AES-256-GCM）",
      body: [
        "浏览器进行实时文件传输时，每次传输都会在各自设备上重新生成一对临时的 X25519 密钥。两个浏览器通过密钥交换协商出共享的 AES-256-GCM 密钥。每个文件数据块都用该密钥配合唯一的随机数加密，因此信令服务器和任何中继看到的都是密文，而非文件明文。CLI 传输使用下文所述的另一套 TLS 1.3 直连协议。",
      ],
      bullets: [
        "密钥是临时的、每次传输独立——不会跨会话复用。",
        "共享密钥在两台设备上协商得出，绝不发送到或存储于任何服务器。",
        "加密施加在应用层，位于 WebRTC 自身传输层安全之上，因此即便传输层被攻破也依然有效。",
      ],
    },
    {
      heading: "校验码（SAS）——识破恶意服务器",
      body: [
        "WebRTC 自带的加密（DTLS）会通过信令服务器交换密钥指纹，因此不诚实的服务器可能居中调包密钥。为识破这种攻击，Relayium 从双方公钥推导出一段 6 位短校验码（SAS），并可以把它显示在两端屏幕上。只有双方通过带外渠道核对一致时，相同的校验码才提供最强的拦截检测保证。 是否显示这段码、是否停下来核对，是一个偏好设置——网页端叫「高级验证」，默认关闭；CLI 里是 `--verify`。关掉它改变的只是屏幕上显示什么、哪些步骤会停下来等你确认，不改变加密：下面的「先承诺后揭示」握手在每条连接上照常运行，揭示对不上就直接拒绝连接；密钥仍在你的设备上生成、从不发给我们；中继仍然只承载密文；在浏览器里，接收文件在写入任何内容之前仍会先询问你——原生 macOS 应用则直接写入它配置的保存位置（默认是「下载」文件夹）。这道询问防的是未经请求的写盘，而不是「对面是谁」；后者只有核对校验码才能确认。",
        "单纯的 6 位数字（约 20 比特）理论上可能被中继抢先暴力凑出一个相同的码。Relayium 用「先承诺后揭示」握手堵住这个缺口：双方先各自发送密钥的哈希作为承诺，收到对方的承诺后才揭示真正的密钥。CLI 传输使用另一套 SAS，它通过「先承诺后揭示」交换固定 TLS 证书指纹来推导；同样只有真的有人带外核对了才起作用，而 `--verify` 就是那个停下来核对的开关。",
      ],
      bullets: [
        "为获得最强的保证，请先打开高级验证，再通过带外渠道核对校验码——当面或语音通话。",
        "如果两边的码不一致，请立即停止传输：可能有人正在拦截连接。",
      ],
    },
    {
      heading: "服务器无法看到或解密的明文",
      body: [
        "本服务的设计确保服务器无法看到或解密以下明文：",
        "浏览器实时模式下，同一网络中的文件和消息字节在两台设备之间直接流动；跨网络时则以密文经过 TURN，中继不持有内容密钥。信令服务仍会处理建立连接所需的数据，并能看到公网 IP、房间归属、时间、你自选的设备昵称和在线状态等元数据。",
      ],
      bullets: [
        "你的文件内容。",
        "你的文件名。",
        "你的文本消息明文。",
        "你的加密密钥。",
      ],
    },
    {
      heading: "浏览器文件与文本何时会经中继转发（TURN）",
      body: [
        "浏览器的跨网络文件和文本传输——即配对码会话（含其生成的加入链接）——按设计经 TURN 服务器中继，而不是作为兜底手段。受限的 NAT 与防火墙让真正的直连希望渺茫，因此应用直接强制走中继路径。同一网络的浏览器会话不会获发中继凭证，走的是直连。CLI 文件和文本传输都不使用 TURN：它们只走直连，找不到直连路径就失败。",
      ],
      bullets: [
        "中继只转发密文——它无法读取你的文件或消息，内容始终保持端到端加密。",
        "我们按账号记录中继字节数，用于执行每月中继额度限制并防止滥用——我们绝不检查中继的内容，只记录字节数。",
        "我们绝不检查中继内容。",
      ],
    },
    {
      heading: "临时文本传输",
      body: [
        "浏览器文本会话使用 Web 协议：双方执行临时 X25519 密钥交换，并在独立于文件传输密钥的域中派生按方向隔离的 AES-256-GCM 子密钥。每条有效 UTF-8 消息都作为独立帧进行认证和加密。跨网络时，浏览器会话按设计使用 TURN；中继只承载密文，不持有消息密钥。打开高级验证后，再通过带外渠道核对 SAS，还能发现对信令的拦截。",
        "CLI 文本使用另一套经固定证书校验的 TLS 1.3 直连协议。它不使用浏览器的 X25519/AES 消息帧或 TURN，无法建立直连时就会失败。Relayium 不存储消息正文，但任一端点在收到文本后都可以复制、记录、截图或以其他方式留存。",
      ],
      bullets: [
        "双方必须同时在线；Relayium 不提供离线文本投递，也不保留服务器端消息历史。",
        "服务器必然会处理连接元数据，例如 IP 地址、房间归属、时间，浏览器会话的设备昵称与在线状态，以及适用时用于创建配对码的账号关联。",
        "对于 TURN 会话，Relayium 可能记录中继字节数以执行额度并防止滥用，但不会检查消息明文。",
      ],
    },
    {
      heading: "暂存下载链接——密钥绝不离开你的浏览器",
      body: [
        "可选的下载链接模式用于对方不在线的场景。你的浏览器在任何内容上传之前先用 AES-256-GCM 加密文件，而解密密钥只放在 URL 片段中——也就是 # 之后的部分——浏览器绝不会把它发送给服务器。",
      ],
      bullets: [
        "服务器只存储密文，外加用于配额与清理的密文大小和时间戳——绝不存明文、文件名或密钥。",
        "任何拿到完整链接的人都能解密，因此请把链接本身当作文件对待，通过可信渠道分享。",
        "链接可设置有效期（1 小时起，最长 14 天，取决于你的套餐），或设为首次完整下载后即焚。",
      ],
    },
    {
      heading: "文件完整性（SHA-256）",
      body: [
        "除了保密性，每个文件的完整性也会被校验。每个数据块都带有 AES-GCM 认证标签，接收端还会端到端校验每个文件的 SHA-256 哈希，因此损坏或被篡改的文件会被检出，而不会被悄悄接受。",
      ],
    },
    {
      heading: "Relayium 不能防范什么",
      body: [
        "端到端加密保护的是数据在两个诚实端点之间的传输过程。就设计而言，它无法防范：",
      ],
      bullets: [
        "任一端设备或浏览器被攻陷——恶意软件、恶意浏览器扩展，或有人偷看屏幕。",
        "服务器必然会接触到的元数据：会话时间、中继字节数，以及（若为暂存下载链接或配对码会话）创建链接或配对码的账号。",
        "接收方在收到文件或消息后选择留存、复制或转发。",
        "通过不可信渠道分享下载链接，因为解密密钥就在链接里。",
      ],
    },
    {
      heading: "浏览器支持及其限制",
      body: [
        "Relayium 可在任何支持 WebRTC 且经 HTTPS 访问的现代浏览器中运行。少数能力因浏览器而异：",
      ],
      bullets: [
        "桌面版 Chrome 与 Edge 具备 File System Access API，会把大文件直接流式写入磁盘，几乎没有内存上限。",
        "Firefox、Safari 以及所有手机浏览器（iOS 上的浏览器全都是 WebKit）没有这个 API，在实时接收路径上只能把文件攒在内存里，因此超过约 256 MB 时应用会先给出提示——这是一个刻意保守的估计值，而不是实测出来的硬上限。这个量级的文件建议改用桌面版 Chrome/Edge，或改走下载链接模式，其下载页还可以通过 service worker 流式落盘。",
        "WebRTC 需要安全上下文（HTTPS）；应用不会在纯 HTTP 下建立连接。",
      ],
    },
    {
      heading: "开源与问题上报",
      body: [
        "协议设计与全部前后端代码都在 GitHub 公开，任何人都能审查其密码学实现、自行运行服务器或参与贡献。如果你发现安全问题，请通过仓库上 GitHub 的私密漏洞上报渠道私下报告，而不要公开提交 issue。",
      ],
    },
  ],
};

const ja = {
  title: "セキュリティと脅威モデル",
  description:
    "Relayium がファイルと一時テキストを保護する仕組み：セッションごとの鍵、認証付き暗号、SAS 検証、直接・中継経路、ゼロ知識ダウンロードリンク、そして何を守り何を守らないかの率直な説明。",
  updatedLabel: "最終更新",
  updated: "2026-08-02",
  otherDocLabel: "プライバシーポリシー",
  lead: [
    "Relayium は、鍵を握るのはサーバーではなくファイルや一時テキストを転送する当事者であるように設計されています。このページでは、何がどのように保護されるのか、そしてその保護の限界を説明します。",
    "要点：同一ネットワークではリアルタイムのファイルとメッセージがデバイス間を直接流れます。ネットワークをまたぐブラウザセッションは、エンドツーエンド暗号化された暗号文だけを運びコンテンツ鍵を持たないリレーを使います。セッションごとの新しい鍵は常に使われます。加えて任意の検証コードがあり、帯域外で照合すればシグナリングの傍受も検出できます。以下に詳細を記します。",
  ],
  sections: [
    {
      heading: "ブラウザのリアルタイムファイル暗号化（X25519 + AES-256-GCM）",
      body: [
        "ブラウザのリアルタイムファイル転送では、転送ごとに各デバイスで新しい一時的な X25519 鍵ペアが生成されます。2 つのブラウザは鍵交換を行い、共有 AES-256-GCM 鍵を導出します。各ファイルチャンクはその鍵と一意のノンスで暗号化されるため、シグナリングサーバーや中継が目にするのはファイルの平文ではなく暗号文です。CLI 転送は後述する別の直接 TLS 1.3 プロトコルを使用します。",
      ],
      bullets: [
        "鍵は一時的で転送ごとに独立しており、セッションをまたいで再利用されることはありません。",
        "共有鍵は 2 台のデバイス上で導出され、いかなるサーバーにも送信・保存されません。",
        "暗号化は WebRTC 自身のトランスポート層セキュリティの上のアプリケーション層で適用されるため、トランスポート層が侵害されても有効性を保ちます。",
      ],
    },
    {
      heading: "検証コード（SAS）——悪意あるサーバーの検出",
      body: [
        "WebRTC 標準の暗号化（DTLS）は鍵のフィンガープリントをシグナリングサーバー経由で交換するため、不正なサーバーが中間に入り鍵をすり替える可能性があります。これを検出するため、Relayium は双方の公開鍵から 6 桁の Short Authentication String（SAS）を導出し、両方の画面に表示できます。一致するコードが最も強い傍受検出保証を与えるのは、両者が帯域外で照合した場合だけです。 このコードを表示して照合のために止まるかどうかは設定です——ウェブでは「高度な検証」（既定はオフ）、CLI では `--verify`。オフにして変わるのは、画面に何を表示するかと、どの手順が確認のために止まるかだけで、暗号化は変わりません。下記のコミット後開示ハンドシェイクはすべての接続で実行され、開示が一致しなければ接続を拒否します。鍵は端末上で生成され当社に送られることはなく、リレーが運ぶのは暗号文だけで、ブラウザではファイルの受信時に保存前の確認があります——ネイティブの macOS アプリは、設定された保存先（既定はダウンロードフォルダー）へ確認なしで書き込みます。この確認は勝手な書き込みを防ぐためのもので、相手が誰かを保証するものではありません。それを確かめられるのはコードの照合だけです。",
        "単純な 6 桁のコード（約 20 ビット）は、原理的には中継サーバーが一致するコードを総当たりで作り出す余地があります。Relayium はコミット後開示ハンドシェイクでこの隙を塞ぎます。各側はまず鍵のハッシュを送ってコミットし、相手のコミットメントを受け取ってから鍵を開示します。CLI 転送は、ピン留めされた TLS 証明書のフィンガープリントをコミット後開示で交換して導出する別の SAS を使用します。これも実際に誰かが帯域外で照合したときにだけ意味を持ち、そのために止まるのが `--verify` です。",
      ],
      bullets: [
        "最も強い保証を得るには、まず高度な検証をオンにし、コードを帯域外——対面または音声通話——で照合してください。",
        "2 つのコードが異なる場合は転送を中止してください。誰かが接続を傍受している可能性があります。",
      ],
    },
    {
      heading: "サーバーが見たり復号したりできない平文",
      body: [
        "本サービスは、サーバーが以下の平文を見たり復号したりできないように設計されています：",
        "ブラウザのリアルタイムモードでは、同一ネットワークのファイルとメッセージの実体は 2 台のデバイス間を直接流れます。ネットワークをまたぐ場合は暗号文として TURN を経由し、リレーはコンテンツ鍵を持ちません。一方、シグナリングサービスは接続確立データを扱い、公開 IP、ルーム所属、時刻、選択したデバイス名、在席状況などのメタデータを見ることができます。",
      ],
      bullets: [
        "ファイルの内容。",
        "ファイルの名前。",
        "テキストメッセージの平文。",
        "お客様の暗号鍵。",
      ],
    },
    {
      heading: "ブラウザのファイルとテキストが中継される場合（TURN）",
      body: [
        "ブラウザでネットワークをまたぐファイルとテキストの転送——ペアリングコードのセッション（その参加リンクを含む）——は、フォールバックではなく設計上 TURN サーバー経由で中継されます。制限の厳しい NAT やファイアウォールのため、アプリは最初からリレー経路を強制します。同一ネットワークのブラウザセッションには中継用資格情報が発行されず、直接接続します。CLI のファイルとテキスト転送は TURN を使わず、直接接続のみで、直接の経路が見つからなければ失敗します。",
      ],
      bullets: [
        "中継サーバーは暗号文のみを転送します。ファイルやメッセージを読むことはできず、エンドツーエンド暗号化が維持されます。",
        "月間中継割り当ての管理と不正利用の防止のため、中継バイト数はアカウントごとに記録します——中継内容を検査することはなく、記録するのはバイト数のみです。",
        "中継されたコンテンツを検査することはありません。",
      ],
    },
    {
      heading: "一時テキスト転送",
      body: [
        "ブラウザのテキストセッションは Web プロトコルを使用します。ピアは一時的な X25519 鍵交換を行い、ファイル転送鍵とは別のドメインで方向ごとに分離された AES-256-GCM サブ鍵を導出します。有効な UTF-8 メッセージはそれぞれ独立したフレームとして認証・暗号化されます。ネットワークをまたぐブラウザセッションは設計上 TURN を使用し、リレーは暗号文のみを運びメッセージ鍵を持ちません。高度な検証をオンにして SAS を帯域外で照合すれば、シグナリングの傍受も検出できます。",
        "CLI テキストは、証明書をピン留めした TLS 1.3 上の別の直接接続専用プロトコルです。ブラウザの X25519/AES メッセージフレームや TURN は使わず、直接経路を確立できなければ失敗します。Relayium はメッセージ本文を保存しませんが、受信後はいずれのエンドポイントもテキストをコピー、記録、スクリーンショットその他の方法で保持できます。",
      ],
      bullets: [
        "双方が同時にオンラインである必要があります。Relayium はテキストのオフライン配信もサーバー側のメッセージ履歴も提供しません。",
        "サーバーは接続に必要なメタデータを処理します。これには IP アドレス、ルーム所属、時刻、ブラウザセッションのデバイス名と在席状況、および該当する場合はペアリングコード作成に使われたアカウントとの関連付けが含まれます。",
        "TURN セッションでは、割り当ての管理と不正利用防止のために中継バイト数を記録する場合がありますが、メッセージの平文を検査することはありません。",
      ],
    },
    {
      heading: "一時保存ダウンロードリンク——鍵はブラウザから出ない",
      body: [
        "オプションのダウンロードリンクモードは、受信者がオンラインでない場合のためのものです。ブラウザは何かがアップロードされる前にファイルを AES-256-GCM で暗号化し、復号鍵は URL フラグメント——# より後ろの部分——にのみ置かれます。ブラウザはこれをサーバーに送信しません。",
      ],
      bullets: [
        "サーバーが保存するのは暗号文と、クォータおよびクリーンアップのための暗号文サイズとタイムスタンプだけで、平文・ファイル名・鍵は決して保存しません。",
        "完全なリンクを持つ人は誰でも復号できるため、リンクをファイルそのものと同様に扱い、信頼できる経路で共有してください。",
        "リンクには有効期限（1 時間から最長 14 日、プランにより異なります）を設定するか、最初の完全なダウンロード後に消える設定にできます。",
      ],
    },
    {
      heading: "ファイル整合性（SHA-256）",
      body: [
        "機密性に加えて、各ファイルの整合性も検証されます。各チャンクには AES-GCM の認証タグが付き、受信側ではファイルごとの SHA-256 ハッシュがエンドツーエンドで照合されるため、破損・改ざんされたファイルは黙って受け入れられるのではなく検出されます。",
      ],
    },
    {
      heading: "Relayium が防げないこと",
      body: [
        "エンドツーエンド暗号化は、2 つの誠実なエンドポイント間の転送中のデータを保護します。設計上、次のものは防げません：",
      ],
      bullets: [
        "いずれかの端末側のデバイスやブラウザの侵害——マルウェア、悪意ある拡張機能、あるいは画面を覗き見る人。",
        "サーバーが必然的に扱うメタデータ：セッション時刻、中継バイト数、そして（保存型ダウンロードリンクまたはペアリングコードのセッションでは）リンクやコードを作成したアカウント。",
        "受信者がファイルやメッセージを受け取った後に保持、コピー、転送することを選ぶこと。",
        "復号鍵がリンク内に含まれるため、信頼できない経路でダウンロードリンクを共有すること。",
      ],
    },
    {
      heading: "ブラウザ対応とその限界",
      body: [
        "Relayium は、HTTPS 経由で WebRTC が使える最新ブラウザで動作します。一部の機能はブラウザによって異なります：",
      ],
      bullets: [
        "デスクトップ版の Chrome と Edge は File System Access API を備えており、大きなファイルをディスクへ直接ストリーミングするため、実質的なメモリ上限はありません。",
        "Firefox と Safari、そしてすべてのモバイルブラウザ（iOS ではどのブラウザも WebKit です）はこの API を持たず、リアルタイム受信の経路ではファイルをメモリ上で組み立てます。そのため、およそ 256 MB を超えるとアプリが事前に警告します——これは実測した上限ではなく、意図的に控えめに置いた見積もりです。その規模のファイルにはデスクトップ版の Chrome/Edge を使うか、ダウンロードリンクモードをご利用ください。後者のダウンロードページは service worker 経由でディスクへ流し込むこともできます。",
        "WebRTC はセキュアコンテキスト（HTTPS）を必要とします。アプリは平文の HTTP では接続しません。",
      ],
    },
    {
      heading: "オープンソースと問題の報告",
      body: [
        "プロトコル設計とクライアント・サーバーの全コードは GitHub で公開されており、誰でも暗号方式を監査し、自分のサーバーを運用し、貢献できます。セキュリティ上の問題を見つけた場合は、公開の issue を作成するのではなく、リポジトリの GitHub 非公開脆弱性報告を通じて非公開でご報告ください。",
      ],
    },
  ],
};

const ko = {
  title: "보안 및 위협 모델",
  description:
    "Relayium이 파일과 임시 텍스트를 보호하는 방식: 세션별 키, 인증된 암호화, SAS 검증, 직접 및 중계 경로, 영지식 다운로드 링크, 그리고 무엇을 방어하고 무엇을 방어하지 않는지에 대한 솔직한 설명.",
  updatedLabel: "최종 업데이트",
  updated: "2026-08-02",
  otherDocLabel: "개인정보 처리방침",
  lead: [
    "Relayium은 서버가 아니라 파일이나 임시 텍스트를 전송하는 당사자가 키를 갖도록 설계되었습니다. 이 페이지에서는 무엇이 어떻게 보호되는지, 그리고 그 보호의 한계를 설명합니다.",
    "요약하면: 같은 네트워크에서는 실시간 파일과 메시지가 기기 사이를 직접 이동합니다. 네트워크 간 브라우저 세션은 종단간 암호문만 운반하고 콘텐츠 키는 갖지 않는 릴레이를 사용합니다. 세션마다 새 키가 항상 사용되며, 여기에 선택적인 검증 코드를 대역 외로 비교하면 시그널링 가로채기까지 탐지할 수 있습니다. 자세한 내용은 아래와 같습니다.",
  ],
  sections: [
    {
      heading: "브라우저 실시간 파일 암호화(X25519 + AES-256-GCM)",
      body: [
        "브라우저의 실시간 파일 전송에서는 전송마다 각 기기에서 새로운 임시 X25519 키 쌍이 생성됩니다. 두 브라우저는 키 교환을 수행하여 공유 AES-256-GCM 키를 도출합니다. 각 파일 청크는 그 키와 고유한 논스로 암호화되므로 시그널링 서버와 릴레이는 파일 평문이 아닌 암호문을 봅니다. CLI 전송은 아래에 설명된 별도의 직접 TLS 1.3 프로토콜을 사용합니다.",
      ],
      bullets: [
        "키는 임시적이며 전송마다 별개입니다 — 세션 간에 재사용되지 않습니다.",
        "공유 키는 두 기기에서 도출되며, 어떤 서버로도 전송되거나 저장되지 않습니다.",
        "암호화는 WebRTC 자체의 전송 계층 보안 위, 애플리케이션 계층에서 적용되므로 전송 계층이 침해되어도 유효성을 유지합니다.",
      ],
    },
    {
      heading: "검증 코드(SAS) — 악의적인 서버 탐지",
      body: [
        "WebRTC 내장 암호화(DTLS)는 키 지문을 시그널링 서버를 통해 교환하므로, 정직하지 않은 서버가 중간에 끼어들어 키를 바꿔치기할 수 있습니다. 이를 탐지하기 위해 Relayium은 양쪽 공개 키에서 6자리 Short Authentication String(SAS)을 도출해 두 화면에 표시할 수 있습니다. 일치하는 코드가 가장 강한 가로채기 탐지 보장을 제공하려면 두 사람이 반드시 대역 외로 비교해야 합니다. 이 코드를 표시하고 대조를 위해 멈출지는 설정입니다 — 웹에서는 «고급 검증»(기본값 꺼짐), CLI에서는 `--verify`. 끄면 화면에 무엇을 보여줄지와 어떤 단계에서 확인을 위해 멈출지만 달라지며, 암호화는 달라지지 않습니다. 아래의 커밋 후 공개 핸드셰이크는 모든 연결에서 실행되고 공개 값이 맞지 않으면 연결을 거부합니다. 키는 기기에서 생성되어 저희에게 전송되지 않고, 릴레이는 암호문만 운반하며, 브라우저에서는 파일 수신 시 저장 전에 확인을 요청합니다 — 네이티브 macOS 앱은 묻지 않고 설정된 저장 위치(기본값은 다운로드 폴더)에 바로 저장합니다. 이 확인은 원치 않는 디스크 쓰기를 막기 위한 것이지 상대가 누구인지 보장하지 않으며, 그것은 코드 대조만이 확인해 줍니다.",
        "단순한 6자리 코드(약 20비트)는 원칙적으로 중계 서버가 일치하는 코드를 무차별 대입으로 만들어낼 여지가 있습니다. Relayium은 커밋 후 공개 핸드셰이크로 이 틈을 막습니다. 각 측은 먼저 키 해시로 커밋하고 상대방의 커밋을 받은 뒤 키를 공개합니다. CLI 전송은 고정된 TLS 인증서 지문을 커밋 후 공개 방식으로 교환해 도출하는 별도의 SAS를 사용합니다. 이 코드도 실제로 누군가 대역 외로 비교할 때만 의미가 있으며, 그 대조를 위해 멈추는 것이 `--verify`입니다.",
      ],
      bullets: [
        "가장 강력한 보장을 위해서는 먼저 고급 검증을 켠 다음 코드를 대역 외로 — 직접 만나거나 음성 통화로 — 대조하십시오.",
        "두 코드가 다르면 전송을 중단하십시오. 누군가 연결을 가로채고 있을 수 있습니다.",
      ],
    },
    {
      heading: "서버가 보거나 복호화할 수 없는 평문",
      body: [
        "본 서비스는 서버가 다음 평문을 보거나 복호화할 수 없도록 설계되었습니다:",
        "브라우저 실시간 모드에서 같은 네트워크의 파일과 메시지 데이터는 두 기기 사이에서 직접 흐릅니다. 네트워크를 넘을 때는 암호문으로 TURN을 통과하며 릴레이는 콘텐츠 키를 갖지 않습니다. 다만 시그널링 서비스는 연결 설정 데이터를 처리하며 공개 IP, 룸 소속, 시각, 사용자가 선택한 기기 별칭과 접속 상태 같은 메타데이터를 볼 수 있습니다.",
      ],
      bullets: [
        "파일의 내용.",
        "파일의 이름.",
        "텍스트 메시지의 평문.",
        "사용자의 암호화 키.",
      ],
    },
    {
      heading: "브라우저 파일과 텍스트가 중계될 때(TURN)",
      body: [
        "브라우저의 네트워크 간 파일 및 텍스트 전송 — 페어링 코드 세션과 참여 링크 — 은 대체 수단이 아니라 설계상 TURN 서버를 거칩니다. 제한적인 NAT과 방화벽 때문에 앱은 처음부터 릴레이 경로를 강제합니다. 같은 네트워크의 브라우저 세션에는 중계 자격 증명이 발급되지 않고 직접 연결됩니다. CLI 파일과 텍스트 전송은 TURN을 사용하지 않으며 직접 연결만 쓰고, 직접 경로를 찾지 못하면 실패합니다.",
      ],
      bullets: [
        "중계 서버는 암호문만 전달합니다. 파일이나 메시지를 읽을 수 없으며 종단간 암호화가 유지됩니다.",
        "월간 릴레이 허용량을 적용하고 남용을 방지하기 위해 계정별로 릴레이된 바이트 수를 기록합니다——중계 내용은 절대 검사하지 않으며, 오직 바이트 수만 기록합니다.",
        "중계된 콘텐츠를 검사하지 않습니다.",
      ],
    },
    {
      heading: "임시 텍스트 전송",
      body: [
        "브라우저 텍스트 세션은 Web 프로토콜을 사용합니다. 피어는 임시 X25519 교환을 수행하고 파일 전송 키와 분리된 도메인에서 방향별 AES-256-GCM 하위 키를 도출합니다. 유효한 UTF-8 메시지는 각각 독립된 프레임으로 인증되고 암호화됩니다. 네트워크를 넘는 브라우저 세션은 설계상 TURN을 사용하며, 릴레이는 암호문만 전달하고 메시지 키를 갖지 않습니다. 고급 검증을 켠 뒤 SAS를 대역 외로 비교하면 시그널링 가로채기까지 탐지할 수 있습니다.",
        "CLI 텍스트는 인증서를 고정한 TLS 1.3 위의 별도 직접 연결 전용 프로토콜입니다. 브라우저의 X25519/AES 메시지 프레이밍이나 TURN을 사용하지 않으며, 직접 경로를 만들 수 없으면 실패합니다. Relayium은 메시지 본문을 저장하지 않지만, 어느 엔드포인트든 수신 후 텍스트를 복사, 기록, 캡처하거나 다른 방식으로 보관할 수 있습니다.",
      ],
      bullets: [
        "두 사람 모두 동시에 온라인이어야 하며, Relayium은 오프라인 텍스트 전달이나 서버 측 메시지 기록을 제공하지 않습니다.",
        "서버는 IP 주소, 룸 소속, 시각, 브라우저 세션의 기기 별칭과 접속 상태, 해당되는 경우 페어링 코드를 만든 계정 연결 등 접속에 필요한 메타데이터를 처리합니다.",
        "TURN 세션에서는 허용량 적용과 남용 방지를 위해 중계 바이트 수를 기록할 수 있지만 메시지 평문은 검사하지 않습니다.",
      ],
    },
    {
      heading: "임시 보관 다운로드 링크 — 키는 브라우저를 떠나지 않습니다",
      body: [
        "선택적 다운로드 링크 모드는 수신자가 온라인이 아닐 때를 위한 것입니다. 브라우저는 무언가 업로드되기 전에 파일을 AES-256-GCM으로 암호화하며, 복호화 키는 URL 프래그먼트 — # 뒤 부분 — 에만 놓입니다. 브라우저는 이를 서버로 보내지 않습니다.",
      ],
      bullets: [
        "서버는 암호문과, 할당량 및 정리를 위한 암호문 크기와 타임스탬프만 저장하며, 평문·파일 이름·키는 절대 저장하지 않습니다.",
        "완전한 링크를 가진 사람은 누구나 복호화할 수 있으므로, 링크를 파일 자체처럼 취급하고 신뢰할 수 있는 경로로 공유하십시오.",
        "링크는 만료(1시간부터 최대 14일까지, 요금제에 따라 다름)를 설정하거나 첫 번째 완전한 다운로드 후 소멸되도록 설정할 수 있습니다.",
      ],
    },
    {
      heading: "파일 무결성(SHA-256)",
      body: [
        "기밀성뿐만 아니라 각 파일의 무결성도 검증됩니다. 각 청크에는 AES-GCM 인증 태그가 있고, 수신 측에서는 파일별 SHA-256 해시를 종단간으로 확인하므로, 손상되거나 변조된 파일은 조용히 수용되는 대신 탐지됩니다.",
      ],
    },
    {
      heading: "Relayium이 방어하지 못하는 것",
      body: [
        "종단간 암호화는 정직한 두 엔드포인트 사이의 전송 중 데이터를 보호합니다. 설계상 다음은 방어할 수 없습니다:",
      ],
      bullets: [
        "어느 한쪽 기기나 브라우저의 침해 — 멀웨어, 악성 브라우저 확장 프로그램, 또는 화면을 훔쳐보는 사람.",
        "서버가 필연적으로 다루는 메타데이터: 세션 시각, 중계 바이트 수, 그리고 저장형 다운로드 링크나 페어링 코드 세션의 경우 링크 또는 코드를 만든 계정.",
        "수신자가 파일이나 메시지를 받은 후 보관, 복사 또는 전달하기로 선택하는 것.",
        "복호화 키가 링크 안에 담겨 이동하므로, 신뢰할 수 없는 경로로 다운로드 링크를 공유하는 것.",
      ],
    },
    {
      heading: "브라우저 지원과 그 한계",
      body: [
        "Relayium은 HTTPS를 통해 WebRTC를 사용할 수 있는 모든 최신 브라우저에서 작동합니다. 일부 기능은 브라우저에 따라 다릅니다:",
      ],
      bullets: [
        "데스크톱 Chrome과 Edge는 File System Access API가 있어 큰 파일을 디스크로 직접 스트리밍하며, 실질적인 메모리 상한이 없습니다.",
        "Firefox와 Safari, 그리고 모든 모바일 브라우저(iOS에서는 어떤 브라우저든 WebKit입니다)에는 그 API가 없어 실시간 수신 경로에서는 파일을 메모리에서 조립합니다. 그래서 약 256MB를 넘으면 앱이 미리 경고합니다 — 실측한 한계가 아니라 일부러 보수적으로 잡은 추정값입니다. 그 정도 크기의 파일에는 데스크톱 Chrome/Edge를 사용하거나 다운로드 링크 모드를 이용하십시오. 다운로드 링크의 내려받기 페이지는 service worker를 통해 디스크로 흘려보낼 수도 있습니다.",
        "WebRTC는 보안 컨텍스트(HTTPS)를 요구합니다. 앱은 일반 HTTP에서는 연결되지 않습니다.",
      ],
    },
    {
      heading: "오픈 소스 및 문제 신고",
      body: [
        "프로토콜 설계와 클라이언트·서버의 모든 코드는 GitHub에 공개되어 있어 누구나 암호화를 감사하고, 자신의 서버를 운영하고, 기여할 수 있습니다. 보안 문제를 발견하면 공개 이슈를 여는 대신 저장소의 GitHub 비공개 취약점 신고를 통해 비공개로 신고해 주십시오.",
      ],
    },
  ],
};

const de = {
  title: "Sicherheit & Bedrohungsmodell",
  description:
    "Wie Relayium Ihre Dateien und temporären Texte schützt: sitzungsbezogene Schlüssel, authentifizierte Verschlüsselung, SAS-Verifizierung, direkte und weitergeleitete Wege, Zero-Knowledge-Download-Links und eine ehrliche Darstellung der Schutzgrenzen.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-08-02",
  otherDocLabel: "Datenschutzerklärung",
  lead: [
    "Relayium ist so gebaut, dass die Personen, die Dateien oder temporäre Texte übertragen — nicht der Server — die Schlüssel besitzen. Diese Seite beschreibt genau, was geschützt ist, wie es funktioniert und wo die Grenzen dieses Schutzes liegen.",
    "Kurz gesagt: Im selben Netzwerk fließen Echtzeitdateien und -nachrichten direkt zwischen Geräten. Netzwerkübergreifende Browsersitzungen nutzen ein Relay, das nur Ende-zu-Ende-verschlüsselten Chiffretext transportiert und keinen Inhaltsschlüssel besitzt. Frische Sitzungsschlüssel gibt es immer; ein optionaler, außerhalb des Kanals verglichener Prüfcode hilft beiden Personen zusätzlich, Eingriffe in die Signalisierung zu erkennen. Es folgen die Details.",
  ],
  sections: [
    {
      heading: "Browser-Echtzeitverschlüsselung für Dateien (X25519 + AES-256-GCM)",
      body: [
        "Bei Echtzeit-Dateiübertragungen im Browser erzeugt jede Übertragung auf jedem Gerät ein frisches, kurzlebiges X25519-Schlüsselpaar. Die beiden Browser führen einen Schlüsselaustausch durch und leiten einen gemeinsamen AES-256-GCM-Schlüssel ab. Jeder Datei-Chunk wird mit diesem Schlüssel und einer eindeutigen Nonce verschlüsselt, sodass Signalisierungsserver und Relay Chiffretext statt Dateiklartext sehen. CLI-Übertragungen verwenden ein anderes direktes TLS-1.3-Protokoll, das unten beschrieben wird.",
      ],
      bullets: [
        "Schlüssel sind kurzlebig und pro Übertragung eigenständig — nichts wird über Sitzungen hinweg wiederverwendet.",
        "Der gemeinsame Schlüssel wird auf den beiden Geräten abgeleitet; er wird nie an einen Server gesendet oder dort gespeichert.",
        "Die Verschlüsselung erfolgt auf der Anwendungsebene, oberhalb der Transportsicherheit von WebRTC, und bleibt daher selbst dann wirksam, wenn die Transportebene kompromittiert wird.",
      ],
    },
    {
      heading: "Der Verifizierungscode (SAS) — einen bösartigen Server erkennen",
      body: [
        "Die eingebaute Verschlüsselung von WebRTC (DTLS) tauscht Schlüssel-Fingerabdrücke über den Signalisierungsserver aus, sodass ein unehrlicher Server sich dazwischenschalten und Schlüssel austauschen könnte. Relayium leitet deshalb aus den öffentlichen Schlüsseln beider Seiten einen 6-stelligen Short Authentication String (SAS) ab, der auf beiden Bildschirmen angezeigt werden kann. Übereinstimmende Codes bieten nur dann die stärkste Erkennung eines Eingriffs, wenn beide Personen sie außerhalb des Kanals vergleichen. Ob dieser Code angezeigt wird und ob für den Vergleich angehalten wird, ist eine Einstellung — im Web „erweiterte Verifizierung“ (standardmäßig aus), in der CLI `--verify`. Ausgeschaltet ändert sie, was angezeigt wird und welche Schritte für eine Bestätigung pausieren; an der Verschlüsselung ändert sie nichts. Der Commit-dann-Offenlegen-Handshake unten läuft auf jeder Verbindung und weist eine Verbindung mit nicht passender Offenlegung ab, Schlüssel entstehen weiterhin auf deinem Gerät und gehen nie an uns, das Relay trägt weiterhin nur Chiffretext, und im Browser wird beim Empfang von Dateien weiterhin vor dem Speichern gefragt — die native macOS-App schreibt stattdessen ohne Rückfrage in ihren eingestellten Zielordner (standardmäßig „Downloads“). Diese Rückfrage verhindert ungefragtes Schreiben auf die Festplatte; wer am anderen Ende sitzt, klärt allein der Codevergleich.",
        "Ein bloßer 6-stelliger Code (etwa 20 Bit) ließe sich im Prinzip durch Brute Force erzwingen. Relayium schließt diese Lücke mit einem Commit-dann-Offenlegen-Handshake. CLI-Übertragungen verwenden einen separaten SAS, der durch einen Commit-dann-Offenlegen-Austausch der gepinnten TLS-Zertifikat-Fingerabdrücke abgeleitet wird; auch er erkennt nur dann etwas, wenn ihn jemand tatsächlich außerhalb des Kanals vergleicht — dafür hält `--verify` an.",
      ],
      bullets: [
        "Für die stärkste Garantie schalten Sie die erweiterte Verifizierung ein und vergleichen den Code außerhalb des Kanals — persönlich oder per Sprachanruf.",
        "Wenn die beiden Codes abweichen, brechen Sie die Übertragung ab: Möglicherweise fängt jemand die Verbindung ab.",
      ],
    },
    {
      heading: "Klartext, den der Server weder sehen noch entschlüsseln kann",
      body: [
        "Der Dienst ist so gestaltet, dass unsere Server den folgenden Klartext weder sehen noch entschlüsseln können:",
        "Im Browser-Echtzeitmodus fließen Datei- und Nachrichtendaten im selben Netzwerk direkt zwischen den Geräten. Netzwerkübergreifend passieren sie TURN als Chiffretext; das Relay besitzt keinen Inhaltsschlüssel. Der Signalisierungsdienst verarbeitet dennoch Verbindungsdaten und kann Metadaten wie öffentliche IP-Adressen, Raumzugehörigkeit, Zeitpunkt, gewählten Gerätenamen und Anwesenheit sehen.",
      ],
      bullets: [
        "Den Inhalt Ihrer Dateien.",
        "Die Namen Ihrer Dateien.",
        "Den Klartext Ihrer Textnachrichten.",
        "Ihre Verschlüsselungsschlüssel.",
      ],
    },
    {
      heading: "Wenn Browser-Dateien und -Texte weitergeleitet werden (TURN)",
      body: [
        "Netzwerkübergreifende Datei- und Textübertragungen im Browser — Pairing-Code-Sitzungen einschließlich ihrer Beitrittslinks — laufen konstruktionsbedingt über TURN, nicht als Rückfall. Wegen restriktiver NATs und Firewalls erzwingt die App den Relay-Weg von Anfang an. Browser-Sitzungen im selben Netzwerk erhalten keine Relay-Anmeldedaten und verbinden sich direkt. Datei- und Textübertragungen der CLI verwenden nie TURN; sie sind ausschließlich direkt und schlagen fehl, wenn kein direkter Weg gefunden wird.",
      ],
      bullets: [
        "Die Weiterleitung übermittelt nur Chiffretext — sie kann Ihre Dateien oder Nachrichten nicht lesen, die Ende-zu-Ende-verschlüsselt bleiben.",
        "Wir erfassen die Anzahl weitergeleiteter Bytes pro Konto, um ein monatliches Weiterleitungskontingent durchzusetzen und Missbrauch zu verhindern — wir sehen niemals ein, was weitergeleitet wird, sondern nur die Byte-Anzahl.",
        "Weitergeleitete Inhalte sehen wir nie ein.",
      ],
    },
    {
      heading: "Temporäre Textübertragung",
      body: [
        "Text-Sitzungen im Browser verwenden das Web-Protokoll: Die Peers führen einen kurzlebigen X25519-Austausch durch und leiten richtungsgetrennte AES-256-GCM-Unterschlüssel in einer von Dateiübertragungsschlüsseln getrennten Domäne ab. Jede gültige UTF-8-Nachricht wird als eigener Frame authentifiziert und verschlüsselt. Netzwerkübergreifend verwenden Browser-Sitzungen konstruktionsbedingt TURN; das Relay trägt Chiffretext und besitzt keinen Nachrichtenschlüssel. Mit eingeschalteter erweiterter Verifizierung erkennt ein Vergleich des SAS außerhalb des Kanals zusätzlich einen Eingriff in die Signalisierung.",
        "CLI-Text nutzt ein anderes, ausschließlich direktes Protokoll über TLS 1.3 mit Zertifikat-Pinning. Es verwendet weder das X25519/AES-Nachrichtenformat des Browsers noch TURN und schlägt fehl, wenn kein direkter Weg aufgebaut werden kann. Relayium speichert keine Nachrichteninhalte, aber beide Endpunkte können empfangenen Text kopieren, protokollieren, als Bildschirmfoto aufnehmen oder anderweitig behalten.",
      ],
      bullets: [
        "Beide Personen müssen gleichzeitig online sein; Relayium bietet weder Offline-Textzustellung noch einen serverseitigen Nachrichtenverlauf.",
        "Server verarbeiten notwendige Verbindungsmetadaten wie IP-Adressen, Raumzugehörigkeit, Zeitpunkt, Gerätename und Anwesenheit bei Browser-Sitzungen sowie gegebenenfalls die Kontozuordnung zur Erstellung eines Pairing-Codes.",
        "Bei TURN-Sitzungen kann Relayium weitergeleitete Byte-Anzahlen zur Kontingentdurchsetzung und Missbrauchsprävention erfassen, prüft aber keinen Nachrichtenklartext.",
      ],
    },
    {
      heading: "Zwischengespeicherte Download-Links — der Schlüssel verlässt Ihren Browser nie",
      body: [
        "Der optionale Download-Link-Modus ist für den Fall gedacht, dass der Empfänger nicht online ist. Ihr Browser verschlüsselt die Dateien mit AES-256-GCM, bevor irgendetwas hochgeladen wird, und der Entschlüsselungsschlüssel wird ausschließlich im URL-Fragment abgelegt — dem Teil nach dem # —, das Browser nie an den Server senden.",
      ],
      bullets: [
        "Der Server speichert nur Chiffretext sowie die Chiffretextgröße und Zeitstempel für Kontingent und Bereinigung — niemals Klartext, Dateinamen oder Schlüssel.",
        "Jeder mit dem vollständigen Link kann entschlüsseln; behandeln Sie den Link daher wie die Datei selbst und teilen Sie ihn über einen vertrauenswürdigen Kanal.",
        "Links können so eingestellt werden, dass sie ablaufen (von 1 Stunde bis zu 14 Tagen, je nach Tarif) oder nach dem ersten vollständigen Download verfallen.",
      ],
    },
    {
      heading: "Dateiintegrität (SHA-256)",
      body: [
        "Über die Vertraulichkeit hinaus wird die Integrität jeder Datei überprüft. Jeder Chunk trägt ein AES-GCM-Authentifizierungs-Tag, und ein SHA-256-Hash pro Datei wird Ende-zu-Ende auf der Empfängerseite überprüft, sodass eine beschädigte oder manipulierte Datei erkannt und nicht stillschweigend akzeptiert wird.",
      ],
    },
    {
      heading: "Wovor Relayium nicht schützt",
      body: [
        "Ende-zu-Ende-Verschlüsselung schützt Daten während der Übertragung zwischen zwei ehrlichen Endpunkten. Konstruktionsbedingt kann sie nicht schützen vor:",
      ],
      bullets: [
        "Einem kompromittierten Gerät oder Browser an einem der beiden Enden — Schadsoftware, einer bösartigen Browsererweiterung oder jemandem, der auf den Bildschirm sieht.",
        "Metadaten, die der Server zwangsläufig verarbeitet: Sitzungszeitpunkt, weitergeleitete Byte-Anzahl und — bei einem gespeicherten Download-Link oder einer Pairing-Code-Sitzung — das Konto, das den Link oder Code erstellt hat.",
        "Einem Empfänger, der Dateien oder Nachrichten nach Erhalt behält, kopiert oder weiterleitet.",
        "Dem Teilen eines Download-Links über einen nicht vertrauenswürdigen Kanal, da der Entschlüsselungsschlüssel im Link mitreist.",
      ],
    },
    {
      heading: "Browserunterstützung und ihre Grenzen",
      body: [
        "Relayium läuft in jedem modernen Browser mit WebRTC über HTTPS. Einige Fähigkeiten unterscheiden sich je nach Browser:",
      ],
      bullets: [
        "Chrome und Edge auf dem Desktop verfügen über die File System Access API und streamen große Dateien direkt auf die Festplatte, ohne praktische Speicherobergrenze.",
        "Firefox, Safari und alle mobilen Browser (auf iOS ist jeder Browser WebKit) haben diese API nicht und setzen die Datei auf dem Echtzeitpfad im Arbeitsspeicher zusammen; ab etwa 256 MB warnt die App deshalb vorab — ein bewusst konservativer Schätzwert, keine gemessene Obergrenze. Nutzen Sie für Dateien dieser Größe bevorzugt Chrome/Edge auf dem Desktop oder den Download-Link-Modus, dessen Download-Seite zusätzlich über einen Service Worker auf die Festplatte streamen kann.",
        "WebRTC erfordert einen sicheren Kontext (HTTPS); die App stellt über einfaches HTTP keine Verbindung her.",
      ],
    },
    {
      heading: "Open Source und Melden von Problemen",
      body: [
        "Das Protokolldesign sowie der gesamte Client- und Servercode sind auf GitHub öffentlich, sodass jeder die Kryptografie prüfen, einen eigenen Server betreiben oder beitragen kann. Wenn Sie ein Sicherheitsproblem finden, melden Sie es bitte vertraulich über die GitHub-Schwachstellenmeldung im Repository, anstatt ein öffentliches Issue zu eröffnen.",
      ],
    },
  ],
};

const fr = {
  title: "Sécurité et modèle de menace",
  description:
    "Comment Relayium protège vos fichiers et textes temporaires : clés par session, chiffrement authentifié, vérification SAS, trajets directs et relayés, liens de téléchargement à divulgation nulle, et limites de cette protection.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-08-02",
  otherDocLabel: "Politique de confidentialité",
  lead: [
    "Relayium est conçu pour que ce soient les personnes qui transfèrent les fichiers ou textes temporaires — et non le serveur — qui détiennent les clés. Cette page décrit précisément ce qui est protégé, comment cela fonctionne, et les limites de cette protection.",
    "En bref : sur le même réseau, les fichiers et messages en temps réel circulent directement entre appareils. Entre réseaux, les sessions du navigateur utilisent un relais qui ne transporte que du chiffré de bout en bout et ne possède aucune clé de contenu. Des clés de session neuves sont toujours utilisées ; un code facultatif, comparé hors bande, permet en plus aux deux personnes de détecter une interception de la signalisation. Les détails suivent.",
  ],
  sections: [
    {
      heading: "Chiffrement des fichiers en temps réel dans le navigateur (X25519 + AES-256-GCM)",
      body: [
        "Pour les fichiers en temps réel dans le navigateur, chaque transfert crée une paire de clés X25519 éphémère sur chaque appareil. Les deux navigateurs dérivent une clé AES-256-GCM partagée et chiffrent chaque bloc avec un nonce unique : la signalisation et le relais voient du chiffré, jamais le fichier en clair. Les transferts CLI utilisent un protocole direct TLS 1.3 distinct décrit plus bas.",
      ],
      bullets: [
        "Les clés sont éphémères et propres à chaque transfert — rien n'est réutilisé d'une session à l'autre.",
        "La clé partagée est dérivée sur les deux appareils ; elle n'est jamais envoyée à un serveur ni stockée sur celui-ci.",
        "Le chiffrement est appliqué au niveau applicatif, au-dessus de la sécurité de transport propre à WebRTC, et tient donc même si la couche de transport est compromise.",
      ],
    },
    {
      heading: "Le code de vérification (SAS) — détecter un serveur malveillant",
      body: [
        "Le chiffrement intégré de WebRTC (DTLS) échange les empreintes via le serveur de signalisation, qui pourrait tenter de permuter les clés. Relayium peut donc afficher un Short Authentication String (SAS) à 6 chiffres sur les deux écrans. Des codes identiques offrent le contrôle le plus fort uniquement si les deux personnes les comparent hors bande. Afficher ce code et s'arrêter pour le comparer est un réglage — « vérification avancée » sur le web (désactivée par défaut), `--verify` dans la CLI. Le désactiver change ce qui est affiché et les étapes qui s'interrompent pour une confirmation ; cela ne change pas le chiffrement. La poignée de main « engagement puis révélation » ci-dessous s'exécute sur chaque connexion et refuse celle dont la révélation ne correspond pas, les clés sont toujours générées sur votre appareil et ne nous sont jamais envoyées, le relais ne transporte toujours que du chiffré, et dans le navigateur, la réception de fichiers demande toujours avant d'enregistrer quoi que ce soit : l'application native macOS, elle, écrit sans demander dans son dossier de destination configuré (« Téléchargements » par défaut). Cette demande empêche une écriture non sollicitée sur votre disque ; elle ne dit rien de l'identité de votre interlocuteur, que seule la comparaison du code établit.",
        "La poignée de main « engagement puis révélation » empêche le serveur de choisir après coup une clé produisant une collision. Les transferts CLI utilisent un SAS distinct, dérivé par engagement puis révélation des empreintes du certificat TLS épinglé ; lui aussi ne détecte rien si personne ne le compare réellement hors bande, ce pour quoi `--verify` s'arrête.",
      ],
      bullets: [
        "Pour la garantie la plus forte, activez la vérification avancée et comparez le code hors bande — en personne ou par appel vocal.",
        "Si les deux codes diffèrent, interrompez le transfert : quelqu'un intercepte peut-être la connexion.",
      ],
    },
    {
      heading: "Le clair que le serveur ne peut ni voir ni déchiffrer",
      body: [
        "Nos serveurs sont conçus pour ne pouvoir ni voir ni déchiffrer les éléments suivants en clair :",
        "Sur le même réseau, fichiers et messages en temps réel circulent directement entre appareils. Entre réseaux, ils passent par TURN sous forme chiffrée, sans que le relais possède la clé. La signalisation traite néanmoins les données de connexion et voit des métadonnées comme les IP publiques, l'appartenance à la salle, l'heure, le nom d'appareil choisi et la présence.",
      ],
      bullets: [
        "Le contenu de vos fichiers.",
        "Les noms de vos fichiers.",
        "Le texte en clair de vos messages.",
        "Vos clés de chiffrement.",
      ],
    },
    {
      heading: "Quand les fichiers et textes du navigateur sont relayés (TURN)",
      body: [
        "Les transferts de fichiers et de texte du navigateur entre réseaux passent par TURN par conception, et non en repli. L'application impose ce trajet car les NAT et pare-feu rendent une liaison directe improbable. Les sessions navigateur sur le même réseau se connectent directement sans identifiants de relais. Les transferts CLI de fichiers et de texte n'utilisent jamais TURN : ils sont uniquement directs et échouent sans trajet direct.",
      ],
      bullets: [
        "Le relais ne transmet que du chiffré — il ne peut lire ni vos fichiers ni vos messages, qui restent chiffrés de bout en bout.",
        "Nous enregistrons le nombre d'octets relayés par compte, afin d'appliquer un quota de relais mensuel et de prévenir les abus — nous n'inspectons jamais ce qui est relayé, seulement le nombre d'octets.",
        "Nous n'inspectons jamais le contenu relayé.",
      ],
    },
    {
      heading: "Transfert de texte temporaire",
      body: [
        "Les sessions de texte du navigateur utilisent le protocole Web : les pairs effectuent un échange X25519 éphémère et dérivent des sous-clés AES-256-GCM séparées par direction, dans un domaine distinct des clés de transfert de fichiers. Chaque message UTF-8 valide est authentifié et chiffré dans sa propre trame. Entre réseaux, les sessions du navigateur utilisent TURN par conception ; le relais transporte du chiffré et ne possède aucune clé de message. Avec la vérification avancée activée, comparer le SAS hors bande détecte en plus une interception de la signalisation.",
        "Le texte CLI utilise un protocole différent, exclusivement direct, sur TLS 1.3 avec certificat épinglé. Il n'utilise ni les trames X25519/AES du navigateur ni TURN, et échoue si aucun trajet direct ne peut être établi. Relayium ne stocke pas le corps des messages, mais chaque extrémité peut copier, journaliser, capturer ou conserver autrement le texte reçu.",
      ],
      bullets: [
        "Les deux personnes doivent être en ligne en même temps ; Relayium ne fournit ni livraison de texte hors ligne ni historique de messages côté serveur.",
        "Les serveurs traitent nécessairement des métadonnées de connexion telles que les adresses IP, l'appartenance à la salle, l'heure, le nom d'appareil et la présence pour les sessions navigateur, ainsi que, le cas échéant, le compte associé à la création d'un code d'appairage.",
        "Pour les sessions TURN, Relayium peut comptabiliser les octets relayés afin d'appliquer les quotas et de prévenir les abus, mais n'inspecte pas le texte en clair des messages.",
      ],
    },
    {
      heading: "Liens de téléchargement stockés — la clé ne quitte jamais votre navigateur",
      body: [
        "Le mode optionnel de lien de téléchargement est prévu pour les cas où le destinataire n'est pas en ligne. Votre navigateur chiffre les fichiers avec AES-256-GCM avant tout envoi, et la clé de déchiffrement n'est placée que dans le fragment d'URL — la partie après le # —, que les navigateurs n'envoient jamais au serveur.",
      ],
      bullets: [
        "Le serveur ne stocke que du chiffré, plus la taille du chiffré et des horodatages pour les quotas et le nettoyage — jamais de clair, de noms de fichiers ni de clés.",
        "Quiconque possède le lien complet peut déchiffrer ; traitez donc le lien comme le fichier lui-même et partagez-le par un canal de confiance.",
        "Les liens peuvent être réglés pour expirer (de 1 heure à 14 jours au maximum, selon votre offre) ou pour s'effacer après le premier téléchargement complet.",
      ],
    },
    {
      heading: "Intégrité des fichiers (SHA-256)",
      body: [
        "Au-delà de la confidentialité, l'intégrité de chaque fichier est vérifiée. Chaque bloc porte une étiquette d'authentification AES-GCM, et un hachage SHA-256 par fichier est vérifié de bout en bout côté destinataire, de sorte qu'un fichier corrompu ou altéré est détecté plutôt qu'accepté silencieusement.",
      ],
    },
    {
      heading: "Ce contre quoi Relayium ne protège pas",
      body: [
        "Le chiffrement de bout en bout protège les données en transit entre deux extrémités honnêtes. Par conception, il ne peut pas protéger contre :",
      ],
      bullets: [
        "Un appareil ou un navigateur compromis à l'une des extrémités — logiciel malveillant, extension de navigateur hostile, ou quelqu'un qui regarde l'écran.",
        "Les métadonnées nécessaires : horaires de session, nombre d'octets relayés et, pour un lien stocké ou une session par code d'appairage, le compte qui a créé le lien ou le code.",
        "Un destinataire qui conserve, copie ou transmet des fichiers ou messages après réception.",
        "Le partage d'un lien de téléchargement par un canal non fiable, puisque la clé de déchiffrement voyage dans le lien.",
      ],
    },
    {
      heading: "Prise en charge des navigateurs et ses limites",
      body: [
        "Relayium fonctionne dans tout navigateur moderne prenant en charge WebRTC via HTTPS. Quelques capacités diffèrent selon le navigateur :",
      ],
      bullets: [
        "Chrome et Edge sur ordinateur disposent de l'API File System Access et diffusent les gros fichiers directement sur le disque, sans plafond de mémoire pratique.",
        "Firefox, Safari et tous les navigateurs mobiles (sur iOS, tous les navigateurs sont WebKit) n'ont pas cette API et assemblent le fichier en mémoire sur le trajet temps réel ; l'application avertit donc au-delà d'environ 256 Mo — un repère volontairement prudent, pas une limite mesurée. Pour des fichiers de cette taille, préférez Chrome/Edge sur ordinateur, ou le mode lien de téléchargement, dont la page de téléchargement peut en outre écrire sur le disque via un service worker.",
        "WebRTC exige un contexte sécurisé (HTTPS) ; l'application ne se connecte pas en HTTP simple.",
      ],
    },
    {
      heading: "Open source et signalement des problèmes",
      body: [
        "La conception du protocole ainsi que tout le code client et serveur sont publics sur GitHub, de sorte que chacun peut auditer la cryptographie, exploiter son propre serveur ou contribuer. Si vous découvrez un problème de sécurité, veuillez le signaler en privé via le signalement de vulnérabilité GitHub du dépôt, plutôt que d'ouvrir un ticket public.",
      ],
    },
  ],
};

const ar = {
  title: "الأمان ونموذج التهديد",
  description:
    "كيف تحمي Relayium ملفاتك ونصوصك المؤقتة: مفاتيح لكل جلسة، وتشفير موثّق، والتحقق عبر SAS، والمسارات المباشرة والمُرحَّلة، وروابط تنزيل بمعرفة صفرية، وعرض صادق لحدود الحماية.",
  updatedLabel: "آخر تحديث",
  updated: "2026-08-02",
  otherDocLabel: "سياسة الخصوصية",
  lead: [
    "صُمِّمت Relayium بحيث يكون مَن ينقلون الملفات أو النصوص المؤقتة — لا الخادم — هم مَن يملكون المفاتيح. تصف هذه الصفحة بدقة ما هو محميّ، وكيف يعمل، وحدود تلك الحماية.",
    "باختصار: تنتقل الملفات والرسائل الفورية مباشرة بين الأجهزة على الشبكة نفسها. وعبر الشبكات تستخدم جلسات المتصفح مُرحِّلًا لا يحمل سوى النص المُشفَّر من الطرف إلى الطرف ولا يملك مفتاح المحتوى. وتُستخدَم دائمًا مفاتيح جلسة جديدة؛ ويتيح رمز تحقّق اختياري يُقارَن عبر قناة خارجية للطرفين اكتشاف اعتراض الإشارة أيضًا. وفيما يلي التفاصيل.",
  ],
  sections: [
    {
      heading: "تشفير ملفات المتصفح الفورية (X25519 + AES-256-GCM)",
      body: [
        "لنقل الملفات الفوري في المتصفح، تُولِّد كل عملية زوج مفاتيح X25519 مؤقتًا على كل جهاز، ويشتق المتصفحان مفتاح AES-256-GCM مشتركًا. تُشفَّر كل كتلة بقيمة nonce فريدة، فلا ترى الإشارة أو المُرحِّل سوى النص المُشفَّر بدل الملف الصريح. تستخدم عمليات CLI بروتوكول TLS 1.3 مباشرًا ومختلفًا موضحًا أدناه.",
      ],
      bullets: [
        "المفاتيح مؤقتة وخاصة بكل عملية نقل — ولا يُعاد استخدام أي شيء عبر الجلسات.",
        "يُشتَقّ المفتاح المشترك على الجهازين؛ ولا يُرسَل أبدًا إلى أي خادم ولا يُخزَّن عليه.",
        "يُطبَّق التشفير في طبقة التطبيق، فوق أمان النقل الخاص بـ WebRTC، فيظل صامدًا حتى لو تعرّضت طبقة النقل للاختراق.",
      ],
    },
    {
      heading: "رمز التحقق (SAS) — اكتشاف خادم خبيث",
      body: [
        "يتبادل WebRTC بصمات المفاتيح عبر خادم الإشارة الذي قد يحاول تبديلها. لذلك يمكن أن تعرض Relayium سلسلة SAS من 6 أرقام على الشاشتين. ولا يمنح تطابق الرمزين أقوى كشف للاعتراض إلا عندما يقارنهما الطرفان عبر قناة خارجية. أما عرض هذا الرمز والتوقّف لمقارنته فهو إعداد — «التحقّق المتقدّم» في الويب (معطَّل افتراضيًا)، و`--verify` في CLI. وتعطيله يغيّر ما يُعرض وأي الخطوات تتوقّف طلبًا للتأكيد فقط، ولا يغيّر التشفير: فمصافحة «الالتزام ثم الكشف» أدناه تعمل على كل اتصال وترفض أي اتصال لا يطابق كشفه التزامه، وتُولَّد المفاتيح على جهازك ولا تصلنا أبدًا، ولا ينقل المُرحِّل سوى نص مشفَّر، وفي المتصفح يظل استقبال الملفات يسألك قبل حفظ أي شيء — أما تطبيق macOS الأصلي فيكتب دون سؤال في وجهة الحفظ المضبوطة (مجلد التنزيلات افتراضيًا). وهذا السؤال يمنع الكتابة غير المطلوبة على قرصك، ولا يثبت من يكون الطرف الآخر؛ فذلك لا تؤكّده إلا مقارنة الرمز.",
        "تمنع مصافحة «الالتزام ثم الكشف» الخادم من اختيار مفتاح متصادم بعد الحدث. وتستخدم عمليات CLI سلسلة SAS منفصلة مشتقة من تبادل الالتزام ثم الكشف لبصمات شهادة TLS المثبّتة؛ وهي أيضًا لا تكشف شيئًا ما لم يقارنها أحد فعليًا عبر قناة خارجية، وهو ما يتوقّف من أجله الخيار `--verify`.",
      ],
      bullets: [
        "للحصول على أقوى ضمان، فعِّل التحقّق المتقدّم ثم قارِن الرمز عبر قناة خارجية — وجهًا لوجه أو عبر مكالمة صوتية.",
        "إذا اختلف الرمزان، فأوقِف النقل: قد يكون أحدهم يعترض الاتصال.",
      ],
    },
    {
      heading: "النص الصريح الذي لا يستطيع الخادم رؤيته أو فكّه",
      body: [
        "صُمِّمت خوادمنا بحيث لا تستطيع رؤية أو فك النص الصريح التالي:",
        "على الشبكة نفسها تنتقل بايتات الملفات والرسائل مباشرة بين الجهازين. وعبر الشبكات تمر عبر TURN كنص مُشفَّر ولا يملك المُرحِّل مفتاح المحتوى. ومع ذلك تعالج الإشارة بيانات الإعداد وترى بيانات وصفية مثل IP العام وعضوية الغرفة والتوقيت واسم الجهاز والحضور.",
      ],
      bullets: [
        "محتويات ملفاتك.",
        "أسماء ملفاتك.",
        "النص الصريح لرسائلك.",
        "مفاتيح التشفير الخاصة بك.",
      ],
    },
    {
      heading: "عندما تُرحَّل ملفات ونصوص المتصفح (TURN)",
      body: [
        "تستخدم عمليات ملفات ونصوص المتصفح عبر الشبكات TURN بحكم التصميم، لا كخيار احتياطي، لأن NAT وجدران الحماية تجعل المسار المباشر غير مرجح. تتصل جلسات المتصفح على الشبكة نفسها مباشرة دون بيانات اعتماد ترحيل. ولا تستخدم عمليات ملفات أو نصوص CLI بروتوكول TURN إطلاقًا: فهي مباشرة فقط وتفشل إن لم يوجد مسار مباشر.",
      ],
      bullets: [
        "لا ينقل المُرحِّل سوى النص المُشفَّر — ولا يمكنه قراءة ملفاتك أو رسائلك، التي تظل مُشفَّرة من الطرف إلى الطرف.",
        "نسجّل عدد البايتات المُرحَّلة لكل حساب لفرض حصة ترحيل شهرية ومنع إساءة الاستخدام — ولا نفحص أبدًا ما يُرحَّل، بل نسجّل عدد البايتات فقط.",
        "لا نفحص أبدًا المحتوى المُرحَّل.",
      ],
    },
    {
      heading: "نقل النص المؤقت",
      body: [
        "تستخدم جلسات النص في المتصفح بروتوكول Web: يُجري الطرفان تبادل X25519 مؤقتًا ويشتقان مفاتيح فرعية AES-256-GCM منفصلة حسب الاتجاه وفي نطاق منفصل عن مفاتيح نقل الملفات. وتُوثَّق كل رسالة UTF-8 صالحة وتُشفَّر في إطار مستقل. وعبر الشبكات تستخدم جلسات المتصفح TURN بحكم التصميم؛ فلا يحمل المُرحِّل إلا النص المُشفَّر ولا يملك مفتاح الرسالة. وعند تفعيل التحقّق المتقدّم، تكشف مقارنة SAS عبر قناة خارجية اعتراض الإشارة أيضًا.",
        "يستخدم نص CLI بروتوكولًا مختلفًا ومباشرًا فقط عبر TLS 1.3 مع تثبيت الشهادة. ولا يستخدم إطارات X25519/AES الخاصة بالمتصفح ولا TURN، ويفشل إن تعذّر إنشاء مسار مباشر. لا تخزّن Relayium متون الرسائل، لكن يمكن لأي من الطرفين نسخ النص أو تسجيله أو التقاط صورة له أو الاحتفاظ به بطريقة أخرى بعد استلامه.",
      ],
      bullets: [
        "يجب أن يكون الشخصان متصلين في الوقت نفسه؛ ولا توفّر Relayium تسليم النص دون اتصال أو سجل رسائل على الخادم.",
        "تعالج الخوادم بالضرورة بيانات وصفية للاتصال مثل عناوين IP، وعضوية الغرفة، والتوقيت، واسم الجهاز والحضور لجلسات المتصفح، وعند الاقتضاء ارتباط الحساب المستخدم لإنشاء رمز اقتران.",
        "في جلسات TURN قد تسجّل Relayium عدد البايتات المُرحَّلة لفرض الحصة ومنع إساءة الاستخدام، لكنها لا تفحص النص الصريح للرسائل.",
      ],
    },
    {
      heading: "روابط التنزيل المُخزَّنة — المفتاح لا يغادر متصفحك أبدًا",
      body: [
        "وضع رابط التنزيل الاختياري مُخصَّص لما يكون فيه المُستقبِل غير متصل. يُشفِّر متصفحك الملفات باستخدام AES-256-GCM قبل رفع أي شيء، ويوضَع مفتاح فك التشفير في جزء URL فقط — الجزء الذي يلي # — وهو ما لا ترسله المتصفحات أبدًا إلى الخادم.",
      ],
      bullets: [
        "لا يخزّن الخادم سوى النص المُشفَّر، إضافةً إلى حجم النص المُشفَّر والطوابع الزمنية لأغراض الحصة والتنظيف — ولا يخزّن أبدًا نصًا صريحًا أو أسماء ملفات أو مفاتيح.",
        "يستطيع أي شخص يملك الرابط الكامل فكّ التشفير، لذا تعامَل مع الرابط كأنه الملف نفسه وشارِكه عبر قناة موثوقة.",
        "يمكن ضبط الروابط لتنتهي صلاحيتها (من ساعة واحدة وحتى 14 يومًا، حسب خطتك) أو لتُحذَف بعد أول تنزيل كامل.",
      ],
    },
    {
      heading: "سلامة الملفات (SHA-256)",
      body: [
        "إلى جانب السرية، يُتحقَّق من سلامة كل ملف. تحمل كل كتلة وسم مصادقة AES-GCM، ويُتحقَّق من تجزئة SHA-256 لكل ملف من الطرف إلى الطرف على جانب المُستقبِل، بحيث يُكتشَف الملف التالف أو المُتلاعَب به بدلًا من قبوله بصمت.",
      ],
    },
    {
      heading: "ما لا تحمي منه Relayium",
      body: [
        "يحمي التشفير من الطرف إلى الطرف البيانات أثناء انتقالها بين طرفين أمينين. ولا يمكنه، بحكم التصميم، أن يحمي من:",
      ],
      bullets: [
        "جهاز أو متصفح مُخترَق على أي من الطرفين — برمجية خبيثة، أو امتداد متصفح عدائي، أو شخص يقرأ الشاشة.",
        "البيانات الوصفية الضرورية: توقيت الجلسة وعدد البايتات المُرحَّلة، وفي الرابط المُخزَّن أو جلسة رمز الاقتران الحساب الذي أنشأ الرابط أو الرمز.",
        "اختيار المُستقبِل الاحتفاظ بالملفات أو الرسائل أو نسخها أو إعادة توجيهها بعد استلامها.",
        "مشاركة رابط تنزيل عبر قناة غير موثوقة، إذ إن مفتاح فك التشفير ينتقل داخل الرابط.",
      ],
    },
    {
      heading: "دعم المتصفحات وحدوده",
      body: [
        "تعمل Relayium في أي متصفح حديث يدعم WebRTC عبر HTTPS. وتختلف بعض القدرات باختلاف المتصفح:",
      ],
      bullets: [
        "يتوفّر في Chrome وEdge على سطح المكتب واجهة File System Access، فيبثّان الملفات الكبيرة مباشرةً إلى القرص، دون سقف عملي للذاكرة.",
        "أما Firefox وSafari وجميع متصفحات الهاتف (فكل متصفح على iOS يعمل بـ WebKit) فتفتقر إلى تلك الواجهة وتجمّع الملف في الذاكرة على المسار الفوري، ولذلك يحذّر التطبيق مسبقًا عند تجاوز نحو 256 MB — وهو تقدير متحفّظ عن قصد، لا حدّ مقيس. لملفات بهذا الحجم فضّل Chrome/Edge على سطح المكتب، أو استخدم وضع رابط التنزيل، الذي يمكن لصفحة التنزيل فيه أيضًا الكتابة إلى القرص عبر service worker.",
        "يتطلب WebRTC سياقًا آمنًا (HTTPS)؛ ولن يتصل التطبيق عبر HTTP العادي.",
      ],
    },
    {
      heading: "المصدر المفتوح والإبلاغ عن المشكلات",
      body: [
        "تصميم البروتوكول وكامل شِفرة العميل والخادم متاحة للعموم على GitHub، بحيث يستطيع أي شخص تدقيق التشفير، أو تشغيل خادمه الخاص، أو المساهمة. وإذا اكتشفت مشكلة أمنية، فيُرجى الإبلاغ عنها بصورة خاصة عبر آلية الإبلاغ عن الثغرات في GitHub على المستودع، بدلًا من فتح مشكلة عامة.",
      ],
    },
  ],
};

const es = {
  title: "Seguridad y modelo de amenazas",
  description:
    "Cómo Relayium protege tus archivos y textos temporales: claves por sesión, cifrado autenticado, verificación SAS, rutas directas y retransmitidas, enlaces de descarga de conocimiento cero y una exposición honesta de los límites de la protección.",
  updatedLabel: "Última actualización",
  updated: "2026-08-02",
  otherDocLabel: "Política de privacidad",
  lead: [
    "Relayium está diseñado para que las personas que transfieren archivos o textos temporales —no el servidor— tengan las claves. Esta página describe exactamente qué está protegido, cómo funciona y los límites de esa protección.",
    "En resumen: en la misma red, los archivos y mensajes en tiempo real circulan directamente entre dispositivos. Entre redes, las sesiones del navegador usan un retransmisor que solo transporta texto cifrado de extremo a extremo y no posee la clave del contenido. Siempre se usan claves nuevas en cada sesión; además, un código opcional comparado fuera de banda permite detectar la interceptación de la señalización. A continuación, los detalles.",
  ],
  sections: [
    {
      heading: "Cifrado de archivos en tiempo real del navegador (X25519 + AES-256-GCM)",
      body: [
        "Para archivos en tiempo real del navegador, cada transferencia genera un par X25519 efímero en cada dispositivo y ambos navegadores derivan una clave AES-256-GCM compartida. Cada fragmento usa un nonce único, por lo que señalización y retransmisor ven texto cifrado, no el archivo en claro. La CLI usa un protocolo directo TLS 1.3 distinto descrito más abajo.",
      ],
      bullets: [
        "Las claves son efímeras y por transferencia: nada se reutiliza entre sesiones.",
        "La clave compartida se deriva en los dos dispositivos; nunca se envía a ningún servidor ni se almacena en él.",
        "El cifrado se aplica en la capa de aplicación, por encima de la propia seguridad de transporte de WebRTC, de modo que se mantiene incluso si la capa de transporte se ve comprometida.",
      ],
    },
    {
      heading: "El código de verificación (SAS): detectar un servidor malicioso",
      body: [
        "WebRTC intercambia huellas mediante el servidor de señalización, que podría intentar sustituir claves. Relayium puede mostrar por ello un SAS de 6 dígitos en ambas pantallas. Los códigos coincidentes ofrecen la comprobación más sólida solo cuando ambas personas los comparan fuera de banda. Mostrar ese código y detenerse a compararlo es una preferencia: «verificación avanzada» en la web (desactivada por omisión) y `--verify` en la CLI. Desactivarla cambia qué se muestra y qué pasos se detienen para pedir confirmación; no cambia el cifrado. El handshake de compromiso y revelación de abajo se ejecuta en cada conexión y rechaza aquella cuya revelación no coincide, las claves se siguen generando en tu dispositivo y nunca se nos envían, el retransmisor sigue transportando solo texto cifrado, y en el navegador, recibir archivos sigue preguntándote antes de guardar nada: la aplicación nativa de macOS, en cambio, escribe sin preguntar en su carpeta de destino configurada (Descargas por omisión). Esa pregunta evita escrituras no solicitadas en tu disco; no dice quién está al otro lado, algo que solo establece comparar el código.",
        "El compromiso y posterior revelación impide que el servidor elija después una clave que colisione. La CLI usa un SAS separado derivado del intercambio de las huellas del certificado TLS fijado; también detecta algo solo si alguien lo compara de verdad fuera de banda, que es para lo que se detiene `--verify`.",
      ],
      bullets: [
        "Para la garantía más sólida, activa la verificación avanzada y compara el código fuera de banda: en persona o por una llamada de voz.",
        "Si los dos códigos difieren, detén la transferencia: alguien podría estar interceptando la conexión.",
      ],
    },
    {
      heading: "Texto claro que el servidor no puede ver ni descifrar",
      body: [
        "Nuestros servidores están diseñados para no poder ver ni descifrar el siguiente texto claro:",
        "En la misma red, los bytes de archivos y mensajes circulan directamente entre dispositivos. Entre redes pasan por TURN como texto cifrado, sin que el retransmisor tenga la clave. La señalización sí procesa datos de conexión y ve metadatos como IP pública, sala, horario, apodo y presencia.",
      ],
      bullets: [
        "El contenido de tus archivos.",
        "Los nombres de tus archivos.",
        "El texto claro de tus mensajes.",
        "Tus claves de cifrado.",
      ],
    },
    {
      heading: "Cuando los archivos y textos del navegador se retransmiten (TURN)",
      body: [
        "Los archivos y textos del navegador entre redes usan TURN por diseño, no como alternativa, porque NAT y cortafuegos hacen improbable la ruta directa. Las sesiones del navegador en la misma red conectan directamente sin credenciales de retransmisión. Los archivos y textos de la CLI nunca usan TURN: son solo directos y fallan sin una ruta directa.",
      ],
      bullets: [
        "El retransmisor reenvía únicamente texto cifrado: no puede leer tus archivos ni mensajes, que permanecen cifrados de extremo a extremo.",
        "Registramos el número de bytes retransmitidos por cuenta, para aplicar una asignación mensual de retransmisión y evitar el abuso; nunca inspeccionamos lo que se retransmite, solo el recuento de bytes.",
        "Nunca inspeccionamos el contenido retransmitido.",
      ],
    },
    {
      heading: "Transferencia de texto temporal",
      body: [
        "Las sesiones de texto del navegador usan el protocolo Web: los pares realizan un intercambio X25519 efímero y derivan subclaves AES-256-GCM separadas por dirección en un dominio distinto del de las claves de transferencia de archivos. Cada mensaje UTF-8 válido se autentica y cifra como una trama independiente. Entre redes, las sesiones del navegador usan TURN por diseño; el retransmisor transporta texto cifrado y no tiene la clave del mensaje. Con la verificación avanzada activada, comparar el SAS fuera de banda detecta además una interceptación de la señalización.",
        "El texto de la CLI utiliza un protocolo distinto, exclusivamente directo, sobre TLS 1.3 con certificado fijado. No usa las tramas X25519/AES del navegador ni TURN, y falla si no puede establecerse una ruta directa. Relayium no almacena el cuerpo de los mensajes, pero cualquiera de los extremos puede copiar, registrar, capturar o conservar de otro modo el texto después de recibirlo.",
      ],
      bullets: [
        "Ambas personas deben estar en línea a la vez; Relayium no proporciona entrega de texto sin conexión ni historial de mensajes en el servidor.",
        "Los servidores necesariamente procesan metadatos de conexión como direcciones IP, pertenencia a la sala, horario, apodo del dispositivo y presencia en sesiones del navegador, y, cuando corresponda, la asociación de la cuenta usada para crear un código de emparejamiento.",
        "En sesiones TURN, Relayium puede registrar el número de bytes retransmitidos para aplicar la asignación y evitar abusos, pero no inspecciona el texto en claro de los mensajes.",
      ],
    },
    {
      heading: "Enlaces de descarga almacenados: la clave nunca abandona tu navegador",
      body: [
        "El modo opcional de enlace de descarga es para cuando el destinatario no está en línea. Tu navegador cifra los archivos con AES-256-GCM antes de subir nada, y la clave de descifrado se coloca únicamente en el fragmento de la URL —la parte después del #—, que los navegadores nunca envían al servidor.",
      ],
      bullets: [
        "El servidor almacena solo texto cifrado, además del tamaño del texto cifrado y marcas de tiempo para la cuota y la limpieza; nunca texto en claro, nombres de archivos ni claves.",
        "Cualquiera que tenga el enlace completo puede descifrar, así que trata el enlace como el archivo mismo y compártelo por un canal de confianza.",
        "Los enlaces pueden configurarse para que caduquen (de 1 hora hasta 14 días, según tu plan) o para que se destruyan tras la primera descarga completa.",
      ],
    },
    {
      heading: "Integridad de los archivos (SHA-256)",
      body: [
        "Más allá de la confidencialidad, se verifica la integridad de cada archivo. Cada fragmento lleva una etiqueta de autenticación AES-GCM, y en el lado receptor se comprueba de extremo a extremo un hash SHA-256 por archivo, de modo que un archivo dañado o manipulado se detecta en lugar de aceptarse en silencio.",
      ],
    },
    {
      heading: "Contra qué no protege Relayium",
      body: [
        "El cifrado de extremo a extremo protege los datos en tránsito entre dos extremos honestos. Por diseño, no puede proteger contra:",
      ],
      bullets: [
        "Un dispositivo o navegador comprometido en cualquiera de los extremos: malware, una extensión de navegador hostil o alguien que lee la pantalla.",
        "Los metadatos necesarios: horario de la sesión, bytes retransmitidos y, para un enlace almacenado o una sesión con código, la cuenta que creó el enlace o el código.",
        "Un destinatario que conserva, copia o reenvía archivos o mensajes después de recibirlos.",
        "Compartir un enlace de descarga por un canal no fiable, ya que la clave de descifrado viaja dentro del enlace.",
      ],
    },
    {
      heading: "Compatibilidad con navegadores y sus límites",
      body: [
        "Relayium funciona en cualquier navegador moderno con WebRTC a través de HTTPS. Algunas capacidades difieren según el navegador:",
      ],
      bullets: [
        "Chrome y Edge de escritorio disponen de la API File System Access y transmiten los archivos grandes directamente al disco, sin un techo de memoria práctico.",
        "Firefox, Safari y todos los navegadores móviles (en iOS todos los navegadores son WebKit) carecen de esa API y ensamblan el archivo en memoria en la ruta en tiempo real, por lo que la aplicación avisa por encima de unos 256 MB: una estimación deliberadamente conservadora, no un límite medido. Para archivos de ese tamaño, prefiere Chrome/Edge de escritorio, o usa el modo de enlace de descarga, cuya página de descarga además puede escribir en disco mediante un service worker.",
        "WebRTC requiere un contexto seguro (HTTPS); la aplicación no se conectará por HTTP simple.",
      ],
    },
    {
      heading: "Código abierto e informe de problemas",
      body: [
        "El diseño del protocolo y todo el código de cliente y servidor son públicos en GitHub, de modo que cualquiera puede auditar la criptografía, ejecutar su propio servidor o contribuir. Si encuentras un problema de seguridad, infórmalo de forma privada a través del informe de vulnerabilidades de GitHub en el repositorio, en lugar de abrir una incidencia pública.",
      ],
    },
  ],
};

const pt = {
  title: "Segurança e modelo de ameaças",
  description:
    "Como a Relayium protege seus arquivos e textos temporários: chaves por sessão, criptografia autenticada, verificação SAS, caminhos diretos e retransmitidos, links de download de conhecimento zero e uma exposição honesta dos limites da proteção.",
  updatedLabel: "Última atualização",
  updated: "2026-08-02",
  otherDocLabel: "Política de Privacidade",
  lead: [
    "A Relayium foi criada para que as pessoas que transferem arquivos ou textos temporários — e não o servidor — tenham as chaves. Esta página descreve exatamente o que é protegido, como funciona e os limites dessa proteção.",
    "Em resumo: na mesma rede, arquivos e mensagens em tempo real circulam diretamente entre dispositivos. Entre redes, as sessões do navegador usam um retransmissor que transporta apenas texto cifrado de ponta a ponta e não possui a chave do conteúdo. Chaves novas por sessão são sempre usadas; além disso, um código opcional comparado fora de banda permite detectar interceptação da sinalização. A seguir, os detalhes.",
  ],
  sections: [
    {
      heading: "Criptografia de arquivos em tempo real no navegador (X25519 + AES-256-GCM)",
      body: [
        "Para arquivos em tempo real no navegador, cada transferência gera um par X25519 efêmero em cada dispositivo e os navegadores derivam uma chave AES-256-GCM compartilhada. Cada bloco usa um nonce único, então a sinalização e o retransmissor veem texto cifrado, não o arquivo simples. A CLI usa outro protocolo direto TLS 1.3 descrito abaixo.",
      ],
      bullets: [
        "As chaves são efêmeras e específicas de cada transferência — nada é reutilizado entre sessões.",
        "A chave compartilhada é derivada nos dois dispositivos; ela nunca é enviada a nenhum servidor nem armazenada nele.",
        "A criptografia é aplicada na camada de aplicação, acima da própria segurança de transporte do WebRTC, de modo que se mantém mesmo se a camada de transporte for comprometida.",
      ],
    },
    {
      heading: "O código de verificação (SAS) — detectar um servidor malicioso",
      body: [
        "O WebRTC troca impressões digitais pelo servidor de sinalização, que poderia tentar substituir chaves. Por isso a Relayium pode mostrar um SAS de 6 dígitos nas duas telas. Códigos iguais oferecem a verificação mais forte somente quando as duas pessoas os comparam fora de banda. Mostrar esse código e parar para compará-lo é uma preferência: “verificação avançada” na web (desligada por padrão) e `--verify` na CLI. Desligá-la muda o que aparece e quais passos param para pedir confirmação; não muda a criptografia. O handshake de compromisso e revelação abaixo roda em toda conexão e recusa aquela cuja revelação não confere, as chaves continuam sendo geradas no seu aparelho e nunca são enviadas a nós, o retransmissor continua carregando apenas texto cifrado, e, no navegador, receber arquivos continua perguntando antes de salvar qualquer coisa — já o aplicativo nativo de macOS grava sem perguntar na sua pasta de destino configurada (Downloads por padrão). Essa pergunta evita gravações não solicitadas no seu disco; ela não diz quem está do outro lado, e só a comparação do código estabelece isso.",
        "O compromisso e posterior revelação impede que o servidor escolha depois uma chave que colida. A CLI usa um SAS separado derivado da troca das impressões do certificado TLS fixado; ele também só detecta algo se alguém realmente o comparar fora de banda, que é para o que `--verify` para.",
      ],
      bullets: [
        "Para a garantia mais forte, ative a verificação avançada e compare o código fora de banda — pessoalmente ou por uma chamada de voz.",
        "Se os dois códigos forem diferentes, interrompa a transferência: alguém pode estar interceptando a conexão.",
      ],
    },
    {
      heading: "Texto simples que o servidor não pode ver nem descriptografar",
      body: [
        "Nossos servidores foram projetados para não poder ver nem descriptografar o seguinte texto simples:",
        "Na mesma rede, bytes de arquivos e mensagens fluem diretamente entre dispositivos. Entre redes passam pelo TURN como texto cifrado, sem que o retransmissor tenha a chave. A sinalização ainda processa dados da conexão e vê metadados como IP público, sala, horário, apelido e presença.",
      ],
      bullets: [
        "O conteúdo dos seus arquivos.",
        "Os nomes dos seus arquivos.",
        "O texto simples das suas mensagens.",
        "Suas chaves de criptografia.",
      ],
    },
    {
      heading: "Quando arquivos e textos do navegador são retransmitidos (TURN)",
      body: [
        "Arquivos e textos do navegador entre redes usam TURN por projeto, não como alternativa, pois NATs e firewalls tornam improvável o caminho direto. Sessões do navegador na mesma rede conectam diretamente sem credenciais de retransmissão. Arquivos e textos da CLI nunca usam TURN: são apenas diretos e falham sem caminho direto.",
      ],
      bullets: [
        "O retransmissor encaminha apenas texto cifrado — ele não consegue ler seus arquivos nem mensagens, que permanecem criptografados de ponta a ponta.",
        "Registramos o número de bytes retransmitidos por conta, para aplicar uma cota mensal de retransmissão e evitar abusos — nunca inspecionamos o que é retransmitido, apenas a contagem de bytes.",
        "Nunca inspecionamos o conteúdo retransmitido.",
      ],
    },
    {
      heading: "Transferência de texto temporário",
      body: [
        "As sessões de texto no navegador usam o protocolo Web: os pares fazem uma troca X25519 efêmera e derivam subchaves AES-256-GCM separadas por direção em um domínio distinto das chaves de transferência de arquivos. Cada mensagem UTF-8 válida é autenticada e criptografada como um quadro independente. Entre redes, as sessões do navegador usam TURN por decisão de projeto; o retransmissor transporta texto cifrado e não possui a chave da mensagem. Com a verificação avançada ativada, comparar o SAS fora de banda detecta também a interceptação da sinalização.",
        "O texto da CLI usa um protocolo diferente, exclusivamente direto, sobre TLS 1.3 com certificado fixado. Ele não usa os quadros X25519/AES do navegador nem TURN e falha se nenhum caminho direto puder ser estabelecido. A Relayium não armazena o corpo das mensagens, mas qualquer ponta pode copiar, registrar, capturar a tela ou reter o texto de outra forma após recebê-lo.",
      ],
      bullets: [
        "As duas pessoas precisam estar online ao mesmo tempo; a Relayium não oferece entrega de texto offline nem histórico de mensagens no servidor.",
        "Os servidores necessariamente processam metadados de conexão, como endereços IP, participação na sala, horário, apelido do dispositivo e presença em sessões do navegador e, quando aplicável, a associação da conta usada para criar um código de emparelhamento.",
        "Em sessões TURN, a Relayium pode registrar a quantidade de bytes retransmitidos para aplicar a cota e prevenir abusos, mas não inspeciona o texto simples das mensagens.",
      ],
    },
    {
      heading: "Links de download armazenados — a chave nunca deixa seu navegador",
      body: [
        "O modo opcional de link de download é para quando o destinatário não está online. Seu navegador criptografa os arquivos com AES-256-GCM antes de qualquer coisa ser enviada, e a chave de descriptografia é colocada apenas no fragmento da URL — a parte depois do # —, que os navegadores nunca enviam ao servidor.",
      ],
      bullets: [
        "O servidor armazena apenas texto cifrado, além do tamanho do texto cifrado e marcas de tempo para cota e limpeza — nunca texto simples, nomes de arquivos ou chaves.",
        "Qualquer pessoa com o link completo pode descriptografar, então trate o link como o próprio arquivo e compartilhe-o por um canal confiável.",
        "Os links podem ser configurados para expirar (de 1 hora até 14 dias, dependendo do seu plano) ou para se destruir após o primeiro download completo.",
      ],
    },
    {
      heading: "Integridade dos arquivos (SHA-256)",
      body: [
        "Além da confidencialidade, a integridade de cada arquivo é verificada. Cada bloco carrega uma tag de autenticação AES-GCM, e um hash SHA-256 por arquivo é verificado de ponta a ponta no lado receptor, de modo que um arquivo corrompido ou adulterado é detectado em vez de aceito silenciosamente.",
      ],
    },
    {
      heading: "Contra o que a Relayium não protege",
      body: [
        "A criptografia de ponta a ponta protege os dados em trânsito entre dois pontos de extremidade honestos. Por design, ela não pode proteger contra:",
      ],
      bullets: [
        "Um dispositivo ou navegador comprometido em qualquer uma das pontas — malware, uma extensão de navegador hostil ou alguém lendo a tela.",
        "Os metadados necessários: horário da sessão, bytes retransmitidos e, para um link armazenado ou sessão com código, a conta que criou o link ou o código.",
        "Um destinatário que guarda, copia ou encaminha arquivos ou mensagens depois de recebê-los.",
        "Compartilhar um link de download por um canal não confiável, já que a chave de descriptografia viaja dentro do link.",
      ],
    },
    {
      heading: "Suporte a navegadores e seus limites",
      body: [
        "A Relayium funciona em qualquer navegador moderno com WebRTC sobre HTTPS. Alguns recursos diferem conforme o navegador:",
      ],
      bullets: [
        "Chrome e Edge no desktop têm a API File System Access e transmitem arquivos grandes diretamente para o disco, sem um teto de memória prático.",
        "Firefox, Safari e todos os navegadores móveis (no iOS, todo navegador é WebKit) não têm essa API e montam o arquivo na memória no caminho em tempo real, por isso o aplicativo avisa acima de cerca de 256 MB — uma estimativa deliberadamente conservadora, não um limite medido. Para arquivos desse tamanho, prefira Chrome/Edge no desktop, ou use o modo de link de download, cuja página de download ainda pode gravar em disco por meio de um service worker.",
        "O WebRTC exige um contexto seguro (HTTPS); o aplicativo não se conecta por HTTP simples.",
      ],
    },
    {
      heading: "Código aberto e relato de problemas",
      body: [
        "O design do protocolo e todo o código de cliente e servidor são públicos no GitHub, de modo que qualquer pessoa pode auditar a criptografia, executar o próprio servidor ou contribuir. Se você encontrar um problema de segurança, relate-o de forma privada por meio do relato de vulnerabilidades do GitHub no repositório, em vez de abrir uma issue pública.",
      ],
    },
  ],
};

export default { slug: "security", langs: { en, zh, ja, ko, de, fr, ar, es, pt } };
