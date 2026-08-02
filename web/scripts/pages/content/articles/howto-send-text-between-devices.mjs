// How-to: move clipboard-shaped text between devices without turning Relayium
// into stored chat. Browser and CLI pairing are separate, non-interoperable
// transports; the shared product contract is online-only, session-scoped text.

const commands = `# One machine mints the code and waits (relayium login is required once)
relayium text
# Code: K7M4XR   (valid 30 minutes)
# On the other machine:  relayium text K7M4XR

# The other machine joins that code
relayium text K7M4XR

# Send one multiline message exactly as copied (macOS)
pbpaste | relayium text K7M4XR --yes

# Or pipe a file on any shell
cat snippet.txt | relayium text K7M4XR --yes`;

function article(c) {
  return {
    title: c.title,
    description: c.description,
    updatedLabel: c.updatedLabel,
    lead: c.lead,
    sections: [
      {
        heading: c.browserHeading,
        body: [c.browserBody],
        bullets: c.browserSteps,
      },
      {
        heading: c.cliHeading,
        body: c.cliBody,
        code: [commands],
        bullets: c.cliNotes,
      },
      {
        heading: c.boundariesHeading,
        body: [c.boundariesBody],
        bullets: c.boundaries,
      },
    ],
    faq: {
      heading: c.faqHeading,
      items: c.faq,
    },
    cta: { text: c.ctaText, button: c.ctaButton, href: "/" },
    relatedHeading: c.relatedHeading,
  };
}

const en = article({
  title: "Send text, links and commands between devices",
  description:
    "Move text, links, commands and multiline code between devices with Relayium — end-to-end encrypted and online-only, with no message bodies or server-side history kept by Relayium; either endpoint can retain received text.",
  updatedLabel: "Last updated",
  lead: [
    "Relayium can move clipboard-shaped content as well as files: a URL from your phone, a command for another computer, or a multiline code block. Messages are end-to-end encrypted; Relayium servers keep no message bodies or server-side history, but either endpoint can copy or retain received text.",
    "The browser and command-line client each support text, but they are separate transports and cannot join each other's pairing codes. Choose one flow below and use it on both ends.",
  ],
  browserHeading: "Browser: send a message to an online device",
  browserBody:
    "Open relayium.com on both devices. Devices on the same network appear automatically; for different networks, create a browser pairing code from the cross-network page and join it in the other browser.",
  browserSteps: [
    "On the peer card, choose “Send a message”; the recipient must accept before any message content or composer appears.",
    "Compare the six-digit verification code (SAS) on both screens, then type or paste text. Use ⌘/Ctrl+Enter to send.",
    "Each side can send several messages and use Copy on any received message while the session remains open.",
  ],
  cliHeading: "CLI: mint a code on one machine, join it on the other",
  cliBody: [
    "Run relayium text with no code on one machine. It mints a six-character code with your account, prints the exact command the other machine should run, and stays in the session waiting for it. There is no temporary file to send and no extra process to stop.",
    "Run relayium text with that code on the other machine. Interactive mode sends one line per message and asks both people to confirm the SAS. For multiline or byte-exact stdin, pipe it as one message and pass --yes because no terminal is available for the SAS prompt.",
  ],
  cliNotes: [
    "CLI codes last thirty minutes and are CLI-to-CLI only; browser codes cannot connect a browser to the CLI.",
    "Only the machine that mints needs a signed-in account. The machine joining the printed code does not sign in.",
    "--yes skips the interactive SAS confirmation, so compare the session another trusted way before using it.",
  ],
  boundariesHeading: "What text transfer is — and is not",
  boundariesBody:
    "Relayium treats the body as UTF-8 plain text. It preserves spaces, tabs, blank lines and line breaks, and does not execute, render Markdown, linkify or preview the content.",
  boundaries: [
    "Both devices must be online together. There is no offline delivery, inbox, contact list or synchronized chat history.",
    "History is local to the open session and disappears when it ends or the page reloads; the server never stores message bodies.",
    "One message is at most 65,536 UTF-8 bytes. For anything larger, send it as a file instead.",
  ],
  faqHeading: "Frequently asked questions",
  faq: [
    {
      q: "Can Relayium read or recover my messages?",
      a: "No. Message content is end-to-end encrypted between the two devices, and Relayium servers keep no message bodies or server-side history. Either endpoint can copy or retain received text; after the live session ends, Relayium has no server copy to recover.",
    },
    {
      q: "Can I use a browser on one end and the CLI on the other?",
      a: "No. Browser and CLI text sessions use different transports and pairing handshakes. Use two browsers or two CLI clients.",
    },
  ],
  ctaText: "Open Relayium on two online devices and move the next thing you would otherwise send to yourself.",
  ctaButton: "Send text now",
  relatedHeading: "Keep reading",
});

