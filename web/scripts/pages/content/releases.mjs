// web/scripts/pages/content/releases.mjs — the public release history at
// /releases/, in nine languages.
//
// ── Why this page exists, and why it is shaped like this ────────────────────
// The site had no changelog and no page a reader could use to answer "is this
// project alive, and can I check what I downloaded?" — the two questions a
// trust asset is for.
//
// The hard part was the SOURCE OF TRUTH, not the markup. Three options were
// rejected before this one:
//
//   * Per-release prose in nine locales. 22 versions today, roughly one a week
//     from here — the translation load grows forever, and the first week nobody
//     writes it the page starts lying by omission.
//   * A build-time read of `git tag`. CI checks out shallow with no tags
//     (.github/workflows/web.yml), and so does any tarball, so the list would
//     render EMPTY in exactly the environment that publishes it.
//   * Fetching api.github.com from the reader's browser. A third-party request
//     from the one page that exists to say "we are not doing anything behind
//     your back", plus a 60-request/hour rate limit.
//
// So the list below carries only what needs no translation and cannot go
// stale in a way that misleads: a version and the date it was tagged. Adding a
// release adds one line here and nothing else. If someone forgets, the page is
// INCOMPLETE AT THE TAIL — never wrong — and releases.test.mjs fails the moment
// it runs anywhere the git tags are present, which is any full clone.
//
// The prose deliberately says what a version number does NOT cover. A `v*` tag
// publishes the two binaries goreleaser builds from server/ (.goreleaser.yaml);
// the web app deploys continuously from main and has no version at all. Listing
// "web app" or "macOS" against v0.15.0 would have been the easy, untrue version
// of this page.
//
// The native apps sit outside that list on purpose, and since 2026-08-10 the two
// of them are in DIFFERENT states, which the copy has to carry: the macOS app is
// released publicly under its own tag namespace (currently `macos-v1.2.7`, a
// Developer ID-signed and Apple-notarized DMG attached to that GitHub Release —
// not a Mac App Store listing), while the iOS app is still an engineering build
// that has been released nowhere. "The native apps are engineering builds" was
// one true sentence about two things; it is now false about one of them, and a
// page whose whole purpose is being checkable cannot carry it. See
// releases.test.mjs, which also keeps the `v*` list from being failed by the
// `macos-v*` tag it must not contain.
//
// The version in that sentence is the CURRENT release, not the first one, and it
// moves. `macos-v1.0` sat here — and in all nine locales below — through 1.1,
// 1.1.1, 1.1.2, 1.1.3 and 1.2.1, telling every reader to fetch a tag five
// releases behind the DMG the site was actually offering. The claim is not
// derivable at render time (this module is plain data, and the copy is
// translated prose), so releases.test.mjs ties the two maintained locales — en
// and zh — to the version in web/native-releases.json, the same manifest /apps
// and the Device Inbox badge resolve against, and rejects any superseded tag
// left behind in them. The other seven locales are frozen archives: their copy
// keeps the tag it was published with and is not moved release by release, so
// only en and zh below change when a new macOS version ships.

/**
 * Every published version, newest first: the tag and the date it was created.
 *
 * Keep in sync with `git tag`, which is the real source of truth —
 * releases.test.mjs enforces exactly that wherever the tags are available.
 * Dates are ISO-8601 and are rendered as-is in every locale: a bare
 * 2026-08-03 needs no translation and cannot be read as 2026-03-08.
 */
export const RELEASES = [
  { version: "v0.20.0", date: "2026-08-17" },
  { version: "v0.19.1", date: "2026-08-12" },
  { version: "v0.19.0", date: "2026-08-12" },
  { version: "v0.18.0", date: "2026-08-09" },
  { version: "v0.17.0", date: "2026-08-09" },
  { version: "v0.16.0", date: "2026-08-09" },
  { version: "v0.15.0", date: "2026-08-03" },
  { version: "v0.14.0", date: "2026-08-02" },
  { version: "v0.13.0", date: "2026-08-01" },
  { version: "v0.12.0", date: "2026-07-30" },
  { version: "v0.11.1", date: "2026-07-28" },
  { version: "v0.11.0", date: "2026-07-28" },
  { version: "v0.10.2", date: "2026-07-23" },
  { version: "v0.10.1", date: "2026-07-23" },
  { version: "v0.10.0", date: "2026-07-23" },
  { version: "v0.9.0", date: "2026-07-22" },
  { version: "v0.8.1", date: "2026-07-22" },
  { version: "v0.8.0", date: "2026-07-22" },
  { version: "v0.7.0", date: "2026-07-13" },
  { version: "v0.6.0", date: "2026-07-13" },
  { version: "v0.5.0", date: "2026-07-13" },
  { version: "v0.4.0", date: "2026-07-13" },
  { version: "v0.3.1", date: "2026-07-13" },
  { version: "v0.3.0", date: "2026-07-13" },
  { version: "v0.2.0", date: "2026-07-08" },
  { version: "v0.1.2", date: "2026-07-08" },
  { version: "v0.1.1", date: "2026-07-08" },
  { version: "v0.1.0", date: "2026-07-08" },
];

