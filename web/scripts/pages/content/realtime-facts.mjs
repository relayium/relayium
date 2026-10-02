// Shared realtime-transfer facts. Articles compose these fragments instead of
// restating protocol constants in prose, so changing the code format, account
// boundary, TTL or cross-network path has one nine-language authority.
//
// cliDirectFacts keeps its historical name so every article that composes it
// keeps one reference, but its maintained en/zh text is the CLI relay policy
// (server/cmd/relayium/help.go linkRelayPolicy): a pairing-code session relays
// every byte whenever the server issues a TURN relay; it goes peer to peer only
// when no relay is issued. Routing is not billing: relayed bytes count toward
// the code owner's allowance only when the relay reports billable usage (fleet
// node heartbeats do; coturn's Redis ingest is disabled and its metering bridge
// defaults to shadow, which never writes the billable ledger —
// server/account/coturn_metering_store.go ApplyCoturnSnapshot). The seven frozen
// locales carry the same fact as a translated archived erratum (DECISION-LOG
// 2026-09-30 item 2; archived-fact-errata.test.mjs), not the retired
// direct-only wording.

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
  en: "Relayium's CLI pairing-code sessions (send / receive, text and pair) send every byte through an encrypted TURN relay whenever the server issues one for the code — even when the two ends could reach each other directly; the relay carries only ciphertext it cannot read. Those relayed bytes count toward the monthly traffic allowance of the account that minted the code when the relay reports them as billable usage — the relay nodes Relayium operates do, while Relayium's coturn TURN servers bill nothing today — their legacy usage ingest is disabled, and their optional accounting ingest is off by default and, if configured in shadow mode, records measurements without writing to the billing ledger, usage periods or any allowance — so a relayed session is not by itself a billed one. Only when no relay is issued (none is configured, or that allowance is used up) do the two ends connect peer to peer, and then the session fails if they have no direct path.",
  zh: "Relayium CLI 的配对码会话（send / receive、text 和 pair）只要服务器为这个码签发了 TURN 中继，每个字节就都经这条加密中继传输——即使两端本可直接连通；中继只经手它读不了的密文。中继把这些字节上报为计费用量时，它们才计入生成配对码那个账号的每月流量额度——Relayium 运营的中继节点会这样上报，而 Relayium 的 coturn TURN 服务器目前不计费——旧的用量采集已停用，可选的计量采集默认关闭，如果配置为影子模式，也只记录测量值，不写入计费账本、用量周期或任何额度——所以会话经过中继并不等于被计费。只有在没有签发中继时（没有配置中继，或该额度已用尽），两端才点对点连接，而此时如果两端之间没有直连路径，会话就会失败。",
  ja: "Relayium CLI のペアリングコードによるセッション（send / receive、text、pair）は、サーバーがそのコードに TURN リレーを発行した場合、両端が直接つながれる状況であっても、すべてのバイトを暗号化された TURN リレー経由で送ります。中継されたバイトは、そのコードを発行したアカウントの月間転送量の枠に計上され、リレーが運ぶのは読むことのできない暗号文だけです。リレーが発行されないとき（リレーが設定されていない、またはその枠を使い切ったとき）に限り両端は P2P で直接つながり、そのとき直接の経路がなければセッションは失敗します。",
  ko: "Relayium CLI의 페어링 코드 세션(send / receive, text, pair)은 서버가 해당 코드에 TURN 릴레이를 발급하면, 두 기기가 직접 연결될 수 있는 경우에도 모든 바이트를 암호화된 TURN 릴레이로 보냅니다. 릴레이된 바이트는 코드를 발급한 계정의 월간 전송량 한도에 집계되며, 릴레이는 읽을 수 없는 암호문만 전달합니다. 릴레이가 발급되지 않을 때(릴레이가 구성되지 않았거나 그 한도를 모두 쓴 경우)에만 두 기기가 P2P로 직접 연결되며, 이때 직접 경로가 없으면 세션이 실패합니다.",
  de: "Die Pairing-Code-Sitzungen der Relayium CLI (send / receive, text und pair) leiten jedes Byte über ein verschlüsseltes TURN-Relay, sobald der Server für den Code eines ausstellt – auch wenn sich beide Endpunkte direkt erreichen könnten –, und diese weitergeleiteten Bytes zählen zum monatlichen Datenvolumen des Kontos, das den Code erzeugt hat; das Relay transportiert nur Chiffretext, den es nicht lesen kann. Nur wenn kein Relay ausgestellt wird (keines ist konfiguriert oder dieses Kontingent ist aufgebraucht), verbinden sich die beiden Endpunkte direkt per P2P, und fehlt dann ein direkter Weg, schlägt die Sitzung fehl.",
  fr: "Les sessions à code d'appairage de la CLI Relayium (send / receive, text et pair) font passer chaque octet par un relais TURN chiffré dès que le serveur en attribue un pour le code — même si les deux extrémités pourraient se joindre directement — et ces octets relayés sont décomptés du quota mensuel de trafic du compte qui a généré le code ; le relais ne transporte que du texte chiffré qu'il ne peut pas lire. Ce n'est que lorsqu'aucun relais n'est attribué (aucun n'est configuré, ou ce quota est épuisé) que les deux extrémités se connectent directement en pair à pair (P2P), et la session échoue alors s'il n'existe aucun chemin direct.",
  ar: "تمرّر جلسات رمز الاقتران في Relayium CLI ‏(send / receive وtext وpair) كل بايت عبر مُرحِّل TURN مُشفَّر كلما أصدر الخادم مُرحِّلًا للرمز — حتى لو كان بإمكان الطرفين الاتصال مباشرةً — وتُحتسب هذه البايتات المُرحَّلة ضمن حصة حركة البيانات الشهرية للحساب الذي أنشأ الرمز؛ ولا يحمل المُرحِّل إلا نصًا مُشفَّرًا لا يستطيع قراءته. ولا يتصل الطرفان مباشرةً من نظير إلى نظير (P2P) إلا عندما لا يُصدَر أي مُرحِّل (لم يُهيَّأ مُرحِّل، أو نفدت تلك الحصة)، وعندها تفشل الجلسة إذا لم يوجد مسار مباشر بينهما.",
  es: "Las sesiones con código de emparejamiento del CLI de Relayium (send / receive, text y pair) envían cada byte a través de un retransmisor TURN cifrado siempre que el servidor emite uno para el código —aunque los dos extremos pudieran conectarse directamente—, y esos bytes retransmitidos cuentan para la cuota mensual de tráfico de la cuenta que generó el código; el retransmisor solo transporta texto cifrado que no puede leer. Solo cuando no se emite ningún retransmisor (no hay ninguno configurado o esa cuota está agotada) los dos extremos se conectan de igual a igual (P2P), y entonces la sesión falla si no existe una ruta directa.",
  pt: "As sessões com código de pareamento da CLI do Relayium (send / receive, text e pair) enviam cada byte por um retransmissor TURN criptografado sempre que o servidor emite um para o código — mesmo quando as duas pontas poderiam se conectar diretamente —, e esses bytes retransmitidos contam para a cota mensal de tráfego da conta que gerou o código; o retransmissor só transporta texto cifrado que não consegue ler. Só quando nenhum retransmissor é emitido (nenhum está configurado ou essa cota se esgotou) as duas pontas se conectam ponto a ponto (P2P), e então a sessão falha se não houver um caminho direto.",
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
