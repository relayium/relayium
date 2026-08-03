<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fetchMeta, downloadBlob, parseDownloadKey, keyFromFragment, DownloadNetworkError, InvalidStoredObjectIdError } from "./stored-file";
  import { decryptManifest, type StoredManifest } from "./store-crypto";
  import { pickSaveTarget, warnsAboutMemory, LARGE_DOWNLOAD_WARN_BYTES, SaveCancelledError, SinkCancelledError, SinkTransportError, type SaveOptions, type SaveTarget, type FileSink } from "./filesink";
  import { lang, setLang, LANGS, messages, legalUrl, type Lang, type Messages } from "./i18n.svelte";
  import { holdRefresh } from "./app-update.svelte";
  import ThemeSelect from "./ThemeSelect.svelte";
  import { formatRemaining, formatSize } from "./format";
  import { safeSegments } from "./zip";

  let { id }: { id: string } = $props();

  const t = $derived<Messages>(messages[lang()]);

  type PageState = "loading" | "ready" | "downloading" | "done" | "error";
  let pageState: PageState = $state("loading");
  let errKey: "notFound" | "noKey" | "decryptFail" | "unsupported" | "netFail" | "cancelled" | "swFail" | "" = $state("");

  /**
   * 下载页是**唯一**打开 service worker 流式落盘的地方。
   *
   * 这条路让没有 File System Access API 的浏览器（Firefox / Safari / 所有手机）
   * 也能把大文件边收边写盘，而不是整份堆进内存。实时接收路（App.svelte）刻意不开：
   * 那边的「已 ack」被当成 durability 信号回给发送端，而 SW 的 ack 只代表字节进了
   * ReadableStream，不代表落盘。理由详见 filesink.ts 的 SaveOptions。
   */
  const SAVE_OPTS: SaveOptions = { swStream: true };
  let manifest = $state<StoredManifest | null>(null);
  let key: CryptoKey | null = null;
  let progress = $state(0); // 0..100
  let expiresAt = $state(0); // unix seconds; 0 until meta loads
  let burnAfterRead = $state(false);
  let now = $state(Math.floor(Date.now() / 1000)); // ticks so the countdown stays live

  let ticker: ReturnType<typeof setInterval> | undefined;
  onMount(async () => {
    ticker = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000);
    if (!window.isSecureContext || !crypto.subtle) { pageState = "error"; errKey = "unsupported"; return; }
    const k = parseDownloadKey(location.hash);
    // Scrub the key from the URL as soon as it's read: #k= is the zero-knowledge
    // decryption secret and must not linger in the address bar, browser history,
    // or any Referer header sent on a later navigation. It's already captured in k.
    if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    if (!k) { pageState = "error"; errKey = "noKey"; return; }
    try {
      const meta = await fetchMeta(id);
      expiresAt = meta.expiresAt;
      burnAfterRead = meta.burnAfterRead;
      key = await keyFromFragment(k);
      manifest = await decryptManifest(key, base64ToBytes(meta.encManifest));
      pageState = "ready";
    } catch (e) {
      pageState = "error";
      errKey = isRefusedLink(e) ? "notFound" : "decryptFail";
    }
  });
  onDestroy(() => clearInterval(ticker));

  function isNotFound(e: unknown): boolean {
    return e instanceof Error && /\b404\b/.test(e.message);
  }
  /**
   * 「这条链接指不向任何东西」的两种说法，归成同一句文案。
   *
   * 404 是服务端说的；InvalidStoredObjectIdError 是 stored-file 在发请求**之前**
   * 说的——链接里的那个 id 是 Relayium 根本不可能签发的形状。后者以前落进 else
   * 分支，被说成「密钥错误或文件损坏」：那句话在指控用户的密钥或这份文件，而真相
   * 是一个字节都没取、密钥一次都没用上。两者用户能做的事完全一样（换一条链接，
   * 找发件人重发），所以同一句话；也都不给重试——同一个 id 只会被同样地拒掉。
   */
  function isRefusedLink(e: unknown): boolean {
    return isNotFound(e) || e instanceof InvalidStoredObjectIdError;
  }
  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const totalBytes = $derived(manifest ? manifest.files.reduce((n, f) => n + f.size, 0) : 0);
  const secLeft = $derived(expiresAt > 0 ? expiresAt - now : 0);
  // A link that lapses while the tab is open. Gated to the "ready" state in the
  // template so it can't interrupt an in-flight download.
  const expired = $derived(expiresAt > 0 && secLeft <= 0);

  // 内存提示已经显示，等用户决定继续还是换个浏览器。
  let memWarn = $state(false);

  async function download() {
    await startDownload(false);
  }

  /**
   * 下载页是唯一同时知道「总共多大」和「这个浏览器能不能流式落盘」的地方，
   * 而且这两件事在下载开始之前就已经知道。没有流式能力（Firefox/Safari/所有
   * 手机浏览器）时整个文件必须先攒进内存，接收方却从来没参与决定文件多大 ——
   * 所以在按下下载之后、真正取字节之前先说一声。
   *
   * 这是提示不是硬拦：桌面 Firefox 上内存管够的用户比我们更清楚自己的情况，
   * 给一个明确的「仍要下载」（force=true）。默认不继续。
   */
  async function startDownload(force: boolean) {
    if (!manifest || !key) return;
    // warnsAboutMemory 而不是手写的同一条件：文件夹清单现在会走 ZIP 分支，峰值约
    // 2× 批次总量，而 memoryPeakBytes 正是按 pickSaveTarget 的分支逐字算这个的。
    // 手写版对扁平批次结果完全一样，只有文件夹会（正确地）更早提示。
    if (!force && warnsAboutMemory(saveSpecs, totalBytes, SAVE_OPTS)) {
      memWarn = true;
      return; // 一个字节都还没取
    }
    memWarn = false;
    // 从这里到这个函数结束是「刷新会毁掉东西」的那一段：保存位置一旦选好、字节一旦
    // 开始落，刷新就等于把这次下载整个丢掉从零再来。全站更新提示条据此禁用刷新按钮
    // （见 app-update 的 holdRefresh）——这条路完全在 workspace 之外，warnsOnLeave
    // 看不见它。**只显示内存提示的那次早退不占闸门**：那时候一个字节都还没取。
    const releaseRefresh = holdRefresh();
    try {
      await runDownload();
    } finally {
      releaseRefresh();
    }
  }

  /**
   * 拿一个文件的写入端。失败（blobSink 构造、ZIP writer、目录句柄）归成
   * SinkTransportError：字节一个都没错，只是没地方落，和 SW 落盘故障是同一类，
   * 下面的归因会把它说成可重试的保存问题，而不是「密钥错误或文件损坏」。
   */
  async function openSink(t: SaveTarget, i: number): Promise<FileSink> {
    try {
      const spec = saveSpecs[i];
      return await t.file(spec.name, spec.size, spec.path);
    } catch (e) {
      throw new SinkTransportError(`could not open a save sink: ${(e as Error)?.message ?? "unknown"}`);
    }
  }

  /**
   * 存储清单没有 path 字段（它是冻结的，密文有金标向量钉着），文件夹层级就写在
   * `name` 里，形如 "trip/day1/a.txt" —— Go CLI 的 walkUploadPaths 一直是这么发的，
   * macOS 原生端现在也是。
   *
   * 这里把它拆成 filesink 认识的 {name(叶子), path(相对路径)}。之前整串 name 直接
   * 当文件名传下去：桌面目录句柄那条路碰巧还对（它自己 safeSegments(path || name)），
   * 但 Firefox/Safari/手机那条路 `f.path` 恒为 undefined，于是判不出这是文件夹，
   * 逐个 blob 下载 —— 层级在最后一步丢光。拆开之后这批会走 ZIP，树完整保留。
   */
  const saveSpecs = $derived(
    (manifest?.files ?? []).map((f) => {
      const segs = safeSegments(f.name);
      return {
        name: segs[segs.length - 1] ?? f.name,
        size: f.size,
        path: segs.length > 1 ? segs.join("/") : undefined,
      };
    }),
  );

  /** startDownload 的破坏性那一段。单独拆出来只为让 holdRefresh 的释放落在一个
   *  finally 上，而不用给下面每一条 return / catch 各补一次。 */
  async function runDownload() {
    if (!manifest || !key) return;
    let target: SaveTarget;
    try {
      target = await pickSaveTarget(saveSpecs, SAVE_OPTS);
    } catch (e) {
      // 用户自己取消保存位置：什么都没发生，回到按钮那一屏就是最诚实的表达。
      if (e instanceof SaveCancelledError) return;
      // 保存这一段用不了（选择器坏了，而这一批大到不能安全塞进内存）。这时静默
      // 返回会让用户看到「按了下载什么都没发生」；如实报出来并给重试入口。
      pageState = "error";
      errKey = "swFail";
      return;
    }
    pageState = "downloading";
    progress = 0;
    // Plaintext is the concatenation of all files; split by manifest sizes.
    let fileIdx = 0;
    let intoFile = 0;
    let sink: FileSink | null = null;
    try {
      // 第一个 sink 以前在 try **之外**：blobSink / ZIP / 目录句柄任何一个构造失败，
      // 异常都直接从这个函数逃出去，页面永远停在进度条上，一句话都不说（而且更新
      // 提示条的刷新闸门也跟着一直被占着）。openSink 把它归成保存故障，交给下面
      // 已有的归因：可重试，不是「密钥错误或文件损坏」。
      sink = manifest.files.length ? await openSink(target, 0) : null;
      await downloadBlob(
        id,
        key,
        async (pt: Uint8Array) => {
          let off = 0;
          while (off < pt.length && fileIdx < manifest!.files.length) {
            const remaining = manifest!.files[fileIdx].size - intoFile;
            const take = Math.min(remaining, pt.length - off);
            if (take > 0 && sink) { await sink.write(pt.subarray(off, off + take)); intoFile += take; off += take; }
            if (intoFile >= manifest!.files[fileIdx].size) {
              if (sink) await sink.close();
              fileIdx++;
              intoFile = 0;
              sink = fileIdx < manifest!.files.length ? await openSink(target, fileIdx) : null;
            }
          }
        },
        (received) => { progress = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : 0; },
      );
      // 把明文流没走到的清单条目补完。
      //
      // 上面那个回调**只在手里有字节时**推进 fileIdx：整个循环的条件是
      // `off < pt.length`。于是零字节文件只要后面没有别的字节来驱动循环，就永远
      // 不会被打开——密文流里根本没有它们的帧。两种真实形状：
      //
      //  * 整份清单都是零字节文件：downloadBlob 一次回调都不发，只有下载前预开的
      //    第 0 个 sink 存在，其余一个都没建；
      //  * 一个非空文件后面跟着两个以上零字节文件：最后一批字节把第 0 个文件收尾、
      //    开出第 1 个 sink，然后 off 到头、循环退出，第 2 个之后再没人建。
      //
      // 而 target.done() 照样跑、页面照样显示"完成"——用户拿到一个少了文件的
      // 文件夹，却被告知一切正常。
      //
      // 这一段只补**剩下的**条目：回调仍然负责关掉它自己写满的那些 sink，这里
      // 关的是回调留下的当前 sink 以及其后从未被打开过的尾部条目。每轮 close
      // 之后立刻置 null，下一轮用 ??= 新开一个，所以已经收尾的 sink 不会被
      // 二次 close；每轮必定 fileIdx++，循环必然终止。
      while (fileIdx < manifest.files.length) {
        sink ??= await openSink(target, fileIdx);
        // 走到这里还没写满的条目只可能是零字节的：downloadBlob 没拿到
        // expectedBytes 时会自己从加密清单算出明文总量，并在 resolve 之前用
        // StoreDecryptor.end(expected) 核对，对不上就抛。真出现就是字节数对不
        // 上，按"和链接描述的不一致"归因，绝不能默默产出一个空文件冒充它。
        if (manifest.files[fileIdx].size !== intoFile) {
          throw new Error(
            `manifest entry ${fileIdx} expected ${manifest.files[fileIdx].size} bytes, got ${intoFile}`,
          );
        }
        await sink.close();
        sink = null;
        fileIdx++;
        intoFile = 0;
      }
      // 收尾这一批。ZIP 分支要靠它把整个 zip 拼出来并触发下载；流式分支没有 done。
      // 少了这一步，打包下载会静默地什么都不产出，而页面照样显示"完成"。
      // 必须排在上面的 while 之后：done 的含义是"每个文件都已经 close 了"。
      await target.done?.();
      pageState = "done";
    } catch (e) {
      pageState = "error";
      // 用户自己取消下载不是故障，更不是"密钥错误或文件损坏"——如实说。
      // 掉线可重试；SW 落盘那一段出问题也可重试（字节一个都没错，只是没交到磁盘）；
      // 只有真正的解密/完整性失败才配得上那句"密钥错误或文件损坏"。
      if (e instanceof SinkCancelledError) errKey = "cancelled";
      else if (e instanceof SinkTransportError) errKey = "swFail";
      // downloadBlob 是自己的信任边界（调用方给了 expectedBytes 时它连 meta 都不查），
      // 所以拒绝也可能在这里才发生 —— 同样不是「密钥错误或文件损坏」。只认这一种，
      // 不顺手把 404 也并进来：取字节阶段的 404 归因是另一件事，本次不动。
      else if (e instanceof InvalidStoredObjectIdError) errKey = "notFound";
      else errKey = e instanceof DownloadNetworkError ? "netFail" : "decryptFail";
    }
  }

