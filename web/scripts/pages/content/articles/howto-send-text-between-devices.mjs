// How-to: move clipboard-shaped text between devices without turning Relayium
// into stored chat. Browser and CLI pairing are separate, non-interoperable
// transports; the shared product contract is online-only, session-scoped text.

const commands = `# One machine mints the code and waits (relayium login is required once)
relayium text
# Code: 483920   (valid 5 minutes)
# On the other machine:  relayium text 483920

# The other machine joins that code
relayium text 483920

# Send one multiline message exactly as copied (macOS)
pbpaste | relayium text 483920

# Or pipe a file on any shell
cat snippet.txt | relayium text 483920

# Optional: stop to compare the verification code (SAS) first
relayium text 483920 --verify`;

function article(c) {
  return {
    title: c.title,
    description: c.description,
    updatedLabel: c.updatedLabel,
    lead: c.lead,
    sections: [
      {
        heading: c.browserHeading,
        prereqs: { label: c.prereqLabel, items: c.prereqs },
        body: [c.browserBody],
        steps: c.browserSteps,
        success: { label: c.successLabel, body: c.successBody, code: c.successCode },
      },
      {
        heading: c.fixHeading,
        body: [c.fixBody],
        troubleshooting: { label: c.fixLabel, items: c.fixes },
      },
      {
        heading: c.cliHeading,
        body: c.cliBody,
        code: [commands],
        bullets: c.cliNotes,
      },
      {
        heading: c.boundariesHeading,
        body: [c.boundariesBody],
        bullets: c.boundaries,
      },
    ],
    faq: {
      heading: c.faqHeading,
      items: c.faq,
    },
    cta: { text: c.ctaText, button: c.ctaButton, href: "/" },
    relatedHeading: c.relatedHeading,
  };
}

const en = article({
  title: "Send text, links and commands between devices",
  description:
    "Move text, links, commands and multiline code between devices with Relayium — end-to-end encrypted and online-only, with no message bodies or server-side history kept by Relayium; either endpoint can retain received text.",
  updatedLabel: "Last updated",
  lead: [
    "Relayium can move clipboard-shaped content as well as files: a URL from your phone, a command for another computer, or a multiline code block. Messages are end-to-end encrypted; Relayium servers keep no message bodies or server-side history, but either endpoint can copy or retain received text.",
    "The browser and command-line client each support text, but they are separate transports and cannot join each other's pairing codes. Choose one flow below and use it on both ends.",
  ],
  browserHeading: "Browser: send a message to an online device",
  browserBody:
    "Open relayium.com on both devices. Only the way they meet differs: on one network the other device appears by itself under “Nearby devices”, while across networks you create a browser pairing code on the cross-network page and join it from the other browser. What the two get once they have met is the same — the peer card offers a single action, “Open workspace”, and the composer lives inside that workspace, beside the file and folder attachments, on the one encrypted connection. Across networks that connection is carried by an encrypted TURN relay which forwards only ciphertext, and it runs under a time limit the workspace warns about before it is reached. The one exception is a peer that is not an up-to-date browser — an older one, a native app, the CLI: it keeps the earlier flow, where files and messages are used one at a time.",
  prereqLabel: "Before you start",
  prereqs: [
    "Both devices online at the same time, with the page open in a browser. There is no inbox: a message exists only inside a session both sides are holding open.",
    "One transport chosen for both ends. Same network needs nothing at all; different networks need a browser pairing code, which the creating side signs in for and which lives five minutes.",
    "Text that fits one message: 65,536 UTF-8 bytes. The composer counts up as you type and tells you to send it as a file instead once you go past that.",
    "Somewhere to put what arrives. The received message stays in the open session, so copy anything you want to keep before the session ends or the page reloads.",
  ],
  browserSteps: [
    {
      text: "Open the transfer page on both devices — the same-network page finds them for you, and the realtime page is where a pairing code goes if they are on different networks.",
      code: ["https://relayium.com/"],
    },
    {
      text: "Press “Open workspace” on the other device's card and type into the composer that workspace puts on screen. It is the same one action either way: under “Nearby devices” on the same network, and on the peer card inside a pairing-code room across networks. By default the session opens straight into the composer on both ends — the connection is encrypted either way.",
    },
    {
      text: "Type or paste the text. The counter under the box shows how much of the one-message budget you have used, in bytes rather than characters, because an emoji or a CJK character costs several.",
      code: ["1,024 / 65,536 bytes"],
    },
    {
      text: "Send with ⌘/Ctrl+Enter — plain Enter inserts a newline, which is what makes a multiline snippet paste-and-send in one go. The hint under the box states that mapping.",
      code: ["Enter for a new line · ⌘/Ctrl+Enter to send"],
    },
    {
      text: "Keep the session open to send several messages in either direction, and press “Copy” on anything you want to keep. To compare a verification code (SAS) first, turn on “Advanced verification” before opening the session: it adds the code and an explicit accept step, not the encryption.",
    },
  ],
  successLabel: "What a working session looks like",
  successBody: [
    "Both sides show the session as open, your message appears in the transcript on the other device, and the byte counter resets for the next one.",
    "That transcript is the only copy Relayium is involved in: it lives in the two open pages, so it is gone on reload or when the session ends, and “Copy” puts the text on that device's clipboard where other apps can read it.",
  ],
  successCode: ["Session open\n1,024 / 65,536 bytes"],
  fixHeading: "When a message won't go through",
  fixBody:
    "Text uses the same connection as a file transfer, so most failures are the connection rather than the message. The two exceptions are specific and both say so on screen: a message over the size limit, and a session that was closed for sending too many at once.",
  fixLabel: "Symptom, check, fix",
  fixes: [
    {
      symptom: "The other device never appears, so there is no card to open a message session from.",
      code: ["https://relayium.com/   # compare the public IP in the status pill on both devices"],
      fix: "Same-network discovery groups devices by the public IP they connect from, so two different addresses mean two rooms — drop a VPN or iCloud Private Relay, or join the same Wi-Fi. If they are genuinely on different networks, use a pairing code on https://relayium.com/cross-network instead.",
    },
    {
      symptom: "The composer refuses the text and says the message is too long.",
      code: ["1,024 / 65,536 bytes   # the counter is bytes of UTF-8, not characters"],
      fix: "One message holds 65,536 UTF-8 bytes, and non-Latin text spends two to four bytes per character, so a long Chinese or emoji-heavy paste hits that byte limit long before the character count would suggest. Split it, or send it as a file — the composer offers exactly that.",
    },
    {
      symptom: "The session closed itself and blamed too many messages.",
      code: ["https://relayium.com/   # the session line reports it ended rather than failed"],
      fix: "A flood guard closes a session when one side sends far more messages than a person types, which a script or a stuck key can do. Reopen the session the way you opened it — “Open workspace” on the other device's card, on the same network or in a pairing-code room — and send the remaining text in fewer, larger messages.",
    },
    {
      symptom: "Everything worked, and after a reload the conversation is empty.",
      code: ["https://relayium.com/   # reloading this page starts a new session with no transcript"],
      fix: "That is the design rather than a bug: Relayium keeps no server-side history, so there is nothing to restore and no server copy to subpoena either. Copy what matters into a note before you leave the session — the transcript is only as durable as the open page.",
    },
    {
      symptom: "A browser and the CLI cannot join each other's code.",
      code: ["relayium text 483920   # a CLI code only ever pairs CLI to CLI"],
      fix: "Browser and CLI text sessions use different transports and pairing handshakes, so a six-digit code minted by one is meaningless to the other. Use two browsers, or the CLI on both ends — relayium text prints the exact command the second machine should run.",
    },
  ],
  cliHeading: "CLI: mint a code on one machine, join it on the other",
  cliBody: [
    "Run relayium text with no code on one machine. It mints a six-digit code with your account, prints the exact command the other machine should run, and stays in the session waiting for it. There is no temporary file to send and no extra process to stop.",
    "Run relayium text with that code on the other machine. Interactive mode sends one line per message and does not stop to compare a code unless you ask it to. For multiline or byte-exact stdin, pipe it as one message; a piped run needs no extra flag.",
  ],
  cliNotes: [
    "CLI codes last five minutes and are CLI-to-CLI only; browser codes cannot connect a browser to the CLI.",
    "Only the machine that mints needs a signed-in account. The machine joining the printed code does not sign in.",
    "--verify opts in to comparing the SAS and needs a terminal to answer it, so a piped run with --verify refuses instead of continuing as if it had been confirmed. --yes is still accepted, still means “never prompt”, and overrides --verify.",
  ],
  boundariesHeading: "What text transfer is — and is not",
  boundariesBody:
    "Relayium treats the body as UTF-8 plain text. It preserves spaces, tabs, blank lines and line breaks, and does not execute, render Markdown, linkify or preview the content.",
  boundaries: [
    "Both devices must be online together. There is no offline delivery, inbox, contact list or synchronized chat history.",
    "History is local to the open session and disappears when it ends or the page reloads; the server never stores message bodies.",
    "One message is at most 65,536 UTF-8 bytes. For anything larger, send it as a file instead.",
  ],
  faqHeading: "Frequently asked questions",
  faq: [
    {
      q: "Can Relayium read or recover my messages?",
      a: "No. Message content is end-to-end encrypted between the two devices, and Relayium servers keep no message bodies or server-side history. Either endpoint can copy or retain received text; after the live session ends, Relayium has no server copy to recover.",
    },
    {
      q: "Can I use a browser on one end and the CLI on the other?",
      a: "No. Browser and CLI text sessions use different transports and pairing handshakes. Use two browsers or two CLI clients.",
    },
  ],
  ctaText: "Open Relayium on two online devices and move the next thing you would otherwise send to yourself.",
  ctaButton: "Send text now",
  relatedHeading: "Keep reading",
});

