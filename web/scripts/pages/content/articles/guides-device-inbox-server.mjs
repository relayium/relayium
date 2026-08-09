// Product guide: browser → always-on Linux server through Device Inbox.
// Commands stay identical in every language; prose is localized here so /cli
// never ejects a reader to GitHub or silently changes their language.

const setupCode = `relayium update
relayium login --device-name prod-backup-1

# Download, inspect, then install the always-on service:
curl -fsSLO https://relayium.com/inbox-server-install.sh
less inbox-server-install.sh
sudo sh inbox-server-install.sh --dir /srv/relayium-inbox`;

const checkCode = `sudo systemctl status relayium-inbox.service
sudo journalctl -u relayium-inbox.service -f
sudo -u relayium relayium inbox status --config-dir /var/lib/relayium-inbox/config
ls -la /srv/relayium-inbox`;

const controlCode = `sudo -u relayium relayium inbox pause --config-dir /var/lib/relayium-inbox/config
sudo -u relayium relayium inbox resume --config-dir /var/lib/relayium-inbox/config
sudo -u relayium relayium inbox disable --config-dir /var/lib/relayium-inbox/config`;

function makeDoc(x) {
  return {
    title: x.title,
    description: x.description,
    updatedLabel: x.updatedLabel,
    lead: [x.lead, x.lead2],
    sections: [
      {
        heading: x.setupH,
        body: [x.setupBody],
        code: [setupCode],
        bullets: [x.setupB1, x.setupB2, x.setupB3],
      },
      {
        heading: x.checkH,
        body: [x.checkBody],
        code: [checkCode],
        bullets: [x.checkB1, x.checkB2, x.checkB3],
      },
      {
        heading: x.crashH,
        body: [x.crashBody],
        bullets: [x.crashB1, x.crashB2, x.crashB3, x.crashB4],
      },
      {
        heading: x.controlH,
        body: [x.controlBody],
        code: [controlCode],
        bullets: [x.controlB1, x.controlB2],
      },
    ],
    faq: {
      heading: x.faqH,
      items: [
        { q: x.q1, a: x.a1 },
        { q: x.q2, a: x.a2 },
        { q: x.q3, a: x.a3 },
      ],
    },
    cta: { text: x.cta, button: x.button, href: "/me" },
    relatedHeading: x.related,
  };
}

const en = makeDoc({
  title: "Set up Device Inbox on an always-on Linux server",
  description: "Receive browser-sent files on your own Linux server with Relayium Device Inbox: a low-privilege systemd service, reboot persistence, status, logs and crash behavior.",
  updatedLabel: "Last updated",
  lead: "Device Inbox sends a file from My Devices in your browser to a server, NAS or workstation you own. The browser encrypts it; only that machine decrypts and saves it.",
  lead2: "A server receiver must survive a closed SSH window and a reboot. The recommended installer below creates the folder and installs a real systemd service; inbox run is only the foreground diagnostic/container entrypoint.",
  setupH: "Install the resident receiver",
  setupBody: "Run login once as the operator, then download and inspect the short installer before giving it root access. The script copies the device credential without printing it, creates a dedicated relayium account, enrols its receive key, installs the hardened unit, starts it now and enables it after reboot.",
  setupB1: "The recommended receive directory is /srv/relayium-inbox. The hardened service cannot access /root or another user's home directory.",
  setupB2: "The installer uses a dedicated low-privilege account; received files and the private receive key are not owned by root.",
  setupB3: "If you previously enabled a foreground inbox, its old local state is moved to a timestamped, recoverable archive only after the service starts successfully.",
  checkH: "Check the service, logs and files",
  checkBody: "These four commands distinguish a running process, its recent logs, Relayium's local/server truth and the directory itself. A green systemd state alone is not proof that the account, key and folder are usable.",
  checkB1: "Files land in /srv/relayium-inbox unless you passed a different --dir to the installer.",
  checkB2: "Existing files are never overwritten. Name collisions get a safe numbered name; received content is never opened, executed or extracted.",
  checkB3: "The My Devices row shows the editable label and the last server-observed IP, which may be a NAT or VPN address.",
  crashH: "What happens when the server is offline or crashes",
  crashBody: "The encrypted task waits at Relayium while the server is offline. Uploaded is not shown as saved: saved appears only after authenticated decryption, verification and durable local commit.",
  crashB1: "systemd restarts the worker after a process failure and starts it after reboot.",
  crashB2: "A partial download remains private staging data and is never exposed as a completed file.",
  crashB3: "A durable journal makes a crash after commit idempotent: restart reports the same save without duplicating the file.",
  crashB4: "If the chosen directory disappears later, the worker does not recreate it; this avoids writing beneath a missing mount and reports attention required instead.",
  controlH: "Pause, resume or remove receiving",
  controlBody: "Run administrative inbox commands as the same service account and config directory. pause keeps keys and queued work; resume continues; disable clears central first and deletes private keys only after that succeeds.",
  controlB1: "Do not use inbox run in an SSH window as the permanent server setup; closing the window stops it.",
  controlB2: "Use systemctl disable --now relayium-inbox.service only to stop the process. Use inbox disable when you also intend to revoke the inbox and its keys.",
  faqH: "Frequently asked questions",
  q1: "Does Relayium see file names or plaintext?", a1: "No. The browser encrypts the manifest and file bytes and seals the content key to the selected device. Central stores ciphertext and routing state only.",
  q2: "Why not receive into /root/inbox?", a2: "The recommended service deliberately runs without root and with home-directory access blocked. /srv/relayium-inbox gives it one narrow writable area.",
  q3: "Can I install it manually?", a3: "Yes. relayium inbox service systemd-user or systemd-system prints a machine-specific unit and commands; launchd and container descriptions also exist. The inspected installer is the shorter Linux server path.",
  cta: "Once the service reports ready, send a file from your own device card.", button: "Open My Devices", related: "Continue reading",
});

