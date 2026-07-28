// web/scripts/pages/content/legal/privacy.mjs
const en = {
  title: "Privacy Policy",
  description:
    "How Relayium handles your data: realtime direct transfers go peer-to-peer and never touch our servers; the stored download-link mode keeps files zero-knowledge encrypted. Accounts are optional and store only an email and display name.",
  updatedLabel: "Last updated",
  updated: "2026-07-21",
  otherDocLabel: "Terms of Service",
  lead: [
    "Relayium is built so that your files stay yours. Realtime direct transfers go peer-to-peer, end-to-end encrypted, and never pass through our servers; the optional stored download-link mode uses zero-knowledge encryption — the server holds only ciphertext it cannot read.",
    "This page explains the little data the service does handle, and the data it deliberately never sees.",
  ],
  sections: [
    {
      heading: "Local-network transfers collect nothing",
      body: [
        "When you transfer files between devices on the same network, no account is needed and the service stores nothing about you. The signaling server only helps the two devices find each other; the file bytes flow device-to-device over an encrypted WebRTC channel.",
      ],
    },
    {
      heading: "What an account stores (only if you sign in)",
      body: [
        "Same-network (LAN) transfers need no account. Sending across networks with a pairing code requires the sender to sign in — the person receiving never needs an account. Creating a stored download link also requires signing in. If you sign in, we store the minimum needed to run an account:",
      ],
      bullets: [
        "Your email address and a display name.",
        "Which sign-in method you used (Sign in with Apple, Google, an email magic link, or email + password). Magic-link tokens are stored only as a hash, never in clear text; if you set a password, we store only its bcrypt hash, never the password itself. If you use Sign in with Apple with Apple's private email relay, we only ever see that relay address.",
        "A login session, kept in a secure, httpOnly cookie.",
        "Devices you register, as a random device id and a device name (e.g. your platform name).",
      ],
    },
    {
      heading: "Stored transfer (download links)",
      body: [
        "When you use the optional stored download-link mode, your browser encrypts your files with AES-256-GCM before they leave your device. The decryption key exists only in the URL fragment — it is never sent to the server. This means:",
      ],
      bullets: [
        "The server stores only ciphertext. It cannot read your file contents, filenames, or keys.",
        "We record the ciphertext size and timestamps (upload time, expiry) for quota management and cleanup.",
        "Ciphertext is automatically deleted at expiry or on the first complete download (burn-after-read), whichever comes first.",
      ],
    },
    {
      heading: "What we never collect",
      body: ["The service is designed so that the following never reach our servers:"],
      bullets: [
        "The contents of your files.",
        "The names of your files.",
        "Your encryption keys.",
      ],
    },
    {
      heading: "Cross-network relay (TURN)",
      body: [
        "Browser transfers across networks are relayed through a TURN server by design, not only as a fallback when a direct connection fails. The relay still cannot read your files — they remain end-to-end encrypted. We record the number of relayed bytes per account, to enforce a monthly relay allowance and prevent abuse — we never inspect what is relayed, only the byte count.",
      ],
    },
    {
      heading: "Cookies and local storage",
      body: [
        "We use one session cookie to keep you signed in. In your browser's local storage we keep a random device id so a device you registered can be recognized. We do not use advertising or tracking cookies.",
      ],
    },
    {
      heading: "Third-party services",
      body: ["A few third parties are involved only when you choose to use them:"],
      bullets: [
        "Google, if you sign in with Google — we receive your email and basic profile to create the account.",
        "Apple, if you use Sign in with Apple — we receive a stable identifier and the email (or Apple's private relay address) you choose to share.",
        "Stripe, our payment processor for subscriptions purchased on the web — see Payments.",
        "Apple, for subscriptions purchased inside the iOS app via in-app purchase — see Payments.",
        "An email delivery provider, to send account emails such as magic-link sign-in and verification.",
      ],
    },
    {
      heading: "Payments",
      body: [
        "You only share payment data if you buy a paid plan. We never receive or store your full card number.",
      ],
      bullets: [
        "On the web, payments are handled by Stripe. Card details go to Stripe, not to us; we receive only a customer reference and the resulting subscription status.",
        "In the iOS app, subscriptions are bought through Apple in-app purchase. Apple processes the payment under your Apple ID; we receive only that you hold an active subscription.",
        "For your account we store only your current plan, subscription status, billing cycle, and period dates — never card data.",
      ],
    },
    {
      heading: "The Relayium app",
      body: [
        "Our native apps handle a little device-level data that the website does not:",
      ],
      bullets: [
        "Push notifications: if you enable them, we store an Apple Push Notification service (APNs) device token so we can deliver notifications to your device. You can turn notifications off at any time in your device settings.",
        "Camera and photos: used only on your device to scan a QR code or pick files to send. Nothing is captured or uploaded from the camera or your library except the files you deliberately choose to transfer.",
        "The app does not track you across other apps or websites, and contains no advertising or third-party analytics SDKs.",
      ],
    },
    {
      heading: "Data retention and deletion",
      body: [
        "Account data is kept while your account exists. You can delete your account and its data at any time from your account settings, in the app or on the web. Deletion starts a 30-day grace period during which you can undo it by signing back in; after that, your account and personal data are permanently removed. Aggregate usage counters we must keep for billing and abuse-prevention are anonymized so they are no longer linked to you.",
      ],
    },
    {
      heading: "Your rights",
      body: [
        "You can access, correct, export, or delete your account data, and object to or restrict certain processing. Most of this you can do yourself in your account settings; for anything else, email support@relayium.com. We do not sell your personal data. Where the GDPR or similar laws apply, our basis for the little data we process is performing the service you asked for and our legitimate interest in keeping it secure and preventing abuse.",
      ],
    },
    {
      heading: "Children",
      body: [
        "Relayium is not directed to children. We do not knowingly collect personal data from anyone under 13, or under the minimum age of digital consent where you live. If you believe a child has given us data, contact support@relayium.com and we will delete it.",
      ],
    },
    {
      heading: "Changes to this policy",
      body: [
        "We may update this policy as the service evolves. When we do, we will change the \"Last updated\" date above.",
      ],
    },
    {
      heading: "Contact",
      body: ["Questions about privacy? Email support@relayium.com."],
    },
  ],
};

const zh = {
  title: "隐私政策",
  description:
    "Relayium 如何处理你的数据：实时直连传输以点对点方式进行，绝不经过我们的服务器；暂存下载链接模式保持文件零知识加密。账号是可选的，仅存储邮箱与显示名。",
  updatedLabel: "最后更新",
  updated: "2026-07-21",
  otherDocLabel: "服务条款",
  lead: [
    "Relayium 的设计宗旨是让你的文件始终属于你。实时直连传输以点对点方式进行，端到端加密，绝不经过我们的服务器；可选的暂存下载链接模式采用零知识加密——服务器仅存储无法解读的密文。",
    "本页说明本服务确实会处理的少量数据，以及它刻意从不接触的数据。",
  ],
  sections: [
    {
      heading: "局域网传输不收集任何数据",
      body: [
        "在同一网络下的设备之间传输文件时，无需账号，服务也不会存储任何关于你的信息。信令服务器只帮助两台设备相互发现；文件字节通过加密的 WebRTC 通道在设备之间直接流动。",
      ],
    },
    {
      heading: "账号会存储什么（仅在你登录时）",
      body: ["同一网络（局域网）内的传输无需账号。跨网络使用配对码传输时，需要发送方登录——接收方始终无需账号。创建暂存下载链接同样需要登录。如果你登录，我们只存储运行账号所必需的最少信息："],
      bullets: [
        "你的邮箱地址和显示名。",
        "你使用的登录方式（通过 Apple 登录、Google、邮箱魔法链接，或邮箱+密码）。魔法链接令牌只以哈希形式存储，绝不明文保存；如果你设置了密码，我们只存储其 bcrypt 哈希值，绝不存储密码本身。如果你使用「通过 Apple 登录」并选择 Apple 的私密邮件转发，我们只会看到该转发地址。",
        "登录会话，保存在安全的 httpOnly cookie 中。",
        "你注册的设备，以一个随机设备 id 和设备名（例如你的平台名称）的形式。",
      ],
    },
    {
      heading: "暂存传输（下载链接）",
      body: [
        "使用可选的暂存下载链接功能时，你的浏览器在文件离开设备前即以 AES-256-GCM 加密。解密密钥仅存在于链接的 URL 片段（# 部分）中，绝不发送至服务器。这意味着：",
      ],
      bullets: [
        "服务器仅存储密文，无法读取你的文件内容、文件名或密钥。",
        "我们记录密文大小和时间戳（上传时间、有效期）用于配额管理和清理。",
        "密文在到期或首次完整下载（阅后即焚）时自动删除，以较早发生者为准。",
      ],
    },
    {
      heading: "我们绝不收集什么",
      body: ["本服务的设计确保以下内容绝不会到达我们的服务器："],
      bullets: ["你的文件内容。", "你的文件名。", "你的加密密钥。"],
    },
    {
      heading: "跨网络中继（TURN）",
      body: [
        "浏览器的跨网络传输按设计经 TURN 服务器中继，而不只是在直连失败时才回退到中继。中继依然无法读取你的文件——它们始终保持端到端加密。我们按账号记录中继字节数，用于执行每月中继额度限制并防止滥用——我们绝不检查中继的内容，只记录字节数。",
      ],
    },
    {
      heading: "Cookie 与本地存储",
      body: [
        "我们使用一个会话 cookie 来保持你的登录状态。在你浏览器的本地存储中，我们保存一个随机设备 id，以便识别你注册过的设备。我们不使用广告或追踪 cookie。",
      ],
    },
    {
      heading: "第三方服务",
      body: ["只有在你选择使用时，才会涉及少数第三方："],
      bullets: [
        "Google——如果你用 Google 登录，我们会获取你的邮箱和基本资料以创建账号。",
        "Apple——如果你使用「通过 Apple 登录」，我们会获取一个稳定标识符，以及你选择分享的邮箱（或 Apple 的私密转发地址）。",
        "Stripe——我们在网页端订阅的支付处理方，详见「支付」。",
        "Apple——在 iOS App 内通过应用内购买订阅时的处理方，详见「支付」。",
        "邮件发送服务商——用于发送账号邮件，如魔法链接登录与验证邮件。",
      ],
    },
    {
      heading: "支付",
      body: [
        "只有在你购买付费套餐时才会涉及支付数据。我们绝不接收或存储你的完整卡号。",
      ],
      bullets: [
        "在网页端，支付由 Stripe 处理。卡片信息提交给 Stripe，而非我们；我们只拿到一个客户标识和由此产生的订阅状态。",
        "在 iOS App 内，订阅通过 Apple 应用内购买完成。Apple 从你的 Apple ID 处理支付；我们只获知你持有一个有效订阅。",
        "就你的账号而言，我们只存储你当前的套餐、订阅状态、计费周期与周期起止日期——绝不存储卡片数据。",
      ],
    },
    {
      heading: "Relayium App",
      body: [
        "我们的原生 App 会处理少量网站不涉及的设备级数据：",
      ],
      bullets: [
        "推送通知：如果你开启，我们会存储一个 Apple 推送通知服务（APNs）设备令牌，以便向你的设备投递通知。你可以随时在设备设置中关闭通知。",
        "相机与相册：仅在你的设备本地用于扫描二维码或选择要发送的文件。除你主动选择传输的文件外，不会从相机或相册采集或上传任何内容。",
        "App 不会跨其他 App 或网站追踪你，也不含广告或第三方分析 SDK。",
      ],
    },
    {
      heading: "数据保留与删除",
      body: [
        "账号数据在你的账号存在期间保留。你可以随时在账号设置中（网页或 App 内）删除你的账号及其数据。删除会进入 30 天宽限期，期间你可重新登录撤销；之后你的账号及个人数据将被永久移除。因计费和防滥用而必须保留的汇总用量计数会被匿名化，不再与你关联。",
      ],
    },
    {
      heading: "你的权利",
      body: [
        "你可以访问、更正、导出或删除你的账号数据，并可反对或限制某些处理。其中大部分你可以自行在账号设置中完成；其他事项请发邮件至 support@relayium.com。我们不出售你的个人数据。在适用 GDPR 或类似法律的情况下，我们处理这少量数据的依据是履行你所请求的服务，以及我们在保障其安全、防止滥用方面的合法利益。",
      ],
    },
    {
      heading: "儿童",
      body: [
        "Relayium 并非面向儿童。我们不会在知情的情况下收集 13 岁以下（或你所在地数字同意最低年龄以下）任何人的个人数据。如果你认为有儿童向我们提供了数据，请联系 support@relayium.com，我们会将其删除。",
      ],
    },
    {
      heading: "本政策的变更",
      body: ["随着服务演进，我们可能会更新本政策。届时我们会更新上方的「最后更新」日期。"],
    },
    {
      heading: "联系我们",
      body: ["有隐私方面的疑问？请发邮件至 support@relayium.com。"],
    },
  ],
};

