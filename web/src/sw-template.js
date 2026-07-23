// Relayium service worker — hand-written, no Workbox. The build plugin
// (vite-plugin-pwa.ts) string-replaces the __PLACEHOLDERS__ with the real
// precache list, a content-derived version, and the share-target route, then
// emits the result as /sw.js. This file is never bundled or imported directly.
/* eslint-disable */
const VERSION = "__VERSION__";
const CACHE = "relayium-shell-" + VERSION;
const PRECACHE = __PRECACHE__; // JSON array of shell URLs
const SHARE_ROUTE = "__SHARE_ROUTE__"; // e.g. "/share-target"
const SHARE_CACHE = "relayium-share";
const STREAM_ROUTE = "__STREAM_ROUTE__"; // e.g. "/__stream__/" — see lib/sw-stream.ts

/**
 * 流式下载注册表：pathname → entry。页面在用户手势里先 postMessage 登记一条流
 * （连带一个 MessagePort），再让隐藏 iframe 去 GET 同一个 pathname；下面的 fetch
 * 拦截把这条流当作响应体交出去，浏览器边收边写盘，内存占用恒定。
 *
 * 键是**完整 pathname** 而不是 token：页面用 sw-stream.ts 的 streamURL 产出路径并
 * 原样登记，SW 只做精确匹配。精确匹配比在这里重新解析一遍路径更严格，也省掉了把
 * TOKEN_RE 之类的解析逻辑复制进这个文件的必要（本文件不参与打包，import 不了）。
 *
 * 注册表只活在 SW 的全局作用域里，SW 被浏览器回收（约 30s 空闲）就整个蒸发。
 * 页面侧靠 stream-ping 保活；细节见 filesink.ts 的 openSwStream。
 */
const streams = new Map();

// 装完**不自动** skipWaiting。旧 SW 一被顶掉，它全局作用域里的 streams 注册表就
// 随之消失，正在落盘的流式下载会在下一个 chunk 上永远等不到 ack——发版恰好撞上
// 一次大文件下载就是一次静默的下载失败。改成由页面在确认自己没有在途流式下载时
// 发 skip-waiting 来放行（见 share-target.ts 的 activateWhenIdle）；页面全关掉时
// 浏览器也会自然激活等待中的版本。
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

/**
 * 分享进来的文件在缓存里能待多久。
 *
 * 这些是**明文文件**：Web Share Target 把用户选的文件交给 SW，SW 先存进 Cache API，
 * 再把浏览器导航到应用去取。正常路径上应用一打开就取走并删掉；但用户如果分享完就
 * 划掉了通知、再也没打开过应用，这些文件就**无限期**留在缓存里——一份用户以为只是
 * "分享了一下"的文件，实际上落在了磁盘上，而且没有任何界面显示它的存在。
 *
 * 一天足够覆盖"分享完隔一会儿再打开"的真实用法，又不至于让它变成一个影子文件夹。
 */
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

