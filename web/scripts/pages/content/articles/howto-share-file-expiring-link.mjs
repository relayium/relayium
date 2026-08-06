// web/scripts/pages/content/articles/howto-share-file-expiring-link.mjs
// How-to: create a stored, expiring download link (async mode) when the recipient
// is not online at the same time. English is the master; zh/ja/ko/de/fr follow the
// same structure with identical facts. Terminology mirrors store-crypto.ts,
// StoredUpload.svelte, OfflinePage.svelte and DownloadPage.svelte.

const en = {
  title: "Share a file with a secure, expiring download link",
  description:
    "Encrypt a file in your browser and get a link the server can't decrypt. Choose 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or burn after the first download, then send it whenever you're ready.",
  updatedLabel: "Last updated",
  lead: [
    "Not every transfer has someone waiting on the other end. Maybe the recipient is asleep, on a flight, or you just want to drop a link in a message and move on with your day. For that, Relayium has a second mode: instead of streaming a file live to another open browser, it encrypts the file where you are, uploads only the ciphertext, and hands you a link you can send whenever — the download happens on the recipient's own schedule.",
    "This guide walks through creating one of these links, the expiry and burn-after-read options, and exactly what the zero-knowledge design means in practice — including the honest limits: creating a link needs the sender to sign in, and links count against a storage quota.",
  ],
  sections: [
    {
      heading: "Stored links vs. realtime: when to use which",
      body: [
        "Relayium's realtime mode streams a file live between two open browser tabs: WebRTC is direct on the same LAN, while cross-network browser sessions use TURN by design to carry end-to-end encrypted ciphertext that the relay cannot read or decrypt. Relayium keeps no server-side copy or realtime history, but both people need to be online together. A stored, expiring link flips that trade-off: your browser does the encryption and uploads the result once, and the recipient can open the link minutes, hours, or days later, on their own time.",
        "Use a stored link when you don't know exactly when the other person will be free, when you're sending the same file to more than one person, or when you just want something you can paste into an email or chat and be done with it.",
      ],
    },
    {
      heading: "How to create a link",
      prereqs: {
        label: "What you need",
        items: [
          "A signed-in account on the sending side only — the recipient never needs one, and never sees a sign-in prompt.",
          "Files that fit under two separate ceilings: the per-file limit printed next to the picker, and your plan's storage quota. Read both off the page instead of guessing.",
          "A retention window your plan allows. The list only offers the windows your plan supports, and the server enforces the same cap defensively on whatever it receives.",
          "Your own copy of anything important. The page says so under the options: this is temporary delivery, not a backup.",
        ],
      },
      body: ["Creating a link takes a few steps, all in the browser:"],
      steps: [
        {
          text: "Open the async transfer page and sign in. Only the sender needs an account; the recipient never will.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Choose one or more files, or drag them in. The figure next to the picker is the live per-file ceiling for your account.",
          code: ["Choose files to upload\nMax 512 MiB"],
        },
        {
          text: "Set “Expires in”, or turn on “Burn after reading (delete on first download)”. The reminder under them — temporary delivery, not a backup — is the page telling you to keep your own copy.",
          code: ["Expires in\n1 day"],
        },
        {
          text: "Wait while the browser encrypts and then uploads; both phases are shown as they run. Leave the page open until it finishes, after which the link no longer depends on it.",
        },
        {
          text: "Copy the link, or have the recipient scan the QR beside it, and send it however you like. The whole string matters: everything after #k= is the decryption key and never reaches the server.",
          code: ["Link ready — send it to the recipient to download:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "What a created link looks like",
        body: [
          "The page replaces the picker with the link, the date it expires on, and a Copy button — plus a QR of the same link and, under it, the builder for fetching it from a terminal.",
          "Opening the link yourself is the honest way to confirm it: the download page shows the encrypted-link title, the file count with the total size, and a countdown of the time left. What it does not show is any way for us to read the file, because the key stayed in the fragment you copied.",
        ],
        code: ["Link ready — send it to the recipient to download:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
      },
    },
    {
      heading: "Expiry and burn-after-read",
      body: [
        "Every link needs a lifetime — leaving one live forever isn't the point of a one-off transfer. When you create a link you pick how long it should stay valid, or you can set it to disappear as soon as it's been used once.",
        "Burn-after-read means one download and then nothing — useful when the file is sensitive and you want exactly one person, one time, with nothing left dangling afterward. Be precise about when that single slot is spent, though: it goes the moment real ciphertext starts moving, not when the download finishes. A download interrupted half way has already used it up, and the link is dead even though the recipient holds only part of the file. Only an attempt that delivered nothing at all — zero bytes — hands the slot back, so a connect-then-drop costs nothing. The asymmetry is deliberate: refunding a near-complete read is exactly how a link holder would pull a burn file over and over. Either way, the recipient sees a live countdown on the download page, so they know how much time (or how many downloads) is left — and if their connection is shaky, leave burn off and pick a short expiry instead.",
      ],
      bullets: [
        "1 hour",
        "1 day (the default)",
        "3 days",
        "7 days",
        "14 days (the maximum, on the top plan)",
        "Or: burn on the first download that delivers any bytes, instead of a fixed time",
      ],
    },
    {
      heading: "The zero-knowledge guarantee, and its limits",
      body: [
        "Here's what actually happens when you create a link. Your browser generates a random AES-256-GCM key — a different mechanism from Relayium's realtime mode, which negotiates a key between two devices with X25519; a stored link's key is generated locally, with nothing to negotiate. That key encrypts your files and the list of filenames before anything leaves your device, and it's appended to the download link after a `#` — a part of the URL that browsers never send to any server. The server stores the ciphertext it's given, and only the ciphertext; it has no way to decrypt it, because it never receives the key.",
        "That design has real trade-offs worth knowing. The key never reaches the server, so there is no password reset we could offer you. It is not quite the link's only copy, though: the browser you uploaded from keeps it locally as well, and “My files” on the account page can rebuild and copy the link in that same browser. What makes a file unrecoverable is losing both — the full link and that local copy, which is what opening the account page on a different device, or clearing this browser's site data, amounts to. After that the stored ciphertext is permanently unreadable, to you and to us. Creating a link requires the sender to be signed in, and every link counts against your account's storage quota until it's deleted or expires. And it's worth being precise about what \"zero-knowledge\" means here: the ciphertext is genuinely stored on Relayium's server between creation and download — it's just unreadable without the key that never left your browser.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The recipient opens the link and the page says the decryption key is missing.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # the key is everything after #k="],
            fix: "The fragment was lost on the way — a chat preview, a link shortener, or a copy that stopped at the #. Send the link again as plain text, and have them paste it into the address bar themselves so nothing rewrites it; the id alone, with no #k= behind it, cannot be decrypted by anyone, us included.",
          },
          {
            symptom: "Decryption fails even though the whole link arrived.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # one id belongs to exactly one key"],
            fix: "The id and the key came from different links, which happens when two uploads are copied in the same sitting. Copy the newest link in one piece from the page that created it, or open “My files” on the account page in that same browser and copy the link from the right entry — the #k= fragment and that browser's local copy are the only two places the key exists, because it never reached the server.",
          },
          {
            symptom: "The link says it is invalid, expired, or already downloaded and deleted.",
            code: ["https://relayium.com/offline-transfer   # create a fresh link with burn left off"],
            fix: "All three are the same state: nothing left to fetch. With “Burn after reading” on, the first download that actually delivers ciphertext spends the only slot — whether it finished or broke off half way — so upload again and leave that off when more than one person, or one retry, needs it.",
          },
          {
            symptom: "The download page reports too many requests, or that the sender's monthly transfer is used up.",
            code: ["https://relayium.com/me   # this month's usage covers transfer as well as storage"],
            fix: "The file is intact and this is metering. A rate limit clears in a few minutes; an exhausted monthly transfer allowance waits for the month, an upgrade, or your own node. Opening the link again afterwards works, because nothing was consumed.",
          },
          {
            symptom: "You need the file back and no longer have the link.",
            code: ["https://relayium.com/me   # “My files” rebuilds the link in the browser that uploaded it"],
            fix: "Try the one recovery path there is first: the browser you uploaded from kept the key locally, so open the account page in that same browser, find the entry under “My files” and use its copy-link button. On any other device, or after that browser's site data was cleared, the key is gone and the stored ciphertext is unreadable to everyone, us included — upload again from your own copy, which is why the page tells you to keep one.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the person I send the link to need an account?",
        a: "No. Anyone with the full link — including the part after the `#` — can open it and download the files. Only the sender needs to sign in to create the link in the first place.",
      },
      {
        q: "Can Relayium read my file?",
        a: "No. Your browser encrypts the files with a random AES-256-GCM key before anything is uploaded, and that key travels only in the URL fragment, which never reaches the server. The browser you uploaded from also keeps a local copy of it so “My files” can rebuild the link later; the server stores ciphertext it has no way to decrypt — a zero-knowledge design.",
      },
      {
        q: "How long do links last?",
        a: "You choose when you create the link: 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or you can set it to burn on the first download instead of a fixed expiry. After that point the link stops working.",
      },
      {
        q: "Is the file really gone after burn-after-read?",
        a: "Burn-after-read is designed for exactly one download, and the slot is spent as soon as that download starts delivering real ciphertext — so the link stops working for anyone who opens it afterward, even if the one download was interrupted and never finished. Only an attempt that transferred nothing at all is handed back.",
      },
    ],
  },
  cta: {
    text: "Have a file ready but no one waiting on the other end? Create an expiring link in your browser and send it whenever you're ready.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用会过期的安全链接分享文件",
  description:
    "在浏览器里加密文件，生成一个连服务器都解不开的链接。可选 1 小时、1 天、3 天、7 天、最长 14 天有效期（上限取决于套餐），也可以设为阅后即焚——你准备好了再发出去。",
  updatedLabel: "最近更新",
  lead: [
    "不是每次传输对面都刚好有人在等。收件人可能在睡觉、在飞机上，或者你只是想把链接丢进聊天窗口就去忙别的。为此 Relayium 准备了第二种模式：不把文件实时流式传给另一个打开着的浏览器，而是先在你这边加密，只上传密文，再给你一个随时可以发出去的链接——什么时候下载，由收件人自己安排。",
    "本文讲解如何创建这样的链接、有效期与「阅后即焚」两个选项，以及零知识设计在实际中到底意味着什么——也如实说明它的限制：创建链接需要发送方登录，链接还会占用存储配额。",
  ],
  sections: [
    {
      heading: "存储链接与实时传输：该用哪个",
      body: [
        "Relayium 的实时模式会在两个打开着的浏览器标签之间实时传文件：同一局域网内由 WebRTC 直连，跨网络浏览器会按设计经 TURN 承载端到端加密的密文，中继无法读取或解密。Relayium 不保留服务器端副本或实时历史，但双方得同时在线。存储型的过期链接正好反过来：你的浏览器负责加密，把结果上传一次，收件人可以在几分钟、几小时甚至几天后，按自己的时间打开链接。",
        "如果你不确定对方什么时候有空、要把同一个文件发给不止一个人，或者只是想粘一条链接进邮件或聊天窗口就了事，那就用存储链接。",
      ],
    },
    {
      heading: "如何创建链接",
      prereqs: {
        label: "你需要准备",
        items: [
          "只有发送这一侧需要已登录的账号——收件人始终不需要，也不会看到任何登录提示。",
          "文件要同时装进两条独立的上限：选择器旁边印出的单文件上限，以及你套餐的存储额度。这两个都从页面上读，不要凭猜。",
          "一个你套餐允许的留存时长。列表只会给出你套餐支持的时长，服务端也会对收到的请求同样地把这个上限兜底执行一遍。",
          "重要内容自己也留一份。页面在选项下面就写着：这是临时投递，不是备份。",
        ],
      },
      body: ["创建链接只需要在浏览器里走几步："],
      steps: [
        {
          text: "打开异步传输页面并登录。只有发送方需要账号，收件人始终不需要。",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "选择一个或多个文件，或者直接拖进去。选择器旁边那个数字就是你账号当下的单文件上限。",
          code: ["选择文件上传\n最大 512 MiB"],
        },
        {
          text: "设置「有效期」，或者打开「阅后即焚（首次下载后删除）」。它们下面那句提醒——临时投递，并非备份——就是页面在告诉你自己也留一份。",
          code: ["有效期\n1 天"],
        },
        {
          text: "等浏览器先加密、再上传，两个阶段都会实时显示。上传完成之前让页面保持打开，完成之后链接就不再依赖它了。",
        },
        {
          text: "复制链接，或者让对方扫旁边的二维码，然后用你喜欢的方式发出去。整串都重要：#k= 之后的部分是解密密钥，它从不上传到服务器。",
          code: ["链接已生成，发给对方即可下载：\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "链接创建成功时是什么样",
        body: [
          "页面会用链接、它的到期日期和一个复制按钮取代原来的选择器——旁边还有同一条链接的二维码，下面则是从终端取回它的命令生成器。",
          "自己把链接打开一次才是诚实的确认方式：下载页面会显示加密下载链接的标题、文件数量与总大小，以及剩余时间的倒计时。它不会显示的，是任何能让我们读到文件的入口，因为密钥留在你复制的那个片段里。",
        ],
        code: ["链接已生成，发给对方即可下载：\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
      },
    },
    {
      heading: "有效期与阅后即焚",
      body: [
        "每个链接都需要一个存续期限——让它永久有效，就违背了一次性传输的初衷。创建链接时，你可以选择它保持有效多久，也可以设置成用过一次就立刻消失。",
        "阅后即焚意味着只能下载一次，之后什么都不剩——文件比较敏感、你只想让一个人看一次、事后不留尾巴时很有用。但要说清这唯一一次名额是什么时候被用掉的：是真正的密文开始下发的那一刻，而不是下载完成的那一刻。中途断掉的下载同样已经把它用掉了，链接就此失效，哪怕收件人手里只有半个文件。只有一个字节都没送出去的尝试才会把名额还回来，所以连上又立刻断开并不花代价。这种不对称是有意的：把「快下完了」当成可以免费退还，正是持有链接的人反复把即焚文件拉走的办法。无论选哪种，收件人在下载页都能看到实时倒计时，清楚还剩多少时间（或者还能不能下载）；如果对方网络不稳，就别开即焚，改用一个较短的有效期。",
      ],
      bullets: ["1 小时", "1 天（默认）", "3 天", "7 天", "14 天（上限，需最高档套餐）", "或者：只要有字节真正开始下发就即焚，而不是固定时长"],
    },
    {
      heading: "零知识保证，以及它的边界",
      body: [
        "创建链接时实际发生的是这样的：你的浏览器会生成一把随机的 AES-256-GCM 密钥——这跟 Relayium 实时模式的机制不一样，实时模式要通过 X25519 在两台设备之间协商密钥，而存储链接的密钥是在本地直接生成的，没有什么可协商。这把密钥会在文件离开你的设备之前，把文件本身和文件名列表一并加密，然后被附加到下载链接的 `#` 之后——这是浏览器永远不会发给任何服务器的那部分 URL。服务器只保存它收到的密文，而且只有密文；它没有办法解密，因为它从未拿到过密钥。",
        "这个设计有几个值得了解的真实取舍。密钥从不上传到服务器，所以我们没有「找回密码」可以提供。不过它也不是只存在于链接里：上传时用的那个浏览器会在本地留一份，在同一个浏览器里打开账户页的「我的文件」，就能重建并复制出那条链接。真正让文件无法找回的，是这两份都丢了——完整链接，以及那个浏览器里的本地副本（换一台设备打开账户页，或者清掉这个浏览器的站点数据，就等于丢了它）。到那一步，服务器上的密文就永久不可读了，对你对我们都一样。创建链接需要发送方处于登录状态，而且每个链接在被删除或过期之前，都会占用你账号的存储配额。这里的「零知识」也有必要说清楚：密文确实在创建到下载之间存放在 Relayium 的服务器上——只是少了那把从未离开过你浏览器的密钥，谁都读不懂它。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "对方打开链接，页面提示缺少解密密钥。",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # #k= 之后的全部内容就是密钥"],
            fix: "片段在路上丢了——可能是聊天预览、短链接服务，或者复制时停在了 # 那里。请把链接以纯文本再发一次，并让对方自己粘进地址栏，中间就没有人再改写它；只有 id 的话，谁都解不开，包括我们。",
          },
          {
            symptom: "整条链接都到了，解密还是失败。",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # 一个 id 只对应一把密钥"],
            fix: "id 和密钥来自两条不同的链接——一次坐下来上传两回时很容易这样。请从生成它的那个页面上把最新的链接整条复制下来，或者在同一个浏览器里打开账户页的「我的文件」，从对应的那一条复制链接——密钥只存在于这两个地方：链接的 #k= 片段，以及那个浏览器里的本地副本，因为它从未到达服务器。",
          },
          {
            symptom: "链接提示无效、已过期，或者已经被下载并删除。",
            code: ["https://relayium.com/offline-transfer   # 重新生成一条，并且不要开启即焚"],
            fix: "这三种说法是同一种状态：已经没有东西可取了。开启「阅后即焚」时，第一次真正开始下发密文的下载就用掉了唯一的名额——无论它下完了还是中途断了；所以当文件需要给多个人、或者可能要重试时，请重新上传并关掉这个开关。",
          },
          {
            symptom: "下载页面提示请求太多，或者发送方本月的流量已用完。",
            code: ["https://relayium.com/me   # 「本月用量」既包含存储也包含流量"],
            fix: "文件是完好的，这只是计量。限流几分钟后自行解除；月流量额度用尽则要等到下个月、升级套餐，或者用自己的节点。之后再打开链接依然有效，因为什么都没有被消耗掉。",
          },
          {
            symptom: "你需要把文件取回，但链接已经不在了。",
            code: ["https://relayium.com/me   # 「我的文件」能在当初上传的那个浏览器里重建链接"],
            fix: "先试唯一存在的那条找回路径：上传时用的那个浏览器把密钥留在了本地，所以请在同一个浏览器里打开账户页，在「我的文件」里找到那一条，用它的复制链接按钮。换成任何别的设备，或者那个浏览器的站点数据被清掉之后，密钥就没了，服务器上的密文对任何人都不可读，包括我们——那就从你自己的副本重新上传一次，这正是页面提醒你留一份的原因。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我发链接给的那个人需要账号吗？",
        a: "不需要。任何拿到完整链接的人——包括 `#` 后面那部分——都能打开并下载文件。只有发送方在创建链接时需要登录。",
      },
      {
        q: "Relayium 能看到我的文件内容吗？",
        a: "不能。你的浏览器会在上传前用一把随机生成的 AES-256-GCM 密钥加密文件，这把密钥只随 URL 片段传递，永远不会到达服务器；上传时用的那个浏览器还会在本地留一份，好让「我的文件」以后能重建出链接。服务器保存的是它无法解密的密文——这就是零知识设计。",
      },
      {
        q: "链接能保留多久？",
        a: "由你在创建时选择：1 小时、1 天、3 天、7 天或最长 14 天（可选范围取决于套餐）；也可以不设固定时长，改成首次下载即焚——名额在字节开始下发时就被用掉，所以中途断掉的下载同样算数。过了这个点，链接就不再有效。",
      },
      {
        q: "开了阅后即焚，文件真的会消失吗？",
        a: "阅后即焚就是为「只下载一次」设计的：只要那次下载开始下发真正的密文，名额就被用掉了，之后任何人再打开这个链接都不会生效——哪怕那次下载中途断了、根本没下完。只有一个字节都没传成的尝试才会被还回来。",
      },
    ],
  },
  cta: {
    text: "文件已经准备好，但对面暂时没人在等？在浏览器里创建一个会过期的链接，等你想发的时候再发。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "期限付きの安全なダウンロードリンクでファイルを共有する",
  description:
    "ブラウザでファイルを暗号化し、サーバーが復号できないリンクを作成。有効期限は1時間・1日・3日・7日・最長14日（プランによる）、または初回ダウンロード後に消去から選べます。準備ができたときに送れます。",
  updatedLabel: "最終更新",
  lead: [
    "すべての転送で、相手が今すぐ待っているとは限りません。受信者が寝ていたり、飛行機の中だったり、あるいはただリンクをメッセージに貼って自分のことに戻りたいだけかもしれません。そのために Relayium にはもう一つのモードがあります。開いている別のブラウザへファイルをその場でストリーミングする代わりに、手元でファイルを暗号化し、暗号文だけをアップロードして、いつでも送れるリンクを渡します。ダウンロードのタイミングは受信者自身のスケジュール次第です。",
    "本ガイドでは、こうしたリンクの作成方法、有効期限と「初回ダウンロード後に消去」オプション、そしてゼロ知識設計が実際に何を意味するかを説明します。正直な制約も含めています。リンクの作成には送信側のサインインが必要で、リンクはストレージ容量を消費します。",
  ],
  sections: [
    {
      heading: "保存型リンク vs リアルタイム：どちらを使うか",
      body: [
        "Relayium のリアルタイムモードは、開いている2つのブラウザタブ間でファイルをライブ転送します。同じ LAN では WebRTC で直接接続し、ネットワークをまたぐブラウザセッションは設計上 TURN を使って、リレーが読み取りも復号もできないエンドツーエンド暗号文を運びます。Relayium はサーバー側のコピーやリアルタイム履歴を保持しませんが、双方が同時にオンラインである必要があります。保存型の期限付きリンクはその逆です。ブラウザが暗号化を行い結果を一度アップロードすれば、受信者は数分後、数時間後、あるいは数日後でも、自分の都合でリンクを開けます。",
        "相手がいつ空くか分からないとき、同じファイルを複数人に送りたいとき、あるいはメールやチャットに貼り付けてそれで終わりにしたいときに、保存型リンクを使ってください。",
      ],
    },
    {
      heading: "リンクの作成方法",
      prereqs: {
        label: "必要なもの",
        items: [
          "サインイン済みのアカウントは送信側だけに必要です。受信側は不要で、サインインの案内も表示されません。",
          "2つの別々の上限に収まるファイル。選択ボタンの隣に表示される1ファイルあたりの上限と、プランの保存容量です。どちらも推測ではなくページから読み取ります。",
          "プランが許す保持期間。一覧にはプランが対応する期間だけが並び、サーバー側でも受け取った内容に同じ上限を念のため適用します。",
          "大切なものは自分の控えを持つこと。ページはオプションの下でそう告げています。これは一時的な受け渡しで、バックアップではありません。",
        ],
      },
      body: ["リンクの作成は、すべてブラウザ内でいくつかの手順を踏むだけです。"],
      steps: [
        {
          text: "非同期転送のページを開き、サインインします。アカウントが必要なのは送信側だけで、受信側は不要です。",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "ファイルを1つ以上選ぶか、ドラッグして入れます。選択ボタンの隣の数値が、そのアカウントの現在の1ファイル上限です。",
          code: ["アップロードするファイルを選択\n最大 512 MiB"],
        },
        {
          text: "「有効期限」を設定するか、「閲覧後削除（初回ダウンロード完了後に削除）」をオンにします。その下の注意——一時的な受け渡しでバックアップではない——は、控えを取るようページが告げているものです。",
          code: ["有効期限\n1 日"],
        },
        {
          text: "ブラウザが暗号化し、続いてアップロードするのを待ちます。どちらの段階も進行中に表示されます。終わるまでページを開いたままにしてください。終わればリンクはページに依存しません。",
        },
        {
          text: "リンクをコピーするか、隣のQRを相手に読み取ってもらい、好きな方法で送ります。文字列は全体が重要です。#k= より後ろは復号鍵で、サーバーには決して届きません。",
          code: ["リンクを作成しました。相手に送ってダウンロードしてもらえます：\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "作成されたリンクの見え方",
        body: [
          "ページは選択ボタンを、リンク、期限の日付、コピーボタンに置き換えます。さらに同じリンクのQRと、その下にはターミナルから取得するためのコマンド作成欄が並びます。",
          "自分でリンクを開いてみるのが正直な確認方法です。ダウンロードページには暗号化ダウンロードリンクの見出し、ファイル数と合計サイズ、残り時間のカウントダウンが出ます。出てこないのは当社がファイルを読む手段で、鍵はコピーしたフラグメントに留まっているからです。",
        ],
        code: ["リンクを作成しました。相手に送ってダウンロードしてもらえます：\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
      },
    },
    {
      heading: "有効期限と初回ダウンロード後の消去",
      body: [
        "どのリンクにも寿命が必要です。永久に有効なままにしておくのは、一度きりの受け渡しの趣旨に反します。リンクを作成するとき、どれだけ有効にしておくかを選べますし、一度使われたら即座に消えるよう設定することもできます。",
        "初回ダウンロード後の消去とは、ダウンロードは一度きりで、そのあとには何も残らないということです。ファイルが機微な内容で、一人に一度だけ見せて、その後は何も残したくないときに便利です。ただし、その1回分がいつ消費されるかは正確に言っておきます。ダウンロードが完了した瞬間ではなく、実際の暗号文が流れ始めた瞬間です。途中で切れたダウンロードもすでにそれを使い切っており、受信者の手元にファイルの一部しかなくてもリンクは死にます。1バイトも送られなかった試行だけが枠を返すので、つないですぐ切れた場合は何も消費しません。この非対称は意図的です。ほぼ完了した読み出しを無償で払い戻すことこそ、リンクを持つ人が消去付きファイルを何度も引き出す手口だからです。どちらを選んでも、受信者はダウンロードページでリアルタイムのカウントダウンを見られるので、残り時間（またはダウンロード回数）がわかります。相手の回線が不安定なら、消去はオフにして短い有効期限を選んでください。",
      ],
      bullets: ["1時間", "1日（既定値）", "3日", "7日", "14日（最長。最上位プランのみ）", "または：固定の期限の代わりに、実際にバイトが流れ始めた最初のダウンロードで消去"],
    },
    {
      heading: "ゼロ知識保証と、その限界",
      body: [
        "リンクを作成するとき実際に起きていることはこうです。ブラウザはランダムな AES-256-GCM 鍵を生成します。これは Relayium のリアルタイムモードとは異なる仕組みで、リアルタイムモードは X25519 で2つの端末間の鍵を協議します。保存リンクの鍵はローカルで生成され、誰とも協議する必要がありません。その鍵は、何かが端末を離れる前にファイル本体とファイル名のリストを暗号化し、ダウンロードリンクの `#` の後に付加されます。ここはブラウザが決してどのサーバーにも送信しない URL の部分です。サーバーは渡された暗号文を、暗号文だけを保存します。鍵を一切受け取らないため、それを復号する方法がありません。",
        "この設計には知っておくべき現実的なトレードオフがあります。鍵はサーバーに一度も届かないので、こちらから提供できるパスワードリセットはありません。ただし、鍵のコピーがリンクだけにあるわけでもありません。アップロードしたブラウザは鍵をローカルにも保持していて、同じブラウザでアカウントページの「マイファイル」を開けばリンクを組み立て直してコピーできます。ファイルが本当に取り戻せなくなるのは、その両方を失ったとき——完全なリンクと、そのブラウザのローカルコピーです（別の端末でアカウントページを開くことや、このブラウザのサイトデータを消去することが、それに当たります）。そうなると、保存された暗号文は利用者にも当社にも永久に読めません。リンクの作成には送信側がサインインしている必要があり、削除または期限切れになるまで各リンクはアカウントのストレージ容量を消費します。そして「ゼロ知識」がここで何を意味するかは正確に言っておく価値があります。暗号文は作成からダウンロードまでの間、実際に Relayium のサーバーに保存されています。ただ、ブラウザを一度も離れなかった鍵がなければ読めない、というだけです。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "相手がリンクを開くと、復号鍵がないとページに出る。",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # #k= より後ろがすべて鍵"],
            fix: "途中でフラグメントが失われています。チャットのプレビュー、短縮リンク、あるいは # で止まったコピーが原因です。リンクをプレーンテキストで送り直し、相手自身がアドレス欄に貼り付けるようにしてください。id だけでは当社を含め誰も復号できません。",
          },
          {
            symptom: "リンク全体が届いているのに復号が失敗する。",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # 1つの id に対応する鍵は1つだけ"],
            fix: "id と鍵が別々のリンクから来ています。同じ作業中に2回アップロードするとよく起こります。作成したページから最新のリンクを一体でコピーするか、同じブラウザでアカウントページの「マイファイル」を開き、該当する行からリンクをコピーしてください。鍵が存在する場所は、リンクの #k= フラグメントと、そのブラウザのローカルコピーの2か所だけです。サーバーには一度も届いていません。",
          },
          {
            symptom: "リンクが無効、期限切れ、またはすでにダウンロードされ削除済みと出る。",
            code: ["https://relayium.com/offline-transfer   # 削除をオフにして新しいリンクを作る"],
            fix: "3つはどれも同じ状態で、取得できるものが残っていません。「閲覧後削除」がオンなら、実際に暗号文を配送し始めた最初のダウンロードが唯一の枠を使い切ります——完了しても途中で切れても同じです。複数人、あるいは再試行が必要なときは、それをオフにして再アップロードしてください。",
          },
          {
            symptom: "ダウンロードページがリクエスト過多、または送信者の今月の転送量を使い切ったと表示する。",
            code: ["https://relayium.com/me   # 今月の使用量は保存だけでなく転送も含む"],
            fix: "ファイルは無事で、これは計量です。レート制限は数分で解け、月間の転送量を使い切った場合は月替わり、プラン変更、または自分のノードを待ちます。その後にリンクを開けば動きます。何も消費されていないからです。",
          },
          {
            symptom: "ファイルを取り戻したいのに、もうリンクがない。",
            code: ["https://relayium.com/me   # 「マイファイル」はアップロードしたブラウザでリンクを組み立て直せる"],
            fix: "まず、唯一ある復旧の道を試してください。アップロードしたブラウザが鍵をローカルに保持しているので、同じブラウザでアカウントページを開き、「マイファイル」の該当する行からリンクをコピーします。ほかの端末では、あるいはそのブラウザのサイトデータを消したあとでは鍵は失われ、保存された暗号文は当社を含め誰にも読めません。その場合は自分の控えから改めてアップロードしてください。ページが控えを促しているのはこのためです。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "リンクを送る相手にアカウントは必要ですか？",
        a: "いいえ。`#` の後の部分を含む完全なリンクを持っている人なら誰でも開いてファイルをダウンロードできます。リンクを作成するときにサインインが必要なのは送信側だけです。",
      },
      {
        q: "Relayium は私のファイルを読めますか？",
        a: "いいえ。ブラウザは、何かをアップロードする前にランダムに生成した AES-256-GCM 鍵でファイルを暗号化し、その鍵は URL フラグメントでのみ運ばれ、サーバーには決して届きません。アップロードしたブラウザは、あとで「マイファイル」がリンクを組み立て直せるようにローカルにも控えを持ちます。サーバーが保存するのは復号する方法のない暗号文だけです。ゼロ知識設計です。",
      },
      {
        q: "リンクはどのくらい持ちますか？",
        a: "リンクを作成するときに選べます：1時間、1日、3日、7日、最長14日（プランによる）、あるいは固定の期限の代わりに初回ダウンロードで消去するよう設定できます。枠はバイトが流れ始めた時点で消費されるので、途中で切れたダウンロードも同じく数えられます。その時点を過ぎるとリンクは機能しなくなります。",
      },
      {
        q: "初回ダウンロード後の消去で、ファイルは本当になくなりますか？",
        a: "初回ダウンロード後の消去は、まさに1回きりのダウンロードのために設計されています。枠はそのダウンロードが実際の暗号文を配送し始めた時点で消費されるため、それ以降にリンクを開いても機能しません——そのダウンロードが途中で切れて完了しなかった場合でも同じです。1バイトも転送されなかった試行だけが返されます。",
      },
    ],
  },
  cta: {
    text: "ファイルの準備はできているけれど、相手がまだ待っていない？ ブラウザで期限付きリンクを作成して、準備ができたときに送りましょう。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "만료되는 안전한 다운로드 링크로 파일 공유하기",
  description:
    "브라우저에서 파일을 암호화하고 서버가 복호화할 수 없는 링크를 생성하세요. 1시간·1일·3일·7일·최대 14일(요금제에 따라 다름) 만료 또는 첫 다운로드 후 소각 중 선택하고, 준비됐을 때 보내세요.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "모든 전송에서 상대방이 지금 기다리고 있는 것은 아닙니다. 수신자가 자고 있거나 비행기 안이거나, 아니면 그냥 메시지에 링크를 남기고 하던 일로 돌아가고 싶을 수도 있습니다. 이를 위해 Relayium에는 두 번째 모드가 있습니다. 열려 있는 다른 브라우저로 파일을 실시간 스트리밍하는 대신, 내 쪽에서 파일을 암호화하고 암호문만 업로드한 뒤, 언제든 보낼 수 있는 링크를 건네줍니다. 다운로드는 수신자 자신의 일정에 맞춰 이루어집니다.",
    "이 가이드는 이런 링크를 만드는 방법, 만료 및 첫 다운로드 후 소각 옵션, 그리고 영지식 설계가 실제로 무엇을 의미하는지 설명합니다. 솔직한 제약도 함께 다룹니다. 링크 생성에는 보내는 쪽의 로그인이 필요하고, 링크는 스토리지 할당량을 차지합니다.",
  ],
  sections: [
    {
      heading: "저장 링크 vs 실시간: 어느 쪽을 써야 할까",
      body: [
        "Relayium의 실시간 모드는 열려 있는 두 브라우저 탭 사이에서 파일을 실시간으로 전송합니다. 같은 LAN에서는 WebRTC로 직접 연결하고, 네트워크를 넘는 브라우저 세션은 설계상 TURN을 사용해 릴레이가 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다. Relayium은 서버 측 복사본이나 실시간 기록을 보관하지 않지만, 양쪽이 동시에 온라인이어야 합니다. 저장형 만료 링크는 그 반대입니다. 브라우저가 암호화를 수행하고 결과를 한 번 업로드하면, 수신자는 몇 분, 몇 시간, 심지어 며칠 뒤에도 자기 시간에 맞춰 링크를 열 수 있습니다.",
        "상대가 언제 시간이 날지 모를 때, 같은 파일을 여러 사람에게 보낼 때, 아니면 그냥 이메일이나 채팅에 붙여넣고 끝내고 싶을 때 저장 링크를 사용하세요.",
      ],
    },
    {
      heading: "링크 만드는 방법",
      prereqs: {
        label: "필요한 것",
        items: [
          "로그인한 계정은 보내는 쪽에만 필요합니다. 받는 사람은 필요 없고 로그인 안내도 보지 않습니다.",
          "서로 다른 두 상한에 들어가는 파일. 선택기 옆에 찍히는 파일당 상한과 요금제의 저장 용량입니다. 둘 다 짐작이 아니라 페이지에서 읽습니다.",
          "요금제가 허용하는 보관 기간. 목록에는 요금제가 지원하는 기간만 나오고, 서버도 받은 요청에 같은 상한을 방어적으로 적용합니다.",
          "중요한 것은 내 사본도 갖고 있기. 페이지가 옵션 아래에서 그렇게 말합니다: 이것은 임시 전달이고 백업이 아닙니다.",
        ],
      },
      body: ["링크를 만드는 과정은 모두 브라우저 안에서 몇 단계로 이루어집니다."],
      steps: [
        {
          text: "비동기 전송 페이지를 열고 로그인합니다. 계정이 필요한 쪽은 보내는 사람뿐이고, 받는 사람은 필요 없습니다.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "파일을 하나 이상 고르거나 끌어다 놓습니다. 선택기 옆의 숫자가 이 계정의 현재 파일당 상한입니다.",
          code: ["업로드할 파일 선택\n최대 512 MiB"],
        },
        {
          text: "“유효 기간”을 정하거나 “열람 후 삭제 (첫 다운로드 시 삭제)”를 켜세요. 그 아래의 안내 — 임시 전달일 뿐 백업이 아니다 — 가 바로 사본을 남기라는 페이지의 말입니다.",
          code: ["유효 기간\n1일"],
        },
        {
          text: "브라우저가 먼저 암호화한 뒤 업로드하는 동안 기다립니다. 두 단계 모두 진행 중에 표시됩니다. 끝날 때까지 페이지를 열어 두세요. 끝나면 링크는 페이지에 의존하지 않습니다.",
        },
        {
          text: "링크를 복사하거나 옆의 QR을 상대가 스캔하게 하고, 원하는 방식으로 보내세요. 문자열은 전체가 중요합니다. #k= 뒤는 복호화 키이고 서버에는 결코 닿지 않습니다.",
          code: ["링크가 생성되었습니다. 상대에게 보내 다운로드하세요:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "만들어진 링크는 이렇게 보입니다",
        body: [
          "페이지가 선택기를 링크, 만료 날짜, 복사 버튼으로 바꿉니다 — 여기에 같은 링크의 QR과, 그 아래 터미널에서 가져오는 명령 생성기가 함께 놓입니다.",
          "링크를 직접 열어 보는 것이 정직한 확인입니다. 다운로드 페이지에는 암호화된 다운로드 링크 제목, 파일 개수와 총 크기, 남은 시간 카운트다운이 뜹니다. 뜨지 않는 것은 우리가 파일을 읽을 수 있는 경로이며, 키는 복사해 둔 프래그먼트에 남아 있기 때문입니다.",
        ],
        code: ["링크가 생성되었습니다. 상대에게 보내 다운로드하세요:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
      },
    },
    {
      heading: "만료와 첫 다운로드 후 소각",
      body: [
        "모든 링크에는 수명이 필요합니다. 영원히 살아있게 두는 것은 일회성 전송의 취지에 맞지 않습니다. 링크를 만들 때 얼마나 오래 유효할지 고를 수 있고, 한 번 쓰이면 즉시 사라지도록 설정할 수도 있습니다.",
        "첫 다운로드 후 소각은 다운로드가 딱 한 번뿐이고 그 뒤에는 아무것도 남지 않는다는 뜻입니다. 파일이 민감해서 딱 한 사람에게 한 번만 보여주고 이후로는 아무것도 남기고 싶지 않을 때 유용합니다. 다만 그 한 번의 슬롯이 언제 소모되는지는 정확히 짚어야 합니다. 다운로드가 끝나는 순간이 아니라, 실제 암호문이 흐르기 시작하는 순간입니다. 중간에 끊긴 다운로드도 이미 슬롯을 써버린 것이라, 수신자가 파일의 일부만 갖고 있어도 링크는 죽습니다. 단 한 바이트도 전달하지 못한 시도만 슬롯을 돌려받으므로, 연결했다가 곧바로 끊긴 경우에는 아무것도 소모되지 않습니다. 이 비대칭은 의도된 것입니다. 거의 다 받은 읽기를 공짜로 환불해 주는 것이야말로 링크를 가진 사람이 소각 파일을 몇 번이고 다시 빼가는 방법이기 때문입니다. 어느 쪽을 선택하든 수신자는 다운로드 페이지에서 실시간 카운트다운을 볼 수 있어, 남은 시간(또는 다운로드 가능 여부)을 알 수 있습니다. 상대의 연결이 불안정하다면 소각은 끄고 짧은 만료 기간을 고르세요.",
      ],
      bullets: ["1시간", "1일(기본값)", "3일", "7일", "14일(최대, 최상위 요금제)", "또는: 고정된 시간 대신 실제로 바이트가 나가기 시작한 첫 다운로드에서 소각"],
    },
    {
      heading: "영지식 보장, 그리고 그 한계",
      body: [
        "링크를 만들 때 실제로 일어나는 일은 이렇습니다. 브라우저가 무작위 AES-256-GCM 키를 생성합니다. 이는 Relayium의 실시간 모드와는 다른 방식으로, 실시간 모드는 X25519로 두 기기 사이에 키를 협상합니다. 저장 링크의 키는 로컬에서 생성되며 협상할 상대가 없습니다. 이 키는 무언가가 기기를 떠나기 전에 파일 본문과 파일명 목록을 암호화하고, 다운로드 링크의 `#` 뒤에 붙습니다. 브라우저가 어떤 서버로도 절대 보내지 않는 URL 부분입니다. 서버는 전달받은 암호문을, 오직 암호문만 저장합니다. 키를 전혀 받지 않으므로 복호화할 방법이 없습니다.",
        "이 설계에는 알아둘 만한 현실적인 절충점이 있습니다. 키는 서버에 한 번도 닿지 않으므로 저희가 드릴 수 있는 비밀번호 재설정 같은 것은 없습니다. 그렇다고 링크가 키의 유일한 사본인 것도 아닙니다. 업로드한 브라우저가 키를 로컬에도 보관하고 있어서, 같은 브라우저에서 계정 페이지의 “내 파일”을 열면 링크를 다시 만들어 복사할 수 있습니다. 파일을 정말로 되찾을 수 없게 되는 것은 그 둘을 모두 잃었을 때입니다 — 전체 링크와, 그 브라우저의 로컬 사본(다른 기기에서 계정 페이지를 열거나 이 브라우저의 사이트 데이터를 지우는 것이 여기에 해당합니다). 그다음부터 저장된 암호문은 여러분에게도 저희에게도 영구히 읽을 수 없습니다. 링크 생성에는 보내는 쪽이 로그인 상태여야 하고, 삭제되거나 만료될 때까지 각 링크는 계정의 스토리지 할당량을 차지합니다. 그리고 여기서 '영지식'이 정확히 무엇을 뜻하는지 분명히 해둘 가치가 있습니다. 암호문은 생성부터 다운로드까지 실제로 Relayium 서버에 저장되어 있습니다. 다만 내 브라우저를 한 번도 떠난 적 없는 키가 없으면 읽을 수 없을 뿐입니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "상대가 링크를 열면 복호화 키가 없다고 페이지가 말합니다.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # #k= 뒤 전부가 키다"],
            fix: "오는 길에 프래그먼트가 사라졌습니다. 채팅 미리보기, 링크 단축기, 또는 # 에서 멈춘 복사가 원인입니다. 링크를 평문으로 다시 보내고 상대가 직접 주소창에 붙여 넣게 하세요. id만으로는 우리를 포함해 누구도 복호화할 수 없습니다.",
          },
          {
            symptom: "링크 전체가 도착했는데도 복호화가 실패합니다.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # 하나의 id에는 정확히 하나의 키"],
            fix: "id와 키가 서로 다른 링크에서 왔습니다. 한 자리에서 두 번 업로드하면 흔히 생깁니다. 그것을 만든 페이지에서 가장 최근 링크를 한 덩어리로 복사하거나, 같은 브라우저에서 계정 페이지의 “내 파일”을 열어 해당 항목의 링크를 복사하세요. 키가 존재하는 곳은 링크의 #k= 프래그먼트와 그 브라우저의 로컬 사본, 이 둘뿐입니다. 서버에는 한 번도 닿지 않았습니다.",
          },
          {
            symptom: "링크가 잘못되었거나 만료되었거나 이미 다운로드되어 삭제되었다고 나옵니다.",
            code: ["https://relayium.com/offline-transfer   # 삭제를 끄고 새 링크를 만든다"],
            fix: "셋 다 같은 상태입니다. 가져올 것이 남아 있지 않습니다. “열람 후 삭제”가 켜져 있으면 실제로 암호문을 내보내기 시작한 첫 다운로드가 하나뿐인 슬롯을 써버립니다 — 끝까지 갔든 중간에 끊겼든 마찬가지입니다. 여러 사람이나 재시도가 필요하다면 그것을 끄고 다시 올리세요.",
          },
          {
            symptom: "다운로드 페이지가 요청이 너무 많다거나 보낸 사람의 월 전송량이 다 되었다고 합니다.",
            code: ["https://relayium.com/me   # 이번 달 사용량은 저장뿐 아니라 전송도 포함한다"],
            fix: "파일은 온전하고 이것은 계량입니다. 속도 제한은 몇 분이면 풀리고, 월 전송량을 다 쓴 경우에는 달이 바뀌거나 요금제를 올리거나 자체 노드를 써야 합니다. 그 뒤에 링크를 다시 열면 동작합니다. 아무것도 소비되지 않았기 때문입니다.",
          },
          {
            symptom: "파일을 되찾아야 하는데 링크가 더 이상 없습니다.",
            code: ["https://relayium.com/me   # “내 파일”은 업로드한 그 브라우저에서 링크를 다시 만든다"],
            fix: "존재하는 단 하나의 복구 경로부터 시도하세요. 업로드한 브라우저가 키를 로컬에 남겨 두었으므로, 같은 브라우저에서 계정 페이지를 열고 “내 파일”에서 해당 항목을 찾아 링크 복사 버튼을 누르면 됩니다. 다른 기기에서는, 또는 그 브라우저의 사이트 데이터를 지운 뒤에는 키가 사라지고 저장된 암호문은 우리를 포함해 누구도 읽을 수 없습니다 — 그때는 내 사본에서 다시 업로드하세요. 페이지가 사본을 남기라고 말하는 이유가 그것입니다.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "링크를 보낼 상대방도 계정이 필요한가요?",
        a: "아니요. `#` 뒤의 부분을 포함한 전체 링크를 가진 사람이라면 누구나 열어서 파일을 다운로드할 수 있습니다. 링크를 만들 때 로그인이 필요한 쪽은 보내는 사람뿐입니다.",
      },
      {
        q: "Relayium이 제 파일을 읽을 수 있나요?",
        a: "아니요. 브라우저는 업로드하기 전에 무작위로 생성한 AES-256-GCM 키로 파일을 암호화하며, 그 키는 URL 프래그먼트로만 전달되고 서버에는 절대 도달하지 않습니다. 업로드한 브라우저는 나중에 “내 파일”이 링크를 다시 만들 수 있도록 로컬 사본도 보관합니다. 서버가 저장하는 것은 복호화할 방법이 없는 암호문뿐입니다. 영지식 설계입니다.",
      },
      {
        q: "링크는 얼마나 유지되나요?",
        a: "링크를 만들 때 직접 선택합니다: 1시간, 1일, 3일, 7일, 최대 14일(요금제에 따라 다름), 또는 고정 기간 대신 첫 다운로드에서 소각으로 설정할 수 있습니다. 슬롯은 바이트가 나가기 시작할 때 소모되므로 중간에 끊긴 다운로드도 똑같이 계산됩니다. 그 시점이 지나면 링크는 더 이상 작동하지 않습니다.",
      },
      {
        q: "첫 다운로드 후 소각이면 파일이 정말로 사라지나요?",
        a: "첫 다운로드 후 소각은 정확히 한 번의 다운로드를 위해 설계되었습니다. 슬롯은 그 다운로드가 실제 암호문을 내보내기 시작하는 순간 소모되므로, 이후 링크를 여는 누구에게도 작동하지 않습니다 — 그 한 번의 다운로드가 중간에 끊겨 끝나지 않았더라도 마찬가지입니다. 한 바이트도 전송하지 못한 시도만 되돌려받습니다.",
      },
    ],
  },
  cta: {
    text: "보낼 파일은 준비됐지만 상대방이 아직 기다리고 있지 않나요? 브라우저에서 만료 링크를 만들고 준비됐을 때 보내세요.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Eine Datei mit einem sicheren, ablaufenden Link teilen",
  description:
    "Verschlüssele eine Datei in deinem Browser und erhalte einen Link, den der Server nicht entschlüsseln kann. Wähle 1 Stunde, 1 Tag, 3, 7 oder bis zu 14 Tage Gültigkeit, je nach Tarif, oder Löschung nach dem ersten Download — sende ihn, wenn du bereit bist.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Nicht bei jeder Übertragung wartet jemand auf der anderen Seite. Vielleicht schläft die empfangende Person, sitzt im Flugzeug, oder du willst einfach einen Link in eine Nachricht fallen lassen und mit deinem Tag weitermachen. Dafür hat Relayium einen zweiten Modus: Statt eine Datei live an einen anderen geöffneten Browser zu streamen, verschlüsselt er die Datei bei dir, lädt nur den Chiffretext hoch und gibt dir einen Link, den du jederzeit versenden kannst — der Download findet nach dem Zeitplan der empfangenden Person statt.",
    "Diese Anleitung zeigt, wie man einen solchen Link erstellt, die Optionen für Ablauf und Löschung nach dem ersten Download, und was das Zero-Knowledge-Design in der Praxis tatsächlich bedeutet — einschließlich der ehrlichen Grenzen: Zum Erstellen eines Links muss sich der Absender anmelden, und Links zählen gegen ein Speicherkontingent.",
  ],
  sections: [
    {
      heading: "Gespeicherte Links vs. Echtzeit: wann was nutzen",
      body: [
        "Relayiums Echtzeitmodus streamt eine Datei live zwischen zwei geöffneten Browser-Tabs: Im selben LAN verbindet WebRTC direkt; netzübergreifende Browser-Sitzungen nutzen planmäßig TURN, das Ende-zu-Ende-verschlüsselten Chiffretext transportiert, den das Relay weder lesen noch entschlüsseln kann. Relayium bewahrt keine serverseitige Kopie oder Echtzeithistorie auf, aber beide Personen müssen gleichzeitig online sein. Ein gespeicherter, ablaufender Link kehrt diesen Kompromiss um: Dein Browser übernimmt die Verschlüsselung und lädt das Ergebnis einmal hoch, und die empfangende Person kann den Link Minuten, Stunden oder Tage später öffnen, zu ihrer eigenen Zeit.",
        "Nutze einen gespeicherten Link, wenn du nicht genau weißt, wann die andere Person Zeit hat, wenn du dieselbe Datei an mehr als eine Person senden willst, oder wenn du einfach etwas willst, das du in eine E-Mail oder einen Chat einfügen kannst und fertig bist.",
      ],
    },
    {
      heading: "So erstellst du einen Link",
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Ein angemeldetes Konto nur auf der sendenden Seite — die empfangende Person braucht keines und sieht auch keine Anmeldeaufforderung.",
          "Dateien, die unter zwei getrennte Obergrenzen passen: die Grenze pro Datei neben der Auswahl und das Speicherkontingent deines Tarifs. Beide liest man von der Seite ab, statt sie zu raten.",
          "Eine Aufbewahrungsdauer, die dein Tarif erlaubt. Die Liste bietet nur die von deinem Tarif unterstützten Zeiträume an, und der Server setzt dieselbe Grenze sicherheitshalber noch einmal durch.",
          "Eine eigene Kopie von allem Wichtigen. Die Seite sagt es unter den Optionen: temporäre Zustellung, kein Backup.",
        ],
      },
      body: ["Einen Link zu erstellen dauert ein paar Schritte, alle im Browser:"],
      steps: [
        {
          text: "Öffne die Seite für asynchrone Übertragung und melde dich an. Nur der Absender braucht ein Konto, die empfangende Person nie.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Wähle eine oder mehrere Dateien, oder zieh sie hinein. Die Zahl neben der Auswahl ist die aktuelle Obergrenze pro Datei für dein Konto.",
          code: ["Dateien zum Hochladen wählen\nMax. 512 MiB"],
        },
        {
          text: "Setz „Gültig für“, oder aktiviere „Nach dem Lesen löschen (beim ersten Download)“. Der Hinweis darunter — temporäre Zustellung, kein Backup — ist die Seite, die dir sagt, eine eigene Kopie zu behalten.",
          code: ["Gültig für\n1 Tag"],
        },
        {
          text: "Warte, während der Browser verschlüsselt und danach hochlädt; beide Phasen sind während des Laufs sichtbar. Lass die Seite offen, bis es fertig ist, danach hängt der Link nicht mehr an ihr.",
        },
        {
          text: "Kopiere den Link, oder lass die andere Person den QR daneben scannen, und verschick ihn, wie du willst. Die ganze Zeichenfolge zählt: Alles nach #k= ist der Entschlüsselungsschlüssel und erreicht den Server nie.",
          code: ["Link bereit — sende ihn dem Empfänger zum Herunterladen:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "So sieht ein erstellter Link aus",
        body: [
          "Die Seite ersetzt die Auswahl durch den Link, das Ablaufdatum und einen Kopieren-Knopf — dazu einen QR desselben Links und darunter den Baukasten, um ihn im Terminal abzuholen.",
          "Den Link selbst zu öffnen ist die ehrliche Bestätigung: Die Download-Seite zeigt die Überschrift des verschlüsselten Links, die Dateizahl mit der Gesamtgröße und einen Countdown der Restzeit. Was sie nicht zeigt, ist ein Weg für uns, die Datei zu lesen, denn der Schlüssel blieb im Fragment, das du kopiert hast.",
        ],
        code: ["Link bereit — sende ihn dem Empfänger zum Herunterladen:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
      },
    },
    {
      heading: "Ablauf und Löschung nach dem ersten Download",
      body: [
        "Jeder Link braucht eine Lebensdauer — einen für immer aktiv zu lassen, widerspricht dem Sinn einer einmaligen Übertragung. Beim Erstellen eines Links wählst du, wie lange er gültig bleiben soll, oder du stellst ihn so ein, dass er nach der ersten Nutzung sofort verschwindet.",
        "Löschung nach dem ersten Download bedeutet: ein Download und danach nichts mehr — nützlich, wenn die Datei sensibel ist und du willst, dass genau eine Person sie genau einmal sieht und danach nichts offen bleibt. Wann dieser eine Platz verbraucht ist, gehört aber genau gesagt: in dem Moment, in dem echter Chiffretext zu fließen beginnt, nicht wenn der Download fertig ist. Ein auf halbem Weg abgebrochener Download hat ihn bereits aufgebraucht, und der Link ist tot, obwohl die empfangende Person nur einen Teil der Datei hat. Nur ein Versuch, der gar nichts geliefert hat — null Bytes —, gibt den Platz zurück; ein Verbinden-und-sofort-Abbrechen kostet also nichts. Diese Asymmetrie ist Absicht: einen fast vollständigen Lesevorgang zu erstatten, ist genau der Weg, auf dem jemand mit dem Link eine Löschdatei immer wieder abziehen würde. In beiden Fällen sieht die empfangende Person auf der Download-Seite einen laufenden Countdown, sodass klar ist, wie viel Zeit (oder wie viele Downloads) noch bleiben — und bei einer wackeligen Verbindung lässt du die Löschung besser aus und wählst stattdessen eine kurze Frist.",
      ],
      bullets: [
        "1 Stunde",
        "1 Tag (Standard)",
        "3 Tage",
        "7 Tage",
        "14 Tage (Maximum, nur im höchsten Tarif)",
        "Oder: Löschung beim ersten Download, der überhaupt Bytes ausliefert, statt einer festen Frist",
      ],
    },
    {
      heading: "Die Zero-Knowledge-Garantie — und ihre Grenzen",
      body: [
        "So läuft es tatsächlich ab, wenn du einen Link erstellst: Dein Browser erzeugt einen zufälligen AES-256-GCM-Schlüssel — ein anderer Mechanismus als bei Relayiums Echtzeitmodus, der per X25519 einen Schlüssel zwischen zwei Geräten aushandelt; der Schlüssel eines gespeicherten Links wird lokal erzeugt, ohne dass etwas ausgehandelt werden muss. Dieser Schlüssel verschlüsselt deine Dateien und die Liste der Dateinamen, bevor irgendetwas dein Gerät verlässt, und wird nach einem `#` an den Download-Link angehängt — ein Teil der URL, den Browser nie an einen Server senden. Der Server speichert genau den Chiffretext, den er erhält, und nur diesen; er kann ihn nicht entschlüsseln, weil er den Schlüssel niemals bekommt.",
        "Dieses Design hat reale Kompromisse, die man kennen sollte. Der Schlüssel erreicht den Server nie, also gibt es kein Zurücksetzen des Passworts, das wir anbieten könnten. Ganz die einzige Kopie ist der Link aber nicht: Der Browser, aus dem du hochgeladen hast, behält ihn auch lokal, und „Meine Dateien“ auf der Kontoseite kann den Link in genau diesem Browser wieder zusammensetzen und kopieren. Unwiederbringlich wird eine Datei erst, wenn beides fehlt — der vollständige Link und diese lokale Kopie, was ein anderes Gerät oder das Löschen der Website-Daten dieses Browsers bedeutet. Danach ist der gespeicherte Chiffretext dauerhaft unlesbar, für dich wie für uns. Zum Erstellen eines Links muss der Absender angemeldet sein, und jeder Link zählt gegen das Speicherkontingent deines Kontos, bis er gelöscht wird oder abläuft. Und es lohnt sich, genau zu sein, was „Zero-Knowledge“ hier bedeutet: Der Chiffretext wird zwischen Erstellung und Download tatsächlich auf Relayiums Server gespeichert — er ist nur unlesbar ohne den Schlüssel, der deinen Browser nie verlassen hat.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Die andere Person öffnet den Link, und die Seite meldet, der Entschlüsselungsschlüssel fehle.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # der Schlüssel ist alles nach #k="],
            fix: "Das Fragment ist unterwegs verloren gegangen — eine Chat-Vorschau, ein Link-Verkürzer, oder eine Kopie, die am # endete. Schick den Link erneut als reinen Text und lass ihn selbst in die Adresszeile einfügen; die id allein ist von niemandem zu entschlüsseln, auch von uns nicht.",
          },
          {
            symptom: "Die Entschlüsselung scheitert, obwohl der ganze Link angekommen ist.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # zu einer id gehört genau ein Schlüssel"],
            fix: "id und Schlüssel stammen aus verschiedenen Links, was passiert, wenn zwei Uploads in derselben Sitzung kopiert werden. Kopiere den neuesten Link in einem Stück von der Seite, die ihn erstellt hat, oder öffne „Meine Dateien“ auf der Kontoseite in genau diesem Browser und kopiere den Link aus dem passenden Eintrag — das #k=-Fragment und die lokale Kopie dieses Browsers sind die einzigen beiden Orte, an denen der Schlüssel existiert, denn den Server hat er nie erreicht.",
          },
          {
            symptom: "Der Link meldet ungültig, abgelaufen, oder bereits heruntergeladen und gelöscht.",
            code: ["https://relayium.com/offline-transfer   # einen frischen Link ohne Löschung erstellen"],
            fix: "Alle drei sind derselbe Zustand: Es ist nichts mehr abzuholen. Mit aktivem „Nach dem Lesen löschen“ verbraucht der erste Download, der tatsächlich Chiffretext ausliefert, den einzigen Platz — ob er fertig wurde oder auf halbem Weg abbrach — lade also erneut hoch und lass es aus, wenn mehr als eine Person oder ein zweiter Versuch nötig ist.",
          },
          {
            symptom: "Die Download-Seite meldet zu viele Anfragen, oder das Monatsvolumen des Senders sei aufgebraucht.",
            code: ["https://relayium.com/me   # die Nutzung dieses Monats umfasst Transfer und Speicher"],
            fix: "Die Datei ist unversehrt, und das hier ist Abrechnung. Ein Ratenlimit löst sich in wenigen Minuten; ein aufgebrauchtes Monatsvolumen wartet auf den Monat, einen Tarifwechsel oder einen eigenen Node. Den Link danach erneut zu öffnen funktioniert, weil nichts verbraucht wurde.",
          },
          {
            symptom: "Du brauchst die Datei zurück und hast den Link nicht mehr.",
            code: ["https://relayium.com/me   # „Meine Dateien“ setzt den Link im hochladenden Browser wieder zusammen"],
            fix: "Probier zuerst den einen Weg, den es gibt: Der Browser, aus dem du hochgeladen hast, hat den Schlüssel lokal behalten. Öffne die Kontoseite in genau diesem Browser, such den Eintrag unter „Meine Dateien“ und nimm dessen Knopf zum Kopieren des Links. Auf jedem anderen Gerät, oder nachdem die Website-Daten dieses Browsers gelöscht wurden, ist der Schlüssel weg und der gespeicherte Chiffretext für alle unlesbar, auch für uns — dann lade die Datei erneut aus deiner eigenen Kopie hoch, weshalb die Seite sagt, eine zu behalten.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Braucht die Person, der ich den Link schicke, ein Konto?",
        a: "Nein. Wer den vollständigen Link hat — einschließlich des Teils nach dem `#` — kann ihn öffnen und die Dateien herunterladen. Nur der Absender muss sich anmelden, um den Link überhaupt zu erstellen.",
      },
      {
        q: "Kann Relayium meine Datei lesen?",
        a: "Nein. Dein Browser verschlüsselt die Dateien mit einem zufällig erzeugten AES-256-GCM-Schlüssel, bevor irgendetwas hochgeladen wird, und dieser Schlüssel reist nur im URL-Fragment, das den Server nie erreicht. Der Browser, aus dem du hochgeladen hast, behält zusätzlich eine lokale Kopie, damit „Meine Dateien“ den Link später wieder zusammensetzen kann. Der Server speichert Chiffretext, den er nicht entschlüsseln kann — ein Zero-Knowledge-Design.",
      },
      {
        q: "Wie lange bleiben Links gültig?",
        a: "Du entscheidest beim Erstellen: 1 Stunde, 1 Tag, 3 Tage, 7 Tage oder bis zu 14 Tage, je nach Tarif, oder du stellst statt einer festen Frist Löschung beim ersten Download ein. Der Platz ist verbraucht, sobald Bytes zu fließen beginnen, ein abgebrochener Download zählt also genauso. Danach funktioniert der Link nicht mehr.",
      },
      {
        q: "Ist die Datei nach Löschung nach dem ersten Download wirklich weg?",
        a: "Löschung nach dem ersten Download ist genau für einen einzigen Download gedacht, und der Platz ist verbraucht, sobald dieser Download echten Chiffretext auszuliefern beginnt: Danach funktioniert der Link für niemanden mehr, der ihn öffnet — selbst wenn dieser eine Download abbrach und nie fertig wurde. Nur ein Versuch, der überhaupt nichts übertragen hat, wird zurückgegeben.",
      },
    ],
  },
  cta: {
    text: "Datei fertig, aber gerade wartet niemand auf der anderen Seite? Erstelle einen ablaufenden Link im Browser und schick ihn, wenn du bereit bist.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Partager un fichier avec un lien de téléchargement à expiration",
  description:
    "Chiffrez un fichier dans votre navigateur et obtenez un lien que le serveur ne peut pas déchiffrer. Choisissez 1 heure, 1 jour, 3, 7 ou jusqu'à 14 jours selon votre offre, ou l'autodestruction après le premier téléchargement, puis envoyez-le.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Il n'y a pas toujours quelqu'un qui attend de l'autre côté d'un transfert. Le destinataire dort peut-être, est dans l'avion, ou vous voulez simplement déposer un lien dans un message et passer à autre chose. C'est pour cela que Relayium propose un second mode : au lieu de diffuser un fichier en direct vers un autre navigateur ouvert, il chiffre le fichier chez vous, ne téléverse que le texte chiffré, et vous remet un lien que vous pouvez envoyer quand vous voulez — le téléchargement se fait au moment qui convient au destinataire.",
    "Ce guide explique comment créer un tel lien, les options d'expiration et d'autodestruction après le premier téléchargement, et ce que la conception à divulgation nulle signifie concrètement — y compris les limites honnêtes : créer un lien exige que l'expéditeur se connecte, et les liens comptent dans un quota de stockage.",
  ],
  sections: [
    {
      heading: "Lien stocké ou temps réel : lequel choisir",
      body: [
        "Le mode temps réel de Relayium diffuse un fichier en direct entre deux onglets ouverts : sur le même LAN, WebRTC établit une connexion directe ; entre réseaux, les sessions navigateur utilisent TURN par conception pour transporter un texte chiffré de bout en bout que le relais ne peut ni lire ni déchiffrer. Relayium ne conserve aucune copie côté serveur ni aucun historique temps réel, mais les deux personnes doivent être en ligne en même temps. Un lien stocké et à expiration renverse cet équilibre : votre navigateur se charge du chiffrement et téléverse le résultat une seule fois, et le destinataire peut ouvrir le lien des minutes, des heures ou des jours plus tard, à son propre rythme.",
        "Utilisez un lien stocké quand vous ne savez pas exactement quand l'autre personne sera disponible, quand vous envoyez le même fichier à plusieurs personnes, ou quand vous voulez simplement quelque chose à coller dans un e-mail ou un chat et à oublier ensuite.",
      ],
    },
    {
      heading: "Comment créer un lien",
      body: ["Créer un lien prend quelques étapes, toutes dans le navigateur :"],
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Un compte connecté du côté qui envoie seulement — le destinataire n'en a jamais besoin et ne voit aucune invitation à se connecter.",
          "Des fichiers qui tiennent sous deux plafonds distincts : la limite par fichier affichée à côté du sélecteur, et le quota de stockage de votre offre. Les deux se lisent sur la page au lieu d'être devinés.",
          "Une durée de conservation autorisée par votre offre. La liste ne propose que les durées prises en charge par votre offre, et le serveur applique le même plafond par précaution sur ce qu'il reçoit.",
          "Votre propre copie de tout ce qui compte. La page le dit sous les options : livraison temporaire, pas une sauvegarde.",
        ],
      },
      steps: [
        {
          text: "Ouvrez la page de transfert asynchrone et connectez-vous. Seul l'expéditeur a besoin d'un compte, jamais le destinataire.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Choisissez un ou plusieurs fichiers, ou glissez-les. Le chiffre à côté du sélecteur est le plafond par fichier en vigueur pour votre compte.",
          code: ["Choisir des fichiers à envoyer\nMax 512 MiB"],
        },
        {
          text: "Réglez « Expire dans », ou activez « Autodestruction après lecture (supprimé au premier téléchargement) ». Le rappel en dessous, livraison temporaire et non sauvegarde, est la page qui vous dit de garder votre propre copie.",
          code: ["Expire dans\n1 jour"],
        },
        {
          text: "Attendez que le navigateur chiffre puis téléverse, les deux phases étant visibles pendant l'opération. Laissez la page ouverte jusqu'à la fin, après quoi le lien n'en dépend plus.",
        },
        {
          text: "Copiez le lien, ou faites scanner au destinataire le code QR à côté, et envoyez-le comme vous voulez. Toute la chaîne compte : ce qui suit #k= est la clé de déchiffrement et n'atteint jamais le serveur.",
          code: ["Lien prêt — envoyez-le au destinataire pour télécharger :\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "À quoi ressemble un lien créé",
        body: [
          "La page remplace le sélecteur par le lien, sa date d'expiration et un bouton de copie, avec un code QR du même lien et, en dessous, le générateur de commande pour le récupérer depuis un terminal.",
          "Ouvrir le lien vous-même est la vérification honnête : la page de téléchargement affiche le titre du lien chiffré, le nombre de fichiers avec la taille totale, et un décompte du temps restant. Ce qu'elle n'affiche pas, c'est un moyen pour nous de lire le fichier, car la clé est restée dans le fragment que vous avez copié.",
        ],
        code: ["Lien prêt — envoyez-le au destinataire pour télécharger :\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
      },
    },
    {
      heading: "Expiration et autodestruction après le premier téléchargement",
      body: [
        "Chaque lien a besoin d'une durée de vie — en laisser un actif pour toujours va à l'encontre de l'idée d'un transfert ponctuel. En créant un lien, vous choisissez combien de temps il doit rester valide, ou vous pouvez le régler pour qu'il disparaisse dès qu'il a été utilisé une fois.",
        "L'autodestruction après le premier téléchargement signifie un seul téléchargement, et plus rien ensuite — utile quand le fichier est sensible et que vous voulez qu'une seule personne le voie une seule fois, sans rien laisser traîner après. Reste à dire précisément quand cet unique jeton est consommé : au moment où du vrai texte chiffré commence à circuler, pas à la fin du téléchargement. Un téléchargement interrompu à mi-course l'a déjà consommé, et le lien est mort alors que le destinataire n'a qu'une partie du fichier. Seule une tentative qui n'a rien livré du tout — zéro octet — rend le jeton, si bien qu'une connexion aussitôt coupée ne coûte rien. Cette asymétrie est voulue : rembourser une lecture presque complète est exactement la manière dont quelqu'un qui détient le lien récupérerait un fichier autodestructible encore et encore. Dans les deux cas, le destinataire voit un compte à rebours en direct sur la page de téléchargement, pour savoir combien de temps (ou de téléchargements) il reste — et si sa connexion est fragile, laissez l'autodestruction de côté et choisissez plutôt une courte durée.",
      ],
      bullets: [
        "1 heure",
        "1 jour (par défaut)",
        "3 jours",
        "7 jours",
        "14 jours (le maximum, sur l'offre la plus élevée)",
        "Ou : autodestruction dès le premier téléchargement qui livre des octets, au lieu d'une durée fixe",
      ],
    },
    {
      heading: "La garantie à divulgation nulle, et ses limites",
      body: [
        "Voici ce qui se passe réellement quand vous créez un lien. Votre navigateur génère une clé AES-256-GCM aléatoire — ce n'est pas le même mécanisme que le mode temps réel de Relayium, qui négocie une clé entre deux appareils via X25519 ; la clé d'un lien stocké est générée localement, sans rien à négocier. Cette clé chiffre vos fichiers et la liste des noms de fichiers avant que quoi que ce soit ne quitte votre appareil, et elle est ajoutée au lien de téléchargement après un `#` — une partie de l'URL que les navigateurs n'envoient jamais à un serveur. Le serveur stocke le texte chiffré qu'on lui donne, et seulement lui ; il n'a aucun moyen de le déchiffrer, car il ne reçoit jamais la clé.",
        "Cette conception a de vrais compromis à connaître. La clé n'atteint jamais le serveur, donc aucune réinitialisation de mot de passe n'est possible de notre côté. Le lien n'en est pas tout à fait la seule copie pour autant : le navigateur depuis lequel vous avez téléversé conserve la clé localement lui aussi, et « Mes fichiers » sur la page de compte peut reconstruire et copier le lien dans ce même navigateur. Ce qui rend un fichier irrécupérable, c'est de perdre les deux — le lien complet et cette copie locale, ce qui revient à ouvrir la page de compte sur un autre appareil ou à effacer les données de site de ce navigateur. Passé ce point, le texte chiffré stocké est définitivement illisible, pour vous comme pour nous. Créer un lien exige que l'expéditeur soit connecté, et chaque lien compte dans le quota de stockage de votre compte jusqu'à sa suppression ou son expiration. Et il vaut la peine d'être précis sur ce que signifie ici « divulgation nulle » : le texte chiffré est bel et bien stocké sur le serveur de Relayium entre la création et le téléchargement — il est simplement illisible sans la clé qui n'a jamais quitté votre navigateur.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Le destinataire ouvre le lien et la page indique que la clé de déchiffrement est absente.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # la clé est tout ce qui suit #k="],
            fix: "Le fragment a été perdu en route, par un aperçu de messagerie, un raccourcisseur de liens, ou une copie arrêtée au #. Renvoyez le lien en texte brut et faites-le coller dans la barre d'adresse par le destinataire, car l'id seule n'est déchiffrable par personne, nous compris.",
          },
          {
            symptom: "Le déchiffrement échoue alors que le lien entier est arrivé.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # une id correspond à exactement une clé"],
            fix: "L'id et la clé viennent de deux liens différents, ce qui arrive quand deux envois sont copiés dans la même séance. Copiez le lien le plus récent d'un seul bloc depuis la page qui l'a créé, ou ouvrez « Mes fichiers » sur la page de compte dans ce même navigateur et copiez le lien depuis la bonne entrée. Le fragment #k= et la copie locale de ce navigateur sont les deux seuls endroits où la clé existe, car elle n'a jamais atteint le serveur.",
          },
          {
            symptom: "Le lien se déclare invalide, expiré, ou déjà téléchargé puis supprimé.",
            code: ["https://relayium.com/offline-transfer   # créez un nouveau lien sans autodestruction"],
            fix: "Les trois désignent le même état : il ne reste rien à récupérer. Avec l'autodestruction activée, le premier téléchargement qui livre réellement du texte chiffré consomme l'unique jeton — qu'il soit allé au bout ou qu'il ait cassé à mi-course —, alors renvoyez-le et laissez l'option désactivée quand plusieurs personnes, ou une seconde tentative, en ont besoin.",
          },
          {
            symptom: "La page de téléchargement signale trop de requêtes, ou un volume mensuel épuisé chez l'expéditeur.",
            code: ["https://relayium.com/me   # l'utilisation du mois couvre le transfert et le stockage"],
            fix: "Le fichier est intact et il s'agit de décompte. Une limitation de débit se lève en quelques minutes, tandis qu'un volume mensuel épuisé attend le mois suivant, un changement d'offre ou votre propre nœud. Rouvrir le lien ensuite fonctionne, car rien n'a été consommé.",
          },
          {
            symptom: "Vous avez besoin du fichier et vous n'avez plus le lien.",
            code: ["https://relayium.com/me   # « Mes fichiers » reconstruit le lien dans le navigateur qui a téléversé"],
            fix: "Commencez par la seule voie de récupération qui existe. Le navigateur depuis lequel vous avez téléversé a gardé la clé localement, donc ouvrez la page de compte dans ce même navigateur, trouvez l'entrée sous « Mes fichiers » et utilisez son bouton de copie du lien. Sur tout autre appareil, ou après effacement des données de site de ce navigateur, la clé a disparu et le texte chiffré stocké est illisible pour tout le monde, nous compris. Téléversez alors le fichier de nouveau depuis votre propre copie, ce que la page vous invite justement à garder.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La personne à qui j'envoie le lien a-t-elle besoin d'un compte ?",
        a: "Non. Quiconque possède le lien complet — y compris la partie après le `#` — peut l'ouvrir et télécharger les fichiers. Seul l'expéditeur doit se connecter pour créer le lien.",
      },
      {
        q: "Relayium peut-il lire mon fichier ?",
        a: "Non. Votre navigateur chiffre les fichiers avec une clé AES-256-GCM générée aléatoirement avant tout téléversement, et cette clé ne voyage que dans le fragment de l'URL, qui n'atteint jamais le serveur. Le navigateur depuis lequel vous avez téléversé en garde aussi une copie locale, pour que « Mes fichiers » puisse reconstruire le lien plus tard. Le serveur stocke un texte chiffré qu'il ne peut pas déchiffrer — une conception à divulgation nulle.",
      },
      {
        q: "Combien de temps les liens durent-ils ?",
        a: "Vous choisissez à la création : 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre, ou réglez une autodestruction dès le premier téléchargement au lieu d'une durée fixe. Le jeton est consommé dès que des octets commencent à circuler, un téléchargement interrompu compte donc aussi. Passé ce délai, le lien cesse de fonctionner.",
      },
      {
        q: "Le fichier disparaît-il vraiment après l'autodestruction ?",
        a: "L'autodestruction après le premier téléchargement est conçue pour exactement un seul téléchargement : le jeton est consommé dès que ce téléchargement commence à livrer du vrai texte chiffré, donc le lien ne fonctionne plus pour personne qui l'ouvrirait ensuite, même si cet unique téléchargement a été interrompu sans jamais aboutir. Seule une tentative qui n'a rien transféré du tout est rendue.",
      },
    ],
  },
  cta: {
    text: "Un fichier prêt mais personne n'attend encore de l'autre côté ? Créez un lien à expiration dans votre navigateur et envoyez-le quand vous êtes prêt.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "مشاركة ملف برابط تنزيل آمن ينتهي صلاحيته",
  description:
    "شفّر ملفًا في متصفحك واحصل على رابط لا يستطيع الخادم فك تشفيره. اختر ساعة واحدة، أو يومًا واحدًا، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب خطتك، أو الحذف بعد أول تنزيل، ثم أرسله متى كنت مستعدًا.",
  updatedLabel: "آخر تحديث",
  lead: [
    "ليس في كل عملية نقل من ينتظر على الطرف الآخر. ربما يكون المُستقبِل نائمًا، أو على متن طائرة، أو تريد ببساطة أن تترك رابطًا في رسالة وتمضي في يومك. لذلك لدى Relayium وضع ثانٍ: بدلًا من بثّ ملف مباشرةً إلى متصفح آخر مفتوح، يشفّر الملف حيث أنت، ويرفع النص المُشفَّر فقط، ويسلّمك رابطًا يمكنك إرساله متى شئت — ويحدث التنزيل وفق جدول المُستقبِل نفسه.",
    "يرشدك هذا الدليل خلال إنشاء أحد هذه الروابط، وخيارات انتهاء الصلاحية والحذف بعد القراءة، وما يعنيه تصميم المعرفة الصفرية بالضبط عمليًا — بما في ذلك الحدود الصريحة: إنشاء رابط يتطلب أن يسجّل المُرسِل الدخول، والروابط تُحتسب ضمن حصة تخزين.",
  ],
  sections: [
    {
      heading: "الروابط المُخزَّنة مقابل الوضع الفوري: متى تستخدم كلًا منهما",
      body: [
        "يبث وضع Relayium الفوري ملفًا حيًا بين علامتي تبويب مفتوحتين: داخل شبكة LAN نفسها يتصل WebRTC مباشرةً، أما جلسات المتصفح عبر الشبكات فتستخدم TURN حسب التصميم لنقل نص مشفّر من الطرف إلى الطرف لا يستطيع المُرحِّل قراءته أو فك تشفيره. لا يحتفظ Relayium بنسخة على الخادم أو بسجل للنقل الفوري، لكن يلزم أن يكون كلا الشخصين متصلين معًا. الرابط المُخزَّن المنتهي الصلاحية يقلب هذه المقايضة: يقوم متصفحك بالتشفير ويرفع النتيجة مرة واحدة، ويمكن للمُستقبِل فتح الرابط بعد دقائق أو ساعات أو أيام، في وقته الخاص.",
        "استخدم رابطًا مُخزَّنًا عندما لا تعرف بالضبط متى سيكون الطرف الآخر متفرغًا، أو عندما ترسل الملف نفسه إلى أكثر من شخص، أو عندما تريد فقط شيئًا تلصقه في بريد إلكتروني أو محادثة وتنتهي منه.",
      ],
    },
    {
      heading: "كيفية إنشاء رابط",
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "حساب مسجَّل الدخول في جهة الإرسال وحدها — فالمُستقبِل لا يحتاج إليه أبدًا ولا يرى أي مطالبة بتسجيل الدخول.",
          "ملفات تتّسع تحت سقفين منفصلين: حدّ الملف الواحد المطبوع جوار المنتقي، وحصة التخزين في باقتك. ويُقرأ كلٌّ منهما من الصفحة لا بالتخمين.",
          "مدة احتفاظ تسمح بها باقتك. ولا تعرض القائمة إلا المدد التي تدعمها باقتك، ويطبّق الخادم السقف نفسه احترازيًا على ما يصله.",
          "نسختك الخاصة من كل ما يهمّ. تقول الصفحة ذلك أسفل الخيارات: تسليم مؤقت، لا نسخة احتياطية.",
        ],
      },
      body: ["إنشاء رابط يستغرق بضع خطوات، كلها في المتصفح:"],
      steps: [
        {
          text: "افتح صفحة النقل غير المتزامن وسجّل الدخول. المُرسِل وحده يحتاج إلى حساب؛ أما المُستقبِل فلن يحتاجه أبدًا.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "اختر ملفًا واحدًا أو أكثر، أو اسحبها إلى الداخل. الرقم المجاور للمنتقي هو سقف الملف الواحد النافذ لحسابك.",
          code: ["اختر ملفات للرفع\nالحد الأقصى 512 MiB"],
        },
        {
          text: "اضبط «تنتهي صلاحيته خلال»، أو فعّل «الحذف بعد القراءة (يُحذَف عند أول تنزيل)». والتنبيه أسفلهما — تسليم مؤقت لا نسخة احتياطية — هو الصفحة تخبرك أن تحتفظ بنسختك.",
          code: ["تنتهي صلاحيته خلال\nيوم واحد"],
        },
        {
          text: "انتظر بينما يشفّر المتصفح ثم يرفع، وكلتا المرحلتين ظاهرتان أثناء تنفيذهما. أبقِ الصفحة مفتوحة حتى تنتهي، وبعدها لا يعتمد الرابط عليها.",
        },
        {
          text: "انسخ الرابط، أو اطلب من المُستقبِل مسح رمز QR المجاور له، ثم أرسِله كما يحلو لك. والسلسلة كلها مهمة: فكل ما بعد ‎#k=‎ هو مفتاح فكّ التشفير ولا يصل إلى الخادم أبدًا.",
          code: ["الرابط جاهز — أرسِله إلى المُستقبِل للتنزيل:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "كيف يبدو الرابط بعد إنشائه",
        body: [
          "تستبدل الصفحة المنتقي بالرابط وتاريخ انتهاء صلاحيته وزر نسخ — ومعها رمز QR للرابط نفسه، وتحته منشئ الأمر لجلبه من الطرفية.",
          "وفتح الرابط بنفسك هو التأكيد الصادق: تُظهِر صفحة التنزيل عنوان رابط التنزيل المشفّر، وعدد الملفات مع الحجم الإجمالي، وعدًّا تنازليًا للوقت المتبقي. وما لا تُظهِره هو أي وسيلة تتيح لنا قراءة الملف، لأن المفتاح بقي في الجزء الذي نسخته.",
        ],
        code: ["الرابط جاهز — أرسِله إلى المُستقبِل للتنزيل:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…\nينتهي هذا الرابط في الخميس 6 أغسطس 2026 الساعة 21:40"],
      },
    },
    {
      heading: "انتهاء الصلاحية والحذف بعد القراءة",
      body: [
        "كل رابط يحتاج إلى عمر — إبقاء رابط حيًا إلى الأبد ليس هو الغرض من نقلة لمرة واحدة. عند إنشاء رابط تختار كم ينبغي أن يبقى صالحًا، أو يمكنك ضبطه ليختفي بمجرد استخدامه مرة واحدة.",
        "الحذف بعد القراءة يعني تنزيلًا واحدًا ولا شيء بعده — مفيد عندما يكون الملف حساسًا وتريد شخصًا واحدًا بالضبط، مرة واحدة، دون أن يبقى شيء عالقًا بعد ذلك. لكن يجدر تحديد متى تُستهلك هذه الحصة الوحيدة بالضبط: تُستهلك في اللحظة التي يبدأ فيها النص المشفَّر الحقيقي بالتدفق، لا عند اكتمال التنزيل. والتنزيل الذي ينقطع في منتصف الطريق يكون قد استهلكها فعلًا، فيموت الرابط رغم أن المُستقبِل لا يملك سوى جزء من الملف. ولا تُعاد الحصة إلا لمحاولة لم تُسلِّم شيئًا على الإطلاق — صفر بايت — أي أن اتصالًا ينقطع فور قيامه لا يكلّف شيئًا. وهذا التفاوت مقصود: فردّ قراءة شارفت على الاكتمال هو بالضبط الطريقة التي يسحب بها حاملُ الرابط ملفًا للحذف مرة بعد مرة. في كلتا الحالتين، يرى المُستقبِل عدًا تنازليًا حيًا على صفحة التنزيل، فيعرف كم بقي من الوقت (أو كم بقي من التنزيلات) — وإن كان اتصاله متذبذبًا فاترك الحذف معطَّلًا واختر مدة صلاحية قصيرة بدلًا منه.",
      ],
      bullets: [
        "ساعة واحدة",
        "يوم واحد (الافتراضي)",
        "3 أيام",
        "7 أيام",
        "14 يومًا (الحد الأقصى، في الخطة الأعلى)",
        "أو: الحذف عند أول تنزيل يُسلِّم بايتات فعلًا، بدلًا من وقت ثابت",
      ],
    },
    {
      heading: "ضمان المعرفة الصفرية، وحدوده",
      body: [
        "إليك ما يحدث فعلًا عندما تنشئ رابطًا. يولّد متصفحك مفتاح AES-256-GCM عشوائيًا — آلية مختلفة عن وضع Relayium الفوري الذي يتفاوض على مفتاح بين جهازين باستخدام X25519؛ أما مفتاح الرابط المُخزَّن فيُولَّد محليًا، دون شيء للتفاوض عليه. يشفّر ذلك المفتاح ملفاتك وقائمة أسماء الملفات قبل أن يغادر أي شيء جهازك، ويُلحَق برابط التنزيل بعد `#` — وهو جزء من الـ URL لا ترسله المتصفحات أبدًا إلى أي خادم. يخزّن الخادم النص المُشفَّر الذي يُعطى له، والنص المُشفَّر وحده؛ ولا سبيل لديه لفك تشفيره، لأنه لا يتلقى المفتاح أبدًا.",
        "لهذا التصميم مقايضات حقيقية تستحق المعرفة. المفتاح لا يصل إلى الخادم أبدًا، فليست لدينا إعادة تعيين لكلمة مرور نقدّمها لك. لكن الرابط ليس تمامًا نسخته الوحيدة: فالمتصفح الذي رفعت منه يحتفظ به محليًا أيضًا، و«ملفاتي» في صفحة الحساب تستطيع إعادة تركيب الرابط ونسخه داخل المتصفح نفسه. وما يجعل الملف غير قابل للاسترجاع هو فقدان الاثنين معًا — الرابط الكامل وتلك النسخة المحلية، وهو ما يعنيه فتح صفحة الحساب على جهاز آخر أو مسح بيانات الموقع في هذا المتصفح. وبعد ذلك يصبح النص المشفَّر المخزَّن غير قابل للقراءة نهائيًا، لك ولنا معًا. إنشاء رابط يتطلب أن يكون المُرسِل مسجّل الدخول، وكل رابط يُحتسب ضمن حصة تخزين حسابك حتى يُحذف أو تنتهي صلاحيته. ويجدر أن نكون دقيقين بشأن ما تعنيه «المعرفة الصفرية» هنا: النص المُشفَّر مخزَّن فعلًا على خادم Relayium بين الإنشاء والتنزيل — لكنه فقط غير قابل للقراءة دون المفتاح الذي لم يغادر متصفحك أبدًا.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "يفتح المُستقبِل الرابط فتقول الصفحة إن مفتاح فكّ التشفير مفقود.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # المفتاح هو كل ما يلي ‎#k=‎"],
            fix: "فُقد جزء المرجع في الطريق — معاينة محادثة، أو خدمة تقصير روابط، أو نسخٌ توقّف عند علامة #. أرسِل الرابط مرة أخرى كنص عادي، واطلب منه لصقه في شريط العنوان بنفسه؛ فالمعرّف وحده لا يستطيع أحد فكّ تشفيره، بمن فيهم نحن.",
          },
          {
            symptom: "يفشل فكّ التشفير مع أن الرابط كله وصل.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # لكل معرّف مفتاح واحد بالضبط"],
            fix: "المعرّف والمفتاح جاءا من رابطين مختلفين، وهو ما يحدث عند نسخ رفعين في الجلسة نفسها. انسخ أحدث رابط كقطعة واحدة من الصفحة التي أنشأته، أو افتح «ملفاتي» في صفحة الحساب داخل المتصفح نفسه وانسخ الرابط من المُدخَل الصحيح؛ فجزء ‎#k=‎ والنسخة المحلية في ذلك المتصفح هما المكانان الوحيدان اللذان يوجد فيهما المفتاح، لأنه لم يصل إلى الخادم قط.",
          },
          {
            symptom: "يقول الرابط إنه غير صالح أو منتهي الصلاحية أو جرى تنزيله وحذفه بالفعل.",
            code: ["https://relayium.com/offline-transfer   # أنشِئ رابطًا جديدًا مع تعطيل الحذف"],
            fix: "الثلاثة حالة واحدة: لم يبقَ شيء ليُجلَب. ومع تفعيل «الحذف بعد القراءة» يستهلك أولُ تنزيل يُسلِّم نصًا مشفَّرًا فعليًا الحصةَ الوحيدة — سواء اكتمل أو انقطع في منتصفه — فارفع مرة أخرى واترك الخيار معطَّلًا عندما يحتاجه أكثر من شخص أو تحتاج إلى محاولة ثانية.",
          },
          {
            symptom: "تقول صفحة التنزيل إن الطلبات كثيرة جدًا، أو إن حصة النقل الشهرية للمُرسِل استُنفدت.",
            code: ["https://relayium.com/me   # «استخدام هذا الشهر» يشمل النقل والتخزين"],
            fix: "الملف سليم وهذه مسألة قياس. يزول تحديد المعدل بعد دقائق، أما حصة النقل الشهرية المستنفدة فتنتظر شهرًا جديدًا أو ترقية أو عقدة خاصة بك. وفتح الرابط بعد ذلك يعمل، لأن لا شيء استُهلك.",
          },
          {
            symptom: "تحتاج إلى الملف ولم يبقَ لديك الرابط.",
            code: ["https://relayium.com/me   # «ملفاتي» تعيد تركيب الرابط في المتصفح الذي رُفع منه"],
            fix: "جرّب أولًا مسار الاستعادة الوحيد الموجود: فالمتصفح الذي رفعت منه احتفظ بالمفتاح محليًا، فافتح صفحة الحساب في المتصفح نفسه، وابحث عن المُدخَل تحت «ملفاتي» واستخدم زر نسخ الرابط الخاص به. أما على أي جهاز آخر، أو بعد مسح بيانات الموقع في ذلك المتصفح، فيضيع المفتاح ويصبح النص المشفَّر المخزَّن غير قابل للقراءة لأي أحد، بمن فيهم نحن — عندها ارفع الملف مرة أخرى من نسختك الخاصة، ولهذا تحديدًا تنبّهك الصفحة إلى الاحتفاظ بواحدة.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يحتاج الشخص الذي أرسل إليه الرابط إلى حساب؟",
        a: "لا. أي شخص لديه الرابط الكامل — بما في ذلك الجزء الذي بعد `#` — يمكنه فتحه وتنزيل الملفات. المُرسِل وحده يحتاج إلى تسجيل الدخول لإنشاء الرابط في المقام الأول.",
      },
      {
        q: "هل يستطيع Relayium قراءة ملفي؟",
        a: "لا. يشفّر متصفحك الملفات بمفتاح AES-256-GCM عشوائي قبل أن يُرفع أي شيء، ولا ينتقل ذلك المفتاح إلا في جزء الـ URL (fragment) الذي لا يصل إلى الخادم أبدًا. كما يحتفظ المتصفح الذي رفعت منه بنسخة محلية منه كي تستطيع «ملفاتي» إعادة تركيب الرابط لاحقًا. يخزّن الخادم نصًا مُشفَّرًا لا سبيل لديه لفك تشفيره — وهو تصميم قائم على المعرفة الصفرية.",
      },
      {
        q: "كم تدوم الروابط؟",
        a: "تختار عند إنشاء الرابط: ساعة واحدة، أو يومًا واحدًا، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب خطتك، أو يمكنك ضبطه ليُحذف عند أول تنزيل بدلًا من انتهاء صلاحية ثابت. وتُستهلك الحصة بمجرد أن تبدأ البايتات بالتدفق، فالتنزيل المنقطع يُحسب كذلك. بعد تلك النقطة يتوقف الرابط عن العمل.",
      },
      {
        q: "هل يختفي الملف حقًا بعد الحذف بعد القراءة؟",
        a: "الحذف بعد القراءة مصمَّم لتنزيل واحد بالضبط، وتُستهلك الحصة بمجرد أن يبدأ ذلك التنزيل بتسليم نص مشفَّر حقيقي: فيتوقف الرابط عن العمل لأي شخص يفتحه بعد ذلك — حتى لو انقطع ذلك التنزيل الوحيد ولم يكتمل. ولا تُعاد إلا محاولة لم تنقل شيئًا على الإطلاق.",
      },
    ],
  },
  cta: {
    text: "لديك ملف جاهز لكن لا أحد ينتظر على الطرف الآخر؟ أنشئ رابطًا ينتهي صلاحيته في متصفحك وأرسله متى كنت مستعدًا.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Compartir un archivo con un enlace de descarga seguro y con caducidad",
  description:
    "Cifra un archivo en tu navegador y obtén un enlace que el servidor no puede descifrar. Elige 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o que se borre tras la primera descarga, y luego envíalo cuando estés listo.",
  updatedLabel: "Última actualización",
  lead: [
    "No en toda transferencia hay alguien esperando del otro lado. Quizás el destinatario está dormido, en un vuelo, o simplemente quieres dejar un enlace en un mensaje y seguir con tu día. Para eso Relayium tiene un segundo modo: en lugar de transmitir un archivo en vivo a otro navegador abierto, cifra el archivo donde estás, sube solo el texto cifrado y te entrega un enlace que puedes enviar cuando quieras — la descarga ocurre según el horario del propio destinatario.",
    "Esta guía recorre la creación de uno de estos enlaces, las opciones de caducidad y de borrado tras la lectura, y qué significa exactamente en la práctica el diseño de conocimiento cero — incluidos los límites honestos: crear un enlace requiere que el remitente inicie sesión, y los enlaces se descuentan de una cuota de almacenamiento.",
  ],
  sections: [
    {
      heading: "Enlaces almacenados vs. tiempo real: cuándo usar cada uno",
      body: [
        "El modo en tiempo real de Relayium transmite un archivo en vivo entre dos pestañas abiertas: en la misma LAN, WebRTC conecta directamente; entre redes, las sesiones del navegador usan TURN por diseño para transportar texto cifrado de extremo a extremo que el retransmisor no puede leer ni descifrar. Relayium no conserva copia del lado del servidor ni historial en tiempo real, pero ambas personas deben estar en línea a la vez. Un enlace almacenado y con caducidad le da la vuelta a ese equilibrio: tu navegador se encarga del cifrado y sube el resultado una sola vez, y el destinatario puede abrir el enlace minutos, horas o días después, a su propio ritmo.",
        "Usa un enlace almacenado cuando no sabes exactamente cuándo estará libre la otra persona, cuando envías el mismo archivo a más de una persona, o cuando simplemente quieres algo que puedas pegar en un correo o chat y olvidarte del asunto.",
      ],
    },
    {
      heading: "Cómo crear un enlace",
      body: ["Crear un enlace lleva unos pocos pasos, todos en el navegador:"],
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Una cuenta conectada solo en el lado que envía — el destinatario no necesita ninguna y no ve ningún aviso de inicio de sesión.",
          "Archivos que quepan bajo dos techos distintos: el límite por archivo impreso junto al selector, y la cuota de almacenamiento de tu plan. Los dos se leen en la página en vez de suponerlos.",
          "Una ventana de retención que tu plan permita. La lista solo ofrece las ventanas que tu plan admite, y el servidor aplica ese mismo tope de forma defensiva a lo que recibe.",
          "Tu propia copia de todo lo importante. La página lo dice bajo las opciones: entrega temporal, no una copia de seguridad.",
        ],
      },
      steps: [
        {
          text: "Abre la página de transferencia asíncrona e inicia sesión. Solo el remitente necesita una cuenta; el destinatario nunca.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Elige uno o más archivos, o arrástralos. La cifra junto al selector es el techo por archivo vigente para tu cuenta.",
          code: ["Elige archivos para subir\nMáx. 512 MiB"],
        },
        {
          text: "Ajusta «Caduca en», o activa «Destrucción tras la lectura (eliminar en la primera descarga)». El recordatorio de debajo, entrega temporal y no copia de seguridad, es la página diciéndote que guardes la tuya.",
          code: ["Caduca en\n1 día"],
        },
        {
          text: "Espera mientras el navegador cifra y luego sube; las dos fases se ven mientras ocurren. Deja la página abierta hasta que termine, y después el enlace ya no depende de ella.",
        },
        {
          text: "Copia el enlace, o que el destinatario escanee el QR de al lado, y envíalo como prefieras. Importa la cadena entera: todo lo que sigue a #k= es la clave de descifrado y nunca llega al servidor.",
          code: ["Enlace listo — envíaselo al destinatario para que descargue:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "Qué se ve cuando el enlace está creado",
        body: [
          "La página sustituye el selector por el enlace, la fecha en que caduca y un botón de copiar, además de un QR del mismo enlace y, debajo, el generador del comando para recogerlo desde una terminal.",
          "Abrir el enlace tú mismo es la comprobación honesta: la página de descarga muestra el título del enlace cifrado, el número de archivos con el tamaño total y una cuenta atrás del tiempo restante. Lo que no muestra es ninguna forma de que nosotros leamos el archivo, porque la clave se quedó en el fragmento que copiaste.",
        ],
        code: ["Enlace listo — envíaselo al destinatario para que descargue:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…\nEste enlace caduca el jueves, 6 de agosto de 2026 a las 21:40"],
      },
    },
    {
      heading: "Caducidad y borrado tras la lectura",
      body: [
        "Todo enlace necesita una vida útil — dejar uno activo para siempre no es el sentido de una transferencia puntual. Al crear un enlace eliges cuánto tiempo debe seguir siendo válido, o puedes configurarlo para que desaparezca en cuanto se use una vez.",
        "El borrado tras la lectura significa una descarga y nada más — útil cuando el archivo es sensible y quieres exactamente una persona, una vez, sin que quede nada colgando después. Conviene precisar cuándo se gasta esa única plaza: se gasta en el momento en que empieza a circular texto cifrado de verdad, no cuando la descarga termina. Una descarga interrumpida a mitad ya la consumió, y el enlace queda muerto aunque el destinatario solo tenga parte del archivo. Solo un intento que no entregó nada en absoluto — cero bytes — devuelve la plaza, así que conectar y cortar enseguida no cuesta nada. Esa asimetría es deliberada: devolver una lectura casi completa es justo la manera en que quien tiene el enlace se llevaría un archivo de un solo uso una y otra vez. En cualquier caso, el destinatario ve una cuenta atrás en vivo en la página de descarga, así que sabe cuánto tiempo (o cuántas descargas) le quedan — y si su conexión es inestable, deja el borrado apagado y elige una caducidad corta.",
      ],
      bullets: [
        "1 hora",
        "1 día (el valor por defecto)",
        "3 días",
        "7 días",
        "14 días (el máximo, en el plan superior)",
        "O: borrado en la primera descarga que entregue bytes, en lugar de un tiempo fijo",
      ],
    },
    {
      heading: "La garantía de conocimiento cero, y sus límites",
      body: [
        "Esto es lo que realmente ocurre cuando creas un enlace. Tu navegador genera una clave AES-256-GCM aleatoria — un mecanismo distinto del modo en tiempo real de Relayium, que negocia una clave entre dos dispositivos con X25519; la clave de un enlace almacenado se genera localmente, sin nada que negociar. Esa clave cifra tus archivos y la lista de nombres de archivo antes de que nada salga de tu dispositivo, y se añade al enlace de descarga después de un `#` — una parte de la URL que los navegadores nunca envían a ningún servidor. El servidor almacena el texto cifrado que se le da, y solo el texto cifrado; no tiene forma de descifrarlo, porque nunca recibe la clave.",
        "Ese diseño tiene compromisos reales que conviene conocer. La clave nunca llega al servidor, así que no hay restablecimiento de contraseña que podamos ofrecerte. Tampoco es exactamente la única copia: el navegador desde el que subiste la guarda también en local, y «Mis archivos» en la página de cuenta puede reconstruir y copiar el enlace en ese mismo navegador. Lo que deja un archivo irrecuperable es perder las dos cosas — el enlace completo y esa copia local, que es lo que significa abrir la página de cuenta en otro dispositivo o borrar los datos de sitio de este navegador. A partir de ahí, el texto cifrado almacenado queda permanentemente ilegible, para ti y para nosotros. Crear un enlace requiere que el remitente haya iniciado sesión, y cada enlace se descuenta de la cuota de almacenamiento de tu cuenta hasta que se borra o caduca. Y vale la pena ser precisos sobre lo que significa aquí «conocimiento cero»: el texto cifrado sí se almacena en el servidor de Relayium entre la creación y la descarga — solo que es ilegible sin la clave que nunca salió de tu navegador.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El destinatario abre el enlace y la página dice que falta la clave de descifrado.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # la clave es todo lo que sigue a #k="],
            fix: "El fragmento se perdió por el camino: una vista previa de chat, un acortador de enlaces, o una copia que se detuvo en el #. Envía el enlace otra vez como texto plano y que lo pegue él mismo en la barra de direcciones, porque el id a solas no lo puede descifrar nadie, nosotros incluidos.",
          },
          {
            symptom: "El descifrado falla aunque llegó el enlace completo.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # a un id le corresponde exactamente una clave"],
            fix: "El id y la clave vienen de enlaces distintos, algo que pasa cuando se copian dos subidas en la misma sesión. Copia el enlace más reciente de una pieza desde la página que lo creó, o abre «Mis archivos» en la página de cuenta en ese mismo navegador y copia el enlace de la entrada correcta: el fragmento #k= y la copia local de ese navegador son los dos únicos sitios donde existe la clave, porque nunca llegó al servidor.",
          },
          {
            symptom: "El enlace se declara no válido, caducado, o ya descargado y eliminado.",
            code: ["https://relayium.com/offline-transfer   # crea un enlace nuevo con la destrucción apagada"],
            fix: "Los tres son el mismo estado: no queda nada que recoger. Con «Destrucción tras la lectura» activada, la primera descarga que entrega texto cifrado de verdad gasta la única plaza — haya terminado o se haya cortado a mitad —, así que vuelve a subirlo y déjala apagada cuando lo necesiten varias personas o un segundo intento.",
          },
          {
            symptom: "La página de descarga informa de demasiadas peticiones, o de que la transferencia mensual del remitente está agotada.",
            code: ["https://relayium.com/me   # el uso de este mes cubre transferencia y almacenamiento"],
            fix: "El archivo está intacto y esto es medición. Un límite de tasa se levanta en unos minutos, mientras que una transferencia mensual agotada espera al mes siguiente, a un cambio de plan o a tu propio nodo. Volver a abrir el enlace después funciona, porque no se consumió nada.",
          },
          {
            symptom: "Necesitas el archivo y ya no tienes el enlace.",
            code: ["https://relayium.com/me   # «Mis archivos» reconstruye el enlace en el navegador que lo subió"],
            fix: "Prueba primero la única vía de recuperación que existe: el navegador desde el que subiste guardó la clave en local, así que abre la página de cuenta en ese mismo navegador, busca la entrada bajo «Mis archivos» y usa su botón de copiar enlace. En cualquier otro dispositivo, o después de borrar los datos de sitio de ese navegador, la clave desaparece y el texto cifrado almacenado es ilegible para todos, también para nosotros — entonces vuelve a subir el archivo desde tu propia copia, que es justo lo que la página te pide conservar.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿La persona a la que envío el enlace necesita una cuenta?",
        a: "No. Cualquiera que tenga el enlace completo — incluida la parte después del `#` — puede abrirlo y descargar los archivos. Solo el remitente necesita iniciar sesión para crear el enlace en primer lugar.",
      },
      {
        q: "¿Puede Relayium leer mi archivo?",
        a: "No. Tu navegador cifra los archivos con una clave AES-256-GCM aleatoria antes de subir nada, y esa clave solo viaja en el fragmento de la URL, que nunca llega al servidor. El navegador desde el que subiste guarda además una copia local para que «Mis archivos» pueda reconstruir el enlace más tarde. El servidor almacena texto cifrado que no tiene forma de descifrar — un diseño de conocimiento cero.",
      },
      {
        q: "¿Cuánto duran los enlaces?",
        a: "Lo eliges al crear el enlace: 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o puedes configurarlo para que se borre en la primera descarga en lugar de una caducidad fija. La plaza se gasta en cuanto empiezan a circular bytes, así que una descarga interrumpida cuenta igual. Pasado ese punto, el enlace deja de funcionar.",
      },
      {
        q: "¿El archivo realmente desaparece tras el borrado por lectura?",
        a: "El borrado tras la lectura está diseñado para exactamente una descarga, y la plaza se gasta en cuanto esa descarga empieza a entregar texto cifrado de verdad: el enlace deja de funcionar para cualquiera que lo abra después, incluso si esa única descarga se cortó y nunca terminó. Solo se devuelve un intento que no transfirió nada en absoluto.",
      },
    ],
  },
  cta: {
    text: "¿Tienes un archivo listo pero nadie esperando del otro lado? Crea un enlace con caducidad en tu navegador y envíalo cuando estés listo.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Compartilhar um arquivo com um link de download seguro e com validade",
  description:
    "Criptografe um arquivo no seu navegador e obtenha um link que o servidor não consegue descriptografar. Escolha 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou que se autodestrua após o primeiro download, e envie quando estiver pronto.",
  updatedLabel: "Última atualização",
  lead: [
    "Nem toda transferência tem alguém esperando do outro lado. Talvez o destinatário esteja dormindo, em um voo, ou você só queira deixar um link em uma mensagem e seguir com o seu dia. Para isso o Relayium tem um segundo modo: em vez de transmitir um arquivo ao vivo para outro navegador aberto, ele criptografa o arquivo onde você está, envia apenas o texto cifrado e lhe entrega um link que você pode enviar quando quiser — o download acontece de acordo com a agenda do próprio destinatário.",
    "Este guia percorre a criação de um desses links, as opções de validade e de autodestruição após a leitura, e o que exatamente o design de conhecimento zero significa na prática — incluindo os limites honestos: criar um link exige que o remetente faça login, e os links contam contra uma cota de armazenamento.",
  ],
  sections: [
    {
      heading: "Links armazenados vs. tempo real: quando usar cada um",
      body: [
        "O modo em tempo real do Relayium transmite um arquivo ao vivo entre duas abas abertas: na mesma LAN, o WebRTC conecta diretamente; entre redes, as sessões do navegador usam TURN por design para transportar texto cifrado de ponta a ponta que o retransmissor não consegue ler nem descriptografar. O Relayium não mantém cópia no servidor nem histórico em tempo real, mas as duas pessoas precisam estar online ao mesmo tempo. Um link armazenado e com validade inverte esse compromisso: o seu navegador faz a criptografia e envia o resultado uma única vez, e o destinatário pode abrir o link minutos, horas ou dias depois, no próprio tempo.",
        "Use um link armazenado quando não souber exatamente quando a outra pessoa estará livre, quando estiver enviando o mesmo arquivo para mais de uma pessoa, ou quando simplesmente quiser algo que você possa colar em um e-mail ou chat e pronto.",
      ],
    },
    {
      heading: "Como criar um link",
      body: ["Criar um link leva alguns passos, todos no navegador:"],
      prereqs: {
        label: "O que você precisa",
        items: [
          "Uma conta conectada só no lado que envia — quem recebe não precisa de nenhuma e não vê nenhum pedido de login.",
          "Arquivos que caibam sob dois tetos distintos: o limite por arquivo impresso ao lado do seletor, e a cota de armazenamento do seu plano. Os dois se leem na página em vez de serem adivinhados.",
          "Um prazo de retenção que o seu plano permita. A lista só oferece os prazos que o seu plano aceita, e o servidor aplica esse mesmo teto de forma defensiva ao que recebe.",
          "A sua própria cópia de tudo o que importa. A página diz isso abaixo das opções: entrega temporária, não backup.",
        ],
      },
      steps: [
        {
          text: "Abra a página de transferência assíncrona e faça login. Só o remetente precisa de uma conta; o destinatário nunca.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Escolha um ou mais arquivos, ou arraste-os. O número ao lado do seletor é o teto por arquivo vigente para a sua conta.",
          code: ["Escolher arquivos para enviar\nMáx. 512 MiB"],
        },
        {
          text: "Defina “Expira em”, ou ligue “Autodestruição após a leitura (excluir no primeiro download)”. O aviso abaixo, entrega temporária e não backup, é a página dizendo para você guardar a sua cópia.",
          code: ["Expira em\n1 dia"],
        },
        {
          text: "Aguarde enquanto o navegador criptografa e depois envia; as duas fases aparecem enquanto acontecem. Deixe a página aberta até terminar, e depois o link não depende mais dela.",
        },
        {
          text: "Copie o link, ou peça para quem recebe escanear o QR ao lado, e envie da forma que preferir. A cadeia inteira importa: tudo depois de #k= é a chave de descriptografia e nunca chega ao servidor.",
          code: ["Link pronto — envie-o ao destinatário para ele baixar:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
      ],
      success: {
        label: "Como é um link criado",
        body: [
          "A página troca o seletor pelo link, pela data em que ele expira e por um botão de copiar — além de um QR do mesmo link e, abaixo, o gerador do comando para buscá-lo de um terminal.",
          "Abrir o link você mesmo é a confirmação honesta: a página de download mostra o título do link criptografado, a quantidade de arquivos com o tamanho total e uma contagem do tempo restante. O que ela não mostra é qualquer caminho para nós lermos o arquivo, porque a chave ficou no fragmento que você copiou.",
        ],
        code: ["Link pronto — envie-o ao destinatário para ele baixar:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…\nEste link expira em quinta-feira, 6 de agosto de 2026 às 21:40"],
      },
    },
    {
      heading: "Validade e autodestruição após a leitura",
      body: [
        "Todo link precisa de um tempo de vida — deixar um ativo para sempre não é o objetivo de uma transferência pontual. Ao criar um link você escolhe por quanto tempo ele deve permanecer válido, ou pode configurá-lo para desaparecer assim que for usado uma vez.",
        "A autodestruição após a leitura significa um download e nada mais — útil quando o arquivo é sensível e você quer exatamente uma pessoa, uma vez, sem deixar nada solto depois. Vale ser preciso sobre quando essa vaga única é gasta: ela vai no momento em que texto cifrado de verdade começa a sair, não quando o download termina. Um download interrompido no meio já a consumiu, e o link está morto mesmo com o destinatário tendo só parte do arquivo. Só uma tentativa que não entregou absolutamente nada — zero bytes — devolve a vaga, então conectar e cair em seguida não custa nada. Essa assimetria é proposital: devolver uma leitura quase completa é exatamente como quem tem o link puxaria um arquivo de uso único vez após vez. De qualquer forma, o destinatário vê uma contagem regressiva ao vivo na página de download, então sabe quanto tempo (ou quantos downloads) resta — e se a conexão dele for instável, deixe a autodestruição desligada e escolha uma validade curta.",
      ],
      bullets: [
        "1 hora",
        "1 dia (o padrão)",
        "3 dias",
        "7 dias",
        "14 dias (o máximo, no plano superior)",
        "Ou: autodestruição no primeiro download que entregar bytes, em vez de um tempo fixo",
      ],
    },
    {
      heading: "A garantia de conhecimento zero, e seus limites",
      body: [
        "Veja o que realmente acontece quando você cria um link. O seu navegador gera uma chave AES-256-GCM aleatória — um mecanismo diferente do modo em tempo real do Relayium, que negocia uma chave entre dois dispositivos com X25519; a chave de um link armazenado é gerada localmente, sem nada a negociar. Essa chave criptografa seus arquivos e a lista de nomes de arquivo antes de qualquer coisa sair do seu dispositivo, e é anexada ao link de download depois de um `#` — uma parte da URL que os navegadores nunca enviam a nenhum servidor. O servidor armazena o texto cifrado que recebe, e apenas o texto cifrado; ele não tem como descriptografá-lo, porque nunca recebe a chave.",
        "Esse design tem compromissos reais que vale a pena conhecer. A chave nunca chega ao servidor, então não existe redefinição de senha que possamos oferecer. Só que o link também não é bem a única cópia dela: o navegador de onde você enviou a guarda localmente, e “Meus arquivos” na página de conta consegue remontar e copiar o link nesse mesmo navegador. O que deixa um arquivo irrecuperável é perder as duas coisas — o link completo e essa cópia local, que é o que significa abrir a página de conta em outro dispositivo ou limpar os dados de site deste navegador. Daí em diante, o texto cifrado armazenado fica permanentemente ilegível, para você e para nós. Criar um link exige que o remetente esteja com login feito, e cada link conta contra a cota de armazenamento da sua conta até ser apagado ou expirar. E vale ser preciso sobre o que “conhecimento zero” significa aqui: o texto cifrado é de fato armazenado no servidor do Relayium entre a criação e o download — só que é ilegível sem a chave que nunca saiu do seu navegador.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "Quem recebe abre o link e a página diz que a chave de descriptografia está faltando.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # a chave é tudo depois de #k="],
            fix: "O fragmento se perdeu no caminho: uma prévia de chat, um encurtador de link, ou uma cópia que parou no #. Envie o link de novo como texto puro e peça para a pessoa colar na barra de endereços, porque o id sozinho não pode ser descriptografado por ninguém, inclusive por nós.",
          },
          {
            symptom: "A descriptografia falha mesmo com o link inteiro tendo chegado.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # a um id corresponde exatamente uma chave"],
            fix: "O id e a chave vieram de links diferentes, o que acontece quando dois uploads são copiados na mesma sessão. Copie o link mais recente em uma peça só, da página que o criou, ou abra “Meus arquivos” na página de conta nesse mesmo navegador e copie o link da entrada certa: o fragmento #k= e a cópia local desse navegador são os dois únicos lugares onde a chave existe, porque ela nunca chegou ao servidor.",
          },
          {
            symptom: "O link se declara inválido, expirado, ou já baixado e excluído.",
            code: ["https://relayium.com/offline-transfer   # crie um link novo com a autodestruição desligada"],
            fix: "Os três são o mesmo estado: não há mais nada para buscar. Com “Autodestruição após a leitura” ligada, o primeiro download que realmente entrega texto cifrado gasta a vaga única — tendo terminado ou quebrado no meio —, então envie de novo e deixe isso desligado quando mais de uma pessoa, ou uma segunda tentativa, precisar dele.",
          },
          {
            symptom: "A página de download informa pedidos demais, ou que a transferência mensal de quem enviou acabou.",
            code: ["https://relayium.com/me   # o uso deste mês cobre transferência e armazenamento"],
            fix: "O arquivo está intacto e isto é medição. Um limite de taxa se solta em alguns minutos, enquanto uma transferência mensal esgotada espera a virada do mês, uma troca de plano ou o seu próprio nó. Reabrir o link depois funciona, porque nada foi consumido.",
          },
          {
            symptom: "Você precisa do arquivo e não tem mais o link.",
            code: ["https://relayium.com/me   # “Meus arquivos” remonta o link no navegador que o enviou"],
            fix: "Tente primeiro o único caminho de recuperação que existe: o navegador de onde você enviou guardou a chave localmente, então abra a página de conta nesse mesmo navegador, ache a entrada em “Meus arquivos” e use o botão de copiar link dela. Em qualquer outro dispositivo, ou depois de limpar os dados de site desse navegador, a chave some e o texto cifrado armazenado é ilegível para todos, inclusive para nós — aí envie o arquivo de novo a partir da sua própria cópia, que é justamente o que a página pede para você guardar.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "A pessoa para quem envio o link precisa de uma conta?",
        a: "Não. Qualquer pessoa com o link completo — incluindo a parte depois do `#` — pode abri-lo e baixar os arquivos. Só o remetente precisa fazer login para criar o link em primeiro lugar.",
      },
      {
        q: "O Relayium consegue ler meu arquivo?",
        a: "Não. O seu navegador criptografa os arquivos com uma chave AES-256-GCM aleatória antes de qualquer coisa ser enviada, e essa chave viaja apenas no fragmento da URL, que nunca chega ao servidor. O navegador de onde você enviou também guarda uma cópia local dela para que “Meus arquivos” consiga remontar o link mais tarde. O servidor armazena texto cifrado que não tem como descriptografar — um design de conhecimento zero.",
      },
      {
        q: "Quanto tempo os links duram?",
        a: "Você escolhe ao criar o link: 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou pode configurá-lo para se autodestruir no primeiro download em vez de uma validade fixa. A vaga é gasta assim que bytes começam a sair, então um download interrompido conta igual. Depois desse ponto, o link para de funcionar.",
      },
      {
        q: "O arquivo realmente some depois da autodestruição após a leitura?",
        a: "A autodestruição após a leitura é projetada para exatamente um download, e a vaga é gasta assim que esse download começa a entregar texto cifrado de verdade: o link para de funcionar para qualquer um que o abra depois, mesmo que esse único download tenha sido interrompido e nunca tenha terminado. Só uma tentativa que não transferiu nada é devolvida.",
      },
    ],
  },
  cta: {
    text: "Tem um arquivo pronto mas ninguém esperando do outro lado? Crie um link com validade no seu navegador e envie quando estiver pronto.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/share-a-file-with-an-expiring-link",
  published: "2026-07-09",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
