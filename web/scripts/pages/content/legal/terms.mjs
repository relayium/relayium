// web/scripts/pages/content/legal/terms.mjs
const en = {
  title: "Terms of Service",
  description:
    "The terms for using Relayium — an open-source service for end-to-end encrypted file and real-time text transfers between devices. The core service is free; optional paid plans are available.",
  updatedLabel: "Last updated",
  updated: "2026-08-13",
  otherDocLabel: "Privacy Policy",
  lead: [
    "By using Relayium you agree to these terms. Relayium is an open-source service that lets you send files and real-time text between devices, end-to-end encrypted. The core service is free; some optional plans are paid — see Subscriptions and billing.",
  ],
  sections: [
    {
      heading: "The service",
      body: [
        "Relayium transfers end-to-end encrypted files and real-time text between devices. The core service is free and its source code is open source under the AGPL-3.0 license. Optional paid plans raise storage, transfer, and retention limits — see Subscriptions and billing.",
      ],
    },
    {
      heading: "Eligibility",
      body: [
        "You must be old enough to form a binding agreement and to consent to the processing of your data where you live — at least 13, or older where your country requires it. Relayium is not directed to children, and we do not knowingly let children create accounts.",
      ],
    },
    {
      heading: "Acceptable use",
      body: ["You agree not to use Relayium to:"],
      bullets: [
        "Break the law or infringe others' rights, including sending content you have no right to share.",
        "Distribute malware, or attempt to disrupt, overload, or abuse the service or its infrastructure.",
        "Circumvent security measures or attempt to access data that is not yours.",
      ],
    },
    {
      heading: "Accounts",
      body: [
        "Same-network (LAN) transfers need no account. Creating a pairing code for a cross-network file or text transfer requires signing in; joining with a pairing code does not require an account. Creating a stored download link also requires an account. You are responsible for keeping access to your email and account secure. You can delete your account and its data at any time from your account settings, in the app or on the web. Deletion starts a 30-day grace period during which you can undo it by signing back in; after that, your account and personal data are permanently removed.",
      ],
    },
    {
      heading: "Subscriptions and billing",
      body: [
        "Relayium offers a free tier and optional paid plans. Paid plans are billed in advance on a recurring basis — monthly or yearly, as you choose — and renew automatically until you cancel.",
        "Who sells and bills a subscription depends on where you buy it. On the web, Relayium sells it and Stripe processes the payment, and the terms in this section apply. In a Relayium app installed from the Apple App Store — including the Mac App Store — Apple sells and bills it, and the section below applies instead.",
      ],
      bullets: [
        "Upgrading to a higher plan takes effect immediately and is charged a prorated amount for the remainder of the current period.",
        "Downgrading, or switching to a shorter billing cycle, takes effect at the end of the current period; we do not refund or credit the unused part of a period.",
        "You can cancel at any time. Paid features remain active until the end of the period you have already paid for.",
        "We do not provide refunds for partial periods except where required by law.",
        "We may change plan prices or features. We will give notice before a price change applies to your next renewal, and you may cancel if you do not agree.",
        "On the web, payments are processed by Stripe. In an App Store version of the Relayium app, subscriptions are sold and billed by Apple — see the next section.",
      ],
    },
    {
      heading: "Apple App Store and in-app purchases",
      body: [
        "If you download Relayium from the Apple App Store — including the Mac App Store — Apple's standard Licensed Application End User License Agreement also applies to your use of the app, and Apple is a third-party beneficiary of these terms with the right to enforce them against you.",
      ],
      bullets: [
        "Subscriptions bought inside an App Store version of the Relayium app, including the Mac App Store version, are sold and billed by Apple through in-app purchase, charged to your Apple ID.",
        "They renew automatically unless you turn off auto-renewal at least 24 hours before the current period ends.",
        "Manage or cancel an Apple-billed subscription in your Apple ID account settings — we cannot cancel it for you. Refunds for App Store purchases are requested from Apple and decided by Apple; we cannot issue them.",
        "We can still help: if your Relayium plan does not match what you bought, or you see a charge you do not recognize, write to support@relayium.com and we will check what Apple has told us about your subscription.",
      ],
    },
    {
      heading: "Real-time text",
      body: [
        "Real-time text transfer works only while both devices are online. Messages are end-to-end encrypted and have no offline delivery or server-side history. On the web, cross-network sessions may carry encrypted traffic through a TURN relay; the relay cannot read the message content.",
      ],
    },
    {
      heading: "Stored content",
      body: [
        "When you use the optional stored download-link mode, your browser encrypts files before upload and the server stores only ciphertext. Because we cannot decrypt stored content (zero-knowledge), we cannot pre-screen it. You agree to use stored transfers only for content you have the right to share and that does not violate applicable law.",
        "Stored transfers are a temporary way to deliver files, not a backup. Because links expire and files are deleted after download or at expiry, please keep your own copy of anything important — we cannot recover stored content once it is gone.",
      ],
      bullets: [
        "You may request removal of a specific download link by reporting the file id to support@relayium.com.",
        "Stored ciphertext is automatically deleted at expiry or on the first complete download (burn-after-read), whichever comes first.",
        "We reserve the right to suspend or remove stored content that is credibly reported as illegal.",
      ],
    },
    {
      heading: "No warranty",
      body: [
        "The service is provided \"as is\" and \"as available\", without warranties of any kind, express or implied. We do not guarantee that transfers will always succeed or that the service will be uninterrupted or error-free.",
      ],
    },
    {
      heading: "Limitation of liability",
      body: [
        "To the maximum extent permitted by law, Relayium and its contributors are not liable for any indirect, incidental, or consequential damages, or for any loss of data, arising from your use of the service.",
      ],
    },
    {
      heading: "Open source and licenses",
      body: [
        "Relayium's source code is available under the AGPL-3.0 license. Your use of the source code is governed by that license.",
      ],
    },
    {
      heading: "Governing law",
      body: [
        "These terms are governed by the law applicable where the service operator is established, without removing any mandatory consumer-protection rights you have where you live. If any provision is found unenforceable, the remaining provisions stay in effect.",
      ],
    },
    {
      heading: "Changes to these terms",
      body: [
        "We may update these terms as the service evolves. When we do, we will change the \"Last updated\" date above. Continued use after a change means you accept the updated terms.",
      ],
    },
    {
      heading: "Contact",
      body: ["Questions about these terms? Email support@relayium.com."],
    },
  ],
};

const zh = {
  title: "服务条款",
  description: "使用 Relayium 的条款——一项开源、端到端加密的设备间文件与实时文本传输服务。核心服务免费，另有可选的付费套餐。",
  updatedLabel: "最后更新",
  updated: "2026-08-13",
  otherDocLabel: "隐私政策",
  lead: [
    "使用 Relayium 即表示你同意本条款。Relayium 是一项开源服务，让你在设备之间端到端加密地发送文件与实时文本。核心服务免费，部分可选套餐需付费——详见「订阅与计费」。",
  ],
  sections: [
    {
      heading: "服务说明",
      body: ["Relayium 在设备之间端到端加密地传输文件与实时文本。核心服务免费，其源代码以 AGPL-3.0 许可证开源。可选的付费套餐可提高存储、传输与保留时长上限——详见「订阅与计费」。"],
    },
    {
      heading: "使用资格",
      body: [
        "你须达到能够订立有约束力协议、并能就你所在地的数据处理作出同意的年龄——至少 13 岁，你所在国家要求更高时以其为准。Relayium 并非面向儿童，我们不会在知情的情况下允许儿童创建账号。",
      ],
    },
    {
      heading: "可接受的使用",
      body: ["你同意不将 Relayium 用于："],
      bullets: [
        "违反法律或侵犯他人权利，包括发送你无权分享的内容。",
        "传播恶意软件，或试图扰乱、过载或滥用本服务及其基础设施。",
        "规避安全措施，或试图访问不属于你的数据。",
      ],
    },
    {
      heading: "账号",
      body: [
        "同一网络（局域网）内的传输无需账号。为跨网络文件或文本传输创建配对码时需要登录；持配对码加入无需账号。创建暂存下载链接同样需要账号。你有责任妥善保管你的邮箱和账号访问权限。你可以随时在账号设置中（网页或 App 内）删除你的账号及其数据。删除会进入 30 天宽限期，期间你可重新登录撤销；之后你的账号及个人数据将被永久移除。",
      ],
    },
    {
      heading: "订阅与计费",
      body: [
        "Relayium 提供免费档和可选的付费套餐。付费套餐按你选择的周期（按月或按年）预先、周期性计费，并自动续订，直至你取消。",
        "由谁销售订阅并向你收费，取决于你在哪里购买。在网页端，订阅由 Relayium 销售、由 Stripe 处理支付，适用本节条款；在从 Apple App Store（含 Mac App Store）安装的 Relayium App 内购买时，由 Apple 销售并计费，改为适用下一节。",
      ],
      bullets: [
        "升级到更高套餐立即生效，并按当前周期剩余时间收取按比例的差额。",
        "降级，或切换到更短的计费周期，在当前周期结束时生效；对已用周期的未用部分不退款、不折抵。",
        "你可以随时取消。已付费的权益会保留到你已支付的周期结束为止。",
        "除法律另有要求外，我们不对未满周期提供退款。",
        "我们可能调整套餐价格或功能。价格调整在应用于你的下一次续订前我们会提前通知，你如不同意可取消。",
        "在网页端，支付由 Stripe 处理；在 App Store 版本的 Relayium App 内，订阅由 Apple 销售并计费——见下一节。",
      ],
    },
    {
      heading: "Apple App Store 与应用内购买",
      body: [
        "如果你从 Apple App Store（含 Mac App Store）下载 Relayium，Apple 的标准《授权应用最终用户许可协议》同样适用于你对 App 的使用，且 Apple 是本条款的第三方受益人，有权对你强制执行本条款。",
      ],
      bullets: [
        "在 App Store 版本的 Relayium App（包括 Mac App Store 版本）内购买的订阅，由 Apple 通过应用内购买销售并计费，从你的 Apple ID 扣款。",
        "除非你在当前周期结束前至少 24 小时关闭自动续订，否则订阅将自动续订。",
        "请在你的 Apple ID 账号设置中管理或取消由 Apple 计费的订阅——我们无法代你取消。App Store 购买的退款需向 Apple 申请、由 Apple 决定，我们无法办理。",
        "我们仍然可以帮忙：如果你的 Relayium 套餐与你所购买的不符，或你看到不认识的扣费，请写信到 support@relayium.com，我们会核对 Apple 告知我们的订阅信息。",
      ],
    },
    {
      heading: "实时文本",
      body: [
        "实时文本传输仅在双方设备均在线时工作。消息采用端到端加密，不支持离线投递，也不在服务器端保留历史记录。网页端跨网络会话可能通过 TURN 中继传输密文；中继无法读取消息内容。",
      ],
    },
    {
      heading: "暂存内容",
      body: [
        "使用可选的暂存下载链接功能时，浏览器在上传前加密文件，服务器仅存储密文。由于我们无法解密暂存内容（零知识），因此无法预审其内容。你同意暂存传输仅用于你有权分享且不违反适用法律的内容。",
        "暂存传输是投递文件的临时方式，并非备份。由于链接会过期、文件在下载后或到期时即被删除，请自行保留重要文件的副本——内容一旦消失，我们无法恢复。",
      ],
      bullets: [
        "你可以通过向 support@relayium.com 举报文件 id 来申请删除特定下载链接。",
        "暂存密文在到期或首次完整下载（阅后即焚）时自动删除，以较早发生者为准。",
        "我们保留暂停或删除被可信举报为违法内容的权利。",
      ],
    },
    {
      heading: "不提供担保",
      body: [
        "本服务按「现状」及「现有」提供，不附带任何明示或默示的担保。我们不保证传输总能成功，也不保证服务不中断或无错误。",
      ],
    },
    {
      heading: "责任限制",
      body: [
        "在法律允许的最大范围内，对于因你使用本服务而产生的任何间接、附带或后果性损害，或任何数据丢失，Relayium 及其贡献者概不负责。",
      ],
    },
    {
      heading: "开源与许可",
      body: ["Relayium 的源代码以 AGPL-3.0 许可证提供。你对源代码的使用受该许可证约束。"],
    },
    {
      heading: "适用法律",
      body: [
        "本条款受服务运营方所在地的适用法律管辖，但不影响你所在地依法享有的强制性消费者保护权利。若任何条款被认定为不可执行，其余条款仍然有效。",
      ],
    },
    {
      heading: "本条款的变更",
      body: [
        "随着服务演进，我们可能会更新本条款。届时我们会更新上方的「最后更新」日期。变更后继续使用即表示你接受更新后的条款。",
      ],
    },
    {
      heading: "联系我们",
      body: ["有关于条款的疑问？请发邮件至 support@relayium.com。"],
    },
  ],
};

