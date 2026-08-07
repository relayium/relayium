// web/scripts/pages/content/articles/howto-same-wifi.mjs
// How-to: send files between any devices on the same Wi-Fi / local network —
// the generic LAN-mode explainer (distinct from the PC-to-phone, Mac-Windows,
// and AirDrop-for-Windows/Android device-pair how-tos, which it cross-links to).
// English is the master; zh/ja/ko/de/fr follow the same structure with identical
// facts. Terminology mirrors src/lib/i18n and other articles in this folder.

import { browserCrossNetworkSection } from "../realtime-facts.mjs";

const en = {
  title: "Send files between devices on the same Wi-Fi",
  description:
    "How to send files between any devices on the same Wi-Fi or local network — no account, no pairing code, just open relayium.com on both and transfer directly, end-to-end encrypted.",
  updatedLabel: "Last updated",
  lead: [
    "If two or more devices are on the same Wi-Fi or local network, sending a file between them should not require an account, a code, or a trip through the cloud. Relayium detects when devices share a network and lets them connect directly, in the browser, with nothing to sign up for.",
    "This guide covers the generic same-network case — any devices, any operating systems, even more than two at once. If you have a specific device pair in mind, see the dedicated guides for PC to phone, Mac to Windows, or an AirDrop-style flow for Windows/Linux/Android linked at the end.",
  ],
  sections: [
    {
      heading: "How same-network detection works",
      body: [
        "Relayium does not ask you to type anything to find nearby devices. When your browser opens relayium.com without a pairing code, the server places you in a room based on the network you are connecting from — in practice, devices that share the same public IP address (the same home, office, or campus Wi-Fi, or the same mobile hotspot) land in the same room automatically.",
        "That room is not capped at two participants: it holds however many devices open the site from that network, so a whole desk of laptops or a classroom of phones can all see each other at once, not just a single pair.",
      ],
    },
    {
      heading: "Step by step",
      prereqs: {
        label: "Before you start",
        items: [
          "Every device on the same Wi-Fi or local network, with the router not keeping its clients apart. Relayium's own hint under the device list names the setting to look for: “AP isolation / client isolation”.",
          "A current browser on each device (Chrome, Edge, Firefox or Safari) with the page open over https://relayium.com/. Encrypted transfer needs HTTPS, and over plain http:// the page says exactly that instead of listing devices.",
          "No account and no pairing code. Same-network discovery asks for neither, on either side, so there is nothing to set up before the first transfer.",
          "Somewhere for the files to land on the receiving device. Which place that is belongs to the receiving browser and its operating system, not to us: Chrome and Edge on a computer can ask you where to save, and other browsers write to their own Downloads folder. You confirm where they landed in that browser's own downloads list — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
      },
      body: [
        "The whole flow happens in the browser — no app to install on any device.",
      ],
      steps: [
        {
          text: "Connect every device you want to use to the same Wi-Fi or local network, then open the transfer page on each of them.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Read the status pill under the heading on both devices and compare the public IP in it. One shared address is what puts two devices in the same room; two different addresses mean two different networks, whatever the Wi-Fi name says.",
          code: ["Connected · this device MacBook · public IP 203.0.113.9"],
        },
        {
          text: "Look under “Nearby devices”. Every device that opened the page from that network is listed there as a card carrying its own name — nothing to type, nothing to confirm.",
        },
        {
          text: "On the sending device, click the recipient's card and press “Open workspace”. On a current browser that is the single action a nearby-device card offers, because files, folders and messages all travel over the one encrypted connection it opens. The room may list several devices; opening a workspace is how you pick the one this transfer goes to, and you open another one when the next person's turn comes.",
        },
        {
          text: "The workspace replaces that card. Read the connection off its header from now on — who you are connected to, the link state, and the one path badge — and use the controls under it to send: “Send files” for a batch, “Send a folder” for a whole tree where the browser offers folder picking, or type into the message box and press “Send”. One file batch carries up to 1,000 files.",
        },
        {
          text: "On the receiving device the request arrives with the file count and the total size, and the line under it says what pressing “Accept” will do — either the browser asks where to save, or the files go to its Downloads folder. Press “Accept” to start.",
        },
        {
          text: "Watch the file counter reach the last file on both screens. If you want to compare a verification code (SAS) before anything moves, turn on “Advanced verification” on both devices first: it is off by default, and switching it on adds a comparison and an approval step rather than encryption — the transfer is encrypted either way.",
        },
      ],
      success: {
        label: "What a working transfer looks like",
        body: [
          "The peer card is gone by then — the workspace took its place. The state is in the workspace header instead: the device you are connected to, a link state of “Connected”, and one path badge reading “LAN direct”, a host-to-host hop across your own network. “P2P direct” is the honest second case: the two devices really did share a public IP, but the hop their browsers settled on was not a local one.",
          "On the receiving side the counter ends on the last file, and the file itself is wherever the save line said it would be. The receiving browser's own downloads list is where you confirm that, not this page — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
        code: ["Connected to MacBook · Connected · LAN direct\nFile 3/3"],
      },
      bullets: [
        "A same-network room is not capped at two devices, so a card for every phone and laptop in the room is normal rather than a sign that something went wrong.",
        "Nothing here is uploaded first and downloaded afterwards, so there is no copy on a server to pick up later: both devices stay on the page until the counter finishes.",
      ],
    },
    {
      heading: "When the devices don't see each other",
      body: [
        "Same-network discovery keys off the network your browser is connecting from, so that is where to look first: the two devices are not really on one network, the router is keeping its clients apart, the page was not opened over HTTPS, or the receiving browser is being asked to hold more than it can. Those are common first checks rather than the whole list, and each of them has something on screen that decides it.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "“Nearby devices” stays empty, or lists only the device you are looking at.",
            code: ["https://relayium.com/   # open it on both, then compare the public IP in the status pill"],
            fix: "Two different public IP addresses mean two separate rooms. A VPN, iCloud Private Relay, or a guest SSID that sends clients out through another address are common reasons for that, and not the only ones. If you are willing to change them: switch the VPN off, or turn Private Relay off for that one Wi-Fi network, or move both devices onto the main network, then reload https://relayium.com/ on each. If you would rather leave them on, a pairing code on https://relayium.com/cross-network reaches the other device without touching either setting, and is end-to-end encrypted the same way.",
          },
          {
            symptom: "Both devices show the same public IP and still neither card appears.",
            code: ["https://relayium.com/   # the hint under the device list names the router setting"],
            fix: "The router is separating its own clients. Turn off “AP isolation / client isolation” in its Wi-Fi settings — mesh systems, hotel and guest networks often ship with it on — and reload the page on both devices. When you do not control the router, a pairing code on https://relayium.com/cross-network is the way through instead.",
          },
          {
            symptom: "The page says encrypted transfer requires HTTPS, and no device list appears at all.",
            code: ["https://relayium.com/   # the address bar has to read https, not http"],
            fix: "The page was opened over http:// or by raw IP address, so the browser withholds the APIs an encrypted transfer needs. relayium.com itself redirects to HTTPS, so this normally means a self-hosted instance reached over http:// — open it as https://relayium.com/, or give your own instance a certificate.",
          },
          {
            symptom: "The receiving device warns, before you accept, that it has to hold the whole batch in memory.",
            code: ["chrome://downloads   # in Chrome; Edge has edge://downloads and Firefox about:downloads"],
            fix: "That browser cannot stream a download straight to disk, so it buffers the batch and a large one may end in a crashed tab. Receive it in Chrome or Edge on a computer, or send fewer files at a time, and check each arrival in the receiving browser's own downloads list — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox — rather than assuming it saved.",
          },
          {
            symptom: "The transfer runs, but the badge reads “P2P direct” instead of “LAN direct”.",
            code: ["https://relayium.com/   # read the path badge in the workspace header"],
            fix: "The two devices share a public IP without sharing a local hop — carrier-grade NAT, two VLANs behind one uplink, or an extender in client mode all do this. The transfer is still direct and still end-to-end encrypted; put both devices on the same access point if you want the path to be your LAN rather than whatever route the browsers found.",
          },
        ],
      },
    },
    {
      heading: "Why it is fast: no server in the middle",
      body: [
        "Both devices connect from the same network, so Relayium links them peer-to-peer: the bytes go from one device to the other without a round trip to a Relayium server, and there is nothing to upload first and nothing to wait on downloading afterwards. How fast that is depends on the hop the two browsers actually settled on, and the path badge names it. “LAN direct” is the local one — the data stays inside your own network and runs at your network's speed rather than your internet connection's. “P2P direct” is still direct and still has no server in the middle, but the route the browsers found left the local segment, so it is bounded by whatever link it really crosses. A shared public IP is what puts two devices in the same room; on its own it is not a promise that the hop between them is local.",
        "This is also why no account is involved on either side: with everyone already on the same trusted network, Relayium does not need sign-in to know who should be allowed to connect to whom.",
      ],
    },
    {
      heading: "Still end-to-end encrypted",
      body: [
        "Being on the same network does not mean the transfer is sent in the clear. Relayium negotiates an X25519 key exchange between the two devices and encrypts every chunk with AES-256-GCM; that key is never seen by any server, including Relayium's own signaling server, which only helps the devices find each other. With advanced verification on, both screens also display a short verification code (SAS) that lets you visually confirm the connection is genuinely between your two devices, and each file is checked end to end with a SHA-256 hash so you know it arrived byte-for-byte intact.",
      ],
    },
    browserCrossNetworkSection.en,
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account to send files on the same Wi-Fi?",
        a: "No. Same-network transfers need no account and no pairing code on either side — just open relayium.com on each device.",
      },
      {
        q: "How does Relayium know which devices are on my network?",
        a: "Devices that connect from the same network typically share the same public IP address, and Relayium groups devices with a matching public IP into the same room automatically, with no code required.",
      },
      {
        q: "Can more than two devices see each other at once?",
        a: "Yes — the room lists every device that opens relayium.com from that network, so a phone, a laptop and a desktop all appear side by side. A transfer itself is one-to-one: you open a workspace with one of the listed devices, and that is who the files go to. Sharing with several people in the same room means opening a workspace with each of them in turn.",
      },
      {
        q: "Is the transfer still encrypted if it never leaves my network?",
        a: "Yes. Every same-network transfer uses the same X25519 key exchange and AES-256-GCM encryption as a cross-network one, with a verification code you can check yourself and a SHA-256 integrity check per file.",
      },
      {
        q: "What if one device is on Wi-Fi and the other is on mobile data?",
        a: "They are not on the same network, so automatic discovery will not connect them. Use a pairing code instead — the sender signs in to create it, and the receiver does not need an account. Across networks the transfer runs over an encrypted TURN relay rather than a direct connection, and it stays end-to-end encrypted throughout: the relay only forwards ciphertext and cannot read the file.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on any two (or more) devices on the same Wi-Fi and send your first file — no account, no code needed.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "同一 Wi-Fi 下的设备之间互传文件",
  description:
    "如何在同一 Wi-Fi 或局域网下的任意设备之间传文件——无需账号，无需配对码，两端都打开 relayium.com 即可直传，全程端到端加密。",
  updatedLabel: "最近更新",
  lead: [
    "如果两台或多台设备在同一个 Wi-Fi 或局域网里，它们之间传文件本不该需要账号、配对码，或绕道云端。Relayium 能识别设备是否处于同一网络，并让它们在浏览器里直接互连，什么都不用注册。",
    "本文讲的是通用的同网络场景——任意设备、任意操作系统，甚至可以同时超过两台。如果你心里想的是某个具体设备组合，可以看文末链接的专门指南：电脑传手机、Mac 传 Windows，或面向 Windows/Linux/Android 的 AirDrop 式方案。",
  ],
  sections: [
    {
      heading: "同网络是怎么被识别的",
      body: [
        "Relayium 不需要你输入任何东西来发现附近的设备。当你的浏览器不带配对码打开 relayium.com 时，服务器会根据你所连接的网络把你放进一个房间——实际上，共享同一个公网 IP 的设备（比如同一个家庭、办公室、校园 Wi-Fi，或同一个手机热点）会自动落入同一个房间。",
        "这个房间不限于两个人：从该网络打开网站的设备有多少，房间里就能容纳多少台，所以一整桌笔记本电脑，或一个教室的手机，都能同时互相看见，不只是一对一。",
      ],
    },
    {
      heading: "分步操作",
      prereqs: {
        label: "开始之前",
        items: [
          "每台设备都在同一个 Wi-Fi 或局域网里，并且路由器没有把客户端互相隔开。设备列表下方 Relayium 自己的提示就写着要找的那个开关：「AP 隔离 / 客户端隔离」。",
          "每台设备上都有一个较新的浏览器（Chrome、Edge、Firefox 或 Safari），并且是通过 https://relayium.com/ 打开页面。加密传输需要 HTTPS，用普通 http:// 打开时页面会直接这么告诉你，而不会列出设备。",
          "不需要账号，也不需要配对码。同网络发现两端都不问这两样，所以第一次传输之前没有任何要配置的东西。",
          "接收端要有地方存文件。存到哪里由接收端的浏览器和操作系统决定，不由我们决定：电脑上的 Chrome 和 Edge 可以让你选保存位置，其他浏览器会写进自己的下载目录。落到哪里，要在那个浏览器自己的下载列表里确认——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
        ],
      },
      body: [
        "整个流程都在浏览器里完成——任何设备都不用装 App。",
      ],
      steps: [
        {
          text: "把你要用到的每台设备都连接到同一个 Wi-Fi 或局域网，然后在每台设备上打开传输页面。",
          code: ["https://relayium.com/"],
        },
        {
          text: "在两台设备上读一下标题下方的状态条，对比里面的公网 IP。地址相同才会把两台设备放进同一个房间；地址不同就说明是两个网络，Wi-Fi 名字叫什么都不算。",
          code: ["已连接 · 本机 MacBook · 公网 IP 203.0.113.9"],
        },
        {
          text: "看「附近的设备」这一栏。凡是从该网络打开页面的设备，都会以卡片形式列在那里，卡片上是它自己的名字——不用输入，也不用确认。",
        },
        {
          text: "在发送端点开对方的卡片，按「打开工作区」。在较新的浏览器上，这是附近设备卡片提供的唯一动作：文件、文件夹和消息都走它打开的那一条加密连接。房间里可能列着好几台设备，打开工作区就是在其中挑定这次要发给谁；轮到下一个人时，再打开一个工作区。",
        },
        {
          text: "工作区会取代那张卡片。从这一刻起，连接状态要看工作区顶部的标题栏——连的是哪台设备、链路处于什么状态、以及唯一的那个路径标签——发送则用它下面的控件：一批文件用「发送文件」，整个目录树用「发送文件夹」（需要浏览器支持选择文件夹），或者在消息框里输入后按「发送」。一批文件最多 1,000 个。",
        },
        {
          text: "接收端会收到请求，上面写着文件数量和总大小，下面那行说明按「接收」之后会发生什么——要么浏览器问你存到哪，要么文件进入它的下载目录。按「接收」就开始。",
        },
        {
          text: "看着两块屏幕上的文件计数走到最后一个文件。如果希望在任何字节移动之前先核对校验码（SAS），请先在两台设备上打开「高级验证」：它默认关闭，打开后多出来的是一次核对和一步确认，而不是加密——无论开不开，传输都是加密的。",
        },
      ],
      success: {
        label: "传输成功时是什么样",
        body: [
          "这时对方的卡片已经不在了——工作区取代了它。状态改看工作区的标题栏：连的是哪台设备、链路状态显示「已连接」、以及唯一的那个路径标签显示「局域网直连」，也就是在你自己网络里的主机到主机一跳。「P2P 直连」是另一种诚实的情况：两台设备确实共享同一个公网 IP，但浏览器最终选中的那一跳并不在本地。",
          "接收端的计数停在最后一个文件，而文件本身就在保存提示所说的位置。确认这一点要看接收端浏览器自己的下载列表，而不是看本页面——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
        ],
        code: ["已连接到 MacBook · 已连接 · 局域网直连\n文件 3/3"],
      },
      bullets: [
        "同网络房间不限于两台设备，所以房间里每部手机、每台笔记本都出现一张卡片是正常的，不是哪里出错了。",
        "这里不存在先上传、后下载：服务器上没有可以稍后再取的副本，所以两台设备都要停在页面上，直到计数走完。",
      ],
    },
    {
      heading: "两台设备互相看不到时",
      body: [
        "同网络发现依据的是你的浏览器从哪个网络连过来，所以先从这里查起：两台设备其实不在同一个网络、路由器把客户端隔开了、页面不是用 HTTPS 打开的，或者接收端浏览器被要求装下超出它能力的内容。这些是常见的第一批排查项，而不是全部原因；每一项在屏幕上都有能判定它的东西。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "「附近的设备」一直是空的，或者只列出你正在看的这一台。",
            code: ["https://relayium.com/   # 两台都打开，然后对比状态条里的公网 IP"],
            fix: "两个不同的公网 IP 就是两个不同的房间。VPN、iCloud 专用代理，或者把客户端从另一个地址送出去的访客 SSID 都是常见原因，但不是全部原因。如果你愿意改动它们：关掉 VPN，或只对当前这个 Wi-Fi 关闭专用代理，或者把两台设备都挪到主网络，然后在每台设备上重新加载 https://relayium.com/。如果你不想改，用 https://relayium.com/cross-network 上的配对码也能接上对方，两个设置都不用动，而且同样是端到端加密。",
          },
          {
            symptom: "两台设备显示的公网 IP 相同，卡片却仍然一张都不出现。",
            code: ["https://relayium.com/   # 设备列表下方的提示写着要改的那个路由器开关"],
            fix: "路由器把自己的客户端隔开了。在它的 Wi-Fi 设置里关闭「AP 隔离 / 客户端隔离」——Mesh 系统、酒店和访客网络经常默认开着——然后在两台设备上重新加载页面。如果路由器不由你管，那就改走 https://relayium.com/cross-network 上的配对码。",
          },
          {
            symptom: "页面提示加密传输需要 HTTPS，设备列表根本没出现。",
            code: ["https://relayium.com/   # 地址栏必须是 https，不是 http"],
            fix: "页面是用 http:// 或裸 IP 打开的，浏览器不会把加密传输所需的接口交给它。relayium.com 本身会跳转到 HTTPS，所以这通常意味着一个用 http:// 访问的自托管实例——请改用 https://relayium.com/ 打开，或者给你自己的实例配一张证书。",
          },
          {
            symptom: "还没点接收，接收端就警告说它必须把整批文件放在内存里。",
            code: ["chrome://downloads   # Chrome 用这个 / Edge 用 edge://downloads / Firefox 用 about:downloads"],
            fix: "那个浏览器无法把下载直接流式写入磁盘，于是会把整批缓存起来，批次一大就可能以标签页崩溃收场。请改用电脑上的 Chrome 或 Edge 接收，或者一次少发几个文件，并在接收端浏览器自己的下载列表里逐个确认到达情况——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)——而不是想当然认为已经保存。",
          },
          {
            symptom: "传输能跑，但标签显示的是「P2P 直连」而不是「局域网直连」。",
            code: ["https://relayium.com/   # 看工作区标题栏里的路径标签"],
            fix: "两台设备共享同一个公网 IP，却没有共享本地的那一跳——运营商级 NAT、同一条上行下的两个 VLAN，或者工作在客户端模式的信号扩展器都会这样。传输仍然是直连，也仍然端到端加密；如果你要的是走局域网而不是浏览器找到的那条路径，就把两台设备接到同一个接入点上。",
          },
        ],
      },
    },
    {
      heading: "为什么这么快：中间没有服务器",
      body: [
        "两台设备是从同一个网络连上来的，所以 Relayium 让它们点对点直连：字节直接从一台设备流向另一台，不绕道 Relayium 的服务器往返，既没有什么要先上传，也没有什么要等着下载。至于到底有多快，取决于两个浏览器最终选中的是哪一跳，而路径标签会把它说出来。「局域网直连」是本地的那一跳——数据不出你自己的网络，跑的是局域网的速度，而不是宽带的速度。「P2P 直连」同样是直连，中间同样没有服务器，但浏览器找到的那条路已经离开了本地网段，因此受限于它实际经过的链路。共享同一个公网 IP 只是把两台设备放进同一个房间，它本身并不保证两者之间那一跳是本地的。",
        "这也是为什么两端都不需要账号：既然大家已经在同一个可信网络里，Relayium 不需要靠登录来判断谁能连谁。",
      ],
    },
    {
      heading: "依然是端到端加密",
      body: [
        "在同一网络下不代表传输就是明文的。Relayium 会在两台设备之间协商 X25519 密钥交换，并用 AES-256-GCM 对每个数据块加密；这把密钥不会被任何服务器看到，包括 Relayium 自己的信令服务器——它只负责帮设备找到彼此。打开高级验证后，两块屏幕还会显示同一段简短校验码（SAS），能让你亲眼确认这条连接确实建立在你的两台设备之间，而每个文件还会用 SHA-256 哈希做端到端完整性校验，让你确信它是逐字节完整到达的。",
      ],
    },
    browserCrossNetworkSection.zh,
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "在同一 Wi-Fi 下传文件需要账号吗？",
        a: "不需要。同网络传输两端都无需账号，也无需配对码——每台设备打开 relayium.com 就行。",
      },
      {
        q: "Relayium 怎么知道哪些设备在我的网络里？",
        a: "同网络下的设备通常共享同一个公网 IP，Relayium 会自动把公网 IP 相同的设备归到同一个房间里，无需任何配对码。",
      },
      {
        q: "能不能同时有两台以上的设备互相看见？",
        a: "可以——从该网络打开 relayium.com 的每台设备都会列在房间里，手机、笔记本、台式机可以并排出现。但一次传输是一对一的：你和列表里的某一台设备打开工作区，文件就发给它。要分享给同一个房间里的几个人，就依次和每个人各开一次工作区。",
      },
      {
        q: "如果传输从未离开我的网络，还是加密的吗？",
        a: "是的。每一次同网络传输都使用和跨网络传输一样的 X25519 密钥交换与 AES-256-GCM 加密，有你能亲自核对的校验码，还有逐文件的 SHA-256 完整性校验。",
      },
      {
        q: "如果一台设备用 Wi-Fi，另一台用移动数据怎么办？",
        a: "那它们就不在同一网络，自动发现连不上。改用配对码：发送方登录后创建配对码，接收方无需账号。跨网络时传输不走直连，而是经一个加密的 TURN 中继转发，但全程仍是端到端加密：中继只转发密文，读不到文件内容。",
      },
    ],
  },
  cta: {
    text: "在同一 Wi-Fi 下的任意两台（或更多）设备上打开 Relayium，发出你的第一个文件——无需账号，无需配对码。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "同じ Wi-Fi 上の端末間でファイルを送る",
  description:
    "同じ Wi-Fi やローカルネットワーク上のどの端末同士でもファイルを送る方法。アカウント不要、ペアリングコード不要、両方で relayium.com を開くだけで直接転送、エンドツーエンド暗号化。",
  updatedLabel: "最終更新",
  lead: [
    "2台以上の端末が同じ Wi-Fi やローカルネットワークにあるなら、その間でファイルを送るのにアカウントもコードもクラウド経由も要らないはずです。Relayium は端末が同じネットワークを共有しているかを検出し、ブラウザの中で直接つなぎます。登録するものは何もありません。",
    "本ガイドは汎用的な同一ネットワークのケースを扱います。どんな端末・OS でも、同時に2台以上でも構いません。特定の端末の組み合わせを想定しているなら、末尾にリンクした PC からスマホへ、Mac から Windows へ、あるいは Windows/Linux/Android 向けの AirDrop 的な手順の専用ガイドを参照してください。",
  ],
  sections: [
    {
      heading: "同一ネットワークの検出の仕組み",
      body: [
        "Relayium は近くの端末を見つけるのに何かを入力させることはありません。ペアリングコードなしでブラウザが relayium.com を開くと、サーバーは接続元のネットワークをもとにルームへ割り当てます。実際には、同じグローバル IP アドレスを共有する端末（同じ自宅・オフィス・キャンパスの Wi-Fi、同じモバイルホットスポットなど）が自動的に同じルームに入ります。",
        "そのルームは2台までに限られません。そのネットワークから relayium.com を開いた端末はいくつでも入れるので、机を並べたノートPCの一群や教室のスマホ全員が、1対1に限らず一度に互いを見つけられます。",
      ],
    },
    {
      heading: "手順",
      prereqs: {
        label: "始める前に",
        items: [
          "すべての端末が同じ Wi-Fi またはローカルネットワークにあり、ルーターがクライアント同士を隔てていないこと。探すべき設定名は、端末一覧の下にある Relayium 自身のヒントに書かれています：「AP 分離 / クライアント分離」。",
          "各端末に最近のブラウザ（Chrome、Edge、Firefox、Safari）があり、ページを https://relayium.com/ で開いていること。暗号化転送には HTTPS が必要で、素の http:// で開いた場合は端末一覧の代わりにその旨が表示されます。",
          "アカウントもペアリングコードも不要です。同一ネットワークの検出はどちら側にもそれを求めないので、最初の転送の前に設定するものは何もありません。",
          "受信側にファイルの置き場所があること。どこに置かれるかを決めるのは Relayium ではなく受信側のブラウザと OS です：PC の Chrome と Edge は保存先を尋ねられますが、ほかのブラウザは自分のダウンロード先に書き込みます。実際にどこへ着いたかは、そのブラウザ自身のダウンロード一覧——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)——で確認します。",
        ],
      },
      body: [
        "すべてブラウザの中で完結します。どの端末にもインストールするものはありません。",
      ],
      steps: [
        {
          text: "使いたいすべての端末を同じ Wi-Fi またはローカルネットワークに接続し、それぞれで転送ページを開きます。",
          code: ["https://relayium.com/"],
        },
        {
          text: "両方の端末で見出しの下のステータス表示を読み、そこにあるグローバル IP を比べます。同じアドレスであることが 2 台を同じルームに入れる条件で、アドレスが違えばネットワークも別です。Wi-Fi の名前が同じでも関係ありません。",
          code: ["接続済み · このデバイス MacBook · グローバル IP 203.0.113.9"],
        },
        {
          text: "「近くのデバイス」の欄を見てください。そのネットワークからページを開いた端末はすべて、自分の名前を載せたカードとして並びます。入力も確認も要りません。",
        },
        {
          text: "送信側で相手のカードを押し、「ワークスペースを開く」を押します。最近のブラウザでは、近くのデバイスのカードが差し出す操作はこれ 1 つだけです。ファイルもフォルダもメッセージも、それが開く 1 本の暗号化接続を通ります。ルームに何台も並んでいることはありますが、ワークスペースを開くという操作が、今回の送り先を 1 台に決める操作です。次の相手にはあらためてもう 1 つ開きます。",
        },
        {
          text: "ワークスペースがそのカードと入れ替わります。以後、接続の状態はワークスペース上部のヘッダーで読みます——どの端末につながっているか、リンクの状態、そして 1 つだけの経路バッジ。送信はその下のコントロールで行います：まとめて送るなら「ファイルを送信」、ディレクトリ全体はブラウザがフォルダ選択に対応していれば「フォルダを送信」、あるいはメッセージ欄に入力して「送信」を押します。1 バッチは最大 1,000 ファイルです。",
        },
        {
          text: "受信側にはファイル数と合計サイズを添えたリクエストが届き、その下の行に「受信」を押すと何が起きるかが書かれています。ブラウザが保存先を尋ねるか、ダウンロード先に入るかのどちらかです。「受信」を押すと始まります。",
        },
        {
          text: "両方の画面でファイルカウンターが最後のファイルに達するまで見守ります。1 バイトも動く前に検証コード（SAS）を照合したい場合は、先に両方の端末で「高度な検証」をオンにしてください。既定はオフで、オンにして増えるのは照合と承認の一手間であって暗号化ではありません。オンでもオフでも転送は暗号化されています。",
        },
      ],
      success: {
        label: "転送が成功したときの画面",
        body: [
          "その頃には相手のカードは消えています——ワークスペースが取って代わったからです。状態はワークスペースのヘッダーで読みます：どの端末につながっているか、リンクの状態は「接続済み」、そして 1 つだけの経路バッジが「LAN直結」。自分のネットワーク内のホスト間 1 ホップという意味です。「P2P直結」はもう一つの正直な結果です：2 台は確かに同じグローバル IP を共有していたものの、ブラウザが選んだホップはローカルなものではありませんでした。",
          "受信側ではカウンターが最後のファイルで止まり、ファイル自体は保存の案内が示した場所にあります。それを確かめる場所はこのページではなく、受信側のブラウザ自身のダウンロード一覧です——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
        ],
        code: ["MacBook に接続済み · 接続済み · LAN直結\nファイル 3/3"],
      },
      bullets: [
        "同一ネットワークのルームは 2 台に限られないので、部屋にあるスマートフォンやノート PC の分だけカードが並ぶのは正常で、不具合ではありません。",
        "ここでは先にアップロードして後からダウンロードする、という動きはありません。あとで取りに行けるサーバー上のコピーは存在しないので、カウンターが終わるまで両方の端末はページに留まってください。",
      ],
    },
    {
      heading: "端末が互いに見えないとき",
      body: [
        "同一ネットワークの検出は、ブラウザがどのネットワークから接続しているかを手がかりにします。だからまずそこを見ます。2 台が実は同じネットワークにない、ルーターがクライアントを隔てている、ページが HTTPS で開かれていない、あるいは受信側のブラウザが抱えきれない量を求められている。これらは原因の全部ではなく、よくある最初の確認項目です。どれも画面上に判定材料があります。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "「近くのデバイス」がずっと空か、今見ている端末しか並ばない。",
            code: ["https://relayium.com/   # 両方で開き、ステータス表示のグローバル IP を比べる"],
            fix: "グローバル IP が 2 つ違えばルームも 2 つです。VPN、iCloud プライベートリレー、クライアントを別アドレスから出すゲスト SSID はよくある原因ですが、原因はそれだけではありません。設定を変えてよいなら、VPN を切る、その Wi-Fi にかぎってプライベートリレーをオフにする、または両方の端末をメインのネットワークへ移し、それぞれで https://relayium.com/ を再読み込みしてください。変えたくない場合は、https://relayium.com/cross-network のペアリングコードならどちらの設定も触らずに相手へ届き、同じくエンドツーエンド暗号化です。",
          },
          {
            symptom: "両方の端末が同じグローバル IP を表示しているのに、カードが 1 枚も現れない。",
            code: ["https://relayium.com/   # 端末一覧の下のヒントに、変更すべきルーター設定名がある"],
            fix: "ルーターが自分のクライアントを隔てています。Wi-Fi 設定で「AP 分離 / クライアント分離」をオフにし——メッシュ機器やホテル・ゲスト用ネットワークでは既定で有効なことが多いです——両方の端末でページを再読み込みしてください。ルーターを管理できない場合は、https://relayium.com/cross-network のペアリングコードが代わりの道です。",
          },
          {
            symptom: "暗号化転送には HTTPS が必要と表示され、端末一覧がまったく出ない。",
            code: ["https://relayium.com/   # アドレス欄は http ではなく https でなければならない"],
            fix: "ページが http:// か素の IP アドレスで開かれているため、ブラウザが暗号化転送に必要な API を渡しません。relayium.com 自体は HTTPS へリダイレクトするので、これは通常 http:// で参照している自己ホスト環境を意味します。https://relayium.com/ で開くか、自分の環境に証明書を用意してください。",
          },
          {
            symptom: "受信を押す前に、受信側がバッチ全体をメモリに保持しなければならないと警告する。",
            code: ["chrome://downloads   # Chrome 用 / Edge は edge://downloads / Firefox は about:downloads"],
            fix: "そのブラウザはダウンロードをディスクへ直接ストリーミングできないため、バッチ全体を抱え込み、大きいとタブが落ちて終わることがあります。PC の Chrome か Edge で受け取るか、一度に送るファイルを減らし、保存できたと決め込まずに受信側のブラウザ自身のダウンロード一覧——chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)——で 1 つずつ確認してください。",
          },
          {
            symptom: "転送は動くが、バッジが「LAN直結」ではなく「P2P直結」になっている。",
            code: ["https://relayium.com/   # ワークスペースのヘッダーにある経路バッジを読む"],
            fix: "2 台はグローバル IP を共有しているのに、ローカルなホップは共有していません。キャリアグレード NAT、1 本の上流にぶら下がる 2 つの VLAN、クライアントモードの中継機などがこうなります。転送は依然として直接で、依然としてエンドツーエンド暗号化です。経路をブラウザが見つけた道ではなく LAN にしたいなら、両方の端末を同じアクセスポイントにつないでください。",
          },
        ],
      },
    },
    {
      heading: "なぜ速いのか：間にサーバーが挟まらない",
      body: [
        "2 台は同じネットワークから接続しているので、Relayium は両者を P2P で直接つなぎます。バイトは一方からもう一方へ渡り、Relayium のサーバーを往復しません。先にアップロードするものも、あとからダウンロードを待つものもありません。どれだけ速いかは、2 つのブラウザが最終的に選んだホップ次第で、それを言い当てるのが経路バッジです。「LAN直結」はローカルなホップで、データは自分のネットワークの外に出ず、インターネット回線ではなく LAN の速度で流れます。「P2P直結」も同じく直接で、間にサーバーはありませんが、ブラウザが見つけた経路はローカルなセグメントを出ているので、実際に通る回線の速さに縛られます。グローバル IP が同じであることは 2 台を同じルームに入れるだけで、それ自体は 2 台の間のホップがローカルだという保証ではありません。",
        "これがどちら側にもアカウントが要らない理由でもあります。全員がすでに同じ信頼できるネットワーク上にいるので、誰が誰につないでよいかを知るのにサインインは必要ありません。",
      ],
    },
    {
      heading: "それでもエンドツーエンド暗号化",
      body: [
        "同じネットワーク上にあるからといって、転送が平文で送られるわけではありません。Relayium は2台の端末間で X25519 鍵交換を行い、すべてのチャンクを AES-256-GCM で暗号化します。その鍵は、端末同士が互いを見つける手助けをするだけの Relayium 自身のシグナリングサーバーを含め、いかなるサーバーにも見えません。高度な検証をオンにすると両方の画面に短い検証コード（SAS）も表示され、接続が本当に手元の2台の端末間であることを目視で確認でき、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるので、バイト単位で無事に届いたことがわかります。",
      ],
    },
    browserCrossNetworkSection.ja,
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "同じ Wi-Fi でファイルを送るのにアカウントは必要ですか？",
        a: "いいえ。同一ネットワークでの転送はどちら側にもアカウントもペアリングコードも不要です。各端末で relayium.com を開くだけです。",
      },
      {
        q: "Relayium はどの端末が自分のネットワークにあると分かるのですか？",
        a: "同一ネットワーク上の端末は通常同じグローバル IP アドレスを共有しており、Relayium はグローバル IP が一致する端末を自動的に同じルームにまとめます。コードは不要です。",
      },
      {
        q: "3台以上の端末が同時に互いを見られますか？",
        a: "はい。そのネットワークから relayium.com を開いた端末はすべてルームに並ぶので、スマートフォンもノートPCもデスクトップも横並びで表示されます。ただし転送そのものは 1 対 1 です。並んだ端末のうち 1 台とワークスペースを開き、ファイルはその相手に届きます。同じ部屋の複数人に渡すときは、相手ごとに順番にワークスペースを開いてください。",
      },
      {
        q: "ネットワークの外に出ない転送でも暗号化されていますか？",
        a: "はい。同一ネットワークの転送もネットワークをまたぐ転送と同じ X25519 鍵交換と AES-256-GCM 暗号化を使い、自分で確認できる検証コードと、ファイルごとの SHA-256 整合性チェックがあります。",
      },
      {
        q: "片方が Wi-Fi、もう片方がモバイル通信の場合は？",
        a: "それは同じネットワークではないので、自動発見ではつながりません。代わりにペアリングコードを使ってください。送信側がサインインしてコードを作成し、受信側はアカウント不要です。ネットワークをまたぐ転送は直接接続ではなく暗号化された TURN リレー経由で行われますが、全体を通じてエンドツーエンド暗号化のままです。リレーが転送するのは暗号文だけで、ファイルの中身は読めません。",
      },
    ],
  },
  cta: {
    text: "同じ Wi-Fi 上の任意の2台（またはそれ以上）で Relayium を開き、最初のファイルを送ってみてください。アカウントもコードも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "같은 Wi-Fi에 있는 기기끼리 파일 보내기",
  description:
    "같은 Wi-Fi나 로컬 네트워크에 있는 어떤 기기끼리도 파일을 보내는 방법 — 계정도, 페어링 코드도 필요 없이 양쪽에서 relayium.com만 열면 직접 전송되며 종단간 암호화됩니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "두 대 이상의 기기가 같은 Wi-Fi나 로컬 네트워크에 있다면, 그 사이에 파일을 보내는 데 계정도, 코드도, 클라우드를 거칠 필요도 없어야 합니다. Relayium은 기기가 같은 네트워크를 공유하는지 감지해 브라우저 안에서 곧바로 연결해 줍니다. 가입할 것도 없습니다.",
    "이 가이드는 일반적인 같은 네트워크 상황을 다룹니다 — 어떤 기기든, 어떤 운영체제든, 심지어 동시에 두 대 이상이어도 됩니다. 특정 기기 조합을 염두에 두고 있다면 끝에 링크된 PC에서 폰으로, Mac에서 Windows로, 또는 Windows/Linux/Android용 AirDrop 방식 전용 가이드를 참고하세요.",
  ],
  sections: [
    {
      heading: "같은 네트워크 감지는 어떻게 되나",
      body: [
        "Relayium은 근처 기기를 찾기 위해 무언가를 입력하라고 하지 않습니다. 브라우저가 페어링 코드 없이 relayium.com을 열면 서버는 접속한 네트워크를 기준으로 방에 배치합니다 — 실제로는 같은 공인 IP 주소를 공유하는 기기(같은 집, 사무실, 캠퍼스 Wi-Fi, 또는 같은 모바일 핫스팟)이 자동으로 같은 방에 들어갑니다.",
        "그 방은 두 대로 제한되지 않습니다. 그 네트워크에서 사이트를 연 기기가 몇 대든 방에 들어갈 수 있어서, 책상 가득한 노트북이나 교실의 휴대폰이 한 쌍뿐 아니라 한꺼번에 서로를 볼 수 있습니다.",
      ],
    },
    {
      heading: "단계별 안내",
      prereqs: {
        label: "시작하기 전에",
        items: [
          "모든 기기가 같은 Wi-Fi 또는 로컬 네트워크에 있고, 공유기가 클라이언트끼리를 갈라놓지 않아야 합니다. 찾아야 할 설정 이름은 기기 목록 아래에 있는 Relayium 자체 안내에 적혀 있습니다: ‘AP 격리 / 클라이언트 격리’.",
          "각 기기에 최신 브라우저(Chrome, Edge, Firefox 또는 Safari)가 있고, 페이지를 https://relayium.com/ 으로 열어야 합니다. 암호화 전송에는 HTTPS가 필요하며, 평범한 http:// 로 열면 기기 목록 대신 바로 그 사실이 표시됩니다.",
          "계정도 페어링 코드도 필요 없습니다. 같은 네트워크 탐색은 양쪽 모두에 그것을 요구하지 않으므로, 첫 전송 전에 설정할 것이 하나도 없습니다.",
          "받는 기기에 파일이 놓일 자리가 있어야 합니다. 어디에 놓일지는 Relayium이 아니라 받는 쪽 브라우저와 운영체제가 정합니다: 컴퓨터의 Chrome과 Edge는 저장 위치를 물어볼 수 있고, 다른 브라우저는 자체 다운로드 폴더에 씁니다. 실제로 어디에 떨어졌는지는 그 브라우저 자체의 다운로드 목록 — chrome://downloads (Chrome), edge://downloads (Edge), about:downloads (Firefox) — 에서 확인합니다.",
        ],
      },
      body: [
        "전 과정이 브라우저 안에서 이루어집니다 — 어느 기기에도 설치할 앱이 없습니다.",
      ],
      steps: [
        {
          text: "사용하려는 모든 기기를 같은 Wi-Fi 또는 로컬 네트워크에 연결한 다음, 각 기기에서 전송 페이지를 엽니다.",
          code: ["https://relayium.com/"],
        },
        {
          text: "두 기기에서 제목 아래 상태 표시를 읽고 거기 있는 공인 IP를 비교합니다. 주소가 같아야 두 기기가 같은 방에 들어가고, 주소가 다르면 Wi-Fi 이름이 무엇이든 서로 다른 네트워크입니다.",
          code: ["연결됨 · 내 기기 MacBook · 공인 IP 203.0.113.9"],
        },
        {
          text: "“주변 기기” 칸을 봅니다. 그 네트워크에서 페이지를 연 기기는 모두 자기 이름이 적힌 카드로 나열됩니다. 입력할 것도, 확인할 것도 없습니다.",
        },
        {
          text: "보내는 기기에서 상대 카드를 누르고 “작업 공간 열기”를 누릅니다. 최신 브라우저에서 주변 기기 카드가 내놓는 동작은 이것 하나뿐입니다. 파일도 폴더도 메시지도 모두 그것이 여는 하나의 암호화된 연결을 지나갑니다. 방에는 여러 기기가 나열될 수 있는데, 작업 공간을 여는 행위가 이번에 보낼 상대를 한 대로 고르는 행위입니다. 다음 사람에게 보낼 때는 작업 공간을 다시 엽니다.",
        },
        {
          text: "작업 공간이 그 카드를 대신합니다. 이제부터 연결 상태는 작업 공간 위쪽 헤더에서 읽습니다 — 어느 기기에 연결되었는지, 링크 상태, 그리고 단 하나의 경로 배지. 보내기는 그 아래 컨트롤로 합니다: 묶음은 “파일 보내기”, 디렉터리 전체는 브라우저가 폴더 선택을 지원할 때 “폴더 보내기”, 아니면 메시지 칸에 입력하고 “보내기”를 누릅니다. 한 배치는 최대 1,000개입니다.",
        },
        {
          text: "받는 기기에는 파일 개수와 총 크기가 붙은 요청이 도착하고, 그 아래 줄에 “받기”를 누르면 무슨 일이 생기는지 적혀 있습니다. 브라우저가 저장 위치를 묻거나, 파일이 다운로드 폴더로 들어가거나 둘 중 하나입니다. “받기”를 누르면 시작됩니다.",
        },
        {
          text: "두 화면에서 파일 카운터가 마지막 파일에 닿을 때까지 지켜봅니다. 한 바이트도 움직이기 전에 검증 코드(SAS)를 대조하고 싶다면 두 기기에서 먼저 “고급 검증”을 켜세요. 기본값은 꺼짐이며, 켜서 늘어나는 것은 대조와 승인 한 단계일 뿐 암호화가 아닙니다. 켜든 끄든 전송은 암호화됩니다.",
        },
      ],
      success: {
        label: "전송이 잘될 때의 화면",
        body: [
          "그때쯤이면 상대 카드는 사라져 있습니다 — 작업 공간이 그 자리를 차지했기 때문입니다. 상태는 작업 공간 헤더에서 읽습니다: 어느 기기에 연결되었는지, 링크 상태는 “연결됨”, 그리고 단 하나의 경로 배지가 “LAN 직접”. 내 네트워크 안의 호스트 대 호스트 한 홉이라는 뜻입니다. “P2P 직접”은 또 하나의 정직한 결과입니다: 두 기기가 정말 같은 공인 IP를 공유했지만, 브라우저가 정착한 홉은 로컬이 아니었다는 뜻입니다.",
          "받는 쪽에서는 카운터가 마지막 파일에서 멈추고, 파일 자체는 저장 안내가 말한 곳에 있습니다. 그것을 확인하는 자리는 이 페이지가 아니라 받는 쪽 브라우저 자체의 다운로드 목록입니다 — chrome://downloads (Chrome), edge://downloads (Edge), about:downloads (Firefox).",
        ],
        code: ["MacBook 에 연결됨 · 연결됨 · LAN 직접\n파일 3/3"],
      },
      bullets: [
        "같은 네트워크 방은 두 대로 제한되지 않으므로, 방에 있는 휴대폰과 노트북 수만큼 카드가 늘어서는 것은 정상이며 고장이 아닙니다.",
        "여기에는 먼저 올리고 나중에 받는 단계가 없습니다. 나중에 가져올 서버 사본이 존재하지 않으니, 카운터가 끝날 때까지 두 기기 모두 페이지에 머물러야 합니다.",
      ],
    },
    {
      heading: "기기가 서로 보이지 않을 때",
      body: [
        "같은 네트워크 탐색은 브라우저가 어느 네트워크에서 접속하는지를 기준으로 삼으니, 먼저 그쪽부터 봅니다. 두 기기가 실은 같은 네트워크가 아니거나, 공유기가 클라이언트를 갈라놓았거나, 페이지를 HTTPS로 열지 않았거나, 받는 브라우저가 감당하지 못할 양을 요구받은 경우입니다. 이것들은 원인의 전부가 아니라 흔한 첫 확인 항목이며, 모두 화면에 판단 근거가 있습니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "“주변 기기”가 계속 비어 있거나, 지금 보고 있는 기기만 나옵니다.",
            code: ["https://relayium.com/   # 두 기기에서 열고 상태 표시의 공인 IP를 비교한다"],
            fix: "공인 IP가 다르면 방도 다릅니다. VPN, iCloud 비공개 릴레이, 클라이언트를 다른 주소로 내보내는 게스트 SSID는 흔한 원인이지만 그것만은 아닙니다. 설정을 바꿔도 괜찮다면 VPN을 끄거나, 그 Wi-Fi에 한해 비공개 릴레이를 끄거나, 두 기기를 주 네트워크로 옮긴 뒤 각 기기에서 https://relayium.com/ 을 다시 불러오세요. 그대로 두고 싶다면 https://relayium.com/cross-network 의 페어링 코드가 두 설정을 건드리지 않고 상대에게 닿으며, 마찬가지로 종단간 암호화입니다.",
          },
          {
            symptom: "두 기기가 같은 공인 IP를 보여주는데도 카드가 하나도 나타나지 않습니다.",
            code: ["https://relayium.com/   # 기기 목록 아래 안내에 바꿔야 할 공유기 설정 이름이 있다"],
            fix: "공유기가 자기 클라이언트를 갈라놓고 있습니다. Wi-Fi 설정에서 ‘AP 격리 / 클라이언트 격리’를 끄고 — 메시 장비, 호텔과 게스트 네트워크는 기본으로 켜둔 경우가 많습니다 — 두 기기에서 페이지를 다시 불러오세요. 공유기를 관리할 수 없다면 https://relayium.com/cross-network 의 페어링 코드가 대신 쓸 길입니다.",
          },
          {
            symptom: "암호화 전송에 HTTPS가 필요하다고만 나오고 기기 목록이 전혀 보이지 않습니다.",
            code: ["https://relayium.com/   # 주소창이 http가 아니라 https여야 한다"],
            fix: "페이지가 http:// 또는 맨 IP 주소로 열려서, 브라우저가 암호화 전송에 필요한 API를 내주지 않습니다. relayium.com 자체는 HTTPS로 넘겨주므로 이는 보통 http:// 로 접근하는 자체 호스팅 인스턴스를 뜻합니다. https://relayium.com/ 으로 열거나, 자기 인스턴스에 인증서를 붙이세요.",
          },
          {
            symptom: "받기를 누르기 전에, 받는 기기가 배치 전체를 메모리에 담아야 한다고 경고합니다.",
            code: ["chrome://downloads   # Chrome용 / Edge는 edge://downloads / Firefox는 about:downloads"],
            fix: "그 브라우저는 다운로드를 디스크로 바로 스트리밍하지 못해 배치 전체를 안고 있으며, 크면 탭이 죽으며 끝날 수 있습니다. 컴퓨터의 Chrome이나 Edge로 받거나 한 번에 보내는 파일 수를 줄이고, 저장되었다고 단정하지 말고 받는 쪽 브라우저 자체의 다운로드 목록 — chrome://downloads (Chrome), edge://downloads (Edge), about:downloads (Firefox) — 에서 하나씩 확인하세요.",
          },
          {
            symptom: "전송은 되지만 배지가 “LAN 직접”이 아니라 “P2P 직접”으로 나옵니다.",
            code: ["https://relayium.com/   # 작업 공간 헤더의 경로 배지를 읽는다"],
            fix: "두 기기가 공인 IP는 공유하지만 로컬 홉은 공유하지 않습니다. 통신사급 NAT, 한 회선 아래 두 VLAN, 클라이언트 모드로 동작하는 확장기가 모두 이렇게 됩니다. 전송은 여전히 직접이고 여전히 종단간 암호화입니다. 경로를 브라우저가 찾은 길이 아니라 LAN으로 만들고 싶다면 두 기기를 같은 액세스 포인트에 연결하세요.",
          },
        ],
      },
    },
    {
      heading: "왜 빠른가: 중간에 서버가 없다",
      body: [
        "두 기기가 같은 네트워크에서 접속하므로 Relayium은 둘을 P2P로 직접 잇습니다. 바이트는 한 기기에서 다른 기기로 곧장 건너가며 Relayium 서버를 왕복하지 않고, 먼저 올릴 것도 나중에 받기를 기다릴 것도 없습니다. 얼마나 빠른지는 두 브라우저가 실제로 정착한 홉에 달렸고, 그것을 이름 붙이는 것이 경로 배지입니다. “LAN 직접”은 로컬 홉이라, 데이터가 내 네트워크 밖으로 나가지 않고 인터넷 회선이 아니라 랜의 속도로 흐릅니다. “P2P 직접”도 마찬가지로 직접이고 중간에 서버가 없지만, 브라우저가 찾아낸 경로가 로컬 구간을 벗어났으므로 실제로 지나는 회선의 속도에 묶입니다. 공인 IP가 같다는 것은 두 기기를 같은 방에 넣어줄 뿐, 그 자체로 둘 사이의 홉이 로컬이라는 보장은 아닙니다.",
        "이것이 양쪽 다 계정이 필요 없는 이유이기도 합니다. 모두가 이미 같은 신뢰할 수 있는 네트워크에 있으니, 누가 누구에게 연결해도 되는지 알기 위해 로그인이 필요하지 않습니다.",
      ],
    },
    {
      heading: "그래도 종단간 암호화",
      body: [
        "같은 네트워크에 있다고 해서 전송이 평문으로 이루어지는 것은 아닙니다. Relayium은 두 기기 사이에서 X25519 키 교환을 협상하고 모든 청크를 AES-256-GCM으로 암호화합니다. 그 키는 기기가 서로를 찾도록 돕기만 하는 Relayium 자체 시그널링 서버를 포함해 어떤 서버에도 보이지 않습니다. 고급 검증을 켜면 두 화면에 동일한 짧은 검증 코드(SAS)도 표시되어 연결이 정말로 내 두 기기 사이에서 이루어졌는지 눈으로 확인할 수 있고, 각 파일은 SHA-256 해시로 종단간 검증되어 바이트 단위로 온전히 도착했음을 알 수 있습니다.",
      ],
    },
    browserCrossNetworkSection.ko,
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "같은 Wi-Fi에서 파일을 보내려면 계정이 필요한가요?",
        a: "아니요. 같은 네트워크에서의 전송은 양쪽 다 계정도, 페어링 코드도 필요 없습니다 — 각 기기에서 relayium.com만 열면 됩니다.",
      },
      {
        q: "Relayium은 어떤 기기가 내 네트워크에 있는지 어떻게 아나요?",
        a: "같은 네트워크에 있는 기기는 보통 같은 공인 IP 주소를 공유하며, Relayium은 공인 IP가 일치하는 기기를 자동으로 같은 방에 묶습니다. 코드는 필요 없습니다.",
      },
      {
        q: "두 대보다 많은 기기가 동시에 서로를 볼 수 있나요?",
        a: "네. 그 네트워크에서 relayium.com을 연 기기는 모두 방에 나열되어 휴대폰과 노트북, 데스크톱이 나란히 보입니다. 다만 전송 자체는 1대 1입니다. 나열된 기기 중 하나와 작업 공간을 열고, 파일은 그 상대에게 갑니다. 같은 방의 여러 사람과 나누려면 각자와 차례로 작업 공간을 열면 됩니다.",
      },
      {
        q: "전송이 내 네트워크를 벗어나지 않아도 여전히 암호화되나요?",
        a: "네. 같은 네트워크 전송도 네트워크를 넘는 전송과 동일한 X25519 키 교환과 AES-256-GCM 암호화를 사용하며, 직접 확인할 수 있는 검증 코드와 파일별 SHA-256 무결성 검사가 있습니다.",
      },
      {
        q: "한쪽은 Wi-Fi, 다른 쪽은 모바일 데이터라면 어떻게 하나요?",
        a: "그러면 같은 네트워크가 아니므로 자동 탐색으로는 연결되지 않습니다. 대신 페어링 코드를 사용하세요 — 보내는 쪽이 로그인해 코드를 만들고, 받는 쪽은 계정이 필요 없습니다. 네트워크를 넘나드는 전송은 직접 연결이 아니라 암호화된 TURN 릴레이를 거치지만, 처음부터 끝까지 종단간 암호화가 유지됩니다. 릴레이는 암호문만 전달할 뿐 파일 내용을 읽을 수 없습니다.",
      },
    ],
  },
  cta: {
    text: "같은 Wi-Fi에 있는 아무 두 대(또는 그 이상)의 기기에서 Relayium을 열고 첫 파일을 보내 보세요 — 계정도 코드도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien zwischen Geräten im selben WLAN senden",
  description:
    "So sendest du Dateien zwischen beliebigen Geräten im selben WLAN oder lokalen Netz — kein Konto, kein Pairing-Code, einfach relayium.com auf beiden öffnen und direkt übertragen, Ende-zu-Ende-verschlüsselt.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Wenn zwei oder mehr Geräte im selben WLAN oder lokalen Netz sind, sollte eine Dateiübertragung zwischen ihnen kein Konto, keinen Code und keinen Umweg über die Cloud erfordern. Relayium erkennt, wenn Geräte sich ein Netzwerk teilen, und lässt sie sich direkt im Browser verbinden, ohne dass irgendwo eine Anmeldung nötig ist.",
    "Diese Anleitung behandelt den allgemeinen Fall im selben Netz — beliebige Geräte, beliebige Betriebssysteme, sogar mehr als zwei gleichzeitig. Wenn du ein bestimmtes Gerätepaar im Sinn hast, findest du am Ende Links zu den eigenen Anleitungen für PC zu Handy, Mac zu Windows oder einen AirDrop-ähnlichen Ablauf für Windows/Linux/Android.",
  ],
  sections: [
    {
      heading: "Wie die Erkennung im selben Netz funktioniert",
      body: [
        "Relayium verlangt keine Eingabe, um Geräte in der Nähe zu finden. Öffnet dein Browser relayium.com ohne Pairing-Code, weist dich der Server anhand des Netzwerks, über das du verbunden bist, einem Raum zu — in der Praxis landen Geräte, die dieselbe öffentliche IP-Adresse teilen (dasselbe WLAN zu Hause, im Büro, auf dem Campus, oder derselbe mobile Hotspot), automatisch im selben Raum.",
        "Dieser Raum ist nicht auf zwei Teilnehmer begrenzt: Er fasst so viele Geräte, wie von diesem Netzwerk aus die Seite öffnen, sodass ein ganzer Schreibtisch voller Laptops oder ein Klassenzimmer voller Handys sich alle gleichzeitig sehen können, nicht nur ein einzelnes Paar.",
      ],
    },
    {
      heading: "Schritt für Schritt",
      prereqs: {
        label: "Bevor du anfängst",
        items: [
          "Alle Geräte im selben WLAN oder lokalen Netz, und der Router trennt seine Clients nicht voneinander. Wie die Einstellung heißt, steht in Relayiums eigenem Hinweis unter der Geräteliste: „AP-Isolierung / Client-Isolierung“.",
          "Ein aktueller Browser auf jedem Gerät (Chrome, Edge, Firefox oder Safari), und die Seite über https://relayium.com/ geöffnet. Verschlüsselte Übertragung braucht HTTPS; über einfaches http:// sagt die Seite genau das, statt Geräte aufzulisten.",
          "Kein Konto und kein Pairing-Code. Die Erkennung im selben Netz verlangt beides auf keiner Seite, also gibt es vor der ersten Übertragung nichts einzurichten.",
          "Platz für die Dateien auf dem empfangenden Gerät. Wo sie landen, entscheiden der empfangende Browser und sein Betriebssystem und nicht Relayium: Chrome und Edge am Computer können nach dem Speicherort fragen, andere Browser schreiben in ihren eigenen Download-Ordner. Wo sie tatsächlich gelandet sind, siehst du in der Download-Liste dieses Browsers — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
      },
      body: [
        "Der gesamte Ablauf findet im Browser statt — auf keinem Gerät ist etwas zu installieren.",
      ],
      steps: [
        {
          text: "Verbinde jedes Gerät, das du nutzen möchtest, mit demselben WLAN oder lokalen Netz und öffne dann auf jedem die Übertragungsseite.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Lies auf beiden Geräten die Statuszeile unter der Überschrift und vergleiche die öffentliche IP darin. Erst eine gemeinsame Adresse steckt zwei Geräte in denselben Raum; zwei verschiedene Adressen bedeuten zwei Netze, ganz egal wie das WLAN heißt.",
          code: ["Verbunden · dieses Gerät MacBook · öffentliche IP 203.0.113.9"],
        },
        {
          text: "Schau unter „Geräte in der Nähe“. Jedes Gerät, das die Seite aus diesem Netz geöffnet hat, steht dort als Karte mit seinem eigenen Namen — nichts zu tippen, nichts zu bestätigen.",
        },
        {
          text: "Klicke auf dem sendenden Gerät die Karte der Gegenseite an und drücke „Arbeitsbereich öffnen“. In einem aktuellen Browser ist das die einzige Aktion, die eine Karte in der Nähe anbietet: Dateien, Ordner und Nachrichten laufen alle über die eine verschlüsselte Verbindung, die sie öffnet. Im Raum stehen womöglich mehrere Geräte; mit dem Öffnen des Arbeitsbereichs legst du fest, an welches davon diese Übertragung geht — für die nächste Person öffnest du einen weiteren.",
        },
        {
          text: "Der Arbeitsbereich ersetzt diese Karte. Den Verbindungszustand liest du ab jetzt in seiner Kopfzeile — mit wem du verbunden bist, der Zustand der Verbindung und das eine Pfad-Abzeichen. Gesendet wird mit den Bedienelementen darunter: „Dateien senden“ für einen Stapel, „Ordner senden“ für einen ganzen Baum, sofern der Browser Ordnerauswahl anbietet, oder tippe ins Nachrichtenfeld und drücke „Senden“. Ein Dateistapel trägt bis zu 1.000 Dateien.",
        },
        {
          text: "Auf dem empfangenden Gerät kommt die Anfrage mit Dateizahl und Gesamtgröße an, und die Zeile darunter sagt, was „Annehmen“ auslöst: entweder fragt der Browser nach dem Speicherort, oder die Dateien landen in seinem Download-Ordner. Mit „Annehmen“ startet es.",
        },
        {
          text: "Sieh zu, wie der Dateizähler auf beiden Bildschirmen die letzte Datei erreicht. Wer vor dem ersten Byte einen Verifizierungscode (SAS) vergleichen will, schaltet vorher auf beiden Geräten „Erweiterte Verifizierung“ ein: standardmäßig aus, und was dabei hinzukommt, ist ein Vergleich samt Zustimmungsschritt, nicht die Verschlüsselung — verschlüsselt ist die Übertragung so oder so.",
        },
      ],
      success: {
        label: "So sieht eine funktionierende Übertragung aus",
        body: [
          "Die Karte der Gegenseite ist dann verschwunden — der Arbeitsbereich hat ihren Platz eingenommen. Der Zustand steht stattdessen in dessen Kopfzeile: mit welchem Gerät du verbunden bist, ein Verbindungszustand „Verbunden“ und ein einziges Pfad-Abzeichen mit „LAN direkt“ — ein Host-zu-Host-Sprung über dein eigenes Netz. „P2P direkt“ ist der zweite ehrliche Fall: die beiden Geräte teilten tatsächlich eine öffentliche IP, aber der Sprung, auf den sich die Browser geeinigt haben, war kein lokaler.",
          "Auf der Empfangsseite bleibt der Zähler auf der letzten Datei stehen, und die Datei selbst liegt dort, wo die Speicherzeile es angekündigt hat. Nachsehen kannst du das in der Download-Liste des empfangenden Browsers, nicht auf dieser Seite — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
        code: ["Verbunden mit MacBook · Verbunden · LAN direkt\nDatei 3/3"],
      },
      bullets: [
        "Ein Raum im selben Netz ist nicht auf zwei Geräte begrenzt: eine Karte für jedes Handy und jeden Laptop im Zimmer ist normal und kein Anzeichen für einen Fehler.",
        "Hier wird nichts erst hochgeladen und später heruntergeladen, es gibt also keine Kopie auf einem Server zum späteren Abholen — beide Geräte bleiben auf der Seite, bis der Zähler durch ist.",
      ],
    },
    {
      heading: "Wenn sich die Geräte nicht sehen",
      body: [
        "Die Erkennung im selben Netz richtet sich danach, aus welchem Netz sich der Browser verbindet — dort schaust du also zuerst nach: die beiden Geräte sind gar nicht in einem Netz, der Router hält seine Clients auseinander, die Seite wurde nicht über HTTPS geöffnet, oder der empfangende Browser soll mehr halten als er kann. Das sind übliche erste Prüfungen und nicht die vollständige Liste; für jede steht etwas auf dem Bildschirm, das sie entscheidet.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "„Geräte in der Nähe“ bleibt leer oder listet nur das Gerät, auf das du gerade schaust.",
            code: ["https://relayium.com/   # auf beiden öffnen, dann die öffentliche IP in der Statuszeile vergleichen"],
            fix: "Zwei verschiedene öffentliche IP-Adressen bedeuten zwei getrennte Räume. Ein VPN, iCloud Private Relay oder eine Gast-SSID, die Clients über eine andere Adresse hinausschickt, sind häufige Gründe dafür und nicht die einzigen. Wenn du sie ändern willst: VPN aus, oder Private Relay nur für dieses eine WLAN aus, oder beide Geräte ins Hauptnetz holen, dann auf jedem https://relayium.com/ neu laden. Willst du sie lieber anlassen, erreicht ein Pairing-Code auf https://relayium.com/cross-network das andere Gerät, ohne eine der Einstellungen anzufassen, und ist genauso Ende-zu-Ende-verschlüsselt.",
          },
          {
            symptom: "Beide Geräte zeigen dieselbe öffentliche IP, und trotzdem erscheint keine Karte.",
            code: ["https://relayium.com/   # der Hinweis unter der Geräteliste nennt die Router-Einstellung"],
            fix: "Der Router trennt seine eigenen Clients. Schalte „AP-Isolierung / Client-Isolierung“ in seinen WLAN-Einstellungen aus — Mesh-Systeme sowie Hotel- und Gastnetze liefern das oft aktiv aus — und lade die Seite auf beiden Geräten neu. Wenn der Router nicht dir gehört, führt stattdessen ein Pairing-Code auf https://relayium.com/cross-network zum Ziel.",
          },
          {
            symptom: "Die Seite meldet, verschlüsselte Übertragung erfordere HTTPS, und es erscheint überhaupt keine Geräteliste.",
            code: ["https://relayium.com/   # in der Adresszeile muss https stehen, nicht http"],
            fix: "Die Seite wurde über http:// oder per nackter IP-Adresse geöffnet, und der Browser gibt die APIs für eine verschlüsselte Übertragung dann nicht heraus. relayium.com selbst leitet auf HTTPS um, das heißt hier steckt in der Regel eine selbst gehostete Instanz über http:// dahinter — öffne sie als https://relayium.com/, oder gib der eigenen Instanz ein Zertifikat.",
          },
          {
            symptom: "Das empfangende Gerät warnt vor dem Annehmen, es müsse den ganzen Stapel im Speicher halten.",
            code: ["chrome://downloads   # in Chrome; Edge hat edge://downloads und Firefox about:downloads"],
            fix: "Dieser Browser kann einen Download nicht direkt auf die Platte streamen, puffert also den Stapel, und ein großer endet womöglich in einem abgestürzten Tab. Empfange ihn in Chrome oder Edge am Computer, oder schicke weniger Dateien auf einmal, und kontrolliere jede Ankunft in der Download-Liste des empfangenden Browsers — chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox — statt das Speichern anzunehmen.",
          },
          {
            symptom: "Die Übertragung läuft, aber das Abzeichen zeigt „P2P direkt“ statt „LAN direkt“.",
            code: ["https://relayium.com/   # das Pfad-Abzeichen in der Kopfzeile des Arbeitsbereichs lesen"],
            fix: "Die beiden Geräte teilen eine öffentliche IP, aber keinen lokalen Sprung — Carrier-Grade-NAT, zwei VLANs hinter einem Uplink oder ein Repeater im Client-Modus führen alle dazu. Die Übertragung bleibt direkt und bleibt Ende-zu-Ende-verschlüsselt; häng beide Geräte an denselben Access Point, wenn der Pfad dein LAN sein soll und nicht die Route, die die Browser gefunden haben.",
          },
        ],
      },
    },
    {
      heading: "Warum es schnell ist: kein Server dazwischen",
      body: [
        "Beide Geräte verbinden sich aus demselben Netz, also koppelt Relayium sie Peer-to-Peer: Die Bytes wandern von einem Gerät zum anderen, ohne den Umweg über einen Relayium-Server, und es gibt weder etwas vorher hochzuladen noch hinterher auf einen Download zu warten. Wie schnell das ist, hängt an dem Sprung, auf den sich die beiden Browser tatsächlich geeinigt haben — und genau den benennt das Pfad-Abzeichen. „LAN direkt“ ist der lokale: Die Daten bleiben in deinem eigenen Netz und laufen mit dessen Tempo statt mit dem deiner Internetleitung. „P2P direkt“ ist ebenso direkt und hat ebenso keinen Server dazwischen, aber die gefundene Route hat das lokale Segment verlassen und ist damit von der Leitung begrenzt, die sie wirklich kreuzt. Eine gemeinsame öffentliche IP steckt zwei Geräte in denselben Raum; sie ist für sich genommen keine Zusage, dass der Sprung dazwischen ein lokaler ist.",
        "Das ist auch der Grund, warum auf keiner Seite ein Konto beteiligt ist: Da alle bereits im selben vertrauenswürdigen Netz sind, braucht Relayium keine Anmeldung, um zu wissen, wer sich mit wem verbinden darf.",
      ],
    },
    {
      heading: "Trotzdem Ende-zu-Ende-verschlüsselt",
      body: [
        "Im selben Netz zu sein bedeutet nicht, dass die Übertragung im Klartext erfolgt. Relayium handelt zwischen den beiden Geräten einen X25519-Schlüsselaustausch aus und verschlüsselt jeden Block mit AES-256-GCM; diesen Schlüssel bekommt kein Server zu sehen, auch nicht Relayiums eigener Signaling-Server, der den Geräten nur hilft, einander zu finden. Mit eingeschalteter erweiterter Verifizierung zeigen beide Bildschirme zusätzlich einen kurzen Verifizierungscode (SAS), der dich visuell bestätigen lässt, dass die Verbindung wirklich zwischen deinen beiden Geräten besteht, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, damit du weißt, dass sie byte-genau angekommen ist.",
      ],
    },
    browserCrossNetworkSection.de,
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Brauche ich ein Konto, um Dateien im selben WLAN zu senden?",
        a: "Nein. Übertragungen im selben Netz brauchen auf keiner Seite ein Konto oder einen Pairing-Code — öffne einfach relayium.com auf jedem Gerät.",
      },
      {
        q: "Woher weiß Relayium, welche Geräte in meinem Netzwerk sind?",
        a: "Geräte, die sich mit demselben Netzwerk verbinden, teilen sich in der Regel dieselbe öffentliche IP-Adresse, und Relayium gruppiert Geräte mit übereinstimmender öffentlicher IP automatisch in denselben Raum, ganz ohne Code.",
      },
      {
        q: "Können mehr als zwei Geräte einander gleichzeitig sehen?",
        a: "Ja — im Raum steht jedes Gerät, das relayium.com aus diesem Netz öffnet, also Handy, Laptop und Desktop nebeneinander. Eine Übertragung selbst läuft eins zu eins: Du öffnest mit einem der gelisteten Geräte einen Arbeitsbereich, und dorthin gehen die Dateien. Mit mehreren Personen im selben Raum teilst du, indem du nacheinander mit jeder einen Arbeitsbereich öffnest.",
      },
      {
        q: "Ist die Übertragung immer noch verschlüsselt, wenn sie mein Netz nie verlässt?",
        a: "Ja. Jede Übertragung im selben Netz nutzt denselben X25519-Schlüsselaustausch und dieselbe AES-256-GCM-Verschlüsselung wie eine netzübergreifende, mit einem Verifizierungscode, den du selbst kontrollieren kannst, und einer SHA-256-Integritätsprüfung pro Datei.",
      },
      {
        q: "Was, wenn ein Gerät im WLAN und das andere im Mobilfunknetz ist?",
        a: "Dann sind sie nicht im selben Netz, und die automatische Erkennung verbindet sie nicht. Nutze stattdessen einen Pairing-Code — der Absender meldet sich an, um ihn zu erstellen, und der Empfänger braucht kein Konto. Über Netzwerkgrenzen hinweg läuft die Übertragung nicht direkt, sondern über ein verschlüsseltes TURN-Relay, bleibt dabei aber durchgehend Ende-zu-Ende-verschlüsselt: Das Relay leitet nur Chiffretext weiter und kann die Datei nicht lesen.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf zwei (oder mehr) beliebigen Geräten im selben WLAN und sende deine erste Datei — kein Konto, kein Code nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer des fichiers entre appareils sur le même Wi-Fi",
  description:
    "Comment envoyer des fichiers entre n'importe quels appareils sur le même Wi-Fi ou réseau local — sans compte, sans code d'appairage, ouvrez simplement relayium.com sur les deux et transférez directement, chiffré de bout en bout.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Si deux appareils ou plus sont sur le même Wi-Fi ou réseau local, envoyer un fichier entre eux ne devrait exiger ni compte, ni code, ni détour par le cloud. Relayium détecte quand des appareils partagent un réseau et les laisse se connecter directement, dans le navigateur, sans rien à créer nulle part.",
    "Ce guide couvre le cas générique du même réseau — n'importe quels appareils, n'importe quels systèmes d'exploitation, même plus de deux à la fois. Si vous avez en tête une paire d'appareils précise, consultez les guides dédiés pour PC vers téléphone, Mac vers Windows, ou un flux façon AirDrop pour Windows/Linux/Android, liés à la fin.",
  ],
  sections: [
    {
      heading: "Comment fonctionne la détection du même réseau",
      body: [
        "Relayium ne vous demande rien à saisir pour trouver les appareils à proximité. Quand votre navigateur ouvre relayium.com sans code d'appairage, le serveur vous place dans une salle basée sur le réseau depuis lequel vous vous connectez — en pratique, les appareils qui partagent la même adresse IP publique (le même Wi-Fi à la maison, au bureau, sur un campus, ou le même point d'accès mobile) atterrissent automatiquement dans la même salle.",
        "Cette salle n'est pas limitée à deux participants : elle contient autant d'appareils qu'il y en a à ouvrir le site depuis ce réseau, si bien qu'un bureau entier d'ordinateurs portables ou une salle de classe de téléphones peuvent tous se voir en même temps, pas seulement une paire.",
      ],
    },
    {
      heading: "Étape par étape",
      prereqs: {
        label: "Avant de commencer",
        items: [
          "Tous les appareils sur le même Wi-Fi ou réseau local, et un routeur qui ne sépare pas ses clients. Le nom du réglage à chercher figure dans l'indication de Relayium sous la liste des appareils : « l'isolation AP / isolation des clients ».",
          "Un navigateur récent sur chaque appareil (Chrome, Edge, Firefox ou Safari), avec la page ouverte via https://relayium.com/. Le transfert chiffré exige HTTPS, et en simple http:// la page le dit au lieu de lister des appareils.",
          "Aucun compte et aucun code d'appairage. La détection sur le même réseau ne demande ni l'un ni l'autre, d'aucun côté, donc il n'y a rien à configurer avant le premier transfert.",
          "De la place pour les fichiers sur l'appareil qui reçoit. Où ils atterrissent relève du navigateur qui reçoit et de son système, pas de Relayium : Chrome et Edge sur un ordinateur peuvent demander où enregistrer, les autres navigateurs écrivent dans leur propre dossier de téléchargements. Où ils ont réellement atterri se vérifie dans la liste de téléchargements de ce navigateur — chrome://downloads dans Chrome, edge://downloads dans Edge, about:downloads dans Firefox.",
        ],
      },
      body: [
        "Tout le flux se déroule dans le navigateur — rien à installer sur aucun appareil.",
      ],
      steps: [
        {
          text: "Connectez chaque appareil que vous voulez utiliser au même Wi-Fi ou réseau local, puis ouvrez la page de transfert sur chacun d'eux.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Lisez la ligne d'état sous le titre sur les deux appareils et comparez l'IP publique qui y figure. C'est une adresse commune qui place deux appareils dans la même salle : deux adresses différentes signifient deux réseaux, quel que soit le nom du Wi-Fi.",
          code: ["Connecté · cet appareil MacBook · IP publique 203.0.113.9"],
        },
        {
          text: "Regardez sous « Appareils à proximité ». Chaque appareil ayant ouvert la page depuis ce réseau y figure comme une carte portant son propre nom, sans rien à saisir ni à confirmer.",
        },
        {
          text: "Sur l'appareil qui envoie, cliquez sur la carte du destinataire et appuyez sur « Ouvrir l’espace de travail ». Sur un navigateur récent, c'est la seule action qu'une carte d'appareil à proximité propose : fichiers, dossiers et messages passent tous par l'unique connexion chiffrée qu'elle ouvre. La salle peut lister plusieurs appareils, et ouvrir l'espace de travail est justement ce qui choisit celui à qui ce transfert s'adresse. Pour la personne suivante, vous en ouvrez un autre.",
        },
        {
          text: "L'espace de travail remplace cette carte. L'état de la connexion se lit désormais dans son en-tête — avec quel appareil vous êtes connecté, l'état du lien et l'unique badge de chemin — et l'envoi se fait avec les commandes en dessous : « Envoyer des fichiers » pour un lot, « Envoyer un dossier » pour toute une arborescence lorsque le navigateur propose la sélection de dossier, ou tapez dans le champ de message et appuyez sur « Envoyer ». Un lot de fichiers transporte jusqu'à 1 000 fichiers.",
        },
        {
          text: "Sur l'appareil qui reçoit, la demande arrive avec le nombre de fichiers et la taille totale, et la ligne en dessous indique ce que fera « Accepter » : soit le navigateur demande où enregistrer, soit les fichiers vont dans son dossier de téléchargements. « Accepter » lance le transfert.",
        },
        {
          text: "Regardez le compteur de fichiers atteindre le dernier fichier sur les deux écrans. Pour comparer un code de vérification (SAS) avant le moindre octet, activez d'abord « Vérification avancée » sur les deux appareils : elle est désactivée par défaut, et ce qu'elle ajoute est une comparaison et une étape d'acceptation, pas le chiffrement — le transfert est chiffré dans les deux cas.",
        },
      ],
      success: {
        label: "À quoi ressemble un transfert qui marche",
        body: [
          "À ce moment-là la carte de l'autre appareil a disparu — l'espace de travail a pris sa place. L'état se lit dans son en-tête : l'appareil auquel vous êtes connecté, un état de lien « Connecté » et un unique badge de chemin indiquant « LAN direct », un saut d'hôte à hôte sur votre propre réseau. « P2P direct » est le second cas honnête : les deux appareils partageaient bien une IP publique, mais le saut retenu par les navigateurs n'était pas local.",
          "Du côté qui reçoit, le compteur s'arrête sur le dernier fichier, et le fichier lui-même se trouve là où la ligne d'enregistrement l'annonçait. C'est la liste de téléchargements du navigateur qui reçoit qui le confirme, pas cette page — chrome://downloads dans Chrome, edge://downloads dans Edge, about:downloads dans Firefox.",
        ],
        code: ["Connecté à MacBook · Connecté · LAN direct\nFichier 3/3"],
      },
      bullets: [
        "Une salle du même réseau n'est pas limitée à deux appareils : une carte par téléphone et par portable présent dans la pièce est normale, et non le signe d'un problème.",
        "Rien n'est ici téléversé d'abord puis téléchargé ensuite, donc aucune copie ne dort sur un serveur pour plus tard — les deux appareils restent sur la page jusqu'à la fin du compteur.",
      ],
    },
    {
      heading: "Quand les appareils ne se voient pas",
      body: [
        "La détection sur le même réseau s'appuie sur le réseau depuis lequel le navigateur se connecte, c'est donc là qu'il faut regarder d'abord : les deux appareils ne sont pas vraiment sur un même réseau, le routeur garde ses clients séparés, la page n'a pas été ouverte en HTTPS, ou le navigateur qui reçoit doit retenir plus qu'il ne peut. Ce sont des vérifications courantes à faire en premier, pas la liste complète, et chacune laisse à l'écran de quoi la trancher.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "« Appareils à proximité » reste vide, ou ne liste que l'appareil que vous regardez.",
            code: ["https://relayium.com/   # ouvrez-la sur les deux, puis comparez l'IP publique de la ligne d'état"],
            fix: "Deux adresses IP publiques différentes, ce sont deux salles distinctes. Un VPN, iCloud Private Relay ou un SSID invité qui fait sortir ses clients par une autre adresse sont des causes fréquentes, et pas les seules. Si vous acceptez de les modifier : coupez le VPN, ou désactivez Private Relay pour ce seul réseau Wi-Fi, ou ramenez les deux appareils sur le réseau principal, puis rechargez https://relayium.com/ sur chacun. Si vous préférez les laisser en place, un code d'appairage sur https://relayium.com/cross-network atteint l'autre appareil sans toucher à l'un ni à l'autre, et reste chiffré de bout en bout.",
          },
          {
            symptom: "Les deux appareils affichent la même IP publique et aucune carte n'apparaît malgré tout.",
            code: ["https://relayium.com/   # l'indication sous la liste des appareils nomme le réglage du routeur"],
            fix: "Le routeur sépare ses propres clients. Désactivez « l'isolation AP / isolation des clients » dans ses réglages Wi-Fi — les systèmes mesh et les réseaux d'hôtel ou invité le livrent souvent actif — puis rechargez la page sur les deux appareils. Quand le routeur ne vous appartient pas, un code d'appairage sur https://relayium.com/cross-network est la voie de secours.",
          },
          {
            symptom: "La page indique que le transfert chiffré nécessite HTTPS, et aucune liste d'appareils n'apparaît.",
            code: ["https://relayium.com/   # la barre d'adresse doit afficher https, pas http"],
            fix: "La page a été ouverte en http:// ou par adresse IP brute, et le navigateur retient alors les API nécessaires à un transfert chiffré. relayium.com redirige lui-même vers HTTPS, donc cela désigne d'ordinaire une instance auto-hébergée jointe en http:// — ouvrez-la comme https://relayium.com/, ou donnez un certificat à votre propre instance.",
          },
          {
            symptom: "Avant l'acceptation, l'appareil qui reçoit avertit qu'il doit garder tout le lot en mémoire.",
            code: ["chrome://downloads   # dans Chrome ; Edge a edge://downloads et Firefox about:downloads"],
            fix: "Ce navigateur ne sait pas écrire un téléchargement directement sur le disque, il met donc le lot en tampon, et un gros lot peut finir sur un onglet planté. Recevez-le dans Chrome ou Edge sur un ordinateur, ou envoyez moins de fichiers à la fois, et contrôlez chaque arrivée dans la liste de téléchargements du navigateur qui reçoit — chrome://downloads dans Chrome, edge://downloads dans Edge, about:downloads dans Firefox — au lieu de supposer l'enregistrement.",
          },
          {
            symptom: "Le transfert fonctionne, mais le badge indique « P2P direct » au lieu de « LAN direct ».",
            code: ["https://relayium.com/   # lisez le badge de chemin dans l'en-tête de l'espace de travail"],
            fix: "Les deux appareils partagent une IP publique sans partager de saut local — NAT d'opérateur, deux VLAN derrière un même lien montant, ou un répéteur en mode client produisent tous cet effet. Le transfert reste direct et reste chiffré de bout en bout : branchez les deux appareils sur le même point d'accès si vous voulez que le chemin soit votre LAN plutôt que la route trouvée par les navigateurs.",
          },
        ],
      },
    },
    {
      heading: "Pourquoi c'est rapide : aucun serveur au milieu",
      body: [
        "Les deux appareils se connectent depuis le même réseau, alors Relayium les relie en pair-à-pair — les octets vont d'un appareil à l'autre sans aller-retour par un serveur Relayium, sans rien à téléverser d'abord ni aucun téléchargement à attendre ensuite ; la rapidité dépend du saut que les deux navigateurs ont réellement retenu, et c'est le badge de chemin qui le nomme. « LAN direct » est le saut local, celui où les données ne quittent pas votre réseau et avancent à sa vitesse plutôt qu'à celle de votre connexion internet. « P2P direct » reste tout aussi direct, toujours sans serveur au milieu, mais la route trouvée par les navigateurs a quitté le segment local, elle est donc bornée par la liaison qu'elle traverse vraiment. Une IP publique commune place deux appareils dans la même salle, elle ne promet pas à elle seule que le saut entre eux soit local.",
        "C'est aussi pourquoi aucun compte n'intervient d'aucun côté : tout le monde étant déjà sur le même réseau de confiance, Relayium n'a pas besoin d'une connexion pour savoir qui peut se connecter à qui.",
      ],
    },
    {
      heading: "Toujours chiffré de bout en bout",
      body: [
        "Être sur le même réseau ne veut pas dire que le transfert circule en clair. Relayium négocie un échange de clés X25519 entre les deux appareils et chiffre chaque bloc avec AES-256-GCM ; cette clé n'est jamais vue par aucun serveur, y compris le propre serveur de signalisation de Relayium, qui aide seulement les appareils à se trouver. Avec la vérification avancée activée, les deux écrans affichent en plus un code de vérification court (SAS) qui vous permet de confirmer visuellement que la connexion est bien entre vos deux appareils, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256, pour savoir qu'il est arrivé intact, octet pour octet.",
      ],
    },
    browserCrossNetworkSection.fr,
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Ai-je besoin d'un compte pour envoyer des fichiers sur le même Wi-Fi ?",
        a: "Non. Les transferts sur le même réseau ne nécessitent ni compte ni code d'appairage d'aucun côté — ouvrez simplement relayium.com sur chaque appareil.",
      },
      {
        q: "Comment Relayium sait-il quels appareils sont sur mon réseau ?",
        a: "Les appareils connectés au même réseau partagent généralement la même adresse IP publique, et Relayium regroupe automatiquement les appareils dont l'IP publique correspond dans la même salle, sans code requis.",
      },
      {
        q: "Plus de deux appareils peuvent-ils se voir en même temps ?",
        a: "Oui. Les salles du même réseau ne sont pas limitées à une paire : tout appareil qui ouvre relayium.com depuis ce réseau y apparaît, téléphone, portable et ordinateur de bureau côte à côte. Un transfert, lui, va d'un appareil à un seul autre. Vous ouvrez un espace de travail avec l'un des appareils listés, et c'est à lui que les fichiers arrivent. Pour partager avec plusieurs personnes dans la même pièce, vous ouvrez un espace de travail avec chacune à son tour.",
      },
      {
        q: "Le transfert est-il quand même chiffré s'il ne quitte jamais mon réseau ?",
        a: "Oui. Chaque transfert sur le même réseau utilise le même échange de clés X25519 et le même chiffrement AES-256-GCM qu'un transfert entre réseaux différents, avec un code de vérification que vous pouvez contrôler vous-même et une vérification d'intégrité SHA-256 par fichier.",
      },
      {
        q: "Et si un appareil est en Wi-Fi et l'autre en données mobiles ?",
        a: "Ils ne sont alors pas sur le même réseau, et la découverte automatique ne les connectera pas. Utilisez plutôt un code d'appairage — l'expéditeur se connecte pour le créer, et le destinataire n'a pas besoin de compte. Entre réseaux différents, le transfert passe par un relais TURN chiffré plutôt que par une connexion directe, tout en restant chiffré de bout en bout : le relais ne transmet que du texte chiffré et ne peut pas lire le fichier.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur deux appareils (ou plus) sur le même Wi-Fi et envoyez votre premier fichier — sans compte, sans code nécessaire.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال الملفات بين الأجهزة على نفس شبكة Wi-Fi",
  description:
    "كيفية إرسال الملفات بين أي أجهزة على نفس شبكة Wi-Fi أو الشبكة المحلية — دون حساب، دون رمز اقتران، فقط افتح relayium.com على كليهما وانقُل مباشرةً، مشفَّرًا من الطرف إلى الطرف.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إذا كان جهازان أو أكثر على نفس شبكة Wi-Fi أو الشبكة المحلية، فإن إرسال ملف بينها لا ينبغي أن يتطلب حسابًا، أو رمزًا، أو مرورًا عبر السحابة. يكتشف Relayium متى تتشارك الأجهزة شبكةً ويتيح لها الاتصال مباشرةً، داخل المتصفح، دون أي تسجيل.",
    "يغطّي هذا الدليل الحالة العامة لنفس الشبكة — أي أجهزة، وأي أنظمة تشغيل، بل وأكثر من جهازين في آنٍ واحد. وإن كان لديك زوج أجهزة محدد في ذهنك، فراجع الأدلة المخصصة للحاسوب إلى الهاتف، أو Mac إلى Windows، أو مسار نقل بأسلوب AirDrop لـ Windows/Linux/Android، المرتبطة في النهاية.",
  ],
  sections: [
    {
      heading: "كيف يعمل اكتشاف نفس الشبكة",
      body: [
        "لا يطلب منك Relayium كتابة أي شيء للعثور على الأجهزة القريبة. عندما يفتح متصفحك relayium.com دون رمز اقتران، يضعك الخادم في غرفة بناءً على الشبكة التي تتصل منها — عمليًا، تدخل الأجهزة التي تتشارك نفس عنوان IP العام (نفس شبكة Wi-Fi في المنزل أو المكتب أو الحرم الجامعي، أو نفس نقطة اتصال الجوال) في نفس الغرفة تلقائيًا.",
        "هذه الغرفة ليست محدودة بمشاركَين اثنين: فهي تسع مهما بلغ عدد الأجهزة التي تفتح الموقع من تلك الشبكة، حتى يستطيع مكتب كامل من الحواسيب المحمولة أو صف دراسي من الهواتف رؤية بعضها في آنٍ واحد، لا مجرد زوج واحد.",
      ],
    },
    {
      heading: "خطوة بخطوة",
      prereqs: {
        label: "قبل أن تبدأ",
        items: [
          "كل الأجهزة على نفس شبكة Wi-Fi أو الشبكة المحلية، والموجّه لا يفصل عملاءه عن بعضهم. اسم الإعداد الذي تبحث عنه مكتوب في تلميح Relayium نفسه أسفل قائمة الأجهزة: «عزل نقطة الوصول / عزل العملاء».",
          "متصفح حديث على كل جهاز (Chrome أو Edge أو Firefox أو Safari)، والصفحة مفتوحة عبر https://relayium.com/. يحتاج النقل المشفَّر إلى HTTPS، وعند فتحها عبر http:// المجرّد تقول الصفحة ذلك بالضبط بدل أن تسرد الأجهزة.",
          "لا حساب ولا رمز اقتران. لا يطلب اكتشاف نفس الشبكة أيًّا منهما على أي من الجانبين، فليس هناك ما تهيّئه قبل أول عملية نقل.",
          "مكان تحلّ فيه الملفات على الجهاز المستلم. تحديد ذلك المكان يعود إلى المتصفح المستلم ونظام تشغيله لا إلى Relayium: يستطيع Chrome وEdge على الحاسوب أن يسألاك عن مكان الحفظ، أما المتصفحات الأخرى فتكتب في مجلد التنزيلات الخاص بها. وأين حلّت فعلًا تتأكد منه في قائمة تنزيلات ذلك المتصفح — chrome://downloads في Chrome، edge://downloads في Edge، about:downloads في Firefox.",
        ],
      },
      body: [
        "يجري مسار النقل كله في المتصفح — لا تطبيق لتثبيته على أي جهاز.",
      ],
      steps: [
        {
          text: "اربط كل جهاز تريد استخدامه بنفس شبكة Wi-Fi أو الشبكة المحلية، ثم افتح صفحة النقل على كل واحد منها.",
          code: ["https://relayium.com/"],
        },
        {
          text: "اقرأ شريط الحالة أسفل العنوان على الجهازين وقارن عنوان IP العام الظاهر فيه. وجود عنوان واحد مشترك هو ما يضع جهازين في غرفة واحدة، أما اختلاف العنوانين فيعني شبكتين مختلفتين مهما كان اسم شبكة Wi-Fi.",
          code: ["متصل · هذا الجهاز MacBook · عنوان IP العام 203.0.113.9"],
        },
        {
          text: "انظر تحت «الأجهزة القريبة». كل جهاز فتح الصفحة من تلك الشبكة يظهر هناك كبطاقة تحمل اسمه — لا شيء تكتبه ولا شيء تؤكّده.",
        },
        {
          text: "على الجهاز المُرسِل، انقر بطاقة المستلم ثم اضغط «فتح مساحة العمل». في المتصفحات الحديثة هذا هو الإجراء الوحيد الذي تعرضه بطاقة الجهاز القريب، لأن الملفات والمجلدات والرسائل تمرّ كلها عبر الاتصال المشفَّر الواحد الذي تفتحه. وقد تسرد الغرفة أجهزة عدة، وفتح مساحة العمل هو بالضبط ما يحدّد إلى أيّها يذهب هذا النقل؛ وللشخص التالي تفتح مساحة عمل أخرى.",
        },
        {
          text: "تحلّ مساحة العمل محلّ تلك البطاقة. ومن هنا فصاعدًا تُقرأ حالة الاتصال من ترويسة مساحة العمل — بأي جهاز أنت متصل، وحالة الوصلة، ووسم المسار الوحيد — أما الإرسال فمن الأدوات التي تحتها: «إرسال ملفات» لدفعة، و«إرسال مجلد» لشجرة كاملة حين يتيح المتصفح اختيار المجلدات، أو اكتب في حقل الرسالة واضغط «إرسال». تحمل الدفعة الواحدة حتى 1,000 ملف.",
        },
        {
          text: "يصل الطلب إلى الجهاز المستلم مصحوبًا بعدد الملفات وحجمها الإجمالي، ويقول السطر الذي تحته ماذا سيحدث عند الضغط على «قبول»: إما أن يسألك المتصفح عن مكان الحفظ، وإما أن تذهب الملفات إلى مجلد التنزيلات الخاص به. الضغط على «قبول» يبدأ النقل.",
        },
        {
          text: "راقب عدّاد الملفات حتى يبلغ الملف الأخير على الشاشتين. وإذا أردت مقارنة رمز التحقق (SAS) قبل أن يتحرك أي بايت، فعّل «التحقّق المتقدّم» على الجهازين أولًا: هو معطَّل افتراضيًا، وما يضيفه تفعيله هو مقارنة وخطوة موافقة، لا التشفير — فالنقل مشفَّر في الحالتين.",
        },
      ],
      success: {
        label: "كيف يبدو نقل ناجح",
        body: [
          "تكون بطاقة الجهاز الآخر قد اختفت عندئذ — إذ حلّت مساحة العمل محلّها. وتُقرأ الحالة من ترويسة مساحة العمل: بأي جهاز أنت متصل، وحالة وصلة تقول «متصل»، ووسم مسار وحيد يقرأ «مباشر عبر LAN» — أي قفزة من مضيف إلى مضيف داخل شبكتك أنت. و«مباشر P2P» هي الحالة الثانية الصادقة: الجهازان تشاركا فعلًا عنوان IP عامًا واحدًا، لكن القفزة التي استقر عليها المتصفحان لم تكن محلية.",
          "على الجانب المستلم يتوقف العدّاد عند الملف الأخير، ويكون الملف نفسه في المكان الذي ذكره سطر الحفظ. والمكان الذي تتأكد فيه من ذلك هو قائمة تنزيلات المتصفح المستلم نفسه، لا هذه الصفحة — chrome://downloads في Chrome، edge://downloads في Edge، about:downloads في Firefox.",
        ],
        code: ["متصل بـ MacBook · متصل · مباشر عبر LAN\nالملف 3/3"],
      },
      bullets: [
        "غرفة نفس الشبكة ليست محدودة بجهازين، فظهور بطاقة لكل هاتف وحاسوب محمول في الغرفة أمر طبيعي وليس علامة على خطأ.",
        "لا شيء هنا يُرفع أولًا ثم يُنزَّل بعد ذلك، فلا توجد نسخة على خادم تُجلب لاحقًا — يبقى الجهازان على الصفحة حتى ينتهي العدّاد.",
      ],
    },
    {
      heading: "عندما لا يرى الجهازان أحدهما الآخر",
      body: [
        "يعتمد اكتشاف نفس الشبكة على الشبكة التي يتصل منها متصفحك، ومن هناك تبدأ: الجهازان ليسا فعلًا على شبكة واحدة، أو الموجّه يفصل عملاءه، أو الصفحة لم تُفتح عبر HTTPS، أو يُطلب من متصفح الاستقبال أن يحمل أكثر مما يستطيع. وهذه فحوص أولى شائعة لا قائمة كاملة بالأسباب، ولكل واحدة منها ما يحسمها على الشاشة.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "تبقى «الأجهزة القريبة» فارغة، أو لا تسرد سوى الجهاز الذي تنظر إليه.",
            code: ["https://relayium.com/   # افتحها على الجهازين ثم قارن عنوان IP العام في شريط الحالة"],
            fix: "عنوانا IP عامان مختلفان يعنيان غرفتين منفصلتين. ومن الأسباب المعتادة لذلك VPN، أو ميزة الترحيل الخاص في iCloud، أو شبكة ضيوف تُخرِج عملاءها من عنوان آخر، وليست وحدها. فإن كنت مستعدًا لتغييرها: أوقف VPN، أو أوقف الترحيل الخاص لشبكة Wi-Fi هذه وحدها، أو انقل الجهازين إلى الشبكة الرئيسية، ثم أعِد تحميل https://relayium.com/ على كل منهما. وإن فضّلت إبقاءها كما هي، فرمز الاقتران على https://relayium.com/cross-network يصل إلى الجهاز الآخر دون المساس بأي من الإعدادين، وهو مشفَّر من الطرف إلى الطرف بالقدر نفسه.",
          },
          {
            symptom: "يعرض الجهازان نفس عنوان IP العام ومع ذلك لا تظهر أي بطاقة.",
            code: ["https://relayium.com/   # التلميح أسفل قائمة الأجهزة يسمّي إعداد الموجّه"],
            fix: "الموجّه يفصل عملاءه عن بعضهم. أوقف «عزل نقطة الوصول / عزل العملاء» في إعدادات Wi-Fi لديه — كثيرًا ما تأتي أنظمة Mesh وشبكات الفنادق والضيوف وهي مفعَّلة — ثم أعِد تحميل الصفحة على الجهازين. وإن لم يكن الموجّه تحت يدك، فرمز الاقتران على https://relayium.com/cross-network هو الطريق البديل.",
          },
          {
            symptom: "تقول الصفحة إن النقل المشفَّر يتطلب HTTPS، ولا تظهر قائمة أجهزة إطلاقًا.",
            code: ["https://relayium.com/   # يجب أن يقرأ شريط العنوان https لا http"],
            fix: "فُتحت الصفحة عبر http:// أو بعنوان IP مجرّد، فيحجب المتصفح واجهات البرمجة التي يحتاجها النقل المشفَّر. وموقع relayium.com نفسه يعيد التوجيه إلى HTTPS، لذا يعني هذا عادةً نسخة مستضافة ذاتيًا يجري الوصول إليها عبر http:// — افتحها بصيغة https://relayium.com/، أو زوِّد نسختك بشهادة.",
          },
          {
            symptom: "قبل أن تضغط قبول، يحذّر الجهاز المستلم من أنه سيحمل الدفعة كلها في الذاكرة.",
            code: ["chrome://downloads   # في Chrome / edge://downloads في Edge / about:downloads في Firefox"],
            fix: "ذلك المتصفح لا يستطيع بثّ التنزيل إلى القرص مباشرةً، فيخزّن الدفعة مؤقتًا، وقد تنتهي الدفعة الكبيرة بانهيار التبويب. استقبلها في Chrome أو Edge على حاسوب، أو أرسِل ملفات أقل في المرة الواحدة، وتحقّق من كل وصول في قائمة تنزيلات المتصفح المستلم نفسه — chrome://downloads في Chrome، edge://downloads في Edge، about:downloads في Firefox — بدلًا من افتراض أنها حُفظت.",
          },
          {
            symptom: "النقل يعمل، لكن الوسم يقرأ «مباشر P2P» بدل «مباشر عبر LAN».",
            code: ["https://relayium.com/   # اقرأ وسم المسار في ترويسة مساحة العمل"],
            fix: "الجهازان يتشاركان عنوان IP عامًا دون أن يتشاركا قفزة محلية — وتفعل ذلك شبكات NAT على مستوى المشغّل، أو شبكتان افتراضيتان خلف وصلة صاعدة واحدة، أو مُوسِّع نطاق يعمل في وضع العميل. يبقى النقل مباشرًا ويبقى مشفَّرًا من الطرف إلى الطرف، وإن أردت أن يكون المسار شبكتك المحلية لا الطريق الذي وجده المتصفحان، فاربط الجهازين بنفس نقطة الوصول.",
          },
        ],
      },
    },
    {
      heading: "لماذا هو سريع: لا خادم في المنتصف",
      body: [
        "يتصل الجهازان من الشبكة نفسها، فيربطهما Relayium من الند للند: تنتقل البايتات من جهاز إلى آخر دون رحلة ذهاب وإياب إلى خادم Relayium، فلا شيء يُرفع أولًا ولا تنزيل يُنتظَر بعد ذلك. أما مقدار السرعة فيتوقف على القفزة التي استقر عليها المتصفحان فعلًا، ووسم المسار هو ما يسمّيها. «مباشر عبر LAN» هي القفزة المحلية: تبقى البيانات داخل شبكتك أنت وتسير بسرعتها هي، لا بسرعة اشتراك الإنترنت لديك. و«مباشر P2P» مباشر مثله ولا خادم في منتصفه كذلك، غير أن المسار الذي وجده المتصفحان قد غادر المقطع المحلي، فتحدّه الوصلة التي يعبرها فعلًا. واشتراك الجهازين في عنوان IP عام واحد يضعهما في الغرفة نفسها، لكنه وحده لا يَعِد بأن القفزة بينهما محلية.",
        "وهذا أيضًا سبب عدم إشراك أي حساب على أي جانب: فما دام الجميع على نفس الشبكة الموثوقة، لا يحتاج Relayium إلى تسجيل الدخول ليعرف مَن يُسمح له بالاتصال بمَن.",
      ],
    },
    {
      heading: "ما يزال مشفَّرًا من الطرف إلى الطرف",
      body: [
        "الوجود على نفس الشبكة لا يعني أن النقل يُرسَل بنص صريح. يتفاوض Relayium على تبادل مفاتيح X25519 بين الجهازين ويشفّر كل جزء بـ AES-256-GCM؛ ولا يرى هذا المفتاح أي خادم، بما في ذلك خادم الإشارة الخاص بـ Relayium نفسه، الذي لا يفعل سوى مساعدة الجهازين على العثور على بعضهما. وعند تفعيل التحقّق المتقدّم تعرض الشاشتان أيضًا رمز تحقق قصيرًا (SAS) يتيح لك أن تؤكّد بصريًا أن الاتصال قائم حقًا بين جهازيك، ويُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256 لتعلم أنه وصل سليمًا بايتًا ببايت.",
      ],
    },
    browserCrossNetworkSection.ar,
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى حساب لإرسال الملفات على نفس شبكة Wi-Fi؟",
        a: "لا. لا تحتاج عمليات النقل على نفس الشبكة إلى حساب ولا رمز اقتران على أي من الجانبين — فقط افتح relayium.com على كل جهاز.",
      },
      {
        q: "كيف يعرف Relayium أي الأجهزة على شبكتي؟",
        a: "تتشارك الأجهزة التي تتصل من نفس الشبكة عادةً نفس عنوان IP العام، ويجمع Relayium الأجهزة ذات عنوان IP العام المتطابق في نفس الغرفة تلقائيًا، دون الحاجة إلى أي رمز.",
      },
      {
        q: "هل يمكن لأكثر من جهازين رؤية بعضها في آنٍ واحد؟",
        a: "نعم. كل جهاز يفتح relayium.com من تلك الشبكة يظهر في الغرفة، فيصطف الهاتف والحاسوب المحمول والمكتبي جنبًا إلى جنب. أما النقل نفسه فمن جهاز إلى جهاز واحد: تفتح مساحة عمل مع أحد الأجهزة المسرودة، وإليه تذهب الملفات. وللمشاركة مع عدة أشخاص في الغرفة نفسها، تفتح مساحة عمل مع كل واحد منهم بدوره.",
      },
      {
        q: "هل يبقى النقل مشفَّرًا إن لم يغادر شبكتي أبدًا؟",
        a: "نعم. يستخدم كل نقل على نفس الشبكة نفس تبادل مفاتيح X25519 وتشفير AES-256-GCM المستخدَمَين في النقل عبر الشبكات، مع رمز تحقق يمكنك التأكد منه بنفسك وفحص سلامة SHA-256 لكل ملف.",
      },
      {
        q: "ماذا لو كان جهاز على Wi-Fi والآخر على بيانات الجوال؟",
        a: "عندئذ لا يكونان على نفس الشبكة، فلن يربطهما الاكتشاف التلقائي. استخدم رمز اقتران بدلًا من ذلك — يسجّل المُرسِل الدخول لإنشائه، ولا يحتاج المُستقبِل إلى حساب. وعبر الشبكات يمرّ النقل عبر مُرحِّل TURN مُشفَّر بدل الاتصال المباشر، لكنه يبقى مُشفَّرًا من الطرف إلى الطرف طوال الوقت: لا يُمرِّر المُرحِّل سوى نصّ مُشفَّر ولا يستطيع قراءة الملف.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على أي جهازين (أو أكثر) على نفس شبكة Wi-Fi وأرسِل أول ملف لك — دون حساب، دون رمز.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Enviar archivos entre dispositivos en la misma Wi-Fi",
  description:
    "Cómo enviar archivos entre cualquier dispositivo en la misma Wi-Fi o red local — sin cuenta, sin código de emparejamiento, solo abre relayium.com en ambos y transfiere directamente, cifrado de extremo a extremo.",
  updatedLabel: "Última actualización",
  lead: [
    "Si dos o más dispositivos están en la misma Wi-Fi o red local, enviar un archivo entre ellos no debería requerir una cuenta, un código ni un rodeo por la nube. Relayium detecta cuándo los dispositivos comparten una red y les permite conectarse directamente, en el navegador, sin nada que registrar.",
    "Esta guía cubre el caso genérico de la misma red — cualquier dispositivo, cualquier sistema operativo, incluso más de dos a la vez. Si tienes en mente una pareja de dispositivos concreta, consulta las guías dedicadas para PC a teléfono, Mac a Windows, o un flujo estilo AirDrop para Windows/Linux/Android, enlazadas al final.",
  ],
  sections: [
    {
      heading: "Cómo funciona la detección en la misma red",
      body: [
        "Relayium no te pide teclear nada para encontrar dispositivos cercanos. Cuando tu navegador abre relayium.com sin un código de emparejamiento, el servidor te coloca en una sala según la red desde la que te conectas — en la práctica, los dispositivos que comparten la misma dirección IP pública (la misma Wi-Fi de casa, la oficina o el campus, o el mismo punto de acceso móvil) van a parar automáticamente a la misma sala.",
        "Esa sala no está limitada a dos participantes: acoge tantos dispositivos como abran el sitio desde esa red, así que toda una mesa de portátiles o un aula de teléfonos pueden verse todos a la vez, no solo una única pareja.",
      ],
    },
    {
      heading: "Paso a paso",
      prereqs: {
        label: "Antes de empezar",
        items: [
          "Todos los dispositivos en la misma Wi-Fi o red local, y un router que no separe a sus clientes. El nombre del ajuste que hay que buscar está en la propia indicación de Relayium bajo la lista de dispositivos: «aislamiento de AP / aislamiento de clientes».",
          "Un navegador actual en cada dispositivo (Chrome, Edge, Firefox o Safari), con la página abierta mediante https://relayium.com/. La transferencia cifrada necesita HTTPS, y con http:// a secas la página dice justo eso en lugar de listar dispositivos.",
          "Ninguna cuenta y ningún código de emparejamiento. El descubrimiento en la misma red no pide ni una cosa ni la otra, en ninguno de los lados, así que no hay nada que configurar antes de la primera transferencia.",
          "Sitio donde dejar los archivos en el dispositivo que recibe. Cuál es ese sitio lo deciden el navegador que recibe y su sistema operativo, no Relayium: Chrome y Edge en un ordenador pueden preguntarte dónde guardar, y los demás navegadores escriben en su propia carpeta de descargas. Dónde han acabado lo confirmas en la lista de descargas de ese navegador — chrome://downloads en Chrome, edge://downloads en Edge, about:downloads en Firefox.",
        ],
      },
      body: [
        "Todo el proceso ocurre en el navegador — ninguna app que instalar en ningún dispositivo.",
      ],
      steps: [
        {
          text: "Conecta cada dispositivo que quieras usar a la misma Wi-Fi o red local y abre después la página de transferencia en cada uno.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Lee la línea de estado bajo el título en ambos dispositivos y compara la IP pública que aparece en ella. Una dirección compartida es lo que mete a dos dispositivos en la misma sala; dos direcciones distintas significan dos redes, se llame como se llame la Wi-Fi.",
          code: ["Conectado · este dispositivo MacBook · IP pública 203.0.113.9"],
        },
        {
          text: "Mira bajo «Dispositivos cercanos». Cada dispositivo que haya abierto la página desde esa red figura ahí como una tarjeta con su propio nombre, sin nada que teclear ni confirmar.",
        },
        {
          text: "En el dispositivo que envía, pulsa la tarjeta de quien recibe y luego «Abrir espacio de trabajo». En un navegador actual esa es la única acción que ofrece una tarjeta de dispositivo cercano, porque archivos, carpetas y mensajes viajan todos por la única conexión cifrada que abre. La sala puede listar varios dispositivos, y abrir el espacio de trabajo es justo lo que elige a cuál va esta transferencia; para la siguiente persona abres otro.",
        },
        {
          text: "El espacio de trabajo sustituye a esa tarjeta. Desde ahí el estado de la conexión se lee en su cabecera — con qué dispositivo estás conectado, el estado del enlace y la única etiqueta de ruta — y para enviar están los controles de debajo: «Enviar archivos» para un lote, «Enviar una carpeta» para un árbol entero cuando el navegador ofrece elegir carpetas, o escribe en el campo de mensaje y pulsa «Enviar». Un lote de archivos lleva hasta 1.000 archivos.",
        },
        {
          text: "En el dispositivo que recibe llega la solicitud con el número de archivos y el tamaño total, y la línea de debajo dice qué hará «Aceptar»: o el navegador pregunta dónde guardar, o los archivos van a su carpeta de descargas. Con «Aceptar» empieza.",
        },
        {
          text: "Observa cómo el contador de archivos llega al último en ambas pantallas. Para comparar un código de verificación (SAS) antes de que se mueva un solo byte, activa primero «Verificación avanzada» en los dos dispositivos: viene desactivada, y lo que añade es una comparación y un paso de aceptación, no el cifrado — la transferencia va cifrada en cualquier caso.",
        },
      ],
      success: {
        label: "Qué se ve cuando la transferencia funciona",
        body: [
          "Para entonces la tarjeta del otro dispositivo ya no está: el espacio de trabajo ocupó su lugar. El estado se lee en su cabecera: a qué dispositivo estás conectado, un estado de enlace «Conectado» y una única etiqueta de ruta que marca «Directo por LAN», un salto de host a host por tu propia red. «Directo P2P» es el segundo caso honesto: los dos dispositivos sí compartían una IP pública, pero el salto en el que se quedaron los navegadores no era local.",
          "En el lado que recibe, el contador se detiene en el último archivo y el archivo está donde la línea de guardado dijo. Eso se confirma en la lista de descargas del propio navegador que recibe, no en esta página — chrome://downloads en Chrome, edge://downloads en Edge, about:downloads en Firefox.",
        ],
        code: ["Conectado a MacBook · Conectado · Directo por LAN\nArchivo 3/3"],
      },
      bullets: [
        "Una sala de la misma red no se limita a dos dispositivos, así que una tarjeta por cada móvil y portátil de la habitación es lo normal y no una señal de que algo falle.",
        "Aquí nada se sube primero y se descarga después, de modo que no queda ninguna copia en un servidor para recoger más tarde: los dos dispositivos siguen en la página hasta que el contador termina.",
      ],
    },
    {
      heading: "Cuando los dispositivos no se ven",
      body: [
        "El descubrimiento en la misma red se guía por la red desde la que se conecta tu navegador, así que ahí es donde hay que mirar primero: los dos dispositivos no están realmente en una misma red, el router mantiene separados a sus clientes, la página no se abrió por HTTPS, o al navegador que recibe se le pide sostener más de lo que puede. Son las comprobaciones habituales para empezar y no la lista completa; cada una deja en pantalla algo que la decide.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "«Dispositivos cercanos» sigue vacío, o solo lista el dispositivo que estás mirando.",
            code: ["https://relayium.com/   # ábrela en los dos y compara la IP pública de la línea de estado"],
            fix: "Dos direcciones IP públicas distintas son dos salas separadas. Una VPN, iCloud Private Relay o un SSID de invitados que saca a sus clientes por otra dirección son causas frecuentes, y no las únicas. Si estás dispuesto a cambiarlos: apaga la VPN, o desactiva Private Relay solo para esa red Wi-Fi, o pasa los dos dispositivos a la red principal, y recarga después https://relayium.com/ en cada uno. Si prefieres dejarlos como están, un código de emparejamiento en https://relayium.com/cross-network llega al otro dispositivo sin tocar ninguno de los dos ajustes, y va igual de cifrado de extremo a extremo.",
          },
          {
            symptom: "Los dos dispositivos muestran la misma IP pública y aun así no aparece ninguna tarjeta.",
            code: ["https://relayium.com/   # la indicación bajo la lista de dispositivos nombra el ajuste del router"],
            fix: "El router separa a sus propios clientes. Desactiva «aislamiento de AP / aislamiento de clientes» en sus ajustes de Wi-Fi — los sistemas mesh y las redes de hotel o de invitados suelen traerlo activado — y recarga la página en los dos dispositivos. Cuando el router no es tuyo, la salida es un código de emparejamiento en https://relayium.com/cross-network.",
          },
          {
            symptom: "La página dice que la transferencia cifrada requiere HTTPS y no aparece ninguna lista de dispositivos.",
            code: ["https://relayium.com/   # la barra de direcciones tiene que decir https, no http"],
            fix: "La página se abrió por http:// o por dirección IP a secas, y entonces el navegador retiene las API que necesita una transferencia cifrada. relayium.com redirige por sí mismo a HTTPS, así que esto suele apuntar a una instancia autoalojada a la que se llega por http:// — ábrela como https://relayium.com/, o dale un certificado a tu propia instancia.",
          },
          {
            symptom: "Antes de aceptar, el dispositivo que recibe avisa de que tiene que sostener todo el lote en memoria.",
            code: ["chrome://downloads   # en Chrome; en Edge es edge://downloads y en Firefox about:downloads"],
            fix: "Ese navegador no sabe escribir una descarga directamente en el disco, así que almacena el lote entero y uno grande puede acabar en una pestaña caída. Recíbelo en Chrome o Edge en un ordenador, o manda menos archivos de una vez, y revisa cada llegada en la lista de descargas del propio navegador que recibe — chrome://downloads en Chrome, edge://downloads en Edge, about:downloads en Firefox — en vez de dar por hecho que se guardó.",
          },
          {
            symptom: "La transferencia funciona, pero la etiqueta marca «Directo P2P» en lugar de «Directo por LAN».",
            code: ["https://relayium.com/   # lee la etiqueta de ruta en la cabecera del espacio de trabajo"],
            fix: "Los dos dispositivos comparten una IP pública sin compartir un salto local: NAT de operador, dos VLAN detrás de un mismo enlace de subida o un repetidor en modo cliente producen ese efecto. La transferencia sigue siendo directa y sigue cifrada de extremo a extremo; conecta los dos dispositivos al mismo punto de acceso si quieres que la ruta sea tu LAN y no el camino que encontraron los navegadores.",
          },
        ],
      },
    },
    {
      heading: "Por qué es rápido: sin servidor en medio",
      body: [
        "Los dos dispositivos se conectan desde la misma red, así que Relayium los enlaza de igual a igual: los bytes van de uno al otro sin un viaje de ida y vuelta a un servidor de Relayium, sin nada que subir antes ni nada que esperar al descargar después. Lo rápido que sea depende del salto en el que se quedaron de verdad los dos navegadores, y la etiqueta de ruta es la que lo nombra. «Directo por LAN» es el salto local: los datos no salen de tu propia red y van a la velocidad de esa red, no a la de tu conexión a internet. «Directo P2P» es igual de directo y tampoco tiene servidor en medio, pero la ruta que encontraron los navegadores salió del segmento local, así que la limita el enlace que de verdad atraviesa. Compartir una IP pública es lo que mete a dos dispositivos en la misma sala; por sí solo no promete que el salto entre ellos sea local.",
        "Esta es también la razón por la que no interviene cuenta alguna en ningún lado: con todos ya en la misma red de confianza, Relayium no necesita inicio de sesión para saber quién debería poder conectarse con quién.",
      ],
    },
    {
      heading: "Sigue siendo cifrado de extremo a extremo",
      body: [
        "Estar en la misma red no significa que la transferencia se envíe en claro. Relayium negocia un intercambio de claves X25519 entre los dos dispositivos y cifra cada bloque con AES-256-GCM; esa clave nunca la ve ningún servidor, incluido el propio servidor de señalización de Relayium, que solo ayuda a los dispositivos a encontrarse. Con la verificación avanzada activada, ambas pantallas muestran además un código de verificación corto (SAS) que te permite confirmar visualmente que la conexión es realmente entre tus dos dispositivos, y cada archivo se comprueba de extremo a extremo con un hash SHA-256 para que sepas que llegó intacto byte a byte.",
      ],
    },
    browserCrossNetworkSection.es,
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito una cuenta para enviar archivos en la misma Wi-Fi?",
        a: "No. Las transferencias en la misma red no necesitan cuenta ni código de emparejamiento en ninguno de los lados — solo abre relayium.com en cada dispositivo.",
      },
      {
        q: "¿Cómo sabe Relayium qué dispositivos están en mi red?",
        a: "Los dispositivos que se conectan desde la misma red suelen compartir la misma dirección IP pública, y Relayium agrupa automáticamente en la misma sala los dispositivos con una IP pública coincidente, sin necesidad de código.",
      },
      {
        q: "¿Pueden verse más de dos dispositivos a la vez?",
        a: "Sí. Cada dispositivo que abra relayium.com desde esa red aparece en la sala, con el móvil, el portátil y el sobremesa uno al lado del otro. La transferencia en sí es de uno a uno: abres un espacio de trabajo con uno de los dispositivos listados y ahí es donde llegan los archivos. Para compartir con varias personas en la misma sala, abres un espacio de trabajo con cada una por turno.",
      },
      {
        q: "¿Sigue cifrada la transferencia aunque nunca salga de mi red?",
        a: "Sí. Cada transferencia en la misma red usa el mismo intercambio de claves X25519 y el mismo cifrado AES-256-GCM que una entre redes, con un código de verificación que puedes comprobar tú mismo y una comprobación de integridad SHA-256 por archivo.",
      },
      {
        q: "¿Y si un dispositivo está en Wi-Fi y el otro en datos móviles?",
        a: "No están en la misma red, así que el descubrimiento automático no los conectará. Usa en su lugar un código de emparejamiento — el remitente inicia sesión para crearlo y quien recibe no necesita cuenta. Entre redes distintas la transferencia va por un retransmisor TURN cifrado en vez de una conexión directa, pero sigue cifrada de extremo a extremo en todo momento: el retransmisor solo reenvía texto cifrado y no puede leer el archivo.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en dos (o más) dispositivos cualesquiera en la misma Wi-Fi y envía tu primer archivo — sin cuenta, sin código.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Enviar arquivos entre dispositivos na mesma rede Wi-Fi",
  description:
    "Como enviar arquivos entre quaisquer dispositivos na mesma rede Wi-Fi ou local — sem conta, sem código de emparelhamento, é só abrir relayium.com nos dois e transferir diretamente, criptografado de ponta a ponta.",
  updatedLabel: "Última atualização",
  lead: [
    "Se dois ou mais dispositivos estão na mesma rede Wi-Fi ou local, enviar um arquivo entre eles não deveria exigir uma conta, um código nem um desvio pela nuvem. O Relayium detecta quando os dispositivos compartilham uma rede e permite que se conectem diretamente, no navegador, sem nada para cadastrar.",
    "Este guia cobre o caso genérico da mesma rede — quaisquer dispositivos, quaisquer sistemas operacionais, até mais de dois ao mesmo tempo. Se você tem em mente um par de dispositivos específico, veja os guias dedicados para PC para celular, Mac para Windows, ou um fluxo no estilo AirDrop para Windows/Linux/Android, com links no fim.",
  ],
  sections: [
    {
      heading: "Como funciona a detecção na mesma rede",
      body: [
        "O Relayium não pede que você digite nada para encontrar dispositivos próximos. Quando seu navegador abre relayium.com sem um código de emparelhamento, o servidor coloca você em uma sala com base na rede pela qual você está se conectando — na prática, dispositivos que compartilham o mesmo endereço IP público (a mesma Wi-Fi de casa, do escritório ou do campus, ou o mesmo ponto de acesso móvel) vão parar automaticamente na mesma sala.",
        "Essa sala não é limitada a dois participantes: ela comporta quantos dispositivos abrirem o site a partir daquela rede, então uma mesa inteira de notebooks ou uma sala de aula de celulares podem se ver todos ao mesmo tempo, não apenas um único par.",
      ],
    },
    {
      heading: "Passo a passo",
      prereqs: {
        label: "Antes de começar",
        items: [
          "Todos os dispositivos na mesma Wi-Fi ou rede local, e um roteador que não separe os próprios clientes. O nome da configuração a procurar está na dica do próprio Relayium abaixo da lista de dispositivos: “isolamento de AP / isolamento de clientes”.",
          "Um navegador atual em cada dispositivo (Chrome, Edge, Firefox ou Safari), com a página aberta por https://relayium.com/. A transferência criptografada exige HTTPS, e em http:// puro a página diz exatamente isso em vez de listar dispositivos.",
          "Nenhuma conta e nenhum código de emparelhamento. A descoberta na mesma rede não pede nem uma coisa nem outra, em nenhum dos lados, então não há nada para configurar antes da primeira transferência.",
          "Lugar para os arquivos caírem no dispositivo que recebe. Qual lugar é esse cabe ao navegador que recebe e ao sistema dele, não ao Relayium: Chrome e Edge em um computador podem perguntar onde salvar, e os outros navegadores escrevem na própria pasta de downloads. Onde eles foram parar você confirma na lista de downloads desse navegador — chrome://downloads no Chrome, edge://downloads no Edge, about:downloads no Firefox.",
        ],
      },
      body: [
        "Todo o fluxo acontece no navegador — nenhum app para instalar em qualquer dispositivo.",
      ],
      steps: [
        {
          text: "Conecte cada dispositivo que você quer usar à mesma Wi-Fi ou rede local e depois abra a página de transferência em cada um deles.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Leia a linha de status abaixo do título nos dois dispositivos e compare o IP público que aparece nela. Um endereço em comum é o que coloca dois dispositivos na mesma sala; dois endereços diferentes significam duas redes, seja qual for o nome da Wi-Fi.",
          code: ["Conectado · este dispositivo MacBook · IP público 203.0.113.9"],
        },
        {
          text: "Olhe abaixo de “Dispositivos próximos”. Todo dispositivo que abriu a página a partir daquela rede aparece ali como um cartão com o próprio nome — nada para digitar, nada para confirmar.",
        },
        {
          text: "No dispositivo que envia, clique no cartão de quem recebe e aperte “Abrir área de trabalho”. Em um navegador atual essa é a única ação que um cartão de dispositivo próximo oferece, porque arquivos, pastas e mensagens passam todos pela única conexão criptografada que ela abre. A sala pode listar vários dispositivos, e abrir a área de trabalho é justamente o que escolhe para qual deles esta transferência vai; para a próxima pessoa, você abre outra.",
        },
        {
          text: "A área de trabalho toma o lugar daquele cartão. Daí em diante o estado da conexão se lê no cabeçalho dela — a qual dispositivo você está conectado, o estado do enlace e o único selo de caminho — e o envio sai dos controles logo abaixo: “Enviar arquivos” para um lote, “Enviar uma pasta” para uma árvore inteira quando o navegador oferece escolher pastas, ou digite no campo de mensagem e aperte “Enviar”. Um lote de arquivos leva até 1.000 arquivos.",
        },
        {
          text: "No dispositivo que recebe, o pedido chega com a quantidade de arquivos e o tamanho total, e a linha abaixo dele diz o que “Aceitar” vai fazer: ou o navegador pergunta onde salvar, ou os arquivos vão para a pasta de downloads dele. Em “Aceitar”, a transferência começa.",
        },
        {
          text: "Acompanhe o contador de arquivos chegar ao último arquivo nas duas telas. Para comparar um código de verificação (SAS) antes de qualquer byte se mover, ligue primeiro a “Verificação avançada” nos dois dispositivos: ela vem desligada, e o que ela acrescenta é uma comparação e uma etapa de aceite, não a criptografia — a transferência é criptografada de qualquer forma.",
        },
      ],
      success: {
        label: "Como é uma transferência que funciona",
        body: [
          "A essa altura o cartão do outro dispositivo já sumiu — a área de trabalho tomou o lugar dele. O estado se lê no cabeçalho dela: a qual dispositivo você está conectado, um estado de enlace “Conectado” e um único selo de caminho marcando “LAN direto”, um salto de host para host pela sua própria rede. “P2P direto” é o segundo caso honesto: os dois dispositivos realmente compartilhavam um IP público, mas o salto em que os navegadores se fixaram não era local.",
          "No lado que recebe, o contador para no último arquivo e o arquivo em si está onde a linha de salvamento disse. Quem confirma isso é a lista de downloads do próprio navegador que recebe, não esta página — chrome://downloads no Chrome, edge://downloads no Edge, about:downloads no Firefox.",
        ],
        code: ["Conectado a MacBook · Conectado · LAN direto\nArquivo 3/3"],
      },
      bullets: [
        "Uma sala da mesma rede não é limitada a dois dispositivos, então um cartão para cada celular e notebook da sala é o normal, e não sinal de que algo deu errado.",
        "Aqui nada é enviado primeiro e baixado depois, então não fica cópia em servidor para buscar mais tarde: os dois dispositivos permanecem na página até o contador terminar.",
      ],
    },
    {
      heading: "Quando os dispositivos não se enxergam",
      body: [
        "A descoberta na mesma rede se guia pela rede de onde seu navegador está se conectando, então é por aí que se começa a olhar: os dois dispositivos não estão de fato em uma mesma rede, o roteador mantém os clientes separados, a página não foi aberta por HTTPS, ou o navegador que recebe está sendo obrigado a segurar mais do que consegue. Essas são as primeiras verificações usuais, não a lista completa, e cada uma delas deixa na tela algo que a decide.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "“Dispositivos próximos” continua vazio, ou lista apenas o dispositivo que você está olhando.",
            code: ["https://relayium.com/   # abra nos dois e compare o IP público da linha de status"],
            fix: "Dois endereços IP públicos diferentes são duas salas separadas. Uma VPN, o iCloud Private Relay ou um SSID de visitantes que faz os clientes saírem por outro endereço são motivos comuns, e não os únicos. Se você topa mexer neles: desligue a VPN, ou desative o Private Relay só para aquela rede Wi-Fi, ou traga os dois dispositivos para a rede principal, e recarregue https://relayium.com/ em cada um. Se preferir deixá-los como estão, um código de emparelhamento em https://relayium.com/cross-network alcança o outro dispositivo sem tocar em nenhuma das duas configurações, e é criptografado de ponta a ponta do mesmo jeito.",
          },
          {
            symptom: "Os dois dispositivos mostram o mesmo IP público e mesmo assim nenhum cartão aparece.",
            code: ["https://relayium.com/   # a dica abaixo da lista de dispositivos nomeia a configuração do roteador"],
            fix: "O roteador está separando os próprios clientes. Desative “isolamento de AP / isolamento de clientes” nas configurações de Wi-Fi dele — sistemas mesh e redes de hotel ou de visitantes costumam vir com isso ligado — e recarregue a página nos dois dispositivos. Quando o roteador não é seu, o caminho é um código de emparelhamento em https://relayium.com/cross-network.",
          },
          {
            symptom: "A página diz que a transferência criptografada exige HTTPS e nenhuma lista de dispositivos aparece.",
            code: ["https://relayium.com/   # a barra de endereços precisa mostrar https, não http"],
            fix: "A página foi aberta por http:// ou por endereço IP cru, e o navegador então retém as APIs de que uma transferência criptografada precisa. O relayium.com redireciona por conta própria para HTTPS, então isso normalmente aponta para uma instância auto-hospedada acessada por http:// — abra como https://relayium.com/, ou dê um certificado à sua própria instância.",
          },
          {
            symptom: "Antes de você aceitar, o dispositivo que recebe avisa que precisa segurar o lote inteiro na memória.",
            code: ["chrome://downloads   # no Chrome; o Edge tem edge://downloads e o Firefox about:downloads"],
            fix: "Esse navegador não consegue gravar um download direto no disco, então guarda o lote inteiro, e um lote grande pode terminar em aba travada. Receba no Chrome ou no Edge em um computador, ou mande menos arquivos por vez, e confira cada chegada na lista de downloads do próprio navegador que recebe — chrome://downloads no Chrome, edge://downloads no Edge, about:downloads no Firefox — em vez de supor que salvou.",
          },
          {
            symptom: "A transferência funciona, mas o selo mostra “P2P direto” em vez de “LAN direto”.",
            code: ["https://relayium.com/   # leia o selo de caminho no cabeçalho da área de trabalho"],
            fix: "Os dois dispositivos compartilham um IP público sem compartilhar um salto local — NAT de operadora, duas VLANs atrás do mesmo enlace de subida ou um repetidor em modo cliente produzem esse efeito. A transferência continua direta e continua criptografada de ponta a ponta; ligue os dois dispositivos ao mesmo ponto de acesso se quiser que o caminho seja a sua LAN e não a rota que os navegadores encontraram.",
          },
        ],
      },
    },
    {
      heading: "Por que é rápido: nenhum servidor no meio",
      body: [
        "Os dois dispositivos se conectam a partir da mesma rede, então o Relayium liga um ao outro ponto a ponto: os bytes vão de um dispositivo para o outro sem ida e volta a um servidor do Relayium, sem nada para enviar antes nem nada para esperar baixando depois. O quanto isso é rápido depende do salto em que os dois navegadores realmente se fixaram, e quem dá nome a ele é o selo de caminho. “LAN direto” é o salto local: os dados não saem da sua própria rede e correm na velocidade dela, não na da sua conexão de internet. “P2P direto” é igualmente direto e também não tem servidor no meio, mas a rota que os navegadores acharam saiu do segmento local, então ela é limitada pelo enlace que de fato atravessa. Compartilhar um IP público é o que coloca dois dispositivos na mesma sala; por si só isso não promete que o salto entre eles seja local.",
        "É também por isso que nenhuma conta está envolvida em nenhum dos lados: com todos já na mesma rede confiável, o Relayium não precisa de login para saber quem deve poder se conectar a quem.",
      ],
    },
    {
      heading: "Ainda criptografado de ponta a ponta",
      body: [
        "Estar na mesma rede não significa que a transferência é enviada às claras. O Relayium negocia uma troca de chaves X25519 entre os dois dispositivos e criptografa cada bloco com AES-256-GCM; essa chave nunca é vista por nenhum servidor, incluindo o próprio servidor de sinalização do Relayium, que apenas ajuda os dispositivos a se encontrarem. Com a verificação avançada ativada, as duas telas também exibem um código de verificação curto (SAS) que permite confirmar visualmente que a conexão é realmente entre os seus dois dispositivos, e cada arquivo é verificado de ponta a ponta com um hash SHA-256 para você saber que chegou intacto, byte a byte.",
      ],
    },
    browserCrossNetworkSection.pt,
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso de uma conta para enviar arquivos na mesma rede Wi-Fi?",
        a: "Não. Transferências na mesma rede não precisam de conta nem de código de emparelhamento em nenhum dos lados — é só abrir relayium.com em cada dispositivo.",
      },
      {
        q: "Como o Relayium sabe quais dispositivos estão na minha rede?",
        a: "Dispositivos que se conectam a partir da mesma rede normalmente compartilham o mesmo endereço IP público, e o Relayium agrupa automaticamente na mesma sala os dispositivos com IP público correspondente, sem exigir código.",
      },
      {
        q: "Mais de dois dispositivos podem se ver ao mesmo tempo?",
        a: "Sim. Todo dispositivo que abrir relayium.com a partir daquela rede aparece na sala, com celular, notebook e desktop lado a lado. A transferência em si é de um para um: você abre uma área de trabalho com um dos dispositivos listados, e é para ele que os arquivos vão. Para compartilhar com várias pessoas na mesma sala, abra uma área de trabalho com cada uma delas por vez.",
      },
      {
        q: "A transferência continua criptografada mesmo que nunca saia da minha rede?",
        a: "Sim. Toda transferência na mesma rede usa a mesma troca de chaves X25519 e a mesma criptografia AES-256-GCM de uma entre redes, com um código de verificação que você mesmo pode conferir e uma verificação de integridade SHA-256 por arquivo.",
      },
      {
        q: "E se um dispositivo estiver na Wi-Fi e o outro nos dados móveis?",
        a: "Então eles não estão na mesma rede, e a descoberta automática não vai conectá-los. Use um código de emparelhamento em vez disso — o remetente faz login para criá-lo e quem recebe não precisa de conta. Entre redes diferentes a transferência passa por um retransmissor TURN criptografado em vez de uma conexão direta, mas continua criptografada de ponta a ponta o tempo todo: o retransmissor só encaminha texto cifrado e não consegue ler o arquivo.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium em dois (ou mais) dispositivos quaisquer na mesma rede Wi-Fi e envie seu primeiro arquivo — sem conta, sem código.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/send-files-on-the-same-wifi",
  published: "2026-07-09",
  updated: "2026-08-07",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
