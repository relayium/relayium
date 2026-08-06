// web/scripts/pages/content/articles/guides-own-node.mjs
// "Bring your own node" — attach your own relay/storage node to your relayium.com
// account so your transfers run through it (free, private) instead of our metered
// infrastructure. Distinct from guides-self-host.mjs, which runs the WHOLE server
// stack yourself. English is the master; zh/ja/ko/de/fr keep identical facts.
// Command/env/port blocks (code) stay English in every language.

const INSTALL_CMD =
  "curl -fsSL https://relayium.com/install-node.sh | sudo RELAYIUM_CENTRAL_URL=https://relayium.com RELAYIUM_NODE_TOKEN=<your-token> RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs sh";
// One multi-line string (not three array elements): the article template emits a
// separate <pre> per array element, and we want these three lines in one block.
const PORTS_CODE = [
  "sudo ufw allow 3478/udp        # TURN\nsudo ufw allow 8081/tcp        # storage\nsudo ufw allow 49152:65535/udp # relay",
];

const en = {
  title: "Bring your own node: use Relayium relay & storage for free",
  description:
    "Attach your own relay/storage node to your Relayium account with one command. Your transfers then run through your node — not our metered servers — so they're free, and the data stays on hardware you control.",
  updatedLabel: "Last updated",
  lead: [
    "Cross-network transfers and stored links use relay bandwidth and disk that cost us money, so they run on a free allowance and are paid past it. There's a way around that: run your own relay/storage node, bind it to your account, and your transfers flow through your node instead of ours — nothing metered, nothing billed.",
    "This is different from self-hosting the whole Relayium server. You keep using your normal relayium.com account and the same apps; you're just adding a node you own to carry your traffic. This guide takes you from a fresh Linux box to an online node in about five minutes.",
  ],
  sections: [
    {
      heading: "Why run your own node",
      body: [
        "Two reasons. First, cost: a node you own carries your relay and storage traffic directly, so it never touches our metered infrastructure and there is nothing to bill — your usage is free no matter how large.",
        "Second, control: the relayed bytes and stored blobs live on hardware you run, under your own operational control. Realtime transfers stay end-to-end encrypted the whole way, so even your own node only ever sees ciphertext.",
      ],
    },
    {
      heading: "Install the node and bring it online",
      prereqs: {
        label: "What you need before step 1",
        items: [
          "A Linux server reachable from the internet — a cheap VPS or an always-on box at home both work. Both amd64 and arm64 are supported.",
          "root on that server, or sudo. The install needs it once; the node itself never runs as root.",
          "The ability to open inbound ports — in the host firewall, and on a cloud VPS in the provider's security group too.",
          "A relayium.com account you are signed in to. The install command is minted on your account page and carries a one-time token.",
          "Disk, only if you want the node to store as well as relay. A relay-only node needs none — leave RELAYIUM_NODE_STORAGE_DIR out.",
        ],
      },
      body: [
        "Four things happen in order: you mint the command, you run it, you open the ports, and you confirm the node came online. About five minutes on a fresh box.",
      ],
      steps: [
        {
          text: "Sign in at relayium.com and open your account page at /me.",
        },
        {
          text: "Scroll to My Nodes and click Add node. Copy the install command right away — the token in it is shown once and cannot be shown again.",
        },
        {
          text: "Paste it on your server. It downloads the relayium-node binary, checksum-verifies it, installs it to /usr/local/bin, writes a systemd service and starts it.",
          code: [INSTALL_CMD],
        },
        {
          text: "Confirm the service is up and will come back after a reboot. Both answers matter: active says it is running now, enabled is what survives a restart.",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "Open the inbound ports on the host firewall. Being Online needs only outbound access, but peers relay and store over these.",
          code: PORTS_CODE,
        },
        {
          text: "On a cloud VPS, allow the same ports in the provider's security group as well. ufw alone leaves them blocked upstream, and the node looks healthy the whole time.",
        },
        {
          text: "Back on /me, watch the node flip to Online — usually within about 30 seconds. From then on your account's transfers prefer it automatically.",
        },
        {
          text: "Optional: turn on \"Only use my own nodes for relay/storage\" so a transfer fails rather than quietly falling back to our shared infrastructure.",
        },
      ],
      success: {
        label: "What a working node looks like",
        body: [
          "systemd reports the service both active and enabled, and the node shows Online under My Nodes. active on its own is not enough — a node that is not enabled disappears at the next reboot.",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "The <your-token> part is filled in for you on the account page — don't paste the placeholder above literally.",
        "RELAYIUM_NODE_STORAGE_DIR turns on blob storage as well as relay. Leave it off (omit the variable) if you only want the node to relay, not store.",
        "Check it started: `systemctl status relayium-node` (should read active/running).",
        "Confirm boot-persistence: `systemctl is-enabled relayium-node` (should read enabled).",
        "Watch logs live: `journalctl -u relayium-node -f`.",
        "3478/udp is the TURN port peers use to relay; 8081/tcp is the blob-storage HTTP port; 49152–65535/udp is the relay media range.",
        "On a cloud VPS, also allow these in the provider's security group / network firewall, not just ufw.",
      ],
    },
    {
      heading: "Is it safe to run this installer as root?",
      body: [
        "Before anything else: BYO nodes run the same code and the same hardening as our own fleet nodes — the same binary from the same signed release, installed by the same script, under the same systemd unit. The only difference is whose machine it is. Everything below describes both.",
        "It is a fair question about a command that pipes a script off the internet into a root shell, and it deserves a specific answer rather than a reassurance. Root is used for the install and for nothing the node does afterwards. The installer creates a system account called relayium-node with no login shell and no home directory, writes the systemd units, starts the service, and exits. The node itself never runs as root: its unit sets User=relayium-node, so from the moment it comes online it is an unprivileged account that owns nothing else on your machine. (Auto-update, which is on by default, does add a second unit that runs as root — the next section is entirely about what that one can and cannot do.)",
        "Around that account the unit puts a systemd sandbox. Every line is aimed at something an attacker would reach for if they ever took over the node process. Nothing here is hidden from you: after installing, read the whole unit with `cat /etc/systemd/system/relayium-node.service`.",
      ],
      table: {
        head: ["In the unit", "What it blocks if the node is ever compromised"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "The attacker is a user who owns nothing, not root."],
          ["ProtectHome=yes", "/home and /root are invisible — no SSH private keys, no other projects' data."],
          ["ProtectSystem=strict", "The whole filesystem is read-only; no system file can be modified."],
          ["ReadWritePaths=", "The only writable places are the node's own state directory and, if you configured one, the storage directory. Writes anywhere else fail."],
          ["NoExecPaths=", "Nothing in the storage directory can be executed — an uploaded file cannot be run."],
          ["NoNewPrivileges=yes", "No route back up to root; the usual escalation tricks are closed off."],
          ["CapabilityBoundingSet=", "Empty — no Linux capabilities at all."],
          ["ProtectKernelTunables=yes, ProtectKernelModules=yes", "The kernel is out of reach: no sysctl changes, no module loading, no rootkit."],
        ],
      },
      bullets: [
        "ReadWritePaths and NoExecPaths name the storage directory only on a node that actually stores. A relay-only node gets neither line and can write nowhere but its own state directory.",
        "The capability set is empty in the normal case. The single exception is a direct-download listener on a port below 1024, which needs CAP_NET_BIND_SERVICE to bind at all; the default download port is 2053, above 1024, so nothing is granted.",
        "The node holds no keys. Files are encrypted by the sender before they are uploaded, so what lands on a storage node is ciphertext it cannot read — that includes your own node, and it includes you.",
      ],
    },
    {
      heading: "What the auto-updater can and cannot do",
      body: [
        "The installer also sets up a self-update timer, on by default: relayium-node-update.timer asks relayium.com roughly every ten minutes what version this node should be running. That is a second unit, and it runs as root, so it owes you its own account of itself.",
        "Central never sends a binary. Its entire answer is a version number, two flags (may this node move now, and is this a deliberate downgrade) and a short reason string — no bytes, no URL, no command. The node then fetches that release itself, checks the archive's SHA-256 against the release's checksums.txt, and verifies an ECDSA P-256 signature over checksums.txt using a public key compiled into the very binary doing the checking. The private half of that key is not on the server answering those polls. So a compromised central could name a version; it could not mint a binary that passes.",
        "The updater and the node are two separate processes with opposite powers. relayium-node.service is the sandbox above — under ProtectSystem=strict it cannot write to /usr/local/bin at all, so the node can never modify a binary, its own included. relayium-node-update.service is a small oneshot unit that runs as root and deliberately carries no sandbox, because replacing a file in /usr/local/bin needs exactly the privilege the node's sandbox exists to deny it. Keeping that power in one single-purpose unit, instead of loosening the node's own hardening, is the whole point of the split: the process with root only ever swaps binaries, and the process in the cage can never touch one.",
        "An update that goes wrong undoes itself. The updater keeps the previous binary beside the new one, restarts the service, then watches for a heartbeat for up to ten minutes; if the new version does not report healthy in that window it puts the old binary back, restarts again, and records the bad version so it is not retried. Stored files are never read, moved or deleted by any of this.",
      ],
      bullets: [
        "Don't want it: re-run the installer with RELAYIUM_NODE_AUTO_UPDATE=off. The timer and its service are disabled and deleted; the node keeps running and you update it when you choose.",
        "Done with the node entirely: see “Removing your node” below.",
      ],
    },
    {
      heading: "Removing your node",
      body: [
        "Uninstalling is one script, and it is the same one whether your node stores files or only relays. It removes the units, the binary, the config and the service account, and makes a best-effort call telling relayium.com the node is gone. If that call fails it is one line on your terminal, not a broken uninstall — it prints the node's ID so it can be marked removed by hand.",
        "Download it, check it, then run it. Piping straight into sh means a 404 or a network blip makes the whole command print nothing and exit 0, which reads exactly like a successful uninstall.",
        "It removes only what it recognises: anything unexpected in the state or storage directories is kept and reported rather than swept away.",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "It refuses while the storage directory still holds any file it doesn't recognise — an expired blob the cleanup hasn't reached yet counts too — because every stored file lives on exactly one node and there are no replicas. Wait for that count to reach zero, or pass RELAYIUM_NODE_FORCE=1 to accept that those files become unreachable.",
        "If it cannot work out where your blobs live, it stops instead of guessing. RELAYIUM_NODE_ASSUME_NO_STORAGE=1 is the only way past that, and it still deletes nothing it does not recognise.",
        "The storage directory itself is kept unless you also pass RELAYIUM_NODE_PURGE_STORAGE=1. Environment variables do not survive `| sudo sh` — pass them as `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh`.",
        "Afterwards, `systemctl status relayium-node` should say not-found and no relayium-node timer should be listed. Install again later and your account gets a NEW node: the uninstall removes the node's identity file, so a fresh install registers a fresh node rather than reviving the old one.",
      ],
    },
    {
      heading: "When it doesn't work",
      body: [
        "Five failures cover nearly every node that does not come up, and three of them look healthy from the server: the service is running, and only the account page or a listening socket says otherwise.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The shell answers \"relayium-node: command not found\".",
            code: [
              `command -v relayium-node
# nothing printed`,
            ],
            fix: "The binary is not installed. You never install relayium-node separately — the one-line command from the account page is what downloads it, puts it on your PATH and starts it as a service. Run that command instead.",
          },
          {
            symptom: "The service is active, but the node never turns Online on the account page.",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "Online is decided by an outbound heartbeat, so a firewall is rarely the cause here — registration is. The token is one-time, so a command that was already run, or an old one from a previous attempt, fails. Click Add node again for a fresh command and re-run it.",
          },
          {
            symptom: "The node shows Online, but transfers still run over our shared infrastructure.",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "Online proves only the outbound heartbeat. Peers need the inbound ports: confirm the node is listening, then open 3478/udp, 8081/tcp and 49152-65535/udp in the host firewall and in the cloud security group. To rule out a silent fallback entirely, turn on the only-my-own-nodes setting.",
          },
          {
            symptom: "The uninstall printed nothing, exited 0, and the service is still there.",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "That is exactly what piping a failed download into sh looks like: a 404 or a network blip prints nothing and exits 0, which reads like success. Download the script, check it is not empty, then run it — that is why the command in this guide is written in three parts rather than one pipe.",
          },
          {
            symptom: "The uninstall refuses while the storage directory still holds files.",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "Deliberate. Every stored file lives on exactly one node and there are no replicas, so removing the node makes those files unreachable. Wait for the count to reach zero as blobs expire, or accept the loss with RELAYIUM_NODE_FORCE=1. Environment variables do not survive a pipe into sudo sh, so pass them as sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "I got \"relayium-node: command not found\" — what went wrong?",
        a: "You ran the relayium-node binary before installing it. Use the one-line install command from the account page (the curl … | sudo … sh form): it downloads the binary, puts it on your PATH, and starts it as a service. You never install relayium-node separately.",
      },
      {
        q: "Does the node stay online after a reboot?",
        a: "Yes. The installer registers a systemd service that is enabled on boot and set to Restart=always, so it comes back after a reboot and restarts itself if it crashes. Nothing extra to run.",
      },
      {
        q: "How is this different from self-hosting Relayium?",
        a: "Bring-your-own-node keeps your normal relayium.com account and apps and just adds a node you own to carry your traffic. Self-hosting runs the entire server stack (accounts, web app, signaling) on your own domain — see the \"Self-host Relayium\" guide for that.",
      },
      {
        q: "Can anyone else use my node or see my data?",
        a: "No. A node is bound to your account by its token and only carries your account's traffic. Realtime transfers are end-to-end encrypted and stored blobs are ciphertext your node can't read. Your data and node configuration are only ever usable by you.",
      },
    ],
  },
  cta: {
    text: "Sign in, open your account page, and add your first node in under a minute.",
    button: "Open the account page",
    href: "/me",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "自建节点：免费使用 Relayium 的中继与存储",
  description:
    "用一条命令把你自己的中继/存储节点绑定到 Relayium 账号。之后你的传输全部走你自己的节点、不经过我们的计量服务器——因此免费，数据也留在你自己掌控的硬件上。",
  updatedLabel: "最近更新",
  lead: [
    "跨网络传输和存储型链接会消耗中继带宽和磁盘，这对我们是有成本的，所以它们按免费额度提供、超出后收费。但有个绕过办法：自己搭一个中继/存储节点，绑定到你的账号，之后你的传输就走你自己的节点而不是我们的——不计量、不收费。",
    "这跟「自托管整套 Relayium 服务端」不是一回事。你依然用你平常的 relayium.com 账号、同样的客户端；只是多接了一个你自己名下的节点来承载你的流量。本指南带你从一台全新的 Linux 服务器，到节点上线，大约五分钟。",
  ],
  sections: [
    {
      heading: "为什么要自建节点",
      body: [
        "两个理由。其一是成本：你自己的节点直接承载你的中继和存储流量，完全不碰我们的计量设施，也就没有任何可计费的东西——无论用量多大都免费。",
        "其二是掌控：中继的字节和存储的数据块都落在你自己运行的硬件上，由你自己运维。实时传输全程端到端加密，所以即便是你自己的节点，看到的也只是密文。",
      ],
    },
    {
      heading: "安装节点并让它上线",
      prereqs: {
        label: "开始之前你需要什么",
        items: [
          "一台能从公网访问到的 Linux 服务器——便宜的 VPS 或家里常开的机器都行。amd64 和 arm64 都支持。",
          "那台服务器的 root 权限，或者 sudo。安装时需要一次；节点本身从不以 root 运行。",
          "放通入站端口的能力——主机防火墙上要放，云 VPS 还要在服务商的安全组里放。",
          "一个已登录的 relayium.com 账号。安装命令是在账号页现生成的，里面带着一次性令牌。",
          "磁盘空间，仅当你希望节点在中继之外还负责存储时才需要。纯中继节点不需要——把 RELAYIUM_NODE_STORAGE_DIR 去掉即可。",
        ],
      },
      body: [
        "按顺序做四件事：生成命令、跑它、放通端口、确认节点上线。全新机器上大约五分钟。",
      ],
      steps: [
        {
          text: "在 relayium.com 登录，打开账号页 /me。",
        },
        {
          text: "滚动到「我的节点」，点「添加节点」。立刻复制那条安装命令——里面的令牌只显示这一次，之后再也拿不到。",
        },
        {
          text: "把它粘到你的服务器上执行。它会下载 relayium-node 二进制、校验校验和、安装到 /usr/local/bin、写好 systemd 服务并启动。",
          code: [INSTALL_CMD],
        },
        {
          text: "确认服务已经起来，并且重启后还会回来。两个答案都重要：active 说明它现在在跑，enabled 才是重启后还在的那个。",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "在主机防火墙上放通入站端口。显示「在线」只需要出站访问，但对端要中继和存储，走的是这几个端口。",
          code: PORTS_CODE,
        },
        {
          text: "如果是云 VPS，还要在服务商的安全组里放通同样的端口。只配 ufw 的话它们在上游依然是封的，而节点全程看着都很健康。",
        },
        {
          text: "回到 /me，看着节点变成「在线」——通常 30 秒左右。从此你账号的传输会自动优先走它。",
        },
        {
          text: "可选：打开「只使用我自己的节点做中继/存储」，这样传输会直接失败，而不是悄悄退回我们的共享设施。",
        },
      ],
      success: {
        label: "一个正常节点长什么样",
        body: [
          "systemd 报告服务同时是 active 和 enabled，并且节点在「我的节点」下显示为在线。光有 active 不够——没有 enabled 的节点下次重启就消失了。",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "其中 <your-token> 会在账号页里替你填好——不要直接照抄上面的占位符。",
        "RELAYIUM_NODE_STORAGE_DIR 会同时开启存储（不只是中继）。如果你只想让节点中继、不存储，去掉这个变量即可。",
        "确认已启动：`systemctl status relayium-node`（应为 active/running）。",
        "确认开机自启：`systemctl is-enabled relayium-node`（应为 enabled）。",
        "实时看日志：`journalctl -u relayium-node -f`。",
        "3478/udp 是别人用来中继的 TURN 端口；8081/tcp 是存储的 HTTP 端口；49152–65535/udp 是中继媒体端口段。",
        "在云 VPS 上，还要在服务商的安全组 / 网络防火墙里放通这些端口，不只是 ufw。",
      ],
    },
    {
      heading: "用 root 跑这个安装脚本安全吗？",
      body: [
        "先把最重要的一句说在前面：自建节点和我们自己机队的节点跑的是同一套代码、同一套加固——同一个签名发布里的同一个二进制、同一个安装脚本、同一份 systemd unit。唯一的差别是这台机器归谁。下面讲的东西对两者都成立。",
        "把一个从网上拉下来的脚本管道给 root shell，值得警惕，也值得一个具体的回答，而不是一句「放心」。root 只用在安装这一步，节点后续运行完全用不到它。安装脚本会建一个叫 relayium-node 的系统账号（没有登录 shell、没有家目录），写好 systemd unit，启动服务，然后退出。节点本身从不以 root 运行：unit 里写死了 User=relayium-node，所以它一上线就是一个在你机器上什么都不拥有的低权限账号。（默认开启的自动更新确实会多装一个以 root 运行的 unit——下一节整节都在讲它能做什么、不能做什么。）",
        "在这个账号外面，unit 还套了一层 systemd 沙箱。每一行都对着「节点进程万一被攻破，攻击者接下来会伸手去够什么」。这里没有任何东西对你隐藏：装完之后 `cat /etc/systemd/system/relayium-node.service` 就能看到完整的 unit。",
      ],
      table: {
        head: ["unit 里的配置", "万一节点被攻破，它挡住了什么"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "攻击者只是一个什么都没有的用户，不是 root。"],
          ["ProtectHome=yes", "/home、/root 完全隐身——偷不到 SSH 私钥，也拿不到别的项目的数据。"],
          ["ProtectSystem=strict", "整个文件系统只读，改不了任何系统文件。"],
          ["ReadWritePaths=", "唯一可写的只有节点自己的状态目录，以及你配置了存储时的那个存储目录。写别处一律失败。"],
          ["NoExecPaths=", "存储目录里的东西跑不起来——上传的文件无法被执行。"],
          ["NoNewPrivileges=yes", "没有回到 root 的路，常见的提权套路全被堵死。"],
          ["CapabilityBoundingSet=", "留空——不给任何 Linux capability。"],
          ["ProtectKernelTunables=yes、ProtectKernelModules=yes", "碰不到内核：改不了 sysctl，加载不了模块，种不了 rootkit。"],
        ],
      },
      bullets: [
        "只有真正开了存储的节点，ReadWritePaths 和 NoExecPaths 才会指向存储目录。纯中继节点这两行都没有，除了自己的状态目录哪儿都写不了。",
        "正常情况下 capability 集合是空的。唯一的例外是把直连下载监听放在 1024 以下的端口时需要 CAP_NET_BIND_SERVICE 才能绑定；默认下载端口是 2053，在 1024 以上，所以什么都不会授予。",
        "节点手里没有密钥。文件在上传之前就已由发送方加密，落到存储节点上的只是它读不了的密文——包括你自己的节点，也包括你自己。",
      ],
    },
    {
      heading: "自动更新能做什么、不能做什么",
      body: [
        "安装脚本还会装一个自动更新的 timer，默认开启：relayium-node-update.timer 大约每十分钟问一次 relayium.com「这台节点该跑哪个版本」。这是第二个 unit，而且以 root 运行，所以它也该向你交代清楚自己。",
        "中央从不下发二进制。它的全部回答就是一个版本号、两个开关（这台节点现在能不能动、这是不是一次刻意的降级）和一句简短的理由——没有字节流，没有 URL，没有命令。之后是节点自己去取那个发布版本，把压缩包的 SHA-256 与该版本的 checksums.txt 比对，再用编译进「正在做这次校验的那个二进制」里的公钥，验证 checksums.txt 上的 ECDSA P-256 签名。这把钥匙的私钥半边并不在回答这些轮询的服务器上。所以中央即使被攻破，也只能报一个版本号，变不出一个能通过验签的二进制。",
        "更新器和节点是两个权限恰好相反的进程。relayium-node.service 就是上面那个沙箱——在 ProtectSystem=strict 之下它根本无法写 /usr/local/bin，所以节点永远改不了任何二进制，包括它自己的。relayium-node-update.service 则是一个只做一件事的 oneshot unit，以 root 运行，并且刻意不套沙箱：因为替换 /usr/local/bin 里的文件，需要的正是节点沙箱存在的意义所要拒绝的那份权限。把「能改二进制」这件事收进这一个单一用途的 unit，而不是去松动节点本体的加固，正是这个拆分的全部意义：拿着 root 的那个进程只负责换二进制，笼子里的那个永远碰不到二进制。",
        "更新出了问题会自己撤销。更新器会把旧二进制留在新二进制旁边，重启服务，然后最多盯十分钟等心跳；如果新版本在这个窗口里没能报健康，它就把旧二进制换回去、再重启一次，并记下这个坏版本不再重试。整个过程从头到尾都不会读、移动或删除存储的文件。",
      ],
      bullets: [
        "不想要它：带 RELAYIUM_NODE_AUTO_UPDATE=off 重跑一遍安装脚本。timer 和它的 service 会被停用并删除；节点照常运行，什么时候升级由你决定。",
        "彻底不用这台节点了：见下面的「移除你的节点」。",
      ],
    },
    {
      heading: "移除你的节点",
      body: [
        "卸载只有一个脚本，无论这台节点只做中继还是也存文件，用的都是它。它会删掉 unit、二进制、配置和那个服务账号，并尽力（best-effort）通知 relayium.com 这台节点已经下线。这次调用失败的话，终端上只多一行提示，不是卸载出了问题——它会打印节点 ID，方便手工标记为已移除。",
        "先下载、检查，再执行。直接管道给 sh 的话，一旦 404 或网络抖动，整条命令会什么都不打印、退出码却是 0，看起来和卸载成功一模一样。",
        "它只删自己认得的东西：状态目录或存储目录里出现的意外文件会被保留并报告，而不是一并扫掉。",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "只要存储目录里还有它认不出的文件，它就拒绝卸载——包括清理还没轮到的过期 blob——因为每个存储文件只存在于唯一一台节点上，没有副本。等这个数变成 0 再跑，或者加 RELAYIUM_NODE_FORCE=1 表示你接受那些文件从此不可达。",
        "如果它判断不出你的 blob 在哪，它会停下来而不是猜。RELAYIUM_NODE_ASSUME_NO_STORAGE=1 是唯一的放行开关，而且它照样不会删任何认不出的东西。",
        "存储目录本身会被保留，除非你另外加 RELAYIUM_NODE_PURGE_STORAGE=1。环境变量过不了 `| sudo sh`，要写成 `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh`。",
        "卸完之后，`systemctl status relayium-node` 应该是 not-found，也不该再列出 relayium-node 的 timer。以后重装的话，你账号里得到的会是一台新节点：卸载把节点的身份文件删掉了，所以重装是注册一台全新节点，而不是把旧的那台救回来。",
      ],
    },
    {
      heading: "出问题时怎么办",
      body: [
        "几乎所有起不来的节点都逃不出这五种，其中三种从服务器上看一切正常：服务在跑，只有账号页或者一个监听端口会告诉你不对。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "shell 回答「relayium-node: command not found」。",
            code: [
              `command -v relayium-node
# 什么都没打印`,
            ],
            fix: "二进制根本没装。你从来不需要单独安装 relayium-node——账号页那条一行命令才是负责下载它、放进 PATH 并作为服务启动的东西。改跑那条命令。",
          },
          {
            symptom: "服务是 active，但节点在账号页上始终不变成在线。",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "在线与否是由出站心跳决定的，所以这里很少是防火墙的问题，而是注册失败。令牌是一次性的，已经用过的命令、或上一次尝试留下的旧命令都会失败。再点一次「添加节点」拿一条新命令重跑。",
          },
          {
            symptom: "节点显示在线，但传输还是走我们的共享设施。",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "在线只证明了出站心跳。对端需要的是入站端口：先确认节点确实在监听，然后在主机防火墙和云安全组里放通 3478/udp、8081/tcp 和 49152-65535/udp。想彻底排除悄悄回退，就打开「只使用我自己的节点」那个开关。",
          },
          {
            symptom: "卸载命令什么都没打印、退出码 0，服务却还在。",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "这正是把一次失败的下载管道给 sh 之后的样子：404 或网络抖动会什么都不打印、退出码 0，读起来和成功一模一样。先下载脚本、确认它非空、再执行——这也是本文那条命令写成三段而不是一条管道的原因。",
          },
          {
            symptom: "存储目录里还有文件，卸载因此拒绝执行。",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "这是刻意的。每个已存储的文件只存在于唯一一个节点上，没有副本，所以移除节点会让这些文件永远取不回来。要么等这些数据块过期、数量归零，要么用 RELAYIUM_NODE_FORCE=1 接受这个损失。环境变量无法穿过管道传给 sudo sh，所以要写成 sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我遇到「relayium-node: command not found」，哪里错了？",
        a: "你在安装之前就运行了 relayium-node 二进制。请用账号页给的那条一行安装命令（curl … | sudo … sh 形式）：它会下载二进制、放到 PATH 上，并作为服务启动。你从不需要单独安装 relayium-node。",
      },
      {
        q: "重启之后节点还会在线吗？",
        a: "会。安装脚本注册了一个 systemd 服务，开机自启且设为 Restart=always，所以重启后会自动回来，崩溃也会自愈。无需额外操作。",
      },
      {
        q: "这跟自托管 Relayium 有什么区别？",
        a: "自建节点保留你平常的 relayium.com 账号和客户端，只是多接一个你自己的节点来承载流量。自托管则是在你自己的域名上运行整套服务端（账号、Web 应用、信令）——那个见「自托管 Relayium」指南。",
      },
      {
        q: "别人能用我的节点或看到我的数据吗？",
        a: "不能。节点通过令牌绑定到你的账号，只承载你账号的流量。实时传输端到端加密，存储的数据块是你的节点也读不了的密文。你的数据和节点配置只为你自己所用。",
      },
    ],
  },
  cta: {
    text: "登录，打开账号页，一分钟内添加你的第一个节点。",
    button: "打开账号页",
    href: "/me",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Bring Your Own Node: Relayium のリレー＆ストレージを無料で使う",
  description:
    "自分で用意したリレー／ストレージノードを、コマンド1つで Relayium アカウントに紐付けます。以降、転送は当社の従量課金サーバーではなく自分のノードを経由するので無料になり、データも自分で管理するハードウェア上にとどまります。",
  updatedLabel: "最終更新",
  lead: [
    "ネットワークをまたぐ転送や保存リンクは、当社にとってコストのかかるリレー帯域とディスクを使うため、無料枠の範囲内で動作し、それを超えると有料になります。それを回避する方法があります。自分のリレー／ストレージノードを立ち上げてアカウントに紐付ければ、転送は当社ではなく自分のノードを経由するようになり、従量課金も請求も一切ありません。",
    "これは Relayium サーバー全体をセルフホストするのとは異なります。いつもの relayium.com アカウントと同じアプリをそのまま使い続け、自分のトラフィックを運ぶノードを追加するだけです。このガイドでは、まっさらな Linux マシンからオンラインのノードまで、およそ5分で到達できます。",
  ],
  sections: [
    {
      heading: "なぜ自分のノードを立てるのか",
      body: [
        "理由は2つあります。1つ目はコストです。自分のノードはリレーとストレージのトラフィックを直接運ぶため、当社の従量課金インフラに一切触れず、請求するものが何もありません。使用量がどれだけ大きくても無料です。",
        "2つ目はコントロールです。リレーされたバイト列や保存されたブロブは、自分で運用し、自分の運用管理下に置いたハードウェア上に存在します。リアルタイム転送は全経路でエンドツーエンド暗号化されたままなので、自分のノードでさえ常に暗号文しか見えません。",
      ],
    },
    {
      heading: "ノードをインストールしてオンラインにする",
      prereqs: {
        label: "手順1の前に必要なもの",
        items: [
          "インターネットから到達できる Linux サーバー——安価な VPS でも、自宅の常時起動マシンでも構いません。amd64 と arm64 の両方に対応しています。",
          "そのサーバーの root 権限、または sudo。インストール時に一度だけ必要で、ノード自体が root で動くことはありません。",
          "受信ポートを開けること——ホストのファイアウォールに加え、クラウド VPS では事業者のセキュリティグループにも設定が要ります。",
          "サインイン済みの relayium.com アカウント。インストールコマンドはアカウントページで発行され、使い捨てのトークンを含みます。",
          "ディスク容量。中継だけでなく保存もさせたい場合のみ必要です。中継専用なら不要で、RELAYIUM_NODE_STORAGE_DIR を外してください。",
        ],
      },
      body: [
        "順に4つのことをします。コマンドを発行し、実行し、ポートを開け、オンラインになったことを確認する——新しいマシンなら5分ほどです。",
      ],
      steps: [
        {
          text: "relayium.com にサインインし、アカウントページ /me を開きます。",
        },
        {
          text: "「マイノード」まで進み、「ノードを追加」をクリックします。表示されたインストールコマンドはすぐにコピーしてください。含まれるトークンは一度きりの表示で、あとから再表示はできません。",
        },
        {
          text: "それをサーバーに貼り付けて実行します。relayium-node のバイナリをダウンロードしてチェックサムを検証し、/usr/local/bin に配置し、systemd サービスを書いて起動します。",
          code: [INSTALL_CMD],
        },
        {
          text: "サービスが起動していること、再起動後も戻ってくることを確認します。どちらの答えも重要です。active は今動いていること、enabled は再起動をまたいで残ることを意味します。",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "ホストのファイアウォールで受信ポートを開けます。オンライン表示に必要なのは送信方向だけですが、ピアが中継や保存に使うのはこれらのポートです。",
          code: PORTS_CODE,
        },
        {
          text: "クラウド VPS の場合は、事業者のセキュリティグループでも同じポートを許可してください。ufw だけでは上流で塞がれたままで、しかもノードはその間ずっと健全に見えます。",
        },
        {
          text: "/me に戻り、ノードがオンラインに変わるのを待ちます——たいてい30秒ほどです。以降、アカウントの転送は自動的にこのノードを優先します。",
        },
        {
          text: "任意: 「自分のノードだけを中継／保存に使う」をオンにすると、共有インフラへ黙って戻る代わりに転送が失敗するようになります。",
        },
      ],
      success: {
        label: "正常なノードの見え方",
        body: [
          "systemd がサービスを active かつ enabled と報告し、「マイノード」でノードがオンラインと表示されます。active だけでは不十分です——enabled になっていないノードは次の再起動で消えます。",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "<your-token> の部分はアカウントページで自動的に埋め込まれます。上のプレースホルダーをそのまま貼り付けないでください。",
        "RELAYIUM_NODE_STORAGE_DIR はリレーに加えてブロブストレージを有効にします。ノードをリレー専用にして保存させたくない場合は、これをオフのまま（変数を省略）にしてください。",
        "起動を確認: `systemctl status relayium-node`（active/running と表示されるはず）。",
        "起動時の永続性を確認: `systemctl is-enabled relayium-node`（enabled と表示されるはず）。",
        "ログをライブで監視: `journalctl -u relayium-node -f`。",
        "3478/udp はピアがリレーに使う TURN ポート、8081/tcp はブロブストレージの HTTP ポート、49152–65535/udp はリレーメディアの範囲です。",
        "クラウド VPS では、ufw だけでなくプロバイダーのセキュリティグループ／ネットワークファイアウォールでもこれらを許可してください。",
      ],
    },
    {
      heading: "このインストーラーを root で実行しても安全ですか？",
      body: [
        "まず最初に。BYO ノードは当社自身のフリートノードとまったく同じコード、まったく同じ堅牢化で動きます — 同じ署名済みリリースの同じバイナリを、同じスクリプトで、同じ systemd ユニットの下にインストールします。違いは「そのマシンが誰のものか」だけです。以下の説明は両方に当てはまります。",
        "インターネットから取ってきたスクリプトを root シェルにパイプするコマンドについて当然の疑問であり、「大丈夫です」ではなく具体的な答えに値します。root はインストールのためだけに使われ、その後のノードの動作には一切使われません。インストーラーは、ログインシェルもホームディレクトリも持たない relayium-node というシステムアカウントを作成し、systemd ユニットを書き、サービスを起動して終了します。ノード自体が root で動くことはありません。ユニットに User=relayium-node が書かれているため、オンラインになった瞬間から、マシン上で何も所有しない非特権アカウントです。（既定で有効な自動更新は、root で動くもう1つのユニットを追加します — 次の節はまるごと、そのユニットに何ができて何ができないかの話です。）",
        "そのアカウントの周囲に、ユニットは systemd サンドボックスを張ります。どの行も「ノードプロセスが乗っ取られたとき、攻撃者が次に手を伸ばすもの」を狙って書かれています。隠しているものは何もありません。インストール後に `cat /etc/systemd/system/relayium-node.service` でユニット全体を読めます。",
      ],
      table: {
        head: ["ユニット内の設定", "ノードが侵害された場合に何を防ぐか"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "攻撃者は何も所有しない一般ユーザーであり、root ではありません。"],
          ["ProtectHome=yes", "/home と /root が見えない — SSH 秘密鍵も、他のプロジェクトのデータも盗めません。"],
          ["ProtectSystem=strict", "ファイルシステム全体が読み取り専用。システムファイルは一切変更できません。"],
          ["ReadWritePaths=", "書き込めるのはノード自身の状態ディレクトリと、ストレージを設定した場合のそのディレクトリだけ。他の場所への書き込みはすべて失敗します。"],
          ["NoExecPaths=", "ストレージディレクトリ内のものは実行できません — アップロードされたファイルは走りません。"],
          ["NoNewPrivileges=yes", "root へ戻る道がなく、よくある権限昇格の手口が塞がれます。"],
          ["CapabilityBoundingSet=", "空 — Linux ケーパビリティを一切与えません。"],
          ["ProtectKernelTunables=yes、ProtectKernelModules=yes", "カーネルに手が届きません。sysctl の変更もモジュールの読み込みもできず、rootkit を仕込めません。"],
        ],
      },
      bullets: [
        "ReadWritePaths と NoExecPaths がストレージディレクトリを指すのは、実際に保存を行うノードだけです。リレー専用のノードにはどちらの行も付かず、自分の状態ディレクトリ以外どこにも書けません。",
        "通常の構成ではケーパビリティ集合は空です。唯一の例外は、直接ダウンロードのリスナーを 1024 未満のポートに置く場合で、バインドに CAP_NET_BIND_SERVICE が必要になります。既定のダウンロードポートは 1024 より上の 2053 なので、何も付与されません。",
        "ノードは鍵を持ちません。ファイルはアップロード前に送信側で暗号化されるため、ストレージノードに届くのはそれ自身が読めない暗号文です — 自分のノードでも、自分自身でも読めません。",
      ],
    },
    {
      heading: "自動更新にできること、できないこと",
      body: [
        "インストーラーは自己更新タイマーも設定します（既定で有効）。relayium-node-update.timer が、およそ10分ごとに relayium.com へ「このノードはどのバージョンを動かすべきか」を尋ねます。これは2つ目のユニットであり、root で動きます。ですからこれ自身についても説明する義務があります。",
        "中央がバイナリを送ることは決してありません。返ってくるのはバージョン番号と2つのフラグ（このノードは今動いてよいか、これは意図的なダウングレードか）、そして短い理由の文字列だけです — バイト列もURLもコマンドもありません。そのうえでノードが自分でそのリリースを取得し、アーカイブの SHA-256 をリリースの checksums.txt と照合し、さらに checksums.txt に対する ECDSA P-256 署名を、まさにその検証を行っているバイナリ自身に埋め込まれた公開鍵で検証します。その鍵の秘密鍵側は、これらのポーリングに答えるサーバー上にはありません。したがって中央が侵害されても、名乗れるのはバージョン番号までで、検証を通るバイナリを作り出すことはできません。",
        "更新器とノードは、権限が正反対の2つの別プロセスです。relayium-node.service は上記のサンドボックスそのもので、ProtectSystem=strict の下では /usr/local/bin に書き込むことすらできません。つまりノードは自分のものを含め、いかなるバイナリも変更できません。relayium-node-update.service は root で動く小さな oneshot ユニットで、意図的にサンドボックスを付けていません。/usr/local/bin のファイルを置き換えるには、まさにノードのサンドボックスが与えまいとしているその権限が必要だからです。その力を、ノード本体の堅牢化を緩めるのではなく、単一目的のユニット1つに閉じ込めること — それがこの分割の要点です。root を持つプロセスはバイナリを差し替えるだけ、檻の中のプロセスはバイナリに触れられません。",
        "更新に失敗すれば自分で元に戻します。更新器は旧バイナリを新バイナリの隣に残し、サービスを再起動し、最大10分間ハートビートを待ちます。その間に新バージョンが健全と報告しなければ、旧バイナリを戻して再起動し、その不良バージョンを記録して再試行しません。この一連の処理で保存済みファイルが読まれたり、移動されたり、削除されたりすることは一度もありません。",
      ],
      bullets: [
        "不要な場合: RELAYIUM_NODE_AUTO_UPDATE=off を付けてインストーラーを再実行します。タイマーとそのサービスは無効化され削除されます。ノードはそのまま動き続け、更新の時期は自分で決められます。",
        "ノードを完全にやめる場合: 下の「ノードを削除する」を参照してください。",
      ],
    },
    {
      heading: "ノードを削除する",
      body: [
        "アンインストールはスクリプト 1 本だけで、ファイルを保存するノードでもリレー専用でも同じものを使います。ユニット、バイナリ、設定、サービスアカウントを削除し、ノードが無くなったことを relayium.com にベストエフォートで伝えます。その通知が失敗しても、ターミナルに 1 行出るだけで、アンインストールが壊れたわけではありません — ノード ID が表示されるので、手動で削除済みにできます。",
        "ダウンロードして、中身を確認してから実行してください。sh に直接パイプすると、404 やネットワークの瞬断のときにコマンド全体が何も出力せず終了コード 0 で終わり、成功したように見えます。",
        "削除するのは把握しているものだけです。状態ディレクトリや保存ディレクトリに想定外のファイルがあれば、消さずに保持して報告します。",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "保存ディレクトリに把握していないファイルが 1 つでも残っている間は拒否します（クリーンアップがまだ届いていない期限切れの blob も同じ扱いです）。保存ファイルは 1 台のノードにしか存在せず、レプリカが無いためです。0 になるまで待つか、それらが到達不能になることを受け入れて RELAYIUM_NODE_FORCE=1 を渡してください。",
        "blob の場所を特定できない場合は、推測せずに停止します。RELAYIUM_NODE_ASSUME_NO_STORAGE=1 が唯一の回避手段で、それでも把握していないものは削除しません。",
        "保存ディレクトリ自体は、RELAYIUM_NODE_PURGE_STORAGE=1 を併せて渡さない限り残ります。環境変数は `| sudo sh` を越えないので、`sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh` の形で渡してください。",
        "その後、`systemctl status relayium-node` は not-found になり、relayium-node のタイマーも一覧に出ないはずです。後で再インストールすると、アカウントに追加されるのは新しいノードです。アンインストールがノードの識別ファイルを削除するため、再インストールは旧ノードの復活ではなく新規登録になります。",
      ],
    },
    {
      heading: "うまくいかないとき",
      body: [
        "立ち上がらないノードのほぼすべては次の5つのどれかで、そのうち3つはサーバー側からは健全に見えます。サービスは動いており、違うと告げるのはアカウントページか待ち受けソケットだけです。",
      ],
      troubleshooting: {
        label: "症状、確認、対処",
        items: [
          {
            symptom: "シェルが「relayium-node: command not found」と返す。",
            code: [
              `command -v relayium-node
# 何も表示されない`,
            ],
            fix: "バイナリが入っていません。relayium-node を単独でインストールすることはありません——アカウントページの1行コマンドこそが、バイナリをダウンロードし、PATH に置き、サービスとして起動するものです。そちらを実行してください。",
          },
          {
            symptom: "サービスは active なのに、アカウントページでノードがオンラインにならない。",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "オンラインかどうかは送信方向のハートビートで決まるため、ここでファイアウォールが原因になることはまれで、たいていは登録の失敗です。トークンは使い捨てなので、すでに実行済みのコマンドや前回の試行で残った古いコマンドは失敗します。「ノードを追加」をもう一度押して新しいコマンドで実行し直してください。",
          },
          {
            symptom: "ノードはオンラインなのに、転送は依然として共有インフラを通る。",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "オンラインが証明するのは送信方向のハートビートだけです。ピアが必要とするのは受信ポートです。ノードが待ち受けていることを確認したうえで、ホストのファイアウォールとクラウドのセキュリティグループの両方で 3478/udp、8081/tcp、49152-65535/udp を開けてください。黙ったフォールバックを完全に排除するには、自分のノードのみを使う設定をオンにします。",
          },
          {
            symptom: "アンインストールが何も表示せず終了コード0で終わり、サービスは残っている。",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "失敗したダウンロードを sh にパイプしたときの見え方そのものです。404 やネットワークの瞬断は何も出力せず終了コード0で終わるため、成功と見分けがつきません。スクリプトをダウンロードし、空でないことを確かめてから実行してください。本記事のコマンドが1本のパイプではなく3つに分かれているのはそのためです。",
          },
          {
            symptom: "ストレージディレクトリにまだファイルが残っているため、アンインストールが拒否される。",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "意図的な動作です。保存済みファイルはちょうど1つのノードにしか存在せず複製もないため、ノードを外すとそれらは取り出せなくなります。ブロブが期限切れになって数がゼロになるまで待つか、RELAYIUM_NODE_FORCE=1 でその損失を受け入れてください。環境変数は sudo sh へのパイプを越えられないので、sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh の形で渡します。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "「relayium-node: command not found」と表示されました — 何が問題ですか？",
        a: "relayium-node バイナリをインストールする前に実行しています。アカウントページのワンライナーインストールコマンド（curl … | sudo … sh の形式）を使ってください。これがバイナリをダウンロードし、PATH に配置し、サービスとして起動します。relayium-node を個別にインストールすることは決してありません。",
      },
      {
        q: "再起動後もノードはオンラインを維持しますか？",
        a: "はい。インストーラーは、起動時に有効化され Restart=always に設定された systemd サービスを登録するため、再起動後に復帰し、クラッシュしても自動的に再起動します。追加で実行するものはありません。",
      },
      {
        q: "これは Relayium のセルフホストとどう違うのですか？",
        a: "Bring-your-own-node は、いつもの relayium.com アカウントとアプリをそのまま使い、自分のトラフィックを運ぶノードを追加するだけです。セルフホストはサーバースタック全体（アカウント、Web アプリ、シグナリング）を自分のドメインで運用します。それについては「Relayium をセルフホスト」ガイドを参照してください。",
      },
      {
        q: "他の誰かが私のノードを使ったり、私のデータを見たりできますか？",
        a: "いいえ。ノードはトークンによって自分のアカウントに紐付けられ、そのアカウントのトラフィックのみを運びます。リアルタイム転送はエンドツーエンド暗号化されており、保存されるブロブは自分のノードが読めない暗号文です。データとノード設定を利用できるのは本人だけです。",
      },
    ],
  },
  cta: {
    text: "サインインしてアカウントページを開き、1分もかからず最初のノードを追加しましょう。",
    button: "アカウントページを開く",
    href: "/me",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Bring Your Own Node: Relayium 릴레이 및 스토리지를 무료로 사용하기",
  description:
    "직접 준비한 릴레이/스토리지 노드를 명령어 하나로 Relayium 계정에 연결하세요. 그러면 전송이 종량제 서버가 아닌 내 노드를 통해 이루어지므로 무료이며, 데이터도 직접 관리하는 하드웨어에 남습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "네트워크를 넘나드는 전송과 저장된 링크는 당사에 비용이 드는 릴레이 대역폭과 디스크를 사용하므로, 무료 허용량 내에서 동작하고 그 이상은 유료입니다. 이를 우회하는 방법이 있습니다. 직접 릴레이/스토리지 노드를 운영하여 계정에 연결하면, 전송이 당사가 아닌 내 노드를 통해 흐르며 종량 계측도 청구도 전혀 없습니다.",
    "이는 Relayium 서버 전체를 셀프 호스팅하는 것과는 다릅니다. 평소 쓰던 relayium.com 계정과 동일한 앱을 그대로 사용하면서, 트래픽을 운반할 본인 소유의 노드를 추가하는 것뿐입니다. 이 가이드는 새로운 Linux 머신에서 온라인 노드까지 약 5분 만에 안내합니다.",
  ],
  sections: [
    {
      heading: "왜 직접 노드를 운영해야 하나",
      body: [
        "두 가지 이유가 있습니다. 첫째, 비용입니다. 직접 운영하는 노드는 내 릴레이와 스토리지 트래픽을 직접 운반하므로 당사의 종량제 인프라에 전혀 닿지 않고 청구할 것이 없습니다. 사용량이 아무리 커도 무료입니다.",
        "둘째, 통제권입니다. 릴레이된 바이트와 저장된 블롭은 직접 운영하고 본인의 운영 통제하에 있는 하드웨어에 존재합니다. 실시간 전송은 전 구간에서 종단 간 암호화를 유지하므로, 내 노드조차 항상 암호문만 보게 됩니다.",
      ],
    },
    {
      heading: "노드를 설치하고 온라인으로 만들기",
      prereqs: {
        label: "1단계 전에 필요한 것",
        items: [
          "인터넷에서 접근 가능한 리눅스 서버 — 저렴한 VPS도, 집에 늘 켜둔 컴퓨터도 됩니다. amd64와 arm64 모두 지원합니다.",
          "그 서버의 root 권한 또는 sudo. 설치할 때 한 번만 필요하며, 노드 자체는 결코 root로 실행되지 않습니다.",
          "인바운드 포트를 열 수 있는 권한 — 호스트 방화벽에서, 그리고 클라우드 VPS라면 제공업체의 보안 그룹에서도.",
          "로그인되어 있는 relayium.com 계정. 설치 명령은 계정 페이지에서 발급되며 일회용 토큰을 담고 있습니다.",
          "디스크 공간은 중계뿐 아니라 저장까지 맡기려는 경우에만 필요합니다. 중계 전용 노드에는 필요 없으며 RELAYIUM_NODE_STORAGE_DIR을 빼면 됩니다.",
        ],
      },
      body: [
        "순서대로 네 가지를 합니다. 명령을 발급받고, 실행하고, 포트를 열고, 노드가 온라인이 되었는지 확인합니다. 새 서버라면 5분 정도입니다.",
      ],
      steps: [
        {
          text: "relayium.com에 로그인하고 계정 페이지 /me를 엽니다.",
        },
        {
          text: "내 노드까지 내려가 노드 추가를 누릅니다. 설치 명령을 즉시 복사하세요 — 그 안의 토큰은 한 번만 표시되고 다시는 볼 수 없습니다.",
        },
        {
          text: "서버에 붙여 넣어 실행합니다. relayium-node 바이너리를 내려받아 체크섬을 검증하고, /usr/local/bin에 설치하고, systemd 서비스를 작성한 뒤 시작합니다.",
          code: [INSTALL_CMD],
        },
        {
          text: "서비스가 떠 있고 재부팅 후에도 돌아오는지 확인합니다. 두 답이 모두 중요합니다. active는 지금 돌고 있다는 뜻이고, 재부팅을 견디게 하는 것은 enabled입니다.",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "호스트 방화벽에서 인바운드 포트를 엽니다. 온라인 표시에는 아웃바운드만 있으면 되지만, 상대가 중계하고 저장하는 통로는 이 포트들입니다.",
          code: PORTS_CODE,
        },
        {
          text: "클라우드 VPS라면 제공업체의 보안 그룹에서도 같은 포트를 허용하세요. ufw만으로는 상위에서 막힌 채로 남고, 그동안 노드는 계속 정상으로 보입니다.",
        },
        {
          text: "/me로 돌아가 노드가 온라인으로 바뀌는지 지켜봅니다 — 보통 30초 정도입니다. 그 뒤로 계정의 전송은 자동으로 이 노드를 우선합니다.",
        },
        {
          text: "선택: 「중계/저장에 내 노드만 사용」을 켜면 공유 인프라로 조용히 되돌아가는 대신 전송이 실패합니다.",
        },
      ],
      success: {
        label: "정상적인 노드의 모습",
        body: [
          "systemd가 서비스를 active이자 enabled로 보고하고, 내 노드 아래에서 노드가 온라인으로 표시됩니다. active만으로는 부족합니다 — enabled가 아닌 노드는 다음 재부팅에 사라집니다.",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "<your-token> 부분은 계정 페이지에서 자동으로 채워집니다. 위의 자리 표시자를 그대로 붙여넣지 마세요.",
        "RELAYIUM_NODE_STORAGE_DIR는 릴레이뿐 아니라 블롭 스토리지도 켭니다. 노드가 저장하지 않고 릴레이만 하기를 원한다면 이를 끈 채로(변수를 생략) 두세요.",
        "시작되었는지 확인: `systemctl status relayium-node`(active/running으로 표시되어야 함).",
        "부팅 지속성 확인: `systemctl is-enabled relayium-node`(enabled로 표시되어야 함).",
        "로그 실시간 확인: `journalctl -u relayium-node -f`.",
        "3478/udp는 피어가 릴레이에 사용하는 TURN 포트이고, 8081/tcp는 블롭 스토리지 HTTP 포트이며, 49152–65535/udp는 릴레이 미디어 범위입니다.",
        "클라우드 VPS에서는 ufw뿐 아니라 공급자의 보안 그룹/네트워크 방화벽에서도 이들을 허용하세요.",
      ],
    },
    {
      heading: "이 설치 프로그램을 root로 실행해도 안전한가요?",
      body: [
        "무엇보다 먼저: BYO 노드는 당사 자체 플릿 노드와 완전히 같은 코드, 완전히 같은 강화 설정으로 동작합니다 — 같은 서명된 릴리스의 같은 바이너리를, 같은 스크립트로, 같은 systemd 유닛 아래에 설치합니다. 유일한 차이는 그 머신이 누구의 것이냐뿐입니다. 아래 설명은 양쪽 모두에 해당합니다.",
        "인터넷에서 받아온 스크립트를 root 셸로 파이프하는 명령에 대해 나올 만한 질문이며, “괜찮습니다”라는 안심 대신 구체적인 답을 받을 자격이 있습니다. root는 설치에만 쓰이고, 그 이후 노드가 하는 일에는 전혀 쓰이지 않습니다. 설치 프로그램은 로그인 셸도 홈 디렉터리도 없는 relayium-node 시스템 계정을 만들고, systemd 유닛을 작성하고, 서비스를 시작한 뒤 종료합니다. 노드 자체는 결코 root로 실행되지 않습니다. 유닛에 User=relayium-node가 지정되어 있어, 온라인이 되는 순간부터 내 머신에서 아무것도 소유하지 않은 비특권 계정입니다. (기본으로 켜져 있는 자동 업데이트는 root로 실행되는 두 번째 유닛을 추가합니다 — 다음 절 전체가 그 유닛이 무엇을 할 수 있고 무엇을 할 수 없는지에 대한 이야기입니다.)",
        "그 계정 주위로 유닛은 systemd 샌드박스를 두릅니다. 모든 줄이 “노드 프로세스가 장악당했을 때 공격자가 다음으로 손을 뻗을 대상”을 겨냥합니다. 감춰 둔 것은 없습니다. 설치 후 `cat /etc/systemd/system/relayium-node.service`로 유닛 전체를 읽어 보세요.",
      ],
      table: {
        head: ["유닛의 설정", "노드가 침해되었을 때 무엇을 막는가"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "공격자는 아무것도 가지지 않은 사용자일 뿐이며 root가 아닙니다."],
          ["ProtectHome=yes", "/home과 /root가 보이지 않습니다 — SSH 개인키도, 다른 프로젝트의 데이터도 훔칠 수 없습니다."],
          ["ProtectSystem=strict", "파일 시스템 전체가 읽기 전용이라 어떤 시스템 파일도 수정할 수 없습니다."],
          ["ReadWritePaths=", "쓸 수 있는 곳은 노드 자신의 상태 디렉터리와, 스토리지를 설정한 경우 그 디렉터리뿐입니다. 다른 곳에 대한 쓰기는 모두 실패합니다."],
          ["NoExecPaths=", "스토리지 디렉터리 안의 것은 실행할 수 없습니다 — 업로드된 파일이 실행될 수 없습니다."],
          ["NoNewPrivileges=yes", "root로 돌아갈 경로가 없어 흔한 권한 상승 수법이 막힙니다."],
          ["CapabilityBoundingSet=", "비어 있음 — Linux 케이퍼빌리티를 전혀 부여하지 않습니다."],
          ["ProtectKernelTunables=yes, ProtectKernelModules=yes", "커널에 손이 닿지 않습니다: sysctl 변경도, 모듈 로드도 불가능하고 루트킷을 심을 수 없습니다."],
        ],
      },
      bullets: [
        "ReadWritePaths와 NoExecPaths가 스토리지 디렉터리를 가리키는 것은 실제로 저장을 하는 노드뿐입니다. 릴레이 전용 노드에는 두 줄 모두 없으며, 자신의 상태 디렉터리 외에는 어디에도 쓸 수 없습니다.",
        "일반적인 구성에서 케이퍼빌리티 집합은 비어 있습니다. 유일한 예외는 직접 다운로드 리스너를 1024 미만 포트에 두는 경우로, 바인딩에 CAP_NET_BIND_SERVICE가 필요합니다. 기본 다운로드 포트는 1024보다 큰 2053이므로 아무것도 부여되지 않습니다.",
        "노드는 키를 갖고 있지 않습니다. 파일은 업로드되기 전에 보내는 쪽에서 암호화되므로, 스토리지 노드에 도달하는 것은 그 노드가 읽을 수 없는 암호문입니다 — 내 노드도, 본인도 읽을 수 없습니다.",
      ],
    },
    {
      heading: "자동 업데이터가 할 수 있는 일과 할 수 없는 일",
      body: [
        "설치 프로그램은 자동 업데이트 타이머도 설정하며, 기본값은 켜짐입니다. relayium-node-update.timer가 약 10분마다 relayium.com에 “이 노드는 어떤 버전을 실행해야 하는지”를 묻습니다. 이것은 두 번째 유닛이고 root로 실행되므로, 그 자신에 대한 설명도 마땅히 필요합니다.",
        "중앙은 결코 바이너리를 보내지 않습니다. 응답의 전부는 버전 번호, 두 개의 플래그(이 노드가 지금 움직여도 되는지, 이것이 의도적인 다운그레이드인지), 그리고 짧은 사유 문자열입니다 — 바이트도, URL도, 명령도 없습니다. 그다음 노드가 스스로 그 릴리스를 받아 아카이브의 SHA-256을 릴리스의 checksums.txt와 대조하고, checksums.txt에 대한 ECDSA P-256 서명을 바로 그 검증을 수행하는 바이너리 자체에 컴파일되어 들어 있는 공개키로 검증합니다. 그 키의 개인키 쪽은 이 폴링에 답하는 서버에 있지 않습니다. 따라서 중앙이 침해되더라도 버전을 지목할 수는 있어도, 검증을 통과하는 바이너리를 만들어 낼 수는 없습니다.",
        "업데이터와 노드는 권한이 정반대인 두 개의 별도 프로세스입니다. relayium-node.service는 위의 샌드박스 그 자체로, ProtectSystem=strict 아래에서는 /usr/local/bin에 쓰는 것 자체가 불가능합니다. 즉 노드는 자기 것을 포함해 어떤 바이너리도 수정할 수 없습니다. relayium-node-update.service는 root로 실행되는 작은 oneshot 유닛이며 의도적으로 샌드박스를 두르지 않습니다. /usr/local/bin의 파일을 교체하려면, 바로 노드의 샌드박스가 막으려는 그 권한이 필요하기 때문입니다. 그 권한을 노드 본체의 강화를 느슨하게 푸는 대신 단일 목적 유닛 하나에 가둬 두는 것 — 그것이 이 분리의 핵심입니다. root를 가진 프로세스는 바이너리를 교체만 하고, 우리 안의 프로세스는 결코 바이너리에 손댈 수 없습니다.",
        "업데이트가 잘못되면 스스로 되돌립니다. 업데이터는 이전 바이너리를 새 바이너리 옆에 남겨 두고 서비스를 재시작한 뒤 최대 10분간 하트비트를 지켜봅니다. 그 시간 안에 새 버전이 정상이라고 보고하지 않으면 이전 바이너리를 되돌려 놓고 다시 재시작하며, 그 불량 버전을 기록해 다시 시도하지 않습니다. 이 과정에서 저장된 파일이 읽히거나 옮겨지거나 삭제되는 일은 전혀 없습니다.",
      ],
      bullets: [
        "원하지 않는다면: RELAYIUM_NODE_AUTO_UPDATE=off를 주고 설치 프로그램을 다시 실행하세요. 타이머와 그 서비스는 비활성화되고 삭제됩니다. 노드는 계속 동작하며, 업데이트 시점은 직접 정합니다.",
        "노드를 완전히 그만두려면: 아래 “노드 제거하기”를 보세요.",
      ],
    },
    {
      heading: "노드 제거하기",
      body: [
        "제거는 스크립트 하나로 끝나며, 파일을 저장하는 노드든 릴레이만 하는 노드든 같은 스크립트를 씁니다. 유닛, 바이너리, 설정, 서비스 계정을 제거하고 노드가 사라졌음을 relayium.com에 최선을 다해 알립니다. 그 호출이 실패해도 터미널에 한 줄이 더 나올 뿐 제거가 고장 난 것은 아니며, 노드 ID가 출력되므로 수동으로 제거됨 표시를 할 수 있습니다.",
        "내려받고, 확인한 다음 실행하세요. sh로 바로 파이프하면 404나 일시적인 네트워크 문제에서 명령 전체가 아무것도 출력하지 않고 종료 코드 0으로 끝나, 제거가 성공한 것처럼 보입니다.",
        "아는 것만 지웁니다. 상태 디렉터리나 저장 디렉터리에 예상치 못한 파일이 있으면 지우지 않고 보관한 뒤 보고합니다.",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "저장 디렉터리에 알아보지 못하는 파일이 하나라도 남아 있으면 거부합니다(정리가 아직 닿지 않은 만료된 blob도 마찬가지). 저장된 파일은 정확히 한 노드에만 있고 복제본이 없기 때문입니다. 0이 될 때까지 기다리거나, 그 파일들이 도달 불가능해지는 것을 감수하고 RELAYIUM_NODE_FORCE=1을 넘기세요.",
        "blob이 어디 있는지 판단할 수 없으면 추측하지 않고 멈춥니다. RELAYIUM_NODE_ASSUME_NO_STORAGE=1이 유일한 통과 방법이며, 그래도 알아보지 못하는 것은 삭제하지 않습니다.",
        "저장 디렉터리 자체는 RELAYIUM_NODE_PURGE_STORAGE=1을 함께 넘기지 않는 한 남습니다. 환경 변수는 `| sudo sh`를 넘지 못하므로 `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh` 형태로 넘기세요.",
        "그다음 `systemctl status relayium-node`는 not-found여야 하고 relayium-node 타이머도 보이지 않아야 합니다. 나중에 다시 설치하면 계정에 생기는 것은 완전히 새 노드입니다. 제거가 노드의 신원 파일을 지우므로, 재설치는 옛 노드를 되살리는 것이 아니라 새로 등록하는 것입니다.",
      ],
    },
    {
      heading: "잘 안 될 때",
      body: [
        "올라오지 않는 노드는 거의 모두 다섯 가지 중 하나이며, 그중 셋은 서버에서 보면 멀쩡합니다. 서비스는 돌고 있고, 아니라고 말해 주는 것은 계정 페이지나 리스닝 소켓뿐입니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "셸이 「relayium-node: command not found」라고 답합니다.",
            code: [
              `command -v relayium-node
# 아무것도 출력되지 않음`,
            ],
            fix: "바이너리가 설치되어 있지 않습니다. relayium-node를 따로 설치하는 일은 없습니다 — 계정 페이지의 한 줄 명령이 바로 바이너리를 내려받아 PATH에 놓고 서비스로 시작해 주는 것입니다. 그 명령을 실행하세요.",
          },
          {
            symptom: "서비스는 active인데 계정 페이지에서 노드가 끝내 온라인이 되지 않습니다.",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "온라인 여부는 아웃바운드 하트비트로 결정되므로 여기서 방화벽이 원인인 경우는 드물고, 대개 등록 실패입니다. 토큰은 일회용이라 이미 실행한 명령이나 이전 시도에서 남은 옛 명령은 실패합니다. 노드 추가를 다시 눌러 새 명령을 받아 실행하세요.",
          },
          {
            symptom: "노드는 온라인인데 전송이 여전히 공유 인프라를 지나갑니다.",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "온라인은 아웃바운드 하트비트만 증명합니다. 상대에게 필요한 것은 인바운드 포트입니다. 노드가 리스닝 중인지 확인한 뒤 호스트 방화벽과 클라우드 보안 그룹 양쪽에서 3478/udp, 8081/tcp, 49152-65535/udp를 여세요. 조용한 폴백을 완전히 배제하려면 내 노드만 사용 설정을 켜면 됩니다.",
          },
          {
            symptom: "제거 명령이 아무것도 출력하지 않고 종료 코드 0으로 끝났는데 서비스는 그대로입니다.",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "실패한 다운로드를 sh로 파이프했을 때의 모습 그대로입니다. 404나 일시적인 네트워크 문제는 아무것도 출력하지 않고 종료 코드 0으로 끝나 성공처럼 읽힙니다. 스크립트를 내려받고 비어 있지 않은지 확인한 다음 실행하세요 — 이 문서의 명령이 파이프 하나가 아니라 세 부분으로 쓰인 이유가 그것입니다.",
          },
          {
            symptom: "저장 디렉터리에 아직 파일이 남아 있어 제거가 거부됩니다.",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "의도된 동작입니다. 저장된 파일은 정확히 한 노드에만 존재하고 복제본이 없으므로, 노드를 없애면 그 파일들에 다시 닿을 수 없습니다. 블롭이 만료되어 개수가 0이 될 때까지 기다리거나, RELAYIUM_NODE_FORCE=1로 그 손실을 감수하세요. 환경 변수는 sudo sh로 가는 파이프를 넘지 못하므로 sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh 형태로 넘겨야 합니다.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "“relayium-node: command not found”가 떴습니다 — 무엇이 잘못되었나요?",
        a: "relayium-node 바이너리를 설치하기 전에 실행한 것입니다. 계정 페이지의 한 줄 설치 명령어(curl … | sudo … sh 형태)를 사용하세요. 이것이 바이너리를 다운로드하여 PATH에 놓고 서비스로 시작합니다. relayium-node를 별도로 설치하는 일은 결코 없습니다.",
      },
      {
        q: "재부팅 후에도 노드가 온라인을 유지하나요?",
        a: "네. 설치 프로그램은 부팅 시 활성화되고 Restart=always로 설정된 systemd 서비스를 등록하므로, 재부팅 후 복귀하고 충돌하면 스스로 재시작합니다. 추가로 실행할 것은 없습니다.",
      },
      {
        q: "이것은 Relayium 셀프 호스팅과 어떻게 다른가요?",
        a: "Bring-your-own-node는 평소의 relayium.com 계정과 앱을 그대로 유지하면서 트래픽을 운반할 본인 소유의 노드를 추가하는 것뿐입니다. 셀프 호스팅은 서버 스택 전체(계정, 웹 앱, 시그널링)를 본인 도메인에서 운영합니다. 이에 대해서는 “Relayium 셀프 호스팅” 가이드를 참조하세요.",
      },
      {
        q: "다른 사람이 제 노드를 사용하거나 제 데이터를 볼 수 있나요?",
        a: "아니요. 노드는 토큰으로 내 계정에 연결되어 그 계정의 트래픽만 운반합니다. 실시간 전송은 종단 간 암호화되고, 저장된 블롭은 내 노드가 읽을 수 없는 암호문입니다. 내 데이터와 노드 구성은 오직 본인만 사용할 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "로그인하여 계정 페이지를 열고 1분도 안 되어 첫 노드를 추가하세요.",
    button: "계정 페이지 열기",
    href: "/me",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Bring Your Own Node: Relay und Speicher von Relayium kostenlos nutzen",
  description:
    "Binde mit einem einzigen Befehl deinen eigenen Relay-/Speicher-Node an dein Relayium-Konto an. Deine Übertragungen laufen dann über deinen Node — nicht über unsere abrechnungspflichtigen Server —, sind also kostenlos, und die Daten bleiben auf Hardware, die du selbst kontrollierst.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Netzübergreifende Übertragungen und gespeicherte Links nutzen Relay-Bandbreite und Speicherplatz, die uns Geld kosten, und laufen daher auf einem kostenlosen Kontingent, das darüber hinaus kostenpflichtig ist. Es gibt einen Ausweg: Betreibe deinen eigenen Relay-/Speicher-Node, binde ihn an dein Konto, und deine Übertragungen fließen über deinen Node statt über unseren — nichts wird gemessen, nichts wird berechnet.",
    "Das unterscheidet sich davon, den gesamten Relayium-Server selbst zu hosten. Du verwendest weiterhin dein normales relayium.com-Konto und dieselben Apps; du fügst lediglich einen Node hinzu, der dir gehört und deinen Datenverkehr trägt. Diese Anleitung führt dich in etwa fünf Minuten von einem frischen Linux-Rechner zu einem Online-Node.",
  ],
  sections: [
    {
      heading: "Warum einen eigenen Node betreiben",
      body: [
        "Zwei Gründe. Erstens die Kosten: Ein Node, der dir gehört, trägt deinen Relay- und Speicherverkehr direkt, berührt also nie unsere abrechnungspflichtige Infrastruktur, und es gibt nichts zu berechnen — deine Nutzung ist kostenlos, egal wie groß.",
        "Zweitens die Kontrolle: Die weitergeleiteten Bytes und gespeicherten Blobs liegen auf Hardware, die du betreibst, unter deiner eigenen betrieblichen Kontrolle. Echtzeit-Übertragungen bleiben auf dem gesamten Weg Ende-zu-Ende-verschlüsselt, sodass selbst dein eigener Node immer nur Chiffretext sieht.",
      ],
    },
    {
      heading: "Den Node installieren und online bringen",
      prereqs: {
        label: "Was du vor Schritt 1 brauchst",
        items: [
          "Einen aus dem Internet erreichbaren Linux-Server — ein günstiger VPS oder eine dauerhaft laufende Kiste zu Hause tun es beide. amd64 und arm64 werden unterstützt.",
          "root auf diesem Server, oder sudo. Die Installation braucht es einmal; der Node selbst läuft nie als root.",
          "Die Möglichkeit, eingehende Ports zu öffnen — in der Host-Firewall und auf einem Cloud-VPS zusätzlich in der Security Group des Anbieters.",
          "Ein relayium.com-Konto, an dem du angemeldet bist. Der Installationsbefehl wird auf der Kontoseite erzeugt und trägt ein Einmal-Token.",
          "Plattenplatz, aber nur wenn der Node außer relayen auch speichern soll. Ein reiner Relay-Node braucht keinen — lass RELAYIUM_NODE_STORAGE_DIR dann weg.",
        ],
      },
      body: [
        "Vier Dinge der Reihe nach: den Befehl erzeugen, ihn ausführen, die Ports öffnen und bestätigen, dass der Node online gegangen ist. Auf einer frischen Kiste rund fünf Minuten.",
      ],
      steps: [
        {
          text: "Melde dich auf relayium.com an und öffne deine Kontoseite unter /me.",
        },
        {
          text: "Scroll zu Meine Nodes und klick auf Node hinzufügen. Kopiere den Installationsbefehl sofort — das Token darin wird genau einmal angezeigt und lässt sich nicht erneut abrufen.",
        },
        {
          text: "Führ ihn auf deinem Server aus. Er lädt das relayium-node-Binary, prüft dessen Checksumme, installiert es nach /usr/local/bin, schreibt einen systemd-Dienst und startet ihn.",
          code: [INSTALL_CMD],
        },
        {
          text: "Bestätige, dass der Dienst läuft und nach einem Neustart wiederkommt. Beide Antworten zählen: active heißt, er läuft jetzt, enabled ist das, was einen Neustart überlebt.",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "Öffne die eingehenden Ports in der Host-Firewall. Für den Online-Status reicht ausgehender Zugriff, aber Peers relayen und speichern über genau diese Ports.",
          code: PORTS_CODE,
        },
        {
          text: "Auf einem Cloud-VPS erlaub dieselben Ports zusätzlich in der Security Group des Anbieters. Mit ufw allein bleiben sie weiter oben dicht — und der Node sieht die ganze Zeit gesund aus.",
        },
        {
          text: "Zurück auf /me: warte, bis der Node auf Online springt, meist in etwa 30 Sekunden. Ab da bevorzugen die Übertragungen deines Kontos ihn automatisch.",
        },
        {
          text: "Optional: Schalte \"Nur meine eigenen Nodes für Relay/Speicher verwenden\" ein, damit eine Übertragung fehlschlägt, statt still auf unsere geteilte Infrastruktur zurückzufallen.",
        },
      ],
      success: {
        label: "So sieht ein funktionierender Node aus",
        body: [
          "systemd meldet den Dienst als active UND enabled, und der Node steht unter Meine Nodes auf Online. active allein genügt nicht — ein Node ohne enabled ist nach dem nächsten Neustart weg.",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "Der Teil <your-token> wird auf der Kontoseite für dich ausgefüllt — füge den obigen Platzhalter nicht wörtlich ein.",
        "RELAYIUM_NODE_STORAGE_DIR aktiviert neben dem Relay auch die Blob-Speicherung. Lass es weg (die Variable auslassen), wenn der Node nur weiterleiten und nicht speichern soll.",
        "Prüfen, ob er gestartet ist: `systemctl status relayium-node` (sollte active/running anzeigen).",
        "Boot-Persistenz bestätigen: `systemctl is-enabled relayium-node` (sollte enabled anzeigen).",
        "Logs live verfolgen: `journalctl -u relayium-node -f`.",
        "3478/udp ist der TURN-Port, den Peers zum Weiterleiten verwenden; 8081/tcp ist der HTTP-Port der Blob-Speicherung; 49152–65535/udp ist der Relay-Medienbereich.",
        "Auf einem Cloud-VPS erlaube sie auch in der Sicherheitsgruppe / Netzwerk-Firewall des Anbieters, nicht nur in ufw.",
      ],
    },
    {
      heading: "Ist es sicher, diesen Installer als root auszuführen?",
      body: [
        "Zuerst das Wichtigste: BYO-Nodes laufen mit demselben Code und derselben Härtung wie unsere eigenen Flotten-Nodes — dieselbe Binärdatei aus demselben signierten Release, installiert vom selben Skript, unter derselben systemd-Unit. Der einzige Unterschied ist, wem die Maschine gehört. Alles Folgende beschreibt beide.",
        "Das ist eine berechtigte Frage zu einem Befehl, der ein Skript aus dem Internet in eine root-Shell leitet, und sie verdient eine konkrete Antwort statt einer Beruhigung. root wird für die Installation gebraucht und für nichts, was der Node danach tut. Der Installer legt ein Systemkonto namens relayium-node ohne Login-Shell und ohne Home-Verzeichnis an, schreibt die systemd-Units, startet den Dienst und beendet sich. Der Node selbst läuft nie als root: Seine Unit setzt User=relayium-node, er ist also ab der Sekunde, in der er online geht, ein unprivilegiertes Konto, dem auf deiner Maschine nichts gehört. (Die standardmäßig aktive Auto-Aktualisierung fügt allerdings eine zweite Unit hinzu, die als root läuft — der nächste Abschnitt handelt ausschließlich davon, was diese kann und was nicht.)",
        "Um dieses Konto legt die Unit eine systemd-Sandbox. Jede Zeile zielt auf etwas, wonach ein Angreifer greifen würde, der den Node-Prozess je übernimmt. Nichts davon ist vor dir verborgen: Lies nach der Installation die ganze Unit mit `cat /etc/systemd/system/relayium-node.service`.",
      ],
      table: {
        head: ["In der Unit", "Was es verhindert, falls der Node je kompromittiert wird"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "Der Angreifer ist ein Benutzer, dem nichts gehört — nicht root."],
          ["ProtectHome=yes", "/home und /root sind unsichtbar — keine privaten SSH-Schlüssel, keine Daten anderer Projekte."],
          ["ProtectSystem=strict", "Das gesamte Dateisystem ist schreibgeschützt; keine Systemdatei lässt sich ändern."],
          ["ReadWritePaths=", "Beschreibbar sind nur das eigene Statusverzeichnis des Nodes und, falls konfiguriert, das Speicherverzeichnis. Schreibzugriffe woanders schlagen fehl."],
          ["NoExecPaths=", "Nichts im Speicherverzeichnis ist ausführbar — eine hochgeladene Datei kann nicht gestartet werden."],
          ["NoNewPrivileges=yes", "Kein Weg zurück zu root; die üblichen Eskalationstricks sind versperrt."],
          ["CapabilityBoundingSet=", "Leer — überhaupt keine Linux-Capabilities."],
          ["ProtectKernelTunables=yes, ProtectKernelModules=yes", "Der Kernel ist außer Reichweite: keine sysctl-Änderungen, kein Laden von Modulen, kein Rootkit."],
        ],
      },
      bullets: [
        "ReadWritePaths und NoExecPaths nennen das Speicherverzeichnis nur auf einem Node, der tatsächlich speichert. Ein reiner Relay-Node bekommt keine der beiden Zeilen und kann nirgends außer in sein eigenes Statusverzeichnis schreiben.",
        "Im Normalfall ist die Capability-Menge leer. Die einzige Ausnahme ist ein Direkt-Download-Listener auf einem Port unter 1024, der zum Binden CAP_NET_BIND_SERVICE braucht; der voreingestellte Download-Port ist 2053, also über 1024, sodass gar nichts gewährt wird.",
        "Der Node besitzt keine Schlüssel. Dateien werden vom Absender vor dem Hochladen verschlüsselt, auf einem Speicher-Node landet also Chiffretext, den er nicht lesen kann — das gilt auch für deinen eigenen Node und auch für dich.",
      ],
    },
    {
      heading: "Was die Auto-Aktualisierung kann und was nicht",
      body: [
        "Der Installer richtet außerdem einen Selbstaktualisierungs-Timer ein, standardmäßig aktiv: relayium-node-update.timer fragt relayium.com etwa alle zehn Minuten, welche Version dieser Node laufen lassen soll. Das ist eine zweite Unit, und sie läuft als root — sie schuldet dir also eine eigene Erklärung.",
        "Die Zentrale schickt nie eine Binärdatei. Ihre gesamte Antwort besteht aus einer Versionsnummer, zwei Flags (darf dieser Node jetzt wechseln, und ist das ein bewusstes Downgrade) und einer kurzen Begründung — keine Bytes, keine URL, kein Befehl. Der Node holt sich dieses Release anschließend selbst, prüft den SHA-256 des Archivs gegen die checksums.txt des Releases und verifiziert eine ECDSA-P-256-Signatur über die checksums.txt mit einem öffentlichen Schlüssel, der in genau die Binärdatei einkompiliert ist, die diese Prüfung durchführt. Die private Hälfte dieses Schlüssels liegt nicht auf dem Server, der diese Abfragen beantwortet. Eine kompromittierte Zentrale könnte also eine Version benennen; eine Binärdatei, die die Prüfung besteht, könnte sie nicht herstellen.",
        "Aktualisierer und Node sind zwei getrennte Prozesse mit entgegengesetzten Rechten. relayium-node.service ist die obige Sandbox — unter ProtectSystem=strict kann er überhaupt nicht nach /usr/local/bin schreiben, der Node kann also nie eine Binärdatei verändern, auch nicht seine eigene. relayium-node-update.service ist eine kleine oneshot-Unit, die als root läuft und bewusst keine Sandbox trägt, denn eine Datei in /usr/local/bin zu ersetzen erfordert genau das Privileg, das die Sandbox des Nodes ihm verwehren soll. Diese Macht in einer einzigen Unit mit einem einzigen Zweck zu bündeln, statt die Härtung des Nodes aufzuweichen, ist der ganze Sinn der Trennung: Der Prozess mit root tauscht nur Binärdateien aus, und der Prozess im Käfig kommt an keine heran.",
        "Eine misslungene Aktualisierung macht sich selbst rückgängig. Der Aktualisierer legt die alte Binärdatei neben die neue, startet den Dienst neu und wartet bis zu zehn Minuten auf einen Heartbeat; meldet sich die neue Version in diesem Fenster nicht gesund, stellt er die alte Binärdatei zurück, startet erneut neu und vermerkt die fehlerhafte Version, damit sie nicht wieder versucht wird. Gespeicherte Dateien werden dabei nie gelesen, verschoben oder gelöscht.",
      ],
      bullets: [
        "Nicht erwünscht: Führe den Installer erneut mit RELAYIUM_NODE_AUTO_UPDATE=off aus. Der Timer und sein Dienst werden deaktiviert und gelöscht; der Node läuft weiter, und du aktualisierst ihn, wann du willst.",
        "Node ganz aufgeben: siehe „Node entfernen“ weiter unten.",
      ],
    },
    {
      heading: "Node entfernen",
      body: [
        "Die Deinstallation ist ein einziges Skript — dasselbe, ob dein Node Dateien speichert oder nur weiterleitet. Es entfernt die Units, die Binärdatei, die Konfiguration und das Dienstkonto und meldet relayium.com nach bestem Wissen, dass der Node weg ist. Schlägt dieser Aufruf fehl, ist das eine Zeile auf deinem Terminal und keine kaputte Deinstallation — die ausgegebene Node-ID erlaubt es, ihn von Hand als entfernt zu markieren.",
        "Herunterladen, prüfen, dann ausführen. Direkt in sh zu pipen bedeutet, dass ein 404 oder ein kurzer Netzaussetzer den ganzen Befehl nichts ausgeben und mit Code 0 enden lässt — was wie eine erfolgreiche Deinstallation aussieht.",
        "Entfernt wird nur, was es kennt: Unerwartetes im Status- oder Speicherverzeichnis wird behalten und gemeldet statt mitgelöscht.",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "Es verweigert die Deinstallation, solange im Speicherverzeichnis noch eine Datei liegt, die es nicht kennt — auch ein abgelaufener Blob, den die Aufräumung noch nicht erreicht hat. Jede gespeicherte Datei liegt auf genau einem Node, Repliken gibt es nicht. Warte, bis dieser Zähler null ist, oder übergib RELAYIUM_NODE_FORCE=1 und nimm in Kauf, dass diese Dateien unerreichbar werden.",
        "Kann es nicht ermitteln, wo deine Blobs liegen, hält es an, statt zu raten. RELAYIUM_NODE_ASSUME_NO_STORAGE=1 ist der einzige Weg daran vorbei — und löscht weiterhin nichts, was es nicht kennt.",
        "Das Speicherverzeichnis selbst bleibt erhalten, sofern du nicht zusätzlich RELAYIUM_NODE_PURGE_STORAGE=1 übergibst. Umgebungsvariablen überleben `| sudo sh` nicht — übergib sie als `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh`.",
        "Danach sollte `systemctl status relayium-node` not-found melden und kein relayium-node-Timer mehr gelistet sein. Installierst du später erneut, ist der Node, den dein Konto bekommt, ein ganz neuer: die Deinstallation löscht die Identitätsdatei, eine Neuinstallation registriert also einen frischen Node statt den alten wiederzubeleben.",
      ],
    },
    {
      heading: "Wenn es nicht funktioniert",
      body: [
        "Fünf Fehler decken fast jeden Node ab, der nicht hochkommt, und drei davon sehen vom Server aus gesund aus: Der Dienst läuft, und nur die Kontoseite oder ein lauschender Socket sagt etwas anderes.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Die Shell antwortet \"relayium-node: command not found\".",
            code: [
              `command -v relayium-node
# keine Ausgabe`,
            ],
            fix: "Das Binary ist nicht installiert. relayium-node wird nie separat installiert — der Einzeiler von der Kontoseite ist das, was es herunterlädt, in deinen PATH legt und als Dienst startet. Führ stattdessen diesen Befehl aus.",
          },
          {
            symptom: "Der Dienst ist active, aber der Node springt auf der Kontoseite nie auf Online.",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "Über Online entscheidet ein ausgehender Heartbeat, eine Firewall ist hier also selten die Ursache — die Registrierung ist es. Das Token gilt einmal, ein bereits ausgeführter oder ein alter Befehl aus einem früheren Versuch scheitert deshalb. Klick erneut auf Node hinzufügen und führ den frischen Befehl aus.",
          },
          {
            symptom: "Der Node steht auf Online, aber Übertragungen laufen weiter über unsere geteilte Infrastruktur.",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "Online belegt nur den ausgehenden Heartbeat. Peers brauchen die eingehenden Ports: Prüfe, dass der Node lauscht, und öffne dann 3478/udp, 8081/tcp und 49152-65535/udp in der Host-Firewall UND in der Cloud-Security-Group. Um ein stilles Zurückfallen ganz auszuschließen, schalte die Einstellung für ausschließlich eigene Nodes ein.",
          },
          {
            symptom: "Die Deinstallation gab nichts aus, endete mit 0, und der Dienst ist noch da.",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "Genau so sieht es aus, wenn ein fehlgeschlagener Download in sh gepipet wird: Ein 404 oder ein kurzer Netzaussetzer gibt nichts aus und endet mit 0, was sich wie Erfolg liest. Lad das Skript herunter, prüfe, dass es nicht leer ist, und führ es dann aus — deshalb steht der Befehl in dieser Anleitung in drei Teilen und nicht als eine Pipe.",
          },
          {
            symptom: "Die Deinstallation verweigert sich, solange im Speicherverzeichnis noch Dateien liegen.",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "Das ist Absicht. Jede gespeicherte Datei liegt auf genau einem Node, Repliken gibt es nicht — den Node zu entfernen macht sie also unerreichbar. Warte, bis die Zahl mit dem Ablaufen der Blobs auf null geht, oder nimm den Verlust mit RELAYIUM_NODE_FORCE=1 in Kauf. Umgebungsvariablen überleben eine Pipe nach sudo sh nicht, übergib sie also als sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufig gestellte Fragen",
    items: [
      {
        q: "Ich habe „relayium-node: command not found“ bekommen — was ist schiefgelaufen?",
        a: "Du hast die relayium-node-Binärdatei ausgeführt, bevor du sie installiert hast. Verwende den Einzeiler-Installationsbefehl von der Kontoseite (in der Form curl … | sudo … sh): Er lädt die Binärdatei herunter, legt sie in deinen PATH und startet sie als Dienst. Du installierst relayium-node nie separat.",
      },
      {
        q: "Bleibt der Node nach einem Neustart online?",
        a: "Ja. Der Installer registriert einen systemd-Dienst, der beim Booten aktiviert und auf Restart=always gesetzt ist, sodass er nach einem Neustart zurückkehrt und sich bei einem Absturz selbst neu startet. Es ist nichts weiter auszuführen.",
      },
      {
        q: "Wie unterscheidet sich das davon, Relayium selbst zu hosten?",
        a: "Bring-your-own-node behält dein normales relayium.com-Konto und deine Apps bei und fügt lediglich einen Node hinzu, der dir gehört und deinen Verkehr trägt. Hostest du Relayium selbst, läuft der gesamte Server-Stack (Konten, Web-App, Signalisierung) auf deiner eigenen Domain — siehe dazu die Anleitung „Relayium selbst hosten“.",
      },
      {
        q: "Kann jemand anderes meinen Node nutzen oder meine Daten sehen?",
        a: "Nein. Ein Node ist über seinen Token an dein Konto gebunden und trägt nur den Verkehr deines Kontos. Echtzeit-Übertragungen sind Ende-zu-Ende-verschlüsselt und gespeicherte Blobs sind Chiffretext, den dein Node nicht lesen kann. Deine Daten und deine Node-Konfiguration sind ausschließlich von dir nutzbar.",
      },
    ],
  },
  cta: {
    text: "Melde dich an, öffne deine Kontoseite und füge in unter einer Minute deinen ersten Node hinzu.",
    button: "Kontoseite öffnen",
    href: "/me",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Apportez votre propre nœud : utilisez gratuitement le relais et le stockage de Relayium",
  description:
    "Rattachez votre propre nœud de relais/stockage à votre compte Relayium en une seule commande. Vos transferts passent alors par votre nœud — et non par nos serveurs facturés à l'usage —, ils sont donc gratuits, et les données restent sur du matériel que vous contrôlez.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Les transferts inter-réseaux et les liens stockés consomment de la bande passante de relais et de l'espace disque qui nous coûtent de l'argent ; ils fonctionnent donc dans la limite d'un quota gratuit et deviennent payants au-delà. Il existe un moyen de contourner cela : faites tourner votre propre nœud de relais/stockage, rattachez-le à votre compte, et vos transferts passent par votre nœud au lieu du nôtre — rien de mesuré, rien de facturé.",
    "C'est différent d'auto-héberger l'ensemble du serveur Relayium. Vous continuez à utiliser votre compte relayium.com habituel et les mêmes applications ; vous ajoutez simplement un nœud qui vous appartient pour acheminer votre trafic. Ce guide vous mène d'une machine Linux vierge à un nœud en ligne en environ cinq minutes.",
  ],
  sections: [
    {
      heading: "Pourquoi faire tourner votre propre nœud",
      body: [
        "Deux raisons. D'abord, le coût : un nœud qui vous appartient achemine directement votre trafic de relais et de stockage, il ne touche donc jamais notre infrastructure facturée à l'usage et il n'y a rien à facturer — votre utilisation est gratuite, quelle que soit son ampleur.",
        "Ensuite, le contrôle : les octets relayés et les blobs stockés résident sur du matériel que vous exploitez, sous votre propre contrôle opérationnel. Les transferts en temps réel restent chiffrés de bout en bout sur tout le trajet, de sorte que même votre propre nœud ne voit jamais que du texte chiffré.",
      ],
    },
    {
      heading: "Installer le nœud et le mettre en ligne",
      prereqs: {
        label: "Ce qu'il vous faut avant l'étape 1",
        items: [
          "Un serveur Linux joignable depuis Internet — un VPS bon marché ou une machine allumée en permanence chez vous font l'affaire. amd64 et arm64 sont pris en charge.",
          "root sur ce serveur, ou sudo. L'installation en a besoin une fois ; le nœud lui-même ne tourne jamais en root.",
          "La possibilité d'ouvrir des ports entrants — dans le pare-feu de l'hôte et, sur un VPS cloud, dans le groupe de sécurité du fournisseur.",
          "Un compte relayium.com auquel vous êtes connecté. La commande d'installation est générée sur la page de compte et contient un jeton à usage unique.",
          "De l'espace disque, uniquement si le nœud doit aussi stocker et pas seulement relayer. Un nœud relais seul n'en a pas besoin — omettez alors RELAYIUM_NODE_STORAGE_DIR.",
        ],
      },
      body: [
        "Quatre choses dans l'ordre : générer la commande, l'exécuter, ouvrir les ports et confirmer que le nœud est passé en ligne. Environ cinq minutes sur une machine neuve.",
      ],
      steps: [
        {
          text: "Connectez-vous sur relayium.com et ouvrez votre page de compte, /me.",
        },
        {
          text: "Descendez jusqu'à Mes nœuds et cliquez sur Ajouter un nœud. Copiez tout de suite la commande d'installation — le jeton qu'elle contient n'est affiché qu'une fois et ne peut pas être réaffiché.",
        },
        {
          text: "Collez-la sur votre serveur. Elle télécharge le binaire relayium-node, en vérifie la somme de contrôle, l'installe dans /usr/local/bin, écrit un service systemd et le démarre.",
          code: [INSTALL_CMD],
        },
        {
          text: "Vérifiez que le service tourne et qu'il reviendra après un redémarrage. Les deux réponses comptent : active dit qu'il tourne maintenant, enabled est ce qui survit à un redémarrage.",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "Ouvrez les ports entrants dans le pare-feu de l'hôte. L'état En ligne ne demande qu'un accès sortant, mais c'est par ces ports que les pairs relaient et stockent.",
          code: PORTS_CODE,
        },
        {
          text: "Sur un VPS cloud, autorisez aussi les mêmes ports dans le groupe de sécurité du fournisseur. Avec ufw seul ils restent bloqués en amont, et le nœud a l'air parfaitement sain pendant tout ce temps.",
        },
        {
          text: "De retour sur /me, regardez le nœud passer En ligne — en général en une trentaine de secondes. À partir de là, les transferts de votre compte le préfèrent automatiquement.",
        },
        {
          text: "Facultatif : activez « N'utiliser que mes propres nœuds pour le relais et le stockage » pour qu'un transfert échoue au lieu de revenir discrètement sur notre infrastructure partagée.",
        },
      ],
      success: {
        label: "À quoi ressemble un nœud qui fonctionne",
        body: [
          "systemd signale le service à la fois active et enabled, et le nœud apparaît En ligne sous Mes nœuds. active seul ne suffit pas — un nœud qui n'est pas enabled disparaît au redémarrage suivant.",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "La partie <your-token> est renseignée pour vous sur la page du compte — ne collez pas le paramètre fictif ci-dessus tel quel.",
        "RELAYIUM_NODE_STORAGE_DIR active le stockage de blobs en plus du relais. Laissez-le désactivé (omettez la variable) si vous voulez que le nœud ne fasse que relayer, pas stocker.",
        "Vérifiez qu'il a démarré : `systemctl status relayium-node` (devrait indiquer active/running).",
        "Confirmez la persistance au démarrage : `systemctl is-enabled relayium-node` (devrait indiquer enabled).",
        "Suivez les journaux en direct : `journalctl -u relayium-node -f`.",
        "3478/udp est le port TURN que les pairs utilisent pour relayer ; 8081/tcp est le port HTTP du stockage de blobs ; 49152–65535/udp est la plage média du relais.",
        "Sur un VPS cloud, autorisez-les aussi dans le groupe de sécurité / pare-feu réseau du fournisseur, pas seulement dans ufw.",
      ],
    },
    {
      heading: "Est-il prudent d'exécuter cet installateur en root ?",
      body: [
        "Avant tout : les nœuds que vous apportez tournent avec le même code et le même durcissement que les nœuds de notre propre flotte — le même binaire issu de la même version signée, installé par le même script, sous la même unité systemd. La seule différence est de savoir à qui appartient la machine. Tout ce qui suit décrit les deux.",
        "La question est légitime pour une commande qui achemine un script pris sur Internet vers un shell root, et elle mérite une réponse précise plutôt qu'une formule rassurante. root sert à l'installation et à rien de ce que le nœud fait ensuite. L'installateur crée un compte système nommé relayium-node, sans shell de connexion ni répertoire personnel, écrit les unités systemd, démarre le service et se termine. Le nœud lui-même ne tourne jamais en root : son unité fixe User=relayium-node, si bien que dès la seconde où il est en ligne, c'est un compte non privilégié qui ne possède rien d'autre sur votre machine. (La mise à jour automatique, active par défaut, ajoute bien une seconde unité qui, elle, tourne en root — la section suivante lui est entièrement consacrée.)",
        "Autour de ce compte, l'unité dresse un bac à sable systemd. Chaque ligne vise quelque chose qu'un attaquant chercherait à atteindre s'il prenait un jour le contrôle du processus du nœud. Rien ne vous est caché : après l'installation, lisez l'unité entière avec `cat /etc/systemd/system/relayium-node.service`.",
      ],
      table: {
        head: ["Dans l'unité", "Ce que cela bloque si le nœud est un jour compromis"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "L'attaquant n'est qu'un utilisateur qui ne possède rien, pas root."],
          ["ProtectHome=yes", "/home et /root sont invisibles — ni clés SSH privées, ni données d'autres projets."],
          ["ProtectSystem=strict", "Tout le système de fichiers est en lecture seule ; aucun fichier système ne peut être modifié."],
          ["ReadWritePaths=", "Les seuls emplacements accessibles en écriture sont le répertoire d'état du nœud et, si vous en avez configuré un, le répertoire de stockage. Toute écriture ailleurs échoue."],
          ["NoExecPaths=", "Rien dans le répertoire de stockage ne peut être exécuté — un fichier téléversé ne peut pas être lancé."],
          ["NoNewPrivileges=yes", "Aucun chemin de retour vers root ; les astuces d'élévation habituelles sont fermées."],
          ["CapabilityBoundingSet=", "Vide — aucune capability Linux, pas une seule."],
          ["ProtectKernelTunables=yes, ProtectKernelModules=yes", "Le noyau est hors de portée : pas de modification de sysctl, pas de chargement de module, pas de rootkit."],
        ],
      },
      bullets: [
        "ReadWritePaths et NoExecPaths ne désignent le répertoire de stockage que sur un nœud qui stocke réellement. Un nœud purement relais n'a ni l'une ni l'autre de ces lignes et ne peut écrire nulle part sauf dans son propre répertoire d'état.",
        "Dans le cas normal, l'ensemble des capabilities est vide. La seule exception est un processus à l'écoute pour le téléchargement direct sur un port inférieur à 1024, qui a besoin de CAP_NET_BIND_SERVICE pour s'y attacher ; le port de téléchargement par défaut est 2053, au-dessus de 1024, donc rien n'est accordé.",
        "Le nœud ne détient aucune clé. Les fichiers sont chiffrés par l'expéditeur avant d'être téléversés : ce qui arrive sur un nœud de stockage est du texte chiffré qu'il ne peut pas lire — y compris sur votre propre nœud, et y compris pour vous.",
      ],
    },
    {
      heading: "Ce que la mise à jour automatique peut et ne peut pas faire",
      body: [
        "L'installateur met aussi en place un minuteur de mise à jour automatique, actif par défaut : relayium-node-update.timer demande à relayium.com, environ toutes les dix minutes, quelle version ce nœud devrait exécuter. C'est une seconde unité, et elle tourne en root : elle vous doit donc ses propres explications.",
        "Le serveur central n'envoie jamais de binaire. Toute sa réponse tient en un numéro de version, deux options (ce nœud peut-il bouger maintenant, et s'agit-il d'un retour en arrière délibéré) et une brève justification — pas d'octets, pas d'URL, pas de commande. C'est ensuite le nœud qui récupère lui-même cette version, compare le SHA-256 de l'archive au checksums.txt de la version, puis vérifie une signature ECDSA P-256 sur ce checksums.txt à l'aide d'une clé publique compilée dans le binaire même qui effectue la vérification. La moitié privée de cette clé ne se trouve pas sur le serveur qui répond à ces sondages. Un serveur central compromis pourrait donc nommer une version ; il ne pourrait pas fabriquer un binaire qui passe la vérification.",
        "Le programme de mise à jour et le nœud sont deux processus distincts aux pouvoirs opposés. relayium-node.service, c'est le bac à sable ci-dessus — sous ProtectSystem=strict, il ne peut pas écrire du tout dans /usr/local/bin, donc le nœud ne peut jamais modifier un binaire, pas même le sien. relayium-node-update.service est une petite unité oneshot qui tourne en root et ne porte délibérément aucun bac à sable, car remplacer un fichier dans /usr/local/bin exige précisément le privilège que le bac à sable du nœud existe pour lui refuser. Enfermer ce pouvoir dans une seule unité à usage unique, plutôt que d'assouplir le durcissement du nœud lui-même, est tout l'intérêt de cette séparation : le processus qui détient root ne fait que remplacer des binaires, et celui qui est en cage ne peut jamais en toucher un.",
        "Une mise à jour qui tourne mal se défait d'elle-même. Le programme conserve l'ancien binaire à côté du nouveau, redémarre le service, puis guette un signal de présence pendant dix minutes au plus ; si la nouvelle version ne se déclare pas saine dans cette fenêtre, il remet l'ancien binaire, redémarre à nouveau et note la version fautive pour ne pas la réessayer. Les fichiers stockés ne sont jamais lus, déplacés ni supprimés par tout cela.",
      ],
      bullets: [
        "Vous n'en voulez pas : relancez l'installateur avec RELAYIUM_NODE_AUTO_UPDATE=off. Le minuteur et son service sont désactivés puis supprimés ; le nœud continue de tourner et vous le mettez à jour quand vous le décidez.",
        "Vous arrêtez tout : voir « Retirer votre nœud » plus bas.",
      ],
    },
    {
      heading: "Retirer votre nœud",
      body: [
        "La désinstallation tient en un seul script, le même que votre nœud stocke des fichiers ou se contente de relayer. Il retire les unités, le binaire, la configuration et le compte de service, et signale à relayium.com, sans garantie, que le nœud a disparu. Si cet appel échoue, c'est une ligne sur votre terminal et non une désinstallation cassée — l'identifiant du nœud s'affiche pour qu'on puisse le marquer retiré à la main.",
        "Téléchargez-le, vérifiez-le, puis exécutez-le. Le faire passer directement dans sh signifie qu'une 404 ou un accroc réseau fait que toute la commande n'affiche rien et se termine avec le code 0 — ce qui ressemble à une désinstallation réussie.",
        "Il ne retire que ce qu'il reconnaît : tout élément inattendu dans le répertoire d'état ou de stockage est conservé et signalé plutôt que balayé.",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "Il refuse tant que le répertoire de stockage contient un fichier qu'il ne reconnaît pas — y compris un blob expiré que le nettoyage n'a pas encore atteint — car chaque fichier stocké vit sur un seul nœud et il n'y a pas de réplique. Attendez que ce décompte tombe à zéro, ou passez RELAYIUM_NODE_FORCE=1 en acceptant que ces fichiers deviennent inaccessibles.",
        "S'il n'arrive pas à déterminer où vivent vos blobs, il s'arrête au lieu de deviner. RELAYIUM_NODE_ASSUME_NO_STORAGE=1 est le seul moyen de passer outre, et il ne supprime toujours rien qu'il ne reconnaisse pas.",
        "Le répertoire de stockage lui-même est conservé sauf si vous passez aussi RELAYIUM_NODE_PURGE_STORAGE=1. Les variables d'environnement ne survivent pas à `| sudo sh` — passez-les via `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh`.",
        "Ensuite, `systemctl status relayium-node` doit répondre not-found et aucun minuteur relayium-node ne doit être listé. Si vous réinstallez plus tard, votre compte obtient un nœud entièrement nouveau : la désinstallation supprime le fichier d'identité, donc une nouvelle installation enregistre un nœud neuf au lieu de ressusciter l'ancien.",
      ],
    },
    {
      heading: "Quand ça ne marche pas",
      body: [
        "Cinq pannes couvrent presque tous les nœuds qui ne démarrent pas, et trois d'entre elles paraissent saines depuis le serveur : le service tourne, et seuls la page de compte ou une socket en écoute disent le contraire.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Le shell répond « relayium-node: command not found ».",
            code: [
              `command -v relayium-node
# aucune sortie`,
            ],
            fix: "Le binaire n'est pas installé. On n'installe jamais relayium-node séparément — c'est la commande d'une ligne de la page de compte qui le télécharge, le place dans votre PATH et le démarre comme service. Exécutez plutôt celle-là.",
          },
          {
            symptom: "Le service est active, mais le nœud ne passe jamais En ligne sur la page de compte.",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "L'état En ligne dépend d'un battement sortant, un pare-feu en est donc rarement la cause ici — c'est l'enregistrement. Le jeton est à usage unique, une commande déjà exécutée ou une ancienne restée d'un essai précédent échoue donc. Cliquez de nouveau sur Ajouter un nœud et relancez la commande fraîche.",
          },
          {
            symptom: "Le nœud est En ligne, mais les transferts passent toujours par notre infrastructure partagée.",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "En ligne ne prouve que le battement sortant. Ce dont les pairs ont besoin, ce sont les ports entrants : vérifiez que le nœud écoute, puis ouvrez 3478/udp, 8081/tcp et 49152-65535/udp dans le pare-feu de l'hôte ET dans le groupe de sécurité du cloud. Pour exclure tout repli silencieux, activez le réglage qui n'utilise que vos propres nœuds.",
          },
          {
            symptom: "La désinstallation n'a rien affiché, s'est terminée avec 0, et le service est toujours là.",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "C'est exactement l'allure d'un téléchargement raté envoyé dans sh : une 404 ou un accroc réseau n'affiche rien et se termine avec 0, ce qui se lit comme une réussite. Téléchargez le script, vérifiez qu'il n'est pas vide, puis exécutez-le — c'est pourquoi la commande de ce guide est écrite en trois parties plutôt qu'en un seul tube.",
          },
          {
            symptom: "La désinstallation refuse tant que le répertoire de stockage contient encore des fichiers.",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "C'est délibéré. Chaque fichier stocké vit sur un seul nœud et il n'existe aucune réplique, retirer le nœud les rend donc inatteignables. Attendez que le compte tombe à zéro à mesure que les blobs expirent, ou acceptez la perte avec RELAYIUM_NODE_FORCE=1. Les variables d'environnement ne survivent pas à un tube vers sudo sh, passez-les donc sous la forme sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "J'ai obtenu « relayium-node: command not found » — qu'est-ce qui a mal tourné ?",
        a: "Vous avez exécuté le binaire relayium-node avant de l'installer. Utilisez la commande d'installation en une ligne de la page du compte (de la forme curl … | sudo … sh) : elle télécharge le binaire, le place dans votre PATH et le démarre en tant que service. Vous n'installez jamais relayium-node séparément.",
      },
      {
        q: "Le nœud reste-t-il en ligne après un redémarrage ?",
        a: "Oui. L'installateur enregistre un service systemd qui est activé au démarrage et réglé sur Restart=always, si bien qu'il revient après un redémarrage et se relance de lui-même en cas de plantage. Rien de plus à exécuter.",
      },
      {
        q: "En quoi est-ce différent d'auto-héberger Relayium ?",
        a: "Bring-your-own-node conserve votre compte relayium.com et vos applications habituels et ajoute simplement un nœud qui vous appartient pour acheminer votre trafic. L'auto-hébergement fait tourner toute la pile serveur (comptes, application web, signalisation) sur votre propre domaine — voyez le guide « Auto-héberger Relayium » pour cela.",
      },
      {
        q: "Quelqu'un d'autre peut-il utiliser mon nœud ou voir mes données ?",
        a: "Non. Un nœud est rattaché à votre compte par son jeton et n'achemine que le trafic de votre compte. Les transferts en temps réel sont chiffrés de bout en bout et les blobs stockés sont du texte chiffré que votre nœud ne peut pas lire. Vos données et la configuration de votre nœud ne sont utilisables que par vous.",
      },
    ],
  },
  cta: {
    text: "Connectez-vous, ouvrez la page de votre compte et ajoutez votre premier nœud en moins d'une minute.",
    button: "Ouvrir la page du compte",
    href: "/me",
  },
  relatedHeading: "Continuer la lecture",
};

const ar = {
  title: "شغّل عقدتك الخاصة: استخدم مُرحِّل وتخزين Relayium مجانًا",
  description:
    "اربط عقدتك للترحيل/التخزين بحساب Relayium بأمر واحد. عندها تمر عمليات النقل عبر عقدتك — لا عبر خوادمنا المحسوبة بالاستهلاك — فتصبح مجانية، وتبقى البيانات على عتاد تتحكم فيه أنت.",
  updatedLabel: "آخر تحديث",
  lead: [
    "عمليات النقل عبر الشبكات والروابط المُخزَّنة تستهلك عرض نطاق المُرحِّل والقرص، وهذا يكلّفنا مالًا، لذا تعمل ضمن حصة مجانية وتصبح مدفوعة بعد تجاوزها. هناك طريقة لتفادي ذلك: شغّل عقدتك للترحيل/التخزين، اربطها بحسابك، فتتدفق عمليات نقلك عبر عقدتك بدل عقدتنا — لا شيء يُحسَب، ولا شيء يُفوتَر.",
    "هذا يختلف عن الاستضافة الذاتية لخادم Relayium بالكامل. تبقى تستخدم حساب relayium.com المعتاد ونفس التطبيقات؛ أنت فقط تضيف عقدة تملكها لتحمل حركتك. يأخذك هذا الدليل من جهاز Linux جديد إلى عقدة متصلة في نحو خمس دقائق.",
  ],
  sections: [
    {
      heading: "لماذا تشغّل عقدتك الخاصة",
      body: [
        "سببان. الأول هو التكلفة: عقدة تملكها تحمل حركة مُرحِّلك وتخزينك مباشرة، فلا تلمس أبدًا بنيتنا المحسوبة بالاستهلاك ولا يوجد ما يُفوتَر — استخدامك مجاني مهما كان كبيرًا.",
        "الثاني هو التحكم: البايتات المُرحَّلة والكتل المُخزَّنة تعيش على عتاد تشغّله أنت، تحت تحكمك التشغيلي الخاص. يبقى النقل الفوري مشفَّرًا من الطرف إلى الطرف طوال الطريق، لذا حتى عقدتك الخاصة لا ترى سوى نص مُشفَّر.",
      ],
    },
    {
      heading: "ثبّت العقدة وأوصلها إلى الإنترنت",
      prereqs: {
        label: "ما تحتاجه قبل الخطوة 1",
        items: [
          "خادم لينكس يمكن الوصول إليه من الإنترنت — سواء VPS رخيص أو جهاز يعمل دائمًا في البيت. المعماريتان amd64 وarm64 مدعومتان.",
          "صلاحية root على ذلك الخادم، أو sudo. التثبيت يحتاجها مرة واحدة، والعقدة نفسها لا تعمل بصلاحية root أبدًا.",
          "القدرة على فتح المنافذ الواردة — في جدار حماية المضيف، وعلى VPS سحابي في مجموعة الأمان لدى المزوّد أيضًا.",
          "حساب على relayium.com مسجَّل الدخول. أمر التثبيت يُولَّد في صفحة الحساب ويحمل رمزًا صالحًا لمرة واحدة.",
          "مساحة قرص، فقط إن أردت للعقدة أن تخزّن إضافةً إلى الترحيل. العقدة المخصصة للترحيل وحده لا تحتاجها — احذف عندها RELAYIUM_NODE_STORAGE_DIR.",
        ],
      },
      body: [
        "أربعة أمور بالترتيب: تولّد الأمر، ثم تشغّله، ثم تفتح المنافذ، ثم تتأكّد أن العقدة صارت متصلة. نحو خمس دقائق على جهاز جديد.",
      ],
      steps: [
        {
          text: "سجّل الدخول في relayium.com وافتح صفحة حسابك على ‎/me‎.",
        },
        {
          text: "انزل إلى «عقدي» واضغط «إضافة عقدة». انسخ أمر التثبيت فورًا — فالرمز الذي بداخله يُعرض مرة واحدة فقط ولا يمكن عرضه ثانيةً.",
        },
        {
          text: "الصقه على خادمك. سينزّل ثنائي relayium-node ويتحقّق من مجموع التحقّق الخاص به، ويثبّته في ‎/usr/local/bin‎، ويكتب خدمة systemd ويشغّلها.",
          code: [INSTALL_CMD],
        },
        {
          text: "تأكّد أن الخدمة تعمل وأنها ستعود بعد إعادة التشغيل. الإجابتان كلتاهما مهمّة: active تعني أنها تعمل الآن، وenabled هي ما يصمد أمام إعادة التشغيل.",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "افتح المنافذ الواردة في جدار حماية المضيف. حالة «متصل» لا تحتاج إلا وصولًا صادرًا، لكن الأقران يرحّلون ويخزّنون عبر هذه المنافذ تحديدًا.",
          code: PORTS_CODE,
        },
        {
          text: "على VPS سحابي، اسمح بالمنافذ نفسها في مجموعة الأمان لدى المزوّد كذلك. الاكتفاء بـ ufw يتركها مغلقة في الأعلى، والعقدة تبدو سليمة طوال ذلك الوقت.",
        },
        {
          text: "عد إلى ‎/me‎ وراقب تحوّل العقدة إلى «متصلة» — عادةً خلال ثلاثين ثانية تقريبًا. ومن حينها تفضّلها عمليات النقل في حسابك تلقائيًا.",
        },
        {
          text: "اختياري: فعّل «استخدام عقدي وحدها للترحيل والتخزين» ليفشل النقل بدل أن يعود بصمت إلى بنيتنا المشتركة.",
        },
      ],
      success: {
        label: "كيف تبدو عقدة تعمل بشكل صحيح",
        body: [
          "يُبلِّغ systemd أن الخدمة active وenabled معًا، وتظهر العقدة «متصلة» تحت «عقدي». وactive وحدها لا تكفي — فالعقدة غير المفعَّلة بـ enabled تختفي عند إعادة التشغيل التالية.",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "الجزء ‎<your-token>‎ يُملأ لك في صفحة الحساب — لا تلصق العنصر النائب أعلاه حرفيًا.",
        "RELAYIUM_NODE_STORAGE_DIR يفعّل تخزين الكتل إضافةً إلى الترحيل. اتركه معطّلًا (احذف المتغير) إن أردت أن تقوم العقدة بالترحيل فقط دون التخزين.",
        "تأكّد من أنه بدأ: `systemctl status relayium-node` (يجب أن يظهر active/running).",
        "تأكّد من الاستمرارية عبر الإقلاع: `systemctl is-enabled relayium-node` (يجب أن يظهر enabled).",
        "راقب السجلات مباشرة: `journalctl -u relayium-node -f`.",
        "المنفذ 3478/udp هو منفذ TURN الذي يستخدمه الأقران للترحيل؛ 8081/tcp هو منفذ HTTP لتخزين الكتل؛ 49152–65535/udp هو نطاق وسائط الترحيل.",
        "على VPS سحابي، اسمح بهذه أيضًا في مجموعة الأمان / جدار حماية الشبكة لدى المزوّد، لا في ufw فقط.",
      ],
    },
    {
      heading: "هل تشغيل هذا المثبّت بصلاحية root آمن؟",
      body: [
        "قبل كل شيء: العقد التي تشغّلها بنفسك تعمل بالشيفرة ذاتها والتحصين ذاته الذي تعمل به عقد أسطولنا نحن — الثنائي نفسه من الإصدار المُوقَّع نفسه، يثبّته السكربت نفسه، تحت وحدة systemd نفسها. الفارق الوحيد هو لمن يعود الجهاز. وكل ما يلي ينطبق على الاثنين معًا.",
        "سؤال في محله عن أمرٍ يمرّر سكربتًا من الإنترنت إلى صدفة root، وهو يستحق جوابًا محددًا لا مجرد طمأنة. صلاحية root تُستخدم للتثبيت فقط، ولا تُستخدم في أي شيء تفعله العقدة بعد ذلك. يُنشئ المثبّت حسابًا نظاميًا اسمه relayium-node بلا صدفة دخول وبلا مجلد منزل، ويكتب وحدات systemd، ويشغّل الخدمة، ثم ينتهي. أما العقدة نفسها فلا تعمل بصلاحية root أبدًا: وحدتها تضبط User=relayium-node، فمنذ اللحظة التي تتصل فيها هي حساب غير مُمتاز لا يملك شيئًا آخر على جهازك. (التحديث التلقائي، وهو مفعّل افتراضيًا، يضيف بالفعل وحدة ثانية تعمل بصلاحية root — والقسم التالي مخصص بالكامل لما تستطيع تلك الوحدة فعله وما لا تستطيعه.)",
        "وحول هذا الحساب تضع الوحدة صندوق عزل من systemd. كل سطر فيه موجَّه إلى شيء قد يمدّ إليه مهاجمٌ يده لو استولى يومًا على عملية العقدة. ولا شيء هنا مخفيّ عنك: بعد التثبيت اقرأ الوحدة كاملة بـ `cat /etc/systemd/system/relayium-node.service`.",
      ],
      table: {
        head: ["في الوحدة", "ما الذي يمنعه إن اختُرقت العقدة يومًا"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "المهاجم مجرد مستخدم لا يملك شيئًا، وليس root."],
          ["ProtectHome=yes", "‏/home و /root غير مرئيين — لا مفاتيح SSH خاصة ولا بيانات مشاريع أخرى."],
          ["ProtectSystem=strict", "نظام الملفات كله للقراءة فقط؛ لا يمكن تعديل أي ملف نظام."],
          ["ReadWritePaths=", "المواضع الوحيدة القابلة للكتابة هي مجلد حالة العقدة نفسها، ومجلد التخزين إن أعددت واحدًا. وأي كتابة في مكان آخر تفشل."],
          ["NoExecPaths=", "لا شيء في مجلد التخزين قابل للتنفيذ — الملف المرفوع لا يمكن تشغيله."],
          ["NoNewPrivileges=yes", "لا طريق للعودة إلى root؛ حيل تصعيد الصلاحيات المعتادة مغلقة."],
          ["CapabilityBoundingSet=", "فارغة — لا قدرات Linux على الإطلاق."],
          ["ProtectKernelTunables=yes، ProtectKernelModules=yes", "النواة بعيدة المنال: لا تغيير لـ sysctl، ولا تحميل وحدات، ولا زرع rootkit."],
        ],
      },
      bullets: [
        "لا يشير ReadWritePaths وNoExecPaths إلى مجلد التخزين إلا على عقدة تخزّن فعلًا. أما العقدة المخصصة للترحيل فقط فلا يظهر لديها أيٌّ من السطرين، ولا تستطيع الكتابة في أي مكان سوى مجلد حالتها.",
        "مجموعة القدرات فارغة في الحالة المعتادة. والاستثناء الوحيد هو مستمع التنزيل المباشر على منفذ أقل من 1024، إذ يحتاج CAP_NET_BIND_SERVICE للارتباط به؛ ومنفذ التنزيل الافتراضي هو 2053، أي فوق 1024، فلا يُمنح شيء.",
        "العقدة لا تحمل أي مفاتيح. تُشفَّر الملفات لدى المرسِل قبل رفعها، فما يصل إلى عقدة التخزين نصٌّ مُشفَّر لا تستطيع قراءته — بما في ذلك عقدتك أنت، وبما في ذلك أنت شخصيًا.",
      ],
    },
    {
      heading: "ما الذي يستطيع المحدِّث التلقائي فعله وما لا يستطيعه",
      body: [
        "يُعِدّ المثبّت أيضًا مؤقّت تحديث ذاتي، مفعّلًا افتراضيًا: يسأل relayium-node-update.timer موقع relayium.com كل عشر دقائق تقريبًا عن الإصدار الذي ينبغي أن تشغّله هذه العقدة. هذه وحدة ثانية، وهي تعمل بصلاحية root، لذا فهي مدينة لك بشرحٍ خاص بها.",
        "المركز لا يرسل ثنائيًا أبدًا. جوابه كله رقم إصدار، وعلَمان (هل يجوز لهذه العقدة أن تنتقل الآن، وهل هذا تخفيضٌ متعمَّد للإصدار) وسطر قصير يوضّح السبب — لا بايتات ولا رابط ولا أمر. بعدها تجلب العقدة ذلك الإصدار بنفسها، وتقارن SHA-256 للأرشيف بملف checksums.txt الخاص بالإصدار، ثم تتحقق من توقيع ECDSA P-256 على ذلك الملف باستخدام مفتاح عام مُضمَّن داخل الثنائي نفسه الذي يجري التحقق. والنصف الخاص من هذا المفتاح ليس على الخادم الذي يجيب عن هذه الاستعلامات. فحتى لو اختُرق المركز، فأقصى ما يستطيعه هو تسمية إصدار؛ ولا يستطيع صناعة ثنائي يجتاز التحقق.",
        "المحدِّث والعقدة عمليتان منفصلتان بصلاحيتين متعاكستين. فـ relayium-node.service هو صندوق العزل الموصوف أعلاه — وتحت ProtectSystem=strict لا يستطيع الكتابة في /usr/local/bin إطلاقًا، أي أن العقدة لا تستطيع أبدًا تعديل أي ثنائي، بما فيه ثنائيها هي. أما relayium-node-update.service فهو وحدة oneshot صغيرة تعمل بصلاحية root ولا تحمل صندوق عزل عن قصد، لأن استبدال ملف في /usr/local/bin يتطلب بالضبط تلك الصلاحية التي وُجد صندوق عزل العقدة كي يمنعها عنها. وحصر هذه القدرة في وحدة واحدة أحادية الغرض، بدل إرخاء تحصين العقدة نفسها، هو مغزى هذا الفصل كله: العملية التي تملك root لا تفعل شيئًا سوى تبديل الثنائيات، والعملية الحبيسة لا تستطيع أن تمسّ ثنائيًا أبدًا.",
        "والتحديث الذي يسوء يتراجع عن نفسه. يبقي المحدِّث الثنائي القديم بجوار الجديد، ويعيد تشغيل الخدمة، ثم يترقّب نبضة لعشر دقائق كحد أقصى؛ فإن لم يبلّغ الإصدار الجديد عن سلامته خلال هذه المهلة أعاد الثنائي القديم إلى مكانه، وأعاد التشغيل من جديد، وسجّل الإصدار المعطوب حتى لا تُعاد المحاولة به. ولا يُقرأ أي ملف مخزَّن ولا يُنقل ولا يُحذف في أيٍّ من هذا.",
      ],
      bullets: [
        "إن لم ترده: أعد تشغيل المثبّت مع RELAYIUM_NODE_AUTO_UPDATE=off. عندها يُعطَّل المؤقّت وخدمته ويُحذفان؛ وتستمر العقدة في العمل، وتحدّثها أنت متى شئت.",
        "إن انتهيت من العقدة تمامًا: انظر «إزالة عقدتك» أدناه.",
      ],
    },
    {
      heading: "إزالة عقدتك",
      body: [
        "الإلغاء سكربت واحد، وهو نفسه سواء كانت عقدتك تخزّن الملفات أو تُرحّل فقط. يزيل الوحدات والثنائي والإعدادات وحساب الخدمة، ويحاول قدر استطاعته إبلاغ relayium.com بأن العقدة لم تعد موجودة. وإن فشل ذلك الاتصال فهو سطر واحد على طرفيتك لا إلغاء معطوب — ويطبع معرّف العقدة كي تُعلَّم كمُزالة يدويًا.",
        "نزّله وتحقّق منه ثم شغّله. تمريره مباشرة إلى sh يعني أن خطأ 404 أو انقطاعًا عابرًا في الشبكة سيجعل الأمر كله لا يطبع شيئًا وينتهي برمز 0، وهو ما يبدو كإلغاء ناجح.",
        "لا يزيل إلا ما يعرفه: أي شيء غير متوقع في دليل الحالة أو دليل التخزين يُحتفظ به ويُبلَّغ عنه بدل حذفه.",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "يرفض ما دام دليل التخزين يحوي أي ملف لا يعرفه — بما في ذلك كائن منتهي الصلاحية لم يصله التنظيف بعد — لأن كل ملف مخزَّن يوجد على عقدة واحدة فقط ولا توجد نسخ. انتظر حتى يصل العدد إلى صفر، أو مرّر RELAYIUM_NODE_FORCE=1 قابلًا بأن تصبح تلك الملفات غير قابلة للوصول.",
        "إن تعذّر عليه تحديد مكان الكائنات، يتوقف بدل أن يخمّن. المتغير RELAYIUM_NODE_ASSUME_NO_STORAGE=1 هو السبيل الوحيد لتجاوز ذلك، ومع هذا لا يحذف شيئًا لا يعرفه.",
        "يبقى دليل التخزين نفسه ما لم تمرّر أيضًا RELAYIUM_NODE_PURGE_STORAGE=1. متغيرات البيئة لا تعبر `| sudo sh` — مرّرها هكذا: `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh`.",
        "بعد ذلك يجب أن يقول `systemctl status relayium-node` أنه not-found وألا يظهر أي مؤقّت relayium-node. وإذا أعدت التثبيت لاحقًا فستحصل في حسابك على عقدة جديدة تمامًا: فالإلغاء يحذف ملف هوية العقدة، لذا يسجّل التثبيت الجديد عقدة جديدة بدل إحياء القديمة.",
      ],
    },
    {
      heading: "حين لا ينجح الأمر",
      body: [
        "خمسة إخفاقات تغطي تقريبًا كل عقدة لا تقلع، وثلاثة منها تبدو سليمة من جهة الخادم: الخدمة تعمل، ولا يخبرك بغير ذلك إلا صفحة الحساب أو مقبس مُنصِت.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "تردّ الصدفة بـ «relayium-node: command not found».",
            code: [
              `command -v relayium-node
# لا شيء يُطبع`,
            ],
            fix: "الثنائي غير مثبَّت. ولا يُثبَّت relayium-node منفصلًا أبدًا — فأمر السطر الواحد في صفحة الحساب هو ما ينزّله ويضعه في مسار PATH ويشغّله كخدمة. شغّل ذلك الأمر بدلًا من هذا.",
          },
          {
            symptom: "الخدمة active لكن العقدة لا تصير «متصلة» في صفحة الحساب أبدًا.",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "حالة «متصل» يقرّرها نبض صادر، لذا نادرًا ما يكون جدار الحماية هو السبب هنا — بل التسجيل. الرمز صالح لمرة واحدة، فيفشل أمر سبق تشغيله أو أمر قديم بقي من محاولة سابقة. اضغط «إضافة عقدة» مجددًا للحصول على أمر جديد وأعد تشغيله.",
          },
          {
            symptom: "العقدة تظهر «متصلة» ومع ذلك تمر عمليات النقل عبر بنيتنا المشتركة.",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "«متصل» لا تثبت إلا النبض الصادر. ما يحتاجه الأقران هو المنافذ الواردة: تأكّد أن العقدة تُنصِت، ثم افتح 3478/udp و8081/tcp و49152-65535/udp في جدار حماية المضيف وفي مجموعة الأمان السحابية معًا. ولاستبعاد أي عودة صامتة تمامًا، فعّل إعداد الاقتصار على عقدك.",
          },
          {
            symptom: "أمر الإزالة لم يطبع شيئًا وانتهى بالرمز 0، والخدمة ما تزال موجودة.",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "هذا بالضبط شكل تمرير تنزيل فاشل إلى sh: خطأ 404 أو انقطاع عابر في الشبكة لا يطبع شيئًا وينتهي بالرمز 0، فيُقرأ كنجاح. نزّل السكربت، وتحقّق أنه ليس فارغًا، ثم شغّله — ولهذا كُتب الأمر في هذا الدليل على ثلاثة أجزاء لا كأنبوب واحد.",
          },
          {
            symptom: "الإزالة ترفض ما دام دليل التخزين يحوي ملفات.",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "هذا مقصود. فكل ملف مخزَّن يوجد على عقدة واحدة بالضبط ولا نسخ احتياطية له، وإزالة العقدة تجعل تلك الملفات غير قابلة للوصول. انتظر حتى يبلغ العدد صفرًا مع انتهاء صلاحية الكتل، أو اقبل الخسارة بـ RELAYIUM_NODE_FORCE=1. ومتغيرات البيئة لا تعبر أنبوبًا إلى sudo sh، فمرّرها بصيغة sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "ظهر لي «‎relayium-node: command not found‎» — ما الخطأ؟",
        a: "لقد شغّلت ثنائي relayium-node قبل تثبيته. استخدم أمر التثبيت ذا السطر الواحد من صفحة الحساب (بصيغة curl … | sudo … sh): إنه ينزّل الثنائي، ويضعه في مسار PATH، ويشغّله كخدمة. أنت لا تثبّت relayium-node بشكل منفصل أبدًا.",
      },
      {
        q: "هل تبقى العقدة متصلة بعد إعادة التشغيل؟",
        a: "نعم. يسجّل المثبّت خدمة systemd مُفعَّلة عند الإقلاع ومضبوطة على Restart=always، فتعود بعد إعادة التشغيل وتعيد تشغيل نفسها إذا تعطّلت. لا شيء إضافي لتشغيله.",
      },
      {
        q: "كيف يختلف هذا عن الاستضافة الذاتية لـ Relayium؟",
        a: "تشغيل عقدتك الخاصة يبقي حساب relayium.com المعتاد وتطبيقاتك ويضيف فقط عقدة تملكها لتحمل حركتك. أما الاستضافة الذاتية فتشغّل حزمة الخادم بالكامل (الحسابات، تطبيق الويب، الإشارة) على نطاقك الخاص — راجع دليل «الاستضافة الذاتية لـ Relayium» لذلك.",
      },
      {
        q: "هل يمكن لأي شخص آخر استخدام عقدتي أو رؤية بياناتي؟",
        a: "لا. ترتبط العقدة بحسابك عبر رمزها ولا تحمل سوى حركة حسابك. النقل الفوري مشفَّر من الطرف إلى الطرف والكتل المُخزَّنة نص مُشفَّر لا تستطيع عقدتك قراءته. بياناتك وإعدادات عقدتك قابلة للاستخدام من قِبلك أنت وحدك.",
      },
    ],
  },
  cta: {
    text: "سجّل الدخول، افتح صفحة حسابك، وأضف عقدتك الأولى في أقل من دقيقة.",
    button: "افتح صفحة الحساب",
    href: "/me",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Usa tu propio nodo: aprovecha el retransmisor y el almacenamiento de Relayium gratis",
  description:
    "Vincula tu propio nodo de retransmisión/almacenamiento a tu cuenta de Relayium con un solo comando. Tus transferencias pasan entonces por tu nodo — no por nuestros servidores medidos —, así que son gratis, y los datos permanecen en hardware que tú controlas.",
  updatedLabel: "Última actualización",
  lead: [
    "Las transferencias entre redes y los enlaces almacenados usan ancho de banda de retransmisión y disco que nos cuestan dinero, así que funcionan con una franquicia gratuita y se pagan a partir de ahí. Hay una forma de evitarlo: ejecuta tu propio nodo de retransmisión/almacenamiento, vincúlalo a tu cuenta, y tus transferencias fluyen por tu nodo en lugar del nuestro — nada medido, nada facturado.",
    "Esto es distinto de autoalojar todo el servidor de Relayium. Sigues usando tu cuenta habitual de relayium.com y las mismas aplicaciones; solo estás añadiendo un nodo que es tuyo para que lleve tu tráfico. Esta guía te lleva de una máquina Linux recién instalada a un nodo en línea en unos cinco minutos.",
  ],
  sections: [
    {
      heading: "Por qué ejecutar tu propio nodo",
      body: [
        "Dos razones. Primero, el coste: un nodo que es tuyo lleva tu tráfico de retransmisión y almacenamiento directamente, así que nunca toca nuestra infraestructura medida y no hay nada que facturar — tu uso es gratis por grande que sea.",
        "Segundo, el control: los bytes retransmitidos y los blobs almacenados residen en hardware que tú operas, bajo tu propio control operativo. Las transferencias en tiempo real siguen cifradas de extremo a extremo durante todo el trayecto, así que incluso tu propio nodo solo ve texto cifrado.",
      ],
    },
    {
      heading: "Instala el nodo y ponlo en línea",
      prereqs: {
        label: "Lo que necesitas antes del paso 1",
        items: [
          "Un servidor Linux accesible desde internet: sirve tanto un VPS barato como una máquina siempre encendida en casa. Se admiten amd64 y arm64.",
          "root en ese servidor, o sudo. La instalación lo necesita una vez; el nodo en sí nunca se ejecuta como root.",
          "Poder abrir puertos entrantes: en el cortafuegos del host y, en un VPS en la nube, también en el grupo de seguridad del proveedor.",
          "Una cuenta de relayium.com con la sesión iniciada. El comando de instalación se genera en la página de cuenta y lleva un token de un solo uso.",
          "Espacio en disco, solo si quieres que el nodo también almacene además de retransmitir. Un nodo de solo retransmisión no necesita ninguno: omite RELAYIUM_NODE_STORAGE_DIR.",
        ],
      },
      body: [
        "Cuatro cosas en orden: generas el comando, lo ejecutas, abres los puertos y confirmas que el nodo se puso en línea. Unos cinco minutos en una máquina recién creada.",
      ],
      steps: [
        {
          text: "Inicia sesión en relayium.com y abre tu página de cuenta en /me.",
        },
        {
          text: "Baja hasta Mis nodos y pulsa Añadir nodo. Copia el comando de instalación de inmediato: el token que lleva se muestra una sola vez y no puede volver a mostrarse.",
        },
        {
          text: "Pégalo en tu servidor. Descarga el binario relayium-node, verifica su suma de comprobación, lo instala en /usr/local/bin, escribe un servicio de systemd y lo arranca.",
          code: [INSTALL_CMD],
        },
        {
          text: "Confirma que el servicio está en marcha y que volverá tras un reinicio. Ambas respuestas importan: active dice que está corriendo ahora, y enabled es lo que sobrevive a un reinicio.",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "Abre los puertos entrantes en el cortafuegos del host. El estado En línea solo requiere acceso saliente, pero es por estos puertos por donde los pares retransmiten y almacenan.",
          code: PORTS_CODE,
        },
        {
          text: "En un VPS en la nube, permite además los mismos puertos en el grupo de seguridad del proveedor. Con ufw a secas siguen bloqueados aguas arriba, y el nodo parece sano todo ese tiempo.",
        },
        {
          text: "De vuelta en /me, observa cómo el nodo pasa a En línea, normalmente en unos 30 segundos. A partir de ahí las transferencias de tu cuenta lo prefieren automáticamente.",
        },
        {
          text: "Opcional: activa \"Usar solo mis propios nodos para retransmisión/almacenamiento\" para que una transferencia falle en vez de volver en silencio a nuestra infraestructura compartida.",
        },
      ],
      success: {
        label: "Qué aspecto tiene un nodo que funciona",
        body: [
          "systemd informa del servicio como active y enabled a la vez, y el nodo aparece En línea bajo Mis nodos. active por sí solo no basta: un nodo que no está enabled desaparece en el siguiente reinicio.",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "La parte <your-token> se rellena por ti en la página de cuenta — no pegues literalmente el marcador de posición de arriba.",
        "RELAYIUM_NODE_STORAGE_DIR activa el almacenamiento de blobs además de la retransmisión. Déjalo desactivado (omite la variable) si solo quieres que el nodo retransmita y no almacene.",
        "Comprueba que arrancó: `systemctl status relayium-node` (debería indicar active/running).",
        "Confirma la persistencia al arranque: `systemctl is-enabled relayium-node` (debería indicar enabled).",
        "Observa los registros en vivo: `journalctl -u relayium-node -f`.",
        "3478/udp es el puerto TURN que los pares usan para retransmitir; 8081/tcp es el puerto HTTP del almacenamiento de blobs; 49152–65535/udp es el rango de medios de la retransmisión.",
        "En un VPS en la nube, permítelos también en el grupo de seguridad / cortafuegos de red del proveedor, no solo en ufw.",
      ],
    },
    {
      heading: "¿Es seguro ejecutar este instalador como root?",
      body: [
        "Antes que nada: los nodos que aportas tú ejecutan el mismo código y el mismo endurecimiento que los nodos de nuestra propia flota — el mismo binario de la misma versión firmada, instalado por el mismo script, bajo la misma unidad de systemd. La única diferencia es de quién es la máquina. Todo lo que sigue describe a ambos.",
        "Es una pregunta justa ante un comando que canaliza un script de internet hacia una shell de root, y merece una respuesta concreta en lugar de una frase tranquilizadora. root se usa para la instalación y para nada de lo que el nodo hace después. El instalador crea una cuenta de sistema llamada relayium-node, sin shell de acceso y sin directorio personal, escribe las unidades de systemd, arranca el servicio y termina. El nodo en sí nunca se ejecuta como root: su unidad fija User=relayium-node, así que desde el segundo en que se pone en línea es una cuenta sin privilegios que no posee nada más en tu máquina. (La actualización automática, activada por omisión, sí añade una segunda unidad que se ejecuta como root — la sección siguiente trata por entero de lo que esa unidad puede y no puede hacer.)",
        "Alrededor de esa cuenta, la unidad levanta un espacio aislado de systemd. Cada línea apunta a algo que un atacante intentaría alcanzar si alguna vez se hiciera con el proceso del nodo. Nada de esto se te oculta: tras instalar, lee la unidad completa con `cat /etc/systemd/system/relayium-node.service`.",
      ],
      table: {
        head: ["En la unidad", "Qué bloquea si el nodo llega a verse comprometido"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "El atacante es un usuario que no posee nada, no root."],
          ["ProtectHome=yes", "/home y /root son invisibles — ni claves SSH privadas, ni datos de otros proyectos."],
          ["ProtectSystem=strict", "Todo el sistema de archivos es de solo lectura; no se puede modificar ningún archivo del sistema."],
          ["ReadWritePaths=", "Los únicos lugares escribibles son el directorio de estado del propio nodo y, si configuraste uno, el directorio de almacenamiento. Escribir en cualquier otro sitio falla."],
          ["NoExecPaths=", "Nada del directorio de almacenamiento se puede ejecutar — un archivo subido no puede echarse a andar."],
          ["NoNewPrivileges=yes", "No hay camino de vuelta a root; los trucos habituales de escalada quedan cerrados."],
          ["CapabilityBoundingSet=", "Vacío — ninguna capability de Linux, ni una."],
          ["ProtectKernelTunables=yes, ProtectKernelModules=yes", "El núcleo queda fuera de alcance: ni cambios de sysctl, ni carga de módulos, ni rootkits."],
        ],
      },
      bullets: [
        "ReadWritePaths y NoExecPaths solo nombran el directorio de almacenamiento en un nodo que realmente almacena. Un nodo de solo retransmisión no lleva ninguna de las dos líneas y no puede escribir en ningún sitio salvo en su propio directorio de estado.",
        "En el caso normal el conjunto de capabilities está vacío. La única excepción es un proceso a la escucha de descarga directa en un puerto por debajo de 1024, que necesita CAP_NET_BIND_SERVICE para poder asociarse; el puerto de descarga por omisión es 2053, por encima de 1024, así que no se concede nada.",
        "El nodo no guarda ninguna clave. Los archivos los cifra el remitente antes de subirlos, así que lo que llega a un nodo de almacenamiento es texto cifrado que no puede leer — eso incluye tu propio nodo, y te incluye a ti.",
      ],
    },
    {
      heading: "Qué puede y qué no puede hacer la actualización automática",
      body: [
        "El instalador también configura un temporizador de actualización automática, activado por omisión: relayium-node-update.timer pregunta a relayium.com, más o menos cada diez minutos, qué versión debería estar ejecutando este nodo. Es una segunda unidad, y se ejecuta como root, así que te debe su propia explicación.",
        "El servidor central nunca envía un binario. Toda su respuesta es un número de versión, dos indicadores (si a este nodo le toca moverse ahora y si se trata de una vuelta atrás deliberada) y un breve motivo — ni bytes, ni URL, ni comando. Después es el nodo quien descarga esa versión por su cuenta, coteja el SHA-256 del archivo con el checksums.txt de la versión y verifica una firma ECDSA P-256 sobre ese checksums.txt con una clave pública compilada dentro del mismísimo binario que hace la comprobación. La mitad privada de esa clave no está en el servidor que responde a esos sondeos. Un servidor central comprometido podría, pues, nombrar una versión; lo que no podría es fabricar un binario que pase la verificación.",
        "El actualizador y el nodo son dos procesos distintos con poderes opuestos. relayium-node.service es el espacio aislado de arriba — bajo ProtectSystem=strict no puede escribir en /usr/local/bin en absoluto, así que el nodo nunca puede modificar un binario, ni siquiera el suyo. relayium-node-update.service es una pequeña unidad oneshot que se ejecuta como root y que deliberadamente no lleva aislamiento, porque reemplazar un archivo en /usr/local/bin exige exactamente el privilegio que el aislamiento del nodo existe para negarle. Encerrar ese poder en una única unidad de un solo propósito, en vez de aflojar el endurecimiento del propio nodo, es todo el sentido de la separación: el proceso que tiene root solo intercambia binarios, y el proceso enjaulado nunca puede tocar uno.",
        "Una actualización que sale mal se deshace sola. El actualizador conserva el binario anterior junto al nuevo, reinicia el servicio y luego vigila el latido durante diez minutos como máximo; si la nueva versión no se declara sana en esa ventana, repone el binario anterior, reinicia de nuevo y anota la versión defectuosa para no reintentarla. Nada de esto lee, mueve ni borra jamás los archivos almacenados.",
      ],
      bullets: [
        "Si no la quieres: vuelve a ejecutar el instalador con RELAYIUM_NODE_AUTO_UPDATE=off. El temporizador y su servicio se desactivan y se eliminan; el nodo sigue funcionando y lo actualizas cuando tú decidas.",
        "¿Terminaste del todo con el nodo?: consulta «Eliminar tu nodo» más abajo.",
      ],
    },
    {
      heading: "Eliminar tu nodo",
      body: [
        "Desinstalar es un solo script, el mismo tanto si tu nodo almacena archivos como si solo retransmite. Elimina las unidades, el binario, la configuración y la cuenta de servicio, y hace un intento de mejor esfuerzo por avisar a relayium.com de que el nodo ya no está. Si esa llamada falla, es una línea en tu terminal y no una desinstalación rota: muestra el ID del nodo para poder marcarlo como eliminado a mano.",
        "Descárgalo, compruébalo y luego ejecútalo. Canalizarlo directamente a sh significa que un 404 o un corte de red pasajero hace que todo el comando no muestre nada y termine con código 0, lo que parece una desinstalación correcta.",
        "Solo elimina lo que reconoce: cualquier cosa inesperada en el directorio de estado o de almacenamiento se conserva y se informa en vez de barrerse.",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "Se niega mientras el directorio de almacenamiento contenga algún archivo que no reconozca — incluido un blob caducado que la limpieza aún no ha alcanzado — porque cada archivo almacenado vive en exactamente un nodo y no hay réplicas. Espera a que ese recuento llegue a cero, o pasa RELAYIUM_NODE_FORCE=1 aceptando que esos archivos queden inalcanzables.",
        "Si no logra determinar dónde viven tus blobs, se detiene en lugar de adivinar. RELAYIUM_NODE_ASSUME_NO_STORAGE=1 es la única forma de saltarse eso, y sigue sin borrar nada que no reconozca.",
        "El directorio de almacenamiento se conserva salvo que pases también RELAYIUM_NODE_PURGE_STORAGE=1. Las variables de entorno no sobreviven a `| sudo sh`: pásalas como `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh`.",
        "Después, `systemctl status relayium-node` debería decir not-found y no debería listarse ningún temporizador relayium-node. Si vuelves a instalarlo más adelante, tu cuenta obtiene un nodo completamente nuevo: la desinstalación borra el archivo de identidad del nodo, así que una instalación nueva registra un nodo nuevo en lugar de revivir el anterior.",
      ],
    },
    {
      heading: "Cuando no funciona",
      body: [
        "Cinco fallos cubren casi todos los nodos que no llegan a levantarse, y tres de ellos parecen sanos desde el servidor: el servicio está corriendo, y solo la página de cuenta o un socket a la escucha dicen lo contrario.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El shell responde \"relayium-node: command not found\".",
            code: [
              `command -v relayium-node
# no imprime nada`,
            ],
            fix: "El binario no está instalado. relayium-node nunca se instala por separado: el comando de una línea de la página de cuenta es justamente lo que lo descarga, lo pone en tu PATH y lo arranca como servicio. Ejecuta ese en su lugar.",
          },
          {
            symptom: "El servicio está active, pero el nodo nunca pasa a En línea en la página de cuenta.",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "El estado En línea lo decide un latido saliente, así que aquí rara vez la causa es el cortafuegos: es el registro. El token es de un solo uso, de modo que un comando ya ejecutado, o uno viejo de un intento anterior, falla. Pulsa Añadir nodo otra vez para obtener un comando nuevo y vuelve a ejecutarlo.",
          },
          {
            symptom: "El nodo aparece En línea, pero las transferencias siguen pasando por nuestra infraestructura compartida.",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "En línea solo demuestra el latido saliente. Lo que los pares necesitan son los puertos entrantes: comprueba que el nodo está escuchando y luego abre 3478/udp, 8081/tcp y 49152-65535/udp en el cortafuegos del host Y en el grupo de seguridad de la nube. Para descartar por completo un repliegue silencioso, activa el ajuste de usar solo tus propios nodos.",
          },
          {
            symptom: "La desinstalación no imprimió nada, terminó con 0 y el servicio sigue ahí.",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "Eso es exactamente el aspecto de canalizar una descarga fallida a sh: un 404 o un corte de red no imprime nada y termina con 0, lo que se lee como éxito. Descarga el script, comprueba que no está vacío y luego ejecútalo: por eso el comando de esta guía está escrito en tres partes y no como una sola tubería.",
          },
          {
            symptom: "La desinstalación se niega mientras el directorio de almacenamiento aún contiene archivos.",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "Es deliberado. Cada archivo almacenado vive en exactamente un nodo y no hay réplicas, así que retirar el nodo los deja inalcanzables. Espera a que la cuenta llegue a cero conforme caducan los blobs, o asume la pérdida con RELAYIUM_NODE_FORCE=1. Las variables de entorno no sobreviven a una tubería hacia sudo sh, así que pásalas como sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "Recibí «relayium-node: command not found» — ¿qué salió mal?",
        a: "Ejecutaste el binario relayium-node antes de instalarlo. Usa el comando de instalación de una línea de la página de cuenta (la forma curl … | sudo … sh): descarga el binario, lo coloca en tu PATH y lo arranca como servicio. Nunca instalas relayium-node por separado.",
      },
      {
        q: "¿El nodo sigue en línea tras un reinicio?",
        a: "Sí. El instalador registra un servicio systemd que se habilita al arrancar y está configurado con Restart=always, así que vuelve tras un reinicio y se reinicia por sí solo si se cae. Nada más que ejecutar.",
      },
      {
        q: "¿En qué se diferencia esto de autoalojar Relayium?",
        a: "Usar tu propio nodo conserva tu cuenta y aplicaciones habituales de relayium.com y solo añade un nodo que es tuyo para llevar tu tráfico. El autoalojamiento ejecuta toda la pila del servidor (cuentas, aplicación web, señalización) en tu propio dominio — consulta la guía «Aloja Relayium por tu cuenta» para eso.",
      },
      {
        q: "¿Puede alguien más usar mi nodo o ver mis datos?",
        a: "No. Un nodo está vinculado a tu cuenta por su token y solo lleva el tráfico de tu cuenta. Las transferencias en tiempo real están cifradas de extremo a extremo y los blobs almacenados son texto cifrado que tu nodo no puede leer. Tus datos y la configuración de tu nodo solo los puedes usar tú.",
      },
    ],
  },
  cta: {
    text: "Inicia sesión, abre tu página de cuenta y añade tu primer nodo en menos de un minuto.",
    button: "Abrir la página de cuenta",
    href: "/me",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Use seu próprio nó: aproveite o retransmissor e o armazenamento do Relayium de graça",
  description:
    "Vincule seu próprio nó de retransmissão/armazenamento à sua conta do Relayium com um único comando. Suas transferências passam então pelo seu nó — não pelos nossos servidores medidos —, então são gratuitas, e os dados ficam em hardware que você controla.",
  updatedLabel: "Última atualização",
  lead: [
    "Transferências entre redes e links armazenados usam largura de banda de retransmissão e disco que nos custam dinheiro, então funcionam dentro de uma cota gratuita e são pagas além dela. Há um jeito de contornar isso: rode seu próprio nó de retransmissão/armazenamento, vincule-o à sua conta, e suas transferências fluem pelo seu nó em vez do nosso — nada medido, nada faturado.",
    "Isso é diferente de auto-hospedar o servidor Relayium inteiro. Você continua usando sua conta habitual do relayium.com e os mesmos aplicativos; só está adicionando um nó que é seu para carregar seu tráfego. Este guia leva você de uma máquina Linux recém-instalada a um nó online em cerca de cinco minutos.",
  ],
  sections: [
    {
      heading: "Por que rodar seu próprio nó",
      body: [
        "Dois motivos. Primeiro, o custo: um nó que é seu carrega seu tráfego de retransmissão e armazenamento diretamente, então nunca toca nossa infraestrutura medida e não há nada a faturar — seu uso é gratuito por maior que seja.",
        "Segundo, o controle: os bytes retransmitidos e os blobs armazenados residem em hardware que você opera, sob seu próprio controle operacional. As transferências em tempo real permanecem com criptografia de ponta a ponta durante todo o trajeto, então até seu próprio nó só vê texto cifrado.",
      ],
    },
    {
      heading: "Instale o nó e coloque-o online",
      prereqs: {
        label: "O que você precisa antes do passo 1",
        items: [
          "Um servidor Linux acessível pela internet — tanto um VPS barato quanto uma máquina sempre ligada em casa servem. amd64 e arm64 são suportados.",
          "root nesse servidor, ou sudo. A instalação precisa disso uma vez; o nó em si nunca roda como root.",
          "Poder abrir portas de entrada — no firewall do host e, num VPS na nuvem, também no grupo de segurança do provedor.",
          "Uma conta relayium.com com sessão iniciada. O comando de instalação é gerado na página da conta e carrega um token de uso único.",
          "Espaço em disco, apenas se você quiser que o nó também armazene além de retransmitir. Um nó só de retransmissão não precisa — nesse caso omita RELAYIUM_NODE_STORAGE_DIR.",
        ],
      },
      body: [
        "Quatro coisas em ordem: gerar o comando, executá-lo, abrir as portas e confirmar que o nó ficou online. Cerca de cinco minutos numa máquina nova.",
      ],
      steps: [
        {
          text: "Entre no relayium.com e abra a página da sua conta em /me.",
        },
        {
          text: "Desça até Meus nós e clique em Adicionar nó. Copie o comando de instalação na hora — o token que ele contém aparece uma única vez e não pode ser exibido de novo.",
        },
        {
          text: "Cole no seu servidor. Ele baixa o binário relayium-node, verifica a soma de verificação, instala em /usr/local/bin, escreve um serviço systemd e o inicia.",
          code: [INSTALL_CMD],
        },
        {
          text: "Confirme que o serviço subiu e que voltará depois de um reboot. As duas respostas importam: active diz que está rodando agora, e enabled é o que sobrevive a um reinício.",
          code: ["systemctl is-active relayium-node", "systemctl is-enabled relayium-node"],
        },
        {
          text: "Abra as portas de entrada no firewall do host. O estado Online só precisa de acesso de saída, mas é por essas portas que os pares retransmitem e armazenam.",
          code: PORTS_CODE,
        },
        {
          text: "Num VPS na nuvem, libere as mesmas portas também no grupo de segurança do provedor. Só com o ufw elas continuam bloqueadas mais acima, e o nó parece saudável esse tempo todo.",
        },
        {
          text: "De volta ao /me, veja o nó virar Online — normalmente em uns 30 segundos. Daí em diante as transferências da sua conta passam a preferi-lo automaticamente.",
        },
        {
          text: "Opcional: ligue \"Usar somente meus próprios nós para retransmissão/armazenamento\" para que uma transferência falhe em vez de voltar silenciosamente à nossa infraestrutura compartilhada.",
        },
      ],
      success: {
        label: "Como é um nó que funciona",
        body: [
          "O systemd informa o serviço como active e enabled ao mesmo tempo, e o nó aparece Online em Meus nós. Só active não basta — um nó que não está enabled some no próximo reboot.",
        ],
        code: [
          `$ systemctl is-active relayium-node
active
$ systemctl is-enabled relayium-node
enabled`,
        ],
      },
      bullets: [
        "A parte <your-token> é preenchida para você na página da conta — não cole literalmente o espaço reservado acima.",
        "RELAYIUM_NODE_STORAGE_DIR ativa o armazenamento de blobs além da retransmissão. Deixe-o desativado (omita a variável) se quiser que o nó apenas retransmita, sem armazenar.",
        "Verifique que iniciou: `systemctl status relayium-node` (deve indicar active/running).",
        "Confirme a persistência na inicialização: `systemctl is-enabled relayium-node` (deve indicar enabled).",
        "Acompanhe os logs ao vivo: `journalctl -u relayium-node -f`.",
        "3478/udp é a porta TURN que os pares usam para retransmitir; 8081/tcp é a porta HTTP do armazenamento de blobs; 49152–65535/udp é a faixa de mídia da retransmissão.",
        "Em um VPS na nuvem, permita-os também no grupo de segurança / firewall de rede do provedor, não só no ufw.",
      ],
    },
    {
      heading: "É seguro executar este instalador como root?",
      body: [
        "Antes de tudo: os nós que você traz rodam o mesmo código e o mesmo endurecimento dos nós da nossa própria frota — o mesmo binário da mesma versão assinada, instalado pelo mesmo script, sob a mesma unidade do systemd. A única diferença é de quem é a máquina. Tudo o que vem a seguir descreve os dois.",
        "É uma pergunta justa diante de um comando que canaliza um script da internet para um shell root, e ela merece uma resposta específica em vez de um “pode confiar”. O root é usado para a instalação e para nada do que o nó faz depois. O instalador cria uma conta de sistema chamada relayium-node, sem shell de login e sem diretório pessoal, escreve as unidades do systemd, inicia o serviço e termina. O nó em si nunca roda como root: sua unidade define User=relayium-node, então, desde o segundo em que fica online, ele é uma conta sem privilégios que não possui mais nada na sua máquina. (A atualização automática, ligada por padrão, de fato acrescenta uma segunda unidade que roda como root — a próxima seção trata inteiramente do que essa unidade pode e não pode fazer.)",
        "Em volta dessa conta, a unidade monta um sandbox do systemd. Cada linha mira algo que um atacante tentaria alcançar se um dia tomasse o processo do nó. Nada disso é escondido de você: depois de instalar, leia a unidade inteira com `cat /etc/systemd/system/relayium-node.service`.",
      ],
      table: {
        head: ["Na unidade", "O que isso bloqueia se o nó algum dia for comprometido"],
        firstColCode: true,
        rows: [
          ["User=relayium-node", "O atacante é um usuário que não possui nada, não o root."],
          ["ProtectHome=yes", "/home e /root ficam invisíveis — nada de chaves SSH privadas nem de dados de outros projetos."],
          ["ProtectSystem=strict", "Todo o sistema de arquivos fica somente leitura; nenhum arquivo de sistema pode ser alterado."],
          ["ReadWritePaths=", "Os únicos lugares graváveis são o diretório de estado do próprio nó e, se você configurou um, o diretório de armazenamento. Gravar em qualquer outro lugar falha."],
          ["NoExecPaths=", "Nada no diretório de armazenamento pode ser executado — um arquivo enviado não consegue rodar."],
          ["NoNewPrivileges=yes", "Não há caminho de volta ao root; os truques usuais de escalada ficam fechados."],
          ["CapabilityBoundingSet=", "Vazio — nenhuma capability do Linux, nenhuma mesmo."],
          ["ProtectKernelTunables=yes, ProtectKernelModules=yes", "O kernel fica fora de alcance: sem mudar sysctl, sem carregar módulos, sem rootkit."],
        ],
      },
      bullets: [
        "ReadWritePaths e NoExecPaths só apontam para o diretório de armazenamento em um nó que de fato armazena. Um nó só de retransmissão não recebe nenhuma das duas linhas e não consegue gravar em lugar algum além do seu próprio diretório de estado.",
        "No caso normal, o conjunto de capabilities é vazio. A única exceção é um processo à escuta de download direto em uma porta abaixo de 1024, que precisa de CAP_NET_BIND_SERVICE para se associar; a porta de download padrão é 2053, acima de 1024, então nada é concedido.",
        "O nó não guarda chave nenhuma. Os arquivos são cifrados pelo remetente antes do envio, então o que chega a um nó de armazenamento é texto cifrado que ele não consegue ler — isso inclui o seu próprio nó, e inclui você.",
      ],
    },
    {
      heading: "O que a atualização automática pode e não pode fazer",
      body: [
        "O instalador também configura um temporizador de autoatualização, ligado por padrão: o relayium-node-update.timer pergunta ao relayium.com, mais ou menos a cada dez minutos, qual versão este nó deveria estar executando. É uma segunda unidade, e ela roda como root, então deve a você uma explicação própria.",
        "O servidor central nunca envia um binário. Toda a resposta dele é um número de versão, dois sinalizadores (se é a vez deste nó de se mover agora e se isso é um retrocesso deliberado) e um breve motivo — sem bytes, sem URL, sem comando. Em seguida é o próprio nó que busca aquela versão, confere o SHA-256 do arquivo contra o checksums.txt da versão e verifica uma assinatura ECDSA P-256 sobre esse checksums.txt usando uma chave pública compilada dentro do próprio binário que está fazendo a verificação. A metade privada dessa chave não fica no servidor que responde a essas consultas. Um central comprometido poderia, portanto, apontar uma versão; o que ele não poderia é forjar um binário que passe na verificação.",
        "O atualizador e o nó são dois processos separados com poderes opostos. O relayium-node.service é o sandbox descrito acima — sob ProtectSystem=strict ele não consegue nem gravar em /usr/local/bin, ou seja, o nó jamais pode modificar um binário, inclusive o dele mesmo. O relayium-node-update.service é uma pequena unidade oneshot que roda como root e que deliberadamente não leva sandbox algum, porque substituir um arquivo em /usr/local/bin exige exatamente o privilégio que o sandbox do nó existe para lhe negar. Trancar esse poder em uma única unidade de propósito único, em vez de afrouxar o endurecimento do próprio nó, é todo o sentido dessa separação: o processo que tem root só troca binários, e o processo enjaulado nunca consegue tocar em um.",
        "Uma atualização que dá errado se desfaz sozinha. O atualizador mantém o binário antigo ao lado do novo, reinicia o serviço e então fica de olho no heartbeat por até dez minutos; se a nova versão não se declarar saudável nessa janela, ele repõe o binário antigo, reinicia de novo e registra a versão ruim para não tentá-la outra vez. Nada disso lê, move ou apaga os arquivos armazenados.",
      ],
      bullets: [
        "Se você não quiser: execute o instalador de novo com RELAYIUM_NODE_AUTO_UPDATE=off. O temporizador e o serviço dele são desativados e removidos; o nó continua rodando e você o atualiza quando decidir.",
        "Terminou de vez com o nó: veja “Remover o seu nó” mais abaixo.",
      ],
    },
    {
      heading: "Remover o seu nó",
      body: [
        "Desinstalar é um único script, o mesmo quer o seu nó armazene arquivos quer apenas retransmita. Ele remove as unidades, o binário, a configuração e a conta de serviço, e tenta, em regime de melhor esforço, avisar o relayium.com de que o nó se foi. Se essa chamada falhar, é uma linha no seu terminal e não uma desinstalação quebrada — ela imprime o ID do nó para que seja marcado como removido à mão.",
        "Baixe, verifique e só então execute. Canalizar direto para o sh significa que um 404 ou uma falha passageira de rede faz o comando inteiro não exibir nada e sair com código 0, o que parece uma desinstalação bem-sucedida.",
        "Só remove o que reconhece: qualquer coisa inesperada no diretório de estado ou de armazenamento é mantida e reportada em vez de ser varrida.",
      ],
      code: ["curl -fsSL https://relayium.com/uninstall-node.sh -o uninstall-node.sh && \\\n  [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh"],
      bullets: [
        "Ele recusa enquanto o diretório de armazenamento tiver algum arquivo que não reconheça — incluindo um blob expirado que a limpeza ainda não alcançou — porque cada arquivo armazenado vive em exatamente um nó e não há réplicas. Espere esse número chegar a zero, ou passe RELAYIUM_NODE_FORCE=1 aceitando que esses arquivos fiquem inacessíveis.",
        "Se não conseguir determinar onde vivem os seus blobs, ele para em vez de adivinhar. RELAYIUM_NODE_ASSUME_NO_STORAGE=1 é a única forma de passar disso, e mesmo assim não apaga nada que não reconheça.",
        "O diretório de armazenamento em si é mantido a menos que passe também RELAYIUM_NODE_PURGE_STORAGE=1. Variáveis de ambiente não sobrevivem ao `| sudo sh` — passe-as como `sudo env RELAYIUM_NODE_PURGE_STORAGE=1 sh uninstall-node.sh`.",
        "Depois, `systemctl status relayium-node` deve dizer not-found e nenhum temporizador relayium-node deve aparecer. Se instalar novamente mais tarde, a sua conta recebe um nó totalmente novo: a desinstalação apaga o arquivo de identidade do nó, por isso uma nova instalação registra um nó novo em vez de ressuscitar o antigo.",
      ],
    },
    {
      heading: "Quando não funciona",
      body: [
        "Cinco falhas cobrem quase todo nó que não sobe, e três delas parecem saudáveis do lado do servidor: o serviço está rodando, e só a página da conta ou um socket em escuta dizem o contrário.",
      ],
      troubleshooting: {
        label: "Sintoma, checagem, correção",
        items: [
          {
            symptom: "O shell responde \"relayium-node: command not found\".",
            code: [
              `command -v relayium-node
# nada é impresso`,
            ],
            fix: "O binário não está instalado. Você nunca instala o relayium-node separadamente — o comando de uma linha da página da conta é justamente o que o baixa, coloca no seu PATH e o inicia como serviço. Rode aquele comando.",
          },
          {
            symptom: "O serviço está active, mas o nó nunca fica Online na página da conta.",
            code: [
              `journalctl -u relayium-node -n 50 --no-pager`,
            ],
            fix: "O estado Online é decidido por um heartbeat de saída, então firewall raramente é a causa aqui — o problema é o registro. O token é de uso único, então um comando já executado, ou um antigo de uma tentativa anterior, falha. Clique em Adicionar nó de novo para obter um comando novo e execute-o.",
          },
          {
            symptom: "O nó aparece Online, mas as transferências continuam passando pela nossa infraestrutura compartilhada.",
            code: [
              `sudo ss -lunp | grep 3478`,
            ],
            fix: "Online só prova o heartbeat de saída. O que os pares precisam são as portas de entrada: confirme que o nó está escutando e então abra 3478/udp, 8081/tcp e 49152-65535/udp no firewall do host E no grupo de segurança da nuvem. Para descartar de vez um retorno silencioso, ligue a opção de usar somente os seus próprios nós.",
          },
          {
            symptom: "A desinstalação não imprimiu nada, saiu com 0, e o serviço continua lá.",
            code: [
              `systemctl status relayium-node
# active (running)`,
            ],
            fix: "É exatamente a cara de canalizar um download que falhou para o sh: um 404 ou uma falha passageira de rede não imprime nada e sai com 0, o que se lê como sucesso. Baixe o script, verifique que ele não está vazio e só então execute — é por isso que o comando neste guia está escrito em três partes e não como um único pipe.",
          },
          {
            symptom: "A desinstalação se recusa enquanto o diretório de armazenamento ainda tem arquivos.",
            code: [
              `sudo ls /var/lib/relayium-node/blobs | wc -l`,
            ],
            fix: "É proposital. Cada arquivo armazenado vive em exatamente um nó e não há réplicas, então remover o nó deixa esses arquivos inalcançáveis. Espere a contagem chegar a zero conforme os blobs expiram, ou aceite a perda com RELAYIUM_NODE_FORCE=1. Variáveis de ambiente não sobrevivem a um pipe para sudo sh, então passe-as como sudo env RELAYIUM_NODE_FORCE=1 sh uninstall-node.sh.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Recebi “relayium-node: command not found” — o que deu errado?",
        a: "Você executou o binário relayium-node antes de instalá-lo. Use o comando de instalação de uma linha da página da conta (a forma curl … | sudo … sh): ele baixa o binário, coloca-o no seu PATH e o inicia como serviço. Você nunca instala relayium-node separadamente.",
      },
      {
        q: "O nó continua online depois de um reinício?",
        a: "Sim. O instalador registra um serviço systemd que é habilitado na inicialização e configurado com Restart=always, então ele volta após um reinício e reinicia-se sozinho se travar. Nada mais a executar.",
      },
      {
        q: "Em que isso difere de auto-hospedar o Relayium?",
        a: "Usar seu próprio nó mantém sua conta e aplicativos habituais do relayium.com e apenas adiciona um nó que é seu para carregar seu tráfego. A auto-hospedagem executa toda a pilha do servidor (contas, aplicativo web, sinalização) no seu próprio domínio — veja o guia “Hospede o Relayium por conta própria” para isso.",
      },
      {
        q: "Alguém mais pode usar meu nó ou ver meus dados?",
        a: "Não. Um nó é vinculado à sua conta pelo seu token e só carrega o tráfego da sua conta. As transferências em tempo real têm criptografia de ponta a ponta e os blobs armazenados são texto cifrado que seu nó não consegue ler. Seus dados e a configuração do seu nó só podem ser usados por você.",
      },
    ],
  },
  cta: {
    text: "Faça login, abra sua página da conta e adicione seu primeiro nó em menos de um minuto.",
    button: "Abrir a página da conta",
    href: "/me",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/bring-your-own-node",
  published: "2026-07-10",
  updated: "2026-08-06",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
