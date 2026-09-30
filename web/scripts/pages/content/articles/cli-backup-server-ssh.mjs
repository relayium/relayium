// web/scripts/pages/content/articles/cli-backup-server-ssh.mjs
// How-to: back up / sync files to your own server with relayium push/pull over SSH.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Keep an off-host copy on your own server over SSH with the Relayium CLI",
  description:
    "Use relayium push, pull and sync to copy a directory to a server you already SSH into — integrity-checked when relayium is on both ends, and free. Bytes travel over your own SSH connection and never touch Relayium's servers. This makes an off-host copy, not a versioned backup.",
  updatedLabel: "Last updated",
  lead: [
    "If you already have SSH access to a box — a VPS, a home server, a NAS, a workstation — you can put a copy of your files on it with the Relayium CLI without setting up a sync service or an account. The transfer runs over your existing SSH connection, so the bytes go straight to your server and never pass through Relayium.",
    "Be clear about what this gives you: an off-host copy of the files as they are right now. It is not a versioned backup. Nothing here keeps yesterday's version of a file you overwrote, and a scheduled mirror carries a deletion or a corrupted file at the source over to the copy on its next run. If you need to recover a file as it was last week, pair this with snapshots or a backup tool that keeps history.",
    "This guide covers pushing and pulling directories, what the integrity check does and does not cover, why push refuses to run twice into the same destination, and how to keep the copy current on a schedule with cron.",
  ],
  sections: [
    {
      heading: "Push a directory to your server",
      prereqs: {
        label: "What you need",
        items: [
          "SSH access you already use. ssh user@your-server true must return silently — push reuses that exact connection and configures nothing of its own.",
          "A writable destination on the server. The parent of the destination path has to exist and be writable by that SSH user.",
          "Optionally relayium on the server, which is what buys the up-front collision check and per-file SHA-256. Without it push still works, over a plain tar stream that verifies nothing.",
          "No Relayium account and no daemon on either end. Nothing here talks to Relayium's servers.",
        ],
      },
      body: [
        "push takes one or more sources and an scp-style destination. Relayium connects over SSH using your usual keys and config, then streams the files to the destination directory:",
      ],
      steps: [
        {
          text: "Confirm the SSH access push will reuse. A silent return means your keys, host alias and port are already right.",
          code: ["ssh user@your-server true"],
        },
        {
          text: "Find out which protocol you will get. A path means the native protocol — an up-front collision check and per-file SHA-256; no output means the tar-stream fallback, which checks nothing per file.",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "Push the directory. The destination is scp-style, and the trailing slash means \"into this directory\".",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "Override the key or the port for this one command if your ssh config doesn't already cover the host.",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "Confirm what landed. push ./photos reproduces photos/ under the destination, so the folder name travels with it.",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "What a successful run looks like",
        body: [
          "On the native protocol, push prints one line per completed file and exits 0. Against a bare server it prints a single summary line instead — that is the tar fallback, and it is also success.",
        ],
        code: [
          `relayium push ./photos user@your-server:backups/
  photos/IMG_0413.jpg (2314518 bytes)
  photos/IMG_0414.jpg (1998233 bytes)

# against a server with no relayium installed, one summary line instead:
sent 2 file(s) (zero-dependency mode)`,
        ],
      },
      bullets: [
        "It reuses your ~/.ssh/config, so host aliases, keys and ports you already set up just work.",
        "If relayium is installed on the server, it uses the native protocol: the whole batch is checked for collisions before any bytes are sent, and each file it transfers is verified by SHA-256 and staged before it is installed.",
        "If not, it falls back to piping a tar stream into the remote's own tar -x -k, so a bare server with no relayium still works — but that path verifies nothing per file and can leave a batch partly applied.",
      ],
    },
    {
      heading: "Pull files back",
      body: [
        "Restoring is the same command in reverse: give a remote source and a local destination directory. This is how you recover a backup, or sync a server's output down to your laptop:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "Unlike push, pull always needs relayium already installed on the remote — it has no tar fallback, so install it there first if it's missing.",
      ],
    },
    {
      heading: "Integrity is built in — resume is not",
      body: [
        "With relayium on both ends, each file push transfers is verified end to end with a SHA-256 hash and staged before it is installed, so what lands on the server is byte-for-byte what you sent. That much is real, and it is the reason to install relayium on the destination.",
        "What push does not do is resume. It is not a transaction either: files are installed one at a time as they pass, so a connection lost partway through leaves the files that already landed in place — and because those files now exist, re-running the same push is refused by the collision check rather than continuing. Push the missing paths explicitly, or use relayium sync, which is the mode that skips what already matches and does continue a partial file on a later run.",
        "--no-resume is accepted by push and pull and does nothing there. It is real on a serve listener receiving a sync, which is where a partial file can exist in the first place.",
      ],
      bullets: [
        "The SHA-256 check runs automatically; a mismatch is reported and that file is flagged as failed.",
        "It covers what the run transfers. The tar fallback hashes nothing, and sync's size+mtime skip means an unchanged-looking file is never read and so never hashed.",
        "Neither push nor pull resumes, in either protocol. Use sync for a directory you expect to be interrupted.",
      ],
    },
    {
      heading: "Keep the copy current on a schedule with cron",
      body: [
        "Schedule sync, not push. push refuses a destination that already exists, so a nightly push into the same directory succeeds once and is refused every night after that. sync is the mode built for a repeated run: it skips files whose size and modification time are unchanged, sends only what changed, and continues a partial file left by an interrupted run.",
        "It is a single non-interactive command that uses your SSH keys, so it drops straight into cron. Point it at a key with no passphrase (or an agent), and log the output so you can see failures:",
      ],
      code: [
        `# back up every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "A nightly sync that gets interrupted continues the next night: what already matches is skipped, and a partial file is carried on rather than restarted.",
        "sync has no tar fallback, so relayium must be installed on the server. That is a loud failure rather than a silent downgrade.",
        "The command exits non-zero if any file fails its integrity check, so cron's mail-on-failure catches problems.",
        "This keeps the copy current; it keeps no history. Add --delete only if you want a deletion at the source to remove the file on the server too — which is a mirror, and the opposite of what you want if you might delete something by mistake.",
      ],
    },
    {
      heading: "When a scheduled copy doesn't land",
      body: [
        "A scheduled job fails quietly by nature — nobody is watching the terminal. These four are the ones that actually happen, and each is decided by a command you can run right now. They are not the only ways a run can fail: the destination can be out of space, or unwritable by that SSH user.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The cron job hangs, or the log ends at a password prompt.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes refuses to prompt, which turns a silent hang into this line. Add that key's public half to the server's ~/.ssh/authorized_keys, or point the job at a key an agent already holds.",
          },
          {
            symptom: "The crontab line runs but the log stays empty.",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "cron runs with a minimal PATH that usually has no /usr/local/bin, so the line fails before relayium starts. Write the absolute path the check just printed into the crontab entry, and keep the >> ~/relayium-backup.log 2>&1 redirect so the next failure is visible.",
          },
          {
            symptom: "The job reports success every night, but nothing was ever verified.",
            code: [
              `ssh user@your-server command -v relayium
# (prints nothing)`,
            ],
            fix: "No relayium on the remote means push took the tar-stream fallback, which hashes nothing per file and can leave a batch partly applied when a name collides mid-extraction. Install the CLI on the server to get the up-front collision check and per-file SHA-256 back. It also lets you switch the job to relayium sync, which has no fallback at all and fails loudly instead of downgrading silently.",
          },
          {
            symptom: "\"N file(s) could not be verified or saved\" and a non-zero exit.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) could not be verified or saved: [photos/IMG_0413.jpg]
# exit status 1
echo $?
# 1`,
            ],
            fix: "Either the SHA-256 computed on arrival did not match the one sent, or relayium on the server could not save or install the file — no free space, no permission, or a destination path it cannot write to; the message does not say which. The first line is printed by relayium on the server and forwarded over SSH, and exit status 1 is that remote process's exit code. Either way, the native protocol stages each file and installs it only after its hash matches and it has been saved — so this transfer did not install that path. That does not prove nothing is there, since something else may have created it in the meantime, so do not delete anything already at the destination just because of this message. If other files from that batch did land, re-running the whole batch is refused by the collision check, so push that one path on its own, to the same intended destination. If it fails again it is not a one-off transit error: check free space, permissions and the destination path on the server, and look at the source file (something writing to it while it is read).",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do the files go through Relayium's servers?",
        a: "No. push and pull run entirely over your own SSH connection. Relayium's servers are never involved and you need no account.",
      },
      {
        q: "Does the server need relayium installed?",
        a: "It depends on the direction. For push, it's optional: with relayium on the remote you get the native protocol — an up-front collision check and a per-file SHA-256 on everything it transfers — and without it, push falls back to a plain tar stream over SSH, which still works but verifies nothing per file. For pull, it's required: pull always needs relayium on the remote (it has no tar fallback), so install it there first. sync needs it too, for the same reason.",
      },
      {
        q: "How does it choose which SSH key and port to use?",
        a: "It reads your ~/.ssh/config like ssh does, so host aliases, keys and ports are picked up automatically. You can also override them per command with -i for the identity file and -p for the port.",
      },
      {
        q: "Is this faster than rsync?",
        a: "For pushing to your own server it's in the same ballpark as rsync over SSH; the point isn't to beat rsync but to give you one tool that also does cross-network and server-to-server transfers with the same per-file integrity check. On the history question the two are alike: neither rsync nor relayium sync keeps an earlier version of a file, so both are a copy rather than a backup.",
      },
      {
        q: "Is this a backup?",
        a: "It is an off-host copy, which is one part of a backup and not the whole of it. push writes the files as they are now, and a scheduled sync keeps that copy current — which also means it carries over a deletion or an in-place corruption at the source on its next run, and --delete makes the deletion half explicit. Nothing here retains an earlier version, so if you need to recover a file as it was last week, keep snapshots on the destination or use a tool that versions.",
      },
    ],
  },
  cta: {
    text: "Put an off-host copy of your next directory on your own server — over your own SSH, integrity-checked, and free.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 通过 SSH 在自己的服务器上留一份异地副本",
  description:
    "用 relayium push、pull 和 sync 把目录复制到你已经能 ssh 上去的服务器——两端都装了 relayium 时逐文件校验，而且免费。字节走你自己的 SSH 连接，从不经过 Relayium 的服务器。它做出来的是一份异地副本，不是带版本历史的备份。",
  updatedLabel: "最近更新",
  lead: [
    "如果你已经能 ssh 到某台机器上——VPS、家庭服务器、NAS、工作站都算——那就可以用 Relayium CLI 把文件的一份副本放过去，不用搭同步服务，也不用注册账号。传输走的是你现有的 SSH 连接，字节直接进你的服务器，从不经过 Relayium。",
    "先把它能给你什么说清楚：一份此刻状态的异地副本。它不是有版本历史的备份。你覆盖掉的文件，这里不会保留昨天那一版；而定时跑的镜像，会在下一次运行时把源端的删除或损坏一起带过去。如果你需要恢复到上周的样子，请再配一层快照或者会保留历史的备份工具。",
    "本文介绍怎么 push 和 pull 目录、完整性校验覆盖到哪里、为什么 push 不会往同一个目标跑第二次，以及如何用 cron 让这份副本保持最新。",
  ],
  sections: [
    {
      heading: "把一个目录 push 到你的服务器",
      prereqs: {
        label: "你需要准备",
        items: [
          "你已经在用的 SSH 访问权限。ssh user@your-server true 必须静默返回——push 复用的就是这条连接，它自己不做任何额外配置。",
          "服务器上一个可写的落点。目标路径的上一级目录必须存在，且那个 SSH 用户对它有写权限。",
          "服务器上可选装 relayium，它换来的是发送前的冲突预检和逐文件 SHA-256。不装 push 也能用，走一条什么都不校验的普通 tar 流。",
          "不需要 Relayium 账号，两端也都不需要跑守护进程。这里的一切都不会与 Relayium 的服务器通信。",
        ],
      },
      body: [
        "push 接受一个或多个源，以及一个 scp 风格的目标地址。Relayium 会用你平常的密钥和配置通过 SSH 连过去，再把文件流式写入目标目录：",
      ],
      steps: [
        {
          text: "确认 push 将要复用的那条 SSH 访问。静默返回就说明你的密钥、主机别名和端口都已正确。",
          code: ["ssh user@your-server true"],
        },
        {
          text: "查清你会走哪条协议。打印出路径就是原生协议——发送前的冲突预检加逐文件 SHA-256；什么都不打印就是走 tar 流兜底，那条路逐文件什么都不校验。",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "把目录 push 上去。目标是 scp 风格的写法，末尾的斜杠表示“放进这个目录里”。",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "如果你的 ssh 配置里还没有这台主机，就为这一条命令临时指定密钥或端口。",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "确认落地结果。push ./photos 会在目标下重建 photos/，所以文件夹名会一起带过去。",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "成功时你会看到什么",
        body: [
          "走原生协议时，push 每传完一个文件打印一行，并以 0 退出。对着裸机服务器则只打印一行汇总——那是 tar 兜底，同样算成功。",
        ],
        code: [
          `relayium push ./photos user@your-server:backups/
  photos/IMG_0413.jpg (2314518 bytes)
  photos/IMG_0414.jpg (1998233 bytes)

# against a server with no relayium installed, one summary line instead:
sent 2 file(s) (zero-dependency mode)`,
        ],
      },
      bullets: [
        "它会复用你的 ~/.ssh/config，所以你早就配好的主机别名、密钥和端口都能直接生效。",
        "如果服务器上装了 relayium，就走原生协议：发送任何字节之前先对整批做冲突预检，传输的每个文件都做 SHA-256 校验并先落到暂存区再安装。",
        "如果没装，就退回到把 tar 流通过管道送给远端自己的 tar -x -k，所以一台没有 relayium 的裸服务器也能收——但那条路逐文件什么都不校验，而且可能让一批文件只装了一半。",
      ],
    },
    {
      heading: "把文件 pull 回来",
      body: [
        "恢复就是把同一条命令反过来写：给出一个远程源和一个本地目标目录。恢复备份，或者把服务器上的产物同步回笔记本，都用它：",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "和 push 不同，pull 始终需要远端已经装好 relayium——它没有 tar 兜底方案，远端要是没装，请先装好。",
      ],
    },
    {
      heading: "完整性校验是内置的，续传不是",
      body: [
        "两端都装了 relayium 时，push 传输的每个文件都会用 SHA-256 哈希做端到端校验，并先落到暂存区再安装——落到服务器上的内容，和你发出去的逐字节一致。这一半是真的，也正是值得在目标端装上 relayium 的理由。",
        "push 不做的事情是续传。它也不是事务：文件是一个一个装上去的，所以中途断线会把已经落地的文件留在原地——而正因为这些文件现在存在了，重跑同一条 push 会被冲突检查拒绝，而不是接着传。请显式补传缺失的路径，或者改用 relayium sync：它才是会跳过已匹配文件、并在下次运行时接着传半截文件的那个模式。",
        "--no-resume 在 push 和 pull 上能被接受，但什么也不做。它只在接收 sync 的 serve 监听端上才是真的有效——那里才可能出现半截文件。",
      ],
      bullets: [
        "SHA-256 校验会自动进行；一旦对不上就会报出来，该文件被标记为失败。",
        "它覆盖的是这一次真正传输的内容。tar 兜底路径不做任何哈希；而 sync 的 size+mtime 跳过意味着看起来没变的文件根本不会被读取，也就不会被哈希。",
        "push 和 pull 在两条协议下都不续传。预计会被中断的目录，请用 sync。",
      ],
    },
    {
      heading: "用 cron 让这份副本保持最新",
      body: [
        "要放进 cron 的是 sync，不是 push。push 会拒绝已存在的目标，所以每晚往同一个目录 push，只有第一晚会成功，之后每晚都被拒。sync 才是为反复运行设计的：它跳过大小与修改时间都没变的文件，只发变化的部分，并接着传上一次中断留下的半截文件。",
        "它是一条用你自己 SSH 密钥的非交互式命令，所以可以原样放进 cron。给它指定一个没有口令的密钥（或者用 agent），并把输出记下来，好让失败能被看见：",
      ],
      code: [
        `# 每晚 2 点备份——加到你的 crontab 里（crontab -e）
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "一个被中断的夜间 sync，下一晚会接着来：已经匹配的会被跳过，半截的文件会接着传而不是重头来。",
        "sync 没有 tar 兜底，所以服务器上必须装有 relayium。那是一次响亮的失败，而不是悄悄降级。",
        "只要有文件没通过完整性校验，命令就会以非零状态退出，cron 的失败邮件通知就能发现问题。",
        "它保持的是副本的最新状态，不保存历史。只有当你确实希望源端的删除也在服务器上生效时才加 --delete——那就是镜像，而如果你可能误删东西，这恰恰是你不想要的。",
      ],
    },
    {
      heading: "定时副本没落地的时候",
      body: [
        "定时任务天生就是悄无声息地失败的——没人盯着终端。下面四种是真正会发生的，而且每一种都能用一条你现在就能跑的命令定性。它们并不是全部：目标端也可能磁盘满了，或者那个 SSH 用户没有写权限。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "cron 任务卡住，或者日志停在一个输入密码的提示上。",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes 会拒绝弹出提示，于是把静默的卡死变成了这一行。把这把密钥的公钥加到服务器的 ~/.ssh/authorized_keys 里，或者让任务改用 agent 已经持有的那把密钥。",
          },
          {
            symptom: "crontab 那行跑了，日志却始终是空的。",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "cron 用的是一份极简 PATH，通常不含 /usr/local/bin，所以那行在 relayium 启动之前就失败了。把刚才查出来的绝对路径写进 crontab 条目里，并保留 >> ~/relayium-backup.log 2>&1 重定向，好让下一次失败看得见。",
          },
          {
            symptom: "任务每晚都报成功，但其实什么都没有被校验过。",
            code: [
              `ssh user@your-server command -v relayium
# （什么都不打印）`,
            ],
            fix: "远端没有 relayium，就意味着 push 走了 tar 流兜底：它逐文件不做任何哈希，而且在解压中途遇到重名时可能让一批文件只装了一半。在服务器上装好 CLI，就能把发送前的冲突预检和逐文件 SHA-256 拿回来。装好之后你还可以把这个任务改成 relayium sync——它根本没有兜底路径，会响亮地失败而不是悄悄降级。",
          },
          {
            symptom: "出现 “N file(s) could not be verified or saved”，并以非 0 退出。",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) could not be verified or saved: [photos/IMG_0413.jpg]
# exit status 1
echo $?
# 1`,
            ],
            fix: "要么落地时算出的 SHA-256 与发送时的不一致，要么服务器上的 relayium 没能保存或安装这个文件（磁盘空间不足、没有权限，或目标路径无法写入）；这条消息不区分是哪一种。第一行由服务器上的 relayium 打印、经 SSH 转发过来，后面的 exit status 1 是那个远程进程的退出码。无论哪种，原生协议都会先把每个文件写到暂存区，只有校验一致并且保存成功才安装，所以这次传输没有安装那个路径。但这并不能证明目标位置什么都没有——期间可能有别的程序创建了它——所以不要仅仅因为这条消息就删除接收端已有的文件。如果同一批里有其他文件已经落地，整批重跑会被冲突检查拒绝，所以单独 push 那一个路径，目标仍是原来打算的位置。如果它反复失败，就不是一次偶发的链路错误：检查服务器上的剩余空间、权限和目标路径，并查源文件（读取时是否正被写入）。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "文件会经过 Relayium 的服务器吗？",
        a: "不会。push 和 pull 完全跑在你自己的 SSH 连接上。Relayium 的服务器全程不参与，也不需要账号。",
      },
      {
        q: "服务器需要装 relayium 吗？",
        a: "要看方向。对 push 来说是可选的：远端装了 relayium 就能走原生协议——发送前对整批做冲突预检，并对它传输的每个文件做 SHA-256 校验；没装的话，push 会退回到通过 SSH 传输 tar 流，依然可用，只是逐文件什么都不校验。对 pull 来说则是必须的：pull 始终需要远端装有 relayium（它没有 tar 兜底方案），请先在远端装好。sync 同理，也必须装。",
      },
      {
        q: "它怎么决定用哪个 SSH 密钥和端口？",
        a: "它会像 ssh 一样读取你的 ~/.ssh/config，所以主机别名、密钥和端口都会被自动识别。你也可以在单条命令里用 -i 指定身份文件、用 -p 指定端口来覆盖它们。",
      },
      {
        q: "这比 rsync 快吗？",
        a: "在推送到自己服务器这件事上，速度和走 SSH 的 rsync 差不多。重点不是跑赢 rsync，而是让你只用一个工具，就能顺带做跨网络传输和服务器之间的传输，并且沿用同一套逐文件完整性校验。在历史这件事上两者也一样：rsync 和 relayium sync 都不保留文件的旧版本，所以都是副本，而不是备份。",
      },
      {
        q: "这算备份吗？",
        a: "它是一份异地副本——那是备份的一部分，但不是全部。push 写下的是文件此刻的样子，而定时 sync 让这份副本保持最新，这也意味着它会在下一次运行时把源端的删除或原地损坏一起带过去，加上 --delete 更是把删除这一半明确打开。这里没有任何东西会保留旧版本，所以如果你需要恢复到上周的样子，请在目标端保留快照，或者改用会做版本管理的工具。",
      },
    ],
  },
  cta: {
    text: "把你的下一个目录放一份异地副本到自己的服务器上——走你自己的 SSH，逐文件校验，而且免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI と SSH でサーバーをバックアップする（廃止）",
  description: "Relayium の SSH 転送、relayium pull、-i と -p は廃止されました。このアーカイブページには実行できるコマンドはもう載っていません。代わりに relayium serve と relayium://host への push または sync を使ってください。",
  updatedLabel: "最終更新",
  lead: [
    "過去の記述についての注記：このページでは、Relayium の SSH 転送（user@host:path 形式の宛先への push や sync、relayium pull、-i と -p オプション）でサーバーをバックアップする方法を説明していました。現在の CLI ではこの転送方式は廃止され、「SSH transfers are currently disabled」と表示して拒否されるため、ここにあったコマンドはもう動作せず、掲載していません。",
    "ページ上部からリンクしている、保守されている英語版と簡体字中国語版が代わりの方法を説明しています。受信側のサーバーで relayium serve を実行し、証明書ピンニング付き TLS で relayium://host へ push または sync します。これは現在の状態のコピーであって、バージョン履歴を持つバックアップではありません。"
  ],
  sections: [
    {
      heading: "代わりに使うもの",
      body: [
        "受信側のサーバーで送信側のフィンガープリント（送信側で relayium id が表示します）を承認し、リスナーを起動します。そのうえで、一度きりのコピーには push、繰り返し実行する一方向ミラーには sync を使います。"
      ],
      code: [
        "relayium authorize <sender-fingerprint>",
        "relayium serve --dir ~/backups",
        "relayium sync ./photos relayium://server.example"
      ]
    }
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "古い SSH の書き方を使い続けられますか？",
        a: "いいえ。現在の CLI は、SSH の宛先、relayium pull、-i と -p を、1バイトも転送する前に拒否します。SSH は別の管理ツールとして引き続き使えますが、Relayium のデータ転送手段ではありません。"
      }
    ]
  },
  cta: {
    text: "サーバーのコピー作業をデーモン直結に移しましょう。",
    button: "CLI を入手",
    href: "/cli"
  },
  relatedHeading: "続けて読む"
};