const zh = article({
  title: "在设备之间发送文本、链接和命令",
  description:
    "用 Relayium 在设备之间传递文本、链接、命令和多行代码——端到端加密、仅限双方在线；Relayium 服务器不保存消息正文或服务端历史，但任一端都可留存收到的文本。",
  updatedLabel: "最近更新",
  lead: [
    "Relayium 不只能传文件，也能传适合剪贴板的内容：手机上的网址、要在另一台电脑执行的命令，或一整段多行代码。消息端到端加密；Relayium 服务器不保存消息正文或服务端历史，但任一端都能复制或留存收到的文本。",
    "浏览器和命令行都支持文本，但它们是两套独立传输，不能加入彼此的配对码。下面任选一种方式，两端保持一致。",
  ],
  browserHeading: "浏览器：给在线设备发送消息",
  browserBody:
    "在两台设备上打开 relayium.com。两条路径只有「怎么遇上」不同：同一网络下，对方会自己出现在「附近的设备」里；跨网络则在跨网络页面创建浏览器配对码，再让另一台浏览器加入。遇上之后两边得到的东西是一样的——对端卡片只提供一个动作「打开工作区」，输入框就在那个工作区里，和文件、文件夹附件并排，共用同一条加密连接。跨网络时这条连接由加密的 TURN 中继承载，中继只转发密文；它还有一个时限，工作区会在到点之前提醒你。唯一的例外是不够新的对端——旧版浏览器、原生应用、CLI：它们保留更早的那套流程，文件和消息只能一次用一样。",
  prereqLabel: "开始之前",
  prereqs: [
    "两台设备同时在线，并且都在浏览器里打开着页面。这里没有收件箱：消息只存在于双方都保持打开的那个会话里。",
    "两端选定同一种传输方式。同一网络下什么都不用准备；不同网络需要一个浏览器配对码，由创建方登录生成，有效期 5 分钟。",
    "内容要装进一条消息：65,536 个 UTF-8 字节。输入时计数会往上走，超出后会提示你改用文件发送。",
    "准备好安放收到的内容。收到的消息留在打开的会话里，所以想保留什么，请在会话结束或页面刷新之前先复制走。",
  ],
  browserSteps: [
    {
      text: "在两台设备上打开传输页面——同一网络的页面会自动帮你找到对方，而配对码要用在实时传输页面上（两端不在同一网络时）。",
      code: ["https://relayium.com/"],
    },
    {
      text: "在对方设备的卡片上按「打开工作区」，然后在工作区给出的输入框里打字。两条路径是同一个动作：同一网络在「附近的设备」里，跨网络在配对码房间的对端卡片上。默认情况下会话会直接在两端打开输入框——无论是否核对校验码，连接都是加密的。",
    },
    {
      text: "输入或粘贴文本。输入框下方的计数显示你已经用掉了单条消息预算的多少，单位是字节而不是字符，因为一个 emoji 或一个汉字要占好几个字节。",
      code: ["1,024 / 65,536 字节"],
    },
    {
      text: "用 ⌘/Ctrl+回车发送——单按回车是换行，正是这一点让多行片段可以一次粘贴、一次发出。输入框下方的提示就写着这套按键。",
      code: ["回车换行 · ⌘/Ctrl+回车发送"],
    },
    {
      text: "会话保持打开时，双方都能连续发送多条消息，想留下的内容就点「复制」。如果希望先核对校验码（SAS），请在打开会话之前先打开「高级验证」：它增加的是校验码和一步明确接受，而不是加密。",
    },
  ],
  successLabel: "会话正常时是什么样",
  successBody: [
    "两端都显示会话已建立，你的消息出现在对方设备的记录里，字节计数也为下一条清零。",
    "这份记录是 Relayium 唯一参与的副本：它只存在于两个打开的页面里，刷新或结束会话就没了；而「复制」会把文本放进那台设备的剪贴板，其他 App 也能读到。",
  ],
  successCode: ["会话已建立\n1,024 / 65,536 字节"],
  fixHeading: "消息发不出去时",
  fixBody:
    "文本和文件传输走同一条连接，所以大多数失败其实是连接的问题，而不是消息的问题。只有两种例外很具体，而且都会在屏幕上说明：一条超过大小上限的消息，以及因为一次发得太多而被关闭的会话。",
  fixLabel: "现象、检查、处理",
  fixes: [
    {
      symptom: "对方设备一直不出现，也就没有卡片可以开消息会话。",
      code: ["https://relayium.com/   # 对比两台设备上状态条里的公网 IP"],
      fix: "同网络发现是按连接过来的公网 IP 分组的，所以两个不同地址就是两个房间——断开 VPN 或 iCloud 专用代理，或者连到同一个 Wi-Fi。如果两端确实不在同一网络，就改用 https://relayium.com/cross-network 上的配对码。",
    },
    {
      symptom: "输入框拒收这段文本，提示消息太长。",
      code: ["1,024 / 65,536 字节   # 计数是 UTF-8 字节，不是字符"],
      fix: "一条消息装 65,536 个 UTF-8 字节，而非拉丁文字每个字符要花 2 到 4 个字节，所以一段很长的中文或大量 emoji 会远在字符数看起来还很宽裕的时候就撞上这个字节上限。请拆开发送，或者作为文件发送——输入框本来就给了这个提示。",
    },
    {
      symptom: "会话自己关掉了，并归因于消息发得太多。",
      code: ["https://relayium.com/   # 会话那行会显示它是结束，而不是失败"],
      fix: "当一侧发送的消息数量远超人手打字的量时，防洪机制会关闭会话——脚本或卡住的按键都会造成这种情况。用你当初打开它的方式重新打开会话——在对方卡片上按「打开工作区」，同一网络和配对码房间都是这一个动作——再把剩下的内容合并成更少、更长的几条发出去。",
    },
    {
      symptom: "本来一切正常，刷新之后对话是空的。",
      code: ["https://relayium.com/   # 刷新这个页面就是开一个没有记录的新会话"],
      fix: "这是设计而不是缺陷：Relayium 不保存服务端历史，所以没有可恢复的东西，也没有可供调取的服务器副本。离开会话之前，请把重要内容复制到备忘录里——这份记录的寿命只等于那个页面开着的时间。",
    },
    {
      symptom: "浏览器和 CLI 无法加入彼此的配对码。",
      code: ["relayium text 483920   # CLI 的配对码只能 CLI 对 CLI"],
      fix: "浏览器与 CLI 的文本会话使用不同的传输和配对握手，所以一端生成的 6 位码对另一端毫无意义。请用两个浏览器，或者两端都用 CLI——relayium text 会打印出第二台机器该运行的完整命令。",
    },
  ],
  cliHeading: "CLI：一台机器生成配对码，另一台加入",
  cliBody: [
    "在其中一台机器上直接运行 relayium text，不带配对码。它会用你的账号生成一个 6 位数字配对码，打印出另一台机器该运行的完整命令，并留在会话里等待对方加入。不需要临时文件，也不需要另外停掉任何进程。",
    "另一台机器用该码运行 relayium text。交互模式每行是一条消息，除非你主动要求，否则不会停下来核对校验码；多行或要求逐字节保真的内容请通过管道作为一条消息发送，管道方式不需要额外加任何参数。",
  ],
  cliNotes: [
    "CLI 配对码有效期 5 分钟，只能 CLI 对 CLI；浏览器码不能让浏览器与 CLI 互连。",
    "只有生成配对码的那台机器需要已登录账号；使用打印出来的配对码加入时不需要登录。",
    "--verify 用来主动开启 SAS 核对，它需要终端来回答，因此管道运行时加 --verify 会直接拒绝，而不是当作已确认继续。--yes 仍然可用，含义仍是“永不提示”，并且优先于 --verify。",
  ],
  boundariesHeading: "文本传输是什么，也不是什么",
  boundariesBody:
    "Relayium 把正文当作 UTF-8 纯文本，保留空格、制表符、空行和换行；不会执行内容、渲染 Markdown、自动识别链接或生成预览。",
  boundaries: [
    "两台设备必须同时在线；没有离线投递、收件箱、联系人或同步聊天记录。",
    "历史只存在于当前本地会话，结束会话或刷新页面后消失；服务器从不保存消息正文。",
    "每条消息最多 65,536 个 UTF-8 字节；更大的内容请作为文件发送。",
  ],
  faqHeading: "常见问题",
  faq: [
    {
      q: "Relayium 能读取或恢复我的消息吗？",
      a: "不能。消息内容在两台设备之间端到端加密，Relayium 服务器不保存消息正文或服务端历史。任一端都可复制或留存收到的文本；实时会话结束后，Relayium 没有可恢复的服务器副本。",
    },
    {
      q: "一端用浏览器、另一端用 CLI 可以吗？",
      a: "不可以。浏览器与 CLI 使用不同的传输和配对握手。请使用两台浏览器，或两端都使用 CLI。",
    },
  ],
  ctaText: "在两台在线设备上打开 Relayium，把下一段原本要“发给自己”的内容直接传过去。",
  ctaButton: "立即发送文本",
  relatedHeading: "继续阅读",
});

const ja = article({
  title: "端末間でテキスト、リンク、コマンドを送る",
  description:
    "Relayium でテキスト、リンク、コマンド、複数行コードを端末間転送。エンドツーエンド暗号化かつ同時オンライン限定で、Relayium サーバーはメッセージ本文やサーバー側履歴を保存しませんが、各端末は受信テキストを保持できます。",
  updatedLabel: "最終更新",
  lead: [
    "Relayium はファイルだけでなく、スマートフォンの URL、別の PC で使うコマンド、複数行のコードなど、クリップボード向けの内容も運べます。メッセージはエンドツーエンド暗号化され、Relayium サーバーは本文やサーバー側履歴を保存しませんが、各端末は受信テキストをコピーまたは保持できます。",
    "ブラウザと CLI の両方がテキストに対応しますが、別々の転送方式であり、互いのペアリングコードには参加できません。両端で同じ方式を選んでください。",
  ],
  browserHeading: "ブラウザ：オンライン端末へメッセージを送る",
  browserBody:
    "両方の端末で relayium.com を開きます。違うのは「どう出会うか」だけです。同じネットワークなら相手は「近くのデバイス」に自動表示され、ネットワークをまたぐ場合はクロスネットワーク画面でブラウザ用のペアリングコードを作り、もう一方のブラウザで参加します。出会ったあとに得られるものはどちらも同じです。相手のカードの操作は「ワークスペースを開く」の一つだけで、入力欄はそのワークスペースの中、ファイルとフォルダの添付の隣にあり、同じ1本の暗号化接続を使います。ネットワークをまたぐ場合、その接続を運ぶのは暗号化された TURN リレーで、リレーが転送するのは暗号文だけです。さらに時間の上限があり、ワークスペースは上限に達する前に知らせます。唯一の例外は最新のブラウザではない相手——古いブラウザ、ネイティブアプリ、CLI——で、その場合はファイルとメッセージを一度に片方ずつ使う以前の流れが残ります。",
  prereqLabel: "始める前に",
  prereqs: [
    "2台が同時にオンラインで、どちらもブラウザでページを開いていること。受信箱はありません。メッセージは双方が開いたままにしているセッションの中にだけ存在します。",
    "両端で同じ転送方式を選ぶこと。同一ネットワークなら準備は何も要りません。別のネットワークならブラウザ用のペアリングコードが必要で、作成側がサインインし、寿命は5分です。",
    "1メッセージに収まる分量、つまり UTF-8 で 65,536 バイトまで。入力に応じてカウンターが増え、超えるとファイルとして送るよう案内されます。",
    "届いたものを置く場所。受信メッセージは開いているセッションの中に留まるので、残したいものはセッションが終わる前、ページを再読み込みする前にコピーしてください。",
  ],
  browserSteps: [
    {
      text: "両方の端末で転送ページを開きます。同一ネットワークのページは相手を自動的に見つけ、別ネットワークならペアリングコードをリアルタイム転送のページで使います。",
      code: ["https://relayium.com/"],
    },
    {
      text: "相手のカードで「ワークスペースを開く」を押し、ワークスペースが出す入力欄に打ち込みます。どちらの経路でも操作は同じ一つです。同じネットワークなら「近くのデバイス」の中、ネットワークをまたぐならペアリングコードの部屋の相手のカードにあります。既定では両端でそのまま入力欄が開きます。いずれの場合も接続は暗号化されています。",
    },
    {
      text: "テキストを入力または貼り付けます。入力欄の下のカウンターは、1メッセージ分の枠をどれだけ使ったかを文字数ではなくバイト数で示します。絵文字や日本語の1文字は数バイトを消費するためです。",
      code: ["1,024 / 65,536 バイト"],
    },
    {
      text: "⌘/Ctrl+Enter で送信します。Enter 単体は改行なので、複数行のスニペットを貼り付けてそのまま送れます。その割り当ては入力欄の下のヒントに書かれています。",
      code: ["Enter で改行 · ⌘/Ctrl+Enter で送信"],
    },
    {
      text: "セッションを開いたままにすれば双方向に何度でも送れ、残したいものは「コピー」を押します。先に検証コード（SAS）を照合したい場合は、セッションを開く前に「高度な検証」をオンにしてください。増えるのはコードと明示的な承認の一手間で、暗号化そのものではありません。",
    },
  ],
  successLabel: "セッションが正常なときの画面",
  successBody: [
    "両端でセッションが開いていると表示され、送ったメッセージが相手の端末の履歴に現れ、バイトカウンターは次の1通のためにゼロへ戻ります。",
    "その履歴が Relayium の関わる唯一のコピーです。開いている2つのページの中だけに存在し、再読み込みやセッション終了で消えます。また「コピー」はその端末のクリップボードにテキストを置くため、ほかのアプリからも読める状態になります。",
  ],
  successCode: ["セッション接続中\n1,024 / 65,536 バイト"],
  fixHeading: "メッセージが送れないとき",
  fixBody:
    "テキストはファイル転送と同じ接続を使うため、失敗のほとんどはメッセージではなく接続の問題です。例外は2つだけで具体的であり、どちらも画面に表示されます。サイズ上限を超えたメッセージと、一度に送りすぎて閉じられたセッションです。",
  fixLabel: "症状・確認・対処",
  fixes: [
    {
      symptom: "相手の端末がいつまでも現れず、メッセージセッションを開くカードがない。",
      code: ["https://relayium.com/   # 両方の端末のステータス表示にあるグローバル IP を比べる"],
      fix: "同一ネットワークの検出は接続元のグローバル IP でグループ化するため、アドレスが2つ違えばルームも2つです。VPN や iCloud プライベートリレーを切る、あるいは同じ Wi-Fi に参加してください。本当に別のネットワークにいる場合は、https://relayium.com/cross-network のペアリングコードを使います。",
    },
    {
      symptom: "入力欄がテキストを受け付けず、メッセージが長すぎると出る。",
      code: ["1,024 / 65,536 バイト   # カウンターは文字数ではなく UTF-8 のバイト数"],
      fix: "1メッセージは UTF-8 で 65,536 バイトまでで、非ラテン文字は1文字あたり2〜4バイトを使うため、長い日本語や絵文字の多い貼り付けは、文字数から想像するよりずっと手前でそのバイト上限に達します。分割するか、ファイルとして送ってください。入力欄がまさにそれを案内します。",
    },
    {
      symptom: "セッションが自ら閉じ、メッセージが多すぎたと告げる。",
      code: ["https://relayium.com/   # セッションの行が失敗ではなく終了と表示する"],
      fix: "片側が人の入力を大きく超える数のメッセージを送ると、洪水対策がセッションを閉じます。スクリプトや押されたままのキーがこれを起こします。開いたときと同じやり方でセッションを開き直し——相手のカードで「ワークスペースを開く」、同じネットワークでもペアリングコードの部屋でも同じです——残りのテキストは少ない回数でまとめて送ってください。",
    },
    {
      symptom: "うまくいっていたのに、再読み込みしたら会話が空になっている。",
      code: ["https://relayium.com/   # このページを再読み込みすると履歴のない新しいセッションになる"],
      fix: "これは不具合ではなく設計です。Relayium はサーバー側の履歴を保存しないので、復元するものはなく、取り寄せられるサーバーのコピーもありません。セッションを離れる前に必要な内容をメモへコピーしてください。履歴の寿命は、そのページが開いている間だけです。",
    },
    {
      symptom: "ブラウザと CLI が互いのコードで参加できない。",
      code: ["relayium text 483920   # CLI のコードは CLI 同士しかペアにしない"],
      fix: "ブラウザと CLI のテキストセッションは転送方式もペアリング手順も異なるため、一方が発行した6桁コードは他方には無意味です。ブラウザ2つ、または両端で CLI を使ってください。relayium text は2台目が実行すべきコマンドをそのまま表示します。",
    },
  ],
  cliHeading: "CLI：片方でコードを発行し、もう片方が参加する",
  cliBody: [
    "片方のマシンでコードを付けずに relayium text を実行します。アカウントで 6 桁の数字コードを発行し、もう一方が実行すべきコマンドをそのまま表示し、相手の参加を待ちます。一時ファイルも、止めるべき別プロセスもありません。",
    "もう一方のマシンではそのコードを指定して relayium text を実行します。対話モードは 1 行を 1 メッセージとして送り、こちらから求めない限りコード照合で止まることはありません。複数行や正確な stdin はパイプで 1 メッセージとして送れます。パイプ実行に追加のフラグは不要です。",
  ],
  cliNotes: [
    "CLI コードは 5 分有効で CLI 同士専用です。ブラウザと CLI は接続できません。",
    "ログイン済みアカウントが必要なのはコードを発行する側だけです。表示されたコードで参加する側はログイン不要です。",
    "--verify は SAS 照合を有効にするオプションで、応答するには端末が必要です。そのためパイプ実行に --verify を付けると、確認済みとして続行せずに拒否します。--yes も引き続き使え、意味は「決してプロンプトを出さない」で、--verify より優先されます。",
  ],
  boundariesHeading: "テキスト転送の範囲",
  boundariesBody:
    "本文は UTF-8 のプレーンテキストです。空白、タブ、空行、改行を保持し、実行、Markdown 描画、リンク化、プレビューはしません。",
  boundaries: [
    "両端が同時にオンラインである必要があります。オフライン配信、受信箱、連絡先、同期チャット履歴はありません。",
    "履歴は開いているローカルセッションだけにあり、終了や再読み込みで消えます。サーバーは本文を保存しません。",
    "1 メッセージは UTF-8 で 65,536 バイトまで。それ以上はファイルとして送ってください。",
  ],
  faqHeading: "よくある質問",
  faq: [
    { q: "Relayium はメッセージを読んだり復元できますか？", a: "できません。内容は端末間でエンドツーエンド暗号化され、Relayium サーバーは本文やサーバー側履歴を保存しません。各端末は受信テキストを保持できますが、セッション終了後に Relayium から復元できるサーバーコピーはありません。" },
    { q: "片方をブラウザ、片方を CLI にできますか？", a: "できません。転送方式とペアリング方式が異なります。ブラウザ同士、または CLI 同士で使ってください。" },
  ],
  ctaText: "オンラインの 2 台で Relayium を開き、次に自分宛てへ送るはずだった内容を直接移しましょう。",
  ctaButton: "テキストを送る",
  relatedHeading: "関連記事",
});

