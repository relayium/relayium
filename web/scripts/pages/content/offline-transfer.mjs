// web/scripts/pages/content/offline-transfer.mjs — localized copy for the static
// /<lang>/offline-transfer landing pages (mode-template.mjs). English is the SPA
// route (/offline-transfer), so only the five non-English locales are generated
// here — see build-pages.mjs's buildModePages + gen-pages.mjs wiring.
//
// This is the async, zero-knowledge stored-transfer / download-link mode:
// the browser encrypts a file before upload; the server stores only the
// ciphertext + an opaque encrypted manifest, never the key. The key lives in
// the download link's URL fragment (after #), which browsers never send to a
// server. Uploading requires the sender to be signed in (it consumes storage
// quota); downloading needs no account, just the link. Optional
// burn-after-read (single claimed download, then the blob+row are deleted)
// and a chosen expiry/TTL. Verified against server/internal/account/files.go
// (RequireSession on POST /api/files; GET meta/blob are public; BurnAfterRead
// + ExpiresAt fields) and web/src/lib/store-crypto.ts (client-side
// AES-256-GCM encryption before upload) + web/src/lib/stored-file.ts (link
// shape `/d/<id>#k=<key>`).
//
// Terminology mirrors src/lib/i18n/*.ts's `stored` section (download link /
// burn-after-read / TTL / zero-knowledge wording) for consistency with the
// app UI, and articles/howto-share-file-expiring-link.mjs for tone.
//
// ── English master (source of truth for translation + accuracy) ──
// title: "Encrypted file link — upload now, download later, zero-knowledge (Relayium)"
// description: "Upload a file encrypted in your browser and share a download
//   link. The server stores only ciphertext it can't decrypt — the key lives
//   in the link. Optional burn-after-read and expiry."
// hero.h1: "Send a file as an encrypted link"
// hero.pitch: "When the other side isn't online, upload now and share a link.
//   Your browser encrypts before upload; the server keeps only ciphertext it
//   can't read — the key never leaves the link."
// hero.cta: "Upload a file"
// how.steps:
//   1. "Sign in and pick a file — your browser encrypts it locally before
//      anything leaves the device."
//   2. "The server stores only the ciphertext; the decryption key stays in
//      the link fragment and is never sent to the server."
//   3. "Share the download link (optionally burn-after-read, with an expiry
//      you choose)."
//   4. "The recipient opens the link; their browser fetches the ciphertext
//      and decrypts it with the key from the link."
// why.items:
//   - "Zero-knowledge" / "The file is encrypted in the browser; the server
//     only ever holds ciphertext it cannot decrypt."
//   - "Key in the link" / "The decryption key lives in the URL fragment
//     (after #), which browsers never send to the server."
//   - "Burn-after-read + expiry" / "Optionally delete the file on first
//     download, and set a time-to-live after which it's gone."
//   - "No recipient account" / "Anyone with the link can download; only the
//     uploader needs to sign in."
//   - "Async complement" / "Use this when the other side isn't online right
//     now; use realtime cross-network transfer when both are present."
// compare.items:
//   - "vs WeTransfer/Dropbox links" / "Those can read your files server-side;
//     Relayium's server only holds ciphertext it can't decrypt — the key
//     stays in the link."
//   - "vs realtime mode" / "Realtime is peer-to-peer and needs both sides
//     online; this stores encrypted so the recipient can fetch later."
// faq.items:
//   - "Can the server read my file?" / "No — it's encrypted in your browser;
//     the server stores only ciphertext and the key never reaches it."
//   - "Where is the key?" / "In the link's fragment (after #). Browsers
//     don't send fragments to servers, so only someone with the full link
//     can decrypt."
//   - "Do I need an account?" / "To upload, yes (it uses storage). To
//     download, no — just the link."
//   - "Can I make it one-time?" / "Yes — enable burn-after-read, and set an
//     expiry."
// learnHeading: "Learn more"
// footer: {privacy, terms, security} — reuse landing.mjs's per-locale labels.

