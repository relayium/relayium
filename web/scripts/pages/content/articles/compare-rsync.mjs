// web/scripts/pages/content/articles/compare-rsync.mjs
// Objective comparison: Relayium `sync` vs rsync, pairs with the sync feature.
// English is the master; zh/ja/ko/de/fr follow the same structure with identical facts.
// Command/code blocks stay English in every language.

import { withInstall } from "../install-section.mjs";

const en = {
  title: "Relayium vs rsync: sync folders without the SSH setup",
  description:
    "A fair comparison: rsync is the mature, powerful standard for mirroring folders; Relayium sync trades some of that power for less setup and works across networks without an SSH server.",
  updatedLabel: "Last updated",
  lead: [
    "rsync has mirrored folders since 1996 for a reason: bidirectional sync, a rolling-checksum delta algorithm that transfers only the bytes that actually changed inside a file, and decades of flags for every edge case. If you already have SSH access and know rsync, it is very hard to beat.",
    "Relayium's sync command covers a narrower job — a one-way incremental mirror — but it removes a step rsync assumes you've already done: setting up SSH. It runs over SSH if you already have it, or connects two machines directly with no SSH server at all. This article compares the two honestly; sync is not a full rsync replacement, and the FAQ says so plainly.",
  ],
  sections: [
    {
      heading: "What rsync gets right",
      body: [
        "rsync is bidirectional — either side can be the source — and its delta-transfer algorithm compares blocks of a file with a rolling checksum, so a small edit to a huge file only sends the changed blocks, not the whole file again. That, plus decades of flags (--exclude, --link-dest for hard-link snapshots, compression, bandwidth limits, and more), make it the right tool for a lot of jobs.",
        "It's also everywhere: most Linux and macOS systems ship it, and it works over an SSH connection you've probably already configured. None of that is something Relayium sync tries to replace.",
      ],
    },
    {
      heading: "What Relayium sync does instead",
      body: [
        "relayium sync <src...> <dest> [--delete] [--watch] is a one-way incremental mirror: it compares each file's size and modification time, skips what already matches, and sends the rest.",
        "It works over two transports. Point it at user@host:/dest and it runs over SSH — but relayium must already be installed on the remote; unlike push, there's no tar fallback for sync. Point it at relayium://host[:port] instead and it skips SSH entirely: a pinned TLS 1.3 connection straight to a relayium serve listener on the other machine, authenticated by that machine's fingerprint (approved once, remembered after). That second path is the real convenience: no sshd to configure, no SSH keys to manage — just two machines with relayium installed and a port open between them.",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "Deletions and continuous sync",
      body: [
        "By default sync only adds and updates — it never deletes anything on its own. Pass --delete to mirror deletions too, but the receiver has to opt in: it must be running relayium serve --allow-delete. If it isn't, the delete request is refused and reported back to the sender rather than silently ignored.",
        "For a folder that changes continuously, --watch keeps sync running after the first pass and re-mirrors whenever a file changes under the source — rsync has nothing built in for this; you'd normally reach for a cron job or a wrapper like lsyncd.",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "Integrity, resume, and the honest limits",
      body: [
        "Every file is verified end to end with a SHA-256 hash, and a transfer that gets cut off mid-file resumes from the byte offset already on disk instead of restarting — useful for the same reasons it is in rsync.",
        "Be clear about what resume is not: it isn't rsync's delta algorithm. If a file is already fully present but has a different size or timestamp, sync retransmits it whole rather than diffing changed blocks inside it. For one huge file that changes slightly and often, rsync's delta transfer will move less data. sync also only handles regular files — symlinks and special files are skipped, so anything relying on those needs handling separately.",
      ],
    },
    {
      heading: "When rsync is still the better tool",
      body: [
        "Pick rsync when you need sync to go both ways, when you already have SSH set up and don't want another daemon, when you need fine-grained control (excludes, filters, hard-link snapshots, bandwidth limits, compression), or when a file changes slightly and often and delta-transfer saves real bandwidth. Relayium sync doesn't try to cover any of that.",
      ],
      bullets: [
        "One-way only: sync mirrors source → destination; rsync can go either direction.",
        "No delta transfer: sync resends a changed file whole; rsync's rolling checksum sends only the changed blocks.",
        "Fewer options: rsync has decades of flags for filtering, compression, and snapshotting; sync has --delete and --watch.",
        "Where Relayium sync wins: no SSH server required (daemon direct), pinned TLS with fingerprint authentication, real-time re-sync with --watch, and it's free with no account for any transfer mode.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Is Relayium sync a full replacement for rsync?",
        a: "No. It only does one-way mirroring and has no block-level delta algorithm like rsync — a file with a different size or timestamp is retransmitted whole, and it has far fewer flags than rsync. If you need bidirectional sync, fine-grained filter control, or want to lean on rsync's mature ecosystem, rsync is still the better tool.",
      },
      {
        q: "Does sync need an SSH server?",
        a: "No. Daemon direct (relayium://host:port) skips SSH entirely: a pinned TLS connection, authenticated by the receiver's fingerprint, approved once and remembered after. You can also go over SSH (user@host:path), but relayium must be installed on the remote for that — and unlike push, there's no tar fallback for sync.",
      },
      {
        q: "Does sync delete files I removed from the source?",
        a: "Only if you pass --delete and the receiver's serve is running with --allow-delete. Otherwise the delete request is refused and reported back to the sender, not silently ignored.",
      },
      {
        q: "Can it sync continuously in real time?",
        a: "Yes, with --watch. After the initial mirror, sync keeps running and re-mirrors (debounced) whenever a file changes under the source.",
      },
      {
        q: "Is it free?",
        a: "Yes. The Relayium CLI is completely free, and no mode — sync included — needs an account.",
      },
    ],
  },
  cta: {
    text: "Mirror a folder between two of your own machines — no SSH server required.",
    button: "Get the CLI",
    href: "/cli",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 rsync：无需配置 SSH 也能同步文件夹",
  description:
    "客观对比 Relayium sync 与 rsync：rsync 是成熟强大的黄金标准，Relayium sync 用一部分能力换取更简单的配置，并且跨网络无需搭建 SSH 服务。",
  updatedLabel: "最近更新",
  lead: [
    "rsync 自 1996 年起就在镜像文件夹，这是有原因的：双向同步、用滚动校验和只传输文件内部真正变化的字节的增量算法，以及几十年积累下来、覆盖各种边界情况的参数。如果你已经有 SSH 访问权限并且熟悉 rsync，它很难被超越。",
    "Relayium 的 sync 命令只覆盖一个更窄的场景——单向增量镜像——但它省掉了 rsync 默认你已经做好的一步：搭建 SSH。它既可以跑在你已有的 SSH 之上，也可以让两台机器直接连接，完全不需要 SSH 服务。本文客观对比两者：sync 不是 rsync 的完整替代品，FAQ 里也会直说这一点。",
  ],
  sections: [
    {
      heading: "rsync 做对了什么",
      body: [
        "rsync 是双向的——任意一端都可以作为源——它的增量传输算法用滚动校验和比较文件的数据块，因此对一个巨大文件做的小修改只会发送变化的数据块，而不是整个文件重传。再加上几十年积累的参数（--exclude、用于硬链接快照的 --link-dest、压缩、带宽限制等等），让它能胜任很多工作。",
        "它也无处不在：大多数 Linux 和 macOS 系统自带 rsync，并且能跑在你大概率已经配置好的 SSH 连接上。这些都不是 Relayium sync 想要取代的东西。",
      ],
    },
    {
      heading: "Relayium sync 换了一种做法",
      body: [
        "relayium sync <源...> <目标> [--delete] [--watch] 是单向增量镜像：它比较每个文件的大小和修改时间，跳过已经一致的文件，只发送其余的。",
        "它支持两种传输方式。指向 user@host:/dest 时走 SSH——但远端必须已经装好 relayium；和 push 不同，sync 没有 tar 兜底方案。指向 relayium://host[:port] 时则完全不需要 SSH：直接用锁定的 TLS 1.3 连接到对端机器上运行的 relayium serve 监听端，通过对端的指纹认证（首次批准，之后记住）。第二种方式才是真正的便利所在：不用配置 sshd，不用管理 SSH 密钥，只要两台机器都装了 relayium，并且之间有一个端口互通即可。",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "删除与持续同步",
      body: [
        "默认情况下 sync 只新增和更新——绝不会自作主张删除任何东西。加上 --delete 才会镜像删除，但接收方必须主动开启：它必须以 relayium serve --allow-delete 运行。如果没有，删除请求会被拒绝并回报给发送方，而不是悄悄被忽略。",
        "对于持续变化的文件夹，--watch 会让 sync 在第一次同步之后继续运行，只要源目录下有文件变化就重新镜像——这一点 rsync 并没有内置支持，通常你得借助 cron 任务或 lsyncd 这类封装工具。",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "完整性、续传，以及诚实的局限",
      body: [
        "每个文件都会用 SHA-256 做端到端校验，传到一半被打断的传输会从磁盘上已有的字节偏移续传，而不是重新开始——这一点和 rsync 的续传出于同样的道理。",
        "但要说清楚续传不是什么：它不是 rsync 的增量算法。如果一个文件已经完整存在，只是大小或时间戳不同，sync 会把它整个重传，而不是去比对内部变化的数据块。对于一个经常发生小改动的巨大文件，rsync 的增量传输会传更少的数据。sync 也只处理常规文件——符号链接和特殊文件会被跳过，依赖它们的场景需要另外处理。",
      ],
    },
    {
      heading: "什么时候 rsync 仍是更好的工具",
      body: [
        "当你需要双向同步、已经配好 SSH 不想再跑一个守护进程、需要精细控制（排除规则、过滤器、硬链接快照、带宽限制、压缩），或者某个文件经常发生小改动、增量传输能省下实打实的带宽时，选 rsync。这些都不是 Relayium sync 想要覆盖的场景。",
      ],
      bullets: [
        "仅单向：sync 只从源镜像到目标；rsync 可以双向进行。",
        "没有增量传输：sync 会整个重传变化的文件；rsync 的滚动校验和只发送变化的数据块。",
        "参数更少：rsync 有几十年积累的过滤、压缩、快照参数；sync 只有 --delete 和 --watch。",
        "Relayium sync 的优势：不需要 SSH 服务（守护进程直连）、带指纹认证的锁定 TLS、用 --watch 实时重新同步，并且所有传输模式都免费、无需账号。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "sync 能完全替代 rsync 吗？",
        a: "不能。它只做单向镜像，也没有 rsync 那种基于数据块的增量算法——大小或时间戳变化的文件会被整个重传，参数也远少于 rsync。如果你需要双向同步、精细的过滤控制，或者依赖 rsync 成熟的生态，rsync 仍然是更好的工具。",
      },
      {
        q: "sync 需要 SSH 服务吗？",
        a: "不需要。守护进程直连（relayium://host:port）完全跳过 SSH：用锁定的 TLS 连接，通过接收方的指纹认证，批准一次之后就会被记住。你也可以选择走 SSH（user@host:path），前提是远端已经装了 relayium——但和 push 不同，sync 没有 tar 兜底。",
      },
      {
        q: "sync 会删除源端已经移除的文件吗？",
        a: "只有在你传了 --delete、并且接收方的 serve 是以 --allow-delete 启动时才会。否则删除请求会被拒绝，并回报给发送方，不会被静默忽略。",
      },
      {
        q: "能做到实时持续同步吗？",
        a: "可以，加上 --watch。完成首次镜像之后 sync 会继续运行，只要源目录下有文件变化（有防抖），就会重新镜像。",
      },
      {
        q: "这是免费的吗？",
        a: "是的。Relayium CLI 完全免费，包括 sync 在内的任何模式都不需要账号。",
      },
    ],
  },
  cta: {
    text: "在你自己的两台机器之间镜像一个文件夹——不需要 SSH 服务。",
    button: "获取 CLI",
    href: "/cli",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium vs rsync: SSH 設定なしでフォルダーを同期",
  description:
    "Relayium sync と rsync を公平に比較。rsync は成熟した強力な標準ツールですが、Relayium sync はその一部の力を手放す代わりに設定を減らし、SSH サーバーなしでネットワークをまたいで動きます。",
  updatedLabel: "最終更新",
  lead: [
    "rsync が 1996 年からフォルダーをミラーリングしてきたのには理由があります。双方向の同期、ローリングチェックサムでファイル内部の変化したバイトだけを転送する差分アルゴリズム、そしてあらゆるケースに対応する数十年分のフラグです。すでに SSH アクセスがあり rsync を知っているなら、これを上回るのは非常に困難です。",
    "Relayium の sync コマンドはもっと狭い範囲——一方向の増分ミラー——だけをカバーしますが、rsync が前提とする一つのステップ、SSH のセットアップを省きます。すでにある SSH の上で動かすこともできますし、SSH サーバーなしで2台のマシンを直接つなぐこともできます。本記事はこの2つを正直に比較します。sync は rsync の完全な代替ではなく、FAQ でもそれをはっきり述べます。",
  ],
  sections: [
    {
      heading: "rsync が優れている点",
      body: [
        "rsync は双方向です——どちらの側もソースになれます——そして差分転送アルゴリズムはローリングチェックサムでファイルのブロックを比較するため、巨大なファイルへの小さな編集でも、変化したブロックだけを送り、ファイル全体を再送しません。それに加えて数十年分のフラグ(--exclude、ハードリンクスナップショット用の --link-dest、圧縮、帯域制限など)が、多くの用途に適した道具にしています。",
        "また、どこにでもあります。ほとんどの Linux と macOS には標準で入っており、すでに設定済みであろう SSH 接続の上で動きます。これらはどれも Relayium sync が置き換えようとしているものではありません。",
      ],
    },
    {
      heading: "Relayium sync のやり方",
      body: [
        "relayium sync <ソース...> <宛先> [--delete] [--watch] は一方向の増分ミラーです。各ファイルのサイズと更新時刻を比較し、すでに一致するものはスキップし、残りを送ります。",
        "2つの転送方式で動きます。user@host:/dest を指定すると SSH 経由で動きますが——リモートにあらかじめ relayium がインストールされている必要があります。push と違い、sync に tar フォールバックはありません。代わりに relayium://host[:port] を指定すると SSH を完全に省けます。固定された TLS 1.3 接続で、相手のマシンで動く relayium serve リスナーに直接つながり、そのマシンのフィンガープリントで認証されます(一度承認すれば以後は記憶されます)。この2つ目の経路こそが本当の利点です。sshd の設定も SSH 鍵の管理も不要で、relayium がインストールされた2台のマシンと、間で開いたポートさえあればよいのです。",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "削除と継続的な同期",
      body: [
        "既定では sync は追加と更新だけを行い、自分から何かを削除することはありません。削除もミラーするには --delete を渡しますが、受信側は明示的に許可する必要があります。relayium serve --allow-delete で動いていなければなりません。そうでなければ削除要求は拒否され、黙って無視されるのではなく送信側に報告されます。",
        "継続的に変化するフォルダーには、--watch を付けると sync は最初のパスの後も動き続け、ソース配下でファイルが変化するたびに再ミラーします——これに相当する機能は rsync には組み込まれておらず、通常は cron ジョブや lsyncd のようなラッパーに頼ることになります。",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "整合性、再開、そして正直な限界",
      body: [
        "各ファイルは SHA-256 ハッシュで端から端まで検証され、途中で切れた転送はディスク上にすでにあるバイトオフセットから再開します。やり直しません——これは rsync の再開と同じ理由で役に立ちます。",
        "再開が何でないかをはっきりさせておきます。rsync の差分アルゴリズムではありません。ファイルがすでに完全に存在していても、サイズやタイムスタンプが異なれば、sync は内部の変化したブロックを差分比較するのではなく、ファイル全体を再送します。頻繁に少しずつ変化する巨大な1ファイルについては、rsync の差分転送の方が転送量は少なくなります。sync が扱うのも通常ファイルだけです——シンボリックリンクと特殊ファイルはスキップされるので、それらに依存する場合は別途対応が必要です。",
      ],
    },
    {
      heading: "rsync がまだ優れているとき",
      body: [
        "双方向の同期が必要なとき、すでに SSH が設定済みで別のデーモンを動かしたくないとき、きめ細かい制御(除外、フィルター、ハードリンクスナップショット、帯域制限、圧縮)が必要なとき、あるいは1つのファイルが頻繁に少しずつ変化して差分転送が実質的に帯域を節約するときは、rsync を選んでください。Relayium sync はそのどれもカバーしようとしていません。",
      ],
      bullets: [
        "一方向のみ: sync はソース→宛先だけをミラーする; rsync はどちらの方向にも動く。",
        "差分転送なし: sync は変化したファイルを丸ごと再送する; rsync のローリングチェックサムは変化したブロックだけを送る。",
        "オプションが少ない: rsync にはフィルタリング、圧縮、スナップショットのための数十年分のフラグがある; sync には --delete と --watch しかない。",
        "Relayium sync が勝る点: SSH サーバー不要(デーモン直結)、フィンガープリント認証付きの固定 TLS、--watch によるリアルタイム再同期、そしてどの転送モードも無料でアカウント不要。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "sync は rsync の完全な代替になりますか?",
        a: "なりません。一方向のミラーしか行わず、rsync のようなブロック単位の差分アルゴリズムもありません——サイズやタイムスタンプが変わったファイルは丸ごと再送され、フラグの数も rsync よりずっと少ないです。双方向の同期やきめ細かいフィルター制御が必要な場合、あるいは rsync の成熟したエコシステムに頼りたい場合は、rsync の方が今も優れた道具です。",
      },
      {
        q: "sync に SSH サーバーは必要ですか?",
        a: "いいえ。デーモン直結(relayium://host:port)は SSH を完全に省きます。固定された TLS 接続で、受信側のフィンガープリントによって認証され、一度承認すれば以後は記憶されます。SSH 経由(user@host:path)を選ぶこともできますが、リモートに relayium がインストールされている必要があり、push と違って sync に tar フォールバックはありません。",
      },
      {
        q: "sync はソース側で削除したファイルを削除しますか?",
        a: "--delete を渡し、かつ受信側の serve が --allow-delete で起動されている場合だけです。そうでなければ削除要求は拒否され、黙って無視されるのではなく送信側に報告されます。",
      },
      {
        q: "リアルタイムで継続的に同期できますか?",
        a: "できます。--watch を付けてください。最初のミラーが終わった後も sync は動き続け、ソース配下でファイルが変化するたびに(デバウンスしつつ)再ミラーします。",
      },
      {
        q: "これは無料ですか?",
        a: "はい。Relayium CLI は完全に無料で、sync を含めどのモードもアカウントは不要です。",
      },
    ],
  },
  cta: {
    text: "自分の2台のマシンの間でフォルダーをミラーリングしましょう——SSH サーバーは不要です。",
    button: "CLI を入手する",
    href: "/cli",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs rsync: SSH 설정 없이 폴더 동기화하기",
  description:
    "Relayium sync와 rsync를 공정하게 비교합니다. rsync는 성숙하고 강력한 표준이지만, Relayium sync는 그 힘의 일부를 내려놓는 대신 설정을 줄이고 SSH 서버 없이도 네트워크를 넘나듭니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "rsync가 1996년부터 폴더를 미러링해 온 데는 이유가 있습니다. 양방향 동기화, 롤링 체크섬으로 파일 내부에서 실제로 바뀐 바이트만 전송하는 델타 알고리즘, 그리고 온갖 예외 상황을 다루는 수십 년치 플래그입니다. 이미 SSH 접근 권한이 있고 rsync를 잘 안다면, 이를 능가하기는 매우 어렵습니다.",
    "Relayium의 sync 명령은 더 좁은 범위——단방향 증분 미러——만 다루지만, rsync가 이미 되어 있다고 가정하는 한 단계, 즉 SSH 설정을 없애줍니다. 이미 SSH가 있다면 그 위에서 동작하고, 없다면 SSH 서버 없이 두 기기를 직접 연결합니다. 이 글은 둘을 정직하게 비교합니다. sync는 rsync의 완전한 대체품이 아니며, FAQ에서도 이를 분명히 밝힙니다.",
  ],
  sections: [
    {
      heading: "rsync가 잘하는 것",
      body: [
        "rsync는 양방향입니다——어느 쪽이든 소스가 될 수 있습니다——그리고 델타 전송 알고리즘은 롤링 체크섬으로 파일의 블록을 비교하므로, 거대한 파일에 작은 수정을 가해도 바뀐 블록만 보내고 파일 전체를 다시 보내지 않습니다. 여기에 수십 년치 플래그(--exclude, 하드링크 스냅샷용 --link-dest, 압축, 대역폭 제한 등)가 더해져 많은 작업에 알맞은 도구가 됩니다.",
        "또한 어디에나 있습니다. 대부분의 Linux와 macOS에 기본 포함되어 있고, 이미 설정해 두었을 SSH 연결 위에서 동작합니다. 이 중 어느 것도 Relayium sync가 대체하려는 것이 아닙니다.",
      ],
    },
    {
      heading: "Relayium sync의 방식",
      body: [
        "relayium sync <소스...> <대상> [--delete] [--watch]는 단방향 증분 미러입니다. 각 파일의 크기와 수정 시각을 비교해 이미 일치하는 것은 건너뛰고 나머지만 보냅니다.",
        "두 가지 전송 방식으로 동작합니다. user@host:/dest를 가리키면 SSH로 동작하지만——원격에 이미 relayium이 설치되어 있어야 합니다. push와 달리 sync에는 tar 폴백이 없습니다. 대신 relayium://host[:port]를 가리키면 SSH를 완전히 건너뜁니다. 고정된 TLS 1.3 연결로 상대 기기에서 실행 중인 relayium serve 리스너에 직접 연결되며, 그 기기의 핑거프린트로 인증됩니다(한 번 승인하면 이후로는 기억됩니다). 이 두 번째 경로가 진짜 편리한 부분입니다. sshd를 설정할 필요도, SSH 키를 관리할 필요도 없이, relayium이 설치된 두 기기와 그 사이의 열린 포트 하나만 있으면 됩니다.",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "삭제와 지속적인 동기화",
      body: [
        "기본적으로 sync는 추가와 갱신만 합니다——스스로 무언가를 삭제하는 일은 없습니다. 삭제까지 미러링하려면 --delete를 넘기되, 받는 쪽이 명시적으로 동의해야 합니다. relayium serve --allow-delete로 실행 중이어야 합니다. 그렇지 않으면 삭제 요청은 조용히 무시되는 대신 거부되고 보내는 쪽에 보고됩니다.",
        "계속 바뀌는 폴더라면 --watch를 붙이세요. 첫 동기화 이후에도 sync가 계속 실행되며, 소스 아래 파일이 바뀔 때마다 다시 미러링합니다——이에 해당하는 기능이 rsync에는 내장되어 있지 않아, 보통 cron 작업이나 lsyncd 같은 래퍼를 써야 합니다.",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "무결성, 재개, 그리고 정직한 한계",
      body: [
        "모든 파일은 SHA-256 해시로 끝에서 끝까지 검증되며, 파일 전송 도중 끊긴 전송은 디스크에 이미 있는 바이트 오프셋부터 재개합니다——처음부터 다시 하지 않습니다. rsync의 재개와 같은 이유로 유용합니다.",
        "다만 재개가 무엇이 아닌지는 분명히 해 둘 필요가 있습니다. rsync의 델타 알고리즘이 아닙니다. 파일이 이미 완전히 존재하더라도 크기나 타임스탬프가 다르면, sync는 내부의 바뀐 블록을 비교하는 대신 파일 전체를 다시 보냅니다. 자주 조금씩 바뀌는 거대한 파일 하나에 대해서는, rsync의 델타 전송이 실제로 더 적은 데이터를 옮깁니다. sync는 일반 파일만 다룹니다——심링크와 특수 파일은 건너뛰므로, 이를 필요로 하는 경우 별도로 처리해야 합니다.",
      ],
    },
    {
      heading: "rsync가 여전히 더 나은 도구일 때",
      body: [
        "양방향 동기화가 필요할 때, 이미 SSH가 설정되어 있어 또 다른 데몬을 돌리고 싶지 않을 때, 세밀한 제어(제외 규칙, 필터, 하드링크 스냅샷, 대역폭 제한, 압축)가 필요할 때, 또는 파일 하나가 자주 조금씩 바뀌어 델타 전송이 실제로 대역폭을 아껴줄 때는 rsync를 선택하세요. Relayium sync는 이 중 어느 것도 다루려 하지 않습니다.",
      ],
      bullets: [
        "단방향뿐: sync는 소스 → 대상만 미러링합니다; rsync는 어느 방향으로든 동작합니다.",
        "델타 전송 없음: sync는 바뀐 파일을 통째로 다시 보냅니다; rsync의 롤링 체크섬은 바뀐 블록만 보냅니다.",
        "옵션이 더 적음: rsync는 필터링, 압축, 스냅샷을 위한 수십 년치 플래그를 갖고 있습니다; sync에는 --delete와 --watch뿐입니다.",
        "Relayium sync가 이기는 지점: SSH 서버 불필요(데몬 다이렉트), 핑거프린트 인증이 붙은 고정 TLS, --watch를 통한 실시간 재동기화, 그리고 어떤 전송 모드든 무료에 계정도 필요 없습니다.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "sync가 rsync를 완전히 대체할 수 있나요?",
        a: "아닙니다. 단방향 미러링만 하며, rsync 같은 블록 단위 델타 알고리즘도 없습니다——크기나 타임스탬프가 바뀐 파일은 통째로 다시 보내지고, 플래그 수도 rsync보다 훨씬 적습니다. 양방향 동기화나 세밀한 필터 제어가 필요하거나 rsync의 성숙한 생태계에 기대고 싶다면, rsync가 여전히 더 나은 도구입니다.",
      },
      {
        q: "sync에 SSH 서버가 필요한가요?",
        a: "아니요. 데몬 다이렉트(relayium://host:port)는 SSH를 완전히 건너뜁니다. 고정된 TLS 연결로, 받는 쪽의 핑거프린트로 인증되며, 한 번 승인하면 이후로는 기억됩니다. SSH(user@host:path)를 통해서도 동작할 수 있지만 원격에 relayium이 설치되어 있어야 하며, push와 달리 sync에는 tar 폴백이 없습니다.",
      },
      {
        q: "sync가 소스에서 지운 파일을 삭제하나요?",
        a: "--delete를 넘기고, 받는 쪽의 serve가 --allow-delete로 실행 중일 때만 그렇습니다. 그렇지 않으면 삭제 요청은 거부되고 보내는 쪽에 보고되며, 조용히 무시되지 않습니다.",
      },
      {
        q: "실시간으로 지속 동기화할 수 있나요?",
        a: "네, --watch를 붙이세요. 첫 미러링 이후에도 sync가 계속 실행되며, 소스 아래 파일이 바뀔 때마다(디바운스하며) 다시 미러링합니다.",
      },
      {
        q: "무료인가요?",
        a: "네. Relayium CLI는 완전히 무료이며, sync를 포함한 어떤 모드도 계정이 필요 없습니다.",
      },
    ],
  },
  cta: {
    text: "당신 소유의 두 기기 사이에서 폴더를 미러링하세요——SSH 서버가 필요 없습니다.",
    button: "CLI 받기",
    href: "/cli",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. rsync: Ordner synchronisieren ohne SSH-Setup",
  description:
    "Ein fairer Vergleich: rsync ist der ausgereifte, mächtige Standard zum Spiegeln von Ordnern; Relayium sync tauscht einen Teil dieser Macht gegen weniger Einrichtungsaufwand und funktioniert netzwerkübergreifend ohne SSH-Server.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "rsync spiegelt seit 1996 Ordner, und das aus gutem Grund: bidirektionale Synchronisation, ein Delta-Algorithmus mit Rolling-Checksum, der nur die tatsächlich veränderten Bytes innerhalb einer Datei überträgt, und Jahrzehnte an Flags für jeden Grenzfall. Wenn du schon SSH-Zugang hast und rsync kennst, ist es sehr schwer zu schlagen.",
    "Relayiums sync-Befehl deckt eine engere Aufgabe ab — einen einseitigen inkrementellen Spiegel —, entfernt aber einen Schritt, den rsync als bereits erledigt voraussetzt: das Einrichten von SSH. sync läuft über SSH, falls vorhanden, oder verbindet zwei Maschinen direkt, ganz ohne SSH-Server. Dieser Artikel vergleicht beide ehrlich: sync ist kein vollständiger Ersatz für rsync, und die FAQ sagt das unumwunden.",
  ],
  sections: [
    {
      heading: "Was rsync richtig macht",
      body: [
        "rsync ist bidirektional — jede Seite kann die Quelle sein — und sein Delta-Transfer-Algorithmus vergleicht Blöcke einer Datei per Rolling-Checksum, sodass eine kleine Änderung an einer riesigen Datei nur die veränderten Blöcke sendet, nicht die ganze Datei erneut. Zusammen mit Jahrzehnten an Flags (--exclude, --link-dest für Hardlink-Snapshots, Kompression, Bandbreitenlimits und mehr) macht das rsync zum richtigen Werkzeug für sehr viele Aufgaben.",
        "Es ist außerdem überall vorhanden: Die meisten Linux- und macOS-Systeme bringen es mit, und es läuft über eine SSH-Verbindung, die wahrscheinlich schon konfiguriert ist. Nichts davon versucht Relayium sync zu ersetzen.",
      ],
    },
    {
      heading: "Was Relayium sync stattdessen macht",
      body: [
        "relayium sync <Quelle...> <Ziel> [--delete] [--watch] ist ein einseitiger inkrementeller Spiegel: Er vergleicht Größe und Änderungszeit jeder Datei, überspringt, was schon übereinstimmt, und sendet den Rest.",
        "Es funktioniert über zwei Transportwege. Zeigst du auf user@host:/dest, läuft es über SSH — relayium muss dafür aber schon auf der Gegenseite installiert sein; anders als bei push gibt es für sync keinen tar-Fallback. Zeigst du stattdessen auf relayium://host[:port], wird SSH komplett übersprungen: eine gepinnte TLS-1.3-Verbindung direkt zu einem relayium serve-Listener auf der anderen Maschine, authentifiziert über deren Fingerprint (einmal genehmigt, danach gemerkt). Dieser zweite Weg ist der eigentliche Komfort: kein sshd einzurichten, keine SSH-Schlüssel zu verwalten — nur zwei Maschinen mit installiertem relayium und einem offenen Port dazwischen.",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "Löschungen und fortlaufende Synchronisation",
      body: [
        "Standardmäßig fügt sync nur hinzu und aktualisiert — es löscht nie von sich aus etwas. Übergib --delete, um auch Löschungen zu spiegeln, aber der Empfänger muss dem zustimmen: Er muss mit relayium serve --allow-delete laufen. Ist das nicht der Fall, wird die Löschanfrage abgelehnt und an den Sender zurückgemeldet, statt sie stillschweigend zu ignorieren.",
        "Für einen Ordner, der sich fortlaufend ändert, hält --watch sync nach dem ersten Durchlauf am Laufen und spiegelt erneut, sobald sich eine Datei unter der Quelle ändert — dafür hat rsync nichts Eingebautes; normalerweise greift man zu einem Cron-Job oder einem Wrapper wie lsyncd.",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "Integrität, Fortsetzung und die ehrlichen Grenzen",
      body: [
        "Jede Datei wird Ende-zu-Ende mit einem SHA-256-Hash geprüft, und eine mitten in einer Datei abgebrochene Übertragung setzt beim bereits auf der Platte liegenden Byte-Offset fort, statt neu zu beginnen — aus denselben Gründen nützlich wie bei rsync.",
        "Klar sein sollte, was Fortsetzen nicht ist: nicht rsyncs Delta-Algorithmus. Ist eine Datei bereits vollständig vorhanden, hat aber eine andere Größe oder einen anderen Zeitstempel, überträgt sync sie komplett erneut, statt veränderte Blöcke darin zu diffen. Bei einer einzelnen riesigen Datei, die sich häufig geringfügig ändert, bewegt rsyncs Delta-Transfer weniger Daten. sync behandelt außerdem nur reguläre Dateien — Symlinks und Spezialdateien werden übersprungen, wer darauf angewiesen ist, muss das separat handhaben.",
      ],
    },
    {
      heading: "Wann rsync noch immer das bessere Werkzeug ist",
      body: [
        "Wähle rsync, wenn die Synchronisation in beide Richtungen gehen muss, wenn SSH bereits eingerichtet ist und du keinen weiteren Daemon willst, wenn du feingranulare Kontrolle brauchst (Ausschlüsse, Filter, Hardlink-Snapshots, Bandbreitenlimits, Kompression), oder wenn sich eine Datei häufig geringfügig ändert und Delta-Transfer echte Bandbreite spart. Relayium sync versucht nichts davon abzudecken.",
      ],
      bullets: [
        "Nur einseitig: sync spiegelt Quelle → Ziel; rsync kann in beide Richtungen.",
        "Kein Delta-Transfer: sync sendet eine veränderte Datei komplett neu; rsyncs Rolling-Checksum sendet nur veränderte Blöcke.",
        "Weniger Optionen: rsync hat Jahrzehnte an Flags für Filterung, Kompression und Snapshots; sync hat --delete und --watch.",
        "Wo Relayium sync gewinnt: kein SSH-Server nötig (Daemon Direct), gepinntes TLS mit Fingerprint-Authentifizierung, Echtzeit-Resync mit --watch, und es ist für jeden Übertragungsmodus kostenlos und ohne Konto.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Kann sync rsync vollständig ersetzen?",
        a: "Nein. Es macht nur einseitiges Spiegeln und hat keinen blockweisen Delta-Algorithmus wie rsync — eine Datei mit anderer Größe oder anderem Zeitstempel wird komplett neu übertragen, und es gibt deutlich weniger Flags als bei rsync. Wenn du bidirektionale Synchronisation, feingranulare Filterkontrolle brauchst oder dich auf rsyncs ausgereiftes Ökosystem verlassen willst, ist rsync weiterhin das bessere Werkzeug.",
      },
      {
        q: "Braucht sync einen SSH-Server?",
        a: "Nein. Daemon Direct (relayium://host:port) überspringt SSH komplett: eine gepinnte TLS-Verbindung, authentifiziert über den Fingerprint des Empfängers, einmal genehmigt und danach gemerkt. Du kannst auch über SSH gehen (user@host:path), dann muss relayium aber auf der Gegenseite installiert sein — und anders als bei push gibt es für sync keinen tar-Fallback.",
      },
      {
        q: "Löscht sync Dateien, die ich aus der Quelle entfernt habe?",
        a: "Nur wenn du --delete übergibst und der Empfänger sein serve mit --allow-delete betreibt. Andernfalls wird die Löschanfrage abgelehnt und an den Sender zurückgemeldet, statt stillschweigend ignoriert zu werden.",
      },
      {
        q: "Kann ich in Echtzeit fortlaufend synchronisieren?",
        a: "Ja, mit --watch. Nach dem ersten Spiegeln läuft sync weiter und spiegelt (entprellt) erneut, sobald sich eine Datei unter der Quelle ändert.",
      },
      {
        q: "Ist das kostenlos?",
        a: "Ja. Die Relayium-CLI ist vollständig kostenlos, und kein Modus — sync eingeschlossen — braucht ein Konto.",
      },
    ],
  },
  cta: {
    text: "Spiegle einen Ordner zwischen zwei eigenen Maschinen — ganz ohne SSH-Server.",
    button: "CLI holen",
    href: "/cli",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs rsync : synchroniser des dossiers sans configurer SSH",
  description:
    "Un comparatif honnête : rsync est la référence mature et puissante pour refléter des dossiers ; Relayium sync échange une partie de cette puissance contre moins de configuration et fonctionne entre réseaux sans serveur SSH.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "rsync reflète des dossiers depuis 1996, et ce n'est pas un hasard : synchronisation bidirectionnelle, un algorithme de transfert différentiel à somme de contrôle glissante qui ne transmet que les octets réellement modifiés à l'intérieur d'un fichier, et des décennies d'options pour chaque cas particulier. Si vous avez déjà un accès SSH et connaissez rsync, il est très difficile à surpasser.",
    "La commande sync de Relayium couvre une tâche plus étroite — un miroir incrémental à sens unique — mais elle supprime une étape que rsync suppose déjà faite : la configuration de SSH. Elle fonctionne par SSH si vous en avez déjà un, ou connecte directement deux machines sans aucun serveur SSH. Cet article compare les deux honnêtement : sync n'est pas un remplacement complet de rsync, et la FAQ le dit clairement.",
  ],
  sections: [
    {
      heading: "Ce que rsync fait très bien",
      body: [
        "rsync est bidirectionnel — n'importe quel côté peut être la source — et son algorithme de transfert différentiel compare les blocs d'un fichier par somme de contrôle glissante, si bien qu'une petite modification dans un fichier énorme n'envoie que les blocs changés, pas le fichier entier. Ajoutez à cela des décennies d'options (--exclude, --link-dest pour des instantanés par liens durs, la compression, des limites de bande passante, et plus), et vous obtenez le bon outil pour énormément de tâches.",
        "Il est aussi partout : la plupart des systèmes Linux et macOS l'incluent, et il fonctionne sur une connexion SSH que vous avez probablement déjà configurée. Rien de tout cela n'est ce que Relayium sync cherche à remplacer.",
      ],
    },
    {
      heading: "Ce que fait Relayium sync à la place",
      body: [
        "relayium sync <sources...> <destination> [--delete] [--watch] est un miroir incrémental à sens unique : il compare la taille et la date de modification de chaque fichier, ignore ce qui correspond déjà, et envoie le reste.",
        "Il fonctionne via deux transports. Pointez-le vers user@host:/dest et il passe par SSH — mais relayium doit déjà être installé sur la machine distante ; contrairement à push, sync n'a pas de repli tar. Pointez-le plutôt vers relayium://host[:port] et il se passe entièrement de SSH : une connexion TLS 1.3 épinglée directement vers un processus relayium serve à l'écoute sur l'autre machine, authentifiée par l'empreinte de cette machine (approuvée une fois, mémorisée ensuite). C'est cette seconde voie qui apporte le vrai confort : pas de sshd à configurer, pas de clés SSH à gérer — juste deux machines avec relayium installé et un port ouvert entre elles.",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "Suppressions et synchronisation continue",
      body: [
        "Par défaut, sync ne fait qu'ajouter et mettre à jour — il ne supprime jamais rien de lui-même. Passez --delete pour refléter aussi les suppressions, mais le récepteur doit y consentir explicitement : il doit tourner avec relayium serve --allow-delete. Sinon, la demande de suppression est refusée et signalée à l'expéditeur plutôt qu'ignorée silencieusement.",
        "Pour un dossier qui change en continu, --watch fait tourner sync après le premier passage et reflète de nouveau dès qu'un fichier change sous la source — rsync n'a rien d'intégré pour cela ; on se tourne normalement vers une tâche cron ou un outil comme lsyncd.",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "Intégrité, reprise, et les limites honnêtes",
      body: [
        "Chaque fichier est vérifié de bout en bout par un hachage SHA-256, et un transfert interrompu en plein milieu d'un fichier reprend à partir de l'octet déjà présent sur le disque plutôt que de tout recommencer — utile pour les mêmes raisons que chez rsync.",
        "Il faut être clair sur ce que la reprise n'est pas : ce n'est pas l'algorithme différentiel de rsync. Si un fichier est déjà entièrement présent mais a une taille ou un horodatage différent, sync le retransmet en entier plutôt que de comparer les blocs modifiés à l'intérieur. Pour un unique fichier énorme qui change légèrement et souvent, le transfert différentiel de rsync déplacera moins de données. sync ne gère aussi que les fichiers réguliers — les liens symboliques et fichiers spéciaux sont ignorés, donc tout ce qui en dépend doit être traité séparément.",
      ],
    },
    {
      heading: "Quand rsync reste le meilleur outil",
      body: [
        "Choisissez rsync quand la synchronisation doit aller dans les deux sens, quand SSH est déjà configuré et que vous ne voulez pas d'un démon supplémentaire, quand vous avez besoin d'un contrôle fin (exclusions, filtres, instantanés par liens durs, limites de bande passante, compression), ou quand un fichier change légèrement et souvent et que le transfert différentiel économise vraiment de la bande passante. Relayium sync ne cherche à couvrir aucun de ces cas.",
      ],
      bullets: [
        "Sens unique seulement : sync reflète la source vers la destination ; rsync peut aller dans les deux sens.",
        "Pas de transfert différentiel : sync retransmet un fichier modifié en entier ; la somme de contrôle glissante de rsync n'envoie que les blocs modifiés.",
        "Moins d'options : rsync a des décennies d'options pour le filtrage, la compression et les instantanés ; sync n'a que --delete et --watch.",
        "Là où Relayium sync l'emporte : pas de serveur SSH requis (démon direct), TLS épinglé avec authentification par empreinte, resynchronisation en temps réel avec --watch, et c'est gratuit sans compte pour n'importe quel mode de transfert.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "sync peut-il remplacer complètement rsync ?",
        a: "Non. Il ne fait qu'un miroir à sens unique et n'a pas d'algorithme différentiel par blocs comme rsync — un fichier dont la taille ou l'horodatage a changé est retransmis en entier, et il a beaucoup moins d'options que rsync. Si vous avez besoin d'une synchronisation bidirectionnelle, d'un contrôle fin par filtres, ou si vous comptez sur l'écosystème mature de rsync, rsync reste le meilleur outil.",
      },
      {
        q: "sync a-t-il besoin d'un serveur SSH ?",
        a: "Non. Le mode démon direct (relayium://host:port) se passe entièrement de SSH : une connexion TLS épinglée, authentifiée par l'empreinte du récepteur, approuvée une fois puis mémorisée. Vous pouvez aussi passer par SSH (user@host:path), mais relayium doit alors être installé sur la machine distante — et contrairement à push, sync n'a pas de repli tar.",
      },
      {
        q: "sync supprime-t-il les fichiers que j'ai retirés de la source ?",
        a: "Seulement si vous passez --delete et que le serve du récepteur tourne avec --allow-delete. Sinon, la demande de suppression est refusée et signalée à l'expéditeur, pas ignorée silencieusement.",
      },
      {
        q: "Puis-je synchroniser en continu et en temps réel ?",
        a: "Oui, avec --watch. Après le premier miroir, sync continue de tourner et reflète de nouveau (avec un anti-rebond) dès qu'un fichier change sous la source.",
      },
      {
        q: "Est-ce gratuit ?",
        a: "Oui. La CLI Relayium est entièrement gratuite, et aucun mode — sync compris — ne nécessite de compte.",
      },
    ],
  },
  cta: {
    text: "Reflétez un dossier entre deux de vos propres machines — sans serveur SSH requis.",
    button: "Obtenir la CLI",
    href: "/cli",
  },
  relatedHeading: "À lire ensuite",
};

const ar = {
  title: "Relayium مقابل rsync: زامِن المجلدات دون إعداد SSH",
  description:
    "مقارنة عادلة: إن rsync هو المعيار الناضج والقوي لعكس المجلدات؛ أما Relayium sync فيقايض بعضاً من تلك القوة بإعداد أقل، ويعمل عبر الشبكات دون خادم SSH.",
  updatedLabel: "آخر تحديث",
  lead: [
    "يعكس rsync المجلدات منذ عام 1996 لسبب وجيه: مزامنة ثنائية الاتجاه، وخوارزمية دلتا بمجموع تحقّق متدحرج تنقل فقط البايتات التي تغيّرت فعلاً داخل الملف، وعقود من الأعلام لكل حالة حافّة. إن كان لديك أصلاً وصول SSH وتعرف rsync، فمن الصعب جداً التفوّق عليه.",
    "يغطّي أمر sync في Relayium مهمة أضيق — مرآة تزايدية أحادية الاتجاه — لكنه يزيل خطوة يفترض rsync أنك أنجزتها أصلاً: إعداد SSH. يعمل فوق SSH إن كان لديك، أو يصل جهازين مباشرة دون أي خادم SSH إطلاقاً. يقارن هذا المقال الاثنين بصدق؛ فليس sync بديلاً كاملاً عن rsync، والأسئلة الشائعة تقول ذلك بوضوح.",
  ],
  sections: [
    {
      heading: "ما يصيبه rsync",
      body: [
        "إن rsync ثنائي الاتجاه — أيّ جانب يمكن أن يكون المصدر — وتقارن خوارزمية النقل بالدلتا فيه كتل الملف بمجموع تحقّق متدحرج، فتعديل صغير على ملف ضخم يرسل الكتل المتغيّرة فقط، لا الملف كله من جديد. وذلك، إضافةً إلى عقود من الأعلام (--exclude و --link-dest للقطات الروابط الصلبة، والضغط، وحدود عرض النطاق، وأكثر)، يجعله الأداة المناسبة لكثير من المهام.",
        "وهو أيضاً في كل مكان: تأتي به معظم أنظمة Linux و macOS، ويعمل فوق اتصال SSH ربما أعددته أصلاً. لا شيء من ذلك يحاول Relayium sync استبداله.",
      ],
    },
    {
      heading: "ما يفعله Relayium sync بدلاً من ذلك",
      body: [
        "إن relayium sync <src...> <dest> [--delete] [--watch] مرآة تزايدية أحادية الاتجاه: يقارن حجم كل ملف ووقت تعديله، ويتخطّى ما يطابق أصلاً، ويرسل الباقي.",
        "يعمل عبر نقلين. وجّهه إلى user@host:/dest فيعمل فوق SSH — لكن يجب أن يكون relayium مثبَّتاً أصلاً على الطرف البعيد؛ وخلافاً لـ push، لا يوجد رجوع إلى tar في sync. وجّهه بدلاً من ذلك إلى relayium://host[:port] فيتخطّى SSH كلياً: اتصال TLS 1.3 مثبَّت مباشرة إلى مستمع relayium serve على الجهاز الآخر، مُصادَق عليه ببصمة ذلك الجهاز (يُوافَق عليها مرة، وتُذكَر بعد ذلك). هذا المسار الثاني هو الراحة الحقيقية: لا sshd لإعداده، ولا مفاتيح SSH لإدارتها — فقط جهازان عليهما relayium ومنفذ مفتوح بينهما.",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "الحذف والمزامنة المستمرة",
      body: [
        "افتراضياً لا يفعل sync سوى الإضافة والتحديث — ولا يحذف شيئاً من تلقاء نفسه أبداً. مرّر --delete لعكس عمليات الحذف أيضاً، لكن على المُستقبِل أن يوافق صراحةً: يجب أن يكون يعمل بـ relayium serve --allow-delete. وإن لم يكن كذلك، يُرفَض طلب الحذف ويُبلَّغ به المُرسِل بدل تجاهله بصمت.",
        "لمجلد يتغيّر باستمرار، يبقي --watch على تشغيل sync بعد المرور الأول ويعيد العكس كلما تغيّر ملف تحت المصدر — لا يملك rsync شيئاً مدمجاً لهذا؛ إذ تلجأ عادةً إلى مهمة cron أو غلاف مثل lsyncd.",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "السلامة والاستئناف والحدود الصادقة",
      body: [
        "يُتحقَّق من كل ملف من الطرف إلى الطرف بتجزئة SHA-256، والنقل الذي يُقطَع في منتصف ملف يُستأنَف من إزاحة البايت الموجودة أصلاً على القرص بدل البدء من جديد — مفيد للأسباب نفسها التي يفيد لها في rsync.",
        "كن واضحاً بشأن ما ليس الاستئناف: إنه ليس خوارزمية الدلتا في rsync. إن كان ملف موجوداً بالكامل أصلاً لكن بحجم أو طابع زمني مختلف، يعيد sync إرساله كاملاً بدل مقارنة الكتل المتغيّرة داخله. لملف ضخم واحد يتغيّر تغيّراً طفيفاً ومتكرراً، سينقل النقل بالدلتا في rsync بيانات أقل. كما يتعامل sync مع الملفات العادية فقط — تُتخطّى الروابط الرمزية والملفات الخاصة، فأي شيء يعتمد عليها يحتاج معالجة منفصلة.",
      ],
    },
    {
      heading: "متى يبقى rsync الأداة الأفضل",
      body: [
        "اختر rsync حين تحتاج إلى مزامنة في الاتجاهين، أو حين يكون SSH مُعدّاً أصلاً ولا تريد daemon آخر، أو حين تحتاج إلى تحكّم دقيق (استثناءات، ومرشّحات، ولقطات روابط صلبة، وحدود عرض نطاق، وضغط)، أو حين يتغيّر ملف تغيّراً طفيفاً ومتكرراً فيوفّر النقل بالدلتا عرض نطاق حقيقياً. لا يحاول Relayium sync تغطية أيٍّ من ذلك.",
      ],
      bullets: [
        "أحادي الاتجاه فقط: يعكس sync من المصدر ← الوجهة؛ أما rsync فيمكنه الذهاب في أيّ اتجاه.",
        "لا نقل بالدلتا: يعيد sync إرسال الملف المتغيّر كاملاً؛ أما مجموع التحقّق المتدحرج في rsync فيرسل الكتل المتغيّرة فقط.",
        "خيارات أقل: يملك rsync عقوداً من الأعلام للترشيح والضغط وأخذ اللقطات؛ أما sync فلديه --delete و --watch.",
        "أين يفوز Relayium sync: لا حاجة إلى خادم SSH (daemon direct)، و TLS مثبَّت بمصادقة بالبصمة، وإعادة مزامنة فورية بـ --watch، وهو مجاني بلا حساب لأي وضع نقل.",
      ],
    },
  ],
  faq: {
    heading: "الأسئلة الشائعة",
    items: [
      {
        q: "هل Relayium sync بديل كامل عن rsync؟",
        a: "لا. لا يفعل سوى عكس أحادي الاتجاه ولا يملك خوارزمية دلتا على مستوى الكتل مثل rsync — فالملف بحجم أو طابع زمني مختلف يُعاد إرساله كاملاً، وأعلامه أقلّ بكثير من rsync. إن احتجت إلى مزامنة ثنائية الاتجاه، أو تحكّم دقيق بالترشيح، أو أردت الاعتماد على منظومة rsync الناضجة، فإن rsync يبقى الأداة الأفضل.",
      },
      {
        q: "هل يحتاج sync إلى خادم SSH؟",
        a: "لا. يتخطّى daemon direct (relayium://host:port) SSH كلياً: اتصال TLS مثبَّت، مُصادَق عليه ببصمة المُستقبِل، يُوافَق عليها مرة وتُذكَر بعد ذلك. يمكنك أيضاً المرور عبر SSH (user@host:path)، لكن يجب أن يكون relayium مثبَّتاً على الطرف البعيد لذلك — وخلافاً لـ push، لا يوجد رجوع إلى tar في sync.",
      },
      {
        q: "هل يحذف sync الملفات التي أزلتها من المصدر؟",
        a: "فقط إن مرّرت --delete وكان serve لدى المُستقبِل يعمل بـ --allow-delete. وإلا يُرفَض طلب الحذف ويُبلَّغ به المُرسِل، لا يُتجاهَل بصمت.",
      },
      {
        q: "هل يمكنه المزامنة باستمرار وفي الوقت الفعلي؟",
        a: "نعم، مع --watch. بعد المرآة الأولى، يبقى sync يعمل ويعيد العكس (مع تخفيف الارتداد) كلما تغيّر ملف تحت المصدر.",
      },
      {
        q: "هل هو مجاني؟",
        a: "نعم. إن CLI الخاص بـ Relayium مجاني تماماً، ولا يحتاج أي وضع — بما فيه sync — إلى حساب.",
      },
    ],
  },
  cta: {
    text: "اعكس مجلداً بين جهازين من أجهزتك — دون حاجة إلى خادم SSH.",
    button: "احصل على CLI",
    href: "/cli",
  },
  relatedHeading: "تابع القراءة",
};

const es = {
  title: "Relayium vs rsync: sincroniza carpetas sin la configuración de SSH",
  description:
    "Una comparación justa: rsync es el estándar maduro y potente para reflejar carpetas; Relayium sync cede parte de esa potencia a cambio de menos configuración y funciona entre redes sin un servidor SSH.",
  updatedLabel: "Última actualización",
  lead: [
    "rsync refleja carpetas desde 1996 por una razón: sincronización bidireccional, un algoritmo de delta con suma de comprobación rodante que transfiere solo los bytes que realmente cambiaron dentro de un archivo, y décadas de opciones para cada caso límite. Si ya tienes acceso SSH y conoces rsync, es muy difícil de superar.",
    "El comando sync de Relayium cubre un trabajo más estrecho — un espejo incremental de un solo sentido — pero elimina un paso que rsync da por hecho que ya has realizado: configurar SSH. Se ejecuta sobre SSH si ya lo tienes, o conecta dos máquinas directamente sin ningún servidor SSH. Este artículo compara ambos con honestidad; sync no es un reemplazo completo de rsync, y las preguntas frecuentes lo dicen claramente.",
  ],
  sections: [
    {
      heading: "Lo que rsync hace bien",
      body: [
        "rsync es bidireccional — cualquiera de los dos lados puede ser el origen — y su algoritmo de transferencia delta compara bloques de un archivo con una suma de comprobación rodante, de modo que una pequeña edición en un archivo enorme solo envía los bloques cambiados, no el archivo entero otra vez. Eso, más décadas de opciones (--exclude, --link-dest para instantáneas con enlaces duros, compresión, límites de ancho de banda y más), lo convierten en la herramienta adecuada para muchos trabajos.",
        "También está en todas partes: la mayoría de los sistemas Linux y macOS lo incluyen, y funciona sobre una conexión SSH que probablemente ya configuraste. Nada de eso es algo que Relayium sync intente reemplazar.",
      ],
    },
    {
      heading: "Lo que hace Relayium sync en su lugar",
      body: [
        "relayium sync <src...> <dest> [--delete] [--watch] es un espejo incremental de un solo sentido: compara el tamaño y la hora de modificación de cada archivo, omite lo que ya coincide y envía el resto.",
        "Funciona sobre dos transportes. Apúntalo a user@host:/dest y se ejecuta sobre SSH — pero relayium ya debe estar instalado en el remoto; a diferencia de push, no hay respaldo tar para sync. Apúntalo en cambio a relayium://host[:port] y se salta SSH por completo: una conexión TLS 1.3 fijada directamente a un proceso a la escucha relayium serve en la otra máquina, autenticada por la huella de esa máquina (aprobada una vez, recordada después). Esa segunda vía es la verdadera comodidad: ningún sshd que configurar, ninguna clave SSH que gestionar — solo dos máquinas con relayium instalado y un puerto abierto entre ellas.",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "Eliminaciones y sincronización continua",
      body: [
        "Por defecto sync solo añade y actualiza — nunca elimina nada por su cuenta. Pasa --delete para reflejar también las eliminaciones, pero el receptor tiene que optar por ello: debe estar ejecutando relayium serve --allow-delete. Si no lo está, la solicitud de eliminación se rechaza y se informa de vuelta al remitente en lugar de ignorarse en silencio.",
        "Para una carpeta que cambia continuamente, --watch mantiene sync en marcha tras la primera pasada y vuelve a reflejar cada vez que un archivo cambia bajo el origen — rsync no tiene nada incorporado para esto; normalmente recurrirías a una tarea cron o a un envoltorio como lsyncd.",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "Integridad, reanudación y los límites honestos",
      body: [
        "Cada archivo se verifica de extremo a extremo con un hash SHA-256, y una transferencia que se corta a mitad de un archivo se reanuda desde el desplazamiento de byte que ya está en disco en lugar de reiniciarse — útil por las mismas razones que en rsync.",
        "Deja claro qué no es la reanudación: no es el algoritmo delta de rsync. Si un archivo ya está completamente presente pero tiene un tamaño o una marca de tiempo diferente, sync lo retransmite entero en vez de comparar los bloques cambiados dentro de él. Para un único archivo enorme que cambia ligeramente y a menudo, la transferencia delta de rsync moverá menos datos. sync además solo maneja archivos normales — los enlaces simbólicos y los archivos especiales se omiten, así que cualquier cosa que dependa de ellos necesita tratarse por separado.",
      ],
    },
    {
      heading: "Cuándo rsync sigue siendo la mejor herramienta",
      body: [
        "Elige rsync cuando necesites que la sincronización vaya en ambos sentidos, cuando ya tengas SSH configurado y no quieras otro daemon, cuando necesites control preciso (exclusiones, filtros, instantáneas con enlaces duros, límites de ancho de banda, compresión), o cuando un archivo cambie ligeramente y a menudo y la transferencia delta ahorre ancho de banda de verdad. Relayium sync no intenta cubrir nada de eso.",
      ],
      bullets: [
        "Solo un sentido: sync refleja origen → destino; rsync puede ir en cualquier dirección.",
        "Sin transferencia delta: sync reenvía entero un archivo cambiado; la suma de comprobación rodante de rsync envía solo los bloques cambiados.",
        "Menos opciones: rsync tiene décadas de opciones para filtrar, comprimir y hacer instantáneas; sync tiene --delete y --watch.",
        "Dónde gana Relayium sync: no requiere servidor SSH (daemon directo), TLS fijado con autenticación por huella, resincronización en tiempo real con --watch, y es gratis y sin cuenta para cualquier modo de transferencia.",
      ],
    },
  ],
  faq: {
    heading: "Preguntas frecuentes",
    items: [
      {
        q: "¿Es Relayium sync un reemplazo completo de rsync?",
        a: "No. Solo hace espejo de un solo sentido y no tiene un algoritmo delta a nivel de bloque como rsync — un archivo con un tamaño o una marca de tiempo diferente se retransmite entero, y tiene muchas menos opciones que rsync. Si necesitas sincronización bidireccional, control preciso de filtros, o quieres apoyarte en el ecosistema maduro de rsync, rsync sigue siendo la mejor herramienta.",
      },
      {
        q: "¿sync necesita un servidor SSH?",
        a: "No. El daemon directo (relayium://host:port) se salta SSH por completo: una conexión TLS fijada, autenticada por la huella del receptor, aprobada una vez y recordada después. También puedes ir sobre SSH (user@host:path), pero relayium debe estar instalado en el remoto para eso — y a diferencia de push, no hay respaldo tar para sync.",
      },
      {
        q: "¿sync elimina los archivos que quité del origen?",
        a: "Solo si pasas --delete y el serve del receptor se está ejecutando con --allow-delete. De lo contrario, la solicitud de eliminación se rechaza y se informa de vuelta al remitente, no se ignora en silencio.",
      },
      {
        q: "¿Puede sincronizar continuamente en tiempo real?",
        a: "Sí, con --watch. Tras el espejo inicial, sync sigue en marcha y vuelve a reflejar (con antirrebote) cada vez que un archivo cambia bajo el origen.",
      },
      {
        q: "¿Es gratis?",
        a: "Sí. La CLI de Relayium es completamente gratis, y ningún modo — sync incluido — necesita cuenta.",
      },
    ],
  },
  cta: {
    text: "Refleja una carpeta entre dos de tus propias máquinas — sin necesidad de un servidor SSH.",
    button: "Obtener la CLI",
    href: "/cli",
  },
  relatedHeading: "Seguir leyendo",
};

const pt = {
  title: "Relayium vs rsync: sincronize pastas sem a configuração de SSH",
  description:
    "Uma comparação justa: o rsync é o padrão maduro e poderoso para espelhar pastas; o Relayium sync abre mão de parte dessa força em troca de menos configuração e funciona entre redes sem um servidor SSH.",
  updatedLabel: "Última atualização",
  lead: [
    "O rsync espelha pastas desde 1996 por um motivo: sincronização bidirecional, um algoritmo de delta com soma de verificação rolante que transfere apenas os bytes que de fato mudaram dentro de um arquivo, e décadas de flags para cada caso extremo. Se você já tem acesso SSH e conhece o rsync, é muito difícil superá-lo.",
    "O comando sync do Relayium cobre um trabalho mais estreito — um espelho incremental de sentido único — mas remove uma etapa que o rsync presume que você já fez: configurar o SSH. Ele roda sobre SSH se você já tiver, ou conecta duas máquinas diretamente sem nenhum servidor SSH. Este artigo compara os dois com honestidade; o sync não é um substituto completo do rsync, e as perguntas frequentes dizem isso claramente.",
  ],
  sections: [
    {
      heading: "O que o rsync acerta",
      body: [
        "O rsync é bidirecional — qualquer um dos lados pode ser a origem — e seu algoritmo de transferência delta compara blocos de um arquivo com uma soma de verificação rolante, de modo que uma pequena edição em um arquivo enorme só envia os blocos alterados, não o arquivo inteiro de novo. Isso, mais décadas de flags (--exclude, --link-dest para snapshots com hard links, compressão, limites de banda e mais), fazem dele a ferramenta certa para muitos trabalhos.",
        "Ele também está em toda parte: a maioria dos sistemas Linux e macOS já vem com ele, e funciona sobre uma conexão SSH que você provavelmente já configurou. Nada disso é algo que o Relayium sync tente substituir.",
      ],
    },
    {
      heading: "O que o Relayium sync faz em vez disso",
      body: [
        "relayium sync <src...> <dest> [--delete] [--watch] é um espelho incremental de sentido único: ele compara o tamanho e a hora de modificação de cada arquivo, pula o que já corresponde e envia o resto.",
        "Ele funciona sobre dois transportes. Aponte-o para user@host:/dest e ele roda sobre SSH — mas o relayium já precisa estar instalado no remoto; diferente do push, não há recurso de reserva tar para o sync. Aponte-o em vez disso para relayium://host[:port] e ele pula o SSH inteiramente: uma conexão TLS 1.3 fixada diretamente a um processo relayium serve à escuta na outra máquina, autenticada pela impressão digital dessa máquina (aprovada uma vez, lembrada depois). Essa segunda via é a real conveniência: nenhum sshd para configurar, nenhuma chave SSH para gerenciar — apenas duas máquinas com o relayium instalado e uma porta aberta entre elas.",
      ],
      code: [
        `relayium sync ./photos user@host:/backup/photos       # over SSH`,
        `relayium sync ./photos relayium://203.0.113.9:9031    # daemon direct, no SSH`,
      ],
    },
    {
      heading: "Exclusões e sincronização contínua",
      body: [
        "Por padrão o sync só adiciona e atualiza — ele nunca exclui nada por conta própria. Passe --delete para espelhar também as exclusões, mas o receptor precisa optar por isso: ele deve estar rodando relayium serve --allow-delete. Se não estiver, a solicitação de exclusão é recusada e reportada de volta ao remetente, em vez de ser ignorada em silêncio.",
        "Para uma pasta que muda continuamente, o --watch mantém o sync rodando após a primeira passada e espelha de novo sempre que um arquivo muda sob a origem — o rsync não tem nada embutido para isso; normalmente você recorreria a uma tarefa cron ou a um invólucro como o lsyncd.",
      ],
      code: [
        `relayium serve --dir /backup --port 9031 --allow-delete`,
        `relayium sync ./photos relayium://203.0.113.9:9031 --delete --watch`,
      ],
    },
    {
      heading: "Integridade, retomada e os limites honestos",
      body: [
        "Cada arquivo é verificado de ponta a ponta com um hash SHA-256, e uma transferência que é interrompida no meio de um arquivo retoma a partir do deslocamento de byte que já está em disco, em vez de recomeçar — útil pelas mesmas razões que no rsync.",
        "Deixe claro o que a retomada não é: ela não é o algoritmo delta do rsync. Se um arquivo já está totalmente presente mas tem um tamanho ou um carimbo de data/hora diferente, o sync o retransmite inteiro em vez de comparar os blocos alterados dentro dele. Para um único arquivo enorme que muda ligeiramente e com frequência, a transferência delta do rsync move menos dados. O sync também só lida com arquivos comuns — links simbólicos e arquivos especiais são pulados, então qualquer coisa que dependa deles precisa ser tratada à parte.",
      ],
    },
    {
      heading: "Quando o rsync ainda é a melhor ferramenta",
      body: [
        "Escolha o rsync quando você precisar que a sincronização vá nos dois sentidos, quando já tiver o SSH configurado e não quiser outro daemon, quando precisar de controle refinado (exclusões, filtros, snapshots com hard links, limites de banda, compressão), ou quando um arquivo mudar ligeiramente e com frequência e a transferência delta economizar banda de verdade. O Relayium sync não tenta cobrir nada disso.",
      ],
      bullets: [
        "Apenas sentido único: o sync espelha origem → destino; o rsync pode ir em qualquer direção.",
        "Sem transferência delta: o sync reenvia inteiro um arquivo alterado; a soma de verificação rolante do rsync envia apenas os blocos alterados.",
        "Menos opções: o rsync tem décadas de flags para filtragem, compressão e snapshots; o sync tem --delete e --watch.",
        "Onde o Relayium sync vence: não exige servidor SSH (daemon direto), TLS fixado com autenticação por impressão digital, ressincronização em tempo real com --watch, e é gratuito e sem conta para qualquer modo de transferência.",
      ],
    },
  ],
  faq: {
    heading: "Perguntas frequentes",
    items: [
      {
        q: "O Relayium sync é um substituto completo do rsync?",
        a: "Não. Ele só faz espelhamento de sentido único e não tem um algoritmo delta em nível de bloco como o rsync — um arquivo com tamanho ou carimbo de data/hora diferente é retransmitido inteiro, e ele tem bem menos flags que o rsync. Se você precisa de sincronização bidirecional, de controle refinado de filtros, ou quer se apoiar no ecossistema maduro do rsync, o rsync ainda é a melhor ferramenta.",
      },
      {
        q: "O sync precisa de um servidor SSH?",
        a: "Não. O daemon direto (relayium://host:port) pula o SSH inteiramente: uma conexão TLS fixada, autenticada pela impressão digital do receptor, aprovada uma vez e lembrada depois. Você também pode ir por SSH (user@host:path), mas o relayium precisa estar instalado no remoto para isso — e diferente do push, não há recurso de reserva tar para o sync.",
      },
      {
        q: "O sync exclui os arquivos que removi da origem?",
        a: "Só se você passar --delete e o serve do receptor estiver rodando com --allow-delete. Caso contrário, a solicitação de exclusão é recusada e reportada de volta ao remetente, não ignorada em silêncio.",
      },
      {
        q: "Ele pode sincronizar continuamente em tempo real?",
        a: "Sim, com --watch. Após o espelhamento inicial, o sync continua rodando e espelha de novo (com antirrebote) sempre que um arquivo muda sob a origem.",
      },
      {
        q: "É gratuito?",
        a: "Sim. A CLI do Relayium é completamente gratuita, e nenhum modo — incluindo o sync — precisa de conta.",
      },
    ],
  },
  cta: {
    text: "Espelhe uma pasta entre duas máquinas suas — sem necessidade de um servidor SSH.",
    button: "Obter a CLI",
    href: "/cli",
  },
  relatedHeading: "Continue lendo",
};

export default {
  slug: "compare/rsync",
  published: "2026-07-09",
  updated: "2026-07-12",
  langs: withInstall({ en, zh, ja, ko, de, fr, ar, es, pt }),
};
