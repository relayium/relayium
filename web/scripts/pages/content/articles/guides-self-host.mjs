// web/scripts/pages/content/articles/guides-self-host.mjs
// Self-hosting the Relayium server. English is the master; zh/ja/ko/de/fr
// follow the same structure with identical facts. Command/env-key blocks
// (code) stay English in every language.

import { withInstall, selfHostInstall } from "../install-section.mjs";

const en = {
  title: "Self-host Relayium: run your own file-and-text transfer server",
  description:
    "Run the whole Relayium stack yourself with one Docker command — your own domain, your own data, no third-party account. Covers file and ephemeral-text pairing, env keys, the optional browser TURN relay, and pointing the CLI at it.",
  updatedLabel: "Last updated",
  lead: [
    "Relayium is AGPL-3.0-licensed and open source, and the server is one self-contained image — no external database, no third-party storage bucket, nothing to sign up for. If you'd rather run the whole thing yourself than rely on relayium.com, this guide gets a server up with Docker and points the CLI at it.",
    "Self-hosting gives you full control over where your data lives, your own domain and TLS certificate, and no dependency on anyone else's infrastructure. Everything below is grounded in the files that ship in the repo — `docker-compose.yml`, `server/.env.example`, and `docs/self-hosting.md` — so nothing here is a flag or setting that doesn't actually exist.",
  ],
  sections: [
    {
      heading: "Why self-host",
      body: [
        "Relayium's realtime transfers are end-to-end encrypted. A self-hosted TURN relay may carry ciphertext bytes, and the server handles signaling metadata, but neither can read or decrypt file plaintext; neither the server nor relay stores a server-side copy or history of realtime content. The server does hold your account and — for stored/link-based transfers — ciphertext blobs and a small SQLite database. Self-hosting means that data lives on infrastructure you control, under your own domain, with nobody else's operational decisions in the loop.",
        "Because the project is AGPL-3.0-licensed and open source (github.com/relayium/relayium), you can read exactly what the server does before you trust it with anything, and fork or modify it freely.",
      ],
    },
    {
      heading: "Quick start with Docker",
      body: [
        "The repo root ships a `Dockerfile` and a `docker-compose.yml` that build one self-contained image — a static Go binary that serves the prebuilt web app, so there is no separate Node, Go toolchain, or nginx required just to run it:",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "That's the whole server, listening on :8080. Put nginx or Caddy in front for TLS in production — docs/self-hosting.md covers the Docker path and what to proxy; Relayium's own production nginx configuration isn't published.",
        "App config comes from an optional server/.env file plus the environment: block in docker-compose.yml. Every setting has a RELAYIUM_* key — copy server/.env.example as a starting point.",
        "The four keys that matter for a basic deploy: RELAYIUM_ADDR (listen address), RELAYIUM_STATIC (path to the built web app), RELAYIUM_DB (SQLite file path), and RELAYIUM_BLOB_DIR (where stored-link ciphertext is written). docker-compose.yml already sets sane defaults for all four and persists them in a named volume.",
      ],
    },
    {
      heading: "Add a TURN relay for cross-network transfers",
      body: [
        "Same-network (LAN) transfers and SSH-based push/pull work with nothing extra. Cross-network realtime transfers (two devices behind different NATs) sometimes need a TURN relay to establish a path — the relay only ever sees ciphertext, never your file contents.",
        "docker-compose.yml has an optional relay profile that starts coturn (the TURN server) and a small Redis instance for relay-byte metering, alongside the main server:",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "coturn needs the host's real public IP and an open UDP port range to work — docs/self-hosting.md covers running it through the Docker relay profile above; Relayium's own production coturn configuration (and install script) isn't published.",
        "Without --profile relay and RELAYIUM_TURN_SECRET, the server still runs fine — cross-network transfers just fall back to STUN-only, which works for easier NAT types but not the strictest ones.",
      ],
    },
    {
      heading: "Point the CLI at your server",
      body: [
        "The Relayium CLI defaults to relayium.com's rendezvous server for cross-network send/receive and text. Pass --server to use your own instead:",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "The CLI is free either way — --server changes which rendezvous server it talks to for the pairing-code handshake. send or text without a code mints one against that server, and cloud up stores under an account on it, so sign in there first with relayium login --server https://your-domain. receive, down, and text with the printed code need no login.",
        "Both text peers must stay online. Messages use their own end-to-end encrypted, direct peer-to-peer session; CLI text is direct-only and does not use the browser's TURN relay. Neither Relayium nor your self-hosted server stores message bodies or server-side history, but either terminal or recipient can copy or retain text after receiving it.",
        "push/pull (over your own SSH) and serve + daemon-direct push relayium://host don't touch relayium.com at all, self-hosted or not — they connect straight to the remote you specify.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need to set up TURN?",
        a: "Only if you want cross-network realtime transfers to work through strict NATs. Same-network transfers, SSH-based push/pull, and daemon-direct all work without it — TURN is purely for NAT traversal on the cross-network pairing-code path.",
      },
      {
        q: "Is the CLI still free if I self-host?",
        a: "Yes. The CLI is completely free whether it talks to relayium.com or a server you run yourself — --server just points it at your instance. An account on that server is needed by send or text when run without a code to mint one, and by up to store a file. receive, down, and text with a printed code need no login.",
      },
      {
        q: "Can I use my own domain and TLS certificate?",
        a: "Yes. The Docker image listens on plain HTTP on :8080; put nginx or Caddy in front with your own domain and certificate (e.g. via certbot/Let's Encrypt). docs/self-hosting.md covers what to proxy; Relayium's own production nginx configuration isn't published, so you'll write your own.",
      },
      {
        q: "What data does my self-hosted server store?",
        a: "A SQLite database (accounts, sessions) at RELAYIUM_DB and, for stored/link-based transfers, encrypted blobs at RELAYIUM_BLOB_DIR that the server itself cannot decrypt. The server keeps no realtime file or message body and only relays the signaling handshake; receiving endpoints can still save files or retain text.",
      },
    ],
  },
  cta: {
    text: "Install the free Relayium CLI and point it at your own server with --server.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "自托管 Relayium：运行属于你自己的文件与文本传输服务器",
  description:
    "用一条 Docker 命令自己运行完整的 Relayium 服务端——自己的域名、自己的数据，无需任何第三方账号。涵盖文件与临时文本配对、环境变量、可选的网页 TURN 中继，以及如何让 CLI 指向它。",
  updatedLabel: "最近更新",
  lead: [
    "Relayium 采用 AGPL-3.0 许可、开源，服务端是一个自包含的镜像——不需要外部数据库，不需要第三方存储桶，也没有什么需要注册。如果你更想自己运行整套系统而不是依赖 relayium.com，本指南会带你用 Docker 起一台服务器，并让 CLI 指向它。",
    "自托管让你完全掌控数据存放的位置、拥有自己的域名和 TLS 证书，也不依赖别人的运维决策。以下内容全部基于仓库中实际存在的文件——docker-compose.yml、server/.env.example 和 docs/self-hosting.md——因此这里不会出现任何实际不存在的参数或配置项。",
  ],
  sections: [
    {
      heading: "为什么要自托管",
      body: [
        "Relayium 的实时传输采用端到端加密。自托管的 TURN 中继可能承载密文字节，服务器也会处理信令元数据，但两者都无法读取或解密文件明文；服务器和中继均不保存实时内容的服务端副本或历史。服务器确实保存着你的账号，以及——对于存储型/链接型传输——密文数据块和一个小型 SQLite 数据库。自托管意味着这些数据存放在你自己掌控的基础设施上，挂在你自己的域名下，不受其他任何人的运维决策影响。",
        "由于该项目采用 AGPL-3.0 许可并且开源（github.com/relayium/relayium），你可以在信任它之前先读清楚服务端到底做了什么，也可以自由 fork 或修改它。",
      ],
    },
    {
      heading: "用 Docker 快速开始",
      body: [
        "仓库根目录提供了一个 Dockerfile 和一个 docker-compose.yml，它们会构建出一个自包含的镜像——一个静态 Go 二进制文件，同时提供预构建好的 Web 应用，因此仅仅为了运行它，你不需要单独的 Node、Go 工具链或 nginx：",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "这就是完整的服务器，监听在 :8080。生产环境请在前面加一层 nginx 或 Caddy 来处理 TLS——docs/self-hosting.md 说明了 Docker 部署路径以及需要反代哪些路径；Relayium 自己生产环境用的 nginx 配置并未公开。",
        "应用配置来自可选的 server/.env 文件，加上 docker-compose.yml 里的 environment: 块。每个设置项都有对应的 RELAYIUM_* 环境变量——可以先复制 server/.env.example 作为起点。",
        "基础部署最关键的四个变量是：RELAYIUM_ADDR（监听地址）、RELAYIUM_STATIC（已构建的 Web 应用路径）、RELAYIUM_DB（SQLite 文件路径），以及 RELAYIUM_BLOB_DIR（存储型链接密文的写入位置）。docker-compose.yml 已经为这四项设好了合理的默认值，并把它们持久化在一个具名卷里。",
      ],
    },
    {
      heading: "为跨网络传输加上 TURN 中继",
      body: [
        "同一网络（局域网）的传输，以及基于 SSH 的 push/pull，不需要任何额外配置就能工作。跨网络的实时传输（两台设备各自处于不同的 NAT 之后）有时需要一个 TURN 中继来建立路径——中继全程只能看到密文，绝不会看到文件内容。",
        "docker-compose.yml 里有一个可选的 relay profile，会在启动主服务器的同时启动 coturn（TURN 服务器）和一个用于中继流量计量的小型 Redis 实例：",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "coturn 需要主机真实的公网 IP，以及一段开放的 UDP 端口范围才能工作——docs/self-hosting.md 说明了通过 Docker 的 relay profile 运行它；Relayium 自己生产环境用的 coturn 配置（以及安装脚本）并未公开。",
        "如果不加 --profile relay 和 RELAYIUM_TURN_SECRET，服务器依然能正常运行——只是跨网络传输会退化为纯 STUN，这对较宽松的 NAT 类型没问题，但对最严格的类型不行。",
      ],
    },
    {
      heading: "让 CLI 指向你的服务器",
      body: [
        "Relayium CLI 默认使用 relayium.com 的会合服务器来完成跨网络的 send/receive 与 text。传入 --server 即可改用你自己的服务器：",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "无论用哪个服务器，CLI 都是免费的——--server 只是改变了配对码握手所连接的会合服务器。send 或 text 不带码运行时会在该服务器生成配对码，云端 up 也存到那台服务器上的账号下，所以要先用 relayium login --server https://your-domain 在那边登录；receive、down，以及使用打印配对码加入的 text 都无需登录。",
        "text 两端必须同时在线。消息使用独立的端到端加密 P2P 直连会话；CLI text 只支持直连，不使用网页版的 TURN 中继。Relayium 和你的自托管服务器都不保存消息正文或服务端历史，但任一终端或接收方都可以在收到文本后复制或留存。",
        "push/pull（走你自己的 SSH）以及 serve + daemon 直连的 push relayium://host，无论是否自托管都完全不会接触 relayium.com——它们直接连到你指定的远程地址。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我需要搭建 TURN 吗？",
        a: "只有当你希望跨网络的实时传输能穿透严格 NAT 时才需要。同一网络传输、基于 SSH 的 push/pull，以及 daemon 直连都不需要它——TURN 只用于跨网络配对码路径上的 NAT 穿透。",
      },
      {
        q: "自托管之后 CLI 还免费吗？",
        a: "是的。无论连接的是 relayium.com 还是你自己运行的服务器，CLI 都完全免费——--server 只是让它指向你的实例。send 或 text 不带码生成配对码时，以及 up 存文件时，需要目标服务器上的账号；receive、down 和使用打印配对码加入的 text 都无需登录。",
      },
      {
        q: "我可以用自己的域名和 TLS 证书吗？",
        a: "可以。Docker 镜像本身在 :8080 上以明文 HTTP 监听；在前面加一层 nginx 或 Caddy，配上你自己的域名和证书（例如通过 certbot/Let's Encrypt）。docs/self-hosting.md 说明了需要反代哪些路径；Relayium 自己生产环境用的 nginx 配置并未公开，需要你自己编写。",
      },
      {
        q: "我自托管的服务器会存储哪些数据？",
        a: "一个位于 RELAYIUM_DB 的 SQLite 数据库（账号、会话），以及——对于存储型/链接型传输——位于 RELAYIUM_BLOB_DIR 的加密数据块，服务器自己也无法解密它们。服务器不保存实时文件或消息正文，只转发信令握手；接收端仍可保存文件或留存文本。",
      },
    ],
  },
  cta: {
    text: "安装免费的 Relayium CLI，用 --server 指向你自己的服务器。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium をセルフホスト：自分専用のファイル・テキスト転送サーバーを運用",
  description:
    "1つの Docker コマンドで Relayium のサーバー一式を自分で運用——自分のドメイン、自分のデータ、第三者のアカウントは不要。ファイルと一時的なテキストのペアリング、環境変数、任意のブラウザ用 TURN リレー、CLI をそのサーバーに向ける方法を解説します。",
  updatedLabel: "最終更新",
  lead: [
    "Relayium は AGPL-3.0 ライセンスのオープンソースで、サーバーは1つの自己完結型イメージです——外部データベースも、サードパーティのストレージバケットも不要で、登録するものもありません。relayium.com に頼るのではなく全体を自分で運用したいなら、本ガイドで Docker によりサーバーを立ち上げ、CLI をそこに向ける方法を案内します。",
    "セルフホストすることで、データがどこに置かれるかを完全に管理でき、自分のドメインと TLS 証明書を使え、他人のインフラ運用判断に依存しません。以下の内容はすべてリポジトリに実際に存在するファイル——docker-compose.yml、server/.env.example、docs/self-hosting.md——に基づいており、実在しないフラグや設定は登場しません。",
  ],
  sections: [
    {
      heading: "なぜセルフホストするのか",
      body: [
        "Relayium のリアルタイム転送はエンドツーエンドで暗号化されています。セルフホストした TURN リレーは暗号文のバイトを運ぶことがあり、サーバーはシグナリングのメタデータを処理しますが、どちらもファイルの平文を読んだり復号したりできません。サーバーもリレーも、リアルタイム内容のサーバー側コピーや履歴を保存しません。サーバーはアカウントを保持し、また保存型/リンク型の転送については、暗号化されたブロブと小さな SQLite データベースを保持します。セルフホストとは、そのデータが自分が管理するインフラ上に、自分のドメインの下に置かれ、他人の運用判断が介在しないということです。",
        "このプロジェクトは AGPL-3.0 ライセンスでオープンソース（github.com/relayium/relayium）なので、何かを任せる前にサーバーが正確に何をしているかを読んで確認でき、自由に fork したり改変したりできます。",
      ],
    },
    {
      heading: "Docker でクイックスタート",
      body: [
        "リポジトリのルートには Dockerfile と docker-compose.yml があり、これらは1つの自己完結型イメージ——事前ビルド済みの Web アプリを配信する静的 Go バイナリ——をビルドします。実行するためだけに別途 Node、Go ツールチェーン、nginx は不要です:",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "これでサーバー全体が :8080 で待ち受けます。本番環境では前段に nginx か Caddy を置いて TLS を処理してください——docs/self-hosting.md は Docker での構成とプロキシすべきパスを説明しています。Relayium 自身の本番 nginx 設定は公開されていません。",
        "アプリの設定は任意の server/.env ファイルと、docker-compose.yml 内の environment: ブロックから読み込まれます。すべての設定項目に対応する RELAYIUM_* キーがあります——出発点として server/.env.example をコピーしてください。",
        "基本的なデプロイで重要な4つのキーは、RELAYIUM_ADDR（リッスンアドレス）、RELAYIUM_STATIC（ビルド済み Web アプリのパス）、RELAYIUM_DB（SQLite ファイルパス）、RELAYIUM_BLOB_DIR（保存型リンクの暗号文の書き込み先）です。docker-compose.yml はこの4つすべてに妥当なデフォルトを設定済みで、名前付きボリュームに永続化します。",
      ],
    },
    {
      heading: "ネットワークをまたぐ転送用に TURN リレーを追加する",
      body: [
        "同一ネットワーク（LAN）の転送や、SSH ベースの push/pull は、追加設定なしで動作します。ネットワークをまたぐリアルタイム転送（それぞれ異なる NAT の背後にある2台のデバイス）は、経路確立のために TURN リレーが必要になることがあります——リレーは常に暗号文しか見ず、ファイルの中身を見ることは決してありません。",
        "docker-compose.yml には任意の relay プロファイルがあり、メインサーバーと合わせて coturn（TURN サーバー）と、リレーバイト計測用の小さな Redis インスタンスを起動できます:",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "coturn が動作するにはホストの実際のパブリック IP と、開放された UDP ポート範囲が必要です——docs/self-hosting.md は Docker の relay プロファイルでの起動方法を説明しています。Relayium 自身の本番 coturn 設定（インストールスクリプトを含む）は公開されていません。",
        "--profile relay と RELAYIUM_TURN_SECRET を使わなくてもサーバー自体は問題なく動作します——ネットワークをまたぐ転送は単に STUN のみにフォールバックし、比較的緩い NAT タイプでは機能しますが、最も厳しいタイプでは機能しません。",
      ],
    },
    {
      heading: "CLI を自分のサーバーに向ける",
      body: [
        "Relayium CLI は、ネットワークをまたぐ send/receive と text で既定では relayium.com のランデブーサーバーを使います。--server を渡せば、代わりに自分のサーバーを使えます:",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "どちらのサーバーを使っても CLI は無料です——--server はペアリングコードのハンドシェイク先を変更するだけです。send または text をコードなしで実行するとそのサーバーでコードを発行し、クラウドの up もそのサーバー上のアカウントに保存するため、先に relayium login --server https://your-domain でサインインしてください。receive、down、表示されたコードで参加する text はログイン不要です。",
        "text の両端は同時にオンラインである必要があります。メッセージは独立したエンドツーエンド暗号化 P2P 直結セッションを使います。CLI text は直結専用で、ブラウザ版の TURN リレーは使いません。Relayium もセルフホストしたサーバーもメッセージ本文やサーバー側の履歴を保存しませんが、どちらの端末または受信者も受信後のテキストをコピーまたは保持できます。",
        "push/pull（自分の SSH 経由）や、serve とデーモン直結の push relayium://host は、セルフホストかどうかにかかわらず relayium.com に一切触れません——指定したリモートに直接接続します。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "TURN を設定する必要はありますか？",
        a: "ネットワークをまたぐリアルタイム転送を厳しい NAT 越しでも機能させたい場合にのみ必要です。同一ネットワークの転送、SSH ベースの push/pull、デーモン直結はいずれも TURN なしで動作します——TURN はネットワークをまたぐペアリングコード経路での NAT 越え専用です。",
      },
      {
        q: "セルフホストしても CLI は無料のままですか？",
        a: "はい。relayium.com でも自分のサーバーでも CLI は完全無料です。コードなしの send または text でコードを発行するときと、up でファイルを保存するときは、指し先サーバーのアカウントが必要です。receive、down、表示されたコードで参加する text はログイン不要です。",
      },
      {
        q: "自分のドメインと TLS 証明書を使えますか？",
        a: "使えます。Docker イメージ自体は :8080 で平文の HTTP を待ち受けます。前段に nginx か Caddy を置き、自分のドメインと証明書（例えば certbot/Let's Encrypt 経由）を設定してください。docs/self-hosting.md はプロキシすべき内容を説明しています。Relayium 自身の本番 nginx 設定は公開されていないため、自分で用意する必要があります。",
      },
      {
        q: "セルフホストしたサーバーはどんなデータを保存しますか？",
        a: "RELAYIUM_DB にある SQLite データベース（アカウント、セッション）と、保存型/リンク型の転送については RELAYIUM_BLOB_DIR にある暗号化されたブロブ——これはサーバー自身も復号できません。サーバーはリアルタイムのファイルやメッセージ本文を保存せず、シグナリングのハンドシェイクだけを中継しますが、受信端末はファイルやテキストを保持できます。",
      },
    ],
  },
  cta: {
    text: "無料の Relayium CLI をインストールし、--server で自分のサーバーに向けましょう。",
    button: "CLI を入手",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium 셀프 호스팅: 나만의 파일·텍스트 전송 서버 운영하기",
  description:
    "Docker 명령어 하나로 Relayium 전체 스택을 직접 운영하세요 — 자신의 도메인, 자신의 데이터, 제3자 계정 불필요. 파일과 임시 텍스트 페어링, 환경 변수, 선택적 브라우저 TURN 릴레이, CLI를 서버로 연결하는 방법까지 다룹니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Relayium은 AGPL-3.0 라이선스 오픈소스이며, 서버는 단일한 자체 완결형 이미지입니다 — 외부 데이터베이스도, 서드파티 스토리지 버킷도 필요 없고, 가입할 것도 없습니다. relayium.com에 의존하는 대신 전체를 직접 운영하고 싶다면, 이 가이드는 Docker로 서버를 띄우고 CLI를 그 서버로 연결하는 방법을 안내합니다.",
    "자체 호스팅을 하면 데이터가 어디에 저장되는지 완전히 통제할 수 있고, 자신의 도메인과 TLS 인증서를 쓸 수 있으며, 다른 누구의 운영 판단에도 의존하지 않습니다. 아래 내용은 모두 저장소에 실제로 존재하는 파일 — docker-compose.yml, server/.env.example, docs/self-hosting.md — 을 근거로 하므로, 실제로 존재하지 않는 플래그나 설정은 등장하지 않습니다.",
  ],
  sections: [
    {
      heading: "왜 자체 호스팅을 하나",
      body: [
        "Relayium의 실시간 전송은 종단간 암호화됩니다. 자체 호스팅한 TURN 릴레이는 암호문 바이트를 운반할 수 있고 서버는 시그널링 메타데이터를 처리하지만, 어느 쪽도 파일 평문을 읽거나 복호화할 수 없습니다. 서버와 릴레이 모두 실시간 내용의 서버 측 사본이나 기록을 저장하지 않습니다. 서버는 계정을 보관하며, 저장형/링크형 전송의 경우 암호화된 블롭과 작은 SQLite 데이터베이스도 보관합니다. 자체 호스팅이란 그 데이터가 직접 통제하는 인프라 위에, 자신의 도메인 아래 놓이고, 다른 누구의 운영 판단도 개입하지 않는다는 뜻입니다.",
        "이 프로젝트는 AGPL-3.0 라이선스로 오픈소스(github.com/relayium/relayium)이므로, 무언가를 맡기기 전에 서버가 정확히 무엇을 하는지 직접 읽어볼 수 있고, 자유롭게 fork하거나 수정할 수도 있습니다.",
      ],
    },
    {
      heading: "Docker로 빠르게 시작하기",
      body: [
        "저장소 루트에는 Dockerfile과 docker-compose.yml이 있으며, 이들은 단일한 자체 완결형 이미지 — 미리 빌드된 웹 앱을 제공하는 정적 Go 바이너리 — 를 빌드합니다. 그저 실행만 하는 데는 별도의 Node, Go 툴체인, nginx가 필요 없습니다:",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "이것이 서버 전체이며, :8080에서 대기합니다. 운영 환경에서는 앞단에 nginx나 Caddy를 두어 TLS를 처리하세요 — docs/self-hosting.md에 Docker 배포 경로와 프록시해야 할 경로가 설명되어 있습니다. Relayium이 실제 운영에 쓰는 nginx 설정 자체는 공개되어 있지 않습니다.",
        "앱 설정은 선택적인 server/.env 파일과 docker-compose.yml의 environment: 블록에서 옵니다. 모든 설정 항목에는 대응하는 RELAYIUM_* 키가 있습니다 — 시작점으로 server/.env.example을 복사하세요.",
        "기본 배포에서 중요한 4가지 키는 RELAYIUM_ADDR(리스닝 주소), RELAYIUM_STATIC(빌드된 웹 앱 경로), RELAYIUM_DB(SQLite 파일 경로), RELAYIUM_BLOB_DIR(저장형 링크 암호문이 기록되는 위치)입니다. docker-compose.yml은 이미 이 4가지 모두에 합리적인 기본값을 설정해 두었고, 명명된 볼륨에 영속화합니다.",
      ],
    },
    {
      heading: "네트워크 간 전송을 위한 TURN 릴레이 추가하기",
      body: [
        "같은 네트워크(LAN) 전송과 SSH 기반 push/pull은 별도 설정 없이 동작합니다. 네트워크를 넘나드는 실시간 전송(서로 다른 NAT 뒤에 있는 두 기기)은 경로를 확보하기 위해 TURN 릴레이가 필요할 때가 있습니다 — 릴레이는 언제나 암호문만 볼 뿐, 파일 내용을 보는 일은 결코 없습니다.",
        "docker-compose.yml에는 선택적인 relay 프로필이 있어, 메인 서버와 함께 coturn(TURN 서버)과 릴레이 바이트 계량용 소형 Redis 인스턴스를 시작할 수 있습니다:",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "coturn이 동작하려면 호스트의 실제 공인 IP와 열려 있는 UDP 포트 범위가 필요합니다 — docs/self-hosting.md에 Docker의 relay 프로필로 실행하는 방법이 설명되어 있습니다. Relayium이 실제 운영에 쓰는 coturn 설정(설치 스크립트 포함)은 공개되어 있지 않습니다.",
        "--profile relay와 RELAYIUM_TURN_SECRET 없이도 서버 자체는 문제없이 동작합니다 — 다만 네트워크 간 전송이 STUN만 사용하는 방식으로 대체되며, 이는 비교적 느슨한 NAT 유형에서는 동작하지만 가장 엄격한 유형에서는 동작하지 않습니다.",
      ],
    },
    {
      heading: "CLI를 자신의 서버로 연결하기",
      body: [
        "Relayium CLI는 네트워크 간 send/receive와 text에서 기본적으로 relayium.com의 랑데부 서버를 사용합니다. --server를 전달하면 대신 자신의 서버를 사용할 수 있습니다:",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "어느 서버를 쓰든 CLI는 무료입니다 — --server는 페어링 코드 핸드셰이크 서버만 바꿉니다. send나 text를 코드 없이 실행하면 그 서버에서 코드를 발급하고, 클라우드 up도 그 서버 계정에 저장하므로 먼저 relayium login --server https://your-domain으로 로그인하세요. receive, down, 출력된 코드로 참여하는 text는 로그인이 필요 없습니다.",
        "text 양쪽은 동시에 온라인이어야 합니다. 메시지는 별도의 종단간 암호화 P2P 직접 연결 세션을 사용합니다. CLI text는 직접 연결 전용이며 브라우저의 TURN 릴레이를 사용하지 않습니다. Relayium과 자체 호스팅 서버는 메시지 본문이나 서버 측 기록을 저장하지 않지만, 어느 터미널이나 수신자든 받은 텍스트를 복사하거나 보관할 수 있습니다.",
        "push/pull(자신의 SSH를 통한)과 serve + 데몬 다이렉트의 push relayium://host는 자체 호스팅 여부와 무관하게 relayium.com에 전혀 닿지 않습니다 — 지정한 원격지에 직접 연결됩니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "TURN을 설정해야 하나요?",
        a: "네트워크를 넘나드는 실시간 전송이 엄격한 NAT 환경에서도 동작하길 원할 때만 필요합니다. 같은 네트워크 전송, SSH 기반 push/pull, 데몬 다이렉트는 모두 TURN 없이 동작합니다 — TURN은 네트워크 간 페어링 코드 경로의 NAT 통과에만 쓰입니다.",
      },
      {
        q: "자체 호스팅해도 CLI는 여전히 무료인가요?",
        a: "네. relayium.com이든 직접 운영하는 서버든 CLI는 완전히 무료입니다. 코드 없는 send나 text로 코드를 발급할 때와 up으로 파일을 저장할 때는 대상 서버 계정이 필요합니다. receive, down, 출력된 코드로 참여하는 text는 로그인이 필요 없습니다.",
      },
      {
        q: "자신의 도메인과 TLS 인증서를 쓸 수 있나요?",
        a: "네. Docker 이미지 자체는 :8080에서 평문 HTTP로 대기합니다. 앞단에 nginx나 Caddy를 두고 자신의 도메인과 인증서(예: certbot/Let's Encrypt)를 설정하세요. docs/self-hosting.md에 프록시해야 할 경로가 설명되어 있습니다. Relayium이 실제 운영에 쓰는 nginx 설정은 공개되어 있지 않으므로 직접 작성해야 합니다.",
      },
      {
        q: "자체 호스팅한 서버는 어떤 데이터를 저장하나요?",
        a: "RELAYIUM_DB에 있는 SQLite 데이터베이스(계정, 세션)와, 저장형/링크형 전송의 경우 RELAYIUM_BLOB_DIR에 있는 암호화된 블롭 — 이는 서버 자신도 복호화할 수 없습니다. 서버는 실시간 파일이나 메시지 본문을 저장하지 않고 시그널링 핸드셰이크만 중계하지만, 수신 기기는 파일이나 텍스트를 보관할 수 있습니다.",
      },
    ],
  },
  cta: {
    text: "무료 Relayium CLI를 설치하고 --server로 자신의 서버를 가리키세요.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium selbst hosten: eigener Datei- und Textübertragungs-Server",
  description:
    "Betreibe den gesamten Relayium-Stack mit einem einzigen Docker-Befehl selbst — eigene Domain, eigene Daten, kein Konto bei Dritten nötig. Behandelt Datei- und flüchtige Textkopplung, Env-Keys, das optionale Browser-TURN-Relay und das Ausrichten der CLI darauf.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Relayium ist AGPL-3.0-lizenziert und Open Source, und der Server ist ein einziges eigenständiges Image — keine externe Datenbank, kein Storage-Bucket eines Drittanbieters, nichts, wofür man sich anmelden müsste. Wenn du lieber alles selbst betreibst, statt dich auf relayium.com zu verlassen, bringt dich diese Anleitung mit Docker zu einem laufenden Server und richtet die CLI darauf aus.",
    "Selbst hosten heißt, volle Kontrolle darüber zu haben, wo deine Daten liegen, eine eigene Domain und ein eigenes TLS-Zertifikat zu nutzen, und von den Betriebsentscheidungen anderer unabhängig zu sein. Alles Folgende stützt sich auf Dateien, die tatsächlich im Repository liegen — docker-compose.yml, server/.env.example und docs/self-hosting.md —, sodass hier kein Flag und keine Einstellung erwähnt wird, die es nicht wirklich gibt.",
  ],
  sections: [
    {
      heading: "Warum selbst hosten",
      body: [
        "Relayiums Echtzeit-Übertragungen sind Ende-zu-Ende verschlüsselt. Ein selbst gehostetes TURN-Relay kann verschlüsselte Bytes transportieren und der Server verarbeitet Signalisierungsmetadaten, doch beide können Dateiklartext weder lesen noch entschlüsseln; weder Server noch Relay speichern eine serverseitige Kopie oder Historie von Echtzeitinhalten. Der Server hält aber dein Konto und — bei gespeicherten/link-basierten Übertragungen — verschlüsselte Blobs sowie eine kleine SQLite-Datenbank. Selbst hosten bedeutet, dass diese Daten auf Infrastruktur liegen, die du kontrollierst, unter deiner eigenen Domain, ohne dass fremde Betriebsentscheidungen mitspielen.",
        "Da das Projekt AGPL-3.0-lizenziert und Open Source ist (github.com/relayium/relayium), kannst du genau nachlesen, was der Server tut, bevor du ihm irgendetwas anvertraust, und ihn frei forken oder verändern.",
      ],
    },
    {
      heading: "Schnellstart mit Docker",
      body: [
        "Im Repository-Root liegen ein Dockerfile und ein docker-compose.yml, die ein einziges eigenständiges Image bauen — ein statisches Go-Binary, das die vorgebaute Web-App ausliefert, sodass für den reinen Betrieb weder ein separates Node, eine Go-Toolchain noch nginx nötig ist:",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "Das ist bereits der gesamte Server, er lauscht auf :8080. Setze in Produktion nginx oder Caddy davor, um TLS zu übernehmen — docs/self-hosting.md beschreibt den Docker-Weg und was du proxyen musst; Relayiums eigene Produktions-nginx-Konfiguration ist nicht veröffentlicht.",
        "Die App-Konfiguration kommt aus einer optionalen server/.env-Datei plus dem environment:-Block in docker-compose.yml. Jede Einstellung hat einen passenden RELAYIUM_*-Key — kopiere server/.env.example als Ausgangspunkt.",
        "Die vier für eine einfache Bereitstellung wichtigen Keys: RELAYIUM_ADDR (Listen-Adresse), RELAYIUM_STATIC (Pfad zur gebauten Web-App), RELAYIUM_DB (SQLite-Dateipfad) und RELAYIUM_BLOB_DIR (wohin der Chiffretext gespeicherter Links geschrieben wird). docker-compose.yml setzt für alle vier bereits sinnvolle Standardwerte und persistiert sie in einem benannten Volume.",
      ],
    },
    {
      heading: "Ein TURN-Relay für netzwerkübergreifende Übertragungen hinzufügen",
      body: [
        "Übertragungen im selben Netzwerk (LAN) und SSH-basiertes push/pull funktionieren ohne irgendetwas Zusätzliches. Netzwerkübergreifende Echtzeit-Übertragungen (zwei Geräte hinter unterschiedlichen NATs) brauchen manchmal ein TURN-Relay, um einen Pfad herzustellen — das Relay sieht dabei stets nur Chiffretext, niemals deinen Dateiinhalt.",
        "docker-compose.yml hat ein optionales relay-Profil, das zusammen mit dem Hauptserver coturn (den TURN-Server) und eine kleine Redis-Instanz für die Zählung der Relay-Bytes startet:",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "coturn braucht die echte öffentliche IP des Hosts und einen offenen UDP-Portbereich, um zu funktionieren — docs/self-hosting.md beschreibt den Start über das Docker-relay-Profil; Relayiums eigene Produktions-coturn-Konfiguration (inklusive Installationsskript) ist nicht veröffentlicht.",
        "Ohne --profile relay und RELAYIUM_TURN_SECRET läuft der Server trotzdem einwandfrei — netzwerkübergreifende Übertragungen fallen dann nur auf reines STUN zurück, das bei einfacheren NAT-Typen funktioniert, aber nicht bei den strengsten.",
      ],
    },
    {
      heading: "Die CLI auf deinen Server ausrichten",
      body: [
        "Die Relayium CLI verwendet für netzwerkübergreifendes send/receive und text standardmäßig den Rendezvous-Server auf relayium.com. Übergib --server, um stattdessen deinen eigenen zu nutzen:",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "Egal welchen Server sie nutzt, die CLI ist kostenlos — --server ändert nur den Rendezvous-Server. send oder text ohne Code erzeugen dort einen Code, und Cloud-up speichert unter einem Konto auf ihm; melde dich daher zuerst mit relayium login --server https://your-domain an. receive, down und text mit dem ausgegebenen Code brauchen keine Anmeldung.",
        "Beide text-Gegenstellen müssen gleichzeitig online bleiben. Nachrichten laufen über eine eigene Ende-zu-Ende-verschlüsselte direkte P2P-Sitzung. CLI text ist rein direkt und nutzt nicht das TURN-Relay der Web-App. Weder Relayium noch dein selbst gehosteter Server speichern Nachrichteninhalte oder einen serverseitigen Verlauf; beide Terminals beziehungsweise der Empfänger können empfangenen Text jedoch kopieren oder aufbewahren.",
        "push/pull (über dein eigenes SSH) sowie serve + daemon-direct push relayium://host berühren relayium.com überhaupt nicht, selbst gehostet oder nicht — sie verbinden sich direkt mit der von dir angegebenen Gegenstelle.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss ich TURN einrichten?",
        a: "Nur, wenn netzwerkübergreifende Echtzeit-Übertragungen auch durch strenge NATs funktionieren sollen. Übertragungen im selben Netzwerk, SSH-basiertes push/pull und daemon-direct funktionieren alle ohne TURN — TURN dient ausschließlich der NAT-Traversal auf dem netzwerkübergreifenden Pairing-Code-Pfad.",
      },
      {
        q: "Ist die CLI immer noch kostenlos, wenn ich selbst hoste?",
        a: "Ja. Die CLI bleibt mit relayium.com wie mit deinem eigenen Server kostenlos. Ein Konto auf dem Zielserver brauchen send oder text ohne Code zum Erzeugen eines Codes sowie up zum Speichern einer Datei. receive, down und text mit dem ausgegebenen Code brauchen keine Anmeldung.",
      },
      {
        q: "Kann ich meine eigene Domain und ein eigenes TLS-Zertifikat verwenden?",
        a: "Ja. Das Docker-Image lauscht selbst auf reinem HTTP auf :8080; setze nginx oder Caddy mit deiner eigenen Domain und deinem Zertifikat davor (z. B. über certbot/Let's Encrypt). docs/self-hosting.md beschreibt, was zu proxyen ist; Relayiums eigene Produktions-nginx-Konfiguration ist nicht veröffentlicht, du musst also deine eigene schreiben.",
      },
      {
        q: "Welche Daten speichert mein selbst gehosteter Server?",
        a: "Eine SQLite-Datenbank (Konten, Sessions) unter RELAYIUM_DB und, bei gespeicherten/link-basierten Übertragungen, verschlüsselte Blobs unter RELAYIUM_BLOB_DIR, die der Server selbst nicht entschlüsseln kann. Der Server speichert keine Echtzeit-Dateien oder Nachrichteninhalte und leitet nur den Signaling-Handshake weiter; Empfangsgeräte können Dateien oder Text dennoch behalten.",
      },
    ],
  },
  cta: {
    text: "Installiere die kostenlose Relayium CLI und richte sie mit --server auf deinen eigenen Server aus.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Auto-héberger Relayium : gérez votre serveur de transfert de fichiers et de texte",
  description:
    "Faites tourner toute la pile Relayium vous-même avec une seule commande Docker — votre propre domaine, vos propres données, aucun compte tiers requis. Couvre l'appairage de fichiers et de texte éphémère, les clés d'environnement, le relais TURN optionnel du navigateur et le paramétrage de la CLI.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Relayium est sous licence AGPL-3.0 et open source, et le serveur est une image unique et autonome — pas de base de données externe, pas de bucket de stockage tiers, rien à quoi s'inscrire. Si vous préférez tout faire tourner vous-même plutôt que dépendre de relayium.com, ce guide vous fait monter un serveur avec Docker et paramètre la CLI pour qu'elle s'y connecte.",
    "S'auto-héberger vous donne un contrôle total sur l'emplacement de vos données, votre propre domaine et certificat TLS, et aucune dépendance aux décisions opérationnelles de quelqu'un d'autre. Tout ce qui suit s'appuie sur des fichiers réellement présents dans le dépôt — docker-compose.yml, server/.env.example et docs/self-hosting.md — donc rien ici n'est un indicateur ou un réglage qui n'existe pas réellement.",
  ],
  sections: [
    {
      heading: "Pourquoi s'auto-héberger",
      body: [
        "Les transferts en temps réel de Relayium sont chiffrés de bout en bout. Un relais TURN auto-hébergé peut transporter des octets chiffrés et le serveur traite des métadonnées de signalisation, mais aucun des deux ne peut lire ni déchiffrer le contenu en clair des fichiers ; ni le serveur ni le relais ne stockent de copie ou d'historique côté serveur du contenu en temps réel. Le serveur conserve toutefois votre compte et — pour les transferts stockés/basés sur un lien — des blobs chiffrés ainsi qu'une petite base SQLite. S'auto-héberger signifie que ces données vivent sur une infrastructure que vous contrôlez, sous votre propre domaine, sans que les décisions opérationnelles de quelqu'un d'autre n'interviennent.",
        "Le projet étant sous licence AGPL-3.0 et open source (github.com/relayium/relayium), vous pouvez lire exactement ce que fait le serveur avant de lui confier quoi que ce soit, et le forker ou le modifier librement.",
      ],
    },
    {
      heading: "Démarrage rapide avec Docker",
      body: [
        "La racine du dépôt fournit un Dockerfile et un docker-compose.yml qui construisent une seule image autonome — un binaire Go statique servant l'application web précompilée, donc aucun Node, aucune chaîne d'outils Go ni aucun nginx séparé n'est requis juste pour le faire tourner :",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "C'est tout le serveur, à l'écoute sur :8080. En production, placez nginx ou Caddy devant pour le TLS — docs/self-hosting.md couvre le chemin Docker et ce qu'il faut proxyfier ; la configuration nginx de production propre à Relayium n'est pas publiée.",
        "La configuration de l'appli provient d'un fichier server/.env optionnel plus le bloc environment: dans docker-compose.yml. Chaque réglage a une clé RELAYIUM_* correspondante — copiez server/.env.example comme point de départ.",
        "Les quatre clés qui comptent pour un déploiement de base : RELAYIUM_ADDR (adresse d'écoute), RELAYIUM_STATIC (chemin vers l'application web compilée), RELAYIUM_DB (chemin du fichier SQLite) et RELAYIUM_BLOB_DIR (où est écrit le texte chiffré des liens stockés). docker-compose.yml définit déjà des valeurs par défaut raisonnables pour ces quatre clés et les persiste dans un volume nommé.",
      ],
    },
    {
      heading: "Ajouter un relais TURN pour les transferts entre réseaux",
      body: [
        "Les transferts sur le même réseau (LAN) et le push/pull basé sur SSH fonctionnent sans rien de plus. Les transferts en temps réel entre réseaux différents (deux appareils derrière des NAT différents) nécessitent parfois un relais TURN pour établir un chemin — le relais ne voit jamais que du texte chiffré, jamais le contenu de vos fichiers.",
        "docker-compose.yml a un profil relay optionnel qui démarre coturn (le serveur TURN) et une petite instance Redis pour la mesure des octets relayés, aux côtés du serveur principal :",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "coturn a besoin de la véritable IP publique de l'hôte et d'une plage de ports UDP ouverte pour fonctionner — docs/self-hosting.md couvre le démarrage via le profil relay de Docker ; la configuration coturn de production propre à Relayium (y compris son script d'installation) n'est pas publiée.",
        "Sans --profile relay ni RELAYIUM_TURN_SECRET, le serveur fonctionne quand même parfaitement — les transferts entre réseaux différents basculent simplement sur STUN seul, ce qui fonctionne pour les NAT les plus simples mais pas pour les plus stricts.",
      ],
    },
    {
      heading: "Paramétrer la CLI pour votre serveur",
      body: [
        "Par défaut, la CLI Relayium utilise le serveur de rendez-vous de relayium.com pour send/receive et text entre réseaux différents. Passez --server pour utiliser le vôtre à la place :",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "Quel que soit le serveur utilisé, la CLI est gratuite — --server ne change que le serveur de rendez-vous. send ou text sans code y génèrent un code, et up y stocke sous un compte ; connectez-vous donc d'abord avec relayium login --server https://your-domain. receive, down et text avec le code affiché ne nécessitent aucune connexion.",
        "Les deux extrémités de text doivent rester en ligne. Les messages utilisent leur propre session P2P directe chiffrée de bout en bout. Le text de la CLI est exclusivement direct et n'utilise pas le relais TURN de l'appli web. Ni Relayium ni votre serveur auto-hébergé ne stockent le corps des messages ou un historique côté serveur, mais chaque terminal ou destinataire peut copier ou conserver le texte après réception.",
        "push/pull (via votre propre SSH) ainsi que serve + le push daemon-direct relayium://host ne touchent jamais relayium.com, auto-hébergé ou non — ils se connectent directement à la machine distante que vous indiquez.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je configurer TURN ?",
        a: "Seulement si vous voulez que les transferts en temps réel entre réseaux différents fonctionnent à travers des NAT stricts. Les transferts sur le même réseau, le push/pull basé sur SSH et le daemon-direct fonctionnent tous sans TURN — TURN sert uniquement au NAT traversal sur le chemin du code d'appairage entre réseaux différents.",
      },
      {
        q: "La CLI reste-t-elle gratuite si je m'auto-héberge ?",
        a: "Oui. La CLI reste gratuite avec relayium.com comme avec votre serveur. Un compte sur le serveur visé est requis par send ou text sans code pour en générer un, et par up pour stocker un fichier. receive, down et text avec le code affiché ne nécessitent aucune connexion.",
      },
      {
        q: "Puis-je utiliser mon propre domaine et mon propre certificat TLS ?",
        a: "Oui. L'image Docker écoute elle-même en HTTP simple sur :8080 ; placez nginx ou Caddy devant avec votre propre domaine et votre certificat (par exemple via certbot/Let's Encrypt). docs/self-hosting.md couvre ce qu'il faut proxyfier ; la configuration nginx de production propre à Relayium n'est pas publiée, il faudra écrire la vôtre.",
      },
      {
        q: "Quelles données mon serveur auto-hébergé stocke-t-il ?",
        a: "Une base SQLite (comptes, sessions) sous RELAYIUM_DB et, pour les transferts stockés/basés sur un lien, des blobs chiffrés sous RELAYIUM_BLOB_DIR que le serveur lui-même ne peut pas déchiffrer. Le serveur ne conserve aucun fichier ni corps de message en temps réel et ne fait que relayer la poignée de main de signalisation ; les appareils destinataires peuvent néanmoins garder les fichiers ou le texte.",
      },
    ],
  },
  cta: {
    text: "Installez la CLI Relayium gratuite et faites-la pointer vers votre propre serveur avec --server.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "الاستضافة الذاتية لـ Relayium: شغّل خادم نقل الملفات والنصوص الخاص بك",
  description:
    "شغّل حزمة Relayium بالكامل بنفسك بأمر Docker واحد — نطاقك الخاص، بياناتك الخاصة، بلا حساب لدى طرف ثالث. يغطّي اقتران الملفات والنصوص العابرة، ومفاتيح البيئة، ومُرحِّل TURN الاختياري للمتصفح، وتوجيه الـ CLI إليه.",
  updatedLabel: "آخر تحديث",
  lead: [
    "‏Relayium مرخَّص بموجب AGPL-3.0 ومفتوح المصدر، والخادم صورة واحدة مكتفية بذاتها — بلا قاعدة بيانات خارجية، بلا حاوية تخزين لطرف ثالث، ولا شيء للتسجيل فيه. إن كنت تفضّل تشغيل كل شيء بنفسك بدل الاعتماد على relayium.com، فهذا الدليل يشغّل خادمًا بـ Docker ويوجّه الـ CLI إليه.",
    "تمنحك الاستضافة الذاتية تحكمًا كاملًا في مكان بياناتك، ونطاقك الخاص وشهادة TLS خاصة بك، وبلا اعتماد على بنية أحد آخر. كل ما يلي مبني على ملفات موجودة فعلًا في المستودع — `docker-compose.yml` و`server/.env.example` و`docs/self-hosting.md` — فلا شيء هنا عبارة عن راية أو إعداد غير موجود فعلًا.",
  ],
  sections: [
    {
      heading: "لماذا الاستضافة الذاتية",
      body: [
        "عمليات النقل الفوري في Relayium مشفَّرة من الطرف إلى الطرف. قد يحمل مُرحِّل TURN المستضاف ذاتيًا بايتات مشفَّرة، ويعالج الخادم بيانات الإشارة الوصفية، لكن لا يمكن لأي منهما قراءة النص الصريح للملف أو فك تشفيره؛ ولا يخزّن الخادم أو المُرحِّل نسخة أو سجلًا على الخادم للمحتوى الفوري. ويحتفظ الخادم بحسابك، و — لعمليات النقل المُخزَّنة/المبنية على رابط — بكتل نص مُشفَّر وقاعدة بيانات SQLite صغيرة. الاستضافة الذاتية تعني أن تعيش تلك البيانات على بنية تتحكم فيها أنت، تحت نطاقك الخاص، دون أن تتدخل قرارات تشغيل أحد آخر.",
        "لأن المشروع مرخَّص بموجب AGPL-3.0 ومفتوح المصدر (github.com/relayium/relayium)، يمكنك أن تقرأ بالضبط ما يفعله الخادم قبل أن تأتمنه على أي شيء، وأن تنسخه (fork) أو تعدّله بحرية.",
      ],
    },
    {
      heading: "بداية سريعة مع Docker",
      body: [
        "جذر المستودع يوفّر `Dockerfile` و`docker-compose.yml` يبنيان صورة واحدة مكتفية بذاتها — ثنائي Go ساكن يقدّم تطبيق الويب المبني مسبقًا، فلا حاجة إلى Node منفصل أو سلسلة أدوات Go أو nginx لمجرد تشغيله:",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "هذا هو الخادم بالكامل، يستمع على ‎:8080. ضع nginx أو Caddy أمامه لأجل TLS في الإنتاج — يغطّي docs/self-hosting.md مسار Docker وما ينبغي توجيهه عبر البروكسي؛ تهيئة nginx الخاصة ببيئة إنتاج Relayium نفسها غير منشورة.",
        "تأتي تهيئة التطبيق من ملف server/.env اختياري إضافةً إلى كتلة environment: في docker-compose.yml. لكل إعداد مفتاح ‎RELAYIUM_*‎ — انسخ server/.env.example كنقطة انطلاق.",
        "المفاتيح الأربعة المهمة لنشر أساسي: RELAYIUM_ADDR (عنوان الاستماع)، وRELAYIUM_STATIC (مسار تطبيق الويب المبني)، وRELAYIUM_DB (مسار ملف SQLite)، وRELAYIUM_BLOB_DIR (حيث يُكتَب النص المُشفَّر لروابط التخزين). يضبط docker-compose.yml أصلًا قيمًا افتراضية معقولة للأربعة جميعًا ويحفظها في وحدة تخزين مُسمّاة.",
      ],
    },
    {
      heading: "أضف مُرحِّل TURN لعمليات النقل عبر الشبكات",
      body: [
        "عمليات النقل في الشبكة نفسها (LAN) وpush/pull القائم على SSH تعمل بلا أي إضافة. عمليات النقل الفوري عبر الشبكات (جهازان خلف NAT مختلفين) تحتاج أحيانًا مُرحِّل TURN لإنشاء مسار — لا يرى المُرحِّل سوى نص مُشفَّر أبدًا، لا محتوى ملفاتك.",
        "لدى docker-compose.yml ملف تعريف relay اختياري يُشغّل coturn (خادم TURN) ونسخة Redis صغيرة لقياس بايتات الترحيل، إلى جانب الخادم الرئيسي:",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "يحتاج coturn عنوان IP العام الحقيقي للمضيف ونطاق منافذ UDP مفتوحًا ليعمل — يغطّي docs/self-hosting.md التشغيل عبر ملف تعريف relay في Docker؛ تهيئة coturn الخاصة ببيئة إنتاج Relayium نفسها (بما في ذلك برنامج التثبيت) غير منشورة.",
        "بدون ‎--profile relay‎ وRELAYIUM_TURN_SECRET، يظل الخادم يعمل جيدًا — تتراجع عمليات النقل عبر الشبكات فقط إلى STUN وحده، وهو يعمل مع أنواع NAT الأسهل لكن ليس الأشد صرامة.",
      ],
    },
    {
      heading: "وجّه الـ CLI إلى خادمك",
      body: [
        "يستخدم Relayium CLI افتراضيًا خادم التعارف الخاص بـ relayium.com لعمليات send/receive وtext عبر الشبكات. مرّر ‎--server‎ لاستخدام خادمك بدلًا منه:",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "الـ CLI مجاني في كلتا الحالتين — ‎--server‎ يغيّر خادم التعارف فقط. يصدر send أو text بلا رمز رمزًا من ذلك الخادم، ويخزّن up السحابي تحت حساب عليه، لذا سجّل الدخول أولًا بـ ‎relayium login --server https://your-domain‎. أما receive وdown وtext مع الرمز المطبوع فلا تحتاج إلى تسجيل دخول.",
        "يجب أن يبقى طرفا text متصلين معًا. تستخدم الرسائل جلسة P2P مباشرة مستقلة ومشفّرة من الطرف إلى الطرف. text في CLI مباشر فقط ولا يستخدم مُرحِّل TURN الخاص بتطبيق الويب. لا تخزّن Relayium ولا خادمك المستضاف ذاتيًا متون الرسائل أو سجلًا على الخادم، لكن يمكن لأي طرفية أو مستلم نسخ النص أو الاحتفاظ به بعد استلامه.",
        "‏push/pull (عبر SSH الخاص بك) وserve + دفع daemon direct عبر push relayium://host لا يلمسان relayium.com إطلاقًا، سواء بالاستضافة الذاتية أم لا — يتصلان مباشرةً بالجهاز البعيد الذي تحدده.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل أحتاج إلى إعداد TURN؟",
        a: "فقط إن أردت أن تعمل عمليات النقل الفوري عبر الشبكات عبر أنواع NAT الصارمة. عمليات النقل في الشبكة نفسها، وpush/pull القائم على SSH، وdaemon direct، جميعها تعمل بدونه — TURN مخصّص بحتًا لاجتياز NAT على مسار رمز الاقتران عبر الشبكات.",
      },
      {
        q: "هل يبقى الـ CLI مجانيًا إن استضفتُ ذاتيًا؟",
        a: "نعم. يبقى الـ CLI مجانيًا مع relayium.com أو خادمك. يحتاج send أو text بلا رمز إلى حساب على الخادم المستهدف لإصدار رمز، ويحتاجه up لتخزين ملف. أما receive وdown وtext مع الرمز المطبوع فلا تحتاج إلى تسجيل دخول.",
      },
      {
        q: "هل يمكنني استخدام نطاقي الخاص وشهادة TLS خاصة بي؟",
        a: "نعم. تستمع صورة Docker على HTTP عادي على ‎:8080؛ ضع nginx أو Caddy أمامها بنطاقك الخاص وشهادتك (مثلًا عبر certbot/Let's Encrypt). يغطّي docs/self-hosting.md ما ينبغي توجيهه عبر البروكسي؛ تهيئة nginx الخاصة ببيئة إنتاج Relayium نفسها غير منشورة، لذا عليك كتابة تهيئتك الخاصة.",
      },
      {
        q: "ما البيانات التي يخزّنها خادمي المُستضاف ذاتيًا؟",
        a: "قاعدة بيانات SQLite (الحسابات، الجلسات) في RELAYIUM_DB، و — لعمليات النقل المُخزَّنة/المبنية على رابط — كتل مشفَّرة في RELAYIUM_BLOB_DIR لا يستطيع الخادم نفسه فكّ تشفيرها. لا يحفظ الخادم ملفات النقل الفوري أو أجسام الرسائل، بل يرحّل مصافحة الإشارة فقط؛ ويمكن للطرف المستلم حفظ الملفات أو الاحتفاظ بالنص.",
      },
    ],
  },
  cta: {
    text: "ثبّت Relayium CLI المجاني ووجّهه إلى خادمك الخاص بـ ‎--server‎.",
    button: "احصل على الـ CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Aloja Relayium por tu cuenta: ejecuta tu servidor de transferencia de archivos y texto",
  description:
    "Ejecuta toda la pila de Relayium por tu cuenta con un solo comando de Docker — tu propio dominio, tus propios datos, sin cuenta de terceros. Cubre el emparejamiento de archivos y texto efímero, las claves de entorno, el retransmisor TURN opcional del navegador y cómo apuntar la CLI hacia él.",
  updatedLabel: "Última actualización",
  lead: [
    "Relayium tiene licencia AGPL-3.0 y es de código abierto, y el servidor es una única imagen autocontenida — sin base de datos externa, sin bucket de almacenamiento de terceros, nada para lo que registrarse. Si prefieres ejecutarlo todo por tu cuenta en vez de depender de relayium.com, esta guía levanta un servidor con Docker y apunta la CLI hacia él.",
    "Autoalojar te da control total sobre dónde viven tus datos, tu propio dominio y certificado TLS, y ninguna dependencia de la infraestructura de nadie más. Todo lo que sigue se basa en los archivos que se distribuyen en el repositorio — `docker-compose.yml`, `server/.env.example` y `docs/self-hosting.md` — así que nada de lo que hay aquí es un indicador o ajuste que no exista de verdad.",
  ],
  sections: [
    {
      heading: "Por qué autoalojar",
      body: [
        "Las transferencias en tiempo real de Relayium están cifradas de extremo a extremo. Un retransmisor TURN autoalojado puede transportar bytes cifrados y el servidor procesa metadatos de señalización, pero ninguno puede leer ni descifrar el texto en claro de los archivos; ni el servidor ni el retransmisor guardan una copia o historial del contenido en tiempo real en el servidor. El servidor sí guarda tu cuenta y — para las transferencias almacenadas/basadas en enlace — blobs de texto cifrado y una pequeña base de datos SQLite. Autoalojar significa que esos datos viven en infraestructura que tú controlas, bajo tu propio dominio, sin las decisiones operativas de nadie más de por medio.",
        "Como el proyecto tiene licencia AGPL-3.0 y es de código abierto (github.com/relayium/relayium), puedes leer exactamente qué hace el servidor antes de confiarle nada, y bifurcarlo o modificarlo libremente.",
      ],
    },
    {
      heading: "Inicio rápido con Docker",
      body: [
        "La raíz del repositorio incluye un `Dockerfile` y un `docker-compose.yml` que construyen una única imagen autocontenida — un binario Go estático que sirve la aplicación web precompilada, así que no hace falta un Node, una cadena de herramientas Go ni nginx aparte solo para ejecutarlo:",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "Ese es el servidor entero, escuchando en :8080. Pon nginx o Caddy delante para el TLS en producción — docs/self-hosting.md cubre la vía Docker y qué hay que redirigir (proxy); la configuración nginx de producción propia de Relayium no está publicada.",
        "La configuración de la aplicación viene de un archivo server/.env opcional más el bloque environment: en docker-compose.yml. Cada ajuste tiene una clave RELAYIUM_* — copia server/.env.example como punto de partida.",
        "Las cuatro claves que importan para un despliegue básico: RELAYIUM_ADDR (dirección de escucha), RELAYIUM_STATIC (ruta a la aplicación web compilada), RELAYIUM_DB (ruta del archivo SQLite) y RELAYIUM_BLOB_DIR (dónde se escribe el texto cifrado de los enlaces almacenados). docker-compose.yml ya fija valores por defecto sensatos para las cuatro y las persiste en un volumen con nombre.",
      ],
    },
    {
      heading: "Añade un retransmisor TURN para las transferencias entre redes",
      body: [
        "Las transferencias en la misma red (red local) y el push/pull basado en SSH funcionan sin nada extra. Las transferencias en tiempo real entre redes (dos dispositivos tras NAT distintos) a veces necesitan un retransmisor TURN para establecer una ruta — el retransmisor solo ve texto cifrado, nunca el contenido de tus archivos.",
        "docker-compose.yml tiene un perfil relay opcional que arranca coturn (el servidor TURN) y una pequeña instancia de Redis para la medición de bytes retransmitidos, junto al servidor principal:",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "coturn necesita la IP pública real del host y un rango de puertos UDP abierto para funcionar — docs/self-hosting.md cubre cómo levantarlo con el perfil relay de Docker; la configuración coturn de producción propia de Relayium (incluido su script de instalación) no está publicada.",
        "Sin --profile relay ni RELAYIUM_TURN_SECRET, el servidor igual funciona bien — las transferencias entre redes simplemente recurren a solo STUN, que funciona para los tipos de NAT más fáciles pero no para los más estrictos.",
      ],
    },
    {
      heading: "Apunta la CLI hacia tu servidor",
      body: [
        "La CLI de Relayium usa por defecto el servidor de punto de encuentro de relayium.com para send/receive y text entre redes. Pasa --server para usar el tuyo en su lugar:",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "La CLI es gratis en cualquier caso — --server solo cambia el servidor de punto de encuentro. send o text sin código generan uno allí, y up guarda bajo una cuenta en ese servidor, así que inicia sesión primero con relayium login --server https://your-domain. receive, down y text con el código impreso no necesitan iniciar sesión.",
        "Ambos extremos de text deben permanecer en línea. Los mensajes usan su propia sesión P2P directa cifrada de extremo a extremo. text en la CLI es solo directo y no usa el relé TURN de la app web. Ni Relayium ni tu servidor autoalojado guardan el cuerpo de los mensajes ni un historial del servidor, pero cualquiera de los terminales o el destinatario puede copiar o conservar el texto después de recibirlo.",
        "push/pull (por tu propio SSH) y serve + el push daemon directo relayium://host no tocan relayium.com en absoluto, te autoalojes o no — se conectan directamente al remoto que indiques.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Necesito configurar TURN?",
        a: "Solo si quieres que las transferencias en tiempo real entre redes funcionen a través de NAT estrictos. Las transferencias en la misma red, el push/pull basado en SSH y el daemon directo funcionan todos sin él — TURN sirve puramente para el recorrido de NAT en la ruta del código de emparejamiento entre redes.",
      },
      {
        q: "¿La CLI sigue siendo gratis si me autoalojo?",
        a: "Sí. La CLI sigue siendo gratis con relayium.com o con tu servidor. send o text sin código necesitan una cuenta en el servidor de destino para generar uno, y up la necesita para guardar un archivo. receive, down y text con el código impreso no requieren iniciar sesión.",
      },
      {
        q: "¿Puedo usar mi propio dominio y certificado TLS?",
        a: "Sí. La imagen de Docker escucha en HTTP simple en :8080; pon nginx o Caddy delante con tu propio dominio y certificado (por ejemplo, vía certbot/Let's Encrypt). docs/self-hosting.md cubre qué hay que redirigir; la configuración nginx de producción propia de Relayium no está publicada, así que tendrás que escribir la tuya.",
      },
      {
        q: "¿Qué datos almacena mi servidor autoalojado?",
        a: "Una base de datos SQLite (cuentas, sesiones) en RELAYIUM_DB y, para las transferencias almacenadas/basadas en enlace, blobs cifrados en RELAYIUM_BLOB_DIR que el propio servidor no puede descifrar. El servidor no guarda archivos en tiempo real ni cuerpos de mensajes y solo retransmite el handshake de señalización; los dispositivos receptores sí pueden conservar archivos o texto.",
      },
    ],
  },
  cta: {
    text: "Instala la CLI gratuita de Relayium y apúntala hacia tu propio servidor con --server.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Hospede o Relayium por conta própria: rode seu servidor de transferência de arquivos e texto",
  description:
    "Rode toda a pilha do Relayium por conta própria com um único comando Docker — seu próprio domínio, seus próprios dados, sem conta de terceiros. Cobre o emparelhamento de arquivos e texto efêmero, as chaves de ambiente, o retransmissor TURN opcional do navegador e como apontar a CLI para ele.",
  updatedLabel: "Última atualização",
  lead: [
    "O Relayium tem licença AGPL-3.0 e é de código aberto, e o servidor é uma única imagem autocontida — sem banco de dados externo, sem bucket de armazenamento de terceiros, nada para se cadastrar. Se você prefere rodar tudo por conta própria em vez de depender do relayium.com, este guia coloca um servidor no ar com Docker e aponta a CLI para ele.",
    "Auto-hospedar dá a você controle total sobre onde seus dados ficam, seu próprio domínio e certificado TLS, e nenhuma dependência da infraestrutura de mais ninguém. Tudo a seguir se baseia nos arquivos que acompanham o repositório — `docker-compose.yml`, `server/.env.example` e `docs/self-hosting.md` — então nada aqui é uma flag ou configuração que não exista de verdade.",
  ],
  sections: [
    {
      heading: "Por que auto-hospedar",
      body: [
        "As transferências em tempo real do Relayium têm criptografia de ponta a ponta. Um retransmissor TURN auto-hospedado pode transportar bytes cifrados e o servidor processa metadados de sinalização, mas nenhum deles pode ler ou descriptografar o texto simples dos arquivos; nem o servidor nem o retransmissor armazenam uma cópia ou histórico do conteúdo em tempo real no servidor. O servidor guarda sua conta e — para transferências armazenadas/baseadas em link — blobs de texto cifrado e um pequeno banco de dados SQLite. Auto-hospedar significa que esses dados ficam em infraestrutura que você controla, sob seu próprio domínio, sem as decisões operacionais de mais ninguém envolvidas.",
        "Como o projeto tem licença AGPL-3.0 e é de código aberto (github.com/relayium/relayium), você pode ler exatamente o que o servidor faz antes de confiar qualquer coisa a ele, e fazer fork ou modificá-lo livremente.",
      ],
    },
    {
      heading: "Início rápido com Docker",
      body: [
        "A raiz do repositório traz um `Dockerfile` e um `docker-compose.yml` que constroem uma única imagem autocontida — um binário Go estático que serve o aplicativo web pré-compilado, então não é preciso um Node, uma cadeia de ferramentas Go ou nginx separados só para executá-lo:",
      ],
      code: ["docker compose up -d --build"],
      bullets: [
        "Esse é o servidor inteiro, escutando em :8080. Coloque nginx ou Caddy na frente para o TLS em produção — docs/self-hosting.md cobre o caminho Docker e o que precisa ser redirecionado (proxy); a configuração nginx de produção da própria Relayium não é publicada.",
        "A configuração do aplicativo vem de um arquivo server/.env opcional mais o bloco environment: no docker-compose.yml. Cada configuração tem uma chave RELAYIUM_* — copie server/.env.example como ponto de partida.",
        "As quatro chaves que importam para uma implantação básica: RELAYIUM_ADDR (endereço de escuta), RELAYIUM_STATIC (caminho para o aplicativo web compilado), RELAYIUM_DB (caminho do arquivo SQLite) e RELAYIUM_BLOB_DIR (onde o texto cifrado dos links armazenados é escrito). O docker-compose.yml já define valores padrão sensatos para as quatro e as persiste em um volume nomeado.",
      ],
    },
    {
      heading: "Adicione um retransmissor TURN para transferências entre redes",
      body: [
        "Transferências na mesma rede (rede local) e o push/pull baseado em SSH funcionam sem nada a mais. Transferências em tempo real entre redes (dois dispositivos atrás de NATs diferentes) às vezes precisam de um retransmissor TURN para estabelecer um caminho — o retransmissor só vê texto cifrado, nunca o conteúdo dos seus arquivos.",
        "O docker-compose.yml tem um perfil relay opcional que inicia o coturn (o servidor TURN) e uma pequena instância Redis para a medição de bytes retransmitidos, ao lado do servidor principal:",
      ],
      code: [
        "RELAYIUM_TURN_SECRET=$(openssl rand -hex 32) docker compose --profile relay up -d --build",
      ],
      bullets: [
        "O coturn precisa do IP público real do host e de uma faixa de portas UDP aberta para funcionar — docs/self-hosting.md cobre como executá-lo com o perfil relay do Docker; a configuração coturn de produção da própria Relayium (incluindo o script de instalação) não é publicada.",
        "Sem --profile relay e RELAYIUM_TURN_SECRET, o servidor ainda funciona bem — as transferências entre redes apenas recorrem a só STUN, que funciona para os tipos de NAT mais fáceis, mas não para os mais rígidos.",
      ],
    },
    {
      heading: "Aponte a CLI para o seu servidor",
      body: [
        "A CLI do Relayium usa por padrão o servidor de encontro do relayium.com para send/receive e text entre redes. Passe --server para usar o seu em vez dele:",
      ],
      code: [
        "relayium send ./report.pdf --server https://your-domain",
        "relayium receive 483920 --server https://your-domain",
        "relayium text --server https://your-domain",
        "relayium text 483920 --server https://your-domain",
      ],
      bullets: [
        "A CLI é gratuita em qualquer dos casos — --server apenas muda o servidor de encontro. send ou text sem código geram um código nele, e up guarda sob uma conta nesse servidor, então entre primeiro com relayium login --server https://your-domain. receive, down e text com o código impresso não precisam de login.",
        "As duas pontas de text precisam permanecer online. As mensagens usam uma sessão P2P direta própria, criptografada de ponta a ponta. text na CLI é apenas direto e não usa o retransmissor TURN do app web. Nem o Relayium nem o servidor auto-hospedado armazenam o corpo das mensagens ou um histórico no servidor, mas qualquer terminal ou destinatário pode copiar ou guardar o texto depois de recebê-lo.",
        "push/pull (pelo seu próprio SSH) e serve + o push daemon direto relayium://host não tocam o relayium.com em nada, com ou sem auto-hospedagem — eles se conectam diretamente ao remoto que você especificar.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Preciso configurar o TURN?",
        a: "Só se você quiser que as transferências em tempo real entre redes funcionem através de NATs rígidos. Transferências na mesma rede, o push/pull baseado em SSH e o daemon direto funcionam todos sem ele — o TURN serve puramente para a travessia de NAT no caminho do código de emparelhamento entre redes.",
      },
      {
        q: "A CLI continua gratuita se eu auto-hospedar?",
        a: "Sim. A CLI continua gratuita com relayium.com ou com o seu servidor. send ou text sem código precisam de uma conta no servidor de destino para gerar um, e up precisa dela para guardar um arquivo. receive, down e text com o código impresso não exigem login.",
      },
      {
        q: "Posso usar meu próprio domínio e certificado TLS?",
        a: "Sim. A imagem Docker escuta em HTTP simples na :8080; coloque nginx ou Caddy na frente com seu próprio domínio e certificado (por exemplo, via certbot/Let's Encrypt). docs/self-hosting.md cobre o que precisa ser redirecionado; a configuração nginx de produção da própria Relayium não é publicada, então você vai escrever a sua.",
      },
      {
        q: "Quais dados o meu servidor auto-hospedado armazena?",
        a: "Um banco de dados SQLite (contas, sessões) em RELAYIUM_DB e, para transferências armazenadas/baseadas em link, blobs criptografados em RELAYIUM_BLOB_DIR que o próprio servidor não consegue descriptografar. O servidor não guarda arquivos em tempo real nem corpos de mensagens e apenas retransmite o handshake de sinalização; os destinatários ainda podem salvar arquivos ou reter texto.",
      },
    ],
  },
  cta: {
    text: "Instale a CLI gratuita do Relayium e aponte-a para o seu próprio servidor com --server.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/self-host-relayium",
  published: "2026-07-09",
  updated: "2026-07-31",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }, selfHostInstall),
};
