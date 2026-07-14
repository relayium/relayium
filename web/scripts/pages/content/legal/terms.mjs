// web/scripts/pages/content/legal/terms.mjs
const en = {
  title: "Terms of Service",
  description:
    "The terms for using Relayium — a free, open-source, end-to-end encrypted peer-to-peer file transfer service provided as is.",
  updatedLabel: "Last updated",
  updated: "2026-07-01",
  otherDocLabel: "Privacy Policy",
  lead: [
    "By using Relayium you agree to these terms. Relayium is a free and open-source service that lets you send files directly between devices, end-to-end encrypted.",
  ],
  sections: [
    {
      heading: "The service",
      body: [
        "Relayium transfers files peer-to-peer between devices. It is provided free of charge and its source code is open source under the MIT license.",
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
        "Same-network (LAN) transfers need no account. Sending across networks with a pairing code requires the sender to sign in — the person receiving never needs an account. Creating a stored download link also requires an account. You are responsible for keeping access to your email and account secure. You may request deletion of your account and its data at any time by contacting support@relayium.com.",
      ],
    },
    {
      heading: "Stored content",
      body: [
        "When you use the optional stored download-link mode, your browser encrypts files before upload and the server stores only ciphertext. Because we cannot decrypt stored content (zero-knowledge), we cannot pre-screen it. You agree to use stored transfers only for content you have the right to share and that does not violate applicable law.",
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
        "Relayium's source code is available under the MIT license. Your use of the source code is governed by that license.",
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
  description: "使用 Relayium 的条款——一项免费、开源、端到端加密的点对点文件传输服务,按现状提供。",
  updatedLabel: "最后更新",
  updated: "2026-07-01",
  otherDocLabel: "隐私政策",
  lead: [
    "使用 Relayium 即表示你同意本条款。Relayium 是一项免费且开源的服务,让你在设备之间直接、端到端加密地发送文件。",
  ],
  sections: [
    {
      heading: "服务说明",
      body: ["Relayium 在设备之间点对点传输文件。本服务免费提供,其源代码以 MIT 许可证开源。"],
    },
    {
      heading: "可接受的使用",
      body: ["你同意不将 Relayium 用于:"],
      bullets: [
        "违反法律或侵犯他人权利,包括发送你无权分享的内容。",
        "传播恶意软件,或试图扰乱、过载或滥用本服务及其基础设施。",
        "规避安全措施,或试图访问不属于你的数据。",
      ],
    },
    {
      heading: "账号",
      body: [
        "同一网络(局域网)内的传输无需账号。跨网络使用配对码传输时,需要发送方登录——接收方始终无需账号。创建暂存下载链接同样需要账号。你有责任妥善保管你的邮箱和账号访问权限。你可以随时联系 support@relayium.com,要求删除你的账号及其数据。",
      ],
    },
    {
      heading: "暂存内容",
      body: [
        "使用可选的暂存下载链接功能时，浏览器在上传前加密文件，服务器仅存储密文。由于我们无法解密暂存内容（零知识），因此无法预审其内容。你同意暂存传输仅用于你有权分享且不违反适用法律的内容。",
      ],
      bullets: [
        "你可以通过向 support@relayium.com 举报文件 id 来申请删除特定下载链接。",
        "暂存密文在到期或首次完整下载（阅后即焚）时自动删除，以先到者为准。",
        "我们保留暂停或删除被可信举报为违法内容的权利。",
      ],
    },
    {
      heading: "不提供担保",
      body: [
        "本服务按「现状」和「可用情况」提供,不附带任何明示或默示的担保。我们不保证传输总能成功,也不保证服务不中断或无错误。",
      ],
    },
    {
      heading: "责任限制",
      body: [
        "在法律允许的最大范围内,对于因你使用本服务而产生的任何间接、附带或后果性损害,或任何数据丢失,Relayium 及其贡献者概不负责。",
      ],
    },
    {
      heading: "开源与许可",
      body: ["Relayium 的源代码以 MIT 许可证提供。你对源代码的使用受该许可证约束。"],
    },
    {
      heading: "本条款的变更",
      body: [
        "随着服务演进,我们可能会更新本条款。届时我们会更新上方的「最后更新」日期。变更后继续使用即表示你接受更新后的条款。",
      ],
    },
    {
      heading: "联系我们",
      body: ["有关于条款的疑问?请发邮件至 support@relayium.com。"],
    },
  ],
};

const ja = {
  title: "利用規約",
  description:
    "Relayiumの利用規約——無料でオープンソースのエンドツーエンド暗号化P2Pファイル転送サービスを現状のまま提供します。",
  updatedLabel: "最終更新",
  updated: "2026-07-01",
  otherDocLabel: "プライバシーポリシー",
  lead: [
    "Relayiumを利用することで、あなたはこれらの規約に同意したものとみなします。Relayiumは、デバイス間で直接かつエンドツーエンドで暗号化されたファイル送信を可能にする、無料のオープンソースサービスです。",
  ],
  sections: [
    {
      heading: "サービスについて",
      body: [
        "Relayiumはデバイス間でピアツーピアでファイルを転送します。無料で提供されており、そのソースコードはMITライセンスのもとオープンソースとして公開されています。",
      ],
    },
    {
      heading: "許容される使用",
      body: ["あなたはRelayiumを以下の目的で使用しないことに同意します："],
      bullets: [
        "法律に違反したり、他者の権利を侵害したりすること。共有する権利のないコンテンツの送信を含みます。",
        "マルウェアを配布すること、またはサービスやそのインフラを妨害、過負荷にする、または悪用しようとすること。",
        "セキュリティ対策を迂回すること、またはあなたのものではないデータへのアクセスを試みること。",
      ],
    },
    {
      heading: "アカウント",
      body: [
        "同一ネットワーク(LAN)内の転送はアカウント不要です。ペアリングコードを使ってネットワークをまたいで送信する場合は、送信者のサインインが必要です——受信者はアカウント不要のままです。保存型ダウンロードリンクの作成にもアカウントが必要です。メールアドレスとアカウントへのアクセスを安全に保つ責任はあなたにあります。support@relayium.com までご連絡いただければ、いつでもアカウントとそのデータの削除を依頼できます。",
      ],
    },
    {
      heading: "保存コンテンツ",
      body: [
        "オプションの一時保存ダウンロードリンク機能を使用する場合、ブラウザがアップロード前にファイルを暗号化し、サーバーは暗号文のみを保存します。保存コンテンツを復号できない（ゼロ知識）ため、当社は事前にコンテンツを審査することができません。あなたは一時保存転送を、共有する権利を持ちかつ適用法に違反しないコンテンツのためにのみ使用することに同意します。",
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
        "法律で許可される最大限の範囲において、Relayiumおよびその貢献者は、本サービスの利用に起因するいかなる間接的、付随的、または結果的損害、あるいはデータの損失についても責任を負いません。",
      ],
    },
    {
      heading: "オープンソースとライセンス",
      body: [
        "RelayiumのソースコードはMITライセンスのもとで公開されています。ソースコードの使用はそのライセンスに従います。",
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
      body: ["規約に関するご質問は、support@relayium.comまでメールでお問い合わせください。"],
    },
  ],
};

const ko = {
  title: "이용약관",
  description:
    "Relayium 이용약관 — 무료 오픈소스 엔드 투 엔드 암호화 P2P 파일 전송 서비스를 있는 그대로 제공합니다.",
  updatedLabel: "최종 업데이트",
  updated: "2026-07-01",
  otherDocLabel: "개인정보 처리방침",
  lead: [
    "Relayium을 사용함으로써 귀하는 이 약관에 동의하는 것으로 간주됩니다. Relayium은 장치 간에 직접 엔드 투 엔드로 암호화된 파일 전송을 지원하는 무료 오픈소스 서비스입니다.",
  ],
  sections: [
    {
      heading: "서비스 소개",
      body: [
        "Relayium은 장치 간에 피어 투 피어로 파일을 전송합니다. 무료로 제공되며 소스 코드는 MIT 라이선스 하에 오픈소스로 공개되어 있습니다.",
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
        "동일 네트워크(LAN) 내 전송은 계정이 필요 없습니다. 페어링 코드로 네트워크를 넘나들며 전송하려면 발신자가 로그인해야 합니다——수신자는 여전히 계정이 필요 없습니다. 저장형 다운로드 링크를 만드는 데도 계정이 필요합니다. 이메일 주소와 계정에 대한 접근을 안전하게 관리할 책임은 귀하에게 있습니다. support@relayium.com으로 연락하시면 언제든지 계정과 그 데이터의 삭제를 요청할 수 있습니다.",
      ],
    },
    {
      heading: "임시 보관 콘텐츠",
      body: [
        "선택적 임시 보관 다운로드 링크 기능을 사용하면 브라우저가 업로드 전에 파일을 암호화하고 서버는 암호문만 저장합니다. 저장된 콘텐츠를 복호화할 수 없기 때문에(제로 지식) 사전에 콘텐츠를 심사할 수 없습니다. 귀하는 임시 보관 전송을 공유할 권리가 있고 적용 법률을 위반하지 않는 콘텐츠에만 사용하는 것에 동의합니다.",
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
        "본 서비스는 명시적 또는 묵시적 보증 없이 '있는 그대로' 및 '이용 가능한 상태로' 제공됩니다. 전송이 항상 성공하거나 서비스가 중단 없이 오류 없이 제공될 것을 보장하지 않습니다.",
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
        "Relayium의 소스 코드는 MIT 라이선스 하에 이용 가능합니다. 소스 코드의 사용은 해당 라이선스의 적용을 받습니다.",
      ],
    },
    {
      heading: "약관 변경",
      body: [
        "서비스가 발전함에 따라 이 약관을 업데이트할 수 있습니다. 업데이트 시 위의 '최종 업데이트' 날짜를 변경합니다. 변경 후 계속 사용하는 것은 업데이트된 약관에 동의하는 것을 의미합니다.",
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
    "Die Nutzungsbedingungen für Relayium — ein kostenloser, quelloffener, Ende-zu-Ende-verschlüsselter Peer-to-Peer-Dateiübertragungsdienst, der ohne Gewährleistung bereitgestellt wird.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-07-01",
  otherDocLabel: "Datenschutzerklärung",
  lead: [
    "Durch die Nutzung von Relayium stimmen Sie diesen Bedingungen zu. Relayium ist ein kostenloser und quelloffener Dienst, der es Ihnen ermöglicht, Dateien direkt zwischen Geräten Ende-zu-Ende-verschlüsselt zu senden.",
  ],
  sections: [
    {
      heading: "Der Dienst",
      body: [
        "Relayium überträgt Dateien Peer-to-Peer zwischen Geräten. Er wird kostenlos bereitgestellt und der Quellcode ist unter der MIT-Lizenz quelloffen.",
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
        "Übertragungen im selben Netzwerk (LAN) benötigen kein Konto. Für den Versand über Netzwerke hinweg per Pairing-Code muss sich die sendende Person anmelden — die empfangende Person benötigt weiterhin kein Konto. Auch das Erstellen eines gespeicherten Download-Links erfordert ein Konto. Sie sind dafür verantwortlich, den Zugang zu Ihrer E-Mail-Adresse und Ihrem Konto zu sichern. Sie können jederzeit die Löschung Ihres Kontos und der zugehörigen Daten beantragen, indem Sie uns unter support@relayium.com kontaktieren.",
      ],
    },
    {
      heading: "Zwischengespeicherte Inhalte",
      body: [
        "Beim optionalen Modus für zwischengespeicherte Download-Links verschlüsselt Ihr Browser die Dateien vor dem Hochladen und der Server speichert nur Chiffretext. Da wir zwischengespeicherte Inhalte nicht entschlüsseln können (Zero-Knowledge), ist eine Vorabprüfung der Inhalte nicht möglich. Sie stimmen zu, zwischengespeicherte Übertragungen ausschließlich für Inhalte zu nutzen, zu deren Weitergabe Sie berechtigt sind und die nicht gegen geltendes Recht verstoßen.",
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
        "Der Quellcode von Relayium ist unter der MIT-Lizenz verfügbar. Ihre Nutzung des Quellcodes unterliegt dieser Lizenz.",
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
    "Les conditions d'utilisation de Relayium — un service de transfert de fichiers pair à pair, gratuit, open source et chiffré de bout en bout, fourni tel quel.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-07-01",
  otherDocLabel: "Politique de confidentialité",
  lead: [
    "En utilisant Relayium, vous acceptez ces conditions. Relayium est un service gratuit et open source qui vous permet d'envoyer des fichiers directement entre appareils, chiffrés de bout en bout.",
  ],
  sections: [
    {
      heading: "Le service",
      body: [
        "Relayium transfère des fichiers de pair à pair entre appareils. Il est fourni gratuitement et son code source est open source sous licence MIT.",
      ],
    },
    {
      heading: "Utilisation acceptable",
      body: ["Vous acceptez de ne pas utiliser Relayium pour :"],
      bullets: [
        "Enfreindre la loi ou porter atteinte aux droits d'autrui, notamment en envoyant des contenus que vous n'avez pas le droit de partager.",
        "Distribuer des logiciels malveillants, ou tenter de perturber, de surcharger ou d'abuser du service ou de son infrastructure.",
        "Contourner les mesures de sécurité ou tenter d'accéder à des données qui ne vous appartiennent pas.",
      ],
    },
    {
      heading: "Comptes",
      body: [
        "Les transferts sur le même réseau (local) ne nécessitent aucun compte. L'envoi entre réseaux différents via un code d'appairage exige que l'expéditeur se connecte — la personne qui reçoit n'a jamais besoin de compte. La création d'un lien de téléchargement stocké exige elle aussi un compte. Vous êtes responsable de la sécurisation de l'accès à votre adresse e-mail et à votre compte. Vous pouvez demander la suppression de votre compte et de ses données à tout moment en nous contactant à support@relayium.com.",
      ],
    },
    {
      heading: "Contenu stocké",
      body: [
        "Lorsque vous utilisez le mode optionnel de liens de téléchargement stockés, votre navigateur chiffre les fichiers avant l'envoi et le serveur ne stocke que du chiffré. Comme nous ne pouvons pas déchiffrer le contenu stocké (zéro-connaissance), nous ne pouvons pas en faire une présélection. Vous acceptez d'utiliser les transferts stockés uniquement pour du contenu que vous avez le droit de partager et qui ne viole pas la loi applicable.",
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
        "Le code source de Relayium est disponible sous licence MIT. Votre utilisation du code source est régie par cette licence.",
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
      body: ["Des questions sur ces conditions ? Écrivez-nous à support@relayium.com."],
    },
  ],
};

const ar = {
  title: "شروط الخدمة",
  description:
    "شروط استخدام Relayium — خدمة نقل ملفات من الند للند، مجانية ومفتوحة المصدر ومُشفَّرة من الطرف إلى الطرف، تُقدَّم كما هي.",
  updatedLabel: "آخر تحديث",
  updated: "2026-07-01",
  otherDocLabel: "سياسة الخصوصية",
  lead: [
    "باستخدامك Relayium فإنك توافق على هذه الشروط. Relayium خدمة مجانية ومفتوحة المصدر تتيح لك إرسال الملفات مباشرةً بين الأجهزة، مُشفَّرة من الطرف إلى الطرف.",
  ],
  sections: [
    {
      heading: "الخدمة",
      body: [
        "تنقل Relayium الملفات من الند للند بين الأجهزة. وهي تُقدَّم مجانًا وشِفرتها المصدرية مفتوحة المصدر بموجب رخصة MIT.",
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
        "لا تتطلب عمليات النقل على نفس الشبكة (الشبكة المحلية) أي حساب. أما الإرسال عبر الشبكات باستخدام رمز الاقتران فيتطلب من المُرسِل تسجيل الدخول — ولا يحتاج المُستقبِل إطلاقًا إلى حساب. كما يتطلب إنشاء رابط تنزيل مُخزَّن حسابًا. وأنت مسؤول عن الحفاظ على أمان الوصول إلى بريدك الإلكتروني وحسابك. ويمكنك طلب حذف حسابك وبياناته في أي وقت عبر مراسلة support@relayium.com.",
      ],
    },
    {
      heading: "المحتوى المُخزَّن",
      body: [
        "عندما تستخدم وضع رابط التنزيل المُخزَّن الاختياري، يُشفِّر متصفحك الملفات قبل الرفع ولا يخزّن الخادم سوى النص المُشفَّر. ولأننا لا نستطيع فك تشفير المحتوى المُخزَّن (معرفة صفرية)، فإننا لا نستطيع فحصه مسبقًا. وأنت توافق على استخدام عمليات النقل المُخزَّن فقط لمحتوى يحق لك مشاركته ولا ينتهك القانون المعمول به.",
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
        "شِفرة Relayium المصدرية متاحة بموجب رخصة MIT. ويخضع استخدامك للشِفرة المصدرية لتلك الرخصة.",
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
    "Los términos para usar Relayium: un servicio de transferencia de archivos de igual a igual, gratuito, de código abierto y cifrado de extremo a extremo, proporcionado tal cual.",
  updatedLabel: "Última actualización",
  updated: "2026-07-01",
  otherDocLabel: "Política de privacidad",
  lead: [
    "Al usar Relayium aceptas estos términos. Relayium es un servicio gratuito y de código abierto que te permite enviar archivos directamente entre dispositivos, cifrados de extremo a extremo.",
  ],
  sections: [
    {
      heading: "El servicio",
      body: [
        "Relayium transfiere archivos de igual a igual entre dispositivos. Se proporciona de forma gratuita y su código fuente es de código abierto bajo la licencia MIT.",
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
        "Las transferencias en la misma red (red local) no necesitan cuenta. Enviar entre redes con un código de emparejamiento requiere que el remitente inicie sesión: la persona que recibe nunca necesita una cuenta. Crear un enlace de descarga almacenado también requiere una cuenta. Eres responsable de mantener seguro el acceso a tu correo electrónico y a tu cuenta. Puedes solicitar la eliminación de tu cuenta y sus datos en cualquier momento contactando con support@relayium.com.",
      ],
    },
    {
      heading: "Contenido almacenado",
      body: [
        "Cuando usas el modo opcional de enlace de descarga almacenado, tu navegador cifra los archivos antes de subirlos y el servidor solo almacena texto cifrado. Como no podemos descifrar el contenido almacenado (conocimiento cero), no podemos examinarlo previamente. Aceptas usar las transferencias almacenadas únicamente para contenido que tienes derecho a compartir y que no infringe la ley aplicable.",
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
        "En la máxima medida permitida por la ley, Relayium y sus colaboradores no son responsables de ningún daño indirecto, incidental o consecuente, ni de ninguna pérdida de datos, derivados de tu uso del servicio.",
      ],
    },
    {
      heading: "Código abierto y licencias",
      body: [
        "El código fuente de Relayium está disponible bajo la licencia MIT. Tu uso del código fuente se rige por esa licencia.",
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
    "Os termos para usar a Relayium — um serviço de transferência de arquivos ponto a ponto, gratuito, de código aberto e com criptografia de ponta a ponta, fornecido no estado em que se encontra.",
  updatedLabel: "Última atualização",
  updated: "2026-07-01",
  otherDocLabel: "Política de Privacidade",
  lead: [
    "Ao usar a Relayium, você concorda com estes termos. A Relayium é um serviço gratuito e de código aberto que permite enviar arquivos diretamente entre dispositivos, com criptografia de ponta a ponta.",
  ],
  sections: [
    {
      heading: "O serviço",
      body: [
        "A Relayium transfere arquivos ponto a ponto entre dispositivos. É fornecida gratuitamente e seu código-fonte é de código aberto sob a licença MIT.",
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
        "As transferências na mesma rede (rede local) não precisam de conta. Enviar entre redes com um código de emparelhamento exige que o remetente faça login — quem recebe nunca precisa de uma conta. Criar um link de download armazenado também exige uma conta. Você é responsável por manter seguro o acesso ao seu e-mail e à sua conta. Você pode solicitar a exclusão da sua conta e dos seus dados a qualquer momento entrando em contato pelo support@relayium.com.",
      ],
    },
    {
      heading: "Conteúdo armazenado",
      body: [
        "Quando você usa o modo opcional de link de download armazenado, seu navegador criptografa os arquivos antes do envio e o servidor armazena apenas texto cifrado. Como não podemos descriptografar o conteúdo armazenado (conhecimento zero), não podemos examiná-lo previamente. Você concorda em usar as transferências armazenadas apenas para conteúdo que tem o direito de compartilhar e que não viola a lei aplicável.",
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
        "O código-fonte da Relayium está disponível sob a licença MIT. Seu uso do código-fonte é regido por essa licença.",
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
