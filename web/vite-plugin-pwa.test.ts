// @vitest-environment node
//
// 构建插件边界上的真行为测试。
//
// 环境必须是 node：插件用 fileURLToPath(new URL("./src/sw-template.js", import.meta.url))
// 找模板，而在 jsdom 环境里 import.meta.url 会被改写成 http: 开头，fileURLToPath 直接抛。
// 这是构建期代码，本来也不该跑在 DOM 里。
//
// 这里**真的调用** pwaPlugin().generateBundle，喂一份有代表性的 bundle，再解析它
// emit 出来的 sw.js —— 而不是对插件源码做文本断言。差别是实测出来的：语言包该不该
// 进 precache 是一条产品决策，它的回归必须由「生成的名单里到底有什么」来钉，源码里
// 换个写法就绕过去的断言等于没有。
import { describe, it, expect, vi } from "vitest";
import { pwaPlugin } from "./vite-plugin-pwa";
import { LANGS } from "./src/lib/i18n/types";

type Emitted = { type: string; fileName: string; source: string };

/** 一个 chunk 的最小形状：插件只看 type / facadeModuleId / moduleIds。 */
function chunk(modules: string[]) {
  return { type: "chunk" as const, facadeModuleId: modules[0] ?? null, moduleIds: modules };
}
function asset() {
  return { type: "asset" as const };
}

const SRC = "/repo/web/src";
/** 九个语言目录各自单独成块，就是当前构建的真实形状。 */
function langChunks(codes = LANGS.map((l) => l.code)): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [i, code] of codes.entries()) {
    out[`assets/${code}-Hash${i}0000000.js`] = chunk([`${SRC}/lib/i18n/${code}.ts`]);
  }
  return out;
}

/** 一份有代表性的 bundle：入口 + 样式 + 一个懒加载路由 + 九个语言目录 + 若干非代码资源。 */
function representativeBundle(extra: Record<string, unknown> = {}) {
  return {
    "assets/index-Aaaaaaaa.js": chunk([`${SRC}/main.ts`, `${SRC}/App.svelte`]),
    "assets/index-Bbbbbbbb.css": asset(),
    "assets/PricingPage-Cccccccc.js": chunk([`${SRC}/lib/PricingPage.svelte`]),
    ...langChunks(),
    // 非代码资源：图标、图片、字体、HTML 外壳。它们不该进 precache —— 名单是
    // 「起应用要的代码」，不是整个 dist。
    "assets/og-image-Dddddddd.jpg": asset(),
    "icons-Eeeeeeee.svg": asset(),
    "index.html": asset(),
    "favicon.svg": asset(),
    ...extra,
  };
}

/** 跑一遍 generateBundle，把 emit 出来的 sw.js 和它内嵌的名单/版本解析出来。 */
function run(bundle: Record<string, unknown>) {
  const emitted: Emitted[] = [];
  const errors: string[] = [];
  const ctx = {
    emitFile: (f: Emitted) => void emitted.push(f),
    error: (m: string) => {
      errors.push(m);
      throw new Error(m); // Rollup 的 this.error 就是抛，构建当场停
    },
  };
  const plugin = pwaPlugin() as unknown as {
    generateBundle: (this: unknown, o: unknown, b: unknown) => void;
  };

  let threw: Error | null = null;
  try {
    plugin.generateBundle.call(ctx, {}, bundle);
  } catch (e) {
    threw = e as Error;
  }

  const sw = emitted.find((f) => f.fileName === "sw.js");
  const precache: string[] = sw ? JSON.parse(/const PRECACHE = (\[.*?\]);/s.exec(sw.source)![1]) : [];
  const version = sw ? /const VERSION = "([^"]+)"/.exec(sw.source)![1] : "";
  return { emitted, errors, threw, sw, precache, version };
}

