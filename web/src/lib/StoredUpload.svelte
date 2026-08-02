<script lang="ts">
  import { copyFeedback } from "./clipboard.svelte";
  import { onMount } from "svelte";
  import { uploadFileResumable, buildDownloadLink, UploadError } from "./stored-file";
  import { canShare, share } from "./share";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { maxSizeHint } from "./max-size";
  import { hasFiles, filesFromDataTransfer } from "./drag";
  import { rememberUploadKey } from "./upload-keys";
  import { LARGE_DOWNLOAD_WARN_BYTES } from "./filesink";
  import { holdRefresh } from "./app-update.svelte";
  import { session } from "./auth.svelte";
  import { fetchUsage } from "./usage.svelte";
  import { allowedTtls, clampTtl } from "./ttl-options";

  const t = $derived<Messages>(messages[lang()]);

  let cfg = $state<{ maxFileSize?: number }>({});
  const hint = $derived(maxSizeHint(cfg.maxFileSize ?? 0));

  onMount(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => { cfg = c; })
      .catch(() => { /* size hint is optional — upload still works without it */ });
  });

  let burn = $state(false);
  let ttl = $state(86400); // default 1 day

  // 档位的留存上限。0 = 未知（未登录、老服务端、请求失败）或无限档，两种情况都
  // 提供全部四挡：服务端仍然会兜底截断，宁可多给选项也不要因为取不到用量就把
  // 能用的有效期藏起来。
  let retentionCap = $state(0);
  const ttlChoices = $derived(allowedTtls(retentionCap));

  // 与 QuotaMeters/QuotaNotice 共用 fetchUsage 的缓存，同页不会重复请求。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { retentionCap = 0; return; }
    fetchUsage(uid).then((u) => {
      // 陈旧响应守卫，同 QuotaNotice：请求兑现时会话可能已登出或换了账号。
      if (session().user?.id !== uid) return;
      retentionCap = u?.plan?.retentionSecs ?? 0;
    });
  });

  // 选项收窄后把已选值拉回合法范围。少了这一步，默认的 1 天（或用户先手选的
  // 7 天）会停在一个不再渲染的 <option> 上：下拉框空白，提交的仍是会被截断的值。
  $effect(() => {
    const next = clampTtl(ttl, ttlChoices);
    if (next !== ttl) ttl = next;
  });

  const ttlLabels: Record<number, string> = $derived({
    3600: t.stored.ttl1h,
    86400: t.stored.ttl1d,
    259200: t.stored.ttl3d,
    604800: t.stored.ttl7d,
    1209600: t.stored.ttl14d,
  });
  let busy = $state(false);
  let progress = $state(0); // 0..100 — progress of whichever phase the API reports
  // The chunked path encrypts and uploads at the same time, so it reports a single
  // "uploading" phase that runs 0→100 once. Only the single-shot fallback still has
  // two phases (encrypt, then POST); the label says which one is live.
  let phase = $state<"encrypting" | "uploading">("encrypting");
  let link = $state("");
  let expiresAt = $state(0); // unix seconds of the generated link, 0 until ready
  let err = $state("");
  const linkCopy = copyFeedback();
  const cmdCopy = copyFeedback();
  let dest = $state("."); // download destination for the `relayium down` command builder
  let qrDataUrl = $state("");

  // A shell-safe download command the recipient can paste on another machine.
  // The link is single-quoted so the `#k=…` fragment isn't swallowed as a
  // comment; the destination is only quoted when it contains characters a
  // shell would otherwise split or interpret (a pasted pwd with spaces, say).
  function shellQuote(s: string): string {
    if (s === "") return ".";
    if (/^[\w@%+=:,./-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  const downCmd = $derived(`relayium down '${link}' ${shellQuote(dest.trim())}`);
  let controller: AbortController | null = null; // in-flight upload, so it can be cancelled

  $effect(() => {
    if (!link) { qrDataUrl = ""; return; }
    let cancelled = false;
    const target = link;
    import("qrcode")
      .then((m) => m.toDataURL(target, { margin: 1, width: 192 }))
      .then((u) => { if (!cancelled) qrDataUrl = u; })
      .catch(() => { /* QR optional — the link is shown/copyable */ });
    return () => { cancelled = true; };
  });

  let dragOver = $state(false); // window/card drag hover, for the drop-zone highlight
  // 这一批的总量大到接收方的手机浏览器可能下载不了 —— 提醒发送方，不阻止上传。
  let bigBatch = $state(false);

  async function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    await startUpload(files);
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (busy || !e.dataTransfer) return;
    // Recurse into dropped folders (Chromium/Firefox); otherwise a flat file list.
    const picked = await filesFromDataTransfer(e.dataTransfer);
    await startUpload(picked.map((p) => p.file));
  }

  function onDragOver(e: DragEvent) {
    if (busy || !hasFiles(e.dataTransfer?.types)) return;
    e.preventDefault(); // required so the drop event fires
    dragOver = true;
  }

  function onDragLeave() {
    dragOver = false;
  }

  async function startUpload(files: File[]) {
    // Re-entrancy guard: onDrop checks `busy` before awaiting the folder-walk, so
    // a second drop landing during that async gap would otherwise reach here too
    // and start a concurrent upload — overwriting `controller` and orphaning the
    // first upload (cancel would only abort the last one). Bail if one is live.
    if (busy) return;
    if (files.length === 0) return;
    // 发送方是唯一决定文件多大的人，代价却落在接收方身上：没有流式落盘能力的
    // 浏览器（Firefox/Safari/所有手机）必须把整份文件读进内存。只提醒，不拦上传
    // ——1 GiB 的服务端上限本身是合理的，CLI 在这个尺寸上真能跑。
    bigBatch = files.reduce((n, f) => n + f.size, 0) > LARGE_DOWNLOAD_WARN_BYTES;
    err = "";
    link = "";
    expiresAt = 0;
    busy = true;
    progress = 0;
    phase = "encrypting";
    controller = new AbortController();
    // 刷新会把这次上传整个丢掉，连带那把只存在于本机内存里的零知识密钥（它要等
    // 上传成功才 rememberUploadKey）。这条路完全在 workspace 之外，warnsOnLeave
    // 看不见它，所以显式占住全站更新提示条的刷新闸门。见 app-update 的 holdRefresh。
    const releaseRefresh = holdRefresh();
    try {
      const out = await uploadFileResumable(files, { burnAfterRead: burn, ttl }, (p) => {
        // The bar tracks whichever phase is live.
        phase = p.phase;
        progress = p.total > 0 ? Math.round((p.sent / p.total) * 100) : 0;
      }, controller.signal);
      link = buildDownloadLink(location.origin, out.id, out.key);
      expiresAt = out.expiresAt;
      // Persist the zero-knowledge key locally so it can be recovered from
      // "My Files" later — the server never sees it, so this is the only copy.
      rememberUploadKey(out.id, out.key);
    } catch (e2) {
      // User-initiated cancel: return to idle silently, not as an error.
      if (controller?.signal.aborted) { /* cancelled */ }
      else if (e2 instanceof UploadError && e2.status === 413) err = t.stored.errTooLarge;
      else if (e2 instanceof UploadError && e2.status === 429) err = t.stored.errQuota;
      else err = t.stored.errUpload;
    } finally {
      releaseRefresh();
      busy = false;
      controller = null;
    }
  }

  function cancel() {
    controller?.abort();
  }

  const copy = () => linkCopy.copy(link);
  const copyCmd = () => cmdCopy.copy(downCmd);
</script>

<section class="stored">
  <div class="opts">
    <label class="opt"><input type="checkbox" bind:checked={burn} />{t.stored.burnLabel}</label>
    <label class="opt">{t.stored.ttlLabel}
      <select bind:value={ttl}>
        {#each ttlChoices as secs (secs)}
          <option value={secs}>{ttlLabels[secs]}</option>
        {/each}
      </select>
    </label>
  </div>
  <p class="notbackup">{t.stored.notBackup}</p>

  <label
    class="pick"
    class:disabled={busy}
    class:dragover={dragOver}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    <input class="file-pick-input" type="file" multiple disabled={busy} onchange={onPick} />
    <span>{busy ? t.stored.uploading : t.stored.pick}</span>
    <span class="drophint">{t.stored.dropHint}</span>
  </label>
  {#if hint}<span class="max-hint">{t.maxSize(hint)}</span>{/if}
  {#if bigBatch}<p class="bignote">{t.stored.bigNote}</p>{/if}

  {#if busy}
    <div class="progress-bar" role="progressbar" aria-label={phase === "uploading" ? t.stored.uploadingNow : t.stored.encrypting} aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style:width="{progress}%"></div></div>
    <!-- 同 DownloadPage：百分比不进 live region，理由见那里的注释。 -->
    <p class="phase">{phase === "uploading" ? `${t.stored.uploadingNow} ${progress}%` : `${t.stored.encrypting} ${progress}%`}</p>
    <button type="button" class="btn btn-ghost cancel" onclick={cancel}>{t.cancel}</button>
  {/if}

  {#if err}<p class="error">{err}</p>{/if}

  {#if link}
    <p class="ready">{t.stored.linkReady}</p>
    <div class="row">
      <input readonly value={link} />
      <button class="btn btn-ghost" onclick={copy}>{linkCopy.value ? t.stored.copied : t.stored.copy}</button>
      {#if canShare()}<button class="btn btn-ghost" onclick={() => share({ title: "Relayium", url: link })}>{t.share}</button>{/if}
    </div>
    {#if expiresAt > 0}
      <p class="expiry">{t.stored.expiresOn(new Date(expiresAt * 1000).toLocaleString(lang()))}</p>
    {/if}
    {#if qrDataUrl}<img class="qr" src={qrDataUrl} alt="QR" width="192" height="192" />{/if}

    <div class="cli">
      <p class="cli-h">{t.stored.cliHeading}</p>
      <p class="cli-intro">{t.stored.cliIntro}</p>
      <label class="cli-dest">
        <span>{t.stored.cliDestLabel}</span>
        <input bind:value={dest} placeholder="." spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" />
      </label>
      <p class="cli-hint">{t.stored.cliDestHint}</p>
      <div class="cli-cmd">
        <code>{downCmd}</code>
        <button class="btn btn-ghost" onclick={copyCmd}>{cmdCopy.value ? t.stored.copied : t.stored.cliCopy}</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .stored { display: flex; flex-direction: column; }
  .opts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin-bottom: var(--space-3); font-size: var(--fs-xs); }
  .opt { display: flex; align-items: center; gap: var(--space-2); }
  .pick { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-4); border: 1.5px dashed var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: border-color .13s, background .13s; }
  .pick:hover { border-color: var(--accent-border); }
  .pick.dragover { border-color: var(--accent); background: var(--code-bg); }
  .pick.disabled { opacity: .6; cursor: not-allowed; }
  .pick .drophint { width: 100%; font-size: var(--fs-xs); color: var(--text); }
  .max-hint { display: block; margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--text); }
  .notbackup { margin: var(--space-2) 0 0; font-size: var(--fs-xs); color: var(--text); }
  .bignote {
    margin: var(--space-3) 0 0; padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm); background: var(--code-bg); border: 1px solid var(--accent-border);
    font-size: var(--fs-xs); line-height: 1.55; color: var(--text-h);
  }
  /* 其余进度条样式在 app.css 的 .progress-bar/.progress-fill；这里只留本页的间距。 */
  .progress-bar { margin-top: var(--space-3); }
  .phase { margin: var(--space-2) 0 0; font-size: var(--fs-xs); color: var(--text); }
  .cancel { align-self: flex-start; margin-top: var(--space-3); }
  .ready { color: var(--text-h); font-size: var(--fs-sm); margin: var(--space-3) 0 var(--space-2); }
  .expiry { color: var(--text); font-size: var(--fs-xs); margin: var(--space-3) 0 0; }
  .row { display: flex; gap: var(--space-2); }
  .row input {
    flex: 1; min-width: 0; font: inherit; font-size: var(--fs-xs); padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg); color: var(--text-h);
  }
  .row .btn { padding: var(--space-2) var(--space-4); white-space: nowrap; }
  .qr { margin-top: var(--space-3); }
  .error { color: var(--danger); font-size: var(--fs-xs); margin-top: var(--space-3); }

  .cli { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border); }
  .cli-h { margin: 0; font-size: var(--fs-sm); color: var(--text-h); font-weight: 600; }
  .cli-intro { margin: var(--space-2) 0 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.5; }
  .cli-dest { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3); font-size: var(--fs-xs); color: var(--text); }
  .cli-dest span { flex: none; }
  .cli-dest input {
    flex: 1; min-width: 0; font: inherit; font-size: var(--fs-xs); padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg); color: var(--text-h);
  }
  .cli-hint { margin: var(--space-2) 0 0; font-size: var(--fs-xs); color: var(--text); line-height: 1.5; }
  .cli-cmd {
    display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--code-bg);
  }
  .cli-cmd code {
    flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); color: var(--text-h);
  }
  .cli-cmd .btn { flex: none; padding: var(--space-2) var(--space-3); white-space: nowrap; }
</style>
