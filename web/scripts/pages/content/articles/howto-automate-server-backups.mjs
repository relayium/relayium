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
        "push makes a collision-safe one-time daemon-direct copy and refuses an existing destination rather than overwriting or resuming. That makes it the wrong shape for a repeated job pointed at one fixed receive directory.",
        "sync keeps one destination as an incremental one-way mirror: unchanged files are skipped, changed files are sent, and a partial file continues on the next run. Being a mirror, it is current rather than historical: deleting or corrupting a source file can be propagated.",
      ],
      bullets: [
        "Use push into a dated destination when you want each run to stand on its own and older copies to survive.",
        "Use sync for a large or frequently-changing directory kept as one current copy, where re-sending everything every night would be wasteful.",
        "Both verify each transferred file with SHA-256. push does not resume; sync continues a partial file on a later run.",
      ],
    },
    {
      heading: "One transport: daemon-direct",
      body: [
        "Point either command at a relayium:// destination whose receiving machine is running relayium serve. SSH destinations are retired.",
      ],
      code: [
        `# daemon-direct — the destination runs "relayium serve"
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "Daemon-direct connections are pinned TLS 1.3 with trust-on-first-use, then pinned to that fingerprint on every run after.",
        "sync accepts the same relayium:// destination form as push.",
      ],
    },
    {
      heading: "Schedule it with cron",
      prereqs: {
        label: "What you need before step 1",
        items: [
          "The CLI on both machines, with relayium serve running on the destination.",
          "A destination running relayium serve with this sender pre-authorized. cron has no terminal, so an unknown fingerprint is rejected rather than prompting.",
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
          text: "Confirm the listener is reachable and this sender has already been authorized.",
          code: ["relayium id"],
        },
        {
          text: "Run the whole command by hand once, written exactly as cron will run it, absolute path included.",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "relayium resolves to an absolute path you can paste into the crontab, and a manual daemon-direct sync exits 0 without asking to authorize an unknown sender. A copy that only works after an interactive approval is not scheduled yet.",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031
$ echo $?
0`,
        ],
      },
      body: [
        "sync is a single non-interactive command, so it drops straight into a crontab once the sender is pre-authorized. Log the output so failures are visible:",
      ],
      code: [
        `# incremental mirror every 15 minutes
*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "The command exits non-zero if any file fails its integrity check, so cron's mail-on-failure catches problems.",
        "An interrupted sync catches up on the next scheduled run: what already matches is skipped and a partial file is continued.",
        "This is a current-state mirror, not versioned history. Add snapshots on the receiver when older states matter.",
      ],
    },
    {
      heading: "Mirroring deletions and real-time sync",
      body: [
        "By default sync only adds or updates files at the destination. Add --delete to mirror source deletions. The relayium:// receiver must have been started as serve --allow-delete; otherwise deletions are skipped and reported as denied.",
        "Two things bound the damage either way. Deletion is confined to the top-level directories the run actually sends, so a sibling directory on the destination is never touched; and sync refuses --delete outright if the source resolves to no files, so a typo in the source path or an unmounted source cannot empty the destination.",
        "If you'd rather not wait for cron's next tick, --watch keeps relayium sync running and re-syncs automatically a moment after any file under the source changes — a lightweight alternative to polling on a schedule.",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete mirrors deletions only when the listener consents with --allow-delete.",
        "relayium sync ./data relayium://backup-server:9031 --delete deletes only if that listener was started with serve --allow-delete; otherwise it is reported back as denied.",
        "relayium sync ./data relayium://backup-server:9031 --watch stays running and re-syncs on change instead of running once from cron.",
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
            symptom: "The log says \"SSH transfers are currently disabled\", or shows nothing after the first run.",
            code: [
              `grep -i "SSH transfers" ~/relayium-sync.log
# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.`,
            ],
            fix: "The scheduled command still names an old SSH destination, and SSH transfers are retired. Run relayium serve on the backup server, authorize this machine's relayium id fingerprint there, and change the target to relayium://backup-server — no SSH key, agent or passphrase is involved any more.",
          },
          {
            symptom: "sync runs cleanly but files deleted at the source are still on the destination.",
            code: [
              `grep -i deni ~/relayium-sync.log`,
            ],
            fix: "Deletion is a receiver-side opt-in: without serve --allow-delete, deletions are skipped and reported as denied. Restart the listener with --allow-delete and confirm --delete is on the scheduled command.",
          },
          {
            symptom: "sync refuses --delete outright.",
            code: [
              `relayium sync ~/documents relayium://backup-server:9031 --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "The source resolved to no files, so the mirror would have emptied the destination. That refusal is deliberate. Check the path for a typo, and check that anything mounted there is actually mounted at the time cron fires rather than only when you are logged in.",
          },
          {
            symptom: "The backup runs, exits 0, and is not what you think it is.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "Current push and sync require a Relayium listener. Install the CLI on the destination, start serve, authorize the sender, and use a relayium:// target; there is no silent fallback transport.",
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
        a: "Yes. Current push and sync use the native daemon-direct protocol and require relayium serve on the receiver. There is no SSH or tar fallback.",
      },
      {
        q: "Is the copy encrypted and verified?",
        a: "Yes in transit, and every transferred file is checked with SHA-256. sync decides what to send from size and modification time, so a skipped file is not re-hashed. Matching directory sizes are a sanity check, not proof that skipped contents still match.",
      },
      {
        q: "What happens if the cron job is interrupted halfway through?",
        a: "It depends which command you scheduled. sync continues: the next run skips what already matches and carries on a partial file, and --no-resume turns that off. push does not resume — it refuses a destination that already exists, so a scheduled push would need a fresh (for example dated) destination every run; that is why this guide schedules sync. --no-resume is accepted by push and does nothing.",
      },
      {
        q: "Can --delete accidentally wipe my destination?",
        a: "sync refuses to run with --delete if the source directory contains no files, and the receiver has to be started with serve --allow-delete for deletions to take effect at all — otherwise they're skipped and reported back to you.",
      },
      {
        q: "Do I need an account or does this cost anything?",
        a: "No. The CLI is free and daemon-direct push/sync needs no Relayium account or per-transfer payment.",
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
        "push 通过 daemon 直连做一次拒绝冲突的复制：目标已存在就拒绝，而不是覆盖或续传。因此它不适合反复指向同一个接收目录的定时任务。",
        "sync 把目标维护成源端的增量单向镜像：未变文件跳过，只发送变化部分，半截文件会在下次运行继续。镜像反映当下而不是历史：源端删除或损坏可能被传播。",
      ],
      bullets: [
        "希望每次运行各自独立、旧副本还能留着，就让 push 写进按日期命名的目标。",
        "目录很大或者经常变动，只想保留一份持续更新的副本、每晚重发全部内容太浪费，就用 sync。",
        "两者都会对真正传输的文件做逐文件 SHA-256 校验。push 不续传；sync 会在后续运行接着传半截文件。",
      ],
    },
    {
      heading: "一种传输方式：daemon 直连",
      body: [
        "两个命令都指向正在运行 relayium serve 的 relayium:// 目标。SSH 目标已经退役。",
      ],
      code: [
        `# daemon 直连——目标机器运行着 "relayium serve"
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon 直连走的是带证书证书固定的 TLS 1.3：首次连接时信任（trust-on-first-use），之后每次运行都校验同一个指纹。",
        "sync 与 push 都接受 relayium:// 目标。",
      ],
    },
    {
      heading: "用 cron 定时运行",
      prereqs: {
        label: "开始之前你需要什么",
        items: [
          "两台机器都装好 CLI，并在目标机运行 relayium serve。",
          "目标监听器已提前授权发送端。cron 没有终端，未知指纹会被拒绝，而不是弹出确认。",
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
          text: "确认监听端可达，并且已提前授权这台发送机。",
          code: ["relayium id"],
        },
        {
          text: "先手动完整跑一次，写法要和 cron 将要执行的一模一样，包括绝对路径。",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "relayium 解析出可以粘进 crontab 的绝对路径，而且手动 daemon 直连 sync 会以 0 退出，不要求批准未知发送端。仍需交互批准的任务还不能定时运行。",
        ],
        code: [
          `$ command -v relayium
/usr/local/bin/relayium
$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031
$ echo $?
0`,
        ],
      },
      body: [
        "发送端提前授权后，sync 是一条可直接放进 crontab 的非交互命令。把输出记下来，让失败可见：",
      ],
      code: [
        `# 每 15 分钟做一次增量镜像
*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "只要有文件没通过完整性校验，命令就会以非零状态退出，cron 的失败邮件通知就能发现问题。",
        "被中断的 sync 会在下一次计划运行时补上：已匹配的跳过，半截的接着传。",
        "这是当前状态镜像，不保留历史。需要旧状态时，请在接收端增加快照。",
      ],
    },
    {
      heading: "镜像删除与实时同步",
      body: [
        "默认情况下，sync 只新增或更新文件。加 --delete 才会镜像源端删除，而且 relayium:// 接收端必须以 serve --allow-delete 启动；否则删除会被跳过并回报 denied。",
        "两件事限定了破坏范围：删除只会发生在这一次运行真正发送的顶层目录内，目标端的兄弟目录永远不会被碰；而且如果源端解析不出任何文件，sync 会直接拒绝 --delete，所以源路径写错、或者该挂的没挂上，都清空不了目标目录。",
        "不想等 cron 的下一个执行点，就用 --watch：它会让 relayium sync 常驻运行，源目录下一有文件变动，片刻之后就自动重新同步——比按计划轮询更轻量。",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete 只有监听端以 --allow-delete 同意时才镜像删除。",
        "relayium sync ./data relayium://backup-server:9031 --delete 只有在那个监听端以 serve --allow-delete 启动时才会真删；否则会回报为 denied。",
        "relayium sync ./data relayium://backup-server:9031 --watch 会常驻运行，一有变化就同步，而不是靠 cron 单次触发。",
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
            symptom: "日志显示 “SSH transfers are currently disabled”，或者第一次运行之后就什么都没有了。",
            code: [
              `grep -i "SSH transfers" ~/relayium-sync.log
# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.`,
            ],
            fix: "定时命令里还写着旧的 SSH 目标，而 SSH 传输已经退役。请在备份服务器上运行 relayium serve，在那边授权这台机器 relayium id 打印的指纹，再把目标改成 relayium://backup-server——从此不再涉及 SSH 密钥、agent 或口令。",
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
              `relayium sync ~/documents relayium://backup-server:9031 --delete
# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).`,
            ],
            fix: "源端解析下来一个文件都没有，这时镜像会把目标端清空。这个拒绝是刻意的。检查路径是不是敲错了，也检查那里该挂载的东西在 cron 触发的时刻是否真的挂着，而不是只在你登录时才挂。",
          },
          {
            symptom: "备份跑了，退出码 0，但它并不是你以为的那个东西。",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "当前 push 与 sync 需要 Relayium 监听器。在目标机安装 CLI、启动 serve、授权发送端并使用 relayium://；不存在静默退化的传输通道。",
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
        a: "需要。当前 push 与 sync 使用原生 daemon 直连协议，接收端必须运行 relayium serve；没有 SSH 或 tar 兜底。",
      },
      {
        q: "这份副本会加密并校验吗？",
        a: "传输层会加密，真正传输的每个文件都会做 SHA-256 校验。但 sync 按大小和修改时间决定是否发送，被跳过的文件不会重新哈希。目录总大小一致只是粗略自检，不能证明跳过的内容仍一致。",
      },
      {
        q: "如果 cron 任务执行到一半被中断会怎样？",
        a: "看你排的是哪条命令。sync 会接着来：下一次运行跳过已匹配的文件，并把半截的文件接着传，--no-resume 可以关掉这一点。push 不续传——它会拒绝已存在的目标，所以定时运行的 push 每次都需要一个新的（例如按日期命名的）目标目录；这正是本指南排的是 sync 的原因。--no-resume 在 push 上能被接受，但什么也不做。",
      },
      {
        q: "--delete 会不会不小心清空我的目标目录？",
        a: "如果源目录里一个文件都没有，sync 会直接拒绝执行 --delete；删除也只会发生在这一次运行真正发送的顶层目录内。至于谁需要同意，取决于目标：走 relayium:// 时接收端必须以 serve --allow-delete 启动，删除才会生效，否则会被跳过并报告给你；走 SSH 时没有独立的监听端可以拒绝，传了 --delete 就是真删。",
      },
      {
        q: "需要账号吗，这个要收费吗？",
        a: "不需要。daemon 直连 push/sync 不需要 Relayium 账号，也不按次收费。",
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
    "本ガイドでは、cron から relayium push と増分同期の relayium sync をスケジュール実行する方法、どちらも使うデーモン直結の転送方式、そしてそのままコピーできる crontab の行を扱います。",
  ],
  sections: [
    {
      heading: "push と sync：全体コピーか増分ミラーか",
      body: [
        "push と sync はどちらもディレクトリを別のマシンへ転送し、どちらも繰り返し実行して安全ですが、解決するバックアップの課題は少し異なります。",
        "push は衝突に安全な一回限りのデーモン直結コピーを作り、既存の宛先は上書きも再開もせずに拒否します。そのため、固定の受信ディレクトリへ繰り返し実行するジョブには向きません。一方 sync は宛先をソースの増分・一方向ミラーとして維持します。変更のないファイルは飛ばし、変更されたファイルだけを送り、半端なファイルは次の実行で続けます。ミラーなので保持するのは過去ではなく現在の状態で、ソース側での削除や破損も伝わり得ます。",
      ],
      bullets: [
        "実行ごとに独立したコピーを残し、古いコピーも保持したいときは、日付付きの宛先へ push を使いましょう。",
        "大きい、あるいは頻繁に変化するディレクトリで、毎晩すべてを再送するのが無駄になる場合は sync を使いましょう。",
        "どちらも転送した各ファイルを SHA-256 で検証します。push は再開せず、sync は半端なファイルを次の実行で続けます。",
      ],
    },
    {
      heading: "転送方式は1つ：daemon-direct",
      body: [
        "どちらのコマンドも、受信側のマシンで relayium serve が動いている relayium:// の宛先を指定します。SSH の宛先は廃止されました。",
      ],
      code: [
        "# daemon-direct：宛先で \"relayium serve\" が動いています\nrelayium push ./data relayium://backup-server:9031",
      ],
      bullets: [
        "daemon-direct 接続はピン留めされた TLS 1.3 で、初回接続時に信頼（trust-on-first-use）し、以降の実行では同じフィンガープリントに対して検証します。",
        "sync は push と同じ relayium:// の宛先の書き方を受け付けます。",
      ],
    },
    {
      heading: "cron でスケジュール実行する",
      prereqs: {
        label: "手順1の前に必要なもの",
        items: [
          "両方のマシンに CLI があり、送り先で relayium serve が動いていること。",
          "relayium serve が動いていて、この送信側を事前承認している送り先。cron には端末がないため、未知のフィンガープリントは確認を求めずに拒否されます。",
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
          text: "リスナーに到達でき、この送信側がすでに承認されていることを確認します。",
          code: ["relayium id"],
        },
        {
          text: "まず手で一度、cron が実行するのとまったく同じ書き方で、絶対パスも含めて通しで実行します。",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "relayium が crontab にそのまま貼れる絶対パスとして解決され、手で実行したデーモン直結の sync が、未知の送信側の承認を求めずに終了コード0で終わります。対話的な承認を経ないと動かないコピーは、まだスケジュールされていません。",
        ],
        code: [
          "$ command -v relayium\n/usr/local/bin/relayium\n$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031\n$ echo $?\n0",
        ],
      },
      body: [
        "送信側を事前承認しておけば、sync は単一の非対話型コマンドなので、そのまま crontab に組み込めます。出力をログに残して、失敗を確認できるようにしましょう：",
      ],
      code: [
        "# 15分ごとの増分ミラー\n*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1",
      ],
      bullets: [
        "いずれかのファイルが整合性チェックに失敗すると、コマンドは非ゼロで終了するので、cron の失敗時メール通知で問題に気づけます。",
        "中断された sync は次の予定実行で追いつきます。すでに一致するものは飛ばされ、半端なファイルは続きから送られます。",
      ],
    },
    {
      heading: "削除のミラーリングとリアルタイム同期",
      body: [
        "デフォルトでは、sync は宛先側でファイルを追加または更新するだけです。--delete を付けると真のミラーになり、ソースにもう存在しないファイルも削除します。受信側は serve --allow-delete で明示的に待ち受けている必要があり、そうでなければ削除は黙って無視され、拒否されたと結果に報告されます。ソースディレクトリが1つもファイルを解決しない場合、sync は --delete の実行そのものを拒否するので、ソースパスの誤字で宛先が消えてしまうことはありません。",
        "cron の次の実行タイミングを待ちたくない場合は、--watch を使うと relayium sync が動き続け、ソース配下のファイルが変化するとすぐに自動で再同期します。スケジュールでポーリングする代わりの軽量な選択肢です。",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete は削除もミラーします（受信側に serve --allow-delete が必要）。",
        "relayium sync ./data relayium://backup-server:9031 --watch は動き続けて変化のたびに同期します。cron による単発実行の代わりに使えます。",
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
            symptom: "ログに「SSH transfers are currently disabled」と出る、または初回以降なにも記録されない。",
            code: [
              "grep -i \"SSH transfers\" ~/relayium-sync.log\n# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.",
            ],
            fix: "予定されたコマンドがまだ古い SSH の宛先を指定していますが、SSH 転送は廃止されました。バックアップサーバーで relayium serve を実行し、そこでこのマシンの relayium id のフィンガープリントを承認して、宛先を relayium://backup-server に変えてください。SSH 鍵も agent もパスフレーズも、もう関係ありません。",
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
              "relayium sync ~/documents relayium://backup-server:9031 --delete\n# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).",
            ],
            fix: "ソース側が1ファイルも解決できず、そのままではミラーが送り先を空にしてしまう状態です。この拒否は意図的です。パスの打ち間違いを確認し、そこにマウントされるはずのものが、ログイン中だけでなく cron の起動時点でも実際にマウントされているかを確認してください。",
          },
          {
            symptom: "バックアップは走り、終了コード0で終わるのに、中身は思っているものではない。",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "現在の push と sync には Relayium のリスナーが必要です。送り先に CLI を入れて serve を起動し、送信側を承認して relayium:// の宛先を使ってください。黙って切り替わる代替の転送方式はありません。",
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
        a: "はい。現在の push と sync はデーモン直結のネイティブプロトコルを使い、受信側で relayium serve が必要です。SSH や tar へのフォールバックはありません。",
      },
      {
        q: "バックアップは暗号化・検証されますか？",
        a: "されます。転送中は暗号化され、転送されたすべてのファイルは SHA-256 で検証されます。sync はサイズと更新時刻で送るものを決めるので、飛ばしたファイルはハッシュを取り直しません。ディレクトリのサイズが一致するのは目安であって、飛ばした内容がまだ一致している証明ではありません。",
      },
      {
        q: "cron ジョブが途中で中断された場合はどうなりますか？",
        a: "どちらのコマンドを予定したかによります。sync は続きます。次の実行はすでに一致するものを飛ばし、半端なファイルを続きから送ります。--no-resume はそれを切ります。push は再開しません。既存の宛先を拒否するので、繰り返し実行するなら sync を予定するか、実行ごとに新しい宛先へ push してください。--no-resume は push でも受け付けられますが、何もしません。",
      },
      {
        q: "--delete で誤って宛先を消してしまうことはありますか？",
        a: "sync はソースディレクトリにファイルが1つもない場合、--delete の実行自体を拒否します。また、削除が実際に反映されるには受信側が serve --allow-delete で起動されている必要があります。そうでなければスキップされ、結果として報告されます。",
      },
      {
        q: "アカウントは必要ですか、これは有料ですか？",
        a: "いいえ。CLI は無料で、デーモン直結の push/sync に Relayium アカウントも転送ごとの支払いも不要です。",
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
    "이 가이드는 cron에서 relayium push와 증분 방식의 relayium sync를 예약하는 방법, 둘 다 사용하는 데몬 다이렉트 전송 방식, 그리고 그대로 복사해 쓸 수 있는 crontab 줄을 다룹니다.",
  ],
  sections: [
    {
      heading: "push와 sync: 전체 복사냐 증분 미러링이냐",
      body: [
        "push와 sync는 둘 다 디렉터리를 다른 머신으로 옮기고, 둘 다 반복 실행해도 안전하지만, 해결하는 백업 문제는 조금 다릅니다.",
        "push는 충돌에 안전한 일회성 데몬 다이렉트 복사를 만들며, 이미 있는 목적지는 덮어쓰거나 재개하지 않고 거부합니다. 그래서 고정된 수신 디렉터리로 반복 실행하는 작업에는 맞지 않습니다. 반면 sync는 목적지를 소스의 증분 단방향 미러로 유지합니다. 바뀌지 않은 파일은 건너뛰고 바뀐 파일만 보내며, 부분 파일은 다음 실행에서 이어 갑니다. 미러이므로 과거가 아니라 현재 상태를 담으며, 소스의 삭제나 손상도 전파될 수 있습니다.",
      ],
      bullets: [
        "실행마다 독립된 복사본을 남기고 이전 복사본도 보존하고 싶다면 날짜별 목적지로 push를 사용하세요.",
        "크거나 자주 변하는 디렉터리에서 매일 밤 전체를 다시 보내는 것이 낭비라면 sync를 사용하세요.",
        "둘 다 전송한 각 파일을 SHA-256으로 검증합니다. push는 재개하지 않고, sync는 부분 파일을 다음 실행에서 이어 갑니다.",
      ],
    },
    {
      heading: "전송 방식은 하나: daemon-direct",
      body: [
        "두 명령 모두 받는 기기에서 relayium serve가 실행 중인 relayium:// 대상을 지정합니다. SSH 대상은 폐지되었습니다.",
      ],
      code: [
        "# daemon-direct: 대상에서 \"relayium serve\"가 실행 중입니다\nrelayium push ./data relayium://backup-server:9031",
      ],
      bullets: [
        "daemon-direct 연결은 고정된(pinned) TLS 1.3을 사용하며, 처음 연결할 때 신뢰(trust-on-first-use)하고 이후 실행부터는 같은 지문(fingerprint)에 대해 검증합니다.",
        "sync는 push와 같은 relayium:// 대상 형식을 받습니다.",
      ],
    },
    {
      heading: "cron으로 예약 실행하기",
      prereqs: {
        label: "1단계 전에 필요한 것",
        items: [
          "두 기기 모두에 CLI가 있고, 대상에서 relayium serve가 실행 중일 것.",
          "relayium serve가 실행 중이고 이 보내는 쪽을 미리 승인해 둔 대상. cron에는 터미널이 없으므로 모르는 지문은 묻지 않고 거부됩니다.",
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
          text: "리스너에 도달할 수 있고 이 보내는 쪽이 이미 승인되었는지 확인합니다.",
          code: ["relayium id"],
        },
        {
          text: "먼저 손으로 한 번, cron이 실행할 것과 똑같은 형태로 절대 경로까지 포함해 통째로 실행해 보세요.",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "relayium이 crontab에 그대로 붙여 넣을 수 있는 절대 경로로 확인되고, 직접 실행한 데몬 다이렉트 sync가 모르는 보내는 쪽의 승인을 묻지 않고 종료 코드 0으로 끝납니다. 대화형 승인을 거쳐야만 동작하는 복사는 아직 예약된 것이 아닙니다.",
        ],
        code: [
          "$ command -v relayium\n/usr/local/bin/relayium\n$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031\n$ echo $?\n0",
        ],
      },
      body: [
        "보내는 쪽을 미리 승인해 두면 sync는 단일 비대화형 명령이므로 crontab에 그대로 넣을 수 있습니다. 실패를 확인할 수 있도록 출력을 로그로 남기세요:",
      ],
      code: [
        "# 15분마다 증분 미러\n*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1",
      ],
      bullets: [
        "무결성 검사에 실패한 파일이 하나라도 있으면 명령이 0이 아닌 상태로 종료되므로, cron의 실패 시 메일 알림으로 문제를 발견할 수 있습니다.",
        "중단된 sync는 다음 예약 실행에서 따라잡습니다. 이미 일치하는 것은 건너뛰고 부분 파일은 이어서 보냅니다.",
      ],
    },
    {
      heading: "삭제 미러링과 실시간 동기화",
      body: [
        "기본적으로 sync는 대상 쪽에서 파일을 추가하거나 갱신하기만 합니다. --delete를 추가하면 진짜 미러가 되어 소스에 더 이상 없는 파일도 삭제합니다 — 수신 측이 명시적으로 serve --allow-delete로 대기 중이어야 하며, 그렇지 않으면 삭제는 조용히 건너뛰어지고 결과에 거부됨으로 보고됩니다. 소스 디렉터리가 파일을 하나도 찾지 못하면 sync는 --delete 실행 자체를 거부하므로, 소스 경로 오타로 대상이 지워지는 일은 없습니다.",
        "cron의 다음 실행 시각을 기다리고 싶지 않다면, --watch를 사용해 relayium sync를 계속 실행 상태로 두면 소스 아래의 파일이 변경된 직후 자동으로 다시 동기화됩니다 — 예약된 폴링을 대신하는 가벼운 방법입니다.",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete는 삭제도 미러링합니다(수신 측에 serve --allow-delete 필요).",
        "relayium sync ./data relayium://backup-server:9031 --watch는 계속 실행되며 변경 시마다 동기화합니다. cron의 단발 실행 대신 사용할 수 있습니다.",
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
            symptom: "로그에 “SSH transfers are currently disabled”가 나오거나, 첫 실행 이후로 아무것도 없습니다.",
            code: [
              "grep -i \"SSH transfers\" ~/relayium-sync.log\n# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.",
            ],
            fix: "예약된 명령이 아직 예전 SSH 대상을 지정하고 있는데, SSH 전송은 폐지되었습니다. 백업 서버에서 relayium serve를 실행하고 거기서 이 기기의 relayium id 지문을 승인한 뒤, 대상을 relayium://backup-server로 바꾸세요. 이제 SSH 키도 agent도 패스프레이즈도 필요 없습니다.",
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
              "relayium sync ~/documents relayium://backup-server:9031 --delete\n# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).",
            ],
            fix: "원본에서 파일이 하나도 잡히지 않아, 그대로 두면 미러가 목적지를 비워 버리는 상태입니다. 이 거부는 의도된 것입니다. 경로 오타를 확인하고, 거기 붙어야 할 것이 로그인 중일 때뿐 아니라 cron이 도는 시점에도 실제로 마운트되어 있는지 확인하세요.",
          },
          {
            symptom: "백업이 돌고 0으로 끝나는데, 내용이 생각한 그것이 아닙니다.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "현재 push와 sync에는 Relayium 리스너가 필요합니다. 대상에 CLI를 설치하고 serve를 시작한 뒤 보내는 쪽을 승인하고 relayium:// 대상을 사용하세요. 조용히 바뀌는 대체 전송 방식은 없습니다.",
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
        a: "네. 현재 push와 sync는 데몬 다이렉트 네이티브 프로토콜을 사용하며 받는 쪽에 relayium serve가 필요합니다. SSH나 tar 대체 방식은 없습니다.",
      },
      {
        q: "백업이 암호화되고 검증되나요?",
        a: "네, 전송 중에 암호화되며 전송된 모든 파일은 SHA-256으로 검증됩니다. sync는 크기와 수정 시각으로 보낼 것을 정하므로, 건너뛴 파일은 다시 해시하지 않습니다. 디렉터리 크기가 같다는 것은 대략적인 확인일 뿐, 건너뛴 내용이 여전히 같다는 증거는 아닙니다.",
      },
      {
        q: "cron 작업이 중간에 중단되면 어떻게 되나요?",
        a: "어떤 명령을 예약했느냐에 따라 다릅니다. sync는 이어집니다: 다음 실행이 이미 일치하는 것은 건너뛰고 부분 파일을 이어서 보내며, --no-resume이 그것을 끕니다. push는 재개하지 않습니다 — 이미 존재하는 목적지를 거부하므로, 반복 실행하려면 sync를 예약하거나 실행마다 새 목적지로 push하세요. --no-resume은 push에서도 받아들여지지만 아무 일도 하지 않습니다.",
      },
      {
        q: "--delete가 실수로 대상을 지워버릴 수 있나요?",
        a: "소스 디렉터리에 파일이 하나도 없으면 sync는 --delete 실행 자체를 거부합니다. 또한 삭제가 실제로 적용되려면 수신 측이 serve --allow-delete로 시작되어 있어야 합니다 — 그렇지 않으면 건너뛰어지고 결과로 보고됩니다.",
      },
      {
        q: "계정이 필요한가요, 비용이 드나요?",
        a: "아니요. CLI는 무료이며, 데몬 다이렉트 push/sync에는 Relayium 계정도 전송별 결제도 필요 없습니다.",
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
    "Diese Anleitung behandelt, wie du relayium push und das inkrementelle relayium sync per cron planst, den daemon-direct-Übertragungsweg, den beide nutzen, und welche crontab-Zeilen du einfach übernehmen kannst.",
  ],
  sections: [
    {
      heading: "push oder sync: vollständige Kopie oder inkrementelle Spiegelung",
      body: [
        "push und sync übertragen beide ein Verzeichnis auf eine andere Maschine, und beide lassen sich gefahrlos wiederholt ausführen, aber sie lösen leicht unterschiedliche Backup-Probleme.",
        "push erstellt eine kollisionssichere einmalige daemon-direct-Kopie und verweigert ein vorhandenes Ziel, statt es zu überschreiben oder fortzusetzen — für einen wiederholten Job auf ein festes Empfangsverzeichnis passt das nicht. sync hält dagegen ein Ziel als inkrementellen Einweg-Spiegel der Quelle: Unveränderte Dateien werden übersprungen, geänderte gesendet, und eine Teildatei wird beim nächsten Lauf fortgesetzt. Als Spiegel ist es aktuell statt historisch: Das Löschen oder Beschädigen einer Quelldatei kann mitübertragen werden.",
      ],
      bullets: [
        "Nutze push in ein datiertes Ziel, wenn jeder Lauf für sich stehen und ältere Kopien erhalten bleiben sollen.",
        "Nutze sync für ein großes oder häufig wechselndes Verzeichnis, bei dem jede Nacht alles neu zu senden Verschwendung wäre.",
        "Beide prüfen jede übertragene Datei per SHA-256. push setzt nicht fort; sync führt eine Teildatei in einem späteren Lauf weiter.",
      ],
    },
    {
      heading: "Ein Übertragungsweg: daemon-direct",
      body: [
        "Richte beide Befehle auf ein relayium://-Ziel, dessen Empfangsrechner relayium serve ausführt. SSH-Ziele sind eingestellt.",
      ],
      code: [
        "# daemon-direct: auf dem Ziel läuft \"relayium serve\"\nrelayium push ./data relayium://backup-server:9031",
      ],
      bullets: [
        "daemon-direct-Verbindungen nutzen gepinntes TLS 1.3 mit Trust-on-first-use und werden danach bei jedem weiteren Lauf gegen genau diesen Fingerabdruck geprüft.",
        "sync akzeptiert dieselbe relayium://-Zielform wie push.",
      ],
    },
    {
      heading: "Per cron planen",
      prereqs: {
        label: "Was du vor Schritt 1 brauchst",
        items: [
          "Die CLI auf beiden Rechnern, mit relayium serve auf dem Ziel.",
          "Ein Ziel, auf dem relayium serve läuft und das diesen Absender vorab autorisiert hat. cron hat kein Terminal, daher wird ein unbekannter Fingerabdruck abgelehnt statt nachgefragt.",
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
          text: "Prüfe, dass der Listener erreichbar ist und dieser Absender bereits autorisiert wurde.",
          code: ["relayium id"],
        },
        {
          text: "Führ den ganzen Befehl einmal von Hand aus, exakt so geschrieben wie cron ihn ausführen wird, absoluter Pfad inklusive.",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "relayium löst zu einem absoluten Pfad auf, den du in die crontab einfügen kannst, und ein manueller daemon-direct-sync endet mit 0, ohne nach der Autorisierung eines unbekannten Absenders zu fragen. Eine Kopie, die nur nach einer interaktiven Bestätigung funktioniert, ist noch nicht eingeplant.",
        ],
        code: [
          "$ command -v relayium\n/usr/local/bin/relayium\n$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031\n$ echo $?\n0",
        ],
      },
      body: [
        "Ist der Absender vorab autorisiert, ist sync ein einzelner nicht-interaktiver Befehl und passt direkt in eine crontab. Protokolliere die Ausgabe, damit Fehler sichtbar werden:",
      ],
      code: [
        "# inkrementeller Spiegel alle 15 Minuten\n*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1",
      ],
      bullets: [
        "Der Befehl endet mit einem Exit-Code ungleich null, wenn eine Datei ihre Integritätsprüfung nicht besteht, sodass crons Mail-bei-Fehlschlag das Problem auffängt.",
        "Ein unterbrochener sync holt beim nächsten geplanten Lauf auf: Was schon passt, wird übersprungen, und eine Teildatei wird fortgesetzt.",
      ],
    },
    {
      heading: "Löschungen spiegeln und Echtzeit-Synchronisierung",
      body: [
        "Standardmäßig fügt sync am Ziel nur Dateien hinzu oder aktualisiert sie. Mit --delete wird daraus ein echter Spiegel, der auch Dateien entfernt, die es in der Quelle nicht mehr gibt — die Empfängerseite muss dafür ausdrücklich mit serve --allow-delete lauschen, sonst werden die Löschungen stillschweigend übersprungen und als abgelehnt zurückgemeldet. sync verweigert --delete außerdem grundsätzlich, wenn das Quellverzeichnis zu keiner einzigen Datei aufgelöst wird, sodass ein Tippfehler im Quellpfad das Ziel nicht leerräumen kann.",
        "Wer nicht auf den nächsten cron-Zeitpunkt warten will, kann mit --watch relayium sync dauerhaft laufen lassen: Es synchronisiert automatisch kurz nachdem sich eine Datei unter der Quelle ändert — eine leichtgewichtige Alternative zum zeitgesteuerten Polling.",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete spiegelt auch Löschungen (Empfänger braucht serve --allow-delete).",
        "relayium sync ./data relayium://backup-server:9031 --watch bleibt laufen und synchronisiert bei jeder Änderung, statt einmalig per cron.",
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
            symptom: "Das Log zeigt „SSH transfers are currently disabled“, oder nach dem ersten Lauf gar nichts mehr.",
            code: [
              "grep -i \"SSH transfers\" ~/relayium-sync.log\n# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.",
            ],
            fix: "Der geplante Befehl nennt noch ein altes SSH-Ziel, und SSH-Übertragungen sind eingestellt. Starte relayium serve auf dem Backup-Server, autorisiere dort den Fingerabdruck aus relayium id dieses Rechners und ändere das Ziel auf relayium://backup-server — SSH-Schlüssel, Agent und Passphrase spielen keine Rolle mehr.",
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
              "relayium sync ~/documents relayium://backup-server:9031 --delete\n# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).",
            ],
            fix: "Die Quelle löste sich zu null Dateien auf, der Spiegel hätte also das Ziel geleert. Diese Weigerung ist Absicht. Prüfe den Pfad auf einen Tippfehler — und prüfe, ob das, was dort eingehängt sein soll, auch zum Zeitpunkt des Cron-Laufs eingehängt ist und nicht nur, während du angemeldet bist.",
          },
          {
            symptom: "Das Backup läuft, endet mit 0, und ist nicht das, wofür du es hältst.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "Aktuelles push und sync brauchen einen Relayium-Listener. Installiere die CLI auf dem Ziel, starte serve, autorisiere den Absender und nutze ein relayium://-Ziel; einen stillen Ersatz-Übertragungsweg gibt es nicht.",
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
        a: "Ja. Aktuelles push und sync nutzen das native daemon-direct-Protokoll und brauchen relayium serve auf dem Empfänger. Es gibt keinen SSH- oder tar-Fallback.",
      },
      {
        q: "Ist das Backup verschlüsselt und geprüft?",
        a: "Ja, während der Übertragung, und jede übertragene Datei wird per SHA-256 geprüft. sync entscheidet anhand von Größe und Änderungszeit, was gesendet wird, eine übersprungene Datei wird also nicht neu gehasht. Übereinstimmende Verzeichnisgrößen sind eine Plausibilitätsprüfung, kein Beweis, dass übersprungene Inhalte noch übereinstimmen.",
      },
      {
        q: "Was passiert, wenn der cron-Job mittendrin unterbrochen wird?",
        a: "Das hängt davon ab, welchen Befehl du eingeplant hast. sync macht weiter: Der nächste Lauf überspringt, was schon passt, und führt eine Teildatei fort — und --no-resume schaltet genau das ab. push setzt nicht fort: Es verweigert ein Ziel, das schon existiert; für wiederholte Läufe plane daher sync ein oder pushe bei jedem Lauf in ein neues Ziel. --no-resume wird von push angenommen und tut nichts.",
      },
      {
        q: "Kann --delete versehentlich mein Ziel leeren?",
        a: "sync verweigert die Ausführung mit --delete, wenn das Quellverzeichnis keine Dateien enthält, und die Empfängerseite muss mit serve --allow-delete gestartet sein, damit Löschungen überhaupt wirksam werden — sonst werden sie übersprungen und dir gemeldet.",
      },
      {
        q: "Brauche ich ein Konto oder kostet das etwas?",
        a: "Nein. Die CLI ist kostenlos, und daemon-direct push/sync braucht weder ein Relayium-Konto noch eine Zahlung pro Übertragung.",
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
    "Ce guide couvre la planification de relayium push et du relayium sync incrémental via cron, le transport daemon-direct que l'un comme l'autre utilisent, et des lignes de crontab prêtes à copier.",
  ],
  sections: [
    {
      heading: "push ou sync : copie complète ou miroir incrémental",
      body: [
        "push et sync déplacent tous deux un répertoire vers une autre machine, et tous deux peuvent être exécutés sans risque de façon répétée, mais ils résolvent des problèmes de sauvegarde légèrement différents.",
        "push crée une copie daemon-direct ponctuelle protégée contre les collisions et refuse une destination existante au lieu de l'écraser ou de reprendre — ce qui ne convient pas à une tâche répétée vers un répertoire de réception fixe. sync, lui, maintient une destination comme miroir incrémental à sens unique de la source : les fichiers inchangés sont sautés, les fichiers modifiés envoyés, et un fichier partiel est poursuivi à l'exécution suivante. En tant que miroir, il reflète l'état actuel et non l'historique : la suppression ou la corruption d'un fichier source peut être propagée.",
      ],
      bullets: [
        "Utilisez push vers une destination datée quand chaque exécution doit être autonome et que les copies plus anciennes doivent survivre.",
        "Utilisez sync pour un répertoire volumineux ou qui change souvent, où tout renvoyer chaque nuit serait un gaspillage.",
        "Les deux vérifient chaque fichier transféré par SHA-256. push ne reprend pas ; sync poursuit un fichier partiel lors d'une exécution ultérieure.",
      ],
    },
    {
      heading: "Un seul transport : daemon-direct",
      body: [
        "Pointez l'une ou l'autre commande vers une destination relayium:// dont la machine réceptrice exécute relayium serve. Les destinations SSH sont retirées.",
      ],
      code: [
        "# daemon-direct : la destination exécute \"relayium serve\"\nrelayium push ./data relayium://backup-server:9031",
      ],
      bullets: [
        "Les connexions daemon-direct utilisent du TLS 1.3 épinglé avec confiance à la première utilisation (trust-on-first-use), puis sont vérifiées contre cette même empreinte à chaque exécution suivante.",
        "sync accepte la même forme de destination relayium:// que push.",
      ],
    },
    {
      heading: "Le planifier avec cron",
      prereqs: {
        label: "Ce qu'il vous faut avant l'étape 1",
        items: [
          "La CLI sur les deux machines, avec relayium serve en cours d'exécution sur la destination.",
          "Une destination qui exécute relayium serve et a pré-autorisé cet expéditeur. cron n'a pas de terminal : une empreinte inconnue est donc refusée au lieu de déclencher une question.",
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
          text: "Vérifiez que l'écouteur est joignable et que cet expéditeur a déjà été autorisé.",
          code: ["relayium id"],
        },
        {
          text: "Exécutez la commande entière une fois à la main, écrite exactement comme cron l'exécutera, chemin absolu compris.",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "relayium se résout en un chemin absolu que vous pouvez coller dans la crontab, et un sync daemon-direct lancé à la main se termine avec 0 sans demander d'autoriser un expéditeur inconnu. Une copie qui ne fonctionne qu'après une approbation interactive n'est pas encore planifiée.",
        ],
        code: [
          "$ command -v relayium\n/usr/local/bin/relayium\n$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031\n$ echo $?\n0",
        ],
      },
      body: [
        "Une fois l'expéditeur pré-autorisé, sync est une seule commande non interactive qui s'insère directement dans une crontab. Journalisez la sortie pour que les échecs soient visibles :",
      ],
      code: [
        "# miroir incrémental toutes les 15 minutes\n*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1",
      ],
      bullets: [
        "La commande se termine avec un code non nul si un fichier échoue à sa vérification d'intégrité, si bien que la notification par e-mail en cas d'échec de cron détecte les problèmes.",
        "Un sync interrompu rattrape son retard à l'exécution planifiée suivante : ce qui correspond déjà est sauté et un fichier partiel est poursuivi.",
      ],
    },
    {
      heading: "Mettre en miroir les suppressions et synchroniser en temps réel",
      body: [
        "Par défaut, sync ne fait qu'ajouter ou mettre à jour des fichiers du côté destination. Ajoutez --delete pour en faire un véritable miroir qui supprime aussi les fichiers que la source n'a plus — le côté récepteur doit explicitement écouter avec serve --allow-delete, sinon les suppressions sont silencieusement ignorées et signalées comme refusées. sync refuse aussi purement et simplement --delete si le répertoire source ne résout aucun fichier, si bien qu'une faute de frappe dans le chemin source ne peut pas vider la destination.",
        "Si vous préférez ne pas attendre le prochain passage de cron, --watch garde relayium sync en cours d'exécution et resynchronise automatiquement peu après qu'un fichier sous la source change — une solution légère, sans interrogation périodique.",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete met en miroir les suppressions (le récepteur a besoin de serve --allow-delete).",
        "relayium sync ./data relayium://backup-server:9031 --watch reste en cours d'exécution et resynchronise à chaque changement, au lieu d'une exécution unique via cron.",
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
            symptom: "Le journal affiche « SSH transfers are currently disabled », ou plus rien après la première exécution.",
            code: [
              "grep -i \"SSH transfers\" ~/relayium-sync.log\n# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.",
            ],
            fix: "La commande planifiée désigne encore une ancienne destination SSH, et les transferts SSH sont retirés. Lancez relayium serve sur le serveur de sauvegarde, autorisez-y l'empreinte relayium id de cette machine et changez la cible en relayium://backup-server — plus aucune clé SSH, agent ou phrase de passe n'intervient.",
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
              "relayium sync ~/documents relayium://backup-server:9031 --delete\n# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).",
            ],
            fix: "La source n'a résolu aucun fichier, le miroir aurait donc vidé la destination. Ce refus est délibéré. Vérifiez le chemin, et vérifiez que ce qui doit y être monté l'est bien à l'heure où cron se déclenche et pas seulement quand vous êtes connecté.",
          },
          {
            symptom: "La sauvegarde tourne, se termine par 0, et n'est pas ce que vous croyez.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "Les push et sync actuels exigent un écouteur Relayium. Installez la CLI sur la destination, lancez serve, autorisez l'expéditeur et utilisez une cible relayium:// ; il n'existe aucun transport de repli silencieux.",
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
        a: "Oui. Les push et sync actuels utilisent le protocole natif daemon-direct et exigent relayium serve sur le destinataire. Il n'y a aucun repli SSH ou tar.",
      },
      {
        q: "La sauvegarde est-elle chiffrée et vérifiée ?",
        a: "Oui pendant le transfert, et chaque fichier transféré est vérifié par SHA-256. sync décide de ce qu'il envoie d'après la taille et la date de modification, donc un fichier sauté n'est pas re-haché. Des tailles de répertoire identiques sont un contrôle de cohérence, pas la preuve que les contenus sautés correspondent encore.",
      },
      {
        q: "Que se passe-t-il si la tâche cron est interrompue en cours de route ?",
        a: "Cela dépend de la commande que vous avez planifiée. sync continue : l'exécution suivante saute ce qui correspond déjà et poursuit un fichier partiel, et --no-resume désactive cela. push ne reprend pas — il refuse une destination qui existe déjà ; pour des exécutions répétées, planifiez donc sync ou poussez vers une nouvelle destination à chaque exécution. --no-resume est accepté par push et n'y fait rien.",
      },
      {
        q: "--delete peut-il vider ma destination par accident ?",
        a: "sync refuse de s'exécuter avec --delete si le répertoire source ne contient aucun fichier, et le récepteur doit être démarré avec serve --allow-delete pour que les suppressions prennent effet — sinon elles sont ignorées et vous sont signalées.",
      },
      {
        q: "Ai-je besoin d'un compte, est-ce payant ?",
        a: "Non. La CLI est gratuite, et push/sync en daemon-direct ne demande ni compte Relayium ni paiement par transfert.",
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
    "يغطي هذا الدليل جدولة relayium push وrelayium sync التزايدي عبر cron، ووسيلة النقل daemon direct التي يستخدمها كلاهما، وأسطر crontab الجاهزة للنسخ.",
  ],
  sections: [
    {
      heading: "push مقابل sync: نسخة كاملة أم مرآة تزايدية",
      body: [
        "كلٌّ من push وsync ينقل مجلدًا إلى جهاز آخر، وكلاهما آمن للتشغيل المتكرر، لكنهما يحلّان مشكلتَي نسخ احتياطي مختلفتَين قليلًا.",
        "ينشئ push نسخة daemon direct لمرة واحدة آمنة من التعارض، ويرفض وجهة موجودة بدل الكتابة فوقها أو الاستئناف — ولذا لا يناسب مهمة متكررة نحو مجلد استقبال ثابت. أما sync فيُبقي الوجهة مرآة تزايدية أحادية الاتجاه للمصدر: يتخطى الملفات غير المتغيّرة ويرسل المتغيّرة ويُكمل الملف الجزئي في التشغيل التالي. ولأنه مرآة فهو يعكس الحالة الحالية لا التاريخ: فقد يُنقل حذف ملف في المصدر أو تلفه.",
      ],
      bullets: [
        "استخدم push نحو وجهة مؤرَّخة حين تريد أن يكون كل تشغيل قائمًا بذاته وأن تبقى النسخ الأقدم.",
        "استخدم sync لمجلد كبير أو كثير التغير حيث تكون إعادة إرسال كل شيء كل ليلة إهدارًا.",
        "يتحقق كلاهما من كل ملف منقول بـ SHA-256. لا يستأنف push، بينما يُكمل sync الملف الجزئي في تشغيل لاحق.",
      ],
    },
    {
      heading: "وسيلة نقل واحدة: daemon-direct",
      body: [
        "وجّه أيًّا من الأمرين إلى وجهة relayium:// يشغّل جهاز الاستقبال فيها relayium serve. أما وجهات SSH فقد أُوقفت.",
      ],
      code: [
        "# daemon-direct: الوجهة تشغّل \"relayium serve\"\nrelayium push ./data relayium://backup-server:9031",
      ],
      bullets: [
        "اتصالات daemon-direct مثبَّتة على TLS 1.3 مع الثقة عند الاستخدام الأول، ثم تُثبَّت على تلك البصمة في كل تشغيل لاحق.",
        "يقبل sync صيغة الوجهة relayium:// نفسها التي يقبلها push.",
      ],
    },
    {
      heading: "جدولته باستخدام cron",
      prereqs: {
        label: "ما تحتاجه قبل الخطوة 1",
        items: [
          "واجهة CLI على الجهازين، مع تشغيل relayium serve على الوجهة.",
          "وجهة تشغّل relayium serve واعتمدت هذا المُرسِل مسبقًا. ليس لدى cron طرفية، لذا تُرفض البصمة المجهولة بدل السؤال عنها.",
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
          text: "تأكّد من أن المستمع قابل للوصول وأن هذا المُرسِل قد اعتُمد بالفعل.",
          code: ["relayium id"],
        },
        {
          text: "شغّل الأمر كاملًا يدويًا مرة واحدة، مكتوبًا تمامًا كما سيشغّله cron، بما في ذلك المسار المطلق.",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "يُحلّ relayium إلى مسار مطلق يمكنك لصقه في crontab، وينتهي sync يدوي عبر daemon direct برمز 0 دون أن يطلب اعتماد مُرسِل مجهول. والنسخة التي لا تعمل إلا بعد موافقة تفاعلية ليست مجدولة بعد.",
        ],
        code: [
          "$ command -v relayium\n/usr/local/bin/relayium\n$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031\n$ echo $?\n0",
        ],
      },
      body: [
        "بعد اعتماد المُرسِل مسبقًا، يصبح sync أمرًا واحدًا غير تفاعلي يدخل مباشرةً في crontab. سجّل المخرجات كي تظهر الإخفاقات:",
      ],
      code: [
        "# مرآة تزايدية كل 15 دقيقة\n*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1",
      ],
      bullets: [
        "يخرج الأمر بحالة غير صفرية إذا فشل أي ملف في فحص سلامته، فتلتقط رسالة cron عند الفشل المشكلات.",
        "يلحق sync المنقطع بالركب في التشغيل المجدول التالي: يتخطى ما يطابق سلفًا ويُكمل الملف الجزئي.",
      ],
    },
    {
      heading: "عكس عمليات الحذف والمزامنة الفورية",
      body: [
        "افتراضيًا، لا يفعل sync سوى إضافة الملفات أو تحديثها في الوجهة. أضف --delete لجعله مرآة حقيقية تزيل أيضًا الملفات التي لم تعد موجودة في المصدر — يجب أن يكون الطرف المستقبِل مُنصِتًا صراحةً بـ serve --allow-delete، وإلا تُتجاهَل عمليات الحذف بصمت ويُبلَّغ عنها بأنها مرفوضة. كما يرفض sync استخدام --delete تمامًا إذا لم يُحلَّل مجلد المصدر إلى أي ملف، فلا يمكن لخطأ مطبعي في مسار المصدر أن يمحو الوجهة.",
        "إذا كنت تفضّل ألا تنتظر الدورة التالية لـ cron، يُبقي --watch عمل relayium sync مستمرًا ويعيد المزامنة تلقائيًا بعد لحظة من تغيّر أي ملف تحت المصدر — بديل خفيف عن الاستطلاع وفق جدول زمني.",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete يعكس عمليات الحذف (يحتاج المستقبِل إلى serve --allow-delete).",
        "relayium sync ./data relayium://backup-server:9031 --watch يبقى مستمرًا ويعيد المزامنة عند التغيّر بدلًا من التشغيل مرة واحدة من cron.",
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
            symptom: "يُظهر السجل «SSH transfers are currently disabled»، أو لا شيء بعد التشغيل الأول.",
            code: [
              "grep -i \"SSH transfers\" ~/relayium-sync.log\n# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.",
            ],
            fix: "ما زال الأمر المجدول يسمّي وجهة SSH قديمة، وقد أُوقفت عمليات النقل عبر SSH. شغّل relayium serve على خادم النسخ الاحتياطي، واعتمد هناك بصمة relayium id لهذا الجهاز، وغيّر الهدف إلى relayium://backup-server — لم يعد لمفتاح SSH ولا للوكيل ولا لعبارة المرور أي دور.",
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
              "relayium sync ~/documents relayium://backup-server:9031 --delete\n# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).",
            ],
            fix: "لم يُحلّ المصدر إلى أي ملف، فكانت المرآة ستفرغ الوجهة. وهذا الرفض مقصود. تحقّق من المسار بحثًا عن خطأ مطبعي، وتحقّق أن ما يُفترض تركيبه هناك مُركَّب فعلًا وقت انطلاق cron لا حين تكون مسجَّل الدخول فقط.",
          },
          {
            symptom: "تعمل النسخة الاحتياطية وتنتهي بالرمز 0، لكنها ليست ما تظنه.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "يتطلب push وsync الحاليان مستمع Relayium. ثبّت CLI على الوجهة وشغّل serve واعتمد المُرسِل واستخدم هدف relayium://؛ لا توجد وسيلة نقل بديلة صامتة.",
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
        a: "نعم. يستخدم push وsync الحاليان بروتوكول daemon direct الأصلي ويتطلبان relayium serve على جهاز الاستقبال. لا يوجد تراجع إلى SSH أو tar.",
      },
      {
        q: "هل النسخة الاحتياطية مُشفَّرة ومُتحقَّق منها؟",
        a: "نعم أثناء النقل، ويُتحقق من كل ملف منقول بـ SHA-256. يقرر sync ما يرسله بحسب الحجم ووقت التعديل، فلا يُعاد حساب تجزئة الملف المُتخطّى. وتطابق أحجام المجلدات فحص تقريبي، لا دليل على أن المحتويات المُتخطّاة ما زالت متطابقة.",
      },
      {
        q: "ماذا يحدث إذا قوطعت مهمة cron في منتصفها؟",
        a: "يعتمد على الأمر الذي جدولته. sync يُكمل: التشغيل التالي يتخطى ما يطابق سلفًا ويُكمل ملفًا جزئيًا، و‏--no-resume يوقف ذلك. أما push فلا يستأنف — فهو يرفض وجهة موجودة سلفًا؛ لذا جدوِل sync للتشغيل المتكرر أو ادفع بـ push إلى وجهة جديدة في كل تشغيل. و‏--no-resume مقبول في push ولا يفعل شيئًا.",
      },
      {
        q: "هل يمكن أن يمحو --delete وجهتي بالخطأ؟",
        a: "يرفض sync التشغيل مع --delete إذا لم يحتوِ مجلد المصدر على أي ملف، ويجب تشغيل المستقبِل بـ serve --allow-delete حتى تسري عمليات الحذف أصلًا — وإلا تُتجاهَل ويُبلَّغ عنها إليك.",
      },
      {
        q: "هل أحتاج إلى حساب، وهل يكلّف هذا شيئًا؟",
        a: "لا. واجهة CLI مجانية، ولا يحتاج push/sync عبر daemon direct إلى حساب Relayium ولا إلى دفع لكل عملية نقل.",
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
    "Esta guía cubre cómo programar relayium push y el relayium sync incremental desde cron, el transporte daemon directo que usan ambos, y las líneas de crontab para copiar.",
  ],
  sections: [
    {
      heading: "push frente a sync: copia completa o réplica incremental",
      body: [
        "Tanto push como sync mueven un directorio a otra máquina y ambos son seguros de ejecutar repetidamente, pero resuelven problemas de copia de seguridad ligeramente distintos.",
        "push hace una copia puntual con daemon directo, segura ante colisiones, y rechaza un destino existente en lugar de sobrescribirlo o reanudar; por eso no encaja en una tarea repetida hacia un directorio de recepción fijo. sync, en cambio, mantiene un destino como espejo incremental de un solo sentido del origen: se saltan los archivos sin cambios, se envían los modificados y un archivo parcial continúa en la siguiente ejecución. Como es un espejo, refleja el estado actual y no el histórico: borrar o corromper un archivo de origen puede propagarse.",
      ],
      bullets: [
        "Usa push hacia un destino con fecha cuando quieras que cada ejecución sea independiente y que las copias anteriores se conserven.",
        "Usa sync para un directorio grande o que cambia con frecuencia, donde reenviar todo cada noche sería un desperdicio.",
        "Ambos verifican cada archivo transferido con SHA-256. push no reanuda; sync continúa un archivo parcial en una ejecución posterior.",
      ],
    },
    {
      heading: "Un solo transporte: daemon-direct",
      body: [
        "Apunta cualquiera de los dos comandos a un destino relayium:// cuya máquina receptora ejecute relayium serve. Los destinos SSH están retirados.",
      ],
      code: [
        "# daemon-direct: el destino ejecuta \"relayium serve\"\nrelayium push ./data relayium://backup-server:9031",
      ],
      bullets: [
        "Las conexiones daemon-direct usan TLS 1.3 fijado con confianza en el primer uso, y luego se comprueban contra esa misma huella en cada ejecución posterior.",
        "sync acepta la misma forma de destino relayium:// que push.",
      ],
    },
    {
      heading: "Prográmalo con cron",
      prereqs: {
        label: "Lo que necesitas antes del paso 1",
        items: [
          "La CLI en las dos máquinas, con relayium serve en ejecución en el destino.",
          "Un destino que ejecute relayium serve y tenga preautorizado a este remitente. cron no tiene terminal, así que una huella desconocida se rechaza en lugar de preguntar.",
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
          text: "Confirma que el receptor es alcanzable y que este remitente ya fue autorizado.",
          code: ["relayium id"],
        },
        {
          text: "Ejecuta la orden entera a mano una vez, escrita exactamente como la ejecutará cron, ruta absoluta incluida.",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "relayium se resuelve a una ruta absoluta que puedes pegar en el crontab, y un sync con daemon directo ejecutado a mano termina con 0 sin pedir autorizar a un remitente desconocido. Una copia que solo funciona tras una aprobación interactiva todavía no está programada.",
        ],
        code: [
          "$ command -v relayium\n/usr/local/bin/relayium\n$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031\n$ echo $?\n0",
        ],
      },
      body: [
        "Con el remitente preautorizado, sync es un único comando no interactivo que entra directamente en un crontab. Registra la salida para que los fallos sean visibles:",
      ],
      code: [
        "# espejo incremental cada 15 minutos\n*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1",
      ],
      bullets: [
        "El comando termina con un código distinto de cero si algún archivo falla su comprobación de integridad, así que el aviso por correo de cron ante fallos detecta los problemas.",
        "Un sync interrumpido se pone al día en la siguiente ejecución programada: lo que ya coincide se salta y un archivo parcial continúa.",
      ],
    },
    {
      heading: "Replicar borrados y sincronización en tiempo real",
      body: [
        "De forma predeterminada, sync solo añade o actualiza archivos en el destino. Añade --delete para convertirlo en una réplica de verdad que también elimina los archivos que el origen ya no tiene: el lado receptor debe estar escuchando explícitamente con serve --allow-delete, o los borrados se omiten en silencio y se informan de vuelta como denegados. sync además rechaza --delete de plano si el directorio de origen no se resuelve en ningún archivo, de modo que un error de tecleo en la ruta de origen no puede vaciar el destino.",
        "Si prefieres no esperar al siguiente tic de cron, --watch mantiene relayium sync en ejecución y vuelve a sincronizar automáticamente un instante después de que cambie cualquier archivo bajo el origen: una alternativa ligera al sondeo programado.",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete replica los borrados (el receptor necesita serve --allow-delete).",
        "relayium sync ./data relayium://backup-server:9031 --watch se mantiene en ejecución y vuelve a sincronizar al cambiar algo, en lugar de ejecutarse una sola vez desde cron.",
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
            symptom: "El registro muestra «SSH transfers are currently disabled», o nada después de la primera ejecución.",
            code: [
              "grep -i \"SSH transfers\" ~/relayium-sync.log\n# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.",
            ],
            fix: "El comando programado todavía nombra un destino SSH antiguo, y las transferencias SSH están retiradas. Ejecuta relayium serve en el servidor de copias, autoriza allí la huella de relayium id de esta máquina y cambia el destino a relayium://backup-server: ya no intervienen clave SSH, agente ni frase de contraseña.",
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
              "relayium sync ~/documents relayium://backup-server:9031 --delete\n# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).",
            ],
            fix: "El origen no resolvió ningún archivo, así que el espejo habría vaciado el destino. Ese rechazo es deliberado. Revisa la ruta por si hay una errata, y comprueba que lo que deba estar montado ahí lo esté a la hora en que se dispara cron y no solo cuando tienes sesión abierta.",
          },
          {
            symptom: "La copia se ejecuta, termina con 0, y no es lo que crees.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "push y sync actuales requieren un receptor de Relayium. Instala la CLI en el destino, inicia serve, autoriza al remitente y usa un destino relayium://; no hay ningún transporte alternativo silencioso.",
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
        a: "Sí. push y sync actuales usan el protocolo nativo daemon directo y requieren relayium serve en el receptor. No hay alternativa con SSH ni con tar.",
      },
      {
        q: "¿La copia de seguridad va cifrada y verificada?",
        a: "Sí durante la transferencia, y cada archivo transferido se comprueba con SHA-256. sync decide qué enviar por tamaño y fecha de modificación, así que un archivo saltado no se vuelve a hashear. Que coincidan los tamaños de directorio es una comprobación de cordura, no una prueba de que el contenido saltado siga coincidiendo.",
      },
      {
        q: "¿Qué pasa si la tarea cron se interrumpe a mitad de camino?",
        a: "Depende de qué comando hayas programado. sync continúa: la siguiente ejecución se salta lo que ya coincide y sigue con un archivo parcial, y --no-resume desactiva eso. push no reanuda: rechaza un destino que ya existe, así que para ejecuciones repetidas programa sync o haz push a un destino nuevo en cada ejecución. --no-resume se acepta en push y no hace nada.",
      },
      {
        q: "¿Puede --delete vaciar mi destino por accidente?",
        a: "sync se niega a ejecutarse con --delete si el directorio de origen no contiene ningún archivo, y el receptor tiene que iniciarse con serve --allow-delete para que los borrados surtan efecto siquiera; de lo contrario se omiten y se te informa de ello.",
      },
      {
        q: "¿Necesito una cuenta o esto cuesta algo?",
        a: "No. La CLI es gratis y push/sync con daemon directo no necesita cuenta de Relayium ni pago por transferencia.",
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
    "Este guia aborda como agendar o relayium push e o relayium sync incremental pelo cron, o transporte daemon direto que ambos usam e as linhas de crontab para copiar.",
  ],
  sections: [
    {
      heading: "push versus sync: cópia completa ou espelho incremental",
      body: [
        "Tanto push quanto sync movem um diretório para outra máquina e ambos são seguros para rodar repetidamente, mas resolvem problemas de backup um pouco diferentes.",
        "O push faz uma cópia pontual com daemon direto, segura contra colisões, e recusa um destino existente em vez de sobrescrever ou retomar — por isso não serve para uma tarefa repetida apontada para um diretório de recebimento fixo. Já o sync mantém um destino como espelho incremental de mão única da origem: arquivos inalterados são pulados, os alterados são enviados e um arquivo parcial continua na próxima execução. Por ser um espelho, ele reflete o estado atual e não o histórico: apagar ou corromper um arquivo na origem pode ser propagado.",
      ],
      bullets: [
        "Use push para um destino com data quando quiser que cada execução seja independente e que as cópias anteriores sobrevivam.",
        "Use sync para um diretório grande ou que muda com frequência, onde reenviar tudo toda noite seria desperdício.",
        "Ambos verificam cada arquivo transferido com SHA-256. O push não retoma; o sync continua um arquivo parcial em uma execução posterior.",
      ],
    },
    {
      heading: "Um só transporte: daemon-direct",
      body: [
        "Aponte qualquer um dos dois comandos para um destino relayium:// cuja máquina de destino rode relayium serve. Destinos SSH foram descontinuados.",
      ],
      code: [
        "# daemon-direct: o destino roda \"relayium serve\"\nrelayium push ./data relayium://backup-server:9031",
      ],
      bullets: [
        "As conexões daemon-direct usam TLS 1.3 fixado com confiança no primeiro uso e, depois, são verificadas contra essa mesma impressão digital em todas as execuções seguintes.",
        "O sync aceita a mesma forma de destino relayium:// que o push.",
      ],
    },
    {
      heading: "Agende com o cron",
      prereqs: {
        label: "O que você precisa antes do passo 1",
        items: [
          "A CLI nas duas máquinas, com relayium serve rodando no destino.",
          "Um destino rodando relayium serve com este remetente pré-autorizado. O cron não tem terminal, então uma impressão digital desconhecida é recusada em vez de gerar uma pergunta.",
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
          text: "Confirme que o receptor está acessível e que este remetente já foi autorizado.",
          code: ["relayium id"],
        },
        {
          text: "Rode o comando inteiro à mão uma vez, escrito exatamente como o cron vai rodar, caminho absoluto incluído.",
          code: ["/usr/local/bin/relayium sync ~/documents relayium://backup-server:9031"],
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
          "O relayium resolve para um caminho absoluto que você pode colar no crontab, e um sync com daemon direto rodado à mão termina com 0 sem pedir para autorizar um remetente desconhecido. Uma cópia que só funciona depois de uma aprovação interativa ainda não está agendada.",
        ],
        code: [
          "$ command -v relayium\n/usr/local/bin/relayium\n$ /usr/local/bin/relayium sync ~/documents relayium://backup-server:9031\n$ echo $?\n0",
        ],
      },
      body: [
        "Com o remetente pré-autorizado, o sync é um único comando não interativo que entra direto no crontab. Registre a saída em log para que as falhas fiquem visíveis:",
      ],
      code: [
        "# espelho incremental a cada 15 minutos\n*/15 * * * * relayium sync ~/documents relayium://backup-server:9031 >> ~/relayium-sync.log 2>&1",
      ],
      bullets: [
        "O comando termina com código diferente de zero se algum arquivo falhar na verificação de integridade, então o aviso por e-mail em caso de falha do cron detecta os problemas.",
        "Um sync interrompido se atualiza na próxima execução agendada: o que já corresponde é pulado e um arquivo parcial continua.",
      ],
    },
    {
      heading: "Espelhar exclusões e sincronização em tempo real",
      body: [
        "Por padrão, o sync apenas adiciona ou atualiza arquivos no destino. Adicione --delete para torná-lo um espelho de verdade, que também remove os arquivos que a origem não tem mais — o lado receptor precisa estar escutando explicitamente com serve --allow-delete, ou as exclusões são silenciosamente ignoradas e reportadas de volta como negadas. O sync também recusa --delete de imediato se o diretório de origem não resolver em nenhum arquivo, de modo que um erro de digitação no caminho de origem não pode apagar o destino.",
        "Se você preferir não esperar o próximo ciclo do cron, --watch mantém o relayium sync em execução e sincroniza novamente de forma automática logo após qualquer arquivo sob a origem mudar — uma alternativa leve à sondagem agendada.",
      ],
      bullets: [
        "relayium sync ./data relayium://backup-server:9031 --delete espelha as exclusões (o receptor precisa de serve --allow-delete).",
        "relayium sync ./data relayium://backup-server:9031 --watch permanece em execução e sincroniza novamente a cada mudança, em vez de rodar uma única vez pelo cron.",
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
            symptom: "O log mostra “SSH transfers are currently disabled”, ou nada depois da primeira execução.",
            code: [
              "grep -i \"SSH transfers\" ~/relayium-sync.log\n# SSH transfers are currently disabled. Use relayium pair, or relayium serve with push/sync to relayium://host.",
            ],
            fix: "O comando agendado ainda aponta para um destino SSH antigo, e as transferências por SSH foram descontinuadas. Rode relayium serve no servidor de backup, autorize lá a impressão digital do relayium id desta máquina e mude o alvo para relayium://backup-server — chave SSH, agente e frase-senha não entram mais na história.",
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
              "relayium sync ~/documents relayium://backup-server:9031 --delete\n# refusing --delete with an empty source: this would delete everything on the destination. Check the path(s).",
            ],
            fix: "A origem não resolveu nenhum arquivo, então o espelho teria esvaziado o destino. Essa recusa é proposital. Verifique o caminho por causa de um erro de digitação, e verifique se o que deveria estar montado ali está montado na hora em que o cron dispara, e não só quando você está logado.",
          },
          {
            symptom: "O backup roda, sai com 0, e não é o que você pensa.",
            code: [
              `ssh user@backup-server command -v relayium`,
            ],
            fix: "O push e o sync atuais exigem um receptor do Relayium. Instale a CLI no destino, inicie o serve, autorize o remetente e use um alvo relayium://; não existe transporte alternativo silencioso.",
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
        a: "Sim. O push e o sync atuais usam o protocolo nativo daemon direto e exigem relayium serve no destino. Não há alternativa com SSH nem com tar.",
      },
      {
        q: "O backup é criptografado e verificado?",
        a: "Sim durante a transferência, e cada arquivo transferido é conferido com SHA-256. O sync decide o que enviar por tamanho e data de modificação, então um arquivo pulado não é re-hasheado. Tamanhos de diretório iguais são uma checagem de sanidade, não prova de que o conteúdo pulado ainda corresponde.",
      },
      {
        q: "O que acontece se a tarefa cron for interrompida no meio?",
        a: "Depende de qual comando você agendou. O sync continua: a próxima execução pula o que já corresponde e leva adiante um arquivo parcial, e o --no-resume desliga isso. O push não retoma — ele recusa um destino que já existe; para execuções repetidas, agende o sync ou faça push para um destino novo a cada execução. O --no-resume é aceito pelo push e não faz nada.",
      },
      {
        q: "O --delete pode apagar meu destino por acidente?",
        a: "O sync se recusa a rodar com --delete se o diretório de origem não contiver nenhum arquivo, e o receptor precisa ser iniciado com serve --allow-delete para que as exclusões tenham efeito — caso contrário, elas são ignoradas e reportadas a você.",
      },
      {
        q: "Preciso de uma conta ou isso custa alguma coisa?",
        a: "Não. A CLI é gratuita e push/sync com daemon direto não precisa de conta do Relayium nem de pagamento por transferência.",
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

const currentEn = {
  title: "Automate server copies with Relayium daemon-direct",
  description: "Schedule relayium sync against an authorized relayium:// listener. SSH destinations, pull, -i and -p are retired.",
  updatedLabel: "Last updated",
  lead: ["For repeated unattended copies, run relayium serve on the receiver and schedule sync from the sender. Current Relayium does not use SSH as a transfer transport.", "This creates a current-state mirror, not a versioned backup. Add snapshots or another history layer if you need point-in-time restore."],
  sections: [
    { heading: "Prepare the receiver", code: ["mkdir -p /srv/backups", "relayium authorize <sender-fingerprint>", "relayium serve --dir /srv/backups --bind 10.0.0.12"], bullets: ["Use the same --config-dir for authorize and serve.", "Run serve under your service manager for restarts.", "Restrict the listener with --bind and a firewall."] },
    { heading: "Schedule the sender", body: ["Use an absolute binary path and redirect output so failures are visible."], code: ["command -v relayium", "0 2 * * * /usr/local/bin/relayium sync /srv/data relayium://backup-server:9031 >> /var/log/relayium-sync.log 2>&1"], bullets: ["Run the exact command by hand before installing the schedule.", "Alert on a non-zero exit and inspect the log after the first scheduled run."] },
    { heading: "Choose deletion and retention deliberately", body: ["Without --delete, sync adds and updates. With --delete, source deletions are mirrored only when serve was started with --allow-delete."], bullets: ["A mirror keeps no old versions.", "A corrupted or deleted source can be propagated on the next run.", "Use destination snapshots when recovery history matters."] },
  ],
  faq: { heading: "Frequently asked questions", items: [
    { q: "Can the cron command use an SSH destination?", a: "No. Current sync accepts relayium:// destinations only; -i and -p are retired." },
    { q: "Does automation need a Relayium account?", a: "No. daemon-direct serve and sync use local fingerprint authorization, separate from Relayium accounts." },
    { q: "Will sync resume after a failed run?", a: "It skips unchanged files and can continue a partial file on the next run. Permanent failures still need operator attention." },
  ] },
  cta: { text: "Automate a monitored daemon-direct mirror.", button: "Get the CLI", href: "/cli" },
  relatedHeading: "Keep reading",
};
const currentZh = {
  title: "用 Relayium daemon 直连自动复制服务器数据",
  description: "定时向已授权的 relayium:// 监听端运行 relayium sync。SSH 目标、pull、-i 与 -p 已退役。",
  updatedLabel: "最近更新",
  lead: ["反复无人值守复制时，在接收端运行 relayium serve，并在发送端定时执行 sync。当前 Relayium 不再把 SSH 当作传输通道。", "这会生成当前状态镜像，不是带版本的备份。需要按时间点恢复时，请增加快照或其他历史层。"],
  sections: [
    { heading: "准备接收端", code: ["mkdir -p /srv/backups", "relayium authorize <sender-fingerprint>", "relayium serve --dir /srv/backups --bind 10.0.0.12"], bullets: ["authorize 与 serve 使用同一个 --config-dir。", "用服务管理器托管 serve，以便崩溃或重启后恢复。", "用 --bind 和防火墙限制监听端。"] },
    { heading: "定时运行发送端", body: ["使用二进制绝对路径并重定向输出，让故障可见。"], code: ["command -v relayium", "0 2 * * * /usr/local/bin/relayium sync /srv/data relayium://backup-server:9031 >> /var/log/relayium-sync.log 2>&1"], bullets: ["安装定时任务前，先手动运行完全相同的命令。", "对非零退出报警，并在第一次定时运行后检查日志。"] },
    { heading: "明确选择删除与留存", body: ["不加 --delete 时，sync 只新增和更新；加上后，只有 serve 以 --allow-delete 启动才会传播源端删除。"], bullets: ["镜像不保留旧版本。", "源端损坏或删除可能在下一次运行中传播。", "需要恢复历史时使用目标端快照。"] },
  ],
  faq: { heading: "常见问题", items: [
    { q: "cron 命令可以使用 SSH 目标吗？", a: "不可以。当前 sync 只接受 relayium:// 目标；-i 与 -p 已退役。" },
    { q: "自动任务需要 Relayium 账号吗？", a: "不需要。daemon 直连 serve 与 sync 使用本机指纹授权，与 Relayium 账号分离。" },
    { q: "sync 会在失败后续传吗？", a: "它会跳过未变化文件，并能在下一次运行继续半截文件。永久故障仍需要人工处理。" },
  ] },
  cta: { text: "自动运行可监控的 daemon 直连镜像。", button: "获取 CLI", href: "/cli" },
  relatedHeading: "继续阅读",
};

export default {
  slug: "how-to/automate-server-backups",
  published: "2026-07-09",
  updated: "2026-09-01",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
