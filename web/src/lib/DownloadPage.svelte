<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fetchMeta, downloadBlob, parseDownloadKey, keyFromFragment } from "./stored-file";
  import { decryptManifest, type StoredManifest } from "./store-crypto";
  import { pickSaveTarget, type SaveTarget, type FileSink } from "./filesink";
  import { lang, setLang, LANGS, messages, legalUrl, type Lang, type Messages } from "./i18n.svelte";
  import { formatRemaining } from "./format";

  let { id }: { id: string } = $props();

  const t = $derived<Messages>(messages[lang()]);

  type PageState = "loading" | "ready" | "downloading" | "done" | "error";
  let pageState: PageState = $state("loading");
  let errKey: "notFound" | "noKey" | "decryptFail" | "unsupported" | "" = $state("");
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
      errKey = isNotFound(e) ? "notFound" : "decryptFail";
    }
  });
  onDestroy(() => clearInterval(ticker));

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
  const secLeft = $derived(expiresAt > 0 ? expiresAt - now : 0);
  // A link that lapses while the tab is open. Gated to the "ready" state in the
  // template so it can't interrupt an in-flight download.
  const expired = $derived(expiresAt > 0 && secLeft <= 0);

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

<header class="dlnav">
  <a class="brand" href="/"><span class="mark">⇌</span><span class="word">Relayium</span></a>
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
</header>

<main class="dl">
  {#if pageState === "loading"}
    <p>{t.download.loading}</p>
  {:else if pageState === "error"}
    <p class="error">
      {#if errKey === "notFound"}{t.download.notFound}
      {:else if errKey === "noKey"}{t.download.noKey}
      {:else if errKey === "unsupported"}{t.download.unsupported}
      {:else}{t.download.decryptFail}{/if}
    </p>
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
      <div class="bar"><div class="fill" style:width="{progress}%"></div></div>
      <p>{t.download.downloading} {progress}%</p>
    {:else if pageState === "done"}
      <p class="ok">{t.download.done}</p>
    {:else}
      <button class="btn btn-primary" onclick={download}>{t.download.downloadBtn}</button>
    {/if}
  {/if}

  <section class="sendcta">
    <span>{t.download.sendPrompt}</span>
    <a href="/">{t.download.sendCta}</a>
  </section>

  <footer>
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
  .brand { display: inline-flex; align-items: center; gap: var(--space-2); margin-right: auto; text-decoration: none; color: var(--text-h); font-weight: 600; }
  .brand .mark {
    width: 28px; height: 28px; line-height: 28px; text-align: center;
    border-radius: var(--radius-sm); color: #fff; font-size: var(--fs-body);
    background: linear-gradient(135deg, var(--accent), #6d28d9);
  }
  .brand .word { font-size: var(--fs-body); letter-spacing: -0.4px; }
  .lang {
    font: inherit; font-size: var(--fs-xs); padding: 5px 28px 5px 10px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer;
  }
  .lang:hover { border-color: var(--accent-border); }

  .dl { width: 560px; max-width: 100%; margin: 0 auto; padding: var(--space-5) var(--space-5) var(--space-7); text-align: left; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); margin: var(--space-2) 0 var(--space-3); }
  .dl h2 { font-size: var(--fs-h3); margin: 0; }
  .summary { font-size: var(--fs-xs); color: var(--text); white-space: nowrap; }
  .filelist { list-style: none; margin: 0 0 var(--space-4); padding: 0; }
  .filelist li { display: flex; justify-content: space-between; gap: var(--space-3); padding: 7px 0; border-bottom: 1px dashed var(--border); }
  .fname { color: var(--text-h); word-break: break-all; }
  .fsize { color: var(--text); white-space: nowrap; }

  .expiry { font-size: var(--fs-xs); color: var(--text); margin: 0 0 var(--space-3); }
  .expiry.soon { color: var(--accent); font-weight: 500; }
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

  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
  .fill { height: 100%; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s; }
  .error { color: var(--accent); } .ok { color: #2ecc71; }

  .sendcta {
    margin-top: var(--space-7); padding: var(--space-4); border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-2);
    display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
    font-size: var(--fs-xs); color: var(--text);
  }
  .sendcta a { color: var(--accent); text-decoration: none; font-weight: 500; white-space: nowrap; }
  .sendcta a:hover { text-decoration: underline; }

  footer { margin-top: var(--space-5); display: flex; gap: var(--space-4); font-size: 12.5px; }
  footer a { color: var(--text-h); text-decoration: none; }
</style>
