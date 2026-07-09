// web/scripts/pages/content/articles/compare-snapdrop.mjs
// Objective comparison: Relayium vs Snapdrop & PairDrop. English is the master;
// zh/ja/ko/de/fr follow the same structure with identical facts.
// Terminology mirrors src/lib/i18n.svelte.ts and content/landing.mjs.

const en = {
  title: "Relayium vs Snapdrop & PairDrop: which secure P2P file transfer?",
  description:
    "An honest look at Relayium, Snapdrop and PairDrop. All three do browser-based peer-to-peer transfer; the real difference is Relayium's application-layer end-to-end encryption and cross-network reach.",
  updatedLabel: "Last updated",
  lead: [
    "Snapdrop and its actively maintained fork PairDrop are pioneers of browser-based, install-free file sharing. They are polished, familiar, and genuinely good tools — Relayium builds on the same idea rather than dismissing it.",
    "This article compares the three fairly: what they share, where Snapdrop and PairDrop are stronger, and where Relayium is different. The short version is that Relayium's focus is encryption strength and reaching across networks, not replacing what already works well on your LAN.",
  ],
  sections: [
    {
      heading: "What they have in common",
      body: [
        "All three run entirely in a modern web browser with nothing to install, and all three use WebRTC to move file bytes directly between two devices instead of parking them on a server.",
        "On the same local network they can discover nearby devices automatically, so sending a photo from a laptop to a phone in the same room is a couple of taps in any of them.",
      ],
    },
    {
      heading: "Where Snapdrop and PairDrop shine",
      body: [
        "Snapdrop has been around for years and has a large, trusting community; PairDrop extends it with features Relayium does not try to match today.",
      ],
      bullets: [
        "PairDrop adds rooms and persistent device pairing, so you can connect specific devices even across different networks by pairing code.",
        "Both are simple to self-host — the server code is small and well understood, which matters if you want to run your own instance.",
        "Years of real-world use mean broad device coverage, plenty of documentation, and a mature, predictable experience.",
      ],
    },
    {
      heading: "Where Relayium differs: application-layer end-to-end encryption",
      body: [
        "Plain WebRTC is encrypted in transit by DTLS, and that is real protection against a passive network eavesdropper. But the DTLS fingerprints that authenticate each side are exchanged through the signaling server. A malicious or compromised signaling server can substitute its own fingerprints and sit invisibly in the middle — a classic man-in-the-middle attack that DTLS alone does not stop.",
        "Relayium adds a second, independent encryption layer on top of the WebRTC channel: an X25519 key exchange derives a key used for per-chunk AES-256-GCM, and that key is never sent to any server. To detect a man-in-the-middle, both devices display the same 6-digit Short Authentication String (SAS); if the codes match, no server sits between you. Each file is also verified end-to-end with a SHA-256 hash.",
      ],
    },
    {
      heading: "Beyond the LAN",
      body: [
        "Relayium is designed to work across networks, not only on the same Wi-Fi. You can connect two devices with a pairing code (or the join link it generates), and the transfer still goes directly peer-to-peer whenever possible.",
        "When a direct connection is impossible, the encrypted stream falls back to a TURN relay — but the relay only ever sees ciphertext, so the transfer stays end-to-end encrypted. There is also an optional stored download-link mode: your browser encrypts the files with AES-256-GCM and the decryption key lives only in the URL fragment, so the server stores zero-knowledge ciphertext it cannot read. On the same network, no account is needed; sending across networks with a pairing code requires the sender to sign in — the person receiving never needs an account, and the same is true for stored download links. Transfers that drop mid-way can resume instead of restarting.",
      ],
    },
    {
      heading: "Feature comparison at a glance",
      body: [
        "The differences that matter most, side by side:",
      ],
      bullets: [
        "Encryption layer: plain WebRTC relies on DTLS alone; Relayium adds application-layer X25519 + AES-256-GCM on top.",
        "MITM defense: Relayium shows a 6-digit SAS code both sides verify; plain WebRTC has no equivalent check against a malicious signaling server.",
        "Across networks: Relayium connects by pairing code (or the join link it generates) with an encrypted TURN fallback; LAN discovery is the primary path for Snapdrop.",
        "Storage mode: Relayium offers optional zero-knowledge stored download links; the others are realtime-only.",
        "Resume: Relayium can resume an interrupted transfer instead of starting over.",
        "Batch: Relayium sends up to 1,000 files per batch with a per-file SHA-256 integrity check.",
      ],
    },
  ],
  faq: {
    heading: "Frequently asked questions",
    items: [
      {
        q: "Can Relayium and Snapdrop/PairDrop replace each other?",
        a: "For quick sharing between devices on the same network, any of them works well. If you need to reach across different networks or you want an extra, server-independent encryption layer with a verification code, Relayium is aimed at that; if you love PairDrop's rooms and persistent pairing, it remains an excellent choice.",
      },
      {
        q: "Is Relayium open source and self-hostable?",
        a: "Yes. Relayium is MIT-licensed and the full protocol and code are public at github.com/relayium/relayium, so you can audit it or run your own instance — the same openness that made Snapdrop and PairDrop trusted.",
      },
      {
        q: "Is there a performance difference?",
        a: "In practice, no meaningful one. All three make a direct WebRTC connection, so throughput is bounded by your network. Relayium's extra AES-256-GCM layer runs in the browser and its overhead is negligible next to the network transfer itself.",
      },
    ],
  },
  cta: {
    text: "See how the application-layer encryption feels in practice — no install, and no account needed on the same network.",
    button: "Try Relayium now",
  },
  relatedHeading: "Keep reading",
};

