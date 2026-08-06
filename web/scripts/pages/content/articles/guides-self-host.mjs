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
    "Self-hosting gives you full control over where your data lives, your own domain and TLS certificate, and no dependency on anyone else's infrastructure. Everything below is grounded in the files that ship in the repo — docker-compose.yml, server/.env.example, and docs/self-hosting.md — so nothing here is a flag or setting that doesn't actually exist.",
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
      prereqs: {
        label: "What you need before step 1",
        items: [
          "A host with Docker Engine and the Compose plugin. docker compose version prints a version string; \"docker: 'compose' is not a docker command\" means the plugin is missing.",
          "A clone of the repository. The compose file builds the image from this source tree, so it needs the Dockerfile and web/ beside it — there is no prebuilt image to pull.",
          "Disk for the named volume relayium-data: the SQLite database plus any stored-transfer ciphertext you keep.",
          "A domain and a TLS-terminating reverse proxy if anyone but you will use it. The container speaks plain HTTP and publishes on the loopback interface only.",
          "Nothing else. No external database, no object-storage bucket, no third-party account.",
        ],
      },
      body: [
        "The repo root ships a Dockerfile and a docker-compose.yml that build one self-contained image — a static Go binary that serves the prebuilt web app, so there is no separate Node, Go toolchain, or nginx required just to run it.",
      ],
      steps: [
        {
          text: "Clone the repository and change into it.",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "Build and start it. The placeholder secret is required even though the relay is off: Compose validates the gated coturn service's required variable while it parses the file, so a bare docker compose up refuses to start.",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "Confirm the container stayed up rather than crash-looping.",
          code: ["docker compose ps"],
        },
        {
          text: "Ask the instance whether it can actually serve. Use /readyz, not /healthz — the difference between them is the whole point of the check, and the expected-result box below spells it out.",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "Copy the config template and set your public URL. RELAYIUM_BASE_URL builds the links in outgoing email and decides whether session cookies carry the Secure flag, so it has to be your real https:// address.",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "Put nginx or Caddy in front, terminating TLS for your domain and proxying everything — /, /api, /ws, /admin — to port 8080. Then restart to pick up server/.env.",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "What a working instance looks like",
        body: [
          "The container reports Up, and both endpoints answer. ready is the one that matters: /healthz returns ok unconditionally, before anything is opened, so it also passes on an instance whose database or blob directory is unusable. /readyz pings the SQLite database and the blob directory and answers 503 when either is broken.",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "docker-compose.yml has an optional relay profile that starts coturn (the TURN server) and a small Redis instance for relay-byte metering, alongside the main server.",
        "The secret has to reach two different places, and getting that wrong fails silently. coturn receives it through Compose variable interpolation, which resolves from the shell or a project-root .env. The server reads it from its own environment, which means server/.env — and an empty secret disables TURN outright. Set only one of them and you get a running coturn the server never issues credentials for: every container reports healthy, nothing is logged, and strict-NAT transfers keep failing exactly as they did before.",
      ],
      steps: [
        {
          text: "Generate one long random secret. Use the same value everywhere below.",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "Put that secret, and the relay addresses your domain resolves to, in server/.env so the server enables TURN at all.",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "Export that same file into the shell so Compose's interpolation can hand coturn the identical secret. Sourcing it keeps one source of truth and keeps the secret off the command line, where ps would expose it.",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "Start the stack with the relay profile.",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "Open the relay ports on the host firewall. coturn runs with host networking, so these are host rules, not Docker ones: UDP 3478 and 49152-65535, TCP 3478 and 5349.",
        },
        {
          text: "Confirm the server — not just coturn — came up holding the secret. This is the check that catches the silent case.",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "What a working relay looks like",
        body: [
          "Both keys come back non-empty from inside the server container. coturn being up tells you nothing on its own — the browser only ever gets relay credentials the server minted.",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
      bullets: [
        "coturn needs the host's real public IP and an open UDP port range to work — docs/self-hosting.md covers running it through the Docker relay profile above; Relayium's own production coturn configuration (and install script) isn't published.",
        "Without --profile relay and RELAYIUM_TURN_SECRET, the server still runs fine — cross-network transfers just fall back to STUN-only, which works for easier NAT types but not the strictest ones.",
      ],
    },
    {
      heading: "Point the CLI at your server",
      body: [
        "The Relayium CLI defaults to relayium.com's rendezvous server for cross-network send/receive and text. Pass --server to use your own instead.",
      ],
      steps: [
        {
          text: "Sign in against your server rather than relayium.com, on a machine that already has the CLI from the section above. It prints a URL and a code; approve it in a browser signed in to your instance.",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "Confirm which server the stored credentials are bound to. whoami takes no flags — it reports what the login actually wrote, which is what makes it worth running.",
          code: ["relayium whoami"],
        },
        {
          text: "Send, passing the same --server. Without it the CLI mints the pairing code against relayium.com and the other end will never find it on your instance.",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "Receive on the other machine with the printed code and the same --server. Text sessions work the same way.",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "How you know it is talking to your instance",
        body: [
          "whoami prints the account followed by the server it is bound to, in parentheses. Your own domain there — not relayium.com — is the confirmation.",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "The CLI is free either way — --server changes which rendezvous server it talks to for the pairing-code handshake. send or text without a code mints one against that server, and cloud up stores under an account on it, so sign in there first with relayium login --server https://your-domain. receive, down, and text with the printed code need no login.",
        "Both text peers must stay online. Messages use their own end-to-end encrypted, direct peer-to-peer session; CLI text is direct-only and does not use the browser's TURN relay. Neither Relayium nor your self-hosted server stores message bodies or server-side history, but either terminal or recipient can copy or retain text after receiving it.",
        "push/pull (over your own SSH) and serve + daemon-direct push relayium://host don't touch relayium.com at all, self-hosted or not — they connect straight to the remote you specify.",
      ],
    },
    {
      heading: "When it doesn't work",
      body: [
        "Five failures cover nearly every unsuccessful self-host. Each has a line you can read or a command you can run that decides it, and three of the five look like success until you run the check.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "docker compose up refuses to start at all, before anything is built.",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "Compose interpolates the whole file before it filters by profile, so the gated coturn service's required variable is validated even though the relay is off. Prefix any placeholder — RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build — and replace it with a real secret only when you actually enable the relay profile.",
          },
          {
            symptom: "The container is Up, but a browser on another machine cannot reach it.",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "That loopback bind is the default, so a public host does not expose plaintext HTTP to the internet. For production, leave it and terminate TLS in a reverse proxy on the same host. For a LAN-only box with no proxy, publish it wider with RELAYIUM_BIND=0.0.0.0 docker compose up -d — that variable is read by compose, not by the server.",
          },
          {
            symptom: "/healthz says ok, but sign-up fails and stored links never appear.",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "/healthz answers ok unconditionally and proves only that the process is listening. /readyz pings the SQLite database and the blob directory, so a 503 means one of them is unusable — check that the relayium-data volume is mounted and that RELAYIUM_DB and RELAYIUM_BLOB_DIR point inside it.",
          },
          {
            symptom: "relayium login prints a verification URL on localhost that you cannot open.",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "The server builds that URL from RELAYIUM_BASE_URL, which defaults to http://localhost:8080. Set it in server/.env to your real https:// address and restart. It also decides whether session cookies carry the Secure flag, so leaving it wrong is not only cosmetic.",
          },
          {
            symptom: "coturn is running, but cross-network transfers through strict NAT still fail — with nothing logged.",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# (no output)`,
            ],
            fix: "The secret reached coturn through Compose interpolation but never reached the server, whose empty secret disables TURN outright. Put RELAYIUM_TURN_SECRET and RELAYIUM_TURN_URLS in server/.env, source it with set -a; . ./server/.env; set +a so interpolation sees the same value, and restart the relay profile. Both keys must come back non-empty from that check.",
          },
        ],
      },
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
      prereqs: {
        label: "开始之前你需要什么",
        items: [
          "一台装了 Docker Engine 和 Compose 插件的主机。docker compose version 会打印版本号；如果提示 “docker: 'compose' is not a docker command”，说明插件没装。",
          "一份仓库克隆。compose 文件是从这份源码构建镜像的，因此它需要旁边的 Dockerfile 和 web/ 目录——没有现成镜像可以直接拉取。",
          "给具名卷 relayium-data 准备的磁盘空间：SQLite 数据库，加上你保留的存储型传输密文。",
          "如果除你之外还有别人要用，就需要一个域名和一层负责终止 TLS 的反向代理。容器只讲明文 HTTP，而且默认只发布在回环接口上。",
          "除此之外别无所需。不需要外部数据库，不需要对象存储桶，也不需要任何第三方账号。",
        ],
      },
      body: [
        "仓库根目录提供了一个 Dockerfile 和一个 docker-compose.yml，它们会构建出一个自包含的镜像——一个静态 Go 二进制文件，同时提供预构建好的 Web 应用，因此仅仅为了运行它，你不需要单独的 Node、Go 工具链或 nginx。",
      ],
      steps: [
        {
          text: "克隆仓库并进入目录。",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "构建并启动。即使中继是关着的，这个占位密钥也不能省：Compose 在解析文件时就会校验被 profile 关掉的 coturn 服务所需的变量，所以直接跑 docker compose up 会被拒绝。",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "确认容器是真的起来了，而不是在反复崩溃重启。",
          code: ["docker compose ps"],
        },
        {
          text: "问这个实例它到底能不能提供服务。用 /readyz，不要用 /healthz——这两者的区别正是这一步的意义所在，下面的预期结果框里说明了原因。",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "复制配置模板并设置你的公开地址。RELAYIUM_BASE_URL 决定了外发邮件里链接的样子，也决定了会话 Cookie 是否带 Secure 标志，所以它必须是你真实的 https:// 地址。",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "在前面放一层 nginx 或 Caddy，为你的域名终止 TLS，并把所有路径——/、/api、/ws、/admin——反代到 8080 端口。然后重启，让 server/.env 生效。",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "一个正常实例长什么样",
        body: [
          "容器状态为 Up，两个端点都能应答。真正说明问题的是 ready：/healthz 无条件返回 ok，在任何东西打开之前就会通过，所以一个数据库或数据块目录已经不可用的实例同样能骗过它。/readyz 会去 ping SQLite 数据库和数据块目录，任一出问题就返回 503。",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "docker-compose.yml 里有一个可选的 relay profile，会在启动主服务器的同时启动 coturn（TURN 服务器）和一个用于中继流量计量的小型 Redis 实例。",
        "这个密钥必须送到两个不同的地方，而送错了是不会报错的。coturn 通过 Compose 的变量插值拿到它，插值只从 shell 或项目根目录的 .env 解析。服务端则是从它自己的环境变量里读——也就是 server/.env——而密钥为空就等于彻底关闭 TURN。只设其中一处，你就会得到一个正在运行、服务端却从不为它签发凭据的 coturn：每个容器都报告健康，日志里什么都没有，跨严格 NAT 的传输和加中继之前一样失败。",
      ],
      steps: [
        {
          text: "生成一个足够长的随机密钥。下面所有地方都用同一个值。",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "把这个密钥，以及你的域名解析到的中继地址，写进 server/.env，服务端才会真正启用 TURN。",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "把同一个文件源进 shell，好让 Compose 的插值把完全相同的密钥交给 coturn。用 source 的方式既保持了单一来源，也让密钥不会出现在命令行上被 ps 看见。",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "带上 relay profile 启动整套服务。",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "在主机防火墙上放行中继端口。coturn 用的是 host 网络模式，所以这些是主机规则而不是 Docker 规则：UDP 3478 与 49152-65535，TCP 3478 与 5349。",
        },
        {
          text: "确认拿到密钥的是服务端，而不只是 coturn。这条检查专门用来抓那个不出声的失败。",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "一个正常的中继长什么样",
        body: [
          "从服务端容器内部查，两个变量都非空。coturn 起来了本身说明不了任何事——浏览器拿到的中继凭据只可能由服务端签发。",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
      bullets: [
        "coturn 需要主机真实的公网 IP，以及一段开放的 UDP 端口范围才能工作——docs/self-hosting.md 说明了通过 Docker 的 relay profile 运行它；Relayium 自己生产环境用的 coturn 配置（以及安装脚本）并未公开。",
        "如果不加 --profile relay 和 RELAYIUM_TURN_SECRET，服务器依然能正常运行——只是跨网络传输会退化为纯 STUN，这对较宽松的 NAT 类型没问题，但对最严格的类型不行。",
      ],
    },
    {
      heading: "让 CLI 指向你的服务器",
      body: [
        "Relayium CLI 默认使用 relayium.com 的会合服务器来完成跨网络的 send/receive 与 text。传入 --server 即可改用你自己的服务器。",
      ],
      steps: [
        {
          text: "在上一节已经装好 CLI 的机器上，登录到你自己的服务器而不是 relayium.com。它会打印一个网址和一个码；在已登录你实例的浏览器里批准它。",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "确认已保存的凭据绑定的是哪台服务器。whoami 不接受任何参数——它汇报的是登录实际写下的内容，这正是它值得一跑的原因。",
          code: ["relayium whoami"],
        },
        {
          text: "发送时带上同一个 --server。不带的话，CLI 会在 relayium.com 上生成配对码，另一端在你的实例上永远找不到它。",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "在另一台机器上，用打印出来的配对码和同一个 --server 接收。文本会话的用法完全一样。",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "怎么确认它连的是你自己的实例",
        body: [
          "whoami 会打印账号，后面括号里跟着它绑定的服务器。那里出现的是你自己的域名而不是 relayium.com，就是确认。",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "无论用哪个服务器，CLI 都是免费的——--server 只是改变了配对码握手所连接的会合服务器。send 或 text 不带码运行时会在该服务器生成配对码，云端 up 也存到那台服务器上的账号下，所以要先用 relayium login --server https://your-domain 在那边登录；receive、down，以及使用打印配对码加入的 text 都无需登录。",
        "text 两端必须同时在线。消息使用独立的端到端加密 P2P 直连会话；CLI text 只支持直连，不使用网页版的 TURN 中继。Relayium 和你的自托管服务器都不保存消息正文或服务端历史，但任一终端或接收方都可以在收到文本后复制或留存。",
        "push/pull（走你自己的 SSH）以及 serve + daemon 直连的 push relayium://host，无论是否自托管都完全不会接触 relayium.com——它们直接连到你指定的远程地址。",
      ],
    },
    {
      heading: "出问题时怎么办",
      body: [
        "几乎所有失败的自托管都逃不出这五种。每一种都有一行可以读的输出或一条可以跑的命令来判定，而其中三种在你跑那条检查之前，看起来都像是成功了。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "docker compose up 直接拒绝启动，什么都还没开始构建。",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "Compose 会先对整个文件做插值，然后才按 profile 过滤，所以被关掉的 coturn 服务所需的变量照样会被校验，即便中继根本没启用。前面加任意占位值即可——RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build——等你真正启用 relay profile 时再把它换成真正的密钥。",
          },
          {
            symptom: "容器状态是 Up，但另一台机器上的浏览器访问不到。",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "绑定到回环是默认行为，这样公网主机才不会把明文 HTTP 直接暴露到互联网上。生产环境请保持这个默认，并在同一台主机上用反向代理终止 TLS。如果是没有反代的纯局域网机器，用 RELAYIUM_BIND=0.0.0.0 docker compose up -d 把它发布得更宽——这个变量由 compose 读取，服务端本身并不认识它。",
          },
          {
            symptom: "/healthz 返回 ok，但注册失败，存储型链接也一直出不来。",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "/healthz 无条件返回 ok，只能证明进程在监听。/readyz 会去 ping SQLite 数据库和数据块目录，所以 503 意味着其中之一不可用——检查 relayium-data 卷是否挂上了，以及 RELAYIUM_DB 和 RELAYIUM_BLOB_DIR 是否指向卷里面。",
          },
          {
            symptom: "relayium login 打印出的验证网址在 localhost 上，你根本打不开。",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "那个网址是服务端用 RELAYIUM_BASE_URL 拼出来的，而它的默认值就是 http://localhost:8080。在 server/.env 里把它设成你真实的 https:// 地址再重启。它同时决定会话 Cookie 是否带 Secure 标志，所以设错了不只是难看的问题。",
          },
          {
            symptom: "coturn 在跑，但跨严格 NAT 的传输依然失败——而且日志里什么都没有。",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# 没有任何输出`,
            ],
            fix: "密钥通过 Compose 插值到了 coturn，却从来没到过服务端，而服务端密钥为空就等于彻底关闭 TURN。把 RELAYIUM_TURN_SECRET 和 RELAYIUM_TURN_URLS 写进 server/.env，用 set -a; . ./server/.env; set +a 源进 shell 让插值看到同一个值，然后重启 relay profile。那条检查必须两个变量都非空才算过。",
          },
        ],
      },
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
        "リポジトリのルートには Dockerfile と docker-compose.yml があり、これらは1つの自己完結型イメージ——事前ビルド済みの Web アプリを配信する静的 Go バイナリ——をビルドします。実行するためだけに別途 Node、Go ツールチェーン、nginx は不要です。",
      ],
      prereqs: {
        label: "手順1の前に必要なもの",
        items: [
          "Docker Engine と Compose プラグインが入ったホスト。docker compose version はバージョン文字列を表示します。「docker: 'compose' is not a docker command」と出る場合はプラグインが入っていません。",
          "リポジトリのクローン。compose ファイルはこのソースツリーからイメージをビルドするため、隣に Dockerfile と web/ が必要です——取得できる事前ビルド済みイメージはありません。",
          "名前付きボリューム relayium-data 用のディスク容量。SQLite データベースと、保持する保存型転送の暗号文が入ります。",
          "自分以外も使うなら、ドメインと TLS を終端するリバースプロキシ。コンテナは平文 HTTP しか話さず、既定ではループバックインターフェースにしか公開されません。",
          "必要なものはこれだけです。外部データベースも、オブジェクトストレージのバケットも、第三者のアカウントも要りません。",
        ],
      },
      steps: [
        {
          text: "リポジトリをクローンして、そのディレクトリに移動します。",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "ビルドして起動します。リレーが無効でもこのプレースホルダーの秘密鍵は省けません。Compose はファイルを解析する時点で、プロファイルによって無効化されている coturn サービスの必須変数まで検証するため、素の docker compose up は拒否されます。",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "コンテナが再起動を繰り返さずに立ち上がったままか確認します。",
          code: ["docker compose ps"],
        },
        {
          text: "このインスタンスが実際に応答できる状態かを尋ねます。/healthz ではなく /readyz を使ってください——両者の違いこそがこの確認の要点で、下の期待結果ボックスがその理由を説明します。",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "設定テンプレートをコピーし、公開 URL を設定します。RELAYIUM_BASE_URL は送信メール内のリンクを組み立て、セッション Cookie に Secure フラグを付けるかどうかも決めるため、実際の https:// アドレスである必要があります。",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "前段に nginx か Caddy を置き、自分のドメインで TLS を終端して、すべてのパス——/、/api、/ws、/admin——を 8080 番ポートへプロキシします。その後、server/.env を反映させるために再起動します。",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "正常なインスタンスの見え方",
        body: [
          "コンテナが Up となり、両方のエンドポイントが応答します。意味を持つのは ready のほうです。/healthz は何も開かれる前に無条件で ok を返すため、データベースやブロブディレクトリが使えないインスタンスでも通ってしまいます。/readyz は SQLite データベースとブロブディレクトリに ping を送り、どちらかが壊れていれば 503 を返します。",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "docker-compose.yml には任意の relay プロファイルがあり、メインサーバーと合わせて coturn（TURN サーバー）と、リレーバイト計測用の小さな Redis インスタンスを起動できます。",
        "この秘密鍵は2か所に届ける必要があり、間違えても何のエラーも出ません。coturn は Compose の変数展開で受け取り、その展開はシェルかプロジェクトルートの .env からしか解決されません。サーバーは自分自身の環境変数——つまり server/.env——から読み、秘密鍵が空なら TURN は完全に無効になります。片方だけ設定すると、動いてはいるがサーバーが決して資格情報を発行しない coturn ができあがります。コンテナはすべて健全と報告し、ログには何も出ず、厳しい NAT をまたぐ転送はリレーを追加する前とまったく同じように失敗し続けます。",
      ],
      steps: [
        {
          text: "十分に長いランダムな秘密鍵を1つ生成します。以下ではすべて同じ値を使います。",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "その秘密鍵と、自分のドメインが解決するリレーアドレスを server/.env に書きます。これでサーバー側の TURN が有効になります。",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "同じファイルをシェルに読み込ませ、Compose の変数展開が coturn へ同一の秘密鍵を渡せるようにします。source する方法なら情報源が1つに保たれ、ps から見える形でコマンドラインに秘密鍵が載ることもありません。",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "relay プロファイルを付けてスタックを起動します。",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "ホストのファイアウォールでリレーポートを開けます。coturn はホストネットワークで動くため、これは Docker ではなくホスト側のルールです: UDP 3478 と 49152-65535、TCP 3478 と 5349。",
        },
        {
          text: "coturn だけでなくサーバーが秘密鍵を持って起動したことを確認します。これが、音もなく起きる失敗を捕まえるための確認です。",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "正常なリレーの見え方",
        body: [
          "サーバーコンテナの内側から見て、両方のキーが空でない値を返します。coturn が動いていること自体は何の証明にもなりません——ブラウザが受け取るリレー資格情報は、サーバーが発行したものだけです。",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
      bullets: [
        "coturn が動作するにはホストの実際のパブリック IP と、開放された UDP ポート範囲が必要です——docs/self-hosting.md は Docker の relay プロファイルでの起動方法を説明しています。Relayium 自身の本番 coturn 設定（インストールスクリプトを含む）は公開されていません。",
        "--profile relay と RELAYIUM_TURN_SECRET を使わなくてもサーバー自体は問題なく動作します——ネットワークをまたぐ転送は単に STUN のみにフォールバックし、比較的緩い NAT タイプでは機能しますが、最も厳しいタイプでは機能しません。",
      ],
    },
    {
      heading: "CLI を自分のサーバーに向ける",
      body: [
        "Relayium CLI は、ネットワークをまたぐ send/receive と text で既定では relayium.com のランデブーサーバーを使います。--server を渡せば、代わりに自分のサーバーを使えます。",
      ],
      steps: [
        {
          text: "前の節で CLI を入れたマシンで、relayium.com ではなく自分のサーバーにサインインします。URL とコードが表示されるので、自分のインスタンスにサインイン済みのブラウザで承認します。",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "保存された資格情報がどのサーバーに結び付いているかを確認します。whoami はフラグを取りません——ログインが実際に書き込んだ内容をそのまま報告するので、実行する価値があります。",
          code: ["relayium whoami"],
        },
        {
          text: "送信時にも同じ --server を渡します。付け忘れると CLI は relayium.com でペアリングコードを発行してしまい、相手は自分のインスタンス上でそれを見つけられません。",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "もう一方のマシンで、表示されたコードと同じ --server を使って受け取ります。テキストセッションも同じ要領です。",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "自分のインスタンスに向いていると分かる形",
        body: [
          "whoami はアカウントに続けて、結び付いているサーバーを括弧内に表示します。そこが relayium.com ではなく自分のドメインになっていれば確認完了です。",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "どちらのサーバーを使っても CLI は無料です——--server はペアリングコードのハンドシェイク先を変更するだけです。send または text をコードなしで実行するとそのサーバーでコードを発行し、クラウドの up もそのサーバー上のアカウントに保存するため、先に relayium login --server https://your-domain でサインインしてください。receive、down、表示されたコードで参加する text はログイン不要です。",
        "text の両端は同時にオンラインである必要があります。メッセージは独立したエンドツーエンド暗号化 P2P 直結セッションを使います。CLI text は直結専用で、ブラウザ版の TURN リレーは使いません。Relayium もセルフホストしたサーバーもメッセージ本文やサーバー側の履歴を保存しませんが、どちらの端末または受信者も受信後のテキストをコピーまたは保持できます。",
        "push/pull（自分の SSH 経由）や、serve とデーモン直結の push relayium://host は、セルフホストかどうかにかかわらず relayium.com に一切触れません——指定したリモートに直接接続します。",
      ],
    },
    {
      heading: "うまくいかないとき",
      body: [
        "失敗するセルフホストのほぼすべては、次の5つのどれかです。それぞれに、読めば分かる1行か、実行すれば決着がつくコマンドがあります。そして5つのうち3つは、その確認を走らせるまで成功したように見えます。",
      ],
      troubleshooting: {
        label: "症状、確認、対処",
        items: [
          {
            symptom: "ビルドが始まる前に、docker compose up がそもそも起動を拒否する。",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "Compose はプロファイルで絞り込む前にファイル全体を変数展開するため、リレーが無効でも、無効化された coturn サービスの必須変数まで検証されます。任意のプレースホルダーを前置してください——RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build——実際に relay プロファイルを有効化するときに本物の秘密鍵へ置き換えます。",
          },
          {
            symptom: "コンテナは Up なのに、別のマシンのブラウザから到達できない。",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "そのループバックへのバインドは既定の動作で、公開ホストが平文 HTTP をインターネットに晒さないためのものです。本番ではそのままにして、同じホスト上のリバースプロキシで TLS を終端してください。プロキシのない LAN 専用機なら、RELAYIUM_BIND=0.0.0.0 docker compose up -d でより広く公開します——この変数を読むのは compose であって、サーバー自身ではありません。",
          },
          {
            symptom: "/healthz は ok を返すのに、サインアップが失敗し、保存型リンクがいつまでも現れない。",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "/healthz は無条件に ok を返し、プロセスが待ち受けていることしか証明しません。/readyz は SQLite データベースとブロブディレクトリに ping を送るため、503 はそのどちらかが使えないという意味です——relayium-data ボリュームがマウントされているか、RELAYIUM_DB と RELAYIUM_BLOB_DIR がその内側を指しているかを確認してください。",
          },
          {
            symptom: "relayium login が、開けるはずのない localhost の確認 URL を表示する。",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "その URL はサーバーが RELAYIUM_BASE_URL から組み立てており、既定値は http://localhost:8080 です。server/.env で実際の https:// アドレスに設定して再起動してください。この値はセッション Cookie に Secure フラグを付けるかどうかも決めるので、間違ったままにするのは見た目だけの問題ではありません。",
          },
          {
            symptom: "coturn は動いているのに、厳しい NAT をまたぐ転送が失敗し続ける——しかもログには何も出ない。",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# 出力なし`,
            ],
            fix: "秘密鍵は Compose の変数展開で coturn には届いたものの、サーバーには一度も届いておらず、サーバー側は秘密鍵が空なので TURN が完全に無効です。RELAYIUM_TURN_SECRET と RELAYIUM_TURN_URLS を server/.env に書き、set -a; . ./server/.env; set +a でシェルに読み込ませて変数展開にも同じ値を見せ、relay プロファイルを再起動してください。先ほどの確認で両方のキーが空でない値を返すことが条件です。",
          },
        ],
      },
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
        "저장소 루트에는 Dockerfile과 docker-compose.yml이 있으며, 이들은 단일한 자체 완결형 이미지 — 미리 빌드된 웹 앱을 제공하는 정적 Go 바이너리 — 를 빌드합니다. 그저 실행만 하는 데는 별도의 Node, Go 툴체인, nginx가 필요 없습니다.",
      ],
      prereqs: {
        label: "1단계 전에 필요한 것",
        items: [
          "Docker Engine과 Compose 플러그인이 설치된 호스트. docker compose version은 버전 문자열을 출력합니다. \"docker: 'compose' is not a docker command\"가 나오면 플러그인이 없는 것입니다.",
          "저장소 클론. compose 파일은 이 소스 트리에서 이미지를 빌드하므로 옆에 Dockerfile과 web/이 있어야 합니다 — 받아올 미리 빌드된 이미지는 없습니다.",
          "이름 있는 볼륨 relayium-data를 위한 디스크 공간. SQLite 데이터베이스와 보관하는 저장형 전송 암호문이 들어갑니다.",
          "본인 외에 다른 사람도 쓸 예정이라면 도메인과 TLS를 종료하는 리버스 프록시. 컨테이너는 평문 HTTP만 사용하며 기본적으로 루프백 인터페이스에만 게시됩니다.",
          "그 밖에는 아무것도 필요 없습니다. 외부 데이터베이스도, 오브젝트 스토리지 버킷도, 제3자 계정도 필요하지 않습니다.",
        ],
      },
      steps: [
        {
          text: "저장소를 클론하고 그 디렉터리로 이동합니다.",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "빌드하고 시작합니다. 릴레이가 꺼져 있어도 이 자리표시자 비밀값은 생략할 수 없습니다. Compose는 파일을 파싱하는 시점에 프로필로 꺼둔 coturn 서비스의 필수 변수까지 검증하므로, 맨 docker compose up은 거부됩니다.",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "컨테이너가 재시작을 반복하지 않고 계속 떠 있는지 확인합니다.",
          code: ["docker compose ps"],
        },
        {
          text: "이 인스턴스가 실제로 서비스할 수 있는 상태인지 물어봅니다. /healthz가 아니라 /readyz를 쓰세요 — 둘의 차이가 이 확인의 핵심이며, 아래 예상 결과 상자가 그 이유를 설명합니다.",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "설정 템플릿을 복사하고 공개 주소를 설정합니다. RELAYIUM_BASE_URL은 발송 메일의 링크를 만들고 세션 쿠키에 Secure 플래그를 붙일지도 결정하므로, 실제 https:// 주소여야 합니다.",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "앞단에 nginx나 Caddy를 두어 자신의 도메인으로 TLS를 종료하고 모든 경로 — /, /api, /ws, /admin — 를 8080 포트로 프록시합니다. 그런 다음 server/.env를 반영하도록 재시작합니다.",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "정상적인 인스턴스의 모습",
        body: [
          "컨테이너가 Up으로 보고되고 두 엔드포인트 모두 응답합니다. 의미가 있는 쪽은 ready입니다. /healthz는 무엇이 열리기도 전에 무조건 ok를 반환하므로, 데이터베이스나 블롭 디렉터리를 쓸 수 없는 인스턴스도 통과시킵니다. /readyz는 SQLite 데이터베이스와 블롭 디렉터리에 핑을 보내고 둘 중 하나라도 문제가 있으면 503을 반환합니다.",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "docker-compose.yml에는 선택적인 relay 프로필이 있어, 메인 서버와 함께 coturn(TURN 서버)과 릴레이 바이트 계량용 소형 Redis 인스턴스를 시작할 수 있습니다.",
        "이 비밀값은 서로 다른 두 곳에 도달해야 하며, 잘못하면 아무 소리 없이 실패합니다. coturn은 Compose 변수 치환으로 받는데, 이 치환은 셸이나 프로젝트 루트의 .env에서만 해석됩니다. 서버는 자신의 환경 — 즉 server/.env — 에서 읽으며, 비밀값이 비어 있으면 TURN이 아예 꺼집니다. 한쪽만 설정하면 돌아가고는 있지만 서버가 자격 증명을 전혀 발급해 주지 않는 coturn이 남습니다. 모든 컨테이너는 정상이라고 보고하고, 로그에는 아무것도 남지 않으며, 엄격한 NAT를 넘는 전송은 릴레이를 추가하기 전과 똑같이 계속 실패합니다.",
      ],
      steps: [
        {
          text: "충분히 긴 무작위 비밀값을 하나 생성합니다. 아래에서는 모두 같은 값을 씁니다.",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "그 비밀값과 도메인이 가리키는 릴레이 주소를 server/.env에 적습니다. 그래야 서버가 TURN을 실제로 활성화합니다.",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "같은 파일을 셸로 불러와 Compose의 치환이 coturn에 동일한 비밀값을 넘기도록 합니다. source 방식은 출처를 하나로 유지하면서, ps에 드러나는 명령줄에 비밀값이 실리지 않게 해줍니다.",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "relay 프로필을 붙여 스택을 시작합니다.",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "호스트 방화벽에서 릴레이 포트를 엽니다. coturn은 호스트 네트워크로 실행되므로 이는 Docker가 아니라 호스트 규칙입니다: UDP 3478과 49152-65535, TCP 3478과 5349.",
        },
        {
          text: "coturn뿐 아니라 서버가 비밀값을 가지고 올라왔는지 확인합니다. 소리 없이 지나가는 실패를 잡아내는 확인이 바로 이것입니다.",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "정상적인 릴레이의 모습",
        body: [
          "서버 컨테이너 안에서 두 키가 모두 비어 있지 않은 값으로 돌아옵니다. coturn이 떠 있다는 사실만으로는 아무것도 증명되지 않습니다 — 브라우저가 받는 릴레이 자격 증명은 오직 서버가 발급한 것뿐입니다.",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
      bullets: [
        "coturn이 동작하려면 호스트의 실제 공인 IP와 열려 있는 UDP 포트 범위가 필요합니다 — docs/self-hosting.md에 Docker의 relay 프로필로 실행하는 방법이 설명되어 있습니다. Relayium이 실제 운영에 쓰는 coturn 설정(설치 스크립트 포함)은 공개되어 있지 않습니다.",
        "--profile relay와 RELAYIUM_TURN_SECRET 없이도 서버 자체는 문제없이 동작합니다 — 다만 네트워크 간 전송이 STUN만 사용하는 방식으로 대체되며, 이는 비교적 느슨한 NAT 유형에서는 동작하지만 가장 엄격한 유형에서는 동작하지 않습니다.",
      ],
    },
    {
      heading: "CLI를 자신의 서버로 연결하기",
      body: [
        "Relayium CLI는 네트워크 간 send/receive와 text에서 기본적으로 relayium.com의 랑데부 서버를 사용합니다. --server를 전달하면 대신 자신의 서버를 사용할 수 있습니다.",
      ],
      steps: [
        {
          text: "앞 절에서 CLI를 설치한 기기에서 relayium.com이 아니라 자신의 서버로 로그인합니다. URL과 코드가 출력되며, 자신의 인스턴스에 로그인된 브라우저에서 승인합니다.",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "저장된 자격 증명이 어느 서버에 묶여 있는지 확인합니다. whoami는 플래그를 받지 않습니다 — 로그인이 실제로 기록한 내용을 그대로 보고하며, 그래서 실행해 볼 가치가 있습니다.",
          code: ["relayium whoami"],
        },
        {
          text: "보낼 때도 같은 --server를 전달합니다. 빠뜨리면 CLI가 relayium.com에서 페어링 코드를 발급하고, 상대는 자신의 인스턴스에서 그 코드를 영영 찾지 못합니다.",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "다른 기기에서 출력된 코드와 같은 --server로 받습니다. 텍스트 세션도 방식이 같습니다.",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "자신의 인스턴스와 통신하고 있음을 확인하는 방법",
        body: [
          "whoami는 계정을 출력하고 괄호 안에 묶여 있는 서버를 함께 보여줍니다. 거기에 relayium.com이 아니라 자신의 도메인이 있으면 확인된 것입니다.",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "어느 서버를 쓰든 CLI는 무료입니다 — --server는 페어링 코드 핸드셰이크 서버만 바꿉니다. send나 text를 코드 없이 실행하면 그 서버에서 코드를 발급하고, 클라우드 up도 그 서버 계정에 저장하므로 먼저 relayium login --server https://your-domain으로 로그인하세요. receive, down, 출력된 코드로 참여하는 text는 로그인이 필요 없습니다.",
        "text 양쪽은 동시에 온라인이어야 합니다. 메시지는 별도의 종단간 암호화 P2P 직접 연결 세션을 사용합니다. CLI text는 직접 연결 전용이며 브라우저의 TURN 릴레이를 사용하지 않습니다. Relayium과 자체 호스팅 서버는 메시지 본문이나 서버 측 기록을 저장하지 않지만, 어느 터미널이나 수신자든 받은 텍스트를 복사하거나 보관할 수 있습니다.",
        "push/pull(자신의 SSH를 통한)과 serve + 데몬 다이렉트의 push relayium://host는 자체 호스팅 여부와 무관하게 relayium.com에 전혀 닿지 않습니다 — 지정한 원격지에 직접 연결됩니다.",
      ],
    },
    {
      heading: "잘 안 될 때",
      body: [
        "실패하는 자체 호스팅은 거의 모두 다섯 가지 중 하나입니다. 각각 읽어서 판단할 수 있는 한 줄이나 실행해서 결론을 내는 명령이 있으며, 다섯 중 셋은 그 확인을 돌려보기 전까지는 성공한 것처럼 보입니다.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "빌드가 시작되기도 전에 docker compose up이 아예 시작을 거부합니다.",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "Compose는 프로필로 걸러내기 전에 파일 전체를 치환하므로, 릴레이가 꺼져 있어도 꺼둔 coturn 서비스의 필수 변수까지 검증합니다. 아무 자리표시자나 앞에 붙이세요 — RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build — 실제로 relay 프로필을 켤 때 진짜 비밀값으로 바꾸면 됩니다.",
          },
          {
            symptom: "컨테이너는 Up인데 다른 기기의 브라우저에서 접근되지 않습니다.",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "그 루프백 바인딩은 기본 동작으로, 공개 호스트가 평문 HTTP를 인터넷에 노출하지 않게 합니다. 운영에서는 그대로 두고 같은 호스트의 리버스 프록시에서 TLS를 종료하세요. 프록시가 없는 LAN 전용 장비라면 RELAYIUM_BIND=0.0.0.0 docker compose up -d로 더 넓게 게시합니다 — 이 변수는 서버가 아니라 compose가 읽습니다.",
          },
          {
            symptom: "/healthz는 ok라는데 가입이 실패하고 저장형 링크가 끝내 나타나지 않습니다.",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "/healthz는 무조건 ok를 반환하며 프로세스가 대기 중이라는 것만 증명합니다. /readyz는 SQLite 데이터베이스와 블롭 디렉터리에 핑을 보내므로 503은 둘 중 하나를 쓸 수 없다는 뜻입니다 — relayium-data 볼륨이 마운트되었는지, RELAYIUM_DB와 RELAYIUM_BLOB_DIR이 그 안쪽을 가리키는지 확인하세요.",
          },
          {
            symptom: "relayium login이 열 수 없는 localhost 확인 URL을 출력합니다.",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "그 URL은 서버가 RELAYIUM_BASE_URL로 만들며, 기본값이 http://localhost:8080입니다. server/.env에서 실제 https:// 주소로 설정하고 재시작하세요. 이 값은 세션 쿠키에 Secure 플래그를 붙일지도 결정하므로, 잘못 둔 채로 두는 것은 보기 나쁜 정도의 문제가 아닙니다.",
          },
          {
            symptom: "coturn은 돌아가는데 엄격한 NAT를 넘는 전송이 계속 실패합니다 — 로그에는 아무것도 없습니다.",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# 출력 없음`,
            ],
            fix: "비밀값이 Compose 치환으로 coturn에는 닿았지만 서버에는 한 번도 닿지 않았고, 서버는 비밀값이 비어 있어 TURN이 아예 꺼져 있습니다. RELAYIUM_TURN_SECRET과 RELAYIUM_TURN_URLS를 server/.env에 적고, set -a; . ./server/.env; set +a로 셸에 불러와 치환도 같은 값을 보게 한 뒤 relay 프로필을 재시작하세요. 그 확인에서 두 키가 모두 비어 있지 않아야 합니다.",
          },
        ],
      },
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
        "Im Repository-Root liegen ein Dockerfile und ein docker-compose.yml, die ein einziges eigenständiges Image bauen — ein statisches Go-Binary, das die vorgebaute Web-App ausliefert, sodass für den reinen Betrieb weder ein separates Node, eine Go-Toolchain noch nginx nötig ist.",
      ],
      prereqs: {
        label: "Was du vor Schritt 1 brauchst",
        items: [
          "Einen Host mit Docker Engine und dem Compose-Plugin. docker compose version gibt eine Versionszeile aus; \"docker: 'compose' is not a docker command\" heißt, dass das Plugin fehlt.",
          "Einen Klon des Repositorys. Die Compose-Datei baut das Image aus genau diesem Quellbaum, braucht also das Dockerfile und web/ daneben — es gibt kein fertiges Image zum Ziehen.",
          "Platz für das benannte Volume relayium-data: die SQLite-Datenbank plus den Chiffretext gespeicherter Übertragungen, den du aufbewahrst.",
          "Eine Domain und einen TLS-terminierenden Reverse-Proxy, falls außer dir noch jemand den Server nutzt. Der Container spricht nur unverschlüsseltes HTTP und veröffentlicht standardmäßig ausschließlich auf dem Loopback-Interface.",
          "Sonst nichts. Keine externe Datenbank, kein Object-Storage-Bucket, kein Konto bei Dritten.",
        ],
      },
      steps: [
        {
          text: "Klone das Repository und wechsle hinein.",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "Bauen und starten. Das Platzhalter-Secret ist auch dann Pflicht, wenn das Relay aus ist: Compose prüft beim Parsen die Pflichtvariable des per Profil deaktivierten coturn-Dienstes mit, sodass ein blankes docker compose up die Arbeit verweigert.",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "Prüfe, ob der Container oben geblieben ist und nicht in einer Neustartschleife hängt.",
          code: ["docker compose ps"],
        },
        {
          text: "Frag die Instanz, ob sie tatsächlich ausliefern kann. Nimm /readyz, nicht /healthz — der Unterschied ist der ganze Sinn dieser Prüfung, und der Erwartungskasten unten sagt, warum.",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "Kopiere die Konfigurationsvorlage und trag deine öffentliche URL ein. RELAYIUM_BASE_URL baut die Links in ausgehenden E-Mails und entscheidet, ob Session-Cookies das Secure-Flag bekommen — es muss also deine echte https://-Adresse sein.",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "Setz nginx oder Caddy davor, das TLS für deine Domain terminiert und alles — /, /api, /ws, /admin — an Port 8080 weiterreicht. Danach neu starten, damit server/.env greift.",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "So sieht eine funktionierende Instanz aus",
        body: [
          "Der Container meldet Up, und beide Endpunkte antworten. Entscheidend ist ready: /healthz liefert bedingungslos ok, noch bevor irgendetwas geöffnet wurde, und geht deshalb auch auf einer Instanz durch, deren Datenbank oder Blob-Verzeichnis unbrauchbar ist. /readyz pingt die SQLite-Datenbank und das Blob-Verzeichnis an und antwortet mit 503, sobald eines von beiden kaputt ist.",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "docker-compose.yml hat ein optionales relay-Profil, das zusammen mit dem Hauptserver coturn (den TURN-Server) und eine kleine Redis-Instanz für die Zählung der Relay-Bytes startet.",
        "Das Secret muss an zwei verschiedene Stellen gelangen, und wenn das schiefgeht, scheitert es lautlos. coturn bekommt es über die Variablenersetzung von Compose, die nur aus der Shell oder einer .env im Projektwurzelverzeichnis aufgelöst wird. Der Server liest es aus seiner eigenen Umgebung — also aus server/.env — und ein leeres Secret schaltet TURN vollständig ab. Setzt du nur eines von beiden, läuft ein coturn, für das der Server nie Zugangsdaten ausstellt: Jeder Container meldet sich gesund, im Log steht nichts, und Übertragungen durch strenge NATs scheitern weiter genau wie vorher.",
      ],
      steps: [
        {
          text: "Erzeuge ein einziges langes Zufalls-Secret. Überall unten kommt derselbe Wert hin.",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "Trag dieses Secret und die Relay-Adressen, auf die deine Domain zeigt, in server/.env ein — erst damit schaltet der Server TURN überhaupt ein.",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "Exportiere dieselbe Datei in die Shell, damit die Ersetzung von Compose coturn dasselbe Secret übergeben kann. Sourcen hält die Quelle einzig und hält das Secret von der Kommandozeile fern, wo ps es sichtbar machen würde.",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "Starte den Stack mit dem relay-Profil.",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "Öffne die Relay-Ports in der Firewall des Hosts. coturn läuft im Host-Netzwerk, das sind also Host-Regeln und keine Docker-Regeln: UDP 3478 und 49152-65535, TCP 3478 und 5349.",
        },
        {
          text: "Prüfe, ob der Server — nicht nur coturn — mit dem Secret hochgekommen ist. Genau diese Prüfung fängt den lautlosen Fall ab.",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "So sieht ein funktionierendes Relay aus",
        body: [
          "Beide Schlüssel kommen aus dem Inneren des Server-Containers nicht leer zurück. Dass coturn läuft, sagt für sich genommen nichts — der Browser bekommt ausschließlich Relay-Zugangsdaten, die der Server ausgestellt hat.",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
      bullets: [
        "coturn braucht die echte öffentliche IP des Hosts und einen offenen UDP-Portbereich, um zu funktionieren — docs/self-hosting.md beschreibt den Start über das Docker-relay-Profil; Relayiums eigene Produktions-coturn-Konfiguration (inklusive Installationsskript) ist nicht veröffentlicht.",
        "Ohne --profile relay und RELAYIUM_TURN_SECRET läuft der Server trotzdem einwandfrei — netzwerkübergreifende Übertragungen fallen dann nur auf reines STUN zurück, das bei einfacheren NAT-Typen funktioniert, aber nicht bei den strengsten.",
      ],
    },
    {
      heading: "Die CLI auf deinen Server ausrichten",
      body: [
        "Die Relayium CLI verwendet für netzwerkübergreifendes send/receive und text standardmäßig den Rendezvous-Server auf relayium.com. Übergib --server, um stattdessen deinen eigenen zu nutzen.",
      ],
      steps: [
        {
          text: "Melde dich auf einem Rechner, der die CLI aus dem Abschnitt oben schon hat, an deinem eigenen Server an statt an relayium.com. Es erscheinen eine URL und ein Code; bestätige ihn in einem Browser, der an deiner Instanz angemeldet ist.",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "Prüfe, an welchen Server die gespeicherten Zugangsdaten gebunden sind. whoami nimmt keine Flags — es meldet, was die Anmeldung tatsächlich geschrieben hat, und genau das macht den Aufruf wertvoll.",
          code: ["relayium whoami"],
        },
        {
          text: "Gib beim Senden dasselbe --server mit. Ohne es prägt die CLI den Pairing-Code auf relayium.com, und die Gegenseite findet ihn auf deiner Instanz nie.",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "Empfange auf dem anderen Rechner mit dem ausgegebenen Code und demselben --server. Textsitzungen laufen genauso.",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "Woran du merkst, dass sie mit deiner Instanz spricht",
        body: [
          "whoami gibt das Konto aus und dahinter in Klammern den Server, an den es gebunden ist. Steht dort deine eigene Domain und nicht relayium.com, ist es bestätigt.",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "Egal welchen Server sie nutzt, die CLI ist kostenlos — --server ändert nur den Rendezvous-Server. send oder text ohne Code erzeugen dort einen Code, und Cloud-up speichert unter einem Konto auf ihm; melde dich daher zuerst mit relayium login --server https://your-domain an. receive, down und text mit dem ausgegebenen Code brauchen keine Anmeldung.",
        "Beide text-Gegenstellen müssen gleichzeitig online bleiben. Nachrichten laufen über eine eigene Ende-zu-Ende-verschlüsselte direkte P2P-Sitzung. CLI text ist rein direkt und nutzt nicht das TURN-Relay der Web-App. Weder Relayium noch dein selbst gehosteter Server speichern Nachrichteninhalte oder einen serverseitigen Verlauf; beide Terminals beziehungsweise der Empfänger können empfangenen Text jedoch kopieren oder aufbewahren.",
        "push/pull (über dein eigenes SSH) sowie serve + daemon-direct push relayium://host berühren relayium.com überhaupt nicht, selbst gehostet oder nicht — sie verbinden sich direkt mit der von dir angegebenen Gegenstelle.",
      ],
    },
    {
      heading: "Wenn es nicht funktioniert",
      body: [
        "Fünf Fehler decken fast jedes gescheiterte Selbst-Hosting ab. Zu jedem gibt es eine Zeile zum Lesen oder einen Befehl zum Ausführen, der die Sache entscheidet — und drei der fünf sehen wie Erfolg aus, bis du die Prüfung wirklich laufen lässt.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "docker compose up verweigert den Start komplett, bevor überhaupt etwas gebaut wird.",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "Compose ersetzt die Variablen der ganzen Datei, bevor es nach Profilen filtert — die Pflichtvariable des abgeschalteten coturn-Dienstes wird also auch dann geprüft, wenn das Relay aus ist. Stell irgendeinen Platzhalter voran — RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build — und ersetze ihn erst durch ein echtes Secret, wenn du das relay-Profil tatsächlich einschaltest.",
          },
          {
            symptom: "Der Container ist Up, aber ein Browser auf einem anderen Rechner erreicht ihn nicht.",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "Diese Bindung ans Loopback ist die Voreinstellung, damit ein öffentlicher Host kein unverschlüsseltes HTTP ins Internet stellt. Lass sie im Produktivbetrieb so und terminiere TLS in einem Reverse-Proxy auf demselben Host. Für eine reine LAN-Kiste ohne Proxy veröffentlichst du weiter mit RELAYIUM_BIND=0.0.0.0 docker compose up -d — diese Variable liest compose, nicht der Server.",
          },
          {
            symptom: "/healthz sagt ok, aber die Registrierung schlägt fehl und gespeicherte Links tauchen nie auf.",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "/healthz antwortet bedingungslos mit ok und belegt nur, dass der Prozess lauscht. /readyz pingt die SQLite-Datenbank und das Blob-Verzeichnis an, eine 503 heißt also, dass eines von beiden unbrauchbar ist — prüfe, ob das Volume relayium-data gemountet ist und ob RELAYIUM_DB und RELAYIUM_BLOB_DIR hineinzeigen.",
          },
          {
            symptom: "relayium login gibt eine Bestätigungs-URL auf localhost aus, die du nicht öffnen kannst.",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "Der Server baut diese URL aus RELAYIUM_BASE_URL, dessen Vorgabe http://localhost:8080 ist. Trag in server/.env deine echte https://-Adresse ein und starte neu. Der Wert entscheidet außerdem, ob Session-Cookies das Secure-Flag bekommen — ihn falsch zu lassen ist also nicht nur ein Schönheitsfehler.",
          },
          {
            symptom: "coturn läuft, aber netzwerkübergreifende Übertragungen durch strenge NATs scheitern weiter — und nichts wird geloggt.",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# keine Ausgabe`,
            ],
            fix: "Das Secret hat coturn über die Compose-Ersetzung erreicht, den Server aber nie, und dessen leeres Secret schaltet TURN vollständig ab. Trag RELAYIUM_TURN_SECRET und RELAYIUM_TURN_URLS in server/.env ein, source die Datei mit set -a; . ./server/.env; set +a, damit die Ersetzung denselben Wert sieht, und starte das relay-Profil neu. Beide Schlüssel müssen bei dieser Prüfung nicht leer zurückkommen.",
          },
        ],
      },
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
        "La racine du dépôt fournit un Dockerfile et un docker-compose.yml qui construisent une seule image autonome — un binaire Go statique servant l'application web précompilée, donc aucun Node, aucune chaîne d'outils Go ni aucun nginx séparé n'est requis juste pour le faire tourner.",
      ],
      prereqs: {
        label: "Ce qu'il vous faut avant l'étape 1",
        items: [
          "Une machine avec Docker Engine et le plugin Compose. docker compose version affiche un numéro de version ; « docker: 'compose' is not a docker command » signifie que le plugin manque.",
          "Un clone du dépôt. Le fichier compose construit l'image à partir de cet arbre de sources, il lui faut donc le Dockerfile et web/ à côté de lui — il n'existe aucune image précompilée à télécharger.",
          "De l'espace disque pour le volume nommé relayium-data : la base SQLite plus le chiffré des transferts stockés que vous conservez.",
          "Un domaine et un proxy inverse terminant TLS si quelqu'un d'autre que vous doit l'utiliser. Le conteneur ne parle qu'en HTTP clair et ne publie par défaut que sur l'interface de bouclage.",
          "Rien d'autre. Aucune base de données externe, aucun bucket de stockage objet, aucun compte tiers.",
        ],
      },
      steps: [
        {
          text: "Clonez le dépôt et placez-vous dedans.",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "Construisez et démarrez. Le secret de remplacement reste obligatoire même quand le relais est éteint : Compose valide la variable requise du service coturn désactivé par profil au moment où il analyse le fichier, si bien qu'un docker compose up nu refuse de démarrer.",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "Vérifiez que le conteneur est bien resté en vie plutôt que de redémarrer en boucle.",
          code: ["docker compose ps"],
        },
        {
          text: "Demandez à l'instance si elle peut réellement servir. Utilisez /readyz, pas /healthz — la différence entre les deux est tout l'intérêt de cette vérification, et l'encadré de résultat attendu ci-dessous explique pourquoi.",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "Copiez le modèle de configuration et renseignez votre URL publique. RELAYIUM_BASE_URL construit les liens des courriels sortants et décide si les cookies de session portent l'attribut Secure : ce doit donc être votre véritable adresse https://.",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "Placez nginx ou Caddy devant, terminant TLS pour votre domaine et relayant tout — /, /api, /ws, /admin — vers le port 8080. Redémarrez ensuite pour prendre en compte server/.env.",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "À quoi ressemble une instance qui fonctionne",
        body: [
          "Le conteneur affiche Up et les deux points d'entrée répondent. C'est ready qui compte : /healthz renvoie ok sans condition, avant même que quoi que ce soit ne soit ouvert, et passe donc aussi sur une instance dont la base ou le répertoire de blobs est inutilisable. /readyz interroge la base SQLite et le répertoire de blobs, et répond 503 dès que l'un des deux est cassé.",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "Le secret doit parvenir à deux endroits différents, et se tromper échoue sans le moindre bruit. coturn le reçoit par la substitution de variables de Compose, qui ne se résout que depuis le shell ou un .env à la racine du projet. Le serveur, lui, le lit dans son propre environnement — c'est-à-dire server/.env — et un secret vide désactive purement et simplement TURN. Si vous n'en renseignez qu'un seul, vous obtenez un coturn qui tourne mais pour lequel le serveur n'émet jamais d'identifiants : tous les conteneurs se déclarent sains, rien n'est journalisé, et les transferts à travers les NAT stricts continuent d'échouer exactement comme avant.",
      ],
      steps: [
        {
          text: "Générez un seul secret aléatoire suffisamment long. C'est la même valeur partout ci-dessous.",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "Inscrivez ce secret, ainsi que les adresses de relais vers lesquelles votre domaine pointe, dans server/.env : c'est ce qui active TURN côté serveur.",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "Exportez ce même fichier dans le shell pour que la substitution de Compose puisse remettre à coturn un secret identique. Le sourcer conserve une source unique et garde le secret hors de la ligne de commande, où ps l'exposerait.",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "Démarrez la pile avec le profil relay.",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "Ouvrez les ports de relais sur le pare-feu de l'hôte. coturn tourne en réseau hôte, ce sont donc des règles de l'hôte et non de Docker : UDP 3478 et 49152-65535, TCP 3478 et 5349.",
        },
        {
          text: "Vérifiez que le serveur — et pas seulement coturn — a démarré avec le secret. C'est cette vérification qui attrape le cas silencieux.",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "À quoi ressemble un relais qui fonctionne",
        body: [
          "Les deux clés reviennent non vides depuis l'intérieur du conteneur serveur. Que coturn tourne ne prouve rien en soi — le navigateur ne reçoit jamais que des identifiants de relais émis par le serveur.",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
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
      steps: [
        {
          text: "Sur une machine qui dispose déjà de la CLI grâce à la section précédente, connectez-vous à votre serveur plutôt qu'à relayium.com. Une URL et un code s'affichent ; approuvez-les dans un navigateur connecté à votre instance.",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "Vérifiez à quel serveur les identifiants enregistrés sont rattachés. whoami ne prend aucune option — il rapporte ce que la connexion a réellement écrit, et c'est précisément ce qui rend la commande utile.",
          code: ["relayium whoami"],
        },
        {
          text: "Passez le même --server à l'envoi. Sans lui, la CLI génère le code d'appairage sur relayium.com et l'autre extrémité ne le trouvera jamais sur votre instance.",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "Recevez sur l'autre machine avec le code affiché et le même --server. Les sessions de texte fonctionnent de la même façon.",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "Comment savoir qu'elle parle bien à votre instance",
        body: [
          "whoami affiche le compte, suivi entre parenthèses du serveur auquel il est rattaché. Votre propre domaine à cet endroit — et non relayium.com — vaut confirmation.",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "Quel que soit le serveur utilisé, la CLI est gratuite — --server ne change que le serveur de rendez-vous. send ou text sans code y génèrent un code, et up y stocke sous un compte ; connectez-vous donc d'abord avec relayium login --server https://your-domain. receive, down et text avec le code affiché ne nécessitent aucune connexion.",
        "Les deux extrémités de text doivent rester en ligne. Les messages utilisent leur propre session P2P directe chiffrée de bout en bout. Le text de la CLI est exclusivement direct et n'utilise pas le relais TURN de l'appli web. Ni Relayium ni votre serveur auto-hébergé ne stockent le corps des messages ou un historique côté serveur, mais chaque terminal ou destinataire peut copier ou conserver le texte après réception.",
        "push/pull (via votre propre SSH) ainsi que serve + le push daemon-direct relayium://host ne touchent jamais relayium.com, auto-hébergé ou non — ils se connectent directement à la machine distante que vous indiquez.",
      ],
    },
    {
      heading: "Quand ça ne marche pas",
      body: [
        "Cinq pannes couvrent presque tous les auto-hébergements ratés. Chacune se tranche par une ligne à lire ou une commande à exécuter, et trois d'entre elles ressemblent à une réussite tant que vous n'avez pas lancé la vérification.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "docker compose up refuse tout net de démarrer, avant même que quoi que ce soit ne soit construit.",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "Compose substitue les variables de tout le fichier avant de filtrer par profil : la variable requise du service coturn désactivé est donc validée même quand le relais est éteint. Préfixez n'importe quelle valeur de remplacement — RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build — et ne la remplacez par un vrai secret qu'au moment où vous activez réellement le profil relay.",
          },
          {
            symptom: "Le conteneur est Up, mais un navigateur sur une autre machine n'y accède pas.",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "Cette liaison sur la boucle locale est le comportement par défaut, pour qu'un hôte public n'expose pas du HTTP en clair à Internet. En production, laissez-la et terminez TLS dans un proxy inverse sur le même hôte. Pour une machine purement LAN sans proxy, publiez plus largement avec RELAYIUM_BIND=0.0.0.0 docker compose up -d — cette variable est lue par compose, pas par le serveur.",
          },
          {
            symptom: "/healthz répond ok, mais l'inscription échoue et les liens stockés n'apparaissent jamais.",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "/healthz renvoie ok sans condition et ne prouve que l'écoute du processus. /readyz interroge la base SQLite et le répertoire de blobs : un 503 signifie donc que l'un des deux est inutilisable — vérifiez que le volume relayium-data est monté et que RELAYIUM_DB et RELAYIUM_BLOB_DIR pointent à l'intérieur.",
          },
          {
            symptom: "relayium login affiche une URL de vérification sur localhost, que vous ne pouvez pas ouvrir.",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "Le serveur construit cette URL à partir de RELAYIUM_BASE_URL, dont la valeur par défaut est http://localhost:8080. Renseignez votre véritable adresse https:// dans server/.env, puis redémarrez. Elle décide aussi si les cookies de session portent l'attribut Secure : la laisser fausse n'est donc pas qu'un détail d'apparence.",
          },
          {
            symptom: "coturn tourne, mais les transferts entre réseaux à travers un NAT strict échouent toujours — sans rien dans les journaux.",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# aucune sortie`,
            ],
            fix: "Le secret a atteint coturn par la substitution de Compose mais n'est jamais parvenu au serveur, dont le secret vide désactive complètement TURN. Inscrivez RELAYIUM_TURN_SECRET et RELAYIUM_TURN_URLS dans server/.env, sourcez-le dans le shell comme à l'étape 3 ci-dessus pour que la substitution voie la même valeur, puis redémarrez le profil relay. Les deux clés doivent revenir non vides à cette vérification.",
          },
        ],
      },
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
    "تمنحك الاستضافة الذاتية تحكمًا كاملًا في مكان بياناتك، ونطاقك الخاص وشهادة TLS خاصة بك، وبلا اعتماد على بنية أحد آخر. كل ما يلي مبني على ملفات موجودة فعلًا في المستودع — docker-compose.yml وserver/.env.example وdocs/self-hosting.md — فلا شيء هنا عبارة عن راية أو إعداد غير موجود فعلًا.",
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
        "جذر المستودع يوفّر Dockerfile وdocker-compose.yml يبنيان صورة واحدة مكتفية بذاتها — ثنائي Go ساكن يقدّم تطبيق الويب المبني مسبقًا، فلا حاجة إلى Node منفصل أو سلسلة أدوات Go أو nginx لمجرد تشغيله.",
      ],
      prereqs: {
        label: "ما تحتاجه قبل الخطوة 1",
        items: [
          "مضيف عليه Docker Engine وملحق Compose. يطبع docker compose version سطر إصدار؛ أما ظهور «docker: 'compose' is not a docker command» فيعني أن الملحق غير مثبَّت.",
          "نسخة من المستودع. يبني ملف compose الصورة من شجرة المصدر هذه، فهو يحتاج إلى Dockerfile وweb/ بجواره — ولا توجد صورة جاهزة لسحبها.",
          "مساحة قرص للوحدة المسماة relayium-data: قاعدة بيانات SQLite إضافةً إلى ما تحتفظ به من نص مشفَّر للنقل المخزَّن.",
          "نطاق ووكيل عكسي ينهي TLS إن كان سيستخدمه أحد غيرك. الحاوية لا تتحدث إلا HTTP صريحًا، ولا تنشر افتراضيًا إلا على واجهة الاسترجاع المحلية.",
          "ولا شيء آخر. لا قاعدة بيانات خارجية، ولا دلو تخزين كائنات، ولا حساب لدى طرف ثالث.",
        ],
      },
      steps: [
        {
          text: "استنسخ المستودع وانتقل إليه.",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "ابنِ وشغّل. المفتاح النائب إلزامي حتى مع إيقاف المُرحِّل: يتحقق Compose من المتغير المطلوب لخدمة coturn المعطَّلة بالملف الشخصي وقت تحليل الملف، فيرفض أمر docker compose up المجرَّد أن يبدأ.",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "تأكّد أن الحاوية بقيت قائمة فعلًا بدل أن تدور في حلقة انهيار وإعادة تشغيل.",
          code: ["docker compose ps"],
        },
        {
          text: "اسأل النسخة إن كانت تستطيع الخدمة فعلًا. استخدم ‎/readyz‎ لا ‎/healthz‎ — الفرق بينهما هو كل مغزى هذا الفحص، وصندوق النتيجة المتوقَّعة أدناه يوضّح السبب.",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "انسخ قالب الإعدادات واضبط عنوانك العام. يبني RELAYIUM_BASE_URL الروابط في البريد الصادر ويقرّر أيضًا هل تحمل كعكات الجلسة راية Secure، فلا بد أن يكون عنوان ‎https://‎ الحقيقي الخاص بك.",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "ضع nginx أو Caddy في المقدمة لينهي TLS لنطاقك ويمرّر كل شيء — ‎/‎ و‎/api‎ و‎/ws‎ و‎/admin‎ — إلى المنفذ 8080. ثم أعد التشغيل ليسري مفعول server/.env.",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "كيف تبدو نسخة تعمل بشكل صحيح",
        body: [
          "تُبلِّغ الحاوية عن Up، ويستجيب الطرفان كلاهما. المهم هو ready: إذ يعيد ‎/healthz‎ قيمة ok دون أي شرط وقبل أن يُفتح أي شيء، فينجح حتى على نسخة صارت قاعدة بياناتها أو دليل الكتل غير صالح للاستعمال. أما ‎/readyz‎ فيتحقق من قاعدة بيانات SQLite ومن دليل الكتل، ويعيد 503 متى تعطّل أحدهما.",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "ولا بد أن يصل المفتاح السري إلى موضعين مختلفين، والخطأ في ذلك يفشل بلا صوت. يتلقّاه coturn عبر استبدال المتغيرات في Compose، وهو استبدال لا يُحَل إلا من الصدفة أو من ملف ‎.env‎ في جذر المشروع. أما الخادم فيقرأه من بيئته هو — أي من server/.env — والمفتاح الفارغ يعطّل TURN تعطيلًا كاملًا. فإن ضبطت أحدهما فقط، حصلت على coturn يعمل ولا يصدر له الخادم بيانات اعتماد قط: كل الحاويات تُبلِّغ أنها سليمة، ولا شيء يُسجَّل، وتظل عمليات النقل عبر شبكات NAT الصارمة تفشل تمامًا كما كانت قبل إضافة المُرحِّل.",
      ],
      steps: [
        {
          text: "ولّد مفتاحًا سريًا عشوائيًا طويلًا واحدًا. والقيمة نفسها تُستخدم في كل ما يلي.",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "ضع هذا المفتاح، مع عناوين المُرحِّل التي يشير إليها نطاقك، في server/.env حتى يفعّل الخادم TURN أصلًا.",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "صدِّر الملف نفسه إلى الصدفة ليتمكن استبدال Compose من تسليم coturn المفتاح ذاته. واستخدام source يُبقي المصدر واحدًا ويُبعد المفتاح عن سطر الأوامر حيث يكشفه ps.",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "شغّل المنظومة مع الملف الشخصي relay.",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "افتح منافذ المُرحِّل على جدار حماية المضيف. يعمل coturn بشبكة المضيف، فهذه قواعد المضيف لا قواعد Docker: UDP 3478 و49152-65535، وTCP 3478 و5349.",
        },
        {
          text: "تأكّد أن الخادم — لا coturn وحده — أقلع وهو يحمل المفتاح. هذا هو الفحص الذي يلتقط الحالة الصامتة.",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "كيف يبدو مُرحِّل يعمل بشكل صحيح",
        body: [
          "يعود المفتاحان كلاهما بقيمة غير فارغة من داخل حاوية الخادم. وكون coturn يعمل لا يثبت شيئًا بذاته — فالمتصفح لا يحصل إلا على بيانات اعتماد مُرحِّل أصدرها الخادم.",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
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
      steps: [
        {
          text: "على جهاز يملك أصلًا الـ CLI من القسم السابق، سجّل الدخول إلى خادمك أنت لا إلى relayium.com. سيطبع رابطًا ورمزًا؛ وافق عليه من متصفح مسجَّل الدخول إلى نسختك.",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "تحقّق من الخادم الذي ارتبطت به بيانات الاعتماد المحفوظة. لا يقبل whoami أي رايات — فهو يُبلِّغ بما كتبه تسجيل الدخول فعلًا، وهذا بالضبط ما يجعل تشغيله مفيدًا.",
          code: ["relayium whoami"],
        },
        {
          text: "مرّر الـ ‎--server‎ نفسه عند الإرسال. فبدونه يُصدر الـ CLI رمز الاقتران على relayium.com، ولن يجده الطرف الآخر على نسختك أبدًا.",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "استقبل على الجهاز الآخر بالرمز المطبوع وبالـ ‎--server‎ نفسه. وجلسات النص تعمل بالطريقة ذاتها.",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "كيف تعرف أنه يتحدث إلى نسختك أنت",
        body: [
          "يطبع whoami الحساب يتبعه بين قوسين الخادم المرتبط به. فظهور نطاقك أنت هناك — لا relayium.com — هو التأكيد.",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "الـ CLI مجاني في كلتا الحالتين — ‎--server‎ يغيّر خادم التعارف فقط. يصدر send أو text بلا رمز رمزًا من ذلك الخادم، ويخزّن up السحابي تحت حساب عليه، لذا سجّل الدخول أولًا بـ ‎relayium login --server https://your-domain‎. أما receive وdown وtext مع الرمز المطبوع فلا تحتاج إلى تسجيل دخول.",
        "يجب أن يبقى طرفا text متصلين معًا. تستخدم الرسائل جلسة P2P مباشرة مستقلة ومشفّرة من الطرف إلى الطرف. text في CLI مباشر فقط ولا يستخدم مُرحِّل TURN الخاص بتطبيق الويب. لا تخزّن Relayium ولا خادمك المستضاف ذاتيًا متون الرسائل أو سجلًا على الخادم، لكن يمكن لأي طرفية أو مستلم نسخ النص أو الاحتفاظ به بعد استلامه.",
        "‏push/pull (عبر SSH الخاص بك) وserve + دفع daemon direct عبر push relayium://host لا يلمسان relayium.com إطلاقًا، سواء بالاستضافة الذاتية أم لا — يتصلان مباشرةً بالجهاز البعيد الذي تحدده.",
      ],
    },
    {
      heading: "حين لا ينجح الأمر",
      body: [
        "خمسة إخفاقات تغطي تقريبًا كل استضافة ذاتية فاشلة. ولكلٍّ منها سطر تقرؤه أو أمر تشغّله يحسم المسألة، وثلاثة من الخمسة تبدو كالنجاح حتى تُشغِّل الفحص فعلًا.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "يرفض docker compose up أن يبدأ من الأساس، قبل أن يُبنى أي شيء.",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "يستبدل Compose متغيرات الملف كله قبل أن يُرشّح حسب الملفات الشخصية، فيتحقق من المتغير المطلوب لخدمة coturn المعطَّلة حتى مع إيقاف المُرحِّل. ضع أي قيمة نائبة في المقدمة — RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build — ولا تستبدلها بمفتاح حقيقي إلا حين تفعّل الملف الشخصي relay فعلًا.",
          },
          {
            symptom: "الحاوية في حالة Up، لكن متصفحًا على جهاز آخر لا يصل إليها.",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "الارتباط بواجهة الاسترجاع هو السلوك الافتراضي، حتى لا يعرض مضيف عام HTTP الصريح على الإنترنت. في الإنتاج اتركه كما هو وأنهِ TLS في وكيل عكسي على المضيف نفسه. أما جهاز الشبكة المحلية وحدها بلا وكيل، فانشره أوسع بـ RELAYIUM_BIND=0.0.0.0 docker compose up -d — وهذا متغير يقرؤه compose لا الخادم.",
          },
          {
            symptom: "يقول ‎/healthz‎ ok، لكن التسجيل يفشل ولا تظهر الروابط المخزَّنة أبدًا.",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "يعيد ‎/healthz‎ قيمة ok دون شرط ولا يثبت إلا أن العملية تستمع. أما ‎/readyz‎ فيتحقق من قاعدة بيانات SQLite ومن دليل الكتل، فيعني الرمز 503 أن أحدهما غير صالح للاستعمال — تحقّق من أن الوحدة relayium-data مُركَّبة وأن RELAYIUM_DB وRELAYIUM_BLOB_DIR يشيران إلى داخلها.",
          },
          {
            symptom: "يطبع relayium login رابط تحقّق على localhost لا يمكنك فتحه.",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "يبني الخادم ذلك الرابط من RELAYIUM_BASE_URL، وقيمته الافتراضية ‎http://localhost:8080‎. اضبطه في server/.env على عنوان ‎https://‎ الحقيقي ثم أعد التشغيل. وهو يقرّر أيضًا هل تحمل كعكات الجلسة راية Secure، فتركه خاطئًا ليس مسألة شكلية.",
          },
          {
            symptom: "coturn يعمل، ومع ذلك تظل عمليات النقل عبر NAT الصارم تفشل — ودون أي شيء في السجلات.",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# لا مُخرَجات`,
            ],
            fix: "وصل المفتاح إلى coturn عبر استبدال Compose ولم يصل إلى الخادم قط، والمفتاح الفارغ لدى الخادم يعطّل TURN تمامًا. ضع RELAYIUM_TURN_SECRET وRELAYIUM_TURN_URLS في server/.env، وحمّله بـ set -a; . ./server/.env; set +a ليرى الاستبدال القيمة نفسها، ثم أعد تشغيل الملف الشخصي relay. ولا بد أن يعود المفتاحان كلاهما بقيمة غير فارغة في ذلك الفحص.",
          },
        ],
      },
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
    "Autoalojar te da control total sobre dónde viven tus datos, tu propio dominio y certificado TLS, y ninguna dependencia de la infraestructura de nadie más. Todo lo que sigue se basa en los archivos que se distribuyen en el repositorio — docker-compose.yml, server/.env.example y docs/self-hosting.md — así que nada de lo que hay aquí es un indicador o ajuste que no exista de verdad.",
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
        "La raíz del repositorio incluye un Dockerfile y un docker-compose.yml que construyen una única imagen autocontenida — un binario Go estático que sirve la aplicación web precompilada, así que no hace falta un Node, una cadena de herramientas Go ni nginx aparte solo para ejecutarlo.",
      ],
      prereqs: {
        label: "Lo que necesitas antes del paso 1",
        items: [
          "Un host con Docker Engine y el plugin de Compose. docker compose version imprime una cadena de versión; si sale «docker: 'compose' is not a docker command», falta el plugin.",
          "Un clon del repositorio. El archivo compose construye la imagen a partir de este árbol de fuentes, así que necesita el Dockerfile y web/ a su lado: no hay ninguna imagen precompilada que descargar.",
          "Espacio en disco para el volumen con nombre relayium-data: la base de datos SQLite más el cifrado de las transferencias almacenadas que conserves.",
          "Un dominio y un proxy inverso que termine TLS si va a usarlo alguien más aparte de ti. El contenedor solo habla HTTP en claro y por omisión publica únicamente en la interfaz de bucle local.",
          "Nada más. Ni base de datos externa, ni bucket de almacenamiento de objetos, ni cuenta de terceros.",
        ],
      },
      steps: [
        {
          text: "Clona el repositorio y entra en él.",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "Constrúyelo y arráncalo. El secreto de relleno es obligatorio aunque el retransmisor esté apagado: Compose valida la variable requerida del servicio coturn desactivado por perfil al analizar el archivo, de modo que un docker compose up a secas se niega a arrancar.",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "Comprueba que el contenedor se ha quedado arriba en vez de reiniciarse en bucle.",
          code: ["docker compose ps"],
        },
        {
          text: "Pregúntale a la instancia si de verdad puede servir. Usa /readyz, no /healthz: la diferencia entre ambos es todo el sentido de esta comprobación, y el recuadro de resultado esperado de abajo explica por qué.",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "Copia la plantilla de configuración y pon tu URL pública. RELAYIUM_BASE_URL construye los enlaces del correo saliente y decide si las cookies de sesión llevan el atributo Secure, así que tiene que ser tu dirección https:// real.",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "Pon nginx o Caddy delante, terminando TLS para tu dominio y pasando todo — /, /api, /ws, /admin — al puerto 8080. Después reinicia para que server/.env surta efecto.",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "Qué aspecto tiene una instancia que funciona",
        body: [
          "El contenedor informa Up y ambos extremos responden. El que importa es ready: /healthz devuelve ok sin condiciones, antes de que se abra nada, así que también pasa en una instancia cuya base de datos o directorio de blobs es inservible. /readyz hace ping a la base de datos SQLite y al directorio de blobs, y responde 503 en cuanto uno de los dos falla.",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "El secreto tiene que llegar a dos sitios distintos, y equivocarse falla en silencio. coturn lo recibe por la sustitución de variables de Compose, que solo se resuelve desde el shell o desde un .env en la raíz del proyecto. El servidor lo lee de su propio entorno — es decir, de server/.env — y un secreto vacío desactiva TURN por completo. Si solo pones uno de los dos, acabas con un coturn en marcha para el que el servidor nunca emite credenciales: todos los contenedores se declaran sanos, no se registra nada, y las transferencias a través de NAT estrictos siguen fallando exactamente igual que antes.",
      ],
      steps: [
        {
          text: "Genera un único secreto aleatorio largo. Abajo se usa siempre el mismo valor.",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "Pon ese secreto, junto con las direcciones de retransmisión a las que apunta tu dominio, en server/.env: es lo que hace que el servidor active TURN.",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "Exporta ese mismo archivo al shell para que la sustitución de Compose pueda entregarle a coturn un secreto idéntico. Hacerle source mantiene una única fuente y deja el secreto fuera de la línea de órdenes, donde ps lo expondría.",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "Arranca la pila con el perfil relay.",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "Abre los puertos de retransmisión en el cortafuegos del host. coturn se ejecuta con la red del host, así que son reglas del host y no de Docker: UDP 3478 y 49152-65535, TCP 3478 y 5349.",
        },
        {
          text: "Comprueba que el servidor — y no solo coturn — ha arrancado con el secreto. Esta es la comprobación que caza el caso silencioso.",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "Qué aspecto tiene un retransmisor que funciona",
        body: [
          "Ambas claves vuelven no vacías desde dentro del contenedor del servidor. Que coturn esté en marcha no demuestra nada por sí solo: el navegador solo recibe credenciales de retransmisión emitidas por el servidor.",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
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
      steps: [
        {
          text: "En una máquina que ya tenga la CLI de la sección anterior, inicia sesión contra tu servidor en vez de contra relayium.com. Imprime una URL y un código; apruébalo en un navegador con sesión iniciada en tu instancia.",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "Comprueba a qué servidor están vinculadas las credenciales guardadas. whoami no acepta opciones: informa de lo que el inicio de sesión escribió de verdad, y eso es justo lo que hace que merezca la pena ejecutarlo.",
          code: ["relayium whoami"],
        },
        {
          text: "Pasa el mismo --server al enviar. Sin él, la CLI acuña el código de emparejamiento en relayium.com y el otro extremo no lo encontrará jamás en tu instancia.",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "Recibe en la otra máquina con el código impreso y el mismo --server. Las sesiones de texto funcionan igual.",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "Cómo sabes que está hablando con tu instancia",
        body: [
          "whoami imprime la cuenta y, entre paréntesis, el servidor al que está vinculada. Que ahí aparezca tu propio dominio y no relayium.com es la confirmación.",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "La CLI es gratis en cualquier caso — --server solo cambia el servidor de punto de encuentro. send o text sin código generan uno allí, y up guarda bajo una cuenta en ese servidor, así que inicia sesión primero con relayium login --server https://your-domain. receive, down y text con el código impreso no necesitan iniciar sesión.",
        "Ambos extremos de text deben permanecer en línea. Los mensajes usan su propia sesión P2P directa cifrada de extremo a extremo. text en la CLI es solo directo y no usa el relé TURN de la app web. Ni Relayium ni tu servidor autoalojado guardan el cuerpo de los mensajes ni un historial del servidor, pero cualquiera de los terminales o el destinatario puede copiar o conservar el texto después de recibirlo.",
        "push/pull (por tu propio SSH) y serve + el push daemon directo relayium://host no tocan relayium.com en absoluto, te autoalojes o no — se conectan directamente al remoto que indiques.",
      ],
    },
    {
      heading: "Cuando no funciona",
      body: [
        "Cinco fallos cubren casi todo autoalojamiento fallido. Cada uno tiene una línea que leer o una orden que ejecutar que lo zanja, y tres de los cinco parecen un éxito hasta que ejecutas la comprobación.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "docker compose up se niega a arrancar siquiera, antes de construir nada.",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "Compose sustituye las variables de todo el archivo antes de filtrar por perfiles, así que valida la variable requerida del servicio coturn desactivado incluso con el retransmisor apagado. Antepón cualquier valor de relleno — RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build — y sustitúyelo por un secreto real solo cuando actives de verdad el perfil relay.",
          },
          {
            symptom: "El contenedor está Up, pero un navegador de otra máquina no llega a él.",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "Esa vinculación al bucle local es el comportamiento por omisión, para que un host público no exponga HTTP en claro a internet. En producción déjala así y termina TLS en un proxy inverso del mismo host. Para una máquina solo de LAN sin proxy, publícalo más ampliamente con RELAYIUM_BIND=0.0.0.0 docker compose up -d: esa variable la lee compose, no el servidor.",
          },
          {
            symptom: "/healthz dice ok, pero el registro falla y los enlaces almacenados no aparecen nunca.",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "/healthz devuelve ok sin condiciones y solo demuestra que el proceso está escuchando. /readyz hace ping a la base de datos SQLite y al directorio de blobs, así que un 503 significa que uno de los dos es inservible: comprueba que el volumen relayium-data está montado y que RELAYIUM_DB y RELAYIUM_BLOB_DIR apuntan dentro de él.",
          },
          {
            symptom: "relayium login imprime una URL de verificación en localhost que no puedes abrir.",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "El servidor construye esa URL a partir de RELAYIUM_BASE_URL, cuyo valor por omisión es http://localhost:8080. Ponlo en server/.env con tu dirección https:// real y reinicia. También decide si las cookies de sesión llevan el atributo Secure, así que dejarlo mal no es solo cuestión de estética.",
          },
          {
            symptom: "coturn está en marcha, pero las transferencias entre redes a través de NAT estricto siguen fallando, y sin nada en los registros.",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# sin salida`,
            ],
            fix: "El secreto llegó a coturn por la sustitución de Compose pero nunca llegó al servidor, cuyo secreto vacío desactiva TURN por completo. Pon RELAYIUM_TURN_SECRET y RELAYIUM_TURN_URLS en server/.env, hazle source con set -a; . ./server/.env; set +a para que la sustitución vea el mismo valor, y reinicia el perfil relay. Ambas claves tienen que volver no vacías en esa comprobación.",
          },
        ],
      },
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
    "Auto-hospedar dá a você controle total sobre onde seus dados ficam, seu próprio domínio e certificado TLS, e nenhuma dependência da infraestrutura de mais ninguém. Tudo a seguir se baseia nos arquivos que acompanham o repositório — docker-compose.yml, server/.env.example e docs/self-hosting.md — então nada aqui é uma flag ou configuração que não exista de verdade.",
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
        "A raiz do repositório traz um Dockerfile e um docker-compose.yml que constroem uma única imagem autocontida — um binário Go estático que serve o aplicativo web pré-compilado, então não é preciso um Node, uma cadeia de ferramentas Go ou nginx separados só para executá-lo.",
      ],
      prereqs: {
        label: "O que você precisa antes do passo 1",
        items: [
          "Um host com o Docker Engine e o plugin do Compose. docker compose version imprime uma linha de versão; se aparecer «docker: 'compose' is not a docker command», o plugin não está instalado.",
          "Um clone do repositório. O arquivo compose constrói a imagem a partir desta árvore de fontes, então precisa do Dockerfile e de web/ ao lado dele — não existe imagem pronta para baixar.",
          "Espaço em disco para o volume nomeado relayium-data: o banco SQLite mais o texto cifrado das transferências armazenadas que você mantiver.",
          "Um domínio e um proxy reverso que termine TLS, caso alguém além de você vá usar. O contêiner só fala HTTP em claro e, por padrão, publica apenas na interface de loopback.",
          "Nada mais. Sem banco de dados externo, sem bucket de armazenamento de objetos, sem conta de terceiros.",
        ],
      },
      steps: [
        {
          text: "Clone o repositório e entre nele.",
          code: ["git clone https://github.com/relayium/relayium.git", "cd relayium"],
        },
        {
          text: "Construa e suba. O segredo de espaço reservado é obrigatório mesmo com o retransmissor desligado: o Compose valida a variável exigida pelo serviço coturn desativado por perfil já na hora de analisar o arquivo, de modo que um docker compose up puro se recusa a iniciar.",
          code: ["RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build"],
        },
        {
          text: "Confirme que o contêiner continuou de pé em vez de entrar em ciclo de reinício.",
          code: ["docker compose ps"],
        },
        {
          text: "Pergunte à instância se ela realmente consegue servir. Use /readyz, não /healthz: a diferença entre os dois é todo o sentido dessa checagem, e a caixa de resultado esperado abaixo explica por quê.",
          code: ["curl -s http://127.0.0.1:8080/readyz"],
        },
        {
          text: "Copie o modelo de configuração e defina sua URL pública. RELAYIUM_BASE_URL monta os links dos e-mails enviados e decide se os cookies de sessão levam o atributo Secure, então precisa ser seu endereço https:// de verdade.",
          code: ["cp server/.env.example server/.env", "chmod 600 server/.env"],
        },
        {
          text: "Coloque nginx ou Caddy na frente, terminando TLS para o seu domínio e encaminhando tudo — /, /api, /ws, /admin — para a porta 8080. Depois reinicie para que server/.env valha.",
          code: ["docker compose up -d"],
        },
      ],
      success: {
        label: "Como é uma instância que funciona",
        body: [
          "O contêiner informa Up e os dois endpoints respondem. O que importa é ready: /healthz devolve ok incondicionalmente, antes de qualquer coisa ser aberta, então também passa numa instância cujo banco ou diretório de blobs está inutilizável. /readyz faz ping no banco SQLite e no diretório de blobs, e responde 503 assim que um dos dois quebra.",
        ],
        code: [
          `$ docker compose ps
NAME                IMAGE                     STATUS          PORTS
relayium-server-1   relayium/relayium:local   Up 12 seconds   127.0.0.1:8080->8080/tcp

$ curl -s http://127.0.0.1:8080/healthz
ok
$ curl -s http://127.0.0.1:8080/readyz
ready`,
        ],
      },
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
        "O segredo precisa chegar a dois lugares diferentes, e errar isso falha em silêncio. O coturn o recebe pela substituição de variáveis do Compose, que só é resolvida a partir do shell ou de um .env na raiz do projeto. Já o servidor o lê do próprio ambiente — ou seja, de server/.env — e um segredo vazio desliga o TURN por completo. Se você definir só um dos dois, fica com um coturn rodando para o qual o servidor nunca emite credenciais: todos os contêineres se declaram saudáveis, nada é registrado, e as transferências através de NAT estrito continuam falhando exatamente como antes.",
      ],
      steps: [
        {
          text: "Gere um único segredo aleatório longo. É o mesmo valor em tudo abaixo.",
          code: ["openssl rand -hex 32"],
        },
        {
          text: "Coloque esse segredo, junto com os endereços de retransmissão para os quais seu domínio aponta, em server/.env: é isso que faz o servidor ativar o TURN.",
          code: [
            `RELAYIUM_TURN_SECRET=<the value from step 1>
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
          ],
        },
        {
          text: "Exporte esse mesmo arquivo para o shell, para que a substituição do Compose consiga entregar ao coturn um segredo idêntico. Dar source mantém uma fonte única e deixa o segredo fora da linha de comando, onde o ps o exporia.",
          code: ["set -a; . ./server/.env; set +a"],
        },
        {
          text: "Suba a pilha com o perfil relay.",
          code: ["docker compose --profile relay up -d --build"],
        },
        {
          text: "Abra as portas de retransmissão no firewall do host. O coturn roda com a rede do host, então são regras do host e não do Docker: UDP 3478 e 49152-65535, TCP 3478 e 5349.",
        },
        {
          text: "Confirme que o servidor — e não apenas o coturn — subiu com o segredo. É essa checagem que pega o caso silencioso.",
          code: ["docker compose exec server env | grep RELAYIUM_TURN"],
        },
      ],
      success: {
        label: "Como é um retransmissor que funciona",
        body: [
          "As duas chaves voltam não vazias de dentro do contêiner do servidor. O coturn estar no ar não prova nada sozinho: o navegador só recebe credenciais de retransmissão emitidas pelo servidor.",
        ],
        code: [
          `$ docker compose exec server env | grep RELAYIUM_TURN
RELAYIUM_TURN_SECRET=3f7a…
RELAYIUM_TURN_URLS=turn:example.com:3478,turns:example.com:5349`,
        ],
      },
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
      steps: [
        {
          text: "Numa máquina que já tenha a CLI da seção anterior, entre no seu servidor em vez de no relayium.com. Ele imprime uma URL e um código; aprove no navegador com sessão iniciada na sua instância.",
          code: ["relayium login --server https://your-domain"],
        },
        {
          text: "Confirme a qual servidor as credenciais salvas estão vinculadas. whoami não aceita flags: ele relata o que o login de fato gravou, e é justamente isso que faz valer a pena rodá-lo.",
          code: ["relayium whoami"],
        },
        {
          text: "Passe o mesmo --server ao enviar. Sem ele, a CLI cunha o código de emparelhamento no relayium.com e o outro lado nunca vai encontrá-lo na sua instância.",
          code: ["relayium send ./report.pdf --server https://your-domain"],
        },
        {
          text: "Receba na outra máquina com o código impresso e o mesmo --server. As sessões de texto funcionam do mesmo jeito.",
          code: [
            "relayium receive 483920 --server https://your-domain",
            "relayium text --server https://your-domain",
            "relayium text 483920 --server https://your-domain",
          ],
        },
      ],
      success: {
        label: "Como saber que ela está falando com a sua instância",
        body: [
          "whoami imprime a conta e, entre parênteses, o servidor a que ela está vinculada. Seu próprio domínio ali — e não relayium.com — é a confirmação.",
        ],
        code: [
          `$ relayium login --server https://your-domain
Open https://your-domain/device and enter code: WDJB-MJHT
logged in as you@example.com

$ relayium whoami
you@example.com (https://your-domain)`,
        ],
      },
      bullets: [
        "A CLI é gratuita em qualquer dos casos — --server apenas muda o servidor de encontro. send ou text sem código geram um código nele, e up guarda sob uma conta nesse servidor, então entre primeiro com relayium login --server https://your-domain. receive, down e text com o código impresso não precisam de login.",
        "As duas pontas de text precisam permanecer online. As mensagens usam uma sessão P2P direta própria, criptografada de ponta a ponta. text na CLI é apenas direto e não usa o retransmissor TURN do app web. Nem o Relayium nem o servidor auto-hospedado armazenam o corpo das mensagens ou um histórico no servidor, mas qualquer terminal ou destinatário pode copiar ou guardar o texto depois de recebê-lo.",
        "push/pull (pelo seu próprio SSH) e serve + o push daemon direto relayium://host não tocam o relayium.com em nada, com ou sem auto-hospedagem — eles se conectam diretamente ao remoto que você especificar.",
      ],
    },
    {
      heading: "Quando não funciona",
      body: [
        "Cinco falhas cobrem quase toda auto-hospedagem malsucedida. Cada uma tem uma linha para ler ou um comando para rodar que resolve a questão, e três das cinco parecem sucesso até você rodar a checagem.",
      ],
      troubleshooting: {
        label: "Sintoma, checagem, correção",
        items: [
          {
            symptom: "O docker compose up se recusa a iniciar, antes mesmo de construir qualquer coisa.",
            code: [
              `docker compose up -d --build
# required variable RELAYIUM_TURN_SECRET is missing a value`,
            ],
            fix: "O Compose substitui as variáveis do arquivo inteiro antes de filtrar por perfis, então a variável exigida pelo serviço coturn desativado é validada mesmo com o retransmissor desligado. Prefixe qualquer valor de espaço reservado — RELAYIUM_TURN_SECRET=placeholder docker compose up -d --build — e troque por um segredo real só quando de fato ativar o perfil relay.",
          },
          {
            symptom: "O contêiner está Up, mas um navegador em outra máquina não chega nele.",
            code: [
              `docker compose ps
# PORTS  127.0.0.1:8080->8080/tcp`,
            ],
            fix: "Esse vínculo com o loopback é o padrão, para que um host público não exponha HTTP em claro na internet. Em produção, deixe assim e termine TLS num proxy reverso no mesmo host. Para uma máquina só de LAN sem proxy, publique de forma mais ampla com RELAYIUM_BIND=0.0.0.0 docker compose up -d: essa variável é lida pelo compose, não pelo servidor.",
          },
          {
            symptom: "O /healthz diz ok, mas o cadastro falha e os links armazenados nunca aparecem.",
            code: [
              `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8080/readyz
# 503`,
            ],
            fix: "O /healthz devolve ok incondicionalmente e só prova que o processo está escutando. O /readyz faz ping no banco SQLite e no diretório de blobs, então um 503 significa que um dos dois está inutilizável: verifique se o volume relayium-data está montado e se RELAYIUM_DB e RELAYIUM_BLOB_DIR apontam para dentro dele.",
          },
          {
            symptom: "O relayium login imprime uma URL de verificação em localhost que você não consegue abrir.",
            code: [
              `relayium login --server https://your-domain
# Open http://localhost:8080/device and enter code: WDJB-MJHT`,
            ],
            fix: "O servidor monta essa URL a partir de RELAYIUM_BASE_URL, cujo padrão é http://localhost:8080. Defina em server/.env o seu endereço https:// real e reinicie. Ela também decide se os cookies de sessão levam o atributo Secure, então deixá-la errada não é só questão de aparência.",
          },
          {
            symptom: "O coturn está rodando, mas as transferências entre redes através de NAT estrito continuam falhando — e sem nada nos registros.",
            code: [
              `docker compose exec server env | grep RELAYIUM_TURN
# nenhuma saída`,
            ],
            fix: "O segredo chegou ao coturn pela substituição do Compose, mas nunca chegou ao servidor, cujo segredo vazio desliga o TURN por completo. Coloque RELAYIUM_TURN_SECRET e RELAYIUM_TURN_URLS em server/.env, dê source com set -a; . ./server/.env; set +a para que a substituição enxergue o mesmo valor, e reinicie o perfil relay. As duas chaves precisam voltar não vazias nessa checagem.",
          },
        ],
      },
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
  updated: "2026-08-06",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }, selfHostInstall),
};
