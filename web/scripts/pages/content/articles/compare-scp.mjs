// web/scripts/pages/content/articles/compare-scp.mjs
// Fair comparison: Relayium's push/pull CLI vs plain scp. English is the
// master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Command/code snippets stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Relayium vs scp: simpler file transfer over SSH",
  description:
    "scp is universal and preinstalled. Relayium's push/pull ride the same SSH but add resume, SHA-256 verification, progress, and a fallback for bare servers. A fair comparison.",
  updatedLabel: "Last updated",
  lead: [
    "scp has been the default way to move a file over SSH for decades: it's on almost every Unix-like machine already, everyone knows the syntax, and it just works. There's no reason to pretend otherwise — scp earned its place.",
    "Relayium's CLI doesn't replace SSH; it rides on top of the exact same SSH access you already have. push and pull use your SSH connection the same way scp does, but add a few things scp was never built to do: resuming a broken transfer, verifying every file with a checksum, showing real progress, and working even when the remote has nothing installed at all.",
  ],
  sections: [
    {
      heading: "Where scp is genuinely simpler",
      body: [
        "It's worth saying plainly: for a lot of jobs, scp is the right tool and adding anything else is overhead.",
      ],
      bullets: [
        "It's already installed — no binary to fetch, nothing to set up, on effectively every server you'll ever SSH into.",
        "It's battle-tested. Decades of use, well-understood behavior, and every sysadmin already knows the flags.",
        "For a genuine one-off — copy this one file, right now — typing scp file.txt user@host:path is less typing than installing anything.",
        "It's ideal for quick, throwaway scripting where you don't want a dependency beyond OpenSSH.",
      ],
    },
    {
      heading: "push / pull: the same SSH, with resume, checksums and progress",
      body: [
        "relayium push and relayium pull connect over the identical SSH access scp uses — same host, same key, same port. The difference is what happens once the connection is open.",
        "Every file is verified end to end with a SHA-256 hash after it arrives, so a transfer that looks done actually matches what was sent, byte for byte. If a transfer is interrupted — a dropped connection, a closed laptop lid — restarting the same command picks up from where it left off instead of resending everything, and you see real per-file progress the whole way, not a silent copy.",
        "The biggest practical difference is what happens when the remote doesn't have relayium installed. push checks for it automatically and, if it isn't there, falls back to streaming a plain tar archive over the same SSH connection into tar -x on the other end — so push still works against a completely bare server, nothing to install first. That fallback is push-only: pull always needs relayium already installed on the remote, because on a pull the remote machine is the one acting as the sender.",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Beyond SSH: daemon-direct and cross-network pairing",
      body: [
        "scp only ever works where you have SSH access. Relayium's CLI adds two more ways to move files that scp has no equivalent for.",
        "relayium serve turns a machine you own into a daemon-direct target reachable over pinned TLS 1.3 — no SSH, no port 22, trust established on the first connection (approved interactively, or pre-authorized with relayium authorize for unattended use) and pinned from then on. Push straight to it with a relayium:// address.",
        "For sending to someone across the internet who you don't have SSH access to at all, relayium send / receive pairs two computers with a short code instead — direct peer-to-peer, with an optional short verification code (SAS) both sides can compare first — --verify stops for it. scp has no answer for that case; you'd need SSH access first.",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf"],
    },
    {
      heading: "Folder mirroring: sync vs re-running scp -r",
      body: [
        "Copying a whole directory again and again with scp -r means re-sending everything every time, with no notion of what changed or what should be removed. relayium sync builds an incremental one-way mirror on top of push/pull or daemon-direct: only changed files move, --delete removes files on the destination that disappeared from the source, and --watch keeps re-syncing in real time as files change locally — no cron job needed.",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Availability: scp is preinstalled on virtually every server; Relayium's CLI is a single binary you install once with one command.",
        "Resume: scp restarts an interrupted transfer from scratch; push/pull resume from where they stopped.",
        "Integrity: scp doesn't verify contents after the fact; every Relayium transfer is checked with a per-file SHA-256 hash.",
        "Bare servers: scp needs nothing extra, and push works the same way via its tar fallback when relayium isn't installed remotely (pull needs relayium on the remote, no fallback).",
        "Beyond SSH: scp only works over SSH; Relayium also offers daemon-direct (pinned TLS, no SSH) and cross-network pairing-code transfers (send/receive) that need no SSH access at all.",
        "Folder mirroring: scp -r re-sends everything; relayium sync mirrors incrementally with --delete and --watch.",
        "Cost and license: both free; scp ships with OpenSSH, Relayium's CLI is AGPL-3.0-licensed and open source.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does Relayium's CLI need an account?",
        a: "Not for push/pull — it uses your own SSH access exactly like scp does, with no Relayium account and no sign-in, and the same goes for daemon-direct and sync. send and cloud up are the exceptions: send needs an account so the server can mint its pairing code (one given a code you were handed does not), and up needs one to store the file. Receiving never needs one.",
      },
      {
        q: "Does push work if the remote server doesn't have Relayium installed?",
        a: "Yes. push checks first and, if relayium isn't there, falls back to a plain tar stream over the same SSH connection so it still works against a bare server. That fallback is push-only — pull always needs relayium already installed on the remote, since the remote acts as the sender in a pull.",
      },
      {
        q: "Is it really as simple as scp to use?",
        a: "The commands look the same: relayium push src user@host:dest instead of scp -r src user@host:dest. The difference only shows up when something goes wrong — a dropped connection resumes instead of restarting, and every file is checksum-verified on arrival.",
      },
      {
        q: "When should I just use scp instead?",
        a: "For a genuine one-off copy where nothing needs to resume, nothing needs verifying, and you don't want any extra binary — scp is already there and is the simpler pick. It's also the safer default inside quick scripts where you don't want a new dependency.",
      },
      {
        q: "Is Relayium's CLI free?",
        a: "The CLI is AGPL-3.0-licensed and open source, and the modes this comparison is about — push, pull and daemon direct — connect the two ends directly with nothing metered and nothing to pay. The one command that draws on your Relayium plan is up, which stores an encrypted copy in hosted storage; scp has no equivalent.",
      },
    ],
  },
  cta: {
    text: "Install the free Relayium CLI and try push or pull over the SSH access you already have.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 scp：更简单的 SSH 文件传输",
  description:
    "scp 通用且预装在几乎所有系统上。Relayium 的 push/pull 走同一条 SSH，但增加了断点续传、SHA-256 校验、进度显示，以及针对裸机服务器的兜底方案。一次客观的对比。",
  updatedLabel: "最近更新",
  lead: [
    "几十年来，scp 一直是通过 SSH 传文件的默认方式：几乎装在你会用到的每一台类 Unix 机器上，人人都熟悉它的用法，而且一直很好用。没必要假装不是这样——scp 的地位是实至名归的。",
    "Relayium 的 CLI 并不是要取代 SSH，而是搭在你已经拥有的同一条 SSH 访问权限之上。push 和 pull 使用你的 SSH 连接的方式和 scp 一样，但补上了几件 scp 从未打算做的事：接续中断的传输、用校验和验证每个文件、显示真实进度，以及在远程什么都没安装的情况下依然能用。",
  ],
  sections: [
    {
      heading: "scp 确实更简单的场景",
      body: ["有必要坦白说：在很多任务里，scp 就是对的工具，加任何别的东西反而是负担。"],
      bullets: [
        "它已经装好了——不用下载任何二进制，不用做任何配置，几乎你会 SSH 进去的每台服务器上都有。",
        "它久经考验。几十年的使用积累、行为清晰可预期，每个系统管理员都已经熟悉它的参数。",
        "对于真正的一次性任务——现在就复制这一个文件——直接敲 scp file.txt user@host:path，比安装任何东西都省事。",
        "对于不想引入 OpenSSH 之外任何依赖的快速、一次性脚本，它是理想之选。",
      ],
    },
    {
      heading: "push / pull：同一条 SSH，加上断点续传、校验和进度",
      body: [
        "relayium push 和 relayium pull 走的是与 scp 完全相同的 SSH 访问——同一台主机、同一把密钥、同一个端口。区别在于连接建立之后发生了什么。",
        "每个文件到达后都会用 SHA-256 哈希做端到端校验，因此一个看起来完成了的传输，其内容确实和发出的一字不差。如果传输被打断——连接掉线、笔记本合上盖子——重新运行同一条命令会从中断处接着传，而不是全部重传，全程还能看到逐文件的真实进度，而不是悄无声息地拷贝。",
        "实际使用上最大的差别，是远程没装 relayium 时会发生什么。push 会自动检测，如果没装，就退化为通过同一条 SSH 连接把一个普通的 tar 归档流传到对端并执行 tar -x——因此 push 在完全裸机的服务器上依然可用，事先无需安装任何东西。这个兜底只属于 push：pull 始终需要远程已经装好 relayium，因为在 pull 里，远程机器才是充当发送方的一端。",
      ],
      code: [
        "relayium push ./photos user@your-server:backups/",
        "relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "超越 SSH：daemon 直连与跨网络配对",
      body: [
        "scp 只能在你拥有 SSH 访问权限的地方使用。Relayium 的 CLI 又加了两种 scp 没有对应能力的传输方式。",
        "relayium serve 能把你拥有的一台机器变成一个 daemon 直连目标，通过证书固定的 TLS 1.3 访问——无需 SSH、无需 22 端口，信任建立在第一次连接时（可交互批准，或用 relayium authorize 提前授权以支持无人值守），此后一直固定。用 relayium:// 地址直接向它 push。",
        "如果要发给一个你完全没有 SSH 访问权限、身处互联网另一端的人，relayium send / receive 则改用一个简短代码来配对两台电脑——直连点对点，并在两端都打印一段验证码（SAS），传输开始前双方核对确认。这种场景 scp 完全无解，你首先得有 SSH 访问权限才行。",
      ],
      code: ["relayium push ./build relayium://your-server", "relayium send ./report.pdf"],
    },
    {
      heading: "文件夹镜像：sync 对比反复运行 scp -r",
      body: [
        "反复用 scp -r 拷贝整个目录，意味着每次都要重传所有内容，也没有「发生了什么变化」或「该删除什么」的概念。relayium sync 在 push/pull 或 daemon 直连之上构建增量单向镜像：只传发生变化的文件；--delete 会删除目标端上源端已经消失的文件；--watch 会在本地文件变化时实时持续重新同步——不需要额外的定时任务。",
      ],
      code: ["relayium sync ./photos user@your-server:backups/photos --delete --watch"],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "可用性：scp 几乎预装在所有服务器上；Relayium 的 CLI 是单一二进制，一条命令安装一次即可。",
        "断点续传：scp 中断的传输要从头开始；push/pull 会从中断处继续。",
        "完整性：scp 事后不会校验内容；Relayium 的每次传输都会做逐文件的 SHA-256 校验。",
        "裸机服务器：scp 不需要任何额外东西；远程未装 relayium 时，push 通过 tar 兜底同样能用（pull 需要远程装有 relayium，没有兜底）。",
        "超越 SSH：scp 只能走 SSH；Relayium 还提供 daemon 直连（证书固定 TLS，无需 SSH）以及完全不需要 SSH 访问权限的跨网络配对码传输（send/receive）。",
        "文件夹镜像：scp -r 每次都重传所有内容；relayium sync 支持 --delete 与 --watch 的增量镜像。",
        "费用与许可：两者都免费；scp 随 OpenSSH 一起提供，Relayium 的 CLI 采用 AGPL-3.0 许可并开源。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 的 CLI 需要账号吗？",
        a: "push/pull 不需要——它使用你自己的 SSH 访问权限，方式和 scp 完全一样，不需要 Relayium 账号，也不需要登录；daemon 直连和 sync 同样如此。send 和云端 up 是例外：send 需要账号，好让服务器签发配对码（如果用的是别人给你的码则不需要），up 需要账号来存文件。接收则从不需要。",
      },
      {
        q: "如果远程服务器没装 Relayium，push 还能用吗？",
        a: "可以。push 会先检测，如果 relayium 不在，就会退化为通过同一条 SSH 连接传输一段普通的 tar 流，因此在裸机服务器上依然可用。这个兜底只属于 push——pull 始终需要远程已经装好 relayium，因为在 pull 里远程要充当发送方。",
      },
      {
        q: "用起来真的和 scp 一样简单吗？",
        a: "命令形式很相近：relayium push src user@host:dest，对应 scp -r src user@host:dest。区别只会在出问题时体现出来——连接掉线时会续传而不是重来，且每个文件到达后都会做校验和验证。",
      },
      {
        q: "什么时候该直接用 scp？",
        a: "对于真正的一次性拷贝——不需要续传，不需要校验，也不想引入额外的二进制——scp 本来就在那里，是更简单的选择。它也是快速脚本里更稳妥的默认项，不想引入新依赖时尤其如此。",
      },
      {
        q: "Relayium 的 CLI 免费吗？",
        a: "CLI 采用 AGPL-3.0 许可并开源，本文对比涉及的 push、pull 与 daemon 直连都是两端直接连接，不计量，也不收费。唯一会用到 Relayium 套餐的是 up：它把加密副本存入托管存储；scp 没有对应功能。",
      },
    ],
  },
  cta: {
    text: "安装免费的 Relayium CLI，在你已有的 SSH 访问权限上试试 push 或 pull。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と scp の比較：Relayium の SSH 転送は廃止されました",
  description: "このアーカイブの比較は、廃止された Relayium の SSH 経由の push/pull を扱っていました。scp は引き続き SSH でのコピーの道具です。Relayium は現在、serve と relayium:// への push または sync で、自分で管理するマシンへコピーします。",
  updatedLabel: "最終更新",
  lead: [
    "過去の記述についての注記：この比較では、Relayium の SSH 経由の push と pull（scp と同じ SSH アクセスを使い、relayium のないサーバーには tar でフォールバックするもの）を説明していました。現在の CLI ではこの転送方式は relayium pull、-i、-p とともに廃止され、「SSH transfers are currently disabled」と表示して拒否されるため、ここにあったコマンドはもう動作せず、掲載していません。",
    "SSH でファイルをコピーしたいなら、scp は今も素直な選択です。ページ上部からリンクしている、保守されている英語版と簡体字中国語版が、Relayium が現在提供するものと比較しています。証明書ピンニング付き TLS での relayium serve と relayium://host への push または sync、SSH アクセス不要のペアリングコード、そしてオフラインの受信者への暗号化された配信です。"
  ],
  sections: [
    {
      heading: "SSH の代わりに Relayium が提供するもの",
      body: [
        "自分で管理するマシンで relayium serve を実行し、その relayium:// アドレスへ証明書ピンニング付き TLS で push または sync します。SSH アカウントも 22 番ポートも関係しません。"
      ],
      code: [
        "relayium serve --dir ~/incoming",
        "relayium push ./photos relayium://server.example",
        "relayium sync ./photos relayium://server.example --watch"
      ]
    }
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "relayium の push や pull を SSH 経由でまだ使えますか？",
        a: "いいえ。現在の CLI は、SSH の宛先と relayium pull を、1バイトも転送する前に拒否します。SSH でコピーするなら scp を、自分で管理するマシンの間では relayium serve と relayium:// への push または sync を使ってください。"
      }
    ]
  },
  cta: {
    text: "Relayium CLI をインストールして、デーモン直結の push や sync を試してみましょう。",
    button: "CLI を入手",
    href: "/cli"
  },
  relatedHeading: "続けて読む"
};

const ko = {
  title: "Relayium vs scp: Relayium의 SSH 전송은 폐지되었습니다",
  description: "이 보관된 비교는 폐지된 Relayium의 SSH 기반 push/pull을 다뤘습니다. scp는 여전히 SSH 복사 도구이며, Relayium은 이제 serve와 relayium://로의 push 또는 sync로 직접 관리하는 기기에 복사합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "이전 내용에 대한 안내: 이 비교는 Relayium의 SSH 기반 push와 pull(scp와 같은 SSH 접근을 쓰고, relayium이 없는 서버에는 tar로 대체하던 방식)을 설명했습니다. 현재 CLI에서는 이 전송 방식이 relayium pull, -i, -p와 함께 폐지되어 \"SSH transfers are currently disabled\"라는 메시지와 함께 거부되므로, 여기에 있던 명령은 더 이상 동작하지 않으며 싣지 않습니다.",
    "SSH로 파일을 복사하고 싶다면 scp는 여전히 간단한 선택입니다. 페이지 상단에서 링크한, 유지 관리되는 영어판과 중국어 간체판이 Relayium이 지금 제공하는 것과 비교합니다. 인증서 고정 TLS를 통한 relayium serve와 relayium://host로의 push 또는 sync, SSH 접근이 필요 없는 페어링 코드, 그리고 오프라인 수신자에게 보내는 암호화 전달입니다."
  ],
  sections: [
    {
      heading: "SSH 대신 Relayium이 제공하는 것",
      body: [
        "직접 관리하는 기기에서 relayium serve를 실행하고, 그 relayium:// 주소로 인증서 고정 TLS를 통해 push 또는 sync합니다. SSH 계정도 22번 포트도 필요 없습니다."
      ],
      code: [
        "relayium serve --dir ~/incoming",
        "relayium push ./photos relayium://server.example",
        "relayium sync ./photos relayium://server.example --watch"
      ]
    }
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "relayium push나 pull을 아직 SSH로 쓸 수 있나요?",
        a: "아니요. 현재 CLI는 SSH 대상과 relayium pull을 바이트를 하나도 전송하기 전에 거부합니다. SSH로 복사하려면 scp를, 직접 관리하는 기기 사이에서는 relayium serve와 relayium://로의 push 또는 sync를 사용하세요."
      }
    ]
  },
  cta: {
    text: "Relayium CLI를 설치하고 데몬 다이렉트 push나 sync를 써보세요.",
    button: "CLI 받기",
    href: "/cli"
  },
  relatedHeading: "계속 읽기"
};