const zh = {
  title: "加密文件链接——先上传，后下载，零知识（Relayium）",
  description:
    "在浏览器里加密后上传文件，分享一个下载链接。服务器只保存它无法解密的密文——密钥就在链接里。可选阅后即焚与有效期。",
  hero: {
    h1: "把文件变成一个加密链接发出去",
    pitch:
      "当对方不在线时，先上传，再分享一个链接。你的浏览器会在上传前加密文件；服务器只保存它无法读取的密文——密钥始终只存在于链接里。",
    cta: "上传文件",
  },
  how: {
    heading: "四步完成一次传输",
    steps: [
      "登录后选择一个文件——你的浏览器会在文件离开设备前于本地完成加密。",
      "服务器只保存密文；解密密钥保留在链接片段中，绝不会发送给服务器。",
      "分享这个下载链接（可选阅后即焚，以及你设定的有效期）。",
      "接收方打开链接后，其浏览器会获取密文，并用链接中的密钥解密。",
    ],
  },
  why: {
    heading: "为什么选择 Relayium",
    items: [
      {
        title: "零知识",
        desc: "文件在浏览器里完成加密；服务器只经手它无法解密的密文。",
      },
      {
        title: "密钥就在链接里",
        desc: "解密密钥存放在 URL 片段（# 之后），浏览器绝不会把它发送给服务器。",
      },
      {
        title: "阅后即焚 + 有效期",
        desc: "可选择在首次下载后删除文件，也可设置有效期，到期后文件即消失。",
      },
      {
        title: "接收方无需账号",
        desc: "任何拿到链接的人都能下载；只有上传方需要登录。",
      },
      {
        title: "异步场景的补充",
        desc: "当对方暂时不在线时使用；若双方同时在线，可改用实时跨网络传输。",
      },
      {
        title: "也能用命令行",
        desc: "在终端里，relayium up 会上传并打印同一个链接，relayium down 在另一台机器上取回——CLI 与网页端共用同一条链接。",
      },
    ],
  },
  learnHeading: "延伸阅读",
  compare: {
    heading: "与其他方式相比",
    items: [
      {
        title: "对比 WeTransfer / Dropbox 链接",
        body: "那些服务能在服务器端读取你的文件；Relayium 的服务器只保存它无法解密的密文——密钥始终留在链接里。",
      },
      {
        title: "对比实时模式",
        body: "实时模式点对点直连，需要双方同时在线；这种模式则加密存储，方便接收方之后再取。",
      },
    ],
  },
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "服务器能读到我的文件吗？",
        a: "不能——文件在你的浏览器里完成加密；服务器只保存密文，密钥永远不会到达服务器。",
      },
      {
        q: "密钥在哪里？",
        a: "在链接的片段里（# 之后）。浏览器不会把片段发送给服务器，因此只有拿到完整链接的人才能解密。",
      },
      {
        q: "需要账号吗？",
        a: "上传需要（会占用存储空间）。下载不需要——只要有链接即可。",
      },
      {
        q: "能设置成只能下载一次吗？",
        a: "可以——开启阅后即焚，并设置有效期。",
      },
    ],
  },
  learnHeading: "深入了解",
  footer: { privacy: "隐私政策", terms: "服务条款", security: "安全说明" },
};

