// Shared realtime-transfer facts. Articles compose these fragments instead of
// restating protocol constants in prose, so changing the code format, account
// boundary, TTL or cross-network path has one nine-language authority.

export const pairingFacts = {
  en: "The server generates exactly six decimal digits (0–9, including a leading zero). The sender signs in to create the code, while the person joining by code, link or QR never needs an account. It accepts new joins for five minutes; an already connected transfer is not cut off when that countdown ends.",
  zh: "配对码由服务器生成，固定为 6 位十进制数字（0–9，可以 0 开头）。发送方登录后创建配对码；通过配对码、链接或二维码加入的人始终无需账号。它可在 5 分钟内用于新设备加入；倒计时结束不会中断已经连上的传输。",
  ja: "ペアリングコードはサーバーが生成する6桁の10進数字です（0〜9、先頭の0も有効）。送信側はコード作成時にサインインしますが、コード、リンク、QRから参加する側にアカウントは不要です。新しく参加できるのは5分間で、すでに接続済みの転送はカウントダウン終了で切断されません。",
  ko: "페어링 코드는 서버가 생성하는 정확히 6자리 십진수입니다(0–9, 맨 앞의 0도 유효). 보내는 쪽은 코드를 만들 때 로그인하지만 코드·링크·QR로 참가하는 쪽은 계정이 필요 없습니다. 새 기기가 참가할 수 있는 시간은 5분이며, 이미 연결된 전송은 카운트다운이 끝나도 끊기지 않습니다.",
  de: "Der Server erzeugt genau sechs Dezimalziffern (0–9, auch mit führender Null). Der Absender meldet sich an, um den Code zu erstellen; wer per Code, Link oder QR beitritt, braucht kein Konto. Neue Beitritte sind fünf Minuten lang möglich; eine bereits verbundene Übertragung endet nicht mit dem Countdown.",
  fr: "Le serveur génère exactement six chiffres décimaux (0–9, zéro initial compris). L’expéditeur se connecte pour créer le code ; la personne qui rejoint par code, lien ou QR n’a jamais besoin de compte. Les nouvelles connexions sont acceptées pendant cinq minutes ; une transmission déjà connectée ne s’arrête pas à la fin du compte à rebours.",
  ar: "يُولِّد الخادم ستة أرقام عشرية بالضبط (من 0 إلى 9، ويصح أن يبدأ الرمز بصفر). يسجّل المُرسِل الدخول لإنشاء الرمز، أما من ينضم بالرمز أو الرابط أو رمز QR فلا يحتاج إلى حساب. يقبل الرمز انضمامات جديدة لمدة خمس دقائق؛ ولا ينقطع نقل اتصل بالفعل عند انتهاء العدّ التنازلي.",
  es: "El servidor genera exactamente seis dígitos decimales (0–9, incluido un cero inicial). El remitente inicia sesión para crear el código; quien se une por código, enlace o QR nunca necesita una cuenta. Acepta nuevas conexiones durante cinco minutos; una transferencia ya conectada no se corta cuando termina la cuenta atrás.",
  pt: "O servidor gera exatamente seis dígitos decimais (0–9, inclusive com zero à esquerda). O remetente faz login para criar o código; quem entra por código, link ou QR nunca precisa de conta. Ele aceita novas entradas por cinco minutos; uma transferência já conectada não é interrompida quando a contagem termina.",
};

export const browserRelayFacts = {
  en: "Across networks, browsers use an encrypted TURN relay by design rather than trying a direct path first. The key stays on the two devices, so the relay forwards only end-to-end-encrypted ciphertext, cannot read the files and keeps no realtime content copy or history.",
  zh: "跨网络时，浏览器按设计直接使用加密的 TURN 中继，不会先尝试直连。密钥始终留在两台设备上，因此中继只转发端到端加密后的密文，无法读取文件，也不保留实时内容副本或历史。",
  ja: "ネットワークをまたぐ場合、ブラウザは先に直接経路を試すのではなく、設計どおり暗号化された TURN リレーを使います。鍵は2台の端末に留まるため、リレーが転送するのはエンドツーエンド暗号化された暗号文だけで、ファイルを読めず、リアルタイム内容のコピーや履歴も保持しません。",
  ko: "네트워크가 다르면 브라우저는 직접 경로를 먼저 시도하지 않고 설계상 암호화된 TURN 릴레이를 사용합니다. 키는 두 기기에만 남으므로 릴레이는 종단 간 암호화된 암호문만 전달하고 파일을 읽을 수 없으며 실시간 콘텐츠 사본이나 기록도 보관하지 않습니다.",
  de: "Über Netzwerkgrenzen hinweg nutzen Browser planmäßig ein verschlüsseltes TURN-Relay, statt zuerst einen direkten Weg zu versuchen. Der Schlüssel bleibt auf den beiden Geräten; das Relay leitet daher nur Ende-zu-Ende-verschlüsselten Chiffretext weiter, kann die Dateien nicht lesen und behält weder eine Echtzeit-Inhaltskopie noch einen Verlauf.",
  fr: "Entre réseaux différents, les navigateurs utilisent par conception un relais TURN chiffré au lieu d’essayer d’abord un chemin direct. La clé reste sur les deux appareils : le relais ne transmet que du texte chiffré de bout en bout, ne peut pas lire les fichiers et ne conserve ni copie ni historique du contenu en temps réel.",
  ar: "عبر الشبكات، تستخدم المتصفّحات مُرحِّل TURN مُشفَّرًا بحكم التصميم بدل محاولة مسار مباشر أولًا. يبقى المفتاح على الجهازين، لذلك لا يمرّر المُرحِّل سوى نص مُشفَّر من طرف إلى طرف، ولا يستطيع قراءة الملفات، ولا يحتفظ بنسخة أو سجل للمحتوى الآني.",
  es: "Entre redes distintas, los navegadores usan por diseño un retransmisor TURN cifrado en vez de intentar primero una ruta directa. La clave permanece en los dos dispositivos, así que el retransmisor solo reenvía texto cifrado de extremo a extremo, no puede leer los archivos ni conserva una copia o historial del contenido en tiempo real.",
  pt: "Entre redes diferentes, os navegadores usam por projeto um retransmissor TURN criptografado em vez de tentar primeiro uma rota direta. A chave fica nos dois dispositivos, então o retransmissor só encaminha texto cifrado de ponta a ponta, não consegue ler os arquivos e não guarda cópia nem histórico do conteúdo em tempo real.",
};