const de = {
  title: "Relayium vs. scp: Relayiums SSH-Transport ist eingestellt",
  description: "Dieser archivierte Vergleich beschrieb Relayiums push/pull über SSH, das eingestellt ist. scp bleibt das Werkzeug für SSH-Kopien; Relayium kopiert heute mit serve und push oder sync zu relayium:// auf Rechner, die du verwaltest.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Historischer Hinweis: Dieser Vergleich beschrieb Relayiums push und pull über SSH — mit demselben SSH-Zugang, den scp nutzt, und einem tar-Fallback für Server ohne relayium. Die aktuelle CLI hat diesen Transport samt relayium pull, -i und -p eingestellt und lehnt ihn mit „SSH transfers are currently disabled“ ab; die Befehle, die hier standen, funktionieren daher nicht mehr und werden nicht mehr gezeigt.",
    "Für Dateikopien über SSH bleibt scp die naheliegende Wahl. Die gepflegte englische und vereinfacht-chinesische Fassung dieser Seite, oben verlinkt, vergleichen es mit dem, was Relayium heute bietet: relayium serve mit push oder sync zu relayium://host über TLS mit Pinning, Pairing-Codes ohne SSH-Zugang und verschlüsselte Zustellung an einen Empfänger, der offline ist."
  ],
  sections: [
    {
      heading: "Was Relayium statt SSH bietet",
      body: [
        "Starte relayium serve auf einem Rechner, den du verwaltest, und pushe oder synchronisiere über TLS mit Pinning an seine relayium://-Adresse; weder ein SSH-Konto noch Port 22 sind beteiligt."
      ],
      code: [
        "relayium serve --dir ~/incoming",
        "relayium push ./photos relayium://server.example",
        "relayium sync ./photos relayium://server.example --watch"
      ]
    }
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kann ich relayium push oder pull noch über SSH nutzen?",
        a: "Nein. Die aktuelle CLI lehnt SSH-Ziele und relayium pull ab, bevor ein Byte übertragen wird. Für eine SSH-Kopie nimm scp; zwischen Rechnern, die du verwaltest, relayium serve mit push oder sync zu relayium://."
      }
    ]
  },
  cta: {
    text: "Installiere die Relayium CLI und probiere daemon-direct push oder sync.",
    button: "CLI holen",
    href: "/cli"
  },
  relatedHeading: "Weiterlesen"
};

