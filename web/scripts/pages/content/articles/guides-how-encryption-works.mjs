// web/scripts/pages/content/articles/guides-how-encryption-works.mjs
// Guide: a plain-language explainer of Relayium's encryption/trust model.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Facts grounded in web/src/lib/crypto.ts, store-crypto.ts, webrtc.ts, transfer.ts
// and cross-checked against web/scripts/pages/content/legal/security.mjs.

const en = {
  title: "How Relayium encrypts your files end-to-end",
  description:
    "How Relayium protects your files: X25519 and AES-256-GCM for live transfers, a six-digit code that catches a dishonest server, and zero-knowledge stored links.",
  updatedLabel: "Last updated",
  lead: [
    "\"Is Relayium secure?\" is a fair question — every file-transfer tool claims to be private. This page walks through exactly how Relayium keeps files private, in plain language, so you can judge the claim instead of taking it on faith.",
    "There are two different encryption schemes at work, because there are two different situations: sending a file live to someone who is online right now, and leaving a download link for someone to pick up later. Both keep the server locked out of your file, but they get there in different ways — and it's worth knowing which one applies when.",
  ],
  sections: [
    {
      heading: "Live transfers: two devices agree on a secret the server never sees",
      body: [
        "When you send a file in realtime — both people online, browser to browser — Relayium starts by having each device generate a fresh key pair using X25519, the same elliptic-curve key exchange used across modern secure messaging (technically, libsodium's crypto_kx). Each device keeps its private key to itself and sends only its public key to the other side.",
        "From those two public keys, each device independently computes the same shared secret — a process that works precisely because of how elliptic-curve key exchange is built, not because the secret was sent anywhere. That shared secret becomes an AES-256-GCM key that exists only inside the two browsers. Every chunk of the file is sealed with that key and a unique nonce before it ever leaves the sender's device, so anything crossing the network — including the signaling server that helped the two browsers find each other — sees only ciphertext.",
      ],
      bullets: [
        "A new key pair is generated for every transfer — nothing is reused across sessions.",
        "The shared AES-256-GCM key is derived independently on each device; it is never transmitted anywhere, including to Relayium's own servers.",
        "Encryption happens at the application layer, on top of WebRTC's own transport security, so it holds even if that transport layer were ever compromised.",
      ],
    },
    {
      heading: "The 6-digit code that catches a dishonest server",
      body: [
        "There's a subtlety worth being honest about. WebRTC's own built-in encryption (DTLS) exchanges key fingerprints through the signaling server that introduces the two devices to each other. If that server were dishonest, it could in theory sit in the middle and swap in its own keys — a classic man-in-the-middle attack — without either browser immediately noticing.",
        "Relayium closes that gap with a short verification code. Both devices derive the same 6-digit Short Authentication String (SAS) from their two public keys and display it on screen. If the codes match, the keys weren't swapped, and no one is in the middle. But a plain 6-digit code is only about 20 bits, which in principle a well-positioned attacker could try to brute-force into matching after seeing both real keys. To prevent that, Relayium uses a commit-then-reveal handshake: each side first sends a hash committing to its key, and only reveals the real key after receiving the other side's commitment. That ordering means a malicious server has to commit to a fake key blind, before it has seen the real one — it cannot pick a colliding key after the fact, so the short code stays trustworthy.",
      ],
      bullets: [
        "For the strongest guarantee, read the code aloud over a call or compare it in person, not just by eye on two screens next to each other.",
        "If the two codes don't match, stop — treat it as a sign someone may be intercepting the connection.",
      ],
    },
    {
      heading: "Making sure what arrives is exactly what was sent",
      body: [
        "Encryption protects secrecy, but it doesn't automatically prove nothing got corrupted or tampered with along the way. Relayium checks that separately: each chunk carries its own AES-GCM authentication tag, so a modified chunk fails to decrypt outright. On top of that, as each file is sent, both sides compute a running SHA-256 hash over its plaintext contents; when the file finishes, the sender's hash is compared against the receiver's. If they match, what landed on disk is byte-for-byte what was sent — if they don't, the file is flagged rather than silently accepted.",
      ],
    },
    {
      heading: "Stored links: a different key, generated once, held only in the link",
      body: [
        "Realtime transfer needs both people online at the same time. When that's not possible, Relayium offers a stored download link instead — and this uses a genuinely different mechanism, worth not confusing with the realtime one above.",
        "There's no key exchange here, because there's no second device to exchange with yet. Instead, your browser generates a single random AES-256-GCM key and uses it to encrypt the files before anything is uploaded. That key is never sent to the server at all — it's appended to the download link after a # character, in what's called the URL fragment, a part of the address that browsers deliberately never transmit to a server. The server ends up storing only ciphertext it has no way to decrypt, plus bookkeeping like the ciphertext's size and an expiry timestamp. Anyone who opens the full link — fragment included — can decrypt the file locally in their browser; anyone without it just sees an opaque blob on the server. That's the zero-knowledge part: the server holds the encrypted file without ever holding the means to read it.",
      ],
      bullets: [
        "Creating a stored link requires the sender to sign in; opening one to download never does.",
        "Links can be set to expire after 1 hour, 1 day, 3 days, or up to 7 days depending on your plan, or to burn after the first completed download.",
        "Treat the full link like the file itself — anyone who has it can decrypt it, so share it the way you'd share the file.",
      ],
    },
    {
      heading: "What the server can see — and what it can't",
      body: [
        "It's worth spelling out exactly where the server sits in all of this, because \"end-to-end encrypted\" is a claim that's easy to make and harder to make precisely. In realtime mode, the file itself never touches Relayium's servers at all — it streams directly between the two browsers. The signaling server's job is limited to relaying connection-setup messages (the technical SDP/ICE information WebRTC needs to establish a direct link) so the two devices can find each other; it never sees file contents, filenames, or keys.",
        "Across networks — where restrictive NATs and firewalls often rule out a direct path — the encrypted stream runs over a TURN relay server. The relay only ever forwards ciphertext; it has no key and cannot decrypt what passes through it. What it does do is count the bytes it relays against the sending account's monthly relay allowance, purely for metering and abuse prevention — never inspecting what's inside.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Can Relayium read my files?",
        a: "No. In realtime mode, the encryption key is derived independently on both devices and never leaves them — Relayium's servers never see it or the file contents. For stored links, the key lives only in the URL fragment, which browsers never send to any server, so the server only ever holds ciphertext it cannot decrypt.",
      },
      {
        q: "What does the server actually see?",
        a: "In realtime mode, only the connection-setup information needed to introduce two devices to each other — never file bytes. For stored links, it sees ciphertext plus bookkeeping like size and expiry time — never the plaintext, filenames, or the decryption key.",
      },
      {
        q: "Is the TURN relay a weak point?",
        a: "It's a fallback used only when a direct connection isn't possible, and it only ever handles ciphertext — it has no key, so it can't read what it's relaying. Relayium counts the bytes it relays against your account's monthly allowance, but never inspects their contents.",
      },
      {
        q: "Is Relayium open source?",
        a: "Yes. The protocol design and all client and server code are public on GitHub under the MIT license, so the cryptography described here can be independently audited rather than taken on trust.",
      },
      {
        q: "What if the two verification codes on screen don't match?",
        a: "Stop the transfer. A mismatch means the commit-then-reveal check failed, which points to a possible man-in-the-middle rather than a benign glitch — don't proceed until you understand why.",
      },
    ],
  },
  cta: {
    text: "Curious what it looks like in practice? Start a transfer and watch the verification code appear for yourself.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 如何对文件端到端加密",
  description:
    "用大白话讲清 Relayium 的加密方式：实时传输用 X25519 加 AES-256-GCM，一段六位校验码识破不诚实的服务器，存储链接则采用零知识方案。",
  updatedLabel: "最近更新",
  lead: [
    "「Relayium 安全吗？」是个合理的问题——每个文件传输工具都会说自己保护隐私。本文用大白话讲清 Relayium 到底如何保护文件隐私，让你能自己判断这个说法，而不是单凭信任。",
    "这里其实有两套不同的加密方案，因为存在两种不同的场景：把文件实时发给一个此刻在线的人，或者留一个下载链接给对方稍后来取。两种方式都让服务器碰不到你的文件，但实现路径不同——搞清楚什么时候用哪种，是值得的。",
  ],
  sections: [
    {
      heading: "实时传输：两台设备协商出一个服务器永远看不到的秘密",
      body: [
        "当你实时发送文件时——双方都在线，浏览器对浏览器——Relayium 会先让每台设备用 X25519 生成一对全新的密钥。这正是现代安全通讯普遍采用的椭圆曲线密钥交换算法（技术上是 libsodium 的 crypto_kx）。每台设备都把私钥留在自己手里，只把公钥发给对方。",
        "凭这两把公钥，每台设备各自独立算出同一个共享密钥——这之所以行得通，是椭圆曲线密钥交换本身的数学特性决定的，而不是因为这个密钥被发送到了哪里。这个共享密钥会变成一把只存在于两端浏览器内的 AES-256-GCM 密钥。文件的每个数据块在离开发送方设备之前，都会用这把密钥配合唯一的随机数封装，因此任何经过网络的东西——包括帮两台浏览器互相找到对方的信令服务器——看到的都只是密文。",
      ],
      bullets: [
        "每次传输都会生成一对全新的密钥——不会跨会话复用。",
        "共享的 AES-256-GCM 密钥在每台设备上独立推导得出；它从不会被发送到任何地方，包括 Relayium 自己的服务器。",
        "加密发生在应用层，位于 WebRTC 自身传输层安全之上，因此即便传输层被攻破，加密依然有效。",
      ],
    },
    {
      heading: "识破不诚实服务器的六位校验码",
      body: [
        "这里有个值得坦白说明的细微之处。WebRTC 自带的加密（DTLS）会通过负责撮合两台设备的信令服务器交换密钥指纹。如果这个服务器不诚实，理论上它可以居中调包成自己的密钥——一次经典的中间人攻击——而两端浏览器不会立刻察觉。",
        "Relayium 用一段简短的校验码堵上这个缺口。两台设备都从各自的公钥推导出同一段 6 位短校验码（SAS），并显示在屏幕上。如果两边的码一致，说明密钥没有被调包，中间没有人。但一段普通的 6 位数字码只有约 20 比特，一个位置合适的攻击者理论上可以在看到双方真实密钥后暴力凑出一个匹配的码。为防止这一点，Relayium 采用「先承诺后揭示」的握手方式：双方先各自发送一段对自己密钥的哈希承诺，收到对方的承诺之后才揭示真正的密钥。这个顺序意味着恶意服务器必须在还没见到真实密钥的情况下盲目地承诺一个伪造密钥——它无法事后再挑一个能撞上的密钥，短校验码因此依然可信。",
      ],
      bullets: [
        "为获得最强的保证，请通过通话读出校验码或当面核对，而不只是各自看屏幕上的数字。",
        "如果两边的码不一致，请立即停止：这可能意味着有人正在拦截连接。",
      ],
    },
    {
      heading: "确认到手的和发出的分毫不差",
      body: [
        "加密保护的是保密性，但它并不能自动证明传输过程中什么都没有损坏或被篡改。Relayium 会单独检查这一点：每个数据块都带有自己的 AES-GCM 认证标签，被改动过的数据块会直接解密失败。除此之外，在发送每个文件的过程中，收发双方都会对明文内容持续计算一个 SHA-256 哈希；文件传完后，发送方的哈希会与接收方的做比对。如果一致，落到磁盘上的内容与发出的逐字节相同；如果不一致，这个文件会被标记出来，而不是被悄悄接受。",
      ],
    },
    {
      heading: "存储链接：一把只生成一次、只存在于链接里的不同密钥",
      body: [
        "实时传输需要双方同时在线。做不到这一点时，Relayium 提供存储下载链接作为替代——它采用的是一套确实不同的机制，不要和上面的实时方案混为一谈。",
        "这里没有密钥交换，因为此刻还没有第二台设备可以交换。取而代之的是，你的浏览器会生成一把随机的 AES-256-GCM 密钥，在任何内容上传之前先用它加密文件。这把密钥完全不会发给服务器——它被附加在下载链接的 # 字符之后，也就是所谓的 URL 片段，这部分地址浏览器有意从不发送给服务器。服务器最终只存下它无法解密的密文，外加密文大小、过期时间等记账信息。任何拿到完整链接（包含片段）的人都能在自己浏览器本地解密文件；没有这个片段的人，在服务器上看到的只是一团不透明的数据。这就是零知识的部分：服务器持有加密后的文件，却从不掌握读懂它的手段。",
      ],
      bullets: [
        "创建存储链接需要发送方登录；打开链接下载则从不需要账号。",
        "链接可设置 1 小时、1 天、3 天或最长 7 天后过期（上限取决于套餐），也可以设为首次下载完成后即焚。",
        "把完整链接当作文件本身对待——任何拿到它的人都能解密，因此请像分享文件一样谨慎分享它。",
      ],
    },
    {
      heading: "服务器能看到什么，又看不到什么",
      body: [
        "有必要把服务器在其中扮演的角色说清楚，因为「端到端加密」这句话说起来容易，说准确却没那么简单。在实时模式下，文件本身完全不经过 Relayium 的服务器——它直接在两端浏览器之间流动。信令服务器的职责仅限于转发建立连接所需的消息（WebRTC 建立直连所需的 SDP/ICE 技术信息），帮两台设备互相找到对方；它从不看到文件内容、文件名或密钥。",
        "跨网络传输的加密数据流经 TURN 中继服务器转发——在受限的 NAT 或防火墙之后，直连往往根本无从建立。中继只转发密文；它没有密钥，无法解密经过它的任何内容。它会做的是把中继的字节数计入发送方账号的每月中继额度，纯粹用于计量和防止滥用——从不检查里面的内容。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 能读到我的文件吗？",
        a: "不能。实时模式下，加密密钥在两台设备上各自独立推导，从不离开设备——Relayium 的服务器从未见过这把密钥或文件内容。对于存储链接，密钥只存在于 URL 片段中，浏览器从不会把它发给任何服务器，因此服务器始终只持有它无法解密的密文。",
      },
      {
        q: "服务器到底能看到什么？",
        a: "实时模式下，只能看到用来撮合两台设备的连接建立信息——从不涉及文件字节。对于存储链接，它能看到密文以及大小、过期时间等记账信息——从不涉及明文、文件名或解密密钥。",
      },
      {
        q: "TURN 中继是不是一个薄弱环节？",
        a: "它只是在无法直连时才启用的兜底方案，且始终只处理密文——它没有密钥，无法读取经它中继的内容。Relayium 会把中继的字节数计入你账号的每月额度，但从不检查内容本身。",
      },
      {
        q: "Relayium 是开源的吗？",
        a: "是的。协议设计以及全部前后端代码都以 MIT 许可证公开在 GitHub 上，因此这里描述的加密方案可以被独立审查，而不必单凭信任。",
      },
      {
        q: "如果屏幕上两边的校验码不一致怎么办？",
        a: "立即停止传输。码不一致意味着「先承诺后揭示」的校验没有通过，这指向的是可能存在中间人，而不是一次无害的小故障——在弄清楚原因之前不要继续。",
      },
    ],
  },
  cta: {
    text: "想亲眼看看实际效果？发起一次传输，亲自见证校验码的出现。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium がファイルをエンドツーエンドで暗号化する仕組み",
  description:
    "Relayium がファイルをどう守るかを平易に解説。リアルタイム転送は X25519 と AES-256-GCM、不正なサーバーを見破る6桁の検証コード、そしてゼロ知識の保存リンク。",
  updatedLabel: "最終更新",
  lead: [
    "「Relayium は安全なの？」というのは当然の疑問です——どのファイル転送ツールもプライバシーを守ると謳っています。このページでは、Relayium が実際にどうやってファイルを守っているのかを平易な言葉で説明します。信じるかどうかではなく、自分で判断できるように。",
    "実は2つの異なる暗号方式が使われています。理由は状況が2つあるからです。今まさにオンラインの相手にファイルをリアルタイムで送る場合と、あとで受け取ってもらうためにダウンロードリンクを残しておく場合です。どちらもサーバーをファイルから締め出しますが、そこへの至り方は異なります——どちらがどの場面に当てはまるのか、知っておく価値があります。",
  ],
  sections: [
    {
      heading: "リアルタイム転送：2台のデバイスがサーバーには見えない秘密を共有する",
      body: [
        "リアルタイムでファイルを送るとき——双方がオンラインで、ブラウザ同士——Relayium はまず各デバイスに X25519 で新しい鍵ペアを生成させます。これは現代の安全なメッセージングで広く使われている楕円曲線鍵交換と同じ方式です（技術的には libsodium の crypto_kx）。各デバイスは秘密鍵を自分だけに留め、公開鍵だけを相手に送ります。",
        "この2つの公開鍵から、各デバイスはそれぞれ独立に同じ共有秘密を計算します——これは秘密がどこかへ送られたからではなく、楕円曲線鍵交換という仕組みそのものによって成り立つ処理です。その共有秘密は、両ブラウザ内にのみ存在する AES-256-GCM 鍵になります。ファイルの各チャンクは、送信側デバイスを離れる前にこの鍵と一意のノンスで封印されるため、ネットワークを通過するもの——2台のブラウザが互いを見つける手助けをしたシグナリングサーバーも含めて——は暗号文しか目にしません。",
      ],
      bullets: [
        "転送ごとに新しい鍵ペアが生成され、セッションをまたいで再利用されることはありません。",
        "共有される AES-256-GCM 鍵は各デバイスで独立に導出され、Relayium 自身のサーバーを含め、どこにも送信されません。",
        "暗号化は WebRTC 自体のトランスポート層セキュリティの上、アプリケーション層で行われるため、トランスポート層が侵害されても有効性を保ちます。",
      ],
    },
    {
      heading: "不正なサーバーを見破る6桁のコード",
      body: [
        "ここには正直に触れておくべき細部があります。WebRTC 標準の暗号化（DTLS）は、2台のデバイスを引き合わせるシグナリングサーバー経由で鍵のフィンガープリントを交換します。もしそのサーバーが不正であれば、理論上は中間に入って自分の鍵にすり替えることができます——典型的な中間者攻撃で、しかもどちらのブラウザもすぐには気づきません。",
        "Relayium はこの隙を短い検証コードで塞ぎます。両方のデバイスは双方の公開鍵から同じ6桁の Short Authentication String（SAS）を導出し、画面に表示します。2つのコードが一致すれば鍵はすり替えられておらず、中間には誰もいません。しかし単純な6桁のコードは約20ビットしかなく、原理的には双方の本物の鍵を見た攻撃者が一致するコードを総当たりで作り出そうとする余地があります。それを防ぐため、Relayium はコミット後開示ハンドシェイクを使います。各側はまず自分の鍵に対するハッシュを送ってコミットし、相手のコミットメントを受け取ってから初めて本物の鍵を開示します。この順序によって、悪意あるサーバーは本物の鍵を見る前に盲目的に偽の鍵をコミットせざるを得ず、後から衝突する鍵を選ぶことはできません。だから短いコードは信頼できるままなのです。",
      ],
      bullets: [
        "最も強い保証を得るには、隣り合った2つの画面を目で見比べるだけでなく、通話でコードを読み上げるか、対面で照合してください。",
        "2つのコードが一致しない場合は中止してください。誰かが接続を傍受している可能性を示すサインです。",
      ],
    },
    {
      heading: "届いたものが送ったものと寸分違わないことを確認する",
      body: [
        "暗号化は機密性を守りますが、途中で何も壊れたり改ざんされたりしていないことを自動的に証明するわけではありません。Relayium はそれを別途確認します。各チャンクには独自の AES-GCM 認証タグが付いており、改ざんされたチャンクはそもそも復号に失敗します。それに加えて、各ファイルの送信中、双方がその平文内容に対して SHA-256 ハッシュを継続的に計算します。ファイルが終わると、送信側のハッシュが受信側のものと照合されます。一致すればディスクに届いたものは送られたものとバイト単位で同一であり、一致しなければそのファイルは黙って受け入れられるのではなく、フラグが立てられます。",
      ],
    },
    {
      heading: "保存リンク：一度だけ生成され、リンクの中にしか存在しない別の鍵",
      body: [
        "リアルタイム転送には双方が同時にオンラインである必要があります。それができないとき、Relayium は代わりに保存型のダウンロードリンクを提供します——これは本当に異なる仕組みを使っているので、上記のリアルタイム方式と混同しないでください。",
        "ここには鍵交換がありません。まだ交換する相手のデバイスが存在しないからです。代わりに、あなたのブラウザは1つのランダムな AES-256-GCM 鍵を生成し、何かがアップロードされる前にそれでファイルを暗号化します。この鍵はサーバーには一切送られません——ダウンロードリンクの # という文字の後ろに付加される、いわゆる URL フラグメントに置かれます。この部分のアドレスはブラウザが意図的にサーバーへ送信しないものです。結果としてサーバーが保存するのは、復号する術のない暗号文と、暗号文のサイズや有効期限のタイムスタンプといった管理情報だけです。フラグメントを含む完全なリンクを開いた人は誰でも、自分のブラウザ内でローカルにファイルを復号できます。それを持たない人には、サーバー上の中身の分からない塊が見えるだけです。これがゼロ知識という部分です。サーバーは暗号化されたファイルを保持していても、それを読む手段を一度も持たないのです。",
      ],
      bullets: [
        "保存リンクの作成には送信者のサインインが必要ですが、ダウンロードのためにリンクを開くのに必要になることはありません。",
        "リンクは1時間、1日、3日、最長7日（プランによる）で失効するよう設定するか、最初のダウンロード完了後に消えるよう設定できます。",
        "完全なリンクはファイルそのものとして扱ってください——それを持つ人は誰でも復号できるため、ファイルを共有するのと同じ慎重さで共有してください。",
      ],
    },
    {
      heading: "サーバーが見えるもの、見えないもの",
      body: [
        "サーバーがこの仕組みのどこに位置しているのかを正確に説明しておく価値があります。「エンドツーエンドで暗号化されている」という主張は口にするのは簡単でも、正確に言うのは意外と難しいからです。リアルタイムモードでは、ファイル自体は Relayium のサーバーに一切触れません——2台のブラウザ間を直接ストリーミングされます。シグナリングサーバーの役割は、接続確立のためのメッセージ（WebRTC が直接リンクを確立するのに必要な SDP/ICE の技術情報)を中継し、2台のデバイスが互いを見つけられるようにすることに限られます。ファイルの内容やファイル名、鍵を目にすることは一切ありません。",
        "ネットワークをまたぐ転送では——制限の厳しい NAT やファイアウォールの内側では直接経路が成立しないことが多いため——暗号化ストリームは TURN 中継サーバーを経由します。中継が転送するのは暗号文だけです。鍵を持たないため、そこを通過する内容を復号することはできません。中継が行うのは、送信側アカウントの月間中継割り当てに対して中継したバイト数を数えることだけで、それは純粋に計量と不正利用防止のためであり、中身を検査することは決してありません。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium は私のファイルを読めますか？",
        a: "いいえ。リアルタイムモードでは、暗号鍵は両方のデバイスで独立に導出され、デバイスの外に出ることはありません——Relayium のサーバーがその鍵やファイルの中身を目にすることは一切ありません。保存リンクの場合、鍵は URL フラグメントにのみ存在し、ブラウザはそれをどのサーバーにも送信しないため、サーバーは復号できない暗号文しか持ちません。",
      },
      {
        q: "サーバーは実際には何を見ているのですか？",
        a: "リアルタイムモードでは、2台のデバイスを引き合わせるために必要な接続確立情報だけを見ます——ファイルのバイトは一切見ません。保存リンクの場合、暗号文とサイズ・有効期限といった管理情報を見ます——平文やファイル名、復号鍵を見ることは一切ありません。",
      },
      {
        q: "TURN 中継は弱点になりませんか？",
        a: "それは直接接続ができない場合にのみ使われるフォールバックであり、常に暗号文しか扱いません——鍵を持たないため、中継している内容を読むことはできません。Relayium は中継したバイト数をあなたのアカウントの月間割り当てに対して数えますが、中身を検査することはありません。",
      },
      {
        q: "Relayium はオープンソースですか？",
        a: "はい。プロトコル設計とクライアント・サーバーの全コードは MIT ライセンスのもと GitHub で公開されているため、ここで説明した暗号方式は信じるしかないものではなく、独自に監査できます。",
      },
      {
        q: "画面上の2つの検証コードが一致しない場合はどうすればいいですか？",
        a: "転送を中止してください。コードが一致しないということは、コミット後開示の検証が失敗したことを意味し、単なる不具合ではなく中間者の存在を示している可能性があります——理由が分かるまで先に進まないでください。",
      },
    ],
  },
  cta: {
    text: "実際にどう見えるか気になりますか？転送を開始して、検証コードが表示される様子を自分の目で確かめてください。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium이 파일을 종단간 암호화하는 방식",
  description:
    "Relayium이 파일을 어떻게 보호하는지 쉽게 설명합니다. 실시간 전송은 X25519와 AES-256-GCM, 부정직한 서버를 잡아내는 6자리 검증 코드, 그리고 영지식 저장 링크까지.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "\"Relayium은 안전한가요?\"는 합리적인 질문입니다——모든 파일 전송 도구가 프라이버시를 지킨다고 말하니까요. 이 페이지는 Relayium이 실제로 파일을 어떻게 보호하는지 쉬운 말로 짚어보아, 그 말을 그냥 믿는 대신 스스로 판단할 수 있게 해드립니다.",
    "여기에는 서로 다른 두 가지 암호화 방식이 작동합니다. 상황이 두 가지이기 때문입니다. 지금 온라인 상태인 상대에게 실시간으로 파일을 보내는 경우와, 나중에 받아가도록 다운로드 링크를 남겨두는 경우입니다. 둘 다 서버가 당신의 파일에 접근하지 못하게 하지만, 그 방식은 서로 다릅니다——언제 어떤 방식이 적용되는지 알아둘 가치가 있습니다.",
  ],
  sections: [
    {
      heading: "실시간 전송: 서버가 절대 볼 수 없는 비밀을 두 기기가 합의하다",
      body: [
        "실시간으로 파일을 보낼 때——양쪽 모두 온라인 상태로, 브라우저 대 브라우저——Relayium은 먼저 각 기기가 X25519로 새로운 키 쌍을 생성하게 합니다. 이는 현대 보안 메신저에서 널리 쓰이는 것과 같은 타원곡선 키 교환 방식입니다(기술적으로는 libsodium의 crypto_kx). 각 기기는 개인 키를 자신만 갖고, 공개 키만 상대에게 보냅니다.",
        "이 두 공개 키로부터 각 기기는 독립적으로 동일한 공유 비밀을 계산해냅니다——이는 비밀이 어딘가로 전송되었기 때문이 아니라, 타원곡선 키 교환이라는 방식 자체가 그렇게 작동하기 때문입니다. 이 공유 비밀은 두 브라우저 안에만 존재하는 AES-256-GCM 키가 됩니다. 파일의 각 청크는 발신 기기를 떠나기 전에 이 키와 고유한 논스로 봉인되므로, 네트워크를 지나가는 것——두 브라우저가 서로를 찾도록 도운 시그널링 서버를 포함해서——은 오직 암호문만 보게 됩니다.",
      ],
      bullets: [
        "전송마다 새로운 키 쌍이 생성되며, 세션 간에 재사용되지 않습니다.",
        "공유되는 AES-256-GCM 키는 각 기기에서 독립적으로 도출되며, Relayium 자체 서버를 포함해 어디로도 전송되지 않습니다.",
        "암호화는 WebRTC 자체의 전송 계층 보안 위, 애플리케이션 계층에서 이루어지므로 전송 계층이 침해되더라도 유효성을 유지합니다.",
      ],
    },
    {
      heading: "부정직한 서버를 잡아내는 6자리 코드",
      body: [
        "여기서 솔직히 짚고 넘어갈 부분이 있습니다. WebRTC 자체 내장 암호화(DTLS)는 두 기기를 소개해주는 시그널링 서버를 통해 키 지문을 교환합니다. 만약 그 서버가 부정직하다면, 이론적으로는 중간에 끼어들어 자신의 키로 바꿔치기할 수 있습니다——고전적인 중간자 공격이며, 양쪽 브라우저 모두 즉시 알아차리지 못할 수 있습니다.",
        "Relayium은 짧은 검증 코드로 이 틈을 막습니다. 두 기기는 각자의 공개 키에서 동일한 6자리 Short Authentication String(SAS)을 도출해 화면에 표시합니다. 두 코드가 일치하면 키가 바뀌지 않았고 중간에 아무도 없다는 뜻입니다. 하지만 단순한 6자리 코드는 약 20비트에 불과해서, 원칙적으로는 유리한 위치에 있는 공격자가 양쪽의 진짜 키를 본 뒤 일치하는 코드를 무차별 대입으로 만들어낼 여지가 있습니다. 이를 막기 위해 Relayium은 커밋 후 공개 핸드셰이크를 사용합니다. 각 측은 먼저 자신의 키에 대한 해시를 보내 커밋하고, 상대방의 커밋을 받은 후에야 진짜 키를 공개합니다. 이 순서 덕분에 악의적인 서버는 진짜 키를 보기도 전에 눈을 감은 채 가짜 키를 커밋해야 하며, 나중에 충돌하는 키를 고를 수 없습니다. 그래서 짧은 코드가 계속 신뢰할 수 있는 상태로 남는 것입니다.",
      ],
      bullets: [
        "가장 강력한 보장을 위해서는 나란히 놓인 두 화면을 눈으로 보기만 하지 말고, 통화로 코드를 소리 내어 읽거나 직접 만나 대조하세요.",
        "두 코드가 일치하지 않으면 중단하세요. 누군가 연결을 가로채고 있다는 신호로 받아들이십시오.",
      ],
    },
    {
      heading: "도착한 것이 보낸 것과 정확히 같은지 확인하기",
      body: [
        "암호화는 기밀성을 지켜주지만, 전송 도중 아무것도 손상되거나 변조되지 않았음을 자동으로 증명해주지는 않습니다. Relayium은 이를 별도로 확인합니다. 각 청크는 자체 AES-GCM 인증 태그를 가지고 있어, 변조된 청크는 애초에 복호화에 실패합니다. 여기에 더해, 각 파일이 전송되는 동안 양쪽 모두 그 평문 내용에 대해 SHA-256 해시를 계속 계산합니다. 파일 전송이 끝나면 발신 측의 해시와 수신 측의 해시를 비교합니다. 일치하면 디스크에 도착한 것은 보낸 것과 바이트 단위로 동일한 것이고, 일치하지 않으면 그 파일은 조용히 받아들여지는 대신 표시가 됩니다.",
      ],
    },
    {
      heading: "저장 링크: 한 번만 생성되어 링크에만 존재하는 다른 키",
      body: [
        "실시간 전송은 양쪽이 동시에 온라인이어야 합니다. 그것이 불가능할 때 Relayium은 대신 저장형 다운로드 링크를 제공합니다——이는 위의 실시간 방식과 혼동하지 말아야 할, 진짜로 다른 메커니즘을 사용합니다.",
        "여기에는 키 교환이 없습니다. 아직 교환할 상대 기기가 존재하지 않기 때문입니다. 대신 당신의 브라우저는 하나의 무작위 AES-256-GCM 키를 생성하고, 무언가 업로드되기 전에 그것으로 파일을 암호화합니다. 이 키는 서버로 전혀 전송되지 않습니다——다운로드 링크의 # 문자 뒤에 덧붙는, 이른바 URL 프래그먼트에 놓입니다. 이 부분의 주소는 브라우저가 의도적으로 서버에 전송하지 않는 부분입니다. 결과적으로 서버는 복호화할 방법이 없는 암호문과, 암호문 크기·만료 시각 같은 관리 정보만 저장하게 됩니다. 프래그먼트를 포함한 완전한 링크를 여는 사람은 누구나 자신의 브라우저 안에서 로컬로 파일을 복호화할 수 있습니다. 그것이 없는 사람에게는 서버에서 그저 알아볼 수 없는 덩어리로만 보입니다. 이것이 영지식이라는 부분입니다. 서버는 암호화된 파일을 보관하지만, 그것을 읽을 수단은 한 번도 갖지 않습니다.",
      ],
      bullets: [
        "저장 링크를 만들려면 발신자가 로그인해야 하지만, 다운로드를 위해 링크를 여는 데는 계정이 전혀 필요하지 않습니다.",
        "링크는 1시간, 1일, 3일, 최대 7일(요금제에 따라 다름) 후 만료되도록 설정하거나, 첫 다운로드가 완료된 후 소멸하도록 설정할 수 있습니다.",
        "완전한 링크를 파일 자체처럼 다루세요——그것을 가진 사람은 누구나 복호화할 수 있으므로, 파일을 공유할 때처럼 신중하게 공유하세요.",
      ],
    },
    {
      heading: "서버가 볼 수 있는 것, 그리고 볼 수 없는 것",
      body: [
        "서버가 이 모든 과정에서 정확히 어디에 위치하는지 짚어볼 가치가 있습니다. \"종단간 암호화\"라는 말은 하기는 쉬워도 정확히 말하기는 어렵기 때문입니다. 실시간 모드에서는 파일 자체가 Relayium의 서버를 전혀 거치지 않습니다——두 브라우저 사이에서 직접 스트리밍됩니다. 시그널링 서버의 역할은 연결 설정 메시지(WebRTC가 직접 연결을 맺는 데 필요한 SDP/ICE 기술 정보)를 중계해 두 기기가 서로를 찾도록 돕는 데 국한됩니다. 파일 내용이나 파일 이름, 키를 보는 일은 전혀 없습니다.",
        "네트워크를 넘는 전송에서는——제한적인 NAT나 방화벽 뒤에서는 직접 경로가 열리지 않는 경우가 많기 때문에——암호화된 스트림이 TURN 중계 서버를 거칩니다. 중계 서버는 오직 암호문만 전달합니다. 키가 없으므로 그것을 통과하는 내용을 복호화할 수 없습니다. 중계 서버가 하는 일은 발신 계정의 월간 중계 허용량에 대해 중계한 바이트 수를 세는 것뿐이며, 이는 순전히 계량과 남용 방지를 위한 것으로, 내용을 검사하는 일은 결코 없습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium이 제 파일을 읽을 수 있나요?",
        a: "아니요. 실시간 모드에서 암호화 키는 두 기기에서 독립적으로 도출되며 기기를 떠나지 않습니다——Relayium의 서버는 이 키나 파일 내용을 전혀 보지 못합니다. 저장 링크의 경우 키는 URL 프래그먼트에만 존재하며, 브라우저는 이를 어떤 서버로도 보내지 않으므로 서버는 복호화할 수 없는 암호문만 갖게 됩니다.",
      },
      {
        q: "서버는 실제로 무엇을 보나요?",
        a: "실시간 모드에서는 두 기기를 서로 소개하는 데 필요한 연결 설정 정보만 봅니다——파일 바이트는 전혀 보지 않습니다. 저장 링크의 경우 암호문과 크기·만료 시각 같은 관리 정보를 봅니다——평문, 파일 이름, 복호화 키는 전혀 보지 않습니다.",
      },
      {
        q: "TURN 중계가 약점이 되지 않나요?",
        a: "직접 연결이 불가능할 때만 쓰이는 대체 수단이며, 항상 암호문만 다룹니다——키가 없으므로 중계하는 내용을 읽을 수 없습니다. Relayium은 중계한 바이트 수를 계정의 월간 허용량에 대해 집계하지만, 내용은 절대 검사하지 않습니다.",
      },
      {
        q: "Relayium은 오픈 소스인가요?",
        a: "네. 프로토콜 설계와 클라이언트·서버의 모든 코드가 MIT 라이선스로 GitHub에 공개되어 있어, 여기서 설명한 암호화 방식을 그냥 믿는 대신 독립적으로 감사할 수 있습니다.",
      },
      {
        q: "화면에 표시된 두 검증 코드가 일치하지 않으면 어떻게 하나요?",
        a: "전송을 중단하세요. 코드가 일치하지 않는다는 것은 커밋 후 공개 검증이 실패했다는 뜻이며, 단순한 오류가 아니라 중간자 공격 가능성을 가리킵니다——이유를 파악하기 전까지는 계속 진행하지 마세요.",
      },
    ],
  },
  cta: {
    text: "실제로 어떻게 보이는지 궁금하신가요? 전송을 시작해서 검증 코드가 나타나는 것을 직접 확인해 보세요.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Wie Relayium Ihre Dateien Ende-zu-Ende verschlüsselt",
  description:
    "Wie Relayium Dateien schützt: X25519 und AES-256-GCM live, ein sechsstelliger Code gegen unehrliche Server und Zero-Knowledge-Speicherlinks.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "„Ist Relayium sicher?“ ist eine berechtigte Frage — jedes Dateiübertragungs-Tool behauptet, privat zu sein. Diese Seite erklärt in einfachen Worten, wie Relayium Dateien tatsächlich privat hält, damit Sie die Behauptung selbst beurteilen können, statt sie einfach zu glauben.",
    "Es sind zwei unterschiedliche Verschlüsselungsverfahren im Spiel, weil es zwei unterschiedliche Situationen gibt: eine Datei live an jemanden zu senden, der gerade online ist, und einen Download-Link zu hinterlassen, den sich jemand später abholt. Beide halten den Server von Ihrer Datei fern, kommen aber auf unterschiedlichen Wegen dorthin — und es lohnt sich zu wissen, welches Verfahren wann gilt.",
  ],
  sections: [
    {
      heading: "Live-Übertragungen: Zwei Geräte einigen sich auf ein Geheimnis, das der Server nie sieht",
      body: [
        "Wenn Sie eine Datei in Echtzeit senden — beide online, Browser zu Browser —, lässt Relayium zuerst jedes Gerät ein frisches Schlüsselpaar mit X25519 erzeugen, demselben Verfahren zum Schlüsselaustausch auf Basis elliptischer Kurven, das auch in moderner sicherer Kommunikation verbreitet ist (technisch: crypto_kx aus libsodium). Jedes Gerät behält seinen privaten Schlüssel für sich und sendet nur den öffentlichen Schlüssel an die Gegenseite.",
        "Aus diesen beiden öffentlichen Schlüsseln berechnet jedes Gerät unabhängig dasselbe gemeinsame Geheimnis — das funktioniert genau deshalb, weil ein Schlüsselaustausch über elliptische Kurven so konstruiert ist, nicht weil das Geheimnis irgendwohin gesendet wurde. Aus diesem gemeinsamen Geheimnis wird ein AES-256-GCM-Schlüssel, der nur innerhalb der beiden Browser existiert. Jeder Chunk der Datei wird mit diesem Schlüssel und einer eindeutigen Nonce versiegelt, bevor er das Gerät des Absenders überhaupt verlässt — alles, was das Netzwerk durchquert, einschließlich des Signalisierungsservers, der den beiden Browsern half, sich zu finden, sieht also nur Chiffretext.",
      ],
      bullets: [
        "Für jede Übertragung wird ein neues Schlüsselpaar erzeugt — nichts wird über Sitzungen hinweg wiederverwendet.",
        "Der gemeinsame AES-256-GCM-Schlüssel wird auf jedem Gerät unabhängig abgeleitet; er wird nie irgendwohin übertragen, auch nicht an Relayiums eigene Server.",
        "Die Verschlüsselung erfolgt auf der Anwendungsebene, oberhalb der eigenen Transportsicherheit von WebRTC, und bleibt daher selbst dann wirksam, wenn diese Transportebene jemals kompromittiert würde.",
      ],
    },
    {
      heading: "Der sechsstellige Code, der einen unehrlichen Server entlarvt",
      body: [
        "Hier gibt es eine Feinheit, die man offen ansprechen sollte. Die in WebRTC eingebaute Verschlüsselung (DTLS) tauscht Schlüssel-Fingerabdrücke über den Signalisierungsserver aus, der die beiden Geräte einander vorstellt. Wäre dieser Server unehrlich, könnte er sich theoretisch dazwischenschalten und eigene Schlüssel unterschieben — ein klassischer Man-in-the-Middle-Angriff, den keiner der beiden Browser sofort bemerken würde.",
        "Relayium schließt diese Lücke mit einem kurzen Prüfcode. Beide Geräte leiten aus ihren beiden öffentlichen Schlüsseln denselben sechsstelligen Short Authentication String (SAS) ab und zeigen ihn auf dem Bildschirm an. Stimmen die Codes überein, wurden die Schlüssel nicht ausgetauscht, und niemand sitzt dazwischen. Ein einfacher sechsstelliger Code hat jedoch nur etwa 20 Bit, was ein gut positionierter Angreifer im Prinzip per Brute Force zu einem passenden Code verarbeiten könnte, nachdem er beide echten Schlüssel gesehen hat. Um das zu verhindern, nutzt Relayium einen Commit-dann-Offenlegen-Handshake: Jede Seite sendet zunächst einen Hash, der sich auf ihren Schlüssel festlegt, und gibt den echten Schlüssel erst preis, nachdem sie die Festlegung der Gegenseite erhalten hat. Diese Reihenfolge zwingt einen bösartigen Server dazu, sich blind — bevor er den echten Schlüssel gesehen hat — auf einen gefälschten Schlüssel festzulegen; er kann also nicht nachträglich einen kollidierenden Schlüssel wählen, weshalb der kurze Code vertrauenswürdig bleibt.",
      ],
      bullets: [
        "Für die stärkste Garantie lesen Sie den Code laut in einem Anruf vor oder vergleichen ihn persönlich — nicht nur mit den Augen auf zwei nebeneinanderliegenden Bildschirmen.",
        "Stimmen die beiden Codes nicht überein, brechen Sie ab — das ist ein Hinweis darauf, dass jemand die Verbindung abfangen könnte.",
      ],
    },
    {
      heading: "Sicherstellen, dass ankommt, was gesendet wurde",
      body: [
        "Verschlüsselung schützt die Vertraulichkeit, beweist aber nicht automatisch, dass unterwegs nichts beschädigt oder manipuliert wurde. Relayium prüft das gesondert: Jeder Chunk trägt sein eigenes AES-GCM-Authentifizierungs-Tag, sodass ein veränderter Chunk erst gar nicht entschlüsselt werden kann. Zusätzlich berechnen beide Seiten während der Übertragung jeder Datei fortlaufend einen SHA-256-Hash über deren Klartextinhalt; ist die Datei fertig übertragen, wird der Hash des Absenders mit dem des Empfängers verglichen. Stimmen sie überein, ist das, was auf der Festplatte gelandet ist, Byte für Byte identisch mit dem Gesendeten — stimmen sie nicht überein, wird die Datei markiert, statt stillschweigend akzeptiert zu werden.",
      ],
    },
    {
      heading: "Gespeicherte Links: ein anderer Schlüssel, einmal erzeugt, nur im Link vorhanden",
      body: [
        "Die Echtzeitübertragung setzt voraus, dass beide gleichzeitig online sind. Ist das nicht möglich, bietet Relayium stattdessen einen gespeicherten Download-Link an — und dieser nutzt einen wirklich anderen Mechanismus, den man nicht mit dem oben beschriebenen Echtzeitverfahren verwechseln sollte.",
        "Hier findet kein Schlüsselaustausch statt, weil es noch kein zweites Gerät gibt, mit dem ausgetauscht werden könnte. Stattdessen erzeugt Ihr Browser einen einzigen zufälligen AES-256-GCM-Schlüssel und verschlüsselt damit die Dateien, bevor überhaupt etwas hochgeladen wird. Dieser Schlüssel wird niemals an den Server gesendet — er wird dem Download-Link nach einem #-Zeichen angehängt, im sogenannten URL-Fragment, einem Teil der Adresse, den Browser bewusst nie an einen Server übermitteln. Der Server speichert am Ende nur Chiffretext, den er auf keine Weise entschlüsseln kann, dazu Verwaltungsdaten wie die Größe des Chiffretexts und einen Ablauf-Zeitstempel. Wer den vollständigen Link öffnet — Fragment eingeschlossen —, kann die Datei lokal im eigenen Browser entschlüsseln; wer ihn nicht hat, sieht auf dem Server nur einen undurchsichtigen Datenblock. Das ist der Zero-Knowledge-Teil: Der Server hält die verschlüsselte Datei, ohne je die Mittel zu besitzen, sie zu lesen.",
      ],
      bullets: [
        "Das Erstellen eines gespeicherten Links erfordert die Anmeldung des Absenders; das Öffnen zum Herunterladen erfordert nie ein Konto.",
        "Links können so eingestellt werden, dass sie nach 1 Stunde, 1, 3 oder bis zu 7 Tagen je nach Tarif ablaufen, oder dass sie nach dem ersten vollständigen Download verfallen.",
        "Behandeln Sie den vollständigen Link wie die Datei selbst — jeder, der ihn besitzt, kann ihn entschlüsseln, teilen Sie ihn also so, wie Sie die Datei teilen würden.",
      ],
    },
    {
      heading: "Was der Server sehen kann — und was nicht",
      body: [
        "Es lohnt sich, genau zu benennen, wo der Server bei alldem steht, denn „Ende-zu-Ende verschlüsselt“ ist eine Behauptung, die sich leicht aufstellen, aber schwerer präzise belegen lässt. Im Echtzeitmodus berührt die Datei selbst Relayiums Server überhaupt nicht — sie wird direkt zwischen den beiden Browsern gestreamt. Die Aufgabe des Signalisierungsservers beschränkt sich darauf, Nachrichten zum Verbindungsaufbau weiterzuleiten (die technischen SDP/ICE-Informationen, die WebRTC benötigt, um eine direkte Verbindung herzustellen), damit sich die beiden Geräte finden können; er sieht nie Dateiinhalte, Dateinamen oder Schlüssel.",
        "Netzübergreifend — wo restriktive NATs oder Firewalls einen direkten Pfad ohnehin oft ausschließen — läuft der verschlüsselte Datenstrom über einen TURN-Relay-Server. Das Relay leitet ausschließlich Chiffretext weiter; es besitzt keinen Schlüssel und kann nicht entschlüsseln, was es durchleitet. Was es tut, ist die Anzahl der weitergeleiteten Bytes gegen das monatliche Weiterleitungskontingent des sendenden Kontos zu zählen, rein zur Abrechnung und Missbrauchsprävention — der Inhalt wird dabei nie eingesehen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kann Relayium meine Dateien lesen?",
        a: "Nein. Im Echtzeitmodus wird der Verschlüsselungsschlüssel auf beiden Geräten unabhängig abgeleitet und verlässt sie nie — Relayiums Server sehen ihn ebenso wenig wie den Dateiinhalt. Bei gespeicherten Links liegt der Schlüssel nur im URL-Fragment, das Browser nie an einen Server senden, sodass der Server stets nur Chiffretext hält, den er nicht entschlüsseln kann.",
      },
      {
        q: "Was sieht der Server tatsächlich?",
        a: "Im Echtzeitmodus nur die Informationen zum Verbindungsaufbau, die nötig sind, um zwei Geräte einander vorzustellen — nie Dateidaten. Bei gespeicherten Links sieht er Chiffretext sowie Verwaltungsdaten wie Größe und Ablaufzeit — nie den Klartext, Dateinamen oder den Entschlüsselungsschlüssel.",
      },
      {
        q: "Ist das TURN-Relay eine Schwachstelle?",
        a: "Es ist ein Rückfall, der nur genutzt wird, wenn eine direkte Verbindung nicht möglich ist, und es verarbeitet stets nur Chiffretext — es besitzt keinen Schlüssel und kann daher nicht lesen, was es weiterleitet. Relayium zählt die weitergeleiteten Bytes gegen das monatliche Kontingent Ihres Kontos, prüft aber nie deren Inhalt.",
      },
      {
        q: "Ist Relayium Open Source?",
        a: "Ja. Das Protokolldesign und der gesamte Client- und Servercode sind unter der MIT-Lizenz auf GitHub öffentlich, sodass die hier beschriebene Kryptografie unabhängig geprüft werden kann, statt sie einfach glauben zu müssen.",
      },
      {
        q: "Was, wenn die beiden Prüfcodes auf dem Bildschirm nicht übereinstimmen?",
        a: "Brechen Sie die Übertragung ab. Eine Abweichung bedeutet, dass die Commit-dann-Offenlegen-Prüfung fehlgeschlagen ist — das deutet eher auf einen möglichen Man-in-the-Middle als auf eine harmlose Störung hin. Fahren Sie erst fort, wenn Sie den Grund verstanden haben.",
      },
    ],
  },
  cta: {
    text: "Neugierig, wie das in der Praxis aussieht? Starten Sie eine Übertragung und sehen Sie den Prüfcode mit eigenen Augen erscheinen.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Comment Relayium chiffre vos fichiers de bout en bout",
  description:
    "Comment Relayium protège vos fichiers : X25519 et AES-256-GCM en direct, un code à six chiffres contre un serveur malhonnête, et des liens à connaissance nulle.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "« Relayium est-il sécurisé ? » est une question légitime — tout outil de transfert de fichiers prétend protéger la vie privée. Cette page explique exactement, en langage simple, comment Relayium garde vos fichiers privés, pour que vous puissiez juger l'affirmation plutôt que la croire sur parole.",
    "Deux mécanismes de chiffrement différents entrent en jeu, parce qu'il y a deux situations différentes : envoyer un fichier en direct à quelqu'un qui est en ligne à l'instant, et laisser un lien de téléchargement pour que quelqu'un le récupère plus tard. Les deux empêchent le serveur d'accéder à votre fichier, mais y parviennent par des chemins différents — et il vaut la peine de savoir lequel s'applique quand.",
  ],
  sections: [
    {
      heading: "Transferts en direct : deux appareils s'accordent sur un secret que le serveur ne voit jamais",
      body: [
        "Quand vous envoyez un fichier en temps réel — les deux personnes en ligne, navigateur à navigateur —, Relayium commence par faire générer à chaque appareil une nouvelle paire de clés avec X25519, le même échange de clés à courbe elliptique utilisé dans la messagerie sécurisée moderne (techniquement, crypto_kx de libsodium). Chaque appareil garde sa clé privée pour lui et n'envoie que sa clé publique à l'autre partie.",
        "À partir de ces deux clés publiques, chaque appareil calcule indépendamment le même secret partagé — un processus qui fonctionne précisément grâce à la construction mathématique de l'échange de clés à courbe elliptique, et non parce que le secret aurait été envoyé quelque part. Ce secret partagé devient une clé AES-256-GCM qui n'existe qu'à l'intérieur des deux navigateurs. Chaque bloc du fichier est scellé avec cette clé et un nonce unique avant même de quitter l'appareil de l'expéditeur, si bien que tout ce qui traverse le réseau — y compris le serveur de signalisation qui a aidé les deux navigateurs à se trouver — ne voit jamais que du chiffré.",
      ],
      bullets: [
        "Une nouvelle paire de clés est générée à chaque transfert — rien n'est réutilisé d'une session à l'autre.",
        "La clé AES-256-GCM partagée est dérivée indépendamment sur chaque appareil ; elle n'est jamais transmise nulle part, y compris aux propres serveurs de Relayium.",
        "Le chiffrement s'applique au niveau applicatif, au-dessus de la sécurité de transport propre à WebRTC, et tient donc même si cette couche de transport venait à être compromise.",
      ],
    },
    {
      heading: "Le code à 6 chiffres qui démasque un serveur malhonnête",
      body: [
        "Il y a une subtilité qu'il vaut la peine d'exposer honnêtement. Le chiffrement intégré de WebRTC (DTLS) échange les empreintes de clés via le serveur de signalisation qui présente les deux appareils l'un à l'autre. Si ce serveur était malhonnête, il pourrait en théorie s'interposer et substituer ses propres clés — une attaque classique de l'homme du milieu — sans qu'aucun des deux navigateurs ne le remarque immédiatement.",
        "Relayium comble cette faille avec un court code de vérification. Les deux appareils dérivent le même Short Authentication String (SAS) à 6 chiffres à partir de leurs deux clés publiques et l'affichent à l'écran. Si les codes correspondent, les clés n'ont pas été substituées, et personne ne s'est interposé. Mais un simple code à 6 chiffres ne représente qu'environ 20 bits, ce qu'un attaquant bien placé pourrait en principe tenter de forcer par force brute pour obtenir une correspondance après avoir vu les deux vraies clés. Pour l'empêcher, Relayium utilise une poignée de main « engagement puis révélation » : chaque partie envoie d'abord un hachage qui l'engage sur sa clé, et ne révèle la vraie clé qu'après avoir reçu l'engagement de l'autre. Cet ordre oblige un serveur malveillant à s'engager sur une fausse clé à l'aveugle, avant d'avoir vu la vraie — il ne peut donc pas choisir après coup une clé provoquant une collision, et le code court reste digne de confiance.",
      ],
      bullets: [
        "Pour la garantie la plus forte, lisez le code à voix haute lors d'un appel ou comparez-le en personne, pas seulement des yeux sur deux écrans côte à côte.",
        "Si les deux codes ne correspondent pas, arrêtez-vous — considérez cela comme un signe que quelqu'un intercepte peut-être la connexion.",
      ],
    },
    {
      heading: "S'assurer que ce qui arrive est exactement ce qui a été envoyé",
      body: [
        "Le chiffrement protège la confidentialité, mais ne prouve pas automatiquement que rien n'a été corrompu ou altéré en chemin. Relayium le vérifie séparément : chaque bloc porte sa propre étiquette d'authentification AES-GCM, si bien qu'un bloc modifié échoue purement et simplement à se déchiffrer. En plus de cela, pendant l'envoi de chaque fichier, les deux parties calculent en continu un hachage SHA-256 sur son contenu en clair ; une fois le fichier terminé, le hachage de l'expéditeur est comparé à celui du destinataire. S'ils correspondent, ce qui atterrit sur le disque est identique octet par octet à ce qui a été envoyé — sinon, le fichier est signalé plutôt qu'accepté silencieusement.",
      ],
    },
    {
      heading: "Liens stockés : une clé différente, générée une seule fois, présente uniquement dans le lien",
      body: [
        "Le transfert en temps réel exige que les deux personnes soient en ligne en même temps. Quand ce n'est pas possible, Relayium propose à la place un lien de téléchargement stocké — qui utilise un mécanisme réellement différent, à ne pas confondre avec celui du temps réel décrit ci-dessus.",
        "Il n'y a pas d'échange de clés ici, car il n'existe pas encore de second appareil avec qui échanger. À la place, votre navigateur génère une unique clé AES-256-GCM aléatoire et l'utilise pour chiffrer les fichiers avant tout envoi. Cette clé n'est jamais envoyée au serveur — elle est ajoutée au lien de téléchargement après un caractère #, dans ce qu'on appelle le fragment d'URL, une partie de l'adresse que les navigateurs ne transmettent délibérément jamais à un serveur. Le serveur finit par ne stocker que du chiffré qu'il n'a aucun moyen de déchiffrer, plus des informations de gestion comme la taille du chiffré et un horodatage d'expiration. Quiconque ouvre le lien complet — fragment compris — peut déchiffrer le fichier localement dans son navigateur ; quiconque ne l'a pas ne voit qu'un bloc opaque sur le serveur. C'est la partie « connaissance nulle » : le serveur détient le fichier chiffré sans jamais détenir les moyens de le lire.",
      ],
      bullets: [
        "Créer un lien stocké exige que l'expéditeur se connecte ; ouvrir un lien pour le télécharger ne l'exige jamais.",
        "Les liens peuvent être réglés pour expirer après 1 heure, 1, 3 ou jusqu'à 7 jours selon votre offre, ou pour s'effacer après le premier téléchargement complet.",
        "Traitez le lien complet comme le fichier lui-même — quiconque le possède peut le déchiffrer, alors partagez-le comme vous partageriez le fichier.",
      ],
    },
    {
      heading: "Ce que le serveur peut voir — et ce qu'il ne peut pas",
      body: [
        "Il vaut la peine de préciser exactement où se situe le serveur dans tout cela, car « chiffré de bout en bout » est une affirmation facile à faire et plus difficile à faire avec précision. En mode temps réel, le fichier lui-même ne touche jamais les serveurs de Relayium — il circule directement entre les deux navigateurs. Le rôle du serveur de signalisation se limite à relayer les messages d'établissement de connexion (les informations techniques SDP/ICE dont WebRTC a besoin pour établir un lien direct) afin que les deux appareils puissent se trouver ; il ne voit jamais le contenu des fichiers, leurs noms, ni les clés.",
        "Entre réseaux — où des NAT ou des pare-feu restrictifs excluent souvent tout chemin direct —, le flux chiffré passe par un serveur relais TURN. Le relais ne transmet que du chiffré ; il n'a pas de clé et ne peut pas déchiffrer ce qui le traverse. Ce qu'il fait, c'est compter les octets qu'il relaie au titre du quota mensuel de relais du compte expéditeur, uniquement à des fins de mesure et de prévention des abus — sans jamais inspecter ce qu'il contient.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Relayium peut-il lire mes fichiers ?",
        a: "Non. En mode temps réel, la clé de chiffrement est dérivée indépendamment sur les deux appareils et ne les quitte jamais — les serveurs de Relayium ne la voient jamais, pas plus que le contenu des fichiers. Pour les liens stockés, la clé ne vit que dans le fragment d'URL, que les navigateurs n'envoient jamais à un serveur, si bien que le serveur ne détient jamais que du chiffré qu'il ne peut pas déchiffrer.",
      },
      {
        q: "Que voit réellement le serveur ?",
        a: "En mode temps réel, uniquement les informations d'établissement de connexion nécessaires pour présenter deux appareils l'un à l'autre — jamais les octets du fichier. Pour les liens stockés, il voit du chiffré ainsi que des informations de gestion comme la taille et la date d'expiration — jamais le contenu en clair, les noms de fichiers, ni la clé de déchiffrement.",
      },
      {
        q: "Le relais TURN est-il un point faible ?",
        a: "C'est un repli utilisé uniquement lorsqu'une connexion directe est impossible, et il ne traite toujours que du chiffré — il n'a pas de clé, donc il ne peut pas lire ce qu'il relaie. Relayium compte les octets relayés au titre du quota mensuel de votre compte, mais n'inspecte jamais leur contenu.",
      },
      {
        q: "Relayium est-il open source ?",
        a: "Oui. La conception du protocole et tout le code client et serveur sont publics sur GitHub sous licence MIT, si bien que la cryptographie décrite ici peut être auditée de façon indépendante plutôt que crue sur parole.",
      },
      {
        q: "Que faire si les deux codes de vérification à l'écran ne correspondent pas ?",
        a: "Arrêtez le transfert. Une différence signifie que la vérification « engagement puis révélation » a échoué, ce qui indique un homme du milieu potentiel plutôt qu'un simple incident bénin — ne poursuivez pas avant d'avoir compris pourquoi.",
      },
    ],
  },
  cta: {
    text: "Curieux de voir à quoi cela ressemble en pratique ? Lancez un transfert et observez le code de vérification apparaître sous vos yeux.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "كيف يُشفِّر Relayium ملفاتك من الطرف إلى الطرف",
  description:
    "كيف يحمي Relayium ملفاتك: X25519 وAES-256-GCM للنقل الفوري، ورمز من ست خانات يكشف الخادم غير النزيه، وروابط مُخزَّنة بمعرفة صفرية.",
  updatedLabel: "آخر تحديث",
  lead: [
    "«هل Relayium آمن؟» سؤال وجيه — فكل أداة لنقل الملفات تدّعي أنها تحمي الخصوصية. تشرح هذه الصفحة بلغة بسيطة كيف يحافظ Relayium على خصوصية ملفاتك بالضبط، حتى تحكم على هذا الادّعاء بنفسك بدلاً من تصديقه على عِلّاته.",
    "هناك نظامان مختلفان للتشفير يعملان هنا، لأن هناك موقفين مختلفين: إرسال ملف بشكل فوري إلى شخص متصل بالإنترنت الآن، وترك رابط تنزيل ليأخذه شخص ما لاحقاً. كلاهما يُبقي الخادم بعيداً عن ملفك، لكنهما يصلان إلى ذلك بطرق مختلفة — ومن المفيد أن تعرف أيّهما ينطبق ومتى.",
  ],
  sections: [
    {
      heading: "النقل الفوري: جهازان يتفقان على سِرٍّ لا يراه الخادم أبداً",
      body: [
        "عندما ترسل ملفاً بشكل فوري — وكلا الطرفين متصل، من متصفح إلى متصفح — يبدأ Relayium بجعل كل جهاز يولّد زوج مفاتيح جديداً باستخدام X25519، وهو نفس تبادل المفاتيح القائم على المنحنيات الإهليلجية المُستخدَم في المراسلة الآمنة الحديثة (تقنياً، crypto_kx من libsodium). يحتفظ كل جهاز بمفتاحه الخاص لنفسه ويرسل مفتاحه العام فقط إلى الطرف الآخر.",
        "من هذين المفتاحين العامّين، يحسب كل جهاز بشكل مستقل السرَّ المشترك نفسه — وهي عملية تنجح تحديداً بسبب طريقة بناء تبادل المفاتيح القائم على المنحنيات الإهليلجية، لا لأن السرّ أُرسِل إلى أي مكان. يصبح ذلك السرُّ المشترك مفتاح AES-256-GCM موجوداً فقط داخل المتصفحَين. يُختَم كل جزء من الملف بهذا المفتاح وبرقم عشوائي فريد (nonce) قبل أن يغادر جهاز المُرسِل أصلاً، بحيث لا يرى أيُّ شيء يعبر الشبكة — بما في ذلك خادم الإشارة الذي ساعد المتصفحَين على إيجاد أحدهما الآخر — سوى النص المُشفَّر.",
      ],
      bullets: [
        "يُولَّد زوج مفاتيح جديد لكل عملية نقل — لا يُعاد استخدام أي شيء عبر الجلسات.",
        "يُشتَقّ مفتاح AES-256-GCM المشترك بشكل مستقل على كل جهاز؛ ولا يُرسَل أبداً إلى أي مكان، بما في ذلك خوادم Relayium نفسها.",
        "يحدث التشفير في طبقة التطبيق، فوق أمان النقل الخاص بـWebRTC، لذا يبقى صامداً حتى لو تعرّضت طبقة النقل تلك للاختراق يوماً ما.",
      ],
    },
    {
      heading: "رمز الخانات الست الذي يكشف الخادم غير النزيه",
      body: [
        "هناك دقيقة تستحق الصراحة بشأنها. يتبادل التشفير المدمج في WebRTC (DTLS) بصمات المفاتيح عبر خادم الإشارة الذي يُعرّف الجهازين أحدهما بالآخر. لو كان ذلك الخادم غير نزيه، لأمكنه نظرياً أن يتوسّط ويستبدل مفاتيحه الخاصة — هجوم وسيط كلاسيكي — دون أن يلاحظ أيٌّ من المتصفحَين ذلك فوراً.",
        "يسدّ Relayium هذه الثغرة برمز تحقق قصير. يشتقّ كلا الجهازين نفس سلسلة المصادقة القصيرة (SAS) المكوَّنة من ست خانات من مفتاحيهما العامّين ويعرضانها على الشاشة. إذا تطابق الرمزان، فالمفاتيح لم تُستبدَل، ولا أحد في المنتصف. لكن الرمز البسيط المكوَّن من ست خانات لا يتجاوز نحو 20 بت، وهو ما قد يحاول مهاجم في موقع مناسب مبدئياً أن يخمّنه بالقوة الغاشمة ليطابقه بعد رؤية المفتاحين الحقيقيين. لمنع ذلك، يستخدم Relayium مصافحة «الالتزام ثم الكشف»: يرسل كل طرف أولاً تجزئة (hash) تلتزم بمفتاحه، ولا يكشف عن المفتاح الحقيقي إلا بعد تلقّي التزام الطرف الآخر. يعني هذا الترتيب أن الخادم الخبيث عليه أن يلتزم بمفتاح مزيّف على العمياء، قبل أن يكون قد رأى المفتاح الحقيقي — فلا يستطيع اختيار مفتاح متصادم بعد وقوع الأمر، وهكذا يبقى الرمز القصير جديراً بالثقة.",
      ],
      bullets: [
        "لأقوى ضمان، اقرأ الرمز بصوت عالٍ عبر مكالمة أو قارِنه وجهاً لوجه، لا بمجرد النظر إلى شاشتين متجاورتين.",
        "إذا لم يتطابق الرمزان، توقّف — واعتبر ذلك علامة على أن أحدهم قد يعترض الاتصال.",
      ],
    },
    {
      heading: "التأكد من أن ما يصل هو تماماً ما أُرسِل",
      body: [
        "يحمي التشفير السرية، لكنه لا يُثبِت تلقائياً أن شيئاً لم يتلف أو يُعبَث به في الطريق. يتحقق Relayium من ذلك على حدة: يحمل كل جزء وسم مصادقة AES-GCM الخاص به، فيفشل فك تشفير أي جزء مُعدَّل من الأساس. علاوة على ذلك، مع إرسال كل ملف، يحسب الطرفان تجزئة SHA-256 جارية على محتواه الصريح؛ وعند انتهاء الملف، تُقارَن تجزئة المُرسِل بتجزئة المُستقبِل. إذا تطابقتا، فما استقرّ على القرص مطابق بايتاً ببايت لما أُرسِل — وإن لم تتطابقا، يُوسَم الملف بدلاً من قبوله بصمت.",
      ],
    },
    {
      heading: "الروابط المُخزَّنة: مفتاح مختلف، يُولَّد مرة واحدة، ولا يوجد إلا في الرابط",
      body: [
        "يحتاج النقل الفوري إلى وجود الطرفين متصلَين في الوقت نفسه. حين يتعذّر ذلك، يقدّم Relayium بدلاً منه رابط تنزيل مُخزَّن — وهذا يستخدم آلية مختلفة فعلاً، يُستحسَن عدم الخلط بينها وبين آلية النقل الفوري أعلاه.",
        "لا يوجد هنا تبادل مفاتيح، لأنه لا يوجد بعدُ جهاز ثانٍ للتبادل معه. بدلاً من ذلك، يولّد متصفحك مفتاح AES-256-GCM عشوائياً واحداً ويستخدمه لتشفير الملفات قبل رفع أي شيء. لا يُرسَل هذا المفتاح إلى الخادم إطلاقاً — بل يُلحَق برابط التنزيل بعد الرمز #، فيما يُسمّى جزء العنوان (URL fragment)، وهو جزء من العنوان تتعمّد المتصفحات ألّا ترسله إلى أي خادم أبداً. ينتهي الأمر بالخادم مُخزِّناً نصاً مُشفَّراً فقط لا سبيل له إلى فك تشفيره، إضافة إلى بيانات إدارية مثل حجم النص المُشفَّر وطابع زمني لانتهاء الصلاحية. أي شخص يفتح الرابط الكامل — بما فيه الجزء — يستطيع فك تشفير الملف محلياً في متصفحه؛ ومن لا يملكه لا يرى سوى كتلة مبهمة على الخادم. هذا هو جزء المعرفة الصفرية: يحتفظ الخادم بالملف المُشفَّر دون أن يملك يوماً وسيلة قراءته.",
      ],
      bullets: [
        "يتطلّب إنشاء رابط مُخزَّن تسجيل دخول المُرسِل؛ أما فتحه للتنزيل فلا يتطلّب ذلك أبداً.",
        "يمكن ضبط الروابط لتنتهي صلاحيتها بعد ساعة واحدة أو يوم واحد أو 3 أيام أو حتى 7 أيام حسب خطتك، أو لتتلاشى بعد أول تنزيل مكتمل.",
        "تعامل مع الرابط الكامل كأنه الملف نفسه — فأي شخص يملكه يستطيع فك تشفيره، لذا شاركه كما تشارك الملف.",
      ],
    },
    {
      heading: "ما يمكن للخادم رؤيته — وما لا يمكنه",
      body: [
        "من المفيد أن نوضّح بالضبط أين يقف الخادم من كل هذا، لأن «التشفير من الطرف إلى الطرف» ادّعاء يسهل قوله ويصعب قوله بدقة. في الوضع الفوري، لا يلمس الملف نفسه خوادم Relayium إطلاقاً — بل يُبَثّ مباشرة بين المتصفحَين. تقتصر مهمة خادم الإشارة على تمرير رسائل إعداد الاتصال (معلومات SDP/ICE التقنية التي يحتاجها WebRTC لإنشاء رابط مباشر) حتى يتمكن الجهازان من إيجاد أحدهما الآخر؛ فهو لا يرى أبداً محتوى الملفات أو أسماءها أو المفاتيح.",
        "عبر الشبكات — حيث تستبعد أنظمة NAT وجدران الحماية المقيِّدة المسار المباشر في الغالب — يمرّ التدفق المُشفَّر على خادم مُرحِّل TURN. لا يمرّر المُرحِّل سوى النص المُشفَّر؛ فليس لديه مفتاح ولا يمكنه فك تشفير ما يمرّ عبره. أما ما يفعله فهو عدّ البايتات التي يُرحّلها ضمن حصة الترحيل الشهرية لحساب المُرسِل، لغرض القياس ومنع إساءة الاستخدام فقط — دون أن يفحص ما بداخلها أبداً.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يستطيع Relayium قراءة ملفاتي؟",
        a: "لا. في الوضع الفوري، يُشتَقّ مفتاح التشفير بشكل مستقل على كلا الجهازين ولا يغادرهما أبداً — ولا ترى خوادم Relayium المفتاح ولا محتوى الملفات. أما بالنسبة للروابط المُخزَّنة، فيوجد المفتاح فقط في جزء العنوان (URL fragment)، الذي لا ترسله المتصفحات إلى أي خادم أبداً، لذا لا يحتفظ الخادم إلا بنص مُشفَّر لا يستطيع فك تشفيره.",
      },
      {
        q: "ماذا يرى الخادم فعلاً؟",
        a: "في الوضع الفوري، لا يرى سوى معلومات إعداد الاتصال اللازمة لتعريف الجهازين أحدهما بالآخر — ولا يرى بايتات الملف أبداً. أما بالنسبة للروابط المُخزَّنة، فيرى النص المُشفَّر إضافة إلى بيانات إدارية مثل الحجم ووقت انتهاء الصلاحية — دون أن يرى النص الصريح أو أسماء الملفات أو مفتاح فك التشفير أبداً.",
      },
      {
        q: "هل مُرحِّل TURN نقطة ضعف؟",
        a: "إنه حلٌّ احتياطي لا يُستخدَم إلا حين يتعذّر الاتصال المباشر، ولا يتعامل إلا مع النص المُشفَّر — فليس لديه مفتاح، ولذلك لا يستطيع قراءة ما يُرحّله. يَعُدّ Relayium البايتات التي يُرحّلها ضمن الحصة الشهرية لحسابك، لكنه لا يفحص محتواها أبداً.",
      },
      {
        q: "هل Relayium مفتوح المصدر؟",
        a: "نعم. تصميم البروتوكول وكامل شيفرة العميل والخادم متاحة علناً على GitHub بموجب رخصة MIT، لذا يمكن تدقيق التعمية الموصوفة هنا بشكل مستقل بدلاً من تصديقها على عِلّاتها.",
      },
      {
        q: "ماذا لو لم يتطابق رمزا التحقق على الشاشة؟",
        a: "أوقِف النقل. عدم التطابق يعني أن فحص «الالتزام ثم الكشف» قد فشل، وهو ما يشير إلى احتمال وجود وسيط لا إلى خلل بسيط غير مؤذٍ — لا تُكمِل حتى تفهم السبب.",
      },
    ],
  },
  cta: {
    text: "أتتساءل كيف يبدو الأمر عملياً؟ ابدأ عملية نقل وشاهد رمز التحقق يظهر بنفسك.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Cómo Relayium cifra tus archivos de extremo a extremo",
  description:
    "Cómo Relayium protege tus archivos: X25519 y AES-256-GCM para transferencias en vivo, un código de seis dígitos que detecta a un servidor deshonesto, y enlaces almacenados de conocimiento cero.",
  updatedLabel: "Última actualización",
  lead: [
    "«¿Es seguro Relayium?» es una pregunta justa — toda herramienta de transferencia de archivos afirma ser privada. Esta página recorre exactamente cómo Relayium mantiene privados los archivos, en lenguaje sencillo, para que puedas juzgar la afirmación en lugar de aceptarla por fe.",
    "Hay dos esquemas de cifrado distintos en juego, porque hay dos situaciones distintas: enviar un archivo en vivo a alguien que está en línea ahora mismo, y dejar un enlace de descarga para que alguien lo recoja más tarde. Ambos dejan al servidor fuera de tu archivo, pero llegan ahí por caminos diferentes — y vale la pena saber cuál se aplica en cada caso.",
  ],
  sections: [
    {
      heading: "Transferencias en vivo: dos dispositivos acuerdan un secreto que el servidor nunca ve",
      body: [
        "Cuando envías un archivo en tiempo real —ambas personas en línea, de navegador a navegador— Relayium empieza haciendo que cada dispositivo genere un nuevo par de claves con X25519, el mismo intercambio de claves de curva elíptica que se usa en la mensajería segura moderna (técnicamente, crypto_kx de libsodium). Cada dispositivo se guarda su clave privada para sí y envía solo su clave pública al otro lado.",
        "A partir de esas dos claves públicas, cada dispositivo calcula de forma independiente el mismo secreto compartido — un proceso que funciona precisamente por cómo está construido el intercambio de claves de curva elíptica, no porque el secreto se haya enviado a ningún sitio. Ese secreto compartido se convierte en una clave AES-256-GCM que existe solo dentro de los dos navegadores. Cada fragmento del archivo se sella con esa clave y un nonce único antes siquiera de salir del dispositivo del remitente, así que todo lo que cruza la red —incluido el servidor de señalización que ayudó a los dos navegadores a encontrarse— solo ve texto cifrado.",
      ],
      bullets: [
        "Se genera un nuevo par de claves para cada transferencia — nada se reutiliza entre sesiones.",
        "La clave AES-256-GCM compartida se deriva de forma independiente en cada dispositivo; nunca se transmite a ningún sitio, incluidos los propios servidores de Relayium.",
        "El cifrado ocurre en la capa de aplicación, por encima de la propia seguridad de transporte de WebRTC, así que se mantiene incluso si esa capa de transporte llegara a verse comprometida.",
      ],
    },
    {
      heading: "El código de 6 dígitos que detecta a un servidor deshonesto",
      body: [
        "Hay una sutileza que conviene reconocer con honestidad. El cifrado propio de WebRTC (DTLS) intercambia las huellas de las claves a través del servidor de señalización que presenta los dos dispositivos entre sí. Si ese servidor fuera deshonesto, podría en teoría situarse en medio y sustituir sus propias claves — un clásico ataque de intermediario — sin que ninguno de los dos navegadores lo notara de inmediato.",
        "Relayium cierra esa brecha con un breve código de verificación. Ambos dispositivos derivan el mismo Short Authentication String (SAS) de 6 dígitos a partir de sus dos claves públicas y lo muestran en pantalla. Si los códigos coinciden, las claves no se sustituyeron y nadie está en medio. Pero un código simple de 6 dígitos son solo unos 20 bits, que en principio un atacante bien situado podría intentar forzar por fuerza bruta hasta hacerlo coincidir tras ver ambas claves reales. Para evitarlo, Relayium usa un intercambio de comprometer-y-luego-revelar: cada lado envía primero un hash que lo compromete con su clave, y solo revela la clave real después de recibir el compromiso del otro lado. Ese orden significa que un servidor malicioso tiene que comprometerse a ciegas con una clave falsa, antes de haber visto la real — no puede elegir después una clave que colisione, así que el código corto sigue siendo fiable.",
      ],
      bullets: [
        "Para la garantía más fuerte, lee el código en voz alta en una llamada o compáralo en persona, no solo a ojo en dos pantallas una al lado de la otra.",
        "Si los dos códigos no coinciden, detente — trátalo como una señal de que alguien podría estar interceptando la conexión.",
      ],
    },
    {
      heading: "Asegurarse de que lo que llega es exactamente lo que se envió",
      body: [
        "El cifrado protege el secreto, pero no prueba automáticamente que nada se haya corrompido o manipulado por el camino. Relayium lo comprueba por separado: cada fragmento lleva su propia etiqueta de autenticación AES-GCM, así que un fragmento modificado no logra descifrarse en absoluto. Además, a medida que se envía cada archivo, ambos lados calculan un hash SHA-256 continuo sobre su contenido en claro; cuando el archivo termina, el hash del remitente se compara con el del destinatario. Si coinciden, lo que aterrizó en el disco es byte por byte lo que se envió — si no, el archivo se marca en lugar de aceptarse en silencio.",
      ],
    },
    {
      heading: "Enlaces almacenados: una clave diferente, generada una sola vez, guardada solo en el enlace",
      body: [
        "La transferencia en tiempo real necesita a ambas personas en línea al mismo tiempo. Cuando eso no es posible, Relayium ofrece en su lugar un enlace de descarga almacenado — y este usa un mecanismo genuinamente distinto, que conviene no confundir con el de tiempo real anterior.",
        "Aquí no hay intercambio de claves, porque todavía no hay un segundo dispositivo con el que intercambiar. En su lugar, tu navegador genera una única clave AES-256-GCM aleatoria y la usa para cifrar los archivos antes de que se suba nada. Esa clave no se envía en absoluto al servidor — se añade al enlace de descarga tras un carácter #, en lo que se llama el fragmento de la URL, una parte de la dirección que los navegadores deliberadamente nunca transmiten a un servidor. El servidor acaba almacenando solo texto cifrado que no tiene forma de descifrar, además de datos administrativos como el tamaño del texto cifrado y una marca de tiempo de caducidad. Cualquiera que abra el enlace completo —fragmento incluido— puede descifrar el archivo localmente en su navegador; cualquiera sin él solo ve un bloque opaco en el servidor. Esa es la parte de conocimiento cero: el servidor guarda el archivo cifrado sin llegar nunca a tener los medios para leerlo.",
      ],
      bullets: [
        "Crear un enlace almacenado requiere que el remitente inicie sesión; abrir uno para descargar no lo requiere nunca.",
        "Los enlaces pueden configurarse para caducar tras 1 hora, 1 día, 3 días o hasta 7 días según tu plan, o para destruirse tras la primera descarga completada.",
        "Trata el enlace completo como el propio archivo — cualquiera que lo tenga puede descifrarlo, así que compártelo como compartirías el archivo.",
      ],
    },
    {
      heading: "Lo que el servidor puede ver — y lo que no",
      body: [
        "Vale la pena precisar exactamente dónde se sitúa el servidor en todo esto, porque «cifrado de extremo a extremo» es una afirmación fácil de hacer y más difícil de precisar. En modo tiempo real, el archivo en sí nunca toca los servidores de Relayium — se transmite directamente entre los dos navegadores. El trabajo del servidor de señalización se limita a retransmitir los mensajes de establecimiento de conexión (la información técnica SDP/ICE que WebRTC necesita para establecer un enlace directo) para que los dos dispositivos puedan encontrarse; nunca ve el contenido de los archivos, los nombres de archivo ni las claves.",
        "Entre redes —donde los NAT o cortafuegos restrictivos suelen descartar cualquier ruta directa— el flujo cifrado pasa por un servidor retransmisor TURN. El retransmisor solo reenvía texto cifrado; no tiene ninguna clave y no puede descifrar lo que pasa a través de él. Lo que sí hace es contabilizar los bytes que retransmite contra la asignación mensual de retransmisión de la cuenta que envía, puramente para medición y prevención de abusos — sin inspeccionar nunca lo que hay dentro.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Puede Relayium leer mis archivos?",
        a: "No. En modo tiempo real, la clave de cifrado se deriva de forma independiente en ambos dispositivos y nunca los abandona — los servidores de Relayium nunca la ven, ni tampoco el contenido de los archivos. Para los enlaces almacenados, la clave vive solo en el fragmento de la URL, que los navegadores nunca envían a ningún servidor, así que el servidor solo llega a guardar texto cifrado que no puede descifrar.",
      },
      {
        q: "¿Qué ve realmente el servidor?",
        a: "En modo tiempo real, solo la información de establecimiento de conexión necesaria para presentar dos dispositivos entre sí — nunca los bytes del archivo. Para los enlaces almacenados, ve texto cifrado más datos administrativos como el tamaño y la hora de caducidad — nunca el texto en claro, los nombres de archivo ni la clave de descifrado.",
      },
      {
        q: "¿Es el retransmisor TURN un punto débil?",
        a: "Es un recurso de reserva que se usa solo cuando una conexión directa no es posible, y siempre maneja únicamente texto cifrado — no tiene ninguna clave, así que no puede leer lo que retransmite. Relayium contabiliza los bytes que retransmite contra la asignación mensual de tu cuenta, pero nunca inspecciona su contenido.",
      },
      {
        q: "¿Es Relayium de código abierto?",
        a: "Sí. El diseño del protocolo y todo el código de cliente y servidor son públicos en GitHub bajo la licencia MIT, así que la criptografía descrita aquí puede auditarse de forma independiente en lugar de aceptarse por fe.",
      },
      {
        q: "¿Qué pasa si los dos códigos de verificación en pantalla no coinciden?",
        a: "Detén la transferencia. Una discrepancia significa que la comprobación de comprometer-y-luego-revelar falló, lo que apunta a un posible intermediario más que a un fallo inofensivo — no continúes hasta entender por qué.",
      },
    ],
  },
  cta: {
    text: "¿Con curiosidad por ver cómo se ve en la práctica? Inicia una transferencia y observa aparecer el código de verificación por ti mismo.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Como o Relayium criptografa seus arquivos de ponta a ponta",
  description:
    "Como o Relayium protege seus arquivos: X25519 e AES-256-GCM para transferências ao vivo, um código de seis dígitos que flagra um servidor desonesto, e links armazenados de conhecimento zero.",
  updatedLabel: "Última atualização",
  lead: [
    "«O Relayium é seguro?» é uma pergunta justa — toda ferramenta de transferência de arquivos afirma ser privada. Esta página percorre exatamente como o Relayium mantém os arquivos privados, em linguagem simples, para que você possa julgar a afirmação em vez de aceitá-la por fé.",
    "Há dois esquemas de criptografia diferentes em jogo, porque há duas situações diferentes: enviar um arquivo ao vivo para alguém que está on-line agora mesmo, e deixar um link de download para alguém pegar mais tarde. Ambos mantêm o servidor fora do seu arquivo, mas chegam lá por caminhos diferentes — e vale a pena saber qual se aplica em cada caso.",
  ],
  sections: [
    {
      heading: "Transferências ao vivo: dois dispositivos combinam um segredo que o servidor nunca vê",
      body: [
        "Quando você envia um arquivo em tempo real — ambas as pessoas on-line, de navegador para navegador — o Relayium começa fazendo cada dispositivo gerar um novo par de chaves com X25519, a mesma troca de chaves de curva elíptica usada nas mensagerias seguras modernas (tecnicamente, o crypto_kx do libsodium). Cada dispositivo guarda sua chave privada para si e envia apenas sua chave pública para o outro lado.",
        "A partir dessas duas chaves públicas, cada dispositivo calcula independentemente o mesmo segredo compartilhado — um processo que funciona precisamente por causa de como a troca de chaves de curva elíptica é construída, e não porque o segredo tenha sido enviado a algum lugar. Esse segredo compartilhado se torna uma chave AES-256-GCM que existe apenas dentro dos dois navegadores. Cada bloco do arquivo é selado com essa chave e um nonce único antes mesmo de sair do dispositivo do remetente, então tudo o que atravessa a rede — incluindo o servidor de sinalização que ajudou os dois navegadores a se encontrarem — só vê texto cifrado.",
      ],
      bullets: [
        "Um novo par de chaves é gerado para cada transferência — nada é reutilizado entre sessões.",
        "A chave AES-256-GCM compartilhada é derivada independentemente em cada dispositivo; ela nunca é transmitida a lugar nenhum, incluindo os próprios servidores do Relayium.",
        "A criptografia acontece na camada de aplicação, acima da própria segurança de transporte do WebRTC, então ela se mantém mesmo que essa camada de transporte venha a ser comprometida.",
      ],
    },
    {
      heading: "O código de 6 dígitos que flagra um servidor desonesto",
      body: [
        "Há uma sutileza que vale a pena reconhecer com honestidade. A criptografia embutida do WebRTC (DTLS) troca as impressões digitais das chaves através do servidor de sinalização que apresenta os dois dispositivos um ao outro. Se esse servidor fosse desonesto, ele poderia em teoria se colocar no meio e substituir suas próprias chaves — um clássico ataque de intermediário — sem que nenhum dos dois navegadores percebesse de imediato.",
        "O Relayium fecha essa brecha com um curto código de verificação. Ambos os dispositivos derivam o mesmo Short Authentication String (SAS) de 6 dígitos a partir de suas duas chaves públicas e o exibem na tela. Se os códigos coincidem, as chaves não foram substituídas e ninguém está no meio. Mas um código simples de 6 dígitos tem apenas cerca de 20 bits, o que em princípio um atacante bem posicionado poderia tentar quebrar por força bruta até fazer coincidir depois de ver as duas chaves reais. Para evitar isso, o Relayium usa um handshake de comprometer-e-depois-revelar: cada lado primeiro envia um hash que o compromete com sua chave, e só revela a chave real depois de receber o compromisso do outro lado. Essa ordem significa que um servidor malicioso tem de se comprometer com uma chave falsa às cegas, antes de ter visto a real — ele não pode escolher depois uma chave que colida, então o código curto continua confiável.",
      ],
      bullets: [
        "Para a garantia mais forte, leia o código em voz alta em uma chamada ou compare-o pessoalmente, não apenas a olho em duas telas lado a lado.",
        "Se os dois códigos não coincidirem, pare — trate isso como um sinal de que alguém pode estar interceptando a conexão.",
      ],
    },
    {
      heading: "Garantir que o que chega é exatamente o que foi enviado",
      body: [
        "A criptografia protege o sigilo, mas não prova automaticamente que nada foi corrompido ou adulterado pelo caminho. O Relayium verifica isso separadamente: cada bloco carrega sua própria etiqueta de autenticação AES-GCM, de modo que um bloco modificado simplesmente falha ao ser descriptografado. Além disso, à medida que cada arquivo é enviado, ambos os lados calculam um hash SHA-256 contínuo sobre seu conteúdo em texto claro; quando o arquivo termina, o hash do remetente é comparado com o do destinatário. Se coincidem, o que chegou ao disco é byte por byte o que foi enviado — se não, o arquivo é sinalizado em vez de ser aceito silenciosamente.",
      ],
    },
    {
      heading: "Links armazenados: uma chave diferente, gerada uma única vez, guardada apenas no link",
      body: [
        "A transferência em tempo real precisa das duas pessoas on-line ao mesmo tempo. Quando isso não é possível, o Relayium oferece em vez disso um link de download armazenado — e este usa um mecanismo genuinamente diferente, que convém não confundir com o de tempo real acima.",
        "Aqui não há troca de chaves, porque ainda não existe um segundo dispositivo com quem trocar. Em vez disso, seu navegador gera uma única chave AES-256-GCM aleatória e a usa para criptografar os arquivos antes que qualquer coisa seja enviada. Essa chave nunca é enviada ao servidor — ela é anexada ao link de download depois de um caractere #, no que se chama fragmento da URL, uma parte do endereço que os navegadores deliberadamente nunca transmitem a um servidor. O servidor acaba armazenando apenas texto cifrado que não tem como descriptografar, mais dados administrativos como o tamanho do texto cifrado e um carimbo de data/hora de expiração. Qualquer pessoa que abra o link completo — incluindo o fragmento — pode descriptografar o arquivo localmente em seu navegador; quem não o tem vê apenas um bloco opaco no servidor. Essa é a parte de conhecimento zero: o servidor guarda o arquivo criptografado sem jamais ter os meios de lê-lo.",
      ],
      bullets: [
        "Criar um link armazenado exige que o remetente faça login; abrir um para baixar nunca exige.",
        "Os links podem ser configurados para expirar após 1 hora, 1 dia, 3 dias ou até 7 dias conforme o seu plano, ou para se autodestruir após o primeiro download concluído.",
        "Trate o link completo como o próprio arquivo — qualquer pessoa que o tenha pode descriptografá-lo, então compartilhe-o do jeito que compartilharia o arquivo.",
      ],
    },
    {
      heading: "O que o servidor pode ver — e o que ele não pode",
      body: [
        "Vale a pena explicitar exatamente onde o servidor se situa em tudo isso, porque «criptografado de ponta a ponta» é uma afirmação fácil de fazer e mais difícil de fazer com precisão. No modo tempo real, o próprio arquivo nunca toca os servidores do Relayium — ele é transmitido diretamente entre os dois navegadores. O trabalho do servidor de sinalização se limita a retransmitir as mensagens de estabelecimento de conexão (as informações técnicas SDP/ICE de que o WebRTC precisa para estabelecer um link direto) para que os dois dispositivos possam se encontrar; ele nunca vê o conteúdo dos arquivos, os nomes dos arquivos ou as chaves.",
        "Entre redes — onde NATs ou firewalls restritivos costumam descartar qualquer caminho direto — o fluxo criptografado passa por um servidor retransmissor TURN. O retransmissor só encaminha texto cifrado; ele não tem chave e não pode descriptografar o que passa por ele. O que ele faz é contar os bytes que retransmite em relação à cota mensal de retransmissão da conta que envia, puramente para medição e prevenção de abuso — sem nunca inspecionar o que há dentro.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O Relayium pode ler meus arquivos?",
        a: "Não. No modo tempo real, a chave de criptografia é derivada independentemente em ambos os dispositivos e nunca os deixa — os servidores do Relayium nunca a veem, nem o conteúdo dos arquivos. Para os links armazenados, a chave vive apenas no fragmento da URL, que os navegadores nunca enviam a nenhum servidor, então o servidor só chega a guardar texto cifrado que não pode descriptografar.",
      },
      {
        q: "O que o servidor realmente vê?",
        a: "No modo tempo real, apenas as informações de estabelecimento de conexão necessárias para apresentar dois dispositivos um ao outro — nunca os bytes do arquivo. Para os links armazenados, ele vê texto cifrado mais dados administrativos como tamanho e hora de expiração — nunca o texto claro, os nomes dos arquivos ou a chave de descriptografia.",
      },
      {
        q: "O retransmissor TURN é um ponto fraco?",
        a: "É um recurso alternativo usado apenas quando uma conexão direta não é possível, e ele sempre lida somente com texto cifrado — não tem chave, então não pode ler o que retransmite. O Relayium conta os bytes que retransmite em relação à cota mensal da sua conta, mas nunca inspeciona o conteúdo deles.",
      },
      {
        q: "O Relayium é de código aberto?",
        a: "Sim. O design do protocolo e todo o código de cliente e servidor são públicos no GitHub sob a licença MIT, então a criptografia descrita aqui pode ser auditada de forma independente em vez de aceita por fé.",
      },
      {
        q: "E se os dois códigos de verificação na tela não coincidirem?",
        a: "Pare a transferência. Uma divergência significa que a verificação de comprometer-e-depois-revelar falhou, o que aponta para um possível intermediário e não para uma falha inofensiva — não prossiga até entender o motivo.",
      },
    ],
  },
  cta: {
    text: "Curioso para ver como isso fica na prática? Inicie uma transferência e veja o código de verificação aparecer você mesmo.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/how-relayium-encrypts-your-files",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