const zh = article({
  title: "在设备之间发送文本、链接和命令",
  description:
    "用 Relayium 在设备之间传递文本、链接、命令和多行代码——端到端加密、仅限双方在线；Relayium 服务器不保存消息正文或服务端历史，但任一端都可留存收到的文本。",
  updatedLabel: "最近更新",
  lead: [
    "Relayium 不只能传文件，也能传适合剪贴板的内容：手机上的网址、要在另一台电脑执行的命令，或一整段多行代码。消息端到端加密；Relayium 服务器不保存消息正文或服务端历史，但任一端都能复制或留存收到的文本。",
    "浏览器和命令行都支持文本，但它们是两套独立传输，不能加入彼此的配对码。下面任选一种方式，两端保持一致。",
  ],
  browserHeading: "浏览器：给在线设备发送消息",
  browserBody:
    "在两台设备上打开 relayium.com。同一网络的设备会自动出现；不同网络时，在跨网络页面创建浏览器配对码，再让另一台浏览器加入。",
  browserSteps: [
    "在对端卡片上选择“发送消息”；接收方接受之前，消息正文和输入框都不会出现。",
    "核对两块屏幕上的 6 位校验码（SAS），然后输入或粘贴文本，用 ⌘/Ctrl+Enter 发送。",
    "会话保持打开时，双方都能连续发送多条消息，也能对收到的任意消息点“复制”。",
  ],
  cliHeading: "CLI：一台机器生成配对码，另一台加入",
  cliBody: [
    "在其中一台机器上直接运行 relayium text，不带配对码。它会用你的账号生成一个 6 位配对码，打印出另一台机器该运行的完整命令，并留在会话里等待对方加入。不需要临时文件，也不需要另外停掉任何进程。",
    "另一台机器用该码运行 relayium text。交互模式每行是一条消息，并默认要求双方确认 SAS；多行或要求逐字节保真的内容请通过管道作为一条消息发送，因为此时没有终端可确认 SAS，所以必须显式加 --yes。",
  ],
  cliNotes: [
    "CLI 配对码有效期 30 分钟，只能 CLI 对 CLI；浏览器码不能让浏览器与 CLI 互连。",
    "只有生成配对码的那台机器需要已登录账号；使用打印出来的配对码加入时不需要登录。",
    "--yes 会跳过交互式 SAS 确认，使用前应通过其他可信方式核对会话。",
  ],
  boundariesHeading: "文本传输是什么，也不是什么",
  boundariesBody:
    "Relayium 把正文当作 UTF-8 纯文本，保留空格、制表符、空行和换行；不会执行内容、渲染 Markdown、自动识别链接或生成预览。",
  boundaries: [
    "两台设备必须同时在线；没有离线投递、收件箱、联系人或同步聊天记录。",
    "历史只存在于当前本地会话，结束会话或刷新页面后消失；服务器从不保存消息正文。",
    "每条消息最多 65,536 个 UTF-8 字节；更大的内容请作为文件发送。",
  ],
  faqHeading: "常见问题",
  faq: [
    {
      q: "Relayium 能读取或恢复我的消息吗？",
      a: "不能。消息内容在两台设备之间端到端加密，Relayium 服务器不保存消息正文或服务端历史。任一端都可复制或留存收到的文本；实时会话结束后，Relayium 没有可恢复的服务器副本。",
    },
    {
      q: "一端用浏览器、另一端用 CLI 可以吗？",
      a: "不可以。浏览器与 CLI 使用不同的传输和配对握手。请使用两台浏览器，或两端都使用 CLI。",
    },
  ],
  ctaText: "在两台在线设备上打开 Relayium，把下一段原本要“发给自己”的内容直接传过去。",
  ctaButton: "立即发送文本",
  relatedHeading: "继续阅读",
});