const zh = {
  title: "Relayium 对比 Snapdrop 与 PairDrop：哪个点对点传输更安全？",
  description:
    "客观对比 Relayium、Snapdrop 与 PairDrop。三者都在浏览器里做点对点传输，真正的差别在于 Relayium 的应用层端到端加密与跨网络能力。",
  updatedLabel: "最近更新",
  lead: [
    "Snapdrop 及其活跃维护的分支 PairDrop 是浏览器免安装文件分享的先驱，成熟、好用、体验优秀——Relayium 是在同样的思路上继续深化，而不是否定它们。",
    "本文客观对比这三者：它们的共同点、Snapdrop 与 PairDrop 更强的地方，以及 Relayium 的不同之处。一句话概括：Relayium 的重点是加密强度与跨网络直连，而不是取代局域网里已经好用的方案。",
  ],
  sections: [
    {
      heading: "它们的共同点",
      body: [
        "三者都完全运行在现代浏览器里，无需安装任何软件；也都用 WebRTC 让文件字节在两台设备之间直接流动，而不是先存到服务器上。",
        "在同一局域网内，它们都能自动发现附近的设备，所以在同一个房间里把照片从笔记本发到手机，任何一个都只需点几下。",
      ],
    },
    {
      heading: "Snapdrop 与 PairDrop 更出色的地方",
      body: [
        "Snapdrop 已经存在多年，拥有庞大而信任它的社区；PairDrop 在其基础上加入了 Relayium 目前并不追求的一些功能。",
      ],
      bullets: [
        "PairDrop 提供房间和持久设备配对，可以用配对码连接特定设备，甚至跨越不同网络。",
        "两者都很容易自托管——服务器代码小巧、易于理解，如果你想自建实例，这一点很重要。",
        "多年的实际使用意味着广泛的设备兼容、丰富的文档，以及成熟、可预期的体验。",
      ],
    },
    {
      heading: "Relayium 的不同：应用层端到端加密",
      body: [
        "原生 WebRTC 由 DTLS 提供传输加密，这对被动的网络窃听者确实是有效保护。但用于验证双方身份的 DTLS 指纹是经由信令服务器交换的。恶意或被入侵的信令服务器可以替换成自己的指纹，隐形地插在中间——这正是 DTLS 本身无法阻止的中间人攻击。",
        "Relayium 在 WebRTC 通道之上再加了一层独立加密：用 X25519 密钥交换协商出密钥，对每个数据块做 AES-256-GCM 加密，而这把密钥从不发送给任何服务器。为发现中间人，两台设备会显示同一段 6 位校验码（SAS）；只要两边一致，就说明没有服务器插在中间。每个文件还会用 SHA-256 做端到端完整性校验。",
      ],
    },
    {
      heading: "走出局域网",
      body: [
        "Relayium 从设计上就支持跨网络工作，而不只是同一个 Wi-Fi。你可以用配对码（或它生成的加入链接）连接两台设备，只要条件允许，传输依然点对点直连。",
        "当无法直连时，加密数据流会退回到 TURN 中继——但中继只能看到密文，因此传输始终保持端到端加密。此外还有可选的存储下载链接模式：浏览器先用 AES-256-GCM 加密文件，解密密钥只存在于 URL 片段里，服务器只保存无法解读的零知识密文。同一网络下无需账号；跨网络用配对码传输则需要发送方登录——接收方无论哪种方式都无需账号，存储下载链接也同样需要发送方登录。中途断开的传输可以断点续传，而不必从头再来。",
      ],
    },
    {
      heading: "功能一览对比",
      body: [
        "把最关键的差别并排列出：",
      ],
      bullets: [
        "加密层级：原生 WebRTC 只依赖 DTLS；Relayium 在其之上再加应用层 X25519 + AES-256-GCM。",
        "防中间人：Relayium 显示两边核对的 6 位 SAS 校验码；原生 WebRTC 对恶意信令服务器没有对应的核验手段。",
        "跨网络：Relayium 可用配对码（或它生成的加入链接）连接，并有加密的 TURN 兜底；Snapdrop 主要依赖局域网发现。",
        "存储模式：Relayium 提供可选的零知识存储下载链接；另两者只有实时模式。",
        "断点续传：Relayium 可在传输中断后续传，而非重来。",
        "批量：Relayium 每批最多发送 1,000 个文件，并对每个文件做 SHA-256 完整性校验。",
      ],
    },
  ],
  faq: {
    heading: "常见问题",
    items: [
      {
        q: "Relayium 与 Snapdrop / PairDrop 能互相替代吗？",
        a: "在同一网络内的设备间快速分享，三者都很好用。如果你需要跨越不同网络，或者想要一层与服务器无关、带校验码的额外加密，Relayium 正是为此而生；而如果你喜欢 PairDrop 的房间与持久配对，它依然是很好的选择。",
      },
      {
        q: "Relayium 开源且可自托管吗？",
        a: "是的。Relayium 采用 MIT 许可，完整的协议与代码都公开在 github.com/relayium/relayium，你可以审计它或自建实例——这正是让 Snapdrop 与 PairDrop 赢得信任的同一种开放。",
      },
      {
        q: "性能上有差异吗？",
        a: "实际上没有明显差异。三者都建立 WebRTC 直连，吞吐取决于你的网络。Relayium 多出的 AES-256-GCM 加密在浏览器里完成，其开销相比网络传输本身可以忽略不计。",
      },
    ],
  },
  cta: {
    text: "亲自体验应用层加密的实际感受——无需安装，同一网络下也无需账号。",
    button: "立即试用 Relayium",
  },
  relatedHeading: "继续阅读",
};

