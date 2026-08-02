// Client half of the Web Share Target flow. The service worker parks files
// shared into the installed PWA in a cache and redirects here with a token;
// we read them back into File objects. Android/Chromium only — iOS Safari has
// no inbound share target, where this simply finds no token and no-ops.
import { probeStreamSupport, streamDownloadsActive } from "./filesink";
import { markAppUpdatePending, markAppUpdateReloadReady } from "./app-update.svelte";

const SHARE_CACHE = "relayium-share";

/** 检查等待中的 SW 能不能放行的间隔。只在真有一个 waiting 版本时才起表。 */
const ACTIVATE_RETRY_MS = 15_000;

/**
 * 等 active SW 回一句退休回执的上限。
 *
 * 超时必须有，而且超时要走兼容路径：这一版之前的 SW 根本不认识 retire-if-idle，
 * 它收到就静静丢掉，永远不会回。要是把沉默当成「有下载」，所有还被旧 SW 控制的
 * 设备就再也升不上来了——一个为保护下载加的闸门反而把升级永久卡死。
 *
 * 2 秒的量级：SW 可能是睡着的，postMessage 会把它唤醒，几十到几百毫秒是常态；而放行
 * 本来就不赶时间（下一次轮询 15s 后还会再来一遍）。
 */
const RETIRE_TIMEOUT_MS = 2_000;

/** retireIfIdle 的回执，外加一个「没回执」。见 sw-template.js 的 retireIfIdle。 */
type RetireVerdict =
  | "retired" // 已预约退休并放行了 waiting 版本
  | "busy" // 有流式下载在途（可能在别的标签页）
  | "nothing" // 没有可放行的 waiting 版本
  | "unsupported"; // 没人可问，或对方不认识这条消息（这一版之前的 SW）

/** Register the service worker. Production + secure context only; the offline
 *  shell and share target are best-effort, so failures are swallowed. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  // 必须在 register() **之前**读，而且要作为显式参数传下去。register() 返回的是
  // 一个 promise：等它落地时，首次安装的那份 SW 很可能已经 activate + claim 了本
  // 页，controller 早已非空。那时候再读就会把「这台设备上的第一份 SW」误判成一次
  // 更新，给一个什么都还没用旧的用户弹刷新条。
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => activateWhenIdle(reg, hadController))
    .catch(() => {});
  // 顺带把流式下载的就绪状态探出来。必须现在（异步）做完：canStreamToDisk 是
  // 同步的，pickSaveTarget 又必须整个跑在用户手势里，到那时已经来不及等 SW。
  probeStreamSupport();
}

/** 「读不到」是第三种答案，不是 null。 */
const UNKNOWN = Symbol("waiting-unknown");

/**
 * reg.waiting 的三态读法：一个 worker / null（确实没有）/ UNKNOWN（读取本身抛了）。
 *
 * registration 在 SW 被注销或回收之后读属性是可能抛的，而这个读法出现在事件回调里，
 * 抛出去只会变成一个没人接的错误。但**不能把抛出当成 null**：调用方拿 null 的含义是
 * 「没有更新的版本在等」，据此会把状态推到 ready、把刷新按钮放开。读失败时到底有没有
 * 更新的在等是未知的，未知必须保守——什么都不改，停在原来的（通常是 pending）。
 */
function waitingState(reg: ServiceWorkerRegistration): ServiceWorker | null | typeof UNKNOWN {
  try {
    return reg.waiting ?? null;
  } catch {
    return UNKNOWN;
  }
}

/**
 * 请 active SW 在空闲时把等待中的新版本放行。
 *
 * 请的是**当前 active 的那个 worker**：待放行的新版本顶掉的正是它，随它一起消失的
 * 流式下载注册表也正是它的，而那张表是唯一一份跨标签页的真相。reg.active 拿不到时
 * 退回 controller（硬刷新等情形下页面可能没被控制，但 registration 仍有 active）。
 *
 * 判断和动作都在对面一个事件任务里完成，页面这边只收结论——中间没有可以被别的标签页
 * 插进来的空窗。详见 sw-template.js 的 retireIfIdle。
 *
 * 这个函数不抛，每条路径都会 settle，并且在 settle 时清掉超时表、关掉端口：15 秒
 * 一轮的轮询会反复走这里，攒着不放就是一次长下载攒出几十个通道。
 */
