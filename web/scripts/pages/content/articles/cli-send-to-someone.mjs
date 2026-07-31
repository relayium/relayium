// web/scripts/pages/content/articles/cli-send-to-someone.mjs
// How-to: send a file to another person across networks with relayium send/receive.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Send a file to someone across networks with the Relayium CLI",
  description:
    "Use relayium send and receive to move a file directly between two people on different networks, using a short pairing code. End-to-end encrypted, verified with a SAS code, and free — the file goes straight between you, never through our servers.",
  updatedLabel: "Last updated",
  lead: [
    "Sometimes the other machine isn't yours and you can't SSH into it — a file for a colleague in another office, a build for a client, an archive for a friend across the country. relayium send and receive move it directly between the two of you across networks, using nothing but a short pairing code that your CLI mints when you send.",
    "The connection is peer-to-peer and end-to-end encrypted. Only a tiny rendezvous handshake passes through Relayium to introduce the two ends; the file bytes never do.",
  ],
  sections: [
    {
      heading: "Send, then pass on the code it prints",
      body: [
        "Sign in once with relayium login, then just send. The CLI mints a pairing code, prints it along with the exact command the other end runs, and waits. Pass that code along out of band — say it over a call, drop it in a chat:",
      ],
      code: [
        `# sender (once per machine: relayium login)
relayium send ./release.zip
# prints:  Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# receiver (in the folder where files should land) — no account needed
relayium receive K7M4XR`,
      ],
      bullets: [
        "The code is 6 characters from a restricted alphabet — no 0 or 1, nothing that can be misread aloud — and it expires 5 minutes after it is minted.",
        "Only the sender signs in. The receiver needs the CLI and the code, and no account at all.",
        "The code is just a shared secret to meet on; it isn't sent to anyone but the rendezvous, and it introduces the two ends only.",
        "The receiver can pass a destination directory: relayium receive K7M4XR ./downloads",
        "Both ends must be the CLI — a browser can't join a CLI pairing code. Sending to someone who only has a browser? Use relayium up instead, which gives you a download link.",
      ],
    },
    {
      heading: "Verify with the SAS code",
      body: [
        "When the two ends connect, both terminals print the same 6-digit SAS (short authentication string) derived from their pinned TLS certificate fingerprints. Compare it out of band — read it aloud on the call — to confirm the fingerprints were not substituted and the rendezvous service did not impersonate either endpoint. The SAS authenticates the endpoints; it does not prove every network hop.",
        "For the strongest protection, add --verify: the transfer then waits for you to confirm the codes match before a single byte moves.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Direct only — free, or it fails",
      body: [
        "The transfer races a direct connection between the two ends. When one can be established — which is the common case for at least one side with a reachable address — the file streams straight across, encrypted, at full speed and at no cost.",
        "If both ends are behind strict NAT and no direct path can be found, the transfer fails cleanly rather than routing your file through a relay. That keeps the CLI completely free and keeps your file bytes off our servers. If you hit this, the reliable answer is daemon direct between two reachable servers, or push over SSH.",
      ],
      bullets: [
        "Direct connection succeeds → free, full-speed, end-to-end encrypted.",
        "No direct path → the transfer fails; the CLI never proxies the file for you.",
        "Both ends can be anywhere geographically — the sender just runs send, and the receiver runs receive with the code it printed.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Where does the pairing code come from?",
        a: "Relayium mints it. Run `relayium send ./release.zip` (after `relayium login`) and the CLI prints a 6-character code good for five minutes, plus the exact command the other end runs. You can't choose it yourself — the server only accepts codes it issued.",
      },
      {
        q: "Is the file uploaded anywhere?",
        a: "No. The file streams directly between the two of you, end-to-end encrypted. Only a small rendezvous handshake passes through Relayium to introduce the ends — never the file.",
      },
      {
        q: "What if we can't connect?",
        a: "If both ends are behind strict NAT with no reachable address, the direct connection can't be made and the transfer fails — the CLI has no relay fallback, by design. Use daemon direct between two reachable servers, or push over SSH, when a direct path isn't available.",
      },
      {
        q: "How do I know it's really the right person on the other end?",
        a: "Both terminals print an identical 6-digit SAS code derived from their pinned TLS certificate fingerprints. Compare it out of band; a match confirms the fingerprints were not substituted and the rendezvous service did not impersonate either endpoint. It authenticates the endpoints, not every network hop. Add --verify to require that confirmation before any bytes move.",
      },
    ],
  },
  cta: {
    text: "Send your next file straight to someone on another network — end-to-end encrypted, and free.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用 Relayium CLI 跨网络把文件发给对方",
  description:
    "使用 relayium send 和 receive，凭一个简短的配对码，把文件直接在两个不同网络上的人之间传输。端到端加密，用 SAS 码验证，而且免费——文件径直在你们之间传输，从不经过我们的服务器。",
  updatedLabel: "最近更新",
  lead: [
    "有时候对方的机器不是你的，你也没法用 SSH 登录进去——给另一个办公室的同事发个文件，给客户发个构建产物，给国外的朋友发个压缩包。relayium send 和 receive 会跨网络把文件直接送到你们两个之间，靠的只是发送时 CLI 为你生成的一个简短配对码。",
    "连接是点对点、端到端加密的。只有一次极小的会合握手会经过 Relayium 来介绍双方；文件字节从不经过。",
  ],
  sections: [
    {
      heading: "先 send，再把打印出来的码转告对方",
      body: [
        "用 relayium login 登录一次，然后直接 send 就行。CLI 会生成一个配对码，连同对面要执行的完整命令一起打印出来，然后等待。把这个码用带外方式转告对方——打电话说一下，或者丢进聊天里：",
      ],
      code: [
        `# 发送方（每台机器执行一次：relayium login）
relayium send ./release.zip
# 输出：  Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# 接收方（在文件应落地的目录下）——无需账号
relayium receive K7M4XR`,
      ],
      bullets: [
        "这个码是 6 位，取自一个受限字母表——没有 0 和 1，也没有念出来会听混的字符——并且在生成 5 分钟后失效。",
        "只有发送方需要登录。接收方只需要装好 CLI 和拿到这个码，完全不需要账号。",
        "这个码只是一个用来会合的共享密钥；除了会合服务器，它不会发给任何人，而且只用来介绍双方。",
        "接收方可以指定目标目录：relayium receive K7M4XR ./downloads",
        "两端都必须是 CLI——浏览器无法加入 CLI 的配对码。如果对方只有浏览器，请改用 relayium up，它会给你一个下载链接。",
      ],
    },
    {
      heading: "用 SAS 码验证",
      body: [
        "两端连接建立后，两边的终端会打印出同一个从固定 TLS 证书指纹派生的 6 位 SAS（简短认证串）。通过带外方式核对——例如在通话中念出来——可以确认指纹没有被替换、会合服务没有冒充任一端。SAS 认证的是端点，并不证明网络路径上的每一跳。",
        "为获得最强保护，加上 --verify：传输会等你确认两边的码一致后，才会移动哪怕一个字节。",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "只走直连——免费，否则失败",
      body: [
        "传输会在两端之间竞速建立直连。一旦能建立——这是常见情况，只要至少一方有可达地址——文件就会直接、加密地全速传输，不收费。",
        "如果两端都在严格 NAT 之后，找不到直连路径，传输会干净地失败，而不会把你的文件路由经过中继。这样才能让 CLI 保持完全免费，也让你的文件字节远离我们的服务器。如果遇到这种情况，可靠的办法是在两台可达的服务器之间用 daemon 直连，或者用 SSH push。",
      ],
      bullets: [
        "直连成功 → 免费、全速、端到端加密。",
        "没有直连路径 → 传输失败；CLI 从不替你代理文件。",
        "两端在地理上可以在任何地方——发送方直接运行 send，接收方用它打印出来的码运行 receive。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "配对码是从哪来的？",
        a: "由 Relayium 生成。登录后运行 `relayium send ./release.zip`，CLI 会打印一个 6 位、5 分钟内有效的码，以及对面要执行的完整命令。这个码不能自己指定——服务器只认它自己签发的。",
      },
      {
        q: "文件会上传到什么地方吗？",
        a: "不会。文件在你们两个之间直接流式传输，端到端加密。只有一次很小的会合握手会经过 Relayium 来介绍双方——文件本身从不经过。",
      },
      {
        q: "如果连接不上怎么办？",
        a: "如果两端都在严格 NAT 之后、没有可达地址，就无法建立直连，传输会失败——CLI 按设计没有中继兜底。当没有直连路径时，可以在两台可达的服务器之间用 daemon 直连，或者用 SSH push。",
      },
      {
        q: "我怎么知道对面真的是对的人？",
        a: "两边的终端会打印出一个从固定 TLS 证书指纹派生的相同 6 位 SAS 码。通过带外方式核对；一致就能确认指纹没有被替换、会合服务没有冒充任一端。它认证的是端点，而不是网络路径上的每一跳。加上 --verify 可以要求在任何字节移动之前先完成这个确认。",
      },
    ],
  },
  cta: {
    text: "把你的下一个文件直接发给另一个网络上的人——端到端加密，而且免费。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium CLI でネットワークを越えて誰かにファイルを送る",
  description:
    "relayium send と receive を使い、短いペアリングコードだけで異なるネットワーク上の2人の間でファイルを直接移動します。エンドツーエンドで暗号化され、SAS コードで検証され、しかも無料。ファイルは二人の間を直接行き来し、当社のサーバーを経由することはありません。",
  updatedLabel: "最終更新",
  lead: [
    "相手のマシンが自分のものではなく SSH でログインできないこともあります。別のオフィスの同僚へのファイル、クライアント向けのビルド、遠方の友人へのアーカイブ。relayium send と receive は、送信時に CLI が発行する短いペアリングコードだけを使って、ネットワークを越えてそれを二人の間で直接移動させます。",
    "接続は P2P で、エンドツーエンドに暗号化されています。二つの端を引き合わせるためのごく小さなランデブーハンドシェイクだけが Relayium を経由し、ファイルのバイトは決して経由しません。",
  ],
  sections: [
    {
      heading: "まず send、そして表示されたコードを相手に伝える",
      body: [
        "最初に一度だけ relayium login でサインインし、あとは send するだけです。CLI がペアリングコードを発行し、相手が実行するコマンドとあわせて表示して待機します。そのコードを帯域外で伝えてください。通話で伝える、チャットに書く、など：",
      ],
      code: [
        `# 送信側（マシンごとに一度：relayium login）
relayium send ./release.zip
# 表示：  Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# 受信側（ファイルを置きたいフォルダーで）。アカウントは不要
relayium receive K7M4XR`,
      ],
      bullets: [
        "コードは制限された文字集合から選ばれた6文字です。0 と 1 は含まれず、読み上げて取り違えやすい文字も除いてあります。そして発行から5分で失効します。",
        "サインインが必要なのは送信側だけです。受信側は CLI とコードさえあればよく、アカウントは一切要りません。",
        "コードは合流するための共有シークレットにすぎません。ランデブー先以外の誰にも送られず、二つの端を引き合わせるためだけに使われます。",
        "受信側は送り先のディレクトリを指定できます：relayium receive K7M4XR ./downloads",
        "両端とも CLI である必要があります。ブラウザは CLI のペアリングコードに参加できません。相手がブラウザしか持っていない場合は、代わりに relayium up を使ってください。ダウンロードリンクが得られます。",
      ],
    },
    {
      heading: "SAS コードで検証する",
      body: [
        "二つの端が接続すると、両方のターミナルに固定された TLS 証明書フィンガープリントから導かれた同じ6桁の SAS（short authentication string）が表示されます。帯域外で照合し（通話中に読み上げるなど）、フィンガープリントが差し替えられておらず、ランデブーサービスがどちらのエンドポイントにもなりすましていないことを確認してください。SAS はエンドポイントを認証するもので、ネットワーク経路上のすべてのホップを証明するものではありません。",
        "最も強い保護が必要なら --verify を付けます。すると転送は、コードが一致することを確認するまで、1バイトも動かさずに待機します。",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "直接接続のみ：無料、さもなくば失敗",
      body: [
        "転送は二つの端の間で直接接続の確立を競います。確立できれば（少なくとも一方に到達可能なアドレスがある一般的なケースでは）、ファイルはそのまま暗号化された状態で全速力かつ無料で流れます。",
        "両端が厳格な NAT の内側にあり直接の経路が見つからない場合、転送はリレー経由でファイルを送るのではなく、きれいに失敗します。これにより CLI は完全に無料のままで、ファイルのバイトも当社のサーバーに触れません。この状況に当たった場合、確実な答えは到達可能な2台のサーバー間でのデーモン直結、または SSH 経由の push です。",
      ],
      bullets: [
        "直接接続が成功 → 無料、全速力、エンドツーエンドで暗号化。",
        "直接の経路がない → 転送は失敗します。CLI が代わりにファイルを中継することは決してありません。",
        "両端は地理的にどこにあっても構いません。送信側は send を実行するだけ、受信側はそれが表示したコードで receive を実行します。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ペアリングコードはどこから来るのですか？",
        a: "Relayium が発行します。`relayium login` のうえで `relayium send ./release.zip` を実行すると、CLI が5分間有効な6文字のコードと、相手が実行するコマンドをそのまま表示します。自分で選ぶことはできません。サーバーは自身が発行したコードしか受け付けないからです。",
      },
      {
        q: "ファイルはどこかにアップロードされますか？",
        a: "いいえ。ファイルは二人の間で直接ストリーミングされ、エンドツーエンドで暗号化されます。二つの端を引き合わせるためのごく小さなランデブーハンドシェイクだけが Relayium を経由し、ファイルは決して経由しません。",
      },
      {
        q: "接続できない場合はどうなりますか？",
        a: "両端が厳格な NAT の内側にあり到達可能なアドレスがない場合、直接接続は確立できず転送は失敗します。CLI は設計上リレーへのフォールバックを持ちません。直接の経路が使えない場合は、到達可能な2台のサーバー間でのデーモン直結、または SSH 経由の push を使ってください。",
      },
      {
        q: "相手が本当に正しい人物だとどうやって分かりますか？",
        a: "両方のターミナルが固定された TLS 証明書フィンガープリントから導かれた同一の6桁の SAS コードを表示します。帯域外で照合すると、フィンガープリントが差し替えられておらず、ランデブーサービスがどちらのエンドポイントにもなりすましていないことを確認できます。これはエンドポイントを認証するもので、ネットワーク経路上のすべてのホップを証明するものではありません。バイトが動く前にその確認を必須にするには --verify を追加します。",
      },
    ],
  },
  cta: {
    text: "次のファイルを、別のネットワークにいる相手へ直接送りましょう。エンドツーエンドで暗号化され、しかも無料です。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 네트워크를 넘어 상대에게 파일 보내기",
  description:
    "relayium send와 receive를 사용해, 짧은 페어링 코드 하나로 서로 다른 네트워크에 있는 두 사람 사이에서 파일을 직접 옮기세요. 종단간 암호화되고 SAS 코드로 검증되며 무료입니다. 파일은 두 사람 사이를 곧장 오가며, 저희 서버를 절대 거치지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "때로는 상대의 컴퓨터가 내 것이 아니어서 SSH로 접속할 수 없을 때가 있습니다. 다른 사무실 동료에게 줄 파일, 고객에게 줄 빌드, 먼 곳의 친구에게 줄 아카이브. relayium send와 receive는 보낼 때 CLI가 발급하는 짧은 페어링 코드 하나만으로 네트워크를 넘어 그것을 두 사람 사이에 직접 옮깁니다.",
    "연결은 P2P이며 종단간 암호화됩니다. 두 끝을 서로 소개하기 위한 아주 작은 랑데부 핸드셰이크만 Relayium을 거치며, 파일 바이트는 결코 거치지 않습니다.",
  ],
  sections: [
    {
      heading: "먼저 send하고, 출력된 코드를 상대에게 전달하기",
      body: [
        "relayium login으로 한 번만 로그인한 뒤에는 그냥 send하면 됩니다. CLI가 페어링 코드를 발급해 상대가 실행할 명령과 함께 출력하고 기다립니다. 그 코드를 대역 외 방식으로 전달하세요. 통화로 말하거나 채팅에 남기면 됩니다:",
      ],
      code: [
        `# 보내는 쪽(기기마다 한 번: relayium login)
relayium send ./release.zip
# 출력:   Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# 받는 쪽(파일이 저장될 폴더에서) — 계정 필요 없음
relayium receive K7M4XR`,
      ],
      bullets: [
        "코드는 제한된 문자 집합에서 뽑은 6자입니다. 0과 1이 없고, 소리 내어 읽을 때 헷갈리는 문자도 빠져 있습니다. 그리고 발급된 지 5분이 지나면 만료됩니다.",
        "로그인이 필요한 쪽은 보내는 사람뿐입니다. 받는 쪽은 CLI와 코드만 있으면 되고, 계정은 전혀 필요 없습니다.",
        "이 코드는 만남을 위한 공유 비밀일 뿐입니다. 랑데부 서버 외에는 누구에게도 전송되지 않으며, 오직 두 끝을 서로 소개하는 데만 쓰입니다.",
        "받는 쪽은 대상 디렉터리를 지정할 수 있습니다: relayium receive K7M4XR ./downloads",
        "양쪽 모두 CLI여야 합니다. 브라우저는 CLI 페어링 코드에 참여할 수 없습니다. 상대에게 브라우저밖에 없다면 대신 relayium up을 쓰세요. 다운로드 링크가 나옵니다.",
      ],
    },
    {
      heading: "SAS 코드로 검증하기",
      body: [
        "두 끝이 연결되면 양쪽 터미널에 고정된 TLS 인증서 지문에서 파생된 동일한 6자리 SAS(짧은 인증 문자열)가 출력됩니다. 이를 대역 외로 비교하세요. 통화 중에 소리 내어 읽으면 됩니다. 일치하면 지문이 바뀌지 않았고 랑데부 서비스가 어느 끝점도 사칭하지 않았음을 확인할 수 있습니다. SAS는 끝점을 인증하는 것이지 네트워크 경로의 모든 홉을 증명하는 것은 아닙니다.",
        "가장 강한 보호를 원하면 --verify를 추가하세요. 그러면 전송은 코드가 일치함을 확인할 때까지 단 1바이트도 움직이지 않고 기다립니다.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "직접 연결만 — 무료가 아니면 실패",
      body: [
        "전송은 두 끝 사이의 직접 연결 수립을 경쟁적으로 시도합니다. 연결이 이루어지면(적어도 한쪽에 도달 가능한 주소가 있는 일반적인 경우) 파일은 암호화된 채로 곧장 전속력으로, 비용 없이 흐릅니다.",
        "양쪽 모두 엄격한 NAT 뒤에 있어 직접 경로를 찾을 수 없으면, 전송은 파일을 릴레이로 우회시키는 대신 깔끔하게 실패합니다. 이렇게 해야 CLI가 완전히 무료로 유지되고, 파일 바이트가 저희 서버에 닿지 않습니다. 이런 상황이라면 확실한 방법은 도달 가능한 두 서버 사이의 데몬 다이렉트나, SSH를 통한 push입니다.",
      ],
      bullets: [
        "직접 연결 성공 → 무료, 전속력, 종단간 암호화.",
        "직접 경로 없음 → 전송 실패; CLI는 결코 대신 파일을 프록시하지 않습니다.",
        "양쪽은 지리적으로 어디에나 있을 수 있습니다. 보내는 쪽은 send를 실행하기만 하고, 받는 쪽은 거기서 출력된 코드로 receive를 실행합니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "페어링 코드는 어디서 나오나요?",
        a: "Relayium이 발급합니다. `relayium login` 후 `relayium send ./release.zip`을 실행하면 CLI가 5분간 유효한 6자 코드와 상대가 실행할 명령을 그대로 출력합니다. 직접 고를 수는 없습니다. 서버는 자신이 발급한 코드만 받아들이기 때문입니다.",
      },
      {
        q: "파일이 어딘가에 업로드되나요?",
        a: "아니요. 파일은 두 사람 사이에서 직접 스트리밍되며 종단간 암호화됩니다. 두 끝을 서로 소개하기 위한 아주 작은 랑데부 핸드셰이크만 Relayium을 거치며, 파일은 절대 거치지 않습니다.",
      },
      {
        q: "연결이 안 되면 어떻게 되나요?",
        a: "양쪽 모두 엄격한 NAT 뒤에 있고 도달 가능한 주소가 없다면 직접 연결을 만들 수 없어 전송이 실패합니다. CLI는 설계상 릴레이 폴백이 없습니다. 직접 경로를 쓸 수 없을 때는 도달 가능한 두 서버 사이의 데몬 다이렉트나, SSH를 통한 push를 사용하세요.",
      },
      {
        q: "상대가 정말 맞는 사람인지 어떻게 알 수 있나요?",
        a: "양쪽 터미널이 고정된 TLS 인증서 지문에서 파생된 동일한 6자리 SAS 코드를 출력합니다. 대역 외로 비교하면 지문이 바뀌지 않았고 랑데부 서비스가 어느 끝점도 사칭하지 않았음을 확인할 수 있습니다. 이는 끝점을 인증하는 것이지 네트워크 경로의 모든 홉을 증명하는 것은 아닙니다. 바이트가 움직이기 전에 이 확인을 필수로 하려면 --verify를 추가하세요.",
      },
    ],
  },
  cta: {
    text: "다음 파일을 다른 네트워크에 있는 상대에게 직접 보내세요. 종단간 암호화되고 무료입니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Mit der Relayium CLI eine Datei über Netzwerke hinweg an jemanden senden",
  description:
    "Nutze relayium send und receive, um eine Datei mithilfe eines kurzen Pairing-Codes direkt zwischen zwei Personen in unterschiedlichen Netzwerken zu bewegen. Ende-zu-Ende verschlüsselt, mit einem SAS-Code verifiziert und kostenlos — die Datei geht direkt zwischen euch hin und her, nie über unsere Server.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Manchmal ist die andere Maschine nicht deine eigene und du kannst dich nicht per SSH einloggen — eine Datei für eine Kollegin in einem anderen Büro, ein Build für einen Kunden, ein Archiv für einen Freund am anderen Ende des Landes. relayium send und receive bewegen sie über Netzwerke hinweg direkt zwischen euch beiden, nur mit einem kurzen Pairing-Code, den deine CLI beim Senden erzeugt.",
    "Die Verbindung ist Peer-to-Peer und Ende-zu-Ende verschlüsselt. Nur ein winziger Rendezvous-Handshake läuft über Relayium, um die beiden Enden einander vorzustellen; die Dateibytes nie.",
  ],
  sections: [
    {
      heading: "Erst senden, dann den ausgegebenen Code weitergeben",
      body: [
        "Melde dich einmalig mit relayium login an, danach sendest du einfach. Die CLI erzeugt einen Pairing-Code, gibt ihn zusammen mit dem Befehl aus, den die andere Seite ausführt, und wartet. Gib diesen Code außerhalb des Kanals weiter — sag ihn am Telefon, schreib ihn in einen Chat:",
      ],
      code: [
        `# Absender (einmal pro Rechner: relayium login)
relayium send ./release.zip
# gibt aus:  Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# Empfänger (in dem Ordner, in dem die Dateien landen sollen) — kein Konto nötig
relayium receive K7M4XR`,
      ],
      bullets: [
        "Der Code besteht aus 6 Zeichen eines eingeschränkten Alphabets — ohne 0 und 1 und ohne alles, was man vorgelesen verwechseln kann — und läuft 5 Minuten nach dem Erzeugen ab.",
        "Nur der Absender meldet sich an. Der Empfänger braucht die CLI und den Code, aber überhaupt kein Konto.",
        "Der Code ist nur ein gemeinsames Geheimnis zum Treffen; er wird an niemanden außer der Rendezvous-Stelle gesendet und stellt nur die beiden Enden einander vor.",
        "Der Empfänger kann ein Zielverzeichnis angeben: relayium receive K7M4XR ./downloads",
        "Beide Enden müssen die CLI sein — ein Browser kann einem CLI-Pairing-Code nicht beitreten. Du sendest an jemanden, der nur einen Browser hat? Nimm stattdessen relayium up, das gibt dir einen Download-Link.",
      ],
    },
    {
      heading: "Mit dem SAS-Code verifizieren",
      body: [
        "Sobald sich die beiden Enden verbinden, geben beide Terminals denselben 6-stelligen SAS (Short Authentication String) aus, der aus den angehefteten TLS-Zertifikatsfingerabdrücken abgeleitet ist. Vergleicht ihn außerhalb des Kanals — lest ihn beim Telefonat laut vor —, um zu bestätigen, dass die Fingerabdrücke nicht ausgetauscht wurden und der Rendezvous-Dienst keinen Endpunkt imitiert hat. Der SAS authentifiziert die Endpunkte; er beweist nicht jeden Netzwerk-Hop.",
        "Für den stärksten Schutz fügt --verify hinzu: Die Übertragung wartet dann, bis ihr bestätigt, dass die Codes übereinstimmen, bevor auch nur ein einziges Byte bewegt wird.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Nur direkt — kostenlos, sonst schlägt es fehl",
      body: [
        "Die Übertragung versucht, eine direkte Verbindung zwischen den beiden Enden herzustellen. Gelingt das — der übliche Fall, wenn wenigstens eine Seite eine erreichbare Adresse hat —, fließt die Datei verschlüsselt direkt hindurch, mit voller Geschwindigkeit und ohne Kosten.",
        "Stehen beide Enden hinter strengem NAT und lässt sich kein direkter Pfad finden, schlägt die Übertragung sauber fehl, statt deine Datei über ein Relay zu leiten. So bleibt die CLI vollständig kostenlos, und deine Dateibytes bleiben von unseren Servern fern. Falls das passiert, ist die verlässliche Antwort daemon-direct zwischen zwei erreichbaren Servern oder push über SSH.",
      ],
      bullets: [
        "Direkte Verbindung gelingt → kostenlos, volle Geschwindigkeit, Ende-zu-Ende verschlüsselt.",
        "Kein direkter Pfad → die Übertragung schlägt fehl; die CLI leitet die Datei niemals stellvertretend für dich weiter.",
        "Beide Enden können geografisch überall sein — der Absender führt einfach send aus, der Empfänger receive mit dem Code, den es ausgegeben hat.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Woher kommt der Pairing-Code?",
        a: "Relayium erzeugt ihn. Führe `relayium send ./release.zip` aus (nach `relayium login`), und die CLI gibt einen Code aus 6 Zeichen aus, der fünf Minuten gilt, dazu den genauen Befehl für die andere Seite. Selbst wählen kannst du ihn nicht — der Server akzeptiert nur Codes, die er selbst ausgegeben hat.",
      },
      {
        q: "Wird die Datei irgendwohin hochgeladen?",
        a: "Nein. Die Datei fließt direkt zwischen euch beiden, Ende-zu-Ende verschlüsselt. Nur ein kleiner Rendezvous-Handshake läuft über Relayium, um die Enden einander vorzustellen — die Datei nie.",
      },
      {
        q: "Was, wenn wir keine Verbindung herstellen können?",
        a: "Stehen beide Enden hinter strengem NAT ohne erreichbare Adresse, kann die direkte Verbindung nicht hergestellt werden und die Übertragung schlägt fehl — die CLI hat absichtlich kein Relay-Fallback. Nutzt daemon-direct zwischen zwei erreichbaren Servern oder push über SSH, wenn kein direkter Pfad verfügbar ist.",
      },
      {
        q: "Woher weiß ich, dass wirklich die richtige Person am anderen Ende ist?",
        a: "Beide Terminals geben einen identischen 6-stelligen SAS-Code aus den angehefteten TLS-Zertifikatsfingerabdrücken aus. Vergleicht ihn außerhalb des Kanals; eine Übereinstimmung bestätigt, dass die Fingerabdrücke nicht ausgetauscht wurden und der Rendezvous-Dienst keinen Endpunkt imitiert hat. Er authentifiziert die Endpunkte, nicht jeden Netzwerk-Hop. Fügt --verify hinzu, um diese Bestätigung zu verlangen, bevor Bytes bewegt werden.",
      },
    ],
  },
  cta: {
    text: "Schicke deine nächste Datei direkt an jemanden in einem anderen Netzwerk — Ende-zu-Ende verschlüsselt und kostenlos.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer un fichier à quelqu'un à travers les réseaux avec la CLI Relayium",
  description:
    "Utilisez relayium send et receive pour déplacer un fichier directement entre deux personnes sur des réseaux différents, à l'aide d'un court code d'appairage. Chiffré de bout en bout, vérifié par un code SAS, et gratuit — le fichier va tout droit entre vous, jamais via nos serveurs.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Parfois l'autre machine n'est pas la vôtre et vous ne pouvez pas vous y connecter en SSH — un fichier pour un collègue dans un autre bureau, un build pour un client, une archive pour un ami à l'autre bout du pays. relayium send et receive le déplacent directement entre vous deux à travers les réseaux, en utilisant seulement un court code d'appairage que votre CLI génère au moment de l'envoi.",
    "La connexion est pair-à-pair et chiffrée de bout en bout. Seule une minuscule poignée de main de rendez-vous passe par Relayium pour présenter les deux extrémités ; les octets du fichier, eux, jamais.",
  ],
  sections: [
    {
      heading: "Faire send, puis transmettre le code affiché",
      body: [
        "Connectez-vous une fois avec relayium login, puis contentez-vous de faire send. La CLI génère un code d'appairage, l'affiche avec la commande exacte que l'autre extrémité doit exécuter, et attend. Transmettez ce code hors bande — dites-le au téléphone, glissez-le dans un chat :",
      ],
      code: [
        `# expéditeur (une fois par machine : relayium login)
relayium send ./release.zip
# affiche :  Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# destinataire (dans le dossier où les fichiers doivent arriver) — aucun compte nécessaire
relayium receive K7M4XR`,
      ],
      bullets: [
        "Le code fait 6 caractères tirés d'un alphabet restreint — ni 0 ni 1, et rien qui puisse être confondu à l'oral — et il expire 5 minutes après sa génération.",
        "Seul l'expéditeur se connecte. Le destinataire a besoin de la CLI et du code, et d'aucun compte.",
        "Le code n'est qu'un secret partagé pour se retrouver ; il n'est envoyé à personne d'autre qu'au point de rendez-vous, et il ne sert qu'à présenter les deux extrémités.",
        "Le destinataire peut indiquer un répertoire de destination : relayium receive K7M4XR ./downloads",
        "Les deux extrémités doivent être la CLI — un navigateur ne peut pas rejoindre un code d'appairage CLI. Vous envoyez à quelqu'un qui n'a qu'un navigateur ? Utilisez plutôt relayium up, qui vous donne un lien de téléchargement.",
      ],
    },
    {
      heading: "Vérifier avec le code SAS",
      body: [
        "Quand les deux extrémités se connectent, les deux terminaux affichent le même SAS (short authentication string) à 6 chiffres, dérivé des empreintes des certificats TLS épinglés. Comparez-le hors bande — lisez-le à voix haute pendant l'appel — pour confirmer que les empreintes n'ont pas été substituées et que le service de rendez-vous n'a usurpé aucune extrémité. Le SAS authentifie les extrémités ; il ne prouve pas chaque saut réseau.",
        "Pour la protection la plus forte, ajoutez --verify : le transfert attend alors que vous confirmiez que les codes correspondent avant qu'un seul octet ne bouge.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Direct uniquement — gratuit, sinon ça échoue",
      body: [
        "Le transfert tente d'établir en priorité une connexion directe entre les deux extrémités. Quand elle peut être établie — le cas courant dès qu'au moins un côté a une adresse joignable —, le fichier passe tout droit, chiffré, à pleine vitesse et sans frais.",
        "Si les deux extrémités sont derrière un NAT strict et qu'aucun chemin direct n'est trouvé, le transfert échoue proprement plutôt que de faire transiter votre fichier par un relais. Cela garde la CLI entièrement gratuite et garde les octets de votre fichier hors de nos serveurs. Si cela vous arrive, la réponse fiable est le daemon-direct entre deux serveurs joignables, ou le push via SSH.",
      ],
      bullets: [
        "Connexion directe réussie → gratuit, pleine vitesse, chiffré de bout en bout.",
        "Aucun chemin direct → le transfert échoue ; la CLI ne fait jamais transiter le fichier à votre place.",
        "Les deux extrémités peuvent être n'importe où géographiquement — l'expéditeur lance simplement send, et le destinataire lance receive avec le code affiché.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "D'où vient le code d'appairage ?",
        a: "C'est Relayium qui le génère. Lancez `relayium send ./release.zip` (après `relayium login`) et la CLI affiche un code de 6 caractères valable cinq minutes, ainsi que la commande exacte que l'autre extrémité doit exécuter. Vous ne pouvez pas le choisir vous-même — le serveur n'accepte que les codes qu'il a émis.",
      },
      {
        q: "Le fichier est-il envoyé quelque part ?",
        a: "Non. Le fichier circule directement entre vous deux, chiffré de bout en bout. Seule une petite poignée de main de rendez-vous passe par Relayium pour présenter les extrémités — jamais le fichier.",
      },
      {
        q: "Que se passe-t-il si nous ne pouvons pas nous connecter ?",
        a: "Si les deux extrémités sont derrière un NAT strict sans adresse joignable, la connexion directe ne peut pas être établie et le transfert échoue — la CLI n'a volontairement aucun repli par relais. Utilisez le daemon-direct entre deux serveurs joignables, ou le push via SSH, quand aucun chemin direct n'est disponible.",
      },
      {
        q: "Comment savoir que c'est vraiment la bonne personne en face ?",
        a: "Les deux terminaux affichent un code SAS identique à 6 chiffres dérivé des empreintes des certificats TLS épinglés. Comparez-le hors bande ; une concordance confirme que les empreintes n'ont pas été substituées et que le service de rendez-vous n'a usurpé aucune extrémité. Il authentifie les extrémités, pas chaque saut réseau. Ajoutez --verify pour exiger cette confirmation avant qu'aucun octet ne bouge.",
      },
    ],
  },
  cta: {
    text: "Envoyez votre prochain fichier directement à quelqu'un sur un autre réseau — chiffré de bout en bout, et gratuit.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "إرسال ملف إلى شخص ما عبر الشبكات باستخدام واجهة Relayium الطرفية (CLI)",
  description:
    "استخدم relayium send وreceive لنقل ملف مباشرةً بين شخصين على شبكتين مختلفتين، بالاعتماد على رمز اقتران قصير. مُشفَّر من الطرف إلى الطرف، ويُتحقَّق منه برمز SAS، ومجاني — يذهب الملف مباشرةً بينكما، ولا يمر أبدًا عبر خوادمنا.",
  updatedLabel: "آخر تحديث",
  lead: [
    "أحيانًا لا يكون الجهاز الآخر جهازك ولا يمكنك الدخول إليه عبر SSH — ملف لزميل في مكتب آخر، أو نسخة بناء لعميل، أو أرشيف لصديق في الطرف الآخر من البلاد. يقوم relayium send وreceive بنقله مباشرةً بينكما عبر الشبكات، بالاعتماد فقط على رمز اقتران قصير تُصدره واجهة CLI لديك عند الإرسال.",
    "الاتصال من الند للند (P2P) ومُشفَّر من الطرف إلى الطرف. لا يمر عبر Relayium سوى مصافحة تعارف ضئيلة للغاية تُعرِّف الطرفين ببعضهما؛ أما بايتات الملف فلا تمر أبدًا.",
  ],
  sections: [
    {
      heading: "أرسِل أولًا، ثم مرِّر الرمز الذي يُطبَع لك",
      body: [
        "سجِّل الدخول مرة واحدة عبر relayium login، ثم اكتفِ بالإرسال. تُصدر واجهة CLI رمز اقتران وتطبعه مع الأمر الذي سينفّذه الطرف الآخر بالضبط، ثم تنتظر. مرِّر هذا الرمز خارج القناة — قُله في مكالمة، أو ألقِه في محادثة:",
      ],
      code: [
        `# المُرسِل (مرة واحدة لكل جهاز: relayium login)
relayium send ./release.zip
# يطبع:   Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# المُستقبِل (في المجلد الذي يجب أن تصل إليه الملفات) — بلا حساب
relayium receive K7M4XR`,
      ],
      bullets: [
        "الرمز مكوَّن من 6 محارف من أبجدية مقيَّدة — بلا 0 أو 1، وبلا أي محرف يسهل الخلط بينه وبين غيره عند النطق — وينتهي مفعوله بعد 5 دقائق من إصداره.",
        "المُرسِل وحده هو من يسجّل الدخول. أما المُستقبِل فيحتاج إلى واجهة CLI والرمز فقط، ولا يحتاج إلى حساب إطلاقًا.",
        "الرمز مجرد سر مشترك للقاء؛ لا يُرسَل إلى أحد سوى نقطة التعارف، وهو يُعرِّف الطرفين ببعضهما فقط.",
        "يمكن للمُستقبِل تمرير مجلد وجهة: relayium receive K7M4XR ./downloads",
        "يجب أن يكون الطرفان كلاهما على واجهة CLI — فالمتصفح لا يستطيع الانضمام إلى رمز اقتران خاص بـ CLI. هل تُرسِل إلى شخص لا يملك سوى متصفح؟ استخدم relayium up بدلًا من ذلك، فهو يعطيك رابط تنزيل.",
      ],
    },
    {
      heading: "التحقق برمز SAS",
      body: [
        "عندما يتصل الطرفان، تطبع كلتا الطرفيتين رمز SAS (سلسلة المصادقة القصيرة) المكوَّن من 6 أرقام نفسه، والمُشتَق من بصمات شهادات TLS المثبّتة. قارنهما خارج القناة — اقرأ الرمز بصوت عالٍ في المكالمة — لتأكيد أن البصمات لم تُستبدل وأن خدمة الالتقاء لم تنتحل شخصية أي طرف. يصادق SAS على الطرفين؛ ولا يثبت كل قفزة في مسار الشبكة.",
        "لأقوى حماية، أضِف --verify: عندئذٍ ينتظر النقل حتى تؤكد أن الرمزين متطابقان قبل أن يتحرك بايت واحد.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "مباشر فقط — مجاني، أو يفشل",
      body: [
        "يتسابق النقل على إنشاء اتصال مباشر بين الطرفين. حين يمكن إنشاؤه — وهي الحالة الشائعة ما دام لأحد الطرفين على الأقل عنوان يمكن الوصول إليه — يتدفق الملف مباشرةً، مُشفَّرًا، بأقصى سرعة وبلا تكلفة.",
        "إذا كان الطرفان خلف NAT صارم ولم يُعثَر على مسار مباشر، يفشل النقل بنظافة بدلًا من توجيه ملفك عبر مُرحِّل. هذا يبقي واجهة CLI مجانية تمامًا ويُبعد بايتات ملفك عن خوادمنا. إن واجهت هذا، فالحل الموثوق هو daemon direct بين خادمين يمكن الوصول إليهما، أو push عبر SSH.",
      ],
      bullets: [
        "نجاح الاتصال المباشر ← مجاني، بأقصى سرعة، مُشفَّر من الطرف إلى الطرف.",
        "لا مسار مباشر ← يفشل النقل؛ لا تُوكِّل CLI أبدًا بترحيل الملف نيابةً عنك.",
        "يمكن أن يكون الطرفان في أي مكان جغرافيًا — يكفي أن يشغّل المُرسِل send، وأن يشغّل المُستقبِل receive بالرمز الذي طُبع.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "من أين يأتي رمز الاقتران؟",
        a: "‏Relayium هو من يُصدره. شغِّل `relayium send ./release.zip` (بعد `relayium login`) فتطبع واجهة CLI رمزًا من 6 محارف صالحًا لخمس دقائق، مع الأمر الذي سينفّذه الطرف الآخر بالضبط. لا يمكنك اختياره بنفسك — فالخادم لا يقبل إلا الرموز التي أصدرها هو.",
      },
      {
        q: "هل يُرفَع الملف إلى أي مكان؟",
        a: "لا. يتدفق الملف مباشرةً بينكما، مُشفَّرًا من الطرف إلى الطرف. لا يمر عبر Relayium سوى مصافحة تعارف صغيرة لتعريف الطرفين — أما الملف فلا يمر أبدًا.",
      },
      {
        q: "ماذا لو تعذَّر علينا الاتصال؟",
        a: "إذا كان الطرفان خلف NAT صارم بلا عنوان يمكن الوصول إليه، فلا يمكن إنشاء الاتصال المباشر ويفشل النقل — فواجهة CLI لا تملك احتياطيًا عبر مُرحِّل، وهذا بحكم التصميم. استخدم daemon direct بين خادمين يمكن الوصول إليهما، أو push عبر SSH، حين لا يتوفر مسار مباشر.",
      },
      {
        q: "كيف أعرف أنه فعلًا الشخص الصحيح على الطرف الآخر؟",
        a: "تطبع كلتا الطرفيتين رمز SAS متطابقًا من 6 أرقام مُشتَقًا من بصمات شهادات TLS المثبّتة. قارنهما خارج القناة؛ يؤكد التطابق أن البصمات لم تُستبدل وأن خدمة الالتقاء لم تنتحل شخصية أي طرف. يصادق الرمز على الطرفين، لا على كل قفزة في مسار الشبكة. أضِف --verify لتشترط ذلك التأكيد قبل أن يتحرك أي بايت.",
      },
    ],
  },
  cta: {
    text: "أرسِل ملفك التالي مباشرةً إلى شخص على شبكة أخرى — مُشفَّرًا من الطرف إلى الطرف، ومجانًا.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Enviar un archivo a alguien entre redes con la CLI de Relayium",
  description:
    "Usa relayium send y receive para mover un archivo directamente entre dos personas en redes distintas, con un breve código de emparejamiento. Cifrado de extremo a extremo, verificado con un código SAS y gratis: el archivo va directo entre los dos extremos, nunca a través de nuestros servidores.",
  updatedLabel: "Última actualización",
  lead: [
    "A veces la otra máquina no es tuya y no puedes entrar por SSH: un archivo para un colega en otra oficina, una compilación para un cliente, un archivo comprimido para un amigo al otro lado del país. relayium send y receive lo mueven directamente entre las dos partes, entre redes, usando solo un código de emparejamiento corto que tu CLI genera al enviar.",
    "La conexión es de igual a igual y cifrada de extremo a extremo. Solo un pequeñísimo handshake con el punto de encuentro pasa por Relayium para presentar los dos extremos; los bytes del archivo nunca lo hacen.",
  ],
  sections: [
    {
      heading: "Envía y luego pasa el código que imprime",
      body: [
        "Inicia sesión una vez con relayium login y después solo envía. La CLI genera un código de emparejamiento, lo imprime junto con el comando exacto que ejecuta el otro extremo, y espera. Pasa ese código fuera de banda: dilo en una llamada, escríbelo en un chat:",
      ],
      code: [
        `# quien envía (una vez por máquina: relayium login)
relayium send ./release.zip
# imprime:  Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# quien recibe (en la carpeta donde deben llegar los archivos) — sin cuenta
relayium receive K7M4XR`,
      ],
      bullets: [
        "El código tiene 6 caracteres de un alfabeto restringido —sin 0 ni 1, y sin nada que se confunda al leerlo en voz alta— y caduca 5 minutos después de generarse.",
        "Solo el remitente inicia sesión. El receptor necesita la CLI y el código, y ninguna cuenta.",
        "El código es solo un secreto compartido para encontrarse; no se envía a nadie más que al punto de encuentro, y solo sirve para presentar los dos extremos.",
        "El receptor puede indicar un directorio de destino: relayium receive K7M4XR ./downloads",
        "Ambos extremos tienen que ser la CLI: un navegador no puede unirse a un código de emparejamiento de la CLI. ¿Envías a alguien que solo tiene navegador? Usa relayium up, que te da un enlace de descarga.",
      ],
    },
    {
      heading: "Verificar con el código SAS",
      body: [
        "Cuando los dos extremos se conectan, ambas terminales muestran el mismo SAS (short authentication string) de 6 dígitos derivado de las huellas de sus certificados TLS fijados. Compáralo fuera de banda —léelo en voz alta durante la llamada— para confirmar que las huellas no fueron sustituidas y que el servicio de encuentro no suplantó a ninguno de los extremos. El SAS autentica los extremos; no demuestra cada salto de la ruta de red.",
        "Para obtener la protección más fuerte, añade --verify: la transferencia esperará a que confirmes que los códigos coinciden antes de que se mueva un solo byte.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Solo directo: gratis, o falla",
      body: [
        "La transferencia compite por establecer una conexión directa entre los dos extremos. Cuando se puede establecer —lo habitual cuando al menos un lado tiene una dirección alcanzable— el archivo fluye directo, cifrado, a máxima velocidad y sin coste.",
        "Si ambos extremos están detrás de un NAT estricto y no se encuentra ninguna ruta directa, la transferencia falla limpiamente en lugar de enrutar tu archivo a través de un retransmisor. Eso mantiene la CLI completamente gratis y mantiene los bytes de tu archivo fuera de nuestros servidores. Si te ocurre esto, la respuesta fiable es daemon directo entre dos servidores alcanzables, o push por SSH.",
      ],
      bullets: [
        "La conexión directa tiene éxito → gratis, a máxima velocidad, cifrada de extremo a extremo.",
        "Sin ruta directa → la transferencia falla; la CLI nunca hace de proxy del archivo por ti.",
        "Ambos extremos pueden estar en cualquier lugar geográficamente; quien envía solo ejecuta send, y quien recibe ejecuta receive con el código que se imprimió.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿De dónde sale el código de emparejamiento?",
        a: "Lo genera Relayium. Ejecuta `relayium send ./release.zip` (después de `relayium login`) y la CLI imprime un código de 6 caracteres válido durante cinco minutos, junto con el comando exacto que ejecuta el otro extremo. No puedes elegirlo tú: el servidor solo acepta los códigos que él mismo emitió.",
      },
      {
        q: "¿Se sube el archivo a algún sitio?",
        a: "No. El archivo fluye directamente entre las dos partes, cifrado de extremo a extremo. Solo un pequeño handshake con el punto de encuentro pasa por Relayium para presentar los extremos; el archivo nunca.",
      },
      {
        q: "¿Y si no podemos conectarnos?",
        a: "Si ambos extremos están detrás de un NAT estricto sin dirección alcanzable, no se puede establecer la conexión directa y la transferencia falla: la CLI no tiene respaldo por retransmisor, por diseño. Usa daemon directo entre dos servidores alcanzables, o push por SSH, cuando no haya una ruta directa disponible.",
      },
      {
        q: "¿Cómo sé que de verdad es la persona correcta al otro lado?",
        a: "Ambas terminales muestran un código SAS idéntico de 6 dígitos derivado de las huellas de sus certificados TLS fijados. Compáralo fuera de banda; la coincidencia confirma que las huellas no fueron sustituidas y que el servicio de encuentro no suplantó a ninguno de los extremos. Autentica los extremos, no cada salto de la ruta de red. Añade --verify para exigir esa confirmación antes de que se muevan bytes.",
      },
    ],
  },
  cta: {
    text: "Envía tu próximo archivo directamente a alguien en otra red: cifrado de extremo a extremo y gratis.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Enviar um arquivo para alguém entre redes com a CLI do Relayium",
  description:
    "Use relayium send e receive para mover um arquivo diretamente entre duas pessoas em redes diferentes, com um código de emparelhamento curto. Com criptografia de ponta a ponta, verificado com um código SAS e gratuito: o arquivo vai direto entre as duas pontas, nunca através dos nossos servidores.",
  updatedLabel: "Última atualização",
  lead: [
    "Às vezes a outra máquina não é sua e você não consegue entrar por SSH: um arquivo para um colega em outro escritório, um build para um cliente, um arquivo compactado para um amigo do outro lado do país. relayium send e receive o movem diretamente entre as duas partes, entre redes, usando apenas um código de emparelhamento curto que a sua CLI gera na hora de enviar.",
    "A conexão é ponto a ponto e com criptografia de ponta a ponta. Apenas um pequeníssimo handshake de encontro passa pelo Relayium para apresentar as duas pontas; os bytes do arquivo nunca passam.",
  ],
  sections: [
    {
      heading: "Envie e depois repasse o código que aparece",
      body: [
        "Faça login uma vez com relayium login e depois é só enviar. A CLI gera um código de emparelhamento, exibe-o junto com o comando exato que a outra ponta executa, e fica aguardando. Repasse esse código fora de banda: diga em uma chamada, coloque em um chat:",
      ],
      code: [
        `# quem envia (uma vez por máquina: relayium login)
relayium send ./release.zip
# imprime:  Code: K7M4XR   (valid 5 minutes)
#          On the other machine:  relayium receive K7M4XR

# quem recebe (na pasta onde os arquivos devem chegar) — sem conta
relayium receive K7M4XR`,
      ],
      bullets: [
        "O código tem 6 caracteres de um alfabeto restrito — sem 0 nem 1, e sem nada que se confunda ao ser lido em voz alta — e expira 5 minutos depois de gerado.",
        "Só quem envia faz login. Quem recebe precisa da CLI e do código, e de conta nenhuma.",
        "O código é apenas um segredo compartilhado para se encontrar; não é enviado a ninguém além do ponto de encontro, e serve apenas para apresentar as duas pontas.",
        "O receptor pode indicar um diretório de destino: relayium receive K7M4XR ./downloads",
        "As duas pontas precisam ser a CLI — um navegador não consegue entrar em um código de emparelhamento da CLI. Vai enviar para alguém que só tem navegador? Use relayium up, que devolve um link de download.",
      ],
    },
    {
      heading: "Verificar com o código SAS",
      body: [
        "Quando as duas pontas se conectam, os dois terminais exibem o mesmo SAS (short authentication string) de 6 dígitos derivado das impressões digitais dos certificados TLS fixados. Compare-o fora de banda — leia em voz alta durante a chamada — para confirmar que as impressões digitais não foram substituídas e que o serviço de encontro não se passou por nenhuma das pontas. O SAS autentica as pontas; não prova cada salto da rota de rede.",
        "Para a proteção mais forte, adicione --verify: a transferência então espera que você confirme que os códigos coincidem antes que um único byte se mova.",
      ],
      code: ["relayium send --verify ./release.zip"],
    },
    {
      heading: "Somente direto: gratuito, ou falha",
      body: [
        "A transferência disputa o estabelecimento de uma conexão direta entre as duas pontas. Quando ela pode ser estabelecida — o caso comum quando pelo menos um lado tem um endereço alcançável — o arquivo flui direto, criptografado, na velocidade máxima e sem custo.",
        "Se ambas as pontas estiverem atrás de um NAT estrito e nenhum caminho direto puder ser encontrado, a transferência falha de forma limpa em vez de rotear seu arquivo por um retransmissor. Isso mantém a CLI completamente gratuita e mantém os bytes do seu arquivo fora dos nossos servidores. Se você se deparar com isso, a resposta confiável é daemon direto entre dois servidores alcançáveis, ou push por SSH.",
      ],
      bullets: [
        "A conexão direta é bem-sucedida → gratuita, na velocidade máxima, com criptografia de ponta a ponta.",
        "Sem caminho direto → a transferência falha; a CLI nunca faz proxy do arquivo por você.",
        "Ambas as pontas podem estar em qualquer lugar geograficamente — quem envia só roda send, e quem recebe roda receive com o código que apareceu.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "De onde vem o código de emparelhamento?",
        a: "Quem gera é o Relayium. Rode `relayium send ./release.zip` (depois de `relayium login`) e a CLI exibe um código de 6 caracteres válido por cinco minutos, junto com o comando exato que a outra ponta executa. Você não pode escolhê-lo — o servidor só aceita os códigos que ele mesmo emitiu.",
      },
      {
        q: "O arquivo é enviado para algum lugar?",
        a: "Não. O arquivo flui diretamente entre as duas partes, com criptografia de ponta a ponta. Apenas um pequeno handshake de encontro passa pelo Relayium para apresentar as pontas — nunca o arquivo.",
      },
      {
        q: "E se não conseguirmos conectar?",
        a: "Se ambas as pontas estiverem atrás de um NAT estrito sem endereço alcançável, a conexão direta não pode ser feita e a transferência falha — a CLI não tem retorno por retransmissor, por decisão de projeto. Use daemon direto entre dois servidores alcançáveis, ou push por SSH, quando não houver um caminho direto disponível.",
      },
      {
        q: "Como sei que é mesmo a pessoa certa do outro lado?",
        a: "Os dois terminais exibem um código SAS idêntico de 6 dígitos derivado das impressões digitais dos certificados TLS fixados. Compare-o fora de banda; a coincidência confirma que as impressões digitais não foram substituídas e que o serviço de encontro não se passou por nenhuma das pontas. Ele autentica as pontas, não cada salto da rota de rede. Adicione --verify para exigir essa confirmação antes que qualquer byte se mova.",
      },
    ],
  },
  cta: {
    text: "Envie seu próximo arquivo diretamente para alguém em outra rede — com criptografia de ponta a ponta e gratuito.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "guides/send-a-file-to-someone",
  published: "2026-07-08",
  updated: "2026-07-31",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
