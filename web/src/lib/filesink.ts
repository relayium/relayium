import { ZipWriter, safeSegments } from "./zip";
import { streamURL, contentDisposition } from "./sw-stream";

/**
 * 一个文件的写入端。
 *
 * **调用必须串行**：每次 write/close 都要 await 到 settle 之后才能发起下一次。
 * 这不是实现偷懒——sink 写的是一条字节流，两个并发的 write 谁先落盘是未定义的，
 * 文件内容本身就已经错了，再怎么排队也救不回来。所以违约不是「不支持」而是
 * 「调用方的字节序已经没有意义」，实现应当**响亮地失败**（swStreamSink 会直接
 * 把这次下载判死并让两侧的 promise 都 reject），而不是默默排队掩盖问题。
 */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** 用户在浏览器的下载界面里主动取消了这次下载（或浏览器掐了它）。
 *  和「解密失败」「网络中断」都不是一回事，下载页要按取消如实提示。 */
export class SinkCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinkCancelledError";
  }
}

/**
 * 把字节交给磁盘这一段出了问题：SW 被回收、部署换版顶掉了它、浏览器一直没来取流。
 *
 * 和 SinkCancelledError（用户自己取消）、DownloadNetworkError（取字节的那一段断了）
 * 并列，三者都**不是**「密钥错误或文件损坏」。分出这个类型只有一个目的：下载页据此
 * 如实归因并给出重试按钮。把 SW 故障落进 decryptFail 等于告诉用户他的文件坏了，
 * 而且连重试的入口都不给——数据其实一个字节都没错。
 */
export class SinkTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinkTransportError";
  }
}

/**
 * 目标选择的能力开关。
 *
 * `swStream` 就是「允许走 service worker 流式落盘那条分支」，**默认关**，目前只有
 * 下载页（DownloadPage.svelte）打开。
 *
 * 为什么是显式开关而不是「能用就用」：SW sink 的「已 ack」只代表 SW 把这一块塞进了
 * ReadableStream，**不代表已经落盘**。实时接收路（App.svelte）拿这个 ack 当作
 * durability 信号回给发送端（`resumable` 与流控 ACK），语义对不上，而且完全没验证过。
 * 下载页那条路没有对端、没有 durability 承诺，是干净的试验田。
 *
 * 开关必须显式传，不能靠「有没有 path」「是不是单文件」这类隐式判别——那种判别会在
 * 下一次有人改调用方形状时悄悄把实时路也打开。filesink.test.ts 有用例钉住这一点。
 */
export interface SaveOptions {
  swStream?: boolean;
}

export interface FileMetaLite {
  name: string;
  size: number;
  path?: string; // relative path within a sent folder; absent for a flat file
}

/** A destination for a whole batch: hands out one sink per file, in arrival order. */
export interface SaveTarget {
  /** Human-readable description of where files are going (for the UI). */
  label: string;
  file(name: string, size: number, path?: string): Promise<FileSink>;
  /** Finalise the batch (e.g. flush a bundled ZIP). Called once, after the last
   *  file's sink closes. Optional: streaming targets need no finalisation. */
  done?(): Promise<void>;
}

