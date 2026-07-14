// web/scripts/pages/content/articles/howto-automate-server-backups.mjs
// How-to: schedule relayium push / sync from cron for automated encrypted backups.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Automate encrypted server backups with a cron job",
  description:
    "Schedule relayium push or sync from cron to copy a directory to another server automatically — encrypted, resumable, SHA-256-verified, and free to run as often as you like.",
  updatedLabel: "Last updated",
  lead: [
    "Back ups you have to remember to run don't happen. Cron does remember, and the Relayium CLI is built for that: a single non-interactive command that copies (or mirrors) a directory to another machine, verifies every file, and picks up where it left off if the network drops.",
    "This guide covers scheduling relayium push and the incremental relayium sync from cron, the two transports you can point either one at, and the crontab lines to copy.",
  ],
  sections: [
    {
      heading: "push vs sync: full copy or incremental mirror",
      body: [
        "Both push and sync move a directory to another machine and both are safe to run repeatedly, but they solve slightly different backup problems.",
        "push sends an SSH or daemon-direct copy each time you run it — simple, and it even works against a bare server with no relayium installed via a tar fallback. sync instead keeps the destination as an incremental one-way mirror of the source: only changed files are re-sent, so a nightly sync of a large directory after the first run is fast. sync always needs relayium's native protocol on both ends — it has no tar fallback.",
      ],
      bullets: [
        "Use push for a straightforward scheduled copy, especially to a server that might not have relayium installed.",
        "Use sync for a large or frequently-changing directory where re-sending everything every night would be wasteful.",
        "Both are per-file SHA-256 verified and resumable if interrupted.",
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
      body: [
        "Both push and sync are single, non-interactive commands, so they drop straight into a crontab. Point them at an SSH key with no passphrase (or an agent), and log the output so failures are visible:",
      ],
      code: [
        `# full copy every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "The command exits non-zero if any file fails its integrity check, so cron's mail-on-failure catches problems.",
        "An interrupted run simply resumes or catches up on the next scheduled run.",
      ],
    },
    {
      heading: "Mirroring deletions and real-time sync",
      body: [
        "By default sync only ever adds or updates files at the destination. Add --delete to make it a true mirror that also removes files the source no longer has — the receiving side must be explicitly listening with serve --allow-delete, or the deletions are silently skipped and reported back as denied. sync also refuses --delete outright if the source directory resolves to no files, so a typo in the source path can't wipe the destination.",
        "If you'd rather not wait for cron's next tick, --watch keeps relayium sync running and re-syncs automatically a moment after any file under the source changes — a lightweight alternative to polling on a schedule.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete mirrors deletions (receiver needs serve --allow-delete).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch stays running and re-syncs on change instead of running once from cron.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the backup server need relayium installed?",
        a: "It depends on the command. push works either way: with relayium installed it uses the native protocol (resume + SHA-256 per file); without it, push falls back to a plain tar stream over SSH, so a bare server still works. sync always needs relayium's native protocol on the remote — there's no tar fallback for sync, so install it there first.",
      },
      {
        q: "Is the backup encrypted and verified?",
        a: "Yes. Every file is checked with a SHA-256 hash end to end, and pushing over SSH or daemon-direct means the bytes are already protected by that connection's encryption — nothing extra to configure.",
      },
      {
        q: "What happens if the cron job is interrupted halfway through?",
        a: "With relayium on both ends, the next scheduled run resumes partial files instead of resending everything. Pass --no-resume if you ever want a clean full re-send instead.",
      },
      {
        q: "Can --delete accidentally wipe my destination?",
        a: "sync refuses to run with --delete if the source directory contains no files, and the receiver has to be started with serve --allow-delete for deletions to take effect at all — otherwise they're skipped and reported back to you.",
      },
      {
        q: "Do I need an account or does this cost anything?",
        a: "No. The CLI is free and needs no account for push, pull, or sync — the transfer runs over your own SSH connection or a direct daemon connection, not through Relayium's servers.",
      },
    ],
  },
  cta: {
    text: "Put your backups on a schedule you don't have to remember — encrypted, resumable, and free.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 cron 任务自动化加密的服务器备份",
  description:
    "在 cron 中定时运行 relayium push 或 sync,按计划自动把目录复制到另一台服务器——加密传输、支持断点续传、SHA-256 校验,而且完全免费。",
  updatedLabel: "最近更新",
  lead: [
    "需要你记得手动运行的备份,常常就不会发生。cron 会记得,而 Relayium CLI 正是为此而生:一条非交互式命令,把目录复制(或镜像)到另一台机器,校验每一个文件,并且在网络中断时从断点继续。",
    "本文介绍如何用 cron 定时运行 relayium push 和增量的 relayium sync、两者都能使用的两种传输方式,以及可以直接复制使用的 crontab 行。",
  ],
  sections: [
    {
      heading: "push 与 sync:整体复制还是增量镜像",
      body: [
        "push 和 sync 都能把一个目录传送到另一台机器,也都可以放心地反复运行,但它们解决的备份问题略有不同。",
        "每次运行 push 都会通过 SSH 或 daemon-direct 发送一份完整拷贝——简单直接,即使远端服务器没装 relayium,也能靠 tar 兜底方案工作。sync 则把目标目录维护成源目录的增量单向镜像:只重新发送发生变化的文件,所以对一个大目录做第一次同步之后,后续的夜间同步会很快。sync 始终需要两端都用 relayium 的原生协议——它没有 tar 兜底方案。",
      ],
      bullets: [
        "如果只是想做一次简单的定时复制,尤其是目标服务器可能没装 relayium,用 push。",
        "如果目录很大或经常变化,每晚重新发送全部内容会很浪费,用 sync。",
        "两者都会对每个文件做 SHA-256 校验,中断后也能续传。",
      ],
    },
    {
      heading: "两种传输方式:SSH 或 daemon-direct",
      body: [
        "两个命令都可以指向一个 SSH 目标(scp 风格,使用你的 ~/.ssh/config),也可以在对方机器运行着 relayium serve 时,直接通过 daemon-direct 协议连接过去——不需要 SSH。",
      ],
      code: [
        `# SSH destination — uses your existing SSH keys and config
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — the destination runs "relayium serve", no SSH required
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon-direct 连接使用带证书锁定的 TLS 1.3,首次连接时信任(trust-on-first-use),之后的每次运行都会校验同一个指纹。",
        "sync 接受和 push 相同的两种目标写法。",
      ],
    },
    {
      heading: "用 cron 定时运行",
      body: [
        "push 和 sync 都是单条非交互式命令,可以直接放进 crontab。给它指定一个没有口令的密钥(或者用 agent),并把输出记录下来以便查看失败:",
      ],
      code: [
        `# full copy every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "只要有文件未通过完整性校验,命令就会以非零状态退出,这样 cron 的失败邮件通知就能发现问题。",
        "被中断的一次运行,会在下一次计划运行时自动续传或补上进度。",
      ],
    },
    {
      heading: "镜像删除与实时同步",
      body: [
        "默认情况下,sync 只会在目标端新增或更新文件。加上 --delete 就会变成真正的镜像,把源目录中已经不存在的文件也从目标端删除——接收端必须显式以 serve --allow-delete 方式监听,否则这些删除操作会被静默跳过,并在结果里报告为被拒绝。如果源目录解析不到任何文件,sync 也会直接拒绝执行 --delete,这样源路径写错也不会清空目标目录。",
        "如果不想等 cron 的下一个执行时间点,--watch 会让 relayium sync 持续运行,一旦源目录下有文件变化,就会在片刻之后自动重新同步——是按计划轮询之外的一种轻量替代方案。",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete 会镜像删除操作(接收端需要 serve --allow-delete)。",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch 会持续运行,有变化就同步,而不是靠 cron 单次触发。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "备份服务器需要装 relayium 吗?",
        a: "要看命令。push 不管远端有没有装都能用:装了 relayium 就用原生协议(断点续传 + 每个文件 SHA-256 校验);没装的话,push 会退回到通过 SSH 传输 tar 流,一台裸服务器也能用。sync 则始终需要远端有 relayium 的原生协议——sync 没有 tar 兜底方案,请先在远端装好它。",
      },
      {
        q: "备份会加密并校验吗?",
        a: "会。每个文件都会做端到端的 SHA-256 校验,而通过 SSH 或 daemon-direct 推送时,字节已经受该连接自身的加密保护——不需要额外配置。",
      },
      {
        q: "如果 cron 任务在执行到一半时被中断会怎样?",
        a: "只要两端都有 relayium,下一次计划运行就会续传未完成的文件,而不是重新发送全部内容。如果你想放弃续传、做一次干净的完整重发,加上 --no-resume 即可。",
      },
      {
        q: "--delete 会不会不小心清空我的目标目录?",
        a: "如果源目录里没有任何文件,sync 会直接拒绝执行 --delete;而且接收端必须以 serve --allow-delete 方式启动,删除操作才会真正生效——否则会被跳过,并把结果报告给你。",
      },
      {
        q: "需要账号吗,这个要收费吗?",
        a: "不需要。CLI 完全免费,push、pull、sync 都不需要账号——传输走的是你自己的 SSH 连接或直接的 daemon 连接,不经过 Relayium 的服务器。",
      },
    ],
  },
  cta: {
    text: "把备份放进一个你不用记得的日程里——加密传输、支持断点续传,而且免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "cron で暗号化されたサーバーバックアップを自動化する",
  description:
    "cron から relayium push または sync を定期実行して、ディレクトリを別のサーバーへ自動コピー——暗号化、再開可能、SHA-256 検証付きで、しかも無料です。",
  updatedLabel: "最終更新",
  lead: [
    "自分で覚えて実行しなければならないバックアップは、たいてい実行されません。cron は覚えていてくれますし、Relayium CLI はまさにそのために作られています。ディレクトリを別のマシンへコピー(またはミラー)し、すべてのファイルを検証し、ネットワークが切れても中断した所から再開する、単一の非対話型コマンドです。",
    "本ガイドでは、cron から relayium push と増分同期の relayium sync をスケジュール実行する方法、どちらでも使える2つの転送方式、そしてそのままコピーできる crontab の行を扱います。",
  ],
  sections: [
    {
      heading: "push と sync:全体コピーか増分ミラーか",
      body: [
        "push と sync はどちらもディレクトリを別のマシンへ転送し、どちらも繰り返し実行して安全ですが、解決するバックアップの課題は少し異なります。",
        "push は実行するたびに SSH または daemon-direct 経由で毎回コピーを送ります——シンプルで、relayium がインストールされていない素のサーバーに対しても tar フォールバックで動作します。一方 sync は宛先をソースの増分・一方向ミラーとして維持します。変更されたファイルだけを再送するので、大きなディレクトリでも最初の同期の後は夜間の同期が高速です。sync は常に両端で relayium のネイティブプロトコルを必要とします——tar フォールバックはありません。",
      ],
      bullets: [
        "relayium がインストールされていないかもしれないサーバーへの、シンプルなスケジュールコピーには push を使いましょう。",
        "大きい、あるいは頻繁に変化するディレクトリで、毎晩すべてを再送するのが無駄になる場合は sync を使いましょう。",
        "どちらもファイルごとに SHA-256 で検証され、中断されても再開できます。",
      ],
    },
    {
      heading: "2つの転送方式:SSH か daemon-direct か",
      body: [
        "どちらのコマンドも、SSH の宛先(scp 形式、あなたの ~/.ssh/config を使用)を指定できますし、相手のマシンで relayium serve が動いていれば、SSH なしで daemon-direct プロトコル経由で直接接続することもできます。",
      ],
      code: [
        `# SSH destination — uses your existing SSH keys and config
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — the destination runs "relayium serve", no SSH required
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon-direct 接続はピン留めされた TLS 1.3 で、初回接続時に信頼(trust-on-first-use)し、以降の実行では同じフィンガープリントに対して検証します。",
        "sync は push と同じ2つの宛先の書き方を受け付けます。",
      ],
    },
    {
      heading: "cron でスケジュール実行する",
      body: [
        "push と sync はどちらも単一の非対話型コマンドなので、そのまま crontab に組み込めます。パスフレーズなしの鍵(または agent)を指定し、出力をログに残して失敗を確認できるようにしましょう:",
      ],
      code: [
        `# full copy every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "いずれかのファイルが整合性チェックに失敗すると、コマンドは非ゼロで終了するので、cron の失敗時メール通知で問題に気づけます。",
        "中断された実行は、次の予定された実行で自動的に再開または追いつきます。",
      ],
    },
    {
      heading: "削除のミラーリングとリアルタイム同期",
      body: [
        "デフォルトでは、sync は宛先側でファイルを追加または更新するだけです。--delete を付けると真のミラーになり、ソースにもう存在しないファイルも削除します——受信側は serve --allow-delete で明示的に待ち受けている必要があり、そうでなければ削除は黙って無視され、拒否されたと結果に報告されます。ソースディレクトリが1つもファイルを解決しない場合、sync は --delete の実行そのものを拒否するので、ソースパスの誤字で宛先が消えてしまうことはありません。",
        "cron の次の実行タイミングを待ちたくない場合は、--watch を使うと relayium sync が動き続け、ソース配下のファイルが変化するとすぐに自動で再同期します——スケジュールでポーリングする代わりの軽量な選択肢です。",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete は削除もミラーします(受信側に serve --allow-delete が必要)。",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch は動き続けて変化のたびに同期します。cron による単発実行の代わりに使えます。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "バックアップサーバーに relayium のインストールは必要ですか?",
        a: "コマンドによります。push はどちらでも動作します。relayium がインストールされていればネイティブプロトコル(再開 + ファイルごとの SHA-256 検証)を使い、なければ push は SSH 上の tar ストリームにフォールバックするので、素のサーバーでも動作します。sync は常にリモート側で relayium のネイティブプロトコルが必要です——sync に tar フォールバックはないので、先にインストールしてください。",
      },
      {
        q: "バックアップは暗号化・検証されますか?",
        a: "されます。すべてのファイルはエンドツーエンドで SHA-256 ハッシュによって検証され、SSH または daemon-direct でプッシュする場合、バイトはその接続自体の暗号化によってすでに保護されています——追加の設定は不要です。",
      },
      {
        q: "cron ジョブが途中で中断された場合はどうなりますか?",
        a: "両端に relayium があれば、次の予定された実行で部分的なファイルが全体を再送するのではなく再開されます。きれいに全体を再送したい場合は --no-resume を指定してください。",
      },
      {
        q: "--delete で誤って宛先を消してしまうことはありますか?",
        a: "sync はソースディレクトリにファイルが1つもない場合、--delete の実行自体を拒否します。また、削除が実際に反映されるには受信側が serve --allow-delete で起動されている必要があります——そうでなければスキップされ、結果として報告されます。",
      },
      {
        q: "アカウントは必要ですか、これは有料ですか?",
        a: "いいえ。CLI は無料で、push、pull、sync のいずれにもアカウントは不要です。転送はあなた自身の SSH 接続、または直接の daemon 接続の上で行われ、Relayium のサーバーは経由しません。",
      },
    ],
  },
  cta: {
    text: "覚えておかなくていいスケジュールにバックアップを乗せましょう——暗号化、再開可能、そして無料です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "cron 작업으로 암호화된 서버 백업 자동화하기",
  description:
    "cron에서 relayium push나 sync를 예약 실행해 디렉터리를 다른 서버로 자동 복사하세요 — 암호화되고, 재개 가능하며, SHA-256으로 검증되고, 무료입니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "직접 기억해서 실행해야 하는 백업은 결국 실행되지 않습니다. cron은 기억해 주며, Relayium CLI는 바로 그 목적을 위해 만들어졌습니다: 디렉터리를 다른 머신으로 복사(또는 미러링)하고, 모든 파일을 검증하며, 네트워크가 끊기면 중단된 지점부터 이어가는 단일 비대화형 명령입니다.",
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
        "둘 다 파일별로 SHA-256 검증을 하며, 중단되어도 재개할 수 있습니다.",
      ],
    },
    {
      heading: "두 가지 전송 방식: SSH 또는 daemon-direct",
      body: [
        "두 명령 모두 SSH 대상(scp 형식, 당신의 ~/.ssh/config 사용)을 지정할 수도 있고, 상대 머신에서 relayium serve가 실행 중이라면 SSH 없이 daemon-direct 프로토콜로 곧장 연결할 수도 있습니다.",
      ],
      code: [
        `# SSH destination — uses your existing SSH keys and config
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — the destination runs "relayium serve", no SSH required
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon-direct 연결은 고정된(pinned) TLS 1.3을 사용하며, 처음 연결할 때 신뢰(trust-on-first-use)하고 이후 실행부터는 같은 지문(fingerprint)에 대해 검증합니다.",
        "sync는 push와 동일한 두 가지 대상 표기법을 받아들입니다.",
      ],
    },
    {
      heading: "cron으로 예약 실행하기",
      body: [
        "push와 sync는 둘 다 단일 비대화형 명령이므로, 그대로 crontab에 넣을 수 있습니다. 암호 없는 키(또는 agent)를 지정하고, 출력을 로그로 남겨 실패를 확인할 수 있게 하세요:",
      ],
      code: [
        `# full copy every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "무결성 검사에 실패한 파일이 하나라도 있으면 명령이 0이 아닌 상태로 종료되므로, cron의 실패 시 메일 알림으로 문제를 발견할 수 있습니다.",
        "중단된 실행은 다음 예약된 실행에서 자동으로 재개되거나 따라잡습니다.",
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
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "백업 서버에 relayium이 설치되어 있어야 하나요?",
        a: "명령에 따라 다릅니다. push는 어느 쪽이든 동작합니다: relayium이 설치되어 있으면 네이티브 프로토콜(재개 + 파일별 SHA-256 검사)을 사용하고, 없으면 push는 SSH를 통한 일반 tar 스트림으로 대체되어 순수한 서버에서도 동작합니다. sync는 항상 원격지에 relayium의 네이티브 프로토콜이 필요합니다 — sync에는 tar 대체 방식이 없으므로 먼저 그곳에 설치하세요.",
      },
      {
        q: "백업이 암호화되고 검증되나요?",
        a: "네. 모든 파일은 종단간 SHA-256 해시로 검사되며, SSH나 daemon-direct로 푸시할 때 바이트는 이미 해당 연결 자체의 암호화로 보호됩니다 — 추가로 설정할 것이 없습니다.",
      },
      {
        q: "cron 작업이 중간에 중단되면 어떻게 되나요?",
        a: "양쪽에 relayium이 있으면, 다음 예약된 실행이 전체를 다시 보내는 대신 부분 파일을 재개합니다. 깔끔하게 전체를 다시 보내고 싶다면 --no-resume을 넘기세요.",
      },
      {
        q: "--delete가 실수로 대상을 지워버릴 수 있나요?",
        a: "소스 디렉터리에 파일이 하나도 없으면 sync는 --delete 실행 자체를 거부합니다. 또한 삭제가 실제로 적용되려면 수신 측이 serve --allow-delete로 시작되어 있어야 합니다 — 그렇지 않으면 건너뛰어지고 결과로 보고됩니다.",
      },
      {
        q: "계정이 필요한가요, 비용이 드나요?",
        a: "아니요. CLI는 무료이며 push, pull, sync 모두 계정이 필요 없습니다. 전송은 당신 자신의 SSH 연결이나 직접적인 daemon 연결을 통해 이루어지며, Relayium의 서버를 거치지 않습니다.",
      },
    ],
  },
  cta: {
    text: "기억할 필요 없는 일정에 백업을 올려두세요 — 암호화되고, 재개 가능하며, 무료입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Verschlüsselte Server-Backups mit einem Cron-Job automatisieren",
  description:
    "Plane relayium push oder sync per cron, um ein Verzeichnis automatisch auf einen anderen Server zu kopieren — verschlüsselt, fortsetzbar, mit SHA-256-Prüfung und kostenlos.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Backups, an die man selbst denken muss, passieren am Ende nicht. cron denkt daran, und die Relayium CLI ist genau dafür gebaut: ein einzelner, nicht-interaktiver Befehl, der ein Verzeichnis auf eine andere Maschine kopiert (oder spiegelt), jede Datei prüft und dort weitermacht, wo er aufgehört hat, falls das Netzwerk abbricht.",
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
        "Beide werden je Datei per SHA-256 geprüft und lassen sich bei einer Unterbrechung fortsetzen.",
      ],
    },
    {
      heading: "Zwei Übertragungswege: SSH oder daemon-direct",
      body: [
        "Richte beide Befehle entweder auf ein SSH-Ziel (im scp-Stil, unter Verwendung deiner ~/.ssh/config) oder, falls die andere Maschine relayium serve ausführt, direkt über das daemon-direct-Protokoll — ganz ohne SSH.",
      ],
      code: [
        `# SSH destination — uses your existing SSH keys and config
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — the destination runs "relayium serve", no SSH required
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "daemon-direct-Verbindungen nutzen gepinntes TLS 1.3 mit Trust-on-first-use und werden danach bei jedem weiteren Lauf gegen genau diesen Fingerabdruck geprüft.",
        "sync akzeptiert dieselben zwei Zielformen wie push.",
      ],
    },
    {
      heading: "Per cron planen",
      body: [
        "push und sync sind beide einzelne, nicht-interaktive Befehle, die sich direkt in eine crontab einsetzen lassen. Verweise auf einen Schlüssel ohne Passphrase (oder einen Agent) und protokolliere die Ausgabe, damit Fehlschläge sichtbar werden:",
      ],
      code: [
        `# full copy every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "Der Befehl endet mit einem Exit-Code ungleich null, wenn eine Datei ihre Integritätsprüfung nicht besteht, sodass crons Mail-bei-Fehlschlag das Problem auffängt.",
        "Ein unterbrochener Lauf setzt beim nächsten geplanten Lauf einfach fort oder holt auf.",
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
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss auf dem Backup-Server relayium installiert sein?",
        a: "Das hängt vom Befehl ab. push funktioniert so oder so: Mit installiertem relayium nutzt es das native Protokoll (Fortsetzen + SHA-256 je Datei); ohne weicht push auf einen einfachen Tar-Stream über SSH aus, sodass auch ein nackter Server funktioniert. sync braucht auf der Gegenseite immer das native Protokoll von relayium — für sync gibt es keinen Tar-Fallback, installiere es also dort zuerst.",
      },
      {
        q: "Ist das Backup verschlüsselt und geprüft?",
        a: "Ja. Jede Datei wird Ende-zu-Ende mit einem SHA-256-Hash geprüft, und beim Push per SSH oder daemon-direct sind die Bytes bereits durch die Verschlüsselung dieser Verbindung geschützt — es ist nichts zusätzlich zu konfigurieren.",
      },
      {
        q: "Was passiert, wenn der cron-Job mittendrin unterbrochen wird?",
        a: "Mit relayium auf beiden Seiten setzt der nächste geplante Lauf Teildateien fort, statt alles neu zu senden. Übergib --no-resume, wenn du stattdessen einen sauberen, vollständigen Neuversand willst.",
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
    text: "Bring deine Backups auf einen Zeitplan, an den du nicht denken musst — verschlüsselt, fortsetzbar und kostenlos.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Automatiser les sauvegardes serveur chiffrées avec une tâche cron",
  description:
    "Planifiez relayium push ou sync via cron pour copier automatiquement un répertoire vers un autre serveur — chiffré, reprenable, vérifié par SHA-256, et gratuit.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Les sauvegardes qu'il faut penser à lancer soi-même finissent par ne pas être faites. cron, lui, s'en souvient, et la CLI Relayium est conçue pour ça : une seule commande non interactive qui copie (ou met en miroir) un répertoire vers une autre machine, vérifie chaque fichier, et reprend là où elle s'est arrêtée si le réseau coupe.",
    "Ce guide couvre la planification de relayium push et du relayium sync incrémental via cron, les deux modes de transport que l'un comme l'autre peuvent utiliser, et des lignes de crontab prêtes à copier.",
  ],
  sections: [
    {
      heading: "push ou sync : copie complète ou miroir incrémental",
      body: [
        "push et sync déplacent tous deux un répertoire vers une autre machine, et tous deux peuvent être exécutés sans risque de façon répétée, mais ils résolvent des problèmes de sauvegarde légèrement différents.",
        "push envoie une copie via SSH ou daemon-direct à chaque exécution — simple, et cela fonctionne même contre un serveur nu sans relayium installé grâce à un repli tar. sync, lui, maintient la destination comme un miroir incrémental et unidirectionnel de la source : seuls les fichiers modifiés sont renvoyés, si bien qu'une synchronisation nocturne d'un grand répertoire est rapide après la première exécution. sync a toujours besoin du protocole natif de relayium des deux côtés — il n'a pas de repli tar.",
      ],
      bullets: [
        "Utilisez push pour une copie planifiée simple, surtout vers un serveur qui pourrait ne pas avoir relayium installé.",
        "Utilisez sync pour un répertoire volumineux ou qui change souvent, où tout renvoyer chaque nuit serait un gaspillage.",
        "Les deux sont vérifiés par SHA-256 fichier par fichier et reprenables en cas d'interruption.",
      ],
    },
    {
      heading: "Deux modes de transport : SSH ou daemon-direct",
      body: [
        "Pointez l'une ou l'autre commande vers une destination SSH (style scp, en utilisant votre ~/.ssh/config) ou, si l'autre machine exécute relayium serve, directement vers elle via le protocole daemon-direct — sans SSH.",
      ],
      code: [
        `# SSH destination — uses your existing SSH keys and config
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — the destination runs "relayium serve", no SSH required
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "Les connexions daemon-direct utilisent du TLS 1.3 épinglé avec confiance à la première utilisation (trust-on-first-use), puis sont vérifiées contre cette même empreinte à chaque exécution suivante.",
        "sync accepte les deux mêmes formes de destination que push.",
      ],
    },
    {
      heading: "Le planifier avec cron",
      body: [
        "push et sync sont tous deux des commandes uniques et non interactives, elles s'intègrent donc directement dans une crontab. Pointez-les vers une clé sans phrase de passe (ou vers un agent), et journalisez la sortie pour repérer les échecs :",
      ],
      code: [
        `# full copy every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "La commande se termine avec un code non nul si un fichier échoue à sa vérification d'intégrité, si bien que la notification par e-mail en cas d'échec de cron détecte les problèmes.",
        "Une exécution interrompue reprend simplement ou rattrape son retard à la prochaine exécution planifiée.",
      ],
    },
    {
      heading: "Mettre en miroir les suppressions et synchroniser en temps réel",
      body: [
        "Par défaut, sync ne fait qu'ajouter ou mettre à jour des fichiers du côté destination. Ajoutez --delete pour en faire un véritable miroir qui supprime aussi les fichiers que la source n'a plus — le côté récepteur doit explicitement écouter avec serve --allow-delete, sinon les suppressions sont silencieusement ignorées et signalées comme refusées. sync refuse aussi purement et simplement --delete si le répertoire source ne résout aucun fichier, si bien qu'une faute de frappe dans le chemin source ne peut pas vider la destination.",
        "Si vous préférez ne pas attendre le prochain passage de cron, --watch garde relayium sync en cours d'exécution et resynchronise automatiquement peu après qu'un fichier sous la source change — une alternative légère au sondage sur un calendrier.",
      ],
      bullets: [
        "relayium sync ./data user@backup-server:/srv/backups/ --delete met en miroir les suppressions (le récepteur a besoin de serve --allow-delete).",
        "relayium sync ./data user@backup-server:/srv/backups/ --watch reste en cours d'exécution et resynchronise à chaque changement, au lieu d'une exécution unique via cron.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Le serveur de sauvegarde a-t-il besoin de relayium installé ?",
        a: "Cela dépend de la commande. push fonctionne dans les deux cas : avec relayium installé, il utilise le protocole natif (reprise + vérification SHA-256 par fichier) ; sans, push bascule sur un simple flux tar via SSH, si bien qu'un serveur nu fonctionne quand même. sync a toujours besoin du protocole natif de relayium côté distant — il n'y a pas de repli tar pour sync, installez-le donc là-bas au préalable.",
      },
      {
        q: "La sauvegarde est-elle chiffrée et vérifiée ?",
        a: "Oui. Chaque fichier est vérifié de bout en bout par un hachage SHA-256, et en poussant via SSH ou daemon-direct, les octets sont déjà protégés par le chiffrement propre à cette connexion — rien à configurer en plus.",
      },
      {
        q: "Que se passe-t-il si la tâche cron est interrompue en cours de route ?",
        a: "Avec relayium des deux côtés, la prochaine exécution planifiée reprend les fichiers partiels au lieu de tout renvoyer. Passez --no-resume si vous voulez plutôt un renvoi complet et propre.",
      },
      {
        q: "--delete peut-il vider ma destination par accident ?",
        a: "sync refuse de s'exécuter avec --delete si le répertoire source ne contient aucun fichier, et le récepteur doit être démarré avec serve --allow-delete pour que les suppressions prennent effet — sinon elles sont ignorées et vous sont signalées.",
      },
      {
        q: "Ai-je besoin d'un compte, est-ce payant ?",
        a: "Non. La CLI est gratuite et ne nécessite aucun compte pour push, pull ou sync — le transfert passe par votre propre connexion SSH ou une connexion daemon directe, pas par les serveurs de Relayium.",
      },
    ],
  },
  cta: {
    text: "Mettez vos sauvegardes sur un calendrier que vous n'avez pas à retenir — chiffré, reprenable et gratuit.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "أتمتة النسخ الاحتياطي المُشفَّر للخادم باستخدام مهمة cron",
  description:
    "جدوِل relayium push أو sync عبر cron لنسخ مجلد إلى خادم آخر تلقائيًا — مُشفَّر، قابل للاستئناف، مُتحقَّق منه بـ SHA-256، ومجاني لتشغيله بأي وتيرة تشاء.",
  updatedLabel: "آخر تحديث",
  lead: [
    "النسخ الاحتياطي الذي عليك أن تتذكر تشغيله لا يحدث. أما cron فيتذكر، وواجهة Relayium CLI مبنية لذلك: أمر واحد غير تفاعلي ينسخ (أو يعكس) مجلدًا إلى جهاز آخر، ويتحقق من كل ملف، ويكمل من حيث توقف إذا انقطعت الشبكة.",
    "يغطي هذا الدليل جدولة relayium push و relayium sync التزايدي عبر cron، ووسيلتَي النقل اللتين يمكن توجيه أيٍّ منهما إليهما، وأسطر crontab الجاهزة للنسخ.",
  ],
  sections: [
    {
      heading: "push مقابل sync: نسخة كاملة أم مرآة تزايدية",
      body: [
        "كلٌّ من push و sync ينقل مجلدًا إلى جهاز آخر، وكلاهما آمن للتشغيل المتكرر، لكنهما يحلّان مشكلتَي نسخ احتياطي مختلفتَين قليلًا.",
        "يرسل push نسخة عبر SSH أو daemon-direct في كل مرة تُشغّله — بسيط، بل ويعمل حتى مع خادم مجرّد لا يوجد عليه relayium عبر بديل tar. أما sync فيُبقي الوجهة كمرآة تزايدية أحادية الاتجاه للمصدر: تُعاد فقط الملفات المتغيرة، فتصبح مزامنة ليلية لمجلد كبير سريعة بعد التشغيل الأول. يحتاج sync دائمًا إلى بروتوكول relayium الأصلي على الطرفين — ولا يوجد لديه بديل tar.",
      ],
      bullets: [
        "استخدم push لنسخة مجدولة مباشرة، خاصةً إلى خادم قد لا يكون relayium مثبتًا عليه.",
        "استخدم sync لمجلد كبير أو كثير التغير حيث تكون إعادة إرسال كل شيء كل ليلة إهدارًا.",
        "كلاهما مُتحقَّق منه بـ SHA-256 لكل ملف وقابل للاستئناف إذا قُطع.",
      ],
    },
    {
      heading: "وسيلتا نقل: SSH أو daemon-direct",
      body: [
        "وجِّه أيًّا من الأمرين إلى وجهة SSH (بأسلوب scp، باستخدام ~/.ssh/config الخاص بك)، أو إذا كان الجهاز الآخر يشغّل relayium serve، فمباشرةً إليه عبر بروتوكول daemon-direct — دون حاجة إلى SSH.",
      ],
      code: [
        `# SSH destination — uses your existing SSH keys and config
relayium push ./data user@backup-server:/srv/backups/

# daemon-direct — the destination runs "relayium serve", no SSH required
relayium push ./data relayium://backup-server:9031`,
      ],
      bullets: [
        "اتصالات daemon-direct مثبَّتة على TLS 1.3 مع الثقة عند الاستخدام الأول، ثم تُثبَّت على تلك البصمة في كل تشغيل لاحق.",
        "يقبل sync الشكلين نفسيهما للوجهة كما يقبلهما push.",
      ],
    },
    {
      heading: "جدولته باستخدام cron",
      body: [
        "كلٌّ من push و sync أمر واحد غير تفاعلي، فيندرج مباشرةً في crontab. وجِّهه إلى مفتاح SSH بلا عبارة مرور (أو إلى وكيل)، وسجِّل المُخرجات لتظهر حالات الفشل:",
      ],
      code: [
        `# full copy every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-backup.log 2>&1

# incremental mirror every 15 minutes instead
*/15 * * * * relayium sync -i ~/.ssh/backup_key ~/documents user@backup-server:/srv/backups/ >> ~/relayium-sync.log 2>&1`,
      ],
      bullets: [
        "يخرج الأمر بحالة غير صفرية إذا فشل أي ملف في فحص سلامته، فتلتقط رسالة cron عند الفشل المشكلات.",
        "التشغيل المُقاطَع يستأنف ببساطة أو يلحق بالركب في التشغيل المُجدوَل التالي.",
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
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يحتاج خادم النسخ الاحتياطي إلى تثبيت relayium؟",
        a: "يعتمد على الأمر. يعمل push في كلتا الحالتين: مع تثبيت relayium يستخدم البروتوكول الأصلي (الاستئناف + SHA-256 لكل ملف)؛ ومن دونه، يتراجع push إلى تدفق tar عادي عبر SSH، فيعمل حتى الخادم المجرّد. أما sync فيحتاج دائمًا إلى بروتوكول relayium الأصلي على الطرف البعيد — لا يوجد بديل tar لـ sync، فثبِّته هناك أولًا.",
      },
      {
        q: "هل النسخة الاحتياطية مُشفَّرة ومُتحقَّق منها؟",
        a: "نعم. يُفحَص كل ملف بتجزئة SHA-256 من الطرف إلى الطرف، والدفع عبر SSH أو daemon-direct يعني أن البايتات محمية أصلًا بتشفير ذلك الاتصال — لا شيء إضافي لضبطه.",
      },
      {
        q: "ماذا يحدث إذا قوطعت مهمة cron في منتصفها؟",
        a: "مع وجود relayium على الطرفين، يستأنف التشغيل المُجدوَل التالي الملفات الجزئية بدلًا من إعادة إرسال كل شيء. مرِّر --no-resume إذا أردت في أي وقت إعادة إرسال كاملة ونظيفة بدلًا من ذلك.",
      },
      {
        q: "هل يمكن أن يمحو --delete وجهتي بالخطأ؟",
        a: "يرفض sync التشغيل مع --delete إذا لم يحتوِ مجلد المصدر على أي ملف، ويجب تشغيل المستقبِل بـ serve --allow-delete حتى تسري عمليات الحذف أصلًا — وإلا تُتجاهَل ويُبلَّغ عنها إليك.",
      },
      {
        q: "هل أحتاج إلى حساب، وهل يكلّف هذا شيئًا؟",
        a: "لا. واجهة CLI مجانية ولا تحتاج إلى حساب لـ push أو pull أو sync — يجري النقل عبر اتصال SSH الخاص بك أو اتصال daemon مباشر، لا عبر خوادم Relayium.",
      },
    ],
  },
  cta: {
    text: "ضع نسخك الاحتياطية على جدول لا يتوجب عليك تذكّره — مُشفَّرة، قابلة للاستئناف، ومجانية.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

export default {
  slug: "how-to/automate-server-backups",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar }),
};
