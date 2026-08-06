// web/scripts/pages/content/articles/howto-large-files-without-cloud.mjs
// How-to: send large files (multi-GB video / project archives) without the cloud.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "How to send large files without the cloud",
  description:
    "For large videos and project archives, create an end-to-end encrypted download link so the recipient can fetch later; realtime remains a live alternative when both sides can stay online.",
  updatedLabel: "Last updated",
  lead: [
    "A 20 GB video export or a heavy project archive is exactly where cloud storage feels slowest: you upload the whole file once, wait, then the other person downloads it again — two full transfers plus whatever your storage quota allows. For a one-time hand-off, that is a lot of copying and waiting for bytes that only ever needed to go from A to B.",
    "For a large file, Relayium's recommended path is an end-to-end encrypted stored download link: the recipient need not be online while you upload and can fetch it later. Keep the sender page open until upload completes; after that the link remains available until expiry. If both people can stay online, realtime is the live alternative: LAN WebRTC is direct, while cross-network browser sessions carry end-to-end ciphertext over TURN. Relayium stores no realtime content or history.",
  ],
  sections: [
    {
      heading: "Why a stored link is the default for big files",
      prereqs: {
        label: "Before you start",
        items: [
          "A signed-in account on the sending side. Creating a stored download link needs one; the person who opens the link never signs in.",
          "Headroom for the file in two separate limits: the per-file ceiling the upload page prints next to the picker, and your plan's storage allowance. Both are read off the page rather than guessed.",
          "A retention window you can live with. The expiry list only offers what your plan allows, and the server enforces that same cap on its own side, so a window you can pick is a window you get — and none of these links is a backup.",
          "The sender page kept open until the upload finishes. After that the link stands on its own until it expires, so the sending laptop can close; the recipient still has to let their own download run to the end.",
        ],
      },
      body: [
        "A Relayium download link stores only browser-encrypted ciphertext. The recipient can be offline during upload and fetch later; once upload completes, closing the sender page does not remove the link. The trade-offs are the displayed per-file limit, account quota and expiry.",
        "Realtime is the alternative when both sides are ready now. On the same LAN, WebRTC connects directly with no account; across networks, browsers use TURN to carry end-to-end encrypted ciphertext and the code creator signs in. Both pages must remain active, so this path is better suited to quick small-file and text handoff than long large-file delivery.",
      ],
    },
    {
      heading: "No size cap in realtime mode",
      body: [
        "Realtime transfers have no server-side storage-size limit because Relayium does not retain a content copy. A TURN relay may carry cross-network ciphertext while both sides are online, but it cannot read, decrypt, or retain it as transfer history. The practical ceiling is set by the receiving browser, not by us.",
        "On Chrome and Edge an incoming realtime file can stream straight to disk, so the protocol can technically carry tens of gigabytes. That capability is not the default recommendation for large files: the live session still needs both pages active. A batch can hold up to 1,000 files, and each one is verified end-to-end with a SHA-256 hash.",
      ],
      bullets: [
        "Chrome or Edge on the receiving desktop: files stream straight to disk, so there is effectively no size cap.",
        "Firefox and Safari have no File System Access API, so a realtime batch is held in memory there — Relayium warns above roughly 256 MB, a deliberately cautious estimate rather than a hard limit.",
        "Up to 1,000 files per batch, each checked with its own SHA-256 hash on arrival.",
      ],
    },
    {
      heading: "Resume instead of restarting",
      body: [
        "A temporary transport drop can resume from a durable checkpoint while both live pages remain active. Closing or reloading either page, or ending the app session, is different: it ends the live transfer and requires a new handoff. This is another reason to prefer a stored link for large files.",
        "Connectivity is handled the same way. On one network the transfer goes directly device-to-device; across networks the encrypted stream travels over a TURN relay. The relay only ever sees ciphertext, so that path stays end-to-end encrypted too.",
      ],
    },
    {
      heading: "Send now, or leave a link for later",
      body: [
        "Realtime transfer needs both people online at the same time, which is ideal when you can coordinate — a call, a shared moment, a colleague at their desk. If the other person is not available right now, you can create a stored download link instead.",
        "A stored link is zero-knowledge: your browser encrypts the files with AES-256-GCM before upload and the decryption key lives only in the URL fragment, so the server keeps ciphertext it cannot read. Be aware of the trade-offs — creating a link requires the sender to sign in, links count against a storage quota, and they expire (or can be single-use, spending their one slot as soon as a download starts receiving ciphertext). Its download page can stream a single file to disk through a service worker even in Firefox and Safari. For the biggest files, reach for the stored link first: the recipient need not be online during upload; keep the sender page open until upload completes, after which that page can close and the recipient can fetch any time before expiry — their own download still has to run to the end. Keep the live path for when you are both at your desks and want the bytes to land now.",
      ],
      steps: [
        {
          text: "Open the async transfer page and sign in.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Choose the files, or drag them in. The figure next to the picker is the live per-file ceiling for your account — check the big one against it before you start rather than after the upload fails.",
          code: ["Choose files to upload\nMax 512 MiB"],
        },
        {
          text: "Set “Expires in”, and turn on “Burn after reading (delete on first download)” if the file should not outlive its first fetch — the one slot is spent as soon as a download starts receiving ciphertext, so even an attempt that never finishes can use it up. The list is already filtered to what your plan allows, so a window you cannot see is a plan limit rather than a bug.",
          code: ["Expires in\n1 day"],
        },
        {
          text: "Leave the page open while it encrypts and uploads. When it finishes, the link appears with its expiry date under it.",
          code: ["Link ready — send it to the recipient to download:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "Send the whole link. Everything after #k= is the decryption key, it never reaches the server, and a link that arrives without that fragment cannot be decrypted by anyone — including us.",
        },
      ],
      success: {
        label: "What a finished upload looks like",
        body: [
          "Your page shows the link, the expiry date it will keep, and the reminder that this is temporary delivery and not a backup. From that moment the upload no longer depends on your page staying open.",
          "On the recipient's side the link opens the encrypted download page with the file count and total size, and “Download & decrypt” ends at “Download complete ✓”. Where the file lands is their browser's decision, so their downloads list is the place to confirm it.",
        ],
        code: ["Encrypted download link\nDownload complete ✓"],
      },
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The upload is refused with a message that the file exceeds the single-file size limit.",
            code: ["https://relayium.com/offline-transfer   # the picker prints the ceiling as Max <size>"],
            fix: "That ceiling is per file, not per batch, so splitting a 40 GB export into parts that each fit is the way through — or send it in realtime instead while you are both online, which has no server-side size limit because nothing is stored.",
          },
          {
            symptom: "The upload is refused for today's quota rather than for the file's size.",
            code: ["https://relayium.com/offline-transfer   # the upload flow is what reports a daily-quota refusal"],
            fix: "The daily upload quota is separate from the per-file ceiling and from storage, and the upload flow is what reports it — https://relayium.com/me shows monthly account usage, not a live remaining daily counter. Wait for the rolling daily window to recover as earlier uploads age out of it, upgrade the plan if that is available to you, or hand the file over in realtime while both sides are online — a realtime transfer stores nothing and so spends no upload quota.",
          },
          {
            symptom: "The expiry list does not offer the 7 or 14 days you expected.",
            code: ["https://relayium.com/pricing   # retention is a per-plan figure"],
            fix: "The list only shows windows your plan's retention cap allows, and the server enforces the same cap defensively on its own side, so nothing you can actually pick gets shortened behind your back. Pick the longest one offered, or change plan — the cap is what decides it, not the file.",
          },
          {
            symptom: "The recipient says the link is invalid, expired, or already downloaded and deleted.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # one link, one id, one key"],
            fix: "All three end in the same place: there is nothing left to fetch. If “Burn after reading” was on, the single slot is spent as soon as a download starts receiving ciphertext — an attempt that broke off partway consumes it too, while one that delivered no bytes at all releases it. Upload again and send a new link, and leave burn off when more than one person needs the file.",
          },
          {
            symptom: "The download page says there are too many requests, or that the sender's monthly transfer allowance is used up.",
            code: ["https://relayium.com/me   # this month's usage covers transfer, not just storage"],
            fix: "The file is still there — this is metering rather than loss. Waiting a few minutes clears a rate limit; an exhausted monthly transfer allowance needs the month to roll over, an upgrade, or your own node, and in the meantime a realtime transfer bypasses it entirely.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "What is the largest file I can send?",
        a: "For large files, use a stored download link; its per-file limit and quota are shown before upload. Realtime has no server-side limit, and desktop Chrome or Edge can stream to disk, but both pages must stay active. Firefox and Safari assemble a realtime receive in memory and Relayium warns above roughly 256 MB — a conservative estimate, not a hard limit.",
      },
      {
        q: "What happens if the transfer is interrupted?",
        a: "A temporary connection drop can resume from a durable checkpoint while both pages remain active. Closing or reloading a page, or ending the app session, ends the live transfer. A stored link avoids requiring the recipient to remain online, but the sender must keep its page open until upload completes.",
      },
      {
        q: "How is my privacy protected for large files?",
        a: "Realtime transfers are end-to-end encrypted with an X25519 key exchange and per-chunk AES-256-GCM, and that key never reaches any server. With advanced verification on (off by default), both devices show a 6-digit verification code; each file is checked with a SHA-256 hash. LAN WebRTC is direct; cross-network browser sessions use TURN by design, and the relay carries only ciphertext it cannot read or decrypt.",
      },
    ],
  },
  cta: {
    text: "Move your next multi-gigabyte file without the cloud — leave an encrypted download link, or connect both devices and send it now. No install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何不用网盘传输大文件",
  description:
    "大视频和工程文件建议生成端到端加密下载链接，让接收方稍后再取；只有双方都能保持在线时，才把实时传输作为即时替代方案。",
  updatedLabel: "最近更新",
  lead: [
    "一个 20 GB 的视频导出，或者一个体积庞大的工程压缩包，恰恰是网盘最慢的场景：你先把整个文件上传一遍、等待，然后对方再下载一遍——两次完整传输，还要受制于你的存储配额。对一次性的交付来说，只是想把字节从 A 送到 B，却要这样反复复制和等待。",
    "大文件推荐使用 Relayium 的端到端加密下载链接：上传时接收方无需在线，之后可随时来取。发送方须保持页面打开直到上传完成；完成后链接会保留到过期。若双方都能保持在线，实时传输可用于即时交付：局域网 WebRTC 直连，跨网络浏览器经 TURN 承载端到端密文。实时模式不保留服务器端内容副本或历史。",
  ],
  sections: [
    {
      heading: "为什么大文件默认应使用下载链接",
      prereqs: {
        label: "开始之前",
        items: [
          "发送这一侧要有已登录的账号。创建下载链接需要账号；打开链接的那个人全程不用登录。",
          "文件要在两条独立的限制里都还有余量：上传页面选择器旁边印着的单文件上限，以及你套餐的存储额度。这两个数字都从页面上读，不要凭猜。",
          "一个你能接受的留存时长。有效期列表只会提供你套餐允许的档位，服务端也会按同一上限做一次防御性限制，所以你能选到的档位就是你实际拿到的档位；而且这些链接都不是备份。",
          "上传完成之前，发送方的页面要一直开着。之后链接就能独立存在，直到过期为止，发送方这边可以合上电脑；但接收方仍要让自己的下载完整跑完。",
        ],
      },
      body: [
        "Relayium 下载链接只存浏览器加密后的密文。上传时接收方可以离线，之后再取；上传完成后，发送方关掉页面也不会移除链接。取舍是页面所示的单文件上限、账号额度与有效期。",
        "实时传输适合双方此刻都已就绪的场景。同一局域网内 WebRTC 免账号直连；跨网络浏览器经 TURN 承载端到端密文，配对码创建者登录。双方页面必须保持在线，因此它更适合快速递送小文件和文本，而不是耗时的大文件交付。",
      ],
    },
    {
      heading: "实时模式没有大小上限",
      body: [
        "实时传输没有服务器端存储大小限制，因为 Relayium 不保留内容副本。跨网络时 TURN 中继会在双方在线期间承载密文，但无法读取、解密或把它留作传输历史。实际的上限由接收端浏览器决定。",
        "在 Chrome 和 Edge 上，实时接收可随到随写磁盘，因此协议在技术上能承载几十 GB。不过实时会话仍要求双方页面保持在线；大文件默认走上面的下载链接。每批最多可放 1,000 个文件，每个都用 SHA-256 做端到端校验。",
      ],
      bullets: [
        "接收端用桌面版 Chrome 或 Edge：文件直接流式写盘，因此实际上没有大小上限。",
        "Firefox 和 Safari 没有 File System Access API，实时接收的一批文件只能放在内存里——超过约 256 MB 时 Relayium 会提示你，这是刻意取的保守估计，而不是硬性上限。",
        "每批最多 1,000 个文件，每个到达时都用各自的 SHA-256 校验。",
      ],
    },
    {
      heading: "断点续传，而非重来",
      body: [
        "双方实时页面仍在运行时，短暂的传输连接中断可从持久断点续传；但关闭或刷新任一页面、结束 App 会话会结束实时传输，需要重新发起。这也是大文件优先使用下载链接的原因。",
        "网络连通问题也是同样的处理思路。同一网络内传输在设备之间直连；跨网络时加密数据流经 TURN 中继转发。中继只能看到密文，因此这条路径同样保持端到端加密。",
      ],
    },
    {
      heading: "现在就传，或留个链接稍后取",
      body: [
        "实时传输需要双方同时在线，这在能协调的时候最理想——一通电话、一个共处的时刻、一位就在工位上的同事。如果对方此刻不在，你可以改为创建一个存储下载链接。",
        "存储链接是零知识的：浏览器在上传前用 AES-256-GCM 加密文件，解密密钥只存在于 URL 片段里，服务器只保存它读不懂的密文。也要清楚其中的取舍——生成链接需要发送方登录，链接会占用存储配额，并且会过期（也可以设置为一次性使用：只要有下载开始接收密文，那唯一的名额就会被消耗）。下载页即使在 Firefox 和 Safari 上也能借助 Service Worker 把单个文件流式写入磁盘。文件越大越应该先考虑存储链接：上传时接收方无需在线；发送方保持页面打开直至上传完成，之后发送方的页面就可以关闭，接收方在过期之前随时可以来取——但对方自己的下载仍要完整跑完。双方都在电脑前、希望文件立刻到位时，再走实时那条路。",
      ],
      steps: [
        {
          text: "打开异步传输页面并登录。",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "选好文件，或者直接拖进去。选择器旁边那个数字就是你账号当下的单文件上限——请在开始之前拿大文件去对一下，而不是等上传失败之后。",
          code: ["选择文件上传\n最大 512 MiB"],
        },
        {
          text: "设置「有效期」，如果这个文件不该在第一次被取走之后还留着，就打开「阅后即焚（首次下载后删除）」——只要有下载开始接收密文，那唯一的名额就会被消耗，所以一次没能完成的尝试同样可能把它用掉。列表已经按你套餐允许的范围过滤过了，所以看不到的档位是套餐限制，不是缺陷。",
          code: ["有效期\n1 天"],
        },
        {
          text: "加密和上传过程中让页面保持打开。完成后链接就会出现，下面附着它的到期日期。",
          code: ["链接已生成，发给对方即可下载：\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "把整条链接发出去。#k= 之后的部分是解密密钥，它从不上传到服务器；一条丢掉了这个片段的链接，谁都解不开——包括我们。",
        },
      ],
      success: {
        label: "上传完成时是什么样",
        body: [
          "你的页面上会显示链接、它将保持到的到期日期，以及那句提醒：这是临时投递，不是备份。从这一刻起，上传结果就不再依赖你的页面是否开着。",
          "在接收方那边，链接会打开加密下载页面，上面写着文件数量和总大小，点「下载并解密」最终会走到「下载完成 ✓」。文件落在哪里由对方的浏览器决定，所以要确认的话得看对方的下载列表。",
        ],
        code: ["加密下载链接\n下载完成 ✓"],
      },
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "上传被拒，提示文件超出单文件大小上限。",
            code: ["https://relayium.com/offline-transfer   # 选择器上会印出「最大 <大小>」"],
            fix: "这个上限是按单个文件算的，不是按整批算的，所以把一个 40 GB 的导出文件切成每块都装得下的分卷才是出路——或者趁双方都在线时改用实时传输，那边没有服务器端大小限制，因为什么都不会被存下来。",
          },
          {
            symptom: "上传被拒的原因是今天的配额，而不是文件大小。",
            code: ["https://relayium.com/offline-transfer   # 每日配额被拒是由上传流程报出来的"],
            fix: "每日上传配额和单文件上限、存储额度是三件不同的事，而且只有上传流程会报出它——https://relayium.com/me 显示的是账号的每月用量，不是每日配额的实时余量。等滚动的每日窗口把较早的上传移出后自行恢复、在可以升级时升级套餐，或者趁双方都在线时用实时传输把文件递过去——实时传输什么都不存，所以不花上传配额。",
          },
          {
            symptom: "有效期列表里没有你以为会有的 7 天或 14 天。",
            code: ["https://relayium.com/pricing   # 留存时长是按套餐给的"],
            fix: "列表只显示你套餐留存上限允许的档位，服务端也会在自己这一侧按同一上限做防御性限制，所以你真正能选到的档位不会被悄悄改短。请选它提供的最长那一档，或者换套餐——决定这件事的是上限，而不是文件。",
          },
          {
            symptom: "对方说链接无效、已过期，或者已经被下载并删除了。",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # 一条链接、一个 id、一把密钥"],
            fix: "这三种说法的落点是同一个：已经没有东西可取了。如果当时打开了「阅后即焚」，那么只要有一次下载开始接收密文，那唯一的名额就已被消耗——中途断掉、但已经取走了部分字节的尝试同样会消耗它，而一个字节都没送出的尝试则会把名额释放回去。请重新上传并发一条新链接；当文件需要给多个人时，不要开启即焚。",
          },
          {
            symptom: "下载页面提示当前请求太多，或者发送方本月的流量额度已经用完。",
            code: ["https://relayium.com/me   # 「本月用量」既包含存储也包含流量"],
            fix: "文件还在——这是计量问题，不是丢失。等几分钟就能解除限流；而月流量额度用尽则要等到下个月、升级套餐，或者用自己的节点，在此期间实时传输可以完全绕开它。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "最大能传多大的文件？",
        a: "大文件请使用下载链接，页面会在上传前显示单文件上限与额度。实时模式没有服务器端上限，桌面版 Chrome 或 Edge 也能流式写盘，但双方页面必须保持在线。Firefox 和 Safari 会把实时接收内容放在内存中，超过约 256 MB 时 Relayium 会提示——这是保守估计而非硬上限。",
      },
      {
        q: "传输中断了怎么办？",
        a: "双方页面保持运行时，短暂连接中断可从持久断点续传；关闭或刷新页面、结束 App 会话会结束实时传输。下载链接不要求接收方保持在线，但发送方仍须保持页面打开直到上传完成。",
      },
      {
        q: "传大文件时隐私如何保证？",
        a: "实时传输用 X25519 密钥交换加逐块 AES-256-GCM 做端到端加密，密钥从不抵达任何服务器。打开高级验证（默认关闭）后两台设备会显示 6 位校验码；每个文件都用 SHA-256 校验。局域网 WebRTC 直连；跨网络浏览器按设计使用 TURN，中继只承载它无法读取或解密的密文。",
      },
    ],
  },
  cta: {
    text: "不用网盘也能搬走下一个几 GB 的大文件——留一条加密下载链接，或者让两台设备连上后立刻发送。无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "クラウドを使わずに大きなファイルを送る方法",
  description:
    "大きな動画やプロジェクトアーカイブにはエンドツーエンド暗号化ダウンロードリンクを作り、相手が後で取得できるようにします。双方がオンラインを保てる場合はリアルタイムも選べます。",
  updatedLabel: "最終更新",
  lead: [
    "20 GB の動画書き出しや重いプロジェクトのアーカイブは、まさにクラウドストレージが最も遅く感じる場面です。ファイル全体を一度アップロードして待ち、相手がもう一度ダウンロードします。2回の完全な転送に加え、ストレージ容量の制限も受けます。一度きりの受け渡しなのに、A から B へ送るだけのバイトのために、これだけの複製と待ち時間がかかります。",
    "大きなファイルでは、Relayium はエンドツーエンド暗号化された保存型ダウンロードリンクを推奨します。アップロード中に受信者がオンラインである必要はなく、後で取得できます。送信側はアップロード完了までページを開き、その後リンクは期限まで残ります。双方がオンラインを保てる場合、リアルタイムはライブの選択肢です。同じ LAN では WebRTC が直接接続し、ネットワーク間では TURN が暗号文を運びます。リアルタイム内容やサーバー側のコピーは残しません。",
  ],
  sections: [
    {
      heading: "大きなファイルで保存リンクを既定にする理由",
      prereqs: {
        label: "始める前に",
        items: [
          "送信側にサインイン済みのアカウント。保存ダウンロードリンクの作成には必要ですが、リンクを開く人は最後までサインインしません。",
          "2つの別々の上限に対する余裕。アップロードページが選択ボタンの隣に表示する1ファイルあたりの上限と、プランの保存容量です。どちらも推測ではなくページから読み取ります。",
          "受け入れられる保持期間。有効期限の一覧はプランが許す範囲だけを示し、サーバーも同じ上限を自分の側で防御的に適用します。つまり選べる期間はそのまま適用されます。そしてこれらのリンクはいずれもバックアップではありません。",
          "アップロードが終わるまで開いたままの送信側ページ。終わったあとはリンクが独立して期限まで残るので、送信側はノートPCを閉じて構いません。受信側は自分のダウンロードを最後まで走らせる必要があります。",
        ],
      },
      body: [
        "Relayium のダウンロードリンクが保存するのはブラウザで暗号化された暗号文だけです。アップロード中に受信者はオフラインでもよく、後で取得できます。完了後に送信側がページを閉じても、リンクは期限まで残ります。制約は画面に表示される1ファイル上限、容量枠、有効期限です。",
        "リアルタイムは双方が今すぐ準備できる場合の選択肢です。同じ LAN ではアカウントなしで WebRTC が直接接続し、ネットワーク間では TURN がエンドツーエンド暗号文を運び、コード作成側がサインインします。双方のページを開いたままにする必要があるため、時間のかかる大容量転送より、小さなファイルやテキストの素早い受け渡しに向きます。",
      ],
    },
    {
      heading: "リアルタイムモードにはサイズ上限がない",
      body: [
        "Relayium は内容のコピーを保持しないため、リアルタイム転送にサーバー側ストレージのサイズ制限はありません。ネットワークをまたぐ際は TURN が両者のオンライン中に暗号文を運びますが、読み取りも復号もできず、転送履歴として保持しません。実際の上限は受信側ブラウザが決めます。",
        "Chrome と Edge ではリアルタイム受信をディスクへ直接流せるため、技術的には数十 GB も扱えます。ただし大きなファイルの既定として推奨する意味ではありません。ライブセッションでは双方のページを開いたままにする必要があります。1バッチ最大1,000ファイルで、それぞれ SHA-256 で検証されます。",
      ],
      bullets: [
        "受信側がパソコン版の Chrome または Edge：ファイルはそのままディスクへストリーミングされるため、実質的にサイズ上限はありません。",
        "Firefox と Safari には File System Access API がないため、リアルタイム受信の1バッチはメモリに保持されます。およそ 256 MB を超えると Relayium が警告します。これは硬い上限ではなく、意図的に控えめに置いた目安です。",
        "1バッチ最大1,000ファイル、それぞれ到着時に固有の SHA-256 ハッシュで検証されます。",
      ],
    },
    {
      heading: "最初からではなく再開する",
      body: [
        "双方のライブページが動作中なら、一時的な通信切断は保存済みのチェックポイントから再開できます。一方、どちらかのページを閉じる／再読み込みする、または App セッションを終了するとライブ転送は終了し、新たな受け渡しが必要です。これも大きなファイルで保存リンクを優先する理由です。",
        "接続性も同じように扱われます。同一ネットワーク内では転送はデバイス間で直接行われ、ネットワークをまたぐ場合は暗号化ストリームが TURN リレーを経由します。リレーが見るのは暗号文だけなので、この経路でもエンドツーエンド暗号化のままです。",
      ],
    },
    {
      heading: "今すぐ送る、または後で取れるリンクを残す",
      body: [
        "リアルタイム転送は双方が同時にオンラインであることが必要で、都合を合わせられるときに最適です。相手が今いない場合は、代わりに保存型のダウンロードリンクを作成できます。",
        "保存リンクはゼロ知識です。ブラウザがアップロード前に AES-256-GCM で暗号化し、復号鍵は URL フラグメントにだけ存在します。作成には送信側のサインインが必要で、容量枠を使い、有効期限があります（1回限りにもできます。その場合、ダウンロードが暗号文を受け取り始めた時点で1回分の枠が消費されます）。ダウンロードページは Firefox や Safari でも Service Worker で単一ファイルをディスクへ流せます。大きなファイルほど保存リンクを先に選びます。アップロード中に受信者はオンライン不要ですが、送信側は完了までページを開きます。その後は送信側のページを閉じてよく、受信者は期限までいつでも取得できます。ただし受信側のダウンロード自体は最後まで走らせる必要があります。ライブ経路は双方が机の前にいて、今すぐ届けたいときの手段です。",
      ],
      steps: [
        {
          text: "非同期転送のページを開き、サインインします。",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "ファイルを選ぶか、ドラッグして入れます。選択ボタンの隣の数値が、そのアカウントの現在の1ファイル上限です。アップロードが失敗してからではなく、始める前に大きいファイルと見比べてください。",
          code: ["アップロードするファイルを選択\n最大 512 MiB"],
        },
        {
          text: "「有効期限」を設定し、そのファイルが最初の取得より長く残るべきでないなら「閲覧後削除（初回ダウンロード完了後に削除）」をオンにします。1回分の枠はダウンロードが暗号文を受け取り始めた時点で消費されるため、途中で終わった試行でも使い切られることがあります。一覧はプランが許す範囲に絞られているので、見えない期間は不具合ではなくプランの制限です。",
          code: ["有効期限\n1 日"],
        },
        {
          text: "暗号化とアップロードの間はページを開いたままにします。終わるとリンクが現れ、その下に期限の日付が付きます。",
          code: ["リンクを作成しました。相手に送ってダウンロードしてもらえます：\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "リンク全体を送ってください。#k= より後ろは復号鍵で、サーバーには決して届きません。そのフラグメントを失ったリンクは、当社を含め誰にも復号できません。",
        },
      ],
      success: {
        label: "アップロードが終わったときの画面",
        body: [
          "ページにリンクと、そのリンクが保たれる期限の日付、そして「これは一時的な受け渡しでバックアップではない」という注意が表示されます。この時点からアップロードは、ページを開いたままかどうかに依存しません。",
          "受信者側では、リンクが暗号化ダウンロードページを開き、ファイル数と合計サイズが示され、「ダウンロードして復号」は「ダウンロード完了 ✓」で終わります。どこに置かれるかは相手のブラウザが決めるので、確認する場所は相手のダウンロード一覧です。",
        ],
        code: ["暗号化ダウンロードリンク\nダウンロード完了 ✓"],
      },
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "ファイルが1ファイルのサイズ上限を超えているという理由でアップロードが拒否される。",
            code: ["https://relayium.com/offline-transfer   # 選択ボタンが上限を「最大 <サイズ>」と表示する"],
            fix: "この上限はバッチ単位ではなく1ファイル単位なので、40 GB の書き出しをそれぞれ収まる分割ファイルにするのが道筋です。あるいは双方がオンラインのうちにリアルタイムで送ってください。何も保存しないため、サーバー側のサイズ制限がありません。",
          },
          {
            symptom: "拒否の理由がファイルサイズではなく、その日の割り当てだった。",
            code: ["https://relayium.com/offline-transfer   # 1日の枠による拒否はアップロードの流れが知らせる"],
            fix: "1日のアップロード枠は、1ファイル上限や保存容量とは別物で、知らせるのはアップロードの流れです。https://relayium.com/me が示すのはアカウントの月次使用量で、1日の枠の残量ではありません。古いアップロードが枠から外れて回復するのを待つ、可能ならプランを上げる、あるいは双方がオンラインのうちにリアルタイムで渡してください。リアルタイム転送は何も保存しないので、アップロード枠を消費しません。",
          },
          {
            symptom: "有効期限の一覧に、期待していた7日や14日がない。",
            code: ["https://relayium.com/pricing   # 保持期間はプランごとの数値"],
            fix: "一覧はプランの保持上限が許す期間だけを示し、サーバーも同じ上限を自分の側で防御的に適用します。そのため実際に選べる期間が黙って短くされることはありません。提示された中で最長のものを選ぶか、プランを変更してください。決めているのは上限で、ファイルではありません。",
          },
          {
            symptom: "相手がリンクは無効、期限切れ、あるいはすでにダウンロードされて削除済みだと言う。",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # リンク1つ、id 1つ、鍵1つ"],
            fix: "3つはどれも同じ結論に至ります。もう取得できるものが残っていません。「閲覧後削除」がオンだったなら、ダウンロードが暗号文を受け取り始めた時点で1回分の枠は消費されています。途中で切れた試行でも、いくらかのバイトが届いていれば消費され、1バイトも届かなかった試行だけが枠を返します。もう一度アップロードして新しいリンクを送ってください。複数人に渡す必要があるときは、削除をオフにしてください。",
          },
          {
            symptom: "ダウンロードページが、リクエストが多すぎる、または送信者の今月の転送量を使い切ったと表示する。",
            code: ["https://relayium.com/me   # 今月の使用量は保存だけでなく転送も含む"],
            fix: "ファイルはまだあります。これは喪失ではなく計量です。数分待てばレート制限は解けますが、月間の転送量を使い切った場合は月替わり、プランの変更、または自分のノードが必要です。その間はリアルタイム転送がこれを完全に回避します。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "送れるファイルの最大サイズは？",
        a: "大きなファイルには保存型ダウンロードリンクを使ってください。1ファイル上限と容量枠はアップロード前に表示されます。リアルタイムにはサーバー側上限がなく、パソコン版 Chrome／Edge はディスクへ流せますが、双方のページを開いたままにする必要があります。Firefox／Safari のリアルタイム受信はメモリに保持され、約256 MBを超えると保守的な警告を表示します。",
      },
      {
        q: "転送が中断されたらどうなりますか？",
        a: "双方のページが動作中なら、一時的な接続切れは保存済みチェックポイントから再開できます。ページを閉じる／再読み込みする、または App セッションを終了するとライブ転送は終了します。保存リンクでは受信者のオンラインは不要ですが、送信側はアップロード完了までページを開く必要があります。",
      },
      {
        q: "大きなファイルでプライバシーはどう守られますか？",
        a: "リアルタイム転送は X25519 の鍵交換とチャンクごとの AES-256-GCM でエンドツーエンドに暗号化され、鍵はどのサーバーにも届きません。高度な検証（既定はオフ）をオンにすると両端末が6桁の検証コードを表示します。各ファイルは SHA-256 で検証します。同じ LAN の WebRTC は直接接続し、ネットワークをまたぐブラウザは設計上 TURN を使用します。リレーは暗号文を運ぶだけで読み取りも復号もできません。",
      },
    ],
  },
  cta: {
    text: "次の数ギガバイトのファイルをクラウドなしで。暗号化したダウンロードリンクを残すか、両方の端末をつないでいま送るか。インストール不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "클라우드 없이 대용량 파일 보내는 방법",
  description:
    "대용량 동영상과 프로젝트 아카이브는 종단간 암호화 다운로드 링크로 만들어 나중에 받게 하세요. 양쪽이 계속 온라인일 수 있을 때만 실시간을 즉시 전송 대안으로 사용합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "20 GB짜리 동영상 내보내기나 무거운 프로젝트 아카이브야말로 클라우드 스토리지가 가장 느리게 느껴지는 순간입니다. 파일 전체를 한 번 업로드하고 기다린 뒤, 상대가 다시 다운로드합니다. 두 번의 완전한 전송에 스토리지 할당량 제한까지 받습니다. 한 번뿐인 전달인데, A에서 B로 보내기만 하면 되는 바이트를 위해 이렇게 복사하고 기다려야 합니다.",
    "대용량 파일에는 Relayium의 종단간 암호화 저장형 다운로드 링크를 권장합니다. 업로드 중 수신자는 온라인일 필요가 없고 나중에 받을 수 있습니다. 보내는 쪽은 업로드 완료까지 페이지를 열어 두며, 이후 링크는 만료까지 남습니다. 양쪽이 계속 온라인일 수 있다면 실시간이 라이브 대안입니다. 같은 LAN에서는 WebRTC가 직접 연결하고 네트워크 간에는 TURN이 종단간 암호문을 운반합니다. 실시간 내용이나 서버 측 복사본을 남기지 않습니다.",
  ],
  sections: [
    {
      heading: "대용량 파일은 저장 링크가 기본인 이유",
      prereqs: {
        label: "시작하기 전에",
        items: [
          "보내는 쪽에 로그인한 계정. 저장 다운로드 링크를 만들려면 필요하지만, 링크를 여는 사람은 끝까지 로그인하지 않습니다.",
          "서로 다른 두 상한에 대한 여유. 업로드 페이지가 선택기 옆에 찍어 주는 파일당 상한과, 요금제의 저장 용량입니다. 둘 다 짐작이 아니라 페이지에서 읽습니다.",
          "받아들일 수 있는 보관 기간. 유효 기간 목록은 요금제가 허용하는 범위만 보여주고, 서버도 같은 상한을 자기 쪽에서 방어적으로 적용합니다. 그래서 고를 수 있는 기간은 그대로 적용되며, 이 링크들은 어느 것도 백업이 아닙니다.",
          "업로드가 끝날 때까지 열어 두는 보내는 쪽 페이지. 그다음에는 링크가 스스로 만료까지 남으므로 보내는 쪽은 노트북을 덮어도 됩니다. 받는 쪽은 자기 다운로드를 끝까지 진행해야 합니다.",
        ],
      },
      body: [
        "Relayium 다운로드 링크에는 브라우저에서 암호화한 암호문만 저장됩니다. 업로드 중 수신자는 오프라인이어도 되고 나중에 받습니다. 완료 후 보내는 쪽이 페이지를 닫아도 링크는 만료까지 남습니다. 화면에 표시되는 파일당 한도, 계정 할당량, 만료가 절충점입니다.",
        "실시간은 양쪽이 지금 준비되어 있을 때의 대안입니다. 같은 LAN에서는 계정 없이 WebRTC가 직접 연결하고, 네트워크 간에는 TURN이 종단간 암호문을 운반하며 코드 생성자가 로그인합니다. 두 페이지가 계속 활성 상태여야 하므로 오래 걸리는 대용량 전달보다 작은 파일과 텍스트를 빠르게 건네는 데 적합합니다.",
      ],
    },
    {
      heading: "실시간 모드에는 크기 제한이 없다",
      body: [
        "Relayium이 내용 복사본을 보관하지 않으므로 실시간 전송에는 서버 측 저장 크기 제한이 없습니다. 네트워크를 넘을 때 TURN은 양쪽이 온라인인 동안 암호문을 운반하지만 읽거나 복호화할 수 없고 전송 기록으로 보관하지 않습니다. 실질적인 상한은 받는 쪽 브라우저가 정합니다.",
        "Chrome과 Edge는 실시간 수신을 디스크로 직접 스트리밍하므로 기술적으로 수십 GB도 처리할 수 있습니다. 하지만 이는 대용량 파일의 기본 권장 사항이 아닙니다. 라이브 세션에서는 두 페이지가 계속 활성 상태여야 합니다. 한 배치에 최대 1,000개 파일을 담고 각각 SHA-256으로 검증합니다.",
      ],
      bullets: [
        "받는 쪽이 데스크톱 Chrome 또는 Edge: 파일이 곧장 디스크로 스트리밍되므로 사실상 크기 제한이 없습니다.",
        "Firefox와 Safari에는 File System Access API가 없어 실시간으로 받은 묶음이 메모리에 담깁니다 — 대략 256 MB를 넘으면 Relayium이 경고하며, 이는 고정된 한계가 아니라 일부러 보수적으로 잡은 추정치입니다.",
        "배치당 최대 1,000개 파일, 각각 도착 시 고유한 SHA-256 해시로 검증됩니다.",
      ],
    },
    {
      heading: "처음부터가 아니라 이어서 재개",
      body: [
        "두 라이브 페이지가 계속 실행 중이면 일시적인 전송 끊김은 저장된 체크포인트에서 재개할 수 있습니다. 한쪽 페이지를 닫거나 새로고침하거나 App 세션을 끝내면 라이브 전송이 종료되어 새로 시작해야 합니다. 대용량 파일에 저장 링크를 우선하는 또 다른 이유입니다.",
        "연결성도 같은 방식으로 처리됩니다. 같은 네트워크 안에서는 전송이 기기 간에 직접 이루어지고, 네트워크를 넘을 때는 암호화된 스트림이 TURN 릴레이를 거칩니다. 릴레이는 암호문만 볼 수 있으므로 그 경로에서도 종단간 암호화를 유지합니다.",
      ],
    },
    {
      heading: "지금 보내거나, 나중에 받을 링크를 남기거나",
      body: [
        "실시간 전송은 양쪽이 동시에 온라인이어야 하며, 시간을 맞출 수 있을 때 가장 이상적입니다. 상대가 지금 없다면 대신 저장형 다운로드 링크를 만들 수 있습니다.",
        "저장 링크는 영지식입니다. 브라우저가 업로드 전에 AES-256-GCM으로 암호화하고 복호화 키는 URL 프래그먼트에만 존재합니다. 생성에는 보내는 쪽 로그인이 필요하고 할당량을 사용하며 만료됩니다(한 번만 쓰도록 설정할 수도 있는데, 다운로드가 암호문을 받기 시작하는 순간 그 한 번이 소진됩니다). 다운로드 페이지는 Firefox와 Safari에서도 서비스 워커로 단일 파일을 디스크에 스트리밍합니다. 파일이 클수록 저장 링크를 먼저 선택하세요. 업로드 중 수신자는 온라인일 필요가 없지만 보내는 쪽은 완료까지 페이지를 열어 둡니다. 이후에는 보내는 쪽 페이지를 닫아도 되고 받는 쪽은 만료 전 아무 때나 가져갈 수 있습니다. 다만 받는 쪽의 다운로드 자체는 끝까지 진행되어야 합니다. 둘 다 자리에 있어 지금 받기를 원할 때 라이브 경로를 쓰세요.",
      ],
      steps: [
        {
          text: "비동기 전송 페이지를 열고 로그인합니다.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "파일을 고르거나 끌어다 놓습니다. 선택기 옆의 숫자가 이 계정의 현재 파일당 상한입니다. 업로드가 실패한 뒤가 아니라 시작하기 전에 큰 파일을 그것과 견주어 보세요.",
          code: ["업로드할 파일 선택\n최대 512 MiB"],
        },
        {
          text: "“유효 기간”을 정하고, 그 파일이 첫 수령보다 오래 남아 있지 않아야 한다면 “열람 후 삭제 (첫 다운로드 시 삭제)”를 켜세요. 한 번뿐인 자리는 다운로드가 암호문을 받기 시작하면 소진되므로, 끝까지 가지 못한 시도도 그것을 써 버릴 수 있습니다. 목록은 이미 요금제가 허용하는 범위로 걸러져 있으므로, 보이지 않는 기간은 결함이 아니라 요금제 제한입니다.",
          code: ["유효 기간\n1일"],
        },
        {
          text: "암호화와 업로드가 진행되는 동안 페이지를 열어 두세요. 끝나면 링크가 나타나고 그 아래에 만료 날짜가 붙습니다.",
          code: ["링크가 생성되었습니다. 상대에게 보내 다운로드하세요:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "링크 전체를 보내세요. #k= 뒤는 복호화 키이고 서버에는 결코 닿지 않으며, 그 프래그먼트가 빠진 링크는 우리를 포함해 누구도 복호화할 수 없습니다.",
        },
      ],
      success: {
        label: "업로드가 끝났을 때의 화면",
        body: [
          "내 페이지에 링크와 그 링크가 유지될 만료 날짜, 그리고 이것이 임시 전달이고 백업이 아니라는 안내가 표시됩니다. 그 순간부터 업로드는 내 페이지가 열려 있는지에 더 이상 의존하지 않습니다.",
          "받는 사람 쪽에서는 링크가 암호화된 다운로드 페이지를 열어 파일 개수와 총 크기를 보여주고, “다운로드 및 복호화”는 “다운로드 완료 ✓”로 끝납니다. 파일이 어디에 놓일지는 그쪽 브라우저가 정하므로, 확인할 자리는 그쪽의 다운로드 목록입니다.",
        ],
        code: ["암호화된 다운로드 링크\n다운로드 완료 ✓"],
      },
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "파일이 단일 파일 크기 상한을 넘는다는 메시지로 업로드가 거부됩니다.",
            code: ["https://relayium.com/offline-transfer   # 선택기가 상한을 ‘최대 <크기>’로 찍는다"],
            fix: "그 상한은 배치가 아니라 파일 단위이므로, 40 GB 내보내기를 각각 들어가는 조각으로 나누는 것이 길입니다. 아니면 둘 다 온라인인 동안 실시간으로 보내세요. 아무것도 저장하지 않으므로 서버 측 크기 제한이 없습니다.",
          },
          {
            symptom: "거부 이유가 파일 크기가 아니라 오늘의 할당량입니다.",
            code: ["https://relayium.com/offline-transfer   # 일일 할당량 거부는 업로드 흐름이 알려준다"],
            fix: "일일 업로드 할당량은 파일당 상한이나 저장 용량과 다른 것이고, 이를 알려주는 것은 업로드 흐름입니다. https://relayium.com/me 는 계정의 월간 사용량을 보여줄 뿐, 남은 일일 할당량을 실시간으로 보여주지 않습니다. 이전 업로드가 창에서 빠지면서 회복되기를 기다리거나, 가능하다면 요금제를 올리거나, 둘 다 온라인인 동안 실시간으로 넘기세요. 실시간 전송은 아무것도 저장하지 않으므로 업로드 할당량을 쓰지 않습니다.",
          },
          {
            symptom: "유효 기간 목록에 기대했던 7일이나 14일이 없습니다.",
            code: ["https://relayium.com/pricing   # 보관 기간은 요금제별 수치다"],
            fix: "목록은 요금제의 보관 상한이 허용하는 기간만 보여주고, 서버도 같은 상한을 자기 쪽에서 방어적으로 적용합니다. 그래서 실제로 고를 수 있는 기간이 몰래 줄어드는 일은 없습니다. 제시된 것 중 가장 긴 것을 고르거나 요금제를 바꾸세요. 결정하는 것은 상한이고 파일이 아닙니다.",
          },
          {
            symptom: "상대가 링크가 잘못되었거나 만료되었거나 이미 다운로드되어 삭제되었다고 합니다.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # 링크 하나, id 하나, 키 하나"],
            fix: "셋 다 같은 결론에 닿습니다. 가져올 것이 남아 있지 않습니다. “열람 후 삭제”가 켜져 있었다면 다운로드가 암호문을 받기 시작한 순간 한 번뿐인 자리가 소진된 것입니다. 중간에 끊긴 시도라도 일부 바이트가 전달됐다면 소진되고, 한 바이트도 전달되지 않은 시도만 자리를 되돌려 줍니다. 다시 올려 새 링크를 보내고, 여러 사람이 받아야 할 때는 삭제를 꺼 두세요.",
          },
          {
            symptom: "다운로드 페이지가 요청이 너무 많다거나 보낸 사람의 이번 달 전송량이 다 되었다고 합니다.",
            code: ["https://relayium.com/me   # 이번 달 사용량은 저장뿐 아니라 전송도 포함한다"],
            fix: "파일은 그대로 있습니다 — 이것은 유실이 아니라 계량입니다. 몇 분 기다리면 속도 제한은 풀리고, 월 전송량을 다 쓴 경우에는 달이 바뀌거나 요금제를 올리거나 자체 노드가 필요하며, 그동안에는 실시간 전송이 이를 완전히 우회합니다.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "보낼 수 있는 파일 최대 크기는 얼마인가요?",
        a: "대용량 파일에는 저장형 다운로드 링크를 사용하세요. 파일당 한도와 할당량은 업로드 전에 표시됩니다. 실시간에는 서버 측 한도가 없고 데스크톱 Chrome/Edge는 디스크로 스트리밍하지만 두 페이지가 계속 활성 상태여야 합니다. Firefox/Safari 실시간 수신은 메모리에 보관되며 약 256 MB를 넘으면 보수적인 경고가 표시됩니다.",
      },
      {
        q: "전송이 중단되면 어떻게 되나요?",
        a: "두 페이지가 실행 중이면 일시적인 연결 끊김은 저장된 체크포인트에서 재개할 수 있습니다. 페이지를 닫거나 새로고침하거나 App 세션을 끝내면 라이브 전송이 종료됩니다. 저장 링크에서는 수신자가 온라인일 필요가 없지만 보내는 쪽은 업로드가 끝날 때까지 페이지를 열어 둬야 합니다.",
      },
      {
        q: "대용량 파일에서 개인정보는 어떻게 보호되나요?",
        a: "실시간 전송은 X25519 키 교환과 블록별 AES-256-GCM으로 종단간 암호화되며 키는 어떤 서버에도 도달하지 않습니다. 고급 검증(기본값 꺼짐)을 켜면 두 기기가 6자리 검증 코드를 표시하며, 각 파일은 SHA-256으로 검사합니다. 같은 LAN의 WebRTC는 직접 연결하며, 네트워크를 넘는 브라우저는 설계상 TURN을 사용합니다. 릴레이는 읽거나 복호화할 수 없는 암호문만 운반합니다.",
      },
    ],
  },
  cta: {
    text: "다음 수 기가바이트 파일을 클라우드 없이 옮기세요 — 암호화된 다운로드 링크를 남기거나, 두 기기를 연결해 지금 보내세요. 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Große Dateien ohne Cloud versenden",
  description:
    "Erstelle für große Videos und Projektarchive einen Ende-zu-Ende verschlüsselten Download-Link zur späteren Abholung; Echtzeit bleibt die Live-Alternative, wenn beide Seiten online bleiben können.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Ein 20 GB großer Videoexport oder ein schweres Projektarchiv ist genau der Fall, in dem Cloud-Speicher am langsamsten wirkt: Du lädst die ganze Datei einmal hoch, wartest, und die andere Person lädt sie erneut herunter — zwei vollständige Übertragungen, plus das, was dein Speicherkontingent zulässt. Für eine einmalige Übergabe ist das viel Kopieren und Warten für Bytes, die nur von A nach B mussten.",
    "Für große Dateien empfiehlt Relayium einen Ende-zu-Ende verschlüsselten gespeicherten Download-Link: Die empfangende Person muss beim Upload nicht online sein und holt ihn später ab. Die Senderseite bleibt bis zum Upload-Ende offen; danach ist der Link bis zum Ablauf verfügbar. Wenn beide online bleiben können, ist Echtzeit die Live-Alternative: im LAN direkt per WebRTC, netzübergreifend als Ende-zu-Ende-Chiffretext über TURN. Echtzeit behält keine serverseitige Kopie und keine Echtzeithistorie.",
  ],
  sections: [
    {
      heading: "Warum ein gespeicherter Link bei großen Dateien Standard ist",
      prereqs: {
        label: "Bevor du anfängst",
        items: [
          "Ein angemeldetes Konto auf der sendenden Seite. Einen gespeicherten Download-Link zu erstellen braucht eines; wer den Link öffnet, meldet sich nie an.",
          "Luft in zwei getrennten Grenzen: der Obergrenze pro Datei, die die Upload-Seite neben der Auswahl ausgibt, und dem Speicherkontingent deines Tarifs. Beide liest man von der Seite ab, statt sie zu raten.",
          "Eine Aufbewahrungsdauer, mit der du leben kannst. Die Ablaufliste bietet nur an, was dein Tarif erlaubt, und der Server setzt dieselbe Grenze zur Sicherheit noch einmal durch — was du auswählen kannst, gilt also auch so. Und keiner dieser Links ist ein Backup.",
          "Die Senderseite bleibt offen, bis der Upload fertig ist. Danach steht der Link für sich, bis er abläuft, und die sendende Seite darf den Laptop zuklappen; die empfangende Seite muss ihren eigenen Download bis zum Ende laufen lassen.",
        ],
      },
      body: [
        "Ein Relayium-Download-Link speichert nur im Browser verschlüsselten Chiffretext. Die empfangende Person kann beim Upload offline sein und später abholen; nach Abschluss entfernt das Schließen der Senderseite den Link nicht. Grenzen sind Dateilimit, Kontingent und Ablauf, die auf der Seite angezeigt werden.",
        "Echtzeit ist die Alternative, wenn beide jetzt bereit sind. Im selben LAN verbindet WebRTC ohne Konto direkt; netzübergreifend trägt TURN Ende-zu-Ende-Chiffretext und der Code-Ersteller meldet sich an. Beide Seiten müssen aktiv bleiben, daher eignet sich dieser Weg besser für kleine Dateien und Text als für lange große Übertragungen.",
      ],
    },
    {
      heading: "Keine Größenbeschränkung im Echtzeitmodus",
      body: [
        "Echtzeitübertragungen haben keine serverseitige Speichergrößenbeschränkung, weil Relayium keine Inhaltskopie behält. Ein TURN-Relay kann netzübergreifenden Chiffretext tragen, solange beide Seiten online sind, kann ihn aber weder lesen noch entschlüsseln oder als Übertragungshistorie behalten. Die praktische Obergrenze setzt der empfangende Browser.",
        "Chrome und Edge können eine eingehende Echtzeitdatei direkt auf die Festplatte streamen, sodass technisch zweistellige Gigabyte-Größen möglich sind. Das ist keine Standardempfehlung für große Dateien: Die Live-Sitzung braucht weiterhin beide aktiven Seiten. Ein Stapel fasst bis zu 1.000 Dateien, jede per SHA-256 geprüft.",
      ],
      bullets: [
        "Chrome oder Edge am empfangenden Desktop: Dateien werden direkt auf die Festplatte gestreamt, es gibt also praktisch keine Größenbeschränkung.",
        "Firefox und Safari haben keine File System Access API, dort liegt ein in Echtzeit empfangener Stapel im Arbeitsspeicher — ab etwa 256 MB warnt Relayium, ein bewusst vorsichtiger Schätzwert und keine harte Grenze.",
        "Bis zu 1.000 Dateien pro Stapel, jede beim Eintreffen mit ihrem eigenen SHA-256-Hash geprüft.",
      ],
    },
    {
      heading: "Fortsetzen statt neu beginnen",
      body: [
        "Ein kurzer Transportabbruch kann von einem beständigen Prüfpunkt fortgesetzt werden, solange beide Live-Seiten aktiv bleiben. Das Schließen oder Neuladen einer Seite beziehungsweise das Beenden der App-Sitzung beendet dagegen die Live-Übertragung. Auch deshalb ist für große Dateien der gespeicherte Link vorzuziehen.",
        "Die Konnektivität wird ebenso gehandhabt. Im selben Netz läuft die Übertragung direkt von Gerät zu Gerät; netzübergreifend läuft der verschlüsselte Datenstrom über ein TURN-Relay. Das Relay sieht nur Chiffretext, sodass auch dieser Pfad Ende-zu-Ende-verschlüsselt bleibt.",
      ],
    },
    {
      heading: "Jetzt senden oder einen Link für später hinterlassen",
      body: [
        "Die Echtzeitübertragung setzt voraus, dass beide gleichzeitig online sind — ideal, wenn ihr euch abstimmen könnt. Ist die andere Person gerade nicht verfügbar, kannst du stattdessen einen gespeicherten Download-Link erstellen.",
        "Ein gespeicherter Link ist Zero-Knowledge: Dein Browser verschlüsselt vor dem Upload mit AES-256-GCM, der Schlüssel liegt nur im URL-Fragment. Erstellen erfordert die Anmeldung, Links zählen gegen ein Kontingent und laufen ab (oder sind einmalig: Der eine Platz ist vergeben, sobald ein Download Chiffretext zu empfangen beginnt). Die Download-Seite kann auch in Firefox und Safari auf die Festplatte streamen. Für die größten Dateien nimm zuerst den gespeicherten Link: Die empfangende Person muss beim Upload nicht online sein; die Senderseite bleibt bis zum Abschluss offen, danach darf sie schließen und die empfangende Person holt bis zum Ablauf jederzeit ab — ihr eigener Download muss allerdings durchlaufen. Den Live-Weg nimmst du, wenn beide am Schreibtisch sitzen und die Bytes jetzt ankommen sollen.",
      ],
      steps: [
        {
          text: "Öffne die Seite für asynchrone Übertragung und melde dich an.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Wähle die Dateien, oder zieh sie hinein. Die Zahl neben der Auswahl ist die aktuelle Obergrenze pro Datei für dein Konto — vergleich die große Datei damit, bevor du startest, und nicht erst wenn der Upload scheitert.",
          code: ["Dateien zum Hochladen wählen\nMax. 512 MiB"],
        },
        {
          text: "Setz „Gültig für“, und schalte „Nach dem Lesen löschen (beim ersten Download)“ ein, wenn die Datei ihren ersten Abruf nicht überleben soll. Der eine Platz ist vergeben, sobald ein Download Chiffretext zu empfangen beginnt — auch ein Versuch, der nie fertig wird, kann ihn also aufbrauchen. Die Liste ist schon auf das gefiltert, was dein Tarif erlaubt, ein nicht sichtbares Fenster ist also eine Tarifgrenze und kein Fehler.",
          code: ["Gültig für\n1 Tag"],
        },
        {
          text: "Lass die Seite offen, während sie verschlüsselt und hochlädt. Zum Abschluss erscheint der Link, mit seinem Ablaufdatum darunter.",
          code: ["Link bereit — sende ihn dem Empfänger zum Herunterladen:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "Sende den ganzen Link. Alles nach #k= ist der Entschlüsselungsschlüssel, er erreicht den Server nie, und ein Link, der ohne dieses Fragment ankommt, ist von niemandem zu entschlüsseln — auch von uns nicht.",
        },
      ],
      success: {
        label: "So sieht ein fertiger Upload aus",
        body: [
          "Deine Seite zeigt den Link, das Ablaufdatum, das er behält, und den Hinweis, dass dies eine temporäre Zustellung und kein Backup ist. Ab diesem Moment hängt der Upload nicht mehr daran, dass deine Seite offen bleibt.",
          "Bei der empfangenden Person öffnet der Link die verschlüsselte Download-Seite mit Dateizahl und Gesamtgröße, und „Herunterladen & entschlüsseln“ endet bei „Download abgeschlossen ✓“. Wo die Datei landet, entscheidet deren Browser, die Download-Liste dort ist also der Ort zum Nachsehen.",
        ],
        code: ["Verschlüsselter Download-Link\nDownload abgeschlossen ✓"],
      },
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Der Upload wird mit der Meldung abgelehnt, die Datei überschreite die Größengrenze pro Datei.",
            code: ["https://relayium.com/offline-transfer   # die Auswahl nennt die Grenze als Max. <Größe>"],
            fix: "Diese Grenze gilt pro Datei und nicht pro Stapel, ein 40-GB-Export in passend große Teile zu zerlegen ist also der Weg — oder schick ihn stattdessen in Echtzeit, solange ihr beide online seid: Dort gibt es keine serverseitige Größengrenze, weil nichts gespeichert wird.",
          },
          {
            symptom: "Abgelehnt wird nicht wegen der Dateigröße, sondern wegen des Tageskontingents.",
            code: ["https://relayium.com/offline-transfer   # die Ablehnung wegen Tageskontingent meldet der Upload-Ablauf"],
            fix: "Das tägliche Upload-Kontingent ist etwas anderes als die Grenze pro Datei und als der Speicher, und gemeldet wird es vom Upload-Ablauf — https://relayium.com/me zeigt die monatliche Kontonutzung und keinen laufenden Rest des Tageskontingents. Warte, bis sich das gleitende Tagesfenster erholt, weil ältere Uploads herausfallen, wechsle den Tarif, wenn das für dich möglich ist, oder übergib die Datei in Echtzeit, solange beide online sind — eine Echtzeitübertragung speichert nichts und verbraucht daher kein Upload-Kontingent.",
          },
          {
            symptom: "Die Ablaufliste bietet die erwarteten 7 oder 14 Tage nicht an.",
            code: ["https://relayium.com/pricing   # die Aufbewahrung ist eine Zahl pro Tarif"],
            fix: "Die Liste zeigt nur Fenster, die die Aufbewahrungsgrenze deines Tarifs erlaubt, und der Server setzt dieselbe Grenze auf seiner Seite noch einmal durch, sodass nichts heimlich gekürzt wird, was du tatsächlich wählen kannst. Nimm das längste angebotene, oder wechsle den Tarif — entscheidend ist die Grenze, nicht die Datei.",
          },
          {
            symptom: "Die andere Person sagt, der Link sei ungültig, abgelaufen oder bereits heruntergeladen und gelöscht.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # ein Link, eine id, ein Schlüssel"],
            fix: "Alle drei enden an derselben Stelle: Es ist nichts mehr abzuholen. War „Nach dem Lesen löschen“ aktiv, ist der eine Platz bereits vergeben, sobald ein Download Chiffretext zu empfangen beginnt — auch ein abgebrochener Versuch, bei dem Bytes ankamen, verbraucht ihn, während ein Versuch ohne ein einziges geliefertes Byte ihn wieder freigibt. Lade also erneut hoch und schick einen neuen Link, und lass das Löschen aus, wenn mehr als eine Person die Datei braucht.",
          },
          {
            symptom: "Die Download-Seite meldet zu viele Anfragen, oder das Monatsvolumen des Senders sei aufgebraucht.",
            code: ["https://relayium.com/me   # die Nutzung dieses Monats umfasst nicht nur Speicher, sondern Transfer"],
            fix: "Die Datei ist noch da — das ist Abrechnung und kein Verlust. Ein paar Minuten Warten löst ein Ratenlimit; ein aufgebrauchtes Monatsvolumen braucht den Monatswechsel, einen Tarifwechsel oder einen eigenen Node, und in der Zwischenzeit umgeht eine Echtzeitübertragung es vollständig.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Wie groß darf die Datei sein, die ich sende?",
        a: "Für große Dateien nimm den gespeicherten Download-Link; Dateilimit und Kontingent werden vor dem Upload angezeigt. Echtzeit hat keine serverseitige Grenze, und Chrome oder Edge können auf die Festplatte streamen, aber beide Seiten müssen aktiv bleiben. Firefox und Safari halten einen Echtzeitempfang im Speicher und warnen ab etwa 256 MB — eine vorsichtige Schätzung, keine harte Grenze.",
      },
      {
        q: "Was passiert, wenn die Übertragung unterbrochen wird?",
        a: "Ein kurzer Verbindungsabbruch kann von einem beständigen Prüfpunkt fortgesetzt werden, solange beide Seiten aktiv bleiben. Schließen oder Neuladen einer Seite oder das Beenden der App-Sitzung beendet die Live-Übertragung. Beim gespeicherten Link muss die empfangende Person nicht online sein; die Senderseite bleibt aber bis zum Upload-Ende offen.",
      },
      {
        q: "Wie ist meine Privatsphäre bei großen Dateien geschützt?",
        a: "Echtzeitübertragungen sind mit X25519 und AES-256-GCM pro Block Ende-zu-Ende verschlüsselt; der Schlüssel erreicht keinen Server. Mit eingeschalteter erweiterter Verifizierung (standardmäßig aus) zeigen beide Geräte einen sechsstelligen Verifizierungscode; jede Datei wird per SHA-256 geprüft. WebRTC ist im selben LAN direkt; netzübergreifende Browser nutzen TURN planmäßig, und das Relay transportiert nur Chiffretext, den es weder lesen noch entschlüsseln kann.",
      },
    ],
  },
  cta: {
    text: "Bewege deine nächste mehrere Gigabyte große Datei ohne Cloud — hinterlass einen verschlüsselten Download-Link oder verbinde beide Geräte und schick sie sofort. Keine Installation und im selben Netz kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer de gros fichiers sans le cloud",
  description:
    "Pour les grosses vidéos et archives, créez un lien de téléchargement chiffré de bout en bout à récupérer plus tard ; le temps réel reste l'option immédiate si les deux côtés restent en ligne.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Un export vidéo de 20 Go ou une lourde archive de projet, c'est justement là que le stockage cloud paraît le plus lent : vous téléversez tout le fichier une fois, vous attendez, puis l'autre personne le télécharge à nouveau — deux transferts complets, plus ce que votre quota de stockage autorise. Pour une remise unique, cela fait beaucoup de copies et d'attente pour des octets qui ne devaient aller que de A à B.",
    "Pour un gros fichier, Relayium recommande un lien de téléchargement stocké et chiffré de bout en bout : le destinataire n'a pas besoin d'être en ligne pendant l'envoi et récupère plus tard. Gardez la page d'envoi ouverte jusqu'à la fin ; ensuite le lien reste disponible jusqu'à expiration. Si les deux côtés restent en ligne, le temps réel est l'alternative immédiate : WebRTC direct sur le LAN, ou chiffré de bout en bout via TURN entre réseaux. Le temps réel ne conserve aucune copie de contenu ni historique côté serveur.",
  ],
  sections: [
    {
      heading: "Pourquoi le lien stocké est le choix par défaut pour les gros fichiers",
      prereqs: {
        label: "Avant de commencer",
        items: [
          "Un compte connecté du côté qui envoie. Créer un lien de téléchargement stocké en exige un, alors que la personne qui ouvre le lien ne se connecte jamais.",
          "De la marge dans deux limites distinctes : le plafond par fichier que la page d'envoi affiche à côté du sélecteur, et le quota de stockage de votre offre. Les deux se lisent sur la page au lieu d'être devinés.",
          "Une durée de conservation qui vous convient. La liste d'expiration ne propose que ce que votre offre autorise, et le serveur applique le même plafond de son côté par précaution : une durée que vous pouvez choisir est donc bien celle que vous obtenez. Aucun de ces liens n'est une sauvegarde.",
          "La page d'envoi laissée ouverte jusqu'à la fin de l'envoi. Ensuite le lien tient seul jusqu'à son expiration et l'expéditeur peut refermer son ordinateur ; le destinataire, lui, doit laisser son propre téléchargement aller jusqu'au bout.",
        ],
      },
      body: [
        "Un lien Relayium ne stocke que le texte chiffré produit dans le navigateur. Le destinataire peut être hors ligne pendant l'envoi et récupérer plus tard ; après la fin du téléversement, fermer la page d'envoi ne supprime pas le lien. Les limites affichées sont la taille par fichier, le quota et l'expiration.",
        "Le temps réel est l'alternative si les deux côtés sont prêts maintenant. WebRTC est direct et sans compte sur le même LAN ; entre réseaux, TURN porte le chiffré de bout en bout et le créateur du code se connecte. Les deux pages doivent rester actives : ce mode convient mieux aux petits fichiers et au texte qu'à une longue livraison volumineuse.",
      ],
    },
    {
      heading: "Aucune limite de taille en mode temps réel",
      body: [
        "Les transferts en temps réel n'ont aucune limite de stockage côté serveur, car Relayium ne conserve aucune copie du contenu. Un relais TURN peut transporter le texte chiffré entre réseaux pendant que les deux côtés sont en ligne, mais ne peut ni le lire, ni le déchiffrer, ni le garder comme historique. Le plafond pratique vient du navigateur qui reçoit.",
        "Chrome et Edge peuvent diffuser un fichier temps réel directement sur le disque, donc le protocole peut techniquement transporter des dizaines de gigaoctets. Ce n'est pas la recommandation par défaut pour les gros fichiers : la session vivante exige toujours les deux pages actives. Un lot contient jusqu'à 1 000 fichiers, chacun vérifié par SHA-256.",
      ],
      bullets: [
        "Chrome ou Edge sur l'ordinateur qui reçoit : les fichiers sont diffusés directement sur le disque, il n'y a donc pratiquement aucune limite de taille.",
        "Firefox et Safari n'ont pas l'API File System Access : un lot reçu en temps réel y tient en mémoire — Relayium prévient au-delà d'environ 256 Mo, une estimation volontairement prudente et non une limite ferme.",
        "Jusqu'à 1 000 fichiers par lot, chacun vérifié à l'arrivée par sa propre empreinte SHA-256.",
      ],
    },
    {
      heading: "Reprendre plutôt que recommencer",
      body: [
        "Une brève coupure de transport peut reprendre depuis un point durable tant que les deux pages vivantes restent actives. Fermer ou recharger une page, ou terminer la session de l'app, met fin au transfert vivant. C'est une raison supplémentaire de préférer le lien stocké pour les gros fichiers.",
        "La connectivité est gérée de la même façon. Sur un même réseau, le transfert se fait directement d'appareil à appareil ; entre réseaux, le flux chiffré passe par un relais TURN. Le relais ne voit que du texte chiffré, si bien que cette voie reste elle aussi chiffrée de bout en bout.",
      ],
    },
    {
      heading: "Envoyer maintenant, ou laisser un lien pour plus tard",
      body: [
        "Le transfert en temps réel exige que les deux personnes soient en ligne en même temps, ce qui est idéal quand vous pouvez vous coordonner. Si l'autre personne n'est pas disponible, vous pouvez créer un lien de téléchargement stocké.",
        "Un lien stocké est à divulgation nulle : le navigateur chiffre en AES-256-GCM avant l'envoi et la clé ne vit que dans le fragment de l'URL. Sa création exige une connexion, utilise un quota et le lien expire, ou peut être à usage unique, sa seule place étant consommée dès qu'un téléchargement commence à recevoir du chiffré. La page de téléchargement peut diffuser un fichier sur le disque même dans Firefox et Safari. Pour les plus gros fichiers, choisissez d'abord le lien stocké : le destinataire n'a pas besoin d'être en ligne pendant l'envoi ; gardez la page d'envoi ouverte jusqu'à la fin, après quoi elle peut se fermer et le destinataire récupère le fichier à tout moment avant l'expiration, son propre téléchargement devant tout de même aller jusqu'au bout. Gardez la voie vivante pour une remise immédiate quand vous êtes tous deux devant l'écran.",
      ],
      steps: [
        {
          text: "Ouvrez la page de transfert asynchrone et connectez-vous.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Choisissez les fichiers, ou glissez-les. Le chiffre à côté du sélecteur est le plafond par fichier en vigueur pour votre compte. Comparez-y le gros fichier avant de commencer, plutôt qu'après l'échec de l'envoi.",
          code: ["Choisir des fichiers à envoyer\nMax 512 MiB"],
        },
        {
          text: "Réglez « Expire dans », et activez « Autodestruction après lecture (supprimé au premier téléchargement) » si le fichier ne doit pas survivre à sa première récupération. La place unique est consommée dès qu'un téléchargement commence à recevoir du chiffré, si bien qu'une tentative qui n'aboutit pas peut aussi l'épuiser. La liste est déjà filtrée selon votre offre, donc une durée absente est une limite d'offre et non un défaut.",
          code: ["Expire dans\n1 jour"],
        },
        {
          text: "Laissez la page ouverte pendant le chiffrement et l'envoi. À la fin, le lien apparaît avec sa date d'expiration en dessous.",
          code: ["Lien prêt — envoyez-le au destinataire pour télécharger :\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "Envoyez le lien entier. Tout ce qui suit #k= est la clé de déchiffrement, elle n'atteint jamais le serveur, et un lien arrivé sans ce fragment n'est déchiffrable par personne, nous compris.",
        },
      ],
      success: {
        label: "À quoi ressemble un envoi terminé",
        body: [
          "Votre page affiche le lien, la date d'expiration qu'il conservera, et le rappel qu'il s'agit d'une livraison temporaire et non d'une sauvegarde. À partir de cet instant, l'envoi ne dépend plus de votre page restée ouverte.",
          "Chez le destinataire, le lien ouvre la page de téléchargement chiffré avec le nombre de fichiers et la taille totale, et « Télécharger et déchiffrer » se termine sur « Téléchargement terminé ✓ ». L'endroit où le fichier atterrit relève de son navigateur, donc sa liste de téléchargements est l'endroit à vérifier.",
        ],
        code: ["Lien de téléchargement chiffré\nTéléchargement terminé ✓"],
      },
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "L'envoi est refusé au motif que le fichier dépasse la limite de taille par fichier.",
            code: ["https://relayium.com/offline-transfer   # le sélecteur indique le plafond sous la forme Max <taille>"],
            fix: "Ce plafond vaut par fichier et non par lot, donc découper un export de 40 Go en parties qui rentrent chacune est la voie à suivre. Ou envoyez-le en temps réel pendant que vous êtes tous deux en ligne, où aucune limite de taille côté serveur n'existe puisque rien n'est stocké.",
          },
          {
            symptom: "Le refus porte sur le quota du jour et non sur la taille du fichier.",
            code: ["https://relayium.com/offline-transfer   # le refus lié au quota du jour est signalé par le flux d'envoi"],
            fix: "Le quota d'envoi quotidien est distinct du plafond par fichier et du stockage, et c'est le flux d'envoi qui le signale, tandis que https://relayium.com/me montre l'utilisation mensuelle du compte et non ce qu'il reste du quota du jour. Attendez que la fenêtre glissante se rétablisse à mesure que les envois plus anciens en sortent, changez d'offre si c'est possible, ou remettez le fichier en temps réel pendant que les deux côtés sont en ligne, car un transfert en temps réel ne stocke rien et ne consomme donc aucun quota d'envoi.",
          },
          {
            symptom: "La liste d'expiration ne propose pas les 7 ou 14 jours attendus.",
            code: ["https://relayium.com/pricing   # la conservation est un chiffre par offre"],
            fix: "La liste ne montre que les durées autorisées par le plafond de conservation de votre offre, et le serveur applique ce même plafond de son côté par précaution, si bien que rien de ce que vous pouvez réellement choisir n'est raccourci à votre insu. Prenez la plus longue proposée, ou changez d'offre, car c'est le plafond qui décide et non le fichier.",
          },
          {
            symptom: "Le destinataire dit que le lien est invalide, expiré, ou déjà téléchargé puis supprimé.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # un lien, un id, une clé"],
            fix: "Les trois aboutissent au même point : il ne reste rien à récupérer. Si « Autodestruction après lecture » était activée, la place unique est consommée dès qu'un téléchargement commence à recevoir du chiffré, et une tentative interrompue qui a tout de même reçu des octets la consomme aussi, alors qu'une tentative n'ayant rien livré la libère. Renvoyez le fichier et transmettez un nouveau lien, et laissez cette option désactivée quand plusieurs personnes doivent récupérer le fichier.",
          },
          {
            symptom: "La page de téléchargement signale trop de requêtes, ou que le volume mensuel de l'expéditeur est épuisé.",
            code: ["https://relayium.com/me   # l'utilisation du mois couvre le transfert et pas seulement le stockage"],
            fix: "Le fichier est toujours là : c'est du décompte, pas une perte. Quelques minutes d'attente lèvent une limitation de débit, tandis qu'un volume mensuel épuisé attend le changement de mois, un changement d'offre ou votre propre nœud, et entre-temps un transfert en temps réel le contourne complètement.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Quelle est la taille maximale d'un fichier que je peux envoyer ?",
        a: "Pour les gros fichiers, utilisez le lien stocké ; la taille maximale et le quota sont affichés avant l'envoi. Le temps réel n'a pas de limite côté serveur et Chrome/Edge peut diffuser sur le disque, mais les deux pages doivent rester actives. Firefox/Safari garde une réception temps réel en mémoire et avertit vers 256 Mo — une estimation prudente, pas une limite ferme.",
      },
      {
        q: "Que se passe-t-il si le transfert est interrompu ?",
        a: "Une brève coupure peut reprendre depuis un point durable tant que les deux pages restent actives. Fermer ou recharger une page, ou terminer la session de l'app, met fin au transfert vivant. Avec un lien stocké, le destinataire peut être hors ligne, mais la page d'envoi reste ouverte jusqu'à la fin du téléversement.",
      },
      {
        q: "Comment ma vie privée est-elle protégée pour les gros fichiers ?",
        a: "Les transferts en temps réel utilisent X25519 et AES-256-GCM par bloc de bout en bout ; la clé n'atteint aucun serveur. Avec la vérification avancée activée (désactivée par défaut), les deux appareils affichent un code à 6 chiffres, et chaque fichier est vérifié par SHA-256. WebRTC est direct sur le même LAN ; entre réseaux, les navigateurs utilisent TURN par conception, et le relais ne transporte que du texte chiffré qu'il ne peut ni lire ni déchiffrer.",
      },
    ],
  },
  cta: {
    text: "Déplacez votre prochain fichier de plusieurs gigaoctets sans le cloud — laissez un lien de téléchargement chiffré, ou connectez les deux appareils et envoyez-le tout de suite. Sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "كيفية إرسال الملفات الكبيرة دون سحابة",
  description:
    "للملفات الكبيرة أنشئ رابط تنزيل مشفّرًا من الطرف إلى الطرف ليستلمه الطرف الآخر لاحقًا؛ ويبقى النقل الفوري بديلًا مباشرًا عندما يستطيع الطرفان البقاء متصلين.",
  updatedLabel: "آخر تحديث",
  lead: [
    "تصدير فيديو بحجم 20 غيغابايت أو أرشيف مشروع ثقيل هو تحديدًا حيث يبدو تخزين السحابة أبطأ ما يكون: ترفع الملف كاملًا مرة، تنتظر، ثم ينزّله الطرف الآخر مجددًا — نقلتان كاملتان زائد ما تسمح به حصة التخزين لديك. لتسليم لمرة واحدة، هذا كمٌّ كبير من النسخ والانتظار لبايتات لم تكن بحاجة إلا للانتقال من أ إلى ب.",
    "للملف الكبير يوصي Relayium برابط تنزيل مخزّن ومشفّر من الطرف إلى الطرف: لا يلزم اتصال المستقبِل أثناء الرفع ويمكنه الاستلام لاحقًا. أبقِ صفحة المُرسِل مفتوحة حتى يكتمل الرفع؛ بعدها يبقى الرابط حتى انتهاء صلاحيته. وإذا أمكن للطرفين البقاء متصلين فالنقل الفوري بديل مباشر: WebRTC داخل LAN وTURN للنص المشفّر عبر الشبكات. ولا يحتفظ النقل الفوري بنسخة محتوى على الخادم أو بسجل.",
  ],
  sections: [
    {
      heading: "لماذا يكون الرابط المخزّن الخيار الافتراضي للملفات الكبيرة",
      prereqs: {
        label: "قبل أن تبدأ",
        items: [
          "حساب مسجَّل الدخول في جهة الإرسال. إنشاء رابط تنزيل مخزَّن يحتاجه، أما من يفتح الرابط فلا يسجّل الدخول أبدًا.",
          "متسع في حدَّين منفصلين: سقف الملف الواحد الذي تطبعه صفحة الرفع جوار المنتقي، وحصة التخزين في باقتك. ويُقرأ كلٌّ منهما من الصفحة لا بالتخمين.",
          "مدة احتفاظ تقبلها. قائمة انتهاء الصلاحية لا تعرض إلا ما تسمح به باقتك، ويطبّق الخادم السقف نفسه من جهته على سبيل الاحتياط، فالمدة التي يمكنك اختيارها هي المدة التي تحصل عليها فعلًا، وليس أي من هذه الروابط نسخة احتياطية.",
          "إبقاء صفحة المُرسِل مفتوحة حتى ينتهي الرفع. وبعد ذلك يستقلّ الرابط بنفسه إلى أن تنتهي صلاحيته، ويمكن للمُرسِل إغلاق الحاسوب؛ أما المستقبِل فعليه أن يترك تنزيله يعمل حتى النهاية.",
        ],
      },
      body: [
        "لا يخزّن رابط Relayium إلا النص المشفّر في المتصفح. يمكن للمستقبِل أن يكون غير متصل أثناء الرفع وأن يستلم لاحقًا؛ وبعد اكتمال الرفع لا يؤدي إغلاق صفحة المُرسِل إلى حذف الرابط. الحدود المعروضة هي حجم الملف والحصة ومدة الصلاحية.",
        "النقل الفوري بديل عندما يكون الطرفان مستعدين الآن. يتصل WebRTC مباشرةً وبدون حساب داخل LAN؛ وعبر الشبكات يحمل TURN النص المشفّر ويسجّل منشئ الرمز الدخول. يجب إبقاء الصفحتين نشطتين، لذا يناسب الملفات الصغيرة والنص أكثر من تسليم ملف كبير طويل.",
      ],
    },
    {
      heading: "لا سقف للحجم في الوضع الفوري",
      body: [
        "لا يملك النقل الفوري حدًا لحجم التخزين على الخادم لأن Relayium لا يحتفظ بنسخة من المحتوى. قد يحمل مُرحِّل TURN النص المشفّر عبر الشبكات أثناء اتصال الطرفين، لكنه لا يستطيع قراءته أو فك تشفيره أو الاحتفاظ به كسجل نقل. السقف العملي يحدده المتصفح المستقبِل.",
        "يستطيع Chrome وEdge بث ملف فوري مباشرةً إلى القرص، لذا يمكن للبروتوكول تقنيًا حمل عشرات الغيغابايت. لكن ذلك ليس التوصية الافتراضية للملفات الكبيرة: ما زالت الجلسة الحية تحتاج الصفحتين نشطتين. تضم الدفعة حتى 1,000 ملف ويُفحَص كل ملف بـ SHA-256.",
      ],
      bullets: [
        "Chrome أو Edge على حاسوب الطرف المستقبِل: تُبَثّ الملفات مباشرةً إلى القرص، فلا يوجد عمليًا سقف للحجم.",
        "أما Firefox وSafari فلا تملكان واجهة File System Access، فتبقى الدفعة المستلمة فوريًا في الذاكرة — وينبّهك Relayium فوق نحو 256 ميغابايت، وهو تقدير متحفّظ عن قصد لا حدٌّ صارم.",
        "حتى 1,000 ملف لكل دفعة، يُفحَص كلٌّ منها بتجزئة SHA-256 خاصة به عند الوصول.",
      ],
    },
    {
      heading: "الاستئناف بدلًا من البدء من جديد",
      body: [
        "يمكن استئناف انقطاع نقل قصير من نقطة محفوظة ما دامت الصفحتان الحيتان نشطتين. أما إغلاق أو تحديث أي صفحة أو إنهاء جلسة التطبيق فيُنهي النقل الحي ويتطلب بدء تسليم جديد. وهذا سبب آخر لتفضيل الرابط المخزّن للملفات الكبيرة.",
        "تُعالَج الاتصالية بالطريقة نفسها. داخل الشبكة الواحدة يجري النقل من الند للند مباشرةً؛ وعبر الشبكات يمرّ التدفق المشفَّر على مُرحِّل TURN. لا يرى المُرحِّل سوى نص مُشفَّر، فيبقى هذا المسار أيضًا مشفَّرًا من الطرف إلى الطرف.",
      ],
    },
    {
      heading: "أرسِل الآن، أو اترك رابطًا للاحقًا",
      body: [
        "يحتاج النقل الفوري إلى أن يكون الطرفان متصلين في الوقت نفسه، وهو مثالي حين يمكنك التنسيق. إذا لم يكن الطرف الآخر متاحًا الآن، يمكنك بدلًا من ذلك إنشاء رابط تنزيل مُخزَّن.",
        "الرابط المُخزَّن ذو معرفة صفرية: يشفّر المتصفح بـ AES-256-GCM قبل الرفع ولا يوجد المفتاح إلا في جزء URL. يتطلب الإنشاء تسجيل الدخول ويستهلك حصة وينتهي، ويمكن جعله لمرة واحدة إذ تُستهلك فرصته الوحيدة بمجرد أن يبدأ تنزيل باستقبال النص المشفّر. ويمكن لصفحة التنزيل بث ملف إلى القرص حتى في Firefox وSafari. للملفات الأكبر اختر الرابط أولًا: لا يلزم اتصال المستقبِل أثناء الرفع؛ أبقِ صفحة المُرسِل مفتوحة حتى يكتمل، وبعدها يمكن إغلاق صفحة المُرسِل ويستطيع المستقبِل الجلب في أي وقت قبل انتهاء الصلاحية، على أن يُكمل تنزيله هو حتى النهاية. استخدم المسار الحي عندما تكونان أمام الجهازين وتريدان الوصول الآن.",
      ],
      steps: [
        {
          text: "افتح صفحة النقل غير المتزامن وسجّل الدخول.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "اختر الملفات أو اسحبها إلى الداخل. الرقم المجاور للمنتقي هو سقف الملف الواحد النافذ لحسابك — قِس الملف الكبير عليه قبل أن تبدأ، لا بعد فشل الرفع.",
          code: ["اختر ملفات للرفع\nالحد الأقصى 512 MiB"],
        },
        {
          text: "اضبط «تنتهي صلاحيته خلال»، وفعّل «الحذف بعد القراءة (يُحذَف عند أول تنزيل)» إن كان لا ينبغي للملف أن يبقى بعد أول جلب له. وتُستهلك الفرصة الوحيدة بمجرد أن يبدأ تنزيل باستقبال النص المشفّر، لذا قد تستنفدها حتى محاولة لم تكتمل. والقائمة مُرشَّحة سلفًا إلى ما تسمح به باقتك، فالمدة غير الظاهرة قيدُ باقة لا خلل.",
          code: ["تنتهي صلاحيته خلال\nيوم واحد"],
        },
        {
          text: "اترك الصفحة مفتوحة أثناء التشفير والرفع. وعند الانتهاء يظهر الرابط ومعه تاريخ انتهاء صلاحيته تحته.",
          code: ["الرابط جاهز — أرسِله إلى المُستقبِل للتنزيل:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "أرسِل الرابط كاملًا. فكل ما بعد ‎#k=‎ هو مفتاح فكّ التشفير، ولا يصل إلى الخادم أبدًا، ورابط يأتي بلا ذلك الجزء لا يستطيع أحد فكّ تشفيره — بمن فيهم نحن.",
        },
      ],
      success: {
        label: "كيف يبدو رفع مكتمل",
        body: [
          "تعرض صفحتك الرابط، وتاريخ انتهاء الصلاحية الذي سيحفظه، والتنبيه بأن هذا تسليم مؤقت لا نسخة احتياطية. ومن تلك اللحظة لا يعتمد الرفع على بقاء صفحتك مفتوحة.",
          "وعلى جانب المُستقبِل يفتح الرابط صفحة التنزيل المشفَّرة بعدد الملفات وحجمها الإجمالي، وينتهي «تنزيل وفكّ تشفير» عند «اكتمل التنزيل ✓». ومكان حلول الملف قرار متصفحه، فقائمة تنزيلاته هي موضع التأكد.",
        ],
        code: ["رابط تنزيل مشفّر\nاكتمل التنزيل ✓"],
      },
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "يُرفض الرفع برسالة أن الملف يتجاوز حدّ حجم الملف الواحد.",
            code: ["https://relayium.com/offline-transfer   # يطبع المنتقي السقف بصيغة «الحد الأقصى <الحجم>»"],
            fix: "هذا السقف للملف الواحد لا للدفعة، فتقسيم تصدير بحجم 40 GB إلى أجزاء يتّسع كلٌّ منها هو المخرج — أو أرسِله فوريًا ما دمتما متصلين، فلا حدّ للحجم من جهة الخادم هناك لأن لا شيء يُخزَّن.",
          },
          {
            symptom: "سبب الرفض هو حصة اليوم لا حجم الملف.",
            code: ["https://relayium.com/offline-transfer   # رفض الحصة اليومية يُبلَّغ عنه في مسار الرفع"],
            fix: "حصة الرفع اليومية شيء آخر غير سقف الملف الواحد وغير التخزين، والذي يُبلّغ عنها هو مسار الرفع؛ أما https://relayium.com/me فيعرض استخدام الحساب الشهري لا ما تبقّى من الحصة اليومية لحظيًا. انتظر تعافي النافذة اليومية المتحرّكة مع خروج عمليات الرفع الأقدم منها، أو ارفع الباقة إن كان ذلك متاحًا لك، أو سلِّم الملف فوريًا ما دام الطرفان متصلين — فالنقل الفوري لا يخزّن شيئًا ولا يستهلك حصة رفع.",
          },
          {
            symptom: "قائمة انتهاء الصلاحية لا تعرض 7 أو 14 يومًا كما توقعت.",
            code: ["https://relayium.com/pricing   # مدة الاحتفاظ رقم يخصّ الباقة"],
            fix: "لا تعرض القائمة إلا المدد التي يسمح بها سقف الاحتفاظ في باقتك، ويطبّق الخادم السقف نفسه من جهته على سبيل الاحتياط، فلا يُقتطع خلسةً شيء مما يمكنك اختياره فعلًا. اختر أطول ما تعرضه، أو غيّر الباقة — فالذي يحكم هو السقف لا الملف.",
          },
          {
            symptom: "يقول الطرف الآخر إن الرابط غير صالح أو منتهي الصلاحية أو جرى تنزيله وحذفه بالفعل.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # رابط واحد ومعرّف واحد ومفتاح واحد"],
            fix: "تنتهي الثلاثة إلى الموضع نفسه: لم يبقَ شيء ليُجلَب. وإن كان «الحذف بعد القراءة» مفعَّلًا، فإن الفرصة الوحيدة تُستهلك بمجرد أن يبدأ تنزيل باستقبال النص المشفّر — فحتى محاولة انقطعت بعد وصول بعض البايتات تستهلكها، بينما محاولة لم تُسلِّم أي بايت تُعيدها. لذا ارفع الملف مرة أخرى وأرسِل رابطًا جديدًا، واترك خيار الحذف معطَّلًا حين يحتاجه أكثر من شخص.",
          },
          {
            symptom: "تقول صفحة التنزيل إن الطلبات كثيرة جدًا، أو إن حصة النقل الشهرية للمُرسِل استُنفدت.",
            code: ["https://relayium.com/me   # «استخدام هذا الشهر» يشمل النقل لا التخزين وحده"],
            fix: "الملف لا يزال موجودًا — فهذه مسألة قياس لا فقدان. انتظار دقائق يزيل تحديد المعدل، أما حصة النقل الشهرية المستنفدة فتحتاج إلى دخول شهر جديد أو ترقية أو عقدة خاصة بك، وفي الأثناء يتجاوز النقل الفوري ذلك كليًا.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "ما أكبر ملف يمكنني إرساله؟",
        a: "للملفات الكبيرة استخدم رابط التنزيل المخزّن؛ تُعرض حدود الملف والحصة قبل الرفع. لا حد من جهة الخادم للنقل الفوري، ويستطيع Chrome وEdge البث إلى القرص، لكن يجب إبقاء الصفحتين نشطتين. يحتفظ Firefox وSafari بالاستقبال الفوري في الذاكرة ويظهر تحذير نحو 256 ميغابايت — تقدير متحفّظ لا حد صارم.",
      },
      {
        q: "ماذا يحدث إذا قُوطِع النقل؟",
        a: "يمكن استئناف انقطاع قصير من نقطة محفوظة ما دامت الصفحتان نشطتين. إغلاق أو تحديث صفحة أو إنهاء جلسة التطبيق ينهي النقل الحي. مع الرابط المخزّن لا يلزم اتصال المستقبِل، لكن يجب إبقاء صفحة المُرسِل مفتوحة حتى يكتمل الرفع.",
      },
      {
        q: "كيف تُحمى خصوصيتي للملفات الكبيرة؟",
        a: "النقل الفوري مشفّر من الطرف إلى الطرف عبر X25519 وAES-256-GCM لكل كتلة، ولا يصل المفتاح إلى أي خادم. وعند تفعيل التحقّق المتقدّم (المعطَّل افتراضيًا) يعرض الجهازان رمزًا من 6 أرقام، ويُفحص كل ملف بـ SHA-256. يتصل WebRTC مباشرةً داخل شبكة LAN نفسها؛ وعبر الشبكات تستخدم المتصفحات TURN حسب التصميم، ولا يحمل المُرحِّل إلا نصًا مشفّرًا لا يستطيع قراءته أو فك تشفيره.",
      },
    ],
  },
  cta: {
    text: "انقل ملفك التالي بحجم عدة غيغابايت دون سحابة — اترك رابط تنزيل مشفّرًا، أو اربط الجهازين وأرسِله الآن. دون تثبيت، ودون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Cómo enviar archivos grandes sin la nube",
  description:
    "Para vídeos y archivos grandes, crea un enlace de descarga cifrado de extremo a extremo para recoger más tarde; el tiempo real queda como alternativa inmediata si ambos lados siguen en línea.",
  updatedLabel: "Última actualización",
  lead: [
    "Una exportación de vídeo de 20 GB o un pesado archivo de proyecto es justo donde el almacenamiento en la nube se siente más lento: subes el archivo entero una vez, esperas y luego la otra persona lo descarga de nuevo — dos transferencias completas más lo que permita tu cuota de almacenamiento. Para una entrega única, es mucho copiar y esperar por bytes que solo tenían que ir de A a B.",
    "Para un archivo grande, Relayium recomienda un enlace almacenado y cifrado de extremo a extremo: quien recibe no necesita estar en línea durante la subida y lo recoge después. Mantén abierta la página de envío hasta que termine; luego el enlace queda disponible hasta caducar. Si ambos pueden seguir en línea, el tiempo real es la alternativa inmediata: WebRTC directo en LAN o texto cifrado por TURN entre redes. El tiempo real no conserva copia de contenido ni historial en el servidor.",
  ],
  sections: [
    {
      heading: "Por qué el enlace almacenado es la opción predeterminada para archivos grandes",
      prereqs: {
        label: "Antes de empezar",
        items: [
          "Una cuenta conectada en el lado que envía. Crear un enlace de descarga almacenado la exige; quien abre el enlace no inicia sesión nunca.",
          "Margen en dos límites distintos: el techo por archivo que la página de subida imprime junto al selector, y la cuota de almacenamiento de tu plan. Los dos se leen en la página en vez de suponerlos.",
          "Una ventana de retención con la que puedas vivir. La lista de caducidad solo ofrece lo que tu plan permite, y el servidor aplica ese mismo tope por su lado como defensa, así que la ventana que puedes elegir es la que obtienes; ninguno de estos enlaces es una copia de seguridad.",
          "La página de envío abierta hasta que la subida termine. Después el enlace se sostiene solo hasta caducar y quien envía puede cerrar el portátil; quien recibe todavía tiene que dejar que su propia descarga llegue al final.",
        ],
      },
      body: [
        "Un enlace de Relayium almacena solo el texto cifrado creado en el navegador. Quien recibe puede estar desconectado durante la subida y recogerlo después; una vez terminada, cerrar la página de envío no elimina el enlace. Los límites mostrados son el máximo por archivo, la cuota y la caducidad.",
        "El tiempo real es la alternativa cuando ambos están listos ahora. WebRTC conecta directamente y sin cuenta en la misma LAN; entre redes TURN transporta el cifrado de extremo a extremo y quien crea el código inicia sesión. Ambas páginas deben seguir activas, así que sirve mejor para archivos pequeños y texto que para una entrega grande y larga.",
      ],
    },
    {
      heading: "Sin límite de tamaño en modo en tiempo real",
      body: [
        "Las transferencias en tiempo real no tienen límite de almacenamiento del lado del servidor porque Relayium no conserva una copia del contenido. Un retransmisor TURN puede transportar texto cifrado entre redes mientras ambos lados están conectados, pero no puede leerlo, descifrarlo ni guardarlo como historial. El tope práctico lo fija el navegador que recibe.",
        "Chrome y Edge pueden transmitir un archivo en tiempo real directamente al disco, así que el protocolo puede llevar técnicamente decenas de gigabytes. No es la recomendación predeterminada para archivos grandes: la sesión viva aún exige ambas páginas activas. Un lote admite hasta 1.000 archivos, cada uno verificado con SHA-256.",
      ],
      bullets: [
        "Chrome o Edge en el ordenador que recibe: los archivos se transmiten directamente al disco, así que prácticamente no hay límite de tamaño.",
        "Firefox y Safari no tienen la API File System Access, así que ahí un lote recibido en tiempo real se mantiene en memoria — Relayium avisa por encima de unos 256 MB, una estimación deliberadamente prudente y no un límite duro.",
        "Hasta 1.000 archivos por lote, cada uno verificado con su propio hash SHA-256 al llegar.",
      ],
    },
    {
      heading: "Reanudar en lugar de empezar de nuevo",
      body: [
        "Una caída breve del transporte puede reanudarse desde un punto guardado mientras ambas páginas vivas sigan activas. Cerrar o recargar una página, o terminar la sesión de la app, finaliza la transferencia viva. Es otra razón para preferir el enlace almacenado con archivos grandes.",
        "La conectividad se maneja de la misma forma. Dentro de una misma red la transferencia va directamente de dispositivo a dispositivo; entre redes, el flujo cifrado viaja por un retransmisor TURN. El retransmisor solo ve texto cifrado, así que esa vía también sigue cifrada de extremo a extremo.",
      ],
    },
    {
      heading: "Envía ahora, o deja un enlace para después",
      body: [
        "La transferencia en tiempo real necesita a ambas personas en línea al mismo tiempo, lo cual es ideal cuando puedes coordinarte. Si la otra persona no está disponible ahora mismo, puedes crear un enlace de descarga almacenado.",
        "Un enlace almacenado es de conocimiento cero: el navegador cifra con AES-256-GCM antes de subir y la clave solo vive en el fragmento de la URL. Crearlo exige iniciar sesión, consume cuota y caduca (o puede ser de un solo uso: su única plaza se gasta en cuanto una descarga empieza a recibir texto cifrado). La descarga puede transmitir al disco incluso en Firefox y Safari. Para los archivos más grandes elige primero el enlace: quien recibe no necesita estar en línea durante la subida; mantén abierta la página de envío hasta terminar y después esa página puede cerrarse y quien recibe lo recoge en cualquier momento antes de caducar, aunque su propia descarga sí tiene que llegar al final. Usa la vía viva cuando ambos estén delante del ordenador y quieran recibir ya.",
      ],
      steps: [
        {
          text: "Abre la página de transferencia asíncrona e inicia sesión.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Elige los archivos, o arrástralos. La cifra junto al selector es el techo por archivo vigente para tu cuenta: compara el archivo grande con ella antes de empezar, y no después de que falle la subida.",
          code: ["Elige archivos para subir\nMáx. 512 MiB"],
        },
        {
          text: "Ajusta «Caduca en» y activa «Destrucción tras la lectura (eliminar en la primera descarga)» si el archivo no debe sobrevivir a su primera recogida. La única plaza se gasta en cuanto una descarga empieza a recibir texto cifrado, así que hasta un intento que no termina puede agotarla. La lista ya está filtrada a lo que tu plan permite, así que una ventana que no ves es un límite de plan y no un fallo.",
          code: ["Caduca en\n1 día"],
        },
        {
          text: "Deja la página abierta mientras cifra y sube. Al terminar aparece el enlace, con su fecha de caducidad debajo.",
          code: ["Enlace listo — envíaselo al destinatario para que descargue:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "Envía el enlace completo. Todo lo que sigue a #k= es la clave de descifrado, nunca llega al servidor, y un enlace que llega sin ese fragmento no lo puede descifrar nadie, nosotros incluidos.",
        },
      ],
      success: {
        label: "Qué se ve al terminar la subida",
        body: [
          "Tu página muestra el enlace, la fecha de caducidad que mantendrá y el recordatorio de que esto es una entrega temporal y no una copia de seguridad. Desde ese momento la subida ya no depende de que tu página siga abierta.",
          "En el lado del destinatario, el enlace abre la página de descarga cifrada con el número de archivos y el tamaño total, y «Descargar y descifrar» acaba en «Descarga completada ✓». Dónde aterriza el archivo lo decide su navegador, así que su lista de descargas es el lugar donde confirmarlo.",
        ],
        code: ["Enlace de descarga cifrado\nDescarga completada ✓"],
      },
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "La subida se rechaza porque el archivo supera el límite de tamaño por archivo.",
            code: ["https://relayium.com/offline-transfer   # el selector imprime el techo como Máx. <tamaño>"],
            fix: "Ese techo es por archivo y no por lote, así que partir una exportación de 40 GB en trozos que quepan es la salida — o envíalo en tiempo real mientras los dos estáis en línea, donde no hay límite de tamaño en el servidor porque no se almacena nada.",
          },
          {
            symptom: "El rechazo es por la cuota de hoy y no por el tamaño del archivo.",
            code: ["https://relayium.com/offline-transfer   # el rechazo por cuota diaria lo informa el flujo de subida"],
            fix: "La cuota diaria de subida es distinta del techo por archivo y del almacenamiento, y quien la informa es el flujo de subida: https://relayium.com/me muestra el uso mensual de la cuenta, no lo que queda de la cuota diaria. Espera a que la ventana diaria móvil se recupere según van saliendo de ella las subidas más antiguas, cambia de plan si lo tienes disponible, o entrega el archivo en tiempo real mientras los dos lados están en línea: una transferencia en tiempo real no almacena nada y por eso no gasta cuota de subida.",
          },
          {
            symptom: "La lista de caducidad no ofrece los 7 o 14 días que esperabas.",
            code: ["https://relayium.com/pricing   # la retención es una cifra por plan"],
            fix: "La lista solo muestra ventanas que el tope de retención de tu plan permite, y el servidor aplica ese mismo tope por su lado como defensa, así que nada de lo que puedes elegir se acorta a tus espaldas. Elige la más larga que ofrezca, o cambia de plan: lo que decide es el tope y no el archivo.",
          },
          {
            symptom: "El destinatario dice que el enlace no es válido, ha caducado, o ya se descargó y se eliminó.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # un enlace, un id, una clave"],
            fix: "Las tres cosas acaban en el mismo punto: no queda nada que recoger. Si «Destrucción tras la lectura» estaba activada, la única plaza se gasta en cuanto una descarga empieza a recibir texto cifrado: un intento que se cortó a medias pero recibió algún byte también la consume, mientras que uno que no entregó nada la libera. Vuelve a subirlo y manda un enlace nuevo, y deja esa opción apagada cuando más de una persona necesite el archivo.",
          },
          {
            symptom: "La página de descarga dice que hay demasiadas peticiones, o que la transferencia mensual del remitente está agotada.",
            code: ["https://relayium.com/me   # el uso de este mes cubre la transferencia, no solo el almacenamiento"],
            fix: "El archivo sigue ahí: esto es medición y no pérdida. Esperar unos minutos levanta un límite de tasa, mientras que una transferencia mensual agotada necesita el cambio de mes, un cambio de plan o tu propio nodo, y entretanto una transferencia en tiempo real lo esquiva por completo.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Cuál es el archivo más grande que puedo enviar?",
        a: "Para archivos grandes usa el enlace almacenado; el máximo y la cuota aparecen antes de subir. El tiempo real no tiene límite del lado del servidor y Chrome/Edge puede transmitir al disco, pero ambas páginas deben seguir activas. Firefox/Safari mantiene una recepción en tiempo real en memoria y avisa cerca de 256 MB — una estimación prudente, no un límite rígido.",
      },
      {
        q: "¿Qué pasa si la transferencia se interrumpe?",
        a: "Una caída breve puede reanudarse desde un punto guardado mientras ambas páginas sigan activas. Cerrar o recargar una página, o terminar la sesión de la app, finaliza la transferencia viva. Con el enlace almacenado quien recibe puede estar desconectado, pero la página de envío debe seguir abierta hasta que termine la subida.",
      },
      {
        q: "¿Cómo se protege mi privacidad con archivos grandes?",
        a: "Las transferencias en tiempo real usan X25519 y AES-256-GCM por bloque de extremo a extremo; la clave no llega a ningún servidor. Con la verificación avanzada activada (desactivada por omisión), ambos dispositivos muestran un código de 6 dígitos, y cada archivo se verifica con SHA-256. WebRTC es directo en la misma LAN; entre redes, los navegadores usan TURN por diseño y el retransmisor solo transporta texto cifrado que no puede leer ni descifrar.",
      },
    ],
  },
  cta: {
    text: "Mueve tu próximo archivo de varios gigabytes sin la nube — deja un enlace de descarga cifrado, o conecta ambos dispositivos y envíalo ahora. Sin instalación, y sin necesidad de cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Como enviar arquivos grandes sem a nuvem",
  description:
    "Para vídeos e arquivos grandes, crie um link de download criptografado de ponta a ponta para pegar depois; o tempo real fica como alternativa imediata se os dois lados permanecerem online.",
  updatedLabel: "Última atualização",
  lead: [
    "Uma exportação de vídeo de 20 GB ou um arquivo de projeto pesado é exatamente onde o armazenamento em nuvem parece mais lento: você faz upload do arquivo inteiro uma vez, espera e a outra pessoa faz o download de novo — duas transferências completas mais o que sua cota de armazenamento permitir. Para uma entrega única, é muita cópia e espera por bytes que só precisavam ir de A para B.",
    "Para um arquivo grande, o Relayium recomenda um link armazenado e criptografado de ponta a ponta: quem recebe não precisa estar online durante o upload e pega depois. Mantenha a página de envio aberta até terminar; depois o link fica disponível até expirar. Se os dois puderem continuar online, o tempo real é a alternativa imediata: WebRTC direto na LAN ou texto cifrado pelo TURN entre redes. O tempo real não mantém cópia de conteúdo nem histórico no servidor.",
  ],
  sections: [
    {
      heading: "Por que o link armazenado é o padrão para arquivos grandes",
      prereqs: {
        label: "Antes de começar",
        items: [
          "Uma conta conectada no lado que envia. Criar um link de download armazenado exige uma; quem abre o link nunca faz login.",
          "Folga em dois limites separados: o teto por arquivo que a página de upload imprime ao lado do seletor, e a cota de armazenamento do seu plano. Os dois se leem na página em vez de serem adivinhados.",
          "Um prazo de retenção com que você consiga viver. A lista de expiração só oferece o que o seu plano permite, e o servidor aplica o mesmo teto do lado dele por precaução, então o prazo que você consegue escolher é o que você recebe; e nenhum desses links é backup.",
          "A página de envio mantida aberta até o upload terminar. Depois disso o link se sustenta sozinho até expirar e quem envia pode fechar o notebook; quem recebe ainda precisa deixar o próprio download ir até o fim.",
        ],
      },
      body: [
        "Um link do Relayium armazena apenas o texto cifrado criado no navegador. Quem recebe pode ficar offline durante o upload e pegar depois; quando o upload termina, fechar a página de envio não remove o link. Os limites mostrados são o máximo por arquivo, a cota e a validade.",
        "O tempo real é a alternativa quando os dois estão prontos agora. O WebRTC conecta direto e sem conta na mesma LAN; entre redes, o TURN transporta a criptografia de ponta a ponta e quem cria o código entra. As duas páginas precisam ficar ativas, então esse modo serve melhor para arquivos pequenos e texto do que para uma entrega grande e demorada.",
      ],
    },
    {
      heading: "Sem limite de tamanho no modo em tempo real",
      body: [
        "As transferências em tempo real não têm limite de armazenamento do lado do servidor porque o Relayium não mantém uma cópia do conteúdo. Um retransmissor TURN pode transportar texto cifrado entre redes enquanto os dois lados estão online, mas não consegue ler, descriptografar ou guardá-lo como histórico. O teto prático é definido pelo navegador que recebe.",
        "Chrome e Edge podem transmitir um arquivo em tempo real direto para o disco, então o protocolo pode carregar tecnicamente dezenas de gigabytes. Isso não é a recomendação padrão para arquivos grandes: a sessão ao vivo ainda exige as duas páginas ativas. Um lote aceita até 1.000 arquivos, cada um verificado com SHA-256.",
      ],
      bullets: [
        "Chrome ou Edge no computador que recebe: os arquivos são transmitidos direto para o disco, então praticamente não há limite de tamanho.",
        "Firefox e Safari não têm a API File System Access, então neles um lote recebido em tempo real fica na memória — o Relayium avisa acima de cerca de 256 MB, uma estimativa propositalmente conservadora e não um limite rígido.",
        "Até 1.000 arquivos por lote, cada um conferido com seu próprio hash SHA-256 na chegada.",
      ],
    },
    {
      heading: "Retomar em vez de recomeçar",
      body: [
        "Uma queda breve do transporte pode retomar de um ponto salvo enquanto as duas páginas ao vivo continuam ativas. Fechar ou recarregar uma página, ou encerrar a sessão do app, termina a transferência ao vivo. É outro motivo para preferir o link armazenado em arquivos grandes.",
        "A conectividade é tratada da mesma forma. Dentro de uma mesma rede a transferência vai direto de dispositivo para dispositivo; entre redes, o fluxo criptografado viaja por um retransmissor TURN. O retransmissor só vê texto cifrado, então esse caminho também permanece criptografado de ponta a ponta.",
      ],
    },
    {
      heading: "Envie agora ou deixe um link para depois",
      body: [
        "A transferência em tempo real precisa das duas pessoas online ao mesmo tempo, o que é ideal quando dá para coordenar. Se a outra pessoa não estiver disponível agora, você pode criar um link de download armazenado.",
        "Um link armazenado é de conhecimento zero: o navegador criptografa com AES-256-GCM antes do upload e a chave só fica no fragmento da URL. Criá-lo exige login, usa cota e expira (ou pode ser de uso único: a vaga dele é gasta assim que um download começa a receber o texto cifrado). O download pode transmitir ao disco até no Firefox e Safari. Para os maiores arquivos escolha primeiro o link: quem recebe não precisa estar online durante o upload; mantenha a página de envio aberta até terminar e depois essa página pode fechar e quem recebe pega o arquivo a qualquer momento antes de expirar — mas o download dele ainda precisa ir até o fim. Use o caminho ao vivo quando os dois estiverem diante do computador e quiserem receber agora.",
      ],
      steps: [
        {
          text: "Abra a página de transferência assíncrona e faça login.",
          code: ["https://relayium.com/offline-transfer"],
        },
        {
          text: "Escolha os arquivos, ou arraste-os. O número ao lado do seletor é o teto por arquivo vigente para a sua conta — compare o arquivo grande com ele antes de começar, e não depois de o upload falhar.",
          code: ["Escolher arquivos para enviar\nMáx. 512 MiB"],
        },
        {
          text: "Defina “Expira em” e ligue “Autodestruição após a leitura (excluir no primeiro download)” se o arquivo não deve sobreviver à primeira retirada. A vaga única é gasta assim que um download começa a receber o texto cifrado, então até uma tentativa que não termina pode consumi-la. A lista já vem filtrada pelo que o seu plano permite, então um prazo que você não vê é limite de plano e não defeito.",
          code: ["Expira em\n1 dia"],
        },
        {
          text: "Deixe a página aberta enquanto ela criptografa e envia. Ao terminar, o link aparece com a data de expiração embaixo dele.",
          code: ["Link pronto — envie-o ao destinatário para ele baixar:\nhttps://relayium.com/d/8f3c2a1b#k=hQ2r…"],
        },
        {
          text: "Envie o link inteiro. Tudo depois de #k= é a chave de descriptografia, ela nunca chega ao servidor, e um link que chega sem esse fragmento não pode ser descriptografado por ninguém — inclusive por nós.",
        },
      ],
      success: {
        label: "Como é um upload concluído",
        body: [
          "Sua página mostra o link, a data de expiração que ele vai manter e o aviso de que isto é entrega temporária e não backup. A partir desse momento o upload não depende mais de a sua página ficar aberta.",
          "No lado de quem recebe, o link abre a página de download criptografado com a quantidade de arquivos e o tamanho total, e “Baixar e descriptografar” termina em “Download concluído ✓”. Onde o arquivo cai é decisão do navegador dele, então a lista de downloads dele é o lugar de confirmar.",
        ],
        code: ["Link de download criptografado\nDownload concluído ✓"],
      },
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O upload é recusado porque o arquivo passa do limite de tamanho por arquivo.",
            code: ["https://relayium.com/offline-transfer   # o seletor imprime o teto como Máx. <tamanho>"],
            fix: "Esse teto é por arquivo e não por lote, então quebrar uma exportação de 40 GB em partes que caibam é o caminho — ou envie em tempo real enquanto os dois estão online, onde não existe limite de tamanho no servidor porque nada é armazenado.",
          },
          {
            symptom: "A recusa é pela cota do dia e não pelo tamanho do arquivo.",
            code: ["https://relayium.com/offline-transfer   # a recusa por cota diária é informada pelo fluxo de upload"],
            fix: "A cota diária de upload é diferente do teto por arquivo e do armazenamento, e quem informa é o fluxo de upload: https://relayium.com/me mostra o uso mensal da conta, não o que sobrou da cota diária. Espere a janela diária móvel se recuperar conforme os uploads mais antigos saem dela, mude de plano se isso estiver disponível para você, ou entregue o arquivo em tempo real enquanto os dois lados estão online: uma transferência em tempo real não armazena nada e por isso não gasta cota de upload.",
          },
          {
            symptom: "A lista de expiração não oferece os 7 ou 14 dias que você esperava.",
            code: ["https://relayium.com/pricing   # a retenção é um número por plano"],
            fix: "A lista só mostra prazos que o teto de retenção do seu plano permite, e o servidor aplica esse mesmo teto do lado dele por precaução, então nada que você consegue escolher é encurtado sem você saber. Escolha o maior oferecido, ou mude de plano: o que decide é o teto, não o arquivo.",
          },
          {
            symptom: "Quem recebe diz que o link é inválido, expirou, ou já foi baixado e excluído.",
            code: ["https://relayium.com/d/8f3c2a1b#k=hQ2r…   # um link, um id, uma chave"],
            fix: "Os três terminam no mesmo ponto: não há mais nada para buscar. Se “Autodestruição após a leitura” estava ligada, a vaga única é gasta assim que um download começa a receber o texto cifrado: uma tentativa que caiu no meio mas recebeu alguns bytes também a consome, enquanto uma que não entregou nada a devolve. Envie de novo e mande um link novo, e deixe essa opção desligada quando mais de uma pessoa precisar do arquivo.",
          },
          {
            symptom: "A página de download diz que há pedidos demais, ou que a transferência mensal de quem enviou acabou.",
            code: ["https://relayium.com/me   # o uso deste mês cobre transferência, não só armazenamento"],
            fix: "O arquivo continua lá — isto é medição e não perda. Esperar alguns minutos libera um limite de taxa, enquanto uma transferência mensal esgotada precisa da virada do mês, de uma troca de plano ou do seu próprio nó, e nesse meio-tempo uma transferência em tempo real contorna isso por completo.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Qual é o maior arquivo que posso enviar?",
        a: "Para arquivos grandes use o link armazenado; o máximo e a cota aparecem antes do upload. O tempo real não tem limite no servidor e Chrome/Edge pode transmitir ao disco, mas as duas páginas precisam continuar ativas. Firefox/Safari mantém uma recepção em tempo real na memória e avisa perto de 256 MB — uma estimativa conservadora, não um limite rígido.",
      },
      {
        q: "O que acontece se a transferência for interrompida?",
        a: "Uma queda breve pode retomar de um ponto salvo enquanto as duas páginas continuam ativas. Fechar ou recarregar uma página, ou encerrar a sessão do app, termina a transferência ao vivo. No link armazenado quem recebe pode ficar offline, mas a página de envio deve permanecer aberta até o upload terminar.",
      },
      {
        q: "Como minha privacidade é protegida em arquivos grandes?",
        a: "As transferências em tempo real usam X25519 e AES-256-GCM por bloco de ponta a ponta; a chave não chega a nenhum servidor. Com a verificação avançada ativada (desligada por padrão), os dois dispositivos mostram um código de 6 dígitos, e cada arquivo é verificado com SHA-256. O WebRTC é direto na mesma LAN; entre redes, os navegadores usam TURN por design e o retransmissor só transporta texto cifrado que não consegue ler nem descriptografar.",
      },
    ],
  },
  cta: {
    text: "Mova seu próximo arquivo de vários gigabytes sem a nuvem — deixe um link de download criptografado, ou conecte os dois aparelhos e envie agora. Sem instalação e sem precisar de conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/send-large-files-without-cloud",
  published: "2026-07-03",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
