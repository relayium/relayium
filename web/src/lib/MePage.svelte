<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import { confirmDialog } from "./confirm-dialog.svelte";
  import { session, refreshSession } from "./auth.svelte";
  import { setLoginOpen } from "./login.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import { formatSize, formatRemaining } from "./format";
  import { nodeRunCommand, nodePortsCommand } from "./nodes";
  import { buildDownloadLink } from "./stored-file";
  import { uploadKey, forgetUploadKey, pruneUploadKeys } from "./upload-keys";
  import WhyAccount from "./WhyAccount.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import { reveal, countUp } from "./reveal";
  import QuotaMeters from "./QuotaMeters.svelte";

  const t = $derived<Messages>(messages[lang()]);

  interface Stats {
    transfers: number; downloads: number;
    uploadBytes: number; downloadBytes: number; relayBytes: number;
  }
  interface FileRow {
    id: string; size: number; createdAt: number; expiresAt: number;
    burnAfterRead: boolean; downloadCount: number;
  }
  interface NodeRow {
    id: string; name: string; host: string; region: string; online: boolean;
    relayedBytes: number; storedBytes: number;
    storageFree: number; storageTotal: number; lastSeen: number;
  }

  let stats = $state<Stats | null>(null);
  let files = $state<FileRow[]>([]);
  // Local id→key map for files this browser uploaded, so their share link (whose
  // key the server never holds) can be rebuilt and re-copied from here.
  let fileKeys = $state<Record<string, string>>({});
  let copiedId = $state(""); // file id whose "copy link" just fired, for the ✓ state
  let loading = $state(true);
  let nowSec = $state(Math.floor(Date.now() / 1000));
  let loadedFor = ""; // user id we last loaded data for; guards against refetch loops

  // "My Nodes" — BYO relay node section.
  let nodes = $state<NodeRow[]>([]);
  let strict = $state(false);
  let addingNode = $state(false); // add-node mini-form open
  let newNodeName = $state("");
  let newToken = $state<string | null>(null); // shown exactly once, right after provisioning

  // Per-node live connectivity probe: distinct from the passive online dot, this
  // asks central to actually reach the node right now.
  interface CheckResult { reachable: boolean; online: boolean; latencyMs: number; error?: string }
  let checking = $state<Record<string, boolean>>({});
  let checkResult = $state<Record<string, CheckResult>>({});

  // Inline node rename: which node id is being edited, and the draft label.
  let renamingId = $state<string | null>(null);
  let renameDraft = $state("");
  function startRename(n: NodeRow) { renamingId = n.id; renameDraft = n.name; }
  function focusRename(node: HTMLInputElement) { node.focus(); node.select(); }
  async function saveRename(id: string) {
    const label = renameDraft.trim();
    renamingId = null;
    const res = await fetch(`/api/nodes/${id}/label`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: label }),
    });
    if (res.ok) nodes = nodes.map((n) => (n.id === id ? { ...n, name: label } : n));
  }

  async function loadNodes() {
    try {
      const res = await fetch("/api/nodes/mine", { credentials: "include" });
      nodes = res.ok ? ((await res.json()).nodes ?? []) : [];
    } catch {
      nodes = [];
    }
  }

  async function checkNode(id: string) {
    checking = { ...checking, [id]: true };
    try {
      const res = await fetch(`/api/nodes/${id}/check`, { method: "POST", credentials: "include" });
      checkResult = { ...checkResult, [id]: res.ok ? await res.json() : { reachable: false, online: false, latencyMs: 0, error: "error" } };
    } catch {
      checkResult = { ...checkResult, [id]: { reachable: false, online: false, latencyMs: 0, error: "error" } };
    } finally {
      checking = { ...checking, [id]: false };
    }
  }

  async function load() {
    loading = true;
    try {
      const [sr, fr, mr] = await Promise.all([
        fetch("/api/stats", { credentials: "include" }),
        fetch("/api/files", { credentials: "include" }),
        fetch("/api/me", { credentials: "include" }),
      ]);
      stats = sr.ok ? await sr.json() : null;
      files = fr.ok ? ((await fr.json()).files ?? []) : [];
      strict = mr.ok ? Boolean((await mr.json()).user?.onlyOwnNodes) : false;
      // Recover locally-held keys for the current files, and drop keys for files
      // the server no longer lists (expired/deleted) so the store can't grow forever.
      const ids = files.map((f) => f.id);
      pruneUploadKeys(ids);
      const km: Record<string, string> = {};
      for (const id of ids) {
        const k = uploadKey(id);
        if (k) km[id] = k;
      }
      fileKeys = km;
    } catch {
      stats = null;
      files = [];
      strict = false;
      fileKeys = {};
    } finally {
      loading = false;
    }
    await loadNodes();
  }

  async function copyLink(id: string) {
    const key = fileKeys[id];
    if (!key) return;
    const link = buildDownloadLink(location.origin, id, key);
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      return; // clipboard blocked
    }
    copiedId = id;
    setTimeout(() => { if (copiedId === id) copiedId = ""; }, 2000);
  }

  async function addNode() {
    const name = newNodeName.trim();
    const res = await fetch("/api/nodes/provision", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const body = (await res.json()) as { token: string };
      newToken = body.token;
      newNodeName = "";
      addingNode = false;
      await loadNodes();
    }
  }

  async function deleteNode(id: string) {
    if (!(await confirmDialog(t.me.confirmDelNode))) return;
    const res = await fetch(`/api/nodes/${id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) nodes = nodes.filter((n) => n.id !== id);
  }

  async function setStrict(next: boolean) {
    if (next === strict) return;
    const prev = strict;
    strict = next; // optimistic — matches the option the user just picked
    const res = await fetch("/api/me/strict-nodes", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onlyOwnNodes: next }),
    });
    if (!res.ok) strict = prev; // revert on failure
  }

  async function del(id: string) {
    if (!(await confirmDialog(t.me.confirmDel))) return;
    const res = await fetch(`/api/files/${id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) {
      files = files.filter((f) => f.id !== id);
      forgetUploadKey(id);
      const { [id]: _drop, ...rest } = fileKeys;
      fileKeys = rest;
      // A deleted link can no longer be downloaded, but its past downloads still
      // count toward lifetime stats — so refresh the numbers, not just the list.
      try {
        const sr = await fetch("/api/stats", { credentials: "include" });
        if (sr.ok) stats = await sr.json();
      } catch { /* keep stale stats on a transient error */ }
    }
  }

  const totalTraffic = $derived(
    stats ? stats.uploadBytes + stats.downloadBytes + stats.relayBytes : 0,
  );

  // Load once per logged-in user; reload if a login happens while on this page.
  $effect(() => {
    const uid = session().user?.id ?? "";
    if (uid && uid !== loadedFor) {
      loadedFor = uid;
      load();
    }
    if (!uid) {
      loadedFor = "";
      stats = null; files = []; loading = false;
      nodes = []; strict = false; newToken = null; addingNode = false; renamingId = null;
    }
  });

  let tick: ReturnType<typeof setInterval>;
  onMount(async () => {
    await refreshSession();
    tick = setInterval(() => (nowSec = Math.floor(Date.now() / 1000)), 30_000);
  });
  onDestroy(() => clearInterval(tick));
</script>

<section class="me page-enter">
  <ConfirmModal />

  <header class="me-head">
    <button class="back" onclick={() => navigate("lan")}>{t.me.back}</button>
    <h1>{t.me.title}</h1>
  </header>

  {#if !session().user}
    <div class="gate">
      <p>{t.me.loginRequired}</p>
      <button class="btn btn-primary" onclick={() => setLoginOpen(true)}>{t.me.signIn}</button>
      <WhyAccount compact />
    </div>
  {:else}
    <div class="stats reveal" use:reveal>
      <div class="stat">
        <span class="num" use:countUp={stats?.transfers ?? 0}>{stats?.transfers ?? 0}</span>
        <span class="lbl">{t.me.transfers}</span>
      </div>
      <div class="stat">
        <span class="num" use:countUp={stats?.downloads ?? 0}>{stats?.downloads ?? 0}</span>
        <span class="lbl">{t.me.downloads}</span>
      </div>
      <div class="stat wide">
        <span class="num">{formatSize(totalTraffic)}</span>
        <span class="lbl">{t.me.traffic}</span>
        <span class="parts">{t.me.trafficParts(
          formatSize(stats?.uploadBytes ?? 0),
          formatSize(stats?.downloadBytes ?? 0),
          formatSize(stats?.relayBytes ?? 0),
        )}</span>
      </div>
    </div>
    <p class="privacy">{t.me.privacyNote}</p>
    <QuotaMeters />

    <section class="files">
      <div class="files-head">
        <h2>{t.me.filesTitle}</h2>
        <span class="note">{t.me.noName}</span>
      </div>
      <p class="link-hint">{t.me.linkHint}</p>

      {#if loading}
        <p class="muted">…</p>
      {:else if files.length === 0}
        <p class="muted">{t.me.filesEmpty}</p>
      {:else}
        <ul class="filelist">
          {#each files as f (f.id)}
            {@const secLeft = f.expiresAt - nowSec}
            <li>
              <span class="fid">#{f.id.slice(0, 8)}</span>
              <span class="fsize">{formatSize(f.size)}</span>
              {#if f.burnAfterRead}<span class="tag burn">🔥 {t.me.burnTag}</span>{/if}
              <span class="dl">↓ {t.me.downloadsN(f.downloadCount)}</span>
              <span class="exp" class:soon={secLeft < 3600}>
                ⏳ {t.me.expiresIn(formatRemaining(secLeft, t.download.durUnits))}
              </span>
              {#if fileKeys[f.id]}
                <button class="linkbtn" class:copied={copiedId === f.id} onclick={() => copyLink(f.id)}>
                  {copiedId === f.id ? "✓" : "🔗 " + t.me.copyLink}
                </button>
              {/if}
              <button class="del" onclick={() => del(f.id)} aria-label={t.me.del}>{t.me.del}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="nodes">
      <div class="nodes-head">
        <h2>{t.me.nodesTitle}</h2>
      </div>
      <div class="routing" role="radiogroup" aria-label={t.me.routingTitle}>
        <label class="routeopt" class:sel={!strict}>
          <input type="radio" name="node-routing" checked={!strict} onchange={() => setStrict(false)} />
          <span class="ropt-text"><b>{t.me.routeAuto}</b><span class="hint">{t.me.routeAutoHint}</span></span>
        </label>
        <label class="routeopt" class:sel={strict}>
          <input type="radio" name="node-routing" checked={strict} onchange={() => setStrict(true)} />
          <span class="ropt-text"><b>{t.me.strictLabel}</b><span class="hint">{t.me.strictHint}</span></span>
        </label>
      </div>
      <p class="hint">{t.me.nodesTrafficHint}</p>

      {#if newToken}
        <div class="token-reveal">
          <p class="hint">{t.me.tokenNote}</p>
          <CommandBlock code={nodeRunCommand(newToken, location.origin)} title="relayium-node" />
          <p class="hint ports-note">{t.me.tokenPortsNote}</p>
          <CommandBlock code={nodePortsCommand()} title={t.me.tokenPortsTitle} />
          <p class="hint">
            <a href={lang() === "en" ? "/guides/bring-your-own-node" : `/${lang()}/guides/bring-your-own-node`} target="_blank" rel="noopener">{t.me.tokenGuideLink} →</a>
          </p>
          <button class="btn btn-primary" onclick={() => (newToken = null)}>{t.me.tokenDone}</button>
        </div>
      {:else if addingNode}
        <form class="add-form" onsubmit={(e) => { e.preventDefault(); addNode(); }}>
          <input type="text" bind:value={newNodeName} placeholder={t.me.nodeNamePlaceholder} />
          <button type="submit" class="btn btn-primary">{t.me.addNodeSubmit}</button>
          <button type="button" class="btn-link" onclick={() => { addingNode = false; newNodeName = ""; }}>
            {t.me.addNodeCancel}
          </button>
        </form>
      {:else}
        <button class="btn btn-ghost" onclick={() => (addingNode = true)}>{t.me.addNode}</button>
      {/if}

      {#if nodes.length === 0}
        <p class="muted">{t.me.nodesEmpty}</p>
      {:else}
        <ul class="nodelist">
          {#each nodes as n (n.id)}
            {@const cr = checkResult[n.id]}
            <li>
              <span class="dot" class:on={n.online} aria-label={n.online ? t.me.nodeOnline : t.me.nodeOffline}></span>
              {#if renamingId === n.id}
                <input
                  class="rename"
                  bind:value={renameDraft}
                  placeholder={t.me.nodeNamePlaceholder}
                  use:focusRename
                  onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveRename(n.id); } else if (e.key === "Escape") { renamingId = null; } }}
                  onblur={() => saveRename(n.id)}
                />
              {:else if n.name}
                <button class="nname" onclick={() => startRename(n)} title={t.me.nodeRename}>{n.name}</button>
              {/if}
              <span class="nid">{#if n.host}{n.host} · {/if}{n.region || "—"} · #{n.id.slice(0, 8)}</span>
              <span class="nstat">{t.me.nodeRelayed(formatSize(n.relayedBytes))} ({t.me.nodeFreeTag})</span>
              <span class="nstat">{t.me.nodeStorageFree(formatSize(n.storageFree), formatSize(n.storageTotal))}</span>
              {#if cr}
                <span class="probe" class:ok={cr.reachable} class:bad={!cr.reachable}>
                  {cr.reachable ? t.me.nodeReachable(String(cr.latencyMs)) : t.me.nodeUnreachable}
                </span>
              {/if}
              <button class="chk" onclick={() => startRename(n)}>{t.me.nodeRename}</button>
              <button class="chk" disabled={checking[n.id]} onclick={() => checkNode(n.id)}>
                {checking[n.id] ? "…" : t.me.checkNode}
              </button>
              <button class="del" onclick={() => deleteNode(n.id)} aria-label={t.me.delNode}>{t.me.delNode}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</section>

<style>
  .me { position: relative; max-width: 1120px; margin: 0 auto; }

  .me-head { text-align: center; padding: var(--space-2) 0 var(--space-5); position: relative; }
  .me-head h1 { font-size: 30px; margin: 0; letter-spacing: -.5px; }
  .back {
    position: absolute; inset-inline-start: 0; top: var(--space-2);
    font: inherit; font-size: var(--fs-xs); background: none; border: 0; color: var(--text); cursor: pointer;
    padding: var(--space-1) 0;
  }
  .back:hover { color: var(--text-h); }

  /* Narrow screens: the centred title is wide enough to collide with the
     absolutely-positioned back link. Drop out of that overlay layout — back
     link on its own line, title left-aligned below it. */
  @media (max-width: 560px) {
    .me-head { text-align: start; padding-top: 0; }
    .me-head .back { position: static; display: inline-block; margin-bottom: var(--space-3); }
    .me-head h1 { font-size: 24px; }
  }

  .gate {
    display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
    padding: var(--space-8) var(--space-4); text-align: center; color: var(--text);
  }

  .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); }
  .stat {
    display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: center;
    padding: var(--space-5) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--social-bg); text-align: center;
  }
  .stat.wide { grid-column: 1 / -1; }
  .stat .num { font-size: 26px; font-weight: 600; color: var(--text-h); }
  .stat .lbl { font-size: var(--fs-xs); color: var(--text); }
  .stat .parts { font-size: var(--fs-xs); color: var(--text); margin-top: 2px; }

  .privacy { margin: var(--space-3) 0 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }

  .files { margin-top: var(--space-6); }
  .files-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; margin-bottom: var(--space-3); }
  .files-head h2 { font-size: var(--fs-h3); margin: 0; }
  .files-head .note { font-size: var(--fs-xs); color: var(--text); }
  .muted { color: var(--text); font-size: var(--fs-xs); }

  .filelist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .filelist li {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
    padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--social-bg); font-size: var(--fs-xs);
  }
  .fid { font-family: ui-monospace, monospace; color: var(--text-h); }
  .fsize { color: var(--text); }
  .dl { color: var(--text-h); }
  .exp { color: var(--text); margin-inline-start: auto; }
  .exp.soon { color: var(--danger); }
  .tag.burn { color: var(--accent); }
  .link-hint { margin: 0 0 var(--space-3); font-size: var(--fs-xs); color: var(--text); }
  .linkbtn {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--accent);
    padding: 2px 10px; transition: border-color .13s;
  }
  .linkbtn:hover { border-color: var(--accent-border); }
  .linkbtn.copied { color: #2ecc71; border-color: #2ecc71; animation: pop-in .3s ease; }
  @media (prefers-reduced-motion: reduce) { .linkbtn.copied { animation: none; } }
  .del {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text);
    padding: 2px 10px; transition: border-color .13s, color .13s;
  }
  .del:hover { border-color: var(--danger); color: var(--danger); }

  .nodes { margin-top: var(--space-6); }
  .nodes-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 10px; margin-bottom: var(--space-2); }
  .nodes-head h2 { font-size: var(--fs-h3); margin: 0; }
  .nodes > .hint { margin: 0 0 var(--space-3); font-size: var(--fs-xs); color: var(--text); }

  /* Routing choice: auto-fastest vs only-my-nodes, as two radio cards. */
  .routing { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
  .routeopt {
    display: flex; align-items: flex-start; gap: var(--space-2);
    padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--social-bg); cursor: pointer; transition: border-color .13s;
  }
  .routeopt.sel { border-color: var(--accent-border); }
  .routeopt input { margin-top: 2px; flex: none; accent-color: var(--accent); }
  .ropt-text { display: flex; flex-direction: column; gap: 2px; }
  .ropt-text b { color: var(--text-h); font-weight: 600; font-size: var(--fs-sm); }
  .ropt-text .hint { color: var(--text); font-size: var(--fs-xs); }

  .nname {
    font: inherit; font-size: var(--fs-xs); font-weight: 600; color: var(--text-h);
    background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px;
  }
  .nname:hover { color: var(--accent); }
  .rename {
    font: inherit; font-size: var(--fs-xs); padding: 2px 8px; width: 14ch; max-width: 45vw;
    border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-h);
  }

  .add-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
  .add-form input {
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border);
    font: inherit; font-size: var(--fs-xs); background: var(--social-bg); color: var(--text-h);
  }

  .token-reveal { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-3); }
  .token-reveal .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); }
  .token-reveal .ports-note { padding-top: var(--space-2); border-top: 1px solid var(--border); }

  .nodelist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .nodelist li {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
    padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--social-bg); font-size: var(--fs-xs);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text); opacity: .4; flex: none; }
  .dot.on { background: var(--accent); opacity: 1; }
  .nid { font-family: ui-monospace, monospace; color: var(--text-h); }
  .nstat { color: var(--text); }
  .probe { font-size: var(--fs-xs); }
  .probe.ok { color: var(--accent); }
  .probe.bad { color: var(--danger); }
  .chk {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer; margin-inline-start: auto;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text);
    padding: 2px 10px; transition: border-color .13s, color .13s;
  }
  .chk:hover:not(:disabled) { border-color: var(--accent-border); color: var(--text-h); }
  .chk:disabled { opacity: .6; cursor: default; }

  @media (max-width: 520px) {
    .exp { margin-inline-start: 0; }
  }
</style>
