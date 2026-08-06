// web/scripts/pages/content/articles/howto-send-files-between-computers.mjs
// How-to: send files between two computers over the internet — the browser
// cross-network pairing-code flow, generalized (device-agnostic, unlike the
// PC-to-phone how-to). English is the master; zh/ja/ko/de/fr follow the same
// structure with identical facts. Terminology mirrors src/lib/i18n/en.ts
// (crossnet.*, pair.*, methods.realtime.*) and CodePairing.svelte / ice.ts.

const en = {
  title: "Send files between two computers over the internet",
  description:
    "A step-by-step guide to browser-to-browser file transfer: direct on the same LAN, or end-to-end encrypted over TURN across networks, with no cloud upload or install.",
  updatedLabel: "Last updated",
  lead: [
    "Sending a file to another computer usually means uploading it somewhere first — a cloud drive, an email attachment, a chat app — and hoping the recipient can get it back out again. Relayium skips that storage step: browsers connect directly on the same LAN, while cross-network transfers use a TURN relay that carries only end-to-end encrypted ciphertext and keeps no server-side realtime content copy or history.",
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
        "If the two computers are on different networks — your desktop at home and a colleague's laptop across the country, for instance — automatic discovery cannot reach across the internet, so Relayium uses a short pairing code instead. The person sending signs in to mint that code; the person receiving never needs an account, whether they type the code in or just open the link it generates. The code is good for five minutes, so have both devices in front of you before you generate one.",
      ],
    },
    {
      heading: "Step by step: send a file across the internet",
      body: [
        "Here is the full flow for two computers on different networks:",
      ],
      prereqs: {
        label: "Before you start",
        items: [
          "A signed-in account on the sending computer only. Minting a pairing code needs one; the computer that joins by code or link never signs in.",
          "A verified email address on that account. Relay for a cross-network session is only issued to verified accounts, and the pairing card says so plainly when it refuses.",
          "Both of you at your computers at the same time. A pairing code lives five minutes, and this is one live session rather than an upload someone collects later.",
          "A way to pass six digits or a link out of band — a phone call, a chat window, a text message.",
        ],
      },
      steps: [
        {
          text: "On the sending computer, open the realtime transfer page and sign in.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Pick the files or the folder to send — up to 1,000 files per batch — and create the pairing code. The card then shows the six digits, a copy-link button, a QR code, and a countdown.",
          code: ["Your pairing code — read it to the other person\n483920\npairing code expires in 4:52"],
        },
        {
          text: "Pass the code or the link to the other person however is convenient — read it out, text it, paste it in chat. The link carries the same code in its fragment, so sharing either one is the same act.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "On the receiving computer, open that link, or open the same page, type the six digits and press “Connect”. There is no sign-in on this side.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "The transfer starts once the other device joins. Leave both tabs open until the file counter reaches the end: the countdown governs new joins only, so it stopping does not cut a transfer that is already running. Turning on “Advanced verification” before you start adds a verification code (SAS) to compare — a match confirms the keys were not replaced and both computers joined the same end-to-end encrypted session; it does not prove which network path carries the ciphertext.",
        },
      ],
      success: {
        label: "What a working transfer looks like",
        body: [
          "The sender's “Waiting for the other device to join…” line is replaced by the connected card, and the path badge on it reads “Relayed”. That is the expected value here rather than a fault: a cross-network browser session goes over the encrypted TURN relay by design, and “LAN direct” is what you would see only if the two computers turned out to share a network after all.",
          "The file counter then runs to the last file of the batch on both screens, and the file itself is wherever the line under the request said the receiving browser would put it.",
        ],
        code: ["Relayed\nFile 1/1"],
      },
    },
    {
      heading: "When the code is refused, or the transfer stops",
      body: [
        "A cross-network transfer has more moving parts than a same-network one — a code with a life span, an account, a relay allowance — and each of them says which it is on the pairing card rather than failing silently. Read that card first.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The receiving computer types the code and gets “Pairing code is invalid or expired”.",
            code: ["https://relayium.com/cross-network   # the sender's card shows the live countdown"],
            fix: "Five minutes have passed since it was minted, or a digit was mistyped. Create a fresh code on the sending computer and have the other person enter it straight away — or send them the join link instead, which needs no typing at all.",
          },
          {
            symptom: "The card says relay is only issued to verified accounts.",
            code: ["https://relayium.com/cross-network   # the pairing card names the reason it was refused"],
            fix: "The sender's email address has not been verified yet. Open the account panel, verify the address from the email Relayium sent, then create a new pairing code — the old one cannot pick up a relay it was already refused. Same-network transfers and the CLI are unaffected by this.",
          },
          {
            symptom: "The card says this month's relay traffic is used up.",
            code: ["https://relayium.com/me   # “This month's usage” shows what is left of the relay allowance"],
            fix: "Cross-network browser sessions cannot start or continue until the allowance resets next month. To send now, upload the files as a stored download link at https://relayium.com/offline-transfer, upgrade the plan, or run your own node; same-network transfers keep working either way.",
          },
          {
            symptom: "The transfer stops part way and does not resume.",
            code: ["https://relayium.com/cross-network   # both tabs have to still be on this page"],
            fix: "This is one live session, so a temporary network drop can resume where it left off, but closing the tab or reloading the page ends it and there is no server-side copy to pick up. Start again with a new code — and when the other person cannot stay online, use the async download link at https://relayium.com/offline-transfer instead.",
          },
          {
            symptom: "The transfer runs, but far slower than the same files on one network.",
            code: ["https://relayium.com/cross-network   # the path badge on the connected card reads Relayed"],
            fix: "A relayed session is bounded by both internet connections plus the relay hop, so it is genuinely slower than a LAN transfer and there is no setting that changes it. For a very large batch, the stored download link at https://relayium.com/offline-transfer is the calmer route, because it does not need both sides online at once.",
          },
        ],
      },
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
        a: "It is peer-to-peer in the sense that matters: the file streams browser to browser and is never stored on a server. On the same LAN the two browsers connect directly to each other. A cross-network pairing-code transfer uses TURN by design, but the relay only forwards end-to-end encrypted ciphertext in flight: it cannot read or decrypt the file and keeps no server-side realtime content copy or history.",
      },
      {
        q: "Do both people need an account?",
        a: "No. On the same network, neither side needs an account. Across different networks, the person sending signs in to create the pairing code — that's what lets Relayium mint and manage the code — but the person receiving never needs an account, whether they type in the code or just open the link.",
      },
      {
        q: "Does it work across different networks and countries?",
        a: "Yes. The pairing code exists specifically for this case: two computers that aren't on the same local network, wherever each one is in the world. That route runs over an encrypted TURN relay rather than a direct link, and it does so deliberately: Relayium takes the relay so that getting past NATs and firewalls never depends on a direct path being available.",
      },
      {
        q: "Is there a limit on file size or how many files I can send?",
        a: "You can send up to 1,000 files in a single batch. No Relayium server imposes a size cap, so the limits that remain are practical ones: Chrome or Edge on the desktop streams the batch straight to disk, and what bounds it there is the browser, the operating system, the free space on that disk and how long the live session stays up. Firefox and Safari hold the batch in memory instead, where Relayium warns you above roughly 256 MB — a cautious estimate rather than a hard ceiling; the real one depends on the machine.",
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
    "一步步教你用浏览器在两台电脑间传文件：同一局域网直连，跨网络则经 TURN 传送端到端加密密文；不用上传网盘，也不用安装软件。",
  updatedLabel: "最近更新",
  lead: [
    "给另一台电脑发文件，通常得先把它传到某个地方——网盘、邮件附件、聊天软件——然后指望对方能顺利取出来。Relayium 省掉了存储这一步：同一局域网内浏览器彼此直连；跨网络时则由 TURN 中继承载端到端加密密文，服务器端不保留实时内容副本或历史。",
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
        "如果两台电脑处于不同网络——比如你家里的台式机和同事在外地的笔记本——自动发现就没法跨越互联网了，这时 Relayium 改用一个短配对码。发送方需要登录才能生成这个码；接收方始终无需账号，无论是手动输入码还是直接打开它生成的链接。 配对码有效期 5 分钟，所以生成之前先把两台设备都准备好。",
      ],
    },
    {
      heading: "分步操作：跨互联网发送文件",
      body: [
        "以下是两台电脑处于不同网络时的完整流程：",
      ],
      prereqs: {
        label: "开始之前",
        items: [
          "只有发送方的电脑需要已登录账号。生成配对码需要账号；用码或链接加入的那台电脑全程不用登录。",
          "该账号的邮箱已验证。跨网络会话的中继只发给已验证的账号，被拒时配对卡片会明确写出原因。",
          "两个人同时守在各自电脑前。配对码有效期 5 分钟，而且这是一次实时会话，不是先上传、对方稍后再来取。",
          "一个能把六位数字或链接带外告诉对方的渠道——一通电话、一个聊天窗口、一条短信。",
        ],
      },
      steps: [
        {
          text: "在发送方的电脑上打开实时传输页面并登录。",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "选择要发送的文件或文件夹——每批最多 1,000 个文件——然后生成配对码。卡片上会显示这六位数字、一个复制链接的按钮、一个二维码，以及一个倒计时。",
          code: ["你的配对码 —— 念给对方\n483920\n配对码 4:52 后失效"],
        },
        {
          text: "用任意方便的方式把这个码或链接告诉对方——念出来、发短信、贴到聊天窗口都行。链接的片段里带的就是同一个码，所以发哪个都一样。",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "在接收方的电脑上打开那个链接，或者打开同一个页面，输入这六位数字并按「连接」。这一侧不需要登录。",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "对方加入后传输就开始了。让两个标签页都开着，直到文件计数走完：倒计时只管新设备能不能加入，它归零并不会掐断已经在跑的传输。开始前打开「高级验证」会多出一个可核对的校验码（SAS）——一致能确认密钥未被替换、两台电脑加入的是同一个端到端加密会话；它并不能证明密文走的是哪条网络路径。",
        },
      ],
      success: {
        label: "传输成功时是什么样",
        body: [
          "发送方那行「等待对方加入…」会被已连接的卡片取代，卡片上的路径标签显示「中继」。在这里这是预期值，而不是故障：跨网络的浏览器会话本来就刻意走加密的 TURN 中继；只有当两台电脑其实处于同一网络时，你才会看到「局域网直连」。",
          "随后两块屏幕上的文件计数都会走到这一批的最后一个文件，而文件本身就在请求下面那行所说的、接收方浏览器会放置的位置。",
        ],
        code: ["中继\n文件 1/1"],
      },
    },
    {
      heading: "配对码被拒绝，或者传输中断时",
      body: [
        "跨网络传输比同网络多几个活动部件——一个有寿命的码、一个账号、一份中继额度——而每一样出问题时，配对卡片都会写明是哪一样，而不是默默失败。所以先读那张卡片。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "接收方输入配对码后提示「配对码无效或已过期」。",
            code: ["https://relayium.com/cross-network   # 发送方卡片上有实时倒计时"],
            fix: "要么距离生成已经过了 5 分钟，要么有一位数字输错了。在发送方电脑上重新生成一个码，让对方立刻输入；或者干脆把加入链接发过去，那样根本不用手动输入。",
          },
          {
            symptom: "卡片提示中继只发给已验证的账号。",
            code: ["https://relayium.com/cross-network   # 配对卡片会写明被拒的原因"],
            fix: "发送方的邮箱地址还没有验证。打开账户面板，用 Relayium 发出的那封邮件完成验证，然后重新生成一个配对码——旧的那个拿不到已经被拒绝过的中继。同网络传输和 CLI 都不受此影响。",
          },
          {
            symptom: "卡片提示本月的中继流量已经用完。",
            code: ["https://relayium.com/me   # 「本月用量」里能看到中继额度还剩多少"],
            fix: "在额度于下个月重置之前，跨网络的浏览器会话既无法建立也无法继续。想现在就发，可以在 https://relayium.com/offline-transfer 把文件传成一个下载链接、升级套餐，或者自己跑一个节点；无论哪种情况，同网络传输都照常可用。",
          },
          {
            symptom: "传输传到一半停下，而且不再恢复。",
            code: ["https://relayium.com/cross-network   # 两个标签页都必须还停在这个页面上"],
            fix: "这是一次实时会话，所以网络短暂中断后可以从断点继续，但关掉标签页或刷新页面就意味着会话结束，服务器上也没有可供续传的副本。请用新的配对码重新开始——如果对方没法一直在线，就改用 https://relayium.com/offline-transfer 上的异步下载链接。",
          },
          {
            symptom: "传输能跑，但比同一网络下传同样的文件慢很多。",
            code: ["https://relayium.com/cross-network   # 已连接卡片上的路径标签显示「中继」"],
            fix: "走中继的会话受两端互联网连接加上中继这一跳共同限制，所以它确实比局域网传输慢，而且没有哪个设置能改变这一点。如果这一批特别大，https://relayium.com/offline-transfer 上的下载链接是更从容的路线，因为它不要求双方同时在线。",
          },
        ],
      },
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
        a: "在真正关键的那一点上，它就是点对点：文件从一个浏览器流向另一个浏览器，从不存储在服务器上。同一局域网内两个浏览器彼此直连；跨网络配对码传输则按设计使用 TURN。中继只转发端到端加密密文，无法读取或解密文件，也不保留服务器端实时内容副本或历史。",
      },
      {
        q: "双方都需要账号吗？",
        a: "不需要。同一网络下，双方都不需要账号。跨网络时，发送方需要登录才能生成配对码——这是 Relayium 生成和管理配对码所必需的——但接收方始终无需账号，无论对方是输入配对码还是直接打开链接。",
      },
      {
        q: "能跨不同网络甚至不同国家传输吗？",
        a: "可以。配对码正是为这种情况设计的：两台不在同一局域网的电脑，无论各自身处世界哪个角落都能连上。这条路径走的是加密 TURN 中继而不是直连，而且是刻意如此：Relayium 选择走中继，好让穿越 NAT 和防火墙这件事不必依赖于是否存在一条可用的直连路径。",
      },
      {
        q: "文件大小或数量有限制吗？",
        a: "一批最多可以发送 1,000 个文件。Relayium 的服务器端不设大小上限，剩下的都是实际层面的限制：桌面版 Chrome 或 Edge 会把整批文件直接流式写入磁盘，此时约束来自浏览器本身、操作系统、磁盘剩余空间，以及这次实时会话能维持多久。Firefox 和 Safari 则把整批文件放在内存里，超过约 256 MB 时 Relayium 会先提示你——这个阈值是保守估计而非硬性天花板，真正的上限要看那台机器。",
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
    "ブラウザ間でファイルを送る手順ガイド。同じ LAN では直接接続し、ネットワークをまたぐ場合は TURN でエンドツーエンド暗号文を運びます。クラウドへのアップロードもインストールも不要です。",
  updatedLabel: "最終更新",
  lead: [
    "別のパソコンにファイルを送るには、たいていまずどこかにアップロードして（クラウドドライブ、メールの添付、チャットアプリ）、相手が無事に取り出せることを願うことになります。Relayium はその保存手順を省きます。同じ LAN ではブラウザ同士が直接接続し、ネットワークをまたぐ転送は TURN リレーがエンドツーエンド暗号文だけを運び、サーバー側にリアルタイム内容のコピーや履歴を残しません。",
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
        "2台が別々のネットワークにある場合（たとえば自宅のデスクトップと遠方にいる同僚のノートPCなど）、自動発見はインターネットをまたげないため、Relayium は代わりに短いペアリングコードを使います。送信する側がサインインしてそのコードを発行し、受信する側はコードを入力するにせよ、生成されたリンクを開くにせよ、アカウントは一切不要です。 コードの有効期限は5分なので、生成する前に両方の端末を手元に用意してください。",
      ],
    },
    {
      heading: "手順：インターネット経由でファイルを送る",
      body: [
        "別々のネットワークにある2台のパソコンの場合の全体の流れです。",
      ],
      prereqs: {
        label: "始める前に",
        items: [
          "サインイン済みのアカウントが必要なのは送信側のパソコンだけです。ペアリングコードの発行にはアカウントが要りますが、コードやリンクで参加する側は最後までサインインしません。",
          "そのアカウントのメールアドレスが確認済みであること。ネットワークをまたぐセッションのリレーは確認済みアカウントにのみ発行され、断られた場合はペアリングカードにその理由がはっきり表示されます。",
          "2人が同時にそれぞれのパソコンの前にいること。ペアリングコードの寿命は5分で、これは相手が後から取りに来るアップロードではなく、1回のライブセッションです。",
          "6桁の数字かリンクを別経路で伝える手段。電話、チャットの画面、テキストメッセージなどです。",
        ],
      },
      steps: [
        {
          text: "送信側のパソコンでリアルタイム転送のページを開き、サインインします。",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "送るファイルまたはフォルダを選び（1 バッチ最大 1,000 ファイル）、ペアリングコードを作成します。カードには 6 桁の数字、リンクをコピーするボタン、QR コード、そしてカウントダウンが表示されます。",
          code: ["ペアリングコード — 相手に伝えてください\n483920\nペアリングコードは 4:52 で失効"],
        },
        {
          text: "そのコードやリンクを都合の良い方法で相手に伝えます。読み上げる、テキストメッセージで送る、チャットに貼り付けるなど。リンクはフラグメントに同じコードを載せているので、どちらを渡しても同じことです。",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "受信側のパソコンでそのリンクを開くか、同じページを開いて 6 桁の数字を入力し、「接続」を押します。こちら側にサインインはありません。",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "相手が参加すると転送が始まります。ファイルカウンターが終わるまで両方のタブを開いたままにしてください。カウントダウンが管理するのは新しい参加だけなので、それが尽きても進行中の転送が切れることはありません。開始前に「高度な検証」をオンにすると照合用の検証コード（SAS）が加わります。一致すれば、鍵がすり替えられず、2台が同じエンドツーエンド暗号化セッションに参加したことを確認しますが、暗号文がどのネットワーク経路を通るかを証明するものではありません。",
        },
      ],
      success: {
        label: "転送が成功したときの画面",
        body: [
          "送信側の「相手の参加を待っています…」の行が接続済みのカードに置き換わり、その経路バッジは「中継」と表示されます。ここではこれが期待どおりの値であり、不具合ではありません。ネットワークをまたぐブラウザセッションは設計上、暗号化された TURN リレーを通ります。「LAN直結」が出るのは、2台が実は同じネットワークにいた場合だけです。",
          "その後、両方の画面でファイルカウンターがそのバッチの最後のファイルまで進み、ファイル自体はリクエストの下の行が示した、受信側ブラウザの保存先にあります。",
        ],
        code: ["中継\nファイル 1/1"],
      },
    },
    {
      heading: "コードが拒否される、または転送が止まるとき",
      body: [
        "ネットワークをまたぐ転送は同一ネットワークより可動部が多く、寿命のあるコード、アカウント、リレーの割り当てが関わります。そのどれが原因でも、黙って失敗するのではなくペアリングカードがどれなのかを告げます。まずはそのカードを読んでください。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "受信側のパソコンがコードを入力すると「ペアリングコードが無効か期限切れです」と出る。",
            code: ["https://relayium.com/cross-network   # 送信側のカードに実時間のカウントダウンが出る"],
            fix: "発行から5分が過ぎたか、数字を打ち間違えたかのどちらかです。送信側のパソコンで新しいコードを作り、相手にすぐ入力してもらってください。あるいは参加リンクを送れば、入力そのものが不要になります。",
          },
          {
            symptom: "リレーは確認済みアカウントにのみ発行される、とカードに出る。",
            code: ["https://relayium.com/cross-network   # ペアリングカードが拒否の理由を示す"],
            fix: "送信側のメールアドレスがまだ確認されていません。アカウントパネルを開き、Relayium から届いたメールでアドレスを確認し、新しいペアリングコードを作成してください。すでに拒否された古いコードが後からリレーを受け取ることはありません。同一ネットワークの転送と CLI はこの影響を受けません。",
          },
          {
            symptom: "今月のリレー通信量を使い切った、とカードに出る。",
            code: ["https://relayium.com/me   # 「今月の使用量」でリレーの残りが分かる"],
            fix: "割り当てが翌月にリセットされるまで、ネットワークをまたぐブラウザセッションは開始も継続もできません。いま送りたい場合は https://relayium.com/offline-transfer でダウンロードリンクとしてアップロードする、プランを上げる、自分のノードを動かす、のいずれかです。いずれの場合も同一ネットワークの転送は使えます。",
          },
          {
            symptom: "転送が途中で止まり、再開しない。",
            code: ["https://relayium.com/cross-network   # 両方のタブがこのページに残っている必要がある"],
            fix: "これは1回のライブセッションなので、一時的な回線断からは続きを再開できますが、タブを閉じたりページを再読み込みしたりすると終了し、サーバー側に引き継げるコピーはありません。新しいコードでやり直してください。相手がオンラインを保てない場合は、https://relayium.com/offline-transfer の非同期ダウンロードリンクを使います。",
          },
          {
            symptom: "転送は動くが、同じファイルを同一ネットワークで送るよりずっと遅い。",
            code: ["https://relayium.com/cross-network   # 接続済みカードの経路バッジが「中継」になっている"],
            fix: "リレー経由のセッションは双方のインターネット回線とリレーの 1ホップに縛られるため、LAN 転送より実際に遅く、それを変える設定はありません。バッチが非常に大きい場合は、双方が同時にオンラインである必要のない https://relayium.com/offline-transfer のダウンロードリンクのほうが落ち着いた経路です。",
          },
        ],
      },
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
        a: "肝心な意味では P2P です。ファイルはブラウザからブラウザへ流れ、サーバーに保存されることはありません。同じ LAN では2つのブラウザが直接接続し、ネットワークをまたぐペアリングコード転送は設計上 TURN を使います。リレーが運ぶのはエンドツーエンド暗号文だけで、ファイルを読み取りも復号もできず、サーバー側にリアルタイム内容のコピーや履歴を残しません。",
      },
      {
        q: "双方ともアカウントが必要ですか？",
        a: "いいえ。同じネットワーク上では、どちらの側もアカウントは不要です。ネットワークをまたぐ場合、送信する側はペアリングコードを作成するためにサインインします（これは Relayium がコードを発行・管理するために必要です）。ですが受信する側は、コードを入力するにせよリンクを開くにせよ、アカウントは一切不要です。",
      },
      {
        q: "異なるネットワークや国をまたいでも使えますか？",
        a: "はい。ペアリングコードはまさにこのケースのために存在します。同じローカルネットワークにない2台のパソコンが、世界のどこにいてもつながります。その経路は直接接続ではなく暗号化された TURN リレーを通ります。これは意図的な設計です。Relayium はリレーを選ぶことで、NAT やファイアウォールの越え方が直接経路の有無に左右されないようにしています。",
      },
      {
        q: "ファイルサイズや送れるファイル数に制限はありますか？",
        a: "1バッチで最大1,000ファイルまで送れます。Relayium のサーバーがサイズ上限を課すことはなく、残るのは現実的な制約です。パソコン版の Chrome や Edge はバッチをそのままディスクへストリーミングするので、そこで効いてくるのはブラウザ自身、OS、そのディスクの空き容量、そしてライブセッションがどれだけ保つかです。Firefox や Safari はバッチをメモリに保持するため、およそ 256MB を超えると Relayium が警告します。この閾値は硬い天井ではなく控えめな目安で、本当の限界はその機械しだいです。",
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
    "브라우저 사이에서 파일을 보내는 단계별 가이드. 같은 LAN에서는 직접 연결하고, 네트워크를 넘을 때는 TURN으로 종단간 암호문을 전달합니다. 클라우드 업로드와 설치가 필요 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "다른 컴퓨터에 파일을 보내려면 보통 먼저 어딘가에 올려야 합니다 — 클라우드 드라이브, 메일 첨부, 채팅 앱 — 그리고 상대가 무사히 다시 꺼낼 수 있길 바라야 합니다. Relayium은 이 저장 단계를 건너뜁니다. 같은 LAN에서는 브라우저끼리 직접 연결하고, 네트워크를 넘는 전송은 TURN 릴레이가 종단간 암호문만 운반하며 서버 측에 실시간 내용 복사본이나 기록을 남기지 않습니다.",
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
        "두 컴퓨터가 서로 다른 네트워크에 있다면 — 예를 들어 집의 데스크톱과 먼 곳에 있는 동료의 노트북 — 자동 탐색은 인터넷을 넘어설 수 없으므로 Relayium은 대신 짧은 페어링 코드를 씁니다. 보내는 쪽이 로그인해서 그 코드를 발급받고, 받는 쪽은 코드를 입력하든 생성된 링크를 열든 계정이 전혀 필요 없습니다. 코드는 5분 동안만 유효하니, 만들기 전에 두 기기를 모두 곁에 두세요.",
      ],
    },
    {
      heading: "단계별로 따라 하기: 인터넷으로 파일 보내기",
      body: [
        "서로 다른 네트워크에 있는 두 컴퓨터의 전체 흐름은 다음과 같습니다.",
      ],
      prereqs: {
        label: "시작하기 전에",
        items: [
          "로그인한 계정은 보내는 쪽 컴퓨터에만 필요합니다. 페어링 코드를 만들려면 계정이 있어야 하지만, 코드나 링크로 참여하는 컴퓨터는 끝까지 로그인하지 않습니다.",
          "그 계정의 이메일 주소가 인증되어 있어야 합니다. 네트워크를 넘는 세션의 릴레이는 인증된 계정에만 발급되며, 거절되면 페어링 카드가 그 이유를 분명히 알려줍니다.",
          "두 사람이 같은 시간에 각자 컴퓨터 앞에 있어야 합니다. 페어링 코드는 5분 동안만 살아 있고, 이것은 나중에 가져가는 업로드가 아니라 한 번의 실시간 세션입니다.",
          "여섯 자리 숫자나 링크를 다른 경로로 전할 방법 — 통화, 채팅 창, 문자 메시지.",
        ],
      },
      steps: [
        {
          text: "보내는 쪽 컴퓨터에서 실시간 전송 페이지를 열고 로그인합니다.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "보낼 파일이나 폴더를 고르고(배치당 최대 1,000개) 페어링 코드를 만듭니다. 그러면 카드에 여섯 자리 숫자, 링크 복사 버튼, QR 코드, 그리고 남은 시간이 표시됩니다.",
          code: ["내 페어링 코드 — 상대에게 알려주세요\n483920\n페어링 코드는 4:52 후 만료"],
        },
        {
          text: "그 코드나 링크를 편한 방법으로 상대에게 전달합니다 — 불러주거나, 문자로 보내거나, 채팅에 붙여넣거나. 링크의 프래그먼트에 같은 코드가 담겨 있으므로 어느 쪽을 보내든 같은 일입니다.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "받는 쪽 컴퓨터에서 그 링크를 열거나, 같은 페이지를 열고 여섯 자리 숫자를 입력한 뒤 “연결”을 누릅니다. 이쪽은 로그인이 없습니다.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "상대가 참여하면 전송이 시작됩니다. 파일 카운터가 끝날 때까지 두 탭을 열어 두세요. 남은 시간은 새 참여만 관장하므로, 그것이 다해도 이미 진행 중인 전송이 끊기지는 않습니다. 시작 전에 “고급 검증”을 켜면 대조할 검증 코드(SAS)가 더해집니다. 일치하면 키가 바뀌지 않았고 두 컴퓨터가 같은 종단간 암호화 세션에 참여했음을 확인하지만, 암호문이 어떤 네트워크 경로를 지나는지 증명하지는 않습니다.",
        },
      ],
      success: {
        label: "전송이 잘될 때의 화면",
        body: [
          "보내는 쪽의 “상대 기기의 참여를 기다리는 중…” 줄이 연결된 카드로 바뀌고, 그 경로 배지는 “릴레이”를 가리킵니다. 여기서는 그것이 고장이 아니라 예상된 값입니다. 네트워크를 넘는 브라우저 세션은 설계상 암호화된 TURN 릴레이를 지나며, “LAN 직접”이 보인다면 두 컴퓨터가 사실 같은 네트워크에 있었다는 뜻입니다.",
          "그다음 두 화면의 파일 카운터가 그 배치의 마지막 파일까지 가고, 파일 자체는 요청 아래 줄이 말한 대로 받는 브라우저가 두는 자리에 있습니다.",
        ],
        code: ["릴레이\n파일 1/1"],
      },
    },
    {
      heading: "코드가 거부되거나 전송이 멈출 때",
      body: [
        "네트워크를 넘는 전송은 같은 네트워크보다 움직이는 부품이 많습니다 — 수명이 있는 코드, 계정, 릴레이 할당량. 그리고 어느 것이 문제든 조용히 실패하는 대신 페어링 카드가 무엇인지 말해 줍니다. 먼저 그 카드를 읽으세요.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "받는 쪽 컴퓨터가 코드를 입력하면 “페어링 코드가 잘못되었거나 만료되었습니다”가 뜹니다.",
            code: ["https://relayium.com/cross-network   # 보내는 쪽 카드에 실시간 남은 시간이 보인다"],
            fix: "발급된 지 5분이 지났거나 숫자 하나를 잘못 입력한 것입니다. 보내는 쪽 컴퓨터에서 새 코드를 만들고 상대가 곧바로 입력하게 하세요. 아니면 참여 링크를 보내면 입력 자체가 필요 없습니다.",
          },
          {
            symptom: "릴레이는 인증된 계정에만 발급된다고 카드에 나옵니다.",
            code: ["https://relayium.com/cross-network   # 페어링 카드가 거절 이유를 알려준다"],
            fix: "보내는 쪽 이메일 주소가 아직 인증되지 않았습니다. 계정 패널을 열어 Relayium이 보낸 메일로 주소를 인증한 다음 새 페어링 코드를 만드세요. 이미 거절된 코드가 나중에 릴레이를 받지는 못합니다. 같은 네트워크 전송과 CLI는 이 영향을 받지 않습니다.",
          },
          {
            symptom: "이번 달 릴레이 트래픽을 다 썼다고 카드에 나옵니다.",
            code: ["https://relayium.com/me   # “이번 달 사용량”에 릴레이 잔여량이 보인다"],
            fix: "할당량이 다음 달에 초기화될 때까지 네트워크를 넘는 브라우저 세션은 시작도 계속도 되지 않습니다. 지금 보내려면 https://relayium.com/offline-transfer 에서 다운로드 링크로 올리거나, 요금제를 올리거나, 자체 노드를 돌리세요. 어느 쪽이든 같은 네트워크 전송은 그대로 됩니다.",
          },
          {
            symptom: "전송이 중간에 멈추고 다시 이어지지 않습니다.",
            code: ["https://relayium.com/cross-network   # 두 탭이 이 페이지에 그대로 있어야 한다"],
            fix: "이것은 한 번의 실시간 세션이라, 일시적인 회선 끊김에서는 이어받을 수 있지만 탭을 닫거나 새로고침하면 세션이 끝나고 이어받을 서버 사본도 없습니다. 새 코드로 다시 시작하세요. 상대가 계속 온라인일 수 없다면 https://relayium.com/offline-transfer 의 비동기 다운로드 링크를 쓰세요.",
          },
          {
            symptom: "전송은 되지만 같은 파일을 한 네트워크에서 보낼 때보다 훨씬 느립니다.",
            code: ["https://relayium.com/cross-network   # 연결된 카드의 경로 배지가 “릴레이”로 되어 있다"],
            fix: "릴레이를 거치는 세션은 양쪽 인터넷 회선과 릴레이 한 홉에 묶이므로 LAN 전송보다 실제로 느리고, 그것을 바꾸는 설정은 없습니다. 배치가 아주 크다면 양쪽이 동시에 온라인일 필요가 없는 https://relayium.com/offline-transfer 의 다운로드 링크가 더 느긋한 경로입니다.",
          },
        ],
      },
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
        a: "중요한 의미에서는 P2P가 맞습니다. 파일은 브라우저에서 브라우저로 흐르며 서버에 저장되지 않습니다. 같은 LAN에서는 두 브라우저가 직접 연결되고, 네트워크를 넘는 페어링 코드 전송은 설계상 TURN을 사용합니다. 릴레이는 종단간 암호문만 전달하므로 파일을 읽거나 복호화할 수 없고, 서버 측에 실시간 내용 복사본이나 기록을 보관하지 않습니다.",
      },
      {
        q: "양쪽 모두 계정이 필요한가요?",
        a: "아니요. 같은 네트워크에서는 양쪽 다 계정이 필요 없습니다. 네트워크를 넘나들 때는 보내는 쪽이 페어링 코드를 만들기 위해 로그인해야 합니다 — 이는 Relayium이 코드를 발급하고 관리하는 데 필요한 절차입니다 — 하지만 받는 쪽은 코드를 입력하든 링크를 열든 계정이 전혀 필요 없습니다.",
      },
      {
        q: "서로 다른 네트워크나 나라를 넘나들어도 되나요?",
        a: "네. 페어링 코드는 바로 이런 경우를 위한 것입니다. 같은 로컬 네트워크에 있지 않은 두 컴퓨터가 세상 어디에 있든 연결됩니다. 그 경로는 직접 연결이 아니라 암호화된 TURN 릴레이를 지나며, 이는 의도된 설계입니다. Relayium이 릴레이를 택하는 덕분에 NAT와 방화벽을 넘는 일이 직접 경로가 열려 있는지에 좌우되지 않습니다.",
      },
      {
        q: "파일 크기나 개수에 제한이 있나요?",
        a: "한 배치에 최대 1,000개의 파일을 보낼 수 있습니다. Relayium 서버가 강제하는 크기 상한은 없고, 남는 것은 현실적인 한계들입니다. 데스크톱 Chrome이나 Edge는 묶음을 곧장 디스크로 스트리밍하므로 거기서 한계를 정하는 것은 브라우저 자체, 운영체제, 그 디스크의 남은 공간, 그리고 실시간 세션이 얼마나 오래 유지되는지입니다. Firefox와 Safari는 묶음을 메모리에 담기 때문에 대략 256MB를 넘으면 Relayium이 경고합니다. 이 기준선은 고정된 천장이 아니라 보수적으로 잡은 값이며, 진짜 한계는 그 컴퓨터에 달려 있습니다.",
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
    "Eine Schritt-für-Schritt-Anleitung für Browser-zu-Browser-Dateien: im selben LAN direkt, netzübergreifend Ende-zu-Ende-verschlüsselt über TURN — ohne Cloud-Upload oder Installation.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Eine Datei an einen anderen Computer zu senden bedeutet normalerweise, sie zuerst irgendwohin hochzuladen — eine Cloud, einen E-Mail-Anhang, eine Chat-App — und zu hoffen, dass der Empfänger sie wieder herunterbekommt. Relayium überspringt diesen Speicherschritt: Im selben LAN verbinden sich die Browser direkt; netzübergreifend trägt ein TURN-Relay nur Ende-zu-Ende-verschlüsselten Chiffretext und behält weder eine serverseitige Echtzeitkopie noch einen Verlauf.",
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
        "Sind die beiden Computer in unterschiedlichen Netzwerken — dein Desktop zu Hause und der Laptop einer Kollegin am anderen Ende des Landes, zum Beispiel — kann die automatische Erkennung das Internet nicht überbrücken, also nutzt Relayium stattdessen einen kurzen Pairing-Code. Der Absender meldet sich an, um diesen Code zu erzeugen; der Empfänger braucht nie ein Konto, egal ob er den Code eingibt oder einfach den erzeugten Link öffnet. Der Code gilt fünf Minuten — halte beide Geräte bereit, bevor du einen erzeugst.",
      ],
    },
    {
      heading: "Schritt für Schritt: eine Datei über das Internet senden",
      body: [
        "So läuft der komplette Vorgang für zwei Computer in unterschiedlichen Netzwerken ab:",
      ],
      prereqs: {
        label: "Bevor du anfängst",
        items: [
          "Ein angemeldetes Konto nur auf dem sendenden Computer. Einen Pairing-Code zu erzeugen braucht eines; der Computer, der per Code oder Link beitritt, meldet sich nie an.",
          "Eine bestätigte E-Mail-Adresse auf diesem Konto. Ein Relay für eine netzübergreifende Sitzung wird nur an bestätigte Konten ausgegeben, und die Pairing-Karte sagt das klar, wenn sie es verweigert.",
          "Ihr beide gleichzeitig an euren Computern. Ein Pairing-Code lebt fünf Minuten, und das hier ist eine Live-Sitzung und kein Upload, den jemand später abholt.",
          "Ein Weg, sechs Ziffern oder einen Link auf anderem Kanal zu übergeben — ein Telefonat, ein Chatfenster, eine SMS.",
        ],
      },
      steps: [
        {
          text: "Öffne auf dem sendenden Computer die Seite für Echtzeitübertragung und melde dich an.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Wähle die zu sendenden Dateien oder den Ordner aus — bis zu 1.000 Dateien pro Stapel — und erzeuge den Pairing-Code. Die Karte zeigt dann die sechs Ziffern, einen Knopf zum Kopieren des Links, einen QR-Code und einen Countdown.",
          code: ["Dein Pairing-Code — sag ihn der anderen Person\n483920\nPairing-Code läuft in 4:52 ab"],
        },
        {
          text: "Gib Code oder Link auf beliebige, bequeme Weise an die andere Person weiter — vorlesen, per SMS schicken, in den Chat einfügen. Der Link trägt denselben Code in seinem Fragment, beides zu teilen ist also dieselbe Handlung.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "Öffne auf dem empfangenden Computer diesen Link, oder öffne dieselbe Seite, tippe die sechs Ziffern ein und drücke „Verbinden“. Auf dieser Seite gibt es keine Anmeldung.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Sobald das andere Gerät beitritt, startet die Übertragung. Lass beide Tabs offen, bis der Dateizähler durch ist: Der Countdown regelt nur neue Beitritte, sein Ablaufen kappt also keine laufende Übertragung. Schaltest du vor dem Start „Erweiterte Verifizierung“ ein, kommt ein Verifizierungscode (SAS) zum Vergleichen hinzu — Übereinstimmung bestätigt, dass die Schlüssel nicht ausgetauscht wurden und beide Computer derselben Ende-zu-Ende-verschlüsselten Sitzung beigetreten sind; welchen Netzwerkpfad der Chiffretext nimmt, beweist sie nicht.",
        },
      ],
      success: {
        label: "So sieht eine funktionierende Übertragung aus",
        body: [
          "Die Zeile „Warte darauf, dass das andere Gerät beitritt…“ wird durch die verbundene Karte ersetzt, und ihr Pfad-Abzeichen zeigt „Über Relay“. Das ist hier der erwartete Wert und kein Fehler: Eine netzübergreifende Browser-Sitzung läuft von Grund auf über das verschlüsselte TURN-Relay, und „LAN direkt“ sähest du nur, wenn die beiden Computer sich doch ein Netz teilen.",
          "Danach läuft der Dateizähler auf beiden Bildschirmen bis zur letzten Datei des Stapels, und die Datei selbst liegt dort, wo die Zeile unter der Anfrage es für den empfangenden Browser angekündigt hat.",
        ],
        code: ["Über Relay\nDatei 1/1"],
      },
    },
    {
      heading: "Wenn der Code abgelehnt wird oder die Übertragung stehen bleibt",
      body: [
        "Eine netzübergreifende Übertragung hat mehr bewegliche Teile als eine im selben Netz — einen Code mit Lebensdauer, ein Konto, ein Relay-Kontingent — und jedes davon nennt sich auf der Pairing-Karte beim Namen, statt still zu scheitern. Lies also zuerst diese Karte.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Der empfangende Computer tippt den Code ein und bekommt „Pairing-Code ist ungültig oder abgelaufen“.",
            code: ["https://relayium.com/cross-network   # die Karte des Senders zeigt den laufenden Countdown"],
            fix: "Seit dem Erzeugen sind fünf Minuten vergangen, oder eine Ziffer war vertippt. Erzeuge auf dem sendenden Computer einen frischen Code und lass ihn die andere Person sofort eingeben — oder schick gleich den Beitrittslink, dann ist gar nichts zu tippen.",
          },
          {
            symptom: "Auf der Karte steht, ein Relay gehe nur an bestätigte Konten.",
            code: ["https://relayium.com/cross-network   # die Pairing-Karte nennt den Grund der Absage"],
            fix: "Die E-Mail-Adresse der sendenden Seite ist noch nicht bestätigt. Öffne den Kontobereich, bestätige die Adresse über die Mail von Relayium und erzeuge dann einen neuen Pairing-Code — der alte holt sich kein Relay mehr, das ihm schon verweigert wurde. Übertragungen im selben Netz und die CLI sind davon unberührt.",
          },
          {
            symptom: "Auf der Karte steht, das Relay-Volumen dieses Monats sei aufgebraucht.",
            code: ["https://relayium.com/me   # „Nutzung diesen Monat“ zeigt den Rest des Relay-Kontingents"],
            fix: "Netzübergreifende Browser-Sitzungen können weder starten noch weiterlaufen, bis das Kontingent nächsten Monat zurückgesetzt wird. Um jetzt zu senden, lade die Dateien unter https://relayium.com/offline-transfer als Download-Link hoch, wechsle den Tarif, oder betreib einen eigenen Node; Übertragungen im selben Netz laufen so oder so weiter.",
          },
          {
            symptom: "Die Übertragung bleibt auf halbem Weg stehen und läuft nicht weiter.",
            code: ["https://relayium.com/cross-network   # beide Tabs müssen noch auf dieser Seite stehen"],
            fix: "Das ist eine Live-Sitzung: Ein kurzer Netzausfall kann fortsetzen, aber den Tab zu schließen oder die Seite neu zu laden beendet sie, und es gibt keine serverseitige Kopie zum Weitermachen. Fang mit einem neuen Code an — und wenn die andere Person nicht online bleiben kann, nimm den Download-Link unter https://relayium.com/offline-transfer.",
          },
          {
            symptom: "Die Übertragung läuft, aber viel langsamer als dieselben Dateien in einem Netz.",
            code: ["https://relayium.com/cross-network   # das Pfad-Abzeichen der verbundenen Karte zeigt Über Relay"],
            fix: "Eine Sitzung über das Relay ist durch beide Internetleitungen plus den Relay-Sprung begrenzt, sie ist also tatsächlich langsamer als eine LAN-Übertragung, und keine Einstellung ändert das. Für einen sehr großen Stapel ist der Download-Link unter https://relayium.com/offline-transfer der ruhigere Weg, weil dabei nicht beide Seiten gleichzeitig online sein müssen.",
          },
        ],
      },
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
        a: "In dem Sinn, auf den es ankommt, ja: Die Datei wird von Browser zu Browser gestreamt und nie auf einem Server gespeichert. Im selben LAN verbinden sich die Browser direkt; netzübergreifend nutzt der Pairing-Code TURN. Das Relay leitet nur Ende-zu-Ende-verschlüsselten Chiffretext weiter, kann die Datei weder lesen noch entschlüsseln und behält weder eine serverseitige Echtzeitkopie noch einen Verlauf.",
      },
      {
        q: "Brauchen beide Seiten ein Konto?",
        a: "Nein. Im selben Netzwerk braucht keine der beiden Seiten ein Konto. Über Netzwerke hinweg meldet sich die sendende Person an, um den Pairing-Code zu erzeugen — das braucht Relayium, um den Code zu vergeben und zu verwalten —, aber die empfangende Person braucht nie ein Konto, egal ob sie den Code eingibt oder nur den Link öffnet.",
      },
      {
        q: "Funktioniert das über verschiedene Netzwerke und Länder hinweg?",
        a: "Ja. Genau dafür gibt es den Pairing-Code: Zwei Computer, die nicht im selben lokalen Netzwerk sind, egal wo auf der Welt sie stehen. Dieser Weg läuft über ein verschlüsseltes TURN-Relay statt über eine direkte Verbindung, und zwar absichtlich: Relayium nimmt das Relay, damit das Durchkommen durch NATs und Firewalls nicht davon abhängt, ob ein direkter Pfad überhaupt zustande käme.",
      },
      {
        q: "Gibt es eine Grenze bei Dateigröße oder -anzahl?",
        a: "Du kannst bis zu 1.000 Dateien in einem einzigen Stapel senden. Kein Relayium-Server erzwingt eine Größenbegrenzung; was bleibt, sind praktische Grenzen: Chrome oder Edge auf dem Desktop streamt den Stapel direkt auf die Festplatte, und dort begrenzen ihn der Browser, das Betriebssystem, der freie Platz auf dieser Festplatte und wie lange die Live-Sitzung durchhält. Firefox und Safari halten den Stapel stattdessen im Arbeitsspeicher, wo Relayium ab etwa 256 MB warnt. Dieser Schwellenwert ist eine vorsichtige Schätzung und keine harte Obergrenze; die echte hängt vom Rechner ab.",
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
    "Un guide pas à pas pour transférer des fichiers de navigateur à navigateur : liaison directe sur le même LAN, ou relais TURN chiffré de bout en bout entre réseaux, sans cloud ni installation.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Envoyer un fichier à un autre ordinateur signifie généralement le téléverser quelque part au préalable — un cloud, une pièce jointe d'e-mail, une appli de messagerie — puis espérer que le destinataire pourra le récupérer. Relayium saute cette étape de stockage : sur le même LAN, les navigateurs se connectent directement ; entre réseaux, un relais TURN ne porte que du texte chiffré de bout en bout et ne conserve ni copie côté serveur ni historique temps réel.",
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
        "Si les deux ordinateurs sont sur des réseaux différents — votre ordinateur de bureau chez vous et le portable d'une collègue à l'autre bout du pays, par exemple — la découverte automatique ne peut pas traverser Internet, donc Relayium utilise à la place un court code d'appairage. La personne qui envoie se connecte pour générer ce code ; la personne qui reçoit n'a jamais besoin de compte, qu'elle saisisse le code ou ouvre simplement le lien généré. Le code est valable cinq minutes : ayez les deux appareils sous la main avant d'en générer un.",
      ],
    },
    {
      heading: "Étape par étape : envoyer un fichier par Internet",
      body: [
        "Voici le déroulé complet pour deux ordinateurs sur des réseaux différents :",
      ],
      prereqs: {
        label: "Avant de commencer",
        items: [
          "Un compte connecté sur le seul ordinateur qui envoie. Créer un code d'appairage en exige un, tandis que l'ordinateur qui rejoint par code ou par lien ne se connecte jamais.",
          "Une adresse e-mail vérifiée sur ce compte. Le relais d'une session entre réseaux n'est délivré qu'aux comptes vérifiés, et la carte d'appairage le dit clairement lorsqu'elle refuse.",
          "Vous deux devant vos ordinateurs en même temps. Un code d'appairage vit cinq minutes, et il s'agit d'une session en direct, pas d'un envoi que quelqu'un récupère plus tard.",
          "Un moyen de transmettre six chiffres ou un lien par un autre canal — un appel, une fenêtre de discussion, un SMS.",
        ],
      },
      steps: [
        {
          text: "Sur l'ordinateur qui envoie, ouvrez la page de transfert en temps réel et connectez-vous.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Choisissez les fichiers ou le dossier à envoyer, puis créez le code d'appairage. La carte affiche alors les six chiffres, un bouton pour copier le lien, un code QR et un décompte.",
          code: ["Votre code d'appairage — communiquez-le à l'autre personne\n483920\nle code d'appairage expire dans 4:52"],
        },
        {
          text: "Transmettez ce code ou ce lien à l'autre personne comme cela vous arrange. Le lien porte le même code dans son fragment, partager l'un ou l'autre revient donc exactement au même.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "Sur l'ordinateur qui reçoit, ouvrez ce lien, ou ouvrez la même page, saisissez les six chiffres et appuyez sur « Connecter ». Aucune connexion de ce côté.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Le transfert démarre dès que l'autre appareil rejoint la session. Laissez les deux onglets ouverts jusqu'à la fin du compteur : le décompte ne régit que les nouvelles arrivées, son expiration ne coupe donc pas un transfert déjà lancé. Activer « Vérification avancée » avant de commencer ajoute un code de vérification (SAS) à comparer, dont la concordance confirme que les clés n'ont pas été substituées et que les deux ordinateurs ont rejoint la même session chiffrée de bout en bout, sans prouver le chemin réseau suivi par le texte chiffré. Jusqu'à 1 000 fichiers par lot.",
        },
      ],
      success: {
        label: "À quoi ressemble un transfert qui marche",
        body: [
          "La ligne « En attente de l'autre appareil… » de l'expéditeur cède la place à la carte connectée, et le badge de chemin qui s'y trouve indique « Relais ». C'est ici la valeur attendue et non une panne, car une session de navigateur entre réseaux passe délibérément par le relais TURN chiffré, et « LAN direct » n'apparaîtrait que si les deux ordinateurs partageaient finalement un réseau.",
          "Le compteur de fichiers va ensuite jusqu'au dernier fichier du lot sur les deux écrans, et le fichier lui-même se trouve là où la ligne sous la demande annonçait que le navigateur récepteur le déposerait.",
        ],
        code: ["Relais\nFichier 1/1"],
      },
    },
    {
      heading: "Quand le code est refusé, ou que le transfert s'arrête",
      body: [
        "Un transfert entre réseaux comporte plus de pièces mobiles qu'un transfert sur le même réseau — un code avec une durée de vie, un compte, une allocation de relais — et chacune se nomme sur la carte d'appairage au lieu d'échouer en silence. La règle est donc simple : lisez cette carte avant tout le reste.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "L'ordinateur qui reçoit saisit le code et obtient « Code d'appairage invalide ou expiré ».",
            code: ["https://relayium.com/cross-network   # la carte de l'expéditeur affiche le décompte en direct"],
            fix: "Cinq minutes se sont écoulées depuis sa création, ou un chiffre a été mal saisi. Créez un nouveau code sur l'ordinateur qui envoie et faites-le saisir tout de suite, ou envoyez plutôt le lien de participation, qui évite toute saisie.",
          },
          {
            symptom: "La carte indique que le relais n'est délivré qu'aux comptes vérifiés.",
            code: ["https://relayium.com/cross-network   # la carte d'appairage nomme la raison du refus"],
            fix: "L'adresse e-mail de l'expéditeur n'est pas encore vérifiée. Ouvrez le panneau du compte, vérifiez l'adresse via le message envoyé par Relayium, puis créez un nouveau code d'appairage, car l'ancien ne récupérera pas un relais qui lui a déjà été refusé. Les transferts sur le même réseau et la CLI n'en dépendent pas.",
          },
          {
            symptom: "La carte indique que le trafic de relais du mois est épuisé.",
            code: ["https://relayium.com/me   # l'utilisation du mois montre ce qu'il reste de l'allocation"],
            fix: "Les sessions de navigateur entre réseaux ne peuvent ni démarrer ni continuer jusqu'à la remise à zéro le mois prochain. Pour envoyer maintenant, déposez les fichiers en lien de téléchargement sur https://relayium.com/offline-transfer, changez d'offre, ou faites tourner votre propre nœud. Les transferts sur le même réseau continuent dans tous les cas.",
          },
          {
            symptom: "Le transfert s'interrompt à mi-parcours et ne repart pas.",
            code: ["https://relayium.com/cross-network   # les deux onglets doivent être restés sur cette page"],
            fix: "C'est une session en direct, donc une coupure réseau passagère peut reprendre là où elle s'était arrêtée, mais fermer l'onglet ou recharger la page y met fin et aucune copie côté serveur ne prend le relais. Recommencez avec un nouveau code, et si l'autre personne ne peut pas rester en ligne, utilisez le lien de téléchargement sur https://relayium.com/offline-transfer.",
          },
          {
            symptom: "Le transfert fonctionne, mais bien plus lentement que les mêmes fichiers sur un seul réseau.",
            code: ["https://relayium.com/cross-network   # le badge de chemin de la carte connectée indique Relais"],
            fix: "Une session relayée est bornée par les deux connexions internet plus le saut du relais, elle est donc réellement plus lente qu'un transfert LAN, et aucun réglage n'y change rien. Pour un très gros lot, le lien de téléchargement sur https://relayium.com/offline-transfer est la voie plus tranquille, car il n'exige pas que les deux côtés soient en ligne en même temps.",
          },
        ],
      },
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
        a: "C'est du pair-à-pair au sens qui compte : le fichier transite d'un navigateur à l'autre et n'est jamais stocké sur un serveur. Sur le même LAN, les navigateurs se connectent directement ; entre réseaux, le code d'appairage utilise TURN par conception. Le relais ne transmet que du texte chiffré de bout en bout, ne peut ni lire ni déchiffrer le fichier, et ne conserve ni copie côté serveur ni historique temps réel.",
      },
      {
        q: "Les deux personnes ont-elles besoin d'un compte ?",
        a: "Non. Sur le même réseau, aucun des deux côtés n'a besoin de compte. Entre réseaux différents, la personne qui envoie se connecte pour créer le code d'appairage — c'est ce qui permet à Relayium de générer et de gérer ce code — mais la personne qui reçoit n'a jamais besoin de compte, qu'elle saisisse le code ou ouvre simplement le lien.",
      },
      {
        q: "Est-ce que cela marche entre réseaux et pays différents ?",
        a: "Oui. Le code d'appairage existe précisément pour ce cas : deux ordinateurs qui ne sont pas sur le même réseau local, où qu'ils se trouvent dans le monde. Cette voie emprunte un relais TURN chiffré plutôt qu'une liaison directe, et c'est délibéré — Relayium prend le relais pour que la traversée des NAT et des pare-feux ne dépende jamais de l'existence d'un chemin direct.",
      },
      {
        q: "Y a-t-il une limite de taille de fichier ou de nombre de fichiers ?",
        a: "Vous pouvez envoyer jusqu'à 1 000 fichiers en un seul lot. Aucun serveur Relayium n'impose de limite de taille, et les limites qui restent sont pratiques : Chrome ou Edge sur ordinateur écrit le lot en flux directement sur le disque, et ce qui le borne là, c'est le navigateur, le système d'exploitation, la place libre sur ce disque et la durée pendant laquelle la session en direct tient, tandis que Firefox et Safari gardent le lot en mémoire, où Relayium prévient au-delà d'environ 256 Mo. Ce seuil est une estimation prudente, pas un plafond ferme ; le vrai dépend de la machine.",
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
    "دليل لنقل الملفات بين متصفحين: اتصال مباشر على شبكة LAN نفسها، أو نقل مشفَّر من الطرف إلى الطرف عبر TURN بين الشبكات، دون رفع سحابي أو تثبيت.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إرسال ملف إلى حاسوب آخر يعني عادةً رفعه إلى مكان ما أولًا — قرص سحابي، مرفق بريد إلكتروني، تطبيق محادثة — والأمل في أن يتمكن المُستقبِل من إخراجه مجددًا. يتخطى Relayium خطوة التخزين هذه: يتصل المتصفحان مباشرةً على شبكة LAN نفسها؛ وعبر الشبكات لا يحمل مُرحِّل TURN سوى نص مشفَّر من الطرف إلى الطرف، ولا يحتفظ بنسخة محتوى فوري أو سجل على الخادم.",
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
        "إذا كان الجهازان على شبكتين مختلفتين — جهاز مكتبك في المنزل وحاسوب زميل محمول في مدينة أخرى، مثلًا — فلا يستطيع الاكتشاف التلقائي العبور عبر الإنترنت، لذا يستخدم Relayium بدلًا من ذلك رمز اقتران قصيرًا. الشخص الذي يُرسل يسجّل الدخول لإنشاء ذلك الرمز؛ أما الشخص الذي يستقبل فلا يحتاج أبدًا إلى حساب، سواء أدخل الرمز أو فتح الرابط الذي يولّده فحسب. والرمز صالح خمس دقائق، فجهِّز الجهازين معًا قبل توليده.",
      ],
    },
    {
      heading: "خطوة بخطوة: إرسال ملف عبر الإنترنت",
      body: [
        "إليك مسار النقل الكامل لحاسوبين على شبكتين مختلفتين:",
      ],
      prereqs: {
        label: "قبل أن تبدأ",
        items: [
          "حساب مسجَّل الدخول على جهاز الإرسال وحده. إنشاء رمز الاقتران يحتاج حسابًا، أما الجهاز الذي ينضم بالرمز أو الرابط فلا يسجّل الدخول أبدًا.",
          "بريد إلكتروني موثَّق في ذلك الحساب. لا يُمنَح مُرحِّل الجلسة عبر الشبكات إلا للحسابات الموثَّقة، وتقول بطاقة الاقتران ذلك صراحةً عند الرفض.",
          "أن تكونا أمام حاسوبيكما في الوقت نفسه. يعيش رمز الاقتران خمس دقائق، وهذه جلسة حيّة لا رفعٌ يأتي أحدهم لاحقًا ليأخذه.",
          "وسيلة لتمرير ستة أرقام أو رابط عبر قناة أخرى — مكالمة هاتفية، نافذة محادثة، رسالة نصية.",
        ],
      },
      steps: [
        {
          text: "على جهاز الإرسال، افتح صفحة النقل الفوري وسجّل الدخول.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "اختر الملفات أو المجلد المراد إرساله — حتى 1,000 ملف في الدفعة الواحدة — ثم أنشِئ رمز الاقتران. تعرض البطاقة عندئذٍ الأرقام الستة، وزرًا لنسخ الرابط، ورمز QR، وعدًّا تنازليًا.",
          code: ["رمز اقترانك — اقرأه للطرف الآخر\n483920\nتنتهي صلاحية رمز الاقتران خلال 4:52"],
        },
        {
          text: "شارك ذلك الرمز أو الرابط مع الطرف الآخر بأي طريقة مناسبة — اقرأه بصوت عالٍ، أرسله برسالة نصية، الصقه في المحادثة. والرابط يحمل الرمز نفسه في جزئه المرجعي، فمشاركة أيٍّ منهما فعل واحد.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "على جهاز الاستقبال، افتح ذلك الرابط، أو افتح الصفحة نفسها واكتب الأرقام الستة ثم اضغط «اتصال». لا تسجيل دخول على هذا الطرف.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "يبدأ النقل بمجرد انضمام الجهاز الآخر. اترك التبويبين مفتوحين حتى ينتهي عدّاد الملفات: فالعدّ التنازلي يحكم الانضمام الجديد فقط، وانتهاؤه لا يقطع نقلًا جاريًا. وتفعيل «التحقّق المتقدّم» قبل البدء يضيف رمز تحقق (SAS) للمقارنة — والتطابق يؤكد أن المفاتيح لم تُستبدل وأن الحاسوبين انضما إلى جلسة التشفير من الطرف إلى الطرف نفسها، لكنه لا يثبت أي مسار شبكي يسلكه النص المشفّر.",
        },
      ],
      success: {
        label: "كيف يبدو نقل ناجح",
        body: [
          "يحلّ محلَّ سطر «في انتظار انضمام الجهاز الآخر…» لدى المُرسِل بطاقةُ الاتصال، ويقرأ وسم المسار عليها «مُرحَّل». وهذه هي القيمة المتوقَّعة هنا لا عطلًا: فجلسة المتصفح عبر الشبكات تمرّ بحكم التصميم عبر مُرحِّل TURN مُشفَّر، ولن ترى «مباشر عبر LAN» إلا إذا تبيّن أن الحاسوبين يتشاركان شبكة واحدة فعلًا.",
          "ثم يمضي عدّاد الملفات إلى آخر ملف في الدفعة على الشاشتين، ويكون الملف نفسه حيث قال السطر أسفل الطلب إن متصفح الاستقبال سيضعه.",
        ],
        code: ["مُرحَّل\nالملف 1/1"],
      },
    },
    {
      heading: "عندما يُرفض الرمز أو يتوقف النقل",
      body: [
        "النقل عبر الشبكات فيه أجزاء متحركة أكثر من النقل على نفس الشبكة — رمز له عمر، وحساب، وحصة مُرحِّل — وكل واحد منها يذكر نفسه على بطاقة الاقتران بدل أن يفشل بصمت. فاقرأ تلك البطاقة أولًا.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "يكتب جهاز الاستقبال الرمز فيظهر «رمز الاقتران غير صالح أو منتهي الصلاحية».",
            code: ["https://relayium.com/cross-network   # بطاقة المُرسِل تعرض العدّ التنازلي الحي"],
            fix: "مضت خمس دقائق على إنشائه، أو أُدخِل رقم خطأ. أنشِئ رمزًا جديدًا على جهاز الإرسال واطلب من الطرف الآخر إدخاله فورًا — أو أرسِل له رابط الانضمام بدلًا من ذلك فلا يحتاج إلى كتابة شيء.",
          },
          {
            symptom: "تقول البطاقة إن المُرحِّل لا يُمنَح إلا للحسابات الموثَّقة.",
            code: ["https://relayium.com/cross-network   # بطاقة الاقتران تسمّي سبب الرفض"],
            fix: "بريد الطرف المُرسِل لم يُوثَّق بعد. افتح لوحة الحساب، ووثِّق العنوان من الرسالة التي أرسلها Relayium، ثم أنشِئ رمز اقتران جديدًا — فالرمز القديم لن يلتقط مُرحِّلًا سبق أن رُفض له. ولا يتأثر بهذا النقل على نفس الشبكة ولا سطر الأوامر.",
          },
          {
            symptom: "تقول البطاقة إن حصة الترحيل لهذا الشهر استُنفدت.",
            code: ["https://relayium.com/me   # «استخدام هذا الشهر» يبيّن ما تبقّى من حصة الترحيل"],
            fix: "لا يمكن لجلسات المتصفح عبر الشبكات أن تبدأ أو تستمر حتى تُصفَّر الحصة الشهر القادم. وللإرسال الآن ارفع الملفات كرابط تنزيل على https://relayium.com/offline-transfer، أو ارفع الباقة، أو شغّل عقدتك الخاصة؛ ويبقى النقل على نفس الشبكة عاملًا في الحالتين.",
          },
          {
            symptom: "يتوقف النقل في منتصفه ولا يستأنف.",
            code: ["https://relayium.com/cross-network   # يجب أن يبقى التبويبان على هذه الصفحة"],
            fix: "هذه جلسة حيّة، فانقطاع الشبكة المؤقت يمكن أن يستأنف من حيث توقّف، لكن إغلاق التبويب أو إعادة تحميل الصفحة ينهيها ولا توجد نسخة على الخادم تكمل عنها. ابدأ من جديد برمز جديد — وإن تعذّر على الطرف الآخر البقاء متصلًا، فاستخدم رابط التنزيل غير المتزامن على https://relayium.com/offline-transfer.",
          },
          {
            symptom: "النقل يعمل، لكنه أبطأ بكثير من إرسال الملفات نفسها على شبكة واحدة.",
            code: ["https://relayium.com/cross-network   # وسم المسار على البطاقة المتصلة يقرأ «مُرحَّل»"],
            fix: "الجلسة المُرحَّلة محكومة باتصالَي الإنترنت لدى الطرفين إضافةً إلى قفزة المُرحِّل، فهي أبطأ فعلًا من النقل على الشبكة المحلية ولا يغيّر ذلك أي إعداد. وللدفعات الكبيرة جدًا يكون رابط التنزيل على https://relayium.com/offline-transfer المسار الأهدأ، لأنه لا يشترط اتصال الطرفين في الوقت نفسه.",
          },
        ],
      },
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
        a: "هو من الند للند بالمعنى الذي يهم: يُبَث الملف من متصفح إلى آخر ولا يُخزَّن على خادم. على شبكة LAN نفسها يتصل المتصفحان مباشرةً؛ وعبر الشبكات يستخدم رمز الاقتران TURN بحكم التصميم. لا يمرّر المُرحِّل إلا نصًا مشفَّرًا من الطرف إلى الطرف، فلا يستطيع قراءة الملف أو فك تشفيره، ولا يحتفظ بنسخة محتوى فوري أو سجل على الخادم.",
      },
      {
        q: "هل يحتاج كلا الشخصين إلى حساب؟",
        a: "لا. على نفس الشبكة، لا يحتاج أي من الطرفين إلى حساب. أما عبر شبكات مختلفة، فالشخص الذي يُرسل يسجّل الدخول لإنشاء رمز الاقتران — وهذا ما يتيح لـ Relayium إنشاء الرمز وإدارته — لكن الشخص الذي يستقبل لا يحتاج أبدًا إلى حساب، سواء أدخل الرمز أو فتح الرابط فحسب.",
      },
      {
        q: "هل يعمل عبر شبكات وبلدان مختلفة؟",
        a: "نعم. رمز الاقتران موجود تحديدًا لهذه الحالة: حاسوبان ليسا على نفس الشبكة المحلية، أينما كان كل منهما في العالم. وهذا المسار يمر عبر مُرحِّل TURN مشفَّر لا عبر وصلة مباشرة، وذلك عن قصد: يسلك Relayium طريق الترحيل حتى لا يتوقف تجاوز NAT وجدران الحماية على توفّر مسار مباشر أصلًا.",
      },
      {
        q: "هل هناك حد لحجم الملف أو لعدد الملفات التي يمكنني إرسالها؟",
        a: "يمكنك إرسال حتى 1,000 ملف في دفعة واحدة. لا يفرض أي خادم من خوادم Relayium حدًّا أقصى للحجم، والباقي حدود عملية: يبثّ المتصفح الدفعة مباشرةً إلى القرص في Chrome أو Edge على الحاسوب (بثًّا إلى القرص)، بينما يحتفظ Firefox وSafari بالدفعة في الذاكرة، وينبّهك Relayium فوق نحو 256 ميغابايت. وهذه العتبة تقدير متحفّظ لا سقف صارم؛ أما السقف الحقيقي فيتوقف على الجهاز نفسه.",
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
    "Una guía para transferir archivos de navegador a navegador: conexión directa en la misma LAN, o TURN cifrado de extremo a extremo entre redes, sin subir a la nube ni instalar nada.",
  updatedLabel: "Última actualización",
  lead: [
    "Enviar un archivo a otro ordenador suele significar subirlo primero a algún sitio — un disco en la nube, un adjunto de correo, una aplicación de chat — y esperar que el destinatario pueda recuperarlo. Relayium se salta ese paso de almacenamiento: en la misma LAN los navegadores conectan directamente; entre redes, un retransmisor TURN solo lleva texto cifrado de extremo a extremo y no conserva copia de contenido ni historial en el servidor.",
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
        "Si los dos ordenadores están en redes distintas — tu ordenador de sobremesa en casa y el portátil de un colega al otro lado del país, por ejemplo — el descubrimiento automático no puede cruzar Internet, así que Relayium usa en su lugar un código de emparejamiento corto. La persona que envía inicia sesión para generar ese código; la persona que recibe nunca necesita una cuenta, ya sea que escriba el código o simplemente abra el enlace que este genera. El código vale cinco minutos, así que ten los dos dispositivos a mano antes de generarlo.",
      ],
    },
    {
      heading: "Paso a paso: enviar un archivo a través de Internet",
      body: [
        "Este es el flujo completo para dos ordenadores en redes distintas:",
      ],
      prereqs: {
        label: "Antes de empezar",
        items: [
          "Una cuenta conectada solo en el ordenador que envía. Crear un código de emparejamiento la exige; el ordenador que se une por código o enlace no inicia sesión nunca.",
          "Una dirección de correo verificada en esa cuenta. El retransmisor de una sesión entre redes solo se entrega a cuentas verificadas, y la tarjeta de emparejamiento lo dice con claridad cuando lo rechaza.",
          "Los dos delante de vuestros ordenadores a la vez. Un código de emparejamiento vive cinco minutos, y esto es una sesión en directo, no una subida que alguien recoge más tarde.",
          "Una forma de pasar seis dígitos o un enlace por otro canal — una llamada, una ventana de chat, un mensaje.",
        ],
      },
      steps: [
        {
          text: "En el ordenador que envía, abre la página de transferencia en tiempo real e inicia sesión.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Elige los archivos o la carpeta a enviar — hasta 1.000 archivos por lote — y crea el código de emparejamiento. La tarjeta muestra entonces los seis dígitos, un botón para copiar el enlace, un código QR y una cuenta atrás.",
          code: ["Tu código de emparejamiento — léeselo a la otra persona\n483920\nel código de emparejamiento caduca en 4:52"],
        },
        {
          text: "Comparte ese código o enlace con la otra persona como te resulte más cómodo — léelo en voz alta, mándalo por mensaje, pégalo en el chat. El enlace lleva el mismo código en su fragmento, así que compartir uno u otro es el mismo acto.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "En el ordenador que recibe, abre ese enlace, o abre la misma página, escribe los seis dígitos y pulsa «Conectar». En este lado no hay inicio de sesión.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "La transferencia empieza en cuanto el otro dispositivo se une. Deja las dos pestañas abiertas hasta que el contador de archivos llegue al final: la cuenta atrás solo rige las incorporaciones nuevas, así que agotarse no corta una transferencia que ya va en marcha. Activar «Verificación avanzada» antes de empezar añade un código de verificación (SAS) que comparar: la coincidencia confirma que las claves no fueron sustituidas y que ambos ordenadores se unieron a la misma sesión cifrada de extremo a extremo, pero no demuestra qué ruta de red lleva el texto cifrado.",
        },
      ],
      success: {
        label: "Qué se ve cuando la transferencia funciona",
        body: [
          "La línea «Esperando a que el otro dispositivo se una…» del remitente deja paso a la tarjeta conectada, y la etiqueta de ruta que lleva marca «Retransmitido». Ese es aquí el valor esperado y no un fallo: una sesión de navegador entre redes pasa por el retransmisor TURN cifrado por diseño, y «Directo por LAN» solo aparecería si los dos ordenadores resultaran compartir una red.",
          "El contador de archivos llega después al último archivo del lote en las dos pantallas, y el archivo está donde la línea bajo la solicitud dijo que lo pondría el navegador que recibe.",
        ],
        code: ["Retransmitido\nArchivo 1/1"],
      },
    },
    {
      heading: "Cuando el código se rechaza, o la transferencia se detiene",
      body: [
        "Una transferencia entre redes tiene más piezas móviles que una en la misma red — un código con caducidad, una cuenta, una asignación de retransmisión — y cada una se nombra en la tarjeta de emparejamiento en vez de fallar en silencio. Así que lee esa tarjeta primero.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El ordenador que recibe escribe el código y obtiene «El código de emparejamiento no es válido o ha caducado».",
            code: ["https://relayium.com/cross-network   # la tarjeta del remitente muestra la cuenta atrás en vivo"],
            fix: "Han pasado cinco minutos desde que se creó, o se ha tecleado mal un dígito. Crea un código nuevo en el ordenador que envía y que la otra persona lo introduzca enseguida, o mándale el enlace de unión, que no exige teclear nada.",
          },
          {
            symptom: "La tarjeta dice que el retransmisor solo se entrega a cuentas verificadas.",
            code: ["https://relayium.com/cross-network   # la tarjeta de emparejamiento nombra el motivo del rechazo"],
            fix: "La dirección de correo de quien envía aún no está verificada. Abre el panel de la cuenta, verifícala con el mensaje que envió Relayium y crea después un código nuevo, porque el antiguo no recogerá un retransmisor que ya se le denegó. Las transferencias en la misma red y la CLI no dependen de esto.",
          },
          {
            symptom: "La tarjeta dice que el tráfico de retransmisión de este mes está agotado.",
            code: ["https://relayium.com/me   # el uso de este mes muestra lo que queda de la asignación"],
            fix: "Las sesiones de navegador entre redes no pueden empezar ni continuar hasta que la asignación se reinicie el mes que viene. Para enviar ahora, sube los archivos como enlace de descarga en https://relayium.com/offline-transfer, cambia de plan, o levanta tu propio nodo; las transferencias en la misma red siguen funcionando igual.",
          },
          {
            symptom: "La transferencia se para a mitad y no se reanuda.",
            code: ["https://relayium.com/cross-network   # las dos pestañas tienen que seguir en esta página"],
            fix: "Esto es una sesión en directo: un corte de red pasajero puede reanudarse donde se quedó, pero cerrar la pestaña o recargar la página la termina y no hay copia en el servidor que la retome. Empieza de nuevo con otro código, y si la otra persona no puede quedarse en línea, usa el enlace de descarga de https://relayium.com/offline-transfer.",
          },
          {
            symptom: "La transferencia funciona, pero mucho más lenta que los mismos archivos en una sola red.",
            code: ["https://relayium.com/cross-network   # la etiqueta de ruta de la tarjeta conectada dice Retransmitido"],
            fix: "Una sesión retransmitida está limitada por las dos conexiones a internet más el salto del retransmisor, así que es realmente más lenta que una transferencia por LAN y ningún ajuste lo cambia. Para un lote muy grande, el enlace de descarga de https://relayium.com/offline-transfer es la vía más tranquila, porque no exige que ambos lados estén en línea a la vez.",
          },
        ],
      },
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
        a: "Es de igual a igual en el sentido que importa: el archivo pasa de un navegador al otro y nunca se almacena en un servidor. En la misma LAN los navegadores conectan directamente; entre redes, el código de emparejamiento usa TURN por diseño. El retransmisor solo lleva texto cifrado de extremo a extremo, no puede leer ni descifrar el archivo y no conserva copia de contenido ni historial en el servidor.",
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
    "Um guia para transferir arquivos entre navegadores: conexão direta na mesma LAN ou TURN criptografado de ponta a ponta entre redes, sem upload para a nuvem nem instalação.",
  updatedLabel: "Última atualização",
  lead: [
    "Enviar um arquivo para outro computador normalmente significa enviá-lo primeiro para algum lugar — um drive na nuvem, um anexo de e-mail, um aplicativo de chat — e torcer para que o destinatário consiga recuperá-lo. O Relayium pula essa etapa de armazenamento: na mesma LAN os navegadores se conectam diretamente; entre redes, um retransmissor TURN só leva texto cifrado de ponta a ponta e não mantém cópia de conteúdo nem histórico no servidor.",
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
        "Se os dois computadores estiverem em redes diferentes — o seu desktop em casa e o notebook de um colega do outro lado do país, por exemplo — a descoberta automática não consegue atravessar a Internet, então o Relayium usa em vez disso um código de emparelhamento curto. Quem envia faz login para gerar esse código; quem recebe nunca precisa de conta, seja digitando o código ou apenas abrindo o link que ele gera. O código vale cinco minutos, então deixe os dois aparelhos à mão antes de gerar um.",
      ],
    },
    {
      heading: "Passo a passo: enviar um arquivo pela Internet",
      body: [
        "Este é o fluxo completo para dois computadores em redes diferentes:",
      ],
      prereqs: {
        label: "Antes de começar",
        items: [
          "Uma conta conectada só no computador que envia. Criar um código de emparelhamento exige uma; o computador que entra por código ou link nunca faz login.",
          "Um e-mail verificado nessa conta. O retransmissor de uma sessão entre redes só é entregue a contas verificadas, e o cartão de emparelhamento diz isso com todas as letras quando recusa.",
          "Os dois na frente dos computadores ao mesmo tempo. Um código de emparelhamento vive cinco minutos, e isto é uma sessão ao vivo, não um envio que alguém busca depois.",
          "Um jeito de passar seis dígitos ou um link por outro canal — uma ligação, uma janela de chat, uma mensagem.",
        ],
      },
      steps: [
        {
          text: "No computador que envia, abra a página de transferência em tempo real e faça login.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "Escolha os arquivos ou a pasta a enviar — até 1.000 arquivos por lote — e crie o código de emparelhamento. O cartão então mostra os seis dígitos, um botão para copiar o link, um código QR e uma contagem regressiva.",
          code: ["Seu código de emparelhamento — leia-o para a outra pessoa\n483920\no código de emparelhamento expira em 4:52"],
        },
        {
          text: "Compartilhe esse código ou link com a outra pessoa da forma que for mais conveniente — leia em voz alta, mande por mensagem, cole no chat. O link carrega o mesmo código no fragmento, então compartilhar um ou outro é o mesmo ato.",
          code: ["https://relayium.com/cross-network#c=483920"],
        },
        {
          text: "No computador que recebe, abra esse link, ou abra a mesma página, digite os seis dígitos e clique em “Conectar”. Deste lado não há login.",
          code: ["https://relayium.com/cross-network"],
        },
        {
          text: "A transferência começa assim que o outro dispositivo entra. Deixe as duas abas abertas até o contador de arquivos terminar: a contagem regressiva rege apenas novas entradas, então ela acabar não corta uma transferência já em andamento. Ligar a “Verificação avançada” antes de começar acrescenta um código de verificação (SAS) para comparar: a coincidência confirma que as chaves não foram substituídas e que os dois computadores entraram na mesma sessão criptografada de ponta a ponta, mas não prova qual caminho de rede leva o texto cifrado.",
        },
      ],
      success: {
        label: "Como é uma transferência que funciona",
        body: [
          "A linha “Aguardando o outro dispositivo entrar…” de quem envia dá lugar ao cartão conectado, e o selo de caminho nele indica “Retransmitido”. Esse é o valor esperado aqui, não uma falha: uma sessão de navegador entre redes passa pelo retransmissor TURN criptografado por decisão de projeto, e “LAN direto” só apareceria se os dois computadores acabassem compartilhando uma rede.",
          "O contador de arquivos vai então até o último arquivo do lote nas duas telas, e o arquivo em si está onde a linha abaixo do pedido disse que o navegador que recebe o colocaria.",
        ],
        code: ["Retransmitido\nArquivo 1/1"],
      },
    },
    {
      heading: "Quando o código é recusado, ou a transferência para",
      body: [
        "Uma transferência entre redes tem mais peças móveis do que uma na mesma rede — um código com prazo, uma conta, uma cota de retransmissão — e cada uma se identifica no cartão de emparelhamento em vez de falhar em silêncio. Então leia esse cartão primeiro.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O computador que recebe digita o código e aparece “O código de emparelhamento é inválido ou expirou”.",
            code: ["https://relayium.com/cross-network   # o cartão de quem envia mostra a contagem ao vivo"],
            fix: "Passaram-se cinco minutos desde que foi criado, ou um dígito foi digitado errado. Crie um código novo no computador que envia e peça para a outra pessoa digitar na hora, ou mande o link de entrada, que dispensa digitação.",
          },
          {
            symptom: "O cartão diz que o retransmissor só é entregue a contas verificadas.",
            code: ["https://relayium.com/cross-network   # o cartão de emparelhamento nomeia o motivo da recusa"],
            fix: "O e-mail de quem envia ainda não foi verificado. Abra o painel da conta, verifique o endereço pela mensagem que o Relayium mandou e crie então um código novo, porque o antigo não vai pegar um retransmissor que já lhe foi negado. Transferências na mesma rede e a CLI não dependem disso.",
          },
          {
            symptom: "O cartão diz que o tráfego de retransmissão deste mês acabou.",
            code: ["https://relayium.com/me   # o uso deste mês mostra o que sobrou da cota"],
            fix: "Sessões de navegador entre redes não podem começar nem continuar até a cota zerar no mês que vem. Para enviar agora, suba os arquivos como link de download em https://relayium.com/offline-transfer, mude de plano, ou rode o seu próprio nó; transferências na mesma rede continuam funcionando de qualquer forma.",
          },
          {
            symptom: "A transferência para no meio e não recomeça.",
            code: ["https://relayium.com/cross-network   # as duas abas precisam continuar nesta página"],
            fix: "Isto é uma sessão ao vivo: uma queda de rede passageira pode retomar de onde parou, mas fechar a aba ou recarregar a página encerra tudo e não há cópia no servidor para continuar. Comece de novo com outro código, e se a outra pessoa não puder ficar online, use o link de download em https://relayium.com/offline-transfer.",
          },
          {
            symptom: "A transferência funciona, mas bem mais devagar do que os mesmos arquivos em uma única rede.",
            code: ["https://relayium.com/cross-network   # o selo de caminho do cartão conectado diz Retransmitido"],
            fix: "Uma sessão retransmitida é limitada pelas duas conexões de internet mais o salto do retransmissor, então é de fato mais lenta que uma transferência por LAN, e nenhuma configuração muda isso. Para um lote muito grande, o link de download em https://relayium.com/offline-transfer é o caminho mais tranquilo, porque não exige os dois lados online ao mesmo tempo.",
          },
        ],
      },
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
        a: "É ponto a ponto no sentido que importa: o arquivo passa de um navegador para o outro e nunca é armazenado em um servidor. Na mesma LAN os navegadores se conectam diretamente; entre redes, o código de emparelhamento usa TURN por decisão de projeto. O retransmissor só leva texto cifrado de ponta a ponta, não consegue ler nem descriptografar o arquivo e não mantém cópia de conteúdo nem histórico no servidor.",
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
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
