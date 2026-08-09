<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { session } from "./auth.svelte";
  import { formatSize } from "./format";
  import { fetchUsage, type Bucket, type Usage } from "./usage.svelte";

  const t = $derived<Messages>(messages[lang()]);

  let usage = $state<Usage | null>(null);

  // 跟着会话走：登出清空，换账号重取。与 QuotaNotice 同款守卫——本组件所在的
  // /me 页在登出后不会立刻卸载，无条件写 usage 会把上一个账号的数字画出来。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { usage = null; return; }
    fetchUsage(uid).then((u) => {
      if (session().user?.id !== uid) return; // 陈旧响应，丢弃
      usage = u;
    });
  });

  // cap === 0 表示无限档，此时不画进度条——画一条永远填不满的槽只会误导。
  const pct = (b: Bucket) => (b.cap > 0 ? Math.min(100, Math.round((b.used / b.cap) * 100)) : 0);
  const resetDate = $derived(
    usage ? new Date(usage.resetsAt * 1000).toLocaleDateString(lang()) : "",
  );
</script>

{#if usage}
  <section class="quota">
    <h2>{t.quota.title}</h2>
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
  /* <h2> for the same reason as PlanCard: it is a top-level section of /me. */
  .quota h2 { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
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