const ja = article({
  title: "端末間でテキスト、リンク、コマンドを送る",
  description:
    "Relayium でテキスト、リンク、コマンド、複数行コードを端末間転送。エンドツーエンド暗号化かつ同時オンライン限定で、Relayium サーバーはメッセージ本文やサーバー側履歴を保存しませんが、各端末は受信テキストを保持できます。",
  updatedLabel: "最終更新",
  lead: [
    "Relayium はファイルだけでなく、スマートフォンの URL、別の PC で使うコマンド、複数行のコードなど、クリップボード向けの内容も運べます。メッセージはエンドツーエンド暗号化され、Relayium サーバーは本文やサーバー側履歴を保存しませんが、各端末は受信テキストをコピーまたは保持できます。",
    "ブラウザと CLI の両方がテキストに対応しますが、別々の転送方式であり、互いのペアリングコードには参加できません。両端で同じ方式を選んでください。",
  ],
  browserHeading: "ブラウザ：オンライン端末へメッセージを送る",
  browserBody:
    "両方の端末で relayium.com を開きます。同じネットワークなら自動表示され、別ネットワークならクロスネットワーク画面でブラウザ用コードを作り、もう一方のブラウザで参加します。",
  browserSteps: [
    "相手のカードで「メッセージを送信」を選びます。受信側が承認するまで本文も入力欄も表示されません。",
    "両画面の 6 桁の確認コード（SAS）を比べ、入力または貼り付け後に ⌘/Ctrl+Enter で送信します。",
    "セッション中は双方が複数のメッセージを送り、受信メッセージをコピーできます。",
  ],
  cliHeading: "CLI：片方でコードを発行し、もう片方が参加する",
  cliBody: [
    "片方のマシンでコードを付けずに relayium text を実行します。アカウントで 6 文字のコードを発行し、もう一方が実行すべきコマンドをそのまま表示し、相手の参加を待ちます。一時ファイルも、止めるべき別プロセスもありません。",
    "もう一方のマシンではそのコードを指定して relayium text を実行します。対話モードは 1 行を 1 メッセージとして送り、既定で SAS 確認を求めます。複数行や正確な stdin はパイプで 1 メッセージとして送り、端末プロンプトがないため --yes を付けます。",
  ],
  cliNotes: [
    "CLI コードは 30 分有効で CLI 同士専用です。ブラウザと CLI は接続できません。",
    "ログイン済みアカウントが必要なのはコードを発行する側だけです。表示されたコードで参加する側はログイン不要です。",
    "--yes は対話的な SAS 確認を省くため、別の信頼できる手段で確認してください。",
  ],
  boundariesHeading: "テキスト転送の範囲",
  boundariesBody:
    "本文は UTF-8 のプレーンテキストです。空白、タブ、空行、改行を保持し、実行、Markdown 描画、リンク化、プレビューはしません。",
  boundaries: [
    "両端が同時にオンラインである必要があります。オフライン配信、受信箱、連絡先、同期チャット履歴はありません。",
    "履歴は開いているローカルセッションだけにあり、終了や再読み込みで消えます。サーバーは本文を保存しません。",
    "1 メッセージは UTF-8 で 65,536 バイトまで。それ以上はファイルとして送ってください。",
  ],
  faqHeading: "よくある質問",
  faq: [
    { q: "Relayium はメッセージを読んだり復元できますか？", a: "できません。内容は端末間でエンドツーエンド暗号化され、Relayium サーバーは本文やサーバー側履歴を保存しません。各端末は受信テキストを保持できますが、セッション終了後に Relayium から復元できるサーバーコピーはありません。" },
    { q: "片方をブラウザ、片方を CLI にできますか？", a: "できません。転送方式とペアリング方式が異なります。ブラウザ同士、または CLI 同士で使ってください。" },
  ],
  ctaText: "オンラインの 2 台で Relayium を開き、次に自分宛てへ送るはずだった内容を直接移しましょう。",
  ctaButton: "テキストを送る",
  relatedHeading: "関連記事",
});

