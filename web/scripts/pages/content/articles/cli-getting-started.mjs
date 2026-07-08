// web/scripts/pages/content/articles/cli-getting-started.mjs
// Getting started with the Relayium CLI. English is the master; zh/ja/ko/de/fr
// follow the same structure with identical facts. Command blocks (code) stay
// English in every language.

const en = {
  title: "Transfer files from the terminal with the Relayium CLI",
  description:
    "Install the free, end-to-end-encrypted Relayium CLI and move files three ways from your terminal — over your own SSH, by a pairing code across networks, or straight between two servers. No account, and file bytes never pass through our servers.",
  updatedLabel: "Last updated",
  lead: [
    "The Relayium CLI is a single small binary that moves files from your terminal — encrypted end to end, self-hostable, and completely free. It exists for the case a browser handles badly: copying files to a server you already run, pushing a build between two machines, or sending an archive to a colleague across networks without uploading it to anyone's cloud.",
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
        "send / receive — to another person across networks, using a short pairing code. Direct peer-to-peer; if a direct path can't be found the transfer fails rather than routing through us.",
        "serve + push relayium:// (daemon direct) — straight between two servers you own, over pinned TLS. No relay, no SSH, no code.",
      ],
    },
    {
      heading: "Your first transfer",
      body: [
        "The quickest thing to try is copying a folder to a server you can SSH into. Relayium uses your existing SSH access, so there is nothing to configure on the remote and no account to create:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "If relayium is installed on the remote too, it uses the native protocol (resumable, per-file SHA-256).",
        "If not, it falls back to a plain tar stream, so it still works on a bare server.",
        "Pull the same files back with: relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Free, and private by design",
      body: [
        "There is nothing to pay and no account to keep. The CLI connects the two ends directly, so your files are never uploaded to a server in the middle — the only thing that ever touches Relayium is a tiny rendezvous handshake in send / receive mode, used to introduce the two ends, never the file itself.",
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
        a: "No. push / pull uses your own SSH, daemon direct uses public-key trust between your servers, and send / receive uses a code you agree on out of band. None of them require an account.",
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
    text: "Install the Relayium CLI and make your first transfer — completely free, and no account.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 从终端传输文件",
  description:
    "安装免费、端到端加密的 Relayium CLI，从终端以三种方式传输文件——通过你自己的 SSH、跨网络使用配对码，或直接在两台服务器之间传输。无需账号，文件字节从不经过我们的服务器。",
  updatedLabel: "最近更新",
  lead: [
    "Relayium CLI 是一个体积很小的单一二进制文件，用来从终端传输文件——端到端加密、可自托管、完全免费。它解决的正是浏览器难以胜任的场景：把文件复制到你已经在运行的服务器、在两台机器之间推送一次构建产物，或者跨网络把一个压缩包发给同事而不上传到任何人的网盘。",
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
        "send / receive——跨网络传给另一个人，使用一个简短的配对码。直连点对点；如果找不到直连路径，传输会直接失败，而不会经我们中转。",
        "serve + push relayium://（daemon direct）——直接在你拥有的两台服务器之间传输，通过锁定的 TLS。无中继、无 SSH、无需配对码。",
      ],
    },
    {
      heading: "第一次传输",
      body: [
        "最快上手的方式是把一个文件夹复制到你能 SSH 进去的服务器。Relayium 使用你现有的 SSH 访问权限，远程无需任何配置，也不用创建账号：",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "如果远程也装了 relayium，就会使用原生协议（可续传、逐文件 SHA-256）。",
        "如果没装，就会退化为普通的 tar 流，因此在裸机服务器上依然可用。",
        "用这个命令把同样的文件取回来：relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "免费，且从设计上保护隐私",
      body: [
        "没有任何费用，也不用保留账号。CLI 直接连接两端，因此你的文件永远不会上传到中间的服务器——唯一会接触 Relayium 的，是 send / receive 模式下一次很小的会合握手，用来撮合两端，绝不是文件本身。",
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
        a: "不需要。push / pull 用你自己的 SSH，daemon direct 在你的服务器之间使用公钥信任，send / receive 用你们线下约定的配对码。三者都不需要账号。",
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
    text: "安装 Relayium CLI，完成你的第一次传输——完全免费，也无需账号。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI でターミナルからファイルを転送する",
  description:
    "無料でエンドツーエンド暗号化された Relayium CLI をインストールし、ターミナルから3つの方法でファイルを移動しましょう——自分の SSH 経由、ネットワークをまたぐペアリングコード、または2台のサーバー間の直接転送。アカウント不要で、ファイルのバイトが私たちのサーバーを通過することはありません。",
  updatedLabel: "最終更新",
  lead: [
    "Relayium CLI はターミナルからファイルを転送する、小さな単一バイナリです——エンドツーエンドで暗号化され、セルフホスト可能で、完全に無料です。ブラウザではうまく扱えない場面のために存在します。すでに運用しているサーバーへのファイルコピー、2台のマシン間でのビルド成果物のプッシュ、あるいはネットワークをまたいで同僚にアーカイブを送る際、誰のクラウドにもアップロードせずに済みます。",
    "どの方法を使っても、ファイルのバイトは両端の間を直接移動し、Relayium のサーバーを通過することはありません。本ガイドではインストールから最初の転送までを案内し、その後各モードのより詳しいハウツーへ案内します。",
  ],
  sections: [
    {
      heading: "1コマンドでインストール",
      body: [
        "macOS または Linux では、1つのコマンドでお使いの OS 向けのビルド済みバイナリをダウンロードし、PATH に配置できます:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "自分でファイルを選びたい場合は、リリースページからバイナリをダウンロードしてください。",
        "Go がインストール済みなら、リポジトリを clone して次を実行します: go build -o relayium ./cmd/relayium（server ディレクトリから）。",
        "その後 relayium --help を実行するとすべてのコマンドを確認でき、relayium version でビルドを確認できます。",
      ],
    },
    {
      heading: "ファイルを移動する3つの方法",
      body: [
        "Relayium には3つの転送方法があります。3つの異なるツールを覚える必要はなく、相手先の場所に応じて選ぶだけです——いずれも同じ転送エンジンを共有し、ファイル単位の再開と SHA-256 検証を備えています。",
      ],
      bullets: [
        "push / pull——すでに SSH でログインできるサーバーへ。バイトは SSH 接続上を流れます。Relayium アカウントは不要です。",
        "send / receive——短いペアリングコードを使って、ネットワークをまたいで他の人へ。直接の P2P です。直接経路が見つからない場合、転送は私たちを経由する代わりに、そのまま失敗します。",
        "serve + push relayium://（daemon direct）——自分が所有する2台のサーバー間で、ピン留めされた TLS 上を直接。リレーなし、SSH なし、コードなし。",
      ],
    },
    {
      heading: "最初の転送",
      body: [
        "最も手早く試せるのは、SSH でログインできるサーバーへフォルダをコピーすることです。Relayium は既存の SSH アクセスを使うので、リモート側で設定することは何もなく、アカウント作成も不要です:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "リモートにも relayium がインストールされていれば、ネイティブプロトコル（再開可能、ファイル単位の SHA-256）が使われます。",
        "インストールされていなければ、単純な tar ストリームにフォールバックするため、裸のサーバーでも動作します。",
        "同じファイルを次のコマンドで取り戻せます: relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "無料、そして設計上プライベート",
      body: [
        "支払うものは何もなく、保持するアカウントもありません。CLI は両端を直接つなぐため、ファイルが中間のサーバーにアップロードされることは決してありません——Relayium が触れるのは、send / receive モードでの小さなランデブーハンドシェイクだけで、両端を引き合わせるために使われ、ファイル自体は決して含まれません。",
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
        a: "いいえ。push / pull は自分の SSH を使い、daemon direct はサーバー間の公開鍵による信頼を使い、send / receive は事前に合意したコードを使います。いずれもアカウントは不要です。",
      },
      {
        q: "どのオペレーティングシステムに対応していますか？",
        a: "macOS、Linux、Windows 向けに、x86-64 と arm64 の両方でビルド済みバイナリが公開されています。インストールスクリプトは macOS と Linux に対応しています。Windows では、リリースページから .zip をダウンロードしてください。",
      },
      {
        q: "自分のファイルは Relayium のサーバーを通過しますか？",
        a: "いいえ。どのモードでも、ファイルのバイトは両端の間を直接移動します。私たちのサーバーに一切触れるのは send / receive だけで、それも小さなランデブーハンドシェイクのためだけです——ファイルの中身は決して含まれません。",
      },
    ],
  },
  cta: {
    text: "Relayium CLI をインストールして最初の転送をしましょう——完全無料で、アカウントも不要です。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 터미널에서 파일 전송하기",
  description:
    "무료로 종단간 암호화된 Relayium CLI를 설치하고, 터미널에서 세 가지 방식으로 파일을 옮기세요 — 자신의 SSH를 통해, 네트워크를 넘어 페어링 코드로, 또는 두 서버 사이에서 직접. 계정이 필요 없고, 파일 데이터는 절대 저희 서버를 거치지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Relayium CLI는 터미널에서 파일을 옮기는 작고 단일한 바이너리입니다 — 종단간 암호화되고, 자체 호스팅이 가능하며, 완전히 무료입니다. 브라우저가 잘 처리하지 못하는 상황을 위해 존재합니다. 이미 운영 중인 서버로 파일을 복사하거나, 두 기기 사이에서 빌드 결과물을 밀어 넣거나, 네트워크를 넘어 동료에게 아카이브를 보낼 때 누구의 클라우드에도 업로드하지 않아도 됩니다.",
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
        "send / receive — 짧은 페어링 코드를 사용해 네트워크를 넘어 다른 사람에게. 직접 P2P 방식입니다. 직접 경로를 찾을 수 없으면 저희를 거쳐 우회하는 대신 전송이 그대로 실패합니다.",
        "serve + push relayium://(daemon direct) — 직접 소유한 두 서버 사이에서, 고정된 TLS를 통해 곧바로. 중계도, SSH도, 코드도 필요 없습니다.",
      ],
    },
    {
      heading: "첫 전송",
      body: [
        "가장 빠르게 시도해 볼 수 있는 것은 SSH로 접속 가능한 서버로 폴더를 복사하는 것입니다. Relayium은 기존 SSH 접근 권한을 사용하므로 원격지에서 설정할 것이 없고 계정을 만들 필요도 없습니다:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "원격지에도 relayium이 설치되어 있으면 네이티브 프로토콜(재개 가능, 파일별 SHA-256)을 사용합니다.",
        "설치되어 있지 않으면 일반 tar 스트림으로 대체되므로, 아무것도 설치되지 않은 서버에서도 동작합니다.",
        "다음 명령어로 같은 파일을 다시 가져올 수 있습니다: relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "무료이며, 설계상 프라이버시를 지킵니다",
      body: [
        "지불할 것도, 유지할 계정도 없습니다. CLI는 두 끝을 직접 연결하므로 파일이 중간의 서버에 업로드되는 일은 결코 없습니다 — Relayium이 유일하게 관여하는 것은 send / receive 모드에서 두 끝을 소개하는 데 쓰이는 아주 작은 랑데부 핸드셰이크뿐이며, 파일 자체는 절대 포함되지 않습니다.",
        "모든 전송은 종단간 암호화되고, 모든 파일은 도착 시 SHA-256 해시로 검증되며, 중단된 전송은 처음부터 다시 시작하는 대신 멈춘 지점에서 재개됩니다. macOS, Linux, Windows에서 동작하며, 전체가 오픈소스이고 자체 호스팅이 가능합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "CLI 사용에 비용이 드나요?",
        a: "아니요. CLI는 완전히 무료입니다. 여러분의 기기를 직접 연결하며 파일 데이터를 Relayium을 거쳐 프록시하는 일이 결코 없으므로, 계량할 것도 지불할 것도 없습니다.",
      },
      {
        q: "Relayium 계정이 필요한가요?",
        a: "아니요. push / pull은 자신의 SSH를 사용하고, daemon direct는 서버 간 공개키 신뢰를 사용하며, send / receive는 별도 채널로 미리 합의한 코드를 사용합니다. 어느 것도 계정을 요구하지 않습니다.",
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
    text: "Relayium CLI를 설치하고 첫 전송을 해보세요 — 완전 무료이며 계정도 필요 없습니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien vom Terminal aus übertragen mit der Relayium CLI",
  description:
    "Installiere die kostenlose, Ende-zu-Ende-verschlüsselte Relayium CLI und bewege Dateien vom Terminal aus auf drei Arten — über dein eigenes SSH, per Pairing-Code netzwerkübergreifend, oder direkt zwischen zwei Servern. Kein Konto, und die Dateibytes laufen nie über unsere Server.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Die Relayium CLI ist ein einzelnes kleines Binary, das Dateien vom Terminal aus bewegt — Ende-zu-Ende verschlüsselt, selbst hostbar und völlig kostenlos. Sie existiert für die Fälle, die ein Browser schlecht handhabt: Dateien auf einen Server kopieren, den du bereits betreibst, einen Build zwischen zwei Maschinen pushen, oder ein Archiv netzwerkübergreifend an einen Kollegen schicken, ohne es in irgendjemandes Cloud hochzuladen.",
    "Egal welchen Weg du nutzt, die Dateibytes wandern direkt zwischen den beiden Enden und laufen nie über Relayiums Server. Diese Anleitung bringt dich zur Installation und durch deine erste Übertragung und verweist dich dann auf die ausführlicheren Anleitungen zu jedem Modus.",
  ],
  sections: [
    {
      heading: "Installation mit einem Befehl",
      body: [
        "Unter macOS oder Linux lädt ein Befehl ein vorgebautes Binary für dein Betriebssystem herunter und legt es in deinen PATH:",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Möchtest du die Datei lieber selbst auswählen? Lade ein Binary von der Releases-Seite herunter.",
        "Go installiert? Clone das Repository und führe aus: go build -o relayium ./cmd/relayium (aus dem server-Verzeichnis).",
        "Führe dann relayium --help aus, um alle Befehle zu sehen, und relayium version, um den Build zu prüfen.",
      ],
    },
    {
      heading: "Die drei Wege, Dateien zu bewegen",
      body: [
        "Relayium bewegt Dateien auf drei Arten. Du wählst danach, wo sich die Gegenstelle befindet, nicht indem du drei verschiedene Werkzeuge lernst — sie teilen sich eine Übertragungs-Engine mit dateiweiser Wiederaufnahme und SHA-256-Prüfung.",
      ],
      bullets: [
        "push / pull — zu einem Server, in den du dich bereits per SSH einloggen kannst. Die Bytes laufen über deine SSH-Verbindung; kein Relayium-Konto nötig.",
        "send / receive — an eine andere Person netzwerkübergreifend, mit einem kurzen Pairing-Code. Direktes Peer-to-Peer; findet sich kein direkter Weg, schlägt die Übertragung fehl, statt über uns umgeleitet zu werden.",
        "serve + push relayium:// (daemon direct) — direkt zwischen zwei Servern, die dir gehören, über gepinntes TLS. Kein Relay, kein SSH, kein Code.",
      ],
    },
    {
      heading: "Deine erste Übertragung",
      body: [
        "Am schnellsten lässt sich ausprobieren, einen Ordner auf einen Server zu kopieren, in den du dich per SSH einloggen kannst. Relayium nutzt deinen bestehenden SSH-Zugang, es gibt also nichts auf der Gegenseite zu konfigurieren und kein Konto anzulegen:",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "Ist relayium auch auf der Gegenseite installiert, nutzt es das native Protokoll (wiederaufnehmbar, dateiweises SHA-256).",
        "Ist es das nicht, fällt es auf einen einfachen tar-Stream zurück, sodass es auch auf einem nackten Server funktioniert.",
        "Hole dieselben Dateien mit folgendem Befehl zurück: relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Kostenlos und von Natur aus privat",
      body: [
        "Es gibt nichts zu bezahlen und kein Konto zu pflegen. Die CLI verbindet die beiden Enden direkt, sodass deine Dateien nie auf einen Server dazwischen hochgeladen werden — das Einzige, was Relayium jemals berührt, ist ein winziger Rendezvous-Handshake im send-/receive-Modus, der die beiden Enden einander vorstellt, niemals die Datei selbst.",
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
        a: "Nein. push / pull nutzt dein eigenes SSH, daemon direct nutzt Public-Key-Vertrauen zwischen deinen Servern, und send / receive nutzt einen Code, den ihr außerhalb des Kanals vereinbart. Keines davon erfordert ein Konto.",
      },
      {
        q: "Welche Betriebssysteme werden unterstützt?",
        a: "Vorgebaute Binaries werden für macOS, Linux und Windows veröffentlicht, jeweils für x86-64 und arm64. Das Installationsskript deckt macOS und Linux ab; unter Windows lädst du die .zip von der Releases-Seite herunter.",
      },
      {
        q: "Laufen meine Dateien über Relayiums Server?",
        a: "Nein. In jedem Modus wandern die Dateibytes direkt zwischen den beiden Enden. Nur send / receive kontaktiert unsere Server überhaupt, und auch nur für einen kleinen Rendezvous-Handshake — nie für den Dateiinhalt.",
      },
    ],
  },
  cta: {
    text: "Installiere die Relayium CLI und mach deine erste Übertragung — völlig kostenlos und ohne Konto.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer des fichiers depuis le terminal avec la CLI Relayium",
  description:
    "Installez la CLI Relayium, gratuite et chiffrée de bout en bout, et déplacez des fichiers de trois façons depuis votre terminal — via votre propre SSH, par un code d'appairage entre réseaux différents, ou directement entre deux serveurs. Aucun compte, et les octets du fichier ne passent jamais par nos serveurs.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "La CLI Relayium est un unique petit binaire qui déplace des fichiers depuis votre terminal — chiffré de bout en bout, auto-hébergeable et entièrement gratuit. Elle existe pour les cas qu'un navigateur gère mal : copier des fichiers vers un serveur que vous exploitez déjà, pousser un build entre deux machines, ou envoyer une archive à un collègue entre réseaux différents sans la téléverser dans le cloud de qui que ce soit.",
    "Quelle que soit la méthode utilisée, les octets du fichier voyagent directement entre les deux extrémités et ne passent jamais par les serveurs de Relayium. Ce guide vous installe et vous fait passer votre premier transfert, puis vous oriente vers les guides plus détaillés pour chaque mode.",
  ],
  sections: [
    {
      heading: "Installation en une commande",
      body: [
        "Sous macOS ou Linux, une commande télécharge un binaire précompilé pour votre OS et l'ajoute à votre PATH :",
      ],
      code: ["curl -fsSL https://relayium.com/install.sh | sh"],
      bullets: [
        "Vous préférez choisir le fichier vous-même ? Téléchargez un binaire depuis la page des releases.",
        "Go est installé ? Clonez le dépôt et lancez : go build -o relayium ./cmd/relayium (depuis le répertoire server).",
        "Lancez ensuite relayium --help pour voir toutes les commandes, et relayium version pour vérifier le build.",
      ],
    },
    {
      heading: "Les trois façons de déplacer des fichiers",
      body: [
        "Relayium déplace les fichiers de trois façons. Vous choisissez selon où se trouve l'autre bout, sans avoir à apprendre trois outils différents — ils partagent un seul moteur de transfert avec reprise par fichier et vérification SHA-256.",
      ],
      bullets: [
        "push / pull — vers un serveur où vous pouvez déjà vous connecter en SSH. Les octets transitent par votre connexion SSH ; aucun compte Relayium requis.",
        "send / receive — vers une autre personne entre réseaux différents, avec un court code d'appairage. Pair-à-pair direct ; si aucun chemin direct n'est trouvé, le transfert échoue plutôt que d'être routé via nos serveurs.",
        "serve + push relayium:// (daemon direct) — directement entre deux serveurs qui vous appartiennent, via TLS épinglé. Pas de relais, pas de SSH, pas de code.",
      ],
    },
    {
      heading: "Votre premier transfert",
      body: [
        "Le plus rapide à essayer est de copier un dossier vers un serveur où vous pouvez vous connecter en SSH. Relayium utilise votre accès SSH existant, il n'y a donc rien à configurer côté distant et aucun compte à créer :",
      ],
      code: ["relayium push ./photos user@your-server:backups/"],
      bullets: [
        "Si relayium est aussi installé sur la machine distante, il utilise le protocole natif (reprenable, SHA-256 par fichier).",
        "Sinon, il bascule sur un simple flux tar, ce qui fonctionne donc même sur un serveur nu.",
        "Récupérez les mêmes fichiers avec : relayium pull user@your-server:backups/ ./restore",
      ],
    },
    {
      heading: "Gratuit, et privé par conception",
      body: [
        "Il n'y a rien à payer et aucun compte à conserver. La CLI connecte les deux extrémités directement, si bien que vos fichiers ne sont jamais téléversés vers un serveur intermédiaire — la seule chose que Relayium touche jamais est une petite poignée de main de mise en relation en mode send / receive, utilisée pour présenter les deux extrémités l'une à l'autre, jamais le fichier lui-même.",
        "Chaque transfert est chiffré de bout en bout, chaque fichier est vérifié par une empreinte SHA-256 à l'arrivée, et un transfert interrompu reprend là où il s'était arrêté au lieu de recommencer depuis le début. Cela fonctionne sous macOS, Linux et Windows, et l'ensemble est open source et auto-hébergeable.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La CLI coûte-t-elle quelque chose ?",
        a: "Non. La CLI est entièrement gratuite. Elle connecte vos machines directement et ne fait jamais transiter les octets de vos fichiers par Relayium, donc il n'y a rien à mesurer ni à payer.",
      },
      {
        q: "Ai-je besoin d'un compte Relayium ?",
        a: "Non. push / pull utilise votre propre SSH, daemon direct utilise une confiance par clé publique entre vos serveurs, et send / receive utilise un code que vous convenez par un autre canal. Aucun des trois ne nécessite de compte.",
      },
      {
        q: "Quels systèmes d'exploitation sont pris en charge ?",
        a: "Des binaires précompilés sont publiés pour macOS, Linux et Windows, en x86-64 comme en arm64. Le script d'installation couvre macOS et Linux ; sous Windows, téléchargez le .zip depuis la page des releases.",
      },
      {
        q: "Mes fichiers passent-ils par les serveurs de Relayium ?",
        a: "Non. Dans tous les modes, les octets du fichier voyagent directement entre les deux extrémités. Seul send / receive contacte nos serveurs, et seulement pour une petite poignée de main de mise en relation — jamais pour le contenu du fichier.",
      },
    ],
  },
  cta: {
    text: "Installez la CLI Relayium et effectuez votre premier transfert — entièrement gratuit, et sans compte.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "cli/transfer-files-from-terminal",
  updated: "2026-07-08",
  langs: { en, zh, ja, ko, de, fr },
};
