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

/** 文件名保留的最大码点数。太长的名字会撑爆 header，也超出多数文件系统的 255 字节上限。 */
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
  return STREAM_ROUTE + token + "/" + encodeURIComponent(filename || FALLBACK_NAME);
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
 * 去掉不能进 header 的字符：
 *  - C0/C1 控制字符（含 CR/LF）。文件名在实时模式下完全由发送端控制
 *    （见 zip.ts 的 safeSegments 注释），带 \r\n 就是 header 注入。
 *  - 落单的代理项。它们会让 encodeURIComponent 抛 URIError，直接把下载打断。
 */
function stripUnsafe(s: string): string {
  return s
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