const ja = {
  title: "暗号化ファイルリンク——今すぐアップロード、後でダウンロード、ゼロ知識（Relayium）",
  description:
    "ブラウザで暗号化してからファイルをアップロードし、ダウンロードリンクを共有します。サーバーは復号できない暗号文だけを保存します——鍵はリンクの中にあります。閲覧後に削除と有効期限も選べます。",
  hero: {
    h1: "ファイルを暗号化リンクとして送る",
    pitch:
      "相手がオンラインでないときは、今すぐアップロードしてリンクを共有しましょう。ブラウザはアップロード前に暗号化します。サーバーは復号できない暗号文だけを保持します——鍵はリンクから出ることはありません。",
    cta: "ファイルをアップロード",
  },
  how: {
    heading: "4ステップで転送",
    steps: [
      "サインインしてファイルを選びます——ブラウザが端末を離れる前にローカルで暗号化します。",
      "サーバーは暗号文だけを保存します。復号鍵はリンクのフラグメントにとどまり、サーバーに送信されることはありません。",
      "ダウンロードリンクを共有します（任意で閲覧後に削除、選んだ有効期限も設定できます）。",
      "受信者がリンクを開くと、ブラウザが暗号文を取得し、リンク内の鍵で復号します。",
    ],
  },
  why: {
    heading: "Relayiumが選ばれる理由",
    items: [
      {
        title: "ゼロ知識",
        desc: "ファイルはブラウザ内で暗号化されます。サーバーが持つのは復号できない暗号文だけです。",
      },
      {
        title: "鍵はリンクの中に",
        desc: "復号鍵はURLフラグメント（#の後）に存在し、ブラウザはそれを決してサーバーへ送信しません。",
      },
      {
        title: "閲覧後に削除 + 有効期限",
        desc: "任意で初回ダウンロード後にファイルを削除でき、有効期限を設定すればその後は消えます。",
      },
      {
        title: "受信側にアカウント不要",
        desc: "リンクを持つ誰でもダウンロードできます。サインインが必要なのはアップロードする側だけです。",
      },
      {
        title: "非同期モードとしての補完",
        desc: "相手が今オンラインでないときに使います。双方がオンラインならリアルタイムのクロスネットワーク転送を使ってください。",
      },
      {
        title: "コマンドラインからも",
        desc: "ターミナルでは relayium up が同じリンクを表示してアップロードし、relayium down が別のマシンで取得します——CLI とウェブは同じリンクを共有します。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  compare: {
    heading: "他の方法との比較",
    items: [
      {
        title: "WeTransfer / Dropboxのリンクとの比較",
        body: "それらはサーバー側でファイルを読むことができます。Relayiumのサーバーは復号できない暗号文だけを保持します——鍵は常にリンクの中にあります。",
      },
      {
        title: "リアルタイムモードとの比較",
        body: "リアルタイムモードはピアツーピアで双方のオンラインが必要です。こちらは暗号化して保存するため、受信者は後から取得できます。",
      },
    ],
  },
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "サーバーは私のファイルを読めますか？",
        a: "いいえ——ファイルはブラウザ内で暗号化されます。サーバーは暗号文だけを保存し、鍵がサーバーに届くことはありません。",
      },
      {
        q: "鍵はどこにありますか？",
        a: "リンクのフラグメント（#の後）にあります。ブラウザはフラグメントをサーバーに送信しないため、完全なリンクを持つ人だけが復号できます。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "アップロードには必要です（ストレージを使用するため）。ダウンロードには不要——リンクさえあれば十分です。",
      },
      {
        q: "一度きりのダウンロードにできますか？",
        a: "できます——閲覧後に削除を有効にし、有効期限も設定してください。",
      },
    ],
  },
  learnHeading: "さらに詳しく",
  footer: { privacy: "プライバシーポリシー", terms: "利用規約", security: "セキュリティ" },
};

