// 配对码的字母表与归一化。**必须与 server/internal/signal/pair.go 逐字一致**——
// 服务端会按同一套规则拒掉形状不对的码，两边不一致的表现是「界面让你输，服务端说
// 无效」，而且只在某些字符上才复现，极难查。pair-code.test.ts 钉住了这份一致性。
//
// 为什么是十个数字：码要在手机上输入（最常见的接收设备），而 inputmode="numeric"
// 只有在整个码都是数字时才成立；码也要能在电话里念出来，字母表里的 D/E/T/P 和 M/N
// 听起来是一样的。丢掉的熵由更短的 TTL 和更紧的加入限流补回来，取舍写在 pair.go 的
// CodeLen 注释里。
export const CODE_ALPHABET = "0123456789";

/** 配对码长度。10^6，理由见 pair.go 的 CodeLen 注释。 */
export const CODE_LEN = 6;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

/** 是否是一个形状合法的配对码（已归一化的输入）。 */
export function isValidCode(s: string): boolean {
  return CODE_RE.test(s);
}

/**
 * 把用户敲进来的东西归一化成候选码：只保留 ASCII 数字，截断到码长。
 *
 * - 丢掉数字之外的一切（空格、连字符、从聊天里连带复制的引号、全角数字）。
 * - **不做 O→0 / I→1 这类映射**：抄错 O 的人真正想输的是别的某个数字，悄悄替换
 *   成一个错码，比直接丢掉、让他重看一眼那一位要糟。
 * - **前导零是有意义的**：码是一个六字符串，不是一个整数。任何 Number()/parseInt
 *   往返都会毁掉码空间的 10%，所以这里从头到尾只有字符串操作。
 */
export function normalizeCode(input: string): string {
  let out = "";
  for (const ch of input) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out.slice(0, CODE_LEN);
}
