// web/scripts/pages/content/legal/support.mjs
// Rendered by the legal template (same shape as privacy/terms/security) because
// it is the same kind of page: static, no-JS, one canonical URL per language.
// This is the URL given to Stripe as the account's Customer support URL, so it
// must always name a real, monitored way to reach a human.
const en = {
  title: "Support",
  description:
    "How to get help with Relayium: contact for billing and subscriptions, transfer problems, self-hosted nodes, and security reports.",
  updatedLabel: "Last updated",
  updated: "2026-07-20",
  otherDocLabel: "Terms of Service",
  lead: [
    "Relayium is run by a small team. Every message reaches a person who works on the product — there is no ticket maze and no chatbot in front of us.",
    "Email support@relayium.com and we aim to reply within two business days.",
  ],
  sections: [
    {
      heading: "Billing and subscriptions",
      body: [
        "You can manage most of it yourself without writing to us. From your account page you can upgrade, downgrade, or cancel at any time; cancelling keeps your plan running until the end of the period you already paid for, and then drops you to Free.",
        "Write to support@relayium.com for anything the account page cannot do — a refund request, a wrong charge, an invoice or VAT detail, or a payment that failed for a reason you cannot see.",
      ],
      bullets: [
        "Upgrades take effect immediately and are prorated; downgrades take effect at the end of the current billing period, so you keep what you paid for.",
        "Include the email address on the account. Never send us your card number — we never see it, and we will never ask for it.",
      ],
    },
    {
      heading: "Transfers and technical problems",
      body: [
        "If a transfer will not connect or a download fails, tell us which mode you were using (realtime pairing code, or a stored download link), the browsers and operating systems on both ends, and roughly when it happened. That is almost always enough to identify the cause.",
        "Bug reports and feature requests are welcome in public on GitHub, where you can also read the code that handles your files.",
      ],
      bullets: [
        "Do not paste a download link or its key into a public issue — the key in the link is what decrypts your file.",
      ],
    },
    {
      heading: "Self-hosted nodes",
      body: [
        "If you run your own relay or storage node, questions and problems belong on GitHub rather than in email, so the answers stay searchable for everyone else running one.",
      ],
    },
    {
      heading: "Security reports",
      body: [
        "Please report vulnerabilities privately through GitHub's vulnerability reporting on the repository rather than opening a public issue, so a fix can ship before the details are public. Our threat model and what we do and do not defend against are documented on the Security page.",
      ],
    },
  ],
};

const zh = {
  title: "支持",
  description:
    "如何获得 Relayium 的帮助：账单与订阅、传输故障、自建节点以及安全问题的联系方式。",
  updatedLabel: "最后更新",
  updated: "2026-07-20",
  otherDocLabel: "服务条款",
  lead: [
    "Relayium 由一个小团队运营。每一封来信都会送到真正开发这个产品的人手里——没有层层转派的工单系统，也没有挡在前面的聊天机器人。",
    "请发信至 support@relayium.com，我们力争在两个工作日内回复。",
  ],
  sections: [
    {
      heading: "账单与订阅",
      body: [
        "大部分事情你都可以自己处理，无需写信给我们。在账户页面你可以随时升级、降级或取消；取消后套餐仍会持续到你已付费周期的结束，之后转为免费版。",
        "凡是账户页面做不到的事，请写信到 support@relayium.com——退款申请、扣错费用、发票或税务信息，以及你看不出原因的支付失败。",
      ],
      bullets: [
        "升级立即生效并按比例计费；降级在当前计费周期结束时生效，因此你付过的部分不会白付。",
        "请附上账户所用的邮箱地址。切勿把卡号发给我们——我们看不到它，也永远不会索要。",
      ],
    },
    {
      heading: "传输与技术问题",
      body: [
        "如果传输连不上或下载失败，请告诉我们你用的是哪种模式（实时配对码，还是暂存下载链接）、两端的浏览器与操作系统，以及大致的发生时间。这些信息几乎总能让我们定位原因。",
        "缺陷报告与功能建议欢迎公开发到 GitHub，你也可以在那里读到处理你文件的全部代码。",
      ],
      bullets: [
        "请勿把下载链接或其中的密钥贴到公开 issue 里——链接里的密钥正是解密你文件的钥匙。",
      ],
    },
    {
      heading: "自建节点",
      body: [
        "如果你自行运行中继或存储节点，相关问题请发到 GitHub 而不是邮件，这样答案能被其他同样自建节点的人搜到。",
      ],
    },
    {
      heading: "安全问题上报",
      body: [
        "请通过仓库上 GitHub 的私密漏洞上报渠道私下报告漏洞，而不要公开提交 issue，这样修复才能赶在细节公开之前发布。我们的威胁模型、以及我们能防和不能防什么，都记录在安全页面上。",
      ],
    },
  ],
};

