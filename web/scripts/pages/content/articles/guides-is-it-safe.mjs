// web/scripts/pages/content/articles/guides-is-it-safe.mjs
// Guide: a layperson "is it safe / what should I check" trust piece — complements
// guides-how-encryption-works.mjs (which explains the mechanism) rather than duplicating it.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Facts grounded in web/src/lib/crypto.ts, store-crypto.ts and
// web/scripts/pages/content/legal/security.mjs (English block).

const en = {
  title: "Is it safe to send files over the internet?",
  description:
    "What actually goes wrong with email, cloud links, and USB drives — what \"end-to-end encrypted\" and \"zero-knowledge\" really mean, and what to check before trusting a transfer tool.",
  updatedLabel: "Last updated",
  lead: [
    "\"Is it safe to send this file?\" is a reasonable question to stop and ask, whether it's a tax return, a contract, or just photos you'd rather stayed private. This guide isn't about scaring you off common tools — it's about walking through, plainly, what actually happens to a file when you email it, drop it in a cloud folder, or carry it on a USB stick, what the phrases \"end-to-end encrypted\" and \"zero-knowledge\" actually promise, and what to check before you trust any tool with something you care about.",
    "None of this requires a technical background. By the end, you'll know what questions to ask — of any transfer method, including this one.",
  ],
  sections: [
    {
      heading: "Where files actually go wrong: the everyday risks",
      body: [
        "Email attachments pass through your mail provider's servers and the recipient's, both of which commonly scan, index, and back up messages for spam filtering and disaster recovery — long after you've forgotten you sent it. Forward the email once, and the file is in front of someone you never intended, with no way to know every copy is gone.",
        "Cloud storage links are convenient, but a link usually keeps working until you remember to revoke it, and \"anyone with the link\" is only as private as an unguessable URL — which a link-shortening service or a careless forward can undo. The file also inherits the security of the whole account it sits in, not just the share itself.",
        "A USB stick feels safe because it's offline, but that's exactly the gap: most drives aren't encrypted by default, so a stick left in a laptop bag or a rental car hands over the plaintext to whoever finds it, no password required.",
        "Free public upload sites solve the immediate problem — get a file from A to B — but rarely say what happens next: how long it's kept, whether it's scanned, who might stumble on it, or how the site pays its bills (ad-funded file hosts have a track record of bundling trackers or worse).",
      ],
      bullets: [
        "Email: retained and scanned by mail servers, easy to forward beyond your control",
        "Cloud links: keep working until revoked, and inherit the whole account's security",
        "USB drives: unencrypted by default, easy to lose or leave behind",
        "Free upload sites: retention and scanning practices are usually unclear",
      ],
    },
    {
      heading: "What \"end-to-end encrypted\" and \"zero-knowledge\" actually mean",
      body: [
        "Plenty of services say \"encrypted\" and mean only that the connection to their server is encrypted — standard HTTPS/TLS, the same padlock icon your bank uses. That's real protection against someone eavesdropping on the network, but it stops at the server: once your file arrives, the service itself can read it, because it holds the key. A lot of everyday tools stop exactly there.",
        "End-to-end encryption means something stronger: the file is encrypted before it leaves your device, with a key that only the sender and the intended recipient ever hold. The service that carries it — the server, the relay, anything in between — never has the key, so it never has the plaintext, no matter how it's asked.",
        "\"Zero-knowledge\" is a related idea usually applied to something stored rather than sent live: even data sitting at rest on a server was encrypted with a key the server itself was never given, so the operator has no way to read it, ever, no matter how long it stays there.",
      ],
      bullets: [
        "\"Encrypted\" alone often just means TLS to the server — the provider can still read the file.",
        "\"End-to-end encrypted\" means only sender and recipient hold the key.",
        "\"Zero-knowledge\" means the server holds data it structurally cannot decrypt, even at rest.",
      ],
    },
    {
      heading: "What to actually check before trusting a transfer tool",
      prereqs: {
        label: "What you need to run this checklist",
        items: [
          "Ten minutes and a browser. The first two checks are reading, not auditing.",
          "Two devices for the live checks. Three and four cannot be done from a marketing page, which is exactly why they are worth doing.",
          "No security expertise. Each item below is either something you can read or something you can see happen.",
        ],
      },
      steps: [
        {
          text: "Find the vendor's own answer to \"can you read my files?\" in their source, not on their pricing page. If there is no source, that is already an answer.",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "Check the licence and whether the repository is the thing that is actually deployed. A claim you can inspect is a different kind of claim from one you are asked to accept.",
        },
        {
          text: "On a live transfer, compare the verification code on both screens. This is the step that turns \"end-to-end encrypted\" from a sentence into something being enforced between these two particular endpoints.",
          code: ["https://relayium.com/"],
        },
        {
          text: "While that transfer runs, open your browser's developer tools and watch the network panel. Look for your file's contents in what is being uploaded. Not finding them is the point; finding them would be the finding.",
        },
        {
          text: "Check what is left afterwards: whether a link expires on its own, and whether the service could produce the file again later if someone asked it to.",
        },
      ],
      success: {
        label: "What passing this checklist actually tells you",
        body: [
          "The first two checks are cheap and rule out most tools in minutes. The last three cannot be faked by a landing page, because they are things you watch happen on your own two devices.",
          "None of it makes a tool trustworthy in the abstract. It makes specific claims checkable, which is the most any of us can do without reading every line ourselves.",
        ],
      },
      body: [
        "The marketing language on a website is worth less than a few concrete questions:",
      ],
      bullets: [
        "Does it say \"encrypted\" (could mean just TLS) or specifically \"end-to-end encrypted\" (only sender and recipient hold the key)?",
        "Is there a way to verify the connection wasn't tampered with — a code you compare, not just a padlock icon you have to trust?",
        "Is the file's integrity checked, so a corrupted or altered file doesn't arrive silently wrong?",
        "Is the code open source and auditable, or are the claims just marketing you have to take on faith?",
        "Does sending or receiving require handing over more identity than the transfer actually needs?",
        "If anything is stored, does it have a clear, finite lifetime — an expiry or delete-after-download — instead of sitting there indefinitely?",
      ],
    },
    {
      heading: "How Relayium answers each of these",
      body: [
        "For a live transfer, with both people online at once, Relayium generates a fresh X25519 key pair on each device and derives a shared AES-256-GCM key that exists only inside the two browsers — it's never sent to Relayium's own servers. An optional short verification code (a SAS) — shown when you turn on advanced verification, which is off by default — lets both sides confirm the keys weren't swapped by a dishonest server in the middle, and each file's SHA-256 hash is checked end to end so a corrupted transfer doesn't arrive looking fine. The mechanics of exactly how that works are covered in more depth in \"How Relayium encrypts your files end-to-end\", if you want to go further than this page.",
        "When the recipient isn't online yet, a stored download link uses a genuinely different, zero-knowledge design: your browser generates a random AES-256-GCM key and encrypts the files with it before anything uploads. That key is never sent to the server — it lives only in the link's URL fragment, the part after #, which browsers never transmit. The server ends up holding ciphertext it has no way to decrypt, plus an expiry you choose: 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or burn after the first completed download.",
        "Across networks, Relayium's browser app uses TURN by design: the relay carries end-to-end encrypted ciphertext, but it never receives the key and cannot read or decrypt the file.",
        "None of this asks you to trust a claim on faith: Relayium's client and server code is open source under the AGPL-3.0 license, so it can be read and audited rather than taken on faith.",
      ],
      bullets: [
        "Same-network transfers need no account at all.",
        "Sending across networks by pairing code, or creating a stored link, needs the sender to sign in — the recipient never needs an account.",
      ],
    },
    {
      heading: "Encryption isn't the whole story — a few habits still matter",
      body: [
        "Strong encryption protects a file in transit and at rest, but it can't stop you from sending a link to the wrong address — treat a share link like the file itself, and don't post it somewhere public.",
        "For anything genuinely sensitive, turn on advanced verification and take the extra few seconds to compare the verification code out loud on a call, or in person, rather than trusting that two matching screens next to each other haven't both been fooled.",
        "And no transfer tool, however well encrypted, protects a file that's already exposed on a device that's compromised — good encryption assumes the two ends themselves are trustworthy. None of this is a reason to be paranoid about sending files; it's just worth knowing what encryption does and doesn't cover.",
      ],
    },
    {
      heading: "When a check does not give you a clean answer",
      body: [
        "Three places people get stuck. In each case the ambiguity is itself informative.",
      ],
      troubleshooting: {
        label: "What you run into, what to check, what it means",
        items: [
          {
            symptom: "The network panel shows a large upload and you cannot tell what is in it.",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "That is the expected result, not a dead end. What you are looking for is the absence of anything recognisable from your file — a filename you chose, a string you know is in the document. If you can read your own content in the payload, that is the finding, and it is a decisive one.",
          },
          {
            symptom: "There is no verification code, so the third check cannot be done.",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "You are on a stored-link transfer rather than a live one. There is no second endpoint online to compare against, so the guarantee has a different shape: the key lives in the link fragment and never reaches the server at all. Compare codes on live transfers, and check link expiry on stored ones.",
          },
          {
            symptom: "The source is open but you cannot read the language it is written in.",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "You do not have to. The question this check answers is whether the claim is falsifiable at all: is there a repository, does it correspond to what is deployed, could someone who does read that language contradict it. A claim nobody is in a position to check is the finding.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is it safe to email a sensitive file?",
        a: "Email isn't designed for confidential file transfer — attachments are commonly retained, scanned, and backed up by mail servers on both ends, and a forwarded message can put the file in front of people you never intended. It's fine for low-stakes files; for anything sensitive, a tool with end-to-end encryption removes that exposure.",
      },
      {
        q: "What does \"zero-knowledge\" actually mean?",
        a: "That the party storing your data was never given the key to read it. The encryption happens on your device before anything uploads, and the key lives only somewhere the server never sees — like a URL fragment — so what sits on the server is ciphertext it structurally cannot decrypt, not just data it promises not to look at.",
      },
      {
        q: "Is a password-protected zip file good enough?",
        a: "It's better than nothing, but the password often travels the same way as the file — in the same email thread, for instance — which undoes the protection, and zip encryption implementations vary widely in strength. A tool built around end-to-end encryption removes that weak link by never needing a shared password at all.",
      },
      {
        q: "Does Relayium keep a copy of my files?",
        a: "In realtime mode, Relayium keeps no server-side copy or transfer history: WebRTC is direct on the same LAN, while cross-network browser sessions use TURN by design to carry end-to-end encrypted ciphertext the relay cannot read or decrypt. For a stored link, the server holds only encrypted ciphertext it cannot read, until the link expires or is downloaded once if you chose burn-after-read.",
      },
      {
        q: "Do I need an account to send or receive a file?",
        a: "On the same network, neither side needs an account. Sending across networks by pairing code, or creating a stored link, requires the sender to sign in — but the person receiving never needs an account, whichever mode is used.",
      },
    ],
  },
  cta: {
    text: "Curious whether a tool actually protects what it claims to? Start a transfer, turn on advanced verification, and see the verification code and the zero-knowledge link for yourself.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "在网上发送文件到底安全吗？",
  description:
    "电子邮件、云盘链接、U 盘各自藏着哪些真实风险？「端到端加密」和「零知识」到底意味着什么？信任一个传输工具之前，你该检查什么——本文用大白话讲清楚。",
  updatedLabel: "最近更新",
  lead: [
    "「发这份文件安全吗？」是个值得停下来想一想的问题——不管是一份报税单、一份合同，还是几张你希望别人看不到的照片。这篇文章不是要吓唬你远离常用工具，而是想平实地讲清楚：用邮件发文件、把文件丢进云盘文件夹、或者用 U 盘带着走的时候，到底会发生什么；「端到端加密」和「零知识」这两个词到底承诺了什么；以及在把重要的东西交给任何一个工具之前，你该检查什么。",
    "这些都不需要技术背景。读完之后，你会知道该问哪些问题——对任何一种传输方式都适用，包括本文介绍的这一个。",
  ],
  sections: [
    {
      heading: "文件真正会出问题的地方：那些日常风险",
      body: [
        "邮件附件会经过你和收件人各自邮件服务商的服务器，双方都会例行地扫描、索引、备份邮件，用于反垃圾和灾难恢复——在你早已忘掉这封邮件很久之后，它们还留在那里。只要邮件被转发一次，文件就到了你从未打算给的人面前，而你没有办法确认每一份副本都被清除了。",
        "云盘链接很方便，但一个链接通常会一直有效，直到你想起来去撤销它；而「拥有链接的任何人都能打开」有多私密，全看这个 URL 有多难猜——短链接服务或一次不小心的转发，都能让它不再难猜。文件的安全性还会连带取决于它所在的整个账号，而不只是这一次分享本身。",
        "U 盘让人感觉安全，因为它是离线的，但这恰恰是问题所在：大多数 U 盘默认不加密，一旦落在笔记本包里或者租来的车上，捡到的人拿到的就是明文，不需要任何密码。",
        "免费的公开上传网站解决了眼前的问题——把文件从 A 送到 B——但很少说清楚接下来会发生什么：文件会被保留多久、会不会被扫描、谁可能碰巧看到它，以及网站靠什么赚钱（靠广告维持的文件托管站，历史上不乏被曝出捆绑追踪器甚至更糟东西的先例）。",
      ],
      bullets: [
        "邮件：会被邮件服务器保留和扫描，也很容易被转发到你控制不了的地方",
        "云盘链接：在被撤销之前一直有效，并且继承整个账号的安全性",
        "U 盘：默认不加密，容易丢失或落在某处",
        "免费上传网站：保留和扫描的做法通常并不透明",
      ],
    },
    {
      heading: "「端到端加密」和「零知识」到底是什么意思",
      body: [
        "不少服务说自己「加密」，其实只是指连到它服务器的这段通道是加密的——也就是标准的 HTTPS/TLS，和你网银用的是同一把挂锁图标。这确实能防止有人在网络上偷听，但保护止步于服务器：文件一旦到达，服务本身就能读到它，因为密钥在它手里。很多日常工具正是止步于此。",
        "端到端加密的意思更进一步：文件在离开你的设备之前就已经加密，而这把密钥只有发送方和指定的接收方手里有。承载文件的那个服务——服务器、中继、中间的任何一环——从来没有这把密钥，所以不管被谁要求，它都拿不出明文。",
        "「零知识」是一个相关但略有不同的概念，通常用在「存放」而不是「实时发送」的场景：即便数据静静地躺在服务器上，加密它用的那把密钥也从未交给过服务器本身，所以运营方无论数据放多久，都没有办法读懂它。",
      ],
      bullets: [
        "单说「加密」，往往只是到服务器为止的 TLS——服务商仍然能读到文件。",
        "「端到端加密」意味着只有发送方和接收方手里有密钥。",
        "「零知识」意味着服务器持有的数据，结构上就无法被它自己解密，哪怕只是静静存着。",
      ],
    },
    {
      heading: "信任一个传输工具之前，真正该检查什么",
      prereqs: {
        label: "要跑这份核查清单，你需要什么",
        items: [
          "十分钟和一个浏览器。前两项是阅读，不是审计。",
          "两台设备，用于实时的那几项。第三、第四项没法在营销页面上完成，而这恰恰是它们值得做的原因。",
          "不需要安全专业知识。下面每一项要么是你能读到的东西，要么是你能亲眼看见发生的事。",
        ],
      },
      steps: [
        {
          text: "到厂商的源码里去找他们自己对「你们能读我的文件吗」的回答，而不是去定价页找。如果根本没有源码，那本身就已经是个回答。",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "看一下许可证，以及那个仓库是不是真正部署上线的那份东西。一个你能亲自查验的说法，和一个要求你接受的说法，是两种不同的说法。",
        },
        {
          text: "在一次实时传输中，比对两块屏幕上的校验码。正是这一步，把「端到端加密」从一句话变成了在这两个具体端点之间正在被强制执行的事。",
          code: ["https://relayium.com/"],
        },
        {
          text: "在那次传输进行时，打开浏览器的开发者工具，看网络面板。在上传的内容里找你自己文件的内容。找不到才是重点；找得到才是结论。",
        },
        {
          text: "检查事后还剩下什么：链接会不会自己过期，以及如果有人日后要求，服务方还能不能把这个文件重新拿出来。",
        },
      ],
      success: {
        label: "通过这份清单到底说明了什么",
        body: [
          "前两项代价很低，几分钟就能筛掉大多数工具。后三项是落地页伪造不了的，因为它们是你在自己那两台设备上亲眼看着发生的事。",
          "这些都不会让一个工具在抽象意义上变得可信。它们做的是让具体的说法变得可核查——在不逐行读完所有代码的前提下，这已经是我们任何人能做到的极限。",
        ],
      },
      body: [
        "官网上的营销话术，远不如几个具体问题管用：",
      ],
      bullets: [
        "它说的是「加密」（可能只是 TLS），还是明确说「端到端加密」（只有发送方和接收方持有密钥）？",
        "有没有办法验证连接没有被篡改——是一段你要亲自核对的校验码，而不只是一个你只能选择相信的挂锁图标？",
        "文件的完整性有没有被校验，好让损坏或被改动过的文件不会悄无声息地「正常」抵达？",
        "代码是不是开源、可审查的，还是这些说法只是你必须单凭信任接受的宣传语？",
        "发送或接收是否要求你交出比这次传输真正需要的更多身份信息？",
        "如果有内容被存放在服务器上，它有没有一个明确、有限的生命周期——比如过期时间，或者阅后即焚——而不是无限期地留在那里？",
      ],
    },
    {
      heading: "Relayium 如何回应这些问题",
      body: [
        "在一次双方同时在线的实时传输中，Relayium 会让每台设备各生成一对全新的 X25519 密钥，再各自推导出同一把只存在于两个浏览器内部的 AES-256-GCM 共享密钥——它从不会发送给 Relayium 自己的服务器。可选的那段简短校验码（SAS）——打开默认关闭的「高级验证」后才会显示——能让双方确认密钥没有被中间不诚实的服务器调包；每个文件的 SHA-256 哈希也会做端到端核对，这样一次损坏的传输不会看起来「一切正常」。想知道这背后具体是怎么运作的，可以接着读《Relayium 如何对文件端到端加密》，那篇讲得更深入。",
        "当接收方还不在线时，存储下载链接采用的是另一套零知识方案：你的浏览器会生成一把随机的 AES-256-GCM 密钥，在任何内容上传之前就用它把文件加密好。这把密钥从不会发给服务器——它只存在于链接的 URL 片段里，也就是 # 号之后、浏览器从不发送的那部分。服务器最终持有的是它无法解密的密文，外加一个由你选择的有效期：1 小时、1 天、3 天、7 天，最长 14 天（上限取决于你的套餐），或者阅后即焚（首次完整下载后即删除）。",
        "跨网络时，Relayium 浏览器端按设计使用 TURN：中继承载端到端加密的密文，但从未拿到密钥，无法读取或解密文件。",
        "这些都不需要你单凭信任去接受：Relayium 的客户端和服务器代码都以 AGPL-3.0 许可证开源，谁都可以阅读和审查，而不必只是相信宣传。",
      ],
      bullets: [
        "同一网络内的传输完全不需要账号。",
        "跨网络用配对码发送，或者创建一个存储链接，都需要发送方登录——但接收方永远不需要账号。",
      ],
    },
    {
      heading: "加密不是全部——有几个习惯依然值得保持",
      body: [
        "强加密能保护文件在传输中和存放时的安全，但它挡不住你把链接发给了错的人——把分享链接当作文件本身来对待，不要把它公开发到什么地方。",
        "对于真正敏感的内容，请打开高级验证，多花几秒钟，在通话里读出校验码或者当面核对，而不要只是相信两块并排的屏幕不可能同时被骗过。",
        "而且不管加密做得多好，任何传输工具都保护不了一台已被攻破的设备上早已暴露的文件——好的加密假设的前提是两端本身可信。这些都不是让你对发文件这件事草木皆兵的理由，只是值得清楚加密到底覆盖了什么、没覆盖什么。",
      ],
    },
    {
      heading: "当某一项给不出干净的答案时",
      body: [
        "有三个地方容易卡住。而在每一种情形里，这份模糊本身就是有信息量的。",
      ],
      troubleshooting: {
        label: "你遇到什么、检查什么、它意味着什么",
        items: [
          {
            symptom: "网络面板里有一大块上传，但你看不出里面是什么。",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "这正是预期结果，不是死胡同。你要找的是「找不到任何能认出来的东西」——你自己起的文件名，或者你知道文档里有的某个字符串。如果你能在上传内容里读出自己的东西，那才是结论，而且是决定性的结论。",
          },
          {
            symptom: "没有校验码，所以第三项做不了。",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "你用的是存储型链接传输，而不是实时传输。这里没有第二个在线端点可供比对，所以保证的形态不同：密钥存在链接的片段部分，根本不会到达服务器。实时传输比对校验码，存储型传输则检查链接过期。",
          },
          {
            symptom: "源码是开放的，但你读不懂它用的那门语言。",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "你不需要读懂。这一项要回答的问题是：这个说法到底可不可证伪——有没有仓库，它是否对应着实际部署的东西，一个读得懂那门语言的人有没有可能站出来反驳它。一个没有任何人有条件去核查的说法，本身就是结论。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "用邮件发敏感文件安全吗？",
        a: "邮件并不是为机密文件传输设计的——附件通常会被收发双方的邮件服务器保留、扫描并备份，而一封被转发的邮件可能把文件送到你从未打算给的人面前。发一些无关紧要的文件没问题；涉及敏感内容时，一个具备端到端加密的工具能消除这种暴露。",
      },
      {
        q: "「零知识」到底是什么意思？",
        a: "意思是存放你数据的一方，从未拿到过能读懂它的密钥。加密发生在你的设备上、内容上传之前，而密钥只存在于服务器永远看不到的地方——比如 URL 片段——所以服务器上存放的是它结构上就无法解密的密文，而不只是一份「承诺不看」的数据。",
      },
      {
        q: "给压缩包加个密码是不是就够了？",
        a: "总比什么都不做强，但这个密码常常和文件走同一条路——比如就在同一封邮件里——这就抵消了保护的作用；而且不同压缩软件实现的加密强度也参差不齐。一个建立在端到端加密之上的工具从根本上不需要共享密码，也就消除了这个薄弱环节。",
      },
      {
        q: "Relayium 会保留我的文件副本吗？",
        a: "实时模式下，Relayium 不保留服务器端副本或传输历史：同一局域网内 WebRTC 直连，跨网络浏览器则按设计经 TURN 承载端到端加密的密文，中继无法读取或解密。对于存储链接，服务器只持有它无法读取的密文，直到链接过期；如果你选了「阅后即焚」，则在首次完整下载之后立即删除。",
      },
      {
        q: "发送或接收文件需要账号吗？",
        a: "在同一网络内，双方都不需要账号。跨网络用配对码发送，或者创建一个存储链接，需要发送方登录——但无论用哪种方式，接收方都从不需要账号。",
      },
    ],
  },
  cta: {
    text: "想知道一个工具是不是真的做到了它宣称的保护？发起一次传输，打开高级验证，亲眼看看那段校验码和这个零知识链接。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "インターネットでファイルを送るのは安全か",
  description:
    "メール添付・クラウドリンク・USBメモリそれぞれの本当のリスク、「エンドツーエンドで暗号化」と「ゼロ知識」が実際に意味すること、そして転送ツールを信頼する前に確認すべきことを平易に解説します。",
  updatedLabel: "最終更新",
  lead: [
    "「このファイルを送っても大丈夫だろうか」と立ち止まって考えるのは、ごく自然な疑問です。確定申告書でも、契約書でも、人に見られたくない写真でも同じです。このガイドは、普段使っているツールを怖がらせるためのものではありません。メールで送る、クラウドフォルダに置く、USBメモリで持ち歩く、それぞれの場合に実際に何が起きるのか、「エンドツーエンドで暗号化されている」「ゼロ知識」という言葉が実際に何を約束しているのか、そして大切なものをどんなツールに預けるにせよ、その前に何を確認すべきかを、平易な言葉で説明します。",
    "専門知識は一切必要ありません。読み終える頃には、このページで紹介するものも含め、どんな転送方法に対してもどんな質問をすればよいかが分かるはずです。",
  ],
  sections: [
    {
      heading: "ファイルが実際に危険にさらされる場面:日常に潜むリスク",
      body: [
        "メールの添付ファイルは、送信者と受信者それぞれのメールプロバイダのサーバーを通過します。どちらもスパム対策や災害復旧のために、メッセージを日常的にスキャンし、索引を作り、バックアップします。送ったことすら忘れてしまったずっと後になっても、それは残り続けます。メールが一度でも転送されれば、ファイルは意図しなかった相手の目の前に現れ、すべてのコピーが消えたことを確認する術はありません。",
        "クラウドストレージのリンクは便利ですが、取り消そうと思い出すまで、たいてい効き続けます。「リンクを知っている全員」というのは、その URL がどれだけ推測しにくいかにすぎず、短縮リンクや不用意な転送によって簡単に崩れます。ファイルの安全性は、その共有自体だけでなく、それが置かれているアカウント全体の安全性も引き継ぎます。",
        "USBメモリはオフラインなので安全に感じられますが、まさにそこが落とし穴です。ほとんどのドライブはデフォルトで暗号化されておらず、ノートPCのバッグやレンタカーに置き忘れれば、拾った人はパスワードなしで平文をそのまま手にすることになります。",
        "無料の公開アップロードサイトは、AからBへファイルを届けるという目の前の問題は解決しますが、その後どうなるかはほとんど説明されません。どれくらい保存されるのか、スキャンされるのか、誰かが偶然見つけるかもしれないのか、そのサイトがどうやって運営費をまかなっているのか（広告収入で運営されているファイルホスティングサイトには、トラッカーやさらに悪質なものを紛れ込ませてきた前例があります）。",
      ],
      bullets: [
        "メール:メールサーバーに保存・スキャンされ、自分のコントロールを超えて転送されやすい",
        "クラウドリンク:取り消すまで有効であり続け、アカウント全体のセキュリティを引き継ぐ",
        "USBメモリ:デフォルトでは暗号化されておらず、紛失や置き忘れが起きやすい",
        "無料アップロードサイト:保存やスキャンの方針が不透明なことが多い",
      ],
    },
    {
      heading: "「エンドツーエンドで暗号化」と「ゼロ知識」が実際に意味すること",
      body: [
        "多くのサービスは「暗号化されている」と謳いますが、それが意味するのはサーバーへの接続が暗号化されていることだけです。標準的な HTTPS/TLS であり、銀行のサイトで見るのと同じ錠前アイコンです。これはネットワーク上の盗聴に対する本物の保護ですが、サーバーで止まります。ファイルが到着すれば、サービス自体がそれを読むことができます。鍵を持っているからです。多くの日常的なツールはまさにそこで止まっています。",
        "エンドツーエンド暗号化はもっと強いことを意味します。ファイルは端末を離れる前に暗号化され、その鍵を持つのは送信者と意図した受信者だけです。それを運ぶサービスは、サーバーもリレーも、その間にあるものすべても、その鍵を一度も持ちません。だから、どう求められても平文を持つことがありません。",
        "「ゼロ知識」は関連する概念で、通常はリアルタイムで送るものではなく、保存されるものに使われます。サーバー上に静かに置かれているデータでさえ、その暗号化に使われた鍵はサーバー自身に一度も渡されていません。だから運営者は、データがどれだけ長く置かれていても、それを読む手段を持ちません。",
      ],
      bullets: [
        "単に「暗号化」というだけでは、サーバーまでの TLS を指すだけのことが多く、提供者はファイルを読めてしまいます。",
        "「エンドツーエンドで暗号化」とは、送信者と受信者だけが鍵を持つことを意味します。",
        "「ゼロ知識」とは、保存中であってもサーバーが構造的に復号できないデータしか持たないことを意味します。",
      ],
    },
    {
      heading: "転送ツールを信頼する前に、実際に確認すべきこと",
      prereqs: {
        label: "このチェックリストを回すのに必要なもの",
        items: [
          "10分とブラウザ。最初の2つは読むだけで、監査ではありません。",
          "ライブの項目のための端末2台。3つめと4つめはマーケティングページ上ではできず、だからこそやる価値があります。",
          "セキュリティの専門知識は不要です。以下の各項目は、読めるものか、起きるのを見られるもののどちらかです。",
        ],
      },
      steps: [
        {
          text: "「この会社はこちらのファイルを読めるのか」に対する提供者自身の答えを、料金ページではなくソースの中に探します。ソースがないなら、それ自体がすでに答えです。",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "ライセンスを確認し、そのリポジトリが実際に動いているものと対応しているかを見ます。自分で確かめられる主張と、受け入れるよう求められる主張は、種類が違います。",
        },
        {
          text: "ライブ転送で、両方の画面の検証コードを照合します。「エンドツーエンド暗号化」を一文から、この2つの端点のあいだで実際に強制されている状態へ変えるのが、この手順です。",
          code: ["https://relayium.com/"],
        },
        {
          text: "その転送中に、ブラウザの開発者ツールを開いてネットワークパネルを見ます。アップロードされている中身に自分のファイルの内容を探してください。見つからないことが要点で、見つかったならそれが結論です。",
        },
        {
          text: "あとに何が残るかを確認します。リンクが自分で期限切れになるか、そして後日求められたときにサービス側がそのファイルをもう一度出せるのか。",
        },
      ],
      success: {
        label: "このチェックリストを通ることが実際に示すもの",
        body: [
          "最初の2つは安上がりで、数分でたいていのツールをふるい落とせます。あとの3つはランディングページには偽装できません。自分の2台の端末で起きるのを見ているからです。",
          "これで抽象的にツールが信頼できるようになるわけではありません。具体的な主張を確認可能にするだけです。全行を自分で読むのでない限り、それが誰にとっても限界です。",
        ],
      },
      body: [
        "ウェブサイトの宣伝文句より、いくつかの具体的な質問のほうがずっと役に立ちます。",
      ],
      bullets: [
        "「暗号化」とだけ書かれているか（単なる TLS かもしれません）、それとも明確に「エンドツーエンドで暗号化」と書かれているか（送信者と受信者だけが鍵を持つ）？",
        "接続が改ざんされていないことを確認する方法があるか、つまり、信頼するしかない錠前アイコンだけでなく、自分で照合するコードがあるか？",
        "ファイルの完全性がチェックされ、壊れたり改ざんされたりしたファイルが、何ごともなかったかのように届いてしまわないか？",
        "コードはオープンソースで監査可能か、それとも主張は単に信じるしかない宣伝文句か？",
        "送受信の際、その転送に本当に必要な以上の身元情報を差し出すことを求められないか？",
        "何かが保存される場合、有効期限やダウンロード後の削除といった、明確で有限の寿命があるか、それとも無期限にそこに置かれ続けるのか？",
      ],
    },
    {
      heading: "Relayium はこれらにどう答えるか",
      body: [
        "双方が同時にオンラインであるリアルタイム転送では、Relayium は各デバイスに新しい X25519 鍵ペアを生成させ、両ブラウザの内部にのみ存在する共有 AES-256-GCM 鍵を導出します。この鍵が Relayium 自身のサーバーに送られることはありません。任意の短い検証コード（SAS）——既定でオフの「高度な検証」をオンにすると表示されます——によって、双方は鍵が中間の不正なサーバーによってすり替えられていないことを確認でき、各ファイルの SHA-256 ハッシュがエンドツーエンドで照合されるため、破損した転送が何ごともなかったように見えることはありません。この仕組みの詳細をさらに知りたい場合は、より深く解説した「Relayium がファイルをエンドツーエンドで暗号化する仕組み」をご覧ください。",
        "受信者がまだオンラインでないとき、保存型のダウンロードリンクは本当に異なるゼロ知識方式を使います。ブラウザがランダムな AES-256-GCM 鍵を生成し、何かがアップロードされる前にそれでファイルを暗号化します。この鍵はサーバーには一切送られません。リンクの URL フラグメント、つまり # の後ろの部分にのみ存在し、ブラウザはこの部分を決して送信しません。結果としてサーバーが持つのは、復号する術のない暗号文と、選んだ有効期限（1時間、1日、3日、7日、プランに応じて最長14日、または最初のダウンロード完了後に消去）だけです。",
        "ネットワークをまたぐ場合、Relayium のブラウザアプリは設計上 TURN を使用します。リレーはエンドツーエンド暗号文を運びますが、鍵を受け取らないため、ファイルを読み取ることも復号することもできません。",
        "これらのどれについても、主張を鵜呑みにする必要はありません。Relayium のクライアントとサーバーのコードは AGPL-3.0 ライセンスのもとオープンソースで公開されており、宣伝を信じるのではなく、誰でも読んで監査できます。",
      ],
      bullets: [
        "同一ネットワーク内の転送にはアカウントが一切不要です。",
        "ペアリングコードでネットワークをまたいで送る場合や、保存リンクを作成する場合は送信者のサインインが必要です。受信者にはアカウントが一切必要ありません。",
      ],
    },
    {
      heading: "暗号化がすべてではない:それでも大切ないくつかの習慣",
      body: [
        "強力な暗号化は転送中と保存中のファイルを守りますが、リンクを間違った宛先に送ってしまうことまでは防げません。共有リンクはファイルそのものだと思って扱い、どこか公開の場に貼らないようにしましょう。",
        "本当に機密性の高い内容については、高度な検証をオンにし、あと数秒手間をかけて、通話で検証コードを声に出して読み合わせるか、対面で照合しましょう。隣り合った2つの画面が両方とも欺かれていないと信じるだけでは十分ではありません。",
        "そして、どれほど暗号化がしっかりしていても、すでに侵害された端末上で露出しているファイルを転送ツールが守ることはできません。優れた暗号化は、両端そのものが信頼できることを前提としています。だからといって、ファイルを送ること自体に神経質になる必要はありません。ただ、暗号化がどこまでをカバーし、どこからはカバーしないのかを知っておく価値がある、というだけです。",
      ],
    },
    {
      heading: "確認がすっきりした答えをくれないとき",
      body: [
        "つまずきやすいのは3か所です。いずれの場合も、その曖昧さ自体に情報があります。",
      ],
      troubleshooting: {
        label: "ぶつかること、確認すること、その意味",
        items: [
          {
            symptom: "ネットワークパネルに大きなアップロードがあるが、中身が何かわからない。",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "それが期待どおりの結果であって、行き止まりではありません。探しているのは、見覚えのあるものが何も見つからないことです——自分で付けたファイル名や、その文書にあるとわかっている文字列など。もしアップロードの中身に自分の内容が読めたなら、それが結論であり、決定的な結論です。",
          },
          {
            symptom: "検証コードがないので、3つめができない。",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "それはライブ転送ではなく保存リンクの転送です。照合する相手の端点がオンラインにいないため、保証の形が違います。鍵はリンクのフラグメントにあり、サーバーには一切届きません。ライブ転送ではコードを照合し、保存型ではリンクの有効期限を確認してください。",
          },
          {
            symptom: "ソースは公開されているが、書かれている言語が読めない。",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "読める必要はありません。この確認が答える問いは、その主張がそもそも反証可能かどうかです。リポジトリはあるか、動いているものと対応しているか、その言語を読める人が反証しうる状態にあるか。誰も確認できる立場にない主張こそが結論です。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "機密性の高いファイルをメールで送っても安全ですか？",
        a: "メールは機密ファイルの転送のために設計されたものではありません。添付ファイルは送受信双方のメールサーバーに日常的に保存・スキャン・バックアップされ、転送されたメッセージは、意図しなかった人の目に触れることがあります。重要度の低いファイルなら問題ありませんが、機密性の高いものには、エンドツーエンド暗号化を備えたツールがこうした露出を取り除きます。",
      },
      {
        q: "「ゼロ知識」とは実際には何を意味しますか？",
        a: "データを保存する側が、それを読むための鍵を一度も渡されていないということです。暗号化はアップロードの前に端末上で行われ、鍵は、たとえば URL フラグメントのように、サーバーが決して目にしない場所にのみ存在します。そのためサーバー上にあるのは、構造的に復号できない暗号文であり、単に「見ないと約束された」データではありません。",
      },
      {
        q: "パスワード付きZIPファイルで十分ですか？",
        a: "何もしないよりはましですが、そのパスワードはしばしば、たとえば同じメールスレッドのように、ファイルと同じ経路で送られてしまい、それが保護を無効にしてしまいます。また ZIP の暗号化実装は製品によって強度に大きな差があります。エンドツーエンド暗号化を前提としたツールは、そもそも共有パスワードを必要としないため、この弱点そのものを取り除きます。",
      },
      {
        q: "Relayium は私のファイルのコピーを保持しますか？",
        a: "リアルタイムモードでは、Relayium はサーバー側のコピーや転送履歴を保持しません。同じ LAN では WebRTC で直接接続し、ネットワークをまたぐブラウザセッションは設計上 TURN で、リレーが読み取りも復号もできないエンドツーエンド暗号文を運びます。保存リンクの場合、サーバーが持つのは読むことのできない暗号文だけで、リンクが期限切れになるか、「閲覧後削除」を選んでいれば一度ダウンロードされるまでの間だけ保持されます。",
      },
      {
        q: "ファイルの送受信にアカウントは必要ですか？",
        a: "同一ネットワーク内であれば、どちらの側もアカウントは不要です。ペアリングコードでネットワークをまたいで送る場合や、保存リンクを作成する場合は送信者のサインインが必要ですが、どちらの方式でも受信者にはアカウントが一切必要ありません。",
      },
    ],
  },
  cta: {
    text: "あるツールが本当に謳い文句どおりに守ってくれているのか気になりますか？転送を始め、高度な検証をオンにして、検証コードとゼロ知識のリンクを自分の目で確かめてください。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "인터넷으로 파일을 보내도 안전할까요?",
  description:
    "이메일 첨부파일, 클라우드 링크, USB 드라이브 각각의 실제 위험, \"종단간 암호화\"와 \"영지식\"이 실제로 의미하는 것, 그리고 전송 도구를 신뢰하기 전에 확인해야 할 것을 쉽게 설명합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "\"이 파일을 보내도 안전할까?\"는 잠시 멈춰 생각해볼 만한 합리적인 질문입니다. 세금 신고서든, 계약서든, 그냥 남에게 보이고 싶지 않은 사진이든 말이죠. 이 글은 흔히 쓰는 도구들을 겁주려는 것이 아닙니다. 이메일로 파일을 보낼 때, 클라우드 폴더에 넣을 때, USB 드라이브에 담아 다닐 때 실제로 무슨 일이 일어나는지, \"종단간 암호화\"와 \"영지식\"이라는 말이 실제로 무엇을 약속하는지, 그리고 소중한 것을 어떤 도구에 맡기기 전에 무엇을 확인해야 하는지를 담담하게 짚어보려는 것입니다.",
    "기술적인 배경지식은 전혀 필요하지 않습니다. 다 읽고 나면, 어떤 전송 방식에든——이 글에서 소개하는 방식을 포함해서——어떤 질문을 던져야 할지 알게 될 것입니다.",
  ],
  sections: [
    {
      heading: "파일이 실제로 새는 지점: 일상적인 위험들",
      body: [
        "이메일 첨부파일은 발신자와 수신자 각각의 메일 서버를 거치는데, 두 서버 모두 스팸 필터링과 재해 복구를 위해 메시지를 일상적으로 스캔하고 색인하고 백업합니다——그 파일을 보냈다는 사실조차 잊어버린 훨씬 뒤에도요. 이메일이 한 번이라도 전달되면, 파일은 의도하지 않은 사람 앞에 놓이게 되고, 모든 사본이 사라졌는지 확인할 방법은 없습니다.",
        "클라우드 저장소 링크는 편리하지만, 보통 취소해야겠다고 떠올리기 전까지는 계속 작동합니다. \"링크를 가진 누구나\"라는 말의 프라이버시 수준은 그 URL을 추측하기 얼마나 어려운가에 달려 있으며, 단축 링크나 부주의한 전달 한 번으로 그 조건이 깨질 수 있습니다. 파일은 그 공유 자체뿐 아니라 그것이 속한 계정 전체의 보안 수준도 물려받습니다.",
        "USB 드라이브는 오프라인이라 안전하게 느껴지지만, 바로 그 지점이 함정입니다. 대부분의 드라이브는 기본적으로 암호화되어 있지 않아서, 노트북 가방이나 렌터카에 두고 내리면 발견한 사람이 비밀번호 없이 평문 그대로를 손에 넣게 됩니다.",
        "무료 공개 업로드 사이트는 당장 눈앞의 문제——파일을 A에서 B로 옮기는 것——는 해결해주지만, 그다음에 무슨 일이 일어나는지는 거의 설명하지 않습니다. 얼마나 보관되는지, 스캔되는지, 누군가 우연히 발견할 수 있는지, 그 사이트가 어떻게 운영비를 충당하는지(광고로 운영되는 파일 호스팅 사이트들은 트래커나 그보다 더한 것을 끼워 넣어온 전례가 있습니다).",
      ],
      bullets: [
        "이메일: 메일 서버에 보관·스캔되며, 통제할 수 없는 범위로 쉽게 전달됨",
        "클라우드 링크: 취소하기 전까지 계속 작동하며, 계정 전체의 보안 수준을 물려받음",
        "USB 드라이브: 기본적으로 암호화되어 있지 않고 분실하거나 두고 오기 쉬움",
        "무료 업로드 사이트: 보관 및 스캔 방침이 대체로 불투명함",
      ],
    },
    {
      heading: "\"종단간 암호화\"와 \"영지식\"이 실제로 의미하는 것",
      body: [
        "많은 서비스가 \"암호화됨\"이라고 말하지만, 실제로는 서버로의 연결만 암호화되어 있다는 뜻일 때가 많습니다——은행 사이트에서 보는 것과 같은 자물쇠 아이콘, 즉 표준 HTTPS/TLS입니다. 이는 네트워크 상의 도청을 막는 실질적인 보호이지만, 서버에서 멈춥니다. 파일이 도착하는 순간, 서비스 자체는 그것을 읽을 수 있습니다. 키를 가지고 있으니까요. 많은 일상적인 도구들이 정확히 이 지점에서 멈춥니다.",
        "종단간 암호화는 더 강한 것을 의미합니다. 파일은 기기를 떠나기 전에 암호화되고, 그 키는 오직 발신자와 의도된 수신자만 갖습니다. 그것을 나르는 서비스——서버, 릴레이, 그 사이의 무엇이든——는 그 키를 한 번도 갖지 않으므로, 어떻게 요구받든 평문을 가질 수 없습니다.",
        "\"영지식\"은 관련된 개념으로, 보통 실시간으로 보내는 것이 아니라 저장되는 것에 적용됩니다. 서버에 조용히 놓여 있는 데이터조차, 그것을 암호화하는 데 쓰인 키는 서버 자신에게 한 번도 주어지지 않았습니다. 그래서 운영자는 데이터가 얼마나 오래 놓여 있든 그것을 읽을 방법이 전혀 없습니다.",
      ],
      bullets: [
        "그냥 \"암호화됨\"이라는 말은 흔히 서버까지의 TLS만을 뜻하며, 제공업체는 여전히 파일을 읽을 수 있습니다.",
        "\"종단간 암호화\"는 발신자와 수신자만이 키를 가진다는 뜻입니다.",
        "\"영지식\"은 서버가 보관 중에도 구조적으로 복호화할 수 없는 데이터만 갖고 있다는 뜻입니다.",
      ],
    },
    {
      heading: "전송 도구를 신뢰하기 전에 실제로 확인해야 할 것",
      prereqs: {
        label: "이 점검 목록을 돌리려면 필요한 것",
        items: [
          "10분과 브라우저 하나. 앞의 두 항목은 읽는 일이지 감사가 아닙니다.",
          "실시간 항목을 위한 기기 두 대. 세 번째와 네 번째는 마케팅 페이지에서는 할 수 없고, 그래서 할 가치가 있습니다.",
          "보안 전문 지식은 필요 없습니다. 아래 각 항목은 읽을 수 있는 것이거나, 벌어지는 것을 볼 수 있는 것입니다.",
        ],
      },
      steps: [
        {
          text: "\"내 파일을 읽을 수 있느냐\"에 대한 공급자 자신의 답을 요금 페이지가 아니라 소스에서 찾으세요. 소스가 없다면 그것 자체가 이미 답입니다.",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "라이선스를 확인하고, 그 저장소가 실제로 배포된 것과 대응하는지 보세요. 직접 살펴볼 수 있는 주장과 받아들이라고 요구되는 주장은 종류가 다릅니다.",
        },
        {
          text: "실시간 전송에서 두 화면의 검증 코드를 대조하세요. 「종단간 암호화」를 한 문장에서, 바로 이 두 종단 사이에 실제로 적용되고 있는 것으로 바꾸는 단계가 이것입니다.",
          code: ["https://relayium.com/"],
        },
        {
          text: "그 전송이 도는 동안 브라우저 개발자 도구를 열고 네트워크 패널을 보세요. 올라가는 내용에서 자기 파일의 내용을 찾아보세요. 찾지 못하는 것이 핵심이고, 찾는다면 그것이 결론입니다.",
        },
        {
          text: "끝난 뒤에 무엇이 남는지 확인하세요. 링크가 스스로 만료되는지, 그리고 나중에 누군가 요구하면 서비스가 그 파일을 다시 내놓을 수 있는지.",
        },
      ],
      success: {
        label: "이 목록을 통과한다는 것이 실제로 알려 주는 것",
        body: [
          "앞의 두 항목은 값이 싸고 몇 분이면 대부분의 도구를 걸러 냅니다. 뒤의 셋은 랜딩 페이지가 흉내 낼 수 없습니다. 자기 기기 두 대에서 벌어지는 것을 직접 보기 때문입니다.",
          "이것으로 어떤 도구가 추상적으로 신뢰할 만해지지는 않습니다. 구체적인 주장을 확인 가능하게 만들 뿐이며, 모든 줄을 직접 읽지 않는 한 그것이 누구에게나 최선입니다.",
        ],
      },
      body: [
        "웹사이트의 마케팅 문구보다 몇 가지 구체적인 질문이 훨씬 더 값어치가 있습니다.",
      ],
      bullets: [
        "\"암호화됨\"이라고만 말하는지(단순 TLS일 수 있음), 아니면 명확히 \"종단간 암호화\"라고 말하는지(발신자와 수신자만 키를 가짐)?",
        "연결이 변조되지 않았는지 확인할 방법이 있는지——그냥 믿어야 하는 자물쇠 아이콘이 아니라, 직접 대조할 수 있는 코드가 있는지?",
        "파일의 무결성이 검증되어, 손상되거나 변조된 파일이 아무 문제 없어 보이게 조용히 도착하지 않는지?",
        "코드가 오픈 소스이고 감사 가능한지, 아니면 그 주장들이 그냥 믿을 수밖에 없는 마케팅 문구인지?",
        "보내거나 받을 때, 그 전송에 실제로 필요한 것보다 더 많은 신원 정보를 요구받지는 않는지?",
        "무언가가 저장된다면, 그것이 명확하고 한정된 수명——만료 기한이나 다운로드 후 삭제——을 가지는지, 아니면 무기한 그대로 남아 있는지?",
      ],
    },
    {
      heading: "Relayium이 이 각각에 답하는 방식",
      body: [
        "양쪽이 동시에 온라인 상태인 실시간 전송에서, Relayium은 각 기기에서 새로운 X25519 키 쌍을 만들고, 두 브라우저 내부에만 존재하는 공유 AES-256-GCM 키를 도출합니다——이 키는 Relayium 자체 서버로 전송되는 일이 없습니다. 선택적인 짧은 검증 코드(SAS)——기본값이 꺼짐인 고급 검증을 켜면 표시됩니다——를 통해 양쪽 모두 중간의 부정직한 서버가 키를 바꿔치기하지 않았음을 확인할 수 있고, 각 파일의 SHA-256 해시가 종단간으로 대조되므로 손상된 전송이 문제없어 보이게 도착하는 일이 없습니다. 이 원리가 정확히 어떻게 작동하는지 더 깊이 알고 싶다면 \"Relayium이 파일을 종단간 암호화하는 방식\"에서 더 자세히 다룹니다.",
        "수신자가 아직 온라인이 아닐 때, 저장형 다운로드 링크는 진짜로 다른 영지식 방식을 사용합니다. 브라우저는 무작위 AES-256-GCM 키를 생성하고, 무언가 업로드되기 전에 그것으로 파일을 암호화합니다. 이 키는 서버로 전혀 전송되지 않습니다——링크의 URL 프래그먼트, 즉 # 뒤의 부분에만 존재하며, 브라우저는 이 부분을 절대 전송하지 않습니다. 결국 서버가 갖게 되는 것은 복호화할 방법이 없는 암호문과, 직접 선택한 만료 기한(1시간, 1일, 3일, 7일, 요금제에 따라 최대 14일, 또는 첫 다운로드 완료 후 삭제)뿐입니다.",
        "네트워크를 넘을 때 Relayium 브라우저 앱은 설계상 TURN을 사용합니다. 릴레이는 종단간 암호문을 운반하지만 키를 받지 않으므로 파일을 읽거나 복호화할 수 없습니다.",
        "이 중 어느 것도 주장을 그냥 믿으라고 요구하지 않습니다. Relayium의 클라이언트와 서버 코드는 AGPL-3.0 라이선스로 공개되어 있어, 홍보 문구를 믿는 대신 누구나 읽고 감사할 수 있습니다.",
      ],
      bullets: [
        "같은 네트워크 내의 전송은 계정이 전혀 필요 없습니다.",
        "페어링 코드로 네트워크를 넘어 보내거나 저장 링크를 만들 때는 발신자의 로그인이 필요합니다——수신자는 어떤 경우든 계정이 전혀 필요 없습니다.",
      ],
    },
    {
      heading: "암호화가 전부는 아닙니다 — 여전히 중요한 몇 가지 습관",
      body: [
        "강력한 암호화는 전송 중과 저장 중인 파일을 보호하지만, 링크를 잘못된 주소로 보내는 것까지 막아주지는 못합니다. 공유 링크를 파일 그 자체처럼 다루고, 어딘가 공개된 곳에 게시하지 마세요.",
        "정말로 민감한 내용에 대해서는 고급 검증을 켠 다음, 몇 초를 더 들여 통화로 검증 코드를 소리 내어 읽어 대조하거나 직접 만나서 확인하세요. 나란히 놓인 두 화면이 둘 다 속지 않았을 것이라고 그냥 믿는 것만으로는 부족합니다.",
        "그리고 아무리 암호화가 잘 되어 있어도, 이미 손상된 기기에서 노출된 파일을 어떤 전송 도구도 보호해줄 수는 없습니다. 좋은 암호화는 양쪽 끝 자체가 신뢰할 수 있다는 것을 전제로 합니다. 이것이 파일을 보내는 일 자체에 대해 지나치게 예민해질 이유는 아닙니다. 다만 암호화가 어디까지 커버하고 어디부터는 커버하지 않는지 알아둘 가치가 있다는 것입니다.",
      ],
    },
    {
      heading: "확인이 깔끔한 답을 주지 않을 때",
      body: [
        "막히는 지점은 세 군데입니다. 어느 경우든 그 모호함 자체가 정보를 담고 있습니다.",
      ],
      troubleshooting: {
        label: "부딪히는 것, 확인할 것, 그 의미",
        items: [
          {
            symptom: "네트워크 패널에 큰 업로드가 보이는데 안에 무엇이 있는지 알 수 없습니다.",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "그것이 기대한 결과이지 막다른 길이 아닙니다. 찾는 것은 알아볼 만한 것이 하나도 없다는 사실입니다 — 직접 붙인 파일 이름이나, 문서에 있다고 아는 문자열 같은 것. 업로드 내용에서 자기 것이 읽힌다면 그것이 결론이고, 결정적인 결론입니다.",
          },
          {
            symptom: "검증 코드가 없어서 세 번째를 할 수 없습니다.",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "실시간 전송이 아니라 저장형 링크 전송입니다. 대조할 상대 종단이 온라인에 없으므로 보장의 모양이 다릅니다. 키는 링크의 프래그먼트에 있고 서버에는 전혀 닿지 않습니다. 실시간 전송에서는 코드를 대조하고, 저장형에서는 링크 만료를 확인하세요.",
          },
          {
            symptom: "소스는 공개되어 있는데 쓰인 언어를 읽지 못합니다.",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "읽을 필요는 없습니다. 이 확인이 답하는 질문은 그 주장이 애초에 반증 가능한가입니다. 저장소가 있는가, 배포된 것과 대응하는가, 그 언어를 읽는 사람이 반박할 수 있는 상태인가. 아무도 확인할 처지가 못 되는 주장이야말로 결론입니다.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "민감한 파일을 이메일로 보내도 안전한가요?",
        a: "이메일은 기밀 파일 전송을 위해 설계된 것이 아닙니다. 첨부파일은 양쪽 메일 서버에 일상적으로 보관·스캔·백업되며, 전달된 메시지는 의도하지 않은 사람 앞에 놓일 수 있습니다. 중요하지 않은 파일이라면 괜찮지만, 민감한 내용이라면 종단간 암호화를 갖춘 도구가 이런 노출을 없애줍니다.",
      },
      {
        q: "\"영지식\"이 실제로 무엇을 의미하나요?",
        a: "내 데이터를 저장하는 쪽이 그것을 읽을 수 있는 키를 한 번도 받은 적이 없다는 뜻입니다. 암호화는 업로드되기 전에 내 기기에서 이루어지며, 키는 서버가 절대 보지 못하는 곳——예를 들어 URL 프래그먼트——에만 존재합니다. 그래서 서버에 있는 것은 구조적으로 복호화할 수 없는 암호문일 뿐, 단순히 '보지 않겠다고 약속한' 데이터가 아닙니다.",
      },
      {
        q: "비밀번호로 보호된 압축 파일이면 충분한가요?",
        a: "아예 안 하는 것보다는 낫지만, 그 비밀번호가 흔히 파일과 같은 경로로——예를 들어 같은 이메일 스레드로——전달되어 보호 효과가 사라지는 경우가 많고, 압축 파일의 암호화 구현 강도도 제품마다 크게 다릅니다. 종단간 암호화를 기반으로 한 도구는 애초에 공유 비밀번호가 필요 없어서 이런 약점 자체를 없애줍니다.",
      },
      {
        q: "Relayium이 제 파일 사본을 보관하나요?",
        a: "실시간 모드에서 Relayium은 서버 측 복사본이나 전송 기록을 보관하지 않습니다. 같은 LAN에서는 WebRTC로 직접 연결하고, 네트워크를 넘는 브라우저 세션은 설계상 TURN으로 릴레이가 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다. 저장 링크의 경우, 서버는 읽을 수 없는 암호문만 가지고 있으며, 링크가 만료되거나 '열람 후 삭제'를 선택했다면 한 번 다운로드된 후까지만 보관합니다.",
      },
      {
        q: "파일을 보내거나 받으려면 계정이 필요한가요?",
        a: "같은 네트워크 안에서는 양쪽 다 계정이 필요 없습니다. 페어링 코드로 네트워크를 넘어 보내거나 저장 링크를 만들 때는 발신자의 로그인이 필요하지만, 어느 방식이든 수신자는 계정이 전혀 필요 없습니다.",
      },
    ],
  },
  cta: {
    text: "어떤 도구가 실제로 약속한 만큼 보호해주는지 궁금하신가요? 전송을 시작하고 고급 검증을 켜서 검증 코드와 영지식 링크를 직접 확인해 보세요.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Ist es sicher, Dateien über das Internet zu senden?",
  description:
    "Die echten Risiken von E-Mail-Anhängen, Cloud-Links und USB-Sticks, was „Ende-zu-Ende verschlüsselt“ und „Zero-Knowledge“ wirklich bedeuten, und worauf du achten solltest, bevor du einem Tool vertraust.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "„Ist es sicher, diese Datei zu senden?“ ist eine berechtigte Frage, kurz innezuhalten — egal ob es sich um eine Steuererklärung, einen Vertrag oder einfach Fotos handelt, die privat bleiben sollen. Diese Anleitung soll dich nicht von gängigen Tools abschrecken, sondern in aller Ruhe durchgehen, was tatsächlich passiert, wenn du eine Datei per E-Mail sendest, in einen Cloud-Ordner legst oder auf einem USB-Stick mit dir herumträgst, was die Begriffe „Ende-zu-Ende verschlüsselt“ und „Zero-Knowledge“ tatsächlich versprechen, und worauf du achten solltest, bevor du einem Tool etwas Wichtiges anvertraust.",
    "Dafür ist kein technisches Vorwissen nötig. Am Ende weißt du, welche Fragen du bei jeder Übertragungsmethode stellen solltest — auch bei der hier vorgestellten.",
  ],
  sections: [
    {
      heading: "Wo Dateien tatsächlich zum Problem werden: die alltäglichen Risiken",
      body: [
        "E-Mail-Anhänge durchlaufen die Server deines Mail-Anbieters und die des Empfängers, und beide scannen, indizieren und sichern Nachrichten routinemäßig für Spam-Filterung und Notfallwiederherstellung — noch lange, nachdem du vergessen hast, dass du die Datei überhaupt verschickt hast. Wird die E-Mail einmal weitergeleitet, liegt die Datei jemandem vor, den du nie im Sinn hattest, und es gibt keine Möglichkeit zu wissen, dass wirklich jede Kopie verschwunden ist.",
        "Cloud-Speicherlinks sind bequem, aber ein Link funktioniert meist so lange weiter, bis du daran denkst, ihn zu widerrufen, und „jeder mit dem Link“ ist nur so privat wie eine schwer zu erratende URL — was ein Link-Kürzungsdienst oder eine unbedachte Weiterleitung zunichtemachen kann. Die Datei erbt außerdem die Sicherheit des gesamten Kontos, in dem sie liegt, nicht nur die der eigentlichen Freigabe.",
        "Ein USB-Stick fühlt sich sicher an, weil er offline ist, aber genau darin liegt die Lücke: Die meisten Sticks sind standardmäßig nicht verschlüsselt, sodass jemand, der einen liegen gelassenen Stick in einer Laptop-Tasche oder einem Mietwagen findet, den Klartext ohne jedes Passwort in die Hand bekommt.",
        "Kostenlose öffentliche Upload-Seiten lösen das unmittelbare Problem — eine Datei von A nach B zu bringen —, sagen aber selten, was danach passiert: wie lange die Datei aufbewahrt wird, ob sie gescannt wird, wer zufällig darüber stolpern könnte, oder wie sich die Seite finanziert (werbefinanzierte Datei-Hoster haben eine Vorgeschichte, Tracker oder Schlimmeres mitzuliefern).",
      ],
      bullets: [
        "E-Mail: wird von Mailservern aufbewahrt und gescannt, lässt sich leicht über deine Kontrolle hinaus weiterleiten",
        "Cloud-Links: funktionieren weiter, bis sie widerrufen werden, und erben die Sicherheit des gesamten Kontos",
        "USB-Sticks: standardmäßig unverschlüsselt, leicht zu verlieren oder liegen zu lassen",
        "Kostenlose Upload-Seiten: Aufbewahrung und Scan-Praktiken sind meist unklar",
      ],
    },
    {
      heading: "Was „Ende-zu-Ende verschlüsselt“ und „Zero-Knowledge“ wirklich bedeuten",
      body: [
        "Viele Dienste sagen „verschlüsselt“ und meinen damit nur, dass die Verbindung zu ihrem Server verschlüsselt ist — Standard-HTTPS/TLS, dasselbe Schloss-Symbol wie bei deiner Bank. Das ist echter Schutz gegen jemanden, der den Netzwerkverkehr abhört, endet aber am Server: Sobald deine Datei ankommt, kann der Dienst selbst sie lesen, weil er den Schlüssel besitzt. Viele alltägliche Tools hören genau da auf.",
        "Ende-zu-Ende-Verschlüsselung bedeutet etwas Stärkeres: Die Datei wird verschlüsselt, bevor sie dein Gerät verlässt, mit einem Schlüssel, den nur Absender und vorgesehener Empfänger je besitzen. Der Dienst, der sie transportiert — Server, Relay, alles dazwischen — besitzt diesen Schlüssel nie und hat deshalb auch nie den Klartext, egal wie danach gefragt wird.",
        "„Zero-Knowledge“ ist ein verwandtes Konzept, das meist auf gespeicherte statt live gesendete Daten angewendet wird: Selbst Daten, die ruhig auf einem Server liegen, wurden mit einem Schlüssel verschlüsselt, den der Server selbst nie erhalten hat — der Betreiber hat also keine Möglichkeit, sie zu lesen, egal wie lange sie dort liegen.",
      ],
      bullets: [
        "„Verschlüsselt“ allein meint oft nur TLS bis zum Server — der Anbieter kann die Datei trotzdem lesen.",
        "„Ende-zu-Ende verschlüsselt“ bedeutet, dass nur Absender und Empfänger den Schlüssel besitzen.",
        "„Zero-Knowledge“ bedeutet, dass der Server Daten besitzt, die er selbst im Ruhezustand strukturell nicht entschlüsseln kann.",
      ],
    },
    {
      heading: "Was du vor dem Vertrauen in ein Übertragungs-Tool wirklich prüfen solltest",
      prereqs: {
        label: "Was du brauchst, um diese Checkliste durchzugehen",
        items: [
          "Zehn Minuten und einen Browser. Die ersten beiden Punkte sind Lesen, kein Audit.",
          "Zwei Geräte für die Live-Punkte. Drei und vier lassen sich auf keiner Marketingseite erledigen — genau deshalb lohnen sie sich.",
          "Kein Sicherheitswissen. Jeder Punkt unten ist entweder etwas, das du lesen, oder etwas, das du geschehen sehen kannst.",
        ],
      },
      steps: [
        {
          text: "Such die Antwort des Anbieters auf \"könnt ihr meine Dateien lesen?\" in seinem Quellcode, nicht auf der Preisseite. Gibt es keinen Quellcode, ist das bereits eine Antwort.",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "Prüfe die Lizenz und ob das Repository dem entspricht, was tatsächlich läuft. Eine Behauptung, die du nachsehen kannst, ist eine andere Art von Behauptung als eine, die du glauben sollst.",
        },
        {
          text: "Vergleiche bei einer laufenden Übertragung den Verifizierungscode auf beiden Bildschirmen. Dieser Schritt macht aus \"Ende-zu-Ende-verschlüsselt\" statt eines Satzes etwas, das zwischen diesen beiden konkreten Endpunkten durchgesetzt wird.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Öffne währenddessen die Entwicklerwerkzeuge deines Browsers und sieh dir das Netzwerk-Panel an. Such im Hochgeladenen nach dem Inhalt deiner Datei. Ihn nicht zu finden ist der Punkt; ihn zu finden wäre der Befund.",
        },
        {
          text: "Prüfe, was danach bleibt: ob ein Link von selbst abläuft, und ob der Dienst die Datei später noch einmal herausgeben könnte, wenn ihn jemand danach fragt.",
        },
      ],
      success: {
        label: "Was das Bestehen dieser Liste tatsächlich sagt",
        body: [
          "Die ersten beiden Punkte sind billig und sortieren die meisten Werkzeuge in Minuten aus. Die letzten drei kann keine Landingpage vortäuschen, weil du sie auf deinen eigenen zwei Geräten geschehen siehst.",
          "Nichts davon macht ein Werkzeug abstrakt vertrauenswürdig. Es macht konkrete Behauptungen überprüfbar — und mehr kann niemand von uns tun, ohne jede Zeile selbst zu lesen.",
        ],
      },
      body: [
        "Die Marketing-Sprache auf einer Website ist weniger wert als ein paar konkrete Fragen:",
      ],
      bullets: [
        "Steht dort „verschlüsselt“ (könnte nur TLS bedeuten) oder ausdrücklich „Ende-zu-Ende verschlüsselt“ (nur Absender und Empfänger besitzen den Schlüssel)?",
        "Gibt es eine Möglichkeit zu überprüfen, dass die Verbindung nicht manipuliert wurde — ein Code, den du selbst vergleichst, statt nur ein Schloss-Symbol, dem du vertrauen musst?",
        "Wird die Integrität der Datei geprüft, sodass eine beschädigte oder veränderte Datei nicht klammheimlich falsch ankommt?",
        "Ist der Code quelloffen und auditierbar, oder sind die Behauptungen bloß Marketing, dem man glauben muss?",
        "Verlangen Senden oder Empfangen mehr Identitätspreisgabe, als für die Übertragung tatsächlich nötig ist?",
        "Falls etwas gespeichert wird — hat es eine klare, endliche Lebensdauer, etwa ein Ablaufdatum oder Löschung nach dem Download, statt unbegrenzt liegen zu bleiben?",
      ],
    },
    {
      heading: "Wie Relayium jede dieser Fragen beantwortet",
      body: [
        "Bei einer Live-Übertragung, bei der beide Seiten gleichzeitig online sind, erzeugt Relayium auf jedem Gerät ein frisches X25519-Schlüsselpaar und leitet einen gemeinsamen AES-256-GCM-Schlüssel ab, der nur innerhalb der beiden Browser existiert — er wird nie an Relayiums eigene Server gesendet. Ein optionaler kurzer Verifizierungscode (ein SAS) — er erscheint, wenn du die standardmäßig ausgeschaltete erweiterte Verifizierung einschaltest — lässt beide Seiten bestätigen, dass die Schlüssel nicht von einem unehrlichen Server in der Mitte ausgetauscht wurden, und der SHA-256-Hash jeder Datei wird Ende-zu-Ende geprüft, sodass eine beschädigte Übertragung nicht unauffällig ankommt. Wie das genau funktioniert, wird ausführlicher in „Wie Relayium deine Dateien Ende-zu-Ende verschlüsselt“ beschrieben, falls du tiefer einsteigen möchtest.",
        "Ist der Empfänger noch nicht online, nutzt ein gespeicherter Download-Link ein wirklich anderes, Zero-Knowledge-Design: Dein Browser erzeugt einen zufälligen AES-256-GCM-Schlüssel und verschlüsselt die Dateien damit, bevor überhaupt etwas hochgeladen wird. Dieser Schlüssel wird nie an den Server gesendet — er lebt nur im URL-Fragment des Links, dem Teil nach dem #, den Browser nie übertragen. Der Server besitzt am Ende nur Chiffretext, den er nicht entschlüsseln kann, plus ein von dir gewähltes Ablaufdatum: 1 Stunde, 1 Tag, 3 Tage, 7 Tage, bis zu 14 Tage je nach Tarif, oder Löschung nach dem ersten vollständigen Download.",
        "Netzübergreifend nutzt Relayiums Browser-App TURN planmäßig: Das Relay transportiert Ende-zu-Ende-verschlüsselten Chiffretext, erhält aber nie den Schlüssel und kann die Datei weder lesen noch entschlüsseln.",
        "Nichts davon verlangt, dass du einer Behauptung einfach glaubst: Relayiums Client- und Servercode ist unter der AGPL-3.0-Lizenz quelloffen und kann gelesen und geprüft werden, statt bloß geglaubt zu werden.",
      ],
      bullets: [
        "Übertragungen im selben Netzwerk benötigen überhaupt kein Konto.",
        "Das Senden über Netzwerke hinweg per Pairing-Code oder das Erstellen eines gespeicherten Links erfordert, dass sich der Absender anmeldet — der Empfänger braucht nie ein Konto.",
      ],
    },
    {
      heading: "Verschlüsselung ist nicht alles — ein paar Gewohnheiten zählen weiterhin",
      body: [
        "Starke Verschlüsselung schützt eine Datei während der Übertragung und im Ruhezustand, kann dich aber nicht davon abhalten, einen Link an die falsche Adresse zu senden — behandle einen Freigabelink wie die Datei selbst und poste ihn nicht irgendwo öffentlich.",
        "Bei wirklich sensiblen Inhalten schalte die erweiterte Verifizierung ein und nimm dir die paar zusätzlichen Sekunden, den Verifizierungscode am Telefon laut vorzulesen oder persönlich zu vergleichen, statt einfach darauf zu vertrauen, dass zwei nebeneinanderliegende, übereinstimmende Bildschirme nicht beide getäuscht wurden.",
        "Und kein noch so gut verschlüsseltes Übertragungs-Tool schützt eine Datei, die bereits auf einem kompromittierten Gerät offenliegt — gute Verschlüsselung setzt voraus, dass die beiden Endpunkte selbst vertrauenswürdig sind. Das ist kein Grund, beim Versenden von Dateien paranoid zu werden — es lohnt sich nur zu wissen, was Verschlüsselung abdeckt und was nicht.",
      ],
    },
    {
      heading: "Wenn eine Prüfung keine saubere Antwort gibt",
      body: [
        "Drei Stellen, an denen man hängen bleibt. In allen dreien steckt in der Unschärfe selbst die Information.",
      ],
      troubleshooting: {
        label: "Worauf du stößt, was du prüfst, was es bedeutet",
        items: [
          {
            symptom: "Das Netzwerk-Panel zeigt einen großen Upload, und du kannst nicht erkennen, was darin steckt.",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "Das ist das erwartete Ergebnis, keine Sackgasse. Wonach du suchst, ist das Fehlen von allem Wiedererkennbaren aus deiner Datei — ein Dateiname, den du vergeben hast, eine Zeichenfolge, von der du weißt, dass sie im Dokument steht. Kannst du deinen eigenen Inhalt in der Nutzlast lesen, ist genau das der Befund, und ein eindeutiger.",
          },
          {
            symptom: "Es gibt keinen Verifizierungscode, der dritte Punkt geht also nicht.",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "Du bist bei einer gespeicherten Link-Übertragung statt einer Live-Übertragung. Es ist kein zweiter Endpunkt online, gegen den man vergleichen könnte, die Zusage hat also eine andere Form: der Schlüssel steckt im Link-Fragment und erreicht den Server nie. Bei Live-Übertragungen vergleichst du Codes, bei gespeicherten prüfst du den Ablauf des Links.",
          },
          {
            symptom: "Der Quellcode ist offen, aber du kannst die Sprache nicht lesen, in der er geschrieben ist.",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "Musst du auch nicht. Die Frage, die dieser Punkt beantwortet, ist, ob die Behauptung überhaupt widerlegbar ist: gibt es ein Repository, entspricht es dem, was läuft, könnte jemand, der die Sprache liest, widersprechen. Eine Behauptung, die niemand in der Lage ist zu prüfen, ist selbst der Befund.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Ist es sicher, eine sensible Datei per E-Mail zu senden?",
        a: "E-Mail ist nicht für vertrauliche Dateiübertragung konzipiert — Anhänge werden auf beiden Seiten routinemäßig von Mailservern aufbewahrt, gescannt und gesichert, und eine weitergeleitete Nachricht kann die Datei Personen vorlegen, die du nie im Sinn hattest. Für unkritische Dateien ist das in Ordnung; bei sensiblen Inhalten beseitigt ein Tool mit Ende-zu-Ende-Verschlüsselung diese Angriffsfläche.",
      },
      {
        q: "Was bedeutet „Zero-Knowledge“ eigentlich?",
        a: "Dass die Partei, die deine Daten speichert, nie den Schlüssel erhalten hat, um sie zu lesen. Die Verschlüsselung erfolgt auf deinem Gerät, bevor überhaupt etwas hochgeladen wird, und der Schlüssel liegt nur an einem Ort, den der Server nie sieht — etwa im URL-Fragment. Was auf dem Server liegt, ist also Chiffretext, den er strukturell nicht entschlüsseln kann, nicht nur Daten, die er verspricht, nicht anzusehen.",
      },
      {
        q: "Reicht eine passwortgeschützte ZIP-Datei aus?",
        a: "Besser als nichts, aber das Passwort reist oft auf demselben Weg wie die Datei selbst — etwa im selben E-Mail-Thread —, was den Schutz zunichtemacht, und ZIP-Verschlüsselungen unterscheiden sich stark in ihrer Stärke je nach Implementierung. Ein Tool, das auf Ende-zu-Ende-Verschlüsselung basiert, benötigt von vornherein kein gemeinsames Passwort und beseitigt damit diese Schwachstelle.",
      },
      {
        q: "Behält Relayium eine Kopie meiner Dateien?",
        a: "Im Echtzeitmodus bewahrt Relayium keine serverseitige Kopie oder Übertragungshistorie auf: Im selben LAN verbindet WebRTC direkt; netzübergreifende Browser-Sitzungen nutzen planmäßig TURN für Ende-zu-Ende-verschlüsselten Chiffretext, den das Relay weder lesen noch entschlüsseln kann. Bei einem gespeicherten Link besitzt der Server nur verschlüsselten Chiffretext, den er nicht lesen kann, bis der Link abläuft oder, wenn du Burn-after-read gewählt hast, einmal heruntergeladen wurde.",
      },
      {
        q: "Brauche ich ein Konto, um eine Datei zu senden oder zu empfangen?",
        a: "Im selben Netzwerk braucht keine Seite ein Konto. Das Senden über Netzwerke hinweg per Pairing-Code oder das Erstellen eines gespeicherten Links erfordert, dass sich der Absender anmeldet — aber die empfangende Person braucht in keinem Fall ein Konto.",
      },
    ],
  },
  cta: {
    text: "Neugierig, ob ein Tool wirklich das schützt, was es verspricht? Starte eine Übertragung, schalte die erweiterte Verifizierung ein und sieh dir den Verifizierungscode und den Zero-Knowledge-Link selbst an.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Est-il sûr d'envoyer des fichiers sur Internet ?",
  description:
    "Les vrais risques des pièces jointes, des liens cloud et des clés USB, ce que « chiffré de bout en bout » et « divulgation nulle » signifient réellement, et ce qu'il faut vérifier avant de faire confiance à un outil de transfert.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "« Est-ce sûr d'envoyer ce fichier ? » est une question raisonnable à se poser, qu'il s'agisse d'une déclaration d'impôts, d'un contrat, ou simplement de photos que vous préféreriez garder privées. Ce guide n'a pas pour but de vous détourner des outils courants — il s'agit d'expliquer clairement ce qui se passe réellement quand vous envoyez un fichier par e-mail, le déposez dans un dossier cloud, ou le transportez sur une clé USB, ce que les expressions « chiffré de bout en bout » et « divulgation nulle » promettent réellement, et ce qu'il faut vérifier avant de confier quelque chose d'important à n'importe quel outil.",
    "Rien de tout cela ne nécessite de connaissances techniques. À la fin, vous saurez quelles questions poser — pour n'importe quelle méthode de transfert, y compris celle présentée ici.",
  ],
  sections: [
    {
      heading: "Où les fichiers posent vraiment problème : les risques du quotidien",
      body: [
        "Les pièces jointes aux e-mails passent par les serveurs de votre fournisseur de messagerie et ceux du destinataire, et les deux analysent, indexent et sauvegardent couramment les messages pour le filtrage antispam et la reprise après sinistre — bien après que vous ayez oublié avoir envoyé ce fichier. Un e-mail transféré une seule fois, et le fichier se retrouve devant quelqu'un que vous n'aviez jamais prévu, sans aucun moyen de savoir si toutes les copies ont disparu.",
        "Les liens de stockage cloud sont pratiques, mais un lien continue généralement de fonctionner jusqu'à ce que vous pensiez à le révoquer, et « toute personne disposant du lien » n'est privé que dans la mesure où l'URL est difficile à deviner — ce qu'un raccourcisseur de lien ou un transfert malencontreux peut annuler. Le fichier hérite aussi de la sécurité de tout le compte dans lequel il se trouve, pas seulement de ce partage précis.",
        "Une clé USB paraît sûre parce qu'elle est hors ligne, mais c'est précisément là le problème : la plupart des clés ne sont pas chiffrées par défaut, donc une clé oubliée dans un sac d'ordinateur portable ou une voiture de location remet le contenu en clair à quiconque la trouve, sans aucun mot de passe requis.",
        "Les sites de téléversement publics et gratuits résolvent le problème immédiat — faire passer un fichier de A à B — mais précisent rarement ce qui se passe ensuite : combien de temps il est conservé, s'il est analysé, qui pourrait tomber dessus par hasard, ou comment le site finance ses coûts (les hébergeurs de fichiers financés par la publicité ont un historique d'ajout de traceurs, voire pire).",
      ],
      bullets: [
        "E-mail : conservé et analysé par les serveurs de messagerie, facile à transférer au-delà de votre contrôle",
        "Liens cloud : continuent de fonctionner jusqu'à révocation, et héritent de la sécurité de tout le compte",
        "Clés USB : non chiffrées par défaut, faciles à perdre ou à oublier",
        "Sites de téléversement gratuits : pratiques de conservation et d'analyse généralement peu claires",
      ],
    },
    {
      heading: "Ce que « chiffré de bout en bout » et « divulgation nulle » signifient réellement",
      body: [
        "De nombreux services disent « chiffré » alors qu'ils veulent simplement dire que la connexion à leur serveur est chiffrée — le HTTPS/TLS standard, la même icône de cadenas que celle de votre banque. C'est une vraie protection contre quelqu'un qui écouterait le réseau, mais elle s'arrête au serveur : une fois votre fichier arrivé, le service lui-même peut le lire, parce qu'il détient la clé. Beaucoup d'outils du quotidien s'arrêtent exactement là.",
        "Le chiffrement de bout en bout signifie quelque chose de plus fort : le fichier est chiffré avant même de quitter votre appareil, avec une clé que seuls l'expéditeur et le destinataire possèdent. Le service qui le transporte — le serveur, le relais, tout ce qui se trouve entre les deux — ne possède jamais cette clé, et n'a donc jamais le contenu en clair, quoi qu'on lui demande.",
        "La « divulgation nulle » est une idée voisine, généralement appliquée à ce qui est stocké plutôt qu'envoyé en direct : même des données posées tranquillement sur un serveur ont été chiffrées avec une clé que le serveur lui-même n'a jamais reçue, si bien que l'opérateur n'a aucun moyen de les lire, quelle que soit la durée pendant laquelle elles y restent.",
      ],
      bullets: [
        "« Chiffré » tout seul signifie souvent simplement du TLS jusqu'au serveur — le fournisseur peut toujours lire le fichier.",
        "« Chiffré de bout en bout » signifie que seuls l'expéditeur et le destinataire détiennent la clé.",
        "« Divulgation nulle » signifie que le serveur détient des données qu'il ne peut structurellement pas déchiffrer, même au repos.",
      ],
    },
    {
      heading: "Ce qu'il faut vraiment vérifier avant de faire confiance à un outil de transfert",
      prereqs: {
        label: "Ce qu'il vous faut pour dérouler cette liste",
        items: [
          "Dix minutes et un navigateur. Les deux premiers points relèvent de la lecture, pas de l'audit.",
          "Deux appareils pour les points en direct. Le troisième et le quatrième ne se font pas depuis une page marketing — c'est précisément ce qui les rend utiles.",
          "Aucune expertise en sécurité. Chaque point ci-dessous est soit quelque chose que vous pouvez lire, soit quelque chose que vous pouvez voir se produire.",
        ],
      },
      steps: [
        {
          text: "Cherchez la réponse de l'éditeur à « pouvez-vous lire mes fichiers ? » dans son code source, pas sur sa page tarifs. S'il n'y a pas de source, c'est déjà une réponse.",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "Vérifiez la licence, et si le dépôt correspond bien à ce qui est déployé. Une affirmation que vous pouvez inspecter n'est pas du même ordre qu'une affirmation qu'on vous demande d'accepter.",
        },
        {
          text: "Sur un transfert en cours, comparez le code de vérification affiché sur les deux écrans. C'est l'étape qui fait passer « chiffré de bout en bout » du statut de phrase à celui de garantie appliquée entre ces deux extrémités précises.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Pendant ce transfert, ouvrez les outils de développement de votre navigateur et regardez le panneau réseau. Cherchez le contenu de votre fichier dans ce qui est envoyé. Ne pas l'y trouver est le but ; l'y trouver serait le résultat.",
        },
        {
          text: "Vérifiez ce qui subsiste ensuite : si un lien expire de lui-même, et si le service pourrait encore ressortir le fichier plus tard si on le lui demandait.",
        },
      ],
      success: {
        label: "Ce que réussir cette liste vous apprend réellement",
        body: [
          "Les deux premiers points ne coûtent rien et éliminent la plupart des outils en quelques minutes. Les trois derniers, aucune page d'accueil ne peut les simuler, parce que vous les voyez se produire sur vos deux propres appareils.",
          "Rien de tout cela ne rend un outil digne de confiance dans l'absolu. Cela rend des affirmations précises vérifiables, et c'est le maximum que chacun puisse faire sans lire soi-même chaque ligne.",
        ],
      },
      body: [
        "Le langage marketing d'un site web vaut moins que quelques questions concrètes :",
      ],
      bullets: [
        "Est-il dit « chiffré » (ce qui pourrait n'être que du TLS) ou explicitement « chiffré de bout en bout » (seuls l'expéditeur et le destinataire détiennent la clé) ?",
        "Existe-t-il un moyen de vérifier que la connexion n'a pas été altérée — un code que vous comparez vous-même, et pas seulement une icône de cadenas à laquelle il faut faire confiance ?",
        "L'intégrité du fichier est-elle vérifiée, pour qu'un fichier corrompu ou modifié n'arrive pas silencieusement en paraissant intact ?",
        "Le code est-il open source et auditable, ou ces affirmations ne sont-elles que du marketing à croire sur parole ?",
        "L'envoi ou la réception exigent-ils de révéler plus d'identité que le transfert n'en a réellement besoin ?",
        "Si quelque chose est stocké, a-t-il une durée de vie claire et limitée — une expiration ou une suppression après téléchargement — plutôt que de rester là indéfiniment ?",
      ],
    },
    {
      heading: "Comment Relayium répond à chacun de ces points",
      body: [
        "Pour un transfert en direct, avec les deux personnes en ligne en même temps, Relayium génère une nouvelle paire de clés X25519 sur chaque appareil et dérive une clé AES-256-GCM partagée qui n'existe qu'à l'intérieur des deux navigateurs — elle n'est jamais envoyée aux serveurs de Relayium eux-mêmes. Un court code de vérification facultatif (un SAS), affiché lorsque vous activez la vérification avancée — désactivée par défaut —, permet aux deux parties de confirmer que les clés n'ont pas été substituées par un serveur malhonnête au milieu, et le hachage SHA-256 de chaque fichier est vérifié de bout en bout, si bien qu'un transfert corrompu n'arrive pas en paraissant intact. Le détail exact de ce mécanisme est expliqué plus en profondeur dans « Comment Relayium chiffre vos fichiers de bout en bout », si vous voulez aller plus loin que cette page.",
        "Quand le destinataire n'est pas encore en ligne, un lien de téléchargement stocké utilise un mécanisme réellement différent, à divulgation nulle : votre navigateur génère une clé AES-256-GCM aléatoire et l'utilise pour chiffrer les fichiers avant tout envoi. Cette clé n'est jamais envoyée au serveur — elle ne vit que dans le fragment d'URL du lien, la partie après le #, que les navigateurs ne transmettent jamais. Le serveur finit par détenir uniquement du texte chiffré qu'il n'a aucun moyen de déchiffrer, plus une expiration que vous choisissez : 1 heure, 1 jour, 3 jours, 7 jours, jusqu'à 14 jours selon votre offre, ou autodestruction après le premier téléchargement complet.",
        "Entre réseaux, l'application navigateur Relayium utilise TURN par conception : le relais transporte du texte chiffré de bout en bout, mais ne reçoit jamais la clé et ne peut ni lire ni déchiffrer le fichier.",
        "Rien de tout cela ne vous demande de croire une affirmation sur parole : le code client et serveur de Relayium est open source sous licence AGPL-3.0, et peut donc être lu et audité plutôt que simplement cru.",
      ],
      bullets: [
        "Les transferts sur le même réseau ne nécessitent aucun compte du tout.",
        "Envoyer entre réseaux via un code d'appairage, ou créer un lien stocké, exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte.",
      ],
    },
    {
      heading: "Le chiffrement n'est pas tout — quelques habitudes comptent encore",
      body: [
        "Un chiffrement solide protège un fichier en transit et au repos, mais il ne peut pas vous empêcher d'envoyer un lien à la mauvaise adresse — traitez un lien de partage comme le fichier lui-même, et ne le publiez pas quelque part de public.",
        "Pour tout ce qui est vraiment sensible, activez la vérification avancée et prenez les quelques secondes supplémentaires pour comparer le code de vérification à voix haute lors d'un appel, ou en personne, plutôt que de faire confiance au fait que deux écrans côte à côte qui correspondent n'aient pas tous deux été trompés.",
        "Et aucun outil de transfert, aussi bien chiffré soit-il, ne protège un fichier déjà exposé sur un appareil compromis — un bon chiffrement suppose que les deux extrémités elles-mêmes sont dignes de confiance. Rien de tout cela n'est une raison de devenir paranoïaque à l'idée d'envoyer des fichiers ; il vaut simplement la peine de savoir ce que le chiffrement couvre, et ce qu'il ne couvre pas.",
      ],
    },
    {
      heading: "Quand une vérification ne donne pas de réponse nette",
      body: [
        "Trois endroits où l'on bloque. Dans chacun, le flou lui-même est instructif.",
      ],
      troubleshooting: {
        label: "Ce sur quoi vous tombez, ce qu'il faut vérifier, ce que cela signifie",
        items: [
          {
            symptom: "Le panneau réseau montre un gros envoi et vous ne pouvez pas dire ce qu'il contient.",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "C'est le résultat attendu, pas une impasse. Ce que vous cherchez, c'est l'absence de tout élément reconnaissable de votre fichier — un nom de fichier que vous avez choisi, une chaîne dont vous savez qu'elle est dans le document. Si vous pouvez lire votre propre contenu dans la charge utile, c'est cela le résultat, et il est décisif.",
          },
          {
            symptom: "Il n'y a pas de code de vérification, le troisième point est donc impossible.",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "Vous êtes sur un transfert par lien stocké et non sur un transfert en direct. Aucune seconde extrémité n'est en ligne pour la comparaison, la garantie a donc une autre forme : la clé vit dans le fragment du lien et n'atteint jamais le serveur. Comparez les codes sur les transferts en direct, et vérifiez l'expiration du lien sur les transferts stockés.",
          },
          {
            symptom: "Le code est ouvert, mais vous ne lisez pas le langage dans lequel il est écrit.",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "Vous n'avez pas à le lire. La question à laquelle ce point répond est de savoir si l'affirmation est seulement réfutable : y a-t-il un dépôt, correspond-il à ce qui est déployé, quelqu'un qui lit ce langage pourrait-il la contredire. Une affirmation que personne n'est en mesure de vérifier constitue elle-même le résultat.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Est-il sûr d'envoyer un fichier sensible par e-mail ?",
        a: "L'e-mail n'est pas conçu pour le transfert confidentiel de fichiers — les pièces jointes sont couramment conservées, analysées et sauvegardées par les serveurs de messagerie des deux côtés, et un message transféré peut mettre le fichier sous les yeux de personnes que vous n'aviez jamais prévues. C'est acceptable pour des fichiers peu sensibles ; pour quelque chose de sensible, un outil chiffré de bout en bout supprime cette exposition.",
      },
      {
        q: "Que signifie réellement « divulgation nulle » ?",
        a: "Que la partie qui stocke vos données n'a jamais reçu la clé pour les lire. Le chiffrement se fait sur votre appareil avant tout envoi, et la clé ne vit que là où le serveur ne la voit jamais — comme un fragment d'URL — si bien que ce qui se trouve sur le serveur est du texte chiffré qu'il ne peut structurellement pas déchiffrer, pas simplement des données qu'il promet de ne pas regarder.",
      },
      {
        q: "Un fichier zip protégé par mot de passe suffit-il ?",
        a: "C'est mieux que rien, mais le mot de passe voyage souvent par le même canal que le fichier — dans le même fil d'e-mails, par exemple —, ce qui annule la protection, et les implémentations du chiffrement zip varient beaucoup en solidité. Un outil construit autour du chiffrement de bout en bout supprime ce maillon faible en n'ayant jamais besoin d'un mot de passe partagé.",
      },
      {
        q: "Relayium conserve-t-il une copie de mes fichiers ?",
        a: "En mode temps réel, Relayium ne conserve aucune copie côté serveur ni aucun historique de transfert : sur le même LAN, WebRTC se connecte directement ; entre réseaux, les sessions navigateur utilisent TURN par conception pour transporter un texte chiffré de bout en bout que le relais ne peut ni lire ni déchiffrer. Pour un lien stocké, le serveur ne détient que du texte chiffré qu'il ne peut pas lire, jusqu'à ce que le lien expire ou soit téléchargé une fois si vous avez choisi l'autodestruction après lecture.",
      },
      {
        q: "Ai-je besoin d'un compte pour envoyer ou recevoir un fichier ?",
        a: "Sur le même réseau, aucun des deux côtés n'a besoin de compte. Envoyer entre réseaux via un code d'appairage, ou créer un lien stocké, exige que l'expéditeur se connecte — mais la personne qui reçoit n'a jamais besoin de compte, quel que soit le mode utilisé.",
      },
    ],
  },
  cta: {
    text: "Curieux de savoir si un outil protège vraiment ce qu'il prétend ? Lancez un transfert, activez la vérification avancée et observez par vous-même le code de vérification et le lien à divulgation nulle.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "هل من الآمن إرسال الملفات عبر الإنترنت؟",
  description:
    "ما الذي يحدث فعلًا من مشكلات مع البريد الإلكتروني وروابط السحابة ومحركات USB — وما الذي يعنيه حقًا «التشفير من الطرف إلى الطرف» و«المعرفة الصفرية»، وما الذي ينبغي التحقق منه قبل الوثوق بأداة نقل.",
  updatedLabel: "آخر تحديث",
  lead: [
    "«هل من الآمن إرسال هذا الملف؟» سؤال معقول يستحق أن تتوقف وتطرحه، سواء أكان إقرارًا ضريبيًا أم عقدًا أم مجرد صور تفضّل أن تبقى خاصة. لا تهدف هذه المقالة إلى تنفيرك من الأدوات الشائعة — بل إلى أن تستعرض بوضوح ما الذي يحدث فعلًا لملف حين ترسله بالبريد الإلكتروني، أو تضعه في مجلد سحابي، أو تحمله على ذاكرة USB، وما الذي تَعِد به عبارتا «التشفير من الطرف إلى الطرف» و«المعرفة الصفرية» فعلًا، وما الذي ينبغي التحقق منه قبل أن تأتمن أي أداة على شيء يهمّك.",
    "لا يتطلّب أيٌّ من هذا خلفية تقنية. وبحلول النهاية، ستعرف ما الأسئلة التي ينبغي طرحها — على أي طريقة نقل، بما فيها هذه الطريقة.",
  ],
  sections: [
    {
      heading: "أين تتعرّض الملفات للخطر فعلًا: المخاطر اليومية",
      body: [
        "تمرّ مرفقات البريد الإلكتروني عبر خوادم مزوّد بريدك وخوادم المُستقبِل، وكلاهما عادةً يفحص الرسائل ويفهرسها وينشئ نسخًا احتياطية منها لغرض تصفية البريد المزعج والتعافي من الكوارث — بعد وقت طويل من نسيانك أنك أرسلتها. أعد توجيه البريد مرة واحدة، ويصبح الملف أمام شخص لم تقصده قط، دون أي وسيلة للتأكد من أن كل نسخة قد زالت.",
        "روابط التخزين السحابي مريحة، لكن الرابط عادةً يظل يعمل حتى تتذكّر إبطاله، و«أي شخص لديه الرابط» ليس خاصًا إلا بقدر عنوان URL يصعب تخمينه — وهو ما قد تُبطِله خدمة اختصار روابط أو إعادة توجيه غير مبالية. كما يرث الملف أمان الحساب كله الذي يقبع فيه، لا أمان المشاركة نفسها فقط.",
        "تبدو ذاكرة USB آمنة لأنها غير متصلة بالإنترنت، لكن هذا بالضبط هو مكمن الثغرة: معظم المحركات غير مشفّرة افتراضيًا، فذاكرة تُركت في حقيبة حاسوب محمول أو في سيارة مستأجرة تسلّم النص الصريح لمن يجدها، دون الحاجة إلى أي كلمة مرور.",
        "تحلّ مواقع الرفع العامة المجانية المشكلة الآنية — نقل ملف من ألف إلى باء — لكنها نادرًا ما تقول ما الذي يحدث بعد ذلك: كم يُحتفَظ به، وهل يُفحَص، ومن قد يعثر عليه مصادفةً، وكيف يغطّي الموقع نفقاته (مواقع استضافة الملفات المموَّلة بالإعلانات لها سجلّ في تضمين أدوات التتبّع أو ما هو أسوأ).",
      ],
      bullets: [
        "البريد الإلكتروني: تحتفظ به خوادم البريد وتفحصه، ويسهل إعادة توجيهه خارج نطاق سيطرتك",
        "روابط السحابة: تظل تعمل حتى إبطالها، وترث أمان الحساب كله",
        "محركات USB: غير مشفّرة افتراضيًا، ويسهل فقدانها أو نسيانها",
        "مواقع الرفع المجانية: ممارسات الاحتفاظ والفحص عادةً غير واضحة",
      ],
    },
    {
      heading: "ما الذي يعنيه فعلًا «التشفير من الطرف إلى الطرف» و«المعرفة الصفرية»",
      body: [
        "كثير من الخدمات تقول «مشفّر» ولا تعني بذلك سوى أن الاتصال بخادمها مشفّر — أي HTTPS/TLS القياسي، نفس أيقونة القفل التي يستخدمها مصرفك. هذه حماية حقيقية ضد من يتنصّت على الشبكة، لكنها تتوقف عند الخادم: ما إن يصل ملفك، حتى تستطيع الخدمة نفسها قراءته، لأنها تملك المفتاح. وكثير من الأدوات اليومية تتوقف عند هذا الحد بالضبط.",
        "يعني التشفير من الطرف إلى الطرف شيئًا أقوى: يُشفَّر الملف قبل أن يغادر جهازك، بمفتاح لا يملكه سوى المُرسِل والمُستقبِل المقصود. أما الخدمة التي تحمله — الخادم، المُرحِّل، وأي شيء بينهما — فلا تملك المفتاح أبدًا، ولذلك لا تملك النص الصريح أبدًا، مهما طُلِب منها ذلك.",
        "«المعرفة الصفرية» فكرة ذات صلة تُطبَّق عادةً على شيء مُخزَّن لا مُرسَل بشكل فوري: حتى البيانات القابعة على خادم شُفِّرت بمفتاح لم يُعطَ للخادم نفسه قط، فلا سبيل للمشغّل إلى قراءتها أبدًا، مهما طالت مدة بقائها هناك.",
      ],
      bullets: [
        "كلمة «مشفّر» وحدها كثيرًا ما تعني مجرد TLS حتى الخادم — ولا يزال بإمكان المزوّد قراءة الملف.",
        "«التشفير من الطرف إلى الطرف» يعني أن المُرسِل والمُستقبِل وحدهما يملكان المفتاح.",
        "«المعرفة الصفرية» تعني أن الخادم يحمل بيانات لا يستطيع فك تشفيرها بنيويًا، حتى وهي قابعة.",
      ],
    },
    {
      heading: "ما الذي ينبغي التحقق منه فعلًا قبل الوثوق بأداة نقل",
      prereqs: {
        label: "ما تحتاجه لتنفيذ قائمة الفحص هذه",
        items: [
          "عشر دقائق ومتصفّح. فالبندان الأولان قراءة لا تدقيق.",
          "جهازان للبنود الحيّة. فالبندان الثالث والرابع لا يمكن إجراؤهما من صفحة تسويقية، وهذا بالضبط ما يجعلهما جديرين بالتنفيذ.",
          "لا حاجة إلى خبرة أمنية. فكل بند أدناه إمّا شيء تستطيع قراءته وإمّا شيء تستطيع أن تراه يحدث.",
        ],
      },
      steps: [
        {
          text: "ابحث عن جواب المزوّد نفسه عن سؤال «هل تستطيعون قراءة ملفاتي؟» داخل شفرته المصدرية، لا في صفحة الأسعار. وإن لم تكن هناك شفرة مصدرية فذلك في حد ذاته جواب.",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "تحقّق من الرخصة، ومن أن المستودع يقابل ما هو منشور فعلًا. فالادّعاء الذي يمكنك فحصه نوع مختلف عن الادّعاء الذي يُطلب منك قبوله.",
        },
        {
          text: "في نقل حيّ، قارن رمز التحقّق على الشاشتين. فهذه هي الخطوة التي تحوّل «التشفير من الطرف إلى الطرف» من جملة إلى شيء يُطبَّق فعلًا بين هذين الطرفين تحديدًا.",
          code: ["https://relayium.com/"],
        },
        {
          text: "وأثناء ذلك النقل، افتح أدوات المطوّر في متصفّحك وراقب لوحة الشبكة. وابحث عن محتوى ملفك داخل ما يجري رفعه. فألّا تجده هو المقصود، وأن تجده هو النتيجة.",
        },
        {
          text: "تحقّق مما يبقى بعد ذلك: هل ينتهي الرابط من تلقاء نفسه، وهل تستطيع الخدمة إخراج الملف مرة أخرى لاحقًا لو طُلب منها ذلك.",
        },
      ],
      success: {
        label: "ماذا يخبرك اجتياز هذه القائمة فعلًا",
        body: [
          "البندان الأولان رخيصان ويستبعدان معظم الأدوات في دقائق. أما البنود الثلاثة الأخيرة فلا تستطيع صفحة هبوط تزييفها، لأنك تراها تحدث على جهازيك أنت.",
          "ولا شيء من هذا يجعل أداةً جديرة بالثقة على نحو مجرَّد. إنه يجعل ادّعاءات محدَّدة قابلة للفحص، وهذا أقصى ما يستطيعه أيٌّ منا دون قراءة كل سطر بنفسه.",
        ],
      },
      body: [
        "لغة التسويق على أي موقع أقل قيمة من بضعة أسئلة ملموسة:",
      ],
      bullets: [
        "هل تقول «مشفّر» (قد تعني مجرد TLS) أم تقول تحديدًا «التشفير من الطرف إلى الطرف» (المُرسِل والمُستقبِل وحدهما يملكان المفتاح)؟",
        "هل هناك طريقة للتحقق من أن الاتصال لم يُعبَث به — رمز تقارنه، لا مجرد أيقونة قفل عليك أن تثق بها؟",
        "هل يُتحقَّق من سلامة الملف، بحيث لا يصل ملف تالف أو مُعدَّل خاطئًا بصمت؟",
        "هل الشيفرة مفتوحة المصدر وقابلة للتدقيق، أم أن الادّعاءات مجرد تسويق عليك تصديقه على عِلّاته؟",
        "هل يتطلّب الإرسال أو الاستقبال تسليم هوية أكثر مما تحتاجه عملية النقل فعلًا؟",
        "إذا خُزِّن أي شيء، فهل له عمر واضح ومحدود — انتهاء صلاحية أو حذف بعد التنزيل — بدلًا من بقائه هناك إلى أجل غير مسمّى؟",
      ],
    },
    {
      heading: "كيف يجيب Relayium عن كلٍّ من هذه",
      body: [
        "في النقل الفوري، مع وجود الطرفين متصلَين في آن واحد، يولّد Relayium زوج مفاتيح X25519 جديدًا على كل جهاز ويشتقّ مفتاح AES-256-GCM مشتركًا موجودًا فقط داخل المتصفحَين — ولا يُرسَل أبدًا إلى خوادم Relayium نفسها. ويتيح رمز تحقق قصير اختياري (SAS) — يظهر عند تفعيل «التحقّق المتقدّم» المعطَّل افتراضيًا — للطرفين تأكيد أن المفاتيح لم تُستبدَل من قِبَل خادم غير نزيه في المنتصف، وتُفحَص تجزئة SHA-256 لكل ملف من الطرف إلى الطرف حتى لا يصل نقل تالف وهو يبدو سليمًا. أما تفاصيل كيفية عمل ذلك بالضبط فتُشرَح بعمق أكبر في «كيف يُشفِّر Relayium ملفاتك من الطرف إلى الطرف»، إن أردت التعمّق أكثر من هذه الصفحة.",
        "حين لا يكون المُستقبِل متصلًا بعد، يستخدم رابط التنزيل المُخزَّن تصميمًا مختلفًا فعلًا بمعرفة صفرية: يولّد متصفحك مفتاح AES-256-GCM عشوائيًا ويشفّر به الملفات قبل رفع أي شيء. لا يُرسَل هذا المفتاح إلى الخادم أبدًا — بل يوجد فقط في جزء عنوان الرابط (URL fragment)، وهو الجزء الذي يلي #، والذي لا ترسله المتصفحات أبدًا. ينتهي الأمر بالخادم حاملًا نصًا مُشفَّرًا لا سبيل له إلى فك تشفيره، إضافة إلى مدة انتهاء صلاحية تختارها أنت: ساعة واحدة، أو يوم واحد، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب باقتك، أو الحذف بعد أول تنزيل مكتمل.",
        "عبر الشبكات يستخدم تطبيق Relayium في المتصفح TURN حسب التصميم: ينقل المُرحِّل نصًا مشفّرًا من الطرف إلى الطرف، لكنه لا يتلقى المفتاح أبدًا ولا يستطيع قراءة الملف أو فك تشفيره.",
        "لا يطلب أيٌّ من هذا أن تصدّق ادّعاءً على عِلّاته: شيفرة عميل Relayium وخادمه مفتوحة المصدر بموجب رخصة AGPL-3.0، فيمكن قراءتها وتدقيقها بدلًا من تصديقها على عِلّاته.",
      ],
      bullets: [
        "لا تحتاج عمليات النقل داخل الشبكة نفسها إلى أي حساب على الإطلاق.",
        "الإرسال عبر الشبكات برمز الاقتران، أو إنشاء رابط مُخزَّن، يتطلّب تسجيل دخول المُرسِل — أما المُستقبِل فلا يحتاج إلى حساب أبدًا.",
      ],
    },
    {
      heading: "التشفير ليس القصة كلها — لا تزال بعض العادات مهمة",
      body: [
        "يحمي التشفير القوي الملف أثناء نقله وأثناء تخزينه، لكنه لا يمنعك من إرسال رابط إلى العنوان الخطأ — تعامل مع رابط المشاركة كأنه الملف نفسه، ولا تنشره في مكان عام.",
        "بالنسبة لأي شيء حسّاس فعلًا، فعِّل التحقّق المتقدّم وخصّص بضع ثوانٍ إضافية لمقارنة رمز التحقق بصوت عالٍ عبر مكالمة، أو وجهًا لوجه، بدلًا من الثقة بأن شاشتين متطابقتين متجاورتين لم تُخدَعا كلتاهما.",
        "ولا توجد أداة نقل، مهما بلغت جودة تشفيرها، تحمي ملفًا منكشفًا أصلًا على جهاز مُخترَق — فالتشفير الجيد يفترض أن الطرفين نفسيهما جديران بالثقة. لا شيء من هذا سبب للإصابة بجنون الارتياب من إرسال الملفات؛ إنما من المفيد فقط أن تعرف ما الذي يغطّيه التشفير وما لا يغطّيه.",
      ],
    },
    {
      heading: "حين لا يعطيك الفحص جوابًا واضحًا",
      body: [
        "ثلاثة مواضع يتعثّر الناس عندها. وفي كل حالة منها يكون الغموض نفسه ذا دلالة.",
      ],
      troubleshooting: {
        label: "ما تصادفه، وما تفحصه، وماذا يعني",
        items: [
          {
            symptom: "تُظهر لوحة الشبكة رفعًا كبيرًا ولا تستطيع معرفة ما بداخله.",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "هذه هي النتيجة المتوقَّعة لا طريقًا مسدودًا. فما تبحث عنه هو غياب أي شيء يمكن التعرّف عليه من ملفك — اسم ملف اخترته أنت، أو نص تعرف أنه موجود في المستند. فإن استطعت قراءة محتواك داخل الحمولة فتلك هي النتيجة، وهي حاسمة.",
          },
          {
            symptom: "لا يوجد رمز تحقّق، فلا يمكن تنفيذ البند الثالث.",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "أنت في نقل عبر رابط مخزَّن لا في نقل حيّ. فلا يوجد طرف ثانٍ متصل لتقارن معه، ومن ثمّ فشكل الضمان مختلف: المفتاح يعيش في جزء الرابط ولا يصل إلى الخادم إطلاقًا. قارن الرموز في عمليات النقل الحيّة، وتحقّق من انتهاء صلاحية الرابط في المخزَّنة.",
          },
          {
            symptom: "الشفرة مفتوحة لكنك لا تقرأ اللغة المكتوبة بها.",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "لست مضطرًا. فالسؤال الذي يجيب عنه هذا الفحص هو: هل الادّعاء قابل للدحض أصلًا؟ هل هناك مستودع، وهل يقابل ما هو منشور، وهل يستطيع من يقرأ تلك اللغة أن يناقضه. والادّعاء الذي لا أحد في موضع يتيح له فحصه هو نفسه النتيجة.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل من الآمن إرسال ملف حسّاس بالبريد الإلكتروني؟",
        a: "لم يُصمَّم البريد الإلكتروني لنقل الملفات السرية — فالمرفقات عادةً تُحتفَظ بها خوادم البريد على الطرفين وتُفحَص وتُنسَخ احتياطيًا، ويمكن لرسالة معاد توجيهها أن تضع الملف أمام أشخاص لم تقصدهم قط. لا بأس بذلك للملفات قليلة الأهمية؛ أما لأي شيء حسّاس، فأداة تعتمد التشفير من الطرف إلى الطرف تُزيل هذا الانكشاف.",
      },
      {
        q: "ما الذي تعنيه «المعرفة الصفرية» فعلًا؟",
        a: "تعني أن الطرف الذي يخزّن بياناتك لم يُعطَ قط المفتاح اللازم لقراءتها. يحدث التشفير على جهازك قبل رفع أي شيء، ويوجد المفتاح فقط في مكان لا يراه الخادم أبدًا — مثل جزء عنوان الرابط (URL fragment) — فيكون ما يقبع على الخادم نصًا مُشفَّرًا لا يستطيع فك تشفيره بنيويًا، لا مجرد بيانات يَعِد بألّا ينظر إليها.",
      },
      {
        q: "هل يكفي ملف مضغوط محميّ بكلمة مرور؟",
        a: "هذا أفضل من لا شيء، لكن كلمة المرور غالبًا ما تسير بالطريق نفسه الذي يسير به الملف — في سلسلة رسائل البريد الإلكتروني نفسها مثلًا — وهو ما يُبطِل الحماية، كما أن قوة تطبيقات تشفير الملفات المضغوطة تتفاوت تفاوتًا كبيرًا. أما أداة مبنية على التشفير من الطرف إلى الطرف فتُزيل هذه الحلقة الضعيفة بعدم حاجتها إلى كلمة مرور مشتركة من الأساس.",
      },
      {
        q: "هل يحتفظ Relayium بنسخة من ملفاتي؟",
        a: "في الوضع الفوري لا يحتفظ Relayium بنسخة على الخادم أو بسجل للنقل: داخل شبكة LAN نفسها يتصل WebRTC مباشرةً، أما جلسات المتصفح عبر الشبكات فتستخدم TURN حسب التصميم لنقل نص مشفّر من الطرف إلى الطرف لا يستطيع المُرحِّل قراءته أو فك تشفيره. أما بالنسبة لرابط مُخزَّن، فيحتفظ الخادم فقط بنص مُشفَّر لا يستطيع قراءته، إلى أن تنتهي صلاحية الرابط أو يُنزَّل مرة واحدة إذا اخترت الحذف بعد القراءة.",
      },
      {
        q: "هل أحتاج إلى حساب لإرسال ملف أو استقباله؟",
        a: "على الشبكة نفسها، لا يحتاج أيٌّ من الطرفين إلى حساب. أما الإرسال عبر الشبكات برمز الاقتران، أو إنشاء رابط مُخزَّن، فيتطلّب تسجيل دخول المُرسِل — لكن الشخص المُستقبِل لا يحتاج إلى حساب أبدًا، أيًا كان الوضع المُستخدَم.",
      },
    ],
  },
  cta: {
    text: "أتتساءل إن كانت أداة ما تحمي فعلًا ما تدّعي حمايته؟ ابدأ عملية نقل، وفعِّل التحقّق المتقدّم، وشاهد رمز التحقق ورابط المعرفة الصفرية بنفسك.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "¿Es seguro enviar archivos por internet?",
  description:
    "Qué sale mal en realidad con el correo electrónico, los enlaces en la nube y las memorias USB — qué significan de verdad «cifrado de extremo a extremo» y «conocimiento cero», y qué comprobar antes de confiar en una herramienta de transferencia.",
  updatedLabel: "Última actualización",
  lead: [
    "«¿Es seguro enviar este archivo?» es una pregunta razonable para detenerse a plantear, ya sea una declaración de la renta, un contrato o simplemente fotos que preferirías mantener privadas. Esta guía no pretende asustarte para que dejes las herramientas habituales — se trata de recorrer, con claridad, qué le ocurre en realidad a un archivo cuando lo envías por correo, lo dejas en una carpeta en la nube o lo llevas en una memoria USB, qué prometen de verdad las expresiones «cifrado de extremo a extremo» y «conocimiento cero», y qué comprobar antes de confiar algo que te importa a cualquier herramienta.",
    "Nada de esto requiere formación técnica. Al terminar, sabrás qué preguntas hacer — sobre cualquier método de transferencia, incluido este.",
  ],
  sections: [
    {
      heading: "Dónde salen mal los archivos en realidad: los riesgos cotidianos",
      body: [
        "Los archivos adjuntos de correo pasan por los servidores de tu proveedor de correo y los del destinatario, y ambos suelen escanear, indexar y hacer copias de seguridad de los mensajes para el filtrado de spam y la recuperación ante desastres — mucho después de que hayas olvidado que lo enviaste. Reenvía el correo una vez, y el archivo queda delante de alguien a quien nunca lo destinaste, sin forma de saber que todas las copias han desaparecido.",
        "Los enlaces de almacenamiento en la nube son cómodos, pero un enlace normalmente sigue funcionando hasta que te acuerdas de revocarlo, y «cualquiera con el enlace» es solo tan privado como una URL imposible de adivinar — algo que un servicio de acortamiento de enlaces o un reenvío descuidado pueden echar por tierra. El archivo hereda además la seguridad de toda la cuenta en la que reside, no solo la del propio recurso compartido.",
        "Una memoria USB parece segura porque está sin conexión, pero ahí está justo la brecha: la mayoría de las unidades no están cifradas por defecto, así que una memoria olvidada en la funda de un portátil o en un coche de alquiler entrega el texto en claro a quien la encuentre, sin necesidad de contraseña.",
        "Los sitios de subida públicos y gratuitos resuelven el problema inmediato —llevar un archivo de A a B— pero rara vez dicen qué pasa después: cuánto tiempo se conserva, si se escanea, quién podría tropezarse con él, o cómo paga sus facturas el sitio (los alojamientos de archivos financiados con publicidad tienen un historial de incluir rastreadores o cosas peores).",
      ],
      bullets: [
        "Correo: retenido y escaneado por los servidores de correo, fácil de reenviar más allá de tu control",
        "Enlaces en la nube: siguen funcionando hasta que se revocan, y heredan la seguridad de toda la cuenta",
        "Memorias USB: sin cifrar por defecto, fáciles de perder u olvidar",
        "Sitios de subida gratuitos: las prácticas de retención y escaneo suelen ser poco claras",
      ],
    },
    {
      heading: "Qué significan de verdad «cifrado de extremo a extremo» y «conocimiento cero»",
      body: [
        "Muchos servicios dicen «cifrado» y solo quieren decir que la conexión a su servidor está cifrada — el HTTPS/TLS estándar, el mismo icono del candado que usa tu banco. Eso es protección real frente a alguien que espíe la red, pero se detiene en el servidor: en cuanto llega tu archivo, el propio servicio puede leerlo, porque tiene la clave. Muchas herramientas cotidianas se detienen exactamente ahí.",
        "El cifrado de extremo a extremo significa algo más fuerte: el archivo se cifra antes de salir de tu dispositivo, con una clave que solo tienen el remitente y el destinatario previsto. El servicio que lo transporta —el servidor, el retransmisor, cualquier cosa intermedia— nunca tiene la clave, así que nunca tiene el texto en claro, por más que se lo pidan.",
        "«Conocimiento cero» es una idea relacionada que suele aplicarse a algo almacenado en lugar de enviado en vivo: incluso los datos que reposan en un servidor se cifraron con una clave que el propio servidor nunca recibió, así que el operador no tiene forma de leerlos, jamás, por mucho tiempo que permanezcan allí.",
      ],
      bullets: [
        "«Cifrado» a secas a menudo solo significa TLS hasta el servidor — el proveedor todavía puede leer el archivo.",
        "«Cifrado de extremo a extremo» significa que solo el remitente y el destinatario tienen la clave.",
        "«Conocimiento cero» significa que el servidor guarda datos que, por su estructura, no puede descifrar, ni siquiera en reposo.",
      ],
    },
    {
      heading: "Qué comprobar de verdad antes de confiar en una herramienta de transferencia",
      prereqs: {
        label: "Lo que necesitas para recorrer esta lista",
        items: [
          "Diez minutos y un navegador. Los dos primeros puntos son leer, no auditar.",
          "Dos dispositivos para los puntos en vivo. El tercero y el cuarto no se pueden hacer desde una página de marketing, que es justo lo que los hace valiosos.",
          "Ninguna experiencia en seguridad. Cada punto de abajo es o algo que puedes leer o algo que puedes ver ocurrir.",
        ],
      },
      steps: [
        {
          text: "Busca la respuesta del proveedor a \"¿podéis leer mis archivos?\" en su código fuente, no en su página de precios. Si no hay código fuente, eso ya es una respuesta.",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "Comprueba la licencia y si el repositorio se corresponde con lo que está realmente desplegado. Una afirmación que puedes inspeccionar es de otro tipo que una que se te pide aceptar.",
        },
        {
          text: "En una transferencia en vivo, compara el código de verificación de las dos pantallas. Este es el paso que convierte \"cifrado de extremo a extremo\" de una frase en algo que se está aplicando entre estos dos extremos concretos.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Mientras esa transferencia corre, abre las herramientas de desarrollo del navegador y mira el panel de red. Busca el contenido de tu archivo en lo que se está subiendo. No encontrarlo es el objetivo; encontrarlo sería el hallazgo.",
        },
        {
          text: "Comprueba qué queda después: si un enlace caduca por sí solo, y si el servicio podría volver a producir el archivo más adelante si alguien se lo pidiera.",
        },
      ],
      success: {
        label: "Qué te dice de verdad superar esta lista",
        body: [
          "Los dos primeros puntos son baratos y descartan la mayoría de las herramientas en minutos. Los tres últimos no los puede fingir ninguna página de aterrizaje, porque los ves ocurrir en tus propios dos dispositivos.",
          "Nada de esto hace que una herramienta sea de fiar en abstracto. Hace comprobables afirmaciones concretas, que es lo máximo que cualquiera de nosotros puede hacer sin leer cada línea.",
        ],
      },
      body: [
        "El lenguaje de marketing de un sitio web vale menos que unas pocas preguntas concretas:",
      ],
      bullets: [
        "¿Dice «cifrado» (podría ser solo TLS) o específicamente «cifrado de extremo a extremo» (solo el remitente y el destinatario tienen la clave)?",
        "¿Hay una forma de verificar que la conexión no fue manipulada — un código que comparas, no solo un icono de candado en el que tienes que confiar?",
        "¿Se comprueba la integridad del archivo, para que un archivo corrupto o alterado no llegue silenciosamente mal?",
        "¿Es el código abierto y auditable, o las afirmaciones son solo marketing que tienes que aceptar por fe?",
        "¿Enviar o recibir exige entregar más identidad de la que la transferencia realmente necesita?",
        "Si se almacena algo, ¿tiene una vida útil clara y finita —una caducidad o un borrado tras la descarga— en lugar de quedarse ahí indefinidamente?",
      ],
    },
    {
      heading: "Cómo responde Relayium a cada una de estas",
      body: [
        "Para una transferencia en vivo, con ambas personas en línea a la vez, Relayium genera un nuevo par de claves X25519 en cada dispositivo y deriva una clave AES-256-GCM compartida que existe solo dentro de los dos navegadores — nunca se envía a los propios servidores de Relayium. Un breve código de verificación opcional (un SAS), que aparece al activar la verificación avanzada —desactivada por omisión—, permite a ambos lados confirmar que las claves no fueron sustituidas por un servidor deshonesto en medio, y el hash SHA-256 de cada archivo se comprueba de extremo a extremo para que una transferencia corrupta no llegue con buen aspecto. Los detalles exactos de cómo funciona eso se tratan con más profundidad en «Cómo Relayium cifra tus archivos de extremo a extremo», si quieres ir más allá de esta página.",
        "Cuando el destinatario aún no está en línea, un enlace de descarga almacenado usa un diseño genuinamente distinto, de conocimiento cero: tu navegador genera una clave AES-256-GCM aleatoria y cifra los archivos con ella antes de que se suba nada. Esa clave nunca se envía al servidor — vive solo en el fragmento de la URL del enlace, la parte tras el #, que los navegadores nunca transmiten. El servidor acaba guardando texto cifrado que no tiene forma de descifrar, más una caducidad que tú eliges: 1 hora, 1 día, 3 días, 7 días, hasta 14 días según tu plan, o destrucción tras la primera descarga completada.",
        "Entre redes, la aplicación web de Relayium usa TURN por diseño: el retransmisor transporta texto cifrado de extremo a extremo, pero nunca recibe la clave y no puede leer ni descifrar el archivo.",
        "Nada de esto te pide confiar en una afirmación por fe: el código de cliente y servidor de Relayium es de código abierto bajo la licencia AGPL-3.0, así que puede leerse y auditarse en lugar de aceptarse por fe.",
      ],
      bullets: [
        "Las transferencias en la misma red no necesitan ninguna cuenta.",
        "Enviar entre redes mediante un código de emparejamiento, o crear un enlace almacenado, requiere que el remitente inicie sesión — el destinatario nunca necesita una cuenta.",
      ],
    },
    {
      heading: "El cifrado no es toda la historia — unos pocos hábitos siguen importando",
      body: [
        "Un cifrado fuerte protege un archivo en tránsito y en reposo, pero no puede impedir que envíes un enlace a la dirección equivocada — trata un enlace para compartir como el propio archivo, y no lo publiques en ningún lugar público.",
        "Para cualquier cosa genuinamente sensible, activa la verificación avanzada y tómate los pocos segundos de más para comparar el código de verificación en voz alta en una llamada, o en persona, en lugar de fiarte de que dos pantallas coincidentes una al lado de la otra no hayan sido engañadas ambas.",
        "Y ninguna herramienta de transferencia, por bien cifrada que esté, protege un archivo que ya está expuesto en un dispositivo comprometido — un buen cifrado da por supuesto que los dos extremos son de fiar. Nada de esto es motivo para volverse paranoico con el envío de archivos; solo vale la pena saber qué cubre el cifrado y qué no.",
      ],
    },
    {
      heading: "Cuando una comprobación no da una respuesta limpia",
      body: [
        "Tres sitios donde la gente se atasca. En los tres, la ambigüedad ya es informativa.",
      ],
      troubleshooting: {
        label: "Con qué te encuentras, qué comprobar, qué significa",
        items: [
          {
            symptom: "El panel de red muestra una subida grande y no puedes saber qué lleva dentro.",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "Ese es el resultado esperado, no un callejón sin salida. Lo que buscas es la ausencia de cualquier cosa reconocible de tu archivo: un nombre de archivo que elegiste tú, una cadena que sabes que está en el documento. Si puedes leer tu propio contenido en la carga, ese es el hallazgo, y es concluyente.",
          },
          {
            symptom: "No hay código de verificación, así que el tercer punto no se puede hacer.",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "Estás en una transferencia por enlace almacenado, no en una en vivo. No hay un segundo extremo conectado con el que comparar, así que la garantía tiene otra forma: la clave vive en el fragmento del enlace y nunca llega al servidor. Compara códigos en las transferencias en vivo y revisa la caducidad del enlace en las almacenadas.",
          },
          {
            symptom: "El código es abierto pero no sabes leer el lenguaje en que está escrito.",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "No hace falta. La pregunta que responde este punto es si la afirmación es siquiera refutable: ¿hay repositorio?, ¿se corresponde con lo desplegado?, ¿podría contradecirla alguien que sí lea ese lenguaje? Una afirmación que nadie está en condiciones de comprobar es, ella misma, el hallazgo.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Es seguro enviar un archivo sensible por correo electrónico?",
        a: "El correo electrónico no está diseñado para la transferencia confidencial de archivos — los servidores de correo de ambos extremos suelen retener, escanear y respaldar los adjuntos, y un mensaje reenviado puede poner el archivo delante de personas a las que nunca lo destinaste. Está bien para archivos de poca importancia; para cualquier cosa sensible, una herramienta con cifrado de extremo a extremo elimina esa exposición.",
      },
      {
        q: "¿Qué significa de verdad «conocimiento cero»?",
        a: "Que a la parte que almacena tus datos nunca se le dio la clave para leerlos. El cifrado ocurre en tu dispositivo antes de que se suba nada, y la clave vive solo en algún sitio que el servidor nunca ve —como un fragmento de URL— así que lo que reside en el servidor es texto cifrado que, por su estructura, no puede descifrar, no solo datos que promete no mirar.",
      },
      {
        q: "¿Basta con un archivo zip protegido con contraseña?",
        a: "Es mejor que nada, pero la contraseña a menudo viaja por el mismo camino que el archivo —en el mismo hilo de correo, por ejemplo— lo que anula la protección, y las implementaciones del cifrado zip varían mucho en solidez. Una herramienta construida en torno al cifrado de extremo a extremo elimina ese eslabón débil al no necesitar nunca una contraseña compartida.",
      },
      {
        q: "¿Guarda Relayium una copia de mis archivos?",
        a: "En modo tiempo real, Relayium no conserva copia del lado del servidor ni historial de transferencia: en la misma LAN, WebRTC conecta directamente; entre redes, las sesiones del navegador usan TURN por diseño para transportar texto cifrado de extremo a extremo que el retransmisor no puede leer ni descifrar. Para un enlace almacenado, el servidor guarda solo texto cifrado que no puede leer, hasta que el enlace caduca o se descarga una vez si elegiste la destrucción tras la lectura.",
      },
      {
        q: "¿Necesito una cuenta para enviar o recibir un archivo?",
        a: "En la misma red, ninguno de los dos lados necesita cuenta. Enviar entre redes mediante un código de emparejamiento, o crear un enlace almacenado, requiere que el remitente inicie sesión — pero quien recibe nunca necesita una cuenta, sea cual sea el modo que se use.",
      },
    ],
  },
  cta: {
    text: "¿Con curiosidad por saber si una herramienta protege de verdad lo que afirma? Inicia una transferencia, activa la verificación avanzada y comprueba por ti mismo el código de verificación y el enlace de conocimiento cero.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "É seguro enviar arquivos pela internet?",
  description:
    "O que de fato dá errado com e-mail, links na nuvem e pendrives — o que “criptografia de ponta a ponta” e “conhecimento zero” realmente significam, e o que verificar antes de confiar em uma ferramenta de transferência.",
  updatedLabel: "Última atualização",
  lead: [
    "“É seguro enviar este arquivo?” é uma pergunta razoável para parar e fazer, seja uma declaração de imposto de renda, um contrato ou apenas fotos que você preferiria manter privadas. Este guia não pretende afastar você das ferramentas comuns — trata-se de percorrer, com clareza, o que de fato acontece com um arquivo quando você o envia por e-mail, o deixa em uma pasta na nuvem ou o carrega em um pendrive, o que as expressões “criptografia de ponta a ponta” e “conhecimento zero” realmente prometem, e o que verificar antes de confiar algo importante a qualquer ferramenta.",
    "Nada disso exige formação técnica. Ao final, você saberá que perguntas fazer — sobre qualquer método de transferência, incluindo este.",
  ],
  sections: [
    {
      heading: "Onde os arquivos de fato dão errado: os riscos do dia a dia",
      body: [
        "Os anexos de e-mail passam pelos servidores do seu provedor de e-mail e pelos do destinatário, e ambos costumam escanear, indexar e fazer backup das mensagens para filtragem de spam e recuperação de desastres — muito depois de você ter esquecido que o enviou. Encaminhe o e-mail uma vez, e o arquivo fica diante de alguém a quem você nunca o destinou, sem como saber se todas as cópias desapareceram.",
        "Os links de armazenamento na nuvem são convenientes, mas um link geralmente continua funcionando até você lembrar de revogá-lo, e “qualquer pessoa com o link” só é tão privado quanto uma URL impossível de adivinhar — algo que um encurtador de links ou um encaminhamento descuidado pode desfazer. O arquivo também herda a segurança de toda a conta em que está, não apenas do compartilhamento em si.",
        "Um pendrive parece seguro porque está offline, mas é exatamente aí que está a brecha: a maioria das unidades não é criptografada por padrão, então um pendrive esquecido na bolsa do notebook ou em um carro alugado entrega o texto claro a quem o encontrar, sem exigir nenhuma senha.",
        "Os sites de upload públicos e gratuitos resolvem o problema imediato — levar um arquivo de A a B — mas raramente dizem o que acontece depois: por quanto tempo é mantido, se é escaneado, quem pode topar com ele, ou como o site paga suas contas (hospedagens de arquivos financiadas por anúncios têm um histórico de embutir rastreadores ou coisas piores).",
      ],
      bullets: [
        "E-mail: retido e escaneado pelos servidores de e-mail, fácil de encaminhar para além do seu controle",
        "Links na nuvem: continuam funcionando até serem revogados, e herdam a segurança de toda a conta",
        "Pendrives: não criptografados por padrão, fáceis de perder ou esquecer",
        "Sites de upload gratuitos: as práticas de retenção e escaneamento costumam ser pouco claras",
      ],
    },
    {
      heading: "O que “criptografia de ponta a ponta” e “conhecimento zero” realmente significam",
      body: [
        "Muitos serviços dizem “criptografado” e querem dizer apenas que a conexão com o servidor deles é criptografada — o HTTPS/TLS padrão, o mesmo ícone de cadeado que o seu banco usa. Isso é proteção real contra alguém que espione a rede, mas para no servidor: assim que seu arquivo chega, o próprio serviço pode lê-lo, porque tem a chave. Muitas ferramentas do dia a dia param exatamente aí.",
        "A criptografia de ponta a ponta significa algo mais forte: o arquivo é criptografado antes de sair do seu dispositivo, com uma chave que só o remetente e o destinatário pretendido têm. O serviço que o transporta — o servidor, o retransmissor, qualquer coisa no meio — nunca tem a chave, então nunca tem o texto claro, por mais que seja solicitado.",
        "“Conhecimento zero” é uma ideia relacionada geralmente aplicada a algo armazenado em vez de enviado ao vivo: até dados parados em um servidor foram criptografados com uma chave que o próprio servidor nunca recebeu, então o operador não tem como lê-los, jamais, por mais tempo que fiquem lá.",
      ],
      bullets: [
        "“Criptografado” sozinho muitas vezes significa apenas TLS até o servidor — o provedor ainda pode ler o arquivo.",
        "“Criptografia de ponta a ponta” significa que só o remetente e o destinatário têm a chave.",
        "“Conhecimento zero” significa que o servidor guarda dados que, por sua estrutura, não consegue descriptografar, mesmo em repouso.",
      ],
    },
    {
      heading: "O que de fato verificar antes de confiar em uma ferramenta de transferência",
      prereqs: {
        label: "O que você precisa para percorrer esta lista",
        items: [
          "Dez minutos e um navegador. Os dois primeiros pontos são leitura, não auditoria.",
          "Dois aparelhos para os pontos ao vivo. O terceiro e o quarto não dá para fazer numa página de marketing, que é justamente o que os torna úteis.",
          "Nenhuma experiência em segurança. Cada ponto abaixo é ou algo que você consegue ler, ou algo que você consegue ver acontecer.",
        ],
      },
      steps: [
        {
          text: "Procure a resposta do fornecedor para \"o serviço consegue ler meus arquivos?\" no código-fonte dele, não na página de preços. Se não há código-fonte, isso já é uma resposta.",
          code: ["https://github.com/relayium/relayium"],
        },
        {
          text: "Confira a licença e se o repositório corresponde ao que está de fato no ar. Uma afirmação que você pode inspecionar é de outro tipo que uma que pedem para você aceitar.",
        },
        {
          text: "Numa transferência ao vivo, compare o código de verificação nas duas telas. É este passo que transforma \"criptografado de ponta a ponta\" de uma frase em algo sendo aplicado entre estas duas pontas específicas.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Enquanto essa transferência roda, abra as ferramentas de desenvolvedor do navegador e olhe o painel de rede. Procure o conteúdo do seu arquivo no que está sendo enviado. Não achar é o objetivo; achar seria a descoberta.",
        },
        {
          text: "Confira o que sobra depois: se um link expira sozinho, e se o serviço conseguiria produzir o arquivo de novo mais tarde caso alguém pedisse.",
        },
      ],
      success: {
        label: "O que passar nesta lista de fato diz",
        body: [
          "Os dois primeiros pontos são baratos e eliminam a maioria das ferramentas em minutos. Os três últimos nenhuma landing page consegue fingir, porque você os vê acontecer nos seus próprios dois aparelhos.",
          "Nada disso torna uma ferramenta confiável em abstrato. Torna afirmações concretas verificáveis, que é o máximo que qualquer um de nós consegue sem ler cada linha.",
        ],
      },
      body: [
        "A linguagem de marketing de um site vale menos do que algumas perguntas concretas:",
      ],
      bullets: [
        "Diz “criptografado” (pode significar apenas TLS) ou especificamente “criptografia de ponta a ponta” (só o remetente e o destinatário têm a chave)?",
        "Existe uma forma de verificar que a conexão não foi adulterada — um código que você compara, e não apenas um ícone de cadeado no qual você tem de confiar?",
        "A integridade do arquivo é verificada, para que um arquivo corrompido ou alterado não chegue silenciosamente errado?",
        "O código é aberto e auditável, ou as afirmações são apenas marketing que você tem de aceitar às cegas?",
        "Enviar ou receber exige entregar mais identidade do que a transferência realmente precisa?",
        "Se algo é armazenado, ele tem um tempo de vida claro e finito — uma expiração ou exclusão após o download — em vez de ficar ali indefinidamente?",
      ],
    },
    {
      heading: "Como o Relayium responde a cada um desses pontos",
      body: [
        "Para uma transferência ao vivo, com as duas pessoas online ao mesmo tempo, o Relayium gera um novo par de chaves X25519 em cada dispositivo e deriva uma chave AES-256-GCM compartilhada que existe apenas dentro dos dois navegadores — ela nunca é enviada aos próprios servidores do Relayium. Um curto código de verificação opcional (um SAS), que aparece quando você ativa a verificação avançada — desligada por padrão —, permite que ambos os lados confirmem que as chaves não foram substituídas por um servidor desonesto no meio, e o hash SHA-256 de cada arquivo é verificado de ponta a ponta para que uma transferência corrompida não chegue parecendo intacta. Os detalhes exatos de como isso funciona são abordados com mais profundidade em “Como o Relayium criptografa seus arquivos de ponta a ponta”, se você quiser ir além desta página.",
        "Quando o destinatário ainda não está online, um link de download armazenado usa um design genuinamente diferente, de conhecimento zero: seu navegador gera uma chave AES-256-GCM aleatória e criptografa os arquivos com ela antes que qualquer coisa seja enviada. Essa chave nunca é enviada ao servidor — ela vive apenas no fragmento da URL do link, a parte depois do #, que os navegadores nunca transmitem. O servidor acaba guardando texto cifrado que não tem como descriptografar, mais uma expiração que você escolhe: 1 hora, 1 dia, 3 dias, 7 dias, até 14 dias conforme o seu plano, ou autodestruição após o primeiro download concluído.",
        "Entre redes, o aplicativo web do Relayium usa TURN por design: o retransmissor transporta texto cifrado de ponta a ponta, mas nunca recebe a chave e não consegue ler nem descriptografar o arquivo.",
        "Nada disso pede que você acredite em uma afirmação às cegas: o código de cliente e servidor do Relayium é de código aberto sob a licença AGPL-3.0, então pode ser lido e auditado em vez de aceito às cegas.",
      ],
      bullets: [
        "As transferências na mesma rede não precisam de conta alguma.",
        "Enviar entre redes por código de emparelhamento, ou criar um link armazenado, exige que o remetente entre — o destinatário nunca precisa de conta.",
      ],
    },
    {
      heading: "A criptografia não é toda a história — alguns hábitos ainda importam",
      body: [
        "Uma criptografia forte protege um arquivo em trânsito e em repouso, mas não pode impedir que você envie um link para o endereço errado — trate um link de compartilhamento como o próprio arquivo, e não o publique em nenhum lugar público.",
        "Para qualquer coisa genuinamente sensível, ative a verificação avançada e dedique os poucos segundos a mais para comparar o código de verificação em voz alta em uma chamada, ou pessoalmente, em vez de confiar que duas telas coincidentes lado a lado não tenham sido ambas enganadas.",
        "E nenhuma ferramenta de transferência, por melhor criptografada que seja, protege um arquivo que já está exposto em um dispositivo comprometido — uma boa criptografia pressupõe que as duas pontas em si são confiáveis. Nada disso é motivo para ficar paranoico em relação a enviar arquivos; só vale a pena saber o que a criptografia cobre e o que não cobre.",
      ],
    },
    {
      heading: "Quando uma checagem não dá resposta limpa",
      body: [
        "Três lugares em que se trava. Nos três, a própria ambiguidade já informa.",
      ],
      troubleshooting: {
        label: "O que você encontra, o que checar, o que significa",
        items: [
          {
            symptom: "O painel de rede mostra um envio grande e você não consegue dizer o que tem dentro.",
            code: [
              `https://relayium.com/   # developer tools, Network panel, during a transfer`,
            ],
            fix: "Esse é o resultado esperado, não um beco sem saída. O que você procura é a ausência de qualquer coisa reconhecível do seu arquivo — um nome de arquivo que você escolheu, um trecho que você sabe estar no documento. Se der para ler o seu próprio conteúdo na carga, essa é a descoberta, e é decisiva.",
          },
          {
            symptom: "Não há código de verificação, então o terceiro ponto não dá para fazer.",
            code: [
              `https://relayium.com/   # a stored link has no second live endpoint to compare against`,
            ],
            fix: "Você está numa transferência por link armazenado, não numa ao vivo. Não existe uma segunda ponta online para comparar, então a garantia tem outro formato: a chave vive no fragmento do link e nunca chega ao servidor. Compare códigos nas transferências ao vivo e confira a expiração do link nas armazenadas.",
          },
          {
            symptom: "O código é aberto mas você não lê a linguagem em que ele foi escrito.",
            code: [
              `https://github.com/relayium/relayium   # is the claim falsifiable at all`,
            ],
            fix: "Não precisa. A pergunta que este ponto responde é se a afirmação é sequer refutável: existe repositório, ele corresponde ao que está no ar, alguém que leia aquela linguagem poderia contradizê-la. Uma afirmação que ninguém tem condições de checar é, ela mesma, a descoberta.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "É seguro enviar um arquivo sensível por e-mail?",
        a: "O e-mail não foi projetado para transferência confidencial de arquivos — os anexos costumam ser retidos, escaneados e copiados por servidores de e-mail nas duas pontas, e uma mensagem encaminhada pode colocar o arquivo diante de pessoas a quem você nunca o destinou. Tudo bem para arquivos de baixo risco; para qualquer coisa sensível, uma ferramenta com criptografia de ponta a ponta elimina essa exposição.",
      },
      {
        q: "O que “conhecimento zero” realmente significa?",
        a: "Que a parte que armazena seus dados nunca recebeu a chave para lê-los. A criptografia acontece no seu dispositivo antes que qualquer coisa seja enviada, e a chave vive apenas em algum lugar que o servidor nunca vê — como um fragmento de URL — então o que fica no servidor é texto cifrado que, por sua estrutura, ele não consegue descriptografar, e não apenas dados que ele promete não olhar.",
      },
      {
        q: "Um arquivo zip protegido por senha é suficiente?",
        a: "É melhor que nada, mas a senha muitas vezes viaja pelo mesmo caminho que o arquivo — na mesma conversa de e-mail, por exemplo — o que desfaz a proteção, e as implementações de criptografia zip variam muito em robustez. Uma ferramenta construída em torno da criptografia de ponta a ponta elimina esse elo fraco por nunca precisar de uma senha compartilhada.",
      },
      {
        q: "O Relayium mantém uma cópia dos meus arquivos?",
        a: "No modo em tempo real, o Relayium não mantém cópia no servidor nem histórico de transferência: na mesma LAN, o WebRTC conecta diretamente; entre redes, as sessões do navegador usam TURN por design para transportar texto cifrado de ponta a ponta que o retransmissor não consegue ler nem descriptografar. Para um link armazenado, o servidor guarda apenas texto cifrado que não consegue ler, até o link expirar ou ser baixado uma vez, se você escolheu a autodestruição após a leitura.",
      },
      {
        q: "Preciso de uma conta para enviar ou receber um arquivo?",
        a: "Na mesma rede, nenhum dos lados precisa de conta. Enviar entre redes por código de emparelhamento, ou criar um link armazenado, exige que o remetente entre — mas a pessoa que recebe nunca precisa de conta, seja qual for o modo usado.",
      },
    ],
  },
  cta: {
    text: "Curioso para saber se uma ferramenta realmente protege o que afirma? Inicie uma transferência, ative a verificação avançada e veja você mesmo o código de verificação e o link de conhecimento zero.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/is-it-safe-to-send-files-over-the-internet",
  published: "2026-07-09",
  updated: "2026-08-06",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
