// Relayium service worker — hand-written, no Workbox. The build plugin
// (vite-plugin-pwa.ts) string-replaces the __PLACEHOLDERS__ with the real
// precache list, a content-derived version, and the share-target route, then
// emits the result as /sw.js. This file is never bundled or imported directly.
/* eslint-disable */
const VERSION = "__VERSION__";
const SHELL_PREFIX = "relayium-shell-";
const CACHE = SHELL_PREFIX + VERSION;
const PRECACHE = __PRECACHE__; // JSON array of shell URLs
const SHARE_ROUTE = "__SHARE_ROUTE__"; // e.g. "/share-target"
const SHARE_CACHE = "relayium-share";
const STREAM_ROUTE = "__STREAM_ROUTE__"; // e.g. "/__stream__/" — see lib/sw-stream.ts

/**
 * 除当前这一代之外，还保留几代旧 shell 缓存。
 *
 * 为什么不是 0（activate 时全删，也就是这一版之前的行为）：发版**不会**动一张已经
 * 开着的页面，它跑的还是加载时那份 JS。那份 JS 里的路由是懒加载的——点「价格」才去
 * 取 PricingPage-<旧 hash>.js。新版本一 activate 就把旧 shell 删光，这些旧 hash 在
 * 服务器上也早已不存在：真机复现过，标题变了、路由内容一片空白。而更新提示条的全部
 * 承诺就是「你可以先把手上的事做完再刷新」——旧壳被删掉，这句承诺就是假的。
 *
 * 为什么是 2 而不是无限：precache 现在把九个语言目录也算进去，一代约 1.43 MiB，
 * 三代合计约 4.3 MiB（原始字节）。两代旧壳刚好覆盖 A→B→C 这种连着发版/紧急修复的
 * 节奏，再多就是在为无限期的陈旧页面付存储，那不是这条闸门要解决的问题。
 */
const KEEP_OLD_SHELLS = 2;

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

/**
 * 已交接：本 SW 已经把 skip-waiting 成功递给了等待中的新版本，随时可能被顶掉。
 *
 * 换版的协调**必须由这个 SW 自己做**，因为只有它看得见上面这张全局 streams 表——
 * 页面手里那个计数只覆盖它自己那个 Window。页面「先查一次、再自己去 post
 * skip-waiting」的两步做法有一个真实的空窗：两步之间别的标签页登记一条流，那条流
 * 就会随旧 SW 一起被掐死。retireIfIdle 把「查表 + 置位 + 递交」放进同一个事件任务，
 * 中间不 await，别的任务插不进来。
 *
 * 置位之后 openStream 一律立刻拒（见那里）：这时候开出来的流注定活不过换版。
 *
 * **这是一个单向闩，本实例内永不解除。** 之前用一个宽限计时器兜底解除，那是错的：
 * 递出去的 skipWaiting 随时可能生效，没有任何本地状态能证明它不会；计时器一解除，
 * 就又能收下一条注定被掐死的流。而且重复请求会各自排一个没人管的计时器，早排的那个
 * 会把晚置位的闩解掉——顺序一乱就直接漏。
 *
 * 那怎么恢复？靠 SW 自己的生命周期，不靠计时器：
 *   - 交接成功且激活落地 → 本实例被终止，闩随之消失；
 *   - 激活迟迟不落地 → 页面每 15s 再请求一次，retireIfIdle 会**重发**一遍递交
 *     （幂等），等待中的版本被唤醒后照样激活；
 *   - 等待中的版本被丢弃（更新被取代等）→ 页面那边 reg.waiting 也变空，轮询停止，
 *     本 SW 随即空闲（约 30s）被浏览器回收，下一个实例是干净的 false。
 * 也就是说：闩为真的整段时间里，交接确实还悬着——拒收新流正是那时候该做的事。
 */
let retiring = false;

/**
 * 等待中的版本回执 skip-waiting-ack 的上限。
 *
 * 只用来给 event.waitUntil 一个有界的 promise，**不参与任何状态解除**。没有它，
 * 浏览器可能在消息处理器返回后立刻把本 SW 掐掉，刚 post 出去的递交就被丢在半路；
 * 有它，本 SW 至少活到对面收下为止。收不到回执也不代表没交接——回滚部署时等待中的
 * 那份可能是**更旧**的构建，它认识 skip-waiting 但不认识这个回执端口，照样会激活。
 */
const HANDOVER_ACK_TIMEOUT_MS = 5_000;