const ko = {
  title: "Relayium CLI로 SSH를 통해 서버 백업하기(폐지됨)",
  description: "Relayium의 SSH 전송, relayium pull, -i와 -p는 폐지되었습니다. 이 보관 페이지에는 더 이상 실행 가능한 명령이 없습니다. 대신 relayium serve와 relayium://host로의 push 또는 sync를 사용하세요.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "이전 내용에 대한 안내: 이 페이지는 Relayium의 SSH 전송(user@host:path 형식 대상으로의 push 또는 sync, relayium pull, -i 및 -p 옵션)으로 서버를 백업하는 방법을 설명했습니다. 현재 CLI에서는 이 전송 방식이 폐지되어 \"SSH transfers are currently disabled\"라는 메시지와 함께 거부되므로, 여기에 있던 명령은 더 이상 동작하지 않으며 싣지 않습니다.",
    "페이지 상단에서 링크한, 유지 관리되는 영어판과 중국어 간체판이 대체 방법을 설명합니다. 받는 서버에서 relayium serve를 실행하고 인증서 고정 TLS로 relayium://host에 push 또는 sync합니다. 이는 현재 상태의 복사본이지, 버전 기록이 있는 백업이 아닙니다."
  ],
  sections: [
    {
      heading: "대신 사용할 것",
      body: [
        "받는 서버에서 보내는 쪽의 지문(보내는 쪽에서 relayium id가 출력)을 승인하고 리스너를 시작합니다. 그런 다음 일회성 복사에는 push를, 반복 실행하는 단방향 미러에는 sync를 사용합니다."
      ],
      code: [
        "relayium authorize <sender-fingerprint>",
        "relayium serve --dir ~/backups",
        "relayium sync ./photos relayium://server.example"
      ]
    }
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "예전 SSH 문법을 계속 쓸 수 있나요?",
        a: "아니요. 현재 CLI는 SSH 대상, relayium pull, -i와 -p를 바이트를 하나도 전송하기 전에 거부합니다. SSH는 별도의 관리 도구로 계속 쓸 수 있지만, Relayium의 데이터 전송 수단은 아닙니다."
      }
    ]
  },
  cta: {
    text: "서버 복사 작업을 데몬 다이렉트로 옮기세요.",
    button: "CLI 받기",
    href: "/cli"
  },
  relatedHeading: "계속 읽기"
};

