// web/scripts/pages/content/articles/howto-mac-to-windows.mjs
// How-to: transfer files between a Mac and a Windows PC. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n/en.ts and content/articles/howto-android-to-iphone.mjs.

const en = {
  title: "Transfer files between a Mac and a Windows PC",
  description:
    "How to send files between macOS and Windows without a flash drive, a shared network folder, or a cloud upload. Both same network and over the internet — nothing to install on either machine.",
  updatedLabel: "Last updated",
  lead: [
    "Macs and PCs don't speak the same file-sharing language out of the box. AirDrop is Apple-only, Windows' network sharing wants both machines on a matching workgroup or domain, and neither one is exactly friendly to set up in five minutes when you just want to move one folder of project files from a MacBook to a Windows desktop.",
    "Relayium sidesteps the whole compatibility question. Open the same page on both computers: on the same LAN the end-to-end encrypted files travel directly, while across networks a TURN relay carries ciphertext it cannot read or decrypt and keeps no realtime content copy or history. Nothing needs installing; the creator signs in for cross-network pairing, while the person joining never needs an account. Here's exactly how it works in both directions.",
  ],
  sections: [
    {
      heading: "What you need before you start",
      body: [
        "Nothing to install on the Mac or the PC. On the same network there is nothing to sign up for either — the browser handles everything.",
      ],
      prereqs: {
        label: "What you need",
        items: [
          "A Mac with Safari or Chrome, and a Windows PC with Edge or Chrome — any modern browser on either side.",
          "For the simplest path, both machines on the same Wi-Fi or Ethernet network. Mixing the two is fine: a wired PC and a Mac on the same router still share one public IP, which is what puts them in the same room.",
          "The page open over https://relayium.com/ on both. Encrypted transfer needs HTTPS, and over plain http:// the page says so instead of listing devices.",
          "For a large batch, Chrome or Edge on whichever machine is receiving. Only those can stream straight to disk and let you pick a target folder — Safari has no such API and has to assemble the batch in memory instead.",
          "The files or folders to send — up to 1,000 files per batch.",
        ],
      },
    },
    {
      heading: "Mac and PC on the same network",
      body: [
        "If both computers are on the same office or home network, this is the fastest way to move files — no shared drive to mount, no permissions to fight with.",
      ],
      steps: [
        {
          text: "On the Mac, open the transfer page in the browser. On the Windows PC, open the same address.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compare the public IP in the status pill on both machines. One shared address is what puts them in the same room — a corporate VPN on the work laptop is the usual reason two machines on one office network report different ones.",
          code: ["Connected · this device MacBook · public IP 203.0.113.9"],
        },
        {
          text: "Each machine now appears to the other under “Nearby devices” — no Windows workgroup setup, no macOS file sharing to enable. On the sending computer, click the other one and press “Open workspace”. On a current browser that is the single action the card offers, because files, folders and messages all travel over the one encrypted connection it opens.",
        },
        {
          text: "The workspace replaces that card. Send from the controls under its header: “Send files” for a batch of up to 1,000, “Send a folder” for a whole tree, or type into the message box — “Enter for a new line · ⌘/Ctrl+Enter to send” — and press “Send”. On the receiving side, read the line under the request: in Chrome or Edge it says the browser will ask where to save, so you pick the folder yourself, and in Safari or Firefox it says the files go to the browser's own Downloads. Then press “Accept”.",
        },
        {
          text: "Watch the file counter run to the last file on both screens. To compare a verification code (SAS) before any bytes move, turn on “Advanced verification” on both machines first: a match confirms both joined the same end-to-end encrypted session, and it does not prove which network path carries the ciphertext. Left off, the session is still encrypted and there is simply no code to compare.",
        },
      ],
      success: {
        label: "What a working transfer looks like",
        body: [
          "The other machine's card is gone by then — the workspace took its place — so the state is read off the workspace header: the machine you are connected to, a link state of “Connected”, and one path badge reading “LAN direct”. The counter ends on the last file of the batch.",
          "In the folder you picked, the tree arrives with its relative paths intact. A name already present in that directory target is not overwritten: report.pdf lands next to it as report (1).pdf. That renaming is Relayium's own, and it applies only where the browser handed us a directory to write into — Chrome or Edge with the folder picker. Without the picker the naming belongs to that browser's download manager instead, and you read the result in its own list: chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
        code: ["Connected to ThinkPad · Connected · LAN direct\nFile 12/12"],
      },
    },
    {
      heading: "When one machine can't see the other",
      body: [
        "On this pair a work VPN and a managed office network are the two worth checking first. They are common first checks rather than the whole list, and everything below is decided by something already on the screen rather than by a support ticket.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "Neither machine appears under “Nearby devices”, even though both are on the office Wi-Fi.",
            code: ["https://relayium.com/   # compare the public IP in the status pill on both machines"],
            fix: "Two different public IP addresses mean two rooms, and a corporate VPN is one common cause: it carries one machine out through the company's address while the other leaves through the office router. A guest SSID that exits elsewhere is another, and they are not the only ones. If you are willing to change them, disconnect the VPN on that machine or leave the guest SSID, then reload https://relayium.com/ there. If the VPN has to stay up, a pairing code on https://relayium.com/cross-network reaches the other machine without dropping it.",
          },
          {
            symptom: "Both machines show the same public IP and neither card appears.",
            code: ["https://relayium.com/   # the hint under the device list names the router setting"],
            fix: "The network is separating its own clients. On a router that is yours, turn off “AP isolation / client isolation”; on a managed office network that you cannot change, pair the two machines with a code on https://relayium.com/cross-network instead.",
          },
          {
            symptom: "The Mac warns, before you accept, that the whole batch has to be held in memory.",
            code: ["https://relayium.com/   # the line under the request says how this browser will save"],
            fix: "Safari has no File System Access API, so it buffers the batch instead of writing it out, and Relayium warns past roughly 256 MiB. Receive the same batch in Chrome or Edge on that Mac: it streams each file straight to disk and asks you for a target folder first.",
          },
          {
            symptom: "One file in a folder transfer fails on the Windows side while the rest arrive.",
            code: ["https://relayium.com/   # the counter names the file it is on when it stops"],
            fix: "Windows forbids the characters \\ / : * ? \" < > | in a file name and macOS does not, so a name that is legal on the Mac can be impossible to create on the PC. Rename that file on the Mac — a colon in a date like 2026:08:05 is the usual offender — and send it again.",
          },
          {
            symptom: "The transfer works but the badge reads “P2P direct” instead of “LAN direct”.",
            code: ["https://relayium.com/   # read the path badge in the workspace header"],
            fix: "The two machines share a public IP without sharing a local hop, which is what two VLANs behind one office uplink look like. The transfer is still direct and still end-to-end encrypted; put both on the same subnet if you want the path to be your LAN rather than whatever route the browsers found.",
          },
        ],
      },
    },
    {
      heading: "Mac and PC on different networks",
      body: [
        "Working from home while the other machine is in the office, or just on a different Wi-Fi network? A pairing code connects a Mac and a Windows PC across the internet, not just across the room. A pairing-code room is a separate surface from a nearby-device workspace, though: it keeps the earlier per-device controls, so there is no “Open workspace” to press there.",
        "The sending computer generates a short pairing code (or a share link); enter it on the other machine to connect. A cross-network transfer runs over an encrypted TURN relay rather than a direct machine-to-machine link, and that is the deliberate design: the session takes the relay from the start, so the connection does not depend on discovering a direct path through the NATs and firewalls between the two networks, which can prevent one. The relay only ever forwards ciphertext — the files are sealed end-to-end before they leave the sending machine, so it has nothing it can read. If the connection drops partway through a large folder, it resumes instead of starting over. This mode needs the sender to sign in; whoever is receiving never needs an account.",
      ],
    },
    {
      heading: "Sending a whole folder, not just single files",
      body: [
        "Moving a project folder from Mac to Windows (or back) usually means zipping it first. Relayium can send a folder directly, keeping its structure intact.",
      ],
      bullets: [
        "On the Mac, drag a folder in, or pick one from the file dialog — up to 1,000 files in the batch.",
        "On a Windows PC using Edge or Chrome, the incoming folder is written straight into a directory you choose, structure preserved.",
        "If the receiving browser doesn't support writing folders directly, the folder arrives as a single .zip that unpacks to the same layout.",
      ],
    },
    {
      heading: "Other ways to move files between Mac and Windows",
      body: [
        "Relayium isn't the only option — here are the honest trade-offs of the usual alternatives:",
      ],
      bullets: [
        "A USB flash drive works offline, but macOS and Windows don't always agree on a filesystem without reformatting, and it's one more physical object to keep track of.",
        "Windows network sharing (SMB) can reach a Mac, but setting up workgroups, permissions, and firewall rules for a one-time transfer is more setup than the transfer is worth.",
        "A cloud drive (OneDrive, iCloud, Google Drive) works when the other person is offline, but the file gets uploaded and then downloaded, counts against your storage quota, and the provider keeps a copy.",
        "Email and chat apps are convenient but usually cap attachment size and aren't end-to-end encrypted for file sharing.",
      ],
    },
    {
      heading: "Will anything about the files change?",
      body: [
        "The contents do not. Relayium transfers the original bytes exactly as they are — no re-compression, no reformatting, no line-ending rewriting between the two operating systems — and a folder keeps its relative paths. Two things do not make the crossing, and both belong to the filesystem rather than to the transfer: Windows forbids characters that macOS allows, so a name legal on the Mac can be impossible to create on the PC, and POSIX permission bits, ownership and macOS extended attributes are not carried over — the receiving browser writes ordinary files under NTFS's own permission model.",
        "Every file is checked end-to-end with a SHA-256 hash, so what lands on the Windows PC (or the Mac) is verified identical to what left the other machine. Large files are handled well too: a browser with the File System Access API — Chrome or Edge on the desktop — streams the download straight to disk with no size cap. Firefox and Safari don't have that API, so a batch received there is assembled in memory instead, and Relayium warns you before you accept once it goes past roughly 256 MB. That number is a deliberately conservative estimate rather than a measured limit — where it actually breaks down depends on the machine's memory, its OS and how much else is open.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need to install anything on the Mac or the Windows PC?",
        a: "No. Relayium runs entirely in the browser on both macOS and Windows. Open relayium.com on each machine and you're ready — nothing to download either way. On the same network a transfer needs no account at all; pairing across the internet only asks the sender to sign in.",
      },
      {
        q: "Do both computers have to be on the same network?",
        a: "No. Being on the same network is the fastest path because the two machines find each other automatically, but a pairing code connects a Mac and a Windows PC across the internet just as well — even from different cities. Either way the transfer stays end-to-end encrypted; the cross-network route just asks the sender to sign in first, and the receiver never needs an account.",
      },
      {
        q: "Can I send a whole folder, not just individual files?",
        a: "Yes. Drag in a folder and Relayium sends up to 1,000 files in the batch, preserving the folder structure. Chrome and Edge on Windows write it straight into a chosen directory; if the receiving browser can't write folders directly, it arrives as a single .zip with the same layout.",
      },
      {
        q: "Will file permissions, line endings, or filenames get mangled crossing from Mac to Windows?",
        a: "The bytes and the relative path inside a folder are unchanged, verified with a SHA-256 hash end-to-end, so nothing touches line endings or encoding — anything an application-level conversion would need to handle (like CRLF vs LF in a text file) is unchanged because the file itself is unchanged. Two things genuinely do not cross: a name containing one of the characters Windows forbids can't be created on the PC at all, and POSIX permissions, ownership and macOS extended attributes are not transferred, because the receiving browser writes ordinary files under NTFS's own model.",
      },
      {
        q: "Is there a size limit?",
        a: "Up to 1,000 files per batch. There's no server-side size cap at all — Chrome and Edge on the desktop stream straight to disk. Firefox and Safari lack the File System Access API, so a batch received in one of those is held in memory, and Relayium warns you above roughly 256 MB — a cautious estimate rather than a hard limit, since the real ceiling depends on the machine's memory and what else it is running.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on your Mac and your Windows PC and move your first files across — no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何在 Mac 和 Windows 电脑之间传输文件",
  description:
    "在 macOS 和 Windows 之间传文件，不用 U 盘、不用共享文件夹、不用上传网盘。同一网络和跨互联网都能用——两台电脑都无需安装任何东西。",
  updatedLabel: "最近更新",
  lead: [
    "Mac 和 PC 天生就不说同一种文件共享语言。AirDrop 只属于苹果生态，Windows 的网络共享又要求两台机器加入匹配的工作组或域，两者都不是那种能在五分钟内搞定的东西——而你可能只是想把 MacBook 上一个项目文件夹搬到 Windows 台式机上。",
    "Relayium 绕开了这整套兼容性难题。在两台电脑上打开同一个页面：同一局域网内，端到端加密的文件会直接传输；跨网络时，TURN 中继只搬运它无法读取或解密的密文，也不保留实时内容副本或历史。两个系统都无需安装；跨网络配对由创建者登录，加入者始终无需账号。下面详细说明两个方向的具体做法。",
  ],
  sections: [
    {
      heading: "开始前需要准备什么",
      body: ["Mac 和 PC 都不用安装。同一网络下也不用注册——浏览器搞定一切。"],
      prereqs: {
        label: "你需要准备",
        items: [
          "一台用 Safari 或 Chrome 的 Mac，一台用 Edge 或 Chrome 的 Windows PC——任意一侧用现代浏览器即可。",
          "最简单的方式是把两台电脑接入同一个 Wi-Fi 或有线网络。有线和无线混着用也没问题：同一台路由器下的有线 PC 和 Mac 仍然共享同一个公网 IP，而这正是把它们放进同一个房间的依据。",
          "两台都通过 https://relayium.com/ 打开页面。加密传输需要 HTTPS，用普通 http:// 打开时页面会直接这么说，而不会列出设备。",
          "如果这一批很大，接收那一侧请用 Chrome 或 Edge。只有它们能流式直接落盘，并让你先挑好目标文件夹——Safari 没有这个接口，只能把整批内容在内存里拼装。",
          "要发送的文件或文件夹——每批最多 1,000 个文件。",
        ],
      },
    },
    {
      heading: "Mac 和 PC 在同一网络下",
      body: [
        "如果两台电脑在同一个办公室或家庭网络中，这是移动文件最快的方式——不用挂载共享盘，也不用跟权限较劲。",
      ],
      steps: [
        {
          text: "在 Mac 上用浏览器打开传输页面；在 Windows PC 上打开同一个地址。",
          code: ["https://relayium.com/"],
        },
        {
          text: "对比两台机器上状态条里的公网 IP。共享同一个地址才会把它们放进同一个房间——同一个办公网络里的两台机器却报出不同地址，通常是工作笔记本上开着公司 VPN。",
          code: ["已连接 · 本机 MacBook · 公网 IP 203.0.113.9"],
        },
        {
          text: "现在两台机器会在「附近的设备」里互相出现——不用设置 Windows 工作组，也不用开启 macOS 文件共享。在发送方电脑上点击另一台，然后按「打开工作区」。在当前浏览器上，这是卡片提供的唯一一个动作——因为接下来文件、文件夹和消息都走它打开的那一条加密连接。",
        },
        {
          text: "工作区会取代那张卡片。发送用它标题栏下面的控件：「发送文件」发一批（最多 1,000 个），整个目录树用「发送文件夹」，或者直接在消息框里打字——「回车换行 · ⌘/Ctrl+回车发送」——然后按「发送」。在接收方读一下请求下面那行：用 Chrome 或 Edge 时它会说浏览器要问你存到哪，也就是由你自己挑文件夹；用 Safari 或 Firefox 时它会说文件进入浏览器自己的下载目录。然后按「接收」。",
        },
        {
          text: "看着两块屏幕上的文件计数走到最后一个文件。如果想在任何字节移动之前核对校验码（SAS），先在两台机器上打开「高级验证」：一致说明双方加入了同一个端到端加密会话，并不证明密文采用了哪条网络路径。不打开它，会话依然是加密的，只是没有可核对的码。",
        },
      ],
      success: {
        label: "传输成功时是什么样",
        body: [
          "这时对方的卡片已经不在了——工作区取代了它——所以状态要从工作区标题栏上读：你连到了哪台机器、连接状态是「已连接」，以及唯一一个路径标签显示「局域网直连」。计数停在这一批的最后一个文件。",
          "在你挑好的文件夹里，目录树会保持相对路径地落地。目标目录里已经存在的同名文件不会被覆盖：report.pdf 会以 report (1).pdf 的名字落在它旁边。这个改名是 Relayium 自己做的，而且只在浏览器把一个目录交给我们写入时才生效——也就是带文件夹选择器的 Chrome 或 Edge。没有选择器时，命名归那个浏览器的下载管理器，结果要在它自己的列表里看：chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
        ],
        code: ["已连接到 ThinkPad · 已连接 · 局域网直连\n文件 12/12"],
      },
    },
    {
      heading: "一台机器看不到另一台时",
      body: [
        "在这一对组合里，工作 VPN 和受管控的办公网络是最值得先查的两项。它们属于常见的首轮排查，而不是全部可能；下面每一种都能靠屏幕上已有的东西判定，不需要找客服。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "两台机器都连着办公 Wi-Fi，但「附近的设备」里谁也不出现。",
            code: ["https://relayium.com/   # 对比两台机器上状态条里的公网 IP"],
            fix: "两个不同的公网 IP 就是两个房间，而公司 VPN 是常见原因之一：它把一台机器从公司的出口地址带出去，另一台却还从办公室路由器出去。从别处出网的访客 SSID 是另一种，两者都不是唯一可能。如果你愿意改：在那台机器上断开 VPN，或者离开访客 SSID，然后在那里重新加载 https://relayium.com/。如果 VPN 必须一直开着，用 https://relayium.com/cross-network 上的配对码也能连到另一台机器，不用断开它。",
          },
          {
            symptom: "两台机器显示的公网 IP 相同，却都不出现卡片。",
            code: ["https://relayium.com/   # 设备列表下方的提示写着要改的那个路由器开关"],
            fix: "网络把自己的客户端隔开了。路由器如果是你自己的，就关闭「AP 隔离 / 客户端隔离」；如果是你无权改动的受管办公网络，就改用 https://relayium.com/cross-network 上的配对码让两台机器配对。",
          },
          {
            symptom: "还没点接收，Mac 就警告说整批文件必须放在内存里。",
            code: ["https://relayium.com/   # 请求下面那行写着这个浏览器会怎么保存"],
            fix: "Safari 没有 File System Access API，所以它会把整批缓存起来而不是直接写出去，超过大约 256 MiB 时 Relayium 就会警告。请在那台 Mac 上换用 Chrome 或 Edge 接收：它会把每个文件流式直接落盘，并且先问你要存到哪个目标文件夹。",
          },
          {
            symptom: "文件夹传输里其余文件都到了，只有一个在 Windows 侧失败。",
            code: ["https://relayium.com/   # 计数停下时会显示它当时正在处理哪个文件"],
            fix: "Windows 不允许文件名里出现 \\ / : * ? \" < > |，而 macOS 允许，所以在 Mac 上合法的名字在 PC 上可能根本无法创建。请在 Mac 上给那个文件改名——像 2026:08:05 这样日期里的冒号是最常见的元凶——然后重新发送。",
          },
          {
            symptom: "传输能跑，但标签显示的是「P2P 直连」而不是「局域网直连」。",
            code: ["https://relayium.com/   # 看工作区标题栏里的路径标签"],
            fix: "两台机器共享同一个公网 IP，却没有共享本地的那一跳——同一条办公上行下的两个 VLAN 就是这个样子。传输仍然是直连，也仍然端到端加密；如果你要的是走局域网而不是浏览器找到的那条路径，就把两台放到同一个子网里。",
          },
        ],
      },
    },
    {
      heading: "Mac 和 PC 不在同一网络",
      body: [
        "在家办公而另一台机器在办公室，或者只是连在不同的 Wi-Fi 上？配对码能让 Mac 和 Windows PC 跨越互联网连接，而不仅仅是跨越房间。不过配对码房间和「附近的设备」工作区是两套界面：它保留的是早先那套按设备分开的控件，那里没有「打开工作区」可按。",
        "发送方电脑会生成一段简短的配对码（或一个分享链接）；在另一台机器上输入即可连接。跨网络的传输走的是加密 TURN 中继，而不是两台机器之间的直连，这是刻意的设计：这类会话一开始就走中继，因此连接不依赖在两个网络之间的 NAT 和防火墙里探测出一条直连路径——它们可能挡住这样的路径。中继只转发密文——文件在离开发送端之前就已完成端到端加密，所以它拿不到任何能读的东西。如果传输一个大文件夹时连接中途断开，可以续传而不必从头再来。这种方式需要发送方登录；接收方始终无需账号。",
      ],
    },
    {
      heading: "发送整个文件夹，而不只是单个文件",
      body: [
        "把一个项目文件夹从 Mac 搬到 Windows（或反过来）通常得先打包压缩。Relayium 可以直接发送文件夹，并保持其结构完整。",
      ],
      bullets: [
        "在 Mac 上，直接把文件夹拖进去，或从文件选择器中选取——一批最多 1,000 个文件。",
        "在使用 Edge 或 Chrome 的 Windows PC 上，收到的文件夹会直接写入你选择的目录，结构保持不变。",
        "如果接收方的浏览器不支持直接写入文件夹，文件夹会以单个 .zip 的形式到达，解压后结构相同。",
      ],
    },
    {
      heading: "在 Mac 和 Windows 之间传文件的其他方式",
      body: ["Relayium 不是唯一选择——以下把常见替代方案的取舍摊开讲："],
      bullets: [
        "U 盘可以离线使用，但 macOS 和 Windows 在文件系统上并不总是兼容，可能需要重新格式化，而且多了一个要随身携带的实物。",
        "Windows 网络共享（SMB）可以连到 Mac，但为了一次性的传输去配置工作组、权限和防火墙规则，付出远超收益。",
        "网盘（OneDrive、iCloud、Google Drive）在对方离线时也能用，但文件要先上传再下载，占用你的存储配额，且服务商手里留有一份副本。",
        "邮件和聊天软件很方便，但通常会限制附件大小，且文件分享并非端到端加密。",
      ],
    },
    {
      heading: "文件会有任何改变吗？",
      body: [
        "内容不会。Relayium 按原始字节精确传输——不重新压缩、不重新格式化，两个系统之间也不会改动换行符——文件夹的相对路径也保持不变。但有两样东西过不去，而且都属于文件系统而不是传输本身：Windows 禁止 macOS 允许的一些字符，所以在 Mac 上合法的名字在 PC 上可能根本无法创建；另外 POSIX 权限位、所属关系和 macOS 扩展属性都不会被带过去——接收端浏览器写出的是普通文件，遵循 NTFS 自己的权限模型。",
        "每个文件都用 SHA-256 做端到端校验，所以落到 Windows PC（或 Mac）上的内容，经验证与从另一台机器发出的完全一致。大文件也处理得很好：支持 File System Access API 的浏览器——桌面版 Chrome、Edge——会把下载直接流式写入磁盘，没有大小上限。Firefox 和 Safari 没有这个 API，在它们那边接收时整批文件只能先攒在内存里，因此一旦超过约 256 MB，Relayium 会在你点「接收」之前先提示一次。这个数字是刻意取的保守估计，而不是实测出来的上限——真正撑不住的临界点取决于这台机器的内存、系统以及还开着多少东西。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Mac 或 Windows PC 上需要安装什么吗？",
        a: "不需要。Relayium 在 macOS 和 Windows 上都完全运行于浏览器中。在每台机器上打开 relayium.com 就绪了——无论哪种方式都不用下载。同一网络下传输完全无需账号；跨互联网配对只需发送方登录一下。",
      },
      {
        q: "两台电脑必须在同一网络吗？",
        a: "不必。同一网络是最快的方式，因为两台机器会自动互相发现；但配对码同样能让 Mac 和 Windows PC 跨越互联网连接——即使身处不同城市。无论哪种方式传输都保持端到端加密；跨网络路径只是需要发送方先登录，接收方始终无需账号。",
      },
      {
        q: "能发送整个文件夹，而不只是单个文件吗？",
        a: "可以。把文件夹拖进去，Relayium 会以一批最多 1,000 个文件发送，并保持文件夹结构。Windows 上的 Chrome 和 Edge 会直接写入你选择的目录；如果接收方浏览器不支持直接写入文件夹，会以单个 .zip 到达，结构相同。",
      },
      {
        q: "从 Mac 传到 Windows，文件权限、换行符或文件名会被弄乱吗？",
        a: "字节和文件夹内的相对路径不变，并用 SHA-256 哈希做端到端校验，所以换行符和编码都不会被触碰——任何需要应用层转换处理的东西（比如文本文件里 CRLF 和 LF 的区别）都不受影响，因为文件本身没有被改动。但确实有两样东西过不去：名字里带有 Windows 禁止字符的文件在 PC 上根本无法创建；POSIX 权限、所属关系和 macOS 扩展属性也不会被传输，因为接收端浏览器写出的是遵循 NTFS 自身模型的普通文件。",
      },
      {
        q: "有大小限制吗？",
        a: "每批最多 1,000 个文件。服务器端完全没有大小上限——桌面版 Chrome 和 Edge 会直接流式写入磁盘。Firefox 和 Safari 没有 File System Access API，在它们那边接收的整批文件只能先放在内存里，因此超过约 256 MB 时 Relayium 会先提示你——这是个保守估计而非硬上限，真正的天花板取决于这台机器的内存以及还跑着什么。",
      },
    ],
  },
  cta: {
    text: "在你的 Mac 和 Windows PC 上打开 Relayium，把第一批文件传过去吧——无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Mac と Windows パソコン間でファイルを転送する方法",
  description:
    "USB メモリも共有フォルダもクラウドへのアップロードも使わずに、macOS と Windows の間でファイルを送る方法。同じネットワークでもインターネット越しでも、どちらの端末にもインストール不要です。",
  updatedLabel: "最終更新",
  lead: [
    "Mac と PC は、そのままではファイル共有の言葉が違います。AirDrop は Apple 専用、Windows のネットワーク共有は両方の端末が一致するワークグループやドメインに入っている必要があり、どちらも5分でさっと設定できるものではありません。MacBook 上のプロジェクトフォルダを1つ、Windows デスクトップに移したいだけなのに。",
    "Relayium はその互換性の問題をまるごと回避します。両方のパソコンで同じページを開くと、同じ LAN 内ではエンドツーエンド暗号化されたファイルが直接転送され、ネットワークをまたぐ場合は TURN リレーが読取りも復号もできない暗号文だけを運び、リアルタイム内容のコピーや履歴を残しません。インストールは不要で、ネットワーク越しのペアリングでは作成者がサインインし、参加者にはアカウントが不要です。以下、両方向の具体的な手順を説明します。",
  ],
  sections: [
    {
      heading: "始める前に必要なもの",
      body: [
        "Mac にも PC にもインストールは不要です。同じネットワークなら登録も不要です。ブラウザがすべて処理します。",
      ],
      prereqs: {
        label: "必要なもの",
        items: [
          "Safari か Chrome を使う Mac と、Edge か Chrome を使う Windows パソコン（どちらも最新のブラウザで構いません）。",
          "最もシンプルな方法は、両方の端末を同じ Wi-Fi または有線ネットワークに接続することです。有線と無線が混ざっていても問題ありません。同じルーター配下なら有線の PC と Mac も同じグローバル IP を共有し、それが 2台を同じルームに入れる根拠になります。",
          "両方で https://relayium.com/ からページを開いていること。暗号化転送には HTTPS が必要で、素の http:// で開くと端末を一覧せずにその旨を表示します。",
          "大きなバッチを送るなら、受信する側は Chrome か Edge にしてください。ディスクへ直接ストリーミングでき、保存先フォルダを先に選べるのはその 2つだけです。Safari にはその API がなく、バッチをメモリ上で組み立てることになります。",
          "送りたいファイルまたはフォルダ（1バッチあたり最大1,000ファイル）。",
        ],
      },
    },
    {
      heading: "Mac と PC が同じネットワークにある場合",
      body: [
        "両方のパソコンが同じオフィスや自宅のネットワークにあれば、これがファイルを移す最速の方法です。共有ドライブをマウントする必要も、権限で苦労する必要もありません。",
      ],
      steps: [
        {
          text: "Mac でブラウザから転送ページを開きます。Windows パソコンでも同じアドレスを開きます。",
          code: ["https://relayium.com/"],
        },
        {
          text: "両方の端末のステータス表示にあるグローバル IP を比べます。同じアドレスを共有していることが 2台を同じルームに入れる条件です。同じオフィスネットワークにいる 2台が違うアドレスを示す場合、原因はたいてい業務用ノート PC で有効な社内 VPN です。",
          code: ["接続済み · このデバイス MacBook · グローバル IP 203.0.113.9"],
        },
        {
          text: "これで各端末が「近くのデバイス」に互いを表示します。Windows のワークグループ設定も、macOS のファイル共有を有効にする必要もありません。送信側のパソコンでもう一方を選び、「ワークスペースを開く」を押します。最新のブラウザではカードが提供する動作はこれ 1 つだけで、以降はファイルもフォルダもメッセージも、そこで開かれる 1 本の暗号化接続を通ります。",
        },
        {
          text: "ワークスペースがそのカードに取って代わります。送信はヘッダーの下のコントロールで行います：1 バッチ最大 1,000 ファイルなら「ファイルを送信」、ディレクトリ全体なら「フォルダを送信」、あるいはメッセージ欄に入力して——「Enter で改行 · ⌘/Ctrl+Enter で送信」——「送信」を押します。受信側ではリクエストの下の行を読んでください。Chrome か Edge ならブラウザが保存先を尋ねる、つまりフォルダを自分で選ぶと書かれ、Safari か Firefox ならブラウザ自身のダウンロード先に入ると書かれています。読んだうえで「受信」を押します。",
        },
        {
          text: "両方の画面でファイルカウンターが最後のファイルに達するまで見守ります。1 バイトも動く前に検証コード（SAS）を照合したい場合は、先に両方の端末で「高度な検証」をオンにしてください。一致は2台が同じエンドツーエンド暗号化セッションに参加したことを確認するもので、暗号文が通るネットワーク経路を証明するものではありません。オフのままでもセッションは暗号化されており、照合すべきコードが出ないだけです。",
        },
      ],
      success: {
        label: "転送が成功したときの画面",
        body: [
          "この時点でもう一方のカードはありません——ワークスペースが取って代わったからです。状態はワークスペースのヘッダーから読みます：接続先の端末、「接続済み」というリンク状態、そして唯一の経路バッジ「LAN直結」。カウンターはそのバッチの最後のファイルで止まります。",
          "選んだフォルダには、ツリーが相対パスそのままで届きます。その書き込み先ディレクトリにすでに同名のファイルがある場合も上書きされません。report.pdf はその隣に report (1).pdf として着地します。この改名は Relayium 自身が行うもので、ブラウザが書き込み先ディレクトリを渡してきた場合——つまりフォルダ選択のある Chrome か Edge——に限られます。選択できない場合、名前の付け方はそのブラウザのダウンロード管理に委ねられ、結果はそのブラウザ自身の一覧で確認します：chrome://downloads (Chrome)、edge://downloads (Edge)、about:downloads (Firefox)。",
        ],
        code: ["ThinkPad に接続済み · 接続済み · LAN直結\nファイル 12/12"],
      },
    },
    {
      heading: "片方の端末がもう片方を見つけられないとき",
      body: [
        "この組み合わせでは、業務用 VPN と管理されたオフィスネットワークがまず確認する価値のある 2 つです。これらは網羅した一覧ではなく定番の初手で、以下はどれも問い合わせではなく画面上にあるものだけで判別できます。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "両方ともオフィスの Wi-Fi にいるのに、「近くのデバイス」にどちらも現れない。",
            code: ["https://relayium.com/   # 両方の端末のステータス表示にあるグローバル IP を比べる"],
            fix: "グローバル IP が 2つ違えばルームも 2つで、社内 VPN はよくある原因の 1 つです。一方の端末を会社の出口アドレス経由で外に出し、もう一方はオフィスのルーターから出ていくためです。別の出口を使うゲスト SSID がもう 1 つで、これらが唯一の原因ではありません。変更してよいなら、その端末で VPN を切る、あるいはゲスト SSID から離れ、そこで https://relayium.com/ を再読み込みしてください。VPN を切れない場合は、https://relayium.com/cross-network のペアリングコードなら VPN を落とさずにもう一方の端末へ届きます。",
          },
          {
            symptom: "両方の端末が同じグローバル IP を表示しているのに、どちらのカードも現れない。",
            code: ["https://relayium.com/   # 端末一覧の下のヒントに、変更すべきルーター設定名がある"],
            fix: "ネットワークが自分のクライアントを隔てています。自分のルーターなら「AP 分離 / クライアント分離」をオフにしてください。変更できない管理されたオフィスネットワークなら、https://relayium.com/cross-network のコードで 2台をペアリングします。",
          },
          {
            symptom: "承認する前に、Mac がバッチ全体をメモリに保持しなければならないと警告する。",
            code: ["https://relayium.com/   # リクエストの下の行に、このブラウザの保存方法が書かれている"],
            fix: "Safari には File System Access API がないため、書き出す代わりにバッチを抱え込み、おおよそ 256 MiB を超えると Relayium が警告します。その Mac で Chrome か Edge に切り替えて受け取ってください。各ファイルをディスクへ直接ストリーミングし、先に保存先フォルダを尋ねます。",
          },
          {
            symptom: "フォルダ転送で他のファイルは届いたのに、1つだけ Windows 側で失敗する。",
            code: ["https://relayium.com/   # 止まった時点でカウンターがどのファイルかを示す"],
            fix: "Windows はファイル名に \\ / : * ? \" < > | を許さず、macOS は許すため、Mac では正当な名前が PC では作成できないことがあります。その Mac 側でファイル名を変更してから送り直してください。2026:08:05 のような日付のコロンが最も多い原因です。",
          },
          {
            symptom: "転送は動くが、バッジが「LAN直結」ではなく「P2P直結」になっている。",
            code: ["https://relayium.com/   # ワークスペースのヘッダーにある経路バッジを読む"],
            fix: "2台はグローバル IP を共有しているのに、ローカルなホップは共有していません。1本のオフィス上流にぶら下がる 2つの VLAN がまさにこの形です。転送は依然として直接で、依然としてエンドツーエンド暗号化です。経路をブラウザが見つけた道ではなく LAN にしたいなら、両方を同じサブネットに置いてください。",
          },
        ],
      },
    },
    {
      heading: "Mac と PC が異なるネットワークにある場合",
      body: [
        "自宅から作業していて、もう一方のパソコンはオフィスにある、あるいは単に別の Wi-Fi につながっている。そんなときも、ペアリングコードは Mac と Windows パソコンを部屋を越えるだけでなく、インターネット越しにつなげます。ただしペアリングコードのルームは「近くのデバイス」のワークスペースとは別の画面で、以前どおり端末ごとに分かれたコントロールのままなので、そこに「ワークスペースを開く」はありません。",
        "送信側のパソコンが短いペアリングコード（または共有リンク）を生成するので、もう一方の端末で入力して接続します。ネットワークをまたぐ転送は、端末同士の直接接続ではなく暗号化された TURN リレー経由で行われます。これは意図的な設計です。この種のセッションは最初からリレーを使うため、接続の成立は、2 つのネットワークの間にある NAT やファイアウォールを越える直接の経路を見つけられるかどうかに左右されません。NAT やファイアウォールが直接の経路を塞ぐこともあります。リレーが転送するのは暗号文だけで、ファイルは送信側のパソコンを出る前にエンドツーエンドで封印されているため、読めるものは何も渡りません。大きなフォルダの転送中に接続が切れても、最初からではなく再開できます。この方式には送信側のサインインが必要です。受信側はアカウント不要です。",
      ],
    },
    {
      heading: "個々のファイルだけでなく、フォルダ丸ごと送る",
      body: [
        "プロジェクトフォルダを Mac から Windows へ（あるいはその逆）移すには、通常まず ZIP 化が必要です。Relayium ならフォルダをそのまま、構造を保ったまま送信できます。",
      ],
      bullets: [
        "Mac では、フォルダをドラッグして入れるか、ファイル選択ダイアログから選びます（1バッチ最大1,000ファイル）。",
        "Edge か Chrome を使う Windows パソコンでは、届いたフォルダが選んだディレクトリへ構造そのままで直接書き込まれます。",
        "受信側のブラウザがフォルダの直接書き込みに対応していない場合、フォルダは同じ構造に展開できる単一の .zip として届きます。",
      ],
    },
    {
      heading: "Mac と Windows の間でファイルを移す他の方法",
      body: ["Relayium だけが選択肢ではありません。よくある代替手段の正直なトレードオフです。"],
      bullets: [
        "USB メモリはオフラインで使えますが、macOS と Windows はファイルシステムで必ずしも一致せず、再フォーマットが必要になることがあり、持ち運ぶ物がもう1つ増えます。",
        "Windows のネットワーク共有（SMB）は Mac にも届きますが、一度きりの転送のためにワークグループや権限、ファイアウォールのルールを設定するのは、転送そのものより手間がかかります。",
        "クラウドドライブ（OneDrive、iCloud、Google ドライブ）は相手がオフラインでも使えますが、ファイルはアップロードされてからダウンロードされ、容量を消費し、提供元がコピーを保持します。",
        "メールやチャットアプリは便利ですが、たいてい添付サイズを制限し、ファイル共有はエンドツーエンド暗号化されていません。",
      ],
    },
    {
      heading: "ファイルに何か変化はありますか？",
      body: [
        "内容は変わりません。Relayium は元のバイトをそのまま正確に転送します。再圧縮も再フォーマットもなく、2つの OS の間で改行コードが書き換わることもなく、フォルダの相対パスも保たれます。ただし渡らないものが 2 つあり、どちらも転送ではなくファイルシステムに属します。Windows は macOS が許す文字を禁じているため、Mac では正当な名前が PC では作成できないことがあります。そして POSIX のパーミッションビット、所有者、macOS の拡張属性は引き継がれません——受信側のブラウザが書き出すのは、NTFS 自身のパーミッションモデルに従う普通のファイルです。",
        "各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるので、Windows パソコン（または Mac）に届くものは、もう一方の端末から送られたものと同一であることが確認されます。大きなファイルもうまく扱えます。File System Access API を備えたブラウザ（パソコン版の Chrome や Edge）なら、ダウンロードはサイズ上限なしでそのままディスクにストリーミングされます。Firefox と Safari にはこの API がないため、そちらで受信するとひとまとめにメモリへ溜めることになり、およそ 256MB を超えると Relayium が受け取る前に警告を出します。この数値は実測した上限ではなく意図的に控えめに置いた目安で、実際に破綻する地点はそのパソコンのメモリ・OS・ほかに何を開いているかによって変わります。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Mac や Windows パソコンに何かインストールする必要がありますか？",
        a: "いいえ。Relayium は macOS でも Windows でもすべてブラウザで動作します。各端末で relayium.com を開けば準備完了です。どちらの方法でもダウンロードは不要です。同じネットワークなら転送にアカウントは一切不要で、インターネット越しのペアリングも送信側がサインインするだけです。",
      },
      {
        q: "両方のパソコンが同じネットワークにある必要がありますか？",
        a: "いいえ。同じネットワークは2台の端末が自動的に互いを見つけるため最速の方法ですが、ペアリングコードなら Mac と Windows パソコンを異なる都市にあってもインターネット越しに接続できます。どちらの場合も転送はエンドツーエンド暗号化のままです。ネットワークをまたぐ経路は送信側が先にサインインするだけで、受信側はアカウント不要です。",
      },
      {
        q: "個々のファイルだけでなく、フォルダ丸ごと送れますか？",
        a: "はい。フォルダをドラッグして入れれば、Relayium は1バッチ最大1,000ファイルを送信し、フォルダ構造を保ちます。Windows の Chrome と Edge は選んだディレクトリへ直接書き込みます。受信側のブラウザがフォルダの直接書き込みに対応していない場合は、同じ構造の単一の .zip として届きます。",
      },
      {
        q: "Mac から Windows に渡ると、ファイル権限や改行コード、ファイル名が崩れませんか？",
        a: "バイトとフォルダ内の相対パスは変わらず、SHA-256 ハッシュでエンドツーエンドに検証されるので、改行コードやエンコーディングには一切触れません。アプリケーション側の変換が必要になるようなもの（テキストファイルの CRLF と LF の違いなど）は、ファイル自体が変更されないため影響を受けません。ただし本当に渡らないものが 2 つあります。Windows が禁じる文字を含む名前は PC 側でそもそも作成できません。そして POSIX のパーミッション、所有者、macOS の拡張属性は転送されません——受信側のブラウザが書き出すのは NTFS 自身のモデルに従う普通のファイルだからです。",
      },
      {
        q: "サイズに制限はありますか？",
        a: "1バッチあたり最大1,000ファイルです。サーバー側のサイズ上限はそもそもありません。パソコン版の Chrome と Edge はそのままディスクへストリーミングします。Firefox と Safari には File System Access API がないため、そちらで受け取るとひとまとめにメモリへ保持することになり、およそ 256MB を超えると Relayium が警告します。これは硬い上限ではなく控えめな目安で、実際の天井はそのパソコンのメモリと、ほかに何を動かしているかで決まります。",
      },
    ],
  },
  cta: {
    text: "Mac と Windows パソコンの両方で Relayium を開いて、最初のファイルを送ってみましょう。インストール不要で、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Mac과 Windows PC 사이에서 파일 전송하는 방법",
  description:
    "USB 드라이브도, 공유 폴더도, 클라우드 업로드도 없이 macOS와 Windows 사이에서 파일을 보내는 방법. 같은 네트워크에서도 인터넷 너머로도 가능하며, 두 운영체제 모두 설치할 것이 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Mac과 PC는 기본적으로 같은 파일 공유 언어를 쓰지 않습니다. AirDrop은 애플 전용이고, Windows의 네트워크 공유는 두 기기가 일치하는 작업 그룹이나 도메인에 있어야 하는데, 둘 다 5분 만에 뚝딱 설정할 수 있는 것이 아닙니다 — MacBook의 프로젝트 폴더 하나를 Windows 데스크톱으로 옮기고 싶을 뿐인데도 말이죠.",
    "Relayium은 이 호환성 문제 전체를 우회합니다. 두 컴퓨터에서 같은 페이지를 열면 같은 LAN에서는 종단간 암호화된 파일이 직접 전송되고, 네트워크를 넘을 때는 TURN 릴레이가 읽거나 복호화할 수 없는 암호문만 전달하며 실시간 콘텐츠 사본이나 기록을 남기지 않습니다. 설치는 필요 없고, 네트워크 간 페어링에서는 생성자가 로그인하며 참가자는 계정이 필요 없습니다. 아래에서 양방향의 정확한 방법을 설명합니다.",
  ],
  sections: [
    {
      heading: "시작하기 전에 필요한 것",
      body: [
        "Mac이나 PC 어느 쪽에도 설치할 것이 없습니다. 같은 네트워크에서는 가입할 것도 없습니다 — 브라우저가 모든 걸 처리합니다.",
      ],
      prereqs: {
        label: "필요한 것",
        items: [
          "Safari나 Chrome을 쓰는 Mac과 Edge나 Chrome을 쓰는 Windows PC — 어느 쪽이든 최신 브라우저면 됩니다.",
          "가장 간단한 방법은 두 기기를 같은 Wi-Fi나 유선 네트워크에 연결하는 것입니다. 둘을 섞어도 됩니다. 같은 공유기 아래라면 유선 PC와 Mac도 같은 공인 IP를 공유하고, 그것이 둘을 같은 방에 넣는 근거입니다.",
          "두 기기 모두 https://relayium.com/ 으로 페이지를 열어야 합니다. 암호화 전송에는 HTTPS가 필요하며, 평범한 http:// 로 열면 기기를 나열하는 대신 그 사실을 알립니다.",
          "배치가 크다면 받는 쪽은 Chrome이나 Edge로 하세요. 디스크로 바로 스트리밍하고 대상 폴더를 먼저 고를 수 있는 것은 그 둘뿐입니다. Safari에는 그 API가 없어 배치를 메모리에서 조립해야 합니다.",
          "보내려는 파일이나 폴더 — 배치당 최대 1,000개 파일.",
        ],
      },
    },
    {
      heading: "Mac과 PC가 같은 네트워크에 있을 때",
      body: [
        "두 컴퓨터가 같은 사무실이나 가정 네트워크에 있다면, 이것이 파일을 옮기는 가장 빠른 방법입니다 — 공유 드라이브를 마운트할 필요도, 권한과 씨름할 필요도 없습니다.",
      ],
      steps: [
        {
          text: "Mac에서 브라우저로 전송 페이지를 엽니다. Windows PC에서도 같은 주소를 엽니다.",
          code: ["https://relayium.com/"],
        },
        {
          text: "두 기기의 상태 표시에 있는 공인 IP를 비교합니다. 주소를 하나 공유하는 것이 둘을 같은 방에 넣는 조건입니다. 같은 사무실 네트워크의 두 기기가 서로 다른 주소를 보인다면 보통 업무용 노트북에 켜진 회사 VPN 때문입니다.",
          code: ["연결됨 · 내 기기 MacBook · 공인 IP 203.0.113.9"],
        },
        {
          text: "이제 두 기기가 “주변 기기”에서 서로 나타납니다 — Windows 작업 그룹 설정도, macOS 파일 공유 활성화도 필요 없습니다. 보내는 컴퓨터에서 다른 쪽을 누르고 “작업 공간 열기”를 누르세요. 최신 브라우저에서 카드가 제공하는 동작은 이 하나뿐입니다 — 이후 파일과 폴더와 메시지가 모두 그때 열리는 암호화된 연결 하나를 지나기 때문입니다.",
        },
        {
          text: "작업 공간이 그 카드를 대신합니다. 보내기는 헤더 아래의 컨트롤로 합니다: 한 배치에 최대 1,000개라면 “파일 보내기”, 디렉터리 전체라면 “폴더 보내기”, 또는 메시지 상자에 입력하고 — “Enter 로 줄바꿈 · ⌘/Ctrl+Enter 로 전송” — “보내기”를 누릅니다. 받는 쪽에서는 요청 아래 줄을 읽으세요. Chrome이나 Edge라면 브라우저가 저장 위치를 묻는다고, 즉 폴더를 직접 고른다고 적혀 있고, Safari나 Firefox라면 파일이 브라우저 자체 다운로드 폴더로 간다고 적혀 있습니다. 그다음 “받기”를 누릅니다.",
        },
        {
          text: "두 화면에서 파일 카운터가 마지막 파일까지 가는 것을 지켜보세요. 한 바이트도 움직이기 전에 검증 코드(SAS)를 대조하려면 먼저 두 기기에서 “고급 검증”을 켜세요. 일치한다는 것은 둘이 같은 종단간 암호화 세션에 참여했음을 확인할 뿐, 암호문이 어떤 네트워크 경로로 이동하는지는 증명하지 않습니다. 꺼 두어도 세션은 여전히 암호화되며, 대조할 코드가 없을 뿐입니다.",
        },
      ],
      success: {
        label: "전송이 잘될 때의 화면",
        body: [
          "그때쯤 상대 카드는 사라져 있습니다 — 작업 공간이 그 자리를 차지했으니까요 — 그래서 상태는 작업 공간 헤더에서 읽습니다: 연결된 기기, “연결됨”이라는 링크 상태, 그리고 하나뿐인 경로 배지 “LAN 직접”. 카운터는 그 배치의 마지막 파일에서 멈춥니다.",
          "고른 폴더에는 트리가 상대 경로를 그대로 유지한 채 도착합니다. 그 대상 디렉터리에 이미 같은 이름이 있어도 덮어쓰지 않습니다. report.pdf는 그 옆에 report (1).pdf로 내려앉습니다. 이 이름 변경은 Relayium 자신이 하는 것이며, 브라우저가 쓸 디렉터리를 넘겨준 경우 — 폴더 선택기가 있는 Chrome이나 Edge — 에만 적용됩니다. 선택기가 없으면 이름 짓기는 그 브라우저의 다운로드 관리자 몫이고, 결과는 그 브라우저 자체 목록에서 확인합니다: chrome://downloads (Chrome), edge://downloads (Edge), about:downloads (Firefox).",
        ],
        code: ["ThinkPad 에 연결됨 · 연결됨 · LAN 직접\n파일 12/12"],
      },
    },
    {
      heading: "한쪽 기기가 다른 쪽을 못 볼 때",
      body: [
        "이 조합에서는 업무용 VPN과 관리되는 사무실 네트워크가 먼저 확인할 만한 두 가지입니다. 전부를 담은 목록이 아니라 흔한 1차 점검이며, 아래는 모두 문의가 아니라 이미 화면에 있는 것으로 판단됩니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "둘 다 사무실 Wi-Fi에 있는데도 “주변 기기”에 어느 쪽도 나타나지 않습니다.",
            code: ["https://relayium.com/   # 두 기기의 상태 표시에 있는 공인 IP를 비교한다"],
            fix: "공인 IP가 다르면 방도 둘이고, 회사 VPN은 흔한 원인 하나입니다. 한 기기는 회사 출구 주소로 나가고 다른 기기는 사무실 공유기로 나가기 때문입니다. 다른 출구로 나가는 게스트 SSID가 또 하나이며, 이 둘만 있는 것은 아닙니다. 바꿔도 괜찮다면 그 기기에서 VPN을 끊거나 게스트 SSID에서 빠져나온 뒤 거기서 https://relayium.com/ 을 다시 불러오세요. VPN을 계속 켜 두어야 한다면 https://relayium.com/cross-network 의 페어링 코드가 VPN을 끊지 않고 상대 기기에 닿습니다.",
          },
          {
            symptom: "두 기기가 같은 공인 IP를 보여주는데도 어느 카드도 나타나지 않습니다.",
            code: ["https://relayium.com/   # 기기 목록 아래 안내에 바꿔야 할 공유기 설정 이름이 있다"],
            fix: "네트워크가 자기 클라이언트를 갈라놓고 있습니다. 내 공유기라면 ‘AP 격리 / 클라이언트 격리’를 끄고, 손댈 수 없는 관리형 사무실 네트워크라면 https://relayium.com/cross-network 의 코드로 두 기기를 페어링하세요.",
          },
          {
            symptom: "받기를 누르기 전에, Mac이 배치 전체를 메모리에 담아야 한다고 경고합니다.",
            code: ["https://relayium.com/   # 요청 아래 줄에 이 브라우저가 어떻게 저장할지 적혀 있다"],
            fix: "Safari에는 File System Access API가 없어 내보내는 대신 배치를 안고 있으며, 대략 256 MiB를 넘으면 Relayium이 경고합니다. 그 Mac에서 Chrome이나 Edge로 받으세요. 파일마다 디스크로 바로 스트리밍하고 대상 폴더를 먼저 물어봅니다.",
          },
          {
            symptom: "폴더 전송에서 나머지는 도착했는데 한 파일만 Windows 쪽에서 실패합니다.",
            code: ["https://relayium.com/   # 멈춘 시점에 카운터가 어느 파일인지 보여준다"],
            fix: "Windows는 파일 이름에 \\ / : * ? \" < > | 를 허용하지 않고 macOS는 허용하므로, Mac에서 적법한 이름이 PC에서는 만들어질 수 없습니다. Mac에서 그 파일 이름을 바꾸고 다시 보내세요 — 2026:08:05 같은 날짜의 콜론이 가장 흔한 원인입니다.",
          },
          {
            symptom: "전송은 되지만 배지가 “LAN 직접”이 아니라 “P2P 직접”으로 나옵니다.",
            code: ["https://relayium.com/   # 작업 공간 헤더의 경로 배지를 읽는다"],
            fix: "두 기기가 공인 IP는 공유하지만 로컬 홉은 공유하지 않습니다. 사무실 회선 하나 아래의 두 VLAN이 바로 그런 모습입니다. 전송은 여전히 직접이고 여전히 종단간 암호화입니다. 경로를 브라우저가 찾은 길이 아니라 LAN으로 만들고 싶다면 둘을 같은 서브넷에 두세요.",
          },
        ],
      },
    },
    {
      heading: "Mac과 PC가 다른 네트워크에 있을 때",
      body: [
        "집에서 작업 중인데 다른 컴퓨터는 사무실에 있거나, 그냥 다른 Wi-Fi에 연결되어 있나요? 페어링 코드는 Mac과 Windows PC를 방을 넘어서뿐 아니라 인터넷 너머로도 연결해 줍니다. 다만 페어링 코드 방은 “주변 기기” 작업 공간과 별개의 화면이며, 기기별로 나뉜 이전 컨트롤을 그대로 쓰므로 거기에는 누를 “작업 공간 열기”가 없습니다.",
        "보내는 컴퓨터가 짧은 페어링 코드(또는 공유 링크)를 생성하면, 다른 기기에서 입력해 연결합니다. 네트워크를 넘는 전송은 기기 간 직접 연결이 아니라 암호화된 TURN 릴레이를 거치며, 이는 의도된 설계입니다. 이런 세션은 처음부터 릴레이로 가기 때문에, 연결이 두 네트워크 사이의 NAT와 방화벽을 통과하는 직접 경로를 찾아내는 데 의존하지 않습니다. NAT나 방화벽이 그런 경로를 막을 수도 있습니다. 릴레이는 암호문만 전달합니다 — 파일은 보내는 컴퓨터를 떠나기 전에 종단간으로 봉인되므로 릴레이가 읽을 수 있는 것은 아무것도 없습니다. 큰 폴더를 전송하다가 중간에 연결이 끊겨도 처음부터가 아니라 이어서 재개됩니다. 이 방식은 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "개별 파일뿐 아니라 폴더 전체 보내기",
      body: [
        "프로젝트 폴더를 Mac에서 Windows로(또는 반대로) 옮기려면 보통 먼저 압축해야 합니다. Relayium은 폴더를 구조 그대로 유지하며 직접 보낼 수 있습니다.",
      ],
      bullets: [
        "Mac에서는 폴더를 끌어다 놓거나 파일 선택 창에서 고릅니다 — 배치당 최대 1,000개 파일.",
        "Edge나 Chrome을 쓰는 Windows PC에서는 들어오는 폴더가 선택한 디렉터리에 구조 그대로 곧바로 기록됩니다.",
        "받는 쪽 브라우저가 폴더를 직접 기록하는 기능을 지원하지 않으면, 폴더는 같은 구조로 풀리는 단일 .zip으로 도착합니다.",
      ],
    },
    {
      heading: "Mac과 Windows 사이에서 파일을 옮기는 다른 방법",
      body: ["Relayium만이 선택지는 아닙니다 — 흔한 대안의 솔직한 절충점입니다:"],
      bullets: [
        "USB 드라이브는 오프라인에서 쓸 수 있지만, macOS와 Windows가 파일 시스템에서 항상 맞지는 않아 재포맷이 필요할 수 있고, 챙겨야 할 물건이 하나 더 생깁니다.",
        "Windows 네트워크 공유(SMB)는 Mac에도 닿지만, 일회성 전송을 위해 작업 그룹, 권한, 방화벽 규칙을 설정하는 건 전송 자체보다 손이 더 갑니다.",
        "클라우드 드라이브(OneDrive, iCloud, Google 드라이브)는 상대가 오프라인이어도 되지만, 파일을 올렸다가 다시 내려받게 되고, 저장 용량을 차지하며, 제공자가 사본을 보관합니다.",
        "이메일과 채팅 앱은 편리하지만 보통 첨부 크기를 제한하고, 파일 공유는 종단간 암호화가 아닙니다.",
      ],
    },
    {
      heading: "파일에 뭔가 바뀌는 게 있나요?",
      body: [
        "내용은 바뀌지 않습니다. Relayium은 원본 바이트를 있는 그대로 정확히 전송합니다 — 재압축도, 재포맷도 없고, 두 운영체제 사이에서 줄바꿈이 다시 쓰이지도 않으며, 폴더의 상대 경로도 그대로입니다. 다만 넘어가지 못하는 것이 두 가지 있고, 둘 다 전송이 아니라 파일 시스템에 속합니다. Windows는 macOS가 허용하는 문자를 금지하므로 Mac에서 적법한 이름이 PC에서는 만들어지지 못할 수 있고, POSIX 권한 비트와 소유권, macOS 확장 속성은 옮겨지지 않습니다 — 받는 쪽 브라우저가 쓰는 것은 NTFS 자체의 권한 모델을 따르는 보통 파일입니다.",
        "각 파일은 SHA-256 해시로 종단간 검증되므로, Windows PC(또는 Mac)에 도착한 것은 다른 쪽 컴퓨터에서 나간 것과 동일함이 확인됩니다. 큰 파일도 잘 처리됩니다. File System Access API가 있는 브라우저 — 데스크톱 Chrome, Edge — 는 크기 제한 없이 다운로드를 곧바로 디스크로 스트리밍합니다. Firefox와 Safari에는 그 API가 없어서 그쪽에서 받으면 한 묶음을 메모리에 모으게 되며, 대략 256MB를 넘어서면 Relayium이 수락하기 전에 미리 경고합니다. 이 수치는 측정된 상한이 아니라 일부러 보수적으로 잡은 추정치이고, 실제로 무너지는 지점은 그 컴퓨터의 메모리와 OS, 그리고 그 밖에 무엇을 열어 두었는지에 달려 있습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Mac이나 Windows PC에 뭔가 설치해야 하나요?",
        a: "아니요. Relayium은 macOS와 Windows 모두에서 전적으로 브라우저에서 동작합니다. 각 기기에서 relayium.com을 열면 준비 끝입니다 — 어느 쪽이든 다운로드는 필요 없습니다. 같은 네트워크에서는 전송에 계정이 전혀 필요 없고, 인터넷 너머 페어링도 보내는 쪽이 로그인만 하면 됩니다.",
      },
      {
        q: "두 컴퓨터가 반드시 같은 네트워크에 있어야 하나요?",
        a: "아니요. 같은 네트워크는 두 기기가 자동으로 서로를 찾기 때문에 가장 빠르지만, 페어링 코드는 서로 다른 도시에 있는 Mac과 Windows PC도 인터넷 너머로 똑같이 연결해 줍니다. 어느 쪽이든 전송은 종단간 암호화를 유지합니다. 네트워크를 넘는 경로는 보내는 쪽이 먼저 로그인하기만 하면 되고, 받는 쪽은 계정이 필요 없습니다.",
      },
      {
        q: "개별 파일뿐 아니라 폴더 전체를 보낼 수 있나요?",
        a: "네. 폴더를 끌어다 놓으면 Relayium이 배치당 최대 1,000개 파일을 폴더 구조를 유지하며 보냅니다. Windows의 Chrome과 Edge는 선택한 디렉터리에 곧바로 기록합니다. 받는 쪽 브라우저가 폴더를 직접 기록하지 못하면, 같은 구조의 단일 .zip으로 도착합니다.",
      },
      {
        q: "Mac에서 Windows로 넘어갈 때 파일 권한, 줄바꿈, 파일명이 망가지나요?",
        a: "바이트와 폴더 안의 상대 경로는 그대로이고 SHA-256 해시로 종단간 검증되므로 줄바꿈이나 인코딩은 건드리지 않습니다 — 애플리케이션 수준의 변환이 필요할 만한 것(텍스트 파일의 CRLF와 LF 차이 등)도 파일 자체가 변경되지 않으므로 영향받지 않습니다. 다만 정말로 넘어가지 않는 것이 두 가지 있습니다. Windows가 금지하는 문자가 들어간 이름은 PC에서 아예 만들어지지 못하고, POSIX 권한과 소유권, macOS 확장 속성은 전송되지 않습니다 — 받는 쪽 브라우저가 NTFS 자체 모델을 따르는 보통 파일을 쓰기 때문입니다.",
      },
      {
        q: "크기 제한이 있나요?",
        a: "배치당 최대 1,000개 파일입니다. 서버 측 크기 제한은 아예 없습니다 — 데스크톱 Chrome과 Edge는 곧바로 디스크로 스트리밍합니다. Firefox와 Safari에는 File System Access API가 없어 그쪽에서 받은 묶음은 메모리에 담기며, 대략 256MB를 넘으면 Relayium이 경고합니다. 이는 고정된 한계가 아니라 보수적으로 잡은 추정치로, 실제 상한은 그 컴퓨터의 메모리와 함께 돌아가는 다른 작업에 달려 있습니다.",
      },
    ],
  },
  cta: {
    text: "Mac과 Windows PC 양쪽에서 Relayium을 열고 첫 파일을 보내 보세요 — 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien zwischen Mac und Windows-PC übertragen",
  description:
    "So sendest du Dateien zwischen macOS und Windows — ohne USB-Stick, freigegebenen Ordner oder Cloud-Upload. Im selben Netz und über das Internet, auf keinem der beiden Systeme ist etwas zu installieren.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Mac und PC sprechen von Haus aus nicht dieselbe Sprache, wenn es um Dateifreigabe geht. AirDrop ist Apple vorbehalten, die Netzwerkfreigabe von Windows verlangt, dass beide Rechner in einer passenden Arbeitsgruppe oder Domäne sind, und beides lässt sich nicht eben in fünf Minuten einrichten — dabei willst du vielleicht nur einen Projektordner vom MacBook auf den Windows-Desktop bringen.",
    "Relayium umgeht dieses ganze Kompatibilitätsproblem. Öffne dieselbe Seite auf beiden Rechnern: Im selben LAN werden die Ende-zu-Ende-verschlüsselten Dateien direkt übertragen; netzübergreifend transportiert ein TURN-Relay nur Chiffretext, den es weder lesen noch entschlüsseln kann, und behält weder Echtzeitinhalte noch einen Verlauf. Installiert werden muss nichts; beim netzübergreifenden Pairing meldet sich der Ersteller an, die beitretende Person braucht nie ein Konto. Hier die genauen Schritte in beide Richtungen.",
  ],
  sections: [
    {
      heading: "Was du vorher brauchst",
      body: [
        "Nichts zu installieren, weder auf dem Mac noch auf dem PC. Im selben Netz gibt es auch nichts zu registrieren — der Browser erledigt alles.",
      ],
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Ein Mac mit Safari oder Chrome und ein Windows-PC mit Edge oder Chrome — auf beiden Seiten reicht ein aktueller Browser.",
          "Für den einfachsten Weg beide Rechner im selben WLAN oder Ethernet-Netz. Beides zu mischen ist in Ordnung: Ein verkabelter PC und ein Mac am selben Router teilen weiterhin eine öffentliche IP, und genau das steckt sie in denselben Raum.",
          "Auf beiden die Seite über https://relayium.com/ geöffnet. Verschlüsselte Übertragung braucht HTTPS, und über einfaches http:// sagt die Seite das, statt Geräte aufzulisten.",
          "Für einen großen Stapel Chrome oder Edge auf dem empfangenden Rechner. Nur die können direkt auf die Platte streamen und dich vorher einen Zielordner wählen lassen — Safari hat diese API nicht und muss den Stapel im Speicher zusammensetzen.",
          "Die Dateien oder Ordner zum Senden — bis zu 1.000 Dateien pro Stapel.",
        ],
      },
    },
    {
      heading: "Mac und PC im selben Netzwerk",
      body: [
        "Sind beide Rechner im selben Büro- oder Heimnetz, ist das der schnellste Weg, Dateien zu bewegen — kein Netzlaufwerk einzubinden, kein Kampf mit Berechtigungen.",
      ],
      steps: [
        {
          text: "Öffne auf dem Mac die Übertragungsseite im Browser. Öffne auf dem Windows-PC dieselbe Adresse.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Vergleiche die öffentliche IP in der Statuszeile auf beiden Rechnern. Eine gemeinsame Adresse steckt sie in denselben Raum — melden zwei Rechner in einem Büronetz verschiedene, liegt das meist an einem Firmen-VPN auf dem Arbeitslaptop.",
          code: ["Verbunden · dieses Gerät MacBook · öffentliche IP 203.0.113.9"],
        },
        {
          text: "Jetzt erscheint jeder Rechner beim anderen unter „Geräte in der Nähe“ — keine Windows-Arbeitsgruppe einzurichten, keine macOS-Dateifreigabe zu aktivieren. Klicke auf dem sendenden Rechner den anderen an und drücke „Arbeitsbereich öffnen“. In einem aktuellen Browser ist das die einzige Aktion, die die Karte anbietet, denn Dateien, Ordner und Nachrichten laufen alle über die eine verschlüsselte Verbindung, die sie öffnet.",
        },
        {
          text: "Der Arbeitsbereich tritt an die Stelle dieser Karte. Gesendet wird mit den Bedienelementen unter seiner Kopfzeile: „Dateien senden“ für einen Stapel von bis zu 1.000 Dateien, „Ordner senden“ für einen ganzen Baum, oder tippe ins Nachrichtenfeld — „Enter für neue Zeile · ⌘/Ctrl+Enter zum Senden“ — und drücke „Senden“. Lies auf der empfangenden Seite die Zeile unter der Anfrage: In Chrome oder Edge steht dort, dass der Browser nach dem Speicherort fragt, du wählst den Ordner also selbst; in Safari oder Firefox steht, dass die Dateien in den eigenen Download-Ordner gehen. Dann drücke „Annehmen“.",
        },
        {
          text: "Sieh zu, wie der Dateizähler auf beiden Bildschirmen die letzte Datei erreicht. Wer vor dem ersten Byte einen Verifizierungscode (SAS) vergleichen will, schaltet vorher auf beiden Rechnern „Erweiterte Verifizierung“ ein: Eine Übereinstimmung bestätigt, dass beide derselben Ende-zu-Ende-verschlüsselten Sitzung beigetreten sind, nicht welchen Netzwerkweg der Chiffretext nimmt. Bleibt sie aus, ist die Sitzung trotzdem verschlüsselt, es gibt nur keinen Code zum Vergleichen.",
        },
      ],
      success: {
        label: "So sieht eine funktionierende Übertragung aus",
        body: [
          "Die Karte des anderen Rechners ist dann verschwunden — der Arbeitsbereich hat ihren Platz übernommen —, der Zustand wird also an der Kopfzeile des Arbeitsbereichs abgelesen: der verbundene Rechner, ein Verbindungszustand „Verbunden“ und ein einziges Pfad-Abzeichen mit „LAN direkt“. Der Zähler endet bei der letzten Datei des Stapels.",
          "Im gewählten Ordner kommt der Baum mit seinen relativen Pfaden an. Ein Name, der in diesem Zielverzeichnis schon liegt, wird nicht überschrieben: report.pdf landet daneben als report (1).pdf. Diese Umbenennung ist Relayiums eigene und gilt nur dort, wo der Browser uns ein Verzeichnis zum Schreiben übergeben hat — Chrome oder Edge mit der Ordnerauswahl. Ohne Auswahl gehört die Benennung dem Download-Manager dieses Browsers, und das Ergebnis liest du in seiner eigenen Liste: chrome://downloads in Chrome, edge://downloads in Edge, about:downloads in Firefox.",
        ],
        code: ["Verbunden mit ThinkPad · Verbunden · LAN direkt\nDatei 12/12"],
      },
    },
    {
      heading: "Wenn ein Rechner den anderen nicht sieht",
      body: [
        "Bei diesem Paar sind ein Firmen-VPN und ein verwaltetes Büronetz die zwei, die zuerst zu prüfen lohnen. Das sind die üblichen ersten Prüfungen und nicht die ganze Liste, und alles unten entscheidet sich an etwas, das schon auf dem Bildschirm steht, und nicht an einer Support-Anfrage.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Keiner der beiden Rechner erscheint unter „Geräte in der Nähe“, obwohl beide im Büro-WLAN sind.",
            code: ["https://relayium.com/   # die öffentliche IP in der Statuszeile auf beiden Rechnern vergleichen"],
            fix: "Zwei verschiedene öffentliche IP-Adressen bedeuten zwei Räume, und ein Firmen-VPN ist eine häufige Ursache: Es führt einen Rechner über die Adresse der Firma hinaus, während der andere über den Büro-Router geht. Eine Gast-SSID mit eigenem Ausgang ist eine weitere, und sie sind nicht die einzigen. Wenn du sie ändern willst, trenne das VPN auf diesem Rechner oder verlasse die Gast-SSID, und lade dort https://relayium.com/ neu. Muss das VPN oben bleiben, erreicht ein Pairing-Code auf https://relayium.com/cross-network den anderen Rechner, ohne es zu trennen.",
          },
          {
            symptom: "Beide Rechner zeigen dieselbe öffentliche IP, und keine Karte erscheint.",
            code: ["https://relayium.com/   # der Hinweis unter der Geräteliste nennt die Router-Einstellung"],
            fix: "Das Netz trennt seine eigenen Clients. Auf einem Router, der dir gehört, schalte „AP-Isolierung / Client-Isolierung“ aus; in einem verwalteten Büronetz, das du nicht ändern kannst, koppel die beiden Rechner stattdessen mit einem Code auf https://relayium.com/cross-network.",
          },
          {
            symptom: "Vor dem Annehmen warnt der Mac, er müsse den ganzen Stapel im Speicher halten.",
            code: ["https://relayium.com/   # die Zeile unter der Anfrage sagt, wie dieser Browser speichert"],
            fix: "Safari hat keine File System Access API, puffert den Stapel also statt ihn wegzuschreiben, und ab etwa 256 MiB warnt Relayium. Empfange denselben Stapel in Chrome oder Edge auf diesem Mac: Der streamt jede Datei direkt auf die Platte und fragt dich vorher nach einem Zielordner.",
          },
          {
            symptom: "Eine Datei einer Ordnerübertragung scheitert auf der Windows-Seite, während der Rest ankommt.",
            code: ["https://relayium.com/   # der Zähler nennt die Datei, bei der er stehen bleibt"],
            fix: "Windows verbietet die Zeichen \\ / : * ? \" < > | in einem Dateinamen, macOS nicht — ein auf dem Mac legaler Name kann auf dem PC also unmöglich anzulegen sein. Benenne diese Datei auf dem Mac um und sende sie erneut; ein Doppelpunkt in einem Datum wie 2026:08:05 ist der übliche Fall.",
          },
          {
            symptom: "Die Übertragung läuft, aber das Abzeichen zeigt „P2P direkt“ statt „LAN direkt“.",
            code: ["https://relayium.com/   # das Pfad-Abzeichen in der Kopfzeile des Arbeitsbereichs lesen"],
            fix: "Die beiden Rechner teilen eine öffentliche IP, aber keinen lokalen Sprung — genau so sehen zwei VLANs hinter einem Büro-Uplink aus. Die Übertragung bleibt direkt und bleibt Ende-zu-Ende-verschlüsselt; setz beide in dasselbe Subnetz, wenn der Pfad dein LAN sein soll und nicht die Route, die die Browser gefunden haben.",
          },
        ],
      },
    },
    {
      heading: "Mac und PC in verschiedenen Netzwerken",
      body: [
        "Du arbeitest von zu Hause, während der andere Rechner im Büro steht, oder bist einfach in einem anderen WLAN? Ein Pairing-Code verbindet Mac und Windows-PC über das Internet, nicht nur über den Raum hinweg. Ein Pairing-Code-Raum ist allerdings eine andere Oberfläche als ein Arbeitsbereich mit einem Gerät in der Nähe: Er behält die früheren, pro Gerät getrennten Bedienelemente, dort gibt es also kein „Arbeitsbereich öffnen“ zu drücken.",
        "Der sendende Rechner erzeugt einen kurzen Pairing-Code (oder einen Freigabelink); gib ihn auf dem anderen Rechner ein, um dich zu verbinden. Eine netzübergreifende Übertragung läuft über ein verschlüsseltes TURN-Relay statt über eine direkte Verbindung zwischen den Rechnern, und das ist so beabsichtigt: Die Sitzung nutzt von Anfang an das Relay, sodass die Verbindung nicht davon abhängt, einen direkten Weg durch die NATs und Firewalls zwischen den beiden Netzwerken zu finden — die einen solchen Weg verhindern können. Das Relay leitet ausschließlich Chiffretext weiter — die Dateien sind Ende-zu-Ende versiegelt, bevor sie den sendenden Rechner verlassen, es bekommt also nichts Lesbares zu sehen. Bricht die Verbindung mitten in einem großen Ordner ab, wird sie fortgesetzt statt neu gestartet. Dieser Weg erfordert die Anmeldung des Absenders; wer empfängt, braucht nie ein Konto.",
      ],
    },
    {
      heading: "Einen ganzen Ordner senden, nicht nur einzelne Dateien",
      body: [
        "Einen Projektordner von Mac nach Windows (oder zurück) zu bewegen bedeutet normalerweise, ihn erst zu zippen. Relayium kann einen Ordner direkt senden und behält dabei seine Struktur bei.",
      ],
      bullets: [
        "Auf dem Mac ziehst du einen Ordner hinein oder wählst ihn im Dateidialog aus — bis zu 1.000 Dateien im Stapel.",
        "Auf einem Windows-PC mit Edge oder Chrome wird der eingehende Ordner direkt in ein von dir gewähltes Verzeichnis geschrieben, Struktur erhalten.",
        "Unterstützt der empfangende Browser das direkte Schreiben von Ordnern nicht, kommt der Ordner als einzelne .zip-Datei an, die sich zur gleichen Struktur entpacken lässt.",
      ],
    },
    {
      heading: "Andere Wege, Dateien zwischen Mac und Windows zu bewegen",
      body: [
        "Relayium ist nicht die einzige Option — hier die ehrlichen Kompromisse der üblichen Alternativen:",
      ],
      bullets: [
        "Ein USB-Stick funktioniert offline, aber macOS und Windows sind sich beim Dateisystem nicht immer einig, ohne dass neu formatiert werden muss, und es ist ein weiteres physisches Objekt, das man nicht verlieren darf.",
        "Windows-Netzwerkfreigabe (SMB) erreicht auch einen Mac, aber für eine einmalige Übertragung Arbeitsgruppen, Berechtigungen und Firewall-Regeln einzurichten, ist mehr Aufwand als die Übertragung wert ist.",
        "Eine Cloud (OneDrive, iCloud, Google Drive) funktioniert, wenn die andere Person offline ist, aber die Datei wird hoch- und wieder heruntergeladen, zählt gegen dein Speicherkontingent, und der Anbieter behält eine Kopie.",
        "E-Mail und Chat-Apps sind praktisch, begrenzen aber meist die Anhangsgröße und sind beim Dateiaustausch nicht Ende-zu-Ende-verschlüsselt.",
      ],
    },
    {
      heading: "Ändert sich etwas an den Dateien?",
      body: [
        "Der Inhalt nicht. Relayium überträgt die Original-Bytes exakt so, wie sie sind — keine erneute Komprimierung, keine Neuformatierung, keine umgeschriebenen Zeilenumbrüche zwischen den beiden Betriebssystemen —, und ein Ordner behält seine relativen Pfade. Zwei Dinge schaffen den Übergang jedoch nicht, und beide gehören zum Dateisystem und nicht zur Übertragung: Windows verbietet Zeichen, die macOS erlaubt, ein auf dem Mac legaler Name kann auf dem PC also unmöglich anzulegen sein, und POSIX-Rechtebits, Besitzverhältnisse und erweiterte macOS-Attribute werden nicht mitgenommen — der empfangende Browser schreibt gewöhnliche Dateien unter NTFS' eigenem Rechtemodell.",
        "Jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, sodass das, was auf dem Windows-PC (oder dem Mac) ankommt, nachweislich identisch mit dem ist, was den anderen Rechner verlassen hat. Auch große Dateien werden gut gehandhabt: Ein Browser mit der File System Access API — Chrome oder Edge auf dem Desktop — streamt den Download ohne Größenbegrenzung direkt auf die Festplatte. Firefox und Safari haben diese API nicht, dort sammelt sich ein empfangener Stapel stattdessen im Arbeitsspeicher, und ab etwa 256 MB warnt Relayium dich, bevor du annimmst. Dieser Wert ist eine bewusst vorsichtige Schätzung und keine gemessene Grenze — wo es tatsächlich kippt, hängt vom Arbeitsspeicher des Rechners, vom Betriebssystem und davon ab, was sonst noch offen ist.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss ich auf dem Mac oder dem Windows-PC etwas installieren?",
        a: "Nein. Relayium läuft auf macOS und Windows vollständig im Browser. Öffne auf jedem Rechner relayium.com, und du bist startklar — einen Download braucht es so oder so nicht. Im selben Netz braucht eine Übertragung überhaupt kein Konto; Pairing über das Internet verlangt nur die Anmeldung des Absenders.",
      },
      {
        q: "Müssen beide Rechner im selben Netzwerk sein?",
        a: "Nein. Dasselbe Netz ist der schnellste Weg, weil sich die beiden Rechner automatisch finden, aber ein Pairing-Code verbindet Mac und Windows-PC genauso gut über das Internet — sogar aus verschiedenen Städten. So oder so bleibt die Übertragung Ende-zu-Ende-verschlüsselt; der Weg über Netzwerke hinweg verlangt nur, dass sich der Absender zuerst anmeldet, der Empfänger braucht nie ein Konto.",
      },
      {
        q: "Kann ich einen ganzen Ordner senden, nicht nur einzelne Dateien?",
        a: "Ja. Ziehe einen Ordner hinein, und Relayium sendet bis zu 1.000 Dateien im Stapel und behält dabei die Ordnerstruktur bei. Chrome und Edge unter Windows schreiben direkt in ein gewähltes Verzeichnis; kann der empfangende Browser Ordner nicht direkt schreiben, kommt er als einzelne .zip-Datei mit derselben Struktur an.",
      },
      {
        q: "Werden Dateiberechtigungen, Zeilenumbrüche oder Dateinamen beim Wechsel von Mac zu Windows durcheinandergebracht?",
        a: "Die Bytes und der relative Pfad innerhalb eines Ordners bleiben unverändert und werden per SHA-256-Hash Ende-zu-Ende geprüft, Zeilenumbrüche und Kodierung werden also nicht angerührt — alles, was eine Konvertierung auf Anwendungsebene bräuchte (etwa CRLF vs. LF in einer Textdatei), bleibt unverändert, weil die Datei selbst unverändert bleibt. Zwei Dinge kommen wirklich nicht mit: Ein Name mit einem der von Windows verbotenen Zeichen lässt sich auf dem PC überhaupt nicht anlegen, und POSIX-Rechte, Besitzverhältnisse und erweiterte macOS-Attribute werden nicht übertragen, weil der empfangende Browser gewöhnliche Dateien unter NTFS' eigenem Modell schreibt.",
      },
      {
        q: "Gibt es eine Größenbegrenzung?",
        a: "Bis zu 1.000 Dateien pro Stapel. Eine serverseitige Größenbegrenzung gibt es überhaupt nicht — Chrome und Edge auf dem Desktop streamen direkt auf die Festplatte. Firefox und Safari fehlt die File System Access API, dort wird ein empfangener Stapel im Arbeitsspeicher gehalten, und ab etwa 256 MB warnt Relayium — eine vorsichtige Schätzung, keine harte Grenze, denn die tatsächliche Obergrenze hängt vom Arbeitsspeicher des Rechners und davon ab, was sonst noch läuft.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf deinem Mac und deinem Windows-PC und schick deine ersten Dateien hinüber — keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer des fichiers entre un Mac et un PC Windows",
  description:
    "Comment envoyer des fichiers entre macOS et Windows sans clé USB, sans dossier partagé, sans envoi vers le cloud. Sur le même réseau ou via Internet, rien à installer sur aucun des deux systèmes.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Mac et PC ne parlent pas nativement le même langage de partage de fichiers. AirDrop est réservé à Apple, le partage réseau de Windows exige que les deux machines soient dans un groupe de travail ou un domaine compatible, et aucun des deux ne se configure vraiment en cinq minutes — alors que vous voulez peut-être juste déplacer un dossier de projet d'un MacBook vers un PC de bureau Windows.",
    "Relayium contourne tout ce problème de compatibilité. Ouvrez la même page sur les deux ordinateurs : sur le même LAN, les fichiers chiffrés de bout en bout passent directement ; entre réseaux, un relais TURN ne transporte que du texte chiffré qu'il ne peut ni lire ni déchiffrer, sans conserver de copie ni d'historique du contenu en temps réel. Rien à installer ; pour l'appairage entre réseaux, le créateur se connecte et la personne qui rejoint n'a jamais besoin de compte. Voici la marche à suivre exacte dans les deux sens.",
  ],
  sections: [
    {
      heading: "Ce qu'il vous faut avant de commencer",
      body: [
        "Rien à installer, ni sur le Mac ni sur le PC. Sur le même réseau, rien à créer non plus — le navigateur s'occupe de tout.",
      ],
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Un Mac avec Safari ou Chrome, et un PC Windows avec Edge ou Chrome — n'importe quel navigateur moderne des deux côtés suffit.",
          "Pour la voie la plus simple, les deux machines sur le même réseau Wi-Fi ou Ethernet. Mélanger les deux ne pose aucun problème : un PC filaire et un Mac derrière le même routeur partagent toujours une IP publique, et c'est elle qui les place dans la même salle.",
          "La page ouverte via https://relayium.com/ sur les deux. Le transfert chiffré exige HTTPS, et en simple http:// la page le dit au lieu de lister des appareils.",
          "Pour un gros lot, Chrome ou Edge sur la machine qui reçoit. Seuls ces deux-là écrivent directement sur le disque et vous laissent choisir un dossier de destination au préalable — Safari n'a pas cette API et doit assembler le lot en mémoire.",
          "Les fichiers ou dossiers à envoyer — jusqu'à 1 000 fichiers par lot.",
        ],
      },
    },
    {
      heading: "Mac et PC sur le même réseau",
      body: [
        "Si les deux ordinateurs sont sur le même réseau de bureau ou domestique, c'est le moyen le plus rapide de déplacer des fichiers — aucun lecteur partagé à monter, aucune permission à débloquer.",
      ],
      steps: [
        {
          text: "Sur le Mac, ouvrez la page de transfert dans le navigateur. Sur le PC Windows, ouvrez la même adresse.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Comparez l'IP publique de la ligne d'état sur les deux machines. Une adresse commune est ce qui les place dans la même salle, et si deux machines d'un même réseau de bureau en annoncent deux différentes, c'est le plus souvent un VPN d'entreprise sur le portable professionnel.",
          code: ["Connecté · cet appareil MacBook · IP publique 203.0.113.9"],
        },
        {
          text: "Chaque machine apparaît maintenant sur l'autre sous « Appareils à proximité » — aucun groupe de travail Windows à configurer, aucun partage de fichiers macOS à activer. Sur l'ordinateur qui envoie, cliquez sur l'autre et appuyez sur « Ouvrir l’espace de travail ». Sur un navigateur actuel c'est la seule action que la carte propose, car fichiers, dossiers et messages passent tous par l'unique connexion chiffrée qu'elle ouvre.",
        },
        {
          text: "L'espace de travail remplace cette carte. Pour envoyer, utilisez les commandes sous son en-tête : « Envoyer des fichiers » pour un lot d'au plus 1 000 fichiers, « Envoyer un dossier » pour toute une arborescence, ou tapez dans la zone de message — « Entrée pour une nouvelle ligne · ⌘/Ctrl+Entrée pour envoyer » — puis appuyez sur « Envoyer ». Du côté qui reçoit, lisez la ligne sous la demande avant d'accepter. Dans Chrome ou Edge, elle annonce que le navigateur demandera où enregistrer, donc vous choisissez le dossier vous-même, et dans Safari ou Firefox, que les fichiers iront dans les téléchargements du navigateur. Appuyez ensuite sur « Accepter ».",
        },
        {
          text: "Regardez le compteur atteindre le dernier fichier sur les deux écrans. Pour comparer un code de vérification (SAS) avant le moindre octet, activez « Vérification avancée » sur les deux machines avant de commencer. Vérifiez qu'il correspond : il confirme que les deux machines ont rejoint la même session chiffrée de bout en bout, pas le chemin réseau emprunté par le texte chiffré. Laissée désactivée, la session reste chiffrée ; il n'y a simplement aucun code à comparer.",
        },
      ],
      success: {
        label: "À quoi ressemble un transfert qui marche",
        body: [
          "La carte de l'autre machine a disparu à ce stade — l'espace de travail a pris sa place — alors l'état se lit sur l'en-tête de l'espace de travail : la machine à laquelle vous êtes connecté, un état de lien « Connecté », et un unique badge de chemin indiquant « LAN direct ». Le compteur s'arrête sur le dernier fichier du lot.",
          "Dans le dossier choisi, l'arborescence arrive avec ses chemins relatifs intacts. Un nom déjà présent dans ce répertoire de destination n'est pas écrasé, car report.pdf atterrit à côté sous le nom report (1).pdf. Ce renommage est celui de Relayium et ne vaut que là où le navigateur nous a confié un répertoire où écrire — Chrome ou Edge avec le sélecteur de dossier. Sans sélecteur, le nommage appartient au gestionnaire de téléchargements de ce navigateur, et le résultat se lit dans sa propre liste : chrome://downloads dans Chrome, edge://downloads dans Edge, about:downloads dans Firefox.",
        ],
        code: ["Connecté à ThinkPad · Connecté · LAN direct\nFichier 12/12"],
      },
    },
    {
      heading: "Quand une machine ne voit pas l'autre",
      body: [
        "Sur cette paire, un VPN d'entreprise et un réseau de bureau administré sont les deux à vérifier en premier. Ce sont des premières vérifications courantes plutôt que la liste complète, et tout ce qui suit se tranche avec un élément déjà présent à l'écran plutôt qu'avec un ticket d'assistance.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Aucune des deux machines n'apparaît sous « Appareils à proximité », alors que les deux sont sur le Wi-Fi du bureau.",
            code: ["https://relayium.com/   # comparez l'IP publique de la ligne d'état sur les deux machines"],
            fix: "Deux adresses IP publiques différentes, ce sont deux salles, et un VPN d'entreprise en est une cause courante : il fait sortir une machine par l'adresse de la société pendant que l'autre passe par le routeur du bureau. Un SSID invité qui sort ailleurs en est une autre, et ce ne sont pas les seules. Si vous acceptez de les changer, coupez le VPN sur cette machine ou quittez le SSID invité, puis rechargez https://relayium.com/ dessus. Si le VPN doit rester actif, un code d'appairage sur https://relayium.com/cross-network atteint l'autre machine sans le couper.",
          },
          {
            symptom: "Les deux machines affichent la même IP publique et aucune carte n'apparaît.",
            code: ["https://relayium.com/   # l'indication sous la liste des appareils nomme le réglage du routeur"],
            fix: "Le réseau sépare ses propres clients. Sur un routeur qui vous appartient, désactivez « l'isolation AP / isolation des clients ». Sur un réseau de bureau administré que vous ne pouvez pas modifier, appairez plutôt les deux machines avec un code sur https://relayium.com/cross-network.",
          },
          {
            symptom: "Avant l'acceptation, le Mac avertit qu'il doit garder tout le lot en mémoire.",
            code: ["https://relayium.com/   # la ligne sous la demande indique comment ce navigateur enregistre"],
            fix: "Safari n'a pas d'API File System Access, il met donc le lot en tampon au lieu de l'écrire, et Relayium avertit au-delà d'environ 256 MiB. Recevez le même lot dans Chrome ou Edge sur ce Mac : il écrit chaque fichier directement sur le disque et vous demande d'abord un dossier de destination.",
          },
          {
            symptom: "Un fichier d'un transfert de dossier échoue du côté Windows alors que le reste arrive.",
            code: ["https://relayium.com/   # le compteur nomme le fichier sur lequel il s'arrête"],
            fix: "Windows interdit les caractères \\/:*?\"<>| dans un nom de fichier, macOS non, donc un nom légal sur le Mac peut être impossible à créer sur le PC. Renommez ce fichier sur le Mac puis renvoyez-le. Le deux-points d'une date comme 2026:08:05 est le cas le plus courant.",
          },
          {
            symptom: "Le transfert fonctionne, mais le badge indique « P2P direct » au lieu de « LAN direct ».",
            code: ["https://relayium.com/   # lisez le badge de chemin dans l'en-tête de l'espace de travail"],
            fix: "Les deux machines partagent une IP publique sans partager de saut local, ce qui est exactement l'allure de deux VLAN derrière un même lien montant de bureau. Le transfert reste direct et reste chiffré de bout en bout : mettez les deux sur le même sous-réseau si vous voulez que le chemin soit votre LAN plutôt que la route trouvée par les navigateurs.",
          },
        ],
      },
    },
    {
      heading: "Mac et PC sur des réseaux différents",
      body: [
        "Vous travaillez depuis chez vous pendant que l'autre machine est au bureau, ou simplement sur un autre réseau Wi-Fi ? Un code d'appairage connecte un Mac et un PC Windows via Internet, pas seulement d'une pièce à l'autre. Une salle à code d'appairage reste toutefois une surface distincte d'un espace de travail avec un appareil à proximité : elle conserve les anciennes commandes séparées par appareil, il n'y a donc pas d'« Ouvrir l’espace de travail » à y presser.",
        "L'ordinateur qui envoie génère un court code d'appairage (ou un lien de partage) ; saisissez-le sur l'autre machine pour vous connecter. Un transfert entre réseaux passe par un relais TURN chiffré plutôt que par une liaison directe entre les deux machines, et c'est délibéré : la session emprunte le relais dès le départ, si bien que la connexion ne dépend pas de la découverte d'une voie directe à travers les NAT et pare-feu situés entre les deux réseaux, qui peuvent en empêcher une. Le relais ne transmet que du texte chiffré — les fichiers sont scellés de bout en bout avant de quitter la machine émettrice, il n'a donc rien de lisible entre les mains. Si la connexion se coupe en cours de transfert d'un gros dossier, elle reprend au lieu de tout recommencer. Ce mode exige que l'expéditeur se connecte ; celui qui reçoit n'a jamais besoin de compte.",
      ],
    },
    {
      heading: "Envoyer un dossier entier, pas seulement des fichiers isolés",
      body: [
        "Déplacer un dossier de projet du Mac vers Windows (ou l'inverse) implique généralement de le compresser d'abord. Relayium peut envoyer un dossier directement, en conservant sa structure intacte.",
      ],
      bullets: [
        "Sur le Mac, glissez un dossier ou choisissez-en un dans le sélecteur de fichiers — jusqu'à 1 000 fichiers dans le lot.",
        "Sur un PC Windows utilisant Edge ou Chrome, le dossier reçu est écrit directement dans un répertoire de votre choix, structure préservée.",
        "Si le navigateur du destinataire ne prend pas en charge l'écriture directe de dossiers, le dossier arrive sous forme d'un seul .zip qui se décompresse selon la même arborescence.",
      ],
    },
    {
      heading: "Autres façons de déplacer des fichiers entre Mac et Windows",
      body: [
        "Relayium n'est pas la seule option — voici les compromis honnêtes des solutions de rechange habituelles :",
      ],
      bullets: [
        "Une clé USB fonctionne hors ligne, mais macOS et Windows ne s'accordent pas toujours sur un système de fichiers sans reformatage, et c'est un objet physique de plus à ne pas perdre.",
        "Le partage réseau Windows (SMB) peut atteindre un Mac, mais configurer groupes de travail, permissions et règles de pare-feu pour un transfert ponctuel demande plus d'effort que le transfert n'en vaut la peine.",
        "Un espace cloud (OneDrive, iCloud, Google Drive) fonctionne quand l'autre personne est hors ligne, mais le fichier est téléversé puis téléchargé, cela grignote votre quota de stockage, et le fournisseur en garde une copie.",
        "L'e-mail et les messageries sont pratiques mais limitent généralement la taille des pièces jointes et ne sont pas chiffrés de bout en bout pour le partage de fichiers.",
      ],
    },
    {
      heading: "Quelque chose change-t-il dans les fichiers ?",
      body: [
        "Le contenu, non. Relayium transfère les octets d'origine exactement tels quels — aucune recompression, aucun reformatage, aucune réécriture des fins de ligne entre les deux systèmes d'exploitation — et un dossier conserve ses chemins relatifs. Deux choses ne franchissent pas la traversée, et elles relèvent du système de fichiers plutôt que du transfert : Windows interdit des caractères que macOS autorise, donc un nom légal sur le Mac peut être impossible à créer sur le PC, et les bits de permission POSIX, la propriété et les attributs étendus macOS ne sont pas repris — le navigateur qui reçoit écrit des fichiers ordinaires sous le modèle de permissions propre à NTFS.",
        "Chaque fichier est vérifié de bout en bout par une empreinte SHA-256, si bien que ce qui arrive sur le PC Windows (ou le Mac) est vérifié identique à ce qui a quitté l'autre machine. Les gros fichiers sont bien gérés aussi : un navigateur doté de l'API File System Access — Chrome ou Edge sur ordinateur — diffuse le téléchargement directement sur le disque, sans limite de taille. Firefox et Safari n'ont pas cette API : un lot reçu là est assemblé en mémoire, et Relayium vous prévient avant que vous acceptiez dès que l'on dépasse environ 256 Mo. Ce chiffre est une estimation volontairement prudente, pas une limite mesurée — le point de rupture réel dépend de la mémoire de la machine, de son système et de tout ce qui tourne à côté.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je installer quelque chose sur le Mac ou sur le PC Windows ?",
        a: "Non. Relayium fonctionne entièrement dans le navigateur, sur macOS comme sur Windows. Ouvrez relayium.com sur chaque machine et vous êtes prêt — aucun téléchargement dans les deux cas. Sur le même réseau, un transfert ne demande aucun compte du tout ; s'appairer via Internet demande seulement que l'expéditeur se connecte.",
      },
      {
        q: "Les deux ordinateurs doivent-ils être sur le même réseau ?",
        a: "Non. Être sur le même réseau est la voie la plus rapide car les deux machines se découvrent automatiquement, mais un code d'appairage connecte tout aussi bien un Mac et un PC Windows via Internet — même depuis des villes différentes. Dans les deux cas, le transfert reste chiffré de bout en bout ; la voie entre réseaux différents demande seulement que l'expéditeur se connecte d'abord, et le destinataire n'a jamais besoin de compte.",
      },
      {
        q: "Puis-je envoyer un dossier entier, pas seulement des fichiers isolés ?",
        a: "Oui. Glissez un dossier, et Relayium envoie jusqu'à 1 000 fichiers dans le lot, en conservant la structure du dossier. Chrome et Edge sous Windows l'écrivent directement dans un répertoire choisi ; si le navigateur du destinataire ne peut pas écrire de dossiers directement, il arrive sous forme d'un seul .zip avec la même arborescence.",
      },
      {
        q: "Les permissions de fichiers, fins de ligne ou noms de fichiers sont-ils altérés en passant de Mac à Windows ?",
        a: "Les octets et le chemin relatif à l'intérieur d'un dossier restent inchangés et sont vérifiés par une empreinte SHA-256 de bout en bout, si bien que rien ne touche aux fins de ligne ni à l'encodage — tout ce qu'une conversion au niveau applicatif devrait gérer (comme CRLF contre LF dans un fichier texte) reste inchangé, car le fichier lui-même reste inchangé. Deux choses ne passent vraiment pas : un nom contenant l'un des caractères interdits par Windows ne peut pas être créé sur le PC, et les permissions POSIX, la propriété et les attributs étendus macOS ne sont pas transférés, car le navigateur qui reçoit écrit des fichiers ordinaires sous le modèle propre à NTFS.",
      },
      {
        q: "Y a-t-il une limite de taille ?",
        a: "Jusqu'à 1 000 fichiers par lot. Il n'y a aucune limite de taille côté serveur — Chrome et Edge sur ordinateur diffusent directement sur le disque. Firefox et Safari n'ont pas l'API File System Access : un lot reçu dans l'un d'eux est gardé en mémoire, et Relayium prévient au-delà d'environ 256 Mo — une estimation prudente plutôt qu'une limite ferme, le plafond réel dépendant de la mémoire de la machine et de ce qu'elle fait par ailleurs.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur votre Mac et votre PC Windows et envoyez vos premiers fichiers — sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "نقل الملفات بين جهاز Mac وحاسوب Windows",
  description:
    "كيفية إرسال الملفات بين macOS وWindows دون ذاكرة فلاش، ولا مجلد شبكة مشترك، ولا رفع إلى السحابة. على نفس الشبكة وعبر الإنترنت معًا — لا شيء لتثبيته على أي من الجهازين.",
  updatedLabel: "آخر تحديث",
  lead: [
    "لا يتكلم جهازا Mac وPC اللغة نفسها لمشاركة الملفات جاهزَين. فـ AirDrop حكرٌ على Apple، ومشاركة الشبكة في Windows تريد أن يكون الجهازان في مجموعة عمل أو نطاق متطابق، وأيٌّ منهما ليس سهل الإعداد تمامًا في خمس دقائق حين تريد فقط نقل مجلد واحد من ملفات مشروع من MacBook إلى سطح مكتب Windows.",
    "يتجاوز Relayium مسألة التوافق برمّتها. افتح الصفحة نفسها على الجهازين: داخل شبكة LAN نفسها تنتقل الملفات المشفَّرة من الطرف إلى الطرف مباشرةً، وعبر الشبكات ينقل مُرحِّل TURN نصًا مشفّرًا لا يستطيع قراءته أو فك تشفيره ولا يحتفظ بنسخة أو سجل للمحتوى الآني. لا حاجة إلى تثبيت شيء؛ يسجّل منشئ الاقتران عبر الشبكات الدخول، ولا يحتاج المنضم إلى حساب. إليك تحديدًا كيف يعمل الأمر في كلا الاتجاهين.",
  ],
  sections: [
    {
      heading: "ما تحتاج إليه قبل أن تبدأ",
      body: [
        "لا شيء لتثبيته على الـ Mac أو الـ PC. على نفس الشبكة لا يوجد ما تسجّل الاشتراك فيه أيضًا — المتصفح يتولى كل شيء.",
      ],
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "جهاز Mac بمتصفح Safari أو Chrome، وحاسوب Windows بمتصفح Edge أو Chrome — أي متصفح حديث على أي من الجانبين.",
          "لأبسط طريق، الجهازان على نفس شبكة Wi-Fi أو Ethernet. ولا مشكلة في الخلط بينهما: فحاسوب Windows موصول بسلك وجهاز Mac على نفس الموجّه يتشاركان عنوان IP عامًا واحدًا، وهو ما يضعهما في الغرفة نفسها.",
          "الصفحة مفتوحة عبر https://relayium.com/ على الجهازين. يحتاج النقل المشفَّر إلى HTTPS، وعبر http:// المجرّد تقول الصفحة ذلك بدل أن تسرد الأجهزة.",
          "للدفعات الكبيرة، استخدم Chrome أو Edge على الجهاز المستقبِل. فهما وحدهما يبثّان إلى القرص مباشرةً ويتيحان لك اختيار مجلد الوجهة أولًا — أما Safari فلا يملك تلك الواجهة ويضطر إلى تجميع الدفعة في الذاكرة.",
          "الملفات أو المجلدات المراد إرسالها — حتى 1,000 ملف لكل دفعة.",
        ],
      },
    },
    {
      heading: "Mac وPC على نفس الشبكة",
      body: [
        "إذا كان الحاسوبان على نفس شبكة المكتب أو المنزل، فهذه أسرع طريقة لنقل الملفات — لا قرص مشترك لتوصيله، ولا أذونات للمصارعة معها.",
      ],
      steps: [
        {
          text: "على الـ Mac، افتح صفحة النقل في المتصفح. وعلى حاسوب Windows، افتح العنوان نفسه.",
          code: ["https://relayium.com/"],
        },
        {
          text: "قارن عنوان IP العام في شريط الحالة على الجهازين. مشاركة عنوان واحد هي ما يضعهما في الغرفة نفسها، وإذا أعلن جهازان على شبكة مكتب واحدة عنوانين مختلفين، فالسبب في الغالب شبكة VPN للشركة على حاسوب العمل.",
          code: ["متصل · هذا الجهاز MacBook · عنوان IP العام 203.0.113.9"],
        },
        {
          text: "يظهر الآن كل جهاز للآخر تحت «الأجهزة القريبة» — لا إعداد لمجموعة عمل Windows، ولا مشاركة ملفات macOS لتفعيلها. على الحاسوب المُرسِل، انقر على الآخر واضغط «فتح مساحة العمل». في المتصفحات الحديثة هذا هو الإجراء الوحيد الذي تعرضه البطاقة، لأن الملفات والمجلدات والرسائل تمرّ كلها عبر الاتصال المشفَّر الواحد الذي تفتحه.",
        },
        {
          text: "تحلّ مساحة العمل مكان تلك البطاقة. أرسِل من عناصر التحكم أسفل ترويستها: «إرسال ملفات» لدفعة تصل إلى 1,000 ملف، و«إرسال مجلد» لشجرة كاملة، أو اكتب في صندوق الرسائل — «Enter لسطر جديد · ⌘/Ctrl+Enter للإرسال» — ثم اضغط «إرسال». وعلى الطرف المستقبِل، اقرأ السطر أسفل الطلب: في Chrome أو Edge يقول إن المتصفح سيسأل عن مكان الحفظ، أي أنك تختار المجلد بنفسك؛ وفي Safari أو Firefox يقول إن الملفات ستذهب إلى تنزيلات المتصفح نفسه. ثم اضغط «قبول».",
        },
        {
          text: "راقب عدّاد الملفات حتى يبلغ آخر ملف على الشاشتين. وإن أردت مقارنة رمز التحقق (SAS) قبل أن يتحرك أي بايت، فعّل «التحقّق المتقدّم» على الجهازين أولًا: التطابق يؤكد انضمامهما إلى جلسة واحدة مشفَّرة من الطرف إلى الطرف، ولا يثبت مسار الشبكة الذي يحمله النص المشفّر. وإن تركته معطَّلًا تظل الجلسة مشفَّرة، لكن دون رمز تقارنه.",
        },
      ],
      success: {
        label: "كيف يبدو نقل ناجح",
        body: [
          "تكون بطاقة الجهاز الآخر قد اختفت عند هذه اللحظة — إذ حلّت مساحة العمل مكانها — فتُقرأ الحالة من ترويسة مساحة العمل: الجهاز المتصل بك، وحالة رابط تقول «متصل»، ووسم مسار واحد يقرأ «مباشر عبر LAN». ويتوقف العدّاد عند آخر ملف في الدفعة.",
          "وفي المجلد الذي اخترته تصل الشجرة بمساراتها النسبية سليمة. ولا يُستبدَل اسم موجود أصلًا في مجلد الوجهة ذاك: إذ يحلّ report.pdf بجانبه باسم report (1).pdf. وإعادة التسمية هذه من عمل Relayium نفسه، ولا تنطبق إلا حيث سلّمنا المتصفح مجلدًا نكتب فيه — أي Chrome أو Edge بمنتقي المجلدات. وبدون المنتقي تعود التسمية إلى مدير التنزيلات في ذلك المتصفح، وتقرأ النتيجة في قائمته الخاصة: chrome://downloads في Chrome، وedge://downloads في Edge، وabout:downloads في Firefox.",
        ],
        code: ["متصل بـ ThinkPad · متصل · مباشر عبر LAN\nالملف 12/12"],
      },
    },
    {
      heading: "عندما لا يرى أحد الجهازين الآخر",
      body: [
        "في هذا الثنائي تُعدّ شبكة VPN للعمل وشبكة المكتب المُدارة أول ما يستحق الفحص. وهما فحصان أوليان شائعان لا قائمة شاملة، وكل ما يلي يُحسَم بشيء معروض على الشاشة أصلًا، لا بمراسلة الدعم.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "لا يظهر أي من الجهازين تحت «الأجهزة القريبة» مع أن كليهما على شبكة Wi-Fi في المكتب.",
            code: ["https://relayium.com/   # قارن عنوان IP العام في شريط الحالة على الجهازين"],
            fix: "عنوانا IP عامان مختلفان يعنيان غرفتين، وشبكة VPN للشركة سبب شائع: فهي تُخرِج أحد الجهازين من عنوان الشركة بينما يخرج الآخر من موجّه المكتب. وشبكة ضيوف تخرج من مكان آخر سبب شائع ثانٍ، وليسا السببين الوحيدين. فإن كنت مستعدًا لتغييرهما، اقطع VPN على ذلك الجهاز أو اترك شبكة الضيوف، ثم أعِد تحميل https://relayium.com/ عليه. وإن كان لا بد أن تبقى VPN عاملة، فرمز اقتران على https://relayium.com/cross-network يصل إلى الجهاز الآخر دون قطعها.",
          },
          {
            symptom: "يعرض الجهازان نفس عنوان IP العام ولا تظهر أي بطاقة.",
            code: ["https://relayium.com/   # التلميح أسفل قائمة الأجهزة يسمّي إعداد الموجّه"],
            fix: "الشبكة تفصل عملاءها عن بعضهم. على موجّه تملكه، أوقف «عزل نقطة الوصول / عزل العملاء»؛ وعلى شبكة مكتب مُدارة لا تستطيع تغييرها، اقرن الجهازين برمز من https://relayium.com/cross-network بدلًا من ذلك.",
          },
          {
            symptom: "قبل القبول، يحذّر جهاز Mac من أنه سيحمل الدفعة كلها في الذاكرة.",
            code: ["https://relayium.com/   # السطر أسفل الطلب يذكر كيف سيحفظ هذا المتصفح"],
            fix: "لا يملك Safari واجهة File System Access، فيخزّن الدفعة مؤقتًا بدل كتابتها، ويحذّر Relayium بعد نحو 256 MiB. استقبل الدفعة نفسها في Chrome أو Edge على ذلك الـ Mac: فهو يبثّ كل ملف إلى القرص مباشرةً ويسألك عن مجلد الوجهة أولًا.",
          },
          {
            symptom: "يفشل ملف واحد من نقل مجلد على جانب Windows بينما يصل الباقي.",
            code: ["https://relayium.com/   # يذكر العدّاد الملف الذي توقّف عنده"],
            fix: "يمنع Windows المحارف \\ / : * ? \" < > | في أسماء الملفات ولا يمنعها macOS، فالاسم المشروع على الـ Mac قد يكون إنشاؤه مستحيلًا على الـ PC. أعِد تسمية ذلك الملف على الـ Mac ثم أرسِله مرة أخرى؛ والنقطتان في تاريخ مثل 2026:08:05 هما الحالة الأكثر شيوعًا.",
          },
          {
            symptom: "النقل يعمل، لكن الوسم يقرأ «مباشر P2P» بدل «مباشر عبر LAN».",
            code: ["https://relayium.com/   # اقرأ وسم المسار في ترويسة مساحة العمل"],
            fix: "الجهازان يتشاركان عنوان IP عامًا دون أن يتشاركا قفزة محلية، وهذا تمامًا شكل شبكتين افتراضيتين خلف وصلة صاعدة واحدة في المكتب. يبقى النقل مباشرًا ويبقى مشفَّرًا من الطرف إلى الطرف، وإن أردت أن يكون المسار شبكتك المحلية لا الطريق الذي وجده المتصفحان، فضعهما في الشبكة الفرعية نفسها.",
          },
        ],
      },
    },
    {
      heading: "Mac وPC على شبكتين مختلفتين",
      body: [
        "تعمل من المنزل بينما الجهاز الآخر في المكتب، أو مجرد على شبكة Wi-Fi مختلفة؟ يوصِل رمز الاقتران جهاز Mac وحاسوب Windows عبر الإنترنت، لا عبر الغرفة فحسب. غير أن غرفة رمز الاقتران واجهة منفصلة عن مساحة عمل جهاز قريب: فهي تحتفظ بعناصر التحكم الأقدم المنفصلة لكل جهاز، ولا يوجد فيها «فتح مساحة العمل» لتضغطه.",
        "يولّد الحاسوب المُرسِل رمز اقتران قصيرًا (أو رابط مشاركة)؛ أدخِله على الجهاز الآخر للاتصال. والنقل عبر الشبكات يجري عبر مُرحِّل TURN مشفَّر لا عبر وصلة مباشرة بين الحاسوبين، وهذا مقصود بحكم التصميم: فالجلسة تسلك المُرحِّل من البداية، فلا يعتمد انعقاد الاتصال على إيجاد مسار مباشر عبر ما بين الشبكتين من شبكات NAT وجدران حماية، وهي قد تمنع مثل هذا المسار. ولا يُمرِّر المُرحِّل سوى نص مُشفَّر — فالملفات مختومة من الطرف إلى الطرف قبل أن تغادر الحاسوب المُرسِل، فلا يصله شيء يمكن قراءته. وإذا انقطع الاتصال في منتصف مجلد كبير، يستأنف بدلًا من البدء من جديد. يحتاج هذا الوضع إلى تسجيل دخول المُرسِل؛ أما من يستقبل فلا يحتاج أبدًا إلى حساب.",
      ],
    },
    {
      heading: "إرسال مجلد كامل، لا ملفات مفردة فحسب",
      body: [
        "نقل مجلد مشروع من Mac إلى Windows (أو العكس) يعني عادةً ضغطه أولًا. يستطيع Relayium إرسال مجلد مباشرةً، مع الحفاظ على بنيته سليمة.",
      ],
      bullets: [
        "على الـ Mac، اسحب مجلدًا إلى الداخل، أو اختره من مربع حوار الملفات — حتى 1,000 ملف في الدفعة.",
        "على حاسوب Windows يستخدم Edge أو Chrome، يُكتَب المجلد الوارد مباشرةً إلى دليل تختاره، مع الحفاظ على البنية.",
        "إذا كان المتصفح المستقبِل لا يدعم كتابة المجلدات مباشرةً، يصل المجلد كملف .zip واحد يُفكّ إلى البنية نفسها.",
      ],
    },
    {
      heading: "طرق أخرى لنقل الملفات بين Mac وWindows",
      body: [
        "ليس Relayium الخيار الوحيد — إليك المقايضات الصادقة للبدائل المعتادة:",
      ],
      bullets: [
        "تعمل ذاكرة فلاش USB دون اتصال، لكن macOS وWindows لا يتفقان دائمًا على نظام ملفات دون إعادة تهيئة، وهي غرض مادي إضافي عليك تتبّعه.",
        "يمكن لمشاركة شبكة Windows (SMB) الوصول إلى Mac، لكن إعداد مجموعات العمل والأذونات وقواعد جدار الحماية لنقل لمرة واحدة إعدادٌ يفوق قيمة النقل نفسه.",
        "يعمل قرص سحابي (OneDrive أو iCloud أو Google Drive) حين يكون الطرف الآخر غير متصل، لكن الملف يُرفَع ثم يُنزَّل، ويُحتسَب على حصة تخزينك، ويحتفظ المزوّد بنسخة.",
        "البريد الإلكتروني وتطبيقات الدردشة مريحة لكنها تحدّ عادةً من حجم المرفق وليست مشفَّرة من الطرف إلى الطرف لمشاركة الملفات.",
      ],
    },
    {
      heading: "هل يتغير أي شيء في الملفات؟",
      body: [
        "المحتوى لا يتغيّر. ينقل Relayium البايتات الأصلية كما هي تمامًا — دون إعادة ضغط، ودون إعادة تهيئة، ودون إعادة كتابة نهايات الأسطر بين نظامَي التشغيل — ويحافظ المجلد على مساراته النسبية. لكن هناك أمران لا يعبران، وكلاهما يتعلق بنظام الملفات لا بالنقل: يمنع Windows محارف يسمح بها macOS، فالاسم المشروع على الـ Mac قد يكون إنشاؤه مستحيلًا على الـ PC؛ كما أن بتات أذونات POSIX والملكية وسمات macOS الممتدة لا تُنقَل — فالمتصفح المستقبِل يكتب ملفات عادية وفق نموذج أذونات NTFS نفسه.",
        "يُفحَص كل ملف من الطرف إلى الطرف بتجزئة SHA-256، فما يحطّ على حاسوب Windows (أو الـ Mac) مُتحقَّق من تطابقه تمامًا مع ما غادر الجهاز الآخر. وتُعالَج الملفات الكبيرة جيدًا أيضًا: المتصفح الذي يدعم واجهة File System Access — ‏Chrome أو Edge على الحاسوب — يبثّ التنزيل مباشرةً إلى القرص دون سقف للحجم. أما Firefox وSafari فلا تملكان تلك الواجهة، فتُجمَّع الدفعة المستلمة هناك في الذاكرة، وينبّهك Relayium قبل القبول متى تجاوزت نحو 256 ميغابايت. وهذا الرقم تقدير متحفّظ عن قصد لا حدٌّ مقيس — فنقطة الانهيار الفعلية تتوقف على ذاكرة الجهاز ونظامه وما هو مفتوح غير ذلك.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى تثبيت أي شيء على الـ Mac أو حاسوب Windows؟",
        a: "لا. يعمل Relayium كليًا في المتصفح على كلٍّ من macOS وWindows. افتح relayium.com على كل جهاز وأنت جاهز — لا شيء للتنزيل في أي من الحالتين. على نفس الشبكة لا يحتاج النقل إلى حساب على الإطلاق؛ والاقتران عبر الإنترنت يطلب من المُرسِل فقط تسجيل الدخول.",
      },
      {
        q: "هل يجب أن يكون الحاسوبان على نفس الشبكة؟",
        a: "لا. أن تكونا على نفس الشبكة هو الطريق الأسرع لأن الجهازين يجدان بعضهما تلقائيًا، لكن رمز الاقتران يوصِل جهاز Mac وحاسوب Windows عبر الإنترنت بالمثل تمامًا — حتى من مدن مختلفة. في كلتا الحالتين يبقى النقل مشفَّرًا من الطرف إلى الطرف؛ ومسار عبر الشبكات يطلب فقط أن يسجّل المُرسِل الدخول أولًا، ولا يحتاج المُستقبِل أبدًا إلى حساب.",
      },
      {
        q: "هل يمكنني إرسال مجلد كامل، لا ملفات مفردة فحسب؟",
        a: "نعم. اسحب مجلدًا إلى الداخل فيرسل Relayium حتى 1,000 ملف في الدفعة، مع الحفاظ على بنية المجلد. يكتب Chrome وEdge على Windows مباشرةً إلى دليل مختار؛ وإذا كان المتصفح المستقبِل لا يستطيع كتابة المجلدات مباشرةً، يصل كملف .zip واحد بالبنية نفسها.",
      },
      {
        q: "هل تتشوّه أذونات الملفات أو نهايات الأسطر أو أسماء الملفات عند الانتقال من Mac إلى Windows؟",
        a: "البايتات والمسار النسبي داخل المجلد تبقى دون تغيير، ويُتحقَّق منها بتجزئة SHA-256 من الطرف إلى الطرف، فلا يُمَسّ شيء من نهايات الأسطر أو الترميز — وأي شيء قد يحتاج تحويلٌ على مستوى التطبيق إلى معالجته (مثل CRLF مقابل LF في ملف نصي) يبقى دون تغيير لأن الملف نفسه لم يتغير. لكن هناك أمران لا يعبران فعلًا: الاسم الذي يحتوي أحد المحارف التي يمنعها Windows لا يمكن إنشاؤه على الـ PC أصلًا، وأذونات POSIX والملكية وسمات macOS الممتدة لا تُنقَل، لأن المتصفح المستقبِل يكتب ملفات عادية وفق نموذج NTFS نفسه.",
      },
      {
        q: "هل هناك حد للحجم؟",
        a: "حتى 1,000 ملف لكل دفعة. لا يوجد سقف للحجم من جهة الخادم إطلاقًا — يبثّ Chrome وEdge على الحاسوب مباشرةً إلى القرص. أما Firefox وSafari فتنقصهما واجهة File System Access، فتُحفَظ الدفعة المستلمة فيهما بالذاكرة، وينبّهك Relayium فوق نحو 256 ميغابايت — وهو تقدير متحفّظ لا حدٌّ صارم، إذ يتوقف السقف الحقيقي على ذاكرة الجهاز وما يشغّله إلى جانب ذلك.",
      },
    ],
  },
  cta: {
    text: "افتح Relayium على جهاز Mac وحاسوب Windows وانقل أول ملفاتك — دون تثبيت، ودون حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Transferir archivos entre un Mac y un PC con Windows",
  description:
    "Cómo enviar archivos entre macOS y Windows sin una memoria USB, una carpeta de red compartida ni una subida a la nube. En la misma red y por internet — nada que instalar en ninguna de las dos máquinas.",
  updatedLabel: "Última actualización",
  lead: [
    "Los Mac y los PC no hablan el mismo idioma de uso compartido de archivos de fábrica. AirDrop es solo de Apple, el uso compartido de red de Windows quiere que ambas máquinas estén en un grupo de trabajo o dominio coincidente, y ninguna de las dos es precisamente fácil de configurar en cinco minutos cuando solo quieres mover una carpeta de archivos de proyecto de un MacBook a un equipo de escritorio con Windows.",
    "Relayium esquiva toda la cuestión de la compatibilidad. Abre la misma página en ambos ordenadores: en la misma LAN los archivos cifrados de extremo a extremo viajan directamente; entre redes, un relé TURN solo transporta texto cifrado que no puede leer ni descifrar y no conserva copia ni historial del contenido en tiempo real. No hay nada que instalar; en el emparejamiento entre redes inicia sesión el creador y quien se une nunca necesita cuenta. Aquí tienes exactamente cómo funciona en ambas direcciones.",
  ],
  sections: [
    {
      heading: "Qué necesitas antes de empezar",
      body: [
        "Nada que instalar en el Mac ni en el PC. En la misma red tampoco hay nada que registrar — el navegador se encarga de todo.",
      ],
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Un Mac con Safari o Chrome, y un PC con Windows con Edge o Chrome — cualquier navegador moderno en cualquiera de los dos lados.",
          "Para la vía más sencilla, ambas máquinas en la misma red Wi-Fi o Ethernet. Mezclarlas no es problema: un PC por cable y un Mac detrás del mismo router siguen compartiendo una IP pública, y es ella la que los mete en la misma sala.",
          "La página abierta mediante https://relayium.com/ en las dos. La transferencia cifrada necesita HTTPS, y con http:// a secas la página lo dice en lugar de listar dispositivos.",
          "Para un lote grande, Chrome o Edge en la máquina que recibe. Solo esos dos pueden escribir directamente al disco y dejarte elegir antes una carpeta de destino — Safari no tiene esa API y debe montar el lote en memoria.",
          "Los archivos o carpetas a enviar — hasta 1.000 archivos por lote.",
        ],
      },
    },
    {
      heading: "Mac y PC en la misma red",
      body: [
        "Si ambos ordenadores están en la misma red de oficina o de casa, esta es la forma más rápida de mover archivos — ninguna unidad compartida que montar, ningún permiso contra el que pelear.",
      ],
      steps: [
        {
          text: "En el Mac, abre la página de transferencia en el navegador. En el PC con Windows, abre la misma dirección.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compara la IP pública de la línea de estado en las dos máquinas. Compartir una dirección es lo que las mete en la misma sala. Si dos máquinas de una misma red de oficina anuncian direcciones distintas, una VPN corporativa en el portátil de trabajo es una causa común, aunque no la única.",
          code: ["Conectado · este dispositivo MacBook · IP pública 203.0.113.9"],
        },
        {
          text: "Ahora cada máquina aparece en la otra bajo «Dispositivos cercanos» — sin configurar un grupo de trabajo de Windows, sin habilitar el uso compartido de archivos de macOS. En el ordenador que envía, haz clic en el otro y pulsa «Abrir espacio de trabajo». En un navegador actual esa es la única acción que ofrece la tarjeta, porque archivos, carpetas y mensajes viajan todos por la única conexión cifrada que abre.",
        },
        {
          text: "El espacio de trabajo sustituye a esa tarjeta. Envía desde los controles bajo su encabezado: «Enviar archivos» para un lote de hasta 1.000, «Enviar una carpeta» para un árbol completo, o escribe en el cuadro de mensaje — «Enter para una nueva línea · ⌘/Ctrl+Enter para enviar» — y pulsa «Enviar». En el lado que recibe, lee la línea bajo la solicitud: en Chrome o Edge dice que el navegador preguntará dónde guardar, así que eliges la carpeta tú mismo, y en Safari o Firefox dice que los archivos irán a las descargas del propio navegador. Después pulsa «Aceptar».",
        },
        {
          text: "Observa cómo el contador llega al último archivo en las dos pantallas. Para comparar un código de verificación (SAS) antes de que se mueva un byte, activa primero «Verificación avanzada» en las dos máquinas: una coincidencia confirma que ambas se unieron a la misma sesión cifrada de extremo a extremo, no la ruta de red que transporta el texto cifrado. Si la dejas desactivada, la sesión sigue cifrada y simplemente no hay código que comparar.",
        },
      ],
      success: {
        label: "Qué se ve cuando la transferencia funciona",
        body: [
          "A esas alturas la tarjeta de la otra máquina ya no está — el espacio de trabajo ocupó su lugar —, así que el estado se lee en el encabezado del espacio de trabajo: la máquina a la que estás conectado, un estado de enlace «Conectado» y una única etiqueta de ruta que marca «Directo por LAN». El contador termina en el último archivo del lote.",
          "En la carpeta que elegiste, el árbol llega con sus rutas relativas intactas. Un nombre que ya esté en ese directorio de destino no se sobrescribe: report.pdf aterriza al lado como report (1).pdf. Ese renombrado es propio de Relayium y solo se aplica allí donde el navegador nos entregó un directorio en el que escribir — Chrome o Edge con el selector de carpeta. Sin selector, el nombrado pertenece al gestor de descargas de ese navegador, y el resultado se lee en su propia lista: chrome://downloads en Chrome, edge://downloads en Edge, about:downloads en Firefox.",
        ],
        code: ["Conectado a ThinkPad · Conectado · Directo por LAN\nArchivo 12/12"],
      },
    },
    {
      heading: "Cuando una máquina no ve a la otra",
      body: [
        "En esta pareja, una VPN de trabajo y una red de oficina gestionada son las dos que conviene comprobar primero. Son comprobaciones iniciales habituales más que la lista completa, y todo lo de abajo se decide con algo que ya está en pantalla y no con una incidencia de soporte.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "Ninguna de las dos máquinas aparece bajo «Dispositivos cercanos», aunque las dos están en la Wi-Fi de la oficina.",
            code: ["https://relayium.com/   # compara la IP pública de la línea de estado en las dos máquinas"],
            fix: "Dos direcciones IP públicas distintas son dos salas, y una VPN corporativa es una causa común: saca una máquina por la dirección de la empresa mientras la otra sale por el router de la oficina. Un SSID de invitados que sale por otro lado es otra, y no son las únicas. Si estás dispuesto a cambiarlas, desconecta la VPN en esa máquina o abandona el SSID de invitados, y recarga https://relayium.com/ ahí. Si la VPN tiene que seguir levantada, un código de emparejamiento en https://relayium.com/cross-network llega a la otra máquina sin desconectarla.",
          },
          {
            symptom: "Las dos máquinas muestran la misma IP pública y no aparece ninguna tarjeta.",
            code: ["https://relayium.com/   # la indicación bajo la lista de dispositivos nombra el ajuste del router"],
            fix: "La red separa a sus propios clientes. En un router que sea tuyo, desactiva «aislamiento de AP / aislamiento de clientes»; en una red de oficina gestionada que no puedes cambiar, empareja las dos máquinas con un código en https://relayium.com/cross-network.",
          },
          {
            symptom: "Antes de aceptar, el Mac avisa de que tiene que sostener todo el lote en memoria.",
            code: ["https://relayium.com/   # la línea bajo la solicitud dice cómo va a guardar este navegador"],
            fix: "Safari no tiene la API File System Access, así que almacena el lote en vez de escribirlo, y Relayium avisa a partir de unos 256 MiB. Recibe el mismo lote en Chrome o Edge en ese Mac: escribe cada archivo directamente al disco y te pide antes una carpeta de destino.",
          },
          {
            symptom: "Un archivo de una transferencia de carpeta falla en el lado Windows mientras el resto llega.",
            code: ["https://relayium.com/   # el contador nombra el archivo en el que se detiene"],
            fix: "Windows prohíbe los caracteres \\ / : * ? \" < > | en un nombre de archivo y macOS no, así que un nombre legal en el Mac puede ser imposible de crear en el PC. Renombra ese archivo en el Mac y envíalo de nuevo; los dos puntos de una fecha como 2026:08:05 son el caso más frecuente.",
          },
          {
            symptom: "La transferencia funciona, pero la etiqueta marca «Directo P2P» en lugar de «Directo por LAN».",
            code: ["https://relayium.com/   # lee la etiqueta de ruta en el encabezado del espacio de trabajo"],
            fix: "Las dos máquinas comparten una IP pública sin compartir un salto local, que es exactamente el aspecto de dos VLAN detrás de un mismo enlace de subida de oficina. La transferencia sigue siendo directa y sigue cifrada de extremo a extremo; pon las dos en la misma subred si quieres que la ruta sea tu LAN y no el camino que encontraron los navegadores.",
          },
        ],
      },
    },
    {
      heading: "Mac y PC en redes distintas",
      body: [
        "¿Trabajas desde casa mientras la otra máquina está en la oficina, o simplemente en una red Wi-Fi distinta? Un código de emparejamiento conecta un Mac y un PC con Windows a través de internet, no solo de un lado a otro de la habitación. Eso sí, una sala con código de emparejamiento es una superficie distinta de un espacio de trabajo con un dispositivo cercano: conserva los controles anteriores separados por dispositivo, así que allí no hay ningún «Abrir espacio de trabajo» que pulsar.",
        "El ordenador que envía genera un código de emparejamiento corto (o un enlace para compartir); introdúcelo en la otra máquina para conectar. Una transferencia entre redes va por un retransmisor TURN cifrado en lugar de por un enlace directo entre las dos máquinas, y es a propósito: la sesión toma el retransmisor desde el principio, de modo que la conexión no depende de encontrar una ruta directa a través de los NAT y cortafuegos que hay entre las dos redes, que pueden impedirla. El retransmisor solo reenvía texto cifrado — los archivos van sellados de extremo a extremo antes de salir de la máquina emisora, así que no le llega nada legible. Si la conexión se cae a mitad de una carpeta grande, se reanuda en lugar de empezar de nuevo. Este modo necesita que el remitente inicie sesión; quien recibe nunca necesita una cuenta.",
      ],
    },
    {
      heading: "Enviar una carpeta entera, no solo archivos sueltos",
      body: [
        "Mover una carpeta de proyecto de Mac a Windows (o al revés) suele implicar comprimirla primero. Relayium puede enviar una carpeta directamente, manteniendo su estructura intacta.",
      ],
      bullets: [
        "En el Mac, arrastra una carpeta, o elígela desde el diálogo de archivos — hasta 1.000 archivos en el lote.",
        "En un PC con Windows usando Edge o Chrome, la carpeta entrante se escribe directamente en un directorio que elijas, con la estructura preservada.",
        "Si el navegador que recibe no admite escribir carpetas directamente, la carpeta llega como un único .zip que se descomprime con la misma disposición.",
      ],
    },
    {
      heading: "Otras formas de mover archivos entre Mac y Windows",
      body: [
        "Relayium no es la única opción — aquí están las concesiones reales de las alternativas habituales:",
      ],
      bullets: [
        "Una memoria USB funciona sin conexión, pero macOS y Windows no siempre se ponen de acuerdo en un sistema de archivos sin reformatear, y es un objeto físico más del que estar pendiente.",
        "El uso compartido de red de Windows (SMB) puede llegar a un Mac, pero configurar grupos de trabajo, permisos y reglas de cortafuegos para una transferencia puntual es más trabajo del que vale la transferencia.",
        "Una unidad en la nube (OneDrive, iCloud, Google Drive) funciona cuando la otra persona está desconectada, pero el archivo se sube y luego se descarga, se descuenta de tu cuota de almacenamiento y el proveedor guarda una copia.",
        "El correo y las apps de chat son cómodos, pero suelen limitar el tamaño del adjunto y no están cifrados de extremo a extremo para compartir archivos.",
      ],
    },
    {
      heading: "¿Cambiará algo en los archivos?",
      body: [
        "El contenido no. Relayium transfiere los bytes originales exactamente como están — sin recompresión, sin reformateo, sin reescribir los fines de línea entre los dos sistemas operativos — y una carpeta conserva sus rutas relativas. Dos cosas sí que no cruzan, y ambas pertenecen al sistema de archivos y no a la transferencia: Windows prohíbe caracteres que macOS permite, así que un nombre legal en el Mac puede ser imposible de crear en el PC, y los bits de permiso POSIX, la propiedad y los atributos extendidos de macOS no se llevan consigo — el navegador que recibe escribe archivos normales bajo el propio modelo de permisos de NTFS.",
        "Cada archivo se comprueba de extremo a extremo con un hash SHA-256, así que lo que llega al PC con Windows (o al Mac) queda verificado como idéntico a lo que salió de la otra máquina. Los archivos grandes también se manejan bien: un navegador con la API File System Access — Chrome o Edge de escritorio — transmite la descarga directamente al disco, sin límite de tamaño. Firefox y Safari no tienen esa API, así que un lote recibido ahí se acumula en memoria y Relayium te avisa antes de que aceptes en cuanto se pasa de unos 256 MB. Esa cifra es una estimación deliberadamente prudente, no un límite medido: dónde falla de verdad depende de la memoria de la máquina, de su sistema y de qué más tengas abierto.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito instalar algo en el Mac o en el PC con Windows?",
        a: "No. Relayium funciona por completo en el navegador tanto en macOS como en Windows. Abre relayium.com en cada máquina y estás listo — nada que descargar en ningún caso. En la misma red una transferencia no necesita cuenta alguna; emparejar por internet solo pide al remitente iniciar sesión.",
      },
      {
        q: "¿Tienen que estar ambos ordenadores en la misma red?",
        a: "No. Estar en la misma red es la vía más rápida porque las dos máquinas se encuentran automáticamente, pero un código de emparejamiento conecta un Mac y un PC con Windows por internet igual de bien — incluso desde ciudades distintas. En cualquier caso la transferencia sigue cifrada de extremo a extremo; la ruta entre redes solo pide que el remitente inicie sesión primero, y quien recibe nunca necesita una cuenta.",
      },
      {
        q: "¿Puedo enviar una carpeta entera, no solo archivos sueltos?",
        a: "Sí. Arrastra una carpeta y Relayium envía hasta 1.000 archivos en el lote, preservando la estructura de la carpeta. Chrome y Edge en Windows la escriben directamente en un directorio elegido; si el navegador que recibe no puede escribir carpetas directamente, llega como un único .zip con la misma disposición.",
      },
      {
        q: "¿Se estropearán los permisos de archivo, los fines de línea o los nombres al pasar de Mac a Windows?",
        a: "Los bytes y la ruta relativa dentro de una carpeta quedan sin cambios y se verifican con un hash SHA-256 de extremo a extremo, así que nada toca los fines de línea ni la codificación — todo lo que una conversión a nivel de aplicación tendría que manejar (como CRLF frente a LF en un archivo de texto) queda sin cambios porque el propio archivo queda sin cambios. Dos cosas realmente no cruzan: un nombre que contenga uno de los caracteres que Windows prohíbe no puede crearse en el PC, y los permisos POSIX, la propiedad y los atributos extendidos de macOS no se transfieren, porque el navegador que recibe escribe archivos normales bajo el propio modelo de NTFS.",
      },
      {
        q: "¿Hay algún límite de tamaño?",
        a: "Hasta 1.000 archivos por lote. No hay ningún límite de tamaño del lado del servidor — Chrome y Edge de escritorio transmiten directamente al disco. Firefox y Safari carecen de la API File System Access, así que un lote recibido en uno de ellos se mantiene en memoria, y Relayium avisa por encima de unos 256 MB — una estimación prudente más que un límite duro, ya que el techo real depende de la memoria de la máquina y de qué más esté ejecutando.",
      },
    ],
  },
  cta: {
    text: "Abre Relayium en tu Mac y en tu PC con Windows y mueve tus primeros archivos — sin instalación, y sin necesidad de cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Transferir arquivos entre um Mac e um PC com Windows",
  description:
    "Como enviar arquivos entre macOS e Windows sem pen drive, sem pasta de rede compartilhada e sem upload para a nuvem. Na mesma rede e pela internet — nada para instalar em nenhuma das máquinas.",
  updatedLabel: "Última atualização",
  lead: [
    "Macs e PCs não falam a mesma língua de compartilhamento de arquivos de fábrica. O AirDrop é só da Apple, o compartilhamento de rede do Windows exige que as duas máquinas estejam em um grupo de trabalho ou domínio compatível, e nenhum dos dois é exatamente fácil de configurar em cinco minutos quando você só quer mover uma pasta de arquivos de projeto de um MacBook para um desktop com Windows.",
    "O Relayium contorna toda a questão da compatibilidade. Abra a mesma página nos dois computadores: na mesma LAN os arquivos criptografados de ponta a ponta viajam diretamente; entre redes, um retransmissor TURN só transporta texto cifrado que não consegue ler nem descriptografar e não mantém cópia nem histórico do conteúdo em tempo real. Não há nada para instalar; no emparelhamento entre redes o criador faz login e quem entra nunca precisa de conta. Veja exatamente como funciona nos dois sentidos.",
  ],
  sections: [
    {
      heading: "O que você precisa antes de começar",
      body: [
        "Nada para instalar no Mac ou no PC. Na mesma rede também não há nada para se cadastrar — o navegador cuida de tudo.",
      ],
      prereqs: {
        label: "O que você precisa",
        items: [
          "Um Mac com Safari ou Chrome e um PC com Windows com Edge ou Chrome — qualquer navegador moderno em qualquer um dos lados.",
          "Para o caminho mais simples, as duas máquinas na mesma rede Wi-Fi ou Ethernet. Misturar as duas não é problema: um PC no cabo e um Mac atrás do mesmo roteador continuam compartilhando um IP público, e é ele que coloca os dois na mesma sala.",
          "A página aberta por https://relayium.com/ nas duas. A transferência criptografada exige HTTPS, e em http:// puro a página diz isso em vez de listar dispositivos.",
          "Para um lote grande, Chrome ou Edge na máquina que recebe. Só esses dois gravam direto no disco e deixam você escolher antes uma pasta de destino — o Safari não tem essa API e precisa montar o lote na memória.",
          "Os arquivos ou pastas a enviar — até 1.000 arquivos por lote.",
        ],
      },
    },
    {
      heading: "Mac e PC na mesma rede",
      body: [
        "Se os dois computadores estiverem na mesma rede do escritório ou de casa, esta é a forma mais rápida de mover arquivos — nenhuma unidade compartilhada para montar e nenhuma briga com permissões.",
      ],
      steps: [
        {
          text: "No Mac, abra a página de transferência no navegador. No PC com Windows, abra o mesmo endereço.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Compare o IP público da linha de status nas duas máquinas. Compartilhar um endereço é o que coloca as duas na mesma sala. Se duas máquinas de uma mesma rede de escritório anunciam endereços diferentes, uma VPN corporativa no notebook de trabalho é uma causa comum, mas não a única.",
          code: ["Conectado · este dispositivo MacBook · IP público 203.0.113.9"],
        },
        {
          text: "Agora cada máquina aparece para a outra em “Dispositivos próximos” — nenhum grupo de trabalho do Windows para configurar, nenhum compartilhamento de arquivos do macOS para ativar. No computador que envia, clique no outro e pressione “Abrir área de trabalho”. Em um navegador atual essa é a única ação que o cartão oferece, porque arquivos, pastas e mensagens passam todos pela única conexão criptografada que ela abre.",
        },
        {
          text: "A área de trabalho toma o lugar daquele cartão. Envie pelos controles abaixo do cabeçalho dela: “Enviar arquivos” para um lote de até 1.000, “Enviar uma pasta” para uma árvore inteira, ou digite na caixa de mensagem — “Enter para uma nova linha · ⌘/Ctrl+Enter para enviar” — e pressione “Enviar”. No lado que recebe, leia a linha abaixo do pedido: no Chrome ou no Edge ela diz que o navegador vai perguntar onde salvar, então você escolhe a pasta, e no Safari ou no Firefox diz que os arquivos vão para os downloads do próprio navegador. Depois clique em “Aceitar”.",
        },
        {
          text: "Acompanhe o contador chegar ao último arquivo nas duas telas. Para comparar um código de verificação (SAS) antes de qualquer byte se mover, ligue primeiro a “Verificação avançada” nas duas máquinas: a coincidência confirma que as duas entraram na mesma sessão criptografada de ponta a ponta, não a rota de rede que transporta o texto cifrado. Se deixar desligada, a sessão continua criptografada e apenas não há código para comparar.",
        },
      ],
      success: {
        label: "Como é uma transferência que funciona",
        body: [
          "A essa altura o cartão da outra máquina já não existe — a área de trabalho ocupou o lugar dele —, então o estado é lido no cabeçalho da área de trabalho: a máquina a que você está conectado, um estado de vínculo “Conectado” e um único selo de caminho indicando “LAN direto”. O contador termina no último arquivo do lote.",
          "Na pasta que você escolheu, a árvore chega com os caminhos relativos intactos. Um nome que já esteja nesse diretório de destino não é sobrescrito: report.pdf cai ao lado como report (1).pdf. Essa renomeação é do próprio Relayium e só vale onde o navegador nos entregou um diretório para gravar — Chrome ou Edge com o seletor de pasta. Sem o seletor, a nomeação é do gerenciador de downloads daquele navegador, e o resultado se lê na lista dele: chrome://downloads no Chrome, edge://downloads no Edge, about:downloads no Firefox.",
        ],
        code: ["Conectado a ThinkPad · Conectado · LAN direto\nArquivo 12/12"],
      },
    },
    {
      heading: "Quando uma máquina não enxerga a outra",
      body: [
        "Nesta dupla, uma VPN de trabalho e uma rede de escritório gerenciada são as duas que vale checar primeiro. São verificações iniciais comuns, não a lista completa, e tudo abaixo se decide com algo que já está na tela, e não com um pedido de suporte.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "Nenhuma das duas máquinas aparece em “Dispositivos próximos”, mesmo com as duas na Wi-Fi do escritório.",
            code: ["https://relayium.com/   # compare o IP público da linha de status nas duas máquinas"],
            fix: "Dois endereços IP públicos diferentes são duas salas, e uma VPN corporativa é uma causa comum: ela faz uma máquina sair pelo endereço da empresa enquanto a outra sai pelo roteador do escritório. Um SSID de visitantes que sai por outro lugar é outra, e não são as únicas. Se você estiver disposto a mudá-las, desconecte a VPN nessa máquina ou saia do SSID de visitantes, e recarregue https://relayium.com/ nela. Se a VPN tiver de continuar de pé, um código de emparelhamento em https://relayium.com/cross-network alcança a outra máquina sem derrubá-la.",
          },
          {
            symptom: "As duas máquinas mostram o mesmo IP público e nenhum cartão aparece.",
            code: ["https://relayium.com/   # a dica abaixo da lista de dispositivos nomeia a configuração do roteador"],
            fix: "A rede está separando os próprios clientes. Em um roteador que seja seu, desative “isolamento de AP / isolamento de clientes”; em uma rede de escritório gerenciada que você não pode mudar, emparelhe as duas máquinas com um código em https://relayium.com/cross-network.",
          },
          {
            symptom: "Antes de aceitar, o Mac avisa que precisa segurar o lote inteiro na memória.",
            code: ["https://relayium.com/   # a linha abaixo do pedido diz como este navegador vai salvar"],
            fix: "O Safari não tem a API File System Access, então guarda o lote em vez de gravá-lo, e o Relayium avisa acima de mais ou menos 256 MiB. Receba o mesmo lote no Chrome ou no Edge nesse Mac: ele grava cada arquivo direto no disco e pede antes uma pasta de destino.",
          },
          {
            symptom: "Um arquivo de uma transferência de pasta falha no lado Windows enquanto o resto chega.",
            code: ["https://relayium.com/   # o contador informa o arquivo em que ele para"],
            fix: "O Windows proíbe os caracteres \\ / : * ? \" < > | em um nome de arquivo e o macOS não, então um nome legal no Mac pode ser impossível de criar no PC. Renomeie esse arquivo no Mac e envie de novo; os dois-pontos de uma data como 2026:08:05 são o caso mais comum.",
          },
          {
            symptom: "A transferência funciona, mas o selo mostra “P2P direto” em vez de “LAN direto”.",
            code: ["https://relayium.com/   # leia o selo de caminho no cabeçalho da área de trabalho"],
            fix: "As duas máquinas compartilham um IP público sem compartilhar um salto local, que é exatamente a cara de duas VLANs atrás do mesmo enlace de subida do escritório. A transferência continua direta e continua criptografada de ponta a ponta; coloque as duas na mesma sub-rede se quiser que o caminho seja a sua LAN e não a rota que os navegadores encontraram.",
          },
        ],
      },
    },
    {
      heading: "Mac e PC em redes diferentes",
      body: [
        "Trabalhando de casa enquanto a outra máquina está no escritório, ou apenas em uma rede Wi-Fi diferente? Um código de emparelhamento conecta um Mac e um PC com Windows pela internet, não só de um lado a outro da sala. Só que uma sala com código de emparelhamento é uma superfície separada de uma área de trabalho com um dispositivo próximo: ela mantém os controles anteriores separados por dispositivo, então não há nenhum “Abrir área de trabalho” para pressionar ali.",
        "O computador que envia gera um código de emparelhamento curto (ou um link de compartilhamento); digite-o na outra máquina para conectar. Uma transferência entre redes passa por um retransmissor TURN criptografado em vez de uma ligação direta entre as duas máquinas, e isso é proposital: a sessão usa o retransmissor desde o início, então a conexão não depende de encontrar uma rota direta através dos NATs e firewalls que existem entre as duas redes, que podem impedi-la. O retransmissor só encaminha texto cifrado — os arquivos são selados de ponta a ponta antes de deixar a máquina que envia, então nada legível chega até ele. Se a conexão cair no meio de uma pasta grande, ela retoma em vez de recomeçar. Esse modo precisa que o remetente faça login; quem recebe nunca precisa de conta.",
      ],
    },
    {
      heading: "Enviar uma pasta inteira, não só arquivos avulsos",
      body: [
        "Mover uma pasta de projeto do Mac para o Windows (ou de volta) geralmente significa compactá-la antes. O Relayium consegue enviar uma pasta diretamente, mantendo sua estrutura intacta.",
      ],
      bullets: [
        "No Mac, arraste uma pasta para dentro, ou escolha uma na caixa de diálogo de arquivos — até 1.000 arquivos no lote.",
        "Em um PC com Windows usando Edge ou Chrome, a pasta que chega é gravada direto em um diretório que você escolhe, com a estrutura preservada.",
        "Se o navegador que recebe não suportar gravar pastas diretamente, a pasta chega como um único .zip que se descompacta com a mesma organização.",
      ],
    },
    {
      heading: "Outras formas de mover arquivos entre Mac e Windows",
      body: [
        "O Relayium não é a única opção — aqui estão as concessões reais das alternativas de sempre:",
      ],
      bullets: [
        "Um pen drive funciona offline, mas macOS e Windows nem sempre concordam sobre um sistema de arquivos sem reformatar, e é mais um objeto físico para não perder de vista.",
        "O compartilhamento de rede do Windows (SMB) consegue alcançar um Mac, mas configurar grupos de trabalho, permissões e regras de firewall para uma transferência única dá mais trabalho do que a transferência vale.",
        "Uma unidade na nuvem (OneDrive, iCloud, Google Drive) funciona quando a outra pessoa está offline, mas o arquivo é enviado e depois baixado, conta contra sua cota de armazenamento e o provedor guarda uma cópia.",
        "E-mail e apps de mensagens são convenientes, mas costumam limitar o tamanho do anexo e não são criptografados de ponta a ponta para compartilhar arquivos.",
      ],
    },
    {
      heading: "Alguma coisa vai mudar nos arquivos?",
      body: [
        "O conteúdo não. O Relayium transfere os bytes originais exatamente como são — sem recompressão, sem reformatação, sem reescrever os fins de linha entre os dois sistemas operacionais — e uma pasta mantém os caminhos relativos. Duas coisas, porém, não fazem a travessia, e as duas pertencem ao sistema de arquivos e não à transferência: o Windows proíbe caracteres que o macOS permite, então um nome legal no Mac pode ser impossível de criar no PC, e os bits de permissão POSIX, a propriedade e os atributos estendidos do macOS não vão junto — o navegador que recebe grava arquivos comuns sob o próprio modelo de permissões do NTFS.",
        "Cada arquivo é conferido de ponta a ponta com um hash SHA-256, então o que pousa no PC com Windows (ou no Mac) é verificado como idêntico ao que saiu da outra máquina. Arquivos grandes também são bem tratados: um navegador com a API File System Access — Chrome ou Edge no computador — transmite o download direto para o disco, sem limite de tamanho. Firefox e Safari não têm essa API, então um lote recebido neles é montado na memória, e o Relayium avisa antes de você aceitar assim que passa de cerca de 256 MB. Esse número é uma estimativa propositalmente conservadora, não um limite medido — onde realmente cede depende da memória da máquina, do sistema e do que mais estiver aberto.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso instalar alguma coisa no Mac ou no PC com Windows?",
        a: "Não. O Relayium roda inteiramente no navegador tanto no macOS quanto no Windows. Abra o relayium.com em cada máquina e está pronto — nada para baixar de qualquer forma. Na mesma rede uma transferência não precisa de conta alguma; emparelhar pela internet só pede que o remetente faça login.",
      },
      {
        q: "Os dois computadores precisam estar na mesma rede?",
        a: "Não. Estar na mesma rede é o caminho mais rápido porque as duas máquinas se encontram automaticamente, mas um código de emparelhamento conecta um Mac e um PC com Windows pela internet igualmente bem — mesmo de cidades diferentes. De qualquer forma, a transferência permanece criptografada de ponta a ponta; a rota entre redes só pede que o remetente faça login primeiro, e quem recebe nunca precisa de conta.",
      },
      {
        q: "Posso enviar uma pasta inteira, não só arquivos individuais?",
        a: "Sim. Arraste uma pasta e o Relayium envia até 1.000 arquivos no lote, preservando a estrutura da pasta. Chrome e Edge no Windows gravam direto em um diretório escolhido; se o navegador que recebe não conseguir gravar pastas diretamente, ela chega como um único .zip com a mesma organização.",
      },
      {
        q: "As permissões de arquivo, os fins de linha ou os nomes de arquivo vão se embaralhar ao passar do Mac para o Windows?",
        a: "Os bytes e o caminho relativo dentro de uma pasta ficam inalterados e são verificados com um hash SHA-256 de ponta a ponta, então nada toca nos fins de linha nem na codificação — tudo o que uma conversão em nível de aplicação precisaria tratar (como CRLF versus LF em um arquivo de texto) fica inalterado, porque o próprio arquivo fica inalterado. Duas coisas realmente não passam: um nome que contenha um dos caracteres proibidos pelo Windows não pode ser criado no PC, e as permissões POSIX, a propriedade e os atributos estendidos do macOS não são transferidos, porque o navegador que recebe grava arquivos comuns sob o próprio modelo do NTFS.",
      },
      {
        q: "Existe algum limite de tamanho?",
        a: "Até 1.000 arquivos por lote. Não há limite de tamanho algum do lado do servidor — Chrome e Edge no computador transmitem direto para o disco. Firefox e Safari não têm a API File System Access, então um lote recebido em um deles fica na memória, e o Relayium avisa acima de cerca de 256 MB — uma estimativa conservadora, não um limite rígido, já que o teto real depende da memória da máquina e do que mais ela estiver rodando.",
      },
    ],
  },
  cta: {
    text: "Abra o Relayium no seu Mac e no seu PC com Windows e mova seus primeiros arquivos — sem instalação e sem precisar de conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/transfer-files-between-mac-and-windows",
  published: "2026-07-09",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
