// 配对码的字母表与归一化。**必须与 server/internal/signal/pair.go 逐字一致**——
// 服务端会按同一套规则拒掉形状不对的码，两边不一致的表现是「界面让你输，服务端说
// 无效」，而且只在某些字符上才复现，极难查。pair-code.test.ts 钉住了这份一致性。
//
// 为什么是这 24 个字符：每一对易混字符都只留一个（B/8 留 8、G/6 留 6、S/5 留 5、
// Z/2 留 2、Q 与 O 都不留、U/V 都不留、I/L/O 不留，连带 0 和 1 也不留）。码是从一
// 块屏幕上读出来、在另一台设备上敲进去的，看错一位就是一次失败的加入。
export const CODE_ALPHABET = "ACDEFHJKMNPRTWXY23456789";

/** 配对码长度。24^6 ≈ 1.91 亿，理由见 pair.go 的 CodeLen 注释。 */
export const CODE_LEN = 6;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

/** 是否是一个形状合法的配对码（已归一化的输入）。 */
export function isValidCode(s: string): boolean {
  return CODE_RE.test(s);
}

/**
 * 把用户敲进来的东西归一化成候选码。
 *
 * - 转大写：码一律以大写示人，但没人愿意为此按住 shift。
 * - 丢掉字母表之外的一切（空格、连字符、从聊天里连带复制的引号）。
 * - **不做 O→0 / I→1 这类映射**：0 和 1 不在字母表里，映过去只会得到一个必然无效
 *   的码。抄错 O 的人真正想输的是 0 之外的某个字符，直接丢掉、让他重看一眼，比
 *   悄悄替换成一个错码要好。
 */
export function normalizeCode(input: string): string {
  const up = input.toUpperCase();
  let out = "";
  for (const ch of up) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out.slice(0, CODE_LEN);
}