const de = {
  title: "Einen Server über SSH mit der Relayium CLI sichern (eingestellt)",
  description: "Relayiums SSH-Transport, relayium pull, -i und -p sind eingestellt. Diese archivierte Seite zeigt keine ausführbaren Befehle mehr; nutze stattdessen relayium serve mit push oder sync zu relayium://host.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Historischer Hinweis: Diese Seite beschrieb, wie man einen Server mit Relayiums SSH-Transport sichert — push oder sync zu einem Ziel der Form user@host:path, relayium pull sowie die Optionen -i und -p. Die aktuelle CLI hat diesen Transport eingestellt und lehnt ihn mit „SSH transfers are currently disabled“ ab; die Befehle, die hier standen, funktionieren daher nicht mehr und werden nicht mehr gezeigt.",
    "Die gepflegte englische und vereinfacht-chinesische Fassung dieser Seite, oben verlinkt, beschreiben den Ersatz: relayium serve auf dem empfangenden Server und push oder sync zu relayium://host über TLS mit Pinning. Das ergibt eine Kopie des aktuellen Stands, kein versioniertes Backup."
  ],
  sections: [
    {
      heading: "Was du stattdessen nutzt",
      body: [
        "Autorisiere auf dem empfangenden Server den Fingerabdruck des Absenders (relayium id gibt ihn auf dem Absender aus) und starte einen Listener; nutze dann push für eine einmalige Kopie oder sync für einen wiederholten Einweg-Spiegel."
      ],
      code: [
        "relayium authorize <sender-fingerprint>",
        "relayium serve --dir ~/backups",
        "relayium sync ./photos relayium://server.example"
      ]
    }
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kann ich die alte SSH-Syntax weiter verwenden?",
        a: "Nein. Die aktuelle CLI lehnt SSH-Ziele, relayium pull, -i und -p ab, bevor ein Byte übertragen wird. SSH bleibt ein eigenes Administrationswerkzeug, ist aber kein Datentransport von Relayium."
      }
    ]
  },
  cta: {
    text: "Verlege deinen Server-Kopierjob auf daemon-direct.",
    button: "CLI holen",
    href: "/cli"
  },
  relatedHeading: "Weiterlesen"
};

