// web/scripts/pages/content/install-section.mjs
// Shared "install the CLI first" section, prepended to every CLI guide whose
// first actionable step is a `relayium` command — so a reader who lands here
// without the CLI installed doesn't hit `command not found`. Keyed by language;
// command blocks stay English in every language, matching the guides.

export const installSection = {
  en: {
    heading: "Before you start",
    body: [
      "Everything below is the relayium CLI, so install it first if you haven't. On macOS or Linux, one command drops a prebuilt binary on your PATH:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "Prefer to pick the file yourself, or on Windows? Grab a binary from the releases page — relayium.com/cli lists every install option (or go build -o relayium ./cmd/relayium if you have Go).",
      "relayium --version confirms it's installed. Skip this and the commands below just print 'command not found'.",
    ],
  },
  zh: {
    heading: "开始之前",
    body: [
      "下面用到的都是 relayium CLI，所以没装的话先装上。在 macOS 或 Linux 上，一条命令就能把预编译二进制放进你的 PATH：",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "想自己挑文件，或在 Windows 上？从发布页下载二进制——relayium.com/cli 列出了所有安装方式（装了 Go 也可 go build -o relayium ./cmd/relayium）。",
      "relayium --version 可确认是否装好。不装这一步，下面的命令只会报 “command not found”。",
    ],
  },
  ja: {
    heading: "始める前に",
    body: [
      "以下はすべて relayium CLI なので、未インストールならまず入れてください。macOS または Linux では、1つのコマンドでビルド済みバイナリが PATH に入ります：",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "自分でファイルを選びたい、または Windows の場合は、リリースページからバイナリを取得してください——relayium.com/cli にすべてのインストール方法があります（Go があれば go build -o relayium ./cmd/relayium も可）。",
      "relayium --version でインストールを確認できます。これをしないと以下のコマンドは「command not found」と出るだけです。",
    ],
  },
  ko: {
    heading: "시작하기 전에",
    body: [
      "아래는 모두 relayium CLI이므로, 설치하지 않았다면 먼저 설치하세요. macOS나 Linux에서는 명령어 하나로 사전 빌드된 바이너리가 PATH에 등록됩니다:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "직접 파일을 고르고 싶거나 Windows인가요? 릴리스 페이지에서 바이너리를 받으세요 — relayium.com/cli 에 모든 설치 방법이 있습니다(Go가 있으면 go build -o relayium ./cmd/relayium 도 가능).",
      "relayium --version 으로 설치를 확인할 수 있습니다. 이 단계를 건너뛰면 아래 명령은 “command not found”만 출력합니다.",
    ],
  },
  de: {
    heading: "Bevor du loslegst",
    body: [
      "Alles unten ist die relayium-CLI, installiere sie also zuerst, falls noch nicht geschehen. Unter macOS oder Linux legt ein Befehl ein vorgebautes Binary in deinen PATH:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "Willst du die Datei lieber selbst wählen, oder unter Windows? Hol dir ein Binary von der Releases-Seite — relayium.com/cli listet alle Installationswege (mit Go auch go build -o relayium ./cmd/relayium).",
      "relayium --version bestätigt die Installation. Ohne das geben die Befehle unten nur „command not found“ aus.",
    ],
  },
  fr: {
    heading: "Avant de commencer",
    body: [
      "Tout ci-dessous passe par la CLI relayium, alors installez-la d'abord si ce n'est pas fait. Sous macOS ou Linux, une commande place un binaire précompilé dans votre PATH :",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "Vous préférez choisir le fichier vous-même, ou sous Windows ? Récupérez un binaire depuis la page des releases — relayium.com/cli liste toutes les options (avec Go, go build -o relayium ./cmd/relayium).",
      "relayium --version confirme l'installation. Sans cela, les commandes ci-dessous affichent seulement « command not found ».",
    ],
  },
  ar: {
    heading: "قبل أن تبدأ",
    body: [
      "كل ما يلي هو relayium CLI، فثبّته أولًا إن لم تكن قد فعلت. على macOS وLinux، يُسقط أمر واحد ملفًا ثنائيًا مُسبق البناء في PATH الخاص بك:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "تفضّل اختيار الملف بنفسك، أو تعمل على Windows؟ احصل على ملف ثنائي من صفحة الإصدارات — يسرد relayium.com/cli كل خيارات التثبيت (أو go build -o relayium ./cmd/relayium إن كان لديك Go).",
      "يؤكّد relayium --version أنه مثبَّت. تخطَّ هذا وستطبع الأوامر أدناه ‘command not found’ لا غير.",
    ],
  },
  es: {
    heading: "Antes de empezar",
    body: [
      "Todo lo de abajo es la CLI de relayium, así que instálala primero si aún no la tienes. En macOS o Linux, un solo comando deja un binario precompilado en tu PATH:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "¿Prefieres elegir el archivo tú mismo, o estás en Windows? Coge un binario de la página de releases — relayium.com/cli lista todas las opciones de instalación (o go build -o relayium ./cmd/relayium si tienes Go).",
      "relayium --version confirma que está instalada. Sáltate esto y los comandos de abajo solo imprimirán « command not found ».",
    ],
  },
  pt: {
    heading: "Antes de começar",
    body: [
      "Tudo abaixo é a CLI do relayium, então instale-a primeiro se ainda não tiver. No macOS ou Linux, um comando coloca um binário pré-compilado no seu PATH:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "Prefere escolher o arquivo você mesmo, ou está no Windows? Pegue um binário na página de releases — relayium.com/cli lista todas as opções de instalação (ou go build -o relayium ./cmd/relayium se você tiver Go).",
      "relayium --version confirma que está instalada. Pule isso e os comandos abaixo só imprimirão “command not found”.",
    ],
  },
};