const ko = article({
  title: "기기 사이에서 텍스트, 링크, 명령 보내기",
  description:
    "Relayium으로 텍스트, 링크, 명령과 여러 줄 코드를 기기 사이에 전송하세요. 종단간 암호화와 동시 온라인 전용이며, Relayium 서버는 메시지 본문이나 서버 측 기록을 저장하지 않지만 각 기기는 받은 텍스트를 보관할 수 있습니다.",
  updatedLabel: "최근 업데이트",
  lead: [
    "Relayium은 파일뿐 아니라 휴대폰의 URL, 다른 컴퓨터에서 쓸 명령, 여러 줄 코드처럼 클립보드에 맞는 내용도 옮깁니다. 메시지는 종단간 암호화되며 Relayium 서버는 본문이나 서버 측 기록을 저장하지 않지만, 각 기기는 받은 텍스트를 복사하거나 보관할 수 있습니다.",
    "브라우저와 CLI 모두 텍스트를 지원하지만 서로 다른 전송 방식이므로 상대 방식의 페어링 코드에 참여할 수 없습니다. 양쪽에서 같은 방식을 사용하세요.",
  ],
  browserHeading: "브라우저: 온라인 기기에 메시지 보내기",
  browserBody:
    "두 기기에서 relayium.com을 엽니다. 다른 것은 “어떻게 만나는가”뿐입니다. 같은 네트워크에서는 상대가 “주변 기기”에 저절로 나타나고, 다른 네트워크에서는 교차 네트워크 페이지에서 브라우저 페어링 코드를 만들어 다른 브라우저로 참여합니다. 만나고 난 뒤 얻는 것은 어느 쪽이든 같습니다. 상대 카드가 주는 동작은 “작업 공간 열기” 하나뿐이고, 작성기는 그 작업 공간 안, 파일과 폴더 첨부 옆에 있으며 하나의 암호화된 연결을 함께 씁니다. 다른 네트워크에서는 그 연결을 암호화된 TURN 릴레이가 나르며, 릴레이가 전달하는 것은 암호문뿐입니다. 또한 시간 제한이 있고 작업 공간이 그 전에 알려 줍니다. 유일한 예외는 최신 브라우저가 아닌 상대 — 오래된 브라우저, 네이티브 앱, CLI — 로, 이 경우 파일과 메시지를 한 번에 하나씩 쓰던 이전 흐름이 남습니다.",
  prereqLabel: "시작하기 전에",
  prereqs: [
    "두 기기가 같은 시간에 온라인이고, 둘 다 브라우저에서 페이지를 열어 두어야 합니다. 받은편지함은 없습니다. 메시지는 양쪽이 열어 둔 세션 안에만 존재합니다.",
    "양쪽에서 같은 전송 방식을 고르세요. 같은 네트워크에서는 준비할 것이 없고, 다른 네트워크에서는 브라우저 페어링 코드가 필요하며 만드는 쪽이 로그인하고 수명은 5분입니다.",
    "한 메시지에 들어갈 분량, 즉 UTF-8 65,536바이트까지. 입력하는 동안 카운터가 올라가고, 넘으면 파일로 보내라고 알려줍니다.",
    "도착한 것을 둘 자리. 받은 메시지는 열린 세션 안에 남으므로, 남기고 싶은 것은 세션이 끝나거나 페이지를 새로고침하기 전에 복사하세요.",
  ],
  browserSteps: [
    {
      text: "두 기기에서 전송 페이지를 엽니다. 같은 네트워크 페이지는 상대를 알아서 찾아 주고, 서로 다른 네트워크라면 페어링 코드를 실시간 전송 페이지에서 씁니다.",
      code: ["https://relayium.com/"],
    },
    {
      text: "상대 기기 카드에서 “작업 공간 열기”를 누르고, 작업 공간이 띄우는 작성기에 입력합니다. 어느 경로든 같은 하나의 동작입니다. 같은 네트워크면 “주변 기기”에, 다른 네트워크면 페어링 코드 방의 상대 카드에 있습니다. 기본값에서는 양쪽 모두 곧바로 작성기가 열립니다. 어느 쪽이든 연결은 암호화됩니다.",
    },
    {
      text: "텍스트를 입력하거나 붙여 넣습니다. 입력창 아래 카운터는 한 메시지 예산을 얼마나 썼는지 글자 수가 아니라 바이트로 보여줍니다. 이모지나 한글 한 글자가 여러 바이트를 쓰기 때문입니다.",
      code: ["1,024 / 65,536 바이트"],
    },
    {
      text: "⌘/Ctrl+Enter로 보냅니다. Enter만 누르면 줄바꿈이라, 여러 줄 스니펫을 붙여 넣고 한 번에 보낼 수 있습니다. 그 할당은 입력창 아래 안내에 적혀 있습니다.",
      code: ["Enter 로 줄바꿈 · ⌘/Ctrl+Enter 로 전송"],
    },
    {
      text: "세션을 열어 두면 양방향으로 여러 메시지를 보낼 수 있고, 남기고 싶은 것은 “복사”를 누르면 됩니다. 먼저 검증 코드(SAS)를 대조하려면 세션을 열기 전에 “고급 검증”을 켜세요. 늘어나는 것은 코드와 명시적인 수락 한 단계일 뿐 암호화가 아닙니다.",
    },
  ],
  successLabel: "세션이 잘될 때의 화면",
  successBody: [
    "양쪽에서 세션이 열렸다고 표시되고, 보낸 메시지가 상대 기기의 기록에 나타나며, 바이트 카운터는 다음 메시지를 위해 0으로 돌아갑니다.",
    "그 기록이 Relayium이 관여하는 유일한 사본입니다. 열려 있는 두 페이지 안에만 있어 새로고침하거나 세션이 끝나면 사라지고, “복사”는 그 기기의 클립보드에 텍스트를 올려 다른 앱도 읽을 수 있게 합니다.",
  ],
  successCode: ["세션 연결됨\n1,024 / 65,536 바이트"],
  fixHeading: "메시지가 가지 않을 때",
  fixBody:
    "텍스트는 파일 전송과 같은 연결을 쓰므로, 실패는 대개 메시지가 아니라 연결의 문제입니다. 예외는 둘뿐이고 구체적이며 둘 다 화면에 표시됩니다. 크기 상한을 넘긴 메시지, 그리고 한꺼번에 너무 많이 보내 닫힌 세션입니다.",
  fixLabel: "증상, 확인, 조치",
  fixes: [
    {
      symptom: "상대 기기가 끝내 나타나지 않아 메시지 세션을 열 카드가 없습니다.",
      code: ["https://relayium.com/   # 두 기기의 상태 표시에 있는 공인 IP를 비교한다"],
      fix: "같은 네트워크 탐색은 접속해 온 공인 IP로 기기를 묶으므로, 주소가 다르면 방도 둘입니다. VPN이나 iCloud 비공개 릴레이를 끄거나 같은 Wi-Fi에 접속하세요. 정말로 다른 네트워크라면 https://relayium.com/cross-network 의 페어링 코드를 쓰세요.",
    },
    {
      symptom: "작성기가 텍스트를 받지 않고 메시지가 너무 길다고 합니다.",
      code: ["1,024 / 65,536 바이트   # 카운터는 글자 수가 아니라 UTF-8 바이트다"],
      fix: "한 메시지는 UTF-8 65,536바이트까지이고, 라틴 문자가 아닌 글자는 한 글자에 2~4바이트를 쓰므로 긴 한글이나 이모지가 많은 붙여넣기는 글자 수로 짐작하는 것보다 훨씬 앞에서 그 바이트 상한에 닿습니다. 나누어 보내거나 파일로 보내세요 — 작성기가 바로 그것을 제안합니다.",
    },
    {
      symptom: "세션이 스스로 닫히며 메시지가 너무 많았다고 알립니다.",
      code: ["https://relayium.com/   # 세션 줄이 실패가 아니라 종료라고 보고한다"],
      fix: "한쪽이 사람이 타이핑하는 양을 크게 넘는 메시지를 보내면 홍수 방지가 세션을 닫습니다. 스크립트나 눌린 키가 그렇게 만듭니다. 열었던 방식 그대로 세션을 다시 여세요 — 상대 카드에서 “작업 공간 열기”, 같은 네트워크든 페어링 코드 방이든 동일합니다 — 그리고 남은 텍스트를 더 적고 큰 메시지로 보내세요.",
    },
    {
      symptom: "잘되고 있었는데 새로고침하니 대화가 비어 있습니다.",
      code: ["https://relayium.com/   # 이 페이지를 새로고침하면 기록 없는 새 세션이 된다"],
      fix: "이것은 결함이 아니라 설계입니다. Relayium은 서버 측 기록을 저장하지 않으므로 복원할 것도, 제출을 요구받을 서버 사본도 없습니다. 세션을 떠나기 전에 중요한 내용을 메모로 복사하세요. 기록의 수명은 그 페이지가 열려 있는 동안뿐입니다.",
    },
    {
      symptom: "브라우저와 CLI가 서로의 코드로 참여하지 못합니다.",
      code: ["relayium text 483920   # CLI 코드는 CLI끼리만 짝을 짓는다"],
      fix: "브라우저와 CLI의 텍스트 세션은 전송 방식과 페어링 절차가 달라, 한쪽이 발급한 여섯 자리 코드는 다른 쪽에 아무 의미가 없습니다. 브라우저 두 개를 쓰거나 양쪽 모두 CLI를 쓰세요. relayium text가 두 번째 컴퓨터에서 실행할 명령을 그대로 출력합니다.",
    },
  ],
  cliHeading: "CLI: 한쪽에서 코드를 발급하고 다른 쪽이 참여",
  cliBody: [
    "한쪽 컴퓨터에서 코드 없이 relayium text를 실행합니다. 계정으로 6자리 코드를 발급하고, 다른 쪽이 실행할 명령을 그대로 출력한 뒤 상대가 참여할 때까지 세션에서 기다립니다. 임시 파일도, 따로 중지할 프로세스도 없습니다.",
    "다른 쪽 컴퓨터에서 그 코드로 relayium text를 실행합니다. 대화형 모드는 한 줄을 한 메시지로 보내며, 직접 요청하지 않는 한 코드를 대조하려고 멈추지 않습니다. 여러 줄이거나 바이트 그대로 보내야 하는 stdin은 파이프로 한 메시지로 보내면 되고, 파이프 실행에는 추가 플래그가 필요 없습니다.",
  ],
  cliNotes: [
    "CLI 코드는 5분 동안 유효하고 CLI끼리만 연결합니다. 브라우저와 CLI는 서로 연결되지 않습니다.",
    "로그인 계정은 코드를 발급하는 쪽에만 필요합니다. 출력된 코드로 참여하는 쪽은 로그인할 필요가 없습니다.",
    "--verify는 SAS 대조를 켜는 옵션이며 답하려면 터미널이 필요합니다. 그래서 파이프 실행에 --verify를 붙이면 확인된 것처럼 진행하지 않고 거부합니다. --yes도 그대로 쓸 수 있고 “절대 묻지 않음”을 뜻하며 --verify보다 우선합니다.",
  ],
  boundariesHeading: "텍스트 전송의 범위",
  boundariesBody:
    "본문은 UTF-8 일반 텍스트입니다. 공백, 탭, 빈 줄과 줄바꿈을 보존하며 실행, Markdown 렌더링, 링크 변환, 미리보기를 하지 않습니다.",
  boundaries: [
    "두 기기가 동시에 온라인이어야 합니다. 오프라인 전달, 받은편지함, 연락처, 동기화된 채팅 기록은 없습니다.",
    "기록은 열린 로컬 세션에만 있고 종료하거나 새로고침하면 사라집니다. 서버는 본문을 저장하지 않습니다.",
    "메시지 하나는 UTF-8 65,536바이트까지입니다. 더 크면 파일로 보내세요.",
  ],
  faqHeading: "자주 묻는 질문",
  faq: [
    { q: "Relayium이 메시지를 읽거나 복구할 수 있나요?", a: "아니요. 내용은 기기 사이에서 종단간 암호화되고 Relayium 서버는 본문이나 서버 측 기록을 저장하지 않습니다. 각 기기는 받은 텍스트를 보관할 수 있지만, 세션이 끝나면 Relayium에서 복구할 서버 사본은 없습니다." },
    { q: "한쪽은 브라우저, 다른 쪽은 CLI를 쓸 수 있나요?", a: "아니요. 전송과 페어링 방식이 다릅니다. 브라우저 두 개 또는 CLI 두 개를 사용하세요." },
  ],
  ctaText: "온라인 기기 두 대에서 Relayium을 열고 다음에 자신에게 보낼 내용을 바로 옮겨 보세요.",
  ctaButton: "텍스트 보내기",
  relatedHeading: "더 읽기",
});