const en = {
  // Not "Changelog": the page links each version's commit-level notes rather
  // than restating them, and calling it a changelog would promise prose that is
  // deliberately not here.
  title: "Releases",
  description:
    "Every published Relayium version, the date it shipped and its full notes — plus what a version number covers, how a release is cut, and how to check what you downloaded.",
  updatedLabel: "Last updated",
  otherDocLabel: "Privacy Policy",
  lead: [
    "Relayium ships in three rhythms, and this page is honest about all three: the web app is deployed continuously, the command-line tools are numbered and tagged, and the native apps are released on their own — macOS 1.2.7 is a signed download from GitHub, while the iOS app is still an engineering build that has not been released publicly.",
    "Every version below was tagged automatically from the main branch, and only after the checks on that exact commit passed. A version's complete notes — every commit it contains — are one click away on GitHub.",
  ],
  sections: [
    {
      heading: "What a version number covers",
      body: [
        "A version tag publishes two programs: the relayium command-line tool, and relayium-node, the relay and storage node that self-hosters run. Both are built from the same source tree, so a version exists only when that tree changed.",
      ],
      bullets: [
        "The web app has no version number. It is deployed from the main branch as soon as its checks pass, so what you use in a browser is usually newer than the newest version listed here.",
        "The macOS app is released under its own tag, macos-v1.2.7: a Developer ID-signed, Apple-notarized direct download from GitHub, not a Mac App Store listing. No version below ships it. The iOS app is an engineering build and has not been released publicly.",
        "A node does not follow this list by itself: it asks the server it belongs to which version to run, so a new version changes nothing until someone starts a rollout. The command-line tool updates with relayium update.",
      ],
    },
    {
      heading: "How a release is cut",
      body: [
        "Releases run on a schedule rather than on someone remembering. Once a week a workflow looks at what has landed since the last version, and stops without tagging in two cases: when the code that actually gets published has not changed, and when the checks on that commit are not green.",
      ],
      bullets: [
        "Both stops are deliberate. Relying on memory once left a finished feature unreleased for months, and tagging an unverified commit would ship exactly the breakage a schedule is meant to prevent.",
        "Weeks that change only documentation or the apps produce no version, because the published programs would be byte-for-byte the previous ones.",
      ],
    },
    {
      heading: "Checking what you downloaded",
      body: [
        "Every release publishes a checksum file next to the archives, and a signature over that file. The updater verifies both before it installs anything, against a public key compiled into the program — so a tampered archive fails on your machine, rather than depending on whether we noticed on ours.",
      ],
      bullets: [
        "For networks that cannot reach GitHub, Relayium also mirrors its own release files. Where the bytes come from is a question of reachability, not of trust: the verification is identical either way.",
        "The source is public. The server, the node and the web app are AGPL-3.0, the native apps Apache-2.0, and the documentation CC BY 4.0.",
      ],
    },
  ],
  releasesHeading: "Every published version",
  releasesNote: "Newest first. Each version links to its full notes and downloads on GitHub.",
};

const zh = {
  title: "版本发布记录",
  description:
    "Relayium 每一个已发布版本、发布日期和完整更新说明——还有版本号覆盖什么、一次发布是怎么切出来的，以及怎么校验你下载到的文件。",
  updatedLabel: "最后更新",
  otherDocLabel: "隐私政策",
  lead: [
    "Relayium 有三种发布节奏，这一页对三种都如实说明：网页版持续部署，命令行工具带版本号打标签发布，原生应用则各自单独发布——macOS 1.2.7 已可从 GitHub 下载，iOS 应用仍是开发版，尚未公开发布。",
    "下面每一个版本都是从 main 分支自动打标签的，而且只在该提交的检查全部通过之后才发布。某个版本的完整说明——它包含的每一条提交——在 GitHub 上一点即达。",
  ],
  sections: [
    {
      heading: "版本号覆盖什么",
      body: [
        "一个版本标签发布两个程序：relayium 命令行工具，以及自托管者运行的中继与存储节点 relayium-node。两者由同一份源码构建，所以只有这份源码有改动时才会切出新版本。",
      ],
      bullets: [
        "网页版没有版本号。它在检查通过后就从 main 分支部署，所以你在浏览器里用到的，通常比这里最新的版本还要新。",
        "macOS 应用用自己的标签 macos-v1.2.7 单独发布：这是一份经过 Developer ID 签名、通过 Apple 公证、直接从 GitHub 下载的安装包，不是 Mac App Store 上架版本。下面任何一个版本都不包含它。iOS 应用仍是开发版，尚未公开发布。",
        "节点不会自己跟着这个列表走：它会向所属的服务器询问该运行哪个版本，所以在有人发起灰度更新之前，新版本什么也不会改变。命令行工具用 relayium update 更新。",
      ],
    },
    {
      heading: "一次发布是怎么切出来的",
      body: [
        "发布按排期进行，不靠谁记得。每周有一个工作流检查上个版本之后合并了什么，并在两种情况下停下、不打标签：真正会被发布的代码没有改动，以及该提交的检查没有全绿。",
      ],
      bullets: [
        "这两个停止条件都刻意如此。靠记性的结果，是一个早就写完的功能被搁置了好几个月没发布；而给一个没验证过的提交打标签，恰恰会发出排期本来要挡住的故障。",
        "只改了文档或应用的那几周不会产生新版本，因为发布出来的程序会和上一版逐字节相同。",
      ],
    },
    {
      heading: "怎么校验你下载到的文件",
      body: [
        "每次发布都会在压缩包旁边附上校验和文件，以及对该文件的签名。更新程序在安装任何东西之前会用编译进程序里的公钥同时校验这两者——所以被篡改的压缩包会在你的机器上校验失败，而不是取决于我们这边有没有注意到。",
      ],
      bullets: [
        "为了访问不到 GitHub 的网络，Relayium 也镜像了自己的发布文件。字节从哪里来是可达性问题，不是信任问题：两条路径上的校验完全一样。",
        "源码是公开的。服务器、节点与网页版采用 AGPL-3.0，原生应用采用 Apache-2.0，文档采用 CC BY 4.0。",
      ],
    },
  ],
  releasesHeading: "全部已发布版本",
  releasesNote: "从新到旧。每个版本都链接到 GitHub 上的完整说明与下载。",
};