const fr = {
  title: "Sauvegarder un serveur via SSH avec la CLI Relayium (retiré)",
  description: "Le transport SSH de Relayium, relayium pull, -i et -p sont retirés. Cette page archivée ne montre plus de commandes exécutables ; utilisez plutôt relayium serve avec push ou sync vers relayium://host.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Note historique : cette page expliquait comment sauvegarder un serveur avec le transport SSH de Relayium — push ou sync vers une destination user@host:path, relayium pull et les options -i et -p. La CLI actuelle a retiré ce transport et le refuse avec « SSH transfers are currently disabled » ; les commandes qui figuraient ici ne fonctionnent donc plus et ne sont plus affichées.",
    "Les versions anglaise et chinoise simplifiée maintenues de cette page, liées en haut, décrivent la solution de remplacement : relayium serve sur le serveur destinataire, puis push ou sync vers relayium://host via TLS avec épinglage. On obtient une copie de l'état actuel, pas une sauvegarde versionnée."
  ],
  sections: [
    {
      heading: "Ce qu'il faut utiliser à la place",
      body: [
        "Sur le serveur destinataire, autorisez l'empreinte de l'expéditeur (relayium id l'affiche sur l'expéditeur) et démarrez un écouteur ; utilisez ensuite push pour une copie ponctuelle, ou sync pour un miroir à sens unique répété."
      ],
      code: [
        "relayium authorize <sender-fingerprint>",
        "relayium serve --dir ~/backups",
        "relayium sync ./photos relayium://server.example"
      ]
    }
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Puis-je continuer à utiliser l'ancienne syntaxe SSH ?",
        a: "Non. La CLI actuelle refuse les destinations SSH, relayium pull, -i et -p avant de transférer le moindre octet. SSH reste un outil d'administration à part, mais ce n'est pas un transport de données de Relayium."
      }
    ]
  },
  cta: {
    text: "Passez votre tâche de copie de serveur au daemon-direct.",
    button: "Obtenir la CLI",
    href: "/cli"
  },
  relatedHeading: "À lire ensuite"
};