const de = article({
  title: "Text, Links und Befehle zwischen Geräten senden",
  description:
    "Mit Relayium Text, Links, Befehle und mehrzeiligen Code zwischen Geräten übertragen — Ende-zu-Ende-verschlüsselt und nur online; Relayium-Server speichern weder Nachrichteninhalte noch serverseitigen Verlauf, beide Endpunkte können empfangenen Text jedoch aufbewahren.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Relayium überträgt neben Dateien auch Inhalte für die Zwischenablage: eine URL vom Handy, einen Befehl für einen anderen Rechner oder mehrzeiligen Code. Nachrichten sind Ende-zu-Ende-verschlüsselt; Relayium-Server speichern weder Inhalte noch serverseitigen Verlauf, aber beide Endpunkte können empfangenen Text kopieren oder aufbewahren.",
    "Browser und CLI unterstützen beide Text, verwenden aber getrennte Transportwege und können den Kopplungscode der jeweils anderen Seite nicht nutzen. Verwende an beiden Enden dieselbe Variante.",
  ],
  browserHeading: "Browser: Nachricht an ein Online-Gerät senden",
  browserBody:
    "Öffne relayium.com auf beiden Geräten. Unterschiedlich ist nur, wie sie sich finden: Im selben Netz erscheint das andere Gerät von selbst unter „Geräte in der Nähe“, netzübergreifend erzeugst du auf der Cross-Network-Seite einen Browser-Pairing-Code und trittst im zweiten Browser bei. Was beide danach bekommen, ist dasselbe: Die Karte der Gegenstelle bietet genau eine Aktion, „Arbeitsbereich öffnen“, und das Eingabefeld sitzt in diesem Arbeitsbereich, neben den Anhängen für Dateien und Ordner, auf derselben einen verschlüsselten Verbindung. Netzübergreifend trägt ein verschlüsseltes TURN-Relay diese Verbindung und leitet dabei nur Chiffretext weiter; außerdem läuft sie unter einer Zeitgrenze, auf die der Arbeitsbereich hinweist, bevor sie erreicht ist. Die einzige Ausnahme ist eine Gegenstelle, die kein aktueller Browser ist — ein älterer, eine native App, das CLI: Dort bleibt der frühere Ablauf, bei dem Dateien und Nachrichten nacheinander genutzt werden.",
  prereqLabel: "Bevor du anfängst",
  prereqs: [
    "Beide Geräte gleichzeitig online, mit der Seite im Browser geöffnet. Es gibt keine Inbox: Eine Nachricht existiert nur in einer Sitzung, die beide Seiten offen halten.",
    "Ein Transportweg, für beide Enden derselbe. Im selben Netz braucht es gar nichts; über verschiedene Netze braucht es einen Browser-Pairing-Code, für den sich die erzeugende Seite anmeldet und der fünf Minuten lebt.",
    "Text, der in eine Nachricht passt: 65.536 UTF-8-Bytes. Der Zähler im Eingabefeld läuft beim Tippen mit und weist dich darüber hinaus darauf hin, es als Datei zu senden.",
    "Ein Platz für das, was ankommt. Die empfangene Nachricht bleibt in der offenen Sitzung — kopiere also alles, was du behalten willst, bevor die Sitzung endet oder die Seite neu lädt.",
  ],
  browserSteps: [
    {
      text: "Öffne die Übertragungsseite auf beiden Geräten — die Seite für dasselbe Netz findet sie für dich, und auf der Echtzeitseite kommt ein Pairing-Code zum Einsatz, wenn sie in verschiedenen Netzen sind.",
      code: ["https://relayium.com/"],
    },
    {
      text: "Drücke auf der Karte des anderen Geräts „Arbeitsbereich öffnen“ und tippe in das Eingabefeld, das der Arbeitsbereich zeigt. Es ist so oder so dieselbe eine Aktion: im selben Netz unter „Geräte in der Nähe“, netzübergreifend auf der Karte der Gegenstelle im Pairing-Code-Raum. Standardmäßig öffnet sich die Sitzung auf beiden Seiten direkt im Eingabefeld — verschlüsselt ist die Verbindung so oder so.",
    },
    {
      text: "Text eingeben oder einfügen. Der Zähler unter dem Feld zeigt, wie viel des Budgets für eine Nachricht verbraucht ist, und zwar in Bytes statt in Zeichen, denn ein Emoji oder ein CJK-Zeichen kostet mehrere.",
      code: ["1.024 / 65.536 Bytes"],
    },
    {
      text: "Mit ⌘/Strg+Enter senden — Enter allein setzt einen Zeilenumbruch, und genau das macht ein mehrzeiliges Snippet in einem Zug einfügbar und sendbar. Der Hinweis unter dem Feld nennt diese Belegung.",
      code: ["Enter für neue Zeile · ⌘/Ctrl+Enter zum Senden"],
    },
    {
      text: "Lass die Sitzung offen, um in beide Richtungen mehrere Nachrichten zu senden, und drücke „Kopieren“ bei allem, was du behalten willst. Wer vorher einen Verifizierungscode (SAS) vergleichen will, schaltet „Erweiterte Verifizierung“ ein, bevor die Sitzung geöffnet wird: Sie ergänzt den Code und einen ausdrücklichen Annahmeschritt, nicht die Verschlüsselung.",
    },
  ],
  successLabel: "So sieht eine funktionierende Sitzung aus",
  successBody: [
    "Beide Seiten zeigen die Sitzung als offen an, deine Nachricht erscheint im Verlauf auf dem anderen Gerät, und der Byte-Zähler steht für die nächste wieder auf Null.",
    "Dieser Verlauf ist die einzige Kopie, an der Relayium beteiligt ist: Er lebt in den zwei offenen Seiten, ist also nach einem Neuladen oder mit dem Ende der Sitzung fort, und „Kopieren“ legt den Text in die Zwischenablage dieses Geräts, wo andere Apps ihn lesen können.",
  ],
  successCode: ["Sitzung offen\n1.024 / 65.536 Bytes"],
  fixHeading: "Wenn eine Nachricht nicht durchgeht",
  fixBody:
    "Text nutzt dieselbe Verbindung wie eine Dateiübertragung, die meisten Fehler betreffen also die Verbindung und nicht die Nachricht. Die zwei Ausnahmen sind konkret und stehen beide auf dem Bildschirm: eine Nachricht über der Größengrenze, und eine Sitzung, die wegen zu vieler Nachrichten auf einmal geschlossen wurde.",
  fixLabel: "Symptom, Prüfung, Lösung",
  fixes: [
    {
      symptom: "Das andere Gerät erscheint nie, es gibt also keine Karte, aus der eine Nachrichtensitzung zu öffnen wäre.",
      code: ["https://relayium.com/   # die öffentliche IP in der Statuszeile auf beiden Geräten vergleichen"],
      fix: "Die Erkennung im selben Netz gruppiert Geräte nach der öffentlichen IP, über die sie sich verbinden, zwei verschiedene Adressen bedeuten also zwei Räume — trenne ein VPN oder iCloud Private Relay, oder geh ins selbe WLAN. Sind sie wirklich in verschiedenen Netzen, nimm einen Pairing-Code auf https://relayium.com/cross-network.",
    },
    {
      symptom: "Das Eingabefeld nimmt den Text nicht an und meldet, die Nachricht sei zu lang.",
      code: ["1.024 / 65.536 Bytes   # der Zähler zählt UTF-8-Bytes, nicht Zeichen"],
      fix: "Eine Nachricht fasst 65.536 UTF-8-Bytes, und nichtlateinischer Text verbraucht zwei bis vier Bytes pro Zeichen, ein langer chinesischer oder emoji-lastiger Einfügevorgang erreicht diese Byte-Grenze also lange vor dem, was die Zeichenzahl vermuten lässt. Teile ihn auf, oder sende ihn als Datei — genau das bietet das Eingabefeld an.",
    },
    {
      symptom: "Die Sitzung hat sich selbst geschlossen und zu viele Nachrichten dafür verantwortlich gemacht.",
      code: ["https://relayium.com/   # die Sitzungszeile meldet beendet statt fehlgeschlagen"],
      fix: "Ein Flutschutz schließt eine Sitzung, wenn eine Seite weit mehr Nachrichten sendet, als ein Mensch tippt — ein Skript oder eine hängende Taste schafft das. Öffne die Sitzung so neu, wie du sie geöffnet hast — „Arbeitsbereich öffnen“ auf der Karte des anderen Geräts, im selben Netz wie im Pairing-Code-Raum — und schicke den restlichen Text in weniger, größeren Nachrichten.",
    },
    {
      symptom: "Alles lief, und nach einem Neuladen ist das Gespräch leer.",
      code: ["https://relayium.com/   # ein Neuladen dieser Seite startet eine neue Sitzung ohne Verlauf"],
      fix: "Das ist Absicht und kein Fehler: Relayium speichert keinen serverseitigen Verlauf, es gibt also nichts wiederherzustellen und auch keine Serverkopie, die jemand anfordern könnte. Kopiere Wichtiges in eine Notiz, bevor du die Sitzung verlässt — der Verlauf hält nur so lange wie die offene Seite.",
    },
    {
      symptom: "Ein Browser und die CLI können dem Code des jeweils anderen nicht beitreten.",
      code: ["relayium text 483920   # ein CLI-Code koppelt immer nur CLI mit CLI"],
      fix: "Browser- und CLI-Textsitzungen nutzen verschiedene Transportwege und Kopplungsverfahren, ein sechsstelliger Code der einen Seite ist für die andere also bedeutungslos. Nimm zwei Browser, oder die CLI an beiden Enden — relayium text gibt genau den Befehl aus, den der zweite Rechner ausführen soll.",
    },
  ],
  cliHeading: "CLI: auf einem Rechner einen Code erzeugen, auf dem anderen beitreten",
  cliBody: [
    "Starte auf einem Rechner relayium text ohne Code. Der Befehl erzeugt mit deinem Konto einen sechsstelligen Pairing-Code, gibt genau den Befehl aus, den der andere Rechner ausführen soll, und wartet in der Sitzung auf ihn. Keine temporäre Datei, kein zusätzlicher Prozess, der beendet werden müsste.",
    "Starte auf dem anderen Rechner relayium text mit diesem Code. Interaktiv ist jede Zeile eine Nachricht, und es wird nicht für einen Codevergleich angehalten, solange du das nicht verlangst. Mehrzeilige oder bytegenaue Eingabe wird als eine Nachricht gepiped — dafür ist kein zusätzliches Flag nötig.",
  ],
  cliNotes: [
    "CLI-Codes gelten fünf Minuten und verbinden nur CLI mit CLI; Browser und CLI sind nicht interoperabel.",
    "Nur der Rechner, der den Code erzeugt, braucht ein angemeldetes Konto. Der Rechner, der dem ausgegebenen Code beitritt, muss sich nicht anmelden.",
    "--verify schaltet den SAS-Vergleich ein und braucht ein Terminal für die Antwort; ein gepipeter Lauf mit --verify wird deshalb abgelehnt, statt so weiterzulaufen, als wäre bestätigt worden. --yes wird weiterhin akzeptiert, bedeutet „niemals fragen“ und hat Vorrang vor --verify.",
  ],
  boundariesHeading: "Was Textübertragung ist — und was nicht",
  boundariesBody:
    "Der Inhalt bleibt UTF-8-Klartext mit Leerzeichen, Tabs, Leerzeilen und Zeilenumbrüchen. Relayium führt nichts aus, rendert kein Markdown, verlinkt nichts und erstellt keine Vorschau.",
  boundaries: [
    "Beide Geräte müssen gleichzeitig online sein. Es gibt keine Offline-Zustellung, Inbox, Kontakte oder synchronisierte Chat-Historie.",
    "Der Verlauf lebt nur lokal in der offenen Sitzung und verschwindet beim Ende oder Neuladen. Der Server speichert keine Nachrichtentexte.",
    "Eine Nachricht darf höchstens 65.536 UTF-8-Bytes groß sein. Größere Inhalte sendest du als Datei.",
  ],
  faqHeading: "Häufige Fragen",
  faq: [
    { q: "Kann Relayium meine Nachrichten lesen oder wiederherstellen?", a: "Nein. Der Inhalt ist zwischen den Geräten Ende-zu-Ende-verschlüsselt, und Relayium-Server speichern weder Nachrichteninhalte noch serverseitigen Verlauf. Beide Endpunkte können empfangenen Text aufbewahren; nach Sitzungsende hat Relayium keine Serverkopie zur Wiederherstellung." },
    { q: "Kann eine Seite den Browser und die andere die CLI nutzen?", a: "Nein. Transport und Kopplung sind verschieden. Verwende zwei Browser oder zwei CLI-Clients." },
  ],
  ctaText: "Öffne Relayium auf zwei Online-Geräten und übertrage den nächsten Inhalt direkt statt ihn dir selbst zu schicken.",
  ctaButton: "Jetzt Text senden",
  relatedHeading: "Weiterlesen",
});