const ko = {
  title: "암호화된 파일 링크 — 지금 업로드, 나중에 다운로드, 영지식(Relayium)",
  description:
    "브라우저에서 파일을 암호화한 뒤 업로드하고 다운로드 링크를 공유하세요. 서버는 복호화할 수 없는 암호문만 저장합니다 — 키는 링크 안에 있습니다. 열람 후 삭제와 유효 기간도 선택할 수 있습니다.",
  hero: {
    h1: "파일을 암호화된 링크로 보내기",
    pitch:
      "상대가 온라인이 아닐 때는 지금 업로드하고 링크를 공유하세요. 브라우저가 업로드 전에 암호화합니다. 서버는 복호화할 수 없는 암호문만 보관합니다 — 키는 링크를 벗어나지 않습니다.",
    cta: "파일 업로드",
  },
  how: {
    heading: "4단계로 전송",
    steps: [
      "로그인 후 파일을 선택하세요 — 브라우저가 기기를 벗어나기 전에 로컬에서 암호화합니다.",
      "서버는 암호문만 저장합니다. 복호화 키는 링크 프래그먼트에 남아 있으며 서버로 전송되지 않습니다.",
      "다운로드 링크를 공유하세요(선택적으로 열람 후 삭제, 직접 정한 유효 기간).",
      "받는 사람이 링크를 열면 브라우저가 암호문을 가져와 링크 속 키로 복호화합니다.",
    ],
  },
  why: {
    heading: "Relayium을 선택하는 이유",
    items: [
      {
        title: "영지식",
        desc: "파일은 브라우저에서 암호화됩니다. 서버가 가지는 것은 복호화할 수 없는 암호문뿐입니다.",
      },
      {
        title: "키는 링크 안에",
        desc: "복호화 키는 URL 프래그먼트(# 뒤)에 있으며, 브라우저는 이를 서버로 전송하지 않습니다.",
      },
      {
        title: "열람 후 삭제 + 유효 기간",
        desc: "선택적으로 첫 다운로드 후 파일을 삭제하거나, 유효 기간을 설정해 그 이후 사라지게 할 수 있습니다.",
      },
      {
        title: "받는 쪽 계정 불필요",
        desc: "링크를 가진 사람은 누구나 다운로드할 수 있습니다. 로그인이 필요한 쪽은 업로드하는 사람뿐입니다.",
      },
      {
        title: "비동기 보완 수단",
        desc: "상대가 지금 온라인이 아닐 때 사용하세요. 양쪽이 모두 온라인이면 실시간 크로스 네트워크 전송을 사용하세요.",
      },
      {
        title: "명령줄에서도",
        desc: "터미널에서 relayium up 이 같은 링크를 출력하며 업로드하고, relayium down 이 다른 기기에서 받습니다 — CLI 와 웹이 같은 링크를 공유합니다.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  compare: {
    heading: "다른 방식과 비교",
    items: [
      {
        title: "WeTransfer / Dropbox 링크와 비교",
        body: "이들은 서버 측에서 파일을 읽을 수 있습니다. Relayium의 서버는 복호화할 수 없는 암호문만 보관합니다 — 키는 항상 링크 안에 있습니다.",
      },
      {
        title: "실시간 모드와 비교",
        body: "실시간 모드는 P2P 방식이라 양쪽이 모두 온라인이어야 합니다. 이 모드는 암호화해 저장하므로 받는 사람이 나중에 가져갈 수 있습니다.",
      },
    ],
  },
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "서버가 제 파일을 읽을 수 있나요?",
        a: "아니요 — 파일은 브라우저에서 암호화됩니다. 서버는 암호문만 저장하며, 키는 서버에 전혀 도달하지 않습니다.",
      },
      {
        q: "키는 어디에 있나요?",
        a: "링크의 프래그먼트(# 뒤)에 있습니다. 브라우저는 프래그먼트를 서버로 보내지 않으므로, 전체 링크를 가진 사람만 복호화할 수 있습니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "업로드에는 필요합니다(저장 공간을 사용하므로). 다운로드에는 필요 없습니다 — 링크만 있으면 됩니다.",
      },
      {
        q: "한 번만 다운로드되게 할 수 있나요?",
        a: "가능합니다 — 열람 후 삭제를 켜고 유효 기간을 설정하세요.",
      },
    ],
  },
  learnHeading: "더 알아보기",
  footer: { privacy: "개인정보 처리방침", terms: "이용약관", security: "보안" },
};