const ja = {
  title: "リリース",
  description:
    "公開済みの Relayium の全バージョンと、その日付、完全な変更履歴。あわせて、バージョン番号が何を指すのか、リリースがどう切られるのか、ダウンロードしたものをどう確認するのかも説明します。",
  updatedLabel: "最終更新",
  otherDocLabel: "プライバシーポリシー",
  lead: [
    "Relayium のリリースには3つのリズムがあり、このページはその3つすべてを正直に書いています。ウェブアプリは継続的にデプロイされ、コマンドラインツールは番号を付けてリリースされ、ネイティブアプリはそれぞれ独自にリリースされます。macOS 1.2.3 は署名済みのダウンロードとして GitHub で公開されており、iOS アプリはまだ公開されていない開発ビルドです。",
    "以下のバージョンはすべて main ブランチから自動でタグ付けされたもので、そのコミットのチェックが通ったときにだけ公開されます。各バージョンの完全な変更履歴——含まれるすべてのコミット——は GitHub でワンクリックで読めます。",
  ],
  sections: [
    {
      heading: "バージョン番号が指す範囲",
      body: [
        "1つのバージョンタグが公開するのは2つのプログラムです。relayium コマンドラインツールと、セルフホストで動かすリレー兼ストレージノードの relayium-node です。どちらも同じソースツリーからビルドされるため、そのツリーに変更があったときにだけ新しいバージョンが生まれます。",
      ],
      bullets: [
        "ウェブアプリにバージョン番号はありません。チェックが通り次第 main ブランチからデプロイされるので、ブラウザで使っているものは、たいていここに並ぶ最新バージョンより新しいです。",
        "macOS アプリは macos-v1.2.3 という独自のタグで別にリリースされます。Developer ID で署名し Apple の公証を通した、GitHub からの直接ダウンロードで、Mac App Store 版ではありません。以下のどのバージョンにも含まれていません。iOS アプリは開発ビルドであり、まだ公開されていません。",
        "ノードはこの一覧を自分で追いかけません。所属するサーバーにどのバージョンを動かすか尋ねるため、誰かがロールアウトを始めるまで新しいバージョンは何も変えません。コマンドラインツールは relayium update で更新します。",
      ],
    },
    {
      heading: "リリースの切り方",
      body: [
        "リリースは誰かが思い出すのではなく、スケジュールで行われます。週に1度、ワークフローが前のバージョン以降に入った変更を確認し、次の2つの場合はタグを付けずに止まります。実際に公開されるコードに変更がない場合と、そのコミットのチェックが緑でない場合です。",
      ],
      bullets: [
        "どちらも設計上の判断です。記憶に頼った結果、完成していた機能が数か月リリースされないままになりました。検証されていないコミットにタグを付ければ、スケジュールが防ごうとしている障害をそのまま出荷することになります。",
        "ドキュメントやアプリだけを変更した週には新しいバージョンは生まれません。公開されるプログラムが前回とバイト単位で同一になるからです。",
      ],
    },
    {
      heading: "ダウンロードしたものを確認する",
      body: [
        "リリースごとに、アーカイブと並べてチェックサムファイルと、そのファイルへの署名が公開されます。アップデーターはインストール前に、プログラムに埋め込まれた公開鍵で両方を検証します。改ざんされたアーカイブは、当社が気づいたかどうかに関係なく、手元のマシンで検証に失敗します。",
      ],
      bullets: [
        "GitHub に到達できないネットワークのために、Relayium は自前のリリースファイルをミラーしています。バイトがどこから来るかは到達性の問題であって、信頼の問題ではありません。検証はどちらの経路でも同一です。",
        "ソースコードは公開されています。サーバー、ノード、ウェブアプリは AGPL-3.0、ネイティブアプリは Apache-2.0、ドキュメントは CC BY 4.0 です。",
      ],
    },
  ],
  releasesHeading: "公開済みの全バージョン",
  releasesNote: "新しい順です。各バージョンから GitHub の完全な変更履歴とダウンロードに移動できます。",
};

