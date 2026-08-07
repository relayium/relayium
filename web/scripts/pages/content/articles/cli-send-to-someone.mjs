// web/scripts/pages/content/articles/cli-send-to-someone.mjs
// How-to: send a file to another person across networks with relayium send/receive.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";
import { cliDirectFacts } from "../realtime-facts.mjs";

const en = {
  title: "Send a file to someone across networks with the Relayium CLI",
  description:
    "Use relayium send and receive to move a file directly between two people on different networks, using a short pairing code. End-to-end encrypted, with an optional SAS code to compare, and free — the file goes straight between you, never through our servers.",
  updatedLabel: "Last updated",
  lead: [
    "Sometimes the other machine isn't yours and you can't SSH into it — a file for a colleague in another office, a build for a client, an archive for a friend across the country. relayium send and receive move it directly between the two of you across networks, using nothing but a short pairing code that your CLI mints when you send.",
    "The connection is peer-to-peer and end-to-end encrypted. Only a tiny rendezvous handshake passes through Relayium to introduce the two ends; the file bytes never do.",
  ],
  sections: [
    {
      heading: "Send, then pass on the code it prints",
      prereqs: {
        label: "What you need",
        items: [
          "The CLI on both machines. relayium version prints a version string on each; a shell that answers 'command not found' means it isn't installed there yet.",
          "A signed-in sender. relayium whoami prints the account email; minting a pairing code needs relayium login first. The receiving machine never signs in.",
          "Both of you at a terminal at the same time. The code lives five minutes, so agree on the moment before you mint one.",
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
path: direct`,
        ],
      },
      bullets: [
        "The code is 6 decimal digits — any of 0-9, leading zeros included — and it expires 5 minutes after it is minted.",
        "The code is just a shared secret to meet on; it isn't sent to anyone but the rendezvous, and it introduces the two ends only.",
        "Both ends must be the CLI — a browser can't join a CLI pairing code. Sending to someone who only has a browser? Use relayium up instead, which gives you a download link.",
      ],
    },
    {
      heading: "Verify with the SAS code",
      body: [
        "When the two ends connect, both terminals print the same 6-digit SAS (short authentication string) derived from their pinned TLS certificate fingerprints. Compare it out of band — read it aloud on the call — to confirm the fingerprints were not substituted and the rendezvous service did not impersonate either endpoint. The SAS authenticates the endpoints; it does not prove every network hop.",
        "For the strongest protection, add --verify: the transfer then waits for you to confirm the codes match before a single byte moves.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Direct only — free, or it fails",
      body: [
        "The transfer races a direct connection between the two ends. When one can be established — which is the common case for at least one side with a reachable address — the file streams straight across, encrypted, at full speed and at no cost.",
        cliDirectFacts.en,
        "If you hit this, the reliable answer is daemon direct between two reachable servers, push over SSH, or a stored link from relayium up.",
      ],
      bullets: [
        "Direct connection succeeds → free, full-speed, end-to-end encrypted.",
        "Both ends can be anywhere geographically — the sender just runs send, and the receiver runs receive with the code it printed.",
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
            fix: "Stop and do not send the file. Differing codes mean the certificate fingerprints the two ends pinned disagree, so the far end is not the machine you think it is. Re-run with --verify, which holds the transfer at that comparison until you confirm, and check with the other person which machine they are on.",
          },
          {
            symptom: "\"no direct connection to the peer (both ends behind strict NAT?)\".",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "Neither end could reach the other and the CLI has no relay path for file bytes, by design. Move one end onto a network with a reachable address — a server, or a phone hotspot — or upload the file with relayium up and hand over the download link instead.",
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
        a: "No. The file streams directly between the two of you, end-to-end encrypted. Only a small rendezvous handshake passes through Relayium to introduce the ends — never the file.",
      },
      {
        q: "What if we can't connect?",
        a: "If both ends are behind strict NAT with no reachable address, the direct connection can't be made and the transfer fails — the CLI has no relay fallback, by design. Use daemon direct between two reachable servers, or push over SSH, when a direct path isn't available.",
      },
      {
        q: "How do I know it's really the right person on the other end?",
        a: "Both terminals print an identical 6-digit SAS code derived from their pinned TLS certificate fingerprints. Compare it out of band; a match confirms the fingerprints were not substituted and the rendezvous service did not impersonate either endpoint. It authenticates the endpoints, not every network hop. Add --verify to require that confirmation before any bytes move.",
      },
    ],
  },
  cta: {
    text: "Send your next file straight to someone on another network — end-to-end encrypted, and free.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 跨网络把文件发给对方",
  description:
    "使用 relayium send 和 receive，凭一个简短的配对码，把文件直接在两个不同网络上的人之间传输。端到端加密，用 SAS 码验证，而且免费——文件径直在你们之间传输，从不经过我们的服务器。",
  updatedLabel: "最近更新",
  lead: [
    "有时候对方的机器不是你的，你也没法用 SSH 登录进去——给另一个办公室的同事发个文件，给客户发个构建产物，给国外的朋友发个压缩包。relayium send 和 receive 会跨网络把文件直接送到你们两个之间，靠的只是发送时 CLI 为你生成的一个简短配对码。",
    "连接是点对点、端到端加密的。只有一次极小的会合握手会经过 Relayium 来介绍双方；文件字节从不经过。",
  ],
  sections: [
    {
      heading: "先 send，再把打印出来的码转告对方",
      prereqs: {
        label: "你需要准备",
        items: [
          "两台机器上都装好 CLI。在各自终端里 relayium version 会打印版本号；如果 shell 回的是 “command not found”，说明那台还没装。",
          "发送方已登录。relayium whoami 会打印账号邮箱；生成配对码之前必须先 relayium login。接收方那台机器全程不用登录。",
          "两个人同时守在终端前。码只有五分钟寿命，所以先约好时间再生成。",
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
path: direct`,
        ],
      },
      bullets: [
        "这个码是 6 位十进制数字——0-9 都可能出现，也可能以 0 开头——并且在生成 5 分钟后失效。",
        "这个码只是一个用来会合的共享密钥；除了会合服务器，它不会发给任何人，而且只用来介绍双方。",
        "两端都必须是 CLI——浏览器无法加入 CLI 的配对码。如果对方只有浏览器，请改用 relayium up，它会给你一个下载链接。",
      ],
    },
    {
      heading: "用 SAS 码验证",
      body: [
        "两端连接建立后，两边的终端会打印出同一个从固定 TLS 证书指纹派生的 6 位 SAS（简短认证串）。通过带外方式核对——例如在通话中念出来——可以确认指纹没有被替换、会合服务没有冒充任一端。SAS 认证的是端点，并不证明网络路径上的每一跳。",
        "为获得最强保护，加上 --verify：传输会等你确认两边的码一致后，才会移动哪怕一个字节。",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "只走直连——免费，否则失败",
      body: [
        "传输会在两端之间竞速建立直连。一旦能建立——这是常见情况，只要至少一方有可达地址——文件就会直接、加密地全速传输，不收费。",
        cliDirectFacts.zh,
        "如果遇到这种情况，可靠的办法是在两台可达的服务器之间用 daemon 直连、用 SSH push，或者通过 relayium up 创建存储链接。",
      ],
      bullets: [
        "直连成功 → 免费、全速、端到端加密。",
        "两端在地理上可以在任何地方——发送方直接运行 send，接收方用它打印出来的码运行 receive。",
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
            fix: "停下，别把文件发出去。校验码不一致意味着两端固定下来的证书指纹对不上，也就是说对面那台机器并不是你以为的那台。用 --verify 重跑一次，它会在这一步停住等你确认，同时跟对方核对他们到底在哪台机器上操作。",
          },
          {
            symptom: "“no direct connection to the peer (both ends behind strict NAT?)”。",
            code: [
              `relayium send ./release.zip
# no direct connection to the peer (both ends behind strict NAT?): …`,
            ],
            fix: "两端谁也够不着谁，而 CLI 刻意如此，没有给文件字节留任何中继通路。把其中一端换到有可达地址的网络上——一台服务器，或者手机热点——或者改用 relayium up 上传文件，把下载链接交给对方。",
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
        a: "不会。文件在你们两个之间直接流式传输，端到端加密。只有一次很小的会合握手会经过 Relayium 来介绍双方——文件本身从不经过。",
      },
      {
        q: "如果连接不上怎么办？",
        a: "如果两端都在严格 NAT 之后、没有可达地址，就无法建立直连，传输会失败——CLI 按设计没有中继兜底。当没有直连路径时，可以在两台可达的服务器之间用 daemon 直连，或者用 SSH push。",
      },
      {
        q: "我怎么知道对面真的是对的人？",
        a: "两边的终端会打印出一个从固定 TLS 证书指纹派生的相同 6 位 SAS 码。通过带外方式核对；一致就能确认指纹没有被替换、会合服务没有冒充任一端。它认证的是端点，而不是网络路径上的每一跳。加上 --verify 可以要求在任何字节移动之前先完成这个确认。",
      },
    ],
  },
  cta: {
    text: "把你的下一个文件直接发给另一个网络上的人——端到端加密，而且免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI でネットワークを越えて誰かにファイルを送る",
  description:
    "relayium send と receive を使い、短いペアリングコードだけで異なるネットワーク上の2人の間でファイルを直接移動します。エンドツーエンドで暗号化され、SAS コードで検証され、しかも無料。ファイルは二人の間を直接行き来し、当社のサーバーを経由することはありません。",
  updatedLabel: "最終更新",
  lead: [
    "相手のマシンが自分のものではなく SSH でログインできないこともあります。別のオフィスの同僚へのファイル、クライアント向けのビルド、遠方の友人へのアーカイブ。relayium send と receive は、送信時に CLI が発行する短いペアリングコードだけを使って、ネットワークを越えてそれを二人の間で直接移動させます。",
    "接続は P2P で、エンドツーエンドに暗号化されています。二つの端を引き合わせるためのごく小さなランデブーハンドシェイクだけが Relayium を経由し、ファイルのバイトは決して経由しません。",
  ],
  sections: [
    {
      heading: "まず send、そして表示されたコードを相手に伝える",
      prereqs: {
        label: "必要なもの",
        items: [
          "両方のマシンに CLI。それぞれの端末で relayium version がバージョン文字列を表示します。シェルが「command not found」と返すなら、そのマシンにはまだ入っていません。",
          "サインイン済みの送信側。relayium whoami がアカウントのメールアドレスを表示します。ペアリングコードの発行には先に relayium login が要ります。受信側のマシンは最後までサインインしません。",
          "二人が同時に端末の前にいること。コードの寿命は5分なので、発行する前にタイミングを合わせてください。",
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
        "両端とも CLI である必要があります。ブラウザは CLI のペアリングコードに参加できません。相手がブラウザしか持っていない場合は、代わりに relayium up を使ってください。ダウンロードリンクが得られます。",
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
      heading: "直接接続のみ：無料、さもなくば失敗",
      body: [
        "転送は二つの端の間で直接接続の確立を競います。確立できれば（少なくとも一方に到達可能なアドレスがある一般的なケースでは）、ファイルはそのまま暗号化された状態で全速力かつ無料で流れます。",
        cliDirectFacts.ja,
        "この状況に当たった場合、確実な方法は到達可能な2台のサーバー間でのデーモン直結、SSH 経由の push、または relayium up で作る保存リンクです。",
      ],
      bullets: [
        "直接接続が成功 → 無料、全速力、エンドツーエンドで暗号化。",
        "両端は地理的にどこにあっても構いません。送信側は send を実行するだけ、受信側はそれが表示したコードで receive を実行します。",
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
            fix: "どちらの端も相手に届かず、CLI にはファイルのバイトを通すリレー経路が設計上ありません。片方を到達可能なアドレスを持つネットワーク（サーバー、あるいはスマートフォンのテザリング）へ移すか、relayium up でアップロードしてダウンロードリンクを渡してください。",
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
        a: "いいえ。ファイルは二人の間で直接ストリーミングされ、エンドツーエンドで暗号化されます。二つの端を引き合わせるためのごく小さなランデブーハンドシェイクだけが Relayium を経由し、ファイルは決して経由しません。",
      },
      {
        q: "接続できない場合はどうなりますか？",
        a: "両端が厳格な NAT の内側にあり到達可能なアドレスがない場合、直接接続は確立できず転送は失敗します。CLI は設計上リレーへのフォールバックを持ちません。直接の経路が使えない場合は、到達可能な2台のサーバー間でのデーモン直結、または SSH 経由の push を使ってください。",
      },
      {
        q: "相手が本当に正しい人物だとどうやって分かりますか？",
        a: "両方のターミナルが固定された TLS 証明書フィンガープリントから導かれた同一の6桁の SAS コードを表示します。帯域外で照合すると、フィンガープリントが差し替えられておらず、ランデブーサービスがどちらのエンドポイントにもなりすましていないことを確認できます。これはエンドポイントを認証するもので、ネットワーク経路上のすべてのホップを証明するものではありません。バイトが動く前にその確認を必須にするには --verify を追加します。",
      },
    ],
  },
  cta: {
    text: "次のファイルを、別のネットワークにいる相手へ直接送りましょう。エンドツーエンドで暗号化され、しかも無料です。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 네트워크를 넘어 상대에게 파일 보내기",
  description:
    "relayium send와 receive를 사용해, 짧은 페어링 코드 하나로 서로 다른 네트워크에 있는 두 사람 사이에서 파일을 직접 옮기세요. 종단간 암호화되고 SAS 코드로 검증되며 무료입니다. 파일은 두 사람 사이를 곧장 오가며, 저희 서버를 절대 거치지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "때로는 상대의 컴퓨터가 내 것이 아니어서 SSH로 접속할 수 없을 때가 있습니다. 다른 사무실 동료에게 줄 파일, 고객에게 줄 빌드, 먼 곳의 친구에게 줄 아카이브. relayium send와 receive는 보낼 때 CLI가 발급하는 짧은 페어링 코드 하나만으로 네트워크를 넘어 그것을 두 사람 사이에 직접 옮깁니다.",
    "연결은 P2P이며 종단간 암호화됩니다. 두 끝을 서로 소개하기 위한 아주 작은 랑데부 핸드셰이크만 Relayium을 거치며, 파일 바이트는 결코 거치지 않습니다.",
  ],
  sections: [
    {
      heading: "먼저 send하고, 출력된 코드를 상대에게 전달하기",
      prereqs: {
        label: "필요한 것",
        items: [
          "두 기기 모두에 설치된 CLI. 각 터미널에서 relayium version 이 버전 문자열을 출력합니다. 셸이 “command not found”를 돌려주면 그 기기에는 아직 없는 것입니다.",
          "로그인된 보내는 쪽. relayium whoami 가 계정 이메일을 출력합니다. 페어링 코드를 발급하려면 먼저 relayium login 이 필요합니다. 받는 쪽 기기는 끝까지 로그인하지 않습니다.",
          "두 사람이 같은 시간에 터미널 앞에 있을 것. 코드의 수명은 5분이므로 발급하기 전에 시점을 맞추세요.",
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
        "양쪽 모두 CLI여야 합니다. 브라우저는 CLI 페어링 코드에 참여할 수 없습니다. 상대에게 브라우저밖에 없다면 대신 relayium up을 쓰세요. 다운로드 링크가 나옵니다.",
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
      heading: "직접 연결만 — 무료가 아니면 실패",
      body: [
        "전송은 두 끝 사이의 직접 연결 수립을 경쟁적으로 시도합니다. 연결이 이루어지면(적어도 한쪽에 도달 가능한 주소가 있는 일반적인 경우) 파일은 암호화된 채로 곧장 전속력으로, 비용 없이 흐릅니다.",
        cliDirectFacts.ko,
        "이런 상황이라면 확실한 방법은 도달 가능한 두 서버 사이의 데몬 다이렉트, SSH를 통한 push, 또는 relayium up으로 만드는 저장 링크입니다.",
      ],
      bullets: [
        "직접 연결 성공 → 무료, 전속력, 종단간 암호화.",
        "양쪽은 지리적으로 어디에나 있을 수 있습니다. 보내는 쪽은 send를 실행하기만 하고, 받는 쪽은 거기서 출력된 코드로 receive를 실행합니다.",
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
            fix: "양쪽 어느 쪽도 상대에 닿지 못했고, CLI에는 파일 바이트를 위한 릴레이 경로가 설계상 없습니다. 한쪽을 도달 가능한 주소가 있는 네트워크 — 서버나 휴대폰 핫스팟 — 로 옮기거나, relayium up 으로 올린 뒤 다운로드 링크를 건네세요.",
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
        a: "아니요. 파일은 두 사람 사이에서 직접 스트리밍되며 종단간 암호화됩니다. 두 끝을 서로 소개하기 위한 아주 작은 랑데부 핸드셰이크만 Relayium을 거치며, 파일은 절대 거치지 않습니다.",
      },
      {
        q: "연결이 안 되면 어떻게 되나요?",
        a: "양쪽 모두 엄격한 NAT 뒤에 있고 도달 가능한 주소가 없다면 직접 연결을 만들 수 없어 전송이 실패합니다. CLI는 설계상 릴레이 폴백이 없습니다. 직접 경로를 쓸 수 없을 때는 도달 가능한 두 서버 사이의 데몬 다이렉트나, SSH를 통한 push를 사용하세요.",
      },
      {
        q: "상대가 정말 맞는 사람인지 어떻게 알 수 있나요?",
        a: "양쪽 터미널이 고정된 TLS 인증서 지문에서 파생된 동일한 6자리 SAS 코드를 출력합니다. 대역 외로 비교하면 지문이 바뀌지 않았고 랑데부 서비스가 어느 끝점도 사칭하지 않았음을 확인할 수 있습니다. 이는 끝점을 인증하는 것이지 네트워크 경로의 모든 홉을 증명하는 것은 아닙니다. 바이트가 움직이기 전에 이 확인을 필수로 하려면 --verify를 추가하세요.",
      },
    ],
  },
  cta: {
    text: "다음 파일을 다른 네트워크에 있는 상대에게 직접 보내세요. 종단간 암호화되고 무료입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Mit der Relayium CLI eine Datei über Netzwerke hinweg an jemanden senden",
  description:
    "Nutze relayium send und receive, um eine Datei mithilfe eines kurzen Pairing-Codes direkt zwischen zwei Personen in unterschiedlichen Netzwerken zu bewegen. Ende-zu-Ende verschlüsselt, mit einem optionalen SAS-Code zum Vergleichen und kostenlos — die Datei geht direkt zwischen euch hin und her, nie über unsere Server.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Manchmal ist die andere Maschine nicht deine eigene und du kannst dich nicht per SSH einloggen — eine Datei für eine Kollegin in einem anderen Büro, ein Build für einen Kunden, ein Archiv für einen Freund am anderen Ende des Landes. relayium send und receive bewegen sie über Netzwerke hinweg direkt zwischen euch beiden, nur mit einem kurzen Pairing-Code, den deine CLI beim Senden erzeugt.",
    "Die Verbindung ist Peer-to-Peer und Ende-zu-Ende verschlüsselt. Nur ein winziger Rendezvous-Handshake läuft über Relayium, um die beiden Enden einander vorzustellen; die Dateibytes nie.",
  ],
  sections: [
    {
      heading: "Erst senden, dann den ausgegebenen Code weitergeben",
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Die CLI auf beiden Rechnern. relayium version gibt auf jedem eine Versionsnummer aus; antwortet die Shell mit „command not found“, ist sie dort noch nicht installiert.",
          "Einen angemeldeten Absender. relayium whoami gibt die Konto-E-Mail aus; das Erzeugen eines Pairing-Codes setzt relayium login voraus. Der empfangende Rechner meldet sich nie an.",
          "Euch beide gleichzeitig am Terminal. Der Code lebt fünf Minuten, stimmt den Moment also ab, bevor du einen erzeugst.",
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
        "Beide Enden müssen die CLI sein — ein Browser kann einem CLI-Pairing-Code nicht beitreten. Du sendest an jemanden, der nur einen Browser hat? Nimm stattdessen relayium up, das gibt dir einen Download-Link.",
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
      heading: "Nur direkt — kostenlos, sonst schlägt es fehl",
      body: [
        "Die Übertragung versucht, eine direkte Verbindung zwischen den beiden Enden herzustellen. Gelingt das — der übliche Fall, wenn wenigstens eine Seite eine erreichbare Adresse hat —, fließt die Datei verschlüsselt direkt hindurch, mit voller Geschwindigkeit und ohne Kosten.",
        cliDirectFacts.de,
        "Falls das passiert, ist die verlässliche Antwort daemon-direct zwischen zwei erreichbaren Servern, push über SSH oder ein gespeicherter Link aus relayium up.",
      ],
      bullets: [
        "Direkte Verbindung gelingt → kostenlos, volle Geschwindigkeit, Ende-zu-Ende verschlüsselt.",
        "Beide Enden können geografisch überall sein — der Absender führt einfach send aus, der Empfänger receive mit dem Code, den es ausgegeben hat.",
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
            fix: "Keine der beiden Seiten hat die andere erreicht, und die CLI hat von Grund auf keinen Relay-Weg für Dateibytes. Bring ein Ende in ein Netz mit erreichbarer Adresse — einen Server oder einen Handy-Hotspot — oder lade die Datei mit relayium up hoch und gib stattdessen den Download-Link weiter.",
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
        a: "Nein. Die Datei fließt direkt zwischen euch beiden, Ende-zu-Ende verschlüsselt. Nur ein kleiner Rendezvous-Handshake läuft über Relayium, um die Enden einander vorzustellen — die Datei nie.",
      },
      {
        q: "Was, wenn wir keine Verbindung herstellen können?",
        a: "Stehen beide Enden hinter strengem NAT ohne erreichbare Adresse, kann die direkte Verbindung nicht hergestellt werden und die Übertragung schlägt fehl — die CLI hat absichtlich kein Relay-Fallback. Nutzt daemon-direct zwischen zwei erreichbaren Servern oder push über SSH, wenn kein direkter Pfad verfügbar ist.",
      },
      {
        q: "Woher weiß ich, dass wirklich die richtige Person am anderen Ende ist?",
        a: "Beide Terminals geben einen identischen 6-stelligen SAS-Code aus den angehefteten TLS-Zertifikatsfingerabdrücken aus. Vergleicht ihn außerhalb des Kanals; eine Übereinstimmung bestätigt, dass die Fingerabdrücke nicht ausgetauscht wurden und der Rendezvous-Dienst keinen Endpunkt imitiert hat. Er authentifiziert die Endpunkte, nicht jeden Netzwerk-Hop. Fügt --verify hinzu, um diese Bestätigung zu verlangen, bevor Bytes bewegt werden.",
      },
    ],
  },
  cta: {
    text: "Schicke deine nächste Datei direkt an jemanden in einem anderen Netzwerk — Ende-zu-Ende verschlüsselt und kostenlos.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer un fichier à quelqu'un à travers les réseaux avec la CLI Relayium",
  description:
    "Utilisez relayium send et receive pour déplacer un fichier directement entre deux personnes sur des réseaux différents, à l'aide d'un court code d'appairage. Chiffré de bout en bout, avec un code SAS facultatif à comparer, et gratuit — le fichier va tout droit entre vous, jamais via nos serveurs.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Parfois l'autre machine n'est pas la vôtre et vous ne pouvez pas vous y connecter en SSH — un fichier pour un collègue dans un autre bureau, un build pour un client, une archive pour un ami à l'autre bout du pays. relayium send et receive le déplacent directement entre vous deux à travers les réseaux, en utilisant seulement un court code d'appairage que votre CLI génère au moment de l'envoi.",
    "La connexion est pair-à-pair et chiffrée de bout en bout. Seule une minuscule poignée de main de rendez-vous passe par Relayium pour présenter les deux extrémités ; les octets du fichier, eux, jamais.",
  ],
  sections: [
    {
      heading: "Faire send, puis transmettre le code affiché",
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "La CLI sur les deux machines. relayium version affiche un numéro de version sur chacune. Si le shell répond « command not found », elle n'y est pas encore installée.",
          "Un expéditeur connecté. relayium whoami affiche l'adresse e-mail du compte, et générer un code d'appairage exige d'abord relayium login. La machine réceptrice ne se connecte jamais.",
          "Vous deux devant un terminal au même moment. Le code vit cinq minutes, alors convenez de l'instant avant d'en générer un.",
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
        "Les deux extrémités doivent être la CLI — un navigateur ne peut pas rejoindre un code d'appairage CLI. Vous envoyez à quelqu'un qui n'a qu'un navigateur ? Utilisez plutôt relayium up, qui vous donne un lien de téléchargement.",
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
      heading: "Direct uniquement — gratuit, sinon ça échoue",
      body: [
        "Le transfert tente d'établir en priorité une connexion directe entre les deux extrémités. Quand elle peut être établie — le cas courant dès qu'au moins un côté a une adresse joignable —, le fichier passe tout droit, chiffré, à pleine vitesse et sans frais.",
        cliDirectFacts.fr,
        "Si cela vous arrive, la réponse fiable est le daemon-direct entre deux serveurs joignables, le push via SSH ou un lien stocké créé avec relayium up.",
      ],
      bullets: [
        "Connexion directe réussie → gratuit, pleine vitesse, chiffré de bout en bout.",
        "Les deux extrémités peuvent être n'importe où géographiquement — l'expéditeur lance simplement send, et le destinataire lance receive avec le code affiché.",
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
            fix: "Aucune des deux extrémités n'a pu atteindre l'autre, et la CLI n'a, par conception, aucune voie de relais pour les octets d'un fichier. Déplacez une extrémité vers un réseau doté d'une adresse joignable — un serveur, ou un partage de connexion mobile — ou téléversez le fichier avec relayium up et transmettez plutôt le lien de téléchargement.",
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
        a: "Non. Le fichier circule directement entre vous deux, chiffré de bout en bout. Seule une petite poignée de main de rendez-vous passe par Relayium pour présenter les extrémités — jamais le fichier.",
      },
      {
        q: "Que se passe-t-il si nous ne pouvons pas nous connecter ?",
        a: "Si les deux extrémités sont derrière un NAT strict sans adresse joignable, la connexion directe ne peut pas être établie et le transfert échoue — la CLI n'a volontairement aucun repli par relais. Utilisez le daemon-direct entre deux serveurs joignables, ou le push via SSH, quand aucun chemin direct n'est disponible.",
      },
      {
        q: "Comment savoir que c'est vraiment la bonne personne en face ?",
        a: "Les deux terminaux affichent un code SAS identique à 6 chiffres dérivé des empreintes des certificats TLS épinglés. Comparez-le hors bande ; une concordance confirme que les empreintes n'ont pas été substituées et que le service de rendez-vous n'a usurpé aucune extrémité. Il authentifie les extrémités, pas chaque saut réseau. Ajoutez --verify pour exiger cette confirmation avant qu'aucun octet ne bouge.",
      },
    ],
  },
  cta: {
    text: "Envoyez votre prochain fichier directement à quelqu'un sur un autre réseau — chiffré de bout en bout, et gratuit.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال ملف إلى شخص ما عبر الشبكات باستخدام واجهة Relayium الطرفية (CLI)",
  description:
    "استخدم relayium send وreceive لنقل ملف مباشرةً بين شخصين على شبكتين مختلفتين، بالاعتماد على رمز اقتران قصير. مُشفَّر من الطرف إلى الطرف، ويُتحقَّق منه برمز SAS، ومجاني — يذهب الملف مباشرةً بينكما، ولا يمر أبدًا عبر خوادمنا.",
  updatedLabel: "آخر تحديث",
  lead: [
    "أحيانًا لا يكون الجهاز الآخر جهازك ولا يمكنك الدخول إليه عبر SSH — ملف لزميل في مكتب آخر، أو نسخة بناء لعميل، أو أرشيف لصديق في الطرف الآخر من البلاد. يقوم relayium send وreceive بنقله مباشرةً بينكما عبر الشبكات، بالاعتماد فقط على رمز اقتران قصير تُصدره واجهة CLI لديك عند الإرسال.",
    "الاتصال من الند للند (P2P) ومُشفَّر من الطرف إلى الطرف. لا يمر عبر Relayium سوى مصافحة تعارف ضئيلة للغاية تُعرِّف الطرفين ببعضهما؛ أما بايتات الملف فلا تمر أبدًا.",
  ],
  sections: [
    {
      heading: "أرسِل أولًا، ثم مرِّر الرمز الذي يُطبَع لك",
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "واجهة CLI على الجهازين معًا. يطبع relayium version سطر إصدار على كلٍّ منهما، وإذا ردَّت الصَدفة بـ «command not found» فهي لم تُثبَّت هناك بعد.",
          "مُرسِل مُسجَّل الدخول. يطبع relayium whoami بريد الحساب، وإصدار رمز اقتران يستلزم relayium login أولًا. أما جهاز الاستقبال فلا يسجّل الدخول إطلاقًا.",
          "وجودكما معًا أمام الطرفية في الوقت نفسه. عمر الرمز خمس دقائق، فاتفقا على اللحظة قبل إصداره.",
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
        "يجب أن يكون الطرفان كلاهما على واجهة CLI — فالمتصفح لا يستطيع الانضمام إلى رمز اقتران خاص بـ CLI. هل تُرسِل إلى شخص لا يملك سوى متصفح؟ استخدم relayium up بدلًا من ذلك، فهو يعطيك رابط تنزيل.",
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
      heading: "مباشر فقط — مجاني، أو يفشل",
      body: [
        "يتسابق النقل على إنشاء اتصال مباشر بين الطرفين. حين يمكن إنشاؤه — وهي الحالة الشائعة ما دام لأحد الطرفين على الأقل عنوان يمكن الوصول إليه — يتدفق الملف مباشرةً، مُشفَّرًا، بأقصى سرعة وبلا تكلفة.",
        cliDirectFacts.ar,
        "إن واجهت هذا، فالحل الموثوق هو daemon direct بين خادمين يمكن الوصول إليهما، أو push عبر SSH، أو رابط مخزّن تنشئه بأمر relayium up.",
      ],
      bullets: [
        "نجاح الاتصال المباشر ← مجاني، بأقصى سرعة، مُشفَّر من الطرف إلى الطرف.",
        "يمكن أن يكون الطرفان في أي مكان جغرافيًا — يكفي أن يشغّل المُرسِل send، وأن يشغّل المُستقبِل receive بالرمز الذي طُبع.",
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
            fix: "لم يستطع أي من الطرفين الوصول إلى الآخر، ولا تملك واجهة CLI أي مسار عبر مُرحِّل لبايتات الملفات، وهذا بحكم التصميم. انقل أحد الطرفين إلى شبكة ذات عنوان يمكن الوصول إليه — خادم، أو نقطة اتصال من الهاتف — أو ارفع الملف بـ relayium up ومرِّر رابط التنزيل بدلًا من ذلك.",
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
        a: "لا. يتدفق الملف مباشرةً بينكما، مُشفَّرًا من الطرف إلى الطرف. لا يمر عبر Relayium سوى مصافحة تعارف صغيرة لتعريف الطرفين — أما الملف فلا يمر أبدًا.",
      },
      {
        q: "ماذا لو تعذَّر علينا الاتصال؟",
        a: "إذا كان الطرفان خلف NAT صارم بلا عنوان يمكن الوصول إليه، فلا يمكن إنشاء الاتصال المباشر ويفشل النقل — فواجهة CLI لا تملك احتياطيًا عبر مُرحِّل، وهذا بحكم التصميم. استخدم daemon direct بين خادمين يمكن الوصول إليهما، أو push عبر SSH، حين لا يتوفر مسار مباشر.",
      },
      {
        q: "كيف أعرف أنه فعلًا الشخص الصحيح على الطرف الآخر؟",
        a: "تطبع كلتا الطرفيتين رمز SAS متطابقًا من 6 أرقام مُشتَقًا من بصمات شهادات TLS المثبّتة. قارنهما خارج القناة؛ يؤكد التطابق أن البصمات لم تُستبدل وأن خدمة الالتقاء لم تنتحل شخصية أي طرف. يصادق الرمز على الطرفين، لا على كل قفزة في مسار الشبكة. أضِف --verify لتشترط ذلك التأكيد قبل أن يتحرك أي بايت.",
      },
    ],
  },
  cta: {
    text: "أرسِل ملفك التالي مباشرةً إلى شخص على شبكة أخرى — مُشفَّرًا من الطرف إلى الطرف، ومجانًا.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Enviar un archivo a alguien entre redes con la CLI de Relayium",
  description:
    "Usa relayium send y receive para mover un archivo directamente entre dos personas en redes distintas, con un breve código de emparejamiento. Cifrado de extremo a extremo, con un código SAS opcional para comparar y gratis: el archivo va directo entre los dos extremos, nunca a través de nuestros servidores.",
  updatedLabel: "Última actualización",
  lead: [
    "A veces la otra máquina no es tuya y no puedes entrar por SSH: un archivo para un colega en otra oficina, una compilación para un cliente, un archivo comprimido para un amigo al otro lado del país. relayium send y receive lo mueven directamente entre las dos partes, entre redes, usando solo un código de emparejamiento corto que tu CLI genera al enviar.",
    "La conexión es de igual a igual y cifrada de extremo a extremo. Solo un pequeñísimo handshake con el punto de encuentro pasa por Relayium para presentar los dos extremos; los bytes del archivo nunca lo hacen.",
  ],
  sections: [
    {
      heading: "Envía y luego pasa el código que imprime",
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "La CLI en las dos máquinas. relayium version imprime una versión en cada una; si el shell responde «command not found», ahí todavía no está instalada.",
          "Un remitente con la sesión iniciada. relayium whoami imprime el correo de la cuenta, y generar un código de emparejamiento exige antes relayium login. La máquina receptora no inicia sesión en ningún momento.",
          "Las dos partes ante un terminal a la vez. El código vive cinco minutos, así que conviene acordar el momento antes de generarlo.",
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
        "Ambos extremos tienen que ser la CLI: un navegador no puede unirse a un código de emparejamiento de la CLI. ¿Envías a alguien que solo tiene navegador? Usa relayium up, que te da un enlace de descarga.",
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
      heading: "Solo directo: gratis, o falla",
      body: [
        "La transferencia compite por establecer una conexión directa entre los dos extremos. Cuando se puede establecer —lo habitual cuando al menos un lado tiene una dirección alcanzable— el archivo fluye directo, cifrado, a máxima velocidad y sin coste.",
        cliDirectFacts.es,
        "Si te ocurre esto, la respuesta fiable es daemon directo entre dos servidores alcanzables, push por SSH o un enlace almacenado creado con relayium up.",
      ],
      bullets: [
        "La conexión directa tiene éxito → gratis, a máxima velocidad, cifrada de extremo a extremo.",
        "Ambos extremos pueden estar en cualquier lugar geográficamente; quien envía solo ejecuta send, y quien recibe ejecuta receive con el código que se imprimió.",
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
            fix: "Ningún extremo pudo alcanzar al otro, y la CLI no tiene, por diseño, ninguna vía de retransmisor para los bytes de un archivo. Mueve un extremo a una red con dirección alcanzable —un servidor, o el punto de acceso del móvil— o sube el archivo con relayium up y pasa el enlace de descarga en su lugar.",
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
        a: "No. El archivo fluye directamente entre las dos partes, cifrado de extremo a extremo. Solo un pequeño handshake con el punto de encuentro pasa por Relayium para presentar los extremos; el archivo nunca.",
      },
      {
        q: "¿Y si no podemos conectarnos?",
        a: "Si ambos extremos están detrás de un NAT estricto sin dirección alcanzable, no se puede establecer la conexión directa y la transferencia falla: la CLI no tiene respaldo por retransmisor, por diseño. Usa daemon directo entre dos servidores alcanzables, o push por SSH, cuando no haya una ruta directa disponible.",
      },
      {
        q: "¿Cómo sé que de verdad es la persona correcta al otro lado?",
        a: "Ambas terminales muestran un código SAS idéntico de 6 dígitos derivado de las huellas de sus certificados TLS fijados. Compáralo fuera de banda; la coincidencia confirma que las huellas no fueron sustituidas y que el servicio de encuentro no suplantó a ninguno de los extremos. Autentica los extremos, no cada salto de la ruta de red. Añade --verify para exigir esa confirmación antes de que se muevan bytes.",
      },
    ],
  },
  cta: {
    text: "Envía tu próximo archivo directamente a alguien en otra red: cifrado de extremo a extremo y gratis.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Enviar um arquivo para alguém entre redes com a CLI do Relayium",
  description:
    "Use relayium send e receive para mover um arquivo diretamente entre duas pessoas em redes diferentes, com um código de emparelhamento curto. Com criptografia de ponta a ponta, com um código SAS opcional para comparar e gratuito: o arquivo vai direto entre as duas pontas, nunca através dos nossos servidores.",
  updatedLabel: "Última atualização",
  lead: [
    "Às vezes a outra máquina não é sua e você não consegue entrar por SSH: um arquivo para um colega em outro escritório, um build para um cliente, um arquivo compactado para um amigo do outro lado do país. relayium send e receive o movem diretamente entre as duas partes, entre redes, usando apenas um código de emparelhamento curto que a sua CLI gera na hora de enviar.",
    "A conexão é ponto a ponto e com criptografia de ponta a ponta. Apenas um pequeníssimo handshake de encontro passa pelo Relayium para apresentar as duas pontas; os bytes do arquivo nunca passam.",
  ],
  sections: [
    {
      heading: "Envie e depois repasse o código que aparece",
      prereqs: {
        label: "O que você precisa",
        items: [
          "A CLI nas duas máquinas. relayium version imprime uma versão em cada uma; se o shell responder “command not found”, ela ainda não está instalada ali.",
          "Quem envia com login feito. relayium whoami imprime o e-mail da conta, e gerar um código de emparelhamento exige antes relayium login. A máquina que recebe não faz login em momento algum.",
          "As duas pessoas diante de um terminal ao mesmo tempo. O código vive cinco minutos, então combine o momento antes de gerar um.",
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
        "As duas pontas precisam ser a CLI — um navegador não consegue entrar em um código de emparelhamento da CLI. Vai enviar para alguém que só tem navegador? Use relayium up, que devolve um link de download.",
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
      heading: "Somente direto: gratuito, ou falha",
      body: [
        "A transferência disputa o estabelecimento de uma conexão direta entre as duas pontas. Quando ela pode ser estabelecida — o caso comum quando pelo menos um lado tem um endereço alcançável — o arquivo flui direto, criptografado, na velocidade máxima e sem custo.",
        cliDirectFacts.pt,
        "Se isso acontecer, a resposta confiável é daemon direto entre dois servidores alcançáveis, push por SSH ou um link armazenado criado com relayium up.",
      ],
      bullets: [
        "A conexão direta é bem-sucedida → gratuita, na velocidade máxima, com criptografia de ponta a ponta.",
        "Ambas as pontas podem estar em qualquer lugar geograficamente — quem envia só roda send, e quem recebe roda receive com o código que apareceu.",
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
            fix: "Nenhuma das pontas conseguiu alcançar a outra, e a CLI não tem, por decisão de projeto, nenhum caminho por retransmissor para os bytes de um arquivo. Leve uma das pontas para uma rede com endereço alcançável — um servidor, ou o roteamento do celular — ou suba o arquivo com relayium up e repasse o link de download.",
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
        a: "Não. O arquivo flui diretamente entre as duas partes, com criptografia de ponta a ponta. Apenas um pequeno handshake de encontro passa pelo Relayium para apresentar as pontas — nunca o arquivo.",
      },
      {
        q: "E se não conseguirmos conectar?",
        a: "Se ambas as pontas estiverem atrás de um NAT estrito sem endereço alcançável, a conexão direta não pode ser feita e a transferência falha — a CLI não tem retorno por retransmissor, por decisão de projeto. Use daemon direto entre dois servidores alcançáveis, ou push por SSH, quando não houver um caminho direto disponível.",
      },
      {
        q: "Como sei que é mesmo a pessoa certa do outro lado?",
        a: "Os dois terminais exibem um código SAS idêntico de 6 dígitos derivado das impressões digitais dos certificados TLS fixados. Compare-o fora de banda; a coincidência confirma que as impressões digitais não foram substituídas e que o serviço de encontro não se passou por nenhuma das pontas. Ele autentica as pontas, não cada salto da rota de rede. Adicione --verify para exigir essa confirmação antes que qualquer byte se mova.",
      },
    ],
  },
  cta: {
    text: "Envie seu próximo arquivo diretamente para alguém em outra rede — com criptografia de ponta a ponta e gratuito.",
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