const de = {
  title: "Verschlüsselter Datei-Link — jetzt hochladen, später herunterladen, Zero-Knowledge (Relayium)",
  description:
    "Lade eine im Browser verschlüsselte Datei hoch und teile einen Download-Link. Der Server speichert nur Chiffretext, den er nicht entschlüsseln kann — der Schlüssel steckt im Link. Optional mit Löschung nach dem ersten Download und Ablauf.",
  hero: {
    h1: "Eine Datei als verschlüsselten Link senden",
    pitch:
      "Wenn die andere Seite nicht online ist: jetzt hochladen und einen Link teilen. Dein Browser verschlüsselt vor dem Upload; der Server behält nur Chiffretext, den er nicht lesen kann — der Schlüssel verlässt nie den Link.",
    cta: "Datei hochladen",
  },
  how: {
    heading: "In vier Schritten übertragen",
    steps: [
      "Melde dich an und wähle eine Datei — dein Browser verschlüsselt sie lokal, bevor irgendetwas das Gerät verlässt.",
      "Der Server speichert nur den Chiffretext; der Entschlüsselungsschlüssel bleibt im Link-Fragment und wird nie an den Server gesendet.",
      "Teile den Download-Link (optional mit Löschung nach dem ersten Download und einer selbst gewählten Ablaufzeit).",
      "Die empfangende Person öffnet den Link; ihr Browser lädt den Chiffretext und entschlüsselt ihn mit dem Schlüssel aus dem Link.",
    ],
  },
  why: {
    heading: "Warum Relayium",
    items: [
      {
        title: "Zero-Knowledge",
        desc: "Die Datei wird im Browser verschlüsselt; der Server hält immer nur Chiffretext, den er nicht entschlüsseln kann.",
      },
      {
        title: "Schlüssel im Link",
        desc: "Der Entschlüsselungsschlüssel steckt im URL-Fragment (nach dem #), das Browser nie an den Server senden.",
      },
      {
        title: "Löschung nach dem ersten Download + Ablauf",
        desc: "Optional die Datei nach dem ersten Download löschen und eine Lebensdauer festlegen, nach der sie verschwindet.",
      },
      {
        title: "Kein Konto für den Empfänger",
        desc: "Jeder mit dem Link kann herunterladen; nur wer hochlädt, muss sich anmelden.",
      },
      {
        title: "Ergänzung für asynchrone Fälle",
        desc: "Nutze dies, wenn die andere Seite gerade nicht online ist; für Echtzeit-Transfers über Netzwerke hinweg, wenn beide Seiten da sind.",
      },
      {
        title: "Auch vom Terminal",
        desc: "Im Terminal lädt relayium up hoch und gibt denselben Link aus, relayium down holt ihn auf einem anderen Rechner ab — CLI und Web teilen sich einen Link.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  compare: {
    heading: "Im Vergleich",
    items: [
      {
        title: "Gegenüber WeTransfer-/Dropbox-Links",
        body: "Diese können deine Dateien serverseitig lesen; Relayiums Server hält nur Chiffretext, den er nicht entschlüsseln kann — der Schlüssel bleibt im Link.",
      },
      {
        title: "Gegenüber dem Echtzeitmodus",
        body: "Echtzeit ist Peer-to-Peer und braucht beide Seiten online; dieser Modus speichert verschlüsselt, damit die empfangende Person später abrufen kann.",
      },
    ],
  },
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kann der Server meine Datei lesen?",
        a: "Nein — sie wird in deinem Browser verschlüsselt; der Server speichert nur Chiffretext, und der Schlüssel erreicht ihn nie.",
      },
      {
        q: "Wo ist der Schlüssel?",
        a: "Im Fragment des Links (nach dem #). Browser senden Fragmente nie an Server, sodass nur jemand mit dem vollständigen Link entschlüsseln kann.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Zum Hochladen ja (es nutzt Speicherplatz). Zum Herunterladen nein — nur der Link genügt.",
      },
      {
        q: "Kann ich es einmalig machen?",
        a: "Ja — aktiviere Löschung nach dem ersten Download und setze eine Ablaufzeit.",
      },
    ],
  },
  learnHeading: "Mehr erfahren",
  footer: { privacy: "Datenschutz", terms: "Nutzungsbedingungen", security: "Sicherheit" },
};

