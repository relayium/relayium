// web/scripts/pages/content/articles/howto-airdrop-for-windows-android.mjs
// How-to: the AirDrop-equivalent experience for Windows, Linux and Android
// (and mixed Apple/non-Apple fleets). English is the master; zh/ja/ko/de/fr
// follow the same structure with identical facts. Terminology mirrors
// src/lib/i18n/en.ts and content/landing.mjs. Distinct from compare/airdrop
// (a head-to-head comparison) — this is the "AirDrop equivalent for X" intent,
// so it cross-links that piece instead of repeating its comparison table.

const en = {
  title: "AirDrop for Windows, Linux and Android",
  description:
    "There is no official AirDrop for Windows, Linux or Android — here is the closest thing: instant same-Wi-Fi sharing in the browser, no account, no install, plus a way to reach across the internet AirDrop can't.",
  updatedLabel: "Last updated",
  lead: [
    "AirDrop only exists inside Apple's world, which leaves everyone else — Windows, Linux, Android, and any household with a mix of devices — without a built-in equivalent. This guide shows the closest thing to AirDrop for non-Apple devices: open a web page on both ends and the file just moves.",
    "It works the same way regardless of platform, so it also covers the case AirDrop never handles well: a Windows laptop, a Linux desktop and an Android phone all in the same room, or all three plus an iPhone thrown in.",
  ],
  sections: [
    {
      heading: "The AirDrop-like flow: same Wi-Fi, in the browser",
      body: [
        "This is the everyday case AirDrop is built for, and Relayium matches it without needing an app from any store.",
      ],
      prereqs: {
        label: "What you need",
        items: [
          "A current browser on each device — Chrome or Edge on Windows, Firefox or Chrome on Linux, Chrome on Android. Nothing from a store, nothing to install.",
          "Both devices on the same Wi-Fi. Unlike AirDrop, being next to each other is not the criterion: discovery groups devices by the public IP they connect from, so a phone still on mobile data will not appear even sitting on the same desk.",
          "Working internet access on both, with the page open over https://relayium.com/. AirDrop needs no internet at all; these browsers do need to reach the rendezvous to find each other, so an isolated LAN calls for a self-hosted instance instead.",
          "No account and no pairing code for the same-network case — that is the part this flow shares with AirDrop.",
        ],
      },
      steps: [
        {
          text: "On each device, open the transfer page in the browser.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compare the public IP in the status pill on both. One shared address is what makes the two devices visible to each other, and it is the fastest way to catch the phone that never left mobile data.",
          code: ["Connected · this device ThinkPad · public IP 203.0.113.9"],
        },
        {
          text: "On the sending device, find the other one under “Nearby devices”, choose its card and press “Open workspace”. On a current browser that is the single action a card offers, because files, folders and messages then all travel over the one encrypted connection it opens. A room can list several devices; opening a workspace is how you pick the one recipient this transfer goes to, and you open another one when the next person's turn comes.",
        },
        {
          text: "The workspace replaces that card. Send from the controls under its header: “Send files” for a batch of up to 1,000, “Send a folder” for a whole tree where the browser offers folder picking, or type into the message box — “Enter for a new line · ⌘/Ctrl+Enter to send” — and press “Send”. On the receiving device, read the line under the request before you accept — it says whether the browser will ask where to save or write to its own Downloads — then press “Accept”. To compare a verification code (SAS) first, turn on “Advanced verification” on both devices before you start.",
        },
      ],
      success: {
        label: "What a working transfer looks like",
        body: [
          "The other device's card is gone by then — the workspace took its place — so read the state off the workspace header: the device you are connected to, a link state of “Connected”, and one path badge reading “LAN direct”. The file counter runs to the last file of the batch on both screens.",
          "How a folder lands depends on the receiving browser, so check the result rather than assuming it: desktop Chrome and Edge write the tree into the directory you picked, while Firefox, Safari and every phone browser hand you one .zip that unpacks to the same structure. That browser's own downloads list is where you confirm it — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
        code: ["Connected to Pixel · Connected · LAN direct\nFile 8/8"],
      },
    },
    {
      heading: "When the other device doesn't appear",
      body: [
        "Start where this flow differs from AirDrop: what makes two devices visible to each other is the network they connect from, not how close they are. The checks below are the common first ones rather than an exhaustive list, and each reads its answer off the page instead of guessing.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The other device is right next to you and still does not show up under “Nearby devices”.",
            code: ["https://relayium.com/   # compare the public IP in the status pill on both devices"],
            fix: "Two different public IP addresses mean two rooms, and proximity does nothing for it. Put both devices on the same Wi-Fi and switch mobile data off on the phone. A VPN or iCloud Private Relay on either side is another common reason for two addresses; if you are willing to change them, switch the VPN off or turn Private Relay off for that one network and reload https://relayium.com/ there. If you would rather leave them on, a pairing code on https://relayium.com/cross-network reaches the other device without touching either setting.",
          },
          {
            symptom: "Both devices show the same public IP and neither card appears.",
            code: ["https://relayium.com/   # the hint under the device list names the router setting"],
            fix: "The router is separating its own clients. Turn off “AP isolation / client isolation” in its Wi-Fi settings, or use a pairing code on https://relayium.com/cross-network when the router is not yours to change.",
          },
          {
            symptom: "The page itself does not load on a network with no internet access.",
            code: ["https://relayium.com/   # if this never loads, the network has no route to the rendezvous"],
            fix: "This is the real gap against AirDrop, which needs no internet at all. Two browsers still need to reach the rendezvous to introduce themselves, so on an air-gapped LAN run your own instance on that network — Relayium is AGPL-3.0 at github.com/relayium/relayium — or fall back to a USB stick.",
          },
          {
            symptom: "The receiving side warns, before you accept, that the batch has to be held in memory.",
            code: ["chrome://downloads   # in Chrome; Edge has edge://downloads and Firefox about:downloads"],
            fix: "Firefox, Safari and every phone browser lack the File System Access API, so they assemble the batch in memory and Relayium warns past roughly 256 MiB. Receive it in Chrome or Edge on a computer, or send fewer files at a time, then check each arrival in that browser's own downloads list rather than assuming it saved — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
          },
          {
            symptom: "A folder arrived as a single .zip instead of a folder.",
            code: ["chrome://downloads   # in Chrome; the entry is one .zip when the browser had no directory picker"],
            fix: "That is the expected result in a browser without the directory picker, and the archive unpacks to the same structure with the relative paths intact. Unzip it, or receive the same folder in desktop Chrome or Edge, which asks for a target directory and writes the tree into it in place.",
          },
        ],
      },
    },
    {
      heading: "Across the internet: something AirDrop can't do",
      body: [
        "AirDrop is nearby-only — walk out of Bluetooth/Wi-Fi range and it stops working. Relayium's second mode covers exactly that gap: two devices on completely different networks, anywhere in the world. It is a separate surface from a nearby-device workspace, though: a pairing-code room keeps the earlier per-device controls, so there is no “Open workspace” to press there.",
        "The sender signs in and gets a short pairing code (with a join link and a QR code); the receiver enters it, or scans the QR, or opens the link — and never needs an account. That cross-network connection runs over an encrypted TURN relay rather than a direct link, and it does so by design: it takes the relay from the start, so the connection does not depend on discovering a direct path through the NATs and firewalls between two unrelated networks, which can prevent one. The files are sealed end-to-end before they leave the sender, so the relay only ever forwards ciphertext it has no key to open — the whole route stays end-to-end encrypted. A dropped connection can resume instead of restarting from zero. The code is good for five minutes, so have both devices in front of you before you generate one.",
      ],
    },
    {
      heading: "What's actually protecting the file",
      body: [
        "Both modes above are realtime transfers, and both use the same encryption: an X25519 key exchange derives a key used for per-chunk AES-256-GCM, negotiated only between the two devices. Turn on advanced verification (off by default) and both sides display the same 6-digit verification code (a Short Authentication String) so you can verify that the derived key was not replaced: the signalling server or a TURN relay has not impersonated either endpoint or terminated the application-layer end-to-end encryption. On cross-network transfers, TURN still remains in the data path, but it carries only ciphertext and is not an encryption endpoint. Each file is checked end-to-end with a SHA-256 hash.",
        "Nothing is stored on a server in this mode — it exists only for the duration of the transfer. Relayium is open source under the AGPL-3.0 license at github.com/relayium/relayium, so the mechanics are auditable rather than a black box.",
      ],
    },
    {
      heading: "The practical limits, honestly",
      body: [
        "Because the file never lands on a server, there's no upload quota — the real limit is which browser is receiving. A desktop browser with the File System Access API (Chrome or Edge on Windows or Linux) streams incoming data straight to disk, so multi-gigabyte files are fine. Firefox, Safari and every phone browser — Chrome on Android included — don't have that API, so there the batch is assembled in memory instead, and Relayium warns the receiver before they accept once it passes roughly 256 MB. Read that as a deliberately cautious estimate rather than a hard ceiling: where it actually gives out depends on the device's memory, its OS and how many tabs are open.",
        "Folders work too: pick a folder on desktop (not iOS) and relative paths are preserved. If the receiving browser can write straight to a chosen directory (desktop Chrome or Edge) files land in place; otherwise (Firefox, Safari, any phone browser) the whole folder arrives as one .zip that unpacks to the same structure.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is there an official AirDrop app for Windows or Android?",
        a: "No — AirDrop is exclusive to Apple devices and Apple has never shipped a Windows or Android client. Relayium is a browser-based equivalent: open relayium.com on both devices and it works the same way regardless of platform, including mixed Apple/non-Apple pairs.",
      },
      {
        q: "Do I need an account?",
        a: "Not for the same-Wi-Fi flow — open the page on both devices and they discover each other, no sign-in at all. Sending across different networks with a pairing code requires the sender to sign in; the person receiving never needs an account, on either network mode.",
      },
      {
        q: "Do I need to install anything?",
        a: "No. It's a web page on every platform — Windows, Linux, macOS, Android and iOS — so there's nothing to download from a store and nothing to keep updated.",
      },
      {
        q: "How is this different from the Relayium vs AirDrop comparison?",
        a: "That article is a head-to-head look at where AirDrop is genuinely better (pure-Apple households) and where it falls short. This guide is the how-to for actually getting the AirDrop-like experience when at least one device isn't an Apple one.",
      },
      {
        q: "Can it send to a group, like AirDrop can?",
        a: "Not in one shot. The local room isn't limited to two devices, so every nearby device that opened the page is listed at once — but a transfer is one-to-one: you open a workspace with one recipient, and that is who those files go to. Sharing the same batch with several people in the room means opening a workspace with each of them in turn. The pairing-code mode for across-the-internet sending joins exactly two devices, over an encrypted relay.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on your Windows, Linux or Android device and the one you're sending to — no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Windows、Linux、Android 的隔空投送替代方案",
  description:
    "Windows、Linux、Android 都没有官方版 AirDrop——这是最接近的做法：在浏览器里同一 Wi-Fi 即时互传，无需账号、无需安装，还能做到 AirDrop 做不到的跨网络传输。",
  updatedLabel: "最近更新",
  lead: [
    "AirDrop 只活在 Apple 的世界里，这让 Windows、Linux、Android 用户，以及任何混用多种设备的家庭都没有对应的内置方案。本文展示非 Apple 设备最接近 AirDrop 的做法：两端各打开一个网页，文件就传过去了。",
    "这种方式不区分平台，因此也覆盖了 AirDrop 一向处理不好的场景：同一个房间里有 Windows 笔记本、Linux 台式机和 Android 手机，或者这三者再加一台 iPhone。",
  ],
  sections: [
    {
      heading: "类 AirDrop 流程：同一 Wi-Fi，浏览器内完成",
      body: [
        "这正是 AirDrop 为之设计的日常场景，而 Relayium 无需从任何应用商店下载 App 就能做到同样效果。",
      ],
      prereqs: {
        label: "你需要准备",
        items: [
          "每台设备上都有一个较新的浏览器——Windows 上用 Chrome 或 Edge，Linux 上用 Firefox 或 Chrome，Android 上用 Chrome。不用去应用商店，也没有要安装的东西。",
          "两台设备在同一个 Wi-Fi 里。和 AirDrop 不同，判断依据不是「挨得近」：设备发现是按连接过来的公网 IP 分组的，所以一台还挂在移动数据上的手机，即使摆在同一张桌子上也不会出现。",
          "两台都能正常联网，并且是通过 https://relayium.com/ 打开页面。AirDrop 完全不需要互联网；而这两个浏览器确实需要连上会合服务器才能找到彼此，所以完全隔离的局域网应改用自托管实例。",
          "同网络场景下不需要账号，也不需要配对码——这正是这套流程和 AirDrop 相同的地方。",
        ],
      },
      steps: [
        {
          text: "在每台设备上用浏览器打开传输页面。",
          code: ["https://relayium.com/"],
        },
        {
          text: "对比两台设备上状态条里的公网 IP。共享同一个地址才能让两台设备互相可见，而这也是最快识别出「那台手机根本没离开移动数据」的办法。",
          code: ["已连接 · 本机 ThinkPad · 公网 IP 203.0.113.9"],
        },
        {
          text: "在发送方设备上，于「附近的设备」里找到另一台，选中它的卡片，然后按「打开工作区」。在当前浏览器上，这是卡片提供的唯一一个动作——因为接下来文件、文件夹和消息都走它打开的那一条加密连接。房间里可能列出好几台设备；打开工作区正是你挑定这次传输的那一个接收方的方式，轮到下一个人时再开一个。",
        },
        {
          text: "工作区会取代那张卡片。发送用它标题栏下面的控件：「发送文件」发一批（最多 1,000 个），浏览器支持选目录时用「发送文件夹」发整棵树，或者直接在消息框里打字——「回车换行 · ⌘/Ctrl+回车发送」——然后按「发送」。在接收方设备上，先看请求下面那行再决定接收——它会说明浏览器是要问你存到哪，还是直接写进它自己的下载目录——然后按「接收」。如果想先核对校验码（SAS），开始前在两台设备上打开「高级验证」。",
        },
      ],
      success: {
        label: "传输成功时是什么样",
        body: [
          "这时对方设备的卡片已经不在了——工作区取代了它——所以状态要从工作区标题栏上读：你连到了哪台设备、连接状态是「已连接」，以及唯一一个路径标签显示「局域网直连」。两块屏幕上的文件计数都走到这一批的最后一个文件。",
          "文件夹以什么形式落地取决于接收方浏览器，所以要看结果而不要想当然：电脑上的 Chrome 和 Edge 会把目录树写进你挑好的目录，而 Firefox、Safari 和所有手机浏览器会给你一个 .zip，解开后是同样的结构。确认这一点要看那个浏览器自己的下载列表——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
        ],
        code: ["已连接到 Pixel · 已连接 · 局域网直连\n文件 8/8"],
      },
    },
    {
      heading: "另一台设备没有出现时",
      body: [
        "先从这套流程与 AirDrop 不同的那一点入手：让两台设备互相可见的是它们从哪个网络连过来，而不是它们离得多近。下面这些检查是常见的首轮排查，而不是穷尽清单，而且每一项都能从页面上读出答案，不用靠猜。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "另一台设备就在你旁边，「附近的设备」里却还是没有它。",
            code: ["https://relayium.com/   # 对比两台设备上状态条里的公网 IP"],
            fix: "两个不同的公网 IP 就是两个房间，靠得再近也不管用。先把两台设备接到同一个 Wi-Fi，并关掉手机上的移动数据。任一侧的 VPN 或 iCloud 专用代理是造成两个地址的另一个常见原因；如果你愿意改这些设置，就断开 VPN，或只对这一个网络关闭专用代理，然后在那台设备上重新加载 https://relayium.com/。如果你更想保留它们，用 https://relayium.com/cross-network 上的配对码也能连到另一台设备，两个设置都不用动。",
          },
          {
            symptom: "两台设备显示的公网 IP 相同，却都不出现卡片。",
            code: ["https://relayium.com/   # 设备列表下方的提示写着要改的那个路由器开关"],
            fix: "路由器把自己的客户端隔开了。在它的 Wi-Fi 设置里关闭「AP 隔离 / 客户端隔离」；如果路由器不由你改，就改用 https://relayium.com/cross-network 上的配对码。",
          },
          {
            symptom: "在一个没有互联网出口的网络里，页面本身就打不开。",
            code: ["https://relayium.com/   # 如果这个地址始终打不开，说明该网络没有通往会合服务器的路"],
            fix: "这才是相对 AirDrop 真正的差距——AirDrop 完全不需要互联网。两个浏览器仍然需要连上会合服务器才能互相介绍，所以在物理隔离的局域网里，请在那个网络内运行你自己的实例（Relayium 按 AGPL-3.0 开源在 github.com/relayium/relayium），或者退回到用 U 盘。",
          },
          {
            symptom: "还没点接收，接收方就警告说这一批必须放在内存里。",
            code: ["chrome://downloads   # Chrome 用这个 / Edge 用 edge://downloads / Firefox 用 about:downloads"],
            fix: "Firefox、Safari 和所有手机浏览器都没有 File System Access API，所以它们会把整批内容在内存里拼装，超过大约 256 MiB 时 Relayium 就会警告。请改用电脑上的 Chrome 或 Edge 接收，或者一次少发几个文件，然后在那个浏览器自己的下载列表里逐个确认到达情况，而不是想当然认为已经保存——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
          },
          {
            symptom: "文件夹变成了一个 .zip，而不是一个文件夹。",
            code: ["chrome://downloads   # Chrome 里看；浏览器没有目录选择器时，这里的条目就是一个 .zip"],
            fix: "在没有目录选择器的浏览器里这是预期结果，而且解开压缩包后结构一致，相对路径完整保留。解压它即可；或者换用电脑上的 Chrome 或 Edge 接收同一个文件夹——它会先问你要写入哪个目标目录，然后把目录树原位写进去。",
          },
        ],
      },
    },
    {
      heading: "跨越互联网：AirDrop 做不到的事",
      body: [
        "AirDrop 只能就近使用——走出蓝牙/Wi-Fi 范围就失灵了。Relayium 的第二种模式正好补上这个空缺：两台设备处在完全不同的网络里，无论在世界的哪个角落。不过它和「附近的设备」工作区是两套界面：配对码房间保留的是早先那套按设备分开的控件，那里没有「打开工作区」可按。",
        "发送方登录后会拿到一段短配对码（附带加入链接和二维码）；接收方输入这个码，或扫描二维码，或直接打开链接——始终无需账号。这条跨网络的连接走的是加密 TURN 中继，而不是两端直连，这是有意为之：它一开始就走中继，因此连接不依赖在两个互不相干的网络之间的 NAT 和防火墙里探测出一条直连路径——它们可能挡住这样的路径。文件在离开发送方之前就已完成端到端加密，因此中继全程只转发它无法解开的密文——整条路径依旧是端到端加密的。若连接中断，传输可以断点续传，不必从头再来。 配对码有效期 5 分钟，所以生成之前先把两台设备都准备好。",
      ],
    },
    {
      heading: "真正保护文件的是什么",
      body: [
        "上面两种模式都是实时传输，用的是同一套加密：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密，只在两台设备之间协商完成。打开默认关闭的「高级验证」后，两端会显示同一段 6 位校验码（SAS），你可据此确认协商出的密钥未被替换：信令服务器或 TURN 中继没有冒充任一端点，也没有终止应用层端到端加密。跨网络传输时 TURN 仍在数据路径中，但只承载密文，并不是加密端点。每个文件还会用 SHA-256 做端到端校验。",
        "这种模式下服务器不会保存任何东西——一切只在传输期间存在。Relayium 采用 AGPL-3.0 许可开源，代码公开在 github.com/relayium/relayium，机制可审计，而非黑箱。",
      ],
    },
    {
      heading: "诚实说说实际限制",
      body: [
        "因为文件从不落到服务器上，所以没有上传配额——真正的限制取决于用哪个浏览器接收。桌面端支持 File System Access API 的浏览器（Windows 或 Linux 上的 Chrome、Edge）会把收到的数据直接流式写入磁盘，几个 GB 的文件也没问题。Firefox、Safari 以及所有手机浏览器（包括 Android 上的 Chrome）都没有这个 API，这时整批文件只能先攒在内存里，因此一旦超过约 256 MB，Relayium 会在接收方点「接收」之前先提示一次。这个数字要当成刻意取的保守估计，而不是硬上限：真正撑不住的临界点取决于设备内存、系统以及开了多少标签页。",
        "文件夹也支持：在桌面端（非 iOS）选择一个文件夹，相对路径会被保留。如果接收方浏览器能直接写入选定目录（桌面版 Chrome、Edge），文件会各就各位；否则（Firefox、Safari 以及手机浏览器）整个文件夹会作为一个 .zip 到达，解压后结构不变。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Windows 或 Android 有官方版 AirDrop 吗？",
        a: "没有——AirDrop 是 Apple 设备专属，Apple 从未推出过 Windows 或 Android 客户端。Relayium 是基于浏览器的替代方案：在两台设备上打开 relayium.com，无论平台组合如何都能一样使用，包括 Apple 与非 Apple 混搭的情况。",
      },
      {
        q: "需要账号吗？",
        a: "同一 Wi-Fi 下的流程不需要——两端打开网页就能互相发现，完全无需登录。跨不同网络用配对码发送时需要发送方登录；无论哪种网络模式，接收方都始终无需账号。",
      },
      {
        q: "需要安装什么吗？",
        a: "不需要。它在每个平台上都是一个网页——Windows、Linux、macOS、Android 和 iOS——所以不用从应用商店下载，也不用操心更新。",
      },
      {
        q: "这和「Relayium 对比 AirDrop」那篇有什么不同？",
        a: "那篇文章是客观的正面对比，讲清 AirDrop 真正更好的地方（纯 Apple 家庭）以及它的短板。本文则是操作指南，教你在至少一台设备不是 Apple 产品时，如何真正获得类似 AirDrop 的体验。",
      },
      {
        q: "能像 AirDrop 一样发给一群人吗？",
        a: "不能一次发完。本地房间不限于两台设备，所以从该网络打开页面的每台设备都会同时列出来——但一次传输是一对一的：你和某一个接收方打开工作区，这批文件就发给它。要把同一批文件分给房间里的好几个人，就依次和他们各开一次工作区。而跨网络的配对码模式只连接两台设备，且经由加密中继完成。",
      },
    ],
  },
  cta: {
    text: "在你的 Windows、Linux 或 Android 设备，以及要发送到的那台设备上打开 Relayium——同一网络下无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Windows・Linux・Android 向け AirDrop 代替",
  description:
    "Windows・Linux・Android には公式の AirDrop がありません。最も近い方法はこちらです：ブラウザで同じ Wi-Fi 内なら即共有、アカウントもインストールも不要、さらに AirDrop にはできないインターネット越しの共有も可能。",
  updatedLabel: "最終更新",
  lead: [
    "AirDrop は Apple の世界の中だけに存在するため、Windows・Linux・Android のユーザー、そして複数の種類の端末が混在する家庭には、内蔵の代替手段がありません。本ガイドは、Apple 以外の端末で AirDrop に最も近い体験を得る方法を示します：両端でウェブページを開くだけで、ファイルが移動します。",
    "この方法はプラットフォームを問わず同じように動作するため、AirDrop がうまく扱えない場面（同じ部屋に Windows ノート、Linux デスクトップ、Android スマホがある、あるいはそれに iPhone まで加わる）もカバーします。",
  ],
  sections: [
    {
      heading: "AirDrop 風の流れ：同じ Wi-Fi で、ブラウザ内完結",
      body: [
        "これはまさに AirDrop が想定する日常的なケースであり、Relayium はどのストアからもアプリを入れることなく同じ体験を実現します。",
      ],
      prereqs: {
        label: "必要なもの",
        items: [
          "各端末に最近のブラウザ。Windows なら Chrome か Edge、Linux なら Firefox か Chrome、Android なら Chrome です。ストアから入れるものも、インストールするものもありません。",
          "両方の端末が同じ Wi-Fi にあること。AirDrop と違い、基準は「近くにあること」ではありません。端末の検出は接続元のグローバル IP でグループ化されるため、モバイル通信のままのスマホは同じ机の上にあっても現れません。",
          "両方でインターネットに接続できること、そしてページを https://relayium.com/ で開いていること。AirDrop はインターネットをまったく必要としませんが、こちらの 2つのブラウザは互いを見つけるためにランデブーへ到達する必要があるため、隔離された LAN では自己ホストのインスタンスを使ってください。",
          "同一ネットワークの場合はアカウントもペアリングコードも不要です。ここがこの手順と AirDrop の共通点です。",
        ],
      },
      steps: [
        {
          text: "各端末で、ブラウザから転送ページを開きます。",
          code: ["https://relayium.com/"],
        },
        {
          text: "両方のステータス表示にあるグローバル IP を比べます。同じアドレスを共有していることが 2台を互いに見えるようにする条件で、モバイル通信のままだったスマホを見抜く最短の方法でもあります。",
          code: ["接続済み · このデバイス ThinkPad · グローバル IP 203.0.113.9"],
        },
        {
          text: "送信側の端末で「近くのデバイス」から相手を見つけ、そのカードを選んで「ワークスペースを開く」を押します。最新のブラウザではカードが提供する動作はこれ 1 つだけで、以降はファイルもフォルダもメッセージも、そこで開かれる 1 本の暗号化接続を通ります。ルームには複数の端末が並ぶことがあります。ワークスペースを開くことが、今回の転送を送る 1 人の相手を選ぶ操作であり、次の人の番になったらもう 1 つ開きます。",
        },
        {
          text: "ワークスペースがそのカードに取って代わります。送信はヘッダーの下のコントロールで行います：1 バッチ最大 1,000 ファイルなら「ファイルを送信」、ブラウザがフォルダ選択に対応していればツリーごと「フォルダを送信」、あるいはメッセージ欄に入力して——「Enter で改行 · ⌘/Ctrl+Enter で送信」——「送信」を押します。受信側の端末では、受け入れる前にリクエストの下の行を読んでください。ブラウザが保存先を尋ねるのか、自分のダウンロード先に書き込むのかが書かれています。読んだうえで「受信」を押します。先に検証コード（SAS）を照合したい場合は、開始前に両方の端末で「高度な検証」をオンにしてください。",
        },
      ],
      success: {
        label: "転送が成功したときの画面",
        body: [
          "この時点で相手の端末のカードはありません——ワークスペースが取って代わったからです。状態はワークスペースのヘッダーから読みます：接続先のデバイス、「接続済み」というリンク状態、そして唯一の経路バッジ「LAN直結」。両方の画面でファイルカウンターがそのバッチの最後のファイルまで進みます。",
          "フォルダがどう着地するかは受信側のブラウザ次第なので、決めつけず結果を確認してください。PC の Chrome と Edge は選んだディレクトリにツリーを書き込み、Firefox、Safari、すべてのスマホブラウザは同じ構造に展開できる .zip を 1つ渡します。それを確かめる場所はそのブラウザ自身のダウンロード一覧です——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
        ],
        code: ["Pixel に接続済み · 接続済み · LAN直結\nファイル 8/8"],
      },
    },
    {
      heading: "相手の端末が現れないとき",
      body: [
        "まず、この手順が AirDrop と異なる点から始めてください。2台を互いに見えるようにするのは、どれだけ近いかではなく、どのネットワークから接続しているかです。以下の確認は網羅した一覧ではなく定番の初手で、いずれも推測ではなくページから答えを読み取ります。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "相手の端末はすぐ隣にあるのに、「近くのデバイス」に現れない。",
            code: ["https://relayium.com/   # 両方の端末のステータス表示にあるグローバル IP を比べる"],
            fix: "グローバル IP が 2つ違えばルームも 2つで、距離の近さは何の役にも立ちません。まず両方の端末を同じ Wi-Fi に置き、スマホのモバイル通信をオフにします。どちらかで有効な VPN や iCloud プライベートリレーも、アドレスが 2 つに分かれるよくある原因です。設定を変えてよいなら、VPN を切る、あるいはその 1 つのネットワークだけプライベートリレーをオフにしてから、その端末で https://relayium.com/ を再読み込みしてください。オンのままにしたい場合は、https://relayium.com/cross-network のペアリングコードならどちらの設定にも触れずに相手の端末へ届きます。",
          },
          {
            symptom: "両方の端末が同じグローバル IP を表示しているのに、どちらのカードも現れない。",
            code: ["https://relayium.com/   # 端末一覧の下のヒントに、変更すべきルーター設定名がある"],
            fix: "ルーターが自分のクライアントを隔てています。Wi-Fi 設定で「AP 分離 / クライアント分離」をオフにするか、ルーターを変更できない場合は https://relayium.com/cross-network のペアリングコードを使ってください。",
          },
          {
            symptom: "インターネットに出られないネットワークでは、ページ自体が開かない。",
            code: ["https://relayium.com/   # これが開かないなら、そのネットワークにランデブーへの経路がない"],
            fix: "これがインターネットを一切必要としない AirDrop に対する本当の差です。2つのブラウザは互いを紹介してもらうためにランデブーへ到達する必要があるので、隔離された LAN ではそのネットワーク内で自分のインスタンスを動かすか（Relayium は AGPL-3.0 で github.com/relayium/relayium にあります）、USB メモリに戻ってください。",
          },
          {
            symptom: "受け入れる前に、受信側がバッチをメモリに保持しなければならないと警告する。",
            code: ["chrome://downloads   # Chrome 用 / Edge は edge://downloads / Firefox は about:downloads"],
            fix: "Firefox、Safari、すべてのスマホブラウザには File System Access API がないため、バッチをメモリ上で組み立て、おおよそ 256 MiB を超えると Relayium が警告します。PC の Chrome か Edge で受け取るか、一度に送るファイルを減らし、保存できたと決め込まずにそのブラウザ自身のダウンロード一覧——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)——で 1つずつ確認してください。",
          },
          {
            symptom: "フォルダではなく 1つの .zip が届いた。",
            code: ["chrome://downloads   # Chrome で見る。ディレクトリ選択がないブラウザでは、この項目が 1つの .zip になる"],
            fix: "ディレクトリ選択のないブラウザではこれが想定どおりの結果で、書庫を展開すれば相対パスを保ったまま同じ構造に戻ります。展開するか、同じフォルダを PC の Chrome か Edge で受け取ってください。そちらは保存先ディレクトリを尋ね、ツリーをその場に書き込みます。",
          },
        ],
      },
    },
    {
      heading: "インターネット越し：AirDrop にはできないこと",
      body: [
        "AirDrop は近接専用です。Bluetooth や Wi-Fi の範囲外に出ると動かなくなります。Relayium の2つ目のモードはまさにその空白を埋めます：まったく異なるネットワーク上の2台の端末を、世界中どこにいても。ただしこれは「近くのデバイス」のワークスペースとは別の画面です。ペアリングコードのルームは以前どおり端末ごとに分かれたコントロールのままなので、そこに「ワークスペースを開く」はありません。",
        "送信側がサインインすると短いペアリングコード（参加リンクと QR コード付き）を受け取ります。受信側はそれを入力するか、QR を読み取るか、リンクを開きます。アカウントは一切不要です。このネットワークをまたぐ接続は、端末同士の直接接続ではなく暗号化された TURN リレー経由で行われます。これは設計上の選択です。最初からリレーを使うため、接続の成立は、無関係な2つのネットワークの間にある NAT やファイアウォールを越える直接の経路を見つけられるかどうかに左右されません。NAT やファイアウォールが直接の経路を塞ぐこともあります。ファイルは送信側を出る前にエンドツーエンドで封印されているため、リレーが転送するのは鍵を持たない暗号文だけで、経路全体がエンドツーエンド暗号化のままです。接続が切れても、最初からではなく再開できます。 コードの有効期限は5分なので、生成する前に両方の端末を手元に用意してください。",
      ],
    },
    {
      heading: "実際にファイルを守っているもの",
      body: [
        "上記どちらのモードもリアルタイム転送で、同じ暗号化方式を使います：X25519 の鍵交換で導出した鍵をチャンクごとの AES-256-GCM に使い、2台の端末の間だけで協議されます。既定でオフの「高度な検証」をオンにすると両端が同じ6桁の検証コード（ショート認証文字列、SAS）を表示するので、導出された鍵が置き換えられていないこと、つまりシグナリングサーバーや TURN リレーがどちらかの端末になりすましたり、アプリケーション層のエンドツーエンド暗号化を終端したりしていないことを確認できます。ネットワークをまたぐ転送では TURN は引き続きデータ経路上にありますが、運ぶのは暗号文だけで、暗号化の端点ではありません。各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。",
        "このモードではサーバーに何も保存されません。存在するのは転送中の間だけです。Relayium は AGPL-3.0 ライセンスのオープンソースで、コードは github.com/relayium/relayium にあり、ブラックボックスではなく仕組みを検証できます。",
      ],
    },
    {
      heading: "正直に言う実際の制限",
      body: [
        "ファイルがサーバーに置かれることはないため、アップロードの割り当てはありません。実際の上限は、どのブラウザで受信するかで決まります。File System Access API を備えたデスクトップのブラウザ（Windows や Linux の Chrome・Edge）なら、受信データはそのままディスクへストリーミングされるので、数ギガバイトのファイルでも問題ありません。Firefox・Safari・スマホのブラウザ（Android の Chrome も含みます）にはこの API がないため、そこでは受信分をいったんメモリに溜めることになり、およそ 256 MB を超えると Relayium が受信側の承認前に警告を出します。この数値は実測した上限ではなく意図的に控えめに置いた目安と考えてください。実際に立ち行かなくなる地点は、端末のメモリ・OS・開いているタブの数によって変わります。",
        "フォルダにも対応しています。デスクトップ（iOS を除く）でフォルダを選ぶと、相対パスが保たれます。受信側のブラウザが選んだディレクトリへ直接書き込めるなら（デスクトップの Chrome、Edge）ファイルはそのまま収まり、そうでなければ（Firefox、Safari、スマホのブラウザ）フォルダ全体が1つの .zip として届き、展開すると同じ構造になります。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Windows や Android 向けの公式 AirDrop はありますか？",
        a: "ありません。AirDrop は Apple 端末専用で、Apple は Windows や Android 向けクライアントを一度も出していません。Relayium はブラウザベースの代替です。両方の端末で relayium.com を開けば、Apple と非 Apple が混在する組み合わせも含め、プラットフォームを問わず同じように動作します。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "同じ Wi-Fi での流れでは不要です。両端でページを開けば互いを発見し、サインインは一切要りません。異なるネットワークをまたいでペアリングコードで送る場合は送信側のサインインが必要ですが、どちらのネットワークモードでも受信側はアカウント不要です。",
      },
      {
        q: "何かインストールする必要はありますか？",
        a: "いいえ。Windows・Linux・macOS・Android・iOS のどれでもウェブページなので、ストアからダウンロードする必要も、更新し続ける必要もありません。",
      },
      {
        q: "「Relayium と AirDrop の比較」記事とは何が違いますか？",
        a: "あの記事は、AirDrop が本当に優れている点（純 Apple の家庭）とその限界を正面から比較したものです。本ガイドは、少なくとも1台が Apple 端末でないときに、実際に AirDrop 風の体験を得るための手順書です。",
      },
      {
        q: "AirDrop のように複数人へ送れますか？",
        a: "一度にはできません。ローカルの部屋は2台に限定されないので、そのネットワークからページを開いた端末はすべて同時に一覧に並びます。ただし転送は 1 対 1 です：1 人の相手とワークスペースを開き、そのファイルはその相手に届きます。同じバッチを部屋の複数の人に渡すには、順番に 1 人ずつワークスペースを開きます。インターネット越しのペアリングコードモードは、暗号化リレーを介した2台の端末どうしの接続です。",
      },
    ],
  },
  cta: {
    text: "お使いの Windows・Linux・Android 端末と、送り先の端末で Relayium を開いてください。同じネットワークならアカウントは不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Windows·Linux·Android용 AirDrop 대안",
  description:
    "Windows·Linux·Android에는 공식 AirDrop이 없습니다 — 가장 가까운 방법은 이것입니다: 브라우저에서 같은 Wi-Fi로 즉시 공유, 계정도 설치도 불필요, 게다가 AirDrop이 못 하는 인터넷 너머 전송까지.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "AirDrop은 Apple의 세계 안에만 존재하므로, Windows·Linux·Android 사용자와 여러 종류의 기기가 섞인 가정에는 내장된 대안이 없습니다. 이 가이드는 Apple이 아닌 기기에서 AirDrop과 가장 가까운 경험을 얻는 방법을 보여줍니다 — 양쪽에서 웹 페이지를 열면 파일이 옮겨집니다.",
    "이 방식은 플랫폼과 상관없이 똑같이 동작하므로, AirDrop이 잘 다루지 못하는 상황도 다룹니다 — 같은 방에 Windows 노트북, Linux 데스크톱, Android 폰이 함께 있거나, 여기에 iPhone까지 더해진 경우요.",
  ],
  sections: [
    {
      heading: "AirDrop 같은 흐름: 같은 Wi-Fi, 브라우저 안에서",
      body: [
        "이것이 바로 AirDrop이 위해 만들어진 일상적인 상황이며, Relayium은 어느 스토어에서도 앱을 받지 않고 같은 결과를 냅니다.",
      ],
      prereqs: {
        label: "필요한 것",
        items: [
          "각 기기에 최신 브라우저 — Windows는 Chrome이나 Edge, Linux는 Firefox나 Chrome, Android는 Chrome. 스토어에서 받을 것도, 설치할 것도 없습니다.",
          "두 기기가 같은 Wi-Fi에 있어야 합니다. AirDrop과 달리 기준은 ‘가까이 있음’이 아닙니다. 기기 탐색은 접속해 온 공인 IP로 묶이므로, 모바일 데이터에 남아 있는 휴대폰은 같은 책상 위에 있어도 나타나지 않습니다.",
          "두 기기 모두 인터넷에 연결되고 페이지를 https://relayium.com/ 으로 열어야 합니다. AirDrop은 인터넷이 전혀 필요 없지만, 이 두 브라우저는 서로를 찾기 위해 랑데부에 닿아야 하므로 격리된 LAN이라면 자체 호스팅 인스턴스를 쓰세요.",
          "같은 네트워크에서는 계정도 페어링 코드도 필요 없습니다 — 이 흐름이 AirDrop과 같은 부분이 바로 그것입니다.",
        ],
      },
      steps: [
        {
          text: "각 기기에서 브라우저로 전송 페이지를 엽니다.",
          code: ["https://relayium.com/"],
        },
        {
          text: "두 기기의 상태 표시에 있는 공인 IP를 비교합니다. 주소를 하나 공유하는 것이 두 기기를 서로 보이게 만드는 조건이며, 모바일 데이터를 벗어나지 않은 휴대폰을 잡아내는 가장 빠른 방법이기도 합니다.",
          code: ["연결됨 · 내 기기 ThinkPad · 공인 IP 203.0.113.9"],
        },
        {
          text: "보내는 기기에서 “주변 기기”에서 상대를 찾아 그 카드를 고르고 “작업 공간 열기”를 누르세요. 최신 브라우저에서 카드가 제공하는 동작은 이 하나뿐입니다 — 이후 파일과 폴더와 메시지가 모두 그때 열리는 암호화된 연결 하나를 지나기 때문입니다. 방에는 여러 기기가 나열될 수 있습니다. 작업 공간을 여는 것이 이번 전송을 받을 한 명을 고르는 방법이고, 다음 사람 차례가 되면 하나를 더 엽니다.",
        },
        {
          text: "작업 공간이 그 카드를 대신합니다. 보내기는 헤더 아래의 컨트롤로 합니다: 한 배치에 최대 1,000개라면 “파일 보내기”, 브라우저가 폴더 선택을 지원하면 트리째 “폴더 보내기”, 또는 메시지 상자에 입력하고 — “Enter 로 줄바꿈 · ⌘/Ctrl+Enter 로 전송” — “보내기”를 누릅니다. 받는 기기에서는 수락하기 전에 요청 아래 줄을 읽으세요 — 브라우저가 저장 위치를 물을지, 자체 다운로드 폴더에 쓸지가 적혀 있습니다 — 그다음 “받기”를 누릅니다. 먼저 검증 코드(SAS)를 대조하려면 시작 전에 두 기기에서 “고급 검증”을 켜세요.",
        },
      ],
      success: {
        label: "전송이 잘될 때의 화면",
        body: [
          "그때쯤 상대 기기 카드는 사라져 있습니다 — 작업 공간이 그 자리를 차지했으니까요 — 그래서 상태는 작업 공간 헤더에서 읽습니다: 연결된 기기, “연결됨”이라는 링크 상태, 그리고 하나뿐인 경로 배지 “LAN 직접”. 두 화면의 파일 카운터가 그 배치의 마지막 파일까지 갑니다.",
          "폴더가 어떻게 내려앉는지는 받는 브라우저에 달렸으니 단정하지 말고 결과를 확인하세요. 컴퓨터의 Chrome과 Edge는 고른 디렉터리에 트리를 쓰고, Firefox와 Safari, 모든 휴대폰 브라우저는 같은 구조로 풀리는 .zip 하나를 건넵니다. 그것을 확인하는 자리는 그 브라우저 자체의 다운로드 목록입니다 — chrome://downloads (Chrome), edge://downloads (Edge), about:downloads (Firefox).",
        ],
        code: ["Pixel 에 연결됨 · 연결됨 · LAN 직접\n파일 8/8"],
      },
    },
    {
      heading: "상대 기기가 나타나지 않을 때",
      body: [
        "이 흐름이 AirDrop과 다른 지점에서 시작하세요. 두 기기를 서로 보이게 하는 것은 얼마나 가까운지가 아니라 어느 네트워크에서 접속했는지입니다. 아래 확인은 전부를 담은 목록이 아니라 흔한 1차 점검이며, 모두 짐작이 아니라 페이지에서 답을 읽어냅니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "상대 기기가 바로 옆에 있는데도 “주변 기기”에 나타나지 않습니다.",
            code: ["https://relayium.com/   # 두 기기의 상태 표시에 있는 공인 IP를 비교한다"],
            fix: "공인 IP가 다르면 방도 둘이고, 가까이 있다고 해결되지 않습니다. 먼저 두 기기를 같은 Wi-Fi에 두고 휴대폰의 모바일 데이터를 끄세요. 어느 쪽이든 켜진 VPN이나 iCloud 비공개 릴레이도 주소가 둘로 갈리는 흔한 이유입니다. 설정을 바꿔도 괜찮다면 VPN을 끄거나 그 한 네트워크에서만 비공개 릴레이를 끄고 그 기기에서 https://relayium.com/ 을 다시 불러오세요. 그대로 두고 싶다면 https://relayium.com/cross-network 의 페어링 코드가 두 설정을 건드리지 않고 상대 기기에 닿습니다.",
          },
          {
            symptom: "두 기기가 같은 공인 IP를 보여주는데도 어느 카드도 나타나지 않습니다.",
            code: ["https://relayium.com/   # 기기 목록 아래 안내에 바꿔야 할 공유기 설정 이름이 있다"],
            fix: "공유기가 자기 클라이언트를 갈라놓고 있습니다. Wi-Fi 설정에서 ‘AP 격리 / 클라이언트 격리’를 끄거나, 공유기를 바꿀 수 없다면 https://relayium.com/cross-network 의 페어링 코드를 쓰세요.",
          },
          {
            symptom: "인터넷이 없는 네트워크에서는 페이지 자체가 열리지 않습니다.",
            code: ["https://relayium.com/   # 이것이 열리지 않으면 그 네트워크에 랑데부로 가는 길이 없다"],
            fix: "인터넷이 전혀 필요 없는 AirDrop과의 진짜 차이가 이것입니다. 두 브라우저는 서로를 소개받기 위해 랑데부에 닿아야 하므로, 망 분리된 LAN이라면 그 네트워크 안에서 자체 인스턴스를 돌리거나(Relayium은 AGPL-3.0으로 github.com/relayium/relayium에 있습니다) USB 메모리로 돌아가세요.",
          },
          {
            symptom: "받기를 누르기 전에, 받는 쪽이 배치를 메모리에 담아야 한다고 경고합니다.",
            code: ["chrome://downloads   # Chrome용 / Edge는 edge://downloads / Firefox는 about:downloads"],
            fix: "Firefox와 Safari, 모든 휴대폰 브라우저에는 File System Access API가 없어 배치를 메모리에서 조립하며, 대략 256 MiB를 넘으면 Relayium이 경고합니다. 컴퓨터의 Chrome이나 Edge로 받거나 한 번에 보내는 파일 수를 줄이고, 저장되었다고 단정하지 말고 그 브라우저 자체의 다운로드 목록 — chrome://downloads (Chrome), edge://downloads (Edge), about:downloads (Firefox) — 에서 하나씩 확인하세요.",
          },
          {
            symptom: "폴더 대신 .zip 하나가 도착했습니다.",
            code: ["chrome://downloads   # Chrome에서 본다. 디렉터리 선택기가 없는 브라우저에서는 항목이 .zip 하나가 된다"],
            fix: "디렉터리 선택기가 없는 브라우저에서는 이것이 예상된 결과이고, 압축을 풀면 상대 경로를 그대로 유지한 같은 구조가 됩니다. 압축을 풀거나, 같은 폴더를 컴퓨터의 Chrome이나 Edge로 받으세요. 그쪽은 대상 디렉터리를 묻고 트리를 그 자리에 씁니다.",
          },
        ],
      },
    },
    {
      heading: "인터넷 너머로: AirDrop이 할 수 없는 것",
      body: [
        "AirDrop은 근접 전용입니다 — Bluetooth/Wi-Fi 범위를 벗어나면 작동을 멈춥니다. Relayium의 두 번째 모드가 정확히 그 빈틈을 메웁니다: 완전히 다른 네트워크에 있는 두 기기를, 세계 어디에서든. 다만 이것은 “주변 기기” 작업 공간과 별개의 화면입니다. 페어링 코드 방은 기기별로 나뉜 이전 컨트롤을 그대로 쓰므로 거기에는 누를 “작업 공간 열기”가 없습니다.",
        "보내는 쪽이 로그인하면 짧은 페어링 코드(참여 링크와 QR 코드 포함)를 받습니다. 받는 쪽은 그 코드를 입력하거나, QR을 스캔하거나, 링크를 열면 됩니다 — 계정은 전혀 필요 없습니다. 이 네트워크 간 연결은 기기 사이의 직접 연결이 아니라 암호화된 TURN 릴레이를 거칩니다. 의도된 설계입니다. 처음부터 릴레이로 가기 때문에, 연결이 서로 무관한 두 네트워크 사이의 NAT와 방화벽을 통과하는 직접 경로를 찾아내는 데 의존하지 않습니다. NAT나 방화벽이 그런 경로를 막을 수도 있습니다. 파일은 보내는 쪽을 떠나기 전에 종단간으로 봉인되므로 릴레이가 나르는 것은 열 열쇠가 없는 암호문뿐이고, 경로 전체가 종단간 암호화를 유지합니다. 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다. 코드는 5분 동안만 유효하니, 만들기 전에 두 기기를 모두 곁에 두세요.",
      ],
    },
    {
      heading: "실제로 파일을 지키는 것",
      body: [
        "위 두 모드 모두 실시간 전송이며, 같은 암호화 방식을 씁니다: X25519 키 교환으로 도출한 키를 블록별 AES-256-GCM에 사용하며, 오직 두 기기 사이에서만 협상됩니다. 기본값이 꺼짐인 고급 검증을 켜면 양쪽이 동일한 6자리 검증 코드(짧은 인증 문자열, SAS)를 표시하므로 도출된 키가 바뀌지 않았는지, 즉 시그널링 서버나 TURN 릴레이가 어느 한쪽 엔드포인트를 사칭하거나 애플리케이션 계층의 종단간 암호화를 종료하지 않았는지 확인할 수 있습니다. 네트워크 간 전송에서는 TURN이 여전히 데이터 경로에 있지만 암호문만 운반하며 암호화 엔드포인트가 아닙니다. 각 파일은 SHA-256 해시로 종단간 검증됩니다.",
        "이 모드에서는 서버에 아무것도 저장되지 않습니다 — 전송이 이루어지는 동안만 존재합니다. Relayium은 AGPL-3.0 라이선스로 오픈소스이며 코드는 github.com/relayium/relayium에 있어, 블랙박스가 아니라 검증 가능한 구조입니다.",
      ],
    },
    {
      heading: "솔직한 실제 한계",
      body: [
        "파일이 서버에 놓이는 일이 없으므로 업로드 할당량이 없습니다 — 실제 한계는 어떤 브라우저로 받느냐에 달렸습니다. File System Access API를 갖춘 데스크톱 브라우저(Windows나 Linux의 Chrome, Edge)는 들어오는 데이터를 곧장 디스크로 스트리밍해 수 기가바이트 파일도 괜찮습니다. Firefox와 Safari, 그리고 모든 휴대폰 브라우저(Android의 Chrome 포함)에는 그 API가 없어서 받은 내용을 일단 메모리에 모으게 되며, 대략 256 MB를 넘어서면 Relayium이 받는 쪽이 수락하기 전에 미리 경고합니다. 이 수치는 측정된 상한이 아니라 일부러 보수적으로 잡은 추정치로 보세요. 실제로 버티지 못하는 지점은 기기 메모리와 OS, 열어 둔 탭 수에 따라 달라집니다.",
        "폴더도 지원됩니다: 데스크톱(iOS 제외)에서 폴더를 고르면 상대 경로가 유지됩니다. 받는 쪽 브라우저가 선택한 디렉터리에 바로 쓸 수 있으면(데스크톱 Chrome, Edge) 파일이 그대로 자리를 잡고, 그렇지 않으면(Firefox, Safari, 휴대폰 브라우저) 폴더 전체가 하나의 .zip으로 도착해 풀면 같은 구조가 됩니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Windows나 Android용 공식 AirDrop이 있나요?",
        a: "없습니다 — AirDrop은 Apple 기기 전용이며 Apple은 Windows나 Android용 클라이언트를 낸 적이 없습니다. Relayium은 브라우저 기반 대안입니다. 두 기기에서 relayium.com을 열면, Apple과 비Apple이 섞인 조합을 포함해 플랫폼과 상관없이 똑같이 동작합니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "같은 Wi-Fi 흐름에서는 필요 없습니다 — 양쪽에서 페이지를 열면 서로를 찾고, 로그인이 전혀 필요 없습니다. 다른 네트워크를 넘어 페어링 코드로 보낼 때는 보내는 쪽의 로그인이 필요하지만, 어느 네트워크 모드든 받는 쪽은 계정이 필요 없습니다.",
      },
      {
        q: "뭔가 설치해야 하나요?",
        a: "아니요. Windows·Linux·macOS·Android·iOS 어디서나 웹 페이지이므로 스토어에서 내려받을 것도, 계속 업데이트할 것도 없습니다.",
      },
      {
        q: "'Relayium vs AirDrop' 비교 글과는 무엇이 다른가요?",
        a: "그 글은 AirDrop이 실제로 더 나은 부분(순수 Apple 가정)과 부족한 부분을 정면으로 비교한 글입니다. 이 가이드는 적어도 한 기기가 Apple 제품이 아닐 때 실제로 AirDrop 같은 경험을 얻는 방법을 알려주는 실전 가이드입니다.",
      },
      {
        q: "AirDrop처럼 여러 명에게 보낼 수 있나요?",
        a: "한 번에는 못 합니다. 로컬 방은 두 기기로 제한되지 않으므로 그 네트워크에서 페이지를 연 기기는 모두 한꺼번에 목록에 나옵니다 — 하지만 전송은 1대1입니다: 한 수신자와 작업 공간을 열면 그 파일은 그 사람에게 갑니다. 같은 배치를 방의 여러 사람에게 나누려면 각자와 차례로 작업 공간을 열면 됩니다. 인터넷 너머의 페어링 코드 모드는 암호화된 릴레이를 거쳐 두 기기만 잇습니다.",
      },
    ],
  },
  cta: {
    text: "여러분의 Windows·Linux·Android 기기와 보낼 대상 기기에서 Relayium을 여세요 — 같은 네트워크에서는 계정이 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "AirDrop-Alternative für Windows, Linux, Android",
  description:
    "Es gibt kein offizielles AirDrop für Windows, Linux oder Android — hier die nächste Alternative: sofortiges Teilen im selben WLAN im Browser, ohne Konto, ohne Installation, plus eine Möglichkeit übers Internet, die AirDrop nicht kann.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "AirDrop existiert nur in Apples Welt, was allen anderen — Windows, Linux, Android und jedem Haushalt mit gemischten Geräten — kein eingebautes Äquivalent lässt. Diese Anleitung zeigt die nächste Alternative zu AirDrop für Nicht-Apple-Geräte: eine Webseite auf beiden Seiten öffnen, und die Datei bewegt sich einfach.",
    "Es funktioniert unabhängig von der Plattform gleich, deckt also auch den Fall ab, den AirDrop nie gut behandelt: ein Windows-Laptop, ein Linux-Desktop und ein Android-Handy im selben Raum — oder alle drei plus ein iPhone dazu.",
  ],
  sections: [
    {
      heading: "Der AirDrop-ähnliche Ablauf: selbes WLAN, im Browser",
      body: [
        "Das ist der Alltagsfall, für den AirDrop gebaut ist, und Relayium erreicht dasselbe ohne App aus irgendeinem Store.",
      ],
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Einen aktuellen Browser auf jedem Gerät — Chrome oder Edge unter Windows, Firefox oder Chrome unter Linux, Chrome unter Android. Nichts aus einem Store, nichts zu installieren.",
          "Beide Geräte im selben WLAN. Anders als bei AirDrop ist Nähe nicht das Kriterium: Die Erkennung gruppiert Geräte nach der öffentlichen IP, über die sie sich verbinden, ein Handy im Mobilfunknetz erscheint also selbst auf demselben Schreibtisch nicht.",
          "Auf beiden funktionierendes Internet, mit der Seite über https://relayium.com/ geöffnet. AirDrop braucht überhaupt kein Internet; diese beiden Browser müssen dagegen das Rendezvous erreichen, um sich zu finden — in einem abgeschotteten LAN gehört deshalb eine selbst gehostete Instanz hin.",
          "Für den Fall im selben Netz kein Konto und kein Pairing-Code — genau darin gleicht dieser Ablauf AirDrop.",
        ],
      },
      steps: [
        {
          text: "Öffne auf jedem Gerät die Übertragungsseite im Browser.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Vergleiche die öffentliche IP in der Statuszeile auf beiden. Eine gemeinsame Adresse ist es, die die zwei Geräte füreinander sichtbar macht, und sie enttarnt am schnellsten das Handy, das nie aus dem Mobilfunknetz gewechselt ist.",
          code: ["Verbunden · dieses Gerät ThinkPad · öffentliche IP 203.0.113.9"],
        },
        {
          text: "Suche auf dem sendenden Gerät das andere unter „Geräte in der Nähe“, wähle seine Karte und drücke „Arbeitsbereich öffnen“. In einem aktuellen Browser ist das die einzige Aktion, die eine Karte anbietet, denn Dateien, Ordner und Nachrichten laufen danach alle über die eine verschlüsselte Verbindung, die sie öffnet. Ein Raum kann mehrere Geräte auflisten; einen Arbeitsbereich zu öffnen ist die Art, wie du den einen Empfänger dieser Übertragung auswählst, und für die nächste Person öffnest du einen weiteren.",
        },
        {
          text: "Der Arbeitsbereich tritt an die Stelle dieser Karte. Gesendet wird mit den Bedienelementen unter seiner Kopfzeile: „Dateien senden“ für einen Stapel von bis zu 1.000 Dateien, „Ordner senden“ für einen ganzen Baum, wo der Browser die Ordnerauswahl anbietet, oder tippe ins Nachrichtenfeld — „Enter für neue Zeile · ⌘/Ctrl+Enter zum Senden“ — und drücke „Senden“. Lies auf dem empfangenden Gerät die Zeile unter der Anfrage, bevor du annimmst — sie sagt, ob der Browser nach dem Speicherort fragt oder in seine eigenen Downloads schreibt — und drücke dann „Annehmen“. Wer zuerst einen Verifizierungscode (SAS) vergleichen will, schaltet vor dem Start auf beiden Geräten „Erweiterte Verifizierung“ ein.",
        },
      ],
      success: {
        label: "So sieht eine funktionierende Übertragung aus",
        body: [
          "Die Karte des anderen Geräts ist dann verschwunden — der Arbeitsbereich hat ihren Platz übernommen —, also liest du den Zustand an der Kopfzeile des Arbeitsbereichs ab: das verbundene Gerät, ein Verbindungszustand „Verbunden“ und ein einziges Pfad-Abzeichen mit „LAN direkt“. Der Dateizähler läuft auf beiden Bildschirmen bis zur letzten Datei des Stapels.",
          "Wie ein Ordner ankommt, hängt vom empfangenden Browser ab — prüfe das Ergebnis, statt es anzunehmen: Chrome und Edge am Computer schreiben den Baum in das gewählte Verzeichnis, Firefox, Safari und jeder Handy-Browser geben dir eine .zip, die sich zur selben Struktur entpackt. Nachsehen kannst du das in der Download-Liste dieses Browsers — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
        code: ["Verbunden mit Pixel · Verbunden · LAN direkt\nDatei 8/8"],
      },
    },
    {
      heading: "Wenn das andere Gerät nicht auftaucht",
      body: [
        "Fang dort an, wo sich dieser Ablauf von AirDrop unterscheidet: Sichtbar füreinander macht die beiden Geräte das Netz, aus dem sie sich verbinden, nicht ihre Nähe. Die Prüfungen unten sind die üblichen ersten und keine vollständige Liste, und jede liest ihre Antwort von der Seite ab, statt zu raten.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Das andere Gerät liegt direkt daneben und erscheint trotzdem nicht unter „Geräte in der Nähe“.",
            code: ["https://relayium.com/   # die öffentliche IP in der Statuszeile auf beiden Geräten vergleichen"],
            fix: "Zwei verschiedene öffentliche IP-Adressen bedeuten zwei Räume, und Nähe hilft dagegen nicht. Bring zuerst beide Geräte ins selbe WLAN und schalte am Handy die mobilen Daten aus. Ein VPN oder iCloud Private Relay auf einer der beiden Seiten ist ein weiterer häufiger Grund für zwei Adressen; wenn du sie ändern willst, trenne das VPN oder schalte Private Relay für dieses eine Netz ab und lade dort https://relayium.com/ neu. Willst du sie lieber anlassen, erreicht ein Pairing-Code auf https://relayium.com/cross-network das andere Gerät, ohne eine der beiden Einstellungen anzutasten.",
          },
          {
            symptom: "Beide Geräte zeigen dieselbe öffentliche IP, und keine Karte erscheint.",
            code: ["https://relayium.com/   # der Hinweis unter der Geräteliste nennt die Router-Einstellung"],
            fix: "Der Router trennt seine eigenen Clients. Schalte „AP-Isolierung / Client-Isolierung“ in seinen WLAN-Einstellungen aus, oder nimm einen Pairing-Code auf https://relayium.com/cross-network, wenn der Router nicht dir gehört.",
          },
          {
            symptom: "In einem Netz ohne Internetzugang lädt die Seite selbst nicht.",
            code: ["https://relayium.com/   # lädt das nie, hat das Netz keine Route zum Rendezvous"],
            fix: "Das ist die echte Lücke gegenüber AirDrop, das ganz ohne Internet auskommt. Zwei Browser müssen das Rendezvous erreichen, um einander vorgestellt zu werden — betreibe in einem abgeschotteten LAN also eine eigene Instanz in diesem Netz (Relayium steht unter AGPL-3.0 auf github.com/relayium/relayium) oder greif zum USB-Stick.",
          },
          {
            symptom: "Vor dem Annehmen warnt die empfangende Seite, der Stapel müsse im Speicher gehalten werden.",
            code: ["chrome://downloads   # in Chrome; Edge hat edge://downloads und Firefox about:downloads"],
            fix: "Firefox, Safari und jeder Handy-Browser haben keine File System Access API, setzen den Stapel also im Speicher zusammen, und ab etwa 256 MiB warnt Relayium. Empfange ihn in Chrome oder Edge am Computer, oder schicke weniger Dateien auf einmal, und kontrolliere jede Ankunft in der Download-Liste dieses Browsers, statt das Speichern anzunehmen — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
          },
          {
            symptom: "Ein Ordner kam als einzelne .zip an statt als Ordner.",
            code: ["chrome://downloads   # in Chrome; ohne Verzeichnisauswahl steht dort ein einziger .zip-Eintrag"],
            fix: "In einem Browser ohne Verzeichnisauswahl ist das das erwartete Ergebnis, und das Archiv entpackt sich mit erhaltenen relativen Pfaden zur selben Struktur. Entpacke es, oder empfange denselben Ordner in Chrome oder Edge am Computer: Die fragen nach einem Zielverzeichnis und schreiben den Baum direkt hinein.",
          },
        ],
      },
    },
    {
      heading: "Übers Internet: etwas, das AirDrop nicht kann",
      body: [
        "AirDrop funktioniert nur in der Nähe — verlässt man die Bluetooth-/WLAN-Reichweite, ist Schluss. Der zweite Modus von Relayium schließt genau diese Lücke: zwei Geräte in völlig unterschiedlichen Netzwerken, überall auf der Welt. Er ist allerdings eine andere Oberfläche als ein Arbeitsbereich mit einem Gerät in der Nähe: Ein Pairing-Code-Raum behält die früheren, pro Gerät getrennten Bedienelemente, dort gibt es also kein „Arbeitsbereich öffnen“ zu drücken.",
        "Der Absender meldet sich an und erhält einen kurzen Pairing-Code (mit Beitrittslink und QR-Code); der Empfänger gibt ihn ein, scannt den QR-Code oder öffnet den Link — und braucht dabei nie ein Konto. Diese netzübergreifende Verbindung läuft über ein verschlüsseltes TURN-Relay statt direkt zwischen den Geräten, und das ist so gewollt: Sie nutzt von Anfang an das Relay, sodass die Verbindung nicht davon abhängt, einen direkten Weg durch die NATs und Firewalls zwischen zwei fremden Netzwerken zu finden — die einen solchen Weg verhindern können. Die Dateien sind versiegelt, bevor sie den Absender verlassen, also leitet das Relay nur Chiffretext weiter, für den es keinen Schlüssel hat — die gesamte Strecke bleibt Ende-zu-Ende-verschlüsselt. Eine abgebrochene Verbindung kann fortgesetzt statt neu gestartet werden. Der Code gilt fünf Minuten — halte beide Geräte bereit, bevor du einen erzeugst.",
      ],
    },
    {
      heading: "Was die Datei tatsächlich schützt",
      body: [
        "Beide obigen Modi sind Echtzeitübertragungen und nutzen dieselbe Verschlüsselung: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, ausgehandelt nur zwischen den beiden Geräten. Schaltest du die standardmäßig ausgeschaltete erweiterte Verifizierung ein, zeigen beide Seiten denselben sechsstelligen Verifizierungscode (einen Short Authentication String), damit du prüfen kannst, dass der abgeleitete Schlüssel nicht ausgetauscht wurde: Weder der Signalisierungsserver noch ein TURN-Relay hat sich als einer der Endpunkte ausgegeben oder die Ende-zu-Ende-Verschlüsselung der Anwendungsschicht beendet. Bei netzübergreifenden Übertragungen bleibt TURN im Datenpfad, transportiert aber nur Chiffretext und ist kein Verschlüsselungsendpunkt. Jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft.",
        "In diesem Modus wird nichts auf einem Server gespeichert — es existiert nur für die Dauer der Übertragung. Relayium ist quelloffen unter der AGPL-3.0-Lizenz auf github.com/relayium/relayium, die Mechanik ist also prüfbar statt eine Blackbox.",
      ],
    },
    {
      heading: "Die praktischen Grenzen, ehrlich gesagt",
      body: [
        "Da die Datei nie auf einem Server landet, gibt es kein Upload-Kontingent — die echte Grenze hängt davon ab, welcher Browser empfängt. Ein Desktop-Browser mit der File System Access API (Chrome oder Edge unter Windows oder Linux) streamt eingehende Daten direkt auf die Festplatte, mehrere Gigabyte große Dateien sind also kein Problem. Firefox, Safari und sämtliche Handy-Browser — Chrome unter Android eingeschlossen — haben diese API nicht, dort sammelt sich der Empfang stattdessen im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium den Empfänger, bevor er annimmt. Versteh diesen Wert als bewusst vorsichtige Schätzung und nicht als harte Obergrenze: Wo es tatsächlich versagt, hängt vom Arbeitsspeicher des Geräts, vom Betriebssystem und von der Zahl der offenen Tabs ab.",
        "Ordner funktionieren ebenfalls: Wähle am Desktop (nicht unter iOS) einen Ordner, relative Pfade bleiben erhalten. Kann der empfangende Browser direkt in ein gewähltes Verzeichnis schreiben (Chrome oder Edge am Desktop), landen die Dateien dort; sonst (Firefox, Safari, jeder Handy-Browser) kommt der gesamte Ordner als eine .zip-Datei an, die sich zur selben Struktur entpackt.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Gibt es eine offizielle AirDrop-App für Windows oder Android?",
        a: "Nein — AirDrop ist Apple-Geräten vorbehalten, und Apple hat nie einen Windows- oder Android-Client herausgebracht. Relayium ist eine browserbasierte Alternative: Öffne relayium.com auf beiden Geräten, und es funktioniert unabhängig von der Plattform gleich, auch bei gemischten Apple-/Nicht-Apple-Paaren.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Für den Ablauf im selben WLAN nicht — öffne die Seite auf beiden Geräten, und sie erkennen sich, ganz ohne Anmeldung. Das Senden über verschiedene Netzwerke mit einem Pairing-Code erfordert die Anmeldung des Absenders; der Empfänger braucht in keinem der beiden Netzwerkmodi je ein Konto.",
      },
      {
        q: "Muss ich etwas installieren?",
        a: "Nein. Es ist auf jeder Plattform eine Webseite — Windows, Linux, macOS, Android und iOS —, es gibt also nichts aus einem Store herunterzuladen und nichts aktuell zu halten.",
      },
      {
        q: "Wie unterscheidet sich das vom Vergleich Relayium vs. AirDrop?",
        a: "Jener Artikel ist ein direkter Vergleich, wo AirDrop wirklich besser ist (reine Apple-Haushalte) und wo es an Grenzen stößt. Diese Anleitung ist die Schritt-für-Schritt-Version, um tatsächlich das AirDrop-ähnliche Erlebnis zu bekommen, wenn mindestens ein Gerät kein Apple-Gerät ist.",
      },
      {
        q: "Kann ich, wie bei AirDrop, an mehrere gleichzeitig senden?",
        a: "Nicht in einem Zug. Der lokale Raum ist nicht auf zwei Geräte begrenzt, jedes Gerät, das die Seite aus diesem Netz geöffnet hat, steht also gleichzeitig in der Liste — eine Übertragung ist aber eins zu eins: Du öffnest einen Arbeitsbereich mit einem Empfänger, und dorthin gehen diese Dateien. Denselben Stapel an mehrere im Raum zu geben heißt, mit jedem der Reihe nach einen Arbeitsbereich zu öffnen. Der Pairing-Code-Modus fürs Senden übers Internet verbindet genau zwei Geräte, und zwar über ein verschlüsseltes Relay.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf deinem Windows-, Linux- oder Android-Gerät und auf dem Zielgerät — im selben Netz ist kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "AirDrop pour Windows, Linux et Android",
  description:
    "Il n'existe pas d'AirDrop officiel pour Windows, Linux ou Android — voici ce qui s'en rapproche le plus : partage instantané sur le même Wi-Fi dans le navigateur, sans compte, sans installation, plus une façon de traverser internet qu'AirDrop ne sait pas faire.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "AirDrop n'existe que dans le monde d'Apple, ce qui laisse tous les autres — Windows, Linux, Android, et tout foyer avec des appareils mélangés — sans équivalent intégré. Ce guide montre ce qui se rapproche le plus d'AirDrop pour les appareils non-Apple : ouvrir une page web des deux côtés, et le fichier se déplace tout simplement.",
    "Cela fonctionne de la même façon quelle que soit la plateforme, couvrant donc aussi le cas qu'AirDrop ne gère jamais bien : un portable Windows, un poste Linux et un téléphone Android dans la même pièce — ou les trois plus un iPhone en plus.",
  ],
  sections: [
    {
      heading: "Le flux façon AirDrop : même Wi-Fi, dans le navigateur",
      body: [
        "C'est le cas quotidien pour lequel AirDrop est conçu, et Relayium l'égale sans nécessiter d'appli d'aucune boutique.",
      ],
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Un navigateur récent sur chaque appareil — Chrome ou Edge sous Windows, Firefox ou Chrome sous Linux, Chrome sous Android. Rien à prendre dans une boutique, rien à installer.",
          "Les deux appareils sur le même Wi-Fi. Contrairement à AirDrop, le critère n'est pas la proximité : la détection regroupe les appareils selon l'IP publique par laquelle ils se connectent, donc un téléphone resté en données mobiles n'apparaîtra pas, même posé sur le même bureau.",
          "Un accès internet fonctionnel des deux côtés, avec la page ouverte via https://relayium.com/. AirDrop n'a besoin d'aucun internet, alors que ces deux navigateurs doivent atteindre le point de rendez-vous pour se trouver, ce qui rend une instance auto-hébergée nécessaire sur un réseau isolé.",
          "Ni compte ni code d'appairage pour le cas du même réseau — c'est justement ce que ce flux partage avec AirDrop.",
        ],
      },
      steps: [
        {
          text: "Sur chaque appareil, ouvrez la page de transfert dans le navigateur.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Comparez l'IP publique de la ligne d'état sur les deux. Une adresse commune est ce qui rend les deux appareils visibles l'un pour l'autre, et c'est le moyen le plus rapide de repérer le téléphone qui n'a jamais quitté les données mobiles.",
          code: ["Connecté · cet appareil ThinkPad · IP publique 203.0.113.9"],
        },
        {
          text: "Sur l'appareil qui envoie, trouvez l'autre sous « Appareils à proximité », choisissez sa carte et appuyez sur « Ouvrir l’espace de travail ». Sur un navigateur actuel c'est la seule action qu'une carte propose, car fichiers, dossiers et messages passent ensuite tous par l'unique connexion chiffrée qu'elle ouvre. Une salle peut lister plusieurs appareils ; ouvrir un espace de travail est la façon de choisir l'unique destinataire de ce transfert, et vous en ouvrez un autre quand vient le tour de la personne suivante.",
        },
        {
          text: "L'espace de travail remplace cette carte. Pour envoyer, utilisez les commandes sous son en-tête : « Envoyer des fichiers » pour un lot d'au plus mille fichiers, « Envoyer un dossier » pour toute une arborescence là où le navigateur propose de choisir un dossier, ou tapez dans la zone de message — « Entrée pour une nouvelle ligne · ⌘/Ctrl+Entrée pour envoyer » — puis appuyez sur « Envoyer ». Sur l'appareil qui reçoit, lisez la ligne sous la demande avant d'accepter — elle indique si le navigateur demandera où enregistrer ou écrira dans ses propres téléchargements — puis appuyez sur « Accepter ». Pour comparer un code de vérification (SAS) d'abord, activez « Vérification avancée » sur les deux appareils avant de commencer.",
        },
      ],
      success: {
        label: "À quoi ressemble un transfert qui marche",
        body: [
          "La carte de l'autre appareil a disparu à ce stade — l'espace de travail a pris sa place — alors lisez l'état sur l'en-tête de l'espace de travail : l'appareil auquel vous êtes connecté, un état de lien « Connecté », et un unique badge de chemin indiquant « LAN direct ». Le compteur de fichiers va jusqu'au dernier fichier du lot sur les deux écrans.",
          "La façon dont un dossier atterrit dépend du navigateur qui reçoit, alors vérifiez le résultat au lieu de le supposer : Chrome et Edge sur ordinateur écrivent l'arborescence dans le répertoire choisi, tandis que Firefox, Safari et tous les navigateurs de téléphone vous remettent un seul .zip qui se décompresse dans la même structure. C'est dans la liste de téléchargements de ce navigateur que vous le confirmez — chrome://downloads dans Chrome, edge://downloads dans Edge, about:downloads dans Firefox.",
        ],
        code: ["Connecté à Pixel · Connecté · LAN direct\nFichier 8/8"],
      },
    },
    {
      heading: "Quand l'autre appareil n'apparaît pas",
      body: [
        "Commencez par le point où ce flux diffère d'AirDrop : ce qui rend deux appareils visibles l'un pour l'autre, c'est le réseau depuis lequel ils se connectent, pas leur proximité. Les vérifications ci-dessous sont les premières habituelles plutôt qu'une liste exhaustive, et chacune lit sa réponse sur la page au lieu de deviner.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "L'autre appareil est juste à côté de vous et n'apparaît toujours pas sous « Appareils à proximité ».",
            code: ["https://relayium.com/   # comparez l'IP publique de la ligne d'état sur les deux appareils"],
            fix: "Deux adresses IP publiques différentes, ce sont deux salles, et la proximité n'y change rien. Mettez d'abord les deux appareils sur le même Wi-Fi et coupez les données mobiles sur le téléphone. Un VPN ou iCloud Private Relay d'un côté ou de l'autre est une autre raison courante d'avoir deux adresses ; si vous acceptez de les changer, coupez le VPN ou désactivez Private Relay pour ce seul réseau, puis rechargez https://relayium.com/ dessus. Si vous préférez les laisser en place, un code d'appairage sur https://relayium.com/cross-network atteint l'autre appareil sans toucher ni l'un ni l'autre réglage.",
          },
          {
            symptom: "Les deux appareils affichent la même IP publique et aucune carte n'apparaît.",
            code: ["https://relayium.com/   # l'indication sous la liste des appareils nomme le réglage du routeur"],
            fix: "Le routeur sépare ses propres clients. Désactivez « l'isolation AP / isolation des clients » dans ses réglages Wi-Fi, ou passez par un code d'appairage sur https://relayium.com/cross-network quand le routeur ne vous appartient pas.",
          },
          {
            symptom: "Sur un réseau sans accès à internet, la page elle-même ne se charge pas.",
            code: ["https://relayium.com/   # si elle ne se charge jamais, le réseau n'a aucune route vers le rendez-vous"],
            fix: "C'est le vrai écart avec AirDrop, qui se passe complètement d'internet. Deux navigateurs doivent atteindre le point de rendez-vous pour être présentés l'un à l'autre, alors sur un réseau isolé faites tourner votre propre instance dessus — Relayium est sous AGPL-3.0 sur github.com/relayium/relayium — ou revenez à une clé USB.",
          },
          {
            symptom: "Avant l'acceptation, le côté récepteur avertit que le lot doit être gardé en mémoire.",
            code: ["chrome://downloads   # dans Chrome ; Edge a edge://downloads et Firefox about:downloads"],
            fix: "Firefox, Safari et tous les navigateurs de téléphone n'ont pas d'API File System Access, ils assemblent donc le lot en mémoire et Relayium avertit au-delà d'environ 256 MiB. Recevez-le dans Chrome ou Edge sur un ordinateur, ou envoyez moins de fichiers à la fois, et contrôlez chaque arrivée dans la liste de téléchargements de ce navigateur au lieu de supposer l'enregistrement — chrome://downloads dans Chrome, edge://downloads dans Edge, about:downloads dans Firefox.",
          },
          {
            symptom: "Un dossier est arrivé sous la forme d'un seul .zip au lieu d'un dossier.",
            code: ["chrome://downloads   # dans Chrome ; sans sélecteur de répertoire, l'entrée est un unique .zip"],
            fix: "C'est le résultat attendu dans un navigateur sans sélecteur de répertoire, et l'archive se décompresse dans la même structure avec les chemins relatifs intacts. Décompressez-la, ou recevez le même dossier dans Chrome ou Edge sur ordinateur, qui demande un répertoire de destination et y écrit l'arborescence sur place.",
          },
        ],
      },
    },
    {
      heading: "À travers internet : ce qu'AirDrop ne sait pas faire",
      body: [
        "AirDrop fonctionne uniquement à proximité — sortez de la portée Bluetooth/Wi-Fi et il s'arrête. Le second mode de Relayium comble exactement ce manque : deux appareils sur des réseaux totalement différents, n'importe où dans le monde. C'est toutefois une surface distincte d'un espace de travail avec un appareil à proximité : une salle à code d'appairage conserve les anciennes commandes séparées par appareil, il n'y a donc pas d'« Ouvrir l’espace de travail » à y presser.",
        "L'expéditeur se connecte et obtient un court code d'appairage (avec un lien de participation et un QR code) ; le destinataire le saisit, scanne le QR code, ou ouvre le lien — sans jamais avoir besoin de compte. Cette connexion entre réseaux passe par un relais TURN chiffré plutôt que par une liaison directe, et c'est voulu : elle emprunte le relais dès le départ, si bien qu'elle ne dépend pas de la découverte d'une voie directe à travers les NAT et pare-feu situés entre deux réseaux étrangers l'un à l'autre, qui peuvent en empêcher une. Les fichiers sont scellés de bout en bout avant de quitter l'expéditeur : le relais ne transmet donc que du texte chiffré qu'aucune clé ne lui permet d'ouvrir, et tout le trajet reste chiffré de bout en bout. Une connexion coupée peut reprendre au lieu de repartir de zéro. Le code est valable cinq minutes : ayez les deux appareils sous la main avant d'en générer un.",
      ],
    },
    {
      heading: "Ce qui protège réellement le fichier",
      body: [
        "Les deux modes ci-dessus sont des transferts en temps réel et utilisent le même chiffrement : un échange de clés X25519 dérive une clé utilisée pour un AES-256-GCM par bloc, négocié uniquement entre les deux appareils. Avec la vérification avancée activée (désactivée par défaut), les deux côtés affichent le même code de vérification à 6 chiffres (une chaîne d'authentification courte), ce qui permet de vérifier que la clé dérivée n'a pas été remplacée : ni le serveur de signalisation ni un relais TURN ne s'est fait passer pour l'un des appareils ou n'a terminé le chiffrement de bout en bout de la couche applicative. Lors d'un transfert entre réseaux, TURN reste bien sur le chemin des données, mais ne transporte que du texte chiffré et n'est pas un point de terminaison du chiffrement. Chaque fichier est vérifié de bout en bout par une empreinte SHA-256.",
        "Rien n'est stocké sur un serveur dans ce mode — il n'existe que pour la durée du transfert. Relayium est open source sous licence AGPL-3.0 sur github.com/relayium/relayium, la mécanique est donc auditable plutôt qu'une boîte noire.",
      ],
    },
    {
      heading: "Les limites pratiques, en toute franchise",
      body: [
        "Comme le fichier n'atterrit jamais sur un serveur, il n'y a pas de quota de téléversement — la vraie limite dépend du navigateur qui reçoit. Un navigateur de bureau doté de l'API File System Access (Chrome ou Edge sous Windows ou Linux) écrit les données entrantes en flux directement sur le disque, donc les fichiers de plusieurs gigaoctets passent sans souci. Firefox, Safari et tous les navigateurs de téléphone — Chrome sous Android compris — n'ont pas cette API : la réception y est assemblée en mémoire, et Relayium prévient le destinataire avant qu'il accepte dès que l'on dépasse environ 256 Mo. À prendre comme une estimation volontairement prudente, pas comme un plafond mesuré : le point où cela lâche vraiment dépend de la mémoire de l'appareil, de son système et du nombre d'onglets ouverts.",
        "Les dossiers fonctionnent aussi : choisissez un dossier sur ordinateur (pas sous iOS) et les chemins relatifs sont conservés. Si le navigateur qui reçoit peut écrire directement dans un répertoire choisi (Chrome ou Edge sur ordinateur), les fichiers s'y placent ; sinon (Firefox, Safari, tout navigateur de téléphone) tout le dossier arrive sous forme d'un seul .zip qui se décompresse en gardant la même structure.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Existe-t-il une appli AirDrop officielle pour Windows ou Android ?",
        a: "Non — AirDrop est exclusif aux appareils Apple, et Apple n'a jamais publié de client Windows ou Android. Relayium est une alternative basée sur le navigateur : ouvrez relayium.com sur les deux appareils, et cela fonctionne de la même façon quelle que soit la plateforme, y compris pour des paires Apple/non-Apple mélangées.",
      },
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Pas pour le flux sur le même Wi-Fi — ouvrez la page sur les deux appareils et ils se découvrent, sans aucune connexion. Envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte ; le destinataire n'a jamais besoin de compte, dans aucun des deux modes réseau.",
      },
      {
        q: "Dois-je installer quelque chose ?",
        a: "Non. C'est une page web sur chaque plateforme — Windows, Linux, macOS, Android et iOS — donc rien à télécharger depuis une boutique et rien à maintenir à jour.",
      },
      {
        q: "En quoi est-ce différent de la comparaison Relayium vs AirDrop ?",
        a: "Cet article-là est une comparaison frontale montrant où AirDrop est réellement meilleur (foyers tout-Apple) et où il atteint ses limites. Ce guide-ci est le mode d'emploi pour obtenir concrètement l'expérience façon AirDrop quand au moins un appareil n'est pas Apple.",
      },
      {
        q: "Puis-je envoyer à un groupe, comme avec AirDrop ?",
        a: "Pas d'un seul coup. La salle locale n'est pas limitée à deux appareils, donc chaque appareil ayant ouvert la page depuis ce réseau est listé en même temps — mais un transfert est un à un : vous ouvrez un espace de travail avec un destinataire, et ces fichiers vont à lui. Partager le même lot avec plusieurs personnes de la salle revient à ouvrir un espace de travail avec chacune à son tour. Le mode par code d'appairage pour l'envoi à travers internet relie exactement deux appareils, via un relais chiffré.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur votre appareil Windows, Linux ou Android et sur celui de destination — sans compte nécessaire sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "AirDrop لأنظمة Windows وLinux وAndroid",
  description:
    "لا يوجد AirDrop رسمي لأنظمة Windows أو Linux أو Android — وهذا أقرب بديل: مشاركة فورية على نفس شبكة Wi-Fi من داخل المتصفح، دون حساب ودون تثبيت، بالإضافة إلى طريقة للوصول عبر الإنترنت لا يقدر عليها AirDrop.",
  updatedLabel: "آخر تحديث",
  lead: [
    "لا يوجد AirDrop إلا داخل عالم Apple، ما يترك الجميع عداه — Windows وLinux وAndroid وأي منزل يجمع بين أجهزة متنوعة — دون بديل مدمج. يعرض هذا الدليل أقرب بديل لـ AirDrop للأجهزة غير التابعة لـ Apple: افتح صفحة ويب على الطرفين، وينتقل الملف من تلقاء نفسه.",
    "يعمل بالطريقة نفسها بصرف النظر عن المنصة، لذا فهو يغطي أيضًا الحالة التي لم يُحسن AirDrop التعامل معها قط: حاسوب محمول بنظام Windows وحاسوب مكتبي بنظام Linux وهاتف Android في الغرفة نفسها، أو الثلاثة جميعًا مع إضافة iPhone.",
  ],
  sections: [
    {
      heading: "الأسلوب الشبيه بـ AirDrop: نفس شبكة Wi-Fi، من داخل المتصفح",
      body: [
        "هذه هي الحالة اليومية التي صُمم AirDrop من أجلها، وRelayium يضاهيها دون الحاجة إلى تطبيق من أي متجر.",
      ],
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "متصفح حديث على كل جهاز — Chrome أو Edge على Windows، وFirefox أو Chrome على Linux، وChrome على Android. لا شيء من متجر، ولا شيء لتثبيته.",
          "الجهازان على نفس شبكة Wi-Fi. وخلافًا لـ AirDrop، ليس القُرب هو المعيار: إذ يجمع الاكتشاف الأجهزة بحسب عنوان IP العام الذي تتصل منه، فالهاتف الباقي على بيانات الجوال لن يظهر ولو كان على المكتب نفسه.",
          "اتصال إنترنت عامل على الجهازين، والصفحة مفتوحة عبر https://relayium.com/. لا يحتاج AirDrop إلى إنترنت إطلاقًا، أما هذان المتصفحان فيحتاجان إلى الوصول إلى خادم التعارف ليجد كل منهما الآخر، ولذلك تحتاج الشبكة المعزولة إلى نسخة مستضافة ذاتيًا.",
          "لا حساب ولا رمز اقتران في حالة نفس الشبكة — وهذا بالضبط ما يشترك فيه هذا المسار مع AirDrop.",
        ],
      },
      steps: [
        {
          text: "على كل جهاز، افتح صفحة النقل في المتصفح.",
          code: ["https://relayium.com/"],
        },
        {
          text: "قارن عنوان IP العام في شريط الحالة على الجهازين. مشاركة عنوان واحد هي ما يجعل الجهازين مرئيَّين لبعضهما، وهي أسرع وسيلة لكشف الهاتف الذي لم يغادر بيانات الجوال أصلًا.",
          code: ["متصل · هذا الجهاز ThinkPad · عنوان IP العام 203.0.113.9"],
        },
        {
          text: "على الجهاز المُرسِل، اعثر على الجهاز الآخر تحت «الأجهزة القريبة»، واختر بطاقته واضغط «فتح مساحة العمل». في المتصفحات الحديثة هذا هو الإجراء الوحيد الذي تعرضه البطاقة، لأن الملفات والمجلدات والرسائل تمرّ بعد ذلك كلها عبر الاتصال المشفَّر الواحد الذي تفتحه. وقد تسرد الغرفة عدة أجهزة؛ وفتح مساحة عمل هو الطريقة التي تختار بها المستلِم الواحد لهذا النقل، وتفتح أخرى عندما يأتي دور الشخص التالي.",
        },
        {
          text: "تحلّ مساحة العمل مكان تلك البطاقة. أرسِل من عناصر التحكم أسفل ترويستها: «إرسال ملفات» لدفعة تصل إلى 1,000 ملف، و«إرسال مجلد» لشجرة كاملة حيث يوفّر المتصفح اختيار المجلدات، أو اكتب في صندوق الرسائل — «Enter لسطر جديد · ⌘/Ctrl+Enter للإرسال» — ثم اضغط «إرسال». وعلى الجهاز المستقبِل، اقرأ السطر أسفل الطلب قبل القبول — فهو يقول إن كان المتصفح سيسأل عن مكان الحفظ أم سيكتب في تنزيلاته الخاصة — ثم اضغط «قبول». وإن أردت مقارنة رمز التحقق (SAS) أولًا، فعّل «التحقّق المتقدّم» على الجهازين قبل البدء.",
        },
      ],
      success: {
        label: "كيف يبدو نقل ناجح",
        body: [
          "تكون بطاقة الجهاز الآخر قد اختفت عند هذه اللحظة — إذ حلّت مساحة العمل مكانها — فاقرأ الحالة من ترويسة مساحة العمل: الجهاز المتصل بك، وحالة رابط تقول «متصل»، ووسم مسار واحد يقرأ «مباشر عبر LAN». ويمضي عدّاد الملفات إلى آخر ملف في الدفعة على الشاشتين.",
          "أما كيفية وصول المجلد فتعتمد على المتصفح المستقبِل، فتحقّق من النتيجة بدل افتراضها: يكتب Chrome وEdge على الحاسوب الشجرة داخل المجلد الذي اخترته، بينما يسلّمك Firefox وSafari وكل متصفحات الهواتف ملف ‎.zip‎ واحدًا يُفكّ إلى البنية نفسها. وقائمة تنزيلات ذلك المتصفح هي المكان الذي تتأكّد منه — chrome://downloads في Chrome، وedge://downloads في Edge، وabout:downloads في Firefox.",
        ],
        code: ["متصل بـ Pixel · متصل · مباشر عبر LAN\nالملف 8/8"],
      },
    },
    {
      heading: "عندما لا يظهر الجهاز الآخر",
      body: [
        "ابدأ من النقطة التي يختلف فيها هذا المسار عن AirDrop: فما يجعل جهازين مرئيَّين لبعضهما هو الشبكة التي يتصلان منها، لا مدى قربهما. والفحوص أدناه هي الأولى المعتادة لا قائمة شاملة، وكل منها يقرأ جوابه من الصفحة بدل التخمين.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "الجهاز الآخر بجوارك تمامًا ومع ذلك لا يظهر تحت «الأجهزة القريبة».",
            code: ["https://relayium.com/   # قارن عنوان IP العام في شريط الحالة على الجهازين"],
            fix: "عنوانا IP عامان مختلفان يعنيان غرفتين، والقُرب لا يغيّر ذلك. ضع الجهازين أولًا على نفس شبكة Wi-Fi، وأوقف بيانات الجوال على الهاتف. ووجود VPN أو الترحيل الخاص في iCloud على أي من الجانبين سبب شائع آخر لظهور عنوانين؛ فإن كنت مستعدًا لتغييرهما، اقطع VPN أو أوقف الترحيل الخاص لهذه الشبكة وحدها، ثم أعِد تحميل https://relayium.com/ هناك. وإن كنت تفضّل تركهما كما هما، فرمز اقتران على https://relayium.com/cross-network يصل إلى الجهاز الآخر دون المساس بأي من الإعدادين.",
          },
          {
            symptom: "يعرض الجهازان نفس عنوان IP العام ولا تظهر أي بطاقة.",
            code: ["https://relayium.com/   # التلميح أسفل قائمة الأجهزة يسمّي إعداد الموجّه"],
            fix: "الموجّه يفصل عملاءه عن بعضهم. أوقف «عزل نقطة الوصول / عزل العملاء» في إعدادات Wi-Fi لديه، أو استخدم رمز اقتران على https://relayium.com/cross-network إن لم يكن الموجّه بيدك لتغييره.",
          },
          {
            symptom: "على شبكة بلا إنترنت، لا تُحمَّل الصفحة نفسها.",
            code: ["https://relayium.com/   # إن لم تُحمَّل أبدًا فلا طريق من هذه الشبكة إلى خادم التعارف"],
            fix: "هذه هي الفجوة الحقيقية أمام AirDrop الذي يستغني عن الإنترنت تمامًا. لا يزال المتصفحان بحاجة إلى الوصول إلى خادم التعارف ليُعرَّف كل منهما بالآخر، فشغّل على الشبكة المعزولة نسختك الخاصة داخلها — فـ Relayium مفتوح المصدر برخصة AGPL-3.0 على github.com/relayium/relayium — أو عُد إلى ذاكرة USB.",
          },
          {
            symptom: "قبل القبول، يحذّر الطرف المستقبِل من أن الدفعة يجب أن تُحفظ في الذاكرة.",
            code: ["chrome://downloads   # في Chrome / وEdge لديه edge://downloads / وFirefox لديه about:downloads"],
            fix: "لا تملك Firefox وSafari وكل متصفحات الهواتف واجهة File System Access، فتجمّع الدفعة في الذاكرة ويحذّر Relayium بعد نحو 256 MiB. استقبلها في Chrome أو Edge على حاسوب، أو أرسِل ملفات أقل في المرة الواحدة، وتحقّق من كل وصول في قائمة تنزيلات ذلك المتصفح بدل افتراض أنها حُفظت — chrome://downloads في Chrome، وedge://downloads في Edge، وabout:downloads في Firefox.",
          },
          {
            symptom: "وصل المجلد على هيئة ملف ‎.zip‎ واحد بدل أن يكون مجلدًا.",
            code: ["chrome://downloads   # في Chrome؛ وبلا منتقي مجلدات يصبح المُدخَل ملف ‎.zip‎ واحدًا"],
            fix: "هذه هي النتيجة المتوقعة في متصفح بلا منتقي مجلدات، والأرشيف يُفكّ إلى البنية نفسها مع بقاء المسارات النسبية سليمة. فُكّ ضغطه، أو استقبل المجلد نفسه في Chrome أو Edge على حاسوب، فهو يسأل عن مجلد الوجهة ويكتب الشجرة داخله في مكانها.",
          },
        ],
      },
    },
    {
      heading: "عبر الإنترنت: أمر لا يقدر عليه AirDrop",
      body: [
        "يعمل AirDrop في النطاق القريب فقط — إذا خرجت عن نطاق Bluetooth/Wi-Fi توقف عن العمل. يسد الوضع الثاني في Relayium هذه الثغرة بالضبط: جهازان على شبكتين مختلفتين تمامًا، في أي مكان في العالم. غير أن هذا واجهة منفصلة عن مساحة عمل جهاز قريب: فغرفة رمز الاقتران تحتفظ بعناصر التحكم الأقدم المنفصلة لكل جهاز، ولا يوجد فيها «فتح مساحة العمل» لتضغطه.",
        "يسجّل المُرسِل الدخول ويحصل على رمز اقتران قصير (مع رابط انضمام ورمز QR)؛ ويُدخله المُستقبِل، أو يمسح رمز QR، أو يفتح الرابط — دون أن يحتاج إلى حساب مطلقًا. وهذا الاتصال عبر الشبكات يجري عبر مُرحِّل TURN مُشفَّر لا عبر وصلة مباشرة بين الجهازين، وذلك بحكم التصميم: فهو يسلك المُرحِّل من البداية، فلا يعتمد انعقاده على إيجاد مسار مباشر عبر ما بين شبكتين لا صلة بينهما من شبكات NAT وجدران حماية، وهي قد تمنع مثل هذا المسار. والملفات مختومة من الطرف إلى الطرف قبل أن تغادر المُرسِل، فلا يُمرِّر المُرحِّل سوى نص مُشفَّر لا يملك مفتاحه — ويبقى المسار كله مُشفَّرًا من الطرف إلى الطرف. ويمكن للاتصال المنقطع أن يستأنف بدلًا من البدء من الصفر. والرمز صالح خمس دقائق، فجهِّز الجهازين معًا قبل توليده.",
      ],
    },
    {
      heading: "ما الذي يحمي الملف فعليًا",
      body: [
        "كلا الوضعين أعلاه نقل فوري، وكلاهما يستخدم التشفير نفسه: تبادل مفاتيح X25519 يشتق مفتاحًا يُستخدم في AES-256-GCM لكل كتلة، ويُتفاوض عليه بين الجهازين فقط. وعند تفعيل «التحقّق المتقدّم» المعطَّل افتراضيًا يعرض الطرفان رمز التحقق نفسه المكوَّن من 6 أرقام (سلسلة مصادقة قصيرة، SAS) كي تتأكد من أن المفتاح المشتق لم يُستبدل: فلم ينتحل خادم الإشارات أو مُرحِّل TURN شخصية أي من الطرفين، ولم يُنهِ التشفير من الطرف إلى الطرف في طبقة التطبيق. وفي النقل بين الشبكات يظل TURN ضمن مسار البيانات، لكنه لا يحمل سوى النص المُشفَّر وليس نقطة نهاية للتشفير. ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256.",
        "لا يُخزَّن أي شيء على خادم في هذا الوضع — فهو لا يوجد إلا طوال مدة النقل. وRelayium مفتوح المصدر بموجب رخصة AGPL-3.0 على github.com/relayium/relayium، فآليته قابلة للتدقيق وليست صندوقًا أسود.",
      ],
    },
    {
      heading: "الحدود العملية، بكل صراحة",
      body: [
        "بما أن الملف لا يستقر على خادم أبدًا، فلا توجد حصة رفع — الحد الحقيقي هو المتصفح الذي يستقبل. متصفح حاسوب مكتبي يدعم واجهة File System Access (‏Chrome أو Edge على Windows أو Linux) يبثّ البيانات الواردة مباشرةً إلى القرص، فالملفات التي تبلغ عدة غيغابايت لا مشكلة فيها. أما Firefox وSafari وكل متصفحات الهواتف — بما فيها Chrome على Android — فلا تملك تلك الواجهة، فتُجمَّع الدفعة في الذاكرة بدلًا من ذلك، وينبّه Relayium المُستقبِل قبل القبول متى تجاوزت نحو 256 ميغابايت. واعتبر ذلك تقديرًا متحفّظًا عن قصد لا سقفًا مقيسًا: فالنقطة التي ينهار عندها فعلًا تتوقف على ذاكرة الجهاز ونظامه وعدد علامات التبويب المفتوحة.",
        "المجلدات تعمل أيضًا: اختر مجلدًا على الحاسوب المكتبي (لا على iOS) وتُحفَظ المسارات النسبية. إذا كان المتصفح المُستقبِل قادرًا على الكتابة مباشرةً في دليل مُختار (‏Chrome أو Edge على الحاسوب المكتبي) فإن الملفات تستقر في مكانها؛ وإلا (Firefox، Safari، وأي متصفح هاتف) يصل المجلد بأكمله في ملف .zip واحد يُفَك إلى البنية نفسها.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يوجد تطبيق AirDrop رسمي لنظام Windows أو Android؟",
        a: "لا — AirDrop حصري لأجهزة Apple، ولم تُطلق Apple قط عميلًا لـ Windows أو Android. وRelayium بديل يعمل في المتصفح: افتح relayium.com على الجهازين وسيعمل بالطريقة نفسها بصرف النظر عن المنصة، بما في ذلك الأزواج المختلطة من أجهزة Apple وغير Apple.",
      },
      {
        q: "هل أحتاج إلى حساب؟",
        a: "ليس في أسلوب نفس شبكة Wi-Fi — افتح الصفحة على الجهازين فيكتشف كل منهما الآخر، دون أي تسجيل دخول. أما الإرسال عبر شبكات مختلفة برمز اقتران فيتطلب من المُرسِل تسجيل الدخول؛ والشخص المُستقبِل لا يحتاج إلى حساب مطلقًا في أي من وضعي الشبكة.",
      },
      {
        q: "هل أحتاج إلى تثبيت أي شيء؟",
        a: "لا. إنه صفحة ويب على كل منصة — Windows وLinux وmacOS وAndroid وiOS — فلا شيء يُنزَّل من متجر ولا شيء يحتاج إلى تحديث مستمر.",
      },
      {
        q: "بمَ يختلف هذا عن مقارنة Relayium مقابل AirDrop؟",
        a: "ذلك المقال نظرة مباشرة تُقارِن بين ما يتفوق فيه AirDrop حقًا (المنازل التي تقتصر على أجهزة Apple) وما يقصّر فيه. أما هذا الدليل فهو الشرح العملي للحصول فعليًا على تجربة شبيهة بـ AirDrop حين لا يكون جهاز واحد على الأقل من أجهزة Apple.",
      },
      {
        q: "هل يمكنه الإرسال إلى مجموعة، كما يستطيع AirDrop؟",
        a: "ليس في مرة واحدة. الغرفة المحلية ليست مقصورة على جهازين، فكل جهاز فتح الصفحة من تلك الشبكة يُسرَد في الوقت نفسه — لكن النقل واحد إلى واحد: تفتح مساحة عمل مع مستلِم واحد، وإليه تذهب تلك الملفات. ولمشاركة الدفعة نفسها مع عدة أشخاص في الغرفة، تفتح مساحة عمل مع كل منهم بالتتابع. أما وضع رمز الاقتران للإرسال عبر الإنترنت فيصل بين جهازين اثنين فقط، عبر مُرحِّل مُشفَّر.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على جهازك بنظام Windows أو Linux أو Android وعلى الجهاز الذي تُرسِل إليه — دون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "AirDrop para Windows, Linux y Android",
  description:
    "No existe un AirDrop oficial para Windows, Linux ni Android — esto es lo más parecido: compartir al instante en la misma Wi-Fi desde el navegador, sin cuenta, sin instalación, además de una forma de llegar a través de internet que AirDrop no puede.",
  updatedLabel: "Última actualización",
  lead: [
    "AirDrop solo existe dentro del mundo de Apple, lo que deja a todos los demás — Windows, Linux, Android y cualquier hogar con una mezcla de dispositivos — sin un equivalente integrado. Esta guía muestra lo más parecido a AirDrop para dispositivos que no son de Apple: abre una página web en ambos extremos y el archivo simplemente se mueve.",
    "Funciona igual sea cual sea la plataforma, así que también cubre el caso que AirDrop nunca gestiona bien: un portátil con Windows, un ordenador de escritorio con Linux y un teléfono Android todos en la misma habitación, o los tres más un iPhone añadido.",
  ],
  sections: [
    {
      heading: "El flujo tipo AirDrop: misma Wi-Fi, en el navegador",
      body: [
        "Este es el caso cotidiano para el que se creó AirDrop, y Relayium lo iguala sin necesidad de una app de ninguna tienda.",
      ],
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Un navegador actual en cada dispositivo — Chrome o Edge en Windows, Firefox o Chrome en Linux, Chrome en Android. Nada de una tienda, nada que instalar.",
          "Los dos dispositivos en la misma Wi-Fi. A diferencia de AirDrop, el criterio no es la cercanía: el descubrimiento agrupa los dispositivos por la IP pública desde la que se conectan, así que un teléfono que sigue en datos móviles no aparecerá ni estando en la misma mesa.",
          "Acceso a internet en los dos, con la página abierta mediante https://relayium.com/. AirDrop no necesita internet en absoluto, mientras que estos dos navegadores sí tienen que llegar al punto de encuentro para hallarse, de modo que una red aislada pide una instancia autoalojada.",
          "Ni cuenta ni código de emparejamiento para el caso de la misma red — eso es justo lo que este flujo comparte con AirDrop.",
        ],
      },
      steps: [
        {
          text: "En cada dispositivo, abre la página de transferencia en el navegador.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compara la IP pública de la línea de estado en los dos. Compartir una dirección es lo que hace visibles a los dos dispositivos entre sí, y es la forma más rápida de descubrir el teléfono que nunca salió de los datos móviles.",
          code: ["Conectado · este dispositivo ThinkPad · IP pública 203.0.113.9"],
        },
        {
          text: "En el dispositivo que envía, busca el otro bajo «Dispositivos cercanos», elige su tarjeta y pulsa «Abrir espacio de trabajo». En un navegador actual esa es la única acción que ofrece una tarjeta, porque a partir de ahí archivos, carpetas y mensajes viajan todos por la única conexión cifrada que abre. Una sala puede listar varios dispositivos; abrir un espacio de trabajo es cómo eliges al único destinatario de esta transferencia, y abres otro cuando llega el turno de la siguiente persona.",
        },
        {
          text: "El espacio de trabajo sustituye a esa tarjeta. Envía desde los controles bajo su encabezado: «Enviar archivos» para un lote de hasta 1.000, «Enviar una carpeta» para un árbol completo allí donde el navegador ofrece elegir carpetas, o escribe en el cuadro de mensaje — «Enter para una nueva línea · ⌘/Ctrl+Enter para enviar» — y pulsa «Enviar». En el dispositivo que recibe, lee la línea bajo la solicitud antes de aceptar — dice si el navegador preguntará dónde guardar o escribirá en sus propias descargas — y después pulsa «Aceptar». Para comparar antes un código de verificación (SAS), activa «Verificación avanzada» en los dos dispositivos antes de empezar.",
        },
      ],
      success: {
        label: "Qué se ve cuando la transferencia funciona",
        body: [
          "A esas alturas la tarjeta del otro dispositivo ya no está — el espacio de trabajo ocupó su lugar —, así que lee el estado en el encabezado del espacio de trabajo: el dispositivo al que estás conectado, un estado de enlace «Conectado» y una única etiqueta de ruta que marca «Directo por LAN». El contador de archivos llega al último archivo del lote en las dos pantallas.",
          "Cómo aterriza una carpeta depende del navegador que recibe, así que comprueba el resultado en vez de suponerlo: Chrome y Edge en un ordenador escriben el árbol en el directorio que elegiste, mientras que Firefox, Safari y todos los navegadores de teléfono te entregan un único .zip que se descomprime con la misma estructura. La lista de descargas de ese navegador es donde lo confirmas — chrome://downloads en Chrome, edge://downloads en Edge, about:downloads en Firefox.",
        ],
        code: ["Conectado a Pixel · Conectado · Directo por LAN\nArchivo 8/8"],
      },
    },
    {
      heading: "Cuando el otro dispositivo no aparece",
      body: [
        "Empieza por el punto en que este flujo se aparta de AirDrop: lo que hace visibles a dos dispositivos entre sí es la red desde la que se conectan, no lo cerca que estén. Las comprobaciones de abajo son las primeras habituales más que una lista exhaustiva, y cada una lee su respuesta en la página en lugar de adivinarla.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El otro dispositivo está justo al lado y aun así no sale bajo «Dispositivos cercanos».",
            code: ["https://relayium.com/   # compara la IP pública de la línea de estado en los dos dispositivos"],
            fix: "Dos direcciones IP públicas distintas son dos salas, y la cercanía no arregla eso. Pon primero los dos dispositivos en la misma Wi-Fi y apaga los datos móviles en el teléfono. Una VPN o iCloud Private Relay en cualquiera de los lados es otro motivo frecuente de dos direcciones; si estás dispuesto a cambiarlos, corta la VPN o desactiva Private Relay solo para esa red, y recarga https://relayium.com/ ahí. Si prefieres dejarlos puestos, un código de emparejamiento en https://relayium.com/cross-network llega al otro dispositivo sin tocar ninguno de los dos ajustes.",
          },
          {
            symptom: "Los dos dispositivos muestran la misma IP pública y no aparece ninguna tarjeta.",
            code: ["https://relayium.com/   # la indicación bajo la lista de dispositivos nombra el ajuste del router"],
            fix: "El router separa a sus propios clientes. Desactiva «aislamiento de AP / aislamiento de clientes» en sus ajustes de Wi-Fi, o usa un código de emparejamiento en https://relayium.com/cross-network cuando el router no sea tuyo.",
          },
          {
            symptom: "En una red sin acceso a internet, la propia página no carga.",
            code: ["https://relayium.com/   # si nunca carga, la red no tiene ruta hasta el punto de encuentro"],
            fix: "Esta es la diferencia real frente a AirDrop, que se las arregla sin internet. Dos navegadores siguen necesitando alcanzar el punto de encuentro para presentarse, así que en una red aislada levanta tu propia instancia dentro de ella — Relayium está bajo AGPL-3.0 en github.com/relayium/relayium — o vuelve a una memoria USB.",
          },
          {
            symptom: "Antes de aceptar, el lado que recibe avisa de que el lote hay que sostenerlo en memoria.",
            code: ["chrome://downloads   # en Chrome; Edge tiene edge://downloads y Firefox about:downloads"],
            fix: "Firefox, Safari y todos los navegadores de teléfono carecen de la API File System Access, así que montan el lote en memoria y Relayium avisa a partir de unos 256 MiB. Recíbelo en Chrome o Edge en un ordenador, o manda menos archivos de una vez, y revisa cada llegada en la lista de descargas de ese navegador en lugar de dar por hecho que se guardó — chrome://downloads en Chrome, edge://downloads en Edge, about:downloads en Firefox.",
          },
          {
            symptom: "Una carpeta llegó como un único .zip en vez de como carpeta.",
            code: ["chrome://downloads   # en Chrome; sin selector de directorio, la entrada es un solo .zip"],
            fix: "Ese es el resultado esperado en un navegador sin selector de directorio, y el archivo se descomprime con la misma estructura y las rutas relativas intactas. Descomprímelo, o recibe la misma carpeta en Chrome o Edge de ordenador, que pide un directorio de destino y escribe el árbol dentro tal cual.",
          },
        ],
      },
    },
    {
      heading: "A través de internet: algo que AirDrop no puede hacer",
      body: [
        "AirDrop es solo de cercanía — sal del alcance de Bluetooth/Wi-Fi y deja de funcionar. El segundo modo de Relayium cubre exactamente ese hueco: dos dispositivos en redes completamente distintas, en cualquier parte del mundo. Eso sí, es una superficie distinta de un espacio de trabajo con un dispositivo cercano: una sala con código de emparejamiento conserva los controles anteriores separados por dispositivo, así que allí no hay ningún «Abrir espacio de trabajo» que pulsar.",
        "El remitente inicia sesión y obtiene un código de emparejamiento corto (con un enlace para unirse y un código QR); el destinatario lo introduce, escanea el QR o abre el enlace — y nunca necesita una cuenta. Esa conexión entre redes va por un retransmisor TURN cifrado en lugar de por un enlace directo, y es así por diseño: toma el retransmisor desde el principio, de modo que no depende de encontrar una ruta directa a través de los NAT y cortafuegos que hay entre dos redes ajenas la una a la otra, que pueden impedirla. Los archivos van sellados de extremo a extremo antes de salir del remitente, así que el retransmisor solo reenvía texto cifrado que no tiene clave para abrir — todo el trayecto sigue cifrado de extremo a extremo. Una conexión caída puede reanudarse en lugar de empezar de cero. El código vale cinco minutos, así que ten los dos dispositivos a mano antes de generarlo.",
      ],
    },
    {
      heading: "Qué protege realmente el archivo",
      body: [
        "Ambos modos anteriores son transferencias en tiempo real, y ambos usan el mismo cifrado: un intercambio de claves X25519 deriva una clave que se usa para AES-256-GCM por bloque, negociada solo entre los dos dispositivos. Con la verificación avanzada activada (desactivada por omisión), ambos lados muestran el mismo código de verificación de 6 dígitos (una Short Authentication String) para comprobar que la clave derivada no se ha sustituido: ni el servidor de señalización ni un retransmisor TURN han suplantado a ninguno de los extremos ni han terminado el cifrado de extremo a extremo de la capa de aplicación. En transferencias entre redes, TURN sigue estando en la ruta de los datos, pero solo transporta texto cifrado y no es un extremo del cifrado. Cada archivo se comprueba de extremo a extremo con un hash SHA-256.",
        "En este modo no se almacena nada en un servidor — existe solo durante la transferencia. Relayium es de código abierto bajo la licencia AGPL-3.0 en github.com/relayium/relayium, así que su mecánica es auditable en lugar de una caja negra.",
      ],
    },
    {
      heading: "Los límites prácticos, con honestidad",
      body: [
        "Como el archivo nunca llega a un servidor, no hay cuota de subida — el límite real es qué navegador está recibiendo. Un navegador de escritorio con la API File System Access (Chrome o Edge en Windows o Linux) transmite los datos entrantes directamente al disco, así que los archivos de varios gigabytes no dan problema. Firefox, Safari y todos los navegadores de móvil — incluido Chrome en Android — no tienen esa API, así que ahí la recepción se acumula en memoria y Relayium avisa a quien recibe antes de que acepte en cuanto se pasa de unos 256 MB. Tómalo como una estimación deliberadamente prudente, no como un techo medido: dónde cede de verdad depende de la memoria del dispositivo, de su sistema y de cuántas pestañas haya abiertas.",
        "Las carpetas también funcionan: elige una carpeta en el escritorio (no en iOS) y se conservan las rutas relativas. Si el navegador receptor puede escribir directamente en un directorio elegido (Chrome o Edge de escritorio) los archivos se colocan en su sitio; si no (Firefox, Safari, cualquier navegador de móvil) toda la carpeta llega como un único .zip que se descomprime con la misma estructura.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Hay una app oficial de AirDrop para Windows o Android?",
        a: "No — AirDrop es exclusivo de los dispositivos de Apple y Apple nunca ha lanzado un cliente para Windows ni Android. Relayium es un equivalente basado en navegador: abre relayium.com en ambos dispositivos y funciona igual sea cual sea la plataforma, incluidas las parejas mixtas de Apple y no Apple.",
      },
      {
        q: "¿Necesito una cuenta?",
        a: "No para el flujo en la misma Wi-Fi — abre la página en ambos dispositivos y se descubren, sin ningún inicio de sesión. Enviar entre redes distintas con un código de emparejamiento requiere que el remitente inicie sesión; la persona que recibe nunca necesita una cuenta, en ninguno de los dos modos de red.",
      },
      {
        q: "¿Necesito instalar algo?",
        a: "No. Es una página web en todas las plataformas — Windows, Linux, macOS, Android e iOS — así que no hay nada que descargar de una tienda ni nada que mantener actualizado.",
      },
      {
        q: "¿En qué se diferencia esto de la comparativa Relayium frente a AirDrop?",
        a: "Ese artículo es un análisis frente a frente de dónde AirDrop es genuinamente mejor (hogares puramente de Apple) y dónde se queda corto. Esta guía es el tutorial para conseguir de verdad la experiencia tipo AirDrop cuando al menos un dispositivo no es de Apple.",
      },
      {
        q: "¿Puede enviar a un grupo, como hace AirDrop?",
        a: "No de una sola vez. La sala local no se limita a dos dispositivos, así que todos los que abrieron la página desde esa red aparecen listados a la vez — pero una transferencia es uno a uno: abres un espacio de trabajo con un destinatario, y esos archivos van ahí. Compartir el mismo lote con varias personas de la sala significa abrir un espacio de trabajo con cada una por turno. El modo con código de emparejamiento para enviar a través de internet une exactamente a dos dispositivos, a través de un retransmisor cifrado.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en tu dispositivo Windows, Linux o Android y en aquel al que envías — sin cuenta necesaria en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "AirDrop para Windows, Linux e Android",
  description:
    "Não existe um AirDrop oficial para Windows, Linux ou Android — aqui está o mais próximo: compartilhamento instantâneo na mesma rede Wi-Fi pelo navegador, sem conta, sem instalação, além de um jeito de alcançar pela internet que o AirDrop não consegue.",
  updatedLabel: "Última atualização",
  lead: [
    "O AirDrop só existe dentro do mundo da Apple, o que deixa todos os demais — Windows, Linux, Android e qualquer casa com uma mistura de dispositivos — sem um equivalente embutido. Este guia mostra o mais próximo do AirDrop para dispositivos que não são da Apple: abra uma página web nas duas pontas e o arquivo simplesmente se move.",
    "Funciona da mesma forma independentemente da plataforma, então também cobre o caso que o AirDrop nunca lida bem: um notebook com Windows, um desktop com Linux e um celular Android todos na mesma sala, ou os três mais um iPhone incluído.",
  ],
  sections: [
    {
      heading: "O fluxo estilo AirDrop: mesma rede Wi-Fi, no navegador",
      body: [
        "Este é o caso do dia a dia para o qual o AirDrop foi feito, e o Relayium o iguala sem precisar de um app de nenhuma loja.",
      ],
      prereqs: {
        label: "O que você precisa",
        items: [
          "Um navegador atual em cada dispositivo — Chrome ou Edge no Windows, Firefox ou Chrome no Linux, Chrome no Android. Nada de loja, nada para instalar.",
          "Os dois dispositivos na mesma rede Wi-Fi. Ao contrário do AirDrop, o critério não é a proximidade: a descoberta agrupa os dispositivos pelo IP público de onde se conectam, então um celular ainda nos dados móveis não aparece nem em cima da mesma mesa.",
          "Acesso à internet funcionando nos dois, com a página aberta por https://relayium.com/. O AirDrop não precisa de internet nenhuma, enquanto estes dois navegadores precisam alcançar o ponto de encontro para se acharem, o que faz uma rede isolada pedir uma instância auto-hospedada.",
          "Nem conta nem código de emparelhamento no caso da mesma rede — é justamente isso que este fluxo tem em comum com o AirDrop.",
        ],
      },
      steps: [
        {
          text: "Em cada dispositivo, abra a página de transferência no navegador.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compare o IP público da linha de status nos dois. Compartilhar um endereço é o que torna os dois dispositivos visíveis um para o outro, e é o jeito mais rápido de flagrar o celular que nunca saiu dos dados móveis.",
          code: ["Conectado · este dispositivo ThinkPad · IP público 203.0.113.9"],
        },
        {
          text: "No dispositivo que envia, encontre o outro em “Dispositivos próximos”, escolha o cartão dele e pressione “Abrir área de trabalho”. Em um navegador atual essa é a única ação que um cartão oferece, porque a partir daí arquivos, pastas e mensagens passam todos pela única conexão criptografada que ela abre. Uma sala pode listar vários dispositivos; abrir uma área de trabalho é como você escolhe o único destinatário desta transferência, e abre outra quando chega a vez da próxima pessoa.",
        },
        {
          text: "A área de trabalho toma o lugar daquele cartão. Envie pelos controles abaixo do cabeçalho dela: “Enviar arquivos” para um lote de até 1.000, “Enviar uma pasta” para uma árvore inteira onde o navegador oferece escolher pastas, ou digite na caixa de mensagem — “Enter para uma nova linha · ⌘/Ctrl+Enter para enviar” — e pressione “Enviar”. No dispositivo que recebe, leia a linha abaixo do pedido antes de aceitar — ela diz se o navegador vai perguntar onde salvar ou gravar nos downloads dele — e depois clique em “Aceitar”. Para comparar antes um código de verificação (SAS), ligue a “Verificação avançada” nos dois dispositivos antes de começar.",
        },
      ],
      success: {
        label: "Como é uma transferência que funciona",
        body: [
          "A essa altura o cartão do outro dispositivo já não existe — a área de trabalho ocupou o lugar dele —, então leia o estado no cabeçalho da área de trabalho: o dispositivo a que você está conectado, um estado de vínculo “Conectado” e um único selo de caminho indicando “LAN direto”. O contador de arquivos vai até o último arquivo do lote nas duas telas.",
          "Como uma pasta chega depende do navegador que recebe, então confira o resultado em vez de supor: Chrome e Edge em computador gravam a árvore no diretório que você escolheu, enquanto Firefox, Safari e todo navegador de celular entregam um único .zip que se descompacta na mesma estrutura. A lista de downloads daquele navegador é onde você confirma isso — chrome://downloads no Chrome, edge://downloads no Edge, about:downloads no Firefox.",
        ],
        code: ["Conectado a Pixel · Conectado · LAN direto\nArquivo 8/8"],
      },
    },
    {
      heading: "Quando o outro dispositivo não aparece",
      body: [
        "Comece pelo ponto em que este fluxo difere do AirDrop: o que torna dois dispositivos visíveis um para o outro é a rede de onde se conectam, não o quão perto estão. As verificações abaixo são as primeiras usuais e não uma lista exaustiva, e cada uma lê a resposta na página em vez de adivinhar.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O outro dispositivo está bem ao lado e mesmo assim não aparece em “Dispositivos próximos”.",
            code: ["https://relayium.com/   # compare o IP público da linha de status nos dois dispositivos"],
            fix: "Dois endereços IP públicos diferentes são duas salas, e a proximidade não resolve isso. Coloque primeiro os dois dispositivos na mesma Wi-Fi e desligue os dados móveis no celular. Uma VPN ou o iCloud Private Relay em qualquer dos lados é outro motivo comum para dois endereços; se você estiver disposto a mudá-los, desligue a VPN ou desative o Private Relay só para aquela rede, e recarregue https://relayium.com/ ali. Se preferir deixá-los ligados, um código de emparelhamento em https://relayium.com/cross-network alcança o outro dispositivo sem tocar em nenhuma das duas configurações.",
          },
          {
            symptom: "Os dois dispositivos mostram o mesmo IP público e nenhum cartão aparece.",
            code: ["https://relayium.com/   # a dica abaixo da lista de dispositivos nomeia a configuração do roteador"],
            fix: "O roteador está separando os próprios clientes. Desative “isolamento de AP / isolamento de clientes” nas configurações de Wi-Fi dele, ou use um código de emparelhamento em https://relayium.com/cross-network quando o roteador não for seu para mexer.",
          },
          {
            symptom: "Em uma rede sem acesso à internet, a própria página não carrega.",
            code: ["https://relayium.com/   # se nunca carregar, a rede não tem rota até o ponto de encontro"],
            fix: "Essa é a diferença real em relação ao AirDrop, que dispensa a internet por completo. Dois navegadores ainda precisam alcançar o ponto de encontro para serem apresentados, então em uma rede isolada rode a sua própria instância dentro dela — o Relayium é AGPL-3.0 em github.com/relayium/relayium — ou volte ao pen drive.",
          },
          {
            symptom: "Antes de aceitar, o lado que recebe avisa que o lote precisa ser mantido na memória.",
            code: ["chrome://downloads   # no Chrome; o Edge tem edge://downloads e o Firefox about:downloads"],
            fix: "Firefox, Safari e todo navegador de celular não têm a API File System Access, então montam o lote na memória e o Relayium avisa acima de mais ou menos 256 MiB. Receba no Chrome ou no Edge de um computador, ou mande menos arquivos por vez, e confira cada chegada na lista de downloads daquele navegador em vez de supor que salvou — chrome://downloads no Chrome, edge://downloads no Edge, about:downloads no Firefox.",
          },
          {
            symptom: "Uma pasta chegou como um único .zip em vez de pasta.",
            code: ["chrome://downloads   # no Chrome; sem seletor de diretório, a entrada é um .zip só"],
            fix: "Esse é o resultado esperado em um navegador sem seletor de diretório, e o arquivo se descompacta na mesma estrutura com os caminhos relativos intactos. Descompacte, ou receba a mesma pasta no Chrome ou no Edge de computador, que pede um diretório de destino e grava a árvore lá dentro.",
          },
        ],
      },
    },
    {
      heading: "Pela internet: algo que o AirDrop não consegue fazer",
      body: [
        "O AirDrop é só de proximidade — saia do alcance de Bluetooth/Wi-Fi e ele para de funcionar. O segundo modo do Relayium cobre exatamente essa lacuna: dois dispositivos em redes completamente diferentes, em qualquer lugar do mundo. Só que é uma superfície separada de uma área de trabalho com um dispositivo próximo: uma sala com código de emparelhamento mantém os controles anteriores separados por dispositivo, então não há nenhum “Abrir área de trabalho” para pressionar ali.",
        "O remetente entra e recebe um código de emparelhamento curto (com um link de entrada e um código QR); o destinatário o digita, escaneia o QR ou abre o link — e nunca precisa de conta. Essa conexão entre redes passa por um retransmissor TURN criptografado em vez de uma ligação direta, e isso é proposital: ela usa o retransmissor desde o início, então não depende de encontrar uma rota direta através dos NATs e firewalls que existem entre duas redes sem relação uma com a outra, que podem impedi-la. Os arquivos saem selados de ponta a ponta antes de deixar o remetente, então o retransmissor só encaminha texto cifrado que não tem chave para abrir — o trajeto inteiro continua criptografado de ponta a ponta. Uma conexão caída pode ser retomada em vez de recomeçar do zero. O código vale cinco minutos, então deixe os dois aparelhos à mão antes de gerar um.",
      ],
    },
    {
      heading: "O que realmente protege o arquivo",
      body: [
        "Ambos os modos acima são transferências em tempo real, e ambos usam a mesma criptografia: uma troca de chaves X25519 deriva uma chave usada para AES-256-GCM por bloco, negociada apenas entre os dois dispositivos. Com a verificação avançada ativada (desligada por padrão), os dois lados exibem o mesmo código de verificação de 6 dígitos (uma Short Authentication String) para verificar que a chave derivada não foi substituída: nem o servidor de sinalização nem um retransmissor TURN se passaram por qualquer uma das pontas ou encerraram a criptografia de ponta a ponta da camada de aplicação. Em transferências entre redes, o TURN continua no caminho dos dados, mas só transporta texto cifrado e não é uma ponta da criptografia. Cada arquivo é verificado de ponta a ponta com um hash SHA-256.",
        "Nesse modo, nada é armazenado em um servidor — existe apenas durante a transferência. O Relayium é de código aberto sob a licença AGPL-3.0 em github.com/relayium/relayium, então a mecânica é auditável em vez de uma caixa-preta.",
      ],
    },
    {
      heading: "Os limites práticos, com honestidade",
      body: [
        "Como o arquivo nunca aterrissa em um servidor, não há cota de upload — o limite real é qual navegador está recebendo. Um navegador de computador com a API File System Access (Chrome ou Edge no Windows ou Linux) grava os dados que chegam direto no disco, então arquivos de vários gigabytes não são problema. Firefox, Safari e todos os navegadores de celular — Chrome no Android incluído — não têm essa API, então neles o lote é montado na memória, e o Relayium avisa quem recebe antes de aceitar assim que passa de cerca de 256 MB. Encare esse número como uma estimativa propositalmente conservadora, não como um teto medido: o ponto em que realmente cede depende da memória do aparelho, do sistema e de quantas abas estão abertas.",
        "Pastas também funcionam: escolha uma pasta no desktop (não no iOS) e os caminhos relativos são preservados. Se o navegador receptor puder gravar direto em um diretório escolhido (Chrome ou Edge no computador), os arquivos ficam em seus lugares; caso contrário (Firefox, Safari, qualquer navegador de celular), a pasta inteira chega como um único .zip que se descompacta com a mesma estrutura.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Existe um app oficial do AirDrop para Windows ou Android?",
        a: "Não — o AirDrop é exclusivo dos dispositivos da Apple e a Apple nunca lançou um cliente para Windows ou Android. O Relayium é um equivalente baseado em navegador: abra relayium.com nos dois dispositivos e ele funciona da mesma forma independentemente da plataforma, inclusive em pares mistos de Apple e não Apple.",
      },
      {
        q: "Preciso de uma conta?",
        a: "Não para o fluxo na mesma rede Wi-Fi — abra a página nos dois dispositivos e eles se descobrem, sem nenhum login. Enviar entre redes diferentes com um código de emparelhamento exige que o remetente entre; a pessoa que recebe nunca precisa de conta, em nenhum dos dois modos de rede.",
      },
      {
        q: "Preciso instalar alguma coisa?",
        a: "Não. É uma página web em toda plataforma — Windows, Linux, macOS, Android e iOS — então não há nada para baixar de uma loja nem nada para manter atualizado.",
      },
      {
        q: "Qual a diferença entre isto e a comparação Relayium versus AirDrop?",
        a: "Aquele artigo é uma análise frente a frente de onde o AirDrop é genuinamente melhor (casas puramente Apple) e onde ele fica aquém. Este guia é o tutorial para de fato obter a experiência estilo AirDrop quando pelo menos um dispositivo não é da Apple.",
      },
      {
        q: "Dá para enviar para um grupo, como o AirDrop faz?",
        a: "Não de uma vez. A sala local não se limita a dois dispositivos, então todo dispositivo que abriu a página daquela rede aparece listado ao mesmo tempo — mas uma transferência é um para um: você abre uma área de trabalho com um destinatário, e aqueles arquivos vão para ele. Compartilhar o mesmo lote com várias pessoas da sala significa abrir uma área de trabalho com cada uma por vez. O modo por código de emparelhamento para envio pela internet liga exatamente dois dispositivos, por um retransmissor criptografado.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium no seu dispositivo Windows, Linux ou Android e naquele para o qual está enviando — sem conta necessária na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/airdrop-for-windows-and-android",
  published: "2026-07-09",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