const fr = article({
  title: "Envoyer du texte, des liens et des commandes entre appareils",
  description:
    "Transférez texte, liens, commandes et code multiligne avec Relayium — chiffré de bout en bout et uniquement en ligne ; les serveurs Relayium ne gardent ni corps de message ni historique côté serveur, mais chaque extrémité peut conserver le texte reçu.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Relayium transporte aussi le contenu du presse-papiers : une URL du téléphone, une commande pour un autre ordinateur ou un bloc de code multiligne. Les messages sont chiffrés de bout en bout ; les serveurs Relayium ne gardent ni corps de message ni historique côté serveur, mais chaque extrémité peut copier ou conserver le texte reçu.",
    "Le navigateur et la CLI prennent en charge le texte, mais utilisent des transports séparés et ne peuvent pas rejoindre leurs codes respectifs. Utilisez la même méthode aux deux extrémités.",
  ],
  browserHeading: "Navigateur : envoyer un message à un appareil en ligne",
  browserBody:
    "Ouvrez relayium.com sur les deux appareils. Seule la façon dont ils se trouvent change : sur le même réseau, l'autre appareil apparaît tout seul sous « Appareils à proximité » ; entre réseaux, vous créez un code d'appairage navigateur sur la page interréseau et vous le rejoignez depuis l'autre navigateur. Ce que les deux obtiennent ensuite est identique : la carte du pair ne propose qu'une action, « Ouvrir l’espace de travail », et la zone de saisie vit dans cet espace de travail, à côté des pièces jointes fichier et dossier, sur la même connexion chiffrée. Entre réseaux, cette connexion est portée par un relais TURN chiffré qui ne transmet que du texte chiffré, et elle est soumise à une limite de temps que l'espace de travail signale avant qu'elle ne soit atteinte. La seule exception est un pair qui n'est pas un navigateur à jour — un ancien, une application native, le CLI : il conserve le flux antérieur, où fichiers et messages s'utilisent l'un après l'autre.",
  prereqLabel: "Avant de commencer",
  prereqs: [
    "Les deux appareils en ligne en même temps, avec la page ouverte dans un navigateur. Il n'y a pas de boîte de réception : un message n'existe que dans une session que les deux côtés maintiennent ouverte.",
    "Un seul transport, choisi pour les deux extrémités. Sur le même réseau, rien à préparer, alors qu'entre réseaux différents il faut un code d'appairage navigateur, créé par une partie connectée et valable cinq minutes.",
    "Un texte qui tient dans un message, soit 65 536 octets UTF-8. Le compteur sous la zone de saisie monte pendant que vous tapez et vous invite à l'envoyer comme fichier au-delà.",
    "Un endroit pour ce qui arrive. Le message reçu reste dans la session ouverte, donc copiez ce que vous voulez garder avant la fin de la session ou un rechargement de la page.",
  ],
  browserSteps: [
    {
      text: "Ouvrez la page de transfert sur les deux appareils : celle du même réseau les trouve pour vous, et c'est sur la page temps réel qu'un code d'appairage sert lorsqu'ils sont sur des réseaux différents.",
      code: ["https://relayium.com/"],
    },
    {
      text: "Appuyez sur « Ouvrir l’espace de travail » sur la carte de l'autre appareil, puis écrivez dans la zone de saisie que l'espace de travail affiche. C'est la même action unique dans les deux cas : sous « Appareils à proximité » sur le même réseau, et sur la carte du pair dans la salle par code d'appairage entre réseaux. Par défaut, la session s'ouvre directement sur la zone de saisie des deux côtés — la connexion est chiffrée dans tous les cas.",
    },
    {
      text: "Saisissez ou collez le texte. Le compteur sous la zone indique la part du budget d'un message déjà consommée, en octets plutôt qu'en caractères, car un emoji ou un idéogramme en coûte plusieurs.",
      code: ["1 024 / 65 536 octets"],
    },
    {
      text: "Envoyez avec ⌘/Ctrl+Entrée : Entrée seule insère un retour à la ligne, ce qui permet de coller puis d'envoyer un extrait multiligne d'un seul geste. L'indication sous la zone rappelle cette correspondance.",
      code: ["Entrée pour une nouvelle ligne · ⌘/Ctrl+Entrée pour envoyer"],
    },
    {
      text: "Laissez la session ouverte pour envoyer plusieurs messages dans les deux sens, et appuyez sur « Copier » sur tout ce que vous voulez garder. Pour comparer d'abord un code de vérification (SAS), activez « Vérification avancée » avant d'ouvrir la session : elle ajoute le code et une acceptation explicite, pas le chiffrement.",
    },
  ],
  successLabel: "À quoi ressemble une session qui marche",
  successBody: [
    "Les deux côtés indiquent la session comme ouverte, votre message apparaît dans l'historique de l'autre appareil, et le compteur d'octets repart de zéro pour le suivant.",
    "Cet historique est la seule copie à laquelle Relayium participe : il vit dans les deux pages ouvertes, disparaît donc au rechargement ou à la fin de la session, et « Copier » place le texte dans le presse-papiers de cet appareil, où d'autres applications peuvent le lire.",
  ],
  successCode: ["Session ouverte\n1 024 / 65 536 octets"],
  fixHeading: "Quand un message ne passe pas",
  fixBody:
    "Le texte emprunte la même connexion qu'un transfert de fichiers, donc la plupart des échecs viennent de la connexion et non du message. Les deux exceptions sont précises et s'affichent toutes les deux à l'écran : un message au-delà de la limite de taille, et une session fermée pour en avoir envoyé trop d'un coup.",
  fixLabel: "Symptôme, vérification, correction",
  fixes: [
    {
      symptom: "L'autre appareil n'apparaît jamais, il n'y a donc aucune carte pour ouvrir une session de messages.",
      code: ["https://relayium.com/   # comparez l'IP publique de la ligne d'état sur les deux appareils"],
      fix: "La détection sur le même réseau regroupe les appareils selon l'IP publique par laquelle ils se connectent, donc deux adresses différentes signifient deux salles : coupez un VPN ou iCloud Private Relay, ou rejoignez le même Wi-Fi. S'ils sont réellement sur des réseaux différents, passez par un code d'appairage sur https://relayium.com/cross-network.",
    },
    {
      symptom: "La zone de saisie refuse le texte et indique que le message est trop long.",
      code: ["1 024 / 65 536 octets   # le compteur compte des octets UTF-8, pas des caractères"],
      fix: "Un message contient 65 536 octets UTF-8, et un texte non latin dépense de deux à quatre octets par caractère, donc un long collage en chinois ou riche en emojis atteint cette limite en octets bien avant ce que le nombre de caractères laisse croire. Découpez-le, ou envoyez-le comme fichier, ce que la zone de saisie propose justement.",
    },
    {
      symptom: "La session s'est fermée d'elle-même en invoquant trop de messages.",
      code: ["https://relayium.com/   # la ligne de session indique terminée plutôt qu'échouée"],
      fix: "Une protection contre les envois en rafale ferme une session quand un côté envoie bien plus de messages qu'une personne n'en tape, ce qu'un script ou une touche bloquée provoque. Rouvrez la session comme vous l'aviez ouverte — « Ouvrir l’espace de travail » sur la carte de l'autre appareil, sur le même réseau comme dans une salle par code d'appairage — et envoyez le reste en moins de messages, plus longs.",
    },
    {
      symptom: "Tout fonctionnait, et après un rechargement la conversation est vide.",
      code: ["https://relayium.com/   # recharger cette page ouvre une nouvelle session sans historique"],
      fix: "C'est le fonctionnement voulu et non une panne : Relayium ne garde aucun historique côté serveur, il n'y a donc rien à restaurer et aucune copie serveur à réclamer. Copiez l'essentiel dans une note avant de quitter la session, car l'historique ne dure que le temps de la page ouverte.",
    },
    {
      symptom: "Un navigateur et la CLI ne peuvent pas rejoindre le code de l'autre.",
      code: ["relayium text 483920   # un code CLI n'appaire jamais que CLI avec CLI"],
      fix: "Les sessions de texte navigateur et CLI utilisent des transports et des appairages différents, donc un code à six chiffres créé par l'un n'a aucun sens pour l'autre. Utilisez deux navigateurs, ou la CLI aux deux extrémités : relayium text affiche exactement la commande que la seconde machine doit exécuter.",
    },
  ],
  cliHeading: "CLI : créer un code sur une machine, le rejoindre sur l'autre",
  cliBody: [
    "Lancez relayium text sans code sur une machine. La commande crée un code d'appairage à six chiffres avec votre compte, affiche exactement la commande que l'autre machine doit exécuter, et reste dans la session à l'attendre. Aucun fichier temporaire, aucun processus supplémentaire à arrêter.",
    "Lancez ensuite relayium text avec ce code sur l'autre machine. En mode interactif, chaque ligne est un message et rien ne s'arrête pour comparer un code tant que vous ne le demandez pas. Pour du texte multiligne ou exact, utilisez un pipe en un seul message : aucun indicateur supplémentaire n'est requis.",
  ],
  cliNotes: [
    "Les codes CLI durent cinq minutes et relient uniquement deux CLI ; navigateur et CLI ne sont pas interopérables.",
    "Seule la machine qui crée le code exige un compte connecté. Celle qui rejoint le code affiché n'a pas besoin de se connecter.",
    "--verify active la comparaison du SAS et nécessite un terminal pour y répondre : un lancement avec un pipe et --verify est refusé plutôt que poursuivi comme s'il avait été confirmé. --yes reste accepté, signifie toujours « ne jamais demander » et l'emporte sur --verify.",
  ],
  boundariesHeading: "Ce que le transfert de texte est — et n'est pas",
  boundariesBody:
    "Le contenu reste du texte brut UTF-8, avec espaces, tabulations, lignes vides et retours à la ligne. Relayium ne l'exécute pas, ne rend pas le Markdown, ne crée ni lien ni aperçu.",
  boundaries: [
    "Les deux appareils doivent être en ligne ensemble. Pas de livraison hors ligne, boîte de réception, contacts ou historique synchronisé.",
    "L'historique est local à la session ouverte et disparaît à sa fermeture ou au rechargement. Le serveur ne stocke aucun corps de message.",
    "Un message est limité à 65 536 octets UTF-8. Envoyez les contenus plus grands sous forme de fichier.",
  ],
  faqHeading: "Questions fréquentes",
  faq: [
    { q: "Relayium peut-il lire ou récupérer mes messages ?", a: "Non. Le contenu est chiffré de bout en bout entre les appareils, et les serveurs Relayium ne gardent ni corps de message ni historique côté serveur. Chaque extrémité peut conserver le texte reçu ; après la session, Relayium n'a aucune copie serveur à récupérer." },
    { q: "Puis-je utiliser le navigateur d'un côté et la CLI de l'autre ?", a: "Non. Les transports et associations diffèrent. Utilisez deux navigateurs ou deux clients CLI." },
  ],
  ctaText: "Ouvrez Relayium sur deux appareils en ligne et transférez directement ce que vous vous seriez envoyé à vous-même.",
  ctaButton: "Envoyer du texte",
  relatedHeading: "Continuer la lecture",
});

