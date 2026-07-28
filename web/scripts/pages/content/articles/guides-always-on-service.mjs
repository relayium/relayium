// web/scripts/pages/content/articles/guides-always-on-service.mjs
// Guide: running `relayium serve` as a long-lived, always-on receive service —
// interactive first-push approval vs pre-authorized fingerprints, systemd, --allow-delete.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

// Shared code for the macOS/launchd section — identical across every language,
// referenced as code: [LAUNCHD_PLIST, LAUNCHD_CMDS] so it's written once. YOU is
// a placeholder the reader replaces with their macOS username.
const LAUNCHD_PLIST = `<!-- /Library/LaunchDaemons/com.relayium.serve.plist  (replace YOU with your macOS username) -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>com.relayium.serve</string>
  <key>UserName</key>           <string>YOU</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/relayium</string>
    <string>serve</string>
    <string>--dir</string>         <string>/Users/YOU/inbox</string>
    <string>--port</string>        <string>9031</string>
    <string>--config-dir</string>  <string>/Users/YOU/.config/relayium</string>
    <string>--allow-delete</string>
  </array>
  <key>RunAtLoad</key>   <true/>
  <key>KeepAlive</key>   <true/>
  <key>StandardOutPath</key>    <string>/Users/YOU/relayium-serve.log</string>
  <key>StandardErrorPath</key>  <string>/Users/YOU/relayium-serve.log</string>
</dict>
</plist>`;
const LAUNCHD_CMDS = `# 1) authorize each pusher first — launchd gives serve no terminal to prompt on:
relayium authorize <fingerprint>     # get the fingerprint from the pusher's  relayium id

# 2) save the plist above to that path, then load it (root-owned, starts at boot):
sudo chown root:wheel /Library/LaunchDaemons/com.relayium.serve.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.relayium.serve.plist

# check it's running / follow logs / stop it:
sudo launchctl print system/com.relayium.serve | grep state
tail -f ~/relayium-serve.log
sudo launchctl bootout system/com.relayium.serve`;

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Run Relayium as an always-on receive service",
  description:
    "Keep relayium serve running so any peer can push to you at any time — daemon-direct over pinned TLS. Covers first-push approval, pre-authorizing fingerprints, running it at boot under systemd (Linux) or launchd (macOS), and --allow-delete.",
  updatedLabel: "Last updated",
  lead: [
    "relayium serve --once handles a single incoming transfer and exits — fine for a one-off pull. But if you want a machine to be a standing drop point — a home server that backups land on overnight, a build box that CI pushes artifacts to, a NAS your phone can send photos to whenever — you want serve running all the time, not started by hand for each transfer.",
    "This guide covers starting a long-running listener, approving who's allowed to push to it, pre-authorizing peers for the cases where no one's at the terminal, running it under systemd, and letting a sync --delete sender mirror deletions.",
  ],
  sections: [
    {
      heading: "Start the listener",
      body: [
        "serve listens for daemon-direct pushes (relayium://host:port) over a pinned TLS 1.3 connection and writes what it receives into a directory. Nothing needs to be pre-shared to start it — no fingerprints to copy, no server to register:",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # non-default port
relayium serve --dir ~/inbox --allow-delete  # let a sync --delete sender mirror deletions`,
      ],
      bullets: [
        "--dir sets where files land (defaults to the current directory).",
        "--port sets the listening port (defaults to 9031); open it on your firewall if the sender is elsewhere.",
        "With no --once, serve keeps running and accepting pushes until you stop it or a process manager restarts it — that's what makes it an always-on service.",
      ],
    },
    {
      heading: "Approve who's allowed to push",
      body: [
        "The first time a new peer pushes, serve — if it's running in a terminal — shows you where the push came from and its fingerprint and asks you to approve it, the same way SSH asks about an unknown host on first connect:",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Answer y once and that fingerprint is written to authorized_fingerprints; every later push from the same machine goes through with no prompt.",
        "A fingerprint identifies a machine, not a network address, so it survives the sender's IP changing.",
        "This is interactive by design — it needs someone at the keyboard, which won't be true once serve moves to systemd (next).",
      ],
    },
    {
      heading: "Pre-authorize peers for non-interactive setups",
      body: [
        "When serve has no terminal to prompt on — a systemd service, a background process, a pipe — it can't ask, so it rejects any fingerprint it doesn't already recognize. Authorize peers ahead of time instead. On the machine that will push, run relayium id to print its fingerprint; on the receiver, add it before the first push arrives:",
      ],
      code: [
        `# on the machine that will PUSH: print its fingerprint
relayium id

# on this always-on RECEIVER: authorize it in advance
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize is idempotent — running it again for a fingerprint you already trust does nothing.",
        "Identity and trust files live under --config-dir, defaulting to ~/.config/relayium (id.key/id.crt is this host's identity, authorized_fingerprints is the peer allow-list).",
      ],
    },
    {
      heading: "Run it under systemd",
      body: [
        "For a service that survives reboots and crashes, hand serve to systemd. Point --config-dir at a fixed path so the host's identity and its authorized-peer list stay put across restarts:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "Before enabling the service, run relayium authorize <fingerprint> for every peer that should be able to push — the service itself can't prompt.",
        "systemctl enable --now relayium-serve starts it and brings it back on every boot.",
        "Keep /etc/relayium/id.key readable only by the service user; relayium refuses to load a key with looser permissions.",
      ],
    },
    {
      heading: "Run it at boot on macOS (launchd)",
      body: [
        "macOS has no systemd — its service manager is launchd. To keep serve running on a Mac (a Mac mini left on as a drop point, say), install it as a LaunchDaemon so it starts at boot, before anyone logs in. Set UserName so it runs as you rather than root, and give --dir and --config-dir absolute paths so its identity and trust files stay in your own ~/.config/relayium:",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "launchd gives serve no terminal, so it can't prompt — run relayium authorize <fingerprint> for each pusher first, the same as with systemd. The fingerprint comes from that machine's relayium id.",
        "KeepAlive restarts serve if it crashes; RunAtLoad plus a LaunchDaemon in /Library/LaunchDaemons starts it at boot without a login — the right fit for a headless Mac mini.",
        "Want a login-scoped service instead? Put the same plist (drop the UserName key) in ~/Library/LaunchAgents/ and load it with launchctl bootstrap gui/$(id -u) <path> — it starts when you log in rather than at boot.",
        "If the macOS application firewall is on, allow incoming connections for relayium (System Settings → Network → Firewall), or pushes to your port are blocked.",
      ],
    },
    {
      heading: "Let a sync --delete sender mirror deletions",
      body: [
        "By default serve only ever adds or updates files — a sender running sync --delete against it still copies new and changed files, but any deletions it asks for are skipped, with a warning logged on the receiver. Start serve with --allow-delete to opt in to true mirroring, where files removed on the sender's side are removed here too:",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete is a receiver-side opt-in; the sender still has to ask for it with sync --delete.",
        "Without it, nothing is ever deleted on this machine, no matter what a sender requests.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "What port does serve listen on by default?",
        a: "9031. Change it with --port on both the listener (serve --port N) and the pusher's target (relayium://host:N).",
      },
      {
        q: "Do I have to approve every single push by hand?",
        a: "Only the first push from a given fingerprint, and only when serve is running with a terminal attached. It's remembered after that. Running serve non-interactively (systemd, a pipe) skips the prompt entirely and rejects unknown peers — pre-authorize them with relayium authorize instead.",
      },
      {
        q: "Can a sender delete files on my always-on receiver?",
        a: "Only if you started serve with --allow-delete and the sender is running sync --delete. Without --allow-delete, deletions are silently skipped and everything else still transfers.",
      },
      {
        q: "Is running an always-on receiver free?",
        a: "Yes. relayium serve is part of the free, self-hostable CLI — no account, no paid tier, on either side of the connection.",
      },
      {
        q: "Where does serve keep its identity and peer list?",
        a: "In ~/.config/relayium by default (id.key/id.crt for this host's identity, authorized_fingerprints for the allow-list). Point --config-dir somewhere fixed, like /etc/relayium, for a systemd service.",
      },
      {
        q: "How do I run serve at boot on macOS?",
        a: "macOS has no systemd — use launchd. Install serve as a LaunchDaemon in /Library/LaunchDaemons (starts at boot; set UserName to run as you), or as a LaunchAgent in ~/Library/LaunchAgents (starts at login). This guide has a ready-to-edit plist; there's no Homebrew service. Pre-authorize pushers with relayium authorize first, since launchd gives serve no terminal to prompt on.",
      },
    ],
  },
  cta: {
    text: "Turn any machine you own into an always-on, free receiver — direct pushes over pinned TLS, no relay involved.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "把 Relayium 变成常驻接收服务",
  description:
    "让 relayium serve 一直运行，这样任何对端都能随时向你推送——通过证书固定的 TLS 进行 daemon 直连。涵盖首次推送批准、预先授权指纹、在 systemd（Linux）或 launchd（macOS）下开机自启，以及 --allow-delete。",
  updatedLabel: "最近更新",
  lead: [
    "relayium serve --once 只处理一次传入的传输就退出——适合偶尔拉取一次的场景。但如果你想让某台机器成为一个常驻的落地点——一台每晚接收备份的家庭服务器、一台 CI 会推送构建产物的构建机、一台随时能接收手机照片的 NAS——你会想让 serve 一直运行，而不是每次传输都手动启动它。",
    "本指南涵盖启动一个长期运行的监听端、批准谁可以向它推送、为没有人守在终端前的场景预先授权对端、在 systemd 下运行它，以及让使用 sync --delete 的发送方镜像删除操作。",
  ],
  sections: [
    {
      heading: "启动监听端",
      body: [
        "serve 通过证书固定的 TLS 1.3 连接监听 daemon 直连推送（relayium://host:port），并把收到的内容写入某个目录。启动它不需要预先共享任何东西——不用复制指纹，也不用注册服务器：",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # 非默认端口
relayium serve --dir ~/inbox --allow-delete  # 允许使用 sync --delete 的发送方镜像删除操作`,
      ],
      bullets: [
        "--dir 设置文件落地的位置（默认是当前目录）。",
        "--port 设置监听端口（默认是 9031）；如果发送方在别处，需要在防火墙上开放该端口。",
        "不加 --once 时，serve 会持续运行并接受推送，直到你手动停止它，或者由进程管理器重启它——这正是它能成为常驻服务的原因。",
      ],
    },
    {
      heading: "批准谁可以推送",
      body: [
        "当一个新的对端第一次推送时，如果 serve 运行在终端中，它会显示这次推送来自哪里、它的指纹，并请你批准——就像 SSH 首次连接未知主机时会询问一样：",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "回答一次 y，该指纹就会被写入 authorized_fingerprints；此后同一台机器的每次推送都会直接通过，不再提示。",
        "指纹标识的是一台机器，而不是一个网络地址，因此即使发送方的 IP 变化，它依然有效。",
        "这一步是交互式的，刻意如此——需要有人守在键盘前，而一旦 serve 迁移到 systemd（下一步），这就不成立了。",
      ],
    },
    {
      heading: "为非交互式场景预先授权对端",
      body: [
        "当 serve 没有终端可以弹出提示时——作为 systemd 服务、后台进程，或通过管道运行——它无法询问，因此会拒绝任何它尚未识别的指纹。这时应该提前授权对端。在将要推送的那台机器上运行 relayium id 打印它的指纹；在接收方上，在第一次推送到达之前把它加进去：",
      ],
      code: [
        `# 在将要推送的那台机器上：打印它的指纹
relayium id

# 在这台常驻接收机上：预先授权它
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize 是幂等的——对一个已经信任的指纹再次运行它不会有任何效果。",
        "身份和信任文件存放在 --config-dir 指定的目录下，默认是 ~/.config/relayium（id.key/id.crt 是这台主机的身份，authorized_fingerprints 是对端允许列表）。",
      ],
    },
    {
      heading: "在 systemd 下运行",
      body: [
        "如果希望服务能在重启和崩溃后依然存活，把 serve 交给 systemd。把 --config-dir 指向一个固定路径，让主机的身份和它的对端允许列表在重启之间保持不变：",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "在启用该服务之前，先为每一个应该能够推送的对端运行 relayium authorize <fingerprint>——服务本身无法弹出提示。",
        "systemctl enable --now relayium-serve 会启动它，并让它在每次开机时自动恢复运行。",
        "让 /etc/relayium/id.key 只能被服务用户读取；权限过于宽松时 relayium 会拒绝加载该密钥。",
      ],
    },
    {
      heading: "在 macOS 上开机自启（launchd）",
      body: [
        "macOS 没有 systemd——它的服务管理器是 launchd。要让 serve 在 Mac 上常驻（比如一台常开、当落地点用的 Mac mini），把它装成 LaunchDaemon，这样开机即启动、无需任何人登录。设置 UserName 让它以你自己的身份（而非 root）运行，并给 --dir 和 --config-dir 绝对路径，这样它的身份和信任文件仍留在你自己的 ~/.config/relayium 里：",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "launchd 不给 serve 终端，所以它无法弹出提示——请先为每个推送方运行 relayium authorize <fingerprint>，跟 systemd 一样。指纹来自那台机器的 relayium id。",
        "KeepAlive 会在 serve 崩溃时把它重新拉起；RunAtLoad 加上放在 /Library/LaunchDaemons 的 LaunchDaemon，会在开机时（无需登录）启动它——正适合一台无人值守的 Mac mini。",
        "想要登录级的服务？把同一份 plist（去掉 UserName 键）放到 ~/Library/LaunchAgents/，用 launchctl bootstrap gui/$(id -u) <path> 加载——它会在你登录时启动，而不是开机时。",
        "如果开了 macOS 应用防火墙，请允许 relayium 的传入连接（系统设置 → 网络 → 防火墙），否则发往你端口的推送会被拦截。",
      ],
    },
    {
      heading: "让 sync --delete 的发送方镜像删除操作",
      body: [
        "默认情况下，serve 只会新增或更新文件——即使发送方对它运行 sync --delete，新增和修改过的文件依然会被复制，但它请求的删除操作会被跳过，接收方会记录一条警告。用 --allow-delete 启动 serve 即可选择启用真正的镜像同步，让发送方那边删除的文件在这里也被删除：",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete 是接收方一侧的选择性开关；发送方仍然需要用 sync --delete 主动请求删除。",
        "如果不加这个选项，无论发送方请求什么，这台机器上都不会删除任何文件。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "serve 默认监听哪个端口？",
        a: "9031。可以用 --port 同时修改监听端（serve --port N）和推送方的目标地址（relayium://host:N）。",
      },
      {
        q: "我必须手动批准每一次推送吗？",
        a: "只需要批准某个指纹的第一次推送，而且仅当 serve 是在带终端的环境下运行时才会提示。此后它会被记住。如果 serve 以非交互方式运行（systemd、管道），就完全不会出现提示，而是直接拒绝未知对端——这时应改为用 relayium authorize 预先授权它们。",
      },
      {
        q: "发送方可以删除我这台常驻接收机上的文件吗？",
        a: "只有当你以 --allow-delete 启动了 serve，并且发送方在运行 sync --delete 时才可以。如果没有 --allow-delete，删除操作会被静默跳过，其余内容照常传输。",
      },
      {
        q: "运行一个常驻接收服务是免费的吗？",
        a: "是的。relayium serve 是免费、可自托管的 CLI 的一部分——连接的任何一方都不需要账号，也没有付费档位。",
      },
      {
        q: "serve 把身份和对端列表存在哪里？",
        a: "默认在 ~/.config/relayium 中（id.key/id.crt 是这台主机的身份，authorized_fingerprints 是允许列表）。对于 systemd 服务，可以把 --config-dir 指向一个固定位置，例如 /etc/relayium。",
      },
      {
        q: "在 macOS 上怎么让 serve 开机自启？",
        a: "macOS 没有 systemd——用 launchd。把 serve 装成 /Library/LaunchDaemons 里的 LaunchDaemon（开机启动；设置 UserName 以你的身份运行），或 ~/Library/LaunchAgents 里的 LaunchAgent（登录时启动）。本指南给了一份可直接改的 plist；没有 Homebrew 服务。由于 launchd 不给 serve 终端弹提示，请先用 relayium authorize 预先授权推送方。",
      },
    ],
  },
  cta: {
    text: "把你拥有的任何一台机器变成一个免费的常驻接收方——通过证书固定的 TLS 直接推送，不经过任何中继。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium を常時稼働の受信サービスとして実行する",
  description:
    "relayium serve を起動したままにして、どのピアからでもいつでもプッシュを受け取れるようにします——証明書ピンニング付き TLS 上でのデーモン直結です。初回プッシュの承認、フィンガープリントの事前認可、systemd (Linux) または launchd (macOS) による起動時の自動実行、そして --allow-delete について解説します。",
  updatedLabel: "最終更新",
  lead: [
    "relayium serve --once は1回の受信を処理して終了します——たまに1回だけ pull する用途には十分です。しかし、あるマシンを常駐の受け皿にしたい場合——毎晩バックアップが届くホームサーバー、CI がビルド成果物をプッシュするビルドマシン、スマートフォンからいつでも写真を送れる NAS——には、毎回手動で起動するのではなく、serve をずっと動かし続けたいはずです。",
    "本ガイドでは、長時間稼働するリスナーの起動、誰にプッシュを許可するかの承認、端末の前に誰もいない場合のためのピア事前承認、systemd 下での実行、そして sync --delete を使う送信側に削除をミラーさせる方法を扱います。",
  ],
  sections: [
    {
      heading: "リスナーを起動する",
      body: [
        "serve は証明書ピンニング付き TLS 1.3 接続上でデーモン直結のプッシュ(relayium://host:port)を待ち受け、受け取った内容をあるディレクトリへ書き込みます。起動するのに事前共有は何も必要ありません——コピーしておくフィンガープリントも、登録しておくサーバーもありません:",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # デフォルト以外のポート
relayium serve --dir ~/inbox --allow-delete  # sync --delete を使う送信側に削除をミラーさせる`,
      ],
      bullets: [
        "--dir はファイルの置き場所を設定します(デフォルトはカレントディレクトリ)。",
        "--port は待ち受けポートを設定します(デフォルトは 9031)。送信側が別の場所にいる場合はファイアウォールで開放してください。",
        "--once を付けなければ、serve は停止させるかプロセスマネージャーが再起動するまで動き続け、プッシュを受け入れ続けます——これが常時稼働サービスたる所以です。",
      ],
    },
    {
      heading: "誰にプッシュを許可するか承認する",
      body: [
        "新しいピアが初めてプッシュすると、serve がターミナルで動いていれば、そのプッシュがどこから来たか、フィンガープリントは何かを表示し、承認するかどうかを尋ねます——SSH が初めての接続先を尋ねるのと同じ要領です:",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "一度 y と答えれば、そのフィンガープリントは authorized_fingerprints に書き込まれます。以降、同じマシンからのプッシュはプロンプトなしで通過します。",
        "フィンガープリントはネットワークアドレスではなくマシンそのものを識別するため、送信側の IP が変わっても有効です。",
        "この手順は設計上、対話的です——キーボードの前に誰かが必要ですが、serve が systemd に移行すると(次の項目)それは成り立たなくなります。",
      ],
    },
    {
      heading: "非対話的な環境のためにピアを事前承認する",
      body: [
        "serve がプロンプトを出せる端末を持たない場合——systemd サービス、バックグラウンドプロセス、パイプなど——尋ねることができないため、まだ認識していないフィンガープリントはすべて拒否します。代わりに事前にピアを承認しておきます。プッシュする側のマシンで relayium id を実行してフィンガープリントを表示し、受信側では最初のプッシュが届く前にそれを追加します:",
      ],
      code: [
        `# プッシュする側のマシンで: フィンガープリントを表示する
relayium id

# この常時稼働の受信側で: 事前に承認しておく
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize は冪等です——すでに信頼しているフィンガープリントに対して再度実行しても何も起きません。",
        "アイデンティティと信頼のファイルは --config-dir で指定したディレクトリにあり、デフォルトは ~/.config/relayium です(id.key/id.crt はこのホストのアイデンティティ、authorized_fingerprints はピアの許可リスト)。",
      ],
    },
    {
      heading: "systemd の下で実行する",
      body: [
        "再起動やクラッシュをまたいで生き残るサービスにするには、serve を systemd に任せます。--config-dir を固定パスに向けて、ホストのアイデンティティとピア許可リストが再起動をまたいでも維持されるようにします:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "このサービスを有効化する前に、プッシュを許可すべきすべてのピアに対して relayium authorize <fingerprint> を実行しておいてください——サービス自体はプロンプトを出せません。",
        "systemctl enable --now relayium-serve で起動し、起動のたびに復帰するようにします。",
        "/etc/relayium/id.key はサービスユーザーだけが読めるようにしてください。権限が緩い鍵は relayium が読み込みを拒否します。",
      ],
    },
    {
      heading: "macOS で起動時に実行する (launchd)",
      body: [
        "macOS に systemd はありません——サービスマネージャーは launchd です。Mac 上で serve を動かし続けるには(受け取り口として常時稼働させる Mac mini など)、LaunchDaemon としてインストールし、誰もログインしていない起動時から開始させます。UserName を設定して root ではなく自分のユーザーとして実行し、--dir と --config-dir には絶対パスを指定して、アイデンティティと信頼のファイルが自分の ~/.config/relayium に残るようにします:",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "launchd は serve にターミナルを与えないため、プロンプトを出せません——systemd のときと同様に、各プッシュ元について先に relayium authorize <fingerprint> を実行してください。フィンガープリントはそのマシンの relayium id から得られます。",
        "KeepAlive は serve がクラッシュしたときに再起動します。RunAtLoad と /Library/LaunchDaemons 内の LaunchDaemon を組み合わせれば、ログインなしで起動時に開始します——ヘッドレスの Mac mini にぴったりです。",
        "ログイン時だけ動くサービスにしたい場合は、同じ plist(UserName キーは削除)を ~/Library/LaunchAgents/ に置き、launchctl bootstrap gui/$(id -u) <path> で読み込みます——起動時ではなくログイン時に開始します。",
        "macOS のアプリケーションファイアウォールが有効な場合は、relayium の受信接続を許可してください(システム設定 → ネットワーク → ファイアウォール)。そうしないと、待ち受けポートへのプッシュがブロックされます。",
      ],
    },
    {
      heading: "sync --delete を使う送信側に削除をミラーさせる",
      body: [
        "デフォルトでは serve はファイルの追加・更新しか行いません——送信側が sync --delete を実行しても、新規・変更ファイルはコピーされますが、要求された削除はスキップされ、受信側に警告がログ出力されます。真のミラーリングを有効にするには --allow-delete を付けて serve を起動します。これにより送信側で削除されたファイルはこちらでも削除されます:",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete は受信側で有効にするオプトインです。送信側は引き続き sync --delete で削除を要求する必要があります。",
        "このオプションを付けなければ、送信側が何を要求しても、このマシン上のファイルが削除されることはありません。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "serve はデフォルトでどのポートを待ち受けますか?",
        a: "9031 です。リスナー側(serve --port N)と送信側の宛先(relayium://host:N)の両方を --port で変更できます。",
      },
      {
        q: "すべてのプッシュを手動で承認する必要がありますか?",
        a: "あるフィンガープリントの最初のプッシュだけです。しかもそれは serve が端末付きで動いているときだけ表示されます。それ以降は記憶されます。serve を非対話的(systemd、パイプ)に動かす場合、プロンプトはまったく出ず未知のピアは拒否されます——その場合は relayium authorize で事前に承認してください。",
      },
      {
        q: "送信側は私の常時稼働の受信機上のファイルを削除できますか?",
        a: "serve を --allow-delete 付きで起動し、かつ送信側が sync --delete を実行している場合に限ります。--allow-delete がなければ削除は静かにスキップされ、それ以外は通常どおり転送されます。",
      },
      {
        q: "常時稼働の受信サービスを動かすのは無料ですか?",
        a: "はい。relayium serve は無料でセルフホスト可能な CLI の一部です——接続のどちら側もアカウントは不要で、有料プランもありません。",
      },
      {
        q: "serve はアイデンティティとピアリストをどこに保存しますか?",
        a: "デフォルトでは ~/.config/relayium です(id.key/id.crt はこのホストのアイデンティティ、authorized_fingerprints は許可リスト)。systemd サービスの場合は --config-dir を /etc/relayium のような固定の場所に向けてください。",
      },
      {
        q: "macOS で起動時に serve を実行するには?",
        a: "macOS に systemd はありません——launchd を使います。serve を /Library/LaunchDaemons に LaunchDaemon としてインストールする(起動時に開始。UserName を設定して自分のユーザーとして実行)か、~/Library/LaunchAgents に LaunchAgent としてインストールします(ログイン時に開始)。このガイドには編集してすぐ使える plist があります。Homebrew サービスはありません。launchd は serve にプロンプト用のターミナルを与えないため、先に relayium authorize でプッシュ元を事前認可してください。",
      },
    ],
  },
  cta: {
    text: "所有しているマシンならどれでも、無料の常時稼働受信機にできます——証明書ピンニング付き TLS 上の直接プッシュで、リレーは一切介在しません。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium을 상시 실행되는 수신 서비스로 운영하기",
  description:
    "relayium serve를 계속 실행해 두어 어떤 피어든 언제든 푸시할 수 있게 하세요——인증서 고정 TLS 위에서 동작하는 데몬 다이렉트입니다. 최초 푸시 승인, 핑거프린트 사전 인증, systemd(Linux) 또는 launchd(macOS)로 부팅 시 실행하기, 그리고 --allow-delete를 다룹니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "relayium serve --once는 들어오는 전송 하나만 처리하고 종료합니다——가끔 한 번 pull하는 용도로는 충분합니다. 하지만 어떤 기기를 상시 대기하는 수신처로 만들고 싶다면——밤사이 백업이 도착하는 홈 서버, CI가 빌드 산출물을 푸시하는 빌드 머신, 언제든 휴대폰에서 사진을 보낼 수 있는 NAS——매번 손으로 켜는 대신 serve를 계속 켜 두고 싶을 것입니다.",
    "이 가이드는 오래 실행되는 리스너 시작하기, 누구에게 푸시를 허용할지 승인하기, 터미널 앞에 아무도 없는 경우를 위해 피어를 미리 승인해 두기, systemd 아래에서 실행하기, 그리고 sync --delete를 쓰는 보내는 쪽이 삭제를 미러링하도록 허용하는 방법을 다룹니다.",
  ],
  sections: [
    {
      heading: "리스너 시작하기",
      body: [
        "serve는 인증서 고정 TLS 1.3 연결을 통해 데몬 다이렉트 푸시(relayium://host:port)를 대기하고, 받은 내용을 어떤 디렉터리에 기록합니다. 시작하는 데 미리 공유해야 할 것은 없습니다——복사해 둘 핑거프린트도, 등록해 둘 서버도 없습니다:",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # 기본값이 아닌 포트
relayium serve --dir ~/inbox --allow-delete  # sync --delete를 쓰는 보내는 쪽이 삭제를 미러링하도록 허용`,
      ],
      bullets: [
        "--dir는 파일이 도착할 위치를 설정합니다(기본값은 현재 디렉터리).",
        "--port는 대기 포트를 설정합니다(기본값 9031). 보내는 쪽이 다른 곳에 있다면 방화벽에서 열어 두세요.",
        "--once 없이 실행하면 serve는 직접 멈추거나 프로세스 매니저가 재시작할 때까지 계속 실행되며 푸시를 계속 받아들입니다——이것이 상시 서비스가 되는 이유입니다.",
      ],
    },
    {
      heading: "누구에게 푸시를 허용할지 승인하기",
      body: [
        "새로운 피어가 처음 푸시하면, serve가 터미널에서 실행 중일 경우 그 푸시가 어디서 왔는지와 핑거프린트를 보여주고 승인할지 물어봅니다——SSH가 처음 접속하는 호스트에 대해 물어보는 것과 같은 방식입니다:",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "한 번 y라고 답하면 그 핑거프린트가 authorized_fingerprints에 기록됩니다. 이후 같은 기기에서의 모든 푸시는 프롬프트 없이 통과합니다.",
        "핑거프린트는 네트워크 주소가 아니라 기기를 식별하므로, 보내는 쪽의 IP가 바뀌어도 유지됩니다.",
        "이 단계는 설계상 대화형입니다——키보드 앞에 누군가 있어야 하는데, serve가 systemd로 옮겨가면(다음 단계) 그렇지 않게 됩니다.",
      ],
    },
    {
      heading: "비대화형 환경을 위해 피어를 미리 승인하기",
      body: [
        "serve가 프롬프트를 띄울 터미널이 없을 때——systemd 서비스, 백그라운드 프로세스, 파이프——는 물어볼 수 없으므로 아직 인식하지 못한 핑거프린트를 모두 거부합니다. 대신 피어를 미리 승인해 두세요. 푸시할 기기에서 relayium id를 실행해 핑거프린트를 출력하고, 받는 쪽에서는 첫 푸시가 도착하기 전에 그것을 추가하세요:",
      ],
      code: [
        `# 푸시할 기기에서: 핑거프린트 출력하기
relayium id

# 이 상시 수신기에서: 미리 승인해 두기
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize는 멱등적입니다——이미 신뢰하는 핑거프린트에 대해 다시 실행해도 아무 효과가 없습니다.",
        "신원 및 신뢰 파일은 --config-dir로 지정한 디렉터리에 있으며 기본값은 ~/.config/relayium입니다(id.key/id.crt는 이 호스트의 신원, authorized_fingerprints는 피어 허용 목록).",
      ],
    },
    {
      heading: "systemd 아래에서 실행하기",
      body: [
        "재부팅과 충돌을 견디는 서비스로 만들려면 serve를 systemd에 맡기세요. --config-dir을 고정된 경로로 지정해 호스트의 신원과 피어 허용 목록이 재시작 간에도 그대로 유지되게 하세요:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "이 서비스를 활성화하기 전에, 푸시를 허용해야 할 모든 피어에 대해 relayium authorize <fingerprint>를 실행해 두세요——서비스 자체는 프롬프트를 띄울 수 없습니다.",
        "systemctl enable --now relayium-serve로 시작하고 부팅할 때마다 다시 올라오게 하세요.",
        "/etc/relayium/id.key는 서비스 사용자만 읽을 수 있게 하세요——권한이 느슨한 키는 relayium이 불러오기를 거부합니다.",
      ],
    },
    {
      heading: "macOS에서 부팅 시 실행하기(launchd)",
      body: [
        "macOS에는 systemd가 없습니다——서비스 관리자는 launchd입니다. Mac에서 serve를 계속 실행하려면(이를테면 수신 지점으로 켜 둔 Mac mini) LaunchDaemon으로 설치해, 아무도 로그인하지 않은 부팅 시점에 시작되게 하세요. UserName을 설정해 root가 아닌 본인 계정으로 실행하고, --dir와 --config-dir에 절대 경로를 지정해 신원 및 신뢰 파일이 기존 ~/.config/relayium에 그대로 남게 하세요:",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "launchd는 serve에 터미널을 주지 않으므로 프롬프트를 띄울 수 없습니다——systemd와 마찬가지로, 푸시하는 쪽마다 먼저 relayium authorize <fingerprint>를 실행해 두세요. 핑거프린트는 그 기기의 relayium id에서 얻습니다.",
        "KeepAlive는 serve가 충돌하면 다시 시작합니다. RunAtLoad와 /Library/LaunchDaemons 안의 LaunchDaemon을 함께 쓰면 로그인 없이 부팅 시점에 시작됩니다——화면 없이 두는 Mac mini에 딱 맞습니다.",
        "로그인할 때만 도는 서비스를 원한다면, 같은 plist(UserName 키는 제거)를 ~/Library/LaunchAgents/에 두고 launchctl bootstrap gui/$(id -u) <path>로 로드하세요——부팅할 때가 아니라 로그인할 때 시작됩니다.",
        "macOS 응용 프로그램 방화벽이 켜져 있다면 relayium의 수신 연결을 허용하세요(시스템 설정 → 네트워크 → 방화벽). 그렇지 않으면 그 포트로 오는 푸시가 차단됩니다.",
      ],
    },
    {
      heading: "sync --delete를 쓰는 보내는 쪽이 삭제를 미러링하도록 허용하기",
      body: [
        "기본적으로 serve는 파일을 추가하거나 갱신하기만 합니다——보내는 쪽이 sync --delete를 실행해도 새 파일과 변경된 파일은 복사되지만, 요청된 삭제는 건너뛰고 받는 쪽 로그에 경고가 남습니다. 진짜 미러링을 사용하려면 --allow-delete와 함께 serve를 시작하세요. 그러면 보내는 쪽에서 삭제된 파일이 여기서도 삭제됩니다:",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete는 받는 쪽에서 선택하는 옵트인입니다. 보내는 쪽은 여전히 sync --delete로 삭제를 요청해야 합니다.",
        "이 옵션이 없으면 보내는 쪽이 무엇을 요청하든 이 기기에서는 아무 파일도 삭제되지 않습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "serve는 기본적으로 어떤 포트를 대기하나요?",
        a: "9031입니다. 리스너 쪽(serve --port N)과 보내는 쪽의 대상 주소(relayium://host:N) 모두에서 --port로 바꿀 수 있습니다.",
      },
      {
        q: "모든 푸시를 일일이 손으로 승인해야 하나요?",
        a: "특정 핑거프린트의 첫 푸시만 승인하면 됩니다. 그것도 serve가 터미널이 연결된 상태로 실행 중일 때만 표시됩니다. 이후에는 기억됩니다. serve를 비대화형(systemd, 파이프)으로 실행하면 프롬프트가 전혀 뜨지 않고 알 수 없는 피어는 거부됩니다——이 경우 relayium authorize로 미리 승인해 두세요.",
      },
      {
        q: "보내는 쪽이 내 상시 수신기에 있는 파일을 삭제할 수 있나요?",
        a: "serve를 --allow-delete와 함께 시작했고 보내는 쪽이 sync --delete를 실행하는 경우에만 가능합니다. --allow-delete가 없으면 삭제는 조용히 건너뛰고 나머지는 그대로 전송됩니다.",
      },
      {
        q: "상시 수신 서비스를 운영하는 것이 무료인가요?",
        a: "네. relayium serve는 무료이며 자체 호스팅 가능한 CLI의 일부입니다——연결 어느 쪽도 계정이 필요 없고 유료 등급도 없습니다.",
      },
      {
        q: "serve는 신원과 피어 목록을 어디에 보관하나요?",
        a: "기본적으로 ~/.config/relayium에 있습니다(id.key/id.crt는 이 호스트의 신원, authorized_fingerprints는 허용 목록). systemd 서비스의 경우 --config-dir을 /etc/relayium 같은 고정된 위치로 지정하세요.",
      },
      {
        q: "macOS에서 부팅 시 serve를 실행하려면?",
        a: "macOS에는 systemd가 없습니다——launchd를 사용하세요. serve를 /Library/LaunchDaemons에 LaunchDaemon으로 설치하거나(부팅 시 시작, UserName을 설정해 본인 계정으로 실행), ~/Library/LaunchAgents에 LaunchAgent로 설치하세요(로그인 시 시작). 이 가이드에는 바로 고쳐 쓸 수 있는 plist가 있습니다. Homebrew 서비스는 없습니다. launchd는 serve에 프롬프트를 띄울 터미널을 주지 않으므로, 먼저 relayium authorize로 푸시하는 쪽을 미리 승인해 두세요.",
      },
    ],
  },
  cta: {
    text: "가지고 있는 어떤 기기든 무료 상시 수신기로 만들어 보세요——인증서 고정 TLS 위의 직접 푸시이며, 릴레이는 전혀 개입하지 않습니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium als dauerhaft laufenden Empfangsdienst betreiben",
  description:
    "Halte relayium serve am Laufen, damit jeder Peer dir jederzeit etwas pushen kann — daemon-direct über TLS mit Pinning. Behandelt die Freigabe des ersten Push, das Vorab-Autorisieren von Fingerprints, den Start beim Booten unter systemd (Linux) oder launchd (macOS) sowie --allow-delete.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "relayium serve --once nimmt eine eingehende Übertragung entgegen und beendet sich dann — gut für ein gelegentliches Pull. Willst du aber eine Maschine zu einer dauerhaften Anlaufstelle machen — einen Heimserver, auf dem nachts Backups landen, eine Build-Maschine, zu der CI Artefakte pusht, ein NAS, an das dein Handy jederzeit Fotos schicken kann —, soll serve durchgehend laufen, statt für jede Übertragung von Hand gestartet zu werden.",
    "Diese Anleitung behandelt das Starten eines dauerhaft laufenden Listeners, das Genehmigen, wer pushen darf, das Vorab-Autorisieren von Peers für den Fall, dass niemand am Terminal sitzt, den Betrieb unter systemd sowie das Zulassen, dass ein sync --delete-Sender Löschungen spiegelt.",
  ],
  sections: [
    {
      heading: "Den Listener starten",
      body: [
        "serve lauscht über eine TLS-1.3-Verbindung mit Pinning auf Pushes per daemon-direct (relayium://host:port) und schreibt das Empfangene in ein Verzeichnis. Zum Starten muss nichts vorab geteilt werden — keine Fingerprints zum Kopieren, kein Server zum Registrieren:",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # abweichender Port
relayium serve --dir ~/inbox --allow-delete  # einem sync --delete-Sender erlauben, Löschungen zu spiegeln`,
      ],
      bullets: [
        "--dir legt fest, wo Dateien landen (Standard ist das aktuelle Verzeichnis).",
        "--port legt den Lauschport fest (Standard 9031); öffne ihn in deiner Firewall, wenn der Sender woanders sitzt.",
        "Ohne --once läuft serve weiter und nimmt Pushes an, bis du es stoppst oder ein Prozessmanager es neu startet — genau das macht es zu einem dauerhaften Dienst.",
      ],
    },
    {
      heading: "Genehmigen, wer pushen darf",
      body: [
        "Wenn ein neuer Peer zum ersten Mal pusht, zeigt dir serve — sofern es in einem Terminal läuft — woher der Push kam und seinen Fingerprint und bittet dich um Genehmigung, genauso wie SSH bei einem unbekannten Host beim ersten Verbinden nachfragt:",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Antworte einmal mit y, und dieser Fingerprint wird in authorized_fingerprints geschrieben; jeder spätere Push von derselben Maschine läuft dann ohne Nachfrage durch.",
        "Ein Fingerprint identifiziert eine Maschine, keine Netzwerkadresse, und bleibt daher gültig, auch wenn sich die IP des Senders ändert.",
        "Dieser Schritt ist von Grund auf interaktiv angelegt — er braucht jemanden an der Tastatur, was nicht mehr zutrifft, sobald serve zu systemd wechselt (nächster Abschnitt).",
      ],
    },
    {
      heading: "Peers für nicht-interaktive Setups vorab autorisieren",
      body: [
        "Hat serve kein Terminal, an dem es nachfragen kann — ein systemd-Dienst, ein Hintergrundprozess, eine Pipe —, kann es nicht fragen und lehnt daher jeden noch nicht erkannten Fingerprint ab. Autorisiere Peers stattdessen im Voraus. Auf der Maschine, die pushen wird, führst du relayium id aus, um ihren Fingerprint auszugeben; auf dem Empfänger trägst du ihn ein, bevor der erste Push eintrifft:",
      ],
      code: [
        `# auf der Maschine, die pushen wird: ihren Fingerprint ausgeben
relayium id

# auf diesem dauerhaft laufenden Empfänger: sie vorab autorisieren
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize ist idempotent — es für einen bereits vertrauten Fingerprint erneut auszuführen, bewirkt nichts.",
        "Identitäts- und Vertrauensdateien liegen im mit --config-dir angegebenen Verzeichnis, standardmäßig ~/.config/relayium (id.key/id.crt ist die Identität dieses Hosts, authorized_fingerprints die Allow-Liste der Peers).",
      ],
    },
    {
      heading: "Unter systemd betreiben",
      body: [
        "Für einen Dienst, der Neustarts und Abstürze übersteht, überlässt du serve systemd. Richte --config-dir auf einen festen Pfad, damit Identität und Peer-Allow-Liste des Hosts über Neustarts hinweg erhalten bleiben:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "Bevor du den Dienst aktivierst, führe relayium authorize <fingerprint> für jeden Peer aus, der pushen dürfen soll — der Dienst selbst kann nicht nachfragen.",
        "systemctl enable --now relayium-serve startet ihn und bringt ihn bei jedem Boot wieder hoch.",
        "Halte /etc/relayium/id.key nur für den Dienstbenutzer lesbar; relayium verweigert das Laden eines Schlüssels mit zu lockeren Berechtigungen.",
      ],
    },
    {
      heading: "Beim Booten unter macOS starten (launchd)",
      body: [
        "macOS hat kein systemd — sein Dienstmanager ist launchd. Um serve auf einem Mac dauerhaft laufen zu lassen (etwa auf einem Mac mini, der als Ablagepunkt eingeschaltet bleibt), installiere es als LaunchDaemon, damit es beim Booten startet, noch bevor sich jemand anmeldet. Setze UserName, damit er unter deinem Benutzerkonto und nicht als root läuft, und gib --dir und --config-dir absolute Pfade an, damit Identität und Vertrauensdateien in deinem eigenen ~/.config/relayium bleiben:",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "launchd gibt serve kein Terminal, es kann also nicht nachfragen — führe für jeden Absender zuerst relayium authorize <fingerprint> aus, genau wie bei systemd. Der Fingerprint stammt aus dem relayium id jener Maschine.",
        "KeepAlive startet serve neu, falls es abstürzt; RunAtLoad zusammen mit einem LaunchDaemon in /Library/LaunchDaemons startet es beim Booten ohne Anmeldung — genau das Richtige für einen kopflosen Mac mini.",
        "Lieber einen anmeldungsbezogenen Dienst? Lege dasselbe plist (ohne den UserName-Schlüssel) in ~/Library/LaunchAgents/ ab und lade es mit launchctl bootstrap gui/$(id -u) <path> — es startet bei deiner Anmeldung statt beim Booten.",
        "Wenn die Anwendungs-Firewall von macOS aktiv ist, erlaube eingehende Verbindungen für relayium (Systemeinstellungen → Netzwerk → Firewall), sonst werden Pushes an deinen Port blockiert.",
      ],
    },
    {
      heading: "Einem sync --delete-Sender erlauben, Löschungen zu spiegeln",
      body: [
        "Standardmäßig fügt serve nur Dateien hinzu oder aktualisiert sie — führt ein Sender sync --delete dagegen aus, werden neue und geänderte Dateien trotzdem kopiert, aber angeforderte Löschungen werden übersprungen und auf dem Empfänger als Warnung protokolliert. Starte serve mit --allow-delete, um echtes Spiegeln zu aktivieren, bei dem auf der Senderseite gelöschte Dateien auch hier gelöscht werden:",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete ist ein Opt-in auf Empfängerseite; der Sender muss weiterhin mit sync --delete danach fragen.",
        "Ohne diese Option wird auf dieser Maschine niemals etwas gelöscht, egal was ein Sender anfordert.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Auf welchem Port lauscht serve standardmäßig?",
        a: "9031. Ändere ihn mit --port sowohl beim Listener (serve --port N) als auch beim Ziel des Senders (relayium://host:N).",
      },
      {
        q: "Muss ich jeden einzelnen Push von Hand genehmigen?",
        a: "Nur den ersten Push eines bestimmten Fingerprints, und nur, wenn serve mit angeschlossenem Terminal läuft. Danach wird er sich gemerkt. Läuft serve nicht-interaktiv (systemd, eine Pipe), entfällt die Nachfrage komplett, und unbekannte Peers werden abgelehnt — autorisiere sie stattdessen vorab mit relayium authorize.",
      },
      {
        q: "Kann ein Sender Dateien auf meinem dauerhaft laufenden Empfänger löschen?",
        a: "Nur wenn du serve mit --allow-delete gestartet hast und der Sender sync --delete ausführt. Ohne --allow-delete werden Löschungen stillschweigend übersprungen, alles andere wird trotzdem übertragen.",
      },
      {
        q: "Ist der Betrieb eines dauerhaft laufenden Empfängers kostenlos?",
        a: "Ja. relayium serve ist Teil der kostenlosen, selbst hostbaren CLI — auf keiner Seite der Verbindung ist ein Konto oder eine kostenpflichtige Stufe nötig.",
      },
      {
        q: "Wo bewahrt serve Identität und Peer-Liste auf?",
        a: "Standardmäßig in ~/.config/relayium (id.key/id.crt für die Identität dieses Hosts, authorized_fingerprints für die Allow-Liste). Richte --config-dir für einen systemd-Dienst auf einen festen Ort wie /etc/relayium.",
      },
      {
        q: "Wie starte ich serve beim Booten unter macOS?",
        a: "macOS hat kein systemd — verwende launchd. Installiere serve als LaunchDaemon in /Library/LaunchDaemons (startet beim Booten; setze UserName, damit er unter deinem Benutzerkonto läuft) oder als LaunchAgent in ~/Library/LaunchAgents (startet bei der Anmeldung). Diese Anleitung enthält ein fertiges, editierbares plist; einen Homebrew-Dienst gibt es nicht. Autorisiere Absender vorab mit relayium authorize, da launchd serve kein Terminal für Rückfragen gibt.",
      },
    ],
  },
  cta: {
    text: "Mach aus jeder Maschine, die dir gehört, einen kostenlosen, dauerhaft laufenden Empfänger — direkte Pushes über TLS mit Pinning, ganz ohne Relay.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Faire tourner Relayium en service de réception permanent",
  description:
    "Gardez relayium serve en fonctionnement pour que n'importe quel pair puisse vous pousser des fichiers à tout moment — en daemon-direct sur TLS avec épinglage. Couvre l'approbation du premier push, la pré-autorisation des empreintes, le lancement au démarrage sous systemd (Linux) ou launchd (macOS), ainsi que --allow-delete.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "relayium serve --once traite un seul transfert entrant puis s'arrête — parfait pour un pull occasionnel. Mais si vous voulez qu'une machine soit un point de dépôt permanent — un serveur domestique qui reçoit des sauvegardes chaque nuit, une machine de build vers laquelle la CI pousse des artefacts, un NAS auquel votre téléphone peut envoyer des photos à tout moment — vous voulez que serve tourne en continu, sans avoir à le démarrer à la main à chaque transfert.",
    "Ce guide couvre le démarrage d'un processus à l'écoute de longue durée, l'approbation de qui est autorisé à envoyer, l'autorisation préalable des pairs pour les cas où personne n'est devant le terminal, l'exécution sous systemd, et le fait de laisser un émetteur utilisant sync --delete répercuter les suppressions.",
  ],
  sections: [
    {
      heading: "Démarrer le processus à l'écoute",
      body: [
        "serve écoute les envois en daemon-direct (relayium://host:port) via une connexion TLS 1.3 avec épinglage et écrit ce qu'il reçoit dans un répertoire. Rien n'a besoin d'être partagé au préalable pour le démarrer — aucune empreinte à copier, aucun serveur à enregistrer :",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # port autre que celui par défaut
relayium serve --dir ~/inbox --allow-delete  # laisser un émetteur sync --delete répercuter les suppressions`,
      ],
      bullets: [
        "--dir définit où les fichiers atterrissent (le répertoire courant par défaut).",
        "--port définit le port d'écoute (9031 par défaut) ; ouvrez-le sur votre pare-feu si l'émetteur se trouve ailleurs.",
        "Sans --once, serve continue de tourner et d'accepter des envois jusqu'à ce que vous l'arrêtiez ou qu'un gestionnaire de processus le redémarre — c'est ce qui en fait un service permanent.",
      ],
    },
    {
      heading: "Approuver qui est autorisé à envoyer",
      body: [
        "La première fois qu'un nouveau pair envoie quelque chose, serve — s'il tourne dans un terminal — vous montre d'où vient l'envoi et son empreinte, puis vous demande de l'approuver, de la même façon que SSH interroge sur un hôte inconnu à la première connexion :",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Répondez y une fois et cette empreinte est écrite dans authorized_fingerprints ; chaque envoi ultérieur depuis la même machine passe alors sans invite.",
        "Une empreinte identifie une machine, pas une adresse réseau, donc elle reste valable même si l'IP de l'émetteur change.",
        "Cette étape est interactive par conception — il faut quelqu'un devant le clavier, ce qui ne sera plus vrai une fois que serve passera sous systemd (section suivante).",
      ],
    },
    {
      heading: "Autoriser des pairs à l'avance pour les configurations non interactives",
      body: [
        "Quand serve n'a pas de terminal où demander confirmation — un service systemd, un processus en arrière-plan, un pipe — il ne peut pas interroger et refuse donc toute empreinte qu'il ne reconnaît pas encore. Autorisez plutôt les pairs à l'avance. Sur la machine qui va envoyer, exécutez relayium id pour afficher son empreinte ; sur le récepteur, ajoutez-la avant que le premier envoi n'arrive :",
      ],
      code: [
        `# sur la machine qui va envoyer, afficher son empreinte
relayium id

# sur ce récepteur permanent, l'autoriser à l'avance
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize est idempotent — l'exécuter à nouveau pour une empreinte déjà approuvée ne fait rien.",
        "Les fichiers d'identité et de confiance se trouvent dans le répertoire indiqué par --config-dir, ~/.config/relayium par défaut (id.key/id.crt sont l'identité de cet hôte, authorized_fingerprints est la liste d'autorisation des pairs).",
      ],
    },
    {
      heading: "Exécuter sous systemd",
      body: [
        "Pour un service qui survit aux redémarrages et aux plantages, confiez serve à systemd. Faites pointer --config-dir vers un chemin fixe pour que l'identité de l'hôte et sa liste de pairs autorisés restent stables d'un redémarrage à l'autre :",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "Avant d'activer le service, exécutez relayium authorize <fingerprint> pour chaque pair qui doit pouvoir envoyer — le service lui-même ne peut pas demander confirmation.",
        "systemctl enable --now relayium-serve le démarre et le fait redémarrer à chaque démarrage de la machine.",
        "Gardez /etc/relayium/id.key lisible uniquement par l'utilisateur du service ; relayium refuse de charger une clé aux permissions trop permissives.",
      ],
    },
    {
      heading: "Le lancer au démarrage sous macOS (launchd)",
      body: [
        "macOS n'a pas de systemd — son gestionnaire de services est launchd. Pour maintenir serve en fonctionnement sur un Mac (par exemple un Mac mini laissé allumé comme point de dépôt), installez-le en tant que LaunchDaemon afin qu'il démarre au démarrage, avant que quiconque ne se connecte. Définissez UserName pour qu'il s'exécute sous votre compte plutôt qu'en root, et donnez à --dir et --config-dir des chemins absolus pour que ses fichiers d'identité et de confiance restent dans votre propre ~/.config/relayium :",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "launchd ne donne aucun terminal à serve, il ne peut donc pas demander de confirmation — exécutez d'abord relayium authorize <fingerprint> pour chaque expéditeur, comme avec systemd. L'empreinte provient du relayium id de cette machine.",
        "KeepAlive redémarre serve s'il plante ; RunAtLoad avec un LaunchDaemon dans /Library/LaunchDaemons le lance au démarrage sans connexion — le choix idéal pour un Mac mini sans écran.",
        "Vous préférez un service à portée de session ? Placez le même plist (sans la clé UserName) dans ~/Library/LaunchAgents/ et chargez-le avec launchctl bootstrap gui/$(id -u) <path> — il démarre à votre connexion plutôt qu'au démarrage.",
        "Si le coupe-feu applicatif de macOS est activé, autorisez les connexions entrantes pour relayium (Réglages Système → Réseau → Coupe-feu), sinon les envois vers votre port seront bloqués.",
      ],
    },
    {
      heading: "Laisser un émetteur utilisant sync --delete répercuter les suppressions",
      body: [
        "Par défaut, serve ne fait qu'ajouter ou mettre à jour des fichiers — un émetteur qui exécute sync --delete contre lui voit quand même ses fichiers nouveaux et modifiés copiés, mais les suppressions demandées sont ignorées, avec un avertissement consigné côté récepteur. Démarrez serve avec --allow-delete pour activer un vrai miroir, où les fichiers supprimés côté émetteur le sont aussi ici :",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete est une option activée côté récepteur ; l'émetteur doit tout de même la demander avec sync --delete.",
        "Sans cette option, rien n'est jamais supprimé sur cette machine, quoi que demande un émetteur.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Sur quel port serve écoute-t-il par défaut ?",
        a: "9031. Changez-le avec --port aussi bien sur le processus à l'écoute (serve --port N) que sur la cible de l'émetteur (relayium://host:N).",
      },
      {
        q: "Dois-je approuver chaque envoi à la main ?",
        a: "Seulement le premier envoi d'une empreinte donnée, et uniquement quand serve tourne avec un terminal attaché. Ensuite, c'est mémorisé. Faire tourner serve de façon non interactive (systemd, un pipe) supprime totalement l'invite et rejette les pairs inconnus — autorisez-les plutôt à l'avance avec relayium authorize.",
      },
      {
        q: "Un émetteur peut-il supprimer des fichiers sur mon récepteur permanent ?",
        a: "Seulement si vous avez démarré serve avec --allow-delete et que l'émetteur exécute sync --delete. Sans --allow-delete, les suppressions sont silencieusement ignorées et tout le reste est transféré normalement.",
      },
      {
        q: "Faire tourner un récepteur permanent est-il gratuit ?",
        a: "Oui. relayium serve fait partie de la CLI gratuite et auto-hébergeable — aucun compte, aucun palier payant, des deux côtés de la connexion.",
      },
      {
        q: "Où serve conserve-t-il son identité et sa liste de pairs ?",
        a: "Par défaut dans ~/.config/relayium (id.key/id.crt pour l'identité de cet hôte, authorized_fingerprints pour la liste d'autorisation). Pour un service systemd, faites pointer --config-dir vers un emplacement fixe comme /etc/relayium.",
      },
      {
        q: "Comment lancer serve au démarrage sous macOS ?",
        a: "macOS n'a pas de systemd — utilisez launchd. Installez serve en tant que LaunchDaemon dans /Library/LaunchDaemons (se lance au démarrage ; définissez UserName pour qu'il s'exécute sous votre compte), ou en tant que LaunchAgent dans ~/Library/LaunchAgents (démarre à la connexion). Ce guide fournit un plist prêt à éditer ; il n'y a pas de service Homebrew. Pré-autorisez les expéditeurs avec relayium authorize au préalable, car launchd ne donne à serve aucun terminal pour demander confirmation.",
      },
    ],
  },
  cta: {
    text: "Transformez n'importe laquelle de vos machines en récepteur permanent et gratuit — envois directs via TLS avec épinglage, sans aucun relais.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "شغّل Relayium كخدمة استقبال دائمة التشغيل",
  description:
    "أبقِ relayium serve قيد التشغيل حتى يتمكن أي نظير من الدفع إليك في أي وقت — daemon direct عبر TLS مثبَّت. يغطّي الموافقة على أول دفعة، والتفويض المسبق للبصمات، وتشغيله عند الإقلاع تحت systemd (لينكس) أو launchd (ماك)، و--allow-delete.",
  updatedLabel: "آخر تحديث",
  lead: [
    "يتعامل relayium serve --once مع عملية نقل واردة واحدة ثم يخرج — وهذا مناسب لعملية سحب لمرة واحدة. لكن إذا أردت أن تكون آلة ما نقطة إنزال دائمة — خادم منزلي تصل إليه النسخ الاحتياطية ليلًا، أو آلة بناء يدفع إليها CI منتجاتها، أو NAS يستطيع هاتفك إرسال الصور إليه في أي وقت — فأنت تريد أن يظل serve قيد التشغيل طوال الوقت، لا أن يُشغَّل يدويًا لكل عملية نقل.",
    "يغطّي هذا الدليل بدء مُستمِع طويل التشغيل، والموافقة على من يُسمَح له بالدفع إليه، والتفويض المسبق للنظراء في الحالات التي لا يكون فيها أحد أمام الطرفية، وتشغيله تحت systemd، والسماح لمُرسِل يستخدم sync --delete بأن يعكس عمليات الحذف.",
  ],
  sections: [
    {
      heading: "ابدأ المُستمِع",
      body: [
        "يستمع serve إلى عمليات الدفع بأسلوب daemon direct (relayium://host:port) عبر اتصال TLS 1.3 مثبَّت ويكتب ما يستقبله في مجلد. لا حاجة إلى مشاركة أي شيء مسبقًا لبدئه — لا بصمات لنسخها، ولا خادم للتسجيل فيه:",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # منفذ غير افتراضي
relayium serve --dir ~/inbox --allow-delete  # السماح لمُرسِل يستخدم sync --delete بعكس عمليات الحذف`,
      ],
      bullets: [
        "--dir يحدد المكان الذي تصل إليه الملفات (الافتراضي هو المجلد الحالي).",
        "--port يحدد منفذ الاستماع (الافتراضي هو 9031)؛ افتحه في جدار الحماية إذا كان المُرسِل في مكان آخر.",
        "بدون --once، يظل serve قيد التشغيل ويقبل عمليات الدفع حتى توقفه أنت أو يعيد مدير عمليات تشغيله — وهذا ما يجعله خدمة دائمة التشغيل.",
      ],
    },
    {
      heading: "وافق على من يُسمَح له بالدفع",
      body: [
        "في أول مرة يدفع فيها نظير جديد، يعرض لك serve — إن كان يعمل في طرفية — من أين أتت الدفعة وبصمتها ويطلب منك الموافقة عليها، بالطريقة نفسها التي يسأل بها SSH عن مضيف مجهول عند أول اتصال:",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "أجب بـ y مرة واحدة، فتُكتَب تلك البصمة في authorized_fingerprints؛ وتمرّ كل دفعة لاحقة من الآلة نفسها دون أي مطالبة.",
        "تُعرّف البصمة آلةً لا عنوان شبكة، لذا تبقى صالحة حتى لو تغيّر عنوان IP الخاص بالمُرسِل.",
        "هذه الخطوة تفاعلية بحكم التصميم — تحتاج إلى شخص أمام لوحة المفاتيح، وهو ما لن يتحقق بمجرد انتقال serve إلى systemd (التالي).",
      ],
    },
    {
      heading: "فوّض النظراء مسبقًا للإعدادات غير التفاعلية",
      body: [
        "حين لا يملك serve طرفيةً يطالب عليها — خدمة systemd، أو عملية في الخلفية، أو أنبوب — فإنه لا يستطيع السؤال، ولذلك يرفض أي بصمة لا يعرفها مسبقًا. بدلًا من ذلك، فوّض النظراء مسبقًا. على الآلة التي ستدفع، شغّل relayium id لطباعة بصمتها؛ وعلى المُستقبِل، أضِفها قبل وصول أول دفعة:",
      ],
      code: [
        `# على الآلة التي ستدفع: اطبع بصمتها
relayium id

# على هذا المُستقبِل الدائم التشغيل: فوّضها مسبقًا
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize عملية عديمة الأثر عند التكرار (idempotent) — تشغيلها مجددًا لبصمة تثق بها مسبقًا لا يفعل شيئًا.",
        "توجد ملفات الهوية والثقة ضمن --config-dir، وقيمته الافتراضية ~/.config/relayium (id.key/id.crt هي هوية هذا المضيف، وauthorized_fingerprints هي قائمة السماح للنظراء).",
      ],
    },
    {
      heading: "شغّله تحت systemd",
      body: [
        "للحصول على خدمة تصمد أمام عمليات إعادة التشغيل والأعطال، سلّم serve إلى systemd. وجّه --config-dir إلى مسار ثابت حتى تبقى هوية المضيف وقائمة نظرائه المفوَّضين في مكانها عبر عمليات إعادة التشغيل:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "قبل تمكين الخدمة، شغّل ‎relayium authorize <fingerprint>‎ لكل نظير ينبغي أن يكون قادرًا على الدفع — فالخدمة نفسها لا تستطيع المطالبة.",
        "systemctl enable --now relayium-serve يشغّلها ويعيدها عند كل إقلاع.",
        "اجعل /etc/relayium/id.key قابلًا للقراءة من مستخدم الخدمة فقط؛ فـ relayium يرفض تحميل مفتاح ذي أذونات أكثر تساهلًا.",
      ],
    },
    {
      heading: "شغّله عند الإقلاع على macOS (launchd)",
      body: [
        "لا يملك macOS نظام systemd — فمدير خدماته هو launchd. لإبقاء serve قيد التشغيل على جهاز Mac (مثلًا Mac mini مُبقى مشغّلًا كنقطة إنزال)، ثبّته كـ LaunchDaemon حتى يبدأ عند الإقلاع، قبل أن يسجّل أحد الدخول. اضبط UserName حتى يعمل باسمك لا باسم root، وامنح --dir و--config-dir مسارات مطلقة حتى تبقى ملفات هويته وثقته في ~/.config/relayium الخاص بك:",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "لا يمنح launchd الخادم serve أي طرفية، فلا يستطيع المطالبة — شغّل ‎relayium authorize <fingerprint>‎ لكل جهة تدفع أولًا، تمامًا كما مع systemd. تأتي البصمة من relayium id الخاص بتلك الآلة.",
        "يعيد KeepAlive تشغيل serve إذا تعطّل؛ ويبدأه RunAtLoad مع LaunchDaemon في /Library/LaunchDaemons عند الإقلاع دون تسجيل دخول — وهو الخيار المناسب لجهاز Mac mini بلا شاشة.",
        "أتريد خدمة على نطاق تسجيل الدخول بدلًا من ذلك؟ ضع الـ plist نفسه (مع إسقاط مفتاح UserName) في ~/Library/LaunchAgents/ وحمّله بـ ‎launchctl bootstrap gui/$(id -u) <path>‎ — يبدأ عند تسجيل دخولك لا عند الإقلاع.",
        "إذا كان جدار حماية تطبيقات macOS مفعّلًا، فاسمح بالاتصالات الواردة لـ relayium (إعدادات النظام ← الشبكة ← جدار الحماية)، وإلا فستُحجَب عمليات الدفع إلى منفذك.",
      ],
    },
    {
      heading: "اسمح لمُرسِل يستخدم sync --delete بعكس عمليات الحذف",
      body: [
        "افتراضيًا، لا يقوم serve إلا بإضافة الملفات أو تحديثها — فالمُرسِل الذي يشغّل sync --delete تجاهه لا يزال ينسخ الملفات الجديدة والمتغيّرة، لكن أي عمليات حذف يطلبها تُتخطّى، مع تسجيل تحذير على المُستقبِل. شغّل serve مع --allow-delete للاشتراك في النسخ المطابق الحقيقي، حيث تُحذَف هنا أيضًا الملفات المحذوفة على جانب المُرسِل:",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete اشتراك اختياري على جانب المُستقبِل؛ ولا يزال على المُرسِل أن يطلبه بـ sync --delete.",
        "بدونه، لا يُحذَف أي شيء أبدًا على هذه الآلة، مهما طلب المُرسِل.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "ما المنفذ الذي يستمع إليه serve افتراضيًا؟",
        a: "9031. غيّره بـ --port على كلٍّ من المُستمِع (serve --port N) وهدف الجهة الدافعة (relayium://host:N).",
      },
      {
        q: "هل عليّ الموافقة على كل دفعة يدويًا؟",
        a: "الدفعة الأولى فقط من بصمة معيّنة، وفقط حين يعمل serve مع طرفية موصولة. وتُحفَظ بعد ذلك. أما تشغيل serve بشكل غير تفاعلي (systemd، أو أنبوب) فيتخطّى المطالبة كليًا ويرفض النظراء المجهولين — ففوّضهم مسبقًا بـ relayium authorize بدلًا من ذلك.",
      },
      {
        q: "هل يستطيع مُرسِل حذف ملفات على مُستقبِلي الدائم التشغيل؟",
        a: "فقط إذا بدأت serve بـ --allow-delete وكان المُرسِل يشغّل sync --delete. بدون --allow-delete، تُتخطّى عمليات الحذف بصمت وينتقل كل شيء آخر كالمعتاد.",
      },
      {
        q: "هل تشغيل مُستقبِل دائم التشغيل مجاني؟",
        a: "نعم. relayium serve جزء من واجهة سطر الأوامر (CLI) المجانية القابلة للاستضافة الذاتية — بلا حساب، وبلا فئة مدفوعة، على أي من طرفي الاتصال.",
      },
      {
        q: "أين يحفظ serve هويته وقائمة نظرائه؟",
        a: "في ~/.config/relayium افتراضيًا (id.key/id.crt لهوية هذا المضيف، وauthorized_fingerprints لقائمة السماح). وجّه --config-dir إلى مكان ثابت، مثل /etc/relayium، لخدمة systemd.",
      },
      {
        q: "كيف أشغّل serve عند الإقلاع على macOS؟",
        a: "لا يملك macOS نظام systemd — استخدم launchd. ثبّت serve كـ LaunchDaemon في /Library/LaunchDaemons (يبدأ عند الإقلاع؛ اضبط UserName ليعمل باسمك)، أو كـ LaunchAgent في ~/Library/LaunchAgents (يبدأ عند تسجيل الدخول). يحتوي هذا الدليل على ملف plist جاهز للتحرير؛ ولا توجد خدمة Homebrew. فوّض الجهات الدافعة مسبقًا بـ relayium authorize أولًا، لأن launchd لا يمنح serve أي طرفية للمطالبة عليها.",
      },
    ],
  },
  cta: {
    text: "حوّل أي آلة تملكها إلى مُستقبِل مجاني دائم التشغيل — عمليات دفع مباشرة عبر TLS مثبَّت، دون أي مُرحِّل.",
    button: "احصل على واجهة سطر الأوامر (CLI)",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Ejecuta Relayium como un servicio de recepción siempre activo",
  description:
    "Mantén relayium serve en ejecución para que cualquier par pueda enviarte archivos en cualquier momento — daemon directo sobre TLS con anclaje. Cubre la aprobación del primer envío, la autorización previa de huellas, ejecutarlo al arranque con systemd (Linux) o launchd (macOS), y --allow-delete.",
  updatedLabel: "Última actualización",
  lead: [
    "relayium serve --once atiende una única transferencia entrante y luego se cierra — perfecto para un pull ocasional. Pero si quieres que una máquina sea un punto de recepción permanente — un servidor doméstico en el que las copias de seguridad aterrizan cada noche, una máquina de compilación a la que CI envía artefactos, un NAS al que tu teléfono puede mandar fotos en cualquier momento — querrás que serve esté en ejecución todo el tiempo, en lugar de iniciarlo a mano para cada transferencia.",
    "Esta guía cubre cómo iniciar un proceso a la escucha de larga duración, aprobar quién puede enviar, autorizar pares de antemano para los casos en que no hay nadie ante la terminal, ejecutarlo con systemd, y permitir que un remitente que usa sync --delete refleje las eliminaciones.",
  ],
  sections: [
    {
      heading: "Iniciar el proceso a la escucha",
      body: [
        "serve escucha envíos daemon directo (relayium://host:port) a través de una conexión TLS 1.3 con anclaje y escribe lo que recibe en un directorio. No hace falta compartir nada de antemano para iniciarlo — ninguna huella que copiar, ningún servidor que registrar:",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # puerto distinto del predeterminado
relayium serve --dir ~/inbox --allow-delete  # permitir que un remitente con sync --delete refleje las eliminaciones`,
      ],
      bullets: [
        "--dir establece dónde aterrizan los archivos (por defecto, el directorio actual).",
        "--port establece el puerto de escucha (por defecto, 9031); ábrelo en tu cortafuegos si el remitente está en otro lugar.",
        "Sin --once, serve sigue en ejecución y aceptando envíos hasta que lo detengas o un gestor de procesos lo reinicie — eso es lo que lo convierte en un servicio siempre activo.",
      ],
    },
    {
      heading: "Aprobar quién puede enviar",
      body: [
        "La primera vez que un par nuevo envía algo, serve — si se está ejecutando en una terminal — te muestra de dónde vino el envío y su huella, y te pide que lo apruebes, igual que SSH pregunta por un host desconocido en la primera conexión:",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Responde y una vez y esa huella se escribe en authorized_fingerprints; cada envío posterior desde la misma máquina pasa sin ninguna solicitud.",
        "Una huella identifica a una máquina, no a una dirección de red, así que sigue siendo válida aunque cambie la IP del remitente.",
        "Este paso es interactivo por diseño — necesita a alguien ante el teclado, algo que dejará de cumplirse en cuanto serve pase a systemd (siguiente).",
      ],
    },
    {
      heading: "Autorizar pares de antemano para configuraciones no interactivas",
      body: [
        "Cuando serve no tiene una terminal en la que preguntar — un servicio systemd, un proceso en segundo plano, una tubería — no puede preguntar, así que rechaza cualquier huella que aún no reconozca. En su lugar, autoriza los pares con antelación. En la máquina que va a enviar, ejecuta relayium id para imprimir su huella; en el receptor, añádela antes de que llegue el primer envío:",
      ],
      code: [
        `# en la máquina que va a ENVIAR: imprime su huella
relayium id

# en este RECEPTOR siempre activo: autorízala de antemano
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize es idempotente — ejecutarlo de nuevo para una huella en la que ya confías no hace nada.",
        "Los archivos de identidad y de confianza viven bajo --config-dir, cuyo valor por defecto es ~/.config/relayium (id.key/id.crt es la identidad de este host, authorized_fingerprints es la lista de permitidos de pares).",
      ],
    },
    {
      heading: "Ejecutarlo con systemd",
      body: [
        "Para un servicio que sobreviva a reinicios y caídas, entrega serve a systemd. Apunta --config-dir a una ruta fija para que la identidad del host y su lista de pares permitidos permanezcan intactas entre reinicios:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "Antes de habilitar el servicio, ejecuta relayium authorize <fingerprint> para cada par que deba poder enviar — el servicio en sí no puede preguntar.",
        "systemctl enable --now relayium-serve lo inicia y hace que vuelva a levantarse en cada arranque.",
        "Mantén /etc/relayium/id.key legible solo por el usuario del servicio; relayium se niega a cargar una clave con permisos más laxos.",
      ],
    },
    {
      heading: "Ejecutarlo al arranque en macOS (launchd)",
      body: [
        "macOS no tiene systemd — su gestor de servicios es launchd. Para mantener serve en ejecución en un Mac (por ejemplo, un Mac mini que dejas encendido como punto de recepción), instálalo como LaunchDaemon para que se inicie en el arranque, antes de que nadie inicie sesión. Define UserName para que se ejecute como tú y no como root, y da a --dir y --config-dir rutas absolutas para que sus archivos de identidad y de confianza permanezcan en tu propio ~/.config/relayium:",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "launchd no da ninguna terminal a serve, así que no puede preguntar — ejecuta primero relayium authorize <fingerprint> para cada emisor, igual que con systemd. La huella proviene del relayium id de esa máquina.",
        "KeepAlive reinicia serve si se cae; RunAtLoad junto con un LaunchDaemon en /Library/LaunchDaemons lo inicia en el arranque sin necesidad de iniciar sesión — la opción idónea para un Mac mini sin monitor.",
        "¿Prefieres un servicio a nivel de sesión? Coloca el mismo plist (quitando la clave UserName) en ~/Library/LaunchAgents/ y cárgalo con launchctl bootstrap gui/$(id -u) <path> — se inicia al iniciar sesión en lugar de en el arranque.",
        "Si el cortafuegos de aplicaciones de macOS está activado, permite las conexiones entrantes para relayium (Ajustes del Sistema → Red → Cortafuegos), o los envíos a tu puerto quedarán bloqueados.",
      ],
    },
    {
      heading: "Permitir que un remitente con sync --delete refleje las eliminaciones",
      body: [
        "Por defecto, serve solo añade o actualiza archivos — un remitente que ejecuta sync --delete contra él sigue copiando los archivos nuevos y modificados, pero cualquier eliminación que solicite se omite, y se registra una advertencia en el receptor. Inicia serve con --allow-delete para optar por un reflejo real, en el que los archivos eliminados en el lado del remitente también se eliminan aquí:",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete es una opción del lado del receptor; el remitente todavía tiene que solicitarla con sync --delete.",
        "Sin ella, nunca se elimina nada en esta máquina, sin importar lo que solicite un remitente.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿En qué puerto escucha serve por defecto?",
        a: "9031. Cámbialo con --port tanto en el proceso a la escucha (serve --port N) como en el destino del emisor (relayium://host:N).",
      },
      {
        q: "¿Tengo que aprobar cada envío a mano?",
        a: "Solo el primer envío de una huella dada, y únicamente cuando serve se ejecuta con una terminal conectada. Después se recuerda. Ejecutar serve de forma no interactiva (systemd, una tubería) omite por completo la solicitud y rechaza los pares desconocidos — autorízalos de antemano con relayium authorize en su lugar.",
      },
      {
        q: "¿Puede un remitente eliminar archivos en mi receptor siempre activo?",
        a: "Solo si iniciaste serve con --allow-delete y el remitente está ejecutando sync --delete. Sin --allow-delete, las eliminaciones se omiten en silencio y todo lo demás se transfiere igualmente.",
      },
      {
        q: "¿Es gratis ejecutar un receptor siempre activo?",
        a: "Sí. relayium serve forma parte de la CLI gratuita y autoalojable — sin cuenta, sin nivel de pago, en ninguno de los dos lados de la conexión.",
      },
      {
        q: "¿Dónde guarda serve su identidad y su lista de pares?",
        a: "En ~/.config/relayium por defecto (id.key/id.crt para la identidad de este host, authorized_fingerprints para la lista de permitidos). Apunta --config-dir a un lugar fijo, como /etc/relayium, para un servicio systemd.",
      },
      {
        q: "¿Cómo ejecuto serve al arranque en macOS?",
        a: "macOS no tiene systemd — usa launchd. Instala serve como LaunchDaemon en /Library/LaunchDaemons (se inicia en el arranque; define UserName para ejecutarlo como tú), o como LaunchAgent en ~/Library/LaunchAgents (se inicia al iniciar sesión). Esta guía incluye un plist listo para editar; no hay servicio de Homebrew. Autoriza de antemano a los emisores con relayium authorize, ya que launchd no da a serve ninguna terminal en la que preguntar.",
      },
    ],
  },
  cta: {
    text: "Convierte cualquier máquina que poseas en un receptor gratuito y siempre activo — envíos directos sobre TLS con anclaje, sin ningún retransmisor de por medio.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Execute o Relayium como um serviço de recepção sempre ativo",
  description:
    "Mantenha o relayium serve em execução para que qualquer par possa enviar arquivos para você a qualquer momento — daemon direto sobre TLS com fixação. Aborda a aprovação do primeiro envio, a pré-autorização de impressões digitais, executá-lo na inicialização com systemd (Linux) ou launchd (macOS), e --allow-delete.",
  updatedLabel: "Última atualização",
  lead: [
    "O relayium serve --once trata de uma única transferência recebida e então encerra — ótimo para um pull ocasional. Mas se você quer que uma máquina seja um ponto de recepção permanente — um servidor doméstico onde os backups chegam durante a noite, uma máquina de build para a qual o CI envia artefatos, um NAS para o qual seu celular pode mandar fotos a qualquer momento — você quer o serve em execução o tempo todo, em vez de iniciá-lo manualmente a cada transferência.",
    "Este guia aborda como iniciar um processo à escuta de longa duração, aprovar quem tem permissão para enviar, pré-autorizar pares para os casos em que ninguém está diante do terminal, executá-lo com systemd, e permitir que um remetente usando sync --delete espelhe as exclusões.",
  ],
  sections: [
    {
      heading: "Iniciar o processo à escuta",
      body: [
        "O serve escuta envios daemon direto (relayium://host:port) por uma conexão TLS 1.3 com fixação e grava o que recebe em um diretório. Nada precisa ser compartilhado de antemão para iniciá-lo — nenhuma impressão digital para copiar, nenhum servidor para registrar:",
      ],
      code: [
        `relayium serve --dir ~/inbox
relayium serve --dir /srv/drop --port 9040   # porta diferente da padrão
relayium serve --dir ~/inbox --allow-delete  # permitir que um remetente com sync --delete espelhe as exclusões`,
      ],
      bullets: [
        "--dir define onde os arquivos chegam (por padrão, o diretório atual).",
        "--port define a porta de escuta (por padrão, 9031); abra-a no seu firewall se o remetente estiver em outro lugar.",
        "Sem --once, o serve continua em execução e aceitando envios até você pará-lo ou um gerenciador de processos reiniciá-lo — é isso que o torna um serviço sempre ativo.",
      ],
    },
    {
      heading: "Aprovar quem tem permissão para enviar",
      body: [
        "Na primeira vez que um novo par envia algo, o serve — se estiver rodando em um terminal — mostra de onde veio o envio e sua impressão digital, e pede que você o aprove, do mesmo jeito que o SSH pergunta sobre um host desconhecido na primeira conexão:",
      ],
      code: [
        `Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Responda y uma vez e essa impressão digital é gravada em authorized_fingerprints; todo envio posterior da mesma máquina passa sem nenhuma solicitação.",
        "Uma impressão digital identifica uma máquina, não um endereço de rede, então continua válida mesmo que o IP do remetente mude.",
        "Esta etapa é interativa por decisão de projeto — precisa de alguém diante do teclado, o que deixará de valer assim que o serve passar para o systemd (a seguir).",
      ],
    },
    {
      heading: "Pré-autorizar pares para configurações não interativas",
      body: [
        "Quando o serve não tem um terminal onde perguntar — um serviço systemd, um processo em segundo plano, um pipe — ele não pode perguntar, então rejeita qualquer impressão digital que ainda não reconheça. Em vez disso, autorize os pares com antecedência. Na máquina que vai enviar, execute relayium id para imprimir a impressão digital dela; no receptor, adicione-a antes que o primeiro envio chegue:",
      ],
      code: [
        `# na máquina que vai ENVIAR: imprima a impressão digital dela
relayium id

# neste RECEPTOR sempre ativo: autorize-a de antemão
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "authorize é idempotente — executá-lo de novo para uma impressão digital em que você já confia não faz nada.",
        "Os arquivos de identidade e de confiança ficam em --config-dir, cujo padrão é ~/.config/relayium (id.key/id.crt é a identidade deste host, authorized_fingerprints é a lista de permissões de pares).",
      ],
    },
    {
      heading: "Executá-lo com systemd",
      body: [
        "Para um serviço que sobrevive a reinicializações e falhas, entregue o serve ao systemd. Aponte --config-dir para um caminho fixo para que a identidade do host e sua lista de pares autorizados permaneçam no lugar entre reinicializações:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium always-on receiver
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/drop --port 9031 --config-dir /etc/relayium --allow-delete
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "Antes de habilitar o serviço, execute relayium authorize <fingerprint> para cada par que deva poder enviar — o próprio serviço não pode perguntar.",
        "systemctl enable --now relayium-serve o inicia e o traz de volta a cada inicialização.",
        "Mantenha /etc/relayium/id.key legível apenas pelo usuário do serviço; o relayium se recusa a carregar uma chave com permissões mais frouxas.",
      ],
    },
    {
      heading: "Executá-lo na inicialização no macOS (launchd)",
      body: [
        "O macOS não tem systemd — seu gerenciador de serviços é o launchd. Para manter o serve em execução em um Mac (por exemplo, um Mac mini deixado ligado como ponto de recepção), instale-o como LaunchDaemon para que ele inicie na inicialização, antes de qualquer login. Defina UserName para que ele rode como você e não como root, e dê a --dir e --config-dir caminhos absolutos para que seus arquivos de identidade e de confiança permaneçam no seu próprio ~/.config/relayium:",
      ],
      code: [LAUNCHD_PLIST, LAUNCHD_CMDS],
      bullets: [
        "O launchd não dá nenhum terminal ao serve, então ele não pode perguntar — execute primeiro relayium authorize <fingerprint> para cada remetente, igual ao systemd. A impressão digital vem do relayium id daquela máquina.",
        "O KeepAlive reinicia o serve se ele travar; o RunAtLoad junto com um LaunchDaemon em /Library/LaunchDaemons o inicia na inicialização sem login — a opção certa para um Mac mini sem tela.",
        "Prefere um serviço no escopo de login? Coloque o mesmo plist (removendo a chave UserName) em ~/Library/LaunchAgents/ e carregue-o com launchctl bootstrap gui/$(id -u) <path> — ele inicia no seu login em vez de na inicialização.",
        "Se o firewall de aplicativos do macOS estiver ativado, permita conexões de entrada para o relayium (Ajustes do Sistema → Rede → Firewall), ou os envios para a sua porta serão bloqueados.",
      ],
    },
    {
      heading: "Permitir que um remetente com sync --delete espelhe as exclusões",
      body: [
        "Por padrão, o serve apenas adiciona ou atualiza arquivos — um remetente que executa sync --delete contra ele ainda copia os arquivos novos e alterados, mas qualquer exclusão que ele solicite é ignorada, com um aviso registrado no receptor. Inicie o serve com --allow-delete para optar por um espelhamento verdadeiro, em que os arquivos removidos no lado do remetente também são removidos aqui:",
      ],
      code: [`relayium serve --dir /srv/mirror --allow-delete`],
      bullets: [
        "--allow-delete é uma opção do lado do receptor; o remetente ainda precisa solicitá-la com sync --delete.",
        "Sem ela, nada é jamais excluído nesta máquina, não importa o que um remetente solicite.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Em que porta o serve escuta por padrão?",
        a: "9031. Mude-a com --port tanto no processo à escuta (serve --port N) quanto no destino do remetente (relayium://host:N).",
      },
      {
        q: "Preciso aprovar cada envio manualmente?",
        a: "Apenas o primeiro envio de uma dada impressão digital, e somente quando o serve está rodando com um terminal conectado. Depois disso, fica memorizado. Rodar o serve de forma não interativa (systemd, um pipe) ignora completamente a solicitação e rejeita pares desconhecidos — pré-autorize-os com relayium authorize em vez disso.",
      },
      {
        q: "Um remetente pode excluir arquivos no meu receptor sempre ativo?",
        a: "Só se você iniciou o serve com --allow-delete e o remetente está executando sync --delete. Sem --allow-delete, as exclusões são ignoradas silenciosamente e todo o resto é transferido normalmente.",
      },
      {
        q: "Executar um receptor sempre ativo é gratuito?",
        a: "Sim. O relayium serve faz parte da CLI gratuita e auto-hospedável — sem conta, sem nível pago, em nenhum dos lados da conexão.",
      },
      {
        q: "Onde o serve guarda sua identidade e sua lista de pares?",
        a: "Em ~/.config/relayium por padrão (id.key/id.crt para a identidade deste host, authorized_fingerprints para a lista de permissões). Aponte --config-dir para um lugar fixo, como /etc/relayium, para um serviço systemd.",
      },
      {
        q: "Como executo o serve na inicialização no macOS?",
        a: "O macOS não tem systemd — use o launchd. Instale o serve como LaunchDaemon em /Library/LaunchDaemons (inicia na inicialização; defina UserName para rodar como você), ou como LaunchAgent em ~/Library/LaunchAgents (inicia no login). Este guia tem um plist pronto para editar; não há serviço do Homebrew. Pré-autorize os remetentes com relayium authorize primeiro, já que o launchd não dá ao serve nenhum terminal para perguntar.",
      },
    ],
  },
  cta: {
    text: "Transforme qualquer máquina que você tenha em um receptor gratuito e sempre ativo — envios diretos sobre TLS com fixação, sem nenhum retransmissor envolvido.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/run-relayium-as-an-always-on-service",
  published: "2026-07-09",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
