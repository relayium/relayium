// Lightweight, dependency-free i18n for the Relayium SPA, driven by Svelte 5 runes.
// The current language lives in module-level $state, so any component that reads
// `messages[lang()]` inside a $derived/template re-renders when the language changes.

export type Lang = "zh" | "en" | "ja" | "ko" | "de" | "fr";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
];

export interface Messages {
  langLabel: string;
  tagline: string;
  connected: (name: string) => string;
  connecting: string;
  unavailable: string;
  unsupported: string;
  guideTitle: string;
  step1: string;
  step2: string;
  step3: (max: number) => string;
  step4: string;
  hint: string;
  requestHead: (name: string, count: number, size: string) => string;
  codeLabel: string;
  codeCompare: string;
  accept: string;
  decline: string;
  sendTo: (name: string) => string;
  recvFrom: (name: string) => string;
  fileCounter: (i: number, n: number) => string;
  close: string;
  peersTitle: string;
  emptyPeers: string;
  pickHint: (max: number) => string;
  footer: string;
  busy: string;
  tooMany: (max: number, n: number) => string;
  titleDefault: string;
  status: {
    connecting: string;
    waitingAccept: string;
    rejected: string;
    sending: string;
    finishing: string;
    sendDone: (n: number) => string;
    sendFail: string;
    receiving: string;
    recvDone: (n: number) => string;
    integrityFail: string;
    recvFail: string;
    noSave: string;
    connectFail: string;
  };
}

export type StatusKey = keyof Messages["status"];

const zh: Messages = {
  langLabel: "语言",
  tagline: "端到端加密的点对点文件传输 · 文件不经过服务器",
  connected: (n) => `已连接 · 本机 ${n}`,
  connecting: "正在连接信令服务器…",
  unavailable: "无法使用",
  unsupported: "需要 HTTPS（或 localhost）才能进行加密传输。请通过 https:// 访问本页面。",
  guideTitle: "如何使用",
  step1: "在同一网络下的另一台设备或浏览器打开本页面（同一公网 IP 归为同一「房间」）。",
  step2: "双方会出现在下方「附近的设备」列表中。",
  step3: (m) => `点击对方卡片选择文件，或把文件拖到对方卡片上（一次最多 ${m} 个）。`,
  step4: "对方点「接收」，核对两边校验码一致后开始传输。",
  hint: "推荐 Chrome（大文件流式落盘、多文件可直接选目标文件夹，不占内存）。若同一路由器下互相看不到设备，请关闭路由器的「AP 隔离 / 客户端隔离」。",
  requestHead: (n, c, s) => `📥 ${n} 想发送 ${c} 个文件 · 共 ${s}`,
  codeLabel: "校验码",
  codeCompare: "请与发送方屏幕核对一致后再接收",
  accept: "接收",
  decline: "拒绝",
  sendTo: (n) => `发送 → ${n}`,
  recvFrom: (n) => `接收 ← ${n}`,
  fileCounter: (i, n) => `文件 ${i}/${n}`,
  close: "关闭",
  peersTitle: "附近的设备",
  emptyPeers: "还没有其它设备。请在同一网络下的另一台设备 / 另一个浏览器窗口打开本页面。",
  pickHint: (m) => `点击选择文件 · 或拖放到此处（最多 ${m} 个）`,
  footer: "端到端加密（X25519 + AES-256-GCM）· 信令服务器只转发连接信息，看不到文件内容",
  busy: "已有传输进行中，请等待完成",
  tooMany: (m, n) => `一次最多 ${m} 个文件，已忽略多余的 ${n} 个`,
  titleDefault: "Relayium — 端到端加密文件传输",
  status: {
    connecting: "正在建立加密连接…",
    waitingAccept: "等待对方确认接收…",
    rejected: "对方已拒绝 ✗",
    sending: "发送中…",
    finishing: "正在完成…",
    sendDone: (n) => `发送完成 ✓（${n} 个文件）`,
    sendFail: "发送失败 ✗",
    receiving: "接收中…",
    recvDone: (n) => `接收完成 ✓（${n} 个文件）`,
    integrityFail: "完整性校验失败 ✗",
    recvFail: "接收失败 ✗",
    noSave: "未选择保存位置，已取消",
    connectFail: "建立连接失败 ✗",
  },
};