interface SavePickerWindow {
  showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FsFileHandle>;
  showDirectoryPicker?: () => Promise<FsDirHandle>;
}
interface FsFileHandle { createWritable: () => Promise<FsWritable>; }
interface FsDirHandle {
  getFileHandle: (name: string, o: { create: boolean }) => Promise<FsFileHandle>;
  getDirectoryHandle: (name: string, o: { create: boolean }) => Promise<FsDirHandle>;
}
interface FsWritable {
  write: (d: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 下载总量超过这个数，且浏览器没有流式落盘能力时，下载页会先提示再下载。
 *
 * 保守估计，不是实测出来的硬数字：没有 File System Access API 的浏览器
 * （Firefox、Safari、以及所有手机浏览器——iOS 上全是 WebKit）必须把整个文件
 * 攒在内存里才能交给用户，手机标签页在这个量级上已经很容易被系统回收。真实
 * 崩溃点随设备内存、系统和标签页数量浮动，需要真机验证后再调。
 */
export const LARGE_DOWNLOAD_WARN_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * 这一批文件在当前浏览器里能不能流式写盘（而不是先攒进内存）。
 *
 * 必须与下面 pickSaveTarget 的分支选择保持一致——它是同一套条件的提前问法，
 * 供下载页在开始下载前判断要不要提示。两者不一致就意味着下载页会在一条其实
 * 能落盘的路径上误报，或者更糟：在内存路径上一声不吭。filesink.test.ts 里有
 * 一条用例真跑 pickSaveTarget 逐个组合比对，专门守这个耦合。
 *
 * 多文件走的是目录选择器那条路：拿到目录句柄后每个文件仍是原生流式写入，同样
 * 不吃内存。所以单文件看 showSaveFilePicker（拿不到则回落到目录选择器），
 * 多文件只看 showDirectoryPicker。
 *
 * opts 必须和传给 pickSaveTarget 的那一份**一致**，否则这个提前问法就问的是另一条路。
 */
export function canStreamToDisk(fileCount: number, opts: SaveOptions = {}): boolean {
  const w = window as unknown as SavePickerWindow;
  if (fileCount === 1 && w.showSaveFilePicker) return true;
  if (w.showDirectoryPicker) return true;
  return fileCount === 1 && !!opts.swStream && swStreamReady();
}

// --- service worker 流式下载 -------------------------------------------------

/**
 * 探测结果缓存。**必须是同步可读的**：canStreamToDisk 是同步函数，pickSaveTarget
 * 又必须整个跑在用户手势里，在里面 await navigator.serviceWorker.ready 会把手势
 * 花掉（之后 showSaveFilePicker 之类就开不出来了）。所以就绪判断在启动时异步做完，
 * 这里只留一个布尔。
 */
let swStreamProbed = false;

/** 上一次 probeStreamSupport 挂的 controllerchange 监听器的摘除函数。
 *  探测可以被调用多次（启动一次，测试里每条用例一次），不摘旧的就会一次叠一个，
 *  之后每次换版都触发 N 遍重探。 */
let swProbeCleanup: (() => void) | null = null;

/**
 * 当前有多少条流式下载在途。
 *
 * 用途是发版换 SW 的时机：旧 SW 一被顶掉，它全局作用域里的 streams 注册表就消失，
 * 在途下载会永远等不到 ack。换版放行（share-target.ts 的 activateWhenIdle）拿这个
 * 数当闸门——为 0 才放行。
 */
let liveStreams = 0;

/** 此刻是否有流式下载在途。见 liveStreams。 */
export function streamDownloadsActive(): boolean {
  return liveStreams > 0;
}

/**
 * 探测正在控制本页的 SW 认不认识流式路由，结果存进 swStreamProbed。
 * 由 share-target.ts 的 registerServiceWorker 在启动时调用（dev 不注册 SW，
 * 因此 dev 下这条路径永远不就绪，和既有的 import.meta.env.PROD 门一致）。
 *
 * 为什么要真的握一次手，而不是只看 controller 非空：部署换版时控制本页的可能还是
 * 一个旧 SW（skipWaiting + clients.claim 换版有窗口），旧 SW 不认识 STREAM_ROUTE，
 * 下载请求会漏到 nginx 被 try_files 兜底成 index.html——用户下载到一个网页。
 */
export function probeStreamSupport(): void {
  swStreamProbed = false; // 重新探测就重新验证
  swProbeCleanup?.(); // 摘掉上一轮的 controllerchange，别每次调用都叠一个
  swProbeCleanup = null;
  const sw = navigator.serviceWorker;
  if (!sw || typeof MessageChannel === "undefined") return;
  const ping = () => {
    const c = sw.controller;
    if (!c) return; // 首次访问：SW 刚注册还没 claim，controller 是 null
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => {
      if ((e.data as { type?: string } | null)?.type === "stream-probe-ok") swStreamProbed = true;
    };
    c.postMessage({ type: "stream-probe" }, [ch.port2]);
  };
  // claim 到来（首次访问）或换版都会触发 controllerchange，两种情况都要重探。
  const onChange = () => { swStreamProbed = false; ping(); };
  sw.addEventListener("controllerchange", onChange);
  // 闭包捕获的是**这一次**的 sw 对象，即使之后 navigator.serviceWorker 被换掉也摘得干净。
  swProbeCleanup = () => sw.removeEventListener("controllerchange", onChange);
  sw.ready.then(ping).catch(() => {});
  ping();
}

/**
 * 这个浏览器现在能不能走 SW 流式下载。
 *
 * controller 非空这一项**每次都现查**而不是缓存：它随时可能变回 null（SW 注销、
 * 换版窗口）。缓存它就等于在 controller 已经没了的时候仍然承诺能流式下载，那次
 * 下载会漏到 nginx 变成一个 index.html。filesink.test.ts 有一条用例守这个。
 */
export function swStreamReady(): boolean {
  return swStreamProbed && !!navigator.serviceWorker?.controller;
}

/** 16 字节随机 token，字母表落在 sw-stream.ts 的 TOKEN_RE 里（十六进制是其子集）。 */
function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}

/** 等 stream-ready 握手的上限。超时就当 SW 不可用，回落到内存分支。 */
const STREAM_OPEN_TIMEOUT_MS = 5000;
/** 保活心跳间隔，必须明显小于浏览器约 30s 的 SW 空闲回收窗口。 */
const STREAM_KEEPALIVE_MS = 10_000;
/** 从触发 iframe 导航到 SW 真的开始供流的上限。超时说明这次下载根本没被接住。 */
const STREAM_SERVE_TIMEOUT_MS = 30_000;
/**
 * **每一次** ack 等待的停滞上限。
 *
 * 这是整条路径上唯一能兜住「SW 被浏览器回收」的东西，而回收恰恰是手机上最常见的
 * 失败方式：SW 死了不会触发 controllerchange（registration 没变），stream-ping 只会
 * 把 SW 拉起来一个**新实例**——新实例的 streams 是空的、旧 port 已随 worker 消失，
 * 之后的 chunk 全发进虚空。没有这个超时，write() 就永远 pending，下载界面停在
 * 某个百分比上一动不动。
 *
 * 取 60s 的理由：ack 由浏览器的下载消费方 pull 触发，它写的是本地磁盘，正常节奏
 * 是毫秒级；真实停顿只可能来自磁盘忙或系统压力，60s 远超这些。再长就等于让用户
 * 盯着一个已经死掉的进度条多熬一分钟。
 * 已知取舍：用户在浏览器下载界面里**暂停**这次下载会让消费方停止 pull，超过 60s
 * 就会被判成停滞而中止。相比「永久挂死」，一个明确的报错 + 重下更可接受。
 */
const STREAM_ACK_TIMEOUT_MS = 60_000;
/**
 * 等 close 回执（SW 确认流已收尾）的上限。
 *
 * SW 活着时这就是一次 postMessage 往返，毫秒级；等不到基本只有一种解释——SW 已经
 * 被回收，这条流永远不会收尾。15s 给手机上被抢占的主线程留足余量，又不至于让用户
 * 在「就差最后一步」的地方干等太久。
 */
const STREAM_CLOSE_TIMEOUT_MS = 15_000;

/**
 * 打开一条 SW 流并触发浏览器下载，返回写入端。
 *
 * 触发方式是隐藏 iframe 而不是 <a download> 或 location.href：万一 SW 没接住
 * （探测和这一刻之间 SW 被换掉），iframe 里静默加载一个 index.html，页面本身
 * 毫发无损；换成顶层导航同样的故障会把用户整个带走。
 *
 * iframe 的 src 赋值不需要用户激活，所以这里 await 握手是安全的——不像
 * showSaveFilePicker 那样必须在手势里同步开出来。
 */
async function openSwStream(name: string, cd: string): Promise<FileSink> {
  const controller = navigator.serviceWorker.controller!;
  const path = streamURL(randomToken(), name);
  const ch = new MessageChannel();
  const port = ch.port1;

  let failure: Error | null = null;
  let settle: { ok: () => void; fail: (e: Error) => void } | null = null;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let serveTimer: ReturnType<typeof setTimeout> | undefined;
  let iframe: HTMLIFrameElement | undefined;

  // 这条流不再占着换版闸门。counted 保证只在真的记过数之后减（握手就失败的流
  // 从没加过），released 保证只减一次（close 成功之后 fail 仍可能被调用）。
  let counted = false;
  let released = false;
  const release = () => {
    if (released || !counted) return;
    released = true;
    liveStreams--;
  };
  const stopTimers = () => {
    clearInterval(keepalive);
    clearTimeout(serveTimer);
    navigator.serviceWorker.removeEventListener("controllerchange", onSwapped);
  };
  const fail = (err: Error): Error => {
    const first = !failure;
    if (!failure) { failure = err; release(); }
    const s = settle;
    settle = null;
    stopTimers();
    port.onmessage = null;
    if (first) {
      // 必须在 port.close() **之前**通知 SW 放弃这条流。只关端口的话 SW 那边什么都
      // 不知道：ReadableStream 的 reader.read() 永远 pending，注册表条目一直活着，
      // 浏览器那份下载吊在一个半截临时文件上，直到 SW 被回收才连带蒸发。
      try { port.postMessage({ type: "abort" }); } catch { /* 端口已经没了 */ }
    }
    port.close();
    iframe?.remove(); // 失败时确实要掐断这次导航
    s?.fail(failure);
    return failure;
  };
  // 部署换版会顶掉旧 SW，注册表随之蒸发，这条流再也不会有 ack。宁可立刻报错，
  // 也不要让下载永远卡在 99%。
  const onSwapped = () => fail(new SinkTransportError("service worker replaced mid-download"));

  /**
   * 占住唯一的 settle 槽，等 SW 的一次回执，带**独立的停滞超时**。
   *
   * 每一次等待都要有超时，不只是握手期：SW 被浏览器回收时既不会触发
   * controllerchange 也不会有任何回执，唯一还能让 write()/close() 结束的就是这里。
   *
   * 这里所有的失败都用 SinkTransportError：调用方（下载页）据此归因成「传输问题，
   * 可重试」。并发误用严格说是调用方的 bug 而不是传输故障，但它照样不是「文件损坏」，
   * 归到可重试那一类比让用户看到「密钥错误或文件损坏」诚实得多。
   *
   * 槽被占着就说明调用方并发调用了 write/close，违反了 FileSink 的串行约定。
   * 这时不排队而是直接把整条流判死（两侧 promise 都 reject）：并发写入的字节序
   * 本来就已经是未定义的，落一个内容错乱的文件比响亮地失败糟得多。
   */
  const awaitReply = (what: string, ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (settle) {
        reject(fail(new SinkTransportError(`FileSink misuse: concurrent ${what} — calls must be serialised`)));
        return;
      }
      const timer = setTimeout(
        () => fail(new SinkTransportError(`service worker stopped responding (${what} timed out)`)),
        ms,
      );
      settle = {
        ok: () => { clearTimeout(timer); resolve(); },
        fail: (e) => { clearTimeout(timer); reject(e); },
      };
    });

