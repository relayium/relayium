// web/scripts/pages/content/articles/cli-send-to-someone.mjs
// How-to: send a file to another person across networks with relayium send/receive.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";
import { cliDirectFacts } from "../realtime-facts.mjs";

const en = {
  title: "Send a file to someone across networks with the Relayium CLI",
  description:
    "Use relayium send and receive to move a file between two people on different networks, using a short pairing code. End-to-end encrypted, with an optional SAS code to compare. Whenever the server issues a relay for the code, the file travels through it as ciphertext, counting toward the monthly traffic allowance of the account that minted the code when the relay reports it as billable usage.",
  updatedLabel: "Last updated",
  lead: [
    "Sometimes the other machine isn't yours and you can't SSH into it — a file for a colleague in another office, a build for a client, an archive for a friend across the country. relayium send and receive move it between the two of you across networks, using nothing but a short pairing code that your CLI mints when you send.",
    "The session is end-to-end encrypted. A short rendezvous on Relayium's server introduces the two ends; whenever the server issues a TURN relay for the code, the file bytes then travel through that relay as ciphertext it cannot read, and count toward the monthly traffic allowance of the account that minted the code when the relay reports them as billable usage — the relay nodes Relayium operates do; its coturn TURN servers bill nothing today: their optional accounting ingest is off by default and, if configured in shadow mode, only records measurements.",
  ],
  sections: [
    {
      heading: "Send, then pass on the code it prints",
      prereqs: {
        label: "What you need",
        items: [
          "The CLI on the sending machine. relayium version prints a version string; a shell that answers 'command not found' means it isn't installed there yet. The other end can run the CLI too, or type the code into a Relayium app or the web page.",
          "A signed-in sender. relayium whoami prints the account email; minting a pairing code needs relayium login first. The receiving machine never signs in.",
          "Both of you online at the same time. The code lives five minutes, so agree on the moment before you mint one.",
          "A way to say six digits out of band — a phone call, a chat window, the room you are both sitting in.",
        ],
      },
      body: [
        "Sign in once with relayium login, then just send. The CLI mints a pairing code, prints it along with the exact command the other end runs, and waits. Pass that code along out of band — say it over a call, drop it in a chat:",
      ],
      steps: [
        {
          text: "On the sending machine, sign in once. Skip this if relayium whoami already prints your account email.",
          code: ["relayium login"],
        },
        {
          text: "From the directory holding the file, start the send. The CLI mints the code, prints the command for the other end, and then waits.",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "Read the six digits it printed to the other person out of band. They stop working five minutes after they were minted.",
        },
        {
          text: "On the receiving machine, in the directory where the files should land, run the command the sender was shown. Add a directory to land somewhere else.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Leave both terminals running until the receiving shell returns to its prompt. This is one live session: closing either end stops the transfer.",
        },
      ],
      success: {
        label: "What a successful run looks like",
        body: [
          "The sender prints the hand-off block, waits, then prints a verification code and the path it got. Both terminals show the same verification code, and both exit 0.",
        ],
        code: [
          `# on the SENDER
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: relay (selected pair …)`,
        ],
      },
      bullets: [
        "The code is 6 decimal digits — any of 0-9, leading zeros included — and it expires 5 minutes after it is minted.",
        "The code is just a shared secret to meet on; it isn't sent to anyone but the rendezvous, and it introduces the two ends only.",
        "The other end does not have to be the CLI: relayium receive, relayium pair, a Relayium app or the web page can all join the code. Sending to someone who is not online right now? Use relayium up for a download link, or relayium inbox send for one of your own devices.",
      ],
    },
    {
      heading: "Verify with the SAS code",
      body: [
        "When the two ends connect, both terminals print the same 6-digit SAS (short authentication string) derived from the keys the two ends exchanged. Compare it out of band — read it aloud on the call — to confirm the keys were not substituted and the rendezvous service did not impersonate either endpoint. The SAS authenticates the endpoints; it does not prove every network hop — or rule out a relay, which carries only ciphertext.",
        "For the strongest protection, add --verify: the transfer then waits for you to confirm the codes match before a single byte moves.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Relay or peer to peer — and what it counts against",
      body: [
        "The path line tells you which way the bytes went: relay, or direct / lan for peer to peer. Either way the file is end-to-end encrypted, and either way there is no per-transfer charge — relayed bytes that the relay reports as billable usage are usage accounting against the minting account's monthly traffic allowance; the relay nodes Relayium operates do, while Relayium's coturn TURN servers bill nothing today — their legacy usage ingest is disabled, and their optional accounting ingest is off by default and, if configured in shadow mode, records measurements without writing to the billing ledger, usage periods or any allowance.",
        cliDirectFacts.en,
        "If a transfer cannot connect, the reliable answers are a stored link from relayium up, relayium inbox send for a device of your own that is not online right now, or relayium serve with push / sync between two reachable servers you run — that path is direct and not metered.",
      ],
      bullets: [
        "Relay issued → every byte goes through the encrypted relay, and counts toward the monthly traffic allowance of the account that minted the code when the relay reports it as billable usage.",
        "No relay issued → the two ends connect peer to peer when a direct path exists; otherwise the session fails.",
      ],
    },
    {
      heading: "When it doesn't work",
      body: [
        "Four failures account for nearly every unsuccessful attempt. Each one has a line you can read or a command you can run that decides it, so you never have to guess which end is at fault.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The sender refuses to start: \"minting a pairing code needs an account\".",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "That machine has no stored credentials. Run relayium login and approve it in the browser; whoami then prints your account email and the send goes through. Nothing was minted, so no code was wasted.",
          },
          {
            symptom: "The receiver types the code and the rendezvous refuses it.",
            code: [
              `# on the SENDER — the hand-off block states the exact life
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "The code lapsed. Press Ctrl-C on the sender, run relayium send ./release.zip again, and read the fresh six digits within the five minutes the new hand-off block states.",
          },
          {
            symptom: "The two terminals print different verification codes.",
            code: ["relayium send --verify ./release.zip"],
            fix: "Stop and do not send the file. Differing codes mean the keys the two ends exchanged disagree, so the far end is not the machine you think it is. Re-run with --verify, which holds the transfer at that comparison until you confirm, and check with the other person which machine they are on.",
          },
          {
            symptom: "The sender prints \"relay unavailable: …\" and the two ends never connect.",
            code: [
              `relayium send ./release.zip
# relay unavailable: the pairing code owner's monthly relay allowance is used up; trying a direct connection only (no relay) — across strict NATs that may fail`,
            ],
            fix: "The server issued no relay for this code, so the ends tried peer to peer and neither could reach the other. The line names the reason: an allowance that is used up resets with the month or grows with a paid plan, and an unverified email address needs verifying. Otherwise move one end onto a network with a reachable address — a server, or a phone hotspot — or upload the file with relayium up and hand over the download link instead. Against an older relayium on the other end the error reads \"no direct connection to the peer\" instead: that older pairing is direct-only, so update both ends.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Where does the pairing code come from?",
        a: "Relayium mints it. Run relayium send ./release.zip (after relayium login) and the CLI prints a 6-digit code good for five minutes, plus the exact command the other end runs. You can't choose it yourself — the server only accepts codes it issued.",
      },
      {
        q: "Is the file uploaded anywhere?",
        a: "It is not stored. The file streams between the two of you, end-to-end encrypted. A small rendezvous handshake on Relayium's server introduces the ends, and whenever the server issues a TURN relay for the code the file's bytes pass through that relay as ciphertext it cannot read — counted toward the monthly traffic allowance of the account that minted the code when the relay reports them as billable usage (the relay nodes Relayium operates do; its coturn TURN servers bill nothing today: their optional accounting ingest is off by default and, if configured in shadow mode, only records measurements), and never kept.",
      },
      {
        q: "What if we can't connect?",
        a: "Whenever the server issues a relay for the code, the session goes through it, so strict NATs do not stop it. When no relay is issued — none is configured, or the minting account's allowance is used up — the two ends need a direct path, and without one the transfer fails. Then use a stored link from relayium up, or relayium serve with push / sync between two reachable servers you run.",
      },
      {
        q: "How do I know it's really the right person on the other end?",
        a: "Both terminals print an identical 6-digit SAS code derived from the keys the two ends exchanged. Compare it out of band; a match confirms the keys were not substituted and the rendezvous service did not impersonate either endpoint. It authenticates the endpoints, not every network hop. Add --verify to require that confirmation before any bytes move.",
      },
    ],
  },
  cta: {
    text: "Send your next file to someone on another network — end-to-end encrypted, with no per-transfer charge.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 跨网络把文件发给对方",
  description:
    "使用 relayium send 和 receive，凭一个简短的配对码，在两个不同网络上的人之间传输文件。端到端加密，可选用 SAS 码验证。只要服务器为这个码签发了中继，文件就以密文经它传输；中继上报为计费用量时，计入生成配对码那个账号的每月流量额度。",
  updatedLabel: "最近更新",
  lead: [
    "有时候对方的机器不是你的，你也没法用 SSH 登录进去——给另一个办公室的同事发个文件，给客户发个构建产物，给国外的朋友发个压缩包。relayium send 和 receive 会跨网络把文件送到你们两个之间，靠的只是发送时 CLI 为你生成的一个简短配对码。",
    "会话是端到端加密的。Relayium 服务器上的一次简短会合负责介绍双方；只要服务器为这个码签发了 TURN 中继，文件字节随后就经这条中继以它读不了的密文传输；中继把它们上报为计费用量时，计入生成配对码那个账号的每月流量额度——Relayium 运营的中继节点会上报，其 coturn TURN 服务器目前不计费：可选的计量采集默认关闭，如果配置为影子模式，也只记录测量值。",
  ],
  sections: [
    {
      heading: "先 send，再把打印出来的码转告对方",
      prereqs: {
        label: "你需要准备",
        items: [
          "发送方机器上装好 CLI。relayium version 会打印版本号；如果 shell 回的是 “command not found”，说明还没装。对端也可以用 CLI，或者把码输入 Relayium 应用或网页。",
          "发送方已登录。relayium whoami 会打印账号邮箱；生成配对码之前必须先 relayium login。接收方那台机器全程不用登录。",
          "两个人同时在线。码只有五分钟寿命，所以先约好时间再生成。",
          "一个能把六位数字带外告诉对方的渠道——一通电话、一个聊天窗口，或者你们同处的那个房间。",
        ],
      },
      body: [
        "用 relayium login 登录一次，然后直接 send 就行。CLI 会生成一个配对码，连同对面要执行的完整命令一起打印出来，然后等待。把这个码用带外方式转告对方——打电话说一下，或者丢进聊天里：",
      ],
      steps: [
        {
          text: "在发送方机器上登录一次。如果 relayium whoami 已经能打印出你的账号邮箱，就跳过这步。",
          code: ["relayium login"],
        },
        {
          text: "在文件所在目录里开始发送。CLI 会生成配对码，打印出对面要执行的命令，然后等待。",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "把它打印出来的六位数字用带外方式念给对方。这串数字在生成五分钟后就不再有效。",
        },
        {
          text: "在接收方机器上，切到文件该落地的目录，执行发送方看到的那条命令。想放到别处就在后面加一个目录。",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "两边的终端都别关，直到接收端回到 shell 提示符。这是一次实时会话：任何一端关掉，传输就停了。",
        },
      ],
      success: {
        label: "成功时你会看到什么",
        body: [
          "发送方先打印交接信息块并等待，然后打印校验码和它拿到的路径。两边终端显示同一个校验码，而且都以 0 退出。",
        ],
        code: [
          `# 发送方
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: relay (selected pair …)`,
        ],
      },
      bullets: [
        "这个码是 6 位十进制数字——0-9 都可能出现，也可能以 0 开头——并且在生成 5 分钟后失效。",
        "这个码只是一个用来会合的共享密钥；除了会合服务器，它不会发给任何人，而且只用来介绍双方。",
        "对端不一定是 CLI：relayium receive、relayium pair、Relayium 应用或网页都能加入这个码。对方此刻不在线？请用 relayium up 生成下载链接，或用 relayium inbox send 发给你自己的设备。",
      ],
    },
    {
      heading: "用 SAS 码验证",
      body: [
        "两端连接建立后，两边的终端会打印出同一个从双方交换的密钥派生的 6 位 SAS（简短认证串）。通过带外方式核对——例如在通话中念出来——可以确认密钥没有被替换、会合服务没有冒充任一端。SAS 认证的是端点，并不证明网络路径上的每一跳，也不排除中继——中继只经手密文。",
        "为获得最强保护，加上 --verify：传输会等你确认两边的码一致后，才会移动哪怕一个字节。",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "走中继还是点对点——以及计入什么",
      body: [
        "path 那一行会告诉你字节走的是哪条路：relay，或者表示点对点的 direct / lan。两种情况下文件都是端到端加密的，也都不按次收费——中继上报为计费用量的字节只是计入生成配对码那个账号每月流量额度的用量；Relayium 运营的中继节点会这样上报，而 Relayium 的 coturn TURN 服务器目前不计费——旧的用量采集已停用，可选的计量采集默认关闭，如果配置为影子模式，也只记录测量值，不写入计费账本、用量周期或任何额度。",
        cliDirectFacts.zh,
        "如果传输连不上，可靠的办法是用 relayium up 创建存储链接，用 relayium inbox send 发给你自己那台此刻不在线的设备，或者在你运行的两台可达服务器之间用 relayium serve 配合 push / sync——这条路径是直连的，不计量。",
      ],
      bullets: [
        "签发了中继 → 每个字节都经加密中继传输；中继上报为计费用量时，计入生成配对码那个账号的每月流量额度。",
        "没有签发中继 → 有直连路径时两端点对点连接；否则会话失败。",
      ],
    },
    {
      heading: "传不过去的时候",
      body: [
        "几乎所有失败都落在下面四种里。每一种都有一行可读的输出或一条可执行的命令来判定，你不必靠猜来判断是哪一端出了问题。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "发送方直接拒绝启动：“minting a pairing code needs an account”。",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "这台机器上没有存下凭据。运行 relayium login 并在浏览器里批准；之后 whoami 就能打印出账号邮箱，发送也能继续。此时还没有生成过码，所以没浪费任何一个。",
          },
          {
            symptom: "接收方输入了码，会合服务却不认。",
            code: [
              `# 发送方——交接信息块里写着确切的有效期
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "码过期了。在发送方按 Ctrl-C，重新运行 relayium send ./release.zip，然后在新交接信息块写明的五分钟内把新的六位数字念过去。",
          },
          {
            symptom: "两边终端打印出的校验码不一样。",
            code: ["relayium send --verify ./release.zip"],
            fix: "停下，别把文件发出去。校验码不一致意味着两端交换的密钥对不上，也就是说对面那台机器并不是你以为的那台。用 --verify 重跑一次，它会在这一步停住等你确认，同时跟对方核对他们到底在哪台机器上操作。",
          },
          {
            symptom: "发送方打印 “relay unavailable: …”，两端一直连不上。",
            code: [
              `relayium send ./release.zip
# relay unavailable: the pairing code owner's monthly relay allowance is used up; trying a direct connection only (no relay) — across strict NATs that may fail`,
            ],
            fix: "服务器没有为这个码签发中继，于是两端尝试点对点，而谁也够不着谁。这一行写明了原因：额度用尽会在下个月重置，也可以通过付费套餐提高；邮箱未验证就先去验证。否则把其中一端换到有可达地址的网络上——一台服务器，或者手机热点——或者改用 relayium up 上传文件，把下载链接交给对方。如果对端是旧版 relayium，报错会是 “no direct connection to the peer”：那种旧配对只走直连，请把两端都升级。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "配对码是从哪来的？",
        a: "由 Relayium 生成。登录后运行 relayium send ./release.zip，CLI 会打印一个 6 位数字、5 分钟内有效的码，以及对面要执行的完整命令。这个码不能自己指定——服务器只认它自己签发的。",
      },
      {
        q: "文件会上传到什么地方吗？",
        a: "不会被存储。文件在你们两个之间流式传输，端到端加密。Relayium 服务器上的一次很小的会合握手负责介绍双方；只要服务器为这个码签发了 TURN 中继，文件字节就以它读不了的密文经这条中继传输——中继上报为计费用量时计入生成配对码那个账号的每月流量额度（Relayium 运营的中继节点会上报，其 coturn TURN 服务器目前不计费：可选的计量采集默认关闭，如果配置为影子模式，也只记录测量值），而且从不留存。",
      },
      {
        q: "如果连接不上怎么办？",
        a: "只要服务器为这个码签发了中继，会话就经它传输，严格 NAT 挡不住。没有签发中继时——没有配置中继，或生成配对码那个账号的额度已用尽——两端需要一条直连路径，没有的话传输会失败。这时可以改用 relayium up 创建存储链接，或者在你运行的两台可达服务器之间用 relayium serve 配合 push / sync。",
      },
      {
        q: "我怎么知道对面真的是对的人？",
        a: "两边的终端会打印出一个从双方交换的密钥派生的相同 6 位 SAS 码。通过带外方式核对；一致就能确认密钥没有被替换、会合服务没有冒充任一端。它认证的是端点，而不是网络路径上的每一跳。加上 --verify 可以要求在任何字节移动之前先完成这个确认。",
      },
    ],
  },
  cta: {
    text: "把你的下一个文件发给另一个网络上的人——端到端加密，不按次收费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI でネットワークを越えて誰かにファイルを送る",
  description:
    "relayium send と receive を使い、短いペアリングコードだけで異なるネットワーク上の2人の間でファイルを移動します。エンドツーエンドで暗号化され、任意で SAS コードを照合できます。サーバーがそのコードにリレーを発行した場合、ファイルは暗号文としてそのリレーを通り、コードを発行したアカウントの月間転送量の枠に計上されます。",
  updatedLabel: "最終更新",
  lead: [
    "相手のマシンが自分のものではなく SSH でログインできないこともあります。別のオフィスの同僚へのファイル、クライアント向けのビルド、遠方の友人へのアーカイブ。relayium send と receive は、送信時に CLI が発行する短いペアリングコードだけを使って、ネットワークを越えてそれを二人の間で移動させます。",
    "セッションはエンドツーエンドで暗号化されています。Relayium のサーバー上の短いランデブーが二つの端を引き合わせ、サーバーがそのコードに TURN リレーを発行した場合、ファイルのバイトはリレーが読めない暗号文としてそのリレーを通り、コードを発行したアカウントの月間転送量の枠に計上されます。",
  ],
  sections: [
    {
      heading: "まず send、そして表示されたコードを相手に伝える",
      prereqs: {
        label: "必要なもの",
        items: [
          "送信側のマシンに CLI。relayium version がバージョン文字列を表示します。シェルが「command not found」と返すなら、まだ入っていません。相手側も CLI を使えますが、Relayium のアプリやウェブページにコードを入力しても参加できます。",
          "サインイン済みの送信側。relayium whoami がアカウントのメールアドレスを表示します。ペアリングコードの発行には先に relayium login が要ります。受信側のマシンは最後までサインインしません。",
          "二人が同時にオンラインであること。コードの寿命は5分なので、発行する前にタイミングを合わせてください。",
          "6桁の数字を帯域外で伝える手段。通話でも、チャットの窓でも、同じ部屋にいるならそのままでも構いません。",
        ],
      },
      body: [
        "最初に一度だけ relayium login でサインインし、あとは send するだけです。CLI がペアリングコードを発行し、相手が実行するコマンドとあわせて表示して待機します。そのコードを帯域外で伝えてください。通話で伝える、チャットに書く、など：",
      ],
      steps: [
        {
          text: "送信側のマシンで一度だけサインインします。relayium whoami がすでにアカウントのメールアドレスを表示するなら、この手順は飛ばしてください。",
          code: ["relayium login"],
        },
        {
          text: "ファイルのあるディレクトリで送信を開始します。CLI がコードを発行し、相手が実行するコマンドを表示して待機します。",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "表示された6桁の数字を帯域外で相手に伝えます。発行から5分で使えなくなります。",
        },
        {
          text: "受信側のマシンで、ファイルを置きたいディレクトリに移動し、送信側に表示されたコマンドを実行します。別の場所に置きたければディレクトリを足します。",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "受信側のシェルがプロンプトに戻るまで、両方の端末を開いたままにしてください。これは1つのライブセッションで、どちらかを閉じれば転送は止まります。",
        },
      ],
      success: {
        label: "成功したときの表示",
        body: [
          "送信側はまず引き渡しブロックを表示して待機し、続いて検証コードと得られた経路を表示します。両方の端末に同じ検証コードが出て、どちらも終了コード 0 で終わります。",
        ],
        code: [
          `# 送信側
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      bullets: [
        "コードは 6 桁の十進数字です。0-9 のいずれも現れ、先頭が 0 になることもあります。そして発行から 5 分で失効します。",
        "コードは合流するための共有シークレットにすぎません。ランデブー先以外の誰にも送られず、二つの端を引き合わせるためだけに使われます。",
        "相手側は CLI でなくても構いません。relayium receive、relayium pair、Relayium のアプリ、ウェブページのどれでもこのコードに参加できます。相手が今オンラインでないなら、relayium up でダウンロードリンクを作ってください。",
      ],
    },
    {
      heading: "SAS コードで検証する",
      body: [
        "二つの端が接続すると、両方のターミナルに固定された TLS 証明書フィンガープリントから導かれた同じ6桁の SAS（short authentication string）が表示されます。帯域外で照合し（通話中に読み上げるなど）、フィンガープリントが差し替えられておらず、ランデブーサービスがどちらのエンドポイントにもなりすましていないことを確認してください。SAS はエンドポイントを認証するもので、ネットワーク経路上のすべてのホップを証明するものではありません。",
        "最も強い保護が必要なら --verify を付けます。すると転送は、コードが一致することを確認するまで、1バイトも動かさずに待機します。",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "リレーか P2P か、そして何に計上されるか",
      body: [
        "path の行を見れば、バイトがどちらを通ったかが分かります。relay か、P2P を示す direct / lan です。どちらの場合もファイルはエンドツーエンドで暗号化され、転送ごとの料金もありません。中継されたバイトは、コードを発行したアカウントの月間転送量の枠に利用量として計上されます。",
        cliDirectFacts.ja,
        "転送がつながらない場合、確実な方法は relayium up で作る保存リンクか、自分で運用する到達可能な2台のサーバー間での relayium serve と push / sync です。後者は直結で、計測されません。",
      ],
      bullets: [
        "リレーが発行された → すべてのバイトが暗号化リレーを通り、コードを発行したアカウントの月間転送量の枠に計上されます。",
        "リレーが発行されない → 直接の経路があれば両端は P2P でつながり、なければセッションは失敗します。",
      ],
    },
    {
      heading: "うまくいかないとき",
      body: [
        "失敗のほとんどは次の4つに収まります。どれにも、それだと決められる表示行か実行できるコマンドがあるので、どちら側の問題かを勘で決める必要はありません。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "送信側が「minting a pairing code needs an account」と出て始まらない。",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "そのマシンに保存された資格情報がありません。relayium login を実行してブラウザーで承認してください。以後 whoami はアカウントのメールアドレスを表示し、送信も通ります。この時点ではコードは発行されていないので、無駄にしたものはありません。",
          },
          {
            symptom: "受信側がコードを入力してもランデブーが受け付けない。",
            code: [
              `# 送信側：引き渡しブロックに正確な寿命が書かれている
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "コードが失効しています。送信側で Ctrl-C を押し、relayium send ./release.zip をもう一度実行して、新しい引き渡しブロックが示す5分のうちに新しい6桁を伝えてください。",
          },
          {
            symptom: "二つの端末が別々の検証コードを表示する。",
            code: ["relayium send --verify ./release.zip"],
            fix: "止めて、ファイルは送らないでください。検証コードが食い違うのは、両端がピン留めした証明書フィンガープリントが一致しないということ、つまり相手側は想定したマシンではないということです。--verify を付けて実行し直すと、その照合で転送が止まって確認を待ちます。あわせて相手がどのマシンにいるのかを確かめてください。",
          },
          {
            symptom: "「no direct connection to the peer (both ends behind strict NAT?)」。",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "片方の端が古い relayium で、そのペアリングは直結専用のため、どちらの端も相手に届きませんでした。両端を更新してください。現在の relayium は、サーバーがそのコードにリレーを発行すれば暗号化リレーを通ります。それ以外の場合は、片方を到達可能なアドレスを持つネットワーク（サーバー、あるいはスマートフォンのテザリング）へ移すか、relayium up でアップロードしてダウンロードリンクを渡してください。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ペアリングコードはどこから来るのですか？",
        a: "Relayium が発行します。relayium login のうえで relayium send ./release.zip を実行すると、CLI が 5 分間有効な 6 桁の数字コードと、相手が実行するコマンドをそのまま表示します。自分で選ぶことはできません。サーバーは自身が発行したコードしか受け付けないからです。",
      },
      {
        q: "ファイルはどこかにアップロードされますか？",
        a: "保存はされません。ファイルは二人の間でストリーミングされ、エンドツーエンドで暗号化されます。Relayium のサーバー上の小さなランデブーハンドシェイクが二つの端を引き合わせ、サーバーがそのコードに TURN リレーを発行した場合、ファイルのバイトはリレーが読めない暗号文としてそのリレーを通ります。コードを発行したアカウントの月間転送量の枠に計上され、保持されることはありません。",
      },
      {
        q: "接続できない場合はどうなりますか？",
        a: "サーバーがそのコードにリレーを発行すれば、セッションはリレーを通るので、厳格な NAT でも止まりません。リレーが発行されないとき（リレーが設定されていない、またはコードを発行したアカウントの枠を使い切ったとき）は両端に直接の経路が必要で、なければ転送は失敗します。その場合は relayium up で作る保存リンクか、自分で運用する到達可能な2台のサーバー間での relayium serve と push / sync を使ってください。",
      },
      {
        q: "相手が本当に正しい人物だとどうやって分かりますか？",
        a: "両方のターミナルが固定された TLS 証明書フィンガープリントから導かれた同一の6桁の SAS コードを表示します。帯域外で照合すると、フィンガープリントが差し替えられておらず、ランデブーサービスがどちらのエンドポイントにもなりすましていないことを確認できます。これはエンドポイントを認証するもので、ネットワーク経路上のすべてのホップを証明するものではありません。バイトが動く前にその確認を必須にするには --verify を追加します。",
      },
    ],
  },
  cta: {
    text: "次のファイルを、別のネットワークにいる相手へ送りましょう。エンドツーエンドで暗号化され、転送ごとの料金はかかりません。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 네트워크를 넘어 상대에게 파일 보내기",
  description:
    "relayium send와 receive를 사용해, 짧은 페어링 코드 하나로 서로 다른 네트워크에 있는 두 사람 사이에서 파일을 옮기세요. 종단간 암호화되고 SAS 코드로 선택적으로 검증할 수 있습니다. 서버가 해당 코드에 릴레이를 발급하면 파일은 암호문으로 그 릴레이를 거치며, 코드를 발급한 계정의 월간 전송량 한도에 집계됩니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "때로는 상대의 컴퓨터가 내 것이 아니어서 SSH로 접속할 수 없을 때가 있습니다. 다른 사무실 동료에게 줄 파일, 고객에게 줄 빌드, 먼 곳의 친구에게 줄 아카이브. relayium send와 receive는 보낼 때 CLI가 발급하는 짧은 페어링 코드 하나만으로 네트워크를 넘어 그것을 두 사람 사이에 옮깁니다.",
    "세션은 종단간 암호화됩니다. Relayium 서버의 짧은 랑데부가 두 끝을 서로 소개하며, 서버가 해당 코드에 TURN 릴레이를 발급하면 파일 바이트는 릴레이가 읽을 수 없는 암호문으로 그 릴레이를 거치고, 코드를 발급한 계정의 월간 전송량 한도에 집계됩니다.",
  ],
  sections: [
    {
      heading: "먼저 send하고, 출력된 코드를 상대에게 전달하기",
      prereqs: {
        label: "필요한 것",
        items: [
          "보내는 기기에 설치된 CLI. relayium version 이 버전 문자열을 출력합니다. 셸이 “command not found”를 돌려주면 아직 없는 것입니다. 상대도 CLI를 쓸 수 있고, Relayium 앱이나 웹 페이지에 코드를 입력해 참여할 수도 있습니다.",
          "로그인된 보내는 쪽. relayium whoami 가 계정 이메일을 출력합니다. 페어링 코드를 발급하려면 먼저 relayium login 이 필요합니다. 받는 쪽 기기는 끝까지 로그인하지 않습니다.",
          "두 사람이 같은 시간에 온라인일 것. 코드의 수명은 5분이므로 발급하기 전에 시점을 맞추세요.",
          "여섯 자리 숫자를 대역 외로 전할 수단 — 통화, 채팅 창, 아니면 두 사람이 함께 있는 그 방.",
        ],
      },
      body: [
        "relayium login으로 한 번만 로그인한 뒤에는 그냥 send하면 됩니다. CLI가 페어링 코드를 발급해 상대가 실행할 명령과 함께 출력하고 기다립니다. 그 코드를 대역 외 방식으로 전달하세요. 통화로 말하거나 채팅에 남기면 됩니다:",
      ],
      steps: [
        {
          text: "보내는 기기에서 한 번만 로그인합니다. relayium whoami 가 이미 계정 이메일을 출력한다면 이 단계는 건너뛰세요.",
          code: ["relayium login"],
        },
        {
          text: "파일이 있는 디렉터리에서 전송을 시작합니다. CLI가 코드를 발급하고, 상대가 실행할 명령을 출력한 뒤 기다립니다.",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "출력된 여섯 자리 숫자를 대역 외로 상대에게 읽어 줍니다. 발급 후 5분이 지나면 더는 통하지 않습니다.",
        },
        {
          text: "받는 기기에서 파일이 저장될 디렉터리로 이동해, 보내는 쪽에 표시된 명령을 실행합니다. 다른 곳에 저장하려면 디렉터리를 덧붙이세요.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "받는 쪽 셸이 프롬프트로 돌아올 때까지 두 터미널을 모두 열어 두세요. 하나의 실시간 세션이라 어느 쪽이든 닫으면 전송이 멈춥니다.",
        },
      ],
      success: {
        label: "성공했을 때 보이는 것",
        body: [
          "보내는 쪽은 먼저 인계 블록을 출력하고 기다린 뒤, 검증 코드와 확보한 경로를 출력합니다. 두 터미널에 같은 검증 코드가 나오고, 양쪽 모두 0으로 종료됩니다.",
        ],
        code: [
          `# 보내는 쪽
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      bullets: [
        "코드는 6자리 십진 숫자입니다. 0-9 어느 것이든 나올 수 있고 앞자리가 0일 수도 있습니다. 그리고 발급된 지 5분이 지나면 만료됩니다.",
        "이 코드는 만남을 위한 공유 비밀일 뿐입니다. 랑데부 서버 외에는 누구에게도 전송되지 않으며, 오직 두 끝을 서로 소개하는 데만 쓰입니다.",
        "상대가 꼭 CLI일 필요는 없습니다. relayium receive, relayium pair, Relayium 앱, 웹 페이지 모두 이 코드에 참여할 수 있습니다. 상대가 지금 온라인이 아니라면 relayium up으로 다운로드 링크를 만드세요.",
      ],
    },
    {
      heading: "SAS 코드로 검증하기",
      body: [
        "두 끝이 연결되면 양쪽 터미널에 고정된 TLS 인증서 지문에서 파생된 동일한 6자리 SAS(짧은 인증 문자열)가 출력됩니다. 이를 대역 외로 비교하세요. 통화 중에 소리 내어 읽으면 됩니다. 일치하면 지문이 바뀌지 않았고 랑데부 서비스가 어느 끝점도 사칭하지 않았음을 확인할 수 있습니다. SAS는 끝점을 인증하는 것이지 네트워크 경로의 모든 홉을 증명하는 것은 아닙니다.",
        "가장 강한 보호를 원하면 --verify를 추가하세요. 그러면 전송은 코드가 일치함을 확인할 때까지 단 1바이트도 움직이지 않고 기다립니다.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "릴레이인가 P2P인가, 그리고 무엇에 집계되는가",
      body: [
        "path 줄을 보면 바이트가 어느 길로 갔는지 알 수 있습니다. relay, 또는 P2P를 뜻하는 direct / lan입니다. 어느 쪽이든 파일은 종단간 암호화되고 전송별 요금도 없습니다. 릴레이된 바이트는 코드를 발급한 계정의 월간 전송량 한도에 사용량으로 집계됩니다.",
        cliDirectFacts.ko,
        "전송이 연결되지 않는다면 확실한 방법은 relayium up으로 만드는 저장 링크, 또는 직접 운영하는 도달 가능한 두 서버 사이의 relayium serve와 push / sync입니다. 후자는 직접 연결이며 계량되지 않습니다.",
      ],
      bullets: [
        "릴레이 발급됨 → 모든 바이트가 암호화된 릴레이를 거치며, 코드를 발급한 계정의 월간 전송량 한도에 집계됩니다.",
        "릴레이 발급 안 됨 → 직접 경로가 있으면 두 끝이 P2P로 연결되고, 없으면 세션이 실패합니다.",
      ],
    },
    {
      heading: "잘 안 될 때",
      body: [
        "실패의 대부분은 아래 네 가지에 들어갑니다. 각각 판정해 주는 출력 한 줄이나 실행할 명령이 있으니, 어느 쪽 문제인지 추측할 필요가 없습니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "보내는 쪽이 “minting a pairing code needs an account”를 내며 시작하지 않습니다.",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "그 기기에 저장된 자격 증명이 없습니다. relayium login 을 실행하고 브라우저에서 승인하세요. 그 뒤 whoami 가 계정 이메일을 출력하고 전송도 진행됩니다. 아직 발급된 코드가 없으므로 낭비된 코드도 없습니다.",
          },
          {
            symptom: "받는 쪽이 코드를 입력해도 랑데부가 받아 주지 않습니다.",
            code: [
              `# 보내는 쪽 — 인계 블록에 정확한 수명이 적혀 있습니다
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "코드가 만료됐습니다. 보내는 쪽에서 Ctrl-C 를 누르고 relayium send ./release.zip 을 다시 실행한 뒤, 새 인계 블록이 알려 주는 5분 안에 새 여섯 자리를 전달하세요.",
          },
          {
            symptom: "두 터미널이 서로 다른 검증 코드를 출력합니다.",
            code: ["relayium send --verify ./release.zip"],
            fix: "멈추고 파일을 보내지 마세요. 검증 코드가 다르다는 것은 양쪽이 고정한 인증서 지문이 어긋난다는 뜻, 곧 반대편이 생각한 그 기기가 아니라는 뜻입니다. --verify 를 붙여 다시 실행하면 그 비교 지점에서 전송을 멈추고 확인을 기다립니다. 동시에 상대가 어느 기기에 있는지 확인하세요.",
          },
          {
            symptom: "“no direct connection to the peer (both ends behind strict NAT?)”.",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "한쪽이 페어링이 직접 연결 전용인 이전 relayium이어서, 양쪽 어느 쪽도 상대에 닿지 못했습니다. 양쪽을 업데이트하세요. 현재 relayium은 서버가 해당 코드에 릴레이를 발급하면 암호화된 릴레이를 거칩니다. 그 밖의 경우에는 한쪽을 도달 가능한 주소가 있는 네트워크 — 서버나 휴대폰 핫스팟 — 로 옮기거나, relayium up 으로 올린 뒤 다운로드 링크를 건네세요.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "페어링 코드는 어디서 나오나요?",
        a: "Relayium이 발급합니다. relayium login 후 relayium send ./release.zip을 실행하면 CLI가 5분간 유효한 6자리 숫자 코드와 상대가 실행할 명령을 그대로 출력합니다. 직접 고를 수는 없습니다. 서버는 자신이 발급한 코드만 받아들이기 때문입니다.",
      },
      {
        q: "파일이 어딘가에 업로드되나요?",
        a: "저장되지 않습니다. 파일은 두 사람 사이에서 스트리밍되며 종단간 암호화됩니다. Relayium 서버의 작은 랑데부 핸드셰이크가 두 끝을 소개하며, 서버가 해당 코드에 TURN 릴레이를 발급하면 파일 바이트는 릴레이가 읽을 수 없는 암호문으로 그 릴레이를 거칩니다. 코드를 발급한 계정의 월간 전송량 한도에 집계되며, 보관되지 않습니다.",
      },
      {
        q: "연결이 안 되면 어떻게 되나요?",
        a: "서버가 해당 코드에 릴레이를 발급하면 세션이 릴레이를 거치므로 엄격한 NAT에도 막히지 않습니다. 릴레이가 발급되지 않을 때(릴레이가 구성되지 않았거나 코드를 발급한 계정의 한도를 모두 쓴 경우)는 두 끝에 직접 경로가 필요하며, 없으면 전송이 실패합니다. 그때는 relayium up으로 만드는 저장 링크나, 직접 운영하는 도달 가능한 두 서버 사이의 relayium serve와 push / sync를 사용하세요.",
      },
      {
        q: "상대가 정말 맞는 사람인지 어떻게 알 수 있나요?",
        a: "양쪽 터미널이 고정된 TLS 인증서 지문에서 파생된 동일한 6자리 SAS 코드를 출력합니다. 대역 외로 비교하면 지문이 바뀌지 않았고 랑데부 서비스가 어느 끝점도 사칭하지 않았음을 확인할 수 있습니다. 이는 끝점을 인증하는 것이지 네트워크 경로의 모든 홉을 증명하는 것은 아닙니다. 바이트가 움직이기 전에 이 확인을 필수로 하려면 --verify를 추가하세요.",
      },
    ],
  },
  cta: {
    text: "다음 파일을 다른 네트워크에 있는 상대에게 보내세요. 종단간 암호화되며 전송별 요금은 없습니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Mit der Relayium CLI eine Datei über Netzwerke hinweg an jemanden senden",
  description:
    "Nutze relayium send und receive, um eine Datei mithilfe eines kurzen Pairing-Codes zwischen zwei Personen in unterschiedlichen Netzwerken zu bewegen. Ende-zu-Ende verschlüsselt, mit einem optionalen SAS-Code zum Vergleichen. Stellt der Server für den Code ein Relay aus, läuft die Datei als Chiffretext darüber und zählt zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Manchmal ist die andere Maschine nicht deine eigene und du kannst dich nicht per SSH einloggen — eine Datei für eine Kollegin in einem anderen Büro, ein Build für einen Kunden, ein Archiv für einen Freund am anderen Ende des Landes. relayium send und receive bewegen sie über Netzwerke hinweg zwischen euch beiden, nur mit einem kurzen Pairing-Code, den deine CLI beim Senden erzeugt.",
    "Die Sitzung ist Ende-zu-Ende verschlüsselt. Ein kurzes Rendezvous auf dem Relayium-Server stellt die beiden Enden einander vor; stellt der Server für den Code ein TURN-Relay aus, laufen die Dateibytes danach als Chiffretext, den das Relay nicht lesen kann, darüber und zählen zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat.",
  ],
  sections: [
    {
      heading: "Erst senden, dann den ausgegebenen Code weitergeben",
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Die CLI auf dem sendenden Rechner. relayium version gibt eine Versionsnummer aus; antwortet die Shell mit „command not found“, ist sie noch nicht installiert. Die Gegenseite kann ebenfalls die CLI nutzen oder den Code in eine Relayium-App oder die Webseite eingeben.",
          "Einen angemeldeten Absender. relayium whoami gibt die Konto-E-Mail aus; das Erzeugen eines Pairing-Codes setzt relayium login voraus. Der empfangende Rechner meldet sich nie an.",
          "Euch beide gleichzeitig online. Der Code lebt fünf Minuten, stimmt den Moment also ab, bevor du einen erzeugst.",
          "Einen Weg, sechs Ziffern außerhalb des Kanals zu übermitteln — ein Anruf, ein Chatfenster, oder der Raum, in dem ihr beide sitzt.",
        ],
      },
      body: [
        "Melde dich einmalig mit relayium login an, danach sendest du einfach. Die CLI erzeugt einen Pairing-Code, gibt ihn zusammen mit dem Befehl aus, den die andere Seite ausführt, und wartet. Gib diesen Code außerhalb des Kanals weiter — sag ihn am Telefon, schreib ihn in einen Chat:",
      ],
      steps: [
        {
          text: "Melde dich auf dem sendenden Rechner einmal an. Überspring das, wenn relayium whoami schon deine Konto-E-Mail ausgibt.",
          code: ["relayium login"],
        },
        {
          text: "Starte das Senden aus dem Verzeichnis, in dem die Datei liegt. Die CLI erzeugt den Code, gibt den Befehl für die Gegenseite aus und wartet dann.",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "Gib die ausgegebenen sechs Ziffern außerhalb des Kanals weiter. Fünf Minuten nach dem Erzeugen funktionieren sie nicht mehr.",
        },
        {
          text: "Führ auf dem empfangenden Rechner, im Verzeichnis, in dem die Dateien landen sollen, den Befehl aus, den der Absender angezeigt bekam. Ein Verzeichnis dahinter schickt sie woandershin.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Lass beide Terminals laufen, bis die empfangende Shell zu ihrem Prompt zurückkehrt. Das ist eine einzige Live-Sitzung: Schließt du eine Seite, endet die Übertragung.",
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Lauf aus",
        body: [
          "Der Absender gibt erst den Übergabeblock aus und wartet, dann einen Verifizierungscode und den Pfad, den er bekommen hat. Beide Terminals zeigen denselben Verifizierungscode, und beide enden mit 0.",
        ],
        code: [
          `# auf dem ABSENDER
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      bullets: [
        "Der Code besteht aus 6 Dezimalziffern — jede von 0-9, führende Nullen eingeschlossen — und läuft 5 Minuten nach dem Erzeugen ab.",
        "Der Code ist nur ein gemeinsames Geheimnis zum Treffen; er wird an niemanden außer der Rendezvous-Stelle gesendet und stellt nur die beiden Enden einander vor.",
        "Die Gegenseite muss nicht die CLI sein: relayium receive, relayium pair, eine Relayium-App oder die Webseite können dem Code beitreten. Ist die Person gerade nicht online? Nimm relayium up für einen Download-Link.",
      ],
    },
    {
      heading: "Mit dem SAS-Code verifizieren",
      body: [
        "Sobald sich die beiden Enden verbinden, geben beide Terminals denselben 6-stelligen SAS (Short Authentication String) aus, der aus den angehefteten TLS-Zertifikatsfingerabdrücken abgeleitet ist. Vergleicht ihn außerhalb des Kanals — lest ihn beim Telefonat laut vor —, um zu bestätigen, dass die Fingerabdrücke nicht ausgetauscht wurden und der Rendezvous-Dienst keinen Endpunkt imitiert hat. Der SAS authentifiziert die Endpunkte; er beweist nicht jeden Netzwerk-Hop.",
        "Für den stärksten Schutz fügt --verify hinzu: Die Übertragung wartet dann, bis ihr bestätigt, dass die Codes übereinstimmen, bevor auch nur ein einziges Byte bewegt wird.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Relay oder Peer-to-Peer — und worauf es angerechnet wird",
      body: [
        "Die path-Zeile zeigt, welchen Weg die Bytes genommen haben: relay oder, für Peer-to-Peer, direct / lan. So oder so ist die Datei Ende-zu-Ende verschlüsselt, und so oder so gibt es keine Gebühr pro Übertragung — weitergeleitete Bytes werden als Nutzung auf das monatliche Datenvolumen des Kontos angerechnet, das den Code erzeugt hat.",
        cliDirectFacts.de,
        "Kommt keine Verbindung zustande, sind die verlässlichen Antworten ein gespeicherter Link aus relayium up oder relayium serve mit push / sync zwischen zwei erreichbaren Servern, die du betreibst — dieser Weg ist direkt und wird nicht gezählt.",
      ],
      bullets: [
        "Relay ausgestellt → jedes Byte läuft über das verschlüsselte Relay und zählt zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat.",
        "Kein Relay ausgestellt → die beiden Enden verbinden sich per Peer-to-Peer, wenn ein direkter Weg existiert; sonst schlägt die Sitzung fehl.",
      ],
    },
    {
      heading: "Wenn es nicht klappt",
      body: [
        "Vier Fehler machen fast jeden misslungenen Versuch aus. Zu jedem gibt es eine Zeile zum Lesen oder einen Befehl zum Ausführen, der ihn entscheidet — du musst nie raten, welche Seite schuld ist.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Der Absender startet gar nicht: „minting a pairing code needs an account“.",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Auf diesem Rechner liegen keine Zugangsdaten. Führ relayium login aus und bestätige im Browser; danach gibt whoami die Konto-E-Mail aus und das Senden läuft durch. Es wurde nichts erzeugt, also ist auch kein Code verbraucht.",
          },
          {
            symptom: "Der Empfänger tippt den Code ein und das Rendezvous lehnt ihn ab.",
            code: [
              `# auf dem ABSENDER — der Übergabeblock nennt die genaue Lebensdauer
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "Der Code ist abgelaufen. Drück auf dem Absender Ctrl-C, führ relayium send ./release.zip erneut aus und gib die frischen sechs Ziffern innerhalb der fünf Minuten weiter, die der neue Übergabeblock nennt.",
          },
          {
            symptom: "Die beiden Terminals zeigen unterschiedliche Verifizierungscodes.",
            code: ["relayium send --verify ./release.zip"],
            fix: "Halt an und schick die Datei nicht. Unterschiedliche Codes heißen, dass die angehefteten Zertifikatsfingerabdrücke der beiden Enden nicht übereinstimmen — die Gegenseite ist also nicht der Rechner, für den du sie hältst. Führ es mit --verify erneut aus, das die Übertragung an genau diesem Vergleich anhält, und klär mit der anderen Person, an welchem Rechner sie sitzt.",
          },
          {
            symptom: "„no direct connection to the peer (both ends behind strict NAT?)“.",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Ein Ende nutzt ein älteres relayium, dessen Pairing nur direkt verbindet, und keine Seite hat die andere erreicht. Aktualisiere beide Enden: Ein aktuelles relayium läuft über das verschlüsselte Relay, sobald der Server für den Code eines ausstellt. Sonst bring ein Ende in ein Netz mit erreichbarer Adresse — einen Server oder einen Handy-Hotspot — oder lade die Datei mit relayium up hoch und gib stattdessen den Download-Link weiter.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Woher kommt der Pairing-Code?",
        a: "Relayium erzeugt ihn. Führe relayium send ./release.zip aus (nach relayium login), und die CLI gibt einen Code aus 6 Ziffern aus, der fünf Minuten gilt, dazu den genauen Befehl für die andere Seite. Selbst wählen kannst du ihn nicht — der Server akzeptiert nur Codes, die er selbst ausgegeben hat.",
      },
      {
        q: "Wird die Datei irgendwohin hochgeladen?",
        a: "Gespeichert wird sie nicht. Die Datei fließt zwischen euch beiden, Ende-zu-Ende verschlüsselt. Ein kleiner Rendezvous-Handshake auf dem Relayium-Server stellt die Enden einander vor, und stellt der Server für den Code ein TURN-Relay aus, laufen die Dateibytes als Chiffretext, den es nicht lesen kann, darüber — gezählt zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat, und nie aufbewahrt.",
      },
      {
        q: "Was, wenn wir keine Verbindung herstellen können?",
        a: "Stellt der Server für den Code ein Relay aus, läuft die Sitzung darüber, und strenges NAT hält sie nicht auf. Wird keines ausgestellt — keines ist konfiguriert oder das Kontingent des erzeugenden Kontos ist aufgebraucht —, brauchen die beiden Enden einen direkten Weg, und ohne ihn schlägt die Übertragung fehl. Nutzt dann einen gespeicherten Link aus relayium up oder relayium serve mit push / sync zwischen zwei erreichbaren Servern, die ihr betreibt.",
      },
      {
        q: "Woher weiß ich, dass wirklich die richtige Person am anderen Ende ist?",
        a: "Beide Terminals geben einen identischen 6-stelligen SAS-Code aus den angehefteten TLS-Zertifikatsfingerabdrücken aus. Vergleicht ihn außerhalb des Kanals; eine Übereinstimmung bestätigt, dass die Fingerabdrücke nicht ausgetauscht wurden und der Rendezvous-Dienst keinen Endpunkt imitiert hat. Er authentifiziert die Endpunkte, nicht jeden Netzwerk-Hop. Fügt --verify hinzu, um diese Bestätigung zu verlangen, bevor Bytes bewegt werden.",
      },
    ],
  },
  cta: {
    text: "Schicke deine nächste Datei an jemanden in einem anderen Netzwerk — Ende-zu-Ende verschlüsselt, ohne Gebühr pro Übertragung.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer un fichier à quelqu'un à travers les réseaux avec la CLI Relayium",
  description:
    "Utilisez relayium send et receive pour déplacer un fichier entre deux personnes sur des réseaux différents, à l'aide d'un court code d'appairage. Chiffré de bout en bout, avec un code SAS facultatif à comparer. Dès que le serveur attribue un relais pour le code, le fichier y passe sous forme chiffrée et est décompté du quota mensuel de trafic du compte qui a généré le code.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Parfois l'autre machine n'est pas la vôtre et vous ne pouvez pas vous y connecter en SSH — un fichier pour un collègue dans un autre bureau, un build pour un client, une archive pour un ami à l'autre bout du pays. relayium send et receive le déplacent entre vous deux à travers les réseaux, en utilisant seulement un court code d'appairage que votre CLI génère au moment de l'envoi.",
    "La session est chiffrée de bout en bout. Un court rendez-vous sur le serveur de Relayium présente les deux extrémités ; dès que le serveur attribue un relais TURN pour le code, les octets du fichier passent par ce relais sous forme de texte chiffré qu'il ne peut pas lire, et sont décomptés du quota mensuel de trafic du compte qui a généré le code.",
  ],
  sections: [
    {
      heading: "Faire send, puis transmettre le code affiché",
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "La CLI sur la machine qui envoie. relayium version affiche un numéro de version ; si le shell répond « command not found », elle n'est pas encore installée. L'autre bout peut aussi utiliser la CLI, ou saisir le code dans une application Relayium ou sur la page web.",
          "Un expéditeur connecté. relayium whoami affiche l'adresse e-mail du compte, et générer un code d'appairage exige d'abord relayium login. La machine réceptrice ne se connecte jamais.",
          "Vous deux en ligne au même moment. Le code vit cinq minutes, alors convenez de l'instant avant d'en générer un.",
          "Un moyen de dicter six chiffres hors bande — un appel, une fenêtre de chat, ou la pièce où vous vous trouvez tous les deux.",
        ],
      },
      body: [
        "Connectez-vous une fois avec relayium login, puis contentez-vous de faire send. La CLI génère un code d'appairage, l'affiche avec la commande exacte que l'autre extrémité doit exécuter, et attend. Transmettez ce code hors bande — dites-le au téléphone, glissez-le dans un chat :",
      ],
      steps: [
        {
          text: "Sur la machine émettrice, connectez-vous une seule fois. Passez cette étape si relayium whoami affiche déjà l'adresse de votre compte.",
          code: ["relayium login"],
        },
        {
          text: "Depuis le répertoire qui contient le fichier, lancez l'envoi. La CLI génère le code, affiche la commande destinée à l'autre extrémité, puis attend.",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "Dictez hors bande les six chiffres affichés. Ils cessent de fonctionner cinq minutes après leur génération.",
        },
        {
          text: "Sur la machine réceptrice, dans le répertoire où les fichiers doivent arriver, lancez la commande affichée à l'expéditeur. Ajoutez un répertoire pour les déposer ailleurs.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Laissez les deux terminaux ouverts jusqu'à ce que le shell récepteur revienne à son invite. C'est une seule session en direct, et fermer une extrémité arrête le transfert.",
        },
      ],
      success: {
        label: "À quoi ressemble une exécution réussie",
        body: [
          "L'expéditeur affiche d'abord le bloc de passation et attend, puis un code de vérification et le chemin obtenu. Les deux terminaux montrent le même code de vérification, et tous deux se terminent par 0.",
        ],
        code: [
          `# côté EXPÉDITEUR
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      bullets: [
        "Le code fait 6 chiffres décimaux — n'importe lequel de 0 à 9, zéros initiaux compris — et il expire 5 minutes après sa génération.",
        "Le code n'est qu'un secret partagé pour se retrouver ; il n'est envoyé à personne d'autre qu'au point de rendez-vous, et il ne sert qu'à présenter les deux extrémités.",
        "L'autre bout n'a pas besoin d'être la CLI : relayium receive, relayium pair, une application Relayium ou la page web peuvent rejoindre le code. La personne n'est pas en ligne en ce moment ? Utilisez relayium up pour obtenir un lien de téléchargement.",
      ],
    },
    {
      heading: "Vérifier avec le code SAS",
      body: [
        "Quand les deux extrémités se connectent, les deux terminaux affichent le même SAS (short authentication string) à 6 chiffres, dérivé des empreintes des certificats TLS épinglés. Comparez-le hors bande — lisez-le à voix haute pendant l'appel — pour confirmer que les empreintes n'ont pas été substituées et que le service de rendez-vous n'a usurpé aucune extrémité. Le SAS authentifie les extrémités ; il ne prouve pas chaque saut réseau.",
        "Pour la protection la plus forte, ajoutez --verify : le transfert attend alors que vous confirmiez que les codes correspondent avant qu'un seul octet ne bouge.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Relais ou pair-à-pair — et sur quoi c'est décompté",
      body: [
        "La ligne path indique le chemin pris par les octets : relay, ou direct / lan pour le pair-à-pair. Dans les deux cas le fichier est chiffré de bout en bout, et dans les deux cas il n'y a aucun frais par transfert — les octets relayés sont comptabilisés comme usage sur le quota mensuel de trafic du compte qui a généré le code.",
        cliDirectFacts.fr,
        "Si un transfert ne parvient pas à se connecter, les réponses fiables sont un lien stocké créé avec relayium up, ou relayium serve avec push / sync entre deux serveurs joignables que vous exploitez — ce chemin est direct et non décompté.",
      ],
      bullets: [
        "Relais attribué → chaque octet passe par le relais chiffré et est décompté du quota mensuel de trafic du compte qui a généré le code.",
        "Aucun relais attribué → les deux extrémités se connectent en pair-à-pair s'il existe un chemin direct ; sinon la session échoue.",
      ],
    },
    {
      heading: "Quand ça ne marche pas",
      body: [
        "Quatre pannes couvrent presque toutes les tentatives ratées. Chacune a une ligne à lire ou une commande à lancer qui la tranche, donc vous n'avez jamais à deviner quelle extrémité est en cause.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "L'expéditeur refuse de démarrer : « minting a pairing code needs an account ».",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Cette machine n'a aucune information d'identification enregistrée. Lancez relayium login et approuvez dans le navigateur. Ensuite whoami affiche l'adresse du compte et l'envoi passe. Rien n'avait été généré, donc aucun code n'a été gaspillé.",
          },
          {
            symptom: "Le destinataire saisit le code et le point de rendez-vous le refuse.",
            code: [
              `# côté EXPÉDITEUR — le bloc de passation indique la durée de vie exacte
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "Le code a expiré. Faites Ctrl-C côté expéditeur, relancez relayium send ./release.zip, puis dictez les six nouveaux chiffres dans les cinq minutes qu'annonce le nouveau bloc de passation.",
          },
          {
            symptom: "Les deux terminaux affichent des codes de vérification différents.",
            code: ["relayium send --verify ./release.zip"],
            fix: "Arrêtez-vous et n'envoyez pas le fichier. Des codes différents signifient que les empreintes des certificats épinglées par les deux extrémités ne concordent pas, donc que l'autre bout n'est pas la machine que vous croyez. Relancez avec --verify, qui bloque le transfert à cette comparaison jusqu'à votre confirmation, et vérifiez avec la personne en face sur quelle machine elle se trouve.",
          },
          {
            symptom: "« no direct connection to the peer (both ends behind strict NAT?) ».",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Une extrémité utilise un ancien relayium dont l'appairage est uniquement direct, et aucune n'a pu atteindre l'autre. Mettez les deux à jour : un relayium actuel passe par le relais chiffré dès que le serveur en attribue un pour le code. Sinon, déplacez une extrémité vers un réseau doté d'une adresse joignable — un serveur, ou un partage de connexion mobile — ou téléversez le fichier avec relayium up et transmettez plutôt le lien de téléchargement.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "D'où vient le code d'appairage ?",
        a: "C'est Relayium qui le génère. Lancez relayium send ./release.zip (après relayium login) et la CLI affiche un code de 6 chiffres valable cinq minutes, ainsi que la commande exacte que l'autre extrémité doit exécuter. Vous ne pouvez pas le choisir vous-même — le serveur n'accepte que les codes qu'il a émis.",
      },
      {
        q: "Le fichier est-il envoyé quelque part ?",
        a: "Il n'est pas stocké. Le fichier circule entre vous deux, chiffré de bout en bout. Une petite poignée de main de rendez-vous sur le serveur de Relayium présente les extrémités, et dès que le serveur attribue un relais TURN pour le code, les octets du fichier passent par ce relais sous forme de texte chiffré qu'il ne peut pas lire — décomptés du quota mensuel de trafic du compte qui a généré le code, et jamais conservés.",
      },
      {
        q: "Que se passe-t-il si nous ne pouvons pas nous connecter ?",
        a: "Dès que le serveur attribue un relais pour le code, la session y passe, et un NAT strict ne l'arrête pas. Quand aucun relais n'est attribué — aucun n'est configuré, ou le quota du compte qui a généré le code est épuisé —, les deux extrémités ont besoin d'un chemin direct, et sans lui le transfert échoue. Utilisez alors un lien stocké créé avec relayium up, ou relayium serve avec push / sync entre deux serveurs joignables que vous exploitez.",
      },
      {
        q: "Comment savoir que c'est vraiment la bonne personne en face ?",
        a: "Les deux terminaux affichent un code SAS identique à 6 chiffres dérivé des empreintes des certificats TLS épinglés. Comparez-le hors bande ; une concordance confirme que les empreintes n'ont pas été substituées et que le service de rendez-vous n'a usurpé aucune extrémité. Il authentifie les extrémités, pas chaque saut réseau. Ajoutez --verify pour exiger cette confirmation avant qu'aucun octet ne bouge.",
      },
    ],
  },
  cta: {
    text: "Envoyez votre prochain fichier à quelqu'un sur un autre réseau — chiffré de bout en bout, sans frais par transfert.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال ملف إلى شخص ما عبر الشبكات باستخدام واجهة Relayium الطرفية (CLI)",
  description:
    "استخدم relayium send وreceive لنقل ملف بين شخصين على شبكتين مختلفتين، بالاعتماد على رمز اقتران قصير. مُشفَّر من الطرف إلى الطرف، مع رمز SAS اختياري للمقارنة. وكلما أصدر الخادم مُرحِّلًا للرمز، مرّ الملف عبره نصًا مُشفَّرًا واحتُسب ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز.",
  updatedLabel: "آخر تحديث",
  lead: [
    "أحيانًا لا يكون الجهاز الآخر جهازك ولا يمكنك الدخول إليه عبر SSH — ملف لزميل في مكتب آخر، أو نسخة بناء لعميل، أو أرشيف لصديق في الطرف الآخر من البلاد. يقوم relayium send وreceive بنقله بينكما عبر الشبكات، بالاعتماد فقط على رمز اقتران قصير تُصدره واجهة CLI لديك عند الإرسال.",
    "الجلسة مُشفَّرة من الطرف إلى الطرف. يعرّف لقاء قصير على خادم Relayium الطرفين ببعضهما، وكلما أصدر الخادم مُرحِّل TURN للرمز مرّت بايتات الملف بعد ذلك عبر هذا المُرحِّل نصًا مُشفَّرًا لا يستطيع قراءته، واحتُسبت ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز.",
  ],
  sections: [
    {
      heading: "أرسِل أولًا، ثم مرِّر الرمز الذي يُطبَع لك",
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "واجهة CLI على جهاز الإرسال. يطبع relayium version سطر إصدار، وإذا ردَّت الصَدفة بـ «command not found» فهي لم تُثبَّت بعد. ويمكن للطرف الآخر استخدام CLI أيضًا، أو إدخال الرمز في تطبيق Relayium أو صفحة الويب.",
          "مُرسِل مُسجَّل الدخول. يطبع relayium whoami بريد الحساب، وإصدار رمز اقتران يستلزم relayium login أولًا. أما جهاز الاستقبال فلا يسجّل الدخول إطلاقًا.",
          "أن تكونا متصلين في الوقت نفسه. عمر الرمز خمس دقائق، فاتفقا على اللحظة قبل إصداره.",
          "وسيلة لنقل ستة أرقام خارج القناة — مكالمة، أو نافذة محادثة، أو الغرفة التي تجلسان فيها معًا.",
        ],
      },
      body: [
        "سجِّل الدخول مرة واحدة عبر relayium login، ثم اكتفِ بالإرسال. تُصدر واجهة CLI رمز اقتران وتطبعه مع الأمر الذي سينفّذه الطرف الآخر بالضبط، ثم تنتظر. مرِّر هذا الرمز خارج القناة — قُله في مكالمة، أو ألقِه في محادثة:",
      ],
      steps: [
        {
          text: "على جهاز الإرسال، سجّل الدخول مرة واحدة. تخطَّ هذه الخطوة إذا كان relayium whoami يطبع بريد حسابك بالفعل.",
          code: ["relayium login"],
        },
        {
          text: "من المجلد الذي يوجد فيه الملف، ابدأ الإرسال. تُصدر واجهة CLI الرمز، وتطبع الأمر الخاص بالطرف الآخر، ثم تنتظر.",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "اقرأ الأرقام الستة المطبوعة على الطرف الآخر خارج القناة. تتوقف عن العمل بعد خمس دقائق من إصدارها.",
        },
        {
          text: "على جهاز الاستقبال، وداخل المجلد الذي يجب أن تصل إليه الملفات، شغّل الأمر الذي ظهر للمُرسِل. أضِف مجلدًا بعده لإنزالها في مكان آخر.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "اترك الطرفيتين مفتوحتين حتى تعود صَدَفة الاستقبال إلى مِحَثِّها. هذه جلسة حية واحدة، وإغلاق أي طرف يوقف النقل.",
        },
      ],
      success: {
        label: "كيف يبدو التشغيل الناجح",
        body: [
          "يطبع المُرسِل كتلة التسليم أولًا وينتظر، ثم يطبع رمز التحقق والمسار الذي حصل عليه. تعرض الطرفيتان رمز التحقق نفسه، وتنتهيان كلتاهما بالرمز 0.",
        ],
        code: [
          `# على جهاز الإرسال
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      bullets: [
        "الرمز مكوَّن من 6 أرقام عشرية — أي رقم من 0 إلى 9، بما في ذلك الأصفار في المقدمة — وينتهي مفعوله بعد 5 دقائق من إصداره.",
        "الرمز مجرد سر مشترك للقاء؛ لا يُرسَل إلى أحد سوى نقطة التعارف، وهو يُعرِّف الطرفين ببعضهما فقط.",
        "لا يلزم أن يكون الطرف الآخر واجهة CLI: يمكن لـ relayium receive أو relayium pair أو تطبيق Relayium أو صفحة الويب الانضمام إلى الرمز. هل الشخص غير متصل الآن؟ استخدم relayium up للحصول على رابط تنزيل.",
      ],
    },
    {
      heading: "التحقق برمز SAS",
      body: [
        "عندما يتصل الطرفان، تطبع كلتا الطرفيتين رمز SAS (سلسلة المصادقة القصيرة) المكوَّن من 6 أرقام نفسه، والمُشتَق من بصمات شهادات TLS المثبّتة. قارنهما خارج القناة — اقرأ الرمز بصوت عالٍ في المكالمة — لتأكيد أن البصمات لم تُستبدل وأن خدمة الالتقاء لم تنتحل شخصية أي طرف. يصادق SAS على الطرفين؛ ولا يثبت كل قفزة في مسار الشبكة.",
        "لأقوى حماية، أضِف --verify: عندئذٍ ينتظر النقل حتى تؤكد أن الرمزين متطابقان قبل أن يتحرك بايت واحد.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "مُرحِّل أم من نظير إلى نظير — وعلى ماذا يُحتسب",
      body: [
        "يخبرك سطر path بالطريق الذي سلكته البايتات: relay، أو direct / lan للاتصال من نظير إلى نظير. وفي الحالتين يكون الملف مُشفَّرًا من الطرف إلى الطرف، ولا توجد رسوم لكل عملية نقل — فالبايتات المُرحَّلة تُحتسب استخدامًا ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز.",
        cliDirectFacts.ar,
        "إن تعذّر اتصال النقل، فالحلول الموثوقة هي رابط مخزّن تنشئه بأمر relayium up، أو relayium serve مع push / sync بين خادمين يمكن الوصول إليهما تديرهما — وهذا المسار مباشر ولا يُحتسب.",
      ],
      bullets: [
        "صدر مُرحِّل ← يمر كل بايت عبر المُرحِّل المُشفَّر ويُحتسب ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز.",
        "لم يصدر مُرحِّل ← يتصل الطرفان من نظير إلى نظير إن وُجد مسار مباشر، وإلا فشلت الجلسة.",
      ],
    },
    {
      heading: "حين لا ينجح الأمر",
      body: [
        "أربعة أعطال تفسّر تقريبًا كل محاولة فاشلة. لكل واحد منها سطر تقرؤه أو أمر تشغّله يحسم الأمر، فلن تضطر أبدًا إلى تخمين أي الطرفين هو السبب.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "لا يبدأ المُرسِل أصلًا ويطبع «minting a pairing code needs an account».",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "لا توجد بيانات اعتماد محفوظة على هذا الجهاز. شغّل relayium login ووافِق في المتصفح، فيطبع whoami بعدها بريد الحساب ويمضي الإرسال. لم يُصدَر أي رمز بعد، فلم يُهدَر شيء.",
          },
          {
            symptom: "يُدخِل المُستقبِل الرمز فترفضه نقطة التعارف.",
            code: [
              `# على جهاز الإرسال — تذكر كتلة التسليم مدة الصلاحية بالضبط
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "انتهى مفعول الرمز. اضغط Ctrl-C على جهاز الإرسال، وشغّل relayium send ./release.zip من جديد، ثم مرِّر الأرقام الستة الجديدة خلال الدقائق الخمس التي تذكرها كتلة التسليم الجديدة.",
          },
          {
            symptom: "تطبع الطرفيتان رمزَي تحقق مختلفين.",
            code: ["relayium send --verify ./release.zip"],
            fix: "توقّف ولا تُرسِل الملف. اختلاف الرمزين يعني أن بصمات الشهادات المثبّتة على الطرفين غير متطابقة، أي أن الطرف المقابل ليس الجهاز الذي تظنه. أعِد التشغيل مع --verify، فيتوقف النقل عند هذه المقارنة بانتظار تأكيدك، وتحقّق مع الشخص الآخر من الجهاز الذي يعمل عليه.",
          },
          {
            symptom: "«no direct connection to the peer (both ends behind strict NAT?)».",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "يستخدم أحد الطرفين إصدارًا أقدم من relayium اقترانه مباشر فقط، ولم يستطع أي منهما الوصول إلى الآخر. حدّث الطرفين: فالإصدار الحالي من relayium يمر عبر المُرحِّل المُشفَّر كلما أصدر الخادم مُرحِّلًا للرمز. وإلا فانقل أحد الطرفين إلى شبكة ذات عنوان يمكن الوصول إليه — خادم، أو نقطة اتصال من الهاتف — أو ارفع الملف بـ relayium up ومرِّر رابط التنزيل بدلًا من ذلك.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "من أين يأتي رمز الاقتران؟",
        a: "‏Relayium هو من يُصدره. شغِّل relayium send ./release.zip (بعد relayium login) فتطبع واجهة CLI رمزًا من 6 أرقام صالحًا لخمس دقائق، مع الأمر الذي سينفّذه الطرف الآخر بالضبط. لا يمكنك اختياره بنفسك — فالخادم لا يقبل إلا الرموز التي أصدرها هو.",
      },
      {
        q: "هل يُرفَع الملف إلى أي مكان؟",
        a: "لا يُخزَّن. يتدفق الملف بينكما، مُشفَّرًا من الطرف إلى الطرف. تعرّف مصافحة تعارف صغيرة على خادم Relayium الطرفين ببعضهما، وكلما أصدر الخادم مُرحِّل TURN للرمز مرّت بايتات الملف عبره نصًا مُشفَّرًا لا يستطيع قراءته — تُحتسب ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز، ولا يُحتفظ بها أبدًا.",
      },
      {
        q: "ماذا لو تعذَّر علينا الاتصال؟",
        a: "كلما أصدر الخادم مُرحِّلًا للرمز مرّت الجلسة عبره، فلا يوقفها NAT الصارم. وحين لا يُصدَر مُرحِّل — لم يُهيَّأ مُرحِّل، أو نفدت حصة الحساب الذي أنشأ الرمز — يحتاج الطرفان إلى مسار مباشر، ويفشل النقل من دونه. عندها استخدم رابطًا مخزّنًا من relayium up، أو relayium serve مع push / sync بين خادمين يمكن الوصول إليهما تديرهما.",
      },
      {
        q: "كيف أعرف أنه فعلًا الشخص الصحيح على الطرف الآخر؟",
        a: "تطبع كلتا الطرفيتين رمز SAS متطابقًا من 6 أرقام مُشتَقًا من بصمات شهادات TLS المثبّتة. قارنهما خارج القناة؛ يؤكد التطابق أن البصمات لم تُستبدل وأن خدمة الالتقاء لم تنتحل شخصية أي طرف. يصادق الرمز على الطرفين، لا على كل قفزة في مسار الشبكة. أضِف --verify لتشترط ذلك التأكيد قبل أن يتحرك أي بايت.",
      },
    ],
  },
  cta: {
    text: "أرسِل ملفك التالي إلى شخص على شبكة أخرى — مُشفَّرًا من الطرف إلى الطرف، دون رسوم لكل عملية نقل.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Enviar un archivo a alguien entre redes con la CLI de Relayium",
  description:
    "Usa relayium send y receive para mover un archivo entre dos personas en redes distintas, con un breve código de emparejamiento. Cifrado de extremo a extremo, con un código SAS opcional para comparar. Siempre que el servidor emite un retransmisor para el código, el archivo pasa por él cifrado y cuenta para la cuota mensual de tráfico de la cuenta que generó el código.",
  updatedLabel: "Última actualización",
  lead: [
    "A veces la otra máquina no es tuya y no puedes entrar por SSH: un archivo para un colega en otra oficina, una compilación para un cliente, un archivo comprimido para un amigo al otro lado del país. relayium send y receive lo mueven entre las dos partes, entre redes, usando solo un código de emparejamiento corto que tu CLI genera al enviar.",
    "La sesión está cifrada de extremo a extremo. Un breve encuentro en el servidor de Relayium presenta a los dos extremos; siempre que el servidor emite un retransmisor TURN para el código, los bytes del archivo pasan por él como texto cifrado que no puede leer y cuentan para la cuota mensual de tráfico de la cuenta que generó el código.",
  ],
  sections: [
    {
      heading: "Envía y luego pasa el código que imprime",
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "La CLI en la máquina que envía. relayium version imprime una versión; si el shell responde «command not found», todavía no está instalada. El otro extremo también puede usar la CLI, o escribir el código en una app de Relayium o en la página web.",
          "Un remitente con la sesión iniciada. relayium whoami imprime el correo de la cuenta, y generar un código de emparejamiento exige antes relayium login. La máquina receptora no inicia sesión en ningún momento.",
          "Las dos partes conectadas a la vez. El código vive cinco minutos, así que conviene acordar el momento antes de generarlo.",
          "Una forma de dictar seis dígitos fuera de banda: una llamada, una ventana de chat o la propia habitación cuando las dos personas están juntas.",
        ],
      },
      body: [
        "Inicia sesión una vez con relayium login y después solo envía. La CLI genera un código de emparejamiento, lo imprime junto con el comando exacto que ejecuta el otro extremo, y espera. Pasa ese código fuera de banda: dilo en una llamada, escríbelo en un chat:",
      ],
      steps: [
        {
          text: "En la máquina que envía, inicia sesión una sola vez. Sáltate este paso si relayium whoami ya imprime el correo de tu cuenta.",
          code: ["relayium login"],
        },
        {
          text: "Desde el directorio donde está el archivo, lanza el envío. La CLI genera el código, imprime el comando para el otro extremo y luego espera.",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "Dicta fuera de banda los seis dígitos que ha impreso. Dejan de funcionar cinco minutos después de generarse.",
        },
        {
          text: "En la máquina receptora, dentro del directorio donde deben llegar los archivos, ejecuta el comando que se le mostró al remitente. Añade un directorio para dejarlos en otro sitio.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Deja los dos terminales abiertos hasta que el shell receptor vuelva a su prompt. Es una única sesión en vivo: cerrar cualquiera de los extremos detiene la transferencia.",
        },
      ],
      success: {
        label: "Cómo se ve una ejecución correcta",
        body: [
          "El remitente imprime primero el bloque de traspaso y espera; después, un código de verificación y la ruta que consiguió. Las dos terminales muestran el mismo código de verificación y ambas terminan con 0.",
        ],
        code: [
          `# en la máquina que ENVÍA
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      bullets: [
        "El código tiene 6 dígitos decimales —cualquiera de 0 a 9, ceros iniciales incluidos— y caduca 5 minutos después de generarse.",
        "El código es solo un secreto compartido para encontrarse; no se envía a nadie más que al punto de encuentro, y solo sirve para presentar los dos extremos.",
        "El otro extremo no tiene que ser la CLI: relayium receive, relayium pair, una app de Relayium o la página web pueden unirse al código. ¿La otra persona no está conectada ahora? Usa relayium up para obtener un enlace de descarga.",
      ],
    },
    {
      heading: "Verificar con el código SAS",
      body: [
        "Cuando los dos extremos se conectan, ambas terminales muestran el mismo SAS (short authentication string) de 6 dígitos derivado de las huellas de sus certificados TLS fijados. Compáralo fuera de banda —léelo en voz alta durante la llamada— para confirmar que las huellas no fueron sustituidas y que el servicio de encuentro no suplantó a ninguno de los extremos. El SAS autentica los extremos; no demuestra cada salto de la ruta de red.",
        "Para obtener la protección más fuerte, añade --verify: la transferencia esperará a que confirmes que los códigos coinciden antes de que se mueva un solo byte.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Retransmisor o de igual a igual, y a qué cuenta",
      body: [
        "La línea path te dice por dónde fueron los bytes: relay, o direct / lan para de igual a igual. En ambos casos el archivo va cifrado de extremo a extremo y no hay cargo por transferencia: los bytes retransmitidos se contabilizan como uso en la cuota mensual de tráfico de la cuenta que generó el código.",
        cliDirectFacts.es,
        "Si una transferencia no logra conectar, las respuestas fiables son un enlace almacenado creado con relayium up, o relayium serve con push / sync entre dos servidores alcanzables que administres; esa ruta es directa y no se contabiliza.",
      ],
      bullets: [
        "Retransmisor emitido → cada byte pasa por el retransmisor cifrado y cuenta para la cuota mensual de tráfico de la cuenta que generó el código.",
        "Sin retransmisor → los dos extremos se conectan de igual a igual si existe una ruta directa; si no, la sesión falla.",
      ],
    },
    {
      heading: "Cuando no funciona",
      body: [
        "Cuatro fallos explican casi todos los intentos fallidos. Cada uno tiene una línea que leer o un comando que ejecutar que lo decide, así que nunca hay que adivinar qué extremo tiene el problema.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El remitente ni siquiera arranca: «minting a pairing code needs an account».",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Esa máquina no tiene credenciales guardadas. Ejecuta relayium login y apruébalo en el navegador; después whoami imprime el correo de la cuenta y el envío sale adelante. No se generó nada, así que no se ha gastado ningún código.",
          },
          {
            symptom: "El receptor teclea el código y el punto de encuentro lo rechaza.",
            code: [
              `# en la máquina que ENVÍA: el bloque de traspaso indica la vida exacta
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "El código caducó. Pulsa Ctrl-C en el remitente, ejecuta otra vez relayium send ./release.zip y dicta los seis dígitos nuevos dentro de los cinco minutos que anuncia el nuevo bloque de traspaso.",
          },
          {
            symptom: "Las dos terminales muestran códigos de verificación distintos.",
            code: ["relayium send --verify ./release.zip"],
            fix: "Para y no envíes el archivo. Que los códigos difieran significa que las huellas de los certificados TLS fijadas por los dos extremos no coinciden, es decir, que el otro lado no es la máquina que crees. Vuelve a lanzarlo con --verify, que detiene la transferencia justo en esa comparación hasta que confirmes, y comprueba con la otra persona en qué máquina está.",
          },
          {
            symptom: "«no direct connection to the peer (both ends behind strict NAT?)».",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Un extremo usa un relayium antiguo cuyo emparejamiento es solo directo, y ninguno pudo alcanzar al otro. Actualiza ambos extremos: un relayium actual pasa por el retransmisor cifrado siempre que el servidor emite uno para el código. Si no, mueve un extremo a una red con dirección alcanzable —un servidor, o el punto de acceso del móvil— o sube el archivo con relayium up y pasa el enlace de descarga en su lugar.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿De dónde sale el código de emparejamiento?",
        a: "Lo genera Relayium. Ejecuta relayium send ./release.zip (después de relayium login) y la CLI imprime un código de 6 dígitos válido durante cinco minutos, junto con el comando exacto que ejecuta el otro extremo. No puedes elegirlo tú: el servidor solo acepta los códigos que él mismo emitió.",
      },
      {
        q: "¿Se sube el archivo a algún sitio?",
        a: "No se guarda. El archivo fluye entre las dos partes, cifrado de extremo a extremo. Un pequeño handshake en el servidor de Relayium presenta a los extremos, y siempre que el servidor emite un retransmisor TURN para el código, los bytes del archivo pasan por él como texto cifrado que no puede leer: se contabilizan en la cuota mensual de tráfico de la cuenta que generó el código y nunca se conservan.",
      },
      {
        q: "¿Y si no podemos conectarnos?",
        a: "Siempre que el servidor emite un retransmisor para el código, la sesión pasa por él, así que un NAT estricto no la detiene. Cuando no se emite ninguno —no hay ninguno configurado o la cuota de la cuenta que generó el código está agotada—, los dos extremos necesitan una ruta directa, y sin ella la transferencia falla. Usa entonces un enlace almacenado de relayium up, o relayium serve con push / sync entre dos servidores alcanzables que administres.",
      },
      {
        q: "¿Cómo sé que de verdad es la persona correcta al otro lado?",
        a: "Ambas terminales muestran un código SAS idéntico de 6 dígitos derivado de las huellas de sus certificados TLS fijados. Compáralo fuera de banda; la coincidencia confirma que las huellas no fueron sustituidas y que el servicio de encuentro no suplantó a ninguno de los extremos. Autentica los extremos, no cada salto de la ruta de red. Añade --verify para exigir esa confirmación antes de que se muevan bytes.",
      },
    ],
  },
  cta: {
    text: "Envía tu próximo archivo a alguien en otra red: cifrado de extremo a extremo y sin cargo por transferencia.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Enviar um arquivo para alguém entre redes com a CLI do Relayium",
  description:
    "Use relayium send e receive para mover um arquivo entre duas pessoas em redes diferentes, com um código de pareamento curto. Com criptografia de ponta a ponta e um código SAS opcional para comparar. Sempre que o servidor emite um retransmissor para o código, o arquivo passa por ele cifrado e conta para a cota mensal de tráfego da conta que gerou o código.",
  updatedLabel: "Última atualização",
  lead: [
    "Às vezes a outra máquina não é sua e você não consegue entrar por SSH: um arquivo para um colega em outro escritório, um build para um cliente, um arquivo compactado para um amigo do outro lado do país. relayium send e receive o movem entre as duas partes, entre redes, usando apenas um código de pareamento curto que a sua CLI gera na hora de enviar.",
    "A sessão tem criptografia de ponta a ponta. Um breve encontro no servidor do Relayium apresenta as duas pontas; sempre que o servidor emite um retransmissor TURN para o código, os bytes do arquivo passam por ele como texto cifrado que ele não consegue ler e contam para a cota mensal de tráfego da conta que gerou o código.",
  ],
  sections: [
    {
      heading: "Envie e depois repasse o código que aparece",
      prereqs: {
        label: "O que você precisa",
        items: [
          "A CLI na máquina que envia. relayium version imprime uma versão; se o shell responder “command not found”, ela ainda não está instalada. A outra ponta também pode usar a CLI, ou digitar o código em um app do Relayium ou na página web.",
          "Quem envia com login feito. relayium whoami imprime o e-mail da conta, e gerar um código de emparelhamento exige antes relayium login. A máquina que recebe não faz login em momento algum.",
          "As duas pessoas online ao mesmo tempo. O código vive cinco minutos, então combine o momento antes de gerar um.",
          "Um jeito de ditar seis dígitos fora de banda: uma ligação, uma janela de chat ou a própria sala, quando as duas pessoas estão juntas.",
        ],
      },
      body: [
        "Faça login uma vez com relayium login e depois é só enviar. A CLI gera um código de emparelhamento, exibe-o junto com o comando exato que a outra ponta executa, e fica aguardando. Repasse esse código fora de banda: diga em uma chamada, coloque em um chat:",
      ],
      steps: [
        {
          text: "Na máquina que envia, faça login uma única vez. Pule este passo se relayium whoami já imprime o e-mail da sua conta.",
          code: ["relayium login"],
        },
        {
          text: "No diretório onde está o arquivo, inicie o envio. A CLI gera o código, imprime o comando para a outra ponta e então aguarda.",
          code: ["relayium send ./release.zip"],
        },
        {
          text: "Dite fora de banda os seis dígitos que apareceram. Eles param de funcionar cinco minutos depois de gerados.",
        },
        {
          text: "Na máquina que recebe, dentro do diretório onde os arquivos devem chegar, rode o comando que apareceu para quem enviou. Acrescente um diretório para colocá-los em outro lugar.",
          code: ["relayium receive 483920", "relayium receive 483920 ./downloads"],
        },
        {
          text: "Deixe os dois terminais abertos até o shell de quem recebe voltar ao prompt. É uma única sessão ao vivo: fechar qualquer uma das pontas interrompe a transferência.",
        },
      ],
      success: {
        label: "Como é uma execução bem-sucedida",
        body: [
          "Quem envia imprime primeiro o bloco de repasse e aguarda; depois, um código de verificação e o caminho que conseguiu. Os dois terminais mostram o mesmo código de verificação, e ambos terminam com 0.",
        ],
        code: [
          `# na máquina que ENVIA
Code: 483920   (valid 5 minutes)
On the other machine:  relayium receive 483920
  not installed there?  curl -fsSL https://relayium.com/install.sh | sh
waiting for the receiver…
verification code (SAS): 271044 — not the pairing code; compare it on both ends to rule out a substituted endpoint
path: direct`,
        ],
      },
      bullets: [
        "O código tem 6 dígitos decimais — qualquer um de 0 a 9, zeros à esquerda incluídos — e expira 5 minutos depois de gerado.",
        "O código é apenas um segredo compartilhado para se encontrar; não é enviado a ninguém além do ponto de encontro, e serve apenas para apresentar as duas pontas.",
        "A outra ponta não precisa ser a CLI: relayium receive, relayium pair, um app do Relayium ou a página web podem entrar no código. A pessoa não está online agora? Use relayium up para ter um link de download.",
      ],
    },
    {
      heading: "Verificar com o código SAS",
      body: [
        "Quando as duas pontas se conectam, os dois terminais exibem o mesmo SAS (short authentication string) de 6 dígitos derivado das impressões digitais dos certificados TLS fixados. Compare-o fora de banda — leia em voz alta durante a chamada — para confirmar que as impressões digitais não foram substituídas e que o serviço de encontro não se passou por nenhuma das pontas. O SAS autentica as pontas; não prova cada salto da rota de rede.",
        "Para a proteção mais forte, adicione --verify: a transferência então espera que você confirme que os códigos coincidem antes que um único byte se mova.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Retransmissor ou ponto a ponto — e para o que conta",
      body: [
        "A linha path mostra por onde os bytes foram: relay, ou direct / lan para ponto a ponto. Nos dois casos o arquivo tem criptografia de ponta a ponta e não há cobrança por transferência — os bytes retransmitidos são contabilizados como uso na cota mensal de tráfego da conta que gerou o código.",
        cliDirectFacts.pt,
        "Se uma transferência não conseguir conectar, as respostas confiáveis são um link armazenado criado com relayium up, ou relayium serve com push / sync entre dois servidores alcançáveis que você administra — esse caminho é direto e não é contabilizado.",
      ],
      bullets: [
        "Retransmissor emitido → cada byte passa pelo retransmissor criptografado e conta para a cota mensal de tráfego da conta que gerou o código.",
        "Nenhum retransmissor emitido → as duas pontas se conectam ponto a ponto se houver um caminho direto; senão, a sessão falha.",
      ],
    },
    {
      heading: "Quando não funciona",
      body: [
        "Quatro falhas explicam quase toda tentativa malsucedida. Cada uma tem uma linha para ler ou um comando para rodar que decide a questão, então nunca é preciso adivinhar qual ponta está com problema.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "Quem envia nem começa: “minting a pairing code needs an account”.",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Essa máquina não tem credenciais salvas. Rode relayium login e aprove no navegador; depois disso whoami imprime o e-mail da conta e o envio segue. Nada tinha sido gerado, então nenhum código foi desperdiçado.",
          },
          {
            symptom: "Quem recebe digita o código e o ponto de encontro recusa.",
            code: [
              `# na máquina que ENVIA: o bloco de repasse informa a vida exata
relayium send ./release.zip
Code: 483920   (valid 5 minutes)`,
            ],
            fix: "O código expirou. Aperte Ctrl-C em quem envia, rode relayium send ./release.zip de novo e dite os seis dígitos novos dentro dos cinco minutos que o novo bloco de repasse anuncia.",
          },
          {
            symptom: "Os dois terminais mostram códigos de verificação diferentes.",
            code: ["relayium send --verify ./release.zip"],
            fix: "Pare e não envie o arquivo. Códigos diferentes significam que as impressões digitais dos certificados TLS fixadas pelas duas pontas não batem, ou seja, o outro lado não é a máquina que você imagina. Rode de novo com --verify, que trava a transferência exatamente nessa comparação até você confirmar, e cheque com a outra pessoa em qual máquina ela está.",
          },
          {
            symptom: "“no direct connection to the peer (both ends behind strict NAT?)”.",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Uma das pontas usa um relayium antigo cujo pareamento é só direto, e nenhuma conseguiu alcançar a outra. Atualize as duas pontas: um relayium atual passa pelo retransmissor criptografado sempre que o servidor emite um para o código. Senão, leve uma das pontas para uma rede com endereço alcançável — um servidor, ou o roteamento do celular — ou suba o arquivo com relayium up e repasse o link de download.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "De onde vem o código de emparelhamento?",
        a: "Quem gera é o Relayium. Rode relayium send ./release.zip (depois de relayium login) e a CLI exibe um código de 6 dígitos válido por cinco minutos, junto com o comando exato que a outra ponta executa. Você não pode escolhê-lo — o servidor só aceita os códigos que ele mesmo emitiu.",
      },
      {
        q: "O arquivo é enviado para algum lugar?",
        a: "Ele não é guardado. O arquivo flui entre as duas partes, com criptografia de ponta a ponta. Um pequeno handshake no servidor do Relayium apresenta as pontas, e sempre que o servidor emite um retransmissor TURN para o código, os bytes do arquivo passam por ele como texto cifrado que ele não consegue ler — contabilizados na cota mensal de tráfego da conta que gerou o código, e nunca mantidos.",
      },
      {
        q: "E se não conseguirmos conectar?",
        a: "Sempre que o servidor emite um retransmissor para o código, a sessão passa por ele, então um NAT estrito não a impede. Quando nenhum é emitido — nenhum está configurado ou a cota da conta que gerou o código se esgotou —, as duas pontas precisam de um caminho direto, e sem ele a transferência falha. Use então um link armazenado do relayium up, ou relayium serve com push / sync entre dois servidores alcançáveis que você administra.",
      },
      {
        q: "Como sei que é mesmo a pessoa certa do outro lado?",
        a: "Os dois terminais exibem um código SAS idêntico de 6 dígitos derivado das impressões digitais dos certificados TLS fixados. Compare-o fora de banda; a coincidência confirma que as impressões digitais não foram substituídas e que o serviço de encontro não se passou por nenhuma das pontas. Ele autentica as pontas, não cada salto da rota de rede. Adicione --verify para exigir essa confirmação antes que qualquer byte se mova.",
      },
    ],
  },
  cta: {
    text: "Envie seu próximo arquivo para alguém em outra rede — com criptografia de ponta a ponta e sem cobrança por transferência.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/send-a-file-to-someone",
  published: "2026-07-08",
  updated: "2026-08-07",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