const en: Messages = {
  langLabel: "Language",
  tagline: "End-to-end encrypted peer-to-peer file transfer · files never touch the server",
  connected: (n) => `Connected · this device ${n}`,
  connecting: "Connecting to the signaling server…",
  unavailable: "Unavailable",
  unsupported: "Encrypted transfer requires HTTPS (or localhost). Please open this page over https://.",
  guideTitle: "How to use",
  step1: "Open this page on another device or browser on the same network (devices sharing a public IP form one “room”).",
  step2: "Both devices then appear in the “Nearby devices” list below.",
  step3: (m) => `Click a device card to choose files, or drag files onto it (up to ${m} at a time).`,
  step4: "The recipient clicks “Accept”; once both verification codes match, the transfer begins.",
  hint: "Chrome is recommended (streams large files straight to disk and lets you pick a target folder for multiple files, without using memory). If devices on the same router can’t see each other, turn off the router’s “AP isolation / client isolation”.",
  requestHead: (n, c, s) => `📥 ${n} wants to send ${c} file(s) · ${s} total`,
  codeLabel: "Verification code",
  codeCompare: "compare it with the sender’s screen before accepting",
  accept: "Accept",
  decline: "Decline",
  sendTo: (n) => `Send → ${n}`,
  recvFrom: (n) => `Receive ← ${n}`,
  fileCounter: (i, n) => `File ${i}/${n}`,
  close: "Close",
  peersTitle: "Nearby devices",
  emptyPeers: "No other devices yet. Open this page on another device or browser window on the same network.",
  pickHint: (m) => `Click to choose files · or drop them here (up to ${m})`,
  footer: "End-to-end encrypted (X25519 + AES-256-GCM) · the signaling server only relays connection info and never sees file contents",
  busy: "A transfer is already in progress — please wait for it to finish",
  tooMany: (m, n) => `Up to ${m} files at a time; ignored the extra ${n}`,
  titleDefault: "Relayium — end-to-end encrypted file transfer",
  status: {
    connecting: "Establishing an encrypted connection…",
    waitingAccept: "Waiting for the recipient to accept…",
    rejected: "Declined by the recipient ✗",
    sending: "Sending…",
    finishing: "Finishing…",
    sendDone: (n) => `Sent ✓ (${n} file${n === 1 ? "" : "s"})`,
    sendFail: "Send failed ✗",
    receiving: "Receiving…",
    recvDone: (n) => `Received ✓ (${n} file${n === 1 ? "" : "s"})`,
    integrityFail: "Integrity check failed ✗",
    recvFail: "Receive failed ✗",
    noSave: "No save location chosen — cancelled",
    connectFail: "Connection failed ✗",
  },
};

const ja: Messages = {
  langLabel: "言語",
  tagline: "エンドツーエンド暗号化のP2Pファイル転送 · ファイルはサーバーを経由しません",
  connected: (n) => `接続済み · このデバイス ${n}`,
  connecting: "シグナリングサーバーに接続中…",
  unavailable: "利用不可",
  unsupported: "暗号化転送には HTTPS（または localhost）が必要です。https:// でこのページを開いてください。",
  guideTitle: "使い方",
  step1: "同じネットワーク上の別のデバイスやブラウザでこのページを開きます（同じグローバルIPは同一の「ルーム」になります）。",
  step2: "両方のデバイスが下の「近くのデバイス」一覧に表示されます。",
  step3: (m) => `相手のカードをクリックしてファイルを選ぶか、ファイルをカードにドラッグします（一度に最大 ${m} 個）。`,
  step4: "相手が「受信」をクリックし、両方の確認コードが一致したら転送が始まります。",
  hint: "Chrome を推奨します（大きなファイルをディスクに直接ストリーミングし、複数ファイルは保存先フォルダーを選べてメモリを消費しません）。同じルーター配下で相手が見えない場合は、ルーターの「AP 分離 / クライアント分離」をオフにしてください。",
  requestHead: (n, c, s) => `📥 ${n} さんが ${c} 個のファイルを送信しようとしています · 合計 ${s}`,
  codeLabel: "確認コード",
  codeCompare: "受信する前に送信側の画面と一致するか確認してください",
  accept: "受信",
  decline: "拒否",
  sendTo: (n) => `送信 → ${n}`,
  recvFrom: (n) => `受信 ← ${n}`,
  fileCounter: (i, n) => `ファイル ${i}/${n}`,
  close: "閉じる",
  peersTitle: "近くのデバイス",
  emptyPeers: "他のデバイスはまだありません。同じネットワーク上の別のデバイスやブラウザウィンドウでこのページを開いてください。",
  pickHint: (m) => `クリックしてファイルを選択 · またはここにドロップ（最大 ${m} 個）`,
  footer: "エンドツーエンド暗号化（X25519 + AES-256-GCM）· シグナリングサーバーは接続情報のみを中継し、ファイルの内容は見えません",
  busy: "すでに転送が進行中です。完了するまでお待ちください",
  tooMany: (m, n) => `一度に最大 ${m} 個まで。超過した ${n} 個は無視しました`,
  titleDefault: "Relayium — エンドツーエンド暗号化ファイル転送",
  status: {
    connecting: "暗号化接続を確立中…",
    waitingAccept: "相手の受信確認を待っています…",
    rejected: "相手に拒否されました ✗",
    sending: "送信中…",
    finishing: "完了処理中…",
    sendDone: (n) => `送信完了 ✓（${n} 個のファイル）`,
    sendFail: "送信に失敗しました ✗",
    receiving: "受信中…",
    recvDone: (n) => `受信完了 ✓（${n} 個のファイル）`,
    integrityFail: "整合性チェックに失敗しました ✗",
    recvFail: "受信に失敗しました ✗",
    noSave: "保存先が選択されなかったため、キャンセルしました",
    connectFail: "接続の確立に失敗しました ✗",
  },
};