const ja = {
  title: "プライバシーポリシー",
  description:
    "Relayium がお客様のデータを扱う方法：リアルタイム直接転送はピアツーピアかつエンドツーエンド暗号化で行われ、当社のサーバーを通過しません。一時保存ダウンロードリンク機能はファイルをゼロ知識暗号化で保護します。アカウントは任意で、メールアドレスと表示名のみを保存します。",
  updatedLabel: "最終更新",
  updated: "2026-07-21",
  otherDocLabel: "利用規約",
  lead: [
    "Relayium は、ファイルが常にお客様のものであり続けるよう設計されています。リアルタイムの直接転送はピアツーピアかつエンドツーエンド暗号化で行われ、当社のサーバーを通過しません——オプションの一時保存ダウンロードリンク機能はゼロ知識暗号化を使用するため、サーバーには解読不能な暗号文のみが保存されます。",
    "このページでは、本サービスが実際に扱う少量のデータと、意図的に取得しないデータについて説明します。",
  ],
  sections: [
    {
      heading: "ローカルネットワーク転送ではデータを収集しません",
      body: [
        "同じネットワーク上のデバイス間でファイルを転送する場合、アカウントは不要で、サービスはお客様に関する情報を一切保存しません。シグナリングサーバーは 2 台のデバイスが互いを見つけるのを助けるだけで、ファイルの実体は暗号化された WebRTC チャネルを通じてデバイス間で直接やり取りされます。",
      ],
    },
    {
      heading: "アカウントに保存される情報（サインインした場合のみ）",
      body: [
        "同一ネットワーク（LAN）内の転送はアカウント不要です。ペアリングコードを使ってネットワークをまたいで送信する場合は、送信者のサインインが必要です——受信者はアカウント不要のままです。保存型ダウンロードリンクの作成にもサインインが必要です。サインインした場合、アカウントの運用に必要な最小限の情報のみを保存します：",
      ],
      bullets: [
        "メールアドレスと表示名。",
        "使用したサインイン方法（Apple でサインイン、Google、メールマジックリンク、またはメール+パスワード）。マジックリンクのトークンはハッシュ値のみ保存され、平文では保存されません。パスワードを設定した場合も、その bcrypt ハッシュのみを保存し、パスワード自体は保存しません。Apple のプライベートメールリレーを使用して「Apple でサインイン」した場合、当社が把握するのはそのリレーアドレスのみです。",
        "ログインセッション。安全な httpOnly クッキーに保存されます。",
        "登録したデバイス。ランダムなデバイス ID とデバイス名（例：プラットフォーム名）で管理されます。",
      ],
    },
    {
      heading: "一時保存転送（ダウンロードリンク）",
      body: [
        "オプションの一時保存ダウンロードリンク機能を使用する場合、ファイルはデバイスから送信される前にブラウザで AES-256-GCM 暗号化されます。復号キーは URL フラグメント（# 部分）にのみ存在し、サーバーには送信されません。つまり、次のとおりです。",
      ],
      bullets: [
        "サーバーは暗号文のみを保存します。ファイルの内容、ファイル名、キーを読み取ることはできません。",
        "クォータ管理とクリーンアップのために、暗号文サイズとタイムスタンプ（アップロード時刻、有効期限）を記録します。",
        "暗号文は有効期限切れまたは最初の完全なダウンロード（閲覧後削除）のいずれか早い方で自動削除されます。",
      ],
    },
    {
      heading: "収集しない情報",
      body: ["本サービスは設計上、以下の情報が当社のサーバーに届くことはありません："],
      bullets: [
        "ファイルの内容。",
        "ファイルの名前。",
        "暗号化キー。",
      ],
    },
    {
      heading: "クロスネットワーク中継（TURN）",
      body: [
        "ブラウザでネットワークをまたぐ転送は、直接接続が失敗したときのフォールバックとしてではなく、設計上つねに TURN サーバーを経由して中継されます。中継サーバーがお客様のファイルを読み取ることはできません——エンドツーエンド暗号化が維持されます。月間中継割り当ての管理と不正利用の防止のため、中継バイト数はアカウントごとに記録します——中継内容を検査することはなく、記録するのはバイト数のみです。",
      ],
    },
    {
      heading: "Cookie とローカルストレージ",
      body: [
        "サインイン状態を維持するために 1 つのセッション Cookie を使用します。ブラウザのローカルストレージには、登録済みデバイスを識別するためのランダムなデバイス ID を保存します。広告用または追跡用の Cookie は使用しません。",
      ],
    },
    {
      heading: "第三者サービス",
      body: ["お客様が利用を選択した場合にのみ、一部の第三者が関与します："],
      bullets: [
        "Google——Google でサインインする場合、アカウント作成のためにメールアドレスと基本プロフィール情報を受け取ります。",
        "Apple——「Apple でサインイン」を使用する場合、安定した識別子と、お客様が共有を選択したメールアドレス（または Apple のプライベートリレーアドレス）を受け取ります。",
        "Stripe——ウェブで購入したサブスクリプションの決済処理業者です。詳しくは「支払い」をご覧ください。",
        "Apple——iOS アプリ内でアプリ内課金により購入したサブスクリプションについて。詳しくは「支払い」をご覧ください。",
        "メール配信プロバイダー——マジックリンクのサインインや確認メールなど、アカウント関連メールの送信に使用します。",
      ],
    },
    {
      heading: "支払い",
      body: [
        "有料プランを購入した場合にのみ、支払いに関するデータが共有されます。当社がカード番号の全体を受け取ったり保存したりすることは一切ありません。",
      ],
      bullets: [
        "ウェブでは、支払いは Stripe が処理します。カード情報は当社ではなく Stripe に送られます。当社が受け取るのは顧客参照情報と、その結果としてのサブスクリプション状況のみです。",
        "iOS アプリでは、サブスクリプションは Apple のアプリ内課金を通じて購入されます。Apple がお客様の Apple ID のもとで支払いを処理します。当社が把握するのは、有効なサブスクリプションを保有しているという事実のみです。",
        "アカウントについて当社が保存するのは、現在のプラン、サブスクリプションの状況、請求サイクル、期間の日付のみであり、カード情報は一切保存しません。",
      ],
    },
    {
      heading: "Relayium アプリ",
      body: [
        "当社のネイティブアプリは、ウェブサイトでは扱わない、デバイスレベルの小さなデータを扱います：",
      ],
      bullets: [
        "プッシュ通知：有効にした場合、デバイスに通知を配信できるよう、Apple Push Notification service（APNs）のデバイストークンを保存します。通知はいつでもデバイスの設定でオフにできます。",
        "カメラと写真：QR コードのスキャンや送信するファイルの選択のためにのみ、デバイス上で使用されます。お客様が意図的に転送を選んだファイル以外、カメラやライブラリから何も取得・アップロードされません。",
        "アプリは他のアプリやウェブサイトを横断してお客様を追跡することはなく、広告や第三者の分析 SDK も含まれていません。",
      ],
    },
    {
      heading: "データの保持と削除",
      body: [
        "アカウントデータはアカウントが存在する間保持されます。アカウントとそのデータは、アプリまたはウェブのアカウント設定からいつでもご自身で削除できます。削除を行うと 30 日間の猶予期間が始まり、その間に再度サインインすることで取り消すことができます。その後、アカウントと個人データは完全に削除されます。課金と不正利用防止のために保持が必要な集計利用カウンターは匿名化され、お客様と紐づかなくなります。",
      ],
    },
    {
      heading: "お客様の権利",
      body: [
        "お客様は、ご自身のアカウントデータへのアクセス、訂正、エクスポート、削除を求めることができ、また特定の処理に異議を唱えたり制限を求めたりすることもできます。その大半はアカウント設定でご自身で行えます。それ以外については support@relayium.com までメールでご連絡ください。当社はお客様の個人データを販売しません。GDPR または類似の法律が適用される場合、当社がこの少量のデータを処理する法的根拠は、お客様が依頼したサービスの提供、および安全性の確保と不正利用の防止という当社の正当な利益です。",
      ],
    },
    {
      heading: "子どもについて",
      body: [
        "Relayium は子ども向けのサービスではありません。当社は、13 歳未満、またはお住まいの地域におけるデジタル同意の最低年齢未満の方から、意図的に個人データを収集することはありません。お子様が当社にデータを提供したと思われる場合は、support@relayium.com までご連絡ください。速やかに削除します。",
      ],
    },
    {
      heading: "このポリシーの変更",
      body: [
        "サービスの進化に伴い、このポリシーを更新することがあります。更新した場合は、上記の「最終更新」日付を変更します。",
      ],
    },
    {
      heading: "お問い合わせ",
      body: ["プライバシーに関するご質問は、support@relayium.com までメールでお問い合わせください。"],
    },
  ],
};