const ar = article({
  title: "إرسال النصوص والروابط والأوامر بين الأجهزة",
  description:
    "انقل النصوص والروابط والأوامر والشيفرة متعددة الأسطر عبر Relayium — بتشفير من الطرف إلى الطرف وأثناء اتصال الجهازين فقط؛ لا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم، لكن يمكن لأي طرف الاحتفاظ بالنص المستلم.",
  updatedLabel: "آخر تحديث",
  lead: [
    "ينقل Relayium محتوى الحافظة إلى جانب الملفات: رابطًا من الهاتف، أو أمرًا لجهاز آخر، أو شيفرة متعددة الأسطر. الرسائل مشفّرة من الطرف إلى الطرف؛ لا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم، لكن يمكن لأي طرف نسخ النص المستلم أو الاحتفاظ به.",
    "يدعم المتصفح وسطر الأوامر النصوص، لكنهما وسيلتا نقل منفصلتان ولا يمكن لإحداهما الانضمام برمز الأخرى. استخدم الوسيلة نفسها في الطرفين.",
  ],
  browserHeading: "المتصفح: إرسال رسالة إلى جهاز متصل",
  browserBody:
    "افتح relayium.com على الجهازين. ما يختلف هو طريقة التعارف فقط: على الشبكة نفسها يظهر الجهاز الآخر وحده تحت «الأجهزة القريبة»، أما عبر شبكتين فتُنشئ رمز اقتران للمتصفح من صفحة النقل بين الشبكات وتنضم إليه من المتصفح الآخر. أما ما يحصل عليه الطرفان بعد ذلك فهو نفسه: لا تعرض بطاقة الطرف الآخر سوى إجراء واحد، «فتح مساحة العمل»، ومربع الكتابة داخل مساحة العمل تلك، إلى جانب مرفقات الملفات والمجلدات، على الاتصال المشفَّر الواحد نفسه. وعبر الشبكات يحمل هذا الاتصالَ مُرحِّلُ TURN مشفَّرٌ لا يمرّر سوى النص المشفَّر، وله كذلك حدٌّ زمني تنبّه إليه مساحة العمل قبل بلوغه. والاستثناء الوحيد طرفٌ ليس متصفحًا حديثًا — متصفح أقدم أو تطبيق أصلي أو CLI: فيبقى لديه المسار السابق حيث تُستخدم الملفات والرسائل واحدة تلو الأخرى.",
  prereqLabel: "قبل أن تبدأ",
  prereqs: [
    "أن يكون الجهازان متصلين في الوقت نفسه، والصفحة مفتوحة في متصفح على كليهما. لا يوجد صندوق وارد: فالرسالة لا توجد إلا داخل جلسة يُبقيها الطرفان مفتوحة.",
    "وسيلة نقل واحدة يختارها الطرفان معًا. على نفس الشبكة لا يلزم شيء؛ وبين شبكتين مختلفتين يلزم رمز اقتران للمتصفح، يسجّل الطرف المُنشِئ الدخول لأجله، وعمره خمس دقائق.",
    "نص يتّسع لرسالة واحدة، أي 65,536 بايت UTF-8. يتزايد العدّاد وأنت تكتب، ويُنبّهك إلى إرساله كملف عند تجاوز ذلك.",
    "مكان لما يصل. تبقى الرسالة المستلمة في الجلسة المفتوحة، فانسخ ما تريد الاحتفاظ به قبل انتهاء الجلسة أو إعادة تحميل الصفحة.",
  ],
  browserSteps: [
    {
      text: "افتح صفحة النقل على الجهازين — صفحة نفس الشبكة تجد أحدهما الآخر تلقائيًا، أما صفحة النقل الفوري فهي موضع رمز الاقتران عندما يكونان على شبكتين مختلفتين.",
      code: ["https://relayium.com/"],
    },
    {
      text: "اضغط «فتح مساحة العمل» على بطاقة الجهاز الآخر، ثم اكتب في مربع الكتابة الذي تعرضه مساحة العمل. وهو الإجراء الواحد نفسه في الحالتين: تحت «الأجهزة القريبة» على الشبكة نفسها، وعلى بطاقة الطرف الآخر داخل غرفة رمز الاقتران عبر الشبكات. افتراضيًا تُفتح الجلسة مباشرةً على مربع الكتابة في الطرفين، والاتصال مُشفَّر في الحالتين.",
    },
    {
      text: "اكتب النص أو الصقه. يبيّن العدّاد أسفل المربع ما استُهلك من ميزانية الرسالة الواحدة، بالبايت لا بالحروف، لأن الرمز التعبيري أو الحرف الصيني يستهلك عدة بايتات.",
      code: ["1,024 / 65,536 بايت"],
    },
    {
      text: "أرسِل باستخدام ⌘/Ctrl+Enter — فـ Enter وحده يُنشئ سطرًا جديدًا، وهذا بالضبط ما يجعل مقتطفًا متعدد الأسطر يُلصق ويُرسَل في خطوة واحدة. والتلميح أسفل المربع يذكر هذا التوزيع.",
      code: ["Enter لسطر جديد · ⌘/Ctrl+Enter للإرسال"],
    },
    {
      text: "أبقِ الجلسة مفتوحة لإرسال عدة رسائل في الاتجاهين، واضغط «نسخ» على كل ما تريد الاحتفاظ به. وإن أردت مقارنة رمز التحقق (SAS) أولًا، فعّل «التحقّق المتقدّم» قبل فتح الجلسة: فهو يضيف الرمز وخطوة قبول صريحة، لا التشفير.",
    },
  ],
  successLabel: "كيف تبدو جلسة ناجحة",
  successBody: [
    "يعرض الطرفان أن الجلسة مفتوحة، وتظهر رسالتك في سجل الجهاز الآخر، ويعود عدّاد البايتات إلى الصفر للرسالة التالية.",
    "وهذا السجل هو النسخة الوحيدة التي لـ Relayium علاقة بها: فهو يعيش في الصفحتين المفتوحتين، ويزول عند إعادة التحميل أو انتهاء الجلسة، و«نسخ» يضع النص في حافظة ذلك الجهاز حيث تستطيع تطبيقات أخرى قراءته.",
  ],
  successCode: ["الجلسة مفتوحة\n1,024 / 65,536 بايت"],
  fixHeading: "عندما لا تنفذ الرسالة",
  fixBody:
    "يستخدم النص الاتصال نفسه الذي يستخدمه نقل الملفات، فمعظم الإخفاقات تتعلق بالاتصال لا بالرسالة. والاستثناءان محدَّدان ويظهر كلاهما على الشاشة: رسالة تتجاوز حدّ الحجم، وجلسة أُغلقت لأن الرسائل أُرسلت بكثافة مفرطة.",
  fixLabel: "العَرَض والفحص والحل",
  fixes: [
    {
      symptom: "لا يظهر الجهاز الآخر أبدًا، فلا توجد بطاقة تُفتح منها جلسة رسائل.",
      code: ["https://relayium.com/   # قارن عنوان IP العام في شريط الحالة على الجهازين"],
      fix: "يجمع اكتشاف نفس الشبكة الأجهزة بحسب عنوان IP العام الذي تتصل منه، فعنوانان مختلفان يعنيان غرفتين — اقطع VPN أو الترحيل الخاص في iCloud، أو انضم إلى شبكة Wi-Fi نفسها. وإن كانا فعلًا على شبكتين مختلفتين، فاستخدم رمز اقتران على https://relayium.com/cross-network.",
    },
    {
      symptom: "يرفض مربع الكتابة النص ويقول إن الرسالة طويلة جدًا.",
      code: ["1,024 / 65,536 بايت   # العدّاد يحسب بايتات UTF-8 لا الحروف"],
      fix: "تتّسع الرسالة الواحدة لـ 65,536 بايت UTF-8، والنص غير اللاتيني يستهلك من بايتين إلى أربعة لكل حرف، فاللصق العربي الطويل أو المزدحم بالرموز التعبيرية يصل إلى حدّ البايتات قبل ما يوحي به عدد الحروف بمسافة كبيرة. جزّئه، أو أرسِله كملف — وهو ما يعرضه مربع الكتابة تمامًا.",
    },
    {
      symptom: "أغلقت الجلسة نفسها وعزت ذلك إلى كثرة الرسائل.",
      code: ["https://relayium.com/   # سطر الجلسة يذكر أنها انتهت لا أنها فشلت"],
      fix: "تُغلق حمايةُ الطوفان الجلسةَ عندما يرسل أحد الطرفين رسائل تتجاوز بكثير ما يكتبه إنسان، وهو ما يفعله نص برمجي أو مفتاح ملتصق. أعِد فتح الجلسة بالطريقة نفسها التي فتحتها بها — «فتح مساحة العمل» على بطاقة الجهاز الآخر، على الشبكة نفسها كما في غرفة رمز الاقتران — وأرسِل ما بقي في رسائل أقل وأطول.",
    },
    {
      symptom: "كان كل شيء يعمل، وبعد إعادة التحميل صار الحوار فارغًا.",
      code: ["https://relayium.com/   # إعادة تحميل هذه الصفحة تبدأ جلسة جديدة بلا سجل"],
      fix: "هذا تصميم لا خلل: لا يحفظ Relayium سجلًا على الخادم، فلا شيء يُستعاد ولا نسخة خادم تُطلَب. انسخ ما يهمّك إلى ملاحظة قبل مغادرة الجلسة — فعمر السجل لا يزيد على عمر الصفحة المفتوحة.",
    },
    {
      symptom: "لا يستطيع المتصفح وسطر الأوامر الانضمام برمز أحدهما الآخر.",
      code: ["relayium text 483920   # رمز CLI يقرن CLI بـ CLI فقط"],
      fix: "تستخدم جلسات النص في المتصفح وسطر الأوامر وسائل نقل ومصافحات اقتران مختلفة، فرمزٌ من ست خانات يصدره أحدهما لا معنى له عند الآخر. استخدم متصفحين، أو سطر الأوامر في الطرفين — فـ relayium text يطبع الأمر الذي ينبغي أن يشغّله الجهاز الثاني تمامًا.",
    },
  ],
  cliHeading: "سطر الأوامر: أصدر الرمز على جهاز وانضم إليه من الآخر",
  cliBody: [
    "شغّل relayium text بلا رمز على أحد الجهازين. سيصدر رمزًا من ستة أرقام باستخدام حسابك، ويطبع الأمر الذي يشغّله الجهاز الآخر تمامًا، ثم يبقى في الجلسة بانتظاره. لا ملف مؤقت ولا عملية إضافية يجب إيقافها.",
    "شغّل relayium text بذلك الرمز على الجهاز الآخر. في الوضع التفاعلي كل سطر رسالة، ولا يتوقّف التشغيل لمقارنة أي رمز ما لم تطلب ذلك. أرسل النص متعدد الأسطر أو الدقيق عبر pipe كرسالة واحدة؛ ولا يحتاج ذلك إلى أي خيار إضافي.",
  ],
  cliNotes: [
    "رمز CLI صالح لخمس دقائق ويربط CLI بـ CLI فقط؛ لا يتوافق المتصفح مع CLI.",
    "الجهاز الذي يصدر الرمز وحده يحتاج حسابًا مسجل الدخول؛ أما الجهاز الذي ينضم بالرمز المطبوع فلا يحتاج إلى تسجيل الدخول.",
    "‏--verify يفعّل مقارنة SAS ويحتاج طرفية للإجابة، لذلك يُرفض التشغيل عبر pipe مع --verify بدل المتابعة وكأن التأكيد قد تم. ولا يزال --yes مقبولًا ويعني «لا تسأل أبدًا»، وله الأولوية على --verify.",
  ],
  boundariesHeading: "حدود نقل النصوص",
  boundariesBody:
    "يظل المحتوى نص UTF-8 عاديًا مع المسافات وعلامات الجدولة والأسطر الفارغة وفواصل الأسطر. لا ينفذه Relayium ولا يعرض Markdown ولا يحوله إلى روابط أو معاينات.",
  boundaries: [
    "يجب أن يكون الجهازان متصلين معًا. لا يوجد تسليم دون اتصال أو صندوق وارد أو جهات اتصال أو سجل محادثة متزامن.",
    "السجل محلي للجلسة المفتوحة ويختفي عند انتهائها أو تحديث الصفحة. لا يخزن الخادم نص الرسالة.",
    "الحد الأقصى للرسالة 65,536 بايت UTF-8. أرسل المحتوى الأكبر كملف.",
  ],
  faqHeading: "الأسئلة الشائعة",
  faq: [
    { q: "هل يستطيع Relayium قراءة رسائلي أو استعادتها؟", a: "لا. المحتوى مشفّر بين الجهازين، ولا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم. يمكن لأي طرف الاحتفاظ بالنص المستلم، لكن بعد انتهاء الجلسة لا تملك Relayium نسخة خادم لاستعادتها." },
    { q: "هل يمكن استخدام المتصفح في طرف وCLI في الآخر؟", a: "لا. النقل والاقتران مختلفان. استخدم متصفحين أو عميلَي CLI." },
  ],
  ctaText: "افتح Relayium على جهازين متصلين وانقل مباشرة ما كنت سترسله إلى نفسك.",
  ctaButton: "إرسال نص الآن",
  relatedHeading: "تابع القراءة",
});

