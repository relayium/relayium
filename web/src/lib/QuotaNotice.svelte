<script lang="ts">
  import { session } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";

  const t = $derived<Messages>(messages[lang()]);

  const WARN_AT = 0.8; // 提醒阈值：留出足够余量让用户在被 429 打断前完成升级

  let pct = $state(0);
  let loadedFor = $state<string | null>(null);

  // 跟着会话走：登出后清零，换账号后重取。未登录用户没有配额可言。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { pct = 0; loadedFor = null; return; }
    if (uid === loadedFor) return;
    loadedFor = uid;
    fetch("/api/me/usage", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        // cap === 0 是无限档，永远不提醒。
        const cap = u?.traffic?.cap ?? 0;
        pct = cap > 0 ? Math.min(100, Math.round((u.traffic.used / cap) * 100)) : 0;
      })
      .catch(() => { pct = 0; });
  });
</script>

{#if pct >= WARN_AT * 100}
  <p class="quota-warn" role="status">
    <span>{t.quota.warn(pct)}</span>
    <button class="btn" onclick={() => navigate("pricing")}>{t.quota.upgrade}</button>
  </p>
{/if}

<style>
  .quota-warn {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--space-3); margin: 0 0 var(--space-3);
    padding: 10px 14px; border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    color: var(--text); font-size: var(--fs-sm);
  }
</style>
