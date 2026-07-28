// web/scripts/pages/content/articles/howto-send-files-between-computers.mjs
// How-to: send files between two computers over the internet — the browser
// cross-network pairing-code flow, generalized (device-agnostic, unlike the
// PC-to-phone how-to). English is the master; zh/ja/ko/de/fr follow the same
// structure with identical facts. Terminology mirrors src/lib/i18n/en.ts
// (crossnet.*, pair.*, methods.realtime.*) and CodePairing.svelte / ice.ts.

const en = {
  title: "Send files between two computers over the internet",
  description:
    "A step-by-step guide to sending files directly between two computers over the internet — peer-to-peer, no cloud upload, no install, and end-to-end encrypted the whole way.",
  updatedLabel: "Last updated",
  lead: [
    "Sending a file to another computer usually means uploading it somewhere first — a cloud drive, an email attachment, a chat app — and hoping the recipient can get it back out again. Relayium skips that step: it connects your browser directly to theirs, wherever in the world they are, and streams the file straight across.",
    "This guide covers both cases — two computers on the same network, and two computers on completely different networks (different homes, offices, countries) — and shows exactly what each side needs to do.",
  ],
  sections: [
    {
      heading: "The direct approach: no cloud in the middle",
      body: [
        "Relayium runs entirely in the browser at relayium.com. There is nothing to install on either computer, and no third-party storage sits between you and the recipient: the file streams from one browser to the other and is never written to a server — not even when the two networks require the stream to pass through a relay, which forwards the bytes without keeping a copy or holding a key.",
        "That matters for two reasons: speed (you are not bottlenecked by someone else's upload/download quota) and privacy (no copy of your file sits on a company's servers waiting to be requested, breached, or forgotten about).",
      ],
    },
    {
      heading: "Same network vs. across the internet",
      body: [
        "If both computers are on the same Wi-Fi or LAN, Relayium finds them automatically — open relayium.com on both, and no account is needed on either side.",
        "If the two computers are on different networks — your desktop at home and a colleague's laptop across the country, for instance — automatic discovery cannot reach across the internet, so Relayium uses a short pairing code instead. The person sending signs in to mint that code; the person receiving never needs an account, whether they type the code in or just open the link it generates.",
      ],
    },
    {
      heading: "Step by step: send a file across the internet",
      body: [
        "Here is the full flow for two computers on different networks:",
      ],
      bullets: [
        "On the sending computer, open relayium.com and sign in.",
        "Pick the files or the folder to send — up to 1,000 files per batch. Relayium mints a 6-character pairing code (and a matching join link/QR).",
        "Share that code or link with the other person however is convenient — read it out, text it, paste it in chat.",
        "On the receiving computer, open the link, or open relayium.com and type in the 6-character code. No sign-in required on this side.",
        "Both screens now show the same short verification code (SAS). Check that they match — this confirms the connection is genuinely between the two of you, with no one in between — then the transfer starts automatically.",
      ],
    },
    {
      heading: "Across networks: the encrypted relay",
      body: [
        "Two browsers on the same network connect directly to each other. Across networks — where corporate firewalls and strict NATs routinely block a direct path — Relayium carries the encrypted stream over a TURN relay instead, so the transfer connects reliably.",
        "The relay only ever sees ciphertext: the file is encrypted end-to-end (X25519 key exchange plus AES-256-GCM) before it ever leaves the sending browser, so the relay cannot read it any more than a random computer on the internet could. If the connection drops partway through, the transfer resumes instead of starting over.",
      ],
    },
    {
      heading: "How many files, and how large",
      body: [
        "You can send up to 1,000 files in one batch, folder structure included. There is no server-side size cap — the practical ceiling is set by the receiving browser.",
        "A browser with the File System Access API — Chrome or Edge on the desktop — streams incoming data straight to disk, so multi-gigabyte files are fine. Firefox and Safari don't have that API, so a batch received there is assembled in memory instead, and Relayium warns you before you accept once it goes past roughly 256 MB: a deliberately conservative estimate rather than a measured limit, since the real ceiling depends on the machine's memory, its OS and what else is open. Each file is also checked end-to-end with a SHA-256 hash, so you know what arrives is byte-for-byte what was sent.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is it really peer-to-peer, or does the file pass through a server?",
        a: "It is peer-to-peer in the sense that matters: the file streams browser to browser and is never stored on a server. On the same network the two browsers connect directly to each other. A cross-network pairing-code transfer is carried by a TURN relay by design — the reliable route through the firewalls and NATs that usually block a direct path — but that relay only ever passes encrypted ciphertext through in flight, never the readable file.",
      },
      {
        q: "Do both people need an account?",
        a: "No. On the same network, neither side needs an account. Across different networks, the person sending signs in to create the pairing code — that's what lets Relayium mint and manage the code — but the person receiving never needs an account, whether they type in the code or just open the link.",
      },
      {
        q: "Does it work across different networks and countries?",
        a: "Yes. The pairing code exists specifically for this case: two computers that aren't on the same local network, wherever each one is in the world. That route runs over an encrypted TURN relay rather than a direct link — the path that connects reliably when NATs and firewalls sit in between, and it comes up in a second or two instead of waiting on direct attempts that would almost always time out first.",
      },
      {
        q: "Is there a limit on file size or how many files I can send?",
        a: "You can send up to 1,000 files in a single batch. There's no size cap enforced by the server — the limit is what the receiving browser can handle: essentially unlimited in Chrome or Edge on the desktop (streamed to disk), while Firefox and Safari hold the batch in memory, where Relayium warns you above roughly 256 MB. That threshold is a cautious estimate rather than a hard ceiling; the real one depends on the machine.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on both computers and send your first file across the internet — no cloud upload, no install, and the recipient never needs an account.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何通过互联网在两台电脑之间传文件",
  description:
    "一步步教你在两台电脑之间通过互联网直接传文件——点对点直连，不用上传到云端，不用安装软件，全程端到端加密。",
  updatedLabel: "最近更新",
  lead: [
    "给另一台电脑发文件，通常得先把它传到某个地方——网盘、邮件附件、聊天软件——然后指望对方能顺利取出来。Relayium 省掉了这一步：它把你的浏览器和对方的浏览器直接连起来，不管对方身处世界哪个角落，文件就直接流过去。",
    "本文覆盖两种情况——两台电脑在同一网络，以及两台电脑处于完全不同的网络（不同的家、不同的办公室、不同的国家）——并说明双方各自需要做什么。",
  ],
  sections: [
    {
      heading: "直连方式：中间没有云",
      body: [
        "Relayium 完全在浏览器里运行，网址是 relayium.com。两台电脑都无需安装任何东西，你和对方之间也没有第三方存储：文件从一个浏览器流向另一个浏览器，从不写入服务器——即使两边网络逼得数据流必须经过中继，中继也只是把字节转发过去，既不留副本，也没有密钥。",
        "这一点很重要，原因有二：速度（不会被别人的上传/下载配额卡住）和隐私（不会有一份文件副本留在某公司的服务器上，等着被调取、被泄露或被遗忘）。",
      ],
    },
    {
      heading: "同一网络，还是跨越互联网",
      body: [
        "如果两台电脑在同一 Wi-Fi 或局域网里，Relayium 会自动找到彼此——两边都打开 relayium.com 即可，双方都无需账号。",
        "如果两台电脑处于不同网络——比如你家里的台式机和同事在外地的笔记本——自动发现就没法跨越互联网了，这时 Relayium 改用一个短配对码。发送方需要登录才能生成这个码；接收方始终无需账号，无论是手动输入码还是直接打开它生成的链接。",
      ],
    },
    {
      heading: "分步操作：跨互联网发送文件",
      body: [
        "以下是两台电脑处于不同网络时的完整流程：",
      ],
      bullets: [
        "在发送方的电脑上，打开 relayium.com 并登录。",
        "选择要发送的文件或文件夹——每批最多 1,000 个文件。Relayium 会生成一个 6 位配对码（以及对应的加入链接/二维码）。",
        "用任意方便的方式把这个码或链接告诉对方——念出来、发短信、贴到聊天窗口都行。",
        "在接收方的电脑上，打开链接，或者打开 relayium.com 输入这个 6 位码。这一侧不需要登录。",
        "此时两边屏幕会显示同一段短校验码（SAS）。核对一致——这能确认连接确实只发生在你们两人之间，中间没有第三方——之后传输会自动开始。",
      ],
    },
    {
      heading: "跨网络：加密中继",
      body: [
        "同一网络下的两个浏览器彼此直连。跨网络时——企业防火墙和严格 NAT 经常挡住直连路径——Relayium 改用 TURN 中继来承载加密数据流，因此连接更可靠。",
        "中继只能看到密文：文件在离开发送方浏览器之前就已端到端加密（X25519 密钥交换加 AES-256-GCM），所以中继读不到内容，就跟互联网上随便一台电脑一样看不到。如果中途断线，传输会续传而不是从头再来。",
      ],
    },
    {
      heading: "能传多少文件、多大的文件",
      body: [
        "一批最多可以发送 1,000 个文件，包含文件夹结构。服务器端没有大小上限——实际限制取决于接收方的浏览器。",
        "支持 File System Access API 的浏览器——桌面版 Chrome、Edge——会把接收到的数据直接流式写入磁盘，所以几个 GB 的文件也没问题。Firefox 和 Safari 没有这个 API，在它们那边接收的整批文件只能先攒在内存里，因此一旦超过约 256 MB，Relayium 会在你点「接收」之前先提示一次：这是刻意取的保守估计，而不是实测出来的上限，真正的天花板取决于这台机器的内存、系统以及还开着什么。每个文件还会做端到端的 SHA-256 校验，确保收到的内容和发出的完全一致。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "这真的是点对点直连吗，会经过服务器吗？",
        a: "在真正关键的那一点上，它就是点对点：文件从一个浏览器流向另一个浏览器，从不存储在服务器上。同一网络下两个浏览器彼此直连。而跨网络的配对码传输按设计经由 TURN 中继承载——这是穿过那些通常挡住直连的防火墙和 NAT 的可靠路径——但中继只是在传输过程中转发加密密文，从来看不到可读的文件。",
      },
      {
        q: "双方都需要账号吗？",
        a: "不需要。同一网络下，双方都不需要账号。跨网络时，发送方需要登录才能生成配对码——这是 Relayium 生成和管理配对码所必需的——但接收方始终无需账号，无论对方是输入配对码还是直接打开链接。",
      },
      {
        q: "能跨不同网络甚至不同国家传输吗？",
        a: "可以。配对码正是为这种情况设计的：两台不在同一局域网的电脑，无论各自身处世界哪个角落都能连上。这条路径走的是加密 TURN 中继而不是直连——在 NAT 和防火墙挡在中间时，它才是可靠连上的那条路，而且一两秒就能建立，不必去等那些几乎注定超时的直连尝试。",
      },
      {
        q: "文件大小或数量有限制吗？",
        a: "一批最多可以发送 1,000 个文件。服务器不设大小上限——限制取决于接收方浏览器能扛多大：桌面版 Chrome 或 Edge（流式写入磁盘）基本没有上限；Firefox 和 Safari 会把整批文件放在内存里，超过约 256 MB 时 Relayium 会先提示你。这个阈值是保守估计而非硬性天花板，真正的上限要看那台机器。",
      },
    ],
  },
  cta: {
    text: "在两台电脑上打开 Relayium，跨互联网发出你的第一个文件——不用上传到云端，不用安装，接收方也始终无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "インターネット経由で2台のPC間にファイルを送る方法",
  description:
    "インターネットを介して2台のパソコン間で直接ファイルを送る手順ガイド。P2P直接接続、クラウドへのアップロード不要、インストール不要、全行程エンドツーエンド暗号化。",
  updatedLabel: "最終更新",
  lead: [
    "別のパソコンにファイルを送るには、たいていまずどこかにアップロードして（クラウドドライブ、メールの添付、チャットアプリ）、相手が無事に取り出せることを願うことになります。Relayium はその手順を省きます。世界のどこにいても、手元のブラウザと相手のブラウザを直接つなぎ、ファイルをそのまま流します。",
    "本ガイドは2つのケース、すなわち同じネットワーク上の2台と、まったく別のネットワーク（別の家、別のオフィス、別の国）にある2台を扱い、それぞれの側が何をすればよいかを正確に示します。",
  ],
  sections: [
    {
      heading: "直接方式：クラウドを介さない",
      body: [
        "Relayium は relayium.com でブラウザ内だけで動作します。どちらのパソコンにもインストールするものはなく、自分と相手の間にサードパーティのストレージは存在しません。ファイルは一方のブラウザからもう一方のブラウザへ流れ、サーバーに書き込まれることはありません。2つのネットワークの都合でストリームがリレーを通る場合でも、リレーはバイトを中継するだけで、コピーも鍵も持ちません。",
        "これが重要なのは2つの理由からです。速度（他人のアップロード／ダウンロード割り当てに足を引っ張られない）と、プライバシー（どこかの会社のサーバーにファイルのコピーが残り、要求されたり、漏えいしたり、忘れ去られたりする心配がない）です。",
      ],
    },
    {
      heading: "同じネットワークか、インターネットをまたぐか",
      body: [
        "2台とも同じ Wi-Fi や LAN にあれば、Relayium は自動的に互いを見つけます。両方で relayium.com を開くだけで、どちらの側もアカウントは不要です。",
        "2台が別々のネットワークにある場合（たとえば自宅のデスクトップと遠方にいる同僚のノートPCなど）、自動発見はインターネットをまたげないため、Relayium は代わりに短いペアリングコードを使います。送信する側がサインインしてそのコードを発行し、受信する側はコードを入力するにせよ、生成されたリンクを開くにせよ、アカウントは一切不要です。",
      ],
    },
    {
      heading: "手順：インターネット経由でファイルを送る",
      body: [
        "別々のネットワークにある2台のパソコンの場合の全体の流れです。",
      ],
      bullets: [
        "送信側のパソコンで relayium.com を開き、サインインします。",
        "送るファイルまたはフォルダを選びます。1バッチ最大1,000ファイル。Relayium が6文字のペアリングコード（対応する参加リンク／QRコード付き）を発行します。",
        "そのコードやリンクを都合の良い方法で相手に伝えます。読み上げる、テキストメッセージで送る、チャットに貼り付けるなど。",
        "受信側のパソコンで、リンクを開くか、relayium.com を開いて6文字のコードを入力します。こちら側にサインインは不要です。",
        "両方の画面に同じ短い検証コード（SAS）が表示されます。一致を確認してください（これは接続が本当に2人の間だけで、間に誰も入っていないことを確認するものです）。その後、転送が自動的に始まります。",
      ],
    },
    {
      heading: "ネットワークをまたぐ場合：暗号化リレー",
      body: [
        "同じネットワーク上の2つのブラウザは互いに直接接続します。ネットワークをまたぐ場合は、企業のファイアウォールや厳格な NAT が直接経路を日常的に阻むため、Relayium が暗号化されたストリームを TURN リレー経由で運び、確実につながるようにします。",
        "リレーが見るのは常に暗号文だけです。ファイルは送信側ブラウザを離れる前にすでにエンドツーエンドで暗号化されており（X25519 鍵交換と AES-256-GCM）、リレーはインターネット上の見知らぬパソコンと同様、中身を読み取ることはできません。途中で接続が切れても、転送は最初からではなく再開されます。",
      ],
    },
    {
      heading: "何ファイルまで、どのくらいの大きさまで",
      body: [
        "1バッチで最大1,000ファイル、フォルダ構造も含めて送れます。サーバー側にサイズ上限はなく、実質的な上限は受信側のブラウザによって決まります。",
        "File System Access API を備えたブラウザ（パソコン版の Chrome や Edge）は受信データをそのままディスクへストリーミングするので、数ギガバイトのファイルでも問題ありません。Firefox と Safari にはこの API がないため、そちらで受信するとひとまとめにメモリへ溜めることになり、およそ 256MB を超えると Relayium が受け取る前に警告を出します。これは実測した上限ではなく意図的に控えめに置いた目安で、実際の天井はそのパソコンのメモリ・OS・ほかに何を開いているかで決まります。各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるため、届いたものが送られたものとバイト単位で一致しているとわかります。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "本当に P2P 直接接続ですか、それともファイルはサーバーを経由しますか？",
        a: "肝心な意味では P2P です。ファイルはブラウザからブラウザへ流れ、サーバーに保存されることはありません。同じネットワーク上なら2つのブラウザは互いに直接つながります。ネットワークをまたぐペアリングコードでの転送は、設計上つねに TURN リレーが運びます。直接経路をたいてい塞いでしまうファイアウォールや NAT を越えて確実につながる経路です。ただし、そのリレーが通すのは通信中の暗号文だけで、読めるファイルが渡ることはありません。",
      },
      {
        q: "双方ともアカウントが必要ですか？",
        a: "いいえ。同じネットワーク上では、どちらの側もアカウントは不要です。ネットワークをまたぐ場合、送信する側はペアリングコードを作成するためにサインインします（これは Relayium がコードを発行・管理するために必要です）。ですが受信する側は、コードを入力するにせよリンクを開くにせよ、アカウントは一切不要です。",
      },
      {
        q: "異なるネットワークや国をまたいでも使えますか？",
        a: "はい。ペアリングコードはまさにこのケースのために存在します。同じローカルネットワークにない2台のパソコンが、世界のどこにいてもつながります。その経路は直接接続ではなく暗号化された TURN リレーを通ります。NAT やファイアウォールが間に立ちはだかるときに確実につながるのがこの経路で、しかもほぼ必ずタイムアウトする直接接続の試行を待たずに1〜2秒で確立します。",
      },
      {
        q: "ファイルサイズや送れるファイル数に制限はありますか？",
        a: "1バッチで最大1,000ファイルまで送れます。サーバーが強制するサイズ上限はなく、限界は受信側のブラウザが扱える範囲で決まります。パソコン版の Chrome や Edge（ディスクへストリーミング）では事実上無制限で、Firefox や Safari はバッチをメモリに保持するため、およそ 256MB を超えると Relayium が警告します。この閾値は硬い天井ではなく控えめな目安で、本当の限界はその機械しだいです。",
      },
    ],
  },
  cta: {
    text: "両方のパソコンで Relayium を開き、インターネット経由で最初のファイルを送ってみてください。クラウドへのアップロードも、インストールも不要で、受信側は常にアカウント不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "인터넷으로 컴퓨터 두 대 사이에 파일 보내는 방법",
  description:
    "인터넷을 통해 두 컴퓨터 사이에서 파일을 직접 보내는 단계별 가이드 — P2P 직접 연결, 클라우드 업로드 없이, 설치 없이, 전 과정 종단간 암호화.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "다른 컴퓨터에 파일을 보내려면 보통 먼저 어딘가에 올려야 합니다 — 클라우드 드라이브, 메일 첨부, 채팅 앱 — 그리고 상대가 무사히 다시 꺼낼 수 있길 바라야 합니다. Relayium은 이 단계를 건너뜁니다. 세상 어디에 있든 내 브라우저와 상대의 브라우저를 직접 연결해 파일을 곧장 흘려보냅니다.",
    "이 가이드는 두 가지 경우 — 같은 네트워크의 컴퓨터 두 대, 그리고 완전히 다른 네트워크(다른 집, 다른 사무실, 다른 나라)에 있는 컴퓨터 두 대 — 를 모두 다루고, 각 쪽이 정확히 무엇을 해야 하는지 보여줍니다.",
  ],
  sections: [
    {
      heading: "직접 연결 방식: 중간에 클라우드가 없다",
      body: [
        "Relayium은 relayium.com에서 브라우저 안에서만 동작합니다. 어느 컴퓨터에도 설치할 것이 없고, 나와 상대 사이에 제3자 저장소가 끼어들지 않습니다. 파일은 한 브라우저에서 다른 브라우저로 흐르며 서버에 저장되는 일이 없습니다 — 두 네트워크 사정상 스트림이 릴레이를 거쳐야 할 때도 마찬가지로, 릴레이는 바이트를 넘겨줄 뿐 사본도 키도 갖지 않습니다.",
        "이것이 중요한 이유는 두 가지입니다. 속도(다른 사람의 업로드/다운로드 할당량에 발목 잡히지 않음)와 개인정보 보호(어느 회사 서버에 파일 사본이 남아 요청되거나 유출되거나 방치될 걱정이 없음)입니다.",
      ],
    },
    {
      heading: "같은 네트워크 vs. 인터넷을 넘나드는 경우",
      body: [
        "두 컴퓨터가 같은 Wi-Fi나 LAN에 있다면 Relayium이 자동으로 서로를 찾습니다 — 양쪽에서 relayium.com을 열기만 하면 되고, 어느 쪽도 계정이 필요 없습니다.",
        "두 컴퓨터가 서로 다른 네트워크에 있다면 — 예를 들어 집의 데스크톱과 먼 곳에 있는 동료의 노트북 — 자동 탐색은 인터넷을 넘어설 수 없으므로 Relayium은 대신 짧은 페어링 코드를 씁니다. 보내는 쪽이 로그인해서 그 코드를 발급받고, 받는 쪽은 코드를 입력하든 생성된 링크를 열든 계정이 전혀 필요 없습니다.",
      ],
    },
    {
      heading: "단계별로 따라 하기: 인터넷으로 파일 보내기",
      body: [
        "서로 다른 네트워크에 있는 두 컴퓨터의 전체 흐름은 다음과 같습니다.",
      ],
      bullets: [
        "보내는 쪽 컴퓨터에서 relayium.com을 열고 로그인합니다.",
        "보낼 파일이나 폴더를 고릅니다 — 배치당 최대 1,000개. Relayium이 6자리 페어링 코드(그리고 짝을 이루는 참여 링크/QR)를 발급합니다.",
        "그 코드나 링크를 편한 방법으로 상대에게 전달합니다 — 불러주거나, 문자로 보내거나, 채팅에 붙여넣거나.",
        "받는 쪽 컴퓨터에서 링크를 열거나, relayium.com을 열고 6자리 코드를 입력합니다. 이쪽은 로그인이 필요 없습니다.",
        "이제 양쪽 화면에 동일한 짧은 검증 코드(SAS)가 표시됩니다. 일치하는지 확인하세요 — 이는 연결이 정말로 두 사람 사이에서만 이루어지고 중간에 아무도 없음을 확인해 줍니다 — 그러면 전송이 자동으로 시작됩니다.",
      ],
    },
    {
      heading: "네트워크를 넘을 때: 암호화된 릴레이",
      body: [
        "같은 네트워크에 있는 두 브라우저는 서로 직접 연결됩니다. 네트워크를 넘을 때는 — 회사 방화벽이나 엄격한 NAT가 직접 경로를 흔히 막기 때문에 — Relayium이 암호화된 스트림을 TURN 릴레이로 전달해 안정적으로 연결합니다.",
        "릴레이는 항상 암호문만 봅니다. 파일은 보내는 쪽 브라우저를 떠나기 전에 이미 종단간 암호화되어 있으므로(X25519 키 교환과 AES-256-GCM), 릴레이는 인터넷의 아무 컴퓨터나 마찬가지로 내용을 읽을 수 없습니다. 도중에 연결이 끊겨도 전송은 처음부터가 아니라 이어서 재개됩니다.",
      ],
    },
    {
      heading: "몇 개까지, 얼마나 큰 파일까지",
      body: [
        "한 배치에 폴더 구조를 포함해 최대 1,000개의 파일을 보낼 수 있습니다. 서버 쪽에는 크기 상한이 없으며, 실제 한계는 받는 쪽 브라우저가 결정합니다.",
        "File System Access API가 있는 브라우저(데스크톱 Chrome, Edge)는 들어오는 데이터를 곧장 디스크로 스트리밍하므로 수 기가바이트짜리 파일도 문제없습니다. Firefox와 Safari에는 그 API가 없어서 그쪽에서 받으면 한 묶음을 메모리에 모으게 되며, 대략 256MB를 넘어서면 Relayium이 수락하기 전에 미리 경고합니다. 이는 측정된 상한이 아니라 일부러 보수적으로 잡은 추정치이고, 실제 상한은 그 컴퓨터의 메모리와 OS, 그 밖에 열어 둔 것에 달려 있습니다. 각 파일은 SHA-256 해시로 종단간 검증되므로 도착한 파일이 보낸 파일과 바이트 단위로 같다는 것을 알 수 있습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "정말로 P2P 직접 연결인가요, 아니면 파일이 서버를 거치나요?",
        a: "중요한 의미에서는 P2P가 맞습니다. 파일은 브라우저에서 브라우저로 흐르며 서버에 저장되지 않습니다. 같은 네트워크에서는 두 브라우저가 서로 직접 연결됩니다. 네트워크를 넘는 페어링 코드 전송은 설계상 TURN 릴레이가 실어 나릅니다 — 직접 경로를 대개 막아버리는 방화벽과 NAT를 통과해 확실히 연결되는 경로입니다 — 하지만 그 릴레이는 오가는 암호문만 통과시킬 뿐, 읽을 수 있는 파일은 결코 보지 못합니다.",
      },
      {
        q: "양쪽 모두 계정이 필요한가요?",
        a: "아니요. 같은 네트워크에서는 양쪽 다 계정이 필요 없습니다. 네트워크를 넘나들 때는 보내는 쪽이 페어링 코드를 만들기 위해 로그인해야 합니다 — 이는 Relayium이 코드를 발급하고 관리하는 데 필요한 절차입니다 — 하지만 받는 쪽은 코드를 입력하든 링크를 열든 계정이 전혀 필요 없습니다.",
      },
      {
        q: "서로 다른 네트워크나 나라를 넘나들어도 되나요?",
        a: "네. 페어링 코드는 바로 이런 경우를 위한 것입니다. 같은 로컬 네트워크에 있지 않은 두 컴퓨터가 세상 어디에 있든 연결됩니다. 그 경로는 직접 연결이 아니라 암호화된 TURN 릴레이를 지납니다 — NAT와 방화벽이 사이에 있을 때 확실히 닿는 길이며, 거의 반드시 시간 초과로 끝날 직접 연결 시도를 기다리지 않고 1~2초 만에 성립합니다.",
      },
      {
        q: "파일 크기나 개수에 제한이 있나요?",
        a: "한 배치에 최대 1,000개의 파일을 보낼 수 있습니다. 서버가 강제하는 크기 상한은 없으며, 한계는 받는 쪽 브라우저가 감당할 수 있는 정도로 정해집니다. 데스크톱 Chrome이나 Edge(디스크로 스트리밍)에서는 사실상 무제한이고, Firefox와 Safari는 묶음을 메모리에 담기 때문에 대략 256MB를 넘으면 Relayium이 경고합니다. 이 기준선은 고정된 천장이 아니라 보수적으로 잡은 값이며, 진짜 한계는 그 컴퓨터에 달려 있습니다.",
      },
    ],
  },
  cta: {
    text: "두 컴퓨터 모두에서 Relayium을 열고 인터넷으로 첫 파일을 보내 보세요 — 클라우드 업로드도, 설치도 필요 없고, 받는 쪽은 언제나 계정이 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien über das Internet zwischen zwei Computern senden",
  description:
    "Eine Schritt-für-Schritt-Anleitung, um Dateien direkt über das Internet zwischen zwei Computern zu senden — Peer-to-Peer, kein Cloud-Upload, keine Installation, durchgehend Ende-zu-Ende-verschlüsselt.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Eine Datei an einen anderen Computer zu senden bedeutet normalerweise, sie zuerst irgendwohin hochzuladen — eine Cloud, einen E-Mail-Anhang, eine Chat-App — und zu hoffen, dass der Empfänger sie wieder herunterbekommt. Relayium überspringt diesen Schritt: Es verbindet deinen Browser direkt mit dem des Empfängers, egal wo auf der Welt er sich befindet, und überträgt die Datei direkt.",
    "Diese Anleitung deckt beide Fälle ab — zwei Computer im selben Netzwerk und zwei Computer in völlig unterschiedlichen Netzwerken (verschiedene Wohnungen, Büros, Länder) — und zeigt genau, was jede Seite tun muss.",
  ],
  sections: [
    {
      heading: "Der direkte Weg: keine Cloud dazwischen",
      body: [
        "Relayium läuft vollständig im Browser unter relayium.com. Es gibt nichts zu installieren, auf keinem der beiden Computer, und kein Drittanbieter-Speicher sitzt zwischen dir und dem Empfänger: Die Datei geht von einem Browser zum anderen und wird nie auf einem Server abgelegt — auch dann nicht, wenn die beiden Netzwerke den Datenstrom über ein Relay zwingen, das die Bytes nur weiterreicht, ohne Kopie und ohne Schlüssel.",
        "Das zählt aus zwei Gründen: Geschwindigkeit (du wirst nicht durch das Upload-/Download-Kontingent einer anderen Person ausgebremst) und Privatsphäre (keine Kopie deiner Datei liegt auf den Servern eines Unternehmens und wartet darauf, angefordert, kompromittiert oder vergessen zu werden).",
      ],
    },
    {
      heading: "Selbes Netzwerk vs. über das Internet",
      body: [
        "Sind beide Computer im selben WLAN oder LAN, findet Relayium sie automatisch — öffne auf beiden relayium.com, und auf keiner Seite ist ein Konto nötig.",
        "Sind die beiden Computer in unterschiedlichen Netzwerken — dein Desktop zu Hause und der Laptop einer Kollegin am anderen Ende des Landes, zum Beispiel — kann die automatische Erkennung das Internet nicht überbrücken, also nutzt Relayium stattdessen einen kurzen Pairing-Code. Der Absender meldet sich an, um diesen Code zu erzeugen; der Empfänger braucht nie ein Konto, egal ob er den Code eingibt oder einfach den erzeugten Link öffnet.",
      ],
    },
    {
      heading: "Schritt für Schritt: eine Datei über das Internet senden",
      body: [
        "So läuft der komplette Vorgang für zwei Computer in unterschiedlichen Netzwerken ab:",
      ],
      bullets: [
        "Öffne auf dem sendenden Computer relayium.com und melde dich an.",
        "Wähle die zu sendenden Dateien oder den Ordner aus — bis zu 1.000 Dateien pro Stapel. Relayium erzeugt einen sechsstelligen Pairing-Code (und den passenden Beitrittslink/QR-Code).",
        "Teile diesen Code oder Link auf beliebige, bequeme Weise mit der anderen Person — vorlesen, per SMS schicken, in den Chat einfügen.",
        "Öffne auf dem empfangenden Computer den Link, oder öffne relayium.com und gib den sechsstelligen Code ein. Auf dieser Seite ist keine Anmeldung nötig.",
        "Beide Bildschirme zeigen nun denselben kurzen Verifizierungscode (SAS). Prüfe, ob sie übereinstimmen — das bestätigt, dass die Verbindung wirklich nur zwischen den beiden Seiten besteht und niemand dazwischensitzt — dann startet die Übertragung automatisch.",
      ],
    },
    {
      heading: "Netzübergreifend: das verschlüsselte Relay",
      body: [
        "Zwei Browser im selben Netzwerk verbinden sich direkt miteinander. Netzübergreifend — wo Firmen-Firewalls und strenge NATs einen direkten Pfad regelmäßig blockieren — überträgt Relayium den verschlüsselten Datenstrom stattdessen über ein TURN-Relay, damit die Verbindung zuverlässig zustande kommt.",
        "Das Relay sieht dabei stets nur Chiffretext: Die Datei ist bereits Ende-zu-Ende verschlüsselt (X25519-Schlüsselaustausch plus AES-256-GCM), bevor sie den sendenden Browser überhaupt verlässt, sodass das Relay sie ebenso wenig lesen kann wie ein beliebiger anderer Rechner im Internet. Bricht die Verbindung mittendrin ab, wird die Übertragung fortgesetzt statt neu gestartet.",
      ],
    },
    {
      heading: "Wie viele Dateien, wie groß",
      body: [
        "Du kannst bis zu 1.000 Dateien in einem Stapel senden, inklusive Ordnerstruktur. Es gibt keine serverseitige Größenbegrenzung — die praktische Obergrenze setzt der empfangende Browser.",
        "Ein Browser mit der File System Access API — Chrome oder Edge auf dem Desktop — streamt eingehende Daten direkt auf die Festplatte, mehrere Gigabyte große Dateien sind also kein Problem. Firefox und Safari haben diese API nicht, dort sammelt sich ein empfangener Stapel im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium dich, bevor du annimmst: eine bewusst vorsichtige Schätzung und keine gemessene Grenze, denn die tatsächliche Obergrenze hängt vom Arbeitsspeicher des Rechners, vom Betriebssystem und davon ab, was sonst offen ist. Jede Datei wird zudem per SHA-256-Hash Ende-zu-Ende geprüft, sodass du weißt, dass das Ankommende byteweise mit dem Gesendeten übereinstimmt.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist es wirklich Peer-to-Peer, oder läuft die Datei über einen Server?",
        a: "In dem Sinn, auf den es ankommt, ja: Die Datei wird von Browser zu Browser gestreamt und nie auf einem Server gespeichert. Im selben Netzwerk verbinden sich die beiden Browser direkt miteinander. Eine netzübergreifende Übertragung per Pairing-Code trägt von Grund auf ein TURN-Relay — der verlässliche Weg durch die Firewalls und NATs, die einen direkten Pfad meist blockieren —, aber dieses Relay reicht im Betrieb nur verschlüsselten Chiffretext weiter, nie die lesbare Datei.",
      },
      {
        q: "Brauchen beide Seiten ein Konto?",
        a: "Nein. Im selben Netzwerk braucht keine der beiden Seiten ein Konto. Über Netzwerke hinweg meldet sich die sendende Person an, um den Pairing-Code zu erzeugen — das braucht Relayium, um den Code zu vergeben und zu verwalten —, aber die empfangende Person braucht nie ein Konto, egal ob sie den Code eingibt oder nur den Link öffnet.",
      },
      {
        q: "Funktioniert das über verschiedene Netzwerke und Länder hinweg?",
        a: "Ja. Genau dafür gibt es den Pairing-Code: Zwei Computer, die nicht im selben lokalen Netzwerk sind, egal wo auf der Welt sie stehen. Dieser Weg läuft über ein verschlüsseltes TURN-Relay statt über eine direkte Verbindung — er ist der, der zuverlässig zustande kommt, wenn NATs und Firewalls dazwischenstehen, und er steht in ein bis zwei Sekunden, statt auf Direktversuche zu warten, die fast immer zuerst in einen Timeout laufen.",
      },
      {
        q: "Gibt es eine Grenze bei Dateigröße oder -anzahl?",
        a: "Du kannst bis zu 1.000 Dateien in einem einzigen Stapel senden. Es gibt keine vom Server erzwungene Größenbegrenzung — die Grenze setzt, was der empfangende Browser bewältigen kann: praktisch unbegrenzt in Chrome oder Edge auf dem Desktop (auf die Festplatte gestreamt), während Firefox und Safari den Stapel im Arbeitsspeicher halten, wo Relayium ab etwa 256 MB warnt. Dieser Schwellenwert ist eine vorsichtige Schätzung und keine harte Obergrenze; die echte hängt vom Rechner ab.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf beiden Computern und sende deine erste Datei über das Internet — kein Cloud-Upload, keine Installation, und der Empfänger braucht nie ein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer des fichiers entre deux ordinateurs par Internet",
  description:
    "Un guide pas à pas pour envoyer des fichiers directement entre deux ordinateurs par Internet — pair-à-pair, sans envoi vers le cloud, sans installation, chiffré de bout en bout tout du long.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Envoyer un fichier à un autre ordinateur signifie généralement le téléverser quelque part au préalable — un cloud, une pièce jointe d'e-mail, une appli de messagerie — puis espérer que le destinataire pourra le récupérer. Relayium saute cette étape : il connecte votre navigateur directement à celui du destinataire, où qu'il se trouve dans le monde, et fait transiter le fichier directement.",
    "Ce guide couvre les deux cas — deux ordinateurs sur le même réseau, et deux ordinateurs sur des réseaux complètement différents (domiciles, bureaux, pays différents) — et montre exactement ce que chaque côté doit faire.",
  ],
  sections: [
    {
      heading: "La méthode directe : pas de cloud au milieu",
      body: [
        "Relayium fonctionne entièrement dans le navigateur, sur relayium.com. Il n'y a rien à installer sur aucun des deux ordinateurs, et aucun stockage tiers ne s'interpose entre vous et le destinataire : le fichier va d'un navigateur à l'autre et n'est jamais écrit sur un serveur — pas même lorsque les deux réseaux obligent le flux à passer par un relais, qui se contente de faire suivre les octets, sans copie ni clé.",
        "Cela compte pour deux raisons : la vitesse (vous n'êtes pas bridé par le quota de téléversement/téléchargement de quelqu'un d'autre) et la confidentialité (aucune copie de votre fichier ne reste sur les serveurs d'une entreprise, en attente d'être réclamée, compromise ou oubliée).",
      ],
    },
    {
      heading: "Même réseau vs. à travers Internet",
      body: [
        "Si les deux ordinateurs sont sur le même Wi-Fi ou réseau local, Relayium les trouve automatiquement — ouvrez relayium.com sur les deux, aucun compte n'est nécessaire d'un côté comme de l'autre.",
        "Si les deux ordinateurs sont sur des réseaux différents — votre ordinateur de bureau chez vous et le portable d'une collègue à l'autre bout du pays, par exemple — la découverte automatique ne peut pas traverser Internet, donc Relayium utilise à la place un court code d'appairage. La personne qui envoie se connecte pour générer ce code ; la personne qui reçoit n'a jamais besoin de compte, qu'elle saisisse le code ou ouvre simplement le lien généré.",
      ],
    },
    {
      heading: "Étape par étape : envoyer un fichier par Internet",
      body: [
        "Voici le déroulé complet pour deux ordinateurs sur des réseaux différents :",
      ],
      bullets: [
        "Sur l'ordinateur qui envoie, ouvrez relayium.com et connectez-vous.",
        "Choisissez les fichiers ou le dossier à envoyer — jusqu'à 1 000 fichiers par lot. Relayium génère un code d'appairage à 6 caractères (avec le lien de participation/code QR correspondant).",
        "Partagez ce code ou ce lien avec l'autre personne comme cela vous arrange — le lire à voix haute, l'envoyer par SMS, le coller dans un chat.",
        "Sur l'ordinateur qui reçoit, ouvrez le lien, ou ouvrez relayium.com et saisissez le code à 6 caractères. Aucune connexion n'est requise de ce côté.",
        "Les deux écrans affichent maintenant le même court code de vérification (SAS). Vérifiez qu'il concorde — cela confirme que la connexion se fait bien uniquement entre vous deux, sans personne au milieu — puis le transfert démarre automatiquement.",
      ],
    },
    {
      heading: "Entre réseaux : le relais chiffré",
      body: [
        "Deux navigateurs sur le même réseau se connectent directement l'un à l'autre. Entre réseaux — où les pare-feux d'entreprise et les NAT stricts bloquent régulièrement tout chemin direct —, Relayium achemine le flux chiffré via un relais TURN, pour que la connexion aboutisse de façon fiable.",
        "Le relais ne voit jamais que du texte chiffré : le fichier est déjà chiffré de bout en bout (échange de clés X25519 plus AES-256-GCM) avant même de quitter le navigateur expéditeur, si bien que le relais ne peut pas le lire, pas plus qu'un ordinateur quelconque sur Internet. Si la connexion se coupe en cours de route, le transfert reprend au lieu de tout recommencer.",
      ],
    },
    {
      heading: "Combien de fichiers, et de quelle taille",
      body: [
        "Vous pouvez envoyer jusqu'à 1 000 fichiers en un seul lot, structure de dossiers comprise. Il n'y a aucune limite de taille côté serveur — le plafond pratique est fixé par le navigateur qui reçoit.",
        "Un navigateur doté de l'API File System Access — Chrome ou Edge sur ordinateur — écrit en flux les données entrantes directement sur le disque, donc des fichiers de plusieurs gigaoctets passent sans problème. Firefox et Safari n'ont pas cette API : un lot reçu là est assemblé en mémoire, et Relayium vous prévient avant que vous acceptiez dès que l'on dépasse environ 256 Mo — une estimation volontairement prudente plutôt qu'une limite mesurée, le plafond réel dépendant de la mémoire de la machine, de son système et de ce qui est ouvert par ailleurs. Chaque fichier est aussi vérifié de bout en bout par une empreinte SHA-256, pour que vous sachiez que ce qui arrive est identique, octet pour octet, à ce qui a été envoyé.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Est-ce vraiment du pair-à-pair, ou le fichier passe-t-il par un serveur ?",
        a: "C'est du pair-à-pair au sens qui compte : le fichier transite d'un navigateur à l'autre et n'est jamais stocké sur un serveur. Sur le même réseau, les deux navigateurs se connectent directement l'un à l'autre. Entre réseaux, un transfert par code d'appairage est porté par un relais TURN, par conception — la voie qui aboutit de façon fiable à travers les pare-feux et les NAT qui bloquent d'ordinaire tout chemin direct — mais ce relais ne fait passer que du texte chiffré au vol, jamais le fichier lisible.",
      },
      {
        q: "Les deux personnes ont-elles besoin d'un compte ?",
        a: "Non. Sur le même réseau, aucun des deux côtés n'a besoin de compte. Entre réseaux différents, la personne qui envoie se connecte pour créer le code d'appairage — c'est ce qui permet à Relayium de générer et de gérer ce code — mais la personne qui reçoit n'a jamais besoin de compte, qu'elle saisisse le code ou ouvre simplement le lien.",
      },
      {
        q: "Est-ce que cela marche entre réseaux et pays différents ?",
        a: "Oui. Le code d'appairage existe précisément pour ce cas : deux ordinateurs qui ne sont pas sur le même réseau local, où qu'ils se trouvent dans le monde. Cette voie emprunte un relais TURN chiffré plutôt qu'une liaison directe — c'est elle qui aboutit de façon fiable quand des NAT et des pare-feux s'interposent, et elle s'établit en une ou deux secondes au lieu d'attendre des tentatives directes qui expireraient presque à coup sûr.",
      },
      {
        q: "Y a-t-il une limite de taille de fichier ou de nombre de fichiers ?",
        a: "Vous pouvez envoyer jusqu'à 1 000 fichiers en un seul lot. Aucune limite de taille n'est imposée par le serveur — la limite dépend de ce que le navigateur qui reçoit peut gérer : pratiquement illimité dans Chrome ou Edge sur ordinateur (écriture en flux sur le disque), tandis que Firefox et Safari gardent le lot en mémoire, où Relayium prévient au-delà d'environ 256 Mo. Ce seuil est une estimation prudente, pas un plafond ferme ; le vrai dépend de la machine.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur les deux ordinateurs et envoyez votre premier fichier par Internet — sans envoi vers le cloud, sans installation, et le destinataire n'a jamais besoin de compte.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال الملفات بين حاسوبين عبر الإنترنت",
  description:
    "دليل تفصيلي خطوة بخطوة لإرسال الملفات مباشرة بين حاسوبين عبر الإنترنت — من الند للند، دون رفع إلى السحابة، دون تثبيت، ومشفَّر من الطرف إلى الطرف طوال الطريق.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إرسال ملف إلى حاسوب آخر يعني عادةً رفعه إلى مكان ما أولًا — قرص سحابي، مرفق بريد إلكتروني، تطبيق محادثة — والأمل في أن يتمكن المُستقبِل من إخراجه مجددًا. يتخطى Relayium هذه الخطوة: فهو يربط متصفحك مباشرةً بمتصفح الطرف الآخر، أينما كان في العالم، ويبث الملف عبره مباشرةً.",
    "يغطي هذا الدليل كلتا الحالتين — حاسوبان على نفس الشبكة، وحاسوبان على شبكتين مختلفتين تمامًا (منازل، مكاتب، بلدان مختلفة) — ويوضح بالضبط ما يحتاج كل طرف إلى فعله.",
  ],
  sections: [
    {
      heading: "النهج المباشر: لا سحابة في المنتصف",
      body: [
        "يعمل Relayium بالكامل داخل المتصفح على relayium.com. لا شيء يُثبَّت على أي من الجهازين، ولا يقف أي تخزين تابع لطرف ثالث بينك وبين المُستقبِل: ينتقل الملف من متصفح إلى آخر ولا يُكتب أبدًا على أي خادم — ولا حتى حين تفرض الشبكتان مرور التدفق عبر مُرحِّل، فهو يمرّر البايتات فحسب، بلا نسخة وبلا مفتاح.",
        "هذا مهم لسببين: السرعة (لا تُقيَّد بحصة الرفع/التنزيل لدى شخص آخر) والخصوصية (لا توجد نسخة من ملفك على خوادم شركة ما تنتظر أن تُطلب أو تُخترق أو تُنسى).",
      ],
    },
    {
      heading: "نفس الشبكة مقابل عبر الإنترنت",
      body: [
        "إذا كان الجهازان على نفس شبكة Wi-Fi أو الشبكة المحلية، يجدهما Relayium تلقائيًا — افتح relayium.com على كليهما، ولا حاجة إلى حساب على أي من الطرفين.",
        "إذا كان الجهازان على شبكتين مختلفتين — جهاز مكتبك في المنزل وحاسوب زميل محمول في مدينة أخرى، مثلًا — فلا يستطيع الاكتشاف التلقائي العبور عبر الإنترنت، لذا يستخدم Relayium بدلًا من ذلك رمز اقتران قصيرًا. الشخص الذي يُرسل يسجّل الدخول لإنشاء ذلك الرمز؛ أما الشخص الذي يستقبل فلا يحتاج أبدًا إلى حساب، سواء أدخل الرمز أو فتح الرابط الذي يولّده فحسب.",
      ],
    },
    {
      heading: "خطوة بخطوة: إرسال ملف عبر الإنترنت",
      body: [
        "إليك مسار النقل الكامل لحاسوبين على شبكتين مختلفتين:",
      ],
      bullets: [
        "على جهاز الإرسال، افتح relayium.com وسجّل الدخول.",
        "اختر الملفات أو المجلد المراد إرساله — حتى 1,000 ملف في الدفعة الواحدة. يُنشئ Relayium رمز اقتران من 6 محارف (ورابط انضمام/رمز QR مطابقًا له).",
        "شارك ذلك الرمز أو الرابط مع الطرف الآخر بأي طريقة مناسبة — اقرأه بصوت عالٍ، أرسله برسالة نصية، الصقه في المحادثة.",
        "على جهاز الاستقبال، افتح الرابط، أو افتح relayium.com وأدخل الرمز المؤلف من 6 محارف. لا حاجة لتسجيل الدخول على هذا الطرف.",
        "تعرض الشاشتان الآن نفس رمز التحقق القصير (SAS). تحقق من تطابقهما — يؤكد هذا أن الاتصال يجري حقًا بينكما أنتما الاثنين، دون أحد في المنتصف — ثم يبدأ النقل تلقائيًا.",
      ],
    },
    {
      heading: "عبر الشبكات: المُرحِّل المشفَّر",
      body: [
        "يتصل متصفحان على الشبكة نفسها ببعضهما مباشرةً. أمّا عبر الشبكات — حيث تحجب جدران الحماية المؤسسية وأنواع NAT الصارمة المسار المباشر عادةً — فيحمل Relayium التدفق المشفَّر عبر مُرحِّل TURN، فيتم الاتصال بموثوقية.",
        "لا يرى المُرحِّل سوى النص المُشفَّر أبدًا: فالملف مشفَّر من الطرف إلى الطرف (تبادل مفاتيح X25519 إضافةً إلى AES-256-GCM) قبل أن يغادر متصفح الإرسال أصلًا، لذا لا يمكن للمُرحِّل قراءته أكثر مما يستطيع أي حاسوب عشوائي على الإنترنت. وإذا انقطع الاتصال في منتصف الطريق، يُستأنف النقل بدلًا من البدء من جديد.",
      ],
    },
    {
      heading: "كم عدد الملفات، وما حجمها",
      body: [
        "يمكنك إرسال حتى 1,000 ملف في دفعة واحدة، بما في ذلك بنية المجلدات. لا يوجد حد أقصى للحجم من جهة الخادم — السقف العملي يحدده متصفح الاستقبال.",
        "المتصفح الذي يدعم واجهة File System Access — ‏Chrome أو Edge على الحاسوب — يبثّ البيانات الواردة مباشرةً إلى القرص، لذا فالملفات التي تبلغ عدة غيغابايت لا مشكلة فيها. أما Firefox وSafari فلا تملكان تلك الواجهة، فتُجمَّع الدفعة المستلمة فيهما بالذاكرة، وينبّهك Relayium قبل القبول متى تجاوزت نحو 256 ميغابايت: تقدير متحفّظ عن قصد لا حدٌّ مقيس، إذ يتوقف السقف الحقيقي على ذاكرة الجهاز ونظامه وما هو مفتوح غير ذلك. كما يُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256، لتعرف أن ما يصل مطابق للمُرسَل بايتًا ببايت.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل هو فعلًا من الند للند، أم يمرّ الملف عبر خادم؟",
        a: "هو من الند للند بالمعنى الذي يهم: يُبَث الملف من متصفح إلى آخر ولا يُخزَّن أبدًا على أي خادم. على الشبكة نفسها يتصل المتصفحان ببعضهما مباشرةً. أما النقل عبر الشبكات برمز اقتران فيحمله مُرحِّل TURN بحكم التصميم — وهو المسار الذي ينجح بموثوقية عبر جدران الحماية وأنواع NAT التي تحجب المسار المباشر عادةً — لكن ذلك المُرحِّل لا يمرّر إلا نصًا مُشفَّرًا أثناء العبور، ولا يرى الملف المقروء أبدًا.",
      },
      {
        q: "هل يحتاج كلا الشخصين إلى حساب؟",
        a: "لا. على نفس الشبكة، لا يحتاج أي من الطرفين إلى حساب. أما عبر شبكات مختلفة، فالشخص الذي يُرسل يسجّل الدخول لإنشاء رمز الاقتران — وهذا ما يتيح لـ Relayium إنشاء الرمز وإدارته — لكن الشخص الذي يستقبل لا يحتاج أبدًا إلى حساب، سواء أدخل الرمز أو فتح الرابط فحسب.",
      },
      {
        q: "هل يعمل عبر شبكات وبلدان مختلفة؟",
        a: "نعم. رمز الاقتران موجود تحديدًا لهذه الحالة: حاسوبان ليسا على نفس الشبكة المحلية، أينما كان كل منهما في العالم. وهذا المسار يمر عبر مُرحِّل TURN مشفَّر لا عبر وصلة مباشرة — فهو الذي ينجح بموثوقية حين تقف NAT وجدران الحماية في الطريق، ويقوم في ثانية أو ثانيتين بدل انتظار محاولات مباشرة تنتهي بالمهلة في الغالب الأعم.",
      },
      {
        q: "هل هناك حد لحجم الملف أو لعدد الملفات التي يمكنني إرسالها؟",
        a: "يمكنك إرسال حتى 1,000 ملف في دفعة واحدة. لا يفرض الخادم أي حد أقصى للحجم — الحد هو ما يستطيع متصفح الاستقبال التعامل معه: غير محدود عمليًا في Chrome أو Edge على الحاسوب (بثًّا إلى القرص)، بينما يحتفظ Firefox وSafari بالدفعة في الذاكرة، وينبّهك Relayium فوق نحو 256 ميغابايت. وهذه العتبة تقدير متحفّظ لا سقف صارم؛ أما السقف الحقيقي فيتوقف على الجهاز نفسه.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على كلا الجهازين وأرسل أول ملف لك عبر الإنترنت — دون رفع إلى السحابة، دون تثبيت، ودون أن يحتاج المُستقبِل أبدًا إلى حساب.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Enviar archivos entre dos ordenadores por Internet",
  description:
    "Una guía paso a paso para enviar archivos directamente entre dos ordenadores por Internet — de igual a igual, sin subir a la nube, sin instalar nada y cifrado de extremo a extremo de principio a fin.",
  updatedLabel: "Última actualización",
  lead: [
    "Enviar un archivo a otro ordenador suele significar subirlo primero a algún sitio — un disco en la nube, un adjunto de correo, una aplicación de chat — y esperar que el destinatario pueda recuperarlo. Relayium se salta ese paso: conecta tu navegador directamente con el suyo, esté donde esté en el mundo, y transmite el archivo directamente de un lado a otro.",
    "Esta guía cubre ambos casos — dos ordenadores en la misma red, y dos ordenadores en redes completamente distintas (distintas casas, oficinas, países) — y muestra exactamente qué debe hacer cada lado.",
  ],
  sections: [
    {
      heading: "El enfoque directo: sin nube en el medio",
      body: [
        "Relayium funciona por completo en el navegador, en relayium.com. No hay nada que instalar en ninguno de los dos ordenadores, y ningún almacenamiento de terceros se interpone entre tú y el destinatario: el archivo va de un navegador al otro y nunca se escribe en un servidor — ni siquiera cuando las dos redes obligan al flujo a pasar por un retransmisor, que se limita a reenviar los bytes, sin copia y sin clave.",
        "Eso importa por dos razones: velocidad (no te frena la cuota de subida/descarga de otra persona) y privacidad (no queda ninguna copia de tu archivo en los servidores de una empresa esperando a ser solicitada, filtrada u olvidada).",
      ],
    },
    {
      heading: "Misma red vs. a través de Internet",
      body: [
        "Si ambos ordenadores están en la misma Wi-Fi o red local, Relayium los encuentra automáticamente — abre relayium.com en los dos, y no hace falta cuenta en ninguno de los lados.",
        "Si los dos ordenadores están en redes distintas — tu ordenador de sobremesa en casa y el portátil de un colega al otro lado del país, por ejemplo — el descubrimiento automático no puede cruzar Internet, así que Relayium usa en su lugar un código de emparejamiento corto. La persona que envía inicia sesión para generar ese código; la persona que recibe nunca necesita una cuenta, ya sea que escriba el código o simplemente abra el enlace que este genera.",
      ],
    },
    {
      heading: "Paso a paso: enviar un archivo a través de Internet",
      body: [
        "Este es el flujo completo para dos ordenadores en redes distintas:",
      ],
      bullets: [
        "En el ordenador que envía, abre relayium.com e inicia sesión.",
        "Elige los archivos o la carpeta a enviar — hasta 1.000 archivos por lote. Relayium genera un código de emparejamiento de 6 caracteres (y un enlace/QR de unión que le corresponde).",
        "Comparte ese código o enlace con la otra persona como te resulte más cómodo — léelo en voz alta, mándalo por mensaje, pégalo en el chat.",
        "En el ordenador que recibe, abre el enlace, o abre relayium.com y escribe el código de 6 caracteres. En este lado no hace falta iniciar sesión.",
        "Ahora ambas pantallas muestran el mismo código de verificación corto (SAS). Comprueba que coincidan — esto confirma que la conexión es genuinamente entre las dos partes, sin nadie en el medio — y entonces la transferencia comienza automáticamente.",
      ],
    },
    {
      heading: "Entre redes: el retransmisor cifrado",
      body: [
        "Dos navegadores en la misma red se conectan directamente entre sí. Entre redes — donde los cortafuegos corporativos y los NAT estrictos bloquean habitualmente cualquier ruta directa — Relayium transporta el flujo cifrado por un retransmisor TURN, de modo que la conexión se establece de forma fiable.",
        "El retransmisor solo ve texto cifrado: el archivo se cifra de extremo a extremo (intercambio de claves X25519 más AES-256-GCM) antes de salir siquiera del navegador que envía, así que el retransmisor no puede leerlo más de lo que podría cualquier ordenador al azar en Internet. Si la conexión se corta a mitad de camino, la transferencia se reanuda en lugar de empezar de nuevo.",
      ],
    },
    {
      heading: "Cuántos archivos, y de qué tamaño",
      body: [
        "Puedes enviar hasta 1.000 archivos en un solo lote, incluida la estructura de carpetas. No hay límite de tamaño del lado del servidor — el tope práctico lo fija el navegador que recibe.",
        "Un navegador con la API File System Access — Chrome o Edge de escritorio — transmite los datos entrantes directamente al disco, así que los archivos de varios gigabytes no son problema. Firefox y Safari no tienen esa API, así que un lote recibido ahí se acumula en memoria y Relayium te avisa antes de que aceptes en cuanto se pasa de unos 256 MB: una estimación deliberadamente prudente y no un límite medido, ya que el techo real depende de la memoria de la máquina, de su sistema y de qué más esté abierto. Cada archivo también se verifica de extremo a extremo con un hash SHA-256, para que sepas que lo que llega es byte por byte lo que se envió.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Es realmente de igual a igual, o el archivo pasa por un servidor?",
        a: "Es de igual a igual en el sentido que importa: el archivo se transmite de un navegador al otro y nunca se almacena en un servidor. En la misma red, los dos navegadores se conectan directamente entre sí. Una transferencia entre redes con código de emparejamiento la lleva un retransmisor TURN por diseño — la vía que conecta de forma fiable a través de los cortafuegos y NAT que suelen bloquear cualquier ruta directa — pero ese retransmisor solo deja pasar texto cifrado en tránsito, nunca el archivo legible.",
      },
      {
        q: "¿Ambas personas necesitan una cuenta?",
        a: "No. En la misma red, ninguno de los lados necesita cuenta. Entre redes distintas, la persona que envía inicia sesión para crear el código de emparejamiento — eso es lo que permite a Relayium generar y gestionar el código — pero la persona que recibe nunca necesita cuenta, ya sea que escriba el código o simplemente abra el enlace.",
      },
      {
        q: "¿Funciona entre redes y países distintos?",
        a: "Sí. El código de emparejamiento existe precisamente para este caso: dos ordenadores que no están en la misma red local, esté donde esté cada uno en el mundo. Esa vía va por un retransmisor TURN cifrado en lugar de un enlace directo — es la que conecta de forma fiable cuando hay NAT y cortafuegos de por medio, y se establece en uno o dos segundos en vez de esperar intentos directos que casi siempre acabarían agotando el tiempo.",
      },
      {
        q: "¿Hay un límite de tamaño de archivo o de cuántos archivos puedo enviar?",
        a: "Puedes enviar hasta 1.000 archivos en un solo lote. No hay límite de tamaño impuesto por el servidor — el límite es lo que el navegador que recibe pueda manejar: prácticamente ilimitado en Chrome o Edge de escritorio (transmitido al disco), mientras que Firefox y Safari mantienen el lote en memoria, donde Relayium avisa por encima de unos 256 MB. Ese umbral es una estimación prudente, no un techo duro; el real depende de la máquina.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en ambos ordenadores y envía tu primer archivo a través de Internet — sin subir a la nube, sin instalar nada, y el destinatario nunca necesita una cuenta.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Enviar arquivos entre dois computadores pela Internet",
  description:
    "Um guia passo a passo para enviar arquivos diretamente entre dois computadores pela Internet — ponto a ponto, sem upload para a nuvem, sem instalação e com criptografia de ponta a ponta o tempo todo.",
  updatedLabel: "Última atualização",
  lead: [
    "Enviar um arquivo para outro computador normalmente significa enviá-lo primeiro para algum lugar — um drive na nuvem, um anexo de e-mail, um aplicativo de chat — e torcer para que o destinatário consiga recuperá-lo. O Relayium pula essa etapa: ele conecta o seu navegador diretamente ao dele, onde quer que ele esteja no mundo, e transmite o arquivo direto de um lado ao outro.",
    "Este guia cobre os dois casos — dois computadores na mesma rede, e dois computadores em redes completamente diferentes (casas, escritórios, países diferentes) — e mostra exatamente o que cada lado precisa fazer.",
  ],
  sections: [
    {
      heading: "A abordagem direta: sem nuvem no meio",
      body: [
        "O Relayium roda inteiramente no navegador, em relayium.com. Não há nada para instalar em nenhum dos dois computadores, e nenhum armazenamento de terceiros fica entre você e o destinatário: o arquivo vai de um navegador para o outro e nunca é gravado em um servidor — nem mesmo quando as duas redes obrigam o fluxo a passar por um retransmissor, que apenas repassa os bytes, sem cópia e sem chave.",
        "Isso importa por dois motivos: velocidade (você não fica limitado pela cota de upload/download de outra pessoa) e privacidade (nenhuma cópia do seu arquivo fica nos servidores de uma empresa esperando para ser solicitada, vazada ou esquecida).",
      ],
    },
    {
      heading: "Mesma rede vs. pela Internet",
      body: [
        "Se os dois computadores estiverem no mesmo Wi-Fi ou rede local, o Relayium os encontra automaticamente — abra relayium.com nos dois, e não é preciso conta em nenhum dos lados.",
        "Se os dois computadores estiverem em redes diferentes — o seu desktop em casa e o notebook de um colega do outro lado do país, por exemplo — a descoberta automática não consegue atravessar a Internet, então o Relayium usa em vez disso um código de emparelhamento curto. Quem envia faz login para gerar esse código; quem recebe nunca precisa de conta, seja digitando o código ou apenas abrindo o link que ele gera.",
      ],
    },
    {
      heading: "Passo a passo: enviar um arquivo pela Internet",
      body: [
        "Este é o fluxo completo para dois computadores em redes diferentes:",
      ],
      bullets: [
        "No computador que envia, abra relayium.com e faça login.",
        "Escolha os arquivos ou a pasta a enviar — até 1.000 arquivos por lote. O Relayium gera um código de emparelhamento de 6 caracteres (e um link/QR de entrada correspondente).",
        "Compartilhe esse código ou link com a outra pessoa da forma que for mais conveniente — leia em voz alta, mande por mensagem, cole no chat.",
        "No computador que recebe, abra o link, ou abra relayium.com e digite o código de 6 caracteres. Deste lado não é preciso fazer login.",
        "Agora as duas telas mostram o mesmo código de verificação curto (SAS). Confira se eles coincidem — isso confirma que a conexão é genuinamente entre as duas partes, sem ninguém no meio — e então a transferência começa automaticamente.",
      ],
    },
    {
      heading: "Entre redes: o retransmissor criptografado",
      body: [
        "Dois navegadores na mesma rede se conectam diretamente um ao outro. Entre redes — onde firewalls corporativos e NATs restritos bloqueiam rotineiramente qualquer caminho direto — o Relayium carrega o fluxo criptografado por um retransmissor TURN, para que a conexão se estabeleça de forma confiável.",
        "O retransmissor só vê texto cifrado: o arquivo é criptografado de ponta a ponta (troca de chaves X25519 mais AES-256-GCM) antes mesmo de sair do navegador que envia, então o retransmissor não consegue lê-lo, assim como qualquer computador aleatório na Internet também não conseguiria. Se a conexão cair no meio do caminho, a transferência é retomada em vez de recomeçar.",
      ],
    },
    {
      heading: "Quantos arquivos, e de que tamanho",
      body: [
        "Você pode enviar até 1.000 arquivos em um único lote, incluindo a estrutura de pastas. Não há limite de tamanho do lado do servidor — o teto prático é definido pelo navegador que recebe.",
        "Um navegador com a API File System Access — Chrome ou Edge no computador — transmite os dados recebidos direto para o disco, então arquivos de vários gigabytes não são problema. Firefox e Safari não têm essa API, então um lote recebido neles é montado na memória, e o Relayium avisa antes de você aceitar assim que passa de cerca de 256 MB: uma estimativa propositalmente conservadora, não um limite medido, já que o teto real depende da memória da máquina, do sistema e do que mais estiver aberto. Cada arquivo também é verificado de ponta a ponta com um hash SHA-256, para você saber que o que chega é, byte a byte, o que foi enviado.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "É realmente ponto a ponto, ou o arquivo passa por um servidor?",
        a: "É ponto a ponto no sentido que importa: o arquivo é transmitido de um navegador para o outro e nunca é armazenado em um servidor. Na mesma rede, os dois navegadores se conectam diretamente um ao outro. Já uma transferência entre redes por código de emparelhamento é carregada por um retransmissor TURN, por decisão de projeto — o caminho que conecta de forma confiável através dos firewalls e NATs que costumam bloquear qualquer rota direta — mas esse retransmissor só deixa passar texto cifrado em trânsito, nunca o arquivo legível.",
      },
      {
        q: "As duas pessoas precisam de conta?",
        a: "Não. Na mesma rede, nenhum dos lados precisa de conta. Entre redes diferentes, quem envia faz login para criar o código de emparelhamento — é o que permite ao Relayium gerar e gerenciar o código — mas quem recebe nunca precisa de conta, seja digitando o código ou apenas abrindo o link.",
      },
      {
        q: "Funciona entre redes e países diferentes?",
        a: "Sim. O código de emparelhamento existe justamente para este caso: dois computadores que não estão na mesma rede local, onde quer que cada um esteja no mundo. Esse caminho corre por um retransmissor TURN criptografado em vez de uma ligação direta — é o que conecta de forma confiável quando NATs e firewalls estão no meio, e sobe em um ou dois segundos em vez de esperar tentativas diretas que quase sempre acabariam em tempo esgotado.",
      },
      {
        q: "Há um limite de tamanho de arquivo ou de quantos arquivos posso enviar?",
        a: "Você pode enviar até 1.000 arquivos em um único lote. Não há limite de tamanho imposto pelo servidor — o limite é o que o navegador que recebe consegue lidar: praticamente ilimitado no Chrome ou Edge de computador (transmitido para o disco), enquanto Firefox e Safari mantêm o lote na memória, onde o Relayium avisa acima de cerca de 256 MB. Esse limiar é uma estimativa conservadora, não um teto rígido; o real depende da máquina.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium nos dois computadores e envie seu primeiro arquivo pela Internet — sem upload para a nuvem, sem instalação, e o destinatário nunca precisa de conta.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/send-files-between-two-computers-over-the-internet",
  published: "2026-07-09",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