const ko = article({
  title: "기기 사이에서 텍스트, 링크, 명령 보내기",
  description:
    "Relayium으로 텍스트, 링크, 명령과 여러 줄 코드를 기기 사이에 전송하세요. 종단간 암호화와 동시 온라인 전용이며, Relayium 서버는 메시지 본문이나 서버 측 기록을 저장하지 않지만 각 기기는 받은 텍스트를 보관할 수 있습니다.",
  updatedLabel: "최근 업데이트",
  lead: [
    "Relayium은 파일뿐 아니라 휴대폰의 URL, 다른 컴퓨터에서 쓸 명령, 여러 줄 코드처럼 클립보드에 맞는 내용도 옮깁니다. 메시지는 종단간 암호화되며 Relayium 서버는 본문이나 서버 측 기록을 저장하지 않지만, 각 기기는 받은 텍스트를 복사하거나 보관할 수 있습니다.",
    "브라우저와 CLI 모두 텍스트를 지원하지만 서로 다른 전송 방식이므로 상대 방식의 페어링 코드에 참여할 수 없습니다. 양쪽에서 같은 방식을 사용하세요.",
  ],
  browserHeading: "브라우저: 온라인 기기에 메시지 보내기",
  browserBody:
    "두 기기에서 relayium.com을 엽니다. 같은 네트워크에서는 자동으로 나타나고, 다른 네트워크에서는 교차 네트워크 페이지에서 브라우저 코드를 만든 뒤 다른 브라우저가 참여합니다.",
  browserSteps: [
    "상대 카드에서 “메시지 보내기”를 선택합니다. 수신자가 수락하기 전에는 본문이나 작성기가 나타나지 않습니다.",
    "두 화면의 6자리 확인 코드(SAS)를 비교한 뒤 입력하거나 붙여 넣고 ⌘/Ctrl+Enter로 보냅니다.",
    "세션이 열린 동안 양쪽에서 여러 메시지를 보내고 받은 메시지를 복사할 수 있습니다.",
  ],
  cliHeading: "CLI: 한쪽에서 코드를 발급하고 다른 쪽이 참여",
  cliBody: [
    "한쪽 컴퓨터에서 코드 없이 relayium text를 실행합니다. 계정으로 6자리 코드를 발급하고, 다른 쪽이 실행할 명령을 그대로 출력한 뒤 상대가 참여할 때까지 세션에서 기다립니다. 임시 파일도, 따로 중지할 프로세스도 없습니다.",
    "다른 쪽 컴퓨터에서 그 코드로 relayium text를 실행합니다. 대화형 모드는 한 줄을 한 메시지로 보내고 기본적으로 SAS 확인을 요구합니다. 여러 줄 또는 정확한 stdin은 파이프로 한 메시지로 보내며 터미널 확인이 없으므로 --yes를 붙입니다.",
  ],
  cliNotes: [
    "CLI 코드는 30분 동안 유효하고 CLI끼리만 연결합니다. 브라우저와 CLI는 서로 연결되지 않습니다.",
    "로그인 계정은 코드를 발급하는 쪽에만 필요합니다. 출력된 코드로 참여하는 쪽은 로그인할 필요가 없습니다.",
    "--yes는 대화형 SAS 확인을 건너뛰므로 다른 신뢰할 수 있는 방법으로 세션을 확인하세요.",
  ],
  boundariesHeading: "텍스트 전송의 범위",
  boundariesBody:
    "본문은 UTF-8 일반 텍스트입니다. 공백, 탭, 빈 줄과 줄바꿈을 보존하며 실행, Markdown 렌더링, 링크 변환, 미리보기를 하지 않습니다.",
  boundaries: [
    "두 기기가 동시에 온라인이어야 합니다. 오프라인 전달, 받은편지함, 연락처, 동기화된 채팅 기록은 없습니다.",
    "기록은 열린 로컬 세션에만 있고 종료하거나 새로고침하면 사라집니다. 서버는 본문을 저장하지 않습니다.",
    "메시지 하나는 UTF-8 65,536바이트까지입니다. 더 크면 파일로 보내세요.",
  ],
  faqHeading: "자주 묻는 질문",
  faq: [
    { q: "Relayium이 메시지를 읽거나 복구할 수 있나요?", a: "아니요. 내용은 기기 사이에서 종단간 암호화되고 Relayium 서버는 본문이나 서버 측 기록을 저장하지 않습니다. 각 기기는 받은 텍스트를 보관할 수 있지만, 세션이 끝나면 Relayium에서 복구할 서버 사본은 없습니다." },
    { q: "한쪽은 브라우저, 다른 쪽은 CLI를 쓸 수 있나요?", a: "아니요. 전송과 페어링 방식이 다릅니다. 브라우저 두 개 또는 CLI 두 개를 사용하세요." },
  ],
  ctaText: "온라인 기기 두 대에서 Relayium을 열고 다음에 자신에게 보낼 내용을 바로 옮겨 보세요.",
  ctaButton: "텍스트 보내기",
  relatedHeading: "더 읽기",
});