  port.onmessage = (e) => {
    const t = (e.data as { type?: string } | null)?.type;
    if (t === "stream-ready" || t === "ack" || t === "closed") {
      const s = settle;
      settle = null;
      s?.ok();
    } else if (t === "stream-serving") {
      clearTimeout(serveTimer); // iframe 的请求到了 SW，这条流真的在供
    } else if (t === "cancel") {
      fail(new SinkCancelledError("download cancelled in the browser"));
    }
  };
  navigator.serviceWorker.addEventListener("controllerchange", onSwapped);
  const opened = awaitReply("open", STREAM_OPEN_TIMEOUT_MS);
  controller.postMessage(
    { type: "stream-open", path, headers: { "Content-Disposition": cd } },
    [ch.port2],
  );
  await opened;
  liveStreams++; // 换版闸门：从这里到 release() 之间不允许激活新 SW
  counted = true;

  // SW 空闲约 30s 会被回收，注册表跟着没。写入本身就是消息，会不断刷新计时器；
  // 心跳只覆盖上游长时间不出数据的那段（对端卡住、暂停）。
  keepalive = setInterval(() => controller.postMessage({ type: "stream-ping" }), STREAM_KEEPALIVE_MS);

  serveTimer = setTimeout(
    () => fail(new SinkTransportError("the browser never fetched the stream")),
    STREAM_SERVE_TIMEOUT_MS,
  );
  iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.src = path;
  document.body.appendChild(iframe);

