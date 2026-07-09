// web/scripts/pages/content/articles/howto-mac-to-windows.mjs
// How-to: transfer files between a Mac and a Windows PC. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n/en.ts and content/articles/howto-android-to-iphone.mjs.

const en = {
  title: "Transfer files between a Mac and a Windows PC",
  description:
    "How to send files between macOS and Windows without a flash drive, a shared network folder, or a cloud upload. Both same network and over the internet — nothing to install on either machine.",
  updatedLabel: "Last updated",
  lead: [
    "Macs and PCs don't speak the same file-sharing language out of the box. AirDrop is Apple-only, Windows' network sharing wants both machines on a matching workgroup or domain, and neither one is exactly friendly to set up in five minutes when you just want to move one folder of project files from a MacBook to a Windows desktop.",
    "Relayium sidesteps the whole compatibility question. Open the same page in a browser on the Mac and on the Windows PC, and the files travel directly between them — end-to-end encrypted, nothing to install on either operating system. On the same network no account is needed at all; sending across the internet with a pairing code only asks the sender to sign in. Here's exactly how it works in both directions.",
  ],
  sections: [
    {
      heading: "What you need before you start",
      body: [
        "Nothing to install on the Mac or the PC. On the same network there is nothing to sign up for either — the browser handles everything.",
      ],
      bullets: [
        "A Mac with Safari or Chrome, and a Windows PC with Edge or Chrome — any modern browser on either side.",
        "For the simplest path, connect both machines to the same Wi-Fi or Ethernet network. If they're in different places, a pairing code bridges the gap instead.",
        "The files or folders to send — up to 1,000 files per batch.",
      ],
    },
    {
      heading: "Mac and PC on the same network",
      body: [
        "If both computers are on the same office or home network, this is the fastest way to move files — no shared drive to mount, no permissions to fight with.",
      ],
      bullets: [
        "On the Mac, open relayium.com in the browser. On the Windows PC, open the same address.",
        "Each machine appears as a nearby device to the other — no Windows workgroup setup, no macOS file sharing to enable.",
        "On the sending computer, tap the other one, then pick the files (or a whole folder) to send.",
        "Both screens show the same short verification code. Check that it matches on both — that confirms the connection is direct between your two machines, not routed through anything in between.",
        "Accept on the receiving side and the transfer starts immediately, streaming straight to disk.",
      ],
    },
    {
      heading: "Mac and PC on different networks",
      body: [
        "Working from home while the other machine is in the office, or just on a different Wi-Fi network? A pairing code connects a Mac and a Windows PC across the internet, not just across the room.",
        "The sending computer generates a short pairing code (or a share link); enter it on the other machine to connect. The transfer still goes directly peer-to-peer whenever a direct path is possible, and falls back to an encrypted TURN relay — which only ever sees ciphertext — when it isn't. If the connection drops partway through a large folder, it resumes instead of starting over. This mode needs the sender to sign in; whoever is receiving never needs an account.",
      ],
    },
    {
      heading: "Sending a whole folder, not just single files",
      body: [
        "Moving a project folder from Mac to Windows (or back) usually means zipping it first. Relayium can send a folder directly, keeping its structure intact.",
      ],
      bullets: [
        "On the Mac, drag a folder in, or pick one from the file dialog — up to 1,000 files in the batch.",
        "On a Windows PC using Edge or Chrome, the incoming folder is written straight into a directory you choose, structure preserved.",
        "If the receiving browser doesn't support writing folders directly, the folder arrives as a single .zip that unpacks to the same layout.",
      ],
    },
    {
      heading: "Other ways to move files between Mac and Windows",
      body: [
        "Relayium isn't the only option — here are the honest trade-offs of the usual alternatives:",
      ],
      bullets: [
        "A USB flash drive works offline, but macOS and Windows don't always agree on a filesystem without reformatting, and it's one more physical object to keep track of.",
        "Windows network sharing (SMB) can reach a Mac, but setting up workgroups, permissions, and firewall rules for a one-time transfer is more setup than the transfer is worth.",
        "A cloud drive (OneDrive, iCloud, Google Drive) works when the other person is offline, but the file gets uploaded and then downloaded, counts against your storage quota, and the provider keeps a copy.",
        "Email and chat apps are convenient but usually cap attachment size and aren't end-to-end encrypted for file sharing.",
      ],
    },
    {
      heading: "Will anything about the files change?",
      body: [
        "No. Relayium transfers the original bytes exactly as they are — no re-compression, no reformatting, no line-ending or filename changes between the two operating systems.",
        "Every file is checked end-to-end with a SHA-256 hash, so what lands on the Windows PC (or the Mac) is verified identical to what left the other machine. Large files are handled well too: Chrome and Edge stream the download straight to disk with no size cap, while Firefox and Safari buffer in memory, so on those keep a single transfer under roughly 200 MB.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Do I need to install anything on the Mac or the Windows PC?",
        a: "No. Relayium runs entirely in the browser on both macOS and Windows. Open relayium.com on each machine and you're ready — nothing to download either way. On the same network a transfer needs no account at all; pairing across the internet only asks the sender to sign in.",
      },
      {
        q: "Do both computers have to be on the same network?",
        a: "No. Being on the same network is the fastest path because the two machines find each other automatically, but a pairing code connects a Mac and a Windows PC across the internet just as well — even from different cities. Either way the transfer stays end-to-end encrypted; the cross-network route just asks the sender to sign in first, and the receiver never needs an account.",
      },
      {
        q: "Can I send a whole folder, not just individual files?",
        a: "Yes. Drag in a folder and Relayium sends up to 1,000 files in the batch, preserving the folder structure. Chrome and Edge on Windows write it straight into a chosen directory; if the receiving browser can't write folders directly, it arrives as a single .zip with the same layout.",
      },
      {
        q: "Will file permissions, line endings, or filenames get mangled crossing from Mac to Windows?",
        a: "No. Relayium moves the exact bytes of each file and verifies them with a SHA-256 hash end-to-end — it doesn't touch line endings, encoding, or filenames. Anything an application-level conversion would need to handle (like CRLF vs LF in a text file) is unchanged because the file itself is unchanged.",
      },
      {
        q: "Is there a size limit?",
        a: "Up to 1,000 files per batch. There's no server-side size cap for a direct transfer — Chrome and Edge stream straight to disk — but Firefox and Safari buffer in memory, so keep individual transfers on those under about 200 MB.",
      },
    ],
  },
  cta: {
    text: "Open Relayium on your Mac and your Windows PC and move your first files across — no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "如何在 Mac 和 Windows 电脑之间传输文件",
  description:
    "在 macOS 和 Windows 之间传文件，不用 U 盘、不用共享文件夹、不用上传网盘。同一网络和跨互联网都能用——两台电脑都无需安装任何东西。",
  updatedLabel: "最近更新",
  lead: [
    "Mac 和 PC 天生就不说同一种文件共享语言。AirDrop 只属于苹果生态，Windows 的网络共享又要求两台机器加入匹配的工作组或域，两者都不是那种能在五分钟内搞定的东西——而你可能只是想把 MacBook 上一个项目文件夹搬到 Windows 台式机上。",
    "Relayium 绕开了这整套兼容性难题。在 Mac 和 Windows 电脑的浏览器里打开同一个页面，文件就在它们之间直接传输——端到端加密，两个系统都无需安装任何东西。同一网络下完全不用账号；跨互联网用配对码发送时只需发送方登录一下。下面详细说明两个方向的具体做法。",
  ],
  sections: [
    {
      heading: "开始前需要准备什么",
      body: ["Mac 和 PC 都不用安装。同一网络下也不用注册——浏览器搞定一切。"],
      bullets: [
        "一台用 Safari 或 Chrome 的 Mac，一台用 Edge 或 Chrome 的 Windows PC——任意一侧用现代浏览器即可。",
        "最简单的方式是把两台电脑接入同一个 Wi-Fi 或有线网络。如果它们不在同一处，配对码同样能连接起来。",
        "要发送的文件或文件夹——每批最多 1,000 个文件。",
      ],
    },
    {
      heading: "Mac 和 PC 在同一网络下",
      body: [
        "如果两台电脑在同一个办公室或家庭网络中，这是移动文件最快的方式——不用挂载共享盘，也不用跟权限较劲。",
      ],
      bullets: [
        "在 Mac 上，用浏览器打开 relayium.com；在 Windows PC 上，打开同一个地址。",
        "两台机器会互相显示为附近的设备——不用设置 Windows 工作组，也不用开启 macOS 文件共享。",
        "在发送方电脑上点击另一台，然后选择要发送的文件（或整个文件夹）。",
        "两边屏幕会显示同一段简短的校验码。核对两边是否一致——这能确认连接是在你的两台机器之间直连的，没有经过中间的任何环节。",
        "在接收方确认接收，传输立即开始，直接流式写入磁盘。",
      ],
    },
    {
      heading: "Mac 和 PC 不在同一网络",
      body: [
        "在家办公而另一台机器在办公室，或者只是连在不同的 Wi-Fi 上？配对码能让 Mac 和 Windows PC 跨越互联网连接，而不仅仅是跨越房间。",
        "发送方电脑会生成一段简短的配对码（或一个分享链接）；在另一台机器上输入即可连接。只要条件允许，传输依然点对点直连；当无法直连时，会退回到加密的 TURN 中继——中继只能看到密文。如果传输一个大文件夹时连接中途断开，可以续传而不必从头再来。这种方式需要发送方登录；接收方始终无需账号。",
      ],
    },
    {
      heading: "发送整个文件夹，而不只是单个文件",
      body: [
        "把一个项目文件夹从 Mac 搬到 Windows（或反过来）通常得先打包压缩。Relayium 可以直接发送文件夹，并保持其结构完整。",
      ],
      bullets: [
        "在 Mac 上，直接把文件夹拖进去，或从文件选择器中选取——一批最多 1,000 个文件。",
        "在使用 Edge 或 Chrome 的 Windows PC 上，收到的文件夹会直接写入你选择的目录，结构保持不变。",
        "如果接收方的浏览器不支持直接写入文件夹，文件夹会以单个 .zip 的形式到达，解压后结构相同。",
      ],
    },
    {
      heading: "在 Mac 和 Windows 之间传文件的其他方式",
      body: ["Relayium 不是唯一选择——以下是常见备选方案诚实的取舍："],
      bullets: [
        "U 盘可以离线使用，但 macOS 和 Windows 在文件系统上并不总是兼容，可能需要重新格式化，而且多了一个要随身携带的实物。",
        "Windows 网络共享（SMB）可以连到 Mac，但为了一次性的传输去配置工作组、权限和防火墙规则，付出远超收益。",
        "网盘（OneDrive、iCloud、Google Drive）在对方离线时也能用，但文件要先上传再下载，占用你的存储配额，且服务商手里留有一份副本。",
        "邮件和聊天软件很方便，但通常会限制附件大小，且文件分享并非端到端加密。",
      ],
    },
    {
      heading: "文件会有任何改变吗？",
      body: [
        "不会。Relayium 按原始字节精确传输——不重新压缩、不重新格式化，两个系统之间也不会改动换行符或文件名。",
        "每个文件都用 SHA-256 做端到端校验，所以落到 Windows PC（或 Mac）上的内容，经验证与从另一台机器发出的完全一致。大文件也处理得很好：Chrome 和 Edge 会直接把下载流式写入磁盘，没有大小上限；而 Firefox 和 Safari 在内存中缓冲，所以在这两者上单次传输建议控制在约 200 MB 以内。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Mac 或 Windows PC 上需要安装什么吗？",
        a: "不需要。Relayium 在 macOS 和 Windows 上都完全运行于浏览器中。在每台机器上打开 relayium.com 就绪了——无论哪种方式都不用下载。同一网络下传输完全无需账号；跨互联网配对只需发送方登录一下。",
      },
      {
        q: "两台电脑必须在同一网络吗？",
        a: "不必。同一网络是最快的方式，因为两台机器会自动互相发现；但配对码同样能让 Mac 和 Windows PC 跨越互联网连接——即使身处不同城市。无论哪种方式传输都保持端到端加密；跨网络路径只是需要发送方先登录，接收方始终无需账号。",
      },
      {
        q: "能发送整个文件夹，而不只是单个文件吗？",
        a: "可以。把文件夹拖进去，Relayium 会以一批最多 1,000 个文件发送，并保持文件夹结构。Windows 上的 Chrome 和 Edge 会直接写入你选择的目录；如果接收方浏览器不支持直接写入文件夹，会以单个 .zip 到达，结构相同。",
      },
      {
        q: "从 Mac 传到 Windows，文件权限、换行符或文件名会被弄乱吗？",
        a: "不会。Relayium 传输的是每个文件的精确字节，并用 SHA-256 哈希做端到端校验——不会触碰换行符、编码或文件名。任何需要应用层转换处理的东西（比如文本文件里 CRLF 和 LF 的区别）都不受影响，因为文件本身没有被改动。",
      },
      {
        q: "有大小限制吗？",
        a: "每批最多 1,000 个文件。直连传输没有服务器端的大小上限——Chrome 和 Edge 会直接流式写入磁盘——但 Firefox 和 Safari 在内存中缓冲，所以在这两者上单次传输建议控制在约 200 MB 以内。",
      },
    ],
  },
  cta: {
    text: "在你的 Mac 和 Windows PC 上打开 Relayium，把第一批文件传过去吧——无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Mac と Windows パソコン間でファイルを転送する方法",
  description:
    "USB メモリも共有フォルダもクラウドへのアップロードも使わずに、macOS と Windows の間でファイルを送る方法。同じネットワークでもインターネット越しでも、どちらの端末にもインストール不要です。",
  updatedLabel: "最終更新",
  lead: [
    "Mac と PC は、そのままではファイル共有の言葉が違います。AirDrop は Apple 専用、Windows のネットワーク共有は両方の端末が一致するワークグループやドメインに入っている必要があり、どちらも5分でさっと設定できるものではありません——MacBook 上のプロジェクトフォルダを1つ、Windows デスクトップに移したいだけなのに。",
    "Relayium はその互換性の問題をまるごと回避します。Mac と Windows パソコンのブラウザで同じページを開けば、ファイルはその間で直接転送されます——エンドツーエンド暗号化、どちらの OS にもインストール不要です。同じネットワークならアカウントすら不要で、ペアリングコードでインターネット越しに送る場合も送信側がサインインするだけです。以下、両方向の具体的な手順を説明します。",
  ],
  sections: [
    {
      heading: "始める前に必要なもの",
      body: [
        "Mac にも PC にもインストールは不要です。同じネットワークなら登録も不要——ブラウザがすべて処理します。",
      ],
      bullets: [
        "Safari か Chrome を使う Mac と、Edge か Chrome を使う Windows パソコン——どちらも最新のブラウザで構いません。",
        "最もシンプルな方法は、両方の端末を同じ Wi-Fi または有線ネットワークに接続することです。別々の場所にあっても、ペアリングコードでつなげます。",
        "送りたいファイルまたはフォルダ——1バッチあたり最大1,000ファイル。",
      ],
    },
    {
      heading: "Mac と PC が同じネットワークにある場合",
      body: [
        "両方のパソコンが同じオフィスや自宅のネットワークにあれば、これがファイルを移す最速の方法です——共有ドライブをマウントする必要も、権限で苦労する必要もありません。",
      ],
      bullets: [
        "Mac でブラウザから relayium.com を開きます。Windows パソコンでも同じアドレスを開きます。",
        "各端末はもう一方に近くの端末として表示されます——Windows のワークグループ設定も、macOS のファイル共有を有効にする必要もありません。",
        "送信側のパソコンでもう一方をタップし、送るファイル（またはフォルダ丸ごと）を選びます。",
        "両方の画面に同じ短い検証コードが表示されます。両方で一致するか確認してください——これは接続が2台のパソコンの間で直接行われており、途中で何も経由していないことを確認するものです。",
        "受信側で承認すると転送がすぐに始まり、ディスクへ直接ストリーミングされます。",
      ],
    },
    {
      heading: "Mac と PC が異なるネットワークにある場合",
      body: [
        "自宅から作業していて、もう一方のパソコンはオフィスにある、あるいは単に別の Wi-Fi につながっている——そんなときも、ペアリングコードは Mac と Windows パソコンを部屋を越えるだけでなく、インターネット越しにつなげます。",
        "送信側のパソコンが短いペアリングコード（または共有リンク）を生成するので、もう一方の端末で入力して接続します。可能な限り転送は引き続き P2P で直接行われ、直接の経路がない場合は暗号化された TURN リレーにフォールバックしますが、リレーが見るのは暗号文だけです。大きなフォルダの転送中に接続が切れても、最初からではなく再開できます。この方式には送信側のサインインが必要です。受信側はアカウント不要です。",
      ],
    },
    {
      heading: "個々のファイルだけでなく、フォルダ丸ごと送る",
      body: [
        "プロジェクトフォルダを Mac から Windows へ（あるいはその逆）移すには、通常まず ZIP 化が必要です。Relayium ならフォルダをそのまま、構造を保ったまま送信できます。",
      ],
      bullets: [
        "Mac では、フォルダをドラッグして入れるか、ファイル選択ダイアログから選びます——1バッチ最大1,000ファイル。",
        "Edge か Chrome を使う Windows パソコンでは、届いたフォルダが選んだディレクトリへ構造そのままで直接書き込まれます。",
        "受信側のブラウザがフォルダの直接書き込みに対応していない場合、フォルダは同じ構造に展開できる単一の .zip として届きます。",
      ],
    },
    {
      heading: "Mac と Windows の間でファイルを移す他の方法",
      body: ["Relayium だけが選択肢ではありません。よくある代替手段の正直なトレードオフです。"],
      bullets: [
        "USB メモリはオフラインで使えますが、macOS と Windows はファイルシステムで必ずしも一致せず、再フォーマットが必要になることがあり、持ち運ぶ物がもう1つ増えます。",
        "Windows のネットワーク共有（SMB）は Mac にも届きますが、一度きりの転送のためにワークグループや権限、ファイアウォールのルールを設定するのは、転送そのものより手間がかかります。",
        "クラウドドライブ（OneDrive、iCloud、Google ドライブ）は相手がオフラインでも使えますが、ファイルはアップロードされてからダウンロードされ、容量を消費し、提供元がコピーを保持します。",
        "メールやチャットアプリは便利ですが、たいてい添付サイズを制限し、ファイル共有はエンドツーエンド暗号化されていません。",
      ],
    },
    {
      heading: "ファイルに何か変化はありますか？",
      body: [
        "ありません。Relayium は元のバイトをそのまま正確に転送します——再圧縮も再フォーマットもなく、2つの OS の間で改行コードやファイル名が変わることもありません。",
        "各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されるので、Windows パソコン（または Mac）に届くものは、もう一方の端末から送られたものと同一であることが確認されます。大きなファイルもうまく扱えます。Chrome と Edge ではダウンロードがサイズ上限なしでそのままディスクにストリーミングされ、Firefox と Safari はメモリにバッファするため、その2つでは1回の転送を約200MB以内に抑えてください。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Mac や Windows パソコンに何かインストールする必要がありますか？",
        a: "いいえ。Relayium は macOS でも Windows でもすべてブラウザで動作します。各端末で relayium.com を開けば準備完了です——どちらの方法でもダウンロードは不要です。同じネットワークなら転送にアカウントは一切不要で、インターネット越しのペアリングも送信側がサインインするだけです。",
      },
      {
        q: "両方のパソコンが同じネットワークにある必要がありますか？",
        a: "いいえ。同じネットワークは2台の端末が自動的に互いを見つけるため最速の方法ですが、ペアリングコードなら Mac と Windows パソコンを異なる都市にあってもインターネット越しに接続できます。どちらの場合も転送はエンドツーエンド暗号化のままです。ネットワークをまたぐ経路は送信側が先にサインインするだけで、受信側はアカウント不要です。",
      },
      {
        q: "個々のファイルだけでなく、フォルダ丸ごと送れますか？",
        a: "はい。フォルダをドラッグして入れれば、Relayium は1バッチ最大1,000ファイルを送信し、フォルダ構造を保ちます。Windows の Chrome と Edge は選んだディレクトリへ直接書き込みます。受信側のブラウザがフォルダの直接書き込みに対応していない場合は、同じ構造の単一の .zip として届きます。",
      },
      {
        q: "Mac から Windows に渡ると、ファイル権限や改行コード、ファイル名が崩れませんか？",
        a: "崩れません。Relayium は各ファイルの正確なバイトを移動し、SHA-256 ハッシュでエンドツーエンドに検証します——改行コード、エンコーディング、ファイル名には一切触れません。アプリケーション側の変換が必要になるようなもの（テキストファイルの CRLF と LF の違いなど）は、ファイル自体が変更されないため影響を受けません。",
      },
      {
        q: "サイズに制限はありますか？",
        a: "1バッチあたり最大1,000ファイルです。直接転送にサーバー側のサイズ上限はありません——Chrome と Edge はそのままディスクへストリーミングします——ただし Firefox と Safari はメモリにバッファするため、その2つでは1回の転送を約200MB以内に抑えてください。",
      },
    ],
  },
  cta: {
    text: "Mac と Windows パソコンの両方で Relayium を開いて、最初のファイルを送ってみましょう——インストール不要、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Mac와 Windows PC 사이에서 파일 전송하는 방법",
  description:
    "USB 드라이브도, 공유 폴더도, 클라우드 업로드도 없이 macOS와 Windows 사이에서 파일을 보내는 방법. 같은 네트워크에서도 인터넷 너머로도 가능하며, 두 운영체제 모두 설치할 것이 없습니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Mac과 PC는 기본적으로 같은 파일 공유 언어를 쓰지 않습니다. AirDrop은 애플 전용이고, Windows의 네트워크 공유는 두 기기가 일치하는 작업 그룹이나 도메인에 있어야 하는데, 둘 다 5분 만에 뚝딱 설정할 수 있는 것이 아닙니다 — MacBook의 프로젝트 폴더 하나를 Windows 데스크톱으로 옮기고 싶을 뿐인데도 말이죠.",
    "Relayium은 이 호환성 문제 전체를 우회합니다. Mac과 Windows PC의 브라우저에서 같은 페이지를 열면 파일이 그 사이에서 직접 전송됩니다 — 종단간 암호화, 두 운영체제 모두 설치할 것이 없습니다. 같은 네트워크에서는 계정조차 필요 없고, 페어링 코드로 인터넷 너머로 보낼 때도 보내는 쪽이 로그인만 하면 됩니다. 아래에서 양방향의 정확한 방법을 설명합니다.",
  ],
  sections: [
    {
      heading: "시작하기 전에 필요한 것",
      body: [
        "Mac이나 PC 어느 쪽에도 설치할 것이 없습니다. 같은 네트워크에서는 가입할 것도 없습니다 — 브라우저가 모든 걸 처리합니다.",
      ],
      bullets: [
        "Safari나 Chrome을 쓰는 Mac과 Edge나 Chrome을 쓰는 Windows PC — 어느 쪽이든 최신 브라우저면 됩니다.",
        "가장 간단한 방법은 두 기기를 같은 Wi-Fi나 유선 네트워크에 연결하는 것입니다. 서로 다른 장소에 있어도 페어링 코드로 이어줄 수 있습니다.",
        "보내려는 파일이나 폴더 — 배치당 최대 1,000개 파일.",
      ],
    },
    {
      heading: "Mac과 PC가 같은 네트워크에 있을 때",
      body: [
        "두 컴퓨터가 같은 사무실이나 가정 네트워크에 있다면, 이것이 파일을 옮기는 가장 빠른 방법입니다 — 공유 드라이브를 마운트할 필요도, 권한과 씨름할 필요도 없습니다.",
      ],
      bullets: [
        "Mac에서 브라우저로 relayium.com을 엽니다. Windows PC에서도 같은 주소를 엽니다.",
        "각 기기가 상대에게 근처 기기로 나타납니다 — Windows 작업 그룹 설정도, macOS 파일 공유 활성화도 필요 없습니다.",
        "보내는 컴퓨터에서 다른 쪽을 탭한 다음, 보낼 파일(또는 폴더 전체)을 고릅니다.",
        "양쪽 화면에 같은 짧은 검증 코드가 표시됩니다. 양쪽이 일치하는지 확인하세요 — 이는 두 컴퓨터 사이의 연결이 직접적이며 중간에 아무것도 거치지 않았음을 확인해 줍니다.",
        "받는 쪽에서 수락하면 전송이 즉시 시작되어 디스크로 곧바로 스트리밍됩니다.",
      ],
    },
    {
      heading: "Mac과 PC가 다른 네트워크에 있을 때",
      body: [
        "집에서 작업 중인데 다른 컴퓨터는 사무실에 있거나, 그냥 다른 Wi-Fi에 연결되어 있나요? 페어링 코드는 Mac과 Windows PC를 방을 넘어서뿐 아니라 인터넷 너머로도 연결해 줍니다.",
        "보내는 컴퓨터가 짧은 페어링 코드(또는 공유 링크)를 생성하면, 다른 기기에서 입력해 연결합니다. 직접 경로가 가능한 한 전송은 여전히 P2P로 직접 이루어지고, 그렇지 않으면 암호화된 TURN 릴레이로 폴백하는데, 릴레이는 암호문만 볼 수 있습니다. 큰 폴더를 전송하다가 중간에 연결이 끊겨도 처음부터가 아니라 이어서 재개됩니다. 이 방식은 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 계정이 필요 없습니다.",
      ],
    },
    {
      heading: "개별 파일뿐 아니라 폴더 전체 보내기",
      body: [
        "프로젝트 폴더를 Mac에서 Windows로(또는 반대로) 옮기려면 보통 먼저 압축해야 합니다. Relayium은 폴더를 구조 그대로 유지하며 직접 보낼 수 있습니다.",
      ],
      bullets: [
        "Mac에서는 폴더를 끌어다 놓거나 파일 선택 창에서 고릅니다 — 배치당 최대 1,000개 파일.",
        "Edge나 Chrome을 쓰는 Windows PC에서는 들어오는 폴더가 선택한 디렉터리에 구조 그대로 곧바로 기록됩니다.",
        "받는 쪽 브라우저가 폴더를 직접 기록하는 기능을 지원하지 않으면, 폴더는 같은 구조로 풀리는 단일 .zip으로 도착합니다.",
      ],
    },
    {
      heading: "Mac과 Windows 사이에서 파일을 옮기는 다른 방법",
      body: ["Relayium만이 선택지는 아닙니다 — 흔한 대안들의 솔직한 절충점입니다:"],
      bullets: [
        "USB 드라이브는 오프라인에서 쓸 수 있지만, macOS와 Windows가 파일 시스템에서 항상 맞지는 않아 재포맷이 필요할 수 있고, 챙겨야 할 물건이 하나 더 생깁니다.",
        "Windows 네트워크 공유(SMB)는 Mac에도 닿지만, 일회성 전송을 위해 작업 그룹, 권한, 방화벽 규칙을 설정하는 건 전송 자체보다 손이 더 갑니다.",
        "클라우드 드라이브(OneDrive, iCloud, Google 드라이브)는 상대가 오프라인이어도 되지만, 파일을 올렸다가 다시 내려받게 되고, 저장 용량을 차지하며, 제공자가 사본을 보관합니다.",
        "이메일과 채팅 앱은 편리하지만 보통 첨부 크기를 제한하고, 파일 공유는 종단간 암호화가 아닙니다.",
      ],
    },
    {
      heading: "파일에 뭔가 바뀌는 게 있나요?",
      body: [
        "없습니다. Relayium은 원본 바이트를 있는 그대로 정확히 전송합니다 — 재압축도, 재포맷도 없고, 두 운영체제 사이에서 줄바꿈이나 파일명이 바뀌지도 않습니다.",
        "각 파일은 SHA-256 해시로 종단간 검증되므로, Windows PC(또는 Mac)에 도착한 것은 다른 쪽 컴퓨터에서 나간 것과 동일함이 확인됩니다. 큰 파일도 잘 처리됩니다. Chrome과 Edge는 크기 제한 없이 다운로드를 곧바로 디스크로 스트리밍하고, Firefox와 Safari는 메모리에 버퍼링하므로 그 둘에서는 한 번의 전송을 약 200MB 이내로 유지하세요.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Mac이나 Windows PC에 뭔가 설치해야 하나요?",
        a: "아니요. Relayium은 macOS와 Windows 모두에서 전적으로 브라우저에서 동작합니다. 각 기기에서 relayium.com을 열면 준비 끝입니다 — 어느 쪽이든 다운로드는 필요 없습니다. 같은 네트워크에서는 전송에 계정이 전혀 필요 없고, 인터넷 너머 페어링도 보내는 쪽이 로그인만 하면 됩니다.",
      },
      {
        q: "두 컴퓨터가 반드시 같은 네트워크에 있어야 하나요?",
        a: "아니요. 같은 네트워크는 두 기기가 자동으로 서로를 찾기 때문에 가장 빠르지만, 페어링 코드는 서로 다른 도시에 있는 Mac과 Windows PC도 인터넷 너머로 똑같이 연결해 줍니다. 어느 쪽이든 전송은 종단간 암호화를 유지합니다. 네트워크를 넘는 경로는 보내는 쪽이 먼저 로그인하기만 하면 되고, 받는 쪽은 계정이 필요 없습니다.",
      },
      {
        q: "개별 파일뿐 아니라 폴더 전체를 보낼 수 있나요?",
        a: "네. 폴더를 끌어다 놓으면 Relayium이 배치당 최대 1,000개 파일을 폴더 구조를 유지하며 보냅니다. Windows의 Chrome과 Edge는 선택한 디렉터리에 곧바로 기록합니다. 받는 쪽 브라우저가 폴더를 직접 기록하지 못하면, 같은 구조의 단일 .zip으로 도착합니다.",
      },
      {
        q: "Mac에서 Windows로 넘어갈 때 파일 권한, 줄바꿈, 파일명이 망가지나요?",
        a: "아니요. Relayium은 각 파일의 정확한 바이트를 옮기고 SHA-256 해시로 종단간 검증합니다 — 줄바꿈, 인코딩, 파일명은 건드리지 않습니다. 애플리케이션 수준의 변환이 필요할 만한 것(텍스트 파일의 CRLF와 LF 차이 등)도 파일 자체가 변경되지 않으므로 영향받지 않습니다.",
      },
      {
        q: "크기 제한이 있나요?",
        a: "배치당 최대 1,000개 파일입니다. 직접 전송에는 서버 측 크기 제한이 없습니다 — Chrome과 Edge는 곧바로 디스크로 스트리밍합니다 — 하지만 Firefox와 Safari는 메모리에 버퍼링하므로 그 둘에서는 한 번의 전송을 약 200MB 이내로 유지하세요.",
      },
    ],
  },
  cta: {
    text: "Mac과 Windows PC 양쪽에서 Relayium을 열고 첫 파일을 보내 보세요 — 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Dateien zwischen Mac und Windows-PC übertragen",
  description:
    "So sendest du Dateien zwischen macOS und Windows — ohne USB-Stick, freigegebenen Ordner oder Cloud-Upload. Im selben Netz und über das Internet, auf keinem der beiden Systeme ist etwas zu installieren.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Mac und PC sprechen von Haus aus nicht dieselbe Sprache, wenn es um Dateifreigabe geht. AirDrop ist Apple vorbehalten, die Netzwerkfreigabe von Windows verlangt, dass beide Rechner in einer passenden Arbeitsgruppe oder Domäne sind, und beides lässt sich nicht eben in fünf Minuten einrichten — dabei willst du vielleicht nur einen Projektordner vom MacBook auf den Windows-Desktop bringen.",
    "Relayium umgeht dieses ganze Kompatibilitätsproblem. Öffne dieselbe Seite im Browser auf dem Mac und auf dem Windows-PC, und die Dateien wandern direkt zwischen ihnen — Ende-zu-Ende-verschlüsselt, auf keinem der beiden Betriebssysteme ist etwas zu installieren. Im selben Netz ist überhaupt kein Konto nötig; beim Senden über das Internet per Pairing-Code muss sich nur der Absender anmelden. Hier die genauen Schritte in beide Richtungen.",
  ],
  sections: [
    {
      heading: "Was du vorher brauchst",
      body: [
        "Nichts zu installieren, weder auf dem Mac noch auf dem PC. Im selben Netz gibt es auch nichts zu registrieren — der Browser erledigt alles.",
      ],
      bullets: [
        "Ein Mac mit Safari oder Chrome und ein Windows-PC mit Edge oder Chrome — auf beiden Seiten reicht ein aktueller Browser.",
        "Für den einfachsten Weg verbinde beide Rechner mit demselben WLAN oder Ethernet-Netzwerk. Sind sie an verschiedenen Orten, überbrückt ein Pairing-Code die Distanz stattdessen.",
        "Die Dateien oder Ordner zum Senden — bis zu 1.000 Dateien pro Stapel.",
      ],
    },
    {
      heading: "Mac und PC im selben Netzwerk",
      body: [
        "Sind beide Rechner im selben Büro- oder Heimnetz, ist das der schnellste Weg, Dateien zu bewegen — kein Netzlaufwerk einzubinden, kein Kampf mit Berechtigungen.",
      ],
      bullets: [
        "Öffne auf dem Mac relayium.com im Browser. Öffne auf dem Windows-PC dieselbe Adresse.",
        "Jeder Rechner erscheint beim anderen als Gerät in der Nähe — keine Windows-Arbeitsgruppe einzurichten, keine macOS-Dateifreigabe zu aktivieren.",
        "Tippe auf dem sendenden Rechner den anderen an und wähle die Dateien (oder einen ganzen Ordner) zum Senden.",
        "Beide Bildschirme zeigen denselben kurzen Prüfcode. Vergleiche ihn auf beiden Seiten — das bestätigt, dass die Verbindung direkt zwischen deinen zwei Rechnern besteht und nichts dazwischengeschaltet ist.",
        "Bestätige auf der empfangenden Seite, und die Übertragung startet sofort und streamt direkt auf die Festplatte.",
      ],
    },
    {
      heading: "Mac und PC in verschiedenen Netzwerken",
      body: [
        "Du arbeitest von zu Hause, während der andere Rechner im Büro steht, oder bist einfach in einem anderen WLAN? Ein Pairing-Code verbindet Mac und Windows-PC über das Internet, nicht nur über den Raum hinweg.",
        "Der sendende Rechner erzeugt einen kurzen Pairing-Code (oder einen Freigabelink); gib ihn auf dem anderen Rechner ein, um dich zu verbinden. Die Übertragung läuft weiterhin direkt Peer-to-Peer, wann immer ein direkter Weg möglich ist, und weicht sonst auf ein verschlüsseltes TURN-Relay aus — das ausschließlich Chiffretext sieht. Bricht die Verbindung mitten in einem großen Ordner ab, wird sie fortgesetzt statt neu gestartet. Dieser Weg erfordert die Anmeldung des Absenders; wer empfängt, braucht nie ein Konto.",
      ],
    },
    {
      heading: "Einen ganzen Ordner senden, nicht nur einzelne Dateien",
      body: [
        "Einen Projektordner von Mac nach Windows (oder zurück) zu bewegen bedeutet normalerweise, ihn erst zu zippen. Relayium kann einen Ordner direkt senden und behält dabei seine Struktur bei.",
      ],
      bullets: [
        "Auf dem Mac ziehst du einen Ordner hinein oder wählst ihn im Dateidialog aus — bis zu 1.000 Dateien im Stapel.",
        "Auf einem Windows-PC mit Edge oder Chrome wird der eingehende Ordner direkt in ein von dir gewähltes Verzeichnis geschrieben, Struktur erhalten.",
        "Unterstützt der empfangende Browser das direkte Schreiben von Ordnern nicht, kommt der Ordner als einzelne .zip-Datei an, die sich zur gleichen Struktur entpacken lässt.",
      ],
    },
    {
      heading: "Andere Wege, Dateien zwischen Mac und Windows zu bewegen",
      body: [
        "Relayium ist nicht die einzige Option — hier die ehrlichen Kompromisse der üblichen Alternativen:",
      ],
      bullets: [
        "Ein USB-Stick funktioniert offline, aber macOS und Windows sind sich beim Dateisystem nicht immer einig, ohne dass neu formatiert werden muss, und es ist ein weiteres physisches Objekt, das man nicht verlieren darf.",
        "Windows-Netzwerkfreigabe (SMB) erreicht auch einen Mac, aber für eine einmalige Übertragung Arbeitsgruppen, Berechtigungen und Firewall-Regeln einzurichten, ist mehr Aufwand als die Übertragung wert ist.",
        "Eine Cloud (OneDrive, iCloud, Google Drive) funktioniert, wenn die andere Person offline ist, aber die Datei wird hoch- und wieder heruntergeladen, zählt gegen dein Speicherkontingent, und der Anbieter behält eine Kopie.",
        "E-Mail und Chat-Apps sind praktisch, begrenzen aber meist die Anhangsgröße und sind beim Dateiaustausch nicht Ende-zu-Ende-verschlüsselt.",
      ],
    },
    {
      heading: "Ändert sich etwas an den Dateien?",
      body: [
        "Nein. Relayium überträgt die Original-Bytes exakt so, wie sie sind — keine erneute Komprimierung, keine Neuformatierung, keine geänderten Zeilenumbrüche oder Dateinamen zwischen den beiden Betriebssystemen.",
        "Jede Datei wird per SHA-256-Hash Ende-zu-Ende geprüft, sodass das, was auf dem Windows-PC (oder dem Mac) ankommt, nachweislich identisch mit dem ist, was den anderen Rechner verlassen hat. Auch große Dateien werden gut gehandhabt: Chrome und Edge streamen den Download ohne Größenbegrenzung direkt auf die Festplatte, während Firefox und Safari im Speicher puffern — halte dort eine einzelne Übertragung also unter etwa 200 MB.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Muss ich auf dem Mac oder dem Windows-PC etwas installieren?",
        a: "Nein. Relayium läuft auf macOS und Windows vollständig im Browser. Öffne auf jedem Rechner relayium.com, und du bist startklar — einen Download braucht es so oder so nicht. Im selben Netz braucht eine Übertragung überhaupt kein Konto; Pairing über das Internet verlangt nur die Anmeldung des Absenders.",
      },
      {
        q: "Müssen beide Rechner im selben Netzwerk sein?",
        a: "Nein. Dasselbe Netz ist der schnellste Weg, weil sich die beiden Rechner automatisch finden, aber ein Pairing-Code verbindet Mac und Windows-PC genauso gut über das Internet — sogar aus verschiedenen Städten. So oder so bleibt die Übertragung Ende-zu-Ende-verschlüsselt; der Weg über Netzwerke hinweg verlangt nur, dass sich der Absender zuerst anmeldet, der Empfänger braucht nie ein Konto.",
      },
      {
        q: "Kann ich einen ganzen Ordner senden, nicht nur einzelne Dateien?",
        a: "Ja. Ziehe einen Ordner hinein, und Relayium sendet bis zu 1.000 Dateien im Stapel und behält dabei die Ordnerstruktur bei. Chrome und Edge unter Windows schreiben direkt in ein gewähltes Verzeichnis; kann der empfangende Browser Ordner nicht direkt schreiben, kommt er als einzelne .zip-Datei mit derselben Struktur an.",
      },
      {
        q: "Werden Dateiberechtigungen, Zeilenumbrüche oder Dateinamen beim Wechsel von Mac zu Windows durcheinandergebracht?",
        a: "Nein. Relayium bewegt die exakten Bytes jeder Datei und prüft sie per SHA-256-Hash Ende-zu-Ende — Zeilenumbrüche, Kodierung oder Dateinamen werden nicht angerührt. Alles, was eine Konvertierung auf Anwendungsebene bräuchte (etwa CRLF vs. LF in einer Textdatei), bleibt unverändert, weil die Datei selbst unverändert bleibt.",
      },
      {
        q: "Gibt es eine Größenbegrenzung?",
        a: "Bis zu 1.000 Dateien pro Stapel. Es gibt keine serverseitige Größenbegrenzung für eine direkte Übertragung — Chrome und Edge streamen direkt auf die Festplatte — aber Firefox und Safari puffern im Speicher, also halte einzelne Übertragungen dort unter etwa 200 MB.",
      },
    ],
  },
  cta: {
    text: "Öffne Relayium auf deinem Mac und deinem Windows-PC und schick deine ersten Dateien hinüber — keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Transférer des fichiers entre un Mac et un PC Windows",
  description:
    "Comment envoyer des fichiers entre macOS et Windows sans clé USB, sans dossier partagé, sans envoi vers le cloud. Sur le même réseau ou via Internet, rien à installer sur aucun des deux systèmes.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Mac et PC ne parlent pas nativement le même langage de partage de fichiers. AirDrop est réservé à Apple, le partage réseau de Windows exige que les deux machines soient dans un groupe de travail ou un domaine compatible, et aucun des deux ne se configure vraiment en cinq minutes — alors que vous voulez peut-être juste déplacer un dossier de projet d'un MacBook vers un PC de bureau Windows.",
    "Relayium contourne tout ce problème de compatibilité. Ouvrez la même page dans le navigateur sur le Mac et sur le PC Windows, et les fichiers voyagent directement entre eux — chiffrés de bout en bout, rien à installer sur aucun des deux systèmes d'exploitation. Sur le même réseau, aucun compte n'est nécessaire du tout ; pour envoyer via Internet avec un code d'appairage, l'expéditeur n'a qu'à se connecter. Voici la marche à suivre exacte dans les deux sens.",
  ],
  sections: [
    {
      heading: "Ce qu'il vous faut avant de commencer",
      body: [
        "Rien à installer, ni sur le Mac ni sur le PC. Sur le même réseau, rien à créer non plus — le navigateur s'occupe de tout.",
      ],
      bullets: [
        "Un Mac avec Safari ou Chrome, et un PC Windows avec Edge ou Chrome — n'importe quel navigateur moderne des deux côtés suffit.",
        "Pour la voie la plus simple, connectez les deux machines au même réseau Wi-Fi ou Ethernet. Si elles sont à des endroits différents, un code d'appairage comble l'écart.",
        "Les fichiers ou dossiers à envoyer — jusqu'à 1 000 fichiers par lot.",
      ],
    },
    {
      heading: "Mac et PC sur le même réseau",
      body: [
        "Si les deux ordinateurs sont sur le même réseau de bureau ou domestique, c'est le moyen le plus rapide de déplacer des fichiers — aucun lecteur partagé à monter, aucune permission à débloquer.",
      ],
      bullets: [
        "Sur le Mac, ouvrez relayium.com dans le navigateur. Sur le PC Windows, ouvrez la même adresse.",
        "Chaque machine apparaît sur l'autre comme un appareil à proximité — aucun groupe de travail Windows à configurer, aucun partage de fichiers macOS à activer.",
        "Sur l'ordinateur qui envoie, touchez l'autre, puis choisissez les fichiers (ou un dossier entier) à envoyer.",
        "Les deux écrans affichent le même code de vérification court. Vérifiez qu'il correspond des deux côtés — cela confirme que la connexion est directe entre vos deux machines, sans rien d'intercalé.",
        "Acceptez du côté récepteur, et le transfert démarre immédiatement, en flux direct vers le disque.",
      ],
    },
    {
      heading: "Mac et PC sur des réseaux différents",
      body: [
        "Vous travaillez depuis chez vous pendant que l'autre machine est au bureau, ou simplement sur un autre réseau Wi-Fi ? Un code d'appairage connecte un Mac et un PC Windows via Internet, pas seulement d'une pièce à l'autre.",
        "L'ordinateur qui envoie génère un court code d'appairage (ou un lien de partage) ; saisissez-le sur l'autre machine pour vous connecter. Le transfert reste en pair-à-pair direct chaque fois qu'une voie directe est possible, et bascule vers un relais TURN chiffré — qui ne voit jamais que du texte chiffré — quand ce n'est pas le cas. Si la connexion se coupe en cours de transfert d'un gros dossier, elle reprend au lieu de tout recommencer. Ce mode exige que l'expéditeur se connecte ; celui qui reçoit n'a jamais besoin de compte.",
      ],
    },
    {
      heading: "Envoyer un dossier entier, pas seulement des fichiers isolés",
      body: [
        "Déplacer un dossier de projet du Mac vers Windows (ou l'inverse) implique généralement de le compresser d'abord. Relayium peut envoyer un dossier directement, en conservant sa structure intacte.",
      ],
      bullets: [
        "Sur le Mac, glissez un dossier ou choisissez-en un dans le sélecteur de fichiers — jusqu'à 1 000 fichiers dans le lot.",
        "Sur un PC Windows utilisant Edge ou Chrome, le dossier reçu est écrit directement dans un répertoire de votre choix, structure préservée.",
        "Si le navigateur du destinataire ne prend pas en charge l'écriture directe de dossiers, le dossier arrive sous forme d'un seul .zip qui se décompresse selon la même arborescence.",
      ],
    },
    {
      heading: "Autres façons de déplacer des fichiers entre Mac et Windows",
      body: [
        "Relayium n'est pas la seule option — voici les compromis honnêtes des solutions de rechange habituelles :",
      ],
      bullets: [
        "Une clé USB fonctionne hors ligne, mais macOS et Windows ne s'accordent pas toujours sur un système de fichiers sans reformatage, et c'est un objet physique de plus à ne pas perdre.",
        "Le partage réseau Windows (SMB) peut atteindre un Mac, mais configurer groupes de travail, permissions et règles de pare-feu pour un transfert ponctuel demande plus d'effort que le transfert n'en vaut la peine.",
        "Un espace cloud (OneDrive, iCloud, Google Drive) fonctionne quand l'autre personne est hors ligne, mais le fichier est téléversé puis téléchargé, cela grignote votre quota de stockage, et le fournisseur en garde une copie.",
        "L'e-mail et les messageries sont pratiques mais limitent généralement la taille des pièces jointes et ne sont pas chiffrés de bout en bout pour le partage de fichiers.",
      ],
    },
    {
      heading: "Quelque chose change-t-il dans les fichiers ?",
      body: [
        "Non. Relayium transfère les octets d'origine exactement tels quels — aucune recompression, aucun reformatage, aucun changement de fin de ligne ou de nom de fichier entre les deux systèmes d'exploitation.",
        "Chaque fichier est vérifié de bout en bout par une empreinte SHA-256, si bien que ce qui arrive sur le PC Windows (ou le Mac) est vérifié identique à ce qui a quitté l'autre machine. Les gros fichiers sont bien gérés aussi : Chrome et Edge diffusent le téléchargement directement sur le disque sans limite de taille, tandis que Firefox et Safari tamponnent en mémoire — sur ceux-là, gardez donc un transfert unique sous environ 200 Mo.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Dois-je installer quelque chose sur le Mac ou sur le PC Windows ?",
        a: "Non. Relayium fonctionne entièrement dans le navigateur, sur macOS comme sur Windows. Ouvrez relayium.com sur chaque machine et vous êtes prêt — aucun téléchargement dans les deux cas. Sur le même réseau, un transfert ne demande aucun compte du tout ; s'appairer via Internet demande seulement que l'expéditeur se connecte.",
      },
      {
        q: "Les deux ordinateurs doivent-ils être sur le même réseau ?",
        a: "Non. Être sur le même réseau est la voie la plus rapide car les deux machines se découvrent automatiquement, mais un code d'appairage connecte tout aussi bien un Mac et un PC Windows via Internet — même depuis des villes différentes. Dans les deux cas, le transfert reste chiffré de bout en bout ; la voie entre réseaux différents demande seulement que l'expéditeur se connecte d'abord, et le destinataire n'a jamais besoin de compte.",
      },
      {
        q: "Puis-je envoyer un dossier entier, pas seulement des fichiers isolés ?",
        a: "Oui. Glissez un dossier, et Relayium envoie jusqu'à 1 000 fichiers dans le lot, en conservant la structure du dossier. Chrome et Edge sous Windows l'écrivent directement dans un répertoire choisi ; si le navigateur du destinataire ne peut pas écrire de dossiers directement, il arrive sous forme d'un seul .zip avec la même arborescence.",
      },
      {
        q: "Les permissions de fichiers, fins de ligne ou noms de fichiers sont-ils altérés en passant de Mac à Windows ?",
        a: "Non. Relayium déplace les octets exacts de chaque fichier et les vérifie par une empreinte SHA-256 de bout en bout — il ne touche ni aux fins de ligne, ni à l'encodage, ni aux noms de fichiers. Tout ce qu'une conversion au niveau applicatif devrait gérer (comme CRLF contre LF dans un fichier texte) reste inchangé, car le fichier lui-même reste inchangé.",
      },
      {
        q: "Y a-t-il une limite de taille ?",
        a: "Jusqu'à 1 000 fichiers par lot. Il n'y a pas de limite de taille côté serveur pour un transfert direct — Chrome et Edge diffusent directement sur le disque — mais Firefox et Safari tamponnent en mémoire, donc gardez les transferts individuels sous environ 200 Mo sur ceux-là.",
      },
    ],
  },
  cta: {
    text: "Ouvrez Relayium sur votre Mac et votre PC Windows et envoyez vos premiers fichiers — sans installation, et sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "how-to/transfer-files-between-mac-and-windows",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr },
};