const ko = {
  title: "릴리스",
  description:
    "공개된 모든 Relayium 버전과 배포 날짜, 각 버전의 전체 변경 내역. 버전 번호가 무엇을 포함하는지, 릴리스가 어떻게 만들어지는지, 내려받은 파일을 어떻게 확인하는지도 함께 정리했습니다.",
  updatedLabel: "마지막 업데이트",
  otherDocLabel: "개인정보처리방침",
  lead: [
    "Relayium은 세 가지 리듬으로 배포되며, 이 페이지는 셋 모두를 있는 그대로 밝힙니다. 웹 앱은 계속 배포되고, 명령줄 도구는 번호를 붙여 릴리스하며, 네이티브 앱은 각자 따로 릴리스합니다. macOS 1.2.3은 서명된 다운로드로 GitHub에 공개되어 있고, iOS 앱은 아직 공개되지 않은 개발 빌드입니다.",
    "아래 모든 버전은 main 브랜치에서 자동으로 태그되었고, 해당 커밋의 검사가 통과한 뒤에만 공개되었습니다. 각 버전의 전체 변경 내역——포함된 모든 커밋——은 GitHub에서 한 번의 클릭으로 볼 수 있습니다.",
  ],
  sections: [
    {
      heading: "버전 번호가 포함하는 것",
      body: [
        "버전 태그 하나가 공개하는 프로그램은 둘입니다. relayium 명령줄 도구와, 자체 호스팅으로 운영하는 릴레이 겸 스토리지 노드인 relayium-node입니다. 둘 다 같은 소스 트리에서 빌드되므로, 그 트리가 바뀐 경우에만 새 버전이 생깁니다.",
      ],
      bullets: [
        "웹 앱에는 버전 번호가 없습니다. 검사가 통과하는 대로 main 브랜치에서 배포되므로, 브라우저에서 쓰는 것은 대개 여기 있는 최신 버전보다 새롭습니다.",
        "macOS 앱은 macos-v1.2.3이라는 자체 태그로 따로 릴리스합니다. Developer ID로 서명하고 Apple 공증을 마친 GitHub 직접 다운로드이며, Mac App Store 등록이 아닙니다. 아래 어떤 버전에도 포함되어 있지 않습니다. iOS 앱은 개발 빌드이며 아직 공개 릴리스가 아닙니다.",
        "노드는 이 목록을 스스로 따라가지 않습니다. 소속된 서버에 어떤 버전을 실행할지 물어보므로, 누군가 롤아웃을 시작하기 전까지 새 버전은 아무것도 바꾸지 않습니다. 명령줄 도구는 relayium update로 업데이트합니다.",
      ],
    },
    {
      heading: "릴리스를 만드는 방식",
      body: [
        "릴리스는 누가 기억해서가 아니라 일정에 따라 이루어집니다. 매주 한 번 워크플로가 지난 버전 이후 반영된 변경을 확인하고, 두 경우에는 태그 없이 멈춥니다. 실제로 공개되는 코드가 바뀌지 않았을 때, 그리고 그 커밋의 검사가 통과하지 않았을 때입니다.",
      ],
      bullets: [
        "둘 다 설계상 의도한 것입니다. 기억에 맡긴 탓에 이미 완성된 기능이 몇 달 동안 배포되지 못한 적이 있고, 검증되지 않은 커밋에 태그를 붙이면 일정이 막으려던 장애를 그대로 내보내게 됩니다.",
        "문서나 앱만 바뀐 주에는 새 버전이 나오지 않습니다. 공개되는 프로그램이 직전 버전과 바이트 단위로 같기 때문입니다.",
      ],
    },
    {
      heading: "내려받은 파일 확인하기",
      body: [
        "릴리스마다 아카이브 옆에 체크섬 파일과 그 파일에 대한 서명이 함께 공개됩니다. 업데이터는 무엇이든 설치하기 전에, 프로그램에 내장된 공개 키로 둘 다 검증합니다. 그래서 변조된 아카이브는 Relayium이 알아챘는지와 무관하게, 쓰고 있는 컴퓨터에서 검증에 실패합니다.",
      ],
      bullets: [
        "GitHub에 접속할 수 없는 네트워크를 위해 Relayium은 자체 릴리스 파일도 미러링합니다. 바이트가 어디에서 오는지는 도달성의 문제이지 신뢰의 문제가 아닙니다. 검증은 어느 경로에서나 동일합니다.",
        "소스 코드는 공개되어 있습니다. 서버와 노드, 웹 앱은 AGPL-3.0, 네이티브 앱은 Apache-2.0, 문서는 CC BY 4.0입니다.",
      ],
    },
  ],
  releasesHeading: "공개된 모든 버전",
  releasesNote: "최신순입니다. 각 버전에서 GitHub의 전체 변경 내역과 다운로드로 이동합니다.",
};