  return {
    write: async (chunk) => {
      if (failure) throw failure;
      // slice 拷一份：chunk 常常是更大缓冲区的 subarray（DownloadPage 就是这么切的），
      // 直接转移会把调用方手里的缓冲区一并 detach 掉。
      const copy = chunk.slice();
      const ack = awaitReply("write", STREAM_ACK_TIMEOUT_MS);
      port.postMessage({ type: "chunk", chunk: copy }, [copy.buffer]);
      await ack; // ← 背压：SW 只在消费方真的要下一块时才 ack
    },
    close: async () => {
      if (failure) throw failure;
      // 必须等 SW 回 closed 才算收尾。只发不等的话，SW 早被回收时 ctrl.close()
      // 根本没发生，浏览器那份下载永远不收尾（用户拿到半个文件），而页面已经把
      // 界面置成「完成」——比它要取代的内存提示糟得多。
      const closed = awaitReply("close", STREAM_CLOSE_TIMEOUT_MS);
      port.postMessage({ type: "close" });
      await closed;
      release();
      // 收尾成功之后才停心跳/摘监听：在此之前 controllerchange 仍是最后的救场。
      stopTimers();
      // 不在这里 close() 端口、也不立刻摘 iframe：流虽然已经收尾，浏览器可能还在
      // 把最后几块落盘，摘掉承载这次导航的 iframe 有可能把它掐了。晚一点再收。
      const el = iframe;
      setTimeout(() => { port.onmessage = null; port.close(); el?.remove(); }, STREAM_KEEPALIVE_MS);
    },
  };
}

