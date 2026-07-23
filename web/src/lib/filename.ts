// 对端/服务端提供的文件名的清洗。文件名在 relayium 里全程是**不可信输入**：
// 实时模式由发送端任意构造，存储模式由上传者任意构造，两者最后都会渲染进接收方
// 的确认卡片、下载列表和传输记录——而那张确认卡片正是用户做信任决策的地方。

/**
 * Unicode Bidi_Control 属性的全部码点：U+061C（ALM）、U+200E–U+200F（LRM/RLM）、
 * U+202A–U+202E（LRE/RLE/PDF/LRO/RLO）、U+2066–U+2069（LRI/RLI/FSI/PDI）。
 * 用 String.fromCodePoint 从数值码点拼字符类，不在源码里直接敲这些字符本身——
 * 敲字面字符会让这份 .ts 源文件自己变成一份 Trojan Source（CVE-2021-42574）：
 * RLO/LRO 之类的字符一旦落进源码，编辑器会把它之后的代码视觉重排，这正是本
 * 模块想替 relayium 的 UI 挡掉的攻击手法，源码自己没道理反过来中招。
 */
const BIDI_CONTROL_RE = new RegExp(
  `[${String.fromCodePoint(0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069)}]`,
  "g",
);

/**
 * 剥离双向文本控制符。浏览器只在**落盘**时替我们剥掉一部分（Content-Disposition
 * 那条路径），我们自己页面上渲染文件名的地方没有任何保护：一个 RLO 就能让
 * evil<RLO>gnp.exe 在 UI 里视觉倒转成看着像 evilexe.png 的东西，是经典的伪装
 * 可执行文件手法。
 *
 * LRO/RLO/LRE/RLE 和四个 isolate 会真正重排/隔离显示顺序，是核心风险；
 * LRM/RLM 只影响相邻中性字符的方向，但同样没道理出现在文件名里，一并清掉
 * 更简单也不留后门。ALM（U+061C）单独出现时比前面这些都弱——它只影响
 * 数字/中性符号的局部方向，不会像 RLO 那样反转扩展名，也不代表"阿拉伯语
 * 文字本身"（文件名合法带阿拉伯语文字是另一回事，ALM 是控制符不是文字）——
 * 但它仍是 Bidi_Control 这同一族里的不可见格式字符，在文件名里没有任何合法
 * 用途，一并剥掉能让"剥离双向控制符"这条规则整族生效，不留一个解释不清的
 * 例外。
 */
export function stripBidi(s: string): string {
  return s.replace(BIDI_CONTROL_RE, "");
}

/**
 * 进入 UI 之前的文件名清洗：剥双向控制符，外加剥掉 C0/C1 控制字符
 * （换行/制表在一个文件名里同样只可能是伪装，且会撑破列表布局）。
 *
 * **在数据进入应用的边界上调用一次**（manifest 解析、服务端列表拉取），
 * 下游的渲染、历史记录和落盘名统一用清洗后的值——散在各个模板里调用必然漏。
 */
export function safeDisplayName(s: string): string {
  return stripBidi(s).replace(CONTROL_RE, "");
}

/** C0（U+0000–U+001F）、DEL 与 C1（U+007F–U+009F）。同样用码点拼，理由见
 *  BIDI_CONTROL_RE 的注释——CR/LF 落进源码里的字符类同样是给自己下绊子。 */
const CONTROL_RE = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}]`,
  "g",
);

/** 就地清洗一批 `{ name }` 记录，保留其余字段。 */
export function sanitizeNames<T extends { name: string }>(items: T[]): T[] {
  return items.map((f) => ({ ...f, name: safeDisplayName(f.name) }));
}