const ja = {
  title: "サポート",
  description:
    "Relayium のサポート窓口：請求とサブスクリプション、転送のトラブル、セルフホストのノード、セキュリティ報告について。",
  updatedLabel: "最終更新",
  updated: "2026-07-20",
  otherDocLabel: "利用規約",
  lead: [
    "Relayium は少人数のチームで運営しています。いただいたメッセージは必ず、製品を実際に作っている人間に届きます。たらい回しのチケットシステムも、前面に立ちはだかるチャットボットもありません。",
    "support@relayium.com までメールでご連絡ください。2 営業日以内の返信を目指しています。",
  ],
  sections: [
    {
      heading: "請求とサブスクリプション",
      body: [
        "ほとんどのことはご自身で完結でき、こちらへご連絡いただく必要はありません。アカウントページからいつでもアップグレード・ダウングレード・解約ができます。解約しても、すでにお支払い済みの期間の終わりまではプランがそのまま有効で、その後は無料プランに戻ります。",
        "アカウントページで対応できないこと——返金のご依頼、誤った請求、請求書や税務情報、原因の分からない支払い失敗——については support@relayium.com までご連絡ください。",
      ],
      bullets: [
        "アップグレードは即時に有効になり日割りで計算されます。ダウングレードは現在の請求期間の終了時に有効になるため、お支払い済みの分は無駄になりません。",
        "アカウントに登録されているメールアドレスを併記してください。カード番号は絶対にお送りにならないでください——当社が目にすることはなく、お尋ねすることもありません。",
      ],
    },
    {
      heading: "転送と技術的な問題",
      body: [
        "転送が接続できない、またはダウンロードが失敗する場合は、どのモードをお使いだったか（リアルタイムのペアリングコードか、一時保存ダウンロードリンクか）、両端のブラウザと OS、そしておおよその発生時刻をお知らせください。ほとんどの場合、それだけで原因を特定できます。",
        "バグ報告と機能のご要望は GitHub で公開の形で歓迎しています。ファイルを扱うコードもそこで読むことができます。",
      ],
      bullets: [
        "ダウンロードリンクやその鍵を公開の issue に貼らないでください——リンクの中の鍵こそが、ファイルを復号するものです。",
      ],
    },
    {
      heading: "セルフホストのノード",
      body: [
        "ご自身で中継ノードやストレージノードを運用している場合、質問や問題はメールではなく GitHub にお寄せください。そうすれば、同じくノードを運用している他の方も回答を検索できます。",
      ],
    },
    {
      heading: "セキュリティ報告",
      body: [
        "脆弱性は公開の issue を作成せず、リポジトリの GitHub 非公開脆弱性報告を通じて非公開でご報告ください。詳細が公になる前に修正を出せるようにするためです。当社の脅威モデル、および何を守り何を守らないかはセキュリティのページに記載しています。",
      ],
    },
  ],
};

