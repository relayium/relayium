// web/scripts/pages/content/articles/howto-send-a-folder.mjs
// How-to: send a whole folder (browser folder picker, relative paths, folder-download fallback).
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "How to send a whole folder, not just files",
  description:
    "Pick a whole folder in the browser and send it in one batch — relative paths preserved, up to 1,000 files, each verified with SHA-256. No zipping required beforehand.",
  updatedLabel: "Last updated",
  lead: [
    "Sending a project isn't the same as sending a file — you have a folder full of subfolders, and copy-pasting each piece individually loses the structure that makes it useful. Zipping it first works, but it means a detour through a compression tool before you can even start.",
    "Relayium lets you pick a folder and send it as-is on a realtime transfer. The browser walks the whole tree, keeps every relative path intact, and streams it live — direct over WebRTC on the same LAN, or as end-to-end ciphertext over TURN across networks — without a server-side realtime copy or history. A stored link you leave for later is the one route that does not carry a tree: archive the folder yourself and upload that single file instead.",
  ],
  sections: [
    {
      heading: "Pick a folder, not a pile of files",
      body: [
        "Instead of selecting files one by one, choose the folder itself. Relayium walks the directory tree in the browser and keeps every file's relative path — subfolders, nested subfolders, all of it — so what arrives on the other end has the same layout you started with.",
        "This works today in desktop Chrome, Edge, and Firefox. It doesn't work on iOS: Safari's file picker on iPhone and iPad has no way to select a folder, only individual files, so folder sending is a desktop feature for now.",
      ],
      prereqs: {
        label: "What you need",
        items: [
          "A desktop browser on the sending side — Chrome, Edge or Firefox. Safari's file picker on iPhone and iPad cannot select a folder at all, only individual files, so a folder send starts from a computer.",
          "A tree of at most 1,000 files. That cap is per batch rather than per session, so a larger tree goes over in several sends without reconnecting.",
          "A decision about the receiving browser, because it decides the shape of what arrives: Chrome or Edge writes the tree into a folder the recipient picks, and every other browser produces one .zip instead.",
          "Both sides online together for a realtime send, or — when the other person is not around — a signed-in sender plus an archive you made yourself, because a stored link uploads a flat list of files and carries no directory tree.",
        ],
      },
      steps: [
        {
          text: "Open the transfer page on the sending computer — the same-network page if you are on one network, the realtime page if you need a pairing code.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Drag the folder onto the page, or use the folder picker button. Relayium walks the tree in the browser and keeps each file's relative path, so nothing has to be zipped first.",
        },
        {
          text: "On the same network, find the recipient under “Nearby devices” and press “Open workspace” on their card, then use the “Send a folder” attachment inside the workspace. Across networks it is the same one action: join the pairing-code room and press “Open workspace” on the peer card there. Either way, the request that arrives on the other side states the file count and the total size of the whole tree, not of one file.",
        },
        {
          text: "On the receiving side, read the line under the request before accepting: in Chrome or Edge it says the browser will ask where to save, which is the path that reproduces the folder on disk. Then press “Accept”.",
        },
        {
          text: "Watch the file counter climb through the tree on both screens. It counts files, so a folder of 300 files reaches File 300/300 rather than showing one progress bar for the batch.",
          code: ["File 300/300"],
        },
      ],
      success: {
        label: "What a finished folder send looks like",
        body: [
          "The counter ends on the last file of the batch, and each file arrived with its own SHA-256 hash checked end to end, so what landed matches what you sent byte for byte.",
          "Then look at the result rather than the page, because it differs by browser: in Chrome or Edge the tree is inside the folder you picked, subfolders and all, and in Firefox or Safari there is a single .zip in the downloads list that unpacks to the same structure.",
        ],
        code: ["LAN direct\nFile 300/300"],
      },
    },
    {
      heading: "What the other person gets",
      body: [
        "How the folder arrives depends on the receiving browser. Chrome and Edge can write files straight into a directory the recipient chooses, so the folder shows up on disk exactly as it left — no extra step.",
        "Firefox and Safari don't have that capability, so instead they receive one store-only .zip archive that unpacks to the exact same folder structure. It stays under 4 GiB (no ZIP64 support), which covers the vast majority of project folders and photo or document sets — for anything bigger, split into two sends.",
      ],
      troubleshooting: {
        label: "Symptom, check, fix",
        items: [
          {
            symptom: "There is no way to pick a folder on the sending device at all.",
            code: ["https://relayium.com/   # the picker offers a folder only where the browser supports one"],
            fix: "You are almost certainly on iPhone or iPad, where Safari's picker exposes individual files and nothing else. Start the folder send from a desktop Chrome, Edge or Firefox, and use the phone as the receiving side instead.",
          },
          {
            symptom: "The .zip that arrived is corrupt, or the download stopped near 4 GiB.",
            code: ["chrome://downloads   # compare the .zip size against the folder you sent"],
            fix: "The archive path has no ZIP64, so both a single entry and the whole archive have to stay under 4 GiB. Split the tree into two sends, or have the recipient use Chrome or Edge, which writes the files into a chosen folder and never builds an archive at all.",
          },
          {
            symptom: "The .zip is the same size as the folder, with no compression at all.",
            code: ["chrome://downloads   # the entry's size matches the folder's total, not less"],
            fix: "That is expected: the archive is store-only, so it packages the tree without compressing it and stays byte-identical to what you sent. Compress the folder yourself before sending if size on the wire matters more than an exact copy.",
          },
          {
            symptom: "The files arrived but they are all loose in one folder, with the subfolders gone.",
            code: ["chrome://downloads   # a browser without the directory picker hands over one .zip"],
            fix: "Relative paths survive a realtime send, so this is what a .zip looks like before it is unpacked rather than a flattened transfer. Unpack the archive and the subfolders are there; to land the tree directly on disk, receive it in Chrome or Edge and pick a target folder when asked. A stored download link is the one route that really is flat — it uploads a plain list of files and drops the paths — which is why a folder meant for a link has to be archived first.",
          },
          {
            symptom: "A folder of a few hundred files stops part way with one file missing.",
            code: ["https://relayium.com/   # the counter names the file it stopped on"],
            fix: "A realtime send is one live session, and a temporary drop can pick up again from the last durable checkpoint as long as both pages stay open. Closing or reloading either one ends the session, and then there is nothing left to resume. Keep both tabs open and give it a moment before touching anything; only if the session is really gone, resend the batch from the file the counter named. For delivery with nobody on the other side, zip the folder yourself first and upload that one archive as a stored link, because a stored upload takes a flat file list.",
          },
        ],
      },
    },
    {
      heading: "Realtime, or a link for later",
      body: [
        "If you can both be online at the same time, send the folder in realtime. On the same LAN, WebRTC connects directly; across networks, the browser uses TURN by design to carry end-to-end encrypted ciphertext that the relay cannot read or decrypt. Relayium keeps no server-side realtime copy or transfer history. Same-network transfer needs no account; across networks the pairing-code creator signs in, while the person joining never needs an account.",
        "If the other person isn't around right now, create a stored link instead — but archive the folder yourself first. A stored upload receives a flat list of files: the relative paths are dropped, so a tree uploaded directly arrives as loose files, and two same-named files from different subfolders collide. Make an ordinary .zip and upload that single file, and the structure travels inside the archive. Your browser encrypts whatever you upload with a random AES-256-GCM key that only ever lives in the link itself, so the server holds ciphertext it can't read. Creating a link needs the sender to sign in; set it to expire in 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or make it burn after the first download.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Can I send a folder from an iPhone or iPad?",
        a: "Not as the sender — iOS's Safari has no folder picker, only individual files, so folder sending currently works from desktop Chrome, Edge, or Firefox. An iPhone or iPad can still receive a folder just fine, as a .zip.",
      },
      {
        q: "Are subfolders and file structure preserved?",
        a: "On a realtime send, yes: Relayium keeps every file's relative path, including nested subfolders, so the folder that arrives has the same layout as the one you picked. A stored download link is different — it uploads a flat list of files and drops the paths — so archive the folder yourself and upload the archive when the structure has to survive.",
      },
      {
        q: "How many files can a folder send hold?",
        a: "Up to 1,000 files in a single batch, each individually verified with a SHA-256 hash on arrival.",
      },
      {
        q: "Does the recipient get an actual folder or a .zip?",
        a: "It depends on their browser. Chrome and Edge write the files straight into a directory they choose. Firefox and Safari receive one store-only .zip (under 4 GiB) that unpacks into the same folder structure.",
      },
      {
        q: "Do I need an account to send a folder?",
        a: "Not on the same network. Sending across networks with a pairing code needs the sender to sign in, but the receiver never needs an account either way.",
      },
    ],
  },
  cta: {
    text: "Pick a folder and send it exactly as it is — structure intact, every file verified.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何直接发送整个文件夹，而不只是文件",
  description:
    "在浏览器里直接选中整个文件夹发送——保留相对路径，一批最多 1,000 个文件，每个都用 SHA-256 校验。发送前无需先打包压缩。",
  updatedLabel: "最近更新",
  lead: [
    "发送一个项目和发送一个文件不是一回事——你手上是一个套着子文件夹的文件夹，一个一个复制粘贴会丢掉让它有意义的结构。先打包压缩也行，但那意味着在开始传输之前要先绕道用一个压缩工具。",
    "Relayium 让你在实时传输里选中文件夹整体发送。浏览器会遍历整棵目录树、保留每个相对路径，并实时流式发出——同一局域网内 WebRTC 直连，跨网络经 TURN 承载端到端密文——且不保留服务器端实时副本或历史。留着稍后取用的存储链接是唯一不携带目录结构的那条路：请自己先打包，然后上传那一个压缩文件。",
  ],
  sections: [
    {
      heading: "选文件夹，而不是一堆散文件",
      body: [
        "不必一个个选文件，直接选中文件夹本身即可。Relayium 会在浏览器里遍历整个目录树，保留每个文件的相对路径——子文件夹、嵌套的子文件夹，全都保留——所以对方收到的东西和你出发时的目录结构一致。",
        "目前这在桌面版 Chrome、Edge 和 Firefox 上可用。在 iOS 上不行：iPhone 和 iPad 上 Safari 的文件选择器没有办法选中文件夹，只能选单个文件，所以发送文件夹暂时是桌面端的功能。",
      ],
      prereqs: {
        label: "你需要准备",
        items: [
          "发送这一侧要用桌面浏览器——Chrome、Edge 或 Firefox。iPhone 和 iPad 上 Safari 的文件选择器根本无法选中文件夹，只能选单个文件，所以发送文件夹要从电脑开始。",
          "一棵最多 1,000 个文件的目录树。这个上限是按批而不是按会话算的，所以更大的树可以分几次发送，不用重新连接。",
          "对接收方浏览器有个判断，因为它决定了到达时的形态：Chrome 或 Edge 会把目录树写进接收方挑选的文件夹，其他浏览器则会给出一个 .zip。",
          "实时发送需要双方同时在线；如果对方不在，则需要发送方登录，外加一个你自己打好的压缩包——因为存储链接上传的是一份平铺的文件清单，不携带任何目录结构。",
        ],
      },
      steps: [
        {
          text: "在发送方电脑上打开传输页面——同一网络就用同网络页面，需要配对码就用实时传输页面。",
          code: ["https://relayium.com/"],
        },
        {
          text: "把文件夹拖到页面上，或者用文件夹选择按钮。Relayium 会在浏览器里遍历目录树并保留每个文件的相对路径，所以不需要先打包。",
        },
        {
          text: "同一网络下，在「附近的设备」里找到接收方，在它的卡片上按「打开工作区」，然后用工作区里的「发送文件夹」附件。跨网络是同一个动作：加入配对码房间，在那里的对端卡片上同样按「打开工作区」。无论哪种情形，对方收到的请求上写的都是文件数量和整棵树的总大小，而不是单个文件的大小。",
        },
        {
          text: "在接收方，接受之前先读一下请求下面那行：用 Chrome 或 Edge 时它会说浏览器要问你存到哪，而这条路径才能在磁盘上还原出文件夹。然后按「接收」。",
        },
        {
          text: "看着两块屏幕上的文件计数逐个走过这棵树。它数的是文件，所以一个 300 个文件的文件夹会走到「文件 300/300」，而不是给整批显示一根进度条。",
          code: ["文件 300/300"],
        },
      ],
      success: {
        label: "文件夹发送完成时是什么样",
        body: [
          "计数停在这一批的最后一个文件，而每个文件到达时都用各自的 SHA-256 哈希做过端到端校验，所以落地的内容和你发出的逐字节一致。",
          "接下来要看的是结果，而不是页面，因为它按浏览器而不同：用 Chrome 或 Edge 时，目录树连同子文件夹都在你挑好的文件夹里；用 Firefox 或 Safari 时，下载列表里是一个 .zip，解开后结构一致。",
        ],
        code: ["局域网直连\n文件 300/300"],
      },
    },
    {
      heading: "对方收到的是什么",
      body: [
        "文件夹如何送达取决于接收端的浏览器。Chrome 和 Edge 可以把文件直接写入接收者选定的目录，文件夹会原样出现在磁盘上——不需要额外步骤。",
        "Firefox 和 Safari 没有这个能力，所以它们收到的是一个仅存储（不压缩）的 .zip 压缩包，解压后就是完全相同的文件夹结构。它保持在 4 GiB 以内（不支持 ZIP64），这足以覆盖绝大多数项目文件夹和照片、文档集合——如果更大，就拆成两次发送。",
      ],
      troubleshooting: {
        label: "现象、检查、处理",
        items: [
          {
            symptom: "发送方设备上根本找不到选文件夹的入口。",
            code: ["https://relayium.com/   # 只有浏览器支持时，选择器才会提供文件夹这一项"],
            fix: "你几乎肯定是在 iPhone 或 iPad 上，那里 Safari 的选择器只给出单个文件，别无其他。请从电脑上的 Chrome、Edge 或 Firefox 发起文件夹传输，把手机当作接收方。",
          },
          {
            symptom: "收到的 .zip 损坏，或者下载在接近 4 GiB 时停住。",
            code: ["chrome://downloads   # 把 .zip 的大小和你发出的文件夹对一下"],
            fix: "打包这条路径不支持 ZIP64，所以单个条目和整个压缩包都必须保持在 4 GiB 以内。请把目录树拆成两次发送，或者让接收方改用 Chrome 或 Edge——它会把文件写进选定的文件夹，根本不会生成压缩包。",
          },
          {
            symptom: ".zip 的大小和文件夹一样，完全没有压缩。",
            code: ["chrome://downloads   # 条目的大小等于文件夹总大小，而不是更小"],
            fix: "这是预期行为：这个压缩包仅存储，它只是把目录树打包起来而不做压缩，因此与你发出的内容逐字节一致。如果你更在意传输体积而不是精确副本，请在发送前自己压缩这个文件夹。",
          },
          {
            symptom: "文件都到了，但全都平铺在一个目录里，子文件夹不见了。",
            code: ["chrome://downloads   # 没有目录选择器的浏览器会交给你一个 .zip"],
            fix: "实时发送会保留相对路径，所以这只是压缩包还没解开时的样子，并不是传输把结构拍平了。解开压缩包，子文件夹就在里面；如果希望目录树直接落在磁盘上，请用 Chrome 或 Edge 接收，并在它询问时挑好目标文件夹。真正会拍平的只有存储下载链接那条路——它上传的是一份平铺的文件清单，路径会被丢掉——所以打算走链接的文件夹必须先自己打包。",
          },
          {
            symptom: "几百个文件的文件夹传到一半停下，缺了一个文件。",
            code: ["https://relayium.com/   # 计数会显示它停在哪个文件上"],
            fix: "实时发送是一次实时会话：只要两个页面都还开着，临时掉线可以从最后一个持久化检查点接着传。任何一侧关闭或刷新都会结束这次会话，那就没有什么可续的了。先保持两个标签页开着稍等一会儿再动手；只有在会话确实已经结束时，才从计数停住的那个文件重发这一批。如果对面根本没人，请先自己把文件夹打包成 zip，再把那一个压缩包作为存储链接上传——因为存储上传拿到的是一份平铺的文件清单。",
          },
        ],
      },
    },
    {
      heading: "实时传输，或留个链接稍后取",
      body: [
        "如果双方能同时在线，就实时发送文件夹。同一局域网内 WebRTC 直连；跨网络浏览器按设计使用 TURN 承载端到端加密的密文，中继无法读取或解密。Relayium 不保留服务器端实时副本或传输历史。同一网络无需账号；跨网络时配对码创建者登录，加入的一方始终无需账号。",
        "如果对方现在不在，可以改为创建一个存储链接——但要先自己把文件夹打包。存储上传收到的是一份平铺的文件清单：相对路径会被丢掉，所以直接上传一棵目录树，到手的是一堆散文件，不同子目录下同名的两个文件还会撞名。做一个普通的 .zip 再上传那一个文件，结构就随压缩包一起走了。你的浏览器会在上传前用一把只存在于链接本身的随机 AES-256-GCM 密钥加密你上传的内容，服务器只保存它读不懂的密文。创建链接需要发送方登录；可以设置 1 小时、1 天、3 天、7 天或最长 14 天后过期（上限取决于套餐），也可以设置为首次下载后即焚。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "能从 iPhone 或 iPad 发送文件夹吗？",
        a: "作为发送方不行——iOS 上的 Safari 没有文件夹选择器，只能选单个文件，所以目前发送文件夹要在桌面版 Chrome、Edge 或 Firefox 上进行。但 iPhone 或 iPad 完全可以正常接收文件夹，会以 .zip 形式收到。",
      },
      {
        q: "子文件夹和文件结构会保留吗？",
        a: "实时发送会：Relayium 保留每个文件的相对路径，包括嵌套的子文件夹，所以到达的文件夹和你选中的那个结构完全一致。存储下载链接不一样——它上传的是一份平铺的文件清单，路径会被丢掉——所以需要保住结构时，请自己先打包，再上传那个压缩包。",
      },
      {
        q: "一个文件夹最多能发送多少文件？",
        a: "单批最多 1,000 个文件，每个文件到达时都会各自用 SHA-256 哈希校验。",
      },
      {
        q: "对方收到的是真正的文件夹还是一个 .zip？",
        a: "取决于对方的浏览器。Chrome 和 Edge 会把文件直接写入对方选定的目录。Firefox 和 Safari 会收到一个仅存储的 .zip（不超过 4 GiB），解压后就是相同的文件夹结构。",
      },
      {
        q: "发送文件夹需要账号吗？",
        a: "同一网络下不需要。跨网络用配对码发送需要发送方登录，但无论哪种情况接收方都不需要账号。",
      },
    ],
  },
  cta: {
    text: "选中一个文件夹，原样发出去——结构完整，每个文件都经过校验。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "ファイルではなくフォルダごと送る方法",
  description:
    "ブラウザでフォルダをまるごと選んで一括送信。相対パスを保持したまま、1バッチ最大1,000ファイル、それぞれ SHA-256 で検証。事前の圧縮は不要です。",
  updatedLabel: "最終更新",
  lead: [
    "プロジェクトを送ることは、ファイルを送ることとは違います。手元にあるのはサブフォルダの入ったフォルダで、ひとつずつコピー&ペーストすると、それを役立つものにしている構造が失われてしまいます。先に圧縮しておく手もありますが、転送を始める前に圧縮ツールへ寄り道することになります。",
    "Relayium ならリアルタイム転送でフォルダをそのまま選んで送信できます。ブラウザはツリー全体と相対パスを保ち、同じ LAN では WebRTC で直接、ネットワークをまたぐ場合は TURN でエンドツーエンド暗号文としてライブ転送し、サーバー側のリアルタイムコピーや履歴を残しません。後で受け取れる保存リンクだけは、ツリーを運ばない唯一の経路です。自分でフォルダを書庫にまとめ、その1ファイルをアップロードしてください。",
  ],
  sections: [
    {
      heading: "ファイルの山ではなく、フォルダを選ぶ",
      body: [
        "ファイルを1つずつ選ぶのではなく、フォルダそのものを選びます。Relayium はブラウザ内でディレクトリツリー全体をたどり、各ファイルの相対パス（サブフォルダ、入れ子になったサブフォルダも含む）をすべて保持するので、相手に届くものは元と同じレイアウトになります。",
        "これは現在、デスクトップの Chrome、Edge、Firefox で使えます。iOS では使えません。iPhone や iPad の Safari のファイル選択画面にはフォルダを選ぶ手段がなく、個々のファイルしか選べないため、フォルダ送信は今のところデスクトップの機能です。",
      ],
      prereqs: {
        label: "必要なもの",
        items: [
          "送信側はデスクトップのブラウザ、つまり Chrome、Edge、Firefox のいずれか。iPhone や iPad の Safari のファイル選択画面はフォルダをまったく選べず個々のファイルだけなので、フォルダ送信はパソコンから始めます。",
          "ファイル数が最大 1,000 のツリー。この上限はセッションごとではなくバッチごとなので、より大きなツリーは接続し直さずに数回に分けて送れます。",
          "受信側のブラウザについての判断。届いたものの形はそれで決まります。Chrome か Edge なら受信者が選んだフォルダにツリーを書き込み、それ以外のブラウザでは代わりに 1つの .zip ができます。",
          "リアルタイム送信なら双方が同時にオンラインであること。相手がいない場合は、サインイン済みの送信者に加えて、自分で作った書庫が必要です。保存リンクがアップロードするのは平坦なファイル一覧で、ディレクトリ構造は運ばれないからです。",
        ],
      },
      steps: [
        {
          text: "送信側のパソコンで転送ページを開きます。同じネットワークなら同一ネットワークのページ、ペアリングコードが必要ならリアルタイム転送のページです。",
          code: ["https://relayium.com/"],
        },
        {
          text: "フォルダをページにドラッグするか、フォルダ選択ボタンを使います。Relayium がブラウザ内でツリーをたどり、各ファイルの相対パスを保つので、事前に圧縮する必要はありません。",
        },
        {
          text: "同じネットワークなら、「近くのデバイス」で相手を見つけ、そのカードで「ワークスペースを開く」を押し、ワークスペース内の「フォルダを送信」の添付を使います。ネットワークをまたぐ場合も同じ一つの操作です。ペアリングコードの部屋に参加し、そこでも相手のカードで「ワークスペースを開く」を押します。どちらの場合も、相手に届くリクエストには、1ファイルではなくツリー全体のファイル数と合計サイズが示されます。",
        },
        {
          text: "受信側では、受け入れる前にリクエストの下の行を読んでください。Chrome か Edge ならブラウザが保存先を尋ねると書かれており、その経路こそがディスク上にフォルダを再現します。読んだうえで「受信」を押します。",
        },
        {
          text: "両方の画面で、ファイルカウンターがツリーを1つずつ進むのを見守ります。数えているのはファイルなので、300 ファイルのフォルダはバッチ全体の進捗バー1本ではなく「ファイル 300/300」まで進みます。",
          code: ["ファイル 300/300"],
        },
      ],
      success: {
        label: "フォルダ送信が終わったときの画面",
        body: [
          "カウンターはそのバッチの最後のファイルで止まり、各ファイルは到着時に固有の SHA-256 ハッシュでエンドツーエンドに検証済みなので、着地したものは送ったものとバイト単位で一致します。",
          "その次に見るのはページではなく結果で、ブラウザによって異なります。Chrome か Edge なら選んだフォルダの中にサブフォルダごとツリーがあり、Firefox か Safari ならダウンロード一覧に .zip が1つあって、展開すると同じ構造になります。",
        ],
        code: ["LAN直結\nファイル 300/300"],
      },
    },
    {
      heading: "相手が受け取るもの",
      body: [
        "フォルダの届き方は受信側のブラウザによって変わります。Chrome と Edge は、受信者が選んだディレクトリへファイルを直接書き込めるため、フォルダは送り出したときとまったく同じ形でディスク上に現れます。追加の手順は不要です。",
        "Firefox と Safari にはその機能がないため、代わりに無圧縮（ストア方式）の .zip アーカイブを1つ受け取り、解凍すると同じフォルダ構造になります。サイズは 4 GiB 未満に収まります（ZIP64 非対応）。これはほとんどのプロジェクトフォルダや写真・書類のまとまりをカバーしますが、それより大きい場合は2回に分けて送ってください。",
      ],
      troubleshooting: {
        label: "症状・確認・対処",
        items: [
          {
            symptom: "送信側の端末でフォルダを選ぶ手段がまったく見つからない。",
            code: ["https://relayium.com/   # 選択画面がフォルダを出すのはブラウザが対応している場合だけ"],
            fix: "ほぼ確実に iPhone か iPad で、そこでは Safari の選択画面が個々のファイルしか出しません。フォルダ送信はパソコンの Chrome、Edge、Firefox から始め、スマホは受信側として使ってください。",
          },
          {
            symptom: "届いた .zip が壊れている、またはダウンロードが 4 GiB 近くで止まる。",
            code: ["chrome://downloads   # .zip のサイズを送ったフォルダと見比べる"],
            fix: "アーカイブ経路は ZIP64 に対応していないため、単一エントリもアーカイブ全体も 4 GiB 未満に収める必要があります。ツリーを2回に分けて送るか、受信側に Chrome か Edge を使ってもらってください。そちらは選んだフォルダへファイルを書き込み、アーカイブをまったく作りません。",
          },
          {
            symptom: ".zip のサイズがフォルダと同じで、まったく圧縮されていない。",
            code: ["chrome://downloads   # エントリのサイズがフォルダの合計と一致し、小さくならない"],
            fix: "これは想定どおりです。このアーカイブはストア方式なので、圧縮せずにツリーをまとめるだけで、送ったものとバイト単位で同一のままです。回線上のサイズが正確な複製より重要なら、送る前に自分でフォルダを圧縮してください。",
          },
          {
            symptom: "ファイルは届いたが、すべて1つのフォルダに平たく並び、サブフォルダが消えている。",
            code: ["chrome://downloads   # ディレクトリ選択のないブラウザは .zip を1つ渡す"],
            fix: "リアルタイム送信では相対パスが保たれるので、これは転送が構造をつぶしたのではなく、展開前の .zip の見た目です。アーカイブを展開すればサブフォルダはそこにあります。ツリーを直接ディスクへ置きたい場合は Chrome か Edge で受け取り、尋ねられたときに保存先フォルダを選んでください。本当に平坦になる経路は保存ダウンロードリンクだけで、そこは平坦なファイル一覧をアップロードしてパスを捨てます。リンクで渡すフォルダを先に書庫へまとめるのはそのためです。",
          },
          {
            symptom: "数百ファイルのフォルダが途中で止まり、1つ足りない。",
            code: ["https://relayium.com/   # カウンターが止まったファイルの名前を示す"],
            fix: "リアルタイム送信は1回のライブセッションで、両方のページが開いたままなら一時的な切断は最後の永続チェックポイントから再開できます。どちらかを閉じたり再読み込みしたりするとセッションは終わり、再開できるものは残りません。まずは両方のタブを開いたまま少し待ち、セッションが本当に終わっていたときだけ、カウンターが示したファイルからバッチを送り直してください。相手が同席しない受け渡しなら、先に自分でフォルダを zip にまとめ、その1つの書庫を保存リンクとしてアップロードします。保存アップロードが受け取るのは平坦なファイル一覧だからです。",
          },
        ],
      },
    },
    {
      heading: "今すぐリアルタイムで、または後で取れるリンクを",
      body: [
        "双方が同時にオンラインなら、フォルダをリアルタイムで送れます。同じ LAN では WebRTC が直接接続し、ネットワークをまたぐブラウザは設計上 TURN で、リレーが読み取りも復号もできないエンドツーエンド暗号文を運びます。Relayium はサーバー側のリアルタイムコピーや転送履歴を保持しません。同じネットワークはアカウント不要で、ネットワークをまたぐ場合はペアリングコードの作成者がサインインし、参加者は不要です。",
        "相手が今いない場合は、代わりに保存リンクを作成できます。ただし先に自分でフォルダを書庫へまとめてください。保存アップロードが受け取るのは平坦なファイル一覧で、相対パスは捨てられます。ツリーをそのままアップロードすると、届くのはばらばらのファイルで、別のサブフォルダにある同名の2ファイルは衝突します。ふつうの .zip を作ってその1ファイルをアップロードすれば、構造は書庫の中を一緒に運ばれます。ブラウザはアップロード前に、そのリンク自体にしか存在しないランダムな AES-256-GCM 鍵でアップロードするものを暗号化するため、サーバーは読めない暗号文だけを保持します。リンクの作成には送信側のサインインが必要です。有効期限は1時間・1日・3日・7日・最長14日（プランによる）から選ぶか、初回ダウンロード後に消去する設定にもできます。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "iPhone や iPad からフォルダを送れますか？",
        a: "送信側としては送れません。iOS の Safari にはフォルダ選択の手段がなく、個々のファイルしか選べないため、現在フォルダ送信はデスクトップの Chrome、Edge、Firefox からのみ行えます。iPhone や iPad は受信側としてはフォルダを問題なく受け取れます（.zip として届きます）。",
      },
      {
        q: "サブフォルダやファイル構造は保持されますか？",
        a: "リアルタイム送信なら保持されます。Relayium は入れ子になったサブフォルダを含む各ファイルの相対パスを保持するため、届くフォルダは選んだものと同じレイアウトになります。保存ダウンロードリンクは別で、平坦なファイル一覧をアップロードしてパスを捨てるので、構造を残したいときは自分でフォルダを書庫へまとめ、その書庫をアップロードしてください。",
      },
      {
        q: "フォルダ送信に入れられるファイル数の上限は？",
        a: "1バッチ最大1,000ファイルで、それぞれ到着時に固有の SHA-256 ハッシュで検証されます。",
      },
      {
        q: "相手が受け取るのは実際のフォルダですか、それとも .zip ですか？",
        a: "相手のブラウザによります。Chrome と Edge は相手が選んだディレクトリへファイルを直接書き込みます。Firefox と Safari は無圧縮の .zip（4 GiB 未満）を1つ受け取り、解凍すると同じフォルダ構造になります。",
      },
      {
        q: "フォルダを送るのにアカウントは必要ですか？",
        a: "同じネットワークなら不要です。ネットワークをまたいでペアリングコードで送る場合は送信側のサインインが必要ですが、受信側はどちらの場合もアカウント不要です。",
      },
    ],
  },
  cta: {
    text: "フォルダを選んで、そのままの形で送りましょう。構造そのまま、すべてのファイルを検証済みで。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "파일이 아니라 폴더째로 보내는 방법",
  description:
    "브라우저에서 폴더 전체를 선택해 한 번에 전송하세요. 상대 경로 유지, 배치당 최대 1,000개 파일, 각각 SHA-256으로 검증. 미리 압축할 필요가 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "프로젝트를 보내는 것은 파일 하나를 보내는 것과 다릅니다. 손에 든 건 하위 폴더가 잔뜩 있는 폴더이고, 하나씩 복사-붙여넣기하면 그것을 쓸모 있게 만드는 구조가 사라져 버립니다. 먼저 압축해도 되지만, 그러면 전송을 시작하기 전에 압축 도구를 거쳐야 합니다.",
    "Relayium은 실시간 전송에서 폴더를 그대로 선택해 보낼 수 있게 해줍니다. 브라우저가 전체 트리와 상대 경로를 유지하고, 같은 LAN에서는 WebRTC로 직접, 네트워크를 넘을 때는 TURN으로 종단간 암호문을 실시간 전송하며 서버 측 실시간 복사본이나 기록을 남기지 않습니다. 나중을 위해 남기는 저장 링크만은 트리를 나르지 않는 유일한 경로입니다. 폴더를 직접 압축해 그 한 파일을 올리세요.",
  ],
  sections: [
    {
      heading: "파일 더미가 아니라 폴더를 선택하세요",
      body: [
        "파일을 하나씩 고르는 대신 폴더 자체를 선택하세요. Relayium은 브라우저에서 디렉터리 트리 전체를 훑으며 각 파일의 상대 경로(하위 폴더, 중첩된 하위 폴더까지 전부)를 유지하므로, 상대에게 도착하는 것은 처음 시작할 때와 같은 구조를 갖습니다.",
        "현재 이 기능은 데스크톱 Chrome, Edge, Firefox에서 동작합니다. iOS에서는 동작하지 않습니다. iPhone과 iPad의 Safari 파일 선택기는 폴더를 선택할 방법이 없고 개별 파일만 고를 수 있어서, 폴더 전송은 지금으로선 데스크톱 기능입니다.",
      ],
      prereqs: {
        label: "필요한 것",
        items: [
          "보내는 쪽은 데스크톱 브라우저 — Chrome, Edge 또는 Firefox. iPhone과 iPad의 Safari 선택기는 폴더를 아예 고를 수 없고 개별 파일만 되므로, 폴더 전송은 컴퓨터에서 시작합니다.",
          "파일이 최대 1,000개인 트리. 이 상한은 세션당이 아니라 배치당이므로, 더 큰 트리는 다시 연결하지 않고 여러 번에 걸쳐 보낼 수 있습니다.",
          "받는 브라우저에 대한 판단. 도착하는 형태가 그것으로 결정됩니다. Chrome이나 Edge는 받는 사람이 고른 폴더에 트리를 쓰고, 그 밖의 브라우저는 대신 .zip 하나를 만듭니다.",
          "실시간 전송이라면 양쪽이 동시에 온라인일 것. 상대가 없다면 로그인한 보내는 사람과 함께, 직접 만든 압축 파일이 필요합니다. 저장 링크가 올리는 것은 평평한 파일 목록이라 디렉터리 구조를 나르지 않기 때문입니다.",
        ],
      },
      steps: [
        {
          text: "보내는 컴퓨터에서 전송 페이지를 엽니다 — 같은 네트워크라면 같은 네트워크 페이지, 페어링 코드가 필요하면 실시간 전송 페이지입니다.",
          code: ["https://relayium.com/"],
        },
        {
          text: "폴더를 페이지에 끌어다 놓거나 폴더 선택 버튼을 씁니다. Relayium이 브라우저에서 트리를 훑으며 각 파일의 상대 경로를 유지하므로 미리 압축할 필요가 없습니다.",
        },
        {
          text: "같은 네트워크라면 “주변 기기”에서 받는 사람을 찾아 그 카드에서 “작업 공간 열기”를 누르고, 작업 공간 안의 “폴더 보내기” 첨부를 쓰세요. 네트워크를 넘을 때도 같은 하나의 동작입니다. 페어링 코드 방에 참여해 거기서도 상대 카드에서 “작업 공간 열기”를 누르세요. 어느 쪽이든 상대에게 도착하는 요청에는 한 파일이 아니라 트리 전체의 파일 개수와 총 크기가 적힙니다.",
        },
        {
          text: "받는 쪽에서는 수락하기 전에 요청 아래 줄을 읽으세요. Chrome이나 Edge라면 브라우저가 저장 위치를 묻는다고 적혀 있고, 그 경로가 바로 디스크에 폴더를 되살리는 길입니다. 그다음 “받기”를 누릅니다.",
        },
        {
          text: "두 화면에서 파일 카운터가 트리를 하나씩 지나가는 것을 지켜보세요. 세는 단위가 파일이므로, 300개 파일 폴더는 배치 전체에 진행 막대 하나가 아니라 “파일 300/300”까지 갑니다.",
          code: ["파일 300/300"],
        },
      ],
      success: {
        label: "폴더 전송이 끝났을 때의 화면",
        body: [
          "카운터가 그 배치의 마지막 파일에서 멈추고, 각 파일은 도착할 때 고유한 SHA-256 해시로 종단간 검증되었으므로 내려앉은 것이 보낸 것과 바이트 단위로 일치합니다.",
          "그다음 볼 것은 페이지가 아니라 결과이고, 브라우저마다 다릅니다. Chrome이나 Edge라면 고른 폴더 안에 하위 폴더까지 그대로 트리가 있고, Firefox나 Safari라면 다운로드 목록에 .zip 하나가 있어 풀면 같은 구조가 됩니다.",
        ],
        code: ["LAN 직접\n파일 300/300"],
      },
    },
    {
      heading: "상대방이 받는 것",
      body: [
        "폴더가 어떻게 도착하는지는 받는 쪽의 브라우저에 따라 다릅니다. Chrome과 Edge는 받는 사람이 선택한 디렉터리로 파일을 곧바로 써넣을 수 있어서, 폴더가 떠날 때와 똑같은 모습으로 디스크에 나타납니다. 추가 단계가 없습니다.",
        "Firefox와 Safari에는 그 기능이 없어서, 대신 압축하지 않은(저장 방식) .zip 아카이브 하나를 받으며 이를 풀면 정확히 같은 폴더 구조가 됩니다. 크기는 4 GiB 미만으로 유지됩니다(ZIP64 미지원). 대부분의 프로젝트 폴더나 사진·문서 모음에는 충분하며, 더 크다면 두 번으로 나눠 보내세요.",
      ],
      troubleshooting: {
        label: "증상, 확인, 조치",
        items: [
          {
            symptom: "보내는 기기에서 폴더를 고를 방법이 아예 없습니다.",
            code: ["https://relayium.com/   # 선택기가 폴더를 내놓는 것은 브라우저가 지원할 때뿐이다"],
            fix: "거의 확실히 iPhone이나 iPad이고, 거기서는 Safari 선택기가 개별 파일만 내놓습니다. 폴더 전송은 컴퓨터의 Chrome, Edge, Firefox에서 시작하고 휴대폰은 받는 쪽으로 쓰세요.",
          },
          {
            symptom: "도착한 .zip이 손상되었거나, 다운로드가 4 GiB 근처에서 멈춥니다.",
            code: ["chrome://downloads   # .zip 크기를 보낸 폴더와 견주어 본다"],
            fix: "아카이브 경로는 ZIP64가 없어 개별 항목과 아카이브 전체가 모두 4 GiB 미만이어야 합니다. 트리를 두 번으로 나눠 보내거나, 받는 쪽이 Chrome이나 Edge를 쓰게 하세요. 그쪽은 고른 폴더에 파일을 쓰고 아카이브를 아예 만들지 않습니다.",
          },
          {
            symptom: ".zip 크기가 폴더와 같고 압축이 전혀 되지 않았습니다.",
            code: ["chrome://downloads   # 항목 크기가 폴더 총합과 같고 더 작지 않다"],
            fix: "예상된 결과입니다. 이 아카이브는 저장 방식이라 압축 없이 트리만 묶으므로 보낸 것과 바이트 단위로 같습니다. 정확한 사본보다 회선상의 크기가 더 중요하다면 보내기 전에 직접 폴더를 압축하세요.",
          },
          {
            symptom: "파일은 도착했는데 모두 한 폴더에 평평하게 놓이고 하위 폴더가 사라졌습니다.",
            code: ["chrome://downloads   # 디렉터리 선택기가 없는 브라우저는 .zip 하나를 건넨다"],
            fix: "실시간 전송에서는 상대 경로가 살아남으므로, 이것은 전송이 구조를 평탄화한 것이 아니라 풀기 전의 .zip 모습입니다. 아카이브를 풀면 하위 폴더가 그대로 있고, 트리를 디스크에 바로 놓고 싶다면 Chrome이나 Edge로 받아 물어볼 때 대상 폴더를 고르세요. 정말로 평평한 경로는 저장 다운로드 링크 하나뿐이며, 그쪽은 평평한 파일 목록을 올리고 경로를 버립니다. 링크로 보낼 폴더를 먼저 압축해야 하는 이유가 그것입니다.",
          },
          {
            symptom: "수백 개 파일 폴더가 중간에 멈추고 한 파일이 빠졌습니다.",
            code: ["https://relayium.com/   # 카운터가 멈춘 파일의 이름을 보여준다"],
            fix: "실시간 전송은 한 번의 실시간 세션이고, 두 페이지가 모두 열려 있는 한 일시적인 끊김은 마지막 영구 체크포인트에서 다시 이어갈 수 있습니다. 어느 한쪽을 닫거나 새로 고치면 세션이 끝나고, 그러면 이어갈 것이 남지 않습니다. 두 탭을 열어 둔 채 잠시 기다려 보고, 세션이 정말 끝났을 때만 카운터가 알려준 파일부터 배치를 다시 보내세요. 상대가 아예 없는 전달이라면 폴더를 먼저 직접 zip으로 묶어 그 압축 파일 하나를 저장 링크로 올리세요. 저장 업로드가 받는 것은 평평한 파일 목록이기 때문입니다.",
          },
        ],
      },
    },
    {
      heading: "지금 실시간으로, 또는 나중을 위해 링크로",
      body: [
        "양쪽이 동시에 온라인이면 폴더를 실시간으로 보내세요. 같은 LAN에서는 WebRTC가 직접 연결하고, 네트워크를 넘는 브라우저는 설계상 TURN으로 릴레이가 읽거나 복호화할 수 없는 종단간 암호문을 운반합니다. Relayium은 서버 측 실시간 복사본이나 전송 기록을 보관하지 않습니다. 같은 네트워크는 계정이 필요 없고, 네트워크를 넘을 때는 페어링 코드 생성자가 로그인하며 참가자는 계정이 필요 없습니다.",
        "상대가 지금 없다면 대신 저장 링크를 만들 수 있습니다 — 다만 폴더를 먼저 직접 압축하세요. 저장 업로드가 받는 것은 평평한 파일 목록이고 상대 경로는 버려지므로, 트리를 그대로 올리면 흩어진 파일들로 도착하고 서로 다른 하위 폴더의 같은 이름 파일 둘은 충돌합니다. 평범한 .zip을 만들어 그 한 파일을 올리면 구조가 압축 파일 안에 담겨 함께 갑니다. 브라우저는 업로드 전에 그 링크에만 존재하는 무작위 AES-256-GCM 키로 올리는 것을 암호화하므로, 서버는 읽을 수 없는 암호문만 보관합니다. 링크 생성에는 보내는 쪽의 로그인이 필요합니다. 1시간·1일·3일·7일·최대 14일(요금제에 따라 다름) 중 만료 시점을 정하거나, 첫 다운로드 후 소각되도록 설정할 수도 있습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "iPhone이나 iPad에서 폴더를 보낼 수 있나요?",
        a: "보내는 쪽으로는 안 됩니다. iOS의 Safari에는 폴더 선택 수단이 없고 개별 파일만 고를 수 있어서, 현재 폴더 전송은 데스크톱 Chrome, Edge, Firefox에서만 가능합니다. iPhone이나 iPad는 받는 쪽으로는 폴더를 문제없이 받을 수 있으며, .zip 형태로 도착합니다.",
      },
      {
        q: "하위 폴더와 파일 구조가 유지되나요?",
        a: "실시간 전송이라면 그렇습니다. Relayium은 중첩된 하위 폴더를 포함해 각 파일의 상대 경로를 유지하므로, 도착한 폴더는 선택했던 것과 같은 구조를 갖습니다. 저장 다운로드 링크는 다릅니다 — 평평한 파일 목록을 올리고 경로를 버리므로, 구조가 살아남아야 한다면 폴더를 직접 압축해 그 압축 파일을 올리세요.",
      },
      {
        q: "폴더 전송에 담을 수 있는 파일 수는 얼마나 되나요?",
        a: "한 배치에 최대 1,000개 파일이며, 각각 도착 시 고유한 SHA-256 해시로 검증됩니다.",
      },
      {
        q: "상대방이 실제 폴더를 받나요, 아니면 .zip을 받나요?",
        a: "상대방의 브라우저에 따라 다릅니다. Chrome과 Edge는 상대가 선택한 디렉터리로 파일을 곧바로 써넣습니다. Firefox와 Safari는 압축하지 않은 .zip(4 GiB 미만) 하나를 받으며, 풀면 같은 폴더 구조가 됩니다.",
      },
      {
        q: "폴더를 보내는 데 계정이 필요한가요?",
        a: "같은 네트워크에서는 필요 없습니다. 네트워크를 넘어 페어링 코드로 보낼 때는 보내는 쪽의 로그인이 필요하지만, 받는 쪽은 어느 경우든 계정이 필요 없습니다.",
      },
    ],
  },
  cta: {
    text: "폴더를 선택해서 있는 그대로 보내세요 — 구조는 그대로, 모든 파일은 검증됩니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Einen ganzen Ordner senden, nicht nur Dateien",
  description:
    "Wähle im Browser einen ganzen Ordner aus und sende ihn in einem Rutsch — relative Pfade bleiben erhalten, bis zu 1.000 Dateien pro Stapel, jede per SHA-256 geprüft. Kein Zip vorab nötig.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Ein Projekt zu senden ist nicht dasselbe wie eine Datei zu senden — man hat einen Ordner voller Unterordner, und jedes Stück einzeln zu kopieren zerstört genau die Struktur, die ihn brauchbar macht. Vorher zu zippen funktioniert, bedeutet aber einen Umweg über ein Kompressionswerkzeug, bevor man überhaupt anfangen kann.",
    "Relayium lässt dich einen Ordner auswählen und in einer Echtzeitübertragung unverändert senden. Der Browser erhält Baum und relative Pfade und streamt live — im selben LAN direkt per WebRTC, netzübergreifend als Ende-zu-Ende-Chiffretext über TURN — ohne serverseitige Echtzeitkopie oder Historie. Ein gespeicherter Link für später ist der eine Weg, der keinen Baum trägt: Pack den Ordner selbst in ein Archiv und lade diese eine Datei hoch.",
  ],
  sections: [
    {
      heading: "Einen Ordner wählen, keinen Haufen Dateien",
      body: [
        "Statt Dateien einzeln auszuwählen, wählst du den Ordner selbst. Relayium durchläuft den Verzeichnisbaum im Browser und behält den relativen Pfad jeder Datei bei — Unterordner, verschachtelte Unterordner, alles — sodass das, was auf der anderen Seite ankommt, dasselbe Layout hat wie zu Beginn.",
        "Das funktioniert heute in Desktop-Chrome, -Edge und -Firefox. Unter iOS geht es nicht: Safaris Dateiauswahl auf iPhone und iPad kann keinen Ordner auswählen, nur einzelne Dateien, daher ist Ordnerversand vorerst eine Desktop-Funktion.",
      ],
      prereqs: {
        label: "Was du brauchst",
        items: [
          "Auf der sendenden Seite einen Desktop-Browser — Chrome, Edge oder Firefox. Safaris Dateiauswahl auf iPhone und iPad kann überhaupt keinen Ordner wählen, nur einzelne Dateien, ein Ordnerversand beginnt also am Computer.",
          "Einen Baum mit höchstens 1.000 Dateien. Diese Grenze gilt pro Stapel und nicht pro Sitzung, ein größerer Baum geht also in mehreren Sendungen hinüber, ohne die Verbindung neu aufzubauen.",
          "Eine Entscheidung über den empfangenden Browser, denn er bestimmt die Form des Ergebnisses: Chrome oder Edge schreibt den Baum in einen Ordner, den die empfangende Person wählt, jeder andere Browser erzeugt stattdessen eine .zip.",
          "Beide Seiten gleichzeitig online für eine Echtzeitsendung, oder — wenn die andere Person nicht da ist — eine angemeldete sendende Seite plus ein selbst gepacktes Archiv, denn ein gespeicherter Link lädt eine flache Dateiliste hoch und trägt keinen Verzeichnisbaum.",
        ],
      },
      steps: [
        {
          text: "Öffne auf dem sendenden Computer die Übertragungsseite — die Seite für dasselbe Netz, wenn ihr in einem Netz seid, die Echtzeitseite, wenn ein Pairing-Code nötig ist.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Zieh den Ordner auf die Seite, oder nutze die Ordnerauswahl-Schaltfläche. Relayium durchläuft den Baum im Browser und behält den relativen Pfad jeder Datei, es muss also nichts vorher gezippt werden.",
        },
        {
          text: "Im selben Netz findest du die empfangende Person unter „Geräte in der Nähe“, drückst auf ihrer Karte „Arbeitsbereich öffnen“ und nutzt dann im Arbeitsbereich den Anhang „Ordner senden“. Netzübergreifend ist es dieselbe eine Aktion: Tritt dem Pairing-Code-Raum bei und drücke auch dort auf der Karte der Gegenstelle „Arbeitsbereich öffnen“. So oder so nennt die Anfrage, die dort ankommt, die Dateizahl und die Gesamtgröße des ganzen Baums, nicht die einer Datei.",
        },
        {
          text: "Lies auf der Empfangsseite die Zeile unter der Anfrage, bevor du annimmst: In Chrome oder Edge steht dort, dass der Browser nach dem Speicherort fragt, und genau dieser Weg stellt den Ordner auf der Platte wieder her. Dann drücke „Annehmen“.",
        },
        {
          text: "Sieh auf beiden Bildschirmen zu, wie der Dateizähler durch den Baum klettert. Er zählt Dateien, ein Ordner mit 300 Dateien erreicht also „Datei 300/300“ statt einen einzigen Balken für den Stapel zu zeigen.",
          code: ["Datei 300/300"],
        },
      ],
      success: {
        label: "So sieht ein fertiger Ordnerversand aus",
        body: [
          "Der Zähler endet bei der letzten Datei des Stapels, und jede Datei kam mit ihrem eigenen Ende-zu-Ende geprüften SHA-256-Hash an, das Gelandete entspricht also byteweise dem Gesendeten.",
          "Danach schau auf das Ergebnis statt auf die Seite, denn es unterscheidet sich je nach Browser: In Chrome oder Edge liegt der Baum samt Unterordnern in dem Ordner, den du gewählt hast, und in Firefox oder Safari steht eine einzelne .zip in der Download-Liste, die sich zur selben Struktur entpackt.",
        ],
        code: ["LAN direkt\nDatei 300/300"],
      },
    },
    {
      heading: "Was die andere Person bekommt",
      body: [
        "Wie der Ordner ankommt, hängt vom empfangenden Browser ab. Chrome und Edge können Dateien direkt in ein Verzeichnis schreiben, das die empfangende Person wählt, sodass der Ordner genauso auf der Festplatte erscheint, wie er abgeschickt wurde — kein zusätzlicher Schritt.",
        "Firefox und Safari haben diese Fähigkeit nicht, deshalb erhalten sie stattdessen ein einzelnes, unkomprimiertes (Store-Modus) .zip-Archiv, das beim Entpacken genau dieselbe Ordnerstruktur ergibt. Es bleibt unter 4 GiB (kein ZIP64), was die große Mehrheit von Projektordnern und Foto- oder Dokumentensammlungen abdeckt — bei mehr teilst du es in zwei Sendungen auf.",
      ],
      troubleshooting: {
        label: "Symptom, Prüfung, Lösung",
        items: [
          {
            symptom: "Auf dem sendenden Gerät gibt es überhaupt keine Möglichkeit, einen Ordner zu wählen.",
            code: ["https://relayium.com/   # die Auswahl bietet einen Ordner nur an, wo der Browser das kann"],
            fix: "Du bist mit hoher Wahrscheinlichkeit auf iPhone oder iPad, wo Safaris Auswahl einzelne Dateien zeigt und sonst nichts. Starte den Ordnerversand in einem Desktop-Chrome, -Edge oder -Firefox und nutze das Handy stattdessen als Empfangsseite.",
          },
          {
            symptom: "Die angekommene .zip ist beschädigt, oder der Download bleibt kurz vor 4 GiB stehen.",
            code: ["chrome://downloads   # die Größe der .zip mit dem gesendeten Ordner vergleichen"],
            fix: "Der Archivweg kennt kein ZIP64, sowohl ein einzelner Eintrag als auch das ganze Archiv müssen also unter 4 GiB bleiben. Teile den Baum in zwei Sendungen, oder lass die empfangende Person Chrome oder Edge nehmen: Die schreibt die Dateien in einen gewählten Ordner und baut überhaupt kein Archiv.",
          },
          {
            symptom: "Die .zip ist genauso groß wie der Ordner, ganz ohne Kompression.",
            code: ["chrome://downloads   # die Größe des Eintrags entspricht der Summe des Ordners, nicht weniger"],
            fix: "Das ist so gewollt: Das Archiv läuft im Store-Modus, verpackt den Baum also ohne ihn zu komprimieren und bleibt byteidentisch zum Gesendeten. Komprimiere den Ordner vorher selbst, wenn die Größe auf der Leitung wichtiger ist als eine exakte Kopie.",
          },
          {
            symptom: "Die Dateien sind angekommen, liegen aber alle flach in einem Ordner, die Unterordner fehlen.",
            code: ["chrome://downloads   # ein Browser ohne Verzeichnisauswahl übergibt eine einzelne .zip"],
            fix: "Relative Pfade überleben eine Echtzeitsendung, das hier ist also das Aussehen einer .zip vor dem Entpacken und keine platt gemachte Übertragung. Entpack das Archiv, dann sind die Unterordner da; damit der Baum direkt auf der Platte landet, empfange ihn in Chrome oder Edge und wähle beim Nachfragen einen Zielordner. Der eine Weg, der wirklich flach ist, ist ein gespeicherter Download-Link — er lädt eine einfache Dateiliste hoch und verwirft die Pfade —, weshalb ein Ordner für einen Link vorher in ein Archiv gehört.",
          },
          {
            symptom: "Ein Ordner mit einigen hundert Dateien bleibt mittendrin stehen, eine Datei fehlt.",
            code: ["https://relayium.com/   # der Zähler nennt die Datei, bei der er stehen bleibt"],
            fix: "Eine Echtzeitsendung ist eine Live-Sitzung, und ein kurzer Abbruch kann am letzten dauerhaften Prüfpunkt weitermachen, solange beide Seiten offen bleiben. Wird eine davon geschlossen oder neu geladen, endet die Sitzung, und dann ist nichts mehr fortzusetzen. Lass beide Tabs offen und gib ihr einen Moment, bevor du etwas anfasst; erst wenn die Sitzung wirklich weg ist, sende den Stapel ab der Datei erneut, die der Zähler nannte. Für eine Zustellung ohne Gegenüber packst du den Ordner vorher selbst in ein Zip und lädst dieses eine Archiv als gespeicherten Link hoch, denn ein gespeicherter Upload nimmt eine flache Dateiliste entgegen.",
          },
        ],
      },
    },
    {
      heading: "Jetzt in Echtzeit oder als Link für später",
      body: [
        "Sind beide Seiten gleichzeitig online, sende den Ordner in Echtzeit. Im selben LAN verbindet WebRTC direkt; netzübergreifende Browser nutzen TURN planmäßig für Ende-zu-Ende-Chiffretext, den das Relay weder lesen noch entschlüsseln kann. Relayium bewahrt keine serverseitige Echtzeitkopie oder Übertragungshistorie auf. Im selben Netz ist kein Konto nötig; netzübergreifend meldet sich die Person an, die den Pairing-Code erstellt, die beitretende Person nie.",
        "Ist die andere Person gerade nicht da, erstelle stattdessen einen gespeicherten Link — aber pack den Ordner vorher selbst in ein Archiv. Ein gespeicherter Upload bekommt eine flache Dateiliste: Die relativen Pfade fallen weg, ein direkt hochgeladener Baum kommt also als lose Dateien an, und zwei gleichnamige Dateien aus verschiedenen Unterordnern kollidieren. Mach eine gewöhnliche .zip und lade diese eine Datei hoch, dann reist die Struktur im Archiv mit. Dein Browser verschlüsselt vor dem Upload, was du hochlädst, mit einem zufälligen AES-256-GCM-Schlüssel, der nur im Link selbst existiert, sodass der Server Chiffretext hält, den er nicht lesen kann. Das Erstellen eines Links erfordert die Anmeldung des Absenders; lege eine Gültigkeit von 1 Stunde, 1 Tag, 3 Tagen, 7 Tagen oder bis zu 14 Tagen je nach Tarif fest, oder lass ihn nach dem ersten Download verfallen.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kann ich einen Ordner von einem iPhone oder iPad senden?",
        a: "Als Absender nicht — Safari unter iOS hat keine Ordnerauswahl, nur einzelne Dateien, daher funktioniert Ordnerversand derzeit von Desktop-Chrome, -Edge oder -Firefox aus. Ein iPhone oder iPad kann einen Ordner problemlos empfangen, als .zip.",
      },
      {
        q: "Bleiben Unterordner und Dateistruktur erhalten?",
        a: "Bei einer Echtzeitsendung ja: Relayium behält den relativen Pfad jeder Datei bei, einschließlich verschachtelter Unterordner, sodass der ankommende Ordner dasselbe Layout hat wie der ausgewählte. Ein gespeicherter Download-Link ist anders — er lädt eine flache Dateiliste hoch und verwirft die Pfade —, also pack den Ordner selbst in ein Archiv und lade das Archiv hoch, wenn die Struktur überleben muss.",
      },
      {
        q: "Wie viele Dateien kann ein Ordnerversand enthalten?",
        a: "Bis zu 1.000 Dateien in einem einzigen Stapel, jede beim Eintreffen einzeln mit einem SHA-256-Hash geprüft.",
      },
      {
        q: "Bekommt die Empfängerin einen echten Ordner oder eine .zip-Datei?",
        a: "Das hängt vom Browser ab. Chrome und Edge schreiben die Dateien direkt in ein von ihr gewähltes Verzeichnis. Firefox und Safari erhalten ein einzelnes unkomprimiertes .zip (unter 4 GiB), das beim Entpacken dieselbe Ordnerstruktur ergibt.",
      },
      {
        q: "Brauche ich ein Konto, um einen Ordner zu senden?",
        a: "Im selben Netz nicht. Beim Senden über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden, aber die empfangende Person braucht in keinem Fall ein Konto.",
      },
    ],
  },
  cta: {
    text: "Wähle einen Ordner und sende ihn genau so, wie er ist — Struktur intakt, jede Datei geprüft.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Envoyer un dossier entier, pas seulement des fichiers",
  description:
    "Choisissez un dossier entier dans le navigateur et envoyez-le en un lot — chemins relatifs conservés, jusqu'à 1 000 fichiers, chacun vérifié par SHA-256. Pas besoin de zipper au préalable.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Envoyer un projet, ce n'est pas comme envoyer un fichier : vous avez un dossier plein de sous-dossiers, et copier-coller chaque élément un par un détruit la structure qui le rend utile. Le zipper d'abord fonctionne, mais cela impose un détour par un outil de compression avant même de pouvoir commencer.",
    "Relayium vous laisse choisir un dossier et l'envoyer tel quel dans un transfert en temps réel. Le navigateur conserve toute l'arborescence et diffuse en direct — directement par WebRTC sur le même LAN, ou sous forme de texte chiffré de bout en bout via TURN entre réseaux — sans copie ni historique temps réel côté serveur ; le lien stocké que vous laissez pour plus tard est la seule voie qui ne transporte pas d'arborescence, alors archivez le dossier vous-même et envoyez ce fichier unique.",
  ],
  sections: [
    {
      heading: "Choisir un dossier, pas un tas de fichiers",
      body: [
        "Plutôt que de sélectionner les fichiers un par un, choisissez le dossier lui-même. Relayium parcourt l'arborescence dans le navigateur et conserve le chemin relatif de chaque fichier — sous-dossiers, sous-dossiers imbriqués, tout — de sorte que ce qui arrive de l'autre côté a la même disposition que ce que vous avez envoyé.",
        "Cela fonctionne aujourd'hui sur Chrome, Edge et Firefox de bureau. Ça ne fonctionne pas sous iOS : le sélecteur de fichiers de Safari sur iPhone et iPad ne permet pas de choisir un dossier, seulement des fichiers individuels, donc l'envoi de dossier reste pour l'instant une fonctionnalité de bureau.",
      ],
      prereqs: {
        label: "Ce qu'il vous faut",
        items: [
          "Un navigateur de bureau du côté qui envoie — Chrome, Edge ou Firefox. Le sélecteur de fichiers de Safari sur iPhone et iPad ne permet pas de choisir un dossier du tout, seulement des fichiers isolés, donc un envoi de dossier part d'un ordinateur.",
          "Une décision sur le navigateur qui reçoit, car c'est lui qui détermine la forme de ce qui arrive : Chrome ou Edge écrit l'arborescence dans un dossier choisi par le destinataire, et tout autre navigateur produit une archive .zip à la place.",
          "Les deux côtés en ligne ensemble pour un envoi en temps réel, ou — quand l'autre personne n'est pas là — un expéditeur connecté et une archive que vous avez faite vous-même, car un lien stocké envoie une liste de fichiers à plat et ne transporte aucune arborescence.",
          "Une arborescence limitée par lot et non par session, donc une arborescence plus grande passe en plusieurs envois, sans reconnexion. Jusqu'à 1 000 fichiers dans un seul lot.",
        ],
      },
      steps: [
        {
          text: "Ouvrez la page de transfert sur l'ordinateur qui envoie — celle du même réseau si vous y êtes tous les deux, celle du temps réel s'il faut un code d'appairage.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Glissez le dossier sur la page, ou utilisez le bouton de sélection de dossier. Relayium parcourt l'arborescence dans le navigateur et conserve le chemin relatif de chaque fichier, il n'y a donc rien à zipper au préalable.",
        },
        {
          text: "Sur le même réseau, trouvez le destinataire sous « Appareils à proximité », appuyez sur « Ouvrir l’espace de travail » sur sa carte, puis utilisez la pièce jointe « Envoyer un dossier » dans cet espace de travail. Entre réseaux, c'est la même action unique : rejoignez la salle par code d'appairage et appuyez là aussi sur « Ouvrir l’espace de travail » sur la carte du pair. Dans les deux cas, la demande qui arrive de l'autre côté indique le nombre de fichiers et la taille totale de toute l'arborescence, pas celle d'un seul fichier.",
        },
        {
          text: "Du côté qui reçoit, lisez la ligne sous la demande avant d'accepter : dans Chrome ou Edge, elle annonce que le navigateur demandera où enregistrer, et c'est cette voie qui reconstitue le dossier sur le disque. Appuyez ensuite sur « Accepter ».",
        },
        {
          text: "Regardez le compteur de fichiers grimper à travers l'arborescence sur les deux écrans. Il compte des fichiers, donc un dossier de 300 fichiers atteint « Fichier 300/300 » au lieu d'afficher une seule barre pour le lot.",
          code: ["Fichier 300/300"],
        },
      ],
      success: {
        label: "À quoi ressemble un envoi de dossier terminé",
        body: [
          "Le compteur s'arrête sur le dernier fichier du lot, et chaque fichier est arrivé avec sa propre empreinte SHA-256 vérifiée de bout en bout, donc ce qui a atterri correspond octet pour octet à ce que vous avez envoyé.",
          "Regardez ensuite le résultat plutôt que la page, car il diffère selon le navigateur : dans Chrome ou Edge, l'arborescence est dans le dossier que vous avez choisi, sous-dossiers compris, et dans Firefox ou Safari, une seule archive .zip figure dans la liste des téléchargements et se décompresse dans la même structure.",
        ],
        code: ["LAN direct\nFichier 300/300"],
      },
    },
    {
      heading: "Ce que l'autre personne reçoit",
      body: [
        "La façon dont le dossier arrive dépend du navigateur de réception. Chrome et Edge peuvent écrire les fichiers directement dans un répertoire choisi par le destinataire, si bien que le dossier apparaît sur le disque exactement tel qu'il est parti — sans étape supplémentaire.",
        "Firefox et Safari n'ont pas cette capacité ; ils reçoivent à la place une seule archive .zip non compressée (mode stockage) qui, une fois décompressée, redonne exactement la même structure de dossier. Elle reste sous 4 Gio (pas de ZIP64), ce qui couvre la grande majorité des dossiers de projet et des ensembles de photos ou documents — au-delà, répartissez l'envoi en deux.",
      ],
      troubleshooting: {
        label: "Symptôme, vérification, correction",
        items: [
          {
            symptom: "Il n'y a aucun moyen de choisir un dossier sur l'appareil qui envoie.",
            code: ["https://relayium.com/   # le sélecteur ne propose un dossier que là où le navigateur le permet"],
            fix: "Vous êtes presque certainement sur iPhone ou iPad, où le sélecteur de Safari n'expose que des fichiers isolés. Lancez l'envoi de dossier depuis un Chrome, Edge ou Firefox de bureau, et servez-vous du téléphone comme côté récepteur.",
          },
          {
            symptom: "L'archive .zip arrivée est corrompue, ou le téléchargement s'arrête près de 4 Gio.",
            code: ["chrome://downloads   # comparez la taille de l'archive au dossier envoyé"],
            fix: "La voie de l'archive ignore ZIP64, donc une entrée seule comme l'archive entière doivent rester sous 4 Gio. Répartissez l'arborescence en deux envois, ou faites recevoir la personne dans Chrome ou Edge, qui écrit les fichiers dans un dossier choisi et ne construit aucune archive.",
          },
          {
            symptom: "L'archive .zip fait la même taille que le dossier, sans aucune compression.",
            code: ["chrome://downloads   # la taille de l'entrée égale le total du dossier, pas moins"],
            fix: "C'est le comportement attendu : l'archive est en mode stockage, elle emballe l'arborescence sans la compresser et reste octet pour octet identique à ce que vous avez envoyé. Compressez le dossier vous-même avant l'envoi si la taille sur le réseau compte plus qu'une copie exacte.",
          },
          {
            symptom: "Les fichiers sont arrivés mais tous à plat dans un dossier, les sous-dossiers ont disparu.",
            code: ["chrome://downloads   # un navigateur sans sélecteur de répertoire remet une seule archive .zip"],
            fix: "Les chemins relatifs survivent à un envoi en temps réel, c'est donc l'allure d'une archive .zip avant décompression et non un transfert aplati. Décompressez l'archive et les sous-dossiers sont là. Pour faire atterrir l'arborescence directement sur le disque, recevez-la dans Chrome ou Edge et choisissez un dossier de destination à la demande. La seule voie réellement à plat est le lien de téléchargement stocké, qui envoie une simple liste de fichiers et jette les chemins, et c'est pourquoi un dossier destiné à un lien doit être archivé d'abord.",
          },
          {
            symptom: "Un dossier de quelques centaines de fichiers s'arrête en route, un fichier manque.",
            code: ["https://relayium.com/   # le compteur nomme le fichier sur lequel il s'est arrêté"],
            fix: "Un envoi en temps réel est une session en direct, et une coupure passagère peut repartir du dernier point de reprise durable tant que les deux pages restent ouvertes. Fermer ou recharger l'une des deux met fin à la session, et il ne reste alors plus rien à reprendre. Laissez les deux onglets ouverts et accordez-lui un instant avant de toucher à quoi que ce soit ; ce n'est qu'une fois la session vraiment perdue qu'il faut renvoyer le lot à partir du fichier nommé par le compteur. Pour une livraison sans personne en face, zippez le dossier vous-même puis envoyez cette archive unique comme lien stocké, car un envoi stocké reçoit une liste de fichiers à plat.",
          },
        ],
      },
    },
    {
      heading: "En temps réel maintenant, ou un lien pour plus tard",
      body: [
        "Si vous êtes en ligne en même temps, envoyez le dossier en temps réel. Sur le même LAN, WebRTC se connecte directement ; entre réseaux, les navigateurs utilisent TURN par conception pour transporter un texte chiffré de bout en bout que le relais ne peut ni lire ni déchiffrer. Relayium ne conserve aucune copie côté serveur ni aucun historique temps réel. Aucun compte n'est requis sur le même réseau ; entre réseaux, la personne qui crée le code se connecte, celle qui rejoint n'en a jamais besoin.",
        "Si l'autre personne n'est pas disponible maintenant, créez plutôt un lien stocké — mais archivez le dossier vous-même d'abord. Un envoi stocké reçoit une liste de fichiers à plat, les chemins relatifs sont jetés, si bien qu'une arborescence envoyée telle quelle arrive en fichiers épars, et deux fichiers de même nom venus de sous-dossiers différents entrent en collision. Faites une archive .zip ordinaire et envoyez ce fichier unique, et la structure voyage à l'intérieur de l'archive. Votre navigateur chiffre ce que vous envoyez avec une clé AES-256-GCM aléatoire qui ne vit que dans le lien lui-même, de sorte que le serveur conserve un texte chiffré qu'il ne peut pas lire. Créer un lien exige que l'expéditeur se connecte ; réglez son expiration à 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre, ou faites-le s'autodétruire après le premier téléchargement.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Puis-je envoyer un dossier depuis un iPhone ou un iPad ?",
        a: "Pas en tant qu'expéditeur — Safari sous iOS n'a pas de sélecteur de dossier, seulement des fichiers individuels, donc l'envoi de dossier fonctionne aujourd'hui depuis Chrome, Edge ou Firefox de bureau. Un iPhone ou un iPad peut tout à fait recevoir un dossier, sous forme de .zip.",
      },
      {
        q: "Les sous-dossiers et la structure des fichiers sont-ils conservés ?",
        a: "Sur un envoi en temps réel, oui : Relayium conserve le chemin relatif de chaque fichier, y compris les sous-dossiers imbriqués, de sorte que le dossier reçu a la même disposition que celui que vous avez choisi. Un lien de téléchargement stocké est différent, car il envoie une liste de fichiers à plat et jette les chemins, alors archivez le dossier vous-même et envoyez l'archive quand la structure doit survivre.",
      },
      {
        q: "Combien de fichiers un envoi de dossier peut-il contenir ?",
        a: "Jusqu'à 1 000 fichiers dans un seul lot, chacun vérifié individuellement par une empreinte SHA-256 à son arrivée.",
      },
      {
        q: "Le destinataire reçoit-il un vrai dossier ou un .zip ?",
        a: "Cela dépend de son navigateur. Chrome et Edge écrivent les fichiers directement dans un répertoire qu'il choisit. Firefox et Safari reçoivent une seule archive .zip non compressée (moins de 4 Gio) qui, une fois décompressée, redonne la même structure de dossier.",
      },
      {
        q: "Ai-je besoin d'un compte pour envoyer un dossier ?",
        a: "Pas sur le même réseau. Envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte, mais le destinataire n'a jamais besoin de compte, dans un cas comme dans l'autre.",
      },
    ],
  },
  cta: {
    text: "Choisissez un dossier et envoyez-le tel quel — structure intacte, chaque fichier vérifié.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "كيفية إرسال مجلد كامل، لا ملفات فقط",
  description:
    "اختر مجلدًا كاملًا في المتصفح وأرسِله دفعةً واحدة — مع الحفاظ على المسارات النسبية، حتى 1,000 ملف، كل منها مُتحقَّق منه بـ SHA-256. لا حاجة إلى الضغط مسبقًا.",
  updatedLabel: "آخر تحديث",
  lead: [
    "إرسال مشروع ليس كإرسال ملف — فلديك مجلد مليء بالمجلدات الفرعية، ونسخ كل قطعة ولصقها على حدة يفقدك البنية التي تجعله مفيدًا. الضغط أولًا يفي بالغرض، لكنه يعني مرورًا جانبيًا بأداة ضغط قبل أن تتمكن حتى من البدء.",
    "يتيح لك Relayium اختيار مجلد وإرساله كما هو في نقل فوري. يحافظ المتصفح على الشجرة والمسارات النسبية، ويبثه حيًا — مباشرةً عبر WebRTC داخل شبكة LAN نفسها، أو كنص مشفّر من الطرف إلى الطرف عبر TURN بين الشبكات — بلا نسخة فورية أو سجل على الخادم. أما الرابط المُخزَّن الذي تتركه لوقت لاحق فهو المسار الوحيد الذي لا يحمل شجرة: احزم المجلد بنفسك وارفع ذلك الملف الواحد.",
  ],
  sections: [
    {
      heading: "اختر مجلدًا، لا كومة ملفات",
      body: [
        "بدلًا من اختيار الملفات واحدًا تلو الآخر، اختر المجلد نفسه. يجتاز Relayium شجرة الدليل في المتصفح ويُبقي المسار النسبي لكل ملف — المجلدات الفرعية، والمجلدات الفرعية المتداخلة، كلها — بحيث يكون لما يصل إلى الجانب الآخر نفس التخطيط الذي بدأت به.",
        "يعمل هذا اليوم في Chrome وEdge وFirefox على سطح المكتب. ولا يعمل على iOS: فمُنتقي الملفات في Safari على iPhone وiPad لا يملك طريقة لاختيار مجلد، بل ملفات فردية فقط، فإرسال المجلدات ميزة سطح مكتب في الوقت الحالي.",
      ],
      prereqs: {
        label: "ما تحتاج إليه",
        items: [
          "متصفح على حاسوب مكتبي في جهة الإرسال — Chrome أو Edge أو Firefox. فمنتقي الملفات في Safari على iPhone وiPad لا يستطيع اختيار مجلد إطلاقًا، بل ملفات مفردة فقط، لذا يبدأ إرسال المجلد من حاسوب.",
          "شجرة لا تزيد على 1,000 ملف. وهذا الحد يخص الدفعة لا الجلسة، فالشجرة الأكبر تنتقل على عدة إرساليات دون إعادة الاتصال.",
          "قرار بشأن المتصفح المستقبِل، فهو الذي يحدّد شكل ما يصل: يكتب Chrome أو Edge الشجرة في مجلد يختاره المُستقبِل، أما أي متصفح آخر فيُنتج ملف ‎.zip‎ واحدًا بدلًا من ذلك.",
          "أن يكون الطرفان متصلين معًا للإرسال الفوري، أو — إن لم يكن الطرف الآخر حاضرًا — أن يكون المُرسِل مسجَّل الدخول ومعه أرشيف حزمته بنفسك، لأن الرابط المُخزَّن يرفع قائمة ملفات مسطّحة ولا يحمل أي شجرة أدلة.",
        ],
      },
      steps: [
        {
          text: "افتح صفحة النقل على حاسوب الإرسال — صفحة نفس الشبكة إن كنتما على شبكة واحدة، وصفحة النقل الفوري إن احتجت إلى رمز اقتران.",
          code: ["https://relayium.com/"],
        },
        {
          text: "اسحب المجلد إلى الصفحة، أو استخدم زر منتقي المجلدات. يتجول Relayium في الشجرة داخل المتصفح ويحافظ على المسار النسبي لكل ملف، فلا حاجة إلى ضغط أي شيء أولًا.",
        },
        {
          text: "على الشبكة نفسها، جِد المُستقبِل تحت «الأجهزة القريبة»، واضغط «فتح مساحة العمل» على بطاقته، ثم استخدم مرفق «إرسال مجلد» داخل مساحة العمل. وعبر الشبكات هو الإجراء نفسه: انضمّ إلى غرفة رمز الاقتران واضغط «فتح مساحة العمل» على بطاقة الطرف الآخر هناك أيضًا. وفي الحالتين، الطلب الذي يصل إلى الطرف الآخر يذكر عدد الملفات والحجم الإجمالي للشجرة كلها، لا حجم ملف واحد.",
        },
        {
          text: "على الطرف المستقبِل، اقرأ السطر أسفل الطلب قبل القبول: في Chrome أو Edge يقول إن المتصفح سيسأل عن مكان الحفظ، وهذا هو المسار الذي يعيد تكوين المجلد على القرص. ثم اضغط «قبول».",
        },
        {
          text: "راقب عدّاد الملفات وهو يتقدّم في الشجرة على الشاشتين. إنه يعدّ الملفات، فمجلد فيه 300 ملف يبلغ «الملف 300/300» بدل أن يعرض شريط تقدّم واحدًا للدفعة كلها.",
          code: ["الملف 300/300"],
        },
      ],
      success: {
        label: "كيف يبدو إرسال مجلد مكتمل",
        body: [
          "يتوقف العدّاد عند آخر ملف في الدفعة، ووصل كل ملف وقد جرى التحقّق منه من الطرف إلى الطرف بتجزئة SHA-256 خاصة به، فما حلّ يطابق ما أرسلته بايتًا ببايت.",
          "ثم انظر إلى النتيجة لا إلى الصفحة، فهي تختلف بحسب المتصفح: في Chrome أو Edge تكون الشجرة داخل المجلد الذي اخترته بمجلداتها الفرعية كلها، وفي Firefox أو Safari يوجد ملف ‎.zip‎ واحد في قائمة التنزيلات يُفكّ إلى البنية نفسها.",
        ],
        code: ["مباشر عبر LAN\nالملف 300/300"],
      },
    },
    {
      heading: "ماذا يستلم الشخص الآخر",
      body: [
        "تعتمد كيفية وصول المجلد على المتصفح المستقبِل. يستطيع Chrome وEdge كتابة الملفات مباشرةً في دليل يختاره المُستقبِل، فيظهر المجلد على القرص تمامًا كما غادر — دون خطوة إضافية.",
        "لا يملك Firefox وSafari هذه القدرة، فيستلمان بدلًا من ذلك أرشيف .zip واحدًا بوضع التخزين فقط (دون ضغط) يُفكّ إلى نفس بنية المجلد بالضبط. ويبقى دون 4 GiB (لا دعم لـ ZIP64)، وهو ما يغطّي الغالبية العظمى من مجلدات المشاريع ومجموعات الصور أو المستندات — ولأي شيء أكبر، قسّمه إلى إرسالين.",
      ],
      troubleshooting: {
        label: "العَرَض والفحص والحل",
        items: [
          {
            symptom: "لا توجد أي طريقة لاختيار مجلد على جهاز الإرسال.",
            code: ["https://relayium.com/   # لا يعرض المنتقي مجلدًا إلا حيث يدعم المتصفح ذلك"],
            fix: "أنت على iPhone أو iPad على الأرجح، وهناك لا يعرض منتقي Safari سوى ملفات مفردة. ابدأ إرسال المجلد من Chrome أو Edge أو Firefox على حاسوب، واستخدم الهاتف طرفًا مستقبِلًا بدلًا من ذلك.",
          },
          {
            symptom: "الأرشيف ‎.zip‎ الذي وصل تالف، أو توقّف التنزيل قرب 4 GiB.",
            code: ["chrome://downloads   # قارن حجم الأرشيف بالمجلد الذي أرسلته"],
            fix: "مسار الأرشيف لا يدعم ZIP64، فيجب أن يبقى كل من المُدخَل الواحد والأرشيف كله دون 4 GiB. قسّم الشجرة إلى إرسالين، أو اطلب من المُستقبِل استخدام Chrome أو Edge، فذاك يكتب الملفات في مجلد مختار ولا يبني أرشيفًا إطلاقًا.",
          },
          {
            symptom: "حجم الأرشيف ‎.zip‎ مساوٍ للمجلد، بلا أي ضغط.",
            code: ["chrome://downloads   # حجم المُدخَل يساوي إجمالي المجلد لا أقل"],
            fix: "هذا هو المتوقَّع: الأرشيف بوضع التخزين فقط، فهو يحزم الشجرة دون ضغطها ويبقى مطابقًا بايتًا ببايت لما أرسلته. اضغط المجلد بنفسك قبل الإرسال إن كان الحجم على الشبكة أهمّ لديك من نسخة مطابقة تمامًا.",
          },
          {
            symptom: "وصلت الملفات لكنها كلها مسطّحة في مجلد واحد، والمجلدات الفرعية غائبة.",
            code: ["chrome://downloads   # المتصفح الذي لا منتقي مجلدات لديه يسلّم ملف ‎.zip‎ واحدًا"],
            fix: "المسارات النسبية تصمد في الإرسال الفوري، فهذا هو شكل ملف ‎.zip‎ قبل فكّه لا نقلًا سطّح البنية. فُكّ الأرشيف فتجد المجلدات الفرعية داخله؛ ولإحلال الشجرة على القرص مباشرةً، استقبلها في Chrome أو Edge واختر مجلد الوجهة عند السؤال. والمسار الوحيد المسطّح فعلًا هو رابط التنزيل المُخزَّن: فهو يرفع قائمة ملفات مسطّحة ويُسقط المسارات، ولهذا يجب حزم المجلد المخصَّص لرابط قبل رفعه.",
          },
          {
            symptom: "مجلد فيه بضع مئات من الملفات يتوقّف في منتصفه وينقص ملف واحد.",
            code: ["https://relayium.com/   # يذكر العدّاد الملف الذي توقّف عنده"],
            fix: "الإرسال الفوري جلسة حيّة، والانقطاع المؤقت يستطيع أن يستأنف من آخر نقطة تفتيش دائمة ما دامت الصفحتان مفتوحتين. أما إغلاق إحداهما أو إعادة تحميلها فينهي الجلسة، ولا يبقى عندها ما يُستأنف. أبقِ التبويبين مفتوحين وامهله لحظة قبل أن تلمس شيئًا؛ وإذا انتهت الجلسة فعلًا، أعِد إرسال الدفعة بدءًا من الملف الذي ذكره العدّاد. وللتسليم بلا أحد على الطرف الآخر، احزم المجلد بنفسك في ملف zip وارفع ذلك الأرشيف الواحد كرابط مُخزَّن، لأن الرفع المُخزَّن يستقبل قائمة ملفات مسطّحة.",
          },
        ],
      },
    },
    {
      heading: "فوريًا، أو رابط لوقت لاحق",
      body: [
        "إن كنتما متصلين في الوقت نفسه، فأرسل المجلد فوريًا. داخل شبكة LAN نفسها يتصل WebRTC مباشرةً؛ وعبر الشبكات تستخدم المتصفحات TURN حسب التصميم لنقل نص مشفّر من الطرف إلى الطرف لا يستطيع المُرحِّل قراءته أو فك تشفيره. لا يحتفظ Relayium بنسخة فورية أو سجل نقل على الخادم. لا يلزم حساب داخل الشبكة نفسها؛ وعبر الشبكات يسجل منشئ رمز الاقتران الدخول ولا يحتاج المنضم إلى حساب.",
        "إن لم يكن الشخص الآخر متاحًا الآن، فأنشئ رابطًا مُخزَّنًا بدلًا من ذلك — لكن احزم المجلد بنفسك أولًا. فالرفع المُخزَّن يستقبل قائمة ملفات مسطّحة: تُسقَط المسارات النسبية، فتصل الشجرة المرفوعة مباشرةً ملفاتٍ متناثرة، ويتصادم ملفان بالاسم نفسه من مجلدين فرعيين مختلفين. أنشئ ملف ‎.zip‎ عاديًا وارفع ذلك الملف الواحد، فتسافر البنية داخل الأرشيف. ويشفّر متصفحك ما ترفعه قبل الرفع بمفتاح AES-256-GCM عشوائي لا يعيش إلا في الرابط نفسه، فيحمل الخادم نصًا مُشفَّرًا لا يستطيع قراءته. يتطلب إنشاء رابط أن يسجّل المُرسِل الدخول؛ اضبطه لينتهي بعد ساعة واحدة، أو يوم واحد، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب خطتك، أو اجعله يحترق بعد أول تنزيل.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل يمكنني إرسال مجلد من iPhone أو iPad؟",
        a: "ليس كمُرسِل — فـ Safari على iOS لا يملك منتقي مجلدات، بل ملفات فردية فقط، فإرسال المجلدات يعمل حاليًا من Chrome أو Edge أو Firefox على سطح المكتب. لكن iPhone أو iPad يستطيع مع ذلك استقبال مجلد بلا مشكلة، على هيئة .zip.",
      },
      {
        q: "هل تُحفَظ المجلدات الفرعية وبنية الملفات؟",
        a: "في الإرسال الفوري نعم: يُبقي Relayium المسار النسبي لكل ملف، بما في ذلك المجلدات الفرعية المتداخلة، فيكون للمجلد الواصل نفس تخطيط الذي اخترته. أما رابط التنزيل المُخزَّن فمختلف — إذ يرفع قائمة ملفات مسطّحة ويُسقط المسارات — فاحزم المجلد بنفسك وارفع الأرشيف عندما يلزم بقاء البنية.",
      },
      {
        q: "كم عدد الملفات التي يمكن أن يحملها إرسال مجلد؟",
        a: "حتى 1,000 ملف في دفعة واحدة، كل منها مُتحقَّق منه على حدة بتجزئة SHA-256 عند الوصول.",
      },
      {
        q: "هل يستلم المُستقبِل مجلدًا فعليًا أم ملف .zip؟",
        a: "يعتمد ذلك على متصفحه. يكتب Chrome وEdge الملفات مباشرةً في دليل يختاره. أما Firefox وSafari فيستلمان ملف .zip واحدًا بوضع التخزين فقط (دون 4 GiB) يُفكّ إلى نفس بنية المجلد.",
      },
      {
        q: "هل أحتاج إلى حساب لإرسال مجلد؟",
        a: "ليس على نفس الشبكة. الإرسال عبر الشبكات برمز اقتران يتطلب أن يسجّل المُرسِل الدخول، لكن المُستقبِل لا يحتاج أبدًا إلى حساب في كلتا الحالتين.",
      },
    ],
  },
  cta: {
    text: "اختر مجلدًا وأرسِله تمامًا كما هو — البنية سليمة، وكل ملف مُتحقَّق منه.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Cómo enviar una carpeta entera, no solo archivos",
  description:
    "Elige una carpeta entera en el navegador y envíala en un solo lote — se conservan las rutas relativas, hasta 1.000 archivos, cada uno verificado con SHA-256. Sin necesidad de comprimir antes.",
  updatedLabel: "Última actualización",
  lead: [
    "Enviar un proyecto no es lo mismo que enviar un archivo — tienes una carpeta llena de subcarpetas, y copiar y pegar cada pieza por separado pierde la estructura que la hace útil. Comprimirla primero funciona, pero implica un rodeo por una herramienta de compresión antes siquiera de poder empezar.",
    "Relayium te deja elegir una carpeta y enviarla tal cual en una transferencia en tiempo real. El navegador conserva todo el árbol y transmite en vivo — directamente por WebRTC en la misma LAN, o como texto cifrado de extremo a extremo por TURN entre redes — sin copia ni historial en tiempo real del lado del servidor. El enlace almacenado que dejas para después es la única vía que no lleva árbol: comprime tú mismo la carpeta y sube ese único archivo.",
  ],
  sections: [
    {
      heading: "Elige una carpeta, no un montón de archivos",
      body: [
        "En lugar de seleccionar los archivos uno por uno, elige la carpeta en sí. Relayium recorre el árbol de directorios en el navegador y conserva la ruta relativa de cada archivo — subcarpetas, subcarpetas anidadas, todo — para que lo que llega al otro extremo tenga la misma disposición con la que empezaste.",
        "Esto funciona hoy en Chrome, Edge y Firefox de escritorio. No funciona en iOS: el selector de archivos de Safari en iPhone y iPad no tiene forma de seleccionar una carpeta, solo archivos individuales, así que el envío de carpetas es de momento una función de escritorio.",
      ],
      prereqs: {
        label: "Lo que necesitas",
        items: [
          "Un navegador de escritorio en el lado que envía — Chrome, Edge o Firefox. El selector de archivos de Safari en iPhone y iPad no puede elegir una carpeta en absoluto, solo archivos sueltos, así que un envío de carpeta arranca en un ordenador.",
          "Un árbol de como máximo 1.000 archivos. Ese tope es por lote y no por sesión, así que un árbol mayor pasa en varios envíos sin reconectar.",
          "Una decisión sobre el navegador que recibe, porque él determina la forma de lo que llega: Chrome o Edge escribe el árbol en una carpeta que elige el destinatario, y cualquier otro navegador produce en su lugar un .zip.",
          "Los dos lados en línea a la vez para un envío en tiempo real, o — cuando la otra persona no está — un remitente con sesión iniciada más un archivo comprimido que hayas hecho tú, porque un enlace almacenado sube una lista plana de archivos y no lleva ningún árbol de directorios.",
        ],
      },
      steps: [
        {
          text: "Abre la página de transferencia en el ordenador que envía: la de la misma red si estáis los dos en una, la de tiempo real si hace falta un código de emparejamiento.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Arrastra la carpeta a la página, o usa el botón de selección de carpeta. Relayium recorre el árbol en el navegador y conserva la ruta relativa de cada archivo, así que no hay que comprimir nada antes.",
        },
        {
          text: "En la misma red, busca al destinatario bajo «Dispositivos cercanos», pulsa «Abrir espacio de trabajo» en su tarjeta y usa después el adjunto «Enviar una carpeta» dentro de ese espacio de trabajo. Entre redes es la misma acción única: únete a la sala de código de emparejamiento y pulsa «Abrir espacio de trabajo» en la tarjeta del par también allí. En ambos casos, la solicitud que llega al otro lado indica el número de archivos y el tamaño total de todo el árbol, no el de un archivo.",
        },
        {
          text: "En el lado que recibe, lee la línea bajo la solicitud antes de aceptar: en Chrome o Edge dice que el navegador preguntará dónde guardar, y esa es la vía que reproduce la carpeta en el disco. Después pulsa «Aceptar».",
        },
        {
          text: "Observa cómo el contador de archivos sube por el árbol en las dos pantallas. Cuenta archivos, así que una carpeta de 300 archivos llega a «Archivo 300/300» en lugar de mostrar una sola barra para el lote.",
          code: ["Archivo 300/300"],
        },
      ],
      success: {
        label: "Qué se ve al terminar un envío de carpeta",
        body: [
          "El contador acaba en el último archivo del lote, y cada archivo llegó con su propio hash SHA-256 comprobado de extremo a extremo, así que lo que aterrizó coincide byte a byte con lo que enviaste.",
          "Después mira el resultado y no la página, porque difiere según el navegador: en Chrome o Edge el árbol está dentro de la carpeta que elegiste, con subcarpetas incluidas, y en Firefox o Safari hay un único .zip en la lista de descargas que se descomprime con la misma estructura.",
        ],
        code: ["Directo por LAN\nArchivo 300/300"],
      },
    },
    {
      heading: "Qué recibe la otra persona",
      body: [
        "Cómo llega la carpeta depende del navegador que recibe. Chrome y Edge pueden escribir los archivos directamente en un directorio que elija el destinatario, así que la carpeta aparece en el disco exactamente como salió — sin paso extra.",
        "Firefox y Safari no tienen esa capacidad, así que en su lugar reciben un único archivo .zip sin comprimir (modo almacenamiento) que se descomprime en la misma estructura de carpetas exacta. Se mantiene por debajo de 4 GiB (sin soporte de ZIP64), lo que cubre la inmensa mayoría de carpetas de proyecto y conjuntos de fotos o documentos — para algo más grande, divídelo en dos envíos.",
      ],
      troubleshooting: {
        label: "Síntoma, comprobación, solución",
        items: [
          {
            symptom: "No hay forma alguna de elegir una carpeta en el dispositivo que envía.",
            code: ["https://relayium.com/   # el selector ofrece una carpeta solo donde el navegador puede"],
            fix: "Casi con seguridad estás en iPhone o iPad, donde el selector de Safari solo expone archivos sueltos. Empieza el envío de carpeta desde un Chrome, Edge o Firefox de escritorio y usa el teléfono como lado receptor.",
          },
          {
            symptom: "El .zip que llegó está corrupto, o la descarga se paró cerca de 4 GiB.",
            code: ["chrome://downloads   # compara el tamaño del .zip con la carpeta que enviaste"],
            fix: "La vía del archivo comprimido no tiene ZIP64, así que tanto una entrada suelta como el archivo entero deben quedarse bajo 4 GiB. Divide el árbol en dos envíos, o que la otra persona reciba en Chrome o Edge, que escribe los archivos en una carpeta elegida y no construye ningún archivo.",
          },
          {
            symptom: "El .zip pesa lo mismo que la carpeta, sin compresión alguna.",
            code: ["chrome://downloads   # el tamaño de la entrada iguala el total de la carpeta, no menos"],
            fix: "Es lo esperado: el archivo va en modo almacenamiento, así que empaqueta el árbol sin comprimirlo y se mantiene idéntico byte a byte a lo que enviaste. Comprime tú mismo la carpeta antes de enviar si el tamaño en la red importa más que una copia exacta.",
          },
          {
            symptom: "Los archivos llegaron pero todos planos en una carpeta, sin las subcarpetas.",
            code: ["chrome://downloads   # un navegador sin selector de directorio entrega un único .zip"],
            fix: "Las rutas relativas sobreviven a un envío en tiempo real, así que esto es el aspecto de un .zip antes de descomprimirlo y no una transferencia aplanada. Descomprímelo y las subcarpetas están ahí; para que el árbol aterrice directamente en el disco, recíbelo en Chrome o Edge y elige una carpeta de destino cuando lo pida. La única vía realmente plana es el enlace de descarga almacenado, que sube una lista simple de archivos y descarta las rutas, y por eso una carpeta destinada a un enlace hay que comprimirla antes.",
          },
          {
            symptom: "Una carpeta de unos cientos de archivos se para a medio camino y falta un archivo.",
            code: ["https://relayium.com/   # el contador nombra el archivo en el que se detuvo"],
            fix: "Un envío en tiempo real es una sesión en directo, y una caída pasajera puede retomarse desde el último punto de control duradero mientras las dos páginas sigan abiertas. Cerrar o recargar cualquiera de las dos termina la sesión, y entonces ya no queda nada que retomar. Deja las dos pestañas abiertas y dale un momento antes de tocar nada; solo si la sesión se ha perdido de verdad, reenvía el lote desde el archivo que nombró el contador. Para una entrega sin nadie al otro lado, comprime tú mismo la carpeta en un zip y sube ese único archivo como enlace almacenado, porque una subida almacenada recibe una lista plana de archivos.",
          },
        ],
      },
    },
    {
      heading: "En tiempo real, o un enlace para más tarde",
      body: [
        "Si ambos lados están en línea, envía la carpeta en tiempo real. En la misma LAN, WebRTC conecta directamente; entre redes, los navegadores usan TURN por diseño para transportar texto cifrado de extremo a extremo que el retransmisor no puede leer ni descifrar. Relayium no conserva copia del lado del servidor ni historial en tiempo real. En la misma red no hace falta cuenta; entre redes inicia sesión quien crea el código y quien se une nunca la necesita.",
        "Si la otra persona no está disponible ahora mismo, crea en su lugar un enlace almacenado — pero comprime tú mismo la carpeta antes. Una subida almacenada recibe una lista plana de archivos: las rutas relativas se descartan, así que un árbol subido tal cual llega como archivos sueltos, y dos archivos con el mismo nombre en subcarpetas distintas chocan. Haz un .zip corriente y sube ese único archivo, y la estructura viaja dentro del comprimido. Tu navegador cifra lo que subas con una clave AES-256-GCM aleatoria que solo vive en el propio enlace, de modo que el servidor guarda texto cifrado que no puede leer. Crear un enlace requiere que el remitente inicie sesión; configúralo para que caduque en 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o haz que se destruya tras la primera descarga.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Puedo enviar una carpeta desde un iPhone o iPad?",
        a: "No como remitente — el Safari de iOS no tiene selector de carpetas, solo archivos individuales, así que el envío de carpetas funciona actualmente desde Chrome, Edge o Firefox de escritorio. Un iPhone o iPad sí puede recibir una carpeta sin problema, como un .zip.",
      },
      {
        q: "¿Se conservan las subcarpetas y la estructura de archivos?",
        a: "En un envío en tiempo real, sí: Relayium conserva la ruta relativa de cada archivo, incluidas las subcarpetas anidadas, así que la carpeta que llega tiene la misma disposición que la que elegiste. Un enlace de descarga almacenado es distinto — sube una lista plana de archivos y descarta las rutas — así que comprime tú mismo la carpeta y sube el comprimido cuando la estructura tenga que sobrevivir.",
      },
      {
        q: "¿Cuántos archivos puede contener un envío de carpeta?",
        a: "Hasta 1.000 archivos en un solo lote, cada uno verificado individualmente con un hash SHA-256 a su llegada.",
      },
      {
        q: "¿El destinatario recibe una carpeta de verdad o un .zip?",
        a: "Depende de su navegador. Chrome y Edge escriben los archivos directamente en un directorio que ellos eligen. Firefox y Safari reciben un único .zip sin comprimir (menos de 4 GiB) que se descomprime en la misma estructura de carpetas.",
      },
      {
        q: "¿Necesito una cuenta para enviar una carpeta?",
        a: "No en la misma red. Enviar entre redes con un código de emparejamiento requiere que el remitente inicie sesión, pero quien recibe nunca necesita cuenta en ningún caso.",
      },
    ],
  },
  cta: {
    text: "Elige una carpeta y envíala exactamente como está — estructura intacta, cada archivo verificado.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "Como enviar uma pasta inteira, não só arquivos",
  description:
    "Escolha uma pasta inteira no navegador e envie de uma vez — caminhos relativos preservados, até 1.000 arquivos, cada um verificado com SHA-256. Sem precisar compactar antes.",
  updatedLabel: "Última atualização",
  lead: [
    "Enviar um projeto não é a mesma coisa que enviar um arquivo — você tem uma pasta cheia de subpastas, e copiar e colar cada pedaço separadamente perde a estrutura que a torna útil. Compactar antes funciona, mas significa um desvio por uma ferramenta de compressão antes mesmo de conseguir começar.",
    "O Relayium deixa você escolher uma pasta e enviá-la como está em uma transferência em tempo real. O navegador preserva toda a árvore e transmite ao vivo — diretamente por WebRTC na mesma LAN, ou como texto cifrado de ponta a ponta por TURN entre redes — sem cópia nem histórico em tempo real no servidor. O link armazenado que você deixa para depois é o único caminho que não leva árvore: compacte a pasta você mesmo e envie esse arquivo único.",
  ],
  sections: [
    {
      heading: "Escolha uma pasta, não uma pilha de arquivos",
      body: [
        "Em vez de selecionar os arquivos um a um, escolha a própria pasta. O Relayium percorre a árvore de diretórios no navegador e mantém o caminho relativo de cada arquivo — subpastas, subpastas aninhadas, tudo — para que o que chega do outro lado tenha o mesmo layout com que você começou.",
        "Isso funciona hoje no Chrome, Edge e Firefox de desktop. Não funciona no iOS: o seletor de arquivos do Safari no iPhone e no iPad não tem como selecionar uma pasta, apenas arquivos individuais, então o envio de pastas é, por enquanto, um recurso de desktop.",
      ],
      prereqs: {
        label: "O que você precisa",
        items: [
          "Um navegador de computador no lado que envia — Chrome, Edge ou Firefox. O seletor de arquivos do Safari no iPhone e no iPad não consegue escolher uma pasta de jeito nenhum, só arquivos avulsos, então um envio de pasta começa num computador.",
          "Uma árvore com no máximo 1.000 arquivos. Esse teto é por lote, não por sessão, então uma árvore maior passa em vários envios sem reconectar.",
          "Uma decisão sobre o navegador que recebe, porque é ele que determina a forma do que chega: Chrome ou Edge grava a árvore em uma pasta escolhida por quem recebe, e qualquer outro navegador produz um .zip em vez disso.",
          "Os dois lados online ao mesmo tempo para um envio em tempo real, ou — quando a outra pessoa não está por perto — um remetente logado mais um arquivo compactado feito por você, porque um link armazenado envia uma lista plana de arquivos e não leva árvore de diretórios nenhuma.",
        ],
      },
      steps: [
        {
          text: "Abra a página de transferência no computador que envia — a da mesma rede se os dois estiverem em uma só, a de tempo real se for preciso um código de emparelhamento.",
          code: ["https://relayium.com/"],
        },
        {
          text: "Arraste a pasta para a página, ou use o botão de seleção de pasta. O Relayium percorre a árvore no navegador e mantém o caminho relativo de cada arquivo, então nada precisa ser compactado antes.",
        },
        {
          text: "Na mesma rede, ache quem recebe em “Dispositivos próximos”, aperte “Abrir área de trabalho” no cartão dele e depois use o anexo “Enviar uma pasta” dentro dessa área de trabalho. Entre redes é a mesma ação única: entre na sala de código de emparelhamento e aperte “Abrir área de trabalho” no cartão do par ali também. De um jeito ou de outro, o pedido que chega do outro lado informa a quantidade de arquivos e o tamanho total da árvore inteira, não de um arquivo.",
        },
        {
          text: "No lado que recebe, leia a linha abaixo do pedido antes de aceitar: no Chrome ou no Edge ela diz que o navegador vai perguntar onde salvar, e é esse caminho que reproduz a pasta no disco. Depois clique em “Aceitar”.",
        },
        {
          text: "Acompanhe o contador de arquivos subir pela árvore nas duas telas. Ele conta arquivos, então uma pasta de 300 arquivos chega a “Arquivo 300/300” em vez de mostrar uma única barra para o lote.",
          code: ["Arquivo 300/300"],
        },
      ],
      success: {
        label: "Como é um envio de pasta concluído",
        body: [
          "O contador termina no último arquivo do lote, e cada arquivo chegou com o seu próprio hash SHA-256 verificado de ponta a ponta, então o que caiu corresponde byte a byte ao que você enviou.",
          "Depois olhe o resultado, não a página, porque ele difere por navegador: no Chrome ou no Edge a árvore está dentro da pasta que você escolheu, com subpastas e tudo, e no Firefox ou no Safari há um único .zip na lista de downloads que se descompacta na mesma estrutura.",
        ],
        code: ["LAN direto\nArquivo 300/300"],
      },
    },
    {
      heading: "O que a outra pessoa recebe",
      body: [
        "Como a pasta chega depende do navegador que recebe. Chrome e Edge podem gravar os arquivos direto em um diretório que o destinatário escolhe, então a pasta aparece no disco exatamente como saiu — sem passo extra.",
        "Firefox e Safari não têm essa capacidade, então recebem em vez disso um único arquivo .zip sem compressão (modo armazenamento) que, ao ser descompactado, resulta na mesma estrutura de pasta exata. Ele fica abaixo de 4 GiB (sem suporte a ZIP64), o que cobre a grande maioria das pastas de projeto e conjuntos de fotos ou documentos — para algo maior, divida em dois envios.",
      ],
      troubleshooting: {
        label: "Sintoma, verificação, correção",
        items: [
          {
            symptom: "Não existe jeito nenhum de escolher uma pasta no dispositivo que envia.",
            code: ["https://relayium.com/   # o seletor oferece pasta só onde o navegador consegue"],
            fix: "Você está quase certamente em iPhone ou iPad, onde o seletor do Safari só expõe arquivos avulsos. Comece o envio de pasta num Chrome, Edge ou Firefox de computador e use o celular como lado que recebe.",
          },
          {
            symptom: "O .zip que chegou está corrompido, ou o download parou perto de 4 GiB.",
            code: ["chrome://downloads   # compare o tamanho do .zip com a pasta que você enviou"],
            fix: "O caminho do arquivo compactado não tem ZIP64, então tanto uma entrada isolada quanto o arquivo inteiro precisam ficar abaixo de 4 GiB. Divida a árvore em dois envios, ou peça para receber no Chrome ou no Edge, que grava os arquivos numa pasta escolhida e não constrói arquivo nenhum.",
          },
          {
            symptom: "O .zip tem o mesmo tamanho da pasta, sem compressão alguma.",
            code: ["chrome://downloads   # o tamanho da entrada iguala o total da pasta, não menos"],
            fix: "É o esperado: o arquivo vai em modo armazenamento, então empacota a árvore sem comprimir e permanece idêntico byte a byte ao que você enviou. Compacte a pasta você mesmo antes de enviar se o tamanho na rede importa mais do que uma cópia exata.",
          },
          {
            symptom: "Os arquivos chegaram mas todos soltos em uma pasta, sem as subpastas.",
            code: ["chrome://downloads   # um navegador sem seletor de diretório entrega um único .zip"],
            fix: "Os caminhos relativos sobrevivem em um envio em tempo real, então isto é a cara de um .zip antes de ser aberto, e não uma transferência achatada. Descompacte e as subpastas estão lá; para a árvore cair direto no disco, receba no Chrome ou no Edge e escolha uma pasta de destino quando ele perguntar. O único caminho realmente plano é o link de download armazenado, que envia uma lista simples de arquivos e descarta os caminhos, e é por isso que uma pasta destinada a um link precisa ser compactada antes.",
          },
          {
            symptom: "Uma pasta de algumas centenas de arquivos para no meio e falta um arquivo.",
            code: ["https://relayium.com/   # o contador informa o arquivo em que parou"],
            fix: "Um envio em tempo real é uma sessão ao vivo, e uma queda passageira pode retomar do último ponto de verificação durável enquanto as duas páginas continuarem abertas. Fechar ou recarregar qualquer uma delas encerra a sessão, e aí não sobra nada para retomar. Deixe as duas abas abertas e dê um momento antes de mexer em qualquer coisa; só se a sessão tiver mesmo acabado, reenvie o lote a partir do arquivo que o contador informou. Para uma entrega sem ninguém do outro lado, compacte a pasta você mesmo em um zip e envie esse arquivo único como link armazenado, porque um upload armazenado recebe uma lista plana de arquivos.",
          },
        ],
      },
    },
    {
      heading: "Em tempo real, ou um link para depois",
      body: [
        "Se as duas partes estiverem online, envie a pasta em tempo real. Na mesma LAN, o WebRTC conecta diretamente; entre redes, os navegadores usam TURN por design para transportar texto cifrado de ponta a ponta que o retransmissor não consegue ler nem descriptografar. O Relayium não mantém cópia no servidor nem histórico em tempo real. Na mesma rede não é preciso conta; entre redes entra quem cria o código e quem participa nunca precisa de uma.",
        "Se a outra pessoa não estiver por perto agora, crie um link armazenado em vez disso — mas compacte a pasta você mesmo antes. Um upload armazenado recebe uma lista plana de arquivos: os caminhos relativos são descartados, então uma árvore enviada direto chega como arquivos soltos, e dois arquivos de mesmo nome em subpastas diferentes colidem. Faça um .zip comum e envie esse arquivo único, e a estrutura viaja dentro do compactado. Seu navegador criptografa o que você envia com uma chave AES-256-GCM aleatória que só existe no próprio link, de modo que o servidor guarda texto cifrado que não consegue ler. Criar um link exige que o remetente faça login; defina para expirar em 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou faça-o se autodestruir após o primeiro download.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "Posso enviar uma pasta de um iPhone ou iPad?",
        a: "Não como remetente — o Safari do iOS não tem seletor de pastas, apenas arquivos individuais, então o envio de pastas funciona atualmente a partir do Chrome, Edge ou Firefox de desktop. Um iPhone ou iPad ainda pode receber uma pasta numa boa, como um .zip.",
      },
      {
        q: "As subpastas e a estrutura de arquivos são preservadas?",
        a: "Em um envio em tempo real, sim: o Relayium mantém o caminho relativo de cada arquivo, incluindo subpastas aninhadas, então a pasta que chega tem o mesmo layout da que você escolheu. Um link de download armazenado é diferente — ele envia uma lista plana de arquivos e descarta os caminhos — então compacte a pasta você mesmo e envie o compactado quando a estrutura precisar sobreviver.",
      },
      {
        q: "Quantos arquivos um envio de pasta pode conter?",
        a: "Até 1.000 arquivos em um único lote, cada um verificado individualmente com um hash SHA-256 na chegada.",
      },
      {
        q: "O destinatário recebe uma pasta de verdade ou um .zip?",
        a: "Depende do navegador dele. Chrome e Edge gravam os arquivos direto em um diretório que ele escolhe. Firefox e Safari recebem um único .zip sem compressão (abaixo de 4 GiB) que, ao ser descompactado, resulta na mesma estrutura de pasta.",
      },
      {
        q: "Preciso de uma conta para enviar uma pasta?",
        a: "Não na mesma rede. Enviar entre redes com um código de emparelhamento exige que o remetente faça login, mas quem recebe nunca precisa de conta em nenhum dos casos.",
      },
    ],
  },
  cta: {
    text: "Escolha uma pasta e envie exatamente como ela está — estrutura intacta, cada arquivo verificado.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "how-to/send-a-folder",
  published: "2026-07-09",
  updated: "2026-08-05",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
