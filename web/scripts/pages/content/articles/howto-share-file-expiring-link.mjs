// web/scripts/pages/content/articles/howto-share-file-expiring-link.mjs
// How-to: create a stored, expiring download link (async mode) when the recipient
// is not online at the same time. English is the master; zh/ja/ko/de/fr follow the
// same structure with identical facts. Terminology mirrors store-crypto.ts,
// StoredUpload.svelte, OfflinePage.svelte and DownloadPage.svelte.

const en = {
  title: "Share a file with a secure, expiring download link",
  description:
    "Encrypt a file in your browser and get a link the server can't decrypt. Choose 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or burn after the first download, then send it whenever you're ready.",
  updatedLabel: "Last updated",
  lead: [
    "Not every transfer has someone waiting on the other end. Maybe the recipient is asleep, on a flight, or you just want to drop a link in a message and move on with your day. For that, Relayium has a second mode: instead of streaming a file live to another open browser, it encrypts the file where you are, uploads only the ciphertext, and hands you a link you can send whenever — the download happens on the recipient's own schedule.",
    "This guide walks through creating one of these links, the expiry and burn-after-read options, and exactly what the zero-knowledge design means in practice — including the honest limits: creating a link needs the sender to sign in, and links count against a storage quota.",
  ],
  sections: [
    {
      heading: "Stored links vs. realtime: when to use which",
      body: [
        "Relayium's realtime mode streams a file directly between two open browser tabs — fast, and nothing is stored anywhere, but both people need to be online together. A stored, expiring link flips that trade-off: your browser does the encryption and uploads the result once, and the recipient can open the link minutes, hours, or days later, on their own time.",
        "Use a stored link when you don't know exactly when the other person will be free, when you're sending the same file to more than one person, or when you just want something you can paste into an email or chat and be done with it.",
      ],
    },
    {
      heading: "How to create a link",
      body: ["Creating a link takes a few steps, all in the browser:"],
      bullets: [
        "Open relayium.com and switch to the link/offline mode.",
        "Sign in — only the sender needs an account; the recipient never will.",
        "Choose one or more files.",
        "Optionally set an expiry window, or turn on burn-after-read.",
        "Wait while the browser encrypts, then uploads, the files — a progress bar shows both phases.",
        "Copy the link (or scan the QR code) and send it however you like.",
      ],
    },
    {
      heading: "Expiry and burn-after-read",
      body: [
        "Every link needs a lifetime — leaving one live forever isn't the point of a one-off transfer. When you create a link you pick how long it should stay valid, or you can set it to disappear as soon as it's been used once.",
        "Burn-after-read means the link stops working the moment the recipient finishes downloading — useful when the file is sensitive and you want exactly one person, one time, with nothing left dangling afterward. Either way, the recipient sees a live countdown on the download page, so they know how much time (or how many downloads) is left.",
      ],
      bullets: [
        "1 hour",
        "1 day (the default)",
        "3 days",
        "7 days",
        "14 days (the maximum, on the top plan)",
        "Or: burn after the first complete download, instead of a fixed time",
      ],
    },
    {
      heading: "The zero-knowledge guarantee, and its limits",
      body: [
        "Here's what actually happens when you create a link. Your browser generates a random AES-256-GCM key — a different mechanism from Relayium's realtime mode, which negotiates a key between two devices with X25519; a stored link's key is generated locally, with nothing to negotiate. That key encrypts your files and the list of filenames before anything leaves your device, and it's appended to the download link after a `#` — a part of the URL that browsers never send to any server. The server stores the ciphertext it's given, and only the ciphertext; it has no way to decrypt it, because it never receives the key.",
        "That design has real trade-offs worth knowing. The link itself is the only copy of the key, so if you lose it, there's no password reset — the data on the server becomes permanently unreadable. Creating a link requires the sender to be signed in, and every link counts against your account's storage quota until it's deleted or expires. And it's worth being precise about what \"zero-knowledge\" means here: the ciphertext is genuinely stored on Relayium's server between creation and download — it's just unreadable without the key that never left your browser.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the person I send the link to need an account?",
        a: "No. Anyone with the full link — including the part after the `#` — can open it and download the files. Only the sender needs to sign in to create the link in the first place.",
      },
      {
        q: "Can Relayium read my file?",
        a: "No. Your browser encrypts the files with a random AES-256-GCM key before anything is uploaded, and that key lives only in the URL fragment, which never reaches the server. The server stores ciphertext it has no way to decrypt — a zero-knowledge design.",
      },
      {
        q: "How long do links last?",
        a: "You choose when you create the link: 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or you can set it to burn after the first complete download instead of a fixed expiry. After that point the link stops working.",
      },
      {
        q: "Is the file really gone after burn-after-read?",
        a: "Burn-after-read is designed for exactly one download: once the recipient finishes downloading the file, the link stops working for anyone who opens it afterward, so it can't quietly be viewed a second time.",
      },
    ],
  },
  cta: {
    text: "Have a file ready but no one waiting on the other end? Create an expiring link in your browser and send it whenever you're ready.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "用会过期的安全链接分享文件",
  description:
    "在浏览器里加密文件，生成一个连服务器都解不开的链接。可选 1 小时、1 天、3 天、7 天、最长 14 天有效期（上限取决于套餐）,或首次下载后即焚——你准备好了再发。",
  updatedLabel: "最近更新",
  lead: [
    "不是每次传输对面都刚好有人在等。收件人可能在睡觉、在飞机上,或者你只是想把链接丢进聊天窗口就去忙别的事了。为此 Relayium 准备了第二种模式:不是把文件实时流式传给另一个打开的浏览器,而是在你这边先加密,只上传密文,再给你一个随时可以发出去的链接——下载什么时候进行,由收件人自己的时间安排决定。",
    "本文讲解如何创建这样的链接、有效期与「首次下载后即焚」选项,以及零知识设计在实际中到底意味着什么——包括如实说明的限制:创建链接需要发送方登录,链接会占用存储配额。",
  ],
  sections: [
    {
      heading: "存储链接与实时传输:该用哪个",
      body: [
        "Relayium 的实时模式在两个打开的浏览器标签之间直接传输文件——很快,也不在任何地方留存,但双方需要同时在线。存储型的过期链接则反过来:你的浏览器负责加密并把结果上传一次,收件人可以在几分钟、几小时甚至几天后,按自己的时间打开链接。",
        "当你不确定对方什么时候有空、要把同一个文件发给不止一个人、或者只是想复制粘贴进邮件或聊天窗口了事时,就该用存储链接。",
      ],
    },
    {
      heading: "如何创建链接",
      body: ["创建链接只需要在浏览器里走几步:"],
      bullets: [
        "打开 relayium.com,切换到链接/异步模式。",
        "登录——只有发送方需要账号,收件人始终不需要。",
        "选择一个或多个文件。",
        "按需设置有效期,或开启首次下载后即焚。",
        "等浏览器先加密、再上传文件——进度条会分别显示这两个阶段。",
        "复制链接(或扫描二维码),用你喜欢的方式发出去。",
      ],
    },
    {
      heading: "有效期与首次下载后即焚",
      body: [
        "每个链接都需要一个存续期限——让它永久有效违背了一次性传输的初衷。创建链接时你可以选择它要保持有效多久,也可以设置成用过一次就立刻消失。",
        "首次下载后即焚意味着链接会在收件人下载完成的那一刻立即失效——当文件比较敏感、你只想让一个人看一次、事后不留任何尾巴时很有用。无论选哪种,收件人在下载页都能看到实时倒计时,清楚还剩多少时间(或还能不能下载)。",
      ],
      bullets: ["1 小时", "1 天(默认)", "3 天", "7 天", "14 天（上限，需最高档套餐）", "或者:首次完整下载后即焚,而不是固定时长"],
    },
    {
      heading: "零知识保证,以及它的边界",
      body: [
        "创建链接时实际发生的是这样的:你的浏览器会生成一个随机的 AES-256-GCM 密钥——这与 Relayium 实时模式的机制不同,实时模式是通过 X25519 在两台设备之间协商出密钥;而存储链接的密钥是在本地生成的,不需要和任何人协商。这把密钥会在文件离开你的设备之前,把文件本身和文件名列表都加密好,并被附加在下载链接的 `#` 之后——这是浏览器永远不会发送给任何服务器的那部分 URL。服务器只保存它收到的密文,而且只有密文;它没有办法解密,因为它从未拿到过密钥。",
        "这个设计有几个值得了解的真实取舍。链接本身是密钥的唯一副本,如果你弄丢了它,没有找回密码这回事——服务器上的数据会变得永久不可读。创建链接需要发送方处于登录状态,而且每个链接在被删除或过期之前都会占用你账号的存储配额。也有必要说清楚这里「零知识」到底是什么意思:密文确实在创建到下载之间被存放在 Relayium 的服务器上——只是没有那把从未离开过你浏览器的密钥,谁都读不懂它。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "我发链接的对象需要账号吗?",
        a: "不需要。任何拿到完整链接的人——包括 `#` 后面那部分——都能打开并下载文件。只有发送方在创建链接时需要登录。",
      },
      {
        q: "Relayium 能看到我的文件内容吗?",
        a: "不能。你的浏览器会在上传前用一把随机生成的 AES-256-GCM 密钥加密文件,这把密钥只存在于 URL 片段里,永远不会到达服务器。服务器保存的是它无法解密的密文——这是一种零知识设计。",
      },
      {
        q: "链接能保留多久?",
        a: "由你在创建时选择:1 小时、1 天、3 天、7 天或最长 14 天（可选范围取决于套餐）,也可以设置为首次完整下载后即焚,而不是固定时长。到期之后链接就会失效。",
      },
      {
        q: "首次下载后即焚,文件真的会消失吗?",
        a: "首次下载后即焚就是为「只下载一次」设计的:一旦收件人完成下载,之后任何人再打开这个链接都不会再生效,所以它不会被人悄悄再看一次。",
      },
    ],
  },
  cta: {
    text: "文件已经准备好了,但对面暂时没人在等?在浏览器里创建一个会过期的链接,等你准备好了再发。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "期限付きの安全なダウンロードリンクでファイルを共有する",
  description:
    "ブラウザでファイルを暗号化し、サーバーが復号できないリンクを作成。有効期限は1時間・1日・3日・7日・最長14日（プランによる）、または初回ダウンロード後に消去から選べます——準備ができたときに送れます。",
  updatedLabel: "最終更新",
  lead: [
    "すべての転送で、相手が今すぐ待っているとは限りません。受信者が寝ていたり、飛行機の中だったり、あるいはただリンクをメッセージに貼って自分のことに戻りたいだけかもしれません。そのために Relayium にはもう一つのモードがあります。開いている別のブラウザへファイルをその場でストリーミングする代わりに、あなたの手元でファイルを暗号化し、暗号文だけをアップロードして、いつでも送れるリンクを渡します——ダウンロードのタイミングは受信者自身のスケジュール次第です。",
    "本ガイドでは、こうしたリンクの作成方法、有効期限と「初回ダウンロード後に消去」オプション、そしてゼロ知識設計が実際に何を意味するかを説明します。正直な制約も含めて——リンクの作成には送信側のサインインが必要で、リンクはストレージ容量を消費します。",
  ],
  sections: [
    {
      heading: "保存型リンク vs リアルタイム: どちらを使うか",
      body: [
        "Relayium のリアルタイムモードは、開いている2つのブラウザタブの間で直接ファイルを転送します——速く、どこにも保存されませんが、双方が同時にオンラインである必要があります。保存型の期限付きリンクはその逆です。あなたのブラウザが暗号化を行い結果を一度アップロードすれば、受信者は数分後、数時間後、あるいは数日後でも、自分の都合でリンクを開けます。",
        "相手がいつ空くか分からないとき、同じファイルを複数人に送りたいとき、あるいはメールやチャットに貼り付けてそれで終わりにしたいときに、保存型リンクを使ってください。",
      ],
    },
    {
      heading: "リンクの作成方法",
      body: ["リンクの作成は、すべてブラウザ内でいくつかの手順を踏むだけです。"],
      bullets: [
        "relayium.com を開き、リンク/オフラインモードに切り替える。",
        "サインインする——アカウントが必要なのは送信側だけで、受信側は不要。",
        "ファイルを1つ以上選ぶ。",
        "必要なら有効期限を設定するか、初回ダウンロード後に消去をオンにする。",
        "ブラウザが暗号化してからアップロードするのを待つ——進行バーが両方の段階を示す。",
        "リンクをコピー(またはQRコードをスキャン)して、好きな方法で送る。",
      ],
    },
    {
      heading: "有効期限と初回ダウンロード後の消去",
      body: [
        "どのリンクにも寿命が必要です——永久に有効なままにしておくのは、一度きりの受け渡しの趣旨に反します。リンクを作成するとき、どれだけ有効にしておくかを選べますし、一度使われたら即座に消えるよう設定することもできます。",
        "初回ダウンロード後の消去とは、受信者がダウンロードを完了した瞬間にリンクが機能しなくなるということです。ファイルが機微な内容で、一人に一度だけ見せて、その後は何も残したくないときに便利です。どちらを選んでも、受信者はダウンロードページでリアルタイムのカウントダウンを見られるので、残り時間(またはダウンロード回数)がわかります。",
      ],
      bullets: ["1時間", "1日(既定値)", "3日", "7日", "14日（最長。最上位プランのみ）", "または: 固定の期限の代わりに、初回の完全なダウンロード後に消去"],
    },
    {
      heading: "ゼロ知識保証と、その限界",
      body: [
        "リンクを作成するとき実際に起きていることはこうです。あなたのブラウザはランダムな AES-256-GCM 鍵を生成します——これは Relayium のリアルタイムモードとは異なる仕組みで、リアルタイムモードは X25519 で2つの端末間の鍵を協議します。保存リンクの鍵はローカルで生成され、誰とも協議する必要がありません。その鍵は、何かが端末を離れる前にファイル本体とファイル名のリストを暗号化し、ダウンロードリンクの `#` の後に付加されます——ここはブラウザが決してどのサーバーにも送信しない URL の部分です。サーバーは渡された暗号文を、暗号文だけを保存します。鍵を一切受け取らないため、それを復号する方法がありません。",
        "この設計には知っておくべき現実的なトレードオフがあります。リンク自体が鍵の唯一のコピーなので、それを失うとパスワードリセットのようなものは存在せず、サーバー上のデータは永久に読めなくなります。リンクの作成には送信側がサインインしている必要があり、削除または期限切れになるまで各リンクはアカウントのストレージ容量を消費します。そして「ゼロ知識」がここで何を意味するかは正確に言っておく価値があります——暗号文は作成からダウンロードまでの間、実際に Relayium のサーバーに保存されています。ただ、あなたのブラウザを一度も離れなかった鍵がなければ読めない、というだけです。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "リンクを送る相手にアカウントは必要ですか?",
        a: "いいえ。`#` の後の部分を含む完全なリンクを持っている人なら誰でも開いてファイルをダウンロードできます。リンクを作成するときにサインインが必要なのは送信側だけです。",
      },
      {
        q: "Relayium は私のファイルを読めますか?",
        a: "いいえ。あなたのブラウザは、何かをアップロードする前にランダムに生成した AES-256-GCM 鍵でファイルを暗号化し、その鍵は URL フラグメントにしか存在せず、サーバーには決して届きません。サーバーが保存するのは復号する方法のない暗号文だけです——ゼロ知識設計です。",
      },
      {
        q: "リンクはどのくらい持ちますか?",
        a: "リンクを作成するときに選べます: 1時間、1日、3日、7日、最長14日（プランによる）、あるいは固定の期限の代わりに初回の完全なダウンロード後に消去するよう設定できます。その時点を過ぎるとリンクは機能しなくなります。",
      },
      {
        q: "初回ダウンロード後の消去で、ファイルは本当になくなりますか?",
        a: "初回ダウンロード後の消去は、まさに1回きりのダウンロードのために設計されています。受信者がファイルのダウンロードを終えた時点で、それ以降にリンクを開いても機能しなくなるため、こっそり二度目を見られることはありません。",
      },
    ],
  },
  cta: {
    text: "ファイルの準備はできているけれど、相手がまだ待っていない? ブラウザで期限付きリンクを作成して、準備ができたときに送りましょう。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "만료되는 안전한 다운로드 링크로 파일 공유하기",
  description:
    "브라우저에서 파일을 암호화하고 서버가 복호화할 수 없는 링크를 생성하세요. 1시간·1일·3일·7일·최대 14일(요금제에 따라 다름) 만료 또는 첫 다운로드 후 소각 중 선택하고, 준비됐을 때 보내세요.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "모든 전송에서 상대방이 지금 기다리고 있는 것은 아닙니다. 수신자가 자고 있거나 비행기 안이거나, 아니면 그냥 메시지에 링크를 남기고 하던 일로 돌아가고 싶을 수도 있습니다. 이를 위해 Relayium에는 두 번째 모드가 있습니다. 열려 있는 다른 브라우저로 파일을 실시간 스트리밍하는 대신, 당신 쪽에서 파일을 암호화하고 암호문만 업로드한 뒤, 언제든 보낼 수 있는 링크를 건네줍니다——다운로드는 수신자 자신의 일정에 맞춰 이루어집니다.",
    "이 가이드는 이런 링크를 만드는 방법, 만료 및 첫 다운로드 후 소각 옵션, 그리고 영지식 설계가 실제로 무엇을 의미하는지 설명합니다. 솔직한 제약도 함께 다룹니다——링크 생성에는 보내는 쪽의 로그인이 필요하고, 링크는 스토리지 할당량을 차지합니다.",
  ],
  sections: [
    {
      heading: "저장 링크 vs 실시간: 어느 쪽을 써야 할까",
      body: [
        "Relayium의 실시간 모드는 열려 있는 두 브라우저 탭 사이에서 파일을 직접 전송합니다——빠르고 어디에도 저장되지 않지만, 양쪽이 동시에 온라인이어야 합니다. 저장형 만료 링크는 그 반대입니다. 브라우저가 암호화를 수행하고 결과를 한 번 업로드하면, 수신자는 몇 분, 몇 시간, 심지어 며칠 뒤에도 자기 시간에 맞춰 링크를 열 수 있습니다.",
        "상대가 언제 시간이 날지 모를 때, 같은 파일을 여러 사람에게 보낼 때, 아니면 그냥 이메일이나 채팅에 붙여넣고 끝내고 싶을 때 저장 링크를 사용하세요.",
      ],
    },
    {
      heading: "링크 만드는 방법",
      body: ["링크를 만드는 과정은 모두 브라우저 안에서 몇 단계로 이루어집니다."],
      bullets: [
        "relayium.com을 열고 링크/오프라인 모드로 전환합니다.",
        "로그인합니다——계정이 필요한 쪽은 보내는 사람뿐이고, 받는 사람은 필요 없습니다.",
        "파일을 하나 이상 선택합니다.",
        "필요하면 만료 기간을 설정하거나 첫 다운로드 후 소각을 켭니다.",
        "브라우저가 먼저 암호화한 뒤 업로드하는 동안 기다립니다——진행 막대가 두 단계를 각각 보여줍니다.",
        "링크를 복사하거나(또는 QR 코드를 스캔해) 원하는 방식으로 보냅니다.",
      ],
    },
    {
      heading: "만료와 첫 다운로드 후 소각",
      body: [
        "모든 링크에는 수명이 필요합니다——영원히 살아있게 두는 것은 일회성 전송의 취지에 맞지 않습니다. 링크를 만들 때 얼마나 오래 유효할지 고를 수 있고, 한 번 쓰이면 즉시 사라지도록 설정할 수도 있습니다.",
        "첫 다운로드 후 소각은 수신자가 다운로드를 마치는 순간 링크가 작동을 멈춘다는 뜻입니다. 파일이 민감해서 딱 한 사람에게 한 번만 보여주고 이후로는 아무것도 남기고 싶지 않을 때 유용합니다. 어느 쪽을 선택하든 수신자는 다운로드 페이지에서 실시간 카운트다운을 볼 수 있어, 남은 시간(또는 다운로드 가능 여부)을 알 수 있습니다.",
      ],
      bullets: ["1시간", "1일(기본값)", "3일", "7일", "14일(최대, 최상위 요금제)", "또는: 고정된 시간 대신 첫 완전한 다운로드 후 소각"],
    },
    {
      heading: "영지식 보장, 그리고 그 한계",
      body: [
        "링크를 만들 때 실제로 일어나는 일은 이렇습니다. 브라우저가 무작위 AES-256-GCM 키를 생성합니다——이는 Relayium의 실시간 모드와는 다른 방식으로, 실시간 모드는 X25519로 두 기기 사이에 키를 협상합니다. 저장 링크의 키는 로컬에서 생성되며 협상할 상대가 없습니다. 이 키는 무언가가 기기를 떠나기 전에 파일 본문과 파일명 목록을 암호화하고, 다운로드 링크의 `#` 뒤에 붙습니다——브라우저가 어떤 서버로도 절대 보내지 않는 URL 부분입니다. 서버는 전달받은 암호문을, 오직 암호문만 저장합니다. 키를 전혀 받지 않으므로 복호화할 방법이 없습니다.",
        "이 설계에는 알아둘 만한 현실적인 절충점이 있습니다. 링크 자체가 키의 유일한 사본이므로, 이를 잃어버리면 비밀번호 재설정 같은 것은 없습니다——서버에 있는 데이터는 영구히 읽을 수 없게 됩니다. 링크 생성에는 보내는 쪽이 로그인 상태여야 하고, 삭제되거나 만료될 때까지 각 링크는 계정의 스토리지 할당량을 차지합니다. 그리고 여기서 '영지식'이 정확히 무엇을 뜻하는지 분명히 해둘 가치가 있습니다——암호문은 생성부터 다운로드까지 실제로 Relayium 서버에 저장되어 있습니다. 다만 당신의 브라우저를 한 번도 떠난 적 없는 키가 없으면 읽을 수 없을 뿐입니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "링크를 보낼 상대방도 계정이 필요한가요?",
        a: "아니요. `#` 뒤의 부분을 포함한 전체 링크를 가진 사람이라면 누구나 열어서 파일을 다운로드할 수 있습니다. 링크를 만들 때 로그인이 필요한 쪽은 보내는 사람뿐입니다.",
      },
      {
        q: "Relayium이 제 파일을 읽을 수 있나요?",
        a: "아니요. 브라우저는 업로드하기 전에 무작위로 생성한 AES-256-GCM 키로 파일을 암호화하며, 그 키는 URL 프래그먼트에만 존재하고 서버에는 절대 도달하지 않습니다. 서버가 저장하는 것은 복호화할 방법이 없는 암호문뿐입니다——영지식 설계입니다.",
      },
      {
        q: "링크는 얼마나 유지되나요?",
        a: "링크를 만들 때 직접 선택합니다: 1시간, 1일, 3일, 7일, 최대 14일(요금제에 따라 다름), 또는 고정 기간 대신 첫 완전한 다운로드 후 소각으로 설정할 수 있습니다. 그 시점이 지나면 링크는 더 이상 작동하지 않습니다.",
      },
      {
        q: "첫 다운로드 후 소각이면 파일이 정말로 사라지나요?",
        a: "첫 다운로드 후 소각은 정확히 한 번의 다운로드를 위해 설계되었습니다. 수신자가 파일 다운로드를 마치면, 그 이후 링크를 여는 누구에게도 작동하지 않으므로 몰래 두 번째로 볼 수 없습니다.",
      },
    ],
  },
  cta: {
    text: "보낼 파일은 준비됐지만 상대방이 아직 기다리고 있지 않나요? 브라우저에서 만료 링크를 만들고 준비됐을 때 보내세요.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Eine Datei mit einem sicheren, ablaufenden Link teilen",
  description:
    "Verschlüssele eine Datei in deinem Browser und erhalte einen Link, den der Server nicht entschlüsseln kann. Wähle 1 Stunde, 1 Tag, 3, 7 oder bis zu 14 Tage Gültigkeit, je nach Tarif, oder Löschung nach dem ersten Download — sende ihn, wenn du bereit bist.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Nicht bei jeder Übertragung wartet jemand auf der anderen Seite. Vielleicht schläft die empfangende Person, sitzt im Flugzeug, oder du willst einfach einen Link in eine Nachricht fallen lassen und mit deinem Tag weitermachen. Dafür hat Relayium einen zweiten Modus: Statt eine Datei live an einen anderen geöffneten Browser zu streamen, verschlüsselt er die Datei bei dir, lädt nur den Chiffretext hoch und gibt dir einen Link, den du jederzeit versenden kannst — der Download findet nach dem Zeitplan der empfangenden Person statt.",
    "Diese Anleitung zeigt, wie man einen solchen Link erstellt, die Optionen für Ablauf und Löschung nach dem ersten Download, und was das Zero-Knowledge-Design in der Praxis tatsächlich bedeutet — einschließlich der ehrlichen Grenzen: Zum Erstellen eines Links muss sich der Absender anmelden, und Links zählen gegen ein Speicherkontingent.",
  ],
  sections: [
    {
      heading: "Gespeicherte Links vs. Echtzeit: wann was nutzen",
      body: [
        "Relayiums Echtzeitmodus überträgt eine Datei direkt zwischen zwei geöffneten Browser-Tabs — schnell, und nirgendwo gespeichert, aber beide Personen müssen gleichzeitig online sein. Ein gespeicherter, ablaufender Link kehrt diesen Kompromiss um: Dein Browser übernimmt die Verschlüsselung und lädt das Ergebnis einmal hoch, und die empfangende Person kann den Link Minuten, Stunden oder Tage später öffnen, zu ihrer eigenen Zeit.",
        "Nutze einen gespeicherten Link, wenn du nicht genau weißt, wann die andere Person Zeit hat, wenn du dieselbe Datei an mehr als eine Person senden willst, oder wenn du einfach etwas willst, das du in eine E-Mail oder einen Chat einfügen kannst und fertig bist.",
      ],
    },
    {
      heading: "So erstellst du einen Link",
      body: ["Einen Link zu erstellen dauert ein paar Schritte, alle im Browser:"],
      bullets: [
        "Öffne relayium.com und wechsle in den Link-/Offline-Modus.",
        "Melde dich an — nur der Absender braucht ein Konto, die empfangende Person nie.",
        "Wähle eine oder mehrere Dateien.",
        "Stelle optional ein Ablauffenster ein oder aktiviere Löschung nach dem ersten Download.",
        "Warte, während der Browser die Dateien verschlüsselt und dann hochlädt — ein Fortschrittsbalken zeigt beide Phasen.",
        "Kopiere den Link (oder scanne den QR-Code) und verschicke ihn, wie du willst.",
      ],
    },
    {
      heading: "Ablauf und Löschung nach dem ersten Download",
      body: [
        "Jeder Link braucht eine Lebensdauer — einen für immer aktiv zu lassen, widerspricht dem Sinn einer einmaligen Übertragung. Beim Erstellen eines Links wählst du, wie lange er gültig bleiben soll, oder du stellst ihn so ein, dass er nach der ersten Nutzung sofort verschwindet.",
        "Löschung nach dem ersten Download bedeutet, dass der Link nicht mehr funktioniert, sobald die empfangende Person den Download abgeschlossen hat — nützlich, wenn die Datei sensibel ist und du willst, dass genau eine Person sie genau einmal sieht und danach nichts offen bleibt. In beiden Fällen sieht die empfangende Person auf der Download-Seite einen laufenden Countdown, sodass klar ist, wie viel Zeit (oder wie viele Downloads) noch bleiben.",
      ],
      bullets: [
        "1 Stunde",
        "1 Tag (Standard)",
        "3 Tage",
        "7 Tage",
        "14 Tage (Maximum, nur im höchsten Tarif)",
        "Oder: Löschung nach dem ersten vollständigen Download statt einer festen Frist",
      ],
    },
    {
      heading: "Die Zero-Knowledge-Garantie — und ihre Grenzen",
      body: [
        "So läuft es tatsächlich ab, wenn du einen Link erstellst: Dein Browser erzeugt einen zufälligen AES-256-GCM-Schlüssel — ein anderer Mechanismus als bei Relayiums Echtzeitmodus, der per X25519 einen Schlüssel zwischen zwei Geräten aushandelt; der Schlüssel eines gespeicherten Links wird lokal erzeugt, ohne dass etwas ausgehandelt werden muss. Dieser Schlüssel verschlüsselt deine Dateien und die Liste der Dateinamen, bevor irgendetwas dein Gerät verlässt, und wird nach einem `#` an den Download-Link angehängt — ein Teil der URL, den Browser nie an einen Server senden. Der Server speichert genau den Chiffretext, den er erhält, und nur diesen; er kann ihn nicht entschlüsseln, weil er den Schlüssel niemals bekommt.",
        "Dieses Design hat reale Kompromisse, die man kennen sollte. Der Link selbst ist die einzige Kopie des Schlüssels — verlierst du ihn, gibt es kein Zurücksetzen des Passworts; die Daten auf dem Server werden dauerhaft unlesbar. Zum Erstellen eines Links muss der Absender angemeldet sein, und jeder Link zählt gegen das Speicherkontingent deines Kontos, bis er gelöscht wird oder abläuft. Und es lohnt sich, genau zu sein, was „Zero-Knowledge“ hier bedeutet: Der Chiffretext wird zwischen Erstellung und Download tatsächlich auf Relayiums Server gespeichert — er ist nur unlesbar ohne den Schlüssel, der deinen Browser nie verlassen hat.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Braucht die Person, der ich den Link schicke, ein Konto?",
        a: "Nein. Wer den vollständigen Link hat — einschließlich des Teils nach dem `#` — kann ihn öffnen und die Dateien herunterladen. Nur der Absender muss sich anmelden, um den Link überhaupt zu erstellen.",
      },
      {
        q: "Kann Relayium meine Datei lesen?",
        a: "Nein. Dein Browser verschlüsselt die Dateien mit einem zufällig erzeugten AES-256-GCM-Schlüssel, bevor irgendetwas hochgeladen wird, und dieser Schlüssel existiert nur im URL-Fragment, das den Server nie erreicht. Der Server speichert Chiffretext, den er nicht entschlüsseln kann — ein Zero-Knowledge-Design.",
      },
      {
        q: "Wie lange bleiben Links gültig?",
        a: "Du entscheidest beim Erstellen: 1 Stunde, 1 Tag, 3 Tage, 7 Tage oder bis zu 14 Tage, je nach Tarif, oder du stellst statt einer festen Frist Löschung nach dem ersten vollständigen Download ein. Danach funktioniert der Link nicht mehr.",
      },
      {
        q: "Ist die Datei nach Löschung nach dem ersten Download wirklich weg?",
        a: "Löschung nach dem ersten Download ist genau für einen einzigen Download gedacht: Sobald die empfangende Person den Download abgeschlossen hat, funktioniert der Link für niemanden mehr, der ihn danach öffnet — er kann also nicht heimlich ein zweites Mal angesehen werden.",
      },
    ],
  },
  cta: {
    text: "Datei fertig, aber gerade wartet niemand auf der anderen Seite? Erstelle einen ablaufenden Link im Browser und schick ihn, wenn du bereit bist.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Partager un fichier avec un lien de téléchargement à expiration",
  description:
    "Chiffrez un fichier dans votre navigateur et obtenez un lien que le serveur ne peut pas déchiffrer. Choisissez 1 heure, 1 jour, 3, 7 ou jusqu'à 14 jours selon votre offre, ou l'autodestruction après le premier téléchargement, puis envoyez-le.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Il n'y a pas toujours quelqu'un qui attend de l'autre côté d'un transfert. Le destinataire dort peut-être, est dans l'avion, ou vous voulez simplement déposer un lien dans un message et passer à autre chose. C'est pour cela que Relayium propose un second mode : au lieu de diffuser un fichier en direct vers un autre navigateur ouvert, il chiffre le fichier chez vous, ne téléverse que le texte chiffré, et vous remet un lien que vous pouvez envoyer quand vous voulez — le téléchargement se fait selon le calendrier du destinataire.",
    "Ce guide explique comment créer un tel lien, les options d'expiration et d'autodestruction après le premier téléchargement, et ce que la conception à divulgation nulle signifie concrètement — y compris les limites honnêtes : créer un lien exige que l'expéditeur se connecte, et les liens comptent dans un quota de stockage.",
  ],
  sections: [
    {
      heading: "Lien stocké ou temps réel : lequel choisir",
      body: [
        "Le mode temps réel de Relayium transfère un fichier directement entre deux onglets de navigateur ouverts — rapide, et rien n'est stocké nulle part, mais les deux personnes doivent être en ligne en même temps. Un lien stocké et à expiration inverse ce compromis : votre navigateur se charge du chiffrement et téléverse le résultat une seule fois, et le destinataire peut ouvrir le lien des minutes, des heures ou des jours plus tard, à son propre rythme.",
        "Utilisez un lien stocké quand vous ne savez pas exactement quand l'autre personne sera disponible, quand vous envoyez le même fichier à plusieurs personnes, ou quand vous voulez simplement quelque chose à coller dans un e-mail ou un chat et à oublier ensuite.",
      ],
    },
    {
      heading: "Comment créer un lien",
      body: ["Créer un lien prend quelques étapes, toutes dans le navigateur :"],
      bullets: [
        "Ouvrez relayium.com et passez au mode lien/hors ligne.",
        "Connectez-vous — seul l'expéditeur a besoin d'un compte, jamais le destinataire.",
        "Choisissez un ou plusieurs fichiers.",
        "Réglez éventuellement une durée d'expiration, ou activez l'autodestruction après le premier téléchargement.",
        "Attendez que le navigateur chiffre puis téléverse les fichiers — une barre de progression indique les deux phases.",
        "Copiez le lien (ou scannez le QR code) et envoyez-le comme vous voulez.",
      ],
    },
    {
      heading: "Expiration et autodestruction après le premier téléchargement",
      body: [
        "Chaque lien a besoin d'une durée de vie — en laisser un actif pour toujours va à l'encontre de l'idée d'un transfert ponctuel. En créant un lien, vous choisissez combien de temps il doit rester valide, ou vous pouvez le régler pour qu'il disparaisse dès qu'il a été utilisé une fois.",
        "L'autodestruction après le premier téléchargement signifie que le lien cesse de fonctionner dès que le destinataire a fini de télécharger — utile quand le fichier est sensible et que vous voulez qu'une seule personne le voie une seule fois, sans rien laisser traîner ensuite. Dans les deux cas, le destinataire voit un compte à rebours en direct sur la page de téléchargement, pour savoir combien de temps (ou de téléchargements) il reste.",
      ],
      bullets: [
        "1 heure",
        "1 jour (par défaut)",
        "3 jours",
        "7 jours",
        "14 jours (le maximum, sur l'offre la plus élevée)",
        "Ou : autodestruction après le premier téléchargement complet, au lieu d'une durée fixe",
      ],
    },
    {
      heading: "La garantie à divulgation nulle, et ses limites",
      body: [
        "Voici ce qui se passe réellement quand vous créez un lien. Votre navigateur génère une clé AES-256-GCM aléatoire — ce n'est pas le même mécanisme que le mode temps réel de Relayium, qui négocie une clé entre deux appareils via X25519 ; la clé d'un lien stocké est générée localement, sans rien à négocier. Cette clé chiffre vos fichiers et la liste des noms de fichiers avant que quoi que ce soit ne quitte votre appareil, et elle est ajoutée au lien de téléchargement après un `#` — une partie de l'URL que les navigateurs n'envoient jamais à un serveur. Le serveur stocke le texte chiffré qu'on lui donne, et seulement lui ; il n'a aucun moyen de le déchiffrer, car il ne reçoit jamais la clé.",
        "Cette conception a de vrais compromis à connaître. Le lien lui-même est la seule copie de la clé : si vous le perdez, il n'y a pas de réinitialisation de mot de passe — les données sur le serveur deviennent définitivement illisibles. Créer un lien exige que l'expéditeur soit connecté, et chaque lien compte dans le quota de stockage de votre compte jusqu'à sa suppression ou son expiration. Et il vaut la peine d'être précis sur ce que signifie ici « divulgation nulle » : le texte chiffré est bel et bien stocké sur le serveur de Relayium entre la création et le téléchargement — il est simplement illisible sans la clé qui n'a jamais quitté votre navigateur.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "La personne à qui j'envoie le lien a-t-elle besoin d'un compte ?",
        a: "Non. Quiconque possède le lien complet — y compris la partie après le `#` — peut l'ouvrir et télécharger les fichiers. Seul l'expéditeur doit se connecter pour créer le lien.",
      },
      {
        q: "Relayium peut-il lire mon fichier ?",
        a: "Non. Votre navigateur chiffre les fichiers avec une clé AES-256-GCM générée aléatoirement avant tout téléversement, et cette clé n'existe que dans le fragment de l'URL, qui n'atteint jamais le serveur. Le serveur stocke un texte chiffré qu'il ne peut pas déchiffrer — une conception à divulgation nulle.",
      },
      {
        q: "Combien de temps les liens durent-ils ?",
        a: "Vous choisissez à la création : 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre, ou réglez une autodestruction après le premier téléchargement complet au lieu d'une durée fixe. Passé ce délai, le lien cesse de fonctionner.",
      },
      {
        q: "Le fichier disparaît-il vraiment après l'autodestruction ?",
        a: "L'autodestruction après le premier téléchargement est conçue pour exactement un seul téléchargement : une fois que le destinataire a fini de télécharger le fichier, le lien ne fonctionne plus pour personne qui l'ouvrirait ensuite, donc il ne peut pas être consulté discrètement une seconde fois.",
      },
    ],
  },
  cta: {
    text: "Un fichier prêt mais personne n'attend encore de l'autre côté ? Créez un lien à expiration dans votre navigateur et envoyez-le quand vous êtes prêt.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "مشاركة ملف برابط تنزيل آمن ينتهي صلاحيته",
  description:
    "شفّر ملفاً في متصفحك واحصل على رابط لا يستطيع الخادم فك تشفيره. اختر ساعة واحدة، أو يوماً واحداً، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب خطتك، أو الحذف بعد أول تنزيل، ثم أرسله متى كنت مستعداً.",
  updatedLabel: "آخر تحديث",
  lead: [
    "ليس في كل عملية نقل من ينتظر على الطرف الآخر. ربما يكون المُستقبِل نائماً، أو على متن طائرة، أو تريد ببساطة أن تترك رابطاً في رسالة وتمضي في يومك. لذلك لدى Relayium وضع ثانٍ: بدلاً من بثّ ملف مباشرةً إلى متصفح آخر مفتوح، يشفّر الملف حيث أنت، ويرفع النص المُشفَّر فقط، ويسلّمك رابطاً يمكنك إرساله متى شئت — ويحدث التنزيل وفق جدول المُستقبِل نفسه.",
    "يرشدك هذا الدليل خلال إنشاء أحد هذه الروابط، وخيارات انتهاء الصلاحية والحذف بعد القراءة، وما يعنيه تصميم المعرفة الصفرية بالضبط عملياً — بما في ذلك الحدود الصريحة: إنشاء رابط يتطلب أن يسجّل المُرسِل الدخول، والروابط تُحتسب ضمن حصة تخزين.",
  ],
  sections: [
    {
      heading: "الروابط المُخزَّنة مقابل الوضع الفوري: متى تستخدم كلاً منهما",
      body: [
        "يبث وضع Relayium الفوري ملفاً مباشرةً بين علامتي تبويب متصفح مفتوحتين — سريع، ولا شيء يُخزَّن في أي مكان، لكن يلزم أن يكون كلا الشخصين متصلين معاً. الرابط المُخزَّن المنتهي الصلاحية يقلب هذه المقايضة: يقوم متصفحك بالتشفير ويرفع النتيجة مرة واحدة، ويمكن للمُستقبِل فتح الرابط بعد دقائق أو ساعات أو أيام، في وقته الخاص.",
        "استخدم رابطاً مُخزَّناً عندما لا تعرف بالضبط متى سيكون الطرف الآخر متفرغاً، أو عندما ترسل الملف نفسه إلى أكثر من شخص، أو عندما تريد فقط شيئاً تلصقه في بريد إلكتروني أو محادثة وتنتهي منه.",
      ],
    },
    {
      heading: "كيفية إنشاء رابط",
      body: ["إنشاء رابط يستغرق بضع خطوات، كلها في المتصفح:"],
      bullets: [
        "افتح relayium.com وبدّل إلى وضع الرابط/عدم الاتصال.",
        "سجّل الدخول — المُرسِل وحده يحتاج إلى حساب؛ أما المُستقبِل فلن يحتاجه أبداً.",
        "اختر ملفاً واحداً أو أكثر.",
        "اضبط اختيارياً نافذة انتهاء صلاحية، أو فعّل الحذف بعد القراءة.",
        "انتظر بينما يشفّر المتصفح الملفات ثم يرفعها — يعرض شريط التقدم كلتا المرحلتين.",
        "انسخ الرابط (أو امسح رمز QR ضوئياً) وأرسله كما يحلو لك.",
      ],
    },
    {
      heading: "انتهاء الصلاحية والحذف بعد القراءة",
      body: [
        "كل رابط يحتاج إلى عمر — إبقاء رابط حياً إلى الأبد ليس هو الغرض من نقلة لمرة واحدة. عند إنشاء رابط تختار كم ينبغي أن يبقى صالحاً، أو يمكنك ضبطه ليختفي بمجرد استخدامه مرة واحدة.",
        "الحذف بعد القراءة يعني أن الرابط يتوقف عن العمل في اللحظة التي ينتهي فيها المُستقبِل من التنزيل — مفيد عندما يكون الملف حساساً وتريد شخصاً واحداً بالضبط، مرة واحدة، دون أن يبقى شيء عالقاً بعد ذلك. في كلتا الحالتين، يرى المُستقبِل عداً تنازلياً حياً على صفحة التنزيل، فيعرف كم بقي من الوقت (أو كم بقي من التنزيلات).",
      ],
      bullets: [
        "ساعة واحدة",
        "يوم واحد (الافتراضي)",
        "3 أيام",
        "7 أيام",
        "14 يومًا (الحد الأقصى، في الخطة الأعلى)",
        "أو: الحذف بعد أول تنزيل كامل، بدلاً من وقت ثابت",
      ],
    },
    {
      heading: "ضمان المعرفة الصفرية، وحدوده",
      body: [
        "إليك ما يحدث فعلاً عندما تنشئ رابطاً. يولّد متصفحك مفتاح AES-256-GCM عشوائياً — آلية مختلفة عن وضع Relayium الفوري الذي يتفاوض على مفتاح بين جهازين باستخدام X25519؛ أما مفتاح الرابط المُخزَّن فيُولَّد محلياً، دون شيء للتفاوض عليه. يشفّر ذلك المفتاح ملفاتك وقائمة أسماء الملفات قبل أن يغادر أي شيء جهازك، ويُلحَق برابط التنزيل بعد `#` — وهو جزء من الـ URL لا ترسله المتصفحات أبداً إلى أي خادم. يخزّن الخادم النص المُشفَّر الذي يُعطى له، والنص المُشفَّر وحده؛ ولا سبيل لديه لفك تشفيره، لأنه لا يتلقى المفتاح أبداً.",
        "لهذا التصميم مقايضات حقيقية تستحق المعرفة. الرابط نفسه هو النسخة الوحيدة من المفتاح، فإن فقدته، فلا إعادة تعيين لكلمة مرور — تصبح البيانات على الخادم غير قابلة للقراءة نهائياً. إنشاء رابط يتطلب أن يكون المُرسِل مسجّل الدخول، وكل رابط يُحتسب ضمن حصة تخزين حسابك حتى يُحذف أو تنتهي صلاحيته. ويجدر أن نكون دقيقين بشأن ما تعنيه \"المعرفة الصفرية\" هنا: النص المُشفَّر مخزَّن فعلاً على خادم Relayium بين الإنشاء والتنزيل — لكنه فقط غير قابل للقراءة دون المفتاح الذي لم يغادر متصفحك أبداً.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يحتاج الشخص الذي أرسل إليه الرابط إلى حساب؟",
        a: "لا. أي شخص لديه الرابط الكامل — بما في ذلك الجزء الذي بعد `#` — يمكنه فتحه وتنزيل الملفات. المُرسِل وحده يحتاج إلى تسجيل الدخول لإنشاء الرابط في المقام الأول.",
      },
      {
        q: "هل يستطيع Relayium قراءة ملفي؟",
        a: "لا. يشفّر متصفحك الملفات بمفتاح AES-256-GCM عشوائي قبل أن يُرفع أي شيء، ويوجد ذلك المفتاح فقط في جزء الـ URL (fragment) الذي لا يصل إلى الخادم أبداً. يخزّن الخادم نصاً مُشفَّراً لا سبيل لديه لفك تشفيره — وهو تصميم قائم على المعرفة الصفرية.",
      },
      {
        q: "كم تدوم الروابط؟",
        a: "تختار عند إنشاء الرابط: ساعة واحدة، أو يوماً واحداً، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب خطتك، أو يمكنك ضبطه ليُحذف بعد أول تنزيل كامل بدلاً من انتهاء صلاحية ثابت. بعد تلك النقطة يتوقف الرابط عن العمل.",
      },
      {
        q: "هل يختفي الملف حقاً بعد الحذف بعد القراءة؟",
        a: "الحذف بعد القراءة مصمَّم لتنزيل واحد بالضبط: بمجرد أن ينتهي المُستقبِل من تنزيل الملف، يتوقف الرابط عن العمل لأي شخص يفتحه بعد ذلك، فلا يمكن الاطلاع عليه خلسةً مرة ثانية.",
      },
    ],
  },
  cta: {
    text: "لديك ملف جاهز لكن لا أحد ينتظر على الطرف الآخر؟ أنشئ رابطاً ينتهي صلاحيته في متصفحك وأرسله متى كنت مستعداً.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Compartir un archivo con un enlace de descarga seguro y con caducidad",
  description:
    "Cifra un archivo en tu navegador y obtén un enlace que el servidor no puede descifrar. Elige 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o que se borre tras la primera descarga, y luego envíalo cuando estés listo.",
  updatedLabel: "Última actualización",
  lead: [
    "No en toda transferencia hay alguien esperando del otro lado. Quizás el destinatario está dormido, en un vuelo, o simplemente quieres dejar un enlace en un mensaje y seguir con tu día. Para eso Relayium tiene un segundo modo: en lugar de transmitir un archivo en vivo a otro navegador abierto, cifra el archivo donde estás, sube solo el texto cifrado y te entrega un enlace que puedes enviar cuando quieras — la descarga ocurre según el horario del propio destinatario.",
    "Esta guía recorre la creación de uno de estos enlaces, las opciones de caducidad y de borrado tras la lectura, y qué significa exactamente en la práctica el diseño de conocimiento cero — incluidos los límites honestos: crear un enlace requiere que el remitente inicie sesión, y los enlaces cuentan contra una cuota de almacenamiento.",
  ],
  sections: [
    {
      heading: "Enlaces almacenados vs. tiempo real: cuándo usar cada uno",
      body: [
        "El modo en tiempo real de Relayium transmite un archivo directamente entre dos pestañas de navegador abiertas — rápido, y sin que nada quede almacenado en ninguna parte, pero ambas personas deben estar en línea a la vez. Un enlace almacenado y con caducidad invierte ese compromiso: tu navegador se encarga del cifrado y sube el resultado una sola vez, y el destinatario puede abrir el enlace minutos, horas o días después, a su propio ritmo.",
        "Usa un enlace almacenado cuando no sabes exactamente cuándo estará libre la otra persona, cuando envías el mismo archivo a más de una persona, o cuando simplemente quieres algo que puedas pegar en un correo o chat y olvidarte del asunto.",
      ],
    },
    {
      heading: "Cómo crear un enlace",
      body: ["Crear un enlace lleva unos pocos pasos, todos en el navegador:"],
      bullets: [
        "Abre relayium.com y cambia al modo enlace/sin conexión.",
        "Inicia sesión — solo el remitente necesita una cuenta; el destinatario nunca.",
        "Elige uno o más archivos.",
        "Opcionalmente fija una ventana de caducidad, o activa el borrado tras la lectura.",
        "Espera mientras el navegador cifra y luego sube los archivos — una barra de progreso muestra ambas fases.",
        "Copia el enlace (o escanea el código QR) y envíalo como prefieras.",
      ],
    },
    {
      heading: "Caducidad y borrado tras la lectura",
      body: [
        "Todo enlace necesita una vida útil — dejar uno activo para siempre no es el sentido de una transferencia puntual. Al crear un enlace eliges cuánto tiempo debe seguir siendo válido, o puedes configurarlo para que desaparezca en cuanto se use una vez.",
        "El borrado tras la lectura significa que el enlace deja de funcionar en el momento en que el destinatario termina de descargar — útil cuando el archivo es sensible y quieres exactamente una persona, una vez, sin que quede nada colgando después. En cualquier caso, el destinatario ve una cuenta atrás en vivo en la página de descarga, así que sabe cuánto tiempo (o cuántas descargas) le quedan.",
      ],
      bullets: [
        "1 hora",
        "1 día (el valor por defecto)",
        "3 días",
        "7 días",
        "14 días (el máximo, en el plan superior)",
        "O: borrado tras la primera descarga completa, en lugar de un tiempo fijo",
      ],
    },
    {
      heading: "La garantía de conocimiento cero, y sus límites",
      body: [
        "Esto es lo que realmente ocurre cuando creas un enlace. Tu navegador genera una clave AES-256-GCM aleatoria — un mecanismo distinto del modo en tiempo real de Relayium, que negocia una clave entre dos dispositivos con X25519; la clave de un enlace almacenado se genera localmente, sin nada que negociar. Esa clave cifra tus archivos y la lista de nombres de archivo antes de que nada salga de tu dispositivo, y se añade al enlace de descarga después de un `#` — una parte de la URL que los navegadores nunca envían a ningún servidor. El servidor almacena el texto cifrado que se le da, y solo el texto cifrado; no tiene forma de descifrarlo, porque nunca recibe la clave.",
        "Ese diseño tiene compromisos reales que conviene conocer. El enlace en sí es la única copia de la clave, así que si lo pierdes, no hay restablecimiento de contraseña — los datos en el servidor quedan permanentemente ilegibles. Crear un enlace requiere que el remitente haya iniciado sesión, y cada enlace cuenta contra la cuota de almacenamiento de tu cuenta hasta que se borra o caduca. Y vale la pena ser precisos sobre lo que significa aquí \"conocimiento cero\": el texto cifrado sí se almacena en el servidor de Relayium entre la creación y la descarga — solo que es ilegible sin la clave que nunca salió de tu navegador.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿La persona a la que envío el enlace necesita una cuenta?",
        a: "No. Cualquiera que tenga el enlace completo — incluida la parte después del `#` — puede abrirlo y descargar los archivos. Solo el remitente necesita iniciar sesión para crear el enlace en primer lugar.",
      },
      {
        q: "¿Puede Relayium leer mi archivo?",
        a: "No. Tu navegador cifra los archivos con una clave AES-256-GCM aleatoria antes de subir nada, y esa clave vive solo en el fragmento de la URL, que nunca llega al servidor. El servidor almacena texto cifrado que no tiene forma de descifrar — un diseño de conocimiento cero.",
      },
      {
        q: "¿Cuánto duran los enlaces?",
        a: "Lo eliges al crear el enlace: 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o puedes configurarlo para que se borre tras la primera descarga completa en lugar de una caducidad fija. Pasado ese punto, el enlace deja de funcionar.",
      },
      {
        q: "¿El archivo realmente desaparece tras el borrado por lectura?",
        a: "El borrado tras la lectura está diseñado para exactamente una descarga: una vez que el destinatario termina de descargar el archivo, el enlace deja de funcionar para cualquiera que lo abra después, de modo que no se puede consultar en silencio una segunda vez.",
      },
    ],
  },
  cta: {
    text: "¿Tienes un archivo listo pero nadie esperando del otro lado? Crea un enlace con caducidad en tu navegador y envíalo cuando estés listo.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Compartilhar um arquivo com um link de download seguro e com validade",
  description:
    "Criptografe um arquivo no seu navegador e obtenha um link que o servidor não consegue descriptografar. Escolha 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou que se apague após o primeiro download, e envie quando estiver pronto.",
  updatedLabel: "Última atualização",
  lead: [
    "Nem toda transferência tem alguém esperando do outro lado. Talvez o destinatário esteja dormindo, em um voo, ou você só queira deixar um link em uma mensagem e seguir com o seu dia. Para isso o Relayium tem um segundo modo: em vez de transmitir um arquivo ao vivo para outro navegador aberto, ele criptografa o arquivo onde você está, envia apenas o texto cifrado e lhe entrega um link que você pode enviar quando quiser — o download acontece de acordo com a agenda do próprio destinatário.",
    "Este guia percorre a criação de um desses links, as opções de validade e de apagar após a leitura, e o que exatamente o design de conhecimento zero significa na prática — incluindo os limites honestos: criar um link exige que o remetente faça login, e os links contam contra uma cota de armazenamento.",
  ],
  sections: [
    {
      heading: "Links armazenados vs. tempo real: quando usar cada um",
      body: [
        "O modo em tempo real do Relayium transmite um arquivo diretamente entre duas abas de navegador abertas — rápido, e nada fica armazenado em lugar nenhum, mas as duas pessoas precisam estar online ao mesmo tempo. Um link armazenado e com validade inverte esse compromisso: o seu navegador faz a criptografia e envia o resultado uma única vez, e o destinatário pode abrir o link minutos, horas ou dias depois, no próprio tempo.",
        "Use um link armazenado quando não souber exatamente quando a outra pessoa estará livre, quando estiver enviando o mesmo arquivo para mais de uma pessoa, ou quando simplesmente quiser algo que você possa colar em um e-mail ou chat e pronto.",
      ],
    },
    {
      heading: "Como criar um link",
      body: ["Criar um link leva alguns passos, todos no navegador:"],
      bullets: [
        "Abra relayium.com e mude para o modo link/offline.",
        "Faça login — só o remetente precisa de uma conta; o destinatário nunca.",
        "Escolha um ou mais arquivos.",
        "Opcionalmente defina uma janela de validade, ou ative o apagar após a leitura.",
        "Aguarde enquanto o navegador criptografa e depois envia os arquivos — uma barra de progresso mostra as duas fases.",
        "Copie o link (ou escaneie o código QR) e envie da forma que preferir.",
      ],
    },
    {
      heading: "Validade e apagar após a leitura",
      body: [
        "Todo link precisa de um tempo de vida — deixar um ativo para sempre não é o objetivo de uma transferência pontual. Ao criar um link você escolhe por quanto tempo ele deve permanecer válido, ou pode configurá-lo para desaparecer assim que for usado uma vez.",
        "Apagar após a leitura significa que o link para de funcionar no momento em que o destinatário termina de baixar — útil quando o arquivo é sensível e você quer exatamente uma pessoa, uma vez, sem deixar nada solto depois. De qualquer forma, o destinatário vê uma contagem regressiva ao vivo na página de download, então sabe quanto tempo (ou quantos downloads) resta.",
      ],
      bullets: [
        "1 hora",
        "1 dia (o padrão)",
        "3 dias",
        "7 dias",
        "14 dias (o máximo, no plano superior)",
        "Ou: apagar após o primeiro download completo, em vez de um tempo fixo",
      ],
    },
    {
      heading: "A garantia de conhecimento zero, e seus limites",
      body: [
        "Veja o que realmente acontece quando você cria um link. O seu navegador gera uma chave AES-256-GCM aleatória — um mecanismo diferente do modo em tempo real do Relayium, que negocia uma chave entre dois dispositivos com X25519; a chave de um link armazenado é gerada localmente, sem nada a negociar. Essa chave criptografa seus arquivos e a lista de nomes de arquivo antes de qualquer coisa sair do seu dispositivo, e é anexada ao link de download depois de um `#` — uma parte da URL que os navegadores nunca enviam a nenhum servidor. O servidor armazena o texto cifrado que recebe, e apenas o texto cifrado; ele não tem como descriptografá-lo, porque nunca recebe a chave.",
        "Esse design tem compromissos reais que vale a pena conhecer. O link em si é a única cópia da chave, então se você o perder, não há redefinição de senha — os dados no servidor ficam permanentemente ilegíveis. Criar um link exige que o remetente esteja com login feito, e cada link conta contra a cota de armazenamento da sua conta até ser apagado ou expirar. E vale ser preciso sobre o que \"conhecimento zero\" significa aqui: o texto cifrado é de fato armazenado no servidor do Relayium entre a criação e o download — só que é ilegível sem a chave que nunca saiu do seu navegador.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "A pessoa para quem envio o link precisa de uma conta?",
        a: "Não. Qualquer pessoa com o link completo — incluindo a parte depois do `#` — pode abri-lo e baixar os arquivos. Só o remetente precisa fazer login para criar o link em primeiro lugar.",
      },
      {
        q: "O Relayium consegue ler meu arquivo?",
        a: "Não. O seu navegador criptografa os arquivos com uma chave AES-256-GCM aleatória antes de qualquer coisa ser enviada, e essa chave existe apenas no fragmento da URL, que nunca chega ao servidor. O servidor armazena texto cifrado que não tem como descriptografar — um design de conhecimento zero.",
      },
      {
        q: "Quanto tempo os links duram?",
        a: "Você escolhe ao criar o link: 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou pode configurá-lo para apagar após o primeiro download completo em vez de uma validade fixa. Depois desse ponto, o link para de funcionar.",
      },
      {
        q: "O arquivo realmente some depois de apagar após a leitura?",
        a: "Apagar após a leitura é projetado para exatamente um download: assim que o destinatário termina de baixar o arquivo, o link para de funcionar para qualquer um que o abra depois, então ele não pode ser visto discretamente uma segunda vez.",
      },
    ],
  },
  cta: {
    text: "Tem um arquivo pronto mas ninguém esperando do outro lado? Crie um link com validade no seu navegador e envie quando estiver pronto.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/share-a-file-with-an-expiring-link",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