// 装完**不自动** skipWaiting。旧 SW 一被顶掉，它全局作用域里的 streams 注册表就
// 随之消失，正在落盘的流式下载会在下一个 chunk 上永远等不到 ack——发版恰好撞上
// 一次大文件下载就是一次静默的下载失败。改成由页面在确认空闲后向**当前 active 的**
// SW 发 retire-if-idle，由它自己查全局 streams 表、置闩、把 skip-waiting 递给等待中
// 的版本（见下面的 retireIfIdle 和 share-target.ts 的 activateWhenIdle）。页面只数得
// 到自己那个 Window，所以这一步必须放在 SW 这一侧才覆盖得到别的标签页。
// 页面全关掉时浏览器也会自然激活等待中的版本。
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

/**
 * 旧 shell 缓存名，**新创建的在前**。
 *
 * 依赖的是 CacheStorage.keys() 的规范保证：它按 name→cache 的**插入顺序**返回，也就是
 * 创建顺序，最早创建的在最前。所以 reverse() 之后就是「最近创建的在前」。这里不能拿
 * 版本号排序——版本是内容哈希，没有顺序可言。
 *
 * 回滚要留意：回滚到一个**缓存名已经存在**的版本时，CACHE 在 keys() 里的位置是它当初
 * 第一次创建的位置，不在最后。所以下面一律先把 CACHE 剔掉再按顺序取，位置在哪都不影响
 * 结果——保留的永远是「除当前之外最近创建的两代」。
 */
function oldShellsNewestFirst(keys) {
  return keys.filter((k) => k !== CACHE && k.startsWith(SHELL_PREFIX)).reverse();
}

/**
 * 只删掉超出保留代数的旧 shell。
 *
 * 三条硬约束，测试逐条钉着：绝不删 CACHE；绝不碰不带 SHELL_PREFIX 的缓存（
 * relayium-share 首当其冲，它装的是用户分享进来的明文文件，删错就是丢文件）；
 * 保留的是**最近创建**的 KEEP_OLD_SHELLS 代，不是随便两代。
 */
function pruneOldShells(keys) {
  const doomed = oldShellsNewestFirst(keys).slice(KEEP_OLD_SHELLS);
  return Promise.all(doomed.map((k) => caches.delete(k)));
}

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then(pruneOldShells)
      .then(() => caches.open(SHARE_CACHE).then(sweepStaleShares).catch(() => {}))
      .then(() => self.clients.claim()),
  );
});

/**
 * 在 shell 缓存里找一条响应：**先当前，再保留的旧壳（新→旧）**。
 *
 * 顺序是这个函数存在的全部理由。全局的 caches.match() 按缓存创建顺序找，第一个命中
 * 就返回——那等于「最旧的优先」：离线导航会拿到最老那一代的 index.html，
 * site.webmanifest 这种**不带哈希、每代同名**的条目也会被旧副本盖住。当前这一代必须
 * 先问。
 *
 * 反过来，旧壳的回退也不能少：一张还开着的旧页面点进懒加载路由时，要的是它自己那代的
 * PricingPage-<旧 hash>.js，服务器上早没有了，只有旧壳里还留着一份。
 *
 * 只找 shell 缓存。relayium-share 装的是分享进来的文件，它们由页面直接开缓存来取
 * （share-target.ts 的 drainSharedFiles），不该出现在任何一次资源查找里。
 *
 * 用 caches.match(req, { cacheName }) 而不是 caches.open(name).then(c => c.match())：
 * open() 会**创建**不存在的缓存，而 fetch 和 activate 的清理是交错跑的——中间那个窗口
 * 里 open 一个刚被删掉的名字，就凭空复活一个空缓存，它还会顶掉一个真正有用的保留位。
 * 带 cacheName 的 match 对不存在的名字直接给 undefined，不创建任何东西。
 */