const zh = makeDoc({
  title: "在常开的 Linux 服务器上设置设备收件箱",
  description: "用 Relayium 设备收件箱把浏览器文件送到自己的 Linux 服务器：低权限 systemd 常驻、开机自启、状态、日志与崩溃恢复。",
  updatedLabel: "最后更新",
  lead: "设备收件箱会把你在浏览器「我的设备」里发送的文件送到自己的服务器、NAS 或工作机。浏览器负责加密，只有目标机器能够解密并写入磁盘。",
  lead2: "服务器接收端必须在 SSH 窗口关闭和重启后继续工作。下面的推荐安装脚本会创建目录并安装真正的 systemd 服务；inbox run 只用于前台排错或容器入口。",
  setupH: "安装常驻接收服务",
  setupBody: "先以管理员身份登录一次，再下载并检查短脚本，确认后才给它 root 权限。脚本不会打印凭据；它会创建独立 relayium 低权限账号、登记接收密钥、安装加固后的 unit、立即启动并设置开机自启。",
  setupB1: "推荐接收目录是 /srv/relayium-inbox。加固服务不能访问 /root 或其他用户的 home。",
  setupB2: "接收文件和私钥由独立低权限账号持有，不归 root 进程。",
  setupB3: "如果以前开过前台收件箱，只有在新服务成功启动后，旧状态才会移到带时间戳、可恢复的归档目录。",
  checkH: "检查服务、日志和文件",
  checkBody: "下面四条命令分别核对进程、近期日志、Relayium 本地/服务端真实状态和落盘目录。systemd 显示绿色并不等于账号、密钥和目录一定可用。",
  checkB1: "未另传 --dir 时，文件落在 /srv/relayium-inbox。",
  checkB2: "绝不覆盖已有文件；重名会安全编号。收到的内容不会自动打开、执行或解压。",
  checkB3: "「我的设备」会同时显示可编辑备注名和服务端最近观察到的 IP；它可能是 NAT 或 VPN 地址。",
  crashH: "服务器离线或崩溃时会怎样",
  crashBody: "服务器离线时，加密任务会在 Relayium 等待。「密文已上传」不等于「已保存」；只有完成认证解密、校验和持久落盘后才显示已保存。",
  crashB1: "进程异常后 systemd 会重启，服务器重启后也会自动启动。",
  crashB2: "未完成下载只存在于私有暂存区，不会暴露成完整文件。",
  crashB3: "持久日志让提交后的崩溃保持幂等：重启后只补报同一次保存，不会复制文件。",
  crashB4: "如果目录之后消失，worker 不会擅自重建，以免写到掉线挂载点下面；它会改为报告需要处理。",
  controlH: "暂停、恢复或移除接收",
  controlBody: "管理命令必须使用同一个服务账号和配置目录。pause 保留密钥和队列；resume 继续；disable 先清除服务端，再在成功后删除私钥。",
  controlB1: "不要把 SSH 窗口里的 inbox run 当作永久方案；窗口关闭它就停止。",
  controlB2: "systemctl disable --now 只停止进程；如果还要撤销收件箱和密钥，请用 inbox disable。",
  faqH: "常见问题",
  q1: "Relayium 能看到文件名或明文吗？", a1: "不能。浏览器会加密清单和文件字节，并把内容密钥封装给目标设备；中心只保存密文和路由状态。",
  q2: "为什么不放在 /root/inbox？", a2: "推荐服务刻意不用 root，并禁止访问用户 home。/srv/relayium-inbox 只给它一个边界清晰的可写区域。",
  q3: "可以手工安装吗？", a3: "可以。relayium inbox service systemd-user 或 systemd-system 会打印本机专用 unit 和命令，也有 launchd/container 说明；上面的可审阅脚本只是 Linux 服务器更短的路径。",
  cta: "服务显示 ready 后，就可以从自己的设备卡片发送文件。", button: "打开「我的设备」", related: "继续阅读",
});

