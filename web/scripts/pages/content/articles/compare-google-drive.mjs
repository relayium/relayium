// web/scripts/pages/content/articles/compare-google-drive.mjs
// Objective comparison: Relayium vs Google Drive for sending files (not
// durable storage). English is the master; zh/ja/ko/de/fr follow the same
// structure with identical facts. Terminology mirrors src/lib/i18n/en.ts.

const en = {
  title: "Relayium vs Google Drive for sending files",
  description:
    "A fair comparison for the one-off file hand-off: Google Drive is great durable storage, but sending means uploading and managing permissions. Relayium keeps no server-side copy of realtime content: browser files move directly on a LAN and use an end-to-end encrypted TURN relay across networks, or you can create a zero-knowledge, self-expiring link.",
  updatedLabel: "Last updated",
  lead: [
    "Google Drive is a genuinely good product: your files live in one place, sync across devices, stay backed up, and are easy to co-edit with a team. If what you need is a durable home for files you will come back to, Drive is a reasonable default, and this article is not trying to talk you out of that.",
    "But a lot of what people use Drive for is really a one-off hand-off — sending a video to a friend, a contract to a client, a dataset to a colleague — not durable storage. For that specific job, uploading a copy to Google's servers and then configuring who can see it is more machinery than the task needs. Relayium is built for exactly that hand-off: realtime transfer keeps no server-side content copy, using a direct browser path on a LAN or end-to-end encrypted TURN across networks, while an optional stored link can be decrypted only by your recipient.",
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
        "Relayium skips server-side content storage for the common realtime case. On a LAN, browser files move directly between devices; across networks, browser sessions use TURN by design, and the relay carries only end-to-end encrypted ciphertext it cannot read or decrypt. When the recipient is offline and you do want a link, the stored-link mode keeps the zero-knowledge property Drive doesn't have: your browser encrypts the file with a random AES-256-GCM key before upload, and that key lives only in the URL fragment (the part after the #, which browsers never send to a server). Google's servers hold and can technically read your Drive files; Relayium's server, for a stored link, holds only ciphertext it cannot decrypt.",
      ],
    },
    {
      heading: "Realtime: no server-side content copy",
      body: [
        "For the classic case — both people are online right now — realtime transfer sends up to 1,000 files in one batch without storing a server-side content copy. Browser files move directly on a LAN; across networks, TURN carries only end-to-end encrypted ciphertext the relay cannot read or decrypt. Both sides see a matching 6-digit verification code (SAS), each file is checked end to end with SHA-256, and an interrupted transfer resumes instead of restarting.",
        "There's no server-side size cap, so the practical limit comes from the receiving browser: Chrome and Edge stream incoming data straight to disk, comfortably handling tens of gigabytes. Firefox and Safari lack that API, and when no streaming path applies they hold the incoming data in memory instead — Relayium warns above roughly 256 MB, a deliberately conservative estimate rather than a measured hard limit. On the same network, no account is needed at all and the two devices connect directly to each other. Sending across networks uses a pairing code, requires whoever creates that code to sign in, and runs over an encrypted TURN relay by design, so the connection comes up in a second or two rather than waiting out direct-connection attempts that rarely succeed between two networks; the relay only ever forwards ciphertext it cannot read, and the recipient never needs an account on either network setup.",
      ],
    },
    {
      heading: "Still want a link? Zero-knowledge stored links",
      body: [
        "Sometimes a link really is what you need — the recipient isn't online, or you want one URL you can paste anywhere. Relayium's stored-link mode covers that case without giving up the privacy of realtime mode.",
        "You choose an expiry — 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan — or set the link to burn after the first completed download. Creating a link requires the sender to sign in (it counts against a storage quota on your account), but the recipient just opens the link and downloads, no account required. Because the decryption key never leaves the URL fragment, Google's model and Relayium's stored-link model differ on one core point: Google can technically decrypt Drive-hosted files; Relayium's server, for stored links, structurally cannot.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: ["The differences that matter most, side by side:"],
      bullets: [
        "Purpose: Google Drive is durable, always-there storage with collaboration built in; Relayium is built for a one-off send — realtime P2P or a self-expiring link.",
        "Where files live: Drive keeps an indefinite copy on Google's servers until you delete it; Relayium realtime never stores the file at all, and stored links auto-expire (1h/1d/3d/7d, depending on plan) or burn after first download.",
        "Who can read it: Google's infrastructure can technically decrypt Drive files; Relayium's stored links are zero-knowledge — the key lives only in the URL fragment, so the server holds ciphertext it can't read.",
        "Accounts: Drive requires a Google account for the sender, and often for the recipient depending on sharing settings; Relayium needs no account on the same network, and only the person who creates the pairing code or the stored link signs in — the recipient never needs one.",
        "Size limits: Drive is bounded by your storage quota; Relayium realtime has no server-side cap (Chrome/Edge stream to disk for tens of GB; when the browser has to buffer in memory instead, Relayium warns above roughly 256 MB).",
        "Cost and openness: Relayium is free and AGPL-3.0-licensed at github.com/relayium/relayium, running in the browser on Windows, macOS, Linux, Android, and iOS with nothing to install.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does Relayium store my files like Google Drive does?",
        a: "Not in realtime mode: Relayium keeps no server-side copy of the content. Browser files move directly on a LAN; across networks, TURN carries only end-to-end encrypted ciphertext the relay cannot read or decrypt. A download link does store zero-knowledge ciphertext the server cannot decrypt; it expires (1h/1d/3d/7d, depending on plan) or burns after the first download.",
      },
      {
        q: "Do I need an account?",
        a: "On the same network, no account is needed at all. Creating the pairing code for a cross-network send, or creating a stored download link, requires signing in. The recipient never needs an account, in either case.",
      },
      {
        q: "Is there a size limit?",
        a: "Realtime transfers carry up to 1,000 files per batch with no server-side size cap — Chrome and Edge stream straight to disk for tens of gigabytes. When no streaming path applies and the browser has to buffer in memory, Relayium warns above roughly 256 MB; that figure is a deliberately conservative estimate, not a hard limit. Stored links count against a quota tied to your account.",
      },
      {
        q: "Is Relayium free?",
        a: "Yes. Relayium is free and open source under the AGPL-3.0 license, with the full protocol and code at github.com/relayium/relayium — no paid tier to unlock bigger or faster transfers.",
      },
    ],
  },
  cta: {
    text: "Send a file by realtime transfer without storing it in anyone's cloud — no server-side size cap, no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 Google Drive：发送文件更直接",
  description:
    "客观对比：一次性发送文件时，Google Drive 擅长的是持久存储，但发送意味着上传并管理权限；Relayium 不保存实时内容的服务端副本，浏览器在局域网内直连、跨网络时经端到端加密的 TURN 中继，或使用零知识加密的自动到期链接。",
  updatedLabel: "最近更新",
  lead: [
    "Google Drive 确实是个好产品：文件集中存放、跨设备同步、自动备份，团队协作编辑也很顺手。如果你需要的是一个会反复用到的文件存放地，Drive 是合理的默认选择，本文并不打算劝你放弃它。",
    "但很多人用 Drive 做的其实是一次性的「交接」——把一段视频发给朋友、把合同发给客户、把数据集发给同事——而不是持久存储。对这类具体任务来说，把一份副本上传到 Google 的服务器、再配置谁能看到它，比任务本身需要的步骤要多。Relayium 正是为这种交接而生：实时传输不保存服务端内容副本，浏览器在局域网内直连、跨网络时经端到端加密的 TURN 中继；可选存储链接则只有接收方能解密。",
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
        "要通过 Drive 发送一个文件，你需要把一份副本上传到 Google 的基础设施上，再决定谁能打开它——某个具体人的 Google 账号，或者「拥有链接的任何人」。分享设置一旦设错，文件要么无法访问，要么比你想的更公开。无论哪种情况，一份副本都会无限期地留在 Google 的服务器上，直到你回去把它删掉。",
        "对常见的实时场景，Relayium 跳过服务端内容存储。局域网内浏览器文件在设备间直连；跨网络时，浏览器会话按设计使用 TURN，中继只承载端到端加密且无法读取或解密的密文。当接收方不在线、你确实需要一个链接时，存储链接模式保留了 Drive 所没有的零知识特性：你的浏览器会在上传前用随机生成的 AES-256-GCM 密钥加密文件，而这个密钥只存在于 URL 片段中（# 之后的部分，浏览器从不把它发给服务器）。Google 的服务器持有并且在技术上可以读取你 Drive 里的文件；而 Relayium 的服务器对于存储链接，只保存它无法解密的密文。",
      ],
    },
    {
      heading: "实时模式：不保存服务端内容副本",
      body: [
        "对于最典型的场景——双方现在都在线——实时传输可以一次发送最多 1,000 个文件，且不保存服务端内容副本。浏览器文件在局域网内直连；跨网络时，TURN 只承载中继无法读取或解密的端到端加密密文。双方会看到一致的 6 位校验码（SAS），每个文件都用 SHA-256 做端到端校验；连接中断时会断点续传。",
        "实时传输没有服务器端的大小上限，实际限制取决于接收方的浏览器：Chrome 和 Edge 会把接收的数据直接流式写入磁盘，轻松应对几十 GB 的文件；Firefox 和 Safari 没有这套 API，当所有流式写盘路径都不适用时，它们只能把数据攒在内存里——Relayium 会在超过约 256 MB 时给出提示，这是刻意取的保守估计，而不是实测出来的硬上限。同一网络下完全无需账号，两台设备之间是直连。跨网络发送使用配对码，需要创建配对码的一方登录，并且刻意经由加密的 TURN 中继传输，因此连接一两秒就能建立，不必去等两个网络之间很难成功的直连尝试；中继只转发它读不懂的密文，而无论哪种网络场景，接收方都始终无需账号。",
      ],
    },
    {
      heading: "还是想要一个链接？零知识存储链接",
      body: [
        "有时候你确实需要一个链接——接收方不在线，或者你想要一个可以贴到任何地方的 URL。Relayium 的存储链接模式覆盖了这种场景，同时不牺牲实时模式的隐私性。",
        "你可以选择有效期——1 小时、1 天、3 天、7 天或最长 14 天（取决于套餐）——或者设置为首次下载后即焚。创建链接需要发送方登录（会计入账号的存储配额），但接收方只需打开链接下载，无需账号。因为解密密钥从不离开 URL 片段，Google 的模式和 Relayium 存储链接的模式在一个核心点上不同：Google 在技术上可以解密 Drive 上托管的文件；而 Relayium 的服务器对存储链接来说，从结构上就做不到这一点。",
      ],
    },
    {
      heading: "功能一览对比",
      body: ["把最关键的差别并排列出："],
      bullets: [
        "定位：Google Drive 是内置协作能力的、始终在线的持久存储；Relayium 是为一次性发送而生——实时点对点或自动到期的链接。",
        "文件存放：Drive 会把副本无限期留在 Google 服务器上，直到你删除；Relayium 实时模式根本不存储文件，存储链接则会自动到期（1小时/1天/3天/7天，视套餐而定）或首次下载后即焚。",
        "谁能读取：Google 的基础设施在技术上可以解密 Drive 上的文件；Relayium 的存储链接是零知识的——密钥只存在于 URL 片段中，服务器保存的是它无法解读的密文。",
        "账号要求：Drive 要求发送方有 Google 账号，收件方是否需要则取决于分享设置；Relayium 在同一网络下完全无需账号，只有创建配对码或存储链接的一方需要登录——接收方始终无需账号。",
        "大小限制：Drive 的限制取决于你的存储配额；Relayium 实时模式没有服务器端上限（Chrome/Edge 可流式写盘应对几十 GB；浏览器只能攒内存时，Relayium 会在超过约 256 MB 时给出提示）。",
        "费用与开放：Relayium 免费且采用 AGPL-3.0 许可，代码在 github.com/relayium/relayium；在浏览器中运行，覆盖 Windows、macOS、Linux、Android 和 iOS，无需安装。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 会像 Google Drive 一样存储我的文件吗？",
        a: "实时模式下不会：Relayium 不保存内容的服务端副本。浏览器文件在局域网内直连；跨网络时，TURN 只承载中继无法读取或解密的端到端加密密文。下载链接会保存服务器无法解密的零知识密文，并在到期（1小时/1天/3天/7天，视套餐而定）或首次下载后即焚。",
      },
      {
        q: "需要账号吗？",
        a: "同一网络下完全无需账号。为跨网络发送创建配对码，或创建存储下载链接，都需要登录。无论哪种情况，接收方都始终无需账号。",
      },
      {
        q: "有大小限制吗？",
        a: "实时传输一次最多可发送 1,000 个文件，没有服务器端大小上限——Chrome 和 Edge 会直接流式写入磁盘，可应对几十 GB 的文件。当所有流式写盘路径都不适用、浏览器只能攒内存时，Relayium 会在超过约 256 MB 时给出提示；这个数字是刻意取的保守估计，不是硬上限。存储链接则计入与账号绑定的配额。",
      },
      {
        q: "Relayium 免费吗？",
        a: "免费。Relayium 采用 AGPL-3.0 许可，是免费开源软件，完整的协议与代码都在 github.com/relayium/relayium——没有付费档去解锁更大或更快的传输。",
      },
    ],
  },
  cta: {
    text: "通过实时传输发送文件，无需存入任何人的云盘——无服务器端大小上限、无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と Google Drive の比較：ファイル送信をもっと直接に",
  description:
    "公平な比較。Google Drive は永続的な保存に優れますが、送るとなるとアップロードと権限管理が必要です。Relayium はリアルタイム内容のサーバー側コピーを保存せず、ブラウザは LAN では直接、ネットワーク間ではエンドツーエンド暗号化 TURN リレーを使うほか、ゼロ知識・自動失効リンクも使えます。",
  updatedLabel: "最終更新",
  lead: [
    "Google Drive は本当に優れた製品です。ファイルは一箇所にまとまり、端末間で同期され、バックアップされ、チームでの共同編集も簡単です。何度も戻ってくるファイルの置き場所が必要なら、Drive は妥当な選択肢であり、本記事はそれをやめさせようとするものではありません。",
    "しかし多くの人が Drive を使っている場面は、実は一度きりの受け渡しです。友人に動画を送る、クライアントに契約書を送る、同僚にデータセットを送るといったことであり、永続的な保存ではありません。その特定の作業のためだけに、コピーを Google のサーバーへアップロードし、誰が見られるかを設定するのは、必要以上の手間です。Relayium のリアルタイム転送はサーバー側の内容コピーを保存せず、ブラウザは LAN では直接、ネットワーク間ではエンドツーエンド暗号化 TURN を使います。保存リンクは受信者だけが復号できます。",
  ],
  sections: [
    {
      heading: "Google Drive が優れている点",
      body: [
        "Drive の強みは永続性と協業です。アップロードしたファイルは、スマートフォン、ノートパソコン、Web の間で同期されながら、削除するまでそこに残り続けます。これはまさに、作業用フォルダやチーム共有ドライブ、リアルタイムで共同編集する文書に求められることです。",
        "保存についても気前が良く、手間がかかりません。十分な無料枠、自動バックアップ、バージョン履歴、これまで保存したすべてを対象にした検索。これらは Relayium が置き換えようとしているものではありません。",
      ],
    },
    {
      heading: "違いはどこか：送ることと保存することは同じ作業ではない",
      body: [
        "Drive で1つのファイルを送るには、コピーを Google のインフラにアップロードし、誰が開けるかを決めます。特定の人の Google アカウント、または「リンクを知っている全員」。共有設定を間違えると、ファイルが届かなくなるか、意図したより公開範囲が広くなります。いずれにせよ、コピーは後で削除しに戻るまで、Google のサーバー上に無期限に存在し続けます。",
        "Relayium はよくあるリアルタイムのケースでサーバー側の内容保存を省きます。LAN ではブラウザのファイルは端末間を直接移動し、ネットワークをまたぐ場合は設計上 TURN を使い、リレーは読み取りも復号もできないエンドツーエンド暗号文だけを運びます。受信者がオフラインで、それでもリンクが欲しいときは、保存リンクモードが Drive にはないゼロ知識の性質を保ちます。ブラウザはアップロード前にランダムな AES-256-GCM 鍵でファイルを暗号化し、その鍵は URL フラグメント（# の後の部分。ブラウザが決してサーバーへ送らない部分）にだけ存在します。Google のサーバーは Drive 上のファイルを保持し、技術的には読むことができます。一方 Relayium のサーバーは、保存リンクについては復号できない暗号文しか保持しません。",
      ],
    },
    {
      heading: "リアルタイム：サーバー側の内容コピーを保存しない",
      body: [
        "典型的なケース（両者が今まさにオンライン）では、リアルタイム転送は最大1,000ファイルを1バッチで送り、サーバー側の内容コピーを保存しません。ブラウザのファイルは LAN では直接移動し、ネットワーク間では TURN がリレーの読み取り・復号できないエンドツーエンド暗号文だけを運びます。両端の SAS とファイルごとの SHA-256 を検証し、切断後は再開します。",
        "サーバー側のサイズ上限はないため、実用上の限界は受信側のブラウザ次第です。Chrome と Edge は受信データをそのままディスクにストリーミングし、数十ギガバイトでも問題なく扱えます。Firefox と Safari にはその API がなく、ストリーミングで書き出せる経路がどれも使えないときは受信データをメモリに保持します。Relayium は約256MBを超えると警告しますが、これは実測された上限ではなく、意図的に保守的な見積もりです。同じネットワーク内ではアカウントは一切不要で、2台の端末は直接つながります。ネットワークをまたぐ送信にはペアリングコードを使い、そのコードを作る側のサインインが必要で、設計上は暗号化された TURN リレーを経由します。そのため、ネットワーク同士ではめったに成功しない直接接続の試行を待たずに1〜2秒でつながります。リレーが中継するのは読めない暗号文だけで、どちらのネットワーク構成でも受信側は常にアカウント不要です。",
      ],
    },
    {
      heading: "それでもリンクが欲しいときは：ゼロ知識の保存リンク",
      body: [
        "リンクが本当に必要な場面もあります。受信者がオンラインでない、あるいはどこにでも貼れる1つの URL が欲しいときです。Relayium の保存リンクモードは、リアルタイムモードのプライバシーを犠牲にせずこのケースをカバーします。",
        "有効期限は1時間・1日・3日・7日・最長14日（プランによる）から選ぶか、最初のダウンロード完了後に削除する設定にできます。リンクの作成には送信側のサインインが必要です（アカウントの保存容量枠に計上されます）が、受信側はリンクを開いてダウンロードするだけでアカウントは不要です。復号鍵が URL フラグメントから外に出ることは決してないため、Google のモデルと Relayium の保存リンクのモデルには核心的な違いがあります。Google は Drive にホストされたファイルを技術的に復号できますが、Relayium のサーバーは保存リンクについて構造的にそれができません。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: ["最も重要な違いを並べて示します。"],
      bullets: [
        "目的：Google Drive は協業機能を備えた常時利用可能な永続ストレージです。Relayium は一度きりの送信のために作られており、リアルタイム P2P か自動失効するリンクを使います。",
        "ファイルの置き場所：Drive は削除するまでコピーを Google のサーバーに無期限に保持します。Relayium のリアルタイムはファイルを一切保存せず、保存リンクは自動失効（1時間/1日/3日/7日、プランによる）するか初回ダウンロード後に削除されます。",
        "誰が読めるか：Google のインフラは技術的に Drive 上のファイルを復号できます。Relayium の保存リンクはゼロ知識で、鍵は URL フラグメントにだけ存在し、サーバーは読めない暗号文を保持します。",
        "アカウント：Drive は送信側に Google アカウントを要求し、共有設定によっては受信側にも必要です。Relayium は同一ネットワークではアカウント不要で、ペアリングコードや保存リンクを作る側だけがサインインします。受信側は常にアカウント不要です。",
        "サイズ上限：Drive は保存容量枠に制約されます。Relayium のリアルタイムはサーバー側の上限がありません（Chrome/Edge は数十GBまでディスクへストリーミング。ブラウザがメモリに溜めるしかない場合は約256MBを超えると警告）。",
        "費用と開放性：Relayium は無料で AGPL-3.0 ライセンス、github.com/relayium/relayium にあり、ブラウザで Windows・macOS・Linux・Android・iOS で動作し、インストールは不要です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium は Google Drive のようにファイルを保存しますか？",
        a: "リアルタイムモードでは Relayium は内容のサーバー側コピーを保存しません。ブラウザのファイルは LAN では直接移動し、ネットワーク間では TURN がリレーの読取り・復号できないエンドツーエンド暗号文だけを運びます。ダウンロードリンクでは復号できないゼロ知識暗号文を保存し、失効時（1時間/1日/3日/7日、プランによる）または最初のダウンロード後に削除します。",
      },
      {
        q: "アカウントは必要ですか？",
        a: "同じネットワーク内ではアカウントは一切不要です。ネットワークをまたぐ送信のためにペアリングコードを作る場合や、保存ダウンロードリンクを作成する場合は、サインインが必要です。どちらの場合も受信側は常にアカウント不要です。",
      },
      {
        q: "サイズに上限はありますか？",
        a: "リアルタイム転送は1バッチにつき最大1,000ファイルまで扱え、サーバー側のサイズ上限はありません。Chrome と Edge は数十ギガバイトまでそのままディスクにストリーミングします。ストリーミングで書き出せる経路がどれも使えず、ブラウザがメモリに溜めるしかない場合、Relayium は約256MBを超えると警告します。この数字は意図的に保守的な見積もりで、ハードな上限ではありません。保存リンクはアカウントに紐づく容量枠に計上されます。",
      },
      {
        q: "Relayium は無料ですか？",
        a: "はい。Relayium は AGPL-3.0 ライセンスの無料オープンソースで、プロトコルとコードのすべてが github.com/relayium/relayium にあります。より大きく、より速い転送を解放する有料プランはありません。",
      },
    ],
  },
  cta: {
    text: "リアルタイム転送で、誰のクラウドにも保存せずファイルを送りましょう。サーバー側のサイズ上限もインストールもなく、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs Google Drive: 파일을 더 직접적으로 보내기",
  description:
    "공정한 비교입니다. Google Drive는 영구 저장에 뛰어나지만, 보내려면 업로드하고 권한을 관리해야 합니다. Relayium은 실시간 내용의 서버 측 사본을 저장하지 않으며 브라우저는 LAN에서 직접, 네트워크 간에는 종단간 암호화 TURN 릴레이를 사용하거나 영지식·자동 만료 링크를 만듭니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Google Drive는 정말 훌륭한 제품입니다. 파일이 한곳에 모여 있고, 기기 간 동기화되며, 백업되고, 팀과 함께 실시간으로 편집하기도 쉽습니다. 계속 다시 찾게 될 파일의 영구적인 보관 장소가 필요하다면 Drive는 합리적인 기본 선택지이며, 이 글은 그것을 그만두라고 설득하려는 것이 아닙니다.",
    "하지만 많은 사람이 Drive로 하는 일은 실제로는 일회성 전달입니다. 친구에게 동영상을 보내거나, 고객에게 계약서를 보내거나, 동료에게 데이터셋을 보내는 일이지 영구 저장이 아닙니다. 그 특정 작업만 놓고 보면, 사본을 Google 서버에 업로드하고 누가 볼 수 있는지 설정하는 것은 작업에 필요한 것보다 더 많은 절차입니다. Relayium의 실시간 전송은 서버 측 내용 사본을 저장하지 않고, 브라우저는 LAN에서 직접, 네트워크 간에는 종단간 암호화 TURN을 사용합니다. 저장 링크는 받는 사람만 복호화할 수 있습니다.",
  ],
  sections: [
    {
      heading: "Google Drive가 잘하는 것",
      body: [
        "Drive의 강점은 영속성과 협업입니다. 업로드한 파일은 휴대폰, 노트북, 웹 사이에서 동기화되며 삭제할 때까지 그곳에 계속 남아 있습니다. 이는 작업 폴더나 팀 공유 드라이브, 실시간으로 함께 편집하는 문서에 정확히 필요한 것입니다.",
        "저장 측면에서도 관대하고 손이 덜 갑니다. 넉넉한 무료 등급, 자동 백업, 버전 기록, 그동안 저장한 모든 것에 대한 검색까지. 이런 것들은 Relayium이 대체하려는 것이 아닙니다.",
      ],
    },
    {
      heading: "차이가 나는 지점: 보내는 것과 저장하는 것은 같은 일이 아니다",
      body: [
        "Drive로 파일 하나를 보내려면 사본을 Google 인프라에 업로드한 뒤, 누가 열 수 있는지 정해야 합니다. 특정 사람의 Google 계정, 또는 ‘링크가 있는 모든 사람’. 공유 설정을 잘못하면 파일에 접근할 수 없거나 의도한 것보다 더 공개됩니다. 어느 쪽이든, 사본은 나중에 직접 돌아가 지울 때까지 Google 서버에 무기한 남아 있습니다.",
        "Relayium은 흔한 실시간 경우에 서버 측 내용 저장을 건너뜁니다. LAN에서는 브라우저 파일이 기기 사이를 직접 이동하고, 네트워크를 넘으면 브라우저 세션은 설계상 TURN을 사용하며 릴레이는 읽거나 복호화할 수 없는 종단간 암호문만 운반합니다. 받는 사람이 오프라인이라 링크가 정말로 필요할 때는, 저장 링크 모드가 Drive에는 없는 영지식 속성을 유지합니다. 브라우저가 업로드 전에 무작위로 생성한 AES-256-GCM 키로 파일을 암호화하고, 그 키는 URL 프래그먼트, 즉 # 뒤의 브라우저가 서버로 절대 보내지 않는 부분에만 존재합니다. Google의 서버는 Drive 파일을 보관하며 기술적으로 읽을 수 있습니다. 반면 Relayium의 서버는 저장 링크에 대해 복호화할 수 없는 암호문만 보관합니다.",
      ],
    },
    {
      heading: "실시간: 서버 측 내용 사본을 저장하지 않음",
      body: [
        "가장 전형적인 경우(두 사람이 지금 모두 온라인)에는 실시간 전송이 한 번에 최대 1,000개 파일을 보내며 서버 측 내용 사본을 저장하지 않습니다. 브라우저 파일은 LAN에서 직접 이동하고, 네트워크 간에는 TURN이 릴레이가 읽거나 복호화할 수 없는 종단간 암호문만 운반합니다. 양쪽 SAS와 파일별 SHA-256을 확인하며, 연결이 끊기면 이어서 재개됩니다.",
        "서버 측 크기 제한이 없으므로 실질적인 한계는 받는 쪽 브라우저에서 옵니다. Chrome과 Edge는 들어오는 데이터를 곧바로 디스크로 스트리밍해 수십 기가바이트도 무리 없이 처리합니다. Firefox와 Safari에는 그 API가 없어, 디스크로 흘려보낼 경로가 하나도 적용되지 않으면 들어오는 데이터를 메모리에 담습니다. Relayium은 약 256 MB를 넘으면 경고하는데, 이는 측정된 하드 한계가 아니라 일부러 보수적으로 잡은 추정치입니다. 같은 네트워크에서는 계정이 전혀 필요 없고, 두 기기가 서로 직접 연결됩니다. 네트워크를 넘어 보낼 때는 페어링 코드를 쓰고, 그 코드를 만드는 쪽의 로그인이 필요하며, 설계상 암호화된 TURN 릴레이를 거칩니다. 덕분에 네트워크 사이에서는 좀처럼 성공하지 않는 직접 연결 시도를 기다리지 않고 1~2초 만에 연결됩니다. 릴레이는 스스로 읽을 수 없는 암호문만 전달하고, 어느 네트워크 구성이든 받는 쪽은 항상 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "그래도 링크가 필요하다면: 영지식 저장 링크",
      body: [
        "때로는 정말로 링크가 필요합니다. 받는 사람이 온라인이 아니거나, 어디에든 붙여넣을 수 있는 URL 하나가 필요할 때입니다. Relayium의 저장 링크 모드는 실시간 모드의 프라이버시를 포기하지 않고 이 경우를 다룹니다.",
        "만료 기간을 1시간, 1일, 3일, 7일, 최대 14일(요금제에 따라 다름) 중에서 고르거나, 첫 다운로드 완료 후 삭제되도록 설정할 수 있습니다. 링크 생성에는 보내는 쪽의 로그인이 필요하지만(계정의 저장 용량 한도에 포함됩니다), 받는 쪽은 링크를 열어 다운로드하기만 하면 되고 계정은 필요 없습니다. 복호화 키가 URL 프래그먼트를 벗어나는 일이 없기 때문에, Google의 모델과 Relayium의 저장 링크 모델은 핵심적인 지점에서 다릅니다. Google은 기술적으로 Drive에 호스팅된 파일을 복호화할 수 있지만, Relayium의 서버는 저장 링크에 대해 구조적으로 그렇게 할 수 없습니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: ["가장 중요한 차이를 나란히 정리하면:"],
      bullets: [
        "목적: Google Drive는 협업 기능을 갖춘, 항상 그 자리에 있는 영구 저장소임. Relayium은 일회성 전송을 위해 만들어졌고, 실시간 P2P 또는 자동 만료 링크를 씀.",
        "파일이 놓이는 곳: Drive는 삭제할 때까지 사본을 Google 서버에 무기한 보관함. Relayium 실시간은 파일을 아예 저장하지 않고, 저장 링크는 자동 만료(1시간/1일/3일/7일, 요금제에 따라 다름)되거나 첫 다운로드 후 삭제됨.",
        "누가 읽을 수 있는가: Google의 인프라는 기술적으로 Drive 파일을 복호화할 수 있음. Relayium의 저장 링크는 영지식으로, 키가 URL 프래그먼트에만 있어 서버는 읽을 수 없는 암호문을 보관함.",
        "계정: Drive는 보내는 쪽에 Google 계정을 요구하고, 공유 설정에 따라 받는 쪽에도 필요할 수 있음. Relayium은 같은 네트워크에서 계정이 전혀 필요 없고, 페어링 코드나 저장 링크를 만드는 쪽만 로그인함. 받는 쪽은 항상 계정 불필요.",
        "크기 제한: Drive는 저장 용량 한도에 제약됨. Relayium 실시간은 서버 측 제한 없음(Chrome/Edge는 수십 GB까지 디스크로 스트리밍하고, 브라우저가 메모리에 담을 수밖에 없을 때는 약 256 MB를 넘으면 경고).",
        "비용과 개방성: Relayium은 무료이며 AGPL-3.0 라이선스로 github.com/relayium/relayium에 있고, 브라우저에서 Windows·macOS·Linux·Android·iOS로 동작하며 설치가 필요 없음.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium도 Google Drive처럼 제 파일을 저장하나요?",
        a: "실시간 모드에서는 Relayium이 내용의 서버 측 사본을 저장하지 않습니다. 브라우저 파일은 LAN에서 직접 이동하고, 네트워크 간에는 TURN이 릴레이가 읽거나 복호화할 수 없는 종단간 암호문만 운반합니다. 다운로드 링크는 복호화할 수 없는 영지식 암호문을 저장하며, 만료되거나(1시간/1일/3일/7일, 요금제에 따라 다름) 첫 다운로드 후 삭제됩니다.",
      },
      {
        q: "계정이 필요한가요?",
        a: "같은 네트워크에서는 계정이 전혀 필요 없습니다. 네트워크를 넘어 보내기 위한 페어링 코드를 만들거나 저장 다운로드 링크를 만들 때는 로그인이 필요합니다. 어느 경우든 받는 쪽은 항상 계정이 필요 없습니다.",
      },
      {
        q: "크기 제한이 있나요?",
        a: "실시간 전송은 한 번에 최대 1,000개 파일을 다룰 수 있고 서버 측 크기 제한이 없습니다. Chrome과 Edge는 수십 기가바이트까지 곧바로 디스크로 스트리밍합니다. 디스크로 흘려보낼 경로가 하나도 적용되지 않아 브라우저가 메모리에 담아야 할 때는 Relayium이 약 256 MB를 넘으면 경고합니다. 이 수치는 일부러 보수적으로 잡은 추정치이지 하드 한계가 아닙니다. 저장 링크는 계정에 연결된 용량 한도에 포함됩니다.",
      },
      {
        q: "Relayium은 무료인가요?",
        a: "네. Relayium은 AGPL-3.0 라이선스의 무료 오픈소스이며, 프로토콜과 코드 전체가 github.com/relayium/relayium에 있습니다. 더 크거나 빠른 전송을 여는 유료 등급은 없습니다.",
      },
    ],
  },
  cta: {
    text: "실시간 전송으로 누구의 클라우드에도 저장하지 않고 파일을 보내세요. 서버 측 크기 제한과 설치가 없고, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. Google Drive: Dateien direkter versenden",
  description:
    "Ein fairer Vergleich: Google Drive ist stark bei dauerhafter Speicherung, aber Versenden heißt Hochladen und Berechtigungen verwalten. Relayium speichert keine serverseitige Kopie von Echtzeitinhalten: Browserdateien laufen im LAN direkt und netzübergreifend über ein Ende-zu-Ende-verschlüsseltes TURN-Relay; alternativ gibt es einen Zero-Knowledge-Link mit Ablaufdatum.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Google Drive ist ein wirklich gutes Produkt: Deine Dateien liegen an einem Ort, synchronisieren sich über Geräte hinweg, sind gesichert und lassen sich leicht im Team gemeinsam bearbeiten. Wenn du ein dauerhaftes Zuhause für Dateien brauchst, zu denen du immer wieder zurückkehrst, ist Drive eine vernünftige Standardwahl — dieser Artikel will dich davon nicht abbringen.",
    "Aber vieles, wofür Leute Drive nutzen, ist eigentlich eine einmalige Übergabe — ein Video an einen Freund, ein Vertrag an eine Kundin, ein Datensatz an einen Kollegen — keine dauerhafte Speicherung. Für genau diese Aufgabe ist es mehr Aufwand als nötig, eine Kopie auf Googles Server zu laden und dann zu konfigurieren, wer sie sehen darf. Relayiums Echtzeitübertragung speichert keine serverseitige Inhaltskopie; Browser nutzen im LAN den direkten Pfad und netzübergreifend Ende-zu-Ende-verschlüsseltes TURN. Einen Speicherlink kann nur der Empfänger entschlüsseln.",
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
        "Um eine Datei per Drive zu senden, lädst du eine Kopie auf Googles Infrastruktur und entscheidest dann, wer sie öffnen darf — das Google-Konto einer bestimmten Person oder „jeder mit dem Link“. Stellst du die Freigabe falsch ein, ist die Datei entweder unerreichbar oder offener als beabsichtigt. So oder so liegt jetzt eine Kopie unbefristet auf Googles Servern, bis du zurückgehst und sie entfernst.",
        "Relayium überspringt im üblichen Echtzeitfall die serverseitige Inhaltsspeicherung. Im LAN laufen Browserdateien direkt zwischen den Geräten; netzübergreifend verwenden Browsersitzungen TURN per Design, und das Relay transportiert nur Ende-zu-Ende-verschlüsselten Text, den es weder lesen noch entschlüsseln kann. Ist der Empfänger offline und du willst wirklich einen Link, behält der Speicherlink-Modus die Zero-Knowledge-Eigenschaft, die Drive nicht hat: Dein Browser verschlüsselt die Datei vor dem Hochladen mit einem zufälligen AES-256-GCM-Schlüssel, und dieser Schlüssel lebt nur im URL-Fragment (dem Teil nach dem #, den Browser nie an einen Server senden). Googles Server halten deine Drive-Dateien und können sie technisch lesen; Relayiums Server hält bei einem Speicherlink nur Chiffretext, den er nicht entschlüsseln kann.",
      ],
    },
    {
      heading: "Echtzeit: keine serverseitige Inhaltskopie",
      body: [
        "Für den klassischen Fall — beide sind gerade online — sendet die Echtzeitübertragung bis zu 1.000 Dateien ohne serverseitige Inhaltskopie. Im LAN laufen Browserdateien direkt; netzübergreifend trägt TURN nur Ende-zu-Ende-verschlüsselten Text, den das Relay weder lesen noch entschlüsseln kann. Beide Seiten prüfen den SAS und jede Datei per SHA-256; nach einem Abbruch wird fortgesetzt.",
        "Es gibt kein serverseitiges Größenlimit, die praktische Grenze kommt also vom empfangenden Browser: Chrome und Edge streamen eingehende Daten direkt auf die Festplatte und bewältigen mühelos mehrere Dutzend Gigabyte. Firefox und Safari haben diese API nicht, und wenn kein Streaming-Weg greift, halten sie die eingehenden Daten stattdessen im Arbeitsspeicher — Relayium warnt oberhalb von rund 256 MB, einer bewusst konservativen Schätzung und keiner gemessenen harten Grenze. Im selben Netz ist überhaupt kein Konto nötig, und die beiden Geräte verbinden sich direkt miteinander. Beim Senden über Netzwerke hinweg per Pairing-Code muss sich anmelden, wer diesen Code erstellt, und die Übertragung läuft planmäßig über ein verschlüsseltes TURN-Relay, sodass die Verbindung in ein bis zwei Sekunden steht, statt auf Direktverbindungsversuche zu warten, die zwischen zwei Netzen selten gelingen; das Relay leitet nur Chiffretext weiter, den es nicht lesen kann, und der Empfänger braucht in keinem der beiden Fälle je ein Konto.",
      ],
    },
    {
      heading: "Doch einen Link gewünscht? Zero-Knowledge-Speicherlinks",
      body: [
        "Manchmal ist ein Link wirklich das, was du brauchst — der Empfänger ist nicht online, oder du willst eine URL, die du überall einfügen kannst. Relayiums Speicherlink-Modus deckt diesen Fall ab, ohne die Privatsphäre des Echtzeitmodus aufzugeben.",
        "Du wählst eine Ablaufzeit — 1 Stunde, 1 Tag, 3 Tage, 7 Tage oder bis zu 14 Tage je nach Tarif — oder stellst den Link so ein, dass er nach dem ersten vollständigen Download vernichtet wird. Das Erstellen eines Links erfordert die Anmeldung des Absenders (er zählt gegen ein Speicherkontingent deines Kontos), aber der Empfänger öffnet den Link einfach und lädt herunter, ohne Konto. Da der Entschlüsselungsschlüssel das URL-Fragment nie verlässt, unterscheiden sich Googles Modell und Relayiums Speicherlink-Modell in einem zentralen Punkt: Google kann Drive-gehostete Dateien technisch entschlüsseln; Relayiums Server kann das bei Speicherlinks strukturell nicht.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: ["Die wichtigsten Unterschiede nebeneinander:"],
      bullets: [
        "Zweck: Google Drive ist dauerhafter, stets verfügbarer Speicher mit eingebauter Zusammenarbeit; Relayium ist für den einmaligen Versand gebaut — Echtzeit-P2P oder ein Link mit Ablaufdatum.",
        "Wo Dateien liegen: Drive behält eine unbefristete Kopie auf Googles Servern, bis du sie löschst; Relayium-Echtzeit speichert die Datei überhaupt nicht, und Speicherlinks laufen automatisch ab (1 Std./1 Tag/3 Tage/7 Tage, je nach Tarif) oder werden nach dem ersten Download vernichtet.",
        "Wer es lesen kann: Googles Infrastruktur kann Drive-Dateien technisch entschlüsseln; Relayiums Speicherlinks sind Zero-Knowledge — der Schlüssel lebt nur im URL-Fragment, sodass der Server Chiffretext hält, den er nicht lesen kann.",
        "Konten: Drive verlangt vom Absender ein Google-Konto und je nach Freigabeeinstellung oft auch vom Empfänger; Relayium braucht im selben Netz kein Konto, und nur wer den Pairing-Code oder den Speicherlink erstellt, meldet sich an — der Empfänger nie.",
        "Größenlimits: Drive ist durch dein Speicherkontingent begrenzt; Relayium-Echtzeit hat kein serverseitiges Limit (Chrome/Edge streamen für mehrere Dutzend Gigabyte auf die Festplatte; muss der Browser stattdessen im Speicher puffern, warnt Relayium oberhalb von rund 256 MB).",
        "Kosten und Offenheit: Relayium ist kostenlos und AGPL-3.0-lizenziert unter github.com/relayium/relayium und läuft im Browser unter Windows, macOS, Linux, Android und iOS ohne Installation.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Speichert Relayium meine Dateien wie Google Drive?",
        a: "Im Echtzeitmodus speichert Relayium keine serverseitige Kopie des Inhalts. Browserdateien laufen im LAN direkt; netzübergreifend trägt TURN nur Ende-zu-Ende-verschlüsselten Text, den das Relay weder lesen noch entschlüsseln kann. Ein Download-Link speichert Zero-Knowledge-Chiffretext ohne Entschlüsselungsschlüssel und läuft ab (1 Std./1 Tag/3 Tage/7 Tage, je nach Tarif) oder wird nach dem ersten Download vernichtet.",
      },
      {
        q: "Brauche ich ein Konto?",
        a: "Im selben Netz ist überhaupt kein Konto nötig. Wer für einen netzübergreifenden Versand den Pairing-Code erstellt oder einen gespeicherten Download-Link anlegt, muss sich anmelden. Der Empfänger braucht in keinem der beiden Fälle je ein Konto.",
      },
      {
        q: "Gibt es ein Größenlimit?",
        a: "Echtzeitübertragungen fassen bis zu 1.000 Dateien pro Durchgang ohne serverseitiges Größenlimit — Chrome und Edge streamen für mehrere Dutzend Gigabyte direkt auf die Festplatte. Greift kein Streaming-Weg und muss der Browser im Arbeitsspeicher puffern, warnt Relayium oberhalb von rund 256 MB; diese Zahl ist eine bewusst konservative Schätzung, keine harte Grenze. Speicherlinks zählen gegen ein an dein Konto gebundenes Kontingent.",
      },
      {
        q: "Ist Relayium kostenlos?",
        a: "Ja. Relayium ist kostenlos und quelloffen unter der AGPL-3.0-Lizenz, mit dem vollständigen Protokoll und Code unter github.com/relayium/relayium — kein Bezahltarif, um größere oder schnellere Übertragungen freizuschalten.",
      },
    ],
  },
  cta: {
    text: "Sende eine Datei per Echtzeitübertragung, ohne sie in einer Cloud zu speichern — ohne serverseitiges Größenlimit, Installation oder Konto im selben Netz.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs Google Drive pour envoyer des fichiers",
  description:
    "Comparatif équitable : Google Drive excelle pour le stockage durable, mais envoyer signifie téléverser et gérer des permissions. Relayium ne conserve aucune copie côté serveur du contenu en temps réel : les fichiers du navigateur circulent directement sur un LAN et via un relais TURN chiffré de bout en bout entre réseaux, ou par un lien à divulgation nulle et expiration automatique.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Google Drive est un vrai bon produit : vos fichiers vivent au même endroit, se synchronisent entre appareils, restent sauvegardés, et se coéditent facilement en équipe. Si vous avez besoin d'un foyer durable pour des fichiers auxquels vous reviendrez, Drive est un choix par défaut raisonnable, et cet article n'essaie pas de vous en dissuader.",
    "Mais une grande partie de ce pour quoi les gens utilisent Drive est en réalité une remise ponctuelle — envoyer une vidéo à un ami, un contrat à un client, un jeu de données à un collègue — pas du stockage durable. Pour cette tâche précise, téléverser une copie sur les serveurs de Google puis configurer qui peut la voir demande plus de rouages que nécessaire. Le temps réel de Relayium ne conserve aucune copie de contenu côté serveur : navigateur direct sur le LAN, TURN chiffré de bout en bout entre réseaux. Seul le destinataire peut déchiffrer le lien stocké.",
  ],
  sections: [
    {
      heading: "Ce que Google Drive fait bien",
      body: [
        "La force de Drive, c'est la permanence et la collaboration. Un fichier téléversé y reste — synchronisé entre votre téléphone, votre ordinateur portable et le web — jusqu'à ce que vous le supprimiez, exactement ce qu'il faut pour un dossier de travail, un lecteur d'équipe partagé, ou des documents que vous coéditez en temps réel.",
        "Il est aussi généreux et sans friction côté stockage : une offre gratuite solide, une sauvegarde automatique, un historique des versions, et une recherche sur tout ce que vous avez jamais enregistré. Rien de tout cela n'est ce que Relayium cherche à remplacer.",
      ],
    },
    {
      heading: "Là où ils diffèrent : envoyer n'est pas la même tâche que stocker",
      body: [
        "Pour envoyer un fichier via Drive, vous téléversez une copie sur l'infrastructure de Google, puis décidez qui peut l'ouvrir — le compte Google d'une personne précise, ou « toute personne disposant du lien ». Si vous vous trompez de réglage de partage, le fichier devient soit inaccessible, soit plus ouvert que prévu. Dans les deux cas, une copie réside désormais indéfiniment sur les serveurs de Google, jusqu'à ce que vous reveniez la retirer.",
        "Relayium évite le stockage de contenu côté serveur dans le cas temps réel courant. Sur un LAN, les fichiers du navigateur circulent directement entre appareils ; entre réseaux, les sessions navigateur utilisent TURN par conception et le relais ne transporte que du texte chiffré de bout en bout qu'il ne peut ni lire ni déchiffrer. Quand le destinataire est hors ligne et que vous voulez vraiment un lien, le mode lien stocké conserve la propriété à divulgation nulle que Drive n'a pas : votre navigateur chiffre le fichier avec une clé AES-256-GCM aléatoire avant le téléversement, et cette clé ne vit que dans le fragment de l'URL (la partie après le #, que les navigateurs n'envoient jamais à un serveur). Les serveurs de Google détiennent vos fichiers Drive et peuvent techniquement les lire ; le serveur de Relayium, pour un lien stocké, ne détient qu'un texte chiffré qu'il ne peut pas déchiffrer.",
      ],
    },
    {
      heading: "Temps réel : aucune copie de contenu côté serveur",
      body: [
        "Pour le cas classique — les deux personnes sont en ligne — le temps réel envoie jusqu'à 1 000 fichiers sans copie de contenu côté serveur. Sur un LAN les fichiers du navigateur circulent directement ; entre réseaux TURN ne transporte que du texte chiffré de bout en bout que le relais ne peut ni lire ni déchiffrer. Les deux côtés vérifient le SAS et chaque fichier par SHA-256 ; une interruption reprend.",
        "Il n'y a aucune limite de taille côté serveur, la limite pratique vient donc du navigateur du destinataire : Chrome et Edge écrivent les données entrantes directement sur le disque, gérant sans peine plusieurs dizaines de gigaoctets. Firefox et Safari n'ont pas cette API et, quand aucun chemin d'écriture en flux ne s'applique, gardent les données entrantes en mémoire — Relayium prévient au-delà d'environ 256 Mo, une estimation volontairement prudente et non une limite dure mesurée. Sur le même réseau, aucun compte n'est nécessaire du tout et les deux appareils se connectent directement l'un à l'autre. Envoyer entre réseaux différents utilise un code d'appairage, exige que la personne qui crée ce code se connecte, et passe par conception par un relais TURN chiffré : la connexion s'établit ainsi en une ou deux secondes au lieu d'attendre des tentatives de connexion directe qui aboutissent rarement entre deux réseaux ; le relais ne transporte que du texte chiffré qu'il ne peut pas lire, et le destinataire n'a jamais besoin de compte, dans aucune des deux configurations réseau.",
      ],
    },
    {
      heading: "Vous voulez quand même un lien ? Liens stockés à divulgation nulle",
      body: [
        "Parfois un lien est vraiment ce qu'il vous faut — le destinataire n'est pas en ligne, ou vous voulez une seule URL à coller n'importe où. Le mode lien stocké de Relayium couvre ce cas sans renoncer à la confidentialité du mode temps réel.",
        "Vous choisissez une expiration — 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre — ou réglez le lien pour qu'il s'autodétruise après le premier téléchargement complet. Créer un lien exige que l'expéditeur se connecte (cela compte dans un quota de stockage lié à votre compte), mais le destinataire n'a qu'à ouvrir le lien et télécharger, sans compte requis. Comme la clé de déchiffrement ne quitte jamais le fragment de l'URL, le modèle de Google et celui des liens stockés de Relayium diffèrent sur un point essentiel : Google peut techniquement déchiffrer les fichiers hébergés sur Drive ; le serveur de Relayium, pour les liens stockés, ne le peut structurellement pas.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: ["Les différences qui comptent le plus, côte à côte :"],
      bullets: [
        "Objectif : Google Drive est un stockage durable, toujours disponible, avec collaboration intégrée ; Relayium est conçu pour un envoi ponctuel — P2P en temps réel ou lien à expiration automatique.",
        "Où résident les fichiers : Drive garde une copie indéfinie sur les serveurs de Google jusqu'à ce que vous la supprimiez ; le temps réel de Relayium ne stocke jamais le fichier du tout, et les liens stockés expirent automatiquement (1 h/1 j/3 j/7 j, selon l'offre) ou s'autodétruisent après le premier téléchargement.",
        "Qui peut le lire : l'infrastructure de Google peut techniquement déchiffrer les fichiers Drive ; les liens stockés de Relayium sont à divulgation nulle — la clé ne vit que dans le fragment de l'URL, donc le serveur détient un texte chiffré qu'il ne peut pas lire.",
        "Comptes : Drive exige un compte Google pour l'expéditeur, et souvent pour le destinataire selon les réglages de partage ; Relayium ne demande aucun compte sur le même réseau, et seule la personne qui crée le code d'appairage ou le lien stocké se connecte — le destinataire n'en a jamais besoin.",
        "Limites de taille : Drive est borné par votre quota de stockage ; le temps réel de Relayium n'a aucune limite côté serveur (Chrome/Edge écrivent sur le disque pour plusieurs dizaines de Go ; quand le navigateur doit mettre en mémoire tampon, Relayium prévient au-delà d'environ 256 Mo).",
        "Coût et ouverture : Relayium est gratuit et sous licence AGPL-3.0 sur github.com/relayium/relayium, et tourne dans le navigateur sur Windows, macOS, Linux, Android et iOS sans rien installer.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Relayium stocke-t-il mes fichiers comme Google Drive ?",
        a: "Pas en mode temps réel : Relayium ne conserve aucune copie du contenu côté serveur. Sur un LAN les fichiers circulent directement ; entre réseaux TURN ne transporte que du texte chiffré de bout en bout que le relais ne peut ni lire ni déchiffrer. Un lien stocke du texte chiffré à divulgation nulle sans clé de déchiffrement, puis expire (1 h/1 j/3 j/7 j, selon l'offre) ou s'autodétruit après le premier téléchargement.",
      },
      {
        q: "Ai-je besoin d'un compte ?",
        a: "Sur le même réseau, aucun compte n'est nécessaire du tout. Créer le code d'appairage pour un envoi entre réseaux, ou créer un lien de téléchargement stocké, exige d'être connecté. Le destinataire n'a jamais besoin de compte, dans les deux cas.",
      },
      {
        q: "Y a-t-il une limite de taille ?",
        a: "Les transferts en temps réel portent jusqu'à 1 000 fichiers par lot sans limite de taille côté serveur — Chrome et Edge écrivent directement sur le disque pour plusieurs dizaines de gigaoctets. Quand aucun chemin d'écriture en flux ne s'applique et que le navigateur doit mettre en mémoire tampon, Relayium prévient au-delà d'environ 256 Mo ; ce chiffre est une estimation volontairement prudente, pas une limite dure. Les liens stockés comptent dans un quota lié à votre compte.",
      },
      {
        q: "Relayium est-il gratuit ?",
        a: "Oui. Relayium est gratuit et open source sous licence AGPL-3.0, avec l'intégralité du protocole et du code sur github.com/relayium/relayium — aucune offre payante pour débloquer des transferts plus grands ou plus rapides.",
      },
    ],
  },
  cta: {
    text: "Envoyez un fichier en temps réel sans le stocker dans un cloud — sans plafond côté serveur, installation ni compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل Google Drive لإرسال الملفات",
  description:
    "مقارنة منصفة لعملية تسليم ملف لمرة واحدة: Google Drive تخزين دائم ممتاز، لكن الإرسال يعني الرفع وإدارة الأذونات. لا تحتفظ Relayium بنسخة على الخادم من المحتوى الفوري؛ تنتقل ملفات المتصفح مباشرة على LAN وعبر مُرحِّل TURN مشفّر من الطرف إلى الطرف بين الشبكات، أو عبر رابط ذاتي الانتهاء بمعرفة صفرية.",
  updatedLabel: "آخر تحديث",
  lead: [
    "Google Drive منتج جيد فعلًا: ملفاتك تعيش في مكان واحد، وتتزامن عبر الأجهزة، وتبقى منسوخة احتياطيًا، ويسهل تحريرها بشكل مشترك مع فريق. إن كان ما تحتاجه بيتًا دائمًا لملفات ستعود إليها، فإن Drive خيار افتراضي معقول، وهذه المقالة لا تحاول أن تثنيك عن ذلك.",
    "لكن كثيرًا مما يستخدم الناس Drive لأجله هو في الحقيقة تسليم لمرة واحدة — إرسال مقطع فيديو إلى صديق، أو عقد إلى عميل، أو مجموعة بيانات إلى زميل — لا تخزين دائم. لتلك المهمة تحديدًا، فإن رفع نسخة إلى خوادم Google ثم ضبط من يمكنه رؤيتها آليةٌ أكثر مما تتطلبه المهمة. لا يحتفظ النقل الفوري في Relayium بنسخة محتوى على الخادم؛ ينتقل المتصفح مباشرة على LAN ويستخدم TURN المشفّر من الطرف إلى الطرف عبر الشبكات. ولا يفك رابط التخزين إلا المُستقبِل.",
  ],
  sections: [
    {
      heading: "ما الذي يجيده Google Drive",
      body: [
        "قوة Drive في الدوام والتعاون. يبقى الملف الذي ترفعه هناك — متزامنًا عبر هاتفك وحاسوبك المحمول والويب — حتى تحذفه، وهذا بالضبط ما تريده لمجلد عمل، أو قرص فريق مشترك، أو مستندات تحرّرونها معًا في الوقت الفعلي.",
        "كما أنه سخيّ وسلس في التخزين: طبقة مجانية متينة، ونسخ احتياطي تلقائي، وسجل إصدارات، وبحث في كل ما حفظته يومًا. لا شيء من ذلك يحاول Relayium استبداله.",
      ],
    },
    {
      heading: "أين يختلفان: الإرسال ليس المهمة نفسها كالتخزين",
      body: [
        "لإرسال ملف واحد عبر Drive، ترفع نسخة إلى بنية Google التحتية، ثم تقرر من يمكنه فتحه — حساب Google لشخص محدد، أو «أي شخص لديه الرابط». إن أخطأت في إعداد المشاركة، صار الملف إما غير قابل للوصول أو أكثر انفتاحًا مما قصدت. وفي كلتا الحالتين، تصبح نسخة الآن مقيمة على خوادم Google إلى أجل غير مسمى، حتى تعود وتزيلها.",
        "يتخطى Relayium تخزين المحتوى على الخادم في الحالة الفورية الشائعة. على LAN تنتقل ملفات المتصفح مباشرة بين الجهازين؛ وعبر الشبكات تستخدم جلسات المتصفح TURN بحكم التصميم، ولا يحمل المُرحِّل سوى نص مشفّر من الطرف إلى الطرف لا يستطيع قراءته أو فك تشفيره. وعندما يكون المُستقبِل غير متصل وتريد فعلًا رابطًا، يحافظ وضع الرابط المُخزَّن على خاصية المعرفة الصفرية التي لا يملكها Drive: يشفّر متصفحك الملف بمفتاح AES-256-GCM عشوائي قبل الرفع، ويعيش ذلك المفتاح في جزء الـ URL فقط (الجزء بعد #، الذي لا ترسله المتصفحات أبدًا إلى خادم). تحتفظ خوادم Google بملفات Drive الخاصة بك وتستطيع تقنيًا قراءتها؛ أما خادم Relayium، بالنسبة إلى رابط مُخزَّن، فلا يحتفظ إلا بنص مُشفَّر لا يستطيع فكّ تشفيره.",
      ],
    },
    {
      heading: "الفوري: بلا نسخة محتوى على الخادم",
      body: [
        "للحالة الكلاسيكية — كلا الشخصين متصلان الآن — يرسل النقل الفوري حتى 1,000 ملف بلا نسخة محتوى على الخادم. على LAN تنتقل ملفات المتصفح مباشرة؛ وعبر الشبكات لا يحمل TURN سوى نص مشفّر من الطرف إلى الطرف لا يستطيع المُرحِّل قراءته أو فك تشفيره. يتحقق الطرفان من SAS ومن كل ملف عبر SHA-256، ويُستأنف النقل بعد الانقطاع.",
        "لا يوجد حدّ للحجم من جانب الخادم، لذا يأتي الحدّ العملي من متصفح الاستقبال: يبثّ Chrome وEdge البيانات الواردة مباشرةً إلى القرص، متعاملَين بأريحية مع عشرات الغيغابايت. أما Firefox وSafari فلا يملكان تلك الواجهة، وحين لا ينطبق أي مسار للكتابة التدفّقية يحتفظان بالبيانات الواردة في الذاكرة — ويحذّر Relayium فوق نحو 256 ميغابايت، وهو تقدير متحفّظ عن قصد لا حدّ صلب مقيس. على نفس الشبكة لا يلزم أي حساب على الإطلاق، ويتّصل الجهازان أحدهما بالآخر مباشرةً. أما الإرسال عبر الشبكات فيستخدم رمز اقتران، ويتطلب تسجيل دخول مُنشئ الرمز، ويمرّ بحكم التصميم عبر مُرحِّل TURN مشفّر، فينعقد الاتصال خلال ثانية أو ثانيتين بدل انتظار محاولات اتصال مباشر نادرًا ما تنجح بين شبكتين؛ والمُرحِّل لا ينقل سوى نص مُشفَّر لا يستطيع قراءته، ولا يحتاج المُستقبِل إلى حساب أبدًا، في أي من إعدادَي الشبكة.",
      ],
    },
    {
      heading: "ما زلت تريد رابطًا؟ روابط مُخزَّنة بمعرفة صفرية",
      body: [
        "أحيانًا يكون الرابط فعلًا ما تحتاجه — المُستقبِل غير متصل، أو تريد عنوان URL واحدًا يمكنك لصقه في أي مكان. يغطّي وضع الرابط المُخزَّن في Relayium تلك الحالة دون التخلي عن خصوصية الوضع الفوري.",
        "تختار مدة انتهاء — ساعة واحدة أو يوم واحد أو 3 أيام أو 7 أيام أو حتى 14 يومًا حسب خطتك — أو تضبط الرابط ليُحذف بعد أول تنزيل مكتمل. يتطلب إنشاء رابط تسجيل دخول المُرسِل (يُحتسب ضمن حصة تخزين في حسابك)، لكن المُستقبِل يفتح الرابط ويُنزّل فحسب، دون الحاجة إلى حساب. ولأن مفتاح فكّ التشفير لا يغادر جزء الـ URL أبدًا، يختلف نموذج Google ونموذج الرابط المُخزَّن في Relayium في نقطة جوهرية واحدة: تستطيع Google تقنيًا فكّ تشفير الملفات المستضافة على Drive؛ أما خادم Relayium فلا يمكنه ذلك بنيويًا بالنسبة إلى الروابط المُخزَّنة.",
      ],
    },
    {
      heading: "مقارنة الميزات في لمحة",
      body: ["الفروق الأهمّ، جنبًا إلى جنب:"],
      bullets: [
        "الغرض: Google Drive تخزين دائم متاح دومًا مع تعاون مدمج؛ أما Relayium فمبني للإرسال لمرة واحدة — إما فوري من الند للند أو رابط ذاتي الانتهاء.",
        "أين تعيش الملفات: يحتفظ Drive بنسخة غير محددة المدة على خوادم Google حتى تحذفها؛ أما Relayium الفوري فلا يخزّن الملف على الإطلاق، والروابط المُخزَّنة تنتهي تلقائيًا (ساعة/يوم/3 أيام/7 أيام، حسب الخطة) أو تُحذف بعد أول تنزيل.",
        "من يمكنه قراءتها: تستطيع بنية Google التحتية تقنيًا فكّ تشفير ملفات Drive؛ أما روابط Relayium المُخزَّنة فبمعرفة صفرية — يعيش المفتاح في جزء الـ URL فقط، فيحتفظ الخادم بنص مُشفَّر لا يستطيع قراءته.",
        "الحسابات: يتطلب Drive حساب Google للمُرسِل، وغالبًا للمُستقبِل بحسب إعدادات المشاركة؛ أما Relayium فلا يحتاج إلى حساب على نفس الشبكة، ولا يسجّل الدخول إلا من ينشئ رمز الاقتران أو الرابط المُخزَّن — والمُستقبِل لا يحتاج إليه أبدًا.",
        "حدود الحجم: Drive محدود بحصة التخزين لديك؛ أما Relayium الفوري فلا حدّ له من جانب الخادم (يبثّ Chrome/Edge إلى القرص لعشرات الغيغابايت؛ وحين يضطر المتصفح إلى التخزين في الذاكرة يحذّر Relayium فوق نحو 256 ميغابايت).",
        "التكلفة والانفتاح: Relayium مجاني ومرخّص بموجب AGPL-3.0 على github.com/relayium/relayium، ويعمل في المتصفح على Windows وmacOS وLinux وAndroid وiOS دون أي شيء يُثبَّت.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يخزّن Relayium ملفاتي كما يفعل Google Drive؟",
        a: "ليس في الوضع الفوري: لا تحتفظ Relayium بنسخة من المحتوى على الخادم. تنتقل ملفات المتصفح مباشرة على LAN؛ وعبر الشبكات لا يحمل TURN سوى نص مشفّر من الطرف إلى الطرف لا يستطيع المُرحِّل قراءته أو فك تشفيره. يخزّن رابط التنزيل نصًا مشفّرًا بمعرفة صفرية بلا مفتاح فك تشفير، وينتهي (ساعة/يوم/3 أيام/7 أيام، حسب الخطة) أو يُحذف بعد أول تنزيل.",
      },
      {
        q: "هل أحتاج إلى حساب؟",
        a: "على نفس الشبكة لا يلزم أي حساب على الإطلاق. أما إنشاء رمز الاقتران لإرسال عبر الشبكات، أو إنشاء رابط تنزيل مُخزَّن، فيتطلب تسجيل الدخول. أما المُستقبِل فلا يحتاج إلى حساب أبدًا، في كلتا الحالتين.",
      },
      {
        q: "هل هناك حدّ للحجم؟",
        a: "تحمل عمليات النقل الفوري ما يصل إلى 1,000 ملف في الدفعة دون حدّ للحجم من جانب الخادم — يبثّ Chrome وEdge مباشرةً إلى القرص لعشرات الغيغابايت. وحين لا ينطبق أي مسار للكتابة التدفّقية ويضطر المتصفح إلى التخزين في الذاكرة، يحذّر Relayium فوق نحو 256 ميغابايت؛ وهذا الرقم تقدير متحفّظ عن قصد، لا حدّ صلب. أما الروابط المُخزَّنة فتُحتسب ضمن حصة مرتبطة بحسابك.",
      },
      {
        q: "هل Relayium مجاني؟",
        a: "نعم. Relayium مجاني ومفتوح المصدر بموجب رخصة AGPL-3.0، والبروتوكول والشيفرة بالكامل على github.com/relayium/relayium — دون طبقة مدفوعة لفتح عمليات نقل أكبر أو أسرع.",
      },
    ],
  },
  cta: {
    text: "أرسل ملفًا بالنقل الفوري دون تخزينه في سحابة أحد — بلا حد حجم على الخادم أو تثبيت أو حساب على الشبكة نفسها.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium frente a Google Drive para enviar archivos",
  description:
    "Una comparación justa para la entrega puntual de un archivo: Google Drive es un excelente almacenamiento duradero, pero enviar significa subir y gestionar permisos. Relayium no guarda una copia del contenido en tiempo real en el servidor: los archivos del navegador van directos en una LAN y por un retransmisor TURN cifrado de extremo a extremo entre redes, o mediante un enlace de conocimiento cero que caduca solo.",
  updatedLabel: "Última actualización",
  lead: [
    "Google Drive es un producto genuinamente bueno: tus archivos viven en un solo lugar, se sincronizan entre dispositivos, quedan respaldados y son fáciles de coeditar en equipo. Si lo que necesitas es un hogar duradero para archivos a los que volverás, Drive es una opción por defecto razonable, y este artículo no intenta disuadirte de ello.",
    "Pero mucho de aquello para lo que la gente usa Drive es en realidad una entrega puntual —enviar un vídeo a un amigo, un contrato a un cliente, un conjunto de datos a un colega—, no almacenamiento duradero. Para esa tarea concreta, subir una copia a los servidores de Google y luego configurar quién puede verla es más maquinaria de la que la tarea necesita. El tiempo real de Relayium no guarda una copia de contenido en el servidor: navegador directo en la LAN y TURN cifrado de extremo a extremo entre redes. Solo el destinatario puede descifrar el enlace almacenado.",
  ],
  sections: [
    {
      heading: "Lo que Google Drive hace bien",
      body: [
        "La fortaleza de Drive es la permanencia y la colaboración. Un archivo que subes permanece ahí —sincronizado entre tu teléfono, tu portátil y la web— hasta que lo eliminas, que es justo lo que quieres para una carpeta de trabajo, una unidad de equipo compartida o documentos que editas junto a otras personas en tiempo real.",
        "También es generoso y sin fricciones para el almacenamiento: un buen plan gratuito, copia de seguridad automática, historial de versiones y búsqueda en todo lo que hayas guardado. Nada de eso es algo que Relayium intente reemplazar.",
      ],
    },
    {
      heading: "En qué se diferencian: enviar no es la misma tarea que almacenar",
      body: [
        "Para enviar un archivo por Drive, subes una copia a la infraestructura de Google y luego decides quién puede abrirlo: la cuenta de Google de una persona concreta, o «cualquier persona con el enlace». Si te equivocas con el ajuste de uso compartido, el archivo queda o inaccesible o más abierto de lo que pretendías. En cualquier caso, ahora vive una copia indefinidamente en los servidores de Google, hasta que vuelvas y la elimines.",
        "Relayium evita almacenar contenido en el servidor en el caso común en tiempo real. En una LAN, los archivos del navegador viajan directamente entre dispositivos; entre redes, las sesiones del navegador usan TURN por diseño y el retransmisor solo transporta texto cifrado de extremo a extremo que no puede leer ni descifrar. Cuando el destinatario está desconectado y sí quieres un enlace, el modo de enlace almacenado conserva la propiedad de conocimiento cero que Drive no tiene: tu navegador cifra el archivo con una clave AES-256-GCM aleatoria antes de subirlo, y esa clave vive únicamente en el fragmento de la URL (la parte tras el #, que los navegadores nunca envían a un servidor). Los servidores de Google guardan tus archivos de Drive y técnicamente pueden leerlos; el servidor de Relayium, para un enlace almacenado, solo guarda texto cifrado que no puede descifrar.",
      ],
    },
    {
      heading: "Tiempo real: sin copia de contenido en el servidor",
      body: [
        "Para el caso clásico —ambas personas están conectadas— el tiempo real envía hasta 1.000 archivos sin copia de contenido en el servidor. En una LAN los archivos del navegador van directos; entre redes TURN solo transporta texto cifrado de extremo a extremo que el retransmisor no puede leer ni descifrar. Ambos lados verifican el SAS y cada archivo con SHA-256; una interrupción se reanuda.",
        "No hay límite de tamaño en el servidor, así que el límite práctico viene del navegador que recibe: Chrome y Edge escriben los datos entrantes directamente al disco, manejando con holgura decenas de gigabytes. Firefox y Safari no tienen esa API y, cuando no se aplica ninguna vía de escritura en flujo, guardan los datos entrantes en memoria: Relayium avisa por encima de unos 256 MB, una estimación deliberadamente conservadora y no un límite duro medido. En la misma red no hace falta ninguna cuenta y los dos dispositivos se conectan directamente entre sí. Enviar entre redes usa un código de emparejamiento, requiere que quien crea ese código inicie sesión y viaja por diseño sobre un retransmisor TURN cifrado, de modo que la conexión se levanta en uno o dos segundos en vez de esperar intentos de conexión directa que rara vez prosperan entre dos redes; el retransmisor solo reenvía texto cifrado que no puede leer, y el destinatario nunca necesita cuenta, en ninguna de las dos configuraciones de red.",
      ],
    },
    {
      heading: "¿Aun así quieres un enlace? Enlaces almacenados de conocimiento cero",
      body: [
        "A veces un enlace es realmente lo que necesitas: el destinatario no está conectado, o quieres una única URL que puedas pegar en cualquier parte. El modo de enlace almacenado de Relayium cubre ese caso sin renunciar a la privacidad del modo en tiempo real.",
        "Eliges una caducidad —1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan— o configuras el enlace para que se destruya tras la primera descarga completada. Crear un enlace requiere que el remitente inicie sesión (cuenta para una cuota de almacenamiento de tu cuenta), pero el destinatario solo abre el enlace y descarga, sin necesidad de cuenta. Como la clave de descifrado nunca sale del fragmento de la URL, el modelo de Google y el modelo de enlace almacenado de Relayium difieren en un punto central: Google puede técnicamente descifrar los archivos alojados en Drive; el servidor de Relayium, para los enlaces almacenados, estructuralmente no puede.",
      ],
    },
    {
      heading: "Comparación de funciones de un vistazo",
      body: ["Las diferencias que más importan, una al lado de la otra:"],
      bullets: [
        "Propósito: Google Drive es almacenamiento duradero, siempre disponible, con colaboración integrada; Relayium está hecho para un envío puntual: P2P en tiempo real o un enlace que caduca solo.",
        "Dónde viven los archivos: Drive conserva una copia indefinida en los servidores de Google hasta que la eliminas; el tiempo real de Relayium no almacena el archivo en absoluto, y los enlaces almacenados caducan automáticamente (1h/1d/3d/7d, según el plan) o se destruyen tras la primera descarga.",
        "Quién puede leerlo: la infraestructura de Google puede técnicamente descifrar los archivos de Drive; los enlaces almacenados de Relayium son de conocimiento cero: la clave vive únicamente en el fragmento de la URL, así que el servidor guarda texto cifrado que no puede leer.",
        "Cuentas: Drive requiere una cuenta de Google para el remitente, y a menudo para el destinatario según los ajustes de uso compartido; Relayium no necesita cuenta en la misma red, y solo inicia sesión quien crea el código de emparejamiento o el enlace almacenado; el destinatario nunca la necesita.",
        "Límites de tamaño: Drive está limitado por tu cuota de almacenamiento; el tiempo real de Relayium no tiene límite en el servidor (Chrome/Edge escriben al disco para decenas de GB; cuando el navegador tiene que almacenar en memoria, Relayium avisa por encima de unos 256 MB).",
        "Coste y apertura: Relayium es gratis y está bajo licencia AGPL-3.0 en github.com/relayium/relayium, funcionando en el navegador en Windows, macOS, Linux, Android e iOS sin nada que instalar.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Relayium almacena mis archivos como lo hace Google Drive?",
        a: "En tiempo real no: Relayium no guarda una copia del contenido en el servidor. Los archivos del navegador van directos en una LAN; entre redes TURN solo transporta texto cifrado de extremo a extremo que el retransmisor no puede leer ni descifrar. Un enlace guarda texto cifrado de conocimiento cero sin clave de descifrado y caduca (1h/1d/3d/7d, según el plan) o se destruye tras la primera descarga.",
      },
      {
        q: "¿Necesito una cuenta?",
        a: "En la misma red no hace falta ninguna cuenta. Crear el código de emparejamiento para un envío entre redes, o crear un enlace de descarga almacenado, requiere iniciar sesión. El destinatario nunca necesita cuenta, en ninguno de los dos casos.",
      },
      {
        q: "¿Hay un límite de tamaño?",
        a: "Las transferencias en tiempo real llevan hasta 1.000 archivos por lote sin límite de tamaño en el servidor: Chrome y Edge escriben directamente al disco para decenas de gigabytes. Cuando no se aplica ninguna vía de escritura en flujo y el navegador tiene que almacenar en memoria, Relayium avisa por encima de unos 256 MB; esa cifra es una estimación deliberadamente conservadora, no un límite duro. Los enlaces almacenados cuentan para una cuota vinculada a tu cuenta.",
      },
      {
        q: "¿Es Relayium gratis?",
        a: "Sí. Relayium es gratis y de código abierto bajo la licencia AGPL-3.0, con el protocolo y el código completos en github.com/relayium/relayium; no hay un plan de pago para desbloquear transferencias más grandes o más rápidas.",
      },
    ],
  },
  cta: {
    text: "Envía un archivo en tiempo real sin almacenarlo en la nube: sin límite del servidor, instalación ni cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs Google Drive para enviar arquivos",
  description:
    "Uma comparação justa para a entrega pontual de um arquivo: o Google Drive é um ótimo armazenamento duradouro, mas enviar significa fazer upload e gerenciar permissões. O Relayium não guarda uma cópia do conteúdo em tempo real no servidor: os arquivos do navegador vão direto em uma LAN e por um retransmissor TURN criptografado de ponta a ponta entre redes, ou por um link de conhecimento zero que expira sozinho.",
  updatedLabel: "Última atualização",
  lead: [
    "O Google Drive é um produto genuinamente bom: seus arquivos ficam em um só lugar, sincronizam entre dispositivos, permanecem com backup e são fáceis de coeditar em equipe. Se o que você precisa é uma casa duradoura para arquivos aos quais você vai voltar, o Drive é uma escolha padrão razoável, e este artigo não tenta convencê-lo do contrário.",
    "Mas boa parte daquilo para que as pessoas usam o Drive é na verdade uma entrega pontual — enviar um vídeo para um amigo, um contrato para um cliente, um conjunto de dados para um colega —, não armazenamento duradouro. Para essa tarefa específica, fazer upload de uma cópia para os servidores do Google e depois configurar quem pode vê-la é mais maquinaria do que a tarefa precisa. O tempo real do Relayium não guarda cópia de conteúdo no servidor: navegador direto na LAN e TURN criptografado de ponta a ponta entre redes. Só o destinatário consegue descriptografar o link armazenado.",
  ],
  sections: [
    {
      heading: "O que o Google Drive faz bem",
      body: [
        "A força do Drive é a permanência e a colaboração. Um arquivo que você envia permanece ali — sincronizado entre seu celular, seu notebook e a web — até você excluí-lo, que é exatamente o que você quer para uma pasta de trabalho, um drive de equipe compartilhado ou documentos que vocês coeditam em tempo real.",
        "Ele também é generoso e sem atrito para o armazenamento: um plano gratuito sólido, backup automático, histórico de versões e busca em tudo o que você já salvou. Nada disso é algo que o Relayium tente substituir.",
      ],
    },
    {
      heading: "Onde eles diferem: enviar não é a mesma tarefa que armazenar",
      body: [
        "Para enviar um arquivo pelo Drive, você faz upload de uma cópia para a infraestrutura do Google e depois decide quem pode abri-lo: a conta Google de uma pessoa específica, ou “qualquer pessoa com o link”. Se você errar a configuração de compartilhamento, o arquivo fica ou inacessível ou mais aberto do que você pretendia. De todo modo, uma cópia agora vive indefinidamente nos servidores do Google, até você voltar e removê-la.",
        "O Relayium evita armazenar conteúdo no servidor no caso comum em tempo real. Em uma LAN, os arquivos do navegador vão diretamente entre dispositivos; entre redes, as sessões do navegador usam TURN por decisão de projeto, e o retransmissor só transporta texto cifrado de ponta a ponta que não consegue ler nem descriptografar. Quando o destinatário está offline e você realmente quer um link, o modo de link armazenado mantém a propriedade de conhecimento zero que o Drive não tem: seu navegador criptografa o arquivo com uma chave AES-256-GCM aleatória antes do upload, e essa chave vive apenas no fragmento da URL (a parte após o #, que os navegadores nunca enviam a um servidor). Os servidores do Google guardam seus arquivos do Drive e podem tecnicamente lê-los; o servidor do Relayium, para um link armazenado, guarda apenas texto cifrado que não consegue descriptografar.",
      ],
    },
    {
      heading: "Tempo real: sem cópia de conteúdo no servidor",
      body: [
        "Para o caso clássico — as duas pessoas estão online — o tempo real envia até 1.000 arquivos sem cópia de conteúdo no servidor. Em uma LAN os arquivos do navegador vão direto; entre redes TURN só transporta texto cifrado de ponta a ponta que o retransmissor não consegue ler nem descriptografar. Os dois lados verificam o SAS e cada arquivo com SHA-256; uma interrupção é retomada.",
        "Não há limite de tamanho no servidor, então o limite prático vem do navegador que recebe: Chrome e Edge gravam os dados que chegam direto no disco, lidando com folga com dezenas de gigabytes. Firefox e Safari não têm essa API e, quando nenhum caminho de gravação em fluxo se aplica, guardam os dados que chegam na memória — o Relayium avisa acima de cerca de 256 MB, uma estimativa deliberadamente conservadora e não um limite rígido medido. Na mesma rede, nenhuma conta é necessária e os dois dispositivos se conectam diretamente um ao outro. Enviar entre redes usa um código de emparelhamento, exige que quem cria esse código faça login e passa por decisão de projeto por um retransmissor TURN criptografado, de modo que a conexão sobe em um ou dois segundos em vez de esperar tentativas de conexão direta que raramente dão certo entre duas redes; o retransmissor só encaminha texto cifrado que não consegue ler, e o destinatário nunca precisa de conta, em nenhuma das duas configurações de rede.",
      ],
    },
    {
      heading: "Ainda quer um link? Links armazenados de conhecimento zero",
      body: [
        "Às vezes um link é realmente o que você precisa — o destinatário não está online, ou você quer uma única URL que possa colar em qualquer lugar. O modo de link armazenado do Relayium cobre esse caso sem abrir mão da privacidade do modo em tempo real.",
        "Você escolhe uma expiração — 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano — ou configura o link para se autodestruir após o primeiro download concluído. Criar um link exige que o remetente faça login (conta para uma cota de armazenamento da sua conta), mas o destinatário apenas abre o link e baixa, sem precisar de conta. Como a chave de descriptografia nunca sai do fragmento da URL, o modelo do Google e o modelo de link armazenado do Relayium diferem em um ponto central: o Google pode tecnicamente descriptografar os arquivos hospedados no Drive; o servidor do Relayium, para os links armazenados, estruturalmente não pode.",
      ],
    },
    {
      heading: "Comparação de recursos em resumo",
      body: ["As diferenças que mais importam, lado a lado:"],
      bullets: [
        "Propósito: o Google Drive é armazenamento duradouro, sempre disponível, com colaboração integrada; o Relayium foi feito para um envio pontual — P2P em tempo real ou um link que expira sozinho.",
        "Onde os arquivos ficam: o Drive mantém uma cópia indefinida nos servidores do Google até você excluí-la; o tempo real do Relayium não armazena o arquivo de forma alguma, e os links armazenados expiram automaticamente (1h/1d/3d/7d, conforme o plano) ou se autodestroem após o primeiro download.",
        "Quem pode lê-lo: a infraestrutura do Google pode tecnicamente descriptografar os arquivos do Drive; os links armazenados do Relayium são de conhecimento zero — a chave vive apenas no fragmento da URL, então o servidor guarda texto cifrado que não consegue ler.",
        "Contas: o Drive exige uma conta Google para o remetente e, muitas vezes, para o destinatário, conforme as configurações de compartilhamento; o Relayium não precisa de conta na mesma rede, e só quem cria o código de emparelhamento ou o link armazenado faz login — o destinatário nunca precisa.",
        "Limites de tamanho: o Drive é limitado pela sua cota de armazenamento; o tempo real do Relayium não tem limite no servidor (Chrome/Edge gravam no disco para dezenas de GB; quando o navegador precisa armazenar na memória, o Relayium avisa acima de cerca de 256 MB).",
        "Custo e abertura: o Relayium é gratuito e licenciado sob AGPL-3.0 em github.com/relayium/relayium, rodando no navegador em Windows, macOS, Linux, Android e iOS sem nada para instalar.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O Relayium armazena meus arquivos como o Google Drive faz?",
        a: "No modo em tempo real, não: o Relayium não guarda uma cópia do conteúdo no servidor. Os arquivos do navegador vão direto em uma LAN; entre redes TURN só transporta texto cifrado de ponta a ponta que o retransmissor não consegue ler nem descriptografar. Um link guarda texto cifrado de conhecimento zero sem a chave de descriptografia e expira (1h/1d/3d/7d, conforme o plano) ou se autodestrói após o primeiro download.",
      },
      {
        q: "Preciso de uma conta?",
        a: "Na mesma rede, nenhuma conta é necessária. Criar o código de emparelhamento para um envio entre redes, ou criar um link de download armazenado, exige login. O destinatário nunca precisa de conta, em nenhum dos casos.",
      },
      {
        q: "Há um limite de tamanho?",
        a: "As transferências em tempo real levam até 1.000 arquivos por lote sem limite de tamanho no servidor — Chrome e Edge gravam direto no disco para dezenas de gigabytes. Quando nenhum caminho de gravação em fluxo se aplica e o navegador precisa armazenar na memória, o Relayium avisa acima de cerca de 256 MB; esse número é uma estimativa deliberadamente conservadora, não um limite rígido. Os links armazenados contam para uma cota ligada à sua conta.",
      },
      {
        q: "O Relayium é gratuito?",
        a: "Sim. O Relayium é gratuito e de código aberto sob a licença AGPL-3.0, com o protocolo e o código completos em github.com/relayium/relayium — sem plano pago para desbloquear transferências maiores ou mais rápidas.",
      },
    ],
  },
  cta: {
    text: "Envie um arquivo em tempo real sem armazená-lo na nuvem — sem limite do servidor, instalação ou conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/google-drive",
  published: "2026-07-09",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