const ko = {
  title: "개인정보 처리방침",
  description:
    "Relayium이 데이터를 처리하는 방식: 실시간 직접 전송은 P2P로 이루어지며 저희 서버를 거치지 않습니다. 임시 보관 다운로드 링크 기능은 파일을 영지식 암호화로 보호합니다. 계정은 선택 사항이며 이메일 주소와 표시 이름만 저장합니다.",
  updatedLabel: "최종 업데이트",
  updated: "2026-07-21",
  otherDocLabel: "이용약관",
  lead: [
    "Relayium은 파일이 항상 사용자의 것으로 남도록 설계되었습니다. 실시간 직접 전송은 P2P로 이루어지며, 종단간 암호화가 적용되어 저희 서버를 통과하지 않습니다——선택적 임시 보관 다운로드 링크 기능은 영지식 암호화를 사용하여 서버에는 해독할 수 없는 암호문만 저장됩니다.",
    "이 페이지에서는 서비스가 실제로 처리하는 소량의 데이터와 의도적으로 수집하지 않는 데이터를 설명합니다.",
  ],
  sections: [
    {
      heading: "로컬 네트워크 전송은 아무것도 수집하지 않습니다",
      body: [
        "동일한 네트워크상의 기기 간에 파일을 전송할 때는 계정이 필요하지 않으며 서비스는 사용자에 관한 어떤 정보도 저장하지 않습니다. 시그널링 서버는 두 기기가 서로를 찾도록 도울 뿐이며, 파일 데이터는 암호화된 WebRTC 채널을 통해 기기 간에 직접 전송됩니다.",
      ],
    },
    {
      heading: "계정에 저장되는 정보(로그인한 경우에만)",
      body: [
        "동일 네트워크(LAN) 내 전송은 계정이 필요 없습니다. 페어링 코드로 네트워크를 넘나들며 전송하려면 발신자가 로그인해야 합니다——수신자는 여전히 계정이 필요 없습니다. 저장형 다운로드 링크를 만드는 데도 로그인이 필요합니다. 로그인하면 계정 운영에 필요한 최소한의 정보만 저장합니다:",
      ],
      bullets: [
        "이메일 주소와 표시 이름.",
        "사용한 로그인 방식(Apple로 로그인, Google, 이메일 매직 링크, 또는 이메일+비밀번호). 매직 링크 토큰은 해시값으로만 저장되며 평문으로는 저장되지 않습니다. 비밀번호를 설정한 경우에도 bcrypt 해시값만 저장하며 비밀번호 자체는 저장하지 않습니다. Apple의 비공개 이메일 릴레이와 함께 ‘Apple로 로그인’을 사용하는 경우, 저희는 해당 릴레이 주소만 확인합니다.",
        "로그인 세션. 안전한 httpOnly 쿠키에 보관됩니다.",
        "등록한 기기. 임의 기기 ID와 기기 이름(예: 플랫폼 이름)으로 관리됩니다.",
      ],
    },
    {
      heading: "임시 보관 전송(다운로드 링크)",
      body: [
        "선택적 임시 보관 다운로드 링크 기능을 사용하면 파일이 기기를 떠나기 전에 브라우저에서 AES-256-GCM으로 암호화됩니다. 복호화 키는 URL 프래그먼트(# 부분)에만 존재하며 서버로 전송되지 않습니다. 이는 다음을 의미합니다:",
      ],
      bullets: [
        "서버는 암호문만 저장합니다. 파일 내용, 파일 이름, 키를 읽을 수 없습니다.",
        "할당량 관리 및 정리를 위해 암호문 크기와 타임스탬프(업로드 시간, 만료 시간)를 기록합니다.",
        "암호문은 만료 시 또는 첫 번째 완전한 다운로드(열람 후 삭제) 중 먼저 발생하는 시점에 자동 삭제됩니다.",
      ],
    },
    {
      heading: "절대 수집하지 않는 정보",
      body: ["서비스는 다음 정보가 저희 서버에 도달하지 않도록 설계되어 있습니다:"],
      bullets: [
        "파일 내용.",
        "파일 이름.",
        "암호화 키.",
      ],
    },
    {
      heading: "크로스 네트워크 릴레이(TURN)",
      body: [
        "브라우저의 네트워크 간 전송은 직접 연결이 실패했을 때의 대체 수단이 아니라 설계상 TURN 서버를 통해 중계됩니다. 릴레이 서버는 여전히 파일을 읽을 수 없습니다——종단간 암호화가 유지됩니다. 월간 릴레이 허용량을 적용하고 남용을 방지하기 위해 계정별로 릴레이된 바이트 수를 기록합니다——중계 내용은 절대 검사하지 않으며, 오직 바이트 수만 기록합니다.",
      ],
    },
    {
      heading: "쿠키 및 로컬 스토리지",
      body: [
        "로그인 상태를 유지하기 위해 세션 쿠키 하나를 사용합니다. 브라우저의 로컬 스토리지에는 등록된 기기를 식별하기 위한 임의 기기 ID를 저장합니다. 광고 또는 추적 쿠키는 사용하지 않습니다.",
      ],
    },
    {
      heading: "제3자 서비스",
      body: ["사용자가 선택하여 사용하는 경우에만 일부 제3자가 관여합니다:"],
      bullets: [
        "Google — Google로 로그인하는 경우, 계정 생성을 위해 이메일 주소와 기본 프로필 정보를 받습니다.",
        "Apple — ‘Apple로 로그인’을 사용하는 경우, 고정된 식별자와 사용자가 공유하기로 선택한 이메일(또는 Apple의 비공개 릴레이 주소)을 받습니다.",
        "Stripe — 웹에서 구매한 구독의 결제 처리업체입니다. 자세한 내용은 ‘결제’를 참고하세요.",
        "Apple — iOS 앱 내 인앱 구매로 구매한 구독에 대해서입니다. 자세한 내용은 ‘결제’를 참고하세요.",
        "이메일 발송 서비스 제공업체 — 매직 링크 로그인, 인증 등 계정 관련 이메일 전송에 사용됩니다.",
      ],
    },
    {
      heading: "결제",
      body: [
        "유료 플랜을 구매하는 경우에만 결제 데이터를 공유하게 됩니다. 저희는 카드 전체 번호를 받거나 저장하지 않습니다.",
      ],
      bullets: [
        "웹에서는 결제가 Stripe를 통해 처리됩니다. 카드 정보는 저희가 아닌 Stripe로 전달되며, 저희는 고객 참조 정보와 그 결과로 나온 구독 상태만 받습니다.",
        "iOS 앱에서는 Apple 인앱 구매를 통해 구독을 구매합니다. Apple이 사용자의 Apple ID로 결제를 처리하며, 저희는 사용자가 활성 구독을 보유하고 있다는 사실만 받습니다.",
        "계정과 관련하여 저희는 현재 플랜, 구독 상태, 결제 주기, 기간 날짜만 저장하며 카드 데이터는 절대 저장하지 않습니다.",
      ],
    },
    {
      heading: "Relayium 앱",
      body: [
        "저희 네이티브 앱은 웹사이트에서는 다루지 않는 소량의 기기 수준 데이터를 처리합니다:",
      ],
      bullets: [
        "푸시 알림: 활성화하면 기기에 알림을 전달할 수 있도록 Apple Push Notification service(APNs) 기기 토큰을 저장합니다. 알림은 언제든지 기기 설정에서 끌 수 있습니다.",
        "카메라 및 사진: QR 코드를 스캔하거나 전송할 파일을 선택하는 용도로만 기기에서 사용됩니다. 사용자가 의도적으로 전송을 선택한 파일을 제외하고는 카메라나 라이브러리에서 어떤 것도 캡처되거나 업로드되지 않습니다.",
        "앱은 다른 앱이나 웹사이트에서 사용자를 추적하지 않으며, 광고나 제3자 분석 SDK를 포함하지 않습니다.",
      ],
    },
    {
      heading: "데이터 보존 및 삭제",
      body: [
        "계정 데이터는 계정이 존재하는 동안 보존됩니다. 앱 또는 웹의 계정 설정에서 언제든지 직접 계정과 그 데이터를 삭제할 수 있습니다. 삭제를 시작하면 30일의 유예 기간이 시작되며, 이 기간 동안 다시 로그인하면 취소할 수 있습니다. 그 이후에는 계정과 개인 데이터가 영구적으로 제거됩니다. 청구 및 남용 방지를 위해 보관해야 하는 집계 사용량 카운터는 익명화되어 더 이상 사용자와 연결되지 않습니다.",
      ],
    },
    {
      heading: "귀하의 권리",
      body: [
        "귀하는 자신의 계정 데이터에 접근, 정정, 내보내기, 삭제를 요청할 수 있으며, 특정 처리에 반대하거나 제한을 요청할 수 있습니다. 대부분은 계정 설정에서 직접 하실 수 있으며, 그 외의 사항은 support@relayium.com으로 이메일을 보내주세요. 저희는 귀하의 개인정보를 판매하지 않습니다. GDPR 또는 유사 법률이 적용되는 경우, 저희가 이 소량의 데이터를 처리하는 근거는 귀하가 요청한 서비스를 제공하는 것과, 보안 유지 및 남용 방지에 대한 저희의 정당한 이익입니다.",
      ],
    },
    {
      heading: "아동",
      body: [
        "Relayium은 아동을 대상으로 하지 않습니다. 저희는 13세 미만이거나 거주 지역의 디지털 동의 최소 연령 미만인 사람의 개인정보를 고의로 수집하지 않습니다. 아동이 저희에게 정보를 제공했다고 생각되시면 support@relayium.com으로 연락해 주시면 삭제해 드리겠습니다.",
      ],
    },
    {
      heading: "이 방침의 변경",
      body: [
        "서비스가 발전함에 따라 이 방침을 업데이트할 수 있습니다. 업데이트 시 위의 ‘최종 업데이트’ 날짜를 변경합니다.",
      ],
    },
    {
      heading: "문의",
      body: ["개인정보에 관한 질문이 있으시면 support@relayium.com으로 이메일을 보내주세요."],
    },
  ],
};