const ja = {
  title: "利用規約",
  description:
    "Relayium の利用規約——デバイス間でファイルとリアルタイムテキストをエンドツーエンド暗号化して転送するオープンソースサービスです。コア機能は無料で、オプションの有料プランもご利用いただけます。",
  updatedLabel: "最終更新",
  updated: "2026-08-13",
  otherDocLabel: "プライバシーポリシー",
  lead: [
    "本サービスをご利用いただいた時点で、お客様は本規約に同意したものとみなされます。Relayium は、デバイス間でエンドツーエンドで暗号化されたファイルとリアルタイムテキストの送信を可能にする、オープンソースのサービスです。コア機能は無料で、一部のオプションプランは有料です——詳細は「サブスクリプションと請求」をご覧ください。",
  ],
  sections: [
    {
      heading: "サービスについて",
      body: [
        "Relayium はデバイス間でファイルとリアルタイムテキストをエンドツーエンド暗号化して転送します。コア機能は無料で、そのソースコードは AGPL-3.0 ライセンスのもとオープンソースとして公開されています。オプションの有料プランでは、ストレージ、転送、保存期間の上限を引き上げることができます——詳細は「サブスクリプションと請求」をご覧ください。",
      ],
    },
    {
      heading: "利用資格",
      body: [
        "拘束力のある契約を締結し、お住まいの地域でのデータ処理に同意できる年齢に達している必要があります——少なくとも 13 歳以上、またはお住まいの国がそれ以上の年齢を求める場合はその年齢以上である必要があります。Relayium は子供を対象としたサービスではなく、子供が意図的にアカウントを作成できるようにすることはありません。",
      ],
    },
    {
      heading: "許容される使用",
      body: ["お客様は、本サービスを次の目的で利用しないことに同意するものとします。"],
      bullets: [
        "法律に違反したり、他者の権利を侵害したりすること。共有する権利のないコンテンツの送信を含みます。",
        "マルウェアを配布すること、またはサービスやそのインフラを妨害、過負荷にする、または悪用しようとすること。",
        "セキュリティ対策を迂回すること、またはお客様のものではないデータへのアクセスを試みること。",
      ],
    },
    {
      heading: "アカウント",
      body: [
        "同一ネットワーク（LAN）内の転送はアカウント不要です。ネットワークをまたぐファイルまたはテキスト転送用のペアリングコードを作成するにはサインインが必要ですが、コードを使って参加する側はアカウント不要です。保存型ダウンロードリンクの作成にもアカウントが必要です。メールアドレスとアカウントへのアクセスを安全に保つ責任はお客様にあります。アカウントとそのデータは、アプリまたはウェブのアカウント設定からいつでも削除できます。削除を行うと 30 日間の猶予期間が始まり、その間に再度サインインすることで削除を取り消すことができます。その後、アカウントと個人データは完全に削除されます。",
      ],
    },
    {
      heading: "サブスクリプションと請求",
      body: [
        "Relayium は無料プランとオプションの有料プランを提供しています。有料プランは、選択した周期（月次または年次）で前払いにより定期的に請求され、お客様が解約するまで自動更新されます。",
        "サブスクリプションを販売・請求するのが誰かは、どこで購入したかによって決まります。ウェブでは Relayium が販売し、Stripe が支払いを処理するため、本セクションの条件が適用されます。Apple App Store（Mac App Store を含む）からインストールした Relayium アプリ内で購入した場合は、Apple が販売・請求し、代わりに次のセクションが適用されます。",
      ],
      bullets: [
        "上位プランへのアップグレードは即座に適用され、当該期間の残り分に応じた日割り金額が請求されます。",
        "ダウングレード、またはより短い請求周期への切り替えは、現在の期間終了時に適用されます。期間の未使用分について返金や積み立てはありません。",
        "いつでも解約できます。有料機能は、すでに支払い済みの期間の終了まで有効です。",
        "法律で義務付けられている場合を除き、期間途中の返金は行いません。",
        "プランの価格や機能を変更する場合があります。価格変更が次回の更新に適用される前に通知し、同意いただけない場合は解約できます。",
        "ウェブでは、支払いは Stripe によって処理されます。App Store 版の Relayium アプリでは、サブスクリプションは Apple によって販売・請求されます——次のセクションをご覧ください。",
      ],
    },
    {
      heading: "Apple App Store とアプリ内課金",
      body: [
        "Relayium を Apple App Store（Mac App Store を含む）からダウンロードした場合、Apple の標準的な「ライセンス供与アプリケーション使用許諾契約（Licensed Application End User License Agreement）」もアプリの利用に適用され、Apple は本規約の第三者受益者として、これをお客様に対して執行する権利を有します。",
      ],
      bullets: [
        "App Store 版の Relayium アプリ（Mac App Store 版を含む）内で購入したサブスクリプションは、アプリ内課金を通じて Apple が販売・請求し、お客様の Apple ID に課金されます。",
        "現在の期間終了の少なくとも 24 時間前に自動更新をオフにしない限り、自動的に更新されます。",
        "Apple が請求するサブスクリプションの管理・解約は、お客様の Apple ID のアカウント設定から行ってください——当社がお客様に代わって解約することはできません。App Store 購入の返金は Apple に申請し、Apple が判断するもので、当社が返金することはできません。",
        "それでもお手伝いできることがあります。Relayium のプランが購入内容と一致しない場合や、心当たりのない請求がある場合は support@relayium.com までご連絡ください。Apple から当社に届いているサブスクリプションの情報を確認します。",
      ],
    },
    {
      heading: "リアルタイムテキスト",
      body: [
        "リアルタイムテキスト転送は、両方のデバイスがオンラインの間だけ機能します。メッセージはエンドツーエンドで暗号化され、オフライン配信やサーバー側の履歴はありません。ウェブでは、ネットワークをまたぐセッションの暗号化された通信が TURN リレーを通る場合がありますが、リレーはメッセージ内容を読み取れません。",
      ],
    },
    {
      heading: "保存コンテンツ",
      body: [
        "オプションの一時保存ダウンロードリンク機能を使用する場合、ブラウザがアップロード前にファイルを暗号化し、サーバーは暗号文のみを保存します。保存コンテンツを復号できない（ゼロ知識）ため、当社は事前にコンテンツを審査することができません。お客様は、一時保存転送を、共有する権利を持ちかつ適用法に違反しないコンテンツのためにのみ利用することに同意するものとします。",
        "保存転送はファイルを届けるための一時的な手段であり、バックアップではありません。リンクは期限切れになり、ファイルはダウンロード後または期限切れ時に削除されるため、重要なものは必ずご自身で控えを保管してください——一度失われたコンテンツを当社が復元することはできません。",
      ],
      bullets: [
        "ファイルの id を support@relayium.com に報告することで、特定のダウンロードリンクの削除を要求できます。",
        "保存された暗号文は有効期限切れまたは最初の完全なダウンロード（閲覧後削除）のいずれか早い方で自動削除されます。",
        "当社は、違法であると信頼できる形で報告された保存コンテンツを停止または削除する権利を留保します。",
      ],
    },
    {
      heading: "無保証",
      body: [
        "本サービスは「現状のまま」および「利用可能な状態で」提供され、明示または黙示を問わず、いかなる種類の保証も行いません。転送が常に成功すること、またはサービスが中断なく、エラーなく提供されることを保証しません。",
      ],
    },
    {
      heading: "責任の制限",
      body: [
        "法律で許可される最大限の範囲において、Relayium およびその貢献者は、本サービスの利用に起因するいかなる間接的、付随的、または結果的損害、あるいはデータの損失についても責任を負いません。",
      ],
    },
    {
      heading: "オープンソースとライセンス",
      body: [
        "Relayium のソースコードは AGPL-3.0 ライセンスのもとで公開されています。ソースコードの使用はそのライセンスに従います。",
      ],
    },
    {
      heading: "準拠法",
      body: [
        "本規約は、サービス運営者の所在地で適用される法律に準拠しますが、これによりお住まいの地域で法律上認められている強制的な消費者保護の権利が失われることはありません。いずれかの条項が執行不能と判断された場合でも、残りの条項は引き続き有効です。",
      ],
    },
    {
      heading: "本規約の変更",
      body: [
        "サービスの進化に伴い、本規約を更新することがあります。更新した場合は、上記の「最終更新」日付を変更します。変更後も引き続き使用することで、更新された規約に同意したものとみなします。",
      ],
    },
    {
      heading: "お問い合わせ",
      body: ["規約に関するご質問は、support@relayium.com までメールでお問い合わせください。"],
    },
  ],
};

