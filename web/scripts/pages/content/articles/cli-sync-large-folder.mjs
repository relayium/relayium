// web/scripts/pages/content/articles/cli-sync-large-folder.mjs
// How-to: sync a large folder between two servers with relayium sync —
// incremental, resumable, run unattended in the background via a retry loop + tmux.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

const en = {
  title: "Sync a large folder between two servers (resumable, in the background)",
  description:
    "Mirror a big directory from one server to another with relayium sync — incremental, resumable after a dropped connection, and safe to run unattended. A retry loop under tmux moves gigabytes without babysitting a terminal.",
  updatedLabel: "Last updated",
  lead: [
    "You have a large folder — tens of gigabytes — on one server and you want an exact copy on another. You can't watch a terminal for hours, and a transfer that dies halfway shouldn't start over from zero. relayium sync is built for this: a one-way incremental mirror that skips what's already there, resumes a half-sent file from where it stopped, and verifies every file end to end.",
    "This guide sets up an unattended, self-healing transfer: authorize the sender once, run the listener in the background, and drive relayium sync from a retry loop inside tmux so it keeps going across dropped connections until the whole folder has landed.",
  ],
  sections: [
    {
      heading: "Why relayium sync fits this job",
      body: [
        "sync is a one-way incremental mirror over the native protocol (install relayium on both ends). Three properties make it safe to run and re-run unattended:",
      ],
      bullets: [
        "Skips files already there: a file whose copy on the receiver matches by size and modification time isn't sent again.",
        "Resumes partial files: if a file was half-transferred when the connection dropped, the next run continues from the byte offset already on disk instead of restarting it.",
        "Verifies every file: each file is checked with SHA-256 end to end, so a completed mirror is known to be intact.",
        "Because of these, the command is idempotent — running it again only does the work that's left, which is exactly what lets a retry loop finish a huge transfer.",
      ],
    },
    {
      heading: "Prerequisites",
      body: [
        "Install relayium on both servers (sync speaks the native protocol, so it must be present on each end):",
      ],
      code: [
        `# on BOTH servers
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      bullets: [
        "This guide uses daemon direct (relayium://), so the two servers don't need SSH access to each other.",
        "Open the listener's port (9031 by default) to the sender on the receiver's firewall or security group.",
      ],
    },
    {
      heading: "Authorize the sender once (on the receiver)",
      body: [
        "The receiver approves the sending machine one time; the approval is written to disk and stays valid across restarts, so you never repeat it. Start the listener in a terminal, and point --dir at the parent directory — relayium sync /root/workspace reproduces workspace/... on the receiver, so --dir /root lands the files at /root/workspace/.",
        "On the sender's first connection (next section), serve shows its address and fingerprint and asks you to approve it; answer y and it's remembered for good:",
      ],
      code: [
        `# on the RECEIVER (foreground, to approve interactively)
relayium serve --dir /root --port 9031`,
        `# on the RECEIVER, at the first connection:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "For a fully unattended setup, skip the prompt: run relayium id on the sender to print its fingerprint, then relayium authorize <fingerprint> on the receiver.",
        "--dir is the parent of the folder you're syncing, not the folder itself — otherwise files land one level too deep (e.g. /root/workspace/workspace).",
      ],
    },
    {
      heading: "Run the listener in the background (on the receiver)",
      body: [
        "Once the fingerprint is authorized, stop the foreground serve (Ctrl-C) and re-launch it detached so it survives your logout. It loads the saved fingerprint and accepts the sender silently — no prompt this time:",
      ],
      code: [
        `# on the RECEIVER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 &`,
      ],
      bullets: [
        "serve handles connections one at a time and keeps running, so it's ready for every reconnect from the retry loop below.",
        "For an always-on inbox, run it under systemd instead (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Run the sync in a retry loop under tmux (on the sender)",
      body: [
        "Long transfers get interrupted — a dropped session, a flaky network, a reboot. The fix isn't a fancy tool; it's a loop that reruns sync until it succeeds, plus a terminal multiplexer so it survives you logging out. tmux is cleaner than nohup here: no output redirection to get wrong, and you can reattach to watch progress.",
        "Start a tmux session, then run the mirror in an until loop — it retries every 10 seconds until sync returns success, then exits on its own:",
      ],
      code: [
        `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
        `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
      ],
      bullets: [
        "Detach with Ctrl-b then d; the loop keeps running after you close the terminal. Reattach with tmux attach -t xfer.",
        "Each retry does less: already-transferred files are skipped, a half-sent file resumes — so the loop converges and finishes.",
        "Progress prints one line per completed file, so a big file transfers quietly until it's done. Silence isn't a stall (see troubleshooting).",
      ],
    },
    {
      heading: "Verify and finish",
      body: [
        "The transfer is complete when the until loop ends and you're back at a normal shell prompt. Confirm both sides match, then stop the listener:",
      ],
      code: [
        `# compare totals on BOTH servers
du -sh /root/workspace`,
        `# on the RECEIVER, once verified
pkill -f 'relayium serve'`,
      ],
      bullets: [
        "Every file was SHA-256 checked on arrival, so matching sizes plus a clean exit means an intact copy.",
      ],
    },
    {
      heading: "Troubleshooting",
      body: [
        "A few things that look like problems but usually aren't — and the one that usually is (a blocked port).",
      ],
      bullets: [
        "No output isn't a stall. Progress prints only when each file finishes, so a large file transfers silently. Check the real state on the sender with ss -tnp | grep 9031 — ESTAB means it's connected and transferring; SYN-SENT means it can't reach the listener.",
        "SYN-SENT means the port is blocked. Open 9031/TCP to the sender on the receiver (cloud security group, or ufw allow 9031/tcp). This is the most common cause of a transfer that never starts.",
        "Prefer tmux plus a single-line loop over multi-line nohup. Pasting a multi-line command with quotes and a > redirect into a shell often breaks on the redirect or leaves you at a > continuation prompt.",
        "When cleaning up processes, match precisely (pkill -f 'relayium sync'), not pkill relayium — a broad match can kill an unrelated relayium process running on the same box.",
        "venv and other regenerable directories are worth excluding. A Python virtualenv can hold gigabytes of libraries that pip recreates on the far side; skipping them saves a lot of transfer.",
        "Symlinks and special files are skipped — sync transfers regular files only. Handle any important symlinks separately.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "What happens if the transfer is interrupted halfway?",
        a: "Nothing is lost. Rerun relayium sync — it skips files already on the receiver and resumes a half-sent file from the byte offset already on disk. The until loop in this guide does that automatically until the whole folder is mirrored.",
      },
      {
        q: "How is this different from rsync?",
        a: "Both do incremental one-way mirroring, but relayium sync runs over a pinned TLS connection with no SSH account required (daemon direct), authenticates the two machines by certificate fingerprint, and verifies every file with SHA-256. It's the same transfer engine as relayium's other modes.",
      },
      {
        q: "Does sync delete files on the receiver that I removed from the source?",
        a: "Only if you ask. By default sync only adds and updates. Pass --delete to mirror deletions, and the receiver must run serve with --allow-delete for it to be honored — otherwise the delete is ignored and reported back.",
      },
      {
        q: "Can I keep two folders in sync continuously?",
        a: "Yes. Add --watch and sync stays running, re-mirroring on any change under the source. For a one-time move of a large folder you don't need it — the retry loop plus a plain sync is enough.",
      },
      {
        q: "Do I have to open a port?",
        a: "For daemon direct, yes — the listener's port (9031 by default) must be reachable from the sender. If you'd rather not open a port and already have SSH between the servers, sync also works over SSH: relayium sync /path user@host:/path (relayium must be installed on the remote).",
      },
    ],
  },
  cta: {
    text: "Mirror a folder between two of your own servers — incremental, resumable, no babysitting.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "在两台服务器之间同步一个大文件夹（可续传、后台运行）",
  description:
    "用 relayium sync 把一台服务器上的大目录镜像到另一台——增量传输、掉线后可续传、可无人值守地后台运行。配合 tmux 里的重试循环，无需守着终端就能搬运数十 GB。",
  updatedLabel: "最近更新",
  lead: [
    "你在一台服务器上有一个很大的文件夹——几十 GB——想在另一台上得到一份完整副本。你没法盯着终端好几个小时，而且传到一半断掉的传输不应该从头再来。relayium sync 正是为此而生：一个单向增量镜像，跳过已经存在的文件，把传了一半的文件从中断处续传，并对每个文件做端到端校验。",
    "本指南搭建一个无人值守、自动恢复的传输：把发送方授权一次，让监听端在后台运行，并在 tmux 里用重试循环驱动 relayium sync，让它在掉线之后继续跑，直到整个文件夹全部到达。",
  ],
  sections: [
    {
      heading: "为什么 relayium sync 适合这件事",
      body: [
        "sync 是走原生协议的单向增量镜像（两端都要装 relayium）。有三个特性让它可以安心地无人值守地反复运行：",
      ],
      bullets: [
        "跳过已存在的文件：接收方上大小和修改时间都一致的文件不会重复发送。",
        "续传半截文件：如果某个文件在连接断开时只传了一半，下次运行会从磁盘上已有的字节偏移继续，而不是重新传。",
        "校验每个文件：每个文件都做端到端的 SHA-256 校验，因此完成的镜像可以确认是完整的。",
        "正因如此，这条命令是幂等的——再跑一次只做剩下的活，这正是重试循环能完成一次超大传输的关键。",
      ],
    },
    {
      heading: "前提条件",
      body: [
        "两端服务器都要装 relayium（sync 走原生协议，因此每一端都必须有）：",
      ],
      code: [
        `# on BOTH servers
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      bullets: [
        "本指南用守护进程直连（relayium://），所以两台服务器之间不需要 SSH 互访。",
        "在接收方的防火墙或安全组上，向发送方开放监听端口（默认 9031）。",
      ],
    },
    {
      heading: "把发送方授权一次（在接收方）",
      body: [
        "接收方对发送的那台机器授权一次；授权会写入磁盘并在重启之间保持有效，因此你无需重复。先在终端里前台启动监听端，并把 --dir 指向父目录——relayium sync /root/workspace 会在接收方重建出 workspace/...，所以 --dir /root 会把文件落到 /root/workspace/。",
        "当发送方首次连接时（见下一节），serve 会显示它的地址和指纹并请你批准；回答 y，它就会被永久记住：",
      ],
      code: [
        `# on the RECEIVER (foreground, to approve interactively)
relayium serve --dir /root --port 9031`,
        `# on the RECEIVER, at the first connection:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "若要完全无人值守，可跳过提示：在发送方运行 relayium id 打印其指纹，再在接收方运行 relayium authorize <指纹>。",
        "--dir 是你要同步的文件夹的父目录，而不是文件夹本身——否则文件会多落一层（例如 /root/workspace/workspace）。",
      ],
    },
    {
      heading: "让监听端在后台运行（在接收方）",
      body: [
        "指纹授权之后，停掉前台的 serve（Ctrl-C），再以脱离终端的方式重新启动，让它在你退出登录后依然存活。它会读回已保存的指纹并静默接受发送方——这次不再提示：",
      ],
      code: [
        `# on the RECEIVER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 &`,
      ],
      bullets: [
        "serve 一次处理一个连接并持续运行，因此下面重试循环的每次重连它都准备好接收。",
        "若要做常驻收件箱，改用 systemd 运行（Restart=always，--config-dir /etc/relayium）。",
      ],
    },
    {
      heading: "在 tmux 里用重试循环运行 sync（在发送方）",
      body: [
        "长时间的传输总会被打断——会话断开、网络抖动、机器重启。解决办法不是什么高级工具，而是一个把 sync 反复重跑到成功为止的循环，再加一个终端复用器让它在你退出登录后存活。这里 tmux 比 nohup 更省心：没有容易写错的输出重定向，而且可以重新接入查看进度。",
        "开一个 tmux 会话，然后在 until 循环里运行镜像——它每 10 秒重试一次，直到 sync 成功返回，然后自己退出：",
      ],
      code: [
        `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
        `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
      ],
      bullets: [
        "按 Ctrl-b 再按 d 脱离；关掉终端后循环仍在跑。用 tmux attach -t xfer 重新接入。",
        "每次重试做的活都更少：已传完的文件被跳过，传了一半的文件续传——所以循环会收敛并结束。",
        "进度是每传完一个文件打印一行，因此一个大文件会安静地传到完成为止。没有输出不代表卡住（见排错）。",
      ],
    },
    {
      heading: "验证与收尾",
      body: [
        "当 until 循环结束、你回到普通的 shell 提示符时，传输就完成了。确认两边一致，然后停掉监听端：",
      ],
      code: [
        `# compare totals on BOTH servers
du -sh /root/workspace`,
        `# on the RECEIVER, once verified
pkill -f 'relayium serve'`,
      ],
      bullets: [
        "每个文件到达时都做过 SHA-256 校验，所以大小一致再加上干净退出，就意味着副本是完整的。",
      ],
    },
    {
      heading: "排错",
      body: [
        "有几件事看起来像问题，但通常并不是——以及一个通常确实是问题的（端口被挡）。",
      ],
      bullets: [
        "没有输出不代表卡住。进度只在每个文件传完时才打印，因此一个大文件会安静地传。用 ss -tnp | grep 9031 在发送方查看真实状态——ESTAB 表示已连上并在传；SYN-SENT 表示连不上监听端。",
        "SYN-SENT 表示端口被挡。在接收方向发送方开放 9031/TCP（云安全组，或 ufw allow 9031/tcp）。这是「传输迟迟不开始」最常见的原因。",
        "优先用 tmux 加单行循环，而不是多行 nohup。把带引号和 > 重定向的多行命令粘进 shell，常常会在重定向处出错，或让你停在 > 续行提示符上。",
        "清理进程时要精确匹配（pkill -f 'relayium sync'），而不是 pkill relayium——宽泛匹配可能误杀同一台机器上无关的 relayium 进程。",
        "venv 等可再生目录值得排除。一个 Python 虚拟环境可能装着几个 GB 的库，这些在对端 pip 就能重建；跳过它们能省下大量传输。",
        "符号链接和特殊文件会被跳过——sync 只传常规文件。重要的软链请单独处理。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "传到一半被打断会怎样？",
        a: "什么都不会丢。重新运行 relayium sync——它会跳过接收方已有的文件，并把传了一半的文件从磁盘上已有的字节偏移续传。本指南里的 until 循环会自动做这件事，直到整个文件夹镜像完成。",
      },
      {
        q: "这和 rsync 有什么不同？",
        a: "两者都做增量单向镜像，但 relayium sync 走锁定的 TLS 连接、不需要 SSH 账号（守护进程直连），通过证书指纹互相认证两台机器，并对每个文件做 SHA-256 校验。它和 relayium 其它模式用的是同一个传输引擎。",
      },
      {
        q: "sync 会把我从源端删掉的文件在接收方也删掉吗？",
        a: "只有你要求时才会。默认情况下 sync 只新增和更新。加 --delete 才会镜像删除，而且接收方必须以 --allow-delete 运行 serve 才会执行——否则删除会被忽略并回报给你。",
      },
      {
        q: "我能让两个文件夹持续保持同步吗？",
        a: "可以。加 --watch，sync 会持续运行，在源目录下任何改动时重新镜像。对于一次性搬运一个大文件夹，你不需要它——重试循环加一个普通的 sync 就够了。",
      },
      {
        q: "我必须开一个端口吗？",
        a: "用守护进程直连的话，是的——监听端口（默认 9031）必须能从发送方访问到。如果你不想开端口、而且两台服务器之间已经有 SSH，sync 也可以走 SSH：relayium sync /path user@host:/path（远端必须装了 relayium）。",
      },
    ],
  },
  cta: {
    text: "在你自己的两台服务器之间镜像一个文件夹——增量、可续传、无需盯守。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "2台のサーバー間で大きなフォルダーを同期する(再開可能・バックグラウンド)",
  description:
    "relayium sync で大きなディレクトリを一方のサーバーからもう一方へミラーリング——増分転送、接続が切れても再開可能、無人での実行も安全です。tmux 内のリトライループで、ターミナルに張り付かずに数十 GB を運べます。",
  updatedLabel: "最終更新",
  lead: [
    "一方のサーバーに大きなフォルダー——数十 GB——があり、それをもう一方に完全な複製として欲しいとします。何時間もターミナルを見張ることはできませんし、途中で落ちた転送が最初からやり直しになるのも困ります。relayium sync はまさにこのために作られています。一方向の増分ミラーで、すでにあるものはスキップし、途中まで送ったファイルは止まったところから再開し、各ファイルを端から端まで検証します。",
    "本ガイドでは、無人で自己修復する転送を構築します。送信側を一度だけ承認し、リスナーをバックグラウンドで動かし、tmux 内のリトライループで relayium sync を回して、接続が切れても続行させ、フォルダー全体が届くまで走らせます。",
  ],
  sections: [
    {
      heading: "なぜ relayium sync がこの用途に向くのか",
      body: [
        "sync はネイティブプロトコル上の一方向増分ミラーです(両端に relayium をインストールします)。無人で繰り返し実行しても安全な理由が3つあります:",
      ],
      bullets: [
        "すでにあるファイルはスキップ: 受信側のコピーがサイズと更新時刻で一致するファイルは再送しません。",
        "途中のファイルを再開: 接続が切れたとき半分だけ送られていたファイルは、次回の実行でディスク上にすでにあるバイトオフセットから続行し、やり直しません。",
        "各ファイルを検証: 各ファイルを端から端まで SHA-256 で検査するため、完了したミラーは完全だと分かります。",
        "これらのおかげでコマンドは冪等です——もう一度実行しても残りの作業だけを行います。これこそがリトライループで巨大な転送を完了させる要点です。",
      ],
    },
    {
      heading: "前提条件",
      body: [
        "両方のサーバーに relayium をインストールします(sync はネイティブプロトコルを話すため、各端に必要です):",
      ],
      code: [
        `# on BOTH servers
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      bullets: [
        "本ガイドはデーモン直結(relayium://)を使うため、2台のサーバー間に SSH アクセスは不要です。",
        "受信側のファイアウォールまたはセキュリティグループで、リスナーのポート(既定 9031)を送信側に開放してください。",
      ],
    },
    {
      heading: "送信側を一度だけ承認する(受信側)",
      body: [
        "受信側は送信側のマシンを一度だけ承認します。承認はディスクに書き込まれ、再起動をまたいでも有効なので繰り返す必要はありません。まずターミナルでリスナーをフォアグラウンド起動し、--dir を親ディレクトリに向けます——relayium sync /root/workspace は受信側で workspace/... を再現するので、--dir /root ならファイルは /root/workspace/ に着地します。",
        "送信側の初回接続時(次節)、serve はその住所とフィンガープリントを表示して承認を求めます。y と答えれば永続的に記憶されます:",
      ],
      code: [
        `# on the RECEIVER (foreground, to approve interactively)
relayium serve --dir /root --port 9031`,
        `# on the RECEIVER, at the first connection:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "完全に無人にするならプロンプトを省けます: 送信側で relayium id を実行してフィンガープリントを表示し、受信側で relayium authorize <フィンガープリント> を実行します。",
        "--dir は同期するフォルダーの親であって、フォルダー自体ではありません——さもないとファイルが1階層深く着地します(例: /root/workspace/workspace)。",
      ],
    },
    {
      heading: "リスナーをバックグラウンドで動かす(受信側)",
      body: [
        "フィンガープリントを承認したら、フォアグラウンドの serve を止め(Ctrl-C)、ログアウト後も生き残るようデタッチして再起動します。保存済みのフィンガープリントを読み込み、送信側を確認なしで受け入れます——今回はプロンプトは出ません:",
      ],
      code: [
        `# on the RECEIVER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 &`,
      ],
      bullets: [
        "serve は接続を1つずつ処理して動き続けるため、下のリトライループの再接続のたびに受信の準備ができています。",
        "常時稼働の受信箱にするなら、代わりに systemd で動かします(Restart=always、--config-dir /etc/relayium)。",
      ],
    },
    {
      heading: "tmux 内のリトライループで sync を回す(送信側)",
      body: [
        "長い転送は中断されます——セッション切断、不安定なネットワーク、再起動。解決策は高級なツールではなく、sync を成功するまで再実行するループと、ログアウト後も生き残らせる端末マルチプレクサです。ここでは tmux が nohup より扱いやすい: 間違えやすい出力リダイレクトがなく、再接続して進捗を見られます。",
        "tmux セッションを開始し、until ループでミラーを実行します——10秒ごとに再試行し、sync が成功を返したら自分で終了します:",
      ],
      code: [
        `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
        `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
      ],
      bullets: [
        "Ctrl-b の次に d でデタッチ。ターミナルを閉じてもループは動き続けます。tmux attach -t xfer で再接続します。",
        "再試行のたびに作業は減ります: 転送済みのファイルはスキップされ、半分送ったファイルは再開する——だからループは収束して終わります。",
        "進捗はファイルが1つ完了するごとに1行表示されるので、大きなファイルは完了まで静かに転送されます。無音は停止ではありません(トラブルシューティング参照)。",
      ],
    },
    {
      heading: "検証と仕上げ",
      body: [
        "until ループが終わり、通常のシェルプロンプトに戻ったら転送は完了です。両側が一致することを確認してから、リスナーを停止します:",
      ],
      code: [
        `# compare totals on BOTH servers
du -sh /root/workspace`,
        `# on the RECEIVER, once verified
pkill -f 'relayium serve'`,
      ],
      bullets: [
        "各ファイルは到着時に SHA-256 で検査済みなので、サイズの一致とクリーンな終了は複製が完全であることを意味します。",
      ],
    },
    {
      heading: "トラブルシューティング",
      body: [
        "問題に見えて多くの場合そうでないこと——そして多くの場合本当に問題であること(ポートの遮断)を挙げます。",
      ],
      bullets: [
        "無音は停止ではありません。進捗は各ファイルが完了したときだけ表示されるので、大きなファイルは静かに転送されます。送信側で ss -tnp | grep 9031 を使って実際の状態を確認します——ESTAB は接続して転送中、SYN-SENT はリスナーに届いていないことを意味します。",
        "SYN-SENT はポートが遮断されている印です。受信側で送信側に向けて 9031/TCP を開放します(クラウドのセキュリティグループ、または ufw allow 9031/tcp)。「転送がいつまでも始まらない」最も一般的な原因です。",
        "複数行の nohup より、tmux と1行のループを優先します。引用符と > リダイレクトを含む複数行コマンドをシェルに貼り付けると、リダイレクトで壊れたり、> の継続プロンプトで止まったりしがちです。",
        "プロセスを片付けるときは正確に一致させます(pkill -f 'relayium sync')。pkill relayium ではありません——広い一致は同じマシンで動く無関係な relayium プロセスを巻き込みかねません。",
        "venv などの再生成可能なディレクトリは除外する価値があります。Python の仮想環境は数 GB のライブラリを抱えることがあり、対向側で pip が作り直せます。除けば転送を大きく節約できます。",
        "シンボリックリンクと特殊ファイルはスキップされます——sync が転送するのは通常ファイルだけです。重要なシンボリックリンクは別途扱ってください。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "転送が途中で中断されたらどうなりますか?",
        a: "何も失われません。relayium sync を再実行してください——受信側にすでにあるファイルはスキップし、半分送ったファイルはディスク上のバイトオフセットから再開します。本ガイドの until ループが、フォルダー全体がミラーされるまでこれを自動で行います。",
      },
      {
        q: "これは rsync と何が違いますか?",
        a: "どちらも増分の一方向ミラーですが、relayium sync は固定された TLS 接続で動作し、SSH アカウントを必要とせず(デーモン直結)、証明書のフィンガープリントで2台を認証し、各ファイルを SHA-256 で検証します。relayium の他モードと同じ転送エンジンです。",
      },
      {
        q: "ソースから削除したファイルを、sync は受信側でも削除しますか?",
        a: "あなたが求めたときだけです。既定では sync は追加と更新だけを行います。削除をミラーするには --delete を渡し、それが有効になるには受信側が --allow-delete で serve を実行している必要があります——さもなければ削除は無視され、報告されます。",
      },
      {
        q: "2つのフォルダーを継続的に同期し続けられますか?",
        a: "はい。--watch を付けると sync は動き続け、ソース配下の変更のたびに再ミラーします。大きなフォルダーの一度きりの移動には不要です——リトライループと素の sync で十分です。",
      },
      {
        q: "ポートを開ける必要がありますか?",
        a: "デーモン直結ならはい——リスナーのポート(既定 9031)が送信側から到達可能である必要があります。ポートを開けたくなく、サーバー間にすでに SSH があるなら、sync は SSH 経由でも動きます: relayium sync /path user@host:/path(リモートに relayium が必要)。",
      },
    ],
  },
  cta: {
    text: "自分の2台のサーバー間でフォルダーをミラーしましょう——増分、再開可能、張り付き不要。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "두 서버 사이에서 큰 폴더 동기화하기(재개 가능, 백그라운드)",
  description:
    "relayium sync로 큰 디렉터리를 한 서버에서 다른 서버로 미러링하세요——증분 전송, 연결이 끊겨도 재개 가능, 무인 실행도 안전합니다. tmux 안의 재시도 루프로 터미널에 붙어 있지 않고도 수십 GB를 옮길 수 있습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "한 서버에 큰 폴더——수십 GB——가 있고, 다른 서버에 똑같은 복사본을 원한다고 합시다. 몇 시간 동안 터미널을 지켜볼 수도 없고, 도중에 죽은 전송이 처음부터 다시 시작되어서도 안 됩니다. relayium sync는 바로 이를 위해 만들어졌습니다. 이미 있는 것은 건너뛰고, 절반만 보낸 파일은 멈춘 지점부터 재개하며, 모든 파일을 끝에서 끝까지 검증하는 단방향 증분 미러입니다.",
    "이 가이드는 무인으로 스스로 복구하는 전송을 구성합니다. 보내는 쪽을 한 번만 승인하고, 리스너를 백그라운드에서 돌리고, tmux 안의 재시도 루프로 relayium sync를 구동해 연결이 끊겨도 계속 진행하여 폴더 전체가 도착할 때까지 실행합니다.",
  ],
  sections: [
    {
      heading: "왜 relayium sync가 이 작업에 맞나",
      body: [
        "sync는 네이티브 프로토콜 위의 단방향 증분 미러입니다(양쪽 끝에 relayium을 설치). 무인으로 반복 실행해도 안전한 이유가 세 가지 있습니다:",
      ],
      bullets: [
        "이미 있는 파일은 건너뜀: 받는 쪽 복사본이 크기와 수정 시각으로 일치하는 파일은 다시 보내지 않습니다.",
        "부분 파일 재개: 연결이 끊길 때 절반만 전송된 파일은, 다음 실행에서 디스크에 이미 있는 바이트 오프셋부터 이어가며 다시 시작하지 않습니다.",
        "모든 파일 검증: 각 파일을 끝에서 끝까지 SHA-256으로 검사하므로 완료된 미러는 온전함이 보장됩니다.",
        "이 덕분에 명령은 멱등적입니다——다시 실행해도 남은 일만 합니다. 이것이 바로 재시도 루프가 거대한 전송을 끝낼 수 있게 하는 핵심입니다.",
      ],
    },
    {
      heading: "사전 준비",
      body: [
        "양쪽 서버에 relayium을 설치하세요(sync는 네이티브 프로토콜을 쓰므로 각 끝에 필요합니다):",
      ],
      code: [
        `# on BOTH servers
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      bullets: [
        "이 가이드는 데몬 다이렉트(relayium://)를 쓰므로 두 서버 사이에 SSH 접근이 필요 없습니다.",
        "받는 쪽 방화벽이나 보안 그룹에서 리스너 포트(기본 9031)를 보내는 쪽에 열어 두세요.",
      ],
    },
    {
      heading: "보내는 쪽을 한 번만 승인하기(받는 쪽)",
      body: [
        "받는 쪽은 보내는 기기를 한 번만 승인합니다. 승인은 디스크에 기록되어 재시작을 넘어 유효하므로 반복할 필요가 없습니다. 먼저 터미널에서 리스너를 포그라운드로 시작하고, --dir을 부모 디렉터리로 향하게 하세요——relayium sync /root/workspace는 받는 쪽에서 workspace/...를 재현하므로, --dir /root이면 파일이 /root/workspace/에 안착합니다.",
        "보내는 쪽의 첫 연결 시(다음 절), serve가 그 주소와 핑거프린트를 보여주며 승인을 요청합니다. y라고 답하면 영구적으로 기억됩니다:",
      ],
      code: [
        `# on the RECEIVER (foreground, to approve interactively)
relayium serve --dir /root --port 9031`,
        `# on the RECEIVER, at the first connection:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "완전 무인 구성이라면 프롬프트를 건너뛰세요: 보내는 쪽에서 relayium id로 핑거프린트를 출력하고, 받는 쪽에서 relayium authorize <핑거프린트>를 실행합니다.",
        "--dir은 동기화하는 폴더의 부모이지 폴더 자체가 아닙니다——그렇지 않으면 파일이 한 단계 더 깊이 안착합니다(예: /root/workspace/workspace).",
      ],
    },
    {
      heading: "리스너를 백그라운드로 돌리기(받는 쪽)",
      body: [
        "핑거프린트를 승인했으면 포그라운드 serve를 멈추고(Ctrl-C), 로그아웃 후에도 살아남도록 분리해서 다시 실행하세요. 저장된 핑거프린트를 불러와 보내는 쪽을 조용히 받아들입니다——이번엔 프롬프트가 없습니다:",
      ],
      code: [
        `# on the RECEIVER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 &`,
      ],
      bullets: [
        "serve는 연결을 하나씩 처리하며 계속 실행되므로, 아래 재시도 루프의 매 재연결마다 받을 준비가 되어 있습니다.",
        "항상 켜져 있는 수신함을 원하면 대신 systemd로 돌리세요(Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "tmux 안의 재시도 루프로 sync 돌리기(보내는 쪽)",
      body: [
        "긴 전송은 중단됩니다——세션 끊김, 불안정한 네트워크, 재부팅. 해결책은 멋진 도구가 아니라 sync를 성공할 때까지 다시 실행하는 루프와, 로그아웃 후에도 살아남게 하는 터미널 멀티플렉서입니다. 여기서는 tmux가 nohup보다 깔끔합니다: 틀리기 쉬운 출력 리다이렉트가 없고, 다시 붙어 진행 상황을 볼 수 있습니다.",
        "tmux 세션을 시작한 뒤 until 루프로 미러를 실행하세요——10초마다 재시도하고 sync가 성공을 반환하면 스스로 종료합니다:",
      ],
      code: [
        `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
        `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
      ],
      bullets: [
        "Ctrl-b 다음 d로 분리하세요. 터미널을 닫아도 루프는 계속 돕니다. tmux attach -t xfer로 다시 붙습니다.",
        "재시도할 때마다 일이 줄어듭니다: 이미 전송된 파일은 건너뛰고, 절반 보낸 파일은 재개됩니다——그래서 루프는 수렴하고 끝납니다.",
        "진행 상황은 파일 하나가 완료될 때마다 한 줄씩 출력되므로, 큰 파일은 끝날 때까지 조용히 전송됩니다. 침묵은 멈춤이 아닙니다(문제 해결 참고).",
      ],
    },
    {
      heading: "검증과 마무리",
      body: [
        "until 루프가 끝나고 평범한 셸 프롬프트로 돌아오면 전송이 완료된 것입니다. 양쪽이 일치하는지 확인한 뒤 리스너를 멈추세요:",
      ],
      code: [
        `# compare totals on BOTH servers
du -sh /root/workspace`,
        `# on the RECEIVER, once verified
pkill -f 'relayium serve'`,
      ],
      bullets: [
        "모든 파일은 도착 시 SHA-256으로 검사되었으므로, 크기 일치에 더해 깔끔한 종료는 복사본이 온전함을 뜻합니다.",
      ],
    },
    {
      heading: "문제 해결",
      body: [
        "문제처럼 보이지만 대개 아닌 몇 가지——그리고 대개 진짜 문제인 하나(포트 차단)입니다.",
      ],
      bullets: [
        "출력이 없다고 멈춘 게 아닙니다. 진행 상황은 각 파일이 완료될 때만 출력되므로 큰 파일은 조용히 전송됩니다. 보내는 쪽에서 ss -tnp | grep 9031로 실제 상태를 확인하세요——ESTAB이면 연결되어 전송 중, SYN-SENT이면 리스너에 닿지 못한 것입니다.",
        "SYN-SENT은 포트가 막혔다는 신호입니다. 받는 쪽에서 보내는 쪽으로 9031/TCP를 여세요(클라우드 보안 그룹 또는 ufw allow 9031/tcp). 전송이 아예 시작되지 않는 가장 흔한 원인입니다.",
        "여러 줄 nohup보다 tmux와 한 줄 루프를 택하세요. 따옴표와 > 리다이렉트가 있는 여러 줄 명령을 셸에 붙여 넣으면 리다이렉트에서 깨지거나 > 연속 프롬프트에서 멈추기 쉽습니다.",
        "프로세스를 정리할 때는 정확히 일치시키세요(pkill -f 'relayium sync'). pkill relayium이 아닙니다——넓은 일치는 같은 기기에서 도는 무관한 relayium 프로세스를 잡을 수 있습니다.",
        "venv 등 재생성 가능한 디렉터리는 제외할 가치가 있습니다. 파이썬 가상환경은 수 GB의 라이브러리를 담을 수 있고 반대편에서 pip가 다시 만들 수 있습니다. 건너뛰면 전송을 크게 아낍니다.",
        "심링크와 특수 파일은 건너뜁니다——sync는 일반 파일만 전송합니다. 중요한 심링크는 따로 처리하세요.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "전송이 도중에 중단되면 어떻게 되나요?",
        a: "아무것도 잃지 않습니다. relayium sync를 다시 실행하세요——받는 쪽에 이미 있는 파일은 건너뛰고, 절반 보낸 파일은 디스크에 이미 있는 바이트 오프셋부터 재개합니다. 이 가이드의 until 루프가 폴더 전체가 미러될 때까지 이를 자동으로 합니다.",
      },
      {
        q: "이것은 rsync와 무엇이 다른가요?",
        a: "둘 다 증분 단방향 미러링을 하지만, relayium sync는 고정된 TLS 연결로 동작하고 SSH 계정이 필요 없으며(데몬 다이렉트), 인증서 핑거프린트로 두 기기를 인증하고, 모든 파일을 SHA-256으로 검증합니다. relayium의 다른 모드와 같은 전송 엔진입니다.",
      },
      {
        q: "sync는 소스에서 지운 파일을 받는 쪽에서도 지우나요?",
        a: "요청할 때만요. 기본적으로 sync는 추가와 갱신만 합니다. 삭제를 미러링하려면 --delete를 넘기고, 그것이 적용되려면 받는 쪽이 --allow-delete로 serve를 실행해야 합니다——그렇지 않으면 삭제는 무시되고 보고됩니다.",
      },
      {
        q: "두 폴더를 계속 동기화 상태로 유지할 수 있나요?",
        a: "네. --watch를 붙이면 sync가 계속 실행되며 소스 아래의 어떤 변경에도 다시 미러링합니다. 큰 폴더를 한 번 옮기는 데는 필요 없습니다——재시도 루프와 평범한 sync면 충분합니다.",
      },
      {
        q: "포트를 열어야 하나요?",
        a: "데몬 다이렉트라면 네——리스너 포트(기본 9031)가 보내는 쪽에서 도달 가능해야 합니다. 포트를 열고 싶지 않고 서버 사이에 이미 SSH가 있다면 sync는 SSH로도 동작합니다: relayium sync /path user@host:/path(원격에 relayium이 필요).",
      },
    ],
  },
  cta: {
    text: "당신 소유의 두 서버 사이에서 폴더를 미러링하세요——증분, 재개 가능, 지켜볼 필요 없이.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Einen großen Ordner zwischen zwei Servern synchronisieren (fortsetzbar, im Hintergrund)",
  description:
    "Spiegle ein großes Verzeichnis von einem Server auf einen anderen mit relayium sync — inkrementell, nach einem Verbindungsabbruch fortsetzbar und sicher unbeaufsichtigt auszuführen. Eine Retry-Schleife unter tmux bewegt Gigabytes, ohne ein Terminal zu bewachen.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Du hast einen großen Ordner — zig Gigabyte — auf einem Server und willst eine exakte Kopie auf einem anderen. Du kannst kein Terminal stundenlang bewachen, und eine Übertragung, die auf halbem Weg abbricht, sollte nicht bei null neu beginnen. relayium sync ist genau dafür gebaut: ein einseitiger inkrementeller Spiegel, der überspringt, was schon da ist, eine halb gesendete Datei dort fortsetzt, wo sie stehen blieb, und jede Datei Ende-zu-Ende prüft.",
    "Diese Anleitung richtet eine unbeaufsichtigte, selbstheilende Übertragung ein: genehmige den Sender einmal, betreibe den Listener im Hintergrund und treibe relayium sync aus einer Retry-Schleife in tmux an, sodass es über Verbindungsabbrüche hinweg weiterläuft, bis der ganze Ordner angekommen ist.",
  ],
  sections: [
    {
      heading: "Warum relayium sync für diese Aufgabe passt",
      body: [
        "sync ist ein einseitiger inkrementeller Spiegel über das native Protokoll (installiere relayium an beiden Enden). Drei Eigenschaften machen es sicher, es unbeaufsichtigt auszuführen und erneut auszuführen:",
      ],
      bullets: [
        "Überspringt bereits vorhandene Dateien: Eine Datei, deren Kopie auf dem Empfänger in Größe und Änderungszeit übereinstimmt, wird nicht erneut gesendet.",
        "Setzt Teildateien fort: War eine Datei beim Verbindungsabbruch halb übertragen, setzt der nächste Lauf beim bereits auf der Platte liegenden Byte-Offset fort, statt neu zu beginnen.",
        "Prüft jede Datei: Jede Datei wird Ende-zu-Ende mit SHA-256 geprüft, sodass ein fertiger Spiegel nachweislich intakt ist.",
        "Deshalb ist der Befehl idempotent — ein erneuter Lauf erledigt nur die verbleibende Arbeit, und genau das lässt eine Retry-Schleife eine riesige Übertragung abschließen.",
      ],
    },
    {
      heading: "Voraussetzungen",
      body: [
        "Installiere relayium auf beiden Servern (sync spricht das native Protokoll, muss also an jedem Ende vorhanden sein):",
      ],
      code: [
        `# on BOTH servers
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      bullets: [
        "Diese Anleitung nutzt Daemon Direct (relayium://), die beiden Server brauchen also keinen SSH-Zugang zueinander.",
        "Öffne den Port des Listeners (Standard 9031) für den Sender in Firewall oder Security-Group des Empfängers.",
      ],
    },
    {
      heading: "Den Sender einmal genehmigen (auf dem Empfänger)",
      body: [
        "Der Empfänger genehmigt die sendende Maschine einmal; die Genehmigung wird auf die Platte geschrieben und bleibt über Neustarts hinweg gültig, du wiederholst sie also nie. Starte den Listener zuerst in einem Terminal und richte --dir auf das übergeordnete Verzeichnis — relayium sync /root/workspace reproduziert workspace/... auf dem Empfänger, sodass --dir /root die Dateien in /root/workspace/ landen lässt.",
        "Bei der ersten Verbindung des Senders (nächster Abschnitt) zeigt serve dessen Adresse und Fingerprint und bittet dich um Genehmigung; antworte mit y, und er wird dauerhaft gespeichert:",
      ],
      code: [
        `# on the RECEIVER (foreground, to approve interactively)
relayium serve --dir /root --port 9031`,
        `# on the RECEIVER, at the first connection:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Für ein vollständig unbeaufsichtigtes Setup überspringst du die Abfrage: Führe relayium id auf dem Sender aus, um seinen Fingerprint auszugeben, dann relayium authorize <Fingerprint> auf dem Empfänger.",
        "--dir ist das übergeordnete Verzeichnis des zu synchronisierenden Ordners, nicht der Ordner selbst — sonst landen die Dateien eine Ebene zu tief (z. B. /root/workspace/workspace).",
      ],
    },
    {
      heading: "Den Listener im Hintergrund betreiben (auf dem Empfänger)",
      body: [
        "Ist der Fingerprint genehmigt, beende das serve im Vordergrund (Ctrl-C) und starte es abgekoppelt neu, damit es dein Ausloggen übersteht. Es lädt den gespeicherten Fingerprint und akzeptiert den Sender stillschweigend — diesmal ohne Abfrage:",
      ],
      code: [
        `# on the RECEIVER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 &`,
      ],
      bullets: [
        "serve verarbeitet Verbindungen nacheinander und läuft weiter, ist also für jede erneute Verbindung der Retry-Schleife unten bereit.",
        "Für einen dauerhaft laufenden Posteingang betreibe es stattdessen unter systemd (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "sync in einer Retry-Schleife unter tmux ausführen (auf dem Sender)",
      body: [
        "Lange Übertragungen werden unterbrochen — eine abgebrochene Sitzung, ein wackeliges Netz, ein Neustart. Die Lösung ist kein raffiniertes Werkzeug, sondern eine Schleife, die sync erneut ausführt, bis es gelingt, plus ein Terminal-Multiplexer, damit es dein Ausloggen übersteht. tmux ist hier sauberer als nohup: keine Ausgabe-Umleitung, die man falsch machen kann, und du kannst dich wieder verbinden, um den Fortschritt zu sehen.",
        "Starte eine tmux-Sitzung und führe den Spiegel in einer until-Schleife aus — sie versucht es alle 10 Sekunden erneut, bis sync Erfolg meldet, und beendet sich dann von selbst:",
      ],
      code: [
        `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
        `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
      ],
      bullets: [
        "Abkoppeln mit Ctrl-b, dann d; die Schleife läuft weiter, nachdem du das Terminal geschlossen hast. Wieder verbinden mit tmux attach -t xfer.",
        "Jeder Versuch tut weniger: bereits übertragene Dateien werden übersprungen, eine halb gesendete Datei wird fortgesetzt — so konvergiert die Schleife und ist fertig.",
        "Der Fortschritt gibt pro fertiger Datei eine Zeile aus, eine große Datei überträgt also still, bis sie fertig ist. Stille ist kein Stillstand (siehe Fehlerbehebung).",
      ],
    },
    {
      heading: "Prüfen und abschließen",
      body: [
        "Die Übertragung ist abgeschlossen, wenn die until-Schleife endet und du wieder an einer normalen Shell-Eingabe bist. Prüfe, dass beide Seiten übereinstimmen, und stoppe dann den Listener:",
      ],
      code: [
        `# compare totals on BOTH servers
du -sh /root/workspace`,
        `# on the RECEIVER, once verified
pkill -f 'relayium serve'`,
      ],
      bullets: [
        "Jede Datei wurde beim Eintreffen mit SHA-256 geprüft, gleiche Größen plus ein sauberes Ende bedeuten also eine intakte Kopie.",
      ],
    },
    {
      heading: "Fehlerbehebung",
      body: [
        "Ein paar Dinge, die wie Probleme aussehen, es aber meist nicht sind — und das eine, das es meist ist (ein blockierter Port).",
      ],
      bullets: [
        "Keine Ausgabe ist kein Stillstand. Der Fortschritt wird nur ausgegeben, wenn jede Datei fertig ist, eine große Datei überträgt also still. Prüfe den echten Zustand auf dem Sender mit ss -tnp | grep 9031 — ESTAB heißt verbunden und übertragend; SYN-SENT heißt, der Listener ist nicht erreichbar.",
        "SYN-SENT heißt, der Port ist blockiert. Öffne 9031/TCP für den Sender auf dem Empfänger (Cloud-Security-Group oder ufw allow 9031/tcp). Das ist die häufigste Ursache für eine Übertragung, die nie startet.",
        "Bevorzuge tmux plus eine einzeilige Schleife gegenüber mehrzeiligem nohup. Fügt man einen mehrzeiligen Befehl mit Anführungszeichen und einer >-Umleitung in eine Shell ein, bricht das oft an der Umleitung oder lässt dich an einer >-Fortsetzungseingabe hängen.",
        "Beim Aufräumen von Prozessen genau abgleichen (pkill -f 'relayium sync'), nicht pkill relayium — ein breiter Abgleich kann einen unbeteiligten relayium-Prozess auf derselben Maschine mit erwischen.",
        "venv und andere neu erzeugbare Verzeichnisse lohnt es auszuschließen. Ein Python-Virtualenv kann Gigabytes an Bibliotheken enthalten, die pip auf der Gegenseite neu erstellt; sie zu überspringen spart viel Übertragung.",
        "Symlinks und Spezialdateien werden übersprungen — sync überträgt nur reguläre Dateien. Wichtige Symlinks separat behandeln.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Was passiert, wenn die Übertragung auf halbem Weg unterbrochen wird?",
        a: "Nichts geht verloren. Führe relayium sync erneut aus — es überspringt bereits auf dem Empfänger vorhandene Dateien und setzt eine halb gesendete Datei beim bereits auf der Platte liegenden Byte-Offset fort. Die until-Schleife in dieser Anleitung tut das automatisch, bis der ganze Ordner gespiegelt ist.",
      },
      {
        q: "Wie unterscheidet sich das von rsync?",
        a: "Beide machen inkrementelles einseitiges Spiegeln, aber relayium sync läuft über eine gepinnte TLS-Verbindung ohne SSH-Konto (Daemon Direct), authentifiziert die beiden Maschinen per Zertifikats-Fingerprint und prüft jede Datei mit SHA-256. Es ist dieselbe Übertragungs-Engine wie die anderen Modi von relayium.",
      },
      {
        q: "Löscht sync auf dem Empfänger Dateien, die ich aus der Quelle entfernt habe?",
        a: "Nur wenn du es verlangst. Standardmäßig fügt sync nur hinzu und aktualisiert. Übergib --delete, um Löschungen zu spiegeln, und der Empfänger muss serve mit --allow-delete betreiben, damit es befolgt wird — sonst wird die Löschung ignoriert und zurückgemeldet.",
      },
      {
        q: "Kann ich zwei Ordner dauerhaft synchron halten?",
        a: "Ja. Füge --watch hinzu, und sync läuft weiter und spiegelt bei jeder Änderung unter der Quelle neu. Für ein einmaliges Verschieben eines großen Ordners brauchst du es nicht — die Retry-Schleife plus ein schlichtes sync genügen.",
      },
      {
        q: "Muss ich einen Port öffnen?",
        a: "Für Daemon Direct ja — der Port des Listeners (Standard 9031) muss vom Sender erreichbar sein. Willst du keinen Port öffnen und hast bereits SSH zwischen den Servern, funktioniert sync auch über SSH: relayium sync /path user@host:/path (relayium muss auf der Gegenseite installiert sein).",
      },
    ],
  },
  cta: {
    text: "Spiegle einen Ordner zwischen zwei eigenen Servern — inkrementell, fortsetzbar, ohne Bewachen.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Synchroniser un gros dossier entre deux serveurs (reprenable, en arrière-plan)",
  description:
    "Recopiez un gros répertoire d'un serveur vers un autre avec relayium sync — incrémental, reprenable après une coupure, et sûr à exécuter sans surveillance. Une boucle de reprise sous tmux déplace des gigaoctets sans surveiller un terminal.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Vous avez un gros dossier — des dizaines de gigaoctets — sur un serveur et vous voulez une copie exacte sur un autre. Vous ne pouvez pas surveiller un terminal pendant des heures, et un transfert qui meurt à mi-chemin ne devrait pas repartir de zéro. relayium sync est fait pour cela : un miroir incrémental à sens unique qui saute ce qui est déjà là, reprend un fichier envoyé à moitié là où il s'est arrêté, et vérifie chaque fichier de bout en bout.",
    "Ce guide met en place un transfert sans surveillance et auto-réparateur : autorisez l'émetteur une fois, faites tourner l'écouteur en arrière-plan, et pilotez relayium sync depuis une boucle de reprise dans tmux pour qu'il continue malgré les coupures jusqu'à ce que tout le dossier soit arrivé.",
  ],
  sections: [
    {
      heading: "Pourquoi relayium sync convient à cette tâche",
      body: [
        "sync est un miroir incrémental à sens unique via le protocole natif (installez relayium aux deux bouts). Trois propriétés le rendent sûr à exécuter et réexécuter sans surveillance :",
      ],
      bullets: [
        "Saute les fichiers déjà présents : un fichier dont la copie sur le récepteur correspond par taille et date de modification n'est pas renvoyé.",
        "Reprend les fichiers partiels : si un fichier était à moitié transféré à la coupure, l'exécution suivante continue depuis l'offset d'octets déjà sur le disque au lieu de le recommencer.",
        "Vérifie chaque fichier : chaque fichier est contrôlé de bout en bout en SHA-256, donc un miroir terminé est connu comme intact.",
        "De ce fait, la commande est idempotente — la relancer ne fait que le travail restant, ce qui est précisément ce qui permet à une boucle de reprise de terminer un transfert énorme.",
      ],
    },
    {
      heading: "Prérequis",
      body: [
        "Installez relayium sur les deux serveurs (sync parle le protocole natif, il doit donc être présent à chaque bout) :",
      ],
      code: [
        `# on BOTH servers
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      bullets: [
        "Ce guide utilise le daemon direct (relayium://), les deux serveurs n'ont donc pas besoin d'accès SSH l'un vers l'autre.",
        "Ouvrez le port de l'écouteur (9031 par défaut) à l'émetteur dans le pare-feu ou le groupe de sécurité du récepteur.",
      ],
    },
    {
      heading: "Autoriser l'émetteur une fois (sur le récepteur)",
      body: [
        "Le récepteur approuve la machine émettrice une seule fois ; l'approbation est écrite sur le disque et reste valable après les redémarrages, vous ne la répétez donc jamais. Démarrez d'abord l'écouteur dans un terminal, et pointez --dir vers le répertoire parent — relayium sync /root/workspace reproduit workspace/... sur le récepteur, donc --dir /root fait atterrir les fichiers dans /root/workspace/.",
        "À la première connexion de l'émetteur (section suivante), serve affiche son adresse et son empreinte et vous demande de l'approuver ; répondez y et elle est mémorisée pour de bon :",
      ],
      code: [
        `# on the RECEIVER (foreground, to approve interactively)
relayium serve --dir /root --port 9031`,
        `# on the RECEIVER, at the first connection:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Pour une configuration entièrement sans surveillance, sautez l'invite : lancez relayium id sur l'émetteur pour afficher son empreinte, puis relayium authorize <empreinte> sur le récepteur.",
        "--dir est le parent du dossier que vous synchronisez, pas le dossier lui-même — sinon les fichiers atterrissent un niveau trop bas (p. ex. /root/workspace/workspace).",
      ],
    },
    {
      heading: "Faire tourner l'écouteur en arrière-plan (sur le récepteur)",
      body: [
        "Une fois l'empreinte autorisée, arrêtez le serve au premier plan (Ctrl-C) et relancez-le détaché pour qu'il survive à votre déconnexion. Il charge l'empreinte enregistrée et accepte l'émetteur silencieusement — pas d'invite cette fois :",
      ],
      code: [
        `# on the RECEIVER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 &`,
      ],
      bullets: [
        "serve traite les connexions une par une et continue de tourner, il est donc prêt pour chaque reconnexion de la boucle de reprise ci-dessous.",
        "Pour une boîte de réception toujours active, faites-le tourner plutôt sous systemd (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Exécuter sync dans une boucle de reprise sous tmux (sur l'émetteur)",
      body: [
        "Les longs transferts sont interrompus — une session coupée, un réseau instable, un redémarrage. La solution n'est pas un outil sophistiqué ; c'est une boucle qui réexécute sync jusqu'à la réussite, plus un multiplexeur de terminal pour qu'il survive à votre déconnexion. Ici tmux est plus propre que nohup : pas de redirection de sortie à rater, et vous pouvez vous reconnecter pour voir la progression.",
        "Démarrez une session tmux, puis exécutez le miroir dans une boucle until — elle réessaie toutes les 10 secondes jusqu'à ce que sync réussisse, puis se termine d'elle-même :",
      ],
      code: [
        `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
        `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
      ],
      bullets: [
        "Détachez avec Ctrl-b puis d ; la boucle continue de tourner après la fermeture du terminal. Reconnectez-vous avec tmux attach -t xfer.",
        "Chaque tentative fait moins : les fichiers déjà transférés sont sautés, un fichier envoyé à moitié reprend — la boucle converge donc et se termine.",
        "La progression affiche une ligne par fichier terminé, un gros fichier se transfère donc en silence jusqu'à sa fin. Le silence n'est pas un blocage (voir dépannage).",
      ],
    },
    {
      heading: "Vérifier et terminer",
      body: [
        "Le transfert est terminé quand la boucle until s'achève et que vous revenez à une invite shell normale. Confirmez que les deux côtés correspondent, puis arrêtez l'écouteur :",
      ],
      code: [
        `# compare totals on BOTH servers
du -sh /root/workspace`,
        `# on the RECEIVER, once verified
pkill -f 'relayium serve'`,
      ],
      bullets: [
        "Chaque fichier a été contrôlé en SHA-256 à l'arrivée, donc des tailles identiques plus une sortie propre signifient une copie intacte.",
      ],
    },
    {
      heading: "Dépannage",
      body: [
        "Quelques choses qui ressemblent à des problèmes mais n'en sont généralement pas — et celle qui en est généralement une (un port bloqué).",
      ],
      bullets: [
        "Aucune sortie n'est pas un blocage. La progression ne s'affiche que quand chaque fichier se termine, un gros fichier se transfère donc en silence. Vérifiez l'état réel sur l'émetteur avec ss -tnp | grep 9031 — ESTAB signifie connecté et en transfert ; SYN-SENT signifie qu'il ne peut pas joindre l'écouteur.",
        "SYN-SENT signifie que le port est bloqué. Ouvrez 9031/TCP à l'émetteur sur le récepteur (groupe de sécurité cloud, ou ufw allow 9031/tcp). C'est la cause la plus fréquente d'un transfert qui ne démarre jamais.",
        "Préférez tmux plus une boucle sur une seule ligne au nohup multi-lignes. Coller dans un shell une commande multi-lignes avec des guillemets et une redirection > casse souvent sur la redirection ou vous laisse à une invite de continuation >.",
        "En nettoyant les processus, faites une correspondance précise (pkill -f 'relayium sync'), pas pkill relayium — une correspondance large peut tuer un processus relayium sans rapport tournant sur la même machine.",
        "venv et autres répertoires régénérables valent la peine d'être exclus. Un environnement virtuel Python peut contenir des gigaoctets de bibliothèques que pip recrée de l'autre côté ; les sauter économise beaucoup de transfert.",
        "Les liens symboliques et fichiers spéciaux sont sautés — sync ne transfère que des fichiers réguliers. Traitez séparément les liens symboliques importants.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Que se passe-t-il si le transfert est interrompu à mi-chemin ?",
        a: "Rien n'est perdu. Relancez relayium sync — il saute les fichiers déjà sur le récepteur et reprend un fichier envoyé à moitié depuis l'offset d'octets déjà sur le disque. La boucle until de ce guide le fait automatiquement jusqu'à ce que tout le dossier soit recopié.",
      },
      {
        q: "En quoi est-ce différent de rsync ?",
        a: "Les deux font un miroir incrémental à sens unique, mais relayium sync tourne sur une connexion TLS épinglée sans compte SSH (daemon direct), authentifie les deux machines par empreinte de certificat, et vérifie chaque fichier en SHA-256. C'est le même moteur de transfert que les autres modes de relayium.",
      },
      {
        q: "sync supprime-t-il sur le récepteur les fichiers que j'ai retirés de la source ?",
        a: "Seulement si vous le demandez. Par défaut, sync ne fait qu'ajouter et mettre à jour. Passez --delete pour recopier les suppressions, et le récepteur doit exécuter serve avec --allow-delete pour que ce soit honoré — sinon la suppression est ignorée et signalée.",
      },
      {
        q: "Puis-je garder deux dossiers synchronisés en continu ?",
        a: "Oui. Ajoutez --watch et sync reste en marche, recopiant à chaque changement sous la source. Pour un déplacement ponctuel d'un gros dossier, inutile — la boucle de reprise plus un sync simple suffisent.",
      },
      {
        q: "Dois-je ouvrir un port ?",
        a: "Pour le daemon direct, oui — le port de l'écouteur (9031 par défaut) doit être joignable depuis l'émetteur. Si vous préférez ne pas ouvrir de port et avez déjà SSH entre les serveurs, sync fonctionne aussi via SSH : relayium sync /path user@host:/path (relayium doit être installé côté distant).",
      },
    ],
  },
  cta: {
    text: "Recopiez un dossier entre deux de vos propres serveurs — incrémental, reprenable, sans surveillance.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "guides/sync-a-large-folder-between-servers",
  updated: "2026-07-08",
  langs: { en, zh, ja, ko, de, fr },
};
