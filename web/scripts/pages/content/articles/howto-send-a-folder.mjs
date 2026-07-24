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
    "Relayium lets you pick a folder directly and send it as-is. The browser walks the whole tree, keeps every relative path intact, and streams it to the other side — whether that ends up peer-to-peer with nothing stored, or as a link you can leave for later.",
  ],
  sections: [
    {
      heading: "Pick a folder, not a pile of files",
      body: [
        "Instead of selecting files one by one, choose the folder itself. Relayium walks the directory tree in the browser and keeps every file's relative path — subfolders, nested subfolders, all of it — so what arrives on the other end has the same layout you started with.",
        "This works today in desktop Chrome, Edge, and Firefox. It doesn't work on iOS: Safari's file picker on iPhone and iPad has no way to select a folder, only individual files, so folder sending is a desktop feature for now.",
      ],
      bullets: [
        "Up to 1,000 files in a single batch.",
        "Every file is verified end-to-end with its own SHA-256 hash, so what lands matches exactly what you sent.",
        "Works from drag-and-drop or a folder picker button — no need to zip anything first.",
      ],
    },
    {
      heading: "What the other person gets",
      body: [
        "How the folder arrives depends on the receiving browser. Chrome and Edge can write files straight into a directory the recipient chooses, so the folder shows up on disk exactly as it left — no extra step.",
        "Firefox and Safari don't have that capability, so instead they receive one store-only .zip archive that unpacks to the exact same folder structure. It stays under 4 GiB (no ZIP64 support), which covers the vast majority of project folders and photo or document sets — for anything bigger, split into two sends.",
      ],
    },
    {
      heading: "Realtime, or a link for later",
      body: [
        "If you can both be online at the same time, send the folder directly — it goes peer-to-peer and nothing is stored on any server in between. This is the fastest path and needs no account if you're on the same network; sending across networks with a pairing code just needs the sender to sign in, and the receiver never needs an account at all.",
        "If the other person isn't around right now, create a stored link instead. Your browser encrypts the folder's files before upload with a random AES-256-GCM key that only ever lives in the link itself, so the server holds ciphertext it can't read. Creating a link needs the sender to sign in; set it to expire in 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or make it burn after the first download.",
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
        a: "Yes. Relayium keeps every file's relative path, including nested subfolders, so the folder that arrives has the same layout as the one you picked.",
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
    "Relayium 让你直接选中文件夹整体发送。浏览器会遍历整棵目录树，完整保留每个文件的相对路径，然后把它流式传给对方——无论最终是点对点、什么都不存，还是生成一个可以留到以后取用的链接。",
  ],
  sections: [
    {
      heading: "选文件夹，而不是一堆散文件",
      body: [
        "不必一个个选文件，直接选中文件夹本身即可。Relayium 会在浏览器里遍历整个目录树，保留每个文件的相对路径——子文件夹、嵌套的子文件夹，全都保留——所以对方收到的东西和你出发时的目录结构一致。",
        "目前这在桌面版 Chrome、Edge 和 Firefox 上可用。在 iOS 上不行：iPhone 和 iPad 上 Safari 的文件选择器没有办法选中文件夹，只能选单个文件，所以发送文件夹暂时是桌面端的功能。",
      ],
      bullets: [
        "单批最多 1,000 个文件。",
        "每个文件都用各自的 SHA-256 哈希做端到端校验，确保到达的内容和你发出的完全一致。",
        "可以拖放，也可以用文件夹选择按钮——不需要先打包压缩。",
      ],
    },
    {
      heading: "对方收到的是什么",
      body: [
        "文件夹如何送达取决于接收端的浏览器。Chrome 和 Edge 可以把文件直接写入接收者选定的目录，文件夹会原样出现在磁盘上——不需要额外步骤。",
        "Firefox 和 Safari 没有这个能力，所以它们收到的是一个仅存储（不压缩）的 .zip 压缩包，解压后就是完全相同的文件夹结构。它保持在 4 GiB 以内（不支持 ZIP64），这足以覆盖绝大多数项目文件夹和照片、文档集合——如果更大，就拆成两次发送。",
      ],
    },
    {
      heading: "实时传输，或留个链接稍后取",
      body: [
        "如果双方能同时在线，直接发送文件夹即可——它走点对点，中途不会存在任何服务器上。这是最快的方式，同一网络下不需要账号；跨网络用配对码发送只需要发送方登录一下，接收方任何情况下都不需要账号。",
        "如果对方现在不在，可以改为创建一个存储链接。你的浏览器会在上传前用一把只存在于链接本身的随机 AES-256-GCM 密钥加密文件夹里的文件，服务器只保存它读不懂的密文。创建链接需要发送方登录；可以设置 1 小时、1 天、3 天、7 天或最长 14 天后过期（上限取决于套餐），也可以设置为首次下载后即焚。",
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
        a: "会。Relayium 保留每个文件的相对路径，包括嵌套的子文件夹，所以到达的文件夹和你选中的那个结构完全一致。",
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
    "ブラウザでフォルダをまるごと選んで一括送信——相対パスを保持したまま、1バッチ最大1,000ファイル、それぞれ SHA-256 で検証。事前の圧縮は不要です。",
  updatedLabel: "最終更新",
  lead: [
    "プロジェクトを送ることは、ファイルを送ることとは違います。手元にあるのはサブフォルダの入ったフォルダで、ひとつずつコピー&ペーストすると、それを役立つものにしている構造が失われてしまいます。先に圧縮しておく手もありますが、転送を始める前に圧縮ツールへ寄り道することになります。",
    "Relayium ならフォルダをそのまま選んで送信できます。ブラウザがディレクトリツリー全体をたどり、各ファイルの相対パスをそのまま保ち、相手側へストリーミングします——最終的にサーバーに何も残らない P2P になるか、あとで受け取れるリンクになるかは選べます。",
  ],
  sections: [
    {
      heading: "ファイルの山ではなく、フォルダを選ぶ",
      body: [
        "ファイルを1つずつ選ぶのではなく、フォルダそのものを選びます。Relayium はブラウザ内でディレクトリツリー全体をたどり、各ファイルの相対パス——サブフォルダ、入れ子になったサブフォルダも含め——をすべて保持するので、相手に届くものは元と同じレイアウトになります。",
        "これは現在、デスクトップの Chrome、Edge、Firefox で使えます。iOS では使えません。iPhone や iPad の Safari のファイル選択画面にはフォルダを選ぶ手段がなく、個々のファイルしか選べないため、フォルダ送信は今のところデスクトップの機能です。",
      ],
      bullets: [
        "1バッチ最大1,000ファイル。",
        "各ファイルは固有の SHA-256 ハッシュでエンドツーエンドに検証され、届いたものが送ったものと完全に一致することを確認します。",
        "ドラッグ&ドロップでもフォルダ選択ボタンでも使えます——事前に圧縮する必要はありません。",
      ],
    },
    {
      heading: "相手が受け取るもの",
      body: [
        "フォルダの届き方は受信側のブラウザによって変わります。Chrome と Edge は、受信者が選んだディレクトリへファイルを直接書き込めるため、フォルダは送り出したときとまったく同じ形でディスク上に現れます——追加の手順は不要です。",
        "Firefox と Safari にはその機能がないため、代わりに無圧縮（ストア方式）の .zip アーカイブを1つ受け取り、解凍すると同じフォルダ構造になります。サイズは 4 GiB 未満に収まります（ZIP64 非対応）。これはほとんどのプロジェクトフォルダや写真・書類のまとまりをカバーしますが、それより大きい場合は2回に分けて送ってください。",
      ],
    },
    {
      heading: "今すぐリアルタイムで、または後で取れるリンクを",
      body: [
        "双方が同時にオンラインになれるなら、フォルダを直接送りましょう——P2P で流れ、途中どのサーバーにも何も保存されません。これが最も速い方法で、同じネットワークならアカウントは不要です。ネットワークをまたいでペアリングコードで送る場合も送信側がサインインするだけで、受信側はどちらの場合もアカウント不要です。",
        "相手が今いない場合は、代わりに保存リンクを作成できます。ブラウザはアップロード前に、そのリンク自体にしか存在しないランダムな AES-256-GCM 鍵でフォルダ内のファイルを暗号化するため、サーバーは読めない暗号文だけを保持します。リンクの作成には送信側のサインインが必要です。有効期限は1時間・1日・3日・7日・最長14日（プランによる）から選ぶか、初回ダウンロード後に消去する設定にもできます。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "iPhone や iPad からフォルダを送れますか？",
        a: "送信側としては送れません——iOS の Safari にはフォルダ選択の手段がなく、個々のファイルしか選べないため、現在フォルダ送信はデスクトップの Chrome、Edge、Firefox からのみ行えます。iPhone や iPad は受信側としてはフォルダを問題なく受け取れます（.zip として届きます）。",
      },
      {
        q: "サブフォルダやファイル構造は保持されますか？",
        a: "はい。Relayium は入れ子になったサブフォルダを含む各ファイルの相対パスを保持するため、届くフォルダは選んだものと同じレイアウトになります。",
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
    text: "フォルダを選んで、そのままの形で送りましょう——構造そのまま、すべてのファイルを検証済みで。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "파일이 아니라 폴더째로 보내는 방법",
  description:
    "브라우저에서 폴더 전체를 선택해 한 번에 전송하세요——상대 경로 유지, 배치당 최대 1,000개 파일, 각각 SHA-256으로 검증. 미리 압축할 필요가 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "프로젝트를 보내는 것은 파일 하나를 보내는 것과 다릅니다. 손에 든 건 하위 폴더가 잔뜩 있는 폴더이고, 하나씩 복사-붙여넣기하면 그것을 쓸모 있게 만드는 구조가 사라져 버립니다. 먼저 압축해도 되지만, 그러면 전송을 시작하기 전에 압축 도구를 거쳐야 합니다.",
    "Relayium은 폴더를 그대로 선택해 보낼 수 있게 해줍니다. 브라우저가 디렉터리 트리 전체를 훑으며 모든 파일의 상대 경로를 그대로 유지한 채 상대에게 스트리밍합니다——결과적으로 아무것도 저장되지 않는 P2P가 되든, 나중에 받을 수 있게 남겨두는 링크가 되든 마찬가지입니다.",
  ],
  sections: [
    {
      heading: "파일 더미가 아니라 폴더를 선택하세요",
      body: [
        "파일을 하나씩 고르는 대신 폴더 자체를 선택하세요. Relayium은 브라우저에서 디렉터리 트리 전체를 훑으며 각 파일의 상대 경로——하위 폴더, 중첩된 하위 폴더까지 전부——를 유지하므로, 상대에게 도착하는 것은 처음 시작할 때와 같은 구조를 갖습니다.",
        "현재 이 기능은 데스크톱 Chrome, Edge, Firefox에서 동작합니다. iOS에서는 동작하지 않습니다. iPhone과 iPad의 Safari 파일 선택기는 폴더를 선택할 방법이 없고 개별 파일만 고를 수 있어서, 폴더 전송은 지금으로선 데스크톱 기능입니다.",
      ],
      bullets: [
        "한 배치에 최대 1,000개 파일.",
        "각 파일은 고유한 SHA-256 해시로 종단간 검증되어, 도착한 것이 보낸 것과 정확히 일치하는지 확인합니다.",
        "드래그 앤 드롭이나 폴더 선택 버튼 모두 사용할 수 있습니다——미리 압축할 필요가 없습니다.",
      ],
    },
    {
      heading: "상대방이 받는 것",
      body: [
        "폴더가 어떻게 도착하는지는 받는 쪽의 브라우저에 따라 다릅니다. Chrome과 Edge는 받는 사람이 선택한 디렉터리로 파일을 곧바로 써넣을 수 있어서, 폴더가 떠날 때와 똑같은 모습으로 디스크에 나타납니다——추가 단계가 없습니다.",
        "Firefox와 Safari에는 그 기능이 없어서, 대신 압축하지 않은(저장 방식) .zip 아카이브 하나를 받으며 이를 풀면 정확히 같은 폴더 구조가 됩니다. 크기는 4 GiB 미만으로 유지됩니다(ZIP64 미지원). 대부분의 프로젝트 폴더나 사진·문서 모음에는 충분하며, 더 크다면 두 번으로 나눠 보내세요.",
      ],
    },
    {
      heading: "지금 실시간으로, 또는 나중을 위해 링크로",
      body: [
        "양쪽이 동시에 온라인일 수 있다면 폴더를 직접 보내세요——P2P로 전달되며 그 사이 어떤 서버에도 아무것도 저장되지 않습니다. 이것이 가장 빠른 방법이며, 같은 네트워크에서는 계정이 필요 없습니다. 네트워크를 넘어 페어링 코드로 보낼 때도 보내는 쪽이 로그인만 하면 되고, 받는 쪽은 어느 경우든 계정이 전혀 필요 없습니다.",
        "상대가 지금 없다면 대신 저장 링크를 만들 수 있습니다. 브라우저는 업로드 전에 그 링크에만 존재하는 무작위 AES-256-GCM 키로 폴더 안의 파일들을 암호화하므로, 서버는 읽을 수 없는 암호문만 보관합니다. 링크 생성에는 보내는 쪽의 로그인이 필요합니다. 1시간·1일·3일·7일·최대 14일(요금제에 따라 다름) 중 만료 시점을 정하거나, 첫 다운로드 후 소각되도록 설정할 수도 있습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "iPhone이나 iPad에서 폴더를 보낼 수 있나요?",
        a: "보내는 쪽으로는 안 됩니다——iOS의 Safari에는 폴더 선택 수단이 없고 개별 파일만 고를 수 있어서, 현재 폴더 전송은 데스크톱 Chrome, Edge, Firefox에서만 가능합니다. iPhone이나 iPad는 받는 쪽으로는 폴더를 문제없이 받을 수 있으며, .zip 형태로 도착합니다.",
      },
      {
        q: "하위 폴더와 파일 구조가 유지되나요?",
        a: "네. Relayium은 중첩된 하위 폴더를 포함해 각 파일의 상대 경로를 유지하므로, 도착한 폴더는 선택했던 것과 같은 구조를 갖습니다.",
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
    "Relayium lässt dich einen Ordner direkt auswählen und so senden, wie er ist. Der Browser durchläuft den ganzen Verzeichnisbaum, behält jeden relativen Pfad bei und streamt ihn zur Gegenseite — egal ob am Ende Peer-to-Peer ohne Speicherung dabei herauskommt oder ein Link, den du für später hinterlässt.",
  ],
  sections: [
    {
      heading: "Einen Ordner wählen, keinen Haufen Dateien",
      body: [
        "Statt Dateien einzeln auszuwählen, wählst du den Ordner selbst. Relayium durchläuft den Verzeichnisbaum im Browser und behält den relativen Pfad jeder Datei bei — Unterordner, verschachtelte Unterordner, alles — sodass das, was auf der anderen Seite ankommt, dasselbe Layout hat wie zu Beginn.",
        "Das funktioniert heute in Desktop-Chrome, -Edge und -Firefox. Unter iOS geht es nicht: Safaris Dateiauswahl auf iPhone und iPad kann keinen Ordner auswählen, nur einzelne Dateien, daher ist Ordnerversand vorerst eine Desktop-Funktion.",
      ],
      bullets: [
        "Bis zu 1.000 Dateien in einem einzigen Stapel.",
        "Jede Datei wird Ende-zu-Ende mit ihrem eigenen SHA-256-Hash geprüft, sodass das Ankommende exakt dem entspricht, was du gesendet hast.",
        "Funktioniert per Drag-and-Drop oder über eine Ordnerauswahl-Schaltfläche — nichts muss vorher gezippt werden.",
      ],
    },
    {
      heading: "Was die andere Person bekommt",
      body: [
        "Wie der Ordner ankommt, hängt vom empfangenden Browser ab. Chrome und Edge können Dateien direkt in ein Verzeichnis schreiben, das die empfangende Person wählt, sodass der Ordner genauso auf der Festplatte erscheint, wie er abgeschickt wurde — kein zusätzlicher Schritt.",
        "Firefox und Safari haben diese Fähigkeit nicht, deshalb erhalten sie stattdessen ein einzelnes, unkomprimiertes (Store-Modus) .zip-Archiv, das beim Entpacken genau dieselbe Ordnerstruktur ergibt. Es bleibt unter 4 GiB (kein ZIP64), was die große Mehrheit von Projektordnern und Foto- oder Dokumentensammlungen abdeckt — bei mehr teilst du es in zwei Sendungen auf.",
      ],
    },
    {
      heading: "Jetzt in Echtzeit oder als Link für später",
      body: [
        "Könnt ihr beide gleichzeitig online sein, sende den Ordner direkt — er läuft Peer-to-Peer, und dazwischen wird nichts auf irgendeinem Server gespeichert. Das ist der schnellste Weg und braucht im selben Netz kein Konto; beim Senden über Netzwerke hinweg per Pairing-Code muss sich nur der Absender anmelden, und die empfangende Person braucht in keinem Fall ein Konto.",
        "Ist die andere Person gerade nicht da, erstelle stattdessen einen gespeicherten Link. Dein Browser verschlüsselt die Dateien des Ordners vor dem Upload mit einem zufälligen AES-256-GCM-Schlüssel, der nur im Link selbst existiert, sodass der Server Chiffretext hält, den er nicht lesen kann. Das Erstellen eines Links erfordert die Anmeldung des Absenders; lege eine Gültigkeit von 1 Stunde, 1 Tag, 3 Tagen, 7 Tagen oder bis zu 14 Tagen je nach Tarif fest, oder lass ihn nach dem ersten Download verfallen.",
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
        a: "Ja. Relayium behält den relativen Pfad jeder Datei bei, einschließlich verschachtelter Unterordner, sodass der ankommende Ordner dasselbe Layout hat wie der ausgewählte.",
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
    "Choisissez un dossier entier dans le navigateur et envoyez-le en un lot — chemins relatifs conservés, jusqu'à 1 000 fichiers, chacun vérifié par SHA-256. Pas besoin de zipper au préalable.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Envoyer un projet, ce n'est pas comme envoyer un fichier : vous avez un dossier plein de sous-dossiers, et copier-coller chaque élément un par un détruit la structure qui le rend utile. Le zipper d'abord fonctionne, mais cela impose un détour par un outil de compression avant même de pouvoir commencer.",
    "Relayium vous laisse choisir un dossier directement et l'envoyer tel quel. Le navigateur parcourt toute l'arborescence, conserve le chemin relatif de chaque fichier, et le diffuse vers l'autre côté — que cela se termine en pair-à-pair sans rien stocker, ou en un lien que vous laissez pour plus tard.",
  ],
  sections: [
    {
      heading: "Choisir un dossier, pas un tas de fichiers",
      body: [
        "Plutôt que de sélectionner les fichiers un par un, choisissez le dossier lui-même. Relayium parcourt l'arborescence dans le navigateur et conserve le chemin relatif de chaque fichier — sous-dossiers, sous-dossiers imbriqués, tout — de sorte que ce qui arrive de l'autre côté a la même disposition que ce que vous avez envoyé.",
        "Cela fonctionne aujourd'hui sur Chrome, Edge et Firefox de bureau. Ça ne fonctionne pas sous iOS : le sélecteur de fichiers de Safari sur iPhone et iPad ne permet pas de choisir un dossier, seulement des fichiers individuels, donc l'envoi de dossier reste pour l'instant une fonctionnalité de bureau.",
      ],
      bullets: [
        "Jusqu'à 1 000 fichiers dans un seul lot.",
        "Chaque fichier est vérifié de bout en bout par sa propre empreinte SHA-256, pour que ce qui arrive corresponde exactement à ce que vous avez envoyé.",
        "Fonctionne par glisser-déposer ou via un bouton de sélection de dossier — rien à zipper au préalable.",
      ],
    },
    {
      heading: "Ce que l'autre personne reçoit",
      body: [
        "La façon dont le dossier arrive dépend du navigateur de réception. Chrome et Edge peuvent écrire les fichiers directement dans un répertoire choisi par le destinataire, si bien que le dossier apparaît sur le disque exactement tel qu'il est parti — sans étape supplémentaire.",
        "Firefox et Safari n'ont pas cette capacité ; ils reçoivent à la place une seule archive .zip non compressée (mode stockage) qui, une fois décompressée, redonne exactement la même structure de dossier. Elle reste sous 4 Gio (pas de ZIP64), ce qui couvre la grande majorité des dossiers de projet et des ensembles de photos ou documents — au-delà, répartissez l'envoi en deux.",
      ],
    },
    {
      heading: "En temps réel maintenant, ou un lien pour plus tard",
      body: [
        "Si vous pouvez être en ligne en même temps tous les deux, envoyez le dossier directement — il passe en pair-à-pair et rien n'est stocké sur un serveur entre les deux. C'est la voie la plus rapide et elle ne demande aucun compte sur le même réseau ; envoyer entre réseaux différents avec un code d'appairage exige seulement que l'expéditeur se connecte, et le destinataire n'a jamais besoin de compte.",
        "Si l'autre personne n'est pas disponible maintenant, créez plutôt un lien stocké. Votre navigateur chiffre les fichiers du dossier avant l'envoi avec une clé AES-256-GCM aléatoire qui ne vit que dans le lien lui-même, de sorte que le serveur conserve un texte chiffré qu'il ne peut pas lire. Créer un lien exige que l'expéditeur se connecte ; réglez son expiration à 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre, ou faites-le s'autodétruire après le premier téléchargement.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Puis-je envoyer un dossier depuis un iPhone ou un iPad ?",
        a: "Pas en tant qu'expéditeur — Safari sous iOS n'a pas de sélecteur de dossier, seulement des fichiers individuels, donc l'envoi de dossier fonctionne aujourd'hui depuis Chrome, Edge ou Firefox de bureau. Un iPhone ou un iPad peut tout à fait recevoir un dossier, sous forme de .zip.",
      },
      {
        q: "Les sous-dossiers et la structure des fichiers sont-ils conservés ?",
        a: "Oui. Relayium conserve le chemin relatif de chaque fichier, y compris les sous-dossiers imbriqués, de sorte que le dossier reçu a la même disposition que celui que vous avez choisi.",
      },
      {
        q: "Combien de fichiers un envoi de dossier peut-il contenir ?",
        a: "Jusqu'à 1 000 fichiers dans un seul lot, chacun vérifié individuellement par une empreinte SHA-256 à son arrivée.",
      },
      {
        q: "Le destinataire reçoit-il un vrai dossier ou un .zip ?",
        a: "Cela dépend de son navigateur. Chrome et Edge écrivent les fichiers directement dans un répertoire qu'il choisit. Firefox et Safari reçoivent une seule archive .zip non compressée (moins de 4 Gio) qui, une fois décompressée, redonne la même structure de dossier.",
      },
      {
        q: "Ai-je besoin d'un compte pour envoyer un dossier ?",
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
    "يتيح لك Relayium اختيار مجلد مباشرةً وإرساله كما هو. يجتاز المتصفح الشجرة كاملة، ويُبقي كل مسار نسبي سليمًا، ويبثّه إلى الجانب الآخر — سواء انتهى الأمر بنقل من الند للند دون تخزين أي شيء، أو برابط تتركه لوقت لاحق.",
  ],
  sections: [
    {
      heading: "اختر مجلدًا، لا كومة ملفات",
      body: [
        "بدلًا من اختيار الملفات واحدًا تلو الآخر، اختر المجلد نفسه. يجتاز Relayium شجرة الدليل في المتصفح ويُبقي المسار النسبي لكل ملف — المجلدات الفرعية، والمجلدات الفرعية المتداخلة، كلها — بحيث يكون لما يصل إلى الجانب الآخر نفس التخطيط الذي بدأت به.",
        "يعمل هذا اليوم في Chrome وEdge وFirefox على سطح المكتب. ولا يعمل على iOS: فمُنتقي الملفات في Safari على iPhone وiPad لا يملك طريقة لاختيار مجلد، بل ملفات فردية فقط، فإرسال المجلدات ميزة سطح مكتب في الوقت الحالي.",
      ],
      bullets: [
        "حتى 1,000 ملف في دفعة واحدة.",
        "يُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256 خاصة به، فما يصل يطابق تمامًا ما أرسلته.",
        "يعمل عبر السحب والإفلات أو زر منتقي المجلدات — لا حاجة إلى ضغط أي شيء أولًا.",
      ],
    },
    {
      heading: "ماذا يستلم الشخص الآخر",
      body: [
        "تعتمد كيفية وصول المجلد على المتصفح المستقبِل. يستطيع Chrome وEdge كتابة الملفات مباشرةً في دليل يختاره المُستقبِل، فيظهر المجلد على القرص تمامًا كما غادر — دون خطوة إضافية.",
        "لا يملك Firefox وSafari هذه القدرة، فيستلمان بدلًا من ذلك أرشيف .zip واحدًا بوضع التخزين فقط (دون ضغط) يُفكّ إلى نفس بنية المجلد بالضبط. ويبقى دون 4 GiB (لا دعم لـ ZIP64)، وهو ما يغطّي الغالبية العظمى من مجلدات المشاريع ومجموعات الصور أو المستندات — ولأي شيء أكبر، قسّمه إلى إرسالين.",
      ],
    },
    {
      heading: "فوريًا، أو رابط لوقت لاحق",
      body: [
        "إن أمكنكما أن تكونا متصلين في الوقت نفسه، أرسِل المجلد مباشرةً — يمرّ من الند للند ولا يُخزَّن شيء على أي خادم بينكما. هذا المسار الأسرع ولا يحتاج إلى حساب إن كنتما على نفس الشبكة؛ أما الإرسال عبر الشبكات برمز اقتران فيتطلب فقط أن يسجّل المُرسِل الدخول، والمُستقبِل لا يحتاج أبدًا إلى حساب على الإطلاق.",
        "إن لم يكن الشخص الآخر متاحًا الآن، فأنشئ رابطًا مُخزَّنًا بدلًا من ذلك. يشفّر متصفحك ملفات المجلد قبل الرفع بمفتاح AES-256-GCM عشوائي لا يعيش إلا في الرابط نفسه، فيحمل الخادم نصًا مُشفَّرًا لا يستطيع قراءته. يتطلب إنشاء رابط أن يسجّل المُرسِل الدخول؛ اضبطه لينتهي بعد ساعة واحدة، أو يوم واحد، أو 3 أيام، أو 7 أيام، أو حتى 14 يومًا حسب خطتك، أو اجعله يحترق بعد أول تنزيل.",
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
        a: "نعم. يُبقي Relayium المسار النسبي لكل ملف، بما في ذلك المجلدات الفرعية المتداخلة، فيكون للمجلد الواصل نفس تخطيط الذي اخترته.",
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
    "Relayium te deja elegir una carpeta directamente y enviarla tal cual. El navegador recorre todo el árbol, mantiene intacta cada ruta relativa y la transmite al otro lado — tanto si acaba siendo de igual a igual sin nada almacenado, como un enlace que puedes dejar para más tarde.",
  ],
  sections: [
    {
      heading: "Elige una carpeta, no un montón de archivos",
      body: [
        "En lugar de seleccionar los archivos uno por uno, elige la carpeta en sí. Relayium recorre el árbol de directorios en el navegador y conserva la ruta relativa de cada archivo — subcarpetas, subcarpetas anidadas, todo — para que lo que llega al otro extremo tenga la misma disposición con la que empezaste.",
        "Esto funciona hoy en Chrome, Edge y Firefox de escritorio. No funciona en iOS: el selector de archivos de Safari en iPhone y iPad no tiene forma de seleccionar una carpeta, solo archivos individuales, así que el envío de carpetas es de momento una función de escritorio.",
      ],
      bullets: [
        "Hasta 1.000 archivos en un solo lote.",
        "Cada archivo se verifica de extremo a extremo con su propio hash SHA-256, para que lo que llega coincida exactamente con lo que enviaste.",
        "Funciona por arrastrar y soltar o con un botón de selección de carpeta — sin necesidad de comprimir nada antes.",
      ],
    },
    {
      heading: "Qué recibe la otra persona",
      body: [
        "Cómo llega la carpeta depende del navegador que recibe. Chrome y Edge pueden escribir los archivos directamente en un directorio que elija el destinatario, así que la carpeta aparece en el disco exactamente como salió — sin paso extra.",
        "Firefox y Safari no tienen esa capacidad, así que en su lugar reciben un único archivo .zip sin comprimir (modo almacenamiento) que se descomprime en la misma estructura de carpetas exacta. Se mantiene por debajo de 4 GiB (sin soporte de ZIP64), lo que cubre la inmensa mayoría de carpetas de proyecto y conjuntos de fotos o documentos — para algo más grande, divídelo en dos envíos.",
      ],
    },
    {
      heading: "En tiempo real, o un enlace para más tarde",
      body: [
        "Si ambos podéis estar en línea a la vez, envía la carpeta directamente — va de igual a igual y nada se almacena en ningún servidor por el camino. Esta es la vía más rápida y no necesita cuenta si estáis en la misma red; enviar entre redes con un código de emparejamiento solo requiere que el remitente inicie sesión, y quien recibe nunca necesita cuenta en absoluto.",
        "Si la otra persona no está disponible ahora mismo, crea en su lugar un enlace almacenado. Tu navegador cifra los archivos de la carpeta antes de subirlos con una clave AES-256-GCM aleatoria que solo vive en el propio enlace, de modo que el servidor guarda texto cifrado que no puede leer. Crear un enlace requiere que el remitente inicie sesión; configúralo para que caduque en 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o haz que se destruya tras la primera descarga.",
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
        a: "Sí. Relayium conserva la ruta relativa de cada archivo, incluidas las subcarpetas anidadas, así que la carpeta que llega tiene la misma disposición que la que elegiste.",
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
    "O Relayium deixa você escolher uma pasta diretamente e enviá-la como está. O navegador percorre toda a árvore, mantém cada caminho relativo intacto e a transmite para o outro lado — seja acabando em ponto a ponto sem nada armazenado, seja como um link que você deixa para depois.",
  ],
  sections: [
    {
      heading: "Escolha uma pasta, não uma pilha de arquivos",
      body: [
        "Em vez de selecionar os arquivos um a um, escolha a própria pasta. O Relayium percorre a árvore de diretórios no navegador e mantém o caminho relativo de cada arquivo — subpastas, subpastas aninhadas, tudo — para que o que chega do outro lado tenha o mesmo layout com que você começou.",
        "Isso funciona hoje no Chrome, Edge e Firefox de desktop. Não funciona no iOS: o seletor de arquivos do Safari no iPhone e no iPad não tem como selecionar uma pasta, apenas arquivos individuais, então o envio de pastas é, por enquanto, um recurso de desktop.",
      ],
      bullets: [
        "Até 1.000 arquivos em um único lote.",
        "Cada arquivo é verificado de ponta a ponta com o seu próprio hash SHA-256, para que o que chega corresponda exatamente ao que você enviou.",
        "Funciona por arrastar e soltar ou por um botão de seleção de pasta — sem precisar compactar nada antes.",
      ],
    },
    {
      heading: "O que a outra pessoa recebe",
      body: [
        "Como a pasta chega depende do navegador que recebe. Chrome e Edge podem gravar os arquivos direto em um diretório que o destinatário escolhe, então a pasta aparece no disco exatamente como saiu — sem passo extra.",
        "Firefox e Safari não têm essa capacidade, então recebem em vez disso um único arquivo .zip sem compressão (modo armazenamento) que, ao ser descompactado, resulta na mesma estrutura de pasta exata. Ele fica abaixo de 4 GiB (sem suporte a ZIP64), o que cobre a grande maioria das pastas de projeto e conjuntos de fotos ou documentos — para algo maior, divida em dois envios.",
      ],
    },
    {
      heading: "Em tempo real, ou um link para depois",
      body: [
        "Se vocês dois puderem estar on-line ao mesmo tempo, envie a pasta diretamente — ela vai ponto a ponto e nada é armazenado em nenhum servidor no meio. Este é o caminho mais rápido e não precisa de conta se vocês estão na mesma rede; enviar entre redes com um código de emparelhamento só exige que o remetente faça login, e quem recebe nunca precisa de conta alguma.",
        "Se a outra pessoa não estiver por perto agora, crie um link armazenado em vez disso. Seu navegador criptografa os arquivos da pasta antes do upload com uma chave AES-256-GCM aleatória que só existe no próprio link, de modo que o servidor guarda texto cifrado que não consegue ler. Criar um link exige que o remetente faça login; defina para expirar em 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou faça-o se autodestruir após o primeiro download.",
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
        a: "Sim. O Relayium mantém o caminho relativo de cada arquivo, incluindo subpastas aninhadas, então a pasta que chega tem o mesmo layout da que você escolheu.",
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
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