</script>

<header class="dlnav">
  <a class="brand" href="/"><span class="mark" aria-hidden="true">⇌</span><span class="word">Relayium</span></a>
  <select
    class="lang"
    aria-label={t.langLabel}
    value={lang()}
    onchange={(e) => setLang((e.currentTarget as HTMLSelectElement).value as Lang)}
  >
    {#each LANGS as l (l.code)}
      <option value={l.code}>{l.label}</option>
    {/each}
  </select>
  <ThemeSelect />
</header>

<main class="dl">
  {#if pageState === "loading"}
    <p>{t.download.loading}</p>
  {:else if pageState === "error"}
    <p class="error">
      {#if errKey === "notFound"}{t.download.notFound}
      {:else if errKey === "noKey"}{t.download.noKey}
      {:else if errKey === "unsupported"}{t.download.unsupported}
      {:else if errKey === "netFail"}{t.download.netFail}
      {:else if errKey === "swFail"}{t.download.swFail}
      {:else if errKey === "cancelled"}{t.download.cancelled}
      {:else}{t.download.decryptFail}{/if}
    </p>
    <!-- 传输类故障（掉线 / SW 落盘中断）和用户主动取消都可以原地重来；
         只有 decryptFail / notFound / noKey / unsupported 重试没有意义。 -->
    {#if (errKey === "netFail" || errKey === "swFail" || errKey === "cancelled") && manifest}
      <button class="btn btn-primary" onclick={download}>{t.download.retry}</button>
    {/if}
  {:else if pageState === "ready" && expired}
    <p class="error">{t.download.notFound}</p>
  {:else}
    <div class="head">
      <h2>{t.download.files}</h2>
      {#if manifest}
        <span class="summary">{t.download.summary(manifest.files.length, formatSize(totalBytes))}</span>
      {/if}
    </div>
    <ul class="filelist">
      {#each manifest?.files ?? [] as f}
        <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
      {/each}
    </ul>

    {#if expiresAt > 0}
      <p class="expiry" class:soon={secLeft < 3600}>⏳ {t.download.expiresIn(formatRemaining(secLeft, t.download.durUnits))}</p>
    {/if}

    <p class="trust">{t.download.zeroKnowledge}</p>
    {#if burnAfterRead}
      <p class="burn">{t.download.burnWarning}</p>
    {/if}

    {#if pageState === "downloading"}
      <div class="progress-bar" role="progressbar" aria-label={t.download.downloading} aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style:width="{progress}%"></div></div>
      <!-- 不加 aria-live：百分比每块都在变，读屏会被刷屏（进度本身已由上面的
           role="progressbar" + aria-valuenow 如实传达）。aria-live 只留给状态切换。 -->
      <p>{t.download.downloading} {progress}%</p>
    {:else if pageState === "done"}
      <p class="ok">{t.download.done}</p>
    {:else if memWarn}
      <div class="memwarn" role="alert">
        <p>{t.download.memWarn(formatSize(totalBytes))}</p>
        <p class="how">{t.download.memWarnHow}</p>
        <button class="btn btn-ghost" onclick={() => startDownload(true)}>{t.download.memWarnContinue}</button>
      </div>
    {:else}
      <button class="btn btn-primary" onclick={download}>{t.download.downloadBtn}</button>
    {/if}
  {/if}

  <section class="sendcta">
    <span>{t.download.sendPrompt}</span>
    <a href="/">{t.download.sendCta}</a>
  </section>

  <footer>
    <a href={legalUrl("security", lang())}>{t.legal.security}</a>
    <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
    <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
  </footer>
</main>

<style>
  .dlnav {
    width: 560px; max-width: 100%; margin: 0 auto;
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-4) var(--space-5) 0;
  }
  .brand { display: inline-flex; align-items: center; gap: var(--space-2); margin-inline-end: auto; text-decoration: none; color: var(--text-h); font-weight: 600; }
  .brand .mark {
    width: 28px; height: 28px; line-height: 28px; text-align: center;
    border-radius: var(--radius-sm); color: #fff; font-size: var(--fs-body);
    background: var(--grad-accent);
  }
  .brand .word { font-size: var(--fs-body); letter-spacing: -0.4px; }
  .lang {
    font: inherit; font-size: var(--fs-xs); padding: 5px 28px 5px 10px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .lang:hover { border-color: var(--accent-border); }

  .dl { width: 560px; max-width: 100%; margin: 0 auto; padding: var(--space-5) var(--space-5) var(--space-7); text-align: start; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); margin: var(--space-2) 0 var(--space-3); }
  .dl h2 { font-size: var(--fs-h3); margin: 0; }
  .summary { font-size: var(--fs-xs); color: var(--text); white-space: nowrap; }
  .filelist { list-style: none; margin: 0 0 var(--space-4); padding: 0; }
  .filelist li { display: flex; justify-content: space-between; gap: var(--space-3); padding: 7px 0; border-bottom: 1px dashed var(--border); }
  .fname { color: var(--text-h); word-break: break-all; }
  .fsize { color: var(--text); white-space: nowrap; }

  .expiry { font-size: var(--fs-xs); color: var(--text); margin: 0 0 var(--space-3); }
  .expiry.soon { color: var(--accent-fg); font-weight: 500; }
  .trust {
    font-size: var(--fs-xs); line-height: 1.55; color: var(--text-h);
    margin: 0 0 var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm);
    background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  .burn {
    font-size: var(--fs-xs); line-height: 1.55; color: var(--text-h);
    margin: 0 0 var(--space-4); padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm);
    background: var(--code-bg); border: 1px solid var(--accent-border);
  }

  .memwarn {
    font-size: var(--fs-xs); line-height: 1.55; color: var(--text-h);
    margin: 0 0 var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm);
    background: var(--code-bg); border: 1px solid var(--danger);
  }
  .memwarn p { margin: 0 0 var(--space-2); }
  .memwarn .how { color: var(--text); }
  .error { color: var(--danger); } .ok { color: var(--ok); }

  .sendcta {
    margin-top: var(--space-7); padding: var(--space-4); border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-2);
    display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
    font-size: var(--fs-xs); color: var(--text);
  }
  .sendcta a { color: var(--accent-fg); text-decoration: none; font-weight: 500; white-space: nowrap; }
  .sendcta a:hover { text-decoration: underline; }

  footer { margin-top: var(--space-5); display: flex; gap: var(--space-4); font-size: 12.5px; }
  footer a { color: var(--text-h); text-decoration: none; }
</style>