const de = {
  title: "Datenschutzerklärung",
  description:
    "Wie Relayium mit Ihren Daten umgeht: Echtzeit-Direktübertragungen werden Peer-to-Peer übertragen und berühren nie unsere Server; der Modus für zwischengespeicherte Download-Links hält Dateien Zero-Knowledge-verschlüsselt. Konten sind optional und speichern nur eine E-Mail-Adresse und einen Anzeigenamen.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-07-21",
  otherDocLabel: "Nutzungsbedingungen",
  lead: [
    "Relayium ist so konzipiert, dass Ihre Dateien Ihnen gehören. Echtzeit-Direktübertragungen erfolgen Peer-to-Peer, Ende-zu-Ende-verschlüsselt, und passieren nie unsere Server — der optionale Modus für zwischengespeicherte Download-Links verwendet Zero-Knowledge-Verschlüsselung, sodass der Server nur Chiffretext speichert, den er nicht lesen kann.",
    "Diese Seite erläutert, mit welchen wenigen Daten der Dienst tatsächlich umgeht und welche Daten er bewusst nie einsieht.",
  ],
  sections: [
    {
      heading: "Lokale Netzwerkübertragungen erfassen keine Daten",
      body: [
        "Wenn Sie Dateien zwischen Geräten im selben Netzwerk übertragen, wird kein Konto benötigt und der Dienst speichert nichts über Sie. Der Signalisierungsserver hilft lediglich dabei, dass sich die beiden Geräte finden; die Dateidaten fließen über einen verschlüsselten WebRTC-Kanal direkt von Gerät zu Gerät.",
      ],
    },
    {
      heading: "Was ein Konto speichert (nur wenn Sie angemeldet sind)",
      body: [
        "Übertragungen im selben Netzwerk (LAN) benötigen kein Konto. Für den Versand über Netzwerke hinweg per Pairing-Code muss sich die sendende Person anmelden — die empfangende Person benötigt weiterhin kein Konto. Auch das Erstellen eines gespeicherten Download-Links erfordert eine Anmeldung. Bei einer Anmeldung speichern wir nur das für den Kontobetrieb notwendige Minimum:",
      ],
      bullets: [
        "Ihre E-Mail-Adresse und ein Anzeigename.",
        "Die verwendete Anmeldemethode (Anmelden mit Apple, Google, ein E-Mail-Magic-Link oder E-Mail + Passwort). Magic-Link-Tokens werden ausschließlich als Hash gespeichert, niemals im Klartext; falls Sie ein Passwort festlegen, speichern wir nur dessen bcrypt-Hash, niemals das Passwort selbst. Wenn Sie „Anmelden mit Apple“ mit Apples privater E-Mail-Weiterleitung nutzen, sehen wir ausschließlich diese Weiterleitungsadresse.",
        "Eine Anmeldesitzung, gespeichert in einem sicheren httpOnly-Cookie.",
        "Registrierte Geräte, bestehend aus einer zufälligen Geräte-ID und einem Gerätenamen (z. B. Ihr Plattformname).",
      ],
    },
    {
      heading: "Zwischengespeicherte Übertragung (Download-Links)",
      body: [
        "Wenn Sie den optionalen Modus für zwischengespeicherte Download-Links nutzen, verschlüsselt Ihr Browser die Dateien mit AES-256-GCM, bevor sie Ihr Gerät verlassen. Der Entschlüsselungsschlüssel befindet sich ausschließlich im URL-Fragment (nach dem #) und wird nie an den Server gesendet. Das bedeutet:",
      ],
      bullets: [
        "Der Server speichert ausschließlich Chiffretext. Er kann Ihre Dateiinhalte, Dateinamen oder Schlüssel nicht lesen.",
        "Wir erfassen die Chiffretextgröße und Zeitstempel (Upload-Zeitpunkt, Ablaufzeit) für Kontingentverwaltung und Bereinigung.",
        "Der Chiffretext wird automatisch gelöscht, wenn er abläuft oder beim ersten vollständigen Download (Burn-after-read) — je nachdem, was zuerst eintritt.",
      ],
    },
    {
      heading: "Was wir niemals erfassen",
      body: ["Der Dienst ist so gestaltet, dass Folgendes unsere Server nie erreicht:"],
      bullets: [
        "Den Inhalt Ihrer Dateien.",
        "Die Namen Ihrer Dateien.",
        "Ihre Verschlüsselungsschlüssel.",
      ],
    },
    {
      heading: "Netzwerkübergreifende Weiterleitung (TURN)",
      body: [
        "Netzwerkübergreifende Übertragungen im Browser werden konstruktionsbedingt über einen TURN-Server weitergeleitet, nicht erst als Rückfall, wenn keine direkte Verbindung zustande kommt. Die Weiterleitung kann Ihre Dateien dennoch nicht lesen — sie bleiben Ende-zu-Ende-verschlüsselt. Wir erfassen die Anzahl weitergeleiteter Bytes pro Konto, um ein monatliches Weiterleitungskontingent durchzusetzen und Missbrauch zu verhindern — wir sehen niemals ein, was weitergeleitet wird, sondern nur die Byte-Anzahl.",
      ],
    },
    {
      heading: "Cookies und lokaler Speicher",
      body: [
        "Wir verwenden ein Sitzungs-Cookie, um Sie angemeldet zu halten. Im lokalen Speicher Ihres Browsers speichern wir eine zufällige Geräte-ID, damit ein von Ihnen registriertes Gerät wiedererkannt werden kann. Wir verwenden keine Werbe- oder Tracking-Cookies.",
      ],
    },
    {
      heading: "Drittanbieterdienste",
      body: ["Einige Drittanbieter sind nur dann beteiligt, wenn Sie sich entscheiden, sie zu nutzen:"],
      bullets: [
        "Google, wenn Sie sich mit Google anmelden — wir erhalten Ihre E-Mail-Adresse und Ihr Basisprofil, um das Konto zu erstellen.",
        "Apple, wenn Sie „Anmelden mit Apple“ nutzen — wir erhalten eine stabile Kennung sowie die E-Mail-Adresse (oder Apples private Weiterleitungsadresse), die Sie zu teilen wählen.",
        "Stripe, unser Zahlungsdienstleister für über das Web erworbene Abonnements — siehe Zahlungen.",
        "Apple, für Abonnements, die über In-App-Käufe in der iOS-App erworben werden — siehe Zahlungen.",
        "Ein E-Mail-Versanddienstleister, um kontobezogene E-Mails wie Magic-Link-Anmeldungen und Verifizierungen zu versenden.",
      ],
    },
    {
      heading: "Zahlungen",
      body: [
        "Sie geben Zahlungsdaten nur weiter, wenn Sie einen kostenpflichtigen Plan kaufen. Wir erhalten oder speichern niemals Ihre vollständige Kartennummer.",
      ],
      bullets: [
        "Im Web werden Zahlungen von Stripe abgewickelt. Kartendaten gehen an Stripe, nicht an uns; wir erhalten nur eine Kundenreferenz und den daraus resultierenden Abonnementstatus.",
        "In der iOS-App werden Abonnements über den In-App-Kauf von Apple erworben. Apple verarbeitet die Zahlung unter Ihrer Apple-ID; wir erfahren nur, dass Sie ein aktives Abonnement besitzen.",
        "Für Ihr Konto speichern wir nur Ihren aktuellen Plan, den Abonnementstatus, den Abrechnungszyklus und die Zeitraumdaten — niemals Kartendaten.",
      ],
    },
    {
      heading: "Die Relayium-App",
      body: [
        "Unsere nativen Apps verarbeiten einige wenige geräteseitige Daten, die die Website nicht verarbeitet:",
      ],
      bullets: [
        "Push-Benachrichtigungen: Wenn Sie diese aktivieren, speichern wir ein Gerätetoken des Apple Push Notification service (APNs), damit wir Benachrichtigungen an Ihr Gerät zustellen können. Sie können Benachrichtigungen jederzeit in den Geräteeinstellungen deaktivieren.",
        "Kamera und Fotos: werden ausschließlich auf Ihrem Gerät verwendet, um einen QR-Code zu scannen oder Dateien zum Versenden auszuwählen. Aus der Kamera oder Ihrer Bibliothek wird nichts erfasst oder hochgeladen außer den Dateien, die Sie bewusst zum Übertragen auswählen.",
        "Die App verfolgt Sie nicht über andere Apps oder Websites hinweg und enthält keine Werbe- oder Drittanbieter-Analyse-SDKs.",
      ],
    },
    {
      heading: "Datenspeicherung und Löschung",
      body: [
        "Kontodaten werden gespeichert, solange Ihr Konto besteht. Sie können Ihr Konto und die zugehörigen Daten jederzeit selbst in den Kontoeinstellungen löschen, in der App oder im Web. Die Löschung startet eine 30-tägige Karenzzeit, innerhalb derer Sie sie durch erneutes Anmelden rückgängig machen können; danach werden Ihr Konto und Ihre personenbezogenen Daten dauerhaft entfernt. Aggregierte Nutzungszähler, die wir für Abrechnung und Missbrauchsprävention aufbewahren müssen, werden anonymisiert, sodass sie nicht mehr mit Ihnen verknüpft sind.",
      ],
    },
    {
      heading: "Ihre Rechte",
      body: [
        "Sie können auf Ihre Kontodaten zugreifen, sie berichtigen, exportieren oder löschen sowie bestimmten Verarbeitungen widersprechen oder deren Einschränkung verlangen. Das meiste davon können Sie selbst in Ihren Kontoeinstellungen erledigen; für alles andere schreiben Sie an support@relayium.com. Wir verkaufen Ihre personenbezogenen Daten nicht. Soweit die GDPR oder ähnliche Gesetze gelten, ist unsere Rechtsgrundlage für die wenigen Daten, die wir verarbeiten, die Erbringung des von Ihnen angefragten Dienstes sowie unser berechtigtes Interesse an dessen Sicherheit und der Verhinderung von Missbrauch.",
      ],
    },
    {
      heading: "Kinder",
      body: [
        "Relayium richtet sich nicht an Kinder. Wir erheben wissentlich keine personenbezogenen Daten von Personen unter 13 Jahren oder unter dem Mindestalter für die digitale Einwilligung in Ihrem Wohnsitzland. Wenn Sie glauben, dass ein Kind uns Daten übermittelt hat, kontaktieren Sie support@relayium.com und wir löschen sie.",
      ],
    },
    {
      heading: "Änderungen dieser Richtlinie",
      body: [
        "Wir können diese Richtlinie aktualisieren, wenn sich der Dienst weiterentwickelt. In diesem Fall ändern wir das oben genannte Datum „Zuletzt aktualisiert“.",
      ],
    },
    {
      heading: "Kontakt",
      body: ["Fragen zum Datenschutz? Schreiben Sie uns an support@relayium.com."],
    },
  ],
};