const ko: Messages = {
  langLabel: "언어",
  tagline: "종단간 암호화 P2P 파일 전송 · 파일은 서버를 거치지 않습니다",
  connected: (n) => `연결됨 · 내 기기 ${n}`,
  connecting: "시그널링 서버에 연결 중…",
  unavailable: "사용 불가",
  unsupported: "암호화 전송에는 HTTPS(또는 localhost)가 필요합니다. https:// 로 이 페이지를 열어 주세요.",
  guideTitle: "사용 방법",
  step1: "같은 네트워크의 다른 기기나 브라우저에서 이 페이지를 엽니다(같은 공인 IP는 하나의 ‘방’이 됩니다).",
  step2: "두 기기가 아래 ‘주변 기기’ 목록에 나타납니다.",
  step3: (m) => `상대 기기 카드를 클릭해 파일을 선택하거나 파일을 카드 위로 끌어다 놓습니다(한 번에 최대 ${m}개).`,
  step4: "상대가 ‘받기’를 클릭하고 양쪽 확인 코드가 일치하면 전송이 시작됩니다.",
  hint: "Chrome을 권장합니다(큰 파일을 디스크로 바로 스트리밍하고, 여러 파일은 대상 폴더를 선택할 수 있어 메모리를 쓰지 않습니다). 같은 공유기에서 서로 보이지 않으면 공유기의 ‘AP 격리 / 클라이언트 격리’를 끄세요.",
  requestHead: (n, c, s) => `📥 ${n} 님이 파일 ${c}개를 보내려 합니다 · 총 ${s}`,
  codeLabel: "확인 코드",
  codeCompare: "받기 전에 보내는 쪽 화면과 일치하는지 확인하세요",
  accept: "받기",
  decline: "거부",
  sendTo: (n) => `보내기 → ${n}`,
  recvFrom: (n) => `받기 ← ${n}`,
  fileCounter: (i, n) => `파일 ${i}/${n}`,
  close: "닫기",
  peersTitle: "주변 기기",
  emptyPeers: "아직 다른 기기가 없습니다. 같은 네트워크의 다른 기기나 브라우저 창에서 이 페이지를 여세요.",
  pickHint: (m) => `클릭하여 파일 선택 · 또는 여기에 드롭(최대 ${m}개)`,
  footer: "종단간 암호화(X25519 + AES-256-GCM) · 시그널링 서버는 연결 정보만 중계하며 파일 내용은 보지 못합니다",
  busy: "이미 전송이 진행 중입니다. 완료될 때까지 기다려 주세요",
  tooMany: (m, n) => `한 번에 최대 ${m}개까지. 초과한 ${n}개는 무시했습니다`,
  titleDefault: "Relayium — 종단간 암호화 파일 전송",
  status: {
    connecting: "암호화 연결을 설정하는 중…",
    waitingAccept: "상대의 수락을 기다리는 중…",
    rejected: "상대가 거부했습니다 ✗",
    sending: "보내는 중…",
    finishing: "마무리 중…",
    sendDone: (n) => `보내기 완료 ✓ (파일 ${n}개)`,
    sendFail: "보내기 실패 ✗",
    receiving: "받는 중…",
    recvDone: (n) => `받기 완료 ✓ (파일 ${n}개)`,
    integrityFail: "무결성 검사 실패 ✗",
    recvFail: "받기 실패 ✗",
    noSave: "저장 위치를 선택하지 않아 취소되었습니다",
    connectFail: "연결 실패 ✗",
  },
};

