// web/scripts/legal/content/privacy.mjs
const en = {
  title: "Privacy Policy",
  description:
    "How Relayium handles your data: files transfer peer-to-peer and never touch our servers. Accounts are optional and store only an email and display name.",
  updatedLabel: "Last updated",
  updated: "2026-06-29",
  otherDocLabel: "Terms of Service",
  lead: [
    "Relayium is built so that your files stay yours. File transfers happen directly between two devices, end-to-end encrypted, and never pass through our servers.",
    "This page explains the little data the service does handle, and the data it deliberately never sees.",
  ],
  sections: [
    {
      heading: "Local-network transfers collect nothing",
      body: [
        "When you transfer files between devices on the same network, no account is needed and the service stores nothing about you. The signaling server only helps the two devices find each other; the file bytes flow device-to-device over an encrypted WebRTC channel.",
      ],
    },
    {
      heading: "What an account stores (only if you sign in)",
      body: [
        "Signing in is optional and only unlocks cross-network transfers. If you sign in, we store the minimum needed to run an account:",
      ],
      bullets: [
        "Your email address and a display name.",
        "Which sign-in method you used (Google, or an email magic link). Magic-link tokens are stored only as a hash, never in clear text.",
        "A login session, kept in a secure, httpOnly cookie.",
        "Devices you register, as a random device id and a device name (e.g. your platform name).",
      ],
    },
    {
      heading: "What we never collect",
      body: ["The service is designed so that the following never reach our servers:"],
      bullets: [
        "The contents of your files.",
        "The names of your files.",
        "Your encryption keys.",
      ],
    },
    {
      heading: "Cross-network relay (TURN)",
      body: [
        "When two devices cannot connect directly across networks, the encrypted stream is relayed through a TURN server. The relay still cannot read your files — they remain end-to-end encrypted. For operating the service we record only the number of relayed bytes for a transfer, attributed to the signed-in user who created it. We never inspect relayed content.",
      ],
    },
    {
      heading: "Cookies and local storage",
      body: [
        "We use one session cookie to keep you signed in. In your browser's local storage we keep a random device id so a device you registered can be recognized. We do not use advertising or tracking cookies.",
      ],
    },
    {
      heading: "Third-party services",
      body: ["A couple of third parties are involved only when you choose to use them:"],
      bullets: [
        "Google, if you sign in with Google — we receive your email and basic profile to create the account.",
        "An email delivery provider, to send magic-link sign-in emails.",
      ],
    },
    {
      heading: "Data retention and deletion",
      body: [
        "Account data is kept while your account exists. You can ask us to delete your account and its data at any time by contacting us at support@relayium.com.",
      ],
    },
    {
      heading: "Changes to this policy",
      body: [
        "We may update this policy as the service evolves. When we do, we will change the \"Last updated\" date above.",
      ],
    },
    {
      heading: "Contact",
      body: ["Questions about privacy? Email support@relayium.com."],
    },
  ],
};

const zh = {
  title: "隐私政策",
  description:
    "Relayium 如何处理你的数据:文件点对点传输,绝不经过我们的服务器。账号是可选的,仅存储邮箱与显示名。",
  updatedLabel: "最后更新",
  updated: "2026-06-29",
  otherDocLabel: "服务条款",
  lead: [
    "Relayium 的设计宗旨是让你的文件始终属于你。文件传输在两台设备之间直接进行,端到端加密,绝不经过我们的服务器。",
    "本页说明本服务确实会处理的少量数据,以及它刻意从不接触的数据。",
  ],
  sections: [
    {
      heading: "局域网传输不收集任何数据",
      body: [
        "在同一网络下的设备之间传输文件时,无需账号,服务也不会存储任何关于你的信息。信令服务器只帮助两台设备相互发现;文件字节通过加密的 WebRTC 通道在设备之间直接流动。",
      ],
    },
    {
      heading: "账号会存储什么(仅在你登录时)",
      body: ["登录是可选的,仅用于解锁跨网络传输。如果你登录,我们只存储运行账号所必需的最少信息:"],
      bullets: [
        "你的邮箱地址和一个显示名。",
        "你使用的登录方式(Google,或邮箱魔法链接)。魔法链接令牌只以哈希形式存储,绝不明文保存。",
        "登录会话,保存在安全的 httpOnly cookie 中。",
        "你注册的设备,以一个随机设备 id 和设备名(例如你的平台名称)的形式。",
      ],
    },
    {
      heading: "我们绝不收集什么",
      body: ["本服务的设计确保以下内容绝不会到达我们的服务器:"],
      bullets: ["你的文件内容。", "你的文件名。", "你的加密密钥。"],
    },
    {
      heading: "跨网络中继(TURN)",
      body: [
        "当两台设备无法跨网络直接连接时,加密流会通过 TURN 服务器中继。中继依然无法读取你的文件——它们始终保持端到端加密。出于运营目的,我们仅记录某次传输中继的字节数,并归属到创建该传输的登录用户。我们绝不检查中继内容。",
      ],
    },
    {
      heading: "Cookie 与本地存储",
      body: [
        "我们使用一个会话 cookie 来保持你的登录状态。在你浏览器的本地存储中,我们保存一个随机设备 id,以便识别你注册过的设备。我们不使用广告或追踪 cookie。",
      ],
    },
    {
      heading: "第三方服务",
      body: ["只有在你选择使用时,才会涉及少数第三方:"],
      bullets: [
        "Google——如果你用 Google 登录,我们会获取你的邮箱和基本资料以创建账号。",
        "邮件发送服务商——用于发送魔法链接登录邮件。",
      ],
    },
    {
      heading: "数据保留与删除",
      body: [
        "账号数据在你的账号存在期间保留。你可以随时通过 support@relayium.com 联系我们,要求删除你的账号及其数据。",
      ],
    },
    {
      heading: "本政策的变更",
      body: ["随着服务演进,我们可能会更新本政策。届时我们会更新上方的「最后更新」日期。"],
    },
    {
      heading: "联系我们",
      body: ["有隐私方面的疑问?请发邮件至 support@relayium.com。"],
    },
  ],
};

export default { slug: "privacy", langs: { en, zh, ja: en, ko: en, de: en, fr: en } };