const fr = {
  title: "Relayium vs scp : le transport SSH de Relayium est retiré",
  description: "Ce comparatif archivé décrivait le push/pull de Relayium via SSH, désormais retiré. scp reste l'outil de copie SSH ; Relayium copie aujourd'hui vers des machines que vous gérez avec serve et push ou sync vers relayium://.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Note historique : ce comparatif décrivait le push et le pull de Relayium via SSH — le même accès SSH que scp, avec un repli tar pour les serveurs sans relayium. La CLI actuelle a retiré ce transport, ainsi que relayium pull, -i et -p, et le refuse avec « SSH transfers are currently disabled » ; les commandes qui figuraient ici ne fonctionnent donc plus et ne sont plus affichées.",
    "Pour copier des fichiers via SSH, scp reste le choix le plus simple. Les versions anglaise et chinoise simplifiée maintenues de cette page, liées en haut, le comparent à ce que Relayium propose aujourd'hui : relayium serve avec push ou sync vers relayium://host via TLS avec épinglage, des codes d'appairage sans accès SSH, et une livraison chiffrée à un destinataire hors ligne."
  ],
  sections: [
    {
      heading: "Ce que Relayium propose à la place de SSH",
      body: [
        "Lancez relayium serve sur une machine que vous gérez, puis faites push ou sync vers son adresse relayium:// via TLS avec épinglage ; ni compte SSH ni port 22 n'entrent en jeu."
      ],
      code: [
        "relayium serve --dir ~/incoming",
        "relayium push ./photos relayium://server.example",
        "relayium sync ./photos relayium://server.example --watch"
      ]
    }
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Puis-je encore utiliser relayium push ou pull via SSH ?",
        a: "Non. La CLI actuelle refuse les destinations SSH et relayium pull avant de transférer le moindre octet. Pour une copie SSH, utilisez scp ; entre machines que vous gérez, relayium serve avec push ou sync vers relayium://."
      }
    ]
  },
  cta: {
    text: "Installez la CLI Relayium et essayez push ou sync en daemon-direct.",
    button: "Obtenir la CLI",
    href: "/cli"
  },
  relatedHeading: "À lire ensuite"
};