const ko = {
  title: "이용약관",
  description:
    "Relayium 이용약관 — 기기 간 파일 및 실시간 텍스트를 종단간 암호화하여 전송하는 오픈소스 서비스입니다. 핵심 서비스는 무료이며, 선택적인 유료 플랜을 이용할 수 있습니다.",
  updatedLabel: "최종 업데이트",
  updated: "2026-08-13",
  otherDocLabel: "개인정보 처리방침",
  lead: [
    "Relayium을 사용함으로써 귀하는 이 약관에 동의하는 것으로 간주됩니다. Relayium은 기기 간에 종단간 암호화된 파일과 실시간 텍스트 전송을 지원하는 오픈소스 서비스입니다. 핵심 서비스는 무료이며, 일부 선택적 플랜은 유료입니다 — 자세한 내용은 ‘구독 및 결제’를 참고하세요.",
  ],
  sections: [
    {
      heading: "서비스 소개",
      body: [
        "Relayium은 기기 간에 파일과 실시간 텍스트를 종단간 암호화하여 전송합니다. 핵심 서비스는 무료이며 소스 코드는 AGPL-3.0 라이선스 하에 오픈소스로 공개되어 있습니다. 선택적 유료 플랜을 이용하면 저장 용량, 전송량, 보관 기간 한도를 늘릴 수 있습니다 — 자세한 내용은 ‘구독 및 결제’를 참고하세요.",
      ],
    },
    {
      heading: "이용 자격",
      body: [
        "귀하는 구속력 있는 계약을 체결하고 거주 지역에서 데이터 처리에 동의할 수 있는 연령이어야 합니다 — 최소 13세 이상이거나, 거주 국가에서 더 높은 연령을 요구하는 경우 그 연령 이상이어야 합니다. Relayium은 아동을 대상으로 하지 않으며, 아동이 계정을 생성하도록 고의로 허용하지 않습니다.",
      ],
    },
    {
      heading: "허용 가능한 사용",
      body: ["귀하는 Relayium을 다음 목적으로 사용하지 않을 것에 동의합니다:"],
      bullets: [
        "법률을 위반하거나 타인의 권리를 침해하는 행위. 공유할 권리가 없는 콘텐츠 전송을 포함합니다.",
        "악성 소프트웨어를 배포하거나, 서비스 또는 그 인프라를 방해하거나 과부하를 일으키거나 남용하려는 행위.",
        "보안 조치를 우회하거나 귀하의 것이 아닌 데이터에 접근하려는 행위.",
      ],
    },
    {
      heading: "계정",
      body: [
        "동일 네트워크(LAN) 내 전송은 계정이 필요 없습니다. 네트워크 간 파일 또는 텍스트 전송용 페어링 코드를 만들려면 로그인해야 하지만, 코드를 가지고 참여하는 쪽은 계정이 필요 없습니다. 저장형 다운로드 링크를 만드는 데도 계정이 필요합니다. 이메일 주소와 계정에 대한 접근을 안전하게 관리할 책임은 귀하에게 있습니다. 귀하는 앱 또는 웹의 계정 설정에서 언제든지 계정과 그 데이터를 삭제할 수 있습니다. 삭제를 시작하면 30일의 유예 기간이 시작되며, 이 기간 동안 다시 로그인하여 삭제를 취소할 수 있습니다. 그 이후에는 계정과 개인 데이터가 영구적으로 삭제됩니다.",
      ],
    },
    {
      heading: "구독 및 결제",
      body: [
        "Relayium은 무료 등급과 선택적 유료 플랜을 제공합니다. 유료 플랜은 귀하가 선택한 주기(월간 또는 연간)로 선불 방식으로 정기 청구되며, 귀하가 취소할 때까지 자동으로 갱신됩니다.",
        "구독을 판매하고 청구하는 주체는 어디에서 구매했는지에 따라 달라집니다. 웹에서는 Relayium이 판매하고 Stripe가 결제를 처리하며, 이 절의 조건이 적용됩니다. Apple App Store(Mac App Store 포함)에서 설치한 Relayium 앱 안에서 구매한 경우에는 Apple이 판매하고 청구하며, 대신 아래의 절이 적용됩니다.",
      ],
      bullets: [
        "상위 플랜으로 업그레이드하면 즉시 적용되며, 현재 기간의 남은 기간에 대해 일할 계산된 금액이 청구됩니다.",
        "다운그레이드하거나 더 짧은 결제 주기로 전환하는 경우 현재 기간이 끝날 때 적용됩니다. 사용하지 않은 기간에 대해서는 환불이나 크레딧을 제공하지 않습니다.",
        "언제든지 취소할 수 있습니다. 유료 기능은 이미 결제한 기간이 끝날 때까지 계속 사용할 수 있습니다.",
        "법률상 요구되는 경우를 제외하고 부분 기간에 대한 환불은 제공하지 않습니다.",
        "당사는 플랜 가격이나 기능을 변경할 수 있습니다. 가격 변경이 다음 갱신에 적용되기 전에 통지하며, 동의하지 않으시면 취소할 수 있습니다.",
        "웹에서는 결제가 Stripe를 통해 처리됩니다. App Store 버전의 Relayium 앱에서는 구독이 Apple을 통해 판매 및 청구됩니다 — 다음 섹션을 참고하세요.",
      ],
    },
    {
      heading: "Apple App Store 및 인앱 구매",
      body: [
        "Apple App Store(Mac App Store 포함)에서 Relayium을 다운로드하는 경우, Apple의 표준 ‘라이선스 애플리케이션 최종 사용자 사용권 계약(Licensed Application End User License Agreement)’도 앱 사용에 적용되며, Apple은 이 약관의 제3자 수익자로서 귀하에게 이를 집행할 권리를 가집니다.",
      ],
      bullets: [
        "App Store 버전의 Relayium 앱(Mac App Store 버전 포함)에서 구매한 구독은 인앱 구매를 통해 Apple이 판매 및 청구하며, 귀하의 Apple ID로 청구됩니다.",
        "현재 기간이 끝나기 최소 24시간 전에 자동 갱신을 끄지 않는 한 자동으로 갱신됩니다.",
        "Apple이 청구하는 구독은 귀하의 Apple ID 계정 설정에서 관리하거나 취소하세요 — 당사는 이를 대신 취소할 수 없습니다. App Store 구매에 대한 환불은 Apple에 요청하고 Apple이 결정하며, 당사가 환불해 드릴 수 없습니다.",
        "그래도 도와드릴 수 있습니다. Relayium 요금제가 구매하신 내용과 다르거나 알 수 없는 청구가 보이면 support@relayium.com으로 문의해 주십시오. Apple이 당사에 알려준 구독 정보를 확인해 드리겠습니다.",
      ],
    },
    {
      heading: "실시간 텍스트",
      body: [
        "실시간 텍스트 전송은 두 기기가 모두 온라인일 때만 작동합니다. 메시지는 종단간 암호화되며 오프라인 전달이나 서버 측 기록은 없습니다. 웹에서는 네트워크 간 세션의 암호화된 트래픽이 TURN 릴레이를 통과할 수 있지만, 릴레이는 메시지 내용을 읽을 수 없습니다.",
      ],
    },
    {
      heading: "임시 보관 콘텐츠",
      body: [
        "선택적 임시 보관 다운로드 링크 기능을 사용하면 브라우저가 업로드 전에 파일을 암호화하고 서버는 암호문만 저장합니다. 저장된 콘텐츠를 복호화할 수 없기 때문에(영지식) 사전에 콘텐츠를 심사할 수 없습니다. 귀하는 임시 보관 전송을 공유할 권리가 있고 적용 법률을 위반하지 않는 콘텐츠에만 사용하는 것에 동의합니다.",
        "임시 보관 전송은 파일을 전달하기 위한 일시적인 수단이며 백업이 아닙니다. 링크는 만료되고 파일은 다운로드 후 또는 만료 시 삭제되므로, 중요한 파일은 반드시 본인이 직접 사본을 보관하시기 바랍니다 — 한 번 사라진 저장 콘텐츠는 당사도 복구할 수 없습니다.",
      ],
      bullets: [
        "파일 id를 support@relayium.com에 신고하여 특정 다운로드 링크 삭제를 요청할 수 있습니다.",
        "저장된 암호문은 만료 시 또는 첫 번째 완전한 다운로드(열람 후 삭제) 중 먼저 발생하는 시점에 자동 삭제됩니다.",
        "당사는 불법으로 신뢰할 수 있게 신고된 저장 콘텐츠를 정지 또는 삭제할 권리를 보유합니다.",
      ],
    },
    {
      heading: "무보증",
      body: [
        "본 서비스는 명시적 또는 묵시적 보증 없이 ‘있는 그대로’ 및 ‘이용 가능한 상태로’ 제공됩니다. 전송이 항상 성공하거나 서비스가 중단 없이 오류 없이 제공될 것을 보장하지 않습니다.",
      ],
    },
    {
      heading: "책임 제한",
      body: [
        "법률이 허용하는 최대 범위 내에서, Relayium 및 그 기여자는 귀하의 서비스 이용으로 인한 간접적, 부수적 또는 결과적 손해나 데이터 손실에 대해 어떠한 책임도 지지 않습니다.",
      ],
    },
    {
      heading: "오픈소스 및 라이선스",
      body: [
        "Relayium의 소스 코드는 AGPL-3.0 라이선스 하에 이용 가능합니다. 소스 코드의 사용은 해당 라이선스의 적용을 받습니다.",
      ],
    },
    {
      heading: "준거법",
      body: [
        "이 약관은 서비스 운영자가 설립된 지역에 적용되는 법률의 적용을 받으며, 귀하가 거주하는 지역에서 법적으로 보장되는 강행 소비자 보호 권리를 제거하지 않습니다. 일부 조항이 집행 불가능한 것으로 판단되더라도 나머지 조항은 계속 유효합니다.",
      ],
    },
    {
      heading: "약관 변경",
      body: [
        "서비스가 발전함에 따라 이 약관을 업데이트할 수 있습니다. 업데이트 시 위의 ‘최종 업데이트’ 날짜를 변경합니다. 변경 후 계속 사용하는 것은 업데이트된 약관에 동의하는 것을 의미합니다.",
      ],
    },
    {
      heading: "문의",
      body: ["이 약관에 관한 질문이 있으시면 support@relayium.com으로 이메일을 보내주세요."],
    },
  ],
};