describe("pwaPlugin 的 precache 名单", () => {
  it("emit 出 sw.js，占位符全部被替换", () => {
    const { sw } = run(representativeBundle());
    expect(sw).toBeTruthy();
    expect(sw!.source).not.toContain("__PRECACHE__");
    expect(sw!.source).not.toContain("__VERSION__");
    expect(sw!.source).not.toContain("__SHARE_ROUTE__");
    expect(sw!.source).not.toContain("__STREAM_ROUTE__");
  });

  // 本轮修的缺陷：SW 是在页面加载**之后**才注册/接管的，首屏那次取语言包根本不经过
  // SW，所以进不了任何缓存。运行时回填补不上——它只在已被接管的加载里发生。名单里少
  // 一种语言，那种语言的用户首次安装后离线就起不来。
  it("九个语言目录一个不落地进名单", () => {
    const { precache } = run(representativeBundle());

    for (const { code } of LANGS) {
      const hit = precache.filter((p) => new RegExp(`^/assets/${code}-\\w+\\.js$`).test(p));
      expect(hit, `${code} 的语言目录必须在 precache 里`).toHaveLength(1);
    }
  });

  it("普通 JS/CSS 照旧在名单里", () => {
    const { precache } = run(representativeBundle());
    expect(precache).toContain("/assets/index-Aaaaaaaa.js");
    expect(precache).toContain("/assets/index-Bbbbbbbb.css");
    expect(precache).toContain("/assets/PricingPage-Cccccccc.js");
    expect(precache).toContain("/");
    expect(precache).toContain("/site.webmanifest");
  });

  it("非代码资源不进名单", () => {
    const { precache } = run(representativeBundle());
    expect(precache).not.toContain("/assets/og-image-Dddddddd.jpg");
    expect(precache).not.toContain("/icons-Eeeeeeee.svg");
    expect(precache).not.toContain("/index.html");
    expect(precache).not.toContain("/favicon.svg");
  });

  it("名单是排过序的，同一份 bundle 两次跑出一样的版本", () => {
    const a = run(representativeBundle());
    const b = run(representativeBundle());
    expect(a.precache).toEqual([...a.precache].sort());
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
  });

  // 语言包必须参与版本推导，否则「只改了某个语言的文案」这种发版不会产生新的一代
  // 缓存，老 SW 会继续拿旧目录，改动对已装过的用户永远不生效。
  it("只有语言文件名变了，版本和名单也跟着变", () => {
    const before = run(representativeBundle());

    // ja 的文案改了 → 内容 hash 变 → 文件名变。**替换**而不是新增，否则这条会退化成
    // 「多了一个文件所以版本变了」，根本没在考语言包参不参与版本推导。
    const renamed = representativeBundle();
    const old = Object.keys(renamed).find((f) => f.startsWith("assets/ja-"))!;
    delete (renamed as Record<string, unknown>)[old];
    (renamed as Record<string, unknown>)["assets/ja-CHANGEDHASH.js"] = chunk([`${SRC}/lib/i18n/ja.ts`]);
    const after = run(renamed);

    expect(after.precache).toHaveLength(before.precache.length); // 条数没变，只换了名字
    expect(after.precache).toContain("/assets/ja-CHANGEDHASH.js");
    expect(after.precache).not.toContain("/" + old);
    expect(after.version, "语言包没参与版本推导的话，改了文案也不会产生新一代缓存")
      .not.toBe(before.version);
  });

  // 静默漏掉一种语言是这一整条修复最怕的回归：它只在有人恰好用那种语言试离线时才
  // 暴露。构建必须当场红。
  it("有语言目录没进名单时，构建直接失败并点名", () => {
    // 语言 chunk 被打成一个非 JS 的产物（或被别的插件改了名），落不进名单。
    const bundle = representativeBundle();
    delete (bundle as Record<string, unknown>)["assets/ko-Hash30000000.js"];
    (bundle as Record<string, unknown>)["assets/ko-Hash30000000.woff2"] = chunk([`${SRC}/lib/i18n/ko.ts`]);
    // this.error 之外还会直接打一行 stderr（理由见插件里的注释）。这里接住它，
    // 顺便断言那行确实发出去了。
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => void logged.push(String(m)));

    const { threw, errors } = run(bundle);
    spy.mockRestore();

    expect(threw, "必须抛出来把构建停掉").toBeTruthy();
    expect(errors[0]).toContain("ko");
    expect(errors[0]).not.toContain("ja"); // 只点名真缺的那个
    expect(logged[0], "真正的原因必须自己出现在终端上").toContain("ko");
  });

  it("语言目录被并进别的 chunk 时也算覆盖（认源模块，不认文件名）", () => {
    const bundle: Record<string, unknown> = {
      "assets/index-Aaaaaaaa.js": chunk([`${SRC}/main.ts`]),
      // 九种语言全被合进同一个 chunk —— 文件名里一个语言代码都没有。
      "assets/merged-Ffffffff.js": chunk(LANGS.map((l) => `${SRC}/lib/i18n/${l.code}.ts`)),
    };

    const { threw, precache } = run(bundle);

    expect(threw).toBeNull();
    expect(precache).toContain("/assets/merged-Ffffffff.js");
  });

  it("只有 facadeModuleId 指向语言目录时也算覆盖", () => {
    const bundle: Record<string, unknown> = { "assets/index-Aaaaaaaa.js": chunk([`${SRC}/main.ts`]) };
    for (const { code } of LANGS) {
      bundle[`assets/${code}-Zz000000.js`] = {
        type: "chunk" as const,
        facadeModuleId: `${SRC}/lib/i18n/${code}.ts`,
        moduleIds: undefined, // 老 rollup 只给 modules
        modules: { [`${SRC}/lib/i18n/${code}.ts`]: {} },
      };
    }
    expect(run(bundle).threw).toBeNull();
  });
});