/** 删掉超过 SHARE_TTL_MS 的分享条目。时间戳就在 token 前缀里（36 进制的毫秒）。 */
async function sweepStaleShares(cache) {
  try {
    const now = Date.now();
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/__shared__/")) continue; // 不是分享条目，不归这里管
      const m = /^\/__shared__\/([0-9a-z]+)-/.exec(path);
      const at = m ? parseInt(m[1], 36) : NaN;
      // 解不出时间戳的**也删**：那是坏数据或另一套命名留下的，没人会来取，
      // 留着就是一份永远不过期的明文文件。
      if (!Number.isFinite(at) || now - at > SHARE_TTL_MS) await cache.delete(req);
    }
  } catch {
    /* 缓存不可用——没什么可清的 */
  }
}

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("relayium-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => caches.open(SHARE_CACHE).then(sweepStaleShares).catch(() => {}))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Inbound Web Share Target: stash the shared files, hand off to the app.
  if (req.method === "POST" && url.pathname === SHARE_ROUTE) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== "GET") return; // never intercept other writes

  // 流式下载。**必须排在下面的 navigate 分支之前**：这个请求由隐藏 iframe 发出，
  // req.mode 就是 "navigate"，放到后面会被那条「网络优先」抢走送去网络，落到
  // nginx 的 try_files 兜底成 index.html——用户下载到一个网页。
  // sw-template.test.ts 里有一条用例真的用 mode:"navigate" 打一条已登记的流式
  // 路径，顺序错了它就红。
  //
  // 没登记过的 /__stream__/ 一律 404 而不是放行：同样是为了不让它漏到 nginx。
  // 注意 Go 的 spa.go 对带扩展名的未知路径返真 404，所以这个故障只在生产（nginx）
  // 才复现，本地 dev 服务器上看不出来。
  if (url.origin === self.location.origin && url.pathname.startsWith(STREAM_ROUTE)) {
    const entry = streams.get(url.pathname);
    if (entry && !entry.served) {
      entry.served = true; // 一次性：同一个 URL 再来一次拿不到已被消费的流
      // 告诉页面「导航真的到了」。页面在此之前一直挂着一个超时：万一 iframe 的
      // 请求根本没到（被拦、被 SW 换版顶掉），页面会在第二个 write 上永远等 ack，
      // 有这个信号才能把无声的挂死变成一个报错。
      entry.port.postMessage({ type: "stream-serving" });
      e.respondWith(new Response(entry.body, { headers: entry.headers }));
    } else {
      e.respondWith(new Response("stream not found", { status: 404 }));
    }
    return;
  }

  if (req.mode === "navigate") {
    // Network-first: fresh HTML when online, the cached shell when offline so
    // the app still opens instantly (signalling/transfer then need the network).
    e.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }

  if (url.origin === self.location.origin) {
    // Cache-first for our own hashed, immutable assets, and fill the cache on a
    // miss. Without the fill, anything outside the precache list (the language
    // chunks, most notably) would go to the network forever and the app would
    // break the moment it went offline — the precache list is deliberately
    // narrow, so the runtime fill is what makes that narrowing safe.
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => fill(req, res))),
    );
  }
});

/**
 * 把一条网络响应存进 shell cache 并原样交还。
 *
 * 只存 200 且**带 hash 的**同源资源：hash 名是不可变的，存下来永远不会变陈旧；
 * 反过来，把 /api/… 之类的动态响应或 opaque/错误响应存进这个按版本清理的 cache，
 * 就会得到一份没人负责失效的影子副本。res.clone() 必须在返回前做——响应体只能读
 * 一次，先给了浏览器就没得存了。
 */
function fill(req, res) {
  const cacheable =
    res && res.ok && res.type !== "opaque" && res.type !== "opaqueredirect";
  if (cacheable && /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(new URL(req.url).pathname)) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

// 页面 → SW 的控制通道。只认两种消息，其余一律忽略（同源页面才能发到这里，
// 但保持严格没有坏处）。
self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "stream-probe") {
    // 能力探测。页面用它确认「正在控制我的这个 SW 认识流式路由」——光看
    // navigator.serviceWorker.controller 非空不够：部署换版期间控制页面的可能
    // 还是一个不认识 STREAM_ROUTE 的旧 SW，那种情况下下载会漏到 nginx。
    if (e.ports[0]) e.ports[0].postMessage({ type: "stream-probe-ok" });
    return;
  }
  if (d.type === "skip-waiting") {
    // 页面确认此刻没有在途流式下载，放行换版。见 install 里不自动 skipWaiting 的注释。
    self.skipWaiting();
    return;
  }
  if (d.type === "stream-ping") return; // 保活空包：收到即刷新 SW 的空闲计时器
  if (d.type === "stream-open") openStream(d, e.ports[0]);
});

/**
 * 登记一条流。流在这里就建好（而不是等 fetch 到来），这样页面可以立刻开始写，
 * 不用和 iframe 的导航赛跑。
 *
 * 背压是 credit-1 的 ack 窗口：页面每写一块就等一个 ack，SW 只在消费方真的要下
 * 一块（ReadableStream 的 pull 被调用）时才回 ack。默认队列策略 HWM=1，所以第二
 * 块之后 pull 就不再来，页面自然被挡住——写盘速度成了上游的节流阀。
 */
