// web/scripts/pages/content/articles/cli-cloud-async.mjs
// Guide: async cloud transfer with the Relayium CLI — relayium login / up / down.
// English is the master; every other locale follows the same structure and facts.
// Commands stay English in every language; the # comments around them are translated.

const en = {
  title: "Push files to the cloud, pull them on another computer",
  description:
    "Async file transfer through your Relayium account: upload from one machine with relayium up, download on another with relayium down whenever it's convenient — end-to-end encrypted, and only uploading needs an account.",
  updatedLabel: "Last updated",
  lead: [
    "Sometimes the two computers are never awake at the same time. You want to drop a file from your work laptop tonight and grab it from your home desktop tomorrow, with nobody waiting on a live connection. relayium up and relayium down do exactly that: up encrypts and uploads to your account, and down fetches and decrypts it later on any machine — no peer-to-peer handshake, no server you both ssh into.",
    "This is the main part of the CLI that uses your Relayium account, alongside send, which needs it to mint a pairing code. Binding is optional for the rest: push/pull, daemon-direct and sync keep working with no login, and so does receive. Downloading needs no account at all, just the link.",
  ],
  sections: [
    {
      heading: "When to reach for it",
      body: ["Pick the mode by whether the far end is online and how the two machines reach each other:"],
      bullets: [
        "up / down (this guide) — the two machines are never online together. You upload now; you (or another machine) download later. Goes through your account.",
        "send / receive — both ends are online right now and want a direct peer-to-peer transfer over a one-time code.",
        "push / pull — you can already ssh into the far machine.",
        "up and send are the two that need relayium login — up to store the file under your account, send only when it has to mint a pairing code (handed one, it needs nothing). down, receive, push/pull, daemon-direct and sync need no account.",
      ],
    },
    {
      heading: "Before you start",
      body: [
        "Two one-time things before your first up — install the CLI, and have an account. Already have both? Skip ahead.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "What you need",
        items: [
          "Install the CLI so the relayium command exists. The command below drops a prebuilt binary on your PATH (macOS and Linux; on Windows, grab the .zip from the releases page); relayium --version confirms it, and relayium.com/cli lists every install option. Skip this and relayium login just prints 'command not found'.",
          "Have a free Relayium account. The browser step approves the login against your account, so you need one before you can approve — sign in at relayium.com first, or create one there if you haven't. Only uploading needs the account; downloading never does.",
          "A way to move one link to the other machine — a note app, a chat window, a password manager. Anyone holding the link can download the file, so treat it like a password.",
        ],
      },
    },
    {
      heading: "Bind this machine to your account (once)",
      body: [
        "up needs to know whose account to store under, so sign in once per machine. It's a browser-approved device login — nothing is typed into the terminal except the code you confirm:",
      ],
      code: ["relayium login"],
      bullets: [
        "The CLI prints a short code and a URL (relayium.com/device). Open it in the browser where you're signed in to relayium.com (sign in there first if you aren't), enter the code, and approve — this machine is now bound.",
        "The login is saved under ~/.config/relayium/, so you only do it once per machine. relayium whoami shows who you're bound to; relayium logout clears it.",
        "To revoke a machine later, delete its device from your account's devices page in the browser.",
      ],
    },
    {
      heading: "Upload from the first computer",
      body: ["up walks the files you give it, encrypts them locally, uploads the ciphertext, and prints a claim link:"],
      steps: [
        {
          text: "Check this machine is still bound to your account. It prints the account and the server it is bound to; if it says you are not logged in, do the login step above first.",
          code: ["relayium whoami"],
        },
        {
          text: "Upload the file. up encrypts it locally, sends only ciphertext, and prints the claim link on stdout.",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "Add a retention flag if the 24-hour default isn't what you want. Your plan caps how long the server will actually keep it.",
          code: [
            `# choose how long it lives (default: 24 hours):
relayium up ./report.pdf --burn              # deleted after one download
relayium up ./report.pdf --ttl 7d            # kept 7 days (your plan sets the cap)
relayium up ./report.pdf --max-downloads 5   # allow 5 downloads, then gone`,
          ],
        },
        {
          text: "Move the link to where the second machine can read it. Only the link goes to stdout, so a pipe stays clean.",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "What a successful upload looks like",
        body: [
          "A progress bar runs on stderr while it uploads, then clears. The link lands on stdout on a line of its own, and the human hint — plus any retention note — follows on stderr.",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "Retention: --burn removes the file after a single download; --ttl <duration> keeps it for a fixed time; --max-downloads <n> allows a fixed number of downloads. Give none of them and the link lives 24 hours, the default when --ttl is absent.",
        "--ttl takes a duration with a unit — 30m, 12h, 7d, 2w — or a plain number of seconds, so --ttl 3600 and --ttl 1h are the same request. Your plan sets the ceiling: 1 day on Free, 3 days on Plus, 7 days on Pro, 14 days on Max. Ask for longer than your ceiling and the server silently keeps it for the ceiling instead — up prints a note afterwards telling you how long it actually kept it.",
      ],
    },
    {
      heading: "Download on the second computer",
      body: [
        "On the other machine, hand the link to down. No login, no setup — the key that decrypts the file is inside the link, so down needs nothing from your account:",
      ],
      steps: [
        {
          text: "Get the link onto the second machine, however suits you. Nothing has to be installed or logged in there beyond the CLI itself.",
        },
        {
          text: "Hand it to down inside single quotes, with the directory the files should land in.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "Leave the directory off to land in the current one.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "What a successful download looks like",
        body: [
          "Every file it wrote is listed on stdout, one per line, and the count and destination are confirmed on stderr.",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "Your share link",
        linkToken: "your link",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "Save to (paste your pwd output)",
        destToken: "target directory",
        destPlaceholder: "/home/you/downloads",
        copy: "Copy command",
        copied: "Copied",
      },
      bullets: [
        "If the file was set to burn, has hit its download limit, or has expired, the link is spent and down reports that it's gone.",
        "A dropped or stalled connection is retried inside the same run: down reconnects up to five attempts and continues with an HTTP Range request from the last complete encrypted frame, so a large download does not start over because a proxy reset it. Against a server that ignores Range — an old one, or a burn/limited file — it restarts the file within that same run instead.",
        "That recovery does not outlive the command. When the attempts are spent, down deletes what it had written rather than leaving a truncated file that looks complete, and running down again begins from the start. This is not the across-runs resume that relayium sync has.",
      ],
    },
    {
      heading: "Works with the website too",
      body: ["The link is the same one the website uses, so the CLI and the browser interoperate freely:"],
      bullets: [
        "A link from relayium up opens in a browser — hand it to someone who doesn't have the CLI and they download from the web.",
        "A share link created on relayium.com can be fetched with relayium down on another machine.",
      ],
    },
    {
      heading: "What the server can and can't see",
      body: ["Cloud transfers stay end-to-end encrypted:"],
      bullets: [
        "Your file is encrypted on your machine before it's uploaded. The decryption key lives only in the link's #k= fragment and is never sent to the server — Relayium stores ciphertext it cannot read, including the file names.",
        "That also means the link is the only way back to the file: lose it and the file is unrecoverable, by you or by us.",
      ],
    },
    {
      heading: "When a link doesn't work",
      body: [
        "Four failures cover almost every unsuccessful up or down, and none of them needs guessing — the state that decides each one is printed by a command, or visible in the command you typed.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "up refuses with \"run relayium login first\".",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Uploading stores the file under your account, so this machine needs credentials. Run relayium login and approve it in the browser at relayium.com/device; whoami then prints your account and the server it is bound to.",
          },
          {
            symptom: "down cannot parse the link, and the key seems to have vanished.",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "An unquoted # starts a comment in most shells, so everything from #k= onwards never reached the command — echo shows exactly what survived. Wrap the whole link in single quotes and the fragment, which is the decryption key, arrives intact.",
          },
          {
            symptom: "The link stops working sooner than the --ttl you asked for.",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "The server silently clamps a request beyond your plan's ceiling — 1 day on Free, 3 on Plus, 7 on Pro, 14 on Max — and up prints that note afterwards to say what it actually got. A link also ends early on --burn or --max-downloads. Upload again for a fresh one.",
          },
          {
            symptom: "You are logged in, but up says you're logged in somewhere else.",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "A --server that did not issue your token is refused rather than sent your credential, which would leak it and would not authenticate there anyway. Either drop --server so it uses the bound server whoami just printed, or run relayium login against the other host first.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account?",
        a: "To upload, and to send when a code has to be minted. relayium up always requires relayium login, so the file can be stored under your account. relayium send requires it only when the server has to mint a fresh pairing code for you — run send with a code someone handed you and it mints nothing, so it needs no login. relayium down and relayium receive need no account, and push/pull, daemon-direct and sync work without one.",
      },
      {
        q: "Is my file encrypted?",
        a: "Yes, end-to-end. It's encrypted on your machine before upload; the key lives only in the link's #k= fragment and is never sent to the server. Relayium stores ciphertext it can't read, including the file names.",
      },
      {
        q: "What if I lose the link?",
        a: "The link carries the only copy of the decryption key, so a lost link means an unrecoverable file — there's nothing on the server that could recover it.",
      },
      {
        q: "Can I limit who downloads it?",
        a: "Anyone with the link can download, so share it privately. Use --burn to allow a single download, or --max-downloads <n> to cap the number, and --ttl <duration> to expire it after a set time.",
      },
      {
        q: "Does it work with the website?",
        a: "Yes. A link from relayium up opens in a browser, and a share link created on relayium.com can be fetched with relayium down on another machine.",
      },
      {
        q: "What happens if a download is interrupted?",
        a: "Inside one run, down handles it: it reconnects up to five attempts and continues by HTTP Range from the last complete encrypted frame, or restarts the file within that run if the server ignores Range. Once the attempts are spent it removes the partial output instead of leaving a truncated file, so a later relayium down starts from the beginning rather than picking up where the last one stopped. Only relayium sync resumes across separate runs.",
      },
    ],
  },
  cta: {
    text: "Ready to move a file across your own machines? Install the CLI, run relayium login, and up it.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "在一台电脑上传到云端，在另一台电脑取回",
  description:
    "通过 Relayium 账号做异步文件传输：用 relayium up 从一台机器上传，之后随时用 relayium down 在另一台机器下载——端到端加密，且只有上传才需要账号。",
  updatedLabel: "最后更新",
  lead: [
    "有时两台电脑根本不会同时开着。你想今晚从工作笔记本丢一个文件，明天再从家里台式机取，中间没人等着保持在线连接。relayium up 和 relayium down 正是干这个的：up 在本地加密后上传到你的账号，down 之后在任意机器上取回并解密——无需点对点握手，也无需一台双方都能 ssh 进去的服务器。",
    "这是 CLI 里主要会用到 Relayium 账号的部分，另一个是 send——它需要账号来生成配对码。其余功能的绑定是可选的：push/pull、daemon 直连、sync 都无需登录照常可用，receive 也一样。下载则完全不需要账号，有链接即可。",
  ],
  sections: [
    {
      heading: "什么时候用它",
      body: ["按对端是否在线、以及两台机器如何互相触达来选模式："],
      bullets: [
        "up / down（本指南）——两台机器从不同时在线。你现在上传，之后你（或另一台机器）再下载。走你的账号。",
        "send / receive——两端此刻都在线，想用一次性配对码做直接点对点传输。",
        "push / pull——你已经能 ssh 进对端机器。",
        "需要 relayium login 的是 up 和 send——up 是为了把文件存到你的账号下，send 只在必须签发配对码时才需要（别人给了你码就不用）。down、receive、push/pull、daemon 直连、sync 都不需要账号。",
      ],
    },
    {
      heading: "开始之前",
      body: [
        "第一次 up 之前有两件一次性的事——装好 CLI，以及有个账号。两样都齐了就往下跳。",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "你需要准备",
        items: [
          "先装 CLI，这样 relayium 命令才存在。下面这行会把预编译好的二进制放到你的 PATH 上（macOS 和 Linux；Windows 请从发布页下载 .zip）；relayium --version 可确认是否装好，relayium.com/cli 列出了所有安装方式。不装这一步，relayium login 只会报「command not found」。",
          "有一个免费的 Relayium 账号。浏览器那一步是拿你的账号来批准这次登录，所以你得先有账号才能批准——先在 relayium.com 登录，没有就在那里注册一个。只有上传才需要账号；下载从不需要。",
          "一个能把链接送到另一台机器的办法——备忘录、聊天窗口、密码管理器都行。任何拿到链接的人都能下载该文件，所以要像对待密码一样对待它。",
        ],
      },
    },
    {
      heading: "把这台机器绑定到你的账号（一次即可）",
      body: [
        "up 需要知道存到谁的账号下，所以每台机器登录一次。这是浏览器授权的设备登录——终端里除了你要确认的那个码，什么都不用输：",
      ],
      code: ["relayium login"],
      bullets: [
        "CLI 会打印一个短码和一个网址（relayium.com/device）。在已登录 relayium.com 的浏览器里打开它（若尚未登录，先在那里登录），输入短码并确认——这台机器就绑定好了。",
        "登录信息存在 ~/.config/relayium/ 下，所以每台机器只需做一次。relayium whoami 显示当前绑定的账号；relayium logout 清除它。",
        "以后要撤销某台机器，在浏览器里从账号的「设备」页删掉对应设备即可。",
      ],
    },
    {
      heading: "从第一台电脑上传",
      body: ["up 会遍历你给的文件，在本地加密，上传密文，并打印一个取件链接："],
      steps: [
        {
          text: "确认这台机器还绑定在你的账号上。它会打印账号和所绑定的服务器；如果显示未登录，先回到上面那步登录。",
          code: ["relayium whoami"],
        },
        {
          text: "上传文件。up 会在本地加密，只把密文发出去，并把取件链接打印到 stdout。",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "如果 24 小时的默认值不合适，就加一个保留策略参数。服务器实际保留多久，上限由你的套餐决定。",
          code: [
            `# 选择它能存活多久（默认 24 小时）：
relayium up ./report.pdf --burn              # 下载一次后即删除
relayium up ./report.pdf --ttl 7d            # 保留 7 天（上限取决于套餐）
relayium up ./report.pdf --max-downloads 5   # 允许下载 5 次，之后删除`,
          ],
        },
        {
          text: "把链接送到第二台机器能读到的地方。只有链接会走 stdout，所以管道里很干净。",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "上传成功是什么样",
        body: [
          "上传过程中 stderr 上会有一个进度条，结束后清除。链接会单独一行落在 stdout 上，随后是给人看的提示行——以及可能出现的保留时长提示——都在 stderr 上。",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "保留策略：--burn 下载一次后即删；--ttl <时长> 保留固定时间；--max-downloads <n> 允许固定下载次数。三者都不给时，链接保留 24 小时——这就是不带 --ttl 时的默认值。",
        "--ttl 接受带单位的时长——30m、12h、7d、2w——也接受纯秒数，所以 --ttl 3600 和 --ttl 1h 是同一个请求。上限由你的套餐决定：Free 1 天、Plus 3 天、Pro 7 天、Max 14 天。要求超过上限时，服务器会静默地只按上限保留——up 随后会打印一行提示，告诉你它实际保留了多久。",
      ],
    },
    {
      heading: "在第二台电脑下载",
      body: [
        "在另一台机器上，把链接交给 down。无需登录、无需配置——解密文件的密钥就在链接里，所以 down 完全不需要你的账号：",
      ],
      steps: [
        {
          text: "用你顺手的方式把链接弄到第二台机器上。那边除了 CLI 本身，不需要安装或登录任何东西。",
        },
        {
          text: "把链接用单引号括起来交给 down，后面跟上文件该落地的目录。",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "省略目录就落到当前目录。",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "下载成功是什么样",
        body: [
          "它写下的每个文件都会逐行列在 stdout 上，数量和目标目录则在 stderr 上确认。",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "你的分享链接",
        linkToken: "你的链接",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "保存到（粘贴你的 pwd 输出）",
        destToken: "目标目录",
        destPlaceholder: "/home/you/downloads",
        copy: "复制命令",
        copied: "已复制",
      },
      bullets: [
        "如果该文件设了阅后即焚、已达下载次数上限或已过期，链接就失效了，down 会告知它已不存在。",
        "连接中断或卡死时，同一次运行内会自动重试：down 最多重连五次，并用 HTTP Range 请求从最后一个完整密文帧继续，所以一个大文件不会因为被代理重置就从头再下。对着忽略 Range 的服务端——老版本，或者阅后即焚／限次的文件——它会在这同一次运行里重头再下。",
        "这种恢复不会跨越命令本身。尝试用尽后，down 会把已经写下的内容删掉，而不是留下一个看起来完整的截断文件；再跑一次 down 是从头开始的。这和 relayium sync 那种跨运行的续传不是一回事。",
      ],
    },
    {
      heading: "也能和网页端互通",
      body: ["这个链接和网页端用的是同一种，所以 CLI 与浏览器可以自由互通："],
      bullets: [
        "relayium up 产出的链接能在浏览器里打开——把它给没装 CLI 的人，对方就能从网页下载。",
        "在 relayium.com 上创建的分享链接，也能在另一台机器上用 relayium down 取回。",
      ],
    },
    {
      heading: "服务器能看到什么、看不到什么",
      body: ["云端传输始终是端到端加密的："],
      bullets: [
        "你的文件在上传前就已在你的机器上加密。解密密钥只存在于链接的 #k= 片段里，从不发给服务器——Relayium 存的是它读不了的密文，连文件名也是。",
        "这也意味着链接是回到文件的唯一途径：丢了链接，文件就无法找回，你和我们都不行。",
      ],
    },
    {
      heading: "链接不管用的时候",
      body: [
        "几乎所有失败的 up 或 down 都落在下面四种里，而且没有一种需要靠猜——决定性的状态要么由一条命令打印出来，要么就摆在你敲的那行命令里。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "up 直接拒绝并提示 “run relayium login first”。",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "上传是把文件存到你的账号名下，所以这台机器需要凭据。运行 relayium login，在浏览器的 relayium.com/device 上批准；之后 whoami 就会打印出你的账号和它绑定的服务器。",
          },
          {
            symptom: "down 解析不了链接，密钥像是凭空消失了。",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "在大多数 shell 里，没加引号的 # 会开启注释，于是从 #k= 起的部分根本没进到命令里——echo 会原样告诉你活下来的是哪一截。把整条链接用单引号括起来，那个片段（也就是解密密钥）就能完整送达。",
          },
          {
            symptom: "链接比你要的 --ttl 更早失效。",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "超过套餐上限的请求，服务器会静默地按上限处理——Free 1 天、Plus 3 天、Pro 7 天、Max 14 天——随后 up 会打印这行提示，告诉你实际拿到了多久。此外 --burn 和 --max-downloads 也会让链接提前作废。想要新的就重新上传一次。",
          },
          {
            symptom: "明明登录了，up 却说你登录在别处。",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "不是签发你令牌的那个 --server，会被拒绝而不是把凭据发过去——发过去既会泄露它，在那边也根本认证不了。要么去掉 --server，让它用 whoami 刚打印出来的那个绑定服务器；要么先对另一台主机执行 relayium login。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我需要账号吗？",
        a: "上传时需要；发送时，只在必须签发配对码的情况下需要。relayium up 始终需要 relayium login，这样文件才能存到你的账号下。relayium send 只在服务器必须为你签发一个新的配对码时才需要——用别人给你的配对码运行 send，它不会签发任何东西，因此也不需要登录。relayium down 和 relayium receive 不需要账号，push/pull、daemon 直连、sync 也都不需要。",
      },
      {
        q: "我的文件加密吗？",
        a: "是的，端到端加密。上传前就在你的机器上加密；密钥只存在于链接的 #k= 片段里，从不发给服务器。Relayium 存的是它读不了的密文，连文件名也是。",
      },
      {
        q: "如果我把链接弄丢了呢？",
        a: "链接携带解密密钥的唯一副本，所以链接一丢，文件就无法找回——服务器上没有任何东西能恢复它。",
      },
      {
        q: "能限制谁来下载吗？",
        a: "任何拿到链接的人都能下载，所以要私密分享。用 --burn 只允许下载一次，或 --max-downloads <n> 限制次数，再用 --ttl <时长> 让它到期自动删除。",
      },
      {
        q: "能和网页端互通吗？",
        a: "能。relayium up 产出的链接能在浏览器里打开；在 relayium.com 上创建的分享链接也能在另一台机器上用 relayium down 取回。",
      },
      {
        q: "下载被中断了会怎样？",
        a: "在同一次运行内，down 自己会处理：最多重连五次，并用 HTTP Range 从最后一个完整密文帧继续；服务端若忽略 Range，它就在这一次运行里重头再下。尝试用尽后它会删掉半截的输出，而不是留下一个截断文件——所以之后再跑 relayium down 是从头开始的，而不是接着上一次。只有 relayium sync 才会跨运行续传。",
      },
    ],
  },
  cta: {
    text: "准备好在自己的几台机器之间传文件了吗？装上 CLI，运行 relayium login，然后 up 它。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "クラウドにアップロードし、別のコンピュータで取得する",
  description:
    "Relayium アカウントを使った非同期ファイル転送。relayium up で一方のマシンからアップロードし、都合のよいときに relayium down で別のマシンからダウンロード。エンドツーエンド暗号化で、アカウントが要るのはアップロードだけ。",
  updatedLabel: "最終更新",
  lead: [
    "二台のコンピュータが同時に起きていることは決してない、という場面があります。今夜は仕事用ノートからファイルを置いておき、明日は自宅のデスクトップから取りたい。ライブ接続を待つ人は誰もいません。relayium up と relayium down はまさにそれです。up はローカルで暗号化してアカウントにアップロードし、down は後から任意のマシンで取得・復号します。P2P ハンドシェイクも、双方が ssh できるサーバーも不要です。",
    "これは CLI の中で Relayium アカウントを使う主な部分です。もう一つはペアリングコードの発行にアカウントを必要とする send です。残りのバインドは任意で、push/pull、デーモン直結、sync はログインなしで動き続け、receive も同様です。ダウンロードにはアカウントは一切不要で、リンクさえあれば十分です。",
  ],
  sections: [
    {
      heading: "どんなときに使うか",
      body: ["相手側がオンラインかどうか、二台がどう到達し合うかでモードを選びます："],
      bullets: [
        "up / down（このガイド）：二台が同時にオンラインになりません。今アップロードし、後で自分（または別のマシン）がダウンロードします。アカウント経由です。",
        "send / receive：両端が今オンラインで、使い捨てコードで直接 P2P 転送したいときです。",
        "push / pull：相手のマシンに既に ssh できます。",
        "relayium login が要るのは up と send の二つ。up はファイルをアカウントに保存するため、send はペアリングコードを発行しなければならないときだけ（コードを渡されていれば不要）。down、receive、push/pull、デーモン直結、sync はアカウント不要です。",
      ],
    },
    {
      heading: "始める前に",
      body: [
        "最初の up の前に、一度だけ済ませることが二つあります。CLI のインストールと、アカウントの用意です。両方そろっていれば読み飛ばしてください。",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "必要なもの",
        items: [
          "まず CLI をインストールして relayium コマンドが存在するようにします。下の一行でビルド済みバイナリが PATH に入ります（macOS と Linux。Windows は releases ページから .zip を取得）。relayium --version でインストールを確認でき、relayium.com/cli にすべてのインストール方法があります。これをしないと relayium login は「command not found」と出るだけです。",
          "無料の Relayium アカウントを用意します。ブラウザでの手順は自分のアカウントに対してログインを承認するので、承認する前にアカウントが必要です。まず relayium.com でサインインし、なければそこで作成してください。アカウントが要るのはアップロードだけで、ダウンロードには不要です。",
          "リンクをもう一台へ移す手段。メモアプリ、チャットの窓、パスワードマネージャーなど何でも構いません。リンクを持つ誰もがダウンロードできるので、パスワードのように扱ってください。",
        ],
      },
    },
    {
      heading: "このマシンをアカウントにバインドする（一度だけ）",
      body: [
        "up は誰のアカウントに保存するかを知る必要があるため、マシンごとに一度サインインします。ブラウザで承認するデバイスログインで、ターミナルには確認するコード以外は何も入力しません：",
      ],
      code: ["relayium login"],
      bullets: [
        "CLI が短いコードと URL（relayium.com/device）を表示します。relayium.com にサインイン済みのブラウザで開き（未サインインならまずそこでサインイン）、コードを入力して承認すると、このマシンがバインドされます。",
        "ログイン情報は ~/.config/relayium/ に保存されるので、マシンごとに一度で済みます。relayium whoami でバインド先を表示し、relayium logout で解除します。",
        "後でマシンを取り消すには、ブラウザのアカウントの「デバイス」ページから該当デバイスを削除します。",
      ],
    },
    {
      heading: "一台目のコンピュータからアップロード",
      body: ["up は渡したファイルをたどり、ローカルで暗号化し、暗号文をアップロードして、取得用リンクを表示します："],
      steps: [
        {
          text: "このマシンがまだアカウントに結び付いているかを確認します。アカウントと結び付き先のサーバーが表示されます。未ログインと出たら、先に上のログイン手順を済ませてください。",
          code: ["relayium whoami"],
        },
        {
          text: "ファイルをアップロードします。up はローカルで暗号化し、暗号文だけを送り、取得用リンクを標準出力に表示します。",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "既定の24時間が望みと違うなら、保持のフラグを足します。サーバーが実際にどれだけ保持するかの上限はプランが決めます。",
          code: [
            `# 保持期間を選ぶ（既定は24時間）：
relayium up ./report.pdf --burn              # 一度ダウンロードすると削除
relayium up ./report.pdf --ttl 7d            # 7日間保持（上限はプランによる）
relayium up ./report.pdf --max-downloads 5   # 5回まで、その後削除`,
          ],
        },
        {
          text: "二台目が読める場所へリンクを移します。標準出力に出るのはリンクだけなので、パイプはきれいなままです。",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "アップロードが成功したときの表示",
        body: [
          "アップロード中は標準エラー出力に進捗バーが出て、終わると消えます。リンクは標準出力に単独の行として出て、人向けのヒント（および保持期間の注記があればそれ）は標準エラー出力に続きます。",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "保持：--burn は一度のダウンロードで削除。--ttl <期間> は一定時間保持。--max-downloads <n> は一定回数まで。どれも指定しなければリンクは24時間保持されます。これが --ttl を付けないときの既定です。",
        "--ttl は単位付きの期間（30m、12h、7d、2w）のほか、単なる秒数も受け取ります。つまり --ttl 3600 と --ttl 1h は同じ指定です。上限はプランで決まります：Free は1日、Plus は3日、Pro は7日、Max は14日。上限より長く要求すると、サーバーは黙って上限までしか保持しません。その場合 up が後から、実際に保持される期間を1行で知らせます。",
      ],
    },
    {
      heading: "二台目のコンピュータでダウンロード",
      body: [
        "別のマシンでは、リンクを down に渡します。ログインも設定も不要。ファイルを復号する鍵はリンクの中にあるので、down はアカウントから何も必要としません：",
      ],
      steps: [
        {
          text: "都合のよい方法でリンクを二台目に持っていきます。あちらには CLI 本体のほかに、インストールもログインも要りません。",
        },
        {
          text: "シングルクォートで囲んだリンクと、ファイルを置きたいディレクトリを down に渡します。",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "ディレクトリを省くと現在のディレクトリに置かれます。",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "ダウンロードが成功したときの表示",
        body: [
          "書き出したファイルが1行ずつ標準出力に並び、件数と保存先が標準エラー出力で確認されます。",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "共有リンク",
        linkToken: "自分のリンク",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "保存先（pwd の出力を貼り付け）",
        destToken: "保存先ディレクトリ",
        destPlaceholder: "/home/you/downloads",
        copy: "コマンドをコピー",
        copied: "コピーしました",
      },
      bullets: [
        "ファイルがバーン設定、ダウンロード上限到達、または期限切れの場合、リンクは使い切られており、down はもう存在しないと報告します。",
      ],
    },
    {
      heading: "ウェブサイトとも連携",
      body: ["このリンクはウェブサイトが使うものと同じなので、CLI とブラウザは自由に連携します："],
      bullets: [
        "relayium up のリンクはブラウザで開けます。CLI を持たない人に渡せば、その人はウェブからダウンロードできます。",
        "relayium.com で作った共有リンクは、別のマシンで relayium down から取得できます。",
      ],
    },
    {
      heading: "サーバーに見えるもの・見えないもの",
      body: ["クラウド転送はエンドツーエンドで暗号化されたままです："],
      bullets: [
        "ファイルはアップロード前に自分のマシンで暗号化されます。復号鍵はリンクの #k= 断片にのみ存在し、サーバーには決して送られません。Relayium は読めない暗号文を、ファイル名も含めて保存します。",
        "つまりリンクだけがファイルへ戻る唯一の手段です。失えばファイルは復旧できません。自分でも当社でも同じです。",
      ],
    },
    {
      heading: "リンクが働かないとき",
      body: [
        "失敗する up と down のほとんどは次の4つで尽きます。どれも当て推量は要りません。判定を決める状態は、コマンドが表示するか、自分が打ったコマンドの中に見えています。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "up が「run relayium login first」と出て断る。",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "アップロードはファイルをアカウントの下に保管するので、このマシンに資格情報が必要です。relayium login を実行し、ブラウザーの relayium.com/device で承認してください。以後 whoami はアカウントと結び付き先のサーバーを表示します。",
          },
          {
            symptom: "down がリンクを解釈できず、鍵が消えたように見える。",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "多くのシェルでは引用符のない # がコメントを始めるため、#k= 以降はコマンドに届いていません。echo が、生き残った部分をそのまま見せてくれます。リンク全体をシングルクォートで囲めば、復号鍵であるその断片も無傷で届きます。",
          },
          {
            symptom: "指定した --ttl より早くリンクが切れる。",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "プランの上限を超える要求を、サーバーは黙って上限に切り詰めます（Free は1日、Plus は3日、Pro は7日、Max は14日）。そのあと up がこの注記を出して、実際に得られた期間を伝えます。--burn や --max-downloads でもリンクは早く終わります。新しいものが必要ならもう一度アップロードしてください。",
          },
          {
            symptom: "ログイン済みなのに、up が別の場所にログインしていると言う。",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "トークンを発行していない --server には、資格情報を送らずに拒否します。送れば漏らすことになり、しかもそちらでは認証もできないからです。--server を外して whoami が今表示した結び付き先を使うか、先に相手のホストに対して relayium login を実行してください。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "アカウントは必要ですか？",
        a: "アップロードのときと、コードを発行しなければならない送信のときです。relayium up は常に relayium login が必要で、ファイルを自分のアカウントに保存するためです。relayium send が必要なのは、サーバーが新しいペアリングコードを発行しなければならないときだけです。誰かから渡されたコードで send を実行する場合は何も発行されないため、ログインは要りません。relayium down と relayium receive にアカウントは不要で、push/pull、デーモン直結、sync もアカウントなしで動きます。",
      },
      {
        q: "ファイルは暗号化されますか？",
        a: "はい、エンドツーエンドで。アップロード前に自分のマシンで暗号化され、鍵はリンクの #k= 断片にのみ存在し、サーバーには決して送られません。Relayium は読めない暗号文を、ファイル名も含めて保存します。",
      },
      {
        q: "リンクを失ったら？",
        a: "リンクは復号鍵の唯一の控えを運びます。失えばファイルは復旧不能です。サーバー側に復元できるものは何もありません。",
      },
      {
        q: "誰がダウンロードできるか制限できますか？",
        a: "リンクを持つ誰もがダウンロードできるので、非公開で共有してください。--burn で一度だけ、--max-downloads <n> で回数を制限し、--ttl <期間> で一定時間後に失効させられます。",
      },
      {
        q: "ウェブサイトと連携しますか？",
        a: "はい。relayium up のリンクはブラウザで開け、relayium.com で作った共有リンクは別のマシンで relayium down から取得できます。",
      },
    ],
  },
  cta: {
    text: "自分のマシン間でファイルを移す準備はできましたか？ CLI をインストールし、relayium login を実行して、up しましょう。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続きを読む",
};

const ko = {
  title: "클라우드에 올리고 다른 컴퓨터에서 받기",
  description:
    "Relayium 계정을 통한 비동기 파일 전송. relayium up으로 한 기기에서 업로드하고, 편할 때 relayium down으로 다른 기기에서 다운로드 — 종단간 암호화이며 계정이 필요한 것은 업로드뿐입니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "두 컴퓨터가 동시에 켜져 있는 일이 결코 없을 때가 있습니다. 오늘 밤 업무용 노트북에서 파일을 올려두고 내일 집 데스크톱에서 받고 싶은데, 실시간 연결을 기다리는 사람은 아무도 없습니다. relayium up과 relayium down이 바로 그 일을 합니다. up은 로컬에서 암호화해 계정에 업로드하고, down은 나중에 아무 기기에서나 가져와 복호화합니다. P2P 핸드셰이크도, 둘 다 ssh 할 수 있는 서버도 필요 없습니다.",
    "이것은 CLI에서 Relayium 계정을 사용하는 주된 부분이며, 다른 하나는 페어링 코드를 발급하기 위해 계정이 필요한 send입니다. 나머지의 바인딩은 선택 사항입니다. push/pull, 데몬 다이렉트, sync는 로그인 없이 계속 동작하고 receive도 마찬가지입니다. 다운로드에는 계정이 전혀 필요 없고 링크만 있으면 됩니다.",
  ],
  sections: [
    {
      heading: "언제 쓰나",
      body: ["상대편이 온라인인지, 두 기기가 서로 어떻게 닿는지에 따라 모드를 고릅니다:"],
      bullets: [
        "up / down (이 가이드) — 두 기기가 동시에 온라인이 되지 않습니다. 지금 업로드하고, 나중에 자신(또는 다른 기기)이 다운로드합니다. 계정을 거칩니다.",
        "send / receive — 양쪽이 지금 온라인이며 일회용 코드로 직접 P2P 전송을 원합니다.",
        "push / pull — 상대 기기에 이미 ssh 할 수 있습니다.",
        "relayium login이 필요한 것은 up과 send 둘입니다 — up은 파일을 계정에 저장하기 위해, send는 페어링 코드를 발급해야 할 때만(코드를 받았다면 필요 없습니다). down, receive, push/pull, 데몬 다이렉트, sync는 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "시작하기 전에",
      body: [
        "첫 up 전에 한 번만 해두면 되는 두 가지 — CLI 설치와 계정 준비입니다. 둘 다 있으면 건너뛰세요.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "필요한 것",
        items: [
          "먼저 CLI를 설치해 relayium 명령이 존재하게 합니다. 아래 한 줄이 미리 빌드된 바이너리를 PATH에 올립니다(macOS와 Linux; Windows는 releases 페이지에서 .zip을 받으세요). relayium --version으로 설치를 확인할 수 있고, relayium.com/cli에 모든 설치 방법이 있습니다. 이 단계를 건너뛰면 relayium login은 “command not found”만 출력합니다.",
          "무료 Relayium 계정을 준비합니다. 브라우저 단계는 본인 계정에 대해 로그인을 승인하므로, 승인하려면 먼저 계정이 있어야 합니다 — relayium.com에서 로그인하거나 없으면 거기서 새로 만드세요. 계정이 필요한 것은 업로드뿐이고 다운로드에는 필요 없습니다.",
          "링크를 다른 기기로 옮길 수단 — 메모 앱, 채팅 창, 비밀번호 관리자 무엇이든 좋습니다. 링크를 가진 누구나 파일을 받을 수 있으니 비밀번호처럼 다루세요.",
        ],
      },
    },
    {
      heading: "이 기기를 계정에 바인딩하기 (한 번만)",
      body: [
        "up은 누구의 계정에 저장할지 알아야 하므로 기기마다 한 번 로그인합니다. 브라우저에서 승인하는 기기 로그인이며, 터미널에는 확인할 코드 외에는 아무것도 입력하지 않습니다:",
      ],
      code: ["relayium login"],
      bullets: [
        "CLI가 짧은 코드와 URL(relayium.com/device)을 표시합니다. relayium.com에 로그인된 브라우저에서 열어(로그인되어 있지 않으면 먼저 거기서 로그인) 코드를 입력하고 승인하면 이 기기가 바인딩됩니다.",
        "로그인 정보는 ~/.config/relayium/ 아래 저장되므로 기기마다 한 번이면 됩니다. relayium whoami로 바인딩 대상을 보고, relayium logout으로 지웁니다.",
        "나중에 기기를 취소하려면 브라우저의 계정 '기기' 페이지에서 해당 기기를 삭제하세요.",
      ],
    },
    {
      heading: "첫 번째 컴퓨터에서 업로드",
      body: ["up은 준 파일들을 훑어 로컬에서 암호화하고 암호문을 업로드한 뒤 수령용 링크를 출력합니다:"],
      steps: [
        {
          text: "이 기기가 아직 계정에 묶여 있는지 확인합니다. 계정과 묶여 있는 서버를 출력하며, 로그인되어 있지 않다고 하면 위의 로그인 단계를 먼저 하세요.",
          code: ["relayium whoami"],
        },
        {
          text: "파일을 올립니다. up은 로컬에서 암호화해 암호문만 보내고, 수령용 링크를 표준 출력에 찍습니다.",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "기본값인 24시간이 원하는 바가 아니면 보관 플래그를 붙이세요. 서버가 실제로 얼마나 보관할지의 상한은 요금제가 정합니다.",
          code: [
            `# 얼마나 살려둘지 고르기(기본값 24시간):
relayium up ./report.pdf --burn              # 한 번 다운로드 후 삭제
relayium up ./report.pdf --ttl 7d            # 7일간 보관(상한은 요금제에 따라 다름)
relayium up ./report.pdf --max-downloads 5   # 5회까지 허용 후 삭제`,
          ],
        },
        {
          text: "두 번째 기기가 읽을 수 있는 곳으로 링크를 옮깁니다. 표준 출력에는 링크만 나오므로 파이프가 깨끗합니다.",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "업로드가 성공했을 때 보이는 것",
        body: [
          "올리는 동안 표준 오류에 진행 막대가 떴다가 끝나면 지워집니다. 링크는 표준 출력에 한 줄로 나오고, 사람이 읽을 안내와 보관 기간 안내는 표준 오류에 이어집니다.",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "보관: --burn은 한 번 다운로드하면 삭제, --ttl <기간>은 정해진 시간 보관, --max-downloads <n>은 정해진 횟수 허용. 셋 다 주지 않으면 링크는 24시간 살아 있습니다 — --ttl이 없을 때의 기본값입니다.",
        "--ttl은 단위가 붙은 기간(30m, 12h, 7d, 2w)이나 초 단위 숫자를 받습니다. 그래서 --ttl 3600과 --ttl 1h는 같은 요청입니다. 상한은 요금제가 정합니다: Free 1일, Plus 3일, Pro 7일, Max 14일. 상한보다 길게 요청하면 서버는 조용히 상한까지만 보관하며, up이 실제로 얼마나 보관되는지 한 줄로 알려줍니다.",
      ],
    },
    {
      heading: "두 번째 컴퓨터에서 다운로드",
      body: [
        "다른 기기에서 링크를 down에 건넵니다. 로그인도 설정도 필요 없습니다 — 파일을 복호화하는 키가 링크 안에 있으므로 down은 계정에서 아무것도 필요로 하지 않습니다:",
      ],
      steps: [
        {
          text: "편한 방법으로 링크를 두 번째 기기로 옮깁니다. 그쪽에는 CLI 자체 말고는 설치할 것도 로그인할 것도 없습니다.",
        },
        {
          text: "작은따옴표로 감싼 링크와, 파일이 저장될 디렉터리를 down에 건넵니다.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "디렉터리를 빼면 현재 디렉터리에 저장됩니다.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "다운로드가 성공했을 때 보이는 것",
        body: [
          "쓴 파일이 표준 출력에 한 줄씩 나열되고, 개수와 대상 디렉터리가 표준 오류에서 확인됩니다.",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "공유 링크",
        linkToken: "내 링크",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "저장 위치 (pwd 출력을 붙여넣기)",
        destToken: "대상 디렉터리",
        destPlaceholder: "/home/you/downloads",
        copy: "명령 복사",
        copied: "복사됨",
      },
      bullets: [
        "파일이 번(burn) 설정이거나 다운로드 한도에 도달했거나 만료되었으면 링크는 소진된 것이고, down은 사라졌다고 알립니다.",
      ],
    },
    {
      heading: "웹사이트와도 연동",
      body: ["이 링크는 웹사이트가 쓰는 것과 같으므로 CLI와 브라우저가 자유롭게 연동됩니다:"],
      bullets: [
        "relayium up의 링크는 브라우저에서 열립니다 — CLI가 없는 사람에게 건네면 웹에서 다운로드합니다.",
        "relayium.com에서 만든 공유 링크는 다른 기기에서 relayium down으로 받을 수 있습니다.",
      ],
    },
    {
      heading: "서버가 볼 수 있는 것과 없는 것",
      body: ["클라우드 전송은 종단간 암호화를 유지합니다:"],
      bullets: [
        "파일은 업로드 전에 내 기기에서 암호화됩니다. 복호화 키는 링크의 #k= 조각에만 있고 서버로 전송되지 않습니다 — Relayium은 읽을 수 없는 암호문을 파일 이름까지 포함해 저장합니다.",
        "그래서 링크가 파일로 돌아가는 유일한 길입니다: 잃으면 파일은 복구할 수 없습니다. 본인도, 저희도.",
      ],
    },
    {
      heading: "링크가 듣지 않을 때",
      body: [
        "실패하는 up과 down은 거의 다 아래 네 가지입니다. 어느 것도 추측이 필요 없습니다. 판정을 가르는 상태는 명령이 출력해 주거나, 직접 친 명령 안에 보입니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "up이 “run relayium login first”를 내며 거부합니다.",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "업로드는 파일을 계정 아래에 보관하므로 이 기기에 자격 증명이 필요합니다. relayium login 을 실행하고 브라우저의 relayium.com/device 에서 승인하세요. 그 뒤 whoami가 계정과 묶여 있는 서버를 출력합니다.",
          },
          {
            symptom: "down이 링크를 해석하지 못하고, 키가 사라진 것처럼 보입니다.",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "대부분의 셸에서 따옴표 없는 #은 주석을 시작하므로 #k= 이후는 명령에 닿지도 못했습니다. echo가 살아남은 부분을 그대로 보여 줍니다. 링크 전체를 작은따옴표로 감싸면 복호화 키인 그 조각이 온전히 전달됩니다.",
          },
          {
            symptom: "요청한 --ttl보다 링크가 일찍 끊깁니다.",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "요금제 상한을 넘는 요청을 서버는 조용히 상한으로 깎습니다 — Free 1일, Plus 3일, Pro 7일, Max 14일 — 그리고 up이 실제로 받은 기간을 이 안내로 알려 줍니다. --burn이나 --max-downloads로도 링크는 일찍 끝납니다. 새 링크가 필요하면 다시 올리세요.",
          },
          {
            symptom: "로그인해 두었는데도 up이 다른 곳에 로그인되어 있다고 합니다.",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "토큰을 발급하지 않은 --server에는 자격 증명을 보내지 않고 거부합니다. 보내면 유출이 되고, 그쪽에서 인증되지도 않기 때문입니다. --server를 빼서 whoami가 방금 출력한 서버를 쓰거나, 먼저 그 호스트를 상대로 relayium login 을 실행하세요.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "계정이 필요한가요?",
        a: "업로드할 때, 그리고 코드를 발급해야 하는 보내기일 때요. relayium up은 파일을 내 계정에 저장해야 하므로 언제나 relayium login이 필요합니다. relayium send는 서버가 새 페어링 코드를 발급해야 할 때만 필요합니다 — 누군가 건네준 코드로 send를 실행하면 아무것도 발급하지 않으므로 로그인이 필요 없습니다. relayium down과 relayium receive는 계정이 필요 없고, push/pull, 데몬 다이렉트, sync도 계정 없이 동작합니다.",
      },
      {
        q: "파일은 암호화되나요?",
        a: "네, 종단간으로요. 업로드 전에 내 기기에서 암호화되며, 키는 링크의 #k= 조각에만 있고 서버로 전송되지 않습니다. Relayium은 읽을 수 없는 암호문을 파일 이름까지 포함해 저장합니다.",
      },
      {
        q: "링크를 잃어버리면요?",
        a: "링크는 복호화 키의 유일한 사본을 담고 있어, 잃으면 파일은 복구할 수 없습니다 — 서버에 복원할 수 있는 것이 전혀 없습니다.",
      },
      {
        q: "누가 다운로드할지 제한할 수 있나요?",
        a: "링크를 가진 누구나 다운로드할 수 있으니 비공개로 공유하세요. --burn으로 한 번만, --max-downloads <n>으로 횟수를 제한하고, --ttl <기간>으로 일정 시간 후 만료시킬 수 있습니다.",
      },
      {
        q: "웹사이트와 연동되나요?",
        a: "네. relayium up의 링크는 브라우저에서 열리고, relayium.com에서 만든 공유 링크는 다른 기기에서 relayium down으로 받을 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "자신의 기기들 사이에서 파일을 옮길 준비가 되셨나요? CLI를 설치하고 relayium login을 실행한 뒤 up 하세요.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien in die Cloud laden und auf einem anderen Computer abholen",
  description:
    "Asynchrone Dateiübertragung über dein Relayium-Konto: mit relayium up von einem Rechner hochladen, mit relayium down auf einem anderen abholen, wann es passt — Ende-zu-Ende-verschlüsselt, und nur das Hochladen braucht ein Konto.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Manchmal sind die beiden Computer nie gleichzeitig wach. Du willst heute Abend vom Arbeitslaptop eine Datei ablegen und sie morgen vom Desktop zu Hause holen, ohne dass jemand auf eine Live-Verbindung wartet. Genau das tun relayium up und relayium down: up verschlüsselt lokal und lädt in dein Konto hoch, down holt sie später auf einem beliebigen Rechner und entschlüsselt sie — kein Peer-to-Peer-Handshake, kein Server, in den beide per ssh kommen.",
    "Das ist der wesentliche Teil der CLI, der dein Relayium-Konto nutzt — daneben send, das eines braucht, um einen Pairing-Code zu erzeugen. Für den Rest ist das Binden optional: push/pull, daemon-direct und sync laufen weiter ohne Anmeldung, receive ebenso. Das Herunterladen braucht überhaupt kein Konto, nur den Link.",
  ],
  sections: [
    {
      heading: "Wann du dazu greifst",
      body: ["Wähle den Modus danach, ob die Gegenseite online ist und wie sich die beiden Rechner erreichen:"],
      bullets: [
        "up / down (diese Anleitung) — die beiden Rechner sind nie gleichzeitig online. Du lädst jetzt hoch; du (oder ein anderer Rechner) lädst später herunter. Läuft über dein Konto.",
        "send / receive — beide Seiten sind jetzt online und wollen eine direkte Peer-to-Peer-Übertragung über einen Einmalcode.",
        "push / pull — du kommst bereits per ssh auf den entfernten Rechner.",
        "relayium login brauchen nur up und send — up, um die Datei unter deinem Konto zu speichern, send nur dann, wenn es einen Pairing-Code erzeugen muss (mit einem übergebenen Code gar nicht). down, receive, push/pull, daemon-direct und sync brauchen kein Konto.",
      ],
    },
    {
      heading: "Bevor du loslegst",
      body: [
        "Zwei einmalige Dinge vor deinem ersten up — die CLI installieren und ein Konto haben. Hast du beides, überspring diesen Abschnitt.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Installiere die CLI, damit es den Befehl relayium gibt. Die Zeile unten legt eine vorkompilierte Binärdatei in deinen PATH (macOS und Linux; unter Windows die .zip von der Releases-Seite holen); relayium --version bestätigt die Installation, und relayium.com/cli listet alle Installationswege. Ohne das gibt relayium login nur „command not found“ aus.",
          "Halte ein kostenloses Relayium-Konto bereit. Der Browser-Schritt bestätigt die Anmeldung gegenüber deinem Konto, du brauchst also vorher eines — melde dich zuerst auf relayium.com an oder erstelle dort eines. Nur das Hochladen braucht das Konto; das Herunterladen nie.",
          "Einen Weg, einen Link auf den anderen Rechner zu bringen — eine Notiz-App, ein Chatfenster, ein Passwortmanager. Wer den Link hat, kann die Datei herunterladen, behandle ihn also wie ein Passwort.",
        ],
      },
    },
    {
      heading: "Diesen Rechner an dein Konto binden (einmalig)",
      body: [
        "up muss wissen, unter wessen Konto es speichern soll, also melde dich pro Rechner einmal an. Es ist eine im Browser bestätigte Geräteanmeldung — im Terminal tippst du nichts außer dem Code, den du bestätigst:",
      ],
      code: ["relayium login"],
      bullets: [
        "Die CLI zeigt einen kurzen Code und eine URL (relayium.com/device). Öffne sie in dem Browser, in dem du bei relayium.com angemeldet bist (melde dich dort zuerst an, falls nicht), gib den Code ein und bestätige — dieser Rechner ist jetzt gebunden.",
        "Die Anmeldung wird unter ~/.config/relayium/ gespeichert, also machst du das pro Rechner nur einmal. relayium whoami zeigt, an wen du gebunden bist; relayium logout löscht es.",
        "Um einen Rechner später zu widerrufen, lösche sein Gerät auf der Geräteseite deines Kontos im Browser.",
      ],
    },
    {
      heading: "Vom ersten Computer hochladen",
      body: ["up geht die angegebenen Dateien durch, verschlüsselt sie lokal, lädt den Chiffretext hoch und gibt einen Abhol-Link aus:"],
      steps: [
        {
          text: "Prüf, ob dieser Rechner noch an dein Konto gebunden ist. Er gibt das Konto und den Server aus, an den er gebunden ist. Steht dort, dass du nicht angemeldet bist, hol den Anmeldeschritt oben zuerst nach.",
          code: ["relayium whoami"],
        },
        {
          text: "Lade die Datei hoch. up verschlüsselt sie lokal, schickt nur Chiffretext und gibt den Abhollink auf stdout aus.",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "Setz eine Aufbewahrungs-Option, wenn die 24 Stunden Standard nicht passen. Wie lange der Server sie wirklich behält, begrenzt dein Tarif.",
          code: [
            `# wähle, wie lange sie lebt (Standard: 24 Stunden):
relayium up ./report.pdf --burn              # nach einem Download gelöscht
relayium up ./report.pdf --ttl 7d            # 7 Tage aufbewahrt (Obergrenze je nach Tarif)
relayium up ./report.pdf --max-downloads 5   # 5 Downloads erlaubt, dann weg`,
          ],
        },
        {
          text: "Bring den Link dorthin, wo der zweite Rechner ihn lesen kann. Auf stdout landet nur der Link, eine Pipe bleibt also sauber.",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Upload aus",
        body: [
          "Während des Hochladens läuft auf stderr ein Fortschrittsbalken, der danach verschwindet. Der Link steht allein auf stdout, der Hinweis für Menschen — und ein etwaiger Hinweis zur Aufbewahrung — folgt auf stderr.",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "Aufbewahrung: --burn entfernt die Datei nach einem einzigen Download; --ttl <Dauer> behält sie eine feste Zeit; --max-downloads <n> erlaubt eine feste Anzahl. Gibst du keines davon an, lebt der Link 24 Stunden — das ist der Standard ohne --ttl.",
        "--ttl nimmt eine Dauer mit Einheit — 30m, 12h, 7d, 2w — oder schlicht eine Anzahl Sekunden, --ttl 3600 und --ttl 1h sind also dieselbe Anfrage. Die Obergrenze setzt dein Tarif: 1 Tag bei Free, 3 Tage bei Plus, 7 Tage bei Pro, 14 Tage bei Max. Forderst du mehr als deine Obergrenze, bewahrt der Server sie stillschweigend nur bis zur Obergrenze auf — up gibt danach einen Hinweis aus, wie lange sie tatsächlich bleibt.",
      ],
    },
    {
      heading: "Auf dem zweiten Computer herunterladen",
      body: [
        "Gib auf dem anderen Rechner den Link an down. Keine Anmeldung, keine Einrichtung — der Schlüssel, der die Datei entschlüsselt, steckt im Link, also braucht down nichts von deinem Konto:",
      ],
      steps: [
        {
          text: "Bring den Link auf den zweiten Rechner, wie es dir passt. Dort muss außer der CLI selbst nichts installiert und niemand angemeldet sein.",
        },
        {
          text: "Gib ihn in einfachen Anführungszeichen an down, zusammen mit dem Verzeichnis, in dem die Dateien landen sollen.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "Lass das Verzeichnis weg, um im aktuellen zu landen.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Download aus",
        body: [
          "Jede geschriebene Datei steht auf stdout, eine pro Zeile, und Anzahl und Zielverzeichnis werden auf stderr bestätigt.",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "Dein Freigabelink",
        linkToken: "dein Link",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "Speichern unter (füg deine pwd-Ausgabe ein)",
        destToken: "Zielverzeichnis",
        destPlaceholder: "/home/du/downloads",
        copy: "Befehl kopieren",
        copied: "Kopiert",
      },
      bullets: [
        "Wurde die Datei auf Burn gesetzt, ihr Download-Limit erreicht oder ist sie abgelaufen, ist der Link verbraucht und down meldet, dass sie weg ist.",
      ],
    },
    {
      heading: "Funktioniert auch mit der Website",
      body: ["Der Link ist derselbe, den die Website verwendet, also arbeiten CLI und Browser frei zusammen:"],
      bullets: [
        "Ein Link von relayium up öffnet sich im Browser — gib ihn jemandem ohne CLI, und er lädt aus dem Web herunter.",
        "Ein auf relayium.com erstellter Freigabelink lässt sich auf einem anderen Rechner mit relayium down abholen.",
      ],
    },
    {
      heading: "Was der Server sehen kann und was nicht",
      body: ["Cloud-Übertragungen bleiben Ende-zu-Ende-verschlüsselt:"],
      bullets: [
        "Deine Datei wird auf deinem Rechner verschlüsselt, bevor sie hochgeladen wird. Der Entschlüsselungsschlüssel lebt nur im #k=-Fragment des Links und wird nie an den Server gesendet — Relayium speichert Chiffretext, den es nicht lesen kann, samt der Dateinamen.",
        "Das heißt auch: der Link ist der einzige Weg zurück zur Datei — verlierst du ihn, ist die Datei unwiederbringlich, für dich wie für uns.",
      ],
    },
    {
      heading: "Wenn ein Link nicht funktioniert",
      body: [
        "Vier Fehlschläge decken fast jedes misslungene up oder down ab, und keiner davon braucht Raten — der entscheidende Zustand wird von einem Befehl ausgegeben oder steht sichtbar in dem Befehl, den du getippt hast.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "up verweigert mit „run relayium login first“.",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Hochladen legt die Datei unter deinem Konto ab, dieser Rechner braucht also Zugangsdaten. Führ relayium login aus und bestätige im Browser unter relayium.com/device; danach gibt whoami dein Konto und den gebundenen Server aus.",
          },
          {
            symptom: "down kann den Link nicht lesen, und der Schlüssel scheint verschwunden.",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "Ein nicht in Anführungszeichen gesetztes # beginnt in den meisten Shells einen Kommentar, alles ab #k= hat den Befehl also nie erreicht — echo zeigt genau, was übrig blieb. Setz den ganzen Link in einfache Anführungszeichen, dann kommt das Fragment, also der Entschlüsselungsschlüssel, unversehrt an.",
          },
          {
            symptom: "Der Link stirbt früher als das --ttl, das du verlangt hast.",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "Der Server begrenzt eine Anfrage über die Obergrenze deines Tarifs hinaus stillschweigend — 1 Tag bei Free, 3 bei Plus, 7 bei Pro, 14 bei Max — und up gibt danach diesen Hinweis aus, der sagt, was du wirklich bekommen hast. Auch --burn und --max-downloads beenden einen Link früher. Lade erneut hoch, um einen frischen zu bekommen.",
          },
          {
            symptom: "Du bist angemeldet, aber up sagt, du seist woanders angemeldet.",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "Ein --server, der dein Token nicht ausgestellt hat, wird abgelehnt, statt ihm deine Zugangsdaten zu schicken — das würde sie preisgeben und würde dort ohnehin nicht authentifizieren. Lass --server weg, dann nutzt es den gebundenen Server, den whoami eben ausgegeben hat, oder melde dich zuerst mit relayium login beim anderen Host an.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Brauche ich ein Konto?",
        a: "Zum Hochladen — und zum Senden, wenn dabei ein Code erzeugt werden muss. relayium up erfordert immer relayium login, damit die Datei unter deinem Konto liegen kann. relayium send erfordert es nur, wenn der Server einen frischen Pairing-Code für dich erzeugen muss — führst du send mit einem Code aus, den dir jemand gegeben hat, wird keiner erzeugt und es braucht keine Anmeldung. relayium down und relayium receive brauchen kein Konto, und push/pull, daemon-direct und sync laufen ohne eines.",
      },
      {
        q: "Ist meine Datei verschlüsselt?",
        a: "Ja, Ende-zu-Ende. Sie wird vor dem Hochladen auf deinem Rechner verschlüsselt; der Schlüssel lebt nur im #k=-Fragment des Links und wird nie an den Server gesendet. Relayium speichert Chiffretext, den es nicht lesen kann, samt der Dateinamen.",
      },
      {
        q: "Was, wenn ich den Link verliere?",
        a: "Der Link trägt die einzige Kopie des Entschlüsselungsschlüssels, ein verlorener Link bedeutet also eine unwiederbringliche Datei — auf dem Server gibt es nichts, was sie wiederherstellen könnte.",
      },
      {
        q: "Kann ich einschränken, wer sie herunterlädt?",
        a: "Jeder mit dem Link kann herunterladen, teile ihn also privat. Nutze --burn für einen einzigen Download oder --max-downloads <n> für eine Obergrenze und --ttl <Dauer>, um sie nach einer festen Zeit ablaufen zu lassen.",
      },
      {
        q: "Funktioniert es mit der Website?",
        a: "Ja. Ein Link von relayium up öffnet sich im Browser, und ein auf relayium.com erstellter Freigabelink lässt sich auf einem anderen Rechner mit relayium down abholen.",
      },
    ],
  },
  cta: {
    text: "Bereit, eine Datei zwischen deinen eigenen Rechnern zu bewegen? Installiere die CLI, führe relayium login aus und lade sie mit up hoch.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer des fichiers dans le cloud, les récupérer sur un autre ordinateur",
  description:
    "Transfert de fichiers asynchrone via votre compte Relayium : téléversez depuis une machine avec relayium up, téléchargez sur une autre avec relayium down quand cela vous arrange — chiffré de bout en bout, et seul le téléversement demande un compte.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Parfois, les deux ordinateurs ne sont jamais allumés en même temps. Vous voulez déposer un fichier ce soir depuis le portable du travail et le récupérer demain depuis le poste de la maison, sans que personne n'attende une connexion en direct. relayium up et relayium down font exactement cela : up chiffre localement puis téléverse vers votre compte, et down le récupère plus tard sur n'importe quelle machine et le déchiffre — pas de poignée de main pair-à-pair, pas de serveur où vous pouvez tous les deux vous connecter en ssh.",
    "C'est la principale partie de la CLI qui utilise votre compte Relayium, avec send, qui en a besoin pour générer un code d'appairage. Pour le reste, la liaison est facultative : push/pull, daemon-direct et sync continuent de fonctionner sans connexion, et receive aussi. Le téléchargement ne demande aucun compte, juste le lien.",
  ],
  sections: [
    {
      heading: "Quand y recourir",
      body: ["Choisissez le mode selon que l'autre extrémité est en ligne et selon la façon dont les deux machines se joignent :"],
      bullets: [
        "up / down (ce guide) — les deux machines ne sont jamais en ligne ensemble. Vous téléversez maintenant ; vous (ou une autre machine) téléchargez plus tard. Passe par votre compte.",
        "send / receive — les deux extrémités sont en ligne maintenant et veulent un transfert pair-à-pair direct via un code à usage unique.",
        "push / pull — vous pouvez déjà vous connecter en ssh à la machine distante.",
        "Seuls up et send demandent relayium login — up pour stocker le fichier sous votre compte, send uniquement quand il doit générer un code d'appairage (avec un code qu'on vous a donné, aucun). down, receive, push/pull, daemon-direct et sync ne demandent aucun compte.",
      ],
    },
    {
      heading: "Avant de commencer",
      body: [
        "Deux choses à faire une seule fois avant votre premier up — installer la CLI et avoir un compte. Si vous avez déjà les deux, passez à la suite.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Installez la CLI pour que la commande relayium existe. La ligne ci-dessous place un binaire précompilé dans votre PATH (macOS et Linux ; sous Windows, récupérez le .zip depuis la page des releases) ; relayium --version confirme l'installation, et relayium.com/cli liste toutes les options d'installation. Sans cela, relayium login affiche seulement « command not found ».",
          "Ayez un compte Relayium gratuit. L'étape dans le navigateur approuve la connexion pour votre compte, il vous en faut donc un avant de pouvoir approuver — connectez-vous d'abord sur relayium.com, ou créez-en un là-bas. Seul le téléversement demande le compte ; le téléchargement jamais.",
          "Un moyen d'amener un lien jusqu'à l'autre machine — une application de notes, une fenêtre de chat, un gestionnaire de mots de passe. Quiconque détient le lien peut télécharger le fichier, traitez-le donc comme un mot de passe.",
        ],
      },
    },
    {
      heading: "Lier cette machine à votre compte (une seule fois)",
      body: [
        "up doit savoir sous quel compte stocker, alors connectez-vous une fois par machine. C'est une connexion d'appareil approuvée dans le navigateur — vous ne tapez rien dans le terminal, hormis le code que vous confirmez :",
      ],
      code: ["relayium login"],
      bullets: [
        "La CLI affiche un code court et une URL (relayium.com/device). Ouvrez-la dans le navigateur où vous êtes connecté à relayium.com (connectez-vous-y d'abord si ce n'est pas le cas), saisissez le code et approuvez — cette machine est désormais liée.",
        "La connexion est enregistrée sous ~/.config/relayium/, vous ne le faites donc qu'une fois par machine. relayium whoami montre à qui vous êtes lié ; relayium logout l'efface.",
        "Pour révoquer une machine plus tard, supprimez son appareil depuis la page « appareils » de votre compte dans le navigateur.",
      ],
    },
    {
      heading: "Téléverser depuis le premier ordinateur",
      body: ["up parcourt les fichiers indiqués, les chiffre localement, téléverse le chiffré et affiche un lien de récupération :"],
      steps: [
        {
          text: "Vérifiez que cette machine est toujours liée à votre compte. La commande affiche le compte et le serveur auquel il est lié ; si elle indique que vous n'êtes pas connecté, faites d'abord l'étape de connexion ci-dessus.",
          code: ["relayium whoami"],
        },
        {
          text: "Téléversez le fichier. up le chiffre en local, n'envoie que du texte chiffré et affiche le lien de retrait sur la sortie standard.",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "Ajoutez une option de conservation si les 24 heures par défaut ne vous conviennent pas. Votre offre plafonne la durée que le serveur retiendra réellement.",
          code: [
            `# choisissez sa durée de vie (par défaut : 24 heures) :
relayium up ./report.pdf --burn              # supprimé après un téléchargement
relayium up ./report.pdf --ttl 7d            # conservé 7 jours (plafond selon l'offre)
relayium up ./report.pdf --max-downloads 5   # 5 téléchargements autorisés, puis supprimé`,
          ],
        },
        {
          text: "Amenez le lien là où la deuxième machine pourra le lire. Seul le lien passe sur la sortie standard, un tube reste donc propre.",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "À quoi ressemble un téléversement réussi",
        body: [
          "Une barre de progression défile sur la sortie d'erreur pendant l'envoi, puis s'efface. Le lien arrive seul sur la sortie standard, et l'indication destinée à l'humain — ainsi qu'une éventuelle note de conservation — suit sur la sortie d'erreur.",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "Rétention : --burn supprime le fichier après un seul téléchargement ; --ttl <durée> le conserve un temps fixe ; --max-downloads <n> autorise un nombre fixe. Si vous n'en donnez aucun, le lien vit 24 heures — la valeur par défaut en l'absence de --ttl.",
        "--ttl accepte une durée avec unité — 30m, 12h, 7d, 2w — ou un simple nombre de secondes : --ttl 3600 et --ttl 1h sont la même demande. Votre offre fixe le plafond : 1 jour en Free, 3 jours en Plus, 7 jours en Pro, 14 jours en Max. Demandez plus que votre plafond et le serveur ne le conserve silencieusement que jusqu'au plafond — up affiche ensuite une note indiquant la durée réellement retenue.",
      ],
    },
    {
      heading: "Télécharger sur le deuxième ordinateur",
      body: [
        "Sur l'autre machine, passez le lien à down. Pas de connexion, pas de configuration — la clé qui déchiffre le fichier est dans le lien, donc down n'a besoin de rien de votre compte :",
      ],
      steps: [
        {
          text: "Amenez le lien sur la deuxième machine comme bon vous semble. Rien n'a besoin d'y être installé ni connecté, hormis la CLI elle-même.",
        },
        {
          text: "Passez-le à down entre apostrophes, avec le répertoire où les fichiers doivent atterrir.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "Omettez le répertoire pour atterrir dans le répertoire courant.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "À quoi ressemble un téléchargement réussi",
        body: [
          "Chaque fichier écrit est listé sur la sortie standard, un par ligne, et le nombre et la destination sont confirmés sur la sortie d'erreur.",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "Votre lien de partage",
        linkToken: "votre lien",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "Enregistrer dans (collez la sortie de votre pwd)",
        destToken: "répertoire cible",
        destPlaceholder: "/home/vous/downloads",
        copy: "Copier la commande",
        copied: "Copié",
      },
      bullets: [
        "Si le fichier était en mode burn, a atteint sa limite de téléchargements ou a expiré, le lien est épuisé et down signale qu'il n'existe plus.",
      ],
    },
    {
      heading: "Fonctionne aussi avec le site web",
      body: ["Le lien est le même que celui du site web, donc la CLI et le navigateur interopèrent librement :"],
      bullets: [
        "Un lien issu de relayium up s'ouvre dans un navigateur — donnez-le à quelqu'un sans la CLI et il télécharge depuis le web.",
        "Un lien de partage créé sur relayium.com peut être récupéré avec relayium down sur une autre machine.",
      ],
    },
    {
      heading: "Ce que le serveur peut voir et ne peut pas voir",
      body: ["Les transferts cloud restent chiffrés de bout en bout :"],
      bullets: [
        "Votre fichier est chiffré sur votre machine avant d'être téléversé. La clé de déchiffrement ne vit que dans le fragment #k= du lien et n'est jamais envoyée au serveur — Relayium stocke un chiffré qu'il ne peut pas lire, noms de fichiers compris.",
        "Cela signifie aussi que le lien est le seul chemin de retour vers le fichier : perdez-le et le fichier est irrécupérable, par vous comme par nous.",
      ],
    },
    {
      heading: "Quand un lien ne fonctionne pas",
      body: [
        "Quatre pannes couvrent presque tous les up et down ratés, et aucune ne demande de deviner : l'état qui tranche est soit affiché par une commande, soit visible dans la commande que vous avez tapée.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "up refuse avec « run relayium login first ».",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Le téléversement range le fichier sous votre compte, cette machine a donc besoin d'informations d'identification. Lancez relayium login et approuvez dans le navigateur sur relayium.com/device ; whoami affiche ensuite votre compte et le serveur auquel il est lié.",
          },
          {
            symptom: "down n'arrive pas à lire le lien, et la clé semble avoir disparu.",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "Un # sans guillemets commence un commentaire dans la plupart des shells, donc tout ce qui suit #k= n'est jamais parvenu à la commande ; echo montre exactement ce qui a survécu. Encadrez le lien entier d'apostrophes et le fragment, c'est-à-dire la clé de déchiffrement, arrive intact.",
          },
          {
            symptom: "Le lien s'éteint plus tôt que le --ttl demandé.",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "Le serveur ramène silencieusement une demande au plafond de votre offre — 1 jour en Free, 3 en Plus, 7 en Pro, 14 en Max — et up affiche ensuite cette note pour dire ce que vous avez réellement obtenu. --burn et --max-downloads mettent aussi fin à un lien plus tôt. Téléversez de nouveau pour en obtenir un frais.",
          },
          {
            symptom: "Vous êtes connecté, mais up dit que vous êtes connecté ailleurs.",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "Un --server qui n'a pas émis votre jeton est refusé plutôt que de recevoir vos informations d'identification, ce qui les divulguerait sans même authentifier là-bas. Retirez --server pour utiliser le serveur lié que whoami vient d'afficher, ou lancez d'abord relayium login sur l'autre hôte.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Pour téléverser, et pour envoyer quand un code doit être généré. relayium up exige toujours relayium login, afin que le fichier soit stocké sous votre compte. relayium send ne l'exige que lorsque le serveur doit générer un nouveau code d'appairage pour vous — lancez send avec un code qu'on vous a remis et il n'en génère aucun, donc il ne demande pas de connexion. relayium down et relayium receive ne demandent aucun compte, et push/pull, daemon-direct et sync fonctionnent sans.",
      },
      {
        q: "Mon fichier est-il chiffré ?",
        a: "Oui, de bout en bout. Il est chiffré sur votre machine avant le téléversement ; la clé ne vit que dans le fragment #k= du lien et n'est jamais envoyée au serveur. Relayium stocke un chiffré qu'il ne peut pas lire, noms de fichiers compris.",
      },
      {
        q: "Et si je perds le lien ?",
        a: "Le lien porte l'unique copie de la clé de déchiffrement ; un lien perdu signifie donc un fichier irrécupérable — rien sur le serveur ne permet de le restaurer.",
      },
      {
        q: "Puis-je limiter qui le télécharge ?",
        a: "Quiconque a le lien peut télécharger, alors partagez-le en privé. Utilisez --burn pour un seul téléchargement, --max-downloads <n> pour plafonner le nombre, et --ttl <durée> pour le faire expirer après un temps donné.",
      },
      {
        q: "Est-ce compatible avec le site web ?",
        a: "Oui. Un lien de relayium up s'ouvre dans un navigateur, et un lien de partage créé sur relayium.com peut être récupéré avec relayium down sur une autre machine.",
      },
    ],
  },
  cta: {
    text: "Prêt à déplacer un fichier entre vos propres machines ? Installez la CLI, lancez relayium login, puis faites-en un up.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire aussi",
};

const ar = {
  title: "ادفع الملفات إلى السحابة، واسحبها على حاسوب آخر",
  description:
    "نقل ملفات غير متزامن عبر حساب Relayium لديك: ارفع من جهاز باستخدام relayium up، ونزّل على جهاز آخر باستخدام relayium down متى ناسبك ذلك — مشفّر من الطرف إلى الطرف، والرفع وحده هو ما يحتاج إلى حساب.",
  updatedLabel: "آخر تحديث",
  lead: [
    "أحيانًا لا يكون الحاسوبان مستيقظين في الوقت نفسه أبدًا. تريد أن تُسقط ملفًا من حاسوب العمل المحمول الليلة وتلتقطه من سطح مكتب المنزل غدًا، دون أن ينتظر أحد اتصالًا مباشرًا. يفعل relayium up وrelayium down ذلك بالضبط: up يشفّر ويرفع إلى حسابك، وdown يجلبه ويفكّ تشفيره لاحقًا على أي جهاز — بلا مصافحة من الند للند، وبلا خادم يدخل إليه كلاكما عبر ssh.",
    "هذا هو الجزء الرئيسي من CLI الذي يستخدم حساب Relayium لديك، إلى جانب send الذي يحتاجه لإصدار رمز اقتران. أما البقية فالربط فيها اختياري: push/pull، وdaemon direct، وsync تظل تعمل بلا تسجيل دخول، وكذلك receive. التنزيل لا يحتاج إلى حساب على الإطلاق، فقط الرابط.",
  ],
  sections: [
    {
      heading: "متى تلجأ إليه",
      body: ["اختر الوضع بحسب ما إذا كان الطرف البعيد متصلًا وكيف يصل كل جهاز إلى الآخر:"],
      bullets: [
        "‏up / down (هذا الدليل) — الجهازان لا يكونان متصلين معًا أبدًا. ترفع الآن؛ وتنزّل أنت (أو جهاز آخر) لاحقًا. يمرّ عبر حسابك.",
        "‏send / receive — كلا الطرفين متصل الآن ويريدان نقلًا مباشرًا من الند للند عبر رمز لمرة واحدة.",
        "‏push / pull — يمكنك بالفعل الدخول إلى الجهاز البعيد عبر ssh.",
        "الأمران اللذان يتطلبان relayium login هما up وsend — الأول ليخزّن الملف تحت حسابك، والثاني فقط حين يلزمه إصدار رمز اقتران (ومع رمز سُلِّم إليك لا يلزمه شيء). أما down وreceive وpush/pull وdaemon direct وsync فلا تحتاج إلى حساب.",
      ],
    },
    {
      heading: "قبل أن تبدأ",
      body: [
        "شيئان لمرة واحدة قبل أول up لك — ثبّت CLI، وامتلك حسابًا. تملك كليهما بالفعل؟ تخطَّ إلى الأمام.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "ثبّت CLI كي يوجد أمر relayium. يُسقط السطر أدناه ملفًا ثنائيًا مُسبق البناء في PATH لديك (macOS وLinux؛ على Windows، احصل على ملف .zip من صفحة الإصدارات)؛ ويؤكّده relayium --version، وrelayium.com/cli يسرد كل خيارات التثبيت. تخطَّ هذا وسيطبع relayium login فقط «command not found».",
          "امتلك حساب Relayium مجانيًا. تعتمد خطوة المتصفح تسجيل الدخول على حسابك، فتحتاج إليه قبل أن تتمكن من الاعتماد — سجّل الدخول في relayium.com أولًا، أو أنشئ واحدًا هناك إن لم تكن قد فعلت. الرفع وحده هو ما يحتاج إلى الحساب؛ أما التنزيل فلا يحتاج أبدًا.",
          "وسيلة لنقل رابط واحد إلى الجهاز الآخر، كتطبيق ملاحظات أو نافذة محادثة أو مدير كلمات مرور. كل من يملك الرابط يستطيع تنزيل الملف، فتعامل معه كأنه كلمة مرور.",
        ],
      },
    },
    {
      heading: "اربط هذا الجهاز بحسابك (مرة واحدة)",
      body: [
        "يحتاج up إلى معرفة حساب مَن يُخزَّن تحته، فسجّل الدخول مرة واحدة لكل جهاز. إنه تسجيل دخول جهاز معتمَد من المتصفح — لا يُكتب في الطرفية شيء سوى الرمز الذي تؤكّده:",
      ],
      code: ["relayium login"],
      bullets: [
        "يطبع CLI رمزًا قصيرًا ورابطًا (relayium.com/device). افتحه في المتصفح الذي سجّلت فيه الدخول إلى relayium.com (سجّل الدخول هناك أولًا إن لم تكن قد فعلت)، وأدخل الرمز واعتمد — هذا الجهاز مربوط الآن.",
        "يُحفظ تسجيل الدخول تحت ~/.config/relayium/، فتفعله مرة واحدة فقط لكل جهاز. يُظهر relayium whoami بمن أنت مربوط؛ وrelayium logout يمسحه.",
        "لإلغاء جهاز لاحقًا، احذف جهازه من صفحة أجهزة حسابك في المتصفح.",
      ],
    },
    {
      heading: "ارفع من الحاسوب الأول",
      body: ["يمرّ up على الملفات التي تعطيه إياها، ويشفّرها محليًا، ويرفع النص المُشفَّر، ويطبع رابط استلام:"],
      steps: [
        {
          text: "تأكّد من أن هذا الجهاز ما زال مرتبطًا بحسابك. يطبع الأمر الحساب والخادم المرتبط به، وإن قال إنك غير مسجَّل الدخول فأنجز خطوة تسجيل الدخول أعلاه أولًا.",
          code: ["relayium whoami"],
        },
        {
          text: "ارفع الملف. يشفّره up محليًا، ولا يرسل إلا نصًا مُشفَّرًا، ويطبع رابط الاستلام على المخرَج القياسي.",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "أضِف خيار احتفاظ إن كان الافتراضي البالغ 24 ساعة لا يناسبك. وباقتك هي ما يحدّ المدة التي سيحتفظ بها الخادم فعليًا.",
          code: [
            `# اختر مدة بقائه (الافتراضي: 24 ساعة):
relayium up ./report.pdf --burn              # يُحذف بعد تنزيل واحد
relayium up ./report.pdf --ttl 7d            # يُحفظ 7 أيام (خطتك تحدّد السقف)
relayium up ./report.pdf --max-downloads 5   # يسمح بـ 5 تنزيلات ثم يختفي`,
          ],
        },
        {
          text: "انقل الرابط إلى حيث يستطيع الجهاز الثاني قراءته. لا يخرج على المخرَج القياسي سوى الرابط، فيبقى الأنبوب نظيفًا.",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "كيف يبدو الرفع الناجح",
        body: [
          "يعمل شريط تقدّم على مخرَج الأخطاء أثناء الرفع ثم يُمحى. ويصل الرابط وحده على المخرَج القياسي، بينما يتبعه على مخرَج الأخطاء التلميح الموجَّه للإنسان، وأي ملاحظة عن مدة الاحتفاظ.",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "الاحتفاظ: --burn يزيل الملف بعد تنزيل واحد؛ و ‎--ttl <duration>‎ يبقيه مدة ثابتة؛ و ‎--max-downloads <n>‎ يسمح بعدد ثابت من التنزيلات. إن لم تعطِ أيًّا منها عاش الرابط 24 ساعة — وهذا هو الافتراضي عند غياب --ttl.",
        "يقبل --ttl مدةً بوحدة — 30m أو 12h أو 7d أو 2w — كما يقبل عدد ثوانٍ مجردًا، فـ --ttl 3600 و --ttl 1h طلب واحد. وخطتك تحدّد السقف: يوم واحد في Free، و3 أيام في Plus، و7 أيام في Pro، و14 يومًا في Max. وإن طلبت أطول من سقفك، احتفظ الخادم به حتى السقف فقط وبصمت — ثم يطبع up سطرًا يخبرك بالمدة التي حُفِظ بها فعلًا.",
      ],
    },
    {
      heading: "نزّل على الحاسوب الثاني",
      body: [
        "على الجهاز الآخر، سلّم الرابط إلى down. بلا تسجيل دخول، بلا إعداد — المفتاح الذي يفكّ تشفير الملف داخل الرابط، فلا يحتاج down إلى شيء من حسابك:",
      ],
      steps: [
        {
          text: "انقل الرابط إلى الجهاز الثاني بالطريقة التي تناسبك. لا شيء يحتاج إلى تثبيت أو تسجيل دخول هناك سوى واجهة CLI نفسها.",
        },
        {
          text: "مرِّره إلى down بين علامتَي اقتباس مفردتين، مع المجلد الذي يجب أن تحطّ فيه الملفات.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "احذف المجلد لتحطّ في المجلد الحالي.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "كيف يبدو التنزيل الناجح",
        body: [
          "يُدرَج كل ملف كتبه على المخرَج القياسي، سطرًا لكل ملف، ويُؤكَّد العدد والوجهة على مخرَج الأخطاء.",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "رابط المشاركة لديك",
        linkToken: "رابطك",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "احفظ في (الصق مخرجات pwd لديك)",
        destToken: "المجلد الهدف",
        destPlaceholder: "/home/you/downloads",
        copy: "انسخ الأمر",
        copied: "تم النسخ",
      },
      bullets: [
        "إذا ضُبط الملف على الحرق، أو بلغ حد تنزيلاته، أو انتهت صلاحيته، فالرابط مُستنفَد وسيبلّغ down أنه لم يعد موجودًا.",
      ],
    },
    {
      heading: "يعمل مع الموقع أيضًا",
      body: ["الرابط هو نفسه الذي يستخدمه الموقع، فيتبادل CLI والمتصفح العمل بحرية:"],
      bullets: [
        "رابط من relayium up يُفتح في متصفح — سلّمه لشخص لا يملك CLI فينزّل من الويب.",
        "رابط مشاركة أُنشئ على relayium.com يمكن جلبه بـ relayium down على جهاز آخر.",
      ],
    },
    {
      heading: "ما يمكن للخادم رؤيته وما لا يمكنه",
      body: ["تظل عمليات النقل السحابي مشفّرة من الطرف إلى الطرف:"],
      bullets: [
        "يُشفَّر ملفك على جهازك قبل رفعه. يعيش مفتاح فك التشفير فقط في الجزء #k= من الرابط ولا يُرسَل إلى الخادم أبدًا — يخزّن Relayium نصًا مُشفَّرًا لا يستطيع قراءته، بما في ذلك أسماء الملفات.",
        "يعني ذلك أيضًا أن الرابط هو الطريق الوحيد للعودة إلى الملف: افقده يصبح الملف غير قابل للاسترجاع، لا منك ولا منّا.",
      ],
    },
    {
      heading: "حين لا يعمل الرابط",
      body: [
        "أربعة أعطال تغطي تقريبًا كل عملية up أو down فاشلة، ولا يحتاج أي منها إلى تخمين: فالحالة التي تحسم الأمر إما يطبعها أمر، وإما تراها ماثلة في الأمر الذي كتبته.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "يرفض up ويقول «run relayium login first».",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "يحفظ الرفع الملف تحت حسابك، فيحتاج هذا الجهاز إلى بيانات اعتماد. شغّل relayium login ووافِق في المتصفح على relayium.com/device، فيطبع whoami بعدها حسابك والخادم المرتبط به.",
          },
          {
            symptom: "يعجز down عن قراءة الرابط، ويبدو أن المفتاح اختفى.",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "تبدأ العلامة # بلا اقتباس تعليقًا في معظم الأصداف، فلم يصل إلى الأمر أي شيء ابتداءً من ‎#k=‎، ويُظهر echo ما بقي منه بالضبط. ضع الرابط كله بين علامتَي اقتباس مفردتين فيصل الجزء الذي هو مفتاح فك التشفير سليمًا.",
          },
          {
            symptom: "ينتهي مفعول الرابط قبل مدة --ttl التي طلبتها.",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "يقلّص الخادم بصمت أي طلب يتجاوز سقف باقتك — يوم واحد في Free، وثلاثة في Plus، وسبعة في Pro، وأربعة عشر في Max — ثم يطبع up هذه الملاحظة ليخبرك بما حصلت عليه فعلًا. كما ينهي --burn و--max-downloads الرابط مبكرًا. ارفع من جديد للحصول على رابط جديد.",
          },
          {
            symptom: "أنت مسجَّل الدخول، لكن up يقول إنك مسجَّل في مكان آخر.",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "يُرفض أي --server لم يُصدِر رمزك بدل أن تُرسَل إليه بيانات اعتمادك، إذ إن إرسالها يكشفها ولا يصادق عليك هناك أصلًا. إما أن تحذف --server ليستخدم الخادم المرتبط الذي طبعه whoami للتو، وإما أن تشغّل relayium login على المضيف الآخر أولًا.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى حساب؟",
        a: "للرفع، وللإرسال حين يلزم إصدار رمز. يتطلب relayium up دائمًا تسجيل relayium login كي يُخزَّن الملف تحت حسابك. أما relayium send فلا يتطلبه إلا حين يلزم الخادم أن يُصدر لك رمز اقتران جديدًا — فإن شغّلت send برمزٍ سلّمه إليك أحدهم، فهو لا يُصدر شيئًا ولا يلزمه تسجيل الدخول. أما relayium down وrelayium receive فلا يحتاجان إلى حساب، وكذلك تعمل push/pull، وdaemon direct، وsync بلا واحد.",
      },
      {
        q: "هل ملفي مشفّر؟",
        a: "نعم، من الطرف إلى الطرف. يُشفَّر على جهازك قبل الرفع؛ ويعيش المفتاح فقط في الجزء #k= من الرابط ولا يُرسَل إلى الخادم أبدًا. يخزّن Relayium نصًا مُشفَّرًا لا يستطيع قراءته، بما في ذلك أسماء الملفات.",
      },
      {
        q: "ماذا لو فقدت الرابط؟",
        a: "يحمل الرابط النسخة الوحيدة من مفتاح فك التشفير، فالرابط المفقود يعني ملفًا غير قابل للاسترجاع — لا يوجد على الخادم شيء يمكنه استعادته.",
      },
      {
        q: "هل يمكنني تقييد من ينزّله؟",
        a: "أي شخص يملك الرابط يستطيع التنزيل، فشاركه بشكل خاص. استخدم --burn للسماح بتنزيل واحد، أو ‎--max-downloads <n>‎ لتحديد العدد، و ‎--ttl <duration>‎ لإنهاء صلاحيته بعد وقت محدد.",
      },
      {
        q: "هل يعمل مع الموقع؟",
        a: "نعم. رابط من relayium up يُفتح في متصفح، ورابط مشاركة أُنشئ على relayium.com يمكن جلبه بـ relayium down على جهاز آخر.",
      },
    ],
  },
  cta: {
    text: "مستعد لنقل ملف بين أجهزتك الخاصة؟ ثبّت CLI، ونفّذ relayium login، ثم ارفعه بـ up.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Sube archivos a la nube y recógelos en otro ordenador",
  description:
    "Transferencia de archivos asíncrona a través de tu cuenta de Relayium: sube desde una máquina con relayium up y descarga en otra con relayium down cuando te venga bien — cifrado de extremo a extremo, y solo subir necesita una cuenta.",
  updatedLabel: "Última actualización",
  lead: [
    "A veces los dos ordenadores nunca están despiertos a la vez. Quieres soltar un archivo desde el portátil del trabajo esta noche y cogerlo desde el sobremesa de casa mañana, sin que nadie espere una conexión en directo. relayium up y relayium down hacen exactamente eso: up cifra y sube a tu cuenta, y down lo recupera y lo descifra después en cualquier máquina — sin handshake de igual a igual, sin un servidor al que las dos partes entren por ssh.",
    "Esta es la parte principal de la CLI que usa tu cuenta de Relayium, junto con send, que la necesita para generar un código de emparejamiento. Para el resto la vinculación es opcional: push/pull, daemon directo y sync siguen funcionando sin iniciar sesión, y receive también. Descargar no necesita ninguna cuenta, solo el enlace.",
  ],
  sections: [
    {
      heading: "Cuándo recurrir a ello",
      body: ["Elige el modo según si el otro extremo está en línea y cómo se alcanzan las dos máquinas entre sí:"],
      bullets: [
        "up / down (esta guía) — las dos máquinas nunca están en línea a la vez. Subes ahora; tú (u otra máquina) descargas después. Pasa por tu cuenta.",
        "send / receive — ambos extremos están en línea ahora mismo y quieren una transferencia directa de igual a igual con un código de un solo uso.",
        "push / pull — ya puedes entrar por ssh a la máquina remota.",
        "Los que piden relayium login son up y send — up para guardar el archivo bajo tu cuenta, send solo cuando tiene que generar un código de emparejamiento (con uno que te hayan dado, ninguno). down, receive, push/pull, daemon directo y sync no necesitan cuenta.",
      ],
    },
    {
      heading: "Antes de empezar",
      body: [
        "Dos cosas de una sola vez antes de tu primer up — instalar la CLI y tener una cuenta. ¿Ya tienes ambas? Sáltate esto.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Instala la CLI para que exista el comando relayium. La línea de abajo deja un binario precompilado en tu PATH (macOS y Linux; en Windows, coge el .zip de la página de releases); relayium --version lo confirma, y relayium.com/cli lista todas las opciones de instalación. Sáltate esto y relayium login solo imprimirá « command not found ».",
          "Ten una cuenta gratuita de Relayium. El paso del navegador aprueba el inicio de sesión contra tu cuenta, así que necesitas una antes de poder aprobar — inicia sesión primero en relayium.com, o crea una allí si no la tienes. Solo subir necesita la cuenta; descargar nunca.",
          "Una forma de llevar un enlace a la otra máquina: una app de notas, una ventana de chat, un gestor de contraseñas. Cualquiera que tenga el enlace puede descargar el archivo, así que trátalo como una contraseña.",
        ],
      },
    },
    {
      heading: "Vincula esta máquina a tu cuenta (una vez)",
      body: [
        "up necesita saber bajo qué cuenta almacenar, así que inicia sesión una vez por máquina. Es un inicio de sesión de dispositivo aprobado en el navegador — no se escribe nada en la terminal salvo el código que confirmas:",
      ],
      code: ["relayium login"],
      bullets: [
        "La CLI imprime un código corto y una URL (relayium.com/device). Ábrela en el navegador donde has iniciado sesión en relayium.com (inicia sesión allí primero si no lo has hecho), introduce el código y aprueba — esta máquina queda ahora vinculada.",
        "El inicio de sesión se guarda en ~/.config/relayium/, así que solo lo haces una vez por máquina. relayium whoami muestra a quién estás vinculado; relayium logout lo borra.",
        "Para revocar una máquina más adelante, elimina su dispositivo desde la página de dispositivos de tu cuenta en el navegador.",
      ],
    },
    {
      heading: "Sube desde el primer ordenador",
      body: ["up recorre los archivos que le das, los cifra localmente, sube el texto cifrado e imprime un enlace de recogida:"],
      steps: [
        {
          text: "Comprueba que esta máquina sigue vinculada a tu cuenta. Imprime la cuenta y el servidor al que está vinculada; si dice que no has iniciado sesión, haz antes el paso de inicio de sesión de arriba.",
          code: ["relayium whoami"],
        },
        {
          text: "Sube el archivo. up lo cifra en local, envía solo texto cifrado e imprime el enlace de recogida en la salida estándar.",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "Añade una opción de retención si las 24 horas por defecto no te sirven. Tu plan pone el tope de cuánto lo guardará realmente el servidor.",
          code: [
            `# elige cuánto vive (por defecto: 24 horas):
relayium up ./report.pdf --burn              # borrado tras una descarga
relayium up ./report.pdf --ttl 7d            # guardado 7 días (tu plan pone el tope)
relayium up ./report.pdf --max-downloads 5   # 5 descargas y luego desaparece`,
          ],
        },
        {
          text: "Lleva el enlace a donde la segunda máquina pueda leerlo. A la salida estándar solo va el enlace, así que una tubería queda limpia.",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "Cómo se ve una subida correcta",
        body: [
          "Durante la subida corre una barra de progreso en la salida de error, que luego se borra. El enlace aparece solo en la salida estándar, y la pista para humanos —más cualquier aviso de retención— la sigue en la salida de error.",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "Retención: --burn elimina el archivo tras una sola descarga; --ttl <duración> lo conserva un tiempo fijo; --max-downloads <n> permite un número fijo de descargas. Si no das ninguno de los tres, el enlace vive 24 horas — el valor por defecto cuando falta --ttl.",
        "--ttl acepta una duración con unidad —30m, 12h, 7d, 2w— o un simple número de segundos, así que --ttl 3600 y --ttl 1h son la misma petición. Tu plan pone el tope: 1 día en Free, 3 días en Plus, 7 días en Pro, 14 días en Max. Si pides más que tu tope, el servidor lo guarda en silencio solo hasta el tope, y up imprime después una nota diciéndote cuánto lo guardó en realidad.",
      ],
    },
    {
      heading: "Descarga en el segundo ordenador",
      body: [
        "En la otra máquina, pasa el enlace a down. Sin iniciar sesión, sin configuración — la clave que descifra el archivo está dentro del enlace, así que down no necesita nada de tu cuenta:",
      ],
      steps: [
        {
          text: "Lleva el enlace a la segunda máquina como prefieras. Ahí no hace falta instalar ni iniciar sesión en nada más allá de la propia CLI.",
        },
        {
          text: "Pásaselo a down entre comillas simples, junto con el directorio donde deben aterrizar los archivos.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "Omite el directorio para guardarlo en el actual.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "Cómo se ve una descarga correcta",
        body: [
          "Cada archivo escrito se lista en la salida estándar, uno por línea, y el número y el destino se confirman en la salida de error.",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "Tu enlace para compartir",
        linkToken: "tu enlace",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "Guardar en (pega la salida de tu pwd)",
        destToken: "directorio de destino",
        destPlaceholder: "/home/you/downloads",
        copy: "Copiar comando",
        copied: "Copiado",
      },
      bullets: [
        "Si el archivo estaba en modo de un solo uso, ha alcanzado su límite de descargas o ha caducado, el enlace está agotado y down informa de que ya no existe.",
      ],
    },
    {
      heading: "Funciona también con el sitio web",
      body: ["El enlace es el mismo que usa el sitio web, así que la CLI y el navegador interoperan libremente:"],
      bullets: [
        "Un enlace de relayium up se abre en un navegador — dáselo a alguien que no tenga la CLI y descargará desde la web.",
        "Un enlace para compartir creado en relayium.com puede recogerse con relayium down en otra máquina.",
      ],
    },
    {
      heading: "Qué puede ver el servidor y qué no",
      body: ["Las transferencias en la nube siguen cifradas de extremo a extremo:"],
      bullets: [
        "Tu archivo se cifra en tu máquina antes de subirse. La clave de descifrado vive solo en el fragmento #k= del enlace y nunca se envía al servidor — Relayium almacena texto cifrado que no puede leer, incluidos los nombres de los archivos.",
        "Eso también significa que el enlace es la única vía de vuelta al archivo: si lo pierdes, el archivo es irrecuperable, ni por ti ni por nosotros.",
      ],
    },
    {
      heading: "Cuando un enlace no funciona",
      body: [
        "Cuatro fallos cubren casi todos los up y down que salen mal, y ninguno exige adivinar: el estado que lo decide lo imprime un comando, o se ve en el comando que escribiste.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "up se niega con «run relayium login first».",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Subir guarda el archivo bajo tu cuenta, así que esta máquina necesita credenciales. Ejecuta relayium login y apruébalo en el navegador en relayium.com/device; después whoami imprime tu cuenta y el servidor al que está vinculada.",
          },
          {
            symptom: "down no consigue leer el enlace y la clave parece haberse esfumado.",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "Un # sin comillas inicia un comentario en la mayoría de las shells, así que todo lo que va desde #k= nunca llegó al comando; echo muestra exactamente lo que sobrevivió. Envuelve el enlace entero en comillas simples y el fragmento, que es la clave de descifrado, llega intacto.",
          },
          {
            symptom: "El enlace muere antes del --ttl que pediste.",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "El servidor recorta en silencio una petición que supere el tope de tu plan —1 día en Free, 3 en Plus, 7 en Pro, 14 en Max— y up imprime después ese aviso para decir lo que realmente obtuviste. --burn y --max-downloads también terminan un enlace antes. Vuelve a subirlo para obtener uno nuevo.",
          },
          {
            symptom: "Has iniciado sesión, pero up dice que la tienes iniciada en otro sitio.",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "Un --server que no emitió tu token se rechaza en lugar de recibir tus credenciales, lo que las filtraría y ni siquiera te autenticaría allí. O quitas --server para usar el servidor vinculado que whoami acaba de imprimir, o ejecutas antes relayium login contra el otro host.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito una cuenta?",
        a: "Para subir, y para enviar cuando hay que generar un código. relayium up requiere siempre relayium login, para guardar el archivo bajo tu cuenta. relayium send lo requiere solo cuando el servidor tiene que generar un código de emparejamiento nuevo para ti — si ejecutas send con un código que te han dado, no genera ninguno, así que no hace falta iniciar sesión. relayium down y relayium receive no necesitan cuenta, y push/pull, daemon directo y sync funcionan sin una.",
      },
      {
        q: "¿Está cifrado mi archivo?",
        a: "Sí, de extremo a extremo. Se cifra en tu máquina antes de subirse; la clave vive solo en el fragmento #k= del enlace y nunca se envía al servidor. Relayium almacena texto cifrado que no puede leer, incluidos los nombres de los archivos.",
      },
      {
        q: "¿Y si pierdo el enlace?",
        a: "El enlace lleva la única copia de la clave de descifrado, así que un enlace perdido significa un archivo irrecuperable — no hay nada en el servidor que pueda recuperarlo.",
      },
      {
        q: "¿Puedo limitar quién lo descarga?",
        a: "Cualquiera con el enlace puede descargar, así que compártelo en privado. Usa --burn para permitir una sola descarga, o --max-downloads <n> para limitar el número, y --ttl <duración> para que caduque tras un tiempo fijo.",
      },
      {
        q: "¿Funciona con el sitio web?",
        a: "Sí. Un enlace de relayium up se abre en un navegador, y un enlace para compartir creado en relayium.com puede recogerse con relayium down en otra máquina.",
      },
    ],
  },
  cta: {
    text: "¿Listo para mover un archivo entre tus propias máquinas? Instala la CLI, ejecuta relayium login y súbelo con up.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Suba arquivos para a nuvem e os pegue em outro computador",
  description:
    "Transferência de arquivos assíncrona pela sua conta do Relayium: envie de uma máquina com relayium up e baixe em outra com relayium down quando for conveniente — com criptografia de ponta a ponta, e só o envio precisa de conta.",
  updatedLabel: "Última atualização",
  lead: [
    "Às vezes os dois computadores nunca estão ligados ao mesmo tempo. Você quer soltar um arquivo do notebook do trabalho hoje à noite e pegá-lo no desktop de casa amanhã, sem ninguém esperando uma conexão ao vivo. relayium up e relayium down fazem exatamente isso: o up criptografa e envia para a sua conta, e o down o busca e o descriptografa depois em qualquer máquina — sem handshake ponto a ponto, sem um servidor no qual os dois entrem por ssh.",
    "Esta é a principal parte da CLI que usa a sua conta do Relayium, ao lado do send, que precisa dela para gerar um código de emparelhamento. Para o resto a vinculação é opcional: push/pull, daemon direto e sync continuam funcionando sem login, e o receive também. Baixar não precisa de conta alguma, apenas do link.",
  ],
  sections: [
    {
      heading: "Quando recorrer a isso",
      body: ["Escolha o modo conforme a outra ponta esteja online e como as duas máquinas se alcançam:"],
      bullets: [
        "up / down (este guia) — as duas máquinas nunca estão online juntas. Você envia agora; você (ou outra máquina) baixa depois. Passa pela sua conta.",
        "send / receive — as duas pontas estão online agora e querem uma transferência ponto a ponto direta com um código de uso único.",
        "push / pull — você já consegue entrar por ssh na máquina remota.",
        "Os que pedem relayium login são o up e o send — o up para guardar o arquivo sob a sua conta, o send apenas quando precisa gerar um código de emparelhamento (com um código que lhe deram, nenhum). O down, o receive, push/pull, daemon direto e sync não precisam de conta.",
      ],
    },
    {
      heading: "Antes de começar",
      body: [
        "Duas coisas para fazer uma vez só antes do seu primeiro up — instalar a CLI e ter uma conta. Já tem as duas? Pule adiante.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      prereqs: {
        label: "O que você precisa",
        items: [
          "Instale a CLI para que o comando relayium exista. A linha abaixo coloca um binário pré-compilado no seu PATH (macOS e Linux; no Windows, pegue o .zip na página de releases); relayium --version confirma, e relayium.com/cli lista todas as opções de instalação. Pule isso e o relayium login só imprimirá “command not found”.",
          "Tenha uma conta gratuita do Relayium. O passo do navegador aprova o login contra a sua conta, então você precisa de uma antes de poder aprovar — faça login em relayium.com primeiro, ou crie uma lá se ainda não tiver. Só o envio precisa da conta; baixar nunca.",
          "Um jeito de levar um link até a outra máquina: um app de notas, uma janela de chat, um gerenciador de senhas. Qualquer um com o link consegue baixar o arquivo, então trate-o como uma senha.",
        ],
      },
    },
    {
      heading: "Vincule esta máquina à sua conta (uma vez)",
      body: [
        "O up precisa saber sob qual conta armazenar, então faça login uma vez por máquina. É um login de dispositivo aprovado no navegador — nada é digitado no terminal além do código que você confirma:",
      ],
      code: ["relayium login"],
      bullets: [
        "A CLI imprime um código curto e uma URL (relayium.com/device). Abra-a no navegador em que você está logado no relayium.com (faça login lá primeiro se não estiver), digite o código e aprove — esta máquina está agora vinculada.",
        "O login é salvo em ~/.config/relayium/, então você só faz isso uma vez por máquina. relayium whoami mostra a quem você está vinculado; relayium logout o apaga.",
        "Para revogar uma máquina mais tarde, exclua o dispositivo dela na página de dispositivos da sua conta no navegador.",
      ],
    },
    {
      heading: "Envie a partir do primeiro computador",
      body: ["O up percorre os arquivos que você passa, criptografa-os localmente, envia o texto cifrado e imprime um link de retirada:"],
      steps: [
        {
          text: "Confirme que esta máquina continua vinculada à sua conta. Ela imprime a conta e o servidor a que está vinculada; se disser que você não está logado, faça antes o passo de login acima.",
          code: ["relayium whoami"],
        },
        {
          text: "Envie o arquivo. O up o criptografa localmente, manda só texto cifrado e imprime o link de retirada na saída padrão.",
          code: ["relayium up ./report.pdf"],
        },
        {
          text: "Acrescente uma opção de retenção se o padrão de 24 horas não servir. O seu plano limita quanto tempo o servidor de fato vai guardar.",
          code: [
            `# escolha quanto tempo ele vive (padrão: 24 horas):
relayium up ./report.pdf --burn              # apagado após um download
relayium up ./report.pdf --ttl 7d            # guardado por 7 dias (seu plano define o teto)
relayium up ./report.pdf --max-downloads 5   # 5 downloads permitidos, depois some`,
          ],
        },
        {
          text: "Leve o link para onde a segunda máquina consiga lê-lo. Só o link vai para a saída padrão, então um pipe fica limpo.",
          code: ["relayium up ./report.pdf | pbcopy"],
        },
      ],
      success: {
        label: "Como é um envio bem-sucedido",
        body: [
          "Durante o envio corre uma barra de progresso na saída de erro, que depois some. O link aparece sozinho na saída padrão, e a dica para humanos — mais qualquer aviso de retenção — vem em seguida na saída de erro.",
        ],
        code: [
          `relayium up ./report.pdf
https://relayium.com/d/7fK2p…#k=Xr8s…
opens in a browser, or fetch it with \`relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'\``,
        ],
      },
      bullets: [
        "Retenção: --burn remove o arquivo após um único download; --ttl <duração> o mantém por um tempo fixo; --max-downloads <n> permite um número fixo de downloads. Não informe nenhum dos três e o link vive 24 horas — o padrão quando --ttl está ausente.",
        "O --ttl aceita uma duração com unidade — 30m, 12h, 7d, 2w — ou um simples número de segundos, então --ttl 3600 e --ttl 1h são o mesmo pedido. O seu plano define o teto: 1 dia no Free, 3 dias no Plus, 7 dias no Pro, 14 dias no Max. Peça mais do que o seu teto e o servidor o guarda em silêncio apenas até o teto — o up imprime depois um aviso dizendo por quanto tempo ele realmente ficou guardado.",
      ],
    },
    {
      heading: "Baixe no segundo computador",
      body: [
        "Na outra máquina, passe o link para o down. Sem login, sem configuração — a chave que descriptografa o arquivo está dentro do link, então o down não precisa de nada da sua conta:",
      ],
      steps: [
        {
          text: "Leve o link até a segunda máquina do jeito que preferir. Ali não é preciso instalar nem logar em nada além da própria CLI.",
        },
        {
          text: "Passe-o para o down entre aspas simples, junto com o diretório onde os arquivos devem chegar.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
        },
        {
          text: "Omita o diretório para cair no atual.",
          code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…'"],
        },
      ],
      success: {
        label: "Como é um download bem-sucedido",
        body: [
          "Cada arquivo escrito é listado na saída padrão, um por linha, e a contagem e o destino são confirmados na saída de erro.",
        ],
        code: [
          `relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads
downloads/report.pdf
✓ downloaded 1 file(s) to ./downloads`,
        ],
      },
      widget: {
        kind: "downloadBuilder",
        linkLabel: "Seu link de compartilhamento",
        linkToken: "seu link",
        linkPlaceholder: "https://relayium.com/d/…#k=…",
        destLabel: "Salvar em (cole a saída do seu pwd)",
        destToken: "diretório de destino",
        destPlaceholder: "/home/you/downloads",
        copy: "Copiar comando",
        copied: "Copiado",
      },
      bullets: [
        "Se o arquivo foi definido para queima, atingiu seu limite de downloads ou expirou, o link está esgotado e o down informa que ele não existe mais.",
      ],
    },
    {
      heading: "Funciona com o site também",
      body: ["O link é o mesmo que o site usa, então a CLI e o navegador interoperam livremente:"],
      bullets: [
        "Um link do relayium up abre em um navegador — passe-o para alguém que não tem a CLI e a pessoa baixa pela web.",
        "Um link de compartilhamento criado no relayium.com pode ser buscado com relayium down em outra máquina.",
      ],
    },
    {
      heading: "O que o servidor pode e não pode ver",
      body: ["As transferências na nuvem permanecem criptografadas de ponta a ponta:"],
      bullets: [
        "Seu arquivo é criptografado na sua máquina antes de ser enviado. A chave de descriptografia vive apenas no fragmento #k= do link e nunca é enviada ao servidor — o Relayium armazena texto cifrado que não consegue ler, incluindo os nomes dos arquivos.",
        "Isso também significa que o link é o único caminho de volta ao arquivo: perca-o e o arquivo fica irrecuperável, por você ou por nós.",
      ],
    },
    {
      heading: "Quando um link não funciona",
      body: [
        "Quatro falhas cobrem quase todo up ou down malsucedido, e nenhuma exige adivinhação: o estado que decide é impresso por um comando ou está visível no comando que você digitou.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O up recusa com “run relayium login first”.",
            code: [
              `relayium whoami
# not logged in (run \`relayium login\`)`,
            ],
            fix: "Enviar guarda o arquivo sob a sua conta, então esta máquina precisa de credenciais. Rode relayium login e aprove no navegador em relayium.com/device; depois disso o whoami imprime sua conta e o servidor a que está vinculada.",
          },
          {
            symptom: "O down não consegue ler o link, e a chave parece ter sumido.",
            code: [
              `echo relayium down https://relayium.com/d/7fK2p#k=Xr8s
# relayium down https://relayium.com/d/7fK2p`,
            ],
            fix: "Um # sem aspas começa um comentário na maioria dos shells, então tudo a partir de #k= nunca chegou ao comando; o echo mostra exatamente o que sobrou. Coloque o link inteiro entre aspas simples e o fragmento, que é a chave de descriptografia, chega intacto.",
          },
          {
            symptom: "O link morre antes do --ttl que você pediu.",
            code: [
              `relayium up ./report.pdf --ttl 7d
# note: your plan caps retention, so this link is kept 1d, not the 7d you asked for`,
            ],
            fix: "O servidor corta em silêncio um pedido acima do teto do seu plano — 1 dia no Free, 3 no Plus, 7 no Pro, 14 no Max — e o up imprime depois esse aviso para dizer o que você realmente conseguiu. --burn e --max-downloads também encerram um link mais cedo. Envie de novo para obter um link novo.",
          },
          {
            symptom: "Você está logado, mas o up diz que você está logado em outro lugar.",
            code: [
              `relayium whoami
# you@example.com (https://relayium.com)`,
            ],
            fix: "Um --server que não emitiu o seu token é recusado em vez de receber suas credenciais, o que as vazaria e nem autenticaria ali. Ou você tira o --server para usar o servidor vinculado que o whoami acabou de imprimir, ou roda antes relayium login contra o outro host.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso de uma conta?",
        a: "Para enviar para a nuvem, e para o send quando um código precisa ser gerado. O relayium up sempre exige relayium login, para que o arquivo fique guardado sob a sua conta. O relayium send só exige quando o servidor precisa gerar um novo código de emparelhamento para você — se você executar send com um código que alguém lhe passou, nada é gerado, então nenhum login é necessário. O relayium down e o relayium receive não precisam de conta, e push/pull, daemon direto e sync funcionam sem uma.",
      },
      {
        q: "Meu arquivo é criptografado?",
        a: "Sim, de ponta a ponta. Ele é criptografado na sua máquina antes do envio; a chave vive apenas no fragmento #k= do link e nunca é enviada ao servidor. O Relayium armazena texto cifrado que não consegue ler, incluindo os nomes dos arquivos.",
      },
      {
        q: "E se eu perder o link?",
        a: "O link carrega a única cópia da chave de descriptografia, então um link perdido significa um arquivo irrecuperável — não há nada no servidor que possa recuperá-lo.",
      },
      {
        q: "Posso limitar quem baixa?",
        a: "Qualquer pessoa com o link pode baixar, então compartilhe-o de forma privada. Use --burn para permitir um único download, ou --max-downloads <n> para limitar o número, e --ttl <duração> para expirá-lo após um tempo definido.",
      },
      {
        q: "Funciona com o site?",
        a: "Sim. Um link do relayium up abre em um navegador, e um link de compartilhamento criado no relayium.com pode ser buscado com relayium down em outra máquina.",
      },
    ],
  },
  cta: {
    text: "Pronto para mover um arquivo entre as suas próprias máquinas? Instale a CLI, execute relayium login e envie-o com up.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/push-to-cloud-pull-on-another-computer",
  published: "2026-07-12",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