const de = article({
  title: "Text, Links und Befehle zwischen Geräten senden",
  description:
    "Mit Relayium Text, Links, Befehle und mehrzeiligen Code zwischen Geräten übertragen — Ende-zu-Ende-verschlüsselt und nur online; Relayium-Server speichern weder Nachrichteninhalte noch serverseitigen Verlauf, beide Endpunkte können empfangenen Text jedoch aufbewahren.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Relayium überträgt neben Dateien auch Inhalte für die Zwischenablage: eine URL vom Handy, einen Befehl für einen anderen Rechner oder mehrzeiligen Code. Nachrichten sind Ende-zu-Ende-verschlüsselt; Relayium-Server speichern weder Inhalte noch serverseitigen Verlauf, aber beide Endpunkte können empfangenen Text kopieren oder aufbewahren.",
    "Browser und CLI unterstützen beide Text, verwenden aber getrennte Transportwege und können den Kopplungscode der jeweils anderen Seite nicht nutzen. Verwende an beiden Enden dieselbe Variante.",
  ],
  browserHeading: "Browser: Nachricht an ein Online-Gerät senden",
  browserBody:
    "Öffne relayium.com auf beiden Geräten. Im selben Netz erscheinen sie automatisch; über verschiedene Netze erzeugst du auf der Cross-Network-Seite einen Browser-Code und trittst im zweiten Browser bei.",
  browserSteps: [
    "Wähle auf der Gerätekarte „Nachricht senden“. Vor der Annahme sieht der Empfänger weder Inhalt noch Eingabefeld.",
    "Vergleiche den sechsstelligen Prüfcode (SAS) auf beiden Bildschirmen, füge Text ein und sende mit ⌘/Strg+Enter.",
    "Solange die Sitzung offen ist, können beide Seiten mehrere Nachrichten senden und empfangene Inhalte kopieren.",
  ],
  cliHeading: "CLI: auf einem Rechner einen Code erzeugen, auf dem anderen beitreten",
  cliBody: [
    "Starte auf einem Rechner relayium text ohne Code. Der Befehl erzeugt mit deinem Konto einen sechsstelligen Code, gibt genau den Befehl aus, den der andere Rechner ausführen soll, und wartet in der Sitzung auf ihn. Keine temporäre Datei, kein zusätzlicher Prozess, der beendet werden müsste.",
    "Starte auf dem anderen Rechner relayium text mit diesem Code. Interaktiv ist jede Zeile eine Nachricht und beide Seiten bestätigen standardmäßig den SAS. Mehrzeilige oder bytegenaue Eingabe wird als eine Nachricht gepiped und braucht --yes, weil kein Terminal für die Bestätigung vorhanden ist.",
  ],
  cliNotes: [
    "CLI-Codes gelten fünf Minuten und verbinden nur CLI mit CLI; Browser und CLI sind nicht interoperabel.",
    "Nur der Rechner, der den Code erzeugt, braucht ein angemeldetes Konto. Der Rechner, der dem ausgegebenen Code beitritt, muss sich nicht anmelden.",
    "--yes überspringt die interaktive SAS-Bestätigung; prüfe die Sitzung vorher auf einem anderen vertrauenswürdigen Weg.",
  ],
  boundariesHeading: "Was Textübertragung ist — und was nicht",
  boundariesBody:
    "Der Inhalt bleibt UTF-8-Klartext mit Leerzeichen, Tabs, Leerzeilen und Zeilenumbrüchen. Relayium führt nichts aus, rendert kein Markdown, verlinkt nichts und erstellt keine Vorschau.",
  boundaries: [
    "Beide Geräte müssen gleichzeitig online sein. Es gibt keine Offline-Zustellung, Inbox, Kontakte oder synchronisierte Chat-Historie.",
    "Der Verlauf lebt nur lokal in der offenen Sitzung und verschwindet beim Ende oder Neuladen. Der Server speichert keine Nachrichtentexte.",
    "Eine Nachricht darf höchstens 65.536 UTF-8-Bytes groß sein. Größere Inhalte sendest du als Datei.",
  ],
  faqHeading: "Häufige Fragen",
  faq: [
    { q: "Kann Relayium meine Nachrichten lesen oder wiederherstellen?", a: "Nein. Der Inhalt ist zwischen den Geräten Ende-zu-Ende-verschlüsselt, und Relayium-Server speichern weder Nachrichteninhalte noch serverseitigen Verlauf. Beide Endpunkte können empfangenen Text aufbewahren; nach Sitzungsende hat Relayium keine Serverkopie zur Wiederherstellung." },
    { q: "Kann eine Seite den Browser und die andere die CLI nutzen?", a: "Nein. Transport und Kopplung sind verschieden. Verwende zwei Browser oder zwei CLI-Clients." },
  ],
  ctaText: "Öffne Relayium auf zwei Online-Geräten und übertrage den nächsten Inhalt direkt statt ihn dir selbst zu schicken.",
  ctaButton: "Jetzt Text senden",
  relatedHeading: "Weiterlesen",
});

const fr = article({
  title: "Envoyer du texte, des liens et des commandes entre appareils",
  description:
    "Transférez texte, liens, commandes et code multiligne avec Relayium — chiffré de bout en bout et uniquement en ligne ; les serveurs Relayium ne gardent ni corps de message ni historique côté serveur, mais chaque extrémité peut conserver le texte reçu.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Relayium transporte aussi le contenu du presse-papiers : une URL du téléphone, une commande pour un autre ordinateur ou un bloc de code multiligne. Les messages sont chiffrés de bout en bout ; les serveurs Relayium ne gardent ni corps de message ni historique côté serveur, mais chaque extrémité peut copier ou conserver le texte reçu.",
    "Le navigateur et la CLI prennent en charge le texte, mais utilisent des transports séparés et ne peuvent pas rejoindre leurs codes respectifs. Utilisez la même méthode aux deux extrémités.",
  ],
  browserHeading: "Navigateur : envoyer un message à un appareil en ligne",
  browserBody:
    "Ouvrez relayium.com sur les deux appareils. Sur le même réseau ils apparaissent automatiquement ; sinon créez un code navigateur sur la page interréseau et rejoignez-le dans l'autre navigateur.",
  browserSteps: [
    "Choisissez « Envoyer un message » sur la carte du pair. Avant acceptation, le destinataire ne voit ni contenu ni zone de saisie.",
    "Comparez le code de vérification à six chiffres (SAS), saisissez ou collez le texte, puis envoyez avec ⌘/Ctrl+Entrée.",
    "Tant que la session reste ouverte, chaque côté peut envoyer plusieurs messages et copier ceux qu'il reçoit.",
  ],
  cliHeading: "CLI : créer un code sur une machine, le rejoindre sur l'autre",
  cliBody: [
    "Lancez relayium text sans code sur une machine. La commande crée un code à six caractères avec votre compte, affiche exactement la commande que l'autre machine doit exécuter, et reste dans la session à l'attendre. Aucun fichier temporaire, aucun processus supplémentaire à arrêter.",
    "Lancez ensuite relayium text avec ce code sur l'autre machine. En mode interactif, chaque ligne est un message et le SAS doit être confirmé. Pour du texte multiligne ou exact, utilisez un pipe en un seul message avec --yes, car aucun terminal ne peut afficher la confirmation.",
  ],
  cliNotes: [
    "Les codes CLI durent cinq minutes et relient uniquement deux CLI ; navigateur et CLI ne sont pas interopérables.",
    "Seule la machine qui crée le code exige un compte connecté. Celle qui rejoint le code affiché n'a pas besoin de se connecter.",
    "--yes ignore la confirmation interactive du SAS ; vérifiez la session par un autre moyen fiable.",
  ],
  boundariesHeading: "Ce que le transfert de texte est — et n'est pas",
  boundariesBody:
    "Le contenu reste du texte brut UTF-8, avec espaces, tabulations, lignes vides et retours à la ligne. Relayium ne l'exécute pas, ne rend pas le Markdown, ne crée ni lien ni aperçu.",
  boundaries: [
    "Les deux appareils doivent être en ligne ensemble. Pas de livraison hors ligne, boîte de réception, contacts ou historique synchronisé.",
    "L'historique est local à la session ouverte et disparaît à sa fermeture ou au rechargement. Le serveur ne stocke aucun corps de message.",
    "Un message est limité à 65 536 octets UTF-8. Envoyez les contenus plus grands sous forme de fichier.",
  ],
  faqHeading: "Questions fréquentes",
  faq: [
    { q: "Relayium peut-il lire ou récupérer mes messages ?", a: "Non. Le contenu est chiffré de bout en bout entre les appareils, et les serveurs Relayium ne gardent ni corps de message ni historique côté serveur. Chaque extrémité peut conserver le texte reçu ; après la session, Relayium n'a aucune copie serveur à récupérer." },
    { q: "Puis-je utiliser le navigateur d'un côté et la CLI de l'autre ?", a: "Non. Les transports et associations diffèrent. Utilisez deux navigateurs ou deux clients CLI." },
  ],
  ctaText: "Ouvrez Relayium sur deux appareils en ligne et transférez directement ce que vous vous seriez envoyé à vous-même.",
  ctaButton: "Envoyer du texte",
  relatedHeading: "Continuer la lecture",
});

