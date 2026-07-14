// web/scripts/pages/content/cross-network.mjs — localized copy for the static
// /<lang>/cross-network landing pages (mode-template.mjs). English is the SPA
// route (/cross-network), so only the five non-English locales are generated
// here — see build-pages.mjs's buildModePages + gen-pages.mjs wiring.
//
// Terminology mirrors src/lib/i18n/*.ts (pairing code / SAS / relay
// wording) for consistency with the app UI.
//
// ── English master (source of truth for translation + accuracy) ──
// title: "Cross-network file transfer — realtime, end-to-end encrypted | Relayium"
// description: "Send files device-to-device across different networks with a
//   6-digit pairing code. End-to-end encrypted over a fast relay that carries
//   only ciphertext it can't read — verified with a SAS code so even a
//   compromised relay can't eavesdrop."
// hero.h1: "Cross-network file transfer, end-to-end encrypted"
// hero.pitch: "Two devices on different networks pair with a 6-digit code (or
//   its link/QR). Files stream over an encrypted channel through a fast relay
//   that only ever sees ciphertext — your keys never leave the two devices."
// hero.cta: "Start a transfer"
// how.steps:
//   1. "The sender signs in and mints a 6-digit pairing code (or shares its
//      join link / QR)."
//   2. "The receiver opens the link or enters the code — no account needed to
//      receive."
//   3. "Both sides verify the same 6-digit SAS on screen to rule out a
//      man-in-the-middle."
//   4. "Files stream end-to-end encrypted (AES-256-GCM per chunk) through
//      Relayium's fast relay, which carries only ciphertext it can't read."
// why.items:
//   - "End-to-end encrypted" / "X25519 key exchange + per-chunk AES-256-GCM;
//     keys are negotiated only between the two devices, so neither the relay
//     nor the server can decrypt."
//   - "SAS anti-MITM" / "Both screens show the same 6-digit code; matching it
//     defeats even a compromised relay or signaling server."
//   - "Relay sees only ciphertext" / "Cross-network transfers travel through
//     a fast relay for a reliable connection across any NAT — and it only
//     ever carries ciphertext, never your keys or plaintext."
//   - "Cross-platform" / "Windows, macOS, Linux, Android, iOS — any modern
//     browser, nothing to install."
//   - "Free" / "Free to use within a monthly relay allowance; minting a code
//     needs the sender signed in, the receiver joins anonymously."
// compare.items:
//   - "vs AirDrop" / "AirDrop is Apple-only and same-vicinity; Relayium
//     connects Windows, Android, iPhone and Mac across different networks,
//     end-to-end encrypted, with just a browser."
//   - "vs Snapdrop/PairDrop" / "Those are same-network only; Relayium adds
//     cross-network pairing plus app-layer E2E + a SAS code, so even a
//     compromised relay or signaling server can't eavesdrop."
// faq.items:
//   - "Do my files go through a server?" / "The encrypted stream travels
//     through Relayium's relay for a reliable cross-network connection —
//     but it's end-to-end encrypted, so the relay only ever sees ciphertext
//     it can't read."
//   - "Is a code required?" / "Yes: a 6-digit code (or its join link/QR),
//     valid 15 minutes, pairs the two devices across networks."
//   - "Do I need an account?" / "The sender signs in to mint a code; the
//     receiver joins anonymously."
//   - "Is it end-to-end encrypted?" / "Yes — X25519 + per-chunk AES-256-GCM,
//     verified with the SAS code, so neither the relay nor the server can
//     decrypt."
// learnHeading: "Learn more"
// footer: {privacy, terms, security} — reuse landing.mjs's per-locale labels.