const ar = {
  title: "Relayium مقابل scp: أُوقف نقل SSH في Relayium",
  description: "كانت هذه المقارنة المؤرشفة تشرح push/pull في Relayium عبر SSH، وقد أُوقف. يظل scp أداة النسخ عبر SSH؛ أما Relayium فينسخ الآن إلى أجهزة تديرها باستخدام serve مع push أو sync إلى relayium://.",
  updatedLabel: "آخر تحديث",
  lead: [
    "ملاحظة تاريخية: كانت هذه المقارنة تشرح push وpull في Relayium عبر SSH — بوصول SSH نفسه الذي يستخدمه scp، مع تراجع إلى tar للخوادم التي لا يوجد عليها relayium. وقد أوقف CLI الحالي هذا النقل مع relayium pull والخيارين -i و-p، ويرفضه برسالة «SSH transfers are currently disabled»، لذا لم تعد الأوامر التي كانت هنا تعمل ولم تعد معروضة.",
    "إن أردت نسخ الملفات عبر SSH فيظل scp الخيار المباشر. وتقارنه النسختان الإنجليزية والصينية المبسّطة المُحدَّثتان من هذه الصفحة، المرتبطتان في أعلاها، بما يقدّمه Relayium الآن: relayium serve مع push أو sync إلى relayium://host عبر TLS مُثبَّت، ورموز اقتران لا تحتاج وصول SSH، وتسليم مُشفَّر إلى مستلم غير متصل."
  ],
  sections: [
    {
      heading: "ما يقدّمه Relayium بدلًا من SSH",
      body: [
        "شغّل relayium serve على جهاز تديره، ثم استخدم push أو sync نحو عنوانه relayium:// عبر TLS مُثبَّت؛ لا حساب SSH ولا المنفذ 22."
      ],
      code: [
        "relayium serve --dir ~/incoming",
        "relayium push ./photos relayium://server.example",
        "relayium sync ./photos relayium://server.example --watch"
      ]
    }
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل ما زال بإمكاني استخدام relayium push أو pull عبر SSH؟",
        a: "لا. يرفض CLI الحالي وجهات SSH وrelayium pull قبل نقل أي بايت. للنسخ عبر SSH استخدم scp؛ وبين أجهزة تديرها استخدم relayium serve مع push أو sync إلى relayium://."
      }
    ]
  },
  cta: {
    text: "ثبّت Relayium CLI وجرّب push أو sync عبر daemon direct.",
    button: "احصل على الواجهة السطرية",
    href: "/cli"
  },
  relatedHeading: "تابع القراءة"
};