async function shellMatch(request) {
  try {
    const hit = await caches.match(request, { cacheName: CACHE });
    if (hit) return hit;
    // 取前 KEEP_OLD_SHELLS 个：activate 之后本来也只剩这么多，明确切一刀之后，
    // 「清理还没跑完」的窗口里行为也和稳态一致。
    for (const name of oldShellsNewestFirst(await caches.keys()).slice(0, KEEP_OLD_SHELLS)) {
      const found = await caches.match(request, { cacheName: name });
      if (found) return found;
    }
  } catch {
    /* 缓存不可用：当作没命中，交给网络。 */
  }
  return undefined;
}

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
    // 离线兜底走 shellMatch 而不是全局 caches.match("/")：后者按缓存创建顺序找，
    // 会把**最老那一代**的 index.html 交出去。见 shellMatch。
    e.respondWith(fetch(req).catch(() => shellMatch("/")));
    return;
  }

  if (url.origin === self.location.origin) {
    // Cache-first for our own hashed, immutable assets, and fill the cache on a
    // miss. The precache covers every JS/CSS this build emitted (language
    // catalogues included — see vite-plugin-pwa.ts), so the fill is the safety
    // net for whatever falls outside it: a chunk a later build adds without a
    // new SW, and anything hashed that the precache list happens not to name.
    //
    // 当前这一代优先，找不到才回退到保留的旧壳（新→旧）：还开着的旧页面靠这条
    // 回退才拿得到它自己那代的懒加载 chunk，而 site.webmanifest 这种每代同名的
    // 条目必须拿当前的。回填只写当前缓存（见 fill）。
    e.respondWith(
      shellMatch(req).then((hit) => hit || fetch(req).then((res) => fill(req, res))),
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
 *
 * 只写**当前**这一代。保留的旧壳是只读的历史，往里回填等于让它们随着时间长胖，而
 * 保留代数那个存储上限就是这么被绕过去的。
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

// 页面 → SW 的控制通道。只认下面几种消息，其余一律忽略。
//
// 同源检查是显式的，不靠"反正只有同源页面发得进来"这个默认：这条通道能触发换版
// （retire-if-idle / skip-waiting），不该依赖别处的默认值来保证。
// e.origin 在部分实现里对同源客户端是空串，所以只在它非空时才比对。
self.addEventListener("message", (e) => {
  if (e.origin && e.origin !== self.location.origin) return;
  const d = e.data;
  if (!d || typeof d !== "object") return;
  if (d.type === "retire-if-idle") {
    retireIfIdle(e);
    return;
  }
  if (d.type === "stream-probe") {
    // 能力探测。页面用它确认「正在控制我的这个 SW 认识流式路由」——光看
    // navigator.serviceWorker.controller 非空不够：部署换版期间控制页面的可能
    // 还是一个不认识 STREAM_ROUTE 的旧 SW，那种情况下下载会漏到 nginx。
    if (e.ports[0]) e.ports[0].postMessage({ type: "stream-probe-ok" });
    return;
  }
  if (d.type === "skip-waiting") {
    // 这一条是**等待中的那一份**收到的：旧 active SW 确认全局没有在途流式下载之后
    // 把它递过来（见 retireIfIdle）。页面在兼容路径上也会直接发这一条。
    //
    // 先回执再 skipWaiting：回执让递交方知道交接确实到手，也让它的 waitUntil 有个
    // 终点。端口是可选的——旧版本的递交方不带端口。
    if (e.ports[0]) { try { e.ports[0].postMessage({ type: "skip-waiting-ack" }); } catch {} }
    // waitUntil 包住 skipWaiting()：它返回的是 promise，不包的话浏览器可以在处理器
    // 返回后就把本 worker 判为空闲、连同这个没落地的激活一起丢掉。
    const p = self.skipWaiting();
    if (e.waitUntil && p && typeof p.then === "function") e.waitUntil(p.catch(() => {}));
    return;
  }
  if (d.type === "stream-ping") return; // 保活空包：收到即刷新 SW 的空闲计时器
  if (d.type === "stream-open") openStream(d, e.ports[0]);
});

/**
 * 把 skip-waiting 递给等待中的版本，并让本 SW 至少活到对面收下为止。
 *
 * 回执端口只有两个作用：给 waitUntil 一个有界的终点，以及让测试能断言「交接确实
 * 到手了」。它**不参与任何状态判断**——收不到回执不等于没交接（见
 * HANDOVER_ACK_TIMEOUT_MS 里回滚部署那一段）。
 *
 * postMessage 抛出去由调用方接：那才是「一个字节都没递出去」的唯一凭据。
 */
function handOver(waiting, event) {
  let ch = null;
  try {
    ch = new MessageChannel();
  } catch {
    ch = null; // 极端环境没有 MessageChannel：不带回执照样递交
  }
  if (!ch) {
    waiting.postMessage({ type: "skip-waiting" });
    return;
  }

  // finish 幂等，且回执和超时**两条路都**收干净：页面每 15s 就会再请求一次，
  // 每一次都会走到这里；只要有一条路漏掉 clearTimeout / close，一次久等的换版就能
  // 攒出几十个计时器和端口。
  let settled = false;
  let timer;
  let resolveAcked;
  const acked = new Promise((r) => { resolveAcked = r; });
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { ch.port1.close(); } catch {}
    resolveAcked();
  };
  ch.port1.onmessage = (ev) => {
    if (ev.data && ev.data.type === "skip-waiting-ack") finish();
  };
  // 有界即可。这个计时器只喂 waitUntil，超时什么状态都不改。
  timer = setTimeout(finish, HANDOVER_ACK_TIMEOUT_MS);

  try {
    waiting.postMessage({ type: "skip-waiting" }, [ch.port2]);
  } catch (err) {
    finish(); // 一个字节都没递出去，别留着计时器和端口空等 5 秒
    throw err; // 交给 retireIfIdle：只有这条路才允许把闩放回去
  }
  // 不包 waitUntil 的话，浏览器可以在本处理器返回后立刻判本 SW 空闲并终止它，
  // 刚 post 出去的递交就丢在半路——页面下一轮还得重来。
  if (event && typeof event.waitUntil === "function") event.waitUntil(acked);
}

/**
 * 换版协调的原子那一步：全局没人在下载就置闩并把 skip-waiting 递给等待中的版本。
 *
 * 决策段全程同步，**中间一个 await 都没有**。这正是它存在的理由：SW 是单线程事件
 * 循环，「查 streams 表 → 置 retiring → 递交」全落在同一个任务里，别的标签页的
 * stream-open 只能排在这个任务前面或后面，插不进中间。排在后面的会被 openStream
 * 立刻拒掉（那时 retiring 已为真），而不是开出一条注定被换版掐断的流。
 *
 * 状态迁移（retiring 是单向闩，本实例内只有一个方向）：
 *   none    --有流在途--------------------▶ none，回 retire-busy
 *   none    --没有等待中的版本------------▶ none，回 retire-none
 *   none    --递交抛异常（什么都没递出去）-▶ none，回 retire-none
 *   none    --递交成功--------------------▶ RETIRED，回 retire-ok
 *   RETIRED --再来一次请求----------------▶ RETIRED，重发递交（幂等），回 retire-ok
 *   RETIRED --本实例被终止/回收-----------▶ （新实例）none
 * RETIRED 期间 openStream 一律拒。没有任何计时器能把它翻回去——上一版用宽限计时器
 * 兜底解除，重复请求会各自排一个没人管的计时器，早排的能把晚置的闩解掉，解掉之后
 * 收下的流又会被那次仍然悬着的激活掐死。
 *
 * 回执一定发，页面据此决定停表还是继续轮询：
 *   retire-ok   —— 已交接，等 controllerchange
 *   retire-busy —— 有流在途（可能在别的标签页），等会儿再来
 *   retire-none —— 没有可交接的对象，什么都没做
 * 没有回执的第四种是**这一版之前的 SW**：它压根不认识这条消息，页面靠超时识别，
 * 走兼容路径（见 share-target.ts）。
 */
function retireIfIdle(event) {
  const port = event && event.ports ? event.ports[0] : null;
  const reply = (type) => { if (port) { try { port.postMessage({ type }); } catch {} } };
  let waiting = null;
  try {
    waiting = self.registration && self.registration.waiting;
  } catch {
    waiting = null; // registration 读不到
  }

  // 已经交接过：闩不动，只把递交重发一遍。等待中的那份可能被浏览器终止过、上一条
  // 消息也可能丢了，重发是让它最终激活的唯一手段，而且是幂等的。
  if (retiring) {
    try {
      if (waiting) handOver(waiting, event);
    } catch {
      /* 重发失败无所谓：闩已经在了，下一轮再来 */
    }
    return reply("retire-ok");
  }

  // 有流在途就不动。这里数的是**全局**的表，覆盖本 SW 控制的所有标签页——页面
  // 自己那个计数做不到这一点，这也正是协调要放在 SW 这一侧的原因。
  if (streams.size > 0) return reply("retire-busy");
  // 没人接班就不置闩：置了却没有新版本上来，等于白白关掉本实例的流式下载，而换版
  // 一次也不会发生。
  if (!waiting) return reply("retire-none");

  retiring = true; // ← 先置闩，再递交。顺序反过来就又有那个空窗了。
  try {
    handOver(waiting, event);
  } catch {
    // 一个字节都没递出去，没有任何激活会发生。这是唯一能安全把闩放回去的分支，
    // 而且它是同步的——不存在「晚到的计时器把闩解掉」这回事。
    retiring = false;
    return reply("retire-none");
  }
  reply("retire-ok");
}

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
  if (retiring) {
    // 已预约退休：这条流一开出来就会随本 SW 一起消失，页面会在下一个 chunk 上等一个
    // 永远不来的 ack。立刻、明确地拒掉——页面据此马上回落到内存分支（见 filesink
    // 的 pickSaveTarget），代价只是这一次下载吃内存，而不是干等 5 秒握手超时、更不是
    // 一次断在半路的下载。
    port.postMessage({ type: "stream-refused", reason: "updating" });
    return;
  }
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