const fr = {
  title: "Lien de fichier chiffré — téléverser maintenant, télécharger plus tard, à divulgation nulle (Relayium)",
  description:
    "Téléversez un fichier chiffré dans votre navigateur et partagez un lien de téléchargement. Le serveur ne stocke que du contenu chiffré qu'il ne peut pas déchiffrer — la clé se trouve dans le lien. Autodestruction après lecture et expiration en option.",
  hero: {
    h1: "Envoyer un fichier sous forme de lien chiffré",
    pitch:
      "Quand l'autre personne n'est pas en ligne, téléversez maintenant et partagez un lien. Votre navigateur chiffre avant l'envoi ; le serveur ne conserve que du contenu chiffré qu'il ne peut pas lire — la clé ne quitte jamais le lien.",
    cta: "Téléverser un fichier",
  },
  how: {
    heading: "Transférer en quatre étapes",
    steps: [
      "Connectez-vous et choisissez un fichier — votre navigateur le chiffre localement avant que quoi que ce soit ne quitte l'appareil.",
      "Le serveur ne stocke que le contenu chiffré ; la clé de déchiffrement reste dans le fragment du lien et n'est jamais envoyée au serveur.",
      "Partagez le lien de téléchargement (avec, en option, l'autodestruction après lecture et une expiration de votre choix).",
      "Le destinataire ouvre le lien ; son navigateur récupère le contenu chiffré et le déchiffre avec la clé du lien.",
    ],
  },
  why: {
    heading: "Pourquoi Relayium",
    items: [
      {
        title: "À divulgation nulle",
        desc: "Le fichier est chiffré dans le navigateur ; le serveur ne détient jamais que du contenu chiffré qu'il ne peut pas déchiffrer.",
      },
      {
        title: "La clé est dans le lien",
        desc: "La clé de déchiffrement se trouve dans le fragment de l'URL (après #), que les navigateurs n'envoient jamais au serveur.",
      },
      {
        title: "Autodestruction après lecture + expiration",
        desc: "Supprimez éventuellement le fichier dès le premier téléchargement, et fixez une durée de vie après laquelle il disparaît.",
      },
      {
        title: "Aucun compte pour le destinataire",
        desc: "Quiconque possède le lien peut télécharger ; seule la personne qui téléverse doit se connecter.",
      },
      {
        title: "Complément asynchrone",
        desc: "Utilisez ceci quand l'autre personne n'est pas en ligne pour l'instant ; utilisez le transfert inter-réseaux en temps réel quand les deux sont présentes.",
      },
      {
        title: "Aussi depuis le terminal",
        desc: "Dans le terminal, relayium up téléverse et affiche le même lien, relayium down le récupère sur une autre machine — la CLI et le web partagent un seul lien.",
      },
    ],
  },
  learnHeading: "Pour aller plus loin",
  compare: {
    heading: "En comparaison",
    items: [
      {
        title: "Face aux liens WeTransfer/Dropbox",
        body: "Ceux-ci peuvent lire vos fichiers côté serveur ; le serveur de Relayium ne détient que du contenu chiffré qu'il ne peut pas déchiffrer — la clé reste dans le lien.",
      },
      {
        title: "Face au mode temps réel",
        body: "Le temps réel est pair-à-pair et exige que les deux parties soient en ligne ; ce mode stocke le fichier chiffré pour que le destinataire puisse le récupérer plus tard.",
      },
    ],
  },
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Le serveur peut-il lire mon fichier ?",
        a: "Non — il est chiffré dans votre navigateur ; le serveur ne stocke que du contenu chiffré, et la clé ne l'atteint jamais.",
      },
      {
        q: "Où se trouve la clé ?",
        a: "Dans le fragment du lien (après #). Les navigateurs n'envoient pas les fragments aux serveurs, donc seule une personne disposant du lien complet peut déchiffrer.",
      },
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Pour téléverser, oui (cela utilise du stockage). Pour télécharger, non — il suffit du lien.",
      },
      {
        q: "Puis-je le rendre à usage unique ?",
        a: "Oui — activez l'autodestruction après lecture et définissez une expiration.",
      },
    ],
  },
  learnHeading: "En savoir plus",
  footer: { privacy: "Confidentialité", terms: "Conditions d'utilisation", security: "Sécurité" },
};