function requestRetirement(reg: ServiceWorkerRegistration): Promise<RetireVerdict> {
  return new Promise<RetireVerdict>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ch: MessageChannel | null = null;
    const finish = (v: RetireVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 只关自己这一端：port2 已经转移给了 SW，这边的引用是空壳。关掉 port1 顺带
      // 让迟到的回执落空，正是想要的。
      try { ch?.port1.close(); } catch { /* 端口早没了 */ }
      resolve(v);
    };
    try {
      const target = reg.active ?? navigator.serviceWorker?.controller ?? null;
      if (!target || typeof MessageChannel === "undefined") return finish("unsupported");
      ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        const t = (e.data as { type?: string } | null)?.type;
        if (t === "retire-ok") finish("retired");
        else if (t === "retire-busy") finish("busy");
        else if (t === "retire-none") finish("nothing");
      };
      timer = setTimeout(() => finish("unsupported"), RETIRE_TIMEOUT_MS);
      target.postMessage({ type: "retire-if-idle" }, [ch.port2]);
    } catch {
      finish("unsupported");
    }
  });
}

/**
 * 放行等待中的新 SW —— 但只在没有流式下载在途的时候。
 *
 * sw-template.js 的 install 故意不再自作主张 skipWaiting：新 SW 一激活，旧 SW 连同
 * 它内存里的流式下载注册表一起消失，正在落盘的那次下载会在下一个 chunk 上永远等不到
 * ack（页面侧靠 STREAM_ACK_TIMEOUT_MS 兜成一个报错，但用户丢的是一次大文件下载）。
 * 换成由页面在空闲时放行：绝大多数情况下就是「装好即刻生效」，只有正在下载时才推迟。
 *
 * 推迟只用一个轮询而不是订阅下载结束事件：这条路径不值得为它建一套通知机制。
 *
 * **放行的决定权不在页面手里。** filesink 的 streamDownloadsActive() 只是本 Window
 * 的模块状态，数不到别的标签页；而「页面查一次、页面再去 post skip-waiting」这种
 * 两步做法，无论查得多准，两步之间都留着一个空窗——别的标签页在那个空窗里登记一条
 * 流，就会被这次换版掐死。所以真正的动作交给 active SW 自己：
 *   1. 本页 streamDownloadsActive() 为真 → 立刻拦，连问都不用问（省一次往返，
 *      SW 那边会给出同样的结论）；
 *   2. 否则给 active SW 发 retire-if-idle，由它在**一个事件任务**里查全局 streams
 *      表、预约退休、把 skip-waiting 发给 waiting 版本。预约之后进来的 stream-open
 *      会被它当场拒掉，页面那边立刻回落到内存下载。
 * 只有这一版之前的 active SW 不认识这条消息（它们静静丢掉，永远不回）。那种情况下
 * 超时之后走兼容路径 = 旧行为：本地闸门过了就自己去 post skip-waiting。旧行为看不到
 * 别的标签页，这正是本版要修的洞；但它只在换到本版的**那一次**发生，而且不这样这些
 * 设备就永远升不上来。见 RETIRE_TIMEOUT_MS。
 *
 * 同一处还负责把「有新版本了」这件事告诉界面（app-update）。换 SW **不会**动正在
 * 跑的这张页面：它的 JS 早就加载完了，新 SW 只决定下一次导航拿到什么。所以线上出过
 * 的那种事故——发版后还开着的旧页面继续按旧规则铸配对码，直到用户手动刷新——只能靠
 * 页面自己挂一条提示、由用户决定何时刷新来收口。这里绝不自动 reload：reload 会掐掉
 * 在途传输、待发队列和未发出的消息，而 SW 对这些一无所知。
 *
 * 界面拿到的是两级状态，不是一个布尔（见 app-update.svelte.ts 的 Stage）：
 *   installed/waiting → pending（条子出现，但刷新按钮不给点）
 *   controllerchange  → ready  （新 SW 真接管了，这时候刷新才落到新构建上）
 * 中间那一级正是为流式下载留的：下载在途时这里压着不放行，页面也就停在 pending，
 * 刷新按钮是死的——既不会掐掉那次下载，也不会刷出一个比 waiting 那份还旧的构建。
 * 下载结束后下一次轮询放行，controllerchange 再把状态推到 ready，按钮自己就活了。
 *
 * 每一次**新**的 installed 都重新置 pending，即使这一页早就是 ready 了：同一张老
 * 标签页连着经历两次发版（B 接管过、用户没刷；C 又装好被压着）时，停在 ready 会让
 * 按钮一直可点，那一下既掐掉压着 C 的下载，又只刷到 B。
 *
 * 注意这套机制的边界（见 app-update.svelte.ts 顶部）：它保护的是**以后**的发版，
 * 前提是这一版已经在标签页里跑起来了；对此刻还在执行旧 JS 的页面无能为力。
 *
 * @param hadControllerAtRegistration register() 调用**之前**本页是否已被某个 SW
 *   控制。由调用方在那一刻读好传进来，理由见 registerServiceWorker。
 */