const ar = article({
  title: "إرسال النصوص والروابط والأوامر بين الأجهزة",
  description:
    "انقل النصوص والروابط والأوامر والشيفرة متعددة الأسطر عبر Relayium — بتشفير من الطرف إلى الطرف وأثناء اتصال الجهازين فقط؛ لا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم، لكن يمكن لأي طرف الاحتفاظ بالنص المستلم.",
  updatedLabel: "آخر تحديث",
  lead: [
    "ينقل Relayium محتوى الحافظة إلى جانب الملفات: رابطًا من الهاتف، أو أمرًا لجهاز آخر، أو شيفرة متعددة الأسطر. الرسائل مشفّرة من الطرف إلى الطرف؛ لا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم، لكن يمكن لأي طرف نسخ النص المستلم أو الاحتفاظ به.",
    "يدعم المتصفح وسطر الأوامر النصوص، لكنهما وسيلتا نقل منفصلتان ولا يمكن لإحداهما الانضمام برمز الأخرى. استخدم الوسيلة نفسها في الطرفين.",
  ],
  browserHeading: "المتصفح: إرسال رسالة إلى جهاز متصل",
  browserBody:
    "افتح relayium.com على الجهازين. تظهر الأجهزة على الشبكة نفسها تلقائيًا؛ وعبر شبكتين أنشئ رمز متصفح من صفحة النقل بين الشبكات وانضم إليه من المتصفح الآخر.",
  browserSteps: [
    "اختر «إرسال رسالة» من بطاقة الطرف الآخر. لا يظهر النص أو مربع الكتابة للمستلم قبل أن يقبل.",
    "قارن رمز التحقق ذي الأرقام الستة (SAS) على الشاشتين، ثم اكتب أو الصق وأرسل باستخدام ⌘/Ctrl+Enter.",
    "ما دامت الجلسة مفتوحة يستطيع الطرفان إرسال عدة رسائل ونسخ أي رسالة مستلمة.",
  ],
  cliHeading: "سطر الأوامر: أصدر الرمز على جهاز وانضم إليه من الآخر",
  cliBody: [
    "شغّل relayium text بلا رمز على أحد الجهازين. سيصدر رمزًا من ستة محارف باستخدام حسابك، ويطبع الأمر الذي يشغّله الجهاز الآخر تمامًا، ثم يبقى في الجلسة بانتظاره. لا ملف مؤقت ولا عملية إضافية يجب إيقافها.",
    "شغّل relayium text بذلك الرمز على الجهاز الآخر. في الوضع التفاعلي كل سطر رسالة ويُطلب تأكيد SAS افتراضيًا. أرسل النص متعدد الأسطر أو الدقيق عبر pipe كرسالة واحدة مع --yes لأن الطرفية غير متاحة للتأكيد.",
  ],
  cliNotes: [
    "رمز CLI صالح لثلاثين دقيقة ويربط CLI بـ CLI فقط؛ لا يتوافق المتصفح مع CLI.",
    "الجهاز الذي يصدر الرمز وحده يحتاج حسابًا مسجل الدخول؛ أما الجهاز الذي ينضم بالرمز المطبوع فلا يحتاج إلى تسجيل الدخول.",
    "--yes يتجاوز تأكيد SAS التفاعلي؛ تحقق من الجلسة بوسيلة موثوقة أخرى.",
  ],
  boundariesHeading: "حدود نقل النصوص",
  boundariesBody:
    "يظل المحتوى نص UTF-8 عاديًا مع المسافات وعلامات الجدولة والأسطر الفارغة وفواصل الأسطر. لا ينفذه Relayium ولا يعرض Markdown ولا يحوله إلى روابط أو معاينات.",
  boundaries: [
    "يجب أن يكون الجهازان متصلين معًا. لا يوجد تسليم دون اتصال أو صندوق وارد أو جهات اتصال أو سجل محادثة متزامن.",
    "السجل محلي للجلسة المفتوحة ويختفي عند انتهائها أو تحديث الصفحة. لا يخزن الخادم نص الرسالة.",
    "الحد الأقصى للرسالة 65,536 بايت UTF-8. أرسل المحتوى الأكبر كملف.",
  ],
  faqHeading: "الأسئلة الشائعة",
  faq: [
    { q: "هل يستطيع Relayium قراءة رسائلي أو استعادتها؟", a: "لا. المحتوى مشفّر بين الجهازين، ولا تحتفظ خوادم Relayium بمتون الرسائل أو سجل على الخادم. يمكن لأي طرف الاحتفاظ بالنص المستلم، لكن بعد انتهاء الجلسة لا تملك Relayium نسخة خادم لاستعادتها." },
    { q: "هل يمكن استخدام المتصفح في طرف وCLI في الآخر؟", a: "لا. النقل والاقتران مختلفان. استخدم متصفحين أو عميلَي CLI." },
  ],
  ctaText: "افتح Relayium على جهازين متصلين وانقل مباشرة ما كنت سترسله إلى نفسك.",
  ctaButton: "إرسال نص الآن",
  relatedHeading: "تابع القراءة",
});