// selfHostInstall is a variant for the self-host guide, whose body is server /
// Docker setup and whose one CLI step ("point the CLI at your server") runs on
// the reader's own machine. The generic "everything below is the CLI" framing
// doesn't fit there, so this one is scoped to that single step.
export const selfHostInstall = {
  en: {
    heading: "Install the CLI on your machine",
    body: [
      "This last step runs the relayium CLI on your own computer (not the server), so install it there if you haven't. On macOS or Linux:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli lists every install option — a Windows binary, the releases page, or go build if you have Go.",
      "relayium --version confirms it. Without the CLI, the command below prints 'command not found'.",
    ],
  },
  zh: {
    heading: "在你自己的机器上装 CLI",
    body: [
      "最后这一步是在你自己的电脑上运行 relayium CLI（不是服务器），所以没装的话先在本机装上。macOS 或 Linux：",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli 列出了所有安装方式——Windows 二进制、发布页，或装了 Go 用 go build。",
      "relayium --version 可确认。没装 CLI，下面的命令只会报 “command not found”。",
    ],
  },
  ja: {
    heading: "自分のマシンに CLI をインストール",
    body: [
      "この最後の手順はサーバーではなく自分のコンピュータで relayium CLI を実行します。未インストールならまず入れてください。macOS または Linux：",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli にすべてのインストール方法があります——Windows バイナリ、リリースページ、または Go があれば go build。",
      "relayium --version で確認できます。CLI がないと下のコマンドは「command not found」と出るだけです。",
    ],
  },
  ko: {
    heading: "내 컴퓨터에 CLI 설치",
    body: [
      "이 마지막 단계는 서버가 아니라 내 컴퓨터에서 relayium CLI를 실행합니다. 설치하지 않았다면 먼저 설치하세요. macOS나 Linux:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli 에 모든 설치 방법이 있습니다 — Windows 바이너리, 릴리스 페이지, 또는 Go가 있으면 go build.",
      "relayium --version 으로 확인합니다. CLI가 없으면 아래 명령은 “command not found”만 출력합니다.",
    ],
  },
  de: {
    heading: "Installiere die CLI auf deinem Rechner",
    body: [
      "Dieser letzte Schritt führt die relayium-CLI auf deinem eigenen Rechner aus (nicht auf dem Server), installiere sie dort also, falls noch nicht geschehen. Unter macOS oder Linux:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli listet alle Installationswege — ein Windows-Binary, die Releases-Seite oder go build, wenn du Go hast.",
      "relayium --version bestätigt es. Ohne die CLI gibt der Befehl unten nur „command not found“ aus.",
    ],
  },
  fr: {
    heading: "Installez la CLI sur votre machine",
    body: [
      "Cette dernière étape exécute la CLI relayium sur votre propre ordinateur (pas le serveur), alors installez-la là si ce n'est pas fait. Sous macOS ou Linux :",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli liste toutes les options — un binaire Windows, la page des releases, ou go build si vous avez Go.",
      "relayium --version le confirme. Sans la CLI, la commande ci-dessous affiche « command not found ».",
    ],
  },
  ar: {
    heading: "ثبّت CLI على جهازك",
    body: [
      "تُشغّل هذه الخطوة الأخيرة relayium CLI على حاسوبك أنت (لا على الخادم)، فثبّته هناك إن لم تكن قد فعلت. على macOS أو Linux:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "يسرد relayium.com/cli كل خيارات التثبيت — ملف ثنائي لـ Windows، أو صفحة الإصدارات، أو go build إن كان لديك Go.",
      "يؤكّده relayium --version. بلا CLI، سيطبع الأمر أدناه ‘command not found’.",
    ],
  },
  es: {
    heading: "Instala la CLI en tu máquina",
    body: [
      "Este último paso ejecuta la CLI de relayium en tu propio ordenador (no en el servidor), así que instálala ahí si aún no la tienes. En macOS o Linux:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli lista todas las opciones de instalación — un binario de Windows, la página de releases, o go build si tienes Go.",
      "relayium --version lo confirma. Sin la CLI, el comando de abajo imprime « command not found ».",
    ],
  },
  pt: {
    heading: "Instale a CLI na sua máquina",
    body: [
      "Este último passo roda a CLI do relayium no seu próprio computador (não no servidor), então instale-a ali se ainda não tiver. No macOS ou Linux:",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "relayium.com/cli lista todas as opções de instalação — um binário para Windows, a página de releases, ou go build se você tiver Go.",
      "relayium --version confirma. Sem a CLI, o comando abaixo imprime “command not found”.",
    ],
  },
};