const es = {
  title: "Relayium vs scp: el transporte SSH de Relayium está retirado",
  description: "Esta comparación archivada describía el push/pull de Relayium por SSH, que está retirado. scp sigue siendo la herramienta de copia por SSH; Relayium ahora copia a máquinas que administras con serve y push o sync a relayium://.",
  updatedLabel: "Última actualización",
  lead: [
    "Nota histórica: esta comparación describía el push y el pull de Relayium por SSH — el mismo acceso SSH que usa scp, con una alternativa tar para servidores sin relayium. El CLI actual ha retirado ese transporte, junto con relayium pull, -i y -p, y lo rechaza con «SSH transfers are currently disabled», así que los comandos que había aquí ya no funcionan y no se muestran.",
    "Para copiar archivos por SSH, scp sigue siendo la opción directa. Las versiones mantenidas en inglés y en chino simplificado de esta página, enlazadas arriba, lo comparan con lo que ofrece Relayium ahora: relayium serve con push o sync a relayium://host sobre TLS con anclaje, códigos de emparejamiento sin acceso SSH y entrega cifrada a un destinatario desconectado."
  ],
  sections: [
    {
      heading: "Lo que ofrece Relayium en lugar de SSH",
      body: [
        "Ejecuta relayium serve en una máquina que administres y haz push o sync a su dirección relayium:// sobre TLS con anclaje; no intervienen ni una cuenta SSH ni el puerto 22."
      ],
      code: [
        "relayium serve --dir ~/incoming",
        "relayium push ./photos relayium://server.example",
        "relayium sync ./photos relayium://server.example --watch"
      ]
    }
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Puedo seguir usando relayium push o pull por SSH?",
        a: "No. El CLI actual rechaza los destinos SSH y relayium pull antes de transferir un solo byte. Para una copia por SSH, usa scp; entre máquinas que administras, relayium serve con push o sync a relayium://."
      }
    ]
  },
  cta: {
    text: "Instala la CLI de Relayium y prueba push o sync con daemon directo.",
    button: "Obtener la CLI",
    href: "/cli"
  },
  relatedHeading: "Sigue leyendo"
};

