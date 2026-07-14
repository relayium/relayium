// web/scripts/pages/content/articles/guides-own-node.mjs
// "Bring your own node" — attach your own relay/storage node to your relayium.com
// account so your transfers run through it (free, private) instead of our metered
// infrastructure. Distinct from guides-self-host.mjs, which runs the WHOLE server
// stack yourself. English is the master; zh/ja/ko/de/fr keep identical facts.
// Command/env/port blocks (code) stay English in every language.

const INSTALL_CMD =
  "curl -fsSL https://relayium.com/install-node.sh | sudo RELAYIUM_CENTRAL_URL=https://relayium.com RELAYIUM_NODE_TOKEN=<your-token> RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs sh";
// One multi-line string (not three array elements): the article template emits a
// separate <pre> per array element, and we want these three lines in one block.
const PORTS_CODE = [
  "sudo ufw allow 3478/udp        # TURN\nsudo ufw allow 8081/tcp        # storage\nsudo ufw allow 49152:65535/udp # relay",
];

const en = {
  title: "Bring your own node: use Relayium relay & storage for free",
  description:
    "Attach your own relay/storage node to your Relayium account with one command. Your transfers then run through your node — not our metered servers — so they're free, and the data stays on hardware you control.",
  updatedLabel: "Last updated",
  lead: [
    "Cross-network transfers and stored links use relay bandwidth and disk that cost us money, so they run on a free allowance and are paid past it. There's a way around that: run your own relay/storage node, bind it to your account, and your transfers flow through your node instead of ours — nothing metered, nothing billed.",
    "This is different from self-hosting the whole Relayium server. You keep using your normal relayium.com account and the same apps; you're just adding a node you own to carry your traffic. This guide takes you from a fresh Linux box to an online node in about five minutes.",
  ],
  sections: [
    {
      heading: "Why run your own node",
      body: [
        "Two reasons. First, cost: a node you own carries your relay and storage traffic directly, so it never touches our metered infrastructure and there is nothing to bill — your usage is free no matter how large.",
        "Second, control: the relayed bytes and stored blobs live on hardware you run, under your own operational control. Realtime transfers stay end-to-end encrypted the whole way, so even your own node only ever sees ciphertext.",
      ],
    },
    {
      heading: "What you need",
      body: [
        "A Linux server reachable from the internet — a cheap VPS or an always-on box at home both work. You'll need root (or sudo), and the ability to open a few inbound ports. Both amd64 and arm64 are supported.",
      ],
    },
    {
      heading: "Step 1 — get your install command",
      body: [
        "Sign in at relayium.com, open the account page (/me), scroll to My Nodes, and click Add node. You'll get a one-time install command with a token baked in — the token is shown only once, so copy it right away. It looks like this:",
      ],
      code: [INSTALL_CMD],
      bullets: [
        "The <your-token> part is filled in for you on the account page — don't paste the placeholder above literally.",
        "RELAYIUM_NODE_STORAGE_DIR turns on blob storage as well as relay. Leave it off (omit the variable) if you only want the node to relay, not store.",
      ],
    },
    {
      heading: "Step 2 — run it on your server, as root",
      body: [
        "Paste the command on your server. It pipes our installer into sh: the installer downloads and checksum-verifies the relayium-node binary, installs it to /usr/local/bin, writes a systemd service, and starts it. The leading sudo is why it can install the service; if you're already root it's a harmless no-op.",
        "Because it's a systemd service, the node is enabled on boot and restarts itself if it ever crashes — it stays online across reboots with nothing more to do. If you see `relayium-node: command not found`, you ran the binary directly instead of the installer above — the one-line command is what puts the binary in place.",
      ],
      bullets: [
        "Check it started: `systemctl status relayium-node` (should read active/running).",
        "Confirm boot-persistence: `systemctl is-enabled relayium-node` (should read enabled).",
        "Watch logs live: `journalctl -u relayium-node -f`.",
      ],
    },
    {
      heading: "Step 3 — open the inbound ports",
      body: [
        "Being online (a heartbeat to relayium.com) only needs outbound access, which you already have. But for peers to actually relay through and store on your node, its inbound ports must be reachable. If the host runs a firewall, open them — with ufw that's:",
      ],
      code: PORTS_CODE,
      bullets: [
        "3478/udp is the TURN port peers use to relay; 8081/tcp is the blob-storage HTTP port; 49152–65535/udp is the relay media range.",
        "On a cloud VPS, also allow these in the provider's security group / network firewall, not just ufw.",
      ],
    },
    {
      heading: "Step 4 — confirm and route through it",
      body: [
        "Back on the account page, your node appears under My Nodes and flips to Online within about 30 seconds. From then on your account's transfers prefer your own node automatically.",
        "To force it — never fall back to our shared infrastructure — turn on \"Only use my own nodes for relay/storage\" on the same page. With that on, if none of your nodes are online a transfer fails rather than quietly using ours.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "I got \"relayium-node: command not found\" — what went wrong?",
        a: "You ran the relayium-node binary before installing it. Use the one-line install command from the account page (the curl … | sudo … sh form): it downloads the binary, puts it on your PATH, and starts it as a service. You never install relayium-node separately.",
      },
      {
        q: "Does the node stay online after a reboot?",
        a: "Yes. The installer registers a systemd service that is enabled on boot and set to Restart=always, so it comes back after a reboot and restarts itself if it crashes. Nothing extra to run.",
      },
      {
        q: "How is this different from self-hosting Relayium?",
        a: "Bring-your-own-node keeps your normal relayium.com account and apps and just adds a node you own to carry your traffic. Self-hosting runs the entire server stack (accounts, web app, signaling) on your own domain — see the \"Self-host Relayium\" guide for that.",
      },
      {
        q: "Can anyone else use my node or see my data?",
        a: "No. A node is bound to your account by its token and only carries your account's traffic. Realtime transfers are end-to-end encrypted and stored blobs are ciphertext your node can't read. Your data and node configuration are only ever usable by you.",
      },
    ],
  },
  cta: {
    text: "Sign in, open your account page, and add your first node in under a minute.",
    button: "Open the account page",
    href: "/me",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "自建节点：免费使用 Relayium 的中转与存储",
  description:
    "用一条命令把你自己的中转/存储节点绑定到 Relayium 账号。之后你的传输全部走你自己的节点、不经过我们的计量服务器——因此免费，数据也留在你自己掌控的硬件上。",
  updatedLabel: "最近更新",
  lead: [
    "跨网络传输和存储型链接会消耗中继带宽和磁盘，这对我们是有成本的，所以它们按免费额度提供、超出后收费。但有个绕过办法：自己搭一个中转/存储节点，绑定到你的账号，之后你的传输就走你自己的节点而不是我们的——不计量、不收费。",
    "这跟「自托管整套 Relayium 服务端」不是一回事。你依然用你平常的 relayium.com 账号、同样的客户端；只是多接了一个你自己名下的节点来承载你的流量。本指南带你从一台全新的 Linux 服务器，到节点上线，大约五分钟。",
  ],
  sections: [
    {
      heading: "为什么要自建节点",
      body: [
        "两个理由。其一是成本：你自己的节点直接承载你的中转和存储流量，完全不碰我们的计量设施，也就没有任何可计费的东西——无论用量多大都免费。",
        "其二是掌控：中转的字节和存储的数据块都落在你自己运行的硬件上，由你自己运维。实时传输全程端到端加密，所以即便是你自己的节点，看到的也只是密文。",
      ],
    },
    {
      heading: "你需要什么",
      body: [
        "一台能从公网访问的 Linux 服务器——便宜的 VPS 或家里常开的机器都行。你需要 root（或 sudo）权限，以及放通几个入站端口的能力。amd64 和 arm64 都支持。",
      ],
    },
    {
      heading: "第一步 —— 拿到你的安装命令",
      body: [
        "在 relayium.com 登录，打开账户页（/me），滚动到「我的节点」，点「添加节点」。你会得到一条内嵌令牌的一次性安装命令——令牌只显示这一次，请立即复制。它长这样：",
      ],
      code: [INSTALL_CMD],
      bullets: [
        "其中 <your-token> 会在账户页里替你填好——不要直接照抄上面的占位符。",
        "RELAYIUM_NODE_STORAGE_DIR 会同时开启存储（不只是中转）。如果你只想让节点中转、不存储，去掉这个变量即可。",
      ],
    },
    {
      heading: "第二步 —— 在你的服务器上以 root 运行",
      body: [
        "把命令粘到你的服务器上。它会把我们的安装脚本管道给 sh：脚本下载并校验 relayium-node 二进制、装到 /usr/local/bin、写好 systemd 服务并启动它。开头的 sudo 就是它能安装服务的原因；如果你本来就是 root，sudo 是无副作用的空操作。",
        "因为它是 systemd 服务，节点会开机自启，崩溃后也会自动重启——无需额外操作就能一直在线。如果你看到 `relayium-node: command not found`，说明你直接运行了二进制、而不是上面的安装命令——正是那条一行命令把二进制装好的。",
      ],
      bullets: [
        "确认已启动：`systemctl status relayium-node`（应为 active/running）。",
        "确认开机自启：`systemctl is-enabled relayium-node`（应为 enabled）。",
        "实时看日志：`journalctl -u relayium-node -f`。",
      ],
    },
    {
      heading: "第三步 —— 放通入站端口",
      body: [
        "「在线」（向 relayium.com 发心跳）只需要出站访问，你已经有了。但要让别人真正通过你的节点中转、往上存储，它的入站端口必须可达。如果这台主机开了防火墙，就放通它们——用 ufw 就是：",
      ],
      code: PORTS_CODE,
      bullets: [
        "3478/udp 是别人用来中继的 TURN 端口；8081/tcp 是存储的 HTTP 端口；49152–65535/udp 是中继媒体端口段。",
        "在云 VPS 上，还要在服务商的安全组 / 网络防火墙里放通这些端口，不只是 ufw。",
      ],
    },
    {
      heading: "第四步 —— 确认并让流量走它",
      body: [
        "回到账户页，你的节点会出现在「我的节点」里，约 30 秒内变为「在线」。从此你账号的传输会自动优先使用你自己的节点。",
        "想强制生效——绝不回落到我们的公共设施——就在同一页打开「仅使用我自己的节点中转/存储」。开启后，若你的节点都不在线，传输会失败，而不是悄悄用我们的。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我遇到「relayium-node: command not found」，哪里错了？",
        a: "你在安装之前就运行了 relayium-node 二进制。请用账户页给的那条一行安装命令（curl … | sudo … sh 形式）：它会下载二进制、放到 PATH 上，并作为服务启动。你从不需要单独安装 relayium-node。",
      },
      {
        q: "重启之后节点还会在线吗？",
        a: "会。安装脚本注册了一个 systemd 服务，开机自启且设为 Restart=always，所以重启后会自动回来，崩溃也会自愈。无需额外操作。",
      },
      {
        q: "这跟自托管 Relayium 有什么区别？",
        a: "自建节点保留你平常的 relayium.com 账号和客户端，只是多接一个你自己的节点来承载流量。自托管则是在你自己的域名上运行整套服务端（账号、Web 应用、信令）——那个见「自托管 Relayium」指南。",
      },
      {
        q: "别人能用我的节点或看到我的数据吗？",
        a: "不能。节点通过令牌绑定到你的账号，只承载你账号的流量。实时传输端到端加密，存储的数据块是你的节点也读不了的密文。你的数据和节点配置只为你自己所用。",
      },
    ],
  },
  cta: {
    text: "登录，打开账户页，一分钟内添加你的第一个节点。",
    button: "打开账户页",
    href: "/me",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Bring Your Own Node: Relayium のリレー＆ストレージを無料で使う",
  description:
    "自分で用意したリレー／ストレージノードを、コマンド1つで Relayium アカウントに紐付けます。以降、あなたの転送は当社の従量課金サーバーではなく自分のノードを経由するので無料になり、データもあなたが管理するハードウェア上にとどまります。",
  updatedLabel: "最終更新",
  lead: [
    "ネットワークをまたぐ転送や保存リンクは、当社にとってコストのかかるリレー帯域とディスクを使うため、無料枠の範囲内で動作し、それを超えると有料になります。それを回避する方法があります。自分のリレー／ストレージノードを立ち上げてアカウントに紐付ければ、あなたの転送は当社ではなく自分のノードを経由するようになり、従量課金も請求も一切ありません。",
    "これは Relayium サーバー全体をセルフホストするのとは異なります。いつもの relayium.com アカウントと同じアプリをそのまま使い続け、自分のトラフィックを運ぶノードを追加するだけです。このガイドでは、まっさらな Linux マシンからオンラインのノードまで、およそ5分で到達できます。",
  ],
  sections: [
    {
      heading: "なぜ自分のノードを立てるのか",
      body: [
        "理由は2つあります。1つ目はコストです。自分のノードはあなたのリレーとストレージのトラフィックを直接運ぶため、当社の従量課金インフラに一切触れず、請求するものが何もありません。使用量がどれだけ大きくても無料です。",
        "2つ目はコントロールです。リレーされたバイト列や保存されたブロブは、あなたが運用し、あなた自身の運用管理下にあるハードウェア上に存在します。リアルタイム転送は全経路でエンドツーエンド暗号化されたままなので、自分のノードでさえ常に暗号文しか見えません。",
      ],
    },
    {
      heading: "必要なもの",
      body: [
        "インターネットから到達可能な Linux サーバー。安価な VPS でも、自宅の常時稼働マシンでも構いません。root（または sudo）と、いくつかの受信ポートを開ける権限が必要です。amd64 と arm64 の両方に対応しています。",
      ],
    },
    {
      heading: "ステップ1 — インストールコマンドを取得する",
      body: [
        "relayium.com にサインインし、アカウントページ（/me）を開いて、My Nodes までスクロールし、Add node をクリックします。トークンが埋め込まれた一度きりのインストールコマンドが表示されます。トークンは一度しか表示されないので、すぐにコピーしてください。次のような形式です。",
      ],
      code: [INSTALL_CMD],
      bullets: [
        "<your-token> の部分はアカウントページで自動的に埋め込まれます。上のプレースホルダーをそのまま貼り付けないでください。",
        "RELAYIUM_NODE_STORAGE_DIR はリレーに加えてブロブストレージを有効にします。ノードをリレー専用にして保存させたくない場合は、これをオフのまま（変数を省略）にしてください。",
      ],
    },
    {
      heading: "ステップ2 — サーバー上で root として実行する",
      body: [
        "サーバー上でコマンドを貼り付けます。これは当社のインストーラーを sh にパイプします。インストーラーは relayium-node バイナリをダウンロードしてチェックサムを検証し、/usr/local/bin にインストールし、systemd サービスを書き込んで起動します。先頭の sudo があるおかげでサービスをインストールできます。すでに root の場合は無害な no-op です。",
        "systemd サービスなので、ノードは起動時に有効化され、万一クラッシュしても自動的に再起動します。再起動をまたいでオンラインを維持し、追加の作業は不要です。`relayium-node: command not found` と表示された場合は、上記のインストーラーではなくバイナリを直接実行しています。バイナリを配置するのはこのワンライナーコマンドです。",
      ],
      bullets: [
        "起動を確認: `systemctl status relayium-node`（active/running と表示されるはず）。",
        "起動時の永続性を確認: `systemctl is-enabled relayium-node`（enabled と表示されるはず）。",
        "ログをライブで監視: `journalctl -u relayium-node -f`。",
      ],
    },
    {
      heading: "ステップ3 — 受信ポートを開く",
      body: [
        "オンライン状態（relayium.com へのハートビート）には送信アクセスだけが必要で、これはすでに備わっています。しかしピアが実際にあなたのノードを経由してリレーし、保存するには、その受信ポートが到達可能でなければなりません。ホストでファイアウォールが動いている場合は開放してください。ufw では次のようにします。",
      ],
      code: PORTS_CODE,
      bullets: [
        "3478/udp はピアがリレーに使う TURN ポート、8081/tcp はブロブストレージの HTTP ポート、49152–65535/udp はリレーメディアの範囲です。",
        "クラウド VPS では、ufw だけでなくプロバイダーのセキュリティグループ／ネットワークファイアウォールでもこれらを許可してください。",
      ],
    },
    {
      heading: "ステップ4 — 確認して経由させる",
      body: [
        "アカウントページに戻ると、あなたのノードが My Nodes の下に表示され、約30秒以内に Online に切り替わります。それ以降、あなたのアカウントの転送は自動的に自分のノードを優先します。",
        "強制するには — 当社の共有インフラに決してフォールバックしない — 同じページで「Only use my own nodes for relay/storage」をオンにします。これをオンにすると、自分のノードが1つもオンラインでない場合、当社のものを黙って使うのではなく転送が失敗します。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "「relayium-node: command not found」と表示されました — 何が問題ですか？",
        a: "relayium-node バイナリをインストールする前に実行しています。アカウントページのワンライナーインストールコマンド（curl … | sudo … sh の形式）を使ってください。これがバイナリをダウンロードし、PATH に配置し、サービスとして起動します。relayium-node を個別にインストールすることは決してありません。",
      },
      {
        q: "再起動後もノードはオンラインを維持しますか？",
        a: "はい。インストーラーは、起動時に有効化され Restart=always に設定された systemd サービスを登録するため、再起動後に復帰し、クラッシュしても自動的に再起動します。追加で実行するものはありません。",
      },
      {
        q: "これは Relayium のセルフホストとどう違うのですか？",
        a: "Bring-your-own-node は、いつもの relayium.com アカウントとアプリをそのまま使い、自分のトラフィックを運ぶノードを追加するだけです。セルフホストはサーバースタック全体（アカウント、Web アプリ、シグナリング）を自分のドメインで運用します。それについては \"Self-host Relayium\" ガイドを参照してください。",
      },
      {
        q: "他の誰かが私のノードを使ったり、私のデータを見たりできますか？",
        a: "いいえ。ノードはトークンによってあなたのアカウントに紐付けられ、あなたのアカウントのトラフィックのみを運びます。リアルタイム転送はエンドツーエンド暗号化されており、保存されるブロブはあなたのノードが読めない暗号文です。あなたのデータとノード設定は、あなただけが利用できます。",
      },
    ],
  },
  cta: {
    text: "サインインしてアカウントページを開き、1分もかからず最初のノードを追加しましょう。",
    button: "アカウントページを開く",
    href: "/me",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Bring Your Own Node: Relayium 릴레이 및 스토리지를 무료로 사용하기",
  description:
    "직접 준비한 릴레이/스토리지 노드를 명령어 하나로 Relayium 계정에 연결하세요. 그러면 전송이 종량제 서버가 아닌 여러분의 노드를 통해 이루어지므로 무료이며, 데이터도 여러분이 관리하는 하드웨어에 남습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "네트워크를 넘나드는 전송과 저장된 링크는 당사에 비용이 드는 릴레이 대역폭과 디스크를 사용하므로, 무료 허용량 내에서 동작하고 그 이상은 유료입니다. 이를 우회하는 방법이 있습니다. 직접 릴레이/스토리지 노드를 운영하여 계정에 연결하면, 전송이 당사가 아닌 여러분의 노드를 통해 흐르며 종량 계측도 청구도 전혀 없습니다.",
    "이는 Relayium 서버 전체를 셀프 호스팅하는 것과는 다릅니다. 평소 쓰던 relayium.com 계정과 동일한 앱을 그대로 사용하면서, 트래픽을 운반할 여러분 소유의 노드를 추가하는 것뿐입니다. 이 가이드는 새로운 Linux 머신에서 온라인 노드까지 약 5분 만에 안내합니다.",
  ],
  sections: [
    {
      heading: "왜 직접 노드를 운영해야 하나",
      body: [
        "두 가지 이유가 있습니다. 첫째, 비용입니다. 직접 운영하는 노드는 여러분의 릴레이와 스토리지 트래픽을 직접 운반하므로 당사의 종량제 인프라에 전혀 닿지 않고 청구할 것이 없습니다. 사용량이 아무리 커도 무료입니다.",
        "둘째, 통제권입니다. 릴레이된 바이트와 저장된 블롭은 여러분이 운영하고 여러분 자신의 운영 통제하에 있는 하드웨어에 존재합니다. 실시간 전송은 전 구간에서 종단 간 암호화를 유지하므로, 여러분 자신의 노드조차 항상 암호문만 보게 됩니다.",
      ],
    },
    {
      heading: "필요한 것",
      body: [
        "인터넷에서 접근 가능한 Linux 서버 — 저렴한 VPS든 집에 상시 켜둔 머신이든 모두 가능합니다. root(또는 sudo)와 몇 개의 인바운드 포트를 열 수 있는 권한이 필요합니다. amd64와 arm64 모두 지원됩니다.",
      ],
    },
    {
      heading: "1단계 — 설치 명령어 받기",
      body: [
        "relayium.com에 로그인하여 계정 페이지(/me)를 열고, My Nodes까지 스크롤한 뒤 Add node를 클릭하세요. 토큰이 삽입된 일회성 설치 명령어를 받게 됩니다. 토큰은 한 번만 표시되므로 즉시 복사하세요. 다음과 같은 형태입니다.",
      ],
      code: [INSTALL_CMD],
      bullets: [
        "<your-token> 부분은 계정 페이지에서 자동으로 채워집니다. 위의 자리 표시자를 그대로 붙여넣지 마세요.",
        "RELAYIUM_NODE_STORAGE_DIR는 릴레이뿐 아니라 블롭 스토리지도 켭니다. 노드가 저장하지 않고 릴레이만 하기를 원한다면 이를 끈 채로(변수를 생략) 두세요.",
      ],
    },
    {
      heading: "2단계 — 서버에서 root로 실행하기",
      body: [
        "서버에 명령어를 붙여넣으세요. 이는 당사의 설치 프로그램을 sh로 파이프합니다. 설치 프로그램은 relayium-node 바이너리를 다운로드하고 체크섬을 검증한 뒤 /usr/local/bin에 설치하고, systemd 서비스를 작성하여 시작합니다. 앞의 sudo 덕분에 서비스를 설치할 수 있으며, 이미 root라면 무해한 no-op입니다.",
        "systemd 서비스이므로 노드는 부팅 시 활성화되고 혹시 충돌하더라도 스스로 재시작합니다. 추가 작업 없이 재부팅을 넘나들며 온라인을 유지합니다. `relayium-node: command not found`가 보인다면 위의 설치 프로그램 대신 바이너리를 직접 실행한 것입니다. 바이너리를 제자리에 놓는 것은 이 한 줄 명령어입니다.",
      ],
      bullets: [
        "시작되었는지 확인: `systemctl status relayium-node`(active/running으로 표시되어야 함).",
        "부팅 지속성 확인: `systemctl is-enabled relayium-node`(enabled로 표시되어야 함).",
        "로그 실시간 확인: `journalctl -u relayium-node -f`.",
      ],
    },
    {
      heading: "3단계 — 인바운드 포트 열기",
      body: [
        "온라인 상태(relayium.com으로의 하트비트)에는 이미 갖추고 있는 아웃바운드 접근만 필요합니다. 하지만 피어가 실제로 여러분의 노드를 통해 릴레이하고 저장하려면 인바운드 포트가 접근 가능해야 합니다. 호스트에서 방화벽이 실행 중이라면 열어 주세요. ufw에서는 다음과 같습니다.",
      ],
      code: PORTS_CODE,
      bullets: [
        "3478/udp는 피어가 릴레이에 사용하는 TURN 포트이고, 8081/tcp는 블롭 스토리지 HTTP 포트이며, 49152–65535/udp는 릴레이 미디어 범위입니다.",
        "클라우드 VPS에서는 ufw뿐 아니라 공급자의 보안 그룹/네트워크 방화벽에서도 이들을 허용하세요.",
      ],
    },
    {
      heading: "4단계 — 확인하고 노드를 경유시키기",
      body: [
        "계정 페이지로 돌아가면 여러분의 노드가 My Nodes 아래에 나타나고 약 30초 이내에 Online으로 바뀝니다. 그때부터 여러분 계정의 전송은 자동으로 여러분의 노드를 우선합니다.",
        "이를 강제하려면 — 당사의 공유 인프라로 절대 폴백하지 않도록 — 같은 페이지에서 \"Only use my own nodes for relay/storage\"를 켜세요. 이를 켜면 여러분의 노드가 하나도 온라인이 아닐 때 당사 것을 조용히 사용하는 대신 전송이 실패합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "\"relayium-node: command not found\"가 떴습니다 — 무엇이 잘못되었나요?",
        a: "relayium-node 바이너리를 설치하기 전에 실행한 것입니다. 계정 페이지의 한 줄 설치 명령어(curl … | sudo … sh 형태)를 사용하세요. 이것이 바이너리를 다운로드하여 PATH에 놓고 서비스로 시작합니다. relayium-node를 별도로 설치하는 일은 결코 없습니다.",
      },
      {
        q: "재부팅 후에도 노드가 온라인을 유지하나요?",
        a: "네. 설치 프로그램은 부팅 시 활성화되고 Restart=always로 설정된 systemd 서비스를 등록하므로, 재부팅 후 복귀하고 충돌하면 스스로 재시작합니다. 추가로 실행할 것은 없습니다.",
      },
      {
        q: "이것은 Relayium 셀프 호스팅과 어떻게 다른가요?",
        a: "Bring-your-own-node는 평소의 relayium.com 계정과 앱을 그대로 유지하면서 트래픽을 운반할 여러분 소유의 노드를 추가하는 것뿐입니다. 셀프 호스팅은 서버 스택 전체(계정, 웹 앱, 시그널링)를 여러분 자신의 도메인에서 운영합니다. 이에 대해서는 \"Self-host Relayium\" 가이드를 참조하세요.",
      },
      {
        q: "다른 사람이 제 노드를 사용하거나 제 데이터를 볼 수 있나요?",
        a: "아니요. 노드는 토큰으로 여러분의 계정에 연결되어 여러분 계정의 트래픽만 운반합니다. 실시간 전송은 종단 간 암호화되고, 저장된 블롭은 여러분의 노드가 읽을 수 없는 암호문입니다. 여러분의 데이터와 노드 구성은 오직 여러분만 사용할 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "로그인하여 계정 페이지를 열고 1분도 안 되어 첫 노드를 추가하세요.",
    button: "계정 페이지 열기",
    href: "/me",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Bring Your Own Node: Relais und Speicher von Relayium kostenlos nutzen",
  description:
    "Binden Sie mit einem einzigen Befehl Ihren eigenen Relais-/Speicher-Node an Ihr Relayium-Konto an. Ihre Übertragungen laufen dann über Ihren Node — nicht über unsere abrechnungspflichtigen Server —, sind also kostenlos, und die Daten bleiben auf Hardware, die Sie selbst kontrollieren.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Netzübergreifende Übertragungen und gespeicherte Links nutzen Relais-Bandbreite und Speicherplatz, die uns Geld kosten, und laufen daher auf einem kostenlosen Kontingent, das darüber hinaus kostenpflichtig ist. Es gibt einen Ausweg: Betreiben Sie Ihren eigenen Relais-/Speicher-Node, binden Sie ihn an Ihr Konto, und Ihre Übertragungen fließen über Ihren Node statt über unseren — nichts wird gemessen, nichts wird berechnet.",
    "Das unterscheidet sich davon, den gesamten Relayium-Server selbst zu hosten. Sie verwenden weiterhin Ihr normales relayium.com-Konto und dieselben Apps; Sie fügen lediglich einen Node hinzu, der Ihnen gehört und Ihren Datenverkehr trägt. Diese Anleitung führt Sie in etwa fünf Minuten von einem frischen Linux-Rechner zu einem Online-Node.",
  ],
  sections: [
    {
      heading: "Warum einen eigenen Node betreiben",
      body: [
        "Zwei Gründe. Erstens die Kosten: Ein Node, der Ihnen gehört, trägt Ihren Relais- und Speicherverkehr direkt, berührt also nie unsere abrechnungspflichtige Infrastruktur, und es gibt nichts zu berechnen — Ihre Nutzung ist kostenlos, egal wie groß.",
        "Zweitens die Kontrolle: Die weitergeleiteten Bytes und gespeicherten Blobs liegen auf Hardware, die Sie betreiben, unter Ihrer eigenen betrieblichen Kontrolle. Echtzeit-Übertragungen bleiben auf dem gesamten Weg Ende-zu-Ende-verschlüsselt, sodass selbst Ihr eigener Node immer nur Chiffretext sieht.",
      ],
    },
    {
      heading: "Was Sie brauchen",
      body: [
        "Einen aus dem Internet erreichbaren Linux-Server — ein günstiger VPS oder ein dauerhaft laufender Rechner zu Hause funktionieren beide. Sie benötigen root (oder sudo) und die Möglichkeit, einige eingehende Ports zu öffnen. Sowohl amd64 als auch arm64 werden unterstützt.",
      ],
    },
    {
      heading: "Schritt 1 — Ihren Installationsbefehl abrufen",
      body: [
        "Melden Sie sich bei relayium.com an, öffnen Sie die Kontoseite (/me), scrollen Sie zu My Nodes und klicken Sie auf Add node. Sie erhalten einen einmaligen Installationsbefehl mit eingebettetem Token — der Token wird nur einmal angezeigt, kopieren Sie ihn also sofort. Er sieht so aus:",
      ],
      code: [INSTALL_CMD],
      bullets: [
        "Der Teil <your-token> wird auf der Kontoseite für Sie ausgefüllt — fügen Sie den obigen Platzhalter nicht wörtlich ein.",
        "RELAYIUM_NODE_STORAGE_DIR aktiviert neben dem Relais auch die Blob-Speicherung. Lassen Sie es weg (die Variable auslassen), wenn der Node nur weiterleiten und nicht speichern soll.",
      ],
    },
    {
      heading: "Schritt 2 — auf Ihrem Server als root ausführen",
      body: [
        "Fügen Sie den Befehl auf Ihrem Server ein. Er leitet unseren Installer an sh weiter: Der Installer lädt die relayium-node-Binärdatei herunter, verifiziert sie per Prüfsumme, installiert sie nach /usr/local/bin, schreibt einen systemd-Dienst und startet ihn. Das führende sudo ist der Grund, warum er den Dienst installieren kann; wenn Sie bereits root sind, ist es ein harmloser No-op.",
        "Da es sich um einen systemd-Dienst handelt, wird der Node beim Booten aktiviert und startet sich selbst neu, falls er jemals abstürzt — er bleibt über Neustarts hinweg online, ohne dass Sie weiter etwas tun müssen. Wenn Sie `relayium-node: command not found` sehen, haben Sie die Binärdatei direkt ausgeführt statt des obigen Installers — der Einzeiler ist es, der die Binärdatei an ihren Platz bringt.",
      ],
      bullets: [
        "Prüfen, ob er gestartet ist: `systemctl status relayium-node` (sollte active/running anzeigen).",
        "Boot-Persistenz bestätigen: `systemctl is-enabled relayium-node` (sollte enabled anzeigen).",
        "Logs live verfolgen: `journalctl -u relayium-node -f`.",
      ],
    },
    {
      heading: "Schritt 3 — die eingehenden Ports öffnen",
      body: [
        "Online zu sein (ein Heartbeat an relayium.com) erfordert nur ausgehenden Zugriff, den Sie bereits haben. Damit Peers aber tatsächlich über Ihren Node weiterleiten und darauf speichern können, müssen dessen eingehende Ports erreichbar sein. Wenn auf dem Host eine Firewall läuft, öffnen Sie sie — mit ufw geht das so:",
      ],
      code: PORTS_CODE,
      bullets: [
        "3478/udp ist der TURN-Port, den Peers zum Weiterleiten verwenden; 8081/tcp ist der HTTP-Port der Blob-Speicherung; 49152–65535/udp ist der Relais-Medienbereich.",
        "Auf einem Cloud-VPS erlauben Sie diese auch in der Sicherheitsgruppe / Netzwerk-Firewall des Anbieters, nicht nur in ufw.",
      ],
    },
    {
      heading: "Schritt 4 — bestätigen und den Verkehr darüber leiten",
      body: [
        "Zurück auf der Kontoseite erscheint Ihr Node unter My Nodes und wechselt innerhalb von etwa 30 Sekunden auf Online. Von da an bevorzugen die Übertragungen Ihres Kontos automatisch Ihren eigenen Node.",
        "Um es zu erzwingen — nie auf unsere gemeinsam genutzte Infrastruktur zurückzufallen — aktivieren Sie auf derselben Seite \"Only use my own nodes for relay/storage\". Ist das aktiviert und keiner Ihrer Nodes ist online, schlägt eine Übertragung fehl, statt stillschweigend unsere zu verwenden.",
      ],
    },
  ],
  faq: {
    heading: "Häufig gestellte Fragen",
    items: [
      {
        q: "Ich habe \"relayium-node: command not found\" bekommen — was ist schiefgelaufen?",
        a: "Sie haben die relayium-node-Binärdatei ausgeführt, bevor Sie sie installiert haben. Verwenden Sie den Einzeiler-Installationsbefehl von der Kontoseite (in der Form curl … | sudo … sh): Er lädt die Binärdatei herunter, legt sie in Ihren PATH und startet sie als Dienst. Sie installieren relayium-node nie separat.",
      },
      {
        q: "Bleibt der Node nach einem Neustart online?",
        a: "Ja. Der Installer registriert einen systemd-Dienst, der beim Booten aktiviert und auf Restart=always gesetzt ist, sodass er nach einem Neustart zurückkehrt und sich bei einem Absturz selbst neu startet. Es ist nichts weiter auszuführen.",
      },
      {
        q: "Wie unterscheidet sich das vom Selbst-Hosten von Relayium?",
        a: "Bring-your-own-node behält Ihr normales relayium.com-Konto und Ihre Apps bei und fügt lediglich einen Node hinzu, der Ihnen gehört und Ihren Verkehr trägt. Selbst-Hosten betreibt den gesamten Server-Stack (Konten, Web-App, Signalisierung) auf Ihrer eigenen Domain — siehe dazu die Anleitung \"Self-host Relayium\".",
      },
      {
        q: "Kann jemand anderes meinen Node nutzen oder meine Daten sehen?",
        a: "Nein. Ein Node ist über seinen Token an Ihr Konto gebunden und trägt nur den Verkehr Ihres Kontos. Echtzeit-Übertragungen sind Ende-zu-Ende-verschlüsselt und gespeicherte Blobs sind Chiffretext, den Ihr Node nicht lesen kann. Ihre Daten und Ihre Node-Konfiguration sind ausschließlich von Ihnen nutzbar.",
      },
    ],
  },
  cta: {
    text: "Melden Sie sich an, öffnen Sie Ihre Kontoseite und fügen Sie in unter einer Minute Ihren ersten Node hinzu.",
    button: "Kontoseite öffnen",
    href: "/me",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Bring Your Own Node : utilisez gratuitement le relais et le stockage de Relayium",
  description:
    "Rattachez votre propre nœud de relais/stockage à votre compte Relayium en une seule commande. Vos transferts passent alors par votre nœud — et non par nos serveurs facturés à l'usage —, ils sont donc gratuits, et les données restent sur du matériel que vous contrôlez.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Les transferts inter-réseaux et les liens stockés consomment de la bande passante de relais et de l'espace disque qui nous coûtent de l'argent ; ils fonctionnent donc dans la limite d'un quota gratuit et deviennent payants au-delà. Il existe un moyen de contourner cela : faites tourner votre propre nœud de relais/stockage, rattachez-le à votre compte, et vos transferts passent par votre nœud au lieu du nôtre — rien de mesuré, rien de facturé.",
    "C'est différent d'héberger vous-même l'ensemble du serveur Relayium. Vous continuez à utiliser votre compte relayium.com habituel et les mêmes applications ; vous ajoutez simplement un nœud qui vous appartient pour acheminer votre trafic. Ce guide vous mène d'une machine Linux vierge à un nœud en ligne en environ cinq minutes.",
  ],
  sections: [
    {
      heading: "Pourquoi faire tourner votre propre nœud",
      body: [
        "Deux raisons. D'abord, le coût : un nœud qui vous appartient achemine directement votre trafic de relais et de stockage, il ne touche donc jamais notre infrastructure facturée à l'usage et il n'y a rien à facturer — votre utilisation est gratuite, quelle que soit son ampleur.",
        "Ensuite, le contrôle : les octets relayés et les blobs stockés résident sur du matériel que vous exploitez, sous votre propre contrôle opérationnel. Les transferts en temps réel restent chiffrés de bout en bout sur tout le trajet, de sorte que même votre propre nœud ne voit jamais que du texte chiffré.",
      ],
    },
    {
      heading: "Ce dont vous avez besoin",
      body: [
        "Un serveur Linux accessible depuis Internet — un VPS bon marché ou une machine toujours allumée chez vous conviennent tous les deux. Il vous faut root (ou sudo) et la possibilité d'ouvrir quelques ports entrants. amd64 et arm64 sont tous deux pris en charge.",
      ],
    },
    {
      heading: "Étape 1 — obtenez votre commande d'installation",
      body: [
        "Connectez-vous sur relayium.com, ouvrez la page du compte (/me), faites défiler jusqu'à My Nodes et cliquez sur Add node. Vous obtenez une commande d'installation à usage unique avec un jeton intégré — le jeton n'est affiché qu'une seule fois, copiez-le donc immédiatement. Elle ressemble à ceci :",
      ],
      code: [INSTALL_CMD],
      bullets: [
        "La partie <your-token> est renseignée pour vous sur la page du compte — ne collez pas le paramètre fictif ci-dessus tel quel.",
        "RELAYIUM_NODE_STORAGE_DIR active le stockage de blobs en plus du relais. Laissez-le désactivé (omettez la variable) si vous voulez que le nœud ne fasse que relayer, pas stocker.",
      ],
    },
    {
      heading: "Étape 2 — exécutez-la sur votre serveur, en tant que root",
      body: [
        "Collez la commande sur votre serveur. Elle achemine notre installateur vers sh : l'installateur télécharge le binaire relayium-node et en vérifie la somme de contrôle, l'installe dans /usr/local/bin, écrit un service systemd et le démarre. Le sudo en tête est ce qui lui permet d'installer le service ; si vous êtes déjà root, c'est un no-op sans conséquence.",
        "Comme il s'agit d'un service systemd, le nœud est activé au démarrage et se relance de lui-même s'il venait à planter — il reste en ligne à travers les redémarrages sans rien de plus à faire. Si vous voyez `relayium-node: command not found`, c'est que vous avez exécuté le binaire directement au lieu de l'installateur ci-dessus — c'est la commande en une ligne qui met le binaire en place.",
      ],
      bullets: [
        "Vérifiez qu'il a démarré : `systemctl status relayium-node` (devrait indiquer active/running).",
        "Confirmez la persistance au démarrage : `systemctl is-enabled relayium-node` (devrait indiquer enabled).",
        "Suivez les journaux en direct : `journalctl -u relayium-node -f`.",
      ],
    },
    {
      heading: "Étape 3 — ouvrez les ports entrants",
      body: [
        "Être en ligne (un signal de présence vers relayium.com) ne nécessite qu'un accès sortant, que vous avez déjà. Mais pour que les pairs puissent effectivement relayer via votre nœud et y stocker, ses ports entrants doivent être accessibles. Si l'hôte fait tourner un pare-feu, ouvrez-les — avec ufw, cela donne :",
      ],
      code: PORTS_CODE,
      bullets: [
        "3478/udp est le port TURN que les pairs utilisent pour relayer ; 8081/tcp est le port HTTP du stockage de blobs ; 49152–65535/udp est la plage média du relais.",
        "Sur un VPS cloud, autorisez-les aussi dans le groupe de sécurité / pare-feu réseau du fournisseur, pas seulement dans ufw.",
      ],
    },
    {
      heading: "Étape 4 — confirmez et faites transiter le trafic par lui",
      body: [
        "De retour sur la page du compte, votre nœud apparaît sous My Nodes et passe à Online en une trentaine de secondes. À partir de là, les transferts de votre compte privilégient automatiquement votre propre nœud.",
        "Pour le forcer — ne jamais retomber sur notre infrastructure partagée — activez \"Only use my own nodes for relay/storage\" sur la même page. Avec cette option activée, si aucun de vos nœuds n'est en ligne, un transfert échoue au lieu d'utiliser discrètement les nôtres.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "J'ai obtenu \"relayium-node: command not found\" — qu'est-ce qui a mal tourné ?",
        a: "Vous avez exécuté le binaire relayium-node avant de l'installer. Utilisez la commande d'installation en une ligne de la page du compte (de la forme curl … | sudo … sh) : elle télécharge le binaire, le place dans votre PATH et le démarre en tant que service. Vous n'installez jamais relayium-node séparément.",
      },
      {
        q: "Le nœud reste-t-il en ligne après un redémarrage ?",
        a: "Oui. L'installateur enregistre un service systemd qui est activé au démarrage et réglé sur Restart=always, si bien qu'il revient après un redémarrage et se relance de lui-même en cas de plantage. Rien de plus à exécuter.",
      },
      {
        q: "En quoi est-ce différent d'héberger soi-même Relayium ?",
        a: "Bring-your-own-node conserve votre compte relayium.com et vos applications habituels et ajoute simplement un nœud qui vous appartient pour acheminer votre trafic. L'auto-hébergement fait tourner toute la pile serveur (comptes, application web, signalisation) sur votre propre domaine — voyez le guide \"Self-host Relayium\" pour cela.",
      },
      {
        q: "Quelqu'un d'autre peut-il utiliser mon nœud ou voir mes données ?",
        a: "Non. Un nœud est rattaché à votre compte par son jeton et n'achemine que le trafic de votre compte. Les transferts en temps réel sont chiffrés de bout en bout et les blobs stockés sont du texte chiffré que votre nœud ne peut pas lire. Vos données et la configuration de votre nœud ne sont utilisables que par vous.",
      },
    ],
  },
  cta: {
    text: "Connectez-vous, ouvrez la page de votre compte et ajoutez votre premier nœud en moins d'une minute.",
    button: "Ouvrir la page du compte",
    href: "/me",
  },
  relatedHeading: "Continuer la lecture",
};

const ar = {
  title: "شغّل عقدتك الخاصة: استخدم مُرحِّل وتخزين Relayium مجانًا",
  description:
    "اربط عقدة مُرحِّل/تخزين خاصة بك بحساب Relayium بأمر واحد. عندها تمر عمليات النقل عبر عقدتك — لا عبر خوادمنا المحسوبة بالاستهلاك — فتصبح مجانية، وتبقى البيانات على عتاد تتحكم فيه أنت.",
  updatedLabel: "آخر تحديث",
  lead: [
    "عمليات النقل عبر الشبكات والروابط المُخزَّنة تستهلك عرض نطاق المُرحِّل والقرص، وهذا يكلّفنا مالًا، لذا تعمل ضمن حصة مجانية وتصبح مدفوعة بعد تجاوزها. هناك طريقة لتفادي ذلك: شغّل عقدة مُرحِّل/تخزين خاصة بك، اربطها بحسابك، فتتدفق عمليات نقلك عبر عقدتك بدل عقدتنا — لا شيء يُحسَب، ولا شيء يُفوتَر.",
    "هذا يختلف عن الاستضافة الذاتية لخادم Relayium بالكامل. تبقى تستخدم حساب relayium.com المعتاد ونفس التطبيقات؛ أنت فقط تضيف عقدة تملكها لتحمل حركتك. يأخذك هذا الدليل من جهاز Linux جديد إلى عقدة متصلة في نحو خمس دقائق.",
  ],
  sections: [
    {
      heading: "لماذا تشغّل عقدتك الخاصة",
      body: [
        "سببان. الأول هو التكلفة: عقدة تملكها تحمل حركة مُرحِّلك وتخزينك مباشرة، فلا تلمس أبدًا بنيتنا المحسوبة بالاستهلاك ولا يوجد ما يُفوتَر — استخدامك مجاني مهما كان كبيرًا.",
        "الثاني هو التحكم: البايتات المُرحَّلة والكتل المُخزَّنة تعيش على عتاد تشغّله أنت، تحت تحكمك التشغيلي الخاص. يبقى النقل الفوري مشفَّرًا من الطرف إلى الطرف طوال الطريق، لذا حتى عقدتك الخاصة لا ترى سوى نص مُشفَّر.",
      ],
    },
    {
      heading: "ما الذي تحتاجه",
      body: [
        "خادم Linux يمكن الوصول إليه من الإنترنت — سواء VPS رخيص أو جهاز يعمل دائمًا في المنزل، كلاهما يفي بالغرض. ستحتاج صلاحية root (أو sudo)، والقدرة على فتح بضعة منافذ واردة. كلٌّ من amd64 و arm64 مدعوم.",
      ],
    },
    {
      heading: "الخطوة 1 — احصل على أمر التثبيت الخاص بك",
      body: [
        "سجّل الدخول في relayium.com، افتح صفحة الحساب (/me)، مرّر إلى My Nodes، وانقر على Add node. ستحصل على أمر تثبيت لمرة واحدة مع رمز مضمَّن فيه — يُعرض الرمز مرة واحدة فقط، فانسخه فورًا. يبدو هكذا:",
      ],
      code: [INSTALL_CMD],
      bullets: [
        "الجزء <your-token> يُملأ لك في صفحة الحساب — لا تلصق العنصر النائب أعلاه حرفيًا.",
        "RELAYIUM_NODE_STORAGE_DIR يفعّل تخزين الكتل إضافةً إلى الترحيل. اتركه معطّلًا (احذف المتغير) إن أردت أن تقوم العقدة بالترحيل فقط دون التخزين.",
      ],
    },
    {
      heading: "الخطوة 2 — شغّله على خادمك بصلاحية root",
      body: [
        "الصق الأمر على خادمك. إنه يمرّر مثبّتنا إلى sh: يقوم المثبّت بتنزيل ثنائي relayium-node والتحقق من مجموعه، وتثبيته في /usr/local/bin، وكتابة خدمة systemd وتشغيلها. الـ sudo في البداية هو ما يتيح له تثبيت الخدمة؛ إن كنت أصلًا root فهو عملية لا أثر لها.",
        "لأنها خدمة systemd، تُفعَّل العقدة عند الإقلاع وتعيد تشغيل نفسها إذا تعطّلت — تبقى متصلة عبر عمليات إعادة التشغيل دون أي عمل إضافي. إذا رأيت `relayium-node: command not found`، فأنت شغّلت الثنائي مباشرةً بدل المثبّت أعلاه — الأمر ذو السطر الواحد هو ما يضع الثنائي في مكانه.",
      ],
      bullets: [
        "تأكّد من أنه بدأ: `systemctl status relayium-node` (يجب أن يظهر active/running).",
        "تأكّد من الاستمرارية عبر الإقلاع: `systemctl is-enabled relayium-node` (يجب أن يظهر enabled).",
        "راقب السجلات مباشرة: `journalctl -u relayium-node -f`.",
      ],
    },
    {
      heading: "الخطوة 3 — افتح المنافذ الواردة",
      body: [
        "البقاء متصلًا (نبضة إلى relayium.com) يحتاج وصولًا صادرًا فقط، وهو متوفر لديك بالفعل. لكن لكي يرحّل الأقران فعلًا عبر عقدتك ويخزّنوا عليها، يجب أن تكون منافذها الواردة قابلة للوصول. إن كان المضيف يشغّل جدار حماية، فافتحها — مع ufw يكون ذلك:",
      ],
      code: PORTS_CODE,
      bullets: [
        "المنفذ 3478/udp هو منفذ TURN الذي يستخدمه الأقران للترحيل؛ 8081/tcp هو منفذ HTTP لتخزين الكتل؛ 49152–65535/udp هو نطاق وسائط الترحيل.",
        "على VPS سحابي، اسمح بهذه أيضًا في مجموعة الأمان / جدار حماية الشبكة لدى المزوّد، لا في ufw فقط.",
      ],
    },
    {
      heading: "الخطوة 4 — تأكّد ووجّه الحركة عبرها",
      body: [
        "عند العودة إلى صفحة الحساب، تظهر عقدتك تحت My Nodes وتتحوّل إلى Online خلال نحو 30 ثانية. من ثم تفضّل عمليات نقل حسابك عقدتك الخاصة تلقائيًا.",
        "لفرض ذلك — بحيث لا ترجع أبدًا إلى بنيتنا المشتركة — فعّل \"Only use my own nodes for relay/storage\" في الصفحة ذاتها. مع تفعيله، إذا لم تكن أيٌّ من عقدك متصلة يفشل النقل بدل أن يستخدم عقدنا بصمت.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "ظهر لي \"relayium-node: command not found\" — ما الخطأ؟",
        a: "لقد شغّلت ثنائي relayium-node قبل تثبيته. استخدم أمر التثبيت ذا السطر الواحد من صفحة الحساب (بصيغة curl … | sudo … sh): إنه ينزّل الثنائي، ويضعه في مسار PATH، ويشغّله كخدمة. أنت لا تثبّت relayium-node بشكل منفصل أبدًا.",
      },
      {
        q: "هل تبقى العقدة متصلة بعد إعادة التشغيل؟",
        a: "نعم. يسجّل المثبّت خدمة systemd مُفعَّلة عند الإقلاع ومضبوطة على Restart=always، فتعود بعد إعادة التشغيل وتعيد تشغيل نفسها إذا تعطّلت. لا شيء إضافي لتشغيله.",
      },
      {
        q: "كيف يختلف هذا عن الاستضافة الذاتية لـ Relayium؟",
        a: "تشغيل عقدتك الخاصة يبقي حساب relayium.com المعتاد وتطبيقاتك ويضيف فقط عقدة تملكها لتحمل حركتك. أما الاستضافة الذاتية فتشغّل حزمة الخادم بالكامل (الحسابات، تطبيق الويب، الإشارة) على نطاقك الخاص — راجع دليل \"الاستضافة الذاتية لـ Relayium\" لذلك.",
      },
      {
        q: "هل يمكن لأي شخص آخر استخدام عقدتي أو رؤية بياناتي؟",
        a: "لا. ترتبط العقدة بحسابك عبر رمزها ولا تحمل سوى حركة حسابك. النقل الفوري مشفَّر من الطرف إلى الطرف والكتل المُخزَّنة نص مُشفَّر لا تستطيع عقدتك قراءته. بياناتك وإعدادات عقدتك قابلة للاستخدام من قِبلك أنت وحدك.",
      },
    ],
  },
  cta: {
    text: "سجّل الدخول، افتح صفحة حسابك، وأضف عقدتك الأولى في أقل من دقيقة.",
    button: "افتح صفحة الحساب",
    href: "/me",
  },
  relatedHeading: "تابع القراءة",
};

export default {
  slug: "guides/bring-your-own-node",
  updated: "2026-07-10",
  langs: { en, zh, ja, ko, de, fr, ar },
};