/**
 * 没有流式落盘能力时，把这一批文件交付给用户的内存峰值估算。
 *
 * 两条内存分支的峰值差一倍：
 * - 文件夹（有 path 含 "/"）走 ZipWriter：每个文件先攒 parts[]，close 时 concat
 *   复制一份进 zip 缓冲，finish 再拼出完整 zip —— 整批同时在内存里且被复制过，
 *   峰值约 2× 批次总量。
 * - 扁平批次走 blobSink 逐个下载，真实峰值约等于最大单文件；这里仍按总量算，
 *   偏保守，与下载页的既有口径一致（宁可多提示一次，不要崩了才知道）。
 *
 * 判文件夹的条件必须与 pickSaveTarget 的 ZIP 分支逐字一致，否则这个估算会
 * 系统性偏低。filesink.test.ts 里有一条用例真跑 pickSaveTarget 比对 label。
 */
export function memoryPeakBytes(files: FileMetaLite[], totalBytes: number): number {
  return files.some((f) => f.path && f.path.includes("/")) ? totalBytes * 2 : totalBytes;
}

/**
 * 开始接收/下载这一批文件之前，要不要先提示内存风险。
 *
 * 阈值只有 LARGE_DOWNLOAD_WARN_BYTES 一个，而且它比的是**估算峰值**而不是批次
 * 总量 —— 这样 ZIP 分支的 2× 不需要第二个常量就能被算进去。两个都是没实测过的
 * 估计值，再拆一个只是多一个同样没底的数字。
 */