const pt = {
  title: "Relayium vs scp: o transporte SSH do Relayium foi descontinuado",
  description: "Esta comparação arquivada descrevia o push/pull do Relayium por SSH, que foi descontinuado. O scp continua sendo a ferramenta de cópia por SSH; o Relayium agora copia para máquinas que você administra com serve e push ou sync para relayium://.",
  updatedLabel: "Última atualização",
  lead: [
    "Nota histórica: esta comparação descrevia o push e o pull do Relayium por SSH — o mesmo acesso SSH que o scp usa, com uma alternativa tar para servidores sem relayium. A CLI atual descontinuou esse transporte, junto com relayium pull, -i e -p, e o recusa com “SSH transfers are currently disabled”, então os comandos que estavam aqui não funcionam mais e não são mostrados.",
    "Para copiar arquivos por SSH, o scp continua sendo a escolha direta. As versões mantidas em inglês e chinês simplificado desta página, com links no topo, o comparam com o que o Relayium oferece agora: relayium serve com push ou sync para relayium://host sobre TLS com fixação, códigos de pareamento sem acesso SSH e entrega criptografada para um destinatário offline."
  ],
  sections: [
    {
      heading: "O que o Relayium oferece no lugar do SSH",
      body: [
        "Rode relayium serve em uma máquina que você administra e faça push ou sync para o endereço relayium:// dela sobre TLS com fixação; nem conta SSH nem porta 22 entram na história."
      ],
      code: [
        "relayium serve --dir ~/incoming",
        "relayium push ./photos relayium://server.example",
        "relayium sync ./photos relayium://server.example --watch"
      ]
    }
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Ainda posso usar relayium push ou pull por SSH?",
        a: "Não. A CLI atual recusa destinos SSH e relayium pull antes de transferir qualquer byte. Para uma cópia por SSH, use scp; entre máquinas que você administra, relayium serve com push ou sync para relayium://."
      }
    ]
  },
  cta: {
    text: "Instale a CLI do Relayium e experimente push ou sync com daemon direto.",
    button: "Obter a CLI",
    href: "/cli"
  },
  relatedHeading: "Continue lendo"
};

