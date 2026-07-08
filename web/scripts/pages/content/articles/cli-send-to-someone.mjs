// web/scripts/pages/content/articles/cli-send-to-someone.mjs
// How-to: send a file to another person across networks with relayium send/receive.
// English is the master; zh/ja/ko/de/fr follow the same structure and facts.
// Command blocks (code) stay English in every language.

const en = {
  title: "Send a file to someone across networks with the Relayium CLI",
  description:
    "Use relayium send and receive to move a file directly between two people on different networks, using a short pairing code. End-to-end encrypted, verified with a SAS code, and free — the file goes straight between you, never through our servers.",
  updatedLabel: "Last updated",
  lead: [
    "Sometimes the other machine isn't yours and you can't SSH into it — a file for a colleague in another office, a build for a client, an archive for a friend across the country. relayium send and receive move it directly between the two of you across networks, using nothing but a short code you agree on.",
    "The connection is peer-to-peer and end-to-end encrypted. Only a tiny rendezvous handshake passes through Relayium to introduce the two ends; the file bytes never do.",
  ],
  sections: [
    {
      heading: "Agree on a code, then send and receive",
      body: [
        "Pick any short code and share it out of band — say it over a call, drop it in a chat. One side sends, the other receives with the same code:",
      ],
      code: [
        `# sender
relayium send ./release.zip 428571

# receiver (in the folder where files should land)
relayium receive 428571`,
      ],
      bullets: [
        "The code is just a shared secret to meet on; it isn't sent to anyone but the rendezvous, and it introduces the two ends only.",
        "The receiver can pass a destination directory: relayium receive 428571 ./downloads",
      ],
    },
    {
      heading: "Verify with the SAS code",
      body: [
        "When the two ends connect, both terminals print the same 6-digit SAS (short authentication string) derived from the session keys. Compare them — read it aloud on the call — to be sure you're connected to each other and not to someone in the middle.",
        "For a hard guarantee, add --verify: the transfer then waits for you to confirm the codes match before a single byte moves.",
      ],
      code: ["relayium send --verify ./release.zip 428571"],
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
        "Both ends can be anywhere geographically — they just each need to run the command with the same code.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Where does the pairing code come from?",
        a: "You make it up. It's any short string both sides type — agree on it over a call or a chat. It only needs to match on both ends.",
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
        a: "Both terminals print an identical 6-digit SAS code from the session keys. Compare them out of band; if they match, there's no one in the middle. Add --verify to require that confirmation before any bytes move.",
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
    "有时候对方的机器不是你的，你也没法用 SSH 登录进去——给另一个办公室的同事发个文件，给客户发个构建产物，给国外的朋友发个压缩包。relayium send 和 receive 会跨网络把文件直接送到你们两个之间，靠的只是你们事先约定好的一个简短的码。",
    "连接是点对点、端到端加密的。只有一次极小的会合握手会经过 Relayium 来介绍双方；文件字节从不经过。",
  ],
  sections: [
    {
      heading: "约定一个码，然后 send 和 receive",
      body: [
        "随便选一个简短的码，用带外方式分享它——打电话说一下，或者丢进聊天里。一方 send，另一方用同一个码 receive：",
      ],
      code: [
        `# sender
relayium send ./release.zip 428571

# receiver (in the folder where files should land)
relayium receive 428571`,
      ],
      bullets: [
        "这个码只是一个用来会合的共享密钥；除了会合服务器，它不会发给任何人，而且只用来介绍双方。",
        "接收方可以指定目标目录：relayium receive 428571 ./downloads",
      ],
    },
    {
      heading: "用 SAS 码验证",
      body: [
        "两端连接建立后，两边的终端会打印出同一个从会话密钥派生的 6 位 SAS（简短认证串）。对比一下——打电话时念出来——确保你们连接的是彼此，而不是中间人。",
        "要获得硬保证，加上 --verify：传输会等你确认两边的码一致后，才会移动哪怕一个字节。",
      ],
      code: ["relayium send --verify ./release.zip 428571"],
    },
    {
      heading: "只走直连——免费，否则失败",
      body: [
        "传输会在两端之间竞速建立直连。一旦能建立——这是常见情况，只要至少一方有可达地址——文件就会直接、加密地全速传输，不收费。",
        "如果两端都在严格 NAT 之后，找不到直连路径，传输会干净地失败，而不会把你的文件路由经过中继。这样才能让 CLI 保持完全免费，也让你的文件字节远离我们的服务器。如果遇到这种情况，可靠的办法是在两台可达的服务器之间用 daemon direct，或者用 SSH push。",
      ],
      bullets: [
        "直连成功 → 免费、全速、端到端加密。",
        "没有直连路径 → 传输失败；CLI 从不替你代理文件。",
        "两端在地理上可以在任何地方——只需要各自用同一个码运行命令。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "配对码是从哪来的？",
        a: "是你自己定的。任何一个双方都能输入的简短字符串都行——打电话或聊天时约定好。它只需要在两端一致即可。",
      },
      {
        q: "文件会上传到什么地方吗？",
        a: "不会。文件在你们两个之间直接流式传输，端到端加密。只有一次很小的会合握手会经过 Relayium 来介绍双方——文件本身从不经过。",
      },
      {
        q: "如果连接不上怎么办？",
        a: "如果两端都在严格 NAT 之后、没有可达地址，就无法建立直连，传输会失败——CLI 按设计没有中继兜底。当没有直连路径时，可以在两台可达的服务器之间用 daemon direct，或者用 SSH push。",
      },
      {
        q: "我怎么知道对面真的是对的人？",
        a: "两边的终端会打印出一个从会话密钥得出的相同的 6 位 SAS 码。用带外方式对比一下；如果一致，就说明中间没有人。加上 --verify 可以要求在任何字节移动之前先完成这个确认。",
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
    "relayium send と receive を使い、短いペアリングコードだけで異なるネットワーク上の2人の間でファイルを直接移動します。エンドツーエンドで暗号化され、SAS コードで検証され、しかも無料——ファイルは二人の間を直接行き来し、当社のサーバーを経由することはありません。",
  updatedLabel: "最終更新",
  lead: [
    "相手のマシンが自分のものではなく SSH でログインできないこともあります——別のオフィスの同僚へのファイル、クライアント向けのビルド、遠方の友人へのアーカイブ。relayium send と receive は、二人で決めた短いコードだけを使って、ネットワークを越えてそれを二人の間で直接移動させます。",
    "接続はピアツーピアでエンドツーエンドに暗号化されています。二つの端を引き合わせるためのごく小さなランデブー・ハンドシェイクだけが Relayium を経由し、ファイルのバイトは決して経由しません。",
  ],
  sections: [
    {
      heading: "コードを決めてから send と receive",
      body: [
        "好きな短いコードを選び、帯域外で共有します——通話で伝える、チャットに書く、など。一方が send し、もう一方が同じコードで receive します：",
      ],
      code: [
        `# sender
relayium send ./release.zip 428571

# receiver (in the folder where files should land)
relayium receive 428571`,
      ],
      bullets: [
        "コードは合流するための共有シークレットにすぎません。ランデブー先以外の誰にも送られず、二つの端を引き合わせるためだけに使われます。",
        "受信側は送り先のディレクトリを指定できます: relayium receive 428571 ./downloads",
      ],
    },
    {
      heading: "SAS コードで検証する",
      body: [
        "二つの端が接続すると、両方のターミナルにセッション鍵から導かれた同じ6桁の SAS（short authentication string）が表示されます。それを比べて——通話中に読み上げて——中間の誰かではなく、お互いに接続していることを確認してください。",
        "確実な保証が欲しいときは --verify を付けます。すると転送は、コードが一致することをあなたが確認するまで、1バイトも動かさずに待機します。",
      ],
      code: ["relayium send --verify ./release.zip 428571"],
    },
    {
      heading: "直接接続のみ——無料、さもなくば失敗",
      body: [
        "転送は二つの端の間で直接接続の確立を競います。確立できれば——少なくとも一方に到達可能なアドレスがある一般的なケースでは——ファイルはそのまま暗号化された状態で全速力かつ無料で流れます。",
        "両端が厳格な NAT の内側にあり直接の経路が見つからない場合、転送はリレー経由でファイルを送るのではなく、きれいに失敗します。これにより CLI は完全に無料のままで、ファイルのバイトも当社のサーバーに触れません。この状況に当たった場合、確実な答えは到達可能な2台のサーバー間での daemon direct、または SSH 経由の push です。",
      ],
      bullets: [
        "直接接続が成功 → 無料、全速力、エンドツーエンドで暗号化。",
        "直接の経路がない → 転送は失敗します。CLI が代わりにファイルを中継することは決してありません。",
        "両端は地理的にどこにあっても構いません——それぞれが同じコードでコマンドを実行するだけです。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ペアリングコードはどこから来るのですか？",
        a: "自分で決めます。両側が入力する任意の短い文字列で構いません——通話やチャットで決めてください。両端で一致してさえいればよいのです。",
      },
      {
        q: "ファイルはどこかにアップロードされますか？",
        a: "いいえ。ファイルは二人の間で直接ストリーミングされ、エンドツーエンドで暗号化されます。二つの端を引き合わせるためのごく小さなランデブー・ハンドシェイクだけが Relayium を経由し、ファイルは決して経由しません。",
      },
      {
        q: "接続できない場合はどうなりますか？",
        a: "両端が厳格な NAT の内側にあり到達可能なアドレスがない場合、直接接続は確立できず転送は失敗します——CLI は設計上リレーへのフォールバックを持ちません。直接の経路が使えない場合は、到達可能な2台のサーバー間での daemon direct、または SSH 経由の push を使ってください。",
      },
      {
        q: "相手が本当に正しい人物だとどうやって分かりますか？",
        a: "両方のターミナルがセッション鍵から得た同一の6桁の SAS コードを表示します。帯域外で比べてください。一致すれば、間に誰もいないということです。バイトが動く前にその確認を必須にするには --verify を追加します。",
      },
    ],
  },
  cta: {
    text: "次のファイルを、別のネットワークにいる相手へ直接送りましょう——エンドツーエンドで暗号化され、しかも無料です。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium CLI로 네트워크를 넘어 상대에게 파일 보내기",
  description:
    "relayium send와 receive를 사용해, 짧은 페어링 코드 하나로 서로 다른 네트워크에 있는 두 사람 사이에서 파일을 직접 옮기세요. 종단간 암호화되고 SAS 코드로 검증되며 무료입니다——파일은 두 사람 사이를 곧장 오가며, 저희 서버를 절대 거치지 않습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "때로는 상대의 컴퓨터가 내 것이 아니어서 SSH로 접속할 수 없을 때가 있습니다——다른 사무실 동료에게 줄 파일, 고객에게 줄 빌드, 먼 곳의 친구에게 줄 아카이브. relayium send와 receive는 두 사람이 합의한 짧은 코드 하나만으로 네트워크를 넘어 그것을 두 사람 사이에 직접 옮깁니다.",
    "연결은 피어투피어이며 종단간 암호화됩니다. 두 끝을 서로 소개하기 위한 아주 작은 랑데부 핸드셰이크만 Relayium을 거치며, 파일 바이트는 결코 거치지 않습니다.",
  ],
  sections: [
    {
      heading: "코드를 합의한 뒤 send와 receive",
      body: [
        "아무 짧은 코드나 정해서 대역 외 방식으로 공유하세요——통화로 말하거나 채팅에 남기면 됩니다. 한쪽이 send하고, 다른 쪽이 같은 코드로 receive합니다:",
      ],
      code: [
        `# sender
relayium send ./release.zip 428571

# receiver (in the folder where files should land)
relayium receive 428571`,
      ],
      bullets: [
        "이 코드는 만남을 위한 공유 비밀일 뿐입니다. 랑데부 서버 외에는 누구에게도 전송되지 않으며, 오직 두 끝을 서로 소개하는 데만 쓰입니다.",
        "받는 쪽은 대상 디렉터리를 지정할 수 있습니다: relayium receive 428571 ./downloads",
      ],
    },
    {
      heading: "SAS 코드로 검증하기",
      body: [
        "두 끝이 연결되면 양쪽 터미널에 세션 키에서 파생된 동일한 6자리 SAS(짧은 인증 문자열)가 출력됩니다. 이를 비교해——통화 중에 소리 내어 읽어——중간의 누군가가 아니라 서로 연결되어 있음을 확인하세요.",
        "확실한 보장이 필요하면 --verify를 추가하세요. 그러면 전송은 코드가 일치함을 당신이 확인할 때까지 단 1바이트도 움직이지 않고 기다립니다.",
      ],
      code: ["relayium send --verify ./release.zip 428571"],
    },
    {
      heading: "직접 연결만 — 무료가 아니면 실패",
      body: [
        "전송은 두 끝 사이의 직접 연결 수립을 경쟁적으로 시도합니다. 연결이 이루어지면——적어도 한쪽에 도달 가능한 주소가 있는 일반적인 경우——파일은 암호화된 채로 곧장 전속력으로, 비용 없이 흐릅니다.",
        "양쪽 모두 엄격한 NAT 뒤에 있어 직접 경로를 찾을 수 없으면, 전송은 파일을 릴레이로 우회시키는 대신 깔끔하게 실패합니다. 이렇게 해야 CLI가 완전히 무료로 유지되고, 파일 바이트가 저희 서버에 닿지 않습니다. 이런 상황이라면 확실한 방법은 도달 가능한 두 서버 사이의 daemon direct나, SSH를 통한 push입니다.",
      ],
      bullets: [
        "직접 연결 성공 → 무료, 전속력, 종단간 암호화.",
        "직접 경로 없음 → 전송 실패; CLI는 결코 대신 파일을 프록시하지 않습니다.",
        "양쪽은 지리적으로 어디에나 있을 수 있습니다——각자 같은 코드로 명령을 실행하기만 하면 됩니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "페어링 코드는 어디서 나오나요?",
        a: "직접 만드는 것입니다. 양쪽이 입력할 수 있는 아무 짧은 문자열이면 됩니다——통화나 채팅으로 정하세요. 양쪽에서 일치하기만 하면 됩니다.",
      },
      {
        q: "파일이 어딘가에 업로드되나요?",
        a: "아니요. 파일은 두 사람 사이에서 직접 스트리밍되며 종단간 암호화됩니다. 두 끝을 서로 소개하기 위한 아주 작은 랑데부 핸드셰이크만 Relayium을 거치며——파일은 절대 거치지 않습니다.",
      },
      {
        q: "연결이 안 되면 어떻게 되나요?",
        a: "양쪽 모두 엄격한 NAT 뒤에 있고 도달 가능한 주소가 없다면 직접 연결을 만들 수 없어 전송이 실패합니다——CLI는 설계상 릴레이 폴백이 없습니다. 직접 경로를 쓸 수 없을 때는 도달 가능한 두 서버 사이의 daemon direct나, SSH를 통한 push를 사용하세요.",
      },
      {
        q: "상대가 정말 맞는 사람인지 어떻게 알 수 있나요?",
        a: "양쪽 터미널이 세션 키에서 나온 동일한 6자리 SAS 코드를 출력합니다. 대역 외로 비교하세요. 일치하면 중간에 아무도 없다는 뜻입니다. 바이트가 움직이기 전에 이 확인을 필수로 하려면 --verify를 추가하세요.",
      },
    ],
  },
  cta: {
    text: "다음 파일을 다른 네트워크에 있는 상대에게 직접 보내세요——종단간 암호화되고 무료입니다.",
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
    "Manchmal ist die andere Maschine nicht deine eigene und du kannst dich nicht per SSH einloggen — eine Datei für eine Kollegin in einem anderen Büro, ein Build für einen Kunden, ein Archiv für einen Freund am anderen Ende des Landes. relayium send und receive bewegen sie über Netzwerke hinweg direkt zwischen euch beiden, nur mit einem kurzen Code, den ihr vereinbart.",
    "Die Verbindung ist Peer-to-Peer und Ende-zu-Ende verschlüsselt. Nur ein winziger Rendezvous-Handshake läuft über Relayium, um die beiden Enden einander vorzustellen; die Dateibytes nie.",
  ],
  sections: [
    {
      heading: "Einen Code vereinbaren, dann send und receive",
      body: [
        "Wählt einen beliebigen kurzen Code und teilt ihn außerhalb des Kanals — sagt ihn am Telefon, schreibt ihn in einen Chat. Eine Seite sendet, die andere empfängt mit demselben Code:",
      ],
      code: [
        `# sender
relayium send ./release.zip 428571

# receiver (in the folder where files should land)
relayium receive 428571`,
      ],
      bullets: [
        "Der Code ist nur ein gemeinsames Geheimnis zum Treffen; er wird an niemanden außer der Rendezvous-Stelle gesendet und stellt nur die beiden Enden einander vor.",
        "Der Empfänger kann ein Zielverzeichnis angeben: relayium receive 428571 ./downloads",
      ],
    },
    {
      heading: "Mit dem SAS-Code verifizieren",
      body: [
        "Sobald sich die beiden Enden verbinden, geben beide Terminals denselben 6-stelligen SAS (Short Authentication String) aus, der aus den Sitzungsschlüsseln abgeleitet ist. Vergleicht ihn — lest ihn beim Telefonat laut vor —, um sicherzugehen, dass ihr miteinander verbunden seid und nicht mit jemandem dazwischen.",
        "Für eine harte Garantie fügt --verify hinzu: Die Übertragung wartet dann, bis ihr bestätigt, dass die Codes übereinstimmen, bevor auch nur ein einziges Byte bewegt wird.",
      ],
      code: ["relayium send --verify ./release.zip 428571"],
    },
    {
      heading: "Nur direkt — kostenlos, sonst schlägt es fehl",
      body: [
        "Die Übertragung versucht, eine direkte Verbindung zwischen den beiden Enden herzustellen. Gelingt das — der übliche Fall, wenn wenigstens eine Seite eine erreichbare Adresse hat —, fließt die Datei verschlüsselt direkt hindurch, mit voller Geschwindigkeit und ohne Kosten.",
        "Stehen beide Enden hinter strengem NAT und lässt sich kein direkter Pfad finden, schlägt die Übertragung sauber fehl, statt deine Datei über ein Relay zu leiten. So bleibt die CLI vollständig kostenlos, und deine Dateibytes bleiben von unseren Servern fern. Falls das passiert, ist die verlässliche Antwort daemon direct zwischen zwei erreichbaren Servern oder push über SSH.",
      ],
      bullets: [
        "Direkte Verbindung gelingt → kostenlos, volle Geschwindigkeit, Ende-zu-Ende verschlüsselt.",
        "Kein direkter Pfad → die Übertragung schlägt fehl; die CLI leitet die Datei niemals stellvertretend für dich weiter.",
        "Beide Enden können geografisch überall sein — sie müssen nur jeweils den Befehl mit demselben Code ausführen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Woher kommt der Pairing-Code?",
        a: "Ihr denkt ihn euch selbst aus. Es ist eine beliebige kurze Zeichenfolge, die beide Seiten eingeben — vereinbart sie am Telefon oder im Chat. Sie muss nur auf beiden Enden übereinstimmen.",
      },
      {
        q: "Wird die Datei irgendwohin hochgeladen?",
        a: "Nein. Die Datei fließt direkt zwischen euch beiden, Ende-zu-Ende verschlüsselt. Nur ein kleiner Rendezvous-Handshake läuft über Relayium, um die Enden einander vorzustellen — die Datei nie.",
      },
      {
        q: "Was, wenn wir keine Verbindung herstellen können?",
        a: "Stehen beide Enden hinter strengem NAT ohne erreichbare Adresse, kann die direkte Verbindung nicht hergestellt werden und die Übertragung schlägt fehl — die CLI hat absichtlich kein Relay-Fallback. Nutzt daemon direct zwischen zwei erreichbaren Servern oder push über SSH, wenn kein direkter Pfad verfügbar ist.",
      },
      {
        q: "Woher weiß ich, dass wirklich die richtige Person am anderen Ende ist?",
        a: "Beide Terminals geben einen identischen 6-stelligen SAS-Code aus den Sitzungsschlüsseln aus. Vergleicht ihn außerhalb des Kanals; stimmt er überein, sitzt niemand dazwischen. Fügt --verify hinzu, um diese Bestätigung zu verlangen, bevor Bytes bewegt werden.",
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
    "Utilisez relayium send et receive pour déplacer un fichier directement entre deux personnes sur des réseaux différents, à l'aide d'un court code de jumelage. Chiffré de bout en bout, vérifié par un code SAS, et gratuit — le fichier va tout droit entre vous, jamais via nos serveurs.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Parfois l'autre machine n'est pas la vôtre et vous ne pouvez pas vous y connecter en SSH — un fichier pour un collègue dans un autre bureau, un build pour un client, une archive pour un ami à l'autre bout du pays. relayium send et receive le déplacent directement entre vous deux à travers les réseaux, en utilisant seulement un court code que vous convenez ensemble.",
    "La connexion est pair-à-pair et chiffrée de bout en bout. Seule une minuscule poignée de main de rendez-vous passe par Relayium pour présenter les deux extrémités ; les octets du fichier, eux, jamais.",
  ],
  sections: [
    {
      heading: "Convenir d'un code, puis send et receive",
      body: [
        "Choisissez un code court, n'importe lequel, et partagez-le hors bande — dites-le au téléphone, glissez-le dans un chat. Un côté fait send, l'autre fait receive avec le même code :",
      ],
      code: [
        `# sender
relayium send ./release.zip 428571

# receiver (in the folder where files should land)
relayium receive 428571`,
      ],
      bullets: [
        "Le code n'est qu'un secret partagé pour se retrouver ; il n'est envoyé à personne d'autre qu'au point de rendez-vous, et il ne sert qu'à présenter les deux extrémités.",
        "Le destinataire peut indiquer un répertoire de destination : relayium receive 428571 ./downloads",
      ],
    },
    {
      heading: "Vérifier avec le code SAS",
      body: [
        "Quand les deux extrémités se connectent, les deux terminaux affichent le même SAS (short authentication string) à 6 chiffres, dérivé des clés de session. Comparez-les — lisez-le à voix haute pendant l'appel — pour être sûrs d'être connectés l'un à l'autre, et non à quelqu'un au milieu.",
        "Pour une garantie ferme, ajoutez --verify : le transfert attend alors que vous confirmiez que les codes correspondent avant qu'un seul octet ne bouge.",
      ],
      code: ["relayium send --verify ./release.zip 428571"],
    },
    {
      heading: "Direct uniquement — gratuit, sinon ça échoue",
      body: [
        "Le transfert tente d'établir en priorité une connexion directe entre les deux extrémités. Quand elle peut être établie — le cas courant dès qu'au moins un côté a une adresse joignable —, le fichier passe tout droit, chiffré, à pleine vitesse et sans frais.",
        "Si les deux extrémités sont derrière un NAT strict et qu'aucun chemin direct n'est trouvé, le transfert échoue proprement plutôt que de faire transiter votre fichier par un relais. Cela garde la CLI entièrement gratuite et garde les octets de votre fichier hors de nos serveurs. Si cela vous arrive, la réponse fiable est le daemon direct entre deux serveurs joignables, ou le push via SSH.",
      ],
      bullets: [
        "Connexion directe réussie → gratuit, pleine vitesse, chiffré de bout en bout.",
        "Aucun chemin direct → le transfert échoue ; la CLI ne fait jamais transiter le fichier à votre place.",
        "Les deux extrémités peuvent être n'importe où géographiquement — il suffit que chacune exécute la commande avec le même code.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "D'où vient le code de jumelage ?",
        a: "Vous l'inventez. C'est n'importe quelle courte chaîne que les deux côtés tapent — convenez-en au téléphone ou dans un chat. Il doit simplement correspondre des deux côtés.",
      },
      {
        q: "Le fichier est-il envoyé quelque part ?",
        a: "Non. Le fichier circule directement entre vous deux, chiffré de bout en bout. Seule une petite poignée de main de rendez-vous passe par Relayium pour présenter les extrémités — jamais le fichier.",
      },
      {
        q: "Que se passe-t-il si nous ne pouvons pas nous connecter ?",
        a: "Si les deux extrémités sont derrière un NAT strict sans adresse joignable, la connexion directe ne peut pas être établie et le transfert échoue — la CLI n'a volontairement aucun repli par relais. Utilisez le daemon direct entre deux serveurs joignables, ou le push via SSH, quand aucun chemin direct n'est disponible.",
      },
      {
        q: "Comment savoir que c'est vraiment la bonne personne en face ?",
        a: "Les deux terminaux affichent un code SAS identique à 6 chiffres issu des clés de session. Comparez-les hors bande ; s'ils correspondent, personne n'est au milieu. Ajoutez --verify pour exiger cette confirmation avant qu'aucun octet ne bouge.",
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

export default {
  slug: "cli/send-a-file-to-someone",
  updated: "2026-07-08",
  langs: { en, zh, ja, ko, de, fr },
};
