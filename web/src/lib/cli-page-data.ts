// /cli 页里那些**不翻译**的东西：命令名、flag、文件名、指南 slug、图标。
//
// 从 CliPage.svelte 搬出来的，不是为了整洁，是为了让类型系统能把它们和 i18n 表钉在
// 一起。页面把这些常量和 t.cliPage 里的文案**按下标配对**渲染（第 i 个 flag 配第 i
// 条解释）。下标配对本身没问题，问题是没有任何东西保证两边一样长：翻译里少一条、
// 或者这里多加一个 flag，渲染出来就是错位或 undefined，而且是**静默**的——9 个语言
// 文件，靠人肉数是不可能守住的。
//
// 下面的 SameLength 把"一样长"这件事变成编译期约束：往 FLAG_ROWS 里加一行，9 份
// 语言文件立刻全部报类型错，直到每一份都补上对应的解释为止。
//
// `as const` 是必须的：没有它，typeof 得到的是 string[] 而不是定长元组，SameLength
// 就退化成普通数组、一点约束都不剩。

/**
 * 与某个常量数组**等长**的字符串元组。
 *
 * 同态映射类型作用在元组上会保留长度，这正是这里要的：
 * `SameLength<typeof FLAG_ROWS>` 就是"15 个字符串，不多不少"。
 */
export type SameLength<T extends readonly unknown[]> = { -readonly [K in keyof T]: string };

/** "该用哪种模式"的几张卡片。文案（什么时候用）在 t.cliPage.pickWhen。 */
export const PICK_MODES = [
  { g: "🔑", title: "push / pull", cmd: "relayium push … user@host:path" },
  { g: "🔗", title: "send / receive", cmd: "relayium send … / receive <code>" },
  { g: "🖧", title: "daemon direct", cmd: "relayium push … relayium://host" },
  { g: "🔁", title: "sync", cmd: "relayium sync … relayium://host" },
  { g: "☁️", title: "up / down", cmd: "relayium up … / down <link>" },
] as const;

/** flag 参考表的前两列（flag 本身、作用于哪些子命令）。第三列在 t.cliPage.flagMeanings。 */
export const FLAG_ROWS = [
  { flag: "--dir <d>", who: "serve" },
  { flag: "--port <n>", who: "serve, relayium://" },
  { flag: "--once", who: "serve" },
  { flag: "--no-resume", who: "push / pull / serve" },
  { flag: "--config-dir <d>", who: "serve / push / sync / id / authorize" },
  { flag: "-i <file>", who: "push / pull / sync" },
  { flag: "-p <n>", who: "push / pull / sync" },
  { flag: "--verify", who: "send / receive" },
  { flag: "--delete", who: "sync" },
  { flag: "--watch", who: "sync" },
  { flag: "--allow-delete", who: "serve" },
  { flag: "--burn", who: "up" },
  { flag: "--ttl <dur>", who: "up" },
  { flag: "--max-downloads <n>", who: "up" },
  { flag: "--server <url>", who: "login / up / down / send / receive" },
] as const;

/** 本地信任材料的文件名。说明在 t.cliPage.fileDescs。 */
export const TRUST_FILES = ["id.key / id.crt", "known_hosts", "authorized_fingerprints"] as const;

/** 指南卡片：slug 与图标。标题在 t.cliPage.guides。 */
export const GUIDES = [
  { slug: "guides/transfer-files-from-terminal", icon: "🚀" },
  { slug: "guides/back-up-a-server-over-ssh", icon: "🔑" },
  { slug: "guides/send-a-file-to-someone", icon: "🔗" },
  { slug: "guides/server-to-server-transfers", icon: "🖧" },
  { slug: "guides/sync-a-large-folder-between-servers", icon: "🔁" },
  { slug: "guides/push-to-cloud-pull-on-another-computer", icon: "☁️" },
] as const;