const es = article({
  title: "Enviar texto, enlaces y comandos entre dispositivos",
  description:
    "Transfiere texto, enlaces, comandos y código multilínea con Relayium: cifrado de extremo a extremo y solo mientras ambos están en línea; los servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor, pero cualquiera de los extremos puede conservar el texto recibido.",
  updatedLabel: "Última actualización",
  lead: [
    "Relayium también mueve contenido de portapapeles: una URL del teléfono, un comando para otro ordenador o código multilínea. Los mensajes están cifrados de extremo a extremo; los servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor, pero cualquiera de los extremos puede copiar o conservar el texto recibido.",
    "El navegador y la CLI admiten texto, pero usan transportes separados y no pueden unirse con el código del otro. Usa el mismo método en ambos extremos.",
  ],
  browserHeading: "Navegador: enviar un mensaje a un dispositivo en línea",
  browserBody:
    "Abre relayium.com en ambos dispositivos. Lo único que cambia es cómo se encuentran: en la misma red el otro dispositivo aparece solo bajo «Dispositivos cercanos»; entre redes creas un código de emparejamiento de navegador en la página entre redes y te unes desde el otro navegador. Lo que obtienen los dos después es lo mismo: la tarjeta del par ofrece una única acción, «Abrir espacio de trabajo», y el editor vive dentro de ese espacio de trabajo, junto a los adjuntos de archivo y carpeta, sobre la misma conexión cifrada. Entre redes esa conexión la transporta un retransmisor TURN cifrado que solo reenvía texto cifrado, y está sujeta a un límite de tiempo del que el espacio de trabajo avisa antes de alcanzarlo. La única excepción es un par que no es un navegador actualizado — uno antiguo, una app nativa, el CLI: conserva el flujo anterior, donde los archivos y los mensajes se usan de uno en uno.",
  prereqLabel: "Antes de empezar",
  prereqs: [
    "Los dos dispositivos en línea a la vez, con la página abierta en un navegador. No hay bandeja de entrada: un mensaje solo existe dentro de una sesión que ambos lados mantienen abierta.",
    "Un transporte elegido para los dos extremos. En la misma red no hace falta nada; entre redes distintas hace falta un código de emparejamiento de navegador, que crea un lado con sesión iniciada y que vive cinco minutos.",
    "Texto que quepa en un mensaje: 65.536 bytes UTF-8. El contador del editor sube mientras escribes y te indica que lo envíes como archivo en cuanto te pasas.",
    "Un sitio donde poner lo que llega. El mensaje recibido se queda en la sesión abierta, así que copia lo que quieras conservar antes de que la sesión termine o la página se recargue.",
  ],
  browserSteps: [
    {
      text: "Abre la página de transferencia en los dos dispositivos: la de la misma red los encuentra por ti, y la página en tiempo real es donde se usa un código de emparejamiento si están en redes distintas.",
      code: ["https://relayium.com/"],
    },
    {
      text: "Pulsa «Abrir espacio de trabajo» en la tarjeta del otro dispositivo y escribe en el editor que ese espacio de trabajo pone en pantalla. Es la misma acción única en ambos casos: bajo «Dispositivos cercanos» en la misma red, y en la tarjeta del par dentro de la sala de código de emparejamiento entre redes. De forma predeterminada la sesión se abre directamente en el editor en ambos lados; la conexión está cifrada en cualquier caso.",
    },
    {
      text: "Escribe o pega el texto. El contador bajo el cuadro muestra cuánto del presupuesto de un mensaje has gastado, en bytes y no en caracteres, porque un emoji o un carácter CJK cuesta varios.",
      code: ["1.024 / 65.536 bytes"],
    },
    {
      text: "Envía con ⌘/Ctrl+Enter: Enter a secas inserta un salto de línea, que es lo que permite pegar y enviar un fragmento multilínea de una vez. La indicación bajo el cuadro recuerda esa asignación.",
      code: ["Enter para una nueva línea · ⌘/Ctrl+Enter para enviar"],
    },
    {
      text: "Deja la sesión abierta para enviar varios mensajes en ambos sentidos y pulsa «Copiar» en lo que quieras conservar. Para comparar antes un código de verificación (SAS), activa «Verificación avanzada» antes de abrir la sesión: añade el código y un paso de aceptación explícito, no el cifrado.",
    },
  ],
  successLabel: "Qué se ve cuando la sesión funciona",
  successBody: [
    "Los dos lados muestran la sesión como abierta, tu mensaje aparece en el historial del otro dispositivo y el contador de bytes vuelve a cero para el siguiente.",
    "Ese historial es la única copia en la que Relayium participa: vive en las dos páginas abiertas, así que desaparece al recargar o al terminar la sesión, y «Copiar» pone el texto en el portapapeles de ese dispositivo, donde otras apps pueden leerlo.",
  ],
  successCode: ["Sesión abierta\n1.024 / 65.536 bytes"],
  fixHeading: "Cuando un mensaje no sale",
  fixBody:
    "El texto usa la misma conexión que una transferencia de archivos, así que la mayoría de los fallos son de la conexión y no del mensaje. Las dos excepciones son concretas y las dos se ven en pantalla: un mensaje por encima del límite de tamaño, y una sesión cerrada por enviar demasiados de golpe.",
  fixLabel: "Síntoma, comprobación, solución",
  fixes: [
    {
      symptom: "El otro dispositivo no aparece nunca, así que no hay tarjeta desde la que abrir una sesión de mensajes.",
      code: ["https://relayium.com/   # compara la IP pública de la línea de estado en los dos dispositivos"],
      fix: "El descubrimiento en la misma red agrupa los dispositivos por la IP pública desde la que se conectan, así que dos direcciones distintas son dos salas: corta una VPN o iCloud Private Relay, o conéctate a la misma Wi-Fi. Si de verdad están en redes distintas, usa un código de emparejamiento en https://relayium.com/cross-network.",
    },
    {
      symptom: "El editor rechaza el texto y dice que el mensaje es demasiado largo.",
      code: ["1.024 / 65.536 bytes   # el contador cuenta bytes UTF-8, no caracteres"],
      fix: "Un mensaje admite 65.536 bytes UTF-8, y el texto no latino gasta de dos a cuatro bytes por carácter, así que un pegado largo en chino o cargado de emojis llega a ese límite de bytes mucho antes de lo que el número de caracteres sugiere. Divídelo, o envíalo como archivo: eso es justo lo que ofrece el editor.",
    },
    {
      symptom: "La sesión se cerró sola y culpó al exceso de mensajes.",
      code: ["https://relayium.com/   # la línea de sesión informa de terminada en vez de fallida"],
      fix: "Una protección contra avalanchas cierra la sesión cuando un lado envía muchos más mensajes de los que teclea una persona, algo que consigue un script o una tecla atascada. Vuelve a abrir la sesión como la abriste — «Abrir espacio de trabajo» en la tarjeta del otro dispositivo, tanto en la misma red como en una sala de código de emparejamiento — y manda el resto en menos mensajes, más largos.",
    },
    {
      symptom: "Todo iba bien y, tras una recarga, la conversación está vacía.",
      code: ["https://relayium.com/   # recargar esta página abre una sesión nueva sin historial"],
      fix: "Es el diseño y no un error: Relayium no guarda historial del lado del servidor, así que no hay nada que restaurar ni copia de servidor que reclamar. Copia lo importante en una nota antes de dejar la sesión, porque el historial dura lo que dure la página abierta.",
    },
    {
      symptom: "Un navegador y la CLI no pueden unirse con el código del otro.",
      code: ["relayium text 483920   # un código de la CLI solo empareja CLI con CLI"],
      fix: "Las sesiones de texto del navegador y de la CLI usan transportes y emparejamientos distintos, así que un código de seis dígitos creado por uno no significa nada para el otro. Usa dos navegadores, o la CLI en los dos extremos: relayium text imprime exactamente el comando que debe ejecutar la segunda máquina.",
    },
  ],
  cliHeading: "CLI: emite el código en un equipo y únete desde el otro",
  cliBody: [
    "Ejecuta relayium text sin código en un equipo. Emite un código de emparejamiento de seis dígitos con tu cuenta, imprime exactamente el comando que debe ejecutar el otro equipo y se queda en la sesión esperándolo. Sin archivo temporal y sin ningún proceso extra que detener.",
    "Después ejecuta relayium text con ese código en el otro equipo. El modo interactivo envía una línea por mensaje y no se detiene a comparar ningún código salvo que lo pidas. Para texto multilínea o exacto, usa una tubería como un solo mensaje: no hace falta ninguna opción adicional.",
  ],
  cliNotes: [
    "Los códigos CLI duran cinco minutos y solo conectan CLI con CLI; navegador y CLI no son interoperables.",
    "Solo el equipo que emite el código exige una cuenta conectada. El equipo que se une con el código impreso no necesita iniciar sesión.",
    "--verify activa la comparación del SAS y necesita un terminal para responder, así que una ejecución con tubería y --verify se rechaza en lugar de continuar como si se hubiera confirmado. --yes se sigue aceptando, sigue significando «nunca preguntar» y tiene prioridad sobre --verify.",
  ],
  boundariesHeading: "Qué es —y qué no es— la transferencia de texto",
  boundariesBody:
    "El contenido sigue siendo texto plano UTF-8, incluidos espacios, tabulaciones, líneas vacías y saltos. Relayium no lo ejecuta, no muestra Markdown, no enlaza ni crea vistas previas.",
  boundaries: [
    "Ambos dispositivos deben estar en línea a la vez. No hay entrega sin conexión, bandeja de entrada, contactos ni historial sincronizado.",
    "El historial es local a la sesión abierta y desaparece al terminar o recargar. El servidor nunca almacena el cuerpo.",
    "Cada mensaje admite hasta 65.536 bytes UTF-8. Envía el contenido mayor como archivo.",
  ],
  faqHeading: "Preguntas frecuentes",
  faq: [
    { q: "¿Puede Relayium leer o recuperar mis mensajes?", a: "No. El contenido está cifrado entre los dispositivos, y los servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor. Cualquiera de los extremos puede conservar el texto recibido; al terminar la sesión Relayium no tiene una copia de servidor que recuperar." },
    { q: "¿Puedo usar navegador en un extremo y CLI en el otro?", a: "No. El transporte y el emparejamiento son distintos. Usa dos navegadores o dos clientes CLI." },
  ],
  ctaText: "Abre Relayium en dos dispositivos en línea y mueve directamente lo próximo que te enviarías a ti mismo.",
  ctaButton: "Enviar texto ahora",
  relatedHeading: "Sigue leyendo",
});