export const cliDirectFacts = {
  en: "Relayium CLI send/receive and text are direct-only P2P: they never relay file or message bytes through TURN or any other Relayium server. If the two ends cannot establish a direct connection, the session fails rather than falling back to a relay.",
  zh: "Relayium CLI 的 send/receive 和 text 都只走 P2P 直连：文件或消息字节绝不会通过 TURN 或任何其他 Relayium 服务器中继。两端无法建立直连时，会话会直接失败，不会回退到中继。",
  ja: "Relayium CLI の send/receive と text は P2P 直接接続専用です。ファイルやメッセージのバイトを TURN やその他の Relayium サーバーで中継することはありません。2 つの端末が直接接続を確立できなければ、リレーへフォールバックせずにセッションは失敗します。",
  ko: "Relayium CLI의 send/receive와 text는 P2P 직접 연결 전용입니다. 파일이나 메시지 바이트를 TURN 또는 다른 Relayium 서버로 릴레이하지 않습니다. 두 기기가 직접 연결을 맺지 못하면 릴레이로 대체하지 않고 세션이 실패합니다.",
  de: "Relayium CLI send/receive und text sind direct-only P2P: Datei- oder Nachrichtenbytes werden weder über TURN noch über einen anderen Relayium-Server weitergeleitet. Können die beiden Endpunkte keine direkte Verbindung herstellen, schlägt die Sitzung fehl, statt auf ein Relay auszuweichen.",
  fr: "Les commandes send/receive et text du CLI Relayium sont P2P et direct-only : aucun octet de fichier ou de message ne transite par TURN ni par un autre serveur Relayium. Si les deux extrémités ne peuvent pas établir de connexion directe, la session échoue au lieu de se rabattre sur un relais.",
  ar: "تعمل أوامر send/receive وtext في Relayium CLI باتصال P2P مباشر فقط: فلا تُمرَّر بايتات الملفات أو الرسائل عبر TURN أو أي خادم Relayium آخر. وإذا تعذّر على الطرفين إنشاء اتصال مباشر، تفشل الجلسة بدل الرجوع إلى مُرحِّل.",
  es: "send/receive y text del CLI de Relayium son P2P y direct-only: nunca retransmiten bytes de archivos o mensajes mediante TURN ni ningún otro servidor de Relayium. Si los dos extremos no pueden establecer una conexión directa, la sesión falla en vez de recurrir a un retransmisor.",
  pt: "send/receive e text da CLI do Relayium são P2P e direct-only: nunca retransmitem bytes de arquivos ou mensagens por TURN nem por qualquer outro servidor Relayium. Se as duas pontas não conseguirem estabelecer uma conexão direta, a sessão falha em vez de recorrer a um retransmissor.",
};

const headings = {
  en: "On different networks: pairing and relay",
  zh: "跨网络：配对与中继",
  ja: "別のネットワーク：ペアリングとリレー",
  ko: "다른 네트워크: 페어링과 릴레이",
  de: "Über verschiedene Netze: Pairing und Relay",
  fr: "Entre réseaux : appairage et relais",
  ar: "عبر الشبكات: الاقتران والمُرحِّل",
  es: "Entre redes: emparejamiento y retransmisión",
  pt: "Entre redes: emparelhamento e retransmissão",
};

export const browserCrossNetworkSection = Object.fromEntries(
  Object.keys(headings).map((lang) => [lang, {
    heading: headings[lang],
    body: [pairingFacts[lang], browserRelayFacts[lang]],
  }]),
);
