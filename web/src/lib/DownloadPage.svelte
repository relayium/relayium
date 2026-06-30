<script lang="ts">
  import { onMount } from "svelte";
  import { fetchMeta, downloadBlob, parseDownloadKey, keyFromFragment } from "./stored-file";
  import { decryptManifest, type StoredManifest } from "./store-crypto";
  import { pickSaveTarget, type SaveTarget, type FileSink } from "./filesink";
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";

  let { id }: { id: string } = $props();

  const t = $derived<Messages>(messages[lang()]);

  type PageState = "loading" | "ready" | "downloading" | "done" | "error";
  let pageState: PageState = $state("loading");
  let errKey: "notFound" | "noKey" | "decryptFail" | "unsupported" | "" = $state("");
  let manifest = $state<StoredManifest | null>(null);
  let key: CryptoKey | null = null;
  let progress = $state(0); // 0..100

  onMount(async () => {
    if (!window.isSecureContext || !crypto.subtle) { pageState = "error"; errKey = "unsupported"; return; }
    const k = parseDownloadKey(location.hash);
    if (!k) { pageState = "error"; errKey = "noKey"; return; }
    try {
      const meta = await fetchMeta(id);
      key = await keyFromFragment(k);
      manifest = await decryptManifest(key, base64ToBytes(meta.encManifest));
      pageState = "ready";
    } catch (e) {
      pageState = "error";
      errKey = isNotFound(e) ? "notFound" : "decryptFail";
    }
  });

  function isNotFound(e: unknown): boolean {
    return e instanceof Error && /\b404\b/.test(e.message);
  }
  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const totalBytes = $derived(manifest ? manifest.files.reduce((n, f) => n + f.size, 0) : 0);

  async function download() {
    if (!manifest || !key) return;
    let target: SaveTarget;
    try {
      target = await pickSaveTarget(manifest.files.map((f) => ({ name: f.name, size: f.size })));
    } catch {
      return; // user cancelled the save picker
    }
    pageState = "downloading";
    progress = 0;
    // Plaintext is the concatenation of all files; split by manifest sizes.
    let fileIdx = 0;
    let intoFile = 0;
    let sink: FileSink | null = manifest.files.length ? await target.file(manifest.files[0].name, manifest.files[0].size) : null;
    try {
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
              sink = fileIdx < manifest!.files.length ? await target.file(manifest!.files[fileIdx].name, manifest!.files[fileIdx].size) : null;
            }
          }
        },
        (received) => { progress = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : 0; },
      );
      if (sink) await sink.close();
      pageState = "done";
    } catch {
      pageState = "error";
      errKey = "decryptFail";
    }
  }

  function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }
</script>

<main class="dl">
  <h1>Relayium</h1>
  {#if pageState === "loading"}
    <p>{t.download.loading}</p>
  {:else if pageState === "error"}
    <p class="error">
      {#if errKey === "notFound"}{t.download.notFound}
      {:else if errKey === "noKey"}{t.download.noKey}
      {:else if errKey === "unsupported"}{t.download.unsupported}
      {:else}{t.download.decryptFail}{/if}
    </p>
  {:else}
    <h2>{t.download.files}</h2>
    <ul class="filelist">
      {#each manifest?.files ?? [] as f}
        <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
      {/each}
    </ul>
    {#if pageState === "downloading"}
      <div class="bar"><div class="fill" style:width="{progress}%"></div></div>
      <p>{t.download.downloading} {progress}%</p>
    {:else if pageState === "done"}
      <p class="ok">{t.download.done}</p>
    {:else}
      <button class="primary" onclick={download}>{t.download.downloadBtn}</button>
    {/if}
  {/if}
  <footer>
    <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
    <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
  </footer>
</main>

<style>
  .dl { width: 560px; max-width: 100%; margin: 0 auto; padding: 24px 20px 48px; text-align: left; }
  .dl h1 { font-size: 28px; margin: 0 0 18px; }
  .dl h2 { font-size: 16px; margin: 18px 0 10px; }
  .filelist { list-style: none; margin: 0 0 16px; padding: 0; }
  .filelist li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px dashed var(--border); }
  .fname { color: var(--text-h); word-break: break-all; }
  .fsize { color: var(--text); white-space: nowrap; }
  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
  .fill { height: 100%; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s; }
  button.primary { font: inherit; font-size: 15px; padding: 10px 24px; border-radius: 9px; cursor: pointer; background: var(--accent); border: 1px solid var(--accent); color: #fff; }
  .error { color: var(--accent); } .ok { color: #2ecc71; }
  footer { margin-top: 28px; display: flex; gap: 16px; font-size: 12.5px; }
  footer a { color: var(--text-h); text-decoration: none; }
</style>
