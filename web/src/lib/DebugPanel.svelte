<script lang="ts">
  // ?debug=1 的连接诊断面板。只读、永不上传——用户自己复制想分享的内容。
  //
  // 存在的理由是手机没有开发者控制台：一次传输为什么慢（掉到 TLS/TCP 中继？中继
  // 绕了地球半圈？），除了在页面上把 getStats() 摊开给用户看，没有别的办法。
  //
  // 从 App.svelte 里搬出来的：它自带轮询、自带一整套样式、和传输逻辑一点关系都没有。
  import { summarizeStats, type Conn, type ConnDiagnostics } from "./webrtc";
  import Icon from "./Icon.svelte";

  interface Props {
    /** 当前活动连接的取数器。传函数而不是传值：面板每秒轮询一次，连接会在传输之间
     *  换成新的（或变回 null），拿快照就会一直问一个已经关掉的 pc。 */
    conn: () => Conn | null;
    /** 中继选优的现状，纯展示。 */
    relayPool: { id: string }[];
    selectedRelayId: string | null;
    myRelayRtt: Record<string, number>;
    peerRelayRtt: Record<string, number>;
    /** 关闭面板（同时清掉 localStorage 里的记忆开关）。 */
    onclose: () => void;
  }
  const { conn, relayPool, selectedRelayId, myRelayRtt, peerRelayRtt, onclose }: Props = $props();

  let dbg = $state<ConnDiagnostics | null>(null);
  let includeIps = $state(false);
  let frozen = $state(false); // 暂停轮询，好让数值停住方便读/抄

  $effect(() => {
    const poll = async () => {
      if (frozen) return; // 冻结时保留最后一帧
      const c = conn();
      if (!c) { dbg = null; return; }
      try { dbg = summarizeStats(await c.stats(), includeIps); }
      catch { dbg = null; } // 两次传输之间 pc 已关，stats() 会 reject
    };
    poll();
    const iv = setInterval(poll, 1000);
    return () => clearInterval(iv);
  });

  function copyDiagnostics() {
    navigator.clipboard?.writeText(JSON.stringify(dbg, null, 2)).catch(() => { /* denied */ });
  }
  const relayRttText = (m: Record<string, number>): string => {
    const parts = Object.entries(m).map(([id, ms]) => `${id}:${ms}`);
    return parts.length ? parts.join(" ") : "—";
  };
</script>

<aside class="dbg" class:frozen aria-label="connection diagnostics">
  <div class="dbg-head">
    <strong>调试 · 连接诊断{frozen ? " · 已冻结" : ""}</strong>
    <label><input type="checkbox" bind:checked={includeIps} /> 含 IP</label>
    <button type="button" onclick={() => (frozen = !frozen)}>{frozen ? "继续" : "冻结"}</button>
    <button type="button" onclick={copyDiagnostics} disabled={!dbg}>复制</button>
    <button type="button" class="dbg-x" onclick={onclose} title="关闭调试" aria-label="关闭调试"><Icon name="close" size={12} /></button>
  </div>
  {#if relayPool.length}
    <div class="dbg-relay">
      中继选优: <b>{selectedRelayId ?? "测量中…"}</b>
      · 我 {relayRttText(myRelayRtt)} · 对方 {relayRttText(peerRelayRtt)}
    </div>
  {/if}
  {#if dbg}
    <dl>
      <dt>path</dt><dd class:relay={dbg.path === "relay"}>{dbg.path}</dd>
      {#if dbg.rttMs !== undefined}<dt>RTT</dt><dd>{dbg.rttMs} ms</dd>{/if}
      {#if dbg.outgoingBitrateKbps !== undefined}<dt>可用带宽</dt><dd>{dbg.outgoingBitrateKbps} kbps</dd>{/if}
      {#if dbg.local}<dt>local</dt><dd>{dbg.local.candidateType ?? "?"} / {dbg.local.protocol ?? "?"}{dbg.local.relayProtocol ? ` (relay ${dbg.local.relayProtocol})` : ""}{dbg.local.address ? ` ${dbg.local.address}${dbg.local.port ? ":" + dbg.local.port : ""}` : ""}</dd>{/if}
      {#if dbg.remote}<dt>remote</dt><dd>{dbg.remote.candidateType ?? "?"} / {dbg.remote.protocol ?? "?"}{dbg.remote.address ? ` ${dbg.remote.address}${dbg.remote.port ? ":" + dbg.remote.port : ""}` : ""}</dd>{/if}
      {#if dbg.bytesSent !== undefined}<dt>bytes ↑/↓</dt><dd>{dbg.bytesSent} / {dbg.bytesReceived}</dd>{/if}
      {#if dbg.dataChannel}<dt>channel</dt><dd>{dbg.dataChannel.state ?? "?"} · msg {dbg.dataChannel.messagesSent ?? 0}/{dbg.dataChannel.messagesReceived ?? 0}</dd>{/if}
    </dl>
  {:else}
    <p class="dbg-idle">无活动连接 · 开始一次传输后显示</p>
  {/if}
</aside>

<style>
  .dbg {
    position: fixed; inset-inline-end: 8px; bottom: 8px; z-index: 9999;
    max-width: min(92vw, 360px); padding: 8px 10px;
    background: rgba(20, 20, 22, 0.92); color: #e8e8ea;
    border: 1px solid #3a3a40; border-radius: 8px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .dbg.frozen { border-color: #ffb454; }
  .dbg-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; }
  .dbg-head strong { flex: 1 0 100%; font-size: 12px; }
  .dbg-head label { display: flex; align-items: center; gap: 3px; white-space: nowrap; opacity: 0.85; }
  .dbg-head button { padding: 3px 10px; border: 1px solid #55555c; border-radius: 5px; background: #2a2a2e; color: inherit; cursor: pointer; }
  .dbg-head button:disabled { opacity: 0.4; cursor: default; }
  .dbg-head .dbg-x { display: inline-grid; place-items: center; margin-inline-start: auto; padding: 3px 8px; }
  .dbg dl { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 0; }
  .dbg dt { opacity: 0.6; }
  .dbg dd { margin: 0; word-break: break-all; }
  .dbg dd.relay { color: #ffb454; } /* relay path is highlighted — the speed-relevant case */
  .dbg-idle { margin: 0; opacity: 0.7; }
  .dbg-relay { margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #3a3a40; word-break: break-all; }
  .dbg-relay b { color: #7fd88f; }
</style>