const es = article({
  title: "Enviar texto, enlaces y comandos entre dispositivos",
  description:
    "Transfiere texto, enlaces, comandos y código multilínea con Relayium: cifrado de extremo a extremo y solo mientras ambos están en línea; los servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor, pero cualquiera de los extremos puede conservar el texto recibido.",
  updatedLabel: "Última actualización",
  lead: [
    "Relayium también mueve contenido de portapapeles: una URL del teléfono, un comando para otro ordenador o código multilínea. Los mensajes están cifrados de extremo a extremo; los servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor, pero cualquiera de los extremos puede copiar o conservar el texto recibido.",
    "El navegador y la CLI admiten texto, pero usan transportes separados y no pueden unirse con el código del otro. Usa el mismo método en ambos extremos.",
  ],
  browserHeading: "Navegador: enviar un mensaje a un dispositivo en línea",
  browserBody:
    "Abre relayium.com en ambos dispositivos. En la misma red aparecen automáticamente; en redes distintas crea un código de navegador en la página entre redes y únete desde el otro navegador.",
  browserSteps: [
    "Elige «Enviar un mensaje» en la tarjeta del par. Antes de aceptar, el destinatario no ve contenido ni editor.",
    "Compara el código de verificación de seis dígitos (SAS), escribe o pega y envía con ⌘/Ctrl+Enter.",
    "Mientras la sesión siga abierta, ambos lados pueden enviar varios mensajes y copiar cualquiera que reciban.",
  ],
  cliHeading: "CLI: emite el código en un equipo y únete desde el otro",
  cliBody: [
    "Ejecuta relayium text sin código en un equipo. Emite un código de seis caracteres con tu cuenta, imprime exactamente el comando que debe ejecutar el otro equipo y se queda en la sesión esperándolo. Sin archivo temporal y sin ningún proceso extra que detener.",
    "Después ejecuta relayium text con ese código en el otro equipo. El modo interactivo envía una línea por mensaje y pide confirmar el SAS. Para texto multilínea o exacto, usa una tubería como un solo mensaje con --yes, porque no hay terminal para confirmar.",
  ],
  cliNotes: [
    "Los códigos CLI duran cinco minutos y solo conectan CLI con CLI; navegador y CLI no son interoperables.",
    "Solo el equipo que emite el código exige una cuenta conectada. El equipo que se une con el código impreso no necesita iniciar sesión.",
    "--yes omite la confirmación interactiva del SAS; verifica la sesión por otro medio fiable.",
  ],
  boundariesHeading: "Qué es —y qué no es— la transferencia de texto",
  boundariesBody:
    "El contenido sigue siendo texto plano UTF-8, incluidos espacios, tabulaciones, líneas vacías y saltos. Relayium no lo ejecuta, no muestra Markdown, no enlaza ni crea vistas previas.",
  boundaries: [
    "Ambos dispositivos deben estar en línea a la vez. No hay entrega sin conexión, bandeja de entrada, contactos ni historial sincronizado.",
    "El historial es local a la sesión abierta y desaparece al terminar o recargar. El servidor nunca almacena el cuerpo.",
    "Cada mensaje admite hasta 65.536 bytes UTF-8. Envía el contenido mayor como archivo.",
  ],
  faqHeading: "Preguntas frecuentes",
  faq: [
    { q: "¿Puede Relayium leer o recuperar mis mensajes?", a: "No. El contenido está cifrado entre los dispositivos, y los servidores de Relayium no guardan cuerpos de mensajes ni historial del servidor. Cualquiera de los extremos puede conservar el texto recibido; al terminar la sesión Relayium no tiene una copia de servidor que recuperar." },
    { q: "¿Puedo usar navegador en un extremo y CLI en el otro?", a: "No. El transporte y el emparejamiento son distintos. Usa dos navegadores o dos clientes CLI." },
  ],
  ctaText: "Abre Relayium en dos dispositivos en línea y mueve directamente lo próximo que te enviarías a ti mismo.",
  ctaButton: "Enviar texto ahora",
  relatedHeading: "Sigue leyendo",
});