const ko = {
  title: "지원",
  description:
    "Relayium 도움을 받는 방법: 결제와 구독, 전송 문제, 직접 운영하는 노드, 보안 신고 문의처.",
  updatedLabel: "최종 업데이트",
  updated: "2026-07-20",
  otherDocLabel: "이용약관",
  lead: [
    "Relayium은 소규모 팀이 운영합니다. 보내주신 모든 메시지는 이 제품을 직접 만드는 사람에게 전달됩니다. 복잡한 티켓 미로도, 앞을 가로막는 챗봇도 없습니다.",
    "support@relayium.com으로 메일을 보내주시면 영업일 기준 2일 이내에 답변드리는 것을 목표로 합니다.",
  ],
  sections: [
    {
      heading: "결제와 구독",
      body: [
        "대부분은 저희에게 연락하지 않고 직접 처리하실 수 있습니다. 계정 페이지에서 언제든지 업그레이드, 다운그레이드, 해지할 수 있으며, 해지하더라도 이미 결제한 기간이 끝날 때까지는 요금제가 그대로 유지되고 그 후 무료로 전환됩니다.",
        "계정 페이지에서 해결할 수 없는 일 — 환불 요청, 잘못된 청구, 인보이스나 세금 정보, 이유를 알 수 없는 결제 실패 — 은 support@relayium.com으로 문의해 주십시오.",
      ],
      bullets: [
        "업그레이드는 즉시 적용되며 일할 계산됩니다. 다운그레이드는 현재 결제 기간이 끝날 때 적용되므로 결제하신 만큼은 그대로 사용하실 수 있습니다.",
        "계정에 등록된 이메일 주소를 함께 적어 주십시오. 카드 번호는 절대 보내지 마십시오 — 저희는 카드 번호를 볼 수 없으며 요청하지도 않습니다.",
      ],
    },
    {
      heading: "전송 및 기술 문제",
      body: [
        "전송이 연결되지 않거나 다운로드가 실패하면, 어떤 방식을 사용하셨는지(실시간 페어링 코드인지, 임시 보관 다운로드 링크인지), 양쪽의 브라우저와 운영체제, 그리고 대략적인 발생 시각을 알려 주십시오. 거의 언제나 그것만으로 원인을 파악할 수 있습니다.",
        "버그 신고와 기능 제안은 GitHub에서 공개적으로 환영합니다. 그곳에서 사용자의 파일을 처리하는 코드도 직접 읽어 보실 수 있습니다.",
      ],
      bullets: [
        "다운로드 링크나 그 안의 키를 공개 이슈에 붙여 넣지 마십시오 — 링크 안의 키가 바로 파일을 복호화하는 열쇠입니다.",
      ],
    },
    {
      heading: "직접 운영하는 노드",
      body: [
        "직접 중계 노드나 저장 노드를 운영하신다면, 질문과 문제는 이메일보다 GitHub에 올려 주십시오. 그래야 같은 노드를 운영하는 다른 분들도 답변을 검색해 찾을 수 있습니다.",
      ],
    },
    {
      heading: "보안 신고",
      body: [
        "취약점은 공개 이슈를 여는 대신 저장소의 GitHub 비공개 취약점 신고를 통해 비공개로 알려 주십시오. 그래야 세부 내용이 공개되기 전에 수정을 배포할 수 있습니다. 저희 위협 모델과 무엇을 방어하고 무엇을 방어하지 않는지는 보안 페이지에 정리되어 있습니다.",
      ],
    },
  ],
};

