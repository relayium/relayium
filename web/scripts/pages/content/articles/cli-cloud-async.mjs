// web/scripts/pages/content/articles/cli-cloud-async.mjs
// Guide: async cloud transfer with the Relayium CLI — relayium login / up / down.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

const en = {
  title: "Push files to the cloud, pull them on another computer",
  description:
    "Async file transfer through your Relayium account: upload from one machine with relayium up, download on another with relayium down whenever it's convenient — end-to-end encrypted, and only uploading needs an account.",
  updatedLabel: "Last updated",
  lead: [
    "Sometimes the two computers are never awake at the same time. You want to drop a file from your work laptop tonight and grab it from your home desktop tomorrow, with nobody waiting on a live connection. relayium up and relayium down do exactly that: up encrypts and uploads to your account, and down fetches and decrypts it later on any machine — no peer-to-peer handshake, no server you both ssh into.",
    "This is the one part of the CLI that uses your Relayium account, and only for uploads. Binding is optional: everything else — push/pull, send/receive, daemon-direct, sync — keeps working with no login. Downloading needs no account at all, just the link.",
  ],
  sections: [
    {
      heading: "When to reach for it",
      body: ["Pick the mode by whether the far end is online and how the two machines reach each other:"],
      bullets: [
        "up / down (this guide) — the two machines are never online together. You upload now; you (or another machine) download later. Goes through your account.",
        "send / receive — both ends are online right now and want a direct peer-to-peer transfer over a one-time code.",
        "push / pull — you can already ssh into the far machine.",
        "Everything except up needs no account; only up requires relayium login.",
      ],
    },
    {
      heading: "Before you start",
      body: [
        "Two one-time things before your first up — install the CLI, and have an account. Already have both? Skip ahead.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Install the CLI so the relayium command exists. The line above drops a prebuilt binary on your PATH (macOS and Linux; on Windows, grab the .zip from the releases page); relayium --version confirms it, and relayium.com/cli lists every install option. Skip this and relayium login just prints 'command not found'.",
        "Have a free Relayium account. The browser step approves the login against your account, so you need one before you can approve — sign in at relayium.com first, or create one there if you haven't. Only uploading needs the account; downloading never does.",
      ],
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
      code: [
        `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…`,
        `# choose how long it lives (otherwise your account's default applies):
relayium up ./report.pdf --burn              # deleted after one download
relayium up ./report.pdf --ttl 7d            # kept for 7 days
relayium up ./report.pdf --max-downloads 5   # allow 5 downloads, then gone`,
      ],
      bullets: [
        "The link is the whole handoff — copy it to wherever the other machine can read it. Anyone with the link can download the file, so treat it like a password.",
        "Retention: --burn removes the file after a single download; --ttl <duration> keeps it for a fixed time (e.g. 7d, 24h); --max-downloads <n> allows a fixed number of downloads. Give none and your account's default applies.",
        "up needs you to be logged in; if you're not, it tells you and does nothing.",
      ],
    },
    {
      heading: "Download on the second computer",
      body: [
        "On the other machine, hand the link to down. No login, no setup — the key that decrypts the file is inside the link, so down needs nothing from your account:",
      ],
      code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
      bullets: [
        "Quote the link: the #k=… fragment carries the decryption key, and some shells treat # as the start of a comment.",
        "Give a destination directory (./downloads here) or omit it to land in the current directory.",
        "If the file was set to burn, has hit its download limit, or has expired, the link is spent and down reports that it's gone.",
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
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need an account?",
        a: "Only to upload. relayium up requires relayium login; relayium down needs no account, and every other CLI command (push/pull, send/receive, daemon-direct, sync) works without one.",
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
    "这是 CLI 里唯一会用到 Relayium 账号的部分，而且只在上传时用。绑定是可选的：其余功能——push/pull、send/receive、daemon 直连、sync——都无需登录照常可用。下载则完全不需要账号，有链接即可。",
  ],
  sections: [
    {
      heading: "什么时候用它",
      body: ["按对端是否在线、以及两台机器如何互相触达来选模式："],
      bullets: [
        "up / down（本指南）——两台机器从不同时在线。你现在上传，之后你（或另一台机器）再下载。走你的账号。",
        "send / receive——两端此刻都在线，想用一次性配对码做直接点对点传输。",
        "push / pull——你已经能 ssh 进对端机器。",
        "除 up 外都无需账号；只有 up 需要 relayium login。",
      ],
    },
    {
      heading: "开始之前",
      body: [
        "第一次 up 之前有两件一次性的事——装好 CLI，以及有个账号。两样都齐了就往下跳。",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "先装 CLI，这样 relayium 命令才存在。上面这行会把预编译好的二进制放到你的 PATH 上（macOS 和 Linux；Windows 请从发布页下载 .zip）；relayium --version 可确认是否装好，relayium.com/cli 列出了所有安装方式。不装这一步，relayium login 只会报 “command not found”。",
        "有一个免费的 Relayium 账号。浏览器那一步是拿你的账号来批准这次登录，所以你得先有账号才能批准——先在 relayium.com 登录，没有就在那里注册一个。只有上传才需要账号；下载从不需要。",
      ],
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
        "以后要撤销某台机器，在浏览器里从账号的“设备”页删掉对应设备即可。",
      ],
    },
    {
      heading: "从第一台电脑上传",
      body: ["up 会遍历你给的文件，在本地加密，上传密文，并打印一个取件链接："],
      code: [
        `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…`,
        `# 选择它能存活多久（不给则用你账号的默认策略）：
relayium up ./report.pdf --burn              # 下载一次后即删除
relayium up ./report.pdf --ttl 7d            # 保留 7 天
relayium up ./report.pdf --max-downloads 5   # 允许下载 5 次，之后删除`,
      ],
      bullets: [
        "链接就是全部交接物——把它复制到另一台机器能读到的地方。任何拿到链接的人都能下载该文件，所以要像对待密码一样对待它。",
        "保留策略：--burn 下载一次后即删；--ttl <时长> 保留固定时间（如 7d、24h）；--max-downloads <n> 允许固定下载次数。都不给则用你账号的默认。",
        "up 需要你已登录；若未登录，它会提示你且不做任何事。",
      ],
    },
    {
      heading: "在第二台电脑下载",
      body: [
        "在另一台机器上，把链接交给 down。无需登录、无需配置——解密文件的密钥就在链接里，所以 down 完全不需要你的账号：",
      ],
      code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
      bullets: [
        "给链接加引号：#k=… 片段携带解密密钥，而有些 shell 会把 # 当作注释起点。",
        "给一个目标目录（这里是 ./downloads），或省略以落到当前目录。",
        "如果该文件设了阅后即焚、已达下载次数上限或已过期，链接就失效了，down 会告知它已不存在。",
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
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我需要账号吗？",
        a: "只有上传才需要。relayium up 需要 relayium login；relayium down 不需要账号，其余所有 CLI 命令（push/pull、send/receive、daemon 直连、sync）也都不需要。",
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
    "Relayium アカウントを使った非同期ファイル転送。relayium up で一方のマシンからアップロードし、都合のよいときに relayium down で別のマシンからダウンロード——エンドツーエンド暗号化で、アカウントが要るのはアップロードだけ。",
  updatedLabel: "最終更新",
  lead: [
    "二台のコンピュータが同時に起きていることは決してない、という場面があります。今夜は仕事用ノートからファイルを置いておき、明日は自宅のデスクトップから取りたい——ライブ接続を待つ人は誰もいない。relayium up と relayium down はまさにそれです。up はローカルで暗号化してアカウントにアップロードし、down は後から任意のマシンで取得・復号します。ピアツーピアのハンドシェイクも、双方が ssh できるサーバーも不要です。",
    "これは CLI の中で唯一 Relayium アカウントを使う部分で、しかもアップロード時だけです。バインドは任意で、他のすべて——push/pull、send/receive、daemon 直結、sync——はログインなしで動き続けます。ダウンロードにはアカウントは一切不要で、リンクさえあれば十分です。",
  ],
  sections: [
    {
      heading: "どんなときに使うか",
      body: ["相手側がオンラインかどうか、二台がどう到達し合うかでモードを選びます："],
      bullets: [
        "up / down（このガイド）——二台が同時にオンラインにならない。今アップロードし、後で自分（または別のマシン）がダウンロードする。アカウント経由。",
        "send / receive——両端が今オンラインで、使い捨てコードで直接ピアツーピア転送したい。",
        "push / pull——相手のマシンに既に ssh できる。",
        "up 以外はアカウント不要。relayium login が要るのは up だけ。",
      ],
    },
    {
      heading: "始める前に",
      body: [
        "最初の up の前に、一度だけ済ませることが二つあります——CLI のインストールと、アカウントの用意です。両方そろっていれば読み飛ばしてください。",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "まず CLI をインストールして relayium コマンドが存在するようにします。上の一行でビルド済みバイナリが PATH に入ります（macOS と Linux。Windows は releases ページから .zip を取得）。relayium --version でインストールを確認でき、relayium.com/cli にすべてのインストール方法があります。これをしないと relayium login は「command not found」と出るだけです。",
        "無料の Relayium アカウントを用意します。ブラウザでの手順はあなたのアカウントに対してログインを承認するので、承認する前にアカウントが必要です——まず relayium.com でサインインし、なければそこで作成してください。アカウントが要るのはアップロードだけで、ダウンロードには不要です。",
      ],
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
      code: [
        `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…`,
        `# 保持期間を選ぶ（指定しなければアカウントの既定が適用）：
relayium up ./report.pdf --burn              # 一度ダウンロードすると削除
relayium up ./report.pdf --ttl 7d            # 7日間保持
relayium up ./report.pdf --max-downloads 5   # 5回まで、その後削除`,
      ],
      bullets: [
        "リンクが受け渡しのすべてです——相手のマシンが読める場所にコピーしてください。リンクを持つ誰もがダウンロードできるので、パスワードのように扱ってください。",
        "保持：--burn は一度のダウンロードで削除。--ttl <期間> は一定時間保持（例：7d、24h）。--max-downloads <n> は一定回数まで。いずれも指定しなければアカウントの既定が適用されます。",
        "up はログインが必要です。していなければその旨を伝え、何もしません。",
      ],
    },
    {
      heading: "二台目のコンピュータでダウンロード",
      body: [
        "別のマシンでは、リンクを down に渡します。ログインも設定も不要——ファイルを復号する鍵はリンクの中にあるので、down はアカウントから何も必要としません：",
      ],
      code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
      bullets: [
        "リンクは引用符で囲みます：#k=… 断片が復号鍵を運び、シェルによっては # をコメントの開始として扱うためです。",
        "宛先ディレクトリ（ここでは ./downloads）を指定するか、省略して現在のディレクトリに落とします。",
        "ファイルがバーン設定、ダウンロード上限到達、または期限切れの場合、リンクは使い切られており、down はもう存在しないと報告します。",
      ],
    },
    {
      heading: "ウェブサイトとも連携",
      body: ["このリンクはウェブサイトが使うものと同じなので、CLI とブラウザは自由に連携します："],
      bullets: [
        "relayium up のリンクはブラウザで開けます——CLI を持たない人に渡せば、その人はウェブからダウンロードできます。",
        "relayium.com で作った共有リンクは、別のマシンで relayium down から取得できます。",
      ],
    },
    {
      heading: "サーバーに見えるもの・見えないもの",
      body: ["クラウド転送はエンドツーエンドで暗号化されたままです："],
      bullets: [
        "ファイルはアップロード前にあなたのマシンで暗号化されます。復号鍵はリンクの #k= 断片にのみ存在し、サーバーには決して送られません——Relayium は読めない暗号文を、ファイル名も含めて保存します。",
        "つまりリンクだけがファイルへ戻る唯一の手段です。失えばファイルは復旧できません。あなたにも私たちにも。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "アカウントは必要ですか？",
        a: "アップロードのときだけです。relayium up は relayium login が必要ですが、relayium down にアカウントは不要で、他のすべての CLI コマンド（push/pull、send/receive、daemon 直結、sync）もアカウントなしで動きます。",
      },
      {
        q: "ファイルは暗号化されますか？",
        a: "はい、エンドツーエンドで。アップロード前にあなたのマシンで暗号化され、鍵はリンクの #k= 断片にのみ存在し、サーバーには決して送られません。Relayium は読めない暗号文を、ファイル名も含めて保存します。",
      },
      {
        q: "リンクを失ったら？",
        a: "リンクは復号鍵の唯一の控えを運びます。失えばファイルは復旧不能です——サーバー側に復元できるものは何もありません。",
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
    "Relayium 계정을 통한 비동기 파일 전송. relayium up 으로 한 기기에서 업로드하고, 편할 때 relayium down 으로 다른 기기에서 다운로드 — 종단 간 암호화이며 계정이 필요한 것은 업로드뿐입니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "두 컴퓨터가 동시에 켜져 있는 일이 결코 없을 때가 있습니다. 오늘 밤 업무용 노트북에서 파일을 올려두고 내일 집 데스크톱에서 받고 싶은데, 실시간 연결을 기다리는 사람은 아무도 없습니다. relayium up 과 relayium down 이 바로 그 일을 합니다. up 은 로컬에서 암호화해 계정에 업로드하고, down 은 나중에 아무 기기에서나 가져와 복호화합니다. 피어 투 피어 핸드셰이크도, 둘 다 ssh 할 수 있는 서버도 필요 없습니다.",
    "이것은 CLI 에서 Relayium 계정을 사용하는 유일한 부분이며, 그것도 업로드할 때뿐입니다. 바인딩은 선택 사항입니다. 나머지 전부 — push/pull, send/receive, daemon 직결, sync — 는 로그인 없이 계속 동작합니다. 다운로드에는 계정이 전혀 필요 없고 링크만 있으면 됩니다.",
  ],
  sections: [
    {
      heading: "언제 쓰나",
      body: ["상대편이 온라인인지, 두 기기가 서로 어떻게 닿는지에 따라 모드를 고릅니다:"],
      bullets: [
        "up / down (이 가이드) — 두 기기가 동시에 온라인이 되지 않습니다. 지금 업로드하고, 나중에 자신(또는 다른 기기)이 다운로드합니다. 계정을 거칩니다.",
        "send / receive — 양쪽이 지금 온라인이며 일회용 코드로 직접 피어 투 피어 전송을 원합니다.",
        "push / pull — 상대 기기에 이미 ssh 할 수 있습니다.",
        "up 을 제외하면 계정이 필요 없습니다. relayium login 이 필요한 것은 up 뿐입니다.",
      ],
    },
    {
      heading: "시작하기 전에",
      body: [
        "첫 up 전에 한 번만 해두면 되는 두 가지 — CLI 설치와 계정 준비입니다. 둘 다 있으면 건너뛰세요.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "먼저 CLI를 설치해 relayium 명령이 존재하게 합니다. 위 한 줄이 미리 빌드된 바이너리를 PATH에 올립니다(macOS와 Linux; Windows는 releases 페이지에서 .zip을 받으세요). relayium --version 으로 설치를 확인할 수 있고, relayium.com/cli 에 모든 설치 방법이 있습니다. 이 단계를 건너뛰면 relayium login 은 “command not found”만 출력합니다.",
        "무료 Relayium 계정을 준비합니다. 브라우저 단계는 당신의 계정에 대해 로그인을 승인하므로, 승인하려면 먼저 계정이 있어야 합니다 — relayium.com 에서 로그인하거나 없으면 거기서 새로 만드세요. 계정이 필요한 것은 업로드뿐이고 다운로드에는 필요 없습니다.",
      ],
    },
    {
      heading: "이 기기를 계정에 바인딩하기 (한 번만)",
      body: [
        "up 은 누구의 계정에 저장할지 알아야 하므로 기기마다 한 번 로그인합니다. 브라우저에서 승인하는 기기 로그인이며, 터미널에는 확인할 코드 외에는 아무것도 입력하지 않습니다:",
      ],
      code: ["relayium login"],
      bullets: [
        "CLI 가 짧은 코드와 URL(relayium.com/device)을 표시합니다. relayium.com 에 로그인된 브라우저에서 열어(로그인되어 있지 않으면 먼저 거기서 로그인) 코드를 입력하고 승인하면 이 기기가 바인딩됩니다.",
        "로그인 정보는 ~/.config/relayium/ 아래 저장되므로 기기마다 한 번이면 됩니다. relayium whoami 로 바인딩 대상을 보고, relayium logout 으로 지웁니다.",
        "나중에 기기를 취소하려면 브라우저의 계정 '기기' 페이지에서 해당 기기를 삭제하세요.",
      ],
    },
    {
      heading: "첫 번째 컴퓨터에서 업로드",
      body: ["up 은 준 파일들을 훑어 로컬에서 암호화하고 암호문을 업로드한 뒤 수령용 링크를 출력합니다:"],
      code: [
        `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…`,
        `# 얼마나 살려둘지 고르기(없으면 계정 기본값 적용):
relayium up ./report.pdf --burn              # 한 번 다운로드 후 삭제
relayium up ./report.pdf --ttl 7d            # 7일간 보관
relayium up ./report.pdf --max-downloads 5   # 5회까지 허용 후 삭제`,
      ],
      bullets: [
        "링크가 전달의 전부입니다 — 다른 기기가 읽을 수 있는 곳에 복사하세요. 링크를 가진 누구나 파일을 다운로드할 수 있으니 비밀번호처럼 다루세요.",
        "보관: --burn 은 한 번 다운로드하면 삭제, --ttl <기간> 은 정해진 시간(예: 7d, 24h) 보관, --max-downloads <n> 은 정해진 횟수 허용. 아무것도 주지 않으면 계정 기본값이 적용됩니다.",
        "up 은 로그인이 필요합니다. 되어 있지 않으면 알려주고 아무 일도 하지 않습니다.",
      ],
    },
    {
      heading: "두 번째 컴퓨터에서 다운로드",
      body: [
        "다른 기기에서 링크를 down 에 건넵니다. 로그인도 설정도 필요 없습니다 — 파일을 복호화하는 키가 링크 안에 있으므로 down 은 계정에서 아무것도 필요로 하지 않습니다:",
      ],
      code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
      bullets: [
        "링크는 따옴표로 감싸세요: #k=… 조각이 복호화 키를 담고 있는데 일부 셸은 # 을 주석 시작으로 취급합니다.",
        "대상 디렉터리(여기서는 ./downloads)를 주거나 생략해 현재 디렉터리에 받습니다.",
        "파일이 번(burn) 설정이거나 다운로드 한도에 도달했거나 만료되었으면 링크는 소진된 것이고, down 은 사라졌다고 알립니다.",
      ],
    },
    {
      heading: "웹사이트와도 연동",
      body: ["이 링크는 웹사이트가 쓰는 것과 같으므로 CLI 와 브라우저가 자유롭게 연동됩니다:"],
      bullets: [
        "relayium up 의 링크는 브라우저에서 열립니다 — CLI 가 없는 사람에게 건네면 웹에서 다운로드합니다.",
        "relayium.com 에서 만든 공유 링크는 다른 기기에서 relayium down 으로 받을 수 있습니다.",
      ],
    },
    {
      heading: "서버가 볼 수 있는 것과 없는 것",
      body: ["클라우드 전송은 종단 간 암호화를 유지합니다:"],
      bullets: [
        "파일은 업로드 전에 당신의 기기에서 암호화됩니다. 복호화 키는 링크의 #k= 조각에만 있고 서버로 전송되지 않습니다 — Relayium 은 읽을 수 없는 암호문을 파일 이름까지 포함해 저장합니다.",
        "그래서 링크가 파일로 돌아가는 유일한 길입니다: 잃으면 파일은 복구할 수 없습니다, 당신도 우리도.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "계정이 필요한가요?",
        a: "업로드할 때만요. relayium up 은 relayium login 이 필요하지만, relayium down 은 계정이 필요 없고 다른 모든 CLI 명령(push/pull, send/receive, daemon 직결, sync)도 계정 없이 동작합니다.",
      },
      {
        q: "파일은 암호화되나요?",
        a: "네, 종단 간으로요. 업로드 전에 당신의 기기에서 암호화되며, 키는 링크의 #k= 조각에만 있고 서버로 전송되지 않습니다. Relayium 은 읽을 수 없는 암호문을 파일 이름까지 포함해 저장합니다.",
      },
      {
        q: "링크를 잃어버리면요?",
        a: "링크는 복호화 키의 유일한 사본을 담고 있어, 잃으면 파일은 복구할 수 없습니다 — 서버에 복원할 수 있는 것이 전혀 없습니다.",
      },
      {
        q: "누가 다운로드할지 제한할 수 있나요?",
        a: "링크를 가진 누구나 다운로드할 수 있으니 비공개로 공유하세요. --burn 으로 한 번만, --max-downloads <n> 으로 횟수를 제한하고, --ttl <기간> 으로 일정 시간 후 만료시킬 수 있습니다.",
      },
      {
        q: "웹사이트와 연동되나요?",
        a: "네. relayium up 의 링크는 브라우저에서 열리고, relayium.com 에서 만든 공유 링크는 다른 기기에서 relayium down 으로 받을 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "자신의 기기들 사이에서 파일을 옮길 준비가 되셨나요? CLI를 설치하고 relayium login 을 실행한 뒤 up 하세요.",
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
    "Das ist der einzige Teil der CLI, der dein Relayium-Konto nutzt, und nur beim Hochladen. Das Binden ist optional: alles andere — push/pull, send/receive, Daemon-Direkt, sync — läuft weiter ohne Anmeldung. Das Herunterladen braucht überhaupt kein Konto, nur den Link.",
  ],
  sections: [
    {
      heading: "Wann du dazu greifst",
      body: ["Wähle den Modus danach, ob die Gegenseite online ist und wie sich die beiden Rechner erreichen:"],
      bullets: [
        "up / down (diese Anleitung) — die beiden Rechner sind nie gleichzeitig online. Du lädst jetzt hoch; du (oder ein anderer Rechner) lädst später herunter. Läuft über dein Konto.",
        "send / receive — beide Seiten sind jetzt online und wollen eine direkte Peer-to-Peer-Übertragung über einen Einmalcode.",
        "push / pull — du kommst bereits per ssh auf den entfernten Rechner.",
        "Außer up braucht nichts ein Konto; nur up erfordert relayium login.",
      ],
    },
    {
      heading: "Bevor du loslegst",
      body: [
        "Zwei einmalige Dinge vor deinem ersten up — die CLI installieren und ein Konto haben. Hast du beides, überspring diesen Abschnitt.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Installiere die CLI, damit es den Befehl relayium gibt. Die Zeile oben legt eine vorgefertigte Binärdatei in deinen PATH (macOS und Linux; unter Windows die .zip von der Releases-Seite holen); relayium --version bestätigt die Installation, und relayium.com/cli listet alle Installationswege. Ohne das gibt relayium login nur „command not found“ aus.",
        "Halte ein kostenloses Relayium-Konto bereit. Der Browser-Schritt bestätigt die Anmeldung gegenüber deinem Konto, du brauchst also vorher eines — melde dich zuerst auf relayium.com an oder erstelle dort eines. Nur das Hochladen braucht das Konto; das Herunterladen nie.",
      ],
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
      code: [
        `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…`,
        `# wähle, wie lange sie lebt (sonst gilt die Vorgabe deines Kontos):
relayium up ./report.pdf --burn              # nach einem Download gelöscht
relayium up ./report.pdf --ttl 7d            # 7 Tage aufbewahrt
relayium up ./report.pdf --max-downloads 5   # 5 Downloads erlaubt, dann weg`,
      ],
      bullets: [
        "Der Link ist die ganze Übergabe — kopiere ihn dorthin, wo der andere Rechner ihn lesen kann. Jeder mit dem Link kann die Datei herunterladen, behandle ihn also wie ein Passwort.",
        "Aufbewahrung: --burn entfernt die Datei nach einem einzigen Download; --ttl <Dauer> behält sie eine feste Zeit (z. B. 7d, 24h); --max-downloads <n> erlaubt eine feste Anzahl. Gibst du nichts an, gilt die Vorgabe deines Kontos.",
        "up erfordert, dass du angemeldet bist; bist du es nicht, sagt es dir das und tut nichts.",
      ],
    },
    {
      heading: "Auf dem zweiten Computer herunterladen",
      body: [
        "Gib auf dem anderen Rechner den Link an down. Keine Anmeldung, keine Einrichtung — der Schlüssel, der die Datei entschlüsselt, steckt im Link, also braucht down nichts von deinem Konto:",
      ],
      code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
      bullets: [
        "Setz den Link in Anführungszeichen: das Fragment #k=… trägt den Entschlüsselungsschlüssel, und manche Shells behandeln # als Kommentaranfang.",
        "Gib ein Zielverzeichnis an (hier ./downloads) oder lass es weg, um im aktuellen Verzeichnis zu landen.",
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
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Brauche ich ein Konto?",
        a: "Nur zum Hochladen. relayium up erfordert relayium login; relayium down braucht kein Konto, und jeder andere CLI-Befehl (push/pull, send/receive, Daemon-Direkt, sync) läuft ohne eines.",
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
    "Transfert de fichiers asynchrone via votre compte Relayium : téléversez depuis une machine avec relayium up, téléchargez sur une autre avec relayium down quand cela vous arrange — chiffré de bout en bout, et seul le téléversement demande un compte.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Parfois, les deux ordinateurs ne sont jamais allumés en même temps. Vous voulez déposer un fichier ce soir depuis le portable du travail et le récupérer demain depuis le poste de la maison, sans que personne n'attende une connexion en direct. relayium up et relayium down font exactement cela : up chiffre localement puis téléverse vers votre compte, et down le récupère plus tard sur n'importe quelle machine et le déchiffre — pas de poignée de main pair-à-pair, pas de serveur où vous pouvez tous les deux vous connecter en ssh.",
    "C'est la seule partie de la CLI qui utilise votre compte Relayium, et uniquement pour le téléversement. La liaison est facultative : tout le reste — push/pull, send/receive, daemon direct, sync — continue de fonctionner sans connexion. Le téléchargement ne demande aucun compte, juste le lien.",
  ],
  sections: [
    {
      heading: "Quand y recourir",
      body: ["Choisissez le mode selon que l'autre extrémité est en ligne et selon la façon dont les deux machines se joignent :"],
      bullets: [
        "up / down (ce guide) — les deux machines ne sont jamais en ligne ensemble. Vous téléversez maintenant ; vous (ou une autre machine) téléchargez plus tard. Passe par votre compte.",
        "send / receive — les deux extrémités sont en ligne maintenant et veulent un transfert pair-à-pair direct via un code à usage unique.",
        "push / pull — vous pouvez déjà vous connecter en ssh à la machine distante.",
        "Tout sauf up se passe de compte ; seul up requiert relayium login.",
      ],
    },
    {
      heading: "Avant de commencer",
      body: [
        "Deux choses à faire une seule fois avant votre premier up — installer la CLI et avoir un compte. Si vous avez déjà les deux, passez à la suite.",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Installez la CLI pour que la commande relayium existe. La ligne ci-dessus place un binaire précompilé dans votre PATH (macOS et Linux ; sous Windows, récupérez le .zip depuis la page des releases) ; relayium --version confirme l'installation, et relayium.com/cli liste toutes les options d'installation. Sans cela, relayium login affiche seulement « command not found ».",
        "Ayez un compte Relayium gratuit. L'étape dans le navigateur approuve la connexion pour votre compte, il vous en faut donc un avant de pouvoir approuver — connectez-vous d'abord sur relayium.com, ou créez-en un là-bas. Seul le téléversement demande le compte ; le téléchargement jamais.",
      ],
    },
    {
      heading: "Lier cette machine à votre compte (une seule fois)",
      body: [
        "up doit savoir sous quel compte stocker, alors connectez-vous une fois par machine. C'est une connexion d'appareil approuvée dans le navigateur — vous ne tapez rien dans le terminal, hormis le code que vous confirmez :",
      ],
      code: ["relayium login"],
      bullets: [
        "La CLI affiche un code court et une URL (relayium.com/device). Ouvrez-la dans le navigateur où vous êtes connecté à relayium.com (connectez-vous-y d'abord si ce n'est pas le cas), saisissez le code et approuvez — cette machine est désormais liée.",
        "La connexion est enregistrée sous ~/.config/relayium/, vous ne le faites donc qu'une fois par machine. relayium whoami montre à qui vous êtes lié ; relayium logout l'efface.",
        "Pour révoquer une machine plus tard, supprimez son appareil depuis la page « appareils » de votre compte dans le navigateur.",
      ],
    },
    {
      heading: "Téléverser depuis le premier ordinateur",
      body: ["up parcourt les fichiers indiqués, les chiffre localement, téléverse le chiffré et affiche un lien de récupération :"],
      code: [
        `relayium up ./report.pdf
#   → https://relayium.com/d/7fK2p…#k=Xr8s…`,
        `# choisissez sa durée de vie (sinon la valeur par défaut de votre compte s'applique) :
relayium up ./report.pdf --burn              # supprimé après un téléchargement
relayium up ./report.pdf --ttl 7d            # conservé 7 jours
relayium up ./report.pdf --max-downloads 5   # 5 téléchargements autorisés, puis supprimé`,
      ],
      bullets: [
        "Le lien est toute la remise — copiez-le là où l'autre machine peut le lire. Quiconque a le lien peut télécharger le fichier, traitez-le donc comme un mot de passe.",
        "Rétention : --burn supprime le fichier après un seul téléchargement ; --ttl <durée> le conserve un temps fixe (p. ex. 7d, 24h) ; --max-downloads <n> autorise un nombre fixe. Sans rien préciser, la valeur par défaut de votre compte s'applique.",
        "up exige que vous soyez connecté ; sinon il vous le dit et ne fait rien.",
      ],
    },
    {
      heading: "Télécharger sur le deuxième ordinateur",
      body: [
        "Sur l'autre machine, passez le lien à down. Pas de connexion, pas de configuration — la clé qui déchiffre le fichier est dans le lien, donc down n'a besoin de rien de votre compte :",
      ],
      code: ["relayium down 'https://relayium.com/d/7fK2p…#k=Xr8s…' ./downloads"],
      bullets: [
        "Mettez le lien entre guillemets : le fragment #k=… porte la clé de déchiffrement, et certains shells traitent # comme un début de commentaire.",
        "Indiquez un répertoire de destination (ici ./downloads) ou omettez-le pour atterrir dans le répertoire courant.",
        "Si le fichier était en mode burn, a atteint sa limite de téléchargements ou a expiré, le lien est épuisé et down signale qu'il n'existe plus.",
      ],
    },
    {
      heading: "Fonctionne aussi avec le site web",
      body: ["Le lien est le même que celui du site web, donc la CLI et le navigateur interopèrent librement :"],
      bullets: [
        "Un lien issu de relayium up s'ouvre dans un navigateur — donnez-le à quelqu'un sans la CLI et il télécharge depuis le web.",
        "Un lien de partage créé sur relayium.com peut être récupéré avec relayium down sur une autre machine.",
      ],
    },
    {
      heading: "Ce que le serveur peut voir et ne peut pas voir",
      body: ["Les transferts cloud restent chiffrés de bout en bout :"],
      bullets: [
        "Votre fichier est chiffré sur votre machine avant d'être téléversé. La clé de déchiffrement ne vit que dans le fragment #k= du lien et n'est jamais envoyée au serveur — Relayium stocke un chiffré qu'il ne peut pas lire, noms de fichiers compris.",
        "Cela signifie aussi que le lien est le seul chemin de retour vers le fichier : perdez-le et le fichier est irrécupérable, par vous comme par nous.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Seulement pour téléverser. relayium up exige relayium login ; relayium down ne demande aucun compte, et toutes les autres commandes de la CLI (push/pull, send/receive, daemon direct, sync) fonctionnent sans compte.",
      },
      {
        q: "Mon fichier est-il chiffré ?",
        a: "Oui, de bout en bout. Il est chiffré sur votre machine avant le téléversement ; la clé ne vit que dans le fragment #k= du lien et n'est jamais envoyée au serveur. Relayium stocke un chiffré qu'il ne peut pas lire, noms de fichiers compris.",
      },
      {
        q: "Et si je perds le lien ?",
        a: "Le lien porte l'unique copie de la clé de déchiffrement ; un lien perdu signifie donc un fichier irrécupérable — rien sur le serveur ne permet de le restaurer.",
      },
      {
        q: "Puis-je limiter qui le télécharge ?",
        a: "Quiconque a le lien peut télécharger, alors partagez-le en privé. Utilisez --burn pour un seul téléchargement, --max-downloads <n> pour plafonner le nombre, et --ttl <durée> pour le faire expirer après un temps donné.",
      },
      {
        q: "Est-ce compatible avec le site web ?",
        a: "Oui. Un lien de relayium up s'ouvre dans un navigateur, et un lien de partage créé sur relayium.com peut être récupéré avec relayium down sur une autre machine.",
      },
    ],
  },
  cta: {
    text: "Prêt à déplacer un fichier entre vos propres machines ? Installez la CLI, lancez relayium login, puis faites-en un up.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire aussi",
};

export default {
  slug: "guides/push-to-cloud-pull-on-another-computer",
  updated: "2026-07-12",
  langs: { en, zh, ja, ko, de, fr },
};
