// web/scripts/legal/content/privacy.mjs
const en = {
  title: "Privacy Policy",
  description:
    "How Relayium handles your data: realtime direct transfers go peer-to-peer and never touch our servers; the stored download-link mode keeps files zero-knowledge encrypted. Accounts are optional and store only an email and display name.",
  updatedLabel: "Last updated",
  updated: "2026-06-29",
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
        "Signing in is optional and only unlocks cross-network transfers. If you sign in, we store the minimum needed to run an account:",
      ],
      bullets: [
        "Your email address and a display name.",
        "Which sign-in method you used (Google, or an email magic link). Magic-link tokens are stored only as a hash, never in clear text.",
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
        "The \"What we never collect\" section below remains accurate: everything the server receives from a stored transfer is ciphertext — plaintext content, filenames, and keys never reach the server.",
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
        "When two devices cannot connect directly across networks, the encrypted stream is relayed through a TURN server. The relay still cannot read your files — they remain end-to-end encrypted. For operating the service we record only the number of relayed bytes for a transfer, attributed to the signed-in user who created it. We never inspect relayed content.",
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
      body: ["A couple of third parties are involved only when you choose to use them:"],
      bullets: [
        "Google, if you sign in with Google — we receive your email and basic profile to create the account.",
        "An email delivery provider, to send magic-link sign-in emails.",
      ],
    },
    {
      heading: "Data retention and deletion",
      body: [
        "Account data is kept while your account exists. You can ask us to delete your account and its data at any time by contacting us at support@relayium.com.",
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
  updated: "2026-06-29",
  otherDocLabel: "服务条款",
  lead: [
    "Relayium 的设计宗旨是让你的文件始终属于你。实时直连传输以点对点方式进行，端到端加密，绝不经过我们的服务器；可选的暂存下载链接模式采用零知识加密——服务器仅存储无法解读的密文。",
    "本页说明本服务确实会处理的少量数据,以及它刻意从不接触的数据。",
  ],
  sections: [
    {
      heading: "局域网传输不收集任何数据",
      body: [
        "在同一网络下的设备之间传输文件时,无需账号,服务也不会存储任何关于你的信息。信令服务器只帮助两台设备相互发现;文件字节通过加密的 WebRTC 通道在设备之间直接流动。",
      ],
    },
    {
      heading: "账号会存储什么(仅在你登录时)",
      body: ["登录是可选的,仅用于解锁跨网络传输。如果你登录,我们只存储运行账号所必需的最少信息:"],
      bullets: [
        "你的邮箱地址和一个显示名。",
        "你使用的登录方式(Google,或邮箱魔法链接)。魔法链接令牌只以哈希形式存储,绝不明文保存。",
        "登录会话,保存在安全的 httpOnly cookie 中。",
        "你注册的设备,以一个随机设备 id 和设备名(例如你的平台名称)的形式。",
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
        "密文在到期或首次完整下载（阅后即焚）时自动删除，以先到者为准。",
        "下方「我们绝不收集什么」一节依然准确：服务器从暂存传输中收到的一切均为密文——明文内容、文件名和密钥永远不会到达服务器。",
      ],
    },
    {
      heading: "我们绝不收集什么",
      body: ["本服务的设计确保以下内容绝不会到达我们的服务器:"],
      bullets: ["你的文件内容。", "你的文件名。", "你的加密密钥。"],
    },
    {
      heading: "跨网络中继(TURN)",
      body: [
        "当两台设备无法跨网络直接连接时,加密流会通过 TURN 服务器中继。中继依然无法读取你的文件——它们始终保持端到端加密。出于运营目的,我们仅记录某次传输中继的字节数,并归属到创建该传输的登录用户。我们绝不检查中继内容。",
      ],
    },
    {
      heading: "Cookie 与本地存储",
      body: [
        "我们使用一个会话 cookie 来保持你的登录状态。在你浏览器的本地存储中,我们保存一个随机设备 id,以便识别你注册过的设备。我们不使用广告或追踪 cookie。",
      ],
    },
    {
      heading: "第三方服务",
      body: ["只有在你选择使用时,才会涉及少数第三方:"],
      bullets: [
        "Google——如果你用 Google 登录,我们会获取你的邮箱和基本资料以创建账号。",
        "邮件发送服务商——用于发送魔法链接登录邮件。",
      ],
    },
    {
      heading: "数据保留与删除",
      body: [
        "账号数据在你的账号存在期间保留。你可以随时通过 support@relayium.com 联系我们,要求删除你的账号及其数据。",
      ],
    },
    {
      heading: "本政策的变更",
      body: ["随着服务演进,我们可能会更新本政策。届时我们会更新上方的「最后更新」日期。"],
    },
    {
      heading: "联系我们",
      body: ["有隐私方面的疑问?请发邮件至 support@relayium.com。"],
    },
  ],
};

const ja = {
  title: "プライバシーポリシー",
  description:
    "Relayiumがあなたのデータを扱う方法：リアルタイム直接転送はピアツーピアかつエンドツーエンド暗号化で行われ、当社のサーバーを通過しません。一時保存ダウンロードリンク機能はファイルをゼロ知識暗号化で保護します。アカウントは任意で、メールアドレスと表示名のみを保存します。",
  updatedLabel: "最終更新",
  updated: "2026-06-29",
  otherDocLabel: "利用規約",
  lead: [
    "Relayiumはあなたのファイルが常にあなたのものであるよう設計されています。リアルタイムの直接転送はピアツーピアかつエンドツーエンド暗号化で行われ、当社のサーバーを通過しません——オプションの一時保存ダウンロードリンク機能はゼロ知識暗号化を使用するため、サーバーには解読不能な暗号文のみが保存されます。",
    "このページでは、本サービスが実際に扱う少量のデータと、意図的に取得しないデータについて説明します。",
  ],
  sections: [
    {
      heading: "ローカルネットワーク転送ではデータを収集しません",
      body: [
        "同じネットワーク上のデバイス間でファイルを転送する場合、アカウントは不要で、サービスはあなたに関する情報を一切保存しません。シグナリングサーバーは2台のデバイスが互いを見つけるのを助けるだけで、ファイルの実体は暗号化されたWebRTCチャネルを通じてデバイス間で直接やり取りされます。",
      ],
    },
    {
      heading: "アカウントに保存される情報（サインインした場合のみ）",
      body: [
        "サインインは任意で、クロスネットワーク転送を有効にするためだけに必要です。サインインした場合、アカウントの運用に必要な最小限の情報のみを保存します：",
      ],
      bullets: [
        "メールアドレスと表示名。",
        "使用したサインイン方法（Google、またはメールマジックリンク）。マジックリンクのトークンはハッシュ値のみ保存され、平文では保存されません。",
        "ログインセッション。安全なhttpOnlyクッキーに保存されます。",
        "登録したデバイス。ランダムなデバイスIDとデバイス名（例：プラットフォーム名）で管理されます。",
      ],
    },
    {
      heading: "一時保存転送（ダウンロードリンク）",
      body: [
        "オプションの一時保存ダウンロードリンク機能を使用する場合、ファイルはデバイスから送信される前にブラウザで AES-256-GCM 暗号化されます。復号キーは URL フラグメント（# 部分）にのみ存在し、サーバーには送信されません。これは以下を意味します：",
      ],
      bullets: [
        "サーバーは暗号文のみを保存します。ファイルの内容、ファイル名、キーを読み取ることはできません。",
        "クォータ管理とクリーンアップのために、暗号文サイズとタイムスタンプ（アップロード時刻、有効期限）を記録します。",
        "暗号文は有効期限切れまたは最初の完全なダウンロード（閲覧後削除）のいずれか早い方で自動削除されます。",
        "下記の「収集しない情報」は引き続き正確です：サーバーが一時保存転送から受け取るものはすべて暗号文であり、平文コンテンツ、ファイル名、キーはサーバーに届きません。",
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
        "2台のデバイスがネットワークをまたいで直接接続できない場合、暗号化されたストリームはTURNサーバーを経由して中継されます。中継サーバーはあなたのファイルを読み取ることができません——エンドツーエンド暗号化が維持されます。サービスの運用上、転送ごとの中継バイト数のみを記録し、それを作成したサインイン済みユーザーに紐付けます。中継されたコンテンツを検査することはありません。",
      ],
    },
    {
      heading: "Cookieとローカルストレージ",
      body: [
        "サインイン状態を維持するために1つのセッションCookieを使用します。ブラウザのローカルストレージには、登録済みデバイスを識別するためのランダムなデバイスIDを保存します。広告用または追跡用のCookieは使用しません。",
      ],
    },
    {
      heading: "第三者サービス",
      body: ["あなたが使用を選択した場合にのみ、一部の第三者が関与します："],
      bullets: [
        "Google——Googleでサインインする場合、アカウント作成のためにメールアドレスと基本プロフィール情報を受け取ります。",
        "メール配信プロバイダー——マジックリンクのサインインメールを送信するために使用します。",
      ],
    },
    {
      heading: "データの保持と削除",
      body: [
        "アカウントデータはアカウントが存在する間保持されます。アカウントとそのデータの削除は、support@relayium.comまでご連絡いただければいつでも対応します。",
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
      body: ["プライバシーに関するご質問は、support@relayium.comまでメールでお問い合わせください。"],
    },
  ],
};

const ko = {
  title: "개인정보 처리방침",
  description:
    "Relayium이 데이터를 처리하는 방식: 실시간 직접 전송은 피어 투 피어로 이루어지며 당사 서버를 거치지 않습니다. 임시 보관 다운로드 링크 기능은 파일을 영지식 암호화로 보호합니다. 계정은 선택 사항이며 이메일 주소와 표시 이름만 저장합니다.",
  updatedLabel: "최종 업데이트",
  updated: "2026-06-29",
  otherDocLabel: "이용약관",
  lead: [
    "Relayium은 파일이 항상 사용자의 것으로 남도록 설계되었습니다. 실시간 직접 전송은 피어 투 피어로 이루어지며, 엔드 투 엔드로 암호화되어 당사 서버를 통과하지 않습니다——선택적 임시 보관 다운로드 링크 기능은 영지식 암호화를 사용하여 서버에는 해독할 수 없는 암호문만 저장됩니다.",
    "이 페이지에서는 서비스가 실제로 처리하는 소량의 데이터와 의도적으로 수집하지 않는 데이터를 설명합니다.",
  ],
  sections: [
    {
      heading: "로컬 네트워크 전송은 아무것도 수집하지 않습니다",
      body: [
        "동일한 네트워크상의 장치 간에 파일을 전송할 때는 계정이 필요하지 않으며 서비스는 사용자에 관한 어떤 정보도 저장하지 않습니다. 시그널링 서버는 두 장치가 서로를 찾도록 도울 뿐이며, 파일 데이터는 암호화된 WebRTC 채널을 통해 장치 간에 직접 전송됩니다.",
      ],
    },
    {
      heading: "계정에 저장되는 정보(로그인한 경우에만)",
      body: [
        "로그인은 선택 사항이며 크로스 네트워크 전송 기능을 사용할 때만 필요합니다. 로그인하면 계정 운영에 필요한 최소한의 정보만 저장합니다:",
      ],
      bullets: [
        "이메일 주소와 표시 이름.",
        "사용한 로그인 방식(Google 또는 이메일 매직 링크). 매직 링크 토큰은 해시값으로만 저장되며 평문으로는 저장되지 않습니다.",
        "로그인 세션. 안전한 httpOnly 쿠키에 보관됩니다.",
        "등록한 장치. 임의 장치 ID와 장치 이름(예: 플랫폼 이름)으로 관리됩니다.",
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
        "아래의 '절대 수집하지 않는 정보' 목록은 여전히 정확합니다: 서버가 임시 보관 전송에서 받는 모든 것은 암호문이며 평문 내용, 파일 이름, 키는 서버에 도달하지 않습니다.",
      ],
    },
    {
      heading: "절대 수집하지 않는 정보",
      body: ["서비스는 다음 정보가 당사 서버에 도달하지 않도록 설계되어 있습니다:"],
      bullets: [
        "파일 내용.",
        "파일 이름.",
        "암호화 키.",
      ],
    },
    {
      heading: "크로스 네트워크 릴레이(TURN)",
      body: [
        "두 장치가 네트워크를 가로질러 직접 연결할 수 없는 경우, 암호화된 스트림이 TURN 서버를 통해 중계됩니다. 릴레이 서버는 여전히 파일을 읽을 수 없습니다——엔드 투 엔드 암호화가 유지됩니다. 서비스 운영을 위해 전송별 릴레이 바이트 수만 기록하며, 이를 전송을 생성한 로그인 사용자에게 귀속시킵니다. 중계된 콘텐츠를 검사하지 않습니다.",
      ],
    },
    {
      heading: "쿠키 및 로컬 스토리지",
      body: [
        "로그인 상태를 유지하기 위해 세션 쿠키 하나를 사용합니다. 브라우저의 로컬 스토리지에는 등록된 장치를 식별하기 위한 임의 장치 ID를 저장합니다. 광고 또는 추적 쿠키는 사용하지 않습니다.",
      ],
    },
    {
      heading: "제3자 서비스",
      body: ["사용자가 선택하여 사용하는 경우에만 일부 제3자가 관여합니다:"],
      bullets: [
        "Google — Google로 로그인하는 경우, 계정 생성을 위해 이메일 주소와 기본 프로필 정보를 받습니다.",
        "이메일 발송 서비스 제공업체 — 매직 링크 로그인 이메일 전송에 사용됩니다.",
      ],
    },
    {
      heading: "데이터 보존 및 삭제",
      body: [
        "계정 데이터는 계정이 존재하는 동안 보존됩니다. support@relayium.com으로 연락하시면 언제든지 계정과 관련 데이터 삭제를 요청할 수 있습니다.",
      ],
    },
    {
      heading: "이 방침의 변경",
      body: [
        "서비스가 발전함에 따라 이 방침을 업데이트할 수 있습니다. 업데이트 시 위의 '최종 업데이트' 날짜를 변경합니다.",
      ],
    },
    {
      heading: "문의",
      body: ["개인정보에 관한 질문이 있으시면 support@relayium.com으로 이메일을 보내주세요."],
    },
  ],
};

const de = {
  title: "Datenschutzrichtlinie",
  description:
    "Wie Relayium mit Ihren Daten umgeht: Echtzeit-Direktübertragungen werden Peer-to-Peer übertragen und berühren nie unsere Server; der Modus für zwischengespeicherte Download-Links hält Dateien Zero-Knowledge-verschlüsselt. Konten sind optional und speichern nur eine E-Mail-Adresse und einen Anzeigenamen.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-06-29",
  otherDocLabel: "Nutzungsbedingungen",
  lead: [
    "Relayium ist so konzipiert, dass Ihre Dateien Ihnen gehören. Echtzeit-Direktübertragungen erfolgen Peer-to-Peer, Ende-zu-Ende-verschlüsselt, und passieren nie unsere Server – der optionale Modus für zwischengespeicherte Download-Links verwendet Zero-Knowledge-Verschlüsselung, sodass der Server nur Chiffretext speichert, den er nicht lesen kann.",
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
        "Die Anmeldung ist optional und schaltet nur geräteübergreifende Übertragungen frei. Bei einer Anmeldung speichern wir nur das für den Kontobetrieb notwendige Minimum:",
      ],
      bullets: [
        "Ihre E-Mail-Adresse und ein Anzeigename.",
        "Die verwendete Anmeldemethode (Google oder ein E-Mail-Magic-Link). Magic-Link-Tokens werden ausschließlich als Hash gespeichert, niemals im Klartext.",
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
        "Der Chiffretext wird automatisch gelöscht, wenn er abläuft oder beim ersten vollständigen Download (einmaliges Lesen) — je nachdem, was zuerst eintritt.",
        "Die Liste \"Was wir niemals erfassen\" bleibt weiterhin korrekt: Alles, was der Server bei einer zwischengespeicherten Übertragung empfängt, ist Chiffretext — Klartext, Dateinamen und Schlüssel gelangen nie zum Server.",
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
        "Wenn sich zwei Geräte nicht direkt über verschiedene Netzwerke verbinden können, wird der verschlüsselte Datenstrom über einen TURN-Server weitergeleitet. Die Weiterleitung kann Ihre Dateien dennoch nicht lesen — sie bleiben Ende-zu-Ende-verschlüsselt. Für den Betrieb des Dienstes erfassen wir lediglich die Anzahl der weitergeleiteten Bytes einer Übertragung, zugeordnet dem angemeldeten Benutzer, der sie erstellt hat. Weitergeleitete Inhalte werden von uns nie eingesehen.",
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
        "Ein E-Mail-Versanddienstleister, um Magic-Link-Anmelde-E-Mails zu senden.",
      ],
    },
    {
      heading: "Datenspeicherung und Löschung",
      body: [
        "Kontodaten werden gespeichert, solange Ihr Konto besteht. Sie können jederzeit die Löschung Ihres Kontos und der zugehörigen Daten beantragen, indem Sie uns unter support@relayium.com kontaktieren.",
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
    "Comment Relayium traite vos données : les transferts directs en temps réel s'effectuent de pair à pair et ne passent jamais par nos serveurs ; le mode de liens de téléchargement stockés maintient les fichiers chiffrés à connaissance nulle. Les comptes sont facultatifs et ne stockent qu'une adresse e-mail et un nom d'affichage.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-06-29",
  otherDocLabel: "Conditions d'utilisation",
  lead: [
    "Relayium est conçu pour que vos fichiers restent les vôtres. Les transferts directs en temps réel s'effectuent de pair à pair, chiffrés de bout en bout, et ne passent jamais par nos serveurs ; le mode optionnel de liens de téléchargement stockés utilise un chiffrement à connaissance nulle — le serveur ne conserve que du chiffré qu'il ne peut pas lire.",
    "Cette page explique les quelques données que le service traite effectivement, et celles qu'il ne voit délibérément jamais.",
  ],
  sections: [
    {
      heading: "Les transferts sur réseau local ne collectent rien",
      body: [
        "Lorsque vous transférez des fichiers entre appareils sur le même réseau, aucun compte n'est nécessaire et le service ne stocke rien vous concernant. Le serveur de signalisation aide simplement les deux appareils à se trouver mutuellement ; les données de fichiers circulent directement d'appareil à appareil via un canal WebRTC chiffré.",
      ],
    },
    {
      heading: "Ce que stocke un compte (uniquement si vous vous connectez)",
      body: [
        "La connexion est facultative et ne sert qu'à débloquer les transferts inter-réseaux. En cas de connexion, nous stockons le strict minimum nécessaire au fonctionnement du compte :",
      ],
      bullets: [
        "Votre adresse e-mail et un nom d'affichage.",
        "La méthode de connexion utilisée (Google ou un lien magique par e-mail). Les jetons de lien magique sont stockés uniquement sous forme de hachage, jamais en clair.",
        "Une session de connexion, conservée dans un cookie sécurisé httpOnly.",
        "Les appareils que vous enregistrez, sous la forme d'un identifiant d'appareil aléatoire et d'un nom d'appareil (par ex. le nom de votre plateforme).",
      ],
    },
    {
      heading: "Transfert stocké (liens de téléchargement)",
      body: [
        "Lorsque vous utilisez le mode optionnel de liens de téléchargement stockés, votre navigateur chiffre vos fichiers avec AES-256-GCM avant qu'ils ne quittent votre appareil. La clé de déchiffrement n'existe que dans le fragment d'URL (après le #) et n'est jamais envoyée au serveur. Cela signifie :",
      ],
      bullets: [
        "Le serveur ne stocke que du chiffré. Il ne peut pas lire le contenu de vos fichiers, leurs noms ni les clés.",
        "Nous enregistrons la taille du chiffré et les horodatages (heure d'envoi, expiration) pour la gestion des quotas et le nettoyage.",
        "Le chiffré est automatiquement supprimé à l'expiration ou lors du premier téléchargement complet (lecture unique), selon ce qui survient en premier.",
        "La liste « Ce que nous ne collectons jamais » ci-dessous reste exacte : tout ce que le serveur reçoit d'un transfert stocké est du chiffré — le contenu en clair, les noms de fichiers et les clés n'atteignent jamais le serveur.",
      ],
    },
    {
      heading: "Ce que nous ne collectons jamais",
      body: ["Le service est conçu pour que les éléments suivants n'atteignent jamais nos serveurs :"],
      bullets: [
        "Le contenu de vos fichiers.",
        "Les noms de vos fichiers.",
        "Vos clés de chiffrement.",
      ],
    },
    {
      heading: "Relais inter-réseau (TURN)",
      body: [
        "Lorsque deux appareils ne peuvent pas se connecter directement entre différents réseaux, le flux chiffré est relayé via un serveur TURN. Le relais ne peut toujours pas lire vos fichiers — ils restent chiffrés de bout en bout. Pour l'exploitation du service, nous enregistrons uniquement le nombre d'octets relayés pour un transfert, attribué à l'utilisateur connecté qui l'a créé. Nous n'inspectons jamais le contenu relayé.",
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
      body: ["Quelques tiers interviennent uniquement lorsque vous choisissez de les utiliser :"],
      bullets: [
        "Google, si vous vous connectez avec Google — nous recevons votre adresse e-mail et votre profil de base pour créer le compte.",
        "Un prestataire d'envoi d'e-mails, pour envoyer les e-mails de connexion par lien magique.",
      ],
    },
    {
      heading: "Conservation et suppression des données",
      body: [
        "Les données du compte sont conservées tant que votre compte existe. Vous pouvez demander la suppression de votre compte et de ses données à tout moment en nous contactant à support@relayium.com.",
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
      body: ["Des questions sur la confidentialité ? Écrivez-nous à support@relayium.com."],
    },
  ],
};

export default { slug: "privacy", langs: { en, zh, ja, ko, de, fr } };
