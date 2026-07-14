// web/scripts/pages/content/articles/compare-dropbox.mjs
// Objective comparison: Relayium vs Dropbox for sending a single file (not
// durable sync/storage). English is the master; zh/ja/ko/de/fr follow the
// same structure with identical facts. Terminology mirrors src/lib/i18n/en.ts.
// Deliberately distinct wording/examples/FAQ from compare-google-drive.mjs —
// this is not a find-replace of that article.

const en = {
  title: "Relayium vs Dropbox for sending a file",
  description:
    "A fair comparison for handing off one file: Dropbox is excellent for durable sync and shared links, but the file ends up living in an account. Relayium sends it directly, peer-to-peer, or via a zero-knowledge link that expires.",
  updatedLabel: "Last updated",
  lead: [
    "Dropbox earns its reputation. It syncs a folder across every machine you own, keeps a version history when you overwrite something by accident, and makes it painless to hand a whole project folder to a client with a shared-link invite. If you want a working folder that just stays in sync, Dropbox does that job well and this isn't an argument against using it that way.",
    "The friction shows up on a narrower job: you have one file, one recipient, and no ongoing need for it to live anywhere afterward — a signed PDF, a video export, a zip of photos. Dropbox still asks you to drop that file into your account, generate a share link, and think about who else has access to that folder. Relayium is built for that narrower job specifically: the file goes straight to the other person's device, or it becomes a link that decrypts only in their browser and disappears on a schedule you set.",
  ],
  sections: [
    {
      heading: "What Dropbox is genuinely good at",
      body: [
        "Dropbox's core strength is that a folder you rely on is always current everywhere: edit a file on your laptop and it's already updated on your phone by the time you check. Selective sync, LAN sync for large local transfers, and file-recovery/version history all serve that same goal — a durable, dependable place for files you keep coming back to.",
        "Shared folders and Dropbox Paper make it a solid pick for ongoing collaboration, and its link-sharing is genuinely convenient for small teams that already live in Dropbox day to day. None of that is what Relayium is trying to be — Relayium doesn't sync a folder or keep a working copy of anything.",
      ],
    },
    {
      heading: "The gap: a share link still means an account holds the file",
      body: [
        "To send one file through Dropbox, it first has to be inside Dropbox — uploaded to your account, sitting in a folder, before you generate a shareable link for it. That link points at a copy Dropbox is storing on your behalf, readable by Dropbox's own infrastructure and staying there until you go back and delete the file or revoke the link yourself.",
        "For a one-off send, that's a lot of standing infrastructure for a file nobody needs to keep. Relayium's realtime mode skips storage entirely for the common case: bytes move directly between the sender's and recipient's devices over an end-to-end encrypted peer-to-peer connection, and the file is never written to a server at all. When you do want a link — because the recipient isn't online right now — the stored-link mode keeps a property Dropbox's sharing doesn't have: your browser generates a random AES-256-GCM key and encrypts the file with it before upload, and that key lives only in the URL fragment (the part after the #, which browsers never transmit to a server). Dropbox's servers can technically read what's in your account; Relayium's server, for a stored link, holds only ciphertext it has no way to decrypt.",
      ],
    },
    {
      heading: "Realtime send: the file never touches a server",
      body: [
        "When both people are online at the same time, realtime direct transfer sends up to 1,000 files in a single batch straight from one device to the other — no upload step, and nothing stored in between. Both sides get a matching 6-digit verification code (SAS) to catch any man-in-the-middle, every file is checked with a SHA-256 hash end to end, and a dropped connection resumes instead of restarting the whole thing.",
        "There's no server-side size cap; the real ceiling is the receiving browser. Chrome and Edge stream incoming data directly to disk, so tens of gigabytes are no problem, while Firefox and Safari buffer in memory, so keep those transfers under roughly 200 MB. On the same network — say, sending to a coworker's laptop across the office Wi-Fi — no account is needed at all. Sending across different networks uses a pairing code and requires the sender to sign in; the recipient never needs an account either way. When a direct connection isn't possible, it falls back to an encrypted TURN relay that only ever sees ciphertext.",
      ],
    },
    {
      heading: "When you need a link instead: zero-knowledge, self-expiring",
      body: [
        "Sometimes a link genuinely is the right tool — the recipient is asleep in another time zone, or you want one URL to paste into an email instead of coordinating a live session. Relayium's stored-link mode is built for exactly that, without giving up the privacy of realtime mode.",
        "You pick how long it lives — 1 hour, 1 day, 3 days, or 7 days — or set it to burn after the first completed download, so there's no lingering copy to remember to clean up. Creating the link requires the sender to sign in (it counts against a storage quota on the account), but the recipient just opens it and downloads — no Dropbox-style account required on their end. Because the decryption key never leaves the URL fragment, Relayium's server for a stored link is structurally unable to read what's inside it, which is a different guarantee than a Dropbox share link, where Dropbox's own infrastructure can technically decrypt the file it's hosting.",
      ],
    },
    {
      heading: "Side-by-side",
      body: ["The differences most relevant to a one-off send:"],
      bullets: [
        "Purpose: Dropbox is durable, always-synced storage built for folders you keep working in; Relayium is built for handing off one file — realtime P2P or a self-expiring link, nothing left behind.",
        "Where the file ends up: a Dropbox share link points at a copy that stays in your account until you delete it; Relayium realtime never stores the file, and stored links auto-expire (1h/1d/3d/7d) or burn after the first download.",
        "Who can read it: Dropbox's infrastructure can technically decrypt files in your account; Relayium's stored links are zero-knowledge — the key exists only in the URL fragment, so the server holds ciphertext it can't read.",
        "Accounts: Dropbox requires an account to upload and share; Relayium needs no account at all on the same network, and only the sender signs in for cross-network or stored-link sending — the recipient never needs one.",
        "Size limits: Dropbox is bounded by your plan's storage quota; Relayium realtime has no server-side cap (Chrome/Edge stream to disk for tens of GB; keep Firefox/Safari under ~200 MB).",
        "Cost and openness: Relayium is free and MIT-licensed at github.com/relayium/relayium, running in the browser on Windows, macOS, Linux, Android, and iOS with nothing to install.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the file sit in an account like it would with Dropbox?",
        a: "Not with realtime transfer — the file moves directly between devices and is never stored on a server. A download link does store something server-side, but only zero-knowledge ciphertext the server can't decrypt, and it expires (1h/1d/3d/7d) or burns after the first download.",
      },
      {
        q: "Does my recipient need to sign up for anything?",
        a: "No. On the same network, neither side needs an account. Sending across networks by pairing code, or creating a stored download link, requires the sender to sign in — the recipient never needs an account, in either case.",
      },
      {
        q: "Is there a file size limit?",
        a: "Realtime transfers handle up to 1,000 files per batch with no server-side size cap — Chrome and Edge stream straight to disk for tens of gigabytes, while Firefox and Safari buffer in memory, so keep those under roughly 200 MB. Stored links count against a quota tied to the sender's account.",
      },
      {
        q: "Is Relayium free to use instead of a Dropbox plan?",
        a: "Yes. Relayium is free and open source under the MIT license, with the full protocol and code at github.com/relayium/relayium — there's no paid tier gating bigger or faster transfers.",
      },
    ],
  },
  cta: {
    text: "Send the file directly, without putting it in anyone's account — no size cap, no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 Dropbox：发送单个文件更直接",
  description:
    "客观对比：交接一个文件时，Dropbox 擅长持久同步与分享链接，但文件最终会留在账号里；Relayium 直接点对点发送，或用会到期的零知识链接发送。",
  updatedLabel: "最近更新",
  lead: [
    "Dropbox 的口碑是挣来的：它能把一个文件夹同步到你所有设备上，误覆盖文件时还能靠版本历史找回来，把整个项目文件夹通过分享链接交给客户也很省心。如果你要的是一个始终保持同步的工作文件夹，Dropbox 确实做得好，本文并不是要劝你别这么用它。",
    "但另一类更窄的任务会暴露出摩擦：只有一个文件、一个收件人，之后也不需要它继续留在任何地方——一份已签字的 PDF、一段导出的视频、一个照片压缩包。Dropbox 仍然要求你先把文件放进账号里，生成一条分享链接，再想清楚这个文件夹里还有谁能访问。Relayium 正是为这类更窄的任务而生：文件直接送到对方设备上，或者变成一条只能在对方浏览器里解密、并按你设定的时间自动消失的链接。",
  ],
  sections: [
    {
      heading: "Dropbox 真正擅长的地方",
      body: [
        "Dropbox 的核心优势是：你依赖的文件夹在所有设备上都保持最新——在笔记本上改完一个文件，等你看手机时它已经同步好了。选择性同步、大文件的局域网同步、文件恢复和版本历史，服务的都是同一个目标：一个持久、可靠、你会反复用到的存放地。",
        "共享文件夹和 Dropbox Paper 也让它很适合长期协作，链接分享对已经天天用 Dropbox 的小团队来说确实方便。这些都不是 Relayium 想做的事——Relayium 不同步文件夹，也不为任何东西保留工作副本。",
      ],
    },
    {
      heading: "差距在哪：分享链接背后仍是账号在持有文件",
      body: [
        "要通过 Dropbox 发送一个文件，它得先进入 Dropbox——上传到你的账号、放进某个文件夹，然后你才能为它生成一条可分享的链接。这条链接指向的是 Dropbox 代你保存的一份副本，Dropbox 自己的基础设施能读取它，并且会一直留在那里，直到你回去删除文件或撤销链接。",
        "对一次性发送来说，为一个没人需要长期保留的文件动用这么多常驻基础设施有点多余。Relayium 的实时模式在常见场景下直接跳过存储：字节通过端到端加密的点对点连接，在发送方和接收方的设备之间直接移动，文件本身根本不会写到任何服务器上。当你确实需要一条链接——因为收件人现在不在线——存储链接模式保留了 Dropbox 分享所没有的特性：你的浏览器会在上传前生成一个随机的 AES-256-GCM 密钥并用它加密文件，这个密钥只存在于 URL 片段中（# 之后的部分，浏览器从不会把它发给服务器）。Dropbox 的服务器在技术上可以读取你账号里的内容；而 Relayium 的服务器对于存储链接，只保存它无法解密的密文。",
      ],
    },
    {
      heading: "实时发送：文件根本不经过服务器",
      body: [
        "当双方同时在线时，实时直连传输可以一次最多发送 1,000 个文件，直接从一台设备送到另一台，没有上传步骤，中间也不存放任何东西。双方会看到一致的 6 位校验码（SAS）以排除中间人，每个文件都用 SHA-256 做端到端校验，连接中断时会断点续传而不是从头再来。",
        "实时传输没有服务器端的大小上限，真正的限制来自接收方的浏览器：Chrome 和 Edge 会把接收数据直接流式写入磁盘，几十 GB 也不成问题；Firefox 和 Safari 则缓冲在内存里，建议这类传输保持在约 200 MB 以内。同一网络下——比如在办公室 Wi-Fi 下发给同事的笔记本——完全无需账号。跨不同网络发送要用配对码，需要发送方登录；但无论哪种情况，接收方都始终无需账号。若无法直连，会退回到加密的 TURN 中继，中继只能看到密文。",
      ],
    },
    {
      heading: "需要一条链接时：零知识、自动到期",
      body: [
        "有时候链接确实是更合适的方式——收件人在另一个时区正在睡觉，或者你想要一条可以直接贴进邮件的 URL，而不是协调一次实时会话。Relayium 的存储链接模式正是为此而生，同时不牺牲实时模式的隐私性。",
        "你可以选择链接的存活时间——1 小时、1 天、3 天或 7 天——或设置为首次下载完成后即焚，这样就不用惦记着回去清理留下的副本。创建链接需要发送方登录（会计入账号的存储配额），但收件人只需打开链接下载，不需要像 Dropbox 那样注册账号。因为解密密钥从不离开 URL 片段，Relayium 存储链接的服务器在结构上就无法读取其中内容，这和 Dropbox 分享链接不同——Dropbox 自己的基础设施在技术上是可以解密它托管的文件的。",
      ],
    },
    {
      heading: "并排对比",
      body: ["与一次性发送最相关的差别："],
      bullets: [
        "定位：Dropbox 是为持续使用的文件夹打造的、始终同步的持久存储；Relayium 是为交接一个文件而生——实时点对点或自动到期的链接，用完不留痕迹。",
        "文件去向：Dropbox 分享链接指向账号中留存的副本，直到你删除；Relayium 实时模式从不存储文件，存储链接会自动到期（1小时/1天/3天/7天）或首次下载后即焚。",
        "谁能读取：Dropbox 的基础设施在技术上可以解密你账号里的文件；Relayium 的存储链接是零知识的——密钥只存在于 URL 片段中，服务器保存的是它无法解读的密文。",
        "账号要求：Dropbox 上传和分享都需要账号；Relayium 在同一网络下完全无需账号，跨网络发送或创建存储链接只需发送方登录——接收方始终无需账号。",
        "大小限制：Dropbox 受你所在套餐的存储配额约束；Relayium 实时模式没有服务器端上限（Chrome/Edge 可流式写盘应对几十 GB；Firefox/Safari 建议保持在约 200 MB 以内）。",
        "费用与开放：Relayium 免费且采用 MIT 许可，代码在 github.com/relayium/relayium；在浏览器中运行，覆盖 Windows、macOS、Linux、Android 和 iOS，无需安装。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "文件会像在 Dropbox 里那样留在账号中吗？",
        a: "实时传输不会——文件直接在设备之间移动，从不存到服务器上。下载链接确实会在服务器端保存一些内容，但只是它无法解密的零知识密文；链接会到期（1小时/1天/3天/7天）或首次下载后即焚。",
      },
      {
        q: "收件人需要注册什么吗？",
        a: "不需要。同一网络下双方都无需账号。用配对码跨网络发送，或创建存储下载链接，都需要发送方登录——但无论哪种情况，接收方都始终无需账号。",
      },
      {
        q: "有文件大小限制吗？",
        a: "实时传输一次最多可处理 1,000 个文件，没有服务器端大小上限——Chrome 和 Edge 会直接流式写入磁盘，可应对几十 GB 的文件；Firefox 和 Safari 会缓冲在内存里，建议这类传输保持在约 200 MB 以内。存储链接则计入发送方账号绑定的配额。",
      },
      {
        q: "用 Relayium 代替 Dropbox 套餐是免费的吗？",
        a: "是的。Relayium 采用 MIT 许可，完全免费开源，完整的协议与代码都在 github.com/relayium/relayium——没有付费档去解锁更大或更快的传输。",
      },
    ],
  },
  cta: {
    text: "直接发送文件，不必放进任何人的账号——无大小上限、无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と Dropbox の比較：1ファイルの送信をもっと直接に",
  description:
    "公平な比較。Dropbox は永続的な同期と共有リンクに優れますが、ファイルは結局アカウントの中に残ります。Relayium はピアツーピアで直接送るか、失効するゼロ知識リンクで送ります。",
  updatedLabel: "最終更新",
  lead: [
    "Dropbox の評判には理由があります。所有するすべての端末でフォルダを同期し、うっかり上書きしてもバージョン履歴で戻せ、プロジェクトフォルダ丸ごとを共有リンクでクライアントに渡すのも簡単です。常に同期された作業フォルダが欲しいなら、Dropbox はその仕事をきちんとこなしますし、本記事はその使い方をやめさせようとするものではありません。",
    "摩擦が出てくるのは、もっと狭い作業のときです。ファイルは1つ、受信者は1人、その後どこかに残しておく必要もない——署名済みの PDF、書き出した動画、写真をまとめた zip。それでも Dropbox は、まずそのファイルをアカウントに入れ、共有リンクを発行し、そのフォルダに他に誰がアクセスできるかを考えることを求めます。Relayium はまさにこの狭い作業のために作られています。ファイルは相手の端末へ直接届くか、相手のブラウザでしか復号できず、あなたが設定した時間で消えるリンクになります。",
  ],
  sections: [
    {
      heading: "Dropbox が本当に得意なこと",
      body: [
        "Dropbox の核心的な強みは、あなたが頼りにしているフォルダが常にどこでも最新であることです。ノートパソコンでファイルを編集すれば、スマートフォンを確認する頃にはもう更新されています。選択的同期、大きなローカル転送のための LAN 同期、ファイル復元・バージョン履歴、これらすべてが同じ目標——何度も戻ってくる、永続的で信頼できる置き場所——に貢献しています。",
        "共有フォルダと Dropbox Paper は継続的な協業にも適しており、リンク共有はすでに日常的に Dropbox を使う小規模チームにとって本当に便利です。これらはどれも Relayium が目指しているものではありません。Relayium はフォルダを同期せず、何かの作業用コピーを保持することもありません。",
      ],
    },
    {
      heading: "違いの核心：共有リンクの先には依然としてアカウントがある",
      body: [
        "Dropbox で1つのファイルを送るには、まずそれが Dropbox の中になければなりません——アカウントにアップロードされ、フォルダに置かれてから、共有可能なリンクを発行します。そのリンクが指すのは、Dropbox があなたに代わって保管しているコピーであり、Dropbox 自身のインフラが読み取ることができ、あなたが戻ってファイルを削除するかリンクを取り消すまでそこに残り続けます。",
        "一度きりの送信にしては、誰も保持する必要のないファイルのためにかなりの常設インフラです。Relayium のリアルタイムモードは、よくあるケースでこの保存という手順を完全に省きます。バイトはエンドツーエンドで暗号化された P2P 接続を通じて送信者と受信者の端末間を直接移動し、ファイル自体はサーバーに一切書き込まれません。受信者が今オフラインで、それでもリンクが欲しいときは、保存リンクモードが Dropbox の共有にはない性質を保ちます。ブラウザはアップロード前にランダムな AES-256-GCM 鍵を生成してファイルを暗号化し、その鍵は URL フラグメント（# の後の部分。ブラウザが決してサーバーへ送らない部分）にだけ存在します。Dropbox のサーバーは、あなたのアカウント内のものを技術的に読み取ることができます。一方 Relayium のサーバーは、保存リンクについて復号できない暗号文しか保持しません。",
      ],
    },
    {
      heading: "リアルタイム送信：ファイルは一切サーバーを経由しない",
      body: [
        "両者が同時にオンラインのとき、リアルタイム直接転送は最大1,000ファイルを1バッチとして一方の端末からもう一方へ直接送ります——アップロードの手順もなく、途中で何も保存されません。両方の端末は一致する6桁の検証コード（SAS）を表示して中間者を排除し、各ファイルは SHA-256 ハッシュでエンドツーエンドに検証され、接続が切れても最初からではなく再開します。",
        "サーバー側のサイズ上限はなく、実際の限界は受信側のブラウザ次第です。Chrome と Edge は受信データをそのままディスクにストリーミングするため数十ギガバイトでも問題なく、Firefox と Safari はメモリにバッファするため、そうした転送は約200MB以内に抑えてください。同じネットワーク内——たとえばオフィスの Wi-Fi で同僚のノートパソコンに送るような場合——ではアカウントは一切不要です。異なるネットワーク間の送信にはペアリングコードを使い、送信側のサインインが必要ですが、どちらの場合でも受信側は常にアカウント不要です。直接接続ができない場合は、暗号化された TURN リレーにフォールバックし、リレーは暗号文しか見ません。",
      ],
    },
    {
      heading: "リンクが必要なとき：ゼロ知識で自動失効",
      body: [
        "受信者が別のタイムゾーンで眠っている、あるいはリアルタイムセッションを調整する代わりにメールに貼り付けられる1つの URL が欲しい——そんなときはリンクこそが正しい道具です。Relayium の保存リンクモードは、リアルタイムモードのプライバシーを犠牲にせずまさにその場面のために作られています。",
        "有効期限は1時間・1日・3日・7日から選ぶか、最初のダウンロード完了後に消去する設定にでき、後で片付けを覚えておく必要のあるコピーが残りません。リンクの作成には送信側のサインインが必要です（アカウントの保存容量枠に計上されます）が、受信側はリンクを開いてダウンロードするだけで、Dropbox のようなアカウント登録は不要です。復号鍵が URL フラグメントから外に出ることは決してないため、Relayium の保存リンクのサーバーは構造的に中身を読み取れません。これは Dropbox の共有リンクとは異なる保証です。Dropbox 自身のインフラは、ホストしているファイルを技術的には復号できます。",
      ],
    },
    {
      heading: "並べて比較",
      body: ["一度きりの送信に最も関係する違い："],
      bullets: [
        "目的：Dropbox は使い続けるフォルダのために作られた、常時同期する永続ストレージ；Relayium は1ファイルの受け渡しのために作られている——リアルタイム P2P か、自動失効するリンクで、後に何も残らない。",
        "ファイルの行き先：Dropbox の共有リンクは、あなたが削除するまでアカウントに残るコピーを指す；Relayium のリアルタイムはファイルを一切保存せず、保存リンクは自動失効（1時間/1日/3日/7日）または初回ダウンロード後に消去。",
        "誰が読めるか：Dropbox のインフラは技術的にアカウント内のファイルを復号できる；Relayium の保存リンクはゼロ知識で、鍵は URL フラグメントにだけ存在し、サーバーは読めない暗号文を保持する。",
        "アカウント：Dropbox はアップロードと共有にアカウントを要求する；Relayium は同一ネットワークではアカウントが一切不要で、ネットワークをまたぐ送信や保存リンクの作成では送信側のみサインインが必要——受信側は常にアカウント不要。",
        "サイズ上限：Dropbox はプランの保存容量枠に制約される；Relayium のリアルタイムはサーバー側の上限なし（Chrome/Edge は数十GBまでディスクへストリーミング、Firefox/Safari は約200MB以内に）。",
        "費用と開放性：Relayium は無料で MIT ライセンス、github.com/relayium/relayium にあり、ブラウザで Windows・macOS・Linux・Android・iOS で動作し、インストール不要。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Dropbox のようにファイルがアカウントの中に残りますか？",
        a: "リアルタイム転送では残りません——ファイルは端末間を直接移動し、サーバーには一切保存されません。ダウンロードリンクはサーバー側で何かを保存しますが、それは復号できないゼロ知識の暗号文だけです。リンクは失効するか（1時間/1日/3日/7日）、最初のダウンロード後に消去されます。",
      },
      {
        q: "受信者は何かに登録する必要がありますか？",
        a: "いいえ。同じネットワーク内では双方ともアカウント不要です。ペアリングコードでネットワークをまたいで送信する場合や、保存ダウンロードリンクを作成する場合は、送信側のサインインが必要です。どちらの場合も受信側は常にアカウント不要です。",
      },
      {
        q: "ファイルサイズに上限はありますか？",
        a: "リアルタイム転送は1バッチにつき最大1,000ファイルまで扱え、サーバー側のサイズ上限はありません——Chrome と Edge は数十ギガバイトまでそのままディスクにストリーミングし、Firefox と Safari はメモリにバッファするため約200MB以内に抑えてください。保存リンクは送信側のアカウントに紐づく容量枠に計上されます。",
      },
      {
        q: "Dropbox のプランの代わりに Relayium を使うのは無料ですか？",
        a: "はい。Relayium は MIT ライセンスの無料オープンソースで、プロトコルとコードのすべてが github.com/relayium/relayium にあります。より大きく、より速い転送を解放する有料プランはありません。",
      },
    ],
  },
  cta: {
    text: "誰のアカウントにも入れず、ファイルを直接送ってみてください——サイズ上限なし、インストール不要、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs Dropbox: 파일 하나를 더 직접적으로 보내기",
  description:
    "공정한 비교입니다. Dropbox는 영구 동기화와 공유 링크에 뛰어나지만, 파일은 결국 계정 안에 남습니다. Relayium은 P2P로 직접 보내거나 만료되는 영지식 링크로 보냅니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Dropbox의 평판에는 이유가 있습니다. 소유한 모든 기기에서 폴더를 동기화하고, 실수로 덮어써도 버전 기록으로 되돌릴 수 있으며, 프로젝트 폴더 전체를 공유 링크로 클라이언트에게 넘기는 것도 수월합니다. 계속 동기화 상태를 유지하는 작업 폴더가 필요하다면 Dropbox는 그 역할을 잘 해내며, 이 글은 그런 용도로 쓰지 말라고 설득하려는 것이 아닙니다.",
    "마찰이 드러나는 건 더 좁은 작업에서입니다. 파일은 하나, 받는 사람도 한 명, 이후 어딘가에 계속 남아 있어야 할 필요도 없는 경우——서명된 PDF, 내보낸 동영상, 사진을 담은 zip 파일. 그런데도 Dropbox는 먼저 그 파일을 계정에 넣고, 공유 링크를 만들고, 그 폴더에 또 누가 접근할 수 있는지 신경 쓰라고 요구합니다. Relayium은 바로 이 좁은 작업을 위해 만들어졌습니다. 파일은 상대방 기기로 곧장 전달되거나, 상대방 브라우저에서만 복호화되고 당신이 정한 시간에 맞춰 사라지는 링크가 됩니다.",
  ],
  sections: [
    {
      heading: "Dropbox가 정말 잘하는 것",
      body: [
        "Dropbox의 핵심 강점은 당신이 의지하는 폴더가 어디서나 항상 최신 상태라는 점입니다. 노트북에서 파일을 편집하면 휴대폰을 확인할 때쯤엔 이미 업데이트되어 있습니다. 선택적 동기화, 대용량 로컬 전송을 위한 LAN 동기화, 파일 복구·버전 기록 모두 같은 목표——계속 다시 찾게 되는 영구적이고 신뢰할 수 있는 보관 장소——를 위한 것입니다.",
        "공유 폴더와 Dropbox Paper는 지속적인 협업에도 적합하고, 링크 공유는 이미 매일 Dropbox를 쓰는 소규모 팀에게는 정말 편리합니다. 이런 것들은 Relayium이 되려는 대상이 아닙니다. Relayium은 폴더를 동기화하지 않고, 무언가의 작업용 사본을 보관하지도 않습니다.",
      ],
    },
    {
      heading: "차이의 핵심: 공유 링크 뒤에는 여전히 계정이 파일을 쥐고 있다",
      body: [
        "Dropbox로 파일 하나를 보내려면 먼저 그것이 Dropbox 안에 있어야 합니다——계정에 업로드되어 폴더에 놓인 뒤에야 공유 가능한 링크를 만들 수 있습니다. 그 링크가 가리키는 것은 Dropbox가 당신을 대신해 보관하는 사본이며, Dropbox 자체 인프라가 이를 읽을 수 있고, 당신이 돌아가 파일을 삭제하거나 링크를 취소할 때까지 그대로 남아 있습니다.",
        "일회성 전송치고는, 아무도 계속 보관할 필요가 없는 파일 하나를 위해 상당한 상시 인프라를 쓰는 셈입니다. Relayium의 실시간 모드는 흔한 경우에 이 저장 단계를 완전히 건너뜁니다. 바이트는 종단간 암호화된 P2P 연결을 통해 보내는 사람과 받는 사람의 기기 사이에서 직접 이동하며, 파일 자체는 서버에 전혀 기록되지 않습니다. 받는 사람이 지금 오프라인이라 링크가 정말로 필요할 때는, 저장 링크 모드가 Dropbox 공유에는 없는 속성을 유지합니다. 브라우저가 업로드 전에 무작위 AES-256-GCM 키를 생성해 파일을 암호화하고, 그 키는 URL 프래그먼트——# 뒤의, 브라우저가 서버로 절대 보내지 않는 부분——에만 존재합니다. Dropbox의 서버는 계정 안의 내용을 기술적으로 읽을 수 있습니다. 반면 Relayium의 서버는 저장 링크에 대해 복호화할 수 없는 암호문만 보관합니다.",
      ],
    },
    {
      heading: "실시간 전송: 파일이 서버를 전혀 거치지 않음",
      body: [
        "양쪽이 동시에 온라인일 때, 실시간 직접 전송은 한 번에 최대 1,000개 파일을 한 기기에서 다른 기기로 곧바로 보냅니다——업로드 단계도 없고, 그 사이 아무것도 저장되지 않습니다. 양쪽 모두 일치하는 6자리 검증 코드(SAS)를 보여 중간자를 배제하고, 각 파일은 SHA-256 해시로 종단간 검증되며, 연결이 끊겨도 처음부터가 아니라 이어서 재개됩니다.",
        "서버 측 크기 제한이 없으므로 실제 한계는 받는 쪽 브라우저에서 옵니다. Chrome과 Edge는 들어오는 데이터를 곧바로 디스크로 스트리밍해 수십 기가바이트도 문제없이 처리하고, Firefox와 Safari는 메모리에 버퍼링하므로 이런 전송은 약 200 MB 이내로 유지하세요. 같은 네트워크——예를 들어 사무실 Wi-Fi로 동료의 노트북에 보내는 경우——에서는 계정이 전혀 필요 없습니다. 서로 다른 네트워크 간 전송은 페어링 코드를 쓰며 보내는 쪽의 로그인이 필요하지만, 어느 경우든 받는 쪽은 항상 계정이 필요 없습니다. 직접 연결이 불가능하면 암호화된 TURN 릴레이로 폴백하며, 릴레이는 암호문만 봅니다.",
      ],
    },
    {
      heading: "링크가 필요할 때: 영지식이며 자동 만료",
      body: [
        "받는 사람이 다른 시간대에서 자고 있거나, 실시간 세션을 조율하는 대신 이메일에 붙여넣을 URL 하나가 필요할 때——그럴 때는 링크가 정말로 맞는 도구입니다. Relayium의 저장 링크 모드는 실시간 모드의 프라이버시를 포기하지 않고 바로 그 경우를 위해 만들어졌습니다.",
        "링크가 얼마나 유지될지——1시간, 1일, 3일, 7일 중——선택하거나, 첫 다운로드 완료 후 소각되도록 설정할 수 있어 나중에 정리해야 할 사본이 남지 않습니다. 링크 생성에는 보내는 쪽의 로그인이 필요하지만(계정의 저장 용량 한도에 포함됩니다), 받는 쪽은 링크를 열어 다운로드하기만 하면 되고 Dropbox 같은 계정 가입은 필요 없습니다. 복호화 키가 URL 프래그먼트를 벗어나는 일이 없기 때문에, Relayium 저장 링크의 서버는 구조적으로 내용을 읽을 수 없습니다. 이는 Dropbox 공유 링크와는 다른 보장입니다. Dropbox 자체 인프라는 호스팅하는 파일을 기술적으로 복호화할 수 있습니다.",
      ],
    },
    {
      heading: "나란히 비교",
      body: ["일회성 전송에 가장 관련 있는 차이:"],
      bullets: [
        "목적: Dropbox는 계속 작업하는 폴더를 위한, 항상 동기화되는 영구 저장소; Relayium은 파일 하나를 전달하기 위해 만들어짐——실시간 P2P 또는 자동 만료 링크로, 나중에 아무것도 남지 않음.",
        "파일이 놓이는 곳: Dropbox 공유 링크는 당신이 삭제할 때까지 계정에 남아 있는 사본을 가리킴; Relayium 실시간은 파일을 아예 저장하지 않고, 저장 링크는 자동 만료(1시간/1일/3일/7일)되거나 첫 다운로드 후 소각됨.",
        "누가 읽을 수 있는가: Dropbox의 인프라는 기술적으로 계정 내 파일을 복호화할 수 있음; Relayium의 저장 링크는 영지식으로, 키가 URL 프래그먼트에만 있어 서버는 읽을 수 없는 암호문을 보관함.",
        "계정: Dropbox는 업로드와 공유에 계정을 요구함; Relayium은 같은 네트워크에서 계정이 전혀 필요 없고, 네트워크를 넘거나 저장 링크를 만들 때만 보내는 쪽이 로그인함——받는 쪽은 항상 계정 불필요.",
        "크기 제한: Dropbox는 요금제의 저장 용량 한도에 제약됨; Relayium 실시간은 서버 측 제한 없음(Chrome/Edge는 수십 GB까지 디스크로 스트리밍, Firefox/Safari는 약 200 MB 이내로 유지).",
        "비용과 개방성: Relayium은 무료이며 MIT 라이선스로 github.com/relayium/relayium에 있고, 브라우저에서 Windows·macOS·Linux·Android·iOS로 동작하며 설치가 필요 없음.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Dropbox처럼 파일이 계정 안에 남나요?",
        a: "실시간 전송에서는 아닙니다——파일이 기기 사이에서 직접 이동하며 서버에 전혀 저장되지 않습니다. 다운로드 링크는 서버 측에 무언가를 저장하지만, 그것은 복호화할 수 없는 영지식 암호문뿐입니다. 링크는 만료되거나(1시간/1일/3일/7일) 첫 다운로드 후 소각됩니다.",
      },
      {
        q: "받는 사람이 뭔가에 가입해야 하나요?",
        a: "아니요. 같은 네트워크에서는 양쪽 모두 계정이 필요 없습니다. 페어링 코드로 네트워크를 넘어 보내거나 저장 다운로드 링크를 만들 때는 보내는 쪽의 로그인이 필요합니다. 어느 경우든 받는 쪽은 항상 계정이 필요 없습니다.",
      },
      {
        q: "파일 크기 제한이 있나요?",
        a: "실시간 전송은 한 번에 최대 1,000개 파일을 처리할 수 있고 서버 측 크기 제한이 없습니다——Chrome과 Edge는 수십 기가바이트까지 곧바로 디스크로 스트리밍하고, Firefox와 Safari는 메모리에 버퍼링하므로 약 200 MB 이내로 유지하세요. 저장 링크는 보내는 쪽 계정에 연결된 용량 한도에 포함됩니다.",
      },
      {
        q: "Dropbox 요금제 대신 Relayium을 쓰는 건 무료인가요?",
        a: "네. Relayium은 MIT 라이선스의 무료 오픈소스이며, 프로토콜과 코드 전체가 github.com/relayium/relayium에 있습니다. 더 크거나 빠른 전송을 여는 유료 등급은 없습니다.",
      },
    ],
  },
  cta: {
    text: "누구의 계정에도 넣지 않고 파일을 직접 보내보세요——크기 제한 없이, 설치 없이, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. Dropbox: eine Datei direkter versenden",
  description:
    "Ein fairer Vergleich: Dropbox ist stark bei dauerhafter Synchronisierung und Freigabelinks, aber die Datei landet trotzdem in einem Konto. Relayium sendet sie direkt, peer-to-peer, oder über einen ablaufenden Zero-Knowledge-Link.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Dropbox hat sich seinen Ruf verdient. Es synchronisiert einen Ordner über alle deine Geräte, bewahrt eine Versionshistorie, falls du versehentlich etwas überschreibst, und macht es mühelos, einen ganzen Projektordner per Freigabelink an eine Kundin zu übergeben. Wenn du einen Arbeitsordner willst, der einfach synchron bleibt, macht Dropbox diesen Job gut — dieser Artikel spricht nicht dagegen, es so zu nutzen.",
    "Die Reibung zeigt sich bei einer engeren Aufgabe: Du hast eine Datei, einen Empfänger, und keinen fortlaufenden Bedarf, dass sie danach irgendwo bleibt — ein unterschriebenes PDF, ein exportiertes Video, ein Zip voller Fotos. Dropbox verlangt trotzdem, diese Datei erst in dein Konto zu legen, einen Freigabelink zu erzeugen und darüber nachzudenken, wer sonst noch Zugriff auf diesen Ordner hat. Relayium ist genau für diese engere Aufgabe gebaut: Die Datei geht direkt an das Gerät der anderen Person, oder sie wird ein Link, der sich nur in deren Browser entschlüsselt und nach einem von dir gewählten Zeitplan verschwindet.",
  ],
  sections: [
    {
      heading: "Worin Dropbox wirklich gut ist",
      body: [
        "Dropboxs Kernstärke ist, dass ein Ordner, auf den du dich verlässt, überall immer aktuell ist: Bearbeitest du eine Datei auf dem Laptop, ist sie schon aktualisiert, wenn du dein Handy prüfst. Selektive Synchronisierung, LAN-Sync für große lokale Übertragungen sowie Dateiwiederherstellung und Versionshistorie dienen alle demselben Ziel — einem dauerhaften, verlässlichen Ort für Dateien, zu denen du immer wieder zurückkehrst.",
        "Freigegebene Ordner und Dropbox Paper machen es zu einer soliden Wahl für laufende Zusammenarbeit, und die Link-Freigabe ist für kleine Teams, die ohnehin täglich in Dropbox leben, wirklich praktisch. Nichts davon versucht Relayium zu sein — Relayium synchronisiert keinen Ordner und behält auch keine Arbeitskopie von irgendetwas.",
      ],
    },
    {
      heading: "Die Lücke: Ein Freigabelink bedeutet trotzdem, dass ein Konto die Datei hält",
      body: [
        "Um eine Datei per Dropbox zu senden, muss sie zuerst in Dropbox sein — hochgeladen in dein Konto, abgelegt in einem Ordner, bevor du einen freigebbaren Link dafür erzeugst. Dieser Link verweist auf eine Kopie, die Dropbox stellvertretend für dich speichert, lesbar für Dropboxs eigene Infrastruktur und dort verbleibend, bis du zurückgehst und die Datei löschst oder den Link selbst widerrufst.",
        "Für einen einmaligen Versand ist das eine Menge ständiger Infrastruktur für eine Datei, die niemand behalten muss. Relayiums Echtzeitmodus überspringt die Speicherung für den üblichen Fall komplett: Bytes bewegen sich über eine Ende-zu-Ende-verschlüsselte Peer-to-Peer-Verbindung direkt zwischen den Geräten von Absender und Empfänger, und die Datei wird nie auf einem Server geschrieben. Willst du wirklich einen Link — weil der Empfänger gerade nicht online ist —, behält der Speicherlink-Modus eine Eigenschaft, die Dropboxs Freigabe nicht hat: Dein Browser erzeugt vor dem Hochladen einen zufälligen AES-256-GCM-Schlüssel und verschlüsselt die Datei damit, und dieser Schlüssel lebt nur im URL-Fragment (dem Teil nach dem #, den Browser nie an einen Server übertragen). Dropboxs Server können technisch lesen, was in deinem Konto liegt; Relayiums Server hält bei einem Speicherlink nur Chiffretext, den er nicht entschlüsseln kann.",
      ],
    },
    {
      heading: "Echtzeit-Versand: Die Datei berührt nie einen Server",
      body: [
        "Sind beide gerade gleichzeitig online, sendet die direkte Echtzeitübertragung bis zu 1.000 Dateien in einem Durchgang direkt von einem Gerät zum anderen — ohne Hochladeschritt und ohne dass zwischendurch irgendwo etwas gespeichert wird. Beide Seiten erhalten einen übereinstimmenden sechsstelligen Prüfcode (SAS), um einen Man-in-the-Middle auszuschließen, jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, und eine abgebrochene Verbindung wird fortgesetzt statt neu gestartet.",
        "Es gibt kein serverseitiges Größenlimit; die eigentliche Grenze setzt der empfangende Browser. Chrome und Edge streamen eingehende Daten direkt auf die Festplatte, sodass mehrere Dutzend Gigabyte kein Problem sind, während Firefox und Safari im Arbeitsspeicher puffern — halte solche Übertragungen dort unter etwa 200 MB. Im selben Netz — etwa beim Senden an den Laptop einer Kollegin über das Büro-WLAN — ist überhaupt kein Konto nötig. Das Senden über verschiedene Netzwerke hinweg nutzt einen Pairing-Code und erfordert die Anmeldung des Absenders; der Empfänger braucht in beiden Fällen nie ein Konto. Ist eine Direktverbindung nicht möglich, weicht die Übertragung auf ein verschlüsseltes TURN-Relay aus, das nur Chiffretext sieht.",
      ],
    },
    {
      heading: "Wenn du stattdessen einen Link brauchst: Zero-Knowledge, automatisch ablaufend",
      body: [
        "Manchmal ist ein Link wirklich das richtige Werkzeug — der Empfänger schläft in einer anderen Zeitzone, oder du willst eine einzige URL, die du in eine E-Mail einfügst, statt eine Live-Sitzung zu koordinieren. Relayiums Speicherlink-Modus ist genau dafür gebaut, ohne die Privatsphäre des Echtzeitmodus aufzugeben.",
        "Du wählst, wie lange er lebt — 1 Stunde, 1 Tag, 3 Tage oder 7 Tage — oder stellst ihn so ein, dass er nach dem ersten vollständigen Download vernichtet wird, sodass keine verbleibende Kopie zum Aufräumen übrig bleibt. Das Erstellen des Links erfordert die Anmeldung des Absenders (er zählt gegen ein Speicherkontingent des Kontos), aber der Empfänger öffnet ihn einfach und lädt herunter — kein Dropbox-artiges Konto auf seiner Seite nötig. Da der Entschlüsselungsschlüssel das URL-Fragment nie verlässt, ist Relayiums Server bei einem Speicherlink strukturell unfähig, dessen Inhalt zu lesen — eine andere Garantie als bei einem Dropbox-Freigabelink, wo Dropboxs eigene Infrastruktur die gehostete Datei technisch entschlüsseln kann.",
      ],
    },
    {
      heading: "Nebeneinander",
      body: ["Die für einen einmaligen Versand relevantesten Unterschiede:"],
      bullets: [
        "Zweck: Dropbox ist dauerhafter, stets synchronisierter Speicher für Ordner, in denen du weiterarbeitest; Relayium ist für die Übergabe einer einzelnen Datei gebaut — Echtzeit-P2P oder ein Link mit Ablaufdatum, ohne dass etwas zurückbleibt.",
        "Wo die Datei landet: Ein Dropbox-Freigabelink verweist auf eine Kopie, die im Konto bleibt, bis du sie löschst; Relayium-Echtzeit speichert die Datei nie, und Speicherlinks laufen automatisch ab (1 Std./1 Tag/3 Tage/7 Tage) oder werden nach dem ersten Download vernichtet.",
        "Wer es lesen kann: Dropboxs Infrastruktur kann Dateien in deinem Konto technisch entschlüsseln; Relayiums Speicherlinks sind Zero-Knowledge — der Schlüssel existiert nur im URL-Fragment, sodass der Server Chiffretext hält, den er nicht lesen kann.",
        "Konten: Dropbox verlangt ein Konto zum Hochladen und Freigeben; Relayium braucht im selben Netz überhaupt kein Konto, und nur der Absender meldet sich beim netzübergreifenden Senden oder beim Erstellen eines Speicherlinks an — der Empfänger nie.",
        "Größenlimits: Dropbox ist durch das Speicherkontingent deines Tarifs begrenzt; Relayium-Echtzeit hat kein serverseitiges Limit (Chrome/Edge streamen für mehrere Dutzend Gigabyte auf die Festplatte; Firefox/Safari unter ~200 MB halten).",
        "Kosten und Offenheit: Relayium ist kostenlos und MIT-lizenziert unter github.com/relayium/relayium und läuft im Browser unter Windows, macOS, Linux, Android und iOS ohne Installation.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Bleibt die Datei wie bei Dropbox in einem Konto?",
        a: "Bei der Echtzeitübertragung nicht — die Datei bewegt sich direkt zwischen den Geräten und wird nie auf einem Server gespeichert. Ein Download-Link speichert zwar etwas serverseitig, aber nur Zero-Knowledge-Chiffretext, den der Server nicht entschlüsseln kann; er läuft ab (1 Std./1 Tag/3 Tage/7 Tage) oder wird nach dem ersten Download vernichtet.",
      },
      {
        q: "Muss sich mein Empfänger irgendwo anmelden?",
        a: "Nein. Im selben Netz braucht keine Seite ein Konto. Beim Senden über Netzwerke hinweg per Pairing-Code oder beim Erstellen eines gespeicherten Download-Links muss sich der Absender anmelden — der Empfänger braucht in keinem der beiden Fälle je ein Konto.",
      },
      {
        q: "Gibt es ein Dateigrößenlimit?",
        a: "Echtzeitübertragungen verarbeiten bis zu 1.000 Dateien pro Durchgang ohne serverseitiges Größenlimit — Chrome und Edge streamen für mehrere Dutzend Gigabyte direkt auf die Festplatte, während Firefox und Safari im Arbeitsspeicher puffern, halte solche Übertragungen also unter etwa 200 MB. Speicherlinks zählen gegen ein an das Konto des Absenders gebundenes Kontingent.",
      },
      {
        q: "Ist Relayium anstelle eines Dropbox-Tarifs kostenlos nutzbar?",
        a: "Ja. Relayium ist kostenlos und quelloffen unter der MIT-Lizenz, mit dem vollständigen Protokoll und Code unter github.com/relayium/relayium — kein Bezahltarif blockiert größere oder schnellere Übertragungen.",
      },
    ],
  },
  cta: {
    text: "Sende die Datei direkt, ohne sie in irgendjemandes Konto zu legen — kein Größenlimit, keine Installation und im selben Netz kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs Dropbox pour envoyer un fichier",
  description:
    "Comparatif équitable : Dropbox excelle pour la synchronisation durable et les liens partagés, mais le fichier finit par résider dans un compte. Relayium l'envoie directement, en pair-à-pair, ou via un lien à divulgation nulle qui expire.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Dropbox mérite sa réputation. Il synchronise un dossier sur tous vos appareils, conserve un historique des versions quand vous écrasez quelque chose par erreur, et permet de remettre tout un dossier de projet à un client via un lien partagé sans effort. Si vous voulez un dossier de travail qui reste simplement synchronisé, Dropbox fait bien ce travail, et cet article ne cherche pas à vous en dissuader.",
    "La friction apparaît sur une tâche plus étroite : vous avez un fichier, un destinataire, et aucun besoin durable qu'il reste quelque part ensuite — un PDF signé, un export vidéo, un zip de photos. Dropbox vous demande quand même de déposer ce fichier dans votre compte, de générer un lien de partage, et de réfléchir à qui d'autre a accès à ce dossier. Relayium est conçu précisément pour cette tâche plus étroite : le fichier va directement sur l'appareil de l'autre personne, ou devient un lien qui ne se déchiffre que dans son navigateur et disparaît selon le calendrier que vous fixez.",
  ],
  sections: [
    {
      heading: "Ce en quoi Dropbox est vraiment bon",
      body: [
        "La force centrale de Dropbox est qu'un dossier sur lequel vous comptez est toujours à jour partout : modifiez un fichier sur votre ordinateur portable, il est déjà à jour sur votre téléphone le temps que vous le consultiez. La synchronisation sélective, la synchronisation LAN pour les gros transferts locaux, la récupération de fichiers et l'historique des versions servent tous le même objectif — un endroit durable et fiable pour des fichiers auxquels vous revenez sans cesse.",
        "Les dossiers partagés et Dropbox Paper en font un choix solide pour une collaboration continue, et le partage de liens est vraiment pratique pour les petites équipes déjà installées dans Dropbox au quotidien. Rien de tout cela n'est ce que Relayium essaie d'être — Relayium ne synchronise pas de dossier et ne conserve de copie de travail de rien.",
      ],
    },
    {
      heading: "L'écart : un lien de partage signifie quand même qu'un compte détient le fichier",
      body: [
        "Pour envoyer un fichier via Dropbox, il doit d'abord se trouver dans Dropbox — téléversé dans votre compte, posé dans un dossier, avant que vous ne génériez un lien partageable pour lui. Ce lien pointe vers une copie que Dropbox stocke en votre nom, lisible par l'infrastructure propre de Dropbox, et qui y reste jusqu'à ce que vous reveniez supprimer le fichier ou révoquer le lien vous-même.",
        "Pour un envoi ponctuel, c'est beaucoup d'infrastructure permanente pour un fichier que personne n'a besoin de conserver. Le mode temps réel de Relayium saute entièrement l'étape de stockage pour le cas courant : les octets se déplacent directement entre les appareils de l'expéditeur et du destinataire via une connexion pair-à-pair chiffrée de bout en bout, et le fichier n'est jamais écrit sur un serveur. Quand vous voulez vraiment un lien — parce que le destinataire n'est pas en ligne en ce moment — le mode lien stocké conserve une propriété que le partage Dropbox n'a pas : votre navigateur génère une clé AES-256-GCM aléatoire et chiffre le fichier avec elle avant le téléversement, et cette clé ne vit que dans le fragment de l'URL (la partie après le #, que les navigateurs ne transmettent jamais à un serveur). Les serveurs de Dropbox peuvent techniquement lire ce qui se trouve dans votre compte ; le serveur de Relayium, pour un lien stocké, ne détient qu'un texte chiffré qu'il n'a aucun moyen de déchiffrer.",
      ],
    },
    {
      heading: "Envoi en temps réel : le fichier ne touche jamais un serveur",
      body: [
        "Quand les deux personnes sont en ligne en même temps, le transfert direct en temps réel envoie jusqu'à 1 000 fichiers en un seul lot directement d'un appareil à l'autre — sans étape de téléversement, et sans rien stocker entre les deux. Les deux côtés reçoivent un code de vérification à 6 chiffres identique (SAS) pour repérer un homme du milieu, chaque fichier est vérifié de bout en bout par une empreinte SHA-256, et une connexion interrompue reprend au lieu de tout recommencer.",
        "Il n'y a aucune limite de taille côté serveur ; le vrai plafond vient du navigateur du destinataire. Chrome et Edge diffusent les données entrantes directement sur le disque, si bien que plusieurs dizaines de gigaoctets ne posent aucun problème, tandis que Firefox et Safari mettent en mémoire tampon, donc gardez ces transferts sous environ 200 Mo. Sur le même réseau — par exemple en envoyant vers l'ordinateur portable d'un collègue via le Wi-Fi du bureau — aucun compte n'est nécessaire du tout. Envoyer entre réseaux différents utilise un code d'appairage et exige que l'expéditeur se connecte ; le destinataire n'a jamais besoin de compte, dans un cas comme dans l'autre. Si une connexion directe est impossible, le transfert bascule vers un relais TURN chiffré qui ne voit que du texte chiffré.",
      ],
    },
    {
      heading: "Quand un lien s'impose : à divulgation nulle, expiration automatique",
      body: [
        "Parfois un lien est vraiment le bon outil — le destinataire dort dans un autre fuseau horaire, ou vous voulez une seule URL à coller dans un e-mail plutôt que de coordonner une session en direct. Le mode lien stocké de Relayium est conçu exactement pour ce cas, sans renoncer à la confidentialité du mode temps réel.",
        "Vous choisissez combien de temps il vit — 1 heure, 1 jour, 3 jours ou 7 jours — ou le réglez pour qu'il se détruise après le premier téléchargement complet, si bien qu'aucune copie persistante ne traîne à nettoyer. Créer le lien exige que l'expéditeur se connecte (cela compte dans un quota de stockage du compte), mais le destinataire n'a qu'à l'ouvrir et télécharger — aucun compte façon Dropbox requis de son côté. Comme la clé de déchiffrement ne quitte jamais le fragment de l'URL, le serveur de Relayium pour un lien stocké est structurellement incapable de lire ce qu'il contient, une garantie différente de celle d'un lien de partage Dropbox, où l'infrastructure propre de Dropbox peut techniquement déchiffrer le fichier qu'elle héberge.",
      ],
    },
    {
      heading: "Côte à côte",
      body: ["Les différences les plus pertinentes pour un envoi ponctuel :"],
      bullets: [
        "Objectif : Dropbox est un stockage durable, toujours synchronisé, conçu pour des dossiers où vous continuez à travailler ; Relayium est conçu pour remettre un seul fichier — P2P en temps réel ou lien à expiration automatique, sans rien laisser derrière.",
        "Où finit le fichier : un lien de partage Dropbox pointe vers une copie qui reste dans votre compte jusqu'à ce que vous la supprimiez ; le temps réel de Relayium ne stocke jamais le fichier, et les liens stockés expirent automatiquement (1 h/1 j/3 j/7 j) ou se détruisent après le premier téléchargement.",
        "Qui peut le lire : l'infrastructure de Dropbox peut techniquement déchiffrer les fichiers de votre compte ; les liens stockés de Relayium sont à divulgation nulle — la clé n'existe que dans le fragment de l'URL, donc le serveur détient un texte chiffré qu'il ne peut pas lire.",
        "Comptes : Dropbox exige un compte pour téléverser et partager ; Relayium ne demande aucun compte du tout sur le même réseau, et seul l'expéditeur se connecte pour un envoi entre réseaux ou un lien stocké — le destinataire n'en a jamais besoin.",
        "Limites de taille : Dropbox est borné par le quota de stockage de votre offre ; le temps réel de Relayium n'a aucune limite côté serveur (Chrome/Edge diffusent sur le disque pour plusieurs dizaines de Go ; gardez Firefox/Safari sous ~200 Mo).",
        "Coût et ouverture : Relayium est gratuit et sous licence MIT sur github.com/relayium/relayium, et tourne dans le navigateur sur Windows, macOS, Linux, Android et iOS sans rien installer.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Le fichier reste-t-il dans un compte comme avec Dropbox ?",
        a: "Pas avec le transfert en temps réel — le fichier se déplace directement entre les appareils et n'est jamais stocké sur un serveur. Un lien de téléchargement stocke bien quelque chose côté serveur, mais uniquement un texte chiffré à divulgation nulle que le serveur ne peut pas déchiffrer ; il expire (1 h/1 j/3 j/7 j) ou se détruit après le premier téléchargement.",
      },
      {
        q: "Mon destinataire doit-il s'inscrire quelque part ?",
        a: "Non. Sur le même réseau, aucun des deux côtés n'a besoin de compte. Envoyer entre réseaux avec un code d'appairage, ou créer un lien de téléchargement stocké, exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte, dans les deux cas.",
      },
      {
        q: "Y a-t-il une limite de taille de fichier ?",
        a: "Les transferts en temps réel gèrent jusqu'à 1 000 fichiers par lot sans limite de taille côté serveur — Chrome et Edge diffusent directement sur le disque pour plusieurs dizaines de gigaoctets, tandis que Firefox et Safari mettent en mémoire tampon, gardez donc ces transferts sous environ 200 Mo. Les liens stockés comptent dans un quota lié au compte de l'expéditeur.",
      },
      {
        q: "Est-ce gratuit d'utiliser Relayium à la place d'une offre Dropbox ?",
        a: "Oui. Relayium est gratuit et open source sous licence MIT, avec l'intégralité du protocole et du code sur github.com/relayium/relayium — aucune offre payante ne verrouille des transferts plus grands ou plus rapides.",
      },
    ],
  },
  cta: {
    text: "Envoyez le fichier directement, sans le déposer dans le compte de qui que ce soit — sans limite de taille, sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل Dropbox لإرسال ملف",
  description:
    "مقارنة منصفة لتسليم ملف واحد: Dropbox ممتاز للمزامنة الدائمة والروابط المشتركة، لكنّ الملف ينتهي به المطاف داخل حساب. أمّا Relayium فيرسله مباشرةً من الند للند، أو عبر رابط بمعرفة صفرية ينتهي.",
  updatedLabel: "آخر تحديث",
  lead: [
    "يستحقّ Dropbox سمعته. فهو يزامن مجلدًا عبر كل جهاز تملكه، ويحتفظ بسجلّ إصدارات حين تكتب فوق شيء بالخطأ، ويجعل تسليم مجلد مشروع كامل إلى عميل عبر دعوة برابط مشترك أمرًا بلا عناء. فإذا أردت مجلد عمل يبقى متزامنًا وحسب، فإنّ Dropbox يؤدّي هذه المهمّة جيّدًا، وهذه المقالة ليست حجّةً ضدّ استخدامه على هذا النحو.",
    "يظهر الاحتكاك في مهمّة أضيق: لديك ملف واحد، ومستقبِل واحد، ولا حاجة مستمرّة لأن يبقى في أي مكان بعد ذلك — ملف PDF موقّع، أو تصدير فيديو، أو ملف مضغوط من الصور. ومع ذلك يطلب منك Dropbox أن تُسقط ذلك الملف في حسابك، وتولّد رابط مشاركة، وتفكّر في مَن غيرك يملك صلاحية الوصول إلى ذلك المجلد. أمّا Relayium فمبني لهذه المهمّة الأضيق تحديدًا: يذهب الملف مباشرةً إلى جهاز الشخص الآخر، أو يصبح رابطًا لا يُفكّ تشفيره إلا في متصفّحه ويختفي وفق جدول تحدّده أنت.",
  ],
  sections: [
    {
      heading: "ما الذي يُتقنه Dropbox حقًّا",
      body: [
        "القوّة الأساسية لـ Dropbox هي أنّ المجلد الذي تعتمد عليه يكون دائمًا محدَّثًا في كل مكان: حرِّر ملفًّا على حاسوبك المحمول فيكون محدَّثًا أصلاً على هاتفك حين تتفقّده. المزامنة الانتقائية، ومزامنة الشبكة المحلية لعمليات النقل المحلية الكبيرة، واسترجاع الملفات وسجلّ الإصدارات، كلها تخدم الهدف نفسه — مكانًا دائمًا يُعتمَد عليه لملفات تعود إليها مرارًا.",
        "والمجلدات المشتركة وDropbox Paper تجعله خيارًا متينًا للتعاون المستمرّ، ومشاركة الروابط فيه مريحة فعلاً للفرق الصغيرة التي تعيش أصلاً في Dropbox يوميًّا. لا شيء من ذلك هو ما يحاول Relayium أن يكونه — فـ Relayium لا يزامن مجلدًا ولا يحتفظ بنسخة عمل لأي شيء.",
      ],
    },
    {
      heading: "الفجوة: رابط المشاركة يعني مع ذلك أنّ حسابًا يحتفظ بالملف",
      body: [
        "لإرسال ملف واحد عبر Dropbox، يجب أولاً أن يكون داخل Dropbox — مرفوعًا إلى حسابك، جالسًا في مجلد، قبل أن تولّد له رابطًا قابلاً للمشاركة. وهذا الرابط يشير إلى نسخة يخزّنها Dropbox نيابةً عنك، قابلة للقراءة من بنية Dropbox التحتية الخاصة، وتبقى هناك إلى أن تعود وتحذف الملف أو تُبطِل الرابط بنفسك.",
        "ولإرسال لمرّة واحدة، فذلك قدرٌ كبير من البنية التحتية الدائمة لملف لا يحتاج أحد إلى الاحتفاظ به. والوضع الفوري في Relayium يتخطّى التخزين كليًّا في الحالة الشائعة: تتحرّك البايتات مباشرةً بين جهازَي المُرسِل والمُستقبِل عبر اتصال من الند للند مشفّر من الطرف إلى الطرف، ولا يُكتب الملف على خادم قط. وحين ترغب فعلاً في رابط — لأنّ المُستقبِل ليس متصلاً الآن — يحتفظ وضع الرابط المُخزَّن بخاصّية لا تملكها مشاركة Dropbox: يولّد متصفّحك مفتاح AES-256-GCM عشوائيًّا ويشفّر الملف به قبل الرفع، وهذا المفتاح يبقى فقط في مقطع الـ URL (الجزء الذي يلي #، والذي لا ترسله المتصفّحات إلى خادم أبدًا). خوادم Dropbox تستطيع تقنيًّا قراءة ما في حسابك؛ أمّا خادم Relayium، بالنسبة إلى رابط مُخزَّن، فلا يحتفظ إلا بنص مُشفَّر لا سبيل له إلى فكّ تشفيره.",
      ],
    },
    {
      heading: "الإرسال الفوري: الملف لا يمسّ خادمًا أبدًا",
      body: [
        "حين يكون الشخصان متصلين في الوقت نفسه، يرسل النقل المباشر الفوري ما يصل إلى 1,000 ملف في دفعة واحدة مباشرةً من جهاز إلى آخر — دون خطوة رفع، ودون تخزين أي شيء بينهما. ويحصل الطرفان على رمز تحقق متطابق من 6 أرقام (SAS) لالتقاط أي هجوم وسيط، ويُتحقَّق من كل ملف ببصمة SHA-256 من الطرف إلى الطرف، والاتصال المنقطع يُستأنف بدلاً من إعادة كل شيء من البداية.",
        "لا يوجد حدّ حجم من جهة الخادم؛ والسقف الحقيقي هو المتصفّح المُستقبِل. يبثّ Chrome وEdge البيانات الواردة مباشرةً إلى القرص، فعشرات الغيغابايتات ليست مشكلة، بينما يخزّن Firefox وSafari مؤقتًا في الذاكرة، فأبقِ تلك العمليات دون نحو 200 MB. وعلى نفس الشبكة — كأن ترسل إلى حاسوب زميل محمول عبر Wi-Fi المكتب — لا حاجة إلى حساب على الإطلاق. أمّا الإرسال عبر شبكات مختلفة فيستخدم رمز اقتران ويتطلّب أن يسجّل المُرسِل الدخول؛ ولا يحتاج المُستقبِل إلى حساب في كلتا الحالتين. وعندما يتعذّر الاتصال المباشر، يتراجع إلى مُرحِّل TURN مُشفَّر لا يرى سوى نص مُشفَّر.",
      ],
    },
    {
      heading: "حين تحتاج إلى رابط بدلاً من ذلك: معرفة صفرية، وانتهاء ذاتي",
      body: [
        "أحيانًا يكون الرابط حقًّا الأداة الصحيحة — فالمُستقبِل نائم في منطقة زمنية أخرى، أو تريد رابط URL واحدًا تلصقه في بريد إلكتروني بدلاً من تنسيق جلسة مباشرة. ووضع الرابط المُخزَّن في Relayium مبني لهذا تمامًا، دون التخلّي عن خصوصية الوضع الفوري.",
        "تختار كم يعيش — ساعة واحدة، أو يومًا واحدًا، أو 3 أيام، أو 7 أيام — أو تضبطه ليُحرَق بعد أول تنزيل مكتمل، فلا تبقى نسخة عالقة تتذكّر تنظيفها. ويتطلّب إنشاء الرابط أن يسجّل المُرسِل الدخول (فهو يُحتسب ضمن حصّة تخزين على الحساب)، لكنّ المُستقبِل يفتحه ببساطة ويُنزّل — دون حساب على طريقة Dropbox من جهته. ولأنّ مفتاح فكّ التشفير لا يغادر مقطع الـ URL أبدًا، فإنّ خادم Relayium بالنسبة إلى رابط مُخزَّن عاجز بنيويًّا عن قراءة ما بداخله، وهو ضمان مختلف عن رابط مشاركة Dropbox، حيث تستطيع بنية Dropbox التحتية الخاصة أن تفكّ تشفير الملف الذي تستضيفه تقنيًّا.",
      ],
    },
    {
      heading: "جنبًا إلى جنب",
      body: ["الفروق الأكثر صلة بالإرسال لمرّة واحدة:"],
      bullets: [
        "الغرض: Dropbox تخزين دائم متزامن دائمًا مبني لمجلدات تواصل العمل فيها؛ أمّا Relayium فمبني لتسليم ملف واحد — من الند للند فوريًّا أو رابط ينتهي ذاتيًّا، دون أن يبقى شيء خلفك.",
        "أين ينتهي الملف: رابط مشاركة Dropbox يشير إلى نسخة تبقى في حسابك حتى تحذفها؛ أمّا الوضع الفوري في Relayium فلا يخزّن الملف قط، والروابط المُخزَّنة تنتهي تلقائيًّا (ساعة/يوم/3 أيام/7 أيام) أو تُحرَق بعد أول تنزيل.",
        "مَن يستطيع قراءته: بنية Dropbox التحتية تستطيع تقنيًّا فكّ تشفير الملفات في حسابك؛ أمّا الروابط المُخزَّنة في Relayium فبمعرفة صفرية — المفتاح موجود فقط في مقطع الـ URL، فيحتفظ الخادم بنص مُشفَّر لا يستطيع قراءته.",
        "الحسابات: Dropbox يتطلّب حسابًا للرفع والمشاركة؛ أمّا Relayium فلا يحتاج حسابًا على الإطلاق على نفس الشبكة، ولا يسجّل الدخول إلا المُرسِل للإرسال عبر الشبكات أو للرابط المُخزَّن — والمُستقبِل لا يحتاج إليه أبدًا.",
        "حدود الحجم: Dropbox محدود بحصّة تخزين خطّتك؛ أمّا الوضع الفوري في Relayium فلا حدّ له من جهة الخادم (Chrome/Edge يبثّان إلى القرص لعشرات الغيغابايتات؛ أبقِ Firefox/Safari دون نحو 200 MB).",
        "التكلفة والانفتاح: Relayium مجاني ومرخّص بـ MIT على github.com/relayium/relayium، ويعمل في المتصفّح على Windows وmacOS وLinux وAndroid وiOS دون أي تثبيت.",
      ],
    },
  ],
  faq: {
    heading: "أسئلة شائعة",
    items: [
      {
        q: "هل يبقى الملف في حساب كما يحدث مع Dropbox؟",
        a: "ليس مع النقل الفوري — يتحرّك الملف مباشرةً بين الأجهزة ولا يُخزَّن على خادم قط. أمّا رابط التنزيل فيخزّن شيئًا من جهة الخادم، لكنّه نص مُشفَّر بمعرفة صفرية فقط لا يستطيع الخادم فكّ تشفيره، وينتهي (ساعة/يوم/3 أيام/7 أيام) أو يُحرَق بعد أول تنزيل.",
      },
      {
        q: "هل يحتاج المُستقبِل إلى التسجيل في أي شيء؟",
        a: "لا. على نفس الشبكة، لا يحتاج أي من الطرفين إلى حساب. أمّا الإرسال عبر الشبكات برمز اقتران، أو إنشاء رابط تنزيل مُخزَّن، فيتطلّب أن يسجّل المُرسِل الدخول — والمُستقبِل لا يحتاج إلى حساب أبدًا، في كلتا الحالتين.",
      },
      {
        q: "هل هناك حدّ لحجم الملف؟",
        a: "تتعامل عمليات النقل الفوري مع ما يصل إلى 1,000 ملف في الدفعة الواحدة دون حدّ حجم من جهة الخادم — يبثّ Chrome وEdge مباشرةً إلى القرص لعشرات الغيغابايتات، بينما يخزّن Firefox وSafari مؤقتًا في الذاكرة، فأبقِ تلك العمليات دون نحو 200 MB. أمّا الروابط المُخزَّنة فتُحتسب ضمن حصّة مرتبطة بحساب المُرسِل.",
      },
      {
        q: "هل استخدام Relayium بدلاً من خطّة Dropbox مجاني؟",
        a: "نعم. Relayium مجاني ومفتوح المصدر بموجب رخصة MIT، مع البروتوكول والشيفرة كاملةً على github.com/relayium/relayium — لا فئة مدفوعة تحجب عمليات نقل أكبر أو أسرع.",
      },
    ],
  },
  cta: {
    text: "أرسِل الملف مباشرةً، دون وضعه في حساب أي أحد — بلا حدّ حجم، وبلا تثبيت، وبلا حاجة إلى حساب على نفس الشبكة.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Relayium vs Dropbox para enviar un archivo",
  description:
    "Una comparación justa para entregar un archivo: Dropbox es excelente para la sincronización duradera y los enlaces compartidos, pero el archivo acaba viviendo en una cuenta. Relayium lo envía directamente, de igual a igual, o mediante un enlace de conocimiento cero que caduca.",
  updatedLabel: "Última actualización",
  lead: [
    "Dropbox se gana su reputación. Sincroniza una carpeta en todas las máquinas que posees, mantiene un historial de versiones cuando sobrescribes algo por accidente, y hace indoloro entregar una carpeta de proyecto entera a un cliente con una invitación por enlace para compartir. Si quieres una carpeta de trabajo que simplemente se mantenga sincronizada, Dropbox hace bien ese trabajo y esto no es un argumento en contra de usarlo así.",
    "La fricción aparece en un trabajo más acotado: tienes un archivo, un destinatario, y ninguna necesidad continua de que viva en ningún sitio después — un PDF firmado, un vídeo exportado, un zip de fotos. Dropbox aún te pide dejar ese archivo en tu cuenta, generar un enlace para compartir, y pensar en quién más tiene acceso a esa carpeta. Relayium está construido específicamente para ese trabajo más acotado: el archivo va directo al dispositivo de la otra persona, o se convierte en un enlace que solo se descifra en su navegador y desaparece según un calendario que tú fijas.",
  ],
  sections: [
    {
      heading: "En qué es genuinamente bueno Dropbox",
      body: [
        "La fortaleza central de Dropbox es que una carpeta de la que dependes está siempre al día en todas partes: edita un archivo en tu portátil y ya está actualizado en tu teléfono para cuando lo consultas. La sincronización selectiva, la sincronización por red local para grandes transferencias locales, y la recuperación de archivos/historial de versiones sirven todas al mismo objetivo — un lugar duradero y fiable para los archivos a los que vuelves una y otra vez.",
        "Las carpetas compartidas y Dropbox Paper lo convierten en una opción sólida para la colaboración continua, y su compartición por enlace es genuinamente cómoda para equipos pequeños que ya viven en Dropbox a diario. Nada de eso es lo que Relayium intenta ser — Relayium no sincroniza una carpeta ni mantiene una copia de trabajo de nada.",
      ],
    },
    {
      heading: "El hueco: un enlace para compartir sigue significando que una cuenta guarda el archivo",
      body: [
        "Para enviar un archivo a través de Dropbox, primero tiene que estar dentro de Dropbox — subido a tu cuenta, alojado en una carpeta, antes de que generes un enlace compartible para él. Ese enlace apunta a una copia que Dropbox guarda en tu nombre, legible por la propia infraestructura de Dropbox y que permanece ahí hasta que vuelvas y elimines el archivo o revoques el enlace tú mismo.",
        "Para un envío puntual, eso es mucha infraestructura permanente para un archivo que nadie necesita conservar. El modo en tiempo real de Relayium omite por completo el almacenamiento en el caso común: los bytes se mueven directamente entre los dispositivos del remitente y del destinatario sobre una conexión de igual a igual cifrada de extremo a extremo, y el archivo nunca se escribe en ningún servidor. Cuando sí quieres un enlace — porque el destinatario no está en línea ahora mismo — el modo de enlace almacenado conserva una propiedad que la compartición de Dropbox no tiene: tu navegador genera una clave AES-256-GCM aleatoria y cifra el archivo con ella antes de la subida, y esa clave vive solo en el fragmento de la URL (la parte después del #, que los navegadores nunca transmiten a un servidor). Los servidores de Dropbox pueden técnicamente leer lo que hay en tu cuenta; el servidor de Relayium, para un enlace almacenado, guarda solo texto cifrado que no tiene forma de descifrar.",
      ],
    },
    {
      heading: "Envío en tiempo real: el archivo nunca toca un servidor",
      body: [
        "Cuando ambas personas están en línea al mismo tiempo, la transferencia directa en tiempo real envía hasta 1.000 archivos en un solo lote directamente de un dispositivo al otro — sin paso de subida, y sin nada almacenado en medio. Ambos lados obtienen un código de verificación de 6 dígitos coincidente (SAS) para detectar cualquier ataque de intermediario, cada archivo se comprueba con un hash SHA-256 de extremo a extremo, y una conexión caída se reanuda en lugar de reiniciar todo.",
        "No hay límite de tamaño del lado del servidor; el techo real es el navegador que recibe. Chrome y Edge transmiten los datos entrantes directamente al disco, así que decenas de gigabytes no son problema, mientras que Firefox y Safari almacenan en memoria, así que mantén esas transferencias por debajo de unos 200 MB. En la misma red — por ejemplo, enviando al portátil de un compañero por la Wi-Fi de la oficina — no hace falta cuenta en absoluto. Enviar entre redes distintas usa un código de emparejamiento y requiere que el remitente inicie sesión; el destinatario nunca necesita cuenta en ninguno de los casos. Cuando una conexión directa no es posible, recurre a un retransmisor TURN cifrado que solo ve texto cifrado.",
      ],
    },
    {
      heading: "Cuando en cambio necesitas un enlace: conocimiento cero, autocaducante",
      body: [
        "A veces un enlace es genuinamente la herramienta correcta — el destinatario duerme en otra zona horaria, o quieres una sola URL para pegar en un correo en lugar de coordinar una sesión en vivo. El modo de enlace almacenado de Relayium está hecho exactamente para eso, sin renunciar a la privacidad del modo en tiempo real.",
        "Eliges cuánto vive — 1 hora, 1 día, 3 días o 7 días — o lo configuras para que se destruya tras la primera descarga completada, así no queda ninguna copia persistente que recordar limpiar. Crear el enlace requiere que el remitente inicie sesión (cuenta contra una cuota de almacenamiento de la cuenta), pero el destinatario simplemente lo abre y descarga — sin cuenta al estilo Dropbox requerida por su parte. Como la clave de descifrado nunca abandona el fragmento de la URL, el servidor de Relayium para un enlace almacenado es estructuralmente incapaz de leer lo que hay dentro, lo cual es una garantía distinta de un enlace para compartir de Dropbox, donde la propia infraestructura de Dropbox puede técnicamente descifrar el archivo que aloja.",
      ],
    },
    {
      heading: "Lado a lado",
      body: ["Las diferencias más relevantes para un envío puntual:"],
      bullets: [
        "Propósito: Dropbox es almacenamiento duradero y siempre sincronizado, hecho para carpetas en las que sigues trabajando; Relayium está hecho para entregar un archivo — P2P en tiempo real o un enlace autocaducante, sin dejar nada atrás.",
        "Dónde acaba el archivo: un enlace para compartir de Dropbox apunta a una copia que permanece en tu cuenta hasta que la elimines; el tiempo real de Relayium nunca almacena el archivo, y los enlaces almacenados caducan automáticamente (1h/1d/3d/7d) o se destruyen tras la primera descarga.",
        "Quién puede leerlo: la infraestructura de Dropbox puede técnicamente descifrar los archivos de tu cuenta; los enlaces almacenados de Relayium son de conocimiento cero — la clave existe solo en el fragmento de la URL, así que el servidor guarda texto cifrado que no puede leer.",
        "Cuentas: Dropbox requiere una cuenta para subir y compartir; Relayium no necesita cuenta en absoluto en la misma red, y solo el remitente inicia sesión para el envío entre redes o de enlace almacenado — el destinatario nunca necesita una.",
        "Límites de tamaño: Dropbox está limitado por la cuota de almacenamiento de tu plan; el tiempo real de Relayium no tiene límite del lado del servidor (Chrome/Edge transmiten al disco para decenas de GB; mantén Firefox/Safari por debajo de ~200 MB).",
        "Coste y apertura: Relayium es gratis y con licencia MIT en github.com/relayium/relayium, y funciona en el navegador en Windows, macOS, Linux, Android e iOS sin nada que instalar.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿El archivo se queda en una cuenta como pasaría con Dropbox?",
        a: "No con la transferencia en tiempo real — el archivo se mueve directamente entre dispositivos y nunca se almacena en un servidor. Un enlace de descarga sí almacena algo del lado del servidor, pero solo texto cifrado de conocimiento cero que el servidor no puede descifrar, y caduca (1h/1d/3d/7d) o se destruye tras la primera descarga.",
      },
      {
        q: "¿Mi destinatario necesita registrarse en algo?",
        a: "No. En la misma red, ninguno de los dos lados necesita cuenta. Enviar entre redes con un código de emparejamiento, o crear un enlace de descarga almacenado, requiere que el remitente inicie sesión — el destinatario nunca necesita cuenta, en cualquiera de los casos.",
      },
      {
        q: "¿Hay un límite de tamaño de archivo?",
        a: "Las transferencias en tiempo real manejan hasta 1.000 archivos por lote sin límite de tamaño del lado del servidor — Chrome y Edge transmiten directo al disco para decenas de gigabytes, mientras que Firefox y Safari almacenan en memoria, así que mantén esas por debajo de unos 200 MB. Los enlaces almacenados cuentan contra una cuota vinculada a la cuenta del remitente.",
      },
      {
        q: "¿Es gratis usar Relayium en lugar de un plan de Dropbox?",
        a: "Sí. Relayium es gratis y de código abierto bajo la licencia MIT, con el protocolo y el código completos en github.com/relayium/relayium — no hay ningún nivel de pago que limite transferencias más grandes o más rápidas.",
      },
    ],
  },
  cta: {
    text: "Envía el archivo directamente, sin ponerlo en la cuenta de nadie — sin límite de tamaño, sin instalación, y sin cuenta en la misma red.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs Dropbox para enviar um arquivo",
  description:
    "Uma comparação justa para entregar um único arquivo: o Dropbox é excelente para sincronização duradoura e links compartilhados, mas o arquivo acaba morando em uma conta. O Relayium o envia diretamente, ponto a ponto, ou por um link de conhecimento zero que expira.",
  updatedLabel: "Última atualização",
  lead: [
    "O Dropbox merece sua reputação. Ele sincroniza uma pasta em todas as máquinas que você possui, mantém um histórico de versões quando você sobrescreve algo por acidente, e torna indolor entregar uma pasta de projeto inteira a um cliente com um convite por link de compartilhamento. Se você quer uma pasta de trabalho que simplesmente permaneça sincronizada, o Dropbox faz bem esse trabalho e isto não é um argumento contra usá-lo assim.",
    "O atrito aparece em uma tarefa mais estreita: você tem um arquivo, um destinatário, e nenhuma necessidade contínua de que ele fique em algum lugar depois — um PDF assinado, um vídeo exportado, um zip de fotos. O Dropbox ainda pede que você largue esse arquivo na sua conta, gere um link de compartilhamento, e pense em quem mais tem acesso a essa pasta. O Relayium é construído especificamente para essa tarefa mais estreita: o arquivo vai direto para o dispositivo da outra pessoa, ou vira um link que só se descriptografa no navegador dela e desaparece conforme um cronograma que você define.",
  ],
  sections: [
    {
      heading: "Em que o Dropbox é genuinamente bom",
      body: [
        "A força central do Dropbox é que uma pasta da qual você depende está sempre atualizada em todo lugar: edite um arquivo no seu notebook e ele já está atualizado no seu telefone quando você for conferir. A sincronização seletiva, a sincronização por rede local para grandes transferências locais, e a recuperação de arquivos/histórico de versões servem todas ao mesmo objetivo — um lugar duradouro e confiável para os arquivos aos quais você volta sempre.",
        "As pastas compartilhadas e o Dropbox Paper fazem dele uma escolha sólida para colaboração contínua, e seu compartilhamento por link é genuinamente conveniente para equipes pequenas que já vivem no Dropbox no dia a dia. Nada disso é o que o Relayium tenta ser — o Relayium não sincroniza uma pasta nem mantém uma cópia de trabalho de nada.",
      ],
    },
    {
      heading: "A lacuna: um link de compartilhamento ainda significa que uma conta guarda o arquivo",
      body: [
        "Para enviar um arquivo pelo Dropbox, ele primeiro precisa estar dentro do Dropbox — enviado para a sua conta, parado em uma pasta, antes de você gerar um link compartilhável para ele. Esse link aponta para uma cópia que o Dropbox armazena em seu nome, legível pela própria infraestrutura do Dropbox e que fica lá até você voltar e apagar o arquivo ou revogar o link você mesmo.",
        "Para um envio pontual, isso é muita infraestrutura permanente para um arquivo que ninguém precisa guardar. O modo em tempo real do Relayium pula o armazenamento por completo no caso comum: os bytes se movem diretamente entre os dispositivos do remetente e do destinatário por uma conexão ponto a ponto criptografada de ponta a ponta, e o arquivo nunca é gravado em um servidor. Quando você realmente quer um link — porque o destinatário não está on-line agora — o modo de link armazenado mantém uma propriedade que o compartilhamento do Dropbox não tem: seu navegador gera uma chave AES-256-GCM aleatória e criptografa o arquivo com ela antes do upload, e essa chave vive apenas no fragmento da URL (a parte depois do #, que os navegadores nunca transmitem a um servidor). Os servidores do Dropbox podem tecnicamente ler o que está na sua conta; o servidor do Relayium, para um link armazenado, guarda apenas texto cifrado que não tem como descriptografar.",
      ],
    },
    {
      heading: "Envio em tempo real: o arquivo nunca toca um servidor",
      body: [
        "Quando as duas pessoas estão on-line ao mesmo tempo, a transferência direta em tempo real envia até 1.000 arquivos em um único lote direto de um dispositivo para o outro — sem etapa de upload, e sem nada armazenado no meio. Os dois lados recebem um código de verificação de 6 dígitos correspondente (SAS) para pegar qualquer ataque de intermediário, cada arquivo é verificado com um hash SHA-256 de ponta a ponta, e uma conexão caída é retomada em vez de recomeçar tudo.",
        "Não há limite de tamanho do lado do servidor; o teto real é o navegador que recebe. Chrome e Edge transmitem os dados que chegam direto para o disco, então dezenas de gigabytes não são problema, enquanto Firefox e Safari armazenam na memória, então mantenha essas transferências abaixo de cerca de 200 MB. Na mesma rede — digamos, enviando para o notebook de um colega pela Wi-Fi do escritório — não é preciso conta alguma. Enviar entre redes diferentes usa um código de emparelhamento e exige que o remetente faça login; o destinatário nunca precisa de conta em nenhum dos casos. Quando uma conexão direta não é possível, ela recorre a um retransmissor TURN criptografado que só vê texto cifrado.",
      ],
    },
    {
      heading: "Quando você precisa de um link: conhecimento zero, com expiração automática",
      body: [
        "Às vezes um link é genuinamente a ferramenta certa — o destinatário está dormindo em outro fuso horário, ou você quer uma única URL para colar em um e-mail em vez de coordenar uma sessão ao vivo. O modo de link armazenado do Relayium é feito exatamente para isso, sem abrir mão da privacidade do modo em tempo real.",
        "Você escolhe quanto tempo ele vive — 1 hora, 1 dia, 3 dias ou 7 dias — ou o configura para se autodestruir após o primeiro download concluído, então não sobra nenhuma cópia persistente para você lembrar de limpar. Criar o link exige que o remetente faça login (ele conta contra uma cota de armazenamento da conta), mas o destinatário apenas o abre e baixa — sem conta ao estilo Dropbox exigida do lado dele. Como a chave de descriptografia nunca deixa o fragmento da URL, o servidor do Relayium para um link armazenado é estruturalmente incapaz de ler o que há dentro dele, o que é uma garantia diferente de um link de compartilhamento do Dropbox, onde a própria infraestrutura do Dropbox pode tecnicamente descriptografar o arquivo que ela hospeda.",
      ],
    },
    {
      heading: "Lado a lado",
      body: ["As diferenças mais relevantes para um envio pontual:"],
      bullets: [
        "Propósito: o Dropbox é armazenamento duradouro e sempre sincronizado, feito para pastas em que você continua trabalhando; o Relayium é feito para entregar um único arquivo — P2P em tempo real ou um link com expiração automática, sem deixar nada para trás.",
        "Onde o arquivo termina: um link de compartilhamento do Dropbox aponta para uma cópia que fica na sua conta até você apagá-la; o tempo real do Relayium nunca armazena o arquivo, e os links armazenados expiram automaticamente (1h/1d/3d/7d) ou se autodestroem após o primeiro download.",
        "Quem pode lê-lo: a infraestrutura do Dropbox pode tecnicamente descriptografar arquivos na sua conta; os links armazenados do Relayium são de conhecimento zero — a chave existe apenas no fragmento da URL, então o servidor guarda texto cifrado que não consegue ler.",
        "Contas: o Dropbox exige uma conta para enviar e compartilhar; o Relayium não precisa de conta alguma na mesma rede, e só o remetente faz login para o envio entre redes ou de link armazenado — o destinatário nunca precisa de uma.",
        "Limites de tamanho: o Dropbox é limitado pela cota de armazenamento do seu plano; o tempo real do Relayium não tem limite do lado do servidor (Chrome/Edge transmitem para o disco para dezenas de GB; mantenha Firefox/Safari abaixo de ~200 MB).",
        "Custo e abertura: o Relayium é gratuito e licenciado sob MIT em github.com/relayium/relayium, e roda no navegador em Windows, macOS, Linux, Android e iOS sem nada para instalar.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O arquivo fica em uma conta como ficaria com o Dropbox?",
        a: "Não com a transferência em tempo real — o arquivo se move diretamente entre os dispositivos e nunca é armazenado em um servidor. Um link de download de fato armazena algo do lado do servidor, mas apenas texto cifrado de conhecimento zero que o servidor não consegue descriptografar, e ele expira (1h/1d/3d/7d) ou se autodestrói após o primeiro download.",
      },
      {
        q: "Meu destinatário precisa se cadastrar em algo?",
        a: "Não. Na mesma rede, nenhum dos lados precisa de conta. Enviar entre redes com um código de emparelhamento, ou criar um link de download armazenado, exige que o remetente faça login — o destinatário nunca precisa de conta, em ambos os casos.",
      },
      {
        q: "Existe um limite de tamanho de arquivo?",
        a: "As transferências em tempo real lidam com até 1.000 arquivos por lote sem limite de tamanho do lado do servidor — Chrome e Edge transmitem direto para o disco para dezenas de gigabytes, enquanto Firefox e Safari armazenam na memória, então mantenha essas abaixo de cerca de 200 MB. Os links armazenados contam contra uma cota vinculada à conta do remetente.",
      },
      {
        q: "É gratuito usar o Relayium no lugar de um plano do Dropbox?",
        a: "Sim. O Relayium é gratuito e de código aberto sob a licença MIT, com o protocolo e o código completos em github.com/relayium/relayium — não há nível pago que restrinja transferências maiores ou mais rápidas.",
      },
    ],
  },
  cta: {
    text: "Envie o arquivo diretamente, sem colocá-lo na conta de ninguém — sem limite de tamanho, sem instalação, e sem conta na mesma rede.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/dropbox",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
