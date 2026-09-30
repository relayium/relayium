// web/scripts/pages/content/articles/cli-getting-started.mjs
// Getting started with the Relayium CLI. English is the master; zh/ja/ko/de/fr
// follow the same structure with identical facts. Command blocks (code) stay
// English in every language.

import { cliDirectFacts } from "../realtime-facts.mjs";

const en = {
  title: "Transfer files and text from the terminal with the Relayium CLI",
  description:
    "Install the free, end-to-end-encrypted Relayium CLI to move files by pairing code, daemon-direct or encrypted Cloud links — and send ephemeral text while both machines are online.",
  updatedLabel: "Last updated",
  lead: [
    "The Relayium CLI is a single small binary that moves files and ephemeral text from your terminal — encrypted end to end, self-hostable, and free and open source under the AGPL-3.0. It handles copying files to a server, pushing a build between machines, sending an archive across networks, and moving a URL, command, or code snippet without first saving it as a file.",
    "In daemon direct — relayium serve with push or sync — the file bytes travel straight between your two machines and never pass through Relayium's servers, so nothing is metered. The pairing-code sessions — send / receive, text and pair — are end-to-end encrypted, but whenever the server issues a relay for the code every byte travels through that encrypted relay and counts toward the monthly traffic allowance of the account that minted the code. Two modes hold data under your account: up, which stores an encrypted copy and draws on four separate plan limits — monthly traffic, the storage you hold live at once, retention, and a rolling daily upload quota — and Device Inbox, which queues an encrypted delivery until a machine of your own comes back for it. This guide gets you installed and through your first transfer, then points you at the deeper how-tos for each mode.",
  ],
  sections: [
    {
      heading: "Install in one command",
      prereqs: {
        label: "What you need",
        items: [
          "A macOS, Linux or Windows machine with a terminal. Prebuilt binaries cover x86-64 and arm64 on all three.",
          "curl, for the one-line install on macOS and Linux — curl --version prints a version. On Windows, download the .zip from the releases page instead.",
          "A writable install directory. The script uses /usr/local/bin when it can write there and ~/.local/bin otherwise, and its last lines name the one it chose.",
          "Nothing else for daemon-direct push or sync. Only minting a pairing code with send, text or pair, uploading with up, and the Device Inbox need a Relayium account.",
        ],
      },
      body: [
        "On macOS or Linux, one command downloads a prebuilt binary for your OS and puts it on your PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Prefer to pick the file yourself? Download a binary from the releases page.",
        "Have Go installed? Clone the repo and run: go build ./cmd/relayium (from the server directory).",
        "Then run relayium --help to see every command, and relayium version to check the build.",
      ],
    },
    {
      heading: "The six ways it moves files and text",
      body: [
        "Two questions decide which one you want: can the machine on the other end be offline right now, and is it a machine you administer? Nothing below is a blanket promise — each mode states the account it needs, whether the far end can be offline, where the bytes go, and what it actually verifies.",
      ],
      bullets: [
        "relayium up / relayium down (Cloud) — the far end can be offline. up encrypts on this machine, uploads only the ciphertext and prints a link; down fetches and decrypts it on any other machine, with no account. Uploading needs relayium login and draws on your plan's monthly traffic, storage cap, retention ceiling and daily upload quota, and the key rides only in the link's #k= fragment, which never reaches Relayium: the encrypted copy stays stored until its retention expires, but losing the link loses the only key that can decrypt it.",
        "Device Inbox — the far end can be offline. relayium inbox send --to <device> encrypts files here and queues them for one of your own devices (relayium inbox sent, cancel and retry follow a delivery up), and relayium inbox enable plus relayium inbox run receive into a folder you chose; browsers and the native apps send and receive too. Both ends sign in to the same account, and someone at the receiving machine has to choose a folder and turn receiving on there. To move files between two of your own servers directly, use serve with push or sync instead.",
        "relayium text — ephemeral encrypted messages between two terminals that are both online at the same time. Minting the code needs relayium login; joining with a code someone handed you needs no account, and Relayium servers keep no message bodies.",
        `relayium send / relayium receive — to another person across networks, using a short pairing code the sender's CLI mints (sign in once with relayium login; the receiver never does). The other end can be relayium receive, relayium pair, a Relayium app or the web page, and relayium pair is the two-way session over the same kind of code. A minted code is good for five minutes, so start the receiving end within that window. ${cliDirectFacts.en}`,
        "relayium serve + relayium push relayium:// (daemon direct) — straight between two machines you own, over pinned TLS 1.3. No relay, no SSH, no pairing code. The receiving host's authorized_fingerprints file is the whole trust decision, and being signed in to a Relayium account grants no one filesystem access.",
        "relayium sync — one-way incremental mirroring over the same transports as push: files whose size and modification time are unchanged are skipped. It is the mode that continues a partial file at the destination on a later run, and it verifies the files it does transfer — but a one-way mirror is a copy of the current state, not a versioned backup.",
      ],
    },
    {
      heading: "Send ephemeral text",
      body: [
        "Run relayium text on one machine to mint a pairing code and wait, then join from the other machine with the printed code:",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "Minting the code needs relayium login; joining with a code needs no login.",
        "Both machines must stay online. Messages are end-to-end encrypted, and Relayium servers never store their bodies.",
        cliDirectFacts.en,
        "Either endpoint can still copy or retain received text.",
        "Each message can be at most 65,536 UTF-8 bytes. Use relayium send for anything larger.",
      ],
    },
    {
      heading: "Your first transfer",
      body: [
        "The quickest thing to try is copying a folder to a machine you manage. Run a Relayium listener there, authorize this sender, and transfer directly with no account:",
      ],
      steps: [
        {
          text: "Check the CLI is on your PATH. It prints a version string, not \"command not found\".",
          code: ["relayium version"],
        },
        {
          text: "On the receiver, create the directory, authorize the sender fingerprint and start the listener. authorize and serve must use the same --config-dir.",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "Push the folder to the listener's relayium:// address.",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "Confirm on the receiving machine that photos/ appeared under the listener's --dir.",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "What a successful run looks like",
        body: [
          "push prints one line per completed file and exits 0 after the listener verifies and installs the batch.",
        ],
        code: [
          `relayium push ./photos relayium://receiver.example
  photos/IMG_0413.jpg (2314518 bytes)
  photos/IMG_0414.jpg (1998233 bytes)
echo $?
# 0`,
        ],
      },
      bullets: [
        "push checks the batch for collisions before sending, verifies each file with SHA-256 and stages it before installation. It does not resume; use relayium sync when a run may be interrupted.",
        "The listener must be reachable and must already have authorized this sender's fingerprint.",
        "SSH destinations, relayium pull, -i and -p are retired. To transfer in the other direction, run serve on this machine and initiate a new daemon-direct push from the other one.",
      ],
    },
    {
      heading: "When the first command doesn't work",
      body: [
        "Four things go wrong on a first run more often than everything else put together. None of them needs guesswork — each has a command whose output decides it.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "\"relayium: command not found\", right after the install script said it succeeded.",
            code: [
              `command -v relayium
# (prints nothing)`,
            ],
            fix: "The binary is installed, but its directory isn't on your PATH. The script's last lines name the directory it used and print the exact export PATH line to add; run them, then open a new shell and try relayium version again.",
          },
          {
            symptom: "push says SSH transfers are disabled.",
            code: [
              `relayium push ./photos <retired-ssh-destination>
# SSH transfers are currently disabled`,
            ],
            fix: "The command uses the retired SSH destination form. Start relayium serve on the receiver and use relayium://receiver instead.",
          },
          {
            symptom: "The listener rejects the sender as unauthorized.",
            code: [
              `relayium id
# sha256:...`,
            ],
            fix: "Run relayium authorize <sender-fingerprint> on the receiver with the same --config-dir used by serve. A running listener reads the new authorization on the next connection.",
          },
          {
            symptom: "Two machines join the same code and one prints \"the other side is running `relayium text`, not `relayium send`/`relayium receive`\".",
            code: [
              `# a message session: BOTH ends run text
relayium text
relayium text 483920`,
            ],
            fix: "The two ends ran different commands. Use relayium text on both machines for messages, and relayium send on one with relayium receive on the other for files; the mismatch is refused before anything is dialed, so nothing was sent.",
          },
        ],
      },
    },
    {
      heading: "Free, and private by design",
      body: [
        "Relayium has no per-transfer charge. Daemon-direct push/sync moves content straight between your two machines, never through Relayium's servers, so it uses no allowance and needs no account. The pairing-code sessions — send / receive, text and pair — need a sign-in only on the side that mints the code, and whenever the server issues a relay for the code, every byte goes through that encrypted relay and counts toward the monthly traffic allowance of the account that minted the code. The two modes that hold data under your account work differently: Cloud up stores an encrypted copy, so it needs a sign-in and consumes the plan's monthly traffic allowance, storage cap, retention ceiling and daily upload quota; Device Inbox queues an encrypted delivery for a machine of your own, counts against the same limits, and both ends have to be signed in to the same account. Consuming an allowance is usage accounting, not a per-transfer charge.",
        "Every direct file transfer is encrypted end to end and verifies each transferred file with SHA-256. Resume is narrower: relayium sync continues a partial file on a later run, relayium down reconnects within the run that started it, and push, send and receive do not resume. It runs on macOS, Linux and Windows, and is open source and self-hostable.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the CLI cost anything?",
        a: "The CLI itself is free and open source, and daemon-direct push/sync costs nothing to use: its bytes never touch Relayium's servers, so there is nothing to meter. send / receive, text and pair are metered when relayed: whenever the server issues a relay for the code, the relayed bytes count toward the monthly traffic allowance of the account that minted the code. up and down, and Device Inbox deliveries, draw on your plan because they write and read an encrypted copy held under your account. Using allowance is usage accounting, not a per-transfer charge: free accounts pay nothing, while paid plans raise the monthly traffic, stored-at-once, retention and rolling daily-upload limits.",
      },
      {
        q: "Do I need a Relayium account?",
        a: "To mint a pairing code with send, text or pair, for cloud up, and for the Device Inbox. Daemon-direct push/sync uses local public-key trust and needs no account. A server mints pairing codes only for a signed-in account, so the creator runs relayium login once; joining with a code you were handed needs no login. A receive user never signs in.",
      },
      {
        q: "Which operating systems are supported?",
        a: "Prebuilt binaries are published for macOS, Linux and Windows on both x86-64 and arm64. The install script covers macOS and Linux; on Windows, download the .zip from the releases page.",
      },
      {
        q: "Do my files pass through Relayium's servers?",
        a: "Not with daemon-direct push/sync: content travels straight between your two machines. send / receive, text and pair contact our servers for a small rendezvous handshake, and whenever the server issues a TURN relay for the code, every byte of the session travels through that relay — as end-to-end-encrypted ciphertext it cannot read, counted toward the monthly traffic allowance of the account that minted the code, and never stored. Two modes hold data server-side on purpose, and in both the server holds only ciphertext it cannot read: up uploads an encrypted copy to your account's storage, and Device Inbox — relayium inbox send from the CLI, or a browser or native app — queues an encrypted copy for a machine of your own until that machine downloads it.",
      },
    ],
  },
  cta: {
    text: "Install the free, open-source Relayium CLI and make your first direct transfer.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 从终端传输文件与文本",
  description:
    "安装免费、端到端加密的 Relayium CLI，通过配对码、daemon 直连或加密云端链接传输文件，并在两台机器同时在线时发送临时文本。",
  updatedLabel: "最近更新",
  lead: [
    "Relayium CLI 是一个体积很小的单一二进制文件，用来从终端传输文件与临时文本——端到端加密、可自托管，并且以 AGPL-3.0 许可免费开源。你可以把文件复制到服务器、在机器间推送构建产物、跨网络发送压缩包，也可以直接传 URL、命令或代码片段，无需先保存成文件。",
    "在 daemon 直连——relayium serve 配合 push 或 sync——下，文件字节在你的两台机器之间直接传输，从不经过 Relayium 的服务器，不计量。配对码会话——send / receive、text 和 pair——是端到端加密的，但只要服务器为这个码签发了中继，每个字节都经这条加密中继传输，并计入生成配对码那个账号的每月流量额度。有两种模式会在你的账号下保存数据：up 会存放加密副本，占用套餐的每月流量额度、同时存放的存储上限、留存时长与每日上传额度；设备收件箱则会把加密投递排队存着，直到你自己的那台机器回来取。本指南带你完成安装并走通第一次传输。",
  ],
  sections: [
    {
      heading: "一条命令完成安装",
      prereqs: {
        label: "你需要准备",
        items: [
          "一台有终端的 macOS、Linux 或 Windows 机器。三个系统都提供 x86-64 和 arm64 的预编译二进制。",
          "curl，用于 macOS 和 Linux 上的一行安装——curl --version 会打印版本号。Windows 请改从发布页下载 .zip。",
          "一个可写的安装目录。脚本能写 /usr/local/bin 时就用它，否则用 ~/.local/bin，最后几行会写明它选了哪个。",
          "daemon 直连 push/sync 不需要别的东西。只有用 send、text 或 pair 生成配对码、用 up 上传，以及设备收件箱，才需要 Relayium 账号。",
        ],
      },
      body: [
        "在 macOS 或 Linux 上，一条命令就能下载适配你操作系统的预编译二进制，并放进你的 PATH：",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "想自己挑选文件？从发布页下载对应的二进制。",
        "已安装 Go？克隆仓库后运行：go build ./cmd/relayium（在 server 目录下执行）。",
        "然后运行 relayium --help 查看全部命令，运行 relayium version 检查构建版本。",
      ],
    },
    {
      heading: "传输文件与文本的六种方式",
      body: [
        "两个问题就能决定用哪一种：对端此刻能不能离线，以及那台机器是不是你自己管理的。下面没有一句是笼统承诺——每一种模式都会写明它需要什么账号、对端能否离线、字节走哪条路，以及它到底校验了什么。",
      ],
      bullets: [
        "relayium up / relayium down（云端）——对端可以离线。up 在本机加密，只上传密文并打印出一个链接；down 在任何另一台机器上取回并解密，无需账号。上传需要 relayium login，并会占用套餐的每月流量、存储上限、留存时长与每日上传额度；密钥只在链接的 #k= 片段里，从不到达 Relayium：加密副本会一直存到留存到期，但链接一旦丢失，能解密它的唯一密钥也就没有了。",
        "Device Inbox（设备收件箱）——对端可以离线。relayium inbox send --to <device> 在本机加密文件，并排队发给你自己的某台设备（relayium inbox sent、cancel 和 retry 用来跟进投递）；relayium inbox enable 加上 relayium inbox run 则把收到的文件存进你选好的文件夹；浏览器和原生应用也能发送和接收。两端要登录同一个账号，并且必须有人在接收端那台机器上选好文件夹、在本地把接收打开。要在你自己的两台服务器之间直接搬文件，请改用 serve 配合 push 或 sync。",
        "relayium text——两个终端之间的临时加密消息，两端必须同时在线。生成配对码需要 relayium login；拿着别人给你的配对码加入则无需账号，Relayium 服务器也不保存消息正文。",
        `relayium send / relayium receive——跨网络传给另一个人，使用一个由发送方 CLI 生成的简短配对码（用 relayium login 登录一次即可；接收方无需登录）。对端可以是 relayium receive、relayium pair、Relayium 应用或网页；relayium pair 是基于同一种配对码的双向会话。铸出来的配对码有效期 5 分钟，所以要在这段时间内让接收端加入。${cliDirectFacts.zh}`,
        "relayium serve + relayium push relayium://（daemon 直连）——直接在你拥有的两台机器之间传输，走证书固定的 TLS 1.3。无中继、无 SSH、无需配对码。接收端主机的 authorized_fingerprints 文件就是全部的信任决定；登录 Relayium 账号并不会给任何人文件系统权限。",
        "relayium sync——单向增量镜像，走和 push 相同的传输通道：大小与修改时间都没变的文件会被跳过。它是那个会在下一次运行时接着传目标端半截文件的模式，并且会校验它确实传输的文件——但单向镜像是当前状态的副本，不是带版本的备份。",
      ],
    },
    {
      heading: "发送临时文本",
      body: [
        "在一台机器运行 relayium text 生成配对码并等待，然后在另一台机器用打印出的配对码加入：",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "生成配对码需要先执行 relayium login；持码加入无需登录。",
        "两台机器必须同时在线。消息经过端到端加密，Relayium 服务器不存储消息正文。",
        cliDirectFacts.zh,
        "任一端仍可复制或保留收到的文本。",
        "单条消息最多 65,536 UTF-8 字节。更大的内容请使用 relayium send。",
      ],
    },
    {
      heading: "第一次传输",
      body: [
        "最快上手的方式是把一个文件夹复制到你管理的机器。在接收端运行 Relayium 监听器、授权这台发送机，然后无需账号直接传输：",
      ],
      steps: [
        {
          text: "确认 CLI 已在 PATH 里。它会打印版本号，而不是 “command not found”。",
          code: ["relayium version"],
        },
        {
          text: "在接收端创建目录、授权发送端指纹并启动监听器。authorize 与 serve 必须使用同一个 --config-dir。",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "把文件夹推送到监听器的 relayium:// 地址。",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "在接收机器上确认 photos/ 出现在监听器的 --dir 下面。",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "成功时你会看到什么",
        body: [
          "监听端校验并安装整批文件后，push 每完成一个文件打印一行，并以 0 退出。",
        ],
        code: [
          `relayium push ./photos relayium://receiver.example
  photos/IMG_0413.jpg (2314518 bytes)
  photos/IMG_0414.jpg (1998233 bytes)
echo $?
# 0`,
        ],
      },
      bullets: [
        "push 会在发送前检查整批冲突，对每个文件做 SHA-256 校验并先暂存再安装。它不续传；可能中断时请用 relayium sync。",
        "监听端必须可达，并且已经授权这台发送机的指纹。",
        "SSH 目标、relayium pull、-i 与 -p 已退役。要反向传输，请在本机运行 serve，并从另一台机器发起新的 daemon 直连 push。",
      ],
    },
    {
      heading: "第一条命令跑不通时",
      body: [
        "第一次运行时出问题，下面四种加起来比其他所有情况都多。它们都不需要靠猜——每一种都有一条命令，输出就能定性。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "安装脚本明明说成功了，却报 “relayium: command not found”。",
            code: [
              `command -v relayium
# （什么都不打印）`,
            ],
            fix: "二进制装好了，只是它所在的目录不在 PATH 里。脚本最后几行会写明它用了哪个目录，并打印出该加的那行 export PATH；照着执行，然后开一个新 shell 再试 relayium version。",
          },
          {
            symptom: "push 报告 SSH transfers are currently disabled。",
            code: [
              `relayium push ./photos <retired-ssh-destination>
# SSH transfers are currently disabled`,
            ],
            fix: "这条命令使用了已退役的 SSH 目标格式。请在接收端启动 relayium serve，并改用 relayium://receiver。",
          },
          {
            symptom: "监听端拒绝发送机，提示未授权。",
            code: [
              `relayium id
# sha256:...`,
            ],
            fix: "在接收端用 serve 相同的 --config-dir 运行 relayium authorize <发送端指纹>。正在运行的监听器会在下一次连接读取新授权。",
          },
          {
            symptom: "两台机器加入了同一个码，其中一台打印 “the other side is running `relayium text`, not `relayium send`/`relayium receive`”。",
            code: [
              `# 消息会话：两端都跑 text
relayium text
relayium text 483920`,
            ],
            fix: "两端跑的是不同的命令。发消息就两台都用 relayium text；传文件就一台 relayium send、另一台 relayium receive。这种不匹配会在拨号之前就被拒绝，所以什么都没发出去。",
          },
        ],
      },
    },
    {
      heading: "免费，且从设计上保护隐私",
      body: [
        "Relayium 不按次收费。daemon 直连 push/sync 在你的两台机器之间直接传内容，从不经过 Relayium 的服务器，因此不占用额度，也不需要账号。配对码会话——send / receive、text 和 pair——只有生成配对码的那一端需要登录；只要服务器为这个码签发了中继，每个字节都经这条加密中继传输，并计入生成配对码那个账号的每月流量额度。在你账号下保存数据的两种模式则不同：云端 up 存放加密副本，因此需要登录，并会占用套餐的每月流量额度、存储上限、留存时长与每日上传额度；设备收件箱会为你自己的机器排入加密投递，占用同样的额度，两端都必须登录同一账号。占用额度表示计入用量，不等于按次收费。",
        "每次直连文件传输都端到端加密，并对真正传输的文件做 SHA-256 校验。续传范围更窄：relayium sync 会在下一次运行接着传半截文件，relayium down 会在发起下载的同一次运行内重连，而 push、send、receive 不续传。它可在 macOS、Linux 和 Windows 上运行，整个项目开源、可自托管。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "CLI 要收费吗？",
        a: "CLI 本身免费且开源，daemon 直连 push/sync 用起来没有任何费用：它的字节从不经过 Relayium 的服务器，没有可计量的东西。send / receive、text 和 pair 经中继时会计量：只要服务器为这个码签发了中继，经中继的字节就计入生成配对码那个账号的每月流量额度。up 和 down，以及设备收件箱投递，也会占用套餐额度，因为它们写入和读取的是存放在你账号下的加密副本。占用额度表示用量记账，不等于按次收费。免费账号不付费，付费套餐提高每月流量、存储、留存时长与每日上传限制。",
      },
      {
        q: "需要 Relayium 账号吗？",
        a: "send、text 或 pair 生成配对码时需要账号，云端 up 和设备收件箱也需要。daemon 直连 push/sync 使用本机公钥信任，无需账号。服务器只为已登录账号签发配对码，因此创建端先运行一次 relayium login；持别人给你的码加入无需登录，receive 接收方也无需登录。",
      },
      {
        q: "支持哪些操作系统？",
        a: "macOS、Linux 和 Windows 上均提供预编译二进制，覆盖 x86-64 和 arm64。安装脚本适用于 macOS 和 Linux；在 Windows 上，请从发布页下载 .zip。",
      },
      {
        q: "我的文件会经过 Relayium 的服务器吗？",
        a: "daemon 直连 push/sync 不会：内容在你的两台机器之间直接传输。send / receive、text 和 pair 会联系服务器做一次很小的会合握手；只要服务器为这个码签发了 TURN 中继，会话的每个字节都经这条中继传输——是它读不了的端到端加密密文，计入生成配对码那个账号的每月流量额度，而且从不留存。有两种模式会有意在服务器上保存数据，服务器在两种情况下都只保存无法读取的密文：up 会把加密副本上传到你账号的存储里；设备收件箱（CLI 里用 relayium inbox send，也可以用浏览器或原生应用）会把加密副本排队存着，直到你自己的那台机器下载。",
      },
    ],
  },
  cta: {
    text: "安装免费开源的 Relayium CLI，完成你的第一次直连传输。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI でターミナルからファイルとテキストを転送する",
  description:
    "無料でエンドツーエンド暗号化された Relayium CLI で、ペアリングコードやデーモン直結によるファイル転送と、両方の端末がオンライン時の一時テキスト送信を始めましょう。",
  updatedLabel: "最終更新",
  lead: [
    "Relayium CLI はターミナルからファイルと一時テキストを転送する小さな単一バイナリです。エンドツーエンド暗号化、セルフホスト可能、AGPL-3.0 ライセンスの無料オープンソース。サーバーへのファイルコピーやマシン間のビルド送信に加え、URL・コマンド・コード片をファイル化せずそのまま送れます。",
    "デーモン直結（relayium serve と push または sync）では、ファイルのバイトは自分の2台のマシンの間を直接移動し、Relayium のサーバーを通過しないため、何も計測されません。ペアリングコードによるセッション（send / receive、text、pair）はエンドツーエンドで暗号化されていますが、サーバーがそのコードにリレーを発行した場合はすべてのバイトがその暗号化リレーを通り、コードを発行したアカウントの月間転送量の枠に計上されます。up は直結ではありません。暗号化したコピーをアカウントに保存します。本ガイドではインストールから最初の転送までを案内し、その後各モードのより詳しいハウツーへ案内します。",
  ],
  sections: [
    {
      heading: "1コマンドでインストール",
      prereqs: {
        label: "必要なもの",
        items: [
          "端末のある macOS、Linux、Windows のいずれかのマシン。ビルド済みバイナリは3つとも x86-64 と arm64 を用意しています。",
          "macOS と Linux の1行インストールに使う curl。curl --version がバージョンを表示します。Windows ではリリースページから .zip をダウンロードしてください。",
          "書き込めるインストール先ディレクトリ。スクリプトは書き込める場合は /usr/local/bin を、そうでなければ ~/.local/bin を使い、最後の数行でどちらを選んだかを表示します。",
          "デーモン直結の push と sync にはこれ以外は不要です。無料の Relayium アカウントが要るのは、send、text、pair でペアリングコードを発行するとき、up でアップロードするとき、そして Device Inbox を使うときだけです。",
        ],
      },
      body: [
        "macOS または Linux では、1つのコマンドでお使いの OS 向けのビルド済みバイナリをダウンロードし、PATH に配置できます：",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "自分でファイルを選びたい場合は、リリースページからバイナリをダウンロードしてください。",
        "Go がインストール済みなら、リポジトリを clone して次を実行します：go build ./cmd/relayium（server ディレクトリから）。",
        "その後 relayium --help を実行するとすべてのコマンドを確認でき、relayium version でビルドを確認できます。",
      ],
    },
    {
      heading: "ファイルを移動する3つの方法",
      body: [
        "Relayium には3つの転送方法があります。3つの異なるツールを覚える必要はなく、相手先の場所に応じて選ぶだけです。いずれも同じ転送エンジンを共有し、運ぶ各ファイルを SHA-256 ハッシュで検証します。共有していないのは再開です。半端なファイルを次回の実行で続けるのは sync で、push、send、receive はまったく再開しません。",
      ],
      bullets: [
        "up / down（クラウド）：相手がオフラインでも構いません。up はこのマシンで暗号化して暗号文だけをアカウントにアップロードし、リンクを表示します。down はそのリンクで別のマシンから取得・復号します。以前ここにあった SSH 経由の push / pull は廃止されました。",
        "send / receive：送信側の CLI が発行する短いペアリングコードを使って、ネットワークをまたいで他の人へ（relayium login で一度サインインするだけ。受信側は不要です）。発行したコードの有効期限は5分なので、その間に受信側のマシンでコマンドを実行してください。",
        cliDirectFacts.ja,
        "serve + push relayium://（デーモン直結）：自分が所有する2台のサーバー間で、証明書ピンニング付き TLS 上を直接。リレーなし、SSH なし、コードなし。",
      ],
    },
    {
      heading: "一時テキストを送る",
      body: [
        "一方で relayium text を実行してペアリングコードを発行し、もう一方は表示されたコードで参加します：",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "コードの発行には relayium login が必要ですが、コードでの参加にはログイン不要です。",
        "両方の端末がオンラインである必要があります。メッセージはエンドツーエンドで暗号化され、Relayium サーバーは本文を保存しません。",
        cliDirectFacts.ja,
        "各端末は受信したテキストをコピーまたは保持できます。",
        "1メッセージは最大 65,536 UTF-8 バイトです。それより大きい内容には relayium send を使ってください。",
      ],
    },
    {
      heading: "最初の転送",
      body: [
        "最も手早く試せるのは、自分で管理するマシンへフォルダをコピーすることです。そこで Relayium のリスナーを起動し、この送信側を承認すれば、アカウントなしで直接転送できます：",
      ],
      steps: [
        {
          text: "CLI が PATH にあることを確認します。「command not found」ではなくバージョン文字列が表示されます。",
          code: ["relayium version"],
        },
        {
          text: "受信側でディレクトリを作成し、送信側のフィンガープリントを承認してリスナーを起動します。authorize と serve には同じ --config-dir を使う必要があります。",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "リスナーの relayium:// アドレスへフォルダを push します。",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "受信側のマシンで、リスナーの --dir の下に photos/ が現れたことを確認します。",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "成功したときの表示",
        body: [
          "push は完了したファイルごとに1行を表示し、リスナーがバッチを検証して設置すると終了コード 0 で終わります。",
        ],
        code: [
          "relayium push ./photos relayium://receiver.example\n  photos/IMG_0413.jpg (2314518 bytes)\n  photos/IMG_0414.jpg (1998233 bytes)\necho $?\n# 0",
        ],
      },
      bullets: [
        "push は送信前にバッチ全体の衝突チェックを行い、各ファイルを SHA-256 で検証して暫定領域に置いてから設置します。再開はしません。中断されうる実行には relayium sync を使ってください。",
        "リスナーには到達可能である必要があり、この送信側のフィンガープリントをあらかじめ承認している必要があります。",
        "SSH の宛先、relayium pull、-i と -p は廃止されました。逆方向に転送するには、このマシンで serve を実行し、もう一方のマシンから新たにデーモン直結の push を行ってください。",
      ],
    },
    {
      heading: "最初のコマンドが通らないとき",
      body: [
        "初回に起きる不具合は、次の4つで他のすべてを合わせたより多くを占めます。どれも当て推量は要りません。出力で判定できるコマンドがそれぞれにあります。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "インストールスクリプトは成功と言ったのに「relayium: command not found」と出る。",
            code: [
              `command -v relayium
# （何も表示されない）`,
            ],
            fix: "バイナリは入っていますが、その置き場所が PATH にありません。スクリプトの最後の数行が使ったディレクトリを示し、追加すべき export PATH の行をそのまま表示します。それを実行し、新しいシェルを開いて relayium version をもう一度試してください。",
          },
          {
            symptom: "push が「SSH transfers are currently disabled」と表示する。",
            code: [
              "relayium push ./photos <retired-ssh-destination>\n# SSH transfers are currently disabled",
            ],
            fix: "コマンドが廃止された SSH 形式の宛先を使っています。受信側で relayium serve を起動し、代わりに relayium://receiver を宛先にしてください。",
          },
          {
            symptom: "リスナーが送信側を未承認として拒否する。",
            code: [
              "relayium id\n# sha256:...",
            ],
            fix: "受信側で、serve と同じ --config-dir を指定して relayium authorize <sender-fingerprint> を実行してください。動作中のリスナーは次の接続時に新しい承認を読み込みます。",
          },
          {
            symptom: "同じコードに2台が参加し、片方が「the other side is running `relayium text`, not `relayium send`/`relayium receive`」と表示する。",
            code: [
              `# メッセージセッション：両端とも text を実行する
relayium text
relayium text 483920`,
            ],
            fix: "両端が別のコマンドを実行しています。メッセージなら2台とも relayium text、ファイルなら片方が relayium send でもう片方が relayium receive です。この食い違いはダイヤルする前に拒否されるので、何も送られていません。",
          },
        ],
      },
    },
    {
      heading: "無料、そして設計上プライベート",
      body: [
        "転送ごとの料金はありません。デーモン直結の push/sync は自分の2台のマシンの間で内容を直接運び、Relayium のサーバーを通らず、アカウントも不要です。send / receive でサインインが要るのはコードを発行する側だけです（クラウドの up もファイルを保存するためにアカウントを使います）。サーバーがそのコードにリレーを発行した場合、すべてのバイトはその暗号化リレーを、リレーが読めない暗号文として通り、コードを発行したアカウントの月間転送量の枠に計上されます。枠の消費は利用量の計上であって、転送ごとの課金ではありません。",
        "すべての転送はエンドツーエンドで暗号化され、実行が転送した各ファイルは到着時に SHA-256 ハッシュで検証されます。再開はそれより狭い話です。relayium sync は半端なファイルを次回の実行で続け、relayium down は始まった実行の中で再接続して続けますが、push、send、receive はまったく再開しません。macOS、Linux、Windows で動作し、全体がオープンソースでセルフホスト可能です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "CLI に料金はかかりますか？",
        a: "CLI 自体は無料のオープンソースで、デーモン直結の push/sync は使っても費用がかかりません。そのバイトは Relayium のサーバーを通らないため、計測するものがないからです。send / receive と text は中継されたときに計測されます。サーバーがそのコードにリレーを発行した場合、中継されたバイトはコードを発行したアカウントの月間転送量の枠に計上されます。プランの枠を使うのは up と down で、アカウントの下に置かれる暗号化コピーを書き込み、読み戻します。up は4つの別々の上限に計上されます。月間転送量の枠、同時に保存しておけるデータ量のストレージ上限、プランの保存期間の上限、そして1日あたりのアップロード上限です。down はコピーを読み戻す分が月間転送量の枠に計上されます。有料プランではこれらすべてが引き上げられます。",
      },
      {
        q: "Relayium アカウントは必要ですか？",
        a: "send、text、pair でペアリングコードを発行するとき、クラウドの up、そして Device Inbox で必要です。デーモン直結の push/sync には不要です。サーバーはログイン済みアカウントにだけコードを発行するため、作成側は一度 relayium login を実行します。渡されたコードで参加する側はログイン不要で、receive 側もサインインしません。",
      },
      {
        q: "どのオペレーティングシステムに対応していますか？",
        a: "macOS、Linux、Windows 向けに、x86-64 と arm64 の両方でビルド済みバイナリが公開されています。インストールスクリプトは macOS と Linux に対応しています。Windows では、リリースページから .zip をダウンロードしてください。",
      },
      {
        q: "自分のファイルは Relayium のサーバーを通過しますか？",
        a: "デーモン直結の push/sync では通過しません。ファイルのバイトは自分の2台のマシンの間を直接移動します。send / receive と text は小さなランデブーハンドシェイクのために当社のサーバーに接続し、サーバーがそのコードに TURN リレーを発行した場合は、セッションのすべてのバイトがそのリレーを通ります。リレーが読めないエンドツーエンド暗号化された暗号文として運ばれ、コードを発行したアカウントの月間転送量の枠に計上され、保存されることはありません。up は異なります。暗号化したコピーをアカウントのストレージにアップロードし、サーバーはそれを保持しますが読むことはできません。",
      },
    ],
  },
  cta: {
    text: "無料のオープンソース Relayium CLI をインストールして、最初の直接転送をしましょう。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 터미널에서 파일과 텍스트 전송하기",
  description:
    "무료 종단간 암호화 Relayium CLI로 페어링 코드·데몬 다이렉트 파일 전송과 두 기기가 함께 온라인일 때의 일회성 텍스트 전송을 시작하세요.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Relayium CLI는 터미널에서 파일과 일회성 텍스트를 옮기는 작은 단일 바이너리입니다 — 종단간 암호화, 자체 호스팅 가능, AGPL-3.0 라이선스의 무료 오픈소스. 서버로 파일을 복사하거나 기기 사이에 빌드를 보내고, URL·명령·코드 조각을 파일로 저장하지 않고 그대로 전송할 수 있습니다.",
    "데몬 다이렉트(relayium serve와 push 또는 sync)에서는 파일 데이터가 내 두 기기 사이에서 직접 이동하며 Relayium 서버를 거치지 않으므로 아무것도 계량되지 않습니다. 페어링 코드 세션(send / receive, text, pair)은 종단간 암호화되지만, 서버가 해당 코드에 릴레이를 발급하면 모든 바이트가 그 암호화된 릴레이를 거치며 코드를 발급한 계정의 월간 전송량 한도에 집계됩니다. up은 직접 연결이 아닙니다. 암호화된 사본을 계정에 저장합니다. 이 가이드는 설치와 첫 전송까지 안내한 뒤, 각 모드별로 더 깊은 방법을 다루는 글로 안내합니다.",
  ],
  sections: [
    {
      heading: "명령어 하나로 설치",
      prereqs: {
        label: "필요한 것",
        items: [
          "터미널이 있는 macOS, Linux 또는 Windows 기기. 사전 빌드된 바이너리는 세 운영체제 모두에서 x86-64와 arm64를 지원합니다.",
          "macOS와 Linux의 한 줄 설치에 쓰이는 curl. curl --version 이 버전을 출력합니다. Windows에서는 릴리스 페이지에서 .zip을 내려받으세요.",
          "쓰기 가능한 설치 디렉터리. 스크립트는 쓸 수 있으면 /usr/local/bin을, 아니면 ~/.local/bin을 사용하고, 마지막 줄에서 어느 쪽을 골랐는지 알려 줍니다.",
          "데몬 다이렉트 push와 sync에는 그 밖에 필요한 것이 없습니다. 무료 Relayium 계정이 필요한 것은 send, text, pair로 페어링 코드를 발급할 때, up으로 올릴 때, 그리고 Device Inbox를 쓸 때뿐입니다.",
        ],
      },
      body: [
        "macOS나 Linux에서는 명령어 하나로 사용 중인 OS용 사전 빌드된 바이너리를 내려받아 PATH에 등록할 수 있습니다:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "직접 파일을 고르고 싶나요? 릴리스 페이지에서 바이너리를 내려받으세요.",
        "Go가 설치되어 있나요? 저장소를 clone한 뒤 다음을 실행하세요: go build ./cmd/relayium (server 디렉터리에서).",
        "이후 relayium --help로 모든 명령어를 확인하고, relayium version으로 빌드를 확인하세요.",
      ],
    },
    {
      heading: "파일을 옮기는 세 가지 방식",
      body: [
        "Relayium은 세 가지 방식으로 파일을 옮깁니다. 세 가지 다른 도구를 배울 필요 없이, 상대가 어디에 있는지에 따라 고르기만 하면 됩니다 — 모두 동일한 전송 엔진을 공유하며 옮기는 각 파일을 SHA-256 해시로 검증합니다. 공유하지 않는 것은 재개입니다: 부분 파일을 다음 실행에서 이어가는 것은 sync이고, push, send, receive는 전혀 재개하지 않습니다.",
      ],
      bullets: [
        "up / down(클라우드) — 상대가 오프라인이어도 됩니다. up은 이 기기에서 암호화해 암호문만 계정에 올리고 링크를 표시하며, down은 그 링크로 다른 기기에서 가져와 복호화합니다. 예전에 여기 있던 SSH 기반 push / pull은 폐지되었습니다.",
        "send / receive — 보내는 쪽 CLI가 발급하는 짧은 페어링 코드를 사용해 네트워크를 넘어 다른 사람에게(relayium login으로 한 번만 로그인하면 되고, 받는 쪽은 로그인하지 않습니다). 발급된 코드는 5분 동안만 유효하니, 그 안에 받는 쪽 머신에서 명령을 실행하세요.",
        cliDirectFacts.ko,
        "serve + push relayium://(데몬 다이렉트) — 직접 소유한 두 서버 사이에서, 인증서 고정 TLS를 통해 곧바로. 중계도, SSH도, 코드도 필요 없습니다.",
      ],
    },
    {
      heading: "일회성 텍스트 보내기",
      body: [
        "한 기기에서 relayium text로 페어링 코드를 발급하고, 다른 기기에서 출력된 코드로 참여하세요:",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "코드 발급에는 relayium login이 필요하지만 코드로 참여할 때는 로그인하지 않습니다.",
        "두 기기가 함께 온라인이어야 합니다. 메시지는 종단간 암호화되며 Relayium 서버는 본문을 저장하지 않습니다.",
        cliDirectFacts.ko,
        "각 엔드포인트는 받은 텍스트를 복사하거나 보관할 수 있습니다.",
        "메시지 하나는 최대 65,536 UTF-8바이트입니다. 더 큰 내용은 relayium send를 사용하세요.",
      ],
    },
    {
      heading: "첫 전송",
      body: [
        "가장 빠르게 시도해 볼 수 있는 것은 직접 관리하는 기기로 폴더를 복사하는 것입니다. 그 기기에서 Relayium 리스너를 실행하고 이 보내는 쪽을 승인하면, 계정 없이 직접 전송할 수 있습니다:",
      ],
      steps: [
        {
          text: "CLI가 PATH에 있는지 확인합니다. “command not found”가 아니라 버전 문자열이 출력됩니다.",
          code: ["relayium version"],
        },
        {
          text: "받는 쪽에서 디렉터리를 만들고, 보내는 쪽의 지문을 승인한 뒤 리스너를 시작합니다. authorize와 serve는 같은 --config-dir를 써야 합니다.",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "리스너의 relayium:// 주소로 폴더를 push합니다.",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "받는 기기에서 리스너의 --dir 아래에 photos/가 생겼는지 확인합니다.",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "성공했을 때 보이는 것",
        body: [
          "push는 완료된 파일마다 한 줄을 표시하고, 리스너가 배치를 검증하고 설치하면 종료 코드 0으로 끝납니다.",
        ],
        code: [
          "relayium push ./photos relayium://receiver.example\n  photos/IMG_0413.jpg (2314518 bytes)\n  photos/IMG_0414.jpg (1998233 bytes)\necho $?\n# 0",
        ],
      },
      bullets: [
        "push는 보내기 전에 배치의 충돌을 검사하고, 각 파일을 SHA-256으로 검증한 뒤 스테이징했다가 설치합니다. 재개는 하지 않으므로, 중단될 수 있는 실행에는 relayium sync를 쓰세요.",
        "리스너는 도달 가능해야 하며, 이 보내는 쪽의 지문을 미리 승인해 두어야 합니다.",
        "SSH 대상, relayium pull, -i와 -p는 폐지되었습니다. 반대 방향으로 전송하려면 이 기기에서 serve를 실행하고 다른 기기에서 새 데몬 다이렉트 push를 시작하세요.",
      ],
    },
    {
      heading: "첫 명령이 안 될 때",
      body: [
        "첫 실행에서 어긋나는 일은 아래 네 가지가 나머지 전부를 합친 것보다 많습니다. 어느 것도 추측이 필요 없고, 각각 출력으로 판정해 주는 명령이 있습니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "설치 스크립트는 성공했다고 했는데 “relayium: command not found”가 뜹니다.",
            code: [
              `command -v relayium
# (아무것도 출력되지 않음)`,
            ],
            fix: "바이너리는 설치됐지만 그 디렉터리가 PATH에 없습니다. 스크립트의 마지막 줄들이 사용한 디렉터리를 알려 주고 추가할 export PATH 줄을 그대로 출력합니다. 그것을 실행한 뒤 새 셸을 열고 relayium version 을 다시 시도하세요.",
          },
          {
            symptom: "push가 “SSH transfers are currently disabled”를 표시합니다.",
            code: [
              "relayium push ./photos <retired-ssh-destination>\n# SSH transfers are currently disabled",
            ],
            fix: "명령이 폐지된 SSH 형식의 대상을 쓰고 있습니다. 받는 쪽에서 relayium serve를 시작하고 대신 relayium://receiver를 대상으로 쓰세요.",
          },
          {
            symptom: "리스너가 보내는 쪽을 승인되지 않았다며 거부합니다.",
            code: [
              "relayium id\n# sha256:...",
            ],
            fix: "받는 쪽에서 serve와 같은 --config-dir로 relayium authorize <sender-fingerprint>를 실행하세요. 실행 중인 리스너는 다음 연결 때 새 승인을 읽어 들입니다.",
          },
          {
            symptom: "두 기기가 같은 코드에 들어갔는데 한쪽이 “the other side is running `relayium text`, not `relayium send`/`relayium receive`”를 출력합니다.",
            code: [
              `# 메시지 세션: 양쪽 모두 text 를 실행
relayium text
relayium text 483920`,
            ],
            fix: "양쪽이 서로 다른 명령을 실행했습니다. 메시지는 두 기기 모두 relayium text, 파일은 한쪽이 relayium send 다른 쪽이 relayium receive 입니다. 이 불일치는 연결을 걸기 전에 거부되므로 아무것도 전송되지 않았습니다.",
          },
        ],
      },
    },
    {
      heading: "무료이며, 설계상 프라이버시를 지킵니다",
      body: [
        "전송별 요금은 없습니다. 데몬 다이렉트 push/sync는 내 두 기기 사이에서 내용을 직접 옮기며 Relayium 서버를 거치지 않고 계정도 필요 없습니다. send / receive에서 로그인이 필요한 쪽은 코드를 발급하는 쪽뿐입니다(클라우드 up도 파일을 저장하기 위해 계정을 사용합니다). 서버가 해당 코드에 릴레이를 발급하면 모든 바이트가 릴레이가 읽을 수 없는 암호문으로 그 암호화된 릴레이를 거치며, 코드를 발급한 계정의 월간 전송량 한도에 집계됩니다. 한도 사용은 사용량 집계일 뿐 전송별 과금이 아닙니다.",
        "모든 전송은 종단간 암호화되고, 한 번의 실행이 전송한 모든 파일은 도착 시 SHA-256 해시로 검증됩니다. 재개는 그보다 좁습니다: relayium sync는 부분 파일을 다음 실행에서 이어가고, relayium down은 시작된 실행 안에서 다시 연결해 이어가지만, push, send, receive는 전혀 재개하지 않습니다. macOS, Linux, Windows에서 동작하며, 전체가 오픈소스이고 자체 호스팅이 가능합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "CLI 사용에 비용이 드나요?",
        a: "CLI 자체는 무료 오픈소스이며, 직접 연결 모드인 데몬 다이렉트 push/sync는 사용해도 비용이 들지 않습니다. 그 데이터는 Relayium 서버를 거치지 않으므로 계량할 것이 없습니다. send / receive와 text는 릴레이될 때 계량됩니다. 서버가 해당 코드에 릴레이를 발급하면, 릴레이된 바이트는 코드를 발급한 계정의 월간 전송량 한도에 집계됩니다. 요금제 한도를 쓰는 명령은 up과 down으로, 계정 아래에 보관되는 암호화 사본을 쓰고 다시 읽어 옵니다. up은 네 가지 별도 한도에 포함됩니다. 월간 트래픽 허용량, 한 번에 저장해 둘 수 있는 양에 대한 저장 용량 한도, 요금제의 보관 기간 상한, 그리고 일일 업로드 한도입니다. down은 사본을 읽어 올 때 월간 트래픽 허용량에 포함됩니다. 유료 요금제는 이 모두를 높여 줍니다.",
      },
      {
        q: "Relayium 계정이 필요한가요?",
        a: "send, text, pair로 페어링 코드를 발급할 때, 클라우드 up, 그리고 Device Inbox에 필요합니다. 데몬 다이렉트 push/sync에는 계정이 필요 없습니다. 서버는 로그인된 계정에만 코드를 발급하므로 생성 측이 relayium login을 한 번 실행합니다. 전달받은 코드로 참여하는 쪽과 receive 수신자는 로그인하지 않습니다.",
      },
      {
        q: "어떤 운영체제를 지원하나요?",
        a: "macOS, Linux, Windows용으로 x86-64와 arm64 모두 사전 빌드된 바이너리가 제공됩니다. 설치 스크립트는 macOS와 Linux를 지원합니다. Windows에서는 릴리스 페이지에서 .zip을 내려받으세요.",
      },
      {
        q: "제 파일이 Relayium 서버를 거치나요?",
        a: "데몬 다이렉트 push/sync에서는 거치지 않습니다. 파일 데이터가 내 두 기기 사이에서 직접 이동합니다. send / receive와 text는 작은 랑데부 핸드셰이크를 위해 저희 서버에 연결하며, 서버가 해당 코드에 TURN 릴레이를 발급하면 세션의 모든 바이트가 그 릴레이를 거칩니다 — 릴레이가 읽을 수 없는 종단간 암호화된 암호문으로, 코드를 발급한 계정의 월간 전송량 한도에 집계되며 저장되지 않습니다. up은 다릅니다. 암호화된 사본을 계정의 저장소에 업로드하며, 서버는 이를 보관하지만 읽을 수 없습니다.",
      },
    ],
  },
  cta: {
    text: "무료 오픈소스 Relayium CLI를 설치하고 첫 직접 전송을 해보세요.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien und Text mit der Relayium CLI vom Terminal übertragen",
  description:
    "Nutze die kostenlose, Ende-zu-Ende-verschlüsselte Relayium CLI für Dateien per Pairing-Code oder daemon-direct — und für flüchtigen Text, solange beide Rechner online sind.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Die Relayium CLI ist ein kleines einzelnes Binary für Dateien und flüchtigen Text im Terminal — Ende-zu-Ende-verschlüsselt, selbst hostbar und kostenlos. Kopiere Dateien auf Server, pushe Builds zwischen Maschinen oder sende URLs, Befehle und Codeausschnitte, ohne sie erst als Datei zu speichern.",
    "Bei daemon-direct — relayium serve mit push oder sync — wandern die Dateibytes direkt zwischen deinen beiden Rechnern und laufen nie über Relayiums Server, daher wird nichts gezählt. Die Pairing-Code-Sitzungen (send / receive, text und pair) sind Ende-zu-Ende-verschlüsselt, doch sobald der Server für den Code ein Relay ausstellt, läuft jedes Byte über dieses verschlüsselte Relay und zählt zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat. up ist nicht direkt: Es speichert eine verschlüsselte Kopie unter deinem Konto. Diese Anleitung bringt dich zur Installation und durch deine erste Übertragung und verweist dich dann auf die ausführlicheren Anleitungen zu jedem Modus.",
  ],
  sections: [
    {
      heading: "Installation mit einem Befehl",
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Einen Rechner mit Terminal unter macOS, Linux oder Windows. Vorgebaute Binaries gibt es für alle drei, jeweils für x86-64 und arm64.",
          "curl für die Ein-Zeilen-Installation unter macOS und Linux — curl --version gibt eine Version aus. Unter Windows lädst du stattdessen das .zip von der Releases-Seite.",
          "Ein beschreibbares Installationsverzeichnis. Das Skript nimmt /usr/local/bin, wenn es dort schreiben darf, sonst ~/.local/bin, und seine letzten Zeilen nennen das gewählte.",
          "Für daemon-direct push und sync sonst nichts. Ein kostenloses Relayium-Konto brauchen nur das Erzeugen eines Pairing-Codes mit send, text oder pair, das Hochladen mit up und die Device Inbox.",
        ],
      },
      body: [
        "Unter macOS oder Linux lädt ein Befehl ein vorkompiliertes Binary für dein Betriebssystem herunter und legt es in deinen PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Möchtest du die Datei lieber selbst auswählen? Lade ein Binary von der Releases-Seite herunter.",
        "Go installiert? Clone das Repository und führe go build ./cmd/relayium im server-Verzeichnis aus.",
        "Führe dann relayium --help aus, um alle Befehle zu sehen, und relayium version, um den Build zu prüfen.",
      ],
    },
    {
      heading: "Die drei Wege, Dateien zu bewegen",
      body: [
        "Relayium bewegt Dateien auf drei Arten. Du wählst danach, wo sich die Gegenstelle befindet, nicht indem du drei verschiedene Werkzeuge lernst — sie teilen sich eine Übertragungs-Engine, die jede bewegte Datei per SHA-256-Hash prüft. Was sie sich nicht teilen, ist das Fortsetzen: sync ist der Modus, der eine Teildatei in einem späteren Lauf weiterführt, und push, send und receive setzen gar nicht fort.",
      ],
      bullets: [
        "up / down (Cloud) — die Gegenstelle darf offline sein. up verschlüsselt auf diesem Rechner, lädt nur den Chiffretext unter dein Konto hoch und gibt einen Link aus; down holt und entschlüsselt ihn mit dem Link auf einem anderen Rechner. Das früher hier genannte push / pull über SSH ist eingestellt.",
        "send / receive — an eine andere Person netzwerkübergreifend, mit einem kurzen Pairing-Code, den die CLI des Absenders erzeugt (einmalig mit relayium login anmelden; der Empfänger nie). Ein erzeugter Code gilt fünf Minuten — starte den Befehl auf der empfangenden Maschine in diesem Fenster.",
        cliDirectFacts.de,
        "serve + push relayium:// (daemon-direct) — direkt zwischen zwei Servern, die dir gehören, über TLS mit Pinning. Kein Relay, kein SSH, kein Code.",
      ],
    },
    {
      heading: "Flüchtigen Text senden",
      body: [
        "Führe auf einem Rechner relayium text aus, um einen Pairing-Code zu erzeugen; der andere tritt mit dem ausgegebenen Code bei:",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "Das Erzeugen des Codes braucht relayium login; der Beitritt mit einem Code braucht keine Anmeldung.",
        "Beide Rechner müssen online bleiben. Nachrichten sind Ende-zu-Ende verschlüsselt; Relayium-Server speichern ihre Inhalte nicht.",
        cliDirectFacts.de,
        "Beide Endpunkte können empfangenen Text dennoch kopieren oder behalten.",
        "Eine Nachricht umfasst höchstens 65.536 UTF-8-Bytes. Für größere Inhalte nutze relayium send.",
      ],
    },
    {
      heading: "Deine erste Übertragung",
      body: [
        "Am schnellsten lässt sich ausprobieren, einen Ordner auf einen Rechner zu kopieren, den du verwaltest. Starte dort einen Relayium-Listener, autorisiere diesen Absender und übertrage direkt, ganz ohne Konto:",
      ],
      steps: [
        {
          text: "Prüf, ob die CLI in deinem PATH liegt. Sie gibt eine Versionsnummer aus, nicht „command not found“.",
          code: ["relayium version"],
        },
        {
          text: "Lege auf dem Empfänger das Verzeichnis an, autorisiere den Fingerabdruck des Absenders und starte den Listener. authorize und serve müssen dasselbe --config-dir verwenden.",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "Pushe den Ordner an die relayium://-Adresse des Listeners.",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "Prüfe auf dem empfangenden Rechner, dass photos/ unter dem --dir des Listeners erschienen ist.",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Lauf aus",
        body: [
          "push gibt pro abgeschlossener Datei eine Zeile aus und endet mit 0, nachdem der Listener den Stapel geprüft und installiert hat.",
        ],
        code: [
          "relayium push ./photos relayium://receiver.example\n  photos/IMG_0413.jpg (2314518 bytes)\n  photos/IMG_0414.jpg (1998233 bytes)\necho $?\n# 0",
        ],
      },
      bullets: [
        "push prüft den Stapel vor dem Senden auf Kollisionen, verifiziert jede Datei per SHA-256 und lagert sie vor der Installation zwischen. Fortgesetzt wird nicht; nimm relayium sync, wenn ein Lauf unterbrochen werden kann.",
        "Der Listener muss erreichbar sein und den Fingerabdruck dieses Absenders bereits autorisiert haben.",
        "SSH-Ziele, relayium pull, -i und -p sind eingestellt. Für die Gegenrichtung starte serve auf diesem Rechner und beginne vom anderen aus einen neuen daemon-direct-push.",
      ],
    },
    {
      heading: "Wenn der erste Befehl nicht durchgeht",
      body: [
        "Vier Dinge gehen beim ersten Lauf häufiger schief als alles andere zusammen. Keins davon musst du raten — zu jedem gibt es einen Befehl, dessen Ausgabe die Sache entscheidet.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "„relayium: command not found“, direkt nachdem das Installationsskript Erfolg gemeldet hat.",
            code: [
              `command -v relayium
# (gibt nichts aus)`,
            ],
            fix: "Das Binary ist installiert, sein Verzeichnis liegt aber nicht im PATH. Die letzten Zeilen des Skripts nennen das verwendete Verzeichnis und geben die passende export-PATH-Zeile aus; führ sie aus, öffne eine neue Shell und probier relayium version noch einmal.",
          },
          {
            symptom: "push meldet „SSH transfers are currently disabled“.",
            code: [
              "relayium push ./photos <retired-ssh-destination>\n# SSH transfers are currently disabled",
            ],
            fix: "Der Befehl nutzt die eingestellte SSH-Zielform. Starte relayium serve auf dem Empfänger und nimm stattdessen relayium://receiver als Ziel.",
          },
          {
            symptom: "Der Listener lehnt den Absender als nicht autorisiert ab.",
            code: [
              "relayium id\n# sha256:...",
            ],
            fix: "Führe auf dem Empfänger relayium authorize <sender-fingerprint> mit demselben --config-dir aus, das serve nutzt. Ein laufender Listener liest die neue Autorisierung bei der nächsten Verbindung.",
          },
          {
            symptom: "Zwei Rechner treten demselben Code bei und einer gibt „the other side is running `relayium text`, not `relayium send`/`relayium receive`“ aus.",
            code: [
              `# Nachrichtensitzung: BEIDE Enden führen text aus
relayium text
relayium text 483920`,
            ],
            fix: "Die beiden Enden haben verschiedene Befehle ausgeführt. Für Nachrichten auf beiden Rechnern relayium text, für Dateien auf einem relayium send und auf dem anderen relayium receive. Die Nichtübereinstimmung wird abgelehnt, bevor überhaupt gewählt wird, es wurde also nichts gesendet.",
          },
        ],
      },
    },
    {
      heading: "Kostenlos und von Grund auf privat",
      body: [
        "Es gibt keine Gebühr pro Übertragung. daemon-direct push/sync bewegt Inhalte direkt zwischen deinen beiden Rechnern, nie über Relayiums Server, und braucht kein Konto. Bei send / receive meldet sich nur die Seite an, die den Code erzeugt (auch Cloud-up nutzt dein Konto, um die Datei zu speichern). Sobald der Server für den Code ein Relay ausstellt, läuft jedes Byte als Chiffretext, den das Relay nicht lesen kann, über dieses verschlüsselte Relay und zählt zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat. Das Verbrauchen eines Kontingents ist Nutzungserfassung, keine Gebühr pro Übertragung.",
        "Jede Übertragung ist Ende-zu-Ende verschlüsselt, und jede Datei, die ein Lauf überträgt, wird bei Ankunft mit einem SHA-256-Hash geprüft. Fortsetzen ist enger gefasst: relayium sync führt eine Teildatei in einem späteren Lauf weiter, relayium down verbindet sich innerhalb des laufenden Vorgangs neu und macht dort weiter, und push, send und receive setzen gar nicht fort. Sie läuft unter macOS, Linux und Windows, und das Ganze ist Open Source und selbst hostbar.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kostet die CLI etwas?",
        a: "Die CLI selbst ist kostenlos und quelloffen, und der direkte Modus daemon-direct push/sync kostet nichts: Diese Bytes laufen nie über Relayiums Server, es gibt also nichts zu messen. send / receive und text werden gezählt, wenn sie weitergeleitet werden: Sobald der Server für den Code ein Relay ausstellt, zählen die weitergeleiteten Bytes zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat. Deinen Tarif belasten außerdem up und down, die eine verschlüsselte Kopie unter deinem Konto schreiben und zurücklesen. up zählt gegen vier separate Limits — dein monatliches Datenkontingent, das Speicherlimit dafür, wie viel du gleichzeitig gespeichert hältst, die Aufbewahrungsdauer deines Tarifs und ein tägliches Upload-Limit —, und down zählt beim Zurücklesen der Kopie gegen das Datenkontingent; bezahlte Tarife erhöhen sie alle.",
      },
      {
        q: "Brauche ich ein Relayium-Konto?",
        a: "Zum Erzeugen eines Pairing-Codes mit send, text oder pair, für Cloud-up und für die Device Inbox. daemon-direct push/sync braucht kein Konto. Der Server erzeugt Codes nur für angemeldete Konten, daher führt die erstellende Seite einmal relayium login aus. Wer mit einem erhaltenen Code beitritt, braucht keine Anmeldung; auch receive meldet sich nie an.",
      },
      {
        q: "Welche Betriebssysteme werden unterstützt?",
        a: "Vorkompilierte Binaries werden für macOS, Linux und Windows veröffentlicht, jeweils für x86-64 und arm64. Das Installationsskript deckt macOS und Linux ab; unter Windows lädst du die .zip von der Releases-Seite herunter.",
      },
      {
        q: "Laufen meine Dateien über Relayiums Server?",
        a: "Bei daemon-direct push/sync nicht: Die Dateibytes wandern direkt zwischen deinen beiden Rechnern. send / receive und text kontaktieren unsere Server für einen kleinen Rendezvous-Handshake, und sobald der Server für den Code ein TURN-Relay ausstellt, läuft jedes Byte der Sitzung über dieses Relay — als Ende-zu-Ende-verschlüsselter Chiffretext, den es nicht lesen kann, gezählt zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat, und nie gespeichert. up ist anders: Es lädt eine verschlüsselte Kopie in den Speicher deines Kontos hoch, die der Server aufbewahrt, aber nicht lesen kann.",
      },
    ],
  },
  cta: {
    text: "Installiere die kostenlose, quelloffene Relayium CLI und mach deine erste direkte Übertragung.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer fichiers et texte depuis le terminal avec la CLI Relayium",
  description:
    "Utilisez la CLI Relayium gratuite et chiffrée de bout en bout pour les fichiers par code d'appairage ou daemon-direct — et le texte éphémère quand les deux machines sont en ligne.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "La CLI Relayium est un petit binaire unique pour transférer fichiers et texte éphémère depuis le terminal — chiffré de bout en bout, auto-hébergeable et gratuit. Copiez des fichiers vers un serveur, poussez un build, ou envoyez URL, commandes et code sans les enregistrer d'abord dans un fichier.",
    "En daemon-direct — relayium serve avec push ou sync —, les octets du fichier voyagent directement entre vos deux machines et ne passent jamais par les serveurs de Relayium : rien n'est décompté. Les sessions à code d'appairage (send / receive, text et pair) sont chiffrées de bout en bout, mais dès que le serveur attribue un relais pour le code, chaque octet passe par ce relais chiffré et est décompté du quota mensuel de trafic du compte qui a généré le code. up n'est pas direct : il stocke une copie chiffrée sous votre compte. Ce guide vous installe et vous fait passer votre premier transfert, puis vous oriente vers les guides plus détaillés pour chaque mode.",
  ],
  sections: [
    {
      heading: "Installation en une commande",
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Une machine macOS, Linux ou Windows avec un terminal. Des binaires précompilés couvrent x86-64 et arm64 sur les trois.",
          "curl, pour l'installation en une ligne sous macOS et Linux — curl --version affiche une version. Sous Windows, téléchargez plutôt le .zip depuis la page des releases.",
          "Un répertoire d'installation accessible en écriture. Le script prend /usr/local/bin s'il peut y écrire, sinon ~/.local/bin, et ses dernières lignes nomment celui qu'il a retenu.",
          "Rien d'autre pour push ou sync en daemon-direct. Seuls la génération d'un code d'appairage avec send, text ou pair, l'envoi avec up et la Device Inbox demandent un compte Relayium gratuit.",
        ],
      },
      body: [
        "Sous macOS ou Linux, une commande télécharge un binaire précompilé pour votre OS et l'ajoute à votre PATH :",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Vous préférez choisir le fichier vous-même ? Téléchargez un binaire depuis la page des releases.",
        "Go est installé ? Clonez le dépôt et lancez : go build ./cmd/relayium (depuis le répertoire server).",
        "Lancez ensuite relayium --help pour voir toutes les commandes, et relayium version pour vérifier le build.",
      ],
    },
    {
      heading: "Les trois façons de déplacer des fichiers",
      body: [
        "Relayium déplace les fichiers de trois façons. Vous choisissez selon où se trouve l'autre bout, sans avoir à apprendre trois outils différents — ils partagent un seul moteur de transfert, qui vérifie chaque fichier déplacé par une empreinte SHA-256. Ce qu'ils ne partagent pas, c'est la reprise : sync est le mode qui poursuit un fichier partiel lors d'une exécution ultérieure, et push, send et receive ne reprennent pas du tout.",
      ],
      bullets: [
        "up / down (cloud) — l'autre bout peut être hors ligne. up chiffre sur cette machine, téléverse seulement le texte chiffré sous votre compte et affiche un lien ; down le récupère et le déchiffre ailleurs avec ce lien. Le push / pull via SSH qui figurait ici est retiré.",
        "send / receive — vers une autre personne entre réseaux différents, avec un court code d'appairage que la CLI de l'expéditeur génère (connectez-vous une fois avec relayium login ; le destinataire, jamais). Un code émis est valable cinq minutes : lancez la commande sur la machine réceptrice dans ce délai.",
        cliDirectFacts.fr,
        "serve + push relayium:// (daemon-direct) — directement entre deux serveurs qui vous appartiennent, via TLS avec épinglage. Pas de relais, pas de SSH, pas de code.",
      ],
    },
    {
      heading: "Envoyer du texte éphémère",
      body: [
        "Lancez relayium text sur une machine pour créer un code d'appairage, puis rejoignez depuis l'autre avec le code affiché :",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "Créer le code nécessite relayium login ; le rejoindre ne nécessite aucune connexion.",
        "Les deux machines doivent rester en ligne. Les messages sont chiffrés de bout en bout et les serveurs Relayium ne stockent pas leur corps.",
        cliDirectFacts.fr,
        "Chaque extrémité peut néanmoins copier ou conserver le texte reçu.",
        "Un message fait au plus 65 536 octets UTF-8. Utilisez relayium send pour un contenu plus grand.",
      ],
    },
    {
      heading: "Votre premier transfert",
      body: [
        "Le plus rapide à essayer est de copier un dossier vers une machine que vous gérez. Lancez-y un écouteur Relayium, autorisez cet expéditeur et transférez directement, sans compte :",
      ],
      steps: [
        {
          text: "Vérifiez que la CLI est dans votre PATH. Elle affiche un numéro de version, et non « command not found ».",
          code: ["relayium version"],
        },
        {
          text: "Sur le destinataire, créez le répertoire, autorisez l'empreinte de l'expéditeur et démarrez l'écouteur. authorize et serve doivent utiliser le même --config-dir.",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "Poussez le dossier vers l'adresse relayium:// de l'écouteur.",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "Sur la machine destinataire, vérifiez que photos/ est apparu sous le --dir de l'écouteur.",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "À quoi ressemble une exécution réussie",
        body: [
          "push affiche une ligne par fichier terminé et se termine avec 0 une fois que l'écouteur a vérifié et installé le lot.",
        ],
        code: [
          "relayium push ./photos relayium://receiver.example\n  photos/IMG_0413.jpg (2314518 bytes)\n  photos/IMG_0414.jpg (1998233 bytes)\necho $?\n# 0",
        ],
      },
      bullets: [
        "push contrôle les collisions du lot avant l'envoi, vérifie chaque fichier par SHA-256 et le met en zone d'attente avant de l'installer. Il ne reprend pas ; utilisez relayium sync quand une exécution peut être interrompue.",
        "L'écouteur doit être joignable et avoir déjà autorisé l'empreinte de cet expéditeur.",
        "Les destinations SSH, relayium pull, -i et -p sont retirés. Pour transférer dans l'autre sens, lancez serve sur cette machine et démarrez un nouveau push daemon-direct depuis l'autre.",
      ],
    },
    {
      heading: "Quand la première commande ne passe pas",
      body: [
        "Quatre choses tournent mal au premier essai plus souvent que tout le reste réuni. Aucune ne demande de deviner : chacune a une commande dont la sortie tranche la question.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "« relayium: command not found », juste après que le script d'installation a annoncé une réussite.",
            code: [
              `command -v relayium
# (n'affiche rien)`,
            ],
            fix: "Le binaire est installé, mais son répertoire n'est pas dans votre PATH. Les dernières lignes du script nomment le répertoire retenu et affichent la ligne export PATH exacte à ajouter. Exécutez-la, ouvrez un nouveau shell et relancez relayium version.",
          },
          {
            symptom: "push affiche « SSH transfers are currently disabled ».",
            code: [
              "relayium push ./photos <retired-ssh-destination>\n# SSH transfers are currently disabled",
            ],
            fix: "La commande utilise la forme de destination SSH retirée. Lancez relayium serve sur le destinataire et utilisez plutôt relayium://receiver.",
          },
          {
            symptom: "L'écouteur refuse l'expéditeur comme non autorisé.",
            code: [
              "relayium id\n# sha256:...",
            ],
            fix: "Exécutez relayium authorize <sender-fingerprint> sur le destinataire avec le même --config-dir que serve. Un écouteur en cours d'exécution lit la nouvelle autorisation à la connexion suivante.",
          },
          {
            symptom: "Deux machines rejoignent le même code et l'une affiche « the other side is running `relayium text`, not `relayium send`/`relayium receive` ».",
            code: [
              `# session de messages : les DEUX extrémités lancent text
relayium text
relayium text 483920`,
            ],
            fix: "Les deux extrémités ont lancé des commandes différentes. Pour des messages, relayium text sur les deux machines ; pour des fichiers, relayium send d'un côté et relayium receive de l'autre. Le désaccord est refusé avant même toute tentative de connexion, donc rien n'a été envoyé.",
          },
        ],
      },
    },
    {
      heading: "Gratuit, et privé par conception",
      body: [
        "Il n'y a aucun frais par transfert. push/sync en daemon-direct déplace le contenu directement entre vos deux machines, jamais par les serveurs de Relayium, et ne demande aucun compte. Avec send / receive, seul le côté qui génère le code se connecte (le up cloud utilise aussi votre compte, pour stocker le fichier). Dès que le serveur attribue un relais pour le code, chaque octet passe par ce relais chiffré, sous forme de texte chiffré qu'il ne peut pas lire, et est décompté du quota mensuel de trafic du compte qui a généré le code. Consommer un quota relève de la comptabilisation de l'usage, pas d'un paiement par transfert.",
        "Chaque transfert est chiffré de bout en bout, et chaque fichier transféré par une exécution est vérifié par une empreinte SHA-256 à l'arrivée. La reprise est plus étroite que le reste : relayium sync poursuit un fichier partiel lors d'une exécution ultérieure, relayium down se reconnecte et poursuit à l'intérieur de l'exécution qui l'a lancé, et push, send et receive ne reprennent pas du tout. Cela fonctionne sous macOS, Linux et Windows, et l'ensemble est open source et auto-hébergeable.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La CLI coûte-t-elle quelque chose ?",
        a: "La CLI elle-même est gratuite et open source, et push/sync en daemon-direct ne coûte rien à l'usage : ces octets ne passent jamais par les serveurs de Relayium, il n'y a donc rien à mesurer. send / receive et text sont décomptés lorsqu'ils sont relayés : dès que le serveur attribue un relais pour le code, les octets relayés sont décomptés du quota mensuel de trafic du compte qui a généré le code. Puisent aussi dans votre offre up et down, qui écrivent et relisent une copie chiffrée conservée sous votre compte. up compte dans quatre limites distinctes — votre quota de trafic mensuel, la limite de stockage pour ce que vous gardez stocké à la fois, la durée de conservation maximale de votre offre et une limite d'envoi quotidienne — et down compte dans le quota de trafic lorsqu'il relit la copie. Les offres payantes les relèvent toutes.",
      },
      {
        q: "Ai-je besoin d'un compte Relayium ?",
        a: "Pour créer un code d'appairage avec send, text ou pair, pour le up cloud et pour la Device Inbox. push/sync en daemon-direct ne nécessite aucun compte. Le serveur ne crée des codes que pour un compte connecté : le créateur lance donc relayium login une fois. Rejoindre avec un code reçu ne demande aucune connexion ; receive non plus.",
      },
      {
        q: "Quels systèmes d'exploitation sont pris en charge ?",
        a: "Des binaires précompilés sont publiés pour macOS, Linux et Windows, en x86-64 comme en arm64. Le script d'installation couvre macOS et Linux ; sous Windows, téléchargez le .zip depuis la page des releases.",
      },
      {
        q: "Mes fichiers passent-ils par les serveurs de Relayium ?",
        a: "Pas avec push/sync en daemon-direct : les octets du fichier voyagent directement entre vos deux machines. send / receive et text contactent nos serveurs pour une petite poignée de main de rendez-vous, et dès que le serveur attribue un relais TURN pour le code, chaque octet de la session passe par ce relais — sous forme de texte chiffré de bout en bout qu'il ne peut pas lire, décompté du quota mensuel de trafic du compte qui a généré le code, et jamais stocké. up est différent : il téléverse une copie chiffrée dans le stockage de votre compte, que le serveur conserve sans pouvoir la lire.",
      },
    ],
  },
  cta: {
    text: "Installez la CLI Relayium, gratuite et open source, et effectuez votre premier transfert direct.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "انقل الملفات والنصوص من الطرفية باستخدام Relayium CLI",
  description:
    "استخدم Relayium CLI المجاني والمشفّر من الطرف إلى الطرف لنقل الملفات عبر رمز اقتران أو daemon direct، ولإرسال نص مؤقت حين يكون الجهازان متصلين.",
  updatedLabel: "آخر تحديث",
  lead: [
    "‏Relayium CLI ملف ثنائي صغير لنقل الملفات والنص المؤقت من الطرفية — مشفّر من الطرف إلى الطرف، قابل للاستضافة الذاتية، ومجاني. انسخ الملفات إلى خادم، أو انقل نسخة بناء، أو أرسل رابطًا أو أمرًا أو مقطع كود دون حفظه أولًا كملف.",
    "في daemon direct — أي relayium serve مع push أو sync — تنتقل بايتات الملف مباشرة بين جهازيك ولا تمر أبدًا عبر خوادم Relayium، فلا يُحتسب شيء. أما جلسات رمز الاقتران (send / receive وtext وpair) فمشفّرة من الطرف إلى الطرف، لكن كلما أصدر الخادم مُرحِّلًا للرمز مرّ كل بايت عبر هذا المُرحِّل المُشفَّر واحتُسب ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز. أما up فليس مباشرًا: إنه يخزّن نسخة مُشفَّرة تحت حسابك. يوصلك هذا الدليل إلى التثبيت وإتمام أول عملية نقل لك، ثم يوجّهك إلى الأدلة الأعمق لكل وضع.",
  ],
  sections: [
    {
      heading: "التثبيت بأمر واحد",
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "جهاز فيه طرفية يعمل بنظام macOS أو Linux أو Windows. تغطي الملفات الثنائية مُسبقة البناء معماريتَي x86-64 وarm64 على الأنظمة الثلاثة.",
          "الأداة curl من أجل التثبيت بسطر واحد على macOS وLinux، ويطبع curl --version رقم الإصدار. أما على Windows فنزّل ملف zip. من صفحة الإصدارات.",
          "مجلد تثبيت قابل للكتابة. يستخدم السكربت المسار /usr/local/bin إن كان يستطيع الكتابة فيه، وإلا فالمسار ~/.local/bin، وتذكر أسطره الأخيرة أيّهما اختار.",
          "ولا شيء غير ذلك من أجل push وsync عبر daemon direct. أما الحساب المجاني على Relayium فلا يلزم إلا لإصدار رمز اقتران عبر send أو text أو pair، وللرفع عبر up، ولاستخدام Device Inbox.",
        ],
      },
      body: [
        "على macOS أو Linux، يُنزّل أمر واحد ملفًا ثنائيًا مُسبق البناء لنظام تشغيلك ويضعه في PATH لديك:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "تفضّل اختيار الملف بنفسك؟ نزّل ملفًا ثنائيًا من صفحة الإصدارات.",
        "لديك Go مثبّت؟ استنسخ المستودع ونفّذ: go build ./cmd/relayium (من مجلد server).",
        "ثم نفّذ relayium --help لرؤية كل أمر، وrelayium version للتحقق من نسخة البناء.",
      ],
    },
    {
      heading: "الطرق الثلاث التي ينقل بها الملفات",
      body: [
        "‏Relayium ينقل الملفات بثلاث طرق. تختار حسب موقع الطرف الآخر، لا بتعلّم ثلاث أدوات مختلفة — فجميعها تتشارك محرك نقل واحدًا يتحقق من كل ملف ينقله بتجزئة SHA-256. وما لا تتشاركه هو الاستئناف: sync هو الوضع الذي يُكمل ملفًا جزئيًا في تشغيل لاحق، أما push وsend وreceive فلا تستأنف إطلاقًا.",
      ],
      bullets: [
        "‏up / down (السحابة) — يمكن أن يكون الطرف الآخر غير متصل. يشفّر up على هذا الجهاز ويرفع النص المُشفَّر فقط إلى حسابك ويطبع رابطًا، ويجلبه down ويفك تشفيره على جهاز آخر بالرابط. أما push / pull عبر SSH الذي كان مذكورًا هنا فقد أُوقف.",
        "‏send / receive — إلى شخص آخر عبر الشبكات، باستخدام رمز اقتران قصير تُصدره واجهة CLI لدى المُرسِل (سجِّل الدخول مرة واحدة عبر relayium login؛ أما المُستقبِل فلا يسجّل الدخول أبدًا). والرمز المُولَّد صالح خمس دقائق، فشغِّل الأمر على الجهاز المُستقبِل خلال هذه المدة.",
        cliDirectFacts.ar,
        "‏serve + push relayium:// (daemon direct) — مباشرة بين خادمين تملكهما، عبر TLS مثبَّت. بدون مُرحِّل، بدون SSH، بدون رمز.",
      ],
    },
    {
      heading: "إرسال نص مؤقت",
      body: [
        "شغّل relayium text على جهاز لإصدار رمز اقتران، ثم انضم من الجهاز الآخر بالرمز المطبوع:",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "يتطلب إصدار الرمز relayium login؛ أما الانضمام بالرمز فلا يحتاج إلى تسجيل دخول.",
        "يجب أن يبقى الجهازان متصلين. تُشفَّر الرسائل من الطرف إلى الطرف، ولا تخزّن خوادم Relayium متنها.",
        cliDirectFacts.ar,
        "ومع ذلك يمكن لأي طرف نسخ النص المستلم أو الاحتفاظ به.",
        "الرسالة الواحدة 65,536 بايت UTF-8 كحد أقصى. استخدم relayium send للمحتوى الأكبر.",
      ],
    },
    {
      heading: "أول عملية نقل لك",
      body: [
        "أسرع شيء يمكنك تجربته هو نسخ مجلد إلى جهاز تديره. شغّل هناك مستمع Relayium، واعتمد هذا المُرسِل، ثم انقل مباشرة دون حساب:",
      ],
      steps: [
        {
          text: "تأكّد من أن واجهة CLI موجودة في PATH لديك. ستطبع سطر إصدار لا عبارة «command not found».",
          code: ["relayium version"],
        },
        {
          text: "على جهاز الاستقبال، أنشئ المجلد واعتمد بصمة المُرسِل وشغّل المستمع. يجب أن يستخدم authorize وserve قيمة --config-dir نفسها.",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "ادفع المجلد بـ push إلى عنوان relayium:// الخاص بالمستمع.",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "تأكّد على جهاز الاستقبال من ظهور photos/ تحت مجلد --dir الخاص بالمستمع.",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "كيف يبدو التشغيل الناجح",
        body: [
          "يطبع push سطرًا لكل ملف مكتمل، وينتهي برمز 0 بعد أن يتحقق المستمع من الدفعة ويثبّتها.",
        ],
        code: [
          "relayium push ./photos relayium://receiver.example\n  photos/IMG_0413.jpg (2314518 bytes)\n  photos/IMG_0414.jpg (1998233 bytes)\necho $?\n# 0",
        ],
      },
      bullets: [
        "يفحص push الدفعة بحثًا عن التعارضات قبل الإرسال، ويتحقق من كل ملف بـ SHA-256 ويضعه في منطقة مؤقتة قبل تثبيته. ولا يستأنف؛ استخدم relayium sync حين قد ينقطع التشغيل.",
        "يجب أن يكون المستمع قابلًا للوصول، وأن يكون قد اعتمد بصمة هذا المُرسِل مسبقًا.",
        "أُوقفت وجهات SSH وrelayium pull والخياران -i و-p. للنقل في الاتجاه المعاكس، شغّل serve على هذا الجهاز وابدأ push جديدًا عبر daemon direct من الجهاز الآخر.",
      ],
    },
    {
      heading: "حين لا يمر الأمر الأول",
      body: [
        "أربعة أمور تتعثر في أول تشغيل أكثر من كل ما عداها مجتمعًا. ولا يحتاج أي منها إلى تخمين، فلكل واحد أمر يحسم المسألة بمخرجاته.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "تظهر «relayium: command not found» مباشرة بعد أن أعلن سكربت التثبيت نجاحه.",
            code: [
              `command -v relayium
# (لا يطبع شيئًا)`,
            ],
            fix: "الملف الثنائي مثبَّت، لكن مجلده ليس ضمن PATH لديك. تذكر أسطر السكربت الأخيرة المجلد الذي استُخدم وتطبع سطر export PATH المطلوب إضافته بالضبط؛ نفّذه، ثم افتح صَدَفة جديدة وجرّب relayium version من جديد.",
          },
          {
            symptom: "يطبع push الرسالة «SSH transfers are currently disabled».",
            code: [
              "relayium push ./photos <retired-ssh-destination>\n# SSH transfers are currently disabled",
            ],
            fix: "يستخدم الأمر صيغة وجهة SSH الموقوفة. شغّل relayium serve على جهاز الاستقبال واستخدم relayium://receiver بدلًا منها.",
          },
          {
            symptom: "يرفض المستمع المُرسِل لأنه غير معتمد.",
            code: [
              "relayium id\n# sha256:...",
            ],
            fix: "شغّل relayium authorize <sender-fingerprint>‎ على جهاز الاستقبال بقيمة --config-dir نفسها التي يستخدمها serve. يقرأ المستمع العامل الاعتماد الجديد عند الاتصال التالي.",
          },
          {
            symptom: "ينضم جهازان إلى الرمز نفسه فيطبع أحدهما «the other side is running `relayium text`, not `relayium send`/`relayium receive`».",
            code: [
              `# جلسة رسائل: كلا الطرفين يشغّل text
relayium text
relayium text 483920`,
            ],
            fix: "شغّل الطرفان أمرين مختلفين. للرسائل استخدم relayium text على الجهازين، وللملفات استخدم relayium send على أحدهما وrelayium receive على الآخر. يُرفض هذا التعارض قبل أي محاولة اتصال، فلم يُرسَل شيء.",
          },
        ],
      },
    },
    {
      heading: "مجاني، وخاص بحكم التصميم",
      body: [
        "لا توجد رسوم لكل عملية نقل. ينقل push/sync عبر daemon direct المحتوى مباشرة بين جهازيك، دون المرور بخوادم Relayium، ولا يحتاج إلى حساب. وفي send / receive لا يسجّل الدخول إلا الطرف الذي يُصدر الرمز (كما يستخدم up السحابي حسابك أيضًا، لتخزين الملف). وكلما أصدر الخادم مُرحِّلًا للرمز، مرّ كل بايت عبر هذا المُرحِّل المُشفَّر نصًا مُشفَّرًا لا يستطيع قراءته، واحتُسب ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز. واستهلاك الحصة هو احتساب للاستخدام، لا رسم على كل عملية نقل.",
        "كل عملية نقل مشفّرة من الطرف إلى الطرف، ويُتحقق من كل ملف ينقله التشغيل بتجزئة SHA-256 عند الوصول. أما الاستئناف فأضيق من ذلك: يُكمل relayium sync ملفًا جزئيًا في تشغيل لاحق، ويعيد relayium down الاتصال ويُكمل داخل التشغيل نفسه، بينما لا تستأنف push وsend وreceive إطلاقًا. يعمل على macOS وLinux وWindows، والمشروع كله مفتوح المصدر وقابل للاستضافة الذاتية.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يكلّف CLI أي شيء؟",
        a: "إن CLI نفسه مجاني ومفتوح المصدر، ولا تكلّف الأوضاع المباشرة — push/sync عبر daemon direct — شيئًا: لا تمر هذه البايتات أبدًا عبر خوادم Relayium، فلا يوجد ما يُقاس. أما send / receive وtext فتُحتسب حين تُرحَّل: كلما أصدر الخادم مُرحِّلًا للرمز، احتُسبت البايتات المُرحَّلة ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز. ويستهلك من خطتك كذلك الأمران up وdown، إذ يكتبان نسخة مشفّرة محفوظة تحت حسابك ويقرآنها. يُحتسب up ضمن أربعة حدود منفصلة — حصة حركة البيانات الشهرية، وحدّ التخزين لما تحتفظ به مُخزَّنًا في آنٍ واحد، ومدة الاحتفاظ القصوى في خطتك، وحدّ رفع يومي — ويُحتسب down ضمن حصة حركة البيانات عند قراءة النسخة. والخطط المدفوعة ترفعها جميعًا.",
      },
      {
        q: "هل أحتاج إلى حساب Relayium؟",
        a: "لإصدار رمز اقتران عبر send أو text أو pair، ولـ up السحابي، ولـ Device Inbox. لا يحتاج push/sync عبر daemon direct إلى حساب. لا يصدر الخادم الرموز إلا لحساب مسجّل الدخول، لذا يشغّل منشئ الرمز relayium login مرة واحدة. أما الانضمام برمز مستلَم وreceive فلا يحتاجان إلى تسجيل دخول.",
      },
      {
        q: "ما أنظمة التشغيل المدعومة؟",
        a: "تُنشر ملفات ثنائية مُسبقة البناء لـ macOS وLinux وWindows على معماريتَي x86-64 وarm64. يغطي سكربت التثبيت macOS وLinux؛ على Windows، نزّل ملف .zip من صفحة الإصدارات.",
      },
      {
        q: "هل تمر ملفاتي عبر خوادم Relayium؟",
        a: "ليس مع push/sync عبر daemon direct: تنتقل بايتات الملف مباشرة بين جهازيك. يتصل send / receive وtext بخوادمنا لمصافحة تعارف صغيرة، وكلما أصدر الخادم مُرحِّل TURN للرمز مرّ كل بايت من الجلسة عبر هذا المُرحِّل — نصًا مُشفَّرًا من الطرف إلى الطرف لا يستطيع قراءته، يُحتسب ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز، ولا يُخزَّن أبدًا. أما up فمختلف: إنه يرفع نسخة مُشفَّرة إلى تخزين حسابك، يحتفظ بها الخادم لكنه لا يستطيع قراءتها.",
      },
    ],
  },
  cta: {
    text: "ثبّت Relayium CLI المجاني والمفتوح المصدر ونفّذ أول عملية نقل مباشر لك.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Transfiere archivos y texto desde la terminal con la CLI de Relayium",
  description:
    "Usa la CLI de Relayium, gratis y cifrada de extremo a extremo, para archivos por código de emparejamiento o daemon directo, y texto efímero mientras ambas máquinas están conectadas.",
  updatedLabel: "Última actualización",
  lead: [
    "La CLI de Relayium es un pequeño binario para transferir archivos y texto efímero desde la terminal — cifrado de extremo a extremo, autoalojable y gratis. Copia archivos a un servidor, envía una compilación o pasa URL, comandos y código sin guardarlos antes como archivo.",
    "En daemon directo — relayium serve con push o sync —, los bytes de los archivos viajan directamente entre tus dos máquinas y nunca pasan por los servidores de Relayium, así que no se contabiliza nada. Las sesiones con código de emparejamiento (send / receive, text y pair) están cifradas de extremo a extremo, pero siempre que el servidor emite un retransmisor para el código, cada byte pasa por ese retransmisor cifrado y cuenta para la cuota mensual de tráfico de la cuenta que generó el código. up no es directo: guarda una copia cifrada en tu cuenta. Esta guía te deja instalado y con tu primera transferencia hecha, y luego te dirige a los tutoriales más detallados de cada modo.",
  ],
  sections: [
    {
      heading: "Instala con un solo comando",
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Un ordenador con terminal en macOS, Linux o Windows. Hay binarios precompilados para los tres, tanto en x86-64 como en arm64.",
          "curl, para la instalación de una línea en macOS y Linux: curl --version imprime una versión. En Windows, descarga en su lugar el .zip de la página de releases.",
          "Un directorio de instalación con permiso de escritura. El script usa /usr/local/bin cuando puede escribir ahí y ~/.local/bin en caso contrario, y sus últimas líneas dicen cuál eligió.",
          "Nada más para push o sync con daemon directo. Solo generar un código de emparejamiento con send, text o pair, subir con up y usar la Device Inbox necesitan una cuenta gratuita de Relayium.",
        ],
      },
      body: [
        "En macOS o Linux, un comando descarga un binario precompilado para tu sistema operativo y lo coloca en tu PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "¿Prefieres elegir el archivo tú mismo? Descarga un binario desde la página de releases.",
        "¿Tienes Go instalado? Clona el repositorio y ejecuta: go build ./cmd/relayium (desde el directorio server).",
        "Luego ejecuta relayium --help para ver todos los comandos, y relayium version para comprobar la compilación.",
      ],
    },
    {
      heading: "Las tres formas en que mueve archivos",
      body: [
        "Relayium mueve archivos de tres maneras. Eliges según dónde esté el otro extremo, no aprendiendo tres herramientas distintas — todas comparten un mismo motor de transferencia, que verifica cada archivo que mueve con un hash SHA-256. Lo que no comparten es la reanudación: sync es el modo que continúa un archivo parcial en una ejecución posterior, y push, send y receive no reanudan en absoluto.",
      ],
      bullets: [
        "up / down (nube) — el otro extremo puede estar desconectado. up cifra en esta máquina, sube solo el texto cifrado a tu cuenta e imprime un enlace; down lo descarga y descifra en otra máquina con ese enlace. El push / pull por SSH que figuraba aquí está retirado.",
        "send / receive — a otra persona entre redes, usando un código de emparejamiento corto que genera la CLI de quien envía (inicia sesión una vez con relayium login; quien recibe, nunca). Un código emitido vale cinco minutos, así que lanza el comando en la máquina receptora dentro de ese margen.",
        cliDirectFacts.es,
        "serve + push relayium:// (daemon directo) — directamente entre dos servidores que posees, sobre TLS con anclaje. Sin retransmisor, sin SSH, sin código.",
      ],
    },
    {
      heading: "Enviar texto efímero",
      body: [
        "Ejecuta relayium text en una máquina para generar un código de emparejamiento y únete desde la otra con el código impreso:",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "Generar el código requiere relayium login; unirse con un código no requiere iniciar sesión.",
        "Ambas máquinas deben seguir conectadas. Los mensajes están cifrados de extremo a extremo y los servidores de Relayium no almacenan su contenido.",
        cliDirectFacts.es,
        "Cualquiera de los extremos puede copiar o conservar el texto recibido.",
        "Cada mensaje admite hasta 65.536 bytes UTF-8. Usa relayium send para contenido mayor.",
      ],
    },
    {
      heading: "Tu primera transferencia",
      body: [
        "Lo más rápido para probar es copiar una carpeta a una máquina que administres. Ejecuta allí un receptor de Relayium, autoriza a este remitente y transfiere directamente, sin cuenta:",
      ],
      steps: [
        {
          text: "Comprueba que la CLI está en tu PATH. Imprime una versión, no «command not found».",
          code: ["relayium version"],
        },
        {
          text: "En el receptor, crea el directorio, autoriza la huella del remitente e inicia el receptor. authorize y serve deben usar el mismo --config-dir.",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "Haz push de la carpeta a la dirección relayium:// del receptor.",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "En la máquina receptora, confirma que photos/ apareció bajo el --dir del receptor.",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "Cómo se ve una ejecución correcta",
        body: [
          "push imprime una línea por cada archivo completado y termina con 0 después de que el receptor verifica e instala el lote.",
        ],
        code: [
          "relayium push ./photos relayium://receiver.example\n  photos/IMG_0413.jpg (2314518 bytes)\n  photos/IMG_0414.jpg (1998233 bytes)\necho $?\n# 0",
        ],
      },
      bullets: [
        "push comprueba las colisiones del lote antes de enviar, verifica cada archivo por SHA-256 y lo coloca en un área temporal antes de instalarlo. No reanuda; usa relayium sync cuando una ejecución pueda interrumpirse.",
        "El receptor debe ser alcanzable y haber autorizado ya la huella de este remitente.",
        "Los destinos SSH, relayium pull, -i y -p están retirados. Para transferir en sentido contrario, ejecuta serve en esta máquina e inicia un nuevo push con daemon directo desde la otra.",
      ],
    },
    {
      heading: "Cuando el primer comando no funciona",
      body: [
        "Cuatro cosas salen mal en un primer intento más a menudo que todo lo demás junto. Ninguna exige adivinar: cada una tiene un comando cuya salida zanja la cuestión.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "«relayium: command not found», justo después de que el script de instalación dijera que había terminado bien.",
            code: [
              `command -v relayium
# (no imprime nada)`,
            ],
            fix: "El binario está instalado, pero su directorio no está en tu PATH. Las últimas líneas del script nombran el directorio que usó e imprimen la línea export PATH exacta que hay que añadir; ejecútala, abre un shell nuevo y prueba otra vez relayium version.",
          },
          {
            symptom: "push muestra «SSH transfers are currently disabled».",
            code: [
              "relayium push ./photos <retired-ssh-destination>\n# SSH transfers are currently disabled",
            ],
            fix: "El comando usa la forma de destino SSH retirada. Inicia relayium serve en el receptor y usa relayium://receiver en su lugar.",
          },
          {
            symptom: "El receptor rechaza al remitente por no estar autorizado.",
            code: [
              "relayium id\n# sha256:...",
            ],
            fix: "Ejecuta relayium authorize <sender-fingerprint> en el receptor con el mismo --config-dir que usa serve. Un receptor en marcha lee la nueva autorización en la siguiente conexión.",
          },
          {
            symptom: "Dos máquinas entran en el mismo código y una imprime «the other side is running `relayium text`, not `relayium send`/`relayium receive`».",
            code: [
              `# sesión de mensajes: AMBOS extremos ejecutan text
relayium text
relayium text 483920`,
            ],
            fix: "Los dos extremos ejecutaron comandos distintos. Para mensajes, relayium text en las dos máquinas; para archivos, relayium send en una y relayium receive en la otra. El desajuste se rechaza antes de intentar ninguna conexión, así que no se envió nada.",
          },
        ],
      },
    },
    {
      heading: "Gratis, y privado por diseño",
      body: [
        "No hay cargo por transferencia. push/sync con daemon directo mueve el contenido directamente entre tus dos máquinas, nunca por los servidores de Relayium, y no necesita cuenta. Con send / receive solo inicia sesión el lado que genera el código (el up en la nube también usa tu cuenta, para guardar el archivo). Siempre que el servidor emite un retransmisor para el código, cada byte pasa por ese retransmisor cifrado, como texto cifrado que no puede leer, y cuenta para la cuota mensual de tráfico de la cuenta que generó el código. Consumir una cuota es contabilizar el uso, no un cargo por transferencia.",
        "Cada transferencia está cifrada de extremo a extremo, y cada archivo que transfiere una ejecución se verifica con un hash SHA-256 al llegar. La reanudación es más estrecha que el resto: relayium sync continúa un archivo parcial en una ejecución posterior, relayium down se reconecta y continúa dentro de la ejecución que lo inició, y push, send y receive no reanudan en absoluto. Funciona en macOS, Linux y Windows, y todo el proyecto es de código abierto y autoalojable.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿La CLI cuesta algo?",
        a: "La CLI en sí es gratis y de código abierto, y push/sync con daemon directo no cuesta nada: esos bytes nunca pasan por los servidores de Relayium, así que no hay nada que medir. send / receive y text se contabilizan cuando se retransmiten: siempre que el servidor emite un retransmisor para el código, los bytes retransmitidos cuentan para la cuota mensual de tráfico de la cuenta que generó el código. También consumen tu plan up y down, que escriben y vuelven a leer una copia cifrada guardada en tu cuenta. up cuenta para cuatro límites distintos — tu franquicia mensual de tráfico, el límite de almacenamiento de lo que guardas a la vez, el periodo de retención máximo de tu plan y un límite de subida diario — y down cuenta para la franquicia de tráfico al leer la copia. Los planes de pago los amplían todos.",
      },
      {
        q: "¿Necesito una cuenta de Relayium?",
        a: "Para generar un código de emparejamiento con send, text o pair, para el up en la nube y para la Device Inbox. push/sync con daemon directo no requiere cuenta. El servidor solo genera códigos para una cuenta con sesión iniciada, así que quien lo crea ejecuta relayium login una vez. Unirse con un código recibido y usar receive no requiere iniciar sesión.",
      },
      {
        q: "¿Qué sistemas operativos son compatibles?",
        a: "Se publican binarios precompilados para macOS, Linux y Windows, tanto en x86-64 como en arm64. El script de instalación cubre macOS y Linux; en Windows, descarga el .zip desde la página de releases.",
      },
      {
        q: "¿Mis archivos pasan por los servidores de Relayium?",
        a: "No con push/sync con daemon directo: los bytes de los archivos viajan directamente entre tus dos máquinas. send / receive y text contactan con nuestros servidores para un pequeño handshake con el punto de encuentro, y siempre que el servidor emite un retransmisor TURN para el código, cada byte de la sesión pasa por ese retransmisor — como texto cifrado de extremo a extremo que no puede leer, contabilizado en la cuota mensual de tráfico de la cuenta que generó el código, y nunca guardado. up es distinto: sube una copia cifrada al almacenamiento de tu cuenta, que el servidor guarda pero no puede leer.",
      },
    ],
  },
  cta: {
    text: "Instala la CLI de Relayium, gratis y de código abierto, y haz tu primera transferencia directa.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Transfira arquivos e texto pelo terminal com a CLI do Relayium",
  description:
    "Use a CLI do Relayium, gratuita e com criptografia de ponta a ponta, para arquivos por código de emparelhamento ou daemon direto, e texto efêmero enquanto as duas máquinas estão online.",
  updatedLabel: "Última atualização",
  lead: [
    "A CLI do Relayium é um pequeno binário para transferir arquivos e texto efêmero pelo terminal — com criptografia de ponta a ponta, auto-hospedável e gratuito. Copie arquivos para um servidor, envie um build ou passe URLs, comandos e código sem salvar primeiro como arquivo.",
    "No daemon direto — relayium serve com push ou sync —, os bytes dos arquivos trafegam diretamente entre as suas duas máquinas e nunca passam pelos servidores do Relayium, então nada é contabilizado. As sessões com código de pareamento (send / receive, text e pair) têm criptografia de ponta a ponta, mas sempre que o servidor emite um retransmissor para o código, cada byte passa por esse retransmissor criptografado e conta para a cota mensal de tráfego da conta que gerou o código. O up não é direto: ele guarda uma cópia criptografada na sua conta. Este guia deixa você instalado e com a sua primeira transferência feita, e depois aponta para os tutoriais mais aprofundados de cada modo.",
  ],
  sections: [
    {
      heading: "Instale com um único comando",
      prereqs: {
        label: "O que você precisa",
        items: [
          "Uma máquina com terminal no macOS, Linux ou Windows. Há binários pré-compilados para os três, em x86-64 e arm64.",
          "curl, para a instalação de uma linha no macOS e no Linux: curl --version imprime uma versão. No Windows, baixe o .zip na página de releases.",
          "Um diretório de instalação com permissão de escrita. O script usa /usr/local/bin quando consegue escrever ali e ~/.local/bin caso contrário, e as últimas linhas dizem qual foi escolhido.",
          "Nada mais para push ou sync com daemon direto. Só gerar um código de pareamento com send, text ou pair, subir com up e usar a Device Inbox precisam de uma conta gratuita do Relayium.",
        ],
      },
      body: [
        "No macOS ou no Linux, um comando baixa um binário pré-compilado para o seu sistema operacional e o coloca no seu PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Prefere escolher o arquivo você mesmo? Baixe um binário na página de releases.",
        "Tem o Go instalado? Clone o repositório e execute: go build ./cmd/relayium (a partir do diretório server).",
        "Depois execute relayium --help para ver todos os comandos, e relayium version para conferir o build.",
      ],
    },
    {
      heading: "As três formas de mover arquivos",
      body: [
        "O Relayium move arquivos de três formas. Você escolhe pela localização da outra ponta, não aprendendo três ferramentas diferentes — todas compartilham um único motor de transferência, que verifica cada arquivo que move com um hash SHA-256. O que elas não compartilham é a retomada: o sync é o modo que continua um arquivo parcial em uma execução posterior, e push, send e receive não retomam nada.",
      ],
      bullets: [
        "up / down (nuvem) — a outra ponta pode estar offline. O up criptografa nesta máquina, envia só o texto cifrado para a sua conta e mostra um link; o down busca e descriptografa em outra máquina com esse link. O push / pull por SSH que aparecia aqui foi descontinuado.",
        "send / receive — para outra pessoa entre redes, usando um código de emparelhamento curto que a CLI de quem envia gera (faça login uma vez com relayium login; quem recebe, nunca). Um código emitido vale cinco minutos, então rode o comando na máquina que recebe dentro desse prazo.",
        cliDirectFacts.pt,
        "serve + push relayium:// (daemon direto) — direto entre dois servidores que você possui, sobre TLS com fixação. Sem retransmissor, sem SSH, sem código.",
      ],
    },
    {
      heading: "Enviar texto efêmero",
      body: [
        "Execute relayium text em uma máquina para gerar um código de emparelhamento e entre na outra com o código exibido:",
      ],
      code: ["relayium text", "relayium text 483920"],
      bullets: [
        "Gerar o código requer relayium login; entrar com um código não requer login.",
        "As duas máquinas precisam ficar online. As mensagens têm criptografia de ponta a ponta, e os servidores da Relayium não armazenam seu conteúdo.",
        cliDirectFacts.pt,
        "Qualquer ponta ainda pode copiar ou guardar o texto recebido.",
        "Cada mensagem pode ter até 65.536 bytes UTF-8. Use relayium send para conteúdo maior.",
      ],
    },
    {
      heading: "Sua primeira transferência",
      body: [
        "O mais rápido para experimentar é copiar uma pasta para uma máquina que você administra. Rode lá um receptor do Relayium, autorize este remetente e transfira diretamente, sem conta:",
      ],
      steps: [
        {
          text: "Confira se a CLI está no seu PATH. Ela imprime uma versão, não “command not found”.",
          code: ["relayium version"],
        },
        {
          text: "No destino, crie o diretório, autorize a impressão digital do remetente e inicie o receptor. authorize e serve precisam usar o mesmo --config-dir.",
          code: ["mkdir -p ~/inbox && relayium authorize <sender-fingerprint> && relayium serve --dir ~/inbox"],
        },
        {
          text: "Faça push da pasta para o endereço relayium:// do receptor.",
          code: ["relayium push ./photos relayium://receiver.example"],
        },
        {
          text: "Na máquina de destino, confirme que photos/ apareceu sob o --dir do receptor.",
          code: ["find ~/inbox/photos -maxdepth 1 -type f"],
        },
      ],
      success: {
        label: "Como é uma execução bem-sucedida",
        body: [
          "O push mostra uma linha por arquivo concluído e termina com 0 depois que o receptor verifica e instala o lote.",
        ],
        code: [
          "relayium push ./photos relayium://receiver.example\n  photos/IMG_0413.jpg (2314518 bytes)\n  photos/IMG_0414.jpg (1998233 bytes)\necho $?\n# 0",
        ],
      },
      bullets: [
        "O push checa colisões no lote antes de enviar, verifica cada arquivo por SHA-256 e o prepara em área temporária antes de instalá-lo. Ele não retoma; use o relayium sync quando uma execução puder ser interrompida.",
        "O receptor precisa estar acessível e já ter autorizado a impressão digital deste remetente.",
        "Destinos SSH, relayium pull, -i e -p foram descontinuados. Para transferir no sentido contrário, rode serve nesta máquina e inicie um novo push com daemon direto a partir da outra.",
      ],
    },
    {
      heading: "Quando o primeiro comando não passa",
      body: [
        "Quatro coisas dão errado numa primeira tentativa mais do que todo o resto somado. Nenhuma exige adivinhação: cada uma tem um comando cuja saída resolve a questão.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "“relayium: command not found”, logo depois de o script de instalação dizer que deu certo.",
            code: [
              `command -v relayium
# (não imprime nada)`,
            ],
            fix: "O binário está instalado, mas o diretório dele não está no seu PATH. As últimas linhas do script dizem qual diretório foi usado e imprimem a linha export PATH exata a acrescentar; rode-a, abra um shell novo e tente relayium version de novo.",
          },
          {
            symptom: "O push mostra “SSH transfers are currently disabled”.",
            code: [
              "relayium push ./photos <retired-ssh-destination>\n# SSH transfers are currently disabled",
            ],
            fix: "O comando usa a forma de destino SSH descontinuada. Inicie relayium serve no destino e use relayium://receiver no lugar dela.",
          },
          {
            symptom: "O receptor recusa o remetente como não autorizado.",
            code: [
              "relayium id\n# sha256:...",
            ],
            fix: "Rode relayium authorize <sender-fingerprint> no destino com o mesmo --config-dir usado pelo serve. Um receptor em execução lê a nova autorização na próxima conexão.",
          },
          {
            symptom: "Duas máquinas entram no mesmo código e uma imprime “the other side is running `relayium text`, not `relayium send`/`relayium receive`”.",
            code: [
              `# sessão de mensagens: AS DUAS pontas rodam text
relayium text
relayium text 483920`,
            ],
            fix: "As duas pontas rodaram comandos diferentes. Para mensagens, relayium text nas duas máquinas; para arquivos, relayium send em uma e relayium receive na outra. A divergência é recusada antes de qualquer tentativa de conexão, então nada foi enviado.",
          },
        ],
      },
    },
    {
      heading: "Gratuito, e privado por decisão de projeto",
      body: [
        "Não há cobrança por transferência. O push/sync com daemon direto move o conteúdo diretamente entre as suas duas máquinas, nunca pelos servidores do Relayium, e não precisa de conta. No send / receive, só o lado que gera o código faz login (o up na nuvem também usa a sua conta, para guardar o arquivo). Sempre que o servidor emite um retransmissor para o código, cada byte passa por esse retransmissor criptografado, como texto cifrado que ele não consegue ler, e conta para a cota mensal de tráfego da conta que gerou o código. Consumir uma cota é contabilizar o uso, não uma cobrança por transferência.",
        "Cada transferência é criptografada de ponta a ponta, e cada arquivo que uma execução transfere é verificado com um hash SHA-256 na chegada. A retomada é mais estreita que o resto: o relayium sync continua um arquivo parcial em uma execução posterior, o relayium down reconecta e continua dentro da execução que o iniciou, e push, send e receive não retomam nada. Ela roda no macOS, no Linux e no Windows, e o projeto inteiro é de código aberto e auto-hospedável.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "A CLI custa alguma coisa?",
        a: "A CLI em si é gratuita e de código aberto, e o push/sync com daemon direto não custa nada: esses bytes nunca passam pelos servidores do Relayium, então não há nada a medir. send / receive e text são contabilizados quando retransmitidos: sempre que o servidor emite um retransmissor para o código, os bytes retransmitidos contam para a cota mensal de tráfego da conta que gerou o código. Também usam o seu plano o up e o down, que gravam e leem de volta uma cópia criptografada guardada na sua conta. O up conta para quatro limites separados — a sua cota mensal de tráfego, o limite de armazenamento do que você mantém guardado ao mesmo tempo, o período de retenção máximo do seu plano e um limite diário de upload — e o down conta para a cota de tráfego ao ler a cópia de volta. Os planos pagos aumentam todos eles.",
      },
      {
        q: "Preciso de uma conta do Relayium?",
        a: "Para gerar um código de pareamento com send, text ou pair, para o up na nuvem e para a Device Inbox. push/sync com daemon direto não exige conta. O servidor só gera códigos para uma conta logada, então quem cria roda relayium login uma vez. Entrar com um código recebido e usar receive não requer login.",
      },
      {
        q: "Quais sistemas operacionais são compatíveis?",
        a: "Binários pré-compilados são publicados para macOS, Linux e Windows, tanto em x86-64 quanto em arm64. O script de instalação cobre macOS e Linux; no Windows, baixe o .zip na página de releases.",
      },
      {
        q: "Meus arquivos passam pelos servidores do Relayium?",
        a: "Não com push/sync com daemon direto: os bytes dos arquivos trafegam diretamente entre as suas duas máquinas. send / receive e text contatam os nossos servidores para um pequeno handshake de encontro, e sempre que o servidor emite um retransmissor TURN para o código, cada byte da sessão passa por esse retransmissor — como texto cifrado de ponta a ponta que ele não consegue ler, contabilizado na cota mensal de tráfego da conta que gerou o código, e nunca guardado. O up é diferente: ele envia uma cópia criptografada para o armazenamento da sua conta, que o servidor guarda mas não consegue ler.",
      },
    ],
  },
  cta: {
    text: "Instale a CLI do Relayium, gratuita e de código aberto, e faça a sua primeira transferência direta.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

const currentEn = {
  title: "Transfer files and text from the terminal with the Relayium CLI",
  description: "Install the Relayium CLI and choose among Cloud, Device Inbox, pairing-code, text, and daemon-direct transfers without relying on retired SSH commands.",
  updatedLabel: "Last updated",
  lead: [
    "Relayium is one free, open-source binary for macOS, Linux and Windows. The current CLI has six modes: Cloud, Device Inbox, text, send/receive, serve and sync.",
    "SSH destinations and relayium pull are retired. For machines you manage, run relayium serve on the receiver and use a relayium:// destination from push or sync.",
  ],
  sections: [
    {
      heading: "Install and inspect the commands",
      body: ["Install on macOS or Linux with the command below; Windows users download the portable ZIP from Releases."],
      code: ["curl -fsSL https://relayium.com/install.sh | sh", "relayium --help"],
      bullets: ["Help is local and makes no network request.", "Use relayium help <command> for command-specific syntax."],
    },
    {
      heading: "Choose the path that matches the task",
      bullets: [
        "Cloud: relayium up stores client-side-encrypted ciphertext and prints a link; relayium down retrieves it. Uploading uses your plan limits. Expiry is one of 1h, 1d, 3d, 7d or 14d, subject to the plan retention cap.",
        "Device Inbox: receive asynchronously into one of your devices. The target may be offline; both ends use the same account.",
        "send/receive and text: both peers stay online. Minting a pairing code requires an account; joining with a code does not.",
        "serve with push or sync: direct transfer between machines you manage over pinned TLS, with no Relayium account or SSH transport.",
      ],
    },
    {
      heading: "Make a first direct server transfer",
      body: ["Start a listener on the receiving machine, authorize the sender fingerprint, then push to its relayium:// address."],
      code: ["relayium id", "relayium authorize <sender-fingerprint>", "relayium serve --dir ~/inbox", "relayium push ./photos relayium://receiver.example"],
      bullets: ["Use the same --config-dir for authorize and serve.", "serve never creates --dir; create it first and restrict --bind or firewall the listener.", "push checks collisions before sending and verifies transferred files with SHA-256."],
    },
    {
      heading: "Understand limits and recovery",
      body: ["sync is a one-way mirror, not a versioned backup. It skips files by size and modification time and can continue a partial file on a later run. relayium down reconnects only within the invocation that started it."],
      bullets: ["Consuming a hosted allowance is usage accounting, not a per-transfer charge. Free accounts pay nothing; paid tiers are flat plans.", "push does not resume and never overwrites an existing destination.", "Use sync --delete only when propagating source deletions is intentional; the listener must opt in with --allow-delete."],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      { q: "Can I use an SSH destination?", a: "No. SSH push/sync destinations, relayium pull, -i and -p are retired. Use serve and a relayium:// destination." },
      { q: "Do direct transfers cost anything?", a: "There is no per-transfer charge for daemon-direct, pairing-code or text paths. A code creator needs an eligible account, but the eligibility check is not a charge." },
      { q: "Can the receiver be offline?", a: "Only Cloud and Device Inbox support an offline receiver. Direct modes require both ends to be available." },
      { q: "Do my files pass through Relayium's servers?", a: "Not in the direct modes: push/sync daemon-direct, send/receive and text move content between endpoints. Two modes are the deliberate exceptions, and in both the server holds only ciphertext it cannot read: up uploads an encrypted copy to your account's storage, and Device Inbox — receive-only in the CLI, through relayium inbox — queues an encrypted copy until your device downloads it." },
    ],
  },
  cta: { text: "Install the CLI and make a direct transfer.", button: "Get the CLI", href: "/cli" },
  relatedHeading: "Keep reading",
};

const currentZh = {
  title: "用 Relayium CLI 从终端传输文件与文本",
  description: "安装 Relayium CLI，在云端、设备收件箱、配对码、临时文本与 daemon 直连之间选择，不再依赖已退役的 SSH 命令。",
  updatedLabel: "最近更新",
  lead: [
    "Relayium 是一个适用于 macOS、Linux 与 Windows 的免费开源单一二进制文件。当前 CLI 有六种模式：云端、设备收件箱、text、send/receive、serve 与 sync。",
    "SSH 目标与 relayium pull 已退役。管理自己的机器时，在接收端运行 relayium serve，再让 push 或 sync 使用 relayium:// 目标。",
  ],
  sections: [
    { heading: "安装并查看命令", body: ["macOS 或 Linux 用下面的命令安装；Windows 用户从 Releases 下载免安装 ZIP。"], code: ["curl -fsSL https://relayium.com/install.sh | sh", "relayium --help"], bullets: ["帮助完全在本地生成，不发网络请求。", "用 relayium help <命令> 查看该命令的准确语法。"] },
    { heading: "按任务选择路径", bullets: ["云端：relayium up 上传本机加密的密文并打印链接，relayium down 取回。上传会占用套餐额度；有效期只能选 1 小时、1 天、3 天、7 天或 14 天，并受套餐留存上限约束。", "设备收件箱：异步接收到你自己的设备，对端可以离线，两端使用同一个账号。", "send/receive 与 text：两端必须同时在线。生成配对码需要账号，用别人给的码加入不需要账号。", "serve 配合 push 或 sync：你管理的机器之间通过证书固定 TLS 直连，不需要 Relayium 账号，也不走 SSH。"] },
    { heading: "完成第一次服务器直传", body: ["在接收端启动监听器、授权发送端指纹，再向 relayium:// 地址推送。"], code: ["relayium id", "relayium authorize <sender-fingerprint>", "relayium serve --dir ~/inbox", "relayium push ./photos relayium://receiver.example"], bullets: ["authorize 与 serve 必须使用同一个 --config-dir。", "serve 不会创建 --dir；请先创建，并用 --bind 或防火墙限制监听范围。", "push 会先检查冲突，并对传输的文件做 SHA-256 校验。"] },
    { heading: "理解额度与恢复", body: ["sync 是单向镜像，不是带版本的备份。它按大小与修改时间跳过文件，并能在下一次运行继续半截文件。relayium down 只会在发起下载的同一次调用中自动重连。"], bullets: ["占用托管额度表示计入用量，不等于按次收费。免费账号不付费，付费档是固定套餐。", "push 不续传，也不会覆盖已存在的目标。", "只有明确需要传播源端删除时才使用 sync --delete；监听端还必须用 --allow-delete 同意。"] },
  ],
  faq: { heading: "常见问题", items: [
    { q: "还能使用 SSH 目标吗？", a: "不能。SSH push/sync 目标、relayium pull、-i 与 -p 已退役。请使用 serve 和 relayium:// 目标。" },
    { q: "直连传输会收费吗？", a: "daemon 直连、配对码和 text 都不按次收费。生成配对码的一端需要符合条件的账号，但资格检查本身不是收费。" },
    { q: "接收端可以离线吗？", a: "只有云端和设备收件箱支持离线接收端；直连模式要求两端可用。" },
    { q: "文件会经过 Relayium 服务器吗？", a: "直连模式不会：push/sync daemon 直连、send/receive 与 text 都在端点之间传内容。有两种模式是有意为之的例外，而且服务器在两种模式里都只保存无法读取的密文：up 会把加密副本上传到你账号的存储里；设备收件箱（在 CLI 中只有接收侧，即 relayium inbox）会让加密副本排队存着，直到你的设备下载。" },
  ] },
  cta: { text: "安装 CLI，完成一次直连传输。", button: "获取 CLI", href: "/cli" },
  relatedHeading: "继续阅读",
};

export default {
  slug: "guides/transfer-files-from-terminal",
  published: "2026-07-08",
  updated: "2026-09-01",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
