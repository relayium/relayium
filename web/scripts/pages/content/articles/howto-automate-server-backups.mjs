// web/scripts/pages/content/articles/howto-automate-server-backups.mjs
// How-to: schedule relayium push / sync from cron for automated encrypted backups.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Schedule an off-host server copy with a cron job",
  description:
    "Schedule relayium push or sync from cron to copy a directory to another server automatically — encrypted in transit, SHA-256-verified per file, and free to run as often as you like. It produces an off-host copy, not a versioned backup.",
  updatedLabel: "Last updated",
  lead: [
    "Copies you have to remember to make don't happen. Cron does remember, and the Relayium CLI is built for that: a single non-interactive command that copies (or mirrors) a directory to another machine and verifies each file it transfers.",
    "Be clear about what a scheduled run gives you. push and sync both put the files as they are right now onto another machine; neither keeps an earlier version. A scheduled sync in particular carries a deletion or an in-place corruption at the source over to the copy on its next run, and --delete makes the deletion half explicit. If you need last week's version of a file, either schedule push into a dated destination as below, or keep snapshots on the destination.",
    "This guide covers scheduling relayium push and the incremental relayium sync from cron, why a repeated push needs a fresh destination, the two transports you can point either one at, and the crontab lines to copy.",
  ],
  sections: [
    {
      heading: "push vs sync: a dated copy or one mirror kept current",
      body: [
        "Both push and sync move a directory to another machine, but only one of them is built to run twice into the same place.",
        "push sends a full SSH or daemon-direct copy, and with relayium on the remote it refuses a destination that already exists rather than overwriting or resuming. That makes it the wrong shape for a nightly job pointed at one fixed directory — the first run succeeds and every run after it is refused — and exactly the right shape for a job that writes into a fresh, dated directory each time, which is also the only arrangement here that leaves you an earlier copy to go back to. push is also the one that works against a bare server with no relayium, via a tar fallback that verifies nothing per file.",
        "sync instead keeps one destination directory as an incremental one-way mirror of the source: files whose size and modification time are unchanged are skipped, only what changed is sent, and a partial file left by an interrupted run is continued on the next run. sync always needs relayium's native protocol on both ends — it has no tar fallback. Being a mirror, it is current rather than historical: delete or corrupt a file at the source and the next run propagates that.",
      ],
      bullets: [
        "Use push into a dated destination when you want each run to stand on its own and older copies to survive.",
        "Use sync for a large or frequently-changing directory kept as one current copy, where re-sending everything every night would be wasteful.",
        "Both verify what they transfer with a per-file SHA-256 on the native protocol. Neither push nor pull resumes; sync is the only one of the three that continues a partial file, and the tar fallback verifies and resumes nothing.",
      ],
    },
    {
      heading: "Two transports: SSH or daemon-direct",
      body: [
        "Point either command at an SSH destination (scp-style, using your ~/.ssh/config) or, if the other machine is running relayium serve, straight at it over the daemon-direct protocol — no SSH needed.",
      ],
      code: [
        `# SSH destination — uses your existing SSH keys and config
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — the destination runs "relayium serve", no SSH required
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "Daemon-direct connections are pinned TLS 1.3 with trust-on-first-use, then pinned to that fingerprint on every run after.",
        "sync accepts the same two destination forms as push.",
      ],
    },
    {
      heading: "Schedule it with cron",
      prereqs: {
        label: "What you need before step 1",
        items: [
          "The CLI on this machine, and on the destination too if you plan to use sync. sync has no tar fallback.",
          "An SSH key with no passphrase, or a destination running relayium serve. cron has no agent and no terminal, so it cannot answer a passphrase prompt.",
          "A source directory that exists at the moment cron fires — not one on a network mount that is only there while you are logged in.",
          "Somewhere to write a log. A cron job whose output goes nowhere is a backup you will find out about when you need it.",
        ],
      },
      steps: [
        {
          text: "Find out where relayium actually is. cron does not use your shell's PATH, and install.sh falls back to ~/.local/bin when /usr/local/bin is not writable — which is exactly the case cron cannot see.",
          code: ["command -v relayium"],
        },
        {
          text: "Confirm the key works with nobody at the keyboard. BatchMode=yes fails instead of prompting, which is what cron would do.",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "Run the whole command by hand once, written exactly as cron will run it, absolute path included.",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "Only then add the schedule. Keep the absolute path and the redirect.",
          code: ["crontab -e"],
        },
        {
          text: "After the first scheduled tick, read the log instead of assuming. This is the step people skip, and it is the one that would have told them.",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "What a working setup looks like",
        body: [
          "relayium resolves to an absolute path you can paste into the crontab, and the BatchMode ssh check exits 0 without printing anything or asking for anything. A backup that only works from your interactive shell is not scheduled yet.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "Both push and sync are single, non-interactive commands, so they drop straight into a crontab. Point them at an SSH key with no passphrase (or an agent), and log the output so failures are visible. Note the destination in the push line: it carries the date, because push refuses a destination that already exists. The % has to be escaped as \\% in a crontab, where a bare % means end-of-command:",
      ],
      code: [
        `# a dated full copy every night at 2am — a fresh destination each run, so the
# collision check never refuses it — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "The command exits non-zero if any file fails its integrity check, so cron's mail-on-failure catches problems.",
        "An interrupted sync catches up on the next scheduled run: what already matches is skipped and a partial file is continued. An interrupted push does not resume — but because each night writes into its own dated directory, the next night is a clean full copy rather than a refusal.",
        "Dated directories accumulate. Prune them on the destination on whatever schedule you can afford, or the disk answers the question for you.",
      ],
    },
    {
      heading: "Mirroring deletions and real-time sync",
      body: [
        "By default sync only ever adds or updates files at the destination. Add --delete to make it a true mirror that also removes files the source no longer has — and who has to agree to that depends on which destination you used. Over relayium:// the receiver is a separate process someone started, so it must have been started as serve --allow-delete; without that the deletions are skipped and reported back to you as denied. Over SSH there is no separate listener to consent: sync starts the receiver itself, through your own SSH session, as you — there is no --allow-delete to set, and passing --delete does delete. The SSH destinations in this guide are that second case.",
        "Two things bound the damage either way. Deletion is confined to the top-level directories the run actually sends, so a sibling directory on the destination is never touched; and sync refuses --delete outright if the source resolves to no files, so a typo in the source path or an unmounted source cannot empty the destination.",
        "If you'd rather not wait for cron's next tick, --watch keeps relayium sync running and re-syncs automatically a moment after any file under the source changes — a lightweight alternative to polling on a schedule.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete mirrors deletions, and over SSH it needs nobody's permission but yours. Leave --delete off if a mistaken deletion at the source is a worse outcome than a stale file on the destination.",
        "relayium sync ./data relayium://backup-server:9031 --delete deletes only if that listener was started with serve --allow-delete; otherwise it is reported back as denied.",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch stays running and re-syncs on change instead of running once from cron.",
      ],
    },
    {
      heading: "When it doesn't work",
      body: [
        "Every one of these is invisible until you look at the log, which is why the log redirect is in the crontab line rather than being optional. The fifth is worse than invisible: it looks like success.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The log says relayium: command not found, but the same command works in your shell.",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "cron runs with a minimal PATH, usually just /usr/bin:/bin. If install.sh could not write to /usr/local/bin it put the binary in ~/.local/bin, which cron will never find. Use the absolute path from command -v in the crontab line, or set PATH= on a line at the top of the crontab.",
          },
          {
            symptom: "The log shows the ssh connection being refused, or nothing after the first run.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "cron has no ssh-agent and no terminal, so a key with a passphrase can only hang or fail. Point -i at a passphrase-less key reserved for backups, and confirm with BatchMode=yes, which refuses to prompt rather than waiting for someone who is not there.",
          },
          {
            symptom: "sync runs cleanly but files deleted at the source are still on the destination.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "Over a relayium:// destination, deletion is a receiver-side opt-in: without serve --allow-delete on the other end the deletions are skipped and reported back as denied, which is why the log has the answer and the exit code does not. Restart that listener with --allow-delete. Over an SSH destination there is no listener to ask, so a denial is not the explanation — check that --delete is actually on the crontab line, since without it sync only ever adds and updates.",
          },
          {
            symptom: "sync refuses --delete outright.",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "The source resolved to no files, so the mirror would have emptied the destination. That refusal is deliberate. Check the path for a typo, and check that anything mounted there is actually mounted at the time cron fires rather than only when you are logged in.",
          },
          {
            symptom: "The backup runs, exits 0, and is not what you think it is.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "push falls back to a plain tar stream over SSH when the remote has no relayium. Your files arrive, so nothing complains — but that path has no per-file SHA-256 verification and no up-front collision check, which are the two reasons to schedule this rather than scp, and tar -x -k can leave a batch partly applied. Install the CLI on the destination to get them back. sync does not have this failure mode because it has no fallback at all: it fails loudly instead.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the backup server need relayium installed?",
        a: "It depends on the command. push works either way: with relayium installed it uses the native protocol (an up-front collision check, plus a SHA-256 on every file it transfers); without it, push falls back to a plain tar stream over SSH, so a bare server still works but nothing is verified per file. sync always needs relayium's native protocol on the remote — there's no tar fallback for sync, so install it there first.",
      },
      {
        q: "Is the copy encrypted and verified?",
        a: "In transit, yes, and per file with a caveat worth knowing. Pushing over SSH or daemon-direct means the bytes are already protected by that connection's encryption, with nothing extra to configure. On the native protocol every file the run transfers is checked with a SHA-256 hash end to end — but the tar fallback hashes nothing, and sync decides what to send from size and modification time, so a file it skips is never read and therefore never hashed. Matching directory sizes are a sanity check, not proof that a skipped file's contents still match.",
      },
      {
        q: "What happens if the cron job is interrupted halfway through?",
        a: "It depends which command you scheduled. sync continues: the next run skips what already matches and carries on a partial file, and --no-resume turns that off. push does not resume in either protocol — it refuses a destination that already exists, which is why the push line above writes into a dated directory, so the next night is a clean full copy rather than a refusal. --no-resume is accepted by push and does nothing.",
      },
      {
        q: "Can --delete accidentally wipe my destination?",
        a: "sync refuses to run with --delete if the source directory contains no files, and the receiver has to be started with serve --allow-delete for deletions to take effect at all — otherwise they're skipped and reported back to you.",
      },
      {
        q: "Do I need an account or does this cost anything?",
        a: "No. The CLI is free and needs no account for push, pull, or sync — the transfer runs over your own SSH connection or a direct daemon connection, not through Relayium's servers.",
      },
      {
        q: "Is this a backup?",
        a: "It is the off-host copy half of one. A scheduled sync keeps one directory current, which means it also propagates a deletion or an in-place corruption at the source on its next run; a scheduled push into a dated directory does keep older copies, but only for as long as you keep the directories, and nothing here prunes or verifies them for you. Treat it as a copy you own on hardware you control, and pair it with snapshots or a versioning tool if you need to recover a file as it was last week.",
      },
    ],
  },
  cta: {
    text: "Put an off-host copy on a schedule you don't have to remember — encrypted in transit, verified per file, and free.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 cron 任务定时做异地服务器副本",
  description:
    "在 cron 里定时运行 relayium push 或 sync，按计划自动把目录复制到另一台服务器——传输加密、逐文件 SHA-256 校验，而且想跑多频繁都免费。它产出的是一份异地副本，不是带版本历史的备份。",
  updatedLabel: "最近更新",
  lead: [
    "需要你记得手动做的副本，往往就不会发生。cron 会记得，而 Relayium CLI 正是为此而生：一条非交互式命令，把目录复制（或镜像）到另一台机器，并校验它传输的每个文件。",
    "先把定时任务能给你什么说清楚。push 和 sync 都是把文件此刻的样子放到另一台机器上，两者都不保留旧版本。尤其是定时 sync，会在下一次运行时把源端的删除或原地损坏一起带过去，而 --delete 更是把删除这一半明确打开。如果你需要上周那一版，要么像下面那样让 push 写进按日期命名的目录，要么在目标端保留快照。",
    "本文介绍如何用 cron 定时运行 relayium push 和增量的 relayium sync、为什么反复运行的 push 需要一个全新的目标、两者共用的两种传输方式，以及可以直接抄走的 crontab 行。",
  ],
  sections: [
    {
      heading: "push 与 sync：按日期的完整副本，还是一份持续更新的镜像",
      body: [
        "push 和 sync 都能把一个目录送到另一台机器，但只有其中一个是为往同一个位置反复运行而设计的。",
        "push 每次都通过 SSH 或 daemon 直连发送一份完整拷贝；在远端装有 relayium 时，它会拒绝已存在的目标，而不是覆盖或续传。这让它完全不适合每晚指向同一个固定目录——第一晚成功，之后每晚都被拒——却恰好适合每次写进一个全新的、按日期命名的目录，而那也是这里唯一能给你留下旧副本的做法。push 还是唯一能对付没装 relayium 的裸服务器的命令，靠的是一条逐文件什么都不校验的 tar 兜底路径。",
        "sync 则把一个目标目录维护成源目录的增量单向镜像：大小与修改时间都没变的文件会被跳过，只发送变化的部分，上一次中断留下的半截文件会在下次运行时接着传。sync 始终需要两端都用 relayium 的原生协议——它没有 tar 兜底方案。既然是镜像，它反映的就是当下而不是历史：源端删掉或损坏一个文件，下一次运行就会把这件事同步过去。",
      ],
      bullets: [
        "希望每次运行各自独立、旧副本还能留着，就让 push 写进按日期命名的目标。",
        "目录很大或者经常变动，只想保留一份持续更新的副本、每晚重发全部内容太浪费，就用 sync。",
        "走原生协议时，两者都会对自己传输的文件做逐文件 SHA-256 校验。push 和 pull 都不续传；三者之中只有 sync 会接着传半截文件，而 tar 兜底路径既不校验也不续传。",
      ],
    },
    {
      heading: "两种传输方式：SSH 或daemon 直连",
      body: [
        "两个命令都可以指向一个 SSH 目标（scp 风格，走你的 ~/.ssh/config）；如果对方机器正跑着 relayium serve，也可以用daemon 直连（daemon-direct）协议直接连过去——不需要 SSH。",
      ],
      code: [
        `# SSH 目标——使用你现有的 SSH 密钥和配置
relayium push ./data user@backup-server:/srv/backups/

# daemon 直连——目标机器运行着 "relayium serve"，无需 SSH
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon 直连走的是带证书证书固定的 TLS 1.3：首次连接时信任（trust-on-first-use），之后每次运行都校验同一个指纹。",
        "sync 接受和 push 完全相同的两种目标写法。",
      ],
    },
    {
      heading: "用 cron 定时运行",
      prereqs: {
        label: "开始之前你需要什么",
        items: [
          "本机装好 CLI；如果你打算用 sync，目标机器上也要装。sync 没有 tar 兜底。",
          "一把没有口令的 SSH 密钥，或者一台在跑 relayium serve 的目标机。cron 既没有 agent 也没有终端，回答不了口令提示。",
          "一个在 cron 触发的那一刻确实存在的源目录——不能是那种只有你登录时才挂上的网络挂载点。",
          "一个写日志的地方。输出无处可去的 cron 任务，等于一份等你真正需要时才会发现问题的备份。",
        ],
      },
      steps: [
        {
          text: "先查清 relayium 到底在哪。cron 不用你 shell 的 PATH，而 install.sh 在 /usr/local/bin 不可写时会退到 ~/.local/bin——那正好是 cron 看不见的地方。",
          code: ["command -v relayium"],
        },
        {
          text: "确认这把密钥在没人守着键盘时也能用。BatchMode=yes 会直接失败而不是弹提示，这正是 cron 的处境。",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "先手动完整跑一次，写法要和 cron 将要执行的一模一样，包括绝对路径。",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "确认之后再加计划任务。绝对路径和重定向都要保留。",
          code: ["crontab -e"],
        },
        {
          text: "第一次定时执行之后，去读日志，不要想当然。这一步是最容易被跳过的，也正是本可以提前告诉你问题的那一步。",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "一个配置正确的备份长什么样",
        body: [
          "relayium 解析出一个可以直接粘进 crontab 的绝对路径，并且那条 BatchMode 的 ssh 检查什么都不打印、什么都不问、退出码为 0。只在你的交互式 shell 里能跑通的备份，还不算配好了。",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "push 和 sync 都是单条非交互式命令，可以直接放进 crontab。给它指定一个没有口令的密钥（或者用 agent），并把输出记下来，好让失败能被看见。注意 push 那一行的目标里带了日期：因为 push 会拒绝已存在的目标。在 crontab 里 % 必须写成 \\%，裸的 % 表示命令到此为止：",
      ],
      code: [
        `# 每晚 2 点做一次按日期归档的完整复制——每次都是全新的目标，
# 所以冲突检查永远不会拒绝它——添加到你的 crontab（crontab -e）
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# 改为每 15 分钟做一次增量镜像
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "只要有文件没通过完整性校验，命令就会以非零状态退出，cron 的失败邮件通知就能发现问题。",
        "被中断的 sync 会在下一次计划运行时补上：已匹配的跳过，半截的接着传。被中断的 push 不续传——但因为每晚都写进各自按日期命名的目录，第二晚是一次干净的完整复制，而不是一次拒绝。",
        "按日期命名的目录会越堆越多。请在目标端按你负担得起的节奏清理，否则磁盘会替你回答这个问题。",
      ],
    },
    {
      heading: "镜像删除与实时同步",
      body: [
        "默认情况下，sync 只会在目标端新增或更新文件。加上 --delete 才会变成真正的镜像，把源目录里已经不存在的文件也从目标端删掉——而谁需要同意这件事，取决于你用的是哪种目标。走 relayium:// 时，接收端是别人启动的独立进程，所以它必须以 serve --allow-delete 启动；否则这些删除会被跳过，并回报给你为 denied。走 SSH 时根本没有独立的监听端可以同意：sync 是通过你自己的 SSH 会话、以你的身份把接收端拉起来的——没有 --allow-delete 可设，传了 --delete 就是真删。本文里的 SSH 目标属于后一种情况。",
        "两件事限定了破坏范围：删除只会发生在这一次运行真正发送的顶层目录内，目标端的兄弟目录永远不会被碰；而且如果源端解析不出任何文件，sync 会直接拒绝 --delete，所以源路径写错、或者该挂的没挂上，都清空不了目标目录。",
        "不想等 cron 的下一个执行点，就用 --watch：它会让 relayium sync 常驻运行，源目录下一有文件变动，片刻之后就自动重新同步——比按计划轮询更轻量。",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete 会把删除也镜像过去，而走 SSH 时除了你自己没人需要同意。如果源端误删比目标端留个旧文件更糟，就别加 --delete。",
        "relayium sync ./data relayium://backup-server:9031 --delete 只有在那个监听端以 serve --allow-delete 启动时才会真删；否则会回报为 denied。",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch 会常驻运行，一有变化就同步，而不是靠 cron 单次触发。",
      ],
    },
    {
      heading: "出问题时怎么办",
      body: [
        "这里每一种在你去看日志之前都是不可见的，所以那条日志重定向写在 crontab 行里，而不是可选项。第五种比不可见更糟：它看起来像成功。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "日志里写 relayium: command not found，但同一条命令在你的 shell 里能跑。",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "cron 使用一个最小化的 PATH，通常只有 /usr/bin:/bin。如果 install.sh 当初写不进 /usr/local/bin，它会把二进制放在 ~/.local/bin，而 cron 永远找不到那里。把 command -v 给出的绝对路径写进 crontab 行，或者在 crontab 顶部单独加一行 PATH=。",
          },
          {
            symptom: "日志显示 ssh 连接被拒绝，或者第一次运行之后就什么都没有了。",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "cron 既没有 ssh-agent 也没有终端，所以带口令的密钥只能卡住或失败。用 -i 指向一把专供备份、没有口令的密钥，并用 BatchMode=yes 确认——它宁可拒绝也不会去等一个根本不在场的人。",
          },
          {
            symptom: "sync 跑得很干净，但源端已删除的文件在目标端还在。",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "走 relayium:// 目标时，删除是接收端的显式选项：对端没有 serve --allow-delete，这些删除就会被跳过并回报为 denied，所以答案在日志里而不在退出码里，给那个监听器加上 --allow-delete 重启即可。走 SSH 目标时根本没有监听端可问，所以被拒不是原因——去确认 crontab 那行上真的写了 --delete，因为不加它 sync 只会新增和更新。",
          },
          {
            symptom: "sync 直接拒绝执行 --delete。",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "源端解析下来一个文件都没有，这时镜像会把目标端清空。这个拒绝是刻意的。检查路径是不是敲错了，也检查那里该挂载的东西在 cron 触发的时刻是否真的挂着，而不是只在你登录时才挂。",
          },
          {
            symptom: "备份跑了，退出码 0，但它并不是你以为的那个东西。",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "远端没有 relayium 时，push 会退回到走 SSH 的普通 tar 流。文件确实到了，所以没有任何东西报警——但这条路径既没有逐文件 SHA-256 校验，也没有发送前的冲突预检，而这两点恰恰是你不用 scp 而设这个计划任务的理由，何况 tar -x -k 还可能让一批文件只装了一半。在目标机上装好 CLI 就能把它们拿回来。sync 不存在这种失败方式，因为它根本没有兜底：它会直接大声失败。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "备份服务器需要装 relayium 吗？",
        a: "要看用哪条命令。push 不管远端装没装都能用：装了就走原生协议（发送前的冲突预检，外加对它传输的每个文件做 SHA-256 校验）；没装的话，push 会退回到通过 SSH 传输 tar 流，一台裸服务器也照样能收，只是逐文件什么都不校验。sync 则始终需要远端有 relayium 的原生协议——它没有 tar 兜底方案，请先在远端装好。",
      },
      {
        q: "这份副本会加密并校验吗？",
        a: "传输层是加密的；逐文件校验也有，但有一个值得知道的边界。通过 SSH 或 daemon 直连推送时，字节已经受该连接自身的加密保护，不需要额外配置什么。走原生协议时，这一次运行传输的每个文件都会做端到端的 SHA-256 校验——但 tar 兜底路径不做任何哈希，而 sync 是按大小和修改时间决定要不要发送的，被它跳过的文件根本不会被读取，也就不会被哈希。目录总大小对得上只是一个粗略的自检，不能证明被跳过的文件内容仍然一致。",
      },
      {
        q: "如果 cron 任务执行到一半被中断会怎样？",
        a: "看你排的是哪条命令。sync 会接着来：下一次运行跳过已匹配的文件，并把半截的文件接着传，--no-resume 可以关掉这一点。push 在两条协议下都不续传——它会拒绝已存在的目标，这正是上面那行 push 写进按日期命名目录的原因，好让第二晚是一次干净的完整复制而不是一次拒绝。--no-resume 在 push 上能被接受，但什么也不做。",
      },
      {
        q: "--delete 会不会不小心清空我的目标目录？",
        a: "如果源目录里一个文件都没有，sync 会直接拒绝执行 --delete；删除也只会发生在这一次运行真正发送的顶层目录内。至于谁需要同意，取决于目标：走 relayium:// 时接收端必须以 serve --allow-delete 启动，删除才会生效，否则会被跳过并报告给你；走 SSH 时没有独立的监听端可以拒绝，传了 --delete 就是真删。",
      },
      {
        q: "需要账号吗，这个要收费吗？",
        a: "都不需要。CLI 的 push、pull、sync 都不需要账号，也不收费——传输走的是你自己的 SSH 连接，或者一条daemon 直连，不经过 Relayium 的服务器。",
      },
      {
        q: "这算备份吗？",
        a: "它是备份里“异地副本”那一半。定时 sync 保持一份目录的最新状态，这也意味着它会在下一次运行时把源端的删除或原地损坏一起带过去；定时 push 写进按日期命名的目录确实会留下旧副本，但也只在你不清理这些目录的期间有效，而且这里没有任何东西会替你清理或校验它们。请把它当作一份放在你自己硬件上的副本，如果需要恢复到上周的样子，再配一层快照或会做版本管理的工具。",
      },
    ],
  },
  cta: {
    text: "把一份异地副本交给一个你不用记着的日程——传输加密、逐文件校验，而且免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "cron で暗号化されたサーバーバックアップを自動化する",
  description:
    "cron から relayium push または sync を定期実行して、ディレクトリを別のサーバーへ自動コピー。転送は暗号化され、ファイルごとに SHA-256 で検証され、しかも無料です。",
  updatedLabel: "最終更新",
  lead: [
    "自分で覚えて実行しなければならないバックアップは、たいてい実行されません。cron は覚えていてくれますし、Relayium CLI はまさにそのために作られています。ディレクトリを別のマシンへコピー（またはミラー）し、転送する各ファイルを検証する、単一の非対話型コマンドです。",
    "本ガイドでは、cron から relayium push と増分同期の relayium sync をスケジュール実行する方法、どちらでも使える2つの転送方式、そしてそのままコピーできる crontab の行を扱います。",
  ],
  sections: [
    {
      heading: "push と sync：全体コピーか増分ミラーか",
      body: [
        "push と sync はどちらもディレクトリを別のマシンへ転送し、どちらも繰り返し実行して安全ですが、解決するバックアップの課題は少し異なります。",
        "push は実行するたびに SSH または daemon-direct 経由で毎回コピーを送ります。シンプルで、relayium がインストールされていない素のサーバーに対しても tar フォールバックで動作します。一方 sync は宛先をソースの増分・一方向ミラーとして維持します。変更されたファイルだけを再送するので、大きなディレクトリでも最初の同期の後は夜間の同期が高速です。sync は常に両端で relayium のネイティブプロトコルを必要とします。tar フォールバックはありません。",
      ],
      bullets: [
        "relayium がインストールされていないかもしれないサーバーへの、シンプルなスケジュールコピーには push を使いましょう。",
        "大きい、あるいは頻繁に変化するディレクトリで、毎晩すべてを再送するのが無駄になる場合は sync を使いましょう。",
        "どちらもネイティブプロトコルでは転送したものをファイルごとに SHA-256 で検証します。push も pull も再開しません。半端なファイルを続けられるのは3つのうち sync だけで、tar フォールバックは検証も再開もしません。",
      ],
    },
    {
      heading: "2つの転送方式：SSH か daemon-direct か",
      body: [
        "どちらのコマンドも、SSH の宛先（scp 形式、お使いの ~/.ssh/config を使用）を指定できますし、相手のマシンで relayium serve が動いていれば、SSH なしで daemon-direct プロトコル経由で直接接続することもできます。",
      ],
      code: [
        `# SSH の宛先：既存の SSH 鍵と設定をそのまま使います
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct：宛先で "relayium serve" が動いていれば SSH は不要です
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon-direct 接続はピン留めされた TLS 1.3 で、初回接続時に信頼（trust-on-first-use）し、以降の実行では同じフィンガープリントに対して検証します。",
        "sync は push と同じ2つの宛先の書き方を受け付けます。",
      ],
    },
    {
      heading: "cron でスケジュール実行する",
      prereqs: {
        label: "手順1の前に必要なもの",
        items: [
          "このマシンの CLI。sync を使うつもりなら送り先にも必要です。sync に tar のフォールバックはありません。",
          "パスフレーズなしの SSH 鍵、または relayium serve が動いている送り先。cron にはエージェントも端末もないため、パスフレーズの入力には答えられません。",
          "cron が起動する時点で実在するソースディレクトリ。ログイン中だけマウントされるネットワーク領域では困ります。",
          "ログの書き出し先。出力がどこにも残らない cron ジョブは、必要になったときに初めて問題が分かるバックアップです。",
        ],
      },
      steps: [
        {
          text: "relayium が実際にどこにあるかを調べます。cron はシェルの PATH を使わず、install.sh は /usr/local/bin に書けないとき ~/.local/bin に置きます——まさに cron から見えない場所です。",
          code: ["command -v relayium"],
        },
        {
          text: "誰も鍵盤の前にいない状態でも鍵が使えるか確認します。BatchMode=yes は入力を促さずに失敗するので、cron と同じ条件です。",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "まず手で一度、cron が実行するのとまったく同じ書き方で、絶対パスも含めて通しで実行します。",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "それが通ってからスケジュールを追加します。絶対パスとリダイレクトはそのまま残してください。",
          code: ["crontab -e"],
        },
        {
          text: "最初の定期実行のあと、思い込まずにログを読みます。ここが最も飛ばされやすく、そして問題を教えてくれたはずの手順です。",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "正しく設定できたときの見え方",
        body: [
          "relayium が crontab にそのまま貼れる絶対パスとして解決され、BatchMode 付きの ssh 確認が何も表示せず何も尋ねずに終了コード0で終わります。対話シェルでしか動かないバックアップは、まだスケジュールされていません。",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "push と sync はどちらも単一の非対話型コマンドなので、そのまま crontab に組み込めます。パスフレーズなしの鍵（または agent）を指定し、出力をログに残して失敗を確認できるようにしましょう：",
      ],
      code: [
        `# 毎晩2時に全体コピー：crontab に追加します（crontab -e）
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# 代わりに15分ごとの増分ミラー
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "いずれかのファイルが整合性チェックに失敗すると、コマンドは非ゼロで終了するので、cron の失敗時メール通知で問題に気づけます。",
        "中断された sync は次の予定実行で追いつきます。すでに一致するものは飛ばされ、半端なファイルは続きから送られます。中断された push は再開しませんが、毎晩それぞれ日付付きのディレクトリへ書くので、翌晩は拒否ではなく新しい完全なコピーになります。",
      ],
    },
    {
      heading: "削除のミラーリングとリアルタイム同期",
      body: [
        "デフォルトでは、sync は宛先側でファイルを追加または更新するだけです。--delete を付けると真のミラーになり、ソースにもう存在しないファイルも削除します。受信側は serve --allow-delete で明示的に待ち受けている必要があり、そうでなければ削除は黙って無視され、拒否されたと結果に報告されます。ソースディレクトリが1つもファイルを解決しない場合、sync は --delete の実行そのものを拒否するので、ソースパスの誤字で宛先が消えてしまうことはありません。",
        "cron の次の実行タイミングを待ちたくない場合は、--watch を使うと relayium sync が動き続け、ソース配下のファイルが変化するとすぐに自動で再同期します。スケジュールでポーリングする代わりの軽量な選択肢です。",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete は削除もミラーします（受信側に serve --allow-delete が必要）。",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch は動き続けて変化のたびに同期します。cron による単発実行の代わりに使えます。",
      ],
    },
    {
      heading: "うまくいかないとき",
      body: [
        "どれもログを見るまでは表に出ません。だからログのリダイレクトは crontab の行に最初から入っていて、任意ではないのです。5つめは見えないより厄介で、成功したように見えます。",
      ],
      troubleshooting: {
        label: "症状、確認、対処",
        items: [
          {
            symptom: "ログに relayium: command not found と出るのに、同じコマンドがシェルでは動く。",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "cron は最小限の PATH、たいてい /usr/bin:/bin だけで動きます。install.sh が /usr/local/bin に書けなかった場合、バイナリは ~/.local/bin に置かれ、cron はそこを決して探しません。command -v が示す絶対パスを crontab の行に書くか、crontab の先頭に PATH= の行を足してください。",
          },
          {
            symptom: "ログに ssh 接続の拒否が出る、または初回以降なにも記録されない。",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "cron には ssh-agent も端末もないため、パスフレーズ付きの鍵は固まるか失敗するかしかありません。-i でバックアップ専用のパスフレーズなし鍵を指し、BatchMode=yes で確認してください。これは、そこにいない人を待つ代わりに入力を拒否します。",
          },
          {
            symptom: "sync は問題なく走るのに、ソースで削除したファイルが送り先に残っている。",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "削除は受信側のオプトインです。相手側に serve --allow-delete がなければ削除はスキップされ、denied として報告されます。答えが終了コードではなくログにあるのはそのためです。受信側のリスナーを --allow-delete 付きで再起動してください。",
          },
          {
            symptom: "sync が --delete をきっぱり拒否する。",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "ソース側が1ファイルも解決できず、そのままではミラーが送り先を空にしてしまう状態です。この拒否は意図的です。パスの打ち間違いを確認し、そこにマウントされるはずのものが、ログイン中だけでなく cron の起動時点でも実際にマウントされているかを確認してください。",
          },
          {
            symptom: "バックアップは走り、終了コード0で終わるのに、中身は思っているものではない。",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "リモートに relayium がないとき、push は SSH 上の素の tar ストリームにフォールバックします。ファイルは届くので何も文句を言いませんが、その経路にはファイルごとの SHA-256 検証も、送信前の衝突チェックもありません——scp ではなくこれをスケジュールする理由そのものが失われます。送り先に CLI を入れれば戻ります。sync にこの失敗はありません。フォールバックが一切ないので、代わりに大きな音を立てて失敗します。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "バックアップサーバーに relayium のインストールは必要ですか？",
        a: "コマンドによります。push はどちらでも動作します。relayium がインストールされていればネイティブプロトコル（送信前の衝突チェック + ファイルごとの SHA-256 検証）を使い、なければ push は SSH 上の tar ストリームにフォールバックするので、素のサーバーでも動作します。sync は常にリモート側で relayium のネイティブプロトコルが必要です。sync に tar フォールバックはないので、先にインストールしてください。",
      },
      {
        q: "バックアップは暗号化・検証されますか？",
        a: "されます。すべてのファイルはエンドツーエンドで SHA-256 ハッシュによって検証され、SSH または daemon-direct でプッシュする場合、バイトはその接続自体の暗号化によってすでに保護されています。追加の設定は不要です。",
      },
      {
        q: "cron ジョブが途中で中断された場合はどうなりますか？",
        a: "どちらのコマンドを予定したかによります。sync は続きます。次の実行はすでに一致するものを飛ばし、半端なファイルを続きから送ります。--no-resume はそれを切ります。push はどちらのプロトコルでも再開しません。既存の宛先を拒否するからで、上の push の行が日付付きディレクトリへ書いているのはそのためです。おかげで翌晩は拒否ではなく新しい完全なコピーになります。--no-resume は push でも受け付けられますが、何もしません。",
      },
      {
        q: "--delete で誤って宛先を消してしまうことはありますか？",
        a: "sync はソースディレクトリにファイルが1つもない場合、--delete の実行自体を拒否します。また、削除が実際に反映されるには受信側が serve --allow-delete で起動されている必要があります。そうでなければスキップされ、結果として報告されます。",
      },
      {
        q: "アカウントは必要ですか、これは有料ですか？",
        a: "いいえ。CLI は無料で、push、pull、sync のいずれにもアカウントは不要です。転送はご自身の SSH 接続、または直接の daemon 接続の上で行われ、Relayium のサーバーは経由しません。",
      },
    ],
  },
  cta: {
    text: "覚えておかなくていいスケジュールにバックアップを乗せましょう。転送は暗号化され、ファイルごとに検証され、そして無料です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "cron 작업으로 암호화된 서버 백업 자동화하기",
  description:
    "cron에서 relayium push나 sync를 예약 실행해 디렉터리를 다른 서버로 자동 복사하세요 — 전송 중 암호화되고, 파일별로 SHA-256 검증이 되며, 무료입니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "직접 기억해서 실행해야 하는 백업은 결국 실행되지 않습니다. cron은 기억해 주며, Relayium CLI는 바로 그 목적을 위해 만들어졌습니다: 디렉터리를 다른 머신으로 복사(또는 미러링)하고, 전송하는 각 파일을 검증하는 단일 비대화형 명령입니다.",
    "이 가이드는 cron에서 relayium push와 증분 방식의 relayium sync를 예약하는 방법, 둘 다에 사용할 수 있는 두 가지 전송 방식, 그리고 그대로 복사해 쓸 수 있는 crontab 줄을 다룹니다.",
  ],
  sections: [
    {
      heading: "push와 sync: 전체 복사냐 증분 미러링이냐",
      body: [
        "push와 sync는 둘 다 디렉터리를 다른 머신으로 옮기고, 둘 다 반복 실행해도 안전하지만, 해결하는 백업 문제는 조금 다릅니다.",
        "push는 실행할 때마다 SSH 또는 daemon-direct로 매번 전체 복사본을 보냅니다 — 단순하며, relayium이 설치되지 않은 순수한 서버에도 tar 대체 방식으로 동작합니다. 반면 sync는 대상을 소스의 증분 단방향 미러로 유지합니다. 변경된 파일만 다시 전송하므로, 큰 디렉터리라도 첫 실행 이후의 야간 동기화는 빠릅니다. sync는 항상 양쪽 모두에서 relayium의 네이티브 프로토콜이 필요합니다 — tar 대체 방식이 없습니다.",
      ],
      bullets: [
        "relayium이 설치되어 있지 않을 수도 있는 서버로의 단순한 예약 복사에는 push를 사용하세요.",
        "크거나 자주 변하는 디렉터리에서 매일 밤 전체를 다시 보내는 것이 낭비라면 sync를 사용하세요.",
        "둘 다 네이티브 프로토콜에서는 전송하는 것을 파일별 SHA-256으로 검증합니다. push도 pull도 재개하지 않습니다. 셋 중 부분 파일을 이어가는 것은 sync뿐이며, tar 대체 방식은 검증도 재개도 하지 않습니다.",
      ],
    },
    {
      heading: "두 가지 전송 방식: SSH 또는 daemon-direct",
      body: [
        "두 명령 모두 SSH 대상(scp 형식, 기존 ~/.ssh/config 사용)을 지정할 수도 있고, 상대 머신에서 relayium serve가 실행 중이라면 SSH 없이 daemon-direct 프로토콜로 곧장 연결할 수도 있습니다.",
      ],
      code: [
        `# SSH 대상: 기존 SSH 키와 설정을 그대로 사용합니다
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct: 대상에서 "relayium serve"가 실행 중이면 SSH가 필요 없습니다
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon-direct 연결은 고정된(pinned) TLS 1.3을 사용하며, 처음 연결할 때 신뢰(trust-on-first-use)하고 이후 실행부터는 같은 지문(fingerprint)에 대해 검증합니다.",
        "sync는 push와 동일한 두 가지 대상 표기법을 받아들입니다.",
      ],
    },
    {
      heading: "cron으로 예약 실행하기",
      prereqs: {
        label: "1단계 전에 필요한 것",
        items: [
          "이 기기의 CLI. sync를 쓸 생각이라면 목적지에도 필요합니다. sync에는 tar 대체 경로가 없습니다.",
          "암호가 없는 SSH 키, 또는 relayium serve를 돌리는 목적지. cron에는 에이전트도 터미널도 없어 암호 입력에 답할 수 없습니다.",
          "cron이 실행되는 시점에 실제로 존재하는 원본 디렉터리. 로그인해 있을 때만 붙는 네트워크 마운트는 곤란합니다.",
          "로그를 남길 곳. 출력이 아무 데도 가지 않는 cron 작업은, 정작 필요할 때에야 문제를 알게 되는 백업입니다.",
        ],
      },
      steps: [
        {
          text: "relayium이 실제로 어디에 있는지 확인하세요. cron은 셸의 PATH를 쓰지 않고, install.sh는 /usr/local/bin에 쓸 수 없으면 ~/.local/bin에 둡니다 — 바로 cron이 보지 못하는 자리입니다.",
          code: ["command -v relayium"],
        },
        {
          text: "아무도 키보드 앞에 없어도 키가 동작하는지 확인하세요. BatchMode=yes는 묻지 않고 실패하므로 cron과 같은 조건입니다.",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "먼저 손으로 한 번, cron이 실행할 것과 똑같은 형태로 절대 경로까지 포함해 통째로 실행해 보세요.",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "그다음에야 스케줄을 추가합니다. 절대 경로와 리다이렉트는 그대로 두세요.",
          code: ["crontab -e"],
        },
        {
          text: "첫 예약 실행 뒤에는 넘겨짚지 말고 로그를 읽으세요. 사람들이 건너뛰는 단계이자, 문제를 미리 알려 주었을 단계입니다.",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "제대로 설정된 백업의 모습",
        body: [
          "relayium이 crontab에 그대로 붙여 넣을 수 있는 절대 경로로 확인되고, BatchMode를 붙인 ssh 검사가 아무것도 출력하지 않고 아무것도 묻지 않은 채 0으로 끝납니다. 대화형 셸에서만 되는 백업은 아직 예약된 것이 아닙니다.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "push와 sync는 둘 다 단일 비대화형 명령이므로, 그대로 crontab에 넣을 수 있습니다. 암호 없는 키(또는 agent)를 지정하고, 출력을 로그로 남겨 실패를 확인할 수 있게 하세요:",
      ],
      code: [
        `# 매일 밤 2시 전체 복사: crontab에 추가하세요 (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# 대신 15분마다 증분 미러링
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "무결성 검사에 실패한 파일이 하나라도 있으면 명령이 0이 아닌 상태로 종료되므로, cron의 실패 시 메일 알림으로 문제를 발견할 수 있습니다.",
        "중단된 sync는 다음 예약 실행에서 따라잡습니다: 이미 일치하는 것은 건너뛰고 부분 파일은 이어서 보냅니다. 중단된 push는 재개하지 않지만, 매일 밤 각자의 날짜별 디렉터리에 쓰므로 다음 날 밤은 거부가 아니라 새로운 전체 복사가 됩니다.",
      ],
    },
    {
      heading: "삭제 미러링과 실시간 동기화",
      body: [
        "기본적으로 sync는 대상 쪽에서 파일을 추가하거나 갱신하기만 합니다. --delete를 추가하면 진짜 미러가 되어 소스에 더 이상 없는 파일도 삭제합니다 — 수신 측이 명시적으로 serve --allow-delete로 대기 중이어야 하며, 그렇지 않으면 삭제는 조용히 건너뛰어지고 결과에 거부됨으로 보고됩니다. 소스 디렉터리가 파일을 하나도 찾지 못하면 sync는 --delete 실행 자체를 거부하므로, 소스 경로 오타로 대상이 지워지는 일은 없습니다.",
        "cron의 다음 실행 시각을 기다리고 싶지 않다면, --watch를 사용해 relayium sync를 계속 실행 상태로 두면 소스 아래의 파일이 변경된 직후 자동으로 다시 동기화됩니다 — 예약된 폴링을 대신하는 가벼운 방법입니다.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete는 삭제도 미러링합니다(수신 측에 serve --allow-delete 필요).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch는 계속 실행되며 변경 시마다 동기화합니다. cron의 단발 실행 대신 사용할 수 있습니다.",
      ],
    },
    {
      heading: "잘 안 될 때",
      body: [
        "여기 있는 것들은 로그를 보기 전까지 전부 보이지 않습니다. 로그 리다이렉트가 선택이 아니라 crontab 줄에 처음부터 들어 있는 이유입니다. 다섯 번째는 보이지 않는 것보다 나쁩니다 — 성공처럼 보입니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "로그에 relayium: command not found가 찍히는데 같은 명령이 셸에서는 됩니다.",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "cron은 최소한의 PATH, 보통 /usr/bin:/bin만으로 돕니다. install.sh가 /usr/local/bin에 쓰지 못했다면 바이너리는 ~/.local/bin에 있고, cron은 그곳을 결코 찾지 않습니다. command -v가 알려 준 절대 경로를 crontab 줄에 쓰거나, crontab 맨 위에 PATH= 줄을 넣으세요.",
          },
          {
            symptom: "로그에 ssh 연결이 거부되었다고 나오거나, 첫 실행 이후로 아무것도 없습니다.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "cron에는 ssh-agent도 터미널도 없어서 암호가 걸린 키는 멈추거나 실패할 수밖에 없습니다. -i로 백업 전용의 암호 없는 키를 지정하고 BatchMode=yes로 확인하세요. 그 옵션은 거기 없는 사람을 기다리는 대신 아예 묻기를 거부합니다.",
          },
          {
            symptom: "sync는 깔끔하게 도는데 원본에서 지운 파일이 목적지에 그대로 있습니다.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "삭제는 수신 측이 켜야 하는 옵션입니다. 상대편에 serve --allow-delete가 없으면 삭제는 건너뛰어지고 denied로 보고됩니다. 답이 종료 코드가 아니라 로그에 있는 이유입니다. 수신 측 리스너를 --allow-delete와 함께 재시작하세요.",
          },
          {
            symptom: "sync가 --delete를 아예 거부합니다.",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "원본에서 파일이 하나도 잡히지 않아, 그대로 두면 미러가 목적지를 비워 버리는 상태입니다. 이 거부는 의도된 것입니다. 경로 오타를 확인하고, 거기 붙어야 할 것이 로그인 중일 때뿐 아니라 cron이 도는 시점에도 실제로 마운트되어 있는지 확인하세요.",
          },
          {
            symptom: "백업이 돌고 0으로 끝나는데, 내용이 생각한 그것이 아닙니다.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "원격에 relayium이 없으면 push는 SSH 위의 평범한 tar 스트림으로 물러납니다. 파일은 도착하니 아무도 불평하지 않지만, 그 경로에는 파일별 SHA-256 검증도, 보내기 전 충돌 검사도 없습니다 — scp 대신 이걸 예약하는 두 가지 이유가 바로 그것입니다. 목적지에 CLI를 설치하면 되돌아옵니다. sync에는 이런 실패가 없습니다. 대체 경로가 아예 없어서 대신 요란하게 실패합니다.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "백업 서버에 relayium이 설치되어 있어야 하나요?",
        a: "명령에 따라 다릅니다. push는 어느 쪽이든 동작합니다: relayium이 설치되어 있으면 네이티브 프로토콜(보내기 전 충돌 검사 + 파일별 SHA-256 검사)을 사용하고, 없으면 push는 SSH를 통한 일반 tar 스트림으로 대체되어 순수한 서버에서도 동작합니다. sync는 항상 원격지에 relayium의 네이티브 프로토콜이 필요합니다 — sync에는 tar 대체 방식이 없으므로 먼저 그곳에 설치하세요.",
      },
      {
        q: "백업이 암호화되고 검증되나요?",
        a: "네. 모든 파일은 종단간 SHA-256 해시로 검사되며, SSH나 daemon-direct로 푸시할 때 바이트는 이미 해당 연결 자체의 암호화로 보호됩니다 — 추가로 설정할 것이 없습니다.",
      },
      {
        q: "cron 작업이 중간에 중단되면 어떻게 되나요?",
        a: "어떤 명령을 예약했느냐에 따라 다릅니다. sync는 이어집니다: 다음 실행이 이미 일치하는 것은 건너뛰고 부분 파일을 이어서 보내며, --no-resume이 그것을 끕니다. push는 어느 프로토콜에서든 재개하지 않습니다 — 이미 존재하는 목적지를 거부하며, 위의 push 줄이 날짜별 디렉터리에 쓰는 이유가 바로 그것입니다. 덕분에 다음 날 밤은 거부가 아니라 새로운 전체 복사가 됩니다. --no-resume은 push에서도 받아들여지지만 아무 일도 하지 않습니다.",
      },
      {
        q: "--delete가 실수로 대상을 지워버릴 수 있나요?",
        a: "소스 디렉터리에 파일이 하나도 없으면 sync는 --delete 실행 자체를 거부합니다. 또한 삭제가 실제로 적용되려면 수신 측이 serve --allow-delete로 시작되어 있어야 합니다 — 그렇지 않으면 건너뛰어지고 결과로 보고됩니다.",
      },
      {
        q: "계정이 필요한가요, 비용이 드나요?",
        a: "아니요. CLI는 무료이며 push, pull, sync 모두 계정이 필요 없습니다. 전송은 본인의 SSH 연결이나 직접적인 daemon 연결을 통해 이루어지며, Relayium의 서버를 거치지 않습니다.",
      },
    ],
  },
  cta: {
    text: "기억할 필요 없는 일정에 백업을 올려두세요 — 전송 중 암호화되고, 파일별로 검증되며, 무료입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Verschlüsselte Server-Backups mit einem Cron-Job automatisieren",
  description:
    "Plane relayium push oder sync per cron, um ein Verzeichnis automatisch auf einen anderen Server zu kopieren — auf dem Transportweg verschlüsselt, je Datei per SHA-256 geprüft und kostenlos.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Backups, an die man selbst denken muss, passieren am Ende nicht. cron denkt daran, und die Relayium CLI ist genau dafür gebaut: ein einzelner, nicht-interaktiver Befehl, der ein Verzeichnis auf eine andere Maschine kopiert (oder spiegelt) und jede Datei prüft, die er überträgt.",
    "Diese Anleitung behandelt, wie du relayium push und das inkrementelle relayium sync per cron planst, welche zwei Übertragungswege beide nutzen können, und welche crontab-Zeilen du einfach übernehmen kannst.",
  ],
  sections: [
    {
      heading: "push oder sync: vollständige Kopie oder inkrementelle Spiegelung",
      body: [
        "push und sync übertragen beide ein Verzeichnis auf eine andere Maschine, und beide lassen sich gefahrlos wiederholt ausführen, aber sie lösen leicht unterschiedliche Backup-Probleme.",
        "push sendet bei jedem Lauf eine Kopie per SSH oder daemon-direct — einfach, und funktioniert dank Tar-Fallback sogar gegen einen nackten Server ohne installiertes relayium. sync dagegen hält das Ziel als inkrementellen, einseitigen Spiegel der Quelle: Nur geänderte Dateien werden erneut gesendet, sodass eine nächtliche Synchronisierung eines großen Verzeichnisses nach dem ersten Lauf schnell ist. sync benötigt auf beiden Seiten immer das native Protokoll von relayium — es gibt keinen Tar-Fallback.",
      ],
      bullets: [
        "Nutze push für eine unkomplizierte geplante Kopie, besonders auf einen Server, auf dem eventuell kein relayium installiert ist.",
        "Nutze sync für ein großes oder häufig wechselndes Verzeichnis, bei dem jede Nacht alles neu zu senden Verschwendung wäre.",
        "Beide prüfen, was sie übertragen, im nativen Protokoll je Datei per SHA-256. Weder push noch pull setzt fort; von den dreien führt nur sync eine Teildatei weiter, und der tar-Fallback prüft und setzt gar nichts fort.",
      ],
    },
    {
      heading: "Zwei Übertragungswege: SSH oder daemon-direct",
      body: [
        "Richte beide Befehle entweder auf ein SSH-Ziel (im scp-Stil, unter Verwendung deiner ~/.ssh/config) oder, falls die andere Maschine relayium serve ausführt, direkt über das daemon-direct-Protokoll — ganz ohne SSH.",
      ],
      code: [
        `# SSH-Ziel — nutzt deine vorhandenen SSH-Schlüssel und deine Konfiguration
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — auf dem Ziel läuft "relayium serve", kein SSH nötig
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon-direct-Verbindungen nutzen gepinntes TLS 1.3 mit Trust-on-first-use und werden danach bei jedem weiteren Lauf gegen genau diesen Fingerabdruck geprüft.",
        "sync akzeptiert dieselben zwei Zielformen wie push.",
      ],
    },
    {
      heading: "Per cron planen",
      prereqs: {
        label: "Was du vor Schritt 1 brauchst",
        items: [
          "Die CLI auf diesem Rechner — und auf dem Ziel ebenfalls, wenn du sync nutzen willst. sync hat keinen tar-Fallback.",
          "Einen SSH-Schlüssel ohne Passphrase, oder ein Ziel, auf dem relayium serve läuft. cron hat weder Agent noch Terminal und kann eine Passphrase-Abfrage nicht beantworten.",
          "Ein Quellverzeichnis, das in dem Moment existiert, in dem cron feuert — keins auf einem Netzlaufwerk, das nur eingehängt ist, solange du angemeldet bist.",
          "Einen Ort für ein Log. Ein Cron-Job, dessen Ausgabe ins Nichts geht, ist ein Backup, von dem du erst erfährst, wenn du es brauchst.",
        ],
      },
      steps: [
        {
          text: "Finde heraus, wo relayium wirklich liegt. cron nutzt nicht den PATH deiner Shell, und install.sh weicht auf ~/.local/bin aus, wenn /usr/local/bin nicht beschreibbar ist — genau die Stelle, die cron nie sieht.",
          code: ["command -v relayium"],
        },
        {
          text: "Prüfe, ob der Schlüssel auch ohne jemanden an der Tastatur funktioniert. BatchMode=yes scheitert, statt zu fragen — genau die Lage von cron.",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "Führ den ganzen Befehl einmal von Hand aus, exakt so geschrieben wie cron ihn ausführen wird, absoluter Pfad inklusive.",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "Erst danach den Zeitplan eintragen. Absoluten Pfad und Umleitung behalten.",
          code: ["crontab -e"],
        },
        {
          text: "Nach dem ersten geplanten Lauf das Log lesen statt zu vermuten. Genau dieser Schritt wird übersprungen, und genau er hätte es gesagt.",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "So sieht ein funktionierendes Setup aus",
        body: [
          "relayium löst sich zu einem absoluten Pfad auf, den du in die crontab kopieren kannst, und die ssh-Prüfung mit BatchMode endet mit 0, ohne etwas auszugeben oder zu fragen. Ein Backup, das nur aus deiner interaktiven Shell läuft, ist noch nicht geplant.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "push und sync sind beide einzelne, nicht-interaktive Befehle, die sich direkt in eine crontab einsetzen lassen. Verweise auf einen Schlüssel ohne Passphrase (oder einen Agent) und protokolliere die Ausgabe, damit Fehlschläge sichtbar werden:",
      ],
      code: [
        `# vollständige Kopie jede Nacht um 2 Uhr — in deine crontab eintragen (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# stattdessen alle 15 Minuten ein inkrementeller Spiegel
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "Der Befehl endet mit einem Exit-Code ungleich null, wenn eine Datei ihre Integritätsprüfung nicht besteht, sodass crons Mail-bei-Fehlschlag das Problem auffängt.",
        "Ein unterbrochenes sync holt beim nächsten geplanten Lauf auf: Was schon passt, wird übersprungen, und eine Teildatei wird weitergeführt. Ein unterbrochenes push setzt nicht fort — aber weil jede Nacht in ihr eigenes datiertes Verzeichnis schreibt, ist die nächste Nacht eine saubere vollständige Kopie statt einer Ablehnung.",
      ],
    },
    {
      heading: "Löschungen spiegeln und Echtzeit-Synchronisierung",
      body: [
        "Standardmäßig fügt sync am Ziel nur Dateien hinzu oder aktualisiert sie. Mit --delete wird daraus ein echter Spiegel, der auch Dateien entfernt, die es in der Quelle nicht mehr gibt — die Empfängerseite muss dafür ausdrücklich mit serve --allow-delete lauschen, sonst werden die Löschungen stillschweigend übersprungen und als abgelehnt zurückgemeldet. sync verweigert --delete außerdem grundsätzlich, wenn das Quellverzeichnis zu keiner einzigen Datei aufgelöst wird, sodass ein Tippfehler im Quellpfad das Ziel nicht leerräumen kann.",
        "Wer nicht auf den nächsten cron-Zeitpunkt warten will, kann mit --watch relayium sync dauerhaft laufen lassen: Es synchronisiert automatisch kurz nachdem sich eine Datei unter der Quelle ändert — eine leichtgewichtige Alternative zum zeitgesteuerten Polling.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete spiegelt auch Löschungen (Empfänger braucht serve --allow-delete).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch bleibt laufen und synchronisiert bei jeder Änderung, statt einmalig per cron.",
      ],
    },
    {
      heading: "Wenn es nicht funktioniert",
      body: [
        "Jeder dieser Fälle ist unsichtbar, bis du ins Log schaust — deshalb steht die Umleitung in der crontab-Zeile und ist nicht optional. Der fünfte ist schlimmer als unsichtbar: er sieht wie Erfolg aus.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Im Log steht relayium: command not found, derselbe Befehl läuft in deiner Shell aber.",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "cron läuft mit einem minimalen PATH, meist nur /usr/bin:/bin. Konnte install.sh nicht nach /usr/local/bin schreiben, liegt das Binary in ~/.local/bin, und dort sucht cron nie. Nimm den absoluten Pfad aus command -v in die crontab-Zeile, oder setz oben in der crontab eine PATH=-Zeile.",
          },
          {
            symptom: "Das Log zeigt eine abgewiesene ssh-Verbindung, oder nach dem ersten Lauf gar nichts mehr.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "cron hat keinen ssh-agent und kein Terminal, ein Schlüssel mit Passphrase kann also nur hängen oder scheitern. Zeig mit -i auf einen passphrasenlosen Schlüssel, der nur fürs Backup da ist, und prüfe mit BatchMode=yes — das verweigert die Abfrage, statt auf jemanden zu warten, der nicht da ist.",
          },
          {
            symptom: "sync läuft sauber, aber an der Quelle gelöschte Dateien liegen am Ziel noch.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "Löschen ist eine Opt-in-Entscheidung der Empfängerseite. Ohne serve --allow-delete drüben werden die Löschungen übersprungen und als denied zurückgemeldet — deshalb steht die Antwort im Log und nicht im Exit-Code. Starte den Listener der Gegenseite mit --allow-delete neu.",
          },
          {
            symptom: "sync verweigert --delete rundheraus.",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "Die Quelle löste sich zu null Dateien auf, der Spiegel hätte also das Ziel geleert. Diese Weigerung ist Absicht. Prüfe den Pfad auf einen Tippfehler — und prüfe, ob das, was dort eingehängt sein soll, auch zum Zeitpunkt des Cron-Laufs eingehängt ist und nicht nur, während du angemeldet bist.",
          },
          {
            symptom: "Das Backup läuft, endet mit 0, und ist nicht das, wofür du es hältst.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "Hat die Gegenstelle kein relayium, fällt push auf einen einfachen tar-Strom über SSH zurück. Die Dateien kommen an, also beschwert sich nichts — aber auf diesem Weg gibt es keine SHA-256-Prüfung pro Datei und keine Kollisionsprüfung vorab, und genau das sind die beiden Gründe, das hier statt scp einzuplanen. Installier die CLI auf dem Ziel, dann sind sie zurück. sync kennt diesen Fehler nicht: es hat gar keinen Fallback und scheitert stattdessen laut.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss auf dem Backup-Server relayium installiert sein?",
        a: "Das hängt vom Befehl ab. push funktioniert so oder so: Mit installiertem relayium nutzt es das native Protokoll (Kollisionsprüfung vorab + SHA-256 je Datei); ohne weicht push auf einen einfachen Tar-Stream über SSH aus, sodass auch ein nackter Server funktioniert. sync braucht auf der Gegenseite immer das native Protokoll von relayium — für sync gibt es keinen Tar-Fallback, installiere es also dort zuerst.",
      },
      {
        q: "Ist das Backup verschlüsselt und geprüft?",
        a: "Ja. Jede Datei wird Ende-zu-Ende mit einem SHA-256-Hash geprüft, und beim Push per SSH oder daemon-direct sind die Bytes bereits durch die Verschlüsselung dieser Verbindung geschützt — es ist nichts zusätzlich zu konfigurieren.",
      },
      {
        q: "Was passiert, wenn der cron-Job mittendrin unterbrochen wird?",
        a: "Das hängt davon ab, welchen Befehl du eingeplant hast. sync macht weiter: Der nächste Lauf überspringt, was schon passt, und führt eine Teildatei fort — und --no-resume schaltet genau das ab. push setzt in keinem der beiden Protokolle fort: Es verweigert ein Ziel, das schon existiert, und deshalb schreibt die push-Zeile oben in ein datiertes Verzeichnis, sodass die nächste Nacht eine saubere vollständige Kopie statt einer Ablehnung ist. --no-resume wird von push angenommen und tut nichts.",
      },
      {
        q: "Kann --delete versehentlich mein Ziel leeren?",
        a: "sync verweigert die Ausführung mit --delete, wenn das Quellverzeichnis keine Dateien enthält, und die Empfängerseite muss mit serve --allow-delete gestartet sein, damit Löschungen überhaupt wirksam werden — sonst werden sie übersprungen und dir gemeldet.",
      },
      {
        q: "Brauche ich ein Konto oder kostet das etwas?",
        a: "Nein. Die CLI ist kostenlos und braucht für push, pull oder sync kein Konto — die Übertragung läuft über deine eigene SSH-Verbindung oder eine direkte daemon-Verbindung, nicht über die Server von Relayium.",
      },
    ],
  },
  cta: {
    text: "Bring deine Backups auf einen Zeitplan, an den du nicht denken musst — auf dem Transportweg verschlüsselt, je Datei geprüft und kostenlos.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Automatiser les sauvegardes serveur chiffrées avec une tâche cron",
  description:
    "Planifiez relayium push ou sync via cron pour copier automatiquement un répertoire vers un autre serveur — chiffré en transit, vérifié par SHA-256 fichier par fichier, et gratuit.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Les sauvegardes qu'il faut penser à lancer soi-même finissent par ne pas être faites. cron, lui, s'en souvient, et la CLI Relayium est conçue pour cela : une seule commande non interactive qui copie (ou met en miroir) un répertoire vers une autre machine et vérifie chaque fichier qu'elle transfère.",
    "Ce guide couvre la planification de relayium push et du relayium sync incrémental via cron, les deux modes de transport que l'un comme l'autre peuvent utiliser, et des lignes de crontab prêtes à copier.",
  ],
  sections: [
    {
      heading: "push ou sync : copie complète ou miroir incrémental",
      body: [
        "push et sync déplacent tous deux un répertoire vers une autre machine, et tous deux peuvent être exécutés sans risque de façon répétée, mais ils résolvent des problèmes de sauvegarde légèrement différents.",
        "push envoie une copie via SSH ou daemon-direct à chaque exécution — simple, et cela fonctionne même vers un serveur nu sans relayium installé grâce à un repli tar. sync, lui, maintient la destination comme un miroir incrémental et unidirectionnel de la source : seuls les fichiers modifiés sont renvoyés, si bien qu'une synchronisation nocturne d'un grand répertoire est rapide après la première exécution. sync a toujours besoin du protocole natif de relayium des deux côtés — il n'a pas de repli tar.",
      ],
      bullets: [
        "Utilisez push pour une copie planifiée simple, surtout vers un serveur qui pourrait ne pas avoir relayium installé.",
        "Utilisez sync pour un répertoire volumineux ou qui change souvent, où tout renvoyer chaque nuit serait un gaspillage.",
        "Tous deux vérifient ce qu'ils transfèrent par un SHA-256 par fichier sur le protocole natif. Ni push ni pull ne reprend. Des trois, seul sync poursuit un fichier partiel, et le repli tar ne vérifie ni ne reprend rien.",
      ],
    },
    {
      heading: "Deux modes de transport : SSH ou daemon-direct",
      body: [
        "Pointez l'une ou l'autre commande vers une destination SSH (style scp, en utilisant votre ~/.ssh/config) ou, si l'autre machine exécute relayium serve, directement vers elle via le protocole daemon-direct — sans SSH.",
      ],
      code: [
        `# destination SSH — utilise vos clés et votre configuration SSH existantes
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — la destination exécute "relayium serve", aucun SSH requis
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "Les connexions daemon-direct utilisent du TLS 1.3 épinglé avec confiance à la première utilisation (trust-on-first-use), puis sont vérifiées contre cette même empreinte à chaque exécution suivante.",
        "sync accepte les deux mêmes formes de destination que push.",
      ],
    },
    {
      heading: "Le planifier avec cron",
      prereqs: {
        label: "Ce qu'il vous faut avant l'étape 1",
        items: [
          "La CLI sur cette machine, et sur la destination aussi si vous comptez utiliser sync. sync n'a aucun repli sur tar.",
          "Une clé SSH sans phrase de passe, ou une destination qui fait tourner relayium serve. cron n'a ni agent ni terminal : il ne peut pas répondre à une demande de phrase de passe.",
          "Un répertoire source qui existe au moment où cron se déclenche — pas un montage réseau présent seulement pendant que vous êtes connecté.",
          "Un endroit où écrire un journal. Une tâche cron dont la sortie ne va nulle part est une sauvegarde dont vous découvrirez l'état le jour où vous en aurez besoin.",
        ],
      },
      steps: [
        {
          text: "Trouvez où se trouve réellement relayium. cron n'utilise pas le PATH de votre shell, et install.sh se rabat sur ~/.local/bin quand /usr/local/bin n'est pas accessible en écriture — précisément l'endroit que cron ne voit jamais.",
          code: ["command -v relayium"],
        },
        {
          text: "Vérifiez que la clé fonctionne sans personne au clavier. BatchMode=yes échoue au lieu de demander, ce qui est exactement la situation de cron.",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "Exécutez la commande entière une fois à la main, écrite exactement comme cron l'exécutera, chemin absolu compris.",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "Ensuite seulement, ajoutez la planification. Gardez le chemin absolu et la redirection.",
          code: ["crontab -e"],
        },
        {
          text: "Après le premier passage planifié, lisez le journal au lieu de supposer. C'est l'étape que l'on saute, et c'est celle qui vous l'aurait dit.",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "À quoi ressemble une installation qui fonctionne",
        body: [
          "relayium se résout en un chemin absolu que vous pouvez coller dans la crontab, et la vérification ssh avec BatchMode se termine par 0 sans rien afficher ni rien demander. Une sauvegarde qui ne marche que depuis votre shell interactif n'est pas encore planifiée.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "push et sync sont tous deux des commandes uniques et non interactives, elles s'intègrent donc directement dans une crontab. Pointez-les vers une clé sans phrase de passe (ou vers un agent), et journalisez la sortie pour repérer les échecs :",
      ],
      code: [
        `# copie complète chaque nuit à 2 h — à ajouter à votre crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# à la place, un miroir incrémental toutes les 15 minutes
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "La commande se termine avec un code non nul si un fichier échoue à sa vérification d'intégrité, si bien que la notification par e-mail en cas d'échec de cron détecte les problèmes.",
        "Un sync interrompu rattrape son retard à la prochaine exécution planifiée : ce qui correspond déjà est sauté et un fichier partiel est poursuivi. Un push interrompu ne reprend pas — mais comme chaque nuit écrit dans son propre répertoire daté, la nuit suivante donne une copie complète et propre plutôt qu'un refus.",
      ],
    },
    {
      heading: "Mettre en miroir les suppressions et synchroniser en temps réel",
      body: [
        "Par défaut, sync ne fait qu'ajouter ou mettre à jour des fichiers du côté destination. Ajoutez --delete pour en faire un véritable miroir qui supprime aussi les fichiers que la source n'a plus — le côté récepteur doit explicitement écouter avec serve --allow-delete, sinon les suppressions sont silencieusement ignorées et signalées comme refusées. sync refuse aussi purement et simplement --delete si le répertoire source ne résout aucun fichier, si bien qu'une faute de frappe dans le chemin source ne peut pas vider la destination.",
        "Si vous préférez ne pas attendre le prochain passage de cron, --watch garde relayium sync en cours d'exécution et resynchronise automatiquement peu après qu'un fichier sous la source change — une solution légère, sans interrogation périodique.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete met en miroir les suppressions (le récepteur a besoin de serve --allow-delete).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch reste en cours d'exécution et resynchronise à chaque changement, au lieu d'une exécution unique via cron.",
      ],
    },
    {
      heading: "Quand ça ne marche pas",
      body: [
        "Chacun de ces cas est invisible tant que vous ne regardez pas le journal — c'est pourquoi la redirection figure dans la ligne de crontab et n'est pas facultative. Le cinquième est pire qu'invisible : il ressemble à une réussite.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Le journal indique relayium: command not found, alors que la même commande marche dans votre shell.",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "cron tourne avec un PATH minimal, en général seulement /usr/bin:/bin. Si install.sh n'a pas pu écrire dans /usr/local/bin, le binaire est dans ~/.local/bin, que cron ne cherchera jamais. Mettez le chemin absolu donné par command -v dans la ligne de crontab, ou ajoutez une ligne PATH= en tête de crontab.",
          },
          {
            symptom: "Le journal montre une connexion ssh refusée, ou plus rien après la première exécution.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "cron n'a ni ssh-agent ni terminal, une clé protégée par phrase de passe ne peut donc que bloquer ou échouer. Pointez -i sur une clé sans phrase de passe réservée aux sauvegardes, et vérifiez avec BatchMode=yes, qui refuse de demander plutôt que d'attendre quelqu'un qui n'est pas là.",
          },
          {
            symptom: "sync s'exécute proprement, mais les fichiers supprimés à la source sont toujours sur la destination.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "La suppression se décide côté récepteur. Sans serve --allow-delete en face, les suppressions sont ignorées et renvoyées comme refusées — voilà pourquoi la réponse est dans le journal et pas dans le code de sortie. Relancez l'écouteur d'en face avec --allow-delete.",
          },
          {
            symptom: "sync refuse purement et simplement --delete.",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "La source n'a résolu aucun fichier, le miroir aurait donc vidé la destination. Ce refus est délibéré. Vérifiez le chemin, et vérifiez que ce qui doit y être monté l'est bien à l'heure où cron se déclenche et pas seulement quand vous êtes connecté.",
          },
          {
            symptom: "La sauvegarde tourne, se termine par 0, et n'est pas ce que vous croyez.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "Quand la machine distante n'a pas relayium, push se rabat sur un simple flux tar via SSH. Les fichiers arrivent, donc rien ne se plaint — mais ce chemin n'a ni vérification SHA-256 fichier par fichier ni contrôle de collision en amont, c'est-à-dire précisément les deux raisons de planifier ceci plutôt qu'un scp. Installez la CLI sur la destination pour les retrouver. sync n'a pas ce défaut : n'ayant aucun repli, il échoue bruyamment à la place.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Le serveur de sauvegarde a-t-il besoin de relayium installé ?",
        a: "Cela dépend de la commande. push fonctionne dans les deux cas : avec relayium installé, il utilise le protocole natif (contrôle de collision en amont + vérification SHA-256 par fichier) ; sans, push bascule sur un simple flux tar via SSH, si bien qu'un serveur nu fonctionne quand même. sync a toujours besoin du protocole natif de relayium côté distant — il n'y a pas de repli tar pour sync, installez-le donc là-bas au préalable.",
      },
      {
        q: "La sauvegarde est-elle chiffrée et vérifiée ?",
        a: "Oui. Chaque fichier est vérifié de bout en bout par un hachage SHA-256, et en poussant via SSH ou daemon-direct, les octets sont déjà protégés par le chiffrement propre à cette connexion — rien à configurer en plus.",
      },
      {
        q: "Que se passe-t-il si la tâche cron est interrompue en cours de route ?",
        a: "Cela dépend de la commande que vous avez planifiée. sync continue : l'exécution suivante saute ce qui correspond déjà et poursuit un fichier partiel, et --no-resume désactive cela. push ne reprend dans aucun des deux protocoles — il refuse une destination qui existe déjà, ce qui est la raison pour laquelle la ligne push ci-dessus écrit dans un répertoire daté, de sorte que la nuit suivante donne une copie complète et propre plutôt qu'un refus. --no-resume est accepté par push et n'y fait rien.",
      },
      {
        q: "--delete peut-il vider ma destination par accident ?",
        a: "sync refuse de s'exécuter avec --delete si le répertoire source ne contient aucun fichier, et le récepteur doit être démarré avec serve --allow-delete pour que les suppressions prennent effet — sinon elles sont ignorées et vous sont signalées.",
      },
      {
        q: "Ai-je besoin d'un compte, est-ce payant ?",
        a: "Non. La CLI est gratuite et ne nécessite aucun compte pour push, pull ou sync — le transfert passe par votre propre connexion SSH ou une connexion daemon directe, pas par les serveurs de Relayium.",
      },
    ],
  },
  cta: {
    text: "Confiez vos sauvegardes à une planification dont vous n'avez pas à vous souvenir — chiffré en transit, vérifié fichier par fichier et gratuit.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "أتمتة النسخ الاحتياطي المُشفَّر للخادم باستخدام مهمة cron",
  description:
    "جدوِل relayium push أو sync عبر cron لنسخ مجلد إلى خادم آخر تلقائيًا — مُشفَّر أثناء النقل، مُتحقَّق منه بـ SHA-256 لكل ملف، ومجاني لتشغيله بأي وتيرة تشاء.",
  updatedLabel: "آخر تحديث",
  lead: [
    "النسخ الاحتياطي الذي عليك أن تتذكر تشغيله لا يحدث. أما cron فيتذكر، وواجهة Relayium CLI مبنية لذلك: أمر واحد غير تفاعلي ينسخ (أو يعكس) مجلدًا إلى جهاز آخر ويتحقق من كل ملف يَنقله.",
    "يغطي هذا الدليل جدولة relayium push وrelayium sync التزايدي عبر cron، ووسيلتَي النقل اللتين يمكن توجيه أيٍّ منهما إليهما، وأسطر crontab الجاهزة للنسخ.",
  ],
  sections: [
    {
      heading: "push مقابل sync: نسخة كاملة أم مرآة تزايدية",
      body: [
        "كلٌّ من push وsync ينقل مجلدًا إلى جهاز آخر، وكلاهما آمن للتشغيل المتكرر، لكنهما يحلّان مشكلتَي نسخ احتياطي مختلفتَين قليلًا.",
        "يرسل push نسخة عبر SSH أو daemon-direct في كل مرة تُشغّله — بسيط، بل ويعمل حتى مع خادم مجرّد لا يوجد عليه relayium عبر بديل tar. أما sync فيُبقي الوجهة كمرآة تزايدية أحادية الاتجاه للمصدر: تُعاد فقط الملفات المتغيرة، فتصبح مزامنة ليلية لمجلد كبير سريعة بعد التشغيل الأول. يحتاج sync دائمًا إلى بروتوكول relayium الأصلي على الطرفين — ولا يوجد لديه بديل tar.",
      ],
      bullets: [
        "استخدم push لنسخة مجدولة مباشرة، خاصةً إلى خادم قد لا يكون relayium مثبتًا عليه.",
        "استخدم sync لمجلد كبير أو كثير التغير حيث تكون إعادة إرسال كل شيء كل ليلة إهدارًا.",
        "كلاهما يتحقق مما يَنقله بـ SHA-256 لكل ملف على البروتوكول الأصلي. ولا يستأنف push ولا pull؛ ومن الثلاثة، sync وحده يُكمل ملفًا جزئيًا، أما تراجع tar فلا يتحقق ولا يستأنف شيئًا.",
      ],
    },
    {
      heading: "وسيلتا نقل: SSH أو daemon-direct",
      body: [
        "وجِّه أيًّا من الأمرين إلى وجهة SSH (بأسلوب scp، باستخدام ~/.ssh/config لديك)، أو إذا كان الجهاز الآخر يشغّل relayium serve، فمباشرةً إليه عبر بروتوكول daemon-direct — دون حاجة إلى SSH.",
      ],
      code: [
        `# وجهة SSH — تستخدم مفاتيح SSH وإعداداتك الحالية
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — الوجهة تشغّل "relayium serve"، ولا حاجة إلى SSH
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "اتصالات daemon-direct مثبَّتة على TLS 1.3 مع الثقة عند الاستخدام الأول، ثم تُثبَّت على تلك البصمة في كل تشغيل لاحق.",
        "يقبل sync الشكلين نفسيهما للوجهة كما يقبلهما push.",
      ],
    },
    {
      heading: "جدولته باستخدام cron",
      prereqs: {
        label: "ما تحتاجه قبل الخطوة 1",
        items: [
          "الـ CLI على هذا الجهاز، وعلى الوجهة أيضًا إن كنت تنوي استخدام sync. فـ sync بلا بديل احتياطي عبر tar.",
          "مفتاح SSH بلا عبارة مرور، أو وجهة تشغّل relayium serve. فـ cron بلا وكيل وبلا طرفية، ولا يستطيع الإجابة عن طلب عبارة المرور.",
          "دليل مصدر موجود فعلًا في اللحظة التي ينطلق فيها cron — لا دليل على مشاركة شبكية لا تُركَّب إلا وأنت مسجَّل الدخول.",
          "مكان تكتب فيه سجلًا. فمهمة cron التي تذهب مخرجاتها إلى العدم هي نسخة احتياطية لن تعرف حالها إلا يوم تحتاجها.",
        ],
      },
      steps: [
        {
          text: "اعرف أين يوجد relayium فعلًا. فـ cron لا يستخدم PATH الخاص بصدفتك، وinstall.sh يتراجع إلى ‎~/.local/bin‎ حين يتعذّر الكتابة في ‎/usr/local/bin‎ — وهو بالضبط الموضع الذي لا يراه cron أبدًا.",
          code: ["command -v relayium"],
        },
        {
          text: "تأكّد أن المفتاح يعمل ولا أحد أمام لوحة المفاتيح. فـ BatchMode=yes يفشل بدل أن يسأل، وهذا هو حال cron تمامًا.",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "شغّل الأمر كاملًا يدويًا مرة واحدة، مكتوبًا تمامًا كما سيشغّله cron، بما في ذلك المسار المطلق.",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "عندها فقط أضف الجدولة. أبقِ المسار المطلق وإعادة التوجيه كما هما.",
          code: ["crontab -e"],
        },
        {
          text: "بعد أول تشغيل مجدول، اقرأ السجل بدل أن تفترض. هذه هي الخطوة التي يتخطّاها الناس، وهي نفسها التي كانت ستخبرهم.",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "كيف يبدو إعداد يعمل بشكل صحيح",
        body: [
          "يُحَل relayium إلى مسار مطلق يمكنك لصقه في crontab، وينتهي فحص ssh مع BatchMode بالرمز 0 دون أن يطبع شيئًا أو يطلب شيئًا. والنسخة الاحتياطية التي لا تعمل إلا من صدفتك التفاعلية ليست مجدولة بعد.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "كلٌّ من push وsync أمر واحد غير تفاعلي، فيندرج مباشرةً في crontab. وجِّهه إلى مفتاح SSH بلا عبارة مرور (أو إلى وكيل)، وسجِّل المُخرجات لتظهر حالات الفشل:",
      ],
      code: [
        `# نسخة كاملة كل ليلة عند الساعة 2 — أضِفها إلى crontab لديك (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# مرآة تزايدية كل 15 دقيقة بدلًا من ذلك
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "يخرج الأمر بحالة غير صفرية إذا فشل أي ملف في فحص سلامته، فتلتقط رسالة cron عند الفشل المشكلات.",
        "‏sync المُقاطَع يلحق بالركب في التشغيل المُجدوَل التالي: يُتخطّى ما يطابق سلفًا ويُكمَل الملف الجزئي. أما push المُقاطَع فلا يستأنف — لكن لأن كل ليلة تكتب في مجلدها المؤرَّخ الخاص، فإن الليلة التالية تعطي نسخة كاملة نظيفة بدل الرفض.",
      ],
    },
    {
      heading: "عكس عمليات الحذف والمزامنة الفورية",
      body: [
        "افتراضيًا، لا يفعل sync سوى إضافة الملفات أو تحديثها في الوجهة. أضف --delete لجعله مرآة حقيقية تزيل أيضًا الملفات التي لم تعد موجودة في المصدر — يجب أن يكون الطرف المستقبِل مُنصِتًا صراحةً بـ serve --allow-delete، وإلا تُتجاهَل عمليات الحذف بصمت ويُبلَّغ عنها بأنها مرفوضة. كما يرفض sync استخدام --delete تمامًا إذا لم يُحلَّل مجلد المصدر إلى أي ملف، فلا يمكن لخطأ مطبعي في مسار المصدر أن يمحو الوجهة.",
        "إذا كنت تفضّل ألا تنتظر الدورة التالية لـ cron، يُبقي --watch عمل relayium sync مستمرًا ويعيد المزامنة تلقائيًا بعد لحظة من تغيّر أي ملف تحت المصدر — بديل خفيف عن الاستطلاع وفق جدول زمني.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete يعكس عمليات الحذف (يحتاج المستقبِل إلى serve --allow-delete).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch يبقى مستمرًا ويعيد المزامنة عند التغيّر بدلًا من التشغيل مرة واحدة من cron.",
      ],
    },
    {
      heading: "حين لا ينجح الأمر",
      body: [
        "كل حالة من هذه غير مرئية حتى تنظر في السجل — ولهذا كُتبت إعادة التوجيه ضمن سطر crontab لا كخيار إضافي. والحالة الخامسة أسوأ من كونها غير مرئية: فهي تبدو كالنجاح.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "يقول السجل relayium: command not found بينما الأمر نفسه يعمل في صدفتك.",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "يعمل cron بمسار PATH أدنى، غالبًا ‎/usr/bin:/bin‎ فقط. وإن لم يتمكّن install.sh من الكتابة في ‎/usr/local/bin‎ فقد وضع الثنائي في ‎~/.local/bin‎، وهو موضع لن يبحث فيه cron قط. ضع المسار المطلق الذي يعطيه command -v في سطر crontab، أو أضف سطر ‎PATH=‎ في أعلى crontab.",
          },
          {
            symptom: "يُظهر السجل رفض اتصال ssh، أو لا شيء بعد التشغيل الأول.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "لا يملك cron وكيل ssh ولا طرفية، فالمفتاح المحمي بعبارة مرور لا يسعه إلا أن يتعلّق أو يفشل. وجّه ‎-i‎ إلى مفتاح بلا عبارة مرور مخصَّص للنسخ الاحتياطي، وتحقّق بـ BatchMode=yes الذي يرفض السؤال بدل انتظار شخص غير موجود.",
          },
          {
            symptom: "يعمل sync بنظافة، لكن الملفات المحذوفة من المصدر ما تزال في الوجهة.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "الحذف اختيار يفعّله الطرف المستقبِل. وبلا serve --allow-delete في الجهة المقابلة تُتخطّى عمليات الحذف ويُبلَّغ عنها بأنها مرفوضة، ولهذا يوجد الجواب في السجل لا في رمز الخروج. أعد تشغيل مُنصِت الطرف المقابل مع ‎--allow-delete‎.",
          },
          {
            symptom: "يرفض sync الخيار ‎--delete‎ رفضًا قاطعًا.",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "لم يُحلّ المصدر إلى أي ملف، فكانت المرآة ستفرغ الوجهة. وهذا الرفض مقصود. تحقّق من المسار بحثًا عن خطأ مطبعي، وتحقّق أن ما يُفترض تركيبه هناك مُركَّب فعلًا وقت انطلاق cron لا حين تكون مسجَّل الدخول فقط.",
          },
          {
            symptom: "تعمل النسخة الاحتياطية وتنتهي بالرمز 0، لكنها ليست ما تظنه.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "حين لا يملك الجهاز البعيد relayium يتراجع push إلى تدفّق tar عادي عبر SSH. تصل الملفات فلا يشتكي شيء — لكن هذا المسار بلا تحقّق SHA-256 لكل ملف وبلا فحص تعارض مسبق، وهما بالضبط السببان اللذان من أجلهما تجدول هذا بدل scp. ثبّت الـ CLI على الوجهة لتستعيدهما. أما sync فلا يعرف هذا الإخفاق: إذ لا بديل احتياطي لديه أصلًا، فيفشل بصوت عالٍ بدلًا من ذلك.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يحتاج خادم النسخ الاحتياطي إلى تثبيت relayium؟",
        a: "يعتمد على الأمر. يعمل push في كلتا الحالتين: مع تثبيت relayium يستخدم البروتوكول الأصلي (فحص التعارض المسبق + SHA-256 لكل ملف)؛ ومن دونه، يتراجع push إلى تدفق tar عادي عبر SSH، فيعمل حتى الخادم المجرّد. أما sync فيحتاج دائمًا إلى بروتوكول relayium الأصلي على الطرف البعيد — لا يوجد بديل tar لـ sync، فثبِّته هناك أولًا.",
      },
      {
        q: "هل النسخة الاحتياطية مُشفَّرة ومُتحقَّق منها؟",
        a: "نعم. يُفحَص كل ملف بتجزئة SHA-256 من الطرف إلى الطرف، والدفع عبر SSH أو daemon-direct يعني أن البايتات محمية أصلًا بتشفير ذلك الاتصال — لا شيء إضافي لضبطه.",
      },
      {
        q: "ماذا يحدث إذا قوطعت مهمة cron في منتصفها؟",
        a: "يعتمد على الأمر الذي جدولته. sync يُكمل: التشغيل التالي يتخطى ما يطابق سلفًا ويُكمل ملفًا جزئيًا، و‏--no-resume يوقف ذلك. أما push فلا يستأنف في أي من البروتوكولين — فهو يرفض وجهة موجودة سلفًا، ولهذا يكتب سطر push أعلاه في مجلد مؤرَّخ، كي تكون الليلة التالية نسخة كاملة نظيفة بدل الرفض. و‏--no-resume مقبول في push ولا يفعل شيئًا.",
      },
      {
        q: "هل يمكن أن يمحو --delete وجهتي بالخطأ؟",
        a: "يرفض sync التشغيل مع --delete إذا لم يحتوِ مجلد المصدر على أي ملف، ويجب تشغيل المستقبِل بـ serve --allow-delete حتى تسري عمليات الحذف أصلًا — وإلا تُتجاهَل ويُبلَّغ عنها إليك.",
      },
      {
        q: "هل أحتاج إلى حساب، وهل يكلّف هذا شيئًا؟",
        a: "لا. واجهة CLI مجانية ولا تحتاج إلى حساب لـ push أو pull أو sync — يجري النقل عبر اتصال SSH لديك أو اتصال daemon مباشر، لا عبر خوادم Relayium.",
      },
    ],
  },
  cta: {
    text: "ضع نسخك الاحتياطية على جدول لا يتوجب عليك تذكّره — مُشفَّرة أثناء النقل، مُتحقَّق منها لكل ملف، ومجانية.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Automatiza copias de seguridad cifradas del servidor con una tarea cron",
  description:
    "Programa relayium push o sync desde cron para copiar automáticamente un directorio a otro servidor: cifrado en tránsito, verificado con SHA-256 por archivo y gratis para ejecutarlo con la frecuencia que quieras.",
  updatedLabel: "Última actualización",
  lead: [
    "Las copias de seguridad que tienes que acordarte de ejecutar no ocurren. cron sí se acuerda, y la CLI de Relayium está hecha para eso: un único comando no interactivo que copia (o replica) un directorio a otra máquina y verifica cada archivo que transfiere.",
    "Esta guía cubre cómo programar relayium push y el relayium sync incremental desde cron, los dos transportes a los que puedes apuntar cualquiera de ellos, y las líneas de crontab para copiar.",
  ],
  sections: [
    {
      heading: "push frente a sync: copia completa o réplica incremental",
      body: [
        "Tanto push como sync mueven un directorio a otra máquina y ambos son seguros de ejecutar repetidamente, pero resuelven problemas de copia de seguridad ligeramente distintos.",
        "push envía una copia por SSH o daemon-direct cada vez que lo ejecutas: sencillo, e incluso funciona contra un servidor pelado sin relayium instalado gracias a un respaldo con tar. sync, en cambio, mantiene el destino como una réplica incremental unidireccional del origen: solo se reenvían los archivos cambiados, así que un sync nocturno de un directorio grande es rápido después de la primera ejecución. sync siempre necesita el protocolo nativo de relayium en ambos extremos: no tiene respaldo con tar.",
      ],
      bullets: [
        "Usa push para una copia programada sencilla, sobre todo hacia un servidor que quizá no tenga relayium instalado.",
        "Usa sync para un directorio grande o que cambia con frecuencia, donde reenviar todo cada noche sería un desperdicio.",
        "Ambos verifican lo que transfieren con un SHA-256 por archivo en el protocolo nativo. Ni push ni pull reanuda; de los tres, solo sync continúa un archivo parcial, y la alternativa con tar no verifica ni reanuda nada.",
      ],
    },
    {
      heading: "Dos transportes: SSH o daemon-direct",
      body: [
        "Apunta cualquiera de los comandos a un destino SSH (al estilo scp, usando tu ~/.ssh/config) o, si la otra máquina ejecuta relayium serve, directamente a ella por el protocolo daemon-direct, sin necesidad de SSH.",
      ],
      code: [
        `# destino SSH — usa tus claves y tu configuración de SSH existentes
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — el destino ejecuta "relayium serve", no hace falta SSH
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "Las conexiones daemon-direct usan TLS 1.3 fijado con confianza en el primer uso, y luego se comprueban contra esa misma huella en cada ejecución posterior.",
        "sync acepta las mismas dos formas de destino que push.",
      ],
    },
    {
      heading: "Prográmalo con cron",
      prereqs: {
        label: "Lo que necesitas antes del paso 1",
        items: [
          "La CLI en esta máquina, y también en el destino si piensas usar sync. sync no tiene repliegue a tar.",
          "Una clave SSH sin frase de paso, o un destino que ejecute relayium serve. cron no tiene agente ni terminal, así que no puede responder a una petición de frase de paso.",
          "Un directorio de origen que exista en el momento en que cron se dispara, no uno en un montaje de red que solo está presente mientras tienes la sesión abierta.",
          "Un sitio donde escribir un registro. Una tarea de cron cuya salida no va a ninguna parte es una copia de seguridad de la que te enterarás el día que la necesites.",
        ],
      },
      steps: [
        {
          text: "Averigua dónde está realmente relayium. cron no usa el PATH de tu shell, e install.sh se repliega a ~/.local/bin cuando no puede escribir en /usr/local/bin, que es justo el sitio que cron nunca ve.",
          code: ["command -v relayium"],
        },
        {
          text: "Comprueba que la clave funciona sin nadie al teclado. BatchMode=yes falla en lugar de preguntar, que es exactamente la situación de cron.",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "Ejecuta la orden entera a mano una vez, escrita exactamente como la ejecutará cron, ruta absoluta incluida.",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "Solo entonces añade la programación. Conserva la ruta absoluta y la redirección.",
          code: ["crontab -e"],
        },
        {
          text: "Tras la primera ejecución programada, lee el registro en vez de suponer. Es el paso que la gente se salta, y es el que se lo habría dicho.",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "Qué aspecto tiene un montaje que funciona",
        body: [
          "relayium se resuelve a una ruta absoluta que puedes pegar en el crontab, y la comprobación de ssh con BatchMode termina con 0 sin imprimir ni pedir nada. Una copia de seguridad que solo funciona desde tu shell interactiva todavía no está programada.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "Tanto push como sync son comandos únicos y no interactivos, así que se integran directamente en un crontab. Apúntalos a una clave SSH sin frase de contraseña (o a un agente) y registra la salida para que los fallos sean visibles:",
      ],
      code: [
        `# copia completa cada noche a las 2 — añádela a tu crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# en su lugar, réplica incremental cada 15 minutos
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "El comando termina con un código distinto de cero si algún archivo falla su comprobación de integridad, así que el aviso por correo de cron ante fallos detecta los problemas.",
        "Un sync interrumpido se pone al día en la siguiente ejecución programada: lo que ya coincide se salta y un archivo parcial se continúa. Un push interrumpido no reanuda, pero como cada noche escribe en su propio directorio con fecha, la noche siguiente es una copia completa y limpia en lugar de un rechazo.",
      ],
    },
    {
      heading: "Replicar borrados y sincronización en tiempo real",
      body: [
        "De forma predeterminada, sync solo añade o actualiza archivos en el destino. Añade --delete para convertirlo en una réplica de verdad que también elimina los archivos que el origen ya no tiene: el lado receptor debe estar escuchando explícitamente con serve --allow-delete, o los borrados se omiten en silencio y se informan de vuelta como denegados. sync además rechaza --delete de plano si el directorio de origen no se resuelve en ningún archivo, de modo que un error de tecleo en la ruta de origen no puede vaciar el destino.",
        "Si prefieres no esperar al siguiente tic de cron, --watch mantiene relayium sync en ejecución y vuelve a sincronizar automáticamente un instante después de que cambie cualquier archivo bajo el origen: una alternativa ligera al sondeo programado.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete replica los borrados (el receptor necesita serve --allow-delete).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch se mantiene en ejecución y vuelve a sincronizar al cambiar algo, en lugar de ejecutarse una sola vez desde cron.",
      ],
    },
    {
      heading: "Cuando no funciona",
      body: [
        "Todos estos casos son invisibles hasta que miras el registro: por eso la redirección va en la línea del crontab y no es opcional. El quinto es peor que invisible, porque parece un éxito.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El registro dice relayium: command not found, pero la misma orden funciona en tu shell.",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "cron corre con un PATH mínimo, normalmente solo /usr/bin:/bin. Si install.sh no pudo escribir en /usr/local/bin, el binario está en ~/.local/bin, donde cron no mirará jamás. Pon en la línea del crontab la ruta absoluta que da command -v, o añade una línea PATH= al principio del crontab.",
          },
          {
            symptom: "El registro muestra la conexión ssh rechazada, o nada después de la primera ejecución.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "cron no tiene ssh-agent ni terminal, así que una clave con frase de paso solo puede colgarse o fallar. Apunta -i a una clave sin frase de paso reservada para las copias, y compruébalo con BatchMode=yes, que se niega a preguntar en lugar de esperar a alguien que no está.",
          },
          {
            symptom: "sync se ejecuta limpiamente, pero los archivos borrados en el origen siguen en el destino.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "El borrado se activa en el lado receptor. Sin serve --allow-delete enfrente, los borrados se omiten y se informan como denegados, y por eso la respuesta está en el registro y no en el código de salida. Reinicia el receptor del otro lado con --allow-delete.",
          },
          {
            symptom: "sync rechaza --delete de plano.",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "El origen no resolvió ningún archivo, así que el espejo habría vaciado el destino. Ese rechazo es deliberado. Revisa la ruta por si hay una errata, y comprueba que lo que deba estar montado ahí lo esté a la hora en que se dispara cron y no solo cuando tienes sesión abierta.",
          },
          {
            symptom: "La copia se ejecuta, termina con 0, y no es lo que crees.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "Cuando la máquina remota no tiene relayium, push se repliega a un flujo tar simple sobre SSH. Los archivos llegan, así que nada se queja, pero ese camino no tiene verificación SHA-256 por archivo ni comprobación de colisiones por adelantado, que son justo las dos razones para programar esto en lugar de un scp. Instala la CLI en el destino para recuperarlas. sync no tiene este fallo: como no tiene ningún repliegue, falla ruidosamente.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿El servidor de copias de seguridad necesita relayium instalado?",
        a: "Depende del comando. push funciona de cualquier forma: con relayium instalado usa el protocolo nativo (comprobación de colisiones por adelantado + SHA-256 por archivo); sin él, push recurre a un simple flujo tar por SSH, así que un servidor pelado sigue funcionando. sync siempre necesita el protocolo nativo de relayium en el extremo remoto: no hay respaldo con tar para sync, así que instálalo allí primero.",
      },
      {
        q: "¿La copia de seguridad va cifrada y verificada?",
        a: "Sí. Cada archivo se comprueba con un hash SHA-256 de extremo a extremo, y al enviar por SSH o daemon-direct los bytes ya están protegidos por el cifrado de esa conexión: nada más que configurar.",
      },
      {
        q: "¿Qué pasa si la tarea cron se interrumpe a mitad de camino?",
        a: "Depende de qué comando hayas programado. sync continúa: la siguiente ejecución se salta lo que ya coincide y sigue con un archivo parcial, y --no-resume desactiva eso. push no reanuda en ninguno de los dos protocolos: rechaza un destino que ya existe, que es la razón por la que la línea push de arriba escribe en un directorio con fecha, de modo que la noche siguiente es una copia completa y limpia en lugar de un rechazo. --no-resume se acepta en push y no hace nada.",
      },
      {
        q: "¿Puede --delete vaciar mi destino por accidente?",
        a: "sync se niega a ejecutarse con --delete si el directorio de origen no contiene ningún archivo, y el receptor tiene que iniciarse con serve --allow-delete para que los borrados surtan efecto siquiera; de lo contrario se omiten y se te informa de ello.",
      },
      {
        q: "¿Necesito una cuenta o esto cuesta algo?",
        a: "No. La CLI es gratis y no necesita cuenta para push, pull ni sync: la transferencia va por tu propia conexión SSH o una conexión de daemon directo, no a través de los servidores de Relayium.",
      },
    ],
  },
  cta: {
    text: "Pon tus copias de seguridad en un calendario que no tienes que recordar: cifradas en tránsito, verificadas por archivo y gratis.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Automatize backups criptografados do servidor com uma tarefa cron",
  description:
    "Agende relayium push ou sync pelo cron para copiar um diretório para outro servidor automaticamente — criptografado em trânsito, verificado com SHA-256 por arquivo e gratuito para rodar com a frequência que quiser.",
  updatedLabel: "Última atualização",
  lead: [
    "Backups que você precisa lembrar de executar não acontecem. O cron lembra, e a CLI do Relayium foi feita para isso: um único comando não interativo que copia (ou espelha) um diretório para outra máquina e verifica cada arquivo que transfere.",
    "Este guia aborda como agendar o relayium push e o relayium sync incremental pelo cron, os dois transportes para os quais você pode apontar qualquer um deles e as linhas de crontab para copiar.",
  ],
  sections: [
    {
      heading: "push versus sync: cópia completa ou espelho incremental",
      body: [
        "Tanto push quanto sync movem um diretório para outra máquina e ambos são seguros para rodar repetidamente, mas resolvem problemas de backup um pouco diferentes.",
        "push envia uma cópia por SSH ou daemon-direct a cada execução — simples, e funciona até contra um servidor pelado sem o relayium instalado, graças a um recurso alternativo com tar. Já o sync mantém o destino como um espelho incremental e unidirecional da origem: apenas os arquivos alterados são reenviados, então um sync noturno de um diretório grande fica rápido depois da primeira execução. O sync sempre precisa do protocolo nativo do relayium nas duas pontas — ele não tem recurso alternativo com tar.",
      ],
      bullets: [
        "Use push para uma cópia agendada direta, especialmente para um servidor que talvez não tenha o relayium instalado.",
        "Use sync para um diretório grande ou que muda com frequência, onde reenviar tudo toda noite seria desperdício.",
        "Ambos verificam o que transferem com um SHA-256 por arquivo no protocolo nativo. Nem o push nem o pull retoma; dos três, só o sync continua um arquivo parcial, e a alternativa com tar não verifica nem retoma nada.",
      ],
    },
    {
      heading: "Dois transportes: SSH ou daemon-direct",
      body: [
        "Aponte qualquer um dos comandos para um destino SSH (no estilo scp, usando seu ~/.ssh/config) ou, se a outra máquina estiver rodando relayium serve, direto para ela pelo protocolo daemon-direct — sem precisar de SSH.",
      ],
      code: [
        `# destino SSH — usa suas chaves e sua configuração de SSH existentes
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — o destino roda "relayium serve", sem precisar de SSH
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "As conexões daemon-direct usam TLS 1.3 fixado com confiança no primeiro uso e, depois, são verificadas contra essa mesma impressão digital em todas as execuções seguintes.",
        "O sync aceita as mesmas duas formas de destino que o push.",
      ],
    },
    {
      heading: "Agende com o cron",
      prereqs: {
        label: "O que você precisa antes do passo 1",
        items: [
          "A CLI nesta máquina, e também no destino se pretende usar o sync. O sync não tem recurso ao tar.",
          "Uma chave SSH sem frase secreta, ou um destino rodando relayium serve. O cron não tem agente nem terminal, então não consegue responder a um pedido de frase secreta.",
          "Um diretório de origem que exista no momento em que o cron dispara — não um em montagem de rede que só está presente enquanto você está logado.",
          "Um lugar para escrever um log. Uma tarefa de cron cuja saída não vai a lugar nenhum é um backup do qual você vai saber no dia em que precisar dele.",
        ],
      },
      steps: [
        {
          text: "Descubra onde o relayium realmente está. O cron não usa o PATH do seu shell, e o install.sh recorre a ~/.local/bin quando não consegue escrever em /usr/local/bin — exatamente o lugar que o cron nunca enxerga.",
          code: ["command -v relayium"],
        },
        {
          text: "Confirme que a chave funciona sem ninguém ao teclado. BatchMode=yes falha em vez de perguntar, que é justamente a situação do cron.",
          code: ["ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true"],
        },
        {
          text: "Rode o comando inteiro à mão uma vez, escrito exatamente como o cron vai rodar, caminho absoluto incluído.",
          code: ["/usr/local/bin/relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/"],
        },
        {
          text: "Só então adicione o agendamento. Mantenha o caminho absoluto e o redirecionamento.",
          code: ["crontab -e"],
        },
        {
          text: "Depois da primeira execução agendada, leia o log em vez de supor. É o passo que as pessoas pulam, e é o que teria contado.",
          code: ["tail -n 20 ~/relayium-backup.log"],
        },
      ],
      success: {
        label: "Como é uma configuração que funciona",
        body: [
          "O relayium resolve para um caminho absoluto que dá para colar no crontab, e a checagem de ssh com BatchMode termina em 0 sem imprimir nem pedir nada. Um backup que só funciona a partir do seu shell interativo ainda não está agendado.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
$ echo $?
0`,
        ],
      },
      body: [
        "Tanto push quanto sync são comandos únicos e não interativos, então se encaixam direto em um crontab. Aponte-os para uma chave SSH sem senha (ou um agente) e registre a saída para que as falhas fiquem visíveis:",
      ],
      code: [
        `# cópia completa toda noite às 2h — adicione ao seu crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/$(date +\\%F)/ >> ~/relayium-backup.log 2>&1

# no lugar disso, espelho incremental a cada 15 minutos
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "O comando termina com código diferente de zero se algum arquivo falhar na verificação de integridade, então o aviso por e-mail em caso de falha do cron detecta os problemas.",
        "Um sync interrompido se atualiza na próxima execução agendada: o que já corresponde é pulado e um arquivo parcial é continuado. Um push interrompido não retoma — mas, como cada noite escreve no seu próprio diretório com data, a noite seguinte é uma cópia completa e limpa em vez de uma recusa.",
      ],
    },
    {
      heading: "Espelhar exclusões e sincronização em tempo real",
      body: [
        "Por padrão, o sync apenas adiciona ou atualiza arquivos no destino. Adicione --delete para torná-lo um espelho de verdade, que também remove os arquivos que a origem não tem mais — o lado receptor precisa estar escutando explicitamente com serve --allow-delete, ou as exclusões são silenciosamente ignoradas e reportadas de volta como negadas. O sync também recusa --delete de imediato se o diretório de origem não resolver em nenhum arquivo, de modo que um erro de digitação no caminho de origem não pode apagar o destino.",
        "Se você preferir não esperar o próximo ciclo do cron, --watch mantém o relayium sync em execução e sincroniza novamente de forma automática logo após qualquer arquivo sob a origem mudar — uma alternativa leve à sondagem agendada.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete espelha as exclusões (o receptor precisa de serve --allow-delete).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch permanece em execução e sincroniza novamente a cada mudança, em vez de rodar uma única vez pelo cron.",
      ],
    },
    {
      heading: "Quando não funciona",
      body: [
        "Cada um destes casos é invisível até você olhar o log — por isso o redirecionamento está na linha do crontab e não é opcional. O quinto é pior que invisível: ele parece sucesso.",
      ],
      troubleshooting: {
        label: "Sintoma, checagem, correção",
        items: [
          {
            symptom: "O log diz relayium: command not found, mas o mesmo comando funciona no seu shell.",
            code: [
              `tail -n 5 ~/relayium-backup.log
# /bin/sh: relayium: command not found`,
            ],
            fix: "O cron roda com um PATH mínimo, normalmente só /usr/bin:/bin. Se o install.sh não conseguiu escrever em /usr/local/bin, o binário está em ~/.local/bin, onde o cron nunca vai procurar. Use na linha do crontab o caminho absoluto que o command -v mostra, ou coloque uma linha PATH= no topo do crontab.",
          },
          {
            symptom: "O log mostra a conexão ssh recusada, ou nada depois da primeira execução.",
            code: [
              `ssh -i ~/.ssh/backup_key -o BatchMode=yes user@backup-server true
# Permission denied (publickey).`,
            ],
            fix: "O cron não tem ssh-agent nem terminal, então uma chave com frase secreta só pode travar ou falhar. Aponte o -i para uma chave sem frase secreta reservada aos backups e confirme com BatchMode=yes, que se recusa a perguntar em vez de esperar por alguém que não está lá.",
          },
          {
            symptom: "O sync roda limpo, mas os arquivos apagados na origem continuam no destino.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "A exclusão é uma opção do lado receptor. Sem serve --allow-delete do outro lado, as exclusões são puladas e reportadas como negadas — por isso a resposta está no log e não no código de saída. Reinicie o receptor do outro lado com --allow-delete.",
          },
          {
            symptom: "O sync recusa o --delete de saída.",
            code: [
              `relayium sync ~/documents user@backup-server:/srv/backups/ --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "A origem não resolveu nenhum arquivo, então o espelho teria esvaziado o destino. Essa recusa é proposital. Verifique o caminho por causa de um erro de digitação, e verifique se o que deveria estar montado ali está montado na hora em que o cron dispara, e não só quando você está logado.",
          },
          {
            symptom: "O backup roda, sai com 0, e não é o que você pensa.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "Quando a máquina remota não tem relayium, o push recorre a um fluxo tar simples sobre SSH. Os arquivos chegam, então nada reclama — mas esse caminho não tem verificação SHA-256 por arquivo nem checagem de colisão antecipada, que são exatamente os dois motivos para agendar isto em vez de um scp. Instale a CLI no destino para recuperá-las. O sync não tem essa falha: como não tem recurso nenhum, ele falha alto em vez disso.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O servidor de backup precisa do relayium instalado?",
        a: "Depende do comando. push funciona nos dois casos: com o relayium instalado, ele usa o protocolo nativo (checagem de colisão antecipada + SHA-256 por arquivo); sem ele, push recorre a um fluxo tar simples por SSH, então um servidor pelado ainda funciona. O sync sempre precisa do protocolo nativo do relayium no lado remoto — não há recurso alternativo com tar para o sync, então instale-o lá primeiro.",
      },
      {
        q: "O backup é criptografado e verificado?",
        a: "Sim. Cada arquivo é conferido com um hash SHA-256 de ponta a ponta, e ao enviar por SSH ou daemon-direct os bytes já estão protegidos pela criptografia daquela conexão — nada mais a configurar.",
      },
      {
        q: "O que acontece se a tarefa cron for interrompida no meio?",
        a: "Depende de qual comando você agendou. O sync continua: a próxima execução pula o que já corresponde e leva adiante um arquivo parcial, e o --no-resume desliga isso. O push não retoma em nenhum dos dois protocolos — ele recusa um destino que já existe, que é o motivo de a linha de push acima escrever em um diretório com data, para que a noite seguinte seja uma cópia completa e limpa em vez de uma recusa. O --no-resume é aceito pelo push e não faz nada.",
      },
      {
        q: "O --delete pode apagar meu destino por acidente?",
        a: "O sync se recusa a rodar com --delete se o diretório de origem não contiver nenhum arquivo, e o receptor precisa ser iniciado com serve --allow-delete para que as exclusões tenham efeito — caso contrário, elas são ignoradas e reportadas a você.",
      },
      {
        q: "Preciso de uma conta ou isso custa alguma coisa?",
        a: "Não. A CLI é gratuita e não precisa de conta para push, pull ou sync — a transferência ocorre pela sua própria conexão SSH ou por uma conexão direta de daemon, não pelos servidores do Relayium.",
      },
    ],
  },
  cta: {
    text: "Coloque seus backups em um cronograma que você não precisa lembrar — criptografados em trânsito, verificados por arquivo e gratuitos.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/automate-server-backups",
  published: "2026-07-09",
  updated: "2026-08-06",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