export function warnsAboutMemory(files: FileMetaLite[], totalBytes: number, opts: SaveOptions = {}): boolean {
  if (canStreamToDisk(files.length, opts)) return false;
  return memoryPeakBytes(files, totalBytes) > LARGE_DOWNLOAD_WARN_BYTES;
}

function nativeSink(writable: FsWritable): FileSink {
  return { write: (c) => writable.write(c), close: () => writable.close() };
}

/** Split a filename into base + extension, keeping the dot with the extension.
 *  A leading dot (dotfile) or no dot means the whole name is the base. */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/** First non-colliding variant of `name` given a `taken` predicate: returns the
 *  name as-is if free, otherwise "base (1).ext", "base (2).ext", … Pure/testable. */
export function nextAvailableName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const { base, ext } = splitExtension(name);
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

// Fallback: buffer in memory, download as a Blob on close. Memory-bound — fine for
// small files on Firefox/Safari, which lack the File System Access API.
function blobSink(name: string): FileSink {
  const parts: Uint8Array[] = [];
  return {
    write: async (chunk) => { parts.push(chunk); },
    close: async () => download(new Blob(parts as BlobPart[]), name),
  };
}

/**
 * Open a save destination for a batch. MUST be called from a user gesture
 * (e.g. a click handler) so the underlying picker is allowed to open.
 *
 * - 1 file + File System Access API → a familiar "Save As" dialog, streamed to disk.
 * - >1 file + API → one directory picker; files stream into the chosen folder.
 * - 1 file + opts.swStream + a SW that owns this page → streamed to disk via the SW.
 * - No API (Firefox/Safari) → in-memory Blob, downloaded per file on completion.
 */