const fr = {
  title: "Politique de confidentialité",
  description:
    "Comment Relayium traite vos données : les transferts directs en temps réel s'effectuent de pair à pair et ne passent jamais par nos serveurs ; le mode de liens de téléchargement stockés maintient les fichiers chiffrés à divulgation nulle. Les comptes sont facultatifs et ne stockent qu'une adresse e-mail et un nom d'affichage.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-07-21",
  otherDocLabel: "Conditions d'utilisation",
  lead: [
    "Relayium est conçu pour que vos fichiers restent les vôtres. Les transferts directs en temps réel s'effectuent de pair à pair, chiffrés de bout en bout, et ne passent jamais par nos serveurs ; le mode optionnel de liens de téléchargement stockés utilise un chiffrement à divulgation nulle — le serveur ne conserve que du chiffré qu'il ne peut pas lire.",
    "Cette page explique les quelques données que le service traite effectivement, et celles qu'il ne voit délibérément jamais.",
  ],
  sections: [
    {
      heading: "Les transferts sur réseau local ne collectent rien",
      body: [
        "Lorsque vous transférez des fichiers entre appareils sur le même réseau, aucun compte n'est nécessaire et le service ne stocke rien vous concernant. Le serveur de signalisation aide simplement les deux appareils à se trouver mutuellement ; les données de fichiers circulent directement d'appareil à appareil via un canal WebRTC chiffré.",
      ],
    },
    {
      heading: "Ce que stocke un compte (uniquement si vous vous connectez)",
      body: [
        "Les transferts sur le même réseau (local) ne nécessitent aucun compte. L'envoi entre réseaux différents via un code d'appairage exige que l'expéditeur se connecte — la personne qui reçoit n'a jamais besoin de compte. La création d'un lien de téléchargement stocké exige elle aussi une connexion. En cas de connexion, nous stockons le strict minimum nécessaire au fonctionnement du compte :",
      ],
      bullets: [
        "Votre adresse e-mail et un nom d'affichage.",
        "La méthode de connexion utilisée (Se connecter avec Apple, Google, un lien magique par e-mail, ou e-mail + mot de passe). Les jetons de lien magique sont stockés uniquement sous forme de hachage, jamais en clair ; si vous définissez un mot de passe, nous ne stockons que son hachage bcrypt, jamais le mot de passe lui-même. Si vous utilisez « Se connecter avec Apple » avec le relais d'e-mail privé d'Apple, nous ne voyons jamais que cette adresse de relais.",
        "Une session de connexion, conservée dans un cookie sécurisé httpOnly.",
        "Les appareils que vous enregistrez, sous la forme d'un identifiant d'appareil aléatoire et d'un nom d'appareil (par ex. le nom de votre plateforme).",
      ],
    },
    {
      heading: "Transfert stocké (liens de téléchargement)",
      body: [
        "Lorsque vous utilisez le mode optionnel de liens de téléchargement stockés, votre navigateur chiffre vos fichiers avec AES-256-GCM avant qu'ils ne quittent votre appareil. La clé de déchiffrement n'existe que dans le fragment d'URL (après le #) et n'est jamais envoyée au serveur. Cela signifie :",
      ],
      bullets: [
        "Le serveur ne stocke que du chiffré. Il ne peut pas lire le contenu de vos fichiers, leurs noms ni les clés.",
        "Nous enregistrons la taille du chiffré et les horodatages (heure d'envoi, expiration) pour la gestion des quotas et le nettoyage.",
        "Le chiffré est automatiquement supprimé à l'expiration ou lors du premier téléchargement complet (lecture unique), selon ce qui survient en premier.",
      ],
    },
    {
      heading: "Ce que nous ne collectons jamais",
      body: ["Le service est conçu pour que les éléments suivants n'atteignent jamais nos serveurs :"],
      bullets: [
        "Le contenu de vos fichiers.",
        "Les noms de vos fichiers.",
        "Vos clés de chiffrement.",
      ],
    },
    {
      heading: "Relais inter-réseau (TURN)",
      body: [
        "Les transferts entre réseaux différents dans le navigateur sont relayés via un serveur TURN par conception, et non seulement en repli lorsqu'une connexion directe échoue. Le relais ne peut toujours pas lire vos fichiers — ils restent chiffrés de bout en bout. Nous enregistrons le nombre d'octets relayés par compte, afin d'appliquer un quota de relais mensuel et de prévenir les abus — nous n'inspectons jamais ce qui est relayé, seulement le nombre d'octets.",
      ],
    },
    {
      heading: "Cookies et stockage local",
      body: [
        "Nous utilisons un cookie de session pour maintenir votre connexion. Dans le stockage local de votre navigateur, nous conservons un identifiant d'appareil aléatoire afin qu'un appareil que vous avez enregistré puisse être reconnu. Nous n'utilisons pas de cookies publicitaires ou de suivi.",
      ],
    },
    {
      heading: "Services tiers",
      body: ["Quelques tiers interviennent uniquement lorsque vous choisissez de les utiliser :"],
      bullets: [
        "Google, si vous vous connectez avec Google — nous recevons votre adresse e-mail et votre profil de base pour créer le compte.",
        "Apple, si vous utilisez « Se connecter avec Apple » — nous recevons un identifiant stable et l'adresse e-mail (ou l'adresse de relais privée d'Apple) que vous choisissez de partager.",
        "Stripe, notre prestataire de paiement pour les abonnements achetés sur le web — voir Paiements.",
        "Apple, pour les abonnements achetés dans l'application iOS via un achat intégré — voir Paiements.",
        "Un prestataire d'envoi d'e-mails, pour envoyer les e-mails liés au compte tels que la connexion par lien magique et la vérification.",
      ],
    },
    {
      heading: "Paiements",
      body: [
        "Vous ne partagez des données de paiement que si vous achetez une offre payante. Nous ne recevons ni ne stockons jamais votre numéro de carte complet.",
      ],
      bullets: [
        "Sur le web, les paiements sont traités par Stripe. Les détails de la carte vont à Stripe, pas à nous ; nous ne recevons qu'une référence client et le statut d'abonnement qui en résulte.",
        "Dans l'application iOS, les abonnements sont achetés via l'achat intégré d'Apple. Apple traite le paiement sous votre identifiant Apple ; nous savons seulement que vous détenez un abonnement actif.",
        "Pour votre compte, nous ne stockons que votre offre actuelle, le statut de l'abonnement, le cycle de facturation et les dates de période — jamais les données de carte.",
      ],
    },
    {
      heading: "L'application Relayium",
      body: [
        "Nos applications natives traitent quelques données au niveau de l'appareil que le site web ne traite pas :",
      ],
      bullets: [
        "Notifications push : si vous les activez, nous stockons un jeton d'appareil Apple Push Notification service (APNs) afin de pouvoir livrer des notifications à votre appareil. Vous pouvez désactiver les notifications à tout moment dans les réglages de votre appareil.",
        "Appareil photo et photos : utilisés uniquement sur votre appareil pour scanner un code QR ou choisir des fichiers à envoyer. Rien n'est capturé ni téléversé depuis l'appareil photo ou votre bibliothèque, à l'exception des fichiers que vous choisissez délibérément de transférer.",
        "L'application ne vous suit pas à travers d'autres applications ou sites web, et ne contient aucun SDK publicitaire ou d'analyse tiers.",
      ],
    },
    {
      heading: "Conservation et suppression des données",
      body: [
        "Les données du compte sont conservées tant que votre compte existe. Vous pouvez supprimer votre compte et ses données à tout moment depuis les paramètres de votre compte, dans l'application ou sur le web. La suppression déclenche un délai de grâce de 30 jours pendant lequel vous pouvez l'annuler en vous reconnectant ; passé ce délai, votre compte et vos données personnelles sont définitivement supprimés. Les compteurs d'utilisation agrégés que nous devons conserver pour la facturation et la prévention des abus sont anonymisés afin de ne plus être liés à vous.",
      ],
    },
    {
      heading: "Vos droits",
      body: [
        "Vous pouvez accéder à vos données de compte, les corriger, les exporter ou les supprimer, et vous opposer à certains traitements ou en demander la limitation. La plupart de ces actions sont possibles vous-même depuis les paramètres de votre compte ; pour le reste, écrivez à support@relayium.com. Nous ne vendons pas vos données personnelles. Lorsque le GDPR ou des lois similaires s'appliquent, notre base légale pour les quelques données que nous traitons est l'exécution du service que vous avez demandé, ainsi que notre intérêt légitime à en assurer la sécurité et à prévenir les abus.",
      ],
    },
    {
      heading: "Enfants",
      body: [
        "Relayium ne s'adresse pas aux enfants. Nous ne collectons pas sciemment de données personnelles auprès de toute personne de moins de 13 ans, ou en dessous de l'âge minimum de consentement numérique en vigueur là où vous résidez. Si vous pensez qu'un enfant nous a communiqué des données, contactez support@relayium.com et nous les supprimerons.",
      ],
    },
    {
      heading: "Modifications de cette politique",
      body: [
        "Nous pouvons mettre à jour cette politique au fur et à mesure de l'évolution du service. Dans ce cas, nous modifierons la date « Dernière mise à jour » ci-dessus.",
      ],
    },
    {
      heading: "Contact",
      body: ["Des questions sur la confidentialité ? Écrivez-nous à support@relayium.com."],
    },
  ],
};

