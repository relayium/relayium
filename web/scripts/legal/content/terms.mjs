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

export default { slug: "terms", langs: { en, zh, ja: en, ko: en, de: en, fr: en } };
