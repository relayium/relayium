// web/scripts/pages/content/articles/cli-getting-started.mjs
// Getting started with the Relayium CLI. English is the master; zh/ja/ko/de/fr
// follow the same structure with identical facts. Command blocks (code) stay
// English in every language.

const en = {
  title: "Transfer files and text from the terminal with the Relayium CLI",
  description:
    "Install the free, end-to-end-encrypted Relayium CLI to move files over SSH, pairing codes, or daemon-direct — and send ephemeral text while both machines are online.",
  updatedLabel: "Last updated",
  lead: [
    "The Relayium CLI is a single small binary that moves files and ephemeral text from your terminal — encrypted end to end, self-hostable, and completely free. It handles copying files to a server, pushing a build between machines, sending an archive across networks, and moving a URL, command, or code snippet without first saving it as a file.",
    "Whichever way you use it, the file bytes travel directly between the two ends and never pass through Relayium's servers. This guide gets you installed and through your first transfer, then points you at the deeper how-tos for each mode.",
  ],
  sections: [
    {
      heading: "Install in one command",
      body: [
        "On macOS or Linux, one command downloads a prebuilt binary for your OS and puts it on your PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Prefer to pick the file yourself? Download a binary from the releases page.",
        "Have Go installed? Clone the repo and run: go build -o relayium ./cmd/relayium (from the server directory).",
        "Then run relayium --help to see every command, and relayium version to check the build.",
      ],
    },
    {
      heading: "The three ways it moves files",
      body: [
        "Relayium moves files three ways. You pick by where the other end is, not by learning three different tools — they share one transfer engine with per-file resume and SHA-256 verification.",
      ],
      bullets: [
        "push / pull — to a server you can already SSH into. Bytes travel over your SSH connection; no Relayium account.",
        "send / receive — to another person across networks, using a short pairing code the sender's CLI mints (sign in once with relayium login; the receiver never does). Direct peer-to-peer; if a direct path can't be found the transfer fails rather than routing through us.",
        "serve + push relayium:// (daemon direct) — straight between two servers you own, over pinned TLS. No relay, no SSH, no code.",
      ],
    },
    {
      heading: "Send ephemeral text",
      body: [
        "Run relayium text on one machine to mint a pairing code and wait, then join from the other machine with the printed code:",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "Minting the code needs relayium login; joining with a code needs no login.",
        "Both machines must stay online. Messages are end-to-end encrypted, travel over a direct P2P (peer-to-peer) connection, and are never stored; CLI text does not use the browser TURN relay.",
        "Each message can be at most 65,536 UTF-8 bytes. Use relayium send for anything larger.",
      ],
    },
    {
      heading: "Your first transfer",
      body: [
        "The quickest thing to try is copying a folder to a server you can SSH into. Relayium uses your existing SSH access, so there is nothing to configure on the remote and no account to create:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "If relayium is installed on the remote too, push uses the native protocol (resumable, per-file SHA-256).",
        "push falls back to a plain tar stream when relayium isn't on the remote, so it works even against a bare server — that fallback is push-only.",
        "Pull the same files back with: relayium pull user@your-server:backups/ ./restore — pull always needs relayium on the remote (it has no tar fallback), so install it there first.",
      ],
    },
    {
      heading: "Free, and private by design",
      body: [
        "There is nothing to pay. Of the three ways above, the only sign-in is the sender's in send / receive mode, so its CLI can mint a pairing code (cloud up uses your account too, to store the file). The CLI connects the two ends directly, so your files are never uploaded to a server in the middle — the only thing that ever touches Relayium is a tiny rendezvous handshake in send / receive mode, used to introduce the two ends, never the file itself.",
        "Every transfer is encrypted end to end, every file is verified with a SHA-256 hash on arrival, and an interrupted transfer resumes from where it stopped instead of starting over. It runs on macOS, Linux and Windows, and the whole thing is open source and self-hostable.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the CLI cost anything?",
        a: "No. The CLI is completely free. It connects your machines directly and never proxies your file bytes through Relayium, so there is nothing to meter and nothing to pay.",
      },
      {
        q: "Do I need a Relayium account?",
        a: "To send, and for cloud up. push / pull uses your own SSH and daemon direct uses public-key trust between your servers, so neither needs an account. send is different: only the server can mint a pairing code, and only for a signed-in account, so the sender runs relayium login once — a send given a code you were handed mints nothing and needs no login. The receiver never signs in.",
      },
      {
        q: "Which operating systems are supported?",
        a: "Prebuilt binaries are published for macOS, Linux and Windows on both x86-64 and arm64. The install script covers macOS and Linux; on Windows, download the .zip from the releases page.",
      },
      {
        q: "Do my files pass through Relayium's servers?",
        a: "No. In every mode the file bytes travel directly between the two ends. Only send / receive contacts our servers at all, and only for a small rendezvous handshake — never the file contents.",
      },
    ],
  },
  cta: {
    text: "Install the Relayium CLI and make your first transfer — completely free.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 从终端传输文件与文本",
  description:
    "安装免费、端到端加密的 Relayium CLI，通过 SSH、配对码或 daemon 直连传输文件，并在两台机器同时在线时发送临时文本。",
  updatedLabel: "最近更新",
  lead: [
    "Relayium CLI 是一个体积很小的单一二进制文件，用来从终端传输文件与临时文本——端到端加密、可自托管、完全免费。你可以把文件复制到服务器、在机器间推送构建产物、跨网络发送压缩包，也可以直接传 URL、命令或代码片段，无需先保存成文件。",
    "无论用哪种方式，文件字节都在两端之间直接传输，从不经过 Relayium 的服务器。本指南带你完成安装并走通第一次传输，然后指向每种模式更深入的操作指南。",
  ],
  sections: [
    {
      heading: "一条命令完成安装",
      body: [
        "在 macOS 或 Linux 上，一条命令就能下载适配你操作系统的预编译二进制，并放进你的 PATH：",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "想自己挑选文件？从发布页下载对应的二进制。",
        "已安装 Go？克隆仓库后运行：go build -o relayium ./cmd/relayium（在 server 目录下执行）。",
        "然后运行 relayium --help 查看全部命令，运行 relayium version 检查构建版本。",
      ],
    },
    {
      heading: "传输文件的三种方式",
      body: [
        "Relayium 提供三种传输方式。你按对方所在的位置来选，而不用去学三种不同的工具——它们共用同一个传输引擎，支持逐文件断点续传和 SHA-256 校验。",
      ],
      bullets: [
        "push / pull——传到一台你已能 SSH 进去的服务器。字节走你的 SSH 连接；无需 Relayium 账号。",
        "send / receive——跨网络传给另一个人，使用一个由发送方 CLI 生成的简短配对码（用 relayium login 登录一次即可；接收方无需登录）。直连点对点；如果找不到直连路径，传输会直接失败，而不会经我们中转。",
        "serve + push relayium://（daemon 直连）——直接在你拥有的两台服务器之间传输，通过证书固定的 TLS。无中继、无 SSH、无需配对码。",
      ],
    },
    {
      heading: "发送临时文本",
      body: [
        "在一台机器运行 relayium text 生成配对码并等待，然后在另一台机器用打印出的配对码加入：",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "生成配对码需要先执行 relayium login；持码加入无需登录。",
        "两台机器必须同时在线。消息端到端加密，通过 P2P 点对点直连传输且绝不存储；CLI text 不使用浏览器的 TURN 中继。",
        "单条消息最多 65,536 UTF-8 字节。更大的内容请使用 relayium send。",
      ],
    },
    {
      heading: "第一次传输",
      body: [
        "最快上手的方式是把一个文件夹复制到你能 SSH 进去的服务器。Relayium 使用你现有的 SSH 访问权限，远程无需任何配置，也不用创建账号：",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "如果远程也装了 relayium，push 就会使用原生协议（可续传、逐文件 SHA-256）。",
        "如果远程没装 relayium，push 会退化为普通的 tar 流，因此在裸机服务器上依然可用——这个兜底只属于 push。",
        "用这个命令把同样的文件取回来：relayium pull user@your-server:backups/ ./restore——pull 始终需要远程装有 relayium（没有 tar 兜底），请先在远程装好它。",
      ],
    },
    {
      heading: "免费，且从设计上保护隐私",
      body: [
        "没有任何费用。上面三种方式里，唯一需要登录的是 send / receive 模式下的发送方，好让 CLI 生成配对码（云端 up 也会用到你的账号，用来存文件）。CLI 直接连接两端，因此你的文件永远不会上传到中间的服务器——唯一会接触 Relayium 的，是 send / receive 模式下一次很小的会合握手，用来牵线搭桥，绝不是文件本身。",
        "每次传输都端到端加密，每个文件到达时都会用 SHA-256 哈希校验，中断的传输会从断点续传而不是从头再来。它可在 macOS、Linux 和 Windows 上运行，整个项目开源、可自托管。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "CLI 要收费吗？",
        a: "不收费。CLI 完全免费。它直接连接你的机器，从不代理你的文件字节经过 Relayium，因此没有什么可计量，也没有什么可付费。",
      },
      {
        q: "需要 Relayium 账号吗？",
        a: "send 需要，云端 up 也需要。push / pull 用你自己的 SSH，daemon 直连在你的服务器之间使用公钥信任，这两者都不需要账号。send 不一样：配对码只能由服务器签发，而且只签发给已登录的账号，所以发送方要先运行一次 relayium login——如果用的是别人给你的码，则不需要登录。接收方始终无需登录。",
      },
      {
        q: "支持哪些操作系统？",
        a: "macOS、Linux 和 Windows 上均提供预编译二进制，覆盖 x86-64 和 arm64。安装脚本适用于 macOS 和 Linux；在 Windows 上，请从发布页下载 .zip。",
      },
      {
        q: "我的文件会经过 Relayium 的服务器吗？",
        a: "不会。在每种模式下，文件字节都在两端之间直接传输。只有 send / receive 会联系到我们的服务器，而且只是为了一次很小的会合握手——从不涉及文件内容。",
      },
    ],
  },
  cta: {
    text: "安装 Relayium CLI，完成你的第一次传输——完全免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI でターミナルからファイルとテキストを転送する",
  description:
    "無料でエンドツーエンド暗号化された Relayium CLI で、SSH・ペアリングコード・デーモン直結によるファイル転送と、両方の端末がオンライン時の一時テキスト送信を始めましょう。",
  updatedLabel: "最終更新",
  lead: [
    "Relayium CLI はターミナルからファイルと一時テキストを転送する小さな単一バイナリです。エンドツーエンド暗号化、セルフホスト可能、完全無料。サーバーへのファイルコピーやマシン間のビルド送信に加え、URL・コマンド・コード片をファイル化せずそのまま送れます。",
    "どの方法を使っても、ファイルのバイトは両端の間を直接移動し、Relayium のサーバーを通過することはありません。本ガイドではインストールから最初の転送までを案内し、その後各モードのより詳しいハウツーへ案内します。",
  ],
  sections: [
    {
      heading: "1コマンドでインストール",
      body: [
        "macOS または Linux では、1つのコマンドでお使いの OS 向けのビルド済みバイナリをダウンロードし、PATH に配置できます：",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "自分でファイルを選びたい場合は、リリースページからバイナリをダウンロードしてください。",
        "Go がインストール済みなら、リポジトリを clone して次を実行します：go build -o relayium ./cmd/relayium（server ディレクトリから）。",
        "その後 relayium --help を実行するとすべてのコマンドを確認でき、relayium version でビルドを確認できます。",
      ],
    },
    {
      heading: "ファイルを移動する3つの方法",
      body: [
        "Relayium には3つの転送方法があります。3つの異なるツールを覚える必要はなく、相手先の場所に応じて選ぶだけです。いずれも同じ転送エンジンを共有し、ファイル単位の再開と SHA-256 検証を備えています。",
      ],
      bullets: [
        "push / pull：すでに SSH でログインできるサーバーへ。バイトは SSH 接続上を流れます。Relayium アカウントは不要です。",
        "send / receive：送信側の CLI が発行する短いペアリングコードを使って、ネットワークをまたいで他の人へ（relayium login で一度サインインするだけ。受信側は不要です）。直接の P2P です。直接経路が見つからない場合、転送は当社を経由する代わりに、そのまま失敗します。",
        "serve + push relayium://（デーモン直結）：自分が所有する2台のサーバー間で、証明書ピンニング付き TLS 上を直接。リレーなし、SSH なし、コードなし。",
      ],
    },
    {
      heading: "一時テキストを送る",
      body: [
        "一方で relayium text を実行してペアリングコードを発行し、もう一方は表示されたコードで参加します：",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "コードの発行には relayium login が必要ですが、コードでの参加にはログイン不要です。",
        "両方の端末がオンラインである必要があります。メッセージはエンドツーエンド暗号化された P2P 直結で流れ、保存されません。CLI text はブラウザの TURN リレーを使いません。",
        "1メッセージは最大 65,536 UTF-8 バイトです。それより大きい内容には relayium send を使ってください。",
      ],
    },
    {
      heading: "最初の転送",
      body: [
        "最も手早く試せるのは、SSH でログインできるサーバーへフォルダをコピーすることです。Relayium は既存の SSH アクセスを使うので、リモート側で設定することは何もなく、アカウント作成も不要です：",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "リモートにも relayium がインストールされていれば、push はネイティブプロトコル（再開可能、ファイル単位の SHA-256）を使います。",
        "リモートに relayium がなければ、push は単純な tar ストリームにフォールバックするため、relayium が入っていない素の状態のサーバーでも動作します。このフォールバックは push だけの機能です。",
        "同じファイルを次のコマンドで取り戻せます：relayium pull user@your-server:backups/ ./restore。pull は常にリモートの relayium を必要とし（tar フォールバックはありません）、先にリモートへインストールしておいてください。",
      ],
    },
    {
      heading: "無料、そして設計上プライベート",
      body: [
        "支払うものは何もありません。上記の3つの方法のうちサインインが要るのは send / receive モードの送信側だけで、CLI がペアリングコードを発行できるようにするためです（クラウドの up もファイルを保存するためにアカウントを使います）。CLI は両端を直接つなぐため、ファイルが中間のサーバーにアップロードされることは決してありません。Relayium が触れるのは、send / receive モードでの小さなランデブーハンドシェイクだけで、両端を引き合わせるために使われ、ファイル自体は決して含まれません。",
        "すべての転送はエンドツーエンドで暗号化され、すべてのファイルは到着時に SHA-256 ハッシュで検証され、中断した転送は最初からやり直すのではなく、止まった所から再開します。macOS、Linux、Windows で動作し、全体がオープンソースでセルフホスト可能です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "CLI に料金はかかりますか？",
        a: "いいえ。CLI は完全に無料です。マシン同士を直接つなぎ、ファイルのバイトを Relayium 経由でプロキシすることは決してないため、計測するものも支払うものもありません。",
      },
      {
        q: "Relayium アカウントは必要ですか？",
        a: "send と、クラウドの up で必要です。push / pull は自分の SSH を使い、デーモン直結はサーバー間の公開鍵による信頼を使うので、どちらもアカウントは不要です。send は違います。ペアリングコードを発行できるのはサーバーだけで、しかもサインイン済みのアカウントに対してだけなので、送信側は一度 relayium login を実行します。渡されたコードを使う send は発行を行わないので不要です。受信側がサインインすることはありません。",
      },
      {
        q: "どのオペレーティングシステムに対応していますか？",
        a: "macOS、Linux、Windows 向けに、x86-64 と arm64 の両方でビルド済みバイナリが公開されています。インストールスクリプトは macOS と Linux に対応しています。Windows では、リリースページから .zip をダウンロードしてください。",
      },
      {
        q: "自分のファイルは Relayium のサーバーを通過しますか？",
        a: "いいえ。どのモードでも、ファイルのバイトは両端の間を直接移動します。当社のサーバーに一切触れるのは send / receive だけで、それも小さなランデブーハンドシェイクのためだけです。ファイルの中身は決して含まれません。",
      },
    ],
  },
  cta: {
    text: "Relayium CLI をインストールして最初の転送をしましょう。完全無料です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 터미널에서 파일과 텍스트 전송하기",
  description:
    "무료 종단간 암호화 Relayium CLI로 SSH·페어링 코드·데몬 다이렉트 파일 전송과 두 기기가 함께 온라인일 때의 일회성 텍스트 전송을 시작하세요.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Relayium CLI는 터미널에서 파일과 일회성 텍스트를 옮기는 작은 단일 바이너리입니다 — 종단간 암호화, 자체 호스팅 가능, 완전 무료. 서버로 파일을 복사하거나 기기 사이에 빌드를 보내고, URL·명령·코드 조각을 파일로 저장하지 않고 그대로 전송할 수 있습니다.",
    "어떤 방식을 쓰든 파일 데이터는 두 끝 사이에서 직접 이동하며 Relayium 서버를 거치지 않습니다. 이 가이드는 설치와 첫 전송까지 안내한 뒤, 각 모드별로 더 깊은 방법을 다루는 글로 안내합니다.",
  ],
  sections: [
    {
      heading: "명령어 하나로 설치",
      body: [
        "macOS나 Linux에서는 명령어 하나로 사용 중인 OS용 사전 빌드된 바이너리를 내려받아 PATH에 등록할 수 있습니다:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "직접 파일을 고르고 싶나요? 릴리스 페이지에서 바이너리를 내려받으세요.",
        "Go가 설치되어 있나요? 저장소를 clone한 뒤 다음을 실행하세요: go build -o relayium ./cmd/relayium (server 디렉터리에서).",
        "이후 relayium --help로 모든 명령어를 확인하고, relayium version으로 빌드를 확인하세요.",
      ],
    },
    {
      heading: "파일을 옮기는 세 가지 방식",
      body: [
        "Relayium은 세 가지 방식으로 파일을 옮깁니다. 세 가지 다른 도구를 배울 필요 없이, 상대가 어디에 있는지에 따라 고르기만 하면 됩니다 — 모두 동일한 전송 엔진을 공유하며 파일별 재개와 SHA-256 검증을 갖추고 있습니다.",
      ],
      bullets: [
        "push / pull — 이미 SSH로 접속 가능한 서버로. 데이터는 SSH 연결을 통해 오가며, Relayium 계정이 필요 없습니다.",
        "send / receive — 보내는 쪽 CLI가 발급하는 짧은 페어링 코드를 사용해 네트워크를 넘어 다른 사람에게(relayium login으로 한 번만 로그인하면 되고, 받는 쪽은 로그인하지 않습니다). 직접 P2P 방식입니다. 직접 경로를 찾을 수 없으면 저희를 거쳐 우회하는 대신 전송이 그대로 실패합니다.",
        "serve + push relayium://(데몬 다이렉트) — 직접 소유한 두 서버 사이에서, 인증서 고정 TLS를 통해 곧바로. 중계도, SSH도, 코드도 필요 없습니다.",
      ],
    },
    {
      heading: "일회성 텍스트 보내기",
      body: [
        "한 기기에서 relayium text로 페어링 코드를 발급하고, 다른 기기에서 출력된 코드로 참여하세요:",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "코드 발급에는 relayium login이 필요하지만 코드로 참여할 때는 로그인하지 않습니다.",
        "두 기기가 함께 온라인이어야 합니다. 메시지는 종단간 암호화된 P2P 직결로 전송되고 저장되지 않습니다. CLI text는 브라우저 TURN 릴레이를 사용하지 않습니다.",
        "메시지 하나는 최대 65,536 UTF-8바이트입니다. 더 큰 내용은 relayium send를 사용하세요.",
      ],
    },
    {
      heading: "첫 전송",
      body: [
        "가장 빠르게 시도해 볼 수 있는 것은 SSH로 접속 가능한 서버로 폴더를 복사하는 것입니다. Relayium은 기존 SSH 접근 권한을 사용하므로 원격지에서 설정할 것이 없고 계정을 만들 필요도 없습니다:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "원격지에도 relayium이 설치되어 있으면 push는 네이티브 프로토콜(재개 가능, 파일별 SHA-256)을 사용합니다.",
        "원격지에 relayium이 없으면 push는 일반 tar 스트림으로 대체되므로, 아무것도 설치되지 않은 서버에서도 동작합니다 — 이 대체 방식은 push에서만 제공됩니다.",
        "다음 명령어로 같은 파일을 다시 가져올 수 있습니다: relayium pull user@your-server:backups/ ./restore — pull은 항상 원격지에 relayium이 있어야 하며(tar 대체 방식 없음), 먼저 원격지에 설치해 두세요.",
      ],
    },
    {
      heading: "무료이며, 설계상 프라이버시를 지킵니다",
      body: [
        "지불할 것은 없습니다. 위 세 가지 방식 중 로그인이 필요한 곳은 send / receive 모드의 보내는 쪽뿐이며, CLI가 페어링 코드를 발급할 수 있도록 하기 위해서입니다(클라우드 up도 파일을 저장하기 위해 계정을 사용합니다). CLI는 두 끝을 직접 연결하므로 파일이 중간의 서버에 업로드되는 일은 결코 없습니다. Relayium이 유일하게 관여하는 것은 send / receive 모드에서 두 끝을 소개하는 데 쓰이는 아주 작은 랑데부 핸드셰이크뿐입니다. 파일 자체는 절대 포함되지 않습니다.",
        "모든 전송은 종단간 암호화되고, 모든 파일은 도착 시 SHA-256 해시로 검증되며, 중단된 전송은 처음부터 다시 시작하는 대신 멈춘 지점에서 재개됩니다. macOS, Linux, Windows에서 동작하며, 전체가 오픈소스이고 자체 호스팅이 가능합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "CLI 사용에 비용이 드나요?",
        a: "아니요. CLI는 완전히 무료입니다. 기기를 직접 연결하며 파일 데이터를 Relayium을 거쳐 프록시하는 일이 결코 없으므로, 계량할 것도 지불할 것도 없습니다.",
      },
      {
        q: "Relayium 계정이 필요한가요?",
        a: "send할 때와 클라우드 up에 필요합니다. push / pull은 자신의 SSH를 사용하고 데몬 다이렉트는 서버 간 공개키 신뢰를 사용하므로 둘 다 계정이 필요 없습니다. send는 다릅니다. 페어링 코드는 서버만, 그것도 로그인된 계정에만 발급할 수 있으므로 보내는 쪽이 relayium login을 한 번 실행합니다. 건네받은 코드를 쓰는 send는 발급을 하지 않으므로 필요 없습니다. 받는 쪽은 절대 로그인하지 않습니다.",
      },
      {
        q: "어떤 운영체제를 지원하나요?",
        a: "macOS, Linux, Windows용으로 x86-64와 arm64 모두 사전 빌드된 바이너리가 제공됩니다. 설치 스크립트는 macOS와 Linux를 지원합니다. Windows에서는 릴리스 페이지에서 .zip을 내려받으세요.",
      },
      {
        q: "제 파일이 Relayium 서버를 거치나요?",
        a: "아니요. 어떤 모드에서든 파일 데이터는 두 끝 사이에서 직접 이동합니다. 저희 서버에 조금이라도 닿는 것은 send / receive뿐이며, 그마저도 작은 랑데부 핸드셰이크를 위한 것일 뿐 — 파일 내용은 절대 아닙니다.",
      },
    ],
  },
  cta: {
    text: "Relayium CLI를 설치하고 첫 전송을 해보세요 — 완전 무료입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien und Text mit der Relayium CLI vom Terminal übertragen",
  description:
    "Nutze die kostenlose, Ende-zu-Ende-verschlüsselte Relayium CLI für Dateien über SSH, Pairing-Code oder daemon-direct — und für flüchtigen Text, solange beide Rechner online sind.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Die Relayium CLI ist ein kleines einzelnes Binary für Dateien und flüchtigen Text im Terminal — Ende-zu-Ende-verschlüsselt, selbst hostbar und kostenlos. Kopiere Dateien auf Server, pushe Builds zwischen Maschinen oder sende URLs, Befehle und Codeausschnitte, ohne sie erst als Datei zu speichern.",
    "Egal welchen Weg du nutzt, die Dateibytes wandern direkt zwischen den beiden Enden und laufen nie über Relayiums Server. Diese Anleitung bringt dich zur Installation und durch deine erste Übertragung und verweist dich dann auf die ausführlicheren Anleitungen zu jedem Modus.",
  ],
  sections: [
    {
      heading: "Installation mit einem Befehl",
      body: [
        "Unter macOS oder Linux lädt ein Befehl ein vorkompiliertes Binary für dein Betriebssystem herunter und legt es in deinen PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Möchtest du die Datei lieber selbst auswählen? Lade ein Binary von der Releases-Seite herunter.",
        "Go installiert? Clone das Repository und führe go build -o relayium ./cmd/relayium im server-Verzeichnis aus.",
        "Führe dann relayium --help aus, um alle Befehle zu sehen, und relayium version, um den Build zu prüfen.",
      ],
    },
    {
      heading: "Die drei Wege, Dateien zu bewegen",
      body: [
        "Relayium bewegt Dateien auf drei Arten. Du wählst danach, wo sich die Gegenstelle befindet, nicht indem du drei verschiedene Werkzeuge lernst — sie teilen sich eine Übertragungs-Engine mit dateiweise fortsetzbarer Übertragung und SHA-256-Prüfung.",
      ],
      bullets: [
        "push / pull — zu einem Server, in den du dich bereits per SSH einloggen kannst. Die Bytes laufen über deine SSH-Verbindung; kein Relayium-Konto nötig.",
        "send / receive — an eine andere Person netzwerkübergreifend, mit einem kurzen Pairing-Code, den die CLI des Absenders erzeugt (einmalig mit relayium login anmelden; der Empfänger nie). Direktes Peer-to-Peer; findet sich kein direkter Weg, schlägt die Übertragung fehl, statt über uns umgeleitet zu werden.",
        "serve + push relayium:// (daemon-direct) — direkt zwischen zwei Servern, die dir gehören, über TLS mit Pinning. Kein Relay, kein SSH, kein Code.",
      ],
    },
    {
      heading: "Flüchtigen Text senden",
      body: [
        "Führe auf einem Rechner relayium text aus, um einen Pairing-Code zu erzeugen; der andere tritt mit dem ausgegebenen Code bei:",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "Das Erzeugen des Codes braucht relayium login; der Beitritt mit einem Code braucht keine Anmeldung.",
        "Beide Rechner müssen online bleiben. Nachrichten laufen Ende-zu-Ende-verschlüsselt über eine direkte P2P-Verbindung und werden nie gespeichert. CLI text nutzt das Browser-TURN-Relay nicht.",
        "Eine Nachricht umfasst höchstens 65.536 UTF-8-Bytes. Für größere Inhalte nutze relayium send.",
      ],
    },
    {
      heading: "Deine erste Übertragung",
      body: [
        "Am schnellsten lässt sich ausprobieren, einen Ordner auf einen Server zu kopieren, in den du dich per SSH einloggen kannst. Relayium nutzt deinen bestehenden SSH-Zugang, es gibt also nichts auf der Gegenseite zu konfigurieren und kein Konto anzulegen:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "Ist relayium auch auf der Gegenseite installiert, nutzt push das native Protokoll (fortsetzbar, dateiweises SHA-256).",
        "Ist relayium dort nicht installiert, fällt push auf einen einfachen tar-Stream zurück, sodass es auch auf einem nackten Server funktioniert — dieser Fallback existiert nur bei push.",
        "Hole dieselben Dateien mit folgendem Befehl zurück: relayium pull user@your-server:backups/ ./restore — pull braucht immer relayium auf der Gegenseite (keinen tar-Fallback), installiere es dort also zuerst.",
      ],
    },
    {
      heading: "Kostenlos und von Grund auf privat",
      body: [
        "Es gibt nichts zu bezahlen. Von den drei Wegen oben erfordert nur der Absender im send-/receive-Modus eine Anmeldung, damit dessen CLI einen Pairing-Code erzeugen kann (auch Cloud-up nutzt dein Konto, um die Datei zu speichern). Die CLI verbindet die beiden Enden direkt, sodass deine Dateien nie auf einen Server dazwischen hochgeladen werden — das Einzige, was Relayium jemals berührt, ist ein winziger Rendezvous-Handshake im send-/receive-Modus, der die beiden Enden einander vorstellt, niemals die Datei selbst.",
        "Jede Übertragung ist Ende-zu-Ende verschlüsselt, jede Datei wird bei Ankunft mit einem SHA-256-Hash geprüft, und eine unterbrochene Übertragung wird dort fortgesetzt, wo sie aufgehört hat, statt von vorn zu beginnen. Sie läuft unter macOS, Linux und Windows, und das Ganze ist Open Source und selbst hostbar.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kostet die CLI etwas?",
        a: "Nein. Die CLI ist völlig kostenlos. Sie verbindet deine Maschinen direkt und leitet deine Dateibytes nie über Relayium um, also gibt es nichts zu messen und nichts zu bezahlen.",
      },
      {
        q: "Brauche ich ein Relayium-Konto?",
        a: "Zum Senden und für Cloud-up. push / pull nutzt dein eigenes SSH und daemon-direct nutzt Public-Key-Vertrauen zwischen deinen Servern, beide brauchen also kein Konto. send ist anders: Einen Pairing-Code kann nur der Server erzeugen, und nur für ein angemeldetes Konto, also führt der Absender einmal relayium login aus — mit einem übergebenen Code entfällt das. Der Empfänger meldet sich nie an.",
      },
      {
        q: "Welche Betriebssysteme werden unterstützt?",
        a: "Vorkompilierte Binaries werden für macOS, Linux und Windows veröffentlicht, jeweils für x86-64 und arm64. Das Installationsskript deckt macOS und Linux ab; unter Windows lädst du die .zip von der Releases-Seite herunter.",
      },
      {
        q: "Laufen meine Dateien über Relayiums Server?",
        a: "Nein. In jedem Modus wandern die Dateibytes direkt zwischen den beiden Enden. Nur send / receive kontaktiert unsere Server überhaupt, und auch nur für einen kleinen Rendezvous-Handshake — nie für den Dateiinhalt.",
      },
    ],
  },
  cta: {
    text: "Installiere die Relayium CLI und mach deine erste Übertragung — völlig kostenlos.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer fichiers et texte depuis le terminal avec la CLI Relayium",
  description:
    "Utilisez la CLI Relayium gratuite et chiffrée de bout en bout pour les fichiers via SSH, code d'appairage ou daemon-direct — et le texte éphémère quand les deux machines sont en ligne.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "La CLI Relayium est un petit binaire unique pour transférer fichiers et texte éphémère depuis le terminal — chiffré de bout en bout, auto-hébergeable et gratuit. Copiez des fichiers vers un serveur, poussez un build, ou envoyez URL, commandes et code sans les enregistrer d'abord dans un fichier.",
    "Quelle que soit la méthode utilisée, les octets du fichier voyagent directement entre les deux extrémités et ne passent jamais par les serveurs de Relayium. Ce guide vous installe et vous fait passer votre premier transfert, puis vous oriente vers les guides plus détaillés pour chaque mode.",
  ],
  sections: [
    {
      heading: "Installation en une commande",
      body: [
        "Sous macOS ou Linux, une commande télécharge un binaire précompilé pour votre OS et l'ajoute à votre PATH :",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Vous préférez choisir le fichier vous-même ? Téléchargez un binaire depuis la page des releases.",
        "Go est installé ? Clonez le dépôt et lancez : go build -o relayium ./cmd/relayium (depuis le répertoire server).",
        "Lancez ensuite relayium --help pour voir toutes les commandes, et relayium version pour vérifier le build.",
      ],
    },
    {
      heading: "Les trois façons de déplacer des fichiers",
      body: [
        "Relayium déplace les fichiers de trois façons. Vous choisissez selon où se trouve l'autre bout, sans avoir à apprendre trois outils différents — ils partagent un seul moteur de transfert avec reprise par fichier et vérification SHA-256.",
      ],
      bullets: [
        "push / pull — vers un serveur où vous pouvez déjà vous connecter en SSH. Les octets transitent par votre connexion SSH ; aucun compte Relayium requis.",
        "send / receive — vers une autre personne entre réseaux différents, avec un court code d'appairage que la CLI de l'expéditeur génère (connectez-vous une fois avec relayium login ; le destinataire, jamais). Pair-à-pair direct ; si aucun chemin direct n'est trouvé, le transfert échoue plutôt que d'être routé via nos serveurs.",
        "serve + push relayium:// (daemon-direct) — directement entre deux serveurs qui vous appartiennent, via TLS avec épinglage. Pas de relais, pas de SSH, pas de code.",
      ],
    },
    {
      heading: "Envoyer du texte éphémère",
      body: [
        "Lancez relayium text sur une machine pour créer un code d'appairage, puis rejoignez depuis l'autre avec le code affiché :",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "Créer le code nécessite relayium login ; le rejoindre ne nécessite aucune connexion.",
        "Les deux machines doivent rester en ligne. Les messages sont chiffrés de bout en bout, passent par une connexion P2P directe et ne sont jamais stockés. CLI text n'utilise pas le relais TURN du navigateur.",
        "Un message fait au plus 65 536 octets UTF-8. Utilisez relayium send pour un contenu plus grand.",
      ],
    },
    {
      heading: "Votre premier transfert",
      body: [
        "Le plus rapide à essayer est de copier un dossier vers un serveur où vous pouvez vous connecter en SSH. Relayium utilise votre accès SSH existant, il n'y a donc rien à configurer côté distant et aucun compte à créer :",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "Si relayium est aussi installé sur la machine distante, push utilise le protocole natif (avec reprise, SHA-256 par fichier).",
        "Sinon, push bascule sur un simple flux tar, ce qui fonctionne donc même sur un serveur nu — ce repli n'existe que pour push.",
        "Récupérez les mêmes fichiers avec : relayium pull user@your-server:backups/ ./restore — pull a toujours besoin de relayium sur la machine distante (aucun repli tar), installez-le donc là-bas au préalable.",
      ],
    },
    {
      heading: "Gratuit, et privé par conception",
      body: [
        "Il n'y a rien à payer. Parmi les trois méthodes ci-dessus, la seule connexion est celle de l'expéditeur en mode send / receive, pour que sa CLI puisse générer un code d'appairage (le up cloud utilise aussi votre compte, pour stocker le fichier). La CLI connecte les deux extrémités directement, si bien que vos fichiers ne sont jamais téléversés vers un serveur intermédiaire — la seule chose que Relayium touche jamais est une petite poignée de main de rendez-vous en mode send / receive, utilisée pour présenter les deux extrémités l'une à l'autre, jamais le fichier lui-même.",
        "Chaque transfert est chiffré de bout en bout, chaque fichier est vérifié par une empreinte SHA-256 à l'arrivée, et un transfert interrompu reprend là où il s'était arrêté au lieu de recommencer depuis le début. Cela fonctionne sous macOS, Linux et Windows, et l'ensemble est open source et auto-hébergeable.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La CLI coûte-t-elle quelque chose ?",
        a: "Non. La CLI est entièrement gratuite. Elle connecte vos machines directement et ne fait jamais transiter les octets de vos fichiers par Relayium, donc il n'y a rien à mesurer ni à payer.",
      },
      {
        q: "Ai-je besoin d'un compte Relayium ?",
        a: "Pour send et pour le up cloud. push / pull utilise votre propre SSH et daemon-direct utilise une confiance par clé publique entre vos serveurs, donc ni l'un ni l'autre ne nécessite de compte. send est différent : seul le serveur peut générer un code d'appairage, et seulement pour un compte connecté, donc l'expéditeur lance une fois relayium login — inutile si on lui passe un code déjà émis. Le destinataire ne se connecte jamais.",
      },
      {
        q: "Quels systèmes d'exploitation sont pris en charge ?",
        a: "Des binaires précompilés sont publiés pour macOS, Linux et Windows, en x86-64 comme en arm64. Le script d'installation couvre macOS et Linux ; sous Windows, téléchargez le .zip depuis la page des releases.",
      },
      {
        q: "Mes fichiers passent-ils par les serveurs de Relayium ?",
        a: "Non. Dans tous les modes, les octets du fichier voyagent directement entre les deux extrémités. Seul send / receive contacte nos serveurs, et seulement pour une petite poignée de main de rendez-vous — jamais pour le contenu du fichier.",
      },
    ],
  },
  cta: {
    text: "Installez la CLI Relayium et effectuez votre premier transfert — entièrement gratuit.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "انقل الملفات والنصوص من الطرفية باستخدام Relayium CLI",
  description:
    "استخدم Relayium CLI المجاني والمشفّر من الطرف إلى الطرف لنقل الملفات عبر SSH أو رمز اقتران أو daemon direct، ولإرسال نص مؤقت حين يكون الجهازان متصلين.",
  updatedLabel: "آخر تحديث",
  lead: [
    "‏Relayium CLI ملف ثنائي صغير لنقل الملفات والنص المؤقت من الطرفية — مشفّر من الطرف إلى الطرف، قابل للاستضافة الذاتية، ومجاني. انسخ الملفات إلى خادم، أو انقل نسخة بناء، أو أرسل رابطًا أو أمرًا أو مقطع كود دون حفظه أولًا كملف.",
    "أيًا كانت الطريقة التي تستخدمها بها، تنتقل بايتات الملف مباشرة بين الطرفين ولا تمر أبدًا عبر خوادم Relayium. يوصلك هذا الدليل إلى التثبيت وإتمام أول عملية نقل لك، ثم يوجّهك إلى الأدلة الأعمق لكل وضع.",
  ],
  sections: [
    {
      heading: "التثبيت بأمر واحد",
      body: [
        "على macOS أو Linux، يُنزّل أمر واحد ملفًا ثنائيًا مُسبق البناء لنظام تشغيلك ويضعه في PATH لديك:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "تفضّل اختيار الملف بنفسك؟ نزّل ملفًا ثنائيًا من صفحة الإصدارات.",
        "لديك Go مثبّت؟ استنسخ المستودع ونفّذ: go build -o relayium ./cmd/relayium (من مجلد server).",
        "ثم نفّذ relayium --help لرؤية كل أمر، وrelayium version للتحقق من نسخة البناء.",
      ],
    },
    {
      heading: "الطرق الثلاث التي ينقل بها الملفات",
      body: [
        "‏Relayium ينقل الملفات بثلاث طرق. تختار حسب موقع الطرف الآخر، لا بتعلّم ثلاث أدوات مختلفة — فجميعها تتشارك محرك نقل واحدًا مع استئناف لكل ملف وتحقق SHA-256.",
      ],
      bullets: [
        "‏push / pull — إلى خادم يمكنك بالفعل الدخول إليه عبر SSH. تنتقل البايتات عبر اتصال SSH لديك؛ بدون حساب Relayium.",
        "‏send / receive — إلى شخص آخر عبر الشبكات، باستخدام رمز اقتران قصير تُصدره واجهة CLI لدى المُرسِل (سجِّل الدخول مرة واحدة عبر relayium login؛ أما المُستقبِل فلا يسجّل الدخول أبدًا). من الند للند مباشرة؛ إذا تعذّر إيجاد مسار مباشر يفشل النقل بدل توجيهه عبرنا.",
        "‏serve + push relayium:// (daemon direct) — مباشرة بين خادمين تملكهما، عبر TLS مثبَّت. بدون مُرحِّل، بدون SSH، بدون رمز.",
      ],
    },
    {
      heading: "إرسال نص مؤقت",
      body: [
        "شغّل relayium text على جهاز لإصدار رمز اقتران، ثم انضم من الجهاز الآخر بالرمز المطبوع:",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "يتطلب إصدار الرمز relayium login؛ أما الانضمام بالرمز فلا يحتاج إلى تسجيل دخول.",
        "يجب أن يبقى الجهازان متصلين. الرسائل مشفّرة من الطرف إلى الطرف، تمر باتصال P2P مباشر، ولا تُخزَّن أبدًا. لا يستخدم CLI text مُرحِّل TURN الخاص بالمتصفح.",
        "الرسالة الواحدة 65,536 بايت UTF-8 كحد أقصى. استخدم relayium send للمحتوى الأكبر.",
      ],
    },
    {
      heading: "أول عملية نقل لك",
      body: [
        "أسرع شيء يمكنك تجربته هو نسخ مجلد إلى خادم يمكنك الدخول إليه عبر SSH. يستخدم Relayium وصول SSH الموجود لديك، فلا شيء لتهيئته على الطرف البعيد ولا حساب لإنشائه:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "إذا كان relayium مثبّتًا على الطرف البعيد أيضًا، يستخدم push البروتوكول الأصلي (قابل للاستئناف، SHA-256 لكل ملف).",
        "يتراجع push إلى بث tar بسيط عندما لا يكون relayium على الطرف البعيد، فيعمل حتى مع خادم عارٍ — وهذا التراجع خاص بـ push وحده.",
        "استرجع الملفات نفسها بـ: relayium pull user@your-server:backups/ ./restore — يحتاج pull دائمًا إلى relayium على الطرف البعيد (لا يملك تراجع tar)، فثبّته هناك أولًا.",
      ],
    },
    {
      heading: "مجاني، وخاص بحكم التصميم",
      body: [
        "لا شيء تدفعه. ومن بين الطرق الثلاث أعلاه، تسجيل الدخول الوحيد هو تسجيل المُرسِل في وضع send / receive، كي تتمكن واجهة CLI لديه من إصدار رمز اقتران (كما يستخدم up السحابي حسابك أيضًا، لتخزين الملف). يصل CLI بين الطرفين مباشرة، فلا تُرفع ملفاتك أبدًا إلى خادم في الوسط — الشيء الوحيد الذي يلمس Relayium على الإطلاق هو مصافحة تعارف صغيرة جدًا في وضع send / receive، تُستخدم للتعريف بين الطرفين، وليست الملف نفسه أبدًا.",
        "كل عملية نقل مشفّرة من الطرف إلى الطرف، وكل ملف يُتحقق منه بتجزئة SHA-256 عند الوصول، والنقل المنقطع يُستأنف من حيث توقّف بدل البدء من جديد. يعمل على macOS وLinux وWindows، والمشروع كله مفتوح المصدر وقابل للاستضافة الذاتية.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يكلّف CLI أي شيء؟",
        a: "لا. إن CLI مجاني تمامًا. يصل بين أجهزتك مباشرة ولا يمرّر بايتات ملفاتك عبر Relayium أبدًا، فلا شيء لقياسه ولا شيء لدفعه.",
      },
      {
        q: "هل أحتاج إلى حساب Relayium؟",
        a: "للإرسال ولـ up السحابي. يستخدم push / pull الـ SSH لديك، ويستخدم daemon direct الثقة بالمفتاح العام بين خوادمك، فلا يتطلب أيٌّ منهما حسابًا. أما send فمختلف: لا يستطيع إصدار رمز الاقتران إلا الخادم، ولحساب مسجَّل الدخول فقط، لذا يشغّل المُرسِل relayium login مرة واحدة — ولا يلزم ذلك إن مرّرت له رمزًا جاهزًا. والمُستقبِل لا يسجّل الدخول أبدًا.",
      },
      {
        q: "ما أنظمة التشغيل المدعومة؟",
        a: "تُنشر ملفات ثنائية مُسبقة البناء لـ macOS وLinux وWindows على معماريتَي x86-64 وarm64. يغطي سكربت التثبيت macOS وLinux؛ على Windows، نزّل ملف .zip من صفحة الإصدارات.",
      },
      {
        q: "هل تمر ملفاتي عبر خوادم Relayium؟",
        a: "لا. في كل وضع، تنتقل بايتات الملف مباشرة بين الطرفين. وحده send / receive يتصل بخوادمنا أصلًا، ولمصافحة تعارف صغيرة فقط — وليس محتوى الملف أبدًا.",
      },
    ],
  },
  cta: {
    text: "ثبّت Relayium CLI ونفّذ أول عملية نقل لك — مجاني تمامًا.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Transfiere archivos y texto desde la terminal con la CLI de Relayium",
  description:
    "Usa la CLI de Relayium, gratis y cifrada de extremo a extremo, para archivos por SSH, código de emparejamiento o daemon directo, y texto efímero mientras ambas máquinas están conectadas.",
  updatedLabel: "Última actualización",
  lead: [
    "La CLI de Relayium es un pequeño binario para transferir archivos y texto efímero desde la terminal — cifrado de extremo a extremo, autoalojable y gratis. Copia archivos a un servidor, envía una compilación o pasa URL, comandos y código sin guardarlos antes como archivo.",
    "Sea cual sea la forma en que la uses, los bytes de los archivos viajan directamente entre los dos extremos y nunca pasan por los servidores de Relayium. Esta guía te deja instalado y con tu primera transferencia hecha, y luego te dirige a los tutoriales más detallados de cada modo.",
  ],
  sections: [
    {
      heading: "Instala con un solo comando",
      body: [
        "En macOS o Linux, un comando descarga un binario precompilado para tu sistema operativo y lo coloca en tu PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "¿Prefieres elegir el archivo tú mismo? Descarga un binario desde la página de releases.",
        "¿Tienes Go instalado? Clona el repositorio y ejecuta: go build -o relayium ./cmd/relayium (desde el directorio server).",
        "Luego ejecuta relayium --help para ver todos los comandos, y relayium version para comprobar la compilación.",
      ],
    },
    {
      heading: "Las tres formas en que mueve archivos",
      body: [
        "Relayium mueve archivos de tres maneras. Eliges según dónde esté el otro extremo, no aprendiendo tres herramientas distintas — todas comparten un mismo motor de transferencia con reanudación por archivo y verificación SHA-256.",
      ],
      bullets: [
        "push / pull — a un servidor al que ya puedes entrar por SSH. Los bytes viajan por tu conexión SSH; sin cuenta de Relayium.",
        "send / receive — a otra persona entre redes, usando un código de emparejamiento corto que genera la CLI de quien envía (inicia sesión una vez con relayium login; quien recibe, nunca). De igual a igual directo; si no se encuentra una ruta directa, la transferencia falla en lugar de enrutarse a través de nosotros.",
        "serve + push relayium:// (daemon directo) — directamente entre dos servidores que posees, sobre TLS con anclaje. Sin retransmisor, sin SSH, sin código.",
      ],
    },
    {
      heading: "Enviar texto efímero",
      body: [
        "Ejecuta relayium text en una máquina para generar un código de emparejamiento y únete desde la otra con el código impreso:",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "Generar el código requiere relayium login; unirse con un código no requiere iniciar sesión.",
        "Ambas máquinas deben seguir conectadas. Los mensajes están cifrados de extremo a extremo, viajan por una conexión P2P directa y nunca se almacenan. CLI text no usa el retransmisor TURN del navegador.",
        "Cada mensaje admite hasta 65.536 bytes UTF-8. Usa relayium send para contenido mayor.",
      ],
    },
    {
      heading: "Tu primera transferencia",
      body: [
        "Lo más rápido para probar es copiar una carpeta a un servidor al que puedas entrar por SSH. Relayium usa tu acceso SSH existente, así que no hay nada que configurar en el remoto ni cuenta que crear:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "Si relayium también está instalado en el remoto, push usa el protocolo nativo (reanudable, SHA-256 por archivo).",
        "push recurre a un simple flujo tar cuando relayium no está en el remoto, así que funciona incluso contra un servidor sin nada instalado — esa alternativa es solo para push.",
        "Recupera los mismos archivos con: relayium pull user@your-server:backups/ ./restore — pull siempre necesita relayium en el remoto (no tiene alternativa con tar), así que instálalo allí primero.",
      ],
    },
    {
      heading: "Gratis, y privado por diseño",
      body: [
        "No hay nada que pagar. De las tres formas de arriba, el único inicio de sesión es el de quien envía en modo send / receive, para que su CLI pueda generar un código de emparejamiento (el up en la nube también usa tu cuenta, para guardar el archivo). La CLI conecta los dos extremos directamente, así que tus archivos nunca se suben a un servidor intermedio — lo único que toca a Relayium en algún momento es un diminuto handshake con el punto de encuentro en el modo send / receive, usado para presentar a los dos extremos, nunca el archivo en sí.",
        "Cada transferencia está cifrada de extremo a extremo, cada archivo se verifica con un hash SHA-256 al llegar, y una transferencia interrumpida se reanuda desde donde se detuvo en lugar de empezar de nuevo. Funciona en macOS, Linux y Windows, y todo el proyecto es de código abierto y autoalojable.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿La CLI cuesta algo?",
        a: "No. La CLI es completamente gratis. Conecta tus máquinas directamente y nunca hace de intermediario para los bytes de tus archivos a través de Relayium, así que no hay nada que medir ni nada que pagar.",
      },
      {
        q: "¿Necesito una cuenta de Relayium?",
        a: "Para enviar y para el up en la nube. push / pull usa tu propio SSH y daemon directo usa confianza por clave pública entre tus servidores, así que ninguno requiere cuenta. send es distinto: solo el servidor puede generar un código de emparejamiento, y solo para una cuenta con sesión iniciada, así que quien envía ejecuta relayium login una vez; no hace falta si le pasas un código ya emitido. Quien recibe no inicia sesión nunca.",
      },
      {
        q: "¿Qué sistemas operativos son compatibles?",
        a: "Se publican binarios precompilados para macOS, Linux y Windows, tanto en x86-64 como en arm64. El script de instalación cubre macOS y Linux; en Windows, descarga el .zip desde la página de releases.",
      },
      {
        q: "¿Mis archivos pasan por los servidores de Relayium?",
        a: "No. En todos los modos, los bytes de los archivos viajan directamente entre los dos extremos. Solo send / receive contacta con nuestros servidores, y únicamente para un pequeño handshake con el punto de encuentro — nunca el contenido del archivo.",
      },
    ],
  },
  cta: {
    text: "Instala la CLI de Relayium y haz tu primera transferencia — completamente gratis.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Transfira arquivos e texto pelo terminal com a CLI do Relayium",
  description:
    "Use a CLI do Relayium, gratuita e com criptografia de ponta a ponta, para arquivos por SSH, código de emparelhamento ou daemon direto, e texto efêmero enquanto as duas máquinas estão online.",
  updatedLabel: "Última atualização",
  lead: [
    "A CLI do Relayium é um pequeno binário para transferir arquivos e texto efêmero pelo terminal — com criptografia de ponta a ponta, auto-hospedável e gratuito. Copie arquivos para um servidor, envie um build ou passe URLs, comandos e código sem salvar primeiro como arquivo.",
    "Seja qual for a forma que você usar, os bytes dos arquivos trafegam diretamente entre as duas pontas e nunca passam pelos servidores do Relayium. Este guia deixa você instalado e com a sua primeira transferência feita, e depois aponta para os tutoriais mais aprofundados de cada modo.",
  ],
  sections: [
    {
      heading: "Instale com um único comando",
      body: [
        "No macOS ou no Linux, um comando baixa um binário pré-compilado para o seu sistema operacional e o coloca no seu PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Prefere escolher o arquivo você mesmo? Baixe um binário na página de releases.",
        "Tem o Go instalado? Clone o repositório e execute: go build -o relayium ./cmd/relayium (a partir do diretório server).",
        "Depois execute relayium --help para ver todos os comandos, e relayium version para conferir o build.",
      ],
    },
    {
      heading: "As três formas de mover arquivos",
      body: [
        "O Relayium move arquivos de três formas. Você escolhe pela localização da outra ponta, não aprendendo três ferramentas diferentes — todas compartilham um único motor de transferência com retomada por arquivo e verificação SHA-256.",
      ],
      bullets: [
        "push / pull — para um servidor no qual você já consegue entrar por SSH. Os bytes trafegam pela sua conexão SSH; sem conta do Relayium.",
        "send / receive — para outra pessoa entre redes, usando um código de emparelhamento curto que a CLI de quem envia gera (faça login uma vez com relayium login; quem recebe, nunca). Ponto a ponto direto; se nenhum caminho direto for encontrado, a transferência falha em vez de ser roteada por nós.",
        "serve + push relayium:// (daemon direto) — direto entre dois servidores que você possui, sobre TLS com fixação. Sem retransmissor, sem SSH, sem código.",
      ],
    },
    {
      heading: "Enviar texto efêmero",
      body: [
        "Execute relayium text em uma máquina para gerar um código de emparelhamento e entre na outra com o código exibido:",
      ],
      code: ["relayium text", "relayium text K7M4XR"],
      bullets: [
        "Gerar o código requer relayium login; entrar com um código não requer login.",
        "As duas máquinas precisam ficar online. As mensagens têm criptografia de ponta a ponta, trafegam por uma conexão P2P direta e nunca são armazenadas. CLI text não usa o retransmissor TURN do navegador.",
        "Cada mensagem pode ter até 65.536 bytes UTF-8. Use relayium send para conteúdo maior.",
      ],
    },
    {
      heading: "Sua primeira transferência",
      body: [
        "O mais rápido para experimentar é copiar uma pasta para um servidor no qual você consiga entrar por SSH. O Relayium usa o seu acesso SSH existente, então não há nada a configurar no remoto e nenhuma conta a criar:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "Se o relayium também estiver instalado no remoto, o push usa o protocolo nativo (retomável, SHA-256 por arquivo).",
        "O push recorre a um simples fluxo tar quando o relayium não está no remoto, então funciona até contra um servidor sem nada instalado — essa alternativa é só do push.",
        "Traga os mesmos arquivos de volta com: relayium pull user@your-server:backups/ ./restore — o pull sempre precisa do relayium no remoto (ele não tem alternativa com tar), então instale-o lá primeiro.",
      ],
    },
    {
      heading: "Gratuito, e privado por decisão de projeto",
      body: [
        "Não há nada a pagar. Das três formas acima, o único login é o de quem envia no modo send / receive, para que a CLI dele possa gerar um código de emparelhamento (o up na nuvem também usa a sua conta, para guardar o arquivo). A CLI conecta as duas pontas diretamente, então seus arquivos nunca são enviados para um servidor no meio — a única coisa que toca o Relayium em algum momento é um minúsculo handshake de encontro no modo send / receive, usado para apresentar as duas pontas uma à outra, nunca o arquivo em si.",
        "Cada transferência é criptografada de ponta a ponta, cada arquivo é verificado com um hash SHA-256 na chegada, e uma transferência interrompida é retomada de onde parou em vez de começar do zero. Ela roda no macOS, no Linux e no Windows, e o projeto inteiro é de código aberto e auto-hospedável.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "A CLI custa alguma coisa?",
        a: "Não. A CLI é totalmente gratuita. Ela conecta suas máquinas diretamente e nunca faz proxy dos bytes dos seus arquivos pelo Relayium, então não há nada a medir nem nada a pagar.",
      },
      {
        q: "Preciso de uma conta do Relayium?",
        a: "Para enviar e para o up na nuvem. O push / pull usa o seu próprio SSH e o daemon direto usa confiança por chave pública entre os seus servidores, então nenhum dos dois exige conta. O send é diferente: só o servidor pode gerar um código de emparelhamento, e apenas para uma conta logada, então quem envia roda relayium login uma vez; não é preciso se você passar um código já emitido. Quem recebe nunca faz login.",
      },
      {
        q: "Quais sistemas operacionais são compatíveis?",
        a: "Binários pré-compilados são publicados para macOS, Linux e Windows, tanto em x86-64 quanto em arm64. O script de instalação cobre macOS e Linux; no Windows, baixe o .zip na página de releases.",
      },
      {
        q: "Meus arquivos passam pelos servidores do Relayium?",
        a: "Não. Em todos os modos, os bytes dos arquivos trafegam diretamente entre as duas pontas. Só o send / receive contata os nossos servidores, e apenas para um pequeno handshake de encontro — nunca o conteúdo do arquivo.",
      },
    ],
  },
  cta: {
    text: "Instale a CLI do Relayium e faça a sua primeira transferência — totalmente gratuita.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/transfer-files-from-terminal",
  published: "2026-07-08",
  updated: "2026-07-30",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