const de = {
  title: "Nutzungsbedingungen",
  description:
    "Die Nutzungsbedingungen für Relayium — einen quelloffenen Dienst für Ende-zu-Ende-verschlüsselte Datei- und Echtzeittextübertragungen zwischen Geräten. Der Kerndienst ist kostenlos; optionale kostenpflichtige Pläne sind verfügbar.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-08-13",
  otherDocLabel: "Datenschutzerklärung",
  lead: [
    "Durch die Nutzung von Relayium stimmen Sie diesen Bedingungen zu. Relayium ist ein quelloffener Dienst, mit dem Sie Dateien und Echtzeittext Ende-zu-Ende-verschlüsselt zwischen Geräten senden können. Der Kerndienst ist kostenlos; einige optionale Pläne sind kostenpflichtig — siehe Abonnements und Abrechnung.",
  ],
  sections: [
    {
      heading: "Der Dienst",
      body: [
        "Relayium überträgt Dateien und Echtzeittext Ende-zu-Ende-verschlüsselt zwischen Geräten. Der Kerndienst ist kostenlos und sein Quellcode ist unter der AGPL-3.0-Lizenz quelloffen. Optionale kostenpflichtige Pläne erhöhen die Grenzwerte für Speicher, Übertragung und Aufbewahrung — siehe Abonnements und Abrechnung.",
      ],
    },
    {
      heading: "Berechtigung",
      body: [
        "Sie müssen alt genug sein, um eine bindende Vereinbarung einzugehen und der Verarbeitung Ihrer Daten an Ihrem Wohnort zuzustimmen — mindestens 13 Jahre alt oder älter, falls dies in Ihrem Land vorgeschrieben ist. Relayium richtet sich nicht an Kinder, und wir gestatten Kindern nicht wissentlich, Konten zu erstellen.",
      ],
    },
    {
      heading: "Zulässige Nutzung",
      body: ["Sie stimmen zu, Relayium nicht für Folgendes zu verwenden:"],
      bullets: [
        "Gesetze zu brechen oder die Rechte anderer zu verletzen, einschließlich des Sendens von Inhalten, zu deren Weitergabe Sie nicht berechtigt sind.",
        "Schadsoftware zu verbreiten oder zu versuchen, den Dienst oder seine Infrastruktur zu stören, zu überlasten oder zu missbrauchen.",
        "Sicherheitsmaßnahmen zu umgehen oder zu versuchen, auf Daten zuzugreifen, die nicht Ihnen gehören.",
      ],
    },
    {
      heading: "Konten",
      body: [
        "Übertragungen im selben Netzwerk (LAN) benötigen kein Konto. Für das Erstellen eines Pairing-Codes für eine netzwerkübergreifende Datei- oder Textübertragung ist eine Anmeldung erforderlich; der Beitritt mit einem Pairing-Code erfordert kein Konto. Auch das Erstellen eines gespeicherten Download-Links erfordert ein Konto. Sie sind dafür verantwortlich, den Zugang zu Ihrer E-Mail-Adresse und Ihrem Konto zu sichern. Sie können Ihr Konto und die zugehörigen Daten jederzeit in den Kontoeinstellungen in der App oder im Web löschen. Mit der Löschung beginnt eine 30-tägige Karenzzeit, innerhalb derer Sie sie durch erneutes Anmelden rückgängig machen können; danach werden Ihr Konto und Ihre personenbezogenen Daten dauerhaft entfernt.",
      ],
    },
    {
      heading: "Abonnements und Abrechnung",
      body: [
        "Relayium bietet eine kostenlose Stufe und optionale kostenpflichtige Pläne an. Kostenpflichtige Pläne werden im Voraus wiederkehrend abgerechnet — monatlich oder jährlich, je nach Wahl — und verlängern sich automatisch, bis Sie kündigen.",
        "Wer ein Abonnement verkauft und abrechnet, hängt davon ab, wo Sie es kaufen. Im Web verkauft Relayium es und Stripe verarbeitet die Zahlung; dann gilt dieser Abschnitt. In einer Relayium-App, die aus dem Apple App Store — einschließlich des Mac App Store — installiert wurde, verkauft und berechnet Apple es, und stattdessen gilt der folgende Abschnitt.",
      ],
      bullets: [
        "Ein Upgrade auf einen höheren Plan wird sofort wirksam und für den verbleibenden Teil des aktuellen Zeitraums anteilig berechnet.",
        "Ein Downgrade oder der Wechsel zu einem kürzeren Abrechnungszyklus wird zum Ende des aktuellen Zeitraums wirksam; wir erstatten oder gutschreiben nicht den ungenutzten Teil eines Zeitraums.",
        "Sie können jederzeit kündigen. Kostenpflichtige Funktionen bleiben bis zum Ende des bereits bezahlten Zeitraums aktiv.",
        "Wir erstatten keine anteiligen Zeiträume, außer wenn gesetzlich vorgeschrieben.",
        "Wir können Preise oder Funktionen von Plänen ändern. Wir informieren Sie vor Inkrafttreten einer Preisänderung bei Ihrer nächsten Verlängerung, und Sie können kündigen, wenn Sie damit nicht einverstanden sind.",
        "Im Web werden Zahlungen von Stripe verarbeitet. In einer App-Store-Version der Relayium-App werden Abonnements von Apple verkauft und abgerechnet — siehe nächster Abschnitt.",
      ],
    },
    {
      heading: "Apple App Store und In-App-Käufe",
      body: [
        "Wenn Sie Relayium aus dem Apple App Store — einschließlich des Mac App Store — herunterladen, gilt für Ihre Nutzung der App zusätzlich Apples standardmäßige „Licensed Application End User License Agreement“ (Endbenutzer-Lizenzvertrag für lizenzierte Anwendungen), und Apple ist begünstigter Dritter dieser Bedingungen mit dem Recht, sie Ihnen gegenüber durchzusetzen.",
      ],
      bullets: [
        "Abonnements, die in einer App-Store-Version der Relayium-App gekauft werden — einschließlich der Version aus dem Mac App Store —, werden von Apple über In-App-Käufe verkauft und abgerechnet und Ihrer Apple-ID belastet.",
        "Sie verlängern sich automatisch, sofern Sie die automatische Verlängerung nicht mindestens 24 Stunden vor Ablauf des aktuellen Zeitraums deaktivieren.",
        "Verwalten oder kündigen Sie ein von Apple abgerechnetes Abonnement in Ihren Apple-ID-Kontoeinstellungen — wir können es nicht für Sie kündigen. Erstattungen für App-Store-Käufe werden bei Apple beantragt und von Apple entschieden; wir können sie nicht auszahlen.",
        "Wir können trotzdem helfen: Wenn Ihr Relayium-Tarif nicht zu dem passt, was Sie gekauft haben, oder Ihnen eine Abbuchung unbekannt vorkommt, schreiben Sie an support@relayium.com — wir prüfen, was Apple uns zu Ihrem Abonnement gemeldet hat.",
      ],
    },
    {
      heading: "Echtzeittext",
      body: [
        "Echtzeittextübertragungen funktionieren nur, solange beide Geräte online sind. Nachrichten sind Ende-zu-Ende-verschlüsselt; es gibt weder Offline-Zustellung noch einen serverseitigen Verlauf. Im Web kann der verschlüsselte Datenverkehr netzwerkübergreifender Sitzungen über ein TURN-Relay laufen; das Relay kann den Nachrichteninhalt nicht lesen.",
      ],
    },
    {
      heading: "Zwischengespeicherte Inhalte",
      body: [
        "Beim optionalen Modus für zwischengespeicherte Download-Links verschlüsselt Ihr Browser die Dateien vor dem Hochladen und der Server speichert nur Chiffretext. Da wir zwischengespeicherte Inhalte nicht entschlüsseln können (Zero-Knowledge), ist eine Vorabprüfung der Inhalte nicht möglich. Sie stimmen zu, zwischengespeicherte Übertragungen ausschließlich für Inhalte zu nutzen, zu deren Weitergabe Sie berechtigt sind und die nicht gegen geltendes Recht verstoßen.",
        "Zwischengespeicherte Übertragungen sind eine vorübergehende Art, Dateien zuzustellen, kein Backup. Da Links ablaufen und Dateien nach dem Download oder bei Ablauf gelöscht werden, bewahren Sie bitte eine eigene Kopie von allem Wichtigen auf — einmal verlorene gespeicherte Inhalte können wir nicht wiederherstellen.",
      ],
      bullets: [
        "Sie können die Entfernung eines bestimmten Download-Links beantragen, indem Sie die Datei-id an support@relayium.com melden.",
        "Zwischengespeicherter Chiffretext wird automatisch gelöscht, wenn er abläuft oder beim ersten vollständigen Download (Burn-after-read) — je nachdem, was zuerst eintritt.",
        "Wir behalten uns das Recht vor, zwischengespeicherte Inhalte, die glaubhaft als illegal gemeldet wurden, zu sperren oder zu entfernen.",
      ],
    },
    {
      heading: "Keine Gewährleistung",
      body: [
        "Der Dienst wird „wie besehen“ und „wie verfügbar“ ohne jegliche ausdrückliche oder stillschweigende Gewährleistung bereitgestellt. Wir garantieren nicht, dass Übertragungen stets erfolgreich sind oder dass der Dienst unterbrechungs- und fehlerfrei verfügbar ist.",
      ],
    },
    {
      heading: "Haftungsbeschränkung",
      body: [
        "Soweit gesetzlich zulässig, haften Relayium und seine Mitwirkenden nicht für mittelbare, zufällige oder Folgeschäden oder für Datenverluste, die durch Ihre Nutzung des Dienstes entstehen.",
      ],
    },
    {
      heading: "Open Source und Lizenzen",
      body: [
        "Der Quellcode von Relayium ist unter der AGPL-3.0-Lizenz verfügbar. Ihre Nutzung des Quellcodes unterliegt dieser Lizenz.",
      ],
    },
    {
      heading: "Anwendbares Recht",
      body: [
        "Diese Bedingungen unterliegen dem Recht, das am Sitz des Dienstanbieters gilt, unbeschadet zwingender verbraucherschützender Rechte, die Ihnen an Ihrem Wohnort zustehen. Sollte eine Bestimmung als nicht durchsetzbar erachtet werden, bleiben die übrigen Bestimmungen in Kraft.",
      ],
    },
    {
      heading: "Änderungen dieser Bedingungen",
      body: [
        "Wir können diese Bedingungen aktualisieren, wenn sich der Dienst weiterentwickelt. In diesem Fall ändern wir das oben genannte Datum „Zuletzt aktualisiert“. Die fortgesetzte Nutzung nach einer Änderung bedeutet, dass Sie die aktualisierten Bedingungen akzeptieren.",
      ],
    },
    {
      heading: "Kontakt",
      body: ["Fragen zu diesen Bedingungen? Schreiben Sie uns an support@relayium.com."],
    },
  ],
};

