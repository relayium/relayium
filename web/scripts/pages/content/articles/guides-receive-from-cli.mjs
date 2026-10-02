// web/scripts/pages/content/articles/guides-receive-from-cli.mjs
// Guide: the receiving side of the Relayium CLI — receive, serve, and down.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { sshRetiredNotice } from "../archived-errata.mjs";

const en = {
  title: "Receive files from the command line",
  description:
    "Three ways to receive a file with the Relayium CLI: receive a pairing-code send, serve as a daemon-direct listener, or download a stored encrypted link with down.",
  updatedLabel: "Last updated",
  lead: [
    "Sending is only half the story — sooner or later you're on the receiving end: a colleague wants to hand you a file across the internet, one of your own machines wants to hand off to another, or someone left you a stored link to fetch whenever you get to it. The Relayium CLI covers all three with a different command for each, and none of them need an account on the receiving side.",
    "Pick receive when someone else sends by pairing code, serve when trusted machines push directly to a listener you manage, and down when the sender gave you a stored encrypted link and may already be offline.",
  ],
  sections: [
    {
      heading: "Three ways to receive, and when each applies",
      body: [
        "Which command you run depends on who's starting the transfer and how the two machines know each other:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — someone sends to you across networks using a pairing code they minted (with the CLI, a Relayium app or the web page) and passed to you out of band. End-to-end encrypted, relayed whenever the server issues a relay for the code, with a SAS code you can compare.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — this machine listens for daemon-direct relayium:// pushes, on port 9031 by default.",
        "relayium down <link> [destdir] — fetch and decrypt a stored link; no account is needed to download.",
      ],
    },
    {
      heading: "receive: someone sends you a file across networks",
      prereqs: {
        label: "What you need before step 1",
        items: [
          "The CLI on this machine. relayium version prints a version string; a shell that answers command not found means it is not installed here yet.",
          "A sender who is signed in and at their terminal right now. Only they need an account — you never sign in to receive.",
          "The six digits, passed to you out of band. They live five minutes from the moment their CLI minted them, so agree on the moment first.",
          "A way to read six more digits back to them afterwards: the SAS is compared out loud, not on screen.",
          "The other end can be relayium send or relayium pair, a Relayium app or the web page — any of them mints a code you can receive with.",
        ],
      },
      steps: [
        {
          text: "Agree with the sender on when they will run send. The code starts expiring the moment it is minted, not the moment you get it.",
        },
        {
          text: "Take the six digits over a channel you both trust — a call, a chat window, the room you are both in.",
        },
        {
          text: "Run receive from the directory where the files should land, or name one explicitly.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "When both terminals print a verification code, read yours aloud and check it matches theirs. It is not the pairing code, and it is the only thing that rules out a substituted endpoint.",
        },
        {
          text: "Leave the terminal alone until it returns to the prompt. This is one live session: closing either end stops the transfer.",
        },
      ],
      success: {
        label: "What a successful receive looks like",
        body: [
          "The path line says how the bytes travel — relay, or direct / lan for peer to peer — and both ends show the SAME verification code. Different codes are the one result you must not accept — stop and check with the sender which machine they are on.",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: relay (selected pair …)`,
        ],
      },
      body: [
        "This is the receiving half of relayium send. The other person runs relayium send <path> on their end (after relayium login); their CLI mints a 6-digit code, good for 5 minutes, and prints it. They tell you what it is over any channel you both trust — a call, a chat message. You run receive with that code:",
      ],
      code: [
        `relayium receive 483920

# or into a specific directory
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "The connection is end-to-end encrypted; both ends print the same SAS (short authentication string) once connected. Compare it out of band to confirm that the keys the two ends exchanged were not substituted and the rendezvous service did not impersonate either endpoint. The SAS authenticates the endpoints; it does not prove every network hop.",
        "No destination given: files land in the current directory.",
        "Same relay rule as send: whenever the server issues a relay for the code, every byte goes through that encrypted relay and counts toward the monthly traffic allowance of the account that minted the code — the sender's, never yours — when the relay reports it as billable usage: the relay nodes Relayium operates do, while Relayium's coturn TURN servers bill nothing today — their legacy usage ingest is disabled, and their optional accounting ingest is off by default and, if configured in shadow mode, records measurements without writing to the billing ledger, usage periods or any allowance. Only when no relay is issued do the two ends connect peer to peer, and then the transfer fails if no direct path exists.",
        "The code is the same pairing code the apps and the web page use: a sender on relayium.com or in a Relayium app can read you a code and you receive it here, and a code minted by relayium send can be joined from the web page instead of the CLI.",
        "The receiver never needs an account, on any network. Only the sender signs in, so their CLI can mint the code.",
      ],
    },
    {
      heading: "serve: turn this machine into a listening drop box",
      steps: [
        {
          text: "Start the listener, naming the directory pushes should land in.",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "When a new machine pushes for the first time, serve shows its address and fingerprint and asks. Approve it once and later pushes from that fingerprint go through silently.",
        },
        {
          text: "If this listener will run without a terminal, do not rely on that prompt — nobody is there to answer it, and an unrecognised pusher is rejected outright. Pre-authorize instead, as the next section describes.",
        },
      ],
      body: [
        "serve works the other way around: instead of you reaching out, other machines push straight to you over relayium:// — built for machines you already trust, like your own laptop pushing to a NAS, or a build server dropping artifacts on a box you own — over a pinned TLS 1.3 connection, no SSH, no rendezvous.",
      ],
      code: [
        `relayium serve

# a specific directory, port, and allowing delete requests
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "The first time a new machine pushes to you, serve (running in a terminal) shows its address and fingerprint and asks you to approve it once; after that, pushes from the same fingerprint go through silently.",
        "Without a terminal — a systemd service, a script with no TTY — there's no one to ask, so an unrecognized pusher is rejected outright. Pre-authorize it instead, using the fingerprint the pusher prints with relayium id:",
      ],
    },
    {
      heading: "Pre-authorize for unattended serve",
      body: [
        "For a serve that runs unattended (systemd, a background script), have the pusher run relayium id to print its fingerprint, then approve it ahead of time from the receiving side:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir sets where files land (default the current directory); --once accepts a single transfer and exits; --allow-delete lets an incoming --delete (mirror) request actually remove files here, and is off by default.",
        "--config-dir (default ~/.config/relayium) is where this host's identity and its authorized-fingerprints list live — override it if you're running serve as a dedicated service.",
      ],
    },
    {
      heading: "down: fetch a stored encrypted link",
      steps: [
        {
          text: "Copy the complete link, including its #k= fragment. That fragment holds the only decryption key and is never sent to Relayium's server.",
          code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
        },
        {
          text: "Choose an existing writable destination directory, or create it before downloading.",
          code: ["mkdir -p ./local-dest"],
        },
        {
          text: "Run down with the complete link. The recipient does not sign in.",
          code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
        },
      ],
      body: [
        "down retrieves ciphertext held by Relayium, decrypts it locally and verifies it before installing the output.",
      ],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
      bullets: [
        "The server receives the URL before # but never the fragment containing the decryption key.",
        "down reconnects and continues within the same invocation, up to five attempts. If that invocation ultimately fails, it deletes the partial output; a later run starts over.",
        "SSH destinations, relayium pull, -i and -p are retired in the current CLI.",
      ],
    },
    {
      heading: "When it doesn't work",
      body: [
        "Five failures cover nearly every unsuccessful receive. Which command you were running decides which of them applies, and each has a line to read or a command to run that settles it.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "You type the code and the rendezvous refuses it.",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "Almost always the five minutes elapsed — the code expires from the moment the sender's CLI minted it, not from when you were told. Ask them to run send again and read you the fresh digits straight away. A mistyped digit looks identical from here, so re-read it back before assuming it lapsed.",
          },
          {
            symptom: "The transfer completes but you cannot find the files.",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "With no destination, receive writes into the directory you ran it from, which is rarely where you were looking. Pass one explicitly, or run pwd first and be sure.",
          },
          {
            symptom: "It prints \"relay unavailable: …\" and never connects.",
            code: [
              `relayium receive 483920
# relay unavailable: the pairing code owner's monthly relay allowance is used up; trying a direct connection only (no relay) — across strict NATs that may fail`,
            ],
            fix: "The server issued no relay for this code — the line names why, for example the sender's monthly allowance is used up — so the two ends tried peer to peer and could not reach each other. Ask the sender for a relayium up download link instead, or use daemon-direct between reachable machines you control. If it says \"no direct connection to the peer\" instead, the other end runs an older relayium whose pairing is direct-only: update it.",
          },
          {
            symptom: "down says the link is invalid or cannot decrypt the file.",
            code: [
              `relayium down '<link-without-fragment>' ./downloads
# invalid link or missing key`,
            ],
            fix: "Copy the whole link again, including #k=. The fragment is the only decryption key; the server cannot reconstruct it if it was omitted.",
          },
          {
            symptom: "A machine pushes to your serve listener and is rejected without ever prompting you.",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "The prompt only exists when serve has a terminal. Under systemd, in a script, or behind a pipe there is nobody to ask, so an unknown fingerprint is refused outright. Have the pusher run relayium id and pre-authorize it here with relayium authorize <fingerprint>, using the same --config-dir the listener runs under.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account to receive files?",
        a: "receive and serve need no account on your side, and down needs only the link. The sender signs in to mint a receive pairing code or create a stored link. Hosted storage consumes the sender's plan allowance, which is usage accounting rather than a per-transfer charge.",
      },
      {
        q: "Does relayium receive interoperate with the browser's pairing code?",
        a: "Yes. A current relayium and the apps and web page at relayium.com use the same pairing codes, so relayium receive can take a code a browser or app minted, and a browser can join a code relayium send minted. Only an older relayium CLI, or a server that predates pairing hints, falls back to the older CLI-only, direct-only pairing.",
      },
      {
        q: "What happens if an unknown machine pushes to my serve listener?",
        a: "In a terminal, you're prompted to approve it by address and fingerprint on its first push, and the approval is remembered. Without a terminal — a systemd service, a cron job — there's no one to ask, so an unrecognized pusher is rejected; pre-authorize it first with relayium authorize <fingerprint>.",
      },
      {
        q: "Can I pull files from a server I administer?",
        a: "Not with relayium pull: it and SSH transfers are retired in the current CLI. Run relayium serve on this machine and have the server push to it with relayium push relayium://this-host, or have the server upload with relayium up and fetch the link here with relayium down.",
      },
      {
        q: "Where does relayium keep my identity and trusted peers?",
        a: "In ~/.config/relayium by default — override the location with --config-dir on any command that touches identity or trust.",
      },
    ],
  },
  cta: {
    text: "Ready to receive your first transfer? Install the CLI and pick receive, serve, or down.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "在命令行接收文件",
  description:
    "用 Relayium CLI 接收文件的三种方式：receive 接收配对码发送，serve 监听 daemon 直连推送，或者用 down 下载托管的加密链接。",
  updatedLabel: "最近更新",
  lead: [
    "发送只是故事的一半——迟早你也会是接收方：同事想跨网络给你一个文件，你自己的一台机器想把东西交给另一台，或者有人给你留了一个托管链接，等你有空再取。Relayium CLI 用三个不同的命令覆盖这三种情形，接收这一侧都不需要账号。",
    "对方用配对码发送时用 receive；受信任机器向你管理的监听端直推时用 serve；发送方给了托管加密链接、而且可能已经离线时用 down。",
  ],
  sections: [
    {
      heading: "三种接收方式，各自适用于什么场景",
      body: ["用哪个命令，取决于谁在发起传输，以及两台机器是怎么互相认识的："],
      bullets: [
        "relayium receive <code> [destdir] ——对方跨网络发给你：他先生成一个配对码（用 CLI、Relayium 应用或网页都行），再线下转告你。端到端加密；只要服务器为这个码签发了中继就经中继传输，并给出一段可供核对的 SAS 码。",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] ——这台机器监听 daemon 直连的 relayium:// 推送，默认端口 9031。",
        "relayium down <link> [destdir] ——下载并解密托管链接；下载端不需要账号。",
      ],
    },
    {
      heading: "receive：对方跨网络把文件发给你",
      prereqs: {
        label: "开始之前你需要什么",
        items: [
          "本机装好 CLI。relayium version 会打印版本号；如果 shell 回答 command not found，说明这台还没装。",
          "一位此刻已登录、并且人就在终端前的发送方。只有他需要账号——你接收全程都不用登录。",
          "那六位数字，通过带外渠道传给你。它从对方 CLI 生成的那一刻起只活五分钟，所以先约好时间。",
          "事后还能再把六位数字念回去的渠道：SAS 是靠口头比对的，不是看屏幕。",
          "另一端可以是 relayium send 或 relayium pair、Relayium 应用或网页——它们生成的码你都能用 receive 接收。",
        ],
      },
      steps: [
        {
          text: "和发送方约好他什么时候执行 send。配对码是从生成那一刻开始计时的，不是从你拿到它的那一刻。",
        },
        {
          text: "通过你们都信任的渠道拿到这六位数字——一通电话、一个聊天窗口，或者你们同处的那个房间。",
        },
        {
          text: "在希望文件落地的目录里执行 receive，或者显式指定一个目录。",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "当两个终端都打印出验证码时，把你这边的念出来，确认和对方一致。它不是配对码，而且它是唯一能排除对端被替换的东西。",
        },
        {
          text: "在终端回到提示符之前不要动它。这是一次实时会话：任何一端关掉，传输就停了。",
        },
      ],
      success: {
        label: "一次成功的接收长什么样",
        body: [
          "path 那一行会写明字节怎么走——relay，或者表示点对点的 direct / lan——并且两端显示相同的验证码。验证码不同是唯一一种你绝不能接受的结果——立刻停下，跟发送方核对他到底在哪台机器上。",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: relay (selected pair …)`,
        ],
      },
      body: [
        "这是 relayium send 的接收端。对方在自己那边运行 relayium send <path>（事先 relayium login 过），CLI 会生成一个 6 位数字、5 分钟内有效的码并打印出来。然后对方通过你们都信任的渠道告诉你——打个电话、发条消息。你则用这个码运行 receive：",
      ],
      code: [
        `relayium receive 483920

# 或者放进指定的目录
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "连接是端到端加密的；一旦连上，两端会打印出同一个 SAS（简短认证串）。通过带外方式与发送方核对，可以确认双方交换的密钥没有被替换、会合服务没有冒充任一端。SAS 认证的是端点，并不证明网络路径上的每一跳。",
        "不指定目标目录时，文件会落到当前目录。",
        "中继规则和 send 一样：只要服务器为这个码签发了中继，每个字节都经这条加密中继传输；中继把它们上报为计费用量时，计入生成配对码那个账号的每月流量额度——是发送方的，不是你的。Relayium 运营的中继节点会这样上报，而 Relayium 的 coturn TURN 服务器目前不计费——旧的用量采集已停用，可选的计量采集默认关闭，如果配置为影子模式，也只记录测量值，不写入计费账本、用量周期或任何额度。只有在没有签发中继时，两端才点对点连接，这时如果没有直连路径，传输就会失败。",
        "这个码和应用、网页用的是同一种配对码：在 relayium.com 或 Relayium 应用里发送的人可以把码念给你，你在这里接收；relayium send 生成的码，也可以在网页上加入，而不必用 CLI。",
        "接收方无论在哪个网络上，都不需要账号。只有发送方需要登录，好让发送端的 CLI 生成配对码。",
      ],
    },
    {
      heading: "serve：把这台机器变成一个监听收件箱",
      steps: [
        {
          text: "启动监听器，并指定推送文件落地的目录。",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "有新机器第一次推送时，serve 会显示它的地址和指纹并询问你。批准一次之后，来自该指纹的推送就会静默通过。",
        },
        {
          text: "如果这个监听器将来没有终端运行，就不要指望那个提示——没人能回答它，陌生的推送方会被直接拒绝。改用下一节讲的预先授权。",
        },
      ],
      body: [
        "serve 的方向正相反：不是你去连别人，而是其他机器通过 relayium:// 直接推送给你——专为你已经信任的机器设计，比如你自己的笔记本推给一台 NAS，或者构建服务器把产物投递到你的机器上——走的是证书固定的 TLS 1.3 连接，无需 SSH，无需会合。",
      ],
      code: [
        `relayium serve

# 指定目录和端口，并允许删除请求
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "新机器第一次向你推送时，serve（在终端中运行时）会显示它的地址和指纹，并请你批准一次；之后同一指纹的推送会静默通过。",
        "没有终端时——比如作为 systemd 服务、无 TTY 的脚本——没有人来回应提示，未知推送方会被直接拒绝。这种情况下应改为预先授权，用推送方通过 relayium id 打印出的指纹：",
      ],
    },
    {
      heading: "为无人值守的 serve 预先授权",
      body: [
        "对于无人值守运行的 serve（systemd、后台脚本），让推送方运行 relayium id 打印出它的指纹，然后在接收方这边提前批准它：",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir 设置文件落地的位置（默认为当前目录）；--once 只接受一次传输就退出；--allow-delete 允许推送方的 --delete（镜像）请求真正在这里删除文件，默认关闭。",
        "--config-dir（默认 ~/.config/relayium）指向一个位置：这台主机的身份和已授权指纹列表都存放在那里——如果把 serve 作为专用服务运行，可以覆盖它。",
      ],
    },
    {
      heading: "down：下载托管的加密链接",
      steps: [
        {
          text: "复制完整链接，包括 #k= 片段。该片段含唯一解密密钥，从不会发送给 Relayium 服务器。",
          code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
        },
        {
          text: "选择一个已存在且可写的目标目录，或先创建它。",
          code: ["mkdir -p ./local-dest"],
        },
        {
          text: "用完整链接运行 down。接收方不需要登录。",
          code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
        },
      ],
      body: [
        "down 会取回 Relayium 保存的密文，在本地解密并校验后再安装输出。",
      ],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
      bullets: [
        "服务器会收到 # 之前的 URL，但永远收不到片段里的解密密钥。",
        "down 会在同一次调用内自动重连，最多五次；如果最终失败，会删除半截输出，之后重新运行会从头开始。",
        "当前 CLI 中，SSH 目标、relayium pull、-i 与 -p 已退役。",
      ],
    },
    {
      heading: "出问题时怎么办",
      body: [
        "几乎所有失败的接收都逃不出这五种。你当时跑的是哪条命令，决定了适用哪一条；每一条都有一行可读的输出或一条可跑的命令来判定。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "你输入配对码，会合服务器拒绝了它。",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "几乎总是那五分钟已经过去了——配对码是从发送方 CLI 生成的那一刻起计时，而不是从你被告知的那一刻。让他重新跑一次 send，并立刻把新的数字念给你。输错一位数字从你这边看起来一模一样，所以在断定它过期之前，先把码复述回去核对一遍。",
          },
          {
            symptom: "传输完成了，但你找不到文件。",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "不指定目标目录时，receive 会写进你执行它时所在的那个目录，而那通常不是你去找的地方。显式传一个目录，或者先跑 pwd 确认清楚。",
          },
          {
            symptom: "打印「relay unavailable: …」，一直连不上。",
            code: [
              `relayium receive 483920
# relay unavailable: the pairing code owner's monthly relay allowance is used up; trying a direct connection only (no relay) — across strict NATs that may fail`,
            ],
            fix: "服务器没有为这个码签发中继——这一行会写明原因，比如发送方的每月额度已用尽——于是两端尝试点对点，却够不着对方。让发送方改用 relayium up 下载链接；如果两台机器都归你控制，就用 daemon 直连。如果报的是「no direct connection to the peer」，说明对端是旧版 relayium，它的配对只走直连：请把它升级。",
          },
          {
            symptom: "down 提示链接无效或无法解密。",
            code: [
              `relayium down '<link-without-fragment>' ./downloads
# invalid link or missing key`,
            ],
            fix: "重新复制完整链接，包括 #k=。该片段是唯一解密密钥；缺失后服务器无法补回。",
          },
          {
            symptom: "有机器推送到你的 serve 监听器，被拒绝了，而且从头到尾没问过你。",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "那个提示只在 serve 拥有终端时才存在。跑在 systemd 下、脚本里或管道后面时没人可问，所以陌生指纹会被直接拒绝。让推送方跑 relayium id，在这边用 relayium authorize <指纹> 预先授权，并且要用监听器运行时相同的 --config-dir。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "接收文件需要账号吗？",
        a: "receive 与 serve 在你这一端不需要账号，down 只需要链接。发送方生成 receive 配对码或托管链接时需要登录。托管存储会占用发送方套餐额度，这表示用量记账，不是按次收费。",
      },
      {
        q: "relayium receive 和浏览器的配对码互通吗？",
        a: "互通。当前版本的 relayium 与 relayium.com 上的应用和网页使用同一种配对码，所以 relayium receive 能接收浏览器或应用生成的码，浏览器也能加入 relayium send 生成的码。只有旧版 relayium CLI，或者早于配对提示的服务器，才会退回旧的、只限 CLI 且只走直连的配对。",
      },
      {
        q: "如果一台未知机器向我的 serve 监听端推送会怎样？",
        a: "在终端中，会在它首次推送时提示你按地址和指纹批准，批准结果会被记住。没有终端时——比如作为 systemd 服务或 cron 任务——没有人来回应，未知推送方会被拒绝；应先用 relayium authorize <fingerprint> 预先授权。",
      },
      {
        q: "能从我管理的服务器上把文件取回来吗？",
        a: "不能用 relayium pull：它和 SSH 传输在当前 CLI 中都已退役。请在本机运行 relayium serve，让服务器用 relayium push relayium://本机 推送过来；或者让服务器用 relayium up 上传，再在这里用 relayium down 取回链接。",
      },
      {
        q: "relayium 把我的身份和受信任的对端存在哪里？",
        a: "默认在 ~/.config/relayium 中——在任何涉及身份或信任的命令上，都可以用 --config-dir 覆盖这个位置。",
      },
    ],
  },
  cta: {
    text: "准备好接收第一次传输了吗？装上 CLI，选择 receive、serve 或 down。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "コマンドラインでファイルを受信する",
  description:
    "Relayium CLI でファイルを受信する3つの方法: ネットワークを越えたペアリングコード送信を receive で受け取る、デーモン直結のプッシュを待ち受ける serve、保存された暗号化リンクを down で取得する。受信側にアカウントは不要です。",
  updatedLabel: "最終更新",
  lead: [
    "送信は話の半分にすぎません——いずれ受け取る側になります。同僚がインターネット越しにファイルを渡したいとき、自分のマシン同士で受け渡ししたいとき、あるいは誰かが保存リンクを残してくれて、都合のよいときに取りに行きたいとき。Relayium CLI はそれぞれに異なるコマンドで、この3つすべてに対応しています。受信側はどれもアカウント不要です。",
    "相手がペアリングコードでこちらへ送ってくるなら receive、信頼できるマシンがいつでもプッシュできる常設の受信箱が欲しいなら serve、そして送信者が保存された暗号化リンクを渡してくれて、すでにオフラインかもしれないなら down を選びます。",
  ],
  sections: [
    {
      heading: "受信の3つの方法と、それぞれが当てはまる場面",
      body: [
        "どのコマンドを使うかは、誰が転送を始めるのか、そして2台のマシンがどう互いを知っているかによって決まります:",
      ],
      bullets: [
        "relayium receive <code> [destdir] ——相手が（CLI、Relayium のアプリ、ウェブページのいずれかで）発行し、帯域外で伝えられたペアリングコードを使って、相手がネットワークを越えて送ってきます。エンドツーエンドで暗号化され、サーバーがそのコードにリレーを発行した場合はそれを通ります。照合用の SAS コードが表示されます。",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] ——このマシンがデーモン直結の relayium:// プッシュを待ち受けます。デフォルトのポートは 9031 です。",
        "relayium down <link> [destdir] ——保存されたリンクを取得して復号します。ダウンロードにアカウントは不要です（以前の SSH 経由の relayium pull は廃止されました）。",
      ],
    },
    {
      heading: "receive: 相手がネットワークを越えてファイルを送ってくる",
      prereqs: {
        label: "手順1の前に必要なもの",
        items: [
          "このマシンに CLI。relayium version はバージョン文字列を表示します。command not found と返るなら、ここにはまだ入っていません。",
          "いまサインイン済みで、いま端末の前にいる送信者。アカウントが要るのは送信者だけで、受信側がサインインすることはありません。",
          "6桁の数字を、帯域外の手段で受け取ること。相手の CLI が発行した瞬間から5分間だけ有効なので、先にタイミングを合わせてください。",
          "あとで6桁をもう一度読み返せる手段。SAS は画面上ではなく口頭で照合します。",
          "相手側は relayium send か relayium pair、Relayium のアプリ、ウェブページのどれでも構いません。どれが発行したコードでも receive で受け取れます。",
        ],
      },
      steps: [
        {
          text: "送信者が send を実行するタイミングを先に決めます。コードの有効期限は発行された瞬間から始まり、受け取った瞬間からではありません。",
        },
        {
          text: "互いに信頼できる経路で6桁を受け取ります——通話、チャット、あるいは同じ部屋にいるならその場で。",
        },
        {
          text: "ファイルを置きたいディレクトリで receive を実行するか、置き場所を明示します。",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "両方の端末に確認コードが表示されたら、自分の側を読み上げて相手と一致するか確かめます。これはペアリングコードではなく、相手側がすり替えられていないことを否定できる唯一の材料です。",
        },
        {
          text: "端末がプロンプトに戻るまで触らないでください。これは1つのライブセッションで、どちらかを閉じれば転送は止まります。",
        },
      ],
      success: {
        label: "受信が成功したときの見え方",
        body: [
          "path の行がバイトの通り道を示します。relay か、P2P を示す direct / lan です。そして両方の端が同じ確認コードを表示します。コードが食い違うことだけは受け入れてはいけません——そこで止めて、相手がどのマシンにいるのかを確認してください。",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      body: [
        "これは relayium send の受信側です。相手は自分の側で relayium send <path> を実行します（事前に relayium login 済み）。相手の CLI が 5 分間有効な 6 桁の数字コードを発行して表示するので、通話やチャットなど二人が信頼できる手段でそれを伝えてもらいます。受け取ったコードで receive を実行します:",
      ],
      code: [
        `relayium receive 483920

# 特定のディレクトリに受け取る場合
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "接続はエンドツーエンドで暗号化されています。接続後、両方の端に同じ SAS（short authentication string）が表示されます。送信側と帯域外で照合すると、固定された TLS 証明書フィンガープリントが差し替えられておらず、ランデブーサービスがどちらのエンドポイントにもなりすましていないことを確認できます。SAS はエンドポイントを認証するもので、ネットワーク経路上のすべてのホップを証明するものではありません。",
        "宛先を指定しない場合、ファイルはカレントディレクトリに置かれます。",
        "リレーのルールは send と同じです。サーバーがそのコードにリレーを発行した場合、すべてのバイトはその暗号化リレーを通り、コードを発行したアカウントの月間転送量の枠に計上されます。受信側ではなく送信側の枠です。リレーが発行されないときだけ両端は P2P でつながり、そのとき直接の経路がなければ転送は失敗します。",
        "このコードは、アプリやウェブページが使うものと同じペアリングコードです。relayium.com や Relayium のアプリで送る人がコードを読み上げれば、ここで受け取れます。relayium send が発行したコードに、CLI ではなくウェブページから参加することもできます。",
        "受信側はどのネットワークにいても、アカウントは一切不要です。サインインするのは送信側だけで、その CLI がコードを発行できるようにするためです。",
      ],
    },
    {
      heading: "serve: このマシンを待ち受け型の受信箱にする",
      steps: [
        {
          text: "受信先ディレクトリを指定してリスナーを起動します。",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "新しいマシンが初めて push してくると、serve はそのアドレスとフィンガープリントを示して確認を求めます。一度承認すれば、同じフィンガープリントからの push は以後そのまま通ります。",
        },
        {
          text: "このリスナーを端末なしで動かすつもりなら、そのプロンプトを当てにしないでください。答える人がいないため、見知らぬ送信元は問答無用で拒否されます。次の節にある事前承認を使ってください。",
        },
      ],
      body: [
        "serve は逆方向に動作します。こちらから出向くのではなく、他のマシンが relayium:// 経由で直接プッシュしてきます——自分のノート PC が NAS へプッシュする、ビルドサーバーが成果物を自分のマシンへ落とすなど、すでに信頼しているマシン向けです。証明書ピンニング付き TLS 1.3 接続で、SSH もランデブーも不要です。",
      ],
      code: [
        `relayium serve

# ディレクトリとポートを指定し、削除要求を許可する場合
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "新しいマシンが初めてプッシュしてくると、serve は（ターミナルで実行している場合）そのアドレスとフィンガープリントを表示し、一度だけ承認するよう求めます。以降、同じフィンガープリントからのプッシュは黙って通過します。",
        "ターミナルがない場合——systemd サービスや TTY のないスクリプト——確認する相手がいないため、未知のプッシュ側はそのまま拒否されます。代わりに、プッシュ側が relayium id で表示するフィンガープリントを使って事前に承認してください:",
      ],
    },
    {
      heading: "無人稼働の serve のために事前承認する",
      body: [
        "無人で動作する serve（systemd、バックグラウンドスクリプト）では、プッシュ側に relayium id を実行させてフィンガープリントを表示させ、受信側であらかじめそれを承認しておきます:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir はファイルの置き場所を設定します（デフォルトはカレントディレクトリ）。--once は1回の転送だけ受け入れて終了します。--allow-delete は受信した --delete（ミラー）要求によって実際にここでファイルを削除できるようにするもので、デフォルトでは無効です。",
        "--config-dir（デフォルト ~/.config/relayium）は、このホストのアイデンティティと承認済みフィンガープリントのリストが置かれる場所です——serve を専用サービスとして動かす場合は上書きしてください。",
      ],
    },
    {
      heading: "pull（SSH）：廃止されました",
      body: [sshRetiredNotice.ja, "自分が管理するサーバーから何かを取り戻すには、サーバー側で relayium up でアップロードし、ここでそのリンクを使って relayium down を実行してください。あるいはこのマシンで relayium serve を実行し、サーバーから relayium://このホスト へ push してもらいます。"],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
    },
    {
      heading: "うまくいかないとき",
      body: [
        "失敗する受信のほぼすべては次の5つのどれかです。どのコマンドを実行していたかで該当するものが決まり、どれにも読めば分かる1行か実行すれば決着がつくコマンドがあります。",
      ],
      troubleshooting: {
        label: "症状、確認、対処",
        items: [
          {
            symptom: "コードを入力したのに、ランデブーがそれを拒否する。",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "ほぼ確実に5分が経過しています。コードの有効期限は送信者の CLI が発行した瞬間から始まり、知らされた瞬間からではありません。もう一度 send を実行してもらい、新しい数字をその場で読み上げてもらってください。1桁の打ち間違いはこちらからは見分けがつかないので、期限切れと決めつける前に読み返して照合します。",
          },
          {
            symptom: "転送は終わったのに、ファイルが見つからない。",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "宛先を指定しない場合、receive は実行したディレクトリに書き込みます。そこは探している場所とは限りません。明示的に指定するか、先に pwd で確かめてください。",
          },
          {
            symptom: "「no direct connection to the peer (both ends behind strict NAT?)」で失敗する。",
            code: [
              `relayium receive 483920
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "片方の端が古い relayium で、そのペアリングは直結専用のため、どちらの端も相手に届きませんでした。両端を更新してください。現在の relayium は、サーバーがそのコードにリレーを発行すれば暗号化リレーを通ります。それ以外の場合は、片方を到達可能なアドレスを持つネットワーク（サーバー、あるいはスマートフォンのテザリング）へ移すか、relayium up でアップロードしてダウンロードリンクを渡してください。",
          },
          {
            symptom: "down がリンクは無効だ、またはファイルを復号できないと言う。",
            code: [
              "relayium down '<link-without-fragment>' ./downloads\n# invalid link or missing key",
            ],
            fix: "#k= を含めて、リンク全体をもう一度コピーしてください。このフラグメントが唯一の復号鍵で、省かれた場合にサーバーがそれを復元することはできません。",
          },
          {
            symptom: "あるマシンが serve リスナーに push して拒否されたのに、こちらには一度も確認が出なかった。",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "あの確認は serve に端末があるときにしか存在しません。systemd 配下、スクリプト内、パイプの先では尋ねる相手がいないため、未知のフィンガープリントは問答無用で拒否されます。送信側に relayium id を実行してもらい、こちらで relayium authorize <フィンガープリント> を、リスナーと同じ --config-dir で実行してください。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ファイルを受信するのにアカウントは必要ですか？",
        a: "いいえ。receive と serve は受信側にアカウントが不要で、down にはリンクだけあれば十分です。サインインが要るのは送信側で、receive 用のペアリングコードを発行するときや保存リンクを作るときです。保存型ストレージは送信側のプランの枠を使いますが、これは利用量の計上であって、転送ごとの料金ではありません。",
      },
      {
        q: "relayium receive はブラウザのペアリングコードと相互運用しますか？",
        a: "します。現在の relayium と relayium.com のアプリやウェブページは同じペアリングコードを使うので、relayium receive はブラウザやアプリが発行したコードを受け取れ、ブラウザも relayium send が発行したコードに参加できます。古い CLI 専用・直結専用のペアリングに戻るのは、古い relayium CLI か、ペアリングヒントより前のサーバーの場合だけです。",
      },
      {
        q: "未知のマシンが自分の serve リスナーへプッシュしてきたらどうなりますか？",
        a: "ターミナルでは、初回のプッシュ時にアドレスとフィンガープリントを見せて承認するかどうか尋ねられ、その承認は記憶されます。ターミナルがない場合——systemd サービスや cron ジョブ——確認する相手がいないため、未知のプッシュ側は拒否されます。先に relayium authorize <fingerprint> で事前承認してください。",
      },
      {
        q: "自分が管理するサーバーからファイルを取り戻せますか？",
        a: "relayium pull ではできません。pull と SSH 転送は現在の CLI では廃止されました。このマシンで relayium serve を実行してサーバーから relayium push relayium://このホスト で送ってもらうか、サーバー側で relayium up でアップロードし、ここで relayium down でリンクを取得してください。",
      },
      {
        q: "relayium は自分のアイデンティティと信頼済みの相手をどこに保存しますか？",
        a: "デフォルトでは ~/.config/relayium にあります——アイデンティティや信頼に関わるどのコマンドでも --config-dir でこの場所を上書きできます。",
      },
    ],
  },
  cta: {
    text: "最初の受信をしてみましょう。CLI をインストールして、receive、serve、down のいずれかを選んでください。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "명령줄에서 파일 받기",
  description:
    "Relayium CLI로 파일을 받는 세 가지 방법: 네트워크를 넘어온 페어링 코드 전송을 receive로 받거나, 데몬 다이렉트 푸시를 대기하는 serve, 저장된 암호화 링크를 down으로 가져오기. 받는 쪽에는 계정이 필요 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "보내는 것은 이야기의 절반일 뿐입니다——언젠가는 받는 쪽이 됩니다. 동료가 인터넷 너머로 파일을 건네주고 싶을 때, 내 기기 하나가 다른 기기에게 넘겨주고 싶을 때, 또는 누군가 남겨 둔 저장 링크를 편할 때 가져오고 싶을 때. Relayium CLI는 이 세 가지 각각에 서로 다른 명령으로 대응하며, 받는 쪽은 어느 경우에도 계정이 필요 없습니다.",
    "상대가 페어링 코드로 보내올 때는 receive를, 신뢰하는 기기들이 언제든 푸시할 수 있는 상시 수신함이 필요할 때는 serve를, 그리고 보내는 사람이 저장된 암호화 링크를 주었고 이미 오프라인일 수 있을 때는 down을 선택하세요.",
  ],
  sections: [
    {
      heading: "받는 세 가지 방법과 각각이 적용되는 상황",
      body: ["어떤 명령을 실행할지는 누가 전송을 시작하는지, 그리고 두 기기가 서로 어떻게 아는 사이인지에 따라 달라집니다:"],
      bullets: [
        "relayium receive <code> [destdir] — 상대가 (CLI, Relayium 앱, 웹 페이지 중 하나로) 발급해 대역 외로 알려준 페어링 코드를 사용해 상대가 네트워크를 넘어 보내옵니다. 종단간 암호화되며, 서버가 해당 코드에 릴레이를 발급하면 그것을 거칩니다. 대조할 수 있는 SAS 코드가 표시됩니다.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — 이 기기가 데몬 다이렉트 relayium:// 푸시를 대기합니다. 기본 포트는 9031입니다.",
        "relayium down <link> [destdir] — 저장된 링크를 가져와 복호화합니다. 다운로드에는 계정이 필요 없습니다(예전의 SSH 기반 relayium pull은 폐지되었습니다).",
      ],
    },
    {
      heading: "receive: 상대가 네트워크를 넘어 파일을 보낼 때",
      prereqs: {
        label: "1단계 전에 필요한 것",
        items: [
          "이 기기에 CLI. relayium version은 버전 문자열을 출력합니다. command not found가 나오면 여기에는 아직 설치되지 않은 것입니다.",
          "지금 로그인되어 있고 지금 터미널 앞에 있는 발신자. 계정이 필요한 쪽은 발신자뿐이고, 받는 쪽은 로그인하지 않습니다.",
          "여섯 자리 숫자를 대역 외 경로로 전달받을 것. 상대 CLI가 발급한 순간부터 5분간만 유효하므로 시점을 먼저 맞추세요.",
          "나중에 여섯 자리를 다시 읽어 줄 수 있는 경로. SAS는 화면이 아니라 말로 대조합니다.",
          "상대는 relayium send나 relayium pair, Relayium 앱, 웹 페이지 중 무엇이든 됩니다. 어느 쪽이 발급한 코드든 receive로 받을 수 있습니다.",
        ],
      },
      steps: [
        {
          text: "발신자가 send를 언제 실행할지 먼저 맞추세요. 코드는 발급된 순간부터 만료가 시작되며, 전달받은 순간부터가 아닙니다.",
        },
        {
          text: "서로 신뢰하는 경로로 여섯 자리를 받으세요 — 통화, 채팅창, 아니면 같이 있는 그 방에서.",
        },
        {
          text: "파일이 떨어질 디렉터리에서 receive를 실행하거나, 위치를 명시하세요.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "두 터미널에 확인 코드가 뜨면 자기 쪽 값을 소리 내어 읽고 상대와 일치하는지 확인하세요. 이것은 페어링 코드가 아니며, 상대 종단이 바꿔치기되지 않았음을 배제해 주는 유일한 근거입니다.",
        },
        {
          text: "터미널이 프롬프트로 돌아올 때까지 건드리지 마세요. 이것은 하나의 실시간 세션이라 어느 쪽이든 닫으면 전송이 멈춥니다.",
        },
      ],
      success: {
        label: "성공적인 수신의 모습",
        body: [
          "path 줄이 바이트가 가는 길을 보여 줍니다. relay, 또는 P2P를 뜻하는 direct / lan입니다. 그리고 양쪽에 같은 확인 코드가 표시됩니다. 코드가 다른 것만은 받아들이면 안 되는 결과입니다 — 멈추고 보내는 사람이 어느 기기에 있는지 확인하세요.",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      body: [
        "이것은 relayium send의 받는 쪽입니다. 상대는 자기 쪽에서 relayium send <path>를 실행합니다(미리 relayium login을 해 둔 상태로). 그러면 상대의 CLI가 5분간 유효한 6자리 숫자 코드를 발급해 출력하고, 상대는 통화나 채팅 등 서로 신뢰하는 채널로 그것을 알려줍니다. 받는 쪽에서는 그 코드로 receive를 실행합니다:",
      ],
      code: [
        `relayium receive 483920

# 특정 디렉터리로 받으려면
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "연결은 종단간 암호화됩니다. 연결되면 양쪽에 같은 SAS(short authentication string)가 표시됩니다. 보내는 사람과 대역 외로 비교하면 고정된 TLS 인증서 지문이 바뀌지 않았고 랑데부 서비스가 어느 끝점도 사칭하지 않았음을 확인할 수 있습니다. SAS는 끝점을 인증할 뿐 네트워크 경로의 모든 홉을 증명하지는 않습니다.",
        "목적지를 지정하지 않으면 파일은 현재 디렉터리에 저장됩니다.",
        "릴레이 규칙은 send와 같습니다. 서버가 해당 코드에 릴레이를 발급하면 모든 바이트가 그 암호화된 릴레이를 거치며, 코드를 발급한 계정의 월간 전송량 한도에 집계됩니다. 받는 쪽이 아니라 보내는 쪽의 한도입니다. 릴레이가 발급되지 않을 때만 두 끝이 P2P로 연결되며, 이때 직접 경로가 없으면 전송이 실패합니다.",
        "이 코드는 앱과 웹 페이지가 쓰는 것과 같은 페어링 코드입니다. relayium.com이나 Relayium 앱에서 보내는 사람이 코드를 불러 주면 여기서 받을 수 있고, relayium send가 발급한 코드에 CLI 대신 웹 페이지로 참여할 수도 있습니다.",
        "받는 쪽은 어느 네트워크에 있든 계정이 전혀 필요하지 않습니다. 로그인하는 쪽은 보내는 사람뿐이며, 그 CLI가 코드를 발급할 수 있도록 하기 위해서입니다.",
      ],
    },
    {
      heading: "serve: 이 기기를 대기형 수신함으로 만들기",
      steps: [
        {
          text: "전송이 떨어질 디렉터리를 지정해 리스너를 시작합니다.",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "새 기기가 처음 밀어 넣으면 serve가 그 주소와 지문을 보여 주며 묻습니다. 한 번 승인하면 같은 지문에서 오는 전송은 이후 조용히 통과합니다.",
        },
        {
          text: "이 리스너를 터미널 없이 돌릴 예정이라면 그 프롬프트에 기대지 마세요. 답할 사람이 없으므로 낯선 발신자는 그대로 거부됩니다. 다음 절의 사전 승인을 쓰세요.",
        },
      ],
      body: [
        "serve는 반대 방향으로 동작합니다. 이쪽에서 다가가는 대신, 다른 기기가 relayium://를 통해 곧바로 푸시해 옵니다——이미 신뢰하는 기기, 예를 들어 자신의 노트북이 NAS로 푸시하거나 빌드 서버가 산출물을 내 기기에 떨어뜨리는 경우를 위한 것입니다. 인증서 고정 TLS 1.3 연결로, SSH도 랑데부도 필요 없습니다.",
      ],
      code: [
        `relayium serve

# 디렉터리와 포트를 지정하고 삭제 요청을 허용하려면
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "새 기기가 처음 푸시해 오면, serve는(터미널에서 실행 중일 때) 그 주소와 핑거프린트를 보여주고 한 번 승인해 달라고 요청합니다. 이후 같은 핑거프린트의 푸시는 조용히 통과합니다.",
        "터미널이 없을 때——systemd 서비스, TTY 없는 스크립트——물어볼 사람이 없으므로 알 수 없는 푸시하는 쪽은 그대로 거부됩니다. 대신 푸시하는 쪽이 relayium id로 출력하는 핑거프린트를 이용해 미리 승인하세요:",
      ],
    },
    {
      heading: "무인 실행되는 serve를 위해 미리 승인하기",
      body: [
        "무인으로 실행되는 serve(systemd, 백그라운드 스크립트)의 경우, 푸시하는 쪽이 relayium id를 실행해 핑거프린트를 출력하게 한 다음, 받는 쪽에서 미리 승인해 두세요:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir는 파일이 저장될 위치를 설정합니다(기본값은 현재 디렉터리). --once는 한 번의 전송만 받고 종료합니다. --allow-delete는 들어오는 --delete(미러) 요청이 실제로 이곳의 파일을 삭제할 수 있게 하며, 기본값은 꺼짐입니다.",
        "--config-dir(기본값 ~/.config/relayium)는 이 호스트의 신원과 승인된 핑거프린트 목록이 저장되는 위치입니다——serve를 전용 서비스로 실행한다면 재정의하세요.",
      ],
    },
    {
      heading: "pull(SSH): 폐지됨",
      body: [sshRetiredNotice.ko, "관리하는 서버에서 무언가를 가져오려면 서버에서 relayium up으로 올리고 여기서 그 링크로 relayium down을 실행하세요. 또는 이 기기에서 relayium serve를 실행하고 서버가 relayium://이-호스트 로 push하게 하세요."],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
    },
    {
      heading: "잘 안 될 때",
      body: [
        "실패하는 수신은 거의 모두 다섯 가지 중 하나입니다. 어떤 명령을 실행했는지가 해당 항목을 정하며, 각각 읽어서 판단할 한 줄이나 실행해서 결론 낼 명령이 있습니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "코드를 입력했는데 랑데부가 거부합니다.",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "거의 항상 5분이 지난 경우입니다. 코드는 발신자의 CLI가 발급한 순간부터 만료되며, 전달받은 시점부터가 아닙니다. 다시 send를 실행하게 하고 새 숫자를 바로 읽어 달라고 하세요. 한 자리 오타는 이쪽에서 보면 똑같아 보이므로, 만료라고 단정하기 전에 코드를 되읽어 대조하세요.",
          },
          {
            symptom: "전송은 끝났는데 파일을 찾을 수 없습니다.",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "목적지를 주지 않으면 receive는 실행한 디렉터리에 씁니다. 그곳이 찾고 있던 위치인 경우는 드뭅니다. 위치를 명시하거나 먼저 pwd로 확인하세요.",
          },
          {
            symptom: "\"no direct connection to the peer (both ends behind strict NAT?)\"로 실패합니다.",
            code: [
              `relayium receive 483920
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "한쪽이 페어링이 직접 연결 전용인 이전 relayium이어서, 양쪽 어느 쪽도 상대에 닿지 못했습니다. 양쪽을 업데이트하세요. 현재 relayium은 서버가 해당 코드에 릴레이를 발급하면 암호화된 릴레이를 거칩니다. 그 밖의 경우에는 한쪽을 도달 가능한 주소가 있는 네트워크 — 서버나 휴대폰 핫스팟 — 로 옮기거나, relayium up 으로 올린 뒤 다운로드 링크를 건네세요.",
          },
          {
            symptom: "down이 링크가 잘못되었거나 파일을 복호화할 수 없다고 합니다.",
            code: [
              "relayium down '<link-without-fragment>' ./downloads\n# invalid link or missing key",
            ],
            fix: "#k=를 포함해 링크 전체를 다시 복사하세요. 이 프래그먼트가 유일한 복호화 키이며, 빠졌다면 서버가 이를 복원할 수 없습니다.",
          },
          {
            symptom: "어떤 기기가 serve 리스너로 밀어 넣었다가 거부되었는데, 한 번도 묻는 창이 뜨지 않았습니다.",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "그 프롬프트는 serve에 터미널이 있을 때만 존재합니다. systemd 아래, 스크립트 안, 파이프 뒤에서는 물어볼 상대가 없으므로 모르는 지문은 그대로 거부됩니다. 보내는 쪽에서 relayium id를 실행하게 하고, 여기서 relayium authorize <지문>을 리스너와 같은 --config-dir로 실행하세요.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "파일을 받는 데 계정이 필요한가요?",
        a: "아니요. receive와 serve는 받는 쪽에 계정이 필요 없고, down은 링크만 있으면 됩니다. 로그인은 보내는 쪽이 receive용 페어링 코드를 발급하거나 저장 링크를 만들 때 합니다. 저장형 스토리지는 보내는 쪽 요금제 한도를 쓰지만, 이는 사용량 집계일 뿐 전송별 요금이 아닙니다.",
      },
      {
        q: "relayium receive는 브라우저의 페어링 코드와 상호 운용되나요?",
        a: "네. 현재 relayium과 relayium.com의 앱·웹 페이지는 같은 페어링 코드를 쓰므로, relayium receive는 브라우저나 앱이 발급한 코드를 받을 수 있고 브라우저도 relayium send가 발급한 코드에 참여할 수 있습니다. 예전의 CLI 전용·직접 연결 전용 페어링으로 돌아가는 것은 이전 relayium CLI이거나 페어링 힌트 이전의 서버일 때뿐입니다.",
      },
      {
        q: "알 수 없는 기기가 내 serve 리스너로 푸시하면 어떻게 되나요?",
        a: "터미널에서는 첫 푸시 시 주소와 핑거프린트로 승인 여부를 묻고, 그 승인은 기억됩니다. 터미널이 없을 때——systemd 서비스나 cron 작업——물어볼 사람이 없으므로 알 수 없는 푸시하는 쪽은 거부됩니다. 먼저 relayium authorize <fingerprint>로 미리 승인하세요.",
      },
      {
        q: "관리하는 서버에서 파일을 가져올 수 있나요?",
        a: "relayium pull로는 안 됩니다. pull과 SSH 전송은 현재 CLI에서 폐지되었습니다. 이 기기에서 relayium serve를 실행하고 서버가 relayium push relayium://이-호스트 로 보내게 하거나, 서버에서 relayium up으로 올린 뒤 여기서 relayium down으로 링크를 가져오세요.",
      },
      {
        q: "relayium은 내 신원과 신뢰하는 상대를 어디에 저장하나요?",
        a: "기본적으로 ~/.config/relayium에 저장됩니다——신원이나 신뢰와 관련된 모든 명령에서 --config-dir로 이 위치를 재정의할 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "첫 전송을 받을 준비가 되셨나요? CLI를 설치하고 receive, serve, down 중 하나를 선택하세요.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien über die Kommandozeile empfangen",
  description:
    "Drei Wege, mit der Relayium CLI eine Datei zu empfangen: receive für einen netzwerkübergreifenden Pairing-Code-Versand, serve als lauschender Eingangskorb für Daemon-Direct-Pushes, oder down für einen gespeicherten verschlüsselten Link. Auf der Empfängerseite kein Konto.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Senden ist nur die halbe Geschichte — früher oder später bist du auf der Empfängerseite: Ein Kollege will dir eine Datei über das Internet übergeben, eine deiner eigenen Maschinen will sie an eine andere weiterreichen, oder jemand hat dir einen gespeicherten Link hinterlassen, den du abholst, wann es dir passt. Die Relayium CLI deckt alle drei Fälle mit jeweils einem eigenen Befehl ab, und auf der Empfängerseite braucht keiner davon ein Konto.",
    "Wähle receive, wenn jemand anderes per Pairing-Code an dich sendet, serve, wenn du einen dauerhaften Eingangskorb willst, zu dem vertrauenswürdige Maschinen jederzeit pushen können, und down, wenn der Absender dir einen gespeicherten verschlüsselten Link gegeben hat und vielleicht schon offline ist.",
  ],
  sections: [
    {
      heading: "Drei Wege zu empfangen, und wann welcher passt",
      body: [
        "Welchen Befehl du nutzt, hängt davon ab, wer die Übertragung startet und wie sich die beiden Maschinen kennen:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — jemand sendet dir netzwerkübergreifend mit einem Pairing-Code, den er erzeugt hat (mit der CLI, einer Relayium-App oder der Webseite) und dir außerhalb des Kanals mitgeteilt hat. Ende-zu-Ende verschlüsselt, über ein Relay, sobald der Server für den Code eines ausstellt, mit einem SAS-Code zum Vergleichen.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — diese Maschine lauscht auf Daemon-Direct-Pushes über relayium://, standardmäßig auf Port 9031.",
        "relayium down <link> [destdir] — einen gespeicherten Link abrufen und entschlüsseln; zum Herunterladen braucht es kein Konto (das frühere relayium pull über SSH ist eingestellt).",
      ],
    },
    {
      heading: "receive: jemand sendet dir eine Datei über Netzwerke hinweg",
      prereqs: {
        label: "Was du vor Schritt 1 brauchst",
        items: [
          "Die CLI auf diesem Rechner. relayium version gibt eine Versionszeile aus; antwortet die Shell mit command not found, ist sie hier noch nicht installiert.",
          "Einen Sender, der gerade angemeldet und gerade am Terminal ist. Nur er braucht ein Konto — zum Empfangen meldest du dich nie an.",
          "Die sechs Ziffern, über einen Nebenkanal. Sie leben fünf Minuten ab dem Moment, in dem seine CLI sie geprägt hat, also stimmt den Zeitpunkt vorher ab.",
          "Einen Weg, ihm danach sechs weitere Ziffern vorzulesen: der SAS wird laut verglichen, nicht auf dem Bildschirm.",
          "Die Gegenseite kann relayium send oder relayium pair, eine Relayium-App oder die Webseite sein — jede davon erzeugt einen Code, den du mit receive empfangen kannst.",
        ],
      },
      steps: [
        {
          text: "Stimm mit dem Sender ab, wann er send ausführt. Der Code läuft ab dem Prägen ab, nicht ab dem Moment, in dem du ihn bekommst.",
        },
        {
          text: "Nimm die sechs Ziffern über einen Kanal entgegen, dem ihr beide traut — ein Anruf, ein Chatfenster, der Raum, in dem ihr sitzt.",
        },
        {
          text: "Führ receive in dem Verzeichnis aus, in dem die Dateien landen sollen, oder gib eines explizit an.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Wenn beide Terminals einen Verifizierungscode zeigen, lies deinen laut vor und prüfe, ob er mit seinem übereinstimmt. Er ist nicht der Pairing-Code, und er ist das Einzige, was eine ausgetauschte Gegenstelle ausschließt.",
        },
        {
          text: "Lass das Terminal in Ruhe, bis es zur Eingabeaufforderung zurückkehrt. Das ist eine laufende Sitzung: schließt eine Seite, stoppt die Übertragung.",
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Empfang aus",
        body: [
          "Die path-Zeile zeigt, wie die Bytes laufen — relay oder, für Peer-to-Peer, direct / lan —, und beide Enden zeigen DENSELBEN Verifizierungscode. Abweichende Codes sind das eine Ergebnis, das du nicht akzeptieren darfst — halte an und kläre mit dem Absender, an welcher Maschine er sitzt.",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      body: [
        "Das ist die Empfangsseite von relayium send. Die andere Person führt auf ihrer Seite relayium send <path> aus (nach relayium login); ihre CLI erzeugt einen Code aus 6 Ziffern, gültig für 5 Minuten, und gibt ihn aus. Sie teilt ihn dir über einen Kanal mit, dem ihr beide vertraut — ein Anruf, eine Chatnachricht. Du führst receive mit diesem Code aus:",
      ],
      code: [
        `relayium receive 483920

# oder in ein bestimmtes Verzeichnis
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "Die Verbindung ist Ende-zu-Ende verschlüsselt; sobald sie steht, zeigen beide Enden denselben SAS (Short Authentication String). Vergleiche ihn außerhalb des Kanals mit dem Absender, um zu bestätigen, dass die angehefteten TLS-Zertifikatsfingerabdrücke nicht ausgetauscht wurden und der Rendezvous-Dienst keinen Endpunkt imitiert hat. Der SAS authentifiziert die Endpunkte, nicht jeden Netzwerk-Hop.",
        "Ohne angegebenes Ziel landen die Dateien im aktuellen Verzeichnis.",
        "Dieselbe Relay-Regel wie bei send: Stellt der Server für den Code ein Relay aus, läuft jedes Byte über dieses verschlüsselte Relay und zählt zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat — dem des Absenders, nie deinem. Nur ohne Relay verbinden sich die beiden Enden per Peer-to-Peer, und dann schlägt die Übertragung fehl, wenn kein direkter Weg existiert.",
        "Der Code ist derselbe Pairing-Code, den die Apps und die Webseite verwenden: Ein Absender auf relayium.com oder in einer Relayium-App kann dir einen Code vorlesen, den du hier empfängst, und einem von relayium send erzeugten Code kann man auch über die Webseite statt der CLI beitreten.",
        "Der Empfänger braucht auf keinem Netzwerk je ein Konto. Nur der Absender meldet sich an, damit dessen CLI den Code erzeugen kann.",
      ],
    },
    {
      heading: "serve: diese Maschine zu einem lauschenden Eingangskorb machen",
      steps: [
        {
          text: "Starte den Listener und nenne das Verzeichnis, in dem Pushes landen sollen.",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "Beim ersten Push eines neuen Rechners zeigt serve dessen Adresse und Fingerprint und fragt nach. Einmal freigegeben, laufen spätere Pushes desselben Fingerprints stumm durch.",
        },
        {
          text: "Soll dieser Listener ohne Terminal laufen, verlass dich nicht auf die Abfrage — niemand kann sie beantworten, und ein unbekannter Sender wird schlicht abgewiesen. Nimm stattdessen die Vorab-Freigabe aus dem nächsten Abschnitt.",
        },
      ],
      body: [
        "serve funktioniert umgekehrt: Statt dass du selbst aktiv wirst, pushen andere Maschinen direkt zu dir über relayium:// — gebaut für Maschinen, denen du schon vertraust, etwa dein eigener Laptop, der zu einem NAS pusht, oder ein Build-Server, der Artefakte auf einer Maschine ablegt, die dir gehört — über eine TLS-1.3-Verbindung mit Pinning, ohne SSH, ohne Rendezvous.",
      ],
      code: [
        `relayium serve

# ein bestimmtes Verzeichnis, ein bestimmter Port, Löschanfragen erlaubt
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "Wenn eine neue Maschine zum ersten Mal zu dir pusht, zeigt dir serve (in einem Terminal laufend) ihre Adresse und ihren Fingerprint und bittet dich, sie einmalig zu genehmigen; danach laufen Pushes vom selben Fingerprint stillschweigend durch.",
        "Ohne Terminal — ein systemd-Dienst, ein Skript ohne TTY — gibt es niemanden, den man fragen könnte, also wird ein unbekannter Pusher rundheraus abgelehnt. Genehmige ihn stattdessen im Voraus, mit dem Fingerprint, den der Pusher via relayium id ausgibt:",
      ],
    },
    {
      heading: "Vorab genehmigen für unbeaufsichtigtes serve",
      body: [
        "Für ein serve, das unbeaufsichtigt läuft (systemd, ein Hintergrundskript), lass den Pusher relayium id ausführen, um seinen Fingerprint auszugeben, und genehmige ihn dann von der Empfängerseite aus im Voraus:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir legt fest, wo Dateien landen (Standard: das aktuelle Verzeichnis); --once nimmt eine einzelne Übertragung an und beendet sich; --allow-delete erlaubt es einer eingehenden --delete-Anfrage (Spiegelung), hier tatsächlich Dateien zu löschen, und ist standardmäßig aus.",
        "--config-dir (Standard ~/.config/relayium) ist der Ort, an dem die Identität dieses Hosts und seine Liste genehmigter Fingerprints liegen — überschreibe ihn, wenn du serve als dedizierten Dienst betreibst.",
      ],
    },
    {
      heading: "pull (SSH): eingestellt",
      body: [sshRetiredNotice.de, "Um etwas von einem Server zu holen, den du verwaltest, lade es dort mit relayium up hoch und führe hier relayium down mit dem Link aus — oder starte relayium serve auf diesem Rechner und lass den Server an relayium://dieser-host pushen."],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
    },
    {
      heading: "Wenn es nicht funktioniert",
      body: [
        "Fünf Fehler decken fast jeden misslungenen Empfang ab. Welcher Befehl lief, entscheidet, welcher davon greift, und zu jedem gibt es eine Zeile zum Lesen oder einen Befehl zum Ausführen.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Du gibst den Code ein und der Rendezvous weist ihn ab.",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "Fast immer sind die fünf Minuten um — der Code verfällt ab dem Prägen durch die CLI des Senders, nicht ab dem Moment, in dem du ihn erfahren hast. Lass ihn send erneut ausführen und dir die frischen Ziffern sofort vorlesen. Eine vertippte Ziffer sieht von hier aus identisch aus, also lies sie zurück, bevor du auf Ablauf tippst.",
          },
          {
            symptom: "Die Übertragung läuft durch, aber du findest die Dateien nicht.",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "Ohne Zielangabe schreibt receive in das Verzeichnis, aus dem du es gestartet hast — selten das, in dem du gesucht hast. Gib eines explizit an, oder führ vorher pwd aus.",
          },
          {
            symptom: "Es scheitert mit \"no direct connection to the peer (both ends behind strict NAT?)\".",
            code: [
              `relayium receive 483920
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Ein Ende nutzt ein älteres relayium, dessen Pairing nur direkt verbindet, und keine Seite hat die andere erreicht. Aktualisiere beide Enden: Ein aktuelles relayium läuft über das verschlüsselte Relay, sobald der Server für den Code eines ausstellt. Sonst bring ein Ende in ein Netz mit erreichbarer Adresse — einen Server oder einen Handy-Hotspot — oder lade die Datei mit relayium up hoch und gib stattdessen den Download-Link weiter.",
          },
          {
            symptom: "down meldet, der Link sei ungültig oder die Datei lasse sich nicht entschlüsseln.",
            code: [
              "relayium down '<link-without-fragment>' ./downloads\n# invalid link or missing key",
            ],
            fix: "Kopiere den ganzen Link erneut, einschließlich #k=. Das Fragment ist der einzige Entschlüsselungsschlüssel; fehlt es, kann der Server ihn nicht wiederherstellen.",
          },
          {
            symptom: "Ein Rechner pusht an deinen serve-Listener und wird abgewiesen, ohne dass du je gefragt wurdest.",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "Die Abfrage existiert nur, wenn serve ein Terminal hat. Unter systemd, in einem Skript oder hinter einer Pipe ist niemand da, also wird ein unbekannter Fingerprint direkt abgelehnt. Lass den Sender relayium id ausführen und gib ihn hier mit relayium authorize <Fingerprint> frei — mit demselben --config-dir, unter dem der Listener läuft.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Brauche ich ein Konto, um Dateien zu empfangen?",
        a: "Nein. receive und serve brauchen auf deiner Seite kein Konto, und down braucht nur den Link. Anmelden muss sich der Absender, um einen receive-Pairing-Code zu erzeugen oder einen gespeicherten Link anzulegen. Gehosteter Speicher verbraucht das Tarifkontingent des Absenders — das ist Nutzungserfassung, keine Gebühr pro Übertragung.",
      },
      {
        q: "Arbeitet relayium receive mit dem Pairing-Code des Browsers zusammen?",
        a: "Ja. Ein aktuelles relayium und die Apps und die Webseite auf relayium.com verwenden dieselben Pairing-Codes, sodass relayium receive einen im Browser oder in einer App erzeugten Code annehmen und ein Browser einem von relayium send erzeugten Code beitreten kann. Nur eine ältere relayium-CLI oder ein Server, der älter als die Pairing-Hinweise ist, fällt auf das alte, nur zwischen CLIs und nur direkt funktionierende Pairing zurück.",
      },
      {
        q: "Was passiert, wenn eine unbekannte Maschine zu meinem serve-Listener pusht?",
        a: "In einem Terminal wirst du bei ihrem ersten Push aufgefordert, sie anhand von Adresse und Fingerprint zu genehmigen, und die Genehmigung wird gespeichert. Ohne Terminal — ein systemd-Dienst, ein Cron-Job — gibt es niemanden, den man fragen könnte, also wird ein unbekannter Pusher abgelehnt; genehmige ihn vorher mit relayium authorize <fingerprint>.",
      },
      {
        q: "Kann ich Dateien von einem Server holen, den ich verwalte?",
        a: "Nicht mit relayium pull: Es ist, wie SSH-Übertragungen, in der aktuellen CLI eingestellt. Starte relayium serve auf diesem Rechner und lass den Server mit relayium push relayium://dieser-host daran senden, oder lade es auf dem Server mit relayium up hoch und hole den Link hier mit relayium down.",
      },
      {
        q: "Wo speichert relayium meine Identität und vertrauenswürdige Gegenstellen?",
        a: "Standardmäßig in ~/.config/relayium — überschreibe den Ort mit --config-dir bei jedem Befehl, der mit Identität oder Vertrauen zu tun hat.",
      },
    ],
  },
  cta: {
    text: "Bereit für deine erste Übertragung? Installiere die CLI und wähle receive, serve oder down.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Recevoir des fichiers depuis la ligne de commande",
  description:
    "Trois façons de recevoir un fichier avec la CLI Relayium : receive pour un envoi par code d'appairage entre réseaux, serve comme boîte de réception à l'écoute des envois en daemon direct, ou down pour un lien chiffré stocké. Aucun compte côté réception.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Envoyer n'est que la moitié de l'histoire — tôt ou tard, c'est vous qui recevez : un collègue veut vous remettre un fichier par Internet, l'une de vos machines veut le transmettre à une autre, ou quelqu'un vous a laissé un lien stocké à récupérer quand vous le voudrez. La CLI Relayium couvre ces trois cas avec une commande différente pour chacun, et aucune ne nécessite de compte côté réception.",
    "Choisissez receive quand quelqu'un d'autre vous envoie via un code d'appairage, serve quand vous voulez une boîte de réception permanente vers laquelle des machines de confiance peuvent envoyer à tout moment, et down quand l'expéditeur vous a donné un lien chiffré stocké et n'est peut-être déjà plus en ligne.",
  ],
  sections: [
    {
      heading: "Trois façons de recevoir, et quand utiliser chacune",
      body: [
        "La commande à exécuter dépend de qui déclenche le transfert et de la façon dont les deux machines se connaissent :",
      ],
      bullets: [
        "relayium receive <code> [destdir] — quelqu'un vous envoie à travers les réseaux avec un code d'appairage qu'il a généré (avec la CLI, une application Relayium ou la page web) et vous a communiqué hors bande. Chiffré de bout en bout, relayé dès que le serveur attribue un relais pour le code, avec un code SAS à comparer.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — cette machine écoute les envois en daemon direct via relayium://, sur le port 9031 par défaut.",
        "relayium down <link> [destdir] — récupérer et déchiffrer un lien stocké ; aucun compte n'est requis pour télécharger (l'ancien relayium pull via SSH est retiré).",
      ],
    },
    {
      heading: "receive : quelqu'un vous envoie un fichier à travers les réseaux",
      prereqs: {
        label: "Ce qu'il vous faut avant l'étape 1",
        items: [
          "La CLI sur cette machine. relayium version affiche un numéro de version ; si le shell répond command not found, elle n'y est pas encore installée.",
          "Un expéditeur connecté et devant son terminal maintenant. Lui seul a besoin d'un compte — vous ne vous connectez jamais pour recevoir.",
          "Les six chiffres, transmis hors bande. Ils vivent cinq minutes à partir du moment où sa CLI les a générés, alors convenez d'abord du moment.",
          "Un moyen de lui relire six autres chiffres ensuite : le SAS se compare à voix haute, pas à l'écran.",
          "L'autre bout peut être relayium send ou relayium pair, une application Relayium ou la page web — chacun génère un code que vous pouvez recevoir avec receive.",
        ],
      },
      steps: [
        {
          text: "Convenez avec l'expéditeur du moment où il lancera send. Le code commence à expirer dès sa génération, pas dès que vous le recevez.",
        },
        {
          text: "Récupérez les six chiffres par un canal auquel vous faites confiance tous les deux — un appel, une fenêtre de discussion, la pièce où vous êtes.",
        },
        {
          text: "Lancez receive depuis le répertoire où les fichiers doivent atterrir, ou indiquez-en un explicitement.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Quand les deux terminaux affichent un code de vérification, lisez le vôtre à voix haute et vérifiez qu'il correspond au sien. Ce n'est pas le code d'appairage, et c'est la seule chose qui écarte une extrémité substituée.",
        },
        {
          text: "Ne touchez plus au terminal jusqu'à ce qu'il revienne à l'invite. C'est une session en direct : fermer l'une des extrémités arrête le transfert.",
        },
      ],
      success: {
        label: "À quoi ressemble une réception réussie",
        body: [
          "La ligne path indique le chemin des octets — relay, ou direct / lan pour le pair-à-pair — et les deux extrémités affichent le MÊME code de vérification. Des codes différents sont le seul résultat à ne jamais accepter — arrêtez-vous et vérifiez avec l'expéditeur sur quelle machine il se trouve.",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      body: [
        "C'est le pendant côté réception de relayium send. L'autre personne exécute relayium send <path> de son côté (après relayium login) ; sa CLI génère un code de 6 chiffres, valable 5 minutes, et l'affiche. Elle vous le communique par un canal auquel vous faites tous deux confiance — un appel, un message. Vous exécutez receive avec ce code :",
      ],
      code: [
        `relayium receive 483920

# ou vers un répertoire précis
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "La connexion est chiffrée de bout en bout ; une fois connectées, les deux extrémités affichent le même SAS (short authentication string). Comparez-le hors bande avec l'expéditeur pour confirmer que les empreintes des certificats TLS épinglés n'ont pas été substituées et que le service de rendez-vous n'a usurpé aucune extrémité. Le SAS authentifie les extrémités ; il ne prouve pas chaque saut réseau.",
        "Sans destination indiquée, les fichiers atterrissent dans le répertoire courant.",
        "Même règle de relais que send : dès que le serveur attribue un relais pour le code, chaque octet passe par ce relais chiffré et est décompté du quota mensuel de trafic du compte qui a généré le code — celui de l'expéditeur, jamais le vôtre. Ce n'est que sans relais que les deux extrémités se connectent en pair-à-pair, et le transfert échoue alors s'il n'existe aucun chemin direct.",
        "Le code est le même code d'appairage que celui des applications et de la page web : un expéditeur sur relayium.com ou dans une application Relayium peut vous lire un code que vous recevez ici, et un code généré par relayium send peut être rejoint depuis la page web plutôt que depuis la CLI.",
        "Le destinataire n'a jamais besoin de compte, quel que soit le réseau. Seul l'expéditeur se connecte, pour que sa CLI puisse générer le code.",
      ],
    },
    {
      heading: "serve : transformer cette machine en boîte de réception à l'écoute",
      steps: [
        {
          text: "Démarrez l'écouteur en nommant le répertoire où les envois doivent atterrir.",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "Au premier envoi d'une machine inconnue, serve affiche son adresse et son empreinte et vous demande confirmation. Une fois approuvée, les envois suivants de cette empreinte passent sans rien dire.",
        },
        {
          text: "Si cet écouteur doit tourner sans terminal, ne comptez pas sur cette demande — personne n'est là pour y répondre, et un expéditeur non reconnu est refusé d'emblée. Utilisez plutôt l'autorisation préalable décrite à la section suivante.",
        },
      ],
      body: [
        "serve fonctionne dans l'autre sens : au lieu que vous alliez chercher, d'autres machines vous envoient directement via relayium:// — conçu pour des machines en qui vous avez déjà confiance, comme votre propre ordinateur portable qui envoie vers un NAS, ou un serveur de build qui dépose des artefacts sur une machine qui vous appartient — via une connexion TLS 1.3 avec épinglage, sans SSH, sans rendez-vous.",
      ],
      code: [
        `relayium serve

# un répertoire et un port précis, en autorisant les requêtes de suppression
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "La première fois qu'une nouvelle machine vous envoie quelque chose, serve (exécuté dans un terminal) affiche son adresse et son empreinte et vous demande de l'approuver une fois ; ensuite, les envois de la même empreinte passent silencieusement.",
        "Sans terminal — un service systemd, un script sans TTY — il n'y a personne à qui demander, donc un émetteur inconnu est rejeté d'emblée. Autorisez-le plutôt à l'avance, en utilisant l'empreinte que l'émetteur affiche avec relayium id :",
      ],
    },
    {
      heading: "Autoriser à l'avance pour un serve sans surveillance",
      body: [
        "Pour un serve qui tourne sans surveillance (systemd, un script en arrière-plan), demandez à l'émetteur d'exécuter relayium id pour afficher son empreinte, puis approuvez-la à l'avance côté récepteur :",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir définit où les fichiers atterrissent (par défaut le répertoire courant) ; --once accepte un seul transfert puis s'arrête ; --allow-delete permet à une requête --delete (miroir) entrante de réellement supprimer des fichiers ici, et est désactivé par défaut.",
        "--config-dir (par défaut ~/.config/relayium) est l'endroit où se trouvent l'identité de cet hôte et sa liste d'empreintes autorisées — surchargez-le si vous exécutez serve comme service dédié.",
      ],
    },
    {
      heading: "pull (SSH) : retiré",
      body: [sshRetiredNotice.fr, "Pour récupérer quelque chose depuis un serveur que vous administrez, téléversez-le depuis le serveur avec relayium up et lancez ici relayium down avec le lien — ou lancez relayium serve sur cette machine et faites pousser le serveur vers relayium://cet-hôte."],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
    },
    {
      heading: "Quand ça ne marche pas",
      body: [
        "Cinq pannes couvrent presque toutes les réceptions ratées. La commande que vous exécutiez détermine laquelle s'applique, et chacune se tranche par une ligne à lire ou une commande à exécuter.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Vous saisissez le code et le rendez-vous le refuse.",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "Presque toujours les cinq minutes sont écoulées — le code expire à partir de sa génération par la CLI de l'expéditeur, pas à partir du moment où on vous l'a donné. Demandez-lui de relancer send et de vous lire les chiffres frais dans la foulée. Un chiffre mal tapé est indiscernable d'ici, alors relisez-le-lui avant de conclure à l'expiration.",
          },
          {
            symptom: "Le transfert se termine mais vous ne trouvez pas les fichiers.",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "Sans destination, receive écrit dans le répertoire depuis lequel vous l'avez lancé, rarement celui où vous cherchiez. Indiquez-en un explicitement, ou lancez pwd d'abord.",
          },
          {
            symptom: "Il échoue avec « no direct connection to the peer (both ends behind strict NAT?) ».",
            code: [
              `relayium receive 483920
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Une extrémité utilise un ancien relayium dont l'appairage est uniquement direct, et aucune n'a pu atteindre l'autre. Mettez les deux à jour : un relayium actuel passe par le relais chiffré dès que le serveur en attribue un pour le code. Sinon, déplacez une extrémité vers un réseau doté d'une adresse joignable — un serveur, ou un partage de connexion mobile — ou téléversez le fichier avec relayium up et transmettez plutôt le lien de téléchargement.",
          },
          {
            symptom: "down indique que le lien est invalide ou qu'il ne peut pas déchiffrer le fichier.",
            code: [
              "relayium down '<link-without-fragment>' ./downloads\n# invalid link or missing key",
            ],
            fix: "Recopiez le lien entier, y compris #k=. Le fragment est la seule clé de déchiffrement ; s'il a été omis, le serveur ne peut pas le reconstituer.",
          },
          {
            symptom: "Une machine pousse vers votre écouteur serve et se fait refuser sans qu'on vous ait jamais demandé quoi que ce soit.",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "Cette demande n'existe que si serve dispose d'un terminal. Sous systemd, dans un script ou derrière un tube, il n'y a personne à qui demander, donc une empreinte inconnue est refusée d'emblée. Faites exécuter relayium id à l'expéditeur et autorisez-la ici avec relayium authorize <empreinte>, sous le même --config-dir que l'écouteur.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Ai-je besoin d'un compte pour recevoir des fichiers ?",
        a: "Non. receive et serve ne demandent aucun compte de votre côté, et down n'a besoin que du lien. C'est l'expéditeur qui se connecte, pour générer un code d'appairage receive ou créer un lien stocké. Le stockage hébergé consomme le quota de l'offre de l'expéditeur, ce qui relève de la comptabilisation de l'usage et non d'un paiement par transfert.",
      },
      {
        q: "relayium receive est-il interopérable avec le code d'appairage du navigateur ?",
        a: "Oui. Un relayium actuel et les applications et la page web de relayium.com utilisent les mêmes codes d'appairage : relayium receive peut accepter un code généré dans un navigateur ou une application, et un navigateur peut rejoindre un code généré par relayium send. Seule une ancienne CLI relayium, ou un serveur antérieur aux indications d'appairage, revient à l'ancien appairage réservé à la CLI et uniquement direct.",
      },
      {
        q: "Que se passe-t-il si une machine inconnue envoie vers mon processus serve à l'écoute ?",
        a: "Dans un terminal, on vous demande de l'approuver par son adresse et son empreinte lors de son premier envoi, et l'approbation est mémorisée. Sans terminal — un service systemd, une tâche cron — il n'y a personne à qui demander, donc un émetteur inconnu est rejeté ; autorisez-le d'abord avec relayium authorize <fingerprint>.",
      },
      {
        q: "Puis-je récupérer des fichiers depuis un serveur que j'administre ?",
        a: "Pas avec relayium pull : lui et les transferts SSH sont retirés de la CLI actuelle. Lancez relayium serve sur cette machine et faites envoyer le serveur avec relayium push relayium://cet-hôte, ou téléversez depuis le serveur avec relayium up et récupérez le lien ici avec relayium down.",
      },
      {
        q: "Où relayium conserve-t-il mon identité et les pairs de confiance ?",
        a: "Par défaut dans ~/.config/relayium — surchargez cet emplacement avec --config-dir sur toute commande touchant à l'identité ou à la confiance.",
      },
    ],
  },
  cta: {
    text: "Prêt à recevoir votre premier transfert ? Installez la CLI et choisissez receive, serve ou down.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "استقبال الملفات من سطر الأوامر",
  description:
    "ثلاث طرق لاستقبال ملف باستخدام Relayium CLI: استقبال إرسال برمز اقتران عبر الشبكات باستخدام receive، أو العمل كصندوق وارد مُستمِع لعمليات الدفع daemon direct باستخدام serve، أو جلب رابط مُشفَّر مُخزَّن باستخدام down. بلا حساب في جهة الاستقبال.",
  updatedLabel: "آخر تحديث",
  lead: [
    "الإرسال نصف القصة فقط — عاجلًا أم آجلًا ستكون أنت في الطرف المُستقبِل: زميل يريد أن يسلّمك ملفًا عبر الإنترنت، أو أحد أجهزتك يريد أن يمرّره إلى آخر، أو ترك لك أحدهم رابطًا مُخزَّنًا لتجلبه متى شئت. يغطي Relayium CLI الحالات الثلاث بأمر مختلف لكلٍّ منها، ولا تحتاج أيٌّ منها حسابًا في جهة الاستقبال.",
    "اختر receive حين يرسل إليك شخص آخر برمز اقتران، وserve حين تريد صندوق وارد دائمًا تستطيع الأجهزة الموثوقة الدفع إليه في أي وقت، وdown حين أعطاك المُرسِل رابطًا مُشفَّرًا مُخزَّنًا وقد يكون غير متصل بالفعل.",
  ],
  sections: [
    {
      heading: "ثلاث طرق للاستقبال، ومتى تنطبق كل منها",
      body: [
        "الأمر الذي تشغّله يعتمد على من يبدأ النقل وكيف يعرف الجهازان أحدهما الآخر:",
      ],
      bullets: [
        "‏‎relayium receive <code> [destdir]‎ — يرسل إليك شخص عبر الشبكات باستخدام رمز اقتران أصدره (من CLI أو تطبيق Relayium أو صفحة الويب) ثم أبلغك به خارج القناة. مُشفَّر من الطرف إلى الطرف، ويمر عبر مُرحِّل كلما أصدره الخادم للرمز، مع رمز SAS يمكنك مقارنته.",
        "‏‎relayium serve [--dir D] [--port N] [--once] [--allow-delete]‎ — يستمع هذا الجهاز لعمليات الدفع daemon direct عبر relayium://، على المنفذ 9031 افتراضيًا.",
        "‏‎relayium down <link> [destdir]‎ — جلب رابط مُخزَّن وفك تشفيره؛ لا حاجة إلى حساب للتنزيل (أما relayium pull القديم عبر SSH فقد أُوقف).",
      ],
    },
    {
      heading: "receive: شخص يرسل إليك ملفًا عبر الشبكات",
      prereqs: {
        label: "ما تحتاجه قبل الخطوة 1",
        items: [
          "الـ CLI على هذا الجهاز. يطبع relayium version سطر إصدار، وإذا ردّت الصدفة بـ command not found فهو غير مثبَّت هنا بعد.",
          "مرسِل مسجَّل الدخول وجالس أمام طرفيته الآن. وهو وحده من يحتاج حسابًا — أما أنت فلا تسجّل الدخول للاستقبال إطلاقًا.",
          "الأرقام الستة، تصلك عبر قناة خارجة عن المسار. وهي تعيش خمس دقائق من لحظة توليد الـ CLI لديه لها، فاتفقا على اللحظة أولًا.",
          "وسيلة تقرأ بها ستة أرقام أخرى عليه بعد ذلك: فالـ SAS يُقارَن نطقًا لا على الشاشة.",
          "يمكن أن يكون الطرف الآخر relayium send أو relayium pair أو تطبيق Relayium أو صفحة الويب — فكلٌّ منها يُصدر رمزًا يمكنك استقباله بـ receive.",
        ],
      },
      steps: [
        {
          text: "اتفق مع المرسِل على موعد تشغيله لـ send. فالرمز يبدأ بالانتهاء من لحظة توليده لا من لحظة وصوله إليك.",
        },
        {
          text: "خذ الأرقام الستة عبر قناة يثق بها كلاكما — مكالمة، أو نافذة محادثة، أو الغرفة التي تجلسان فيها.",
        },
        {
          text: "شغّل receive من الدليل الذي يُفترض أن تصل إليه الملفات، أو سمِّ دليلًا صراحةً.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "حين تطبع الطرفيتان رمز تحقّق، اقرأ رمزك بصوت مسموع وتأكّد أنه يطابق رمزه. إنه ليس رمز الاقتران، وهو الشيء الوحيد الذي يستبعد استبدال الطرف المقابل.",
        },
        {
          text: "اترك الطرفية وشأنها حتى تعود إلى المحث. فهذه جلسة حيّة واحدة: إغلاق أي طرف يوقف النقل.",
        },
      ],
      success: {
        label: "كيف يبدو استقبال ناجح",
        body: [
          "يبيّن سطر path كيف تنتقل البايتات — relay، أو direct / lan للاتصال من نظير إلى نظير — ويعرض الطرفان رمز التحقق نفسه. والرموز المختلفة هي النتيجة الوحيدة التي يجب ألّا تقبلها — توقّف وتحقّق مع المُرسِل من الجهاز الذي يعمل عليه.",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      body: [
        "هذا هو نصف الاستقبال من relayium send. يشغّل الطرف الآخر ‎relayium send <path>‎ من جهته (بعد relayium login)، فتُصدر واجهة CLI لديه رمزًا من 6 أرقام صالحًا لـ 5 دقائق وتطبعه. ثم يخبرك به عبر أي قناة تثقان بها كلاكما — مكالمة، رسالة محادثة. تشغّل أنت receive بذلك الرمز:",
      ],
      code: [
        `relayium receive 483920

# أو إلى مجلد محدد
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "الاتصال مُشفَّر من الطرف إلى الطرف؛ وبمجرد الاتصال يعرض الطرفان رمز SAS (سلسلة مصادقة قصيرة) نفسه. قارنه مع المُرسِل خارج القناة لتتأكد من أن بصمات شهادات TLS المثبّتة لم تُستبدل وأن خدمة الالتقاء لم تنتحل شخصية أي طرف. يصادق SAS على الطرفين، لا على كل قفزة في مسار الشبكة.",
        "بلا وجهة محددة: تصل الملفات إلى المجلد الحالي.",
        "قاعدة الترحيل نفسها كما في send: كلما أصدر الخادم مُرحِّلًا للرمز مرّ كل بايت عبر هذا المُرحِّل المُشفَّر واحتُسب ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز — حساب المُرسِل، لا حسابك أبدًا. ولا يتصل الطرفان من نظير إلى نظير إلا حين لا يصدر مُرحِّل، وعندها يفشل النقل إن لم يوجد مسار مباشر.",
        "الرمز هو رمز الاقتران نفسه الذي تستخدمه التطبيقات وصفحة الويب: يمكن لمُرسِل على relayium.com أو في تطبيق Relayium أن يقرأ لك رمزًا تستقبله هنا، ويمكن الانضمام إلى رمز أصدره relayium send من صفحة الويب بدلًا من CLI.",
        "المُستقبِل لا يحتاج حسابًا أبدًا، على أي شبكة. المُرسِل وحده هو من يسجّل الدخول، كي تتمكن واجهة CLI لديه من إصدار الرمز.",
      ],
    },
    {
      heading: "serve: حوّل هذا الجهاز إلى صندوق وارد مُستمِع",
      steps: [
        {
          text: "شغّل المُنصِت مع تسمية الدليل الذي ستصل إليه الدفعات.",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "عند أول دفعة من جهاز جديد، يعرض serve عنوانه وبصمته ويسألك. وافق مرة واحدة، فتمر الدفعات التالية من البصمة نفسها بصمت.",
        },
        {
          text: "إن كان هذا المُنصِت سيعمل بلا طرفية، فلا تعتمد على ذلك السؤال — لا أحد هناك ليجيب عنه، والمرسِل غير المعروف يُرفَض من فوره. استخدم بدلًا من ذلك التصريح المسبق الموصوف في القسم التالي.",
        },
      ],
      body: [
        "يعمل serve بالعكس: بدل أن تمدّ يدك أنت، تدفع أجهزة أخرى إليك مباشرةً عبر relayium:// — مصمَّم للأجهزة التي تثق بها أصلًا، مثل حاسوبك المحمول يدفع إلى NAS، أو خادم بناء يُسقط منتجاته على جهاز تملكه — عبر اتصال TLS 1.3 مثبَّت، بلا SSH وبلا تعارف.",
      ],
      code: [
        `relayium serve

# مجلد ومنفذ محددان، مع السماح بطلبات الحذف
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "أول مرة يدفع إليك جهاز جديد، يعرض serve (عند تشغيله في طرفية) عنوانه وبصمته ويطلب منك الموافقة عليه مرة واحدة؛ بعد ذلك تمر عمليات الدفع من البصمة نفسها بصمت.",
        "بلا طرفية — خدمة systemd، برنامج نصي بلا TTY — لا أحد ليُسأل، فيُرفض الطرف الدافع غير المعروف فورًا. بدلًا من ذلك، امنحه الإذن مسبقًا باستخدام البصمة التي يطبعها الطرف الدافع بـ relayium id:",
      ],
    },
    {
      heading: "منح الإذن مسبقًا لـ serve دون إشراف",
      body: [
        "لتشغيل serve دون إشراف (systemd، برنامج نصي في الخلفية)، اجعل الطرف الدافع يشغّل relayium id لطباعة بصمته، ثم امنحها الإذن مسبقًا من جهة الاستقبال:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "‏--dir يحدّد أين تصل الملفات (الافتراضي هو المجلد الحالي)؛ ‏--once يقبل نقلًا واحدًا ثم يخرج؛ ‏--allow-delete يتيح لطلب --delete (المرآة) الوارد أن يزيل الملفات فعلًا هنا، وهو معطّل افتراضيًا.",
        "‏--config-dir (الافتراضي ~/.config/relayium) هو مكان هوية هذا المضيف وقائمة بصماته المُصرَّح بها — تجاوزه إن كنت تشغّل serve كخدمة مخصّصة.",
      ],
    },
    {
      heading: "‏pull ‏(SSH): أُوقف",
      body: [sshRetiredNotice.ar, "لجلب شيء من خادم تديره، ارفعه من الخادم بـ relayium up وشغّل هنا relayium down بالرابط — أو شغّل relayium serve على هذا الجهاز واجعل الخادم يدفعه بـ push إلى relayium://this-host."],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
    },
    {
      heading: "حين لا ينجح الأمر",
      body: [
        "خمسة إخفاقات تغطي تقريبًا كل استقبال فاشل. والأمر الذي كنت تشغّله يحدّد أيها ينطبق، ولكلٍّ منها سطر تقرؤه أو أمر تشغّله يحسم المسألة.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "تُدخِل الرمز فيرفضه خادم اللقاء.",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "غالبًا انقضت الدقائق الخمس — فالرمز ينتهي ابتداءً من لحظة توليد الـ CLI لدى المرسِل له، لا من لحظة إخبارك به. اطلب منه تشغيل send مرة أخرى وقراءة الأرقام الجديدة عليك فورًا. وخطأ رقم واحد يبدو من هنا مطابقًا تمامًا، فأعد قراءة الرمز عليه قبل أن تفترض أنه انتهى.",
          },
          {
            symptom: "يكتمل النقل لكنك لا تجد الملفات.",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "من دون تحديد وجهة، يكتب receive في الدليل الذي شغّلته منه، وهو نادرًا ما يكون المكان الذي بحثت فيه. حدّد دليلًا صراحةً، أو شغّل pwd أولًا لتتيقّن.",
          },
          {
            symptom: "يفشل برسالة «no direct connection to the peer (both ends behind strict NAT?)».",
            code: [
              `relayium receive 483920
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "يستخدم أحد الطرفين إصدارًا أقدم من relayium اقترانه مباشر فقط، ولم يستطع أي منهما الوصول إلى الآخر. حدّث الطرفين: فالإصدار الحالي من relayium يمر عبر المُرحِّل المُشفَّر كلما أصدر الخادم مُرحِّلًا للرمز. وإلا فانقل أحد الطرفين إلى شبكة ذات عنوان يمكن الوصول إليه — خادم، أو نقطة اتصال من الهاتف — أو ارفع الملف بـ relayium up ومرِّر رابط التنزيل بدلًا من ذلك.",
          },
          {
            symptom: "يقول down إن الرابط غير صالح أو إنه لا يستطيع فك تشفير الملف.",
            code: [
              "relayium down '<link-without-fragment>' ./downloads\n# invalid link or missing key",
            ],
            fix: "انسخ الرابط كاملًا مرة أخرى، بما في ذلك #k=. فهذا الجزء هو مفتاح فك التشفير الوحيد، ولا يستطيع الخادم إعادة بنائه إن حُذف.",
          },
          {
            symptom: "جهاز يدفع إلى مُنصِت serve لديك فيُرفَض دون أن تُسأل قط.",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "ذلك السؤال لا يوجد إلا حين تكون لـ serve طرفية. أما تحت systemd أو داخل سكربت أو خلف أنبوب فلا أحد ليُسأل، فتُرفَض البصمة المجهولة من فورها. اطلب من المرسِل تشغيل relayium id، وصرّح لها هنا بـ relayium authorize <البصمة>، بالـ ‎--config-dir‎ نفسه الذي يعمل به المُنصِت.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج حسابًا لاستقبال الملفات؟",
        a: "لا. لا يحتاج receive وserve إلى حساب من جهتك، ولا يحتاج down إلا إلى الرابط. أما تسجيل الدخول فيقوم به المُرسِل لإصدار رمز اقتران لـ receive أو لإنشاء رابط مُخزَّن. ويستهلك التخزين المُستضاف حصة خطة المُرسِل، وهذا احتساب للاستخدام لا رسم على كل عملية نقل.",
      },
      {
        q: "هل يتوافق relayium receive مع رمز اقتران المتصفح؟",
        a: "نعم. يستخدم الإصدار الحالي من relayium والتطبيقات وصفحة الويب على relayium.com رموز الاقتران نفسها، فيستطيع relayium receive استقبال رمز أصدره متصفّح أو تطبيق، ويستطيع المتصفّح الانضمام إلى رمز أصدره relayium send. ولا يعود إلى الاقتران القديم المقتصر على CLI والمباشر فقط إلا إصدار أقدم من relayium CLI أو خادم يسبق تلميحات الاقتران.",
      },
      {
        q: "ماذا يحدث إذا دفع جهاز غير معروف إلى مُستمِع serve لديّ؟",
        a: "في الطرفية، يُطلب منك الموافقة عليه بعنوانه وبصمته عند أول دفعة، وتُحفَظ الموافقة. بلا طرفية — خدمة systemd، مهمة cron — لا أحد ليُسأل، فيُرفض الطرف الدافع غير المعروف؛ امنحه الإذن مسبقًا أولًا بـ ‎relayium authorize <fingerprint>‎.",
      },
      {
        q: "هل يمكنني جلب ملفات من خادم أديره؟",
        a: "ليس باستخدام relayium pull: فقد أُوقف هو وعمليات النقل عبر SSH في CLI الحالي. شغّل relayium serve على هذا الجهاز واجعل الخادم يرسل إليه بـ relayium push relayium://this-host، أو ارفع من الخادم بـ relayium up واجلب الرابط هنا بـ relayium down.",
      },
      {
        q: "أين يحفظ relayium هويتي والأقران الموثوقين؟",
        a: "في ~/.config/relayium افتراضيًا — تجاوز الموقع بـ --config-dir في أي أمر يمسّ الهوية أو الثقة.",
      },
    ],
  },
  cta: {
    text: "مستعد لاستقبال نقلك الأول؟ ثبّت الـ CLI واختر receive أو serve أو down.",
    button: "احصل على الـ CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Recibir archivos desde la línea de comandos",
  description:
    "Tres formas de recibir un archivo con la CLI de Relayium: recibir un envío entre redes por código de emparejamiento, actuar como buzón a la escucha para envíos en daemon directo, o descargar un enlace cifrado almacenado con down. Sin cuenta en el lado que recibe.",
  updatedLabel: "Última actualización",
  lead: [
    "Enviar es solo la mitad de la historia — tarde o temprano estás en el extremo receptor: un colega quiere entregarte un archivo por internet, una de tus propias máquinas quiere pasárselo a otra, o alguien te dejó un enlace almacenado para descargarlo cuando te venga bien. La CLI de Relayium cubre los tres casos con un comando distinto para cada uno, y ninguno necesita cuenta en el lado que recibe.",
    "Elige receive cuando alguien te envía por código de emparejamiento, serve cuando quieres un buzón permanente al que máquinas de confianza puedan enviar en cualquier momento, y down cuando el remitente te dio un enlace cifrado almacenado y quizá ya esté desconectado.",
  ],
  sections: [
    {
      heading: "Tres formas de recibir, y cuándo aplica cada una",
      body: [
        "Qué comando ejecutas depende de quién inicia la transferencia y de cómo se conocen las dos máquinas:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — alguien te envía entre redes usando un código de emparejamiento que generó (con la CLI, una app de Relayium o la página web) y te comunicó fuera de banda. Cifrado de extremo a extremo, retransmitido siempre que el servidor emite un retransmisor para el código, con un código SAS que puedes comparar.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — esta máquina escucha envíos en daemon directo por relayium://, en el puerto 9031 por defecto.",
        "relayium down <link> [destdir] — descargar y descifrar un enlace almacenado; no hace falta cuenta para descargar (el antiguo relayium pull por SSH está retirado).",
      ],
    },
    {
      heading: "receive: alguien te envía un archivo entre redes",
      prereqs: {
        label: "Lo que necesitas antes del paso 1",
        items: [
          "La CLI en esta máquina. relayium version imprime una cadena de versión; si el shell responde command not found, aquí todavía no está instalada.",
          "Un emisor con la sesión iniciada y delante de su terminal ahora mismo. Solo él necesita cuenta: para recibir no inicias sesión nunca.",
          "Los seis dígitos, por un canal aparte. Viven cinco minutos desde el momento en que su CLI los acuñó, así que acordad antes el momento.",
          "Una forma de leerle después otros seis dígitos: el SAS se compara en voz alta, no en pantalla.",
          "El otro extremo puede ser relayium send o relayium pair, una app de Relayium o la página web: cualquiera genera un código que puedes recibir con receive.",
        ],
      },
      steps: [
        {
          text: "Acuerda con el emisor cuándo va a ejecutar send. El código empieza a caducar en cuanto se acuña, no cuando te llega.",
        },
        {
          text: "Recibe los seis dígitos por un canal en el que ambos confiéis: una llamada, una ventana de chat, la habitación en la que estáis.",
        },
        {
          text: "Ejecuta receive desde el directorio donde deban caer los archivos, o nombra uno explícitamente.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Cuando ambos terminales impriman un código de verificación, lee el tuyo en voz alta y comprueba que coincide con el suyo. No es el código de emparejamiento, y es lo único que descarta un extremo suplantado.",
        },
        {
          text: "No toques el terminal hasta que vuelva al prompt. Es una sola sesión en vivo: cerrar cualquiera de los dos extremos detiene la transferencia.",
        },
      ],
      success: {
        label: "Qué aspecto tiene una recepción correcta",
        body: [
          "La línea path indica por dónde viajan los bytes —relay, o direct / lan para de igual a igual— y ambos extremos muestran el MISMO código de verificación. Códigos distintos son el único resultado que no debes aceptar: detente y comprueba con el remitente en qué máquina está.",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      body: [
        "Esta es la mitad receptora de relayium send. La otra persona ejecuta relayium send <path> en su extremo (tras relayium login); su CLI genera un código de 6 dígitos, válido 5 minutos, y lo imprime. Te dice cuál es por cualquier canal en el que ambos confíen — una llamada, un mensaje de chat. Tú ejecutas receive con ese código:",
      ],
      code: [
        `relayium receive 483920

# o dentro de un directorio concreto
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "La conexión está cifrada de extremo a extremo; una vez conectados, ambos extremos muestran el mismo SAS (short authentication string). Compáralo fuera de banda con el remitente para confirmar que las huellas de los certificados TLS fijados no fueron sustituidas y que el servicio de encuentro no suplantó a ninguno. El SAS autentica los extremos; no prueba cada salto de la ruta de red.",
        "Sin destino indicado: los archivos caen en el directorio actual.",
        "La misma regla de retransmisión que send: siempre que el servidor emite un retransmisor para el código, cada byte pasa por ese retransmisor cifrado y cuenta para la cuota mensual de tráfico de la cuenta que generó el código —la del remitente, nunca la tuya—. Solo sin retransmisor los dos extremos se conectan de igual a igual, y entonces la transferencia falla si no existe una ruta directa.",
        "El código es el mismo código de emparejamiento que usan las apps y la página web: alguien que envía desde relayium.com o una app de Relayium puede leerte un código que recibes aquí, y a un código generado por relayium send se puede unir desde la página web en lugar de la CLI.",
        "El receptor nunca necesita una cuenta, en ninguna red. Solo el remitente inicia sesión, para que su CLI pueda generar el código.",
      ],
    },
    {
      heading: "serve: convierte esta máquina en un buzón a la escucha",
      steps: [
        {
          text: "Arranca el receptor nombrando el directorio donde deben caer los envíos.",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "Cuando una máquina nueva empuja por primera vez, serve muestra su dirección y su huella y te pregunta. Apruébala una vez y los envíos posteriores de esa huella pasan en silencio.",
        },
        {
          text: "Si este receptor va a funcionar sin terminal, no cuentes con esa pregunta: no hay nadie para responderla y un emisor desconocido se rechaza sin más. Usa la autorización previa de la sección siguiente.",
        },
      ],
      body: [
        "serve funciona al revés: en lugar de que seas tú quien va a buscar, otras máquinas te envían directamente por relayium:// — pensado para máquinas en las que ya confías, como tu propio portátil enviando a un NAS, o un servidor de compilación dejando artefactos en una máquina que es tuya — por una conexión TLS 1.3 con anclaje, sin SSH, sin punto de encuentro.",
      ],
      code: [
        `relayium serve

# un directorio y un puerto concretos, permitiendo peticiones de borrado
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "La primera vez que una máquina nueva te envía algo, serve (ejecutándose en un terminal) muestra su dirección y su huella y te pide que la apruebes una vez; después, los envíos de la misma huella pasan en silencio.",
        "Sin terminal — un servicio systemd, un script sin TTY — no hay a quién preguntar, así que un emisor no reconocido se rechaza de plano. En su lugar, autorízalo por adelantado usando la huella que el emisor imprime con relayium id:",
      ],
    },
    {
      heading: "Autorizar por adelantado para un serve desatendido",
      body: [
        "Para un serve que corre desatendido (systemd, un script en segundo plano), haz que el emisor ejecute relayium id para imprimir su huella, y luego apruébala de antemano desde el lado receptor:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir fija dónde caen los archivos (por defecto el directorio actual); --once acepta una única transferencia y sale; --allow-delete deja que una petición --delete (espejo) entrante realmente elimine archivos aquí, y está desactivado por defecto.",
        "--config-dir (por defecto ~/.config/relayium) es donde viven la identidad de este host y su lista de huellas autorizadas — anúlalo si ejecutas serve como un servicio dedicado.",
      ],
    },
    {
      heading: "pull (SSH): retirado",
      body: [sshRetiredNotice.es, "Para traer algo de un servidor que administras, súbelo desde el servidor con relayium up y ejecuta aquí relayium down con el enlace, o ejecuta relayium serve en esta máquina y haz que el servidor haga push a relayium://este-host."],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
    },
    {
      heading: "Cuando no funciona",
      body: [
        "Cinco fallos cubren casi todas las recepciones fallidas. Qué orden estabas ejecutando decide cuál aplica, y cada uno se zanja con una línea que leer o una orden que ejecutar.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "Escribes el código y el rendezvous lo rechaza.",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "Casi siempre han pasado los cinco minutos: el código caduca desde que lo acuñó la CLI del emisor, no desde que te lo dijeron. Pídele que ejecute send otra vez y que te lea los dígitos nuevos en el momento. Un dígito mal tecleado es indistinguible desde aquí, así que reléeselo antes de dar por hecho que caducó.",
          },
          {
            symptom: "La transferencia termina pero no encuentras los archivos.",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "Sin destino, receive escribe en el directorio desde el que lo lanzaste, que rara vez es donde estabas mirando. Indica uno explícitamente, o ejecuta pwd antes.",
          },
          {
            symptom: "Falla con \"no direct connection to the peer (both ends behind strict NAT?)\".",
            code: [
              `relayium receive 483920
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Un extremo usa un relayium antiguo cuyo emparejamiento es solo directo, y ninguno pudo alcanzar al otro. Actualiza ambos extremos: un relayium actual pasa por el retransmisor cifrado siempre que el servidor emite uno para el código. Si no, mueve un extremo a una red con dirección alcanzable —un servidor, o el punto de acceso del móvil— o sube el archivo con relayium up y pasa el enlace de descarga en su lugar.",
          },
          {
            symptom: "down dice que el enlace no es válido o que no puede descifrar el archivo.",
            code: [
              "relayium down '<link-without-fragment>' ./downloads\n# invalid link or missing key",
            ],
            fix: "Copia de nuevo el enlace completo, incluido #k=. El fragmento es la única clave de descifrado; si se omitió, el servidor no puede reconstruirlo.",
          },
          {
            symptom: "Una máquina empuja a tu receptor serve y es rechazada sin que nunca te pregunten.",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "Esa pregunta solo existe si serve tiene terminal. Bajo systemd, dentro de un script o detrás de una tubería no hay a quién preguntar, así que una huella desconocida se rechaza sin más. Haz que el emisor ejecute relayium id y autorízala aquí con relayium authorize <huella>, con el mismo --config-dir bajo el que corre el receptor.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito una cuenta para recibir archivos?",
        a: "No. receive y serve no necesitan cuenta por tu parte, y down solo necesita el enlace. Quien inicia sesión es el remitente, para generar un código de emparejamiento para receive o crear un enlace almacenado. El almacenamiento alojado consume la cuota del plan del remitente, lo cual es contabilizar el uso, no un cargo por transferencia.",
      },
      {
        q: "¿relayium receive interopera con el código de emparejamiento del navegador?",
        a: "Sí. Un relayium actual y las apps y la página web de relayium.com usan los mismos códigos de emparejamiento, así que relayium receive puede aceptar un código generado en un navegador o una app, y un navegador puede unirse a un código que generó relayium send. Solo una CLI de relayium antigua, o un servidor anterior a las indicaciones de emparejamiento, vuelve al emparejamiento antiguo, solo entre CLI y solo directo.",
      },
      {
        q: "¿Qué pasa si una máquina desconocida envía a mi proceso serve a la escucha?",
        a: "En un terminal, se te pide aprobarla por dirección y huella en su primer envío, y la aprobación se recuerda. Sin terminal — un servicio systemd, una tarea cron — no hay a quién preguntar, así que un emisor no reconocido se rechaza; autorízalo primero con relayium authorize <fingerprint>.",
      },
      {
        q: "¿Puedo traer archivos de un servidor que administro?",
        a: "No con relayium pull: tanto él como las transferencias SSH están retirados en la CLI actual. Ejecuta relayium serve en esta máquina y haz que el servidor envíe con relayium push relayium://este-host, o sube desde el servidor con relayium up y descarga aquí el enlace con relayium down.",
      },
      {
        q: "¿Dónde guarda relayium mi identidad y los pares de confianza?",
        a: "En ~/.config/relayium por defecto — anula la ubicación con --config-dir en cualquier comando que toque la identidad o la confianza.",
      },
    ],
  },
  cta: {
    text: "¿Listo para recibir tu primera transferencia? Instala la CLI y elige receive, serve o down.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Receber arquivos pela linha de comando",
  description:
    "Três formas de receber um arquivo com a CLI do Relayium: receber um envio entre redes por código de pareamento, atuar como caixa de entrada à escuta para envios em daemon direto, ou baixar um link criptografado armazenado com down. Sem conta do lado que recebe.",
  updatedLabel: "Última atualização",
  lead: [
    "Enviar é só metade da história — mais cedo ou mais tarde você está na ponta receptora: um colega quer te entregar um arquivo pela internet, uma das suas próprias máquinas quer repassá-lo a outra, ou alguém deixou para você um link armazenado para baixar quando puder. A CLI do Relayium cobre os três casos com um comando diferente para cada um, e nenhum precisa de conta do lado que recebe.",
    "Escolha receive quando outra pessoa está te enviando por código de pareamento, serve quando você quer uma caixa de entrada permanente para a qual máquinas confiáveis possam enviar a qualquer momento, e down quando quem enviou te deu um link criptografado armazenado e talvez já esteja offline.",
  ],
  sections: [
    {
      heading: "Três formas de receber, e quando cada uma se aplica",
      body: [
        "Qual comando você executa depende de quem inicia a transferência e de como as duas máquinas se conhecem:",
      ],
      bullets: [
        "relayium receive <code> [destdir] — alguém envia para você entre redes usando um código de pareamento que gerou (com a CLI, um app do Relayium ou a página web) e repassou a você fora de banda. Com criptografia de ponta a ponta, retransmitido sempre que o servidor emite um retransmissor para o código, com um código SAS que você pode comparar.",
        "relayium serve [--dir D] [--port N] [--once] [--allow-delete] — esta máquina fica à escuta de envios em daemon direto por relayium://, na porta 9031 por padrão.",
        "relayium down <link> [destdir] — buscar e descriptografar um link armazenado; não é preciso conta para baixar (o antigo relayium pull por SSH foi descontinuado).",
      ],
    },
    {
      heading: "receive: alguém envia um arquivo para você entre redes",
      prereqs: {
        label: "O que você precisa antes do passo 1",
        items: [
          "A CLI nesta máquina. relayium version imprime uma linha de versão; se o shell responder command not found, ela ainda não está instalada aqui.",
          "Um remetente com sessão iniciada e diante do terminal agora. Só ele precisa de conta — você nunca faz login para receber.",
          "Os seis dígitos, por um canal à parte. Eles vivem cinco minutos a partir do momento em que a CLI dele os gerou, então combinem antes a hora.",
          "Um jeito de ler outros seis dígitos de volta para ele depois: o SAS se compara em voz alta, não na tela.",
          "A outra ponta pode ser relayium send ou relayium pair, um app do Relayium ou a página web — qualquer um gera um código que você pode receber com receive.",
        ],
      },
      steps: [
        {
          text: "Combine com o remetente quando ele vai rodar o send. O código começa a expirar assim que é gerado, não quando chega até você.",
        },
        {
          text: "Receba os seis dígitos por um canal em que os dois lados confiem — uma ligação, uma janela de conversa, a sala em que estão.",
        },
        {
          text: "Rode o receive no diretório onde os arquivos devem cair, ou nomeie um explicitamente.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Quando os dois terminais imprimirem um código de verificação, leia o seu em voz alta e confirme que bate com o dele. Ele não é o código de emparelhamento, e é a única coisa que descarta uma ponta trocada.",
        },
        {
          text: "Não mexa no terminal até ele voltar ao prompt. É uma única sessão ao vivo: fechar qualquer uma das pontas interrompe a transferência.",
        },
      ],
      success: {
        label: "Como é um recebimento bem-sucedido",
        body: [
          "A linha path mostra por onde os bytes viajam — relay, ou direct / lan para ponto a ponto — e as duas pontas mostram o MESMO código de verificação. Códigos diferentes são o único resultado que você não deve aceitar — pare e confira com quem enviou em qual máquina a pessoa está.",
        ],
        code: [
          `$ relayium receive 483920
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      body: [
        "Esta é a metade receptora do relayium send. A outra pessoa executa relayium send <path> do lado dela (depois de relayium login); a CLI dela gera um código de 6 dígitos, válido por 5 minutos, e o exibe. Ela te diz qual é por qualquer canal em que ambos confiem — uma ligação, uma mensagem de chat. Você executa receive com esse código:",
      ],
      code: [
        `relayium receive 483920

# ou para um diretório específico
relayium receive 483920 ./downloads`,
      ],
      bullets: [
        "A conexão tem criptografia de ponta a ponta; depois de conectadas, as duas pontas mostram o mesmo SAS (short authentication string). Compare-o fora de banda com quem enviou para confirmar que as impressões digitais dos certificados TLS fixados não foram substituídas e que o serviço de encontro não se passou por nenhuma delas. O SAS autentica as pontas; não prova cada salto da rota de rede.",
        "Sem destino indicado: os arquivos caem no diretório atual.",
        "A mesma regra de retransmissão do send: sempre que o servidor emite um retransmissor para o código, cada byte passa por esse retransmissor criptografado e conta para a cota mensal de tráfego da conta que gerou o código — a de quem enviou, nunca a sua. Só sem retransmissor as duas pontas se conectam ponto a ponto, e então a transferência falha se não houver um caminho direto.",
        "O código é o mesmo código de pareamento que os apps e a página web usam: alguém enviando pelo relayium.com ou por um app do Relayium pode ler para você um código que você recebe aqui, e um código gerado pelo relayium send pode ser acessado pela página web em vez da CLI.",
        "O receptor nunca precisa de conta, em nenhuma rede. Só quem envia faz login, para que a CLI dele possa gerar o código.",
      ],
    },
    {
      heading: "serve: transforme esta máquina em uma caixa de entrada à escuta",
      steps: [
        {
          text: "Inicie o receptor nomeando o diretório onde os envios devem cair.",
          code: ["relayium serve --dir ~/incoming"],
        },
        {
          text: "Quando uma máquina nova empurra pela primeira vez, o serve mostra o endereço e a impressão digital dela e pergunta. Aprove uma vez e os envios seguintes daquela impressão passam em silêncio.",
        },
        {
          text: "Se este receptor for rodar sem terminal, não conte com essa pergunta: não há ninguém para responder, e um remetente desconhecido é recusado de cara. Use a autorização prévia descrita na próxima seção.",
        },
      ],
      body: [
        "serve funciona ao contrário: em vez de você ir buscar, outras máquinas enviam diretamente para você por relayium:// — feito para máquinas em que você já confia, como seu próprio notebook enviando para um NAS, ou um servidor de compilação despejando artefatos em uma máquina que é sua — por uma conexão TLS 1.3 com fixação, sem SSH, sem encontro.",
      ],
      code: [
        `relayium serve

# um diretório e uma porta específicos, permitindo requisições de exclusão
relayium serve --dir ~/incoming --port 9031 --allow-delete`,
      ],
      bullets: [
        "Na primeira vez que uma máquina nova envia para você, o serve (rodando em um terminal) mostra o endereço e a impressão digital dela e pede que você a aprove uma vez; depois disso, os envios da mesma impressão digital passam silenciosamente.",
        "Sem terminal — um serviço systemd, um script sem TTY — não há a quem perguntar, então um emissor não reconhecido é rejeitado de imediato. Em vez disso, autorize-o com antecedência usando a impressão digital que o emissor imprime com relayium id:",
      ],
    },
    {
      heading: "Autorizar com antecedência para um serve desassistido",
      body: [
        "Para um serve que roda desassistido (systemd, um script em segundo plano), faça o emissor executar relayium id para imprimir sua impressão digital, e então aprove-a de antemão do lado receptor:",
      ],
      code: ["relayium authorize <fingerprint>"],
      bullets: [
        "--dir define onde os arquivos caem (padrão o diretório atual); --once aceita uma única transferência e sai; --allow-delete permite que uma requisição --delete (espelho) recebida realmente remova arquivos aqui, e está desligado por padrão.",
        "--config-dir (padrão ~/.config/relayium) é onde ficam a identidade deste host e sua lista de impressões digitais autorizadas — substitua-o se você executa serve como um serviço dedicado.",
      ],
    },
    {
      heading: "pull (SSH): descontinuado",
      body: [sshRetiredNotice.pt, "Para trazer algo de um servidor que você administra, envie-o do servidor com relayium up e rode aqui relayium down com o link — ou rode relayium serve nesta máquina e faça o servidor dar push para relayium://este-host."],
      code: ["relayium down '<complete-link-with-#k-fragment>' ./local-dest"],
    },
    {
      heading: "Quando não funciona",
      body: [
        "Cinco falhas cobrem quase todo recebimento malsucedido. O comando que você estava rodando decide qual delas se aplica, e cada uma se resolve com uma linha para ler ou um comando para rodar.",
      ],
      troubleshooting: {
        label: "Sintoma, checagem, correção",
        items: [
          {
            symptom: "Você digita o código e o rendezvous recusa.",
            code: [
              `relayium receive 483920
# the rendezvous refuses the code`,
            ],
            fix: "Quase sempre os cinco minutos já passaram: o código expira a partir de quando a CLI do remetente o gerou, não de quando você foi avisado. Peça para ele rodar o send de novo e ler os dígitos novos na hora. Um dígito digitado errado é indistinguível daqui, então releia o código para ele antes de concluir que expirou.",
          },
          {
            symptom: "A transferência termina mas você não acha os arquivos.",
            code: [
              `relayium receive 483920 ./downloads`,
            ],
            fix: "Sem destino, o receive escreve no diretório de onde você o executou, que raramente é onde você estava procurando. Passe um explicitamente, ou rode pwd antes.",
          },
          {
            symptom: "Falha com \"no direct connection to the peer (both ends behind strict NAT?)\".",
            code: [
              `relayium receive 483920
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Uma das pontas usa um relayium antigo cujo pareamento é só direto, e nenhuma conseguiu alcançar a outra. Atualize as duas pontas: um relayium atual passa pelo retransmissor criptografado sempre que o servidor emite um para o código. Senão, leve uma das pontas para uma rede com endereço alcançável — um servidor, ou o roteamento do celular — ou suba o arquivo com relayium up e repasse o link de download.",
          },
          {
            symptom: "O down diz que o link é inválido ou que não consegue descriptografar o arquivo.",
            code: [
              "relayium down '<link-without-fragment>' ./downloads\n# invalid link or missing key",
            ],
            fix: "Copie o link inteiro de novo, incluindo #k=. O fragmento é a única chave de descriptografia; se ele foi omitido, o servidor não consegue reconstruí-lo.",
          },
          {
            symptom: "Uma máquina empurra para o seu receptor serve e é recusada sem que você seja perguntado.",
            code: [
              `relayium serve --dir ~/incoming`,
            ],
            fix: "Essa pergunta só existe quando o serve tem terminal. Sob systemd, dentro de um script ou atrás de um pipe não há a quem perguntar, então uma impressão digital desconhecida é recusada de cara. Peça ao remetente para rodar relayium id e autorize aqui com relayium authorize <impressão>, usando o mesmo --config-dir sob o qual o receptor roda.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso de uma conta para receber arquivos?",
        a: "Não. receive e serve não precisam de conta do seu lado, e o down só precisa do link. Quem faz login é quem envia, para gerar um código de pareamento para receive ou criar um link armazenado. O armazenamento hospedado consome a cota do plano de quem envia, o que é contabilizar o uso, não uma cobrança por transferência.",
      },
      {
        q: "O relayium receive interopera com o código de emparelhamento do navegador?",
        a: "Sim. Um relayium atual e os apps e a página web do relayium.com usam os mesmos códigos de pareamento, então o relayium receive consegue aceitar um código gerado em um navegador ou app, e um navegador consegue entrar em um código gerado pelo relayium send. Só uma CLI do relayium antiga, ou um servidor anterior às dicas de pareamento, volta ao pareamento antigo, só entre CLIs e só direto.",
      },
      {
        q: "O que acontece se uma máquina desconhecida enviar para o meu processo serve à escuta?",
        a: "Em um terminal, você é solicitado a aprová-la por endereço e impressão digital no primeiro envio dela, e a aprovação é lembrada. Sem terminal — um serviço systemd, uma tarefa cron — não há a quem perguntar, então um emissor não reconhecido é rejeitado; autorize-o primeiro com relayium authorize <fingerprint>.",
      },
      {
        q: "Posso trazer arquivos de um servidor que eu administro?",
        a: "Não com relayium pull: ele e as transferências por SSH foram descontinuados na CLI atual. Rode relayium serve nesta máquina e faça o servidor enviar com relayium push relayium://este-host, ou envie do servidor com relayium up e baixe o link aqui com relayium down.",
      },
      {
        q: "Onde o relayium guarda minha identidade e os pares confiáveis?",
        a: "Em ~/.config/relayium por padrão — substitua o local com --config-dir em qualquer comando que toque a identidade ou a confiança.",
      },
    ],
  },
  cta: {
    text: "Pronto para receber sua primeira transferência? Instale a CLI e escolha receive, serve ou down.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

const currentEn = {
  title: "Receive files from the command line",
  description: "Receive with a pairing code, an authorized daemon-direct listener, Device Inbox or a Cloud link. The current CLI has no pull command.",
  updatedLabel: "Last updated",
  lead: ["The right receive path depends on whether both ends are online and whether you manage the receiving machine.", "relayium pull and SSH destinations are retired. A current CLI receives through receive, serve, inbox, or down."],
  sections: [
    { heading: "Receive from another online CLI", body: ["The sender mints a five-minute code and you join without an account."], code: ["relayium receive 483920 ./downloads"], bullets: ["Both ends must stay online.", "The transfer is direct-only and fails rather than falling back to a relay.", "Use --verify to stop and compare the SAS derived from pinned TLS certificate fingerprints."] },
    { heading: "Run a listener on a machine you manage", body: ["Authorize the sender fingerprint and run serve in an existing writable directory."], code: ["relayium authorize <sender-fingerprint>", "relayium serve --dir ~/inbox"], bullets: ["The sender uses relayium push ... relayium://host.", "Use the same --config-dir for authorize and serve.", "No Relayium account or SSH transport is involved."] },
    { heading: "Receive while this machine is offline", body: ["Use Device Inbox for a named device, or relayium down for a stored encrypted link."], code: ["relayium inbox enable --dir ~/inbox", "relayium down '<link>' ./downloads"], bullets: ["Device Inbox requires the same account on the sending and receiving sides.", "down needs only the link and no account."] },
  ],
  faq: { heading: "Frequently asked questions", items: [
    { q: "Can I pull from an SSH server?", a: "Not with the current Relayium CLI. relayium pull, SSH destinations, -i and -p are retired." },
    { q: "Which receive modes need an account?", a: "Device Inbox does. Joining receive with a code and using down do not; daemon-direct serve does not." },
    { q: "Can receive fall back to a relay?", a: "CLI pairing-code receive is direct-only. Use Cloud or Device Inbox when asynchronous hosted delivery is required." },
  ] },
  cta: { text: "Choose the receive path that matches availability.", button: "Get the CLI", href: "/cli" },
  relatedHeading: "Keep reading",
};
const currentZh = {
  title: "从命令行接收文件",
  description: "通过配对码、已授权的 daemon 监听器、设备收件箱或云端链接接收。当前 CLI 没有 pull 命令。",
  updatedLabel: "最近更新",
  lead: ["选择哪种接收路径，取决于两端是否同时在线，以及你是否管理接收机器。", "relayium pull 与 SSH 目标已退役。当前 CLI 通过 receive、serve、inbox 或 down 接收。"],
  sections: [
    { heading: "从另一台在线 CLI 接收", body: ["发送方生成一个五分钟有效的码，你无需账号即可加入。"], code: ["relayium receive 483920 ./downloads"], bullets: ["两端必须保持在线。", "传输只走直连，失败时不会回退到中继。", "用 --verify 停下来比对由固定 TLS 证书指纹生成的 SAS。"] },
    { heading: "在自管机器上运行监听器", body: ["授权发送端指纹，并在已经存在且可写的目录中运行 serve。"], code: ["relayium authorize <sender-fingerprint>", "relayium serve --dir ~/inbox"], bullets: ["发送端使用 relayium push ... relayium://host。", "authorize 与 serve 使用同一个 --config-dir。", "不需要 Relayium 账号，也不走 SSH 传输。"] },
    { heading: "机器离线时接收", body: ["给命名设备使用设备收件箱，或用 relayium down 下载托管的加密链接。"], code: ["relayium inbox enable --dir ~/inbox", "relayium down '<link>' ./downloads"], bullets: ["设备收件箱要求发送端与接收端使用同一个账号。", "down 只需要链接，不需要账号。"] },
  ],
  faq: { heading: "常见问题", items: [
    { q: "可以从 SSH 服务器 pull 吗？", a: "当前 Relayium CLI 不可以。relayium pull、SSH 目标、-i 与 -p 已退役。" },
    { q: "哪些接收模式需要账号？", a: "设备收件箱需要。用码加入 receive、用 down 下载、daemon 直连 serve 都不需要。" },
    { q: "receive 会回退到中继吗？", a: "CLI 配对码 receive 只走直连。需要异步托管投递时，请用云端或设备收件箱。" },
  ] },
  cta: { text: "按在线状态选择接收路径。", button: "获取 CLI", href: "/cli" },
  relatedHeading: "继续阅读",
};

export default {
  slug: "guides/receive-files-from-the-command-line",
  published: "2026-07-09",
  updated: "2026-09-01",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