const zh = {
  title: "跨网络文件传输——实时、端到端加密 | Relayium",
  description:
    "用 6 位配对码，让两台设备跨网络互传文件。端到端加密：文件经由 Relayium 的快速中继转发，中继只经手无法解密的密文；并以 SAS 校验码验证，即便中继被入侵也无法窃听。",
  hero: {
    h1: "跨网络文件传输，端到端加密",
    pitch:
      "两台设备身处不同网络，用 6 位配对码（或其加入链接/二维码）完成配对。文件通过加密通道流动，途经 Relayium 的快速中继转发——中继只能看到密文，密钥始终只留在两台设备之间。",
    cta: "开始传输",
  },
  how: {
    heading: "四步完成一次传输",
    steps: [
      "发送方登录后生成一个 6 位配对码（也可分享其加入链接/二维码）。",
      "接收方打开链接或输入配对码即可——接收无需账号。",
      "双方核对屏幕上同一段 6 位 SAS 校验码，确认一致以排除中间人。",
      "文件端到端加密流式传输（逐块 AES-256-GCM），经由 Relayium 的快速中继转发；中继只经手它无法解密的密文。",
    ],
  },
  why: {
    heading: "为什么选择 Relayium",
    items: [
      {
        title: "端到端加密",
        desc: "X25519 密钥交换 + 每块 AES-256-GCM 加密，密钥只在两台设备间协商，中继与服务器均无法解密。",
      },
      {
        title: "SAS 防中间人",
        desc: "两边屏幕显示同一段 6 位校验码，核对一致即可排除中间人——即便中继或信令服务器被入侵也无法得逞。",
      },
      {
        title: "中继只经手密文",
        desc: "跨网络传输经由快速中继转发，以在任何 NAT 环境下都能可靠连接——中继只经手密文，从不接触你的密钥或明文。",
      },
      {
        title: "跨平台",
        desc: "Windows、macOS、Linux、Android、iOS——只要有现代浏览器，无需安装任何 App。",
      },
      {
        title: "免费",
        desc: "在每月中继流量额度内免费使用；生成配对码需发送方登录，接收方可匿名加入。",
      },
    ],
  },
  compare: {
    heading: "与其他方式相比",
    items: [
      {
        title: "对比 AirDrop",
        body: "AirDrop 仅限 Apple 设备之间使用，且需彼此靠近；Relayium 能让 Windows、Android、iPhone 与 Mac 跨网络端到端加密互传，只需一个浏览器。",
      },
      {
        title: "对比 Snapdrop / PairDrop",
        body: "它们仅限同一网络内使用；Relayium 在此之上增加了跨网络配对，以及应用层端到端加密 + SAS 校验码，即便中继或信令服务器被入侵也无法窃听。",
      },
    ],
  },
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "文件会经过你们的服务器吗？",
        a: "加密数据流会经由 Relayium 的中继转发，以实现跨网络的可靠连接——但由于端到端加密，中继只能看到它无法解密的密文。",
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
        a: "是——采用 X25519 密钥交换 + 每块 AES-256-GCM 加密，并通过 SAS 校验码核验，中继与服务器均无法解密。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "ネットワークをまたぐファイル転送——リアルタイム・エンドツーエンド暗号化 | Relayium",
  description:
    "6桁のペアリングコードで、異なるネットワークの2台の端末間でファイルを送受信します。エンドツーエンドで暗号化し、Relayiumの高速リレーを経由します——リレーは復号できない暗号文しか扱いません。SASコードで検証するため、リレーが侵害されていても盗聴されません。",
  hero: {
    h1: "ネットワークをまたぐファイル転送、エンドツーエンド暗号化",
    pitch:
      "異なるネットワーク上の2台の端末が、6桁のコード（またはその参加リンク/QR）でペアリングします。ファイルは暗号化されたチャネルを通じて、Relayiumの高速リレーを経由して流れます——リレーが目にするのは暗号文だけで、鍵は常に2台の端末間にとどまります。",
    cta: "転送を始める",
  },
  how: {
    heading: "4ステップで転送",
    steps: [
      "送信側がサインインし、6桁のペアリングコードを発行します（参加リンク/QRの共有も可能）。",
      "受信側はリンクを開くかコードを入力するだけ——受信にアカウントは不要です。",
      "両方の画面に表示される同じ6桁のSASコードを照合し、中間者がいないことを確認します。",
      "ファイルはエンドツーエンドで暗号化され（チャンクごとにAES-256-GCM）、Relayiumの高速リレーを経由してストリーミング転送されます。リレーは復号できない暗号文しか扱いません。",
    ],
  },
  why: {
    heading: "Relayiumが選ばれる理由",
    items: [
      {
        title: "エンドツーエンド暗号化",
        desc: "X25519鍵交換とチャンクごとのAES-256-GCM。鍵は2台の端末間だけでネゴシエートされ、リレーもサーバーも復号できません。",
      },
      {
        title: "SASで中間者攻撃を防止",
        desc: "両方の画面に同じ6桁のコードが表示されます。一致を確認すれば、リレーやシグナリングサーバーが侵害されていても中間者攻撃を防げます。",
      },
      {
        title: "リレーは暗号文しか扱わない",
        desc: "ネットワークをまたぐ転送は、あらゆるNAT環境でも確実に接続できるよう高速リレーを経由します——リレーが扱うのは常に暗号文のみで、鍵や平文に触れることはありません。",
      },
      {
        title: "クロスプラットフォーム",
        desc: "Windows・macOS・Linux・Android・iOS——モダンブラウザさえあればインストール不要です。",
      },
      {
        title: "無料",
        desc: "月々の中継トラフィック枠の範囲内で無料で利用できます。コードの発行には送信側のサインインが必要で、受信側は匿名のまま参加できます。",
      },
    ],
  },
  compare: {
    heading: "他の方法との比較",
    items: [
      {
        title: "AirDropとの比較",
        body: "AirDropはApple製品同士、かつ近接している場合に限られます。RelayiumはブラウザだけでWindows・Android・iPhone・Macをネットワークをまたいでエンドツーエンド暗号化しながらペアリングできます。",
      },
      {
        title: "Snapdrop / PairDropとの比較",
        body: "それらは同一ネットワーク限定です。Relayiumはネットワークをまたぐペアリングに加え、アプリケーション層のエンドツーエンド暗号化とSASコードを備え、リレーやシグナリングサーバーが侵害されていても盗聴できません。",
      },
    ],
  },
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "ファイルは御社のサーバーを経由しますか？",
        a: "暗号化されたデータストリームはRelayiumのリレーを経由し、ネットワークをまたいでも確実に接続できるようにしています——ただしエンドツーエンドで暗号化されているため、リレーが目にするのは復号できない暗号文だけです。",
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
        a: "はい——X25519鍵交換とチャンクごとのAES-256-GCM暗号化を使い、SASコードで検証します。リレーもサーバーも復号できません。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "네트워크를 넘는 파일 전송 — 실시간, 종단간 암호화 | Relayium",
  description:
    "6자리 페어링 코드로 서로 다른 네트워크에 있는 두 기기가 파일을 주고받습니다. 종단간 암호화——파일은 Relayium의 빠른 중계를 거치지만, 중계는 복호화할 수 없는 암호문만 다룹니다. SAS 코드로 검증하므로 중계가 침해되어도 도청할 수 없습니다.",
  hero: {
    h1: "네트워크를 넘는 파일 전송, 종단간 암호화",
    pitch:
      "서로 다른 네트워크에 있는 두 기기가 6자리 코드(또는 참여 링크/QR)로 페어링합니다. 파일은 암호화된 채널을 통해 Relayium의 빠른 중계를 거쳐 전송됩니다——중계는 암호문만 볼 수 있으며, 키는 항상 두 기기 사이에만 머무릅니다.",
    cta: "전송 시작",
  },
  how: {
    heading: "4단계로 전송",
    steps: [
      "보내는 쪽이 로그인한 뒤 6자리 페어링 코드를 생성합니다(참여 링크/QR 공유도 가능).",
      "받는 쪽은 링크를 열거나 코드를 입력하기만 하면 됩니다 — 받는 데는 계정이 필요 없습니다.",
      "양쪽 화면에 표시되는 동일한 6자리 SAS 코드를 대조해 중간자가 없는지 확인합니다.",
      "파일은 종단간 암호화되어(청크마다 AES-256-GCM) Relayium의 빠른 중계를 거쳐 스트리밍됩니다. 중계는 복호화할 수 없는 암호문만 전달합니다.",
    ],
  },
  why: {
    heading: "Relayium을 선택하는 이유",
    items: [
      {
        title: "종단간 암호화",
        desc: "X25519 키 교환과 청크별 AES-256-GCM. 키는 두 기기 사이에서만 협상되어 중계도 서버도 복호화할 수 없습니다.",
      },
      {
        title: "SAS로 중간자 공격 차단",
        desc: "양쪽 화면에 동일한 6자리 코드가 표시됩니다. 서로 대조하면 중계나 시그널링 서버가 침해되어도 중간자 공격을 막을 수 있습니다.",
      },
      {
        title: "중계는 암호문만 전달",
        desc: "네트워크를 넘는 전송은 어떤 NAT 환경에서도 안정적으로 연결되도록 빠른 중계를 거칩니다——중계는 항상 암호문만 다루며, 키나 평문에는 접근하지 않습니다.",
      },
      {
        title: "크로스 플랫폼",
        desc: "Windows, macOS, Linux, Android, iOS — 최신 브라우저만 있으면 설치가 필요 없습니다.",
      },
      {
        title: "무료",
        desc: "월별 중계 트래픽 한도 내에서 무료로 이용할 수 있습니다. 코드 생성에는 보내는 쪽의 로그인이 필요하며, 받는 쪽은 익명으로 참여합니다.",
      },
    ],
  },
  compare: {
    heading: "다른 방식과 비교",
    items: [
      {
        title: "AirDrop과 비교",
        body: "AirDrop은 Apple 기기끼리, 그것도 가까운 거리에서만 가능합니다. Relayium은 브라우저만으로 Windows, Android, iPhone, Mac을 네트워크를 넘어 종단간 암호화로 페어링합니다.",
      },
      {
        title: "Snapdrop / PairDrop과 비교",
        body: "이들은 같은 네트워크에서만 동작합니다. Relayium은 네트워크를 넘는 페어링에 더해 애플리케이션 계층의 종단간 암호화와 SAS 코드를 갖춰, 중계나 시그널링 서버가 침해되어도 도청할 수 없습니다.",
      },
    ],
  },
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "파일이 서버를 거치나요?",
        a: "암호화된 데이터 스트림은 Relayium의 중계를 거쳐 네트워크를 넘는 안정적인 연결을 제공합니다——다만 종단간 암호화되어 있어 중계는 복호화할 수 없는 암호문만 볼 수 있습니다.",
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
        a: "네 — X25519 키 교환과 청크별 AES-256-GCM 암호화를 사용하며 SAS 코드로 검증합니다. 중계도 서버도 복호화할 수 없습니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Netzwerkübergreifende Dateiübertragung — Echtzeit, Ende-zu-Ende-verschlüsselt | Relayium",
  description:
    "Übertrage Dateien mit einem 6-stelligen Kopplungscode zwischen Geräten in unterschiedlichen Netzwerken. Ende-zu-Ende-verschlüsselt — die Übertragung läuft über Relayiums schnelles Relay, das ausschließlich Chiffretext transportiert, den es nicht lesen kann. Verifiziert per SAS-Code, sodass selbst ein kompromittiertes Relay nicht mithören kann.",
  hero: {
    h1: "Netzwerkübergreifende Dateiübertragung, Ende-zu-Ende-verschlüsselt",
    pitch:
      "Zwei Geräte in unterschiedlichen Netzwerken koppeln sich mit einem 6-stelligen Code (oder dessen Beitrittslink/QR). Dateien fließen über einen verschlüsselten Kanal durch Relayiums schnelles Relay — das Relay sieht dabei ausschließlich Chiffretext, die Schlüssel verlassen nie die beiden Geräte.",
    cta: "Übertragung starten",
  },
  how: {
    heading: "In vier Schritten übertragen",
    steps: [
      "Der Absender meldet sich an und erzeugt einen 6-stelligen Kopplungscode (oder teilt dessen Beitrittslink/QR).",
      "Der Empfänger öffnet den Link oder gibt den Code ein — zum Empfangen ist kein Konto nötig.",
      "Beide Seiten vergleichen denselben 6-stelligen SAS-Code auf dem Bildschirm, um einen Mittelsmann auszuschließen.",
      "Dateien werden Ende-zu-Ende-verschlüsselt gestreamt (Chunk für Chunk mit AES-256-GCM) — über Relayiums schnelles Relay, das nur Chiffretext transportiert, den es nicht entschlüsseln kann.",
    ],
  },
  why: {
    heading: "Warum Relayium",
    items: [
      {
        title: "Ende-zu-Ende-verschlüsselt",
        desc: "X25519-Schlüsselaustausch und AES-256-GCM pro Chunk; die Schlüssel werden ausschließlich zwischen den beiden Geräten ausgehandelt, weder das Relay noch der Server können entschlüsseln.",
      },
      {
        title: "SAS gegen Man-in-the-Middle",
        desc: "Beide Bildschirme zeigen denselben 6-stelligen Code; stimmt er überein, ist ein Mittelsmann ausgeschlossen — selbst ein kompromittiertes Relay oder ein kompromittierter Signalisierungsserver kann sich nicht einschleichen.",
      },
      {
        title: "Relay sieht nur Chiffretext",
        desc: "Netzwerkübergreifende Übertragungen laufen über ein schnelles Relay, damit die Verbindung über jedes NAT hinweg zuverlässig zustande kommt — dabei transportiert es ausschließlich Chiffretext, nie deine Schlüssel oder Klartext.",
      },
      {
        title: "Plattformübergreifend",
        desc: "Windows, macOS, Linux, Android, iOS — ein moderner Browser genügt, keine Installation nötig.",
      },
      {
        title: "Kostenlos",
        desc: "Kostenlos nutzbar innerhalb eines monatlichen Relay-Kontingents; für einen Code muss sich der Absender anmelden, der Empfänger tritt anonym bei.",
      },
    ],
  },
  compare: {
    heading: "Im Vergleich",
    items: [
      {
        title: "Gegenüber AirDrop",
        body: "AirDrop funktioniert nur zwischen Apple-Geräten und nur in unmittelbarer Nähe; Relayium koppelt Windows, Android, iPhone und Mac netzwerkübergreifend, Ende-zu-Ende-verschlüsselt, mit nur einem Browser.",
      },
      {
        title: "Gegenüber Snapdrop / PairDrop",
        body: "Diese funktionieren nur im selben Netzwerk; Relayium ergänzt netzwerkübergreifendes Koppeln plus Ende-zu-Ende-Verschlüsselung auf Anwendungsebene und den SAS-Code, sodass selbst ein kompromittiertes Relay oder ein kompromittierter Signalisierungsserver nicht mithören kann.",
      },
    ],
  },
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Laufen meine Dateien über euren Server?",
        a: "Der verschlüsselte Datenstrom läuft über Relayiums Relay, um eine zuverlässige netzwerkübergreifende Verbindung zu ermöglichen — da alles Ende-zu-Ende-verschlüsselt ist, sieht das Relay dabei nur Chiffretext, den es nicht lesen kann.",
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
        a: "Ja — X25519 plus AES-256-GCM pro Chunk, verifiziert mit dem SAS-Code; weder das Relay noch der Server können entschlüsseln.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Transfert de fichiers inter-réseaux — temps réel, chiffré de bout en bout | Relayium",
  description:
    "Envoyez des fichiers d'un appareil à l'autre entre réseaux différents avec un code d'appairage à 6 chiffres. Chiffré de bout en bout — le flux transite par le relais rapide de Relayium, qui ne transporte que du contenu chiffré qu'il ne peut pas lire, vérifié par un code SAS afin que même un relais compromis ne puisse pas espionner.",
  hero: {
    h1: "Transfert de fichiers inter-réseaux, chiffré de bout en bout",
    pitch:
      "Deux appareils sur des réseaux différents s'appairent avec un code à 6 chiffres (ou son lien/QR). Les fichiers circulent via un canal chiffré à travers le relais rapide de Relayium — le relais ne voit jamais que du contenu chiffré, les clés ne quittent jamais les deux appareils.",
    cta: "Démarrer le transfert",
  },
  how: {
    heading: "Transférer en quatre étapes",
    steps: [
      "L'expéditeur se connecte et génère un code d'appairage à 6 chiffres (ou partage son lien d'accès/QR).",
      "Le destinataire ouvre le lien ou saisit le code — aucun compte n'est nécessaire pour recevoir.",
      "Les deux parties vérifient le même code SAS à 6 chiffres à l'écran pour écarter tout homme du milieu.",
      "Les fichiers sont transférés chiffrés de bout en bout (AES-256-GCM par bloc) via le relais rapide de Relayium, qui ne transporte que du contenu chiffré qu'il ne peut pas lire.",
    ],
  },
  why: {
    heading: "Pourquoi Relayium",
    items: [
      {
        title: "Chiffré de bout en bout",
        desc: "Échange de clés X25519 et AES-256-GCM par bloc ; les clés sont négociées uniquement entre les deux appareils, ni le relais ni le serveur ne peuvent donc déchiffrer.",
      },
      {
        title: "SAS contre l'homme du milieu",
        desc: "Les deux écrans affichent le même code à 6 chiffres ; le faire correspondre déjoue même un relais ou un serveur de signalisation compromis.",
      },
      {
        title: "Le relais ne voit que du chiffré",
        desc: "Les transferts inter-réseaux passent par un relais rapide pour garantir une connexion fiable à travers n'importe quel NAT — il ne transporte que du contenu chiffré, jamais vos clés ni du texte en clair.",
      },
      {
        title: "Multiplateforme",
        desc: "Windows, macOS, Linux, Android, iOS — un navigateur moderne suffit, rien à installer.",
      },
      {
        title: "Gratuit",
        desc: "Gratuit dans la limite d'un quota mensuel de trafic relais ; générer un code exige que l'expéditeur soit connecté, le destinataire rejoint de façon anonyme.",
      },
    ],
  },
  compare: {
    heading: "En comparaison",
    items: [
      {
        title: "Face à AirDrop",
        body: "AirDrop est réservé aux appareils Apple et à la proximité immédiate ; Relayium appaire Windows, Android, iPhone et Mac entre réseaux différents, chiffré de bout en bout, avec un simple navigateur.",
      },
      {
        title: "Face à Snapdrop / PairDrop",
        body: "Ceux-ci ne fonctionnent que sur le même réseau ; Relayium ajoute l'appairage inter-réseaux ainsi qu'un chiffrement de bout en bout au niveau applicatif et un code SAS, si bien qu'un relais ou un serveur de signalisation compromis ne peut pas espionner.",
      },
    ],
  },
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Mes fichiers passent-ils par votre serveur ?",
        a: "Le flux chiffré transite par le relais de Relayium pour garantir une connexion inter-réseaux fiable — mais tout est chiffré de bout en bout, donc le relais ne voit jamais que du contenu chiffré qu'il ne peut pas lire.",
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
        a: "Oui — X25519 et AES-256-GCM par bloc, vérifié avec le code SAS ; ni le relais ni le serveur ne peuvent déchiffrer.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

const ar = {
  title: "نقل الملفات عبر الشبكات — فوري، مُشفَّر من الطرف إلى الطرف | Relayium",
  description:
    "أرسل الملفات من جهاز إلى آخر عبر شبكات مختلفة برمز اقتران مكوّن من 6 أرقام. مُشفَّر من الطرف إلى الطرف — يمر التدفق عبر مُرحِّل Relayium السريع الذي لا ينقل سوى نص مُشفَّر لا يستطيع قراءته، ويُتحقق منه برمز SAS بحيث لا يستطيع حتى مُرحِّل مخترَق التنصّت.",
  hero: {
    h1: "نقل الملفات عبر الشبكات، مُشفَّر من الطرف إلى الطرف",
    pitch:
      "يقترن جهازان على شبكتين مختلفتين برمز مكوّن من 6 أرقام (أو رابطه/رمز QR الخاص به). تنتقل الملفات عبر قناة مُشفَّرة خلال مُرحِّل Relayium السريع — لا يرى المُرحِّل سوى نص مُشفَّر، والمفاتيح لا تغادر الجهازين أبدًا.",
    cta: "ابدأ النقل",
  },
  how: {
    heading: "انقل في أربع خطوات",
    steps: [
      "يسجّل المُرسِل الدخول ويولّد رمز اقتران مكوّنًا من 6 أرقام (أو يشارك رابط الانضمام/رمز QR الخاص به).",
      "يفتح المُستقبِل الرابط أو يُدخل الرمز — لا حاجة إلى حساب للاستقبال.",
      "يتحقق الطرفان من رمز SAS نفسه المكوّن من 6 أرقام على الشاشة لاستبعاد أي هجوم وسيط.",
      "تُنقل الملفات مُشفَّرة من الطرف إلى الطرف (AES-256-GCM لكل كتلة) عبر مُرحِّل Relayium السريع الذي لا ينقل سوى نص مُشفَّر لا يستطيع قراءته.",
    ],
  },
  why: {
    heading: "لماذا Relayium",
    items: [
      {
        title: "التشفير من الطرف إلى الطرف",
        desc: "تبادل مفاتيح X25519 وتشفير AES-256-GCM لكل كتلة؛ تُتفاوض المفاتيح بين الجهازين فقط، لذا لا يستطيع المُرحِّل ولا الخادم فك التشفير.",
      },
      {
        title: "SAS ضد هجوم الوسيط",
        desc: "تعرض الشاشتان الرمز نفسه المكوّن من 6 أرقام؛ ومطابقته تُحبط حتى مُرحِّلًا أو خادم إشارة مخترَقًا.",
      },
      {
        title: "المُرحِّل لا يرى سوى نص مُشفَّر",
        desc: "تمر عمليات النقل عبر الشبكات بمُرحِّل سريع لضمان اتصال موثوق عبر أي NAT — وهو لا ينقل سوى نص مُشفَّر، ولا يمسّ أبدًا مفاتيحك أو النص الصريح.",
      },
      {
        title: "متعدد المنصات",
        desc: "Windows وmacOS وLinux وAndroid وiOS — يكفي متصفح حديث، لا شيء للتثبيت.",
      },
      {
        title: "مجاني",
        desc: "مجاني ضمن حصة شهرية من حركة المُرحِّل؛ يتطلب توليد الرمز أن يكون المُرسِل مسجّلًا الدخول، بينما ينضم المُستقبِل بشكل مجهول.",
      },
    ],
  },
  compare: {
    heading: "بالمقارنة",
    items: [
      {
        title: "مقابل AirDrop",
        body: "AirDrop مقتصر على أجهزة Apple وعلى القرب المباشر؛ أما Relayium فيقرن بين Windows وAndroid وiPhone وMac عبر شبكات مختلفة، مُشفَّرًا من الطرف إلى الطرف، بمجرد متصفح.",
      },
      {
        title: "مقابل Snapdrop / PairDrop",
        body: "هذان يعملان على نفس الشبكة فقط؛ يضيف Relayium الاقتران عبر الشبكات إضافةً إلى تشفير من الطرف إلى الطرف على مستوى التطبيق ورمز SAS، بحيث لا يستطيع مُرحِّل أو خادم إشارة مخترَق التنصّت.",
      },
    ],
  },
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل تمر ملفاتي عبر خادمكم؟",
        a: "يمر التدفق المُشفَّر عبر مُرحِّل Relayium لضمان اتصال موثوق عبر الشبكات — لكن كل شيء مُشفَّر من الطرف إلى الطرف، لذا لا يرى المُرحِّل أبدًا سوى نص مُشفَّر لا يستطيع قراءته.",
      },
      {
        q: "هل الرمز إلزامي؟",
        a: "نعم: رمز مكوّن من 6 أرقام (أو رابط الانضمام/رمز QR الخاص به)، صالح لمدة 15 دقيقة، يقرن الجهازين عبر شبكات مختلفة.",
      },
      {
        q: "هل يلزم حساب؟",
        a: "يسجّل المُرسِل الدخول لتوليد رمز؛ بينما ينضم المُستقبِل بشكل مجهول.",
      },
      {
        q: "هل هو مُشفَّر من الطرف إلى الطرف؟",
        a: "نعم — X25519 وAES-256-GCM لكل كتلة، مُتحقَّق منه برمز SAS؛ لا يستطيع المُرحِّل ولا الخادم فك التشفير.",
      },
    ],
  },
  learnHeading: "اعرف المزيد",
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