// withInstall returns a copy of a guide's `langs` map with an install section
// inserted just before the first section that shows a `relayium` command (in a
// code block). Task guides that open with a command get it at the very top;
// comparison articles keep their intro first and get it right before the first
// command demo. Pass `snippet` to use a variant (e.g. selfHostInstall). Inputs
// are not mutated.
export function withInstall(langs, snippet = installSection) {
  const out = {};
  for (const [l, doc] of Object.entries(langs)) {
    const sections = doc.sections || [];
    // Every command block a section can hold, not just `section.code`. A tutorial
    // section keeps its commands inside its numbered steps (and its expected
    // output inside `success`), so a `code`-only scan would miss the first
    // `relayium` command on exactly the guides that lead with a procedure, and
    // drop the install step below it — after the command it exists to precede.
    const codeBlocks = (s) => [
      ...(s.code || []),
      ...(s.steps || []).flatMap((step) => step.code || []),
      ...(s.success?.code || []),
      ...(s.troubleshooting?.items || []).flatMap((i) => i.code || []),
    ];
    const hasCmd = (s) => codeBlocks(s).some((block) => block.includes("relayium "));
    let i = sections.findIndex(hasCmd);
    if (i < 0) i = 0;
    const snip = snippet[l] || snippet.en;
    out[l] = {
      ...doc,
      sections: [...sections.slice(0, i), snip, ...sections.slice(i)],
    };
  }
  return out;
}

export default installSection;