const ar = {
  title: "النسخ الاحتياطي لخادم عبر SSH باستخدام Relayium CLI (موقوف)",
  description: "أُوقف نقل SSH في Relayium وrelayium pull والخياران -i و-p. لم تعد هذه الصفحة المؤرشفة تعرض أوامر قابلة للتشغيل؛ استخدم بدلًا منها relayium serve مع push أو sync إلى relayium://host.",
  updatedLabel: "آخر تحديث",
  lead: [
    "ملاحظة تاريخية: كانت هذه الصفحة تشرح النسخ الاحتياطي لخادم عبر نقل SSH في Relayium — أي push أو sync إلى وجهة بصيغة user@host:path، وrelayium pull، والخيارين -i و-p. وقد أوقف CLI الحالي هذا النقل ويرفضه برسالة «SSH transfers are currently disabled»، لذا لم تعد الأوامر التي كانت هنا تعمل ولم تعد معروضة.",
    "تشرح النسختان الإنجليزية والصينية المبسّطة المُحدَّثتان من هذه الصفحة، المرتبطتان في أعلاها، البديل: relayium serve على خادم الاستقبال، ثم push أو sync إلى relayium://host عبر TLS مُثبَّت. والنتيجة نسخة من الحالة الحالية، لا نسخة احتياطية ذات إصدارات."
  ],
  sections: [
    {
      heading: "ما تستخدمه بدلًا من ذلك",
      body: [
        "على خادم الاستقبال، اعتمد بصمة المُرسِل (يطبعها relayium id على جهاز الإرسال) وشغّل مستمعًا؛ ثم استخدم push لنسخة لمرة واحدة، أو sync لمرآة أحادية الاتجاه متكررة."
      ],
      code: [
        "relayium authorize <sender-fingerprint>",
        "relayium serve --dir ~/backups",
        "relayium sync ./photos relayium://server.example"
      ]
    }
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يمكنني الاستمرار في استخدام صيغة SSH القديمة؟",
        a: "لا. يرفض CLI الحالي وجهات SSH وrelayium pull والخيارين -i و-p قبل نقل أي بايت. ويظل SSH أداة إدارة مستقلة، لكنه ليس وسيلة لنقل بيانات Relayium."
      }
    ]
  },
  cta: {
    text: "انقل مهمة نسخ الخادم لديك إلى daemon direct.",
    button: "احصل على CLI",
    href: "/cli"
  },
  relatedHeading: "تابع القراءة"
};

