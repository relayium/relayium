// web/scripts/pages/content/articles/cli-sync-large-folder.mjs
// How-to: sync a large folder between two servers with relayium sync —
// incremental, resumable, run unattended in the background via a retry loop + tmux.
// English is the master; every other locale follows the same structure and facts.
// Commands stay English in every language; the # comments around them are translated.

const en = {
  title: "Sync a large folder between two servers (resumable, in the background)",
  description:
    "Mirror a big directory from one server to another with relayium sync — incremental, resumable after a dropped connection, and safe to run unattended. A retry loop under tmux moves gigabytes without babysitting a terminal.",
  updatedLabel: "Last updated",
  lead: [
    "You have a large folder — tens of gigabytes — on one server and you want an exact copy on another. You can't watch a terminal for hours, and a transfer that dies halfway shouldn't start over from zero. relayium sync is built for this: a one-way incremental mirror that skips what's already there, resumes a half-sent file from where it stopped, and verifies every file it sends, end to end.",
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
        "Verifies what it sends: every file it transfers — a resumed one included — is checked end to end against the sender's SHA-256, and a mismatch is reported as a failure. Files it skips are matched on size and mtime and never re-hashed, so sync says nothing about the contents it did not send.",
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
      steps: [
        {
          text: "Start a tmux session on the sender, so the loop outlives the ssh session you started it from.",
          code: [
            `# on the SENDER
tmux new -s xfer      # apt install -y tmux if it's missing`,
          ],
        },
        {
          text: "Run the mirror inside an until loop. It retries every 10 seconds until sync returns success, then exits on its own.",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "Detach with Ctrl-b then d. The loop keeps running; reattach whenever you want to watch it.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "What a successful pass looks like",
        body: [
          "Each pass prints one line per file it actually sent, then a summary counting what it sent against what the receiver already had. The loop ends the first time sync returns success, and that summary is the state of the mirror.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Each retry does less: already-transferred files are skipped, a half-sent file resumes — so the loop converges and finishes.",
        "Progress prints one line per completed file, so a big file transfers quietly until it's done. Silence isn't a stall (see troubleshooting).",
      ],
    },
    {
      heading: "Verify and finish",
      body: [
        "The transfer is complete when the until loop ends and you're back at a normal shell prompt. Confirm both sides match, then stop the listener:",
      ],
      steps: [
        {
          text: "Wait for the until loop to exit on its own. Being back at an ordinary shell prompt is the transfer finishing, not you interrupting it.",
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
          "du -sh reports the same total on both servers, and the until loop has returned you to an ordinary shell prompt rather than retrying again. Matching totals are a coarse completeness check, not proof of integrity: sync decided by size and mtime which files not to send, so the totals say nothing about the contents of the files it skipped.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "What sync sent was verified: every file it transferred was SHA-256 checked on arrival, and a clean exit means none of those checks failed. What it skipped was matched on size and mtime only, so equal du -sh totals are a sanity check on completeness rather than proof that the skipped contents still match. Compare per-file checksums on both servers if you need that proof.",
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
            fix: "Progress prints only when a file finishes, so one large file transfers in complete silence. ESTAB proves reachability only — an established socket can sit idle or stall — so it is never on its own evidence of forward progress. Run the check twice a few seconds apart and compare the bytes_acked counter that -i prints for that socket: a rising count is a transfer that is moving, an unchanged one is a real stall.",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "A multi-line nohup command with quotes and a > redirect usually breaks on the redirect when pasted. Use tmux plus this single-line loop instead: there is no redirection to get wrong, and you can reattach to watch it.",
          },
          {
            symptom: "Cleaning up killed something you did not mean to kill.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Killing by command-line pattern signals every process whose command line contains that text, which on a machine running more than one transfer is not the one you meant. It also does not stop the mirror: the until loop owns the sync, so a killed child is simply started again ten seconds later. Look with pgrep -af, then end the things this guide actually owns — tmux kill-session -t xfer ends the loop, and kill on the PID in ~/relayium-serve.pid ends the listener you launched. Print that PID's command line before you signal it if the file has been sitting there since an earlier run: a PID the system has reused belongs to something else entirely.",
          },
          {
            symptom: "You want to leave one subdirectory out and there is no exclude flag.",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "sync takes -i and -p, --delete, --watch and --config-dir — nothing that filters a path out mid-tree. Name the subdirectories you do want instead: each source arrives under the receiver's --dir by its own name, so against serve --dir /root/workspace this rebuilds /root/workspace/src and /root/workspace/data and never walks a regenerable venv.",
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
        a: "Nothing is lost. Rerun relayium sync — it skips files already on the receiver and resumes a half-sent file from the byte offset already on disk. The until loop in this guide does that automatically until the whole folder is mirrored.",
      },
      {
        q: "How is this different from rsync?",
        a: "Both do incremental one-way mirroring, but relayium sync runs over a pinned TLS connection with no SSH account required (daemon direct), authenticates the two machines by certificate fingerprint, and SHA-256 verifies every file it transfers. Like rsync's default, a file whose size and mtime already match on the receiver is skipped rather than re-hashed. It's the same transfer engine as relayium's other modes.",
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
    "你在一台服务器上有一个很大的文件夹——几十 GB——想在另一台上得到一份完整副本。你没法盯着终端好几个小时，而且传到一半断掉的传输不应该从头再来。relayium sync 正是为此而生：一个单向增量镜像，跳过已经存在的文件，把传了一半的文件从中断处续传，并对它发送的每个文件做端到端校验。",
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
        "校验它发送的内容：它传输的每个文件——包括续传的那些——都会按发送端的 SHA-256 做端到端校验，对不上就报为失败。被跳过的文件只按大小和 mtime 判定，不会重新计算哈希，所以 sync 对它没有发送的内容不作任何保证。",
        "正因如此，这条命令是幂等的——再跑一次只做剩下的活，这正是重试循环能完成一次超大传输的关键。",
      ],
    },
    {
      heading: "前提条件",
      body: [
        "两端服务器都要装 relayium（sync 走原生协议，因此每一端都必须有）：",
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
      steps: [
        {
          text: "在发送方开一个 tmux 会话，好让循环活得比你启动它的那次 ssh 更久。",
          code: [
            `# 在发送方
tmux new -s xfer      # 没有 tmux 就 apt install -y tmux`,
          ],
        },
        {
          text: "把镜像放进一个 until 循环里跑。它每 10 秒重试一次，直到 sync 返回成功，然后自己退出。",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "按 Ctrl-b 再按 d 脱离。循环照跑不误；想看的时候随时重新接入。",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "一次成功的传输是什么样",
        body: [
          "每一趟都会为它真正发出去的每个文件打印一行，然后打印一行汇总：这次发了多少，接收方已经有多少。循环会在 sync 第一次返回成功时结束，而那行汇总就是镜像的状态。",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "每次重试做的活都更少：已传完的文件被跳过，传了一半的文件续传——所以循环会收敛并结束。",
        "进度是每传完一个文件打印一行，因此一个大文件会安静地传到完成为止。没有输出不代表卡住（见排错）。",
      ],
    },
    {
      heading: "验证与收尾",
      body: [
        "当 until 循环结束、你回到普通的 shell 提示符时，传输就完成了。确认两边一致，然后停掉监听端：",
      ],
      steps: [
        {
          text: "等 until 循环自己退出。回到普通的 shell 提示符，说明的是传输结束了，而不是你把它打断了。",
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
          "两台服务器上的 du -sh 报出同一个总量，而且 until 循环已经把你送回普通的 shell 提示符，而不是又在重试。总量一致只是一次粗略的完整性核对，并不能证明内容无误：sync 是按大小和 mtime 决定哪些文件不发送的，所以总量说明不了被跳过文件的内容。",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "sync 发送过的内容是校验过的：它传输的每个文件在到达时都做过 SHA-256 校验，干净退出意味着没有一项校验失败。被跳过的部分只比对了大小和 mtime，所以 du -sh 总量一致只是对完整性的一次粗略核对，并不能证明被跳过文件的内容仍然一致。需要这种证明，就在两台服务器上逐个文件比对校验和。",
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
            fix: "进度只在一个文件传完时才打印，所以一个大文件会在完全的安静中传输。ESTAB 只能证明够得着——一条已建立的连接照样可以闲着或者卡住——它本身永远不能证明还在往前走。隔几秒把这条检查跑两次，比较 -i 为该套接字打印的 bytes_acked 计数：数字在涨就是真的在传，一直不变才是真卡住。",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "带引号和 > 重定向的多行 nohup 命令，粘贴时通常会在重定向那里断掉。改用 tmux 加这条单行循环：没有重定向可写错，而且随时能重新接入观察。",
          },
          {
            symptom: "清理进程时误杀了不该杀的东西。",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "按命令行模式去杀，会对所有命令行里含这段文字的进程都发信号；机器上同时跑着不止一个传输时，杀掉的就不是你想杀的那个。而且它也停不下镜像：sync 是 until 循环的子进程，杀掉之后循环十秒后又拉起一个。先用 pgrep -af 看清楚，再去结束本指南真正拥有的东西——tmux kill-session -t xfer 结束那个循环，对 ~/relayium-serve.pid 里的 PID 执行 kill 结束你启动的监听端。如果那个 PID 文件是上一次运行留下的，先把它的命令行打出来再发信号：被系统重新分配出去的 PID，属于完全不相干的另一个进程。",
          },
          {
            symptom: "你想排除某个子目录，但没有 exclude 参数。",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "sync 支持 -i 和 -p、--delete、--watch 和 --config-dir——没有任何能在树中间过滤掉某个路径的开关。改成直接点名你真正想要的子目录：每个源都会按自己的名字落在接收方的 --dir 下面，所以配合 serve --dir /root/workspace，这条命令会重建 /root/workspace/src 和 /root/workspace/data，而那个可以重新生成的 venv 根本不会被遍历。",
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
        a: "什么都不会丢。重新运行 relayium sync——它会跳过接收方已有的文件，并把传了一半的文件从磁盘上已有的字节偏移续传。本指南里的 until 循环会自动做这件事，直到整个文件夹镜像完成。",
      },
      {
        q: "这和 rsync 有什么不同？",
        a: "两者都做增量单向镜像，但 relayium sync 走证书固定的 TLS 连接、不需要 SSH 账号（daemon 直连），通过证书指纹互相认证两台机器，并对它传输的每个文件做 SHA-256 校验。和 rsync 的默认行为一样，接收端上大小和 mtime 已经一致的文件会被跳过，而不是重新计算哈希。它和 relayium 其他模式用的是同一个传输引擎。",
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
        a: "用 daemon 直连的话，是的——监听端口（默认 9031）必须能从发送方访问到。如果你不想开端口、而且两台服务器之间已经有 SSH，sync 也可以走 SSH：relayium sync /path user@host:/path（远端必须装了 relayium）。",
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
    "relayium sync で大きなディレクトリを一方のサーバーからもう一方へミラーリング。増分転送、接続が切れても再開可能、無人での実行も安全です。tmux 内のリトライループで、ターミナルに張り付かずに数十 GB を運べます。",
  updatedLabel: "最終更新",
  lead: [
    "一方のサーバーに大きなフォルダー（数十 GB）があり、それをもう一方に完全な複製として欲しいとします。何時間もターミナルを見張ることはできませんし、途中で落ちた転送が最初からやり直しになるのも困ります。relayium sync はまさにこのために作られています。一方向の増分ミラーで、すでにあるものはスキップし、途中まで送ったファイルは止まったところから再開し、送信した各ファイルを端から端まで検証します。",
    "本ガイドでは、無人で自己修復する転送を構築します。送信側を一度だけ承認し、リスナーをバックグラウンドで動かし、tmux 内のリトライループで relayium sync を回して、接続が切れても続行させ、フォルダー全体が届くまで走らせます。",
  ],
  sections: [
    {
      heading: "なぜ relayium sync がこの用途に向くのか",
      body: [
        "sync はネイティブプロトコル上の一方向増分ミラーです（両端に relayium をインストールします）。無人で繰り返し実行しても安全な理由が3つあります：",
      ],
      bullets: [
        "すでにあるファイルはスキップ：受信側のコピーがサイズと更新時刻で一致するファイルは再送しません。",
        "途中のファイルを再開：接続が切れたとき半分だけ送られていたファイルは、次回の実行でディスク上にすでにあるバイトオフセットから続行し、やり直しません。",
        "送るものを検証：転送する各ファイルは（再開したものも含めて）送信側の SHA-256 と端から端まで照合され、一致しなければ失敗として報告されます。スキップするファイルはサイズと mtime で判定するだけでハッシュを取り直さないため、送らなかった内容について sync は何も保証しません。",
        "これらのおかげでコマンドは冪等です。もう一度実行しても残りの作業だけを行います。これこそがリトライループで巨大な転送を完了させる要点です。",
      ],
    },
    {
      heading: "前提条件",
      body: [
        "両方のサーバーに relayium をインストールします（sync はネイティブプロトコルを話すため、各端に必要です）：",
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
        "serve は接続を1つずつ処理して動き続けるため、下のリトライループの再接続のたびに受信の準備ができています。",
        "常時稼働の受信箱にするなら、代わりに systemd で動かします（Restart=always、--config-dir /etc/relayium）。",
      ],
    },
    {
      heading: "tmux 内のリトライループで sync を回す（送信側）",
      body: [
        "長い転送は中断されます。セッション切断、不安定なネットワーク、再起動。解決策は高級なツールではなく、sync を成功するまで再実行するループと、ログアウト後も生き残らせる端末マルチプレクサです。ここでは tmux のほうが nohup より扱いやすいです：間違えやすい出力リダイレクトがなく、再接続して進捗を見られます。",
        "tmux セッションを開始し、until ループでミラーを実行します。10秒ごとに再試行し、sync が成功を返したら自分で終了します：",
      ],
      steps: [
        {
          text: "ループを起動元の ssh セッションより長生きさせるため、送信側で tmux セッションを開きます。",
          code: [
            `# 送信側で
tmux new -s xfer      # tmux が無ければ apt install -y tmux`,
          ],
        },
        {
          text: "until ループの中でミラーを回します。10秒ごとに再試行し、sync が成功を返したところで自分から終了します。",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "Ctrl-b の次に d でデタッチします。ループはそのまま動き続けるので、見たくなったらいつでも再接続してください。",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "成功した一巡の表示",
        body: [
          "一巡ごとに、実際に送ったファイルの数だけ行が表示され、続いて今回送った数と受信側にすでにあった数の要約が出ます。ループは sync が最初に成功を返した時点で終わり、その要約がミラーの状態です。",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "再試行のたびに作業は減ります：転送済みのファイルはスキップされ、半分送ったファイルは再開されます。だからループは収束して終わります。",
        "進捗はファイルが1つ完了するごとに1行表示されるので、大きなファイルは完了まで静かに転送されます。無音は停止ではありません（トラブルシューティング参照）。",
      ],
    },
    {
      heading: "検証と仕上げ",
      body: [
        "until ループが終わり、通常のシェルプロンプトに戻ったら転送は完了です。両側が一致することを確認してから、リスナーを停止します：",
      ],
      steps: [
        {
          text: "until ループが自分から終わるのを待ちます。通常のシェルプロンプトに戻っているのは、転送が終わったということであって、途中で中断されたということではありません。",
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
          "両方のサーバーで du -sh が同じ合計を報告し、until ループは再試行に戻らず、通常のシェルプロンプトへ戻っています。合計の一致は大まかな完了確認であって、内容が同一であることの証明ではありません。sync はサイズと mtime でどのファイルを送らないかを決めているため、スキップしたファイルの中身について合計は何も語りません。",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "sync が送ったものは検証済みです。転送した各ファイルは到着時に SHA-256 で検査され、クリーンな終了はその検査が一つも失敗しなかったことを意味します。スキップした分はサイズと mtime を照合しただけなので、du -sh の合計が一致することは完了の目安であって、スキップしたファイルの中身が今も同じだという証明ではありません。その証明が要るなら、両方のサーバーでファイルごとのチェックサムを突き合わせてください。",
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
            fix: "進捗はファイルが1つ完了したときにしか表示されないので、大きなファイル1つはまったくの無音で転送されます。ESTAB が示すのは到達できたことだけで、確立済みのソケットが無通信のまま止まっていることもあり、それだけでは前進の証拠になりません。このチェックを数秒あけて2回実行し、-i がそのソケットについて表示する bytes_acked カウンターを比べてください。増えていれば転送は動いており、変わらなければ本当に止まっています。",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "引用符と > リダイレクトを含む複数行の nohup コマンドは、貼り付け時にリダイレクトのところで壊れがちです。代わりに tmux とこの1行ループを使ってください。書き間違えるリダイレクトが無く、再接続して様子も見られます。",
          },
          {
            symptom: "後片付けのつもりが、殺すつもりのないものまで殺してしまった。",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "コマンドラインのパターンで殺すやり方は、その文字列を含むプロセスすべてにシグナルを送るので、転送が複数動いているマシンでは狙った相手とは限りません。しかもミラーは止まりません。sync を所有しているのは until ループなので、子プロセスを殺しても10秒後にまた起動されます。まず pgrep -af で確認し、このガイドが実際に所有しているものを終わらせてください。tmux kill-session -t xfer でループを終了し、~/relayium-serve.pid にある PID を kill して、自分で起動したリスナーを止めます。その PID ファイルが前回の実行から残っているなら、シグナルを送る前にコマンドラインを表示してください。システムが再利用した PID は、まったく別のプロセスのものです。",
          },
          {
            symptom: "あるサブディレクトリだけ除きたいのに、exclude のフラグが無い。",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "sync が取るのは -i と -p、--delete、--watch、--config-dir だけで、木の途中でパスを除外する仕組みはありません。代わりに欲しいサブディレクトリを列挙してください。各ソースは受信側の --dir の下に自分の名前で届くので、serve --dir /root/workspace に対してこのコマンドを実行すると /root/workspace/src と /root/workspace/data が再現され、作り直せる venv は一度も走査されません。",
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
        a: "何も失われません。relayium sync を再実行してください。受信側にすでにあるファイルはスキップし、半分送ったファイルはディスク上のバイトオフセットから再開します。本ガイドの until ループが、フォルダー全体がミラーされるまでこれを自動で行います。",
      },
      {
        q: "これは rsync と何が違いますか？",
        a: "どちらも増分の一方向ミラーですが、relayium sync は証明書ピンニング付き TLS 接続で動作し、SSH アカウントを必要とせず（デーモン直結）、証明書のフィンガープリントで2台を認証し、転送する各ファイルを SHA-256 で検証します。rsync の既定と同じく、受信側でサイズと mtime がすでに一致するファイルはハッシュを取り直さずスキップされます。relayium の他モードと同じ転送エンジンです。",
      },
      {
        q: "ソースから削除したファイルを、sync は受信側でも削除しますか？",
        a: "求めたときだけです。既定では sync は追加と更新だけを行います。削除をミラーするには --delete を渡し、それが有効になるには受信側が --allow-delete で serve を実行している必要があります。さもなければ削除は無視され、報告されます。",
      },
      {
        q: "2つのフォルダーを継続的に同期し続けられますか？",
        a: "はい。--watch を付けると sync は動き続け、ソース配下の変更のたびに再ミラーします。大きなフォルダーの一度きりの移動には不要です。リトライループと素の sync で十分です。",
      },
      {
        q: "ポートを開ける必要がありますか？",
        a: "デーモン直結ならはい。リスナーのポート（既定 9031）が送信側から到達可能である必要があります。ポートを開けたくなく、サーバー間にすでに SSH があるなら、sync は SSH 経由でも動きます：relayium sync /path user@host:/path（リモートに relayium が必要）。",
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
    "relayium sync로 큰 디렉터리를 한 서버에서 다른 서버로 미러링하세요. 증분 전송, 연결이 끊겨도 재개 가능, 무인 실행도 안전합니다. tmux 안의 재시도 루프로 터미널에 붙어 있지 않고도 수십 GB를 옮길 수 있습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "한 서버에 큰 폴더(수십 GB)가 있고, 다른 서버에 똑같은 복사본을 원한다고 합시다. 몇 시간 동안 터미널을 지켜볼 수도 없고, 도중에 죽은 전송이 처음부터 다시 시작되어서도 안 됩니다. relayium sync는 바로 이를 위해 만들어졌습니다. 이미 있는 것은 건너뛰고, 절반만 보낸 파일은 멈춘 지점부터 재개하며, 보낸 파일을 끝에서 끝까지 검증하는 단방향 증분 미러입니다.",
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
        "보내는 것을 검증: 전송하는 각 파일은 — 이어받은 파일도 포함해 — 송신 측의 SHA-256과 끝에서 끝까지 대조되고, 어긋나면 실패로 보고됩니다. 건너뛰는 파일은 크기와 mtime으로만 판정하며 해시를 다시 계산하지 않으므로, 보내지 않은 내용에 대해 sync는 아무것도 보장하지 않습니다.",
        "이 덕분에 명령은 멱등적입니다. 다시 실행해도 남은 일만 합니다. 이것이 바로 재시도 루프가 거대한 전송을 끝낼 수 있게 하는 핵심입니다.",
      ],
    },
    {
      heading: "사전 준비",
      body: [
        "양쪽 서버에 relayium을 설치하세요(sync는 네이티브 프로토콜을 쓰므로 각 끝에 필요합니다):",
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
        "serve는 연결을 하나씩 처리하며 계속 실행되므로, 아래 재시도 루프의 매 재연결마다 받을 준비가 되어 있습니다.",
        "항상 켜져 있는 수신함을 원하면 대신 systemd로 돌리세요(Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "tmux 안의 재시도 루프로 sync 돌리기(보내는 쪽)",
      body: [
        "긴 전송은 중단됩니다. 세션 끊김, 불안정한 네트워크, 재부팅. 해결책은 멋진 도구가 아니라 sync를 성공할 때까지 다시 실행하는 루프와, 로그아웃 후에도 살아남게 하는 터미널 멀티플렉서입니다. 여기서는 tmux가 nohup보다 깔끔합니다: 틀리기 쉬운 출력 리다이렉트가 없고, 다시 붙어 진행 상황을 볼 수 있습니다.",
        "tmux 세션을 시작한 뒤 until 루프로 미러를 실행하세요. 10초마다 재시도하고 sync가 성공을 반환하면 스스로 종료합니다:",
      ],
      steps: [
        {
          text: "루프가 그것을 시작한 ssh 세션보다 오래 살도록, 보내는 쪽에서 tmux 세션을 엽니다.",
          code: [
            `# 보내는 쪽에서
tmux new -s xfer      # tmux가 없으면 apt install -y tmux`,
          ],
        },
        {
          text: "until 루프 안에서 미러를 돌립니다. 10초마다 재시도하다가 sync가 성공을 반환하면 스스로 끝납니다.",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "Ctrl-b 다음 d로 분리합니다. 루프는 계속 돌고, 보고 싶을 때 언제든 다시 붙으면 됩니다.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "한 번의 성공적인 패스는 어떻게 보이나",
        body: [
          "한 번 돌 때마다 실제로 보낸 파일마다 한 줄이 찍히고, 이어서 이번에 보낸 수와 받는 쪽이 이미 갖고 있던 수를 세는 요약이 나옵니다. 루프는 sync가 처음으로 성공을 반환할 때 끝나며, 그 요약이 곧 미러의 상태입니다.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "재시도할 때마다 일이 줄어듭니다: 이미 전송된 파일은 건너뛰고, 절반 보낸 파일은 재개됩니다. 그래서 루프는 수렴하고 끝납니다.",
        "진행 상황은 파일 하나가 완료될 때마다 한 줄씩 출력되므로, 큰 파일은 끝날 때까지 조용히 전송됩니다. 침묵은 멈춤이 아닙니다(문제 해결 참고).",
      ],
    },
    {
      heading: "검증과 마무리",
      body: [
        "until 루프가 끝나고 평범한 셸 프롬프트로 돌아오면 전송이 완료된 것입니다. 양쪽이 일치하는지 확인한 뒤 리스너를 멈추세요:",
      ],
      steps: [
        {
          text: "until 루프가 스스로 끝날 때까지 기다리세요. 평범한 셸 프롬프트로 돌아와 있다는 것은 전송이 끝났다는 뜻이지, 여러분이 중단했다는 뜻이 아닙니다.",
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
          "두 서버에서 du -sh 가 같은 총량을 보고하고, until 루프는 다시 재시도하는 대신 평범한 셸 프롬프트로 돌아와 있습니다. 총량이 같다는 것은 대략적인 완료 확인일 뿐, 내용이 같다는 증명은 아닙니다. sync는 크기와 mtime으로 어떤 파일을 보내지 않을지 결정하므로, 건너뛴 파일의 내용에 대해서는 총량이 아무것도 말해 주지 않습니다.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "sync가 보낸 것은 검증되었습니다. 전송한 각 파일은 도착 시 SHA-256으로 검사되었고, 깔끔한 종료는 그 검사 중 실패가 하나도 없었다는 뜻입니다. 건너뛴 쪽은 크기와 mtime만 대조했으므로, du -sh 총량이 같다는 것은 완료 여부에 대한 대략적인 확인일 뿐 건너뛴 파일의 내용이 여전히 같다는 증명은 아닙니다. 그 증명이 필요하면 두 서버에서 파일별 체크섬을 직접 비교하세요.",
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
            fix: "진행 상황은 파일 하나가 끝날 때만 출력되므로, 큰 파일 하나는 완전한 침묵 속에 전송됩니다. ESTAB은 닿았다는 것만 증명합니다. established 소켓도 놀고 있거나 멈춰 있을 수 있으니, 그것만으로는 결코 전진의 증거가 되지 않습니다. 이 확인을 몇 초 간격으로 두 번 실행해, -i 가 그 소켓에 대해 출력하는 bytes_acked 카운터를 비교하세요. 숫자가 오르면 실제로 전송 중이고, 그대로면 진짜 멈춘 것입니다.",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "따옴표와 > 리다이렉트가 섞인 여러 줄짜리 nohup 명령은 붙여넣을 때 리다이렉트에서 깨지기 쉽습니다. 대신 tmux와 이 한 줄 루프를 쓰세요. 틀릴 리다이렉트가 없고, 다시 붙어서 지켜볼 수도 있습니다.",
          },
          {
            symptom: "정리하다가 죽일 생각이 없던 것까지 죽였습니다.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "명령줄 패턴으로 죽이면 그 문자열이 들어간 모든 프로세스에 시그널이 갑니다. 전송이 둘 이상 도는 기기에서는 노린 그것이 아닐 수 있습니다. 미러도 멈추지 않습니다. sync를 소유한 것은 until 루프라서, 자식을 죽여도 10초 뒤에 다시 뜹니다. 먼저 pgrep -af 로 확인한 뒤, 이 가이드가 실제로 소유한 것을 끝내세요. tmux kill-session -t xfer 로 루프를 끝내고, ~/relayium-serve.pid 에 있는 PID에 kill 을 보내 직접 띄운 리스너를 멈춥니다. 그 PID 파일이 이전 실행부터 남아 있었다면 시그널을 보내기 전에 명령줄부터 출력해 보세요. 시스템이 재사용한 PID는 전혀 다른 프로세스의 것입니다.",
          },
          {
            symptom: "하위 디렉터리 하나를 빼고 싶은데 exclude 플래그가 없습니다.",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "sync가 받는 것은 -i와 -p, --delete, --watch, --config-dir 뿐이고, 트리 중간에서 경로를 걸러 내는 기능은 없습니다. 대신 원하는 하위 디렉터리를 직접 나열하세요. 각 소스는 받는 쪽 --dir 아래에 자기 이름으로 도착하므로, serve --dir /root/workspace 를 상대로 이 명령은 /root/workspace/src 와 /root/workspace/data 를 재현하고 다시 만들 수 있는 venv는 아예 훑지 않습니다.",
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
        a: "아무것도 잃지 않습니다. relayium sync를 다시 실행하세요. 받는 쪽에 이미 있는 파일은 건너뛰고, 절반 보낸 파일은 디스크에 이미 있는 바이트 오프셋부터 재개합니다. 이 가이드의 until 루프가 폴더 전체가 미러될 때까지 이를 자동으로 합니다.",
      },
      {
        q: "이것은 rsync와 무엇이 다른가요?",
        a: "둘 다 증분 단방향 미러링을 하지만, relayium sync는 인증서 고정 TLS 연결로 동작하고 SSH 계정이 필요 없으며(데몬 다이렉트), 인증서 핑거프린트로 두 기기를 인증하고, 전송하는 각 파일을 SHA-256으로 검증합니다. rsync의 기본 동작과 마찬가지로, 수신 측에서 크기와 mtime이 이미 일치하는 파일은 해시를 다시 계산하지 않고 건너뜁니다. relayium의 다른 모드와 같은 전송 엔진입니다.",
      },
      {
        q: "sync는 소스에서 지운 파일을 받는 쪽에서도 지우나요?",
        a: "요청할 때만요. 기본적으로 sync는 추가와 갱신만 합니다. 삭제를 미러링하려면 --delete를 넘기고, 그것이 적용되려면 받는 쪽이 --allow-delete로 serve를 실행해야 합니다. 그렇지 않으면 삭제는 무시되고 보고됩니다.",
      },
      {
        q: "두 폴더를 계속 동기화 상태로 유지할 수 있나요?",
        a: "네. --watch를 붙이면 sync가 계속 실행되며 소스 아래의 어떤 변경에도 다시 미러링합니다. 큰 폴더를 한 번 옮기는 데는 필요 없습니다. 재시도 루프와 평범한 sync면 충분합니다.",
      },
      {
        q: "포트를 열어야 하나요?",
        a: "데몬 다이렉트라면 네. 리스너 포트(기본 9031)가 보내는 쪽에서 도달 가능해야 합니다. 포트를 열고 싶지 않고 서버 사이에 이미 SSH가 있다면 sync는 SSH로도 동작합니다: relayium sync /path user@host:/path(원격에 relayium이 필요).",
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
    "Spiegle ein großes Verzeichnis von einem Server auf einen anderen mit relayium sync — inkrementell, nach einem Verbindungsabbruch fortsetzbar und sicher unbeaufsichtigt auszuführen. Eine Retry-Schleife unter tmux bewegt Gigabytes, ohne ein Terminal zu bewachen.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Du hast einen großen Ordner — zig Gigabyte — auf einem Server und willst eine exakte Kopie auf einem anderen. Du kannst kein Terminal stundenlang bewachen, und eine Übertragung, die auf halbem Weg abbricht, sollte nicht bei null neu beginnen. relayium sync ist genau dafür gebaut: ein einseitiger inkrementeller Spiegel, der überspringt, was schon da ist, eine halb gesendete Datei dort fortsetzt, wo sie stehen blieb, und jede Datei, die er sendet, Ende-zu-Ende prüft.",
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
        "Prüft, was er sendet: Jede übertragene Datei — auch eine fortgesetzte — wird Ende-zu-Ende gegen die SHA-256 des Senders geprüft, und eine Abweichung wird als Fehler gemeldet. Übersprungene Dateien werden allein über Größe und mtime entschieden und nicht neu gehasht; über Inhalte, die er nicht gesendet hat, sagt sync nichts aus.",
        "Deshalb ist der Befehl idempotent — ein erneuter Lauf erledigt nur die verbleibende Arbeit, und genau das lässt eine Retry-Schleife eine riesige Übertragung abschließen.",
      ],
    },
    {
      heading: "Voraussetzungen",
      body: [
        "Installiere relayium auf beiden Servern (sync spricht das native Protokoll, muss also an jedem Ende vorhanden sein):",
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
      steps: [
        {
          text: "Starte auf dem Sender eine tmux-Sitzung, damit die Schleife die ssh-Sitzung überlebt, aus der du sie gestartet hast.",
          code: [
            `# auf dem SENDER
tmux new -s xfer      # apt install -y tmux, falls es fehlt`,
          ],
        },
        {
          text: "Lass den Spiegel in einer until-Schleife laufen. Sie versucht es alle 10 Sekunden erneut, bis sync Erfolg meldet, und beendet sich dann von selbst.",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "Koppel mit Ctrl-b, dann d ab. Die Schleife läuft weiter; verbinde dich wieder, wann immer du zusehen willst.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Durchlauf aus",
        body: [
          "Jeder Durchlauf gibt eine Zeile pro tatsächlich gesendeter Datei aus, dann eine Zusammenfassung, die Gesendetes gegen das stellt, was der Empfänger schon hatte. Die Schleife endet, sobald sync das erste Mal Erfolg meldet, und diese Zusammenfassung ist der Stand des Spiegels.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Jeder Versuch tut weniger: bereits übertragene Dateien werden übersprungen, eine halb gesendete Datei wird fortgesetzt — so konvergiert die Schleife und ist fertig.",
        "Der Fortschritt gibt pro fertiger Datei eine Zeile aus, eine große Datei überträgt also still, bis sie fertig ist. Stille ist kein Stillstand (siehe Fehlerbehebung).",
      ],
    },
    {
      heading: "Prüfen und abschließen",
      body: [
        "Die Übertragung ist abgeschlossen, wenn die until-Schleife endet und du wieder an einer normalen Shell-Eingabe bist. Prüfe, dass beide Seiten übereinstimmen, und stoppe dann den Listener:",
      ],
      steps: [
        {
          text: "Warte, bis die until-Schleife von allein endet. Wieder an einer gewöhnlichen Shell-Eingabe zu sein heißt, dass die Übertragung fertig ist, nicht dass du sie abgebrochen hast.",
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
          "du -sh meldet auf beiden Servern dieselbe Gesamtgröße, und die until-Schleife hat dich an einen gewöhnlichen Shell-Prompt zurückgegeben, statt erneut zu versuchen. Gleiche Summen sind eine grobe Vollständigkeitsprobe und kein Integritätsbeweis: sync hat über Größe und mtime entschieden, welche Dateien gar nicht erst gehen, also sagt die Summe nichts über den Inhalt der übersprungenen Dateien.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Was sync gesendet hat, ist geprüft: Jede übertragene Datei wurde beim Eintreffen mit SHA-256 kontrolliert, und ein sauberes Ende heißt, dass keine dieser Prüfungen fehlgeschlagen ist. Was übersprungen wurde, wurde nur über Größe und mtime abgeglichen; gleiche du -sh-Summen sind deshalb eine Plausibilitätsprobe auf Vollständigkeit und kein Beweis, dass die übersprungenen Inhalte noch übereinstimmen. Brauchst du diesen Beweis, vergleiche Prüfsummen pro Datei auf beiden Servern.",
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
            fix: "Der Fortschritt erscheint nur, wenn eine Datei fertig ist, eine einzelne große Datei überträgt also völlig still. ESTAB belegt nur die Erreichbarkeit — ein aufgebauter Socket kann untätig sein oder hängen — und ist für sich genommen nie ein Beleg für Fortschritt. Führ die Prüfung zweimal im Abstand einiger Sekunden aus und vergleich den bytes_acked-Zähler, den -i für diesen Socket ausgibt: ein steigender Wert ist eine laufende Übertragung, ein unveränderter ein echter Stillstand.",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "Ein mehrzeiliger nohup-Befehl mit Anführungszeichen und einer >-Umleitung bricht beim Einfügen meist an der Umleitung. Nimm stattdessen tmux und diese einzeilige Schleife: Es gibt keine Umleitung, die schiefgehen kann, und du kannst dich wieder verbinden und zusehen.",
          },
          {
            symptom: "Beim Aufräumen ist etwas gestorben, das du nicht treffen wolltest.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Über ein Kommandozeilen-Muster zu töten schickt das Signal an jeden Prozess, dessen Kommandozeile diesen Text enthält — auf einer Maschine mit mehr als einer Übertragung also nicht an den gemeinten. Es stoppt den Spiegel auch nicht: die until-Schleife besitzt das sync, ein getötetes Kind wird zehn Sekunden später einfach neu gestartet. Sieh mit pgrep -af nach und beende dann, was diese Anleitung wirklich besitzt — tmux kill-session -t xfer beendet die Schleife, und ein kill auf die PID in ~/relayium-serve.pid beendet den Listener, den du gestartet hast. Liegt die PID-Datei noch von einem früheren Lauf herum, lass dir vor dem Signal ihre Kommandozeile ausgeben: eine vom System neu vergebene PID gehört zu etwas ganz anderem.",
          },
          {
            symptom: "Du willst ein Unterverzeichnis auslassen, und es gibt keine exclude-Option.",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "sync nimmt -i und -p, --delete, --watch und --config-dir — nichts, was mitten im Baum einen Pfad herausfiltert. Nenn stattdessen die Unterverzeichnisse, die du willst: Jede Quelle landet unter dem --dir des Empfängers unter ihrem eigenen Namen, gegen serve --dir /root/workspace entstehen so wieder /root/workspace/src und /root/workspace/data, und ein neu erzeugbares venv wird nie durchlaufen.",
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
        a: "Nichts geht verloren. Führe relayium sync erneut aus — es überspringt bereits auf dem Empfänger vorhandene Dateien und setzt eine halb gesendete Datei beim bereits auf der Platte liegenden Byte-Offset fort. Die until-Schleife in dieser Anleitung tut das automatisch, bis der ganze Ordner gespiegelt ist.",
      },
      {
        q: "Wie unterscheidet sich das von rsync?",
        a: "Beide machen inkrementelles einseitiges Spiegeln, aber relayium sync läuft über eine TLS-Verbindung mit Pinning ohne SSH-Konto (daemon-direct), authentifiziert die beiden Maschinen per Zertifikats-Fingerprint und prüft jede übertragene Datei mit SHA-256. Wie bei rsync in der Voreinstellung wird eine Datei, deren Größe und mtime auf dem Empfänger schon übereinstimmen, übersprungen statt neu gehasht. Es ist dieselbe Übertragungs-Engine wie die anderen Modi von relayium.",
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
        a: "Für daemon-direct ja — der Port des Listeners (Standard 9031) muss vom Sender erreichbar sein. Willst du keinen Port öffnen und hast bereits SSH zwischen den Servern, funktioniert sync auch über SSH: relayium sync /path user@host:/path (relayium muss auf der Gegenseite installiert sein).",
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
    "Recopiez un gros répertoire d'un serveur vers un autre avec relayium sync — incrémental, avec reprise après une coupure, et sûr à exécuter sans surveillance. Une boucle de reprise sous tmux déplace des gigaoctets sans surveiller un terminal.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Vous avez un gros dossier — des dizaines de gigaoctets — sur un serveur et vous voulez une copie exacte sur un autre. Vous ne pouvez pas surveiller un terminal pendant des heures, et un transfert qui meurt à mi-chemin ne devrait pas repartir de zéro. relayium sync est fait pour cela : un miroir incrémental à sens unique qui saute ce qui est déjà là, reprend un fichier envoyé à moitié là où il s'est arrêté, et vérifie de bout en bout chaque fichier qu'il envoie.",
    "Ce guide met en place un transfert sans surveillance et auto-réparateur : autorisez l'émetteur une fois, faites tourner le processus à l'écoute en arrière-plan, et pilotez relayium sync depuis une boucle de reprise dans tmux pour qu'il continue malgré les coupures jusqu'à ce que tout le dossier soit arrivé.",
  ],
  sections: [
    {
      heading: "Pourquoi relayium sync convient à cette tâche",
      body: [
        "sync est un miroir incrémental à sens unique via le protocole natif (installez relayium aux deux bouts). Trois propriétés le rendent sûr à exécuter et réexécuter sans surveillance :",
      ],
      bullets: [
        "Saute les fichiers déjà présents : un fichier dont la copie sur le récepteur correspond par taille et date de modification n'est pas renvoyé.",
        "Reprend les fichiers partiels : si un fichier était à moitié transféré à la coupure, l'exécution suivante continue depuis l'offset d'octets déjà sur le disque au lieu de le recommencer.",
        "Vérifie ce qu'il envoie : chaque fichier transféré — y compris un fichier repris — est contrôlé de bout en bout face au SHA-256 de l'émetteur, et un écart est signalé comme un échec. Les fichiers ignorés sont décidés sur la taille et le mtime, jamais rehachés, et sync ne dit donc rien du contenu qu'il n'a pas envoyé.",
        "De ce fait, la commande est idempotente — la relancer ne fait que le travail restant, ce qui est précisément ce qui permet à une boucle de reprise de terminer un transfert énorme.",
      ],
    },
    {
      heading: "Prérequis",
      body: [
        "Installez relayium sur les deux serveurs (sync parle le protocole natif, il doit donc être présent à chaque bout) :",
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
        "serve traite les connexions une par une et continue de tourner, il est donc prêt pour chaque reconnexion de la boucle de reprise ci-dessous.",
        "Pour une boîte de réception toujours active, faites-le tourner plutôt sous systemd (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Exécuter sync dans une boucle de reprise sous tmux (sur l'émetteur)",
      body: [
        "Les longs transferts sont interrompus — une session coupée, un réseau instable, un redémarrage. La solution n'est pas un outil sophistiqué ; c'est une boucle qui réexécute sync jusqu'à la réussite, plus un multiplexeur de terminal pour qu'il survive à votre déconnexion. Ici tmux est plus propre que nohup : pas de redirection de sortie à rater, et vous pouvez vous reconnecter pour voir la progression.",
        "Démarrez une session tmux, puis exécutez le miroir dans une boucle until — elle réessaie toutes les 10 secondes jusqu'à ce que sync réussisse, puis se termine d'elle-même :",
      ],
      steps: [
        {
          text: "Ouvrez une session tmux sur l'émetteur, pour que la boucle survive à la session ssh depuis laquelle vous l'avez lancée.",
          code: [
            `# sur l'ÉMETTEUR
tmux new -s xfer      # apt install -y tmux s'il manque`,
          ],
        },
        {
          text: "Faites tourner le miroir dans une boucle until. Elle réessaie toutes les 10 secondes jusqu'à ce que sync réussisse, puis s'arrête d'elle-même.",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "Détachez-vous avec Ctrl-b puis d. La boucle continue ; reconnectez-vous quand vous voulez la regarder.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "À quoi ressemble un passage réussi",
        body: [
          "Chaque passage affiche une ligne par fichier réellement envoyé, puis un résumé opposant ce qu'il a envoyé à ce que le récepteur avait déjà. La boucle s'arrête au premier succès de sync, et ce résumé est l'état du miroir.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Chaque tentative fait moins : les fichiers déjà transférés sont sautés, un fichier envoyé à moitié reprend — la boucle converge donc et se termine.",
        "La progression affiche une ligne par fichier terminé, un gros fichier se transfère donc en silence jusqu'à sa fin. Le silence n'est pas un blocage (voir dépannage).",
      ],
    },
    {
      heading: "Vérifier et terminer",
      body: [
        "Le transfert est terminé quand la boucle until s'achève et que vous revenez à une invite shell normale. Confirmez que les deux côtés correspondent, puis arrêtez le processus à l'écoute :",
      ],
      steps: [
        {
          text: "Attendez que la boucle until s'achève d'elle-même. Retrouver une invite shell ordinaire signifie que le transfert est terminé, pas que vous l'avez interrompu.",
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
          "du -sh annonce le même total sur les deux serveurs, et la boucle until vous a rendu une invite de shell ordinaire au lieu de réessayer. Des totaux identiques sont un contrôle d'exhaustivité grossier, pas une preuve d'intégrité — sync a décidé sur la taille et le mtime quels fichiers ne pas envoyer, donc le total ne dit rien du contenu des fichiers ignorés.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Ce que sync a envoyé est vérifié — chaque fichier transféré a été contrôlé en SHA-256 à l'arrivée, et une sortie propre signifie qu'aucun de ces contrôles n'a échoué. Ce qu'il a ignoré n'a été comparé que sur la taille et le mtime, donc des totaux du -sh identiques sont un contrôle de vraisemblance sur l'exhaustivité, pas une preuve que le contenu ignoré correspond toujours. Si vous avez besoin de cette preuve, comparez les sommes de contrôle fichier par fichier sur les deux serveurs.",
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
            fix: "La progression ne s'affiche qu'à la fin de chaque fichier, un seul gros fichier se transfère donc dans un silence complet. ESTAB ne prouve que l'accessibilité — une socket établie peut rester inactive ou bloquée — et ne constitue jamais à elle seule une preuve d'avancement ; relancez la vérification à quelques secondes d'intervalle et comparez le compteur bytes_acked que -i affiche pour cette socket, un compteur qui monte est un transfert qui avance, un compteur figé est un vrai blocage.",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "Une commande nohup multiligne avec des guillemets et une redirection > casse le plus souvent sur la redirection au moment du collage. Utilisez plutôt tmux et cette boucle d'une seule ligne : aucune redirection à rater, et vous pouvez vous reconnecter pour regarder.",
          },
          {
            symptom: "Le nettoyage a tué quelque chose que vous ne visiez pas.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Tuer par motif de ligne de commande envoie le signal à tout processus dont la ligne de commande contient ce texte, sur une machine où tourne plus d'un transfert ce n'est donc pas celui que vous visiez. Et cela n'arrête pas la copie, la boucle until possède le sync et un enfant tué est simplement relancé dix secondes plus tard. Regardez avec pgrep -af, puis terminez ce que ce guide possède réellement : tmux kill-session -t xfer met fin à la boucle, et un kill sur le PID contenu dans ~/relayium-serve.pid arrête le processus à l'écoute que vous avez lancé. Si le fichier de PID traîne depuis une exécution précédente, affichez sa ligne de commande avant d'envoyer le signal, car un PID réattribué par le système appartient à tout autre chose.",
          },
          {
            symptom: "Vous voulez laisser un sous-répertoire de côté et il n'y a aucune option d'exclusion.",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "sync accepte -i et -p, --delete, --watch et --config-dir — rien qui filtre un chemin au milieu de l'arborescence. Nommez plutôt les sous-répertoires que vous voulez : chaque source arrive sous le --dir du récepteur avec son propre nom, donc face à serve --dir /root/workspace cette commande reconstruit /root/workspace/src et /root/workspace/data sans jamais parcourir un venv régénérable.",
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
        a: "Rien n'est perdu. Relancez relayium sync — il saute les fichiers déjà sur le récepteur et reprend un fichier envoyé à moitié depuis l'offset d'octets déjà sur le disque. La boucle until de ce guide le fait automatiquement jusqu'à ce que tout le dossier soit recopié.",
      },
      {
        q: "En quoi est-ce différent de rsync ?",
        a: "Les deux font un miroir incrémental à sens unique, mais relayium sync tourne sur une connexion TLS avec épinglage sans compte SSH (daemon-direct), authentifie les deux machines par empreinte de certificat, et vérifie en SHA-256 chaque fichier qu'il transfère. Comme rsync par défaut, un fichier dont la taille et le mtime correspondent déjà côté récepteur est ignoré plutôt que rehaché. C'est le même moteur de transfert que les autres modes de relayium.",
      },
      {
        q: "sync supprime-t-il sur le récepteur les fichiers que j'ai retirés de la source ?",
        a: "Seulement si vous le demandez. Par défaut, sync ne fait qu'ajouter et mettre à jour. Passez --delete pour recopier les suppressions, et le récepteur doit exécuter serve avec --allow-delete pour que ce soit honoré — sinon la suppression est ignorée et signalée.",
      },
      {
        q: "Puis-je garder deux dossiers synchronisés en continu ?",
        a: "Oui. Ajoutez --watch et sync reste en marche, recopiant à chaque changement sous la source. Pour un déplacement ponctuel d'un gros dossier, inutile — la boucle de reprise plus un sync simple suffisent.",
      },
      {
        q: "Dois-je ouvrir un port ?",
        a: "Pour le daemon-direct, oui — le port du processus à l'écoute (9031 par défaut) doit être joignable depuis l'émetteur. Si vous préférez ne pas ouvrir de port et avez déjà SSH entre les serveurs, sync fonctionne aussi via SSH : relayium sync /path user@host:/path (relayium doit être installé côté distant).",
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
    "انسخ دليلًا كبيرًا من خادم إلى آخر بـ relayium sync — تزايدية، قابلة للاستئناف بعد انقطاع الاتصال، وآمنة للتشغيل دون إشراف. حلقة إعادة محاولة تحت tmux تنقل غيغابايتات دون ملازمة طرفية.",
  updatedLabel: "آخر تحديث",
  lead: [
    "لديك مجلد كبير — عشرات الغيغابايتات — على خادم وتريد نسخة مطابقة على آخر. لا يمكنك مراقبة طرفية لساعات، ولا ينبغي لنقلٍ يموت في منتصف الطريق أن يبدأ من الصفر. صُمِّم relayium sync لهذا: مرآة تزايدية أحادية الاتجاه تتخطى ما هو موجود سلفًا، وتستأنف ملفًا أُرسِل نصفه من حيث توقف، وتتحقق من كل ملف تُرسِله من الطرف إلى الطرف.",
    "يُعِدّ هذا الدليل نقلًا دون إشراف يُصلِح نفسه: فوِّض المُرسِل مرةً واحدة، وشغّل المُستمِع في الخلفية، وقُد relayium sync من حلقة إعادة محاولة داخل tmux كي يستمر عبر الانقطاعات حتى يصل المجلد كاملًا.",
  ],
  sections: [
    {
      heading: "لماذا يناسب relayium sync هذه المهمة",
      body: [
        "sync مرآة تزايدية أحادية الاتجاه عبر البروتوكول الأصلي (ثبّت relayium على الطرفين). ثلاث خصائص تجعله آمنًا للتشغيل وإعادة التشغيل دون إشراف:",
      ],
      bullets: [
        "يتخطى الملفات الموجودة سلفًا: الملف الذي تطابق نسخته لدى المُستقبِل في الحجم ووقت التعديل لا يُرسَل ثانيةً.",
        "يستأنف الملفات الجزئية: إذا نُقِل نصف ملف عند انقطاع الاتصال، يُكمِل التشغيل التالي من إزاحة البايت الموجودة سلفًا على القرص بدل إعادته من البداية.",
        "يتحقق مما يُرسِله: يُقارَن كل ملف مَنقول — بما في ذلك ملف استُؤنِف — بـ SHA-256 المُرسِل من الطرف إلى الطرف، وأي اختلاف يُبلَّغ عنه كفشل. أما الملفات المتخطّاة فتُحدَّد بالحجم وmtime فقط ولا يُعاد حساب بصمتها، فلا يقول sync شيئًا عن محتوى لم يُرسِله.",
        "بسبب هذا، الأمر خامل التكرار (idempotent) — إعادة تشغيله تنجز ما تبقى فقط، وهذا بالضبط ما يتيح لحلقة إعادة المحاولة إتمام نقلٍ ضخم.",
      ],
    },
    {
      heading: "المتطلبات المسبقة",
      body: [
        "ثبّت relayium على كلا الخادمين (sync يتحدث البروتوكول الأصلي، فيجب أن يكون حاضرًا على كل طرف):",
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
        "يعالج serve الاتصالات واحدًا تلو الآخر ويبقى شغّالًا، فيكون جاهزًا لكل إعادة اتصال من حلقة إعادة المحاولة أدناه.",
        "لصندوق وارد دائم التشغيل، شغّله تحت systemd بدلًا من ذلك (Restart=always، --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "شغّل sync في حلقة إعادة محاولة تحت tmux (على المُرسِل)",
      body: [
        "تُقطَع عمليات النقل الطويلة — جلسة تسقط، شبكة متذبذبة، إعادة إقلاع. الحل ليس أداة متطورة؛ بل حلقة تعيد تشغيل sync حتى ينجح، مع مُعدِّد طرفيات كي يصمد بعد خروجك. هنا tmux أنظف من nohup: لا إعادة توجيه مخرجات يمكن أن تُخطئ فيها، ويمكنك إعادة الوصل لمتابعة التقدم.",
        "ابدأ جلسة tmux، ثم شغّل المرآة في حلقة until — تعيد المحاولة كل 10 ثوانٍ حتى يُرجِع sync نجاحًا، ثم تخرج من تلقاء نفسها:",
      ],
      steps: [
        {
          text: "افتح جلسة tmux على المُرسِل كي تعيش الحلقة أطول من جلسة ssh التي شغّلتها منها.",
          code: [
            `# على المُرسِل
tmux new -s xfer      # نفّذ apt install -y tmux إن لم يكن موجودًا`,
          ],
        },
        {
          text: "شغّل المرآة داخل حلقة until. تعيد المحاولة كل 10 ثوانٍ حتى ينجح sync، ثم تنتهي من تلقاء نفسها.",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "افصِل بـ Ctrl-b ثم d. تظل الحلقة تعمل، وأعِد الوصل متى شئت لتراقبها.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "كيف تبدو جولة ناجحة",
        body: [
          "تطبع كل جولة سطرًا لكل ملف أرسلته فعلًا، ثم سطر ملخّص يقابل ما أُرسِل بما كان لدى المُستقبِل سلفًا. وتنتهي الحلقة عند أول نجاح لـ sync، وذلك الملخّص هو حال المرآة.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "كل إعادة محاولة تنجز أقل: تُتخطى الملفات المنقولة سلفًا، ويُستأنف الملف المُرسَل نصفه — فتتقارب الحلقة وتنتهي.",
        "يطبع التقدم سطرًا واحدًا لكل ملف مكتمل، فينتقل الملف الكبير بهدوء حتى يكتمل. الصمت ليس تعطّلًا (انظر استكشاف الأخطاء).",
      ],
    },
    {
      heading: "التحقق والإنهاء",
      body: [
        "يكتمل النقل حين تنتهي حلقة until وتعود إلى مُطالبة صدفة عادية. تأكد من تطابق الطرفين، ثم أوقِف المُستمِع:",
      ],
      steps: [
        {
          text: "انتظر حتى تنتهي حلقة until من تلقاء نفسها. عودتك إلى مِحَث صَدَفة عادي تعني أن النقل انتهى، لا أنك قطعته.",
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
          "يُبلِغ du -sh بالمجموع نفسه على الخادمين، وقد أعادتك حلقة until إلى مِحَث صَدَفة عادي بدل أن تعيد المحاولة من جديد. وتطابُق المجموع فحصٌ خشِن للاكتمال لا برهانٌ على السلامة: فقد قرّر sync بالحجم وmtime أي الملفات لا تُرسَل، فلا يقول المجموع شيئًا عن محتوى الملفات المتخطّاة.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "ما أرسله sync مُتحقَّق منه: كل ملف نُقِل فُحِص بـ SHA-256 عند وصوله، والخروج النظيف يعني أن أيًّا من تلك الفحوص لم يفشل. أما ما تخطّاه فقُورِن بالحجم وmtime فقط، فتطابُق مجاميع du -sh فحصُ معقولية للاكتمال لا برهانٌ على أن المحتوى المتخطّى ما زال مطابقًا. إن احتجت هذا البرهان فقارِن بصمات كل ملف على الخادمين بنفسك.",
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
            fix: "لا يُطبَع التقدم إلا عند اكتمال ملف، فينتقل ملف كبير واحد في صمت تام. ولا تثبت ESTAB إلا إمكانية الوصول، فالمقبس المُنشأ قد يبقى خاملًا أو متعطّلًا، وهي وحدها ليست دليلًا على التقدّم أبدًا. نفّذ الفحص مرتين بفارق ثوانٍ قليلة وقارِن عدّاد bytes_acked الذي يطبعه ‎-i‎ لذلك المقبس: تزايُده يعني نقلًا يتقدّم، وثباته يعني تعطّلًا حقيقيًا.",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "أمر nohup متعدد الأسطر فيه علامات اقتباس وإعادة توجيه ينكسر عادةً عند إعادة التوجيه لحظة اللصق. استخدم tmux مع حلقة السطر الواحد هذه بدلًا من ذلك: لا إعادة توجيه لتخطئ فيها، ويمكنك إعادة الوصل لتراقب.",
          },
          {
            symptom: "قتل التنظيف شيئًا لم تكن تقصده.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "القتل بمطابقة نمط في سطر الأوامر يُرسِل الإشارة إلى كل عملية يحتوي سطر أوامرها ذلك النص، وعلى جهاز يعمل عليه أكثر من نقل واحد لن تكون هي المقصودة. كما أنه لا يوقف المرآة: الحلقة until هي التي تملك sync، فالابن المقتول يُعاد تشغيله بعد عشر ثوانٍ. انظر أولًا بـ pgrep -af، ثم أنهِ ما يملكه هذا الدليل فعلًا — ينهي tmux kill-session -t xfer الحلقة، ويوقف kill على الـPID الموجود في ~/relayium-serve.pid المُستمِع الذي شغّلته. وإن كان ملف الـPID باقيًا من تشغيل سابق، فاعرض سطر أوامره قبل إرسال الإشارة، لأن مُعرّفًا أعاد النظام استخدامه يخص شيئًا آخر تمامًا.",
          },
          {
            symptom: "تريد استثناء مجلد فرعي واحد ولا توجد راية استثناء.",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "يقبل sync الرايتين -i و-p و--delete و--watch و--config-dir، ولا شيء فيها يرشّح مسارًا في وسط الشجرة. سمِّ المجلدات الفرعية التي تريدها بدلًا من ذلك: يصل كل مصدر تحت --dir لدى المُستقبِل باسمه هو، فمع serve --dir /root/workspace يعيد هذا الأمر بناء /root/workspace/src و/root/workspace/data ولا يمشي أبدًا في بيئة venv يمكن إعادة توليدها.",
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
        a: "لا يُفقَد شيء. أعِد تشغيل relayium sync — يتخطى الملفات الموجودة سلفًا لدى المُستقبِل ويستأنف الملف المُرسَل نصفه من إزاحة البايت الموجودة سلفًا على القرص. حلقة until في هذا الدليل تفعل ذلك تلقائيًا حتى تُنسَخ صورة المجلد كاملة.",
      },
      {
        q: "بماذا يختلف هذا عن rsync؟",
        a: "كلاهما يقوم بمرآة تزايدية أحادية الاتجاه، لكن relayium sync يعمل عبر اتصال TLS مُثبَّت دون الحاجة إلى حساب SSH (daemon direct)، ويصادق الجهازين ببصمة الشهادة، ويتحقق بـ SHA-256 من كل ملف يَنقُله. وكما في سلوك rsync الافتراضي، يُتخطّى الملف الذي يتطابق حجمه وmtime أصلًا على الطرف المستقبِل بدل إعادة حساب بصمته. إنه محرك النقل نفسه المُستخدَم في أوضاع relayium الأخرى.",
      },
      {
        q: "هل يحذف sync لدى المُستقبِل الملفات التي أزلتها من المصدر؟",
        a: "فقط إن طلبت ذلك. افتراضيًا، يضيف sync ويحدّث فقط. مرِّر --delete لعكس عمليات الحذف، ويجب أن يشغّل المُستقبِل serve مع --allow-delete كي يُحترَم ذلك — وإلا يُتجاهَل الحذف ويُبلَّغ عنه.",
      },
      {
        q: "هل يمكنني إبقاء مجلدين متزامنين باستمرار؟",
        a: "نعم. أضِف --watch فيبقى sync شغّالًا، مُعيدًا عكس الصورة عند أي تغيير تحت المصدر. لنقل مجلد كبير لمرة واحدة لا تحتاجه — تكفي حلقة إعادة المحاولة مع sync بسيط.",
      },
      {
        q: "هل عليّ فتح منفذ؟",
        a: "لـ daemon direct، نعم — يجب أن يكون منفذ المُستمِع (9031 افتراضيًا) قابلًا للوصول من المُرسِل. إن كنت تفضّل عدم فتح منفذ ولديك SSH بين الخادمين سلفًا، فإن sync يعمل أيضًا عبر SSH: relayium sync /path user@host:/path (يجب تثبيت relayium على الطرف البعيد).",
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
    "Replica un directorio grande de un servidor a otro con relayium sync — incremental, reanudable tras una caída de conexión y seguro para ejecutar sin supervisión. Un bucle de reintentos bajo tmux mueve gigabytes sin tener que vigilar una terminal.",
  updatedLabel: "Última actualización",
  lead: [
    "Tienes una carpeta grande —decenas de gigabytes— en un servidor y quieres una copia exacta en otro. No puedes vigilar una terminal durante horas, y una transferencia que muere a mitad de camino no debería empezar de cero. relayium sync está hecho para esto: un espejo incremental unidireccional que se salta lo que ya está, reanuda un archivo enviado a medias desde donde se detuvo y verifica de extremo a extremo cada archivo que envía.",
    "Esta guía configura una transferencia sin supervisión y con recuperación automática: autoriza al emisor una vez, ejecuta el proceso a la escucha en segundo plano y dirige relayium sync desde un bucle de reintentos dentro de tmux para que siga adelante a través de las caídas de conexión hasta que toda la carpeta haya llegado.",
  ],
  sections: [
    {
      heading: "Por qué relayium sync encaja en esta tarea",
      body: [
        "sync es un espejo incremental unidireccional sobre el protocolo nativo (instala relayium en ambos extremos). Tres propiedades hacen que sea seguro ejecutarlo y volver a ejecutarlo sin supervisión:",
      ],
      bullets: [
        "Se salta los archivos que ya están: un archivo cuya copia en el receptor coincide en tamaño y hora de modificación no se envía de nuevo.",
        "Reanuda archivos parciales: si un archivo se transfirió a medias cuando cayó la conexión, la siguiente ejecución continúa desde el desplazamiento de bytes que ya está en disco en lugar de reiniciarlo.",
        "Verifica lo que envía: cada archivo transferido —incluido uno reanudado— se comprueba de extremo a extremo contra el SHA-256 del emisor, y una discrepancia se informa como fallo. Los archivos que omite se deciden por tamaño y mtime, y no se vuelven a hashear, así que sync no dice nada del contenido que no envió.",
        "Por todo esto, el comando es idempotente: volver a ejecutarlo solo hace el trabajo que queda, que es justo lo que permite a un bucle de reintentos terminar una transferencia enorme.",
      ],
    },
    {
      heading: "Requisitos previos",
      body: [
        "Instala relayium en ambos servidores (sync habla el protocolo nativo, así que debe estar presente en cada extremo):",
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
        "serve maneja las conexiones de una en una y sigue ejecutándose, así que está listo para cada reconexión del bucle de reintentos de abajo.",
        "Para una bandeja de entrada siempre activa, ejecútalo bajo systemd en su lugar (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Ejecutar el sync en un bucle de reintentos bajo tmux (en el emisor)",
      body: [
        "Las transferencias largas se interrumpen: una sesión caída, una red inestable, un reinicio. La solución no es una herramienta sofisticada; es un bucle que vuelve a ejecutar sync hasta que tiene éxito, más un multiplexor de terminal para que sobreviva a tu cierre de sesión. Aquí tmux es más limpio que nohup: no hay redirección de salida que puedas equivocar, y puedes volver a conectarte para ver el progreso.",
        "Inicia una sesión de tmux, luego ejecuta el espejo en un bucle until: reintenta cada 10 segundos hasta que sync devuelve éxito, y luego sale por sí solo:",
      ],
      steps: [
        {
          text: "Abre una sesión de tmux en el emisor, para que el bucle sobreviva a la sesión ssh desde la que lo lanzaste.",
          code: [
            `# en el EMISOR
tmux new -s xfer      # apt install -y tmux si falta`,
          ],
        },
        {
          text: "Ejecuta el espejo dentro de un bucle until. Reintenta cada 10 segundos hasta que sync devuelva éxito, y entonces sale por su cuenta.",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "Desconéctate con Ctrl-b y luego d. El bucle sigue en marcha; vuelve a conectarte cuando quieras mirarlo.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "Cómo se ve una pasada correcta",
        body: [
          "Cada pasada imprime una línea por cada archivo que realmente envió, y luego un resumen que enfrenta lo enviado con lo que el receptor ya tenía. El bucle acaba la primera vez que sync devuelve éxito, y ese resumen es el estado del espejo.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Cada reintento hace menos: los archivos ya transferidos se saltan, un archivo enviado a medias se reanuda; así el bucle converge y termina.",
        "El progreso imprime una línea por archivo completado, así que un archivo grande se transfiere en silencio hasta que termina. El silencio no es un atasco (ver resolución de problemas).",
      ],
    },
    {
      heading: "Verificar y terminar",
      body: [
        "La transferencia está completa cuando el bucle until termina y vuelves a un prompt de shell normal. Confirma que ambos lados coinciden, y luego detén el proceso a la escucha:",
      ],
      steps: [
        {
          text: "Espera a que el bucle until termine por su cuenta. Volver a un prompt de shell normal significa que la transferencia acabó, no que la interrumpiste.",
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
          "du -sh informa del mismo total en los dos servidores, y el bucle until te ha devuelto a un prompt de shell normal en lugar de reintentar otra vez. Que los totales coincidan es una comprobación gruesa de completitud, no una prueba de integridad: sync decidió por tamaño y mtime qué archivos no enviar, así que el total no dice nada del contenido de los archivos que omitió.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "Lo que sync envió está verificado: cada archivo transferido se comprobó con SHA-256 al llegar, y una salida limpia significa que ninguna de esas comprobaciones falló. Lo que omitió solo se cotejó por tamaño y mtime, así que unos totales de du -sh iguales son una comprobación de sensatez sobre la completitud, no una prueba de que el contenido omitido siga coincidiendo. Si necesitas esa prueba, compara las sumas de verificación archivo por archivo en los dos servidores.",
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
            fix: "El progreso solo se imprime cuando termina un archivo, así que un único archivo grande se transfiere en completo silencio. ESTAB solo demuestra alcanzabilidad — un socket establecido puede quedarse inactivo o atascado — y por sí solo nunca es prueba de avance. Ejecuta la comprobación dos veces con unos segundos de diferencia y compara el contador bytes_acked que -i imprime para ese socket: si sube, la transferencia avanza; si no cambia, es un atasco real.",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "Un comando nohup de varias líneas con comillas y una redirección > suele romperse en la redirección al pegarlo. Usa en su lugar tmux con este bucle de una sola línea: no hay redirección que equivocar, y puedes volver a conectarte para mirarlo.",
          },
          {
            symptom: "La limpieza mató algo que no querías matar.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Matar por patrón de línea de comandos envía la señal a todo proceso cuya línea de comandos contenga ese texto, que en una máquina con más de una transferencia en marcha no es el que querías. Tampoco detiene el espejo: el bucle until es el dueño del sync, así que un hijo muerto vuelve a arrancar diez segundos después. Mira con pgrep -af y luego termina lo que esta guía realmente posee: tmux kill-session -t xfer acaba con el bucle, y un kill al PID que hay en ~/relayium-serve.pid detiene el proceso a la escucha que lanzaste. Si el archivo de PID lleva ahí desde una ejecución anterior, imprime su línea de comandos antes de señalarlo, porque un PID que el sistema ha reutilizado pertenece a algo completamente distinto.",
          },
          {
            symptom: "Quieres dejar fuera un subdirectorio y no existe ninguna opción de exclusión.",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "sync acepta -i y -p, --delete, --watch y --config-dir; nada que filtre una ruta en medio del árbol. Nombra en su lugar los subdirectorios que sí quieres: cada fuente llega bajo el --dir del receptor con su propio nombre, así que frente a serve --dir /root/workspace este comando reconstruye /root/workspace/src y /root/workspace/data y nunca recorre un venv regenerable.",
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
        a: "No se pierde nada. Vuelve a ejecutar relayium sync: se salta los archivos que ya están en el receptor y reanuda un archivo enviado a medias desde el desplazamiento de bytes que ya está en disco. El bucle until de esta guía lo hace automáticamente hasta que toda la carpeta queda replicada.",
      },
      {
        q: "¿En qué se diferencia esto de rsync?",
        a: "Ambos hacen replicación incremental unidireccional, pero relayium sync se ejecuta sobre una conexión TLS fijada sin necesidad de cuenta SSH (daemon directo), autentica las dos máquinas por huella de certificado y verifica con SHA-256 cada archivo que transfiere. Igual que rsync por defecto, un archivo cuyo tamaño y mtime ya coinciden en el receptor se omite en lugar de volver a hashearse. Es el mismo motor de transferencia que los otros modos de relayium.",
      },
      {
        q: "¿sync elimina en el receptor los archivos que quité del origen?",
        a: "Solo si lo pides. Por defecto sync solo añade y actualiza. Pasa --delete para replicar las eliminaciones, y el receptor debe ejecutar serve con --allow-delete para que se respeten; de lo contrario la eliminación se ignora y se informa de vuelta.",
      },
      {
        q: "¿Puedo mantener dos carpetas sincronizadas de forma continua?",
        a: "Sí. Añade --watch y sync se mantiene en ejecución, volviendo a replicar ante cualquier cambio bajo el origen. Para un traslado puntual de una carpeta grande no lo necesitas: el bucle de reintentos más un sync normal bastan.",
      },
      {
        q: "¿Tengo que abrir un puerto?",
        a: "Para daemon directo, sí: el puerto del proceso a la escucha (9031 por defecto) debe ser alcanzable desde el emisor. Si prefieres no abrir un puerto y ya tienes SSH entre los servidores, sync también funciona sobre SSH: relayium sync /path user@host:/path (relayium debe estar instalado en el remoto).",
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
    "Espelhe um diretório grande de um servidor para outro com relayium sync — incremental, retomável após uma queda de conexão e seguro para executar sem supervisão. Um laço de repetição sob tmux move gigabytes sem precisar vigiar um terminal.",
  updatedLabel: "Última atualização",
  lead: [
    "Você tem uma pasta grande — dezenas de gigabytes — em um servidor e quer uma cópia exata em outro. Você não pode vigiar um terminal por horas, e uma transferência que morre no meio do caminho não deveria recomeçar do zero. relayium sync foi feito para isso: um espelho incremental unidirecional que pula o que já está lá, retoma um arquivo enviado pela metade de onde parou e verifica de ponta a ponta cada arquivo que envia.",
    "Este guia configura uma transferência sem supervisão e com autorrecuperação: autorize o emissor uma vez, execute o processo à escuta em segundo plano e conduza relayium sync a partir de um laço de repetição dentro do tmux para que ele continue através das quedas de conexão até que a pasta inteira chegue.",
  ],
  sections: [
    {
      heading: "Por que relayium sync se encaixa nesta tarefa",
      body: [
        "sync é um espelho incremental unidirecional sobre o protocolo nativo (instale relayium nas duas pontas). Três propriedades o tornam seguro para executar e reexecutar sem supervisão:",
      ],
      bullets: [
        "Pula os arquivos que já estão lá: um arquivo cuja cópia no receptor coincide em tamanho e hora de modificação não é enviado de novo.",
        "Retoma arquivos parciais: se um arquivo foi transferido pela metade quando a conexão caiu, a próxima execução continua a partir do deslocamento de bytes já em disco em vez de reiniciá-lo.",
        "Verifica o que envia: cada arquivo transferido — inclusive um retomado — é conferido de ponta a ponta contra o SHA-256 do emissor, e uma divergência é relatada como falha. Os arquivos que ele pula são decididos por tamanho e mtime e não são re-hasheados, então o sync não diz nada sobre o conteúdo que não enviou.",
        "Por causa disso, o comando é idempotente — executá-lo novamente só faz o trabalho que resta, que é exatamente o que permite a um laço de repetição concluir uma transferência enorme.",
      ],
    },
    {
      heading: "Pré-requisitos",
      body: [
        "Instale relayium nos dois servidores (sync fala o protocolo nativo, então ele precisa estar presente em cada ponta):",
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
        "serve trata as conexões uma de cada vez e continua rodando, então está pronto para cada reconexão do laço de repetição abaixo.",
        "Para uma caixa de entrada sempre ativa, execute-o sob systemd em vez disso (Restart=always, --config-dir /etc/relayium).",
      ],
    },
    {
      heading: "Executar o sync em um laço de repetição sob tmux (no emissor)",
      body: [
        "Transferências longas são interrompidas: uma sessão caída, uma rede instável, uma reinicialização. A solução não é uma ferramenta sofisticada; é um laço que reexecuta sync até ter sucesso, mais um multiplexador de terminal para que sobreviva ao seu logout. Aqui o tmux é mais limpo que o nohup: não há redirecionamento de saída para errar, e você pode reconectar para acompanhar o progresso.",
        "Inicie uma sessão do tmux, depois execute o espelho em um laço until — ele tenta de novo a cada 10 segundos até que sync retorne sucesso, e então sai sozinho:",
      ],
      steps: [
        {
          text: "Abra uma sessão do tmux no emissor, para que o laço sobreviva à sessão ssh de onde você o lançou.",
          code: [
            `# no EMISSOR
tmux new -s xfer      # apt install -y tmux se estiver faltando`,
          ],
        },
        {
          text: "Rode o espelho dentro de um laço until. Ele tenta de novo a cada 10 segundos até o sync retornar sucesso, e então sai sozinho.",
          code: [
            `until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
          ],
        },
        {
          text: "Desanexe com Ctrl-b e depois d. O laço continua rodando; reanexe quando quiser acompanhar.",
          code: ["tmux attach -t xfer"],
        },
      ],
      success: {
        label: "Como é uma passada bem-sucedida",
        body: [
          "Cada passada imprime uma linha por arquivo que realmente enviou, e depois um resumo que contrapõe o que enviou ao que o receptor já tinha. O laço termina na primeira vez que o sync retorna sucesso, e esse resumo é o estado do espelho.",
        ],
        code: [
          `relayium sync /root/workspace relayium://203.0.113.43:9031
  workspace/data/part-004.bin (1073741824 bytes)
synced: 1 sent, 812 unchanged`,
        ],
      },
      bullets: [
        "Cada tentativa faz menos: os arquivos já transferidos são pulados, um arquivo enviado pela metade é retomado — então o laço converge e termina.",
        "O progresso imprime uma linha por arquivo concluído, então um arquivo grande é transferido em silêncio até terminar. O silêncio não é um travamento (veja solução de problemas).",
      ],
    },
    {
      heading: "Verificar e finalizar",
      body: [
        "A transferência está completa quando o laço until termina e você volta a um prompt de shell normal. Confirme que os dois lados coincidem, depois pare o processo à escuta:",
      ],
      steps: [
        {
          text: "Espere o laço until terminar sozinho. Estar de volta a um prompt de shell comum significa que a transferência acabou, não que você a interrompeu.",
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
          "O du -sh informa o mesmo total nos dois servidores, e o laço until devolveu você a um prompt de shell comum em vez de tentar de novo. Totais iguais são uma conferência grosseira de completude, não uma prova de integridade: o sync decidiu por tamanho e mtime quais arquivos não enviar, então o total não diz nada sobre o conteúdo dos arquivos que ele pulou.",
        ],
        code: [
          `# the same total, on BOTH servers
46G	/root/workspace`,
        ],
      },
      bullets: [
        "O que o sync enviou está verificado: cada arquivo transferido foi conferido com SHA-256 na chegada, e uma saída limpa significa que nenhuma dessas conferências falhou. O que ele pulou só foi comparado por tamanho e mtime, então totais de du -sh iguais são uma conferência de sanidade sobre a completude, não uma prova de que o conteúdo pulado ainda confere. Se você precisa dessa prova, compare as somas de verificação arquivo por arquivo nos dois servidores.",
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
            fix: "O progresso só é impresso quando um arquivo termina, então um único arquivo grande é transferido em completo silêncio. ESTAB prova apenas alcançabilidade — um socket estabelecido pode ficar ocioso ou travado — e sozinho nunca é prova de avanço. Rode a verificação duas vezes com alguns segundos de intervalo e compare o contador bytes_acked que o -i imprime para aquele socket: subindo, a transferência está andando; parado, é um travamento de verdade.",
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
until relayium sync /root/workspace relayium://203.0.113.43:9031; do echo "$(date) retrying"; sleep 10; done`,
            ],
            fix: "Um comando nohup de várias linhas com aspas e um redirecionamento > costuma quebrar no redirecionamento na hora de colar. Use em vez disso o tmux com este laço de uma linha só: não há redirecionamento para errar, e você pode reanexar para acompanhar.",
          },
          {
            symptom: "A limpeza matou algo que você não queria matar.",
            code: [
              `pgrep -af relayium
ps -p "$(cat ~/relayium-serve.pid)" -o command=
tmux kill-session -t xfer
kill "$(cat ~/relayium-serve.pid)" && rm ~/relayium-serve.pid`,
            ],
            fix: "Matar por padrão de linha de comando envia o sinal a todo processo cuja linha de comando contenha aquele texto — numa máquina com mais de uma transferência rodando, não é o que você queria. E também não para o espelho: o laço until é o dono do sync, então um filho morto é iniciado de novo dez segundos depois. Olhe com pgrep -af e depois encerre o que este guia de fato possui: tmux kill-session -t xfer termina o laço, e um kill no PID que está em ~/relayium-serve.pid para o processo à escuta que você lançou. Se o arquivo de PID está ali desde uma execução anterior, imprima a linha de comando dele antes de sinalizá-lo, porque um PID que o sistema reutilizou pertence a outra coisa completamente.",
          },
          {
            symptom: "Você quer deixar um subdiretório de fora e não existe nenhuma opção de exclusão.",
            code: [
              `relayium sync /root/workspace/src /root/workspace/data relayium://203.0.113.43:9031`,
            ],
            fix: "O sync aceita -i e -p, --delete, --watch e --config-dir; nada que filtre um caminho no meio da árvore. Nomeie em vez disso os subdiretórios que você quer: cada origem chega sob o --dir do receptor com o próprio nome, então diante de serve --dir /root/workspace este comando reconstrói /root/workspace/src e /root/workspace/data e nunca percorre um venv regenerável.",
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
        a: "Nada se perde. Reexecute relayium sync — ele pula os arquivos que já estão no receptor e retoma um arquivo enviado pela metade a partir do deslocamento de bytes já em disco. O laço until deste guia faz isso automaticamente até que a pasta inteira seja espelhada.",
      },
      {
        q: "Em que isso difere do rsync?",
        a: "Ambos fazem espelhamento incremental unidirecional, mas relayium sync roda sobre uma conexão TLS fixada sem exigir conta SSH (daemon direto), autentica as duas máquinas pela impressão digital do certificado e verifica com SHA-256 cada arquivo que transfere. Como no comportamento padrão do rsync, um arquivo cujo tamanho e mtime já coincidem no receptor é pulado em vez de ser re-hasheado. É o mesmo motor de transferência dos outros modos do relayium.",
      },
      {
        q: "O sync apaga no receptor os arquivos que removi da origem?",
        a: "Só se você pedir. Por padrão sync apenas adiciona e atualiza. Passe --delete para espelhar as exclusões, e o receptor precisa executar serve com --allow-delete para que sejam respeitadas — caso contrário a exclusão é ignorada e reportada de volta.",
      },
      {
        q: "Posso manter duas pastas sincronizadas continuamente?",
        a: "Sim. Adicione --watch e sync continua rodando, reespelhando a qualquer mudança sob a origem. Para uma movimentação única de uma pasta grande você não precisa dele — o laço de repetição mais um sync simples bastam.",
      },
      {
        q: "Preciso abrir uma porta?",
        a: "Para daemon direto, sim — a porta do processo à escuta (9031 por padrão) precisa ser alcançável a partir do emissor. Se você preferir não abrir uma porta e já tiver SSH entre os servidores, sync também funciona sobre SSH: relayium sync /path user@host:/path (relayium precisa estar instalado no remoto).",
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
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
