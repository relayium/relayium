// web/scripts/pages/content/articles/howto-pc-to-phone-wirelessly.mjs
// How-to: send files from a PC to a phone wirelessly, no cable or cloud login.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical
// facts. Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

import { browserCrossNetworkSection } from "../realtime-facts.mjs";

const en = {
  title: "Send files from PC to phone wirelessly, no cable or app",
  description:
    "A step-by-step guide to moving files between a computer and a phone over Wi-Fi — drag and drop, no USB cable, no cloud account, and end-to-end encrypted the whole way.",
  updatedLabel: "Last updated",
  lead: [
    "Getting a file from your laptop onto your phone should not mean hunting for the right cable, emailing yourself, or uploading to a cloud drive and downloading it again. Relayium moves the bytes straight from your computer to your phone over your own Wi-Fi, in the browser, with nothing to install on either side.",
    "This guide walks through the wireless way step by step — same network or across networks — then compares it honestly with the usual alternatives (USB, Bluetooth, chat apps and email) so you can pick the right tool for the job.",
  ],
  sections: [
    {
      heading: "Send from PC to phone on the same Wi-Fi",
      body: [
        "This is the fastest path: both devices are on the same network, so they connect directly and the transfer is bounded only by your Wi-Fi. You need nothing but a browser on each device.",
      ],
      prereqs: {
        label: "Before you start",
        items: [
          "The computer and the phone on the same Wi-Fi, with the router not keeping its clients apart. The hint under the device list names the setting: “AP isolation / client isolation”.",
          "A browser on each, with the page open over https://relayium.com/. Encrypted transfer needs HTTPS, and over plain http:// the page says so instead of listing any devices.",
          "The phone's tab kept in front for the whole transfer. Relayium requests a screen wake lock where the browser offers one, which covers the screen switching off — it does not cover switching to another app, and a mobile browser may throttle or suspend a tab that goes to the background.",
          "No account on either device for a same-network transfer. Signing in becomes necessary only for the sender, and only when the two are on different networks and a pairing code has to be minted.",
        ],
      },
      steps: [
        {
          text: "On the computer, open the transfer page in any modern browser (Chrome, Edge, Firefox or Safari).",
          code: ["https://relayium.com/"],
        },
        {
          text: "Open the same page on the phone, then compare the public IP in the status pill on both screens. A matching address is what puts the two devices in one room — a phone that quietly stayed on mobile data shows a different one.",
          code: ["Connected · this device Pixel · public IP 203.0.113.9"],
        },
        {
          text: "On the computer, find the phone under “Nearby devices”, click its card and press “Open workspace”. On a current browser that is the single action the card offers, because files, folders and messages then all travel over the one encrypted connection it opens. Dragging files straight onto that card sends them without this step.",
        },
        {
          text: "The workspace replaces the card. Use the controls under its header to send: “Send files” for a batch of up to 1,000, “Send a folder” for a whole tree where the browser offers folder picking, or type into the message box — “Enter for a new line · ⌘/Ctrl+Enter to send” — and press “Send”.",
        },
        {
          text: "On the phone, read the line under the request before you accept — it says whether the browser will ask where to save or write straight to its Downloads folder — then press “Accept” and leave that tab in front until the file counter reaches the last file of the batch. To compare a verification code (SAS) before any bytes move, turn on “Advanced verification” on both devices before you start — it is off by default and adds a comparison plus an approval step, not encryption.",
        },
      ],
      success: {
        label: "What a finished transfer looks like",
        body: [
          "The phone's card is gone by then — the workspace took its place — so read the state off the workspace header: the device you are connected to, a link state of “Connected”, and one path badge reading “LAN direct”. The file counter on both screens ends on the last file of the batch.",
          "Then check the file, not the page. Where it landed is the phone browser's decision: Chrome and Firefox on Android put it in the browser's own downloads list — chrome://downloads and about:downloads respectively — and Safari on iOS puts it in the Downloads folder you can open in the Files app.",
        ],
        code: ["Connected to Pixel · Connected · LAN direct\nFile 1/1"],
      },
      bullets: [
        "A same-network room holds every device that opened the page from that network, so a tablet or a second laptop appearing next to the phone is normal.",
        "The 1,000-file cap is per batch rather than per session, so a very large tree can go over in several drops without reconnecting.",
      ],
    },
    {
      heading: "When the phone doesn't show up, or the transfer stops",
      body: [
        "The phone is usually the side that explains itself: it is on a different network than you thought, its tab went to the background, or its browser cannot hold what it was asked to hold. Those are the common first checks rather than the whole list, and each of them has something already on screen that decides it.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The phone never appears under “Nearby devices” on the computer.",
            code: ["https://relayium.com/   # compare the public IP in the status pill on both screens"],
            fix: "Two different public IP addresses mean two rooms. A phone that quietly stayed on mobile data is one common reason; a VPN or iCloud Private Relay sending it out through another address is another, and they are not the only ones. If you are willing to change them: join the Wi-Fi, switch the VPN off, or turn Private Relay off for that one network, then reload https://relayium.com/ on the phone. If you would rather leave them on, a pairing code on https://relayium.com/cross-network reaches the phone without touching either setting, and is end-to-end encrypted the same way.",
          },
          {
            symptom: "Both devices show the same public IP and the cards still do not appear.",
            code: ["https://relayium.com/   # the hint under the device list names the router setting"],
            fix: "The router is separating its own clients, which guest and hotel Wi-Fi often do by default. Turn off “AP isolation / client isolation”, or use a pairing code on https://relayium.com/cross-network when the router is not yours to change.",
          },
          {
            symptom: "The transfer starts and then stalls or fails after you switch apps on the phone.",
            code: ["https://relayium.com/   # the Relayium tab has to be the one in front on the phone"],
            fix: "A mobile browser may throttle or suspend a backgrounded tab, and while it does, no bytes move. Relayium's stall watchdog grants one fresh window after the page returns to the foreground rather than failing instantly, but the fix is to leave the tab in front — the wake lock Relayium requests only covers the screen turning off and buys no background execution, and older Safari and Android offer no wake lock to request at all.",
          },
          {
            symptom: "Before you accept, the phone warns that the whole batch has to be held in memory.",
            code: ["chrome://downloads   # in Chrome; Edge has edge://downloads and Firefox about:downloads"],
            fix: "Phone browsers have no File System Access API, so the batch is assembled in memory and Relayium warns past roughly 256 MiB. That figure is a cautious warning threshold rather than a hard cap: send fewer files at a time, or send the large one in the other direction into a desktop Chrome or Edge, which writes it straight to disk. Confirm each arrival in the receiving browser's own downloads list — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
          },
          {
            symptom: "The pairing code for the cross-network case is refused when the phone types it in.",
            code: ["https://relayium.com/cross-network   # the pairing card shows the countdown and any relay refusal"],
            fix: "A pairing code lives five minutes, and only the device that created it needs an account. Generate a fresh one and type it in straight away. If the card says relay is only issued to verified accounts, verify the sender's email address from the account panel first — the same-network flow above is unaffected by that.",
          },
        ],
      },
    },
    browserCrossNetworkSection.en,
    {
      heading: "Install it like an app (optional PWA)",
      body: [
        "Relayium is a website, so there is genuinely nothing to install. But if you send files often, you can add it to your home screen or desktop as a Progressive Web App: it then opens in its own window and launches like a native app, while still being just the web page under the hood.",
        "On the phone, use your browser's \"Add to Home Screen\" option; on the computer, use the install icon in the address bar. It stays free either way — Relayium is open source under the AGPL-3.0 license at github.com/relayium/relayium, and works on Windows, macOS, Linux, Android and iOS.",
      ],
    },
    {
      heading: "Big files: what your browser can handle",
      body: [
        "Because a realtime transfer never parks your files on a server, there is no upload quota to worry about. The practical limit is which browser is receiving.",
        "A browser with the File System Access API — Chrome or Edge on a desktop — streams incoming data straight to disk, so there is effectively no size cap; multi-gigabyte videos are fine. Firefox, Safari and every phone browser lack that API, so the batch is assembled in memory there instead, and Relayium warns you before you accept once it passes roughly 256 MB. Treat that as a deliberately cautious estimate rather than a hard limit — a phone tab of that size is easy for the OS to reclaim, and the real breaking point moves with the device's memory, its OS and how many tabs are open. Since the phone is the receiving end here, a very large file is better sent the other way, into a desktop Chrome or Edge that can stream it to disk.",
      ],
    },
    {
      heading: "Other ways to move files PC to phone (and their limits)",
      body: [
        "Wireless in the browser is not the only option, and the honest answer is that each alternative has its place. Here is how the common ones compare:",
      ],
      bullets: [
        "USB cable: reliable and fast, but you need the right cable, and phone-to-PC file access can be fiddly (especially iPhone to Windows). It is wired, not wireless.",
        "Bluetooth: truly cable-free, but slow — sending a few large photos can take minutes, and it is impractical for videos or large batches.",
        "Chat apps or emailing yourself (WeChat, Telegram, mail): convenient if you already have them open, but most impose size limits, may re-compress photos, and route your files through a third-party server rather than keeping them private.",
        "Relayium: wireless, no install, no account needed on the same network (only the sender signs in to pair across networks), no re-compression (byte-for-byte with a per-file SHA-256 integrity check), and end-to-end encrypted with a verification code you can check yourself.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does this work with Mac and Android, not just Windows and iPhone?",
        a: "Yes. Relayium runs in the browser on Windows, macOS, Linux, Android and iOS, so any combination works — Windows to Android, Mac to iPhone, Linux to a phone, and back the other way. There is nothing to install on either device.",
      },
      {
        q: "How fast is the transfer?",
        a: "On the same Wi-Fi the two devices connect directly, so speed is bounded by your local network rather than by any server — usually as fast as your Wi-Fi allows. Across different networks the transfer runs over an encrypted TURN relay by design, so it depends on both internet connections plus that extra hop; the payoff is that the connection does not depend on discovering a direct path through the NATs and firewalls in between, which can prevent one.",
      },
      {
        q: "Is it secure to send files this way?",
        a: "Yes. On top of the browser's transport encryption, Relayium adds its own layer: an X25519 key exchange derives a key used for per-chunk AES-256-GCM, and that key never touches a server. A matching 6-digit code (SAS) confirms the keys weren't replaced: a server or relay has not impersonated either endpoint or terminated the application-layer end-to-end encryption. Across networks, the TURN relay still sits in the transfer path, but it only forwards ciphertext it cannot decrypt. Each file is also verified end-to-end with a SHA-256 hash.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on your computer and your phone and send your first file wirelessly — no cable, no install, no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "电脑无线传文件到手机：不用数据线，不用装 App",
  description:
    "一步步教你在电脑和手机之间通过 Wi-Fi 传文件——拖拽即发，不用数据线，不用网盘账号，全程端到端加密。",
  updatedLabel: "最近更新",
  lead: [
    "把一个文件从笔记本弄到手机上，不该还得翻找合适的数据线、给自己发邮件，或者先上传到网盘再下载一遍。Relayium 通过你自己的 Wi-Fi，把文件字节直接从电脑传到手机，全程在浏览器里完成，两端都无需安装任何软件。",
    "本文一步步讲清无线传输的做法——同一网络或跨网络都行——再客观地和常见的几种替代方式（数据线、蓝牙、聊天软件和邮件）作对比，帮你为不同场景选对工具。",
  ],
  sections: [
    {
      heading: "同一 Wi-Fi 下，从电脑传到手机",
      body: [
        "这是最快的方式：两台设备在同一网络里，直接互连，传输速度只受你的 Wi-Fi 限制。除了浏览器，两边什么都不需要。",
      ],
      prereqs: {
        label: "开始之前",
        items: [
          "电脑和手机在同一个 Wi-Fi 里，并且路由器没有把客户端互相隔开。设备列表下方的提示写着那个开关的名字：「AP 隔离 / 客户端隔离」。",
          "两边各有一个浏览器，并且是通过 https://relayium.com/ 打开页面。加密传输需要 HTTPS，用普通 http:// 打开时页面会直接这么说，而不会列出任何设备。",
          "整个传输过程中手机上的这个标签页保持在最前面。只要浏览器提供，Relayium 会申请屏幕唤醒锁，这能盖住屏幕自动熄灭——但盖不住你切到别的 App，而手机浏览器可能会限速甚至挂起退到后台的标签页。",
          "同网络传输时两边都不需要账号。只有在两端处于不同网络、必须生成配对码时，发送方才需要登录。",
        ],
      },
      steps: [
        {
          text: "在电脑上用任意现代浏览器（Chrome、Edge、Firefox 或 Safari）打开传输页面。",
          code: ["https://relayium.com/"],
        },
        {
          text: "在手机上打开同一个页面，然后对比两块屏幕上状态条里的公网 IP。地址一致才会把两台设备放进同一个房间——如果手机悄悄留在移动数据上，它显示的会是另一个地址。",
          code: ["已连接 · 本机 Pixel · 公网 IP 203.0.113.9"],
        },
        {
          text: "在电脑上于「附近的设备」里找到手机，点它的卡片，然后按「打开工作区」。在当前浏览器上，这是卡片提供的唯一一个动作——因为接下来文件、文件夹和消息都走它打开的那一条加密连接。把文件直接拖到那张卡片上也能发出去，不必先经过这一步。",
        },
        {
          text: "工作区会取代那张卡片。用它标题栏下面的控件来发送：「发送文件」发一批（最多 1,000 个），浏览器支持选目录时用「发送文件夹」发整棵树，或者直接在消息框里打字——「回车换行 · ⌘/Ctrl+回车发送」——然后按「发送」。",
        },
        {
          text: "在手机上，先看请求下面那行再决定接收：它会说明浏览器是要问你存到哪，还是直接写进它的下载目录。然后按「接收」，并让那个标签页一直留在最前面，直到文件计数走到这一批的最后一个文件。如果想在任何字节移动之前核对校验码（SAS），开始前先在两台设备上打开「高级验证」——它默认关闭，打开后增加的是一次核对和一步确认，而不是加密。",
        },
      ],
      success: {
        label: "传输完成时是什么样",
        body: [
          "这时手机的卡片已经不在了——工作区取代了它——所以状态要从工作区标题栏上读：你连到了哪台设备、连接状态是「已连接」，以及唯一一个路径标签显示「局域网直连」。两块屏幕上的文件计数都停在这一批的最后一个文件。",
          "然后要检查的是文件，而不是页面。落在哪里由手机浏览器决定：Android 上的 Chrome 和 Firefox 会放进浏览器自己的下载列表（分别是 chrome://downloads 和 about:downloads），iOS 上的 Safari 会放进你可以在「文件」App 里打开的下载目录。",
        ],
        code: ["已连接到 Pixel · 已连接 · 局域网直连\n文件 1/1"],
      },
      bullets: [
        "同网络房间会容纳所有从该网络打开页面的设备，所以手机旁边多出一台平板或第二台笔记本是正常的。",
        "1,000 个文件的上限是按批而不是按会话算的，所以很大的目录树可以分几次拖过去，不用重新连接。",
      ],
    },
    {
      heading: "手机没出现，或者传输中断时",
      body: [
        "通常是手机那一侧会把原因摆出来：它其实不在你以为的那个网络里、它的标签页退到了后台，或者它的浏览器装不下被要求装的东西。这些是常见的首轮排查，而不是全部可能，而且每一项都有屏幕上现成的东西能判定。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "电脑上的「附近的设备」里始终没有手机。",
            code: ["https://relayium.com/   # 对比两块屏幕上状态条里的公网 IP"],
            fix: "两个不同的公网 IP 就是两个房间。手机悄悄留在移动数据上是常见原因之一；VPN 或 iCloud 专用代理把它从另一个地址送出去是另一种，而且都不是唯一可能。如果你愿意改这些设置：让它连上 Wi-Fi、断开 VPN，或只对这一个网络关闭专用代理，然后在手机上重新加载 https://relayium.com/。如果你更想保留它们，用 https://relayium.com/cross-network 上的配对码也能连到这台手机，两个设置都不用动，端到端加密同样成立。",
          },
          {
            symptom: "两台设备显示的公网 IP 相同，卡片却还是不出现。",
            code: ["https://relayium.com/   # 设备列表下方的提示写着要改的那个路由器开关"],
            fix: "路由器把自己的客户端隔开了，访客网络和酒店 Wi-Fi 经常默认这样。关闭「AP 隔离 / 客户端隔离」；如果路由器不由你改，就改用 https://relayium.com/cross-network 上的配对码。",
          },
          {
            symptom: "传输开始后，你在手机上切了别的 App，然后它就卡住或失败了。",
            code: ["https://relayium.com/   # 手机上 Relayium 这个标签页必须是最前面那个"],
            fix: "手机浏览器可能会限速甚至挂起退到后台的标签页，而在它这么做的时候字节根本不动。Relayium 的停滞看护在页面回到前台后会额外给一个完整窗口，而不是立刻判失败，但真正的解决办法是让标签页留在最前面——Relayium 申请的唤醒锁只盖住屏幕熄灭，并不能换来后台执行，而较旧的 Safari 和 Android 连唤醒锁都没有可申请的。",
          },
          {
            symptom: "还没点接收，手机就警告说整批文件必须放在内存里。",
            code: ["chrome://downloads   # Chrome 用这个 / Edge 用 edge://downloads / Firefox 用 about:downloads"],
            fix: "手机浏览器没有 File System Access API，所以整批内容会在内存里拼装，超过大约 256 MiB 时 Relayium 就会警告。这个数字是一个偏保守的警告线，不是硬上限：一次少发几个文件，或者把大文件改成反向发送，发给电脑上的 Chrome 或 Edge，由它直接写盘。每个文件是否真的到了，要在接收端浏览器自己的下载列表里确认——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
          },
          {
            symptom: "跨网络时手机输入配对码被拒绝。",
            code: ["https://relayium.com/cross-network   # 配对卡片上有倒计时，以及中继被拒的原因"],
            fix: "配对码有效期 5 分钟，而且只有生成它的那台设备需要账号。重新生成一个，然后立刻输入。如果卡片提示中继只发给已验证的账号，请先在账户面板里验证发送方的邮箱地址——上面那套同网络流程不受此影响。",
          },
        ],
      },
    },
    browserCrossNetworkSection.zh,
    {
      heading: "像 App 一样安装（可选的 PWA）",
      body: [
        "Relayium 就是一个网站，所以确实没有什么要安装的。但如果你经常传文件，可以把它添加到主屏幕或桌面，作为渐进式网页应用（PWA）：它会在独立窗口中打开，像原生应用一样启动，而底层依然只是那张网页。",
        "在手机上用浏览器的「添加到主屏幕」；在电脑上用地址栏里的安装图标。无论哪种方式它都保持免费——Relayium 采用 AGPL-3.0 许可开源，代码在 github.com/relayium/relayium，支持 Windows、macOS、Linux、Android 和 iOS。",
      ],
    },
    {
      heading: "大文件：你的浏览器能扛多大",
      body: [
        "由于实时传输从不把文件存到服务器上，所以不用担心任何上传配额。实际的上限取决于用哪个浏览器接收。",
        "支持 File System Access API 的浏览器——桌面版 Chrome、Edge——会把接收到的数据直接流式写入磁盘，因此几乎没有大小上限，几个 GB 的视频也没问题。Firefox、Safari 以及所有手机浏览器都没有这个 API，这时整批文件只能先攒在内存里，因此一旦超过约 256 MB，Relayium 会在你点「接收」之前先提示一次。这要当成刻意取的保守估计，而不是硬性上限——手机标签页到了这个量级本来就很容易被系统回收，真正的临界点还随设备内存、系统和标签页数量浮动。这里接收端是手机，所以真正很大的文件更适合反过来传：发到桌面端的 Chrome 或 Edge，那边可以直接流式写盘。",
      ],
    },
    {
      heading: "电脑传手机的其他方式（及其局限）",
      body: [
        "浏览器无线传输并不是唯一选择，而且说句实话，每种替代方式都有它的用武之地。常见的几种对比如下：",
      ],
      bullets: [
        "数据线：可靠又快，但你得有合适的线，而且手机到电脑的文件访问有时挺麻烦（尤其 iPhone 到 Windows）。它是有线的，不是无线。",
        "蓝牙：真正免线，但慢——发几张大照片就可能要好几分钟，传视频或大批文件很不现实。",
        "聊天软件或给自己发邮件（微信、Telegram、邮箱）：如果已经开着，用起来方便，但大多有大小限制、可能重新压缩照片，而且会把文件经由第三方服务器中转，而非保持私密。",
        "Relayium：无线、免安装、同一网络下免账号（跨网络配对仅需发送方登录）、不重新压缩（字节级传输并对每个文件做 SHA-256 完整性校验），且端到端加密，还带一个你能亲自核对的校验码。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Mac 和 Android 也行吗，不只是 Windows 和 iPhone？",
        a: "行。Relayium 在 Windows、macOS、Linux、Android 和 iOS 的浏览器里都能运行，所以任意组合都可以——Windows 传 Android、Mac 传 iPhone、Linux 传手机，反过来也一样。两端都无需安装任何东西。",
      },
      {
        q: "传输速度有多快？",
        a: "在同一 Wi-Fi 下，两台设备直接互连，所以速度由你的本地网络决定，而不受任何服务器限制——通常能跑满你的 Wi-Fi。跨网络时，传输按设计走加密 TURN 中继，因此速度取决于双方的网络以及中继这一跳；换来的是连接不依赖在中间的 NAT 和防火墙之间探测出一条直连路径——它们可能挡住这样的路径。",
      },
      {
        q: "这样传文件安全吗？",
        a: "安全。在浏览器的传输加密之上，Relayium 再加了一层：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密，这把密钥从不接触服务器。两台设备的 6 位校验码（SAS）一致，能确认密钥未被替换：服务器或中继没有冒充任一端，也没有终止应用层端到端加密。跨网络时，TURN 中继仍处于传输路径上，但只转发无法解密的密文。每个文件还会用 SHA-256 做端到端校验。",
      },
    ],
  },
  cta: {
    text: "在电脑和手机上同时打开 Relayium，无线发出你的第一个文件——不用数据线，不用安装，同一网络下也不用账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "PC からスマホへ無線でファイル転送：ケーブルもアプリも不要",
  description:
    "パソコンとスマホの間で Wi-Fi 経由でファイルを送る手順ガイド。ドラッグ＆ドロップだけ、USB ケーブル不要、クラウドのアカウント不要、しかも全行程がエンドツーエンド暗号化。",
  updatedLabel: "最終更新",
  lead: [
    "ノートPCのファイルをスマホに移すのに、合うケーブルを探したり、自分宛にメールしたり、クラウドにアップして再びダウンロードしたりする必要はないはずです。Relayium は自分の Wi-Fi を通じて、ファイルのバイトをパソコンからスマホへ直接送ります。すべてブラウザ内で完結し、どちらの端末にもインストールは要りません。",
    "本ガイドは無線での方法を段階的に説明します（同じネットワークでも、ネットワークをまたいでも）。そのうえで、よくある代替手段（USB、Bluetooth、チャットアプリ、メール）と公平に比較し、用途に合った手段を選べるようにします。",
  ],
  sections: [
    {
      heading: "同じ Wi-Fi で PC からスマホへ送る",
      body: [
        "これが最速の方法です。2台が同じネットワークにあるので直接つながり、転送速度は Wi-Fi だけに左右されます。必要なのは各端末のブラウザだけです。",
      ],
      prereqs: {
        label: "始める前に",
        items: [
          "パソコンとスマホが同じ Wi-Fi にあり、ルーターがクライアント同士を隔てていないこと。設定名は端末一覧の下のヒントに書かれています：「AP 分離 / クライアント分離」。",
          "両方にブラウザがあり、ページを https://relayium.com/ で開いていること。暗号化転送には HTTPS が必要で、素の http:// で開くと端末を一覧せずにその旨を表示します。",
          "転送中はスマホのタブを前面に置いたままにすること。ブラウザが対応していれば Relayium は画面のウェイクロックを要求し、画面が消えるのは防げます。ただし他のアプリへの切り替えは防げず、スマホのブラウザはバックグラウンドに回ったタブを絞ったり停止させたりすることがあります。",
          "同一ネットワークの転送では、どちらの端末にもアカウントは不要です。サインインが必要になるのは送信側だけで、しかも両者が別のネットワークにあってペアリングコードを発行する場合だけです。",
        ],
      },
      steps: [
        {
          text: "パソコンで、任意の最新ブラウザ（Chrome、Edge、Firefox、Safari）で転送ページを開きます。",
          code: ["https://relayium.com/"],
        },
        {
          text: "スマホでも同じページを開き、両方の画面のステータス表示にあるグローバル IP を比べます。同じアドレスであることが 2 台を同じルームに入れる条件です。気づかないうちにモバイル通信のままだったスマホは、別のアドレスを表示します。",
          code: ["接続済み · このデバイス Pixel · グローバル IP 203.0.113.9"],
        },
        {
          text: "パソコンで「近くのデバイス」からスマホを見つけ、そのカードをクリックして「ワークスペースを開く」を押します。最新のブラウザではカードが提供する動作はこれ 1 つだけです。というのも、以降はファイルもフォルダもメッセージも、そこで開かれる 1 本の暗号化接続を通るからです。ファイルをそのカードへ直接ドラッグすれば、この手順を経ずに送ることもできます。",
        },
        {
          text: "ワークスペースがそのカードに取って代わります。送信はヘッダーの下のコントロールで行います：1 バッチ最大 1,000 ファイルなら「ファイルを送信」、ブラウザがフォルダ選択に対応していればツリーごと「フォルダを送信」、あるいはメッセージ欄に入力して——「Enter で改行 · ⌘/Ctrl+Enter で送信」——「送信」を押します。",
        },
        {
          text: "スマホでは、受け入れる前にリクエストの下の行を読んでください。ブラウザが保存先を尋ねるのか、ダウンロード先へ直接書き込むのかが書かれています。読んだうえで「受信」を押し、ファイルカウンターがそのバッチの最後のファイルに達するまでそのタブを前面に置いたままにします。1 バイトも動く前に検証コード（SAS）を照合したい場合は、開始前に両方の端末で「高度な検証」をオンにしてください。既定はオフで、増えるのは照合と承認の一手間であって暗号化ではありません。",
        },
      ],
      success: {
        label: "転送が終わったときの画面",
        body: [
          "この時点でスマホのカードはもうありません——ワークスペースが取って代わったからです。状態はワークスペースのヘッダーから読みます：接続先のデバイス、「接続済み」というリンク状態、そして唯一の経路バッジ「LAN直結」。両方の画面のファイルカウンターはそのバッチの最後のファイルで止まります。",
          "その次に確かめるのはページではなくファイルです。どこに置かれるかはスマホのブラウザが決めます：Android の Chrome と Firefox はブラウザ自身のダウンロード一覧（それぞれ chrome://downloads と about:downloads）に入れ、iOS の Safari は「ファイル」アプリで開けるダウンロードフォルダに入れます。",
        ],
        code: ["Pixel に接続済み · 接続済み · LAN直結\nファイル 1/1"],
      },
      bullets: [
        "同一ネットワークのルームはそのネットワークからページを開いた端末をすべて収めるので、スマホの隣にタブレットや 2 台目のノート PC が現れるのは正常です。",
        "1,000 ファイルの上限はセッションごとではなくバッチごとなので、非常に大きなツリーは接続し直さずに何回かのドロップで送れます。",
      ],
    },
    {
      heading: "スマホが現れない、または転送が止まるとき",
      body: [
        "理由を明かすのはたいていスマホ側です。思っていたのとは別のネットワークにいる、タブがバックグラウンドに回った、あるいはブラウザが求められた量を抱えきれない。これらは網羅した一覧ではなく、まず当たるべき定番の確認事項で、どれも推測ではなく画面上にあるものだけで判断できます。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "パソコンの「近くのデバイス」にスマホがいつまでも現れない。",
            code: ["https://relayium.com/   # 両方の画面のステータス表示にあるグローバル IP を比べる"],
            fix: "グローバル IP が 2 つ違えばルームも 2 つです。気づかないうちにモバイル通信のままだったのはよくある原因の 1 つ、iCloud プライベートリレーや VPN が別アドレスから出しているのはもう 1 つで、どちらも唯一の原因ではありません。設定を変えてよいなら：Wi-Fi に参加する、VPN を切る、あるいはその 1 つのネットワークだけプライベートリレーをオフにする、のどれかを行い、スマホで https://relayium.com/ を再読み込みしてください。そのままにしておきたい場合は、https://relayium.com/cross-network のペアリングコードならどちらの設定にも触れずにそのスマホへ届き、エンドツーエンド暗号化も同じです。",
          },
          {
            symptom: "両方の端末が同じグローバル IP を表示しているのに、カードが現れない。",
            code: ["https://relayium.com/   # 端末一覧の下のヒントに、変更すべきルーター設定名がある"],
            fix: "ルーターが自分のクライアントを隔てています。ゲスト用やホテルの Wi-Fi では既定でそうなっていることが多いです。「AP 分離 / クライアント分離」をオフにするか、ルーターを変更できない場合は https://relayium.com/cross-network のペアリングコードを使ってください。",
          },
          {
            symptom: "転送が始まったあと、スマホで他のアプリに切り替えると止まる、または失敗する。",
            code: ["https://relayium.com/   # スマホでは Relayium のタブが前面にある必要がある"],
            fix: "スマホのブラウザはバックグラウンドのタブを絞ったり停止させたりすることがあり、そうしている間はバイトが動きません。Relayium の停滞監視はページが前面に戻ったあと即座に失敗させず 1 回分の猶予を与えますが、対処はタブを前面に置いたままにすることです。Relayium が要求するウェイクロックは画面が消えるのを防ぐだけでバックグラウンド実行までは得られず、古い Safari と Android には要求できるウェイクロックそのものがありません。",
          },
          {
            symptom: "受け入れる前に、スマホがバッチ全体をメモリに保持しなければならないと警告する。",
            code: ["chrome://downloads   # Chrome 用 / Edge は edge://downloads / Firefox は about:downloads"],
            fix: "スマホのブラウザには File System Access API がないため、バッチはメモリ上で組み立てられ、おおよそ 256 MiB を超えると Relayium が警告します。この数値は硬い上限ではなく慎重な警告線です。一度に送るファイルを減らすか、大きいものは向きを変えて、ディスクへ直接書き出せる PC の Chrome か Edge へ送ってください。何が実際に届いたかは、受信側のブラウザ自身のダウンロード一覧——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)——で確認します。",
          },
          {
            symptom: "ネットワークをまたぐ場合、スマホが入力したペアリングコードが拒否される。",
            code: ["https://relayium.com/cross-network   # ペアリングカードにカウントダウンとリレー拒否の理由が出る"],
            fix: "ペアリングコードの有効期限は5分で、アカウントが必要なのは発行した端末だけです。新しいコードを発行し、すぐに入力してください。カードにリレーは確認済みアカウントにのみ発行されると出る場合は、まずアカウントパネルで送信側のメールアドレスを確認してください。上の同一ネットワークの手順はその影響を受けません。",
          },
        ],
      },
    },
    browserCrossNetworkSection.ja,
    {
      heading: "アプリのようにインストール（任意の PWA）",
      body: [
        "Relayium はウェブサイトなので、本当にインストールするものはありません。ただ、頻繁に送るなら、ホーム画面やデスクトップにプログレッシブウェブアプリ（PWA）として追加できます。独立したウィンドウで開き、ネイティブアプリのように起動しますが、中身はあくまでそのウェブページです。",
        "スマホではブラウザの「ホーム画面に追加」を、パソコンではアドレスバーのインストールアイコンを使います。どちらでも無料のままです。Relayium は AGPL-3.0 ライセンスのオープンソースで、コードは github.com/relayium/relayium にあり、Windows、macOS、Linux、Android、iOS で動作します。",
      ],
    },
    {
      heading: "大きなファイル：ブラウザが扱える上限",
      body: [
        "リアルタイム転送はファイルをサーバーに置かないため、アップロードの割り当てを気にする必要はありません。実際の上限は、どのブラウザで受信するかで決まります。",
        "File System Access API を備えたブラウザ（パソコン版の Chrome や Edge）では受信データがそのままディスクへストリーミングされるので、事実上サイズの上限はなく、数ギガバイトの動画でも問題ありません。Firefox・Safari・スマホのブラウザにはこの API がないため、そこでは受信分をいったんメモリに溜めることになり、およそ 256 MB を超えると Relayium が受け取る前に警告を出します。これは実測した上限ではなく意図的に控えめに置いた目安と考えてください。その規模のスマホのタブは OS に回収されやすく、実際の限界も端末のメモリ・OS・開いているタブの数で動きます。ここでは受信側がスマホなので、本当に大きなファイルは逆向きに送り、ディスクへストリーミングできるパソコンの Chrome や Edge で受け取るほうが確実です。",
      ],
    },
    {
      heading: "PC からスマホへ送る他の方法（とその限界）",
      body: [
        "ブラウザでの無線転送だけが選択肢ではなく、正直に言えば、どの代替手段にもそれぞれの出番があります。よくあるものの比較は次のとおりです。",
      ],
      bullets: [
        "USB ケーブル：信頼できて速いですが、合うケーブルが要り、スマホから PC へのファイルアクセスは面倒なこともあります（特に iPhone から Windows）。有線であって無線ではありません。",
        "Bluetooth：本当にケーブル不要ですが遅く、大きな写真を数枚送るだけで数分かかることもあり、動画や大量のバッチには非現実的です。",
        "チャットアプリや自分宛メール（LINE、Telegram、メール）：すでに開いていれば便利ですが、多くはサイズ制限があり、写真を再圧縮することもあり、しかもファイルを第三者のサーバー経由で送るため私的なまま保てません。",
        "Relayium：無線、インストール不要、同じネットワークならアカウント不要（ネットワークをまたぐペアリングは送信側のサインインのみ）、再圧縮なし（ファイルごとの SHA-256 整合性チェック付きでバイト単位）、そして自分で確認できる検証コード付きのエンドツーエンド暗号化。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Windows と iPhone だけでなく、Mac や Android でも使えますか？",
        a: "はい。Relayium は Windows、macOS、Linux、Android、iOS のブラウザで動作するので、どの組み合わせでも使えます。Windows から Android、Mac から iPhone、Linux からスマホ、その逆も同様です。どちらの端末にもインストールするものはありません。",
      },
      {
        q: "転送はどのくらい速いですか？",
        a: "同じ Wi-Fi では2台が直接つながるため、速度はサーバーではなくローカルネットワークで決まり、たいてい Wi-Fi の許す限りの速さです。ネットワークをまたぐ場合、転送は設計上つねに暗号化 TURN リレー経由となるため、双方の回線とそのひと跳び分に左右されます。その代わり、接続の成立は、途中の NAT やファイアウォールを越える直接の経路を見つけられるかどうかに左右されません。NAT やファイアウォールが直接の経路を塞ぐこともあります。",
      },
      {
        q: "この方法でファイルを送っても安全ですか？",
        a: "はい。ブラウザの転送暗号化に加えて、Relayium は独自の層を重ねます。X25519 の鍵交換で導出した鍵をチャンクごとの AES-256-GCM に使い、その鍵はサーバーに触れません。両端末の6桁のコード（SAS）が一致すれば、鍵が差し替えられておらず、サーバーやリレーがどちらかの端末になりすましたり、アプリケーション層のエンドツーエンド暗号化を終端したりしていないことを確認できます。ネットワークをまたぐ場合、TURN リレーは引き続き転送経路上にありますが、復号できない暗号文だけを転送します。各ファイルは SHA-256 ハッシュでもエンドツーエンドに検証されます。",
      },
    ],
  },
  cta: {
    text: "パソコンとスマホで Relayium を開き、最初のファイルを無線で送ってみてください。ケーブルもインストールも不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "PC에서 폰으로 무선 파일 전송: 케이블도 앱도 필요 없이",
  description:
    "컴퓨터와 휴대폰 사이에서 Wi-Fi로 파일을 옮기는 단계별 가이드 — 드래그 앤 드롭, USB 케이블 없이, 클라우드 계정 없이, 게다가 전 과정 종단간 암호화.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "노트북의 파일을 휴대폰으로 옮기는 데 맞는 케이블을 찾거나, 자신에게 메일을 보내거나, 클라우드에 올렸다가 다시 내려받을 필요는 없어야 합니다. Relayium은 자신의 Wi-Fi를 통해 파일 바이트를 컴퓨터에서 휴대폰으로 곧장 보냅니다. 모두 브라우저 안에서 끝나며, 양쪽 기기 어디에도 설치할 것이 없습니다.",
    "이 가이드는 무선 방식을 단계별로 설명합니다 — 같은 네트워크든 서로 다른 네트워크든. 그런 다음 흔한 대안(USB, 블루투스, 채팅 앱, 메일)과 공정하게 비교해, 상황에 맞는 도구를 고를 수 있게 합니다.",
  ],
  sections: [
    {
      heading: "같은 Wi-Fi에서 PC에서 폰으로 보내기",
      body: [
        "이것이 가장 빠른 방법입니다. 두 기기가 같은 네트워크에 있어 직접 연결되고, 전송 속도는 오직 Wi-Fi에만 좌우됩니다. 각 기기의 브라우저 외에는 아무것도 필요 없습니다.",
      ],
      prereqs: {
        label: "시작하기 전에",
        items: [
          "컴퓨터와 휴대폰이 같은 Wi-Fi에 있고, 공유기가 클라이언트끼리를 갈라놓지 않아야 합니다. 기기 목록 아래 안내에 그 설정 이름이 적혀 있습니다: ‘AP 격리 / 클라이언트 격리’.",
          "양쪽에 브라우저가 있고, 페이지를 https://relayium.com/ 으로 열어야 합니다. 암호화 전송에는 HTTPS가 필요하며, 평범한 http:// 로 열면 기기를 나열하는 대신 그 사실을 알립니다.",
          "전송이 끝날 때까지 휴대폰의 탭을 맨 앞에 두어야 합니다. 브라우저가 지원하면 Relayium이 화면 웨이크 록을 요청해 화면이 꺼지는 것은 막지만, 다른 앱으로 전환하는 것은 막지 못하며 모바일 브라우저는 백그라운드로 간 탭을 조이거나 정지시킬 수 있습니다.",
          "같은 네트워크 전송에서는 어느 기기에도 계정이 필요 없습니다. 로그인은 보내는 쪽에만, 그것도 두 기기가 다른 네트워크에 있어 페어링 코드를 만들어야 할 때만 필요합니다.",
        ],
      },
      steps: [
        {
          text: "컴퓨터에서 최신 브라우저(Chrome, Edge, Firefox 또는 Safari)로 전송 페이지를 엽니다.",
          code: ["https://relayium.com/"],
        },
        {
          text: "휴대폰에서도 같은 페이지를 열고, 두 화면의 상태 표시에 있는 공인 IP를 비교합니다. 주소가 같아야 두 기기가 한 방에 들어갑니다. 슬그머니 모바일 데이터에 남아 있던 휴대폰은 다른 주소를 보여줍니다.",
          code: ["연결됨 · 내 기기 Pixel · 공인 IP 203.0.113.9"],
        },
        {
          text: "컴퓨터에서 “주변 기기”에서 휴대폰을 찾아 그 카드를 클릭하고 “작업 공간 열기”를 누릅니다. 최신 브라우저에서 카드가 제공하는 동작은 이 하나뿐입니다 — 이후 파일과 폴더와 메시지가 모두 그때 열리는 암호화된 연결 하나를 지나기 때문입니다. 파일을 그 카드 위로 바로 드래그하면 이 단계 없이도 보낼 수 있습니다.",
        },
        {
          text: "작업 공간이 그 카드를 대신합니다. 보내기는 헤더 아래의 컨트롤로 합니다: 한 배치에 최대 1,000개라면 “파일 보내기”, 브라우저가 폴더 선택을 지원하면 트리째 “폴더 보내기”, 또는 메시지 상자에 입력하고 — “Enter 로 줄바꿈 · ⌘/Ctrl+Enter 로 전송” — “보내기”를 누릅니다.",
        },
        {
          text: "휴대폰에서는 받기 전에 요청 아래 줄을 읽으세요. 브라우저가 저장 위치를 물을지, 다운로드 폴더에 바로 쓸지가 적혀 있습니다. 그다음 “받기”를 누르고, 파일 카운터가 그 배치의 마지막 파일에 닿을 때까지 그 탭을 맨 앞에 두세요. 한 바이트도 움직이기 전에 검증 코드(SAS)를 대조하려면 시작 전에 두 기기에서 “고급 검증”을 켜세요. 기본값은 꺼짐이고, 늘어나는 것은 대조와 승인 한 단계일 뿐 암호화가 아닙니다.",
        },
      ],
      success: {
        label: "전송이 끝났을 때의 화면",
        body: [
          "그때쯤 휴대폰 카드는 사라져 있습니다 — 작업 공간이 그 자리를 차지했으니까요. 상태는 작업 공간 헤더에서 읽습니다: 연결된 기기, “연결됨”이라는 링크 상태, 그리고 하나뿐인 경로 배지 “LAN 직접”. 두 화면의 파일 카운터는 그 배치의 마지막 파일에서 멈춥니다.",
          "그다음 확인할 것은 페이지가 아니라 파일입니다. 어디에 놓일지는 휴대폰 브라우저가 정합니다: Android의 Chrome과 Firefox는 브라우저 자체 다운로드 목록(각각 chrome://downloads 과 about:downloads)에 넣고, iOS의 Safari는 파일 앱에서 열 수 있는 다운로드 폴더에 넣습니다.",
        ],
        code: ["Pixel 에 연결됨 · 연결됨 · LAN 직접\n파일 1/1"],
      },
      bullets: [
        "같은 네트워크 방은 그 네트워크에서 페이지를 연 기기를 모두 담으므로, 휴대폰 옆에 태블릿이나 두 번째 노트북이 나타나는 것은 정상입니다.",
        "1,000개 상한은 세션당이 아니라 배치당이므로, 아주 큰 트리는 다시 연결하지 않고 여러 번 드롭해 보낼 수 있습니다.",
      ],
    },
    {
      heading: "휴대폰이 보이지 않거나 전송이 멈출 때",
      body: [
        "이유를 드러내는 쪽은 대개 휴대폰입니다. 생각했던 것과 다른 네트워크에 있거나, 탭이 백그라운드로 갔거나, 브라우저가 요구받은 양을 감당하지 못하는 경우입니다. 이것들은 전부가 아니라 흔한 1차 점검이며, 각 항목은 짐작이 아니라 이미 화면에 있는 것으로 판정됩니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "컴퓨터의 “주변 기기”에 휴대폰이 끝내 나타나지 않습니다.",
            code: ["https://relayium.com/   # 두 화면의 상태 표시에 있는 공인 IP를 비교한다"],
            fix: "공인 IP가 다르면 방도 둘입니다. 휴대폰이 슬그머니 모바일 데이터에 남아 있는 것이 흔한 이유 하나이고, VPN이나 iCloud 비공개 릴레이가 다른 주소로 내보내는 것이 또 하나이며, 이 둘만 있는 것도 아닙니다. 설정을 바꿔도 괜찮다면: Wi-Fi에 접속하거나, VPN을 끊거나, 그 한 네트워크에서만 비공개 릴레이를 끄고 휴대폰에서 https://relayium.com/ 을 다시 불러오세요. 그대로 두고 싶다면 https://relayium.com/cross-network 의 페어링 코드가 두 설정을 건드리지 않고 그 휴대폰에 닿으며, 종단간 암호화도 똑같습니다.",
          },
          {
            symptom: "두 기기가 같은 공인 IP를 보여주는데도 카드가 나타나지 않습니다.",
            code: ["https://relayium.com/   # 기기 목록 아래 안내에 바꿔야 할 공유기 설정 이름이 있다"],
            fix: "공유기가 자기 클라이언트를 갈라놓고 있습니다. 게스트망과 호텔 Wi-Fi가 기본으로 그렇게 합니다. ‘AP 격리 / 클라이언트 격리’를 끄거나, 공유기를 바꿀 수 없다면 https://relayium.com/cross-network 의 페어링 코드를 쓰세요.",
          },
          {
            symptom: "전송이 시작된 뒤 휴대폰에서 다른 앱으로 전환하면 멈추거나 실패합니다.",
            code: ["https://relayium.com/   # 휴대폰에서 Relayium 탭이 맨 앞에 있어야 한다"],
            fix: "모바일 브라우저는 백그라운드 탭을 조이거나 정지시킬 수 있고, 그러는 동안에는 바이트가 움직이지 않습니다. Relayium의 정지 감시는 페이지가 앞으로 돌아온 뒤 곧바로 실패시키지 않고 한 번의 여유를 주지만, 해법은 탭을 맨 앞에 두는 것입니다. Relayium이 요청하는 웨이크 록은 화면이 꺼지는 것만 막고 백그라운드 실행까지 주지는 않으며, 오래된 Safari와 Android에는 요청할 웨이크 록 자체가 없습니다.",
          },
          {
            symptom: "받기를 누르기 전에, 휴대폰이 배치 전체를 메모리에 담아야 한다고 경고합니다.",
            code: ["chrome://downloads   # Chrome용 / Edge는 edge://downloads / Firefox는 about:downloads"],
            fix: "휴대폰 브라우저에는 File System Access API가 없어 배치가 메모리에서 조립되고, 대략 256 MiB를 넘으면 Relayium이 경고합니다. 그 숫자는 단단한 상한이 아니라 조심스러운 경고선입니다. 한 번에 보내는 파일 수를 줄이거나, 큰 파일은 방향을 바꿔 디스크로 바로 쓰는 컴퓨터의 Chrome이나 Edge로 보내세요. 실제로 무엇이 도착했는지는 받는 쪽 브라우저 자체의 다운로드 목록 — chrome://downloads (Chrome), edge://downloads (Edge), about:downloads (Firefox) — 에서 확인하세요.",
          },
          {
            symptom: "네트워크를 넘는 경우, 휴대폰이 입력한 페어링 코드가 거부됩니다.",
            code: ["https://relayium.com/cross-network   # 페어링 카드에 남은 시간과 릴레이 거부 이유가 보인다"],
            fix: "페어링 코드는 5분 동안만 살아 있고, 계정이 필요한 쪽은 코드를 만든 기기뿐입니다. 새로 만들고 곧바로 입력하세요. 카드에 릴레이가 인증된 계정에만 발급된다고 나오면, 먼저 계정 패널에서 보내는 쪽의 이메일 주소를 인증하세요. 위의 같은 네트워크 절차는 그 영향을 받지 않습니다.",
          },
        ],
      },
    },
    browserCrossNetworkSection.ko,
    {
      heading: "앱처럼 설치하기 (선택적 PWA)",
      body: [
        "Relayium은 웹사이트라서 정말로 설치할 것이 없습니다. 다만 자주 보낸다면 홈 화면이나 바탕화면에 프로그레시브 웹 앱(PWA)으로 추가할 수 있습니다. 그러면 독립된 창에서 열리고 네이티브 앱처럼 실행되지만, 속은 여전히 그 웹 페이지입니다.",
        "휴대폰에서는 브라우저의 '홈 화면에 추가'를, 컴퓨터에서는 주소창의 설치 아이콘을 씁니다. 어느 쪽이든 무료 그대로입니다 — Relayium은 AGPL-3.0 라이선스 오픈소스이며 코드는 github.com/relayium/relayium에 있고, Windows, macOS, Linux, Android, iOS에서 동작합니다.",
      ],
    },
    {
      heading: "큰 파일: 브라우저가 감당할 수 있는 크기",
      body: [
        "실시간 전송은 파일을 서버에 두지 않으므로 업로드 할당량을 걱정할 필요가 없습니다. 실제 상한은 어떤 브라우저로 받느냐에 달렸습니다.",
        "File System Access API가 있는 브라우저 — 데스크톱 Chrome, Edge — 에서는 들어오는 데이터가 곧장 디스크로 스트리밍되어 사실상 크기 상한이 없어, 수 기가바이트 동영상도 괜찮습니다. Firefox와 Safari, 그리고 모든 휴대폰 브라우저에는 그 API가 없어서 받은 내용을 일단 메모리에 모으게 되며, 대략 256 MB를 넘어서면 Relayium이 수락하기 전에 미리 경고합니다. 이 수치는 고정된 상한이 아니라 일부러 보수적으로 잡은 추정치로 보세요 — 그 정도 크기의 휴대폰 탭은 OS가 회수하기 쉽고, 실제 한계도 기기 메모리와 OS, 열어 둔 탭 수에 따라 움직입니다. 여기서는 받는 쪽이 휴대폰이므로, 정말 큰 파일이라면 반대 방향으로 보내 디스크로 스트리밍할 수 있는 데스크톱 Chrome이나 Edge에서 받는 편이 낫습니다.",
      ],
    },
    {
      heading: "PC에서 폰으로 옮기는 다른 방법 (그리고 그 한계)",
      body: [
        "브라우저 무선 전송만이 선택지는 아니며, 솔직히 말하면 각 대안마다 쓸모가 있습니다. 흔한 것을 비교하면 다음과 같습니다.",
      ],
      bullets: [
        "USB 케이블: 믿음직하고 빠르지만 맞는 케이블이 필요하고, 휴대폰에서 PC로의 파일 접근이 번거로울 수 있습니다(특히 iPhone에서 Windows). 무선이 아니라 유선입니다.",
        "블루투스: 정말로 케이블이 없지만 느립니다 — 큰 사진 몇 장 보내는 데 몇 분이 걸리기도 하고, 동영상이나 대량 배치에는 비현실적입니다.",
        "채팅 앱이나 자신에게 메일(카카오톡, Telegram, 메일): 이미 열려 있으면 편하지만 대부분 크기 제한이 있고, 사진을 다시 압축하기도 하며, 파일을 제3자 서버를 거쳐 보내 사적으로 유지되지 않습니다.",
        "Relayium: 무선, 설치 불필요, 같은 네트워크에서는 계정 불필요(네트워크를 넘는 페어링은 보내는 쪽 로그인만 필요), 재압축 없음(파일별 SHA-256 무결성 검사와 함께 바이트 단위), 그리고 직접 확인할 수 있는 검증 코드가 있는 종단간 암호화.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Windows와 iPhone뿐 아니라 Mac과 Android에서도 되나요?",
        a: "네. Relayium은 Windows, macOS, Linux, Android, iOS의 브라우저에서 동작하므로 어떤 조합이든 됩니다 — Windows에서 Android로, Mac에서 iPhone으로, Linux에서 휴대폰으로, 그리고 그 반대도 마찬가지입니다. 양쪽 기기 어디에도 설치할 것이 없습니다.",
      },
      {
        q: "전송은 얼마나 빠른가요?",
        a: "같은 Wi-Fi에서는 두 기기가 직접 연결되어 속도가 서버가 아닌 로컬 네트워크로 결정되며, 보통 Wi-Fi가 허락하는 만큼 빠릅니다. 서로 다른 네트워크에서는 설계상 전송이 암호화된 TURN 릴레이를 거치므로, 양쪽 인터넷 회선과 그 한 홉에 달려 있습니다. 대신 연결이 중간의 NAT와 방화벽을 통과하는 직접 경로를 찾아내는 데 의존하지 않습니다. NAT나 방화벽이 그런 경로를 막을 수도 있습니다.",
      },
      {
        q: "이렇게 파일을 보내도 안전한가요?",
        a: "네. 브라우저의 전송 암호화 위에 Relayium은 자체 계층을 더합니다. X25519 키 교환으로 도출한 키를 블록별 AES-256-GCM에 쓰며, 이 키는 서버에 닿지 않습니다. 두 기기의 6자리 코드(SAS)가 일치하면 키가 바뀌지 않았으며 서버나 릴레이가 어느 한쪽 끝점으로 위장하거나 애플리케이션 계층 종단간 암호화를 종료하지 않았음을 확인할 수 있습니다. 네트워크를 넘을 때 TURN 릴레이는 여전히 전송 경로에 있지만, 복호화할 수 없는 암호문만 전달합니다. 각 파일은 SHA-256 해시로도 종단간 검증됩니다.",
      },
    ],
  },
  cta: {
    text: "컴퓨터와 휴대폰에서 Relayium을 열고 첫 파일을 무선으로 보내 보세요 — 케이블도 설치도 필요 없고, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien vom PC drahtlos aufs Handy senden — ohne Kabel, ohne App",
  description:
    "Eine Schritt-für-Schritt-Anleitung, um Dateien per WLAN zwischen Computer und Handy zu bewegen — per Drag-and-drop, ohne USB-Kabel, ohne Cloud-Konto und durchgehend Ende-zu-Ende-verschlüsselt.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Eine Datei vom Laptop aufs Handy zu bekommen, sollte nicht bedeuten, das richtige Kabel zu suchen, sich selbst eine E-Mail zu schreiben oder etwas in eine Cloud hochzuladen und wieder herunterzuladen. Relayium bewegt die Bytes über dein eigenes WLAN direkt vom Computer aufs Handy, im Browser, ohne dass auf einer Seite etwas installiert werden muss.",
    "Diese Anleitung zeigt den drahtlosen Weg Schritt für Schritt — im selben Netz oder netzwerkübergreifend — und vergleicht ihn dann ehrlich mit den üblichen Alternativen (USB, Bluetooth, Chat-Apps und E-Mail), damit du das passende Werkzeug wählen kannst.",
  ],
  sections: [
    {
      heading: "Im selben WLAN vom PC aufs Handy senden",
      body: [
        "Das ist der schnellste Weg: Beide Geräte sind im selben Netz, verbinden sich also direkt, und die Übertragung ist nur durch dein WLAN begrenzt. Du brauchst nichts außer einem Browser auf jedem Gerät.",
      ],
      prereqs: {
        label: "Bevor du anfängst",
        items: [
          "Computer und Handy im selben WLAN, und der Router trennt seine Clients nicht voneinander. Wie die Einstellung heißt, steht im Hinweis unter der Geräteliste: „AP-Isolierung / Client-Isolierung“.",
          "Auf beiden ein Browser, mit der Seite über https://relayium.com/ geöffnet. Verschlüsselte Übertragung braucht HTTPS, und über einfaches http:// sagt die Seite das, statt Geräte aufzulisten.",
          "Der Tab auf dem Handy bleibt während der ganzen Übertragung vorn. Relayium fordert eine Bildschirm-Wake-Lock an, wo der Browser eine anbietet — das deckt den abschaltenden Bildschirm ab, nicht den Wechsel in eine andere App, und ein Handy-Browser kann einen Tab im Hintergrund ausbremsen oder einfrieren.",
          "Für eine Übertragung im selben Netz braucht keines der Geräte ein Konto. Anmelden muss sich nur die sendende Seite, und nur wenn beide in verschiedenen Netzen sind und ein Pairing-Code erzeugt werden muss.",
        ],
      },
      steps: [
        {
          text: "Öffne am Computer die Übertragungsseite in einem beliebigen modernen Browser (Chrome, Edge, Firefox oder Safari).",
          code: ["https://relayium.com/"],
        },
        {
          text: "Öffne dieselbe Seite auf dem Handy und vergleiche dann die öffentliche IP in der Statuszeile auf beiden Bildschirmen. Eine übereinstimmende Adresse steckt die beiden Geräte in einen Raum — ein Handy, das still auf Mobilfunk geblieben ist, zeigt eine andere.",
          code: ["Verbunden · dieses Gerät Pixel · öffentliche IP 203.0.113.9"],
        },
        {
          text: "Suche am Computer das Handy unter „Geräte in der Nähe“, klicke seine Karte an und drücke „Arbeitsbereich öffnen“. In einem aktuellen Browser ist das die einzige Aktion, die die Karte anbietet, denn Dateien, Ordner und Nachrichten laufen danach alle über die eine verschlüsselte Verbindung, die sie öffnet. Dateien direkt auf diese Karte zu ziehen sendet sie auch ohne diesen Schritt.",
        },
        {
          text: "Der Arbeitsbereich tritt an die Stelle der Karte. Gesendet wird mit den Bedienelementen unter seiner Kopfzeile: „Dateien senden“ für einen Stapel von bis zu 1.000 Dateien, „Ordner senden“ für einen ganzen Baum, wo der Browser die Ordnerauswahl anbietet, oder tippe ins Nachrichtenfeld — „Enter für neue Zeile · ⌘/Ctrl+Enter zum Senden“ — und drücke „Senden“.",
        },
        {
          text: "Lies auf dem Handy die Zeile unter der Anfrage, bevor du annimmst — sie sagt, ob der Browser nach dem Speicherort fragt oder direkt in seinen Download-Ordner schreibt —, drücke dann „Annehmen“ und lass diesen Tab vorn, bis der Dateizähler die letzte Datei des Stapels erreicht. Wer vor dem ersten Byte einen Verifizierungscode (SAS) vergleichen will, schaltet vor dem Start auf beiden Geräten „Erweiterte Verifizierung“ ein — standardmäßig aus, und hinzu kommt ein Vergleich samt Zustimmungsschritt, nicht die Verschlüsselung.",
        },
      ],
      success: {
        label: "So sieht eine fertige Übertragung aus",
        body: [
          "Die Karte des Handys ist dann verschwunden — der Arbeitsbereich hat ihren Platz übernommen —, also liest du den Zustand an der Kopfzeile des Arbeitsbereichs ab: das verbundene Gerät, ein Verbindungszustand „Verbunden“ und ein einziges Pfad-Abzeichen mit „LAN direkt“. Der Dateizähler endet auf beiden Bildschirmen bei der letzten Datei des Stapels.",
          "Danach prüfst du die Datei, nicht die Seite. Wo sie landet, entscheidet der Browser des Handys: Chrome und Firefox unter Android legen sie in ihre eigene Download-Liste — chrome://downloads beziehungsweise about:downloads —, Safari unter iOS in den Download-Ordner, den du in der Dateien-App öffnen kannst.",
        ],
        code: ["Verbunden mit Pixel · Verbunden · LAN direkt\nDatei 1/1"],
      },
      bullets: [
        "Ein Raum im selben Netz fasst jedes Gerät, das die Seite aus diesem Netz geöffnet hat — ein Tablet oder ein zweiter Laptop neben dem Handy ist also normal.",
        "Die Grenze von 1.000 Dateien gilt pro Stapel, nicht pro Sitzung: ein sehr großer Baum geht in mehreren Ablagen hinüber, ohne die Verbindung neu aufzubauen.",
      ],
    },
    {
      heading: "Wenn das Handy nicht auftaucht oder die Übertragung stehen bleibt",
      body: [
        "Meist ist es das Handy, das sich erklärt: Es ist in einem anderen Netz als gedacht, sein Tab ist in den Hintergrund gerutscht, oder sein Browser kann nicht halten, was von ihm verlangt wird. Das sind die üblichen ersten Prüfungen und nicht die ganze Liste, und für jede gibt es etwas auf dem Bildschirm, das sie entscheidet, statt etwas zu raten.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Das Handy erscheint am Computer nie unter „Geräte in der Nähe“.",
            code: ["https://relayium.com/   # die öffentliche IP in der Statuszeile auf beiden Bildschirmen vergleichen"],
            fix: "Zwei verschiedene öffentliche IP-Adressen bedeuten zwei Räume. Ein Handy, das still auf Mobilfunk geblieben ist, ist ein häufiger Grund; ein VPN oder iCloud Private Relay, das es über eine andere Adresse hinausschickt, ein weiterer — und sie sind nicht die einzigen. Wenn du sie ändern willst: ins WLAN wechseln, das VPN trennen oder Private Relay für dieses eine Netz ausschalten, dann https://relayium.com/ auf dem Handy neu laden. Willst du sie lieber anlassen, erreicht ein Pairing-Code auf https://relayium.com/cross-network das Handy, ohne eine der beiden Einstellungen anzutasten, und ist genauso Ende-zu-Ende verschlüsselt.",
          },
          {
            symptom: "Beide Geräte zeigen dieselbe öffentliche IP, und die Karten erscheinen trotzdem nicht.",
            code: ["https://relayium.com/   # der Hinweis unter der Geräteliste nennt die Router-Einstellung"],
            fix: "Der Router trennt seine eigenen Clients, was Gast- und Hotel-WLANs oft von Haus aus tun. Schalte „AP-Isolierung / Client-Isolierung“ aus, oder nimm einen Pairing-Code auf https://relayium.com/cross-network, wenn der Router nicht dir gehört.",
          },
          {
            symptom: "Die Übertragung startet und bleibt dann stehen oder scheitert, nachdem du auf dem Handy die App gewechselt hast.",
            code: ["https://relayium.com/   # auf dem Handy muss der Relayium-Tab der vorderste sein"],
            fix: "Ein Handy-Browser kann einen Tab im Hintergrund ausbremsen oder einfrieren, und solange er das tut, bewegt sich kein Byte. Relayiums Stillstandswächter gewährt nach der Rückkehr in den Vordergrund ein frisches Zeitfenster statt sofort abzubrechen, aber die Lösung ist, den Tab vorn zu lassen — die Wake-Lock, die Relayium anfordert, deckt nur den abschaltenden Bildschirm ab und verschafft keine Ausführung im Hintergrund, und ältere Safari- und Android-Versionen bieten überhaupt keine an.",
          },
          {
            symptom: "Vor dem Annehmen warnt das Handy, es müsse den ganzen Stapel im Speicher halten.",
            code: ["chrome://downloads   # in Chrome; Edge hat edge://downloads und Firefox about:downloads"],
            fix: "Handy-Browser haben keine File System Access API, der Stapel wird dort also im Speicher zusammengesetzt, und ab etwa 256 MiB warnt Relayium. Diese Zahl ist eine vorsichtige Warnschwelle und keine harte Grenze: schicke weniger Dateien auf einmal, oder schicke die große Datei in die andere Richtung, in ein Chrome oder Edge am Computer, das sie direkt auf die Platte streamt. Was tatsächlich ankam, prüfst du in der Download-Liste des empfangenden Browsers — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
          },
          {
            symptom: "Über Netzwerkgrenzen hinweg wird der Pairing-Code abgelehnt, den das Handy eintippt.",
            code: ["https://relayium.com/cross-network   # die Pairing-Karte zeigt den Countdown und eine Relay-Absage"],
            fix: "Ein Pairing-Code lebt fünf Minuten, und ein Konto braucht nur das Gerät, das ihn erzeugt hat. Erzeuge einen frischen und tippe ihn gleich ein. Steht auf der Karte, dass ein Relay nur an verifizierte Konten geht, dann bestätige zuerst im Kontobereich die E-Mail-Adresse der sendenden Seite — der Ablauf im selben Netz weiter oben ist davon unberührt.",
          },
        ],
      },
    },
    browserCrossNetworkSection.de,
    {
      heading: "Wie eine App installieren (optionale PWA)",
      body: [
        "Relayium ist eine Website, es gibt also wirklich nichts zu installieren. Wenn du aber oft Dateien sendest, kannst du sie als Progressive Web App (PWA) zum Startbildschirm oder Desktop hinzufügen: Sie öffnet sich dann in einem eigenen Fenster und startet wie eine native App, während sie im Kern weiterhin nur die Webseite ist.",
        "Nutze auf dem Handy die Option „Zum Startbildschirm hinzufügen“ deines Browsers; am Computer das Installationssymbol in der Adressleiste. Kostenlos bleibt es so oder so — Relayium ist quelloffen unter der AGPL-3.0-Lizenz auf github.com/relayium/relayium und läuft unter Windows, macOS, Linux, Android und iOS.",
      ],
    },
    {
      heading: "Große Dateien: was dein Browser bewältigt",
      body: [
        "Da eine Echtzeitübertragung deine Dateien nie auf einem Server ablegt, musst du dich um kein Upload-Kontingent kümmern. Die praktische Grenze hängt davon ab, welcher Browser empfängt.",
        "Ein Browser mit der File System Access API — Chrome oder Edge auf dem Desktop — streamt eingehende Daten direkt auf die Festplatte, es gibt also praktisch keine Größengrenze; Videos mit mehreren Gigabyte sind kein Problem. Firefox, Safari und sämtliche Handy-Browser haben diese API nicht, dort sammelt sich der Empfang stattdessen im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium dich, bevor du annimmst. Nimm das als bewusst vorsichtige Schätzung und nicht als harte Grenze — ein Handy-Tab dieser Größe holt sich das Betriebssystem leicht zurück, und der tatsächliche Knackpunkt verschiebt sich mit Arbeitsspeicher, Betriebssystem und Zahl der offenen Tabs. Da hier das Handy empfängt, schickst du etwas sehr Großes besser in die andere Richtung — an ein Chrome oder Edge am Desktop, das es auf die Festplatte streamen kann.",
      ],
    },
    {
      heading: "Andere Wege vom PC aufs Handy (und ihre Grenzen)",
      body: [
        "Drahtlos im Browser ist nicht die einzige Möglichkeit, und ehrlich gesagt hat jede Alternative ihren Platz. So schneiden die üblichen ab:",
      ],
      bullets: [
        "USB-Kabel: zuverlässig und schnell, aber du brauchst das richtige Kabel, und der Dateizugriff vom Handy zum PC kann fummelig sein (besonders iPhone zu Windows). Es ist kabelgebunden, nicht drahtlos.",
        "Bluetooth: wirklich kabellos, aber langsam — schon ein paar große Fotos können Minuten dauern, und für Videos oder große Stapel ist es unpraktisch.",
        "Chat-Apps oder E-Mail an sich selbst (WhatsApp, Telegram, Mail): praktisch, wenn schon geöffnet, aber die meisten haben Größenbeschränkungen, komprimieren Fotos womöglich neu und leiten deine Dateien über einen fremden Server, statt sie privat zu halten.",
        "Relayium: drahtlos, ohne Installation, im selben Netz ohne Konto (nur der Absender meldet sich für Pairing über Netzwerke hinweg an), ohne Neukomprimierung (byteweise mit SHA-256-Integritätsprüfung je Datei) und Ende-zu-Ende-verschlüsselt mit einem Verifizierungscode, den du selbst kontrollieren kannst.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Funktioniert das auch mit Mac und Android, nicht nur Windows und iPhone?",
        a: "Ja. Relayium läuft im Browser unter Windows, macOS, Linux, Android und iOS, jede Kombination funktioniert also — Windows zu Android, Mac zu iPhone, Linux zu einem Handy und umgekehrt. Auf keinem Gerät muss etwas installiert werden.",
      },
      {
        q: "Wie schnell ist die Übertragung?",
        a: "Im selben WLAN verbinden sich die beiden Geräte direkt, die Geschwindigkeit hängt also von deinem lokalen Netz ab und nicht von einem Server — meist so schnell, wie dein WLAN es erlaubt. Netzwerkübergreifend läuft die Übertragung von vornherein über ein verschlüsseltes TURN-Relay, hängt also von beiden Internetverbindungen plus diesem zusätzlichen Sprung ab; dafür hängt die Verbindung nicht davon ab, einen direkten Pfad durch die NATs und Firewalls dazwischen zu finden — die einen solchen Pfad verhindern können.",
      },
      {
        q: "Ist es sicher, Dateien so zu senden?",
        a: "Ja. Zusätzlich zur Transportverschlüsselung des Browsers legt Relayium eine eigene Schicht darüber: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, und dieser Schlüssel erreicht nie einen Server. Stimmen die sechsstelligen Codes (SAS) beider Geräte überein, bestätigt das, dass die Schlüssel nicht ausgetauscht wurden: Ein Server oder Relay hat sich weder als einer der Endpunkte ausgegeben noch die Ende-zu-Ende-Verschlüsselung der Anwendungsschicht beendet. Netzwerkübergreifend bleibt das TURN-Relay im Übertragungspfad, leitet aber nur Chiffretext weiter, den es nicht entschlüsseln kann. Jede Datei wird außerdem per SHA-256-Hash Ende-zu-Ende geprüft.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf deinem Computer und deinem Handy und sende deine erste Datei drahtlos — kein Kabel, keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer des fichiers du PC au téléphone sans fil, sans câble ni appli",
  description:
    "Un guide pas à pas pour déplacer des fichiers entre un ordinateur et un téléphone par Wi-Fi — glisser-déposer, sans câble USB, sans compte cloud, et chiffré de bout en bout tout du long.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Faire passer un fichier de votre ordinateur portable à votre téléphone ne devrait pas obliger à chercher le bon câble, à s'envoyer un e-mail à soi-même, ou à téléverser vers un cloud pour le retélécharger ensuite. Relayium déplace les octets directement de votre ordinateur vers votre téléphone via votre propre Wi-Fi, dans le navigateur, sans rien à installer d'un côté ou de l'autre.",
    "Ce guide détaille la méthode sans fil pas à pas — même réseau ou réseaux différents — puis la compare honnêtement aux solutions habituelles (USB, Bluetooth, applis de messagerie et e-mail), pour que vous choisissiez le bon outil selon le cas.",
  ],
  sections: [
    {
      heading: "Envoyer du PC au téléphone sur le même Wi-Fi",
      body: [
        "C'est la voie la plus rapide : les deux appareils sont sur le même réseau, ils se connectent donc directement et le transfert n'est limité que par votre Wi-Fi. Vous n'avez besoin que d'un navigateur sur chaque appareil.",
      ],
      prereqs: {
        label: "Avant de commencer",
        items: [
          "L'ordinateur et le téléphone sur le même Wi-Fi, avec un routeur qui ne sépare pas ses clients. L'indication sous la liste des appareils nomme le réglage : « l'isolation AP / isolation des clients ».",
          "Un navigateur sur chacun, avec la page ouverte via https://relayium.com/. Le transfert chiffré exige HTTPS, et en simple http:// la page le dit au lieu de lister le moindre appareil.",
          "L'onglet du téléphone gardé au premier plan pendant tout le transfert. Relayium demande un verrou d'écran là où le navigateur en propose un, ce qui couvre l'extinction de l'écran mais pas le passage à une autre application, et un navigateur mobile peut brider voire suspendre un onglet passé en arrière-plan.",
          "Aucun compte sur l'un ou l'autre appareil pour un transfert sur le même réseau. La connexion ne devient nécessaire que pour l'expéditeur, et seulement quand les deux sont sur des réseaux différents et qu'un code d'appairage doit être créé.",
        ],
      },
      steps: [
        {
          text: "Sur l'ordinateur, ouvrez la page de transfert dans n'importe quel navigateur moderne (Chrome, Edge, Firefox ou Safari).",
          code: ["https://relayium.com/"],
        },
        {
          text: "Ouvrez la même page sur le téléphone, puis comparez l'IP publique de la ligne d'état sur les deux écrans. Une adresse identique place les deux appareils dans une même salle : un téléphone resté discrètement en données mobiles en affiche une autre.",
          code: ["Connecté · cet appareil Pixel · IP publique 203.0.113.9"],
        },
        {
          text: "Sur l'ordinateur, trouvez le téléphone sous « Appareils à proximité », cliquez sa carte et appuyez sur « Ouvrir l’espace de travail ». Sur un navigateur actuel c'est la seule action que la carte propose, car fichiers, dossiers et messages passent ensuite tous par l'unique connexion chiffrée qu'elle ouvre. Glisser des fichiers directement sur cette carte les envoie aussi, sans cette étape.",
        },
        {
          text: "L'espace de travail remplace la carte. Pour envoyer, utilisez les commandes sous son en-tête : « Envoyer des fichiers » pour un lot d'au plus 1 000 fichiers, « Envoyer un dossier » pour une arborescence entière là où le navigateur propose de choisir un dossier, ou tapez dans la zone de message — « Entrée pour une nouvelle ligne · ⌘/Ctrl+Entrée pour envoyer » — puis appuyez sur « Envoyer ».",
        },
        {
          text: "Sur le téléphone, lisez la ligne sous la demande avant d'accepter — elle indique si le navigateur demandera où enregistrer ou écrira directement dans son dossier de téléchargements —, puis appuyez sur « Accepter » et laissez cet onglet au premier plan jusqu'à ce que le compteur atteigne le dernier fichier du lot. Pour comparer un code de vérification (SAS) avant le moindre octet, activez « Vérification avancée » sur les deux appareils avant de commencer : désactivée par défaut, elle ajoute une comparaison et une étape d'acceptation, pas le chiffrement.",
        },
      ],
      success: {
        label: "À quoi ressemble un transfert terminé",
        body: [
          "La carte du téléphone a disparu à ce stade — l'espace de travail a pris sa place —, alors lisez l'état sur l'en-tête de l'espace de travail : l'appareil auquel vous êtes connecté, un état de lien « Connecté », et un unique badge de chemin indiquant « LAN direct ». Le compteur de fichiers s'arrête sur le dernier fichier du lot sur les deux écrans.",
          "Ensuite, vérifiez le fichier et non la page. L'endroit où il atterrit relève du navigateur du téléphone : Chrome et Firefox sous Android le placent dans leur propre liste de téléchargements — chrome://downloads et about:downloads respectivement —, et Safari sous iOS dans le dossier Téléchargements que vous pouvez ouvrir dans l'app Fichiers.",
        ],
        code: ["Connecté à Pixel · Connecté · LAN direct\nFichier 1/1"],
      },
      bullets: [
        "Une salle du même réseau accueille tout appareil ayant ouvert la page depuis ce réseau, donc une tablette ou un second portable à côté du téléphone est normal.",
        "La limite de 1 000 fichiers vaut par lot et non par session : une très grande arborescence passe en plusieurs dépôts, sans reconnexion.",
      ],
    },
    {
      heading: "Quand le téléphone n'apparaît pas, ou que le transfert s'arrête",
      body: [
        "C'est en général le téléphone qui s'explique : il est sur un autre réseau que prévu, son onglet est passé en arrière-plan, ou son navigateur ne peut pas retenir ce qu'on lui demande. Ce sont les premières vérifications courantes plutôt que la liste complète, et chacune se tranche avec quelque chose déjà à l'écran plutôt qu'en devinant.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Le téléphone n'apparaît jamais sous « Appareils à proximité » sur l'ordinateur.",
            code: ["https://relayium.com/   # comparez l'IP publique de la ligne d'état sur les deux écrans"],
            fix: "Deux adresses IP publiques différentes, ce sont deux salles. Un téléphone resté discrètement en données mobiles est une raison courante ; un VPN ou iCloud Private Relay qui le fait sortir par une autre adresse en est une autre, et ce ne sont pas les seules. Si vous acceptez de les changer : rejoignez le Wi-Fi, coupez le VPN, ou désactivez Private Relay pour ce seul réseau, puis rechargez https://relayium.com/ sur le téléphone. Si vous préférez les laisser en place, un code d'appairage sur https://relayium.com/cross-network atteint le téléphone sans toucher ni l'un ni l'autre réglage, et reste chiffré de bout en bout de la même façon.",
          },
          {
            symptom: "Les deux appareils affichent la même IP publique et les cartes n'apparaissent toujours pas.",
            code: ["https://relayium.com/   # l'indication sous la liste des appareils nomme le réglage du routeur"],
            fix: "Le routeur sépare ses propres clients, ce que font souvent par défaut les Wi-Fi d'hôtel et d'invités. Désactivez « l'isolation AP / isolation des clients », ou passez par un code d'appairage sur https://relayium.com/cross-network quand le routeur ne vous appartient pas.",
          },
          {
            symptom: "Le transfert démarre puis se bloque ou échoue après un changement d'application sur le téléphone.",
            code: ["https://relayium.com/   # sur le téléphone, l'onglet Relayium doit être celui au premier plan"],
            fix: "Un navigateur mobile peut brider voire suspendre un onglet en arrière-plan, et pendant ce temps aucun octet ne circule. Le chien de garde de Relayium accorde une nouvelle fenêtre au retour au premier plan au lieu d'échouer aussitôt, mais la solution est de laisser l'onglet devant : le verrou que Relayium demande ne couvre que l'extinction de l'écran et n'achète aucune exécution en arrière-plan, et les anciens Safari et Android n'en proposent aucun à demander.",
          },
          {
            symptom: "Avant l'acceptation, le téléphone avertit qu'il doit garder tout le lot en mémoire.",
            code: ["chrome://downloads   # dans Chrome ; Edge a edge://downloads et Firefox about:downloads"],
            fix: "Les navigateurs de téléphone n'ont pas d'API File System Access, le lot y est donc assemblé en mémoire et Relayium avertit au-delà d'environ 256 MiB. Ce chiffre est un seuil d'alerte prudent et non une limite dure : envoyez moins de fichiers à la fois, ou envoyez le gros fichier dans l'autre sens, vers un Chrome ou Edge d'ordinateur qui l'écrit directement sur le disque. Ce qui est réellement arrivé se vérifie dans la liste de téléchargements du navigateur récepteur — chrome://downloads dans Chrome, edge://downloads dans Edge, about:downloads dans Firefox.",
          },
          {
            symptom: "Entre réseaux différents, le code d'appairage saisi sur le téléphone est refusé.",
            code: ["https://relayium.com/cross-network   # la carte d'appairage montre le décompte et tout refus de relais"],
            fix: "Un code d'appairage vit cinq minutes, et seul l'appareil qui l'a créé a besoin d'un compte. Générez-en un nouveau et saisissez-le tout de suite. Si la carte indique que le relais n'est délivré qu'aux comptes vérifiés, vérifiez d'abord l'adresse e-mail de l'expéditeur depuis le panneau du compte : le flux sur le même réseau ci-dessus n'en dépend pas.",
          },
        ],
      },
    },
    browserCrossNetworkSection.fr,
    {
      heading: "L'installer comme une appli (PWA facultative)",
      body: [
        "Relayium est un site web, il n'y a donc vraiment rien à installer. Mais si vous envoyez souvent des fichiers, vous pouvez l'ajouter à votre écran d'accueil ou à votre bureau en tant qu'application web progressive (PWA) : elle s'ouvre alors dans sa propre fenêtre et se lance comme une appli native, tout en restant, au fond, la même page web.",
        "Sur le téléphone, utilisez l'option « Ajouter à l'écran d'accueil » de votre navigateur ; sur l'ordinateur, l'icône d'installation dans la barre d'adresse. Cela reste gratuit dans tous les cas — Relayium est open source sous licence AGPL-3.0 sur github.com/relayium/relayium et fonctionne sous Windows, macOS, Linux, Android et iOS.",
      ],
    },
    {
      heading: "Gros fichiers : ce que votre navigateur peut gérer",
      body: [
        "Comme un transfert en temps réel ne stocke jamais vos fichiers sur un serveur, aucun quota de téléversement à surveiller. La limite pratique dépend du navigateur qui reçoit.",
        "Un navigateur doté de l'API File System Access — Chrome ou Edge sur ordinateur — écrit les données entrantes en flux directement sur le disque : en pratique, aucune limite de taille, des vidéos de plusieurs gigaoctets passent sans souci. Firefox, Safari et tous les navigateurs de téléphone n'ont pas cette API : la réception y est assemblée en mémoire, et Relayium vous prévient avant que vous acceptiez dès que l'on dépasse environ 256 Mo. À considérer comme une estimation volontairement prudente plutôt qu'une limite ferme — un onglet de téléphone de cette taille est facile à récupérer pour le système, et le point de rupture réel varie avec la mémoire de l'appareil, son système et le nombre d'onglets ouverts. Comme c'est ici le téléphone qui reçoit, mieux vaut envoyer un très gros fichier dans l'autre sens, vers un Chrome ou Edge de bureau capable de l'écrire en flux sur le disque.",
      ],
    },
    {
      heading: "Autres façons de transférer du PC au téléphone (et leurs limites)",
      body: [
        "Le sans-fil dans le navigateur n'est pas la seule option, et honnêtement, chaque solution a sa place. Voici comment les plus courantes se comparent :",
      ],
      bullets: [
        "Câble USB : fiable et rapide, mais il faut le bon câble, et l'accès aux fichiers du téléphone vers le PC peut être capricieux (surtout iPhone vers Windows). C'est filaire, pas sans fil.",
        "Bluetooth : vraiment sans câble, mais lent — envoyer quelques grandes photos peut prendre des minutes, et c'est impraticable pour des vidéos ou de gros lots.",
        "Applis de messagerie ou e-mail à soi-même (WhatsApp, Telegram, mail) : pratique si c'est déjà ouvert, mais la plupart imposent des limites de taille, peuvent recompresser les photos, et font transiter vos fichiers par un serveur tiers au lieu de les garder privés.",
        "Relayium : sans fil, sans installation, sans compte sur le même réseau (l'expéditeur se connecte seulement pour s'appairer entre réseaux différents), sans recompression (octet pour octet avec une vérification d'intégrité SHA-256 par fichier), et chiffré de bout en bout avec un code de vérification que vous pouvez contrôler vous-même.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Est-ce que cela marche avec Mac et Android, pas seulement Windows et iPhone ?",
        a: "Oui. Relayium tourne dans le navigateur sous Windows, macOS, Linux, Android et iOS, donc toute combinaison fonctionne — Windows vers Android, Mac vers iPhone, Linux vers un téléphone, et inversement. Il n'y a rien à installer sur aucun des appareils.",
      },
      {
        q: "À quelle vitesse se fait le transfert ?",
        a: "Sur le même Wi-Fi, les deux appareils se connectent directement, la vitesse est donc limitée par votre réseau local et non par un serveur — en général aussi rapide que votre Wi-Fi le permet. Entre réseaux différents, le transfert passe par conception par un relais TURN chiffré : cela dépend donc des deux connexions internet et de ce saut supplémentaire, mais la connexion ne dépend pas de la découverte d'un chemin direct à travers les NAT et pare-feu intermédiaires, qui peuvent en empêcher un.",
      },
      {
        q: "Est-ce sûr d'envoyer des fichiers ainsi ?",
        a: "Oui. Par-dessus le chiffrement de transport du navigateur, Relayium ajoute sa propre couche : un échange de clés X25519 dérive une clé utilisée pour un AES-256-GCM par bloc, et cette clé n'atteint jamais un serveur. La concordance des codes à 6 chiffres (SAS) confirme que les clés n'ont pas été substituées : aucun serveur ou relais ne s'est fait passer pour l'un des terminaux ni n'a terminé le chiffrement de bout en bout de la couche applicative. Entre réseaux, le relais TURN reste sur le trajet du transfert, mais ne transmet que du texte chiffré qu'il ne peut pas déchiffrer. Chaque fichier est aussi vérifié de bout en bout par une empreinte SHA-256.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur votre ordinateur et votre téléphone et envoyez votre premier fichier sans fil — sans câble, sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال الملفات من الحاسوب إلى الهاتف لاسلكيًا، دون كابل أو تطبيق",
  description:
    "دليل خطوة بخطوة لنقل الملفات بين الحاسوب والهاتف عبر Wi-Fi — بالسحب والإفلات، دون كابل USB، دون حساب سحابي، ومع التشفير من الطرف إلى الطرف طوال الطريق.",
  updatedLabel: "آخر تحديث",
  lead: [
    "نقل ملف من حاسوبك المحمول إلى هاتفك لا ينبغي أن يعني البحث عن الكابل المناسب، أو إرسال بريد إلكتروني إلى نفسك، أو الرفع إلى قرص سحابي ثم تنزيله من جديد. ينقل Relayium البايتات مباشرةً من حاسوبك إلى هاتفك عبر شبكة Wi-Fi لديك، داخل المتصفح، دون أي شيء لتثبيته على أي من الجهازين.",
    "يشرح هذا الدليل الطريقة اللاسلكية خطوة بخطوة — على نفس الشبكة أو عبر الشبكات — ثم يقارنها بصدق مع البدائل المعتادة (USB، بلوتوث، تطبيقات المحادثة والبريد الإلكتروني) حتى تختار الأداة المناسبة للمهمة.",
  ],
  sections: [
    {
      heading: "الإرسال من الحاسوب إلى الهاتف على نفس شبكة Wi-Fi",
      body: [
        "هذا هو المسار الأسرع: كلا الجهازين على نفس الشبكة، فيتصلان مباشرةً ولا يحدّ النقل سوى شبكة Wi-Fi لديك. لا تحتاج إلى شيء سوى متصفح على كل جهاز.",
      ],
      prereqs: {
        label: "قبل أن تبدأ",
        items: [
          "الحاسوب والهاتف على نفس شبكة Wi-Fi، والموجّه لا يفصل عملاءه عن بعضهم. التلميح أسفل قائمة الأجهزة يسمّي الإعداد: «عزل نقطة الوصول / عزل العملاء».",
          "متصفح على كل منهما، والصفحة مفتوحة عبر https://relayium.com/. يحتاج النقل المشفَّر إلى HTTPS، وعبر http:// المجرّد تقول الصفحة ذلك بدل أن تسرد أي جهاز.",
          "إبقاء تبويب الهاتف في المقدمة طوال النقل. يطلب Relayium قفل إبقاء الشاشة مضاءة حيث يوفّره المتصفح، وهذا يغطّي انطفاء الشاشة لا الانتقال إلى تطبيق آخر، كما قد يخفّض متصفح الهاتف سرعة التبويب الذي ينتقل إلى الخلفية أو يعلّقه.",
          "لا حساب على أي من الجهازين للنقل على نفس الشبكة. لا يصبح تسجيل الدخول لازمًا إلا للطرف المُرسِل، وفقط عندما يكون الجهازان على شبكتين مختلفتين ويجب توليد رمز اقتران.",
        ],
      },
      steps: [
        {
          text: "على الحاسوب، افتح صفحة النقل في أي متصفح حديث (Chrome أو Edge أو Firefox أو Safari).",
          code: ["https://relayium.com/"],
        },
        {
          text: "افتح الصفحة نفسها على الهاتف، ثم قارن عنوان IP العام في شريط الحالة على الشاشتين. تطابق العنوان هو ما يضع الجهازين في غرفة واحدة — أما الهاتف الذي ظلّ على بيانات الجوال بهدوء فسيعرض عنوانًا آخر.",
          code: ["متصل · هذا الجهاز Pixel · عنوان IP العام 203.0.113.9"],
        },
        {
          text: "على الحاسوب، اعثر على الهاتف تحت «الأجهزة القريبة»، وانقر بطاقته واضغط «فتح مساحة العمل». في المتصفحات الحديثة هذا هو الإجراء الوحيد الذي تعرضه البطاقة، لأن الملفات والمجلدات والرسائل تمرّ بعد ذلك كلها عبر الاتصال المشفَّر الواحد الذي تفتحه. وسحب الملفات مباشرةً إلى تلك البطاقة يرسلها أيضًا دون هذه الخطوة.",
        },
        {
          text: "تحلّ مساحة العمل مكان البطاقة. أرسِل من عناصر التحكم أسفل ترويستها: «إرسال ملفات» لدفعة تصل إلى 1,000 ملف، و«إرسال مجلد» لشجرة كاملة حيث يوفّر المتصفح اختيار المجلدات، أو اكتب في صندوق الرسائل — «Enter لسطر جديد · ⌘/Ctrl+Enter للإرسال» — ثم اضغط «إرسال».",
        },
        {
          text: "على الهاتف، اقرأ السطر أسفل الطلب قبل القبول — فهو يقول إن كان المتصفح سيسأل عن مكان الحفظ أم سيكتب مباشرةً في مجلد التنزيلات الخاص به — ثم اضغط «قبول» وأبقِ ذلك التبويب في المقدمة حتى يبلغ عدّاد الملفات آخر ملف في الدفعة. وإن أردت مقارنة رمز التحقق (SAS) قبل أن يتحرك أي بايت، فعّل «التحقّق المتقدّم» على الجهازين قبل البدء — فهو معطَّل افتراضيًا ويضيف مقارنة وخطوة موافقة، لا التشفير.",
        },
      ],
      success: {
        label: "كيف يبدو نقل مكتمل",
        body: [
          "تكون بطاقة الهاتف قد اختفت عند هذه اللحظة — إذ حلّت مساحة العمل مكانها — فاقرأ الحالة من ترويسة مساحة العمل: الجهاز المتصل بك، وحالة رابط تقول «متصل»، ووسم مسار واحد يقرأ «مباشر عبر LAN». ويتوقف عدّاد الملفات على الشاشتين عند آخر ملف في الدفعة.",
          "بعد ذلك تحقّق من الملف لا من الصفحة. فمكان وصوله قرار متصفح الهاتف: يضعه Chrome وFirefox على Android في قائمة التنزيلات الخاصة بالمتصفح — chrome://downloads وabout:downloads على التوالي — ويضعه Safari على iOS في مجلد التنزيلات الذي يمكنك فتحه من تطبيق «الملفات».",
        ],
        code: ["متصل بـ Pixel · متصل · مباشر عبر LAN\nالملف 1/1"],
      },
      bullets: [
        "تسع غرفة نفس الشبكة كل جهاز فتح الصفحة من تلك الشبكة، فظهور لوح أو حاسوب محمول ثانٍ إلى جانب الهاتف أمر طبيعي.",
        "حد 1,000 ملف يخص الدفعة لا الجلسة، فالشجرة الضخمة يمكن أن تنتقل على عدة دفعات دون إعادة الاتصال.",
      ],
    },
    {
      heading: "عندما لا يظهر الهاتف أو يتوقف النقل",
      body: [
        "الهاتف عادةً هو الطرف الذي يفصح عن السبب: فهو على شبكة غير التي تظنها، أو انتقل تبويبه إلى الخلفية، أو لا يستطيع متصفحه حمل ما طُلب منه حمله. وهذه فحوص أولى شائعة لا قائمة شاملة، ولكل منها شيء موجود على الشاشة يحسمه بدل أن تخمّنه.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "لا يظهر الهاتف أبدًا تحت «الأجهزة القريبة» على الحاسوب.",
            code: ["https://relayium.com/   # قارن عنوان IP العام في شريط الحالة على الشاشتين"],
            fix: "عنوانا IP عامان مختلفان يعنيان غرفتين. وبقاء الهاتف على بيانات الجوال بهدوء سبب شائع، وإخراجه من عنوان آخر بواسطة VPN أو الترحيل الخاص في iCloud سبب شائع آخر، وليسا السببين الوحيدين. فإن كنت مستعدًا لتغييرها: انضم إلى شبكة Wi-Fi، أو اقطع VPN، أو أوقف الترحيل الخاص لهذه الشبكة وحدها، ثم أعِد تحميل https://relayium.com/ على الهاتف. وإن كنت تفضّل تركها كما هي، فرمز اقتران على https://relayium.com/cross-network يصل إلى الهاتف دون المساس بأي من الإعدادين، ومشفَّر من الطرف إلى الطرف بالطريقة نفسها.",
          },
          {
            symptom: "يعرض الجهازان نفس عنوان IP العام ومع ذلك لا تظهر البطاقات.",
            code: ["https://relayium.com/   # التلميح أسفل قائمة الأجهزة يسمّي إعداد الموجّه"],
            fix: "الموجّه يفصل عملاءه، وهو ما تفعله شبكات الضيوف والفنادق افتراضيًا في الغالب. أوقف «عزل نقطة الوصول / عزل العملاء»، أو استخدم رمز اقتران على https://relayium.com/cross-network إن لم يكن الموجّه بيدك لتغييره.",
          },
          {
            symptom: "يبدأ النقل ثم يتجمّد أو يفشل بعد أن تنتقل إلى تطبيق آخر على الهاتف.",
            code: ["https://relayium.com/   # يجب أن يكون تبويب Relayium هو الأمامي على الهاتف"],
            fix: "قد يخفّض متصفح الهاتف سرعة التبويب في الخلفية أو يعلّقه، وما دام يفعل ذلك فلا يتحرك أي بايت. ويمنح مراقب التجمّد في Relayium نافذة جديدة كاملة بعد عودة الصفحة إلى المقدمة بدل الفشل الفوري، لكن الحل هو إبقاء التبويب في المقدمة — فالقفل الذي يطلبه Relayium يغطّي انطفاء الشاشة فقط ولا يشتري تنفيذًا في الخلفية، والإصدارات الأقدم من Safari وAndroid لا توفّر قفلًا يُطلَب أصلًا.",
          },
          {
            symptom: "قبل القبول، يحذّر الهاتف من أنه سيحمل الدفعة كلها في الذاكرة.",
            code: ["chrome://downloads   # في Chrome / وEdge لديه edge://downloads / وFirefox لديه about:downloads"],
            fix: "لا تملك متصفحات الهواتف واجهة File System Access، فتُجمَّع الدفعة في الذاكرة ويحذّر Relayium بعد نحو 256 MiB. وهذا الرقم عتبة تحذير حصيفة وليس حدًا صارمًا: أرسِل ملفات أقل في المرة الواحدة، أو أرسِل الملف الكبير في الاتجاه المعاكس إلى Chrome أو Edge على حاسوب يكتبه إلى القرص مباشرةً. وتأكّد مما وصل فعلًا من قائمة التنزيلات الخاصة بالمتصفح المُستقبِل — chrome://downloads في Chrome، وedge://downloads في Edge، وabout:downloads في Firefox.",
          },
          {
            symptom: "عبر الشبكات، يُرفض رمز الاقتران الذي يكتبه الهاتف.",
            code: ["https://relayium.com/cross-network   # تُظهر بطاقة الاقتران العدّ التنازلي وأي رفض للمُرحِّل"],
            fix: "يعيش رمز الاقتران خمس دقائق، والجهاز الذي أنشأه وحده يحتاج حسابًا. أنشِئ رمزًا جديدًا واكتبه فورًا. وإن قالت البطاقة إن المُرحِّل لا يُمنح إلا للحسابات المُوثَّقة، فوثِّق بريد الطرف المُرسِل من لوحة الحساب أولًا — ولا يتأثر مسار نفس الشبكة أعلاه بذلك.",
          },
        ],
      },
    },
    browserCrossNetworkSection.ar,
    {
      heading: "ثبّته كتطبيق (تطبيق ويب تقدُّمي PWA اختياري)",
      body: [
        "Relayium موقع ويب، فلا يوجد فعلًا ما يُثبَّت. لكن إن كنت تُرسِل الملفات كثيرًا، فيمكنك إضافته إلى شاشتك الرئيسية أو سطح مكتبك كتطبيق ويب تقدُّمي (PWA): عندها يُفتح في نافذته الخاصة ويُطلَق كتطبيق أصلي، بينما يبقى في جوهره مجرد صفحة الويب نفسها.",
        "على الهاتف، استخدم خيار «إضافة إلى الشاشة الرئيسية» في متصفحك؛ وعلى الحاسوب، استخدم أيقونة التثبيت في شريط العنوان. يبقى مجانيًا في كلتا الحالتين — Relayium مفتوح المصدر بموجب رخصة AGPL-3.0 على github.com/relayium/relayium، ويعمل على Windows وmacOS وLinux وAndroid وiOS.",
      ],
    },
    {
      heading: "الملفات الكبيرة: ما يستطيع متصفحك تحمّله",
      body: [
        "لأن النقل الفوري لا يودِع ملفاتك أبدًا على خادم، فلا حصة رفع تقلق بشأنها. الحد العملي هو أي متصفح يستقبل.",
        "المتصفح الذي يدعم واجهة File System Access — ‏Chrome أو Edge على الحاسوب — يبثّ البيانات الواردة مباشرةً إلى القرص، فلا يوجد فعليًا حد للحجم؛ مقاطع الفيديو بحجم عدة غيغابايت لا مشكلة فيها. أما Firefox وSafari وكل متصفحات الهواتف فلا تملك تلك الواجهة، فتُجمَّع الدفعة في الذاكرة بدلًا من ذلك، وينبّهك Relayium قبل القبول متى تجاوزت نحو 256 ميغابايت. واعتبر ذلك تقديرًا متحفّظًا عن قصد لا حدًّا صارمًا — فعلامة تبويب على هاتف بهذا الحجم يسهل على النظام استرجاعها، ونقطة الانهيار الحقيقية تتحرك بحسب ذاكرة الجهاز ونظامه وعدد علامات التبويب المفتوحة. وبما أن المُستقبِل هنا هو الهاتف، فالأفضل إرسال الملف الضخم في الاتجاه المعاكس، إلى Chrome أو Edge على حاسوب يستطيع بثّه إلى القرص.",
      ],
    },
    {
      heading: "طرق أخرى لنقل الملفات من الحاسوب إلى الهاتف (وحدودها)",
      body: [
        "اللاسلكي في المتصفح ليس الخيار الوحيد، والجواب الصادق أن لكل بديل موضعه. إليك كيف تُقارَن البدائل الشائعة:",
      ],
      bullets: [
        "كابل USB: موثوق وسريع، لكنك تحتاج إلى الكابل المناسب، وقد يكون الوصول إلى ملفات الهاتف من الحاسوب مُربكًا (خاصةً من iPhone إلى Windows). إنه سلكي، لا لاسلكي.",
        "بلوتوث: خالٍ من الكابل حقًا، لكنه بطيء — قد يستغرق إرسال بضع صور كبيرة دقائق، وهو غير عملي للفيديوهات أو الدفعات الكبيرة.",
        "تطبيقات المحادثة أو إرسال بريد إلكتروني إلى نفسك (WeChat، Telegram، البريد): مريحة إن كانت مفتوحة لديك أصلًا، لكن معظمها يفرض حدود حجم، وقد يُعيد ضغط الصور، ويمرّر ملفاتك عبر خادم طرف ثالث بدلًا من إبقائها خاصة.",
        "Relayium: لاسلكي، بدون تثبيت، بدون حساب على نفس الشبكة (يسجّل المُرسِل الدخول فقط للاقتران عبر الشبكات)، بدون إعادة ضغط (بايتًا ببايت مع فحص سلامة SHA-256 لكل ملف)، ومشفَّر من الطرف إلى الطرف مع رمز تحقق يمكنك التأكد منه بنفسك.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يعمل هذا مع Mac وAndroid، لا مع Windows وiPhone فقط؟",
        a: "نعم. يعمل Relayium في المتصفح على Windows وmacOS وLinux وAndroid وiOS، فأي مزيج يعمل — من Windows إلى Android، ومن Mac إلى iPhone، ومن Linux إلى هاتف، والعكس أيضًا. لا يوجد ما يُثبَّت على أي من الجهازين.",
      },
      {
        q: "ما مدى سرعة النقل؟",
        a: "على نفس شبكة Wi-Fi يتصل الجهازان مباشرةً، فتتحدد السرعة بشبكتك المحلية لا بأي خادم — عادةً بأقصى سرعة تسمح بها شبكة Wi-Fi لديك. أما عبر شبكات مختلفة فيجري النقل بحكم التصميم عبر مُرحِّل TURN مُشفَّر، فيعتمد على كلا اتصالَي الإنترنت وعلى تلك القفزة الإضافية؛ والمقابل أن انعقاد الاتصال لا يعتمد على إيجاد مسار مباشر عبر ما بينهما من شبكات NAT وجدران حماية، وهي قد تمنع مثل هذا المسار.",
      },
      {
        q: "هل من الآمن إرسال الملفات بهذه الطريقة؟",
        a: "نعم. فوق تشفير النقل الذي يوفّره المتصفح، يضيف Relayium طبقته الخاصة: يشتقّ تبادل مفاتيح X25519 مفتاحًا يُستخدَم لتشفير AES-256-GCM لكل كتلة، وهذا المفتاح لا يلمس خادمًا أبدًا. يؤكد تطابق الرمز المكوَّن من 6 أرقام (SAS) أن المفاتيح لم تُستبدل: فلم ينتحل خادم أو مُرحِّل شخصية أي من الطرفين ولم يُنهِ التشفير من الطرف إلى الطرف على مستوى التطبيق. وعبر الشبكات يظل مُرحِّل TURN ضمن مسار النقل، لكنه لا يمرر إلا نصًا مشفّرًا لا يستطيع فك تشفيره. ويُتحقَّق أيضًا من كل ملف من الطرف إلى الطرف بتجزئة SHA-256.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على حاسوبك وهاتفك وأرسِل أول ملف لك لاسلكيًا — دون كابل، دون تثبيت، ودون حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Enviar archivos del PC al teléfono sin cables, sin cable ni app",
  description:
    "Una guía paso a paso para mover archivos entre un ordenador y un teléfono por Wi-Fi — arrastrar y soltar, sin cable USB, sin cuenta en la nube y con cifrado de extremo a extremo de principio a fin.",
  updatedLabel: "Última actualización",
  lead: [
    "Pasar un archivo del portátil al teléfono no debería obligarte a buscar el cable adecuado, enviarte un correo a ti mismo o subirlo a un disco en la nube para volver a descargarlo. Relayium mueve los bytes directamente de tu ordenador a tu teléfono a través de tu propia Wi-Fi, en el navegador, sin nada que instalar en ninguno de los dos lados.",
    "Esta guía recorre paso a paso la vía inalámbrica — en la misma red o entre redes — y luego la compara con honestidad con las alternativas habituales (USB, Bluetooth, apps de mensajería y correo) para que elijas la herramienta adecuada para cada caso.",
  ],
  sections: [
    {
      heading: "Enviar del PC al teléfono en la misma Wi-Fi",
      body: [
        "Esta es la vía más rápida: ambos dispositivos están en la misma red, así que se conectan directamente y la transferencia solo está limitada por tu Wi-Fi. No necesitas nada más que un navegador en cada dispositivo.",
      ],
      prereqs: {
        label: "Antes de empezar",
        items: [
          "El ordenador y el teléfono en la misma Wi-Fi, con un router que no separe a sus clientes. La indicación bajo la lista de dispositivos nombra el ajuste: «aislamiento de AP / aislamiento de clientes».",
          "Un navegador en cada uno, con la página abierta mediante https://relayium.com/. La transferencia cifrada necesita HTTPS, y con http:// a secas la página lo dice en lugar de listar ningún dispositivo.",
          "La pestaña del teléfono en primer plano durante toda la transferencia. Relayium pide un bloqueo de pantalla donde el navegador lo ofrece, lo que cubre que la pantalla se apague pero no que cambies de aplicación, y un navegador móvil puede frenar o incluso suspender una pestaña que pasa al fondo.",
          "Ninguna cuenta en ninguno de los dos para una transferencia en la misma red. Iniciar sesión solo hace falta en el lado que envía, y solo cuando los dos están en redes distintas y hay que crear un código de emparejamiento.",
        ],
      },
      steps: [
        {
          text: "En el ordenador, abre la página de transferencia en cualquier navegador moderno (Chrome, Edge, Firefox o Safari).",
          code: ["https://relayium.com/"],
        },
        {
          text: "Abre la misma página en el teléfono y compara la IP pública de la línea de estado en las dos pantallas. Una dirección coincidente es lo que mete a los dos dispositivos en una sala; un teléfono que se quedó calladamente en datos móviles muestra otra.",
          code: ["Conectado · este dispositivo Pixel · IP pública 203.0.113.9"],
        },
        {
          text: "En el ordenador, busca el teléfono bajo «Dispositivos cercanos», haz clic en su tarjeta y pulsa «Abrir espacio de trabajo». En un navegador actual esa es la única acción que ofrece la tarjeta, porque a partir de ahí archivos, carpetas y mensajes viajan todos por la única conexión cifrada que abre. Arrastrar archivos directamente sobre esa tarjeta también los envía, sin este paso.",
        },
        {
          text: "El espacio de trabajo sustituye a la tarjeta. Para enviar, usa los controles bajo su encabezado: «Enviar archivos» para un lote de hasta 1.000, «Enviar una carpeta» para un árbol completo allí donde el navegador ofrece elegir carpetas, o escribe en el cuadro de mensaje — «Enter para una nueva línea · ⌘/Ctrl+Enter para enviar» — y pulsa «Enviar».",
        },
        {
          text: "En el teléfono, lee la línea bajo la solicitud antes de aceptar — dice si el navegador preguntará dónde guardar o escribirá directamente en su carpeta de descargas —, después pulsa «Aceptar» y deja esa pestaña delante hasta que el contador llegue al último archivo del lote. Para comparar un código de verificación (SAS) antes de que se mueva un byte, activa «Verificación avanzada» en los dos dispositivos antes de empezar: viene desactivada y añade una comparación y un paso de aceptación, no el cifrado.",
        },
      ],
      success: {
        label: "Qué se ve al terminar la transferencia",
        body: [
          "A esas alturas la tarjeta del teléfono ya no está — el espacio de trabajo ocupó su lugar —, así que el estado se lee en el encabezado del espacio de trabajo: el dispositivo al que estás conectado, un estado de enlace «Conectado» y una única etiqueta de ruta que marca «Directo por LAN». El contador de archivos termina en el último archivo del lote en las dos pantallas.",
          "Después comprueba el archivo, no la página. Dónde aterriza lo decide el navegador del teléfono: Chrome y Firefox en Android lo dejan en su propia lista de descargas — chrome://downloads y about:downloads respectivamente —, y Safari en iOS en la carpeta Descargas que puedes abrir en la app Archivos.",
        ],
        code: ["Conectado a Pixel · Conectado · Directo por LAN\nArchivo 1/1"],
      },
      bullets: [
        "Una sala de la misma red acoge a todo dispositivo que haya abierto la página desde esa red, así que una tableta o un segundo portátil junto al teléfono es normal.",
        "El tope de 1.000 archivos es por lote y no por sesión, de modo que un árbol muy grande pasa en varias tandas sin reconectar.",
      ],
    },
    {
      heading: "Cuando el teléfono no aparece, o la transferencia se detiene",
      body: [
        "Normalmente es el teléfono el que se explica: está en una red distinta de la que creías, su pestaña pasó al fondo, o su navegador no puede sostener lo que se le pide. Son las primeras comprobaciones habituales y no la lista completa, y cada una se resuelve con algo que ya está en pantalla en lugar de adivinando.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El teléfono nunca aparece bajo «Dispositivos cercanos» en el ordenador.",
            code: ["https://relayium.com/   # compara la IP pública de la línea de estado en las dos pantallas"],
            fix: "Dos direcciones IP públicas distintas son dos salas. Que el teléfono se haya quedado calladamente en datos móviles es un motivo frecuente; que una VPN o iCloud Private Relay lo saquen por otra dirección es otro, y no son los únicos. Si estás dispuesto a cambiarlos: conéctalo a la Wi-Fi, corta la VPN o desactiva Private Relay solo para esa red, y recarga https://relayium.com/ en el teléfono. Si prefieres dejarlos puestos, un código de emparejamiento en https://relayium.com/cross-network llega al teléfono sin tocar ninguno de los dos ajustes, y va cifrado de extremo a extremo igual.",
          },
          {
            symptom: "Los dos dispositivos muestran la misma IP pública y las tarjetas siguen sin aparecer.",
            code: ["https://relayium.com/   # la indicación bajo la lista de dispositivos nombra el ajuste del router"],
            fix: "El router separa a sus propios clientes, algo que las Wi-Fi de hotel y de invitados hacen a menudo de fábrica. Desactiva «aislamiento de AP / aislamiento de clientes», o usa un código de emparejamiento en https://relayium.com/cross-network cuando el router no sea tuyo.",
          },
          {
            symptom: "La transferencia empieza y luego se para o falla después de cambiar de aplicación en el teléfono.",
            code: ["https://relayium.com/   # en el teléfono, la pestaña de Relayium tiene que ser la de delante"],
            fix: "Un navegador móvil puede frenar o incluso suspender una pestaña en segundo plano, y mientras lo hace no se mueve ningún byte. El vigilante de atascos de Relayium concede una ventana nueva al volver al primer plano en vez de fallar al instante, pero la solución es dejar la pestaña delante: el bloqueo que Relayium pide solo cubre que la pantalla se apague y no compra ejecución en segundo plano, y los Safari y Android antiguos no ofrecen ninguno que pedir.",
          },
          {
            symptom: "Antes de aceptar, el teléfono avisa de que tiene que sostener todo el lote en memoria.",
            code: ["chrome://downloads   # en Chrome; Edge tiene edge://downloads y Firefox about:downloads"],
            fix: "Los navegadores de teléfono no tienen la API File System Access, así que el lote se monta en memoria y Relayium avisa a partir de unos 256 MiB. Esa cifra es un umbral de aviso prudente y no un tope duro: manda menos archivos de una vez, o manda el archivo grande en el otro sentido, a un Chrome o Edge de ordenador que lo escribe directamente en el disco. Comprueba qué llegó de verdad en la lista de descargas del propio navegador receptor — chrome://downloads en Chrome, edge://downloads en Edge, about:downloads en Firefox.",
          },
          {
            symptom: "Entre redes distintas, el código de emparejamiento que teclea el teléfono es rechazado.",
            code: ["https://relayium.com/cross-network   # la tarjeta de emparejamiento muestra la cuenta atrás y el rechazo del retransmisor"],
            fix: "Un código de emparejamiento vive cinco minutos, y solo el dispositivo que lo creó necesita cuenta. Genera uno nuevo y tecléalo enseguida. Si la tarjeta dice que el retransmisor solo se entrega a cuentas verificadas, verifica antes la dirección de correo de quien envía desde el panel de la cuenta: el flujo en la misma red de arriba no depende de eso.",
          },
        ],
      },
    },
    browserCrossNetworkSection.es,
    {
      heading: "Instálalo como una app (PWA opcional)",
      body: [
        "Relayium es un sitio web, así que de verdad no hay nada que instalar. Pero si envías archivos a menudo, puedes añadirlo a tu pantalla de inicio o escritorio como aplicación web progresiva (PWA): entonces se abre en su propia ventana y se lanza como una app nativa, aunque por debajo sigue siendo solo la página web.",
        "En el teléfono, usa la opción «Añadir a la pantalla de inicio» de tu navegador; en el ordenador, el icono de instalar en la barra de direcciones. De cualquier modo sigue siendo gratis — Relayium es de código abierto bajo la licencia AGPL-3.0 en github.com/relayium/relayium, y funciona en Windows, macOS, Linux, Android e iOS.",
      ],
    },
    {
      heading: "Archivos grandes: lo que tu navegador puede manejar",
      body: [
        "Como una transferencia en tiempo real nunca deja tus archivos en un servidor, no hay cuota de subida que te preocupe. El límite práctico es qué navegador recibe.",
        "Un navegador con la API File System Access — Chrome o Edge de escritorio — transmite los datos entrantes directamente al disco, así que en la práctica no hay tope de tamaño; vídeos de varios gigabytes no son problema. Firefox, Safari y todos los navegadores de móvil no tienen esa API, así que ahí la recepción se acumula en memoria y Relayium te avisa antes de que aceptes en cuanto se pasa de unos 256 MB. Tómalo como una estimación deliberadamente prudente y no como un límite duro — una pestaña de móvil de ese tamaño es fácil de reclamar para el sistema, y el punto real de ruptura se mueve con la memoria del dispositivo, su sistema y cuántas pestañas haya abiertas. Como aquí el receptor es el teléfono, un archivo muy grande conviene mandarlo en el otro sentido, hacia un Chrome o Edge de escritorio que pueda escribirlo al disco.",
      ],
    },
    {
      heading: "Otras formas de mover archivos del PC al teléfono (y sus límites)",
      body: [
        "El inalámbrico en el navegador no es la única opción, y la respuesta honesta es que cada alternativa tiene su lugar. Así se comparan las más habituales:",
      ],
      bullets: [
        "Cable USB: fiable y rápido, pero necesitas el cable adecuado, y acceder a los archivos del teléfono desde el PC puede ser engorroso (sobre todo iPhone a Windows). Es con cable, no inalámbrico.",
        "Bluetooth: de verdad sin cables, pero lento — enviar unas pocas fotos grandes puede llevar minutos, y es poco práctico para vídeos o lotes grandes.",
        "Apps de mensajería o enviarte un correo a ti mismo (WhatsApp, Telegram, correo): cómodo si ya lo tienes abierto, pero la mayoría impone límites de tamaño, puede recomprimir las fotos y hace pasar tus archivos por un servidor de terceros en lugar de mantenerlos privados.",
        "Relayium: inalámbrico, sin instalación, sin cuenta en la misma red (solo el remitente inicia sesión para emparejar entre redes), sin recompresión (byte a byte con una comprobación de integridad SHA-256 por archivo), y cifrado de extremo a extremo con un código de verificación que puedes comprobar tú mismo.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Funciona con Mac y Android, no solo con Windows y iPhone?",
        a: "Sí. Relayium funciona en el navegador en Windows, macOS, Linux, Android e iOS, así que cualquier combinación sirve — de Windows a Android, de Mac a iPhone, de Linux a un teléfono, y a la inversa. No hay nada que instalar en ninguno de los dispositivos.",
      },
      {
        q: "¿Qué velocidad tiene la transferencia?",
        a: "En la misma Wi-Fi los dos dispositivos se conectan directamente, así que la velocidad la limita tu red local y no un servidor — normalmente tan rápido como lo permita tu Wi-Fi. Entre redes distintas la transferencia va por diseño a través de un retransmisor TURN cifrado, así que depende de ambas conexiones a internet más ese salto extra; a cambio, la conexión no depende de encontrar una ruta directa a través de los NAT y cortafuegos intermedios, que pueden impedirla.",
      },
      {
        q: "¿Es seguro enviar archivos así?",
        a: "Sí. Además del cifrado de transporte del navegador, Relayium añade su propia capa: un intercambio de claves X25519 deriva una clave usada para AES-256-GCM por bloque, y esa clave nunca toca un servidor. La coincidencia de los códigos de 6 dígitos (SAS) confirma que las claves no se sustituyeron: ningún servidor o retransmisor se hizo pasar por uno de los extremos ni terminó el cifrado de extremo a extremo de la capa de aplicación. Entre redes, el retransmisor TURN sigue en la ruta de transferencia, pero solo reenvía texto cifrado que no puede descifrar. Cada archivo también se verifica de extremo a extremo con un hash SHA-256.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en tu ordenador y tu teléfono y envía tu primer archivo sin cables — sin cable, sin instalación, sin cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Enviar arquivos do PC para o celular sem fio, sem cabo nem app",
  description:
    "Um guia passo a passo para mover arquivos entre um computador e um celular por Wi-Fi — arrastar e soltar, sem cabo USB, sem conta na nuvem e com criptografia de ponta a ponta o tempo todo.",
  updatedLabel: "Última atualização",
  lead: [
    "Levar um arquivo do notebook para o celular não deveria significar caçar o cabo certo, mandar um e-mail para si mesmo ou subir para um disco na nuvem e baixar de novo. O Relayium move os bytes direto do seu computador para o seu celular pela sua própria rede Wi-Fi, no navegador, sem nada para instalar em nenhum dos lados.",
    "Este guia mostra o jeito sem fio passo a passo — na mesma rede ou entre redes — e depois compara com honestidade com as alternativas de sempre (USB, Bluetooth, apps de mensagem e e-mail) para você escolher a ferramenta certa para cada situação.",
  ],
  sections: [
    {
      heading: "Enviar do PC para o celular na mesma rede Wi-Fi",
      body: [
        "Este é o caminho mais rápido: os dois dispositivos estão na mesma rede, então se conectam diretamente e a transferência é limitada apenas pela sua rede Wi-Fi. Você não precisa de nada além de um navegador em cada dispositivo.",
      ],
      prereqs: {
        label: "Antes de começar",
        items: [
          "O computador e o celular na mesma Wi-Fi, com um roteador que não separe os próprios clientes. A dica abaixo da lista de dispositivos nomeia a configuração: “isolamento de AP / isolamento de clientes”.",
          "Um navegador em cada um, com a página aberta por https://relayium.com/. A transferência criptografada exige HTTPS, e em http:// puro a página diz isso em vez de listar qualquer dispositivo.",
          "A aba do celular mantida à frente durante toda a transferência. O Relayium pede um bloqueio de tela onde o navegador oferece um, o que cobre a tela apagar mas não a troca para outro aplicativo, e um navegador de celular pode limitar ou até suspender uma aba que vai para o segundo plano.",
          "Nenhuma conta em nenhum dos dois para uma transferência na mesma rede. Fazer login só passa a ser necessário para quem envia, e apenas quando os dois estão em redes diferentes e um código de emparelhamento precisa ser criado.",
        ],
      },
      steps: [
        {
          text: "No computador, abra a página de transferência em qualquer navegador moderno (Chrome, Edge, Firefox ou Safari).",
          code: ["https://relayium.com/"],
        },
        {
          text: "Abra a mesma página no celular e compare o IP público da linha de status nas duas telas. Um endereço igual é o que coloca os dois dispositivos em uma sala; um celular que ficou quietinho nos dados móveis mostra outro.",
          code: ["Conectado · este dispositivo Pixel · IP público 203.0.113.9"],
        },
        {
          text: "No computador, encontre o celular em “Dispositivos próximos”, clique no cartão dele e pressione “Abrir área de trabalho”. Em um navegador atual essa é a única ação que o cartão oferece, porque a partir daí arquivos, pastas e mensagens passam todos pela única conexão criptografada que ela abre. Arrastar arquivos direto para aquele cartão também os envia, sem essa etapa.",
        },
        {
          text: "A área de trabalho toma o lugar do cartão. Para enviar, use os controles abaixo do cabeçalho dela: “Enviar arquivos” para um lote de até 1.000, “Enviar uma pasta” para uma árvore inteira onde o navegador oferece escolher pastas, ou digite na caixa de mensagem — “Enter para uma nova linha · ⌘/Ctrl+Enter para enviar” — e pressione “Enviar”.",
        },
        {
          text: "No celular, leia a linha abaixo do pedido antes de aceitar — ela diz se o navegador vai perguntar onde salvar ou gravar direto na pasta de downloads dele —, depois toque em “Aceitar” e deixe essa aba à frente até o contador de arquivos chegar ao último arquivo do lote. Para comparar um código de verificação (SAS) antes de qualquer byte se mover, ligue a “Verificação avançada” nos dois dispositivos antes de começar: ela vem desligada e acrescenta uma comparação e uma etapa de aceite, não a criptografia.",
        },
      ],
      success: {
        label: "Como é uma transferência concluída",
        body: [
          "A essa altura o cartão do celular já não existe — a área de trabalho ocupou o lugar dele —, então leia o estado no cabeçalho da área de trabalho: o dispositivo a que você está conectado, um estado de vínculo “Conectado” e um único selo de caminho indicando “LAN direto”. O contador de arquivos termina no último arquivo do lote nas duas telas.",
          "Depois confira o arquivo, não a página. Onde ele cai é decisão do navegador do celular: Chrome e Firefox no Android colocam na própria lista de downloads — chrome://downloads e about:downloads respectivamente —, e o Safari no iOS coloca na pasta Downloads que você abre no app Arquivos.",
        ],
        code: ["Conectado a Pixel · Conectado · LAN direto\nArquivo 1/1"],
      },
      bullets: [
        "Uma sala da mesma rede acomoda todo dispositivo que abriu a página a partir daquela rede, então um tablet ou um segundo notebook ao lado do celular é normal.",
        "O limite de 1.000 arquivos é por lote, não por sessão, então uma árvore muito grande passa em várias remessas sem reconectar.",
      ],
    },
    {
      heading: "Quando o celular não aparece, ou a transferência para",
      body: [
        "Normalmente é o celular que se explica: está em uma rede diferente da que você imaginava, a aba dele foi para o segundo plano, ou o navegador dele não consegue segurar o que foi pedido. Essas são as primeiras verificações comuns, não a lista completa, e cada uma se decide por algo que já está na tela em vez de por adivinhação.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O celular nunca aparece em “Dispositivos próximos” no computador.",
            code: ["https://relayium.com/   # compare o IP público da linha de status nas duas telas"],
            fix: "Dois endereços IP públicos diferentes são duas salas. Um celular que ficou quietinho nos dados móveis é um motivo comum; uma VPN ou o iCloud Private Relay fazendo a saída por outro endereço é outro, e não são os únicos. Se você estiver disposto a mudá-los: entre na Wi-Fi, desligue a VPN ou desative o Private Relay só para aquela rede, e recarregue https://relayium.com/ no celular. Se preferir deixá-los ligados, um código de emparelhamento em https://relayium.com/cross-network alcança o celular sem tocar em nenhuma das duas configurações, e é criptografado de ponta a ponta do mesmo jeito.",
          },
          {
            symptom: "Os dois dispositivos mostram o mesmo IP público e os cartões continuam sem aparecer.",
            code: ["https://relayium.com/   # a dica abaixo da lista de dispositivos nomeia a configuração do roteador"],
            fix: "O roteador está separando os próprios clientes, o que Wi-Fi de hotel e de visitantes costuma fazer de fábrica. Desative “isolamento de AP / isolamento de clientes”, ou use um código de emparelhamento em https://relayium.com/cross-network quando o roteador não for seu para mexer.",
          },
          {
            symptom: "A transferência começa e depois trava ou falha quando você troca de aplicativo no celular.",
            code: ["https://relayium.com/   # no celular, a aba do Relayium precisa ser a da frente"],
            fix: "Um navegador de celular pode limitar ou até suspender uma aba em segundo plano, e enquanto faz isso nenhum byte se move. O vigia de travamento do Relayium concede uma janela nova depois que a página volta à frente em vez de falhar na hora, mas a solução é deixar a aba à frente: o bloqueio que o Relayium pede só cobre a tela apagar e não compra execução em segundo plano, e Safari e Android antigos não oferecem nenhum para pedir.",
          },
          {
            symptom: "Antes de você aceitar, o celular avisa que precisa segurar o lote inteiro na memória.",
            code: ["chrome://downloads   # no Chrome; o Edge tem edge://downloads e o Firefox about:downloads"],
            fix: "Navegadores de celular não têm a API File System Access, então o lote é montado na memória e o Relayium avisa acima de mais ou menos 256 MiB. Esse número é um limiar de aviso cauteloso e não um teto rígido: mande menos arquivos por vez, ou mande o arquivo grande no sentido contrário, para um Chrome ou Edge de computador que grava direto no disco. Confirme o que realmente chegou na lista de downloads do próprio navegador que recebe — chrome://downloads no Chrome, edge://downloads no Edge, about:downloads no Firefox.",
          },
          {
            symptom: "Entre redes diferentes, o código de emparelhamento digitado no celular é recusado.",
            code: ["https://relayium.com/cross-network   # o cartão de emparelhamento mostra a contagem e a recusa do retransmissor"],
            fix: "Um código de emparelhamento vive cinco minutos, e só o dispositivo que o criou precisa de conta. Gere um novo e digite na hora. Se o cartão disser que o retransmissor só é entregue a contas verificadas, verifique primeiro o e-mail de quem envia no painel da conta: o fluxo na mesma rede acima não depende disso.",
          },
        ],
      },
    },
    browserCrossNetworkSection.pt,
    {
      heading: "Instale como um app (PWA opcional)",
      body: [
        "O Relayium é um site, então realmente não há nada para instalar. Mas se você envia arquivos com frequência, pode adicioná-lo à tela inicial ou à área de trabalho como um aplicativo web progressivo (PWA): ele então abre na própria janela e é iniciado como um app nativo, embora por baixo continue sendo apenas a página web.",
        "No celular, use a opção “Adicionar à tela inicial” do seu navegador; no computador, o ícone de instalar na barra de endereços. De qualquer forma continua gratuito — o Relayium é de código aberto sob a licença AGPL-3.0 em github.com/relayium/relayium, e funciona em Windows, macOS, Linux, Android e iOS.",
      ],
    },
    {
      heading: "Arquivos grandes: o que seu navegador consegue lidar",
      body: [
        "Como uma transferência em tempo real nunca deixa seus arquivos em um servidor, não há cota de upload com que se preocupar. O limite prático é qual navegador está recebendo.",
        "Um navegador com a API File System Access — Chrome ou Edge no computador — grava os dados que chegam direto no disco, então praticamente não há limite de tamanho; vídeos de vários gigabytes são tranquilos. Firefox, Safari e todos os navegadores de celular não têm essa API, então neles o lote é montado na memória, e o Relayium avisa antes de você aceitar assim que passa de cerca de 256 MB. Encare isso como uma estimativa propositalmente conservadora, não como um limite rígido — uma aba de celular desse tamanho é fácil de o sistema recuperar, e o ponto real de falha muda conforme a memória do aparelho, o sistema e quantas abas estão abertas. Como aqui quem recebe é o celular, um arquivo muito grande vai melhor no sentido contrário, para um Chrome ou Edge de computador que consiga gravá-lo no disco.",
      ],
    },
    {
      heading: "Outras formas de mover arquivos do PC para o celular (e seus limites)",
      body: [
        "O sem fio no navegador não é a única opção, e a resposta honesta é que cada alternativa tem o seu lugar. Veja como as mais comuns se comparam:",
      ],
      bullets: [
        "Cabo USB: confiável e rápido, mas você precisa do cabo certo, e acessar os arquivos do celular pelo PC pode ser complicado (especialmente iPhone para Windows). É com fio, não sem fio.",
        "Bluetooth: realmente sem cabo, mas lento — enviar algumas fotos grandes pode levar minutos, e é impraticável para vídeos ou lotes grandes.",
        "Apps de mensagem ou mandar e-mail para si mesmo (WhatsApp, Telegram, e-mail): conveniente se você já tem aberto, mas a maioria impõe limites de tamanho, pode recomprimir as fotos e faz seus arquivos passarem por um servidor de terceiros em vez de mantê-los privados.",
        "Relayium: sem fio, sem instalação, sem conta na mesma rede (só o remetente faz login para emparelhar entre redes), sem recompressão (byte a byte com uma verificação de integridade SHA-256 por arquivo), e criptografado de ponta a ponta com um código de verificação que você mesmo pode conferir.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Isso funciona com Mac e Android, não só com Windows e iPhone?",
        a: "Sim. O Relayium roda no navegador em Windows, macOS, Linux, Android e iOS, então qualquer combinação funciona — Windows para Android, Mac para iPhone, Linux para um celular, e vice-versa. Não há nada para instalar em nenhum dos dispositivos.",
      },
      {
        q: "Qual é a velocidade da transferência?",
        a: "Na mesma rede Wi-Fi os dois dispositivos se conectam diretamente, então a velocidade é limitada pela sua rede local e não por um servidor — normalmente tão rápido quanto sua rede Wi-Fi permitir. Entre redes diferentes a transferência passa, por decisão de projeto, por um retransmissor TURN criptografado, então depende das duas conexões de internet mais esse salto extra; em troca, a conexão não depende de encontrar uma rota direta através dos NATs e firewalls no meio, que podem impedi-la.",
      },
      {
        q: "É seguro enviar arquivos assim?",
        a: "Sim. Além da criptografia de transporte do navegador, o Relayium adiciona a sua própria camada: uma troca de chaves X25519 deriva uma chave usada para AES-256-GCM por bloco, e essa chave nunca toca um servidor. A coincidência dos códigos de 6 dígitos (SAS) confirma que as chaves não foram substituídas: nenhum servidor ou retransmissor se fez passar por uma das pontas nem encerrou a criptografia de ponta a ponta da camada de aplicação. Entre redes, o retransmissor TURN continua no caminho da transferência, mas só encaminha texto cifrado que não consegue descriptografar. Cada arquivo também é verificado de ponta a ponta com um hash SHA-256.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium no seu computador e no seu celular e envie seu primeiro arquivo sem fio — sem cabo, sem instalação, sem conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/send-files-pc-to-phone-wirelessly",
  published: "2026-07-03",
  updated: "2026-08-07",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