const de = {
  // Not "Releases": the English title is that word, and two indexable URLs
  // sharing one title is what site-graph.test.mjs fails on.
  title: "Versionen",
  description:
    "Jede veröffentlichte Relayium-Version mit ihrem Datum und ihren vollständigen Änderungen — dazu, was eine Versionsnummer abdeckt, wie eine Veröffentlichung entsteht und wie du prüfst, was du heruntergeladen hast.",
  updatedLabel: "Zuletzt aktualisiert",
  otherDocLabel: "Datenschutzerklärung",
  lead: [
    "Relayium erscheint in drei Rhythmen, und diese Seite benennt alle drei ehrlich: Die Web-App wird laufend ausgeliefert, die Kommandozeilenwerkzeuge bekommen Nummern und Tags, und die nativen Apps werden eigenständig veröffentlicht — macOS 1.2.3 gibt es als signierten Download bei GitHub, während die iOS-App weiterhin ein Entwicklungs-Build ist, der noch nicht öffentlich veröffentlicht wurde.",
    "Jede Version unten wurde automatisch aus dem main-Branch getaggt, und nur dann, wenn die Prüfungen auf genau diesem Commit grün waren. Die vollständigen Änderungen einer Version — jeder enthaltene Commit — sind auf GitHub einen Klick entfernt.",
  ],
  sections: [
    {
      heading: "Was eine Versionsnummer abdeckt",
      body: [
        "Ein Versions-Tag veröffentlicht zwei Programme: die CLI relayium und relayium-node, den Relay- und Speicher-Node für alle, die selbst hosten. Beide werden aus demselben Quellbaum gebaut — eine Version entsteht deshalb nur, wenn sich dieser Baum geändert hat.",
      ],
      bullets: [
        "Die Web-App hat keine Versionsnummer. Ausgeliefert wird aus dem main-Branch, sobald ihre Prüfungen grün sind — was du im Browser benutzt, ist also meist neuer als die neueste Version in dieser Liste.",
        "Die macOS-App wird unter einem eigenen Tag veröffentlicht, macos-v1.2.3: ein mit Developer ID signierter, von Apple notarisierter Direkt-Download bei GitHub, kein Mac-App-Store-Eintrag. Keine der Versionen unten enthält sie. Die iOS-App ist ein Entwicklungs-Build und wurde nicht öffentlich veröffentlicht.",
        "Ein Node folgt dieser Liste nicht von selbst: Er fragt den Server, zu dem er gehört, welche Version er ausführen soll. Eine neue Version ändert also nichts, bis jemand einen Rollout startet. Die CLI aktualisierst du mit relayium update.",
      ],
    },
    {
      heading: "Wie eine Veröffentlichung entsteht",
      body: [
        "Veröffentlicht wird nach Plan, nicht aus Erinnerung. Einmal pro Woche sieht ein Workflow nach, was seit der letzten Version dazugekommen ist, und hört in zwei Fällen ohne Tag auf: wenn sich am Code, der tatsächlich veröffentlicht wird, nichts geändert hat, und wenn die Prüfungen auf diesem Commit nicht grün sind.",
      ],
      bullets: [
        "Beides ist von Grund auf so gewollt. Auf Erinnerung zu bauen hat schon einmal dazu geführt, dass ein fertiges Feature monatelang unveröffentlicht lag; und einen ungeprüften Commit zu taggen würde genau den Ausfall ausliefern, den der Plan verhindern soll.",
        "Wochen, in denen sich nur Dokumentation oder die Apps ändern, ergeben keine Version — die veröffentlichten Programme wären Byte für Byte die vorherigen.",
      ],
    },
    {
      heading: "Prüfen, was du heruntergeladen hast",
      body: [
        "Jede Veröffentlichung legt neben die Archive eine Prüfsummendatei und eine Signatur über diese Datei. Der Updater prüft beides, bevor er irgendetwas installiert, gegen einen ins Programm einkompilierten öffentlichen Schlüssel — ein manipuliertes Archiv scheitert damit auf deinem Rechner und hängt nicht daran, ob wir es auf unserem bemerkt haben.",
      ],
      bullets: [
        "Für Netzwerke, die GitHub nicht erreichen, spiegelt Relayium seine eigenen Release-Dateien. Woher die Bytes kommen, ist eine Frage der Erreichbarkeit und keine des Vertrauens: Die Prüfung ist auf beiden Wegen dieselbe.",
        "Der Quellcode ist offen. Server, Node und Web-App stehen unter AGPL-3.0, die nativen Apps unter Apache-2.0 und die Dokumentation unter CC BY 4.0.",
      ],
    },
  ],
  releasesHeading: "Alle veröffentlichten Versionen",
  releasesNote: "Neueste zuerst. Jede Version verlinkt ihre vollständigen Änderungen und Downloads auf GitHub.",
};

