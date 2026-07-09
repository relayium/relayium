// web/scripts/pages/content/articles/compare-google-drive.mjs
// Objective comparison: Relayium vs Google Drive for sending files (not
// durable storage). English is the master; zh/ja/ko/de/fr follow the same
// structure with identical facts. Terminology mirrors src/lib/i18n/en.ts.

const en = {
  title: "Relayium vs Google Drive for sending files",
  description:
    "A fair comparison for the one-off file hand-off: Google Drive is great durable storage, but sending means uploading and managing permissions. Relayium sends peer-to-peer or via a zero-knowledge, self-expiring link.",
  updatedLabel: "Last updated",
  lead: [
    "Google Drive is a genuinely good product: your files live in one place, sync across devices, stay backed up, and are easy to co-edit with a team. If what you need is a durable home for files you will come back to, Drive is a reasonable default, and this article is not trying to talk you out of that.",
    "But a lot of what people use Drive for is really a one-off hand-off — sending a video to a friend, a contract to a client, a dataset to a colleague — not durable storage. For that specific job, uploading a copy to Google's servers and then configuring who can see it is more machinery than the task needs. Relayium is built for exactly that hand-off: it sends the file directly between the two devices, or via a link that only your recipient can decrypt.",
  ],
  sections: [
    {
      heading: "What Google Drive does well",
      body: [
        "Drive's strength is permanence and collaboration. A file you upload stays there — synced across your phone, laptop, and the web — until you delete it, which is exactly what you want for a working folder, a shared team drive, or documents you edit together in real time.",
        "It is also generous and frictionless for storage: a solid free tier, automatic backup, version history, and search across everything you have ever saved. None of that is something Relayium tries to replace.",
      ],
    },
    {
      heading: "Where they differ: sending isn't the same job as storing",
      body: [
        "To send one file through Drive, you upload a copy to Google's infrastructure, then decide who can open it — a specific person's Google account, or \"anyone with the link.\" Get the sharing setting wrong and the file is either unreachable or more open than you meant. Either way, a copy now lives on Google's servers indefinitely, until you go back and remove it.",
        "Relayium skips the storage step for the common case. Its realtime mode moves bytes directly between the sender's and recipient's devices over an end-to-end encrypted peer-to-peer connection — the file itself is never stored on a server at all. When the recipient is offline and you do want a link, the stored-link mode keeps the zero-knowledge property Drive doesn't have: your browser encrypts the file with a random AES-256-GCM key before upload, and that key lives only in the URL fragment (the part after the #, which browsers never send to a server). Google's servers hold and can technically read your Drive files; Relayium's server, for a stored link, holds only ciphertext it cannot decrypt.",
      ],
    },
    {
      heading: "Realtime: nothing stored on a server",
      body: [
        "For the classic case — both people are online right now — realtime direct transfer sends up to 1,000 files in one batch straight between devices, with no upload step and nothing stored anywhere in between. Both sides see a matching 6-digit verification code (SAS) to rule out a man-in-the-middle, and each file is checked end-to-end with a SHA-256 hash; if the connection drops, the transfer resumes instead of restarting.",
        "There's no server-side size cap, so the practical limit comes from the receiving browser: Chrome and Edge stream incoming data straight to disk, comfortably handling tens of gigabytes, while Firefox and Safari buffer in memory, so keep those transfers under roughly 200 MB. On the same network, no account is needed at all. Sending across networks uses a pairing code and requires the sender to sign in — the recipient never needs an account, on either network setup. If a direct connection isn't possible, it falls back to an encrypted TURN relay that only ever sees ciphertext.",
      ],
    },
    {
      heading: "Still want a link? Zero-knowledge stored links",
      body: [
        "Sometimes a link really is what you need — the recipient isn't online, or you want one URL you can paste anywhere. Relayium's stored-link mode covers that case without giving up the privacy of realtime mode.",
        "You choose an expiry — 1 hour, 1 day, 3 days, or 7 days — or set the link to burn after the first completed download. Creating a link requires the sender to sign in (it counts against a storage quota on your account), but the recipient just opens the link and downloads, no account required. Because the decryption key never leaves the URL fragment, Google's model and Relayium's stored-link model differ on one core point: Google can technically decrypt Drive-hosted files; Relayium's server, for stored links, structurally cannot.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Purpose: Google Drive is durable, always-there storage with collaboration built in; Relayium is built for a one-off send — realtime P2P or a self-expiring link.",
        "Where files live: Drive keeps an indefinite copy on Google's servers until you delete it; Relayium realtime never stores the file at all, and stored links auto-expire (1h/1d/3d/7d) or burn after first download.",
        "Who can read it: Google's infrastructure can technically decrypt Drive files; Relayium's stored links are zero-knowledge — the key lives only in the URL fragment, so the server holds ciphertext it can't read.",
        "Accounts: Drive requires a Google account for the sender, and often for the recipient depending on sharing settings; Relayium needs no account on the same network, and only the sender signs in for cross-network or stored-link sending — the recipient never needs one.",
        "Size limits: Drive is bounded by your storage quota; Relayium realtime has no server-side cap (Chrome/Edge stream to disk for tens of GB; keep Firefox/Safari under ~200 MB).",
        "Cost and openness: Relayium is free and MIT-licensed at github.com/relayium/relayium, running in the browser on Windows, macOS, Linux, Android, and iOS with nothing to install.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does Relayium store my files like Google Drive does?",
        a: "Not in realtime mode — the file goes directly between devices and is never stored on a server. If you create a download link, the server does store something, but only zero-knowledge ciphertext it cannot decrypt; it expires (1h/1d/3d/7d) or burns after the first download.",
      },
      {
        q: "Do I need an account?",
        a: "On the same network, no account is needed at all. Sending across networks with a pairing code, or creating a stored download link, requires the sender to sign in. The recipient never needs an account, in either case.",
      },
      {
        q: "Is there a size limit?",
        a: "Realtime transfers carry up to 1,000 files per batch with no server-side size cap — Chrome and Edge stream straight to disk for tens of gigabytes, while Firefox and Safari buffer in memory, so keep those under roughly 200 MB. Stored links count against a quota tied to your account.",
      },
      {
        q: "Is Relayium free?",
        a: "Yes. Relayium is free and open source under the MIT license, with the full protocol and code at github.com/relayium/relayium — no paid tier to unlock bigger or faster transfers.",
      },
    ],
  },
  cta: {
    text: "Send a file directly, without uploading it to anyone's cloud — no size cap, no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 Google Drive：发送文件更直接",
  description:
    "客观对比：一次性发送文件时，Google Drive 擅长的是持久存储，但发送意味着上传并管理权限；Relayium 直接点对点发送，或使用零知识加密的自动到期链接。",
  updatedLabel: "最近更新",
  lead: [
    "Google Drive 确实是个好产品：文件集中存放、跨设备同步、自动备份，团队协作编辑也很顺手。如果你需要的是一个会反复用到的文件存放地，Drive 是合理的默认选择，本文并不打算劝你放弃它。",
    "但很多人用 Drive 做的其实是一次性的“交接”——把一段视频发给朋友、把合同发给客户、把数据集发给同事——而不是持久存储。对这类具体任务来说，把一份副本上传到 Google 的服务器、再配置谁能看到它，比任务本身需要的步骤要多。Relayium 正是为这种交接而生：文件直接在两台设备之间传输，或通过一个只有收件人能解密的链接发送。",
  ],
  sections: [
    {
      heading: "Google Drive 做得好的地方",
      body: [
        "Drive 的长处在于持久性和协作。你上传的文件会一直留在那里——在手机、笔记本和网页间同步——直到你删除它为止，这正是工作文件夹、团队共享盘或需要实时共同编辑的文档所需要的。",
        "在存储方面它也很慷慨、很省心：不错的免费额度、自动备份、版本历史，以及对你保存过的一切内容的搜索。这些都不是 Relayium 想要取代的东西。",
      ],
    },
    {
      heading: "差异所在：发送和存储不是同一件事",
      body: [
        "要通过 Drive 发送一个文件，你需要把一份副本上传到 Google 的基础设施上，再决定谁能打开它——某个具体人的 Google 账号，或者“拥有链接的任何人”。分享设置一旦设错，文件要么无法访问，要么比你想的更公开。无论哪种情况，一份副本都会无限期地留在 Google 的服务器上，直到你回去把它删掉。",
        "对常见场景，Relayium 干脆跳过了存储这一步。它的实时模式通过端到端加密的点对点连接，在发送方和接收方的设备之间直接传输字节——文件本身根本不会存到任何服务器上。当收件人不在线、你确实需要一个链接时，存储链接模式保留了 Drive 所没有的零知识特性：你的浏览器会在上传前用随机生成的 AES-256-GCM 密钥加密文件，而这个密钥只存在于 URL 片段中（# 之后的部分，浏览器从不会把它发给服务器）。Google 的服务器持有并且在技术上可以读取你 Drive 里的文件；而 Relayium 的服务器对于存储链接，只保存它无法解密的密文。",
      ],
    },
    {
      heading: "实时模式：不在服务器上存任何东西",
      body: [
        "对于最典型的场景——双方现在都在线——实时直连传输可以一次发送最多 1,000 个文件，在设备之间直接传输，没有上传这一步，中间也不存放任何东西。双方会看到一致的 6 位校验码（SAS）以排除中间人攻击，每个文件都用 SHA-256 做端到端校验；连接中断时，传输会断点续传而不是从头再来。",
        "实时传输没有服务器端的大小上限，实际限制取决于接收方的浏览器：Chrome 和 Edge 会把接收的数据直接流式写入磁盘，轻松应对几十 GB 的文件；Firefox 和 Safari 则会缓冲在内存里，建议这类传输保持在约 200 MB 以内。同一网络下完全无需账号。跨网络发送使用配对码，需要发送方登录——但无论哪种网络场景，接收方都始终无需账号。若无法直连，会退回到加密的 TURN 中继，中继只能看到密文。",
      ],
    },
    {
      heading: "还是想要一个链接？零知识存储链接",
      body: [
        "有时候你确实需要一个链接——收件人不在线，或者你想要一个可以贴到任何地方的 URL。Relayium 的存储链接模式覆盖了这种场景，同时不牺牲实时模式的隐私性。",
        "你可以选择有效期——1 小时、1 天、3 天或 7 天——或者设置为首次下载完成后即焚。创建链接需要发送方登录（会计入账号的存储配额），但收件人只需打开链接下载，无需账号。因为解密密钥从不离开 URL 片段，Google 的模式和 Relayium 存储链接的模式在一个核心点上不同：Google 在技术上可以解密 Drive 上托管的文件；而 Relayium 的服务器对存储链接来说，从结构上就做不到这一点。",
      ],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "定位：Google Drive 是内置协作能力的、始终在线的持久存储；Relayium 是为一次性发送而生——实时点对点或自动到期的链接。",
        "文件存放：Drive 会把副本无限期留在 Google 服务器上，直到你删除；Relayium 实时模式根本不存储文件，存储链接则会自动到期（1小时/1天/3天/7天）或首次下载后即焚。",
        "谁能读取：Google 的基础设施在技术上可以解密 Drive 上的文件；Relayium 的存储链接是零知识的——密钥只存在于 URL 片段中，服务器保存的是它无法解读的密文。",
        "账号要求：Drive 要求发送方有 Google 账号，收件方是否需要则取决于分享设置；Relayium 在同一网络下完全无需账号，跨网络发送或创建存储链接时只需发送方登录——接收方始终无需账号。",
        "大小限制：Drive 的限制取决于你的存储配额；Relayium 实时模式没有服务器端上限（Chrome/Edge 可流式写盘应对几十 GB；Firefox/Safari 建议保持在约 200 MB 以内）。",
        "费用与开放：Relayium 免费且采用 MIT 许可，代码在 github.com/relayium/relayium；在浏览器中运行，覆盖 Windows、macOS、Linux、Android 和 iOS，无需安装。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 会像 Google Drive 一样存储我的文件吗？",
        a: "实时模式下不会——文件直接在设备之间传输，从不存到服务器上。如果你创建了下载链接，服务器确实会保存一些内容，但只是它无法解密的零知识密文；链接会到期（1小时/1天/3天/7天）或首次下载后即焚。",
      },
      {
        q: "需要账号吗？",
        a: "同一网络下完全无需账号。用配对码跨网络发送，或创建存储下载链接，都需要发送方登录。无论哪种情况，接收方都始终无需账号。",
      },
      {
        q: "有大小限制吗？",
        a: "实时传输一次最多可发送 1,000 个文件，没有服务器端大小上限——Chrome 和 Edge 会直接流式写入磁盘，可应对几十 GB 的文件；Firefox 和 Safari 会缓冲在内存里，建议这类传输保持在约 200 MB 以内。存储链接则计入与账号绑定的配额。",
      },
      {
        q: "Relayium 免费吗？",
        a: "免费。Relayium 采用 MIT 许可，是免费开源软件，完整的协议与代码都在 github.com/relayium/relayium——没有付费档去解锁更大或更快的传输。",
      },
    ],
  },
  cta: {
    text: "直接发送文件，无需上传到任何人的云盘——无大小上限、无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と Google Drive の比較：ファイル送信をもっと直接に",
  description:
    "公平な比較。Google Drive は永続的な保存に優れますが、送るとなるとアップロードと権限管理が必要です。Relayium はピアツーピアで直接送るか、ゼロ知識・自動失効リンクで送ります。",
  updatedLabel: "最終更新",
  lead: [
    "Google Drive は本当に優れた製品です。ファイルは一箇所にまとまり、端末間で同期され、バックアップされ、チームでの共同編集も簡単です。何度も戻ってくるファイルの置き場所が必要なら、Drive は妥当な選択肢であり、本記事はそれをやめさせようとするものではありません。",
    "しかし多くの人が Drive を使っている場面は、実は一度きりの受け渡しです——友人に動画を送る、クライアントに契約書を送る、同僚にデータセットを送る——永続的な保存ではありません。その特定の作業のためだけに、コピーを Google のサーバーへアップロードし、誰が見られるかを設定するのは、必要以上の手間です。Relayium はまさにその受け渡しのために作られています。ファイルを2台の端末間で直接送るか、受信者だけが復号できるリンクで送ります。",
  ],
  sections: [
    {
      heading: "Google Drive が優れている点",
      body: [
        "Drive の強みは永続性と協業です。アップロードしたファイルはそこに残り続けます——スマートフォン、ノートパソコン、Web の間で同期されながら——削除するまで。これはまさに、作業用フォルダやチーム共有ドライブ、リアルタイムで共同編集する文書に求められることです。",
        "保存についても気前が良く、手間がかかりません。十分な無料枠、自動バックアップ、バージョン履歴、これまで保存したすべてを対象にした検索。これらは Relayium が置き換えようとしているものではありません。",
      ],
    },
    {
      heading: "違いはどこか：送ることと保存することは同じ作業ではない",
      body: [
        "Drive で1つのファイルを送るには、コピーを Google のインフラにアップロードし、誰が開けるかを決めます——特定の人の Google アカウント、または「リンクを知っている全員」。共有設定を間違えると、ファイルが届かなくなるか、意図したより公開範囲が広くなります。いずれにせよ、コピーはあなたが後で削除しに戻るまで、Google のサーバー上に無期限に存在し続けます。",
        "Relayium はよくあるケースで、この保存という手順を省きます。リアルタイムモードは、エンドツーエンドで暗号化された P2P 接続を通じて、送信者と受信者の端末間でバイトを直接動かします——ファイル自体はサーバーに一切保存されません。受信者がオフラインで、それでもリンクが欲しいときは、保存リンクモードが Drive にはないゼロ知識の性質を保ちます。ブラウザはアップロード前にランダムな AES-256-GCM 鍵でファイルを暗号化し、その鍵は URL フラグメント（# の後の部分。ブラウザが決してサーバーへ送らない部分）にだけ存在します。Google のサーバーは Drive 上のファイルを保持し、技術的には読むことができます。一方 Relayium のサーバーは、保存リンクについては復号できない暗号文しか保持しません。",
      ],
    },
    {
      heading: "リアルタイム：サーバーには何も保存されない",
      body: [
        "典型的なケース——両者が今まさにオンライン——では、リアルタイム直接転送は最大1,000ファイルを1バッチとして端末間で直接送り、アップロードの手順もなく、途中で何も保存されません。両方の端末は一致する6桁の検証コード（SAS）を表示して中間者を排除し、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。接続が切れても、転送は最初からではなく再開します。",
        "サーバー側のサイズ上限はないため、実用上の限界は受信側のブラウザ次第です。Chrome と Edge は受信データをそのままディスクにストリーミングし、数十ギガバイトでも問題なく扱えます。Firefox と Safari はメモリにバッファするため、そうした転送は約200MB以内に抑えてください。同じネットワーク内ではアカウントは一切不要です。ネットワークをまたぐ送信にはペアリングコードを使い、送信側のサインインが必要です——ただしどちらのネットワーク構成でも、受信側は常にアカウント不要です。直接接続ができない場合は、暗号化された TURN リレーにフォールバックし、リレーは暗号文しか見ません。",
      ],
    },
    {
      heading: "それでもリンクが欲しいときは：ゼロ知識の保存リンク",
      body: [
        "リンクが本当に必要な場面もあります——受信者がオンラインでない、あるいはどこにでも貼れる1つの URL が欲しいときです。Relayium の保存リンクモードは、リアルタイムモードのプライバシーを犠牲にせずこのケースをカバーします。",
        "有効期限は1時間・1日・3日・7日から選ぶか、最初のダウンロード完了後に消去する設定にできます。リンクの作成には送信側のサインインが必要です（アカウントの保存容量枠に計上されます）が、受信側はリンクを開いてダウンロードするだけでアカウントは不要です。復号鍵が URL フラグメントから外に出ることは決してないため、Google のモデルと Relayium の保存リンクのモデルには核心的な違いがあります。Google は Drive にホストされたファイルを技術的に復号できますが、Relayium のサーバーは保存リンクについて構造的にそれができません。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "目的：Google Drive は協業機能を備えた常時利用可能な永続ストレージ；Relayium は一度きりの送信のために作られている——リアルタイム P2P か、自動失効するリンク。",
        "ファイルの置き場所：Drive はあなたが削除するまでコピーを Google のサーバーに無期限に保持；Relayium のリアルタイムはファイルを一切保存せず、保存リンクは自動失効（1時間/1日/3日/7日）または初回ダウンロード後に消去。",
        "誰が読めるか：Google のインフラは技術的に Drive 上のファイルを復号できる；Relayium の保存リンクはゼロ知識で、鍵は URL フラグメントにだけ存在し、サーバーは読めない暗号文を保持する。",
        "アカウント：Drive は送信側に Google アカウントを要求し、共有設定によっては受信側にも必要；Relayium は同一ネットワークではアカウント不要、ネットワークをまたぐ送信や保存リンクの作成では送信側のみサインインが必要——受信側は常にアカウント不要。",
        "サイズ上限：Drive はあなたの保存容量枠に制約される；Relayium のリアルタイムはサーバー側の上限なし（Chrome/Edge は数十GBまでディスクへストリーミング、Firefox/Safari は約200MB以内に）。",
        "費用と開放性：Relayium は無料で MIT ライセンス、github.com/relayium/relayium にあり、ブラウザで Windows・macOS・Linux・Android・iOS で動作し、インストール不要。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium は Google Drive のようにファイルを保存しますか？",
        a: "リアルタイムモードでは保存しません——ファイルは端末間を直接移動し、サーバーには一切保存されません。ダウンロードリンクを作成した場合、サーバーは何かを保存しますが、それは復号できないゼロ知識の暗号文だけです。リンクは失効するか（1時間/1日/3日/7日）、最初のダウンロード後に消去されます。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "同じネットワーク内ではアカウントは一切不要です。ペアリングコードでネットワークをまたいで送信する場合や、保存ダウンロードリンクを作成する場合は、送信側のサインインが必要です。どちらの場合も受信側は常にアカウント不要です。",
      },
      {
        q: "サイズに上限はありますか？",
        a: "リアルタイム転送は1バッチにつき最大1,000ファイルまで扱え、サーバー側のサイズ上限はありません——Chrome と Edge は数十ギガバイトまでそのままディスクにストリーミングし、Firefox と Safari はメモリにバッファするため約200MB以内に抑えてください。保存リンクはアカウントに紐づく容量枠に計上されます。",
      },
      {
        q: "Relayium は無料ですか？",
        a: "はい。Relayium は MIT ライセンスの無料オープンソースで、プロトコルとコードのすべてが github.com/relayium/relayium にあります。より大きく、より速い転送を解放する有料プランはありません。",
      },
    ],
  },
  cta: {
    text: "誰のクラウドにもアップロードせず、ファイルを直接送ってみてください——サイズ上限なし、インストール不要、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs Google Drive: 파일을 더 직접적으로 보내기",
  description:
    "공정한 비교입니다. Google Drive는 영구 저장에 뛰어나지만, 보내려면 업로드하고 권한을 관리해야 합니다. Relayium은 P2P로 직접 보내거나 영지식·자동 만료 링크로 보냅니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Google Drive는 정말 훌륭한 제품입니다. 파일이 한곳에 모여 있고, 기기 간 동기화되며, 백업되고, 팀과 함께 실시간으로 편집하기도 쉽습니다. 계속 다시 찾게 될 파일의 영구적인 보관 장소가 필요하다면 Drive는 합리적인 기본 선택지이며, 이 글은 그것을 그만두라고 설득하려는 것이 아닙니다.",
    "하지만 많은 사람이 Drive로 하는 일은 실제로는 일회성 전달입니다——친구에게 동영상을 보내거나, 고객에게 계약서를 보내거나, 동료에게 데이터셋을 보내는 일——영구 저장이 아닙니다. 그 특정 작업만 놓고 보면, 사본을 Google 서버에 업로드하고 누가 볼 수 있는지 설정하는 것은 작업에 필요한 것보다 더 많은 절차입니다. Relayium은 바로 그 전달을 위해 만들어졌습니다. 파일을 두 기기 사이에서 직접 보내거나, 받는 사람만 복호화할 수 있는 링크로 보냅니다.",
  ],
  sections: [
    {
      heading: "Google Drive가 잘하는 것",
      body: [
        "Drive의 강점은 영속성과 협업입니다. 업로드한 파일은 삭제할 때까지 그곳에——휴대폰, 노트북, 웹 사이에서 동기화되며——계속 남아 있습니다. 이는 작업 폴더나 팀 공유 드라이브, 실시간으로 함께 편집하는 문서에 정확히 필요한 것입니다.",
        "저장 측면에서도 관대하고 손이 덜 갑니다. 넉넉한 무료 등급, 자동 백업, 버전 기록, 그동안 저장한 모든 것에 대한 검색까지. 이런 것들은 Relayium이 대체하려는 것이 아닙니다.",
      ],
    },
    {
      heading: "차이가 나는 지점: 보내는 것과 저장하는 것은 같은 일이 아니다",
      body: [
        "Drive로 파일 하나를 보내려면 사본을 Google 인프라에 업로드한 뒤, 누가 열 수 있는지 정해야 합니다——특정 사람의 Google 계정, 또는 \"링크가 있는 모든 사람\". 공유 설정을 잘못하면 파일에 접근할 수 없거나 의도한 것보다 더 공개됩니다. 어느 쪽이든, 사본은 당신이 나중에 돌아가 지울 때까지 Google 서버에 무기한 남아 있습니다.",
        "Relayium은 흔한 경우에 이 저장 단계를 건너뜁니다. 실시간 모드는 종단간 암호화된 P2P 연결을 통해 보내는 사람과 받는 사람의 기기 사이에서 바이트를 직접 이동시킵니다——파일 자체는 서버에 전혀 저장되지 않습니다. 받는 사람이 오프라인이라 링크가 정말로 필요할 때는, 저장 링크 모드가 Drive에는 없는 영지식 속성을 유지합니다. 브라우저가 업로드 전에 무작위로 생성한 AES-256-GCM 키로 파일을 암호화하고, 그 키는 URL 프래그먼트——# 뒤의, 브라우저가 서버로 절대 보내지 않는 부분——에만 존재합니다. Google의 서버는 Drive 파일을 보관하며 기술적으로 읽을 수 있습니다. 반면 Relayium의 서버는 저장 링크에 대해 복호화할 수 없는 암호문만 보관합니다.",
      ],
    },
    {
      heading: "실시간: 서버에 아무것도 저장되지 않음",
      body: [
        "가장 전형적인 경우——두 사람이 지금 모두 온라인——에는 실시간 직접 전송이 한 번에 최대 1,000개 파일을 기기 사이에서 곧바로 보내며, 업로드 단계도 없고 그 사이 어디에도 아무것도 저장되지 않습니다. 양쪽 모두 일치하는 6자리 검증 코드(SAS)를 보여 중간자를 배제하고, 각 파일은 SHA-256 해시로 종단간 검증됩니다. 연결이 끊기면 전송은 처음부터가 아니라 이어서 재개됩니다.",
        "서버 측 크기 제한이 없으므로 실질적인 한계는 받는 쪽 브라우저에서 옵니다. Chrome과 Edge는 들어오는 데이터를 곧바로 디스크로 스트리밍해 수십 기가바이트도 무리 없이 처리하고, Firefox와 Safari는 메모리에 버퍼링하므로 이런 전송은 약 200 MB 이내로 유지하세요. 같은 네트워크에서는 계정이 전혀 필요 없습니다. 네트워크를 넘어 보낼 때는 페어링 코드를 쓰며 보내는 쪽의 로그인이 필요합니다——다만 어느 네트워크 구성이든 받는 쪽은 항상 계정이 필요 없습니다. 직접 연결이 불가능하면 암호화된 TURN 릴레이로 폴백하며, 릴레이는 암호문만 봅니다.",
      ],
    },
    {
      heading: "그래도 링크가 필요하다면: 영지식 저장 링크",
      body: [
        "때로는 정말로 링크가 필요합니다——받는 사람이 온라인이 아니거나, 어디에든 붙여넣을 수 있는 URL 하나가 필요할 때입니다. Relayium의 저장 링크 모드는 실시간 모드의 프라이버시를 포기하지 않고 이 경우를 다룹니다.",
        "만료 기간을 1시간, 1일, 3일, 7일 중에서 고르거나, 첫 다운로드 완료 후 소각되도록 설정할 수 있습니다. 링크 생성에는 보내는 쪽의 로그인이 필요하지만(계정의 저장 용량 한도에 포함됩니다), 받는 쪽은 링크를 열어 다운로드하기만 하면 되고 계정은 필요 없습니다. 복호화 키가 URL 프래그먼트를 벗어나는 일이 없기 때문에, Google의 모델과 Relayium의 저장 링크 모델은 핵심적인 지점에서 다릅니다. Google은 기술적으로 Drive에 호스팅된 파일을 복호화할 수 있지만, Relayium의 서버는 저장 링크에 대해 구조적으로 그렇게 할 수 없습니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "목적: Google Drive는 협업 기능을 갖춘, 항상 그 자리에 있는 영구 저장소; Relayium은 일회성 전송을 위해 만들어짐——실시간 P2P 또는 자동 만료 링크.",
        "파일이 놓이는 곳: Drive는 당신이 삭제할 때까지 사본을 Google 서버에 무기한 보관; Relayium 실시간은 파일을 아예 저장하지 않고, 저장 링크는 자동 만료(1시간/1일/3일/7일)되거나 첫 다운로드 후 소각됨.",
        "누가 읽을 수 있는가: Google의 인프라는 기술적으로 Drive 파일을 복호화할 수 있음; Relayium의 저장 링크는 영지식으로, 키가 URL 프래그먼트에만 있어 서버는 읽을 수 없는 암호문을 보관함.",
        "계정: Drive는 보내는 쪽에 Google 계정을 요구하고, 공유 설정에 따라 받는 쪽에도 필요할 수 있음; Relayium은 같은 네트워크에서 계정이 전혀 필요 없고, 네트워크를 넘거나 저장 링크를 만들 때만 보내는 쪽이 로그인함——받는 쪽은 항상 계정 불필요.",
        "크기 제한: Drive는 저장 용량 한도에 제약됨; Relayium 실시간은 서버 측 제한 없음(Chrome/Edge는 수십 GB까지 디스크로 스트리밍, Firefox/Safari는 약 200 MB 이내로 유지).",
        "비용과 개방성: Relayium은 무료이며 MIT 라이선스로 github.com/relayium/relayium에 있고, 브라우저에서 Windows·macOS·Linux·Android·iOS로 동작하며 설치가 필요 없음.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium도 Google Drive처럼 제 파일을 저장하나요?",
        a: "실시간 모드에서는 아닙니다——파일이 기기 사이에서 직접 이동하며 서버에 전혀 저장되지 않습니다. 다운로드 링크를 만들면 서버가 무언가를 저장하지만, 그것은 복호화할 수 없는 영지식 암호문뿐입니다. 링크는 만료되거나(1시간/1일/3일/7일) 첫 다운로드 후 소각됩니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "같은 네트워크에서는 계정이 전혀 필요 없습니다. 페어링 코드로 네트워크를 넘어 보내거나 저장 다운로드 링크를 만들 때는 보내는 쪽의 로그인이 필요합니다. 어느 경우든 받는 쪽은 항상 계정이 필요 없습니다.",
      },
      {
        q: "크기 제한이 있나요?",
        a: "실시간 전송은 한 번에 최대 1,000개 파일을 다룰 수 있고 서버 측 크기 제한이 없습니다——Chrome과 Edge는 수십 기가바이트까지 곧바로 디스크로 스트리밍하고, Firefox와 Safari는 메모리에 버퍼링하므로 약 200 MB 이내로 유지하세요. 저장 링크는 계정에 연결된 용량 한도에 포함됩니다.",
      },
      {
        q: "Relayium은 무료인가요?",
        a: "네. Relayium은 MIT 라이선스의 무료 오픈소스이며, 프로토콜과 코드 전체가 github.com/relayium/relayium에 있습니다. 더 크거나 빠른 전송을 여는 유료 등급은 없습니다.",
      },
    ],
  },
  cta: {
    text: "누구의 클라우드에도 업로드하지 않고 파일을 직접 보내보세요——크기 제한 없이, 설치 없이, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. Google Drive: Dateien direkter versenden",
  description:
    "Ein fairer Vergleich: Google Drive ist stark bei dauerhafter Speicherung, aber Versenden heißt Hochladen und Berechtigungen verwalten. Relayium sendet peer-to-peer oder über einen Zero-Knowledge-Link mit Ablaufdatum.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Google Drive ist ein wirklich gutes Produkt: Deine Dateien liegen an einem Ort, synchronisieren sich über Geräte hinweg, sind gesichert und lassen sich leicht im Team gemeinsam bearbeiten. Wenn du ein dauerhaftes Zuhause für Dateien brauchst, zu denen du immer wieder zurückkehrst, ist Drive eine vernünftige Standardwahl — dieser Artikel will dich davon nicht abbringen.",
    "Aber vieles, wofür Leute Drive nutzen, ist eigentlich eine einmalige Übergabe — ein Video an einen Freund, ein Vertrag an eine Kundin, ein Datensatz an einen Kollegen — keine dauerhafte Speicherung. Für genau diese Aufgabe ist es mehr Aufwand als nötig, eine Kopie auf Googles Server zu laden und dann zu konfigurieren, wer sie sehen darf. Relayium ist genau für diese Übergabe gebaut: Es sendet die Datei direkt zwischen den beiden Geräten, oder über einen Link, den nur dein Empfänger entschlüsseln kann.",
  ],
  sections: [
    {
      heading: "Was Google Drive gut macht",
      body: [
        "Drives Stärke ist Beständigkeit und Zusammenarbeit. Eine hochgeladene Datei bleibt dort — synchronisiert über Handy, Laptop und Web — bis du sie löschst, genau das, was du für einen Arbeitsordner, ein gemeinsames Team-Laufwerk oder Dokumente brauchst, die ihr in Echtzeit gemeinsam bearbeitet.",
        "Es ist außerdem großzügig und mühelos bei der Speicherung: ein solider kostenloser Tarif, automatische Sicherung, Versionsverlauf und eine Suche über alles, was du je gespeichert hast. Nichts davon versucht Relayium zu ersetzen.",
      ],
    },
    {
      heading: "Worin sie sich unterscheiden: Senden ist nicht dasselbe wie Speichern",
      body: [
        "Um eine Datei per Drive zu senden, lädst du eine Kopie auf Googles Infrastruktur und entscheidest dann, wer sie öffnen darf — das Google-Konto einer bestimmten Person oder \"jeder mit dem Link\". Stellst du die Freigabe falsch ein, ist die Datei entweder unerreichbar oder offener als beabsichtigt. So oder so liegt jetzt eine Kopie unbefristet auf Googles Servern, bis du zurückgehst und sie entfernst.",
        "Relayium überspringt den Speicherschritt für den üblichen Fall. Der Echtzeitmodus bewegt Bytes über eine Ende-zu-Ende-verschlüsselte Peer-to-Peer-Verbindung direkt zwischen den Geräten von Absender und Empfänger — die Datei selbst wird nie auf einem Server gespeichert. Ist der Empfänger offline und du willst wirklich einen Link, behält der Speicherlink-Modus die Zero-Knowledge-Eigenschaft, die Drive nicht hat: Dein Browser verschlüsselt die Datei vor dem Hochladen mit einem zufälligen AES-256-GCM-Schlüssel, und dieser Schlüssel lebt nur im URL-Fragment (dem Teil nach dem #, den Browser nie an einen Server senden). Googles Server halten deine Drive-Dateien und können sie technisch lesen; Relayiums Server hält bei einem Speicherlink nur Chiffretext, den er nicht entschlüsseln kann.",
      ],
    },
    {
      heading: "Echtzeit: nichts wird auf einem Server gespeichert",
      body: [
        "Für den klassischen Fall — beide sind gerade online — sendet die direkte Echtzeitübertragung bis zu 1.000 Dateien in einem Durchgang direkt zwischen den Geräten, ohne Hochladeschritt und ohne dass zwischendurch irgendwo etwas gespeichert wird. Beide Seiten sehen einen übereinstimmenden sechsstelligen Prüfcode (SAS), um einen Man-in-the-Middle auszuschließen, und jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft; bricht die Verbindung ab, wird die Übertragung fortgesetzt statt neu gestartet.",
        "Es gibt kein serverseitiges Größenlimit, die praktische Grenze kommt also vom empfangenden Browser: Chrome und Edge streamen eingehende Daten direkt auf die Festplatte und bewältigen mühelos mehrere Dutzend Gigabyte, während Firefox und Safari im Arbeitsspeicher puffern — halte solche Übertragungen dort unter etwa 200 MB. Im selben Netz ist überhaupt kein Konto nötig. Beim Senden über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden — der Empfänger braucht in keinem der beiden Fälle je ein Konto. Ist eine Direktverbindung nicht möglich, weicht die Übertragung auf ein verschlüsseltes TURN-Relay aus, das nur Chiffretext sieht.",
      ],
    },
    {
      heading: "Doch einen Link gewünscht? Zero-Knowledge-Speicherlinks",
      body: [
        "Manchmal ist ein Link wirklich das, was du brauchst — der Empfänger ist nicht online, oder du willst eine URL, die du überall einfügen kannst. Relayiums Speicherlink-Modus deckt diesen Fall ab, ohne die Privatsphäre des Echtzeitmodus aufzugeben.",
        "Du wählst eine Ablaufzeit — 1 Stunde, 1 Tag, 3 Tage oder 7 Tage — oder stellst den Link so ein, dass er nach dem ersten vollständigen Download vernichtet wird. Das Erstellen eines Links erfordert die Anmeldung des Absenders (er zählt gegen ein Speicherkontingent deines Kontos), aber der Empfänger öffnet den Link einfach und lädt herunter, ohne Konto. Da der Entschlüsselungsschlüssel das URL-Fragment nie verlässt, unterscheiden sich Googles Modell und Relayiums Speicherlink-Modell in einem zentralen Punkt: Google kann Drive-gehostete Dateien technisch entschlüsseln; Relayiums Server kann das bei Speicherlinks strukturell nicht.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Zweck: Google Drive ist dauerhafter, stets verfügbarer Speicher mit eingebauter Zusammenarbeit; Relayium ist für den einmaligen Versand gebaut — Echtzeit-P2P oder ein Link mit Ablaufdatum.",
        "Wo Dateien liegen: Drive behält eine unbefristete Kopie auf Googles Servern, bis du sie löschst; Relayium-Echtzeit speichert die Datei überhaupt nicht, und Speicherlinks laufen automatisch ab (1 Std./1 Tag/3 Tage/7 Tage) oder werden nach dem ersten Download vernichtet.",
        "Wer es lesen kann: Googles Infrastruktur kann Drive-Dateien technisch entschlüsseln; Relayiums Speicherlinks sind Zero-Knowledge — der Schlüssel lebt nur im URL-Fragment, sodass der Server Chiffretext hält, den er nicht lesen kann.",
        "Konten: Drive verlangt vom Absender ein Google-Konto und je nach Freigabeeinstellung oft auch vom Empfänger; Relayium braucht im selben Netz kein Konto, und nur der Absender meldet sich beim netzübergreifenden Senden oder beim Erstellen eines Speicherlinks an — der Empfänger nie.",
        "Größenlimits: Drive ist durch dein Speicherkontingent begrenzt; Relayium-Echtzeit hat kein serverseitiges Limit (Chrome/Edge streamen für mehrere Dutzend Gigabyte auf die Festplatte; Firefox/Safari unter ~200 MB halten).",
        "Kosten und Offenheit: Relayium ist kostenlos und MIT-lizenziert unter github.com/relayium/relayium und läuft im Browser unter Windows, macOS, Linux, Android und iOS ohne Installation.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Speichert Relayium meine Dateien wie Google Drive?",
        a: "Im Echtzeitmodus nicht — die Datei geht direkt zwischen den Geräten und wird nie auf einem Server gespeichert. Erstellst du einen Download-Link, speichert der Server zwar etwas, aber nur Zero-Knowledge-Chiffretext, den er nicht entschlüsseln kann; er läuft ab (1 Std./1 Tag/3 Tage/7 Tage) oder wird nach dem ersten Download vernichtet.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Im selben Netz ist überhaupt kein Konto nötig. Beim Senden über Netzwerke hinweg per Pairing-Code oder beim Erstellen eines gespeicherten Download-Links muss sich der Absender anmelden. Der Empfänger braucht in keinem der beiden Fälle je ein Konto.",
      },
      {
        q: "Gibt es ein Größenlimit?",
        a: "Echtzeitübertragungen fassen bis zu 1.000 Dateien pro Durchgang ohne serverseitiges Größenlimit — Chrome und Edge streamen für mehrere Dutzend Gigabyte direkt auf die Festplatte, während Firefox und Safari im Arbeitsspeicher puffern, halte solche Übertragungen also unter etwa 200 MB. Speicherlinks zählen gegen ein an dein Konto gebundenes Kontingent.",
      },
      {
        q: "Ist Relayium kostenlos?",
        a: "Ja. Relayium ist kostenlos und quelloffen unter der MIT-Lizenz, mit dem vollständigen Protokoll und Code unter github.com/relayium/relayium — kein Bezahltarif, um größere oder schnellere Übertragungen freizuschalten.",
      },
    ],
  },
  cta: {
    text: "Sende eine Datei direkt, ohne sie in irgendjemandes Cloud hochzuladen — kein Größenlimit, keine Installation und im selben Netz kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs Google Drive pour envoyer des fichiers",
  description:
    "Comparatif équitable : Google Drive excelle pour le stockage durable, mais envoyer signifie téléverser et gérer des permissions. Relayium envoie en pair-à-pair ou via un lien à divulgation nulle et expiration automatique.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Google Drive est un vrai bon produit : vos fichiers vivent au même endroit, se synchronisent entre appareils, restent sauvegardés, et se coéditent facilement en équipe. Si vous avez besoin d'un foyer durable pour des fichiers auxquels vous reviendrez, Drive est un choix par défaut raisonnable, et cet article n'essaie pas de vous en dissuader.",
    "Mais une grande partie de ce pour quoi les gens utilisent Drive est en réalité une remise ponctuelle — envoyer une vidéo à un ami, un contrat à un client, un jeu de données à un collègue — pas du stockage durable. Pour cette tâche précise, téléverser une copie sur les serveurs de Google puis configurer qui peut la voir demande plus de rouages que nécessaire. Relayium est conçu exactement pour cette remise : il envoie le fichier directement entre les deux appareils, ou via un lien que seul votre destinataire peut déchiffrer.",
  ],
  sections: [
    {
      heading: "Ce que Google Drive fait bien",
      body: [
        "La force de Drive, c'est la permanence et la collaboration. Un fichier téléversé y reste — synchronisé entre votre téléphone, votre ordinateur portable et le web — jusqu'à ce que vous le supprimiez, exactement ce qu'il faut pour un dossier de travail, un lecteur d'équipe partagé, ou des documents que vous coéditez en temps réel.",
        "Il est aussi généreux et sans friction côté stockage : une offre gratuite solide, une sauvegarde automatique, un historique des versions, et une recherche sur tout ce que vous avez jamais enregistré. Rien de tout cela n'est ce que Relayium cherche à remplacer.",
      ],
    },
    {
      heading: "Là où ils diffèrent : envoyer n'est pas la même tâche que stocker",
      body: [
        "Pour envoyer un fichier via Drive, vous téléversez une copie sur l'infrastructure de Google, puis décidez qui peut l'ouvrir — le compte Google d'une personne précise, ou « toute personne disposant du lien ». Si vous vous trompez de réglage de partage, le fichier devient soit inaccessible, soit plus ouvert que prévu. Dans les deux cas, une copie réside désormais indéfiniment sur les serveurs de Google, jusqu'à ce que vous reveniez la retirer.",
        "Relayium saute l'étape du stockage pour le cas courant. Son mode temps réel déplace des octets directement entre les appareils de l'expéditeur et du destinataire via une connexion pair-à-pair chiffrée de bout en bout — le fichier lui-même n'est jamais stocké sur un serveur. Quand le destinataire est hors ligne et que vous voulez vraiment un lien, le mode lien stocké conserve la propriété à divulgation nulle que Drive n'a pas : votre navigateur chiffre le fichier avec une clé AES-256-GCM aléatoire avant le téléversement, et cette clé ne vit que dans le fragment de l'URL (la partie après le #, que les navigateurs n'envoient jamais à un serveur). Les serveurs de Google détiennent vos fichiers Drive et peuvent techniquement les lire ; le serveur de Relayium, pour un lien stocké, ne détient qu'un texte chiffré qu'il ne peut pas déchiffrer.",
      ],
    },
    {
      heading: "Temps réel : rien n'est stocké sur un serveur",
      body: [
        "Pour le cas classique — les deux personnes sont en ligne en ce moment — le transfert direct en temps réel envoie jusqu'à 1 000 fichiers en un seul lot directement entre les appareils, sans étape de téléversement et sans rien stocker entre les deux. Les deux côtés voient un code de vérification à 6 chiffres identique (SAS) pour écarter un homme du milieu, et chaque fichier est vérifié de bout en bout par une empreinte SHA-256 ; si la connexion tombe, le transfert reprend au lieu de recommencer.",
        "Il n'y a aucune limite de taille côté serveur, la limite pratique vient donc du navigateur du destinataire : Chrome et Edge diffusent les données entrantes directement sur le disque, gérant sans peine plusieurs dizaines de gigaoctets, tandis que Firefox et Safari mettent en mémoire tampon, donc gardez ces transferts sous environ 200 Mo. Sur le même réseau, aucun compte n'est nécessaire du tout. Envoyer entre réseaux différents utilise un code d'appairage et exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte, dans aucune des deux configurations réseau. Si une connexion directe est impossible, le transfert bascule vers un relais TURN chiffré qui ne voit que du texte chiffré.",
      ],
    },
    {
      heading: "Vous voulez quand même un lien ? Liens stockés à divulgation nulle",
      body: [
        "Parfois un lien est vraiment ce qu'il vous faut — le destinataire n'est pas en ligne, ou vous voulez une seule URL à coller n'importe où. Le mode lien stocké de Relayium couvre ce cas sans renoncer à la confidentialité du mode temps réel.",
        "Vous choisissez une expiration — 1 heure, 1 jour, 3 jours ou 7 jours — ou réglez le lien pour qu'il se détruise après le premier téléchargement complet. Créer un lien exige que l'expéditeur se connecte (cela compte dans un quota de stockage lié à votre compte), mais le destinataire n'a qu'à ouvrir le lien et télécharger, sans compte requis. Comme la clé de déchiffrement ne quitte jamais le fragment de l'URL, le modèle de Google et celui des liens stockés de Relayium diffèrent sur un point essentiel : Google peut techniquement déchiffrer les fichiers hébergés sur Drive ; le serveur de Relayium, pour les liens stockés, ne le peut structurellement pas.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "Objectif : Google Drive est un stockage durable, toujours disponible, avec collaboration intégrée ; Relayium est conçu pour un envoi ponctuel — P2P en temps réel ou lien à expiration automatique.",
        "Où résident les fichiers : Drive garde une copie indéfinie sur les serveurs de Google jusqu'à ce que vous la supprimiez ; le temps réel de Relayium ne stocke jamais le fichier du tout, et les liens stockés expirent automatiquement (1 h/1 j/3 j/7 j) ou se détruisent après le premier téléchargement.",
        "Qui peut le lire : l'infrastructure de Google peut techniquement déchiffrer les fichiers Drive ; les liens stockés de Relayium sont à divulgation nulle — la clé ne vit que dans le fragment de l'URL, donc le serveur détient un texte chiffré qu'il ne peut pas lire.",
        "Comptes : Drive exige un compte Google pour l'expéditeur, et souvent pour le destinataire selon les réglages de partage ; Relayium ne demande aucun compte sur le même réseau, et seul l'expéditeur se connecte pour un envoi entre réseaux ou un lien stocké — le destinataire n'en a jamais besoin.",
        "Limites de taille : Drive est borné par votre quota de stockage ; le temps réel de Relayium n'a aucune limite côté serveur (Chrome/Edge diffusent sur le disque pour plusieurs dizaines de Go ; gardez Firefox/Safari sous ~200 Mo).",
        "Coût et ouverture : Relayium est gratuit et sous licence MIT sur github.com/relayium/relayium, et tourne dans le navigateur sur Windows, macOS, Linux, Android et iOS sans rien installer.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Relayium stocke-t-il mes fichiers comme Google Drive ?",
        a: "Pas en mode temps réel — le fichier va directement entre les appareils et n'est jamais stocké sur un serveur. Si vous créez un lien de téléchargement, le serveur stocke bien quelque chose, mais uniquement un texte chiffré à divulgation nulle qu'il ne peut pas déchiffrer ; il expire (1 h/1 j/3 j/7 j) ou se détruit après le premier téléchargement.",
      },
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Sur le même réseau, aucun compte n'est nécessaire du tout. Envoyer entre réseaux avec un code d'appairage, ou créer un lien de téléchargement stocké, exige que l'expéditeur se connecte. Le destinataire n'a jamais besoin de compte, dans les deux cas.",
      },
      {
        q: "Y a-t-il une limite de taille ?",
        a: "Les transferts en temps réel portent jusqu'à 1 000 fichiers par lot sans limite de taille côté serveur — Chrome et Edge diffusent directement sur le disque pour plusieurs dizaines de gigaoctets, tandis que Firefox et Safari mettent en mémoire tampon, gardez donc ces transferts sous environ 200 Mo. Les liens stockés comptent dans un quota lié à votre compte.",
      },
      {
        q: "Relayium est-il gratuit ?",
        a: "Oui. Relayium est gratuit et open source sous licence MIT, avec l'intégralité du protocole et du code sur github.com/relayium/relayium — aucune offre payante pour débloquer des transferts plus grands ou plus rapides.",
      },
    ],
  },
  cta: {
    text: "Envoyez un fichier directement, sans le téléverser sur le cloud de qui que ce soit — sans limite de taille, sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "compare/google-drive",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr },
};