export async function pickSaveTarget(files: FileMetaLite[], opts: SaveOptions = {}): Promise<SaveTarget> {
  const w = window as unknown as SavePickerWindow;

  if (files.length === 1 && w.showSaveFilePicker) {
    // Open the Save As dialog now, while the gesture is live.
    const handle = await w.showSaveFilePicker({ suggestedName: files[0].name });
    const writable = await handle.createWritable();
    const sink = nativeSink(writable);
    let used = false;
    return {
      label: "已选择保存位置",
      file: async () => {
        if (used) throw new Error("single-file target already consumed");
        used = true;
        return sink;
      },
    };
  }

  if (w.showDirectoryPicker) {
    // Grant folder access now; per-file handles afterwards need no further gesture.
    const root = await w.showDirectoryPicker();
    // Never silently clobber: dedupe both against files already on disk and
    // against earlier files in this same batch ("name (1).ext", "name (2).ext", …).
    // Dedup is scoped per destination directory, keyed by full relative path.
    const claimed = new Set<string>();
    const existsInDir = async (d: FsDirHandle, n: string): Promise<boolean> => {
      try {
        await d.getFileHandle(n, { create: false });
        return true;
      } catch {
        return false;
      }
    };
    // Resolve (creating as needed) the nested subdirectory a relative path lives in.
    const dirFor = async (segments: string[]): Promise<FsDirHandle> => {
      let d = root;
      for (const seg of segments) d = await d.getDirectoryHandle(seg, { create: true });
      return d;
    };
    return {
      label: "已选择目标文件夹",
      file: async (name, _size, path) => {
        // safeSegments drops any ".."/absolute components so a hostile peer
        // path can't escape the chosen directory (matches the ZIP sink).
        const segs = safeSegments(path || name);
        const base = segs.pop() ?? name;
        const dir = segs.length ? await dirFor(segs) : root;
        const prefix = segs.join("/");
        const key = (n: string) => (prefix ? `${prefix}/${n}` : n);
        // Resolve claimed-in-batch synchronously, then probe the folder; loop in
        // case a probed variant is itself already on disk.
        let unique = nextAvailableName(base, (n) => claimed.has(key(n)));
        while (await existsInDir(dir, unique)) {
          claimed.add(key(unique)); // force the next candidate past this on-disk name
          unique = nextAvailableName(base, (n) => claimed.has(key(n)));
        }
        claimed.add(key(unique));
        const fh = await dir.getFileHandle(unique, { create: true });
        return nativeSink(await fh.createWritable());
      },
    };
  }

  // 没有 File System Access API，但 SW 在管着这一页：让 SW 造一个流式响应，
  // 浏览器边收边写盘。这条排在目录选择器**之后**有两个理由：原生句柄那条路不
  // 依赖 SW 生命周期（空闲回收、部署换版都能掐断 SW 流），可靠性更高；而且插到
  // 前面会把「只有 showDirectoryPicker + 单文件」这个组合从既有分支上抢走，等于
  // 改了现有分支的行为。所以这条只服务真正没有 FSA 的浏览器——Firefox / Safari /
  // 所有手机，也正是这一步想覆盖的人群。
  //
  // 只接单文件：SW 流是一条字节流，多文件仍走目录句柄或 ZIP。单文件即使带着
  // 文件夹路径也走这里，落盘就是那个文件本身（丢掉一层只有它自己的目录）——
  // 比为了一个文件打一个 ZIP 更接近用户想要的东西。
  //
  // opts.swStream 是显式开关，只有下载页打开；实时接收路（App.svelte）一律走不到
  // 这里，理由见 SaveOptions 的注释（ack ≠ 已落盘，与那条路的 durability 语义冲突）。
  if (files.length === 1 && opts.swStream && swStreamReady()) {
    try {
      const sink = await openSwStream(files[0].name, contentDisposition(files[0].name));
      let used = false;
      return {
        label: "将流式下载到默认下载目录",
        file: async () => {
          if (used) throw new Error("single-file target already consumed");
          used = true;
          return sink;
        },
      };
    } catch {
      // 握手没成（SW 刚被换掉/回收）。别把下载弄死，落到下面的内存分支——
      // 代价只是本该无提示的一次下载吃了内存。
    }
  }

  // No File System Access API (Firefox/Safari). A folder send can't stream to
  // disk here, and per-file downloads would lose the tree, so bundle the batch
  // into one ZIP that preserves paths. Flat batches keep per-file downloads.
  if (files.some((f) => f.path && f.path.includes("/"))) {
    const zip = new ZipWriter();
    const topDir = files.find((f) => f.path?.includes("/"))!.path!.split("/")[0];
    return {
      label: "将打包为 ZIP 下载",
      file: async (name, _size, path) => {
        const parts: Uint8Array[] = [];
        return {
          write: async (c) => { parts.push(c); },
          close: async () => { zip.add(path || name, concat(parts)); },
        };
      },
      done: async () => download(zip.finish(), `${topDir || "relayium"}.zip`),
    };
  }
  return {
    label: "将逐个下载到默认下载目录",
    file: async (name) => blobSink(name),
  };
}

/** Concatenate chunks into one contiguous buffer (the ZIP writer stores whole files). */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Trigger a browser download of a blob under the given filename.
 *
 * This is the *only* download path on Firefox/Safari/mobile (no File System
 * Access API, no SW stream), so two details are load-bearing rather than
 * cosmetic:
 *  - the anchor must be in the document. Firefox ignores programmatic clicks on
 *    a detached anchor.
 *  - the object URL must outlive the click. Starting a download is async; a
 *    synchronous revoke races it and the download fails with nothing on screen.
 *    The delay is the browser's window to latch the blob, after which we still
 *    free it — a leaked object URL pins the whole file in memory.
 */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