const fr = {
  title: "Versions",
  description:
    "Toutes les versions publiées de Relayium, leur date et l'intégralité de leurs modifications — avec ce que couvre un numéro de version, comment une publication est produite et comment vérifier ce que vous avez téléchargé.",
  updatedLabel: "Dernière mise à jour",
  otherDocLabel: "Politique de confidentialité",
  lead: [
    "Relayium avance à trois rythmes, et cette page les décrit honnêtement tous les trois : l'application web est déployée en continu, les outils en ligne de commande sont numérotés et publiés, et les applications natives sont publiées séparément — macOS 1.2.3 se télécharge depuis GitHub, signée et notarisée, tandis que l'application iOS reste une version d'ingénierie qui n'est pas diffusée publiquement.",
    "Chaque version ci-dessous a été étiquetée automatiquement depuis la branche main, et seulement après que les vérifications de ce commit précis sont passées. Les modifications complètes d'une version — chacun de ses commits — sont à un clic sur GitHub.",
  ],
  sections: [
    {
      heading: "Ce que couvre un numéro de version",
      body: [
        "Une étiquette de version publie deux programmes : la CLI relayium et relayium-node, le nœud de relais et de stockage que font tourner celles et ceux qui s'auto-hébergent. Les deux sont compilés depuis la même arborescence de sources, si bien qu'une version n'apparaît que lorsque cette arborescence a changé.",
      ],
      bullets: [
        "L'application web n'a pas de numéro de version. Elle est déployée depuis la branche main dès que ses vérifications passent : ce que vous utilisez dans le navigateur est donc généralement plus récent que la dernière version listée ici.",
        "L'application macOS est publiée sous son propre tag, macos-v1.2.3 : un téléchargement direct depuis GitHub, signé Developer ID et notarisé par Apple, et non une fiche sur le Mac App Store. Aucune version ci-dessous ne la contient. L'application iOS reste une version d'ingénierie, non diffusée publiquement.",
        "Un nœud ne suit pas cette liste de lui-même : il demande au serveur auquel il appartient quelle version exécuter, si bien qu'une nouvelle version ne change rien tant que personne n'a lancé de déploiement progressif. La CLI se met à jour avec relayium update.",
      ],
    },
    {
      heading: "Comment une publication est produite",
      body: [
        "Les publications suivent un calendrier plutôt que la mémoire de quelqu'un. Une fois par semaine, un workflow regarde ce qui est arrivé depuis la version précédente et s'arrête sans étiqueter dans deux cas : quand le code réellement publié n'a pas changé, et quand les vérifications de ce commit ne sont pas au vert.",
      ],
      bullets: [
        "Les deux arrêts sont voulus. S'en remettre à la mémoire a déjà laissé une fonctionnalité terminée non publiée pendant des mois ; et étiqueter un commit non vérifié reviendrait à diffuser précisément la panne que le calendrier doit éviter.",
        "Les semaines où seules la documentation ou les applications changent ne produisent aucune version : les programmes publiés seraient identiques octet pour octet aux précédents.",
      ],
    },
    {
      heading: "Vérifier ce que vous avez téléchargé",
      body: [
        "Chaque publication place à côté des archives un fichier de sommes de contrôle et une signature de ce fichier. Le programme de mise à jour vérifie les deux avant d'installer quoi que ce soit, avec une clé publique compilée dans le binaire : une archive altérée échoue donc sur votre machine, sans dépendre de ce que nous aurions remarqué de notre côté.",
      ],
      bullets: [
        "Pour les réseaux qui n'atteignent pas GitHub, Relayium met aussi en miroir ses propres fichiers de publication. D'où viennent les octets est une question d'accessibilité, pas de confiance : la vérification est identique dans les deux cas.",
        "Le code source est ouvert. Le serveur, le nœud et l'application web sont sous AGPL-3.0, les applications natives sous Apache-2.0 et la documentation sous CC BY 4.0.",
      ],
    },
  ],
  releasesHeading: "Toutes les versions publiées",
  releasesNote: "De la plus récente à la plus ancienne. Chaque version renvoie à ses modifications complètes et à ses téléchargements sur GitHub.",
};

const ar = {
  title: "الإصدارات",
  description:
    "كل إصدار منشور من Relayium، وتاريخ نشره، وملاحظاته الكاملة — إضافة إلى ما يغطيه رقم الإصدار، وكيف يُقتطع الإصدار، وكيف تتحقق مما نزَّلته.",
  updatedLabel: "آخر تحديث",
  otherDocLabel: "سياسة الخصوصية",
  lead: [
    "يصدر Relayium بثلاثة إيقاعات، وهذه الصفحة تذكرها الثلاثة بصراحة: تطبيق الويب يُنشر باستمرار، وأدوات سطر الأوامر تحمل أرقامًا وعلامات إصدار، والتطبيقات الأصلية تصدر على حدة — إصدار macOS 1.2.3 متاح للتنزيل موقّعًا من GitHub، أما تطبيق iOS فما يزال نسخة تطوير لم تُنشر للعموم بعد.",
    "كل إصدار في الأسفل وُسم تلقائيًا من فرع main، وبعد اجتياز فحوص ذلك الالتزام بالتحديد فقط. أما ملاحظات الإصدار الكاملة — كل التزام يحتويه — فهي على بعد نقرة واحدة على GitHub.",
  ],
  sections: [
    {
      heading: "ما يغطيه رقم الإصدار",
      body: [
        "علامة الإصدار الواحدة تنشر برنامجين: أداة سطر الأوامر relayium، وrelayium-node وهو عقدة المُرحِّل والتخزين التي يشغلها من يعتمدون الاستضافة الذاتية. كلاهما يُبنى من شجرة المصدر نفسها، فلا يوجد إصدار جديد إلا إذا تغيرت تلك الشجرة.",
      ],
      bullets: [
        "تطبيق الويب ليس له رقم إصدار. يُنشر من فرع main حالما تجتاز فحوصه، فما تستخدمه في المتصفح يكون عادة أحدث من أحدث إصدار مذكور هنا.",
        "تطبيق macOS يصدر بعلامته الخاصة macos-v1.2.3: تنزيل مباشر من GitHub موقّع بـ Developer ID وموثّق من Apple، وليس إدراجًا في Mac App Store. ولا يتضمنه أي إصدار في الأسفل. أما تطبيق iOS فنسخة تطوير لم تُنشر للعموم.",
        "العقدة لا تتبع هذه القائمة من تلقاء نفسها: تسأل الخادم الذي تنتمي إليه أي إصدار تشغّل، فلا يغير الإصدار الجديد شيئًا حتى يبدأ أحدهم طرحًا تدريجيًا. أما أداة سطر الأوامر فتُحدَّث بالأمر relayium update.",
      ],
    },
    {
      heading: "كيف يُقتطع الإصدار",
      body: [
        "الإصدارات تجري وفق جدول زمني لا بالاعتماد على تذكُّر أحدهم. مرة كل أسبوع ينظر سير عمل فيما وصل منذ الإصدار السابق، ويتوقف دون وسم في حالتين: حين لا يتغير الكود الذي يُنشر فعلًا، وحين لا تكون فحوص ذلك الالتزام خضراء.",
      ],
      bullets: [
        "كلا التوقفين مقصود بحكم التصميم. الاعتماد على الذاكرة ترك ذات مرة ميزة مكتملة دون نشر شهورًا، ووسم التزام غير مُتحقَّق منه يعني شحن العطل نفسه الذي وُضع الجدول لمنعه.",
        "الأسابيع التي لا يتغير فيها سوى التوثيق أو التطبيقات لا تنتج إصدارًا، لأن البرامج المنشورة ستكون مطابقة بايتًا ببايت لسابقتها.",
      ],
    },
    {
      heading: "التحقق مما نزَّلته",
      body: [
        "كل إصدار ينشر إلى جانب الأرشيفات ملف مجاميع تحقق وتوقيعًا على ذلك الملف. ويتحقق المُحدِّث من الاثنين قبل تثبيت أي شيء، مقابل مفتاح عام مُضمَّن داخل البرنامج — فالأرشيف المُتلاعب به يفشل على جهازك أنت، لا أن يتوقف الأمر على ما إذا كنا قد لاحظناه عندنا.",
      ],
      bullets: [
        "من أجل الشبكات التي لا تصل إلى GitHub، يعكس Relayium ملفات إصداراته أيضًا. ومن أين تأتي البايتات مسألة إمكانية وصول لا مسألة ثقة: التحقق واحد في الحالتين.",
        "الشيفرة المصدرية علنية. الخادم والعقدة وتطبيق الويب تحت AGPL-3.0، والتطبيقات الأصلية تحت Apache-2.0، والتوثيق تحت CC BY 4.0.",
      ],
    },
  ],
  releasesHeading: "كل الإصدارات المنشورة",
  releasesNote: "الأحدث أولًا. كل إصدار يقود إلى ملاحظاته الكاملة وملفات تنزيله على GitHub.",
};

