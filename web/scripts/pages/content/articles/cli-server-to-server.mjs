// web/scripts/pages/content/articles/cli-server-to-server.mjs
// How-to: server-to-server transfers with relayium daemon direct (serve + push relayium://).
// English is the master; every other locale follows the same structure and facts.
// Commands stay English in every language; the # comments around them are translated.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Server-to-server transfers with the Relayium CLI (daemon direct)",
  description:
    "Move files straight between two servers you control with relayium serve and push relayium:// — over pinned TLS, no relay, no SSH, no pairing code. Approve a new pusher once on its first push, then automate it or run it under systemd.",
  updatedLabel: "Last updated",
  lead: [
    "When both machines are yours and each knows the other's address, SSH is extra friction and a rendezvous is pure overhead. Daemon direct is built for exactly this: one server listens, the other pushes straight to it over a pinned TLS 1.3 connection. No relay, no SSH, no pairing code — trust is public-key and set up once.",
    "This guide covers starting the listener, pushing to it, approving a new pusher on first contact, automating it, and running the listener as a systemd service.",
  ],
  sections: [
    {
      heading: "Start the listener (on the receiver)",
      prereqs: {
        label: "What you need",
        items: [
          "Two machines you control, with the receiver's address reachable from the sender. A hostname or a bare IP both work.",
          "relayium on both ends. Daemon direct speaks the native protocol only, so there is no tar fallback to rescue a missing install here.",
          "The listener's port open to the sender — 9031/TCP unless you change it — in the host firewall and in any cloud security group.",
          "A terminal on the receiver for the first push, so you can answer the approval prompt. With no terminal, pre-authorize the sender instead (see below).",
        ],
      },
      body: [
        "On the receiving server, serve listens for pushes and writes them into a directory. It's long-running by default; add --once to accept a single transfer and exit. You don't pre-share anything — no fingerprints to copy up front:",
      ],
      steps: [
        {
          text: "Create the directory pushes should land in.",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "Open the listener's port to the sender only. Substitute the sender's own address for 203.0.113.7 — its public IP, or its private one when the two servers share a network — and scope the cloud security group to that same source rather than to the whole internet.",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "Start the listener in a terminal, so there is someone to answer the approval prompt on the first push. Add --once to take a single transfer and exit, or --port to move off 9031.",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "What a running listener looks like",
        body: [
          "serve names the address it bound, the directory it writes into, and this host's own fingerprint. With no approved peers yet, it also says it will ask about each new one.",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
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
      steps: [
        {
          text: "Run the push from the sending server. On the very first connection it stops right here, while the receiver approves it.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "Answer the prompt on the receiver — that is the next section. The push then finishes on its own, and later pushes never stop here again.",
        },
        {
          text: "Append a port when the listener isn't on 9031.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "What a successful push looks like",
        body: [
          "On first contact the sender learns and pins the listener's fingerprint, then transfers. The receiver records the pusher's fingerprint and reports the file and byte count.",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
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
    {
      heading: "When a push doesn't get through",
      body: [
        "Reachability and trust are the first two things to check: ss -tinp on the sender says whether the listener was reached at all, and relayium authorize on the receiver grants the trust a rejected pusher is missing. They are not the only ways a push can fail — a receiver out of disk space, an inbox its user cannot write into, or a transferred file whose integrity check fails all report themselves — so read the error in front of you rather than assuming it is one of the four below.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "The push sits there, then fails with a connection error.",
            code: [
              `# on the SENDER, while the push is running — run it twice, a few seconds apart
ss -tinp dst :9031
# ESTAB    the listener was reached; says nothing about progress
# SYN-SENT nothing answered on that port`,
            ],
            fix: "SYN-SENT means the packets never reached a listening socket. Confirm serve is up on the receiver with ss -tlnp | grep 9031, then open 9031/TCP to the sender in the host firewall and the cloud security group. ESTAB proves reachability only — an established socket can sit idle or stall — so to separate a live transfer from a stalled one, run the check twice a few seconds apart and compare the bytes_acked counter that -i prints for that socket. There is no relay path here, so an unreachable listener is a hard failure rather than a slow one.",
          },
          {
            symptom: "The serve log says \"rejected unauthorized peer …\" and the push fails.",
            code: [
              `# on the SENDER
relayium id
# 74318e3b…

# on the RECEIVER
relayium authorize 74318e3b…`,
            ],
            fix: "serve had no terminal to ask on — a systemd unit or a pipe — so an unknown fingerprint is refused rather than trusted. Pre-authorize it: the fingerprint in the rejection line is exactly the one relayium id prints on the sender, and authorize is idempotent.",
          },
          {
            symptom: "\"fingerprint mismatch for receiver.example.com:9031\".",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "The listener presented a different key than the one pinned on first contact. If you rotated that key on purpose, delete the matching known_hosts line and push again. If you did not, leave the line alone and find out why the key changed before sending anything.",
          },
          {
            symptom: "The systemd unit dies at startup with an insecure-permissions error.",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "relayium refuses to load a private key that anyone but its owner can read, the same rule ssh applies. Run chmod 600 on the path the error names, make sure it is owned by the service user, and restart the unit.",
          },
        ],
      },
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
  title: "用 Relayium CLI 实现服务器到服务器直传（daemon 直连）",
  description:
    "用 relayium serve 和 push relayium:// 在你自己掌控的两台服务器之间直接搬运文件——基于证书固定的 TLS，无需中继、无需 SSH、无需配对码。在新的推送方首次推送时批准一次，之后即可自动化，或在 systemd 下运行。",
  updatedLabel: "最近更新",
  lead: [
    "当两台机器都是你自己的，并且彼此知道对方地址时，用 SSH 是白绕一道，走会合服务器更是纯粹的额外开销。daemon 直连正是为此而生：一台服务器监听，另一台通过证书固定的 TLS 1.3 连接直接推送过去。无需中继、无需 SSH、无需配对码——信任基于公钥，只需设置一次。",
    "本指南涵盖启动监听端、向其推送、在首次联系时批准新的推送方、实现自动化，以及把监听端作为 systemd 服务运行。",
  ],
  sections: [
    {
      heading: "启动监听端（在接收方）",
      prereqs: {
        label: "你需要准备",
        items: [
          "两台你自己掌控的机器，并且接收方的地址从发送方可达。主机名或裸 IP 都行。",
          "两端都装好 relayium。daemon 直连只说原生协议，所以这里没有 tar 兜底来救一台没装的机器。",
          "把监听端的端口对发送方开放——默认是 9031/TCP——主机防火墙和云安全组都要开。",
          "接收方在第一次推送时要有一个终端，好回答批准提示。没有终端的话，请改为预先授权发送方（见下文）。",
        ],
      },
      body: [
        "在接收方服务器上，serve 监听推送并把它们写入某个目录。它默认长期运行；加上 --once 可以只接受一次传输就退出。你不需要预先共享任何东西——不用提前复制任何指纹：",
      ],
      steps: [
        {
          text: "建好推送要落地的目录。",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "只对发送方开放监听端的端口。把 203.0.113.7 换成发送方自己的地址——公网 IP，或者两台服务器同处一个内网时的内网 IP——并且把云安全组也收敛到同一个来源，而不是对整个互联网开放。",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "在终端里启动监听端，这样第一次推送时才有人回答批准提示。加 --once 只接一次传输就退出，加 --port 可以离开 9031。",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "监听端跑起来是什么样",
        body: [
          "serve 会写明它绑定的地址、写入的目录，以及本机自己的指纹。在还没有已批准的对端时，它还会说明每遇到一个新对端都会来问你。",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
      bullets: [
        "监听端依次处理连接，并把文件落到 --dir 指定的目录下。",
        "默认端口是 9031；可用 --port 修改，并在防火墙上开放该端口。",
      ],
    },
    {
      heading: "向监听端推送（在发送方）",
      body: [
        "从发送方服务器，推送到接收方的 relayium:// 地址。第一次连接会固定接收方的指纹；此后每次连接都会校验它，指纹一旦变化，监听端就会拒绝连接，而不会默默放行——密钥掉包或中间人攻击会当场暴露，不会被当成可信。在第一次推送时，发送方会稍等片刻，等待接收方批准（下一步）。",
      ],
      steps: [
        {
          text: "在发送方服务器上执行推送。第一次连接时它会正好停在这里，等接收方批准。",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "在接收方回答那个提示——就是下一节的内容。之后推送会自己走完，以后的推送也不会再停在这里。",
        },
        {
          text: "监听端不在 9031 时，在地址后面加上端口。",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "推送成功是什么样",
        body: [
          "第一次接触时，发送方会学到并固定监听端的指纹，然后开始传输。接收方会记下推送方的指纹，并报告文件数和字节数。",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
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
        `# 在接收方，当有新的发送方推送时：
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "回答 y，该指纹就会记入 authorized_fingerprints；此后同一台机器的每次推送都会静默通过。",
        "指纹是一台机器的稳定身份（重启和 IP 变化都不受影响），因此批准对每个推送方来说只是一次性的步骤。",
        "推送方则在首次连接时获知监听端的密钥（首次使用即信任），并将其固定在 known_hosts 中。",
      ],
    },
    {
      heading: "实现自动化（或在没有终端的环境下运行）",
      body: [
        "由于已批准的指纹会一直保留，后续推送不再需要确认——因此 relayium push 可以直接接入 cron、部署脚本或 CI，实现加密、可校验完整性、可续传的服务器到服务器同步。当 serve 在没有终端的环境下运行（作为 systemd 服务、通过管道）时，它无法弹出提示，因此会拒绝未知的推送方；这时应改为预先授权它们。可以从推送方的 relayium id 获取指纹，或者从 serve 日志中「rejected unauthorized peer …」那一行复制它，然后：",
      ],
      code: [
        `# 在接收方：无需提示，预先授权一个发送方
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
        "让 /etc/relayium/id.key 只对服务用户可读——权限过于宽松时 relayium 会拒绝加载该密钥。",
      ],
    },
    {
      heading: "推送不通的时候",
      body: [
        "先查的是可达性和信任这两件事：在发送方跑 ss -tinp，能看出监听端到底通没通；在接收方跑 relayium authorize，则是把被拒绝的发送方缺的那份信任补上。但推送出错的方式不止这两类——接收方磁盘满了、收件目录对运行它的用户不可写、某个文件传完后过不了完整性校验，这些都会自己报错——所以请先看眼前的报错，而不是假定它一定是下面四种之一。",
      ],
      troubleshooting: {
        label: "现象、检查、修复",
        items: [
          {
            symptom: "推送一直挂着，最后报连接错误。",
            code: [
              `# 在发送方，推送还在跑的时候——隔几秒跑两次
ss -tinp dst :9031
# ESTAB    说明够得着监听端，但不说明有没有进展
# SYN-SENT 那个端口上没人应答`,
            ],
            fix: "SYN-SENT 意味着数据包根本没到达一个正在监听的套接字。先在接收方用 ss -tlnp | grep 9031 确认 serve 起着，再在主机防火墙和云安全组里把 9031/TCP 对发送方开放。ESTAB 只能证明够得着——一条已建立的连接照样可以闲着或者卡住——所以要区分「在传」和「卡住」，得隔几秒把这条检查跑两次，比较 -i 为该套接字打印的 bytes_acked 计数。这里没有中继通路，所以监听端不可达是硬失败，而不是变慢。",
          },
          {
            symptom: "serve 日志里写着 “rejected unauthorized peer …”，推送失败。",
            code: [
              `# 在发送方
relayium id
# 74318e3b…

# 在接收方
relayium authorize 74318e3b…`,
            ],
            fix: "serve 当时没有终端可问——比如跑在 systemd 下或接了管道——所以对未知指纹选择拒绝而不是信任。预先授权即可：拒绝那行里的指纹，正是发送方 relayium id 打印出来的那个，而 authorize 是幂等的。",
          },
          {
            symptom: "“fingerprint mismatch for receiver.example.com:9031”。",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "监听端出示的密钥，和首次接触时固定下来的那把不一样。如果是你自己有意轮换了密钥，就删掉对应的 known_hosts 那一行再推。如果不是，先别动那一行，弄清楚密钥为什么变了，再发任何东西。",
          },
          {
            symptom: "systemd 单元一启动就因为权限不安全而退出。",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "relayium 拒绝加载一把除属主之外还有人能读的私钥，这和 ssh 的规矩一样。对报错里给出的路径执行 chmod 600，确认它属于那个服务用户，然后重启单元。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "daemon 直连和通过 SSH 推送有什么不同？",
        a: "通过 SSH 推送会把传输隧道进你的 SSH 连接，并且需要在远端有一个 SSH 账号。daemon 直连不需要 SSH，也不需要账号——两台服务器通过证书固定的 TLS，用证书指纹互相验证身份，当两台机器都是你自己的时候，这样更轻量。",
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
        a: "监听端会拒绝这次推送并发出警告。监听端的密钥在首次使用时就固定在 known_hosts 中，因此之后的变化——无论是主机重新生成了密钥，还是中间人攻击——都会遭到拒绝，而不会默默放行。只有在你确实主动轮换了密钥时，才应删除 known_hosts 中对应的那一行。",
      },
      {
        q: "有没有中继回退？",
        a: "没有。daemon 直连假定监听端地址是可达的；如果无法建立连接，就会失败。任何数据都绝不会经由 Relayium 代理——这正是这个模式的意义所在。",
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
  title: "Relayium CLI でサーバー間転送（デーモン直結）",
  description:
    "relayium serve と push relayium:// を使い、自分が管理する2台のサーバー間でファイルを直接やり取りします。証明書ピンニング付き TLS 上で、リレーも SSH もペアリングコードも不要です。新しいプッシュ側が最初にプッシュしたときに一度だけ承認し、その後は自動化するか systemd の下で実行します。",
  updatedLabel: "最終更新",
  lead: [
    "両方のマシンが自分のもので、互いのアドレスを知っている場合、SSH は余計な手間であり、ランデブーは純粋なオーバーヘッドです。デーモン直結はまさにこのために作られています。一方のサーバーが待ち受け、もう一方が証明書ピンニング付き TLS 1.3 接続でそこへ直接プッシュします。リレーも SSH もペアリングコードも不要。信頼は公開鍵によるもので、一度設定すれば済みます。",
    "本ガイドではリスナーの起動、そこへのプッシュ、初回接触時に新しいプッシュ側を承認すること、自動化、そしてリスナーを systemd サービスとして実行する方法を扱います。",
  ],
  sections: [
    {
      heading: "リスナーを起動する（受信側）",
      prereqs: {
        label: "必要なもの",
        items: [
          "自分で管理する2台のマシン。受信側のアドレスが送信側から到達できることが条件です。ホスト名でも生の IP でも構いません。",
          "両端の relayium。デーモン直結はネイティブプロトコルしか話さないので、未インストールを救う tar フォールバックはここにはありません。",
          "リスナーのポートを送信側に開けること。変更しなければ 9031/TCP で、ホストのファイアウォールとクラウドのセキュリティグループの両方が対象です。",
          "初回プッシュのために受信側の端末。承認プロンプトに答えるためです。端末が無い場合は、代わりに送信側を事前承認します（後述）。",
        ],
      },
      body: [
        "受信側のサーバーでは、serve がプッシュを待ち受け、あるディレクトリへ書き込みます。デフォルトでは常駐し続けます。--once を付けると1回の転送だけを受け取って終了します。事前に何かを共有しておく必要はありません。あらかじめコピーしておくフィンガープリントもありません：",
      ],
      steps: [
        {
          text: "プッシュが着地するディレクトリを作ります。",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "リスナーのポートは送信側にだけ開けます。203.0.113.7 は送信側自身のアドレス——グローバル IP、2台が同じネットワークにいるならプライベート IP——に置き換え、クラウドのセキュリティグループもインターネット全体ではなく同じ送信元だけに絞ってください。",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "初回プッシュの承認プロンプトに答える人がいるよう、端末でリスナーを起動します。--once を足せば1回受けて終了、--port なら 9031 以外に移せます。",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "リスナーが動いているときの表示",
        body: [
          "serve は待ち受けたアドレス、書き込み先ディレクトリ、そしてこのホスト自身のフィンガープリントを表示します。承認済みのピアがまだ無いときは、新しいピアごとに確認する旨も表示します。",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
      bullets: [
        "リスナーは接続を1つずつ処理し、ファイルを --dir の下に配置します。",
        "デフォルトのポートは 9031 です。--port で変更し、ファイアウォールで開放してください。",
      ],
    },
    {
      heading: "リスナーへプッシュする（送信側）",
      body: [
        "送信側のサーバーから、受信側の relayium:// アドレスへプッシュします。最初の接続で受信側のフィンガープリントが固定され、以降の接続はすべてそれを検証します。フィンガープリントが変わった場合は黙って受け入れられるのではなく拒否されます。鍵のすり替えや中間者攻撃はそのまま信頼されるのではなく、検知されます。最初のプッシュでは、受信側が承認するまでの間、送信側は少し待機します（次のステップ）。",
      ],
      steps: [
        {
          text: "送信側のサーバーでプッシュを実行します。ごく最初の接続では、受信側が承認するまでちょうどここで止まります。",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "受信側でプロンプトに答えます。次の節がそれです。あとはプッシュが自力で完了し、以後のプッシュがここで止まることはありません。",
        },
        {
          text: "リスナーが 9031 以外にいる場合は、末尾にポートを付けます。",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "プッシュが成功したときの表示",
        body: [
          "初回接触で送信側はリスナーのフィンガープリントを学習してピン留めし、そのまま転送します。受信側はプッシュ元のフィンガープリントを記録し、ファイル数とバイト数を報告します。",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
      bullets: [
        "リレーもフォールバックもありません。リスナーに到達できなければプッシュは失敗します。ファイルのバイト列が他の誰かを経由することは決してありません。",
        "他のモードと同じ転送エンジンです。再開可能で、ファイルごとに SHA-256 チェックが行われます。",
      ],
    },
    {
      heading: "初回プッシュ時に送信側を承認する（受信側）",
      body: [
        "新しいマシンが初めて自分のリスナーへプッシュすると、serve は（ターミナルで）その送信元とフィンガープリントを表示し、承認するかどうかを尋ねます。SSH の初回接続時のプロンプトに似ていますが、受信側で行われる点が異なります：",
      ],
      code: [
        `# 受信側で、新しい送信側がプッシュしたとき:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "y と答えると、そのフィンガープリントが authorized_fingerprints に記録されます。以降、同じマシンからのプッシュはすべて確認なしで通過します。",
        "フィンガープリントはそのマシンの安定したアイデンティティであり（再起動や IP の変更を経ても変わりません）、承認はプッシュ側ごとに一度だけで済みます。",
        "プッシュ側は、初回接続時にリスナーの鍵を学習し（信頼オンファーストユース）、known_hosts に固定します。",
      ],
    },
    {
      heading: "自動化する（またはターミナルなしで実行する）",
      body: [
        "承認済みのフィンガープリントは記憶されるため、以降のプッシュにはプロンプトが不要になります。そのため relayium push は cron、デプロイスクリプト、CI にそのまま組み込め、暗号化・整合性チェック済み・再開可能なサーバー間同期を実現します。serve がターミナルなしで動作している場合（systemd サービスやパイプなど）はプロンプトを出せないため、未知のプッシュ側を拒否します。その場合は事前に承認してください。フィンガープリントはプッシュ側で relayium id を実行して取得するか、serve のログにある「rejected unauthorized peer …」の行からコピーし、次のように実行します：",
      ],
      code: [
        `# 受信側で: プロンプトなしに送信側を事前承認する
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "アイデンティティと信頼のファイルは ~/.config/relayium/ にあります（サービスとして使う場合など、--config-dir で /etc/relayium などに上書きできます）。",
        "authorize は冪等です。同じフィンガープリントに対して再度実行しても何も起こりません。",
      ],
    },
    {
      heading: "systemd でリスナーを実行する",
      body: [
        "常時稼働の受信箱にするには、serve を systemd サービスとして実行します。--config-dir を /etc/relayium のような固定の場所に向けて、再起動をまたいでアイデンティティを安定させ、生存は systemd に任せます：",
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
        "/etc/relayium/id.key はサービスユーザーだけが読めるようにしてください。権限が緩い鍵は relayium が読み込みを拒否します。",
      ],
    },
    {
      heading: "プッシュが通らないとき",
      body: [
        "まず見るのは到達性と信頼の2つです。送信側で ss -tinp を実行すればリスナーに届いているかが分かり、受信側の relayium authorize は、拒否された送信側に足りない信頼を与えます。ただしプッシュが失敗する道はこの2種類だけではありません。受信側のディスクが一杯、受信ディレクトリに実行ユーザーが書き込めない、転送されたファイルが整合性チェックに落ちる——どれも自分でエラーを出します。ですから下の4つのどれかだと決めてかからず、目の前のエラーを読んでください。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "プッシュがそのまま止まり、最後に接続エラーで失敗する。",
            code: [
              `# 送信側で、プッシュ実行中に — 数秒あけて2回実行する
ss -tinp dst :9031
# ESTAB    リスナーに届いたことだけを示し、進捗までは示さない
# SYN-SENT そのポートで誰も応答していない`,
            ],
            fix: "SYN-SENT は、パケットが待ち受け中のソケットまで届いていないという意味です。受信側で ss -tlnp | grep 9031 を実行して serve が起動しているか確かめ、ホストのファイアウォールとクラウドのセキュリティグループで 9031/TCP を送信側に開けてください。ESTAB が示すのは到達できたことだけで、確立済みのソケットが無通信のまま止まっていることもあります。動いているのか止まっているのかを見分けるには、このチェックを数秒あけて2回実行し、-i がそのソケットについて表示する bytes_acked カウンターを比べてください。ここにはリレー経路が無いので、届かないリスナーは遅いのではなく完全な失敗です。",
          },
          {
            symptom: "serve のログに「rejected unauthorized peer …」と出てプッシュが失敗する。",
            code: [
              `# 送信側で
relayium id
# 74318e3b…

# 受信側で
relayium authorize 74318e3b…`,
            ],
            fix: "serve に尋ねる相手の端末が無かった（systemd ユニットやパイプ）ため、未知のフィンガープリントは信頼されずに拒否されます。事前に承認してください。拒否行のフィンガープリントは送信側の relayium id が表示するものとまったく同じで、authorize は何度実行しても同じ結果です。",
          },
          {
            symptom: "「fingerprint mismatch for receiver.example.com:9031」。",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "リスナーが、初回接触でピン留めした鍵とは別の鍵を提示しました。意図して鍵を更新したのなら、該当する known_hosts の行を削除してからプッシュし直します。そうでないなら行はそのままにして、鍵が変わった理由が分かるまで何も送らないでください。",
          },
          {
            symptom: "systemd ユニットが起動時にパーミッション不備のエラーで落ちる。",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "relayium は所有者以外にも読める秘密鍵の読み込みを拒否します。ssh と同じ規則です。エラーが示すパスに chmod 600 を実行し、所有者がサービス用ユーザーであることを確かめて、ユニットを再起動してください。",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "デーモン直結は SSH 経由の push と何が違いますか？",
        a: "SSH 経由の push は転送を SSH 接続のトンネルに通し、リモート側に SSH アカウントが必要です。デーモン直結には SSH もアカウントも不要です。2台のサーバーは証明書ピンニング付き TLS 上で証明書のフィンガープリントによって互いを認証します。両方のマシンが自分のものである場合、これはより軽量です。",
      },
      {
        q: "フィンガープリントを手作業でコピーして回る必要がありますか？",
        a: "いいえ。ターミナルでは、serve が新しいプッシュ側の初回プッシュ時にそのアドレスとフィンガープリントを表示し、承認するかどうかを尋ね、それを記憶します。そのため以降のプッシュは確認なしで進みます。relayium id や relayium authorize が必要になるのは、systemd サービスのようにプロンプトに応答する人がいない非対話的な環境を設定する場合だけです。",
      },
      {
        q: "アイデンティティと信頼のファイルはどこにありますか？",
        a: "デフォルトでは ~/.config/relayium/ にあります（--config-dir で上書き可能）。id.key / id.crt はこのホストの永続的なアイデンティティ、known_hosts はプッシュ先にしたリスナーのフィンガープリントを保持し、authorized_fingerprints はリスナー側のプッシュ元許可リストです。",
      },
      {
        q: "フィンガープリントが変わったらどうなりますか？",
        a: "プッシュは拒否され、警告が出ます。リスナーの鍵は初回使用時に known_hosts に固定されるため、その後の変化（鍵を再生成したホスト、あるいは中間者攻撃）は黙って受け入れられるのではなく拒否されます。known_hosts の該当行を削除するのは、意図的に鍵をローテーションした場合だけにしてください。",
      },
      {
        q: "リレーへのフォールバックはありますか？",
        a: "ありません。デーモン直結はリスナーのアドレスに到達できることを前提としています。接続できなければ失敗します。何ものも Relayium を経由してプロキシされることはありません。それがこのモードの要点です。",
      },
    ],
  },
  cta: {
    text: "自分の2台のサーバーをつないで直接転送しましょう。リレーも SSH もペアリングコードも不要です。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 서버 간 전송(데몬 다이렉트)",
  description:
    "relayium serve와 push relayium://로 직접 관리하는 두 서버 사이에서 파일을 곧바로 옮기세요. 인증서 고정 TLS를 통해, 릴레이도 SSH도 페어링 코드도 필요 없습니다. 새로운 푸시하는 쪽이 처음 푸시할 때 한 번만 승인하면, 이후 자동화하거나 systemd 아래에서 실행할 수 있습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "두 기기가 모두 내 것이고 서로의 주소를 알고 있다면, SSH는 불필요한 마찰이고 랑데부는 순전한 오버헤드입니다. 데몬 다이렉트는 정확히 이를 위해 만들어졌습니다. 한쪽 서버는 대기하고, 다른 쪽은 인증서 고정 TLS 1.3 연결로 그곳에 곧바로 푸시합니다. 릴레이도 SSH도 페어링 코드도 없습니다. 신뢰는 공개 키 방식이며 한 번만 설정하면 됩니다.",
    "이 가이드는 리스너 시작하기, 리스너로의 푸시, 처음 접촉했을 때 새로운 푸시하는 쪽 승인하기, 자동화하기, 그리고 리스너를 systemd 서비스로 실행하는 방법을 다룹니다.",
  ],
  sections: [
    {
      heading: "리스너 시작하기(받는 쪽)",
      prereqs: {
        label: "필요한 것",
        items: [
          "직접 관리하는 두 대의 기기, 그리고 보내는 쪽에서 닿을 수 있는 받는 쪽 주소. 호스트명이든 생 IP든 됩니다.",
          "양쪽 모두의 relayium. 데몬 다이렉트는 네이티브 프로토콜만 쓰므로, 설치 누락을 구해 줄 tar 대체 방식이 여기에는 없습니다.",
          "보내는 쪽에 열린 리스너 포트 — 바꾸지 않았다면 9031/TCP — 호스트 방화벽과 클라우드 보안 그룹 양쪽에서.",
          "첫 푸시 때 승인 프롬프트에 답할 수 있도록 받는 쪽의 터미널. 터미널이 없다면 대신 보내는 쪽을 미리 승인하세요(아래 참고).",
        ],
      },
      body: [
        "받는 쪽 서버에서 serve는 푸시를 대기하고 이를 어떤 디렉터리에 기록합니다. 기본적으로 계속 실행되며, --once를 추가하면 한 번의 전송만 받고 종료합니다. 미리 공유해야 할 것은 아무것도 없습니다. 미리 복사해 둘 핑거프린트도 없습니다:",
      ],
      steps: [
        {
          text: "푸시가 도착할 디렉터리를 만듭니다.",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "리스너의 포트를 보내는 쪽에만 엽니다. 203.0.113.7 은 보내는 쪽 자신의 주소——공인 IP, 두 서버가 같은 네트워크에 있다면 사설 IP——로 바꾸고, 클라우드 보안 그룹도 인터넷 전체가 아니라 같은 출발지로 좁히세요.",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "첫 푸시의 승인 프롬프트에 답할 사람이 있도록 터미널에서 리스너를 시작합니다. --once 를 붙이면 한 번 받고 종료하고, --port 로 9031을 벗어날 수 있습니다.",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "리스너가 떠 있을 때 보이는 것",
        body: [
          "serve는 바인딩한 주소, 파일을 쓰는 디렉터리, 그리고 이 호스트 자신의 지문을 알려 줍니다. 승인된 피어가 아직 없으면 새 피어마다 물어보겠다는 안내도 함께 나옵니다.",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
      bullets: [
        "리스너는 연결을 한 번에 하나씩 처리하며 파일을 --dir 아래에 내려놓습니다.",
        "기본 포트는 9031입니다. --port로 변경하고 방화벽에서 열어 두세요.",
      ],
    },
    {
      heading: "리스너로 푸시하기(보내는 쪽)",
      body: [
        "보내는 쪽 서버에서 받는 쪽의 relayium:// 주소로 푸시하세요. 첫 연결에서 받는 쪽의 핑거프린트가 고정되고, 이후 모든 연결은 이를 검증합니다. 핑거프린트가 바뀌면 조용히 받아들여지는 대신 거부됩니다. 그래서 키가 바뀌었거나 중간자 공격이 있으면 신뢰되는 대신 발견됩니다. 첫 푸시에서는 받는 쪽이 승인할 때까지 보내는 쪽이 잠시 대기합니다(다음 단계).",
      ],
      steps: [
        {
          text: "보내는 서버에서 푸시를 실행합니다. 맨 처음 연결에서는 받는 쪽이 승인할 때까지 바로 여기서 멈춥니다.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "받는 쪽에서 프롬프트에 답합니다 — 바로 다음 절의 내용입니다. 그 뒤로 푸시는 스스로 끝나고, 이후의 푸시는 다시는 여기서 멈추지 않습니다.",
        },
        {
          text: "리스너가 9031이 아니라면 주소 뒤에 포트를 덧붙입니다.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "푸시가 성공했을 때 보이는 것",
        body: [
          "첫 접촉에서 보내는 쪽이 리스너의 지문을 배워 고정한 뒤 전송합니다. 받는 쪽은 푸시한 기기의 지문을 기록하고 파일 수와 바이트 수를 보고합니다.",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
      bullets: [
        "릴레이도 폴백도 없습니다. 리스너에 도달할 수 없으면 푸시는 실패합니다. 파일 바이트는 결코 다른 누군가를 거쳐 전달되지 않습니다.",
        "다른 모드와 동일한 전송 엔진입니다. 재개 가능하며 파일별 SHA-256 검사를 수행합니다.",
      ],
    },
    {
      heading: "첫 푸시 시 보내는 쪽 승인하기(받는 쪽)",
      body: [
        "새 기기가 리스너로 처음 푸시하면, serve는(터미널에서) 그 출처와 핑거프린트를 보여주고 승인할지 물어봅니다. SSH의 첫 연결 프롬프트와 비슷하지만, 받는 쪽에서 이루어진다는 점이 다릅니다:",
      ],
      code: [
        `# 받는 쪽에서, 새 보내는 쪽이 푸시할 때:
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
        "승인된 핑거프린트는 기억되므로 이후의 푸시에는 확인이 필요 없습니다. 따라서 relayium push는 cron, 배포 스크립트, CI에 곧바로 연결되어 암호화되고 무결성이 검증되며 재개 가능한 서버 간 동기화를 제공합니다. serve가 터미널 없이 실행될 때(systemd 서비스, 파이프 등)는 프롬프트를 띄울 수 없으므로 알 수 없는 푸시하는 쪽을 거부합니다. 대신 미리 승인해 두세요. 핑거프린트는 푸시하는 쪽에서 relayium id로 얻거나, serve 로그의 “rejected unauthorized peer …” 줄에서 복사한 뒤 다음을 실행하세요:",
      ],
      code: [
        `# 받는 쪽에서: 프롬프트 없이 보내는 쪽을 미리 승인
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "신원 및 신뢰 파일은 ~/.config/relayium/에 있습니다(서비스로 쓸 때는 --config-dir로 /etc/relayium 같은 곳으로 재정의할 수 있습니다).",
        "authorize는 멱등적입니다. 같은 핑거프린트에 대해 다시 실행해도 아무 효과가 없습니다.",
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
        "/etc/relayium/id.key는 서비스 사용자만 읽을 수 있게 하세요. 권한이 느슨한 키는 relayium이 불러오기를 거부합니다.",
      ],
    },
    {
      heading: "푸시가 통하지 않을 때",
      body: [
        "먼저 볼 것은 도달성과 신뢰, 이 두 가지입니다. 보내는 쪽에서 ss -tinp 를 돌리면 리스너에 닿기는 했는지 알 수 있고, 받는 쪽의 relayium authorize 는 거부당한 보내는 쪽에 없는 신뢰를 부여합니다. 다만 푸시가 실패하는 방식이 이 둘뿐인 것은 아닙니다. 받는 쪽 디스크가 꽉 찼거나, 받는 디렉터리에 실행 사용자가 쓸 수 없거나, 전송된 파일이 무결성 검사를 통과하지 못하는 경우도 각각 자기 오류를 냅니다. 그러니 아래 네 가지 중 하나라고 단정하지 말고 눈앞의 오류를 읽으세요.",
      ],
      troubleshooting: {
        label: "증상, 확인, 해결",
        items: [
          {
            symptom: "푸시가 그대로 멈춰 있다가 연결 오류로 실패합니다.",
            code: [
              `# 보내는 쪽에서, 푸시가 도는 동안 — 몇 초 간격으로 두 번 실행
ss -tinp dst :9031
# ESTAB    리스너에 닿았다는 뜻일 뿐, 진행 여부는 말해 주지 않음
# SYN-SENT 그 포트에서 아무도 응답하지 않음`,
            ],
            fix: "SYN-SENT는 패킷이 대기 중인 소켓까지 닿지 못했다는 뜻입니다. 받는 쪽에서 ss -tlnp | grep 9031 로 serve가 떠 있는지 확인하고, 호스트 방화벽과 클라우드 보안 그룹에서 9031/TCP를 보내는 쪽에 여세요. ESTAB은 닿았다는 것만 증명합니다. established 소켓도 놀고 있거나 멈춰 있을 수 있습니다. 그러니 움직이는지 멈췄는지 가리려면 이 확인을 몇 초 간격으로 두 번 실행해, -i 가 그 소켓에 대해 출력하는 bytes_acked 카운터를 비교하세요. 여기에는 릴레이 경로가 없으므로, 닿지 않는 리스너는 느린 것이 아니라 완전한 실패입니다.",
          },
          {
            symptom: "serve 로그에 “rejected unauthorized peer …”가 찍히고 푸시가 실패합니다.",
            code: [
              `# 보내는 쪽에서
relayium id
# 74318e3b…

# 받는 쪽에서
relayium authorize 74318e3b…`,
            ],
            fix: "serve에게 물어볼 터미널이 없었기 때문입니다 — systemd 유닛이나 파이프 — 그래서 알 수 없는 지문은 신뢰 대신 거부됩니다. 미리 승인하세요. 거부 줄에 있는 지문은 보내는 쪽의 relayium id 가 출력하는 것과 똑같고, authorize는 몇 번 실행해도 같습니다.",
          },
          {
            symptom: "“fingerprint mismatch for receiver.example.com:9031”.",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "리스너가 첫 접촉 때 고정한 것과 다른 키를 제시했습니다. 일부러 그 키를 교체했다면 해당 known_hosts 줄을 지우고 다시 푸시하세요. 그렇지 않다면 그 줄은 그대로 두고, 키가 왜 바뀌었는지 알아내기 전에는 아무것도 보내지 마세요.",
          },
          {
            symptom: "systemd 유닛이 시작하자마자 권한 오류로 죽습니다.",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "relayium은 소유자 외의 누구라도 읽을 수 있는 개인 키를 읽어들이길 거부합니다. ssh와 같은 규칙입니다. 오류가 알려 준 경로에 chmod 600을 적용하고, 그 파일의 소유자가 서비스 사용자인지 확인한 뒤 유닛을 재시작하세요.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "데몬 다이렉트는 SSH를 통한 push와 어떻게 다른가요?",
        a: "SSH를 통한 push는 전송을 SSH 연결 터널로 통과시키며 원격에 SSH 계정이 필요합니다. 데몬 다이렉트는 SSH도 계정도 필요 없습니다. 두 서버는 인증서 고정 TLS를 통해 인증서 핑거프린트로 서로를 인증하며, 두 기기가 모두 내 것일 때 더 가볍습니다.",
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
        a: "푸시가 거부되고 경고가 표시됩니다. 리스너의 키는 첫 사용 시 known_hosts에 고정되므로, 이후의 변화(키를 재발급한 호스트든 중간자 공격이든)는 조용히 받아들여지는 대신 거부됩니다. known_hosts의 해당 줄은 의도적으로 키를 교체했을 때만 삭제하세요.",
      },
      {
        q: "릴레이 폴백이 있나요?",
        a: "없습니다. 데몬 다이렉트는 도달 가능한 리스너 주소를 전제로 합니다. 연결할 수 없으면 실패합니다. 어떤 것도 Relayium을 통해 프록시되지 않습니다. 그것이 이 모드의 요점입니다.",
      },
    ],
  },
  cta: {
    text: "내 서버 두 대를 연결해 직접 전송을 해보세요. 릴레이도, SSH도, 페어링 코드도 필요 없습니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Server-zu-Server-Übertragungen mit der Relayium CLI (daemon-direct)",
  description:
    "Bewege Dateien direkt zwischen zwei Servern, die du kontrollierst, mit relayium serve und push relayium:// — über TLS mit Pinning, ohne Relay, ohne SSH, ohne Pairing-Code. Genehmige einen neuen Pusher einmalig bei seinem ersten Push, dann automatisiere es oder lass es unter systemd laufen.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Wenn beide Maschinen dir gehören und jede die Adresse der anderen kennt, ist SSH zusätzliche Reibung und ein Rendezvous reiner Overhead. daemon-direct ist genau dafür gebaut: Ein Server lauscht, der andere pusht direkt dorthin über eine TLS-1.3-Verbindung mit Pinning. Kein Relay, kein SSH, kein Pairing-Code — das Vertrauen basiert auf Public Keys und wird einmal eingerichtet.",
    "Diese Anleitung behandelt das Starten des Listeners, das Pushen dorthin, das Genehmigen eines neuen Pushers beim ersten Kontakt, die Automatisierung und den Betrieb des Listeners als systemd-Dienst.",
  ],
  sections: [
    {
      heading: "Den Listener starten (auf dem Empfänger)",
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Zwei Rechner, die dir gehören, und die Adresse des Empfängers vom Sender aus erreichbar. Ein Hostname oder eine nackte IP tun es beide.",
          "relayium auf beiden Seiten. Daemon-direct spricht nur das native Protokoll, hier rettet dich also kein tar-Fallback, wenn die Installation fehlt.",
          "Den Port des Listeners für den Sender offen — 9031/TCP, solange du ihn nicht änderst — in der Host-Firewall und in jeder Cloud-Sicherheitsgruppe.",
          "Ein Terminal auf dem Empfänger für den ersten Push, damit du die Genehmigungsfrage beantworten kannst. Ohne Terminal autorisierst du den Sender stattdessen vorab (siehe unten).",
        ],
      },
      body: [
        "Auf dem empfangenden Server lauscht serve auf Pushes und schreibt sie in ein Verzeichnis. Standardmäßig läuft es dauerhaft; mit --once nimmt es eine einzelne Übertragung an und beendet sich. Du musst nichts vorab teilen — keine Fingerprints, die du im Voraus kopieren müsstest:",
      ],
      steps: [
        {
          text: "Leg das Verzeichnis an, in dem Pushes landen sollen.",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "Öffne den Port des Listeners nur für den Sender. Ersetz 203.0.113.7 durch die Adresse des Senders selbst — seine öffentliche IP, oder seine private, wenn beide Server im selben Netz hängen — und grenz die Cloud-Sicherheitsgruppe auf dieselbe Quelle ein statt auf das ganze Internet.",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "Starte den Listener in einem Terminal, damit beim ersten Push jemand die Genehmigungsfrage beantworten kann. --once nimmt eine einzelne Übertragung und beendet sich, --port bringt ihn weg von 9031.",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "So sieht ein laufender Listener aus",
        body: [
          "serve nennt die Adresse, an die er gebunden hat, das Verzeichnis, in das er schreibt, und den eigenen Fingerabdruck dieses Hosts. Solange keine Peers genehmigt sind, sagt er außerdem, dass er zu jedem neuen nachfragen wird.",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
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
      steps: [
        {
          text: "Führ den Push auf dem sendenden Server aus. Bei der allerersten Verbindung hält er genau hier an, bis der Empfänger ihn genehmigt.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "Beantworte die Frage auf dem Empfänger — das ist der nächste Abschnitt. Danach läuft der Push von allein zu Ende, und spätere Pushes halten hier nie wieder an.",
        },
        {
          text: "Häng einen Port an, wenn der Listener nicht auf 9031 sitzt.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "So sieht ein erfolgreicher Push aus",
        body: [
          "Beim ersten Kontakt lernt der Sender den Fingerabdruck des Listeners und heftet ihn an, dann überträgt er. Der Empfänger merkt sich den Fingerabdruck des Pushers und meldet Datei- und Byte-Zahl.",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
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
        `# auf dem EMPFÄNGER, wenn ein neuer Sender pusht:
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
        `# auf dem EMPFÄNGER: einen Sender ohne Abfrage vorab genehmigen
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
    {
      heading: "Wenn ein Push nicht durchkommt",
      body: [
        "Erreichbarkeit und Vertrauen sind das Erste, was du prüfst: ss -tinp auf dem Sender zeigt, ob der Listener überhaupt erreicht wurde, und relayium authorize auf dem Empfänger gibt einem abgewiesenen Sender das fehlende Vertrauen. Das sind nicht die einzigen Arten, wie ein Push scheitern kann — ein Empfänger ohne Plattenplatz, ein Eingangsverzeichnis, in das sein Benutzer nicht schreiben darf, oder eine übertragene Datei, die ihre Integritätsprüfung nicht besteht, melden sich alle selbst — lies also den Fehler vor dir, statt anzunehmen, es sei einer der vier unten.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Der Push steht, dann scheitert er mit einem Verbindungsfehler.",
            code: [
              `# auf dem SENDER, während der Push läuft — zweimal im Abstand einiger Sekunden
ss -tinp dst :9031
# ESTAB    der Listener wurde erreicht; über Fortschritt sagt das nichts
# SYN-SENT auf dem Port hat nichts geantwortet`,
            ],
            fix: "SYN-SENT heißt, die Pakete haben nie einen lauschenden Socket erreicht. Prüf auf dem Empfänger mit ss -tlnp | grep 9031, ob serve läuft, und öffne dann 9031/TCP für den Sender in der Host-Firewall und in der Cloud-Sicherheitsgruppe. ESTAB belegt nur die Erreichbarkeit — ein aufgebauter Socket kann untätig oder blockiert sein —, also führ die Prüfung zweimal im Abstand einiger Sekunden aus und vergleich den bytes_acked-Zähler, den -i für diesen Socket ausgibt, um Bewegung von Stillstand zu unterscheiden. Hier gibt es keinen Relay-Weg, ein nicht erreichbarer Listener ist also ein harter Fehlschlag und kein langsamer Lauf.",
          },
          {
            symptom: "Im serve-Log steht „rejected unauthorized peer …“ und der Push scheitert.",
            code: [
              `# auf dem SENDER
relayium id
# 74318e3b…

# auf dem EMPFÄNGER
relayium authorize 74318e3b…`,
            ],
            fix: "serve hatte kein Terminal zum Nachfragen — eine systemd-Unit oder eine Pipe — also wird ein unbekannter Fingerabdruck abgelehnt statt vertraut. Autorisier ihn vorab: Der Fingerabdruck in der Ablehnungszeile ist genau der, den relayium id auf dem Sender ausgibt, und authorize ist idempotent.",
          },
          {
            symptom: "„fingerprint mismatch for receiver.example.com:9031“.",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "Der Listener hat einen anderen Schlüssel vorgezeigt als den, der beim ersten Kontakt angeheftet wurde. Hast du den Schlüssel absichtlich rotiert, lösch die passende known_hosts-Zeile und push erneut. Wenn nicht, lass die Zeile stehen und finde heraus, warum sich der Schlüssel geändert hat, bevor du irgendetwas sendest.",
          },
          {
            symptom: "Die systemd-Unit stirbt beim Start an einem Fehler über unsichere Dateirechte.",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "relayium lädt keinen privaten Schlüssel, den außer seinem Besitzer noch jemand lesen kann — dieselbe Regel, die ssh anwendet. Führ chmod 600 auf dem Pfad aus, den der Fehler nennt, stell sicher, dass er dem Dienstbenutzer gehört, und starte die Unit neu.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Wie unterscheidet sich daemon-direct von push über SSH?",
        a: "push über SSH tunnelt die Übertragung durch deine SSH-Verbindung und braucht ein SSH-Konto auf der Gegenseite. daemon-direct braucht weder SSH noch ein Konto — die beiden Server authentifizieren sich gegenseitig per Zertifikats-Fingerprint über TLS mit Pinning, was leichtgewichtiger ist, wenn beide Maschinen dir gehören.",
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
        a: "Nein. daemon-direct setzt eine erreichbare Listener-Adresse voraus; kann die Verbindung nicht hergestellt werden, schlägt es fehl. Nichts wird jemals über Relayium weitergeleitet — genau das ist der Sinn dieses Modus.",
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
  title: "Transferts serveur à serveur avec la CLI Relayium (daemon-direct)",
  description:
    "Déplacez des fichiers directement entre deux serveurs que vous contrôlez avec relayium serve et push relayium:// — via TLS avec épinglage, sans relais, sans SSH, sans code d'appairage. Approuvez un nouvel émetteur une seule fois lors de son premier envoi, puis automatisez-le ou exécutez-le sous systemd.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Quand les deux machines vous appartiennent et que chacune connaît l'adresse de l'autre, SSH est une friction superflue et un rendez-vous n'est que du pur surcoût. Le daemon-direct est fait exactement pour cela : un serveur écoute, l'autre pousse directement vers lui via une connexion TLS 1.3 avec épinglage. Pas de relais, pas de SSH, pas de code d'appairage — la confiance repose sur des clés publiques et se configure une seule fois.",
    "Ce guide couvre le démarrage du processus à l'écoute, l'envoi vers celui-ci, l'approbation d'un nouvel émetteur au premier contact, l'automatisation, et l'exécution du processus à l'écoute en tant que service systemd.",
  ],
  sections: [
    {
      heading: "Démarrer le processus à l'écoute (sur le récepteur)",
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Deux machines qui vous appartiennent, l'adresse du récepteur étant joignable depuis l'émetteur. Un nom d'hôte ou une simple IP conviennent.",
          "relayium des deux côtés. Le daemon-direct ne parle que le protocole natif, donc aucun repli tar ne rattrapera ici une installation manquante.",
          "Le port du processus à l'écoute ouvert à l'émetteur — 9031/TCP tant que vous ne le changez pas — dans le pare-feu de l'hôte et dans tout groupe de sécurité cloud.",
          "Un terminal sur le récepteur pour le premier envoi, afin de répondre à la demande d'approbation. Sans terminal, autorisez plutôt l'émetteur à l'avance (voir plus bas).",
        ],
      },
      body: [
        "Sur le serveur récepteur, serve écoute les envois et les écrit dans un répertoire. Il tourne en continu par défaut ; ajoutez --once pour accepter un seul transfert puis s'arrêter. Vous n'avez rien à partager à l'avance — aucune empreinte à copier au préalable :",
      ],
      steps: [
        {
          text: "Créez le répertoire dans lequel les envois doivent atterrir.",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "N'ouvrez le port du processus à l'écoute qu'à l'émetteur. Remplacez 203.0.113.7 par l'adresse de l'émetteur lui-même — son IP publique, ou son IP privée si les deux serveurs partagent un réseau — et restreignez le groupe de sécurité cloud à cette même source plutôt qu'à tout l'internet.",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "Démarrez le processus à l'écoute dans un terminal, pour que quelqu'un puisse répondre à la demande d'approbation au premier envoi. --once accepte un seul transfert puis quitte, --port le déplace hors de 9031.",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "À quoi ressemble un processus à l'écoute qui tourne",
        body: [
          "serve annonce l'adresse sur laquelle il écoute, le répertoire dans lequel il écrit, et l'empreinte propre de cet hôte. Tant qu'aucun pair n'est approuvé, il précise aussi qu'il posera la question pour chaque nouveau.",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
      bullets: [
        "Le processus à l'écoute traite les connexions une par une et dépose les fichiers sous --dir.",
        "Le port par défaut est 9031 ; changez-le avec --port et ouvrez-le sur votre pare-feu.",
      ],
    },
    {
      heading: "Envoyer vers le processus à l'écoute (sur l'émetteur)",
      body: [
        "Depuis le serveur émetteur, envoyez vers l'adresse relayium:// du récepteur. La première connexion épingle l'empreinte du récepteur ; chaque connexion suivante la vérifie, et une empreinte modifiée est refusée plutôt qu'acceptée silencieusement — une clé remplacée ou une attaque de l'homme du milieu est ainsi détectée, pas approuvée. Lors du tout premier envoi, l'émetteur patiente un instant pendant que le récepteur l'approuve (étape suivante).",
      ],
      steps: [
        {
          text: "Lancez l'envoi depuis le serveur émetteur. À la toute première connexion, il s'arrête précisément ici, le temps que le récepteur l'approuve.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "Répondez à la demande sur le récepteur, c'est la section suivante. L'envoi se termine ensuite tout seul, et les envois suivants ne s'arrêtent plus jamais ici.",
        },
        {
          text: "Ajoutez un port lorsque le processus à l'écoute n'est pas sur 9031.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "À quoi ressemble un envoi réussi",
        body: [
          "Au premier contact, l'émetteur apprend puis épingle l'empreinte du processus à l'écoute, et transfère. Le récepteur enregistre l'empreinte de l'émetteur et annonce le nombre de fichiers et d'octets.",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
      bullets: [
        "Aucun relais et aucun repli : si le processus à l'écoute n'est pas joignable, l'envoi échoue — les octets du fichier ne transitent jamais par qui que ce soit d'autre.",
        "Le même moteur de transfert que les autres modes : avec reprise, et une vérification SHA-256 par fichier.",
      ],
    },
    {
      heading: "Approuver l'émetteur au premier envoi (sur le récepteur)",
      body: [
        "La première fois qu'une nouvelle machine envoie vers votre processus à l'écoute, serve (dans un terminal) vous montre d'où elle vient et son empreinte, puis vous demande de l'approuver — comme l'invite de première connexion de SSH, mais côté récepteur :",
      ],
      code: [
        `# sur le RÉCEPTEUR, quand un nouvel émetteur envoie :
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Répondez y et cette empreinte est mémorisée dans authorized_fingerprints ; chaque envoi ultérieur depuis la même machine passe alors silencieusement.",
        "L'empreinte est l'identité stable d'une machine (elle survit aux redémarrages et aux changements d'IP), donc l'approbation n'est qu'une étape ponctuelle par émetteur.",
        "L'émetteur, de son côté, découvre la clé du processus à l'écoute à la première connexion (confiance à la première utilisation) et l'épingle dans known_hosts.",
      ],
    },
    {
      heading: "Automatiser (ou exécuter sans terminal)",
      body: [
        "Comme une empreinte approuvée est mémorisée, les envois suivants ne demandent plus de confirmation — relayium push s'intègre donc directement dans cron, un script de déploiement ou la CI pour une synchronisation serveur à serveur chiffrée, vérifiée en intégrité et avec reprise. Quand serve tourne sans terminal (un service systemd, un pipe), il ne peut pas demander confirmation et rejette donc les émetteurs inconnus ; autorisez-les plutôt à l'avance. Récupérez l'empreinte via relayium id côté émetteur, ou copiez-la depuis la ligne « rejected unauthorized peer … » du journal de serve, puis :",
      ],
      code: [
        `# sur le RÉCEPTEUR : autoriser un émetteur à l'avance, sans invite
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Les fichiers d'identité et de confiance se trouvent dans ~/.config/relayium/ (à surcharger avec --config-dir, par exemple /etc/relayium pour un service).",
        "authorize est idempotent — l'exécuter à nouveau pour la même empreinte ne fait rien.",
      ],
    },
    {
      heading: "Exécuter le processus à l'écoute sous systemd",
      body: [
        "Pour une boîte de réception toujours active, exécutez serve en tant que service systemd. Pointez --config-dir vers un emplacement fixe comme /etc/relayium pour que l'identité reste stable entre les redémarrages, et laissez systemd le maintenir en vie :",
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
        "systemctl enable --now relayium-serve pour le démarrer et le faire démarrer au démarrage.",
        "Gardez /etc/relayium/id.key lisible uniquement par l'utilisateur du service — relayium refuse de charger une clé aux permissions trop permissives.",
      ],
    },
    {
      heading: "Quand un envoi ne passe pas",
      body: [
        "La joignabilité et la confiance sont les deux premières choses à vérifier : ss -tinp sur l'émetteur dit si le processus à l'écoute a seulement été atteint, et relayium authorize sur le récepteur accorde à un émetteur refusé la confiance qui lui manque. Ce ne sont pas les seules façons dont un envoi peut échouer — un récepteur à court d'espace disque, un répertoire de réception où son utilisateur ne peut pas écrire, ou un fichier transféré qui rate son contrôle d'intégrité se signalent tous eux-mêmes — lisez donc l'erreur que vous avez sous les yeux plutôt que de supposer qu'il s'agit de l'un des quatre cas ci-dessous.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "L'envoi reste immobile, puis échoue sur une erreur de connexion.",
            code: [
              `# sur l'ÉMETTEUR, pendant que l'envoi tourne — lancez-la deux fois, à quelques secondes d'intervalle
ss -tinp dst :9031
# ESTAB    le processus à l'écoute a été atteint ; cela ne dit rien de la progression
# SYN-SENT rien n'a répondu sur ce port`,
            ],
            fix: "SYN-SENT signifie que les paquets n'ont jamais atteint une socket à l'écoute. Vérifiez sur le récepteur que serve tourne, avec ss -tlnp | grep 9031, puis ouvrez 9031/TCP à l'émetteur dans le pare-feu de l'hôte et dans le groupe de sécurité cloud. ESTAB ne prouve que l'accessibilité — une socket établie peut rester inactive ou bloquée —, donc pour distinguer ce qui avance de ce qui est coincé, relancez la vérification à quelques secondes d'intervalle et comparez le compteur bytes_acked que -i affiche pour cette socket. Il n'y a aucune voie de relais ici, donc un processus à l'écoute injoignable est un échec net et non un ralentissement.",
          },
          {
            symptom: "Le journal de serve indique « rejected unauthorized peer … » et l'envoi échoue.",
            code: [
              `# sur l'ÉMETTEUR
relayium id
# 74318e3b…

# sur le RÉCEPTEUR
relayium authorize 74318e3b…`,
            ],
            fix: "serve n'avait aucun terminal à qui demander — une unité systemd, un tube — donc une empreinte inconnue est refusée plutôt qu'acceptée. Autorisez-la à l'avance : l'empreinte de la ligne de refus est exactement celle qu'affiche relayium id sur l'émetteur, et authorize est idempotent.",
          },
          {
            symptom: "« fingerprint mismatch for receiver.example.com:9031 ».",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "Le processus à l'écoute a présenté une clé différente de celle épinglée au premier contact. Si vous avez fait tourner cette clé volontairement, supprimez la ligne correspondante de known_hosts et relancez l'envoi. Sinon, laissez la ligne en place et cherchez pourquoi la clé a changé avant d'envoyer quoi que ce soit.",
          },
          {
            symptom: "L'unité systemd meurt au démarrage sur une erreur de permissions non sûres.",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "relayium refuse de charger une clé privée lisible par quelqu'un d'autre que son propriétaire, la même règle qu'applique ssh. Lancez chmod 600 sur le chemin nommé par l'erreur, assurez-vous qu'il appartient à l'utilisateur du service, et redémarrez l'unité.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "En quoi le daemon-direct diffère-t-il de push via SSH ?",
        a: "push via SSH fait transiter le transfert par votre connexion SSH et nécessite un compte SSH sur la machine distante. Le daemon-direct ne nécessite ni SSH ni compte — les deux serveurs s'authentifient mutuellement par empreinte de certificat via TLS avec épinglage, ce qui est plus léger quand les deux machines vous appartiennent.",
      },
      {
        q: "Dois-je recopier les empreintes à la main ?",
        a: "Non. Dans un terminal, serve vous invite à approuver chaque nouvel émetteur lors de son premier envoi — en affichant son adresse et son empreinte — et s'en souvient, si bien que les envois suivants sont silencieux. Vous n'avez recours à relayium id ou relayium authorize que pour des configurations non interactives, comme un service systemd, où personne n'est là pour répondre à l'invite.",
      },
      {
        q: "Où se trouvent les fichiers d'identité et de confiance ?",
        a: "Dans ~/.config/relayium/ par défaut (à surcharger avec --config-dir). id.key / id.crt sont l'identité persistante de cet hôte, known_hosts contient les empreintes des processus à l'écoute vers lesquels vous avez envoyé, et authorized_fingerprints est la liste d'autorisation des émetteurs du processus à l'écoute.",
      },
      {
        q: "Que se passe-t-il si une empreinte change ?",
        a: "L'envoi est refusé et un avertissement s'affiche. La clé du processus à l'écoute est épinglée dans known_hosts à la première utilisation, donc un changement ultérieur — un hôte dont la clé a été régénérée, ou une attaque de l'homme du milieu — est rejeté plutôt qu'accepté silencieusement. Ne supprimez la ligne known_hosts que si vous avez intentionnellement effectué une rotation de clé.",
      },
      {
        q: "Y a-t-il un repli vers un relais ?",
        a: "Non. Le daemon-direct suppose une adresse de processus à l'écoute joignable ; si la connexion ne peut pas être établie, il échoue. Rien n'est jamais relayé via Relayium — c'est tout l'intérêt de ce mode.",
      },
    ],
  },
  cta: {
    text: "Reliez deux de vos propres serveurs pour des transferts directs — sans relais, sans SSH, sans code d'appairage.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "النقل من خادم إلى خادم باستخدام واجهة Relayium الطرفية (daemon direct)",
  description:
    "انقل الملفات مباشرةً بين خادمين تتحكم بهما باستخدام relayium serve وpush relayium:// — عبر TLS مُثبَّت، دون مُرحِّل، دون SSH، دون رمز اقتران. اعتمِد مُرسِلًا جديدًا مرةً واحدة عند أول دفعة له، ثم أتمتِه أو شغّله تحت systemd.",
  updatedLabel: "آخر تحديث",
  lead: [
    "حين يكون الجهازان كلاهما لك ويعرف كلٌّ منهما عنوان الآخر، يصبح SSH احتكاكًا زائدًا والتعارف عبئًا محضًا. صُمِّم daemon direct لهذا تمامًا: خادم يُنصِت، والآخر يدفع إليه مباشرةً عبر اتصال TLS 1.3 مُثبَّت. لا مُرحِّل، لا SSH، لا رمز اقتران — الثقة تقوم على المفتاح العام وتُهيَّأ مرةً واحدة.",
    "يغطي هذا الدليل تشغيل المُستمِع، والدفع إليه، واعتماد مُرسِل جديد عند أول اتصال، وأتمتة ذلك، وتشغيل المُستمِع كخدمة systemd.",
  ],
  sections: [
    {
      heading: "شغّل المُستمِع (على المُستقبِل)",
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "جهازان تتحكم بهما، وعنوان المُستقبِل قابل للوصول من المُرسِل. يصلح اسم مضيف أو عنوان IP مجرد.",
          "برنامج relayium على الطرفين. لا يتحدث daemon direct إلا البروتوكول الأصلي، فلا يوجد هنا تراجع إلى tar ينقذ تثبيتًا ناقصًا.",
          "منفذ المُستمِع مفتوح أمام المُرسِل، وهو 9031/TCP ما لم تغيّره، في جدار حماية المضيف وفي أي مجموعة أمان سحابية.",
          "طرفية على المُستقبِل من أجل أول دفعة، كي تجيب عن سؤال الاعتماد. وإن لم تكن هناك طرفية، فاعتمِد المُرسِل مسبقًا بدلًا من ذلك (انظر أدناه).",
        ],
      },
      body: [
        "على الخادم المُستقبِل، يستمع serve للدفعات ويكتبها في مجلد. يعمل باستمرار افتراضيًا؛ أضِف --once لقبول نقلة واحدة ثم الخروج. لا تشارك أي شيء مسبقًا — لا بصمات تنسخها سلفًا:",
      ],
      steps: [
        {
          text: "أنشئ المجلد الذي يجب أن تصل إليه الدفعات.",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "لا تفتح منفذ المُستمِع إلا أمام المُرسِل. استبدِل 203.0.113.7 بعنوان المُرسِل نفسه — عنوانه العام، أو الخاص إن كان الخادمان على الشبكة ذاتها — وضيِّق مجموعة الأمان السحابية على المصدر نفسه بدل فتحها للإنترنت كله.",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "شغّل المُستمِع في طرفية، كي يكون هناك من يجيب عن سؤال الاعتماد عند أول دفعة. أضِف --once ليأخذ نقلة واحدة ثم يخرج، أو --port لنقله عن 9031.",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "كيف يبدو مُستمِع يعمل",
        body: [
          "يذكر serve العنوان الذي ارتبط به، والمجلد الذي يكتب فيه، وبصمة هذا المضيف نفسه. وما دام لا يوجد أقران معتمدون بعد، يذكر أيضًا أنه سيسأل عن كل قرين جديد.",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
      bullets: [
        "يعالج المُستمِع الاتصالات واحدًا تلو الآخر ويُنزِل الملفات تحت --dir.",
        "المنفذ الافتراضي هو 9031؛ غيّره بـ --port وافتحه على جدارك الناري.",
      ],
    },
    {
      heading: "ادفع إليه (على المُرسِل)",
      body: [
        "من الخادم المُرسِل، ادفع إلى عنوان relayium:// الخاص بالمُستقبِل. يُثبِّت الاتصال الأول بصمة المُستقبِل؛ ويتحقق منها كل اتصال بعده، وتُرفَض البصمة المتغيّرة بدل قبولها بصمت — فالمفتاح المُستبدَل أو هجوم الوسيط يُكتشَف، لا يُوثَق به. عند أول دفعة على الإطلاق، ينتظر المُرسِل لحظةً بينما يعتمده المُستقبِل (الخطوة التالية).",
      ],
      steps: [
        {
          text: "نفّذ الدفع على الخادم المُرسِل. في أول اتصال على الإطلاق يتوقف هنا بالضبط ريثما يعتمده المُستقبِل.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "أجِب عن السؤال على المُستقبِل، وهو موضوع القسم التالي. بعدها تكتمل الدفعة وحدها، ولن تتوقف الدفعات اللاحقة هنا أبدًا.",
        },
        {
          text: "أضِف منفذًا في نهاية العنوان حين لا يكون المُستمِع على 9031.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "كيف تبدو دفعة ناجحة",
        body: [
          "عند أول اتصال يتعلّم المُرسِل بصمة المُستمِع ويثبّتها، ثم ينقل. ويسجّل المُستقبِل بصمة الدافع ويُبلِغ بعدد الملفات والبايتات.",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
      bullets: [
        "لا مُرحِّل ولا احتياطي: إن تعذَّر الوصول إلى المُستمِع، تفشل الدفعة — ولا تمر بايتات الملف أبدًا عبر أي طرف آخر.",
        "المحرك نفسه المُستخدَم في الأوضاع الأخرى: قابل للاستئناف، مع فحص SHA-256 لكل ملف.",
      ],
    },
    {
      heading: "اعتمِد المُرسِل عند أول دفعة (على المُستقبِل)",
      body: [
        "في أول مرة يدفع فيها جهاز جديد إلى مُستمِعك، يُظهِر لك serve (في طرفية) من أين أتى وبصمته ويطلب منك اعتماده — مثل مُطالبة الاتصال الأول في SSH، لكن على جانب المُستقبِل:",
      ],
      code: [
        `# على المُستقبِل، حين يدفع مُرسِل جديد:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "أجِب بـ y فتُحفَظ تلك البصمة في authorized_fingerprints؛ عندئذٍ تمر كل دفعة لاحقة من الجهاز نفسه بصمت.",
        "البصمة هوية ثابتة للجهاز (تصمد عبر إعادة التشغيل وتغيّر عناوين IP)، فالاعتماد خطوة تُنفَّذ مرةً واحدة لكل مُرسِل.",
        "أما المُرسِل، فيتعلَّم مفتاح المُستمِع عند أول اتصال (الثقة عند أول استخدام) ويُثبِّته في known_hosts.",
      ],
    },
    {
      heading: "أتمِتها (أو شغّلها دون طرفية)",
      body: [
        "بما أن البصمة المعتمَدة تُحفَظ، لا تحتاج الدفعات اللاحقة إلى مُطالبة — لذا يدخل relayium push مباشرةً في cron أو سكربت نشر أو CI لمزامنة مُشفَّرة، مفحوصة السلامة، قابلة للاستئناف من خادم إلى خادم. حين يعمل serve دون طرفية (خدمة systemd، أنبوب) لا يستطيع المُطالبة، فيرفض المُرسِلين المجهولين؛ فوّض لهم مسبقًا بدلًا من ذلك. احصل على البصمة من relayium id لدى المُرسِل، أو انسخها من سطر «rejected unauthorized peer …» في سجل serve، ثم:",
      ],
      code: [
        `# على المُستقبِل: فوِّض مُرسِلًا مسبقًا دون مُطالبة
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "تقيم ملفات الهوية والثقة في ~/.config/relayium/ (تُتجاوَز بـ --config-dir، مثلًا /etc/relayium لخدمة).",
        "authorize خاملة التكرار (idempotent) — تشغيلها مجددًا للبصمة نفسها لا يفعل شيئًا.",
      ],
    },
    {
      heading: "شغّل المُستمِع تحت systemd",
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
        "أبقِ /etc/relayium/id.key قابلًا للقراءة من مستخدم الخدمة فقط — يرفض relayium تحميل مفتاح بأذونات فضفاضة.",
      ],
    },
    {
      heading: "حين لا تمرّ الدفعة",
      body: [
        "إمكانية الوصول والثقة هما أول ما تفحصه: يُظهر ss -tinp على المُرسِل ما إذا كان المُستمِع قد وصلته الحزم أصلًا، ويمنح relayium authorize على المُستقبِل الثقةَ الناقصة لمُرسِل مرفوض. وليستا الطريقتين الوحيدتين لفشل الدفعة — فالمُستقبِل الذي نفدت مساحته، أو مجلد الوارد الذي لا يستطيع مستخدمه الكتابة فيه، أو ملف مَنقول يسقط في فحص السلامة، كلها تُبلِغ عن نفسها — فاقرأ الخطأ الذي أمامك بدل افتراض أنه أحد الأربعة أدناه.",
      ],
      troubleshooting: {
        label: "العَرَض، الفحص، الإصلاح",
        items: [
          {
            symptom: "تبقى الدفعة واقفة ثم تفشل بخطأ في الاتصال.",
            code: [
              `# على المُرسِل، أثناء عمل الدفعة — نفّذه مرتين بفارق ثوانٍ قليلة
ss -tinp dst :9031
# ESTAB    يعني أن المُستمِع تم الوصول إليه، ولا يقول شيئًا عن التقدّم
# SYN-SENT لم يردّ أحد على ذلك المنفذ`,
            ],
            fix: "تعني SYN-SENT أن الحزم لم تصل قط إلى مقبس يستمع. تأكّد على المُستقبِل من أن serve يعمل عبر ss -tlnp | grep 9031، ثم افتح 9031/TCP أمام المُرسِل في جدار حماية المضيف وفي مجموعة الأمان السحابية. لا تثبت ESTAB إلا إمكانية الوصول، فالمقبس المُنشأ قد يبقى خاملًا أو متعطّلًا؛ ولتمييز الحركة من التوقّف نفّذ الفحص مرتين بفارق ثوانٍ قليلة وقارِن عدّاد bytes_acked الذي يطبعه ‎-i‎ لذلك المقبس. لا يوجد هنا مسار عبر مُرحِّل، فالمُستمِع غير القابل للوصول فشل قاطع لا بطء.",
          },
          {
            symptom: "يذكر سجل serve عبارة «rejected unauthorized peer …» وتفشل الدفعة.",
            code: [
              `# على المُرسِل
relayium id
# 74318e3b…

# على المُستقبِل
relayium authorize 74318e3b…`,
            ],
            fix: "لم تكن لدى serve طرفية يسأل عليها، كوحدة systemd أو أنبوب، فتُرفَض البصمة المجهولة بدل الوثوق بها. اعتمِدها مسبقًا: البصمة في سطر الرفض هي نفسها التي يطبعها relayium id على المُرسِل، وauthorize لا يتغير أثره بتكراره.",
          },
          {
            symptom: "«fingerprint mismatch for receiver.example.com:9031».",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "قدّم المُستمِع مفتاحًا مختلفًا عن المفتاح المثبّت عند أول اتصال. إن كنت قد بدّلت ذلك المفتاح عن قصد، فاحذف سطر known_hosts المطابق وأعِد الدفع. وإن لم تفعل، فاترك السطر كما هو واعرف سبب تغيّر المفتاح قبل أن ترسل أي شيء.",
          },
          {
            symptom: "تموت وحدة systemd عند الإقلاع بخطأ عن أذونات غير آمنة.",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "يرفض relayium تحميل مفتاح خاص يستطيع أحد غير مالكه قراءته، وهي القاعدة نفسها التي يطبّقها ssh. نفّذ chmod 600 على المسار الذي يسمّيه الخطأ، وتأكّد من أن مالكه هو مستخدم الخدمة، ثم أعِد تشغيل الوحدة.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "بماذا يختلف daemon direct عن push عبر SSH؟",
        a: "يوجِّه push عبر SSH النقل خلال اتصال SSH لديك ويحتاج إلى حساب SSH على الطرف البعيد. أما daemon direct فلا يحتاج SSH ولا حسابًا — يصادق الخادمان أحدهما الآخر ببصمة الشهادة عبر TLS مُثبَّت، وهو أخف حين يكون الجهازان كلاهما لك.",
      },
      {
        q: "هل عليّ نسخ البصمات يدويًا هنا وهناك؟",
        a: "لا. في طرفية، يطالبك serve باعتماد كل مُرسِل جديد عند أول دفعة له — مُظهِرًا عنوانه وبصمته — ويحفظه، فتمر الدفعات اللاحقة بصمت. لا تلجأ إلى relayium id أو relayium authorize إلا في الإعدادات غير التفاعلية مثل خدمة systemd، حيث لا أحد ليُجيب على المُطالبة.",
      },
      {
        q: "أين تقع ملفات الهوية والثقة؟",
        a: "في ~/.config/relayium/ افتراضيًا (تُتجاوَز بـ --config-dir). id.key / id.crt هما الهوية الدائمة لهذا المضيف، ويحتفظ known_hosts ببصمات المُستمِعين الذين دفعت إليهم، أما authorized_fingerprints فهو قائمة السماح بالمُرسِلين لدى المُستمِع.",
      },
      {
        q: "ماذا يحدث إذا تغيّرت بصمة؟",
        a: "تُرفَض الدفعة ويُطلَق تحذير. يُثبَّت مفتاح المُستمِع في known_hosts عند أول استخدام، فأي تغيّر لاحق — مضيف أُعيد ترميزه، أو هجوم وسيط — يُرفَض بدل قبوله بصمت. لا تحذف سطر known_hosts إلا إن كنت قد بدّلت المفتاح عمدًا.",
      },
      {
        q: "هل هناك احتياطي عبر مُرحِّل؟",
        a: "لا. يفترض daemon direct عنوان مُستمِع يمكن الوصول إليه؛ فإن تعذَّر إنشاء الاتصال، يفشل. لا يُوجَّه أي شيء أبدًا عبر Relayium — وهذا هو مغزى هذا الوضع.",
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
  title: "Transferencias de servidor a servidor con la CLI de Relayium (daemon directo)",
  description:
    "Mueve archivos directamente entre dos servidores que controlas con relayium serve y push relayium:// — sobre TLS con anclaje, sin retransmisor, sin SSH, sin código de emparejamiento. Aprueba un nuevo emisor una vez en su primer push, y luego automatízalo o ejecútalo bajo systemd.",
  updatedLabel: "Última actualización",
  lead: [
    "Cuando ambas máquinas son tuyas y cada una conoce la dirección de la otra, SSH es una fricción de más y un encuentro es pura sobrecarga. daemon directo está hecho exactamente para esto: un servidor escucha, el otro le hace push directamente sobre una conexión TLS 1.3 con anclaje. Sin retransmisor, sin SSH, sin código de emparejamiento: la confianza se basa en clave pública y se configura una sola vez.",
    "Esta guía cubre iniciar el proceso a la escucha, hacerle push, aprobar un nuevo emisor en el primer contacto, automatizarlo y ejecutar el proceso a la escucha como servicio de systemd.",
  ],
  sections: [
    {
      heading: "Iniciar el proceso a la escucha (en el receptor)",
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Dos máquinas bajo tu control, con la dirección del receptor alcanzable desde el emisor. Vale un nombre de host o una IP pelada.",
          "relayium en los dos extremos. El daemon directo solo habla el protocolo nativo, así que aquí no hay ninguna alternativa con tar que rescate una instalación ausente.",
          "El puerto del proceso a la escucha abierto al emisor —9031/TCP mientras no lo cambies— tanto en el cortafuegos del host como en cualquier grupo de seguridad en la nube.",
          "Un terminal en el receptor para el primer push, para poder responder a la petición de aprobación. Sin terminal, autoriza al emisor de antemano (más abajo).",
        ],
      },
      body: [
        "En el servidor receptor, serve escucha los push y los escribe en un directorio. Se ejecuta de forma continua por defecto; añade --once para aceptar una sola transferencia y salir. No compartes nada de antemano: no hay huellas que copiar por adelantado:",
      ],
      steps: [
        {
          text: "Crea el directorio donde deben aterrizar los envíos.",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "Abre el puerto del proceso a la escucha solo al emisor. Sustituye 203.0.113.7 por la dirección del propio emisor — su IP pública, o la privada si los dos servidores comparten red — y acota el grupo de seguridad en la nube a esa misma fuente en vez de a todo internet.",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "Arranca el proceso a la escucha en un terminal, para que haya alguien que responda a la petición de aprobación en el primer push. Con --once acepta una sola transferencia y sale; con --port lo mueves fuera de 9031.",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "Cómo se ve un proceso a la escucha en marcha",
        body: [
          "serve indica la dirección a la que se ha enlazado, el directorio en el que escribe y la huella propia de este host. Mientras no haya pares aprobados, avisa además de que preguntará por cada uno nuevo.",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
      bullets: [
        "El proceso a la escucha procesa las conexiones de una en una y deposita los archivos bajo --dir.",
        "El puerto por defecto es 9031; cámbialo con --port y ábrelo en tu cortafuegos.",
      ],
    },
    {
      heading: "Hacerle push (en el emisor)",
      body: [
        "Desde el servidor emisor, haz push a la dirección relayium:// del receptor. La primera conexión fija la huella del receptor; cada conexión posterior la verifica, y una huella cambiada se rechaza en lugar de aceptarse en silencio, de modo que una clave sustituida o un ataque de intermediario se detecta, no se confía en él. En el primer push, el emisor espera un momento mientras el receptor lo aprueba (siguiente paso).",
      ],
      steps: [
        {
          text: "Lanza el push desde el servidor emisor. En la primerísima conexión se detiene justo aquí mientras el receptor lo aprueba.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "Responde a la petición en el receptor: es la sección siguiente. Después el push termina solo, y los push posteriores ya no se detienen nunca aquí.",
        },
        {
          text: "Añade un puerto cuando el proceso a la escucha no esté en 9031.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "Cómo se ve un push correcto",
        body: [
          "En el primer contacto el emisor aprende y fija la huella del proceso a la escucha, y luego transfiere. El receptor anota la huella de quien empuja e informa del número de archivos y de bytes.",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
      bullets: [
        "Sin retransmisor y sin respaldo: si no se puede alcanzar el proceso a la escucha, el push falla; los bytes del archivo nunca se enrutan a través de nadie más.",
        "El mismo motor de transferencia que los otros modos: reanudable, con una comprobación SHA-256 por archivo.",
      ],
    },
    {
      heading: "Aprobar al emisor en el primer push (en el receptor)",
      body: [
        "La primera vez que una máquina nueva hace push a tu proceso a la escucha, serve (en una terminal) te muestra de dónde viene y su huella y te pide que la apruebes, como el aviso de primera conexión de SSH, pero en el lado receptor:",
      ],
      code: [
        `# en el RECEPTOR, cuando una máquina nueva hace push:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Responde y y esa huella se recuerda en authorized_fingerprints; cada push posterior desde la misma máquina pasa entonces en silencio.",
        "La huella es la identidad estable de una máquina (sobrevive a reinicios y cambios de IP), así que aprobar es un paso único por emisor.",
        "El emisor, a su vez, aprende la clave del proceso a la escucha en la primera conexión (confianza en el primer uso) y la fija en known_hosts.",
      ],
    },
    {
      heading: "Automatizarlo (o ejecutarlo sin terminal)",
      body: [
        "Como una huella aprobada se recuerda, los push posteriores no necesitan aviso, así que relayium push encaja directamente en cron, un script de despliegue o CI para una sincronización de servidor a servidor cifrada, con integridad comprobada y reanudable. Cuando serve se ejecuta sin terminal (un servicio de systemd, una tubería) no puede preguntar, así que rechaza a los emisores desconocidos; autorízalos de antemano en su lugar. Obtén la huella con relayium id en el emisor, o cópiala de la línea « rejected unauthorized peer … » del registro de serve, y luego:",
      ],
      code: [
        `# en el RECEPTOR: autoriza a un emisor de antemano, sin aviso
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Los archivos de identidad y confianza viven en ~/.config/relayium/ (se anulan con --config-dir, p. ej. /etc/relayium para un servicio).",
        "authorize es idempotente: ejecutarlo de nuevo para la misma huella no hace nada.",
      ],
    },
    {
      heading: "Ejecutar el proceso a la escucha bajo systemd",
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
    {
      heading: "Cuando un push no llega",
      body: [
        "La accesibilidad y la confianza son lo primero que hay que comprobar: ss -tinp en el emisor dice si el proceso a la escucha llegó siquiera a ser alcanzado, y relayium authorize en el receptor le da a un emisor rechazado la confianza que le falta. No son las únicas formas en que un push puede fallar: un receptor sin espacio en disco, un directorio de entrada en el que su usuario no puede escribir o un archivo transferido que no supera su comprobación de integridad se anuncian todos por su cuenta, así que lee el error que tienes delante en vez de dar por hecho que es uno de los cuatro de abajo.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "El push se queda quieto y luego falla con un error de conexión.",
            code: [
              `# en el EMISOR, mientras el push está en marcha — ejecútalo dos veces, con unos segundos de diferencia
ss -tinp dst :9031
# ESTAB    se alcanzó el proceso a la escucha; no dice nada del progreso
# SYN-SENT nada respondió en ese puerto`,
            ],
            fix: "SYN-SENT significa que los paquetes nunca llegaron a un socket a la escucha. Comprueba en el receptor que serve está en marcha con ss -tlnp | grep 9031, y luego abre 9031/TCP al emisor en el cortafuegos del host y en el grupo de seguridad de la nube. ESTAB solo demuestra alcanzabilidad — un socket establecido puede quedarse inactivo o atascado —, así que para distinguir lo que avanza de lo que está parado ejecuta la comprobación dos veces con unos segundos de diferencia y compara el contador bytes_acked que -i imprime para ese socket. Aquí no hay ninguna vía de retransmisor, así que un proceso a la escucha inalcanzable es un fallo rotundo, no una lentitud.",
          },
          {
            symptom: "El registro de serve dice «rejected unauthorized peer …» y el push falla.",
            code: [
              `# en el EMISOR
relayium id
# 74318e3b…

# en el RECEPTOR
relayium authorize 74318e3b…`,
            ],
            fix: "serve no tenía ningún terminal al que preguntar —una unidad de systemd, una tubería—, así que una huella desconocida se rechaza en lugar de aceptarse. Autorízala de antemano: la huella de la línea de rechazo es exactamente la que imprime relayium id en el emisor, y authorize es idempotente.",
          },
          {
            symptom: "«fingerprint mismatch for receiver.example.com:9031».",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "El proceso a la escucha presentó una clave distinta de la fijada en el primer contacto. Si rotaste esa clave a propósito, borra la línea correspondiente de known_hosts y vuelve a hacer push. Si no fuiste tú, deja la línea en paz y averigua por qué cambió la clave antes de enviar nada.",
          },
          {
            symptom: "La unidad de systemd muere al arrancar con un error de permisos inseguros.",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "relayium se niega a cargar una clave privada que pueda leer alguien más que su propietario, la misma regla que aplica ssh. Ejecuta chmod 600 sobre la ruta que nombra el error, asegúrate de que pertenece al usuario del servicio y reinicia la unidad.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿En qué se diferencia daemon directo de push por SSH?",
        a: "push por SSH tuneliza la transferencia a través de tu conexión SSH y necesita una cuenta SSH en el remoto. daemon directo no necesita SSH ni cuenta: los dos servidores se autentican mutuamente por huella de certificado sobre TLS con anclaje, lo cual es más ligero cuando ambas máquinas son tuyas.",
      },
      {
        q: "¿Tengo que copiar huellas a mano de un lado a otro?",
        a: "No. En una terminal, serve te pide aprobar a cada nuevo emisor en su primer push —mostrando su dirección y su huella— y lo recuerda, así que los push posteriores son silenciosos. Solo recurres a relayium id o relayium authorize en configuraciones no interactivas como un servicio de systemd, donde no hay nadie para responder al aviso.",
      },
      {
        q: "¿Dónde están los archivos de identidad y confianza?",
        a: "En ~/.config/relayium/ por defecto (se anula con --config-dir). id.key / id.crt son la identidad persistente de este host, known_hosts guarda las huellas de los procesos a la escucha a los que has hecho push, y authorized_fingerprints es la lista de permitidos de emisores del proceso a la escucha.",
      },
      {
        q: "¿Qué pasa si una huella cambia?",
        a: "El push se rechaza y avisa. La clave del proceso a la escucha se fija en known_hosts en el primer uso, así que un cambio posterior —un host con clave regenerada o un ataque de intermediario— se rechaza en lugar de aceptarse en silencio. Elimina la línea de known_hosts solo si rotaste la clave a propósito.",
      },
      {
        q: "¿Hay algún respaldo por retransmisor?",
        a: "No. daemon directo asume una dirección de proceso a la escucha alcanzable; si no se puede establecer la conexión, falla. Nada se enruta nunca a través de Relayium como proxy: ese es el sentido de este modo.",
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
  title: "Transferências de servidor para servidor com a CLI do Relayium (daemon direto)",
  description:
    "Mova arquivos diretamente entre dois servidores que você controla com relayium serve e push relayium:// — sobre TLS com fixação, sem retransmissor, sem SSH, sem código de emparelhamento. Aprove um novo emissor uma vez no seu primeiro push e depois automatize-o ou execute-o sob systemd.",
  updatedLabel: "Última atualização",
  lead: [
    "Quando as duas máquinas são suas e cada uma conhece o endereço da outra, o SSH é um atrito a mais e um encontro é puro overhead. O daemon direto foi feito exatamente para isso: um servidor escuta, o outro faz push direto para ele sobre uma conexão TLS 1.3 com fixação. Sem retransmissor, sem SSH, sem código de emparelhamento: a confiança é por chave pública e é configurada uma única vez.",
    "Este guia cobre iniciar o processo à escuta, fazer push para ele, aprovar um novo emissor no primeiro contato, automatizá-lo e executar o processo à escuta como um serviço do systemd.",
  ],
  sections: [
    {
      heading: "Iniciar o processo à escuta (no receptor)",
      prereqs: {
        label: "O que você precisa",
        items: [
          "Duas máquinas sob o seu controle, com o endereço do receptor alcançável a partir do emissor. Serve um nome de host ou um IP puro.",
          "O relayium nas duas pontas. O daemon direto só fala o protocolo nativo, então aqui não existe alternativa com tar para salvar uma instalação faltando.",
          "A porta do processo à escuta aberta ao emissor — 9031/TCP enquanto você não mudar — no firewall do host e em qualquer grupo de segurança na nuvem.",
          "Um terminal no receptor para o primeiro push, para responder ao pedido de aprovação. Sem terminal, autorize o emissor de antemão (veja abaixo).",
        ],
      },
      body: [
        "No servidor receptor, serve escuta os pushes e os escreve em um diretório. Ele roda continuamente por padrão; adicione --once para aceitar uma única transferência e sair. Você não compartilha nada com antecedência: não há impressões digitais para copiar antes:",
      ],
      steps: [
        {
          text: "Crie o diretório onde os envios devem aterrissar.",
          code: ["mkdir -p ~/inbox"],
        },
        {
          text: "Abra a porta do processo à escuta somente para o emissor. Substitua 203.0.113.7 pelo endereço do próprio emissor — o IP público, ou o privado se os dois servidores compartilham uma rede — e restrinja o grupo de segurança da nuvem à mesma origem em vez de à internet inteira.",
          code: ["sudo ufw allow from 203.0.113.7 to any port 9031 proto tcp"],
        },
        {
          text: "Inicie o processo à escuta num terminal, para que haja alguém para responder ao pedido de aprovação no primeiro push. Com --once ele aceita uma única transferência e sai; com --port você o tira de 9031.",
          code: ["relayium serve --dir ~/inbox"],
        },
      ],
      success: {
        label: "Como é um processo à escuta em execução",
        body: [
          "O serve informa o endereço em que se ligou, o diretório em que escreve e a impressão digital do próprio host. Enquanto não houver pares aprovados, ele também avisa que vai perguntar sobre cada novo.",
        ],
        code: [
          `relayium serve --dir ~/inbox
no authorized peers yet — you'll be asked to approve each new peer on its first push.
relayium serve: listening on [::]:9031, receiving into /home/you/inbox (fingerprint 5c1d9f04…)`,
        ],
      },
      bullets: [
        "O processo à escuta processa as conexões uma de cada vez e deposita os arquivos em --dir.",
        "A porta padrão é 9031; altere-a com --port e abra-a no seu firewall.",
      ],
    },
    {
      heading: "Fazer push para ele (no emissor)",
      body: [
        "Do servidor emissor, faça push para o endereço relayium:// do receptor. A primeira conexão fixa a impressão digital do receptor; toda conexão posterior a verifica, e uma impressão digital alterada é recusada em vez de aceita silenciosamente — assim, uma chave trocada ou um ataque de intermediário é detectado, não confiado. No primeiro push, o emissor espera um momento enquanto o receptor o aprova (próximo passo).",
      ],
      steps: [
        {
          text: "Rode o push a partir do servidor emissor. Na primeiríssima conexão ele para exatamente aqui enquanto o receptor o aprova.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com"],
        },
        {
          text: "Responda ao pedido no receptor: é a seção seguinte. Depois o push termina sozinho, e os push seguintes nunca mais param aqui.",
        },
        {
          text: "Acrescente uma porta quando o processo à escuta não estiver na 9031.",
          code: ["relayium push ./build.tar.zst relayium://receiver.example.com:9040"],
        },
      ],
      success: {
        label: "Como é um push bem-sucedido",
        body: [
          "No primeiro contato o emissor aprende e fixa a impressão digital do processo à escuta e então transfere. O receptor anota a impressão digital de quem empurrou e informa a contagem de arquivos e de bytes.",
        ],
        code: [
          `# on the SENDER, first contact
learned receiver.example.com:9031 5c1d9f04… (added to known_hosts)
  build.tar.zst (48213004 bytes)

# on the RECEIVER
authorized 74318e3b… (added to /home/you/.config/relayium/authorized_fingerprints)
received 1 file(s), 48213004 bytes from 74318e3b…`,
        ],
      },
      bullets: [
        "Sem retransmissor e sem retorno: se o processo à escuta não for alcançável, o push falha — os bytes do arquivo nunca são roteados por mais ninguém.",
        "O mesmo motor de transferência dos outros modos: retomável, com uma verificação SHA-256 por arquivo.",
      ],
    },
    {
      heading: "Aprovar o emissor no primeiro push (no receptor)",
      body: [
        "Na primeira vez que uma máquina nova faz push para o seu processo à escuta, serve (em um terminal) mostra de onde ela vem e sua impressão digital e pede que você a aprove — como o prompt de primeira conexão do SSH, mas no lado receptor:",
      ],
      code: [
        `# no RECEPTOR, quando um novo emissor faz push:
Incoming push from 203.0.113.7:54021
  fingerprint: 74318e3b…
Accept and remember this peer? [y/N] y`,
      ],
      bullets: [
        "Responda y e essa impressão digital é lembrada em authorized_fingerprints; cada push posterior da mesma máquina passa então em silêncio.",
        "A impressão digital é a identidade estável de uma máquina (sobrevive a reinicializações e mudanças de IP), então aprovar é um passo único por emissor.",
        "O emissor, por sua vez, aprende a chave do processo à escuta na primeira conexão (confiança no primeiro uso) e a fixa em known_hosts.",
      ],
    },
    {
      heading: "Automatizá-lo (ou executá-lo sem terminal)",
      body: [
        "Como uma impressão digital aprovada é lembrada, os pushes posteriores não precisam de prompt, então relayium push se encaixa direto em cron, um script de deploy ou CI para uma sincronização de servidor para servidor criptografada, com integridade verificada e retomável. Quando serve roda sem terminal (um serviço do systemd, um pipe) ele não pode perguntar, então rejeita emissores desconhecidos; pré-autorize-os em vez disso. Obtenha a impressão digital com relayium id no emissor, ou copie-a da linha “rejected unauthorized peer …” no log do serve, e então:",
      ],
      code: [
        `# no RECEPTOR: pré-autorize um emissor sem prompt
relayium authorize 74318e3b...`,
      ],
      bullets: [
        "Os arquivos de identidade e confiança ficam em ~/.config/relayium/ (substitua com --config-dir, por exemplo /etc/relayium para um serviço).",
        "authorize é idempotente — executá-lo novamente para a mesma impressão digital não faz nada.",
      ],
    },
    {
      heading: "Executar o processo à escuta sob systemd",
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
    {
      heading: "Quando um push não passa",
      body: [
        "Alcançabilidade e confiança são as duas primeiras coisas a verificar: ss -tinp no emissor diz se o processo à escuta chegou sequer a ser alcançado, e relayium authorize no receptor concede a um emissor recusado a confiança que lhe falta. Não são as únicas formas de um push falhar — um receptor sem espaço em disco, um diretório de entrada em que o seu usuário não pode escrever, ou um arquivo transferido que falha na verificação de integridade anunciam-se todos sozinhos — então leia o erro à sua frente em vez de supor que é um dos quatro abaixo.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "O push fica parado e depois falha com um erro de conexão.",
            code: [
              `# no EMISSOR, enquanto o push está rodando — execute duas vezes, com alguns segundos de intervalo
ss -tinp dst :9031
# ESTAB    o processo à escuta foi alcançado; não diz nada sobre progresso
# SYN-SENT nada respondeu naquela porta`,
            ],
            fix: "SYN-SENT significa que os pacotes nunca chegaram a um socket à escuta. Confirme no receptor que o serve está no ar com ss -tlnp | grep 9031 e então abra 9031/TCP para o emissor no firewall do host e no grupo de segurança da nuvem. ESTAB prova apenas alcançabilidade — um socket estabelecido pode ficar ocioso ou travado —, então, para separar o que anda do que está parado, rode a verificação duas vezes com alguns segundos de intervalo e compare o contador bytes_acked que o -i imprime para aquele socket. Aqui não há caminho por retransmissor, então um processo à escuta inalcançável é uma falha seca, não uma lentidão.",
          },
          {
            symptom: "O log do serve diz “rejected unauthorized peer …” e o push falha.",
            code: [
              `# no EMISSOR
relayium id
# 74318e3b…

# no RECEPTOR
relayium authorize 74318e3b…`,
            ],
            fix: "O serve não tinha nenhum terminal a quem perguntar — uma unidade do systemd, um pipe — então uma impressão digital desconhecida é recusada em vez de aceita. Autorize-a de antemão: a impressão digital da linha de recusa é exatamente a que relayium id imprime no emissor, e o authorize é idempotente.",
          },
          {
            symptom: "“fingerprint mismatch for receiver.example.com:9031”.",
            code: [
              `grep receiver.example.com ~/.config/relayium/known_hosts`,
            ],
            fix: "O processo à escuta apresentou uma chave diferente da que foi fixada no primeiro contato. Se você girou essa chave de propósito, apague a linha correspondente do known_hosts e faça o push de novo. Se não foi você, deixe a linha em paz e descubra por que a chave mudou antes de enviar qualquer coisa.",
          },
          {
            symptom: "A unidade do systemd morre na inicialização com um erro de permissões inseguras.",
            code: [
              `systemctl status relayium-serve
# secure: /etc/relayium/id.key has insecure permissions 0644; run: chmod 600 /etc/relayium/id.key
ls -l /etc/relayium/id.key`,
            ],
            fix: "O relayium se recusa a carregar uma chave privada que qualquer um além do dono consiga ler, a mesma regra que o ssh aplica. Rode chmod 600 no caminho que o erro nomeia, confirme que ele pertence ao usuário do serviço e reinicie a unidade.",
          },
        ],
      },
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Em que o daemon direto difere de push por SSH?",
        a: "push por SSH tunela a transferência pela sua conexão SSH e precisa de uma conta SSH no remoto. O daemon direto não precisa de SSH nem de conta — os dois servidores se autenticam mutuamente pela impressão digital do certificado sobre TLS com fixação, o que é mais leve quando as duas máquinas são suas.",
      },
      {
        q: "Preciso copiar impressões digitais à mão de um lado para o outro?",
        a: "Não. Em um terminal, serve pede que você aprove cada novo emissor no seu primeiro push — mostrando seu endereço e sua impressão digital — e o lembra, então os pushes posteriores são silenciosos. Você só recorre a relayium id ou relayium authorize em configurações não interativas como um serviço do systemd, onde não há ninguém para responder ao prompt.",
      },
      {
        q: "Onde estão os arquivos de identidade e confiança?",
        a: "Em ~/.config/relayium/ por padrão (substitua com --config-dir). id.key / id.crt são a identidade persistente deste host, known_hosts guarda as impressões digitais dos processos à escuta para os quais você fez push, e authorized_fingerprints é a lista de permissão de emissores do processo à escuta.",
      },
      {
        q: "O que acontece se uma impressão digital mudar?",
        a: "O push é recusado e avisa. A chave do processo à escuta é fixada em known_hosts no primeiro uso, então uma mudança posterior — um host com chave regenerada ou um ataque de intermediário — é rejeitada em vez de aceita silenciosamente. Remova a linha do known_hosts apenas se você rotacionou a chave intencionalmente.",
      },
      {
        q: "Existe algum retorno por retransmissor?",
        a: "Não. O daemon direto pressupõe um endereço de processo à escuta alcançável; se a conexão não puder ser feita, ela falha. Nada é jamais roteado via proxy pelo Relayium — esse é o propósito deste modo.",
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
  published: "2026-07-08",
  updated: "2026-08-05",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
