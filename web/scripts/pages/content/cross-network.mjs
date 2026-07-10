// web/scripts/pages/content/cross-network.mjs — localized copy for the static
// /<lang>/cross-network landing pages (mode-template.mjs). English is the SPA
// route (/cross-network), so only the five non-English locales are generated
// here — see build-pages.mjs's buildModePages + gen-pages.mjs wiring.
//
// Terminology mirrors src/lib/i18n/*.ts (pairing code / SAS / TURN relay
// wording) for consistency with the app UI.
//
// ── English master (source of truth for translation + accuracy) ──
// title: "Cross-network file transfer — realtime, end-to-end encrypted, peer-to-peer (Relayium)"
// description: "Send files device-to-device across different networks with a
//   6-digit pairing code. Realtime peer-to-peer, end-to-end encrypted; a TURN
//   relay is used only when a direct path is impossible, and it relays
//   ciphertext only."
// hero.h1: "Cross-network transfer, still peer-to-peer"
// hero.pitch: "Two devices on different networks pair with a 6-digit code (or
//   its link/QR). Files stream directly over an encrypted WebRTC channel;
//   only when a direct path is impossible does an encrypted TURN relay carry
//   the ciphertext."
// hero.cta: "Start a transfer"
// how.steps:
//   1. "The sender signs in and mints a 6-digit pairing code (or shares its
//      join link / QR)."
//   2. "The receiver opens the link or enters the code — no account needed to
//      receive."
//   3. "Both sides verify the same 6-digit SAS on screen to rule out a
//      man-in-the-middle."
//   4. "Files stream peer-to-peer, AES-256-GCM per chunk; a TURN relay
//      carries only ciphertext if no direct path exists."
// why.items:
//   - "End-to-end encrypted" / "X25519 key exchange + per-chunk AES-256-GCM;
//     keys are negotiated only between the two devices, so the server can't
//     decrypt."
//   - "SAS anti-MITM" / "Both screens show the same 6-digit code; matching it
//     defeats even a compromised signaling server."
//   - "Direct when possible" / "Files flow device-to-device over WebRTC; the
//     relay is a ciphertext-only fallback for symmetric-NAT cases."
//   - "Cross-platform" / "Windows, macOS, Linux, Android, iOS — any modern
//     browser, nothing to install."
//   - "Free" / "Realtime transfer is free; minting a code needs the sender
//     logged in (for attribution), the receiver joins anonymously."
// compare.items:
//   - "vs AirDrop" / "AirDrop is Apple-only; Relayium pairs Windows, Android,
//     iPhone and Mac across different networks with just a browser."
//   - "vs Snapdrop/PairDrop" / "Those are same-network only; Relayium adds
//     cross-network pairing plus app-layer E2E + SAS so a malicious signaling
//     server can't eavesdrop."
// faq.items:
//   - "Do my files go through your server?" / "In realtime mode, no — files
//     stream peer-to-peer. Only when a direct path is impossible does an
//     encrypted TURN relay carry ciphertext it can't read."
//   - "Is a code required?" / "Yes: a 6-digit code (or its join link/QR),
//     valid 15 minutes, pairs the two devices across networks."
//   - "Do I need an account?" / "The sender signs in to mint a code; the
//     receiver joins anonymously."
//   - "Is it end-to-end encrypted?" / "Yes — X25519 + per-chunk AES-256-GCM,
//     verified with the SAS code."
// learnHeading: "Learn more"
// footer: {privacy, terms, security} — reuse landing.mjs's per-locale labels.