const ja = {
  title: "Relayium と Snapdrop・PairDrop の比較：安全な P2P 転送はどれ？",
  description:
    "Relayium、Snapdrop、PairDrop を公平に比較。3つともブラウザで P2P 転送を行いますが、本当の違いは Relayium のアプリケーション層エンドツーエンド暗号化とネットワークをまたぐ到達性です。",
  updatedLabel: "最終更新",
  lead: [
    "Snapdrop と、その活発にメンテナンスされているフォーク PairDrop は、ブラウザでインストール不要のファイル共有を切り開いた先駆者です。洗練され、使いやすく、本当に優れたツールで、Relayium はそれを否定するのではなく同じ発想の上に築いています。",
    "本記事はこの3つを公平に比較します。共通点、Snapdrop と PairDrop が優れている点、そして Relayium が異なる点です。要するに、Relayium の焦点は暗号化の強度とネットワークをまたぐ到達性であり、LAN 上で既にうまく機能しているものを置き換えることではありません。",
  ],
  sections: [
    {
      heading: "共通しているところ",
      body: [
        "3つとも最新のブラウザだけで動作し、インストールは不要です。いずれも WebRTC を使い、ファイルのバイトをサーバーに置くのではなく2台の端末間で直接やり取りします。",
        "同じローカルネットワークでは近くの端末を自動的に発見できるため、同じ部屋でノートPCからスマホへ写真を送るのは、どれを使っても数タップです。",
      ],
    },
    {
      heading: "Snapdrop と PairDrop が優れている点",
      body: [
        "Snapdrop は長年使われ、信頼する大きなコミュニティを持っています。PairDrop はそこに、Relayium が今は狙っていない機能を加えています。",
      ],
      bullets: [
        "PairDrop はルームと永続的な端末ペアリングを備え、ペアリングコードで特定の端末を、異なるネットワークをまたいでも接続できます。",
        "どちらも自己ホストが簡単です。サーバーコードは小さくよく理解されており、自分のインスタンスを運用したい場合に重要です。",
        "長年の実運用により、広い端末対応、豊富なドキュメント、成熟して予測可能な体験があります。",
      ],
    },
    {
      heading: "Relayium の違い：アプリケーション層のエンドツーエンド暗号化",
      body: [
        "素の WebRTC は DTLS によって転送中は暗号化され、受動的な盗聴者に対しては確かな保護になります。しかし双方を認証する DTLS フィンガープリントはシグナリングサーバー経由で交換されます。悪意ある、あるいは侵害されたシグナリングサーバーは自分のフィンガープリントに差し替え、見えない形で間に入り込めます——これは DTLS だけでは防げない典型的な中間者攻撃です。",
        "Relayium は WebRTC チャネルの上に、独立した2つ目の暗号化層を加えます。X25519 の鍵交換で導出した鍵をブロックごとの AES-256-GCM に使い、その鍵はどのサーバーにも送られません。中間者を検出するため、両方の端末が同じ6桁のショート認証文字列（SAS）を表示します。コードが一致すれば、間にサーバーはいません。各ファイルは SHA-256 ハッシュでエンドツーエンドに検証されます。",
      ],
    },
    {
      heading: "LAN を越えて",
      body: [
        "Relayium は同じ Wi-Fi だけでなく、ネットワークをまたいで動くよう設計されています。ペアリングコード（またはそれが生成する参加リンク）で2台の端末を接続でき、可能な限り転送は P2P で直接行われます。",
        "直接接続が不可能なときは、暗号化ストリームが TURN リレーにフォールバックしますが、リレーが見るのは暗号文だけなので、転送はエンドツーエンド暗号化のままです。任意の保存型ダウンロードリンクもあります。ブラウザが AES-256-GCM でファイルを暗号化し、復号鍵は URL フラグメントにだけ存在するため、サーバーは読めないゼロ知識の暗号文を保存します。同じネットワークならアカウントは不要です。ネットワークをまたいでペアリングコードで送る場合は送信側のサインインが必要です——受信側はどちらの場合もアカウント不要で、保存型ダウンロードリンクの作成にも送信側のサインインが必要です。途中で切れた転送は最初からではなく再開できます。",
      ],
    },
    {
      heading: "機能の一覧比較",
      body: [
        "最も重要な違いを並べて示します。",
      ],
      bullets: [
        "暗号化層：素の WebRTC は DTLS だけに依存。Relayium はその上にアプリケーション層の X25519 + AES-256-GCM を加える。",
        "中間者対策：Relayium は双方で照合する6桁の SAS コードを表示。素の WebRTC には悪意あるシグナリングサーバーへの相当する確認手段がない。",
        "ネットワーク越え：Relayium はペアリングコード（またはその参加リンク）で接続し、暗号化された TURN フォールバックを持つ。Snapdrop は主に LAN 発見に依存。",
        "保存モード：Relayium は任意のゼロ知識保存ダウンロードリンクを提供。他はリアルタイムのみ。",
        "再開：Relayium は中断した転送を最初からやり直さずに再開できる。",
        "バッチ：Relayium は1バッチ最大1,000ファイルを送り、ファイルごとに SHA-256 整合性チェックを行う。",
      ],
    },
  ],
  faq: {
    heading: "よくある質問",
    items: [
      {
        q: "Relayium と Snapdrop・PairDrop は互いに置き換えられますか？",
        a: "同じネットワーク内の端末間で手早く共有するなら、どれもよく機能します。異なるネットワークをまたぐ必要がある場合や、サーバーに依存しない検証コード付きの追加暗号化層が欲しい場合は Relayium が狙いです。PairDrop のルームや永続ペアリングが好きなら、それも引き続き優れた選択肢です。",
      },
      {
        q: "Relayium はオープンソースで自己ホストできますか？",
        a: "はい。Relayium は MIT ライセンスで、プロトコルとコードのすべてが github.com/relayium/relayium で公開されています。監査も自分のインスタンス運用も可能です——Snapdrop と PairDrop が信頼された、まさに同じ開放性です。",
      },
      {
        q: "性能に違いはありますか？",
        a: "実際には意味のある違いはありません。3つとも WebRTC の直接接続を行うため、スループットはネットワークで決まります。Relayium の追加の AES-256-GCM 層はブラウザ内で動作し、そのオーバーヘッドはネットワーク転送そのものに比べて無視できます。",
      },
    ],
  },
  cta: {
    text: "アプリケーション層の暗号化の実際の感触を体験してください——インストール不要、同じネットワークならアカウントも不要です。",
    button: "Relayium を今すぐ試す",
  },
  relatedHeading: "続けて読む",
};

