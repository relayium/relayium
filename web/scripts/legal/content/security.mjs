// web/scripts/legal/content/security.mjs
const en = {
  title: "Security & Threat Model",
  description:
    "How Relayium protects your files: per-transfer X25519 keys and AES-256-GCM, a SAS verification code with a commit-then-reveal handshake to defeat a malicious server, zero-knowledge download links, and an honest account of what we do and do not defend against.",
  updatedLabel: "Last updated",
  updated: "2026-07-01",
  otherDocLabel: "Privacy Policy",
  lead: [
    "Relayium is built so that the people transferring files — not the server — hold the keys. This page describes exactly what is protected, how it works, and the limits of that protection.",
    "The short version: in realtime mode your files never touch our servers; the encryption keys are generated fresh on each device and never leave it; and a short verification code lets two people detect a malicious server. The detail follows.",
  ],
  sections: [
    {
      heading: "End-to-end encryption (X25519 + AES-256-GCM)",
      body: [
        "Each transfer generates a fresh, ephemeral X25519 key pair on each device. The two devices perform a key exchange to derive a shared AES-256-GCM key that exists only inside the two browsers. Every chunk is encrypted under that key with a unique nonce, so the signaling server — and any relay — only ever sees ciphertext.",
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
        "WebRTC's built-in encryption (DTLS) exchanges key fingerprints through the signaling server, so a dishonest server could sit in the middle and swap keys. To catch this, Relayium derives a 6-digit Short Authentication String (SAS) from both sides' public keys and shows it on both screens. If the two codes match, no one is in the middle.",
        "A plain 6-digit code (about 20 bits) could in principle be brute-forced by a relay racing to force a matching code. Relayium closes that gap with a commit-then-reveal handshake: each side first commits to its key by sending a hash, and only reveals the key after receiving the other side's commitment. A server therefore cannot pick a colliding key after the fact, so the short code stays trustworthy.",
      ],
      bullets: [
        "For the strongest guarantee, compare the code out of band — in person or over a voice call.",
        "If the two codes differ, stop the transfer: someone may be intercepting the connection.",
      ],
    },
    {
      heading: "What the server never sees",
      body: [
        "The service is designed so that the following never reach our servers, in any mode:",
        "In realtime mode the file bytes never touch the server at all — they flow directly between the two devices. The signaling server only relays connection-setup messages and sees room membership (your public IP), a device nickname you choose, and presence.",
      ],
      bullets: [
        "The contents of your files.",
        "The names of your files.",
        "Your encryption keys.",
      ],
    },
    {
      heading: "When your files are relayed (TURN)",
      body: [
        "When two devices cannot open a direct connection across networks (restrictive NATs or firewalls), the encrypted stream is relayed through a TURN server so the transfer can still complete. Direct peer-to-peer is always tried first; the relay is a fallback, and only pairing-code and share-link sessions are issued relay credentials.",
      ],
      bullets: [
        "The relay forwards only ciphertext — it cannot read your files, which stay end-to-end encrypted.",
        "For operating the service we record only the number of relayed bytes per transfer, attributed to the signed-in user who created it.",
        "We never inspect relayed content.",
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
        "Links can be set to expire (1, 3, or 7 days) or to burn after the first complete download.",
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
        "Metadata the server necessarily handles: that a transfer happened, its size and timing, and — if you signed in — the account that created it.",
        "A recipient choosing to keep or forward the files after they have received them.",
        "Sharing a download link over an untrusted channel, since the decryption key travels inside the link.",
      ],
    },
    {
      heading: "Browser support and its limits",
      body: [
        "Relayium runs in any modern browser with WebRTC over HTTPS. A few capabilities differ by browser:",
      ],
      bullets: [
        "Chrome and Edge stream large files straight to disk, with no practical memory ceiling.",
        "Firefox and Safari buffer files in memory, so very large files (over roughly 200 MB) may fail — prefer Chrome/Edge, or use the download-link mode for those.",
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
    "Relayium 如何保护你的文件：每次传输独立的 X25519 密钥与 AES-256-GCM、带「先承诺后揭示」握手的 SAS 校验码以挫败恶意服务器、零知识下载链接，以及对我们能防和不能防什么的坦诚说明。",
  updatedLabel: "最后更新",
  updated: "2026-07-01",
  otherDocLabel: "隐私政策",
  lead: [
    "Relayium 的设计宗旨是：掌握密钥的是传输文件的双方，而不是服务器。本页说明究竟保护了什么、如何保护，以及这份保护的边界。",
    "一句话概括：实时模式下你的文件绝不经过我们的服务器；加密密钥在每台设备上重新生成、绝不离开设备；一段简短的校验码让双方能识破恶意服务器。以下是细节。",
  ],
  sections: [
    {
      heading: "端到端加密（X25519 + AES-256-GCM）",
      body: [
        "每次传输都会在各自设备上重新生成一对临时的 X25519 密钥。两台设备通过密钥交换协商出一个共享的 AES-256-GCM 密钥，它只存在于两端浏览器中。每个数据块都用该密钥配合唯一的随机数加密，因此信令服务器——以及任何中继——只能看到密文。",
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
        "WebRTC 自带的加密（DTLS）会通过信令服务器交换密钥指纹，因此不诚实的服务器可能居中调包密钥。为识破这种攻击，Relayium 从双方公钥推导出一段 6 位短校验码（SAS）并显示在两端屏幕上。两边的码一致，就说明没有人居中。",
        "单纯的 6 位数字（约 20 比特）理论上可能被中继抢先暴力凑出一个相同的码。Relayium 用「先承诺后揭示」握手堵住这个缺口：双方先各自发送密钥的哈希作为承诺，收到对方的承诺后才揭示真正的密钥。这样服务器就无法事后挑选一个能撞上的密钥，短校验码因此依然可信。",
      ],
      bullets: [
        "为获得最强的保证，请通过带外渠道核对校验码——当面或语音通话。",
        "如果两边的码不一致，请立即停止传输：可能有人正在拦截连接。",
      ],
    },
    {
      heading: "服务器绝不会看到什么",
      body: [
        "本服务的设计确保以下内容在任何模式下都绝不会到达我们的服务器：",
        "实时模式下文件字节根本不经过服务器——它们在两台设备之间直接流动。信令服务器只转发建立连接所需的消息，能看到的仅有房间归属（你的公网 IP）、你自选的设备昵称以及在线状态。",
      ],
      bullets: [
        "你的文件内容。",
        "你的文件名。",
        "你的加密密钥。",
      ],
    },
    {
      heading: "文件何时会经中继转发（TURN）",
      body: [
        "当两台设备无法跨网络直接建立连接（受限的 NAT 或防火墙）时，加密流会经由 TURN 服务器中继，让传输仍能完成。系统始终优先尝试点对点直连；中继只是兜底，且只有配对码与分享链接的会话才会获发中继凭证。",
      ],
      bullets: [
        "中继只转发密文——它无法读取你的文件，文件始终保持端到端加密。",
        "出于运营目的，我们仅记录某次传输中继的字节数，并归属到创建该传输的登录用户。",
        "我们绝不检查中继内容。",
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
        "链接可设置有效期（1、3 或 7 天），或设为首次完整下载后即焚。",
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
        "服务器必然会接触到的元数据：曾发生过一次传输、其大小与时间，以及（若你已登录）创建它的账号。",
        "接收方在收到文件后选择保留或转发。",
        "通过不可信渠道分享下载链接，因为解密密钥就在链接里。",
      ],
    },
    {
      heading: "浏览器支持及其限制",
      body: [
        "Relayium 可在任何支持 WebRTC 且经 HTTPS 访问的现代浏览器中运行。少数能力因浏览器而异：",
      ],
      bullets: [
        "Chrome 与 Edge 会把大文件直接流式写入磁盘，几乎没有内存上限。",
        "Firefox 与 Safari 会把文件缓存在内存中，因此过大的文件（约 200 MB 以上）可能失败——建议改用 Chrome/Edge，或对这类文件使用下载链接模式。",
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
    "Relayium がファイルを保護する仕組み：転送ごとの X25519 鍵と AES-256-GCM、悪意あるサーバーを見破るためのコミット後開示ハンドシェイクを備えた SAS 検証コード、ゼロ知識ダウンロードリンク、そして何を守り何を守らないかの率直な説明。",
  updatedLabel: "最終更新",
  updated: "2026-07-01",
  otherDocLabel: "プライバシーポリシー",
  lead: [
    "Relayium は、鍵を握るのはサーバーではなくファイルを転送する当事者であるように設計されています。このページでは、何がどのように保護されるのか、そしてその保護の限界を説明します。",
    "要点：リアルタイムモードではファイルは当社のサーバーを一切通りません。暗号鍵は各デバイスで新たに生成され、デバイスの外に出ることはありません。そして短い検証コードによって、当事者は悪意あるサーバーを見破ることができます。以下に詳細を記します。",
  ],
  sections: [
    {
      heading: "エンドツーエンド暗号化（X25519 + AES-256-GCM）",
      body: [
        "転送ごとに、各デバイスで新しい一時的な X25519 鍵ペアが生成されます。2 台のデバイスは鍵交換を行い、両ブラウザ内にのみ存在する共有 AES-256-GCM 鍵を導出します。各チャンクはその鍵と一意のノンスで暗号化されるため、シグナリングサーバー、そしてあらゆる中継サーバーが目にするのは暗号文だけです。",
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
        "WebRTC 標準の暗号化（DTLS）は鍵のフィンガープリントをシグナリングサーバー経由で交換するため、不正なサーバーが中間に入り鍵をすり替える可能性があります。これを検出するため、Relayium は双方の公開鍵から 6 桁の Short Authentication String（SAS）を導出し、両方の画面に表示します。2 つのコードが一致すれば、中間に誰もいません。",
        "単純な 6 桁のコード（約 20 ビット）は、原理的には中継サーバーが一致するコードを総当たりで作り出す余地があります。Relayium はコミット後開示ハンドシェイクでこの隙を塞ぎます。各側はまず鍵のハッシュを送ってコミットし、相手のコミットメントを受け取ってから初めて鍵を開示します。そのためサーバーは後から衝突する鍵を選ぶことができず、短いコードは信頼できるままです。",
      ],
      bullets: [
        "最も強い保証を得るには、コードを帯域外——対面または音声通話——で照合してください。",
        "2 つのコードが異なる場合は転送を中止してください。誰かが接続を傍受している可能性があります。",
      ],
    },
    {
      heading: "サーバーが決して見ないもの",
      body: [
        "本サービスは、以下がどのモードでも当社のサーバーに届かないように設計されています：",
        "リアルタイムモードでは、ファイルの実体はサーバーを一切通らず、2 台のデバイス間で直接やり取りされます。シグナリングサーバーは接続確立のためのメッセージを中継するだけで、把握するのはルームの所属（あなたの公開 IP）、あなたが選んだデバイス名、在席状況のみです。",
      ],
      bullets: [
        "ファイルの内容。",
        "ファイルの名前。",
        "あなたの暗号鍵。",
      ],
    },
    {
      heading: "ファイルが中継される場合（TURN）",
      body: [
        "2 台のデバイスがネットワークをまたいで直接接続できない場合（制限の厳しい NAT やファイアウォール）、転送を完了させるために暗号化ストリームが TURN サーバー経由で中継されます。まず常に直接のピアツーピアが試みられ、中継はフォールバックであり、中継用の資格情報が発行されるのはペアリングコードと共有リンクのセッションのみです。",
      ],
      bullets: [
        "中継サーバーは暗号文のみを転送します。ファイルを読むことはできず、エンドツーエンド暗号化が維持されます。",
        "サービス運用のため、転送ごとの中継バイト数のみを記録し、それを作成したサインイン済みユーザーに紐付けます。",
        "中継されたコンテンツを検査することはありません。",
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
        "リンクには有効期限（1、3、または 7 日）を設定するか、最初の完全なダウンロード後に消える設定にできます。",
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
        "サーバーが必然的に扱うメタデータ：転送が行われた事実、そのサイズと時刻、そして（サインインしていれば）作成したアカウント。",
        "受信者がファイルを受け取った後に保持または転送することを選ぶこと。",
        "復号鍵がリンク内に含まれるため、信頼できない経路でダウンロードリンクを共有すること。",
      ],
    },
    {
      heading: "ブラウザ対応とその限界",
      body: [
        "Relayium は、HTTPS 経由で WebRTC が使える最新ブラウザで動作します。一部の機能はブラウザによって異なります：",
      ],
      bullets: [
        "Chrome と Edge は大きなファイルをディスクへ直接ストリーミングし、実質的なメモリ上限はありません。",
        "Firefox と Safari はファイルをメモリにバッファするため、非常に大きなファイル（およそ 200 MB 超）は失敗することがあります——Chrome/Edge を使うか、そうしたファイルにはダウンロードリンクモードをご利用ください。",
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
    "Relayium이 파일을 보호하는 방식: 전송마다 새로운 X25519 키와 AES-256-GCM, 악의적인 서버를 탐지하기 위한 커밋 후 공개 핸드셰이크를 갖춘 SAS 검증 코드, 영지식 다운로드 링크, 그리고 무엇을 방어하고 무엇을 방어하지 않는지에 대한 솔직한 설명.",
  updatedLabel: "최종 업데이트",
  updated: "2026-07-01",
  otherDocLabel: "개인정보 처리방침",
  lead: [
    "Relayium은 서버가 아니라 파일을 전송하는 당사자가 키를 갖도록 설계되었습니다. 이 페이지에서는 무엇이 어떻게 보호되는지, 그리고 그 보호의 한계를 설명합니다.",
    "요약하면: 실시간 모드에서 파일은 당사 서버를 전혀 거치지 않습니다. 암호화 키는 각 기기에서 새로 생성되어 기기를 떠나지 않습니다. 그리고 짧은 검증 코드로 두 사람은 악의적인 서버를 탐지할 수 있습니다. 자세한 내용은 아래와 같습니다.",
  ],
  sections: [
    {
      heading: "종단간 암호화(X25519 + AES-256-GCM)",
      body: [
        "전송마다 각 기기에서 새로운 임시 X25519 키 쌍이 생성됩니다. 두 기기는 키 교환을 수행하여 두 브라우저 안에만 존재하는 공유 AES-256-GCM 키를 도출합니다. 각 청크는 그 키와 고유한 논스로 암호화되므로, 시그널링 서버와 모든 중계 서버는 오직 암호문만 보게 됩니다.",
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
        "WebRTC 내장 암호화(DTLS)는 키 지문을 시그널링 서버를 통해 교환하므로, 정직하지 않은 서버가 중간에 끼어들어 키를 바꿔치기할 수 있습니다. 이를 탐지하기 위해 Relayium은 양쪽의 공개 키에서 6자리 Short Authentication String(SAS)을 도출하여 두 화면 모두에 표시합니다. 두 코드가 일치하면 중간에 아무도 없는 것입니다.",
        "단순한 6자리 코드(약 20비트)는 원칙적으로 중계 서버가 일치하는 코드를 무차별 대입으로 만들어낼 여지가 있습니다. Relayium은 커밋 후 공개 핸드셰이크로 이 틈을 막습니다. 각 측은 먼저 키의 해시를 보내 커밋하고, 상대방의 커밋을 받은 후에야 키를 공개합니다. 따라서 서버는 나중에 충돌하는 키를 고를 수 없으며, 짧은 코드는 신뢰할 수 있는 상태로 유지됩니다.",
      ],
      bullets: [
        "가장 강력한 보장을 위해서는 코드를 대역 외로 — 직접 만나거나 음성 통화로 — 대조하십시오.",
        "두 코드가 다르면 전송을 중단하십시오. 누군가 연결을 가로채고 있을 수 있습니다.",
      ],
    },
    {
      heading: "서버가 절대 보지 못하는 것",
      body: [
        "본 서비스는 다음 정보가 어떤 모드에서도 당사 서버에 도달하지 않도록 설계되었습니다:",
        "실시간 모드에서는 파일 데이터가 서버를 전혀 거치지 않고 두 기기 사이에서 직접 흐릅니다. 시그널링 서버는 연결 설정 메시지만 중계하며, 룸 소속(사용자의 공개 IP), 사용자가 선택한 기기 별칭, 접속 상태만 볼 수 있습니다.",
      ],
      bullets: [
        "파일의 내용.",
        "파일의 이름.",
        "사용자의 암호화 키.",
      ],
    },
    {
      heading: "파일이 중계될 때(TURN)",
      body: [
        "두 기기가 네트워크를 가로질러 직접 연결할 수 없는 경우(제한적인 NAT 또는 방화벽), 전송을 완료할 수 있도록 암호화된 스트림이 TURN 서버를 통해 중계됩니다. 언제나 직접 피어 투 피어를 먼저 시도하며, 중계는 대체 수단이고, 중계 자격 증명은 페어링 코드와 공유 링크 세션에만 발급됩니다.",
      ],
      bullets: [
        "중계 서버는 암호문만 전달합니다. 파일을 읽을 수 없으며 종단간 암호화가 유지됩니다.",
        "서비스 운영을 위해 전송별 중계 바이트 수만 기록하며, 이를 전송을 생성한 로그인 사용자에게 귀속시킵니다.",
        "중계된 콘텐츠를 검사하지 않습니다.",
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
        "링크는 만료(1, 3, 또는 7일)를 설정하거나 첫 번째 완전한 다운로드 후 소멸되도록 설정할 수 있습니다.",
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
        "서버가 필연적으로 다루는 메타데이터: 전송이 일어났다는 사실, 그 크기와 시각, 그리고 (로그인한 경우) 이를 생성한 계정.",
        "수신자가 파일을 받은 후 보관하거나 전달하기로 선택하는 것.",
        "복호화 키가 링크 안에 담겨 이동하므로, 신뢰할 수 없는 경로로 다운로드 링크를 공유하는 것.",
      ],
    },
    {
      heading: "브라우저 지원과 그 한계",
      body: [
        "Relayium은 HTTPS를 통해 WebRTC를 사용할 수 있는 모든 최신 브라우저에서 작동합니다. 일부 기능은 브라우저에 따라 다릅니다:",
      ],
      bullets: [
        "Chrome과 Edge는 큰 파일을 디스크로 직접 스트리밍하며, 실질적인 메모리 상한이 없습니다.",
        "Firefox와 Safari는 파일을 메모리에 버퍼링하므로 매우 큰 파일(대략 200MB 초과)은 실패할 수 있습니다 — Chrome/Edge를 사용하거나 그런 파일에는 다운로드 링크 모드를 이용하십시오.",
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
    "Wie Relayium Ihre Dateien schützt: pro Übertragung neue X25519-Schlüssel und AES-256-GCM, ein SAS-Prüfcode mit Commit-dann-Offenlegen-Handshake gegen einen bösartigen Server, Zero-Knowledge-Download-Links und eine ehrliche Darstellung dessen, wovor wir schützen und wovor nicht.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-07-01",
  otherDocLabel: "Datenschutzerklärung",
  lead: [
    "Relayium ist so gebaut, dass die Personen, die Dateien übertragen — nicht der Server — die Schlüssel besitzen. Diese Seite beschreibt genau, was geschützt ist, wie es funktioniert und wo die Grenzen dieses Schutzes liegen.",
    "Kurz gesagt: Im Echtzeitmodus berühren Ihre Dateien nie unsere Server; die Verschlüsselungsschlüssel werden auf jedem Gerät neu erzeugt und verlassen es nie; und ein kurzer Prüfcode erlaubt zwei Personen, einen bösartigen Server zu erkennen. Es folgen die Details.",
  ],
  sections: [
    {
      heading: "Ende-zu-Ende-Verschlüsselung (X25519 + AES-256-GCM)",
      body: [
        "Jede Übertragung erzeugt auf jedem Gerät ein frisches, kurzlebiges X25519-Schlüsselpaar. Die beiden Geräte führen einen Schlüsselaustausch durch und leiten daraus einen gemeinsamen AES-256-GCM-Schlüssel ab, der nur in den beiden Browsern existiert. Jeder Chunk wird mit diesem Schlüssel und einer eindeutigen Nonce verschlüsselt, sodass der Signalisierungsserver — und jede Weiterleitung — stets nur Chiffretext sieht.",
      ],
      bullets: [
        "Schlüssel sind kurzlebig und pro Übertragung eigenständig — nichts wird über Sitzungen hinweg wiederverwendet.",
        "Der gemeinsame Schlüssel wird auf den beiden Geräten abgeleitet; er wird nie an einen Server gesendet oder dort gespeichert.",
        "Die Verschlüsselung erfolgt auf der Anwendungsebene, oberhalb der Transportsicherheit von WebRTC, und bleibt daher selbst dann wirksam, wenn die Transportebene kompromittiert wird.",
      ],
    },
    {
      heading: "Der Prüfcode (SAS) — einen bösartigen Server erkennen",
      body: [
        "Die eingebaute Verschlüsselung von WebRTC (DTLS) tauscht Schlüssel-Fingerabdrücke über den Signalisierungsserver aus, sodass ein unehrlicher Server sich dazwischenschalten und Schlüssel austauschen könnte. Um das zu erkennen, leitet Relayium aus den öffentlichen Schlüsseln beider Seiten einen 6-stelligen Short Authentication String (SAS) ab und zeigt ihn auf beiden Bildschirmen an. Stimmen die beiden Codes überein, ist niemand dazwischen.",
        "Ein bloßer 6-stelliger Code (etwa 20 Bit) ließe sich im Prinzip von einer Weiterleitung durch Brute Force zu einem passenden Code zwingen. Relayium schließt diese Lücke mit einem Commit-dann-Offenlegen-Handshake: Jede Seite legt sich zunächst durch das Senden eines Hashes auf ihren Schlüssel fest und gibt den Schlüssel erst preis, nachdem sie die Festlegung der Gegenseite erhalten hat. Ein Server kann daher nicht nachträglich einen kollidierenden Schlüssel wählen, und der kurze Code bleibt vertrauenswürdig.",
      ],
      bullets: [
        "Für die stärkste Garantie vergleichen Sie den Code außerhalb des Kanals — persönlich oder per Sprachanruf.",
        "Wenn die beiden Codes abweichen, brechen Sie die Übertragung ab: Möglicherweise fängt jemand die Verbindung ab.",
      ],
    },
    {
      heading: "Was der Server nie sieht",
      body: [
        "Der Dienst ist so gestaltet, dass Folgendes in keinem Modus unsere Server erreicht:",
        "Im Echtzeitmodus berühren die Dateidaten den Server überhaupt nicht — sie fließen direkt zwischen den beiden Geräten. Der Signalisierungsserver leitet nur Nachrichten zum Verbindungsaufbau weiter und sieht die Raumzugehörigkeit (Ihre öffentliche IP), einen von Ihnen gewählten Gerätenamen und die Anwesenheit.",
      ],
      bullets: [
        "Den Inhalt Ihrer Dateien.",
        "Die Namen Ihrer Dateien.",
        "Ihre Verschlüsselungsschlüssel.",
      ],
    },
    {
      heading: "Wenn Ihre Dateien weitergeleitet werden (TURN)",
      body: [
        "Wenn zwei Geräte über verschiedene Netzwerke hinweg keine direkte Verbindung aufbauen können (restriktive NATs oder Firewalls), wird der verschlüsselte Datenstrom über einen TURN-Server weitergeleitet, damit die Übertragung dennoch abgeschlossen werden kann. Zuerst wird stets eine direkte Peer-to-Peer-Verbindung versucht; die Weiterleitung ist ein Rückfall, und Weiterleitungs-Anmeldedaten werden nur an Sitzungen mit Kopplungscode und Freigabelink ausgegeben.",
      ],
      bullets: [
        "Die Weiterleitung übermittelt nur Chiffretext — sie kann Ihre Dateien nicht lesen, die Ende-zu-Ende-verschlüsselt bleiben.",
        "Für den Betrieb des Dienstes erfassen wir nur die Anzahl der weitergeleiteten Bytes pro Übertragung, zugeordnet dem angemeldeten Benutzer, der sie erstellt hat.",
        "Weitergeleitete Inhalte sehen wir nie ein.",
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
        "Links können so eingestellt werden, dass sie ablaufen (1, 3 oder 7 Tage) oder nach dem ersten vollständigen Download verfallen.",
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
        "Metadaten, die der Server zwangsläufig verarbeitet: dass eine Übertragung stattfand, deren Größe und Zeitpunkt und — falls Sie angemeldet waren — das Konto, das sie erstellt hat.",
        "Einem Empfänger, der sich entscheidet, die Dateien nach Erhalt zu behalten oder weiterzuleiten.",
        "Dem Teilen eines Download-Links über einen nicht vertrauenswürdigen Kanal, da der Entschlüsselungsschlüssel im Link mitreist.",
      ],
    },
    {
      heading: "Browserunterstützung und ihre Grenzen",
      body: [
        "Relayium läuft in jedem modernen Browser mit WebRTC über HTTPS. Einige Fähigkeiten unterscheiden sich je nach Browser:",
      ],
      bullets: [
        "Chrome und Edge streamen große Dateien direkt auf die Festplatte, ohne praktische Speicherobergrenze.",
        "Firefox und Safari puffern Dateien im Arbeitsspeicher, sodass sehr große Dateien (über etwa 200 MB) fehlschlagen können — bevorzugen Sie Chrome/Edge oder nutzen Sie für solche Dateien den Download-Link-Modus.",
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
    "Comment Relayium protège vos fichiers : des clés X25519 propres à chaque transfert et AES-256-GCM, un code de vérification SAS avec une poignée de main « engagement puis révélation » pour déjouer un serveur malveillant, des liens de téléchargement à connaissance nulle, et un exposé honnête de ce contre quoi nous protégeons ou non.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-07-01",
  otherDocLabel: "Politique de confidentialité",
  lead: [
    "Relayium est conçu pour que ce soient les personnes qui transfèrent les fichiers — et non le serveur — qui détiennent les clés. Cette page décrit précisément ce qui est protégé, comment cela fonctionne, et les limites de cette protection.",
    "En bref : en mode temps réel, vos fichiers ne touchent jamais nos serveurs ; les clés de chiffrement sont générées à neuf sur chaque appareil et n'en sortent jamais ; et un court code de vérification permet à deux personnes de détecter un serveur malveillant. Les détails suivent.",
  ],
  sections: [
    {
      heading: "Chiffrement de bout en bout (X25519 + AES-256-GCM)",
      body: [
        "Chaque transfert génère une paire de clés X25519 éphémère et nouvelle sur chaque appareil. Les deux appareils effectuent un échange de clés pour dériver une clé AES-256-GCM partagée qui n'existe qu'à l'intérieur des deux navigateurs. Chaque bloc est chiffré avec cette clé et un nonce unique, si bien que le serveur de signalisation — et tout relais — ne voit jamais que du chiffré.",
      ],
      bullets: [
        "Les clés sont éphémères et propres à chaque transfert — rien n'est réutilisé d'une session à l'autre.",
        "La clé partagée est dérivée sur les deux appareils ; elle n'est jamais envoyée à un serveur ni stockée sur celui-ci.",
        "Le chiffrement est appliqué au niveau applicatif, au-dessus de la sécurité de transport propre à WebRTC, et tient donc même si la couche de transport est compromise.",
      ],
    },
    {
      heading: "Le code de vérification (SAS) — détecter un serveur malveillant",
      body: [
        "Le chiffrement intégré de WebRTC (DTLS) échange les empreintes de clés via le serveur de signalisation, si bien qu'un serveur malhonnête pourrait s'interposer et permuter les clés. Pour le détecter, Relayium dérive un Short Authentication String (SAS) à 6 chiffres à partir des clés publiques des deux parties et l'affiche sur les deux écrans. Si les deux codes correspondent, personne ne s'est interposé.",
        "Un simple code à 6 chiffres (environ 20 bits) pourrait en principe être forcé par un relais cherchant à produire un code correspondant. Relayium comble cette faille par une poignée de main « engagement puis révélation » : chaque partie s'engage d'abord sur sa clé en envoyant un hachage, et ne révèle la clé qu'après avoir reçu l'engagement de l'autre. Un serveur ne peut donc pas choisir après coup une clé provoquant une collision, et le court code reste digne de confiance.",
      ],
      bullets: [
        "Pour la garantie la plus forte, comparez le code hors bande — en personne ou par appel vocal.",
        "Si les deux codes diffèrent, interrompez le transfert : quelqu'un intercepte peut-être la connexion.",
      ],
    },
    {
      heading: "Ce que le serveur ne voit jamais",
      body: [
        "Le service est conçu pour que les éléments suivants n'atteignent jamais nos serveurs, quel que soit le mode :",
        "En mode temps réel, les données des fichiers ne touchent pas du tout le serveur — elles circulent directement entre les deux appareils. Le serveur de signalisation ne relaie que les messages d'établissement de connexion et voit l'appartenance à un salon (votre IP publique), un nom d'appareil que vous choisissez, et la présence.",
      ],
      bullets: [
        "Le contenu de vos fichiers.",
        "Les noms de vos fichiers.",
        "Vos clés de chiffrement.",
      ],
    },
    {
      heading: "Quand vos fichiers sont relayés (TURN)",
      body: [
        "Lorsque deux appareils ne peuvent pas ouvrir de connexion directe entre différents réseaux (NAT restrictifs ou pare-feu), le flux chiffré est relayé via un serveur TURN afin que le transfert puisse tout de même aboutir. Le pair à pair direct est toujours tenté en premier ; le relais est un repli, et les identifiants de relais ne sont délivrés qu'aux sessions par code d'appariement et par lien de partage.",
      ],
      bullets: [
        "Le relais ne transmet que du chiffré — il ne peut pas lire vos fichiers, qui restent chiffrés de bout en bout.",
        "Pour l'exploitation du service, nous enregistrons uniquement le nombre d'octets relayés par transfert, attribué à l'utilisateur connecté qui l'a créé.",
        "Nous n'inspectons jamais le contenu relayé.",
      ],
    },
    {
      heading: "Liens de téléchargement stockés — la clé ne quitte jamais votre navigateur",
      body: [
        "Le mode optionnel de lien de téléchargement est prévu pour les cas où le destinataire n'est pas en ligne. Votre navigateur chiffre les fichiers avec AES-256-GCM avant tout envoi, et la clé de déchiffrement n'est placée que dans le fragment d'URL — la partie après le # —, que les navigateurs n'envoient jamais au serveur.",
      ],
      bullets: [
        "Le serveur ne stocke que du chiffré, plus la taille du chiffré et des horodatages pour les quotas et le nettoyage — jamais de clair, de noms de fichiers ni de clés.",
        "Quiconque possède le lien complet peut déchiffrer ; traitez donc le lien comme le fichier lui-même et partagez-le par un canal de confiance.",
        "Les liens peuvent être réglés pour expirer (1, 3 ou 7 jours) ou pour s'effacer après le premier téléchargement complet.",
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
        "Le chiffrement de bout en bout protège les données en transit entre deux extrémités honnêtes. Par conception, il ne peut pas protéger contre :",
      ],
      bullets: [
        "Un appareil ou un navigateur compromis à l'une des extrémités — logiciel malveillant, extension de navigateur hostile, ou quelqu'un qui regarde l'écran.",
        "Les métadonnées que le serveur traite nécessairement : le fait qu'un transfert a eu lieu, sa taille et son horodatage, et — si vous étiez connecté — le compte qui l'a créé.",
        "Un destinataire qui choisit de conserver ou de transmettre les fichiers après les avoir reçus.",
        "Le partage d'un lien de téléchargement par un canal non fiable, puisque la clé de déchiffrement voyage dans le lien.",
      ],
    },
    {
      heading: "Prise en charge des navigateurs et ses limites",
      body: [
        "Relayium fonctionne dans tout navigateur moderne prenant en charge WebRTC via HTTPS. Quelques capacités diffèrent selon le navigateur :",
      ],
      bullets: [
        "Chrome et Edge diffusent les gros fichiers directement sur le disque, sans plafond de mémoire pratique.",
        "Firefox et Safari mettent les fichiers en mémoire tampon, si bien que les très gros fichiers (au-delà d'environ 200 Mo) peuvent échouer — préférez Chrome/Edge, ou utilisez le mode lien de téléchargement pour ceux-là.",
        "WebRTC exige un contexte sécurisé (HTTPS) ; l'application ne se connecte pas en HTTP simple.",
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

export default { slug: "security", langs: { en, zh, ja, ko, de, fr } };
