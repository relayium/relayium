// web/scripts/pages/content/articles/cli-sync-large-folder.mjs
// How-to: sync a large folder between two servers with relayium sync —
// Incremental sync with automatic reconnect, optionally run in tmux.
// English is the master; every other locale follows the same structure and facts.
// Commands stay English in every language; the # comments around them are translated.

const en = {
  title: "Sync a large folder between two servers (resumable, in the background)",
  description:
    "Mirror a large directory between two servers with relayium sync. It can reconnect after temporary interruptions and reuse verified data.",
  updatedLabel: "Last updated",
  lead: [
    "Use v0.28.4 on both ends. One command automatically splits large selections into batches of up to 100,000 regular files and a 32 MiB directory index each. Matching size and SHA-256 let current receivers skip unchanged files. Older receivers can fall back to size and mtime; use --checksum to require content comparison. With v0.28.3 on the receiver, a sync can retain a private checkpoint for a file of at least 1 MiB. Rerun the same command to reuse a matching checkpoint. An interrupted file without one starts again. Completed, verified files are skipped.",
    "Authorize the sender once, keep the receiver running in the background, and run sync in tmux if the transfer should survive logout.",
  ],
  sections: [
    {
      heading: "Why relayium sync fits this job",
      body: [
        "sync is a one-way incremental mirror over the native protocol (install relayium on both ends). Three properties make it safe to run and re-run unattended:",
      ],
      bullets: [
        "Matching size and SHA-256 let current receivers skip unchanged files. Older receivers can fall back to size and mtime; use --checksum to require content comparison.",
        "With v0.28.3 on the receiver, a sync can retain a private checkpoint for a file of at least 1 MiB. Rerun the same command to reuse a matching checkpoint. An interrupted file without one starts again. Completed, verified files are skipped.",
        "Matching du -sh totals are a coarse check. Rerun with --checksum to require SHA-256 comparison of the selected files.",
      ],
    },
    {
      heading: "Prerequisites",
      body: [
        "Use v0.28.4 on both ends. One command automatically splits large selections into batches of up to 100,000 regular files and a 32 MiB directory index each. For multiple batches, run relayium serve without --once. Multi-batch sync refuses --delete. To probe first, run serve without --once and use sync --check; it verifies connectivity and authorization without sending file data. For ongoing synchronization, keep the receiver running and add --watch on the sender.",
      ],
      code: [
        `# on BOTH servers
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "What you need",
        items: [
          "This guide uses daemon direct (relayium://), so the two servers don't need SSH access to each other.",
          "Open the listener's port (9031 by default) to the sender on the receiver's firewall or security group.",
          "Room for the whole folder on the receiver. Compare du -sh /root/workspace on the sender against df -h /root on the receiver before you start a multi-hour transfer.",
        ],
      },
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
        "Once the fingerprint is authorized, stop the foreground serve (Ctrl-C) and re-launch it detached so it survives your logout. It loads the saved fingerprint and accepts the sender silently — no prompt this time. The same line records the new process's PID in ~/relayium-serve.pid, which is how the last step of this guide stops the listener it started rather than every relayium command on the box:",
      ],
      code: [
        `# on the RECEIVER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "For an always-on inbox, run it under systemd instead (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Run sync in tmux on the sender",
      body: [
        "On v0.28.4, ordinary sync automatically reconnects up to eight times after a temporary interruption and continues the current batch. With --delete, reconnect is disabled within an attempt.",
        "Keep serve running without --once. With v0.28.4 at both ends, sync shows receiver verification progress.",
      ],
      steps: [
        {
          text: "Start a tmux session on the sender.",
          code: [
            `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
          ],
        },
        {
          text: "Run the sync command once.",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "Detach with Ctrl-b then d. Reattach to check the result.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "What a successful pass looks like",
        body: [
          "Progress shows source hashing and sent bytes, including while one large file is in flight. Read the final sent/unchanged counts.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "With v0.28.3 on the receiver, a sync can retain a private checkpoint for a file of at least 1 MiB. Rerun the same command to reuse a matching checkpoint. An interrupted file without one starts again. Completed, verified files are skipped.",
        "Progress shows source hashing and sent bytes, including while one large file is in flight. Read the final sent/unchanged counts.",
      ],
    },
    {
      heading: "Verify and finish",
      body: [
        "Check the final receiver result before stopping the listener.",
      ],
      steps: [
        {
          text: "Continue once sync returns successfully and reports zero failed files.",
        },
        {
          text: "Compare the totals on both servers.",
          code: [
            `# compare totals on BOTH servers
du -sh /root/workspace`,
          ],
        },
        {
          text: "Stop the listener on the receiver once the totals match. It signals the PID you recorded when you launched it rather than substring-matching every relayium command on the box, and the PID file is removed only if that signal succeeded. A PID file left over from an earlier run can name a PID the system has since reused, so when you are not certain the file is still yours, print that PID's command line first and only kill it if serve is what comes back.",
          code: [
            `# on the RECEIVER, once verified
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "What a finished mirror looks like",
        body: [
          "Matching du -sh totals are a coarse check. Rerun with --checksum to require SHA-256 comparison of the selected files.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Matching size and SHA-256 let current receivers skip unchanged files. Older receivers can fall back to size and mtime; use --checksum to require content comparison.",
      ],
    },
    {
      heading: "Troubleshooting",
      body: [
        "Six things come up on a multi-hour mirror. Three of them look like failures and are not; the other three are real, and each has a command that says which one you are looking at.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "Nothing has printed for a long time and the transfer looks stalled.",
            code: [
              `# on the SENDER, twice, a few seconds apart
ss -tinp dst :9031
# ESTAB    the listener was reached; not proof that bytes are moving
# SYN-SENT it cannot reach the listener`,
            ],
            fix: "ESTAB proves reachability only. Check the CLI byte progress or run ss -tinp twice and compare bytes_acked. While it is hashing locally there may be no transfer socket.",
          },
          {
            symptom: "The socket sits in SYN-SENT and the transfer never starts at all.",
            code: [
              `# on the RECEIVER
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "The port is blocked. Open 9031/TCP to the sender alone — substitute the sender's own address for 203.0.113.9, its public IP or its private one when the two servers share a network — scope the cloud security group to that same source, then confirm serve is really listening. This is the most common cause of a transfer that never begins.",
          },
          {
            symptom: "Pasting the background command leaves the shell at a > continuation prompt.",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Open tmux first, then paste the sync command on its own line.",
          },
          {
            symptom: "Cleaning up killed something you did not mean to kill.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Inspect the PID with ps before signaling it. Stop only the tmux session and listener that you started for this transfer.",
          },
          {
            symptom: "Exclude a folder or file pattern you chose",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Repeat --exclude for each rule. Use relative paths or quoted file-name globs. Rules are your choice; --exclude cannot be combined with --delete.",
          },
          {
            symptom: "A source you expected to mirror arrives with nothing in it.",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "sync transfers regular files only, and that warning is exactly what a tree of nothing but symlinks looks like. Point sync at the directories the links refer to, and handle any symlinks you need on the receiver separately.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "What happens if the transfer is interrupted halfway?",
        a: "With v0.28.3 on the receiver, a sync can retain a private checkpoint for a file of at least 1 MiB. Rerun the same command to reuse a matching checkpoint. An interrupted file without one starts again. Completed, verified files are skipped.",
      },
      {
        q: "How is this different from rsync?",
        a: "Matching size and SHA-256 let current receivers skip unchanged files. Older receivers can fall back to size and mtime; use --checksum to require content comparison.",
      },
      {
        q: "Does sync delete files on the receiver that I removed from the source?",
        a: "Only if you ask. By default sync only adds and updates. Pass --delete to mirror deletions, and the receiver must run serve with --allow-delete for it to be honored — otherwise the delete is ignored and reported back.",
      },
      {
        q: "Can I keep two folders in sync continuously?",
        a: "Add --watch to repeat sync when sources change. For a one-time copy, run sync once.",
      },
      {
        q: "Do I have to open a port?",
        a: "Yes — the listener's port (9031 by default) must be reachable from the sender. Current sync accepts relayium:// destinations only; if you cannot expose a listener, use a different transfer path rather than an SSH destination.",
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
    "用 relayium sync 在两台服务器之间同步大目录。临时断线后可自动重连并复用已验证的数据。",
  updatedLabel: "最近更新",
  lead: [
    "两端均使用 v0.28.4 或更新版本。一条命令会自动分批，每批最多 100,000 个普通文件和 32 MiB 目录索引。 新版接收端按大小和 SHA-256 跳过内容相同的文件。旧接收端可能回退到大小和 mtime。用 --checksum 可要求内容比对。 接收端使用 v0.28.3 时，可为至少 1 MiB 的文件保留私有断点。重跑同一条命令可复用匹配的断点；没有可用断点的中断文件会重传，已经校验的文件会跳过。",
    "授权发送方一次，让接收端持续运行。如需在退出登录后继续传输，可在 tmux 里运行 sync。",
  ],
  sections: [
    {
      heading: "为什么 relayium sync 适合这件事",
      body: [
        "sync 是走原生协议的单向增量镜像（两端都要装 relayium）。有三个特性让它可以安心地无人值守地反复运行：",
      ],
      bullets: [
        "新版接收端按大小和 SHA-256 跳过内容相同的文件。旧接收端可能回退到大小和 mtime。用 --checksum 可要求内容比对。",
        "接收端使用 v0.28.3 时，可为至少 1 MiB 的文件保留私有断点。重跑同一条命令可复用匹配的断点；没有可用断点的中断文件会重传，已经校验的文件会跳过。",
        "du -sh 总量只是粗略核对。再用 --checksum 运行一次，可要求对选中的文件做 SHA-256 内容比对。",
      ],
    },
    {
      heading: "前提条件",
      body: [
        "两端均使用 v0.28.4 或更新版本。一条命令会自动分批，每批最多 100,000 个普通文件和 32 MiB 目录索引。 多批次同步请直接运行 relayium serve，去掉 --once。多批次同步会拒绝 --delete。若想先检查，请让接收端去掉 --once，再用 sync --check，验证连通性和授权而不发送文件数据。需要持续同步时，保持接收端运行，并在发送端加 --watch。",
      ],
      code: [
        `# 两台服务器上都执行
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "你需要准备",
        items: [
          "本指南用 daemon 直连（relayium://），所以两台服务器之间不需要 SSH 互访。",
          "在接收方的防火墙或安全组上，向发送方开放监听端口（默认 9031）。",
          "接收方要有装得下整个文件夹的空间。开始一场几个小时的传输之前，先把发送方的 du -sh /root/workspace 和接收方的 df -h /root 对一下。",
        ],
      },
    },
    {
      heading: "把发送方授权一次（在接收方）",
      body: [
        "接收方对发送的那台机器授权一次；授权会写入磁盘并在重启之间保持有效，因此你无需重复。先在终端里前台启动监听端，并把 --dir 指向父目录——relayium sync /root/workspace 会在接收方重建出 workspace/...，所以 --dir /root 会把文件落到 /root/workspace/。",
        "当发送方首次连接时（见下一节），serve 会显示它的地址和指纹并请你批准；回答 y，它就会被永久记住：",
      ],
      code: [
        `# 在接收方（前台运行，以便交互式批准）
relayium serve --dir /root --port 9031`,
        `# 在接收方，首次连接时：
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
        "指纹授权之后，停掉前台的 serve（Ctrl-C），再以脱离终端的方式重新启动，让它在你退出登录后依然存活。它会读回已保存的指纹并静默接受发送方——这次不再提示。同一行还会把新进程的 PID 记进 ~/relayium-serve.pid，本指南最后一步正是靠它停掉自己启动的这个监听端，而不是按名字匹配机器上所有 relayium 命令：",
      ],
      code: [
        `# 在接收方
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "若要做常驻收件箱，改用 systemd 运行（Restart=always，--config-dir /etc/relayium）。",
      ],
    },
    {
      heading: "在发送方的 tmux 中运行 sync",
      body: [
        "从 v0.28.4 开始，普通 sync 遇到临时断线后最多自动重连八次，并从当前批次继续。带 --delete 时单次执行禁用自动重连。",
        "让 serve 持续运行，去掉 --once。两端使用 v0.28.4 时，sync 会显示接收端校验进度。",
      ],
      steps: [
        {
          text: "在发送方开启 tmux 会话。",
          code: [
            `# 在发送方
tmux new -s xfer      # 没有 tmux 就 apt install -y tmux`,
          ],
        },
        {
          text: "执行一次 sync。",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "按 Ctrl-b，再按 d，即可分离会话。重新接入可查看结果。",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "一次成功的传输是什么样",
        body: [
          "进度会显示源文件校验和已发送字节，单个大文件传输期间也会更新。最终汇总显示发送和跳过的文件数。",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "接收端使用 v0.28.3 时，可为至少 1 MiB 的文件保留私有断点。重跑同一条命令可复用匹配的断点；没有可用断点的中断文件会重传，已经校验的文件会跳过。",
        "进度会显示源文件校验和已发送字节，单个大文件传输期间也会更新。最终汇总显示发送和跳过的文件数。",
      ],
    },
    {
      heading: "验证与收尾",
      body: [
        "查看接收端最终回执，再停止监听。",
      ],
      steps: [
        {
          text: "确认 sync 成功退出并报告零失败文件后再继续。",
        },
        {
          text: "在两台服务器上比较总量。",
          code: [
            `# 在两台服务器上比较总量
du -sh /root/workspace`,
          ],
        },
        {
          text: "总量对上之后，在接收方停掉监听端。它只对启动时记下的那个 PID 发信号，而不是拿字符串去匹配机器上每一条 relayium 命令；只有信号成功送出，PID 文件才会被删掉。上一次运行遗留的 PID 文件，可能指向一个已被系统重新分配的 PID，所以拿不准这个文件还是不是你的时，先把那个 PID 的命令行打出来，确认回显的是 serve 再动手。",
          code: [
            `# 在接收方，确认无误后
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "镜像完成是什么样",
        body: [
          "du -sh 总量只是粗略核对。再用 --checksum 运行一次，可要求对选中的文件做 SHA-256 内容比对。",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "新版接收端按大小和 SHA-256 跳过内容相同的文件。旧接收端可能回退到大小和 mtime。用 --checksum 可要求内容比对。",
      ],
    },
    {
      heading: "排错",
      body: [
        "跑几个小时的镜像会碰到六件事。其中三件看着像故障其实不是；另外三件是真问题。每一件都有一条命令能告诉你你正面对的是哪一种。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "很久没有任何输出，传输看着像卡住了。",
            code: [
              `# 在发送方，隔几秒跑两次
ss -tinp dst :9031
# ESTAB    说明够得着监听端，但不能证明字节在动
# SYN-SENT 连不上监听端`,
            ],
            fix: "ESTAB 只说明已连接。查看 CLI 的字节进度，或运行两次 ss -tinp 并比较 bytes_acked。初始本地校验时可能还没有传输连接。",
          },
          {
            symptom: "套接字停在 SYN-SENT，传输压根没开始。",
            code: [
              `# 在接收方
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "端口被挡住了。只对发送方开放 9031/TCP——把 203.0.113.9 换成发送方自己的地址，公网 IP，或者两台服务器同处一个内网时的内网 IP——云安全组也收敛到同一个来源，然后确认 serve 真的在监听。这是「传输迟迟不开始」最常见的原因。",
          },
          {
            symptom: "把后台命令粘进去之后，shell 停在一个 > 续行提示符上。",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "按 Ctrl-C 退出续行提示。先开启 tmux，再把完整的 sync 命令单独粘贴在一行，按回车运行。",
          },
          {
            symptom: "清理进程时误杀了不该杀的东西。",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "发信号前先用 ps 核对 PID。只结束本次传输启动的 tmux 会话和监听进程。",
          },
          {
            symptom: "排除你指定的目录或文件模式",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "每条规则用一个 --exclude。可以用相对路径，也可以用加引号的文件名通配符。排除项由你决定，--exclude 不能和 --delete 同用。",
          },
          {
            symptom: "你以为会镜像过去的源，传过去却是空的。",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "sync 只传普通文件，而上面这行警告正是「整棵树全是符号链接」的样子。把 sync 指向这些链接真正指向的目录，接收方需要的符号链接单独处理。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "传到一半被打断会怎样？",
        a: "接收端使用 v0.28.3 时，可为至少 1 MiB 的文件保留私有断点。重跑同一条命令可复用匹配的断点；没有可用断点的中断文件会重传，已经校验的文件会跳过。",
      },
      {
        q: "这和 rsync 有什么不同？",
        a: "新版接收端按大小和 SHA-256 跳过内容相同的文件。旧接收端可能回退到大小和 mtime。用 --checksum 可要求内容比对。",
      },
      {
        q: "sync 会把我从源端删掉的文件在接收方也删掉吗？",
        a: "只有你要求时才会。默认情况下 sync 只新增和更新。加 --delete 才会镜像删除，而且接收方必须以 --allow-delete 运行 serve 才会执行——否则删除会被忽略并回报给你。",
      },
      {
        q: "我能让两个文件夹持续保持同步吗？",
        a: "加 --watch 可在源文件变化时再次同步。只传一次时，执行一次 sync 即可。",
      },
      {
        q: "我必须开一个端口吗？",
        a: "需要——监听端口（默认 9031）必须能从发送方访问到。当前 sync 只接受 relayium:// 目标；如果不能开放监听端，请改用其他传输路径，而不是 SSH 目标。",
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
  title: "2台のサーバー間で大きなフォルダーを同期する（再開可能・バックグラウンド）",
  description:
    "relayium sync で2台のサーバー間の大きなフォルダーを同期します。一時的な切断後に再接続し、検証済みデータを再利用できます。",
  updatedLabel: "最終更新",
  lead: [
    "両端を v0.28.4 以降にしてください。1 つのコマンドで自動的に分割し、各バッチは通常ファイル 100,000 個とディレクトリインデックス 32 MiB までです。 現行の受信側はサイズと SHA-256 が一致するファイルをスキップします。旧版ではサイズと mtime に戻ることがあります。内容比較を必須にするには --checksum を使います。 再実行では検証済みの先頭部分を再利用できます。検証できる先頭部分のない中断ファイルは送り直し、完了済みの検証されたファイルはスキップします。",
    "送信側を一度許可し、受信側を起動したままにします。ログアウト後も続けるには tmux で sync を実行します。",
  ],
  sections: [
    {
      heading: "なぜ relayium sync がこの用途に向くのか",
      body: [
        "sync はネイティブプロトコル上の一方向増分ミラーです（両端に relayium をインストールします）。無人で繰り返し実行しても安全な理由が3つあります：",
      ],
      bullets: [
        "現行の受信側はサイズと SHA-256 が一致するファイルをスキップします。旧版ではサイズと mtime に戻ることがあります。内容比較を必須にするには --checksum を使います。",
        "再実行では検証済みの先頭部分を再利用できます。検証できる先頭部分のない中断ファイルは送り直し、完了済みの検証されたファイルはスキップします。",
        "du -sh の合計は目安です。選択したファイルを SHA-256 で比較するには --checksum を付けて再実行します。",
      ],
    },
    {
      heading: "前提条件",
      body: [
        "両端を v0.28.4 以降にしてください。1 つのコマンドで自動的に分割し、各バッチは通常ファイル 100,000 個とディレクトリインデックス 32 MiB までです。 複数バッチでは relayium serve を --once なしで実行します。複数バッチでは --delete を使用できません。事前確認には --once を外し、ファイルデータを送信せず到達性と許可を確認する sync --check を使います。定期的に同期する場合は受信側を起動したまま送信側に --watch を付けます。",
      ],
      code: [
        `# 両方のサーバーで
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "必要なもの",
        items: [
          "本ガイドはデーモン直結(relayium://)を使うため、2台のサーバー間に SSH アクセスは不要です。",
          "受信側のファイアウォールまたはセキュリティグループで、リスナーのポート（既定 9031）を送信側に開放してください。",
          "受信側にフォルダー全体が入る空き容量。数時間かかる転送を始める前に、送信側の du -sh /root/workspace と受信側の df -h /root を突き合わせてください。",
        ],
      },
    },
    {
      heading: "送信側を一度だけ承認する（受信側）",
      body: [
        "受信側は送信側のマシンを一度だけ承認します。承認はディスクに書き込まれ、再起動をまたいでも有効なので繰り返す必要はありません。まずターミナルでリスナーをフォアグラウンド起動し、--dir を親ディレクトリに向けます。relayium sync /root/workspace は受信側で workspace/... を再現するので、--dir /root ならファイルは /root/workspace/ に着地します。",
        "送信側の初回接続時（次節）、serve はそのアドレスとフィンガープリントを表示して承認を求めます。y と答えれば永続的に記憶されます：",
      ],
      code: [
        `# 受信側で（フォアグラウンド、対話的に承認するため）
relayium serve --dir /root --port 9031`,
        `# 受信側で、初回接続時:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "完全に無人にするならプロンプトを省けます：送信側で relayium id を実行してフィンガープリントを表示し、受信側で relayium authorize <フィンガープリント> を実行します。",
        "--dir は同期するフォルダーの親であって、フォルダー自体ではありません。さもないとファイルが1階層深く着地します（例：/root/workspace/workspace）。",
      ],
    },
    {
      heading: "リスナーをバックグラウンドで動かす（受信側）",
      body: [
        "フィンガープリントを承認したら、フォアグラウンドの serve を止め(Ctrl-C)、ログアウト後も生き残るようデタッチして再起動します。保存済みのフィンガープリントを読み込み、送信側を確認なしで受け入れます。今回はプロンプトは出ません。同じ行が新しいプロセスの PID を ~/relayium-serve.pid に記録し、本ガイドの最後の手順はそれを使って、自分が起動したリスナーを止めます。relayium という文字列を含むコマンドを片端から止めるわけではありません：",
      ],
      code: [
        `# 受信側で
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "常時稼働の受信箱にするなら、代わりに systemd で動かします（Restart=always、--config-dir /etc/relayium）。",
      ],
    },
    {
      heading: "送信側の tmux で sync を実行する",
      body: [
        "v0.28.4 の通常の sync は一時的な切断後に最大8回再接続し、現在のバッチを続行します。--delete を指定した実行では再接続しません。",
        "serve は --once なしで起動したままにします。両端が v0.28.4 なら受信側の検証進捗を表示します。",
      ],
      steps: [
        {
          text: "送信側で tmux セッションを開きます。",
          code: [
            `# 送信側で
tmux new -s xfer      # tmux が無ければ apt install -y tmux`,
          ],
        },
        {
          text: "sync を一度実行します。",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "Ctrl-b、続けて d で切り離せます。結果を見るには再接続します。",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "成功した一巡の表示",
        body: [
          "進捗は送信元のハッシュ計算と送信済みバイトを表示します。大きなファイルの途中でも更新され、最後に送信数とスキップ数が出ます。",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "再実行では検証済みの先頭部分を再利用できます。検証できる先頭部分のない中断ファイルは送り直し、完了済みの検証されたファイルはスキップします。",
        "進捗は送信元のハッシュ計算と送信済みバイトを表示します。大きなファイルの途中でも更新され、最後に送信数とスキップ数が出ます。",
      ],
    },
    {
      heading: "検証と仕上げ",
      body: [
        "リスナーを止める前に受信結果を確認します。",
      ],
      steps: [
        {
          text: "sync が正常終了し、失敗が0件であることを確認します。",
        },
        {
          text: "両方のサーバーで合計を比較します。",
          code: [
            `# 両方のサーバーで合計を比較
du -sh /root/workspace`,
          ],
        },
        {
          text: "合計が一致したら受信側のリスナーを止めます。マシン上の relayium コマンドを文字列で総なめにするのではなく、起動時に記録した PID にシグナルを送り、PID ファイルはシグナルが成功したときにだけ削除されます。前回の実行が残した PID ファイルは、システムが再利用した別の PID を指していることがあります。そのファイルがまだ自分のものか確信が持てないときは、まずその PID のコマンドラインを表示し、serve が返ってきた場合にだけ kill してください。",
          code: [
            `# 受信側で、確認できたら
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "ミラーが完了したときの表示",
        body: [
          "du -sh の合計は目安です。選択したファイルを SHA-256 で比較するには --checksum を付けて再実行します。",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "現行の受信側はサイズと SHA-256 が一致するファイルをスキップします。旧版ではサイズと mtime に戻ることがあります。内容比較を必須にするには --checksum を使います。",
      ],
    },
    {
      heading: "トラブルシューティング",
      body: [
        "数時間かかるミラーでは6つのことが起こります。うち3つは失敗に見えて失敗ではなく、残り3つは本当の問題です。どれについても、いま自分が見ているのがどれかを教えてくれるコマンドがあります。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "長いあいだ何も表示されず、転送が止まったように見える。",
            code: [
              `# 送信側で、数秒あけて2回
ss -tinp dst :9031
# ESTAB    リスナーに届いたことを示すだけで、バイトが動いている証拠ではない
# SYN-SENT リスナーに届いていない`,
            ],
            fix: "ESTAB は到達できたことだけを示します。CLI のバイト進捗を見るか、ss -tinp を 2 回実行して bytes_acked を比較してください。ローカルのハッシュ計算中は接続がない場合があります。",
          },
          {
            symptom: "ソケットが SYN-SENT のままで、転送がまったく始まらない。",
            code: [
              `# 受信側で
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "ポートが遮断されています。9031/TCP は送信側にだけ開けてください。203.0.113.9 は送信側自身のアドレス、グローバル IP か、2台が同じネットワークにいるならプライベート IP に置き換えます。クラウドのセキュリティグループも同じ送信元に絞ったうえで、serve が本当に待ち受けているかを確かめてください。転送が始まらない原因として最も多いものです。",
          },
          {
            symptom: "バックグラウンド用のコマンドを貼ると、シェルが > の継続プロンプトで止まる。",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Ctrl-C で継続プロンプトを抜けます。tmux を開き、sync コマンド全体を一行に貼り付けて実行します。",
          },
          {
            symptom: "後片付けのつもりが、殺すつもりのないものまで殺してしまった。",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "シグナルを送る前に ps で PID を確認します。今回起動した tmux セッションとリスナーだけを終了します。",
          },
          {
            symptom: "指定したフォルダーやファイルパターンを除外する",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "ルールごとに --exclude を指定します。相対パスまたは引用符で囲んだファイル名パターンを使えます。除外は利用者が指定し、--delete とは併用できません。",
          },
          {
            symptom: "ミラーされるはずのソースが、中身のない状態で届く。",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "sync が転送するのは通常ファイルだけで、この警告はまさに「シンボリックリンクしか無い木」の姿です。リンクが指している実体のディレクトリを sync に渡し、受信側で必要なシンボリックリンクは別途用意してください。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "転送が途中で中断されたらどうなりますか？",
        a: "再実行では検証済みの先頭部分を再利用できます。検証できる先頭部分のない中断ファイルは送り直し、完了済みの検証されたファイルはスキップします。",
      },
      {
        q: "これは rsync と何が違いますか？",
        a: "現行の受信側はサイズと SHA-256 が一致するファイルをスキップします。旧版ではサイズと mtime に戻ることがあります。内容比較を必須にするには --checksum を使います。",
      },
      {
        q: "ソースから削除したファイルを、sync は受信側でも削除しますか？",
        a: "求めたときだけです。既定では sync は追加と更新だけを行います。削除をミラーするには --delete を渡し、それが有効になるには受信側が --allow-delete で serve を実行している必要があります。さもなければ削除は無視され、報告されます。",
      },
      {
        q: "2つのフォルダーを継続的に同期し続けられますか？",
        a: "変更時にも同期するには --watch を追加します。一度だけコピーする場合は sync を一度実行します。",
      },
      {
        q: "ポートを開ける必要がありますか？",
        a: "はい。リスナーのポート（既定 9031）が送信側から到達可能である必要があります。現在の sync が受け付けるのは relayium:// の宛先だけです。以前の SSH 経由の sync は廃止されたので、リスナーを公開できない場合は SSH の宛先ではなく別の転送方法を使ってください。",
      },
    ],
  },
  cta: {
    text: "自分の2台のサーバー間でフォルダーをミラーしましょう。増分、再開可能、張り付き不要。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "두 서버 사이에서 큰 폴더 동기화하기(재개 가능, 백그라운드)",
  description:
    "relayium sync로 두 서버 사이의 큰 폴더를 동기화합니다. 일시적인 연결 끊김 뒤에 다시 연결하고 검증된 데이터를 재사용할 수 있습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "양쪽 모두 v0.28.4 이상을 사용하세요. 명령 하나가 자동으로 분할하며, 배치당 일반 파일 최대 100,000개와 디렉터리 인덱스 최대 32 MiB를 처리합니다. 최신 수신기는 크기와 SHA-256이 같은 파일을 건너뜁니다. 이전 수신기는 크기와 mtime으로 대체할 수 있으므로 내용 비교를 요구하려면 --checksum을 사용하세요. 다시 실행하면 검증된 앞부분을 재사용할 수 있습니다. 검증된 앞부분이 없는 중단 파일은 다시 보내고, 검증이 끝난 파일은 건너뜁니다.",
    "보내는 쪽을 한 번 승인하고 수신기를 계속 실행합니다. 로그아웃 후에도 계속하려면 tmux에서 sync를 실행하세요.",
  ],
  sections: [
    {
      heading: "왜 relayium sync가 이 작업에 맞나",
      body: [
        "sync는 네이티브 프로토콜 위의 단방향 증분 미러입니다(양쪽 끝에 relayium을 설치). 무인으로 반복 실행해도 안전한 이유가 세 가지 있습니다:",
      ],
      bullets: [
        "최신 수신기는 크기와 SHA-256이 같은 파일을 건너뜁니다. 이전 수신기는 크기와 mtime으로 대체할 수 있으므로 내용 비교를 요구하려면 --checksum을 사용하세요.",
        "다시 실행하면 검증된 앞부분을 재사용할 수 있습니다. 검증된 앞부분이 없는 중단 파일은 다시 보내고, 검증이 끝난 파일은 건너뜁니다.",
        "du -sh의 총량은 대략적인 확인입니다. 선택한 파일을 SHA-256으로 비교하려면 --checksum으로 다시 실행하세요.",
      ],
    },
    {
      heading: "사전 준비",
      body: [
        "양쪽 모두 v0.28.4 이상을 사용하세요. 명령 하나가 자동으로 분할하며, 배치당 일반 파일 최대 100,000개와 디렉터리 인덱스 최대 32 MiB를 처리합니다. 여러 배치에서는 relayium serve를 --once 없이 실행하세요. 여러 배치에서는 --delete를 사용할 수 없습니다. 사전 확인은 --once를 빼고 sync --check로 연결과 승인을 확인하며 파일 데이터는 보내지 않습니다. 계속 동기화하려면 수신기를 계속 실행하고 송신기에 --watch를 추가하세요.",
      ],
      code: [
        `# 양쪽 서버 모두에서
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "필요한 것",
        items: [
          "이 가이드는 데몬 다이렉트(relayium://)를 쓰므로 두 서버 사이에 SSH 접근이 필요 없습니다.",
          "받는 쪽 방화벽이나 보안 그룹에서 리스너 포트(기본 9031)를 보내는 쪽에 열어 두세요.",
          "받는 쪽에 폴더 전체가 들어갈 공간. 몇 시간짜리 전송을 시작하기 전에 보내는 쪽의 du -sh /root/workspace 와 받는 쪽의 df -h /root 를 맞춰 보세요.",
        ],
      },
    },
    {
      heading: "보내는 쪽을 한 번만 승인하기(받는 쪽)",
      body: [
        "받는 쪽은 보내는 기기를 한 번만 승인합니다. 승인은 디스크에 기록되어 재시작을 넘어 유효하므로 반복할 필요가 없습니다. 먼저 터미널에서 리스너를 포그라운드로 시작하고, --dir을 부모 디렉터리로 향하게 하세요. relayium sync /root/workspace는 받는 쪽에서 workspace/...를 재현하므로, --dir /root이면 파일이 /root/workspace/에 안착합니다.",
        "보내는 쪽의 첫 연결 시(다음 절), serve가 그 주소와 핑거프린트를 보여주며 승인을 요청합니다. y라고 답하면 영구적으로 기억됩니다:",
      ],
      code: [
        `# 받는 쪽에서(포그라운드, 대화식으로 승인하기 위해)
relayium serve --dir /root --port 9031`,
        `# 받는 쪽에서, 첫 연결 시:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "완전 무인 구성이라면 프롬프트를 건너뛰세요: 보내는 쪽에서 relayium id로 핑거프린트를 출력하고, 받는 쪽에서 relayium authorize <핑거프린트>를 실행합니다.",
        "--dir은 동기화하는 폴더의 부모이지 폴더 자체가 아닙니다. 그렇지 않으면 파일이 한 단계 더 깊이 안착합니다(예: /root/workspace/workspace).",
      ],
    },
    {
      heading: "리스너를 백그라운드로 돌리기(받는 쪽)",
      body: [
        "핑거프린트를 승인했으면 포그라운드 serve를 멈추고(Ctrl-C), 로그아웃 후에도 살아남도록 분리해서 다시 실행하세요. 저장된 핑거프린트를 불러와 보내는 쪽을 조용히 받아들입니다. 이번엔 프롬프트가 없습니다. 같은 줄이 새 프로세스의 PID를 ~/relayium-serve.pid에 기록하며, 이 가이드의 마지막 단계는 그것으로 자기가 띄운 리스너를 멈춥니다. relayium 이 들어간 명령을 문자열로 훑어 멈추는 방식이 아닙니다:",
      ],
      code: [
        `# 받는 쪽에서
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "항상 켜져 있는 수신함을 원하면 대신 systemd로 돌리세요(Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "보내는 쪽의 tmux에서 sync 실행하기",
      body: [
        "v0.28.4의 일반 sync는 일시적 연결 끊김 뒤에 최대 8번 다시 연결하여 현재 배치를 이어갑니다. --delete를 쓰면 한 번 실행하는 동안 다시 연결하지 않습니다.",
        "serve는 --once 없이 계속 실행하세요. 양쪽이 v0.28.4이면 수신 쪽의 검증 진행률도 표시됩니다.",
      ],
      steps: [
        {
          text: "보내는 쪽에서 tmux 세션을 여세요.",
          code: [
            `# 보내는 쪽에서
tmux new -s xfer      # tmux가 없으면 apt install -y tmux`,
          ],
        },
        {
          text: "sync를 한 번 실행하세요.",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "Ctrl-b를 누른 뒤 d를 눌러 분리합니다. 다시 접속하면 결과를 볼 수 있습니다.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "한 번의 성공적인 패스는 어떻게 보이나",
        body: [
          "진행률에는 원본 해시 계산과 전송된 바이트가 표시됩니다. 큰 파일 하나를 전송할 때도 갱신되며 마지막에 전송 수와 건너뛴 수가 표시됩니다.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "다시 실행하면 검증된 앞부분을 재사용할 수 있습니다. 검증된 앞부분이 없는 중단 파일은 다시 보내고, 검증이 끝난 파일은 건너뜁니다.",
        "진행률에는 원본 해시 계산과 전송된 바이트가 표시됩니다. 큰 파일 하나를 전송할 때도 갱신되며 마지막에 전송 수와 건너뛴 수가 표시됩니다.",
      ],
    },
    {
      heading: "검증과 마무리",
      body: [
        "수신 결과를 확인한 뒤 수신기를 중지하세요.",
      ],
      steps: [
        {
          text: "sync가 성공적으로 종료하고 실패 파일이 0개인지 확인하세요.",
        },
        {
          text: "양쪽 서버에서 합계를 비교합니다.",
          code: [
            `# 양쪽 서버에서 합계 비교
du -sh /root/workspace`,
          ],
        },
        {
          text: "합계가 맞으면 받는 쪽 리스너를 멈춥니다. 기기의 relayium 명령을 문자열로 훑는 대신 실행할 때 기록해 둔 PID에 시그널을 보내며, PID 파일은 그 시그널이 성공했을 때만 지워집니다. 이전 실행이 남긴 PID 파일은 시스템이 이미 재사용한 PID를 가리킬 수 있으니, 그 파일이 아직 내 것인지 확신이 없으면 먼저 해당 PID의 명령줄을 출력해 보고 serve 가 나올 때만 죽이세요.",
          code: [
            `# 받는 쪽에서, 확인이 끝나면
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "미러가 끝났을 때 보이는 것",
        body: [
          "du -sh의 총량은 대략적인 확인입니다. 선택한 파일을 SHA-256으로 비교하려면 --checksum으로 다시 실행하세요.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "최신 수신기는 크기와 SHA-256이 같은 파일을 건너뜁니다. 이전 수신기는 크기와 mtime으로 대체할 수 있으므로 내용 비교를 요구하려면 --checksum을 사용하세요.",
      ],
    },
    {
      heading: "문제 해결",
      body: [
        "몇 시간짜리 미러링에서는 여섯 가지가 나타납니다. 그중 셋은 실패처럼 보이지만 아니고, 나머지 셋은 진짜 문제입니다. 각각에는 지금 보고 있는 것이 어느 쪽인지 알려 주는 명령이 있습니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "한참 아무것도 출력되지 않아 전송이 멈춘 것처럼 보입니다.",
            code: [
              `# 보내는 쪽에서, 몇 초 간격으로 두 번
ss -tinp dst :9031
# ESTAB    리스너에 닿았다는 뜻일 뿐, 바이트가 움직인다는 증거는 아님
# SYN-SENT 리스너에 닿지 못함`,
            ],
            fix: "ESTAB는 연결 가능 여부만 보여 줍니다. CLI 바이트 진행률을 보거나 ss -tinp를 두 번 실행해 bytes_acked를 비교하세요. 로컬 해시 계산 중에는 전송 연결이 없을 수 있습니다.",
          },
          {
            symptom: "소켓이 SYN-SENT에 머물고 전송이 아예 시작되지 않습니다.",
            code: [
              `# 받는 쪽에서
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "포트가 막혀 있습니다. 9031/TCP는 보내는 쪽에만 여세요. 203.0.113.9 는 보내는 쪽 자신의 주소, 공인 IP나 두 서버가 같은 네트워크에 있다면 사설 IP로 바꾸고, 클라우드 보안 그룹도 같은 출발지로 좁힌 다음, serve가 정말 대기 중인지 확인하세요. 전송이 시작조차 되지 않는 가장 흔한 원인입니다.",
          },
          {
            symptom: "백그라운드용 명령을 붙여넣으면 셸이 > 계속 프롬프트에 머뭅니다.",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Ctrl-C로 계속 프롬프트를 닫으세요. tmux를 먼저 연 다음, 완전한 sync 명령을 한 줄로 붙여 넣고 실행하세요.",
          },
          {
            symptom: "정리하다가 죽일 생각이 없던 것까지 죽였습니다.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "신호를 보내기 전에 ps로 PID를 확인하세요. 이 전송을 위해 시작한 tmux 세션과 수신기만 중지합니다.",
          },
          {
            symptom: "지정한 폴더 또는 파일 패턴을 제외하기",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "규칙마다 --exclude를 지정하세요. 상대 경로나 따옴표로 감싼 파일명 패턴을 사용할 수 있습니다. 제외 항목은 직접 선택하며 --delete와 함께 쓸 수 없습니다.",
          },
          {
            symptom: "미러될 줄 알았던 소스가 텅 빈 채로 도착합니다.",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "sync는 일반 파일만 전송하며, 저 경고가 바로 심볼릭 링크뿐인 트리의 모습입니다. 링크가 가리키는 실제 디렉터리를 sync에 주고, 받는 쪽에 필요한 심볼릭 링크는 따로 처리하세요.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "전송이 도중에 중단되면 어떻게 되나요?",
        a: "다시 실행하면 검증된 앞부분을 재사용할 수 있습니다. 검증된 앞부분이 없는 중단 파일은 다시 보내고, 검증이 끝난 파일은 건너뜁니다.",
      },
      {
        q: "이것은 rsync와 무엇이 다른가요?",
        a: "최신 수신기는 크기와 SHA-256이 같은 파일을 건너뜁니다. 이전 수신기는 크기와 mtime으로 대체할 수 있으므로 내용 비교를 요구하려면 --checksum을 사용하세요.",
      },
      {
        q: "sync는 소스에서 지운 파일을 받는 쪽에서도 지우나요?",
        a: "요청할 때만요. 기본적으로 sync는 추가와 갱신만 합니다. 삭제를 미러링하려면 --delete를 넘기고, 그것이 적용되려면 받는 쪽이 --allow-delete로 serve를 실행해야 합니다. 그렇지 않으면 삭제는 무시되고 보고됩니다.",
      },
      {
        q: "두 폴더를 계속 동기화 상태로 유지할 수 있나요?",
        a: "원본 변경 때마다 동기화하려면 --watch를 추가합니다. 한 번만 복사하려면 sync를 한 번 실행합니다.",
      },
      {
        q: "포트를 열어야 하나요?",
        a: "네. 리스너 포트(기본 9031)가 보내는 쪽에서 도달 가능해야 합니다. 현재 sync는 relayium:// 대상만 받습니다. 예전의 SSH를 통한 sync는 폐지되었으므로, 리스너를 노출할 수 없다면 SSH 대상 대신 다른 전송 방법을 쓰세요.",
      },
    ],
  },
  cta: {
    text: "내 소유의 두 서버 사이에서 폴더를 미러링하세요. 증분, 재개 가능, 지켜볼 필요 없이.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Einen großen Ordner zwischen zwei Servern synchronisieren (fortsetzbar, im Hintergrund)",
  description:
    "Synchronisiere einen großen Ordner zwischen zwei Servern mit relayium sync. Nach einer vorübergehenden Unterbrechung kann es erneut verbinden und geprüfte Daten wiederverwenden.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Verwende auf beiden Seiten v0.28.4 oder neuer. Ein Befehl teilt die Auswahl automatisch auf, mit bis zu 100,000 regulären Dateien und 32 MiB Verzeichnisindex je Stapel. Aktuelle Empfänger überspringen Dateien mit gleicher Größe und gleichem SHA-256. Ältere Empfänger können auf Größe und mtime zurückfallen; --checksum erzwingt den Inhaltsvergleich. Ein weiterer Lauf kann ein geprüftes Präfix wiederverwenden. Eine unterbrochene Datei ohne solches Präfix wird neu gesendet; vollständig geprüfte Dateien werden übersprungen.",
    "Autorisiere den Sender einmal und lass den Empfänger laufen. Starte sync in tmux, wenn die Übertragung nach dem Abmelden weiterlaufen soll.",
  ],
  sections: [
    {
      heading: "Warum relayium sync für diese Aufgabe passt",
      body: [
        "sync ist ein einseitiger inkrementeller Spiegel über das native Protokoll (installiere relayium an beiden Enden). Drei Eigenschaften machen es sicher, es unbeaufsichtigt auszuführen und erneut auszuführen:",
      ],
      bullets: [
        "Aktuelle Empfänger überspringen Dateien mit gleicher Größe und gleichem SHA-256. Ältere Empfänger können auf Größe und mtime zurückfallen; --checksum erzwingt den Inhaltsvergleich.",
        "Ein weiterer Lauf kann ein geprüftes Präfix wiederverwenden. Eine unterbrochene Datei ohne solches Präfix wird neu gesendet; vollständig geprüfte Dateien werden übersprungen.",
        "Gleiche du -sh-Summen sind eine grobe Kontrolle. Führe den Lauf mit --checksum erneut aus, um die ausgewählten Dateien per SHA-256 zu vergleichen.",
      ],
    },
    {
      heading: "Voraussetzungen",
      body: [
        "Verwende auf beiden Seiten v0.28.4 oder neuer. Ein Befehl teilt die Auswahl automatisch auf, mit bis zu 100,000 regulären Dateien und 32 MiB Verzeichnisindex je Stapel. Bei mehreren Stapeln läuft relayium serve ohne --once. Mehrere Stapel unterstützen kein --delete. Für den Vorabtest lasse --once weg und nutze sync --check, das Verbindung und Berechtigung ohne Dateidaten prüft. Für laufende Synchronisierung bleibt der Empfänger aktiv und der Sender nutzt --watch.",
      ],
      code: [
        `# auf BEIDEN Servern
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Diese Anleitung nutzt daemon-direct (relayium://), die beiden Server brauchen also keinen SSH-Zugang zueinander.",
          "Öffne den Port des Listeners (Standard 9031) für den Sender in Firewall oder Security-Group des Empfängers.",
          "Platz für den ganzen Ordner auf dem Empfänger. Vergleich du -sh /root/workspace auf dem Sender mit df -h /root auf dem Empfänger, bevor du eine mehrstündige Übertragung startest.",
        ],
      },
    },
    {
      heading: "Den Sender einmal genehmigen (auf dem Empfänger)",
      body: [
        "Der Empfänger genehmigt die sendende Maschine einmal; die Genehmigung wird auf die Platte geschrieben und bleibt über Neustarts hinweg gültig, du wiederholst sie also nie. Starte den Listener zuerst in einem Terminal und richte --dir auf das übergeordnete Verzeichnis — relayium sync /root/workspace reproduziert workspace/... auf dem Empfänger, sodass --dir /root die Dateien in /root/workspace/ landen lässt.",
        "Bei der ersten Verbindung des Senders (nächster Abschnitt) zeigt serve dessen Adresse und Fingerprint und bittet dich um Genehmigung; antworte mit y, und er wird dauerhaft gespeichert:",
      ],
      code: [
        `# auf dem EMPFÄNGER (im Vordergrund, zum interaktiven Genehmigen)
relayium serve --dir /root --port 9031`,
        `# auf dem EMPFÄNGER, bei der ersten Verbindung:
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
        "Ist der Fingerprint genehmigt, beende das serve im Vordergrund (Ctrl-C) und starte es abgekoppelt neu, damit es dein Ausloggen übersteht. Es lädt den gespeicherten Fingerprint und akzeptiert den Sender stillschweigend — diesmal ohne Abfrage. Dieselbe Zeile schreibt die PID des neuen Prozesses nach ~/relayium-serve.pid, und damit beendet der letzte Schritt dieser Anleitung den Listener, den er selbst gestartet hat, statt jeden relayium-Befehl auf der Maschine:",
      ],
      code: [
        `# auf dem EMPFÄNGER
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "Für einen dauerhaft laufenden Posteingang betreibe es stattdessen unter systemd (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "sync auf dem Sender in tmux ausführen",
      body: [
        "Ab v0.28.4 verbindet sich ein normaler sync nach einer vorübergehenden Unterbrechung bis zu achtmal neu und setzt den aktuellen Stapel fort. Mit --delete bleibt die Wiederverbindung innerhalb eines Versuchs aus.",
        "Lass serve ohne --once laufen. Mit v0.28.4 auf beiden Seiten zeigt sync den Prüffortschritt des Empfängers.",
      ],
      steps: [
        {
          text: "Öffne auf dem Sender eine tmux-Sitzung.",
          code: [
            `# auf dem SENDER
tmux new -s xfer      # apt install -y tmux, falls es fehlt`,
          ],
        },
        {
          text: "Führe sync einmal aus.",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "Trenne die Sitzung mit Strg-b und dann d. Verbinde dich erneut, um das Ergebnis zu sehen.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Durchlauf aus",
        body: [
          "Der Fortschritt zeigt das Hashen an der Quelle und die gesendeten Bytes, auch während einer einzelnen großen Datei. Am Ende siehst du die Anzahl gesendeter und übersprungener Dateien.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Ein weiterer Lauf kann ein geprüftes Präfix wiederverwenden. Eine unterbrochene Datei ohne solches Präfix wird neu gesendet; vollständig geprüfte Dateien werden übersprungen.",
        "Der Fortschritt zeigt das Hashen an der Quelle und die gesendeten Bytes, auch während einer einzelnen großen Datei. Am Ende siehst du die Anzahl gesendeter und übersprungener Dateien.",
      ],
    },
    {
      heading: "Prüfen und abschließen",
      body: [
        "Prüfe das Ergebnis am Empfänger, bevor du den Listener stoppst.",
      ],
      steps: [
        {
          text: "Warte auf einen erfolgreichen Abschluss und prüfe, dass keine Datei fehlgeschlagen ist.",
        },
        {
          text: "Vergleich die Gesamtgrößen auf beiden Servern.",
          code: [
            `# Gesamtgrößen auf BEIDEN Servern vergleichen
du -sh /root/workspace`,
          ],
        },
        {
          text: "Stopp den Listener auf dem Empfänger, sobald die Größen übereinstimmen. Das Signal geht an die PID, die du beim Start notiert hast, statt per Textsuche an jeden relayium-Befehl auf der Maschine, und die PID-Datei verschwindet nur, wenn das Signal geglückt ist. Eine PID-Datei aus einem früheren Lauf kann eine PID nennen, die das System längst neu vergeben hat — bist du dir also nicht sicher, dass die Datei noch deine ist, lass dir erst die Kommandozeile dieser PID ausgeben und töte sie nur, wenn serve zurückkommt.",
          code: [
            `# auf dem EMPFÄNGER, sobald geprüft
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "So sieht ein fertiger Spiegel aus",
        body: [
          "Gleiche du -sh-Summen sind eine grobe Kontrolle. Führe den Lauf mit --checksum erneut aus, um die ausgewählten Dateien per SHA-256 zu vergleichen.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Aktuelle Empfänger überspringen Dateien mit gleicher Größe und gleichem SHA-256. Ältere Empfänger können auf Größe und mtime zurückfallen; --checksum erzwingt den Inhaltsvergleich.",
      ],
    },
    {
      heading: "Fehlerbehebung",
      body: [
        "Bei einem mehrstündigen Spiegel kommen sechs Dinge vor. Drei davon sehen wie Fehler aus und sind keine, die anderen drei sind echt — und zu jedem gibt es einen Befehl, der sagt, welches du gerade vor dir hast.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Lange Zeit erscheint nichts, und die Übertragung sieht aus, als stünde sie.",
            code: [
              `# auf dem SENDER, zweimal im Abstand einiger Sekunden
ss -tinp dst :9031
# ESTAB    der Listener wurde erreicht; kein Beleg dafür, dass Bytes fließen
# SYN-SENT erreicht den Listener nicht`,
            ],
            fix: "ESTAB zeigt nur Erreichbarkeit. Beobachte den Byte-Fortschritt oder führe ss -tinp zweimal aus und vergleiche bytes_acked. Beim lokalen Hashen kann die Verbindung noch fehlen.",
          },
          {
            symptom: "Der Socket bleibt in SYN-SENT, und die Übertragung beginnt gar nicht erst.",
            code: [
              `# auf dem EMPFÄNGER
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "Der Port ist blockiert. Öffne 9031/TCP nur für den Sender — ersetz 203.0.113.9 durch die Adresse des Senders selbst, seine öffentliche IP oder seine private, wenn beide Server im selben Netz hängen — grenz die Cloud-Sicherheitsgruppe auf dieselbe Quelle ein und prüf dann, ob serve wirklich lauscht. Das ist die häufigste Ursache für eine Übertragung, die nie anfängt.",
          },
          {
            symptom: "Nach dem Einfügen des Hintergrundbefehls hängt die Shell an einem >-Fortsetzungsprompt.",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Öffne zuerst tmux und füge den sync-Befehl in eine eigene Zeile ein.",
          },
          {
            symptom: "Beim Aufräumen ist etwas gestorben, das du nicht treffen wolltest.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Prüfe die PID mit ps, bevor du ein Signal sendest. Beende nur die tmux-Sitzung und den Listener dieser Übertragung.",
          },
          {
            symptom: "Einen gewählten Ordner oder ein Dateimuster ausschließen",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Setze --exclude pro Regel. Gib relative Pfade oder Dateinamensmuster in Anführungszeichen an. Du wählst die Ausschlüsse; --delete ist damit nicht kombinierbar.",
          },
          {
            symptom: "Eine Quelle, die gespiegelt werden sollte, kommt leer an.",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "sync überträgt nur reguläre Dateien, und genau so sieht ein Baum aus, der nur aus Symlinks besteht. Richte sync auf die Verzeichnisse, auf die die Links zeigen, und leg die benötigten Symlinks auf dem Empfänger getrennt an.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Was passiert, wenn die Übertragung auf halbem Weg unterbrochen wird?",
        a: "Ein weiterer Lauf kann ein geprüftes Präfix wiederverwenden. Eine unterbrochene Datei ohne solches Präfix wird neu gesendet; vollständig geprüfte Dateien werden übersprungen.",
      },
      {
        q: "Wie unterscheidet sich das von rsync?",
        a: "Aktuelle Empfänger überspringen Dateien mit gleicher Größe und gleichem SHA-256. Ältere Empfänger können auf Größe und mtime zurückfallen; --checksum erzwingt den Inhaltsvergleich.",
      },
      {
        q: "Löscht sync auf dem Empfänger Dateien, die ich aus der Quelle entfernt habe?",
        a: "Nur wenn du es verlangst. Standardmäßig fügt sync nur hinzu und aktualisiert. Übergib --delete, um Löschungen zu spiegeln, und der Empfänger muss serve mit --allow-delete betreiben, damit es befolgt wird — sonst wird die Löschung ignoriert und zurückgemeldet.",
      },
      {
        q: "Kann ich zwei Ordner dauerhaft synchron halten?",
        a: "Mit --watch synchronisiert sync bei Änderungen erneut. Für eine einmalige Kopie führe sync einmal aus.",
      },
      {
        q: "Muss ich einen Port öffnen?",
        a: "Ja — der Port des Listeners (Standard 9031) muss vom Sender erreichbar sein. Das aktuelle sync akzeptiert nur relayium://-Ziele; sync über SSH ist eingestellt. Kannst du keinen Listener erreichbar machen, nimm einen anderen Übertragungsweg statt eines SSH-Ziels.",
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
  title: "Synchroniser un gros dossier entre deux serveurs (avec reprise, en arrière-plan)",
  description:
    "Synchronisez un grand dossier entre deux serveurs avec relayium sync. Il peut se reconnecter après une interruption temporaire et réutiliser les données vérifiées.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Utilisez v0.28.4 ou une version ultérieure aux deux extrémités. Une commande divise automatiquement la sélection en lots de 100,000 fichiers ordinaires et 32 MiB d’index au maximum. Les récepteurs récents ignorent les fichiers dont la taille et le SHA-256 correspondent. Les anciens peuvent revenir à la taille et au mtime. --checksum impose la comparaison du contenu. Une nouvelle exécution peut réutiliser un préfixe vérifié. Un fichier interrompu sans préfixe vérifié repart du début et les fichiers terminés et vérifiés sont ignorés.",
    "Autorisez l’émetteur une fois et laissez le récepteur tourner. Pour continuer après la déconnexion de votre terminal, lancez sync dans tmux.",
  ],
  sections: [
    {
      heading: "Pourquoi relayium sync convient à cette tâche",
      body: [
        "sync est un miroir incrémental à sens unique via le protocole natif (installez relayium aux deux bouts). Trois propriétés le rendent sûr à exécuter et réexécuter sans surveillance :",
      ],
      bullets: [
        "Les récepteurs récents ignorent les fichiers dont la taille et le SHA-256 correspondent. Les anciens peuvent revenir à la taille et au mtime. --checksum impose la comparaison du contenu.",
        "Une nouvelle exécution peut réutiliser un préfixe vérifié. Un fichier interrompu sans préfixe vérifié repart du début et les fichiers terminés et vérifiés sont ignorés.",
        "Les totaux de du -sh donnent un ordre de grandeur. Relancez avec --checksum pour imposer la comparaison SHA-256 des fichiers sélectionnés.",
      ],
    },
    {
      heading: "Prérequis",
      body: [
        "Utilisez v0.28.4 ou une version ultérieure aux deux extrémités. Une commande divise automatiquement la sélection en lots de 100,000 fichiers ordinaires et 32 MiB d’index au maximum. Pour plusieurs lots, lancez relayium serve sans --once. Le mode par lots refuse --delete. Pour un contrôle préalable, omettez --once et utilisez sync --check, qui vérifie la connexion et l’autorisation sans envoyer de données de fichier. Pour une synchronisation continue, laissez le récepteur en marche et ajoutez --watch côté envoi.",
      ],
      code: [
        `# sur les DEUX serveurs
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Ce guide utilise le daemon-direct (relayium://), les deux serveurs n'ont donc pas besoin d'accès SSH l'un vers l'autre.",
          "Ouvrez le port du processus à l'écoute (9031 par défaut) à l'émetteur dans le pare-feu ou le groupe de sécurité du récepteur.",
          "De la place pour tout le dossier sur le récepteur. Comparez du -sh /root/workspace sur l'émetteur et df -h /root sur le récepteur avant de lancer un transfert de plusieurs heures.",
        ],
      },
    },
    {
      heading: "Autoriser l'émetteur une fois (sur le récepteur)",
      body: [
        "Le récepteur approuve la machine émettrice une seule fois ; l'approbation est écrite sur le disque et reste valable après les redémarrages, vous ne la répétez donc jamais. Démarrez d'abord le processus à l'écoute dans un terminal, et pointez --dir vers le répertoire parent — relayium sync /root/workspace reproduit workspace/... sur le récepteur, donc --dir /root fait atterrir les fichiers dans /root/workspace/.",
        "À la première connexion de l'émetteur (section suivante), serve affiche son adresse et son empreinte et vous demande de l'approuver ; répondez y et elle est mémorisée pour de bon :",
      ],
      code: [
        `# sur le RÉCEPTEUR (au premier plan, pour approuver de façon interactive)
relayium serve --dir /root --port 9031`,
        `# sur le RÉCEPTEUR, à la première connexion :
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Pour une configuration entièrement sans surveillance, sautez l'invite : lancez relayium id sur l'émetteur pour afficher son empreinte, puis relayium authorize <empreinte> sur le récepteur.",
        "--dir est le parent du dossier que vous synchronisez, pas le dossier lui-même — sinon les fichiers atterrissent un niveau trop bas (p. ex. /root/workspace/workspace).",
      ],
    },
    {
      heading: "Faire tourner le processus à l'écoute en arrière-plan (sur le récepteur)",
      body: [
        "Une fois l'empreinte autorisée, arrêtez le serve au premier plan (Ctrl-C) et relancez-le détaché pour qu'il survive à votre déconnexion. Il charge l'empreinte enregistrée et accepte l'émetteur silencieusement — pas d'invite cette fois. La même ligne note le PID du nouveau processus dans ~/relayium-serve.pid, et c'est ainsi que la dernière étape de ce guide arrête le processus à l'écoute qu'elle a lancé, au lieu de viser toute commande relayium de la machine :",
      ],
      code: [
        `# sur le RÉCEPTEUR
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "Pour une boîte de réception toujours active, faites-le tourner plutôt sous systemd (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Lancer sync dans tmux côté émetteur",
      body: [
        "Depuis la v0.28.4, sync se reconnecte jusqu’à huit fois après une interruption temporaire et reprend le lot courant. Avec --delete, la reconnexion est désactivée au sein d’une tentative.",
        "Laissez serve tourner sans --once. Avec la v0.28.4 aux deux extrémités, sync affiche la progression des vérifications côté réception.",
      ],
      steps: [
        {
          text: "Ouvrez une session tmux sur l’émetteur.",
          code: [
            `# sur l'ÉMETTEUR
tmux new -s xfer      # apt install -y tmux s'il manque`,
          ],
        },
        {
          text: "Exécutez sync une seule fois.",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "Détachez la session avec Ctrl-b puis d. Rattachez-la pour consulter le résultat.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "À quoi ressemble un passage réussi",
        body: [
          "La progression indique le calcul des empreintes et les octets envoyés, y compris pendant le transfert d’un seul gros fichier. Le bilan final indique les fichiers envoyés et ignorés.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Une nouvelle exécution peut réutiliser un préfixe vérifié. Un fichier interrompu sans préfixe vérifié repart du début et les fichiers terminés et vérifiés sont ignorés.",
        "La progression indique le calcul des empreintes et les octets envoyés, y compris pendant le transfert d’un seul gros fichier. Le bilan final indique les fichiers envoyés et ignorés.",
      ],
    },
    {
      heading: "Vérifier et terminer",
      body: [
        "Vérifiez le résultat côté réception avant d’arrêter le processus à l’écoute.",
      ],
      steps: [
        {
          text: "Attendez que sync se termine avec succès et confirme qu’aucun fichier n’a échoué.",
        },
        {
          text: "Comparez les totaux sur les deux serveurs.",
          code: [
            `# comparez les totaux sur les DEUX serveurs
du -sh /root/workspace`,
          ],
        },
        {
          text: "Arrêtez le processus à l'écoute sur le récepteur une fois les totaux identiques. Le signal part vers le PID noté au lancement, et non vers toute commande relayium de la machine trouvée par correspondance de texte, et le fichier de PID n'est supprimé que si ce signal a réussi. Un fichier de PID laissé par une exécution précédente peut désigner un PID que le système a depuis réattribué, donc si vous n'êtes pas certain qu'il soit encore le vôtre, affichez d'abord la ligne de commande de ce PID et ne le tuez que si serve apparaît.",
          code: [
            `# sur le RÉCEPTEUR, une fois vérifié
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "À quoi ressemble un miroir terminé",
        body: [
          "Les totaux de du -sh donnent un ordre de grandeur. Relancez avec --checksum pour imposer la comparaison SHA-256 des fichiers sélectionnés.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Les récepteurs récents ignorent les fichiers dont la taille et le SHA-256 correspondent. Les anciens peuvent revenir à la taille et au mtime. --checksum impose la comparaison du contenu.",
      ],
    },
    {
      heading: "Dépannage",
      body: [
        "Six choses reviennent sur un miroir de plusieurs heures. Trois ressemblent à des pannes sans en être, les trois autres en sont vraiment, et chacune a une commande qui dit laquelle vous avez sous les yeux.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Rien ne s'affiche depuis longtemps et le transfert semble bloqué.",
            code: [
              `# sur l'ÉMETTEUR, deux fois, à quelques secondes d'intervalle
ss -tinp dst :9031
# ESTAB    le processus à l'écoute a été atteint, ce n'est pas une preuve que des octets circulent
# SYN-SENT n'atteint pas le processus à l'écoute`,
            ],
            fix: "ESTAB prouve seulement l’accessibilité. Regardez les octets dans le CLI ou exécutez ss -tinp deux fois et comparez bytes_acked. Le calcul local peut précéder toute connexion de transfert.",
          },
          {
            symptom: "La socket reste en SYN-SENT et le transfert ne démarre jamais.",
            code: [
              `# sur le RÉCEPTEUR
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "Le port est bloqué. N'ouvrez 9031/TCP qu'à l'émetteur — remplacez 203.0.113.9 par l'adresse de l'émetteur lui-même, son IP publique ou son IP privée si les deux serveurs partagent un réseau — restreignez le groupe de sécurité cloud à cette même source, puis vérifiez que serve écoute vraiment. C'est la cause la plus fréquente d'un transfert qui ne commence jamais.",
          },
          {
            symptom: "Coller la commande d'arrière-plan laisse le shell sur une invite de continuation >.",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Ouvrez d’abord tmux, puis collez la commande sync seule sur sa ligne.",
          },
          {
            symptom: "Le nettoyage a tué quelque chose que vous ne visiez pas.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Vérifiez le PID avec ps avant d’envoyer un signal. Arrêtez uniquement la session tmux et le processus à l’écoute lancés pour ce transfert.",
          },
          {
            symptom: "Exclure un dossier ou un motif de votre choix",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Répétez --exclude pour chaque règle. Utilisez des chemins relatifs ou des motifs de noms entre guillemets. Vous choisissez les exclusions. --exclude et --delete sont incompatibles.",
          },
          {
            symptom: "Une source censée être mise en miroir arrive vide.",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "sync ne transfère que des fichiers réguliers, et cet avertissement est exactement l'aspect d'une arborescence faite uniquement de liens symboliques. Pointez sync sur les répertoires que les liens désignent, et créez séparément sur le récepteur les liens dont vous avez besoin.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Que se passe-t-il si le transfert est interrompu à mi-chemin ?",
        a: "Une nouvelle exécution peut réutiliser un préfixe vérifié. Un fichier interrompu sans préfixe vérifié repart du début et les fichiers terminés et vérifiés sont ignorés.",
      },
      {
        q: "En quoi est-ce différent de rsync ?",
        a: "Les récepteurs récents ignorent les fichiers dont la taille et le SHA-256 correspondent. Les anciens peuvent revenir à la taille et au mtime. --checksum impose la comparaison du contenu.",
      },
      {
        q: "sync supprime-t-il sur le récepteur les fichiers que j'ai retirés de la source ?",
        a: "Seulement si vous le demandez. Par défaut, sync ne fait qu'ajouter et mettre à jour. Passez --delete pour recopier les suppressions, et le récepteur doit exécuter serve avec --allow-delete pour que ce soit honoré — sinon la suppression est ignorée et signalée.",
      },
      {
        q: "Puis-je garder deux dossiers synchronisés en continu ?",
        a: "Ajoutez --watch pour synchroniser à chaque changement des sources. Pour une copie ponctuelle, lancez sync une fois.",
      },
      {
        q: "Dois-je ouvrir un port ?",
        a: "Oui — le port du processus à l'écoute (9031 par défaut) doit être joignable depuis l'émetteur. Le sync actuel n'accepte que des destinations relayium:// ; le sync via SSH est retiré. Si vous ne pouvez pas exposer de processus à l'écoute, utilisez un autre chemin de transfert plutôt qu'une destination SSH.",
      },
    ],
  },
  cta: {
    text: "Recopiez un dossier entre deux de vos propres serveurs — incrémental, avec reprise, sans surveillance.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "مزامنة مجلد كبير بين خادمين (قابلة للاستئناف، في الخلفية)",
  description:
    "زامن مجلدًا كبيرًا بين خادمين باستخدام relayium sync. يستطيع إعادة الاتصال بعد انقطاع مؤقت وإعادة استخدام البيانات التي تحقّق منها.",
  updatedLabel: "آخر تحديث",
  lead: [
    "استخدم v0.28.4 أو أحدث على الطرفين. يقسّم الأمر الملفات تلقائيًا إلى دفعات تضم كل منها حتى 100,000 ملف عادي وفهرسًا حتى 32 MiB. يتخطّى المستقبِل الحديث الملفات التي يتطابق حجمها وبصمة SHA-256 لها. قد يرجع المستقبِل القديم إلى الحجم وmtime؛ استخدم --checksum لاشتراط مقارنة المحتوى. قد تعيد المحاولة استخدام بادئة جرى التحقق منها. يبدأ الملف المنقطع بلا بادئة صالحة من جديد، وتُتخطّى الملفات المكتملة التي جرى التحقق منها.",
    "فوّض المُرسِل مرة واحدة وأبقِ المستقبِل قيد التشغيل. شغّل sync داخل tmux لمواصلة النقل بعد تسجيل الخروج.",
  ],
  sections: [
    {
      heading: "لماذا يناسب relayium sync هذه المهمة",
      body: [
        "sync مرآة تزايدية أحادية الاتجاه عبر البروتوكول الأصلي (ثبّت relayium على الطرفين). ثلاث خصائص تجعله آمنًا للتشغيل وإعادة التشغيل دون إشراف:",
      ],
      bullets: [
        "يتخطّى المستقبِل الحديث الملفات التي يتطابق حجمها وبصمة SHA-256 لها. قد يرجع المستقبِل القديم إلى الحجم وmtime؛ استخدم --checksum لاشتراط مقارنة المحتوى.",
        "قد تعيد المحاولة استخدام بادئة جرى التحقق منها. يبدأ الملف المنقطع بلا بادئة صالحة من جديد، وتُتخطّى الملفات المكتملة التي جرى التحقق منها.",
        "تطابق إجمالي du -sh فحص تقريبي. أعد التشغيل مع --checksum لاشتراط مقارنة SHA-256 للملفات المحددة.",
      ],
    },
    {
      heading: "المتطلبات المسبقة",
      body: [
        "استخدم v0.28.4 أو أحدث على الطرفين. يقسّم الأمر الملفات تلقائيًا إلى دفعات تضم كل منها حتى 100,000 ملف عادي وفهرسًا حتى 32 MiB. لعدة دفعات شغّل relayium serve بدون --once. لا يدعم النقل متعدد الدفعات --delete. للفحص المسبق، احذف --once واستخدم sync --check لاختبار الاتصال والتفويض بلا إرسال بيانات الملفات. للمزامنة المستمرة، أبقِ المستقبِل قيد التشغيل وأضف --watch على المُرسِل.",
      ],
      code: [
        `# على كلا الخادمين
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "يستخدم هذا الدليل daemon direct (relayium://)، فلا يحتاج الخادمان إلى وصول SSH أحدهما للآخر.",
          "افتح منفذ المُستمِع (9031 افتراضيًا) للمُرسِل على الجدار الناري أو مجموعة الأمان لدى المُستقبِل.",
          "مساحة تكفي المجلد كاملًا على المُستقبِل. قارِن du -sh /root/workspace على المُرسِل بـ df -h /root على المُستقبِل قبل أن تبدأ نقلًا يستغرق ساعات.",
        ],
      },
    },
    {
      heading: "فوِّض المُرسِل مرةً واحدة (على المُستقبِل)",
      body: [
        "يعتمد المُستقبِل الجهاز المُرسِل مرةً واحدة؛ يُكتَب الاعتماد على القرص ويبقى صالحًا عبر إعادات التشغيل، فلا تكرره أبدًا. شغّل المُستمِع أولًا في طرفية في المقدمة، ووجِّه --dir إلى الدليل الأب — relayium sync /root/workspace يُعيد إنتاج workspace/... لدى المُستقبِل، فـ --dir /root يُنزِل الملفات في /root/workspace/.",
        "عند أول اتصال للمُرسِل (القسم التالي)، يُظهِر serve عنوانه وبصمته ويطلب منك اعتماده؛ أجِب بـ y فيُحفَظ إلى الأبد:",
      ],
      code: [
        `# على المُستقبِل (في المقدمة، للاعتماد تفاعليًا)
relayium serve --dir /root --port 9031`,
        `# على المُستقبِل، عند أول اتصال:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "لإعداد بلا إشراف تمامًا، تخطَّ المُطالبة: شغّل relayium id على المُرسِل لطباعة بصمته، ثم relayium authorize ‎<البصمة>‎ على المُستقبِل.",
        "‏--dir هو أب المجلد الذي تزامنه، لا المجلد نفسه — وإلا نزلت الملفات مستوى أعمق مما ينبغي (مثلًا /root/workspace/workspace).",
      ],
    },
    {
      heading: "شغّل المُستمِع في الخلفية (على المُستقبِل)",
      body: [
        "بمجرد اعتماد البصمة، أوقِف serve الذي في المقدمة (Ctrl-C) وأعِد تشغيله منفصلًا كي يصمد بعد خروجك من الجلسة. يحمّل البصمة المحفوظة ويقبل المُرسِل بصمت — لا مُطالبة هذه المرة. ويسجّل السطر نفسه مُعرّف العملية الجديدة (PID) في ~/relayium-serve.pid، وبه توقِف الخطوة الأخيرة من هذا الدليل المُستمِع الذي شغّلته هي، بدل مطابقة كل أمر relayium على الجهاز:",
      ],
      code: [
        `# على المُستقبِل
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "لصندوق وارد دائم التشغيل، شغّله تحت systemd بدلًا من ذلك (Restart=always، --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "تشغيل sync داخل tmux لدى المُرسِل",
      body: [
        "بدءًا من v0.28.4 يعيد sync العادي الاتصال حتى ثماني مرات بعد انقطاع مؤقت ويتابع الدفعة الحالية. عند استخدام --delete تتوقف إعادة الاتصال داخل المحاولة الواحدة.",
        "أبقِ serve قيد التشغيل دون --once. مع v0.28.4 على الطرفين يعرض sync تقدّم التحقق لدى المستقبِل.",
      ],
      steps: [
        {
          text: "افتح جلسة tmux على المُرسِل.",
          code: [
            `# على المُرسِل
tmux new -s xfer      # نفّذ apt install -y tmux إن لم يكن موجودًا`,
          ],
        },
        {
          text: "شغّل sync مرة واحدة.",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "اضغط Ctrl-b ثم d لفصل الجلسة. عاود الاتصال بها للاطلاع على النتيجة.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "كيف تبدو جولة ناجحة",
        body: [
          "يعرض التقدّم حساب البصمات والبايتات المرسلة حتى أثناء إرسال ملف كبير واحد. ويعرض الملخص عدد الملفات المرسلة والمتخطاة.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "قد تعيد المحاولة استخدام بادئة جرى التحقق منها. يبدأ الملف المنقطع بلا بادئة صالحة من جديد، وتُتخطّى الملفات المكتملة التي جرى التحقق منها.",
        "يعرض التقدّم حساب البصمات والبايتات المرسلة حتى أثناء إرسال ملف كبير واحد. ويعرض الملخص عدد الملفات المرسلة والمتخطاة.",
      ],
    },
    {
      heading: "التحقق والإنهاء",
      body: [
        "افحص النتيجة النهائية لدى المستقبِل قبل إيقاف المستمع.",
      ],
      steps: [
        {
          text: "تأكّد من نجاح sync وأن عدد الملفات الفاشلة صفر.",
        },
        {
          text: "قارِن الإجماليات على كلا الخادمين.",
          code: [
            `# قارِن الإجماليات على كلا الخادمين
du -sh /root/workspace`,
          ],
        },
        {
          text: "أوقِف المُستمِع على المُستقبِل بعد تطابق الإجماليات. تُرسَل الإشارة إلى مُعرّف العملية الذي دوّنته عند التشغيل، لا إلى كل أمر relayium على الجهاز بمطابقة نصية، ولا يُحذَف ملف الـPID إلا إذا نجحت تلك الإشارة. وقد يشير ملف PID بقي من تشغيل سابق إلى مُعرّف أعاد النظام استخدامه، فإن لم تكن واثقًا أنه ما زال ملفك، اعرض أولًا سطر أوامر ذلك المُعرّف ولا تقتله إلا إذا ظهر serve.",
          code: [
            `# على المُستقبِل، بعد التحقق
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "كيف تبدو المرآة المكتملة",
        body: [
          "تطابق إجمالي du -sh فحص تقريبي. أعد التشغيل مع --checksum لاشتراط مقارنة SHA-256 للملفات المحددة.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "يتخطّى المستقبِل الحديث الملفات التي يتطابق حجمها وبصمة SHA-256 لها. قد يرجع المستقبِل القديم إلى الحجم وmtime؛ استخدم --checksum لاشتراط مقارنة المحتوى.",
      ],
    },
    {
      heading: "استكشاف الأخطاء وإصلاحها",
      body: [
        "ستة أمور تظهر في مرآة تستغرق ساعات. ثلاثة منها تبدو أعطالًا وليست كذلك، والثلاثة الأخرى أعطال حقيقية، ولكل واحد أمر يخبرك أيَّها تنظر إليه.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "لم يُطبَع شيء منذ وقت طويل ويبدو النقل متوقفًا.",
            code: [
              `# على المُرسِل، مرتين بفارق ثوانٍ قليلة
ss -tinp dst :9031
# ESTAB    وصلت إلى المُستمِع، وليس دليلًا على أن البايتات تتحرك
# SYN-SENT لا يصل إلى المُستمِع`,
            ],
            fix: "يشير ESTAB إلى إمكانية الوصول فقط. راقب تقدّم البايتات أو نفّذ ss -tinp مرتين وقارن bytes_acked. قد لا يوجد اتصال نقل أثناء حساب البصمات محليًا.",
          },
          {
            symptom: "يبقى المقبس في حالة SYN-SENT ولا يبدأ النقل أصلًا.",
            code: [
              `# على المُستقبِل
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "المنفذ محجوب. لا تفتح 9031/TCP إلا أمام المُرسِل — استبدِل 203.0.113.9 بعنوان المُرسِل نفسه، عنوانه العام أو الخاص إن كان الخادمان على الشبكة ذاتها — وضيِّق مجموعة الأمان السحابية على المصدر نفسه، ثم تأكّد من أن serve يستمع فعلًا. هذا أكثر أسباب النقل الذي لا يبدأ شيوعًا.",
          },
          {
            symptom: "بعد لصق أمر التشغيل في الخلفية، تبقى الصَدَفة عند مِحَث المتابعة <.",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "افتح tmux أولًا، ثم ألصق أمر sync وحده في سطر مستقل.",
          },
          {
            symptom: "قتل التنظيف شيئًا لم تكن تقصده.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "تحقّق من PID باستخدام ps قبل إرسال الإشارة. أوقف فقط جلسة tmux والمستمع اللذين شغّلتهما لهذا النقل.",
          },
          {
            symptom: "استبعاد مجلد أو نمط أسماء تختاره",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "كرّر --exclude لكل قاعدة. استخدم مسارات نسبية أو أنماط أسماء بين علامات اقتباس. أنت من يحدد ما يُستبعد، ولا يمكن الجمع بين --exclude و--delete.",
          },
          {
            symptom: "يصل مصدر كنت تتوقع نسخه فارغًا.",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "لا ينقل sync إلا الملفات العادية، وهذا التحذير هو تمامًا شكل شجرة ليس فيها سوى روابط رمزية. وجّه sync إلى المجلدات التي تشير إليها الروابط، وأنشئ ما تحتاج إليه من روابط رمزية على المُستقبِل على حدة.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "ماذا يحدث إذا انقطع النقل في منتصف الطريق؟",
        a: "قد تعيد المحاولة استخدام بادئة جرى التحقق منها. يبدأ الملف المنقطع بلا بادئة صالحة من جديد، وتُتخطّى الملفات المكتملة التي جرى التحقق منها.",
      },
      {
        q: "بماذا يختلف هذا عن rsync؟",
        a: "يتخطّى المستقبِل الحديث الملفات التي يتطابق حجمها وبصمة SHA-256 لها. قد يرجع المستقبِل القديم إلى الحجم وmtime؛ استخدم --checksum لاشتراط مقارنة المحتوى.",
      },
      {
        q: "هل يحذف sync لدى المُستقبِل الملفات التي أزلتها من المصدر؟",
        a: "فقط إن طلبت ذلك. افتراضيًا، يضيف sync ويحدّث فقط. مرِّر --delete لعكس عمليات الحذف، ويجب أن يشغّل المُستقبِل serve مع --allow-delete كي يُحترَم ذلك — وإلا يُتجاهَل الحذف ويُبلَّغ عنه.",
      },
      {
        q: "هل يمكنني إبقاء مجلدين متزامنين باستمرار؟",
        a: "أضف --watch لإعادة المزامنة عند تغيّر المصادر. للنسخ مرة واحدة، شغّل sync مرة واحدة.",
      },
      {
        q: "هل عليّ فتح منفذ؟",
        a: "نعم — يجب أن يكون منفذ المُستمِع (9031 افتراضيًا) قابلًا للوصول من المُرسِل. لا يقبل sync الحالي إلا وجهات relayium://، وقد أُوقف sync عبر SSH. وإن تعذّر عليك إتاحة مُستمِع، فاستخدم مسار نقل آخر بدل وجهة SSH.",
      },
    ],
  },
  cta: {
    text: "انسخ صورة مجلد بين خادمين من خوادمك — تزايديًا، قابلًا للاستئناف، دون ملازمة.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Sincronizar una carpeta grande entre dos servidores (reanudable, en segundo plano)",
  description:
    "Sincroniza una carpeta grande entre dos servidores con relayium sync. Puede reconectarse tras una interrupción temporal y reutilizar datos verificados.",
  updatedLabel: "Última actualización",
  lead: [
    "Usa v0.28.4 o posterior en ambos extremos. Un comando divide la selección automáticamente en lotes de hasta 100,000 archivos regulares y 32 MiB de índice de directorio. Los receptores actuales omiten archivos con el mismo tamaño y SHA-256. Los antiguos pueden recurrir al tamaño y al mtime; --checksum exige comparar el contenido. Otra ejecución puede reutilizar un prefijo verificado. Un archivo interrumpido sin prefijo verificado vuelve a enviarse y los archivos completos verificados se omiten.",
    "Autoriza el emisor una sola vez y deja el receptor en marcha. Ejecuta sync en tmux para que siga después de cerrar sesión.",
  ],
  sections: [
    {
      heading: "Por qué relayium sync encaja en esta tarea",
      body: [
        "sync es un espejo incremental unidireccional sobre el protocolo nativo (instala relayium en ambos extremos). Tres propiedades hacen que sea seguro ejecutarlo y volver a ejecutarlo sin supervisión:",
      ],
      bullets: [
        "Los receptores actuales omiten archivos con el mismo tamaño y SHA-256. Los antiguos pueden recurrir al tamaño y al mtime; --checksum exige comparar el contenido.",
        "Otra ejecución puede reutilizar un prefijo verificado. Un archivo interrumpido sin prefijo verificado vuelve a enviarse y los archivos completos verificados se omiten.",
        "Los totales de du -sh sirven como comprobación aproximada. Repite con --checksum para exigir la comparación SHA-256 de los archivos seleccionados.",
      ],
    },
    {
      heading: "Requisitos previos",
      body: [
        "Usa v0.28.4 o posterior en ambos extremos. Un comando divide la selección automáticamente en lotes de hasta 100,000 archivos regulares y 32 MiB de índice de directorio. Para varios lotes, ejecuta relayium serve sin --once. La sincronización en varios lotes rechaza --delete. Para comprobar primero, omite --once y usa sync --check, que verifica la conexión y la autorización sin enviar datos de archivos. Para sincronizar continuamente, deja el receptor activo y añade --watch en el emisor.",
      ],
      code: [
        `# en AMBOS servidores
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Esta guía usa daemon directo (relayium://), así que los dos servidores no necesitan acceso SSH entre sí.",
          "Abre el puerto del proceso a la escucha (9031 por defecto) al emisor en el cortafuegos o grupo de seguridad del receptor.",
          "Sitio para toda la carpeta en el receptor. Compara du -sh /root/workspace en el emisor con df -h /root en el receptor antes de lanzar una transferencia de varias horas.",
        ],
      },
    },
    {
      heading: "Autorizar al emisor una vez (en el receptor)",
      body: [
        "El receptor aprueba la máquina emisora una vez; la aprobación se escribe en disco y sigue siendo válida entre reinicios, así que nunca la repites. Inicia el proceso a la escucha en una terminal y apunta --dir al directorio padre — relayium sync /root/workspace reproduce workspace/... en el receptor, así que --dir /root deposita los archivos en /root/workspace/.",
        "En la primera conexión del emisor (siguiente sección), serve muestra su dirección y su huella y te pide que lo apruebes; responde y y se recuerda para siempre:",
      ],
      code: [
        `# en el RECEPTOR (en primer plano, para aprobar de forma interactiva)
relayium serve --dir /root --port 9031`,
        `# en el RECEPTOR, en la primera conexión:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Para una configuración totalmente sin supervisión, sáltate el aviso: ejecuta relayium id en el emisor para imprimir su huella, y luego relayium authorize <huella> en el receptor.",
        "--dir es el padre de la carpeta que sincronizas, no la carpeta en sí; de lo contrario los archivos llegan un nivel demasiado profundo (p. ej. /root/workspace/workspace).",
      ],
    },
    {
      heading: "Ejecutar el proceso a la escucha en segundo plano (en el receptor)",
      body: [
        "Una vez autorizada la huella, detén el serve en primer plano (Ctrl-C) y relánzalo desacoplado para que sobreviva a tu cierre de sesión. Carga la huella guardada y acepta al emisor en silencio: esta vez no hay aviso. La misma línea anota el PID del nuevo proceso en ~/relayium-serve.pid, y así es como el último paso de esta guía detiene el proceso a la escucha que lanzó, en vez de todo comando relayium de la máquina:",
      ],
      code: [
        `# en el RECEPTOR
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "Para una bandeja de entrada siempre activa, ejecútalo bajo systemd en su lugar (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Ejecutar sync en tmux en el emisor",
      body: [
        "Desde v0.28.4, un sync normal vuelve a conectarse hasta ocho veces tras una interrupción temporal y continúa el lote actual. Con --delete se desactiva la reconexión dentro del intento.",
        "Deja serve en marcha sin --once. Con v0.28.4 en ambos extremos, sync muestra el progreso de la verificación del receptor.",
      ],
      steps: [
        {
          text: "Abre una sesión tmux en el emisor.",
          code: [
            `# en el EMISOR
tmux new -s xfer      # apt install -y tmux si falta`,
          ],
        },
        {
          text: "Ejecuta sync una vez.",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "Pulsa Ctrl-b y después d para separar la sesión. Vuelve a conectarte para ver el resultado.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "Cómo se ve una pasada correcta",
        body: [
          "El progreso muestra el cálculo de huellas en el origen y los bytes enviados, incluso durante el envío de un solo archivo grande. El resumen cuenta los archivos enviados y omitidos.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Otra ejecución puede reutilizar un prefijo verificado. Un archivo interrumpido sin prefijo verificado vuelve a enviarse y los archivos completos verificados se omiten.",
        "El progreso muestra el cálculo de huellas en el origen y los bytes enviados, incluso durante el envío de un solo archivo grande. El resumen cuenta los archivos enviados y omitidos.",
      ],
    },
    {
      heading: "Verificar y terminar",
      body: [
        "Comprueba el resultado del receptor antes de detener la escucha.",
      ],
      steps: [
        {
          text: "Espera a que sync termine correctamente y confirme que no hay archivos fallidos.",
        },
        {
          text: "Compara los totales en los dos servidores.",
          code: [
            `# compara los totales en AMBOS servidores
du -sh /root/workspace`,
          ],
        },
        {
          text: "Detén el proceso a la escucha en el receptor cuando los totales coincidan. La señal va al PID que anotaste al lanzarlo, y no a todo comando relayium de la máquina por coincidencia de texto, y el archivo de PID se borra solo si esa señal tuvo éxito. Un archivo de PID que quedó de una ejecución anterior puede nombrar un PID que el sistema ya reutilizó, así que si no tienes la certeza de que siga siendo el tuyo, imprime primero la línea de comandos de ese PID y mátalo solo si aparece serve.",
          code: [
            `# en el RECEPTOR, una vez verificado
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "Cómo se ve un espejo terminado",
        body: [
          "Los totales de du -sh sirven como comprobación aproximada. Repite con --checksum para exigir la comparación SHA-256 de los archivos seleccionados.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Los receptores actuales omiten archivos con el mismo tamaño y SHA-256. Los antiguos pueden recurrir al tamaño y al mtime; --checksum exige comparar el contenido.",
      ],
    },
    {
      heading: "Resolución de problemas",
      body: [
        "En un espejo de varias horas aparecen seis cosas. Tres parecen fallos y no lo son; las otras tres sí, y cada una tiene un comando que dice cuál tienes delante.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "Hace mucho que no se imprime nada y la transferencia parece atascada.",
            code: [
              `# en el EMISOR, dos veces, con unos segundos de diferencia
ss -tinp dst :9031
# ESTAB    se alcanzó el proceso a la escucha; no prueba que los bytes se muevan
# SYN-SENT no alcanza al proceso a la escucha`,
            ],
            fix: "ESTAB solo confirma que se pudo conectar. Mira el progreso de bytes o ejecuta ss -tinp dos veces y compara bytes_acked. Durante el cálculo local puede no haber conexión de transferencia.",
          },
          {
            symptom: "El socket se queda en SYN-SENT y la transferencia no arranca en absoluto.",
            code: [
              `# en el RECEPTOR
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "El puerto está bloqueado. Abre 9031/TCP solo al emisor — sustituye 203.0.113.9 por la dirección del propio emisor, su IP pública o la privada si los dos servidores comparten red — acota el grupo de seguridad en la nube a esa misma fuente y luego comprueba que serve está realmente a la escucha. Es la causa más frecuente de una transferencia que nunca empieza.",
          },
          {
            symptom: "Pegar el comando de segundo plano deja la shell en un prompt de continuación >.",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Abre tmux primero y pega el comando sync en una línea independiente.",
          },
          {
            symptom: "La limpieza mató algo que no querías matar.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Comprueba el PID con ps antes de enviar una señal. Detén solo la sesión tmux y la escucha que iniciaste para esta transferencia.",
          },
          {
            symptom: "Excluir una carpeta o un patrón a tu elección",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Repite --exclude por cada regla. Usa rutas relativas o patrones de nombre entre comillas. Tú eliges qué excluir; --exclude es incompatible con --delete.",
          },
          {
            symptom: "Una fuente que esperabas duplicar llega vacía.",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "sync solo transfiere archivos regulares, y ese aviso es exactamente el aspecto de un árbol hecho únicamente de enlaces simbólicos. Apunta sync a los directorios a los que apuntan los enlaces, y crea aparte en el receptor los enlaces que necesites.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Qué pasa si la transferencia se interrumpe a mitad de camino?",
        a: "Otra ejecución puede reutilizar un prefijo verificado. Un archivo interrumpido sin prefijo verificado vuelve a enviarse y los archivos completos verificados se omiten.",
      },
      {
        q: "¿En qué se diferencia esto de rsync?",
        a: "Los receptores actuales omiten archivos con el mismo tamaño y SHA-256. Los antiguos pueden recurrir al tamaño y al mtime; --checksum exige comparar el contenido.",
      },
      {
        q: "¿sync elimina en el receptor los archivos que quité del origen?",
        a: "Solo si lo pides. Por defecto sync solo añade y actualiza. Pasa --delete para replicar las eliminaciones, y el receptor debe ejecutar serve con --allow-delete para que se respeten; de lo contrario la eliminación se ignora y se informa de vuelta.",
      },
      {
        q: "¿Puedo mantener dos carpetas sincronizadas de forma continua?",
        a: "Añade --watch para sincronizar cuando cambien los archivos de origen. Para una copia puntual, ejecuta sync una vez.",
      },
      {
        q: "¿Tengo que abrir un puerto?",
        a: "Sí: el puerto del proceso a la escucha (9031 por defecto) debe ser alcanzable desde el emisor. El sync actual solo acepta destinos relayium://; el sync por SSH está retirado. Si no puedes exponer un proceso a la escucha, usa otra vía de transferencia en lugar de un destino SSH.",
      },
    ],
  },
  cta: {
    text: "Replica una carpeta entre dos de tus propios servidores: incremental, reanudable, sin tener que vigilar.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Sincronizar uma pasta grande entre dois servidores (retomável, em segundo plano)",
  description:
    "Sincronize uma pasta grande entre dois servidores com relayium sync. Ele pode reconectar após uma interrupção temporária e reutilizar dados verificados.",
  updatedLabel: "Última atualização",
  lead: [
    "Use v0.28.4 ou posterior nas duas pontas. Um comando divide a seleção automaticamente em lotes de até 100,000 arquivos regulares e 32 MiB de índice de diretórios. Receptores atuais ignoram arquivos de mesmo tamanho e SHA-256. Os antigos podem usar tamanho e mtime; --checksum exige a comparação do conteúdo. Outra execução pode reutilizar um prefixo verificado. Um arquivo interrompido sem prefixo verificado é reenviado; arquivos completos e verificados são ignorados.",
    "Autorize o emissor uma vez e mantenha o receptor em execução. Use tmux para que sync continue após encerrar a sessão.",
  ],
  sections: [
    {
      heading: "Por que relayium sync se encaixa nesta tarefa",
      body: [
        "sync é um espelho incremental unidirecional sobre o protocolo nativo (instale relayium nas duas pontas). Três propriedades o tornam seguro para executar e reexecutar sem supervisão:",
      ],
      bullets: [
        "Receptores atuais ignoram arquivos de mesmo tamanho e SHA-256. Os antigos podem usar tamanho e mtime; --checksum exige a comparação do conteúdo.",
        "Outra execução pode reutilizar um prefixo verificado. Um arquivo interrompido sem prefixo verificado é reenviado; arquivos completos e verificados são ignorados.",
        "Os totais de du -sh são uma conferência aproximada. Execute novamente com --checksum para exigir a comparação SHA-256 dos arquivos selecionados.",
      ],
    },
    {
      heading: "Pré-requisitos",
      body: [
        "Use v0.28.4 ou posterior nas duas pontas. Um comando divide a seleção automaticamente em lotes de até 100,000 arquivos regulares e 32 MiB de índice de diretórios. Para vários lotes, execute relayium serve sem --once. A sincronização em vários lotes rejeita --delete. Para verificar primeiro, omita --once e use sync --check, que testa a conexão e a autorização sem enviar dados de arquivos. Para sincronização contínua, mantenha o receptor em execução e use --watch no remetente.",
      ],
      code: [
        `# nos DOIS servidores
curl -fsSL https://relayium.com/install.sh | sh`,
      ],
      prereqs: {
        label: "O que você precisa",
        items: [
          "Este guia usa daemon direto (relayium://), então os dois servidores não precisam de acesso SSH entre si.",
          "Abra a porta do processo à escuta (9031 por padrão) para o emissor no firewall ou grupo de segurança do receptor.",
          "Espaço para a pasta inteira no receptor. Compare du -sh /root/workspace no emissor com df -h /root no receptor antes de iniciar uma transferência de várias horas.",
        ],
      },
    },
    {
      heading: "Autorizar o emissor uma vez (no receptor)",
      body: [
        "O receptor aprova a máquina emissora uma vez; a aprovação é escrita em disco e permanece válida entre reinicializações, então você nunca a repete. Inicie o processo à escuta em um terminal e aponte --dir para o diretório pai — relayium sync /root/workspace reproduz workspace/... no receptor, então --dir /root deposita os arquivos em /root/workspace/.",
        "Na primeira conexão do emissor (próxima seção), serve mostra seu endereço e sua impressão digital e pede que você o aprove; responda y e ele é lembrado para sempre:",
      ],
      code: [
        `# no RECEPTOR (em primeiro plano, para aprovar interativamente)
relayium serve --dir /root --port 9031`,
        `# no RECEPTOR, na primeira conexão:
Incoming push from 203.0.113.9:52140
  fingerprint: 9f2c41ab…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Para uma configuração totalmente sem supervisão, pule o prompt: execute relayium id no emissor para imprimir sua impressão digital, e então relayium authorize <impressão digital> no receptor.",
        "--dir é o pai da pasta que você está sincronizando, não a pasta em si — caso contrário os arquivos caem um nível fundo demais (por exemplo /root/workspace/workspace).",
      ],
    },
    {
      heading: "Executar o processo à escuta em segundo plano (no receptor)",
      body: [
        "Uma vez autorizada a impressão digital, pare o serve em primeiro plano (Ctrl-C) e relance-o desacoplado para que sobreviva ao seu logout. Ele carrega a impressão digital salva e aceita o emissor em silêncio — sem prompt desta vez. A mesma linha registra o PID do novo processo em ~/relayium-serve.pid, e é assim que o último passo deste guia para o processo à escuta que ele mesmo lançou, em vez de todo comando relayium da máquina:",
      ],
      code: [
        `# no RECEPTOR
nohup relayium serve --dir /root --port 9031 > ~/relayium-serve.log 2>&1 & echo $! > ~/relayium-serve.pid`,
      ],
      bullets: [
        "Para uma caixa de entrada sempre ativa, execute-o sob systemd em vez disso (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Executar sync em tmux no emissor",
      body: [
        "A partir da v0.28.4, um sync comum reconecta até oito vezes após uma interrupção temporária e retoma o lote atual. Com --delete, a reconexão fica desativada dentro da tentativa.",
        "Mantenha serve em execução sem --once. Com a v0.28.4 nas duas pontas, sync mostra o progresso da verificação do receptor.",
      ],
      steps: [
        {
          text: "Abra uma sessão tmux no emissor.",
          code: [
            `# no EMISSOR
tmux new -s xfer      # apt install -y tmux se estiver faltando`,
          ],
        },
        {
          text: "Execute sync uma vez.",
          code: [
            `relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
          ],
        },
        {
          text: "Use Ctrl-b e depois d para desconectar a sessão. Volte a ela para ver o resultado.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "Como é uma passada bem-sucedida",
        body: [
          "O progresso mostra os hashes na origem e os bytes enviados, inclusive durante o envio de um único arquivo grande. O resumo conta arquivos enviados e ignorados.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  Sending 1.0 GiB / 1.0 GiB · 1/1 files · workspace/data/part-004.bin
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Outra execução pode reutilizar um prefixo verificado. Um arquivo interrompido sem prefixo verificado é reenviado; arquivos completos e verificados são ignorados.",
        "O progresso mostra os hashes na origem e os bytes enviados, inclusive durante o envio de um único arquivo grande. O resumo conta arquivos enviados e ignorados.",
      ],
    },
    {
      heading: "Verificar e finalizar",
      body: [
        "Confira o resultado do receptor antes de parar o processo à escuta.",
      ],
      steps: [
        {
          text: "Aguarde sync terminar com sucesso e confirmar zero falhas de arquivo.",
        },
        {
          text: "Compare os totais nos dois servidores.",
          code: [
            `# compare os totais nos DOIS servidores
du -sh /root/workspace`,
          ],
        },
        {
          text: "Pare o processo à escuta no receptor quando os totais baterem. O sinal vai para o PID que você registrou ao lançá-lo, e não para todo comando relayium da máquina por correspondência de texto, e o arquivo de PID só é removido se aquele sinal deu certo. Um arquivo de PID deixado por uma execução anterior pode nomear um PID que o sistema já reutilizou, então, se você não tem certeza de que ele ainda é seu, imprima primeiro a linha de comando desse PID e só o mate se serve aparecer.",
          code: [
            `# no RECEPTOR, depois de verificado
ps -p "$(cat ~/relayium-serve.pid)" -o command=
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
          ],
        },
      ],
      success: {
        label: "Como é um espelho concluído",
        body: [
          "Os totais de du -sh são uma conferência aproximada. Execute novamente com --checksum para exigir a comparação SHA-256 dos arquivos selecionados.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Receptores atuais ignoram arquivos de mesmo tamanho e SHA-256. Os antigos podem usar tamanho e mtime; --checksum exige a comparação do conteúdo.",
      ],
    },
    {
      heading: "Solução de problemas",
      body: [
        "Num espelho de várias horas seis coisas aparecem. Três parecem falhas e não são; as outras três são de verdade, e cada uma tem um comando que diz qual delas você está vendo.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "Faz muito tempo que nada é impresso e a transferência parece travada.",
            code: [
              `# no EMISSOR, duas vezes, com alguns segundos de intervalo
ss -tinp dst :9031
# ESTAB    o processo à escuta foi alcançado; não prova que bytes estejam se movendo
# SYN-SENT não alcança o processo à escuta`,
            ],
            fix: "ESTAB só confirma a conexão. Veja o progresso de bytes ou execute ss -tinp duas vezes e compare bytes_acked. O cálculo local de hashes pode ocorrer antes da conexão de transferência.",
          },
          {
            symptom: "O socket fica em SYN-SENT e a transferência nunca começa.",
            code: [
              `# no RECEPTOR
sudo ufw allow from 203.0.113.9 to any port 9031 proto tcp
ss -tlnp | grep 9031`,
            ],
            fix: "A porta está bloqueada. Abra 9031/TCP somente para o emissor — substitua 203.0.113.9 pelo endereço do próprio emissor, o IP público ou o privado se os dois servidores compartilham uma rede — restrinja o grupo de segurança da nuvem à mesma origem e então confirme que o serve está mesmo escutando. Essa é a causa mais comum de uma transferência que nunca começa.",
          },
          {
            symptom: "Colar o comando de segundo plano deixa o shell num prompt de continuação >.",
            code: [
              `tmux new -s xfer
relayium sync --checksum /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Abra tmux primeiro e cole o comando sync em uma linha separada.",
          },
          {
            symptom: "A limpeza matou algo que você não queria matar.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Confira o PID com ps antes de enviar um sinal. Encerre apenas a sessão tmux e o processo à escuta que iniciou para esta transferência.",
          },
          {
            symptom: "Excluir uma pasta ou um padrão que você escolheu",
            code: [
              `relayium sync --exclude 'example-cache/' /root/workspace relayium://203.0.113.43:9031`,
            ],
            fix: "Repita --exclude para cada regra. Use caminhos relativos ou padrões de nomes entre aspas. Você escolhe as exclusões; --exclude é incompatível com --delete.",
          },
          {
            symptom: "Uma origem que você esperava espelhar chega vazia.",
            code: [
              `relayium sync ./links relayium://203.0.113.43:9031
# warning: no regular files to send (symlinks and special files are skipped)`,
            ],
            fix: "O sync só transfere arquivos regulares, e esse aviso é exatamente a cara de uma árvore feita só de links simbólicos. Aponte o sync para os diretórios a que os links se referem, e crie à parte no receptor os links de que você precisa.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O que acontece se a transferência for interrompida no meio do caminho?",
        a: "Outra execução pode reutilizar um prefixo verificado. Um arquivo interrompido sem prefixo verificado é reenviado; arquivos completos e verificados são ignorados.",
      },
      {
        q: "Em que isso difere do rsync?",
        a: "Receptores atuais ignoram arquivos de mesmo tamanho e SHA-256. Os antigos podem usar tamanho e mtime; --checksum exige a comparação do conteúdo.",
      },
      {
        q: "O sync apaga no receptor os arquivos que removi da origem?",
        a: "Só se você pedir. Por padrão sync apenas adiciona e atualiza. Passe --delete para espelhar as exclusões, e o receptor precisa executar serve com --allow-delete para que sejam respeitadas — caso contrário a exclusão é ignorada e reportada de volta.",
      },
      {
        q: "Posso manter duas pastas sincronizadas continuamente?",
        a: "Adicione --watch para sincronizar quando a origem mudar. Para uma cópia única, execute sync uma vez.",
      },
      {
        q: "Preciso abrir uma porta?",
        a: "Sim — a porta do processo à escuta (9031 por padrão) precisa ser alcançável a partir do emissor. O sync atual só aceita destinos relayium://; o sync por SSH foi descontinuado. Se você não puder expor um processo à escuta, use outro caminho de transferência em vez de um destino SSH.",
      },
    ],
  },
  cta: {
    text: "Espelhe uma pasta entre dois dos seus próprios servidores — incremental, retomável, sem precisar vigiar.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/sync-a-large-folder-between-servers",
  published: "2026-07-08",
  updated: "2026-11-27",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