const ko = {
  title: "Relayium vs Snapdrop·PairDrop: 어떤 P2P 파일 전송이 더 안전할까?",
  description:
    "Relayium, Snapdrop, PairDrop을 공정하게 비교합니다. 셋 다 브라우저 기반 P2P 전송을 하지만, 진짜 차이는 Relayium의 애플리케이션 계층 종단간 암호화와 네트워크를 넘나드는 도달성입니다.",
  updatedLabel: "마지막 업데이트",
  lead: [
    "Snapdrop과 활발히 유지되는 포크 PairDrop은 브라우저 기반 무설치 파일 공유의 선구자입니다. 세련되고 익숙하며 정말로 훌륭한 도구로, Relayium은 이를 부정하는 대신 같은 발상 위에 쌓아 올립니다.",
    "이 글은 세 가지를 공정하게 비교합니다. 공통점, Snapdrop과 PairDrop이 더 강한 점, 그리고 Relayium이 다른 점입니다. 요약하면 Relayium의 초점은 암호화 강도와 네트워크를 넘나드는 도달성이며, LAN에서 이미 잘 작동하는 것을 대체하려는 것이 아닙니다.",
  ],
  sections: [
    {
      heading: "공통점",
      body: [
        "셋 다 최신 웹 브라우저에서 설치 없이 완전히 동작하며, 모두 WebRTC를 사용해 파일 바이트를 서버에 두지 않고 두 기기 사이에서 직접 주고받습니다.",
        "같은 로컬 네트워크에서는 근처 기기를 자동으로 찾을 수 있어, 같은 방에서 노트북에서 휴대폰으로 사진을 보내는 일은 어느 것을 써도 몇 번의 탭이면 됩니다.",
      ],
    },
    {
      heading: "Snapdrop과 PairDrop이 뛰어난 점",
      body: [
        "Snapdrop은 오랫동안 쓰였고 신뢰하는 큰 커뮤니티가 있습니다. PairDrop은 여기에 Relayium이 지금은 목표로 하지 않는 기능을 더합니다.",
      ],
      bullets: [
        "PairDrop은 방과 지속적인 기기 페어링을 제공해, 페어링 코드로 특정 기기를 서로 다른 네트워크를 넘어서도 연결할 수 있습니다.",
        "둘 다 자체 호스팅이 간단합니다. 서버 코드가 작고 잘 이해되어 있어, 자체 인스턴스를 운영하려는 경우 중요합니다.",
        "수년간의 실제 사용은 폭넓은 기기 지원, 풍부한 문서, 성숙하고 예측 가능한 경험을 의미합니다.",
      ],
    },
    {
      heading: "Relayium의 차이: 애플리케이션 계층 종단간 암호화",
      body: [
        "순수 WebRTC는 DTLS로 전송 중 암호화되며, 수동적 도청자에 대해서는 실질적인 보호가 됩니다. 하지만 양쪽을 인증하는 DTLS 지문은 시그널링 서버를 거쳐 교환됩니다. 악의적이거나 침해된 시그널링 서버는 자신의 지문으로 바꿔치기해 보이지 않게 중간에 끼어들 수 있습니다. 이것이 DTLS만으로는 막을 수 없는 전형적인 중간자 공격입니다.",
        "Relayium은 WebRTC 채널 위에 독립적인 두 번째 암호화 계층을 더합니다. X25519 키 교환으로 도출한 키를 블록별 AES-256-GCM에 사용하며, 이 키는 어떤 서버에도 전송되지 않습니다. 중간자를 탐지하기 위해 두 기기가 동일한 6자리 짧은 인증 문자열(SAS)을 표시합니다. 코드가 일치하면 사이에 서버가 없다는 뜻입니다. 각 파일은 SHA-256 해시로 종단간 검증됩니다.",
      ],
    },
    {
      heading: "LAN을 넘어서",
      body: [
        "Relayium은 같은 Wi-Fi뿐 아니라 네트워크를 넘나들며 작동하도록 설계되었습니다. 페어링 코드(또는 그것이 생성하는 참여 링크)로 두 기기를 연결할 수 있고, 가능한 경우 전송은 여전히 P2P로 직접 이루어집니다.",
        "직접 연결이 불가능할 때는 암호화된 스트림이 TURN 릴레이로 폴백하지만, 릴레이는 암호문만 볼 수 있어 전송은 종단간 암호화를 유지합니다. 선택적인 저장형 다운로드 링크 모드도 있습니다. 브라우저가 AES-256-GCM으로 파일을 암호화하고 복호화 키는 URL 프래그먼트에만 존재하므로, 서버는 읽을 수 없는 영지식 암호문을 저장합니다. 같은 네트워크에서는 계정이 필요 없습니다. 페어링 코드로 네트워크를 넘어 보낼 때는 보내는 쪽의 로그인이 필요합니다 — 받는 쪽은 어느 경우든 계정이 필요 없고, 저장형 다운로드 링크 생성에도 보내는 쪽의 로그인이 필요합니다. 도중에 끊긴 전송은 처음부터가 아니라 이어서 재개할 수 있습니다.",
      ],
    },
    {
      heading: "기능 한눈에 비교",
      body: [
        "가장 중요한 차이를 나란히 정리하면:",
      ],
      bullets: [
        "암호화 계층: 순수 WebRTC는 DTLS에만 의존; Relayium은 그 위에 애플리케이션 계층 X25519 + AES-256-GCM을 더함.",
        "중간자 방어: Relayium은 양쪽이 대조하는 6자리 SAS 코드를 표시; 순수 WebRTC는 악의적 시그널링 서버에 대한 상응하는 확인 수단이 없음.",
        "네트워크 넘기: Relayium은 페어링 코드(또는 그 참여 링크)로 연결하고 암호화된 TURN 폴백을 가짐; Snapdrop은 주로 LAN 탐색에 의존.",
        "저장 모드: Relayium은 선택적 영지식 저장 다운로드 링크를 제공; 나머지는 실시간 전용.",
        "재개: Relayium은 중단된 전송을 처음부터 다시 하지 않고 이어받을 수 있음.",
        "일괄: Relayium은 배치당 최대 1,000개 파일을 보내며 파일별 SHA-256 무결성 검사를 함.",
      ],
    },
  ],
  faq: {
    heading: "자주 묻는 질문",
    items: [
      {
        q: "Relayium과 Snapdrop·PairDrop은 서로 대체할 수 있나요?",
        a: "같은 네트워크의 기기 간 빠른 공유라면 어느 것이든 잘 작동합니다. 서로 다른 네트워크를 넘나들어야 하거나 서버에 의존하지 않는 검증 코드가 있는 추가 암호화 계층을 원한다면 Relayium이 그 목적입니다. PairDrop의 방과 지속 페어링을 좋아한다면 그것도 여전히 훌륭한 선택입니다.",
      },
      {
        q: "Relayium은 오픈소스이며 자체 호스팅이 가능한가요?",
        a: "네. Relayium은 MIT 라이선스이며 프로토콜과 코드 전체가 github.com/relayium/relayium에 공개되어 있어 감사하거나 자체 인스턴스를 운영할 수 있습니다. Snapdrop과 PairDrop이 신뢰받게 한 바로 그 개방성입니다.",
      },
      {
        q: "성능 차이가 있나요?",
        a: "실제로는 의미 있는 차이가 없습니다. 셋 다 WebRTC 직접 연결을 하므로 처리량은 네트워크에 의해 결정됩니다. Relayium의 추가 AES-256-GCM 계층은 브라우저에서 동작하며 그 오버헤드는 네트워크 전송 자체에 비해 무시할 만합니다.",
      },
    ],
  },
  cta: {
    text: "애플리케이션 계층 암호화가 실제로 어떤지 직접 확인해 보세요 — 설치 불필요, 같은 네트워크에서는 계정도 필요 없습니다.",
    button: "지금 Relayium 사용해보기",
  },
  relatedHeading: "계속 읽기",
};