const de = {
  title: "Hilfe & Support",
  description:
    "So erhalten Sie Hilfe zu Relayium: Kontakt für Abrechnung und Abonnements, Übertragungsprobleme, selbst betriebene Nodes und Sicherheitsmeldungen.",
  updatedLabel: "Zuletzt aktualisiert",
  updated: "2026-07-20",
  otherDocLabel: "Nutzungsbedingungen",
  lead: [
    "Relayium wird von einem kleinen Team betrieben. Jede Nachricht landet bei einem Menschen, der am Produkt arbeitet — es gibt kein Ticket-Labyrinth und keinen Chatbot davor.",
    "Schreiben Sie an support@relayium.com; wir bemühen uns, innerhalb von zwei Werktagen zu antworten.",
  ],
  sections: [
    {
      heading: "Abrechnung und Abonnements",
      body: [
        "Das meiste können Sie selbst erledigen, ohne uns zu schreiben. Auf Ihrer Kontoseite können Sie jederzeit ein Upgrade oder eine Herabstufung vornehmen oder kündigen; nach einer Kündigung läuft Ihr Tarif bis zum Ende des bereits bezahlten Zeitraums weiter und wechselt danach zu Free.",
        "Schreiben Sie an support@relayium.com für alles, was die Kontoseite nicht abdeckt — eine Rückerstattungsanfrage, eine falsche Abbuchung, eine Rechnungs- oder Umsatzsteuerangabe oder eine Zahlung, die aus einem für Sie nicht ersichtlichen Grund fehlgeschlagen ist.",
      ],
      bullets: [
        "Upgrades gelten sofort und werden anteilig berechnet; Herabstufungen werden zum Ende des laufenden Abrechnungszeitraums wirksam, sodass Ihnen das Bezahlte erhalten bleibt.",
        "Geben Sie die E-Mail-Adresse des Kontos an. Senden Sie uns niemals Ihre Kartennummer — wir sehen sie nie und werden niemals danach fragen.",
      ],
    },
    {
      heading: "Übertragungen und technische Probleme",
      body: [
        "Wenn eine Übertragung keine Verbindung aufbaut oder ein Download fehlschlägt, nennen Sie uns den verwendeten Modus (Echtzeit-Pairing-Code oder gespeicherter Download-Link), die Browser und Betriebssysteme auf beiden Seiten sowie ungefähr den Zeitpunkt. Das genügt fast immer, um die Ursache zu bestimmen.",
        "Fehlerberichte und Funktionswünsche sind öffentlich auf GitHub willkommen, wo Sie auch den Code lesen können, der Ihre Dateien verarbeitet.",
      ],
      bullets: [
        "Fügen Sie keinen Download-Link und keinen darin enthaltenen Schlüssel in ein öffentliches Issue ein — der Schlüssel im Link ist genau das, was Ihre Datei entschlüsselt.",
      ],
    },
    {
      heading: "Selbst betriebene Nodes",
      body: [
        "Wenn Sie eine eigene Relay- oder Storage-Node betreiben, gehören Fragen und Probleme auf GitHub statt in eine E-Mail, damit die Antworten für alle anderen Betreiber durchsuchbar bleiben.",
      ],
    },
    {
      heading: "Sicherheitsmeldungen",
      body: [
        "Bitte melden Sie Schwachstellen vertraulich über die GitHub-Schwachstellenmeldung im Repository, anstatt ein öffentliches Issue zu eröffnen, damit ein Fix erscheinen kann, bevor die Details öffentlich werden. Unser Bedrohungsmodell und wovor wir schützen und wovor nicht, sind auf der Sicherheitsseite dokumentiert.",
      ],
    },
  ],
};