const de: Messages = {
  langLabel: "Sprache",
  tagline: "Ende-zu-Ende-verschlüsselte Peer-to-Peer-Dateiübertragung · Dateien erreichen nie den Server",
  connected: (n) => `Verbunden · dieses Gerät ${n}`,
  connecting: "Verbindung zum Signalisierungsserver…",
  unavailable: "Nicht verfügbar",
  unsupported: "Verschlüsselte Übertragung erfordert HTTPS (oder localhost). Bitte öffnen Sie diese Seite über https://.",
  guideTitle: "So funktioniert’s",
  step1: "Öffnen Sie diese Seite auf einem anderen Gerät oder Browser im selben Netzwerk (Geräte mit derselben öffentlichen IP bilden einen „Raum“).",
  step2: "Beide Geräte erscheinen dann in der Liste „Geräte in der Nähe“ unten.",
  step3: (m) => `Klicken Sie auf eine Gerätekarte, um Dateien auszuwählen, oder ziehen Sie Dateien darauf (bis zu ${m} auf einmal).`,
  step4: "Der Empfänger klickt auf „Annehmen“; sobald beide Prüfcodes übereinstimmen, beginnt die Übertragung.",
  hint: "Chrome wird empfohlen (streamt große Dateien direkt auf die Festplatte und lässt Sie bei mehreren Dateien einen Zielordner wählen, ohne Speicher zu belegen). Wenn sich Geräte am selben Router nicht sehen, deaktivieren Sie die „AP-Isolierung / Client-Isolierung“ des Routers.",
  requestHead: (n, c, s) => `📥 ${n} möchte ${c} Datei(en) senden · ${s} gesamt`,
  codeLabel: "Prüfcode",
  codeCompare: "vergleichen Sie ihn vor dem Annehmen mit dem Bildschirm des Absenders",
  accept: "Annehmen",
  decline: "Ablehnen",
  sendTo: (n) => `Senden → ${n}`,
  recvFrom: (n) => `Empfangen ← ${n}`,
  fileCounter: (i, n) => `Datei ${i}/${n}`,
  close: "Schließen",
  peersTitle: "Geräte in der Nähe",
  emptyPeers: "Noch keine anderen Geräte. Öffnen Sie diese Seite auf einem anderen Gerät oder Browserfenster im selben Netzwerk.",
  pickHint: (m) => `Zum Auswählen klicken · oder hierher ziehen (bis zu ${m})`,
  footer: "Ende-zu-Ende-verschlüsselt (X25519 + AES-256-GCM) · der Signalisierungsserver leitet nur Verbindungsdaten weiter und sieht nie Dateiinhalte",
  busy: "Eine Übertragung läuft bereits – bitte warten Sie, bis sie abgeschlossen ist",
  tooMany: (m, n) => `Maximal ${m} Dateien auf einmal; ${n} überzählige ignoriert`,
  titleDefault: "Relayium — Ende-zu-Ende-verschlüsselte Dateiübertragung",
  status: {
    connecting: "Verschlüsselte Verbindung wird hergestellt…",
    waitingAccept: "Warten auf die Annahme des Empfängers…",
    rejected: "Vom Empfänger abgelehnt ✗",
    sending: "Senden…",
    finishing: "Wird abgeschlossen…",
    sendDone: (n) => `Gesendet ✓ (${n} Datei${n === 1 ? "" : "en"})`,
    sendFail: "Senden fehlgeschlagen ✗",
    receiving: "Empfangen…",
    recvDone: (n) => `Empfangen ✓ (${n} Datei${n === 1 ? "" : "en"})`,
    integrityFail: "Integritätsprüfung fehlgeschlagen ✗",
    recvFail: "Empfang fehlgeschlagen ✗",
    noSave: "Kein Speicherort gewählt – abgebrochen",
    connectFail: "Verbindung fehlgeschlagen ✗",
  },
};