const currentEn = {
  title: "Relayium vs scp: daemon-direct and pairing-code transfer compared with SSH",
  description: "scp remains the SSH copy tool. Relayium's current CLI uses pinned-TLS daemon-direct, pairing codes, Device Inbox or encrypted Cloud links instead of SSH transport.",
  updatedLabel: "Last updated",
  lead: ["scp is the straightforward choice when you already want SSH file copy. Relayium no longer wraps SSH: SSH destinations, pull, -i and -p are retired.", "Choose Relayium when pinned-TLS server transfer, pairing without SSH access, asynchronous encrypted delivery or one-way daemon-direct mirroring fits the task."],
  sections: [
    { heading: "The practical difference", body: ["scp copies through SSH. Relayium push and sync connect only to a relayium serve listener at a relayium:// address; send/receive uses a short pairing code between two online ends — the CLI, a Relayium app or the web page."], code: ["scp -r ./photos user@server:backups/", "relayium push ./photos relayium://server.example", "relayium sync ./photos relayium://server.example --watch"] },
    { heading: "Use scp when", bullets: ["SSH is already the required trust and network boundary.", "You want an ad-hoc copy with no additional listener.", "You need to copy from the remote machine with ordinary SSH syntax; Relayium pull is unavailable."] },
    { heading: "Use Relayium when", bullets: ["You manage both machines and want an explicitly authorized pinned-TLS listener.", "You want incremental one-way sync with cross-run partial-file continuation.", "You need pairing-code transfer without granting SSH access, or encrypted hosted delivery to an offline recipient."] },
  ],
  faq: { heading: "Frequently asked questions", items: [
    { q: "Does Relayium still use SSH?", a: "No. Current push and sync accept relayium:// only; pull, -i and -p are retired." },
    { q: "Does Relayium need an account?", a: "Daemon-direct push/sync does not. Minting a send/text code and uploading with up do; joining with a code or downloading a link does not." },
    { q: "Which is free?", a: "Both tools are free software. Relayium direct paths have no per-transfer charge; hosted paths consume plan allowances, which is usage accounting rather than a separate transfer fee." },
  ] },
  cta: { text: "Choose the transport that matches your trust boundary.", button: "Get the CLI", href: "/cli" },
  relatedHeading: "Keep reading",
};

