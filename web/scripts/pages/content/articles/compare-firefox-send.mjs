// web/scripts/pages/content/articles/compare-firefox-send.mjs
// "Best Firefox Send alternative" comparison. Firefox Send was discontinued by
// Mozilla in 2020 — this article is honest about that and positions Relayium's
// stored/async link mode (plus realtime P2P) as the closest living replacement.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.

const en = {
  title: "The best Firefox Send alternative in 2026",
  description:
    "Firefox Send shut down in 2020. Relayium brings back private, expiring, encrypted link sharing — a random key generated in your browser, zero-knowledge storage, and no account needed to download.",
  updatedLabel: "Last updated",
  lead: [
    "Firefox Send was Mozilla's take on private file sharing: drop in a file, get an encrypted link, set it to expire or self-destruct after one download. People loved it and still look for it years later. It is not coming back — Mozilla discontinued the service in 2020 — but the need it filled is still real.",
    "Relayium's async (stored-link) mode picks up that same idea: encrypt in the browser, share a link, watch it expire or burn. This article is an honest comparison — what Firefox Send did, how closely Relayium matches it, and where Relayium goes further with realtime peer-to-peer transfer, a CLI, and self-hosting.",
  ],
  sections: [
    {
      heading: "What Firefox Send was, and why people still miss it",
      body: [
        "Firefox Send launched from Mozilla in 2019 as a simple, privacy-minded way to share files: upload a file, the browser encrypted it, and you got a link you could send anywhere. The recipient needed no account to download. You could set the link to expire after a number of downloads or after a set time, and Mozilla marketed it as end-to-end encrypted.",
        "Mozilla shut Firefox Send down in September 2020, citing abuse of the service for malware distribution and a decision to focus engineering elsewhere. There has been no successor from Mozilla and no announced plans to revive it — if you are hoping it comes back under its old name, it will not. That has left a real gap: a lot of people still want a free, private, link-based way to send a file that expires and that the host provider cannot read.",
      ],
    },
    {
      heading: "How Relayium's stored links match that idea",
      body: [
        "Relayium's async mode is built around the same shape of experience. You pick your files, your browser generates a random AES-256-GCM key locally, encrypts the files with it, and uploads the ciphertext. The server never sees the key and cannot decrypt what it stores — it is genuinely zero-knowledge, not just \"encrypted at rest.\"",
        "The decryption key travels only inside the link itself, in the URL fragment after the #, which browsers never transmit to any server. Whoever receives the link needs no account to download — they just open it, and their browser fetches the ciphertext and decrypts it locally with the key from the fragment. That is the core Firefox Send promise, intact: a link that carries its own key and that the server hosting it cannot read.",
      ],
    },
    {
      heading: "Expiry, burn-after-read, and the honest limits",
      body: [
        "Like Firefox Send, every Relayium link has a lifespan you choose: 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or you can set it to burn after the very first complete download so it is gone the moment your recipient has the file. Once a link expires or burns, the stored ciphertext is deleted and the link stops working.",
        "To be precise about what's stored where: this is a stored-link mode, so the encrypted file bytes genuinely do sit on Relayium's server between upload and download — it is zero-knowledge ciphertext the server cannot decrypt, but it is not a \"the file never touches a server\" setup. Creating a link does require the sender to sign in (it's tied to your account's storage quota); the recipient never needs an account to open or download it.",
      ],
    },
    {
      heading: "Beyond link sharing: realtime transfer, a CLI, and self-hosting",
      body: [
        "Firefox Send only ever did one thing — encrypted, async link sharing — and Relayium's stored mode covers that ground. But Relayium also has a mode Firefox Send never offered: realtime peer-to-peer transfer, where files stream directly between two open browsers over an end-to-end encrypted WebRTC channel and nothing is stored on a server at all. On the same network it needs no account for either side; sending across networks with a pairing code needs the sender to sign in, and the receiver still never does.",
        "For people who want more control, Relayium also ships a free, open-source CLI (push/pull over SSH, cross-network send/receive, folder sync) and a self-hostable server you can run yourself — none of which Firefox Send ever had. The whole project is AGPL-3.0-licensed and open source on GitHub.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is Firefox Send coming back?",
        a: "No. Mozilla discontinued Firefox Send in September 2020 and has not revived it or announced a successor. Relayium's stored-link mode is a separate, independently built project designed to fill the same gap.",
      },
      {
        q: "Is Relayium as private as Firefox Send was?",
        a: "Yes, and the design is stronger in one respect: your browser generates a random AES-256-GCM key locally, and the key lives only in the link's URL fragment, which is never sent to the server. The server stores only ciphertext it cannot decrypt — a true zero-knowledge setup.",
      },
      {
        q: "Do links expire?",
        a: "Yes. Choose 1 hour, 1 day, 3 days, 7 days, or up to 14 days depending on your plan, or set the link to burn after the first complete download. After that, the stored ciphertext is deleted and the link no longer works.",
      },
      {
        q: "Is Relayium free?",
        a: "Yes. Relayium is free and open source under the AGPL-3.0 license. Creating a stored download link requires the sender to sign in (links count against your account's storage quota), but the recipient never needs an account to download.",
      },
    ],
  },
  cta: {
    text: "Send a private, expiring link the way Firefox Send used to — encrypted in your browser, unreadable by the server.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "2026 年最佳 Firefox Send 替代品",
  description:
    "Firefox Send 已于 2020 年停运。Relayium 带回了私密、限时、加密的链接分享：浏览器本地生成随机密钥、零知识存储，下载无需账号。",
  updatedLabel: "最近更新",
  lead: [
    "Firefox Send 是 Mozilla 对私密文件分享的尝试：放入文件、拿到加密链接，可设置到期或首次下载后自毁。很多人喜欢它，多年后仍在寻找它。它不会回归——Mozilla 已于 2020 年停止该服务——但它满足的那个需求依然真实存在。",
    "Relayium 的异步（存储链接）模式延续了同样的理念：浏览器加密、分享链接、到期或即焚。本文做一次坦诚的对比——Firefox Send 曾做到什么、Relayium 有多接近它，以及 Relayium 在实时点对点传输、命令行工具和自托管方面又走得更远。",
  ],
  sections: [
    {
      heading: "Firefox Send 是什么，为何人们仍怀念它",
      body: [
        "Firefox Send 由 Mozilla 于 2019 年推出，是一种简单、注重隐私的文件分享方式：上传文件、浏览器对其加密，你会得到一个可以发给任何人的链接。收件方下载无需账号。你可以设置链接在若干次下载后或一段时间后失效，Mozilla 当时也将其宣传为端到端加密。",
        "Mozilla 于 2020 年 9 月关闭了 Firefox Send，理由包括该服务被滥用于传播恶意软件，以及决定把工程资源投向别处。Mozilla 没有推出继任产品，也没有宣布过复活计划——如果你期待它以原名回归，那不会发生。这留下了一个真实的空缺：许多人仍然想要一种免费、私密、基于链接、会到期、且托管方无法读取内容的文件发送方式。",
      ],
    },
    {
      heading: "Relayium 的存储链接如何呼应这一理念",
      body: [
        "Relayium 的异步模式围绕同样的体验构建。你选择文件后，浏览器会在本地生成一个随机的 AES-256-GCM 密钥，用它加密文件并上传密文。服务器从不看到密钥，也无法解密它所存储的内容——这是真正的零知识，而不只是「静态加密」。",
        "解密密钥只存在于链接本身之中，也就是 # 之后的 URL 片段，浏览器从不把这部分发送给任何服务器。拿到链接的人下载时无需账号——直接打开链接，浏览器就会取回密文并用片段中的密钥在本地解密。这正是 Firefox Send 当年的核心承诺，完整保留：一个自带密钥、托管方读不懂的链接。",
      ],
    },
    {
      heading: "到期、阅后即焚，以及坦诚说明的限制",
      body: [
        "和 Firefox Send 一样，Relayium 的每个链接都有你自己选择的有效期：1 小时、1 天、3 天、7 天或最长 14 天（上限取决于套餐），或者设置为「首次下载后即焚」，收件方一拿到文件链接就会失效。链接一旦到期或即焚，存储的密文就会被删除，链接随之失效。",
        "需要说清楚存储的具体情况：这是存储链接模式，加密后的文件字节确实会在上传与下载之间存放在 Relayium 服务器上——它是服务器无法解密的零知识密文，但并非「文件从不经过服务器」那种设置。生成链接需要发送方登录（这与你账号的存储配额挂钩）；收件方打开或下载时始终无需账号。",
      ],
    },
    {
      heading: "不止链接分享：实时传输、命令行工具与自托管",
      body: [
        "Firefox Send 只做一件事——异步加密链接分享，Relayium 的存储模式覆盖了这一点。但 Relayium 还有一种 Firefox Send 从未提供过的模式：实时点对点传输，文件通过端到端加密的 WebRTC 通道在两个打开的浏览器之间直接流动，完全不落到服务器上。同一网络下双方都无需账号；跨网络用配对码发送时需要发送方登录，接收方仍然始终无需账号。",
        "对想要更多掌控权的人，Relayium 还提供免费开源的命令行工具（基于 SSH 的 push/pull、跨网络的 send/receive、文件夹同步）以及可自行运行的自托管服务端——这些都是 Firefox Send 从未有过的。整个项目在 GitHub 上以 AGPL-3.0 许可开源。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Firefox Send 会回归吗？",
        a: "不会。Mozilla 已于 2020 年 9 月停止 Firefox Send，也未复活它或宣布过继任产品。Relayium 的存储链接模式是一个独立开发的项目，旨在填补同样的空缺。",
      },
      {
        q: "Relayium 和 Firefox Send 一样私密吗？",
        a: "是的，在某一点上其设计更强：浏览器会在本地生成随机的 AES-256-GCM 密钥，密钥只存在于链接的 URL 片段中，从不发送给服务器。服务器只存储它无法解密的密文——这是真正的零知识设置。",
      },
      {
        q: "链接会过期吗？",
        a: "会。可选择 1 小时、1 天、3 天、7 天或最长 14 天（上限取决于套餐），或设置为首次下载后即焚。之后，存储的密文会被删除，链接不再可用。",
      },
      {
        q: "Relayium 免费吗？",
        a: "免费。Relayium 采用 AGPL-3.0 许可，免费开源。生成存储下载链接需要发送方登录（链接计入你账号的存储配额），但收件方下载始终无需账号。",
      },
    ],
  },
  cta: {
    text: "像当年的 Firefox Send 一样发一个私密、限时的链接——浏览器本地加密，服务器无法读取。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "2026年、最良の Firefox Send 代替サービス",
  description:
    "Firefox Send は2020年に終了しました。Relayium はブラウザでランダムな鍵を生成し、ゼロ知識で保存し、ダウンロードにアカウント不要な、プライベートで期限付きの暗号化リンク共有を取り戻します。",
  updatedLabel: "最終更新",
  lead: [
    "Firefox Send は Mozilla によるプライベートなファイル共有の試みでした。ファイルを入れると暗号化されたリンクが得られ、期限切れや1回のダウンロード後の自動削除を設定できました。多くの人がこれを気に入り、何年経った今も探し続けています。もう戻ってきません。Mozilla は2020年にこのサービスを終了しました。ですが、それが満たしていたニーズは今も現実に存在します。",
    "Relayium の非同期（保存リンク）モードは同じ発想を引き継いでいます。ブラウザで暗号化し、リンクを共有し、期限切れや削除を見届ける。この記事は正直な比較です。Firefox Send が何をしていたか、Relayium はどれほど近いか、そして Relayium がリアルタイムの P2P 転送、CLI、セルフホストでどこまで先へ進んでいるかを見ていきます。",
  ],
  sections: [
    {
      heading: "Firefox Send とは何だったか、そしてなぜ今も惜しまれるのか",
      body: [
        "Firefox Send は2019年に Mozilla からリリースされた、シンプルでプライバシー志向のファイル共有方法でした。ファイルをアップロードするとブラウザがそれを暗号化し、どこへでも送れるリンクを受け取ります。受信側はダウンロードにアカウントを必要としませんでした。ダウンロード回数や一定時間の経過でリンクを失効させることができ、Mozilla はこれをエンドツーエンド暗号化とうたっていました。",
        "Mozilla は2020年9月に Firefox Send を終了しました。理由はマルウェア配布への悪用と、エンジニアリングを他へ注力する判断だったとされています。Mozilla からの後継サービスはなく、復活の計画も発表されていません。もし旧名での復活を期待しているなら、それは起きません。ここに現実の空白が残りました。無料で、プライベートで、リンクベースで期限が切れ、ホスト側が内容を読めないファイル送信方法を、今も多くの人が求めています。",
      ],
    },
    {
      heading: "Relayium の保存リンクがこの発想にどう応えるか",
      body: [
        "Relayium の非同期モードは、同じ形の体験を軸に作られています。ファイルを選ぶと、ブラウザがローカルでランダムな AES-256-GCM 鍵を生成し、それでファイルを暗号化して暗号文をアップロードします。サーバーは鍵を一切見ることがなく、保存しているものを復号できません。これは単なる「保存時の暗号化」ではなく、真のゼロ知識です。",
        "復号鍵はリンク自体の中、# の後の URL フラグメントにのみ存在し、ブラウザがどのサーバーにも送信しない部分です。リンクを受け取った人はダウンロードにアカウントを必要としません。ただ開くだけで、ブラウザが暗号文を取得し、フラグメント内の鍵でローカルに復号します。これは Firefox Send の核心的な約束、すなわち自身の鍵を運び、ホストするサーバーが読めないリンクという約束が、そのまま守られている形です。",
      ],
    },
    {
      heading: "期限切れ、閲覧後削除、そして正直な限界",
      body: [
        "Firefox Send と同様に、Relayium のすべてのリンクには自分で選ぶ有効期間があります。1時間、1日、3日、7日、最長14日（プランによる）、あるいは最初の完全なダウンロードの後に削除するよう設定することもでき、その瞬間に受信者が手にしたファイルとともにリンクが消えます。リンクが期限切れになるか削除されると、保存された暗号文は削除され、リンクは機能しなくなります。",
        "何がどこに保存されているかを正確に言うと、これは保存リンク方式であり、暗号化されたファイルのバイト列はアップロードとダウンロードの間、実際に Relayium のサーバー上に置かれます。サーバーが復号できないゼロ知識の暗号文ではありますが、「ファイルが決してサーバーに触れない」という構成ではありません。リンクの作成には送信側のサインインが必要です（アカウントの保存容量枠に紐づきます）。受信側はリンクを開いてダウンロードするのに、決してアカウントを必要としません。",
      ],
    },
    {
      heading: "リンク共有を超えて：リアルタイム転送、CLI、セルフホスト",
      body: [
        "Firefox Send は非同期の暗号化リンク共有という一つのことしかしませんでしたが、Relayium の保存モードはその範囲をカバーします。しかし Relayium には Firefox Send が一度も提供しなかったモードもあります。リアルタイムのピアツーピア転送では、ファイルはエンドツーエンド暗号化された WebRTC チャネルを通じて、開いている2つのブラウザ間を直接流れ、サーバーには一切保存されません。同じネットワークならどちらもアカウント不要です。ペアリングコードでネットワークをまたいで送る場合は送信側のサインインが必要ですが、受信側は依然として不要です。",
        "より多くの制御を望む人向けに、Relayium は無料でオープンソースの CLI（SSH 経由の push/pull、ネットワークをまたぐ send/receive、フォルダ同期）と、自分で運用できるセルフホスト型サーバーも提供します。どちらも Firefox Send にはなかったものです。プロジェクト全体は AGPL-3.0 ライセンスで GitHub 上にオープンソース公開されています。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Firefox Send は復活しますか？",
        a: "いいえ。Mozilla は2020年9月に Firefox Send を終了し、復活も後継サービスの発表もしていません。Relayium の保存リンクモードは、同じ空白を埋めることを目指して独立に作られた別のプロジェクトです。",
      },
      {
        q: "Relayium は Firefox Send と同じくらいプライベートですか？",
        a: "はい。ある点ではさらに強固です。ブラウザがローカルでランダムな AES-256-GCM 鍵を生成し、鍵はリンクの URL フラグメントにのみ存在し、サーバーに送信されることはありません。サーバーは復号できない暗号文だけを保存する、真のゼロ知識構成です。",
      },
      {
        q: "リンクは期限切れになりますか？",
        a: "はい。1時間、1日、3日、7日、最長14日（プランによる）から選ぶか、最初の完全なダウンロード後に削除するよう設定できます。その後、保存された暗号文は削除され、リンクは使えなくなります。",
      },
      {
        q: "Relayium は無料ですか？",
        a: "はい。Relayium は AGPL-3.0 ライセンスの無料オープンソースです。保存型ダウンロードリンクの作成には送信側のサインインが必要です（リンクはアカウントの保存容量枠に計上されます）が、受信側はダウンロードに決してアカウントを必要としません。",
      },
    ],
  },
  cta: {
    text: "かつての Firefox Send のように、プライベートで期限付きのリンクを送りましょう。ブラウザでローカルに暗号化され、サーバーは読み取れません。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "2026년 최고의 Firefox Send 대안",
  description:
    "Firefox Send는 2020년에 종료되었습니다. Relayium은 브라우저에서 무작위 키를 생성하고 영지식으로 저장하며 다운로드에 계정이 필요 없는, 사적이고 만료되는 암호화 링크 공유를 되살립니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Firefox Send는 Mozilla가 시도한 사적인 파일 공유 방식이었습니다. 파일을 넣으면 암호화된 링크를 받고, 만료 시점이나 첫 다운로드 후 자동 삭제을 설정할 수 있었습니다. 많은 사람이 이를 좋아했고 몇 년이 지난 지금도 여전히 찾고 있습니다. 다시 돌아오지는 않습니다. Mozilla는 2020년에 이 서비스를 중단했습니다. 하지만 그것이 채워주던 필요는 지금도 실재합니다.",
    "Relayium의 비동기(저장 링크) 모드는 같은 발상을 이어받습니다. 브라우저에서 암호화하고, 링크를 공유하고, 만료되거나 삭제되는 것을 지켜보세요. 이 글은 정직한 비교입니다. Firefox Send가 무엇을 했는지, Relayium이 얼마나 가깝게 닮았는지, 그리고 Relayium이 실시간 P2P 전송, CLI, 셀프호스팅으로 어디까지 더 나아가는지를 다룹니다.",
  ],
  sections: [
    {
      heading: "Firefox Send는 무엇이었고, 왜 아직도 그리워하는가",
      body: [
        "Firefox Send는 2019년 Mozilla가 출시한, 프라이버시를 중시한 간단한 파일 공유 방식이었습니다. 파일을 업로드하면 브라우저가 이를 암호화하고, 어디로든 보낼 수 있는 링크를 받았습니다. 받는 쪽은 다운로드에 계정이 필요 없었습니다. 링크를 몇 번의 다운로드 후 또는 일정 시간이 지난 후 만료되도록 설정할 수 있었고, Mozilla는 이를 종단간 암호화라고 홍보했습니다.",
        "Mozilla는 2020년 9월 Firefox Send를 종료했습니다. 서비스가 멀웨어 유포에 악용된 점과 엔지니어링 자원을 다른 곳에 집중하기로 한 결정이 이유로 꼽혔습니다. Mozilla의 후속 서비스는 없었고 부활 계획도 발표된 적이 없습니다. 옛 이름으로 돌아오길 기대한다면 그런 일은 없습니다. 이는 실질적인 공백을 남겼습니다. 무료이고, 사적이며, 링크 기반이고, 만료되며, 호스트가 내용을 읽을 수 없는 파일 전송 방법을 여전히 많은 사람이 원합니다.",
      ],
    },
    {
      heading: "Relayium의 저장 링크가 이 발상에 어떻게 부응하는가",
      body: [
        "Relayium의 비동기 모드는 같은 형태의 경험을 중심으로 만들어졌습니다. 파일을 고르면 브라우저가 로컬에서 무작위 AES-256-GCM 키를 생성하고, 그 키로 파일을 암호화해 암호문을 업로드합니다. 서버는 키를 전혀 보지 못하며 저장하고 있는 것을 복호화할 수 없습니다. 이는 단순한 ‘저장 시 암호화’가 아니라 진정한 영지식입니다.",
        "복호화 키는 링크 자체 안, # 뒤의 URL 프래그먼트에만 존재하며, 브라우저는 이 부분을 어떤 서버로도 전송하지 않습니다. 링크를 받은 사람은 다운로드에 계정이 필요 없습니다. 그냥 열기만 하면 브라우저가 암호문을 가져와 프래그먼트 속 키로 로컬에서 복호화합니다. 이것이 바로 Firefox Send의 핵심 약속, 즉 자체 키를 담고 있으며 이를 호스팅하는 서버가 읽을 수 없는 링크라는 약속이 그대로 유지되는 방식입니다.",
      ],
    },
    {
      heading: "만료, 열람 후 삭제, 그리고 정직하게 밝히는 한계",
      body: [
        "Firefox Send와 마찬가지로 Relayium의 모든 링크는 직접 고르는 수명을 가집니다: 1시간, 1일, 3일, 7일, 최대 14일(요금제에 따라 다름) 중 선택하거나, 첫 완전한 다운로드 후 삭제되도록 설정할 수 있어 받는 쪽이 파일을 손에 넣는 순간 링크가 사라집니다. 링크가 만료되거나 삭제되면 저장된 암호문이 삭제되고 링크는 더 이상 작동하지 않습니다.",
        "무엇이 어디에 저장되는지 정확히 말하자면, 이는 저장 링크 방식이므로 암호화된 파일 바이트가 업로드와 다운로드 사이에 실제로 Relayium 서버에 놓입니다. 서버가 복호화할 수 없는 영지식 암호문이긴 하지만, ‘파일이 서버에 전혀 닿지 않는’ 구조는 아닙니다. 링크 생성에는 보내는 쪽의 로그인이 필요합니다(계정의 저장 용량 한도에 연결됩니다). 받는 쪽은 링크를 열거나 다운로드하는 데 계정이 전혀 필요하지 않습니다.",
      ],
    },
    {
      heading: "링크 공유를 넘어서: 실시간 전송, CLI, 셀프호스팅",
      body: [
        "Firefox Send는 비동기 암호화 링크 공유라는 한 가지만 했으며, Relayium의 저장 모드가 그 영역을 커버합니다. 하지만 Relayium에는 Firefox Send가 전혀 제공한 적 없는 모드도 있습니다. 실시간 피어투피어 전송에서는 파일이 종단간 암호화된 WebRTC 채널을 통해 열려 있는 두 브라우저 사이를 직접 흐르며 서버에는 전혀 저장되지 않습니다. 같은 네트워크에서는 양쪽 모두 계정이 필요 없습니다. 페어링 코드로 네트워크를 넘어 보낼 때는 보내는 쪽의 로그인이 필요하지만, 받는 쪽은 여전히 필요 없습니다.",
        "더 많은 제어를 원하는 사람들을 위해 Relayium은 무료 오픈소스 CLI(SSH를 통한 push/pull, 네트워크를 넘나드는 send/receive, 폴더 동기화)와 직접 운영할 수 있는 셀프호스팅 서버도 제공합니다. 둘 다 Firefox Send에는 없던 것입니다. 프로젝트 전체는 AGPL-3.0 라이선스로 GitHub에 오픈소스로 공개되어 있습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Firefox Send가 다시 돌아오나요?",
        a: "아니요. Mozilla는 2020년 9월 Firefox Send를 종료했으며 부활시키거나 후속 서비스를 발표한 적이 없습니다. Relayium의 저장 링크 모드는 같은 공백을 채우기 위해 독립적으로 만들어진 별개의 프로젝트입니다.",
      },
      {
        q: "Relayium이 Firefox Send만큼 사적인가요?",
        a: "네, 한 가지 측면에서는 더 강력합니다. 브라우저가 로컬에서 무작위 AES-256-GCM 키를 생성하며, 키는 링크의 URL 프래그먼트에만 존재하고 서버로 전송되지 않습니다. 서버는 복호화할 수 없는 암호문만 저장하는, 진정한 영지식 구조입니다.",
      },
      {
        q: "링크가 만료되나요?",
        a: "네. 1시간, 1일, 3일, 7일, 최대 14일(요금제에 따라 다름) 중에서 고르거나 첫 완전한 다운로드 후 삭제되도록 설정할 수 있습니다. 그 후에는 저장된 암호문이 삭제되고 링크가 더 이상 작동하지 않습니다.",
      },
      {
        q: "Relayium은 무료인가요?",
        a: "네. Relayium은 AGPL-3.0 라이선스의 무료 오픈소스입니다. 저장형 다운로드 링크를 만들려면 보내는 쪽의 로그인이 필요합니다(링크는 계정의 저장 용량 한도에 포함됩니다). 하지만 받는 쪽은 다운로드에 계정이 전혀 필요하지 않습니다.",
      },
    ],
  },
  cta: {
    text: "예전 Firefox Send처럼 사적이고 만료되는 링크를 보내세요. 브라우저에서 로컬로 암호화되어 서버가 읽을 수 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Die beste Firefox-Send-Alternative 2026",
  description:
    "Firefox Send wurde 2020 eingestellt. Relayium bringt privates, ablaufendes, verschlüsseltes Link-Teilen zurück: ein zufälliger Schlüssel im Browser, Zero-Knowledge-Speicherung, und kein Konto zum Herunterladen nötig.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Firefox Send war Mozillas Ansatz für privates Dateiteilen: Datei einwerfen, verschlüsselten Link erhalten, Ablauf oder Burn-after-read nach einem Download einstellen. Die Leute liebten es und suchen Jahre später immer noch danach. Es kommt nicht zurück — Mozilla hat den Dienst 2020 eingestellt —, aber das Bedürfnis, das er erfüllte, ist weiterhin real.",
    "Relayiums asynchroner (Speicherlink-)Modus greift dieselbe Idee auf: im Browser verschlüsseln, einen Link teilen, ihn ablaufen oder vernichten lassen. Dieser Artikel ist ein ehrlicher Vergleich — was Firefox Send konnte, wie nah Relayium herankommt, und wo Relayium mit Echtzeit-Peer-to-Peer-Übertragung, einer CLI und der Möglichkeit, selbst zu hosten, weiter geht.",
  ],
  sections: [
    {
      heading: "Was Firefox Send war und warum es vielen fehlt",
      body: [
        "Firefox Send startete 2019 bei Mozilla als einfacher, auf Privatsphäre bedachter Weg, Dateien zu teilen: Datei hochladen, der Browser verschlüsselte sie, und man erhielt einen Link, den man überallhin senden konnte. Der Empfänger brauchte zum Herunterladen kein Konto. Man konnte den Link so einstellen, dass er nach einer bestimmten Anzahl Downloads oder nach einer festgelegten Zeit ablief, und Mozilla vermarktete es als Ende-zu-Ende-verschlüsselt.",
        "Mozilla stellte Firefox Send im September 2020 ein, mit Verweis auf Missbrauch des Dienstes zur Malware-Verbreitung und die Entscheidung, die Entwicklungsressourcen anderswo einzusetzen. Es gab keinen Nachfolger von Mozilla und keine angekündigten Pläne für eine Wiederbelebung — wer hofft, dass es unter dem alten Namen zurückkehrt, wird enttäuscht. Das hat eine echte Lücke hinterlassen: Viele Menschen wollen weiterhin einen kostenlosen, privaten, linkbasierten Weg, eine Datei zu senden, die abläuft und die der Hostinganbieter nicht lesen kann.",
      ],
    },
    {
      heading: "Wie Relayiums Speicherlinks diese Idee aufgreifen",
      body: [
        "Relayiums asynchroner Modus ist um dasselbe Erlebnis herum gebaut. Du wählst deine Dateien, dein Browser erzeugt lokal einen zufälligen AES-256-GCM-Schlüssel, verschlüsselt die Dateien damit und lädt den Chiffretext hoch. Der Server sieht den Schlüssel nie und kann nicht entschlüsseln, was er speichert — das ist echtes Zero-Knowledge, nicht nur „verschlüsselt im Ruhezustand“.",
        "Der Entschlüsselungsschlüssel reist nur innerhalb des Links selbst, im URL-Fragment nach dem #, das Browser niemals an einen Server übertragen. Wer den Link erhält, braucht zum Herunterladen kein Konto — er öffnet ihn einfach, und sein Browser holt den Chiffretext und entschlüsselt ihn lokal mit dem Schlüssel aus dem Fragment. Das ist das Kernversprechen von Firefox Send, unverändert erhalten: ein Link, der seinen eigenen Schlüssel trägt und den der hostende Server nicht lesen kann.",
      ],
    },
    {
      heading: "Ablauf, Burn-after-read und die ehrlichen Grenzen",
      body: [
        "Wie bei Firefox Send hat jeder Relayium-Link eine Lebensdauer, die du wählst: 1 Stunde, 1 Tag, 3 Tage, 7 Tage oder bis zu 14 Tage je nach Tarif, oder du stellst ihn so ein, dass er nach dem allerersten vollständigen Download vernichtet wird, sodass er verschwindet, sobald dein Empfänger die Datei hat. Sobald ein Link abläuft oder vernichtet wird, wird der gespeicherte Chiffretext gelöscht und der Link funktioniert nicht mehr.",
        "Um genau zu sein, wo was gespeichert wird: Dies ist ein Speicherlink-Modus, die verschlüsselten Dateibytes liegen zwischen Upload und Download tatsächlich auf Relayiums Server — es ist Zero-Knowledge-Chiffretext, den der Server nicht entschlüsseln kann, aber es ist kein Setup, bei dem „die Datei nie einen Server berührt“. Das Erstellen eines Links erfordert die Anmeldung des Absenders (es ist an das Speicherkontingent deines Kontos gebunden); der Empfänger braucht zum Öffnen oder Herunterladen niemals ein Konto.",
      ],
    },
    {
      heading: "Mehr als Link-Teilen: Echtzeitübertragung, eine CLI und selbst hosten",
      body: [
        "Firefox Send konnte immer nur eines — asynchrones, verschlüsseltes Link-Teilen —, und Relayiums Speichermodus deckt das ab. Aber Relayium hat auch einen Modus, den Firefox Send nie bot: Echtzeit-Peer-to-Peer-Übertragung, bei der Dateien direkt zwischen zwei geöffneten Browsern über einen Ende-zu-Ende-verschlüsselten WebRTC-Kanal streamen und überhaupt nichts auf einem Server gespeichert wird. Im selben Netz braucht keine Seite ein Konto; beim Senden über Netzwerke hinweg mit einem Pairing-Code muss sich der Absender anmelden, der Empfänger weiterhin nie.",
        "Für alle, die mehr Kontrolle wollen, bietet Relayium außerdem eine kostenlose, quelloffene CLI (push/pull über SSH, netzwerkübergreifendes send/receive, Ordnersynchronisation) und einen selbst hostbaren Server, den du selbst betreiben kannst — nichts davon hatte Firefox Send je. Das ganze Projekt ist AGPL-3.0-lizenziert und quelloffen auf GitHub.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kommt Firefox Send zurück?",
        a: "Nein. Mozilla hat Firefox Send im September 2020 eingestellt und weder wiederbelebt noch einen Nachfolger angekündigt. Relayiums Speicherlink-Modus ist ein separates, unabhängig entwickeltes Projekt, das dieselbe Lücke füllen soll.",
      },
      {
        q: "Ist Relayium so privat wie Firefox Send war?",
        a: "Ja, und das Design ist in einer Hinsicht sogar stärker: Dein Browser erzeugt lokal einen zufälligen AES-256-GCM-Schlüssel, und der Schlüssel lebt nur im URL-Fragment des Links, das nie an den Server gesendet wird. Der Server speichert nur Chiffretext, den er nicht entschlüsseln kann — ein echtes Zero-Knowledge-Setup.",
      },
      {
        q: "Laufen Links ab?",
        a: "Ja. Wähle 1 Stunde, 1 Tag, 3 Tage, 7 Tage oder bis zu 14 Tage je nach Tarif, oder stelle den Link so ein, dass er nach dem ersten vollständigen Download vernichtet wird. Danach wird der gespeicherte Chiffretext gelöscht und der Link funktioniert nicht mehr.",
      },
      {
        q: "Ist Relayium kostenlos?",
        a: "Ja. Relayium ist kostenlos und quelloffen unter der AGPL-3.0-Lizenz. Das Erstellen eines gespeicherten Download-Links erfordert die Anmeldung des Absenders (Links zählen gegen das Speicherkontingent deines Kontos), aber der Empfänger braucht zum Herunterladen niemals ein Konto.",
      },
    ],
  },
  cta: {
    text: "Sende einen privaten, ablaufenden Link wie einst bei Firefox Send — im Browser verschlüsselt, für den Server unlesbar.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "La meilleure alternative à Firefox Send en 2026",
  description:
    "Firefox Send a fermé en 2020. Relayium ramène le partage de liens privé, expirant et chiffré : une clé aléatoire générée dans le navigateur, un stockage à divulgation nulle, et aucun compte requis pour télécharger.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Firefox Send était la vision de Mozilla du partage de fichiers privé : déposez un fichier, obtenez un lien chiffré, réglez-le pour qu'il expire ou s'autodétruise après un téléchargement. Les gens l'adoraient et le cherchent encore des années plus tard. Il ne reviendra pas — Mozilla a arrêté le service en 2020 — mais le besoin qu'il comblait reste bien réel.",
    "Le mode asynchrone (lien stocké) de Relayium reprend cette même idée : chiffrer dans le navigateur, partager un lien, le voir expirer ou s'autodétruire. Cet article est une comparaison honnête — ce que faisait Firefox Send, à quel point Relayium s'en rapproche, et où Relayium va plus loin avec le transfert pair-à-pair en temps réel, une CLI et l'auto-hébergement.",
  ],
  sections: [
    {
      heading: "Ce qu'était Firefox Send, et pourquoi on le regrette encore",
      body: [
        "Firefox Send a été lancé par Mozilla en 2019 comme un moyen simple et respectueux de la vie privée de partager des fichiers : téléversez un fichier, le navigateur le chiffrait, et vous obteniez un lien à envoyer où vous vouliez. Le destinataire n'avait besoin d'aucun compte pour télécharger. Vous pouviez régler le lien pour qu'il expire après un certain nombre de téléchargements ou après un délai donné, et Mozilla le présentait comme chiffré de bout en bout.",
        "Mozilla a fermé Firefox Send en septembre 2020, invoquant des abus du service pour la distribution de malwares et une décision de concentrer l'ingénierie ailleurs. Il n'y a eu aucun successeur de la part de Mozilla ni de plan annoncé pour le relancer — si vous espérez le voir revenir sous son ancien nom, cela n'arrivera pas. Cela a laissé un vrai vide : beaucoup de gens veulent toujours un moyen gratuit, privé, basé sur des liens, d'envoyer un fichier qui expire et que l'hébergeur ne peut pas lire.",
      ],
    },
    {
      heading: "Comment les liens stockés de Relayium reprennent cette idée",
      body: [
        "Le mode asynchrone de Relayium est construit autour de la même expérience. Vous choisissez vos fichiers, votre navigateur génère localement une clé AES-256-GCM aléatoire, chiffre les fichiers avec elle, et téléverse le texte chiffré. Le serveur ne voit jamais la clé et ne peut pas déchiffrer ce qu'il stocke — c'est réellement à divulgation nulle, pas seulement « chiffré au repos ».",
        "La clé de déchiffrement ne voyage qu'à l'intérieur du lien lui-même, dans le fragment d'URL après le #, que les navigateurs ne transmettent jamais à un serveur. Quiconque reçoit le lien n'a besoin d'aucun compte pour télécharger — il l'ouvre simplement, et son navigateur récupère le texte chiffré et le déchiffre localement avec la clé du fragment. C'est la promesse centrale de Firefox Send, intacte : un lien qui porte sa propre clé et que le serveur qui l'héberge ne peut pas lire.",
      ],
    },
    {
      heading: "Expiration, autodestruction après lecture, et les limites honnêtes",
      body: [
        "Comme Firefox Send, chaque lien Relayium a une durée de vie que vous choisissez : 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre, ou vous pouvez le régler pour qu'il s'autodétruise après le tout premier téléchargement complet, si bien qu'il disparaît dès que votre destinataire a le fichier. Une fois qu'un lien expire ou s'autodétruit, le texte chiffré stocké est supprimé et le lien cesse de fonctionner.",
        "Pour être précis sur ce qui est stocké où : c'est un mode à lien stocké, donc les octets du fichier chiffré résident bel et bien sur le serveur de Relayium entre le téléversement et le téléchargement — c'est du texte chiffré à divulgation nulle que le serveur ne peut pas déchiffrer, mais ce n'est pas un dispositif où « le fichier ne touche jamais un serveur ». Créer un lien exige que l'expéditeur se connecte (cela est lié au quota de stockage de votre compte) ; le destinataire n'a jamais besoin de compte pour ouvrir ou télécharger.",
      ],
    },
    {
      heading: "Au-delà du partage de liens : transfert en temps réel, CLI et auto-hébergement",
      body: [
        "Firefox Send ne faisait qu'une seule chose — le partage de liens chiffrés asynchrone — et le mode stocké de Relayium couvre ce terrain. Mais Relayium a aussi un mode que Firefox Send n'a jamais offert : le transfert pair-à-pair en temps réel, où les fichiers circulent directement entre deux navigateurs ouverts via un canal WebRTC chiffré de bout en bout, sans jamais rien stocker sur un serveur. Sur le même réseau, aucun compte n'est requis d'un côté comme de l'autre ; envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte, le destinataire n'en ayant toujours pas besoin.",
        "Pour ceux qui veulent plus de contrôle, Relayium propose aussi une CLI gratuite et open source (push/pull via SSH, send/receive entre réseaux, synchronisation de dossiers) et un serveur auto-hébergeable que vous pouvez faire tourner vous-même — rien de tout cela n'a jamais existé chez Firefox Send. L'ensemble du projet est sous licence AGPL-3.0 et open source sur GitHub.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Firefox Send va-t-il revenir ?",
        a: "Non. Mozilla a arrêté Firefox Send en septembre 2020 et ne l'a ni relancé ni annoncé de successeur. Le mode lien stocké de Relayium est un projet distinct, développé indépendamment, conçu pour combler le même vide.",
      },
      {
        q: "Relayium est-il aussi privé que l'était Firefox Send ?",
        a: "Oui, et la conception est même plus solide sur un point : votre navigateur génère localement une clé AES-256-GCM aléatoire, et la clé ne vit que dans le fragment d'URL du lien, qui n'est jamais envoyé au serveur. Le serveur ne stocke que du texte chiffré qu'il ne peut pas déchiffrer — un véritable dispositif à divulgation nulle.",
      },
      {
        q: "Les liens expirent-ils ?",
        a: "Oui. Choisissez 1 heure, 1 jour, 3 jours, 7 jours ou jusqu'à 14 jours selon votre offre, ou réglez le lien pour qu'il s'autodétruise après le premier téléchargement complet. Ensuite, le texte chiffré stocké est supprimé et le lien ne fonctionne plus.",
      },
      {
        q: "Relayium est-il gratuit ?",
        a: "Oui. Relayium est gratuit et open source sous licence AGPL-3.0. Créer un lien de téléchargement stocké exige que l'expéditeur se connecte (les liens comptent dans le quota de stockage de votre compte), mais le destinataire n'a jamais besoin de compte pour télécharger.",
      },
    ],
  },
  cta: {
    text: "Envoyez un lien privé et expirant comme au temps de Firefox Send — chiffré dans votre navigateur, illisible pour le serveur.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "أفضل بديل لـ Firefox Send في 2026",
  description:
    "أُغلق Firefox Send في 2020. يعيد Relayium مشاركة الروابط المشفّرة الخاصة والمنتهية الصلاحية — مفتاح عشوائي يُولَّد في متصفحك، وتخزين بمعرفة صفرية، ولا حاجة إلى حساب للتنزيل.",
  updatedLabel: "آخر تحديث",
  lead: [
    "كان Firefox Send رؤية Mozilla لمشاركة الملفات الخاصة: تضع ملفًا، فتحصل على رابط مشفّر، وتضبطه لينتهي أو يُحذف بعد تنزيل واحد. أحبّه الناس ولا يزالون يبحثون عنه بعد سنوات. لن يعود — فقد أوقفت Mozilla الخدمة في 2020 — لكن الحاجة التي كان يلبّيها لا تزال قائمة فعلًا.",
    "يلتقط وضع Relayium غير المتزامن (رابط مُخزَّن) الفكرة ذاتها: التشفير في المتصفح، ومشاركة رابط، ومراقبته وهو ينتهي أو يُحذف. هذه المقالة مقارنة صادقة — ماذا كان Firefox Send يفعل، وكم يقترب منه Relayium، وأين يذهب Relayium أبعد من ذلك بالنقل الفوري من الند للند، وواجهة سطر الأوامر CLI، والاستضافة الذاتية.",
  ],
  sections: [
    {
      heading: "ماذا كان Firefox Send، ولماذا لا يزال الناس يفتقدونه",
      body: [
        "أطلقت Mozilla خدمة Firefox Send في 2019 كطريقة بسيطة تراعي الخصوصية لمشاركة الملفات: ترفع ملفًا، فيشفّره المتصفح، وتحصل على رابط يمكنك إرساله إلى أي مكان. لم يكن المُستقبِل بحاجة إلى حساب للتنزيل. كان بإمكانك ضبط الرابط لينتهي بعد عدد من عمليات التنزيل أو بعد مدة محددة، وكانت Mozilla تسوّقه على أنه مشفّر من الطرف إلى الطرف.",
        "أوقفت Mozilla خدمة Firefox Send في سبتمبر 2020، مشيرةً إلى إساءة استخدام الخدمة لنشر البرمجيات الخبيثة وقرارٍ بتركيز الهندسة في مكان آخر. لم يظهر خلَف من Mozilla ولا أي خطط معلنة لإحيائها — إن كنت تأمل عودته باسمه القديم، فلن يحدث ذلك. وقد ترك هذا فجوة حقيقية: لا يزال كثيرون يريدون طريقة مجانية وخاصة قائمة على الروابط لإرسال ملف ينتهي ولا يستطيع مزوّد الاستضافة قراءته.",
      ],
    },
    {
      heading: "كيف تطابق الروابط المُخزَّنة في Relayium تلك الفكرة",
      body: [
        "بُني وضع Relayium غير المتزامن حول الشكل ذاته من التجربة. تختار ملفاتك، فيولّد متصفحك مفتاح AES-256-GCM عشوائيًا محليًا، ويشفّر الملفات به، ويرفع النص المُشفَّر. لا يرى الخادم المفتاح أبدًا ولا يمكنه فكّ تشفير ما يخزّنه — إنها معرفة صفرية بحق، وليست مجرد «تشفير في حالة السكون».",
        "ينتقل مفتاح فكّ التشفير داخل الرابط نفسه فقط، في جزء الـ URL بعد علامة #، وهو ما لا ترسله المتصفحات أبدًا إلى أي خادم. أيّ من يستقبل الرابط لا يحتاج إلى حساب للتنزيل — يفتحه فحسب، فيجلب متصفحه النص المُشفَّر ويفكّ تشفيره محليًا بالمفتاح المأخوذ من ذلك الجزء. هذا هو وعد Firefox Send الجوهري سليمًا: رابط يحمل مفتاحه الخاص ولا يستطيع الخادم الذي يستضيفه قراءته.",
      ],
    },
    {
      heading: "الانتهاء، والحذف بعد القراءة، والحدود المذكورة بصدق",
      body: [
        "مثل Firefox Send، لكل رابط في Relayium عمر تختاره أنت: ساعة واحدة أو يوم واحد أو 3 أيام أو 7 أيام أو حتى 14 يومًا حسب خطتك، أو يمكنك ضبطه ليُحذف بعد أول تنزيل كامل فيزول لحظة حصول المُستقبِل على الملف. بمجرد أن ينتهي الرابط أو يُحذف، يُحذف النص المُشفَّر المُخزَّن ويتوقف الرابط عن العمل.",
        "لكي نكون دقيقين بشأن ما يُخزَّن وأين: هذا وضع رابط مُخزَّن، لذا فإن بايتات الملف المشفّرة تستقر فعلًا على خادم Relayium بين الرفع والتنزيل — إنه نص مُشفَّر بمعرفة صفرية لا يستطيع الخادم فكّ تشفيره، لكنه ليس إعدادًا من نوع «الملف لا يلمس خادمًا أبدًا». يتطلب إنشاء رابط تسجيل دخول المُرسِل (فهو مرتبط بحصة التخزين في حسابك)؛ أما المُستقبِل فلا يحتاج إلى حساب أبدًا لفتحه أو تنزيله.",
      ],
    },
    {
      heading: "أبعد من مشاركة الروابط: النقل الفوري، وواجهة سطر الأوامر، والاستضافة الذاتية",
      body: [
        "لم يفعل Firefox Send سوى شيء واحد — مشاركة روابط مشفّرة غير متزامنة — ووضع Relayium المُخزَّن يغطي تلك الأرضية. لكن لدى Relayium أيضًا وضعًا لم يقدّمه Firefox Send قط: النقل الفوري من الند للند، حيث تتدفق الملفات مباشرةً بين متصفحين مفتوحين عبر قناة WebRTC مشفّرة من الطرف إلى الطرف، ولا يُخزَّن أي شيء على خادم على الإطلاق. على نفس الشبكة لا يحتاج أي من الطرفين إلى حساب؛ أما الإرسال عبر الشبكات برمز اقتران فيتطلب تسجيل دخول المُرسِل، ويظل المُستقبِل لا يحتاج إلى ذلك أبدًا.",
        "لمن يريدون مزيدًا من التحكم، يوفّر Relayium أيضًا واجهة سطر أوامر CLI مجانية ومفتوحة المصدر (push/pull عبر SSH، وإرسال/استقبال عبر الشبكات، ومزامنة المجلدات) وخادمًا قابلًا للاستضافة الذاتية يمكنك تشغيله بنفسك — ولم يكن أيٌّ من هذا موجودًا في Firefox Send قط. المشروع بأكمله مرخّص بموجب AGPL-3.0 ومفتوح المصدر على GitHub.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل سيعود Firefox Send؟",
        a: "لا. أوقفت Mozilla خدمة Firefox Send في سبتمبر 2020 ولم تُحيِها ولم تعلن عن خلَف لها. وضع الرابط المُخزَّن في Relayium مشروع منفصل بُني باستقلالية ليملأ الفجوة نفسها.",
      },
      {
        q: "هل Relayium خاص بقدر ما كان Firefox Send؟",
        a: "نعم، والتصميم أقوى في جانب واحد: يولّد متصفحك مفتاح AES-256-GCM عشوائيًا محليًا، ويعيش المفتاح في جزء الـ URL من الرابط فقط، وهو ما لا يُرسَل إلى الخادم أبدًا. لا يخزّن الخادم سوى نص مُشفَّر لا يستطيع فكّ تشفيره — إعداد معرفة صفرية حقيقي.",
      },
      {
        q: "هل تنتهي الروابط؟",
        a: "نعم. اختر ساعة واحدة أو يومًا واحدًا أو 3 أيام أو 7 أيام أو حتى 14 يومًا حسب خطتك، أو اضبط الرابط ليُحذف بعد أول تنزيل كامل. بعد ذلك يُحذف النص المُشفَّر المُخزَّن ولا يعمل الرابط بعدها.",
      },
      {
        q: "هل Relayium مجاني؟",
        a: "نعم. Relayium مجاني ومفتوح المصدر بموجب رخصة AGPL-3.0. يتطلب إنشاء رابط تنزيل مُخزَّن تسجيل دخول المُرسِل (تُحتسب الروابط ضمن حصة التخزين في حسابك)، لكن المُستقبِل لا يحتاج إلى حساب أبدًا للتنزيل.",
      },
    ],
  },
  cta: {
    text: "أرسل رابطًا خاصًا منتهي الصلاحية كما كان Firefox Send يفعل — مشفّرًا في متصفحك، غير قابل للقراءة من الخادم.",
    button: "جرّب Relayium الآن",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "La mejor alternativa a Firefox Send en 2026",
  description:
    "Firefox Send cerró en 2020. Relayium recupera el uso compartido de enlaces cifrados, privados y con caducidad: una clave aleatoria generada en tu navegador, almacenamiento de conocimiento cero y sin necesidad de cuenta para descargar.",
  updatedLabel: "Última actualización",
  lead: [
    "Firefox Send era la propuesta de Mozilla para compartir archivos de forma privada: sueltas un archivo, obtienes un enlace cifrado y lo configuras para que caduque o se destruya tras una sola descarga. A la gente le encantaba y lo sigue buscando años después. No va a volver —Mozilla descontinuó el servicio en 2020—, pero la necesidad que cubría sigue siendo real.",
    "El modo asíncrono (enlace almacenado) de Relayium retoma esa misma idea: cifrar en el navegador, compartir un enlace, verlo caducar o destruirse. Este artículo es una comparativa honesta: qué hacía Firefox Send, cuánto se le acerca Relayium y dónde Relayium va más allá con la transferencia en tiempo real de igual a igual, una CLI y el autoalojamiento.",
  ],
  sections: [
    {
      heading: "Qué era Firefox Send y por qué la gente aún lo echa de menos",
      body: [
        "Firefox Send se lanzó desde Mozilla en 2019 como una forma sencilla y respetuosa con la privacidad de compartir archivos: subes un archivo, el navegador lo cifraba y obtenías un enlace que podías enviar a cualquier parte. El destinatario no necesitaba cuenta para descargar. Podías configurar el enlace para que caducara tras cierto número de descargas o pasado un tiempo determinado, y Mozilla lo promocionaba como cifrado de extremo a extremo.",
        "Mozilla cerró Firefox Send en septiembre de 2020, alegando el abuso del servicio para distribuir malware y la decisión de centrar la ingeniería en otra parte. No ha habido ningún sucesor por parte de Mozilla ni planes anunciados para revivirlo: si esperas que vuelva con su antiguo nombre, no lo hará. Eso ha dejado un vacío real: mucha gente todavía quiere una forma gratuita, privada y basada en enlaces de enviar un archivo que caduque y que el proveedor que lo aloja no pueda leer.",
      ],
    },
    {
      heading: "Cómo los enlaces almacenados de Relayium encajan con esa idea",
      body: [
        "El modo asíncrono de Relayium se construye en torno a la misma forma de experiencia. Eliges tus archivos, tu navegador genera localmente una clave AES-256-GCM aleatoria, cifra los archivos con ella y sube el texto cifrado. El servidor nunca ve la clave y no puede descifrar lo que almacena: es genuinamente de conocimiento cero, no solo «cifrado en reposo».",
        "La clave de descifrado viaja únicamente dentro del propio enlace, en el fragmento de la URL tras el #, que los navegadores nunca transmiten a ningún servidor. Quien recibe el enlace no necesita cuenta para descargar: simplemente lo abre, y su navegador obtiene el texto cifrado y lo descifra localmente con la clave del fragmento. Esa es la promesa central de Firefox Send, intacta: un enlace que lleva su propia clave y que el servidor que lo aloja no puede leer.",
      ],
    },
    {
      heading: "Caducidad, destrucción tras la lectura y los límites honestos",
      body: [
        "Como en Firefox Send, cada enlace de Relayium tiene una vida útil que tú eliges: 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o puedes configurarlo para que se destruya tras la primera descarga completa, de modo que desaparece en cuanto tu destinatario tiene el archivo. Una vez que un enlace caduca o se destruye, el texto cifrado almacenado se elimina y el enlace deja de funcionar.",
        "Para ser precisos sobre qué se almacena y dónde: este es un modo de enlace almacenado, así que los bytes del archivo cifrado sí que residen en el servidor de Relayium entre la subida y la descarga; es texto cifrado de conocimiento cero que el servidor no puede descifrar, pero no es un montaje en el que «el archivo nunca toca un servidor». Crear un enlace exige que el remitente inicie sesión (está vinculado a la cuota de almacenamiento de tu cuenta); el destinatario nunca necesita cuenta para abrirlo o descargarlo.",
      ],
    },
    {
      heading: "Más allá de compartir enlaces: transferencia en tiempo real, una CLI y autoalojamiento",
      body: [
        "Firefox Send solo hizo una cosa —compartir enlaces cifrados de forma asíncrona— y el modo almacenado de Relayium cubre ese terreno. Pero Relayium también tiene un modo que Firefox Send nunca ofreció: la transferencia en tiempo real de igual a igual, en la que los archivos fluyen directamente entre dos navegadores abiertos a través de un canal WebRTC cifrado de extremo a extremo y no se almacena nada en ningún servidor. En la misma red no necesita cuenta ninguna de las partes; enviar entre redes con un código de emparejamiento requiere que el remitente inicie sesión, y el receptor sigue sin necesitarla nunca.",
        "Para quienes quieren más control, Relayium también incluye una CLI gratuita y de código abierto (push/pull por SSH, envío/recepción entre redes, sincronización de carpetas) y un servidor autoalojable que puedes ejecutar tú mismo, nada de lo cual tuvo nunca Firefox Send. Todo el proyecto está bajo licencia AGPL-3.0 y es de código abierto en GitHub.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Va a volver Firefox Send?",
        a: "No. Mozilla descontinuó Firefox Send en septiembre de 2020 y no lo ha revivido ni ha anunciado un sucesor. El modo de enlace almacenado de Relayium es un proyecto independiente y construido por separado, diseñado para llenar el mismo vacío.",
      },
      {
        q: "¿Es Relayium tan privado como lo era Firefox Send?",
        a: "Sí, y el diseño es más fuerte en un aspecto: tu navegador genera localmente una clave AES-256-GCM aleatoria, y la clave vive únicamente en el fragmento de la URL del enlace, que nunca se envía al servidor. El servidor solo almacena texto cifrado que no puede descifrar: un montaje de conocimiento cero de verdad.",
      },
      {
        q: "¿Caducan los enlaces?",
        a: "Sí. Elige 1 hora, 1 día, 3 días, 7 días o hasta 14 días según tu plan, o configura el enlace para que se destruya tras la primera descarga completa. Después de eso, el texto cifrado almacenado se elimina y el enlace ya no funciona.",
      },
      {
        q: "¿Es Relayium gratis?",
        a: "Sí. Relayium es gratis y de código abierto bajo la licencia AGPL-3.0. Crear un enlace de descarga almacenado requiere que el remitente inicie sesión (los enlaces cuentan para la cuota de almacenamiento de tu cuenta), pero el destinatario nunca necesita cuenta para descargar.",
      },
    ],
  },
  cta: {
    text: "Envía un enlace privado y con caducidad como solía hacerlo Firefox Send: cifrado en tu navegador, ilegible para el servidor.",
    button: "Prueba Relayium ahora",
  },
  relatedHeading: "Sigue leyendo",
};

const pt = {
  title: "A melhor alternativa ao Firefox Send em 2026",
  description:
    "O Firefox Send encerrou em 2020. O Relayium traz de volta o compartilhamento de links criptografados, privados e com expiração: uma chave aleatória gerada no seu navegador, armazenamento de conhecimento zero e sem necessidade de conta para baixar.",
  updatedLabel: "Última atualização",
  lead: [
    "O Firefox Send era a proposta da Mozilla para o compartilhamento privado de arquivos: você solta um arquivo, recebe um link criptografado e o configura para expirar ou se autodestruir após um único download. As pessoas adoravam e ainda o procuram anos depois. Ele não vai voltar — a Mozilla descontinuou o serviço em 2020 —, mas a necessidade que ele atendia continua real.",
    "O modo assíncrono (link armazenado) do Relayium retoma a mesma ideia: criptografar no navegador, compartilhar um link, vê-lo expirar ou se autodestruir. Este artigo é uma comparação honesta: o que o Firefox Send fazia, o quanto o Relayium chega perto disso e onde o Relayium vai além com a transferência em tempo real ponto a ponto, uma CLI e a auto-hospedagem.",
  ],
  sections: [
    {
      heading: "O que era o Firefox Send e por que as pessoas ainda sentem falta dele",
      body: [
        "O Firefox Send foi lançado pela Mozilla em 2019 como uma forma simples e voltada à privacidade de compartilhar arquivos: você envia um arquivo, o navegador o criptografava e você recebia um link que podia mandar para qualquer lugar. O destinatário não precisava de conta para baixar. Você podia configurar o link para expirar após um certo número de downloads ou depois de um tempo determinado, e a Mozilla o divulgava como criptografado de ponta a ponta.",
        "A Mozilla encerrou o Firefox Send em setembro de 2020, citando o abuso do serviço para distribuir malware e a decisão de concentrar a engenharia em outro lugar. Não houve nenhum sucessor da Mozilla nem planos anunciados para revivê-lo: se você espera que ele volte com o nome antigo, isso não acontecerá. Isso deixou uma lacuna real: muita gente ainda quer uma forma gratuita, privada e baseada em links de enviar um arquivo que expire e que o provedor de hospedagem não consiga ler.",
      ],
    },
    {
      heading: "Como os links armazenados do Relayium correspondem a essa ideia",
      body: [
        "O modo assíncrono do Relayium é construído em torno do mesmo formato de experiência. Você escolhe seus arquivos, seu navegador gera localmente uma chave AES-256-GCM aleatória, criptografa os arquivos com ela e envia o texto cifrado. O servidor nunca vê a chave e não consegue descriptografar o que armazena — é genuinamente de conhecimento zero, não apenas “criptografado em repouso”.",
        "A chave de descriptografia viaja apenas dentro do próprio link, no fragmento da URL após o #, que os navegadores nunca transmitem a nenhum servidor. Quem recebe o link não precisa de conta para baixar — basta abri-lo, e o navegador busca o texto cifrado e o descriptografa localmente com a chave do fragmento. Essa é a promessa central do Firefox Send, intacta: um link que carrega a própria chave e que o servidor que o hospeda não consegue ler.",
      ],
    },
    {
      heading: "Expiração, autodestruição após a leitura e os limites honestos",
      body: [
        "Assim como no Firefox Send, cada link do Relayium tem um tempo de vida que você escolhe: 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou você pode configurá-lo para se autodestruir após o primeiríssimo download completo, de modo que desaparece no momento em que seu destinatário tem o arquivo. Depois que um link expira ou se autodestrói, o texto cifrado armazenado é excluído e o link para de funcionar.",
        "Para ser preciso sobre o que é armazenado e onde: este é um modo de link armazenado, então os bytes do arquivo criptografado realmente ficam no servidor do Relayium entre o envio e o download — é texto cifrado de conhecimento zero que o servidor não consegue descriptografar, mas não é uma configuração em que “o arquivo nunca toca um servidor”. Criar um link exige que o remetente faça login (está ligado à cota de armazenamento da sua conta); o destinatário nunca precisa de conta para abri-lo ou baixá-lo.",
      ],
    },
    {
      heading: "Além do compartilhamento de links: transferência em tempo real, uma CLI e auto-hospedagem",
      body: [
        "O Firefox Send só fez uma coisa — compartilhamento de links criptografados de forma assíncrona — e o modo armazenado do Relayium cobre esse terreno. Mas o Relayium também tem um modo que o Firefox Send nunca ofereceu: a transferência em tempo real ponto a ponto, em que os arquivos fluem diretamente entre dois navegadores abertos por um canal WebRTC criptografado de ponta a ponta e nada é armazenado em nenhum servidor. Na mesma rede, nenhum dos lados precisa de conta; enviar entre redes com um código de emparelhamento exige que o remetente faça login, e o receptor continua nunca precisando.",
        "Para quem quer mais controle, o Relayium também traz uma CLI gratuita e de código aberto (push/pull por SSH, envio/recebimento entre redes, sincronização de pastas) e um servidor auto-hospedável que você mesmo pode rodar — nada disso o Firefox Send jamais teve. Todo o projeto é licenciado sob AGPL-3.0 e de código aberto no GitHub.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O Firefox Send vai voltar?",
        a: "Não. A Mozilla descontinuou o Firefox Send em setembro de 2020 e não o reviveu nem anunciou um sucessor. O modo de link armazenado do Relayium é um projeto separado, construído de forma independente, feito para preencher a mesma lacuna.",
      },
      {
        q: "O Relayium é tão privado quanto o Firefox Send era?",
        a: "Sim, e o design é mais forte em um aspecto: seu navegador gera localmente uma chave AES-256-GCM aleatória, e a chave vive apenas no fragmento da URL do link, que nunca é enviado ao servidor. O servidor armazena somente texto cifrado que não consegue descriptografar — uma configuração de conhecimento zero de verdade.",
      },
      {
        q: "Os links expiram?",
        a: "Sim. Escolha 1 hora, 1 dia, 3 dias, 7 dias ou até 14 dias conforme o seu plano, ou configure o link para se autodestruir após o primeiro download completo. Depois disso, o texto cifrado armazenado é excluído e o link não funciona mais.",
      },
      {
        q: "O Relayium é gratuito?",
        a: "Sim. O Relayium é gratuito e de código aberto sob a licença AGPL-3.0. Criar um link de download armazenado exige que o remetente faça login (os links contam para a cota de armazenamento da sua conta), mas o destinatário nunca precisa de conta para baixar.",
      },
    ],
  },
  cta: {
    text: "Envie um link privado e com expiração como o Firefox Send fazia — criptografado no seu navegador, ilegível para o servidor.",
    button: "Experimente o Relayium agora",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/firefox-send",
  published: "2026-07-09",
  updated: "2026-07-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
