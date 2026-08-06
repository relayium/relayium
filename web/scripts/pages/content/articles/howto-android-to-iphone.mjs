// web/scripts/pages/content/articles/howto-android-to-iphone.mjs
// How-to: transfer files from Android to iPhone. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "How to transfer files from Android to iPhone (no cable)",
  description:
    "A step-by-step guide to sending photos, videos and documents from Android to iPhone in a browser — no AirDrop, no cable, no cloud upload. Just open Relayium on both devices.",
  updatedLabel: "Last updated",
  lead: [
    "Android and iPhone do not share an AirDrop, so moving a few photos or a video between them usually means a USB cable, a chat app that compresses your images, or a round-trip through some cloud drive. All three are slower and more fiddly than they should be.",
    "Relayium skips all of that. Both phones open the same page: on the same LAN the end-to-end encrypted files travel directly, while across networks a TURN relay carries ciphertext it cannot read or decrypt and keeps no realtime content copy or history. No app is needed; the creator signs in for cross-network pairing, while the person joining never needs an account. This guide walks through it step by step.",
  ],
  sections: [
    {
      heading: "What you need before you start",
      body: [
        "Nothing to install. On the same network there is nothing to sign up for either — realtime transfers work straight from the browser on both devices.",
      ],
      prereqs: {
        label: "What you need",
        items: [
          "An Android phone with Chrome (or any modern browser) and an iPhone with Safari — both up to date.",
          "For the fastest path, both devices on the same Wi-Fi network. On the iPhone that usually also means turning iCloud Private Relay off for that one network: it sends the phone out through a different public IP, and same-network discovery groups devices by exactly that address. Leaving it on is a perfectly good choice — a pairing code on https://relayium.com/cross-network then reaches the phone without changing the setting.",
          "The page open over https://relayium.com/ on both phones. Encrypted transfer needs HTTPS, and over plain http:// the page says so instead of listing devices.",
          "The files you want to send, up to 1,000 per batch, and somewhere for them to land on the receiving phone — which folder that is belongs to its browser, not to Relayium.",
        ],
      },
    },
    {
      heading: "Step by step: both devices on the same Wi-Fi",
      body: [
        "This is the simplest route. On the same network, the two phones discover each other automatically, so there is almost nothing to type.",
      ],
      steps: [
        {
          text: "On both the Android phone and the iPhone, open the transfer page in the browser.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compare the public IP in the status pill on both phones. Matching addresses put the two in one room; a different one on the iPhone commonly means iCloud Private Relay or mobile data rather than a broken Wi-Fi.",
          code: ["Connected · this device iPhone · public IP 203.0.113.9"],
        },
        {
          text: "Each phone now lists the other under “Nearby devices”. On the sending phone, tap the receiving one and press “Open workspace”. On a current browser that is the card's one action, because files and messages then share the single encrypted connection it opens.",
        },
        {
          text: "The workspace replaces that card, and its controls carry both: “Send files” for a batch of up to 1,000, or type into the message box and press “Send”. “Send a folder” is offered on the Android phone but not on the iPhone, because no iOS browser lets a page pick a folder. Then, on the receiving iPhone, read the line under the request before you accept — it says whether Safari will ask where to save or write to its own Downloads — and tap “Accept”.",
        },
        {
          text: "Keep both browser tabs in front until the file counter reaches the last file. To compare a verification code (SAS) first, turn on “Advanced verification” on both phones before you start: a match confirms both phones joined the same end-to-end encrypted session, and it does not prove which network path carries the ciphertext. Left off, there is no code to compare and the session is still encrypted.",
        },
      ],
      success: {
        label: "What a working transfer looks like",
        body: [
          "The other phone's card is gone by then — the workspace took its place — so the state is read off the workspace header: the device you are connected to, a link state of “Connected”, and one path badge reading “LAN direct”. The file counter on both screens ends on the last file of the batch.",
          "Then confirm the file rather than the page. On the iPhone that means the Downloads folder in the Files app, which is where Safari puts a download; on the Android phone it means the browser's own downloads list — chrome://downloads in Chrome, about:downloads in Firefox.",
        ],
        code: ["Connected to iPhone · Connected · LAN direct\nFile 2/2"],
      },
    },
    {
      heading: "When the two phones can't see each other",
      body: [
        "One cause worth knowing on the iPhone: iCloud Private Relay is on for many iCloud+ accounts and changes the public IP the phone appears to come from, which is exactly what same-network discovery groups by. It is one common reason among several, not the only one, and the checks below are the usual first ones rather than an exhaustive list — each decides its case from what is already on screen.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The iPhone never appears on the Android phone, or the other way round.",
            code: ["https://relayium.com/   # compare the public IP in the status pill on both phones"],
            fix: "Two different public IP addresses mean two rooms. On an iPhone iCloud Private Relay is one common cause, and a phone that quietly stayed on mobile data is another; neither is the only possibility. If you are willing to change them, turn Private Relay off for that one Wi-Fi under Settings › Wi-Fi › the network › Limit IP Address Tracking, or join the Wi-Fi, then reload https://relayium.com/. If you would rather leave Private Relay or a VPN on, a pairing code on https://relayium.com/cross-network reaches the phone without touching either.",
          },
          {
            symptom: "Both phones show the same public IP and neither card appears.",
            code: ["https://relayium.com/   # the hint under the device list names the router setting"],
            fix: "The router is separating its own clients. Turn off “AP isolation / client isolation” in its Wi-Fi settings, or pair the two phones across networks with a code on https://relayium.com/cross-network when the router is not yours to change.",
          },
          {
            symptom: "The iPhone warns, before you accept, that the whole batch has to be held in memory.",
            code: ["https://relayium.com/   # the warning states the batch size it is about to hold"],
            fix: "Every iPhone browser is WebKit and has no File System Access API, so the batch is assembled in memory and Relayium warns past roughly 256 MiB. Send fewer files at a time, or send that file into a desktop Chrome or Edge instead, which writes it straight to disk with no size cap.",
          },
          {
            symptom: "The counter finished but you cannot find the file on the iPhone.",
            code: ["https://relayium.com/   # the line under the request said where this browser saves"],
            fix: "Safari does not put a download in the photo library. Look in the Files app under Downloads — the exact location is whatever Settings › Safari › Downloads points at, iCloud Drive or On My iPhone — and open it from there; a photo only reaches the Photos app if you save it out of the file yourself.",
          },
          {
            symptom: "The transfer stalls or fails when you switch apps or the screen locks.",
            code: ["https://relayium.com/   # the Relayium tab has to be the one in front on both phones"],
            fix: "A backgrounded tab may be throttled or suspended on either phone, and while it is, no bytes move. Relayium requests a screen wake lock where the browser offers one, which covers the screen switching off but grants no background execution and does not survive app switching — leave both tabs in front until the counter finishes.",
          },
        ],
      },
    },
    {
      heading: "On different networks? Use a pairing code",
      body: [
        "You don't have to be on the same Wi-Fi. If the phones are on different networks — one on mobile data, the other on home Wi-Fi — Relayium can still connect them with a pairing code. A pairing-code room is a separate surface from a nearby-device workspace, though: it keeps the earlier per-device controls, so there is no “Open workspace” to press there.",
        "The sending device shows a short pairing code; enter it on the other phone (or open the share link it generates). A transfer set up this way runs over an encrypted TURN relay rather than a direct link between the two phones — and that is deliberate: Relayium goes straight to the relay, so the connection does not depend on discovering a direct route through the NATs and firewalls between the two networks, which can prevent one. The relay only ever forwards ciphertext; the files are sealed end-to-end before they leave your phone, so it can never read them. If the connection drops mid-transfer, it can resume instead of starting over. Sending this way needs the sender to sign in — the person receiving never needs an account. The code is good for five minutes, so have both devices in front of you before you generate one.",
      ],
    },
    {
      heading: "Other ways to move files between Android and iPhone",
      body: [
        "Relayium isn't the only option, and it's worth knowing the honest trade-offs of the alternatives:",
      ],
      bullets: [
        "Google's Quick Share and third-party apps like SHAREit move files quickly, but they need an install on both phones and Quick Share doesn't reach iPhones.",
        "A cloud drive (Google Drive, iCloud, Dropbox) works when the other person is offline, but you upload and then download the same file twice, it counts against your quota, and the provider holds a copy.",
        "Chat apps and email are everywhere, but they usually re-compress photos, cap attachment sizes, and are not end-to-end encrypted for file sharing.",
        "A USB cable is reliable but needs the right adapter between USB-C and Lightning, plus a computer in the middle for many file types.",
      ],
    },
    {
      heading: "Will my photos lose quality?",
      body: [
        "No. Unlike a messaging app, Relayium sends the original file byte-for-byte — no re-compression, no resizing. What lands on the iPhone is an exact copy of what left the Android phone.",
        "To prove it, each file is verified end-to-end with a SHA-256 hash, so a photo or video that arrives is guaranteed identical to the one you sent. Large files are handled well too: a browser with the File System Access API (Chrome or Edge on a desktop) writes the incoming file straight to disk, with no size cap. Firefox, Safari and phone browsers — an iPhone is always WebKit — don't have that API, so there the batch is assembled in memory instead, and Relayium warns you before you accept once it goes past roughly 256 MB. That number is a deliberately cautious estimate rather than a measured ceiling: where it actually breaks down depends on the device's memory, its OS and how many tabs are open.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need to install an app on either phone?",
        a: "No. Relayium runs entirely in the browser on both Android and iPhone. Open relayium.com on each device and you're ready — no download either way. On the same network a realtime transfer needs no account; pairing across networks just asks the sender to sign in. You can optionally add it to your home screen as a PWA, but that's just a shortcut.",
      },
      {
        q: "Do both phones have to be on the same Wi-Fi?",
        a: "No. The same network is the fastest path because the devices discover each other automatically, but a pairing code connects two phones across different networks — even one on mobile data and one on Wi-Fi. The transfer stays end-to-end encrypted in both cases, though pairing across networks requires the sender to sign in — the receiver never needs an account.",
      },
      {
        q: "Are the photos compressed or changed in any way?",
        a: "No. The original file is transferred byte-for-byte with no compression, and each file is checked end-to-end with a SHA-256 hash, so what arrives on the iPhone is bit-for-bit identical to what you sent from Android.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on both phones and send your first files across — no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何把文件从安卓传到 iPhone（无需数据线）",
  description:
    "一步步教你在浏览器里把照片、视频和文档从安卓传到 iPhone——不用 AirDrop、不用数据线、不用上传网盘。两台设备打开 Relayium 即可。",
  updatedLabel: "最近更新",
  lead: [
    "安卓和 iPhone 之间没有互通的 AirDrop，所以在两者间传几张照片或一段视频，往往只能靠 USB 数据线、会压缩画质的聊天软件，或者绕一圈网盘上传下载。三种方式都比本该有的更慢、更折腾。",
    "Relayium 把这些统统省掉。两台手机打开同一个网页：同一局域网内，端到端加密的文件会直接传输；跨网络时，TURN 中继只搬运它无法读取或解密的密文，也不保留实时内容副本或历史。无需安装应用；跨网络配对由创建者登录，加入者始终无需账号。本文一步步带你完成。",
  ],
  sections: [
    {
      heading: "开始前需要准备什么",
      body: [
        "不用安装。同一网络下也不用注册——实时传输在两台设备的浏览器里直接就能用。",
      ],
      prereqs: {
        label: "你需要准备",
        items: [
          "一台装有 Chrome（或任意现代浏览器）的安卓手机，一台用 Safari 的 iPhone——都保持最新版本。",
          "想要最快的路径，就让两台设备连到同一个 Wi-Fi。在 iPhone 上，这通常还意味着只对这一个网络关闭 iCloud 专用代理：它会让手机从另一个公网 IP 出去，而同网络发现正是按这个地址来分组的。继续开着它也完全可以——那就用 https://relayium.com/cross-network 上的配对码，不改设置也能连到这台手机。",
          "两台手机都通过 https://relayium.com/ 打开页面。加密传输需要 HTTPS，用普通 http:// 打开时页面会直接这么说，而不会列出设备。",
          "你要发送的文件，每批最多 1,000 个；接收方手机上也要有地方放它们——放进哪个目录由它的浏览器决定，不由 Relayium 决定。",
        ],
      },
    },
    {
      heading: "分步操作：两台设备连同一 Wi-Fi",
      body: [
        "这是最简单的方式。在同一网络里，两台手机会自动发现彼此，几乎不用输入任何东西。",
      ],
      steps: [
        {
          text: "在安卓手机和 iPhone 上，都在浏览器里打开传输页面。",
          code: ["https://relayium.com/"],
        },
        {
          text: "对比两台手机上状态条里的公网 IP。地址一致才会把两台放进同一个房间；iPhone 显示的地址不同，常见的缘故是 iCloud 专用代理或移动数据，而不是 Wi-Fi 出了问题。",
          code: ["已连接 · 本机 iPhone · 公网 IP 203.0.113.9"],
        },
        {
          text: "现在每台手机都会在「附近的设备」里列出另一台。在发送方手机上点击接收方那台，然后按「打开工作区」。在当前浏览器上，这是卡片提供的唯一一个动作——因为接下来文件和消息都共用它打开的那一条加密连接。",
        },
        {
          text: "工作区会取代那张卡片，它的控件同时承载两者：「发送文件」发一批（最多 1,000 个），或者在消息框里打字后按「发送」。「发送文件夹」在安卓手机上有，在 iPhone 上没有，因为 iOS 上没有任何浏览器允许网页选择文件夹。然后在接收方 iPhone 上，先看请求下面那行再决定接收——它会说明 Safari 是要问你存到哪，还是直接写进它自己的下载目录——然后点「接收」。",
        },
        {
          text: "让两个浏览器标签页都留在最前面，直到文件计数走到最后一个文件。如果想先核对校验码（SAS），开始前在两台手机上打开「高级验证」：一致说明两台手机加入了同一个端到端加密会话，但并不证明密文走了哪条网络路径。不打开就没有可核对的码，会话依然是加密的。",
        },
      ],
      success: {
        label: "传输成功时是什么样",
        body: [
          "这时对方的卡片已经不在了——工作区取代了它——所以状态要从工作区标题栏上读：你连到了哪台设备、连接状态是「已连接」，以及唯一一个路径标签显示「局域网直连」。两块屏幕上的文件计数都停在这一批的最后一个文件。",
          "然后要确认的是文件，而不是页面。在 iPhone 上是「文件」App 里的「下载」目录，那是 Safari 存放下载内容的地方；在安卓手机上则是浏览器自己的下载列表——Chrome 用 chrome://downloads，Firefox 用 about:downloads。",
        ],
        code: ["已连接到 iPhone · 已连接 · 局域网直连\n文件 2/2"],
      },
    },
    {
      heading: "两台手机互相看不到时",
      body: [
        "iPhone 上有一个值得先知道的原因：很多 iCloud+ 账号默认开着 iCloud 专用代理，它会改变手机对外呈现的公网 IP，而同网络发现正是按这个地址来分组的。它是几种常见原因之一，并非唯一原因；下面这些检查是通常的首轮排查，而不是穷尽清单，每一条都能用屏幕上已有的东西判定各自的情况。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "iPhone 始终不出现在安卓手机上，或者反过来。",
            code: ["https://relayium.com/   # 对比两台手机上状态条里的公网 IP"],
            fix: "两个不同的公网 IP 就是两个房间。在 iPhone 上，iCloud 专用代理是常见原因之一，手机悄悄留在移动数据上是另一种，两者都不是唯一可能。如果你愿意改这些设置：在「设置 › 无线局域网 › 该网络 › 限制 IP 地址跟踪」里只对那一个 Wi-Fi 关掉专用代理，或让手机连上 Wi-Fi，然后重新加载 https://relayium.com/。如果你更想保留专用代理或 VPN，用 https://relayium.com/cross-network 上的配对码也能连到这台手机，两者都不用动。",
          },
          {
            symptom: "两台手机显示的公网 IP 相同，却都不出现卡片。",
            code: ["https://relayium.com/   # 设备列表下方的提示写着要改的那个路由器开关"],
            fix: "路由器把自己的客户端隔开了。在它的 Wi-Fi 设置里关闭「AP 隔离 / 客户端隔离」；如果路由器不由你改，就用 https://relayium.com/cross-network 上的配对码让两台手机跨网络配对。",
          },
          {
            symptom: "还没点接收，iPhone 就警告说整批文件必须放在内存里。",
            code: ["https://relayium.com/   # 警告里写着它即将装下的这一批有多大"],
            fix: "iPhone 上的浏览器全都是 WebKit，没有 File System Access API，所以整批内容会在内存里拼装，超过大约 256 MiB 时 Relayium 就会警告。一次少发几个文件，或者把这个文件改发到电脑上的 Chrome 或 Edge——那边会直接写盘，没有大小上限。",
          },
          {
            symptom: "计数已经走完，但在 iPhone 上找不到文件。",
            code: ["https://relayium.com/   # 请求下面那行已经说明了这个浏览器存到哪"],
            fix: "Safari 不会把下载内容放进照片图库。请到「文件」App 的「下载」目录里找——具体位置取决于「设置 › Safari 浏览器 › 下载」指向 iCloud 云盘还是本机——然后从那里打开；只有你自己再从文件里存一次，照片才会进入「照片」App。",
          },
          {
            symptom: "切到别的 App 或者屏幕锁上之后，传输卡住或失败。",
            code: ["https://relayium.com/   # 两台手机上 Relayium 这个标签页都必须是最前面那个"],
            fix: "退到后台的标签页在两台手机上都可能被限流甚至挂起，而在它被这样处理时字节根本不动。只要浏览器提供，Relayium 会申请屏幕唤醒锁，这能盖住屏幕熄灭，但它并不带来后台执行，也盖不住切换 App——请让两个标签页都留在最前面，直到计数走完。",
          },
        ],
      },
    },
    {
      heading: "不在同一网络？用配对码",
      body: [
        "你不必连同一个 Wi-Fi。如果两台手机在不同网络——一台用移动数据，另一台用家里的 Wi-Fi——Relayium 依然能用配对码把它们连起来。不过配对码房间和「附近的设备」工作区是两套界面：它保留的是早先那套按设备分开的控件，那里没有「打开工作区」可按。",
        "发送方设备会显示一段简短的配对码，在另一台手机上输入即可（或打开它生成的分享链接）。这样建立的跨网络传输走的是加密 TURN 中继，而不是两台手机之间的直连——这是刻意的选择：Relayium 直接走中继，因此连接不依赖在两个网络之间的 NAT 和防火墙里探测出一条直连路径——它们可能挡住这样的路径。中继只转发密文；文件在离开你手机之前就已完成端到端加密，中继永远读不到内容。若中途连接断开，可以断点续传，而不必从头再来。这样发送需要发送方登录——接收方始终无需账号。 配对码有效期 5 分钟，所以生成之前先把两台设备都准备好。",
      ],
    },
    {
      heading: "在安卓和 iPhone 间传文件的其他方式",
      body: [
        "Relayium 并不是唯一选择，了解各替代方案的取舍也很有必要：",
      ],
      bullets: [
        "谷歌的快速分享（Quick Share）以及 SHAREit 这类第三方 App 传得很快，但两台手机都要安装，而且快速分享无法覆盖 iPhone。",
        "网盘（Google Drive、iCloud、Dropbox）在对方不在线时也能用，但同一个文件要上传再下载两次，会占用你的配额，且服务商手里留有一份副本。",
        "聊天软件和邮件随处可用，但它们通常会重新压缩照片、限制附件大小，且文件分享并非端到端加密。",
        "USB 数据线很可靠，但需要 USB-C 与 Lightning 之间合适的转接头，很多文件类型还得靠中间一台电脑。",
      ],
    },
    {
      heading: "照片会掉画质吗？",
      body: [
        "不会。与聊天软件不同，Relayium 按原文件逐字节发送——不重新压缩、不缩放。落到 iPhone 上的，就是从安卓手机发出的那份的精确副本。",
        "为了证明这一点，每个文件都用 SHA-256 做端到端校验，所以收到的照片或视频保证与你发送的完全一致。大文件也处理得很好：支持 File System Access API 的浏览器（桌面版 Chrome、Edge）会把收到的文件直接流式写入磁盘，没有大小上限。Firefox、Safari 以及手机上的浏览器（iPhone 上一律是 WebKit）没有这个 API，这时整批文件只能先攒在内存里，因此一旦超过约 256 MB，Relayium 会在你点「接收」之前先提示一次。这个数字是刻意取的保守估计，而不是实测出来的硬上限：真正撑不住的临界点取决于设备内存、系统以及开了多少标签页。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "两台手机都要装 App 吗？",
        a: "不用。Relayium 在安卓和 iPhone 上都完全运行于浏览器里。在每台设备上打开 relayium.com 就绪了——无论哪种方式都无需下载。同一网络下实时传输无需账号；跨网络配对只需发送方登录一下。你也可以把它作为 PWA 添加到主屏幕，但那只是个快捷方式。",
      },
      {
        q: "两台手机必须在同一 Wi-Fi 上吗？",
        a: "不必。同一网络是最快的路径，因为设备会自动发现彼此；但配对码能把两台手机跨越不同网络连起来——哪怕一台用移动数据、一台用 Wi-Fi。两种情况下传输都保持端到端加密，不过跨网络配对需要发送方登录——接收方始终无需账号。",
      },
      {
        q: "照片会被压缩或改动吗？",
        a: "不会。原文件按逐字节传输、不做压缩，每个文件还用 SHA-256 做端到端校验，所以到达 iPhone 的内容与你从安卓发出的逐位一致。",
      },
    ],
  },
  cta: {
    text: "在两台手机上打开 Relayium，把第一批文件传过去吧——无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Android から iPhone へファイルを転送する方法（ケーブル不要）",
  description:
    "写真・動画・書類を Android から iPhone へブラウザで送る手順を解説。AirDrop もケーブルもクラウドへのアップロードも不要。両方の端末で Relayium を開くだけです。",
  updatedLabel: "最終更新",
  lead: [
    "Android と iPhone は AirDrop を共有していないため、写真を数枚や動画を1本やり取りするだけでも、USB ケーブル、画質を圧縮するチャットアプリ、あるいはクラウドドライブへのアップロードとダウンロードの往復に頼りがちです。どれも本来より遅く、面倒です。",
    "Relayium はそれをすべて省きます。2台のスマホで同じページを開くと、同じ LAN 内ではエンドツーエンド暗号化されたファイルが直接転送され、ネットワークをまたぐ場合は TURN リレーが読取りも復号もできない暗号文だけを運び、リアルタイム内容のコピーや履歴を残しません。アプリは不要で、ネットワーク越しのペアリングでは作成者がサインインし、参加者にはアカウントが不要です。本記事で手順を順に説明します。",
  ],
  sections: [
    {
      heading: "始める前に必要なもの",
      body: [
        "インストールは不要です。同じネットワークなら登録も不要です。リアルタイム転送は両方の端末のブラウザからそのまま使えます。",
      ],
      prereqs: {
        label: "必要なもの",
        items: [
          "Chrome（または任意の最新ブラウザ）が入った Android 端末と、Safari を使う iPhone（どちらも最新の状態に）。",
          "最速の経路は、両方の端末を同じ Wi-Fi ネットワークに置くことです。iPhone ではふつう、その 1 つのネットワークについて iCloud プライベートリレーをオフにすることも含みます。オンだと別のグローバル IP から出ることになり、同一ネットワークの検出はまさにそのアドレスで端末をまとめているからです。オンのままにするのも十分よい選択で、その場合は https://relayium.com/cross-network のペアリングコードなら設定を変えずにそのスマホへ届きます。",
          "両方のスマホで https://relayium.com/ からページを開いていること。暗号化転送には HTTPS が必要で、素の http:// で開くと端末を一覧せずにその旨を表示します。",
          "送りたいファイル（1 バッチ最大 1,000 個）と、受信側のスマホにそれを置く場所。どのフォルダになるかは Relayium ではなくそのブラウザが決めます。",
        ],
      },
    },
    {
      heading: "手順：両方の端末が同じ Wi-Fi の場合",
      body: [
        "これが最もシンプルな経路です。同じネットワークなら2台のスマホが自動的に互いを見つけるので、入力はほとんどありません。",
      ],
      steps: [
        {
          text: "Android 端末と iPhone の両方で、ブラウザから転送ページを開きます。",
          code: ["https://relayium.com/"],
        },
        {
          text: "両方のスマホのステータス表示にあるグローバル IP を比べます。同じアドレスなら 2 台は同じルームに入ります。iPhone だけ違うアドレスなら、Wi-Fi の不具合ではなく、iCloud プライベートリレーかモバイル通信が原因であることが多いです。",
          code: ["接続済み · このデバイス iPhone · グローバル IP 203.0.113.9"],
        },
        {
          text: "これで各スマホの「近くのデバイス」にもう一方が並びます。送信側のスマホで受信側をタップし、「ワークスペースを開く」を押します。最新のブラウザではカードが提供する動作はこれ 1 つだけで、以降はファイルもメッセージも、そこで開かれる 1 本の暗号化接続を共有します。",
        },
        {
          text: "ワークスペースがそのカードに取って代わり、そのコントロールが両方を担います：1 バッチ最大 1,000 個なら「ファイルを送信」、あるいはメッセージ欄に入力して「送信」を押します。「フォルダを送信」は Android 端末には出ますが iPhone には出ません。iOS のブラウザはどれもページにフォルダを選ばせないからです。続いて受信側の iPhone では、承認する前にリクエストの下の行を読んでください——Safari が保存先を尋ねるのか、自分のダウンロード先に書き込むのかが書かれています——そのうえで「受信」をタップします。",
        },
        {
          text: "ファイルカウンターが最後のファイルに達するまで、両方のブラウザのタブを前面に置いたままにします。先に検証コード（SAS）を照合したい場合は、開始前に両方のスマホで「高度な検証」をオンにしてください。一致は2台が同じエンドツーエンド暗号化セッションに参加したことを確認するもので、暗号文が通るネットワーク経路を証明するものではありません。オフのままなら照合するコードは表示されませんが、セッションは変わらず暗号化されています。",
        },
      ],
      success: {
        label: "転送が成功したときの画面",
        body: [
          "この時点でもう一方のカードはありません——ワークスペースが取って代わったからです。状態はワークスペースのヘッダーから読みます：接続先のデバイス、「接続済み」というリンク状態、そして唯一の経路バッジ「LAN直結」。両方の画面のファイルカウンターはそのバッチの最後のファイルで止まります。",
          "その次に確かめるのはページではなくファイルです。iPhone では「ファイル」アプリの「ダウンロード」フォルダ（Safari がダウンロードを置く場所）、Android 端末ではブラウザ自身のダウンロード一覧——Chrome は chrome://downloads、Firefox は about:downloads——が、それに当たります。",
        ],
        code: ["iPhone に接続済み · 接続済み · LAN直結\nファイル 2/2"],
      },
    },
    {
      heading: "2台のスマホが互いに見えないとき",
      body: [
        "iPhone で先に知っておく価値のある原因が 1 つあります。多くの iCloud+ アカウントでは iCloud プライベートリレーが有効で、端末が外から見えるグローバル IP が変わり、同一ネットワークの検出はまさにそのアドレスで端末をまとめているからです。これはよくある原因の 1 つで、唯一の原因ではありません。以下の確認は網羅した一覧ではなく通常の初手で、どれもすでに画面にあるものだけでその場合を判別できます。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "iPhone が Android 端末に現れない、またはその逆。",
            code: ["https://relayium.com/   # 両方のスマホのステータス表示にあるグローバル IP を比べる"],
            fix: "グローバル IP が 2 つ違えばルームも 2 つです。iPhone では iCloud プライベートリレーがよくある原因の 1 つ、気づかないうちにモバイル通信のままだったのがもう 1 つで、どちらも唯一の可能性ではありません。設定を変えてよいなら、「設定 › Wi-Fi › そのネットワーク › IP アドレスを追跡させない」からその 1 つの Wi-Fi についてプライベートリレーをオフにするか、Wi-Fi に参加してから https://relayium.com/ を再読み込みしてください。プライベートリレーや VPN をオンのままにしたい場合は、https://relayium.com/cross-network のペアリングコードならどちらにも触れずにそのスマホへ届きます。",
          },
          {
            symptom: "両方のスマホが同じグローバル IP を表示しているのに、どちらのカードも現れない。",
            code: ["https://relayium.com/   # 端末一覧の下のヒントに、変更すべきルーター設定名がある"],
            fix: "ルーターが自分のクライアントを隔てています。Wi-Fi 設定で「AP 分離 / クライアント分離」をオフにしてください。ルーターを変更できない場合は、https://relayium.com/cross-network のコードで 2台をネットワークをまたいでペアリングします。",
          },
          {
            symptom: "承認する前に、iPhone がバッチ全体をメモリに保持しなければならないと警告する。",
            code: ["https://relayium.com/   # 警告には、これから抱えるバッチのサイズが書かれている"],
            fix: "iPhone のブラウザはすべて WebKit で File System Access API を持たないため、バッチはメモリ上で組み立てられ、おおよそ 256 MiB を超えると Relayium が警告します。一度に送るファイルを減らすか、そのファイルはディスクへ直接書き出せてサイズ上限のない PC の Chrome か Edge へ送ってください。",
          },
          {
            symptom: "カウンターは終わったのに、iPhone でファイルが見つからない。",
            code: ["https://relayium.com/   # リクエストの下の行に、このブラウザの保存先が書かれていた"],
            fix: "Safari はダウンロードを写真ライブラリに入れません。「ファイル」アプリの「ダウンロード」を見てください。正確な場所は「設定 › Safari › ダウンロード」が iCloud Drive か iPhone 内のどちらを指しているかで決まります。そこから開いてください。写真が「写真」アプリに入るのは、そのファイルから自分で保存した場合だけです。",
          },
          {
            symptom: "アプリを切り替えたり画面がロックされたりすると、転送が止まる、または失敗する。",
            code: ["https://relayium.com/   # 両方のスマホで Relayium のタブが前面にある必要がある"],
            fix: "バックグラウンドのタブはどちらのスマホでも絞られたり停止されたりすることがあり、そうなっている間はバイトが動きません。Relayium はブラウザが対応していれば画面のウェイクロックを要求し、画面が消えるのは防げますが、バックグラウンド実行までは得られず、アプリの切り替えも防げません。カウンターが終わるまで両方のタブを前面に置いてください。",
          },
        ],
      },
    },
    {
      heading: "異なるネットワークの場合は？ ペアリングコードを使う",
      body: [
        "同じ Wi-Fi である必要はありません。スマホが別々のネットワーク（一方はモバイルデータ、もう一方は自宅の Wi-Fi）にあっても、Relayium はペアリングコードで両者を接続できます。ただしペアリングコードのルームは「近くのデバイス」のワークスペースとは別の画面で、以前どおり端末ごとに分かれたコントロールのままなので、そこに「ワークスペースを開く」はありません。",
        "送信側の端末が短いペアリングコードを表示するので、もう一方のスマホで入力します（または生成された共有リンクを開きます）。この方法で結ばれるネットワークをまたぐ転送は、端末同士の直接接続ではなく暗号化された TURN リレー経由で行われます。これは意図的な設計です。Relayium は最初からリレーを使うため、接続の成立は、2 つのネットワークの間にある NAT やファイアウォールを越える直接の経路を見つけられるかどうかに左右されません。NAT やファイアウォールが直接の経路を塞ぐこともあります。リレーが転送するのは暗号文だけで、ファイルはスマホを出る前にエンドツーエンドで封印されているため、リレーが中身を読むことはできません。途中で接続が切れても、最初からではなく再開できます。この方法で送るには送信側のサインインが必要です。受信側はアカウント不要です。 コードの有効期限は5分なので、生成する前に両方の端末を手元に用意してください。",
      ],
    },
    {
      heading: "Android と iPhone の間でファイルを移す他の方法",
      body: [
        "Relayium だけが選択肢ではありません。代替手段の正直なトレードオフを知っておく価値があります。",
      ],
      bullets: [
        "Google のクイック共有や SHAREit のようなサードパーティ製アプリは高速ですが、両方のスマホにインストールが必要で、クイック共有は iPhone には届きません。",
        "クラウドドライブ（Google ドライブ、iCloud、Dropbox）は相手がオフラインでも使えますが、同じファイルをアップロードして再びダウンロードと2回動かすことになり、容量を消費し、提供元がコピーを保持します。",
        "チャットアプリやメールはどこにでもありますが、たいてい写真を再圧縮し、添付サイズを制限し、ファイル共有はエンドツーエンド暗号化されていません。",
        "USB ケーブルは確実ですが、USB-C と Lightning の間に適切なアダプターが必要で、多くのファイル形式では間にパソコンも要ります。",
      ],
    },
    {
      heading: "写真の画質は落ちますか？",
      body: [
        "落ちません。メッセージアプリと違い、Relayium は元のファイルをバイト単位でそのまま送ります。再圧縮もリサイズもしません。iPhone に届くのは、Android から出たものの正確なコピーです。",
        "それを裏づけるため、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるので、届いた写真や動画は送ったものと必ず同一です。大きなファイルもうまく扱えます。File System Access API を備えたブラウザ（パソコン版の Chrome や Edge）は、受信したファイルをサイズ上限なしでそのままディスクへ書き込みます。Firefox・Safari・スマホのブラウザ（iPhone は中身がすべて WebKit です）にはこの API がないため、そこでは受信分をいったんメモリに溜めることになり、およそ 256MB を超えると Relayium が受け取る前に警告を出します。この数値は実測した上限ではなく意図的に控えめに置いた目安で、実際に破綻する地点は端末のメモリ・OS・開いているタブの数によって変わります。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "どちらのスマホにもアプリのインストールは必要ですか？",
        a: "いいえ。Relayium は Android でも iPhone でもすべてブラウザで動作します。各端末で relayium.com を開けば準備完了です。どちらの方法でもダウンロードは不要です。同じネットワークならリアルタイム転送にアカウントは不要で、ネットワークをまたぐペアリングも送信側がサインインするだけです。任意で PWA としてホーム画面に追加できますが、それはショートカットにすぎません。",
      },
      {
        q: "両方のスマホが同じ Wi-Fi にある必要がありますか？",
        a: "いいえ。同じネットワークは端末が自動的に互いを見つけるため最速の経路ですが、ペアリングコードなら2台のスマホを異なるネットワークをまたいで接続できます。一方がモバイルデータ、もう一方が Wi-Fi でも大丈夫です。どちらの場合も転送はエンドツーエンド暗号化のままですが、ネットワークをまたぐペアリングには送信側のサインインが必要です。受信側はアカウント不要です。",
      },
      {
        q: "写真は圧縮されたり変更されたりしますか？",
        a: "いいえ。元のファイルは圧縮なしでバイト単位で転送され、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるため、iPhone に届くものは Android から送ったものとビット単位で同一です。",
      },
    ],
  },
  cta: {
    text: "両方のスマホで Relayium を開いて、最初のファイルを送ってみましょう。インストール不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "안드로이드에서 아이폰으로 파일 전송하는 방법 (케이블 없이)",
  description:
    "사진, 동영상, 문서를 안드로이드에서 아이폰으로 브라우저에서 보내는 단계별 안내. AirDrop도, 케이블도, 클라우드 업로드도 필요 없습니다. 두 기기에서 Relayium을 열기만 하면 됩니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "안드로이드와 아이폰은 AirDrop을 공유하지 않아, 사진 몇 장이나 동영상 하나를 옮기는 데도 보통 USB 케이블, 이미지를 압축하는 채팅 앱, 아니면 클라우드 드라이브를 오가는 업로드와 다운로드에 기대게 됩니다. 셋 다 마땅히 그래야 하는 것보다 느리고 번거롭습니다.",
    "Relayium은 그 모든 것을 건너뜁니다. 두 휴대폰에서 같은 페이지를 열면 같은 LAN에서는 종단간 암호화된 파일이 직접 전송되고, 네트워크를 넘을 때는 TURN 릴레이가 읽거나 복호화할 수 없는 암호문만 전달하며 실시간 콘텐츠 사본이나 기록을 남기지 않습니다. 앱은 필요 없고, 네트워크 간 페어링에서는 생성자가 로그인하며 참가자는 계정이 필요 없습니다. 이 글에서 단계별로 안내합니다.",
  ],
  sections: [
    {
      heading: "시작하기 전에 필요한 것",
      body: [
        "설치할 것이 없습니다. 같은 네트워크에서는 가입할 것도 없습니다 — 실시간 전송은 두 기기의 브라우저에서 바로 됩니다.",
      ],
      prereqs: {
        label: "필요한 것",
        items: [
          "Chrome(또는 최신 브라우저 아무거나)이 있는 안드로이드 폰과 Safari를 쓰는 아이폰 — 둘 다 최신 상태로.",
          "가장 빠른 경로는 두 기기를 같은 Wi-Fi 네트워크에 두는 것입니다. 아이폰에서는 보통 그 한 네트워크에 대해 iCloud 비공개 릴레이를 끄는 것까지 포함됩니다. 켜져 있으면 다른 공인 IP로 나가게 되고, 같은 네트워크 탐색은 바로 그 주소로 기기를 묶기 때문입니다. 켜둔 채로 두는 것도 충분히 좋은 선택이며, 그때는 https://relayium.com/cross-network 의 페어링 코드가 설정을 바꾸지 않고 그 휴대폰에 닿습니다.",
          "두 휴대폰 모두 https://relayium.com/ 으로 페이지를 열어야 합니다. 암호화 전송에는 HTTPS가 필요하며, 평범한 http:// 로 열면 기기를 나열하는 대신 그 사실을 알립니다.",
          "보내려는 파일(배치당 최대 1,000개)과 받는 휴대폰에서 그것들이 놓일 자리. 어느 폴더가 될지는 Relayium이 아니라 그 브라우저가 정합니다.",
        ],
      },
    },
    {
      heading: "단계별: 두 기기가 같은 Wi-Fi에 있을 때",
      body: [
        "가장 간단한 방법입니다. 같은 네트워크에서는 두 휴대폰이 자동으로 서로를 찾으므로 입력할 것이 거의 없습니다.",
      ],
      steps: [
        {
          text: "안드로이드 폰과 아이폰 모두에서 브라우저로 전송 페이지를 엽니다.",
          code: ["https://relayium.com/"],
        },
        {
          text: "두 휴대폰의 상태 표시에 있는 공인 IP를 비교합니다. 주소가 같으면 두 대가 한 방에 들어갑니다. 아이폰만 다른 주소라면 Wi-Fi 고장이 아니라 iCloud 비공개 릴레이나 모바일 데이터 때문인 경우가 많습니다.",
          code: ["연결됨 · 내 기기 iPhone · 공인 IP 203.0.113.9"],
        },
        {
          text: "이제 각 휴대폰의 “주변 기기”에 상대가 나타납니다. 보내는 폰에서 받는 쪽을 탭하고 “작업 공간 열기”를 누르세요. 최신 브라우저에서 카드가 제공하는 동작은 이 하나뿐이며, 이후 파일과 메시지가 그때 열리는 암호화된 연결 하나를 함께 씁니다.",
        },
        {
          text: "작업 공간이 그 카드를 대신하고, 그 컨트롤이 둘 다 담당합니다: 한 배치에 최대 1,000개라면 “파일 보내기”, 또는 메시지 상자에 입력하고 “보내기”를 누릅니다. “폴더 보내기”는 안드로이드 폰에는 나오지만 아이폰에는 나오지 않습니다 — iOS 브라우저는 어느 것도 페이지가 폴더를 고르게 하지 않기 때문입니다. 그다음 받는 아이폰에서는 수락하기 전에 요청 아래 줄을 읽으세요 — Safari가 저장 위치를 물을지, 자기 다운로드 폴더에 바로 쓸지가 적혀 있습니다 — 그리고 “받기”를 탭합니다.",
        },
        {
          text: "파일 카운터가 마지막 파일에 닿을 때까지 두 브라우저 탭을 맨 앞에 두세요. 먼저 검증 코드(SAS)를 대조하려면 시작 전에 두 휴대폰에서 “고급 검증”을 켜세요. 일치한다는 것은 두 휴대폰이 같은 종단간 암호화 세션에 참여했다는 뜻일 뿐, 암호문이 어떤 네트워크 경로로 이동하는지는 증명하지 않습니다. 꺼 두면 대조할 코드가 없을 뿐, 세션은 그대로 암호화됩니다.",
        },
      ],
      success: {
        label: "전송이 잘될 때의 화면",
        body: [
          "그때쯤 상대 카드는 사라져 있습니다 — 작업 공간이 그 자리를 차지했으니까요 — 그래서 상태는 작업 공간 헤더에서 읽습니다: 연결된 기기, “연결됨”이라는 링크 상태, 그리고 하나뿐인 경로 배지 “LAN 직접”. 두 화면의 파일 카운터는 그 배치의 마지막 파일에서 멈춥니다.",
          "그다음 확인할 것은 페이지가 아니라 파일입니다. 아이폰에서는 파일 앱의 다운로드 폴더 — Safari가 다운로드를 넣는 자리 — 이고, 안드로이드 폰에서는 브라우저 자체의 다운로드 목록 — Chrome은 chrome://downloads, Firefox는 about:downloads — 입니다.",
        ],
        code: ["iPhone 에 연결됨 · 연결됨 · LAN 직접\n파일 2/2"],
      },
    },
    {
      heading: "두 휴대폰이 서로 보이지 않을 때",
      body: [
        "아이폰에서 먼저 알아둘 만한 원인이 하나 있습니다. 많은 iCloud+ 계정에서 iCloud 비공개 릴레이가 켜져 있고, 그것이 휴대폰이 밖으로 보이는 공인 IP를 바꾸는데, 같은 네트워크 탐색이 바로 그 주소로 기기를 묶습니다. 이것은 흔한 원인 중 하나일 뿐 유일한 원인은 아니며, 아래 확인은 전부를 담은 목록이 아니라 통상적인 1차 점검으로, 각 항목이 이미 화면에 있는 것만으로 그 경우를 가려냅니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "아이폰이 안드로이드 폰에 끝내 나타나지 않거나, 그 반대입니다.",
            code: ["https://relayium.com/   # 두 휴대폰의 상태 표시에 있는 공인 IP를 비교한다"],
            fix: "공인 IP가 다르면 방도 둘입니다. 아이폰에서는 iCloud 비공개 릴레이가 흔한 원인 하나이고, 휴대폰이 슬그머니 모바일 데이터에 남아 있는 것이 또 하나이며, 어느 쪽도 유일한 가능성은 아닙니다. 설정을 바꿔도 괜찮다면 ‘설정 › Wi-Fi › 해당 네트워크 › IP 주소 추적 제한’에서 그 한 Wi-Fi에 대해 비공개 릴레이를 끄거나 Wi-Fi에 접속한 뒤 https://relayium.com/ 을 다시 불러오세요. 비공개 릴레이나 VPN을 켜둔 채로 두고 싶다면, https://relayium.com/cross-network 의 페어링 코드가 둘 중 어느 것도 건드리지 않고 그 휴대폰에 닿습니다.",
          },
          {
            symptom: "두 휴대폰이 같은 공인 IP를 보여주는데도 어느 카드도 나타나지 않습니다.",
            code: ["https://relayium.com/   # 기기 목록 아래 안내에 바꿔야 할 공유기 설정 이름이 있다"],
            fix: "공유기가 자기 클라이언트를 갈라놓고 있습니다. Wi-Fi 설정에서 ‘AP 격리 / 클라이언트 격리’를 끄세요. 공유기를 바꿀 수 없다면 https://relayium.com/cross-network 의 코드로 두 휴대폰을 네트워크를 넘어 페어링하세요.",
          },
          {
            symptom: "수락하기 전에, 아이폰이 배치 전체를 메모리에 담아야 한다고 경고합니다.",
            code: ["https://relayium.com/   # 경고에 곧 담게 될 배치 크기가 적혀 있다"],
            fix: "아이폰의 브라우저는 모두 WebKit이고 File System Access API가 없어 배치가 메모리에서 조립되며, 대략 256 MiB를 넘으면 Relayium이 경고합니다. 한 번에 보내는 파일 수를 줄이거나, 그 파일은 크기 상한 없이 디스크로 바로 쓰는 컴퓨터의 Chrome이나 Edge로 보내세요.",
          },
          {
            symptom: "카운터는 끝났는데 아이폰에서 파일을 찾을 수 없습니다.",
            code: ["https://relayium.com/   # 요청 아래 줄이 이 브라우저의 저장 위치를 이미 알려주었다"],
            fix: "Safari는 다운로드를 사진 라이브러리에 넣지 않습니다. 파일 앱의 다운로드에서 찾으세요. 정확한 위치는 ‘설정 › Safari › 다운로드’가 iCloud Drive를 가리키는지 기기 내부를 가리키는지에 따릅니다. 거기서 열면 되고, 사진이 사진 앱으로 들어가는 것은 그 파일에서 직접 저장했을 때뿐입니다.",
          },
          {
            symptom: "앱을 전환하거나 화면이 잠기면 전송이 멈추거나 실패합니다.",
            code: ["https://relayium.com/   # 두 휴대폰에서 Relayium 탭이 맨 앞에 있어야 한다"],
            fix: "백그라운드 탭은 두 휴대폰 어느 쪽에서든 조여지거나 정지될 수 있고, 그러는 동안에는 바이트가 움직이지 않습니다. Relayium은 브라우저가 지원하면 화면 웨이크 록을 요청해 화면이 꺼지는 것은 막지만, 백그라운드 실행을 주지도 않고 앱 전환을 막지도 못합니다. 카운터가 끝날 때까지 두 탭을 맨 앞에 두세요.",
          },
        ],
      },
    },
    {
      heading: "다른 네트워크라면? 페어링 코드를 쓰세요",
      body: [
        "같은 Wi-Fi일 필요는 없습니다. 휴대폰이 서로 다른 네트워크에 있어도 — 하나는 모바일 데이터, 다른 하나는 집 Wi-Fi — Relayium은 페어링 코드로 둘을 연결할 수 있습니다. 다만 페어링 코드 방은 “주변 기기” 작업 공간과 별개의 화면이며, 기기별로 나뉜 이전 컨트롤을 그대로 쓰므로 거기에는 누를 “작업 공간 열기”가 없습니다.",
        "보내는 기기가 짧은 페어링 코드를 표시하니, 다른 폰에서 입력하세요(또는 생성된 공유 링크를 여세요). 이렇게 맺어지는 네트워크 간 전송은 두 폰 사이의 직접 연결이 아니라 암호화된 TURN 릴레이를 통해 이루어집니다. 이는 의도된 설계입니다. Relayium은 곧장 릴레이를 쓰기 때문에, 연결이 두 네트워크 사이의 NAT와 방화벽을 통과하는 직접 경로를 찾아내는 데 의존하지 않습니다. NAT나 방화벽이 그런 경로를 막을 수도 있습니다. 릴레이는 암호문만 전달하며, 파일은 폰을 떠나기 전에 이미 종단간으로 봉인되므로 릴레이가 내용을 읽을 수는 없습니다. 전송 중 연결이 끊겨도 처음부터가 아니라 이어서 재개할 수 있습니다. 이 방식으로 보내려면 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 계정이 필요 없습니다. 코드는 5분 동안만 유효하니, 만들기 전에 두 기기를 모두 곁에 두세요.",
      ],
    },
    {
      heading: "안드로이드와 아이폰 사이에서 파일을 옮기는 다른 방법",
      body: [
        "Relayium만이 선택지는 아니며, 대안의 솔직한 절충점을 알아 둘 가치가 있습니다:",
      ],
      bullets: [
        "구글의 퀵 셰어나 SHAREit 같은 서드파티 앱은 빠르게 옮기지만, 두 폰 모두에 설치가 필요하고 퀵 셰어는 아이폰에 닿지 않습니다.",
        "클라우드 드라이브(구글 드라이브, iCloud, Dropbox)는 상대가 오프라인일 때도 되지만, 같은 파일을 올렸다가 다시 내려받아 두 번 옮기게 되고, 용량을 차지하며, 제공자가 사본을 보관합니다.",
        "채팅 앱과 이메일은 어디에나 있지만, 대개 사진을 재압축하고 첨부 크기를 제한하며, 파일 공유는 종단간 암호화가 아닙니다.",
        "USB 케이블은 확실하지만 USB-C와 Lightning 사이에 맞는 어댑터가 필요하고, 많은 파일 형식은 중간에 컴퓨터까지 있어야 합니다.",
      ],
    },
    {
      heading: "사진 화질이 떨어지나요?",
      body: [
        "아니요. 메시징 앱과 달리 Relayium은 원본 파일을 바이트 단위 그대로 보냅니다 — 재압축도, 크기 조정도 없습니다. 아이폰에 도착하는 것은 안드로이드 폰에서 나간 것의 정확한 사본입니다.",
        "이를 증명하기 위해 각 파일은 SHA-256 해시로 종단간 검증되므로, 도착한 사진이나 동영상은 보낸 것과 반드시 동일합니다. 큰 파일도 잘 처리됩니다. File System Access API가 있는 브라우저(데스크톱 Chrome, Edge)는 들어오는 파일을 크기 제한 없이 곧바로 디스크에 씁니다. Firefox와 Safari, 그리고 휴대폰 브라우저(아이폰은 전부 WebKit입니다)에는 그 API가 없어서 받은 내용을 일단 메모리에 모으게 되며, 대략 256MB를 넘어서면 Relayium이 수락하기 전에 미리 경고합니다. 이 수치는 측정된 상한이 아니라 일부러 보수적으로 잡은 추정치이고, 실제로 무너지는 지점은 기기 메모리와 OS, 열어 둔 탭 수에 따라 달라집니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "두 폰 중 어느 쪽에든 앱을 설치해야 하나요?",
        a: "아니요. Relayium은 안드로이드와 아이폰 모두에서 전적으로 브라우저에서 동작합니다. 각 기기에서 relayium.com을 열면 준비 끝입니다 — 어느 쪽이든 다운로드는 필요 없습니다. 같은 네트워크에서는 실시간 전송에 계정이 필요 없고, 네트워크를 넘는 페어링도 보내는 쪽이 로그인만 하면 됩니다. 원하면 PWA로 홈 화면에 추가할 수 있지만, 그것은 바로가기일 뿐입니다.",
      },
      {
        q: "두 폰이 반드시 같은 Wi-Fi에 있어야 하나요?",
        a: "아니요. 같은 네트워크는 기기가 자동으로 서로를 찾기 때문에 가장 빠른 경로이지만, 페어링 코드로 두 폰을 서로 다른 네트워크를 넘어 연결할 수 있습니다 — 하나가 모바일 데이터, 다른 하나가 Wi-Fi여도 됩니다. 두 경우 모두 전송은 종단간 암호화를 유지하지만, 네트워크를 넘는 페어링에는 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 계정이 필요 없습니다.",
      },
      {
        q: "사진이 압축되거나 어떤 식으로든 바뀌나요?",
        a: "아니요. 원본 파일은 압축 없이 바이트 단위로 전송되고, 각 파일은 SHA-256 해시로 종단간 검증되므로, 아이폰에 도착하는 것은 안드로이드에서 보낸 것과 비트 단위로 동일합니다.",
      },
    ],
  },
  cta: {
    text: "두 폰에서 Relayium을 열고 첫 파일을 보내 보세요 — 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien von Android auf iPhone übertragen (ohne Kabel)",
  description:
    "Eine Schritt-für-Schritt-Anleitung, um Fotos, Videos und Dokumente im Browser von Android auf iPhone zu senden — ohne AirDrop, ohne Kabel, ohne Cloud-Upload. Öffne einfach Relayium auf beiden Geräten.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Android und iPhone teilen sich kein AirDrop, also bedeutet es, ein paar Fotos oder ein Video zu übertragen, meist ein USB-Kabel, eine Chat-App, die deine Bilder komprimiert, oder einen Umweg über irgendeine Cloud. Alle drei sind langsamer und umständlicher, als sie sein müssten.",
    "Relayium spart dir all das. Beide Handys öffnen dieselbe Seite: Im selben LAN werden die Ende-zu-Ende-verschlüsselten Dateien direkt übertragen; netzübergreifend transportiert ein TURN-Relay nur Chiffretext, den es weder lesen noch entschlüsseln kann, und behält weder Echtzeitinhalte noch einen Verlauf. Eine App ist nicht nötig; beim netzübergreifenden Pairing meldet sich der Ersteller an, die beitretende Person braucht nie ein Konto. Diese Anleitung führt dich Schritt für Schritt hindurch.",
  ],
  sections: [
    {
      heading: "Was du vorher brauchst",
      body: [
        "Nichts zu installieren. Im selben Netz gibt es auch nichts zu registrieren — Echtzeitübertragungen laufen direkt aus dem Browser auf beiden Geräten.",
      ],
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Ein Android-Handy mit Chrome (oder einem beliebigen modernen Browser) und ein iPhone mit Safari — beide auf dem neuesten Stand.",
          "Für den schnellsten Weg beide Geräte im selben WLAN. Auf dem iPhone heißt das meist außerdem: iCloud Private Relay für dieses eine Netz aus. Es schickt das Handy über eine andere öffentliche IP hinaus, und die Erkennung im selben Netz gruppiert Geräte genau nach dieser Adresse. Es anzulassen ist eine völlig gute Wahl — dann erreicht ein Pairing-Code auf https://relayium.com/cross-network das Handy, ohne die Einstellung zu ändern.",
          "Auf beiden Handys die Seite über https://relayium.com/ geöffnet. Verschlüsselte Übertragung braucht HTTPS, und über einfaches http:// sagt die Seite das, statt Geräte aufzulisten.",
          "Die Dateien, die du senden willst, bis zu 1.000 pro Stapel, und ein Platz dafür auf dem empfangenden Handy — welcher Ordner das ist, entscheidet dessen Browser und nicht Relayium.",
        ],
      },
    },
    {
      heading: "Schritt für Schritt: beide Geräte im selben WLAN",
      body: [
        "Das ist der einfachste Weg. Im selben Netz erkennen sich die beiden Handys automatisch, sodass es fast nichts einzutippen gibt.",
      ],
      steps: [
        {
          text: "Öffne auf dem Android-Handy und dem iPhone jeweils die Übertragungsseite im Browser.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Vergleiche die öffentliche IP in der Statuszeile auf beiden Handys. Übereinstimmende Adressen stecken die beiden in einen Raum; eine andere auf dem iPhone bedeutet häufig iCloud Private Relay oder Mobilfunk und nicht ein kaputtes WLAN.",
          code: ["Verbunden · dieses Gerät iPhone · öffentliche IP 203.0.113.9"],
        },
        {
          text: "Jetzt listet jedes Handy das andere unter „Geräte in der Nähe“. Tippe auf dem sendenden Handy das empfangende an und drücke „Arbeitsbereich öffnen“. In einem aktuellen Browser ist das die einzige Aktion der Karte, denn Dateien und Nachrichten teilen sich danach die eine verschlüsselte Verbindung, die sie öffnet.",
        },
        {
          text: "Der Arbeitsbereich tritt an die Stelle dieser Karte, und seine Bedienelemente tragen beides: „Dateien senden“ für einen Stapel von bis zu 1.000, oder tippe ins Nachrichtenfeld und drücke „Senden“. „Ordner senden“ gibt es auf dem Android-Handy, auf dem iPhone nicht, weil kein iOS-Browser eine Seite einen Ordner auswählen lässt. Lies dann auf dem empfangenden iPhone die Zeile unter der Anfrage, bevor du annimmst — sie sagt, ob Safari nach dem Speicherort fragt oder in seine eigenen Downloads schreibt —, und tippe „Annehmen“.",
        },
        {
          text: "Lass beide Browser-Tabs vorn, bis der Dateizähler die letzte Datei erreicht. Wer zuerst einen Verifizierungscode (SAS) vergleichen will, schaltet vor dem Start auf beiden Handys „Erweiterte Verifizierung“ ein: Eine Übereinstimmung bestätigt, dass beide Handys derselben Ende-zu-Ende-verschlüsselten Sitzung beigetreten sind, nicht welchen Netzwerkweg der Chiffretext nimmt. Bleibt sie aus, gibt es keinen Code zum Vergleichen; verschlüsselt ist die Sitzung trotzdem.",
        },
      ],
      success: {
        label: "So sieht eine funktionierende Übertragung aus",
        body: [
          "Die Karte des anderen Handys ist dann verschwunden — der Arbeitsbereich hat ihren Platz übernommen —, der Zustand wird also an der Kopfzeile des Arbeitsbereichs abgelesen: das verbundene Gerät, ein Verbindungszustand „Verbunden“ und ein einziges Pfad-Abzeichen mit „LAN direkt“. Der Dateizähler endet auf beiden Bildschirmen bei der letzten Datei des Stapels.",
          "Danach prüfst du die Datei statt der Seite. Auf dem iPhone ist das der Ordner Downloads in der Dateien-App, wohin Safari einen Download legt; auf dem Android-Handy die Download-Liste des Browsers selbst — chrome://downloads in Chrome, about:downloads in Firefox.",
        ],
        code: ["Verbunden mit iPhone · Verbunden · LAN direkt\nDatei 2/2"],
      },
    },
    {
      heading: "Wenn sich die beiden Handys nicht sehen",
      body: [
        "Eine Ursache lohnt sich auf dem iPhone zu kennen: iCloud Private Relay ist bei vielen iCloud+-Konten aktiv und ändert die öffentliche IP, unter der das Handy erscheint — und genau danach gruppiert die Erkennung im selben Netz. Sie ist eine von mehreren häufigen Ursachen und nicht die einzige, und die Prüfungen unten sind die üblichen ersten und keine vollständige Liste; jede entscheidet ihren Fall mit dem, was schon auf dem Bildschirm steht.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Das iPhone erscheint nie auf dem Android-Handy, oder umgekehrt.",
            code: ["https://relayium.com/   # die öffentliche IP in der Statuszeile auf beiden Handys vergleichen"],
            fix: "Zwei verschiedene öffentliche IP-Adressen bedeuten zwei Räume. Auf einem iPhone ist iCloud Private Relay eine häufige Ursache, ein Handy, das still auf Mobilfunk geblieben ist, eine weitere; keine von beiden ist die einzige Möglichkeit. Wenn du sie ändern willst, schalte Private Relay unter „Einstellungen › WLAN › das Netzwerk › IP-Adresse verbergen“ für dieses eine WLAN ab oder wechsle ins WLAN, und lade dann https://relayium.com/ neu. Willst du Private Relay oder ein VPN lieber anlassen, erreicht ein Pairing-Code auf https://relayium.com/cross-network das Handy, ohne eines von beiden anzutasten.",
          },
          {
            symptom: "Beide Handys zeigen dieselbe öffentliche IP, und keine Karte erscheint.",
            code: ["https://relayium.com/   # der Hinweis unter der Geräteliste nennt die Router-Einstellung"],
            fix: "Der Router trennt seine eigenen Clients. Schalte „AP-Isolierung / Client-Isolierung“ in seinen WLAN-Einstellungen aus, oder koppel die beiden Handys mit einem Code auf https://relayium.com/cross-network über Netzwerkgrenzen hinweg, wenn der Router nicht dir gehört.",
          },
          {
            symptom: "Vor dem Annehmen warnt das iPhone, es müsse den ganzen Stapel im Speicher halten.",
            code: ["https://relayium.com/   # die Warnung nennt die Stapelgröße, die es halten soll"],
            fix: "Jeder iPhone-Browser ist WebKit und hat keine File System Access API, der Stapel wird also im Speicher zusammengesetzt und Relayium warnt ab etwa 256 MiB. Schicke weniger Dateien auf einmal, oder schicke diese Datei in ein Chrome oder Edge am Computer, das sie ohne Größengrenze direkt auf die Platte schreibt.",
          },
          {
            symptom: "Der Zähler ist durch, aber die Datei ist auf dem iPhone nicht zu finden.",
            code: ["https://relayium.com/   # die Zeile unter der Anfrage sagte, wohin dieser Browser speichert"],
            fix: "Safari legt einen Download nicht in die Fotobibliothek. Schau in der Dateien-App unter Downloads — der genaue Ort ist der, auf den „Einstellungen › Safari › Downloads“ zeigt, iCloud Drive oder das iPhone selbst — und öffne sie dort; ein Foto landet nur in der Fotos-App, wenn du es selbst aus der Datei heraus speicherst.",
          },
          {
            symptom: "Die Übertragung bleibt stehen oder scheitert, wenn du die App wechselst oder der Bildschirm sperrt.",
            code: ["https://relayium.com/   # auf beiden Handys muss der Relayium-Tab der vorderste sein"],
            fix: "Ein Tab im Hintergrund kann auf beiden Handys gebremst oder eingefroren werden, und solange das so ist, bewegt sich kein Byte. Relayium fordert eine Bildschirm-Wake-Lock an, wo der Browser eine anbietet — das deckt den abschaltenden Bildschirm ab, verschafft aber keine Ausführung im Hintergrund und übersteht keinen App-Wechsel. Lass beide Tabs vorn, bis der Zähler durch ist.",
          },
        ],
      },
    },
    {
      heading: "In verschiedenen Netzwerken? Nutze einen Pairing-Code",
      body: [
        "Ihr müsst nicht im selben WLAN sein. Sind die Handys in verschiedenen Netzwerken — eines im Mobilfunk, das andere im Heim-WLAN — kann Relayium sie trotzdem per Pairing-Code verbinden. Ein Pairing-Code-Raum ist allerdings eine andere Oberfläche als ein Arbeitsbereich mit einem Gerät in der Nähe: Er behält die früheren, pro Gerät getrennten Bedienelemente, dort gibt es also kein „Arbeitsbereich öffnen“ zu drücken.",
        "Das sendende Gerät zeigt einen kurzen Pairing-Code; gib ihn auf dem anderen Handy ein (oder öffne den erzeugten Freigabelink). Eine so aufgebaute netzübergreifende Übertragung läuft über ein verschlüsseltes TURN-Relay statt über eine direkte Verbindung zwischen den beiden Handys — und das mit Absicht: Relayium nimmt gleich das Relay, sodass die Verbindung nicht davon abhängt, einen direkten Weg durch die NATs und Firewalls zwischen den beiden Netzwerken zu finden — die einen solchen Weg verhindern können. Das Relay leitet ausschließlich Chiffretext weiter; die Dateien sind bereits Ende-zu-Ende versiegelt, bevor sie dein Handy verlassen, es kann sie also nie lesen. Bricht die Verbindung mittendrin ab, kann sie fortgesetzt statt neu gestartet werden. Für diesen Weg muss sich der Absender anmelden — der Empfänger braucht nie ein Konto. Der Code gilt fünf Minuten — halte beide Geräte bereit, bevor du einen erzeugst.",
      ],
    },
    {
      heading: "Andere Wege, Dateien zwischen Android und iPhone zu bewegen",
      body: [
        "Relayium ist nicht die einzige Option, und es lohnt sich, die ehrlichen Kompromisse der Alternativen zu kennen:",
      ],
      bullets: [
        "Googles Quick Share und Drittanbieter-Apps wie SHAREit übertragen schnell, brauchen aber eine Installation auf beiden Handys, und Quick Share erreicht keine iPhones.",
        "Eine Cloud (Google Drive, iCloud, Dropbox) funktioniert, wenn die andere Person offline ist, aber du lädst dieselbe Datei zweimal hoch und wieder herunter, es zählt gegen dein Kontingent, und der Anbieter behält eine Kopie.",
        "Chat-Apps und E-Mail sind überall, komprimieren Fotos aber meist erneut, begrenzen die Anhangsgröße und sind beim Dateiaustausch nicht Ende-zu-Ende-verschlüsselt.",
        "Ein USB-Kabel ist zuverlässig, braucht aber den passenden Adapter zwischen USB-C und Lightning und für viele Dateitypen zusätzlich einen Computer dazwischen.",
      ],
    },
    {
      heading: "Verlieren meine Fotos an Qualität?",
      body: [
        "Nein. Anders als eine Messaging-App sendet Relayium die Originaldatei Byte für Byte — keine erneute Komprimierung, keine Größenänderung. Was auf dem iPhone ankommt, ist eine exakte Kopie dessen, was das Android-Handy verlassen hat.",
        "Zum Beleg wird jede Datei per SHA-256-Hash Ende-zu-Ende geprüft, sodass ein ankommendes Foto oder Video garantiert identisch mit dem gesendeten ist. Auch große Dateien werden gut gehandhabt: Ein Browser mit der File System Access API (Chrome oder Edge auf dem Desktop) schreibt die eingehende Datei ohne Größenbegrenzung direkt auf die Festplatte. Firefox, Safari und Handy-Browser — auf dem iPhone steckt immer WebKit dahinter — haben diese API nicht, dort sammelt sich der Empfang stattdessen im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium dich, bevor du annimmst. Dieser Wert ist eine bewusst vorsichtige Schätzung und keine gemessene Obergrenze: Wo es tatsächlich kippt, hängt vom Arbeitsspeicher des Geräts, vom Betriebssystem und von der Zahl der offenen Tabs ab.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss ich auf einem der Handys eine App installieren?",
        a: "Nein. Relayium läuft auf Android und iPhone vollständig im Browser. Öffne auf jedem Gerät relayium.com, und du bist startklar — einen Download braucht es so oder so nicht. Im selben Netz braucht eine Echtzeitübertragung kein Konto; Pairing über Netzwerke hinweg verlangt nur die Anmeldung des Absenders. Optional kannst du es als PWA zum Startbildschirm hinzufügen, aber das ist nur eine Verknüpfung.",
      },
      {
        q: "Müssen beide Handys im selben WLAN sein?",
        a: "Nein. Dasselbe Netz ist der schnellste Weg, weil sich die Geräte automatisch erkennen, aber ein Pairing-Code verbindet zwei Handys über verschiedene Netzwerke hinweg — auch eines im Mobilfunk und eines im WLAN. Die Übertragung bleibt in beiden Fällen Ende-zu-Ende-verschlüsselt, wobei Pairing über Netzwerke hinweg die Anmeldung des Absenders erfordert — der Empfänger braucht nie ein Konto.",
      },
      {
        q: "Werden die Fotos komprimiert oder irgendwie verändert?",
        a: "Nein. Die Originaldatei wird Byte für Byte ohne Komprimierung übertragen, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, sodass das, was auf dem iPhone ankommt, Bit für Bit identisch mit dem ist, was du von Android gesendet hast.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf beiden Handys und schick deine ersten Dateien hinüber — keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer des fichiers d'Android vers iPhone (sans câble)",
  description:
    "Un guide pas à pas pour envoyer photos, vidéos et documents d'Android vers iPhone dans le navigateur — sans AirDrop, sans câble, sans envoi vers le cloud. Ouvrez simplement Relayium sur les deux appareils.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Android et iPhone ne partagent pas d'AirDrop, donc déplacer quelques photos ou une vidéo entre eux passe le plus souvent par un câble USB, une messagerie qui compresse vos images, ou un aller-retour via un espace cloud. Les trois sont plus lents et plus pénibles qu'ils ne devraient l'être.",
    "Relayium fait l'impasse sur tout cela. Les deux téléphones ouvrent la même page : sur le même LAN, les fichiers chiffrés de bout en bout passent directement ; entre réseaux, un relais TURN ne transporte que du texte chiffré qu'il ne peut ni lire ni déchiffrer, sans conserver de copie ni d'historique du contenu en temps réel. Aucune application à installer ; pour l'appairage entre réseaux, le créateur se connecte et la personne qui rejoint n'a jamais besoin de compte. Ce guide vous accompagne pas à pas.",
  ],
  sections: [
    {
      heading: "Ce qu'il vous faut avant de commencer",
      body: [
        "Rien à installer. Sur le même réseau, rien à créer non plus — les transferts en temps réel fonctionnent directement depuis le navigateur sur les deux appareils.",
      ],
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Un téléphone Android avec Chrome (ou n'importe quel navigateur moderne) et un iPhone avec Safari — tous deux à jour.",
          "Pour la voie la plus rapide, les deux appareils sur le même réseau Wi-Fi. Sur l'iPhone, cela veut dire le plus souvent aussi désactiver iCloud Private Relay pour ce seul réseau : il fait sortir le téléphone par une autre IP publique, et la détection sur le même réseau regroupe les appareils précisément sur cette adresse. Le laisser actif est un choix parfaitement valable — un code d'appairage sur https://relayium.com/cross-network atteint alors le téléphone sans changer le réglage.",
          "La page ouverte via https://relayium.com/ sur les deux téléphones. Le transfert chiffré exige HTTPS, et en simple http:// la page le dit au lieu de lister des appareils.",
          "Les fichiers à envoyer et de la place pour eux sur le téléphone qui reçoit, dont le dossier relève de son navigateur et non de Relayium. Jusqu'à 1 000 par lot.",
        ],
      },
    },
    {
      heading: "Pas à pas : les deux appareils sur le même Wi-Fi",
      body: [
        "C'est la voie la plus simple. Sur le même réseau, les deux téléphones se découvrent automatiquement, il n'y a donc presque rien à saisir.",
      ],
      steps: [
        {
          text: "Sur le téléphone Android et sur l'iPhone, ouvrez la page de transfert dans le navigateur.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Comparez l'IP publique de la ligne d'état sur les deux téléphones. Des adresses identiques placent les deux dans une même salle, tandis qu'une adresse différente sur l'iPhone signifie souvent iCloud Private Relay ou les données mobiles, et non un Wi-Fi en panne.",
          code: ["Connecté · cet appareil iPhone · IP publique 203.0.113.9"],
        },
        {
          text: "Chaque téléphone liste maintenant l'autre sous « Appareils à proximité ». Sur celui qui envoie, touchez celui qui reçoit et appuyez sur « Ouvrir l’espace de travail ». Sur un navigateur actuel c'est la seule action de la carte, car fichiers et messages partagent ensuite l'unique connexion chiffrée qu'elle ouvre.",
        },
        {
          text: "L'espace de travail remplace cette carte, et ses commandes portent les deux. Utilisez « Envoyer des fichiers » pour envoyer une fournée, jusqu'à 1 000 par lot. « Envoyer un dossier » est proposé sur le téléphone Android mais pas sur l'iPhone, car aucun navigateur iOS ne laisse une page choisir un dossier. Vous pouvez aussi taper dans la zone de message et appuyer sur « Envoyer ». Puis, sur l'iPhone qui reçoit, lisez la ligne sous la demande avant d'accepter : elle indique si Safari demandera où enregistrer ou écrira dans ses propres téléchargements. Touchez ensuite « Accepter ».",
        },
        {
          text: "Laissez les deux onglets au premier plan jusqu'à ce que le compteur atteigne le dernier fichier. Pour comparer un code de vérification (SAS) d'abord, activez « Vérification avancée » sur les deux téléphones avant de commencer, et les deux écrans afficheront alors le même code à 6 chiffres : vérifiez qu'il concorde. Une correspondance confirme que les deux téléphones ont rejoint la même session chiffrée de bout en bout, pas le chemin réseau emprunté par le texte chiffré. Sans elle, il n'y a aucun code à comparer et la session reste chiffrée.",
        },
      ],
      success: {
        label: "À quoi ressemble un transfert qui marche",
        body: [
          "La carte de l'autre téléphone a disparu à ce stade — l'espace de travail a pris sa place — alors l'état se lit sur l'en-tête de l'espace de travail : l'appareil auquel vous êtes connecté, un état de lien « Connecté », et un unique badge de chemin indiquant « LAN direct ». Le compteur de fichiers s'arrête sur le dernier fichier du lot sur les deux écrans.",
          "Ensuite, confirmez le fichier plutôt que la page. Sur l'iPhone, c'est le dossier Téléchargements de l'app Fichiers, là où Safari dépose un téléchargement, et sur le téléphone Android, la liste de téléchargements du navigateur lui-même — chrome://downloads dans Chrome, about:downloads dans Firefox.",
        ],
        code: ["Connecté à iPhone · Connecté · LAN direct\nFichier 2/2"],
      },
    },
    {
      heading: "Quand les deux téléphones ne se voient pas",
      body: [
        "Une cause vaut la peine d'être connue sur l'iPhone : iCloud Private Relay est actif sur beaucoup de comptes iCloud+ et change l'IP publique sous laquelle le téléphone apparaît — or c'est exactement ce qui sert à regrouper les appareils du même réseau. C'est une cause courante parmi plusieurs et non la seule, et les vérifications ci-dessous sont les premières habituelles plutôt qu'une liste exhaustive ; chacune tranche son cas avec ce qui est déjà à l'écran.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "L'iPhone n'apparaît jamais sur le téléphone Android, ou l'inverse.",
            code: ["https://relayium.com/   # comparez l'IP publique de la ligne d'état sur les deux téléphones"],
            fix: "Deux adresses IP publiques différentes, ce sont deux salles. Sur un iPhone, iCloud Private Relay est une cause courante, et un téléphone resté en données mobiles une autre ; aucune des deux n'est la seule possibilité. Si vous acceptez de les changer, désactivez Private Relay pour ce seul Wi-Fi dans Réglages › Wi-Fi › le réseau › Limiter le suivi d'adresse IP, ou rejoignez le Wi-Fi, puis rechargez https://relayium.com/. Si vous préférez laisser Private Relay ou un VPN actif, un code d'appairage sur https://relayium.com/cross-network atteint le téléphone sans toucher à l'un ni à l'autre.",
          },
          {
            symptom: "Les deux téléphones affichent la même IP publique et aucune carte n'apparaît.",
            code: ["https://relayium.com/   # l'indication sous la liste des appareils nomme le réglage du routeur"],
            fix: "Le routeur sépare ses propres clients. Désactivez « l'isolation AP / isolation des clients » dans ses réglages Wi-Fi, ou appairez les deux téléphones entre réseaux différents avec un code sur https://relayium.com/cross-network quand le routeur ne vous appartient pas.",
          },
          {
            symptom: "Avant l'acceptation, l'iPhone avertit qu'il doit garder tout le lot en mémoire.",
            code: ["https://relayium.com/   # l'avertissement indique la taille du lot qu'il devrait retenir"],
            fix: "Tous les navigateurs d'iPhone sont WebKit et n'ont pas d'API File System Access, le lot y est donc assemblé en mémoire et Relayium avertit au-delà d'environ 256 MiB. Envoyez moins de fichiers à la fois, ou envoyez ce fichier vers un Chrome ou Edge d'ordinateur, qui l'écrit directement sur le disque sans limite de taille.",
          },
          {
            symptom: "Le compteur est arrivé au bout mais le fichier est introuvable sur l'iPhone.",
            code: ["https://relayium.com/   # la ligne sous la demande indiquait où ce navigateur enregistre"],
            fix: "Safari ne place pas un téléchargement dans la photothèque. Regardez dans l'app Fichiers, sous Téléchargements — l'emplacement exact est celui que désigne Réglages › Safari › Téléchargements, iCloud Drive ou l'iPhone lui-même — et ouvrez-le depuis là. Une photo ne rejoint l'app Photos que si vous l'enregistrez vous-même depuis le fichier.",
          },
          {
            symptom: "Le transfert se bloque ou échoue quand vous changez d'application ou que l'écran se verrouille.",
            code: ["https://relayium.com/   # sur les deux téléphones, l'onglet Relayium doit être celui au premier plan"],
            fix: "Un onglet en arrière-plan peut être bridé voire suspendu sur l'un comme sur l'autre téléphone, et pendant ce temps aucun octet ne circule. Relayium demande un verrou d'écran là où le navigateur en propose un, ce qui couvre l'extinction de l'écran mais n'achète aucune exécution en arrière-plan et ne survit pas à un changement d'application : laissez les deux onglets devant jusqu'à la fin du compteur.",
          },
        ],
      },
    },
    {
      heading: "Sur des réseaux différents ? Utilisez un code d'appairage",
      body: [
        "Vous n'avez pas besoin d'être sur le même Wi-Fi. Si les téléphones sont sur des réseaux différents — l'un en données mobiles, l'autre sur le Wi-Fi de la maison — Relayium peut quand même les connecter avec un code d'appairage. Une salle à code d'appairage reste toutefois une surface distincte d'un espace de travail avec un appareil à proximité : elle conserve les anciennes commandes séparées par appareil, il n'y a donc pas d'« Ouvrir l’espace de travail » à y presser.",
        "L'appareil qui envoie affiche un court code d'appairage ; saisissez-le sur l'autre téléphone (ou ouvrez le lien de partage qu'il génère). Un transfert établi ainsi entre deux réseaux passe par un relais TURN chiffré plutôt que par une liaison directe entre les deux téléphones — et c'est délibéré : Relayium emprunte le relais d'emblée, si bien que la connexion ne dépend pas de la découverte d'une voie directe à travers les NAT et pare-feu situés entre les deux réseaux, qui peuvent en empêcher une. Le relais ne transmet que du texte chiffré ; les fichiers sont scellés de bout en bout avant de quitter votre téléphone, il ne peut donc jamais les lire. Si la connexion se coupe en cours de route, il peut reprendre au lieu de tout recommencer. Envoyer ainsi exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte. Le code est valable cinq minutes : ayez les deux appareils sous la main avant d'en générer un.",
      ],
    },
    {
      heading: "Autres façons de déplacer des fichiers entre Android et iPhone",
      body: [
        "Relayium n'est pas la seule option, et il vaut la peine de connaître les compromis honnêtes des solutions de rechange :",
      ],
      bullets: [
        "Le Partage rapide de Google et des applications tierces comme SHAREit transfèrent vite, mais exigent une installation sur les deux téléphones, et le Partage rapide n'atteint pas les iPhone.",
        "Un espace cloud (Google Drive, iCloud, Dropbox) fonctionne quand l'autre personne est hors ligne, mais vous téléversez puis téléchargez deux fois le même fichier, cela grignote votre quota, et le fournisseur en garde une copie.",
        "Les messageries et l'e-mail sont partout, mais elles recompressent souvent les photos, limitent la taille des pièces jointes et ne sont pas chiffrées de bout en bout pour le partage de fichiers.",
        "Un câble USB est fiable, mais demande le bon adaptateur entre USB-C et Lightning, plus un ordinateur au milieu pour beaucoup de types de fichiers.",
      ],
    },
    {
      heading: "Mes photos perdront-elles en qualité ?",
      body: [
        "Non. Contrairement à une messagerie, Relayium envoie le fichier d'origine octet par octet — aucune recompression, aucun redimensionnement. Ce qui arrive sur l'iPhone est une copie exacte de ce qui a quitté le téléphone Android.",
        "Pour le prouver, chaque fichier est vérifié de bout en bout par une empreinte SHA-256, si bien qu'une photo ou une vidéo qui arrive est garantie identique à celle que vous avez envoyée. Les gros fichiers sont bien gérés aussi : un navigateur doté de l'API File System Access (Chrome ou Edge sur ordinateur) écrit le fichier entrant directement sur le disque, sans limite de taille. Firefox, Safari et les navigateurs de téléphone — sur iPhone, tout est WebKit — n'ont pas cette API : la réception y est assemblée en mémoire, et Relayium vous avertit avant que vous acceptiez dès que l'on dépasse environ 256 Mo. Ce chiffre est une estimation volontairement prudente, pas un plafond mesuré : le point de rupture réel dépend de la mémoire de l'appareil, de son système et du nombre d'onglets ouverts.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je installer une application sur l'un des téléphones ?",
        a: "Non. Relayium fonctionne entièrement dans le navigateur, sur Android comme sur iPhone. Ouvrez relayium.com sur chaque appareil et vous êtes prêt — aucun téléchargement dans les deux cas. Sur le même réseau, un transfert en temps réel ne demande aucun compte ; s'appairer entre réseaux différents demande seulement que l'expéditeur se connecte. Vous pouvez au choix l'ajouter à l'écran d'accueil comme PWA, mais ce n'est qu'un raccourci.",
      },
      {
        q: "Les deux téléphones doivent-ils être sur le même Wi-Fi ?",
        a: "Non. Le même réseau est la voie la plus rapide car les appareils se découvrent automatiquement, mais un code d'appairage connecte deux téléphones sur des réseaux différents — même l'un en données mobiles et l'autre en Wi-Fi. Le transfert reste chiffré de bout en bout dans les deux cas, même si s'appairer entre réseaux différents exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte.",
      },
      {
        q: "Les photos sont-elles compressées ou modifiées d'une quelconque façon ?",
        a: "Non. Le fichier d'origine est transféré octet par octet sans compression, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256, si bien que ce qui arrive sur l'iPhone est identique bit pour bit à ce que vous avez envoyé depuis Android.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur les deux téléphones et envoyez vos premiers fichiers — sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "كيفية نقل الملفات من Android إلى iPhone (دون كابل)",
  description:
    "دليل إرشادي خطوة بخطوة لإرسال الصور ومقاطع الفيديو والمستندات من Android إلى iPhone في المتصفح — دون AirDrop ودون كابل ودون رفع إلى السحابة. ما عليك سوى فتح Relayium على الجهازين.",
  updatedLabel: "آخر تحديث",
  lead: [
    "لا يشترك Android وiPhone في AirDrop، لذا فإن نقل بضع صور أو مقطع فيديو بينهما يعني عادةً كابل USB، أو تطبيق محادثة يضغط صورك، أو رحلة ذهاب وإياب عبر أحد أقراص السحابة. والثلاثة جميعًا أبطأ وأكثر إزعاجًا مما ينبغي.",
    "يتخطى Relayium كل ذلك. يفتح الهاتفان الصفحة نفسها: داخل شبكة LAN نفسها تنتقل الملفات المشفَّرة من الطرف إلى الطرف مباشرةً، وعبر الشبكات ينقل مُرحِّل TURN نصًا مشفّرًا لا يستطيع قراءته أو فك تشفيره ولا يحتفظ بنسخة أو سجل للمحتوى الآني. لا حاجة إلى تطبيق؛ يسجّل منشئ الاقتران عبر الشبكات الدخول، ولا يحتاج المنضم إلى حساب. يرشدك هذا الدليل خطوة بخطوة.",
  ],
  sections: [
    {
      heading: "ما تحتاج إليه قبل أن تبدأ",
      body: [
        "لا شيء يُثبَّت. وعلى نفس الشبكة لا شيء يتطلب التسجيل كذلك — يعمل النقل الفوري مباشرةً من المتصفح على الجهازين.",
      ],
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "هاتف Android مزوَّد بـ Chrome (أو أي متصفح حديث) وهاتف iPhone مزوَّد بـ Safari — كلاهما محدَّث.",
          "للحصول على أسرع مسار، ضع الجهازين على نفس شبكة Wi-Fi. وعلى iPhone يعني ذلك عادةً أيضًا تعطيل ميزة الترحيل الخاص في iCloud لهذه الشبكة وحدها: فهي تُخرِج الهاتف من عنوان IP عام آخر، واكتشاف نفس الشبكة يجمع الأجهزة بحسب ذلك العنوان بالتحديد. وإبقاؤها مفعَّلة خيار سليم تمامًا — فرمز اقتران على https://relayium.com/cross-network يصل حينها إلى الهاتف دون تغيير الإعداد.",
          "الصفحة مفتوحة عبر https://relayium.com/ على الهاتفين. يحتاج النقل المشفَّر إلى HTTPS، وعبر http:// المجرّد تقول الصفحة ذلك بدل أن تسرد الأجهزة.",
          "الملفات التي تريد إرسالها، حتى 1,000 ملف في كل دفعة، ومكان تحلّ فيه على الهاتف المستلم — واختيار المجلد يعود إلى متصفحه لا إلى Relayium.",
        ],
      },
    },
    {
      heading: "خطوة بخطوة: كلا الجهازين على نفس شبكة Wi-Fi",
      body: [
        "هذا أبسط المسارات. على نفس الشبكة، يكتشف الهاتفان أحدهما الآخر تلقائيًا، فلا يكاد يوجد ما يُكتَب.",
      ],
      steps: [
        {
          text: "على كل من هاتف Android وiPhone، افتح صفحة النقل في المتصفح.",
          code: ["https://relayium.com/"],
        },
        {
          text: "قارن عنوان IP العام في شريط الحالة على الهاتفين. تطابق العنوانين يضع الهاتفين في غرفة واحدة، أما اختلاف العنوان على iPhone فيعني في الغالب ميزة الترحيل الخاص في iCloud أو بيانات الجوال، لا خللًا في شبكة Wi-Fi.",
          code: ["متصل · هذا الجهاز iPhone · عنوان IP العام 203.0.113.9"],
        },
        {
          text: "يسرد كل هاتف الآن الآخر تحت «الأجهزة القريبة». على الهاتف المُرسِل، انقر على الهاتف المُستقبِل واضغط «فتح مساحة العمل». في المتصفحات الحديثة هذا هو الإجراء الوحيد الذي تعرضه البطاقة، لأن الملفات والرسائل تتشارك بعد ذلك الاتصال المشفَّر الواحد الذي تفتحه.",
        },
        {
          text: "تحلّ مساحة العمل مكان تلك البطاقة، وعناصر تحكّمها تحمل الاثنين: «إرسال ملفات» لدفعة تصل إلى 1,000 ملف، أو اكتب في صندوق الرسائل واضغط «إرسال». و«إرسال مجلد» متاح على هاتف Android لا على iPhone، لأن أي متصفح على iOS لا يسمح للصفحة باختيار مجلد. ثم على iPhone المُستقبِل، اقرأ السطر أسفل الطلب قبل القبول — فهو يقول إن كان Safari سيسأل عن مكان الحفظ أم سيكتب في تنزيلاته الخاصة — واضغط «قبول».",
        },
        {
          text: "أبقِ تبويبَي المتصفح في المقدمة حتى يبلغ عدّاد الملفات آخر ملف. وإن أردت مقارنة رمز التحقق (SAS) أولًا، فعّل «التحقّق المتقدّم» على الهاتفين قبل البدء: التطابق يؤكد انضمام الهاتفين إلى جلسة واحدة مشفَّرة من الطرف إلى الطرف، ولا يثبت مسار الشبكة الذي يحمله النص المشفّر. وإن تركته معطَّلًا فلن يكون هناك رمز للمقارنة، وتظل الجلسة مشفَّرة كما هي.",
        },
      ],
      success: {
        label: "كيف يبدو نقل ناجح",
        body: [
          "تكون بطاقة الهاتف الآخر قد اختفت عند هذه اللحظة — إذ حلّت مساحة العمل مكانها — فتُقرأ الحالة من ترويسة مساحة العمل: الجهاز المتصل بك، وحالة رابط تقول «متصل»، ووسم مسار واحد يقرأ «مباشر عبر LAN». ويتوقف عدّاد الملفات على الشاشتين عند آخر ملف في الدفعة.",
          "ثم تأكّد من الملف لا من الصفحة. على iPhone يكون ذلك في مجلد التنزيلات داخل تطبيق «الملفات»، وهو المكان الذي يضع فيه Safari أي تنزيل؛ وعلى هاتف Android يكون في قائمة التنزيلات الخاصة بالمتصفح نفسه — chrome://downloads في Chrome، وabout:downloads في Firefox.",
        ],
        code: ["متصل بـ iPhone · متصل · مباشر عبر LAN\nالملف 2/2"],
      },
    },
    {
      heading: "عندما لا يرى الهاتفان أحدهما الآخر",
      body: [
        "ثمّة سبب يستحق أن تعرفه على iPhone: ميزة الترحيل الخاص في iCloud مفعَّلة في كثير من حسابات iCloud+، وهي تغيّر عنوان IP العام الذي يظهر به الهاتف — وهو تحديدًا ما يجمع اكتشاف نفس الشبكة الأجهزة بحسبه. وهو سبب شائع من عدة أسباب لا السبب الوحيد، والفحوص أدناه هي الأولى المعتادة لا قائمة شاملة، وكل منها يحسم حالته بما هو معروض على الشاشة أصلًا.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "لا يظهر iPhone على هاتف Android أبدًا، أو العكس.",
            code: ["https://relayium.com/   # قارن عنوان IP العام في شريط الحالة على الهاتفين"],
            fix: "عنوانا IP عامان مختلفان يعنيان غرفتين. على iPhone تُعدّ ميزة الترحيل الخاص في iCloud سببًا شائعًا، وبقاء الهاتف على بيانات الجوال سببًا شائعًا آخر، وليس أي منهما الاحتمال الوحيد. فإن كنت مستعدًا لتغييرها، أوقف الترحيل الخاص لهذه الشبكة وحدها من «الإعدادات › Wi-Fi › الشبكة › حدّ من تتبّع عنوان IP»، أو انضم إلى شبكة Wi-Fi، ثم أعِد تحميل https://relayium.com/. وإن كنت تفضّل إبقاء الترحيل الخاص أو VPN مفعَّلًا، فرمز اقتران على https://relayium.com/cross-network يصل إلى الهاتف دون المساس بأي منهما.",
          },
          {
            symptom: "يعرض الهاتفان نفس عنوان IP العام ولا تظهر أي بطاقة.",
            code: ["https://relayium.com/   # التلميح أسفل قائمة الأجهزة يسمّي إعداد الموجّه"],
            fix: "الموجّه يفصل عملاءه عن بعضهم. أوقف «عزل نقطة الوصول / عزل العملاء» في إعدادات Wi-Fi لديه، أو اقرن الهاتفين عبر الشبكات برمز من https://relayium.com/cross-network إن لم يكن الموجّه بيدك لتغييره.",
          },
          {
            symptom: "قبل القبول، يحذّر iPhone من أنه سيحمل الدفعة كلها في الذاكرة.",
            code: ["https://relayium.com/   # يذكر التحذير حجم الدفعة التي سيحملها"],
            fix: "كل متصفحات iPhone مبنية على WebKit ولا تملك واجهة File System Access، فتُجمَّع الدفعة في الذاكرة ويحذّر Relayium بعد نحو 256 MiB. أرسِل ملفات أقل في المرة الواحدة، أو أرسِل هذا الملف إلى Chrome أو Edge على حاسوب يكتبه إلى القرص مباشرةً دون حدّ للحجم.",
          },
          {
            symptom: "انتهى العدّاد لكن الملف غير موجود على iPhone.",
            code: ["https://relayium.com/   # السطر أسفل الطلب كان قد ذكر مكان الحفظ في هذا المتصفح"],
            fix: "لا يضع Safari التنزيل في مكتبة الصور. ابحث في تطبيق «الملفات» تحت «التنزيلات» — والموضع الدقيق هو ما تشير إليه «الإعدادات › Safari › التنزيلات»، إما iCloud Drive أو الهاتف نفسه — وافتحه من هناك؛ ولا تصل الصورة إلى تطبيق «الصور» إلا إذا حفظتها بنفسك من الملف.",
          },
          {
            symptom: "يتوقف النقل أو يفشل عند الانتقال إلى تطبيق آخر أو عند قفل الشاشة.",
            code: ["https://relayium.com/   # يجب أن يكون تبويب Relayium هو الأمامي على الهاتفين"],
            fix: "قد يُكبَح التبويب في الخلفية أو يُعلَّق على أي من الهاتفين، وما دام كذلك فلا يتحرك أي بايت. ويطلب Relayium قفل إبقاء الشاشة مضاءة حيث يوفّره المتصفح، وهذا يغطّي انطفاء الشاشة لكنه لا يمنح تنفيذًا في الخلفية ولا يصمد أمام الانتقال بين التطبيقات — فأبقِ التبويبين في المقدمة حتى ينتهي العدّاد.",
          },
        ],
      },
    },
    {
      heading: "على شبكتين مختلفتين؟ استخدم رمز اقتران",
      body: [
        "لست مضطرًا إلى أن تكون على نفس شبكة Wi-Fi. إذا كان الهاتفان على شبكتين مختلفتين — أحدهما على بيانات الهاتف المحمول والآخر على شبكة Wi-Fi المنزلية — فلا يزال بإمكان Relayium ربطهما برمز اقتران. غير أن غرفة رمز الاقتران واجهة منفصلة عن مساحة عمل جهاز قريب: فهي تحتفظ بعناصر التحكم الأقدم المنفصلة لكل جهاز، ولا يوجد فيها «فتح مساحة العمل» لتضغطه.",
        "يعرض الجهاز المُرسِل رمز اقتران قصيرًا؛ أدخله على الهاتف الآخر (أو افتح رابط المشاركة الذي يولّده). والنقل الذي يُبنى بهذه الطريقة عبر شبكتين مختلفتين يجري عبر مُرحِّل TURN مُشفَّر لا عبر اتصال مباشر بين الهاتفين — وهذا اختيار مقصود: فـ Relayium يذهب إلى المُرحِّل مباشرةً، فلا يعتمد انعقاد الاتصال على إيجاد مسار مباشر عبر ما بين الشبكتين من شبكات NAT وجدران حماية، وهي قد تمنع مثل هذا المسار. ولا يُمرِّر المُرحِّل سوى نص مُشفَّر؛ فالملفات مختومة من الطرف إلى الطرف قبل أن تغادر هاتفك، ولا يستطيع قراءتها أبدًا. وإن انقطع الاتصال أثناء النقل، أمكنه الاستئناف بدلًا من البدء من جديد. ويتطلب الإرسال بهذه الطريقة أن يسجّل المُرسِل الدخول — أما الشخص المُستقبِل فلا يحتاج إلى حساب مطلقًا. والرمز صالح خمس دقائق، فجهِّز الجهازين معًا قبل توليده.",
      ],
    },
    {
      heading: "طرق أخرى لنقل الملفات بين Android وiPhone",
      body: [
        "Relayium ليس الخيار الوحيد، ومن الجدير معرفة الموازنات الصريحة للبدائل:",
      ],
      bullets: [
        "تنقل خدمة Quick Share من Google والتطبيقات الخارجية مثل SHAREit الملفات بسرعة، لكنها تحتاج إلى تثبيت على الهاتفين، كما أن Quick Share لا يصل إلى أجهزة iPhone.",
        "يعمل قرص سحابي (Google Drive، iCloud، Dropbox) حين يكون الطرف الآخر غير متصل، لكنك ترفع الملف نفسه ثم تنزّله مرتين، وهو يُحتسب من حصتك، ويحتفظ المزوّد بنسخة منه.",
        "تطبيقات المحادثة والبريد الإلكتروني في كل مكان، لكنها عادةً تعيد ضغط الصور، وتحدّ من أحجام المرفقات، وليست مُشفَّرة من الطرف إلى الطرف لمشاركة الملفات.",
        "كابل USB موثوق لكنه يحتاج إلى المحوّل المناسب بين USB-C وLightning، إضافةً إلى حاسوب في المنتصف لكثير من أنواع الملفات.",
      ],
    },
    {
      heading: "هل ستفقد صوري جودتها؟",
      body: [
        "لا. بخلاف تطبيق المراسلة، يرسل Relayium الملف الأصلي بايتًا ببايت — دون إعادة ضغط ودون تغيير الحجم. وما يصل إلى iPhone نسخة طبق الأصل مما غادر هاتف Android.",
        "وإثباتًا لذلك، يُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256، فالصورة أو الفيديو الذي يصل مضمون أنه مطابق لما أرسلته. وتُعالَج الملفات الكبيرة جيدًا أيضًا: المتصفح الذي يدعم واجهة File System Access (‏Chrome أو Edge على الحاسوب) يكتب الملف الوارد مباشرةً إلى القرص دون حد للحجم. أما Firefox وSafari ومتصفحات الهواتف — وكل ما على iPhone هو WebKit — فلا تملك تلك الواجهة، فتُجمَّع الدفعة في الذاكرة بدلًا من ذلك، ولذلك ينبّهك Relayium قبل القبول متى تجاوزت نحو 256 ميغابايت. وهذا الرقم تقدير متحفّظ عن قصد لا سقف مقيس: فنقطة الانهيار الفعلية تتوقف على ذاكرة الجهاز ونظامه وعدد علامات التبويب المفتوحة.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى تثبيت تطبيق على أي من الهاتفين؟",
        a: "لا. يعمل Relayium بالكامل في المتصفح على كل من Android وiPhone. افتح relayium.com على كل جهاز وستكون جاهزًا — دون أي تنزيل في الحالتين. على نفس الشبكة لا يحتاج النقل الفوري إلى حساب؛ والاقتران عبر الشبكات يتطلب فقط أن يسجّل المُرسِل الدخول. ويمكنك اختياريًا إضافته إلى شاشتك الرئيسية بوصفه تطبيق ويب تقدمي (PWA)، لكن ذلك مجرد اختصار.",
      },
      {
        q: "هل يجب أن يكون الهاتفان على نفس شبكة Wi-Fi؟",
        a: "لا. نفس الشبكة هي أسرع مسار لأن الأجهزة تكتشف بعضها تلقائيًا، لكن رمز الاقتران يربط هاتفين عبر شبكات مختلفة — حتى لو كان أحدهما على بيانات الهاتف المحمول والآخر على Wi-Fi. يبقى النقل مُشفَّرًا من الطرف إلى الطرف في الحالتين، وإن كان الاقتران عبر الشبكات يتطلب أن يسجّل المُرسِل الدخول — أما المُستقبِل فلا يحتاج إلى حساب مطلقًا.",
      },
      {
        q: "هل تُضغَط الصور أو تتغير بأي شكل؟",
        a: "لا. يُنقَل الملف الأصلي بايتًا ببايت دون ضغط، ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256، فما يصل إلى iPhone مطابق بتة ببتة لما أرسلته من Android.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على الهاتفين وأرسل أول ملفاتك — دون تثبيت، ودون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Cómo transferir archivos de Android a iPhone (sin cable)",
  description:
    "Una guía paso a paso para enviar fotos, vídeos y documentos de Android a iPhone en un navegador — sin AirDrop, sin cable, sin subir a la nube. Solo abre Relayium en ambos dispositivos.",
  updatedLabel: "Última actualización",
  lead: [
    "Android y iPhone no comparten un AirDrop, así que mover unas fotos o un vídeo entre ellos suele implicar un cable USB, una app de chat que comprime tus imágenes, o un viaje de ida y vuelta por algún disco en la nube. Los tres son más lentos y engorrosos de lo que deberían.",
    "Relayium se salta todo eso. Ambos teléfonos abren la misma página: en la misma LAN los archivos cifrados de extremo a extremo viajan directamente; entre redes, un relé TURN solo transporta texto cifrado que no puede leer ni descifrar y no conserva copia ni historial del contenido en tiempo real. No hay app que instalar; en el emparejamiento entre redes inicia sesión el creador y quien se une nunca necesita cuenta. Esta guía lo explica paso a paso.",
  ],
  sections: [
    {
      heading: "Lo que necesitas antes de empezar",
      body: [
        "Nada que instalar. En la misma red tampoco hay nada que registrar — las transferencias en tiempo real funcionan directamente desde el navegador en ambos dispositivos.",
      ],
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Un teléfono Android con Chrome (o cualquier navegador moderno) y un iPhone con Safari — ambos actualizados.",
          "Para la vía más rápida, ambos dispositivos en la misma red Wi-Fi. En el iPhone eso suele incluir desactivar iCloud Private Relay solo para esa red: saca el teléfono por otra IP pública, y el descubrimiento en la misma red agrupa los dispositivos precisamente por esa dirección. Dejarlo activado es una opción perfectamente válida — entonces un código de emparejamiento en https://relayium.com/cross-network llega al teléfono sin cambiar el ajuste.",
          "La página abierta mediante https://relayium.com/ en los dos teléfonos. La transferencia cifrada necesita HTTPS, y con http:// a secas la página lo dice en lugar de listar dispositivos.",
          "Los archivos que quieres enviar, hasta 1.000 por lote, y sitio para ellos en el teléfono que recibe — qué carpeta es eso lo decide su navegador y no Relayium.",
        ],
      },
    },
    {
      heading: "Paso a paso: ambos dispositivos en la misma Wi-Fi",
      body: [
        "Esta es la vía más sencilla. En la misma red, los dos teléfonos se descubren automáticamente, así que casi no hay nada que escribir.",
      ],
      steps: [
        {
          text: "Tanto en el teléfono Android como en el iPhone, abre la página de transferencia en el navegador.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compara la IP pública de la línea de estado en los dos teléfonos. Direcciones iguales meten a los dos en una sala; una distinta en el iPhone suele significar iCloud Private Relay o datos móviles, no una Wi-Fi averiada.",
          code: ["Conectado · este dispositivo iPhone · IP pública 203.0.113.9"],
        },
        {
          text: "Ahora cada teléfono lista al otro bajo «Dispositivos cercanos». En el que envía, toca el que recibe y pulsa «Abrir espacio de trabajo». En un navegador actual esa es la única acción de la tarjeta, porque a partir de ahí archivos y mensajes comparten la única conexión cifrada que abre.",
        },
        {
          text: "El espacio de trabajo sustituye a esa tarjeta, y sus controles llevan ambas cosas: «Enviar archivos» para un lote de hasta 1.000, o escribe en el cuadro de mensaje y pulsa «Enviar». «Enviar una carpeta» aparece en el teléfono Android pero no en el iPhone, porque ningún navegador de iOS permite que una página elija una carpeta. Luego, en el iPhone que recibe, lee la línea bajo la solicitud antes de aceptar — dice si Safari preguntará dónde guardar o escribirá en sus propias descargas — y toca «Aceptar».",
        },
        {
          text: "Deja las dos pestañas delante hasta que el contador llegue al último archivo. Para comparar antes un código de verificación (SAS), activa «Verificación avanzada» en los dos teléfonos antes de empezar: una coincidencia confirma que ambos teléfonos se unieron a la misma sesión cifrada de extremo a extremo, no la ruta de red que transporta el texto cifrado. Si la dejas desactivada no hay ningún código que comparar, y la sesión sigue igualmente cifrada.",
        },
      ],
      success: {
        label: "Qué se ve cuando la transferencia funciona",
        body: [
          "A esas alturas la tarjeta del otro teléfono ya no está — el espacio de trabajo ocupó su lugar —, así que el estado se lee en el encabezado del espacio de trabajo: el dispositivo al que estás conectado, un estado de enlace «Conectado» y una única etiqueta de ruta que marca «Directo por LAN». El contador de archivos termina en el último archivo del lote en las dos pantallas.",
          "Después confirma el archivo, no la página. En el iPhone eso es la carpeta Descargas de la app Archivos, donde Safari deja una descarga; en el teléfono Android, la lista de descargas del propio navegador — chrome://downloads en Chrome, about:downloads en Firefox.",
        ],
        code: ["Conectado a iPhone · Conectado · Directo por LAN\nArchivo 2/2"],
      },
    },
    {
      heading: "Cuando los dos teléfonos no se ven",
      body: [
        "Hay una causa que vale la pena conocer en el iPhone: iCloud Private Relay está activo en muchas cuentas de iCloud+ y cambia la IP pública con la que aparece el teléfono, que es exactamente por lo que el descubrimiento en la misma red agrupa los dispositivos. Es una causa común entre varias y no la única, y las comprobaciones de abajo son las primeras habituales más que una lista exhaustiva; cada una decide su caso con lo que ya está en pantalla.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El iPhone nunca aparece en el teléfono Android, o al revés.",
            code: ["https://relayium.com/   # compara la IP pública de la línea de estado en los dos teléfonos"],
            fix: "Dos direcciones IP públicas distintas son dos salas. En un iPhone iCloud Private Relay es una causa común, y que el teléfono se haya quedado en datos móviles es otra; ninguna de las dos es la única posibilidad. Si estás dispuesto a cambiarlas, desactiva Private Relay solo para esa Wi-Fi en Ajustes › Wi-Fi › la red › Limitar seguimiento de dirección IP, o conéctalo a la Wi-Fi, y recarga después https://relayium.com/. Si prefieres dejar Private Relay o una VPN activos, un código de emparejamiento en https://relayium.com/cross-network llega al teléfono sin tocar ninguno de los dos.",
          },
          {
            symptom: "Los dos teléfonos muestran la misma IP pública y no aparece ninguna tarjeta.",
            code: ["https://relayium.com/   # la indicación bajo la lista de dispositivos nombra el ajuste del router"],
            fix: "El router separa a sus propios clientes. Desactiva «aislamiento de AP / aislamiento de clientes» en sus ajustes de Wi-Fi, o empareja los dos teléfonos entre redes con un código en https://relayium.com/cross-network cuando el router no sea tuyo.",
          },
          {
            symptom: "Antes de aceptar, el iPhone avisa de que tiene que sostener todo el lote en memoria.",
            code: ["https://relayium.com/   # el aviso indica el tamaño del lote que tendría que sostener"],
            fix: "Todos los navegadores del iPhone son WebKit y no tienen la API File System Access, así que el lote se monta en memoria y Relayium avisa a partir de unos 256 MiB. Manda menos archivos de una vez, o manda ese archivo a un Chrome o Edge de ordenador, que lo escribe directamente en el disco sin tope de tamaño.",
          },
          {
            symptom: "El contador terminó pero no encuentras el archivo en el iPhone.",
            code: ["https://relayium.com/   # la línea bajo la solicitud ya decía dónde guarda este navegador"],
            fix: "Safari no deja una descarga en la fototeca. Mira en la app Archivos, en Descargas — la ubicación exacta es la que apunta Ajustes › Safari › Descargas, iCloud Drive o el propio iPhone — y ábrelo desde ahí; una foto solo llega a la app Fotos si la guardas tú mismo desde el archivo.",
          },
          {
            symptom: "La transferencia se para o falla al cambiar de aplicación o cuando se bloquea la pantalla.",
            code: ["https://relayium.com/   # en los dos teléfonos, la pestaña de Relayium tiene que ser la de delante"],
            fix: "Una pestaña en segundo plano puede frenarse o incluso suspenderse en cualquiera de los dos teléfonos, y mientras eso pasa no se mueve ningún byte. Relayium pide un bloqueo de pantalla donde el navegador lo ofrece, lo que cubre que la pantalla se apague pero no compra ejecución en segundo plano ni sobrevive a un cambio de aplicación: deja las dos pestañas delante hasta que el contador acabe.",
          },
        ],
      },
    },
    {
      heading: "¿En redes distintas? Usa un código de emparejamiento",
      body: [
        "No hace falta estar en la misma Wi-Fi. Si los teléfonos están en redes distintas — uno con datos móviles, el otro con la Wi-Fi de casa — Relayium aún puede conectarlos con un código de emparejamiento. Eso sí, una sala con código de emparejamiento es una superficie distinta de un espacio de trabajo con un dispositivo cercano: conserva los controles anteriores separados por dispositivo, así que allí no hay ningún «Abrir espacio de trabajo» que pulsar.",
        "El dispositivo que envía muestra un código de emparejamiento corto; introdúcelo en el otro teléfono (o abre el enlace para compartir que genera). Una transferencia montada así entre dos redes va por un retransmisor TURN cifrado, no por un enlace directo entre los dos teléfonos — y es a propósito: Relayium va directo al retransmisor, de modo que la conexión no depende de encontrar una ruta directa a través de los NAT y cortafuegos que hay entre las dos redes, que pueden impedirla. El retransmisor solo reenvía texto cifrado; los archivos salen sellados de extremo a extremo antes de dejar tu teléfono, así que nunca puede leerlos. Si la conexión se cae a mitad de la transferencia, puede reanudarse en lugar de empezar de nuevo. Enviar así necesita que el remitente inicie sesión — la persona que recibe nunca necesita una cuenta. El código vale cinco minutos, así que ten los dos dispositivos a mano antes de generarlo.",
      ],
    },
    {
      heading: "Otras formas de mover archivos entre Android y iPhone",
      body: [
        "Relayium no es la única opción, y vale la pena conocer las concesiones reales de las alternativas:",
      ],
      bullets: [
        "Quick Share de Google y apps de terceros como SHAREit mueven archivos rápido, pero necesitan instalación en ambos teléfonos y Quick Share no llega a los iPhone.",
        "Un disco en la nube (Google Drive, iCloud, Dropbox) funciona cuando la otra persona está desconectada, pero subes y luego descargas el mismo archivo dos veces, se descuenta de tu cuota y el proveedor guarda una copia.",
        "Las apps de chat y el correo están en todas partes, pero suelen recomprimir las fotos, limitar el tamaño de los adjuntos y no están cifradas de extremo a extremo para compartir archivos.",
        "Un cable USB es fiable pero necesita el adaptador adecuado entre USB-C y Lightning, además de un ordenador en medio para muchos tipos de archivo.",
      ],
    },
    {
      heading: "¿Mis fotos perderán calidad?",
      body: [
        "No. A diferencia de una app de mensajería, Relayium envía el archivo original byte a byte — sin recompresión, sin redimensionar. Lo que llega al iPhone es una copia exacta de lo que salió del teléfono Android.",
        "Para demostrarlo, cada archivo se verifica de extremo a extremo con un hash SHA-256, así que una foto o un vídeo que llega tiene garantizado ser idéntico al que enviaste. Los archivos grandes también se gestionan bien: un navegador con la API File System Access (Chrome o Edge de escritorio) escribe el archivo entrante directamente al disco, sin límite de tamaño. Firefox, Safari y los navegadores de móvil — en el iPhone todo es WebKit — no tienen esa API, así que ahí la recepción se acumula en memoria y Relayium te avisa antes de que aceptes en cuanto se pasa de unos 256 MB. Esa cifra es una estimación deliberadamente prudente, no un techo medido: dónde falla de verdad depende de la memoria del dispositivo, de su sistema y de cuántas pestañas tengas abiertas.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito instalar una app en alguno de los teléfonos?",
        a: "No. Relayium se ejecuta por completo en el navegador tanto en Android como en iPhone. Abre relayium.com en cada dispositivo y ya está — sin descarga de ningún tipo. En la misma red una transferencia en tiempo real no necesita cuenta; emparejar entre redes solo le pide al remitente que inicie sesión. Puedes, opcionalmente, añadirlo a tu pantalla de inicio como PWA, pero eso es solo un acceso directo.",
      },
      {
        q: "¿Los dos teléfonos tienen que estar en la misma Wi-Fi?",
        a: "No. La misma red es la vía más rápida porque los dispositivos se descubren automáticamente, pero un código de emparejamiento conecta dos teléfonos entre redes distintas — incluso uno con datos móviles y otro con Wi-Fi. La transferencia sigue cifrada de extremo a extremo en ambos casos, aunque emparejar entre redes requiere que el remitente inicie sesión — el destinatario nunca necesita una cuenta.",
      },
      {
        q: "¿Se comprimen o alteran las fotos de alguna forma?",
        a: "No. El archivo original se transfiere byte a byte sin compresión, y cada archivo se comprueba de extremo a extremo con un hash SHA-256, así que lo que llega al iPhone es idéntico bit a bit a lo que enviaste desde Android.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en ambos teléfonos y envía tus primeros archivos — sin instalación, y sin cuenta necesaria en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Como transferir arquivos do Android para o iPhone (sem cabo)",
  description:
    "Um guia passo a passo para enviar fotos, vídeos e documentos do Android para o iPhone no navegador — sem AirDrop, sem cabo, sem upload para a nuvem. Basta abrir o Relayium nos dois dispositivos.",
  updatedLabel: "Última atualização",
  lead: [
    "Android e iPhone não compartilham um AirDrop, então mover algumas fotos ou um vídeo entre eles geralmente significa um cabo USB, um app de conversa que comprime suas imagens, ou uma ida e volta por algum drive na nuvem. Os três são mais lentos e mais trabalhosos do que deveriam ser.",
    "O Relayium pula tudo isso. Os dois celulares abrem a mesma página: na mesma LAN os arquivos criptografados de ponta a ponta viajam diretamente; entre redes, um retransmissor TURN só transporta texto cifrado que não consegue ler nem descriptografar e não mantém cópia nem histórico do conteúdo em tempo real. Não há app para instalar; no emparelhamento entre redes o criador faz login e quem entra nunca precisa de conta. Este guia mostra passo a passo.",
  ],
  sections: [
    {
      heading: "O que você precisa antes de começar",
      body: [
        "Nada para instalar. Na mesma rede também não há nada para cadastrar — as transferências em tempo real funcionam direto do navegador nos dois dispositivos.",
      ],
      prereqs: {
        label: "O que você precisa",
        items: [
          "Um celular Android com Chrome (ou qualquer navegador moderno) e um iPhone com Safari — ambos atualizados.",
          "Para o caminho mais rápido, os dois dispositivos na mesma rede Wi-Fi. No iPhone isso normalmente inclui desligar o iCloud Private Relay só para aquela rede: ele faz o celular sair por outro IP público, e a descoberta na mesma rede agrupa os dispositivos exatamente por esse endereço. Deixá-lo ligado é uma escolha perfeitamente válida — nesse caso um código de emparelhamento em https://relayium.com/cross-network alcança o celular sem mudar a configuração.",
          "A página aberta por https://relayium.com/ nos dois celulares. A transferência criptografada exige HTTPS, e em http:// puro a página diz isso em vez de listar dispositivos.",
          "Os arquivos que você quer enviar, até 1.000 por lote, e lugar para eles no celular que recebe — qual pasta é essa cabe ao navegador dele, não ao Relayium.",
        ],
      },
    },
    {
      heading: "Passo a passo: os dois dispositivos na mesma rede Wi-Fi",
      body: [
        "Este é o caminho mais simples. Na mesma rede, os dois celulares se descobrem automaticamente, então quase não há nada para digitar.",
      ],
      steps: [
        {
          text: "Tanto no celular Android quanto no iPhone, abra a página de transferência no navegador.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compare o IP público da linha de status nos dois celulares. Endereços iguais colocam os dois em uma sala; um endereço diferente no iPhone costuma significar iCloud Private Relay ou dados móveis, e não uma Wi-Fi com problema.",
          code: ["Conectado · este dispositivo iPhone · IP público 203.0.113.9"],
        },
        {
          text: "Agora cada celular lista o outro em “Dispositivos próximos”. No que envia, toque no que recebe e pressione “Abrir área de trabalho”. Em um navegador atual essa é a única ação do cartão, porque a partir daí arquivos e mensagens compartilham a única conexão criptografada que ela abre.",
        },
        {
          text: "A área de trabalho toma o lugar daquele cartão, e os controles dela levam os dois: “Enviar arquivos” para um lote de até 1.000, ou digite na caixa de mensagem e pressione “Enviar”. “Enviar uma pasta” aparece no celular Android mas não no iPhone, porque nenhum navegador de iOS deixa uma página escolher uma pasta. Depois, no iPhone que recebe, leia a linha abaixo do pedido antes de aceitar — ela diz se o Safari vai perguntar onde salvar ou gravar nos downloads dele — e toque em “Aceitar”.",
        },
        {
          text: "Deixe as duas abas à frente até o contador chegar ao último arquivo. Para comparar antes um código de verificação (SAS), ligue a “Verificação avançada” nos dois celulares antes de começar: a coincidência confirma que os dois celulares entraram na mesma sessão criptografada de ponta a ponta, não a rota de rede que transporta o texto cifrado. Se deixar desligada, não há código para comparar e a sessão continua criptografada do mesmo jeito.",
        },
      ],
      success: {
        label: "Como é uma transferência que funciona",
        body: [
          "A essa altura o cartão do outro celular já não existe — a área de trabalho ocupou o lugar dele —, então o estado é lido no cabeçalho da área de trabalho: o dispositivo a que você está conectado, um estado de vínculo “Conectado” e um único selo de caminho indicando “LAN direto”. O contador de arquivos termina no último arquivo do lote nas duas telas.",
          "Depois confirme o arquivo, não a página. No iPhone isso é a pasta Downloads no app Arquivos, onde o Safari deixa um download; no celular Android, a lista de downloads do próprio navegador — chrome://downloads no Chrome, about:downloads no Firefox.",
        ],
        code: ["Conectado a iPhone · Conectado · LAN direto\nArquivo 2/2"],
      },
    },
    {
      heading: "Quando os dois celulares não se enxergam",
      body: [
        "Há uma causa que vale conhecer no iPhone: o iCloud Private Relay está ligado em muitas contas iCloud+ e muda o IP público com que o celular aparece — que é exatamente o critério pelo qual a descoberta na mesma rede agrupa os dispositivos. É uma causa comum entre várias, não a única, e as verificações abaixo são as primeiras usuais e não uma lista exaustiva; cada uma decide o seu caso com o que já está na tela.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O iPhone nunca aparece no celular Android, ou o contrário.",
            code: ["https://relayium.com/   # compare o IP público da linha de status nos dois celulares"],
            fix: "Dois endereços IP públicos diferentes são duas salas. No iPhone o iCloud Private Relay é uma causa comum, e o celular ter ficado nos dados móveis é outra; nenhuma das duas é a única possibilidade. Se você estiver disposto a mudá-las, desligue o Private Relay só para aquela Wi-Fi em Ajustes › Wi-Fi › a rede › Limitar rastreamento de endereço IP, ou entre na Wi-Fi, e recarregue depois https://relayium.com/. Se preferir deixar o Private Relay ou uma VPN ligados, um código de emparelhamento em https://relayium.com/cross-network alcança o celular sem mexer em nenhum dos dois.",
          },
          {
            symptom: "Os dois celulares mostram o mesmo IP público e nenhum cartão aparece.",
            code: ["https://relayium.com/   # a dica abaixo da lista de dispositivos nomeia a configuração do roteador"],
            fix: "O roteador está separando os próprios clientes. Desative “isolamento de AP / isolamento de clientes” nas configurações de Wi-Fi dele, ou emparelhe os dois celulares entre redes com um código em https://relayium.com/cross-network quando o roteador não for seu para mexer.",
          },
          {
            symptom: "Antes de aceitar, o iPhone avisa que precisa segurar o lote inteiro na memória.",
            code: ["https://relayium.com/   # o aviso informa o tamanho do lote que ele teria de segurar"],
            fix: "Todos os navegadores do iPhone são WebKit e não têm a API File System Access, então o lote é montado na memória e o Relayium avisa acima de mais ou menos 256 MiB. Mande menos arquivos por vez, ou mande esse arquivo para um Chrome ou Edge de computador, que grava direto no disco sem teto de tamanho.",
          },
          {
            symptom: "O contador terminou mas você não encontra o arquivo no iPhone.",
            code: ["https://relayium.com/   # a linha abaixo do pedido já dizia onde este navegador salva"],
            fix: "O Safari não coloca um download na biblioteca de fotos. Procure no app Arquivos, em Downloads — o local exato é o que Ajustes › Safari › Downloads aponta, iCloud Drive ou o próprio iPhone — e abra de lá; uma foto só chega ao app Fotos se você mesmo a salvar a partir do arquivo.",
          },
          {
            symptom: "A transferência para ou falha ao trocar de aplicativo ou quando a tela bloqueia.",
            code: ["https://relayium.com/   # nos dois celulares, a aba do Relayium precisa ser a da frente"],
            fix: "Uma aba em segundo plano pode ser limitada ou até suspensa em qualquer dos dois celulares, e enquanto isso acontece nenhum byte se move. O Relayium pede um bloqueio de tela onde o navegador oferece, o que cobre a tela apagar mas não compra execução em segundo plano nem sobrevive a uma troca de aplicativo: deixe as duas abas à frente até o contador terminar.",
          },
        ],
      },
    },
    {
      heading: "Em redes diferentes? Use um código de emparelhamento",
      body: [
        "Você não precisa estar na mesma rede Wi-Fi. Se os celulares estão em redes diferentes — um em dados móveis, o outro na rede Wi-Fi de casa — o Relayium ainda consegue conectá-los com um código de emparelhamento. Só que uma sala com código de emparelhamento é uma superfície separada de uma área de trabalho com um dispositivo próximo: ela mantém os controles anteriores separados por dispositivo, então não há nenhum “Abrir área de trabalho” para pressionar ali.",
        "O dispositivo que envia mostra um código de emparelhamento curto; digite-o no outro celular (ou abra o link de compartilhamento que ele gera). Uma transferência montada assim entre duas redes passa por um retransmissor TURN criptografado, e não por uma ligação direta entre os dois celulares — de propósito: o Relayium vai direto ao retransmissor, então a conexão não depende de encontrar uma rota direta através dos NATs e firewalls que existem entre as duas redes, que podem impedi-la. O retransmissor só encaminha texto cifrado; os arquivos saem selados de ponta a ponta antes de deixar o seu celular, então ele nunca consegue lê-los. Se a conexão cair no meio da transferência, ela pode ser retomada em vez de recomeçar. Enviar assim exige que o remetente entre — a pessoa que recebe nunca precisa de conta. O código vale cinco minutos, então deixe os dois aparelhos à mão antes de gerar um.",
      ],
    },
    {
      heading: "Outras formas de mover arquivos entre Android e iPhone",
      body: [
        "O Relayium não é a única opção, e vale conhecer os trade-offs honestos das alternativas:",
      ],
      bullets: [
        "O Quick Share do Google e apps de terceiros como o SHAREit movem arquivos rápido, mas precisam de instalação nos dois celulares e o Quick Share não alcança iPhones.",
        "Um drive na nuvem (Google Drive, iCloud, Dropbox) funciona quando a outra pessoa está offline, mas você envia e depois baixa o mesmo arquivo duas vezes, ele conta na sua cota e o provedor guarda uma cópia.",
        "Apps de conversa e e-mail estão em toda parte, mas costumam recomprimir fotos, limitar o tamanho dos anexos e não são criptografados de ponta a ponta para compartilhamento de arquivos.",
        "Um cabo USB é confiável, mas precisa do adaptador certo entre USB-C e Lightning, além de um computador no meio para muitos tipos de arquivo.",
      ],
    },
    {
      heading: "Minhas fotos vão perder qualidade?",
      body: [
        "Não. Diferentemente de um app de mensagens, o Relayium envia o arquivo original byte a byte — sem recompressão, sem redimensionamento. O que chega ao iPhone é uma cópia exata do que saiu do celular Android.",
        "Para comprovar, cada arquivo é verificado de ponta a ponta com um hash SHA-256, então uma foto ou vídeo que chega é garantidamente idêntico ao que você enviou. Arquivos grandes também são bem tratados: um navegador com a API File System Access (Chrome ou Edge no computador) grava o arquivo recebido direto no disco, sem limite de tamanho. Firefox, Safari e navegadores de celular — no iPhone é tudo WebKit — não têm essa API, então neles o lote é montado na memória, e o Relayium avisa antes de você aceitar assim que passa de cerca de 256 MB. Esse número é uma estimativa propositalmente conservadora, não um teto medido: o ponto real de falha depende da memória do aparelho, do sistema e de quantas abas estão abertas.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso instalar um app em algum dos celulares?",
        a: "Não. O Relayium roda inteiramente no navegador tanto no Android quanto no iPhone. Abra relayium.com em cada dispositivo e você está pronto — sem download de qualquer forma. Na mesma rede uma transferência em tempo real não precisa de conta; emparelhar entre redes apenas pede que o remetente entre. Você pode, opcionalmente, adicioná-lo à tela inicial como um PWA, mas isso é só um atalho.",
      },
      {
        q: "Os dois celulares precisam estar na mesma rede Wi-Fi?",
        a: "Não. A mesma rede é o caminho mais rápido porque os dispositivos se descobrem automaticamente, mas um código de emparelhamento conecta dois celulares entre redes diferentes — mesmo um em dados móveis e outro em Wi-Fi. A transferência permanece criptografada de ponta a ponta nos dois casos, embora emparelhar entre redes exija que o remetente entre — o destinatário nunca precisa de conta.",
      },
      {
        q: "As fotos são comprimidas ou alteradas de alguma forma?",
        a: "Não. O arquivo original é transferido byte a byte sem compressão, e cada arquivo é verificado de ponta a ponta com um hash SHA-256, então o que chega ao iPhone é idêntico bit a bit ao que você enviou do Android.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium nos dois celulares e envie seus primeiros arquivos — sem instalação, e sem conta necessária na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/transfer-files-android-to-iphone",
  published: "2026-07-03",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
