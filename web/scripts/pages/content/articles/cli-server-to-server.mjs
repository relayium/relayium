// web/scripts/pages/content/articles/cli-server-to-server.mjs
// How-to: server-to-server transfers with relayium daemon direct (serve + push relayium://).
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Server-to-server transfers with the Relayium CLI (daemon direct)",
  description:
    "Move files straight between two servers you control with relayium serve and push relayium:// — over pinned TLS, no relay, no SSH, no code. Approve a new pusher once on its first push, then automate it or run it under systemd.",
  updatedLabel: "Last updated",
  lead: [
    "When both machines are yours and each knows the other's address, SSH is extra friction and a rendezvous is pure overhead. Daemon direct is built for exactly this: one server listens, the other pushes straight to it over a pinned TLS 1.3 connection. No relay, no SSH, no pairing code — trust is public-key and set up once.",
    "This guide covers starting the listener, pushing to it, approving a new pusher on first contact, automating it, and running the listener as a systemd service.",
  ],
  sections: [
    {
      heading: "Start the listener (on the receiver)",
      body: [
        "On the receiving server, serve listens for pushes and writes them into a directory. It's long-running by default; add --once to accept a single transfer and exit. You don't pre-share anything — no fingerprints to copy up front:",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "The listener processes connections one at a time and lands files under --dir.",
        "The default port is 9031; change it with --port and open it on your firewall.",
      ],
    },
    {
      heading: "Push to it (on the sender)",
      body: [
        "From the sending server, push to the receiver's relayium:// address. The first connection pins the receiver's fingerprint; every connection after that verifies it, and a changed fingerprint is refused rather than silently accepted — so a swapped key or a man-in-the-middle is caught, not trusted. On the very first push, the sender waits a moment while the receiver approves it (next step).",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "No relay and no fallback: if the listener isn't reachable, the push fails — file bytes never route through anyone else.",
        "The same transfer engine as the other modes: resumable, with a per-file SHA-256 check.",
      ],
    },
    {
      heading: "Approve the sender on first push (on the receiver)",
      body: [
        "The first time a new machine pushes to your listener, serve (in a terminal) shows you where it's from and its fingerprint and asks you to approve it — like SSH's first-connect prompt, but on the receiving side:",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Answer y and that fingerprint is remembered in authorized_fingerprints; every later push from the same machine then goes through silently.",
        "The fingerprint is a machine's stable identity (it survives restarts and IP changes), so approving is a one-time step per pusher.",
        "The pusher, in turn, learns the listener's key on first connect (trust on first use) and pins it in known_hosts.",
      ],
    },
    {
      heading: "Automate it (or run without a terminal)",
      body: [
        "Because an approved fingerprint is remembered, later pushes need no prompt — so relayium push drops straight into cron, a deploy script, or CI for encrypted, integrity-checked, resumable server-to-server sync. When serve runs without a terminal (a systemd service, a pipe) it can't prompt, so it rejects unknown pushers; pre-authorize them instead. Get the fingerprint from the pusher's relayium id, or copy it from the \"rejected unauthorized peer …\" line in the serve log, then:",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Identity and trust files live in ~/.config/relayium/ (override with --config-dir, e.g. /etc/relayium for a service).",
        "authorize is idempotent — running it again for the same fingerprint is a no-op.",
      ],
    },
    {
      heading: "Run the listener under systemd",
      body: [
        "For an always-on inbox, run serve as a systemd service. Point --config-dir at a fixed location like /etc/relayium so the identity is stable across restarts, and let systemd keep it alive:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve to start it and bring it up on boot.",
        "Keep /etc/relayium/id.key readable only by the service user — relayium refuses to load a key with loose permissions.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "How is daemon direct different from push over SSH?",
        a: "push over SSH tunnels the transfer through your SSH connection and needs an SSH account on the remote. Daemon direct needs no SSH and no account — the two servers authenticate each other by certificate fingerprint over pinned TLS, which is lighter when both machines are yours.",
      },
      {
        q: "Do I have to copy fingerprints around by hand?",
        a: "No. In a terminal, serve prompts you to approve each new pusher on its first push — showing its address and fingerprint — and remembers it, so later pushes are silent. You only reach for relayium id or relayium authorize for non-interactive setups like a systemd service, where there's no one to answer the prompt.",
      },
      {
        q: "Where are the identity and trust files?",
        a: "In ~/.config/relayium/ by default (override with --config-dir). id.key / id.crt are this host's persistent identity, known_hosts holds fingerprints of listeners you've pushed to, and authorized_fingerprints is the listener's allow-list of pushers.",
      },
      {
        q: "What happens if a fingerprint changes?",
        a: "The push refuses and warns. The listener's key is pinned in known_hosts on first use, so a later change — a re-keyed host, or a man-in-the-middle — is rejected rather than silently accepted. Remove the known_hosts line only if you intentionally rotated the key.",
      },
      {
        q: "Is there any relay fallback?",
        a: "No. Daemon direct assumes a reachable listener address; if the connection can't be made, it fails. Nothing is ever proxied through Relayium — that's the point of this mode.",
      },
    ],
  },
  cta: {
    text: "Wire up two of your own servers for direct transfers — no relay, no SSH, no pairing code.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 实现服务器到服务器直传（守护进程直连）",
  description:
    "用 relayium serve 和 push relayium:// 在你自己掌控的两台服务器之间直接搬运文件——基于锁定的 TLS，无需中继、无需 SSH、无需代码。在新的推送方首次推送时批准一次，之后即可自动化，或在 systemd 下运行。",
  updatedLabel: "最近更新",
  lead: [
    "当两台机器都是你自己的，并且彼此知道对方地址时，SSH 是多余的摩擦，中转撮合纯属多余开销。守护进程直连正是为此而生：一台服务器监听，另一台通过锁定的 TLS 1.3 连接直接推送过去。无需中继、无需 SSH、无需配对码——信任基于公钥，只需设置一次。",
    "本指南涵盖启动监听端、向其推送、在首次联系时批准新的推送方、实现自动化，以及把监听端作为 systemd 服务运行。",
  ],
  sections: [
    {
      heading: "启动监听端（在接收方）",
      body: [
        "在接收方服务器上，serve 监听推送并把它们写入某个目录。它默认长期运行；加上 --once 可以只接受一次传输就退出。你不需要预先共享任何东西——不用提前复制任何指纹：",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "监听端依次处理连接，并把文件落到 --dir 指定的目录下。",
        "默认端口是 9031；可用 --port 修改，并在防火墙上开放该端口。",
      ],
    },
    {
      heading: "向监听端推送（在发送方）",
      body: [
        "从发送方服务器，推送到接收方的 relayium:// 地址。第一次连接会锁定接收方的指纹；此后每次连接都会校验它，指纹一旦变化就会被拒绝而不是被默默接受——因此密钥被替换或中间人攻击会被发现，而不是被信任。在第一次推送时，发送方会稍等片刻，等待接收方批准（下一步）。",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "没有中继，也没有回退：如果监听端无法到达，推送就会失败——文件字节永远不会经过其他任何人转发。",
        "使用与其他模式相同的传输引擎：可续传，并对每个文件做 SHA-256 校验。",
      ],
    },
    {
      heading: "在首次推送时批准发送方（在接收方）",
      body: [
        "当一台新机器第一次向你的监听端推送时，serve（在终端中）会显示它的来源和指纹，并请你批准它——就像 SSH 首次连接时的提示，只不过是在接收方这一侧：",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "回答 y，该指纹就会被记录到 authorized_fingerprints 中；此后同一台机器的每次推送都会静默通过。",
        "指纹是一台机器的稳定身份（重启和 IP 变化都不受影响），因此批准对每个推送方来说只是一次性的步骤。",
        "推送方则在首次连接时获知监听端的密钥（首次使用即信任），并将其锁定在 known_hosts 中。",
      ],
    },
    {
      heading: "实现自动化（或在没有终端的环境下运行）",
      body: [
        "由于已批准的指纹会被记住，后续推送不再需要确认——因此 relayium push 可以直接接入 cron、部署脚本或 CI，实现加密、可校验完整性、可续传的服务器到服务器同步。当 serve 在没有终端的环境下运行（作为 systemd 服务、通过管道）时，它无法弹出提示，因此会拒绝未知的推送方；这时应改为预先授权它们。可以从推送方的 relayium id 获取指纹，或者从 serve 日志中 “rejected unauthorized peer …” 那一行复制它，然后：",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "身份和信任文件存放在 ~/.config/relayium/ 中（可用 --config-dir 覆盖，例如作为服务时用 /etc/relayium）。",
        "authorize 是幂等的——对同一个指纹再次运行它不会有任何效果。",
      ],
    },
    {
      heading: "在 systemd 下运行监听端",
      body: [
        "要做一个常驻收件箱，把 serve 作为 systemd 服务运行。把 --config-dir 指向一个固定位置，例如 /etc/relayium，让身份在重启之间保持稳定，并交给 systemd 来保活：",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "用 systemctl enable --now relayium-serve 启动它，并让它开机自启。",
        "让 /etc/relayium/id.key 只能被服务用户读取——权限过于宽松时 relayium 会拒绝加载该密钥。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "守护进程直连和通过 SSH 推送有什么不同？",
        a: "通过 SSH 推送会把传输隧道进你的 SSH 连接，并且需要在远端有一个 SSH 账号。守护进程直连不需要 SSH，也不需要账号——两台服务器通过锁定的 TLS，用证书指纹互相验证身份，当两台机器都是你自己的时候，这样更轻量。",
      },
      {
        q: "我需要手动到处复制指纹吗？",
        a: "不需要。在终端中，serve 会在每个新推送方首次推送时提示你批准它——显示其地址和指纹——并记住它，因此后续推送是静默的。只有在没有终端的非交互式场景（比如作为 systemd 服务运行，没有人来回应提示）时，你才需要用到 relayium id 或 relayium authorize。",
      },
      {
        q: "身份和信任文件在哪里？",
        a: "默认在 ~/.config/relayium/ 中（可用 --config-dir 覆盖）。id.key / id.crt 是这台主机的持久身份，known_hosts 保存着你推送过的监听端的指纹，authorized_fingerprints 则是监听端的推送方允许列表。",
      },
      {
        q: "指纹变化了会怎样？",
        a: "推送会被拒绝并发出警告。监听端的密钥在首次使用时就被锁定在 known_hosts 中，因此之后的变化——无论是主机重新生成了密钥，还是中间人攻击——都会被拒绝而不是被默默接受。只有在你确实主动轮换了密钥时，才应删除 known_hosts 中对应的那一行。",
      },
      {
        q: "有没有中继回退？",
        a: "没有。守护进程直连假定监听端地址是可达的；如果无法建立连接，就会失败。任何数据都绝不会经由 Relayium 代理——这正是这个模式的意义所在。",
      },
    ],
  },
  cta: {
    text: "把你自己的两台服务器接起来做直接传输——无需中继、无需 SSH、无需配对码。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI でサーバー間転送(デーモン直結)",
  description:
    "relayium serve と push relayium:// を使い、あなたが管理する2台のサーバー間でファイルを直接やり取りします——固定された TLS 上で、リレーも SSH もコードも不要です。新しいプッシュ側が最初にプッシュしたときに一度だけ承認し、その後は自動化するか systemd の下で実行します。",
  updatedLabel: "最終更新",
  lead: [
    "両方のマシンが自分のもので、互いのアドレスを知っている場合、SSH は余計な手間であり、集合場所を介するのは純粋なオーバーヘッドです。デーモン直結はまさにこのために作られています。一方のサーバーが待ち受け、もう一方が固定された TLS 1.3 接続でそこへ直接プッシュします。リレーも SSH もペアリングコードも不要——信頼は公開鍵によるもので、一度設定すれば済みます。",
    "本ガイドではリスナーの起動、そこへのプッシュ、初回接触時に新しいプッシュ側を承認すること、自動化、そしてリスナーを systemd サービスとして実行する方法を扱います。",
  ],
  sections: [
    {
      heading: "リスナーを起動する(受信側)",
      body: [
        "受信側のサーバーでは、serve がプッシュを待ち受け、あるディレクトリへ書き込みます。デフォルトでは常駐し続けます。--once を付けると1回の転送だけを受け取って終了します。事前に何かを共有しておく必要はありません——あらかじめコピーしておくフィンガープリントもありません:",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "リスナーは接続を1つずつ処理し、ファイルを --dir の下に配置します。",
        "デフォルトのポートは 9031 です。--port で変更し、ファイアウォールで開放してください。",
      ],
    },
    {
      heading: "リスナーへプッシュする(送信側)",
      body: [
        "送信側のサーバーから、受信側の relayium:// アドレスへプッシュします。最初の接続で受信側のフィンガープリントが固定され、以降の接続はすべてそれを検証します。フィンガープリントが変わった場合は黙って受け入れられるのではなく拒否されます——鍵のすり替えや中間者攻撃はそのまま信頼されるのではなく、検知されます。最初のプッシュでは、受信側が承認するまでの間、送信側は少し待機します(次のステップ)。",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "リレーもフォールバックもありません。リスナーに到達できなければプッシュは失敗します——ファイルのバイト列が他の誰かを経由することは決してありません。",
        "他のモードと同じ転送エンジンです。再開可能で、ファイルごとに SHA-256 チェックが行われます。",
      ],
    },
    {
      heading: "初回プッシュ時に送信側を承認する(受信側)",
      body: [
        "新しいマシンが初めてあなたのリスナーへプッシュすると、serve は(ターミナルで)その送信元とフィンガープリントを表示し、承認するかどうかを尋ねます——SSH の初回接続時のプロンプトに似ていますが、受信側で行われる点が異なります:",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "y と答えると、そのフィンガープリントが authorized_fingerprints に記録されます。以降、同じマシンからのプッシュはすべて確認なしで通過します。",
        "フィンガープリントはそのマシンの安定したアイデンティティであり(再起動や IP の変更を経ても変わりません)、承認はプッシュ側ごとに一度だけで済みます。",
        "プッシュ側は、初回接続時にリスナーの鍵を学習し(信頼オンファーストユース)、known_hosts に固定します。",
      ],
    },
    {
      heading: "自動化する(またはターミナルなしで実行する)",
      body: [
        "承認済みのフィンガープリントは記憶されるため、以降のプッシュにはプロンプトが不要になります——そのため relayium push は cron、デプロイスクリプト、CI にそのまま組み込め、暗号化・整合性チェック済み・再開可能なサーバー間同期を実現します。serve がターミナルなしで動作している場合(systemd サービスやパイプなど)はプロンプトを出せないため、未知のプッシュ側を拒否します。その場合は事前に承認してください。フィンガープリントはプッシュ側で relayium id を実行して取得するか、serve のログにある「rejected unauthorized peer …」の行からコピーし、次のように実行します:",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "アイデンティティと信頼のファイルは ~/.config/relayium/ にあります(サービスとして使う場合など、--config-dir で /etc/relayium などに上書きできます)。",
        "authorize は冪等です——同じフィンガープリントに対して再度実行しても何も起こりません。",
      ],
    },
    {
      heading: "systemd でリスナーを実行する",
      body: [
        "常時稼働の受信箱にするには、serve を systemd サービスとして実行します。--config-dir を /etc/relayium のような固定の場所に向けて、再起動をまたいでアイデンティティを安定させ、生存は systemd に任せます:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve で起動し、起動時に自動的に立ち上がるようにします。",
        "/etc/relayium/id.key はサービスユーザーだけが読めるようにしてください——権限が緩い鍵は relayium が読み込みを拒否します。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "デーモン直結は SSH 経由の push と何が違いますか?",
        a: "SSH 経由の push は転送を SSH 接続のトンネルに通し、リモート側に SSH アカウントが必要です。デーモン直結には SSH もアカウントも不要です——2台のサーバーは固定された TLS 上で証明書のフィンガープリントによって互いを認証します。両方のマシンが自分のものである場合、これはより軽量です。",
      },
      {
        q: "フィンガープリントを手作業でコピーして回る必要がありますか?",
        a: "いいえ。ターミナルでは、serve が新しいプッシュ側の初回プッシュ時にその住所とフィンガープリントを表示し、承認するかどうかを尋ね、それを記憶します。そのため以降のプッシュは確認なしで進みます。relayium id や relayium authorize が必要になるのは、systemd サービスのようにプロンプトに応答する人がいない非対話的な環境を設定する場合だけです。",
      },
      {
        q: "アイデンティティと信頼のファイルはどこにありますか?",
        a: "デフォルトでは ~/.config/relayium/ にあります(--config-dir で上書き可能)。id.key / id.crt はこのホストの永続的なアイデンティティ、known_hosts はプッシュ先にしたリスナーのフィンガープリントを保持し、authorized_fingerprints はリスナー側のプッシュ元許可リストです。",
      },
      {
        q: "フィンガープリントが変わったらどうなりますか?",
        a: "プッシュは拒否され、警告が出ます。リスナーの鍵は初回使用時に known_hosts に固定されるため、その後の変化——鍵を再生成したホスト、あるいは中間者攻撃——は黙って受け入れられるのではなく拒否されます。known_hosts の該当行を削除するのは、意図的に鍵をローテーションした場合だけにしてください。",
      },
      {
        q: "リレーへのフォールバックはありますか?",
        a: "ありません。デーモン直結はリスナーのアドレスに到達できることを前提としています。接続できなければ失敗します。何ものも Relayium を経由してプロキシされることはありません——それがこのモードの要点です。",
      },
    ],
  },
  cta: {
    text: "自分の2台のサーバーをつないで直接転送しましょう——リレーも SSH もペアリングコードも不要です。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 서버 간 전송(데몬 다이렉트)",
  description:
    "relayium serve와 push relayium://로 당신이 관리하는 두 서버 사이에서 파일을 곧바로 옮기세요——고정된 TLS를 통해, 릴레이도 SSH도 코드도 필요 없습니다. 새로운 푸시하는 쪽이 처음 푸시할 때 한 번만 승인하면, 이후 자동화하거나 systemd 아래에서 실행할 수 있습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "두 기기가 모두 당신 것이고 서로의 주소를 알고 있다면, SSH는 불필요한 마찰이고 랑데부는 순전한 오버헤드입니다. 데몬 다이렉트는 정확히 이를 위해 만들어졌습니다. 한쪽 서버는 대기하고, 다른 쪽은 고정된 TLS 1.3 연결로 그곳에 곧바로 푸시합니다. 릴레이도 SSH도 페어링 코드도 없습니다——신뢰는 공개 키 방식이며 한 번만 설정하면 됩니다.",
    "이 가이드는 리스너 시작하기, 리스너로의 푸시, 처음 접촉했을 때 새로운 푸시하는 쪽 승인하기, 자동화하기, 그리고 리스너를 systemd 서비스로 실행하는 방법을 다룹니다.",
  ],
  sections: [
    {
      heading: "리스너 시작하기(받는 쪽)",
      body: [
        "받는 쪽 서버에서 serve는 푸시를 대기하고 이를 어떤 디렉터리에 기록합니다. 기본적으로 계속 실행되며, --once를 추가하면 한 번의 전송만 받고 종료합니다. 미리 공유해야 할 것은 아무것도 없습니다——미리 복사해 둘 핑거프린트도 없습니다:",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "리스너는 연결을 한 번에 하나씩 처리하며 파일을 --dir 아래에 내려놓습니다.",
        "기본 포트는 9031입니다. --port로 변경하고 방화벽에서 열어 두세요.",
      ],
    },
    {
      heading: "리스너로 푸시하기(보내는 쪽)",
      body: [
        "보내는 쪽 서버에서 받는 쪽의 relayium:// 주소로 푸시하세요. 첫 연결에서 받는 쪽의 핑거프린트가 고정되고, 이후 모든 연결은 이를 검증합니다. 핑거프린트가 바뀌면 조용히 받아들여지는 대신 거부됩니다——그래서 키가 바뀌었거나 중간자 공격이 있으면 신뢰되는 대신 발견됩니다. 첫 푸시에서는 받는 쪽이 승인할 때까지 보내는 쪽이 잠시 대기합니다(다음 단계).",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "릴레이도 폴백도 없습니다. 리스너에 도달할 수 없으면 푸시는 실패합니다——파일 바이트는 결코 다른 누군가를 거쳐 전달되지 않습니다.",
        "다른 모드와 동일한 전송 엔진입니다. 재개 가능하며 파일별 SHA-256 검사를 수행합니다.",
      ],
    },
    {
      heading: "첫 푸시 시 보내는 쪽 승인하기(받는 쪽)",
      body: [
        "새 기기가 리스너로 처음 푸시하면, serve는(터미널에서) 그 출처와 핑거프린트를 보여주고 승인할지 물어봅니다——SSH의 첫 연결 프롬프트와 비슷하지만, 받는 쪽에서 이루어진다는 점이 다릅니다:",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "y라고 답하면 그 핑거프린트가 authorized_fingerprints에 기록됩니다. 이후 같은 기기에서의 모든 푸시는 조용히 통과합니다.",
        "핑거프린트는 기기의 안정적인 신원이므로(재시작이나 IP 변경에도 유지됩니다), 승인은 푸시하는 쪽마다 한 번만 하면 되는 단계입니다.",
        "푸시하는 쪽은 첫 연결 시 리스너의 키를 알게 되고(첫 사용 시 신뢰), 이를 known_hosts에 고정합니다.",
      ],
    },
    {
      heading: "자동화하기(또는 터미널 없이 실행하기)",
      body: [
        "승인된 핑거프린트는 기억되므로 이후의 푸시에는 확인이 필요 없습니다——따라서 relayium push는 cron, 배포 스크립트, CI에 곧바로 연결되어 암호화되고 무결성이 검증되며 재개 가능한 서버 간 동기화를 제공합니다. serve가 터미널 없이 실행될 때(systemd 서비스, 파이프 등)는 프롬프트를 띄울 수 없으므로 알 수 없는 푸시하는 쪽을 거부합니다. 대신 미리 승인해 두세요. 핑거프린트는 푸시하는 쪽에서 relayium id로 얻거나, serve 로그의 “rejected unauthorized peer …” 줄에서 복사한 뒤 다음을 실행하세요:",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "신원 및 신뢰 파일은 ~/.config/relayium/에 있습니다(서비스로 쓸 때는 --config-dir로 /etc/relayium 같은 곳으로 재정의할 수 있습니다).",
        "authorize는 멱등적입니다——같은 핑거프린트에 대해 다시 실행해도 아무 효과가 없습니다.",
      ],
    },
    {
      heading: "systemd에서 리스너 실행하기",
      body: [
        "항상 켜져 있는 수신함을 만들려면 serve를 systemd 서비스로 실행하세요. --config-dir을 /etc/relayium 같은 고정된 위치로 지정해 재시작 간에도 신원이 안정적으로 유지되게 하고, 살아 있게 하는 것은 systemd에 맡기세요:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve로 시작하고 부팅 시 자동으로 올라오게 하세요.",
        "/etc/relayium/id.key는 서비스 사용자만 읽을 수 있게 하세요——권한이 느슨한 키는 relayium이 불러오기를 거부합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "데몬 다이렉트는 SSH를 통한 push와 어떻게 다른가요?",
        a: "SSH를 통한 push는 전송을 SSH 연결 터널로 통과시키며 원격에 SSH 계정이 필요합니다. 데몬 다이렉트는 SSH도 계정도 필요 없습니다——두 서버는 고정된 TLS를 통해 인증서 핑거프린트로 서로를 인증하며, 두 기기가 모두 당신 것일 때 더 가볍습니다.",
      },
      {
        q: "핑거프린트를 손으로 일일이 복사해서 옮겨야 하나요?",
        a: "아니요. 터미널에서는 serve가 각 새 푸시하는 쪽의 첫 푸시 시 주소와 핑거프린트를 보여주며 승인할지 물어보고, 이를 기억합니다. 그래서 이후의 푸시는 조용히 진행됩니다. relayium id나 relayium authorize가 필요한 경우는 systemd 서비스처럼 프롬프트에 답할 사람이 없는 비대화형 설정뿐입니다.",
      },
      {
        q: "신원 및 신뢰 파일은 어디에 있나요?",
        a: "기본적으로 ~/.config/relayium/에 있습니다(--config-dir로 재정의 가능). id.key / id.crt는 이 호스트의 영구적인 신원이고, known_hosts는 푸시했던 리스너들의 핑거프린트를 담고 있으며, authorized_fingerprints는 리스너 쪽의 푸시하는 쪽 허용 목록입니다.",
      },
      {
        q: "핑거프린트가 바뀌면 어떻게 되나요?",
        a: "푸시가 거부되고 경고가 표시됩니다. 리스너의 키는 첫 사용 시 known_hosts에 고정되므로, 이후의 변화——키를 재발급한 호스트든 중간자 공격이든——는 조용히 받아들여지는 대신 거부됩니다. known_hosts의 해당 줄은 의도적으로 키를 교체했을 때만 삭제하세요.",
      },
      {
        q: "릴레이 폴백이 있나요?",
        a: "없습니다. 데몬 다이렉트는 도달 가능한 리스너 주소를 전제로 합니다. 연결할 수 없으면 실패합니다. 어떤 것도 Relayium을 통해 프록시되지 않습니다——그것이 이 모드의 요점입니다.",
      },
    ],
  },
  cta: {
    text: "당신의 서버 두 대를 연결해 직접 전송을 해보세요——릴레이도, SSH도, 페어링 코드도 필요 없습니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Server-zu-Server-Übertragungen mit der Relayium CLI (Daemon Direct)",
  description:
    "Bewege Dateien direkt zwischen zwei Servern, die du kontrollierst, mit relayium serve und push relayium:// — über gepinntes TLS, ohne Relay, ohne SSH, ohne Code. Genehmige einen neuen Pusher einmalig bei seinem ersten Push, dann automatisiere es oder lass es unter systemd laufen.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Wenn beide Maschinen dir gehören und jede die Adresse der anderen kennt, ist SSH zusätzliche Reibung und ein Rendezvous reiner Overhead. Daemon Direct ist genau dafür gebaut: Ein Server lauscht, der andere pusht direkt dorthin über eine gepinnte TLS-1.3-Verbindung. Kein Relay, kein SSH, kein Pairing-Code — das Vertrauen basiert auf Public Keys und wird einmal eingerichtet.",
    "Diese Anleitung behandelt das Starten des Listeners, das Pushen dorthin, das Genehmigen eines neuen Pushers beim ersten Kontakt, die Automatisierung und den Betrieb des Listeners als systemd-Dienst.",
  ],
  sections: [
    {
      heading: "Den Listener starten (auf dem Empfänger)",
      body: [
        "Auf dem empfangenden Server lauscht serve auf Pushes und schreibt sie in ein Verzeichnis. Standardmäßig läuft es dauerhaft; mit --once nimmt es eine einzelne Übertragung an und beendet sich. Du musst nichts vorab teilen — keine Fingerprints, die du im Voraus kopieren müsstest:",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "Der Listener verarbeitet Verbindungen nacheinander und legt Dateien unter --dir ab.",
        "Der Standardport ist 9031; ändere ihn mit --port und öffne ihn in deiner Firewall.",
      ],
    },
    {
      heading: "Zum Listener pushen (auf dem Sender)",
      body: [
        "Vom sendenden Server aus, push zur relayium://-Adresse des Empfängers. Die erste Verbindung pinnt den Fingerprint des Empfängers; jede folgende Verbindung überprüft ihn, und ein geänderter Fingerprint wird abgelehnt statt stillschweigend akzeptiert — ein ausgetauschter Schlüssel oder ein Man-in-the-Middle wird so erkannt, nicht vertraut. Beim allerersten Push wartet der Sender einen Moment, während der Empfänger ihn genehmigt (nächster Schritt).",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "Kein Relay und kein Fallback: Ist der Listener nicht erreichbar, schlägt der Push fehl — die Datei-Bytes laufen nie über irgendjemand anderen.",
        "Dieselbe Übertragungs-Engine wie die anderen Modi: fortsetzbar, mit einer SHA-256-Prüfung pro Datei.",
      ],
    },
    {
      heading: "Den Sender beim ersten Push genehmigen (auf dem Empfänger)",
      body: [
        "Wenn eine neue Maschine zum ersten Mal zu deinem Listener pusht, zeigt dir serve (in einem Terminal), woher sie kommt und ihren Fingerprint, und bittet dich, sie zu genehmigen — wie die Erstverbindungs-Abfrage von SSH, nur auf der Empfängerseite:",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Antworte mit y, und dieser Fingerprint wird in authorized_fingerprints gespeichert; jeder spätere Push von derselben Maschine läuft dann stillschweigend durch.",
        "Der Fingerprint ist die stabile Identität einer Maschine (er übersteht Neustarts und IP-Wechsel), sodass die Genehmigung pro Pusher nur einmal nötig ist.",
        "Der Pusher wiederum lernt den Schlüssel des Listeners beim ersten Verbinden (Vertrauen bei erster Nutzung) und pinnt ihn in known_hosts.",
      ],
    },
    {
      heading: "Automatisieren (oder ohne Terminal betreiben)",
      body: [
        "Weil ein genehmigter Fingerprint gespeichert bleibt, brauchen spätere Pushes keine Abfrage mehr — relayium push lässt sich also direkt in cron, ein Deploy-Skript oder CI einbinden, für verschlüsselte, integritätsgeprüfte, fortsetzbare Server-zu-Server-Synchronisation. Läuft serve ohne Terminal (ein systemd-Dienst, eine Pipe), kann es nicht nachfragen und lehnt daher unbekannte Pusher ab; genehmige sie stattdessen im Voraus. Hol dir den Fingerprint über relayium id auf der Pusher-Seite, oder kopiere ihn aus der Zeile „rejected unauthorized peer …“ im serve-Log, dann:",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Identitäts- und Vertrauensdateien liegen in ~/.config/relayium/ (mit --config-dir überschreibbar, z. B. /etc/relayium für einen Dienst).",
        "authorize ist idempotent — es erneut für denselben Fingerprint auszuführen, ist ein No-op.",
      ],
    },
    {
      heading: "Den Listener unter systemd betreiben",
      body: [
        "Für einen dauerhaft laufenden Posteingang betreibst du serve als systemd-Dienst. Richte --config-dir auf einen festen Ort wie /etc/relayium, damit die Identität über Neustarts hinweg stabil bleibt, und lass systemd sie am Leben halten:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve, um ihn zu starten und beim Booten hochzufahren.",
        "Halte /etc/relayium/id.key nur für den Dienstbenutzer lesbar — relayium verweigert das Laden eines Schlüssels mit zu lockeren Berechtigungen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Wie unterscheidet sich Daemon Direct von push über SSH?",
        a: "push über SSH tunnelt die Übertragung durch deine SSH-Verbindung und braucht ein SSH-Konto auf der Gegenseite. Daemon Direct braucht weder SSH noch ein Konto — die beiden Server authentifizieren sich gegenseitig per Zertifikats-Fingerprint über gepinntes TLS, was leichtgewichtiger ist, wenn beide Maschinen dir gehören.",
      },
      {
        q: "Muss ich Fingerprints von Hand herumkopieren?",
        a: "Nein. In einem Terminal fordert dich serve auf, jeden neuen Pusher bei seinem ersten Push zu genehmigen — zeigt dabei seine Adresse und seinen Fingerprint — und merkt sich das, sodass spätere Pushes stillschweigend ablaufen. Du greifst nur bei nicht-interaktiven Setups wie einem systemd-Dienst zu relayium id oder relayium authorize, wo niemand da ist, um die Abfrage zu beantworten.",
      },
      {
        q: "Wo liegen die Identitäts- und Vertrauensdateien?",
        a: "Standardmäßig in ~/.config/relayium/ (mit --config-dir überschreibbar). id.key / id.crt sind die dauerhafte Identität dieses Hosts, known_hosts enthält die Fingerprints der Listener, zu denen du gepusht hast, und authorized_fingerprints ist die Allow-Liste des Listeners für Pusher.",
      },
      {
        q: "Was passiert, wenn sich ein Fingerprint ändert?",
        a: "Der Push wird abgelehnt und warnt. Der Schlüssel des Listeners wird bei der ersten Nutzung in known_hosts gepinnt, sodass eine spätere Änderung — ein neu verschlüsselter Host oder ein Man-in-the-Middle — abgelehnt statt stillschweigend akzeptiert wird. Entferne die known_hosts-Zeile nur, wenn du den Schlüssel absichtlich rotiert hast.",
      },
      {
        q: "Gibt es einen Relay-Fallback?",
        a: "Nein. Daemon Direct setzt eine erreichbare Listener-Adresse voraus; kann die Verbindung nicht hergestellt werden, schlägt es fehl. Nichts wird jemals über Relayium weitergeleitet — genau das ist der Sinn dieses Modus.",
      },
    ],
  },
  cta: {
    text: "Verbinde zwei deiner eigenen Server für direkte Übertragungen — kein Relay, kein SSH, kein Pairing-Code.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transferts serveur à serveur avec la CLI Relayium (daemon direct)",
  description:
    "Déplacez des fichiers directement entre deux serveurs que vous contrôlez avec relayium serve et push relayium:// — via TLS épinglé, sans relais, sans SSH, sans code. Approuvez un nouvel émetteur une seule fois lors de son premier envoi, puis automatisez-le ou exécutez-le sous systemd.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Quand les deux machines vous appartiennent et que chacune connaît l'adresse de l'autre, SSH est une friction superflue et un rendez-vous n'est que du pur surcoût. Le daemon direct est fait exactement pour cela : un serveur écoute, l'autre pousse directement vers lui via une connexion TLS 1.3 épinglée. Pas de relais, pas de SSH, pas de code de jumelage — la confiance repose sur des clés publiques et se configure une seule fois.",
    "Ce guide couvre le démarrage de l'écouteur, l'envoi vers celui-ci, l'approbation d'un nouvel émetteur au premier contact, l'automatisation, et l'exécution de l'écouteur en tant que service systemd.",
  ],
  sections: [
    {
      heading: "Démarrer l'écouteur (sur le récepteur)",
      body: [
        "Sur le serveur récepteur, serve écoute les envois et les écrit dans un répertoire. Il tourne en continu par défaut ; ajoutez --once pour accepter un seul transfert puis s'arrêter. Vous n'avez rien à partager à l'avance — aucune empreinte à copier au préalable :",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "L'écouteur traite les connexions une par une et dépose les fichiers sous --dir.",
        "Le port par défaut est 9031 ; changez-le avec --port et ouvrez-le sur votre pare-feu.",
      ],
    },
    {
      heading: "Envoyer vers l'écouteur (sur l'émetteur)",
      body: [
        "Depuis le serveur émetteur, envoyez vers l'adresse relayium:// du récepteur. La première connexion épingle l'empreinte du récepteur ; chaque connexion suivante la vérifie, et une empreinte modifiée est refusée plutôt qu'acceptée silencieusement — une clé remplacée ou une attaque de l'homme du milieu est ainsi détectée, pas approuvée. Lors du tout premier envoi, l'émetteur patiente un instant pendant que le récepteur l'approuve (étape suivante).",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "Aucun relais et aucun repli : si l'écouteur n'est pas joignable, l'envoi échoue — les octets du fichier ne transitent jamais par qui que ce soit d'autre.",
        "Le même moteur de transfert que les autres modes : reprenable, avec une vérification SHA-256 par fichier.",
      ],
    },
    {
      heading: "Approuver l'émetteur au premier envoi (sur le récepteur)",
      body: [
        "La première fois qu'une nouvelle machine envoie vers votre écouteur, serve (dans un terminal) vous montre d'où elle vient et son empreinte, puis vous demande de l'approuver — comme l'invite de première connexion de SSH, mais côté récepteur :",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Répondez y et cette empreinte est mémorisée dans authorized_fingerprints ; chaque envoi ultérieur depuis la même machine passe alors silencieusement.",
        "L'empreinte est l'identité stable d'une machine (elle survit aux redémarrages et aux changements d'IP), donc l'approbation n'est qu'une étape ponctuelle par émetteur.",
        "L'émetteur, de son côté, découvre la clé de l'écouteur à la première connexion (confiance à la première utilisation) et l'épingle dans known_hosts.",
      ],
    },
    {
      heading: "Automatiser (ou exécuter sans terminal)",
      body: [
        "Comme une empreinte approuvée est mémorisée, les envois suivants ne demandent plus de confirmation — relayium push s'intègre donc directement dans cron, un script de déploiement ou la CI pour une synchronisation serveur à serveur chiffrée, vérifiée en intégrité et reprenable. Quand serve tourne sans terminal (un service systemd, un pipe), il ne peut pas demander confirmation et rejette donc les émetteurs inconnus ; autorisez-les plutôt à l'avance. Récupérez l'empreinte via relayium id côté émetteur, ou copiez-la depuis la ligne « rejected unauthorized peer … » du journal de serve, puis :",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Les fichiers d'identité et de confiance se trouvent dans ~/.config/relayium/ (à surcharger avec --config-dir, par exemple /etc/relayium pour un service).",
        "authorize est idempotent — l'exécuter à nouveau pour la même empreinte ne fait rien.",
      ],
    },
    {
      heading: "Exécuter l'écouteur sous systemd",
      body: [
        "Pour une boîte de réception toujours active, exécutez serve en tant que service systemd. Pointez --config-dir vers un emplacement fixe comme /etc/relayium pour que l'identité reste stable entre les redémarrages, et laissez systemd le maintenir en vie :",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve pour le démarrer et le faire démarrer au boot.",
        "Gardez /etc/relayium/id.key lisible uniquement par l'utilisateur du service — relayium refuse de charger une clé aux permissions trop permissives.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "En quoi le daemon direct diffère-t-il de push via SSH ?",
        a: "push via SSH fait transiter le transfert par votre connexion SSH et nécessite un compte SSH sur la machine distante. Le daemon direct ne nécessite ni SSH ni compte — les deux serveurs s'authentifient mutuellement par empreinte de certificat via TLS épinglé, ce qui est plus léger quand les deux machines vous appartiennent.",
      },
      {
        q: "Dois-je recopier les empreintes à la main ?",
        a: "Non. Dans un terminal, serve vous invite à approuver chaque nouvel émetteur lors de son premier envoi — en affichant son adresse et son empreinte — et s'en souvient, si bien que les envois suivants sont silencieux. Vous n'avez recours à relayium id ou relayium authorize que pour des configurations non interactives, comme un service systemd, où personne n'est là pour répondre à l'invite.",
      },
      {
        q: "Où se trouvent les fichiers d'identité et de confiance ?",
        a: "Dans ~/.config/relayium/ par défaut (à surcharger avec --config-dir). id.key / id.crt sont l'identité persistante de cet hôte, known_hosts contient les empreintes des écouteurs vers lesquels vous avez envoyé, et authorized_fingerprints est la liste d'autorisation des émetteurs de l'écouteur.",
      },
      {
        q: "Que se passe-t-il si une empreinte change ?",
        a: "L'envoi est refusé et un avertissement s'affiche. La clé de l'écouteur est épinglée dans known_hosts à la première utilisation, donc un changement ultérieur — un hôte reclé, ou une attaque de l'homme du milieu — est rejeté plutôt qu'accepté silencieusement. Ne supprimez la ligne known_hosts que si vous avez intentionnellement fait tourner la clé.",
      },
      {
        q: "Y a-t-il un repli vers un relais ?",
        a: "Non. Le daemon direct suppose une adresse d'écouteur joignable ; si la connexion ne peut pas être établie, il échoue. Rien n'est jamais relayé via Relayium — c'est tout l'intérêt de ce mode.",
      },
    ],
  },
  cta: {
    text: "Reliez deux de vos propres serveurs pour des transferts directs — sans relais, sans SSH, sans code de jumelage.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "النقل من خادم إلى خادم باستخدام واجهة Relayium الطرفية (daemon direct)",
  description:
    "انقل الملفات مباشرةً بين خادمين تتحكم بهما باستخدام relayium serve و push relayium:// — عبر TLS مُثبَّت، دون مُرحِّل، دون SSH، دون رمز. اعتمِد مُرسِلاً جديداً مرةً واحدة عند أول دفعة له، ثم أتمتِه أو شغّله تحت systemd.",
  updatedLabel: "آخر تحديث",
  lead: [
    "حين يكون الجهازان كلاهما لك ويعرف كلٌّ منهما عنوان الآخر، يصبح SSH احتكاكاً زائداً واللقاء عبئاً محضاً. صُمِّم daemon direct لهذا تماماً: خادم يُنصِت، والآخر يدفع إليه مباشرةً عبر اتصال TLS 1.3 مُثبَّت. لا مُرحِّل، لا SSH، لا رمز اقتران — الثقة تقوم على المفتاح العام وتُهيَّأ مرةً واحدة.",
    "يغطي هذا الدليل تشغيل المُنصِت، والدفع إليه، واعتماد مُرسِل جديد عند أول اتصال، وأتمتة ذلك، وتشغيل المُنصِت كخدمة systemd.",
  ],
  sections: [
    {
      heading: "شغّل المُنصِت (على المُستقبِل)",
      body: [
        "على الخادم المُستقبِل، يُنصِت serve للدفعات ويكتبها في مجلد. يعمل باستمرار افتراضياً؛ أضِف --once لقبول نقلة واحدة ثم الخروج. لا تشارك أي شيء مسبقاً — لا بصمات تنسخها سلفاً:",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "يعالج المُنصِت الاتصالات واحداً تلو الآخر ويُنزِل الملفات تحت --dir.",
        "المنفذ الافتراضي هو 9031؛ غيّره بـ --port وافتحه على جدارك الناري.",
      ],
    },
    {
      heading: "ادفع إليه (على المُرسِل)",
      body: [
        "من الخادم المُرسِل، ادفع إلى عنوان relayium:// الخاص بالمُستقبِل. يُثبِّت الاتصال الأول بصمة المُستقبِل؛ ويتحقق منها كل اتصال بعده، وتُرفَض البصمة المتغيّرة بدل قبولها بصمت — فالمفتاح المُستبدَل أو هجوم الوسيط يُكتشَف، لا يُوثَق به. عند أول دفعة على الإطلاق، ينتظر المُرسِل لحظةً بينما يعتمده المُستقبِل (الخطوة التالية).",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "لا مُرحِّل ولا احتياطي: إن تعذَّر الوصول إلى المُنصِت، تفشل الدفعة — ولا تمر بايتات الملف أبداً عبر أي طرف آخر.",
        "المحرك نفسه المُستخدَم في الأوضاع الأخرى: قابل للاستئناف، مع فحص SHA-256 لكل ملف.",
      ],
    },
    {
      heading: "اعتمِد المُرسِل عند أول دفعة (على المُستقبِل)",
      body: [
        "في أول مرة يدفع فيها جهاز جديد إلى مُنصِتك، يُظهِر لك serve (في طرفية) من أين أتى وبصمته ويطلب منك اعتماده — مثل مُطالبة الاتصال الأول في SSH، لكن على جانب المُستقبِل:",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "أجِب بـ y فتُحفَظ تلك البصمة في authorized_fingerprints؛ عندئذٍ تمر كل دفعة لاحقة من الجهاز نفسه بصمت.",
        "البصمة هوية ثابتة للجهاز (تصمد عبر إعادة التشغيل وتغيّر عناوين IP)، فالاعتماد خطوة تُنفَّذ مرةً واحدة لكل مُرسِل.",
        "أما المُرسِل، فيتعلَّم مفتاح المُنصِت عند أول اتصال (الثقة عند أول استخدام) ويُثبِّته في known_hosts.",
      ],
    },
    {
      heading: "أتمِتها (أو شغّلها دون طرفية)",
      body: [
        "بما أن البصمة المعتمَدة تُحفَظ، لا تحتاج الدفعات اللاحقة إلى مُطالبة — لذا يدخل relayium push مباشرةً في cron أو سكربت نشر أو CI لمزامنة مُشفَّرة، مفحوصة السلامة، قابلة للاستئناف من خادم إلى خادم. حين يعمل serve دون طرفية (خدمة systemd، أنبوب) لا يستطيع المُطالبة، فيرفض المُرسِلين المجهولين؛ فوّض لهم مسبقاً بدلاً من ذلك. احصل على البصمة من relayium id لدى المُرسِل، أو انسخها من سطر \"rejected unauthorized peer …\" في سجل serve، ثم:",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "تقيم ملفات الهوية والثقة في ~/.config/relayium/ (تُتجاوَز بـ --config-dir، مثلاً /etc/relayium لخدمة).",
        "authorize خاملة التكرار (idempotent) — تشغيلها مجدداً للبصمة نفسها لا يفعل شيئاً.",
      ],
    },
    {
      heading: "شغّل المُنصِت تحت systemd",
      body: [
        "لصندوق وارد دائم التشغيل، شغّل serve كخدمة systemd. وجِّه --config-dir إلى موقع ثابت مثل /etc/relayium كي تبقى الهوية مستقرة عبر إعادات التشغيل، ودع systemd يُبقيها حيّة:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve لتشغيلها ولرفعها عند الإقلاع.",
        "أبقِ /etc/relayium/id.key قابلاً للقراءة من مستخدم الخدمة فقط — يرفض relayium تحميل مفتاح بأذونات فضفاضة.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "بماذا يختلف daemon direct عن push عبر SSH؟",
        a: "يوجِّه push عبر SSH النقل خلال اتصال SSH الخاص بك ويحتاج إلى حساب SSH على الطرف البعيد. أما daemon direct فلا يحتاج SSH ولا حساباً — يصادق الخادمان أحدهما الآخر ببصمة الشهادة عبر TLS مُثبَّت، وهو أخف حين يكون الجهازان كلاهما لك.",
      },
      {
        q: "هل عليّ نسخ البصمات يدوياً هنا وهناك؟",
        a: "لا. في طرفية، يطالبك serve باعتماد كل مُرسِل جديد عند أول دفعة له — مُظهِراً عنوانه وبصمته — ويحفظه، فتمر الدفعات اللاحقة بصمت. لا تلجأ إلى relayium id أو relayium authorize إلا في الإعدادات غير التفاعلية مثل خدمة systemd، حيث لا أحد ليُجيب على المُطالبة.",
      },
      {
        q: "أين تقع ملفات الهوية والثقة؟",
        a: "في ~/.config/relayium/ افتراضياً (تُتجاوَز بـ --config-dir). id.key / id.crt هما الهوية الدائمة لهذا المضيف، ويحتفظ known_hosts ببصمات المُنصِتين الذين دفعت إليهم، أما authorized_fingerprints فهو قائمة السماح بالمُرسِلين لدى المُنصِت.",
      },
      {
        q: "ماذا يحدث إذا تغيّرت بصمة؟",
        a: "تُرفَض الدفعة ويُطلَق تحذير. يُثبَّت مفتاح المُنصِت في known_hosts عند أول استخدام، فأي تغيّر لاحق — مضيف أُعيد ترميزه، أو هجوم وسيط — يُرفَض بدل قبوله بصمت. لا تحذف سطر known_hosts إلا إن كنت قد بدّلت المفتاح عمداً.",
      },
      {
        q: "هل هناك احتياطي عبر مُرحِّل؟",
        a: "لا. يفترض daemon direct عنوان مُنصِت يمكن الوصول إليه؛ فإن تعذَّر إنشاء الاتصال، يفشل. لا يُوجَّه أي شيء أبداً عبر Relayium — وهذا هو مغزى هذا الوضع.",
      },
    ],
  },
  cta: {
    text: "اربط خادمين من خوادمك للنقل المباشر — دون مُرحِّل، دون SSH، دون رمز اقتران.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Transferencias de servidor a servidor con la CLI de Relayium (daemon direct)",
  description:
    "Mueve archivos directamente entre dos servidores que controlas con relayium serve y push relayium:// — sobre TLS fijado, sin retransmisor, sin SSH, sin código. Aprueba un nuevo emisor una vez en su primer push, y luego automatízalo o ejecútalo bajo systemd.",
  updatedLabel: "Última actualización",
  lead: [
    "Cuando ambas máquinas son tuyas y cada una conoce la dirección de la otra, SSH es una fricción de más y un encuentro es pura sobrecarga. daemon direct está hecho exactamente para esto: un servidor escucha, el otro le hace push directamente sobre una conexión TLS 1.3 fijada. Sin retransmisor, sin SSH, sin código de emparejamiento: la confianza se basa en clave pública y se configura una sola vez.",
    "Esta guía cubre iniciar el escucha, hacerle push, aprobar un nuevo emisor en el primer contacto, automatizarlo y ejecutar el escucha como servicio de systemd.",
  ],
  sections: [
    {
      heading: "Iniciar el escucha (en el receptor)",
      body: [
        "En el servidor receptor, serve escucha los push y los escribe en un directorio. Se ejecuta de forma continua por defecto; añade --once para aceptar una sola transferencia y salir. No compartes nada de antemano: no hay huellas que copiar por adelantado:",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "El escucha procesa las conexiones de una en una y deposita los archivos bajo --dir.",
        "El puerto por defecto es 9031; cámbialo con --port y ábrelo en tu cortafuegos.",
      ],
    },
    {
      heading: "Hacerle push (en el emisor)",
      body: [
        "Desde el servidor emisor, haz push a la dirección relayium:// del receptor. La primera conexión fija la huella del receptor; cada conexión posterior la verifica, y una huella cambiada se rechaza en lugar de aceptarse en silencio, de modo que una clave sustituida o un ataque de intermediario se detecta, no se confía en él. En el primer push, el emisor espera un momento mientras el receptor lo aprueba (siguiente paso).",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "Sin retransmisor y sin respaldo: si no se puede alcanzar el escucha, el push falla; los bytes del archivo nunca se enrutan a través de nadie más.",
        "El mismo motor de transferencia que los otros modos: reanudable, con una comprobación SHA-256 por archivo.",
      ],
    },
    {
      heading: "Aprobar al emisor en el primer push (en el receptor)",
      body: [
        "La primera vez que una máquina nueva hace push a tu escucha, serve (en una terminal) te muestra de dónde viene y su huella y te pide que la apruebes, como el aviso de primera conexión de SSH, pero en el lado receptor:",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Responde y y esa huella se recuerda en authorized_fingerprints; cada push posterior desde la misma máquina pasa entonces en silencio.",
        "La huella es la identidad estable de una máquina (sobrevive a reinicios y cambios de IP), así que aprobar es un paso único por emisor.",
        "El emisor, a su vez, aprende la clave del escucha en la primera conexión (confianza en el primer uso) y la fija en known_hosts.",
      ],
    },
    {
      heading: "Automatizarlo (o ejecutarlo sin terminal)",
      body: [
        "Como una huella aprobada se recuerda, los push posteriores no necesitan aviso, así que relayium push encaja directamente en cron, un script de despliegue o CI para una sincronización de servidor a servidor cifrada, con integridad comprobada y reanudable. Cuando serve se ejecuta sin terminal (un servicio de systemd, una tubería) no puede preguntar, así que rechaza a los emisores desconocidos; autorízalos de antemano en su lugar. Obtén la huella con relayium id en el emisor, o cópiala de la línea \"rejected unauthorized peer …\" del registro de serve, y luego:",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Los archivos de identidad y confianza viven en ~/.config/relayium/ (se anulan con --config-dir, p. ej. /etc/relayium para un servicio).",
        "authorize es idempotente: ejecutarlo de nuevo para la misma huella no hace nada.",
      ],
    },
    {
      heading: "Ejecutar el escucha bajo systemd",
      body: [
        "Para una bandeja de entrada siempre activa, ejecuta serve como servicio de systemd. Apunta --config-dir a una ubicación fija como /etc/relayium para que la identidad sea estable entre reinicios, y deja que systemd la mantenga viva:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve para iniciarlo y levantarlo al arrancar.",
        "Mantén /etc/relayium/id.key legible solo para el usuario del servicio: relayium se niega a cargar una clave con permisos laxos.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿En qué se diferencia daemon direct de push por SSH?",
        a: "push por SSH tuneliza la transferencia a través de tu conexión SSH y necesita una cuenta SSH en el remoto. daemon direct no necesita SSH ni cuenta: los dos servidores se autentican mutuamente por huella de certificado sobre TLS fijado, lo cual es más ligero cuando ambas máquinas son tuyas.",
      },
      {
        q: "¿Tengo que copiar huellas a mano de un lado a otro?",
        a: "No. En una terminal, serve te pide aprobar a cada nuevo emisor en su primer push —mostrando su dirección y su huella— y lo recuerda, así que los push posteriores son silenciosos. Solo recurres a relayium id o relayium authorize en configuraciones no interactivas como un servicio de systemd, donde no hay nadie para responder al aviso.",
      },
      {
        q: "¿Dónde están los archivos de identidad y confianza?",
        a: "En ~/.config/relayium/ por defecto (se anula con --config-dir). id.key / id.crt son la identidad persistente de este host, known_hosts guarda las huellas de los escuchas a los que has hecho push, y authorized_fingerprints es la lista de permitidos de emisores del escucha.",
      },
      {
        q: "¿Qué pasa si una huella cambia?",
        a: "El push se rechaza y avisa. La clave del escucha se fija en known_hosts en el primer uso, así que un cambio posterior —un host con clave regenerada o un ataque de intermediario— se rechaza en lugar de aceptarse en silencio. Elimina la línea de known_hosts solo si rotaste la clave a propósito.",
      },
      {
        q: "¿Hay algún respaldo por retransmisor?",
        a: "No. daemon direct asume una dirección de escucha alcanzable; si no se puede establecer la conexión, falla. Nada se enruta nunca a través de Relayium como proxy: ese es el sentido de este modo.",
      },
    ],
  },
  cta: {
    text: "Conecta dos de tus propios servidores para transferencias directas: sin retransmisor, sin SSH, sin código de emparejamiento.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Transferências de servidor para servidor com a CLI do Relayium (daemon direct)",
  description:
    "Mova arquivos diretamente entre dois servidores que você controla com relayium serve e push relayium:// — sobre TLS fixado, sem retransmissor, sem SSH, sem código. Aprove um novo emissor uma vez no seu primeiro push e depois automatize-o ou execute-o sob systemd.",
  updatedLabel: "Última atualização",
  lead: [
    "Quando as duas máquinas são suas e cada uma conhece o endereço da outra, o SSH é um atrito a mais e um encontro é puro overhead. O daemon direct foi feito exatamente para isso: um servidor escuta, o outro faz push direto para ele sobre uma conexão TLS 1.3 fixada. Sem retransmissor, sem SSH, sem código de emparelhamento: a confiança é por chave pública e é configurada uma única vez.",
    "Este guia cobre iniciar o listener, fazer push para ele, aprovar um novo emissor no primeiro contato, automatizá-lo e executar o listener como um serviço do systemd.",
  ],
  sections: [
    {
      heading: "Iniciar o listener (no receptor)",
      body: [
        "No servidor receptor, serve escuta os pushes e os escreve em um diretório. Ele roda continuamente por padrão; adicione --once para aceitar uma única transferência e sair. Você não compartilha nada com antecedência: não há impressões digitais para copiar antes:",
      ],
      code: [
        `# on the RECEIVER
relayium serve --dir ~/inbox      # add --once for a single transfer; --port to change 9031`,
      ],
      bullets: [
        "O listener processa as conexões uma de cada vez e deposita os arquivos em --dir.",
        "A porta padrão é 9031; altere-a com --port e abra-a no seu firewall.",
      ],
    },
    {
      heading: "Fazer push para ele (no emissor)",
      body: [
        "Do servidor emissor, faça push para o endereço relayium:// do receptor. A primeira conexão fixa a impressão digital do receptor; toda conexão posterior a verifica, e uma impressão digital alterada é recusada em vez de aceita silenciosamente — assim, uma chave trocada ou um ataque de intermediário é detectado, não confiado. No primeiro push, o emissor espera um momento enquanto o receptor o aprova (próximo passo).",
      ],
      code: [
        `# on the SENDER
relayium push ./build.tar.zst relayium://receiver.example.com

# non-default port
relayium push ./build.tar.zst relayium://receiver.example.com:9040`,
      ],
      bullets: [
        "Sem retransmissor e sem retorno: se o listener não for alcançável, o push falha — os bytes do arquivo nunca são roteados por mais ninguém.",
        "O mesmo motor de transferência dos outros modos: retomável, com uma verificação SHA-256 por arquivo.",
      ],
    },
    {
      heading: "Aprovar o emissor no primeiro push (no receptor)",
      body: [
        "Na primeira vez que uma máquina nova faz push para o seu listener, serve (em um terminal) mostra de onde ela vem e sua impressão digital e pede que você a aprove — como o prompt de primeira conexão do SSH, mas no lado receptor:",
      ],
      code: [
        `# on the RECEIVER, when a new sender pushes:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Responda y e essa impressão digital é lembrada em authorized_fingerprints; cada push posterior da mesma máquina passa então em silêncio.",
        "A impressão digital é a identidade estável de uma máquina (sobrevive a reinicializações e mudanças de IP), então aprovar é um passo único por emissor.",
        "O emissor, por sua vez, aprende a chave do listener na primeira conexão (confiança no primeiro uso) e a fixa em known_hosts.",
      ],
    },
    {
      heading: "Automatizá-lo (ou executá-lo sem terminal)",
      body: [
        "Como uma impressão digital aprovada é lembrada, os pushes posteriores não precisam de prompt, então relayium push se encaixa direto em cron, um script de deploy ou CI para uma sincronização de servidor para servidor criptografada, com integridade verificada e retomável. Quando serve roda sem terminal (um serviço do systemd, um pipe) ele não pode perguntar, então rejeita emissores desconhecidos; pré-autorize-os em vez disso. Obtenha a impressão digital com relayium id no emissor, ou copie-a da linha \"rejected unauthorized peer …\" no log do serve, e então:",
      ],
      code: [
        `# on the RECEIVER: pre-authorize a sender without a prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Os arquivos de identidade e confiança ficam em ~/.config/relayium/ (substitua com --config-dir, por exemplo /etc/relayium para um serviço).",
        "authorize é idempotente — executá-lo novamente para a mesma impressão digital não faz nada.",
      ],
    },
    {
      heading: "Executar o listener sob systemd",
      body: [
        "Para uma caixa de entrada sempre ativa, execute serve como um serviço do systemd. Aponte --config-dir para um local fixo como /etc/relayium para que a identidade seja estável entre reinicializações, e deixe o systemd mantê-la viva:",
      ],
      code: [
        `# /etc/systemd/system/relayium-serve.service
[Unit]
Description=Relayium daemon-direct listener
After=network-online.target

[Service]
ExecStart=/usr/local/bin/relayium serve --dir /srv/inbox --config-dir /etc/relayium
Restart=always
User=relayium

[Install]
WantedBy=multi-user.target`,
      ],
      bullets: [
        "systemctl enable --now relayium-serve para iniciá-lo e subi-lo no boot.",
        "Mantenha /etc/relayium/id.key legível apenas pelo usuário do serviço — relayium se recusa a carregar uma chave com permissões frouxas.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Em que o daemon direct difere de push por SSH?",
        a: "push por SSH tunela a transferência pela sua conexão SSH e precisa de uma conta SSH no remoto. O daemon direct não precisa de SSH nem de conta — os dois servidores se autenticam mutuamente pela impressão digital do certificado sobre TLS fixado, o que é mais leve quando as duas máquinas são suas.",
      },
      {
        q: "Preciso copiar impressões digitais à mão de um lado para o outro?",
        a: "Não. Em um terminal, serve pede que você aprove cada novo emissor no seu primeiro push — mostrando seu endereço e sua impressão digital — e o lembra, então os pushes posteriores são silenciosos. Você só recorre a relayium id ou relayium authorize em configurações não interativas como um serviço do systemd, onde não há ninguém para responder ao prompt.",
      },
      {
        q: "Onde estão os arquivos de identidade e confiança?",
        a: "Em ~/.config/relayium/ por padrão (substitua com --config-dir). id.key / id.crt são a identidade persistente deste host, known_hosts guarda as impressões digitais dos listeners para os quais você fez push, e authorized_fingerprints é a lista de permissão de emissores do listener.",
      },
      {
        q: "O que acontece se uma impressão digital mudar?",
        a: "O push é recusado e avisa. A chave do listener é fixada em known_hosts no primeiro uso, então uma mudança posterior — um host com chave regenerada ou um ataque de intermediário — é rejeitada em vez de aceita silenciosamente. Remova a linha do known_hosts apenas se você rotacionou a chave intencionalmente.",
      },
      {
        q: "Existe algum retorno por retransmissor?",
        a: "Não. O daemon direct pressupõe um endereço de listener alcançável; se a conexão não puder ser feita, ela falha. Nada é jamais roteado via proxy pelo Relayium — esse é o propósito deste modo.",
      },
    ],
  },
  cta: {
    text: "Conecte dois dos seus próprios servidores para transferências diretas — sem retransmissor, sem SSH, sem código de emparelhamento.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/server-to-server-transfers",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