const fr = {
  title: "Conditions d'utilisation",
  description:
    "Les conditions d'utilisation de Relayium — un service open source de transfert de fichiers et de texte en temps réel entre appareils, chiffré de bout en bout. Le service de base est gratuit ; des offres payantes optionnelles sont disponibles.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-08-13",
  otherDocLabel: "Politique de confidentialité",
  lead: [
    "En utilisant Relayium, vous acceptez ces conditions. Relayium est un service open source qui vous permet d'envoyer des fichiers et du texte en temps réel entre appareils, chiffrés de bout en bout. Le service de base est gratuit ; certaines offres optionnelles sont payantes — voir Abonnements et facturation.",
  ],
  sections: [
    {
      heading: "Le service",
      body: [
        "Relayium transfère des fichiers et du texte en temps réel entre appareils, chiffrés de bout en bout. Le service de base est gratuit et son code source est open source sous licence AGPL-3.0. Les offres payantes optionnelles augmentent les limites de stockage, de transfert et de conservation — voir Abonnements et facturation.",
      ],
    },
    {
      heading: "Éligibilité",
      body: [
        "Vous devez avoir l'âge requis pour conclure un contrat contraignant et pour consentir au traitement de vos données là où vous vivez — au moins 13 ans, ou plus si votre pays l'exige. Relayium ne s'adresse pas aux enfants, et nous ne permettons pas sciemment aux enfants de créer des comptes.",
      ],
    },
    {
      heading: "Utilisation acceptable",
      body: ["Vous acceptez de ne pas utiliser Relayium pour :"],
      bullets: [
        "Enfreindre la loi ou porter atteinte aux droits d'autrui, notamment en envoyant des contenus que vous n'avez pas le droit de partager.",
        "Distribuer des logiciels malveillants, ou tenter de perturber, de surcharger ou d'abuser du service ou de son infrastructure.",
        "Contourner les mesures de sécurité ou tenter d'accéder à des données qui ne vous appartiennent pas.",
      ],
    },
    {
      heading: "Comptes",
      body: [
        "Les transferts sur le même réseau (local) ne nécessitent aucun compte. La création d'un code d'appairage pour un transfert de fichier ou de texte entre réseaux exige une connexion ; rejoindre avec un code d'appairage ne nécessite aucun compte. La création d'un lien de téléchargement stocké exige elle aussi un compte. Vous êtes responsable de la sécurisation de l'accès à votre adresse e-mail et à votre compte. Vous pouvez supprimer votre compte et ses données à tout moment depuis les paramètres de votre compte, dans l'application ou sur le web. La suppression déclenche un délai de grâce de 30 jours pendant lequel vous pouvez l'annuler en vous reconnectant ; passé ce délai, votre compte et vos données personnelles sont définitivement supprimés.",
      ],
    },
    {
      heading: "Abonnements et facturation",
      body: [
        "Relayium propose un niveau gratuit et des offres payantes optionnelles. Les offres payantes sont facturées à l'avance de façon récurrente — mensuellement ou annuellement, selon votre choix — et se renouvellent automatiquement jusqu'à ce que vous annuliez.",
        "Qui vend et facture un abonnement dépend de l'endroit où vous l'achetez. Sur le web, Relayium le vend et Stripe traite le paiement : la présente section s'applique. Dans une application Relayium installée depuis l'Apple App Store — y compris le Mac App Store —, Apple le vend et le facture, et c'est la section suivante qui s'applique.",
      ],
      bullets: [
        "Le passage à une offre supérieure prend effet immédiatement et est facturé au prorata pour le reste de la période en cours.",
        "Le passage à une offre inférieure, ou à un cycle de facturation plus court, prend effet à la fin de la période en cours ; nous ne remboursons ni ne créditons la partie inutilisée d'une période.",
        "Vous pouvez annuler à tout moment. Les fonctionnalités payantes restent actives jusqu'à la fin de la période déjà payée.",
        "Nous ne remboursons pas les périodes partielles, sauf lorsque la loi l'exige.",
        "Nous pouvons modifier les prix ou les fonctionnalités des offres. Nous vous préviendrons avant qu'un changement de prix ne s'applique à votre prochain renouvellement, et vous pourrez annuler si vous n'êtes pas d'accord.",
        "Sur le web, les paiements sont traités par Stripe. Dans une version App Store de l'application Relayium, les abonnements sont vendus et facturés par Apple — voir la section suivante.",
      ],
    },
    {
      heading: "Apple App Store et achats intégrés",
      body: [
        "Si vous téléchargez Relayium depuis l'Apple App Store — y compris le Mac App Store —, le contrat de licence utilisateur final standard d'Apple pour les applications sous licence (« Licensed Application End User License Agreement ») s'applique également à votre utilisation de l'application, et Apple est un bénéficiaire tiers des présentes conditions, avec le droit de les faire appliquer à votre encontre.",
      ],
      bullets: [
        "Les abonnements achetés dans une version App Store de l'application Relayium, y compris la version Mac App Store, sont vendus et facturés par Apple via un achat intégré, débité sur votre identifiant Apple.",
        "Ils se renouvellent automatiquement sauf si vous désactivez le renouvellement automatique au moins 24 heures avant la fin de la période en cours.",
        "Gérez ou annulez un abonnement facturé par Apple dans les paramètres de votre compte identifiant Apple — nous ne pouvons pas l'annuler à votre place. Les remboursements des achats sur l'App Store se demandent auprès d'Apple et sont décidés par Apple ; nous ne pouvons pas les effectuer.",
        "Nous pouvons tout de même vous aider : si votre offre Relayium ne correspond pas à ce que vous avez acheté, ou si un prélèvement vous est inconnu, écrivez à support@relayium.com et nous vérifierons ce qu'Apple nous a communiqué sur votre abonnement.",
      ],
    },
    {
      heading: "Texte en temps réel",
      body: [
        "Le transfert de texte en temps réel fonctionne uniquement lorsque les deux appareils sont en ligne. Les messages sont chiffrés de bout en bout, sans livraison hors ligne ni historique côté serveur. Sur le web, les sessions entre réseaux peuvent faire transiter leur trafic chiffré par un relais TURN ; ce relais ne peut pas lire le contenu des messages.",
      ],
    },
    {
      heading: "Contenu stocké",
      body: [
        "Lorsque vous utilisez le mode optionnel de liens de téléchargement stockés, votre navigateur chiffre les fichiers avant l'envoi et le serveur ne stocke que du chiffré. Comme nous ne pouvons pas déchiffrer le contenu stocké (à divulgation nulle), nous ne pouvons pas en faire une présélection. Vous acceptez d'utiliser les transferts stockés uniquement pour du contenu que vous avez le droit de partager et qui ne viole pas la loi applicable.",
        "Les transferts stockés sont un moyen temporaire de livrer des fichiers, pas une sauvegarde. Comme les liens expirent et que les fichiers sont supprimés après le téléchargement ou à l'expiration, conservez votre propre copie de tout ce qui compte pour vous — nous ne pouvons pas récupérer un contenu stocké une fois qu'il a disparu.",
      ],
      bullets: [
        "Vous pouvez demander la suppression d'un lien de téléchargement spécifique en signalant l'id du fichier à support@relayium.com.",
        "Le chiffré stocké est automatiquement supprimé à l'expiration ou lors du premier téléchargement complet (lecture unique), selon ce qui survient en premier.",
        "Nous nous réservons le droit de suspendre ou de supprimer du contenu stocké qui est signalé de manière crédible comme illégal.",
      ],
    },
    {
      heading: "Absence de garantie",
      body: [
        "Le service est fourni « tel quel » et « selon disponibilité », sans garantie d'aucune sorte, expresse ou implicite. Nous ne garantissons pas que les transferts aboutiront toujours ni que le service sera ininterrompu ou exempt d'erreurs.",
      ],
    },
    {
      heading: "Limitation de responsabilité",
      body: [
        "Dans toute la mesure permise par la loi, Relayium et ses contributeurs ne sont pas responsables des dommages indirects, accessoires ou consécutifs, ni de toute perte de données résultant de votre utilisation du service.",
      ],
    },
    {
      heading: "Open source et licences",
      body: [
        "Le code source de Relayium est disponible sous licence AGPL-3.0. Votre utilisation du code source est régie par cette licence.",
      ],
    },
    {
      heading: "Droit applicable",
      body: [
        "Ces conditions sont régies par le droit applicable là où l'opérateur du service est établi, sans que cela ne supprime les droits impératifs de protection des consommateurs dont vous bénéficiez là où vous vivez. Si une disposition est jugée inapplicable, les autres dispositions restent en vigueur.",
      ],
    },
    {
      heading: "Modifications des présentes conditions",
      body: [
        "Nous pouvons mettre à jour ces conditions au fur et à mesure de l'évolution du service. Dans ce cas, nous modifierons la date « Dernière mise à jour » ci-dessus. La poursuite de l'utilisation après une modification signifie que vous acceptez les conditions mises à jour.",
      ],
    },
    {
      heading: "Contact",
      body: ["Des questions sur ces conditions ? Écrivez-nous à support@relayium.com."],
    },
  ],
};

