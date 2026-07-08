// web/scripts/pages/content/articles/cli-backup-server-ssh.mjs
// How-to: back up / sync files to your own server with relayium push/pull over SSH.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

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
        a: "It's optional. With relayium on the remote you get the native protocol — resumable transfers and per-file SHA-256 checks. Without it, relayium falls back to a tar stream over SSH, which still works but always sends each file in full.",
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
    "用 relayium push 和 pull 把目录复制或同步到你已经能用 ssh 连接的服务器——支持断点续传、完整性校验,而且免费。字节通过你自己的 SSH 连接传输,从不经过 Relayium 的服务器。",
  updatedLabel: "最近更新",
  lead: [
    "如果你已经能用 ssh 访问某台机器——VPS、家庭服务器、NAS、工作站——就可以用 Relayium CLI 把文件备份过去,不需要搭建同步服务,也不需要账号。传输走的是你现有的 SSH 连接,字节直接进你的服务器,从不经过 Relayium。",
    "本文将介绍如何 push 和 pull 目录、断点续传与完整性校验能带来什么,以及如何用 cron 定时运行它。",
  ],
  sections: [
    {
      heading: "把一个目录 push 到你的服务器",
      body: [
        "push 接受一个或多个源以及一个 scp 风格的目标地址。Relayium 会用你平常的密钥和配置通过 SSH 连接,然后把文件流式传输到目标目录:",
      ],
      code: [
        `# copy a local folder to the server
relayium push ./photos user@your-server:backups/

# choose an SSH key and a non-default port
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "它会复用你的 ~/.ssh/config,所以你已经设置好的主机别名、密钥和端口都能直接生效。",
        "如果服务器上装了 relayium,就会使用原生协议:逐文件断点续传,并对每个文件做 SHA-256 校验。",
        "如果没装,则会退回到把 tar 流通过管道传给远端,所以即使是一台没有 relayium 的裸服务器也能用。",
      ],
    },
    {
      heading: "把文件 pull 回来",
      body: [
        "恢复就是把同一条命令反过来:给出一个远程源和一个本地目标目录。这就是恢复备份,或者把服务器的输出同步到笔记本电脑的方法:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
    },
    {
      heading: "内置断点续传与完整性校验",
      body: [
        "备份往往体积很大,网络也常常掉线。当两端都装了 relayium 时,中断的传输会在下次运行时从中断处继续,而不是重新发送全部内容,并且每个文件都会用 SHA-256 哈希做端到端校验——落到服务器上的内容与你发送的逐字节一致。",
        "如果你想放弃续传、做一次干净的完整重发,加上 --no-resume 即可。",
      ],
      bullets: [
        "续传需要远端装有 relayium(原生协议);tar 兜底方案总是完整发送。",
        "SHA-256 校验会自动运行;一旦不匹配就会报告,该文件会被标记为失败。",
      ],
    },
    {
      heading: "用 cron 定时运行",
      body: [
        "因为 push 是一条使用你 SSH 密钥的非交互式命令,可以直接放进 cron 做定期备份。给它指定一个没有口令的密钥(或者用 agent),并把输出记录下来以便查看失败:",
      ],
      code: [
        `# back up every night at 2am — add to your crontab (crontab -e)
0 2 * * * relayium push -i ~/.ssh/backup_key ~/documents user@your-server:backups/ >> ~/relayium-backup.log 2>&1`,
      ],
      bullets: [
        "配合续传,一个被中断的夜间任务下一晚会自动接着传。",
        "只要有文件未通过完整性校验,命令就会以非零状态退出,这样 cron 的失败邮件通知就能发现问题。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "文件会经过 Relayium 的服务器吗?",
        a: "不会。push 和 pull 完全通过你自己的 SSH 连接运行。Relayium 的服务器完全不参与,也不需要账号。",
      },
      {
        q: "服务器需要装 relayium 吗?",
        a: "这是可选的。远端装了 relayium 就能用原生协议——支持断点续传,并对每个文件做 SHA-256 校验。没装的话,relayium 会退回到通过 SSH 传输 tar 流,依然可用,只是每个文件都会完整发送一次。",
      },
      {
        q: "它怎么选择使用哪个 SSH 密钥和端口?",
        a: "它会像 ssh 一样读取你的 ~/.ssh/config,所以主机别名、密钥和端口都会被自动识别。你也可以在每条命令里用 -i 指定身份文件、用 -p 指定端口来覆盖它们。",
      },
      {
        q: "这比 rsync 快吗?",
        a: "在推送到自己服务器这件事上,速度和通过 SSH 的 rsync 差不多;重点不是要跑赢 rsync,而是给你一个同时能做跨网络传输和服务器到服务器传输、并且有同样续传与完整性保证的工具。",
      },
    ],
  },
  cta: {
    text: "用最直接的方式备份你的下一个目录——通过你自己的 SSH,支持断点续传、完整性校验,而且免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI と SSH で自分のサーバーにファイルをバックアップする",
  description:
    "relayium push と pull を使って、すでに ssh でアクセスできるサーバーへディレクトリをコピーまたは同期。再開可能、整合性チェック付きで無料。バイトはあなた自身の SSH 接続を通り、Relayium のサーバーには一切触れません。",
  updatedLabel: "最終更新",
  lead: [
    "VPS、自宅サーバー、NAS、ワークステーションなど、すでに ssh でアクセスできるマシンがあれば、同期サービスやアカウントを用意しなくても Relayium CLI でそこへファイルをバックアップできます。転送は既存の SSH 接続の上で行われるため、バイトは直接あなたのサーバーへ向かい、Relayium を通ることはありません。",
    "本ガイドではディレクトリの push と pull、再開機能と整合性チェックが何をもたらすか、そして cron でスケジュール実行する方法を扱います。",
  ],
  sections: [
    {
      heading: "ディレクトリをサーバーへ push する",
      body: [
        "push は1つ以上のソースと scp 形式の宛先を受け取ります。Relayium はいつも使っている鍵と設定を使って SSH 経由で接続し、ファイルを宛先ディレクトリへストリーミングします:",
      ],
      code: [
        `# copy a local folder to the server
relayium push ./photos user@your-server:backups/

# choose an SSH key and a non-default port
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "あなたの ~/.ssh/config を再利用するので、すでに設定済みのホストエイリアス、鍵、ポートがそのまま使えます。",
        "サーバーに relayium がインストールされていれば、ネイティブプロトコルを使います。ファイルごとの再開と、すべてのファイルに対する SHA-256 チェックです。",
        "インストールされていない場合は、tar ストリームをリモートへパイプする方式にフォールバックするので、relayium のない素のサーバーでも動作します。",
      ],
    },
    {
      heading: "ファイルを pull で戻す",
      body: [
        "復元は同じコマンドを逆にするだけです。リモートのソースとローカルの宛先ディレクトリを指定します。これがバックアップを復元したり、サーバーの出力をノート PC に同期したりする方法です:",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
    },
    {
      heading: "再開と整合性が標準で備わっている",
      body: [
        "バックアップは大きくなりがちで、ネットワークは切れがちです。relayium が両端にあれば、中断された転送は次回の実行時にすべてを再送するのではなく中断した所から再開し、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます——サーバーに届くものは送ったものとバイト単位で同一です。",
        "部分的なファイルを再開するのではなく、きれいに全体を再送したい場合は --no-resume を指定してください。",
      ],
      bullets: [
        "再開にはリモート側に relayium が必要です(ネイティブプロトコル)。tar フォールバックは常に全体を送信します。",
        "SHA-256 チェックは自動的に実行され、不一致があれば報告され、そのファイルは失敗としてフラグが立てられます。",
      ],
    },
    {
      heading: "cron でスケジュール実行する",
      body: [
        "push は SSH 鍵を使う単一の非対話型コマンドなので、そのまま cron に組み込んで定期バックアップにできます。パスフレーズなしの鍵(または agent)を指定し、出力をログに残して失敗を確認できるようにしましょう:",
      ],
      code: [
        `# back up every night at 2am — add to your crontab (crontab -e)
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
        q: "ファイルは Relayium のサーバーを経由しますか?",
        a: "いいえ。push と pull はすべてあなた自身の SSH 接続の上で完結します。Relayium のサーバーは一切関与せず、アカウントも不要です。",
      },
      {
        q: "サーバーに relayium のインストールは必要ですか?",
        a: "任意です。リモートに relayium があればネイティブプロトコルが使え、再開可能な転送とファイルごとの SHA-256 チェックが得られます。なければ relayium は SSH 上の tar ストリームにフォールバックし、それでも動作しますが、各ファイルは常に全体が送信されます。",
      },
      {
        q: "どの SSH 鍵とポートを使うかはどう決まりますか?",
        a: "ssh と同じようにあなたの ~/.ssh/config を読み込むため、ホストエイリアス、鍵、ポートは自動的に反映されます。コマンドごとに -i でアイデンティティファイル、-p でポートを指定して上書きすることもできます。",
      },
      {
        q: "これは rsync より速いですか?",
        a: "自分のサーバーへの push に関しては、SSH 経由の rsync とほぼ同等です。狙いは rsync に勝つことではなく、同じ再開・整合性保証を備えたまま、クロスネットワーク転送やサーバー間転送もこなせる1つのツールを提供することです。",
      },
    ],
  },
  cta: {
    text: "次のディレクトリを直接の方法でバックアップしましょう——自分の SSH 経由、再開可能、整合性チェック付きで無料です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 SSH를 통해 자신의 서버에 파일 백업하기",
  description:
    "relayium push와 pull로 이미 ssh로 접속하는 서버에 디렉터리를 복사하거나 동기화하세요 — 재개 가능하고 무결성 검사가 되며 무료입니다. 바이트는 당신 자신의 SSH 연결을 통해 이동하며 Relayium의 서버를 전혀 거치지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "VPS, 홈 서버, NAS, 워크스테이션 등 이미 ssh로 접속할 수 있는 서버가 있다면, 동기화 서비스나 계정을 따로 마련하지 않고도 Relayium CLI로 그곳에 파일을 백업할 수 있습니다. 전송은 기존 SSH 연결을 통해 이루어지므로 바이트는 곧장 당신의 서버로 가고 Relayium을 거치지 않습니다.",
    "이 가이드는 디렉터리를 push하고 pull하는 방법, 재개와 무결성 검사가 주는 이점, 그리고 cron으로 예약 실행하는 방법을 다룹니다.",
  ],
  sections: [
    {
      heading: "디렉터리를 서버로 push하기",
      body: [
        "push는 하나 이상의 소스와 scp 형식의 대상을 받습니다. Relayium은 평소 쓰는 키와 설정으로 SSH를 통해 연결한 뒤, 파일을 대상 디렉터리로 스트리밍합니다:",
      ],
      code: [
        `# copy a local folder to the server
relayium push ./photos user@your-server:backups/

# choose an SSH key and a non-default port
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "당신의 ~/.ssh/config를 그대로 재사용하므로, 이미 설정해 둔 호스트 별칭, 키, 포트가 그대로 작동합니다.",
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
    },
    {
      heading: "재개와 무결성이 기본으로 내장되어 있다",
      body: [
        "백업은 대체로 크고, 네트워크는 대체로 끊깁니다. 양쪽에 relayium이 있으면 중단된 전송은 다음 실행 시 전체를 다시 보내는 대신 멈춘 지점에서 재개되고, 각 파일은 SHA-256 해시로 종단간 검증됩니다 — 서버에 도착하는 것은 당신이 보낸 것과 바이트 단위로 동일합니다.",
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
        `# back up every night at 2am — add to your crontab (crontab -e)
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
        a: "아니요. push와 pull은 전적으로 당신 자신의 SSH 연결을 통해 실행됩니다. Relayium의 서버는 전혀 관여하지 않으며 계정도 필요 없습니다.",
      },
      {
        q: "서버에 relayium이 설치되어 있어야 하나요?",
        a: "선택 사항입니다. 원격에 relayium이 있으면 네이티브 프로토콜을 사용할 수 있습니다 — 재개 가능한 전송과 파일별 SHA-256 검사입니다. 없으면 relayium은 SSH를 통한 tar 스트림으로 대체되며, 여전히 동작하지만 각 파일을 항상 전체 전송합니다.",
      },
      {
        q: "어떤 SSH 키와 포트를 사용할지 어떻게 정하나요?",
        a: "ssh와 마찬가지로 당신의 ~/.ssh/config를 읽으므로, 호스트 별칭, 키, 포트가 자동으로 반영됩니다. 명령마다 -i로 신원 파일을, -p로 포트를 지정해 재정의할 수도 있습니다.",
      },
      {
        q: "이게 rsync보다 빠른가요?",
        a: "자신의 서버로 push하는 경우라면 SSH를 통한 rsync와 비슷한 수준입니다. 목표는 rsync를 이기는 것이 아니라, 같은 재개와 무결성 보장을 갖춘 채로 크로스 네트워크 전송과 서버 간 전송까지 함께 해내는 하나의 도구를 제공하는 것입니다.",
      },
    ],
  },
  cta: {
    text: "다음 디렉터리를 직접적인 방식으로 백업하세요 — 당신 자신의 SSH를 통해, 재개 가능하고, 무결성 검사가 되며, 무료입니다.",
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
        `# copy a local folder to the server
relayium push ./photos user@your-server:backups/

# choose an SSH key and a non-default port
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
        `# back up every night at 2am — add to your crontab (crontab -e)
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
        a: "Das ist optional. Mit relayium auf der Gegenseite bekommst du das native Protokoll — fortsetzbare Übertragungen und SHA-256-Prüfungen je Datei. Ohne das weicht relayium auf einen tar-Stream über SSH aus, der weiterhin funktioniert, aber jede Datei stets vollständig sendet.",
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
    "Ce guide couvre le push et le pull de répertoires, ce que la reprise et la vérification d'intégrité vous apportent, et comment lancer cela sur un calendrier avec cron.",
  ],
  sections: [
    {
      heading: "Pousser (push) un répertoire vers votre serveur",
      body: [
        "push prend une ou plusieurs sources et une destination de style scp. Relayium se connecte en SSH avec vos clés et votre configuration habituelles, puis diffuse les fichiers vers le répertoire de destination :",
      ],
      code: [
        `# copy a local folder to the server
relayium push ./photos user@your-server:backups/

# choose an SSH key and a non-default port
relayium push -i ~/.ssh/id_ed25519 -p 2222 ./photos user@your-server:backups/`,
      ],
      bullets: [
        "Il réutilise votre ~/.ssh/config, donc les alias d'hôtes, les clés et les ports déjà configurés fonctionnent tels quels.",
        "Si relayium est installé sur le serveur, il utilise le protocole natif : reprise par fichier et vérification SHA-256 sur chaque fichier.",
        "Sinon, il bascule sur l'envoi d'un flux tar par tube vers la machine distante, si bien qu'un serveur nu sans relayium fonctionne quand même.",
      ],
    },
    {
      heading: "Récupérer les fichiers avec pull",
      body: [
        "La restauration est la même commande en sens inverse : indiquez une source distante et un répertoire de destination local. C'est ainsi que vous récupérez une sauvegarde, ou que vous synchronisez la sortie d'un serveur vers votre portable :",
      ],
      code: ["relayium pull user@your-server:backups/ ./restore"],
    },
    {
      heading: "Reprise et intégrité intégrées d'office",
      body: [
        "Les sauvegardes ont tendance à être volumineuses, et les réseaux ont tendance à se couper. Quand relayium est présent des deux côtés, un transfert interrompu reprend là où il s'est arrêté lors de l'exécution suivante au lieu de tout renvoyer, et chaque fichier est vérifié de bout en bout par un hachage SHA-256 — ce qui arrive sur le serveur est identique octet pour octet à ce que vous avez envoyé.",
        "Si vous voulez un renvoi complet et propre plutôt que la reprise d'un fichier partiel, passez --no-resume.",
      ],
      bullets: [
        "La reprise nécessite relayium côté distant (le protocole natif) ; le repli tar envoie toujours l'intégralité.",
        "La vérification SHA-256 s'exécute automatiquement ; une divergence est signalée et le fichier est marqué en échec.",
      ],
    },
    {
      heading: "L'exécuter sur un calendrier avec cron",
      body: [
        "Comme push est une commande unique et non interactive qui utilise vos clés SSH, elle s'intègre directement dans cron pour une sauvegarde récurrente. Pointez-la vers une clé sans phrase de passe (ou vers un agent), et journalisez la sortie pour repérer les échecs :",
      ],
      code: [
        `# back up every night at 2am — add to your crontab (crontab -e)
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
        q: "Les fichiers passent-ils par les serveurs de Relayium ?",
        a: "Non. push et pull s'exécutent entièrement sur votre propre connexion SSH. Les serveurs de Relayium ne sont jamais impliqués et aucun compte n'est nécessaire.",
      },
      {
        q: "Le serveur a-t-il besoin de relayium installé ?",
        a: "C'est optionnel. Avec relayium côté distant, vous obtenez le protocole natif — transferts reprenables et vérifications SHA-256 par fichier. Sans cela, relayium bascule sur un flux tar via SSH, qui fonctionne toujours mais renvoie systématiquement chaque fichier en entier.",
      },
      {
        q: "Comment choisit-il quelle clé SSH et quel port utiliser ?",
        a: "Il lit votre ~/.ssh/config comme le fait ssh, si bien que les alias d'hôtes, les clés et les ports sont repris automatiquement. Vous pouvez aussi les surcharger par commande avec -i pour le fichier d'identité et -p pour le port.",
      },
      {
        q: "Est-ce plus rapide que rsync ?",
        a: "Pour pousser vers votre propre serveur, c'est dans le même ordre de grandeur que rsync via SSH ; l'objectif n'est pas de battre rsync mais de vous offrir un seul outil qui gère aussi les transferts entre réseaux et de serveur à serveur, avec les mêmes garanties de reprise et d'intégrité.",
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

export default {
  slug: "cli/back-up-a-server-over-ssh",
  updated: "2026-07-08",
  langs: { en, zh, ja, ko, de, fr },
};