export function activateWhenIdle(reg: ServiceWorkerRegistration, hadControllerAtRegistration: boolean): void {
  // 「本页已经被某个版本控制过」这个基线，决定之后装好的 worker 算不算更新：首次
  // 安装装好的那份不是「新版本」，是这台设备上的第一份，那时候弹更新条纯属噪音。
  //
  // 两个来源取或，缺一不可：
  //   - hadControllerAtRegistration：register() 调用**之前**读到的值。controller 可能
  //     在这之后变回 null（注销、换版窗口），但那不会让这张页面的 JS 重新变新，所以
  //     一旦为真就算数。
  //   - 此刻的 controller：首装的 SW 可能在 register() 的 promise 落地之前就 claim 了
  //     本页，那次 controllerchange 发生在监听器挂上之前，永远收不到。只认参数的话
  //     hadController 会永远停在 false，下一次**真**发版就被静默吞掉。
  // 这里读 controller 不会造成误报：读到非空说明那份 SW 现在就是 controller，不是
  // waiting/installing，下面没有任何一条路会拿它去报更新——只有比它更新的 worker 才
  // 报。（第一次 controllerchange 之后照样置真，管的是首访那条路。）
  let hadController = hadControllerAtRegistration || !!navigator.serviceWorker?.controller;

  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const arm = () => { timer ??= setInterval(tryActivate, ACTIVATE_RETRY_MS); };
  /** 有一次退休请求在途。并发的 updatefound / 轮询 / controllerchange 都可能同时叫到
   *  tryActivate，没有这道闸就会重复请求、也可能重复 post skip-waiting。 */
  let checking = false;

  /**
   * 兼容这一版之前的 active SW —— 它不认识 retire-if-idle。只能沿用旧做法：本页自己
   * 的闸门过了就直接把 skip-waiting 发给 waiting 版本。旧做法看不到别的标签页，这正
   * 是本版要修的洞；但不这样这些设备永远升不上来（见 RETIRE_TIMEOUT_MS）。
   */
  const legacySkipWaiting = () => {
    const waiting = reg.waiting;
    if (!waiting) { stop(); return; }
    if (streamDownloadsActive()) { arm(); return; }
    waiting.postMessage({ type: "skip-waiting" });
    arm(); // 换版真落地时 waiting 会变空，那时轮询自己停
  };

  /**
   * 放行闸门。自终止：没有 waiting 版本时顺手把轮询也停掉，免得留一根空转的表。
   * 异步，因为放行是由 active SW 执行的（见函数头注释）。
   */
  const tryActivate = () => {
    try {
      if (checking) return; // 已经有一次在请求了，等它的结论
      const waiting = reg.waiting;
      if (!waiting) { stop(); return; } // 没有待激活的版本，什么都不用做
      // 本页自己就在下载：同步、立刻拦，连问都不用问。
      if (streamDownloadsActive()) { arm(); return; }
      checking = true;
      requestRetirement(reg).then((verdict) => {
        checking = false;
        try {
          // 请求成功也继续留着轮询：万一激活迟迟不落地（等待中的那份被浏览器终止、
          // 消息丢了），下一轮会再请求一次，SW 那边会**重发**递交——它的退休闩是本
          // 实例内永不解除的，重发是幂等的，也正是让激活最终落地的唯一手段。
          // 真换版之后 waiting 变空，轮询自己停。
          if (verdict === "retired") { arm(); return; }
          if (verdict === "busy") { arm(); return; } // 有流在途，可能在别的标签页
          if (verdict === "nothing") { if (reg.waiting) arm(); else stop(); return; }
          legacySkipWaiting(); // unsupported：这一版之前的 SW
        } catch {
          stop();
        }
      });
    } catch {
      // SW 相关调用一律 best-effort：离线外壳挂了也不能把 App 的启动带崩。
      checking = false;
      stop();
    }
  };

  /** 已经在盯着的 installing worker。同一份 worker 可能从两处递进来（setup 时它
   *  已经在了，updatefound 又报一次），重复挂监听会让同一次安装报两遍。 */
  const watched = new WeakSet<ServiceWorker>();
  /** 盯住一份正在安装的 worker，装好就上报 + 走一遍放行闸门。 */
  const watchInstalling = (w: ServiceWorker | null) => {
    if (!w || watched.has(w)) return;
    watched.add(w);
    const onState = () => {
      if (w.state !== "installed") return;
      if (hadController) markAppUpdatePending();
      tryActivate();
    };
    w.addEventListener("statechange", onState);
    onState(); // 监听器挂上之前它就可能已经 installed 了
  };

  // 整段挂监听都包在 try 里：SW / registration 全是 best-effort，离线外壳这边出任何
  // 岔子都不能把 App 的启动带崩（这个函数是在 register().then 里跑的）。
  try {
    // controllerchange 先挂上，且必须早于任何可能触发换版的调用（下面的 tryActivate、
    // 以及 updatefound 里的那次）。晚挂就有一个窗口：skip-waiting 已经发出去、新 SW
    // claim 完了，监听器才装好——那次换版永远收不到，界面就卡在 pending 再也活不过来。
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      try {
        // controllerchange 也会在 controller 变成 **null** 时触发（注销、或换版窗口
        // 里短暂没人控制）。那不是「新版本接管了」，把它当更新会让刷新按钮在实际上
        // 没有任何新构建在控的时候活过来。只认非空的新 controller。
        if (!navigator.serviceWorker.controller) return;
        // 首次安装那一次自己不算更新，但它之后的都算。hadController 一旦为真就不再
        // 回退：controller 掉成 null 并不会让这张页面的 JS 重新变新。
        if (hadController) {
          // 事件到手的那一刻再看一眼 registration，而不是照着「有 controllerchange
          // 就是 ready」写死。A→B→C 快速连发时，B 的 controllerchange 可能排在 C 的
          // installed 后面才跑到：那时候 reg.waiting 已经是 C，谎称 ready 会让按钮
          // 短暂活过来，点下去既掐掉压着 C 的东西，又只刷到 B。
          // 还压着更新的一份，就还是 pending；等 C 自己接管时再置 ready。
          const waiting = waitingState(reg);
          // 读不到 registration 时**一个字都不改**：那时候「有没有更新的在等」是未知
          // 的，而唯一会造成伤害的猜法恰恰是猜「没有」——那会把刷新按钮放开。停在
          // 原来的状态（通常是 pending），等下一次事件或轮询给出确定答案。
          if (waiting !== UNKNOWN) {
            if (waiting) markAppUpdatePending();
            else markAppUpdateReloadReady();
          }
        }
        hadController = true;
        tryActivate(); // 换版落地：停表；万一又压着一个 waiting，顺手再走一遍闸门。
      } catch {
        /* 同上，best-effort */
      }
    });

    reg.addEventListener("updatefound", () => {
      try {
        watchInstalling(reg.installing);
      } catch {
        /* 同上，best-effort */
      }
    });

    // register() 的 promise 是在 Install 算法**中途**兑现的，所以走到这里时 reg
    // .installing 往往已经存在、它那次 updatefound 也早发过了——只挂 updatefound
    // 监听器的话，这一份正在装的新版本会被整个漏掉（它 installed 时没人在听）。
    watchInstalling(reg.installing);

    // 上一次访问留下的 waiting 版本（当时正在下载，或标签页被关掉了）。
    if (reg.waiting && hadController) markAppUpdatePending();
  } catch {
    /* 同上，best-effort */
  }
  tryActivate();
}

/** If the current URL carries a share-target token, drain the SW-stashed files
 *  back into File objects, then clean up the cache entries and the URL param so
 *  a reload can't re-trigger. Returns [] when there's nothing to drain. */
export async function drainSharedFiles(): Promise<File[]> {
  const params = new URLSearchParams(location.search);
  const token = params.get("share-target");
  if (!token) return [];

  // Strip the param up front so a refresh doesn't reopen a spent share.
  params.delete("share-target");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);

  if (!("caches" in window)) return [];
  try {
    const cache = await caches.open(SHARE_CACHE);
    const base = "/__shared__/" + token + "/";
    const countRes = await cache.match(base + "count");
    const count = countRes ? parseInt(await countRes.text(), 10) : 0;

    const files: File[] = [];
    for (let i = 0; i < count; i++) {
      const res = await cache.match(base + i);
      if (!res) continue;
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get("x-name") || `shared-${i}`);
      files.push(new File([blob], name, { type: res.headers.get("content-type") || blob.type }));
    }

    // Best-effort cleanup: this token's entries are one-shot.
    await cache.delete(base + "count");
    for (let i = 0; i < count; i++) await cache.delete(base + i);
    return files;
  } catch {
    return [];
  }
}