const zh = {
  title: "跨网络文件传输——实时点对点，端到端加密（Relayium）",
  description:
    "用 6 位配对码，让两台设备跨网络直接互传文件。实时点对点、端到端加密；仅当无法直连时才会启用 TURN 中继兜底，且中继只经手密文。",
  hero: {
    h1: "跨网络传输，依然点对点",
    pitch:
      "两台设备身处不同网络，用 6 位配对码（或其加入链接/二维码）完成配对。文件直接通过加密的 WebRTC 通道流动；只有在无法直连时，才由加密 TURN 中继转发密文。",
    cta: "开始传输",
  },
  how: {
    heading: "四步完成一次传输",
    steps: [
      "发送方登录后生成一个 6 位配对码（也可分享其加入链接/二维码）。",
      "接收方打开链接或输入配对码即可——接收无需账号。",
      "双方核对屏幕上同一段 6 位 SAS 校验码，确认一致以排除中间人。",
      "文件点对点流式传输，逐块 AES-256-GCM 加密；若无法直连，则由 TURN 中继仅转发密文。",
    ],
  },
  why: {
    heading: "为什么选择 Relayium",
    items: [
      {
        title: "端到端加密",
        desc: "X25519 密钥交换 + 每块 AES-256-GCM 加密，密钥只在两台设备间协商，服务器无法解密。",
      },
      {
        title: "SAS 防中间人",
        desc: "两边屏幕显示同一段 6 位校验码，核对一致即可排除中间人——即便信令服务器被入侵也无法得逞。",
      },
      {
        title: "能直连就直连",
        desc: "文件通过 WebRTC 在设备间直接流动；仅在对称 NAT 等打洞失败的场景下，才会退回到只转发密文的中继兜底。",
      },
      {
        title: "跨平台",
        desc: "Windows、macOS、Linux、Android、iOS——只要有现代浏览器，无需安装任何 App。",
      },
      {
        title: "免费",
        desc: "实时传输免费；生成配对码需发送方登录（用于归属），接收方可匿名加入。",
      },
    ],
  },
  compare: {
    heading: "与其他方式相比",
    items: [
      {
        title: "对比 AirDrop",
        body: "AirDrop 仅限 Apple 设备之间；Relayium 能让 Windows、Android、iPhone 与 Mac 跨网络配对，只需一个浏览器。",
      },
      {
        title: "对比 Snapdrop / PairDrop",
        body: "它们仅限同一网络；Relayium 在此之上增加了跨网络配对，以及应用层端到端加密 + SAS 校验码，即便信令服务器被恶意控制也无法窃听。",
      },
    ],
  },
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "文件会经过你们的服务器吗？",
        a: "实时模式下不会——文件点对点流式传输。只有当无法直连时，才会由加密 TURN 中继转发密文，中继本身无法解密。",
      },
      {
        q: "一定要用配对码吗？",
        a: "是的：6 位配对码（或其加入链接/二维码）有效期 15 分钟，用于让两台设备跨网络配对。",
      },
      {
        q: "需要注册账号吗？",
        a: "发送方需登录才能生成配对码；接收方可匿名加入。",
      },
      {
        q: "是端到端加密的吗？",
        a: "是——采用 X25519 密钥交换 + 每块 AES-256-GCM 加密，并通过 SAS 校验码核验。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "ネットワークをまたぐファイル転送——リアルタイム・エンドツーエンド暗号化・P2P（Relayium）",
  description:
    "6桁のペアリングコードで、異なるネットワークの2台の端末が直接ファイルをやり取りします。リアルタイムP2P・エンドツーエンド暗号化。直接接続が不可能な場合のみTURNリレーを使い、リレーは暗号文しか扱いません。",
  hero: {
    h1: "ネットワークをまたいでも、やっぱりP2P",
    pitch:
      "異なるネットワーク上の2台の端末が、6桁のコード（またはその参加リンク/QR）でペアリングします。ファイルは暗号化されたWebRTCチャネルを通じて直接流れます。直接接続ができない場合に限り、暗号化されたTURNリレーが暗号文を運びます。",
    cta: "転送を始める",
  },
  how: {
    heading: "4ステップで転送",
    steps: [
      "送信側がサインインし、6桁のペアリングコードを発行します（参加リンク/QRの共有も可能）。",
      "受信側はリンクを開くかコードを入力するだけ——受信にアカウントは不要です。",
      "両方の画面に表示される同じ6桁のSASコードを照合し、中間者がいないことを確認します。",
      "ファイルはP2Pでストリーミング転送され、チャンクごとにAES-256-GCMで暗号化されます。直接接続できない場合のみ、TURNリレーが暗号文だけを運びます。",
    ],
  },
  why: {
    heading: "Relayiumが選ばれる理由",
    items: [
      {
        title: "エンドツーエンド暗号化",
        desc: "X25519鍵交換とチャンクごとのAES-256-GCM。鍵は2台の端末間だけでネゴシエートされ、サーバーは復号できません。",
      },
      {
        title: "SASで中間者攻撃を防止",
        desc: "両方の画面に同じ6桁のコードが表示されます。一致を確認すれば、シグナリングサーバーが侵害されていても中間者攻撃を防げます。",
      },
      {
        title: "可能な限り直接接続",
        desc: "ファイルはWebRTCで端末間を直接流れます。シンメトリックNATなどでホールパンチングに失敗した場合のみ、暗号文だけを運ぶリレーにフォールバックします。",
      },
      {
        title: "クロスプラットフォーム",
        desc: "Windows・macOS・Linux・Android・iOS——モダンブラウザさえあればインストール不要です。",
      },
      {
        title: "無料",
        desc: "リアルタイム転送は無料です。コードの発行には送信側のサインインが必要（帰属のため）で、受信側は匿名のまま参加できます。",
      },
    ],
  },
  compare: {
    heading: "他の方法との比較",
    items: [
      {
        title: "AirDropとの比較",
        body: "AirDropはApple製品同士に限られます。RelayiumはブラウザだけでWindows・Android・iPhone・Macをネットワークをまたいでペアリングできます。",
      },
      {
        title: "Snapdrop / PairDropとの比較",
        body: "それらは同一ネットワーク限定です。Relayiumはネットワークをまたぐペアリングに加え、アプリケーション層のエンドツーエンド暗号化とSASコードを備え、悪意あるシグナリングサーバーでも盗聴できません。",
      },
    ],
  },
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ファイルは御社のサーバーを経由しますか？",
        a: "リアルタイムモードでは経由しません——ファイルはP2Pでストリーミングされます。直接接続が不可能な場合のみ、暗号化されたTURNリレーが復号できない暗号文を運びます。",
      },
      {
        q: "コードは必須ですか？",
        a: "はい。6桁のコード（またはその参加リンク/QR）は15分間有効で、ネットワークをまたぐ2台の端末をペアリングします。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "送信側はコードを発行するためにサインインが必要ですが、受信側は匿名で参加できます。",
      },
      {
        q: "エンドツーエンド暗号化されていますか？",
        a: "はい——X25519鍵交換とチャンクごとのAES-256-GCM暗号化を使い、SASコードで検証します。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "네트워크를 넘는 파일 전송 — 실시간, 종단간 암호화, P2P (Relayium)",
  description:
    "6자리 페어링 코드로 서로 다른 네트워크에 있는 두 기기가 파일을 직접 주고받습니다. 실시간 P2P, 종단간 암호화. 직접 연결이 불가능할 때만 TURN 중계를 사용하며, 중계는 암호문만 전달합니다.",
  hero: {
    h1: "네트워크를 넘어도, 여전히 P2P",
    pitch:
      "서로 다른 네트워크에 있는 두 기기가 6자리 코드(또는 참여 링크/QR)로 페어링합니다. 파일은 암호화된 WebRTC 채널을 통해 직접 흐릅니다. 직접 연결이 불가능할 때만 암호화된 TURN 중계가 암호문을 전달합니다.",
    cta: "전송 시작",
  },
  how: {
    heading: "4단계로 전송",
    steps: [
      "보내는 쪽이 로그인한 뒤 6자리 페어링 코드를 생성합니다(참여 링크/QR 공유도 가능).",
      "받는 쪽은 링크를 열거나 코드를 입력하기만 하면 됩니다 — 받는 데는 계정이 필요 없습니다.",
      "양쪽 화면에 표시되는 동일한 6자리 SAS 코드를 대조해 중간자가 없는지 확인합니다.",
      "파일은 P2P로 스트리밍되며 청크마다 AES-256-GCM으로 암호화됩니다. 직접 연결이 불가능할 때만 TURN 중계가 암호문만 전달합니다.",
    ],
  },
  why: {
    heading: "Relayium을 선택하는 이유",
    items: [
      {
        title: "종단간 암호화",
        desc: "X25519 키 교환과 청크별 AES-256-GCM. 키는 두 기기 사이에서만 협상되어 서버는 복호화할 수 없습니다.",
      },
      {
        title: "SAS로 중간자 공격 차단",
        desc: "양쪽 화면에 동일한 6자리 코드가 표시됩니다. 서로 대조하면 시그널링 서버가 침해되어도 중간자 공격을 막을 수 있습니다.",
      },
      {
        title: "가능하면 직접 연결",
        desc: "파일은 WebRTC를 통해 기기 간에 직접 흐릅니다. 대칭 NAT 등으로 홀 펀칭에 실패한 경우에만 암호문만 전달하는 중계로 전환됩니다.",
      },
      {
        title: "크로스 플랫폼",
        desc: "Windows, macOS, Linux, Android, iOS — 최신 브라우저만 있으면 설치가 필요 없습니다.",
      },
      {
        title: "무료",
        desc: "실시간 전송은 무료입니다. 코드 생성에는 보내는 쪽의 로그인이 필요하며(귀속을 위해), 받는 쪽은 익명으로 참여합니다.",
      },
    ],
  },
  compare: {
    heading: "다른 방식과 비교",
    items: [
      {
        title: "AirDrop과 비교",
        body: "AirDrop은 Apple 기기끼리만 가능합니다. Relayium은 브라우저만으로 Windows, Android, iPhone, Mac을 네트워크를 넘어 페어링합니다.",
      },
      {
        title: "Snapdrop / PairDrop과 비교",
        body: "이들은 같은 네트워크에서만 동작합니다. Relayium은 네트워크를 넘는 페어링에 더해 애플리케이션 계층의 종단간 암호화와 SAS 코드를 갖춰, 악의적인 시그널링 서버도 도청할 수 없습니다.",
      },
    ],
  },
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "파일이 서버를 거치나요?",
        a: "실시간 모드에서는 아닙니다 — 파일은 P2P로 스트리밍됩니다. 직접 연결이 불가능할 때만 암호화된 TURN 중계가 복호화할 수 없는 암호문을 전달합니다.",
      },
      {
        q: "코드가 꼭 필요한가요?",
        a: "네. 6자리 코드(또는 참여 링크/QR)는 15분간 유효하며 네트워크를 넘는 두 기기를 페어링합니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "보내는 쪽은 코드를 생성하려면 로그인해야 하지만, 받는 쪽은 익명으로 참여합니다.",
      },
      {
        q: "종단간 암호화인가요?",
        a: "네 — X25519 키 교환과 청크별 AES-256-GCM 암호화를 사용하며 SAS 코드로 검증합니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Netzwerkübergreifende Dateiübertragung — Echtzeit, Ende-zu-Ende-verschlüsselt, Peer-to-Peer (Relayium)",
  description:
    "Übertrage Dateien mit einem 6-stelligen Kopplungscode direkt zwischen Geräten in unterschiedlichen Netzwerken. Echtzeit-Peer-to-Peer, Ende-zu-Ende-verschlüsselt; ein TURN-Relay kommt nur zum Einsatz, wenn eine direkte Verbindung unmöglich ist, und transportiert ausschließlich Chiffretext.",
  hero: {
    h1: "Netzwerkübergreifend übertragen, trotzdem Peer-to-Peer",
    pitch:
      "Zwei Geräte in unterschiedlichen Netzwerken koppeln sich mit einem 6-stelligen Code (oder dessen Beitrittslink/QR). Dateien fließen direkt über einen verschlüsselten WebRTC-Kanal; nur wenn eine direkte Verbindung unmöglich ist, transportiert ein verschlüsseltes TURN-Relay den Chiffretext.",
    cta: "Übertragung starten",
  },
  how: {
    heading: "In vier Schritten übertragen",
    steps: [
      "Der Absender meldet sich an und erzeugt einen 6-stelligen Kopplungscode (oder teilt dessen Beitrittslink/QR).",
      "Der Empfänger öffnet den Link oder gibt den Code ein — zum Empfangen ist kein Konto nötig.",
      "Beide Seiten vergleichen denselben 6-stelligen SAS-Code auf dem Bildschirm, um einen Mittelsmann auszuschließen.",
      "Dateien werden Peer-to-Peer gestreamt, Chunk für Chunk mit AES-256-GCM verschlüsselt; ist keine direkte Verbindung möglich, transportiert ein TURN-Relay nur den Chiffretext.",
    ],
  },
  why: {
    heading: "Warum Relayium",
    items: [
      {
        title: "Ende-zu-Ende-verschlüsselt",
        desc: "X25519-Schlüsselaustausch und AES-256-GCM pro Chunk; die Schlüssel werden ausschließlich zwischen den beiden Geräten ausgehandelt, der Server kann nicht entschlüsseln.",
      },
      {
        title: "SAS gegen Man-in-the-Middle",
        desc: "Beide Bildschirme zeigen denselben 6-stelligen Code; stimmt er überein, ist ein Mittelsmann ausgeschlossen — selbst ein kompromittierter Signalisierungsserver kann sich nicht einschleichen.",
      },
      {
        title: "Direkt, wenn möglich",
        desc: "Dateien fließen über WebRTC direkt von Gerät zu Gerät; nur wenn das Hole-Punching etwa bei symmetrischem NAT scheitert, springt das Relay als reiner Chiffretext-Fallback ein.",
      },
      {
        title: "Plattformübergreifend",
        desc: "Windows, macOS, Linux, Android, iOS — ein moderner Browser genügt, keine Installation nötig.",
      },
      {
        title: "Kostenlos",
        desc: "Echtzeitübertragung ist kostenlos; für einen Code muss sich der Absender anmelden (zur Zuordnung), der Empfänger tritt anonym bei.",
      },
    ],
  },
  compare: {
    heading: "Im Vergleich",
    items: [
      {
        title: "Gegenüber AirDrop",
        body: "AirDrop funktioniert nur zwischen Apple-Geräten; Relayium koppelt Windows, Android, iPhone und Mac netzwerkübergreifend mit nur einem Browser.",
      },
      {
        title: "Gegenüber Snapdrop / PairDrop",
        body: "Diese funktionieren nur im selben Netzwerk; Relayium ergänzt netzwerkübergreifendes Koppeln plus Ende-zu-Ende-Verschlüsselung auf Anwendungsebene und den SAS-Code, sodass ein böswilliger Signalisierungsserver nicht mithören kann.",
      },
    ],
  },
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Laufen meine Dateien über euren Server?",
        a: "Im Echtzeitmodus nein — Dateien werden Peer-to-Peer gestreamt. Nur wenn eine direkte Verbindung unmöglich ist, transportiert ein verschlüsseltes TURN-Relay Chiffretext, den es nicht lesen kann.",
      },
      {
        q: "Ist ein Code erforderlich?",
        a: "Ja: Ein 6-stelliger Code (oder dessen Beitrittslink/QR), 15 Minuten gültig, koppelt die beiden Geräte über Netzwerke hinweg.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Der Absender meldet sich an, um einen Code zu erzeugen; der Empfänger tritt anonym bei.",
      },
      {
        q: "Ist es Ende-zu-Ende-verschlüsselt?",
        a: "Ja — X25519 plus AES-256-GCM pro Chunk, verifiziert mit dem SAS-Code.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Transfert de fichiers inter-réseaux — temps réel, chiffré de bout en bout, pair-à-pair (Relayium)",
  description:
    "Envoyez des fichiers d'un appareil à l'autre entre réseaux différents avec un code d'appairage à 6 chiffres. Temps réel, pair-à-pair, chiffré de bout en bout ; un relais TURN n'intervient que lorsqu'une connexion directe est impossible, et il ne transporte que du contenu chiffré.",
  hero: {
    h1: "Transfert inter-réseaux, toujours pair-à-pair",
    pitch:
      "Deux appareils sur des réseaux différents s'appairent avec un code à 6 chiffres (ou son lien/QR). Les fichiers circulent directement via un canal WebRTC chiffré ; seulement lorsqu'une connexion directe est impossible, un relais TURN chiffré transporte le contenu chiffré.",
    cta: "Démarrer le transfert",
  },
  how: {
    heading: "Transférer en quatre étapes",
    steps: [
      "L'expéditeur se connecte et génère un code d'appairage à 6 chiffres (ou partage son lien d'accès/QR).",
      "Le destinataire ouvre le lien ou saisit le code — aucun compte n'est nécessaire pour recevoir.",
      "Les deux parties vérifient le même code SAS à 6 chiffres à l'écran pour écarter tout homme du milieu.",
      "Les fichiers circulent en pair-à-pair, chiffrés en AES-256-GCM par bloc ; un relais TURN ne transporte que le contenu chiffré si aucune connexion directe n'existe.",
    ],
  },
  why: {
    heading: "Pourquoi Relayium",
    items: [
      {
        title: "Chiffré de bout en bout",
        desc: "Échange de clés X25519 et AES-256-GCM par bloc ; les clés sont négociées uniquement entre les deux appareils, le serveur ne peut donc pas déchiffrer.",
      },
      {
        title: "SAS contre l'homme du milieu",
        desc: "Les deux écrans affichent le même code à 6 chiffres ; le faire correspondre déjoue même un serveur de signalisation compromis.",
      },
      {
        title: "Direct quand c'est possible",
        desc: "Les fichiers circulent d'appareil à appareil via WebRTC ; le relais n'est qu'un repli chiffré pour les cas de NAT symétrique où le hole-punching échoue.",
      },
      {
        title: "Multiplateforme",
        desc: "Windows, macOS, Linux, Android, iOS — un navigateur moderne suffit, rien à installer.",
      },
      {
        title: "Gratuit",
        desc: "Le transfert en temps réel est gratuit ; générer un code exige que l'expéditeur soit connecté (pour l'attribution), le destinataire rejoint de façon anonyme.",
      },
    ],
  },
  compare: {
    heading: "En comparaison",
    items: [
      {
        title: "Face à AirDrop",
        body: "AirDrop est réservé aux appareils Apple ; Relayium appaire Windows, Android, iPhone et Mac entre réseaux différents avec un simple navigateur.",
      },
      {
        title: "Face à Snapdrop / PairDrop",
        body: "Ceux-ci ne fonctionnent que sur le même réseau ; Relayium ajoute l'appairage inter-réseaux ainsi qu'un chiffrement de bout en bout au niveau applicatif et un code SAS, si bien qu'un serveur de signalisation malveillant ne peut pas espionner.",
      },
    ],
  },
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Mes fichiers passent-ils par votre serveur ?",
        a: "En mode temps réel, non — les fichiers circulent en pair-à-pair. Seulement lorsqu'une connexion directe est impossible, un relais TURN chiffré transporte un contenu chiffré qu'il ne peut pas lire.",
      },
      {
        q: "Un code est-il obligatoire ?",
        a: "Oui : un code à 6 chiffres (ou son lien d'accès/QR), valable 15 minutes, appaire les deux appareils entre réseaux différents.",
      },
      {
        q: "Faut-il un compte ?",
        a: "L'expéditeur se connecte pour générer un code ; le destinataire rejoint de façon anonyme.",
      },
      {
        q: "Est-ce chiffré de bout en bout ?",
        a: "Oui — X25519 et AES-256-GCM par bloc, vérifié avec le code SAS.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

export default {
  updated: "2026-07-10",
  langs: { zh, ja, ko, de, fr },
};