const de = {
  title: "Relayium vs. Snapdrop & PairDrop: welche sichere P2P-Übertragung?",
  description:
    "Ein ehrlicher Vergleich von Relayium, Snapdrop und PairDrop. Alle drei übertragen Peer-to-Peer im Browser; der echte Unterschied ist Relayiums Ende-zu-Ende-Verschlüsselung auf Anwendungsebene und seine netzwerkübergreifende Reichweite.",
  updatedLabel: "Zuletzt aktualisiert",
  lead: [
    "Snapdrop und sein aktiv gepflegter Fork PairDrop sind Pioniere des browserbasierten, installationsfreien Dateiaustauschs. Sie sind ausgereift, vertraut und wirklich gute Werkzeuge — Relayium baut auf derselben Idee auf, statt sie abzutun.",
    "Dieser Artikel vergleicht die drei fair: Gemeinsamkeiten, wo Snapdrop und PairDrop stärker sind und wo Relayium anders ist. Kurz gesagt liegt Relayiums Fokus auf Verschlüsselungsstärke und dem Erreichen über Netzwerke hinweg — nicht darauf, das zu ersetzen, was im LAN bereits gut funktioniert.",
  ],
  sections: [
    {
      heading: "Was sie gemeinsam haben",
      body: [
        "Alle drei laufen vollständig in einem modernen Webbrowser ohne Installation, und alle drei nutzen WebRTC, um Datei-Bytes direkt zwischen zwei Geräten zu bewegen, statt sie auf einem Server abzulegen.",
        "Im selben lokalen Netz erkennen sie nahe Geräte automatisch, sodass das Senden eines Fotos vom Laptop zum Handy im selben Raum bei jedem von ihnen nur ein paar Tipps ist.",
      ],
    },
    {
      heading: "Wo Snapdrop und PairDrop glänzen",
      body: [
        "Snapdrop gibt es seit Jahren und hat eine große, vertrauensvolle Community; PairDrop erweitert es um Funktionen, die Relayium heute nicht anstrebt.",
      ],
      bullets: [
        "PairDrop bietet Räume und dauerhafte Gerätepaarung, sodass du bestimmte Geräte per Pairing-Code verbinden kannst — sogar über verschiedene Netzwerke hinweg.",
        "Beide lassen sich einfach selbst hosten — der Servercode ist klein und gut verstanden, was zählt, wenn du eine eigene Instanz betreiben willst.",
        "Jahre realen Einsatzes bedeuten breite Geräteabdeckung, viel Dokumentation und eine ausgereifte, vorhersehbare Erfahrung.",
      ],
    },
    {
      heading: "Worin sich Relayium unterscheidet: Ende-zu-Ende-Verschlüsselung auf Anwendungsebene",
      body: [
        "Reines WebRTC ist beim Transport durch DTLS verschlüsselt, und das ist echter Schutz gegen einen passiven Netzwerk-Lauscher. Aber die DTLS-Fingerabdrücke, die jede Seite authentifizieren, werden über den Signalisierungsserver ausgetauscht. Ein bösartiger oder kompromittierter Signalisierungsserver kann eigene Fingerabdrücke einschleusen und sich unsichtbar dazwischensetzen — ein klassischer Man-in-the-Middle-Angriff, den DTLS allein nicht verhindert.",
        "Relayium fügt über dem WebRTC-Kanal eine zweite, unabhängige Verschlüsselungsschicht hinzu: Ein X25519-Schlüsselaustausch leitet einen Schlüssel für AES-256-GCM pro Block ab, und dieser Schlüssel wird nie an einen Server gesendet. Um einen Man-in-the-Middle zu erkennen, zeigen beide Geräte denselben sechsstelligen Short Authentication String (SAS) an; stimmen die Codes überein, sitzt kein Server dazwischen. Jede Datei wird zudem per SHA-256-Hash Ende-zu-Ende geprüft.",
      ],
    },
    {
      heading: "Über das LAN hinaus",
      body: [
        "Relayium ist darauf ausgelegt, netzwerkübergreifend zu funktionieren, nicht nur im selben WLAN. Du kannst zwei Geräte per Pairing-Code (oder den erzeugten Beitrittslink) verbinden, und die Übertragung läuft nach Möglichkeit weiterhin direkt Peer-to-Peer.",
        "Ist eine Direktverbindung unmöglich, weicht der verschlüsselte Datenstrom auf ein TURN-Relay aus — doch das Relay sieht nur Chiffretext, sodass die Übertragung Ende-zu-Ende-verschlüsselt bleibt. Es gibt außerdem einen optionalen Modus mit gespeichertem Download-Link: Der Browser verschlüsselt die Dateien mit AES-256-GCM, und der Entschlüsselungsschlüssel liegt nur im URL-Fragment, sodass der Server nur Zero-Knowledge-Chiffretext speichert, den er nicht lesen kann. Im selben Netz ist kein Konto nötig; beim Senden über Netzwerke hinweg per Pairing-Code muss sich der Absender anmelden — der Empfänger braucht in beiden Fällen kein Konto, ebenso wenig wie bei gespeicherten Download-Links, die ebenfalls die Anmeldung des Absenders erfordern. Abgebrochene Übertragungen können fortgesetzt statt neu gestartet werden.",
      ],
    },
    {
      heading: "Funktionsvergleich auf einen Blick",
      body: [
        "Die wichtigsten Unterschiede nebeneinander:",
      ],
      bullets: [
        "Verschlüsselungsschicht: Reines WebRTC verlässt sich allein auf DTLS; Relayium legt X25519 + AES-256-GCM auf Anwendungsebene darüber.",
        "MITM-Schutz: Relayium zeigt einen sechsstelligen SAS-Code, den beide Seiten prüfen; reines WebRTC hat keine entsprechende Kontrolle gegen einen bösartigen Signalisierungsserver.",
        "Netzwerkübergreifend: Relayium verbindet per Pairing-Code (oder dessen Beitrittslink) mit verschlüsseltem TURN-Fallback; bei Snapdrop ist die LAN-Erkennung der Hauptweg.",
        "Speichermodus: Relayium bietet optionale Zero-Knowledge-Download-Links; die anderen sind nur Echtzeit.",
        "Fortsetzen: Relayium kann eine unterbrochene Übertragung fortsetzen, statt neu zu beginnen.",
        "Stapel: Relayium sendet bis zu 1.000 Dateien pro Stapel mit einer SHA-256-Integritätsprüfung je Datei.",
      ],
    },
  ],
  faq: {
    heading: "Häufige Fragen",
    items: [
      {
        q: "Können Relayium und Snapdrop/PairDrop einander ersetzen?",
        a: "Für schnelles Teilen zwischen Geräten im selben Netz funktioniert jedes gut. Wenn du über verschiedene Netzwerke hinweg erreichen musst oder eine zusätzliche, serverunabhängige Verschlüsselungsschicht mit Prüfcode willst, zielt Relayium darauf ab; wenn du PairDrops Räume und dauerhafte Paarung liebst, bleibt es eine ausgezeichnete Wahl.",
      },
      {
        q: "Ist Relayium quelloffen und selbst hostbar?",
        a: "Ja. Relayium ist MIT-lizenziert, und das vollständige Protokoll samt Code ist öffentlich unter github.com/relayium/relayium — du kannst es prüfen oder eine eigene Instanz betreiben, dieselbe Offenheit, die Snapdrop und PairDrop Vertrauen verschafft hat.",
      },
      {
        q: "Gibt es einen Leistungsunterschied?",
        a: "In der Praxis keinen nennenswerten. Alle drei bauen eine direkte WebRTC-Verbindung auf, der Durchsatz ist also durch dein Netzwerk begrenzt. Relayiums zusätzliche AES-256-GCM-Schicht läuft im Browser, und ihr Aufwand ist neben der Netzwerkübertragung selbst vernachlässigbar.",
      },
    ],
  },
  cta: {
    text: "Erlebe, wie sich die Verschlüsselung auf Anwendungsebene in der Praxis anfühlt — keine Installation, im selben Netz kein Konto nötig.",
    button: "Relayium jetzt ausprobieren",
  },
  relatedHeading: "Weiterlesen",
};