// Every locale carries the same operational facts. Literal commands and paths
// remain identical so an operator can copy them across languages.
function variant(base, o) { return makeDoc({ ...base, ...o }); }
const common = {
  description: en.description, updatedLabel: "Last updated", lead: en.lead[0], lead2: en.lead[1],
  setupH: en.sections[0].heading, setupBody: en.sections[0].body[0], setupB1: en.sections[0].bullets[0], setupB2: en.sections[0].bullets[1], setupB3: en.sections[0].bullets[2],
  checkH: en.sections[1].heading, checkBody: en.sections[1].body[0], checkB1: en.sections[1].bullets[0], checkB2: en.sections[1].bullets[1], checkB3: en.sections[1].bullets[2],
  crashH: en.sections[2].heading, crashBody: en.sections[2].body[0], crashB1: en.sections[2].bullets[0], crashB2: en.sections[2].bullets[1], crashB3: en.sections[2].bullets[2], crashB4: en.sections[2].bullets[3],
  controlH: en.sections[3].heading, controlBody: en.sections[3].body[0], controlB1: en.sections[3].bullets[0], controlB2: en.sections[3].bullets[1],
  faqH: en.faq.heading, q1: en.faq.items[0].q, a1: en.faq.items[0].a, q2: en.faq.items[1].q, a2: en.faq.items[1].a, q3: en.faq.items[2].q, a3: en.faq.items[2].a,
  cta: en.cta.text, button: en.cta.button, related: en.relatedHeading,
};
const ja = variant(common, {
  title: "常時稼働する Linux サーバーに Device Inbox を設定", description: "低権限の systemd サービスとして Device Inbox を導入し、再起動後もブラウザーから自分のサーバーへ安全にファイルを受信します。", updatedLabel: "最終更新",
  lead: "Device Inbox は、ブラウザーの「マイデバイス」から自分のサーバー、NAS、ワークステーションへファイルを送ります。ブラウザーで暗号化され、対象のマシンだけが復号して保存できます。",
  lead2: "サーバーの受信機は、SSH を閉じても再起動しても動き続ける必要があります。推奨インストーラーはフォルダーを作成して systemd サービスを導入します。inbox run は前面での診断またはコンテナー用です。",
  setupH: "常駐受信サービスを導入", setupBody: "最初に運用ユーザーでログインし、短いスクリプトをダウンロードして確認してから root 権限で実行します。資格情報を表示せずに専用 relayium ユーザーへコピーし、受信鍵を登録して、強化した unit を今すぐ起動し再起動後も有効にします。",
  setupB1: "推奨保存先は /srv/relayium-inbox です。強化されたサービスは /root や他ユーザーのホームへアクセスできません。", setupB2: "受信ファイルと秘密鍵は root ではなく専用の低権限ユーザーが所有します。", setupB3: "以前の前面受信状態は、新サービスの起動成功後にだけ、日時付きの復元可能なアーカイブへ移されます。",
  checkH: "サービス・ログ・ファイルを確認", checkBody: "次のコマンドで、プロセス、ログ、Relayium のローカル/サーバー状態、保存先を別々に確認します。systemd が緑でも、アカウント、鍵、フォルダーが利用可能とは限りません。",
  checkB1: "別の --dir を指定しなければ、ファイルは /srv/relayium-inbox に保存されます。", checkB2: "既存ファイルは上書きしません。同名の場合は安全な連番名になり、自動で開く、実行する、展開することもありません。", checkB3: "マイデバイスには編集可能な名前とサーバーが最後に観測した IP が表示されます。NAT や VPN のアドレスの場合があります。",
  crashH: "オフラインやクラッシュ時の動作", crashBody: "サーバーがオフラインの間、暗号化されたタスクは Relayium で待機します。アップロード済みと保存済みは区別され、認証付き復号、検証、永続保存が完了して初めて保存済みになります。",
  crashB1: "プロセス障害後は systemd が再起動し、サーバー再起動後にも起動します。", crashB2: "途中のダウンロードは非公開の一時領域に残り、完成ファイルとして見えません。", crashB3: "永続ジャーナルにより、保存直後のクラッシュも重複せず同じ保存結果として再報告されます。", crashB4: "保存先が後で消えた場合、切断されたマウントの下へ書かないよう worker は再作成せず、対応が必要と報告します。",
  controlH: "一時停止・再開・削除", controlBody: "管理コマンドは同じサービスユーザーと設定ディレクトリーで実行します。pause は鍵と待機中の処理を保持し、resume は続行し、disable は中央の状態を消してから秘密鍵を削除します。",
  controlB1: "SSH 内の inbox run を恒久運用に使わないでください。ウィンドウを閉じると停止します。", controlB2: "systemctl disable --now はプロセスだけを停止します。受信箱と鍵も失効させる場合は inbox disable を使います。",
  faqH: "よくある質問", q1: "Relayium はファイル名や平文を見られますか？", a1: "いいえ。ブラウザーがマニフェストと内容を暗号化し、対象端末だけに内容鍵を封印します。中央には暗号文とルーティング状態だけが残ります。", q2: "なぜ /root/inbox に保存しないのですか？", a2: "推奨サービスは意図的に root を使わず、ホームへのアクセスを遮断します。/srv/relayium-inbox だけを限定した書き込み領域にします。", q3: "手動で導入できますか？", a3: "はい。relayium inbox service systemd-user または systemd-system でこのマシン向けの unit と手順を表示できます。launchd と container の説明もあります。",
  cta: "サービスが ready になったら、自分の端末カードからファイルを送信できます。", button: "マイデバイスを開く", related: "続きを読む",
});
const ko = variant(common, {
  title: "항상 켜진 Linux 서버에 Device Inbox 설정", description: "낮은 권한의 systemd 서비스로 Device Inbox를 설치해 재부팅 뒤에도 브라우저에서 내 서버로 파일을 받습니다.", updatedLabel: "마지막 업데이트",
  lead: "Device Inbox는 브라우저의 내 기기에서 내가 소유한 서버, NAS 또는 워크스테이션으로 파일을 보냅니다. 브라우저가 암호화하며 대상 기기만 복호화하고 저장합니다.", lead2: "서버 수신기는 SSH 창을 닫거나 재부팅해도 계속 동작해야 합니다. 권장 설치 프로그램은 폴더와 실제 systemd 서비스를 만듭니다. inbox run은 전경 진단 또는 컨테이너 진입점입니다.",
  setupH: "상주 수신 서비스 설치", setupBody: "운영자 계정으로 한 번 로그인한 뒤 짧은 스크립트를 내려받아 검토하고 root 권한으로 실행하세요. 자격 증명을 출력하지 않고 전용 relayium 계정으로 복사하며 수신 키를 등록하고 강화된 unit을 즉시 시작해 재부팅 후에도 활성화합니다.", setupB1: "권장 수신 경로는 /srv/relayium-inbox입니다. 강화된 서비스는 /root나 다른 사용자의 홈에 접근할 수 없습니다.", setupB2: "수신 파일과 개인 키는 root가 아니라 전용 저권한 계정이 소유합니다.", setupB3: "기존 전경 수신 상태는 새 서비스가 성공적으로 시작된 뒤에만 시간 표시가 있는 복구 가능한 보관 경로로 이동합니다.",
  checkH: "서비스·로그·파일 확인", checkBody: "아래 명령은 프로세스, 최근 로그, Relayium의 로컬/서버 상태, 실제 디렉터리를 각각 확인합니다. systemd가 정상이라고 해서 계정, 키, 폴더가 모두 사용 가능하다는 뜻은 아닙니다.", checkB1: "다른 --dir을 지정하지 않으면 파일은 /srv/relayium-inbox에 저장됩니다.", checkB2: "기존 파일을 덮어쓰지 않습니다. 이름이 겹치면 안전한 번호를 붙이며 받은 내용을 자동으로 열거나 실행하거나 압축 해제하지 않습니다.", checkB3: "내 기기에는 수정 가능한 이름과 서버가 마지막으로 확인한 IP가 표시됩니다. NAT 또는 VPN 주소일 수 있습니다.",
  crashH: "오프라인 또는 충돌 시 동작", crashBody: "서버가 오프라인이면 암호화된 작업은 Relayium에서 기다립니다. 업로드와 저장 완료는 다르며 인증 복호화, 검증, 영구 저장 뒤에만 저장됨으로 표시됩니다.", crashB1: "프로세스 오류 뒤 systemd가 worker를 다시 시작하고 서버 재부팅 후에도 시작합니다.", crashB2: "부분 다운로드는 비공개 준비 영역에만 남고 완료 파일로 노출되지 않습니다.", crashB3: "영구 저널 덕분에 커밋 직후 충돌해도 재시작 시 같은 저장을 보고하며 파일을 중복 만들지 않습니다.", crashB4: "수신 폴더가 나중에 사라지면 마운트 해제된 경로 아래에 쓰지 않도록 worker가 다시 만들지 않고 조치 필요 상태를 보고합니다.",
  controlH: "일시 중지·재개·제거", controlBody: "관리 명령은 같은 서비스 계정과 설정 디렉터리로 실행합니다. pause는 키와 대기 작업을 유지하고 resume은 계속하며 disable은 중앙 상태를 먼저 지운 뒤 개인 키를 삭제합니다.", controlB1: "SSH 창의 inbox run을 영구 설정으로 사용하지 마세요. 창을 닫으면 중지됩니다.", controlB2: "systemctl disable --now는 프로세스만 중지합니다. 수신함과 키도 해지하려면 inbox disable을 사용하세요.",
  faqH: "자주 묻는 질문", q1: "Relayium이 파일 이름이나 평문을 볼 수 있나요?", a1: "아니요. 브라우저가 매니페스트와 파일을 암호화하고 콘텐츠 키를 대상 기기에만 봉인합니다. 중앙에는 암호문과 라우팅 상태만 저장됩니다.", q2: "왜 /root/inbox를 사용하지 않나요?", a2: "권장 서비스는 의도적으로 root가 아니며 홈 디렉터리 접근도 차단합니다. /srv/relayium-inbox만 제한된 쓰기 영역으로 사용합니다.", q3: "수동으로 설치할 수 있나요?", a3: "예. relayium inbox service systemd-user 또는 systemd-system이 기기별 unit과 명령을 출력하며 launchd와 container 설명도 제공합니다.",
  cta: "서비스가 ready이면 내 기기 카드에서 파일을 보내세요.", button: "내 기기 열기", related: "계속 읽기",
});
const de = variant(common, {
  title: "Device Inbox auf einem dauerhaft laufenden Linux-Server einrichten", description: "Device Inbox als privilegienarmen systemd-Dienst installieren und Dateien auch nach einem Neustart vom Browser auf den eigenen Server empfangen.", updatedLabel: "Zuletzt aktualisiert",
  lead: "Device Inbox sendet eine Datei von „Meine Geräte“ im Browser an deinen eigenen Server, dein NAS oder deinen Arbeitsplatzrechner. Der Browser verschlüsselt sie; nur das Zielgerät entschlüsselt und speichert sie.", lead2: "Ein Server-Empfänger muss ein geschlossenes SSH-Fenster und Neustarts überstehen. Der empfohlene Installer erstellt den Ordner und einen echten systemd-Dienst. inbox run ist nur für Diagnose im Vordergrund oder Container gedacht.",
  setupH: "Dauerhaften Empfänger installieren", setupBody: "Melde die Maschine einmal als Betreiber an, lade dann das kurze Skript herunter und prüfe es, bevor du ihm Root-Rechte gibst. Es kopiert die Zugangsdaten ohne Ausgabe, erstellt ein eigenes relayium-Konto, registriert den Empfangsschlüssel und startet die gehärtete Unit sofort sowie nach Neustarts.", setupB1: "Empfohlen ist /srv/relayium-inbox. Der gehärtete Dienst kann weder auf /root noch auf fremde Home-Verzeichnisse zugreifen.", setupB2: "Empfangene Dateien und der private Schlüssel gehören dem eigenen, privilegienarmen Konto und nicht root.", setupB3: "Ein alter Vordergrund-Zustand wird erst nach erfolgreichem Dienststart in ein datiertes, wiederherstellbares Archiv verschoben.",
  checkH: "Dienst, Logs und Dateien prüfen", checkBody: "Die vier Befehle prüfen Prozess, Logs, den lokalen und zentralen Relayium-Status sowie den Ordner getrennt. Ein grüner systemd-Status allein beweist nicht, dass Konto, Schlüssel und Ordner nutzbar sind.", checkB1: "Ohne anderes --dir landen Dateien in /srv/relayium-inbox.", checkB2: "Vorhandene Dateien werden nie überschrieben. Kollisionen erhalten eine sichere Nummer; Inhalte werden nicht automatisch geöffnet, ausgeführt oder entpackt.", checkB3: "Meine Geräte zeigt den änderbaren Namen und die zuletzt vom Server beobachtete IP. Das kann eine NAT- oder VPN-Adresse sein.",
  crashH: "Verhalten bei Offlinezeit und Absturz", crashBody: "Während der Server offline ist, wartet die verschlüsselte Aufgabe bei Relayium. Hochgeladen bedeutet nicht gespeichert; gespeichert erscheint erst nach authentisierter Entschlüsselung, Prüfung und dauerhaftem lokalen Commit.", crashB1: "systemd startet den Worker nach einem Prozessfehler und nach einem Neustart erneut.", crashB2: "Ein Teildownload bleibt in privatem Staging und erscheint nie als fertige Datei.", crashB3: "Ein dauerhaftes Journal macht einen Absturz nach dem Commit idempotent: Der Neustart meldet dieselbe Speicherung ohne Duplikat.", crashB4: "Verschwindet der Ordner später, erstellt der Worker ihn nicht unter einem fehlenden Mount neu, sondern meldet Handlungsbedarf.",
  controlH: "Pausieren, fortsetzen oder entfernen", controlBody: "Führe Verwaltungsbefehle mit demselben Dienstkonto und Konfigurationsordner aus. pause behält Schlüssel und Warteschlange, resume fährt fort, disable entfernt zuerst den zentralen Zustand und danach die privaten Schlüssel.", controlB1: "Nutze inbox run im SSH-Fenster nicht dauerhaft; beim Schließen endet der Prozess.", controlB2: "systemctl disable --now stoppt nur den Prozess. inbox disable widerruft zusätzlich Inbox und Schlüssel.",
  faqH: "Häufige Fragen", q1: "Sieht Relayium Dateinamen oder Klartext?", a1: "Nein. Der Browser verschlüsselt Manifest und Datei und versiegelt den Inhaltsschlüssel für das Zielgerät. Zentral liegen nur Chiffretext und Routingstatus.", q2: "Warum nicht /root/inbox?", a2: "Der empfohlene Dienst läuft bewusst ohne root und ohne Home-Zugriff. /srv/relayium-inbox ist sein eng begrenzter Schreibbereich.", q3: "Kann ich manuell installieren?", a3: "Ja. relayium inbox service systemd-user oder systemd-system gibt eine maschinenspezifische Unit und Befehle aus; Beschreibungen für launchd und container sind ebenfalls vorhanden.",
  cta: "Sobald der Dienst ready meldet, sende eine Datei über deine Gerätekarte.", button: "Meine Geräte öffnen", related: "Weiterlesen",
});
const fr = variant(common, {
  title: "Configurer Device Inbox sur un serveur Linux toujours actif",
  description: "Installer Device Inbox comme service systemd peu privilégié et recevoir depuis le navigateur même après un redémarrage.", updatedLabel: "Dernière mise à jour",
  lead: "Device Inbox envoie un fichier depuis Mes appareils dans le navigateur vers votre serveur, NAS ou poste de travail. Le navigateur le chiffre et seule la machine cible le déchiffre et l'enregistre.",
  lead2: "Un récepteur de serveur doit survivre à la fermeture de SSH et au redémarrage. L'installateur recommandé crée le dossier et un vrai service systemd. inbox run reste réservé au diagnostic au premier plan ou au conteneur.",
  setupH: "Installer le récepteur permanent", setupBody: "Connectez d'abord la machine, puis téléchargez et examinez le script avant de lui accorder les droits root. Il copie l'identifiant sans l'afficher, crée un compte relayium dédié, inscrit la clé, installe l'unité renforcée, la démarre et l'active au redémarrage.",
  setupB1: "Le dossier conseillé est /srv/relayium-inbox. Le service renforcé ne peut pas accéder à /root ni au dossier personnel d'un autre utilisateur.",
  setupB2: "Les fichiers reçus et la clé privée appartiennent au compte dédié peu privilégié, pas à root.",
  setupB3: "Un ancien état de premier plan est déplacé vers une archive horodatée et récupérable uniquement après le démarrage réussi du service.",
  checkH: "Vérifier service, journaux et fichiers", checkBody: "Ces commandes vérifient séparément le processus, ses journaux, l'état local et distant de Relayium et le dossier. Un état systemd vert ne prouve pas à lui seul que compte, clé et dossier sont utilisables.",
  checkB1: "Sans autre option --dir, les fichiers arrivent dans /srv/relayium-inbox.",
  checkB2: "Aucun fichier existant n'est écrasé. Un conflit reçoit un numéro sûr et le contenu n'est ni ouvert, ni exécuté, ni extrait automatiquement.",
  checkB3: "Mes appareils affiche le libellé modifiable et la dernière IP observée par le serveur, qui peut être celle d'un NAT ou d'un VPN.",
  crashH: "Comportement hors ligne ou après incident", crashBody: "La tâche chiffrée attend pendant que le serveur est hors ligne. Téléversé ne signifie jamais enregistré. Ce dernier état apparaît seulement après déchiffrement authentifié, vérification et écriture durable.",
  crashB1: "systemd relance le worker après un incident et au redémarrage du serveur.",
  crashB2: "Un téléchargement partiel reste dans une zone privée et n'apparaît jamais comme fichier terminé.",
  crashB3: "Le journal durable rend un incident après validation idempotent. Le redémarrage confirme le même enregistrement sans dupliquer le fichier.",
  crashB4: "Si le dossier disparaît, le worker ne le recrée pas sous un volume démonté et signale qu'une intervention est nécessaire.",
  controlH: "Suspendre, reprendre ou supprimer", controlBody: "Exécutez les commandes avec le même compte de service et le même dossier de configuration. pause garde clés et file, resume continue et disable efface d'abord l'état central avant les clés privées.",
  controlB1: "N'utilisez pas inbox run dans une fenêtre SSH comme installation permanente. Sa fermeture arrête le processus.",
  controlB2: "systemctl disable --now arrête seulement le processus. Utilisez inbox disable pour révoquer aussi la boîte et ses clés.",
  faqH: "Questions fréquentes",
  q1: "Relayium voit-il les noms ou le contenu en clair ?", a1: "Non. Le navigateur chiffre manifeste et octets, puis scelle la clé pour l'appareil choisi. Le serveur central ne conserve que le chiffré et l'état de routage.",
  q2: "Pourquoi ne pas utiliser /root/inbox ?", a2: "Le service recommandé fonctionne volontairement sans root et sans accès aux dossiers personnels. /srv/relayium-inbox lui donne une seule zone d'écriture bien délimitée.",
  q3: "Puis-je faire l'installation manuellement ?", a3: "Oui. relayium inbox service systemd-user ou systemd-system imprime une unité adaptée et ses commandes. Des descriptions launchd et container existent aussi. Le script examiné est simplement le chemin Linux le plus court.",
  cta: "Quand le service indique ready, envoyez un fichier depuis votre fiche d'appareil.", button: "Ouvrir Mes appareils", related: "Continuer la lecture",
});
const es = variant(common, {
  title: "Configurar Device Inbox en un servidor Linux siempre encendido", description: "Instala Device Inbox como servicio systemd con pocos privilegios y recibe archivos del navegador incluso tras reiniciar.", updatedLabel: "Última actualización",
  lead: "Device Inbox envía un archivo desde Mis dispositivos en el navegador a tu servidor, NAS o equipo de trabajo. El navegador lo cifra; solo la máquina de destino puede descifrarlo y guardarlo.", lead2: "El receptor debe seguir activo al cerrar SSH y después de reiniciar. El instalador recomendado crea la carpeta y un servicio systemd real. inbox run queda para diagnósticos en primer plano o contenedores.",
  setupH: "Instalar el receptor permanente", setupBody: "Inicia sesión una vez como operador, descarga y revisa el script antes de darle permisos root. Copia la credencial sin mostrarla, crea una cuenta relayium dedicada, registra la clave de recepción e instala, inicia y habilita la unidad reforzada.", setupB1: "La carpeta recomendada es /srv/relayium-inbox. El servicio reforzado no accede a /root ni al directorio personal de otro usuario.", setupB2: "Los archivos recibidos y la clave privada pertenecen a la cuenta dedicada con pocos privilegios, no a root.", setupB3: "Un estado anterior en primer plano solo se mueve a un archivo recuperable con fecha después de que el nuevo servicio arranque correctamente.",
  checkH: "Comprobar servicio, registros y archivos", checkBody: "Estos comandos verifican por separado el proceso, sus registros, el estado local/remoto de Relayium y la carpeta. Un estado verde de systemd no demuestra por sí solo que cuenta, clave y carpeta funcionen.", checkB1: "Sin otro --dir, los archivos llegan a /srv/relayium-inbox.", checkB2: "Nunca se sobrescriben archivos. Los nombres repetidos reciben un número seguro y el contenido no se abre, ejecuta ni extrae automáticamente.", checkB3: "Mis dispositivos muestra el nombre editable y la última IP observada por el servidor, que puede ser de un NAT o una VPN.",
  crashH: "Qué pasa sin conexión o tras un fallo", crashBody: "La tarea cifrada espera en Relayium mientras el servidor está desconectado. Subido no significa guardado: solo se muestra guardado tras descifrar, verificar y confirmar de forma duradera en disco.", crashB1: "systemd reinicia el worker tras un fallo y al reiniciar el servidor.", crashB2: "Una descarga parcial permanece en preparación privada y nunca aparece como archivo terminado.", crashB3: "El diario duradero hace idempotente un fallo posterior a la escritura: se informa del mismo guardado sin duplicar el archivo.", crashB4: "Si la carpeta desaparece, el worker no la recrea bajo un montaje ausente; informa que necesita atención.",
  controlH: "Pausar, reanudar o eliminar", controlBody: "Ejecuta los comandos con la misma cuenta de servicio y configuración. pause conserva claves y cola, resume continúa y disable elimina primero el estado central y después las claves privadas.", controlB1: "No uses inbox run en una sesión SSH como solución permanente: se detiene al cerrarla.", controlB2: "systemctl disable --now solo detiene el proceso. Usa inbox disable para revocar también el buzón y sus claves.",
  faqH: "Preguntas frecuentes", q1: "¿Relayium ve nombres o texto sin cifrar?", a1: "No. El navegador cifra el manifiesto y los bytes y sella la clave para el dispositivo elegido. El centro solo guarda cifrado y estado de enrutamiento.", q2: "¿Por qué no usar /root/inbox?", a2: "El servicio recomendado no usa root y bloquea los directorios personales. /srv/relayium-inbox es su única zona de escritura limitada.", q3: "¿Puedo instalarlo manualmente?", a3: "Sí. relayium inbox service systemd-user o systemd-system imprime la unidad y los comandos de esta máquina; también hay descripciones para launchd y container.",
  cta: "Cuando el servicio indique ready, envía un archivo desde tu tarjeta de dispositivo.", button: "Abrir Mis dispositivos", related: "Seguir leyendo",
});
const pt = variant(common, {
  title: "Configurar o Device Inbox em um servidor Linux sempre ligado", description: "Instale o Device Inbox como serviço systemd de baixo privilégio e receba arquivos do navegador mesmo após reiniciar.", updatedLabel: "Última atualização",
  lead: "O Device Inbox envia um arquivo de Meus dispositivos no navegador para seu servidor, NAS ou estação de trabalho. O navegador criptografa; só a máquina escolhida descriptografa e salva.", lead2: "O receptor precisa continuar após fechar o SSH e reiniciar. O instalador recomendado cria a pasta e um serviço systemd real. inbox run serve apenas para diagnóstico em primeiro plano ou contêiner.",
  setupH: "Instalar o receptor permanente", setupBody: "Faça login uma vez como operador, baixe e examine o script antes de conceder root. Ele copia a credencial sem exibi-la, cria uma conta relayium dedicada, registra a chave e instala, inicia e habilita a unidade reforçada.", setupB1: "A pasta recomendada é /srv/relayium-inbox. O serviço reforçado não acessa /root nem a home de outro usuário.", setupB2: "Arquivos recebidos e chave privada pertencem à conta dedicada de baixo privilégio, não ao root.", setupB3: "Um estado antigo em primeiro plano só é movido para um arquivo recuperável com data depois que o novo serviço inicia com sucesso.",
  checkH: "Verificar serviço, logs e arquivos", checkBody: "Os comandos verificam separadamente processo, logs, estado local/remoto do Relayium e diretório. Um systemd verde não prova sozinho que conta, chave e pasta estão utilizáveis.", checkB1: "Sem outro --dir, os arquivos chegam em /srv/relayium-inbox.", checkB2: "Arquivos existentes nunca são sobrescritos. Conflitos ganham um número seguro e o conteúdo não é aberto, executado ou extraído automaticamente.", checkB3: "Meus dispositivos mostra o nome editável e o último IP observado pelo servidor, que pode ser de NAT ou VPN.",
  crashH: "Comportamento offline ou após falha", crashBody: "A tarefa criptografada aguarda no Relayium enquanto o servidor está offline. Enviado não significa salvo; salvo só aparece após descriptografia autenticada, verificação e gravação durável.", crashB1: "O systemd reinicia o worker após falha e depois da reinicialização do servidor.", crashB2: "Um download parcial permanece em preparação privada e nunca aparece como arquivo concluído.", crashB3: "O diário durável torna idempotente uma falha após a gravação: o reinício informa o mesmo salvamento sem duplicar.", crashB4: "Se a pasta sumir, o worker não a recria sob uma montagem ausente e informa que é necessária atenção.",
  controlH: "Pausar, retomar ou remover", controlBody: "Execute os comandos com a mesma conta de serviço e configuração. pause mantém chaves e fila, resume continua e disable apaga primeiro o estado central e depois as chaves privadas.", controlB1: "Não use inbox run em uma janela SSH como instalação permanente; fechar a janela interrompe o processo.", controlB2: "systemctl disable --now apenas para o processo. Use inbox disable para revogar também a caixa e as chaves.",
  faqH: "Perguntas frequentes", q1: "O Relayium vê nomes ou conteúdo em claro?", a1: "Não. O navegador criptografa manifesto e bytes e sela a chave para o dispositivo escolhido. A central guarda somente texto cifrado e estado de roteamento.", q2: "Por que não /root/inbox?", a2: "O serviço recomendado não usa root e bloqueia homes. /srv/relayium-inbox é sua única área restrita de escrita.", q3: "Posso instalar manualmente?", a3: "Sim. relayium inbox service systemd-user ou systemd-system imprime a unidade e os comandos da máquina; também há descrições para launchd e container.",
  cta: "Quando o serviço mostrar ready, envie um arquivo pelo cartão do dispositivo.", button: "Abrir Meus dispositivos", related: "Continue lendo",
});
const ar = variant(common, {
  title: "إعداد Device Inbox على خادم Linux يعمل دائمًا", description: "ثبّت Device Inbox كخدمة systemd محدودة الصلاحيات لاستقبال الملفات من المتصفح حتى بعد إعادة التشغيل.", updatedLabel: "آخر تحديث",
  lead: "يرسل Device Inbox الملف من «أجهزتي» في المتصفح إلى خادمك أو جهاز NAS أو محطة العمل. يشفّره المتصفح، ولا يفكّه ويحفظه إلا الجهاز المستهدف.", lead2: "يجب أن يستمر مستقبِل الخادم بعد إغلاق SSH وإعادة التشغيل. ينشئ المثبّت الموصى به المجلد وخدمة systemd فعلية. أما inbox run فللتشخيص في الواجهة أو للحاويات فقط.",
  setupH: "تثبيت المستقبِل الدائم", setupBody: "سجّل الدخول مرة كمشغّل، ثم نزّل النص القصير وافحصه قبل منحه صلاحيات root. ينسخ بيانات الاعتماد دون عرضها، وينشئ حساب relayium مخصصًا، ويسجل مفتاح الاستقبال، ثم يثبت الوحدة المقوّاة ويشغلها الآن وبعد إعادة التشغيل.", setupB1: "المجلد الموصى به هو /srv/relayium-inbox. لا تصل الخدمة المقوّاة إلى /root أو المجلد المنزلي لمستخدم آخر.", setupB2: "تعود ملكية الملفات والمفتاح الخاص إلى الحساب المخصص محدود الصلاحيات، لا إلى root.", setupB3: "لا تُنقل حالة استقبال قديمة إلى أرشيف مؤرخ قابل للاستعادة إلا بعد نجاح تشغيل الخدمة الجديدة.",
  checkH: "فحص الخدمة والسجلات والملفات", checkBody: "تفحص الأوامر العملية والسجلات وحالة Relayium المحلية/المركزية والمجلد كلًا على حدة. لا تكفي حالة systemd الخضراء لإثبات صلاحية الحساب والمفتاح والمجلد.", checkB1: "تصل الملفات إلى /srv/relayium-inbox ما لم تمرر --dir مختلفًا.", checkB2: "لا تُستبدل الملفات الموجودة؛ يحصل الاسم المتكرر على رقم آمن، ولا يُفتح المحتوى أو يُنفذ أو يُستخرج تلقائيًا.", checkB3: "تعرض «أجهزتي» الاسم القابل للتعديل وآخر IP رآه الخادم، وقد يكون عنوان NAT أو VPN.",
  crashH: "السلوك عند انقطاع الاتصال أو التعطل", crashBody: "تنتظر المهمة المشفرة في Relayium أثناء غياب الخادم. الرفع لا يعني الحفظ؛ لا تظهر حالة الحفظ إلا بعد فك موثّق والتحقق والكتابة الدائمة.", crashB1: "يعيد systemd تشغيل العامل بعد فشل العملية وبعد إعادة تشغيل الخادم.", crashB2: "يبقى التنزيل الجزئي في مساحة تجهيز خاصة ولا يظهر كملف مكتمل.", crashB3: "يجعل السجل الدائم التعطل بعد الحفظ متكررًا بأمان: يُبلغ عن الحفظ نفسه دون إنشاء نسخة.", crashB4: "إذا اختفى المجلد لاحقًا فلا يعيد العامل إنشاءه تحت نقطة تركيب غائبة، بل يبلغ أن الأمر يحتاج إلى تدخل.",
  controlH: "الإيقاف المؤقت أو الاستئناف أو الإزالة", controlBody: "شغّل أوامر الإدارة بالحساب ومجلد الإعداد نفسيهما. يحتفظ pause بالمفاتيح والطابور، ويتابع resume، ويحذف disable الحالة المركزية أولًا ثم المفاتيح الخاصة.", controlB1: "لا تستخدم inbox run داخل نافذة SSH كإعداد دائم؛ سيتوقف عند إغلاقها.", controlB2: "يوقف systemctl disable --now العملية فقط. استخدم inbox disable لإلغاء صندوق الاستقبال ومفاتيحه أيضًا.",
  faqH: "الأسئلة الشائعة", q1: "هل يرى Relayium أسماء الملفات أو النص الواضح؟", a1: "لا. يشفّر المتصفح البيان والملف ويغلق مفتاح المحتوى للجهاز المختار. لا يحتفظ المركز إلا بالنص المشفر وحالة التوجيه.", q2: "لماذا لا نستخدم /root/inbox؟", a2: "تعمل الخدمة الموصى بها دون root وتمنع الوصول إلى مجلدات المستخدمين. يمنحها /srv/relayium-inbox مساحة كتابة واحدة محدودة.", q3: "هل يمكن التثبيت يدويًا؟", a3: "نعم. يطبع relayium inbox service systemd-user أو systemd-system الوحدة والأوامر الخاصة بالجهاز، كما توجد إرشادات launchd وcontainer.",
  cta: "عندما تعرض الخدمة ready أرسل ملفًا من بطاقة جهازك.", button: "فتح أجهزتي", related: "تابع القراءة",
});

export default {
  slug: "guides/device-inbox-server",
  published: "2026-08-09",
  updated: "2026-08-09",
  langs: { en, zh, ja, ko, de, fr, ar, es, pt },
};
