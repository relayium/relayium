// Shared factual errata for the seven ARCHIVED (frozen) locales.
//
// The archived translations are not maintained copy, but they stay public and
// indexable, so a claim in them that is now false about the CLI — and that a
// reader would act on — is corrected in place with the smallest translated
// sentence that states the current fact (DECISION-LOG 2026-09-30, item 2; the
// W-N50–52 precedent in archived-fact-errata.test.mjs). This module holds the
// one fragment that repeats across pages: the notice that replaces a section
// whose whole subject was the retired SSH transport. Only frozen locales carry
// it; the maintained en/zh pages describe the current CLI directly.
//
// The notice never shows a retired command as runnable. It names what the
// section used to cover, the refusal a reader of an old script will see, the
// current replacement, and points at the maintained versions of the same page,
// which every archived page links from its archive notice at the top.

export const sshRetiredNotice = {
  ja: "過去の記述についての注記：この節では Relayium の SSH 転送（user@host:path 形式の宛先への push や sync、relayium pull、-i と -p オプション）を説明していました。現在の CLI ではこれらは廃止され、「SSH transfers are currently disabled」と表示して拒否されるため、ここにあったコマンドはもう動作せず、掲載していません。自分で管理する2台のマシンの間では、relayium serve と relayium://host への push または sync を使ってください。現在の手順は、ページ上部からリンクしている、保守されている英語版と簡体字中国語版に記載されています。",
  ko: "이전 내용에 대한 안내: 이 절은 Relayium의 SSH 전송(user@host:path 형식 대상으로의 push 또는 sync, relayium pull, -i 및 -p 옵션)을 설명했습니다. 현재 CLI에서는 이 기능이 폐지되어 \"SSH transfers are currently disabled\"라는 메시지와 함께 거부되므로, 여기에 있던 명령은 더 이상 동작하지 않으며 싣지 않습니다. 직접 관리하는 두 기기 사이에서는 relayium serve와 relayium://host로의 push 또는 sync를 사용하세요. 현재 절차는 페이지 상단에서 링크한, 유지 관리되는 영어판과 중국어 간체판에 있습니다.",
  de: "Historischer Hinweis: Dieser Abschnitt beschrieb die SSH-Übertragungen von Relayium – push oder sync zu einem Ziel der Form user@host:path, relayium pull sowie die Optionen -i und -p. Die aktuelle CLI hat sie eingestellt und lehnt sie mit „SSH transfers are currently disabled“ ab; die Befehle, die hier standen, funktionieren daher nicht mehr und werden nicht mehr gezeigt. Zwischen zwei Rechnern, die du verwaltest, nutze relayium serve mit push oder sync zu relayium://host; die gepflegte englische und vereinfacht-chinesische Fassung dieser Seite, oben verlinkt, beschreiben die aktuellen Schritte.",
  fr: "Note historique : cette section décrivait les transferts SSH de Relayium — push ou sync vers une destination user@host:path, relayium pull et les options -i et -p. La CLI actuelle les a retirés et les refuse avec « SSH transfers are currently disabled » ; les commandes qui figuraient ici ne fonctionnent donc plus et ne sont plus affichées. Entre deux machines que vous gérez, utilisez relayium serve avec push ou sync vers relayium://host ; les versions anglaise et chinoise simplifiée maintenues de cette page, liées en haut, décrivent les étapes actuelles.",
  ar: "ملاحظة تاريخية: كان هذا القسم يشرح عمليات النقل عبر SSH في Relayium — أي push أو sync إلى وجهة بصيغة user@host:path، وrelayium pull، والخيارين -i و-p. وقد أوقف CLI الحالي هذه العمليات ويرفضها برسالة «SSH transfers are currently disabled»، لذا لم تعد الأوامر التي كانت هنا تعمل ولم تعد معروضة. بين جهازين تديرهما، استخدم relayium serve مع push أو sync إلى relayium://host؛ وتشرح النسختان الإنجليزية والصينية المبسّطة المُحدَّثتان من هذه الصفحة، المرتبطتان في أعلاها، الخطوات الحالية.",
  es: "Nota histórica: esta sección describía las transferencias SSH de Relayium: push o sync a un destino user@host:path, relayium pull y las opciones -i y -p. El CLI actual las ha retirado y las rechaza con «SSH transfers are currently disabled», así que los comandos que había aquí ya no funcionan y no se muestran. Entre dos máquinas que administres, usa relayium serve con push o sync a relayium://host; las versiones mantenidas en inglés y en chino simplificado de esta página, enlazadas arriba, describen los pasos actuales.",
  pt: "Nota histórica: esta seção descrevia as transferências por SSH do Relayium — push ou sync para um destino user@host:path, relayium pull e as opções -i e -p. A CLI atual as descontinuou e as recusa com “SSH transfers are currently disabled”, então os comandos que estavam aqui não funcionam mais e não são mostrados. Entre duas máquinas que você administra, use relayium serve com push ou sync para relayium://host; as versões mantidas em inglês e chinês simplificado desta página, com links no topo, descrevem os passos atuais.",
};
