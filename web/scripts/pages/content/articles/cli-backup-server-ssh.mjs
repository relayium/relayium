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
            symptom: "\"N file(s) failed integrity check\" and a non-zero exit.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "The SHA-256 computed on arrival did not match the one sent, and the native protocol stages each file and installs it only once the hash matches — so that path was never written to the server, and there is nothing to remove there. Re-running the whole batch is still refused by the collision check, because the other files from that batch already landed, so push that one path on its own. If it fails again it is not a one-off transit error: look at the source file (something writing to it while it is read) and at the storage on either end.",
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
            symptom: "出现 “N file(s) failed integrity check”，并以非 0 退出。",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "落地时算出的 SHA-256 与发送时的不一致；原生协议会先把每个文件写到暂存区，只有校验一致才安装，所以那个路径根本没写到服务器上，接收端没有东西需要删。整批重跑仍然会被冲突检查拒绝——同一批里其他文件已经落地了——所以单独 push 那一个路径。如果它反复失败，就不是一次偶发的链路错误：去查源文件（读取时是否正被写入）和两端的存储。",
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
  title: "Relayium CLI と SSH で自分のサーバーにファイルをバックアップする",
  description:
    "relayium push と pull を使って、すでに ssh でアクセスできるサーバーへディレクトリをコピーまたは同期。両端に relayium があればファイル単位で整合性チェックされ、しかも無料。バイトは自分の SSH 接続を通り、Relayium のサーバーには一切触れません。",
  updatedLabel: "最終更新",
  lead: [
    "VPS、自宅サーバー、NAS、ワークステーションなど、すでに ssh でアクセスできるマシンがあれば、同期サービスやアカウントを用意しなくても Relayium CLI でそこへファイルをバックアップできます。転送は既存の SSH 接続の上で行われるため、バイトは直接自分のサーバーへ向かい、Relayium を通ることはありません。",
    "本ガイドではディレクトリの push と pull、整合性チェックが何を保証し何を保証しないか、なぜ push は同じ宛先へ二度目を拒否するのか、そして cron でスケジュール実行する方法を扱います。",
  ],
  sections: [
    {
      heading: "ディレクトリをサーバーへ push する",
      prereqs: {
        label: "必要なもの",
        items: [
          "すでに使っている SSH アクセス。ssh user@your-server true が黙って戻ることが条件です。push はまさにその接続を再利用し、独自の設定は何も持ちません。",
          "サーバー側の書き込み可能な宛先。宛先パスの親ディレクトリが存在し、その SSH ユーザーが書き込めることが必要です。",
          "任意で、サーバー側の relayium。送信前の衝突チェックとファイル単位の SHA-256 はこれで得られます。なくても push は素の tar ストリームで動きますが、そちらは何も検証しません。",
          "Relayium アカウントも、どちらの端のデーモンも不要です。ここでは Relayium のサーバーと通信するものは何もありません。",
        ],
      },
      body: [
        "push は1つ以上のソースと scp 形式の宛先を受け取ります。Relayium はいつも使っている鍵と設定を使って SSH 経由で接続し、ファイルを宛先ディレクトリへストリーミングします：",
      ],
      steps: [
        {
          text: "push が再利用する SSH アクセスを確認します。黙って戻れば、鍵もホストエイリアスもポートもすでに正しいということです。",
          code: ["ssh user@your-server true"],
        },
        {
          text: "どちらのプロトコルになるかを調べます。パスが表示されればネイティブプロトコル（送信前の衝突チェックとファイル単位の SHA-256）、何も出なければ tar ストリームの方で、こちらはファイル単位では何も検証しません。",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "ディレクトリを push します。宛先は scp 形式で、末尾のスラッシュは「このディレクトリの中へ」を意味します。",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "ssh の設定にそのホストがまだ無い場合は、このコマンドに限って鍵やポートを指定します。",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "何が届いたかを確認します。push ./photos は宛先の下に photos/ を再現するので、フォルダー名もそのまま付いてきます。",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "成功したときの表示",
        body: [
          "ネイティブプロトコルなら、push は完了したファイルごとに1行を表示して終了コード 0 で終わります。素のサーバー相手なら要約が1行出るだけで、それが tar フォールバックであり、これも成功です。",
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
        "既存の ~/.ssh/config を再利用するので、すでに設定済みのホストエイリアス、鍵、ポートがそのまま使えます。",
        "サーバーに relayium がインストールされていれば、ネイティブプロトコルを使います。送信前にバッチ全体の衝突チェックを行い、転送する各ファイルを SHA-256 で検証してから設置します。",
        "インストールされていない場合は、tar ストリームをリモートへパイプする方式にフォールバックするので、relayium のない素のサーバーでも動作します。",
      ],
    },
    {
      heading: "ファイルを pull で戻す",
      body: [
        "復元は同じコマンドを逆にするだけです。リモートのソースとローカルの宛先ディレクトリを指定します。これがバックアップを復元したり、サーバーの出力をノート PC に同期したりする方法です：",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "push と異なり、pull は常にリモートに relayium がすでにインストールされている必要があります。tar フォールバックがないため、なければ先にそちらへインストールしてください。",
      ],
    },
    {
      heading: "整合性は標準で備わっている——再開は備わっていない",
      body: [
        "relayium が両端にあれば、push が転送する各ファイルは SHA-256 ハッシュでエンドツーエンドに検証され、暫定領域に置かれてから設置されます。サーバーに届くものは送ったものとバイト単位で同一です。ここまでは本当で、宛先に relayium を入れる理由もそこにあります。",
        "push がしないのは再開です。ファイルは通過した順に1つずつ設置されるため、途中で接続が切れると、すでに届いたファイルはそのまま残ります。そしてそれらが存在するせいで、同じ push をやり直しても衝突チェックに拒否されます。足りないパスを個別に push するか、すでに一致するものを飛ばし、半端なファイルを次回の実行で続けてくれる relayium sync を使ってください。",
        "--no-resume は push と pull でも受け付けられますが、そこでは何もしません。実際に効くのは sync を受ける serve の待ち受け側です——半端なファイルが存在しうるのは、そもそもそこだけだからです。",
      ],
      bullets: [
        "push も pull も、どちらのプロトコルでも再開しません。中断されうるディレクトリには sync を使ってください。tar フォールバックは再開もせず、ファイル単位の検証もしません。",
        "SHA-256 チェックは自動的に実行され、不一致があれば報告され、そのファイルは失敗としてフラグが立てられます。",
      ],
    },
    {
      heading: "cron でスケジュール実行する",
      body: [
        "cron に入れるのは push ではなく sync です。push は既存の宛先を拒否するので、同じディレクトリへ毎晩 push すると初回だけ成功し、以降は毎回拒否されます。sync は繰り返し実行のために作られたモードで、サイズと更新時刻が変わっていないファイルを飛ばし、変わった分だけを送り、中断された実行が残した半端なファイルを続けます。SSH 鍵を使う単一の非対話型コマンドなので、そのまま cron に入ります。パスフレーズなしの鍵（または agent）を指定し、出力をログに残して失敗を確認できるようにしましょう：",
      ],
      code: [
        `# 毎晩2時にバックアップ（crontab -e で crontab に追加）
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "中断された夜間の sync は翌晩そのまま続きます。すでに一致するものは飛ばされ、半端なファイルはやり直しではなく続きから送られます。",
        "いずれかのファイルが整合性チェックに失敗すると、コマンドは非ゼロで終了するので、cron の失敗時メール通知で問題に気づけます。",
      ],
    },
    {
      heading: "バックアップが届かないとき",
      body: [
        "スケジュール実行のバックアップは、その性質上ひっそりと失敗します。誰も端末を見ていないからです。次の4つでほぼ尽きますし、どれも今すぐ実行できるコマンドで判定できます。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "cron ジョブが固まる、またはログがパスワード入力待ちで終わっている。",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes は入力を求めずに失敗するので、無言のハングがこの1行に変わります。その鍵の公開鍵をサーバーの ~/.ssh/authorized_keys に追加するか、エージェントがすでに保持している鍵をジョブに指定してください。",
          },
          {
            symptom: "crontab の行は動いているのにログが空のまま。",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "cron は最小限の PATH で動き、たいてい /usr/local/bin を含みません。そのため relayium が起動する前に行が失敗します。いま確認した絶対パスを crontab のエントリーに書き、>> ~/relayium-backup.log 2>&1 のリダイレクトは残しておいて、次の失敗が見えるようにしてください。",
          },
          {
            symptom: "中断された夜間の sync が、次の実行でゼロからやり直しになる。",
            code: [
              `ssh user@your-server command -v relayium
# （何も表示されない）`,
            ],
            fix: "リモートに relayium が無いということです。sync にはフォールバックが無いのでそもそも動かず、push は何も検証しない tar ストリームに落ちて毎回ファイル全体を送り直します。サーバーに入れてください。半端なファイルを次回に続けるのは sync だけで、push と pull はどちらのプロトコルでも再開しません。すでに sync を使っているなら、その待ち受け側の再開を実際に切る --no-resume を渡していないかも確認してください。",
          },
          {
            symptom: "「N file(s) failed integrity check」と表示され、終了コードが 0 以外になる。",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "到着時に計算した SHA-256 が送信時のものと一致せず、ネイティブプロトコルは各ファイルをいったん暫定領域に置いてハッシュが一致したときだけ設置します。つまりそのパスはサーバーに書き込まれておらず、向こう側に削除すべきものはありません。同じバッチの他のファイルはすでに設置済みなので、バッチ全体をやり直しても衝突チェックに拒否されます。そのパスだけを push し直してください。それでも繰り返し失敗するなら一度きりの転送エラーではありません。元ファイル（読み取り中に何かが書き込んでいないか）と両端のストレージを調べてください。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ファイルは Relayium のサーバーを経由しますか？",
        a: "いいえ。push と pull はすべて自分の SSH 接続の上で完結します。Relayium のサーバーは一切関与せず、アカウントも不要です。",
      },
      {
        q: "サーバーに relayium のインストールは必要ですか？",
        a: "方向によります。push の場合は任意です。リモートに relayium があればネイティブプロトコルが使え、送信前の衝突チェックと、転送するすべてのファイルに対する SHA-256 チェックが得られます。なければ push は SSH 上の tar ストリームにフォールバックし、それでも動作しますが、ファイル単位では何も検証しません。pull の場合は必須です。pull は常にリモート側の relayium を必要とし（tar フォールバックはありません）、先にリモートへインストールしておいてください。",
      },
      {
        q: "どの SSH 鍵とポートを使うかはどう決まりますか？",
        a: "ssh と同じように既存の ~/.ssh/config を読み込むため、ホストエイリアス、鍵、ポートは自動的に反映されます。コマンドごとに -i でアイデンティティファイル、-p でポートを指定して上書きすることもできます。",
      },
      {
        q: "これは rsync より速いですか？",
        a: "自分のサーバーへの push に関しては、SSH 経由の rsync とほぼ同等です。狙いは rsync に勝つことではなく、同じファイル単位の整合性チェックを備えたまま、クロスネットワーク転送やサーバー間転送もこなせる1つのツールを提供することです。",
      },
    ],
  },
  cta: {
    text: "次のディレクトリを直接の方法でバックアップしましょう。自分の SSH 経由、ファイル単位の整合性チェック付きで無料です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 SSH를 통해 자신의 서버에 파일 백업하기",
  description:
    "relayium push와 pull로 이미 ssh로 접속하는 서버에 디렉터리를 복사하거나 동기화하세요 — 양쪽에 relayium이 있으면 파일별로 무결성 검사가 되며 무료입니다. 바이트는 내 SSH 연결을 통해 이동하며 Relayium의 서버를 전혀 거치지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "VPS, 홈 서버, NAS, 워크스테이션 등 이미 ssh로 접속할 수 있는 서버가 있다면, 동기화 서비스나 계정을 따로 마련하지 않고도 Relayium CLI로 그곳에 파일을 백업할 수 있습니다. 전송은 기존 SSH 연결을 통해 이루어지므로 바이트는 곧장 내 서버로 가고 Relayium을 거치지 않습니다.",
    "이 가이드는 디렉터리를 push하고 pull하는 방법, 무결성 검사가 보장하는 것과 보장하지 않는 것, push가 같은 목적지로 두 번째 실행을 거부하는 이유, 그리고 cron으로 예약 실행하는 방법을 다룹니다.",
  ],
  sections: [
    {
      heading: "디렉터리를 서버로 push하기",
      prereqs: {
        label: "필요한 것",
        items: [
          "이미 쓰고 있는 SSH 접근 권한. ssh user@your-server true 가 조용히 돌아와야 합니다 — push는 바로 그 연결을 재사용하며 자체 설정은 아무것도 만들지 않습니다.",
          "서버에 쓰기 가능한 대상. 대상 경로의 상위 디렉터리가 존재하고 그 SSH 사용자가 쓸 수 있어야 합니다.",
          "선택적으로 서버의 relayium. 보내기 전 충돌 검사와 파일별 SHA-256을 얻게 해 주는 것이 이것입니다. 없어도 push는 평범한 tar 스트림으로 동작하지만, 그쪽은 아무것도 검증하지 않습니다.",
          "Relayium 계정도, 어느 쪽 데몬도 필요 없습니다. 여기서 Relayium 서버와 통신하는 것은 아무것도 없습니다.",
        ],
      },
      body: [
        "push는 하나 이상의 소스와 scp 형식의 대상을 받습니다. Relayium은 평소 쓰는 키와 설정으로 SSH를 통해 연결한 뒤, 파일을 대상 디렉터리로 스트리밍합니다:",
      ],
      steps: [
        {
          text: "push가 재사용할 SSH 접근을 확인합니다. 조용히 돌아오면 키와 호스트 별칭과 포트가 이미 맞다는 뜻입니다.",
          code: ["ssh user@your-server true"],
        },
        {
          text: "어느 프로토콜을 쓰게 될지 확인합니다. 경로가 나오면 네이티브 프로토콜 — 보내기 전 충돌 검사와 파일별 SHA-256이고, 아무것도 안 나오면 파일별로 아무것도 검사하지 않는 tar 스트림 대체 방식입니다.",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "디렉터리를 push합니다. 대상은 scp 형식이고, 끝의 슬래시는 “이 디렉터리 안으로”라는 뜻입니다.",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "ssh 설정에 그 호스트가 아직 없다면, 이 명령에 한해 키나 포트를 지정합니다.",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "무엇이 도착했는지 확인합니다. push ./photos 는 목적지 아래에 photos/ 를 재현하므로 폴더 이름이 함께 갑니다.",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "성공했을 때 보이는 것",
        body: [
          "네이티브 프로토콜에서는 push가 완료된 파일마다 한 줄을 출력하고 0으로 종료합니다. 아무것도 없는 서버를 상대로는 요약 한 줄만 나오는데, 그것이 tar 대체 방식이며 역시 성공입니다.",
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
        "기존 ~/.ssh/config를 그대로 재사용하므로, 이미 설정해 둔 호스트 별칭, 키, 포트가 그대로 작동합니다.",
        "서버에 relayium이 설치되어 있으면 네이티브 프로토콜을 사용합니다: 바이트를 보내기 전에 배치 전체의 충돌을 검사하고, 전송하는 각 파일을 SHA-256으로 검증한 뒤 자리에 설치합니다.",
        "설치되어 있지 않으면 tar 스트림을 원격으로 파이프하는 방식으로 대체되어, relayium이 없는 순수한 서버에서도 동작합니다.",
      ],
    },
    {
      heading: "파일을 pull로 되돌려받기",
      body: [
        "복원은 같은 명령을 반대로 실행하는 것과 같습니다. 원격 소스와 로컬 대상 디렉터리를 지정하세요. 백업을 복구하거나 서버의 출력을 노트북으로 동기화할 때 이렇게 합니다:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "push와 달리 pull은 항상 원격지에 relayium이 이미 설치되어 있어야 합니다 — tar 대체 방식이 없으므로, 설치되어 있지 않다면 먼저 그곳에 설치하세요.",
      ],
    },
    {
      heading: "무결성은 기본으로 내장되어 있다 — 재개는 아니다",
      body: [
        "양쪽에 relayium이 있으면 push가 전송하는 각 파일은 SHA-256 해시로 종단간 검증되고, 자리에 설치되기 전에 스테이징됩니다 — 서버에 도착하는 것은 보낸 것과 바이트 단위로 동일합니다. 여기까지는 사실이고, 대상 쪽에 relayium을 설치할 이유이기도 합니다.",
        "push가 하지 않는 것이 재개입니다. 파일은 통과하는 대로 하나씩 설치되므로, 도중에 연결이 끊기면 이미 도착한 파일은 그대로 남습니다. 그리고 그 파일들이 존재하기 때문에 같은 push를 다시 실행해도 충돌 검사에 거부됩니다. 빠진 경로를 따로 push하거나, 이미 일치하는 것은 건너뛰고 부분 파일은 다음 실행에서 이어가는 relayium sync를 쓰세요.",
        "--no-resume은 push와 pull에서도 받아들여지지만 거기서는 아무 일도 하지 않습니다. 실제로 효력이 있는 곳은 sync를 받는 serve 수신 측입니다 — 애초에 부분 파일이 존재할 수 있는 곳이 거기뿐이기 때문입니다.",
      ],
      bullets: [
        "push도 pull도 어느 프로토콜에서든 재개하지 않습니다. 중단될 수 있는 디렉터리에는 sync를 쓰세요. tar 대체 방식은 재개도 하지 않고 파일별 검증도 하지 않습니다.",
        "SHA-256 검사는 자동으로 실행되며, 불일치가 있으면 보고되고 해당 파일은 실패로 표시됩니다.",
      ],
    },
    {
      heading: "cron으로 예약 실행하기",
      body: [
        "cron에 넣을 것은 push가 아니라 sync입니다. push는 이미 존재하는 목적지를 거부하므로 같은 디렉터리로 매일 밤 push하면 첫 실행만 성공하고 그 뒤로는 매번 거부됩니다. sync는 반복 실행을 위해 만들어진 모드로, 크기와 수정 시각이 그대로인 파일은 건너뛰고 바뀐 것만 보내며, 중단된 실행이 남긴 부분 파일을 이어갑니다. SSH 키를 사용하는 단일 비대화형 명령이므로 그대로 cron에 들어갑니다. 암호 없는 키(또는 agent)를 지정하고, 출력을 로그로 남겨 실패를 확인할 수 있게 하세요:",
      ],
      code: [
        `# 매일 밤 2시에 백업. crontab에 추가하세요(crontab -e)
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "중단된 야간 sync는 다음 날 밤 그대로 이어집니다: 이미 일치하는 것은 건너뛰고, 부분 파일은 처음부터가 아니라 이어서 보냅니다.",
        "무결성 검사에 실패한 파일이 하나라도 있으면 명령이 0이 아닌 상태로 종료되므로, cron의 실패 시 메일 알림으로 문제를 발견할 수 있습니다.",
      ],
    },
    {
      heading: "백업이 도착하지 않을 때",
      body: [
        "예약된 백업은 본질적으로 조용히 실패합니다. 아무도 터미널을 보고 있지 않기 때문입니다. 아래 네 가지가 거의 전부를 덮고, 각각 지금 바로 실행할 수 있는 명령으로 판정됩니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "cron 작업이 멈춰 있거나 로그가 비밀번호 입력 프롬프트에서 끝납니다.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes 는 입력을 요구하지 않고 실패하므로, 조용한 멈춤이 이 한 줄로 바뀝니다. 그 키의 공개키를 서버의 ~/.ssh/authorized_keys 에 추가하거나, 에이전트가 이미 들고 있는 키를 작업에 지정하세요.",
          },
          {
            symptom: "crontab 줄은 실행되는데 로그가 계속 비어 있습니다.",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "cron은 최소한의 PATH로 실행되며 대개 /usr/local/bin이 없습니다. 그래서 relayium이 시작되기도 전에 그 줄이 실패합니다. 방금 확인한 절대 경로를 crontab 항목에 적고, >> ~/relayium-backup.log 2>&1 리다이렉트는 남겨 두어 다음 실패가 보이게 하세요.",
          },
          {
            symptom: "중단된 야간 sync가 다음 실행에서 처음부터 다시 시작합니다.",
            code: [
              `ssh user@your-server command -v relayium
# (아무것도 출력되지 않음)`,
            ],
            fix: "원격에 relayium이 없다는 뜻입니다. sync는 대체 방식이 없어 아예 실행되지 않고, push는 아무것도 검증하지 않는 tar 스트림으로 내려가 늘 파일 전체를 다시 보냅니다. 서버에 설치하세요. 부분 파일을 다음 실행에서 이어가는 것은 sync뿐이며, push와 pull은 어느 프로토콜에서든 재개하지 않습니다. 이미 sync를 쓰고 있다면, 그 수신 측의 재개를 실제로 끄는 --no-resume 을 넘기고 있지는 않은지도 확인하세요.",
          },
          {
            symptom: "“N file(s) failed integrity check”가 나오고 0이 아닌 코드로 종료됩니다.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "도착 시 계산한 SHA-256이 보낸 값과 달랐고, 네이티브 프로토콜은 각 파일을 먼저 스테이징한 뒤 해시가 맞을 때만 설치합니다 — 그래서 그 경로는 서버에 쓰인 적이 없고, 저쪽에서 지울 것도 없습니다. 같은 배치의 다른 파일들은 이미 자리에 설치되었기 때문에 배치 전체를 다시 실행하면 충돌 검사가 그대로 거부합니다. 그 경로 하나만 다시 push하세요. 그래도 계속 실패한다면 일회성 전송 오류가 아닙니다: 원본 파일(읽는 도중에 무언가가 쓰고 있는지)과 양쪽 저장소를 살펴보세요.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "파일이 Relayium의 서버를 거치나요?",
        a: "아니요. push와 pull은 전적으로 내 SSH 연결을 통해 실행됩니다. Relayium의 서버는 전혀 관여하지 않으며 계정도 필요 없습니다.",
      },
      {
        q: "서버에 relayium이 설치되어 있어야 하나요?",
        a: "방향에 따라 다릅니다. push의 경우 선택 사항입니다. 원격에 relayium이 있으면 네이티브 프로토콜을 사용할 수 있습니다 — 보내기 전 충돌 검사와, 전송하는 모든 파일에 대한 파일별 SHA-256 검사입니다. 없으면 push는 SSH를 통한 tar 스트림으로 대체되며, 여전히 동작하지만 파일별로는 아무것도 검증하지 않습니다. pull의 경우 필수입니다. pull은 항상 원격지에 relayium이 있어야 하며(tar 대체 방식 없음), 먼저 원격지에 설치해 두세요.",
      },
      {
        q: "어떤 SSH 키와 포트를 사용할지 어떻게 정하나요?",
        a: "ssh와 마찬가지로 기존 ~/.ssh/config를 읽으므로, 호스트 별칭, 키, 포트가 자동으로 반영됩니다. 명령마다 -i로 신원 파일을, -p로 포트를 지정해 재정의할 수도 있습니다.",
      },
      {
        q: "이게 rsync보다 빠른가요?",
        a: "자신의 서버로 push하는 경우라면 SSH를 통한 rsync와 비슷한 수준입니다. 목표는 rsync를 이기는 것이 아니라, 같은 파일별 무결성 검사를 갖춘 채로 크로스 네트워크 전송과 서버 간 전송까지 함께 해내는 하나의 도구를 제공하는 것입니다.",
      },
    ],
  },
  cta: {
    text: "다음 디렉터리를 직접적인 방식으로 백업하세요 — 내 SSH를 통해, 파일별 무결성 검사가 되며, 무료입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien über SSH auf dem eigenen Server sichern mit der Relayium CLI",
  description:
    "Nutze relayium push und pull, um Verzeichnisse auf einen Server zu kopieren oder zu synchronisieren, auf den du bereits per ssh zugreifst — mit Integritätsprüfung je Datei, wenn relayium auf beiden Seiten liegt, und kostenlos. Die Bytes laufen über deine eigene SSH-Verbindung und berühren nie die Server von Relayium.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Wenn du bereits SSH-Zugriff auf eine Maschine hast — einen VPS, einen Heimserver, ein NAS, eine Workstation —, kannst du Dateien mit der Relayium CLI dorthin sichern, ohne einen Sync-Dienst einzurichten oder ein Konto zu brauchen. Die Übertragung läuft über deine bestehende SSH-Verbindung, sodass die Bytes direkt zu deinem Server gehen und Relayium nie passieren.",
    "Diese Anleitung behandelt das push und pull von Verzeichnissen, was die Integritätsprüfung abdeckt und was nicht, warum push ein zweites Mal in dasselbe Ziel verweigert, und wie du das Ganze mit cron nach Zeitplan laufen lässt.",
  ],
  sections: [
    {
      heading: "Ein Verzeichnis auf deinen Server pushen",
      prereqs: {
        label: "Was du brauchst",
        items: [
          "SSH-Zugang, den du ohnehin nutzt. ssh user@your-server true muss stumm zurückkehren — push verwendet genau diese Verbindung wieder und richtet nichts Eigenes ein.",
          "Ein beschreibbares Ziel auf dem Server. Das übergeordnete Verzeichnis des Zielpfads muss existieren und für diesen SSH-Benutzer beschreibbar sein.",
          "Optional relayium auf dem Server — das ist es, was die Kollisionsprüfung vorab und dateiweises SHA-256 einbringt. Ohne läuft push trotzdem, über einen schlichten tar-Stream, der nichts prüft.",
          "Kein Relayium-Konto und kein Daemon auf einer der beiden Seiten. Nichts davon spricht mit den Servern von Relayium.",
        ],
      },
      body: [
        "push nimmt eine oder mehrere Quellen und ein Ziel im scp-Stil entgegen. Relayium verbindet sich per SSH mit deinen üblichen Schlüsseln und deiner Konfiguration und streamt die Dateien dann in das Zielverzeichnis:",
      ],
      steps: [
        {
          text: "Bestätige den SSH-Zugang, den push wiederverwendet. Kehrt er stumm zurück, stimmen Schlüssel, Host-Alias und Port bereits.",
          code: ["ssh user@your-server true"],
        },
        {
          text: "Finde heraus, welches Protokoll du bekommst. Ein Pfad heißt natives Protokoll — Kollisionsprüfung vorab und dateiweises SHA-256; keine Ausgabe heißt tar-Stream, der je Datei nichts prüft.",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "Push das Verzeichnis. Das Ziel steht im scp-Stil, und der Schrägstrich am Ende heißt „in dieses Verzeichnis hinein“.",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "Gib Schlüssel oder Port nur für diesen einen Befehl an, falls deine ssh-Konfiguration den Host noch nicht abdeckt.",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "Prüf, was gelandet ist. push ./photos legt photos/ unter dem Ziel wieder an, der Ordnername kommt also mit.",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Lauf aus",
        body: [
          "Auf dem nativen Protokoll gibt push eine Zeile pro fertiger Datei aus und endet mit 0. Gegen einen nackten Server erscheint stattdessen eine einzelne Zusammenfassungszeile — das ist der tar-Weg, und auch das ist Erfolg.",
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
        "Es verwendet deine ~/.ssh/config wieder, sodass bereits eingerichtete Host-Aliase, Schlüssel und Ports einfach funktionieren.",
        "Ist relayium auf dem Server installiert, nutzt es das native Protokoll: Der ganze Stapel wird auf Kollisionen geprüft, bevor ein Byte fließt, und jede übertragene Datei wird per SHA-256 verifiziert und erst danach an ihren Platz gelegt.",
        "Ist es das nicht, weicht es darauf aus, einen tar-Stream in die Gegenstelle zu pipen, sodass auch ein nackter Server ohne relayium funktioniert.",
      ],
    },
    {
      heading: "Dateien mit pull zurückholen",
      body: [
        "Das Wiederherstellen ist derselbe Befehl umgekehrt: Gib eine Remote-Quelle und ein lokales Zielverzeichnis an. So stellst du ein Backup wieder her oder synchronisierst die Ausgabe eines Servers auf deinen Laptop herunter:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "Anders als push braucht pull immer bereits installiertes relayium auf der Gegenseite — es gibt keinen tar-Fallback, installiere es also dort zuerst, falls es fehlt.",
      ],
    },
    {
      heading: "Integrität ist eingebaut — Fortsetzen nicht",
      body: [
        "Ist relayium auf beiden Seiten vorhanden, wird jede Datei, die push überträgt, Ende-zu-Ende mit einem SHA-256-Hash geprüft und erst nach der Prüfung an ihren Platz gelegt — was auf dem Server landet, entspricht Byte für Byte dem, was du gesendet hast. So weit ist das real, und es ist der Grund, relayium auf dem Ziel zu installieren.",
        "Was push nicht tut, ist fortsetzen. Dateien werden einzeln installiert, sobald sie durch sind, sodass ein Abbruch mittendrin die bereits gelandeten Dateien liegen lässt — und weil sie nun existieren, wird derselbe push beim nächsten Versuch von der Kollisionsprüfung abgelehnt statt fortgesetzt. Push die fehlenden Pfade einzeln, oder nimm relayium sync: das ist der Modus, der überspringt, was schon passt, und eine Teildatei in einem späteren Lauf tatsächlich weiterführt.",
        "--no-resume wird von push und pull zwar angenommen, tut dort aber nichts. Real ist es auf einem serve-Listener, der ein sync empfängt — dort kann überhaupt erst eine Teildatei liegen.",
      ],
      bullets: [
        "Weder push noch pull setzt fort, in keinem der beiden Protokolle. Nimm sync für ein Verzeichnis, bei dem du mit Unterbrechungen rechnest. Der tar-Fallback setzt weder fort noch prüft er je Datei etwas.",
        "Die SHA-256-Prüfung läuft automatisch; bei einer Abweichung wird das gemeldet und die Datei als fehlgeschlagen markiert.",
      ],
    },
    {
      heading: "Per cron nach Zeitplan ausführen",
      body: [
        "Plane sync ein, nicht push. push verweigert ein Ziel, das schon existiert, also gelingt ein nächtlicher push in dasselbe Verzeichnis genau einmal und wird danach jede Nacht abgelehnt. sync ist der Modus für den wiederholten Lauf: Er überspringt Dateien, deren Größe und Änderungszeit gleich geblieben sind, sendet nur das Geänderte und führt eine Teildatei aus einem abgebrochenen Lauf weiter. Es ist ein einzelner, nicht-interaktiver Befehl, der deine SSH-Schlüssel nutzt, und passt damit direkt in cron. Verweise auf einen Schlüssel ohne Passphrase (oder einen Agent) und protokolliere die Ausgabe, damit du Fehlschläge siehst:",
      ],
      code: [
        `# jede Nacht um 2 Uhr sichern — in deine crontab eintragen (crontab -e)
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Ein unterbrochenes nächtliches sync läuft in der folgenden Nacht einfach weiter: Was schon passt, wird übersprungen, und eine Teildatei wird fortgeführt statt neu begonnen.",
        "Der Befehl endet mit einem Exit-Code ungleich null, wenn eine Datei ihre Integritätsprüfung nicht besteht, sodass crons Mail-bei-Fehlschlag das Problem auffängt.",
      ],
    },
    {
      heading: "Wenn ein Backup nicht ankommt",
      body: [
        "Ein geplantes Backup scheitert von Natur aus leise — niemand schaut aufs Terminal. Diese vier decken fast alles ab, und jedes wird von einem Befehl entschieden, den du sofort ausführen kannst.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Der cron-Job hängt, oder das Log endet an einer Passwortabfrage.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes fragt nicht nach, sondern scheitert — aus dem stillen Hängen wird diese eine Zeile. Trag den öffentlichen Teil dieses Schlüssels in ~/.ssh/authorized_keys auf dem Server ein, oder gib dem Job einen Schlüssel, den ein Agent bereits hält.",
          },
          {
            symptom: "Die crontab-Zeile läuft, aber das Log bleibt leer.",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "cron läuft mit einem minimalen PATH, in dem /usr/local/bin meist fehlt, also scheitert die Zeile, bevor relayium überhaupt startet. Schreib den eben ausgegebenen absoluten Pfad in den crontab-Eintrag und behalte die Umleitung >> ~/relayium-backup.log 2>&1, damit der nächste Fehler sichtbar ist.",
          },
          {
            symptom: "Ein abgebrochenes nächtliches sync fängt beim nächsten Lauf wieder bei null an.",
            code: [
              `ssh user@your-server command -v relayium
# (gibt nichts aus)`,
            ],
            fix: "Auf der Gegenseite fehlt relayium. sync hat keinen Fallback und läuft dann gar nicht; push fällt auf den tar-Stream zurück, der nichts prüft und jede Datei immer vollständig überträgt. Installier es auf dem Server. Nur sync führt eine Teildatei im nächsten Lauf weiter — push und pull setzen in keinem der beiden Protokolle fort. Nutzt du bereits sync, prüf außerdem, dass du nicht --no-resume übergibst, das genau dieses Fortsetzen auf dem Listener abschaltet.",
          },
          {
            symptom: "„N file(s) failed integrity check“ und ein Exit-Code ungleich null.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "Der beim Eintreffen berechnete SHA-256 stimmte nicht mit dem gesendeten überein, und das native Protokoll legt jede Datei zuerst in einen Zwischenbereich und installiert sie nur, wenn der Hash passt — dieser Pfad wurde also nie auf den Server geschrieben, und dort gibt es nichts zu entfernen. Den ganzen Stapel erneut zu senden lehnt die Kollisionsprüfung weiterhin ab, weil die übrigen Dateien dieses Stapels bereits an ihrem Platz liegen; wiederhol den push deshalb nur für genau diesen einen Pfad. Scheitert er erneut, ist es kein einmaliger Übertragungsfehler: Sieh dir die Quelldatei an (schreibt etwas hinein, während sie gelesen wird) und den Speicher auf beiden Seiten.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Laufen die Dateien über die Server von Relayium?",
        a: "Nein. push und pull laufen vollständig über deine eigene SSH-Verbindung. Die Server von Relayium sind nie beteiligt, und du brauchst kein Konto.",
      },
      {
        q: "Muss auf dem Server relayium installiert sein?",
        a: "Das hängt von der Richtung ab. Bei push ist es optional: Mit relayium auf der Gegenseite bekommst du das native Protokoll — eine Kollisionsprüfung vorab und SHA-256-Prüfungen je Datei auf allem, was es überträgt —, und ohne das weicht push auf einen tar-Stream über SSH aus, der weiterhin funktioniert, je Datei aber nichts prüft. Bei pull ist es erforderlich: pull braucht immer relayium auf der Gegenseite (keinen tar-Fallback), installiere es dort also zuerst.",
      },
      {
        q: "Wie wählt es aus, welchen SSH-Schlüssel und welchen Port es nutzt?",
        a: "Es liest deine ~/.ssh/config genau wie ssh, sodass Host-Aliase, Schlüssel und Ports automatisch übernommen werden. Du kannst sie auch pro Befehl überschreiben, mit -i für die Identitätsdatei und -p für den Port.",
      },
      {
        q: "Ist das schneller als rsync?",
        a: "Beim Push auf den eigenen Server liegt es in etwa auf dem Niveau von rsync über SSH; der Punkt ist nicht, rsync zu schlagen, sondern dir ein einziges Werkzeug zu geben, das mit derselben dateiweisen Integritätsprüfung auch netzwerkübergreifende und Server-zu-Server-Übertragungen erledigt.",
      },
    ],
  },
  cta: {
    text: "Sichere dein nächstes Verzeichnis auf dem direkten Weg — über deine eigene SSH-Verbindung, mit Integritätsprüfung je Datei und kostenlos.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Sauvegarder des fichiers sur son propre serveur via SSH avec la CLI Relayium",
  description:
    "Utilisez relayium push et pull pour copier ou synchroniser des répertoires vers un serveur auquel vous accédez déjà en ssh — intégrité vérifiée fichier par fichier quand relayium est présent des deux côtés, et gratuit. Les octets circulent sur votre propre connexion SSH et ne touchent jamais les serveurs de Relayium.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Si vous avez déjà un accès SSH à une machine — un VPS, un serveur personnel, un NAS, un poste de travail —, vous pouvez y sauvegarder des fichiers avec la CLI Relayium sans mettre en place un service de synchronisation ni de compte. Le transfert passe par votre connexion SSH existante, si bien que les octets vont directement à votre serveur et ne transitent jamais par Relayium.",
    "Ce guide couvre le push et le pull de répertoires, ce que la vérification d'intégrité couvre et ne couvre pas, pourquoi push refuse de s'exécuter deux fois vers la même destination, et comment le planifier avec cron.",
  ],
  sections: [
    {
      heading: "Pousser (push) un répertoire vers votre serveur",
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "L'accès SSH que vous utilisez déjà. ssh user@your-server true doit revenir en silence — push réutilise exactement cette connexion et ne configure rien de son côté.",
          "Une destination inscriptible sur le serveur. Le répertoire parent du chemin de destination doit exister et être inscriptible par cet utilisateur SSH.",
          "Éventuellement relayium sur le serveur, car c'est lui qui apporte le contrôle de collision en amont et le SHA-256 par fichier. Sans lui, push fonctionne quand même, via un simple flux tar qui ne vérifie rien.",
          "Aucun compte Relayium et aucun démon d'un côté ou de l'autre. Rien ici ne parle aux serveurs de Relayium.",
        ],
      },
      body: [
        "push prend une ou plusieurs sources et une destination de style scp. Relayium se connecte en SSH avec vos clés et votre configuration habituelles, puis diffuse les fichiers vers le répertoire de destination :",
      ],
      steps: [
        {
          text: "Confirmez l'accès SSH que push va réutiliser. Un retour silencieux signifie que vos clés, votre alias d'hôte et votre port sont déjà bons.",
          code: ["ssh user@your-server true"],
        },
        {
          text: "Déterminez le protocole que vous obtiendrez. Un chemin annonce le protocole natif — contrôle de collision en amont et SHA-256 par fichier ; aucune sortie annonce le flux tar, qui ne vérifie rien fichier par fichier.",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "Poussez le répertoire. La destination est de style scp, et la barre oblique finale signifie « à l'intérieur de ce répertoire ».",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "Indiquez la clé ou le port pour cette seule commande si votre configuration ssh ne couvre pas encore cet hôte.",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "Vérifiez ce qui est arrivé. push ./photos recrée photos/ sous la destination, le nom du dossier suit donc.",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "À quoi ressemble une exécution réussie",
        body: [
          "Sur le protocole natif, push affiche une ligne par fichier terminé et se termine par 0. Face à un serveur nu, il affiche une seule ligne de résumé — c'est la voie tar, et c'est aussi une réussite.",
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
        "Il réutilise votre ~/.ssh/config, donc les alias d'hôtes, les clés et les ports déjà configurés fonctionnent tels quels.",
        "Si relayium est installé sur le serveur, il utilise le protocole natif : tout le lot est contrôlé pour les collisions avant le moindre octet, et chaque fichier transféré est vérifié par SHA-256 puis mis en place.",
        "Sinon, il bascule sur l'envoi d'un flux tar par tube vers la machine distante, si bien qu'un serveur nu sans relayium fonctionne quand même.",
      ],
    },
    {
      heading: "Récupérer les fichiers avec pull",
      body: [
        "La restauration est la même commande en sens inverse : indiquez une source distante et un répertoire de destination local. C'est ainsi que vous récupérez une sauvegarde, ou que vous synchronisez la sortie d'un serveur vers votre portable :",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "Contrairement à push, pull a toujours besoin de relayium déjà installé côté distant — il n'a pas de repli tar, installez-le donc là-bas d'abord s'il manque.",
      ],
    },
    {
      heading: "L'intégrité est intégrée d'office — la reprise, non",
      body: [
        "Quand relayium est présent des deux côtés, chaque fichier que push transfère est vérifié de bout en bout par un hachage SHA-256 et placé en zone d'attente avant d'être installé — ce qui arrive sur le serveur est identique octet pour octet à ce que vous avez envoyé. Cela, c'est réel, et c'est la raison d'installer relayium sur la destination.",
        "Ce que push ne fait pas, c'est reprendre. Les fichiers sont installés un à un au fur et à mesure, donc une coupure en cours de route laisse en place ceux qui sont déjà arrivés — et comme ils existent désormais, relancer le même push est refusé par le contrôle de collision au lieu de continuer. Poussez explicitement les chemins manquants, ou utilisez relayium sync, le mode qui saute ce qui correspond déjà et qui, lui, poursuit un fichier partiel lors d'une exécution ultérieure.",
        "--no-resume est accepté par push et pull et n'y fait rien. Il est réel sur un processus serve à l'écoute qui reçoit un sync — c'est le seul endroit où un fichier partiel peut exister.",
      ],
      bullets: [
        "Ni push ni pull ne reprend, dans aucun des deux protocoles. Utilisez sync pour un répertoire que vous vous attendez à voir interrompu ; le repli tar, lui, ne reprend rien et ne vérifie rien fichier par fichier.",
        "La vérification SHA-256 s'exécute automatiquement ; une divergence est signalée et le fichier est marqué en échec.",
      ],
    },
    {
      heading: "Le planifier avec cron",
      body: [
        "Planifiez sync, pas push. push refuse une destination qui existe déjà, donc un push nocturne vers le même répertoire réussit une fois et est refusé toutes les nuits suivantes. sync est le mode conçu pour une exécution répétée : il saute les fichiers dont la taille et la date de modification n'ont pas changé, n'envoie que ce qui a changé, et poursuit un fichier partiel laissé par une exécution interrompue. C'est une commande unique et non interactive qui utilise vos clés SSH, donc elle s'intègre directement dans cron. Pointez-la vers une clé sans phrase de passe (ou vers un agent), et journalisez la sortie pour repérer les échecs :",
      ],
      code: [
        `# sauvegarde chaque nuit à 2 h — à ajouter dans votre crontab (crontab -e)
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Un sync nocturne interrompu continue simplement la nuit suivante : ce qui correspond déjà est sauté, et un fichier partiel est poursuivi plutôt que repris de zéro.",
        "La commande se termine avec un code non nul si un fichier échoue à sa vérification d'intégrité, si bien que la notification par e-mail en cas d'échec de cron détecte les problèmes.",
      ],
    },
    {
      heading: "Quand une sauvegarde n'arrive pas",
      body: [
        "Une sauvegarde planifiée échoue par nature en silence, puisque personne ne regarde le terminal. Ces quatre cas couvrent presque tout, et chacun se tranche par une commande que vous pouvez lancer tout de suite.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "La tâche cron reste bloquée, ou le journal s'arrête sur une demande de mot de passe.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes refuse de demander quoi que ce soit et échoue, ce qui transforme un blocage muet en cette ligne. Ajoutez la partie publique de cette clé au fichier ~/.ssh/authorized_keys du serveur, ou pointez la tâche sur une clé que l'agent détient déjà.",
          },
          {
            symptom: "La ligne de crontab s'exécute mais le journal reste vide.",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "cron tourne avec un PATH minimal qui n'inclut généralement pas /usr/local/bin, donc la ligne échoue avant même que relayium démarre. Écrivez dans l'entrée crontab le chemin absolu que la vérification vient d'afficher, et gardez la redirection >> ~/relayium-backup.log 2>&1 pour que la prochaine panne soit visible.",
          },
          {
            symptom: "Un sync nocturne interrompu repart de zéro à l'exécution suivante.",
            code: [
              `ssh user@your-server command -v relayium
# (n'affiche rien)`,
            ],
            fix: "relayium manque en face. sync n'a aucun repli et ne démarre donc pas du tout, et push retombe sur le flux tar, qui ne vérifie rien et renvoie toujours chaque fichier en entier. Installez-le sur le serveur. Seul sync poursuit un fichier partiel à l'exécution suivante : ni push ni pull ne reprend, dans aucun des deux protocoles. Si vous utilisez déjà sync, vérifiez aussi que vous ne passez pas --no-resume, qui désactive volontairement cette reprise côté processus à l'écoute.",
          },
          {
            symptom: "« N file(s) failed integrity check » et un code de sortie non nul.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "Le SHA-256 calculé à l'arrivée ne correspondait pas à celui envoyé, et le protocole natif place chaque fichier en zone d'attente puis ne l'installe que si le hachage concorde — ce chemin n'a donc jamais été écrit sur le serveur, et il n'y a rien à y supprimer. Relancer tout le lot reste refusé par le contrôle de collision, puisque les autres fichiers de ce lot sont déjà en place : relancez donc le push sur ce seul chemin. S'il échoue de nouveau, ce n'est pas une erreur de transit ponctuelle : regardez le fichier source (quelque chose y écrit-il pendant qu'il est lu) et le stockage de chaque côté.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Les fichiers passent-ils par les serveurs de Relayium ?",
        a: "Non. push et pull s'exécutent entièrement sur votre propre connexion SSH. Les serveurs de Relayium ne sont jamais impliqués et aucun compte n'est nécessaire.",
      },
      {
        q: "Le serveur a-t-il besoin de relayium installé ?",
        a: "Cela dépend du sens. Pour push, c'est optionnel : avec relayium côté distant, vous obtenez le protocole natif — un contrôle de collision en amont et des vérifications SHA-256 par fichier sur tout ce qu'il transfère — et sans cela, push bascule sur un flux tar via SSH, qui fonctionne toujours mais ne vérifie rien fichier par fichier. Pour pull, c'est requis : pull a toujours besoin de relayium côté distant (aucun repli tar), installez-le donc là-bas au préalable.",
      },
      {
        q: "Comment choisit-il quelle clé SSH et quel port utiliser ?",
        a: "Il lit votre ~/.ssh/config comme le fait ssh, si bien que les alias d'hôtes, les clés et les ports sont repris automatiquement. Vous pouvez aussi les surcharger par commande avec -i pour le fichier d'identité et -p pour le port.",
      },
      {
        q: "Est-ce plus rapide que rsync ?",
        a: "Pour pousser vers votre propre serveur, c'est dans le même ordre de grandeur que rsync via SSH ; l'objectif n'est pas de battre rsync mais de vous offrir un seul outil qui gère aussi les transferts entre réseaux et de serveur à serveur, avec la même vérification d'intégrité fichier par fichier.",
      },
    ],
  },
  cta: {
    text: "Sauvegardez votre prochain répertoire de la manière la plus directe — via votre propre SSH, avec l'intégrité vérifiée fichier par fichier, et gratuit.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "انسخ الملفات احتياطيًا إلى خادمك عبر SSH باستخدام Relayium CLI",
  description:
    "استخدم relayium push وpull لنسخ المجلدات أو مزامنتها إلى خادم تدخل إليه بالفعل عبر ssh — مع تحقق من السلامة لكل ملف حين يكون relayium على الطرفين، ومجاني. تنتقل البايتات عبر اتصال SSH لديك ولا تلمس خوادم Relayium أبدًا.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إذا كان لديك بالفعل وصول SSH إلى جهاز — خادم افتراضي خاص، أو خادم منزلي، أو NAS، أو محطة عمل — فيمكنك نسخ الملفات إليه احتياطيًا باستخدام Relayium CLI دون إعداد خدمة مزامنة أو حساب. تجري عملية النقل عبر اتصال SSH الموجود لديك، فتذهب البايتات مباشرة إلى خادمك ولا تمر أبدًا عبر Relayium.",
    "يغطّي هذا الدليل دفع المجلدات وسحبها، وما يغطّيه التحقق من السلامة وما لا يغطّيه، ولماذا يرفض push العمل مرتين إلى الوجهة نفسها، وكيفية تشغيله وفق جدول باستخدام cron.",
  ],
  sections: [
    {
      heading: "ادفع مجلدًا إلى خادمك",
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "وصول SSH الذي تستخدمه أصلًا. لا بد أن يعود ssh user@your-server true بصمت، فـpush يعيد استخدام هذا الاتصال نفسه ولا يهيّئ شيئًا خاصًا به.",
          "وجهة قابلة للكتابة على الخادم. يجب أن يكون المجلد الأب لمسار الوجهة موجودًا وقابلًا للكتابة من قِبَل مستخدم SSH ذاك.",
          "اختياريًا relayium على الخادم، فهو ما يمنحك فحص التعارض المسبق وتحقق SHA-256 لكل ملف. وبدونه يظل push يعمل عبر بث tar بسيط، لكنه لا يتحقق من شيء.",
          "لا حساب على Relayium ولا خدمة تعمل في الخلفية على أي من الطرفين. لا شيء هنا يتحدث إلى خوادم Relayium.",
        ],
      },
      body: [
        "يأخذ push مصدرًا واحدًا أو أكثر ووجهة بأسلوب scp. يتصل Relayium عبر SSH باستخدام مفاتيحك وإعداداتك المعتادة، ثم يبثّ الملفات إلى مجلد الوجهة:",
      ],
      steps: [
        {
          text: "تأكّد من وصول SSH الذي سيعيد push استخدامه. عودته بصمت تعني أن مفاتيحك واسم المضيف المستعار والمنفذ صحيحة أصلًا.",
          code: ["ssh user@your-server true"],
        },
        {
          text: "اعرف أي بروتوكول ستحصل عليه. ظهور مسار يعني البروتوكول الأصلي، أي فحص التعارض المسبق وتحقق SHA-256 لكل ملف؛ وغياب أي مخرجات يعني بث tar الذي لا يتحقق من شيء لكل ملف.",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "ادفع المجلد. الوجهة مكتوبة بأسلوب scp، والشرطة المائلة في نهايتها تعني «إلى داخل هذا المجلد».",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "حدّد المفتاح أو المنفذ لهذا الأمر وحده إن كان إعداد ssh لديك لا يغطي هذا المضيف بعد.",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "تأكّد مما وصل. يعيد push ./photos بناء المجلد photos تحت الوجهة، فيأتي اسم المجلد معه.",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "كيف يبدو التشغيل الناجح",
        body: [
          "على البروتوكول الأصلي، يطبع push سطرًا لكل ملف اكتمل وينتهي بالرمز 0. وأمام خادم عارٍ يطبع سطر ملخّص واحدًا فقط، وهذا هو مسار tar، وهو نجاح أيضًا.",
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
        "يعيد استخدام ملف ~/.ssh/config لديك، فأسماء المضيفين المستعارة والمفاتيح والمنافذ التي أعددتها من قبل تعمل مباشرة.",
        "إذا كان relayium مثبّتًا على الخادم، يستخدم البروتوكول الأصلي: تُفحَص الدفعة كلها بحثًا عن التعارضات قبل إرسال أي بايت، ويُتحقَّق من كل ملف يَنقله بـ SHA-256 ويوضع في منطقة مؤقتة قبل تثبيته.",
        "إن لم يكن، يتراجع إلى تمرير بث tar عبر أنبوب إلى الطرف البعيد، فيعمل حتى خادم عارٍ لا يملك relayium.",
      ],
    },
    {
      heading: "اسحب الملفات مرة أخرى",
      body: [
        "الاسترجاع هو الأمر نفسه بالاتجاه المعاكس: أعطِ مصدرًا بعيدًا ومجلد وجهة محليًا. هكذا تستعيد نسخة احتياطية، أو تزامن مخرجات خادم نزولًا إلى حاسوبك المحمول:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "على عكس push، يحتاج pull دائمًا إلى relayium مثبّتًا مسبقًا على الطرف البعيد — فهو لا يملك تراجع tar، لذا ثبّته هناك أولًا إن كان ناقصًا.",
      ],
    },
    {
      heading: "السلامة مدمجة — أما الاستئناف فلا",
      body: [
        "عندما يكون relayium على الطرفين، يُتحقَّق من كل ملف يَنقله push من الطرف إلى الطرف بتجزئة SHA-256 ويوضع في منطقة مؤقتة قبل تثبيته — فما يصل إلى الخادم مطابق بايتًا ببايت لما أرسلته. هذا القدر حقيقي، وهو سبب تثبيت relayium على الوجهة.",
        "ما لا يفعله push هو الاستئناف. تُثبَّت الملفات واحدًا تلو الآخر كلما اكتملت، فانقطاع الاتصال في المنتصف يترك الملفات التي وصلت في مكانها — ولأنها صارت موجودة، فإن إعادة تشغيل الدفع نفسه يُرفَض بفحص التعارض بدل أن يُكمِل. ادفع المسارات الناقصة صراحةً، أو استخدم relayium sync، وهو الوضع الذي يتخطى ما يطابق سلفًا ويُكمل بالفعل ملفًا جزئيًا في تشغيل لاحق.",
        "‏--no-resume مقبول في push وpull ولا يفعل شيئًا هناك. وهو حقيقي على مُستمِع serve يستقبل sync — فهذا هو المكان الوحيد الذي يمكن أن يوجد فيه ملف جزئي أصلًا.",
      ],
      bullets: [
        "لا يستأنف push ولا pull، في أي من البروتوكولين. استخدم sync لمجلد تتوقّع انقطاعه؛ أما تراجع tar فلا يستأنف ولا يتحقق من شيء لكل ملف.",
        "يعمل تحقق SHA-256 تلقائيًا؛ ويُبلَّغ عن أي عدم تطابق ويُوسَم ذلك الملف بالفشل.",
      ],
    },
    {
      heading: "شغّله وفق جدول باستخدام cron",
      body: [
        "جدوِل sync لا push. يرفض push وجهة موجودة سلفًا، فالدفع الليلي إلى المجلد نفسه ينجح مرة واحدة ويُرفَض كل ليلة بعدها. أما sync فهو الوضع المبني للتشغيل المتكرر: يتخطى الملفات التي لم يتغيّر حجمها ولا وقت تعديلها، ويرسل ما تغيّر فقط، ويُكمل ملفًا جزئيًا خلّفه تشغيل منقطع. وهو أمر واحد غير تفاعلي يستخدم مفاتيح SSH لديك، فيندرج مباشرة في cron. وجّهه إلى مفتاح بلا عبارة مرور (أو إلى agent)، وسجّل المخرجات كي ترى حالات الفشل:",
      ],
      code: [
        `# انسخ احتياطيًا كل ليلة عند الساعة 2 — أضِف هذا إلى crontab لديك (crontab -e)
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "‏sync ليلي ينقطع يُكمل ببساطة في الليلة التالية: يُتخطّى ما يطابق سلفًا، ويُكمَل الملف الجزئي بدل إعادته من البداية.",
        "يخرج الأمر بحالة غير صفرية إذا فشل أي ملف في تحقق سلامته، فيلتقط بريد cron عند الفشل المشكلات.",
      ],
    },
    {
      heading: "حين لا تصل النسخة الاحتياطية",
      body: [
        "النسخ الاحتياطي المجدول يفشل بصمت بطبيعته، إذ لا أحد يراقب الطرفية. تغطي الحالات الأربع التالية معظمه، ولكل واحدة أمر يمكنك تشغيله الآن ليحسمها.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "تتوقف مهمة cron معلّقة، أو ينتهي السجل عند طلب كلمة مرور.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "الخيار BatchMode=yes يرفض السؤال ويفشل، فيحوّل التعليق الصامت إلى هذا السطر. أضِف الشقّ العام من ذلك المفتاح إلى ملف ~/.ssh/authorized_keys على الخادم، أو وجّه المهمة إلى مفتاح يحمله الوكيل أصلًا.",
          },
          {
            symptom: "يعمل سطر crontab لكن السجل يبقى فارغًا.",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "يعمل cron بمسار PATH مختصر لا يتضمن /usr/local/bin عادةً، فيفشل السطر قبل أن يبدأ relayium أصلًا. اكتب المسار المطلق الذي طبعه الفحص للتو داخل مُدخَل crontab، وأبقِ إعادة التوجيه >> ~/relayium-backup.log 2>&1 كي يظهر العطل التالي.",
          },
          {
            symptom: "يبدأ sync الليلي المنقطع من الصفر في التشغيل التالي.",
            code: [
              `ssh user@your-server command -v relayium
# (لا يطبع شيئًا)`,
            ],
            fix: "‏relayium غائب عن الطرف البعيد. لا يملك sync أي تراجع فلا يعمل أصلًا، ويهبط push إلى مسار بث tar الذي لا يتحقق من شيء ويعيد إرسال كل ملف كاملًا في كل مرة. ثبّته على الخادم. وحده sync يُكمل ملفًا جزئيًا في التشغيل التالي؛ فلا push ولا pull يستأنف في أي من البروتوكولين. وإن كنت تستخدم sync أصلًا، فتأكّد أيضًا من أنك لا تمرّر --no-resume الذي يعطّل ذلك الاستئناف على المُستمِع عمدًا.",
          },
          {
            symptom: "تظهر «N file(s) failed integrity check» مع رمز خروج غير صفري.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "قيمة SHA-256 المحسوبة عند الوصول لم تطابق المُرسَلة، والبروتوكول الأصلي يضع كل ملف في منطقة مؤقتة ولا يثبّته إلا عند تطابق البصمة — لذلك لم يُكتب ذلك المسار على الخادم أصلًا، ولا شيء هناك يحتاج إلى حذف. وإعادة تشغيل الدفعة كاملة سيظل فحص التعارض يرفضها، لأن بقية ملفات تلك الدفعة قد استقرت بالفعل، فأعد push لذلك المسار وحده. وإن فشل مجددًا فهو ليس خطأ نقل عابرًا: افحص الملف المصدر (هل يكتب فيه شيء أثناء قراءته) والتخزين على الطرفين.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل تمر الملفات عبر خوادم Relayium؟",
        a: "لا. يجري push وpull بالكامل عبر اتصال SSH لديك. خوادم Relayium لا تشارك أبدًا ولا تحتاج إلى حساب.",
      },
      {
        q: "هل يحتاج الخادم إلى تثبيت relayium؟",
        a: "يعتمد ذلك على الاتجاه. بالنسبة لـ push فهو اختياري: مع relayium على الطرف البعيد تحصل على البروتوكول الأصلي — فحص تعارض مسبق وتحقق SHA-256 لكل ملف يَنقله — وبدونه يتراجع push إلى بث tar بسيط عبر SSH، وهو يعمل مع ذلك لكنه لا يتحقق من شيء لكل ملف. أما بالنسبة لـ pull فهو مطلوب: يحتاج pull دائمًا إلى relayium على الطرف البعيد (لا يملك تراجع tar)، فثبّته هناك أولًا.",
      },
      {
        q: "كيف يختار أي مفتاح SSH وأي منفذ يستخدم؟",
        a: "يقرأ ملف ~/.ssh/config لديك كما يفعل ssh، فتُلتقط أسماء المضيفين المستعارة والمفاتيح والمنافذ تلقائيًا. يمكنك أيضًا تجاوزها لكل أمر بـ -i لملف الهوية و -p للمنفذ.",
      },
      {
        q: "هل هذا أسرع من rsync؟",
        a: "للدفع إلى خادمك الخاص فهو في المستوى نفسه تقريبًا لـ rsync عبر SSH؛ الهدف ليس التفوّق على rsync بل أن نمنحك أداة واحدة تنفّذ أيضًا عمليات النقل عبر الشبكات ومن خادم إلى خادم بنفس تحقق السلامة لكل ملف.",
      },
    ],
  },
  cta: {
    text: "انسخ مجلدك التالي احتياطيًا بالطريقة المباشرة — عبر SSH لديك، مع تحقق من السلامة لكل ملف، ومجاني.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Haz copias de seguridad de archivos en tu propio servidor por SSH con la CLI de Relayium",
  description:
    "Usa relayium push y pull para copiar o sincronizar directorios a un servidor al que ya accedes por ssh — con comprobación de integridad por archivo cuando relayium está en ambos extremos, y gratis. Los bytes viajan por tu propia conexión SSH y nunca tocan los servidores de Relayium.",
  updatedLabel: "Última actualización",
  lead: [
    "Si ya tienes acceso SSH a una máquina — un VPS, un servidor doméstico, un NAS, una estación de trabajo —, puedes hacer copias de seguridad de tus archivos en ella con la CLI de Relayium sin montar un servicio de sincronización ni una cuenta. La transferencia se ejecuta sobre tu conexión SSH existente, así que los bytes van directos a tu servidor y nunca pasan por Relayium.",
    "Esta guía cubre cómo hacer push y pull de directorios, qué cubre y qué no cubre la comprobación de integridad, por qué push se niega a ejecutarse dos veces hacia el mismo destino, y cómo ejecutarlo de forma programada con cron.",
  ],
  sections: [
    {
      heading: "Envía (push) un directorio a tu servidor",
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "El acceso SSH que ya usas. ssh user@your-server true tiene que volver en silencio: push reutiliza exactamente esa conexión y no configura nada por su cuenta.",
          "Un destino con permiso de escritura en el servidor. El directorio padre de la ruta de destino debe existir y ser escribible por ese usuario SSH.",
          "Opcionalmente relayium en el servidor, que es lo que aporta la comprobación de colisiones por adelantado y el SHA-256 por archivo. Sin él, push sigue funcionando mediante un simple flujo tar, que no verifica nada.",
          "Ninguna cuenta de Relayium y ningún demonio en ninguno de los dos extremos. Nada de esto habla con los servidores de Relayium.",
        ],
      },
      body: [
        "push toma una o más fuentes y un destino al estilo scp. Relayium se conecta por SSH usando tus claves y tu configuración habituales, y luego transmite los archivos al directorio de destino:",
      ],
      steps: [
        {
          text: "Confirma el acceso SSH que push va a reutilizar. Un retorno silencioso significa que tus claves, tu alias de host y tu puerto ya son correctos.",
          code: ["ssh user@your-server true"],
        },
        {
          text: "Averigua qué protocolo vas a obtener. Una ruta indica el protocolo nativo —comprobación de colisiones por adelantado y SHA-256 por archivo—; ninguna salida indica el flujo tar, que no comprueba nada archivo por archivo.",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "Envía el directorio. El destino es al estilo scp, y la barra final significa «dentro de este directorio».",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "Indica la clave o el puerto solo para este comando si tu configuración de ssh todavía no cubre ese host.",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "Comprueba qué llegó. push ./photos recrea photos/ bajo el destino, así que el nombre de la carpeta viaja con ellos.",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "Cómo se ve una ejecución correcta",
        body: [
          "Con el protocolo nativo, push imprime una línea por archivo terminado y sale con 0. Contra un servidor sin nada instalado imprime una sola línea de resumen: esa es la vía tar, y también es un éxito.",
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
        "Reutiliza tu ~/.ssh/config, así que los alias de host, las claves y los puertos que ya configuraste funcionan sin más.",
        "Si relayium está instalado en el servidor, usa el protocolo nativo: se comprueba todo el lote en busca de colisiones antes de enviar un solo byte, y cada archivo que transfiere se verifica por SHA-256 y se coloca en un área temporal antes de instalarlo.",
        "Si no lo está, recurre a canalizar un flujo tar hacia la máquina remota, de modo que hasta un servidor sin nada instalado y sin relayium funciona.",
      ],
    },
    {
      heading: "Recupera (pull) los archivos",
      body: [
        "Restaurar es el mismo comando a la inversa: indica una fuente remota y un directorio de destino local. Así recuperas una copia de seguridad, o sincronizas la salida de un servidor hacia tu portátil:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "A diferencia de push, pull siempre necesita relayium ya instalado en el remoto — no tiene alternativa con tar, así que instálalo allí primero si falta.",
      ],
    },
    {
      heading: "La integridad viene de serie — la reanudación no",
      body: [
        "Cuando relayium está en ambos extremos, cada archivo que push transfiere se verifica de extremo a extremo con un hash SHA-256 y se coloca en un área temporal antes de instalarlo — lo que llega al servidor es byte por byte lo que enviaste. Eso sí es real, y es la razón para instalar relayium en el destino.",
        "Lo que push no hace es reanudar. Los archivos se instalan de uno en uno según van pasando, así que una conexión que se corta a medias deja en su sitio los que ya llegaron — y como ahora existen, volver a lanzar el mismo push lo rechaza la comprobación de colisiones en lugar de continuar. Envía los archivos que faltan de forma explícita, o usa relayium sync, que es el modo que se salta lo que ya coincide y que sí continúa un archivo parcial en una ejecución posterior.",
        "--no-resume se acepta en push y pull y allí no hace nada. Es real en un proceso serve a la escucha que recibe un sync, que es donde puede existir un archivo parcial.",
      ],
      bullets: [
        "Ni push ni pull reanuda, en ninguno de los dos protocolos. Usa sync para un directorio que esperes que se interrumpa; la alternativa con tar no reanuda ni verifica nada archivo por archivo.",
        "La comprobación SHA-256 se ejecuta automáticamente; una discrepancia se informa y ese archivo se marca como fallido.",
      ],
    },
    {
      heading: "Ejecútalo de forma programada con cron",
      body: [
        "Programa sync, no push. push rechaza un destino que ya existe, así que un push nocturno al mismo directorio tiene éxito una vez y se rechaza todas las noches siguientes. sync es el modo pensado para una ejecución repetida: se salta los archivos cuyo tamaño y fecha de modificación no han cambiado, envía solo lo que cambió y continúa un archivo parcial que dejó una ejecución interrumpida. Es un único comando no interactivo que usa tus claves SSH, así que encaja directamente en cron. Apúntalo a una clave sin frase de contraseña (o a un agente), y registra la salida para poder ver los fallos:",
      ],
      code: [
        `# copia de seguridad cada noche a las 2 — añádela a tu crontab (crontab -e)
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Un sync nocturno que se interrumpe simplemente continúa la noche siguiente: lo que ya coincide se salta, y un archivo parcial se continúa en lugar de empezarse de nuevo.",
        "El comando termina con un código distinto de cero si algún archivo falla su comprobación de integridad, así que el correo de fallo de cron detecta los problemas.",
      ],
    },
    {
      heading: "Cuando una copia no llega",
      body: [
        "Una copia programada falla en silencio por naturaleza: nadie está mirando el terminal. Estos cuatro casos cubren casi todo, y cada uno se decide con un comando que puedes ejecutar ahora mismo.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "La tarea de cron se queda colgada, o el registro termina en una petición de contraseña.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes se niega a preguntar y falla, lo que convierte un cuelgue mudo en esta línea. Añade la parte pública de esa clave al ~/.ssh/authorized_keys del servidor, o apunta la tarea a una clave que el agente ya tenga cargada.",
          },
          {
            symptom: "La línea del crontab se ejecuta pero el registro sigue vacío.",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "cron corre con un PATH mínimo que normalmente no incluye /usr/local/bin, así que la línea falla antes de que relayium arranque. Escribe en la entrada del crontab la ruta absoluta que acaba de imprimir la comprobación, y conserva la redirección >> ~/relayium-backup.log 2>&1 para que el próximo fallo se vea.",
          },
          {
            symptom: "Un sync nocturno interrumpido vuelve a empezar desde cero en la ejecución siguiente.",
            code: [
              `ssh user@your-server command -v relayium
# (no imprime nada)`,
            ],
            fix: "Falta relayium en el remoto. sync no tiene alternativa alguna y por tanto ni siquiera arranca, y push cae al flujo tar, que no verifica nada y siempre reenvía cada archivo entero. Instálalo en el servidor. Solo sync continúa un archivo parcial en la ejecución siguiente: ni push ni pull reanuda, en ninguno de los dos protocolos. Si ya usas sync, comprueba además que no estás pasando --no-resume, que desactiva a propósito esa reanudación en el proceso a la escucha.",
          },
          {
            symptom: "«N file(s) failed integrity check» y una salida distinta de cero.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "El SHA-256 calculado al llegar no coincidió con el enviado, y el protocolo nativo deja cada archivo en una zona temporal y solo lo instala cuando el hash cuadra: esa ruta nunca se escribió en el servidor y allí no hay nada que borrar. Repetir el lote entero lo sigue rechazando la comprobación de colisiones, porque los demás archivos de ese lote ya están en su sitio, así que repite el push solo con esa ruta. Si vuelve a fallar no es un error puntual de tránsito: revisa el archivo de origen (si algo escribe en él mientras se lee) y el almacenamiento de ambos lados.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Los archivos pasan por los servidores de Relayium?",
        a: "No. push y pull se ejecutan enteramente sobre tu propia conexión SSH. Los servidores de Relayium nunca intervienen y no necesitas ninguna cuenta.",
      },
      {
        q: "¿El servidor necesita tener relayium instalado?",
        a: "Depende de la dirección. Para push es opcional: con relayium en el remoto obtienes el protocolo nativo — una comprobación de colisiones por adelantado y comprobaciones SHA-256 por archivo sobre todo lo que transfiere — y sin él, push recurre a un simple flujo tar sobre SSH, que sigue funcionando pero no verifica nada archivo por archivo. Para pull es obligatorio: pull siempre necesita relayium en el remoto (no tiene alternativa con tar), así que instálalo allí primero.",
      },
      {
        q: "¿Cómo elige qué clave SSH y qué puerto usar?",
        a: "Lee tu ~/.ssh/config igual que hace ssh, así que los alias de host, las claves y los puertos se recogen automáticamente. También puedes sobrescribirlos por comando con -i para el archivo de identidad y -p para el puerto.",
      },
      {
        q: "¿Es más rápido que rsync?",
        a: "Para enviar a tu propio servidor está en el mismo orden de magnitud que rsync sobre SSH; el objetivo no es superar a rsync, sino darte una sola herramienta que además hace transferencias entre redes y de servidor a servidor con la misma comprobación de integridad por archivo.",
      },
    ],
  },
  cta: {
    text: "Haz la copia de seguridad de tu próximo directorio de la forma directa — por tu propio SSH, con comprobación de integridad por archivo y gratis.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Faça backup de arquivos no seu próprio servidor via SSH com a CLI do Relayium",
  description:
    "Use relayium push e pull para copiar ou sincronizar diretórios para um servidor que você já acessa por ssh — com verificação de integridade por arquivo quando o relayium está nas duas pontas, e gratuito. Os bytes trafegam pela sua própria conexão SSH e nunca tocam os servidores do Relayium.",
  updatedLabel: "Última atualização",
  lead: [
    "Se você já tem acesso SSH a uma máquina — um VPS, um servidor doméstico, um NAS, uma estação de trabalho —, pode fazer backup dos seus arquivos nela com a CLI do Relayium sem montar um serviço de sincronização nem uma conta. A transferência roda sobre a sua conexão SSH existente, então os bytes vão direto para o seu servidor e nunca passam pelo Relayium.",
    "Este guia aborda como fazer push e pull de diretórios, o que a verificação de integridade cobre e o que não cobre, por que o push se recusa a rodar duas vezes para o mesmo destino, e como executá-lo de forma agendada com o cron.",
  ],
  sections: [
    {
      heading: "Envie (push) um diretório para o seu servidor",
      prereqs: {
        label: "O que você precisa",
        items: [
          "O acesso SSH que você já usa. ssh user@your-server true precisa voltar em silêncio: o push reaproveita exatamente essa conexão e não configura nada por conta própria.",
          "Um destino com permissão de escrita no servidor. O diretório pai do caminho de destino tem de existir e ser gravável por aquele usuário SSH.",
          "Opcionalmente o relayium no servidor, que é o que traz a checagem de colisão antecipada e o SHA-256 por arquivo. Sem ele o push continua funcionando, por um fluxo tar simples que não verifica nada.",
          "Nenhuma conta do Relayium e nenhum daemon em qualquer das pontas. Nada disso conversa com os servidores do Relayium.",
        ],
      },
      body: [
        "O push recebe uma ou mais origens e um destino no estilo scp. O Relayium se conecta por SSH usando suas chaves e sua configuração de sempre e, em seguida, transmite os arquivos para o diretório de destino:",
      ],
      steps: [
        {
          text: "Confirme o acesso SSH que o push vai reaproveitar. Um retorno silencioso significa que suas chaves, seu apelido de host e sua porta já estão certos.",
          code: ["ssh user@your-server true"],
        },
        {
          text: "Descubra qual protocolo você vai usar. Um caminho indica o protocolo nativo — checagem de colisão antecipada e SHA-256 por arquivo; nenhuma saída indica o fluxo tar, que não confere nada arquivo por arquivo.",
          code: ["ssh user@your-server command -v relayium"],
        },
        {
          text: "Envie o diretório. O destino é no estilo scp, e a barra no fim significa “para dentro deste diretório”.",
          code: ["relayium push ./photos user@your-server:backups/"],
        },
        {
          text: "Informe a chave ou a porta só para este comando se a sua configuração de ssh ainda não cobre esse host.",
          code: ["relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/"],
        },
        {
          text: "Confira o que chegou. push ./photos recria photos/ sob o destino, então o nome da pasta vai junto.",
          code: ["ssh user@your-server ls backups/photos"],
        },
      ],
      success: {
        label: "Como é uma execução bem-sucedida",
        body: [
          "No protocolo nativo, o push imprime uma linha por arquivo concluído e sai com 0. Contra um servidor sem nada instalado ele imprime uma única linha de resumo: esse é o caminho do tar, e também é sucesso.",
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
        "Ele reaproveita seu ~/.ssh/config, então os apelidos de host, as chaves e as portas que você já configurou simplesmente funcionam.",
        "Se o relayium estiver instalado no servidor, ele usa o protocolo nativo: o lote inteiro é checado por colisões antes de qualquer byte sair, e cada arquivo transferido é verificado por SHA-256 e preparado em área temporária antes de ser instalado.",
        "Se não estiver, ele recorre a canalizar um fluxo tar para a máquina remota, de modo que até um servidor sem nada instalado e sem relayium funciona.",
      ],
    },
    {
      heading: "Traga os arquivos de volta (pull)",
      body: [
        "Restaurar é o mesmo comando ao contrário: informe uma origem remota e um diretório de destino local. É assim que você recupera um backup ou sincroniza a saída de um servidor para o seu notebook:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
      bullets: [
        "Ao contrário do push, o pull sempre precisa do relayium já instalado no remoto — ele não tem alternativa com tar, então instale-o lá primeiro se estiver faltando.",
      ],
    },
    {
      heading: "A integridade já vem embutida — a retomada não",
      body: [
        "Quando o relayium está nas duas pontas, cada arquivo que o push transfere é verificado de ponta a ponta com um hash SHA-256 e preparado em área temporária antes de ser instalado — o que chega ao servidor é byte por byte o que você enviou. Isso é real, e é o motivo para instalar o relayium no destino.",
        "O que o push não faz é retomar. Os arquivos são instalados um a um conforme passam, então uma conexão perdida no meio deixa no lugar os que já chegaram — e, como agora eles existem, repetir o mesmo push é recusado pela checagem de colisão em vez de continuar. Envie os caminhos que faltam explicitamente, ou use o relayium sync, que é o modo que pula o que já corresponde e que de fato continua um arquivo parcial em uma execução posterior.",
        "--no-resume é aceito por push e pull e ali não faz nada. Ele é real em um serve à escuta que recebe um sync, que é onde um arquivo parcial pode existir.",
      ],
      bullets: [
        "Nem o push nem o pull retoma, em nenhum dos dois protocolos. Use o sync para um diretório que você espera ver interrompido; a alternativa com tar não retoma nem verifica nada arquivo por arquivo.",
        "A verificação SHA-256 roda automaticamente; uma divergência é relatada e esse arquivo é marcado como falho.",
      ],
    },
    {
      heading: "Execute-o de forma agendada com o cron",
      body: [
        "Agende o sync, não o push. O push recusa um destino que já existe, então um push noturno para o mesmo diretório dá certo uma vez e é recusado em todas as noites seguintes. O sync é o modo feito para uma execução repetida: pula os arquivos cujo tamanho e data de modificação não mudaram, envia só o que mudou e continua um arquivo parcial deixado por uma execução interrompida. É um único comando não interativo que usa suas chaves SSH, então entra direto no cron. Aponte-o para uma chave sem frase-senha (ou para um agente) e registre a saída para conseguir ver as falhas:",
      ],
      code: [
        `# backup toda noite às 2h — adicione ao seu crontab (crontab -e)
0 2 * * * relayium sync -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Um sync noturno que é interrompido simplesmente continua na noite seguinte: o que já corresponde é pulado, e um arquivo parcial é continuado em vez de recomeçado.",
        "O comando encerra com código diferente de zero se algum arquivo falhar na verificação de integridade, então o e-mail de falha do cron detecta os problemas.",
      ],
    },
    {
      heading: "Quando um backup não chega",
      body: [
        "Um backup agendado falha em silêncio por natureza: ninguém está olhando o terminal. Estes quatro casos cobrem quase tudo, e cada um é decidido por um comando que você pode rodar agora.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "A tarefa do cron trava, ou o log termina num pedido de senha.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@your-server true
# Permission denied (publickey).`,
            ],
            fix: "BatchMode=yes se recusa a perguntar e falha, o que transforma um travamento mudo nesta linha. Acrescente a parte pública dessa chave ao ~/.ssh/authorized_keys do servidor, ou aponte a tarefa para uma chave que o agente já carregou.",
          },
          {
            symptom: "A linha do crontab roda, mas o log continua vazio.",
            code: [
              `command -v relayium
# /usr/local/bin/relayium`,
            ],
            fix: "O cron roda com um PATH mínimo que normalmente não tem /usr/local/bin, então a linha falha antes de o relayium começar. Escreva na entrada do crontab o caminho absoluto que a verificação acabou de imprimir, e mantenha o redirecionamento >> ~/relayium-backup.log 2>&1 para que a próxima falha apareça.",
          },
          {
            symptom: "Um sync noturno interrompido recomeça do zero na execução seguinte.",
            code: [
              `ssh user@your-server command -v relayium
# (não imprime nada)`,
            ],
            fix: "Falta o relayium no remoto. O sync não tem alternativa nenhuma e por isso nem chega a rodar, e o push cai no fluxo tar, que não verifica nada e sempre reenvia cada arquivo inteiro. Instale-o no servidor. Só o sync continua um arquivo parcial na execução seguinte: nem o push nem o pull retoma, em nenhum dos dois protocolos. Se você já usa o sync, confira também que não está passando --no-resume, que desliga de propósito essa retomada no processo à escuta.",
          },
          {
            symptom: "“N file(s) failed integrity check” e uma saída diferente de zero.",
            code: [
              `relayium push ./photos user@your-server:backups/
# 1 file(s) failed integrity check: [photos/IMG_0413.jpg]
echo $?
# 1`,
            ],
            fix: "O SHA-256 calculado na chegada não bateu com o enviado, e o protocolo nativo põe cada arquivo numa área temporária e só o instala quando o hash confere — então aquele caminho nunca foi escrito no servidor, e não há nada para remover lá. Rodar o lote inteiro de novo continua sendo recusado pela verificação de colisões, porque os outros arquivos daquele lote já estão no lugar, então rode o push de novo só naquele caminho. Se falhar outra vez, não é um erro de trânsito pontual: olhe o arquivo de origem (se algo escreve nele enquanto é lido) e o armazenamento dos dois lados.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Os arquivos passam pelos servidores do Relayium?",
        a: "Não. O push e o pull rodam inteiramente sobre a sua própria conexão SSH. Os servidores do Relayium nunca são envolvidos e você não precisa de conta alguma.",
      },
      {
        q: "O servidor precisa ter o relayium instalado?",
        a: "Depende da direção. Para o push é opcional: com o relayium no remoto você obtém o protocolo nativo — uma checagem de colisão antecipada e verificações SHA-256 por arquivo em tudo o que ele transfere — e sem ele, o push recorre a um simples fluxo tar sobre SSH, que ainda funciona, mas não verifica nada arquivo por arquivo. Para o pull é obrigatório: o pull sempre precisa do relayium no remoto (ele não tem alternativa com tar), então instale-o lá primeiro.",
      },
      {
        q: "Como ele escolhe qual chave SSH e qual porta usar?",
        a: "Ele lê o seu ~/.ssh/config como o ssh faz, então os apelidos de host, as chaves e as portas são identificados automaticamente. Você também pode sobrescrevê-los por comando com -i para o arquivo de identidade e -p para a porta.",
      },
      {
        q: "Isso é mais rápido que o rsync?",
        a: "Para enviar ao seu próprio servidor, fica na mesma ordem de grandeza que o rsync sobre SSH; o objetivo não é vencer o rsync, mas dar a você uma única ferramenta que também faz transferências entre redes e de servidor para servidor com a mesma verificação de integridade por arquivo.",
      },
    ],
  },
  cta: {
    text: "Faça o backup do seu próximo diretório da forma direta — pelo seu próprio SSH, com verificação de integridade por arquivo e gratuito.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/back-up-a-server-over-ssh",
  published: "2026-07-08",
  updated: "2026-08-05",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
