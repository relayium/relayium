// 流式下载（service worker 落盘）的纯逻辑：URL 约定 + Content-Disposition 构造。
//
// 没有 File System Access API 的浏览器（Firefox / Safari / 手机）无法把大文件直接
// 写进磁盘，只能整份堆进内存。绕开办法是让页面向一个假 URL 发起下载导航，由 SW
// 拦截并用一个 ReadableStream 作为响应体——浏览器边收边写盘，内存占用恒定。
//
// jsdom 没有 service worker，SW 脚本本身测不了，所以这里只放**不依赖 SW 运行时**
// 的部分，sw.js 侧只做 glue（拦截 → parseStreamPath → 取流 → 带 contentDisposition
// 响应）。和 zip.ts 导出纯 crc32/safeSegments 是同一个路子。

/**
 * 流式 URL 的路径前缀。用 dunder 命名与真实路由隔离：
 * router.svelte.ts 的路由表（/、/cross-network、/offline-transfer、/me、/cli、
 * /apps、/pricing、/verify-email、/reset-password、/d/<id>）、后端的 /api/ /ws
 * /blob/ /admin /device /healthz、以及 web/public/ 下的静态文件都不以 __ 开头。
 * SW 内部给 Web Share Target 落盘用的 /__shared__/ 也已经是这个约定。
 */
export const STREAM_ROUTE = "/__stream__/";

/** 令牌字母表：URL-safe base64 的字符集。故意不含 "."、"%" 和 "/"，
 *  所以 "."、".."、百分号编码和多段路径都会被 parseStreamPath 直接判死。 */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 名字被清干净后什么都不剩时的兜底名（必须非空，否则 header 里会出现 filename=""）。 */
const FALLBACK_NAME = "download";

/** 文件名保留的最大码点数——只承诺码点，不承诺字节。太长的名字会撑爆 header；
 *  120 个 CJK 字码点会有 360 UTF-8 字节，早就超过 ext4/APFS 的 255 字节上限，
 *  所以这里不复述"字节上限"这句话，免得读者以为截断已经在按字节数。真要卡
 *  255 字节，得改成按字节预算截断且不劈断多字节序列——这里没做，因为落盘文件名
 *  最终还要过一遍浏览器自己的 OS 级截断/清洗（见 asciiFallback 的注释），
 *  这层再精确卡字节收益有限，不值得多这份复杂度。 */
const MAX_NAME = 120;

/**
 * 构造流式下载 URL。文件名放进 path 只是给浏览器一个极端情况下的回落名
 * （比如 SW 没接管、响应缺 header），**真正定名的是 Content-Disposition**。
 *
 * token 不合法时直接抛错而不是悄悄产出一个 SW 必然拒绝的 URL——那种失败会表现为
 * 下载卡死，很难排查。
 */
export function streamURL(token: string, filename: string): string {
  if (!TOKEN_RE.test(token)) {
    throw new Error(`streamURL: invalid token ${JSON.stringify(token)}`);
  }
  // encodeURIComponent 会把 "/"、"?"、"#" 一并编码，所以攻击者控制的文件名
  // 无法伪造出额外的路径段或 query。
  //
  // 但 "."、".." 这两个值 encodeURIComponent 不编码（它们本来就是普通字符），
  // 而它们恰好是 URL 里的点段：浏览器在发请求前就会把路径规范化，
  // 把 "/__stream__/<token>/.." 折成 "/__stream__/"，请求根本不会带着
  // token 一起发出去，parseStreamPath 也就无从解析——这不是安全逃逸
  // （"/" 已经被编码成 "%2F"，点段只能把路径折回 STREAM_ROUTE 自身这一个
  // 非路由的前缀），但会让下载静默地落到 SPA 外壳。这里直接把这两个值当
  // 空文件名处理，换成兜底名。
  const safeName = filename === "." || filename === ".." ? FALLBACK_NAME : filename || FALLBACK_NAME;
  return STREAM_ROUTE + token + "/" + encodeURIComponent(safeName);
}

/**
 * SW 侧解析：只接受 streamURL 产出的那一种形状，即
 * `/__stream__/<token>/<filename>` 恰好两段、token 合法、文件名段非空。
 * 其余一律 null（畸形输入不该走进取流逻辑）。
 */