const fr = {
  title: "Assistance",
  description:
    "Comment obtenir de l'aide sur Relayium : contact pour la facturation et les abonnements, les problèmes de transfert, les nœuds auto-hébergés et les signalements de sécurité.",
  updatedLabel: "Dernière mise à jour",
  updated: "2026-07-20",
  otherDocLabel: "Conditions d'utilisation",
  lead: [
    "Relayium est géré par une petite équipe. Chaque message parvient à une personne qui travaille sur le produit — il n'y a ni dédale de tickets, ni robot conversationnel en première ligne.",
    "Écrivez à support@relayium.com ; nous nous efforçons de répondre sous deux jours ouvrés.",
  ],
  sections: [
    {
      heading: "Facturation et abonnements",
      body: [
        "Vous pouvez gérer l'essentiel vous-même sans nous écrire. Depuis votre page de compte, vous pouvez à tout moment passer à une offre supérieure, rétrograder ou résilier ; en cas de résiliation, votre forfait reste actif jusqu'à la fin de la période déjà payée, puis bascule vers Gratuit.",
        "Écrivez à support@relayium.com pour tout ce que la page de compte ne permet pas — une demande de remboursement, un prélèvement erroné, une facture ou une mention de TVA, ou un paiement échoué pour une raison que vous ne pouvez pas identifier.",
      ],
      bullets: [
        "Les mises à niveau prennent effet immédiatement et sont calculées au prorata ; les rétrogradations prennent effet à la fin de la période de facturation en cours, de sorte que vous conservez ce que vous avez payé.",
        "Indiquez l'adresse e-mail associée au compte. Ne nous envoyez jamais votre numéro de carte — nous ne le voyons jamais et ne vous le demanderons jamais.",
      ],
    },
    {
      heading: "Transferts et problèmes techniques",
      body: [
        "Si un transfert ne parvient pas à se connecter ou si un téléchargement échoue, indiquez-nous le mode utilisé (code d'appairage en temps réel, ou lien de téléchargement stocké), les navigateurs et systèmes d'exploitation des deux côtés, et à peu près le moment où cela s'est produit. Cela suffit presque toujours à identifier la cause.",
        "Les rapports de bogues et les demandes de fonctionnalités sont les bienvenus publiquement sur GitHub, où vous pouvez aussi lire le code qui manipule vos fichiers.",
      ],
      bullets: [
        "Ne collez pas un lien de téléchargement ni sa clé dans un ticket public — la clé contenue dans le lien est ce qui déchiffre votre fichier.",
      ],
    },
    {
      heading: "Nœuds auto-hébergés",
      body: [
        "Si vous exploitez votre propre nœud de relais ou de stockage, les questions et les problèmes ont leur place sur GitHub plutôt que par e-mail, afin que les réponses restent consultables par tous ceux qui en font autant.",
      ],
    },
    {
      heading: "Signalements de sécurité",
      body: [
        "Veuillez signaler les vulnérabilités en privé via le signalement de vulnérabilité GitHub du dépôt plutôt qu'en ouvrant un ticket public, afin qu'un correctif puisse être publié avant les détails. Notre modèle de menace et ce contre quoi nous protégeons ou non sont documentés sur la page Sécurité.",
      ],
    },
  ],
};