const es = {
  title: "Transferencia de archivos entre redes — en tiempo real, cifrada de extremo a extremo | Relayium",
  description:
    "Envía archivos de un dispositivo a otro entre redes distintas con un código de emparejamiento de 6 dígitos. Cifrado de extremo a extremo — el flujo pasa por el retransmisor rápido de Relayium, que solo transporta contenido cifrado que no puede leer, verificado con un código SAS para que ni siquiera un retransmisor comprometido pueda espiar.",
  hero: {
    h1: "Transferencia de archivos entre redes, cifrada de extremo a extremo",
    pitch:
      "Dos dispositivos en redes distintas se emparejan con un código de 6 dígitos (o su enlace/QR). Los archivos circulan por un canal cifrado a través del retransmisor rápido de Relayium — el retransmisor solo ve contenido cifrado, y las claves nunca salen de los dos dispositivos.",
    cta: "Iniciar transferencia",
  },
  how: {
    heading: "Transferir en cuatro pasos",
    steps: [
      "El remitente inicia sesión y genera un código de emparejamiento de 6 dígitos (o comparte su enlace de acceso/QR).",
      "El destinatario abre el enlace o introduce el código — no hace falta cuenta para recibir.",
      "Ambas partes verifican en pantalla el mismo código SAS de 6 dígitos para descartar cualquier intermediario.",
      "Los archivos se transfieren cifrados de extremo a extremo (AES-256-GCM por bloque) a través del retransmisor rápido de Relayium, que solo transporta contenido cifrado que no puede leer.",
    ],
  },
  why: {
    heading: "Por qué Relayium",
    items: [
      {
        title: "Cifrado de extremo a extremo",
        desc: "Intercambio de claves X25519 y AES-256-GCM por bloque; las claves se negocian únicamente entre los dos dispositivos, de modo que ni el retransmisor ni el servidor pueden descifrar.",
      },
      {
        title: "SAS contra el ataque de intermediario",
        desc: "Las dos pantallas muestran el mismo código de 6 dígitos; hacerlo coincidir frustra incluso a un retransmisor o un servidor de señalización comprometido.",
      },
      {
        title: "El retransmisor solo ve texto cifrado",
        desc: "Las transferencias entre redes pasan por un retransmisor rápido para garantizar una conexión fiable a través de cualquier NAT — solo transporta contenido cifrado, nunca tus claves ni texto en claro.",
      },
      {
        title: "Multiplataforma",
        desc: "Windows, macOS, Linux, Android, iOS — basta un navegador moderno, nada que instalar.",
      },
      {
        title: "Gratis",
        desc: "Gratis dentro de un cupo mensual de tráfico de retransmisor; generar un código exige que el remitente haya iniciado sesión, el destinatario se une de forma anónima.",
      },
    ],
  },
  compare: {
    heading: "En comparación",
    items: [
      {
        title: "Frente a AirDrop",
        body: "AirDrop se limita a los dispositivos Apple y a la cercanía inmediata; Relayium empareja Windows, Android, iPhone y Mac entre redes distintas, cifrado de extremo a extremo, con un simple navegador.",
      },
      {
        title: "Frente a Snapdrop / PairDrop",
        body: "Estos solo funcionan en la misma red; Relayium añade el emparejamiento entre redes junto con un cifrado de extremo a extremo a nivel de aplicación y un código SAS, de modo que un retransmisor o un servidor de señalización comprometido no puede espiar.",
      },
    ],
  },
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Mis archivos pasan por vuestro servidor?",
        a: "El flujo cifrado pasa por el retransmisor de Relayium para garantizar una conexión fiable entre redes — pero todo está cifrado de extremo a extremo, así que el retransmisor solo ve contenido cifrado que no puede leer.",
      },
      {
        q: "¿Es obligatorio un código?",
        a: "Sí: un código de 6 dígitos (o su enlace de acceso/QR), válido 15 minutos, empareja los dos dispositivos entre redes distintas.",
      },
      {
        q: "¿Necesito una cuenta?",
        a: "El remitente inicia sesión para generar un código; el destinatario se une de forma anónima.",
      },
      {
        q: "¿Es cifrado de extremo a extremo?",
        a: "Sí — X25519 y AES-256-GCM por bloque, verificado con el código SAS; ni el retransmisor ni el servidor pueden descifrar.",
      },
    ],
  },
  learnHeading: "Más información",
  footer: { privacy: "Privacidad", terms: "Términos del servicio", security: "Seguridad" },
};

