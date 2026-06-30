<script lang="ts">
  import { uploadFile, buildDownloadLink, UploadError } from "./stored-file";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);

  let burn = $state(false);
  let ttl = $state(86400); // default 1 day
  let busy = $state(false);
  let progress = $state(0); // 0..100
  let link = $state("");
  let err = $state("");
  let copied = $state(false);
  let qrDataUrl = $state("");

  $effect(() => {
    if (link) {
      import("qrcode").then((m) =>
        m.toDataURL(link, { margin: 1, width: 192 }).then((u) => (qrDataUrl = u)),
      );
    } else {
      qrDataUrl = "";
    }
  });

  async function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    if (files.length === 0) return;
    err = "";
    link = "";
    busy = true;
    progress = 0;
    try {
      const out = await uploadFile(files, { burnAfterRead: burn, ttl }, (sent, total) => {
        progress = total > 0 ? Math.round((sent / total) * 100) : 0;
      });
      link = buildDownloadLink(location.origin, out.id, out.key);
    } catch (e2) {
      if (e2 instanceof UploadError && e2.status === 413) err = t.stored.errTooLarge;
      else if (e2 instanceof UploadError && e2.status === 429) err = t.stored.errQuota;
      else err = t.stored.errUpload;
    } finally {
      busy = false;
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(link);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<section class="stored">
  <h2>{t.stored.title}</h2>
  <p class="desc">{t.stored.desc}</p>

  <div class="opts">
    <label class="opt"><input type="checkbox" bind:checked={burn} />{t.stored.burnLabel}</label>
    <label class="opt">{t.stored.ttlLabel}
      <select bind:value={ttl}>
        <option value={86400}>{t.stored.ttl1d}</option>
        <option value={259200}>{t.stored.ttl3d}</option>
        <option value={604800}>{t.stored.ttl7d}</option>
      </select>
    </label>
  </div>

  <label class="pick" class:disabled={busy}>
    <input type="file" multiple disabled={busy} onchange={onPick} />
    <span>{busy ? t.stored.uploading : t.stored.pick}</span>
  </label>

  {#if busy}
    <div class="bar"><div class="fill" style:width="{progress}%"></div></div>
  {/if}

  {#if err}<p class="error">{err}</p>{/if}

  {#if link}
    <p class="ready">{t.stored.linkReady}</p>
    <div class="row">
      <input readonly value={link} />
      <button onclick={copy}>{copied ? t.stored.copied : t.stored.copy}</button>
    </div>
    {#if qrDataUrl}<img class="qr" src={qrDataUrl} alt="QR" width="192" height="192" />{/if}
  {/if}
</section>

<style>
  .stored { border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; margin: 18px 0; background: var(--social-bg); }
  .stored h2 { font-size: 17px; margin: 0 0 6px; }
  .desc { color: var(--text); font-size: 13.5px; margin: 0 0 12px; }
  .opts { display: flex; flex-wrap: wrap; gap: 18px; margin-bottom: 12px; font-size: 14px; }
  .opt { display: flex; align-items: center; gap: 8px; }
  .pick { display: inline-flex; align-items: center; gap: 10px; padding: 10px 16px; border: 1.5px dashed var(--border); border-radius: 12px; cursor: pointer; }
  .pick.disabled { opacity: .6; cursor: not-allowed; }
  .pick input[type="file"] { display: none; }
  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; margin-top: 12px; }
  .fill { height: 100%; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s; }
  .ready { color: var(--text-h); font-size: 14px; margin: 12px 0 6px; }
  .row { display: flex; gap: 8px; }
  .row input { flex: 1; font: inherit; padding: 8px 10px; }
  .row button { font: inherit; padding: 8px 14px; cursor: pointer; }
  .qr { margin-top: 12px; }
  .error { color: var(--accent); font-size: 13.5px; margin-top: 10px; }
</style>
