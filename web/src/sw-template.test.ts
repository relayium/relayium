// sw-template.js 的真行为测试。
//
// 这个文件长期被当成"测不了的"：它不参与打包、也不能被 import，而 jsdom 没有
// service worker。但它是**无 import 的纯 JS**，需要的运行时（ReadableStream /
// Response / MessageChannel / URL）jsdom 全都有——用 new Function 把源码跑起来、
// 配一套假 self/caches，就能真的驱动 fetch 分派和 pull/cancel 的时序。
//
// 这比"读源码文本比对分支顺序"强得多：那种断言有过一次实测到的假阴性
//（`src.indexOf("STREAM_ROUTE)")` 会先撞上 openStream 里的同名匹配，把流式分支
// 挪到 navigate 之后仍然全绿）。下面的用例改成真发一个 mode:"navigate" 的请求。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STREAM_ROUTE, streamURL, contentDisposition } from "./lib/sw-stream";

const ORIGIN = "https://relayium.test";
const SHARE_ROUTE = "/share-target";

interface FetchEvent {
  request: { method: string; url: string; mode?: string };
  respondWith: (r: Response | Promise<Response>) => void;
}

/** 把 sw-template.js 当成真 SW 跑起来，返回驱动它的把手。 */
function loadSW() {
  const src = readFileSync(resolve(process.cwd(), "src/sw-template.js"), "utf8")
    .replace("__VERSION__", "test")
    .replace("__PRECACHE__", "[]")
    .replace("__SHARE_ROUTE__", SHARE_ROUTE)
    .replace("__STREAM_ROUTE__", STREAM_ROUTE);

  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const skipWaitingCalls: number[] = [];
  const swSelf = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] ||= []).push(f),
    skipWaiting: () => void skipWaitingCalls.push(1),
    clients: { claim: async () => {} },
  };
  // caches / fetch 大多只是为了让脚本能加载；缓存写入这一项是真的被断言的，
  // 所以 put 记账而不是空实现。
  const put: { url: string; body: string }[] = [];
  const cachesStub = {
    open: async () => ({
      addAll: async () => {},
      put: async (req: { url: string }, res: Response) => void put.push({ url: req.url, body: await res.text() }),
    }),
    keys: async () => [] as string[],
    delete: async () => true,
    match: async () => undefined,
  };
  const fetchStub = async () => new Response("from network");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", "caches", "fetch", src)(swSelf, cachesStub, fetchStub);

  return {
    put,
    skipWaitingCalls,
    /** 触发 install（并 await 它 waitUntil 的那个 promise）。 */
    async install() {
      let done: Promise<unknown> = Promise.resolve();
      for (const f of listeners.install || []) f({ waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
    },
    /** 发一个 fetch 事件，返回 SW 交出的 Response；没拦截则返回 null。 */
    fetch(req: { method?: string; url: string; mode?: string }): Promise<Response> | null {
      let answer: Promise<Response> | null = null;
      const e: FetchEvent = {
        request: { method: "GET", ...req },
        respondWith: (r) => { answer = Promise.resolve(r); },
      };
      for (const f of listeners.fetch || []) f(e);
      return answer;
    },
    /** 发一个 message 事件（带可选的 MessagePort）。 */
    message(data: unknown, ports: MessagePort[] = []) {
      for (const f of listeners.message || []) f({ data, ports });
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !cond(); i++) await tick();
}

/** 登记一条流并把"页面那一侧"的端口交出来。 */
function openStream(sw: ReturnType<typeof loadSW>, name = "a.bin") {
  // 用真的 streamURL 产出路径：非 ASCII / 空格必须先百分号编码，否则 new URL 的
  // 规范化会让 pathname 和登记的键对不上（真实页面走的也正是这条路）。
  const path = streamURL("tok" + Math.random().toString(36).slice(2), name);
  const ch = new MessageChannel();
  const page = ch.port1;
  const seen: { type: string }[] = [];
  page.onmessage = (e) => seen.push(e.data as { type: string });
  sw.message(
    { type: "stream-open", path, headers: { "Content-Disposition": contentDisposition(name) } },
    [ch.port2],
  );
  return { path, page, seen, url: ORIGIN + path };
}

describe("sw-template fetch 分派", () => {
  it("已登记的流式路径即使 mode 是 navigate 也由流式分支接住（不被网络优先那条抢走）", async () => {
    // 触发下载的是一个隐藏 iframe，它发出的请求 req.mode **就是** "navigate"。
    // 流式分支排在 navigate 分支之后的话，这里拿到的会是 "from network"——
    // 生产环境里那就是 nginx 的 try_files 兜底出来的 index.html，用户下载到一个网页。
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await bodyIsStream(res)).toBe(true);
  });

  it("未登记的 /__stream__/ 路径由 SW 自己 404，不放行到网络", async () => {
    const sw = loadSW();
    const res = await sw.fetch({ url: ORIGIN + STREAM_ROUTE + "nope/a.bin", mode: "navigate" })!;
    expect(res.status).toBe(404);
  });

  it("同一条流只供一次：第二次 GET 拿到 404 而不是一个已被消费的流", async () => {
    const sw = loadSW();
    const s = openStream(sw);
    expect((await sw.fetch({ url: s.url, mode: "navigate" })!).status).toBe(200);
    expect((await sw.fetch({ url: s.url, mode: "navigate" })!).status).toBe(404);
  });

  it("普通 navigate 仍然走网络优先", async () => {
    const sw = loadSW();
    const res = await sw.fetch({ url: ORIGIN + "/d/abc", mode: "navigate" })!;
    expect(await res.text()).toBe("from network");
  });

  it("非 GET 一律不拦截（share-target 的 POST 除外）", () => {
    const sw = loadSW();
    expect(sw.fetch({ url: ORIGIN + "/api/x", method: "POST" })).toBeNull();
  });

  it("供流时给页面发 stream-serving —— 页面靠它把'导航根本没到'从无声挂死变成报错", async () => {
    const sw = loadSW();
    const s = openStream(sw);
    await sw.fetch({ url: s.url, mode: "navigate" });
    await until(() => s.seen.some((m) => m.type === "stream-serving"));
    expect(s.seen.map((m) => m.type)).toContain("stream-serving");
  });
});

async function bodyIsStream(res: Response): Promise<boolean> {
  return !!res.body && typeof res.body.getReader === "function";
}

describe("sw-template 响应头", () => {
  it("强制 octet-stream + nosniff，不反射页面给的 Content-Type", async () => {
    // /__stream__/ 上流的是完全由对端控制的字节。原样反射消息里的头，等于把
    // "在同源上以任意 Content-Type 托管任意字节" 这个能力交出去。
    const sw = loadSW();
    const path = STREAM_ROUTE + "tok1/evil.bin";
    const ch = new MessageChannel();
    sw.message(
      {
        type: "stream-open",
        path,
        headers: {
          "Content-Type": "text/html",
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "",
        },
      },
      [ch.port2],
    );
    const res = await sw.fetch({ url: ORIGIN + path, mode: "navigate" })!;
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe("attachment"); // "inline" 被换掉
  });

  it("页面给的 Content-Disposition 通过，但必须是 attachment 开头且纯可打印 ASCII", async () => {
    const sw = loadSW();
    const s = openStream(sw, "图 片.svg");
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    expect(res.headers.get("content-disposition")).toBe(contentDisposition("图 片.svg"));
  });

  it("不发 Content-Length —— 字节数对不上会让浏览器丢弃整份已下完的文件", async () => {
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    expect(res.headers.get("content-length")).toBeNull();
  });
});

describe("sw-template 背压 (pull/ack 汇合)", () => {
  it("消费方 pull 之后才 ack：页面先写、消费方后要 → ackDue 汇合", async () => {
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    const reader = res.body!.getReader();
    // start 时 HWM=1 已经拉过一次，先把它耗掉。
    await until(() => s.seen.some((m) => m.type === "ack") || true);
    s.seen.length = 0;

    s.page.postMessage({ type: "chunk", chunk: new Uint8Array([1, 2, 3]) });
    await until(() => s.seen.some((m) => m.type === "ack"));
    expect(s.seen.filter((m) => m.type === "ack").length).toBe(1);

    const r = await reader.read();
    expect(Array.from(r.value as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("消费方停止读取后就不再 ack —— 背压真的会把页面挡住", async () => {
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    res.body!.getReader(); // 拿到 reader 但一次都不 read
    s.seen.length = 0;

    // HWM=1：第一块填满队列后 pull 就不再来，后面的 chunk 都拿不到 ack。
    for (let i = 0; i < 4; i++) s.page.postMessage({ type: "chunk", chunk: new Uint8Array([i]) });
    await tick(); await tick(); await tick();
    expect(s.seen.filter((m) => m.type === "ack").length).toBeLessThan(4);
  });

  it("消费方取消（用户点了取消下载）时通知页面，页面不再往死流里写", async () => {
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    await res.body!.cancel();
    await until(() => s.seen.some((m) => m.type === "cancel"));
    expect(s.seen.map((m) => m.type)).toContain("cancel");
  });
});

describe("sw-template close 回执", () => {
  it("close 收尾后回一个 closed —— 页面靠它区分'流已收尾'和'SW 早就死了'", async () => {
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    const reader = res.body!.getReader();
    s.page.postMessage({ type: "close" });
    await until(() => s.seen.some((m) => m.type === "closed"));
    expect(s.seen.map((m) => m.type)).toContain("closed");
    // 流真的收尾了，浏览器那份下载才会被写完而不是永远吊着。
    expect((await reader.read()).done).toBe(true);
  });

  it("页面发 abort 时流被判废，注册表条目也删掉 —— 否则 reader 永远 pending", async () => {
    // 页面侧任何放弃（ack 停滞超时、controllerchange、并发误用）都会走 filesink.ts
    // 的 fail()，它必须在 port.close() 之前发这条 abort。不发的话 SW 这边什么都不
    // 知道：下面的 reader.read() 永远不 settle，浏览器那份下载吊在一个半截临时文件上。
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    const reader = res.body!.getReader();

    s.page.postMessage({ type: "abort" });
    await expect(reader.read()).rejects.toThrow(/aborted by page/);
  });

  it("供流之前就 abort：注册表条目删掉，之后的 GET 拿到 404 而不是一条死流", async () => {
    // 页面在握手期或 iframe 导航到达之前放弃（open 超时、controllerchange）。
    // 条目留在注册表里的话，那次导航还是会拿到 200 + 一条永远不出数据的流。
    const sw = loadSW();
    const s = openStream(sw);
    s.page.postMessage({ type: "abort" });
    // abort 不带回执，没有可轮询的信号；而这里又只能 fetch 一次（第一次 GET 会把
    // served 置真，之后无论条目在不在都是 404，再轮询就成了假阳性）。所以固定排空
    // 一批宏任务，让 jsdom 把这条 MessagePort 消息投递完。
    for (let i = 0; i < 20; i++) await tick();
    expect((await sw.fetch({ url: s.url, mode: "navigate" })!).status).toBe(404);
  });

  it("enqueue 抛错（流已废）时上报 cancel，绝不静默丢块", async () => {
    // 静默 return 会同时丢掉这一块**和**页面等的 ack：磁盘上少一段，页面永久挂死。
    const sw = loadSW();
    const s = openStream(sw);
    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    await res.body!.cancel(); // 流废掉，之后的 enqueue 必抛
    await until(() => s.seen.some((m) => m.type === "cancel"));
    s.seen.length = 0;

    s.page.postMessage({ type: "chunk", chunk: new Uint8Array([9]) });
    await until(() => s.seen.length > 0);
    expect(s.seen.map((m) => m.type)).toContain("cancel");
    expect(s.seen.map((m) => m.type)).not.toContain("ack");
  });
});

describe("sw-template message 分派", () => {
  it("stream-probe 回 stream-probe-ok（页面靠它认出旧版 SW）", async () => {
    const sw = loadSW();
    const ch = new MessageChannel();
    const seen: { type: string }[] = [];
    ch.port1.onmessage = (e) => seen.push(e.data as { type: string });
    sw.message({ type: "stream-probe" }, [ch.port2]);
    await until(() => seen.length > 0);
    expect(seen[0].type).toBe("stream-probe-ok");
  });

  it("登记路径必须落在 STREAM_ROUTE 下，否则不登记", async () => {
    const sw = loadSW();
    const ch = new MessageChannel();
    sw.message({ type: "stream-open", path: "/d/abc", headers: {} }, [ch.port2]);
    const res = await sw.fetch({ url: ORIGIN + "/d/abc", mode: "navigate" })!;
    expect(await res.text()).toBe("from network"); // 没被流式分支接住
  });

  it("留着给 vite-plugin-pwa 替换的 __STREAM_ROUTE__ 占位符", () => {
    const src = readFileSync(resolve(process.cwd(), "src/sw-template.js"), "utf8");
    expect(src).toContain("__STREAM_ROUTE__");
  });
});

describe("sw-template 运行时缓存回填", () => {
  it("precache 之外的带 hash 资源，未命中取网络后写回缓存", async () => {
    // 语言包（9 个，约 460KB）故意不进 precache——见 vite-plugin-pwa.ts。没有这个
    // 回填，它们就永远只走网络，离线时整个应用起不来，那条排除就成了纯损失。
    const sw = loadSW();
    const url = ORIGIN + "/assets/en-CLd7DiBC.js";
    const res = await sw.fetch({ url })!;
    expect(await res.text()).toBe("from network"); // 响应体仍原样交给页面
    await until(() => sw.put.length > 0);
    expect(sw.put).toEqual([{ url, body: "from network" }]);
  });

  it("不缓存无 hash 的动态路径（/api 之类没人负责失效）", async () => {
    const sw = loadSW();
    await sw.fetch({ url: ORIGIN + "/api/me/usage" })!;
    await tick();
    expect(sw.put).toEqual([]);
  });
});

describe("sw-template 换版时机", () => {
  it("install 不自动 skipWaiting —— 顶掉旧 SW 会杀掉它内存里在途的流式下载", async () => {
    const sw = loadSW();
    await sw.install();
    expect(sw.skipWaitingCalls.length).toBe(0);
  });

  it("页面确认空闲后发 skip-waiting 才换版", async () => {
    const sw = loadSW();
    await sw.install();
    sw.message({ type: "skip-waiting" });
    expect(sw.skipWaitingCalls.length).toBe(1);
  });
});