const es = {
  title: "Copias de seguridad de un servidor por SSH con la CLI de Relayium (retirado)",
  description: "El transporte SSH de Relayium, relayium pull, -i y -p están retirados. Esta página archivada ya no muestra comandos ejecutables; usa en su lugar relayium serve con push o sync a relayium://host.",
  updatedLabel: "Última actualización",
  lead: [
    "Nota histórica: esta página explicaba cómo hacer copias de seguridad de un servidor con el transporte SSH de Relayium: push o sync a un destino user@host:path, relayium pull y las opciones -i y -p. El CLI actual ha retirado ese transporte y lo rechaza con «SSH transfers are currently disabled», así que los comandos que había aquí ya no funcionan y no se muestran.",
    "Las versiones mantenidas en inglés y en chino simplificado de esta página, enlazadas arriba, describen el reemplazo: relayium serve en el servidor receptor y push o sync a relayium://host sobre TLS con anclaje. El resultado es una copia del estado actual, no una copia de seguridad con versiones."
  ],
  sections: [
    {
      heading: "Qué usar en su lugar",
      body: [
        "En el servidor receptor, autoriza la huella del remitente (relayium id la imprime en el remitente) e inicia un receptor; luego usa push para una copia puntual, o sync para un espejo de un solo sentido repetido."
      ],
      code: [
        "relayium authorize <sender-fingerprint>",
        "relayium serve --dir ~/backups",
        "relayium sync ./photos relayium://server.example"
      ]
    }
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Puedo seguir usando la sintaxis SSH antigua?",
        a: "No. El CLI actual rechaza los destinos SSH, relayium pull, -i y -p antes de transferir un solo byte. SSH sigue siendo una herramienta de administración aparte, pero no es un transporte de datos de Relayium."
      }
    ]
  },
  cta: {
    text: "Pasa tu tarea de copia de servidor a daemon directo.",
    button: "Obtener la CLI",
    href: "/cli"
  },
  relatedHeading: "Sigue leyendo"
};