const es = {
  title: "Versiones",
  description:
    "Todas las versiones publicadas de Relayium, la fecha en que salieron y sus notas completas — además de qué cubre un número de versión, cómo se corta una publicación y cómo comprobar lo que has descargado.",
  updatedLabel: "Última actualización",
  otherDocLabel: "Política de privacidad",
  lead: [
    "Relayium avanza a tres ritmos, y esta página los cuenta los tres con honestidad: la aplicación web se despliega de forma continua, las herramientas de línea de comandos llevan número y etiqueta, y las aplicaciones nativas se publican por su cuenta: macOS 1.2.3 ya se descarga firmada desde GitHub, mientras que la aplicación de iOS sigue siendo una compilación de ingeniería que aún no se ha publicado.",
    "Todas las versiones de abajo se etiquetaron automáticamente desde la rama main, y solo después de que pasaran las comprobaciones de ese commit exacto. Las notas completas de una versión — cada commit que contiene — están a un clic en GitHub.",
  ],
  sections: [
    {
      heading: "Qué cubre un número de versión",
      body: [
        "Una etiqueta de versión publica dos programas: la CLI relayium y relayium-node, el nodo de retransmisión y almacenamiento que ejecuta quien se autoaloja. Ambos se compilan desde el mismo árbol de fuentes, así que solo hay versión nueva cuando ese árbol ha cambiado.",
      ],
      bullets: [
        "La aplicación web no tiene número de versión. Se despliega desde la rama main en cuanto pasan sus comprobaciones, así que lo que usas en el navegador suele ser más reciente que la última versión de esta lista.",
        "La aplicación de macOS se publica con su propia etiqueta, macos-v1.2.3: una descarga directa desde GitHub, firmada con Developer ID y notarizada por Apple, no una ficha en la Mac App Store. Ninguna versión de abajo la incluye. La aplicación de iOS es una compilación de ingeniería y no se ha publicado.",
        "Un nodo no sigue esta lista por su cuenta: le pregunta al servidor al que pertenece qué versión ejecutar, así que una versión nueva no cambia nada hasta que alguien inicia un despliegue gradual. La CLI se actualiza con relayium update.",
      ],
    },
    {
      heading: "Cómo se corta una publicación",
      body: [
        "Las publicaciones siguen un calendario en vez de depender de que alguien se acuerde. Una vez por semana un flujo de trabajo mira qué ha entrado desde la versión anterior y se detiene sin etiquetar en dos casos: cuando el código que de verdad se publica no ha cambiado, y cuando las comprobaciones de ese commit no están en verde.",
      ],
      bullets: [
        "Las dos paradas son deliberadas. Fiarlo a la memoria ya dejó una función terminada sin publicar durante meses, y etiquetar un commit sin verificar sería enviar justo la avería que el calendario existe para evitar.",
        "Las semanas en las que solo cambian la documentación o las aplicaciones no producen versión, porque los programas publicados serían byte a byte los anteriores.",
      ],
    },
    {
      heading: "Comprobar lo que has descargado",
      body: [
        "Cada publicación deja junto a los archivos comprimidos un fichero de sumas de verificación y una firma sobre ese fichero. El actualizador comprueba ambos antes de instalar nada, contra una clave pública compilada dentro del programa: un archivo manipulado falla en tu ordenador, sin depender de si nosotros lo hemos notado en el nuestro.",
      ],
      bullets: [
        "Para las redes que no llegan a GitHub, Relayium también replica sus propios ficheros de publicación. De dónde vienen los bytes es una cuestión de accesibilidad, no de confianza: la verificación es idéntica en ambos casos.",
        "El código fuente es público. El servidor, el nodo y la aplicación web están bajo AGPL-3.0, las aplicaciones nativas bajo Apache-2.0 y la documentación bajo CC BY 4.0.",
      ],
    },
  ],
  releasesHeading: "Todas las versiones publicadas",
  releasesNote: "De más reciente a más antigua. Cada versión enlaza sus notas completas y sus descargas en GitHub.",
};