const pt = article({
  title: "Enviar texto, links e comandos entre dispositivos",
  description:
    "Transfira texto, links, comandos e código multilinha com o Relayium — criptografado de ponta a ponta e apenas online; os servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor, mas qualquer ponta pode conservar o texto recebido.",
  updatedLabel: "Última atualização",
  lead: [
    "O Relayium também move conteúdo de área de transferência: uma URL do celular, um comando para outro computador ou código multilinha. As mensagens são criptografadas de ponta a ponta; os servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor, mas qualquer ponta pode copiar ou conservar o texto recebido.",
    "O navegador e a CLI aceitam texto, mas usam transportes separados e não entram com o código um do outro. Use o mesmo método nas duas pontas.",
  ],
  browserHeading: "Navegador: enviar mensagem a um dispositivo online",
  browserBody:
    "Abra relayium.com nos dois dispositivos. Na mesma rede eles aparecem automaticamente; em redes diferentes crie um código de navegador na página entre redes e entre pelo outro navegador.",
  browserSteps: [
    "Escolha “Enviar uma mensagem” no cartão do par. Antes de aceitar, o destinatário não vê conteúdo nem editor.",
    "Compare o código de verificação de seis dígitos (SAS), digite ou cole e envie com ⌘/Ctrl+Enter.",
    "Enquanto a sessão estiver aberta, os dois lados podem enviar várias mensagens e copiar qualquer mensagem recebida.",
  ],
  cliHeading: "CLI: emita o código em uma máquina e entre pela outra",
  cliBody: [
    "Execute relayium text sem código em uma das máquinas. Ele emite um código de seis caracteres com a sua conta, imprime exatamente o comando que a outra máquina deve executar e permanece na sessão esperando por ela. Sem arquivo temporário e sem nenhum processo extra para parar.",
    "Depois execute relayium text com esse código na outra máquina. O modo interativo envia uma linha por mensagem e pede confirmação do SAS. Para texto multilinha ou exato, use um pipe como uma mensagem com --yes, pois não há terminal para confirmar.",
  ],
  cliNotes: [
    "Códigos CLI duram cinco minutos e conectam apenas CLI com CLI; navegador e CLI não são interoperáveis.",
    "Somente a máquina que emite o código exige uma conta conectada. A máquina que entra com o código impresso não precisa fazer login.",
    "--yes pula a confirmação interativa do SAS; verifique a sessão por outro meio confiável.",
  ],
  boundariesHeading: "O que a transferência de texto é — e não é",
  boundariesBody:
    "O conteúdo permanece texto simples UTF-8, com espaços, tabulações, linhas vazias e quebras. O Relayium não executa, renderiza Markdown, cria links nem prévias.",
  boundaries: [
    "Os dois dispositivos precisam estar online juntos. Não há entrega offline, caixa de entrada, contatos ou histórico sincronizado.",
    "O histórico é local à sessão aberta e desaparece ao terminar ou recarregar. O servidor nunca armazena o corpo.",
    "Cada mensagem aceita até 65.536 bytes UTF-8. Envie conteúdo maior como arquivo.",
  ],
  faqHeading: "Perguntas frequentes",
  faq: [
    { q: "O Relayium pode ler ou recuperar minhas mensagens?", a: "Não. O conteúdo é criptografado entre os dispositivos, e os servidores do Relayium não guardam o corpo das mensagens nem histórico no servidor. Qualquer ponta pode conservar o texto recebido; ao terminar a sessão o Relayium não tem uma cópia no servidor para recuperar." },
    { q: "Posso usar navegador em uma ponta e CLI na outra?", a: "Não. Transporte e pareamento são diferentes. Use dois navegadores ou dois clientes CLI." },
  ],
  ctaText: "Abra o Relayium em dois dispositivos online e mova diretamente o próximo conteúdo que enviaria a si mesmo.",
  ctaButton: "Enviar texto agora",
  relatedHeading: "Continue lendo",
});

export default {
  slug: "how-to/send-text-between-devices",
  published: "2026-07-30",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