const pt = {
  title: "Backup de um servidor via SSH com a CLI do Relayium (descontinuado)",
  description: "O transporte SSH do Relayium, relayium pull, -i e -p foram descontinuados. Esta página arquivada não mostra mais comandos executáveis; use no lugar relayium serve com push ou sync para relayium://host.",
  updatedLabel: "Última atualização",
  lead: [
    "Nota histórica: esta página explicava como fazer backup de um servidor com o transporte SSH do Relayium — push ou sync para um destino user@host:path, relayium pull e as opções -i e -p. A CLI atual descontinuou esse transporte e o recusa com “SSH transfers are currently disabled”, então os comandos que estavam aqui não funcionam mais e não são mostrados.",
    "As versões mantidas em inglês e chinês simplificado desta página, com links no topo, descrevem a substituição: relayium serve no servidor de destino e push ou sync para relayium://host sobre TLS com fixação. O resultado é uma cópia do estado atual, não um backup com versões."
  ],
  sections: [
    {
      heading: "O que usar no lugar",
      body: [
        "No servidor de destino, autorize a impressão digital do remetente (o relayium id a mostra no remetente) e inicie um receptor; depois use push para uma cópia pontual, ou sync para um espelho de mão única repetido."
      ],
      code: [
        "relayium authorize <sender-fingerprint>",
        "relayium serve --dir ~/backups",
        "relayium sync ./photos relayium://server.example"
      ]
    }
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Posso continuar usando a sintaxe SSH antiga?",
        a: "Não. A CLI atual recusa destinos SSH, relayium pull, -i e -p antes de transferir qualquer byte. O SSH continua sendo uma ferramenta de administração à parte, mas não é um transporte de dados do Relayium."
      }
    ]
  },
  cta: {
    text: "Passe a sua tarefa de cópia de servidor para o daemon direto.",
    button: "Obter a CLI",
    href: "/cli"
  },
  relatedHeading: "Continue lendo"
};

const currentEn = {
  title: "Migrate an old SSH backup command to Relayium daemon-direct",
  description: "SSH transport, relayium pull, -i and -p are retired. Replace old server copy commands with serve plus relayium:// push or sync.",
  updatedLabel: "Last updated",
  lead: [
    "This URL used to document Relayium's SSH transport. That transport is retired: current push and sync accept relayium:// destinations only, and relayium pull is unavailable.",
    "For an off-host copy on a machine you manage, run relayium serve on the receiver and push or sync directly over pinned TLS. This is a current-state copy, not a versioned backup.",
  ],
  sections: [
    { heading: "Prepare the receiving server", prereqs: { label: "What you need", items: ["Relayium installed on both the sending and receiving machines.", "A reachable TCP port (9031 by default) restricted to the sender.", "An existing receive directory writable by the listener account."] }, steps: [
      { text: "Create the directory that will receive the copy.", code: ["mkdir -p ~/backups"] },
      { text: "On the sender, print the fingerprint that the receiver will authorize.", code: ["relayium id"] },
      { text: "On the receiver, authorize that fingerprint. Use the same --config-dir here and when starting serve.", code: ["relayium authorize <sender-fingerprint>"] },
      { text: "Start the receiver on the intended interface.", code: ["relayium serve --dir ~/backups --bind 10.0.0.12"] },
    ], success: { label: "What a ready receiver looks like", body: ["serve reports the bound address, receive directory and receiver fingerprint, then stays running for authorized pushes."], code: ["relayium serve: listening on 10.0.0.12:9031, receiving into /home/you/backups (fingerprint 5c1d9f04…)"] }, bullets: ["Use the same --config-dir for authorize and serve.", "For unattended use, pre-authorize the sender; an unknown sender is rejected when no terminal can prompt."] },
    { heading: "Send one copy or maintain a mirror", body: ["Use push for a collision-safe one-time copy and sync for a repeated one-way mirror."], code: ["relayium push ./photos relayium://server.example", "relayium sync ./photos relayium://server.example --watch"], bullets: ["push never overwrites and does not resume.", "sync skips files by size and modification time and continues partial files across runs.", "sync --delete requires the listener's explicit --allow-delete consent."] },
    { heading: "Replace old scripts safely", body: ["Remove host:path destinations, relayium pull, -i and -p from Relayium commands. SSH remains a separate administration tool, but it is not a Relayium data transport."], bullets: ["Use snapshots or another history-preserving backup layer if you need older versions.", "A scheduled mirror carries source deletions or corruption over on its next run; keep independent history.", "Log scheduled sync output and alert on non-zero exits.", "Restrict the listener with --bind and a firewall."], troubleshooting: { label: "Troubleshooting", items: [
      { symptom: "The sender is rejected as unauthorized", code: ["relayium id"], fix: "Authorize that exact sender fingerprint on the receiver, using the same --config-dir that the serve process uses." },
      { symptom: "The listener exits before binding", code: ["test -d ~/backups && test -w ~/backups"], fix: "Create ~/backups and grant the listener account write access to that exact directory, then start relayium serve again." },
      { symptom: "The sender cannot reach the listener", code: ["curl -v telnet://10.0.0.12:9031"], fix: "Check the --bind address and allow TCP 9031 from the sender in both the host firewall and cloud firewall." },
      { symptom: "A transfer exits non-zero", code: ["relayium sync ./photos relayium://server.example"], fix: "Read the reported path and error, correct permissions or capacity, and rerun sync; completed files are skipped by size and modification time." },
    ] } },
  ],
  faq: { heading: "Frequently asked questions", items: [
    { q: "Can I keep using the old SSH syntax?", a: "Not with the current CLI. It rejects SSH destinations before transferring bytes." },
    { q: "How do I restore files?", a: "Relayium has no current pull command. Restore from the receiver using your normal administrative access or initiate a new daemon-direct transfer in the opposite direction." },
    { q: "Is sync a backup?", a: "It is a current-state mirror. It keeps no history, and --delete deliberately propagates deletions." },
  ] },
  cta: { text: "Move your server copy job to daemon-direct.", button: "Get the CLI", href: "/cli" },
  relatedHeading: "Keep reading",
};

