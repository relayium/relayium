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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  // self.skipWaiting() 返回 promise，处理器要用 event.waitUntil 包住它——真 SW 就是
  // 这样，桩返回 undefined 的话那一步永远测不到。
  let skipWaitingResolve: () => void = () => {};
  const skipWaitingDone = new Promise<void>((r) => (skipWaitingResolve = r));
  // 换版协调（retireIfIdle）要读 self.registration.waiting 并给它发 skip-waiting，
  // 所以 registration 必须是真的可驱动的，不能是空实现。
  type PortLike = { postMessage(m: unknown): void; close?: () => void };
  const waitingPosts: { msg: { type?: string }; port: PortLike | null }[] = [];
  const registration: {
    waiting: { postMessage(m: { type?: string }, transfer?: PortLike[]): void } | null;
  } = { waiting: null };
  const swSelf = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] ||= []).push(f),
    skipWaiting: () => {
      skipWaitingCalls.push(1);
      return skipWaitingDone;
    },
    clients: { claim: async () => {} },
    registration,
  };
  // caches / fetch 大多只是为了让脚本能加载；缓存写入这一项是真的被断言的，
  // 所以 put 记账而不是空实现。
  const put: { url: string; body: string }[] = [];
  // 分享缓存是真的会被枚举和删除的（sweepStaleShares），所以这个桩不能只有 put。
  const shareEntries = new Map<string, string>();
  const shareCache = {
    addAll: async () => {},
    put: async (req: { url: string }, res: Response) => void put.push({ url: req.url, body: await res.text() }),
    keys: async () => [...shareEntries.keys()].map((url) => ({ url })),
    delete: async (req: { url: string }) => shareEntries.delete(req.url),
  };
  const cachesStub = {
    open: async () => shareCache,
    keys: async () => [] as string[],
    delete: async () => true,
    match: async () => undefined,
  };
  const waitUntils: Promise<unknown>[] = [];
  const fetchStub = async () => new Response("from network");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("self", "caches", "fetch", src)(swSelf, cachesStub, fetchStub);

  return {
    put,
    shareEntries,
    skipWaitingCalls,
    /** 这个 SW 递给等待中版本的消息，连同它一起转移过去的回执端口。 */
    waitingPosts,
    /** 让 self.skipWaiting() 返回的那个 promise 兑现（真 SW 里就是激活落地）。 */
    finishSkipWaiting: skipWaitingResolve,
    /**
     * 装上/摘掉一个 waiting 版本。
     *   present —— 本版或更新的构建：收到 skip-waiting 会通过转移来的端口回执
     *   silent  —— 回滚部署留下的更旧构建：认识 skip-waiting，但不回执
     *   absent  —— 没有等待中的版本
     *   throws  —— 递交时抛（worker 已经没了）
     */
    setWaiting(mode: "present" | "silent" | "absent" | "throws" = "present") {
      if (mode === "absent") { registration.waiting = null; return; }
      if (mode === "throws") {
        registration.waiting = { postMessage() { throw new Error("worker gone"); } };
        return;
      }
      registration.waiting = {
        postMessage: (m, transfer) => {
          const port = transfer?.[0] ?? null;
          waitingPosts.push({ msg: m, port });
          if (mode === "present" && port) port.postMessage({ type: "skip-waiting-ack" });
        },
      };
    },
    /** 触发 activate（并 await 它 waitUntil 的那个 promise）。 */
    async activate() {
      let done: Promise<unknown> = Promise.resolve();
      for (const f of listeners.activate || []) f({ waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
    },
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
    /** 这个 SW 交给 message 事件 waitUntil 的那些 promise。真 ExtendableMessageEvent
     *  有 waitUntil，没有它浏览器可以在处理器返回后立刻把 SW 掐掉。 */
    waitUntils,
    /** 发一个 message 事件（带可选的 MessagePort）。origin 省略时是 undefined，
     *  和多数实现给同源客户端的行为一致（有的给空串，有的给真实 origin）。 */
    message(data: unknown, ports: unknown[] = [], origin?: string) {
      for (const f of listeners.message || []) {
        f({ data, ports, origin, waitUntil: (p: Promise<unknown>) => void waitUntils.push(p) });
      }
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

  // 这条通道能触发换版，不该只靠「反正只有同源页面发得进来」这个默认。
  // origin 为空/缺省时放行（部分实现对同源客户端就是空串）。
  it("非同源的 message 一律不理（retire-if-idle / skip-waiting 也不例外）", async () => {
    const sw = loadSW();
    sw.setWaiting();
    const ch = new MessageChannel();
    const seen: unknown[] = [];
    ch.port1.onmessage = (e) => seen.push(e.data);

    sw.message({ type: "retire-if-idle" }, [ch.port2], "https://evil.example");
    sw.message({ type: "skip-waiting" }, [], "https://evil.example");
    await tick();

    expect(seen).toEqual([]);
    expect(handedOver(sw)).toEqual([]);
    expect(sw.skipWaitingCalls.length).toBe(0);
  });

  it("显式同源的 message 正常处理", async () => {
    const sw = loadSW();
    sw.message({ type: "skip-waiting" }, [], ORIGIN);
    expect(sw.skipWaitingCalls.length).toBe(1);
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

/** 递给等待中版本的消息（去掉随行的端口，MessagePort 进不了 toEqual）。 */
const handedOver = (sw: ReturnType<typeof loadSW>) => sw.waitingPosts.map((p) => p.msg);

// 换版协调必须由**旧的 active SW** 自己做：只有它看得见全局 streams 表，也只有在
// 它这一个事件任务里，「查表 → 置闩 → 递交」之间才没有别的标签页能插进来的空窗。
describe("sw-template 退休协调（retire-if-idle）", () => {
  /** 发一次 retire-if-idle，返回收到的回执类型。 */
  async function retire(sw: ReturnType<typeof loadSW>, origin?: string) {
    const ch = new MessageChannel();
    const seen: { type: string }[] = [];
    ch.port1.onmessage = (e) => seen.push(e.data as { type: string });
    sw.message({ type: "retire-if-idle" }, [ch.port2], origin);
    await until(() => seen.length > 0);
    return seen[0]?.type;
  }

  it("空闲时预约退休并把 skip-waiting 发给等待中的版本", async () => {
    const sw = loadSW();
    sw.setWaiting();

    expect(await retire(sw)).toBe("retire-ok");
    expect(handedOver(sw)).toEqual([{ type: "skip-waiting" }]);
  });

  it("有流在途时拒绝退休，也绝不放行", async () => {
    const sw = loadSW();
    sw.setWaiting();
    openStream(sw); // 可能是**另一个标签页**开的：本 SW 的表是唯一一份全局真相

    expect(await retire(sw)).toBe("retire-busy");
    expect(handedOver(sw)).toEqual([]);
  });

  it("流收尾之后又肯退休了", async () => {
    const sw = loadSW();
    sw.setWaiting();
    const s = openStream(sw);
    await sw.fetch({ url: s.url, mode: "navigate" })!;
    expect(await retire(sw)).toBe("retire-busy");

    s.page.postMessage({ type: "close" });
    await until(() => s.seen.some((m) => m.type === "closed" || m.type === "cancel"));

    expect(await retire(sw)).toBe("retire-ok");
    expect(handedOver(sw)).toEqual([{ type: "skip-waiting" }]);
  });

  // 这一条就是 BLOCKER A 说的那次数据丢失：查询和放行分成两步时，别的标签页会在
  // 中间那一瞬登记一条注定被掐死的流。预约之后 openStream 必须当场拒。
  it("预约之后新来的 stream-open 被立刻明确拒掉，而不是开出一条注定断掉的流", async () => {
    const sw = loadSW();
    sw.setWaiting();
    expect(await retire(sw)).toBe("retire-ok");

    // 「另一个标签页」在放行之后才来开流。
    const late = openStream(sw, "late.bin");
    await until(() => late.seen.length > 0);

    expect(late.seen.map((m) => m.type)).toEqual(["stream-refused"]);
    expect(late.seen.map((m) => m.type)).not.toContain("stream-ready");
    // 而且它确实没被登记：真去取那个路径只会拿到 404，不会拿到半条流。
    expect((await sw.fetch({ url: late.url, mode: "navigate" })!).status).toBe(404);
  });

  it("预约之前开的流不受影响，照常供流", async () => {
    const sw = loadSW();
    sw.setWaiting();
    const s = openStream(sw);
    await until(() => s.seen.some((m) => m.type === "stream-ready"));
    // 有流在途，所以这次退休本来就会被拒——先确认它没被预约。
    expect(await retire(sw)).toBe("retire-busy");

    const res = await sw.fetch({ url: s.url, mode: "navigate" })!;
    expect(res.status).toBe(200);
  });

  // 没有 waiting 版本却预约，等于把这个 SW 的流式下载永久关掉，而换版一次也不会发生。
  it("没有等待中的版本时什么都不预约", async () => {
    const sw = loadSW();
    sw.setWaiting("absent");

    expect(await retire(sw)).toBe("retire-none");

    // 预约没生效：后面的流照常开得出来。
    const s = openStream(sw);
    await until(() => s.seen.length > 0);
    expect(s.seen.map((m) => m.type)).toContain("stream-ready");
  });

  it("放行时抛异常就解除预约并如实回报", async () => {
    const sw = loadSW();
    sw.setWaiting("throws");

    expect(await retire(sw)).toBe("retire-none");

    // 关键是没有留下一个「预约了却没人接班」的 SW：流式下载必须还能用。
    const s = openStream(sw);
    await until(() => s.seen.length > 0);
    expect(s.seen.map((m) => m.type)).toContain("stream-ready");
  });

  // 多标签页会各发各的。重复请求是幂等的：状态已经是「预约中」，再放行一次无害，
  // 每一个请求方都必须拿到回执，否则它会一直等到超时、误以为对面是旧 SW。
  it("重复请求都拿到回执，放行是幂等的", async () => {
    const sw = loadSW();
    sw.setWaiting();

    expect(await retire(sw)).toBe("retire-ok");
    expect(await retire(sw)).toBe("retire-ok");

    expect(handedOver(sw)).toEqual([{ type: "skip-waiting" }, { type: "skip-waiting" }]);
  });

  it("非同源的退休请求既不回执也不放行", async () => {
    const sw = loadSW();
    sw.setWaiting();
    const ch = new MessageChannel();
    const seen: unknown[] = [];
    ch.port1.onmessage = (e) => seen.push(e.data);

    sw.message({ type: "retire-if-idle" }, [ch.port2], "https://evil.example");
    await tick();

    expect(seen).toEqual([]);
    expect(handedOver(sw)).toEqual([]);
  });

  // 等待中的那一份收到递交时该做的两件事。真 SW 里这段代码和上面是同一个文件——
  // 换版之后角色互换，所以这里驱动的就是它未来会跑的那条路径。
  it("收到 skip-waiting 的一方会回执，并用 waitUntil 包住 skipWaiting()", async () => {
    const sw = loadSW();
    const ch = new MessageChannel();
    const seen: { type: string }[] = [];
    ch.port1.onmessage = (e) => seen.push(e.data as { type: string });

    sw.message({ type: "skip-waiting" }, [ch.port2]);

    await until(() => seen.length > 0);
    expect(seen.map((m) => m.type)).toEqual(["skip-waiting-ack"]);
    expect(sw.skipWaitingCalls.length).toBe(1);

    // waitUntil 拿到的必须是 skipWaiting() 那个 promise：没包住的话浏览器可以在
    // 处理器返回后就判本 worker 空闲，把还没落地的激活一起丢掉。
    expect(sw.waitUntils.length).toBe(1);
    let settled = false;
    void sw.waitUntils[0].then(() => (settled = true));
    await tick();
    expect(settled).toBe(false); // 激活还没落地

    sw.finishSkipWaiting();
    await tick();
    expect(settled).toBe(true);
  });

  it("兼容路径那种不带端口的 skip-waiting 照样激活", async () => {
    const sw = loadSW();
    sw.message({ type: "skip-waiting" }); // 页面直接发的，没有回执端口
    expect(sw.skipWaitingCalls.length).toBe(1);
    expect(sw.waitUntils.length).toBe(1);
  });
});

// BLOCKER C：retiring 是**单向闩**，本实例内没有任何计时器能把它翻回去。
//
// 这一组用同步投递的 MessageChannel 替身 + 假计时器，才能同时看见 SW 内部那条回执
// 通道的开闭和计时器数量——jsdom 真的 MessagePort 在假计时器下根本不投递。
describe("sw-template 退休闩与资源回收", () => {
  /** SW 内部（以及本组用例自己）建的所有通道，用来断言端口有没有被关掉。 */
  let channels: { port1: { closed: boolean }; port2: { closed: boolean } }[] = [];

  function installSyncChannels() {
    class FakePort {
      other: FakePort | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      closed = false;
      postMessage(data: unknown) {
        if (this.closed || this.other?.closed) return;
        this.other?.onmessage?.({ data });
      }
      close() { this.closed = true; }
    }
    class FakeChannel {
      port1 = new FakePort();
      port2 = new FakePort();
      constructor() {
        this.port1.other = this.port2;
        this.port2.other = this.port1;
        channels.push(this);
      }
    }
    vi.stubGlobal("MessageChannel", FakeChannel);
  }

  /** 同步版的 retire：替身立刻投递，不需要等宏任务。 */
  function retireSync(sw: ReturnType<typeof loadSW>) {
    const before = channels.length;
    const ch = new MessageChannel();
    const seen: { type: string }[] = [];
    (ch.port1 as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage = (e) =>
      seen.push(e.data as { type: string });
    sw.message({ type: "retire-if-idle" }, [ch.port2]);
    // 请求自己那条通道排在 before，SW 为递交新建的那条（如果有）排在它后面。
    return { verdict: seen[0]?.type, handoverChannel: channels[before + 1] };
  }

  beforeEach(() => {
    channels = [];
    vi.useFakeTimers();
    installSyncChannels();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("回执到手就清掉计时器、关掉端口", () => {
    const sw = loadSW();
    sw.setWaiting("present"); // 本版或更新的构建，会回执

    const { verdict, handoverChannel } = retireSync(sw);

    expect(verdict).toBe("retire-ok");
    expect(handoverChannel.port1.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // 回执路径也清了那个 5s 的表
    expect(sw.waitUntils.length).toBe(1);
  });

  it("对面不回执时，超时那条路一样清干净", async () => {
    const sw = loadSW();
    sw.setWaiting("silent"); // 回滚部署留下的更旧构建：认识 skip-waiting，不回执

    const { verdict, handoverChannel } = retireSync(sw);
    expect(verdict).toBe("retire-ok");
    expect(handoverChannel.port1.closed).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(handoverChannel.port1.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // 页面每 15s 就再请求一次；久等的换版能攒出几十次。
  it("重复请求不累积计时器和端口", () => {
    const sw = loadSW();
    sw.setWaiting("present");

    for (let i = 0; i < 20; i++) retireSync(sw);

    expect(handedOver(sw).length).toBe(20); // 每次都重发了递交
    expect(vi.getTimerCount()).toBe(0);
    expect(channels.filter((c) => c.port1.closed).length).toBe(20); // SW 那 20 条全关了
  });

  it("递交抛异常时立刻收干净，并且把闩放回去", () => {
    const sw = loadSW();
    sw.setWaiting("throws");

    const { verdict } = retireSync(sw);

    expect(verdict).toBe("retire-none");
    expect(vi.getTimerCount()).toBe(0); // 没留下 5s 的空等
    // 闩确实放回去了：什么都没递出去，就不会有任何激活来掐这条流。
    const s = openStream(sw);
    expect(s.seen.map((m) => m.type)).toContain("stream-ready");
  });

  // 上一版用一个 15s 宽限计时器兜底解除，这是错的：递出去的 skipWaiting 随时可能
  // 生效，没有任何本地状态能证明它不会。
  it("交接之后没有任何计时器能把闩翻回去", async () => {
    const sw = loadSW();
    sw.setWaiting("present");
    expect(retireSync(sw).verdict).toBe("retire-ok");

    await vi.advanceTimersByTimeAsync(10 * 60_000); // 十分钟，远超任何宽限期

    const s = openStream(sw, "late.bin");
    expect(s.seen.map((m) => m.type)).toEqual(["stream-refused"]);
  });

  // 先排的计时器后触发，正是上一版会漏的顺序：早的那个会把晚置的闩解掉。
  it("早排的计时器不会解掉后来那次请求置的闩", async () => {
    const sw = loadSW();
    sw.setWaiting("silent"); // 不回执，所以两次请求各留一个真的会触发的计时器

    expect(retireSync(sw).verdict).toBe("retire-ok");
    await vi.advanceTimersByTimeAsync(4_000); // 第一个还没到期
    expect(retireSync(sw).verdict).toBe("retire-ok"); // 第二次请求，又排一个
    await vi.advanceTimersByTimeAsync(2_000); // 第一个到期了，第二个还没

    const s = openStream(sw, "between.bin");
    expect(s.seen.map((m) => m.type)).toEqual(["stream-refused"]);

    await vi.advanceTimersByTimeAsync(10_000); // 第二个也到期
    const s2 = openStream(sw, "after.bin");
    expect(s2.seen.map((m) => m.type)).toEqual(["stream-refused"]);
    expect(vi.getTimerCount()).toBe(0); // 两个都清干净了
  });

  it("没有 MessageChannel 时不带回执照样递交", () => {
    const sw = loadSW();
    sw.setWaiting("present");
    vi.stubGlobal("MessageChannel", class { constructor() { throw new Error("nope"); } });

    const ch = { postMessage: () => {}, close: () => {} };
    sw.message({ type: "retire-if-idle" }, [ch]);

    expect(handedOver(sw)).toEqual([{ type: "skip-waiting" }]);
    expect(sw.waitingPosts[0].port).toBeNull(); // 没有端口可带
  });
});

// Web Share Target 把用户选的文件交给 SW，SW 先存进 Cache API 再让应用来取。
// 正常路径上应用一开就取走并删掉；但用户分享完直接划掉通知、再没打开过应用的话，
// 这些**明文文件**就无限期留在磁盘上，而且界面上没有任何痕迹显示它们存在。
describe("sw-template 分享缓存的过期清理", () => {
  const stamp = (msAgo: number) => (Date.now() - msAgo).toString(36);

  it("activate 时清掉超过一天的分享条目，保留新的", async () => {
    const sw = loadSW();
    const old1 = `https://relayium.test/__shared__/${stamp(25 * 3600_000)}-abc/0`;
    const old2 = `https://relayium.test/__shared__/${stamp(25 * 3600_000)}-abc/count`;
    const fresh = `https://relayium.test/__shared__/${stamp(60_000)}-xyz/0`;
    sw.shareEntries.set(old1, "x");
    sw.shareEntries.set(old2, "1");
    sw.shareEntries.set(fresh, "y");

    await sw.activate();

    expect([...sw.shareEntries.keys()], "过期条目没被清掉").toEqual([fresh]);
  });

  it("时间戳解不出来的条目也清掉（坏数据不该长期留着）", async () => {
    const sw = loadSW();
    const junk = "https://relayium.test/__shared__/!!!-abc/0";
    sw.shareEntries.set(junk, "x");
    await sw.activate();
    expect(sw.shareEntries.size).toBe(0);
  });

  it("不碰分享路径以外的东西", async () => {
    const sw = loadSW();
    const other = "https://relayium.test/assets/index-abcdefgh.js";
    sw.shareEntries.set(other, "x");
    await sw.activate();
    expect([...sw.shareEntries.keys()]).toEqual([other]);
  });
});