const currentZh = {
  title: "Relayium 与 scp：daemon 直连、配对码传输和 SSH 的对比",
  description: "scp 仍是 SSH 复制工具。Relayium 当前 CLI 使用证书固定的 daemon 直连、配对码、设备收件箱或加密云端链接，不再使用 SSH 传输。",
  updatedLabel: "最近更新",
  lead: ["如果你本来就要通过 SSH 复制文件，scp 是直接选择。Relayium 不再封装 SSH：SSH 目标、pull、-i 与 -p 均已退役。", "需要证书固定的服务器传输、无需 SSH 权限的配对、异步加密投递或单向 daemon 镜像时，再选择 Relayium。"],
  sections: [
    { heading: "实际区别", body: ["scp 通过 SSH 复制。Relayium push 与 sync 只连接 relayium:// 地址上的 relayium serve 监听端；send/receive 用短配对码连接两台在线设备——CLI、Relayium 应用或网页均可。"], code: ["scp -r ./photos user@server:backups/", "relayium push ./photos relayium://server.example", "relayium sync ./photos relayium://server.example --watch"] },
    { heading: "适合用 scp 的情况", bullets: ["SSH 本来就是要求的信任与网络边界。", "你要一次临时复制，不想再运行监听器。", "你需要用普通 SSH 语法从远端复制；Relayium pull 已不可用。"] },
    { heading: "适合用 Relayium 的情况", bullets: ["你管理两台机器，并希望使用显式授权、证书固定 TLS 的监听端。", "你要增量单向 sync，并允许跨运行继续半截文件。", "你要在不授予 SSH 权限的情况下配对传输，或向离线接收方发送加密托管文件。"] },
  ],
  faq: { heading: "常见问题", items: [
    { q: "Relayium 还使用 SSH 吗？", a: "不使用。当前 push 与 sync 只接受 relayium://；pull、-i 与 -p 已退役。" },
    { q: "Relayium 需要账号吗？", a: "daemon 直连 push/sync 不需要。生成 send/text 配对码与用 up 上传需要；用码加入或用链接下载不需要。" },
    { q: "哪个免费？", a: "两者都是自由软件。Relayium 直连路径不按次收费；托管路径占用套餐额度，这表示用量记账，不是另外收取传输费。" },
  ] },
  cta: { text: "按你的信任边界选择传输方式。", button: "获取 CLI", href: "/cli" },
  relatedHeading: "继续阅读",
};

export default {
  slug: "compare/scp",
  published: "2026-07-09",
  updated: "2026-07-12",
  langs: withInstall({ en: currentEn, zh: currentZh, ja, ko, de, fr, ar, es, pt }),
};