const pt = article({
  title: "Enviar texto, links e comandos entre dispositivos",
  description:
    "Transfira texto, links, comandos e código multilinha com o Relayium — criptografado de ponta a ponta e apenas online; os servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor, mas qualquer ponta pode conservar o texto recebido.",
  updatedLabel: "Última atualização",
  lead: [
    "O Relayium também move conteúdo de área de transferência: uma URL do celular, um comando para outro computador ou código multilinha. As mensagens são criptografadas de ponta a ponta; os servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor, mas qualquer ponta pode copiar ou conservar o texto recebido.",
    "O navegador e a CLI aceitam texto, mas usam transportes separados e não entram com o código um do outro. Use o mesmo método nas duas pontas.",
  ],
  browserHeading: "Navegador: enviar mensagem a um dispositivo online",
  browserBody:
    "Abra relayium.com nos dois dispositivos. Só muda como eles se encontram: na mesma rede o outro dispositivo aparece sozinho em “Dispositivos próximos”; entre redes você cria um código de emparelhamento de navegador na página entre redes e entra por ele no outro navegador. O que os dois recebem depois é o mesmo: o cartão do par oferece uma única ação, “Abrir área de trabalho”, e o editor fica dentro dessa área de trabalho, ao lado dos anexos de arquivo e de pasta, na mesma conexão criptografada. Entre redes essa conexão é carregada por um retransmissor TURN criptografado que só encaminha texto cifrado, e ela corre sob um limite de tempo que a área de trabalho avisa antes de ser atingido. A única exceção é um par que não é um navegador atualizado — um antigo, um app nativo, a CLI: ele mantém o fluxo anterior, em que arquivos e mensagens são usados um de cada vez.",
  prereqLabel: "Antes de começar",
  prereqs: [
    "Os dois dispositivos online ao mesmo tempo, com a página aberta em um navegador. Não existe caixa de entrada: uma mensagem só existe dentro de uma sessão que os dois lados mantêm aberta.",
    "Um transporte escolhido para as duas pontas. Na mesma rede não é preciso nada; entre redes diferentes é preciso um código de emparelhamento de navegador, criado por um lado logado e válido por cinco minutos.",
    "Texto que caiba em uma mensagem: 65.536 bytes UTF-8. O contador do editor sobe enquanto você digita e avisa para enviar como arquivo quando passa disso.",
    "Um lugar para o que chega. A mensagem recebida fica na sessão aberta, então copie o que quiser guardar antes de a sessão terminar ou a página recarregar.",
  ],
  browserSteps: [
    {
      text: "Abra a página de transferência nos dois dispositivos: a da mesma rede encontra um ao outro para você, e a página em tempo real é onde um código de emparelhamento entra quando eles estão em redes diferentes.",
      code: ["https://relayium.com/"],
    },
    {
      text: "Aperte “Abrir área de trabalho” no cartão do outro dispositivo e escreva no editor que essa área de trabalho coloca na tela. É a mesma ação única nos dois casos: em “Dispositivos próximos” na mesma rede, e no cartão do par dentro da sala de código de emparelhamento entre redes. Por padrão a sessão abre direto no editor dos dois lados; a conexão é criptografada de qualquer forma.",
    },
    {
      text: "Digite ou cole o texto. O contador abaixo da caixa mostra quanto do orçamento de uma mensagem já foi usado, em bytes e não em caracteres, porque um emoji ou um caractere CJK custa vários.",
      code: ["1.024 / 65.536 bytes"],
    },
    {
      text: "Envie com ⌘/Ctrl+Enter: o Enter sozinho insere uma quebra de linha, e é isso que permite colar e enviar um trecho multilinha de uma só vez. A dica abaixo da caixa informa esse mapeamento.",
      code: ["Enter para uma nova linha · ⌘/Ctrl+Enter para enviar"],
    },
    {
      text: "Deixe a sessão aberta para enviar várias mensagens nos dois sentidos e clique em “Copiar” no que quiser guardar. Para comparar antes um código de verificação (SAS), ligue a “Verificação avançada” antes de abrir a sessão: ela acrescenta o código e uma aceitação explícita, não a criptografia.",
    },
  ],
  successLabel: "Como é uma sessão que funciona",
  successBody: [
    "Os dois lados mostram a sessão como aberta, sua mensagem aparece no histórico do outro dispositivo, e o contador de bytes volta a zero para a próxima.",
    "Esse histórico é a única cópia de que o Relayium participa: ele vive nas duas páginas abertas, então desaparece ao recarregar ou quando a sessão termina, e “Copiar” coloca o texto na área de transferência daquele dispositivo, onde outros aplicativos podem ler.",
  ],
  successCode: ["Sessão aberta\n1.024 / 65.536 bytes"],
  fixHeading: "Quando uma mensagem não vai",
  fixBody:
    "O texto usa a mesma conexão de uma transferência de arquivos, então a maioria das falhas é da conexão e não da mensagem. As duas exceções são específicas e as duas aparecem na tela: uma mensagem acima do limite de tamanho, e uma sessão fechada por enviar demais de uma vez.",
  fixLabel: "Sintoma, verificação, correção",
  fixes: [
    {
      symptom: "O outro dispositivo nunca aparece, então não há cartão para abrir uma sessão de mensagens.",
      code: ["https://relayium.com/   # compare o IP público da linha de status nos dois dispositivos"],
      fix: "A descoberta na mesma rede agrupa dispositivos pelo IP público de onde se conectam, então dois endereços diferentes são duas salas: desligue uma VPN ou o iCloud Private Relay, ou entre na mesma Wi-Fi. Se eles estiverem realmente em redes diferentes, use um código de emparelhamento em https://relayium.com/cross-network.",
    },
    {
      symptom: "O editor recusa o texto e diz que a mensagem é longa demais.",
      code: ["1.024 / 65.536 bytes   # o contador conta bytes UTF-8, não caracteres"],
      fix: "Uma mensagem aceita 65.536 bytes UTF-8, e texto não latino gasta de dois a quatro bytes por caractere, então uma colagem longa em chinês ou cheia de emojis chega a esse limite de bytes muito antes do que a contagem de caracteres sugere. Divida, ou envie como arquivo — é exatamente o que o editor oferece.",
    },
    {
      symptom: "A sessão se fechou sozinha culpando o excesso de mensagens.",
      code: ["https://relayium.com/   # a linha da sessão informa encerrada em vez de falhou"],
      fix: "Uma proteção contra enxurrada fecha a sessão quando um lado envia muito mais mensagens do que uma pessoa digita, o que um script ou uma tecla presa consegue. Reabra a sessão do mesmo jeito que a abriu — “Abrir área de trabalho” no cartão do outro dispositivo, tanto na mesma rede quanto em uma sala de código de emparelhamento — e mande o resto em menos mensagens, maiores.",
    },
    {
      symptom: "Tudo funcionava e, depois de recarregar, a conversa está vazia.",
      code: ["https://relayium.com/   # recarregar esta página inicia uma sessão nova sem histórico"],
      fix: "Isso é o projeto e não um defeito: o Relayium não guarda histórico no servidor, então não há o que restaurar nem cópia no servidor para requisitar. Copie o que importa para uma nota antes de sair da sessão, porque o histórico dura só enquanto a página fica aberta.",
    },
    {
      symptom: "Um navegador e a CLI não conseguem entrar com o código um do outro.",
      code: ["relayium text 483920   # um código da CLI só pareia CLI com CLI"],
      fix: "As sessões de texto do navegador e da CLI usam transportes e handshakes de emparelhamento diferentes, então um código de seis dígitos criado por um não significa nada para o outro. Use dois navegadores, ou a CLI nas duas pontas: o relayium text imprime exatamente o comando que a segunda máquina deve executar.",
    },
  ],
  cliHeading: "CLI: emita o código em uma máquina e entre pela outra",
  cliBody: [
    "Execute relayium text sem código em uma das máquinas. Ele emite um código de emparelhamento de seis dígitos com a sua conta, imprime exatamente o comando que a outra máquina deve executar e permanece na sessão esperando por ela. Sem arquivo temporário e sem nenhum processo extra para parar.",
    "Depois execute relayium text com esse código na outra máquina. O modo interativo envia uma linha por mensagem e não para para comparar nenhum código, a menos que você peça. Para texto multilinha ou exato, use um pipe como uma única mensagem: nenhuma opção extra é necessária.",
  ],
  cliNotes: [
    "Códigos CLI duram cinco minutos e conectam apenas CLI com CLI; navegador e CLI não são interoperáveis.",
    "Somente a máquina que emite o código exige uma conta conectada. A máquina que entra com o código impresso não precisa fazer login.",
    "--verify ativa a comparação do SAS e precisa de um terminal para responder, então uma execução com pipe e --verify é recusada em vez de continuar como se tivesse sido confirmada. --yes continua aceito, ainda significa “nunca perguntar” e tem prioridade sobre --verify.",
  ],
  boundariesHeading: "O que a transferência de texto é — e não é",
  boundariesBody:
    "O conteúdo permanece texto simples UTF-8, com espaços, tabulações, linhas vazias e quebras. O Relayium não executa, renderiza Markdown, cria links nem prévias.",
  boundaries: [
    "Os dois dispositivos precisam estar online juntos. Não há entrega offline, caixa de entrada, contatos ou histórico sincronizado.",
    "O histórico é local à sessão aberta e desaparece ao terminar ou recarregar. O servidor nunca armazena o corpo.",
    "Cada mensagem aceita até 65.536 bytes UTF-8. Envie conteúdo maior como arquivo.",
  ],
  faqHeading: "Perguntas frequentes",
  faq: [
    { q: "O Relayium pode ler ou recuperar minhas mensagens?", a: "Não. O conteúdo é criptografado entre os dispositivos, e os servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor. Qualquer ponta pode conservar o texto recebido; ao terminar a sessão o Relayium não tem uma cópia no servidor para recuperar." },
    { q: "Posso usar navegador em uma ponta e CLI na outra?", a: "Não. Transporte e pareamento são diferentes. Use dois navegadores ou dois clientes CLI." },
  ],
  ctaText: "Abra o Relayium em dois dispositivos online e mova diretamente o próximo conteúdo que enviaria a si mesmo.",
  ctaButton: "Enviar texto agora",
  relatedHeading: "Continue lendo",
});

export default {
  slug: "how-to/send-text-between-devices",
  published: "2026-07-30",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
