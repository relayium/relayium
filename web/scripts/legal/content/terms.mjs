// web/scripts/legal/content/terms.mjs
const en = {
  title: "Terms of Service",
  description:
    "The terms for using Relayium — a free, open-source, end-to-end encrypted peer-to-peer file transfer service provided as is.",
  updatedLabel: "Last updated",
  updated: "2026-06-29",
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
        "An account is optional and only needed for cross-network transfers. You are responsible for keeping access to your email and account secure. You may delete your account at any time.",
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
  updated: "2026-06-29",
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
        "账号是可选的,仅跨网络传输时需要。你有责任妥善保管你的邮箱和账号访问权限。你可以随时删除你的账号。",
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
  updated: "2026-06-29",
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
        "アカウントは任意で、クロスネットワーク転送にのみ必要です。メールアドレスとアカウントへのアクセスを安全に保つ責任はあなたにあります。アカウントはいつでも削除できます。",
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
  updated: "2026-06-29",
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
        "계정은 선택 사항이며 크로스 네트워크 전송에만 필요합니다. 이메일 주소와 계정에 대한 접근을 안전하게 관리할 책임은 귀하에게 있습니다. 계정은 언제든지 삭제할 수 있습니다.",
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
  updated: "2026-06-29",
  otherDocLabel: "Datenschutzrichtlinie",
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
        "Ein Konto ist optional und wird nur für netzwerkübergreifende Übertragungen benötigt. Sie sind dafür verantwortlich, den Zugang zu Ihrer E-Mail-Adresse und Ihrem Konto zu sichern. Sie können Ihr Konto jederzeit löschen.",
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
  updated: "2026-06-29",
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
        "Un compte est facultatif et n'est nécessaire que pour les transferts inter-réseaux. Vous êtes responsable de la sécurisation de l'accès à votre adresse e-mail et à votre compte. Vous pouvez supprimer votre compte à tout moment.",
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

export default { slug: "terms", langs: { en, zh, ja, ko, de, fr } };