const fr: Messages = {
  langLabel: "Langue",
  tagline: "Transfert de fichiers pair-à-pair chiffré de bout en bout · les fichiers ne passent jamais par le serveur",
  connected: (n) => `Connecté · cet appareil ${n}`,
  connecting: "Connexion au serveur de signalisation…",
  unavailable: "Indisponible",
  unsupported: "Le transfert chiffré nécessite HTTPS (ou localhost). Veuillez ouvrir cette page via https://.",
  guideTitle: "Comment ça marche",
  step1: "Ouvrez cette page sur un autre appareil ou navigateur du même réseau (les appareils partageant une IP publique forment une même « salle »).",
  step2: "Les deux appareils apparaissent alors dans la liste « Appareils à proximité » ci-dessous.",
  step3: (m) => `Cliquez sur la carte d’un appareil pour choisir des fichiers, ou faites-les glisser dessus (jusqu’à ${m} à la fois).`,
  step4: "Le destinataire clique sur « Accepter » ; une fois les deux codes de vérification identiques, le transfert démarre.",
  hint: "Chrome est recommandé (diffuse les gros fichiers directement sur le disque et permet de choisir un dossier de destination pour plusieurs fichiers, sans utiliser la mémoire). Si des appareils sur le même routeur ne se voient pas, désactivez « l’isolation AP / isolation des clients » du routeur.",
  requestHead: (n, c, s) => `📥 ${n} veut envoyer ${c} fichier(s) · ${s} au total`,
  codeLabel: "Code de vérification",
  codeCompare: "comparez-le avec l’écran de l’expéditeur avant d’accepter",
  accept: "Accepter",
  decline: "Refuser",
  sendTo: (n) => `Envoi → ${n}`,
  recvFrom: (n) => `Réception ← ${n}`,
  fileCounter: (i, n) => `Fichier ${i}/${n}`,
  close: "Fermer",
  peersTitle: "Appareils à proximité",
  emptyPeers: "Aucun autre appareil pour l’instant. Ouvrez cette page sur un autre appareil ou une autre fenêtre du même réseau.",
  pickHint: (m) => `Cliquez pour choisir · ou déposez ici (jusqu’à ${m})`,
  footer: "Chiffré de bout en bout (X25519 + AES-256-GCM) · le serveur de signalisation ne relaie que les infos de connexion et ne voit jamais le contenu des fichiers",
  busy: "Un transfert est déjà en cours — veuillez attendre qu’il se termine",
  tooMany: (m, n) => `Jusqu’à ${m} fichiers à la fois ; ${n} en trop ignoré(s)`,
  titleDefault: "Relayium — transfert de fichiers chiffré de bout en bout",
  status: {
    connecting: "Établissement d’une connexion chiffrée…",
    waitingAccept: "En attente de l’acceptation du destinataire…",
    rejected: "Refusé par le destinataire ✗",
    sending: "Envoi…",
    finishing: "Finalisation…",
    sendDone: (n) => `Envoyé ✓ (${n} fichier${n === 1 ? "" : "s"})`,
    sendFail: "Échec de l’envoi ✗",
    receiving: "Réception…",
    recvDone: (n) => `Reçu ✓ (${n} fichier${n === 1 ? "" : "s"})`,
    integrityFail: "Échec du contrôle d’intégrité ✗",
    recvFail: "Échec de la réception ✗",
    noSave: "Aucun emplacement de sauvegarde choisi — annulé",
    connectFail: "Échec de la connexion ✗",
  },
};

export const messages: Record<Lang, Messages> = { zh, en, ja, ko, de, fr };

const STORAGE_KEY = "relayium-lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in messages) return saved as Lang;
  } catch { /* storage may be unavailable */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  for (const code of ["zh", "ja", "ko", "de", "fr"] as Lang[]) {
    if (nav.startsWith(code)) return code;
  }
  return "en";
}

let current = $state<Lang>(detect());

/** Reactive read of the current language. */
export function lang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}