function openStream(d, port) {
  if (!port || typeof d.path !== "string" || !d.path.startsWith(STREAM_ROUTE)) return;
  const entry = {
    port,
    headers: streamHeaders(d.headers),
    body: null,
    ctrl: null,
    served: false,
    wantsChunk: false, // 消费方已经要过下一块，但那时页面还没写
    ackDue: false,     // 页面已经写了一块，但那时消费方还没要
  };
  const ack = () => port.postMessage({ type: "ack" });
  entry.body = new ReadableStream({
    start(c) { entry.ctrl = c; },
    pull() {
      if (entry.ackDue) { entry.ackDue = false; ack(); }
      else entry.wantsChunk = true;
    },
    cancel() {
      // 用户在浏览器里取消了下载。告诉页面别再往死流里写。
      streams.delete(d.path);
      port.postMessage({ type: "cancel" });
    },
  });
  port.onmessage = (ev) => {
    const m = ev.data;
    if (!m || !entry.ctrl) return;
    if (m.type === "chunk") {
      try {
        entry.ctrl.enqueue(m.chunk);
      } catch {
        // 流已关/已废（消费方消失、浏览器掐了这次下载）。**绝不能静默 return**：
        // 那样这一块就丢了，而且页面等的 ack 永远不来——落盘一个缺了一段的文件，
        // 或者干脆永远挂住。当作取消上报，页面会让 write() 报错。
        streams.delete(d.path);
        port.postMessage({ type: "cancel" });
        return;
      }
      if (entry.wantsChunk) { entry.wantsChunk = false; ack(); }
      else entry.ackDue = true;
    } else if (m.type === "close") {
      streams.delete(d.path);
      let ok = true;
      try { entry.ctrl.close(); } catch { ok = false; }
      // 回执。页面的 close() 必须等到这一条才 resolve：没有回执就没法区分
      // 「流已收尾」和「SW 早就被回收、close 发进了虚空」，后者会让浏览器拿到
      // 一份永不收尾的截断文件，而页面照样把界面置成「完成」。
      port.postMessage({ type: ok ? "closed" : "cancel" });
    } else if (m.type === "abort") {
      streams.delete(d.path);
      try { entry.ctrl.error(new Error("aborted by page")); } catch {}
    }
  };
  streams.set(d.path, entry);
  port.postMessage({ type: "stream-ready" });
}

/**
 * 响应头由 SW 自己定，**不反射页面给的内容**。
 *
 * /__stream__/ 是同源 URL 上一段完全由对端控制的字节流（实时模式下发送端连文件名
 * 都是任意的，见 zip.ts 的注释）。把消息里的 headers 原样交给 Response，就等于把
 * 「在 relayium.com 上以任意 Content-Type 托管任意字节」这个能力交出去了——今天
 * 只靠页面自己硬编码 octet-stream 兜着，而消息内容不是页面的专有物。
 *
 * 只有 Content-Disposition 从消息里取（文件名必须由页面定），且强制 attachment 前缀、
 * 只收可打印 ASCII —— 非 ASCII 会让 Response 的 header 校验直接抛，把下载打断。
 */
function streamHeaders(given) {
  const raw = given && typeof given === "object" ? given["Content-Disposition"] : "";
  const cd = typeof raw === "string" && /^attachment(;[\x20-\x7e]*)?$/.test(raw) ? raw : "attachment";
  return {
    "Content-Type": "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Disposition": cd,
  };
}

// Read the shared files out of the multipart POST, park them in a dedicated
// cache keyed by a one-off token, then redirect the launch to the app, which
// drains them back into File objects. A cache (not postMessage) is used because
// at share time the app may not have an open client yet.
async function handleShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f) => f instanceof File);
    const token = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const cache = await caches.open(SHARE_CACHE);
    await sweepStaleShares(cache); // 顺手清掉过期的（见 SHARE_TTL_MS）
    const base = "/__shared__/" + token + "/";
    await cache.put(base + "count", new Response(String(files.length)));
    for (let i = 0; i < files.length; i++) {
      await cache.put(
        base + i,
        new Response(files[i], {
          headers: {
            "content-type": files[i].type || "application/octet-stream",
            // Header values must be ASCII; percent-encode to survive non-Latin names.
            "x-name": encodeURIComponent(files[i].name),
          },
        }),
      );
    }
    return Response.redirect("/?share-target=" + token, 303);
  } catch {
    return Response.redirect("/", 303);
  }
}