const ar = {
  title: "الدعم",
  description:
    "كيف تحصل على المساعدة في Relayium: جهة الاتصال للفوترة والاشتراكات، ومشكلات النقل، والعُقد التي تشغّلها بنفسك، وبلاغات الأمان.",
  updatedLabel: "آخر تحديث",
  updated: "2026-07-20",
  otherDocLabel: "شروط الخدمة",
  lead: [
    "يدير Relayium فريق صغير. وكل رسالة تصل إلى شخص يعمل فعلًا على المنتج — فلا متاهة تذاكر ولا روبوت محادثة يقف بيننا وبينك.",
    "راسِلنا على support@relayium.com ونسعى للرد خلال يومَي عمل.",
  ],
  sections: [
    {
      heading: "الفوترة والاشتراكات",
      body: [
        "يمكنك إدارة معظم الأمور بنفسك دون مراسلتنا. فمن صفحة حسابك يمكنك الترقية أو خفض الباقة أو الإلغاء في أي وقت؛ والإلغاء يُبقي باقتك فعّالة حتى نهاية الفترة التي دفعت ثمنها بالفعل، ثم تعود إلى الباقة المجانية.",
        "راسِلنا على support@relayium.com لكل ما لا تستطيع صفحة الحساب فعله — طلب استرداد، أو رسم خاطئ، أو تفصيل يخصّ فاتورة أو ضريبة القيمة المضافة، أو دفعة أخفقت لسبب لا يظهر لك.",
      ],
      bullets: [
        "تسري الترقيات فورًا وتُحتسب بالتناسب؛ أما خفض الباقة فيسري في نهاية دورة الفوترة الحالية، فتحتفظ بما دفعت مقابله.",
        "أرفِق عنوان البريد الإلكتروني المسجَّل في الحساب. ولا ترسل إلينا رقم بطاقتك أبدًا — فنحن لا نراه إطلاقًا ولن نطلبه منك أبدًا.",
      ],
    },
    {
      heading: "عمليات النقل والمشكلات التقنية",
      body: [
        "إذا تعذّر على عملية نقل الاتصال أو أخفق تنزيل، فأخبِرنا بالوضع الذي كنت تستخدمه (رمز اقتران فوري، أو رابط تنزيل مُخزَّن)، والمتصفحات وأنظمة التشغيل على الطرفين، والوقت التقريبي لحدوث ذلك. فهذا وحده يكفي في الغالب لتحديد السبب.",
        "بلاغات الأخطاء وطلبات الميزات مرحَّب بها علنًا على GitHub، حيث يمكنك أيضًا قراءة الشِّفرة التي تتعامل مع ملفاتك.",
      ],
      bullets: [
        "لا تنسخ رابط تنزيل أو مفتاحه داخل مشكلة عامة — فالمفتاح الموجود في الرابط هو ما يفكّ تشفير ملفك.",
      ],
    },
    {
      heading: "العُقد التي تشغّلها بنفسك",
      body: [
        "إذا كنت تشغّل عقدة ترحيل أو تخزين خاصة بك، فمكان الأسئلة والمشكلات هو GitHub لا البريد الإلكتروني، حتى تبقى الإجابات قابلة للبحث لكل من يشغّل عقدة مثلك.",
      ],
    },
    {
      heading: "بلاغات الأمان",
      body: [
        "يُرجى الإبلاغ عن الثغرات بصورة خاصة عبر آلية الإبلاغ عن الثغرات في GitHub على المستودع بدلًا من فتح مشكلة عامة، حتى يمكن إصدار إصلاح قبل أن تصبح التفاصيل علنية. ونموذج التهديد لدينا وما نحمي منه وما لا نحمي منه موثّقان في صفحة الأمان.",
      ],
    },
  ],
};

const es = {
  title: "Soporte",
  description:
    "Cómo obtener ayuda con Relayium: contacto para facturación y suscripciones, problemas de transferencia, nodos autoalojados e informes de seguridad.",
  updatedLabel: "Última actualización",
  updated: "2026-07-20",
  otherDocLabel: "Términos del servicio",
  lead: [
    "Relayium lo lleva un equipo pequeño. Cada mensaje llega a una persona que trabaja en el producto: no hay laberinto de tickets ni un chatbot por delante.",
    "Escribe a support@relayium.com y procuramos responder en un plazo de dos días hábiles.",
  ],
  sections: [
    {
      heading: "Facturación y suscripciones",
      body: [
        "Casi todo puedes gestionarlo tú mismo sin escribirnos. Desde tu página de cuenta puedes mejorar, bajar de plan o cancelar cuando quieras; al cancelar, tu plan sigue activo hasta el final del periodo que ya pagaste y después pasa a Gratis.",
        "Escribe a support@relayium.com para todo lo que la página de cuenta no cubre: una solicitud de reembolso, un cargo erróneo, un dato de factura o de IVA, o un pago que falló por un motivo que no puedes ver.",
      ],
      bullets: [
        "Las mejoras surten efecto de inmediato y se prorratean; las bajadas de plan se aplican al final del periodo de facturación actual, así que conservas lo que pagaste.",
        "Incluye la dirección de correo de la cuenta. Nunca nos envíes el número de tu tarjeta: no lo vemos nunca y jamás te lo pediremos.",
      ],
    },
    {
      heading: "Transferencias y problemas técnicos",
      body: [
        "Si una transferencia no conecta o una descarga falla, dinos qué modo estabas usando (código de emparejamiento en tiempo real o un enlace de descarga almacenado), los navegadores y sistemas operativos de ambos extremos y aproximadamente cuándo ocurrió. Casi siempre basta con eso para identificar la causa.",
        "Los informes de errores y las peticiones de funciones son bienvenidos en público en GitHub, donde además puedes leer el código que maneja tus archivos.",
      ],
      bullets: [
        "No pegues un enlace de descarga ni su clave en una incidencia pública: la clave que va en el enlace es lo que descifra tu archivo.",
      ],
    },
    {
      heading: "Nodos autoalojados",
      body: [
        "Si ejecutas tu propio nodo de retransmisión o de almacenamiento, las dudas y los problemas van mejor en GitHub que por correo, para que las respuestas queden buscables para todos los demás que también ejecutan uno.",
      ],
    },
    {
      heading: "Informes de seguridad",
      body: [
        "Informa de las vulnerabilidades en privado a través del informe de vulnerabilidades de GitHub en el repositorio en lugar de abrir una incidencia pública, para que la corrección pueda publicarse antes que los detalles. Nuestro modelo de amenazas y aquello contra lo que protegemos o no está documentado en la página de Seguridad.",
      ],
    },
  ],
};

