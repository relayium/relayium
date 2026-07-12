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
      "Tout ci-dessous passe par la CLI relayium, alors installez-la d'abord si ce n'est pas fait. Sous macOS ou Linux, une commande place un binaire précompilé dans votre PATH :",
    ],
    code: ["curl -fsSL https://relayium.com/install.sh | sh"],
    bullets: [
      "Vous préférez choisir le fichier vous-même, ou sous Windows ? Récupérez un binaire depuis la page des releases — relayium.com/cli liste toutes les options (avec Go, go build -o relayium ./cmd/relayium).",
      "relayium --version confirme l'installation. Sans cela, les commandes ci-dessous affichent seulement « command not found ».",
    ],
  },
};

// withInstall returns a copy of a guide's `langs` map with the install section
// inserted just before the first section that shows a `relayium` command (in a
// code block). Task guides that open with a command get it at the very top;
// comparison articles keep their intro first and get it right before the first
// command demo. Inputs are not mutated.
export function withInstall(langs) {
  const out = {};
  for (const [l, doc] of Object.entries(langs)) {
    const sections = doc.sections || [];
    const hasCmd = (s) => (s.code || []).some((block) => block.includes("relayium "));
    let i = sections.findIndex(hasCmd);
    if (i < 0) i = 0;
    const snippet = installSection[l] || installSection.en;
    out[l] = {
      ...doc,
      sections: [...sections.slice(0, i), snippet, ...sections.slice(i)],
    };
  }
  return out;
}

export default installSection;