const ar = {
  title: "سياسة الخصوصية",
  description:
    "كيف تتعامل Relayium مع بياناتك: عمليات النقل المباشر الفوري تتم من الند للند ولا تمرّ مطلقًا عبر خوادمنا؛ ووضع رابط التنزيل المُخزَّن يُبقي الملفات مُشفَّرة بمعرفة صفرية. الحسابات اختيارية ولا تخزّن سوى عنوان بريد إلكتروني واسم عرض.",
  updatedLabel: "آخر تحديث",
  updated: "2026-07-21",
  otherDocLabel: "شروط الخدمة",
  lead: [
    "صُمِّمت Relayium بحيث تظل ملفاتك مِلكًا لك. عمليات النقل المباشر الفوري تتم من الند للند، ومُشفَّرة من الطرف إلى الطرف، ولا تمرّ مطلقًا عبر خوادمنا؛ ووضع رابط التنزيل المُخزَّن الاختياري يستخدم التشفير بمعرفة صفرية — إذ لا يحتفظ الخادم إلا بنص مُشفَّر لا يستطيع قراءته.",
    "توضّح هذه الصفحة البيانات القليلة التي تتعامل معها الخدمة فعلًا، والبيانات التي لا تراها عن قصد أبدًا.",
  ],
  sections: [
    {
      heading: "عمليات النقل على الشبكة المحلية لا تجمع أي شيء",
      body: [
        "عندما تنقل الملفات بين الأجهزة على نفس الشبكة، لا حاجة إلى حساب ولا تخزّن الخدمة أي شيء عنك. يقتصر دور خادم الإشارة على مساعدة الجهازين على العثور على أحدهما الآخر؛ أما بايتات الملف فتتدفق من جهاز إلى جهاز عبر قناة WebRTC مُشفَّرة.",
      ],
    },
    {
      heading: "ما الذي يخزّنه الحساب (فقط في حال تسجيل الدخول)",
      body: [
        "لا تتطلب عمليات النقل على نفس الشبكة (الشبكة المحلية) أي حساب. أما الإرسال عبر الشبكات باستخدام رمز الاقتران فيتطلب من المُرسِل تسجيل الدخول — ولا يحتاج المُستقبِل إطلاقًا إلى حساب. كما يتطلب إنشاء رابط تنزيل مُخزَّن تسجيل الدخول. إذا سجّلت الدخول، فإننا نخزّن الحد الأدنى اللازم لتشغيل الحساب:",
      ],
      bullets: [
        "عنوان بريدك الإلكتروني واسم عرض.",
        "طريقة تسجيل الدخول التي استخدمتها (تسجيل الدخول عبر Apple، أو Google، أو رابط تسجيل الدخول عبر البريد الإلكتروني، أو البريد الإلكتروني + كلمة المرور). تُخزَّن رموز رابط تسجيل الدخول على هيئة تجزئة فقط، ولا تُخزَّن أبدًا كنص صريح؛ وإذا ضبطت كلمة مرور، فإننا نخزّن تجزئة bcrypt الخاصة بها فقط، ولا نخزّن كلمة المرور نفسها أبدًا. إذا استخدمت «تسجيل الدخول عبر Apple» مع خدمة إخفاء البريد الإلكتروني الخاصة بـ Apple، فإننا لا نرى سوى عنوان الترحيل ذاك.",
        "جلسة تسجيل دخول، محفوظة في ملف تعريف ارتباط آمن من نوع httpOnly.",
        "الأجهزة التي تسجّلها، على هيئة مُعرِّف جهاز عشوائي واسم جهاز (مثل اسم منصّتك).",
      ],
    },
    {
      heading: "النقل المُخزَّن (روابط التنزيل)",
      body: [
        "عندما تستخدم وضع رابط التنزيل المُخزَّن الاختياري، يُشفِّر متصفحك ملفاتك باستخدام AES-256-GCM قبل أن تغادر جهازك. ولا يوجد مفتاح فك التشفير إلا في جزء URL (المقطع الذي يلي #) — ولا يُرسَل أبدًا إلى الخادم. وهذا يعني:",
      ],
      bullets: [
        "لا يخزّن الخادم سوى النص المُشفَّر. ولا يمكنه قراءة محتويات ملفاتك أو أسماءها أو مفاتيحك.",
        "نسجّل حجم النص المُشفَّر والطوابع الزمنية (وقت الرفع، وقت انتهاء الصلاحية) لأغراض إدارة الحصة والتنظيف.",
        "يُحذَف النص المُشفَّر تلقائيًا عند انتهاء الصلاحية أو عند أول تنزيل كامل (الحذف بعد القراءة)، أيهما يقع أولًا.",
      ],
    },
    {
      heading: "ما الذي لا نجمعه أبدًا",
      body: ["صُمِّمت الخدمة بحيث لا يصل ما يلي مطلقًا إلى خوادمنا:"],
      bullets: [
        "محتويات ملفاتك.",
        "أسماء ملفاتك.",
        "مفاتيح التشفير الخاصة بك.",
      ],
    },
    {
      heading: "المُرحِّل عبر الشبكات (TURN)",
      body: [
        "تُرحَّل عمليات النقل عبر الشبكات في المتصفح عبر خادم TURN بحكم التصميم، لا كخيار احتياطي عند فشل الاتصال المباشر فحسب. ومع ذلك لا يستطيع المُرحِّل قراءة ملفاتك — فهي تظل مُشفَّرة من الطرف إلى الطرف. نسجّل عدد البايتات المُرحَّلة لكل حساب لفرض حصة ترحيل شهرية ومنع إساءة الاستخدام — ولا نفحص أبدًا ما يُرحَّل، بل نسجّل عدد البايتات فقط.",
      ],
    },
    {
      heading: "ملفات تعريف الارتباط والتخزين المحلي",
      body: [
        "نستخدم ملف تعريف ارتباط جلسة واحدًا لإبقائك مُسجّل الدخول. ونحتفظ في التخزين المحلي لمتصفحك بمُعرِّف جهاز عشوائي حتى يمكن التعرّف على جهاز سجّلته. ولا نستخدم ملفات تعريف ارتباط للإعلانات أو التتبّع.",
      ],
    },
    {
      heading: "خدمات الطرف الثالث",
      body: ["لا يشارك سوى عدد قليل من الأطراف الثالثة وذلك فقط عندما تختار استخدامها:"],
      bullets: [
        "Google، إذا سجّلت الدخول باستخدام Google — نتلقّى بريدك الإلكتروني وملفك التعريفي الأساسي لإنشاء الحساب.",
        "Apple، إذا استخدمت «تسجيل الدخول عبر Apple» — نتلقّى مُعرِّفًا ثابتًا والبريد الإلكتروني (أو عنوان ترحيل Apple الخاص) الذي تختار مشاركته.",
        "Stripe، مُعالِج المدفوعات الخاص بنا للاشتراكات التي تُشترى عبر الويب — راجع «المدفوعات».",
        "Apple، للاشتراكات التي تُشترى داخل تطبيق iOS عبر الشراء داخل التطبيق — راجع «المدفوعات».",
        "مزوّد لتوصيل البريد الإلكتروني، لإرسال رسائل الحساب مثل رابط تسجيل الدخول والتحقق.",
      ],
    },
    {
      heading: "المدفوعات",
      body: [
        "لا تشارك بيانات الدفع إلا إذا اشتريت خطة مدفوعة. ولا نتلقّى أو نخزّن أبدًا رقم بطاقتك الكامل.",
      ],
      bullets: [
        "على الويب، تُعالَج المدفوعات بواسطة Stripe. تذهب تفاصيل البطاقة إلى Stripe وليس إلينا؛ ولا نتلقّى سوى مرجع للعميل وحالة الاشتراك الناتجة عنه.",
        "في تطبيق iOS، تُشترى الاشتراكات عبر الشراء داخل التطبيق من Apple. تُعالِج Apple الدفع باستخدام معرّف Apple الخاص بك؛ ولا نعلم سوى أنك تمتلك اشتراكًا نشطًا.",
        "بخصوص حسابك، لا نخزّن سوى خطتك الحالية وحالة اشتراكك ودورة الفوترة وتواريخ الفترة — ولا نخزّن أبدًا بيانات البطاقة.",
      ],
    },
    {
      heading: "تطبيق Relayium",
      body: [
        "تتعامل تطبيقاتنا الأصلية مع قدر ضئيل من البيانات على مستوى الجهاز لا يتعامل معها الموقع الإلكتروني:",
      ],
      bullets: [
        "الإشعارات الفورية: إذا فعّلتها، فإننا نخزّن رمز جهاز خاص بخدمة Apple Push Notification (APNs) حتى نتمكّن من إرسال الإشعارات إلى جهازك. يمكنك إيقاف الإشعارات في أي وقت من إعدادات جهازك.",
        "الكاميرا والصور: تُستخدَم فقط على جهازك لمسح رمز QR أو اختيار ملفات لإرسالها. لا يُلتقَط أو يُرفَع أي شيء من الكاميرا أو مكتبتك باستثناء الملفات التي تختار عمدًا نقلها.",
        "لا يتتبّعك التطبيق عبر تطبيقات أو مواقع أخرى، ولا يحتوي على إعلانات أو أدوات تحليل من أطراف ثالثة.",
      ],
    },
    {
      heading: "الاحتفاظ بالبيانات وحذفها",
      body: [
        "يُحتفَظ ببيانات الحساب طوال وجود حسابك. يمكنك حذف حسابك وبياناته في أي وقت بنفسك من إعدادات حسابك، سواء في التطبيق أو على الويب. يبدأ الحذف فترة سماح مدتها 30 يومًا يمكنك خلالها التراجع عنه بتسجيل الدخول مجددًا؛ وبعد ذلك، تُزال بياناتك الشخصية وحسابك بشكل دائم. تُخفى هوية عدادات الاستخدام الإجمالية التي يتعيّن علينا الاحتفاظ بها لأغراض الفوترة ومنع إساءة الاستخدام، بحيث لم تعد مرتبطة بك.",
      ],
    },
    {
      heading: "حقوقك",
      body: [
        "يمكنك الوصول إلى بيانات حسابك أو تصحيحها أو تصديرها أو حذفها، والاعتراض على معالجات معيّنة أو طلب تقييدها. يمكنك القيام بمعظم ذلك بنفسك من إعدادات حسابك؛ وبالنسبة لأي شيء آخر، راسِلنا على support@relayium.com. نحن لا نبيع بياناتك الشخصية. وحيثما تُطبَّق GDPR أو قوانين مماثلة، فإن أساسنا القانوني لمعالجة هذا القدر الضئيل من البيانات هو تقديم الخدمة التي طلبتها ومصلحتنا المشروعة في الحفاظ على أمنها ومنع إساءة استخدامها.",
      ],
    },
    {
      heading: "الأطفال",
      body: [
        "لا تستهدف Relayium الأطفال. ولا نجمع عن علم بيانات شخصية من أي شخص دون سن 13 عامًا، أو دون الحد الأدنى لسن الموافقة الرقمية في مكان إقامتك. إذا كنت تعتقد أن طفلًا قد زوّدنا ببيانات، فتواصل معنا على support@relayium.com وسنقوم بحذفها.",
      ],
    },
    {
      heading: "التغييرات على هذه السياسة",
      body: [
        "قد نُحدِّث هذه السياسة مع تطوّر الخدمة. وعندما نفعل ذلك، سنغيّر تاريخ «آخر تحديث» أعلاه.",
      ],
    },
    {
      heading: "التواصل",
      body: ["هل لديك أسئلة عن الخصوصية؟ راسِلنا على support@relayium.com."],
    },
  ],
};