const currentZh = {
  title: "把旧 SSH 备份命令迁移到 Relayium daemon 直连",
  description: "SSH 传输、relayium pull、-i 与 -p 已退役。用 serve 加 relayium:// push 或 sync 替换旧服务器复制命令。",
  updatedLabel: "最近更新",
  lead: ["这个网址过去介绍 Relayium 的 SSH 传输。该传输已经退役：当前 push 与 sync 只接受 relayium:// 目标，relayium pull 不可用。", "要在自己管理的机器上保留异地副本，请在接收端运行 relayium serve，再通过证书固定 TLS 直接 push 或 sync。它保存的是当前状态，不是带版本历史的备份。"],
  sections: [
    { heading: "准备接收服务器", prereqs: { label: "你需要准备", items: ["发送端和接收端两台机器都已经安装 Relayium。", "一个仅向发送端开放的可达 TCP 端口（默认 9031）。", "一个已经存在、监听进程账户可以写入的接收目录。"] }, steps: [
      { text: "创建用于接收副本的目录。", code: ["mkdir -p ~/backups"] },
      { text: "在发送端输出需要由接收端授权的指纹。", code: ["relayium id"] },
      { text: "在接收端授权该指纹；这里与启动 serve 时必须使用同一个 --config-dir。", code: ["relayium authorize <sender-fingerprint>"] },
      { text: "让接收端在预期网络接口上启动监听。", code: ["relayium serve --dir ~/backups --bind 10.0.0.12"] },
    ], success: { label: "接收端就绪时会看到", body: ["serve 会报告监听地址、接收目录和接收端指纹，然后持续等待已授权发送端。"], code: ["relayium serve: listening on 10.0.0.12:9031, receiving into /home/you/backups (fingerprint 5c1d9f04…)"] }, bullets: ["authorize 与 serve 使用同一个 --config-dir。", "无人值守时要提前授权；没有终端可询问时，未知发送端会被拒绝。"] },
    { heading: "发送一次副本或持续镜像", body: ["一次性、拒绝冲突的复制用 push；反复运行的单向镜像用 sync。"], code: ["relayium push ./photos relayium://server.example", "relayium sync ./photos relayium://server.example --watch"], bullets: ["push 不覆盖，也不续传。", "sync 按大小与修改时间跳过文件，并能跨运行继续半截文件。", "sync --delete 还需要监听端显式启用 --allow-delete。"] },
    { heading: "安全替换旧脚本", body: ["从 Relayium 命令中移除 host:path 目标、relayium pull、-i 与 -p。SSH 仍可独立用于系统管理，但不再是 Relayium 的数据传输通道。"], bullets: ["需要旧版本恢复能力时，另加快照或保留历史的备份工具。", "定时镜像会在下次运行时把源端删除或损坏同步过去，因此要保留独立历史。", "记录定时 sync 的输出，并对非零退出报警。", "用 --bind 与防火墙限制监听端。"], troubleshooting: { label: "故障排查", items: [
      { symptom: "发送端因未授权而被拒绝", code: ["relayium id"], fix: "在接收端授权这个发送端的准确指纹，并确保使用与 serve 进程相同的 --config-dir。" },
      { symptom: "监听端在绑定端口前退出", code: ["test -d ~/backups && test -w ~/backups"], fix: "创建 ~/backups，让监听进程账户能够写入这个准确目录，然后重新启动 relayium serve。" },
      { symptom: "发送端无法连接监听端", code: ["curl -v telnet://10.0.0.12:9031"], fix: "检查 --bind 地址，并在主机与云防火墙中仅允许发送端访问 TCP 9031。" },
      { symptom: "传输以非零状态退出", code: ["relayium sync ./photos relayium://server.example"], fix: "根据报告的路径和错误修正权限或容量，再运行 sync；已完成文件会按大小和修改时间跳过。" },
    ] } },
  ],
  faq: { heading: "常见问题", items: [
    { q: "还能继续用旧 SSH 语法吗？", a: "当前 CLI 不行。它会在传输任何字节之前拒绝 SSH 目标。" },
    { q: "怎样恢复文件？", a: "Relayium 当前没有 pull 命令。请用普通管理通道从接收端恢复，或反向发起一次新的 daemon 直连传输。" },
    { q: "sync 是备份吗？", a: "它是当前状态的镜像，不保留历史；--delete 还会有意传播删除。" },
  ] },
  cta: { text: "把服务器复制任务迁移到 daemon 直连。", button: "获取 CLI", href: "/cli" },
  relatedHeading: "继续阅读",
};

export default {
  slug: "guides/back-up-a-server-over-ssh",
  published: "2026-07-08",
  updated: "2026-09-01",
  langs: withInstall({ en: currentEn, zh: currentZh, ja, ko, de, fr, ar, es, pt }),
};