export function parseStreamPath(pathname: string): { token: string } | null {
  if (!pathname.startsWith(STREAM_ROUTE)) return null;
  const segs = pathname.slice(STREAM_ROUTE.length).split("/");
  if (segs.length !== 2 || segs[1] === "") return null;
  if (!TOKEN_RE.test(segs[0])) return null;
  return { token: segs[0] };
}

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
 * 剥离双向文本控制符。**不是** header 注入防护——百分号编码之后 header 仍是纯
 * ASCII，Chrome/Firefox 落盘时也会各自剥掉 RLO 这类字符——真正的风险面是
 * relayium 自己页面上渲染文件名的地方（下载列表、传输记录等）没有任何浏览器
 * 给的保护：一个 RLO 就能让存的名字 evil<RLO>gnp.exe 在我们自己的 UI 里视觉
 * 倒转成看着像 evilexe.png 的东西，是经典的伪装可执行文件手法。
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
function stripBidi(s: string): string {
  return s.replace(BIDI_CONTROL_RE, "");
}

/**
 * 去掉不能进 header 的字符：
 *  - C0/C1 控制字符（含 CR/LF）。文件名在实时模式下完全由发送端控制
 *    （见 zip.ts 的 safeSegments 注释），带 \r\n 就是 header 注入。
 *  - 双向文本控制符。这不是本条注释的重点，理由和码点列表见 stripBidi 的注释。
 *  - 落单的代理项。它们会让 encodeURIComponent 抛 URIError，直接把下载打断。
 */
function stripUnsafe(s: string): string {
  return stripBidi(s)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\ud800-\udbff][\udc00-\udfff]|([\ud800-\udfff])/g, (m, lone) => (lone ? "" : m));
}

/** 按码点截断（绝不劈开代理对），尽量保住扩展名——没有扩展名的文件在 Windows 上很难打开。 */
function truncate(s: string): string {
  const cp = Array.from(s);
  if (cp.length <= MAX_NAME) return s;
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(s)?.[0] ?? "";
  return cp.slice(0, MAX_NAME - ext.length).join("") + ext;
}

/**
 * ASCII 回落名：不认识 filename* 的老浏览器只能读它，所以宁可失真也不能带毒。
 * 保留可打印 ASCII，其余（含所有非 ASCII）换成 "_"；额外挡掉
 * `"`（会提前闭合 quoted-string）、`\`（quoted-string 的转义引导符）、
 * `;`（会被当成下一个参数的开始）、`/`（会被某些客户端当路径）。
 *
 * 注意这份清洗**只保护 header 语法，不保护用户实际落盘拿到的文件名**：
 * 现代浏览器（Chrome/Firefox/Safari）在 filename* 存在时会优先用 filename*、
 * 完全忽略这个 ASCII 回落名，所以它谁也保护不了「文件系统」这一层——真正
 * 替用户把落盘文件名洗安全的是浏览器自己（Chrome 的
 * ReplaceIllegalCharactersInPath、Firefox 的 DownloadPaths.sanitize、
 * Safari 对 basename 的压平）。别把这份清洗当成文件系统层的安全边界去加固——
 * 它加固的是别的东西：quoted-string 的语法完整性。
 */
function asciiFallback(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0x20 && c <= 0x7e && !`"\\;/`.includes(ch) ? ch : "_";
  }
  return out;
}

/**
 * RFC 5987 的 value-chars 编码。encodeURIComponent 还不够：它把 ' ( ) * 留成原样，
 * 而这四个都不是 attr-char。尤其 `'` 是 `UTF-8''<value>` 的分隔符，留原样会让
 * 严格解析器在文件名中间截断（拿到错的名字）。
 */
function rfc5987(s: string): string {
  return encodeURIComponent(s).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * 构造 Content-Disposition。双 filename 是必须的：只给 filename* 老浏览器会拿不到名字，
 * 只给 ASCII 回落则中文名会变成一串下划线。
 *
 * 例：contentDisposition("图 片.svg")
 *   => `attachment; filename="_ _.svg"; filename*=UTF-8''%E5%9B%BE%20%E7%89%87.svg`
 */
export function contentDisposition(filename: string): string {
  const name = truncate(stripUnsafe(filename)) || FALLBACK_NAME;
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}