const es = {
  title: "Política de privacidad",
  description:
    "Cómo Relayium gestiona tus datos: las transferencias directas en tiempo real se realizan de igual a igual y nunca pasan por nuestros servidores; el modo de enlace de descarga almacenado mantiene los archivos cifrados con conocimiento cero. Las cuentas son opcionales y solo almacenan un correo electrónico y un nombre para mostrar.",
  updatedLabel: "Última actualización",
  updated: "2026-07-21",
  otherDocLabel: "Términos del servicio",
  lead: [
    "Relayium está diseñado para que tus archivos sigan siendo tuyos. Las transferencias directas en tiempo real se realizan de igual a igual, cifradas de extremo a extremo, y nunca pasan por nuestros servidores; el modo opcional de enlace de descarga almacenado utiliza cifrado de conocimiento cero: el servidor solo conserva texto cifrado que no puede leer.",
    "Esta página explica los pocos datos que el servicio sí gestiona, y los datos que deliberadamente nunca ve.",
  ],
  sections: [
    {
      heading: "Las transferencias en red local no recopilan nada",
      body: [
        "Cuando transfieres archivos entre dispositivos de la misma red, no se necesita ninguna cuenta y el servicio no almacena nada sobre ti. El servidor de señalización solo ayuda a que los dos dispositivos se encuentren entre sí; los bytes del archivo fluyen de dispositivo a dispositivo a través de un canal WebRTC cifrado.",
      ],
    },
    {
      heading: "Qué almacena una cuenta (solo si inicias sesión)",
      body: [
        "Las transferencias en la misma red (red local) no necesitan cuenta. Enviar entre redes con un código de emparejamiento requiere que el remitente inicie sesión: la persona que recibe nunca necesita una cuenta. Crear un enlace de descarga almacenado también requiere iniciar sesión. Si inicias sesión, almacenamos lo mínimo necesario para gestionar una cuenta:",
      ],
      bullets: [
        "Tu dirección de correo electrónico y un nombre para mostrar.",
        "Qué método de inicio de sesión usaste (Iniciar sesión con Apple, Google, un enlace mágico por correo electrónico, o correo electrónico + contraseña). Los tokens de enlace mágico se almacenan solo como un hash, nunca en texto en claro; si estableces una contraseña, almacenamos solo su hash bcrypt, nunca la contraseña en sí. Si usas Iniciar sesión con Apple con la retransmisión de correo privada de Apple, solo vemos esa dirección de retransmisión.",
        "Una sesión de inicio de sesión, guardada en una cookie segura httpOnly.",
        "Los dispositivos que registras, como un id de dispositivo aleatorio y un nombre de dispositivo (p. ej., el nombre de tu plataforma).",
      ],
    },
    {
      heading: "Transferencia almacenada (enlaces de descarga)",
      body: [
        "Cuando usas el modo opcional de enlace de descarga almacenado, tu navegador cifra tus archivos con AES-256-GCM antes de que salgan de tu dispositivo. La clave de descifrado existe únicamente en el fragmento de la URL: nunca se envía al servidor. Esto significa:",
      ],
      bullets: [
        "El servidor solo almacena texto cifrado. No puede leer el contenido de tus archivos, sus nombres ni las claves.",
        "Registramos el tamaño del texto cifrado y marcas de tiempo (hora de subida, caducidad) para la gestión de cuotas y la limpieza.",
        "El texto cifrado se elimina automáticamente al caducar o en la primera descarga completa (destrucción tras la lectura), lo que ocurra primero.",
      ],
    },
    {
      heading: "Qué nunca recopilamos",
      body: ["El servicio está diseñado para que lo siguiente nunca llegue a nuestros servidores:"],
      bullets: [
        "El contenido de tus archivos.",
        "Los nombres de tus archivos.",
        "Tus claves de cifrado.",
      ],
    },
    {
      heading: "Retransmisión entre redes (TURN)",
      body: [
        "Las transferencias entre redes en el navegador se retransmiten a través de un servidor TURN por diseño, y no solo como recurso alternativo cuando falla una conexión directa. El retransmisor sigue sin poder leer tus archivos: permanecen cifrados de extremo a extremo. Registramos el número de bytes retransmitidos por cuenta, para aplicar una asignación mensual de retransmisión y evitar el abuso; nunca inspeccionamos lo que se retransmite, solo el recuento de bytes.",
      ],
    },
    {
      heading: "Cookies y almacenamiento local",
      body: [
        "Usamos una cookie de sesión para mantener tu sesión iniciada. En el almacenamiento local de tu navegador guardamos un id de dispositivo aleatorio para que un dispositivo que hayas registrado pueda ser reconocido. No usamos cookies de publicidad ni de seguimiento.",
      ],
    },
    {
      heading: "Servicios de terceros",
      body: ["Solo intervienen un par de terceros cuando eliges usarlos:"],
      bullets: [
        "Google, si inicias sesión con Google: recibimos tu correo electrónico y tu perfil básico para crear la cuenta.",
        "Apple, si usas Iniciar sesión con Apple: recibimos un identificador estable y el correo electrónico (o la dirección de retransmisión privada de Apple) que elijas compartir.",
        "Stripe, nuestro procesador de pagos para las suscripciones compradas en la web; consulta Pagos.",
        "Apple, para las suscripciones compradas dentro de la app de iOS mediante compra dentro de la app; consulta Pagos.",
        "Un proveedor de envío de correo electrónico, para enviar correos de la cuenta como el inicio de sesión con enlace mágico y la verificación.",
      ],
    },
    {
      heading: "Pagos",
      body: [
        "Solo compartes datos de pago si compras un plan de pago. Nunca recibimos ni almacenamos tu número de tarjeta completo.",
      ],
      bullets: [
        "En la web, los pagos los gestiona Stripe. Los datos de la tarjeta van a Stripe, no a nosotros; solo recibimos una referencia de cliente y el estado de suscripción resultante.",
        "En la app de iOS, las suscripciones se compran mediante la compra dentro de la app de Apple. Apple procesa el pago con tu Apple ID; solo sabemos que tienes una suscripción activa.",
        "Para tu cuenta solo almacenamos tu plan actual, el estado de la suscripción, el ciclo de facturación y las fechas del período, nunca los datos de la tarjeta.",
      ],
    },
    {
      heading: "La app de Relayium",
      body: [
        "Nuestras apps nativas gestionan algunos datos a nivel de dispositivo que el sitio web no gestiona:",
      ],
      bullets: [
        "Notificaciones push: si las activas, almacenamos un token de dispositivo del Apple Push Notification service (APNs) para poder enviar notificaciones a tu dispositivo. Puedes desactivar las notificaciones en cualquier momento en los ajustes de tu dispositivo.",
        "Cámara y fotos: se usan solo en tu dispositivo para escanear un código QR o elegir archivos que enviar. No se captura ni se sube nada de la cámara ni de tu biblioteca, salvo los archivos que decidas transferir deliberadamente.",
        "La app no te rastrea a través de otras apps o sitios web, y no contiene publicidad ni SDK de análisis de terceros.",
      ],
    },
    {
      heading: "Conservación y eliminación de datos",
      body: [
        "Los datos de la cuenta se conservan mientras exista tu cuenta. Puedes eliminar tu cuenta y sus datos en cualquier momento desde los ajustes de tu cuenta, en la app o en la web. La eliminación inicia un período de gracia de 30 días durante el cual puedes deshacerla volviendo a iniciar sesión; después de eso, tu cuenta y tus datos personales se eliminan de forma permanente. Los contadores de uso agregados que debemos conservar para la facturación y la prevención de abusos se anonimizan para que ya no estén vinculados a ti.",
      ],
    },
    {
      heading: "Tus derechos",
      body: [
        "Puedes acceder, corregir, exportar o eliminar los datos de tu cuenta, y oponerte a ciertos tratamientos o solicitar su limitación. La mayor parte de esto puedes hacerlo tú mismo en los ajustes de tu cuenta; para cualquier otra cosa, escribe a support@relayium.com. No vendemos tus datos personales. Cuando se aplique el GDPR u otras leyes similares, nuestra base para tratar la escasa cantidad de datos que procesamos es la prestación del servicio que solicitaste y nuestro interés legítimo en mantenerlo seguro y prevenir abusos.",
      ],
    },
    {
      heading: "Menores",
      body: [
        "Relayium no está dirigido a menores. No recopilamos a sabiendas datos personales de nadie menor de 13 años, ni por debajo de la edad mínima de consentimiento digital de tu lugar de residencia. Si crees que un menor nos ha proporcionado datos, contacta con support@relayium.com y los eliminaremos.",
      ],
    },
    {
      heading: "Cambios en esta política",
      body: [
        "Podemos actualizar esta política a medida que el servicio evolucione. Cuando lo hagamos, cambiaremos la fecha de «Última actualización» anterior.",
      ],
    },
    {
      heading: "Contacto",
      body: ["¿Preguntas sobre privacidad? Escribe a support@relayium.com."],
    },
  ],
};

