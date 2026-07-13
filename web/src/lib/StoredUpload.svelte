<script lang="ts">
  import { onMount } from "svelte";
  import { uploadFileResumable, buildDownloadLink, UploadError } from "./stored-file";
  import { canShare, share } from "./share";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { maxSizeHint } from "./max-size";
  import { hasFiles, filesFromDataTransfer } from "./drag";
  import { rememberUploadKey } from "./upload-keys";

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
  let busy = $state(false);
  let progress = $state(0); // 0..100 — encryption progress (the only phase the API reports)
  // The API reports encryption progress; the POST that follows has none. Track the
  // phase so the bar hitting 100% reads as "now uploading…" rather than a silent stall.
  let phase = $state<"encrypting" | "uploading">("encrypting");
  let link = $state("");
  let expiresAt = $state(0); // unix seconds of the generated link, 0 until ready
  let err = $state("");
  let copied = $state(false);
  let cmdCopied = $state(false);
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
    if (files.length === 0) return;
    err = "";
    link = "";
    expiresAt = 0;
    busy = true;
    progress = 0;
    phase = "encrypting";
    controller = new AbortController();
    try {
      const out = await uploadFileResumable(files, { burnAfterRead: burn, ttl }, (p) => {
        // The bar tracks whichever phase is live; it fills 0→100 for encryption,
        // then resets and fills again for the real upload (the label says which).
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
      busy = false;
      controller = null;
    }
  }

  function cancel() {
    controller?.abort();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      return; // clipboard blocked — the link is visible in the read-only field
    }
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(downCmd);
    } catch {
      return; // clipboard blocked — the command is visible and selectable
    }
    cmdCopied = true;
    setTimeout(() => (cmdCopied = false), 2000);
  }
</script>

<section class="stored">
  <div class="opts">
    <label class="opt"><input type="checkbox" bind:checked={burn} />{t.stored.burnLabel}</label>
    <label class="opt">{t.stored.ttlLabel}
      <select bind:value={ttl}>
        <option value={3600}>{t.stored.ttl1h}</option>
        <option value={86400}>{t.stored.ttl1d}</option>
        <option value={259200}>{t.stored.ttl3d}</option>
        <option value={604800}>{t.stored.ttl7d}</option>
      </select>
    </label>
  </div>

  <label
    class="pick"
    class:disabled={busy}
    class:dragover={dragOver}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    <input type="file" multiple disabled={busy} onchange={onPick} />
    <span>{busy ? t.stored.uploading : t.stored.pick}</span>
    <span class="drophint">{t.stored.dropHint}</span>
  </label>
  {#if hint}<span class="max-hint">{t.maxSize(hint)}</span>{/if}

  {#if busy}
    <div class="bar" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100"><div class="fill" style:width="{progress}%"></div></div>
    <p class="phase" aria-live="polite">{phase === "uploading" ? `${t.stored.uploadingNow} ${progress}%` : `${t.stored.encrypting} ${progress}%`}</p>
    <button type="button" class="btn btn-ghost cancel" onclick={cancel}>{t.cancel}</button>
  {/if}

  {#if err}<p class="error">{err}</p>{/if}

  {#if link}
    <p class="ready">{t.stored.linkReady}</p>
    <div class="row">
      <input readonly value={link} />
      <button class="btn btn-ghost" onclick={copy}>{copied ? t.stored.copied : t.stored.copy}</button>
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
        <button class="btn btn-ghost" onclick={copyCmd}>{cmdCopied ? t.stored.copied : t.stored.cliCopy}</button>
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
  .pick input[type="file"] { display: none; }
  .pick .drophint { width: 100%; font-size: var(--fs-xs); color: var(--text); }
  .max-hint { display: block; margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--text); }
  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; margin-top: var(--space-3); }
  .fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-deep)); transition: width .2s; }
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
