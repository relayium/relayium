// web/scripts/pages/content/articles/cli-backup-server-ssh.mjs
// How-to: back up / sync files to your own server with relayium push/pull over SSH.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Back up files to your own server over SSH with the Relayium CLI",
  description:
    "Use relayium push and pull to copy or sync directories to a server you already SSH into — resumable, integrity-checked, and free. Bytes travel over your own SSH connection and never touch Relayium's servers.",
  updatedLabel: "Last updated",
  lead: [
    "If you already have SSH access to a box — a VPS, a home server, a NAS, a workstation — you can back files up to it with the Relayium CLI without setting up a sync service or an account. The transfer runs over your existing SSH connection, so the bytes go straight to your server and never pass through Relayium.",
    "This guide covers pushing and pulling directories, what resume and integrity checking give you, and how to run it on a schedule with cron.",
  ],
  sections: [
    {
      heading: "Push a directory to your server",
      body: [
        "push takes one or more sources and an scp-style destination. Relayium connects over SSH using your usual keys and config, then streams the files to the destination directory:",
      ],
      code: [
        `# copy a local folder to the server
relayium push ./photos user@your-server:backups/

# choose an SSH key and a non-default port
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "It reuses your ~/.ssh/config, so host aliases, keys and ports you already set up just work.",
        "If relayium is installed on the server, it uses the native protocol: per-file resume and a SHA-256 check on every file.",
        "If not, it falls back to piping a tar stream into the remote, so a bare server with no relayium still works.",
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
      heading: "Resume and integrity come built in",
      body: [
        "Backups tend to be large and networks tend to drop. When relayium is on both ends, an interrupted transfer resumes from where it stopped on the next run instead of re-sending everything, and each file is verified end to end with a SHA-256 hash — what lands on the server is byte-for-byte what you sent.",
        "If you ever want a clean, full re-send instead of resuming a partial file, pass --no-resume.",
      ],
      bullets: [
        "Resume needs relayium on the remote (the native protocol); the tar fallback always sends in full.",
        "The SHA-256 check runs automatically; a mismatch is reported and that file is flagged as failed.",
      ],
    },
    {
      heading: "Run it on a schedule with cron",
      body: [
        "Because push is a single non-interactive command that uses your SSH keys, it drops straight into cron for a recurring backup. Point it at a key with no passphrase (or an agent), and log the output so you can see failures:",
      ],
      code: [
        `# back up every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Combined with resume, a nightly job that gets interrupted simply continues the next night.",
        "The command exits non-zero if any file fails its integrity check, so cron's mail-on-failure catches problems.",
      ],
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
        a: "It depends on the direction. For push, it's optional: with relayium on the remote you get the native protocol — resumable transfers and per-file SHA-256 checks — and without it, push falls back to a plain tar stream over SSH, which still works but always sends each file in full. For pull, it's required: pull always needs relayium on the remote (it has no tar fallback), so install it there first.",
      },
      {
        q: "How does it choose which SSH key and port to use?",
        a: "It reads your ~/.ssh/config like ssh does, so host aliases, keys and ports are picked up automatically. You can also override them per command with -i for the identity file and -p for the port.",
      },
      {
        q: "Is this faster than rsync?",
        a: "For pushing to your own server it's in the same ballpark as rsync over SSH; the point isn't to beat rsync but to give you one tool that also does cross-network and server-to-server transfers with the same resume and integrity guarantees.",
      },
    ],
  },
  cta: {
    text: "Back up your next directory the direct way — over your own SSH, resumable, integrity-checked, and free.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 通过 SSH 把文件备份到自己的服务器",
  description:
    "用 relayium push 和 pull 把目录复制或同步到你已经能 ssh 上去的服务器——支持断点续传、完整性校验，而且免费。字节走你自己的 SSH 连接，从不经过 Relayium 的服务器。",
  updatedLabel: "最近更新",
  lead: [
    "如果你已经能 ssh 到某台机器上——VPS、家庭服务器、NAS、工作站都算——那就可以用 Relayium CLI 直接把文件备份过去，不用搭同步服务，也不用注册账号。传输走的是你现有的 SSH 连接，字节直接进你的服务器，从不经过 Relayium。",
    "本文介绍怎么 push 和 pull 目录、断点续传与完整性校验各自能带来什么，以及如何用 cron 让它定时跑起来。",
  ],
  sections: [
    {
      heading: "把一个目录 push 到你的服务器",
      body: [
        "push 接受一个或多个源，以及一个 scp 风格的目标地址。Relayium 会用你平常的密钥和配置通过 SSH 连过去，再把文件流式写入目标目录：",
      ],
      code: [
        `# 把本地文件夹复制到服务器
relayium push ./photos user@your-server:backups/

# 指定 SSH 密钥和非默认端口
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "它会复用你的 ~/.ssh/config，所以你早就配好的主机别名、密钥和端口都能直接生效。",
        "如果服务器上装了 relayium，就走原生协议：逐文件断点续传，并对每个文件做 SHA-256 校验。",
        "如果没装，就退回到把 tar 流通过管道送给远端，所以一台没有 relayium 的裸服务器也能收。",
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
      heading: "断点续传与完整性校验都是内置的",
      body: [
        "备份往往体积很大，网络又常常掉线。两端都装了 relayium 时，中断的传输会在下次运行时从断点接着传，而不是重头再发一遍；每个文件还会用 SHA-256 哈希做端到端校验——落到服务器上的内容，和你发出去的逐字节一致。",
        "如果你想放弃续传、做一次干净的完整重发，加上 --no-resume 即可。",
      ],
      bullets: [
        "续传需要远端装有 relayium（走原生协议）；tar 兜底方案每次都是完整发送。",
        "SHA-256 校验会自动进行；一旦对不上就会报出来，该文件被标记为失败。",
      ],
    },
    {
      heading: "用 cron 定时运行",
      body: [
        "push 是一条用你自己 SSH 密钥的非交互式命令，所以可以原样放进 cron 做定期备份。给它指定一个没有口令的密钥（或者用 agent），并把输出记下来，好让失败能被看见：",
      ],
      code: [
        `# 每晚 2 点备份——加到你的 crontab 里（crontab -e）
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "配合续传，一个被中断的夜间任务下一晚会自动接着传。",
        "只要有文件没通过完整性校验，命令就会以非零状态退出，cron 的失败邮件通知就能发现问题。",
      ],
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
        a: "要看方向。对 push 来说是可选的：远端装了 relayium 就能走原生协议——支持断点续传，并对每个文件做 SHA-256 校验；没装的话，push 会退回到通过 SSH 传输 tar 流，依然可用，只是每个文件每次都完整发送。对 pull 来说则是必须的：pull 始终需要远端装有 relayium（它没有 tar 兜底方案），请先在远端装好。",
      },
      {
        q: "它怎么决定用哪个 SSH 密钥和端口？",
        a: "它会像 ssh 一样读取你的 ~/.ssh/config，所以主机别名、密钥和端口都会被自动识别。你也可以在单条命令里用 -i 指定身份文件、用 -p 指定端口来覆盖它们。",
      },
      {
        q: "这比 rsync 快吗？",
        a: "在推送到自己服务器这件事上，速度和走 SSH 的 rsync 差不多。重点不是跑赢 rsync，而是让你只用一个工具，就能顺带做跨网络传输和服务器之间的传输，而且续传与完整性保证完全一致。",
      },
    ],
  },
  cta: {
    text: "用最直接的方式备份你的下一个目录——走你自己的 SSH，支持断点续传、完整性校验，而且免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI と SSH で自分のサーバーにファイルをバックアップする",
  description:
    "relayium push と pull を使って、すでに ssh でアクセスできるサーバーへディレクトリをコピーまたは同期。再開可能、整合性チェック付きで無料。バイトは自分の SSH 接続を通り、Relayium のサーバーには一切触れません。",
  updatedLabel: "最終更新",
  lead: [
    "VPS、自宅サーバー、NAS、ワークステーションなど、すでに ssh でアクセスできるマシンがあれば、同期サービスやアカウントを用意しなくても Relayium CLI でそこへファイルをバックアップできます。転送は既存の SSH 接続の上で行われるため、バイトは直接自分のサーバーへ向かい、Relayium を通ることはありません。",
    "本ガイドではディレクトリの push と pull、再開機能と整合性チェックが何をもたらすか、そして cron でスケジュール実行する方法を扱います。",
  ],
  sections: [
    {
      heading: "ディレクトリをサーバーへ push する",
      body: [
        "push は1つ以上のソースと scp 形式の宛先を受け取ります。Relayium はいつも使っている鍵と設定を使って SSH 経由で接続し、ファイルを宛先ディレクトリへストリーミングします：",
      ],
      code: [
        `# ローカルのフォルダーをサーバーへコピーする
relayium push ./photos user@your-server:backups/

# SSH 鍵と既定以外のポートを指定する
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "既存の ~/.ssh/config を再利用するので、すでに設定済みのホストエイリアス、鍵、ポートがそのまま使えます。",
        "サーバーに relayium がインストールされていれば、ネイティブプロトコルを使います。ファイルごとの再開と、すべてのファイルに対する SHA-256 チェックです。",
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
      heading: "再開と整合性が標準で備わっている",
      body: [
        "バックアップは大きくなりがちで、ネットワークは切れがちです。relayium が両端にあれば、中断された転送は次回の実行時にすべてを再送するのではなく中断した所から再開し、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。サーバーに届くものは送ったものとバイト単位で同一です。",
        "部分的なファイルを再開するのではなく、きれいに全体を再送したい場合は --no-resume を指定してください。",
      ],
      bullets: [
        "再開にはリモート側に relayium が必要です（ネイティブプロトコル）。tar フォールバックは常に全体を送信します。",
        "SHA-256 チェックは自動的に実行され、不一致があれば報告され、そのファイルは失敗としてフラグが立てられます。",
      ],
    },
    {
      heading: "cron でスケジュール実行する",
      body: [
        "push は SSH 鍵を使う単一の非対話型コマンドなので、そのまま cron に組み込んで定期バックアップにできます。パスフレーズなしの鍵（または agent）を指定し、出力をログに残して失敗を確認できるようにしましょう：",
      ],
      code: [
        `# 毎晩2時にバックアップ（crontab -e で crontab に追加）
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "再開と組み合わせれば、中断された夜間ジョブは翌晩そのまま続きから進みます。",
        "いずれかのファイルが整合性チェックに失敗すると、コマンドは非ゼロで終了するので、cron の失敗時メール通知で問題に気づけます。",
      ],
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
        a: "方向によります。push の場合は任意です。リモートに relayium があればネイティブプロトコルが使え、再開可能な転送とファイルごとの SHA-256 チェックが得られます。なければ push は SSH 上の tar ストリームにフォールバックし、それでも動作しますが、各ファイルは常に全体が送信されます。pull の場合は必須です。pull は常にリモート側の relayium を必要とし（tar フォールバックはありません）、先にリモートへインストールしておいてください。",
      },
      {
        q: "どの SSH 鍵とポートを使うかはどう決まりますか？",
        a: "ssh と同じように既存の ~/.ssh/config を読み込むため、ホストエイリアス、鍵、ポートは自動的に反映されます。コマンドごとに -i でアイデンティティファイル、-p でポートを指定して上書きすることもできます。",
      },
      {
        q: "これは rsync より速いですか？",
        a: "自分のサーバーへの push に関しては、SSH 経由の rsync とほぼ同等です。狙いは rsync に勝つことではなく、同じ再開・整合性保証を備えたまま、クロスネットワーク転送やサーバー間転送もこなせる1つのツールを提供することです。",
      },
    ],
  },
  cta: {
    text: "次のディレクトリを直接の方法でバックアップしましょう。自分の SSH 経由、再開可能、整合性チェック付きで無料です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 SSH를 통해 자신의 서버에 파일 백업하기",
  description:
    "relayium push와 pull로 이미 ssh로 접속하는 서버에 디렉터리를 복사하거나 동기화하세요 — 재개 가능하고 무결성 검사가 되며 무료입니다. 바이트는 내 SSH 연결을 통해 이동하며 Relayium의 서버를 전혀 거치지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "VPS, 홈 서버, NAS, 워크스테이션 등 이미 ssh로 접속할 수 있는 서버가 있다면, 동기화 서비스나 계정을 따로 마련하지 않고도 Relayium CLI로 그곳에 파일을 백업할 수 있습니다. 전송은 기존 SSH 연결을 통해 이루어지므로 바이트는 곧장 내 서버로 가고 Relayium을 거치지 않습니다.",
    "이 가이드는 디렉터리를 push하고 pull하는 방법, 재개와 무결성 검사가 주는 이점, 그리고 cron으로 예약 실행하는 방법을 다룹니다.",
  ],
  sections: [
    {
      heading: "디렉터리를 서버로 push하기",
      body: [
        "push는 하나 이상의 소스와 scp 형식의 대상을 받습니다. Relayium은 평소 쓰는 키와 설정으로 SSH를 통해 연결한 뒤, 파일을 대상 디렉터리로 스트리밍합니다:",
      ],
      code: [
        `# 로컬 폴더를 서버로 복사
relayium push ./photos user@your-server:backups/

# SSH 키와 기본이 아닌 포트 지정
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "기존 ~/.ssh/config를 그대로 재사용하므로, 이미 설정해 둔 호스트 별칭, 키, 포트가 그대로 작동합니다.",
        "서버에 relayium이 설치되어 있으면 네이티브 프로토콜을 사용합니다: 파일별 재개와 모든 파일에 대한 SHA-256 검사입니다.",
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
      heading: "재개와 무결성이 기본으로 내장되어 있다",
      body: [
        "백업은 대체로 크고, 네트워크는 대체로 끊깁니다. 양쪽에 relayium이 있으면 중단된 전송은 다음 실행 시 전체를 다시 보내는 대신 멈춘 지점에서 재개되고, 각 파일은 SHA-256 해시로 종단간 검증됩니다 — 서버에 도착하는 것은 보낸 것과 바이트 단위로 동일합니다.",
        "부분 파일을 재개하는 대신 깔끔하게 전체를 다시 보내고 싶다면 --no-resume을 넘기세요.",
      ],
      bullets: [
        "재개에는 원격에 relayium이 필요합니다(네이티브 프로토콜); tar 대체 방식은 항상 전체를 전송합니다.",
        "SHA-256 검사는 자동으로 실행되며, 불일치가 있으면 보고되고 해당 파일은 실패로 표시됩니다.",
      ],
    },
    {
      heading: "cron으로 예약 실행하기",
      body: [
        "push는 SSH 키를 사용하는 단일 비대화형 명령이므로, 그대로 cron에 넣어 반복 백업으로 쓸 수 있습니다. 암호 없는 키(또는 agent)를 지정하고, 출력을 로그로 남겨 실패를 확인할 수 있게 하세요:",
      ],
      code: [
        `# 매일 밤 2시에 백업. crontab에 추가하세요(crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "재개 기능과 결합하면, 중단된 야간 작업은 다음 날 밤 그대로 이어서 진행됩니다.",
        "무결성 검사에 실패한 파일이 하나라도 있으면 명령이 0이 아닌 상태로 종료되므로, cron의 실패 시 메일 알림으로 문제를 발견할 수 있습니다.",
      ],
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
        a: "방향에 따라 다릅니다. push의 경우 선택 사항입니다. 원격에 relayium이 있으면 네이티브 프로토콜을 사용할 수 있습니다 — 재개 가능한 전송과 파일별 SHA-256 검사입니다. 없으면 push는 SSH를 통한 tar 스트림으로 대체되며, 여전히 동작하지만 각 파일을 항상 전체 전송합니다. pull의 경우 필수입니다. pull은 항상 원격지에 relayium이 있어야 하며(tar 대체 방식 없음), 먼저 원격지에 설치해 두세요.",
      },
      {
        q: "어떤 SSH 키와 포트를 사용할지 어떻게 정하나요?",
        a: "ssh와 마찬가지로 기존 ~/.ssh/config를 읽으므로, 호스트 별칭, 키, 포트가 자동으로 반영됩니다. 명령마다 -i로 신원 파일을, -p로 포트를 지정해 재정의할 수도 있습니다.",
      },
      {
        q: "이게 rsync보다 빠른가요?",
        a: "자신의 서버로 push하는 경우라면 SSH를 통한 rsync와 비슷한 수준입니다. 목표는 rsync를 이기는 것이 아니라, 같은 재개와 무결성 보장을 갖춘 채로 크로스 네트워크 전송과 서버 간 전송까지 함께 해내는 하나의 도구를 제공하는 것입니다.",
      },
    ],
  },
  cta: {
    text: "다음 디렉터리를 직접적인 방식으로 백업하세요 — 내 SSH를 통해, 재개 가능하고, 무결성 검사가 되며, 무료입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien über SSH auf dem eigenen Server sichern mit der Relayium CLI",
  description:
    "Nutze relayium push und pull, um Verzeichnisse auf einen Server zu kopieren oder zu synchronisieren, auf den du bereits per ssh zugreifst — fortsetzbar, mit Integritätsprüfung und kostenlos. Die Bytes laufen über deine eigene SSH-Verbindung und berühren nie die Server von Relayium.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Wenn du bereits SSH-Zugriff auf eine Maschine hast — einen VPS, einen Heimserver, ein NAS, eine Workstation —, kannst du Dateien mit der Relayium CLI dorthin sichern, ohne einen Sync-Dienst einzurichten oder ein Konto zu brauchen. Die Übertragung läuft über deine bestehende SSH-Verbindung, sodass die Bytes direkt zu deinem Server gehen und Relayium nie passieren.",
    "Diese Anleitung behandelt das push und pull von Verzeichnissen, was Fortsetzen und Integritätsprüfung dir bringen, und wie du das Ganze mit cron nach Zeitplan laufen lässt.",
  ],
  sections: [
    {
      heading: "Ein Verzeichnis auf deinen Server pushen",
      body: [
        "push nimmt eine oder mehrere Quellen und ein Ziel im scp-Stil entgegen. Relayium verbindet sich per SSH mit deinen üblichen Schlüsseln und deiner Konfiguration und streamt die Dateien dann in das Zielverzeichnis:",
      ],
      code: [
        `# einen lokalen Ordner auf den Server kopieren
relayium push ./photos user@your-server:backups/

# einen SSH-Schlüssel und einen abweichenden Port wählen
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "Es verwendet deine ~/.ssh/config wieder, sodass bereits eingerichtete Host-Aliase, Schlüssel und Ports einfach funktionieren.",
        "Ist relayium auf dem Server installiert, nutzt es das native Protokoll: Fortsetzen je Datei und eine SHA-256-Prüfung für jede Datei.",
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
      heading: "Fortsetzen und Integrität sind eingebaut",
      body: [
        "Backups sind meist groß, und Netzwerke brechen gerne ab. Ist relayium auf beiden Seiten vorhanden, setzt eine unterbrochene Übertragung beim nächsten Lauf dort fort, wo sie aufgehört hat, statt alles neu zu senden, und jede Datei wird Ende-zu-Ende mit einem SHA-256-Hash geprüft — was auf dem Server landet, entspricht Byte für Byte dem, was du gesendet hast.",
        "Willst du statt der Fortsetzung einer Teildatei einen sauberen, vollständigen Neuversand, übergib --no-resume.",
      ],
      bullets: [
        "Fortsetzen braucht relayium auf der Gegenseite (das native Protokoll); der tar-Fallback sendet immer vollständig.",
        "Die SHA-256-Prüfung läuft automatisch; bei einer Abweichung wird das gemeldet und die Datei als fehlgeschlagen markiert.",
      ],
    },
    {
      heading: "Per cron nach Zeitplan ausführen",
      body: [
        "Da push ein einzelner, nicht-interaktiver Befehl ist, der deine SSH-Schlüssel nutzt, lässt es sich direkt in cron für ein wiederkehrendes Backup einsetzen. Verweise auf einen Schlüssel ohne Passphrase (oder einen Agent) und protokolliere die Ausgabe, damit du Fehlschläge siehst:",
      ],
      code: [
        `# jede Nacht um 2 Uhr sichern — in deine crontab eintragen (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Zusammen mit dem Fortsetzen läuft ein unterbrochener nächtlicher Job in der folgenden Nacht einfach weiter.",
        "Der Befehl endet mit einem Exit-Code ungleich null, wenn eine Datei ihre Integritätsprüfung nicht besteht, sodass crons Mail-bei-Fehlschlag das Problem auffängt.",
      ],
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
        a: "Das hängt von der Richtung ab. Bei push ist es optional: Mit relayium auf der Gegenseite bekommst du das native Protokoll — fortsetzbare Übertragungen und SHA-256-Prüfungen je Datei —, und ohne das weicht push auf einen tar-Stream über SSH aus, der weiterhin funktioniert, aber jede Datei stets vollständig sendet. Bei pull ist es erforderlich: pull braucht immer relayium auf der Gegenseite (keinen tar-Fallback), installiere es dort also zuerst.",
      },
      {
        q: "Wie wählt es aus, welchen SSH-Schlüssel und welchen Port es nutzt?",
        a: "Es liest deine ~/.ssh/config genau wie ssh, sodass Host-Aliase, Schlüssel und Ports automatisch übernommen werden. Du kannst sie auch pro Befehl überschreiben, mit -i für die Identitätsdatei und -p für den Port.",
      },
      {
        q: "Ist das schneller als rsync?",
        a: "Beim Push auf den eigenen Server liegt es in etwa auf dem Niveau von rsync über SSH; der Punkt ist nicht, rsync zu schlagen, sondern dir ein einziges Werkzeug zu geben, das mit denselben Fortsetzungs- und Integritätsgarantien auch netzwerkübergreifende und Server-zu-Server-Übertragungen erledigt.",
      },
    ],
  },
  cta: {
    text: "Sichere dein nächstes Verzeichnis auf dem direkten Weg — über deine eigene SSH-Verbindung, fortsetzbar, mit Integritätsprüfung und kostenlos.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Sauvegarder des fichiers sur son propre serveur via SSH avec la CLI Relayium",
  description:
    "Utilisez relayium push et pull pour copier ou synchroniser des répertoires vers un serveur auquel vous accédez déjà en ssh — reprise possible, intégrité vérifiée, et gratuit. Les octets circulent sur votre propre connexion SSH et ne touchent jamais les serveurs de Relayium.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Si vous avez déjà un accès SSH à une machine — un VPS, un serveur personnel, un NAS, un poste de travail —, vous pouvez y sauvegarder des fichiers avec la CLI Relayium sans mettre en place un service de synchronisation ni de compte. Le transfert passe par votre connexion SSH existante, si bien que les octets vont directement à votre serveur et ne transitent jamais par Relayium.",
    "Ce guide couvre le push et le pull de répertoires, ce que la reprise et la vérification d'intégrité vous apportent, et comment le planifier avec cron.",
  ],
  sections: [
    {
      heading: "Pousser (push) un répertoire vers votre serveur",
      body: [
        "push prend une ou plusieurs sources et une destination de style scp. Relayium se connecte en SSH avec vos clés et votre configuration habituelles, puis diffuse les fichiers vers le répertoire de destination :",
      ],
      code: [
        `# copier un dossier local vers le serveur
relayium push ./photos user@your-server:backups/

# choisir une clé SSH et un port non standard
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "Il réutilise votre ~/.ssh/config, donc les alias d'hôtes, les clés et les ports déjà configurés fonctionnent tels quels.",
        "Si relayium est installé sur le serveur, il utilise le protocole natif : reprise par fichier et vérification SHA-256 sur chaque fichier.",
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
      heading: "Reprise et intégrité intégrées d'office",
      body: [
        "Les sauvegardes ont tendance à être volumineuses, et les réseaux ont tendance à se couper. Quand relayium est présent des deux côtés, un transfert interrompu reprend là où il s'est arrêté lors de l'exécution suivante au lieu de tout renvoyer, et chaque fichier est vérifié de bout en bout par un hachage SHA-256 — ce qui arrive sur le serveur est identique octet pour octet à ce que vous avez envoyé.",
        "Si vous voulez un renvoi complet et propre plutôt que la reprise d'un fichier partiel, passez --no-resume.",
      ],
      bullets: [
        "La reprise nécessite relayium côté distant (le protocole natif) ; le repli tar envoie toujours l'intégralité.",
        "La vérification SHA-256 s'exécute automatiquement ; une divergence est signalée et le fichier est marqué en échec.",
      ],
    },
    {
      heading: "Le planifier avec cron",
      body: [
        "Comme push est une commande unique et non interactive qui utilise vos clés SSH, elle s'intègre directement dans cron pour une sauvegarde récurrente. Pointez-la vers une clé sans phrase de passe (ou vers un agent), et journalisez la sortie pour repérer les échecs :",
      ],
      code: [
        `# sauvegarde chaque nuit à 2 h — à ajouter dans votre crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Combinée à la reprise, une tâche nocturne interrompue continue simplement la nuit suivante.",
        "La commande se termine avec un code non nul si un fichier échoue à sa vérification d'intégrité, si bien que la notification par e-mail en cas d'échec de cron détecte les problèmes.",
      ],
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
        a: "Cela dépend du sens. Pour push, c'est optionnel : avec relayium côté distant, vous obtenez le protocole natif — transferts avec reprise et vérifications SHA-256 par fichier — et sans cela, push bascule sur un flux tar via SSH, qui fonctionne toujours mais renvoie systématiquement chaque fichier en entier. Pour pull, c'est requis : pull a toujours besoin de relayium côté distant (aucun repli tar), installez-le donc là-bas au préalable.",
      },
      {
        q: "Comment choisit-il quelle clé SSH et quel port utiliser ?",
        a: "Il lit votre ~/.ssh/config comme le fait ssh, si bien que les alias d'hôtes, les clés et les ports sont repris automatiquement. Vous pouvez aussi les surcharger par commande avec -i pour le fichier d'identité et -p pour le port.",
      },
      {
        q: "Est-ce plus rapide que rsync ?",
        a: "Pour pousser vers votre propre serveur, c'est dans le même ordre de grandeur que rsync via SSH ; l'objectif n'est pas de battre rsync mais de vous offrir un seul outil qui gère aussi les transferts entre réseaux et de serveur à serveur, avec les mêmes garanties de reprise et d'intégrité.",
      },
    ],
  },
  cta: {
    text: "Sauvegardez votre prochain répertoire de la manière la plus directe — via votre propre SSH, avec reprise possible, intégrité vérifiée, et gratuit.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "انسخ الملفات احتياطيًا إلى خادمك عبر SSH باستخدام Relayium CLI",
  description:
    "استخدم relayium push وpull لنسخ المجلدات أو مزامنتها إلى خادم تدخل إليه بالفعل عبر ssh — قابل للاستئناف، ومُتحقَّق من سلامته، ومجاني. تنتقل البايتات عبر اتصال SSH لديك ولا تلمس خوادم Relayium أبدًا.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إذا كان لديك بالفعل وصول SSH إلى جهاز — خادم افتراضي خاص، أو خادم منزلي، أو NAS، أو محطة عمل — فيمكنك نسخ الملفات إليه احتياطيًا باستخدام Relayium CLI دون إعداد خدمة مزامنة أو حساب. تجري عملية النقل عبر اتصال SSH الموجود لديك، فتذهب البايتات مباشرة إلى خادمك ولا تمر أبدًا عبر Relayium.",
    "يغطّي هذا الدليل دفع المجلدات وسحبها، وما يمنحك إياه الاستئناف والتحقق من السلامة، وكيفية تشغيله وفق جدول باستخدام cron.",
  ],
  sections: [
    {
      heading: "ادفع مجلدًا إلى خادمك",
      body: [
        "يأخذ push مصدرًا واحدًا أو أكثر ووجهة بأسلوب scp. يتصل Relayium عبر SSH باستخدام مفاتيحك وإعداداتك المعتادة، ثم يبثّ الملفات إلى مجلد الوجهة:",
      ],
      code: [
        `# انسخ مجلدًا محليًا إلى الخادم
relayium push ./photos user@your-server:backups/

# اختر مفتاح SSH ومنفذًا غير افتراضي
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "يعيد استخدام ملف ~/.ssh/config لديك، فأسماء المضيفين المستعارة والمفاتيح والمنافذ التي أعددتها من قبل تعمل مباشرة.",
        "إذا كان relayium مثبّتًا على الخادم، يستخدم البروتوكول الأصلي: استئناف لكل ملف وتحقق SHA-256 على كل ملف.",
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
      heading: "الاستئناف والسلامة مدمجان",
      body: [
        "تميل النسخ الاحتياطية إلى أن تكون كبيرة وتميل الشبكات إلى الانقطاع. عندما يكون relayium على الطرفين، يُستأنف النقل المنقطع من حيث توقّف في التشغيل التالي بدل إعادة إرسال كل شيء، ويُتحقق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256 — فما يصل إلى الخادم مطابق بايتًا ببايت لما أرسلته.",
        "إذا أردت في أي وقت إعادة إرسال كاملة ونظيفة بدل استئناف ملف جزئي، مرّر --no-resume.",
      ],
      bullets: [
        "يحتاج الاستئناف إلى relayium على الطرف البعيد (البروتوكول الأصلي)؛ أما تراجع tar فيرسل دائمًا بالكامل.",
        "يعمل تحقق SHA-256 تلقائيًا؛ ويُبلَّغ عن أي عدم تطابق ويُوسَم ذلك الملف بالفشل.",
      ],
    },
    {
      heading: "شغّله وفق جدول باستخدام cron",
      body: [
        "لأن push أمر واحد غير تفاعلي يستخدم مفاتيح SSH لديك، فإنه يندرج مباشرة في cron لنسخ احتياطي متكرر. وجّهه إلى مفتاح بلا عبارة مرور (أو إلى agent)، وسجّل المخرجات كي ترى حالات الفشل:",
      ],
      code: [
        `# انسخ احتياطيًا كل ليلة عند الساعة 2 — أضِف هذا إلى crontab لديك (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "بالاقتران مع الاستئناف، فإن مهمة ليلية تنقطع تكمل ببساطة في الليلة التالية.",
        "يخرج الأمر بحالة غير صفرية إذا فشل أي ملف في تحقق سلامته، فيلتقط بريد cron عند الفشل المشكلات.",
      ],
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
        a: "يعتمد ذلك على الاتجاه. بالنسبة لـ push فهو اختياري: مع relayium على الطرف البعيد تحصل على البروتوكول الأصلي — عمليات نقل قابلة للاستئناف وتحقق SHA-256 لكل ملف — وبدونه يتراجع push إلى بث tar بسيط عبر SSH، وهو يعمل مع ذلك لكنه يرسل دائمًا كل ملف بالكامل. أما بالنسبة لـ pull فهو مطلوب: يحتاج pull دائمًا إلى relayium على الطرف البعيد (لا يملك تراجع tar)، فثبّته هناك أولًا.",
      },
      {
        q: "كيف يختار أي مفتاح SSH وأي منفذ يستخدم؟",
        a: "يقرأ ملف ~/.ssh/config لديك كما يفعل ssh، فتُلتقط أسماء المضيفين المستعارة والمفاتيح والمنافذ تلقائيًا. يمكنك أيضًا تجاوزها لكل أمر بـ -i لملف الهوية و -p للمنفذ.",
      },
      {
        q: "هل هذا أسرع من rsync؟",
        a: "للدفع إلى خادمك الخاص فهو في المستوى نفسه تقريبًا لـ rsync عبر SSH؛ الهدف ليس التفوّق على rsync بل أن نمنحك أداة واحدة تنفّذ أيضًا عمليات النقل عبر الشبكات ومن خادم إلى خادم بنفس ضمانات الاستئناف والسلامة.",
      },
    ],
  },
  cta: {
    text: "انسخ مجلدك التالي احتياطيًا بالطريقة المباشرة — عبر SSH لديك، قابل للاستئناف، ومُتحقَّق من سلامته، ومجاني.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Haz copias de seguridad de archivos en tu propio servidor por SSH con la CLI de Relayium",
  description:
    "Usa relayium push y pull para copiar o sincronizar directorios a un servidor al que ya accedes por ssh — reanudable, con comprobación de integridad y gratis. Los bytes viajan por tu propia conexión SSH y nunca tocan los servidores de Relayium.",
  updatedLabel: "Última actualización",
  lead: [
    "Si ya tienes acceso SSH a una máquina — un VPS, un servidor doméstico, un NAS, una estación de trabajo —, puedes hacer copias de seguridad de tus archivos en ella con la CLI de Relayium sin montar un servicio de sincronización ni una cuenta. La transferencia se ejecuta sobre tu conexión SSH existente, así que los bytes van directos a tu servidor y nunca pasan por Relayium.",
    "Esta guía cubre cómo hacer push y pull de directorios, qué te aportan la reanudación y la comprobación de integridad, y cómo ejecutarlo de forma programada con cron.",
  ],
  sections: [
    {
      heading: "Envía (push) un directorio a tu servidor",
      body: [
        "push toma una o más fuentes y un destino al estilo scp. Relayium se conecta por SSH usando tus claves y tu configuración habituales, y luego transmite los archivos al directorio de destino:",
      ],
      code: [
        `# copia una carpeta local al servidor
relayium push ./photos user@your-server:backups/

# elige una clave SSH y un puerto distinto al de por defecto
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "Reutiliza tu ~/.ssh/config, así que los alias de host, las claves y los puertos que ya configuraste funcionan sin más.",
        "Si relayium está instalado en el servidor, usa el protocolo nativo: reanudación por archivo y una comprobación SHA-256 en cada archivo.",
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
      heading: "Reanudación e integridad vienen de serie",
      body: [
        "Las copias de seguridad tienden a ser grandes y las redes tienden a cortarse. Cuando relayium está en ambos extremos, una transferencia interrumpida se reanuda en la siguiente ejecución desde donde se detuvo en lugar de reenviarlo todo, y cada archivo se verifica de extremo a extremo con un hash SHA-256 — lo que llega al servidor es byte por byte lo que enviaste.",
        "Si en algún momento prefieres un reenvío completo y limpio en vez de reanudar un archivo parcial, pasa --no-resume.",
      ],
      bullets: [
        "La reanudación necesita relayium en el remoto (el protocolo nativo); la alternativa con tar siempre envía por completo.",
        "La comprobación SHA-256 se ejecuta automáticamente; una discrepancia se informa y ese archivo se marca como fallido.",
      ],
    },
    {
      heading: "Ejecútalo de forma programada con cron",
      body: [
        "Como push es un único comando no interactivo que usa tus claves SSH, encaja directamente en cron para una copia de seguridad recurrente. Apúntalo a una clave sin frase de contraseña (o a un agente), y registra la salida para poder ver los fallos:",
      ],
      code: [
        `# copia de seguridad cada noche a las 2 — añádela a tu crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Combinado con la reanudación, un trabajo nocturno que se interrumpe simplemente continúa la noche siguiente.",
        "El comando termina con un código distinto de cero si algún archivo falla su comprobación de integridad, así que el correo de fallo de cron detecta los problemas.",
      ],
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
        a: "Depende de la dirección. Para push es opcional: con relayium en el remoto obtienes el protocolo nativo — transferencias reanudables y comprobaciones SHA-256 por archivo — y sin él, push recurre a un simple flujo tar sobre SSH, que sigue funcionando pero envía siempre cada archivo por completo. Para pull es obligatorio: pull siempre necesita relayium en el remoto (no tiene alternativa con tar), así que instálalo allí primero.",
      },
      {
        q: "¿Cómo elige qué clave SSH y qué puerto usar?",
        a: "Lee tu ~/.ssh/config igual que hace ssh, así que los alias de host, las claves y los puertos se recogen automáticamente. También puedes sobrescribirlos por comando con -i para el archivo de identidad y -p para el puerto.",
      },
      {
        q: "¿Es más rápido que rsync?",
        a: "Para enviar a tu propio servidor está en el mismo orden de magnitud que rsync sobre SSH; el objetivo no es superar a rsync, sino darte una sola herramienta que además hace transferencias entre redes y de servidor a servidor con las mismas garantías de reanudación e integridad.",
      },
    ],
  },
  cta: {
    text: "Haz la copia de seguridad de tu próximo directorio de la forma directa — por tu propio SSH, reanudable, con comprobación de integridad y gratis.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Faça backup de arquivos no seu próprio servidor via SSH com a CLI do Relayium",
  description:
    "Use relayium push e pull para copiar ou sincronizar diretórios para um servidor que você já acessa por ssh — retomável, com verificação de integridade e gratuito. Os bytes trafegam pela sua própria conexão SSH e nunca tocam os servidores do Relayium.",
  updatedLabel: "Última atualização",
  lead: [
    "Se você já tem acesso SSH a uma máquina — um VPS, um servidor doméstico, um NAS, uma estação de trabalho —, pode fazer backup dos seus arquivos nela com a CLI do Relayium sem montar um serviço de sincronização nem uma conta. A transferência roda sobre a sua conexão SSH existente, então os bytes vão direto para o seu servidor e nunca passam pelo Relayium.",
    "Este guia aborda como fazer push e pull de diretórios, o que a retomada e a verificação de integridade oferecem, e como executá-lo de forma agendada com o cron.",
  ],
  sections: [
    {
      heading: "Envie (push) um diretório para o seu servidor",
      body: [
        "O push recebe uma ou mais origens e um destino no estilo scp. O Relayium se conecta por SSH usando suas chaves e sua configuração de sempre e, em seguida, transmite os arquivos para o diretório de destino:",
      ],
      code: [
        `# copie uma pasta local para o servidor
relayium push ./photos user@your-server:backups/

# escolha uma chave SSH e uma porta diferente da padrão
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "Ele reaproveita seu ~/.ssh/config, então os apelidos de host, as chaves e as portas que você já configurou simplesmente funcionam.",
        "Se o relayium estiver instalado no servidor, ele usa o protocolo nativo: retomada por arquivo e uma verificação SHA-256 em cada arquivo.",
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
      heading: "Retomada e integridade já vêm embutidas",
      body: [
        "Backups tendem a ser grandes e redes tendem a cair. Quando o relayium está nas duas pontas, uma transferência interrompida é retomada na próxima execução de onde parou em vez de reenviar tudo, e cada arquivo é verificado de ponta a ponta com um hash SHA-256 — o que chega ao servidor é byte por byte o que você enviou.",
        "Se em algum momento você quiser um reenvio completo e limpo em vez de retomar um arquivo parcial, passe --no-resume.",
      ],
      bullets: [
        "A retomada precisa do relayium no remoto (o protocolo nativo); a alternativa com tar sempre envia por completo.",
        "A verificação SHA-256 roda automaticamente; uma divergência é relatada e esse arquivo é marcado como falho.",
      ],
    },
    {
      heading: "Execute-o de forma agendada com o cron",
      body: [
        "Como o push é um único comando não interativo que usa suas chaves SSH, ele entra direto no cron para um backup recorrente. Aponte-o para uma chave sem frase-senha (ou para um agente) e registre a saída para conseguir ver as falhas:",
      ],
      code: [
        `# backup toda noite às 2h — adicione ao seu crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "Combinado com a retomada, um trabalho noturno que é interrompido simplesmente continua na noite seguinte.",
        "O comando encerra com código diferente de zero se algum arquivo falhar na verificação de integridade, então o e-mail de falha do cron detecta os problemas.",
      ],
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
        a: "Depende da direção. Para o push é opcional: com o relayium no remoto você obtém o protocolo nativo — transferências retomáveis e verificações SHA-256 por arquivo — e sem ele, o push recorre a um simples fluxo tar sobre SSH, que ainda funciona, mas envia sempre cada arquivo por completo. Para o pull é obrigatório: o pull sempre precisa do relayium no remoto (ele não tem alternativa com tar), então instale-o lá primeiro.",
      },
      {
        q: "Como ele escolhe qual chave SSH e qual porta usar?",
        a: "Ele lê o seu ~/.ssh/config como o ssh faz, então os apelidos de host, as chaves e as portas são identificados automaticamente. Você também pode sobrescrevê-los por comando com -i para o arquivo de identidade e -p para a porta.",
      },
      {
        q: "Isso é mais rápido que o rsync?",
        a: "Para enviar ao seu próprio servidor, fica na mesma ordem de grandeza que o rsync sobre SSH; o objetivo não é vencer o rsync, mas dar a você uma única ferramenta que também faz transferências entre redes e de servidor para servidor com as mesmas garantias de retomada e integridade.",
      },
    ],
  },
  cta: {
    text: "Faça o backup do seu próximo diretório da forma direta — pelo seu próprio SSH, retomável, com verificação de integridade e gratuito.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/back-up-a-server-over-ssh",
  published: "2026-07-08",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