const ar = {
  title: "شروط الخدمة",
  description:
    "شروط استخدام Relayium — خدمة مفتوحة المصدر لنقل الملفات والنصوص الفورية بين الأجهزة بتشفير من الطرف إلى الطرف. الخدمة الأساسية مجانية؛ وتتوفر خطط مدفوعة اختيارية.",
  updatedLabel: "آخر تحديث",
  updated: "2026-08-13",
  otherDocLabel: "سياسة الخصوصية",
  lead: [
    "باستخدامك Relayium فإنك توافق على هذه الشروط. Relayium خدمة مفتوحة المصدر تتيح لك إرسال الملفات والنصوص الفورية بين الأجهزة، مُشفَّرة من الطرف إلى الطرف. الخدمة الأساسية مجانية؛ وبعض الخطط الاختيارية مدفوعة — راجع «الاشتراكات والفوترة».",
  ],
  sections: [
    {
      heading: "الخدمة",
      body: [
        "تنقل Relayium الملفات والنصوص الفورية بين الأجهزة بتشفير من الطرف إلى الطرف. الخدمة الأساسية مجانية وشِفرتها المصدرية مفتوحة المصدر بموجب رخصة AGPL-3.0. تتيح الخطط المدفوعة الاختيارية رفع حدود التخزين والنقل والاحتفاظ بالبيانات — راجع «الاشتراكات والفوترة».",
      ],
    },
    {
      heading: "الأهلية",
      body: [
        "يجب أن تكون في سنٍّ يسمح لك بإبرام اتفاقية مُلزِمة وبالموافقة على معالجة بياناتك في مكان إقامتك — 13 عامًا على الأقل، أو أكبر إن كان بلدك يشترط ذلك. لا تستهدف Relayium الأطفال، ولا نسمح عن علم للأطفال بإنشاء حسابات.",
      ],
    },
    {
      heading: "الاستخدام المقبول",
      body: ["توافق على ألّا تستخدم Relayium من أجل:"],
      bullets: [
        "مخالفة القانون أو انتهاك حقوق الآخرين، بما في ذلك إرسال محتوى لا يحق لك مشاركته.",
        "توزيع البرمجيات الخبيثة، أو محاولة تعطيل الخدمة أو بنيتها التحتية أو إثقالها أو إساءة استخدامها.",
        "الالتفاف على التدابير الأمنية أو محاولة الوصول إلى بيانات ليست ملكًا لك.",
      ],
    },
    {
      heading: "الحسابات",
      body: [
        "لا تتطلب عمليات النقل على نفس الشبكة (الشبكة المحلية) أي حساب. يتطلب إنشاء رمز اقتران لنقل ملف أو نص عبر الشبكات تسجيل الدخول؛ أما الانضمام باستخدام رمز اقتران فلا يتطلب حسابًا. كما يتطلب إنشاء رابط تنزيل مُخزَّن حسابًا. وأنت مسؤول عن الحفاظ على أمان الوصول إلى بريدك الإلكتروني وحسابك. يمكنك حذف حسابك وبياناته في أي وقت من إعدادات حسابك، في التطبيق أو على الويب. يبدأ الحذف فترة سماح مدتها 30 يومًا يمكنك خلالها التراجع عنه بتسجيل الدخول مجددًا؛ وبعد ذلك، تُزال بياناتك الشخصية وحسابك نهائيًا.",
      ],
    },
    {
      heading: "الاشتراكات والفوترة",
      body: [
        "تقدّم Relayium مستوى مجانيًا وخططًا مدفوعة اختيارية. تُفوتَر الخطط المدفوعة مسبقًا وبشكل متكرر — شهريًا أو سنويًا، حسب اختيارك — وتُجدَّد تلقائيًا إلى أن تُلغيها.",
        "يعتمد تحديد مَن يبيع الاشتراك ويُفوتره على مكان الشراء. فعلى الويب، تبيعه Relayium وتُعالِج Stripe الدفع، وتسري أحكام هذا القسم. أما داخل تطبيق Relayium المُثبَّت من Apple App Store — بما في ذلك Mac App Store — فتبيعه Apple وتُفوتره، ويسري القسم التالي بدلًا من ذلك.",
      ],
      bullets: [
        "تسري الترقية إلى خطة أعلى فورًا وتُحتسب بمبلغ تناسبي عن الجزء المتبقي من الفترة الحالية.",
        "يسري التخفيض، أو التحوّل إلى دورة فوترة أقصر، في نهاية الفترة الحالية؛ ولا نُرجِع أو نُرصِد الجزء غير المُستخدَم من الفترة.",
        "يمكنك الإلغاء في أي وقت. تظل الميزات المدفوعة نشطة حتى نهاية الفترة التي سبق أن دفعت مقابلها.",
        "لا نقدّم استردادًا للفترات الجزئية إلا حين يقتضي القانون ذلك.",
        "قد نُغيِّر أسعار الخطط أو ميزاتها. سنُخطرك قبل سريان أي تغيير في السعر على تجديدك التالي، ويمكنك الإلغاء إن لم توافق.",
        "على الويب، تُعالَج المدفوعات عبر Stripe. وفي نسخة App Store من تطبيق Relayium، تُباع الاشتراكات وتُفوتَر بواسطة Apple — راجع القسم التالي.",
      ],
    },
    {
      heading: "Apple App Store والمشتريات داخل التطبيق",
      body: [
        "إذا نزّلت Relayium من Apple App Store — بما في ذلك Mac App Store — تسري أيضًا اتفاقية Apple القياسية لترخيص المستخدم النهائي للتطبيقات المرخَّصة («Licensed Application End User License Agreement») على استخدامك للتطبيق، وتُعَدّ Apple مستفيدًا من الغير في هذه الشروط ولها الحق في إنفاذها ضدك.",
      ],
      bullets: [
        "الاشتراكات المُشتراة داخل نسخة App Store من تطبيق Relayium، بما في ذلك نسخة Mac App Store، تبيعها وتُفوترها Apple عبر الشراء داخل التطبيق، وتُخصَم من مُعرِّف Apple الخاص بك.",
        "تُجدَّد تلقائيًا ما لم تُوقِف التجديد التلقائي قبل 24 ساعة على الأقل من انتهاء الفترة الحالية.",
        "أدِر أو ألغِ اشتراكًا تُفوتِره Apple من إعدادات حساب مُعرِّف Apple الخاص بك — إذ لا يمكننا إلغاؤه نيابةً عنك. أما استرداد مشتريات App Store فيُطلَب من Apple وتقرّره Apple، ولا يمكننا تنفيذه.",
        "ومع ذلك يمكننا المساعدة: إذا لم تتطابق باقتك في Relayium مع ما اشتريته، أو ظهر لك رسم لا تعرفه، راسِلنا على support@relayium.com وسنتحقق مما أبلغتنا به Apple عن اشتراكك.",
      ],
    },
    {
      heading: "النصوص الفورية",
      body: [
        "لا يعمل نقل النصوص الفورية إلا عندما يكون الجهازان متصلين بالإنترنت. الرسائل مُشفَّرة من الطرف إلى الطرف، ولا تتوفر لها خدمة تسليم دون اتصال أو سجل على الخادم. على الويب، قد تمر حركة المرور المُشفَّرة للجلسات عبر الشبكات من خلال مُرحِّل TURN؛ ولا يستطيع المُرحِّل قراءة محتوى الرسائل.",
      ],
    },
    {
      heading: "المحتوى المُخزَّن",
      body: [
        "عندما تستخدم وضع رابط التنزيل المُخزَّن الاختياري، يُشفِّر متصفحك الملفات قبل الرفع ولا يخزّن الخادم سوى النص المُشفَّر. ولأننا لا نستطيع فك تشفير المحتوى المُخزَّن (معرفة صفرية)، فإننا لا نستطيع فحصه مسبقًا. وأنت توافق على استخدام عمليات النقل المُخزَّن فقط لمحتوى يحق لك مشاركته ولا ينتهك القانون المعمول به.",
        "عمليات النقل المُخزَّن وسيلة مؤقتة لتسليم الملفات، وليست نسخة احتياطية. ولأن الروابط تنتهي صلاحيتها وتُحذَف الملفات بعد التنزيل أو عند انتهاء الصلاحية، يُرجى الاحتفاظ بنسختك الخاصة من أي شيء مهم — إذ لا يمكننا استعادة المحتوى المُخزَّن بعد فقدانه.",
      ],
      bullets: [
        "يمكنك طلب إزالة رابط تنزيل مُعيَّن عبر الإبلاغ عن مُعرِّف الملف إلى support@relayium.com.",
        "يُحذَف النص المُشفَّر المُخزَّن تلقائيًا عند انتهاء الصلاحية أو عند أول تنزيل كامل (الحذف بعد القراءة)، أيهما يقع أولًا.",
        "نحتفظ بالحق في تعليق أو إزالة المحتوى المُخزَّن الذي يُبلَّغ عنه على نحو موثوق بأنه غير قانوني.",
      ],
    },
    {
      heading: "إخلاء المسؤولية عن الضمان",
      body: [
        "تُقدَّم الخدمة «كما هي» و«حسب توافرها»، دون أي ضمانات من أي نوع، صريحة كانت أم ضمنية. ولا نضمن أن تنجح عمليات النقل دائمًا أو أن تكون الخدمة دون انقطاع أو خالية من الأخطاء.",
      ],
    },
    {
      heading: "تحديد المسؤولية",
      body: [
        "إلى أقصى حد يسمح به القانون، لا تتحمّل Relayium والمساهمون فيها المسؤولية عن أي أضرار غير مباشرة أو عرضية أو تبعية، أو عن أي فقدان للبيانات ينشأ عن استخدامك للخدمة.",
      ],
    },
    {
      heading: "المصدر المفتوح والتراخيص",
      body: [
        "شِفرة Relayium المصدرية متاحة بموجب رخصة AGPL-3.0. ويخضع استخدامك للشِفرة المصدرية لتلك الرخصة.",
      ],
    },
    {
      heading: "القانون الحاكم",
      body: [
        "تخضع هذه الشروط للقانون المعمول به في مكان تأسيس مُشغِّل الخدمة، دون أن يُلغي ذلك أي حقوق إلزامية لحماية المستهلك تتمتع بها في مكان إقامتك. وإذا تبيَّن أن أحد الأحكام غير قابل للتنفيذ، تظل الأحكام المتبقية سارية.",
      ],
    },
    {
      heading: "التغييرات على هذه الشروط",
      body: [
        "قد نُحدِّث هذه الشروط مع تطوّر الخدمة. وعندما نفعل ذلك، سنغيّر تاريخ «آخر تحديث» أعلاه. ويعني استمرارك في الاستخدام بعد أي تغيير قبولك للشروط المُحدَّثة.",
      ],
    },
    {
      heading: "التواصل",
      body: ["هل لديك أسئلة عن هذه الشروط؟ راسِلنا على support@relayium.com."],
    },
  ],
};