const fr = {
  title: "Relayium vs Snapdrop et PairDrop : quel transfert P2P sécurisé ?",
  description:
    "Un comparatif honnête de Relayium, Snapdrop et PairDrop. Les trois font du transfert pair-à-pair dans le navigateur ; la vraie différence est le chiffrement de bout en bout au niveau applicatif de Relayium et sa portée entre réseaux.",
  updatedLabel: "Dernière mise à jour",
  lead: [
    "Snapdrop et son fork activement maintenu PairDrop sont des pionniers du partage de fichiers sans installation, dans le navigateur. Ce sont des outils soignés, familiers et vraiment bons — Relayium s'appuie sur la même idée plutôt que de la balayer.",
    "Cet article compare les trois équitablement : ce qu'ils partagent, là où Snapdrop et PairDrop sont plus forts, et là où Relayium diffère. En bref, Relayium se concentre sur la force du chiffrement et l'atteinte entre réseaux, pas sur le remplacement de ce qui fonctionne déjà bien sur votre réseau local.",
  ],
  sections: [
    {
      heading: "Ce qu'ils ont en commun",
      body: [
        "Les trois fonctionnent entièrement dans un navigateur moderne, sans rien à installer, et tous utilisent WebRTC pour déplacer les octets de fichiers directement entre deux appareils plutôt que de les stocker sur un serveur.",
        "Sur le même réseau local, ils peuvent découvrir automatiquement les appareils proches, si bien qu'envoyer une photo d'un ordinateur portable à un téléphone dans la même pièce ne prend que quelques touches avec n'importe lequel.",
      ],
    },
    {
      heading: "Là où Snapdrop et PairDrop brillent",
      body: [
        "Snapdrop existe depuis des années et compte une grande communauté qui lui fait confiance ; PairDrop l'étend avec des fonctions que Relayium ne cherche pas à égaler aujourd'hui.",
      ],
      bullets: [
        "PairDrop ajoute des salons et un appairage d'appareils persistant, permettant de connecter des appareils précis par code d'appairage, même sur des réseaux différents.",
        "Les deux sont simples à auto-héberger — le code serveur est petit et bien compris, ce qui compte si vous voulez faire tourner votre propre instance.",
        "Des années d'usage réel signifient une large compatibilité d'appareils, une documentation abondante et une expérience mature et prévisible.",
      ],
    },
    {
      heading: "Là où Relayium diffère : chiffrement de bout en bout au niveau applicatif",
      body: [
        "Le WebRTC brut est chiffré en transit par DTLS, ce qui protège réellement contre une écoute réseau passive. Mais les empreintes DTLS qui authentifient chaque partie sont échangées via le serveur de signalisation. Un serveur de signalisation malveillant ou compromis peut y substituer ses propres empreintes et s'intercaler de façon invisible — une attaque de l'homme du milieu classique que DTLS seul n'empêche pas.",
        "Relayium ajoute une seconde couche de chiffrement indépendante par-dessus le canal WebRTC : un échange de clés X25519 dérive une clé utilisée pour un AES-256-GCM par bloc, et cette clé n'est jamais envoyée à aucun serveur. Pour détecter un homme du milieu, les deux appareils affichent la même chaîne d'authentification courte (SAS) à 6 chiffres ; si les codes concordent, aucun serveur ne s'intercale. Chaque fichier est aussi vérifié de bout en bout par une empreinte SHA-256.",
      ],
    },
    {
      heading: "Au-delà du réseau local",
      body: [
        "Relayium est conçu pour fonctionner entre réseaux, pas seulement sur le même Wi-Fi. Vous pouvez connecter deux appareils par code d'appairage (ou le lien de participation qu'il génère), et le transfert reste en pair-à-pair direct chaque fois que possible.",
        "Quand une connexion directe est impossible, le flux chiffré bascule vers un relais TURN — mais le relais ne voit que du texte chiffré, donc le transfert reste chiffré de bout en bout. Il existe aussi un mode optionnel de lien de téléchargement stocké : le navigateur chiffre les fichiers en AES-256-GCM et la clé de déchiffrement ne vit que dans le fragment de l'URL, si bien que le serveur ne stocke qu'un texte chiffré à divulgation nulle qu'il ne peut pas lire. Sur le même réseau, aucun compte n'est nécessaire ; envoyer entre réseaux différents avec un code d'appairage exige que l'expéditeur se connecte — le destinataire n'a jamais besoin de compte, et il en va de même pour les liens de téléchargement stockés. Les transferts interrompus en cours de route peuvent reprendre au lieu de tout recommencer.",
      ],
    },
    {
      heading: "Comparatif des fonctions en un coup d'œil",
      body: [
        "Les différences qui comptent le plus, côte à côte :",
      ],
      bullets: [
        "Couche de chiffrement : le WebRTC brut ne repose que sur DTLS ; Relayium ajoute par-dessus X25519 + AES-256-GCM au niveau applicatif.",
        "Défense MITM : Relayium affiche un code SAS à 6 chiffres que les deux parties vérifient ; le WebRTC brut n'a aucun contrôle équivalent contre un serveur de signalisation malveillant.",
        "Entre réseaux : Relayium se connecte par code d'appairage (ou son lien de participation) avec un repli TURN chiffré ; pour Snapdrop, la découverte sur le réseau local est la voie principale.",
        "Mode de stockage : Relayium propose des liens de téléchargement stockés à divulgation nulle en option ; les autres sont uniquement en temps réel.",
        "Reprise : Relayium peut reprendre un transfert interrompu au lieu de recommencer.",
        "Lot : Relayium envoie jusqu'à 1 000 fichiers par lot avec une vérification d'intégrité SHA-256 par fichier.",
      ],
    },
  ],
  faq: {
    heading: "Questions fréquentes",
    items: [
      {
        q: "Relayium et Snapdrop/PairDrop peuvent-ils se remplacer mutuellement ?",
        a: "Pour un partage rapide entre appareils du même réseau, chacun fonctionne bien. Si vous devez atteindre des réseaux différents ou voulez une couche de chiffrement supplémentaire, indépendante du serveur, avec un code de vérification, Relayium vise cela ; si vous aimez les salons et l'appairage persistant de PairDrop, il reste un excellent choix.",
      },
      {
        q: "Relayium est-il open source et auto-hébergeable ?",
        a: "Oui. Relayium est sous licence MIT et l'intégralité du protocole et du code est publique sur github.com/relayium/relayium, vous pouvez donc l'auditer ou faire tourner votre propre instance — la même ouverture qui a rendu Snapdrop et PairDrop dignes de confiance.",
      },
      {
        q: "Y a-t-il une différence de performance ?",
        a: "En pratique, aucune notable. Les trois établissent une connexion WebRTC directe, le débit est donc limité par votre réseau. La couche AES-256-GCM supplémentaire de Relayium s'exécute dans le navigateur et son coût est négligeable face au transfert réseau lui-même.",
      },
    ],
  },
  cta: {
    text: "Découvrez ce que donne le chiffrement au niveau applicatif en pratique — sans installation, sans compte sur le même réseau.",
    button: "Essayer Relayium maintenant",
  },
  relatedHeading: "À lire ensuite",
};

export default {
  slug: "compare/snapdrop",
  updated: "2026-07-03",
  langs: { en, zh, ja, ko, de, fr },
};
