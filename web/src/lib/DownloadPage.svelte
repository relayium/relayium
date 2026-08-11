<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fetchMeta, parseDownloadKey, keyFromFragment, DownloadNetworkError, InvalidStoredObjectIdError, StoredDownloadHttpError } from "./stored-file";
  import { decryptManifest, type StoredManifest } from "./store-crypto";
  import { pickSaveTarget, warnsAboutMemory, LARGE_DOWNLOAD_WARN_BYTES, SaveCancelledError, SinkCancelledError, SinkTransportError, type SaveOptions, type SaveTarget } from "./filesink";
  import { lang, setLang, LANGS, messages, legalUrl, type Lang, type Messages } from "./i18n.svelte";
  import { holdRefresh } from "./app-update.svelte";
  import ThemeSelect from "./ThemeSelect.svelte";
  import { formatRemaining, formatSize } from "./format";
  import { storedSaveSpecs, writeStoredObject } from "./stored-download";
  import CommandBlock from "./CommandBlock.svelte";
  import { RELEASE_PAGE_URL, downCommand, storedLink, tempDownloaderScript, windowsTempDownloaderScript } from "./temp-downloader";

  let { id }: { id: string } = $props();

  const t = $derived<Messages>(messages[lang()]);

  type PageState = "loading" | "ready" | "downloading" | "done" | "error";
  type ErrKey =
    | "notFound" | "noKey" | "decryptFail" | "unsupported"
    | "netFail" | "cancelled" | "swFail" | "limited" | "unavailable" | "";
  let pageState: PageState = $state("loading");
  let errKey: ErrKey = $state("");

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
  /**
   * onMount 读到的那把 #k=，原样留在内存里。
   *
   * 地址栏里的那份在读到的下一行就被 history.replaceState 抹掉了（零知识密钥不能
   * 留在历史记录和 Referer 里），所以**页面活着的这段时间里这是唯一一份**。元数据
   * 那一步失败时的重试全靠它：再去读一次 location.hash 只会拿到空串，把用户从
   * 「网络故障，可以重试」踢进「链接不完整」，而且再也回不来；location.reload 同理
   * ——重新加载的那条 URL 已经没有密钥了。
   *
   * 用 $state 而不是普通 let：重试按钮的显示条件要读它。
   */
  let fragKey = $state("");
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
    fragKey = k;
    await loadMeta();
  });
  onDestroy(() => clearInterval(ticker));

  /** 读元数据、解出清单，走到「可以下载」那一屏。重试也走这里，所以它不读地址栏
   *  ——密钥从 fragKey 来（见那里的注释）。先把状态打回 loading：错误屏连同重试
   *  按钮一起消失，用户点不出第二次，也就不会有两个并发的元数据请求。 */
  async function loadMeta() {
    pageState = "loading";
    errKey = "";
    try {
      const meta = await fetchMeta(id);
      expiresAt = meta.expiresAt;
      burnAfterRead = meta.burnAfterRead;
      key = await keyFromFragment(fragKey);
      manifest = await decryptManifest(key, base64ToBytes(meta.encManifest));
      pageState = "ready";
    } catch (e) {
      pageState = "error";
      errKey = classifyError(e);
    }
  }

  /** 重试按下之后该重做哪一步：清单还没读出来就重读元数据，读出来了就重取字节。
   *  两条路都在页面内完成 —— 不重新加载，因为那条 URL 上的 #k= 早就没了。
   *
   *  两条路都**先**同步离开错误屏，然后才 await 任何东西：错误屏连同重试按钮一起
   *  消失，用户点不出第二次；而且下载真要在取字节之前停下来问一句（大文件 + 不能
   *  流式落盘的浏览器要弹内存提示），那一屏是长在非 error 分支里的 —— 停在 error
   *  上就等于「点了重试什么都没发生」，用户只会以为自己没点中。 */
  async function retry() {
    if (manifest === null || key === null) { await loadMeta(); return; } // loadMeta 自己会打回 loading
    pageState = "ready";
    errKey = "";
    await download();
  }

  /**
   * 「这条链接指不向任何东西」的两种说法，归成同一句文案。
   *
   * 404 是服务端说的——链接曾经指向的那份东西现在不在了：TTL 到了、别的接收方
   * burn 掉了、或者 GC 正好跑在读完 meta 和取字节之间。InvalidStoredObjectIdError
   * 是 stored-file 在发请求**之前**说的——链接里的那个 id 是 Relayium 根本不可能
   * 签发的形状。两者用户能做的事完全一样（换一条链接，找发件人重发），所以同一句
   * 话；也都不给重试——文件不会自己回来，同一个 id 也只会被同样地拒掉。
   *
   * 只认结构化的 404，不再拿正则搜 message。正则那版只在加载阶段说得对：取字节
   * 阶段压根不问它，一次「文件已经不在了」被说成「密钥错误或文件损坏」——在指控
   * 用户的密钥和这份文件。而且它两头都不牢：改一句措辞就漏掉真 404，「offset 404」
   * 这类解密诊断又会被当成链接失效，可那正是唯一该让用户去查密钥的场合。
   * 403/429/5xx 同样是类型化的响应失败，但它们不是「不在了」——各自的归因见
   * classifyError。
   */
  function isRefusedLink(e: unknown): boolean {
    return (e instanceof StoredDownloadHttpError && e.status === 404)
      || e instanceof InvalidStoredObjectIdError;
  }

  /**
   * 一次失败该说哪句话 —— 加载阶段和取字节阶段共用这一个判据。
   *
   * 两个阶段以前各写各的 if 链，而且加载阶段那条只有两个分支（404 / 其它），于是
   * 「服务端在读密文之前就答了个状态码」和「密钥错误或文件损坏」被混成一句话。那句
   * 话是这一页最重的指控：它说收件人手里的密钥不对，或者这份文件坏了。可 429（限流
   * 或发件人流量用尽）、最终 403、5xx、以及请求压根没发出去这四种，全都发生在
   * StoreDecryptor 拿到第一个字节**之前** —— 密钥一次都没用上，指控它没有任何依据。
   *
   * 排序是有讲究的：先认最具体的类型，最后才落到 decryptFail。decryptFail 是**兜底**
   * 而不是某一类错误的名字，所以它必须排在最后，且只接住真正没被认出来的东西。
   */
  function classifyError(e: unknown): ErrKey {
    if (e instanceof SinkCancelledError) return "cancelled";
    if (e instanceof SinkTransportError) return "swFail";
    // 这条链接指不向任何东西：404 或者一个 Relayium 不可能签发的 id。
    if (isRefusedLink(e)) return "notFound";
    if (e instanceof StoredDownloadHttpError) {
      // 429 只有一个状态码，背后却是两个闸门：per-IP 的下载起始限流，和发件人账号的
      // 月流量上限。服务端**只在英文响应体里**区分它们，而按那段文本分流等于把归因
      // 钉死在一句服务端文案上 —— 改一个词前端就错。一句话覆盖两者，不给立即重试。
      if (e.status === 429) return "limited";
      // 剩下的结构化失败（最终 403、5xx）：服务端/存储侧暂时不可用，可重试。
      // downloadBlob 已经替一次性直连令牌做过它那唯一一次 403 重放，走到这里的 403
      // 是真的被拒了。
      return "unavailable";
    }
    if (e instanceof DownloadNetworkError) return "netFail";
    return "decryptFail";
  }

  /** 能在这一页原地重来的失败。429 刻意不在里面：那个按钮除了把同一个闸门撞得更响
   *  什么也做不到。notFound / noKey / unsupported / decryptFail 重试同样没有意义。 */
  const RETRYABLE: readonly ErrKey[] = ["netFail", "swFail", "cancelled", "unavailable"];
  // fragKey 是闸门的另一半：没有密钥就没有可以重做的事（noKey / unsupported 那两屏
  // 根本没走到读密钥这一步）。不必再判 pageState —— 这个按钮只长在模板的 error
  // 分支里面，而 errKey 只和 pageState = "error" 同时被写。
  const canRetry = $derived(RETRYABLE.includes(errKey) && fragKey !== "");
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

  /**
   * 已经有一次下载在跑了。
   *
   * 点下载到 pageState 变成 "downloading" 之间隔着一整个 `await pickSaveTarget`
   * ——「保存到哪里」的对话框开着的那段时间里，按钮还长在「就绪」那一屏上原地没动。
   * 手快点两下（或者点完没反应又补一下）就会开出**两次**下载：两个保存目标、两条
   * 各自往同一批 sink 里写的字节流、两个 holdRefresh 闸门。第二个闸门永远放不掉的
   * 那一半更糟——全站更新提示条的刷新按钮就此一直是灰的，而页面看上去完全正常。
   *
   * 装在 startDownload 这个公共边界上，所以三个入口（下载按钮、「仍要下载」、重试）
   * 都被同一道闸门挡住。必须**同步**置位：任何 await 之后再置就还留着同一个窗口。
   * 普通 let 而不是 $state：模板不读它，它只负责让第二次调用当场返回。
   */
  let downloadInFlight = false;

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
    if (downloadInFlight) return; // 见 downloadInFlight：第二下当场丢掉
    // warnsAboutMemory 而不是手写的同一条件：文件夹清单现在会走 ZIP 分支，峰值约
    // 2× 批次总量，而 memoryPeakBytes 正是按 pickSaveTarget 的分支逐字算这个的。
    // 手写版对扁平批次结果完全一样，只有文件夹会（正确地）更早提示。
    if (!force && warnsAboutMemory(saveSpecs, totalBytes, SAVE_OPTS)) {
      memWarn = true;
      return; // 一个字节都还没取——闸门还没置位，紧接着的「仍要下载」才进得来
    }
    memWarn = false;
    // 同步置位，且**在第一个 await 之前** —— 这一行往下再没有第二次能进来。
    downloadInFlight = true;
    // 从这里到这个函数结束是「刷新会毁掉东西」的那一段：保存位置一旦选好、字节一旦
    // 开始落，刷新就等于把这次下载整个丢掉从零再来。全站更新提示条据此禁用刷新按钮
    // （见 app-update 的 holdRefresh）——这条路完全在 workspace 之外，warnsOnLeave
    // 看不见它。**只显示内存提示的那次早退不占闸门**：那时候一个字节都还没取。
    const releaseRefresh = holdRefresh();
    try {
      await runDownload();
    } finally {
      // 两个闸门在同一个 finally 里一起放：选择器取消、选择器失败、下载成功、下载
      // 失败，以及 runDownload 万一漏出来的抛出，走的都是这里。漏放一次这一页的
      // 下载能力就永久废掉了（而且看不出来：按钮还在，点了没反应）。
      releaseRefresh();
      downloadInFlight = false;
    }
  }

  /** The manifest's entries as the save layer wants them — see storedSaveSpecs,
   *  which owns the "the folder tree lives inside `name`" rule for every caller. */
  const saveSpecs = $derived(storedSaveSpecs(manifest ?? { files: [] }));

  // ── 终端那条路 ───────────────────────────────────────────────────────────
  //
  // 浏览器下载之外的两条：装了 CLI 的一行命令，和「无需持久安装」的可见序列。
  // 三件事必须同时成立，缺一条这一段就不该存在：
  //
  //  1. 完整链接是在这里**重新拼出来**的。地址栏里的 #k= 在 onMount 第一行就被
  //     抹掉了，fragKey 是页面活着这段时间里仅存的一份（见那里的注释）。
  //  2. 拼出来的链接只进入命令文本和剪贴板 —— 绝不能变成 href / src / fetch 的
  //     一部分。一旦进了地址，它就会以 Referer、access log、CDN 日志的形式离开
  //     这台机器，零知识承诺当场作废。dest 也一样是本地字符串，不发给任何人。
  //  3. 引号由 shQuote 上，不是模板字符串顺手加的一对单引号：链接里的 #
  //     不加引号会被当成注释起点，密钥连同后半段一起被 shell 吃掉。
  //
  // 这一段只在 fragKey 非空时渲染 —— 没有密钥的那两屏（noKey / unsupported）
  // 本来也拼不出可用的命令，给一条缺密钥的命令只会让用户在终端里再失败一次。
  let dest = $state(".");
  const fullLink = $derived(
    fragKey ? storedLink(typeof location === "undefined" ? "" : location.origin, id, fragKey) : "",
  );
  const installedCmd = $derived(fullLink ? downCommand(fullLink, dest) : "");
  const tempScript = $derived(fullLink ? tempDownloaderScript({ link: fullLink, dest }) : "");
  const windowsScript = $derived(fullLink ? windowsTempDownloaderScript(fullLink, dest) : "");

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
    try {
      // The whole "plaintext is the concatenation, split it by the manifest"
      // job — including the zero-byte tail and the sink-open failure mode —
      // lives in stored-download.ts, shared with the pre-upload receiver so the
      // two cannot drift. Classification of whatever it throws stays here.
      await writeStoredObject({
        id,
        key,
        manifest,
        target,
        specs: saveSpecs,
        onProgress: (received) => {
          progress = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : 0;
        },
      });
      pageState = "done";
    } catch (e) {
      pageState = "error";
      // 和加载阶段同一个 classifyError。这一段是每一条归因的第二个入口：清单读出来
      // 了、文件列表都显示了，故障才发生 —— 对象在按下下载的那一刻没了（TTL 到期、
      // 被别的接收方 burn、GC 撞上）、限流闸门落下、节点正在重启、用户自己取消。
      // 两个阶段共用一个判据，正是为了不让其中一边悄悄少认一类错误。
      errKey = classifyError(e);
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
      {:else if errKey === "limited"}{t.download.limited}
      {:else if errKey === "unavailable"}{t.download.unavailable}
      {:else}{t.download.decryptFail}{/if}
    </p>
    <!-- 传输类故障（掉线 / SW 落盘中断 / 服务端暂时不可用）和用户主动取消都可以
         原地重来；429 / decryptFail / notFound / noKey / unsupported 重试没有意义。
         按下之后 retry 会自己决定是重读元数据还是重取字节。 -->
    {#if canRetry}
      <button class="btn btn-primary" onclick={retry}>{t.download.retry}</button>
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

    <!-- 终端那条路。只在手里真有密钥时才出现 —— 没有 fragKey 就拼不出能用的
         命令，给一条缺密钥的命令等于让用户在终端里再失败一次。

         这里所有链接文本都只是**文本**：唯一的 <a> 指向 GitHub 发布页，而完整
         链接（含 #k=）只出现在 <code> 里和剪贴板里，从不出现在任何 href/src。
         DownloadPage.test.ts 逐个属性检查这件事。 -->
    {#if fragKey}
      <section class="terminal" aria-labelledby="dl-cli-heading">
        <h3 id="dl-cli-heading">{t.download.cli.heading}</h3>

        <div class="field">
          <label for="dl-cli-dest">{t.stored.cliDestLabel}</label>
          <!-- dir="ltr"：这是一个会被贴进命令里的路径，阿拉伯语页面里也必须按
               它真正的字节顺序显示，否则用户核对不了自己粘贴的是什么。 -->
          <input
            id="dl-cli-dest"
            type="text"
            dir="ltr"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            bind:value={dest}
          />
          <p class="hint">{t.stored.cliDestHint}</p>
        </div>

        <h4>{t.download.cli.installedTitle}</h4>
        <p>{t.download.cli.installedIntro}</p>
        <CommandBlock
          code={installedCmd}
          title="relayium down"
          copyLabel={t.stored.cliCopy}
          copiedLabel={t.stored.copied}
          copyAria="{t.stored.cliCopy}: relayium down"
        />

        <h4>{t.download.cli.tempTitle}</h4>
        <p>{t.download.cli.tempMeans}</p>
        <p class="curlnote">{t.download.cli.tempCurlNote}</p>
        <ol class="steps">
          {#each t.download.cli.steps as step, i (i)}
            <li>{step}</li>
          {/each}
        </ol>
        <div class="script">
          <CommandBlock
            code={tempScript}
            title="temporary · verified"
            copyLabel={t.stored.cliCopy}
            copiedLabel={t.stored.copied}
            copyAria="{t.stored.cliCopy}: {t.download.cli.tempTitle}"
          />
        </div>
        <p class="attest">{t.download.cli.verified}</p>
        <p class="attest">{t.download.cli.keyStaysLocal}</p>

        <h4>{t.download.cli.windowsTitle}</h4>
        <p>{t.download.cli.windowsNote}</p>
        <CommandBlock
          code={windowsScript}
          title="powershell · pinned SHA-256"
          copyLabel={t.stored.cliCopy}
          copiedLabel={t.stored.copied}
          copyAria="{t.stored.cliCopy}: {t.download.cli.windowsTitle}"
        />
        <p>
          <!-- noreferrer as well as noopener: the address bar no longer holds
               the fragment, but this is the one outbound navigation on the
               page and it costs nothing to make that independent of scrubbing. -->
          <a class="releases" href={RELEASE_PAGE_URL} target="_blank" rel="noopener noreferrer">
            {t.download.cli.releasesLink}
          </a>
        </p>
      </section>
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

  /* 终端那条路。
     窄屏是硬要求：这一段里最长的一行是 openssl 那条验签命令，比手机屏宽得多。
     命令块自己用 overflow-x 横向滚（见 CommandBlock 的 <pre>），所以这里只要
     保证外层容器**允许**自己被压窄 —— min-width: 0 就是那一条：网格/弹性子项
     的默认 min-width 是 auto，会被里面那条不换行的 <pre> 顶开，于是整页出现
     横向滚动条，文件列表和下载按钮一起被挤出屏幕。 */
  .terminal { margin-top: var(--space-7); min-width: 0; }
  .terminal h3 { font-size: var(--fs-h3); margin: 0 0 var(--space-2); }
  .terminal h4 {
    font-size: var(--fs-sm); font-weight: 600; color: var(--text-h);
    margin: var(--space-5) 0 var(--space-2);
  }
  .terminal p { font-size: var(--fs-xs); line-height: 1.6; color: var(--text); margin: 0 0 var(--space-3); }
  .terminal :global(.term) { margin-bottom: var(--space-3); min-width: 0; }

  .field { margin: 0 0 var(--space-4); }
  .field label { display: block; font-size: var(--fs-xs); color: var(--text-h); margin-bottom: 5px; }
  .field input {
    font: inherit; font-size: var(--fs-sm); font-family: var(--mono);
    width: 100%; box-sizing: border-box; padding: 7px 10px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--code-bg); color: var(--text-h);
  }
  .field input:focus { border-color: var(--accent-border); }
  .terminal p.hint { margin: 5px 0 0; }

  /* 「普通 curl 只能存密文」那句。它是这一段里唯一一句**否定**性的话，也是最容易
     被跳过的一句 —— 它必须看起来和步骤同级，而不是脚注。attest 是另外两句
     供应链断言，同样不能读成装饰性小字。 */
  .terminal p.curlnote, .terminal p.attest {
    color: var(--text-h);
    padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm);
  }
  .terminal p.curlnote { background: var(--code-bg); border: 1px solid var(--border); }
  .terminal p.attest { background: var(--accent-bg); border: 1px solid var(--accent-border); }
  /* 完整脚本三十多行。手机上它是一千多像素的等宽文字，会把后面的 Windows 指引和
     发布页链接整个埋掉 —— 而那两块恰恰是 POSIX 块覆盖不到的人唯一能用的东西。
     给它一个高度上限并纵向可滚；<pre> 本来就是键盘可聚焦的（CommandBlock 的
     tabindex="0"），所以滚得到的人也包括不用鼠标的人。 */
  .script :global(pre) { max-height: 24rem; overflow-y: auto; }

  .steps { margin: 0 0 var(--space-3); padding-inline-start: var(--space-5); }
  .steps li { font-size: var(--fs-xs); line-height: 1.6; color: var(--text); margin-bottom: 6px; }
  .releases { color: var(--accent-fg); text-decoration: none; font-weight: 500; }
  .releases:hover { text-decoration: underline; }

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
