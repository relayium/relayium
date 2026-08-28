// web/scripts/pages/content/articles/compare-dropbox.mjs
// Objective comparison: Relayium vs Dropbox for sending a single file (not
// durable sync/storage). English is the master; zh/ja/ko/de/fr follow the
// same structure with identical facts. Terminology mirrors src/lib/i18n/en.ts.
// Deliberately distinct wording/examples/FAQ from compare-google-drive.mjs —
// this is not a find-replace of that article.

const en = {
  title: "Relayium vs Dropbox for sending a file",
  description:
    "A fair comparison for handing off one file: Dropbox is excellent for durable sync and shared links, while Relayium offers a realtime path with no server-side content copy or history, or a zero-knowledge stored link that expires.",
  updatedLabel: "Last updated",
  lead: [
    "Dropbox earns its reputation. It syncs a folder across every machine you own, keeps a version history when you overwrite something by accident, and makes it painless to hand a whole project folder to a client with a shared-link invite. If you want a working folder that just stays in sync, Dropbox does that job well and this isn't an argument against using it that way.",
    "The friction shows up on a narrower job: one file, one recipient, and no need to keep it afterward. Dropbox puts it in an account first. Relayium instead streams it live — direct over WebRTC on the same LAN or as end-to-end ciphertext over TURN across networks — or creates a link that decrypts only in the recipient's browser and disappears on your schedule.",
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
        "For a one-off send, Relayium's realtime mode avoids a stored server-side content copy or history: WebRTC is direct on the same LAN, while cross-network browser sessions use TURN by design to carry end-to-end ciphertext the relay cannot read or decrypt. When you do want a link because the recipient is offline, the stored-link mode keeps a property Dropbox sharing lacks: your browser generates a random AES-256-GCM key and encrypts before upload, and the key lives only in the URL fragment after #, which browsers never send to a server. Dropbox can technically read files in your account; Relayium's stored-link server holds only ciphertext it cannot decrypt.",
      ],
    },
    {
      heading: "Realtime send: no server-side content copy or history",
      body: [
        "When both people are online, realtime transfer streams up to 1,000 files over the selected path: direct WebRTC on the same LAN, or TURN by design across networks. There is no upload-for-storage step or server-side realtime content history. Advanced verification (off by default) adds a matching 6-digit verification code (SAS) for both sides, every file is checked with SHA-256 end to end, and a dropped connection resumes.",
        "There's no server-side storage-size cap; the receiving browser sets the practical ceiling. Chrome and Edge stream to disk; Firefox and Safari may buffer in memory, so Relayium warns above roughly 256 MB. On the same LAN no account is needed and WebRTC connects directly. Across networks, whoever creates the pairing code signs in and the browser uses TURN by design; the relay carries only end-to-end ciphertext it cannot read or decrypt. The person joining never needs an account.",
      ],
    },
    {
      heading: "When you need a link instead: zero-knowledge, self-expiring",
      body: [
        "Sometimes a link genuinely is the right tool — the recipient is asleep in another time zone, or you want one URL to paste into an email instead of coordinating a live session. Relayium's stored-link mode is built for exactly that, without giving up the privacy of realtime mode.",
        "You pick how long it lives — 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan — or set it to burn after the first completed download, so there's no lingering copy to remember to clean up. Creating the link requires the sender to sign in (it counts against a storage quota on the account), but the recipient just opens it and downloads — no Dropbox-style account required on their end. Because the decryption key never leaves the URL fragment, Relayium's server for a stored link is structurally unable to read what's inside it, which is a different guarantee than a Dropbox share link, where Dropbox's own infrastructure can technically decrypt the file it's hosting.",
      ],
    },
    {
      heading: "Side-by-side",
      body: ["The differences most relevant to a one-off send:"],
      bullets: [
        "Purpose: Dropbox is durable synced storage; Relayium is for a one-off handoff — realtime over the appropriate LAN or TURN path, or a self-expiring stored link.",
        "Where the file ends up: Dropbox keeps an account copy until deletion; Relayium keeps no server-side realtime content copy or history, while stored links auto-expire or burn after the first download.",
        "Who can read it: Dropbox's infrastructure can technically decrypt files in your account; Relayium's stored links are zero-knowledge — the key exists only in the URL fragment, so the server holds ciphertext it can't read.",
        "Accounts: Dropbox requires an account to upload and share; Relayium needs no account on the same LAN, and only the pairing-code or stored-link creator signs in — the person joining or downloading never needs one.",
        "Size limits: Dropbox is bounded by your plan's storage quota; Relayium realtime has no server-side cap (Chrome/Edge stream to disk for tens of GB; when the browser has to buffer in memory instead, Relayium warns above roughly 256 MB).",
        "Cost and openness: Relayium is open source under AGPL-3.0 at github.com/relayium/relayium, running in the browser on Windows, macOS, Linux, Android, and iOS with nothing to install. Same-network transfers are free; cross-network relay and stored links draw on your plan's monthly traffic allowance, with a separate cap on how much you keep stored at once, and paid plans raise both.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Does the file sit in an account like it would with Dropbox?",
        a: "Not as a server-side realtime copy or history. On the same LAN WebRTC is direct; across networks TURN carries end-to-end ciphertext the relay cannot read or decrypt. A download link does store zero-knowledge ciphertext, but the server cannot decrypt it and the link expires or burns after the first download.",
      },
      {
        q: "Does my recipient need to sign up for anything?",
        a: "No. On the same LAN, neither side needs an account. The pairing-code or stored-link creator signs in; the person joining the realtime session or downloading the link never needs an account.",
      },
      {
        q: "Is there a file size limit?",
        a: "Realtime transfers handle up to 1,000 files per batch with no server-side size cap — Chrome and Edge stream straight to disk for tens of gigabytes. When no streaming path applies and the browser has to buffer in memory, Relayium warns above roughly 256 MB; that figure is a deliberately conservative estimate, not a hard limit. Stored links count against a quota tied to the sender's account.",
      },
      {
        q: "Is Relayium free to use instead of a Dropbox plan?",
        a: "Mostly. The software is free and open source under the AGPL-3.0 license, with the full protocol and code at github.com/relayium/relayium, and browser transfers on the same network are free with no size limit. Cross-network relay and stored download links draw on limits every account gets: a monthly traffic allowance, and a separate cap on how much you keep stored at once. Paid plans raise both, and running your own node keeps it free at any volume.",
      },
    ],
  },
  cta: {
    text: "Send the file in realtime without putting it in anyone's account — no install, and no account needed on the same LAN.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 Dropbox：发送单个文件",
  description:
    "客观对比：Dropbox 擅长持久同步与分享链接；Relayium 提供不保留服务器端内容副本或历史的实时路径，或会到期的零知识存储链接。",
  updatedLabel: "最近更新",
  lead: [
    "Dropbox 的口碑是挣来的：它能把一个文件夹同步到你所有设备上，误覆盖文件时还能靠版本历史找回来，把整个项目文件夹通过分享链接交给客户也很省心。如果你要的是一个始终保持同步的工作文件夹，Dropbox 确实做得好，本文并不是要劝你别这么用它。",
    "当任务只是交接一个文件时，Dropbox 仍要先把它放进账号。Relayium 则实时传输：同一局域网 WebRTC 直连，跨网络浏览器按设计经 TURN 承载端到端密文；也可以创建只在对方浏览器解密并按时消失的链接。",
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
        "Relayium 实时模式不保留服务器端内容副本或历史：同一局域网 WebRTC 直连，跨网络浏览器按设计使用 TURN 承载中继无法读取或解密的端到端密文。对方离线时，存储链接仍保留 Dropbox 分享没有的特性：浏览器用随机 AES-256-GCM 密钥在上传前加密，密钥只存在于 # 后的 URL 片段。Dropbox 技术上可读取账号文件；Relayium 的存储链接服务器只保存无法解密的密文。",
      ],
    },
    {
      heading: "实时发送：不保留服务器端内容副本或历史",
      body: [
        "双方同时在线时，实时传输会沿选定路径流式发送最多 1,000 个文件：同一局域网 WebRTC 直连，跨网络按设计使用 TURN。没有为存储而上传的步骤，也不保留服务器端实时内容历史；双方显示一致的 6 位校验码，每个文件用 SHA-256 校验，断线后可续传。",
        "实时传输没有服务器端存储大小上限，实际限制来自接收浏览器；Chrome 和 Edge 流式写盘，Firefox 和 Safari 可能缓存在内存中，因此约 256 MB 以上会提示。同一局域网无需账号且 WebRTC 直连。跨网络时配对码创建者登录，浏览器按设计使用 TURN；中继只承载它无法读取或解密的端到端密文，加入者无需账号。",
      ],
    },
    {
      heading: "需要一条链接时：零知识、自动到期",
      body: [
        "有时候链接确实是更合适的方式——接收方在另一个时区正在睡觉，或者你想要一条可以直接贴进邮件的 URL，而不是协调一次实时会话。Relayium 的存储链接模式正是为此而生，同时不牺牲实时模式的隐私性。",
        "你可以选择链接的存活时间——1 小时、1 天、3 天、7 天或最长 14 天（取决于套餐）——或设置为首次下载后即焚，这样就不用惦记着回去清理留下的副本。创建链接需要发送方登录（会计入账号的存储配额），但接收方只需打开链接下载，不需要像 Dropbox 那样注册账号。因为解密密钥从不离开 URL 片段，Relayium 存储链接的服务器在结构上就无法读取其中内容，这和 Dropbox 分享链接不同——Dropbox 自己的基础设施在技术上是可以解密它托管的文件的。",
      ],
    },
    {
      heading: "并排对比",
      body: ["与一次性发送最相关的差别："],
      bullets: [
        "定位：Dropbox 是持久同步存储；Relayium 用于一次性交接——沿适用的局域网或 TURN 路径实时传输，或使用自动到期的存储链接。",
        "文件去向：Dropbox 在账号内保留副本直到删除；Relayium 不保留服务器端实时内容副本或历史，存储链接会自动到期或首次下载后即焚。",
        "谁能读取：Dropbox 的基础设施在技术上可以解密你账号里的文件；Relayium 的存储链接是零知识的——密钥只存在于 URL 片段中，服务器保存的是它无法解读的密文。",
        "账号要求：Dropbox 上传和分享需要账号；Relayium 同一局域网无需账号，只有配对码或存储链接创建者登录——加入或下载的一方无需账号。",
        "大小限制：Dropbox 受你所在套餐的存储配额约束；Relayium 实时模式没有服务器端上限（Chrome/Edge 可流式写盘应对几十 GB；浏览器只能攒内存时，Relayium 会在超过约 256 MB 时给出提示）。",
        "费用与开放：Relayium 采用 AGPL-3.0 许可开源，代码在 github.com/relayium/relayium；在浏览器中运行，覆盖 Windows、macOS、Linux、Android 和 iOS，无需安装。同一网络内的传输免费；跨网络中继与存储链接会占用套餐的每月流量额度，同时存放的数据量另有一项独立上限，付费套餐两者都更高。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "文件会像在 Dropbox 里那样留在账号中吗？",
        a: "实时模式不保留服务器端副本或历史。同一局域网 WebRTC 直连；跨网络 TURN 承载中继无法读取或解密的端到端密文。下载链接会存储零知识密文，但服务器无法解密，链接会到期或首次下载后即焚。",
      },
      {
        q: "接收方需要注册什么吗？",
        a: "不需要。同一局域网双方都无需账号。配对码或存储链接创建者需要登录；加入实时会话或下载链接的一方无需账号。",
      },
      {
        q: "有文件大小限制吗？",
        a: "实时传输一次最多可处理 1,000 个文件，没有服务器端大小上限——Chrome 和 Edge 会直接流式写入磁盘，可应对几十 GB 的文件。当所有流式写盘路径都不适用、浏览器只能攒内存时，Relayium 会在超过约 256 MB 时给出提示；这个数字是刻意取的保守估计，不是硬上限。存储链接则计入发送方账号绑定的配额。",
      },
      {
        q: "用 Relayium 代替 Dropbox 套餐是免费的吗？",
        a: "大部分是。软件本身采用 AGPL-3.0 许可、免费开源，完整的协议与代码都在 github.com/relayium/relayium，同一网络内的浏览器传输免费，且不限文件大小。跨网络中继与存储下载链接会占用每个账号都有的额度：每月流量额度，以及同时存放的数据量上限，这两项彼此独立。付费套餐两者都更高；运行你自己的节点则可以在任意用量下保持免费。",
      },
    ],
  },
  cta: {
    text: "实时发送文件，不必放进任何人的账号——无需安装，同一局域网下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と Dropbox の比較：1ファイルを送る",
  description:
    "公平な比較。Dropbox は永続同期と共有リンクに優れ、Relayium はサーバー側の内容コピーや履歴を残さないリアルタイム経路、または失効するゼロ知識保存リンクを提供します。",
  updatedLabel: "最終更新",
  lead: [
    "Dropbox の評判には理由があります。所有するすべての端末でフォルダを同期し、うっかり上書きしてもバージョン履歴で戻せ、プロジェクトフォルダ丸ごとを共有リンクでクライアントに渡すのも簡単です。常に同期された作業フォルダが欲しいなら、Dropbox はその仕事をきちんとこなしますし、本記事はその使い方をやめさせようとするものではありません。",
    "1ファイルの受け渡しでも Dropbox はまずアカウントに置きます。Relayium は同じ LAN では WebRTC 直結、ネットワーク間では設計上 TURN でエンドツーエンド暗号文を運ぶリアルタイム転送、または相手のブラウザだけで復号して期限で消えるリンクを使います。",
  ],
  sections: [
    {
      heading: "Dropbox が本当に得意なこと",
      body: [
        "Dropbox の核心的な強みは、頼りにしているフォルダが常にどこでも最新であることです。ノートパソコンでファイルを編集すれば、スマートフォンを確認する頃にはもう更新されています。選択的同期、大きなローカル転送のための LAN 同期、ファイル復元・バージョン履歴、これらすべてが同じ目標（何度も戻ってくる、永続的で信頼できる置き場所）に貢献しています。",
        "共有フォルダと Dropbox Paper は継続的な協業にも適しており、リンク共有はすでに日常的に Dropbox を使う小規模チームにとって本当に便利です。これらはどれも Relayium が目指しているものではありません。Relayium はフォルダを同期せず、何かの作業用コピーを保持することもありません。",
      ],
    },
    {
      heading: "違いの核心：共有リンクの先には依然としてアカウントがある",
      body: [
        "Dropbox で1つのファイルを送るには、まずそれが Dropbox の中になければなりません。アカウントにアップロードされ、フォルダに置かれてから、共有可能なリンクを発行します。そのリンクが指すのは、Dropbox が代わりに保管しているコピーであり、Dropbox 自身のインフラが読み取ることができ、戻ってファイルを削除するかリンクを取り消すまでそこに残り続けます。",
        "Relayium のリアルタイムモードはサーバー側の内容コピーや履歴を残しません。同じ LAN は WebRTC 直結、ネットワーク間ブラウザは設計上 TURN で、リレーが読み取りも復号もできないエンドツーエンド暗号文を運びます。相手がオフラインなら、ブラウザがランダムな AES-256-GCM 鍵でアップロード前に暗号化し、鍵を # 後の URL 片にだけ置く保存リンクを使えます。Dropbox はアカウント内ファイルを技術的に読めますが、Relayium の保存リンクサーバーは復号不能な暗号文だけを保持します。",
      ],
    },
    {
      heading: "リアルタイム送信：サーバー側の内容コピーや履歴なし",
      body: [
        "双方がオンラインなら、リアルタイム転送は選択された経路で最大1,000ファイルを流します。同じ LAN は WebRTC 直結、ネットワーク間は設計上 TURN です。保存用アップロードやサーバー側のリアルタイム履歴はなく、6桁コード、SHA-256 検証、再開に対応します。",
        "サーバー側ストレージのサイズ上限はなく、実際の限界は受信ブラウザです。Chrome/Edge はディスクへ流し、Firefox/Safari はメモリに保持する場合があるため約256MB超で警告します。同じ LAN はアカウント不要で WebRTC 直結。ネットワーク間ではコード作成者がサインインし、TURN は読み取りも復号もできない暗号文だけを運び、参加者はアカウント不要です。",
      ],
    },
    {
      heading: "リンクが必要なとき：ゼロ知識で自動失効",
      body: [
        "受信者が別のタイムゾーンで眠っている、あるいはリアルタイムセッションを調整する代わりにメールに貼り付けられる1つの URL が欲しい。そんなときはリンクこそが正しい道具です。Relayium の保存リンクモードは、リアルタイムモードのプライバシーを犠牲にせずまさにその場面のために作られています。",
        "有効期限は1時間・1日・3日・7日・最長14日（プランによる）から選ぶか、最初のダウンロード完了後に削除する設定にでき、後で片付けを覚えておく必要のあるコピーが残りません。リンクの作成には送信側のサインインが必要です（アカウントの保存容量枠に計上されます）が、受信側はリンクを開いてダウンロードするだけで、Dropbox のようなアカウント登録は不要です。復号鍵が URL フラグメントから外に出ることは決してないため、Relayium の保存リンクのサーバーは構造的に中身を読み取れません。これは Dropbox の共有リンクとは異なる保証です。Dropbox 自身のインフラは、ホストしているファイルを技術的には復号できます。",
      ],
    },
    {
      heading: "並べて比較",
      body: ["一度きりの送信に最も関係する違い："],
      bullets: [
        "目的：Dropbox は永続同期ストレージ。Relayium は適切な LAN/TURN 経路でのリアルタイム受け渡し、または自動失効する保存リンクです。",
        "ファイルの行き先：Dropbox は削除までアカウント内コピーを保持。Relayium はサーバー側のリアルタイム内容コピーや履歴を残さず、保存リンクは自動失効または初回ダウンロード後に削除されます。",
        "誰が読めるか：Dropbox のインフラは技術的にアカウント内のファイルを復号できます。Relayium の保存リンクはゼロ知識で、鍵は URL フラグメントにだけ存在し、サーバーは読めない暗号文を保持します。",
        "アカウント：Dropbox はアップロードと共有に必要。Relayium は同じ LAN で不要、コードまたは保存リンク作成者だけがサインインし、参加・ダウンロード側は不要です。",
        "サイズ上限：Dropbox はプランの保存容量枠に制約されます。Relayium のリアルタイムはサーバー側の上限がありません（Chrome/Edge は数十GBまでディスクへストリーミング。ブラウザがメモリに溜めるしかない場合は約256MBを超えると警告）。",
        "費用と開放性：Relayium は無料で AGPL-3.0 ライセンス、github.com/relayium/relayium にあり、ブラウザで Windows・macOS・Linux・Android・iOS で動作し、インストールは不要です。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Dropbox のようにファイルがアカウントの中に残りますか？",
        a: "サーバー側のリアルタイムコピーや履歴は残りません。同じ LAN は WebRTC 直結、ネットワーク間 TURN は読み取りも復号もできない暗号文を運びます。保存リンクは復号不能なゼロ知識暗号文を保存し、期限または初回ダウンロードで消えます。",
      },
      {
        q: "受信者は何かに登録する必要がありますか？",
        a: "いいえ。同じ LAN は双方不要です。コードまたは保存リンク作成者はサインインしますが、リアルタイム参加者やリンクのダウンロード側は不要です。",
      },
      {
        q: "ファイルサイズに上限はありますか？",
        a: "リアルタイム転送は1バッチにつき最大1,000ファイルまで扱え、サーバー側のサイズ上限はありません。Chrome と Edge は数十ギガバイトまでそのままディスクにストリーミングします。ストリーミングで書き出せる経路がどれも使えず、ブラウザがメモリに溜めるしかない場合、Relayium は約256MBを超えると警告します。この数字は意図的に保守的な見積もりで、ハードな上限ではありません。保存リンクは送信側のアカウントに紐づく容量枠に計上されます。",
      },
      {
        q: "Dropbox のプランの代わりに Relayium を使うのは無料ですか？",
        a: "はい。Relayium は AGPL-3.0 ライセンスの無料オープンソースで、プロトコルとコードのすべてが github.com/relayium/relayium にあります。より大きく、より速い転送を解放する有料プランはありません。",
      },
    ],
  },
  cta: {
    text: "誰のアカウントにも入れず、ファイルをリアルタイム送信。インストール不要、同じ LAN ならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs Dropbox: 파일 하나 보내기",
  description:
    "공정한 비교입니다. Dropbox는 영구 동기화와 공유 링크에 강하고, Relayium은 서버 측 내용 복사본이나 기록을 남기지 않는 실시간 경로 또는 만료되는 영지식 저장 링크를 제공합니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Dropbox의 평판에는 이유가 있습니다. 소유한 모든 기기에서 폴더를 동기화하고, 실수로 덮어써도 버전 기록으로 되돌릴 수 있으며, 프로젝트 폴더 전체를 공유 링크로 클라이언트에게 넘기는 것도 수월합니다. 계속 동기화 상태를 유지하는 작업 폴더가 필요하다면 Dropbox는 그 역할을 잘 해내며, 이 글은 그런 용도로 쓰지 말라고 설득하려는 것이 아닙니다.",
    "파일 하나를 넘길 때도 Dropbox는 먼저 계정에 넣습니다. Relayium은 같은 LAN에서 WebRTC 직접 연결, 네트워크 간에는 설계상 TURN으로 종단간 암호문을 운반하는 실시간 전송, 또는 상대 브라우저에서만 복호화되고 만료되는 링크를 사용합니다.",
  ],
  sections: [
    {
      heading: "Dropbox가 정말 잘하는 것",
      body: [
        "Dropbox의 핵심 강점은 의지하는 폴더가 어디서나 항상 최신 상태라는 점입니다. 노트북에서 파일을 편집하면 휴대폰을 확인할 때쯤엔 이미 업데이트되어 있습니다. 선택적 동기화, 대용량 로컬 전송을 위한 LAN 동기화, 파일 복구·버전 기록 모두 같은 목표, 즉 계속 다시 찾게 되는 영구적이고 신뢰할 수 있는 보관 장소를 위한 것입니다.",
        "공유 폴더와 Dropbox Paper는 지속적인 협업에도 적합하고, 링크 공유는 이미 매일 Dropbox를 쓰는 소규모 팀에게는 정말 편리합니다. 이런 것들은 Relayium이 되려는 대상이 아닙니다. Relayium은 폴더를 동기화하지 않고, 무언가의 작업용 사본을 보관하지도 않습니다.",
      ],
    },
    {
      heading: "차이의 핵심: 공유 링크 뒤에는 여전히 계정이 파일을 쥐고 있다",
      body: [
        "Dropbox로 파일 하나를 보내려면 먼저 그것이 Dropbox 안에 있어야 합니다. 계정에 업로드되어 폴더에 놓인 뒤에야 공유 가능한 링크를 만들 수 있습니다. 그 링크가 가리키는 것은 Dropbox가 대신 보관하는 사본이며, Dropbox 자체 인프라가 이를 읽을 수 있고, 직접 돌아가 파일을 삭제하거나 링크를 취소할 때까지 그대로 남아 있습니다.",
        "Relayium의 실시간 모드는 서버 측 내용 복사본이나 기록을 남기지 않습니다. 같은 LAN은 WebRTC 직접 연결, 네트워크 간 브라우저는 설계상 TURN으로 릴레이가 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다. 상대가 오프라인이면 브라우저가 무작위 AES-256-GCM 키로 업로드 전에 암호화하고 키를 # 뒤 URL 조각에만 두는 저장 링크를 사용합니다. Dropbox는 계정 파일을 기술적으로 읽을 수 있지만 Relayium 저장 링크 서버는 복호화할 수 없는 암호문만 보관합니다.",
      ],
    },
    {
      heading: "실시간 전송: 서버 측 내용 복사본이나 기록 없음",
      body: [
        "양쪽이 온라인이면 실시간 전송은 선택된 경로로 최대 1,000개 파일을 스트리밍합니다. 같은 LAN은 WebRTC 직접 연결, 네트워크 간은 설계상 TURN입니다. 저장용 업로드나 서버 측 실시간 기록은 없고 6자리 코드, SHA-256 검증, 재개를 지원합니다.",
        "서버 측 저장 크기 제한은 없고 실제 한계는 받는 브라우저입니다. Chrome/Edge는 디스크로 스트리밍하고 Firefox/Safari는 메모리에 버퍼링할 수 있어 약 256 MB 이상에서 경고합니다. 같은 LAN은 계정 없이 WebRTC로 직접 연결합니다. 네트워크 간에는 코드 생성자가 로그인하고 TURN이 읽거나 복호화할 수 없는 종단간 암호문만 운반하며 참가자는 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "링크가 필요할 때: 영지식이며 자동 만료",
      body: [
        "받는 사람이 다른 시간대에서 자고 있거나, 실시간 세션을 조율하는 대신 이메일에 붙여넣을 URL 하나가 필요할 때가 있습니다. 그럴 때는 링크가 정말로 맞는 도구입니다. Relayium의 저장 링크 모드는 실시간 모드의 프라이버시를 포기하지 않고 바로 그 경우를 위해 만들어졌습니다.",
        "링크가 얼마나 유지될지 1시간, 1일, 3일, 7일, 최대 14일(요금제에 따라 다름) 중에서 선택하거나, 첫 다운로드 완료 후 삭제되도록 설정할 수 있어 나중에 정리해야 할 사본이 남지 않습니다. 링크 생성에는 보내는 쪽의 로그인이 필요하지만(계정의 저장 용량 한도에 포함됩니다), 받는 쪽은 링크를 열어 다운로드하기만 하면 되고 Dropbox 같은 계정 가입은 필요 없습니다. 복호화 키가 URL 프래그먼트를 벗어나는 일이 없기 때문에, Relayium 저장 링크의 서버는 구조적으로 내용을 읽을 수 없습니다. 이는 Dropbox 공유 링크와는 다른 보장입니다. Dropbox 자체 인프라는 호스팅하는 파일을 기술적으로 복호화할 수 있습니다.",
      ],
    },
    {
      heading: "나란히 비교",
      body: ["일회성 전송에 가장 관련 있는 차이:"],
      bullets: [
        "목적: Dropbox는 영구 동기화 저장소이고, Relayium은 적절한 LAN/TURN 경로의 실시간 전달 또는 자동 만료 저장 링크용입니다.",
        "파일 위치: Dropbox는 삭제할 때까지 계정 사본을 보관합니다. Relayium은 서버 측 실시간 내용 복사본이나 기록을 남기지 않고, 저장 링크는 만료되거나 첫 다운로드 후 삭제됩니다.",
        "누가 읽을 수 있는가: Dropbox의 인프라는 기술적으로 계정 내 파일을 복호화할 수 있음. Relayium의 저장 링크는 영지식으로, 키가 URL 프래그먼트에만 있어 서버는 읽을 수 없는 암호문을 보관함.",
        "계정: Dropbox는 계정을 요구합니다. Relayium은 같은 LAN에서 필요 없고 코드나 링크 생성자만 로그인하며 참가자나 다운로드자는 필요 없습니다.",
        "크기 제한: Dropbox는 요금제의 저장 용량 한도에 제약됨. Relayium 실시간은 서버 측 제한 없음(Chrome/Edge는 수십 GB까지 디스크로 스트리밍하고, 브라우저가 메모리에 담을 수밖에 없을 때는 약 256 MB를 넘으면 경고).",
        "비용과 개방성: Relayium은 무료이며 AGPL-3.0 라이선스로 github.com/relayium/relayium에 있고, 브라우저에서 Windows·macOS·Linux·Android·iOS로 동작하며 설치가 필요 없음.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Dropbox처럼 파일이 계정 안에 남나요?",
        a: "서버 측 실시간 복사본이나 기록은 남지 않습니다. 같은 LAN은 WebRTC 직접 연결, 네트워크 간 TURN은 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다. 저장 링크는 복호화할 수 없는 영지식 암호문을 저장하고 만료되거나 첫 다운로드 후 삭제됩니다.",
      },
      {
        q: "받는 사람이 뭔가에 가입해야 하나요?",
        a: "아니요. 같은 LAN은 양쪽 모두 계정이 필요 없습니다. 코드나 저장 링크 생성자는 로그인하지만 실시간 참가자나 링크 다운로드자는 계정이 필요 없습니다.",
      },
      {
        q: "파일 크기 제한이 있나요?",
        a: "실시간 전송은 한 번에 최대 1,000개 파일을 처리할 수 있고 서버 측 크기 제한이 없습니다. Chrome과 Edge는 수십 기가바이트까지 곧바로 디스크로 스트리밍합니다. 디스크로 흘려보낼 경로가 하나도 적용되지 않아 브라우저가 메모리에 담아야 할 때는 Relayium이 약 256 MB를 넘으면 경고합니다. 이 수치는 일부러 보수적으로 잡은 추정치이지 하드 한계가 아닙니다. 저장 링크는 보내는 쪽 계정에 연결된 용량 한도에 포함됩니다.",
      },
      {
        q: "Dropbox 요금제 대신 Relayium을 쓰는 건 무료인가요?",
        a: "네. Relayium은 AGPL-3.0 라이선스의 무료 오픈소스이며, 프로토콜과 코드 전체가 github.com/relayium/relayium에 있습니다. 더 크거나 빠른 전송을 여는 유료 등급은 없습니다.",
      },
    ],
  },
  cta: {
    text: "누구의 계정에도 넣지 않고 파일을 실시간으로 보내세요. 설치가 필요 없고 같은 LAN에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. Dropbox: eine Datei versenden",
  description:
    "Ein fairer Vergleich: Dropbox ist stark bei dauerhafter Synchronisierung und Freigabelinks; Relayium bietet einen Echtzeitpfad ohne serverseitige Inhaltskopie oder Historie oder einen ablaufenden Zero-Knowledge-Speicherlink.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Dropbox hat sich seinen Ruf verdient. Es synchronisiert einen Ordner über alle deine Geräte, bewahrt eine Versionshistorie, falls du versehentlich etwas überschreibst, und macht es mühelos, einen ganzen Projektordner per Freigabelink an eine Kundin zu übergeben. Wenn du einen Arbeitsordner willst, der einfach synchron bleibt, macht Dropbox diesen Job gut — dieser Artikel spricht nicht dagegen, es so zu nutzen.",
    "Auch für eine einzelne Übergabe legt Dropbox die Datei zuerst in ein Konto. Relayium streamt sie dagegen im selben LAN direkt per WebRTC und netzübergreifend planmäßig als Ende-zu-Ende-Chiffretext über TURN oder erstellt einen Link, der nur im Browser entschlüsselt wird und nach Zeitplan verschwindet.",
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
        "Relayiums Echtzeitmodus hinterlässt keine serverseitige Inhaltskopie oder Historie: WebRTC ist im selben LAN direkt, netzübergreifend transportiert TURN planmäßig Ende-zu-Ende-Chiffretext, den das Relay weder lesen noch entschlüsseln kann. Ist die andere Person offline, verschlüsselt ein Speicherlink vor dem Upload mit AES-256-GCM; der Schlüssel bleibt im URL-Fragment nach #. Dropbox kann Kontodateien technisch lesen, Relayiums Speicherlink-Server hält nur nicht entschlüsselbaren Chiffretext.",
      ],
    },
    {
      heading: "Echtzeit-Versand: keine serverseitige Inhaltskopie oder Historie",
      body: [
        "Sind beide online, streamt die Echtzeitübertragung bis zu 1.000 Dateien über den gewählten Pfad: WebRTC direkt im selben LAN oder planmäßig TURN zwischen Netzen. Es gibt keinen Speicher-Upload und keine serverseitige Echtzeithistorie; sechsstelliger Code, SHA-256-Prüfung und Fortsetzen bleiben erhalten.",
        "Es gibt kein serverseitiges Speichergrößenlimit; der empfangende Browser setzt die praktische Grenze. Chrome/Edge streamen auf die Festplatte, Firefox/Safari können im Speicher puffern und warnen ab etwa 256 MB. Im selben LAN ist kein Konto nötig und WebRTC direkt. Netzübergreifend meldet sich die Person an, die den Code erstellt; TURN trägt nur Ende-zu-Ende-Chiffretext, den es weder lesen noch entschlüsseln kann, und die beitretende Person braucht kein Konto.",
      ],
    },
    {
      heading: "Wenn du stattdessen einen Link brauchst: Zero-Knowledge, automatisch ablaufend",
      body: [
        "Manchmal ist ein Link wirklich das richtige Werkzeug — der Empfänger schläft in einer anderen Zeitzone, oder du willst eine einzige URL, die du in eine E-Mail einfügst, statt eine Live-Sitzung zu koordinieren. Relayiums Speicherlink-Modus ist genau dafür gebaut, ohne die Privatsphäre des Echtzeitmodus aufzugeben.",
        "Du wählst, wie lange er lebt — 1 Stunde, 1 Tag, 3 Tage, 7 Tage oder bis zu 14 Tage je nach Tarif — oder stellst ihn so ein, dass er nach dem ersten vollständigen Download vernichtet wird, sodass keine verbleibende Kopie zum Aufräumen übrig bleibt. Das Erstellen des Links erfordert die Anmeldung des Absenders (er zählt gegen ein Speicherkontingent des Kontos), aber der Empfänger öffnet ihn einfach und lädt herunter — kein Dropbox-artiges Konto auf seiner Seite nötig. Da der Entschlüsselungsschlüssel das URL-Fragment nie verlässt, ist Relayiums Server bei einem Speicherlink strukturell unfähig, dessen Inhalt zu lesen — eine andere Garantie als bei einem Dropbox-Freigabelink, wo Dropboxs eigene Infrastruktur die gehostete Datei technisch entschlüsseln kann.",
      ],
    },
    {
      heading: "Nebeneinander",
      body: ["Die für einen einmaligen Versand relevantesten Unterschiede:"],
      bullets: [
        "Zweck: Dropbox ist dauerhafter Sync-Speicher; Relayium übergibt eine Datei in Echtzeit über den passenden LAN/TURN-Pfad oder per ablaufendem Speicherlink.",
        "Wo sie landet: Dropbox behält eine Kontokopie bis zur Löschung; Relayium behält keine serverseitige Echtzeit-Inhaltskopie oder Historie, Speicherlinks laufen ab oder werden nach dem ersten Download vernichtet.",
        "Wer es lesen kann: Dropboxs Infrastruktur kann Dateien in deinem Konto technisch entschlüsseln; Relayiums Speicherlinks sind Zero-Knowledge — der Schlüssel existiert nur im URL-Fragment, sodass der Server Chiffretext hält, den er nicht lesen kann.",
        "Konten: Dropbox verlangt eines; Relayium im selben LAN nicht. Wer Code oder Link erstellt, meldet sich an; wer beitritt oder herunterlädt, braucht keines.",
        "Größenlimits: Dropbox ist durch das Speicherkontingent deines Tarifs begrenzt; Relayium-Echtzeit hat kein serverseitiges Limit (Chrome/Edge streamen für mehrere Dutzend Gigabyte auf die Festplatte; muss der Browser stattdessen im Speicher puffern, warnt Relayium oberhalb von rund 256 MB).",
        "Kosten und Offenheit: Relayium ist kostenlos und AGPL-3.0-lizenziert unter github.com/relayium/relayium und läuft im Browser unter Windows, macOS, Linux, Android und iOS ohne Installation.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Bleibt die Datei wie bei Dropbox in einem Konto?",
        a: "Keine serverseitige Echtzeitkopie oder Historie. Im selben LAN ist WebRTC direkt; netzübergreifend trägt TURN Ende-zu-Ende-Chiffretext, den es weder lesen noch entschlüsseln kann. Der Speicherlink hält nur Zero-Knowledge-Chiffretext und läuft ab oder wird nach dem ersten Download vernichtet.",
      },
      {
        q: "Muss sich mein Empfänger irgendwo anmelden?",
        a: "Nein. Im selben LAN braucht keine Seite ein Konto. Wer den Code oder Speicherlink erstellt, meldet sich an; wer der Echtzeitsitzung beitritt oder den Link lädt, braucht keines.",
      },
      {
        q: "Gibt es ein Dateigrößenlimit?",
        a: "Echtzeitübertragungen verarbeiten bis zu 1.000 Dateien pro Durchgang ohne serverseitiges Größenlimit — Chrome und Edge streamen für mehrere Dutzend Gigabyte direkt auf die Festplatte. Greift kein Streaming-Weg und muss der Browser im Arbeitsspeicher puffern, warnt Relayium oberhalb von rund 256 MB; diese Zahl ist eine bewusst konservative Schätzung, keine harte Grenze. Speicherlinks zählen gegen ein an das Konto des Absenders gebundenes Kontingent.",
      },
      {
        q: "Ist Relayium anstelle eines Dropbox-Tarifs kostenlos nutzbar?",
        a: "Ja. Relayium ist kostenlos und quelloffen unter der AGPL-3.0-Lizenz, mit dem vollständigen Protokoll und Code unter github.com/relayium/relayium — kein Bezahltarif blockiert größere oder schnellere Übertragungen.",
      },
    ],
  },
  cta: {
    text: "Sende die Datei in Echtzeit, ohne sie in ein Konto zu legen — keine Installation und im selben LAN kein Konto.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs Dropbox pour envoyer un fichier",
  description:
    "Comparatif équitable : Dropbox excelle dans la synchronisation durable et les liens partagés ; Relayium propose une voie temps réel sans copie ni historique de contenu côté serveur, ou un lien stocké à divulgation nulle qui expire.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Dropbox mérite sa réputation. Il synchronise un dossier sur tous vos appareils, conserve un historique des versions quand vous écrasez quelque chose par erreur, et permet de remettre tout un dossier de projet à un client via un lien partagé sans effort. Si vous voulez un dossier de travail qui reste simplement synchronisé, Dropbox fait bien ce travail, et cet article ne cherche pas à vous en dissuader.",
    "Même pour remettre un seul fichier, Dropbox le place d'abord dans un compte. Relayium le diffuse en temps réel : WebRTC direct sur le même LAN, ou texte chiffré de bout en bout via TURN par conception entre réseaux ; il peut aussi créer un lien déchiffré uniquement dans le navigateur et supprimé selon votre calendrier.",
  ],
  sections: [
    {
      heading: "Ce en quoi Dropbox est vraiment bon",
      body: [
        "La force centrale de Dropbox est qu'un dossier sur lequel vous comptez est toujours à jour partout : modifiez un fichier sur votre ordinateur portable, il est déjà à jour sur votre téléphone le temps que vous le consultiez. La synchronisation sélective, la synchronisation LAN pour les gros transferts locaux, la récupération de fichiers et l'historique des versions servent tous le même objectif — un endroit durable et fiable pour des fichiers auxquels vous revenez sans cesse.",
        "Les dossiers partagés et Dropbox Paper en font un choix solide pour une collaboration continue, et le partage de liens est vraiment pratique pour les petites équipes déjà installées dans Dropbox au quotidien. Rien de tout cela n'est ce que Relayium essaie d'être — Relayium ne synchronise pas de dossier et ne conserve de copie de travail de rien.",
      ],
    },
    {
      heading: "L'écart : un lien de partage signifie quand même qu'un compte détient le fichier",
      body: [
        "Pour envoyer un fichier via Dropbox, il doit d'abord se trouver dans Dropbox — téléversé dans votre compte, posé dans un dossier, avant que vous ne génériez un lien partageable pour lui. Ce lien pointe vers une copie que Dropbox stocke en votre nom, lisible par l'infrastructure propre de Dropbox, et qui y reste jusqu'à ce que vous reveniez supprimer le fichier ou révoquer le lien vous-même.",
        "Le mode temps réel de Relayium ne laisse aucune copie ni aucun historique de contenu côté serveur : WebRTC est direct sur le même LAN ; entre réseaux, TURN transporte par conception du texte chiffré de bout en bout que le relais ne peut ni lire ni déchiffrer. Hors ligne, le lien stocké chiffre avant téléversement avec AES-256-GCM et garde la clé uniquement après le #. Dropbox peut techniquement lire les fichiers du compte ; le serveur de lien Relayium ne détient qu'un texte chiffré indéchiffrable.",
      ],
    },
    {
      heading: "Envoi en temps réel : aucune copie ni historique côté serveur",
      body: [
        "Quand les deux personnes sont en ligne, le transfert temps réel diffuse jusqu'à 1 000 fichiers sur la voie choisie : WebRTC direct sur le même LAN ou TURN par conception entre réseaux. Aucun téléversement de stockage ni historique temps réel côté serveur ; code à 6 chiffres, SHA-256 et reprise restent disponibles.",
        "Il n'y a aucune limite de stockage côté serveur ; le navigateur récepteur fixe la limite pratique. Chrome/Edge diffusent vers le disque, Firefox/Safari peuvent garder en mémoire et avertissent vers 256 Mo. Sur le même LAN, aucun compte et WebRTC direct. Entre réseaux, la personne qui crée le code se connecte ; TURN transporte seulement du texte chiffré de bout en bout qu'il ne peut ni lire ni déchiffrer, et la personne qui rejoint n'a pas besoin de compte.",
      ],
    },
    {
      heading: "Quand un lien s'impose : à divulgation nulle, expiration automatique",
      body: [
        "Parfois un lien est vraiment le bon outil — le destinataire dort dans un autre fuseau horaire, ou vous voulez une seule URL à coller dans un e-mail plutôt que de coordonner une session en direct. Le mode lien stocké de Relayium est conçu exactement pour ce cas, sans renoncer à la confidentialité du mode temps réel.",
        "Vous choisissez combien de temps il vit — 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre — ou le réglez pour qu'il s'autodétruise après le premier téléchargement complet, si bien qu'aucune copie persistante ne traîne à nettoyer. Créer le lien exige que l'expéditeur se connecte (cela compte dans un quota de stockage du compte), mais le destinataire n'a qu'à l'ouvrir et télécharger — aucun compte façon Dropbox requis de son côté. Comme la clé de déchiffrement ne quitte jamais le fragment de l'URL, le serveur de Relayium pour un lien stocké est structurellement incapable de lire ce qu'il contient, une garantie différente de celle d'un lien de partage Dropbox, où l'infrastructure propre de Dropbox peut techniquement déchiffrer le fichier qu'elle héberge.",
      ],
    },
    {
      heading: "Côte à côte",
      body: ["Les différences les plus pertinentes pour un envoi ponctuel :"],
      bullets: [
        "Objectif : Dropbox est un stockage synchronisé durable ; Relayium remet un fichier en temps réel sur la voie LAN/TURN appropriée, ou par lien stocké auto-expirant.",
        "Où finit le fichier : Dropbox conserve une copie dans le compte jusqu'à suppression ; Relayium ne garde aucune copie ni historique temps réel côté serveur, et les liens stockés expirent ou s'autodétruisent après le premier téléchargement.",
        "Qui peut le lire : l'infrastructure de Dropbox peut techniquement déchiffrer les fichiers de votre compte ; les liens stockés de Relayium sont à divulgation nulle — la clé n'existe que dans le fragment de l'URL, donc le serveur détient un texte chiffré qu'il ne peut pas lire.",
        "Comptes : Dropbox en exige un ; Relayium n'en demande aucun sur le même LAN. La personne qui crée le code ou le lien se connecte ; celle qui rejoint ou télécharge n'en a pas besoin.",
        "Limites de taille : Dropbox est borné par le quota de stockage de votre offre ; le temps réel de Relayium n'a aucune limite côté serveur (Chrome/Edge écrivent sur le disque pour plusieurs dizaines de Go ; quand le navigateur doit mettre en mémoire tampon, Relayium prévient au-delà d'environ 256 Mo).",
        "Coût et ouverture : Relayium est gratuit et sous licence AGPL-3.0 sur github.com/relayium/relayium, et tourne dans le navigateur sur Windows, macOS, Linux, Android et iOS sans rien installer.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Le fichier reste-t-il dans un compte comme avec Dropbox ?",
        a: "Aucune copie ni historique temps réel côté serveur. WebRTC est direct sur le même LAN ; entre réseaux, TURN transporte un texte chiffré que le relais ne peut ni lire ni déchiffrer. Le lien stocke uniquement un texte chiffré à divulgation nulle et expire ou s'autodétruit après le premier téléchargement.",
      },
      {
        q: "Mon destinataire doit-il s'inscrire quelque part ?",
        a: "Non. Sur le même LAN, aucun compte. La personne qui crée le code ou le lien se connecte ; celle qui rejoint la session ou télécharge le lien n'en a pas besoin.",
      },
      {
        q: "Y a-t-il une limite de taille de fichier ?",
        a: "Les transferts en temps réel gèrent jusqu'à 1 000 fichiers par lot sans limite de taille côté serveur — Chrome et Edge écrivent directement sur le disque pour plusieurs dizaines de gigaoctets. Quand aucun chemin d'écriture en flux ne s'applique et que le navigateur doit mettre en mémoire tampon, Relayium prévient au-delà d'environ 256 Mo ; ce chiffre est une estimation volontairement prudente, pas une limite dure. Les liens stockés comptent dans un quota lié au compte de l'expéditeur.",
      },
      {
        q: "Est-ce gratuit d'utiliser Relayium à la place d'une offre Dropbox ?",
        a: "Oui. Relayium est gratuit et open source sous licence AGPL-3.0, avec l'intégralité du protocole et du code sur github.com/relayium/relayium — aucune offre payante ne verrouille des transferts plus grands ou plus rapides.",
      },
    ],
  },
  cta: {
    text: "Envoyez le fichier en temps réel sans le déposer dans un compte — sans installation, ni compte sur le même LAN.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل Dropbox لإرسال ملف",
  description:
    "مقارنة منصفة: Dropbox ممتاز للمزامنة الدائمة والروابط المشتركة؛ ويقدم Relayium مسارًا فوريًا بلا نسخة محتوى أو سجل على الخادم، أو رابطًا مُخزّنًا بمعرفة صفرية ينتهي.",
  updatedLabel: "آخر تحديث",
  lead: [
    "يستحقّ Dropbox سمعته. فهو يزامن مجلدًا عبر كل جهاز تملكه، ويحتفظ بسجلّ إصدارات حين تكتب فوق شيء بالخطأ، ويجعل تسليم مجلد مشروع كامل إلى عميل عبر دعوة برابط مشترك أمرًا بلا عناء. فإذا أردت مجلد عمل يبقى متزامنًا وحسب، فإنّ Dropbox يؤدّي هذه المهمّة جيّدًا، وهذه المقالة ليست حجّةً ضدّ استخدامه على هذا النحو.",
    "حتى لتسليم ملف واحد يضعه Dropbox أولًا في حساب. يبثّه Relayium فوريًا عبر WebRTC مباشرةً داخل شبكة LAN نفسها، أو عبر TURN حسب التصميم كنص مشفّر من الطرف إلى الطرف بين الشبكات؛ أو ينشئ رابطًا لا يُفك إلا في المتصفح وينتهي حسب جدولك.",
  ],
  sections: [
    {
      heading: "ما الذي يُتقنه Dropbox حقًّا",
      body: [
        "القوّة الأساسية لـ Dropbox هي أنّ المجلد الذي تعتمد عليه يكون دائمًا محدَّثًا في كل مكان: حرِّر ملفًّا على حاسوبك المحمول فيكون محدَّثًا أصلًا على هاتفك حين تتفقّده. المزامنة الانتقائية، ومزامنة الشبكة المحلية لعمليات النقل المحلية الكبيرة، واسترجاع الملفات وسجلّ الإصدارات، كلها تخدم الهدف نفسه — مكانًا دائمًا يُعتمَد عليه لملفات تعود إليها مرارًا.",
        "والمجلدات المشتركة وDropbox Paper تجعله خيارًا متينًا للتعاون المستمرّ، ومشاركة الروابط فيه مريحة فعلًا للفرق الصغيرة التي تعيش أصلًا في Dropbox يوميًّا. لا شيء من ذلك هو ما يحاول Relayium أن يكونه — فـ Relayium لا يزامن مجلدًا ولا يحتفظ بنسخة عمل لأي شيء.",
      ],
    },
    {
      heading: "الفجوة: رابط المشاركة يعني مع ذلك أنّ حسابًا يحتفظ بالملف",
      body: [
        "لإرسال ملف واحد عبر Dropbox، يجب أولًا أن يكون داخل Dropbox — مرفوعًا إلى حسابك، جالسًا في مجلد، قبل أن تولّد له رابطًا قابلًا للمشاركة. وهذا الرابط يشير إلى نسخة يخزّنها Dropbox نيابةً عنك، قابلة للقراءة من بنية Dropbox التحتية الخاصة، وتبقى هناك إلى أن تعود وتحذف الملف أو تُبطِل الرابط بنفسك.",
        "لا يترك الوضع الفوري في Relayium نسخة محتوى أو سجلًا على الخادم: يتصل WebRTC مباشرةً داخل شبكة LAN نفسها، وعبر الشبكات يحمل TURN حسب التصميم نصًا مشفّرًا من الطرف إلى الطرف لا يستطيع المُرحِّل قراءته أو فك تشفيره. وللطرف غير المتصل يشفر الرابط المُخزّن قبل الرفع بـ AES-256-GCM ويبقي المفتاح بعد # فقط. يستطيع Dropbox تقنيًا قراءة ملفات الحساب؛ ويحفظ خادم رابط Relayium نصًا مشفّرًا لا يستطيع فكّه.",
      ],
    },
    {
      heading: "الإرسال الفوري: بلا نسخة محتوى أو سجل على الخادم",
      body: [
        "حين يكون الطرفان متصلين يبث النقل الفوري حتى 1,000 ملف عبر المسار المختار: WebRTC مباشر داخل شبكة LAN نفسها أو TURN حسب التصميم بين الشبكات. لا رفع للتخزين ولا سجل فوري على الخادم، مع رمز اختياري من 6 أرقام (التحقّق المتقدّم، معطَّل افتراضيًا) وSHA-256 والاستئناف.",
        "لا يوجد حد لتخزين الحجم على الخادم؛ ويحدد المتصفح المستقبِل السقف العملي. يبث Chrome/Edge إلى القرص وقد يخزن Firefox/Safari في الذاكرة مع تحذير قرب 256 ميغابايت. داخل شبكة LAN نفسها لا حساب وWebRTC مباشر. عبر الشبكات يسجل منشئ الرمز الدخول، ويحمل TURN نصًا مشفّرًا من الطرف إلى الطرف لا يستطيع قراءته أو فك تشفيره، ولا يحتاج المنضم إلى حساب.",
      ],
    },
    {
      heading: "حين تحتاج إلى رابط بدلًا من ذلك: معرفة صفرية، وانتهاء ذاتي",
      body: [
        "أحيانًا يكون الرابط حقًّا الأداة الصحيحة — فالمُستقبِل نائم في منطقة زمنية أخرى، أو تريد رابط URL واحدًا تلصقه في بريد إلكتروني بدلًا من تنسيق جلسة مباشرة. ووضع الرابط المُخزَّن في Relayium مبني لهذا تمامًا، دون التخلّي عن خصوصية الوضع الفوري.",
        "تختار كم يعيش — ساعة واحدة، أو يومًا واحدًا، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب خطتك — أو تضبطه ليُحذف بعد أول تنزيل مكتمل، فلا تبقى نسخة عالقة تتذكّر تنظيفها. ويتطلّب إنشاء الرابط أن يسجّل المُرسِل الدخول (فهو يُحتسب ضمن حصّة تخزين على الحساب)، لكنّ المُستقبِل يفتحه ببساطة ويُنزّل — دون حساب على طريقة Dropbox من جهته. ولأنّ مفتاح فكّ التشفير لا يغادر مقطع الـ URL أبدًا، فإنّ خادم Relayium بالنسبة إلى رابط مُخزَّن عاجز بنيويًّا عن قراءة ما بداخله، وهو ضمان مختلف عن رابط مشاركة Dropbox، حيث تستطيع بنية Dropbox التحتية الخاصة أن تفكّ تشفير الملف الذي تستضيفه تقنيًّا.",
      ],
    },
    {
      heading: "جنبًا إلى جنب",
      body: ["الفروق الأكثر صلة بالإرسال لمرّة واحدة:"],
      bullets: [
        "الغرض: Dropbox تخزين متزامن دائم؛ وRelayium لتسليم ملف فوريًا عبر مسار LAN/TURN المناسب أو رابط مُخزّن ينتهي.",
        "أين ينتهي: يحتفظ Dropbox بنسخة الحساب حتى حذفها؛ ولا يحتفظ Relayium بنسخة محتوى أو سجل فوري على الخادم، وتنتهي الروابط أو تُحذف بعد أول تنزيل.",
        "مَن يستطيع قراءته: بنية Dropbox التحتية تستطيع تقنيًّا فكّ تشفير الملفات في حسابك؛ أمّا الروابط المُخزَّنة في Relayium فبمعرفة صفرية — المفتاح موجود فقط في مقطع الـ URL، فيحتفظ الخادم بنص مُشفَّر لا يستطيع قراءته.",
        "الحسابات: يتطلب Dropbox حسابًا؛ ولا يتطلب Relayium واحدًا داخل شبكة LAN نفسها. يسجل منشئ الرمز أو الرابط الدخول، ولا يحتاج المنضم أو منزل الرابط إلى حساب.",
        "حدود الحجم: Dropbox محدود بحصّة تخزين خطّتك؛ أمّا الوضع الفوري في Relayium فلا حدّ له من جهة الخادم (Chrome/Edge يبثّان إلى القرص لعشرات الغيغابايتات؛ وحين يضطر المتصفّح إلى التخزين في الذاكرة يحذّر Relayium فوق نحو 256 ميغابايت).",
        "التكلفة والانفتاح: Relayium مجاني ومرخّص بـ AGPL-3.0 على github.com/relayium/relayium، ويعمل في المتصفّح على Windows وmacOS وLinux وAndroid وiOS دون أي تثبيت.",
      ],
    },
  ],
  faq: {
    heading: "أسئلة شائعة",
    items: [
      {
        q: "هل يبقى الملف في حساب كما يحدث مع Dropbox؟",
        a: "لا توجد نسخة أو سجل فوري على الخادم. WebRTC مباشر داخل شبكة LAN نفسها؛ وعبر الشبكات يحمل TURN نصًا مشفّرًا لا يستطيع المُرحِّل قراءته أو فك تشفيره. يخزن الرابط نصًا مشفّرًا بمعرفة صفرية فقط وينتهي أو يُحذف بعد أول تنزيل.",
      },
      {
        q: "هل يحتاج المُستقبِل إلى التسجيل في أي شيء؟",
        a: "لا. داخل شبكة LAN نفسها لا يحتاج الطرفان إلى حساب. يسجل منشئ الرمز أو الرابط الدخول، ولا يحتاج المنضم إلى الجلسة أو منزل الرابط إلى حساب.",
      },
      {
        q: "هل هناك حدّ لحجم الملف؟",
        a: "تتعامل عمليات النقل الفوري مع ما يصل إلى 1,000 ملف في الدفعة الواحدة دون حدّ حجم من جهة الخادم — يبثّ Chrome وEdge مباشرةً إلى القرص لعشرات الغيغابايتات. وحين لا ينطبق أي مسار للكتابة التدفّقية ويضطر المتصفّح إلى التخزين في الذاكرة، يحذّر Relayium فوق نحو 256 ميغابايت؛ وهذا الرقم تقدير متحفّظ عن قصد، لا حدّ صلب. أمّا الروابط المُخزَّنة فتُحتسب ضمن حصّة مرتبطة بحساب المُرسِل.",
      },
      {
        q: "هل استخدام Relayium بدلًا من خطّة Dropbox مجاني؟",
        a: "نعم. Relayium مجاني ومفتوح المصدر بموجب رخصة AGPL-3.0، مع البروتوكول والشيفرة كاملةً على github.com/relayium/relayium — لا فئة مدفوعة تحجب عمليات نقل أكبر أو أسرع.",
      },
    ],
  },
  cta: {
    text: "أرسِل الملف فوريًا دون وضعه في حساب — بلا تثبيت ولا حساب داخل شبكة LAN نفسها.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابِع القراءة",
};

const es = {
  title: "Relayium vs Dropbox para enviar un archivo",
  description:
    "Una comparación justa: Dropbox destaca en sincronización duradera y enlaces compartidos; Relayium ofrece una vía en tiempo real sin copia ni historial de contenido del lado del servidor, o un enlace almacenado de conocimiento cero que caduca.",
  updatedLabel: "Última actualización",
  lead: [
    "Dropbox se gana su reputación. Sincroniza una carpeta en todas las máquinas que posees, mantiene un historial de versiones cuando sobrescribes algo por accidente, y convierte en un trámite el entregar una carpeta de proyecto entera a un cliente con una invitación por enlace para compartir. Si quieres una carpeta de trabajo que simplemente se mantenga sincronizada, Dropbox hace bien ese trabajo y esto no es un argumento en contra de usarlo así.",
    "Incluso para entregar un archivo, Dropbox lo pone primero en una cuenta. Relayium lo transmite en tiempo real: WebRTC directo en la misma LAN o texto cifrado de extremo a extremo por TURN entre redes por diseño; también puede crear un enlace que solo se descifra en el navegador y desaparece según tu calendario.",
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
        "El modo en tiempo real de Relayium no deja copia ni historial de contenido del lado del servidor: WebRTC es directo en la misma LAN; entre redes, TURN transporta por diseño texto cifrado de extremo a extremo que el retransmisor no puede leer ni descifrar. Si la otra persona está desconectada, el enlace almacenado cifra antes de subir con AES-256-GCM y guarda la clave solo después de #. Dropbox puede leer técnicamente los archivos de la cuenta; el servidor de enlaces de Relayium solo guarda texto cifrado que no puede descifrar.",
      ],
    },
    {
      heading: "Envío en tiempo real: sin copia ni historial del lado del servidor",
      body: [
        "Cuando ambas personas están en línea, la transferencia en tiempo real transmite hasta 1.000 archivos por la vía elegida: WebRTC directo en la misma LAN o TURN por diseño entre redes. No hay subida para almacenar ni historial en tiempo real del lado del servidor; mantiene código de 6 dígitos, SHA-256 y reanudación.",
        "No hay límite de almacenamiento del lado del servidor; el navegador receptor fija el techo práctico. Chrome/Edge escriben al disco y Firefox/Safari pueden guardar en memoria con aviso cerca de 256 MB. En la misma LAN no hace falta cuenta y WebRTC es directo. Entre redes inicia sesión quien crea el código; TURN transporta texto cifrado de extremo a extremo que no puede leer ni descifrar, y quien se une no necesita cuenta.",
      ],
    },
    {
      heading: "Cuando en cambio necesitas un enlace: conocimiento cero, con caducidad automática",
      body: [
        "A veces un enlace es genuinamente la herramienta correcta — el destinatario duerme en otra zona horaria, o quieres una sola URL para pegar en un correo en lugar de coordinar una sesión en vivo. El modo de enlace almacenado de Relayium está hecho exactamente para eso, sin renunciar a la privacidad del modo en tiempo real.",
        "Eliges cuánto vive — 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan — o lo configuras para que se destruya tras la primera descarga completada, así no queda ninguna copia persistente que recordar limpiar. Crear el enlace requiere que el remitente inicie sesión (se descuenta de una cuota de almacenamiento de la cuenta), pero el destinatario simplemente lo abre y descarga — no necesita ninguna cuenta como la de Dropbox. Como la clave de descifrado nunca abandona el fragmento de la URL, el servidor de Relayium para un enlace almacenado es estructuralmente incapaz de leer lo que hay dentro, lo cual es una garantía distinta de un enlace para compartir de Dropbox, donde la propia infraestructura de Dropbox puede técnicamente descifrar el archivo que aloja.",
      ],
    },
    {
      heading: "Cara a cara",
      body: ["Las diferencias más relevantes para un envío puntual:"],
      bullets: [
        "Propósito: Dropbox es almacenamiento sincronizado duradero; Relayium entrega un archivo en tiempo real por la vía LAN/TURN adecuada o mediante un enlace almacenado que caduca.",
        "Dónde acaba: Dropbox conserva una copia en la cuenta hasta borrarla; Relayium no conserva copia ni historial de contenido en tiempo real del lado del servidor, y los enlaces caducan o se destruyen tras la primera descarga.",
        "Quién puede leerlo: la infraestructura de Dropbox puede técnicamente descifrar los archivos de tu cuenta; los enlaces almacenados de Relayium son de conocimiento cero — la clave existe solo en el fragmento de la URL, así que el servidor guarda texto cifrado que no puede leer.",
        "Cuentas: Dropbox exige una; Relayium no en la misma LAN. Inicia sesión quien crea el código o enlace; quien se une o descarga no necesita cuenta.",
        "Límites de tamaño: Dropbox está limitado por la cuota de almacenamiento de tu plan; el tiempo real de Relayium no tiene límite del lado del servidor (Chrome/Edge escriben al disco para decenas de GB; cuando el navegador tiene que almacenar en memoria, Relayium avisa por encima de unos 256 MB).",
        "Coste y apertura: Relayium es gratis y con licencia AGPL-3.0 en github.com/relayium/relayium, y funciona en el navegador en Windows, macOS, Linux, Android e iOS sin nada que instalar.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿El archivo se queda en una cuenta como pasaría con Dropbox?",
        a: "No queda copia ni historial en tiempo real del lado del servidor. WebRTC es directo en la misma LAN; entre redes, TURN transporta texto cifrado que no puede leer ni descifrar. El enlace guarda solo texto cifrado de conocimiento cero y caduca o se destruye tras la primera descarga.",
      },
      {
        q: "¿Mi destinatario necesita registrarse en algo?",
        a: "No. En la misma LAN nadie necesita cuenta. Inicia sesión quien crea el código o enlace; quien se une a la sesión o descarga el enlace no necesita una.",
      },
      {
        q: "¿Hay un límite de tamaño de archivo?",
        a: "Las transferencias en tiempo real manejan hasta 1.000 archivos por lote sin límite de tamaño del lado del servidor — Chrome y Edge escriben directo al disco para decenas de gigabytes. Cuando no se aplica ninguna vía de escritura en flujo y el navegador tiene que almacenar en memoria, Relayium avisa por encima de unos 256 MB; esa cifra es una estimación deliberadamente conservadora, no un límite duro. Los enlaces almacenados se descuentan de una cuota vinculada a la cuenta del remitente.",
      },
      {
        q: "¿Es gratis usar Relayium en lugar de un plan de Dropbox?",
        a: "Sí. Relayium es gratis y de código abierto bajo la licencia AGPL-3.0, con el protocolo y el código completos en github.com/relayium/relayium — no hay ningún nivel de pago que limite transferencias más grandes o más rápidas.",
      },
    ],
  },
  cta: {
    text: "Envía el archivo en tiempo real sin ponerlo en una cuenta — sin instalación ni cuenta en la misma LAN.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Relayium vs Dropbox para enviar um arquivo",
  description:
    "Uma comparação justa: o Dropbox se destaca na sincronização duradoura e em links compartilhados; o Relayium oferece um caminho em tempo real sem cópia nem histórico de conteúdo no servidor, ou um link armazenado de conhecimento zero que expira.",
  updatedLabel: "Última atualização",
  lead: [
    "O Dropbox merece sua reputação. Ele sincroniza uma pasta em todas as máquinas que você possui, mantém um histórico de versões quando você sobrescreve algo por acidente, e torna indolor entregar uma pasta de projeto inteira a um cliente com um convite por link de compartilhamento. Se você quer uma pasta de trabalho que simplesmente permaneça sincronizada, o Dropbox faz bem esse trabalho e isto não é um argumento contra usá-lo assim.",
    "Mesmo para entregar um arquivo, o Dropbox primeiro o coloca em uma conta. O Relayium o transmite em tempo real: WebRTC direto na mesma LAN ou texto cifrado de ponta a ponta por TURN entre redes por design; também pode criar um link que só é descriptografado no navegador e desaparece no prazo escolhido.",
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
        "O modo em tempo real do Relayium não deixa cópia nem histórico de conteúdo no servidor: o WebRTC é direto na mesma LAN; entre redes, o TURN transporta por design texto cifrado de ponta a ponta que o retransmissor não consegue ler nem descriptografar. Se a outra pessoa estiver offline, o link armazenado cifra antes do upload com AES-256-GCM e mantém a chave só depois de #. O Dropbox pode ler tecnicamente arquivos da conta; o servidor de links do Relayium guarda apenas texto cifrado que não consegue descriptografar.",
      ],
    },
    {
      heading: "Envio em tempo real: sem cópia nem histórico no servidor",
      body: [
        "Quando as duas pessoas estão online, a transferência em tempo real transmite até 1.000 arquivos pelo caminho escolhido: WebRTC direto na mesma LAN ou TURN por design entre redes. Não há upload para armazenamento nem histórico em tempo real no servidor; mantém código de 6 dígitos, SHA-256 e retomada.",
        "Não há limite de armazenamento no servidor; o navegador receptor define o teto prático. Chrome/Edge gravam no disco e Firefox/Safari podem manter na memória com aviso perto de 256 MB. Na mesma LAN não é preciso conta e o WebRTC é direto. Entre redes entra quem cria o código; o TURN transporta texto cifrado de ponta a ponta que não consegue ler nem descriptografar, e quem participa não precisa de conta.",
      ],
    },
    {
      heading: "Quando você precisa de um link: conhecimento zero, com expiração automática",
      body: [
        "Às vezes um link é genuinamente a ferramenta certa — o destinatário está dormindo em outro fuso horário, ou você quer uma única URL para colar em um e-mail em vez de coordenar uma sessão ao vivo. O modo de link armazenado do Relayium é feito exatamente para isso, sem abrir mão da privacidade do modo em tempo real.",
        "Você escolhe quanto tempo ele vive — 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano — ou o configura para se autodestruir após o primeiro download concluído, então não sobra nenhuma cópia persistente para você lembrar de limpar. Criar o link exige que o remetente faça login (ele conta contra uma cota de armazenamento da conta), mas o destinatário apenas o abre e baixa — sem conta ao estilo Dropbox exigida do lado dele. Como a chave de descriptografia nunca deixa o fragmento da URL, o servidor do Relayium para um link armazenado é estruturalmente incapaz de ler o que há dentro dele, o que é uma garantia diferente de um link de compartilhamento do Dropbox, onde a própria infraestrutura do Dropbox pode tecnicamente descriptografar o arquivo que ela hospeda.",
      ],
    },
    {
      heading: "Lado a lado",
      body: ["As diferenças mais relevantes para um envio pontual:"],
      bullets: [
        "Propósito: o Dropbox é armazenamento sincronizado duradouro; o Relayium entrega um arquivo em tempo real pelo caminho LAN/TURN adequado ou por um link armazenado que expira.",
        "Onde termina: o Dropbox mantém uma cópia na conta até apagar; o Relayium não mantém cópia nem histórico de conteúdo em tempo real no servidor, e os links expiram ou se autodestroem após o primeiro download.",
        "Quem pode lê-lo: a infraestrutura do Dropbox pode tecnicamente descriptografar arquivos na sua conta; os links armazenados do Relayium são de conhecimento zero — a chave existe apenas no fragmento da URL, então o servidor guarda texto cifrado que não consegue ler.",
        "Contas: o Dropbox exige uma; o Relayium não na mesma LAN. Entra quem cria o código ou link; quem participa ou baixa não precisa de conta.",
        "Limites de tamanho: o Dropbox é limitado pela cota de armazenamento do seu plano; o tempo real do Relayium não tem limite do lado do servidor (Chrome/Edge gravam no disco para dezenas de GB; quando o navegador precisa armazenar na memória, o Relayium avisa acima de cerca de 256 MB).",
        "Custo e abertura: o Relayium é gratuito e licenciado sob AGPL-3.0 em github.com/relayium/relayium, e roda no navegador em Windows, macOS, Linux, Android e iOS sem nada para instalar.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O arquivo fica em uma conta como ficaria com o Dropbox?",
        a: "Não fica cópia nem histórico em tempo real no servidor. O WebRTC é direto na mesma LAN; entre redes, o TURN transporta texto cifrado que não consegue ler nem descriptografar. O link guarda apenas texto cifrado de conhecimento zero e expira ou se autodestrói após o primeiro download.",
      },
      {
        q: "Meu destinatário precisa se cadastrar em algo?",
        a: "Não. Na mesma LAN ninguém precisa de conta. Entra quem cria o código ou link; quem participa da sessão ou baixa o link não precisa de uma.",
      },
      {
        q: "Existe um limite de tamanho de arquivo?",
        a: "As transferências em tempo real lidam com até 1.000 arquivos por lote sem limite de tamanho do lado do servidor — Chrome e Edge gravam direto no disco para dezenas de gigabytes. Quando nenhum caminho de gravação em fluxo se aplica e o navegador precisa armazenar na memória, o Relayium avisa acima de cerca de 256 MB; esse número é uma estimativa deliberadamente conservadora, não um limite rígido. Os links armazenados contam contra uma cota vinculada à conta do remetente.",
      },
      {
        q: "É gratuito usar o Relayium no lugar de um plano do Dropbox?",
        a: "Sim. O Relayium é gratuito e de código aberto sob a licença AGPL-3.0, com o protocolo e o código completos em github.com/relayium/relayium — não há nível pago que restrinja transferências maiores ou mais rápidas.",
      },
    ],
  },
  cta: {
    text: "Envie o arquivo em tempo real sem colocá-lo em uma conta — sem instalação nem conta na mesma LAN.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/dropbox",
  published: "2026-07-09",
  updated: "2026-07-31",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
