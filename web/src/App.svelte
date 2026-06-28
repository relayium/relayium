<script lang="ts">
  import { onMount } from "svelte";
  import {
    ready,
    generateKeyPair,
    deriveSession,
    sas,
    type SessionKeys,
  } from "./lib/crypto";
  import { SignalingClient } from "./lib/signaling";
  import { connect, type InboundSignal } from "./lib/webrtc";
  import { Sender, Receiver, ACCEPT, REJECT, controlKind } from "./lib/transfer";
  import { createFileSink, type FileSink } from "./lib/filesink";
  import type { Peer } from "./lib/protocol";

  interface Incoming { from: string; name: string; size: number }
  interface Active { peer: string; name: string; progress: number; status: string; done: boolean; ok: boolean }

  // Reactive state — Svelte 5 $state runes
  let connState = $state<"connecting" | "ready">("connecting");
  let unsupported = $state<string | null>(null);
  let selfName = $state("");
  let selfId = $state("");
  let peers = $state<Peer[]>([]);
  let sasCode = $state("");

  let incoming = $state<Incoming | null>(null); // pending receive request awaiting accept/reject
  let recv = $state<Active | null>(null); // active/finished receive
  let send = $state<Active | null>(null); // active/finished send

  // Non-reactive locals
  let signaling: SignalingClient;
  const activePeers = new Set<string>();
  let acceptFn: (() => void) | null = null;
  let rejectFn: (() => void) | null = null;

  const visiblePeers = $derived(peers.filter((p) => p.id !== selfId));

  onMount(async () => {
    if (!window.isSecureContext || !crypto.subtle) {
      unsupported =
        "需要 HTTPS（或 localhost）才能进行加密传输。请通过 https:// 访问本页面。";
      return;
    }
    await ready();
    selfName = deviceName();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    signaling = new SignalingClient(`${proto}://${location.host}/ws`, selfName);
    signaling.onSelfId((id) => (selfId = id));
    signaling.onPeers((p) => (peers = p));
    listenForIncoming();
    connState = "ready";
  });

  function deviceName(): string {
    const base = navigator.platform || "设备";
    return `${base}-${Math.floor(Math.random() * 1000)}`;
  }

  function nameOf(peerId: string): string {
    return peers.find((p) => p.id === peerId)?.name ?? peerId.slice(0, 6);
  }

  // ── RECEIVE ────────────────────────────────────────────────────────────────
  function listenForIncoming() {
    signaling.onSignal(async (from, data) => {
      const msg = data as InboundSignal;
      if (msg.sdp?.type !== "offer") return; // act only on offers
      if (activePeers.has(from)) return; // already handling this peer
      activePeers.add(from);
      try {
        await beginReceive(from, msg);
      } catch (err) {
        console.error("relayium receive setup error", err);
        recv = { peer: from, name: "", progress: 0, status: "建立连接失败 ✗", done: true, ok: false };
        cleanup(from);
      }
    });
  }

  async function beginReceive(from: string, offer: InboundSignal) {
    const selfKey = generateKeyPair(); // per-transfer ephemeral keypair
    let keys: SessionKeys | undefined;
    const receiver = new Receiver();
    let sink: FileSink | undefined;
    let total = 0, got = 0;

    recv = { peer: from, name: "", progress: 0, status: "正在建立加密连接…", done: false, ok: false };

    const channel = await connect({
      signaling,
      peerId: from,
      selfKey: selfKey.publicKey,
      role: "responder",
      initialSignal: offer, // pass the offer so it isn't lost
      onPeerKey: async (pk) => {
        keys = await deriveSession("responder", selfKey, pk);
        sasCode = sas(selfKey.publicKey, pk);
      },
    });

    // User clicked "接收": this is the gesture that lets showSaveFilePicker run.
    acceptFn = async () => {
      const req = incoming;
      if (!req) return;
      let opened: FileSink;
      try {
        opened = await createFileSink(req.name, req.size); // needs the click's user activation
      } catch (err) {
        console.error("relayium save-target error", err);
        recv = { peer: from, name: req.name, progress: 0, status: "未选择保存位置，已取消", done: true, ok: false };
        incoming = null;
        try { channel.send(REJECT); } catch { /* channel may be gone */ }
        cleanup(from);
        return;
      }
      sink = opened;
      total = req.size;
      recv = { peer: from, name: req.name, progress: 0, status: "接收中…", done: false, ok: false };
      incoming = null;
      channel.send(ACCEPT); // tell the sender to start streaming chunks
    };

    rejectFn = () => {
      try { channel.send(REJECT); } catch { /* ignore */ }
      incoming = null;
      recv = null;
      cleanup(from);
    };

    const handleFrame = async (buf: ArrayBuffer) => {
      while (!keys) await sleep(5); // queue frames until keys are derived
      const out = await receiver.feed(new Uint8Array(buf), keys);
      if (out.meta) {
        // Show the confirmation card; do NOT touch disk yet (no gesture).
        incoming = { from, name: out.meta.name, size: out.meta.size };
        recv = null;
        return;
      }
      if (out.chunk && sink) {
        await sink.write(out.chunk);
        got += out.chunk.length;
        recv = { ...(recv as Active), progress: total ? Math.round((got / total) * 100) : 0 };
        return;
      }
      if (out.done) {
        if (sink) await sink.close();
        recv = {
          ...(recv as Active),
          progress: 100,
          status: out.done.ok ? "接收完成 ✓" : "完整性校验失败 ✗",
          done: true,
          ok: out.done.ok,
        };
        cleanup(from);
      }
    };

    let pending: Promise<void> = Promise.resolve();
    channel.onmessage = (ev) => {
      pending = pending
        .then(() => handleFrame(ev.data as ArrayBuffer))
        .catch((err) => {
          console.error("relayium receive error", err);
          recv = { peer: from, name: incoming?.name ?? recv?.name ?? "", progress: recv?.progress ?? 0, status: "接收失败 ✗", done: true, ok: false };
          incoming = null;
          cleanup(from);
        });
    };
  }

  // ── SEND ─────────────────────────────────────────────────────────────────────
  async function sendTo(peerId: string, file: File) {
    if (activePeers.has(peerId)) return; // a transfer with this peer is already in flight
    activePeers.add(peerId);
    send = { peer: peerId, name: file.name, progress: 0, status: "正在建立加密连接…", done: false, ok: false };

    const selfKey = generateKeyPair(); // per-transfer ephemeral keypair
    let keys: SessionKeys | undefined;
    let resolveAccept!: (ok: boolean) => void;
    const accepted = new Promise<boolean>((r) => (resolveAccept = r));

    try {
      const channel = await connect({
        signaling,
        peerId,
        selfKey: selfKey.publicKey,
        role: "initiator",
        onPeerKey: async (pk) => {
          keys = await deriveSession("initiator", selfKey, pk);
          sasCode = sas(selfKey.publicKey, pk);
        },
      });
      channel.onmessage = (ev) => {
        const k = controlKind(ev.data as ArrayBuffer);
        if (k === "accept") resolveAccept(true);
        else if (k === "reject") resolveAccept(false);
      };
      channel.onclose = () => resolveAccept(false);

      while (!keys) await sleep(20);

      const sender = new Sender();
      channel.send(sender.metaFrame(file)); // announce the file; wait for the peer's decision
      send = { peer: peerId, name: file.name, progress: 0, status: "等待对方确认接收…", done: false, ok: false };

      const ok = await accepted;
      if (!ok) {
        send = { peer: peerId, name: file.name, progress: 0, status: "对方已拒绝 ✗", done: true, ok: false };
        return;
      }

      send = { peer: peerId, name: file.name, progress: 0, status: "发送中…", done: false, ok: false };
      let sent = 0;
      for await (const frame of sender.dataFrames(file, keys)) {
        await backpressure(channel);
        channel.send(frame);
        sent += frame.byteLength;
        send = { ...send, progress: Math.min(100, Math.round((sent / file.size) * 100)) };
      }
      send = { peer: peerId, name: file.name, progress: 100, status: "发送完成 ✓", done: true, ok: true };
    } catch (err) {
      console.error("relayium send error", err);
      send = { peer: peerId, name: file.name, progress: 0, status: "发送失败 ✗", done: true, ok: false };
    } finally {
      cleanup(peerId);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  function cleanup(peerId: string) {
    activePeers.delete(peerId); // allow a fresh transfer with this peer later
  }

  async function backpressure(ch: RTCDataChannel) {
    if (ch.bufferedAmount > ch.bufferedAmountLowThreshold) {
      await new Promise<void>((resolve) => {
        ch.onbufferedamountlow = () => {
          ch.onbufferedamountlow = null;
          resolve();
        };
      });
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }

  function pickFile(e: Event, peerId: string) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    if (f) sendTo(peerId, f);
    input.value = ""; // allow picking the same file again
  }

  function onDrop(e: DragEvent, peerId: string) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove("drag");
    const file = e.dataTransfer?.files?.[0];
    if (file) sendTo(peerId, file);
  }
</script>

<main>
  <header>
    <h1>Relayium</h1>
    <p class="tagline">端到端加密的点对点文件传输 · 文件不经过服务器</p>
  </header>

  {#if unsupported}
    <div class="banner error">{unsupported}</div>
  {:else}
    <div class="statusbar">
      <span class="dot" class:on={connState === "ready"}></span>
      {#if connState === "ready"}
        已连接 · 本机：<b>{selfName}</b>
      {:else}
        正在连接信令服务器…
      {/if}
    </div>

    <section class="guide">
      <h2>如何使用</h2>
      <ol>
        <li>在<b>同一网络</b>下的另一台设备或浏览器打开本页面（同一公网 IP 归为同一「房间」）。</li>
        <li>双方会出现在下方「附近的设备」列表中。</li>
        <li>点击对方卡片选择文件，或把文件<b>拖到</b>对方卡片上。</li>
        <li>对方点「接收」，<b>核对两边校验码一致</b>后开始传输。</li>
      </ol>
      <p class="hint">提示：推荐使用 Chrome（大文件可流式落盘，不占内存）。若同一路由器下互相看不到设备，请关闭路由器的「AP 隔离 / 客户端隔离」。</p>
    </section>

    {#if incoming}
      <section class="card request">
        <div class="req-head">📥 <b>{nameOf(incoming.from)}</b> 想发送文件</div>
        <div class="file">
          <span class="fname">{incoming.name}</span>
          <span class="fsize">{formatSize(incoming.size)}</span>
        </div>
        {#if sasCode}
          <div class="sas">校验码 <code>{sasCode}</code> — 请与发送方屏幕核对一致</div>
        {/if}
        <div class="actions">
          <button class="primary" onclick={() => acceptFn?.()}>接收</button>
          <button class="ghost" onclick={() => rejectFn?.()}>拒绝</button>
        </div>
      </section>
    {/if}

    {#if recv}
      <section class="card" class:ok={recv.done && recv.ok} class:bad={recv.done && !recv.ok}>
        <div class="row"><span class="label">接收</span><span class="fname">{recv.name}</span></div>
        <div class="status">{recv.status}{#if sasCode && !recv.done} · 校验码 <code>{sasCode}</code>{/if}</div>
        {#if !recv.done}<progress value={recv.progress} max="100"></progress> <span class="pct">{recv.progress}%</span>{/if}
      </section>
    {/if}

    {#if send}
      <section class="card" class:ok={send.done && send.ok} class:bad={send.done && !send.ok}>
        <div class="row"><span class="label">发送 → {nameOf(send.peer)}</span><span class="fname">{send.name}</span></div>
        <div class="status">{send.status}{#if sasCode && !send.done} · 校验码 <code>{sasCode}</code>{/if}</div>
        {#if !send.done}<progress value={send.progress} max="100"></progress> <span class="pct">{send.progress}%</span>{/if}
      </section>
    {/if}

    <section class="peers">
      <h2>附近的设备</h2>
      {#if visiblePeers.length === 0}
        <p class="empty">还没有其它设备。请在同一网络下的另一台设备 / 另一个浏览器窗口打开本页面。</p>
      {:else}
        <ul>
          {#each visiblePeers as p (p.id)}
            <li
              class="peer"
              ondragover={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("drag"); }}
              ondragleave={(e) => (e.currentTarget as HTMLElement).classList.remove("drag")}
              ondrop={(e) => onDrop(e, p.id)}
            >
              <label>
                <span class="pname">{p.name}</span>
                <span class="pick">选择文件 / 拖到此处</span>
                <input type="file" onchange={(e) => pickFile(e, p.id)} />
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    width: 680px;
    max-width: 100%;
    margin: 0 auto;
    padding: 0 20px 64px;
    box-sizing: border-box;
    text-align: left;
  }
  header { text-align: center; }
  h1 { margin: 36px 0 8px; }
  .tagline { color: var(--text); margin-bottom: 8px; }

  .statusbar {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: center;
    font-size: 15px;
    margin: 0 0 28px;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #d0a; opacity: .5; background: var(--border); }
  .dot.on { background: #2ecc71; opacity: 1; }

  h2 { font-size: 19px; margin: 0 0 12px; }

  .guide ol { margin: 0; padding-left: 22px; }
  .guide li { margin: 6px 0; }
  .guide .hint { margin-top: 12px; font-size: 14px; color: var(--text); }
  .guide { margin-bottom: 28px; }

  .banner.error {
    border: 1px solid var(--accent-border);
    background: var(--accent-bg);
    color: var(--text-h);
    padding: 16px;
    border-radius: 10px;
    text-align: center;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
    margin-bottom: 18px;
    background: var(--social-bg);
  }
  .card.ok { border-color: #2ecc71; }
  .card.bad { border-color: var(--accent-border); }
  .card.request { border-color: var(--accent-border); background: var(--accent-bg); }

  .req-head { font-size: 16px; margin-bottom: 10px; }
  .file { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  .fname { color: var(--text-h); font-weight: 500; word-break: break-all; }
  .fsize { color: var(--text); font-size: 14px; white-space: nowrap; }
  .sas { font-size: 14px; margin-bottom: 14px; }

  .actions { display: flex; gap: 10px; }
  button {
    font: inherit;
    font-size: 15px;
    padding: 9px 22px;
    border-radius: 8px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-h);
    transition: filter .15s, box-shadow .15s;
  }
  button:hover { box-shadow: var(--shadow); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { filter: brightness(1.08); }

  .row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .label { color: var(--accent); font-size: 14px; white-space: nowrap; }
  .status { font-size: 14px; color: var(--text); margin: 6px 0 8px; }
  progress { width: 100%; height: 8px; vertical-align: middle; }
  .pct { font-size: 13px; color: var(--text); }

  .peers ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  .peer {
    border: 1.5px dashed var(--border);
    border-radius: 12px;
    transition: border-color .15s, background .15s;
  }
  .peer:hover, .peer:global(.drag) { border-color: var(--accent-border); background: var(--accent-bg); }
  .peer label { display: flex; flex-direction: column; gap: 4px; padding: 16px 18px; cursor: pointer; }
  .pname { color: var(--text-h); font-weight: 500; font-size: 17px; }
  .pick { color: var(--text); font-size: 14px; }
  .peer input[type="file"] { display: none; }

  .empty { color: var(--text); }
</style>
