import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { STREAM_ROUTE } from "./src/lib/sw-stream.js";
// 语言清单从应用自己的那份取，不在这里再抄一遍：加一种语言只改 types.ts，下面的
// 覆盖校验自动跟着变。types.ts 是纯类型 + 常量，没有 rune，配置期 import 得动。
import { LANGS } from "./src/lib/i18n/types.js";

const SHARE_ROUTE = "/share-target";

/**
 * Emits a hand-written service worker (`/sw.js`) that precaches the app shell.
 * The precache list is every built JS/CSS file — language catalogues included —
 * plus the root document and the manifest; the cache version is a hash of that
 * list, so it changes exactly when a hashed asset name changes, which now
 * includes a changed language catalogue. No Workbox.
 *
 * Old shells are NOT all evicted on activate: the two most recently created ones
 * are kept (see KEEP_OLD_SHELLS in sw-template.js). A deploy does not touch a tab
 * that is already open — it keeps running the JavaScript it loaded with, and that
 * JavaScript lazy-loads routes by their old hashed filenames, which the server no
 * longer has. Deleting the old shell made those routes render blank, which is
 * exactly the "finish what you are doing, then refresh" promise the update notice
 * makes. Retention is bounded, not indefinite.
 */
export function pwaPlugin(): Plugin {
  return {
    name: "relayium-pwa",
    apply: "build",
    generateBundle(_options, bundle) {
      const templatePath = fileURLToPath(new URL("./src/sw-template.js", import.meta.url));
      const template = readFileSync(templatePath, "utf8");

      // 每一个产出的 JS/CSS 都进 precache，**语言包也不例外**。
      //
      // 语言包曾经被排除在外，理由是「九种里用户只读一两种，其余是白花的安装流量」。
      // 那个理由算错了一笔账：SW 是页面加载**之后**才注册、install、claim 的，而首屏
      // 那次取语言包发生在页面还没被接管的时候，所以那次请求根本不经过 SW，也就进不了
      // 任何缓存。真机复现过（全站 no-store 的全新来源）：首次加载英文 → SW 装好接管 →
      // 立刻断网 → 重新导航时根文档从缓存出来了，en-*.js 却 ERR_FAILED，应用起不来。
      // 靠运行时回填补不上这个洞：回填只在**已被接管**的那一次加载才发生，而首次安装
      // 那一次按定义就不是。
      //
      // 代价是实测的（本次构建）：九个语言包 563,304 字节原始 / 约 184.5 KB gzip；
      // precache 从 41 条约 0.89 MiB 涨到 50 条 1,495,071 字节（1.43 MiB 原始 /
      // 0.47 MiB gzip），当前 + 保留两代旧壳约 4.3 MiB 原始。换来的是「首次安装后
      // 离线也能用选中的语言起来，并且能离线切换语言」这个确定性。
      //
      // 另一面要知道：cache.addAll 是全有或全无，名单长一条就多一次可能失败的请求。
      // 但这正是想要的——半份 shell 会把本次修的缺陷原样带回来，而且是静默的。装不上
      // 就是装不上，页面照旧在线可用，下次访问再试。
      //
      // 注意 precache 只是**取字节存起来**，不是执行：应用照旧按需 import() 单个语言
      // 目录，初始 JS 的体积和执行行为一点没变。
      const assets = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        .map((f) => "/" + f);
      const precache = ["/", "/site.webmanifest", ...assets].sort();
      const version = createHash("sha1").update(precache.join("\n")).digest("hex").slice(0, 12);

      // 硬保证：每一种语言都必须真的有一份目录落进 precache。少一种，那种语言的用户
      // 在首次安装后离线就起不来 —— 而且是静默的，直到有人恰好用那种语言试离线。
      // 宁可让构建当场红。
      //
      // 认的是**源模块**而不是文件名：`assets/en-*.js` 这种正则哪天冒出个 entry-*.js
      // 就误伤，而且加一种语言时它不会提醒任何人。moduleIds 覆盖了「语言目录被并进
      // 别的 chunk」这种打包结果，facadeModuleId 只覆盖它自己单独成块的情况。
      const codes = LANGS.map((l) => l.code);
      const covered = new Set<string>();
      for (const path of precache) {
        const c = bundle[path.slice(1)];
        if (!c || c.type !== "chunk") continue;
        const ids = [c.facadeModuleId ?? "", ...(c.moduleIds ?? Object.keys(c.modules ?? {}))];
        for (const code of codes) {
          if (ids.some((id) => id.endsWith(`/lib/i18n/${code}.ts`))) covered.add(code);
        }
      }
      const missing = codes.filter((c) => !covered.has(c));
      if (missing.length > 0) {
        const msg =
          `relayium-pwa: these language catalogues are not in the shell precache: ${missing.join(", ")}. ` +
          `Users of those languages would fail to boot offline after a first install.`;
        // 先直接打到 stderr 再 this.error：this.error 会中止产物写盘，而后面的
        // closeBundle 钩子（route-shells 要读 dist/index.html）随即以 ENOENT 失败，
        // 报到终端上的往往是那个 ENOENT，真正的原因反而看不见。实测如此。
        console.error(msg);
        this.error(msg);
      }

      const sw = template
        .replace("__PRECACHE__", JSON.stringify(precache))
        .replace("__VERSION__", version)
        .replace("__SHARE_ROUTE__", SHARE_ROUTE)
        // STREAM_ROUTE 直接从 lib/sw-stream.ts import：SW 侧和页面侧必须逐字相同，
        // 差一个字符就是「下载到一个网页」。sw-template.js 不参与打包，import 不了，
        // 所以只能在这里替换（和 __SHARE_ROUTE__ 一个路子）。
        .replace("__STREAM_ROUTE__", STREAM_ROUTE);

      this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
    },
  };
}
