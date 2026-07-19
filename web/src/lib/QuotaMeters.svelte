<script lang="ts">
  import { onMount } from "svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { formatSize } from "./format";

  const t = $derived<Messages>(messages[lang()]);

  interface Bucket { used: number; cap: number }
  interface Usage { period: string; resetsAt: number; traffic: Bucket; storage: Bucket }

  let usage = $state<Usage | null>(null);

  onMount(() => {
    fetch("/api/me/usage", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => { usage = u; })
      .catch(() => { /* 用量表是附加信息，取不到就整块不渲染 */ });
  });

  // cap === 0 表示无限档，此时不画进度条——画一条永远填不满的槽只会误导。
  const pct = (b: Bucket) => (b.cap > 0 ? Math.min(100, Math.round((b.used / b.cap) * 100)) : 0);
  const resetDate = $derived(
    usage ? new Date(usage.resetsAt * 1000).toLocaleDateString(lang()) : "",
  );
</script>

{#if usage}
  <section class="quota">
    <h3>{t.quota.title}</h3>
    {#each [{ key: "traffic", label: t.quota.traffic, b: usage.traffic }, { key: "storage", label: t.quota.storage, b: usage.storage }] as row (row.key)}
      <div class="row">
        <div class="head">
          <span class="lbl">{row.label}</span>
          {#if row.b.cap > 0}
            <span class="val">{formatSize(row.b.used)} / {formatSize(row.b.cap)}</span>
          {:else}
            <span class="val">{formatSize(row.b.used)} · {t.quota.unlimited}</span>
          {/if}
        </div>
        {#if row.b.cap > 0}
          <div
            class="bar"
            role="progressbar"
            aria-label={row.label}
            aria-valuenow={pct(row.b)}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="fill" style:width="{pct(row.b)}%"></div>
          </div>
          <span class="sub">{t.quota.left(formatSize(Math.max(0, row.b.cap - row.b.used)))}</span>
        {/if}
      </div>
    {/each}
    <p class="resets">{t.quota.resets(resetDate)}</p>
  </section>
{/if}

<style>
  /* Same card treatment as MePage.svelte's .stat — this block is the primary
     content of the page (current-month quota), not a footnote to the lifetime
     stats below it, so it needs the same visual weight. */
  .quota {
    padding: var(--space-5) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--social-bg);
  }
  .quota h3 { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
  .row { margin-top: var(--space-3); }
  .head { display: flex; justify-content: space-between; gap: var(--space-3); }
  .lbl { color: var(--text-h); }
  .val { color: var(--text-h); }
  /* 进度条沿用 App.svelte:1646 / StoredUpload.svelte:225 的既有样式（本仓没有 --muted，
     统一用 --text 做次要文字色） */
  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; margin-top: var(--space-2); }
  .fill { height: 100%; background: var(--accent); }
  .sub, .resets { color: var(--text); font-size: var(--fs-xs); }
  .resets { margin-top: var(--space-3); }
</style>