const pt = {
  title: "Política de Privacidade",
  description:
    "Como a Relayium lida com seus dados: as transferências diretas em tempo real são feitas ponto a ponto e nunca passam pelos nossos servidores; o modo de link de download armazenado mantém os arquivos criptografados com conhecimento zero. As contas são opcionais e armazenam apenas um e-mail e um nome de exibição.",
  updatedLabel: "Última atualização",
  updated: "2026-07-21",
  otherDocLabel: "Termos de Serviço",
  lead: [
    "A Relayium foi criada para que seus arquivos continuem sendo seus. As transferências diretas em tempo real são feitas ponto a ponto, com criptografia de ponta a ponta, e nunca passam pelos nossos servidores; o modo opcional de link de download armazenado usa criptografia de conhecimento zero — o servidor guarda apenas texto cifrado que não consegue ler.",
    "Esta página explica os poucos dados que o serviço de fato processa e os dados que ele deliberadamente nunca vê.",
  ],
  sections: [
    {
      heading: "As transferências na rede local não coletam nada",
      body: [
        "Quando você transfere arquivos entre dispositivos na mesma rede, nenhuma conta é necessária e o serviço não armazena nada sobre você. O servidor de sinalização apenas ajuda os dois dispositivos a se encontrarem; os bytes do arquivo fluem de dispositivo para dispositivo por um canal WebRTC criptografado.",
      ],
    },
    {
      heading: "O que uma conta armazena (somente se você fizer login)",
      body: [
        "As transferências na mesma rede (rede local) não precisam de conta. Enviar entre redes com um código de emparelhamento exige que o remetente faça login — quem recebe nunca precisa de uma conta. Criar um link de download armazenado também exige fazer login. Se você fizer login, armazenamos o mínimo necessário para operar uma conta:",
      ],
      bullets: [
        "Seu endereço de e-mail e um nome de exibição.",
        "Qual método de login você usou (Entrar com a Apple, Google, um link mágico por e-mail ou e-mail + senha). Os tokens de link mágico são armazenados apenas como um hash, nunca em texto claro; se você definir uma senha, armazenamos apenas o hash bcrypt dela, nunca a senha em si. Se você usar o Entrar com a Apple com o serviço de retransmissão de e-mail privado da Apple, veremos apenas esse endereço de retransmissão.",
        "Uma sessão de login, mantida em um cookie seguro httpOnly.",
        "Os dispositivos que você registra, como um id de dispositivo aleatório e um nome de dispositivo (por exemplo, o nome da sua plataforma).",
      ],
    },
    {
      heading: "Transferência armazenada (links de download)",
      body: [
        "Quando você usa o modo opcional de link de download armazenado, seu navegador criptografa seus arquivos com AES-256-GCM antes de eles saírem do seu dispositivo. A chave de descriptografia existe apenas no fragmento da URL — ela nunca é enviada ao servidor. Isso significa:",
      ],
      bullets: [
        "O servidor armazena apenas texto cifrado. Ele não consegue ler o conteúdo dos seus arquivos, os nomes deles nem as chaves.",
        "Registramos o tamanho do texto cifrado e marcas de tempo (hora do envio, expiração) para gerenciamento de cota e limpeza.",
        "O texto cifrado é excluído automaticamente na expiração ou no primeiro download completo (destruição após leitura), o que ocorrer primeiro.",
      ],
    },
    {
      heading: "O que nunca coletamos",
      body: ["O serviço foi projetado para que o seguinte nunca chegue aos nossos servidores:"],
      bullets: [
        "O conteúdo dos seus arquivos.",
        "Os nomes dos seus arquivos.",
        "Suas chaves de criptografia.",
      ],
    },
    {
      heading: "Retransmissão entre redes (TURN)",
      body: [
        "As transferências entre redes no navegador são retransmitidas por um servidor TURN por decisão de projeto, e não apenas como recurso alternativo quando uma conexão direta falha. O retransmissor ainda não consegue ler seus arquivos — eles permanecem com criptografia de ponta a ponta. Registramos o número de bytes retransmitidos por conta, para aplicar uma cota mensal de retransmissão e evitar abusos — nunca inspecionamos o que é retransmitido, apenas a contagem de bytes.",
      ],
    },
    {
      heading: "Cookies e armazenamento local",
      body: [
        "Usamos um cookie de sessão para manter você conectado. No armazenamento local do seu navegador, guardamos um id de dispositivo aleatório para que um dispositivo que você registrou possa ser reconhecido. Não usamos cookies de publicidade ou de rastreamento.",
      ],
    },
    {
      heading: "Serviços de terceiros",
      body: ["Alguns poucos terceiros só entram em cena quando você opta por usá-los:"],
      bullets: [
        "O Google, se você fizer login com o Google — recebemos seu e-mail e seu perfil básico para criar a conta.",
        "A Apple, se você usar o Entrar com a Apple — recebemos um identificador estável e o e-mail (ou o endereço de retransmissão privado da Apple) que você optar por compartilhar.",
        "A Stripe, nossa processadora de pagamentos para assinaturas compradas na web — veja Pagamentos.",
        "A Apple, para assinaturas compradas dentro do app iOS via compra no app — veja Pagamentos.",
        "Um provedor de envio de e-mail, para enviar e-mails da conta como login por link mágico e verificação.",
      ],
    },
    {
      heading: "Pagamentos",
      body: [
        "Você só compartilha dados de pagamento se comprar um plano pago. Nunca recebemos nem armazenamos o número completo do seu cartão.",
      ],
      bullets: [
        "Na web, os pagamentos são processados pela Stripe. Os dados do cartão vão para a Stripe, não para nós; recebemos apenas uma referência de cliente e o status de assinatura resultante.",
        "No app iOS, as assinaturas são compradas por meio da compra no app da Apple. A Apple processa o pagamento usando seu Apple ID; sabemos apenas que você possui uma assinatura ativa.",
        "Para sua conta, armazenamos apenas seu plano atual, o status da assinatura, o ciclo de cobrança e as datas do período — nunca dados de cartão.",
      ],
    },
    {
      heading: "O aplicativo Relayium",
      body: [
        "Nossos aplicativos nativos lidam com alguns dados no nível do dispositivo que o site não trata:",
      ],
      bullets: [
        "Notificações push: se você as ativar, armazenamos um token de dispositivo do Apple Push Notification service (APNs) para podermos entregar notificações ao seu dispositivo. Você pode desativar as notificações a qualquer momento nas configurações do seu dispositivo.",
        "Câmera e fotos: usadas apenas no seu dispositivo para escanear um código QR ou escolher arquivos para enviar. Nada é capturado ou enviado da câmera ou da sua biblioteca, exceto os arquivos que você escolhe deliberadamente transferir.",
        "O aplicativo não rastreia você em outros aplicativos ou sites, e não contém publicidade nem SDKs de análise de terceiros.",
      ],
    },
    {
      heading: "Retenção e exclusão de dados",
      body: [
        "Os dados da conta são mantidos enquanto sua conta existir. Você pode excluir sua conta e seus dados a qualquer momento nas configurações da conta, no app ou na web. A exclusão inicia um período de carência de 30 dias durante o qual você pode desfazê-la fazendo login novamente; depois disso, sua conta e seus dados pessoais são removidos permanentemente. Os contadores agregados de uso que precisamos manter para cobrança e prevenção de abusos são anonimizados para que não fiquem mais vinculados a você.",
      ],
    },
    {
      heading: "Seus direitos",
      body: [
        "Você pode acessar, corrigir, exportar ou excluir os dados da sua conta, e se opor a determinados processamentos ou solicitar sua restrição. A maior parte disso você pode fazer sozinho nas configurações da sua conta; para o restante, envie um e-mail para support@relayium.com. Não vendemos seus dados pessoais. Quando o GDPR ou leis semelhantes se aplicarem, nossa base para os poucos dados que processamos é a execução do serviço que você solicitou e nosso interesse legítimo em mantê-lo seguro e prevenir abusos.",
      ],
    },
    {
      heading: "Crianças",
      body: [
        "A Relayium não é direcionada a crianças. Não coletamos intencionalmente dados pessoais de ninguém com menos de 13 anos, ou abaixo da idade mínima de consentimento digital do seu local de residência. Se você acredita que uma criança nos forneceu dados, entre em contato pelo support@relayium.com e nós os excluiremos.",
      ],
    },
    {
      heading: "Alterações nesta política",
      body: [
        "Podemos atualizar esta política à medida que o serviço evolui. Quando o fizermos, alteraremos a data de \"Última atualização\" acima.",
      ],
    },
    {
      heading: "Contato",
      body: ["Dúvidas sobre privacidade? Envie um e-mail para support@relayium.com."],
    },
  ],
};

export default { slug: "privacy", langs: { en, zh, ja, ko, de, fr, ar, es, pt } };