const pt = {
  title: "Suporte",
  description:
    "Como obter ajuda com a Relayium: contato para cobrança e assinaturas, problemas de transferência, nós auto-hospedados e relatos de segurança.",
  updatedLabel: "Última atualização",
  updated: "2026-07-20",
  otherDocLabel: "Termos de Serviço",
  lead: [
    "A Relayium é tocada por uma equipe pequena. Cada mensagem chega a uma pessoa que trabalha no produto — não há labirinto de tíquetes nem chatbot na nossa frente.",
    "Escreva para support@relayium.com; procuramos responder em até dois dias úteis.",
  ],
  sections: [
    {
      heading: "Cobrança e assinaturas",
      body: [
        "Você mesmo pode resolver a maior parte sem nos escrever. Na página da sua conta é possível fazer upgrade, downgrade ou cancelar a qualquer momento; ao cancelar, seu plano continua ativo até o fim do período que você já pagou e depois passa para o Gratuito.",
        "Escreva para support@relayium.com para o que a página da conta não resolve — um pedido de reembolso, uma cobrança indevida, um dado de nota fiscal ou de imposto, ou um pagamento que falhou por um motivo que você não consegue ver.",
      ],
      bullets: [
        "Os upgrades entram em vigor imediatamente e são proporcionais; os downgrades passam a valer no fim do período de cobrança atual, então você mantém aquilo que pagou.",
        "Informe o e-mail cadastrado na conta. Nunca nos envie o número do seu cartão — nós nunca o vemos e jamais vamos pedi-lo.",
      ],
    },
    {
      heading: "Transferências e problemas técnicos",
      body: [
        "Se uma transferência não conectar ou um download falhar, diga qual modo você estava usando (código de emparelhamento em tempo real ou um link de download armazenado), os navegadores e sistemas operacionais das duas pontas e aproximadamente quando aconteceu. Quase sempre isso já basta para identificar a causa.",
        "Relatos de bugs e pedidos de recursos são bem-vindos publicamente no GitHub, onde você também pode ler o código que lida com os seus arquivos.",
      ],
      bullets: [
        "Não cole um link de download nem a sua chave em uma issue pública — a chave que está no link é o que descriptografa o seu arquivo.",
      ],
    },
    {
      heading: "Nós auto-hospedados",
      body: [
        "Se você roda o seu próprio nó de retransmissão ou de armazenamento, dúvidas e problemas cabem no GitHub em vez do e-mail, para que as respostas continuem pesquisáveis por todos os outros que também rodam um.",
      ],
    },
    {
      heading: "Relatos de segurança",
      body: [
        "Por favor, relate vulnerabilidades de forma privada por meio do relato de vulnerabilidades do GitHub no repositório, em vez de abrir uma issue pública, para que a correção possa ser publicada antes que os detalhes venham a público. Nosso modelo de ameaças e aquilo contra o que protegemos ou não estão documentados na página de Segurança.",
      ],
    },
  ],
};

export default { slug: "support", langs: { en, zh, ja, ko, de, fr, ar, es, pt } };