const pt = {
  title: "Transferência de arquivos entre redes — em tempo real, criptografia de ponta a ponta | Relayium",
  description:
    "Envie arquivos de um dispositivo a outro entre redes diferentes com um código de emparelhamento de 6 dígitos. Criptografia de ponta a ponta — o fluxo passa pelo retransmissor rápido do Relayium, que só transporta conteúdo cifrado que não consegue ler, verificado com um código SAS para que nem mesmo um retransmissor comprometido consiga espionar.",
  hero: {
    h1: "Transferência de arquivos entre redes, criptografia de ponta a ponta",
    pitch:
      "Dois dispositivos em redes diferentes se emparelham com um código de 6 dígitos (ou seu link/QR). Os arquivos circulam por um canal criptografado através do retransmissor rápido do Relayium — o retransmissor só vê conteúdo cifrado, e as chaves nunca saem dos dois dispositivos.",
    cta: "Iniciar transferência",
  },
  how: {
    heading: "Transferir em quatro passos",
    steps: [
      "O remetente faz login e gera um código de emparelhamento de 6 dígitos (ou compartilha seu link de acesso/QR).",
      "O destinatário abre o link ou digita o código — não é preciso conta para receber.",
      "As duas partes verificam na tela o mesmo código SAS de 6 dígitos para descartar qualquer intermediário.",
      "Os arquivos são transferidos com criptografia de ponta a ponta (AES-256-GCM por bloco) através do retransmissor rápido do Relayium, que só transporta conteúdo cifrado que não consegue ler.",
    ],
  },
  why: {
    heading: "Por que o Relayium",
    items: [
      {
        title: "Criptografia de ponta a ponta",
        desc: "Troca de chaves X25519 e AES-256-GCM por bloco; as chaves são negociadas apenas entre os dois dispositivos, de modo que nem o retransmissor nem o servidor conseguem descriptografar.",
      },
      {
        title: "SAS contra o ataque de intermediário",
        desc: "As duas telas mostram o mesmo código de 6 dígitos; fazê-lo coincidir frustra até mesmo um retransmissor ou um servidor de sinalização comprometido.",
      },
      {
        title: "O retransmissor só vê texto cifrado",
        desc: "As transferências entre redes passam por um retransmissor rápido para garantir uma conexão confiável através de qualquer NAT — ele só transporta conteúdo cifrado, nunca suas chaves nem texto em claro.",
      },
      {
        title: "Multiplataforma",
        desc: "Windows, macOS, Linux, Android, iOS — basta um navegador moderno, nada a instalar.",
      },
      {
        title: "Gratuito",
        desc: "Gratuito dentro de uma cota mensal de tráfego de retransmissor; gerar um código exige que o remetente esteja com login feito, o destinatário entra de forma anônima.",
      },
    ],
  },
  compare: {
    heading: "Em comparação",
    items: [
      {
        title: "Comparado ao AirDrop",
        body: "O AirDrop se restringe aos dispositivos Apple e à proximidade imediata; o Relayium emparelha Windows, Android, iPhone e Mac entre redes diferentes, com criptografia de ponta a ponta, usando apenas um navegador.",
      },
      {
        title: "Comparado ao Snapdrop / PairDrop",
        body: "Esses só funcionam na mesma rede; o Relayium acrescenta o emparelhamento entre redes, além de uma criptografia de ponta a ponta na camada de aplicação e um código SAS, de modo que um retransmissor ou um servidor de sinalização comprometido não consegue espionar.",
      },
    ],
  },
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Meus arquivos passam pelo servidor de vocês?",
        a: "O fluxo criptografado passa pelo retransmissor do Relayium para garantir uma conexão confiável entre redes — mas tudo é criptografado de ponta a ponta, então o retransmissor só vê conteúdo cifrado que não consegue ler.",
      },
      {
        q: "Um código é obrigatório?",
        a: "Sim: um código de 6 dígitos (ou seu link de acesso/QR), válido por 15 minutos, empareja os dois dispositivos entre redes diferentes.",
      },
      {
        q: "Preciso de uma conta?",
        a: "O remetente faz login para gerar um código; o destinatário entra de forma anônima.",
      },
      {
        q: "É criptografia de ponta a ponta?",
        a: "Sim — X25519 e AES-256-GCM por bloco, verificado com o código SAS; nem o retransmissor nem o servidor conseguem descriptografar.",
      },
    ],
  },
  learnHeading: "Saiba mais",
  footer: { privacy: "Privacidade", terms: "Termos de Serviço", security: "Segurança" },
};

export default {
  updated: "2026-07-10",
  langs: { zh, ja, ko, de, fr, ar, es, pt },
};