const es = {
  title: "Términos del servicio",
  description:
    "Los términos para usar Relayium: un servicio de código abierto para transferir archivos y texto en tiempo real entre dispositivos, cifrado de extremo a extremo. El servicio básico es gratuito; hay planes de pago opcionales disponibles.",
  updatedLabel: "Última actualización",
  updated: "2026-08-13",
  otherDocLabel: "Política de privacidad",
  lead: [
    "Al usar Relayium aceptas estos términos. Relayium es un servicio de código abierto que te permite enviar archivos y texto en tiempo real entre dispositivos, cifrados de extremo a extremo. El servicio básico es gratuito; algunos planes opcionales son de pago — consulta Suscripciones y facturación.",
  ],
  sections: [
    {
      heading: "El servicio",
      body: [
        "Relayium transfiere archivos y texto en tiempo real entre dispositivos, cifrados de extremo a extremo. El servicio básico es gratuito y su código fuente es de código abierto bajo la licencia AGPL-3.0. Los planes de pago opcionales aumentan los límites de almacenamiento, transferencia y retención — consulta Suscripciones y facturación.",
      ],
    },
    {
      heading: "Elegibilidad",
      body: [
        "Debes tener la edad suficiente para celebrar un acuerdo vinculante y para consentir el tratamiento de tus datos en el lugar donde vives —al menos 13 años, o más si tu país lo exige—. Relayium no está dirigido a menores, y no permitimos a sabiendas que los menores creen cuentas.",
      ],
    },
    {
      heading: "Uso aceptable",
      body: ["Aceptas no usar Relayium para:"],
      bullets: [
        "Infringir la ley o vulnerar los derechos de otros, incluido el envío de contenido que no tienes derecho a compartir.",
        "Distribuir malware, o intentar interrumpir, sobrecargar o abusar del servicio o de su infraestructura.",
        "Eludir las medidas de seguridad o intentar acceder a datos que no son tuyos.",
      ],
    },
    {
      heading: "Cuentas",
      body: [
        "Las transferencias en la misma red (red local) no necesitan cuenta. Crear un código de emparejamiento para transferir archivos o texto entre redes requiere iniciar sesión; unirse con un código de emparejamiento no requiere cuenta. Crear un enlace de descarga almacenado también requiere una cuenta. Eres responsable de mantener seguro el acceso a tu correo electrónico y a tu cuenta. Puedes eliminar tu cuenta y sus datos en cualquier momento desde los ajustes de tu cuenta, en la aplicación o en la web. La eliminación inicia un período de gracia de 30 días durante el cual puedes deshacerla volviendo a iniciar sesión; transcurrido ese plazo, tu cuenta y tus datos personales se eliminan de forma permanente.",
      ],
    },
    {
      heading: "Suscripciones y facturación",
      body: [
        "Relayium ofrece un nivel gratuito y planes de pago opcionales. Los planes de pago se facturan por adelantado de forma recurrente —mensual o anualmente, según elijas— y se renuevan automáticamente hasta que canceles.",
        "Quién vende y factura una suscripción depende de dónde la compres. En la web la vende Relayium y Stripe procesa el pago, y se aplica esta sección. En una aplicación Relayium instalada desde el Apple App Store —incluido el Mac App Store— la vende y la factura Apple, y se aplica en su lugar la sección siguiente.",
      ],
      bullets: [
        "Actualizar a un plan superior se aplica de inmediato y se cobra un importe prorrateado por el resto del período actual.",
        "Bajar de plan, o cambiar a un ciclo de facturación más corto, se aplica al final del período actual; no reembolsamos ni acreditamos la parte no utilizada de un período.",
        "Puedes cancelar en cualquier momento. Las funciones de pago permanecen activas hasta el final del período que ya has pagado.",
        "No ofrecemos reembolsos por períodos parciales, salvo cuando la ley lo exija.",
        "Podemos cambiar los precios o las funciones de los planes. Te avisaremos antes de que un cambio de precio se aplique a tu próxima renovación, y podrás cancelar si no estás de acuerdo.",
        "En la web, los pagos los procesa Stripe. En una versión del App Store de la aplicación Relayium, las suscripciones las vende y factura Apple — consulta la siguiente sección.",
      ],
    },
    {
      heading: "Apple App Store y compras dentro de la aplicación",
      body: [
        "Si descargas Relayium desde el Apple App Store —incluido el Mac App Store—, el Contrato de licencia de usuario final estándar de Apple para aplicaciones con licencia («Licensed Application End User License Agreement») también se aplica a tu uso de la aplicación, y Apple es un tercero beneficiario de estos términos con derecho a hacerlos cumplir frente a ti.",
      ],
      bullets: [
        "Las suscripciones compradas dentro de una versión del App Store de la aplicación Relayium, incluida la versión del Mac App Store, son vendidas y facturadas por Apple mediante compras dentro de la aplicación, con cargo a tu Apple ID.",
        "Se renuevan automáticamente a menos que desactives la renovación automática al menos 24 horas antes de que finalice el período actual.",
        "Gestiona o cancela una suscripción facturada por Apple en los ajustes de tu cuenta de Apple ID — no podemos cancelarla en tu nombre. Los reembolsos de compras del App Store se solicitan a Apple y los decide Apple; nosotros no podemos emitirlos.",
        "Aun así podemos ayudarte: si tu plan de Relayium no coincide con lo que compraste, o ves un cargo que no reconoces, escribe a support@relayium.com y comprobaremos lo que Apple nos ha comunicado sobre tu suscripción.",
      ],
    },
    {
      heading: "Texto en tiempo real",
      body: [
        "La transferencia de texto en tiempo real solo funciona mientras ambos dispositivos están en línea. Los mensajes están cifrados de extremo a extremo y no tienen entrega sin conexión ni historial en el servidor. En la web, las sesiones entre redes pueden enviar tráfico cifrado a través de un relé TURN; el relé no puede leer el contenido de los mensajes.",
      ],
    },
    {
      heading: "Contenido almacenado",
      body: [
        "Cuando usas el modo opcional de enlace de descarga almacenado, tu navegador cifra los archivos antes de subirlos y el servidor solo almacena texto cifrado. Como no podemos descifrar el contenido almacenado (conocimiento cero), no podemos examinarlo previamente. Aceptas usar las transferencias almacenadas únicamente para contenido que tienes derecho a compartir y que no infringe la ley aplicable.",
        "Las transferencias almacenadas son una forma temporal de entregar archivos, no una copia de seguridad. Como los enlaces caducan y los archivos se eliminan tras la descarga o al caducar, conserva tu propia copia de todo lo que te importe — no podemos recuperar el contenido almacenado una vez que ha desaparecido.",
      ],
      bullets: [
        "Puedes solicitar la retirada de un enlace de descarga específico informando del id del archivo a support@relayium.com.",
        "El texto cifrado almacenado se elimina automáticamente al caducar o en la primera descarga completa (destrucción tras la lectura), lo que ocurra primero.",
        "Nos reservamos el derecho de suspender o retirar el contenido almacenado que se denuncie de forma creíble como ilegal.",
      ],
    },
    {
      heading: "Sin garantía",
      body: [
        "El servicio se proporciona «tal cual» y «según disponibilidad», sin garantías de ningún tipo, expresas o implícitas. No garantizamos que las transferencias siempre se completen con éxito ni que el servicio sea ininterrumpido o esté libre de errores.",
      ],
    },
    {
      heading: "Limitación de responsabilidad",
      body: [
        "En la máxima medida permitida por la ley, Relayium y sus colaboradores no son responsables de ningún daño indirecto, incidental o consiguiente, ni de ninguna pérdida de datos, que se derive de tu uso del servicio.",
      ],
    },
    {
      heading: "Código abierto y licencias",
      body: [
        "El código fuente de Relayium está disponible bajo la licencia AGPL-3.0. Tu uso del código fuente se rige por esa licencia.",
      ],
    },
    {
      heading: "Ley aplicable",
      body: [
        "Estos términos se rigen por la ley aplicable en el lugar donde está establecido el operador del servicio, sin eliminar los derechos imperativos de protección al consumidor que tengas donde vives. Si alguna disposición se considera inaplicable, las demás disposiciones seguirán vigentes.",
      ],
    },
    {
      heading: "Cambios en estos términos",
      body: [
        "Podemos actualizar estos términos a medida que el servicio evolucione. Cuando lo hagamos, cambiaremos la fecha de «Última actualización» anterior. El uso continuado tras un cambio significa que aceptas los términos actualizados.",
      ],
    },
    {
      heading: "Contacto",
      body: ["¿Preguntas sobre estos términos? Escribe a support@relayium.com."],
    },
  ],
};