const pt = {
  title: "Versões",
  description:
    "Todas as versões publicadas do Relayium, a data em que saíram e as notas completas de cada uma — além do que um número de versão cobre, como uma publicação é fechada e como conferir o que você baixou.",
  updatedLabel: "Última atualização",
  otherDocLabel: "Política de Privacidade",
  lead: [
    "O Relayium sai em três ritmos, e esta página conta os três com honestidade: o app web é implantado continuamente, as ferramentas de linha de comando recebem número e tag, e os apps nativos são publicados por conta própria — o macOS 1.2.3 já pode ser baixado assinado no GitHub, enquanto o app de iOS ainda é um build de engenharia que não foi publicado.",
    "Todas as versões abaixo foram marcadas automaticamente a partir do branch main, e só depois que as verificações daquele commit exato passaram. As notas completas de uma versão — cada commit que ela contém — estão a um clique no GitHub.",
  ],
  sections: [
    {
      heading: "O que um número de versão cobre",
      body: [
        "Uma tag de versão publica dois programas: a CLI relayium e o relayium-node, o nó de retransmissão e armazenamento que quem se auto-hospeda executa. Os dois são compilados da mesma árvore de código, então só existe versão nova quando essa árvore muda.",
      ],
      bullets: [
        "O app web não tem número de versão. Ele é implantado a partir do branch main assim que as verificações passam, então o que você usa no navegador costuma ser mais novo do que a versão mais recente desta lista.",
        "O app de macOS é publicado com a própria tag, macos-v1.2.3: um download direto do GitHub, assinado com Developer ID e notarizado pela Apple, e não uma listagem na Mac App Store. Nenhuma versão abaixo o inclui. O app de iOS é um build de engenharia e não foi publicado.",
        "Um nó não segue esta lista sozinho: ele pergunta ao servidor a que pertence qual versão executar, então uma versão nova não muda nada até alguém iniciar uma implantação gradual. A CLI se atualiza com relayium update.",
      ],
    },
    {
      heading: "Como uma publicação é fechada",
      body: [
        "As publicações seguem um calendário em vez de depender de alguém lembrar. Uma vez por semana um fluxo de trabalho olha o que entrou desde a versão anterior e para sem criar tag em dois casos: quando o código que de fato é publicado não mudou, e quando as verificações daquele commit não estão verdes.",
      ],
      bullets: [
        "As duas paradas são propositais. Contar com a memória já deixou um recurso pronto sem publicação por meses, e marcar um commit não verificado seria entregar exatamente a falha que o calendário existe para evitar.",
        "Semanas em que só a documentação ou os apps mudam não geram versão, porque os programas publicados seriam byte a byte os anteriores.",
      ],
    },
    {
      heading: "Conferir o que você baixou",
      body: [
        "Cada publicação coloca ao lado dos arquivos compactados um arquivo de somas de verificação e uma assinatura sobre ele. O atualizador confere os dois antes de instalar qualquer coisa, contra uma chave pública compilada dentro do programa: um arquivo adulterado falha na sua máquina, sem depender de a gente ter percebido na nossa.",
      ],
      bullets: [
        "Para redes que não alcançam o GitHub, o Relayium também espelha os próprios arquivos de publicação. De onde vêm os bytes é uma questão de alcance, não de confiança: a verificação é idêntica nos dois casos.",
        "O código-fonte é público. O servidor, o nó e o app web estão sob AGPL-3.0, os apps nativos sob Apache-2.0 e a documentação sob CC BY 4.0.",
      ],
    },
  ],
  releasesHeading: "Todas as versões publicadas",
  releasesNote: "Da mais recente para a mais antiga. Cada versão leva às suas notas completas e aos downloads no GitHub.",
};

const langs = { en, zh, ja, ko, de, fr, ar, es, pt };
// The page's own "last updated" is the newest release date, computed rather than
// written down. A hand-kept date here would be a second thing to remember and
// the first thing to go stale.
const updated = RELEASES[0].date;

export default {
  slug: "releases",
  updated,
  releases: RELEASES,
  langs: Object.fromEntries(Object.entries(langs).map(([l, doc]) => [l, { ...doc, updated }])),
};