const ar = {
  title: "رابط ملف مُشفَّر — ارفع الآن، نزّل لاحقًا، بمعرفة صفرية (Relayium)",
  description:
    "ارفع ملفًا مُشفَّرًا في متصفحك وشارِك رابط تنزيل. لا يخزّن الخادم سوى نص مُشفَّر لا يستطيع فك تشفيره — والمفتاح موجود في الرابط. الحذف بعد القراءة ومدة الصلاحية اختياريان.",
  hero: {
    h1: "أرسل ملفًا على هيئة رابط مُشفَّر",
    pitch:
      "عندما لا يكون الطرف الآخر متصلًا، ارفع الآن وشارِك رابطًا. يشفّر متصفحك قبل الإرسال؛ ولا يحتفظ الخادم إلا بنص مُشفَّر لا يستطيع قراءته — والمفتاح لا يغادر الرابط أبدًا.",
    cta: "ارفع ملفًا",
  },
  how: {
    heading: "انقل في أربع خطوات",
    steps: [
      "سجّل الدخول واختر ملفًا — يشفّره متصفحك محليًا قبل أن يغادر أي شيء الجهاز.",
      "لا يخزّن الخادم سوى النص المُشفَّر؛ ويبقى مفتاح فك التشفير في جزء الرابط ولا يُرسَل أبدًا إلى الخادم.",
      "شارِك رابط التنزيل (مع خيار الحذف بعد القراءة ومدة صلاحية تختارها).",
      "يفتح المُستقبِل الرابط؛ فيجلب متصفحه النص المُشفَّر ويفك تشفيره بالمفتاح الموجود في الرابط.",
    ],
  },
  why: {
    heading: "لماذا Relayium",
    items: [
      {
        title: "بمعرفة صفرية",
        desc: "يُشفَّر الملف في المتصفح؛ ولا يحتفظ الخادم أبدًا إلا بنص مُشفَّر لا يستطيع فك تشفيره.",
      },
      {
        title: "المفتاح في الرابط",
        desc: "يوجد مفتاح فك التشفير في جزء الـ URL (بعد #)، وهو ما لا ترسله المتصفحات أبدًا إلى الخادم.",
      },
      {
        title: "الحذف بعد القراءة + مدة الصلاحية",
        desc: "احذف الملف إن شئت عند أول تنزيل، وحدّد مدة صلاحية يختفي بعدها.",
      },
      {
        title: "لا حساب للمُستقبِل",
        desc: "يمكن لأي شخص لديه الرابط التنزيل؛ ووحده مَن يرفع يحتاج إلى تسجيل الدخول.",
      },
      {
        title: "مكمّل غير متزامن",
        desc: "استخدم هذا عندما لا يكون الطرف الآخر متصلًا الآن؛ واستخدم النقل الفوري عبر الشبكات عندما يكون كلاهما حاضرًا.",
      },
      {
        title: "من الطرفية أيضًا",
        desc: "في الطرفية، يرفع relayium up ويعرض الرابط نفسه، ويجلبه relayium down على جهاز آخر — تتشارك CLI والويب رابطًا واحدًا.",
      },
    ],
  },
  learnHeading: "لمزيد من التعمّق",
  compare: {
    heading: "بالمقارنة",
    items: [
      {
        title: "مقابل روابط WeTransfer/Dropbox",
        body: "هذه يمكنها قراءة ملفاتك على جانب الخادم؛ أما خادم Relayium فلا يحتفظ إلا بنص مُشفَّر لا يستطيع فك تشفيره — ويبقى المفتاح في الرابط.",
      },
      {
        title: "مقابل الوضع الفوري",
        body: "الوضع الفوري من الند للند ويتطلب أن يكون الطرفان متصلين؛ أما هذا الوضع فيخزّن الملف مُشفَّرًا كي يتمكّن المُستقبِل من جلبه لاحقًا.",
      },
    ],
  },
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يستطيع الخادم قراءة ملفي؟",
        a: "لا — يُشفَّر في متصفحك؛ ولا يخزّن الخادم سوى نص مُشفَّر، والمفتاح لا يصله أبدًا.",
      },
      {
        q: "أين يوجد المفتاح؟",
        a: "في جزء الرابط (بعد #). لا ترسل المتصفحات الأجزاء إلى الخوادم، لذا لا يستطيع فك التشفير إلا مَن يملك الرابط الكامل.",
      },
      {
        q: "هل أحتاج إلى حساب؟",
        a: "للرفع، نعم (فهو يستهلك مساحة تخزين). للتنزيل، لا — يكفي الرابط.",
      },
      {
        q: "هل يمكنني جعله لمرة واحدة؟",
        a: "نعم — فعّل الحذف بعد القراءة وحدّد مدة صلاحية.",
      },
    ],
  },
  learnHeading: "اعرف المزيد",
  footer: { privacy: "الخصوصية", terms: "شروط الخدمة", security: "الأمان" },
};

export default {
  updated: "2026-07-10",
  langs: { zh, ja, ko, de, fr, ar },
};