const pt = {
  title: "Termos de Serviço",
  description:
    "Os termos para usar a Relayium — um serviço de código aberto para transferir arquivos e texto em tempo real entre dispositivos, com criptografia de ponta a ponta. O serviço principal é gratuito; há planos pagos opcionais disponíveis.",
  updatedLabel: "Última atualização",
  updated: "2026-08-13",
  otherDocLabel: "Política de Privacidade",
  lead: [
    "Ao usar a Relayium, você concorda com estes termos. A Relayium é um serviço de código aberto que permite enviar arquivos e texto em tempo real entre dispositivos, com criptografia de ponta a ponta. O serviço principal é gratuito; alguns planos opcionais são pagos — veja Assinaturas e cobrança.",
  ],
  sections: [
    {
      heading: "O serviço",
      body: [
        "A Relayium transfere arquivos e texto em tempo real entre dispositivos, com criptografia de ponta a ponta. O serviço principal é gratuito e seu código-fonte é de código aberto sob a licença AGPL-3.0. Planos pagos opcionais aumentam os limites de armazenamento, transferência e retenção — veja Assinaturas e cobrança.",
      ],
    },
    {
      heading: "Elegibilidade",
      body: [
        "Você deve ter idade suficiente para celebrar um contrato vinculativo e para consentir com o tratamento dos seus dados no local onde vive — pelo menos 13 anos, ou mais se o seu país exigir. A Relayium não é direcionada a crianças, e não permitimos conscientemente que crianças criem contas.",
      ],
    },
    {
      heading: "Uso aceitável",
      body: ["Você concorda em não usar a Relayium para:"],
      bullets: [
        "Infringir a lei ou violar os direitos de terceiros, incluindo o envio de conteúdo que você não tem o direito de compartilhar.",
        "Distribuir malware ou tentar interromper, sobrecarregar ou abusar do serviço ou de sua infraestrutura.",
        "Contornar medidas de segurança ou tentar acessar dados que não são seus.",
      ],
    },
    {
      heading: "Contas",
      body: [
        "As transferências na mesma rede (rede local) não precisam de conta. Criar um código de emparelhamento para uma transferência de arquivo ou texto entre redes exige login; entrar com um código de emparelhamento não exige conta. Criar um link de download armazenado também exige uma conta. Você é responsável por manter seguro o acesso ao seu e-mail e à sua conta. Você pode excluir sua conta e seus dados a qualquer momento nas configurações da conta, no aplicativo ou na web. A exclusão inicia um período de carência de 30 dias durante o qual você pode desfazê-la voltando a fazer login; depois disso, sua conta e seus dados pessoais são removidos permanentemente.",
      ],
    },
    {
      heading: "Assinaturas e cobrança",
      body: [
        "A Relayium oferece um nível gratuito e planos pagos opcionais. Os planos pagos são cobrados antecipadamente de forma recorrente — mensal ou anualmente, conforme sua escolha — e se renovam automaticamente até que você cancele.",
        "Quem vende e cobra uma assinatura depende de onde você a compra. Na web, quem vende é a Relayium e o pagamento é processado pela Stripe, e vale esta seção. Em um aplicativo Relayium instalado pela Apple App Store — incluindo a Mac App Store — quem vende e cobra é a Apple, e vale a seção seguinte.",
      ],
      bullets: [
        "Fazer upgrade para um plano superior tem efeito imediato e é cobrado um valor proporcional pelo restante do período atual.",
        "Fazer downgrade, ou mudar para um ciclo de cobrança mais curto, tem efeito ao final do período atual; não reembolsamos nem creditamos a parte não utilizada de um período.",
        "Você pode cancelar a qualquer momento. Os recursos pagos permanecem ativos até o final do período que você já pagou.",
        "Não oferecemos reembolsos por períodos parciais, exceto quando exigido por lei.",
        "Podemos alterar os preços ou recursos dos planos. Avisaremos antes que uma mudança de preço se aplique à sua próxima renovação, e você poderá cancelar se não concordar.",
        "Na web, os pagamentos são processados pela Stripe. Em uma versão da App Store do aplicativo Relayium, as assinaturas são vendidas e cobradas pela Apple — veja a próxima seção.",
      ],
    },
    {
      heading: "Apple App Store e compras no aplicativo",
      body: [
        "Se você baixar a Relayium da Apple App Store — incluindo a Mac App Store —, o Contrato de Licença de Usuário Final padrão da Apple para aplicativos licenciados (\"Licensed Application End User License Agreement\") também se aplica ao seu uso do aplicativo, e a Apple é uma terceira beneficiária destes termos, com o direito de aplicá-los contra você.",
      ],
      bullets: [
        "As assinaturas compradas dentro de uma versão da App Store do aplicativo Relayium, incluindo a versão da Mac App Store, são vendidas e cobradas pela Apple por meio de compra no aplicativo, debitadas do seu Apple ID.",
        "Elas se renovam automaticamente, a menos que você desative a renovação automática pelo menos 24 horas antes do fim do período atual.",
        "Gerencie ou cancele uma assinatura cobrada pela Apple nas configurações da sua conta Apple ID — não podemos cancelá-la por você. Os reembolsos de compras na App Store são solicitados à Apple e decididos pela Apple; nós não podemos efetuá-los.",
        "Ainda assim podemos ajudar: se o seu plano da Relayium não corresponder ao que você comprou, ou se você vir uma cobrança que não reconhece, escreva para support@relayium.com e verificaremos o que a Apple nos informou sobre a sua assinatura.",
      ],
    },
    {
      heading: "Texto em tempo real",
      body: [
        "A transferência de texto em tempo real funciona apenas enquanto os dois dispositivos estão online. As mensagens têm criptografia de ponta a ponta e não contam com entrega offline nem histórico no servidor. Na web, sessões entre redes podem enviar tráfego criptografado por um relé TURN; o relé não consegue ler o conteúdo das mensagens.",
      ],
    },
    {
      heading: "Conteúdo armazenado",
      body: [
        "Quando você usa o modo opcional de link de download armazenado, seu navegador criptografa os arquivos antes do envio e o servidor armazena apenas texto cifrado. Como não podemos descriptografar o conteúdo armazenado (conhecimento zero), não podemos examiná-lo previamente. Você concorda em usar as transferências armazenadas apenas para conteúdo que tem o direito de compartilhar e que não viola a lei aplicável.",
        "As transferências armazenadas são uma forma temporária de entregar arquivos, não um backup. Como os links expiram e os arquivos são excluídos após o download ou na expiração, mantenha sua própria cópia de qualquer coisa importante — não podemos recuperar o conteúdo armazenado depois que ele desaparecer.",
      ],
      bullets: [
        "Você pode solicitar a remoção de um link de download específico informando o id do arquivo ao support@relayium.com.",
        "O texto cifrado armazenado é excluído automaticamente na expiração ou no primeiro download completo (destruição após leitura), o que ocorrer primeiro.",
        "Reservamo-nos o direito de suspender ou remover conteúdo armazenado que seja denunciado de forma credível como ilegal.",
      ],
    },
    {
      heading: "Sem garantia",
      body: [
        "O serviço é fornecido \"no estado em que se encontra\" e \"conforme disponível\", sem garantias de qualquer tipo, expressas ou implícitas. Não garantimos que as transferências sempre serão bem-sucedidas nem que o serviço será ininterrupto ou livre de erros.",
      ],
    },
    {
      heading: "Limitação de responsabilidade",
      body: [
        "Na máxima extensão permitida por lei, a Relayium e seus colaboradores não se responsabilizam por quaisquer danos indiretos, incidentais ou consequentes, nem por qualquer perda de dados, decorrentes do seu uso do serviço.",
      ],
    },
    {
      heading: "Código aberto e licenças",
      body: [
        "O código-fonte da Relayium está disponível sob a licença AGPL-3.0. Seu uso do código-fonte é regido por essa licença.",
      ],
    },
    {
      heading: "Lei aplicável",
      body: [
        "Estes termos são regidos pela lei aplicável no local onde o operador do serviço está estabelecido, sem eliminar quaisquer direitos obrigatórios de proteção ao consumidor que você tenha no local onde vive. Se alguma disposição for considerada inexequível, as demais disposições permanecem em vigor.",
      ],
    },
    {
      heading: "Alterações nestes termos",
      body: [
        "Podemos atualizar estes termos à medida que o serviço evolui. Quando o fizermos, alteraremos a data de \"Última atualização\" acima. O uso continuado após uma alteração significa que você aceita os termos atualizados.",
      ],
    },
    {
      heading: "Contato",
      body: ["Dúvidas sobre estes termos? Envie um e-mail para support@relayium.com."],
    },
  ],
};

export default { slug: "terms", langs: { en, zh, ja, ko, de, fr, ar, es, pt } };
