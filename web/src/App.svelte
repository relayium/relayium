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
  import { connect, type InboundSignal, type Conn } from "./lib/webrtc";
  import {
    Sender,
    Receiver,
    ACCEPT,
    REJECT,
    controlKind,
    FRAME,
    CHUNK_OVERHEAD,
    MAX_FILES,
    type FileMeta,
  } from "./lib/transfer";
  import { pickSaveTarget, type SaveTarget, type FileSink } from "./lib/filesink";
  import type { Peer } from "./lib/protocol";

  interface Incoming { from: string; files: FileMeta[]; total: number }
  interface Xfer {
    peer: string;
    dir: "send" | "recv";
    files: FileMeta[];
    index: number; // current file (0-based)
    sent: number; // plaintext bytes done across the batch
    total: number; // plaintext bytes total
    status: string;
    done: boolean;
    ok: boolean;
    speed: number; // bytes/sec
  }

  // Reactive state
  let connState = $state<"connecting" | "ready">("connecting");
  let unsupported = $state<string | null>(null);
  let selfName = $state("");
  let selfId = $state("");
  let peers = $state<Peer[]>([]);
  let sasCode = $state("");

  let incoming = $state<Incoming | null>(null); // pending receive awaiting accept/reject
  let recv = $state<Xfer | null>(null);
  let send = $state<Xfer | null>(null);
  let notice = $state(""); // transient hint (e.g. "busy", "too many files")

  // Non-reactive locals
  let signaling: SignalingClient;
  let acceptFn: (() => void) | null = null;
  let rejectFn: (() => void) | null = null;

  const visiblePeers = $derived(peers.filter((p) => p.id !== selfId));
  const busy = $derived(
    !!incoming || !!(recv && !recv.done) || !!(send && !send.done),
  );

  // Reflect transfer progress in the tab title.
  $effect(() => {
    const x = (send && !send.done && send) || (recv && !recv.done && recv);
    document.title = x
      ? `${pct(x)}% ${x.dir === "send" ? "↑" : "↓"} · Relayium`
      : "Relayium — 端到端加密文件传输";
  });

  onMount(async () => {
    if (!window.isSecureContext || !crypto.subtle) {
      unsupported = "需要 HTTPS（或 localhost）才能进行加密传输。请通过 https:// 访问本页面。";
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
  function flash(msg: string) {
    notice = msg;
    setTimeout(() => { if (notice === msg) notice = ""; }, 3500);
  }

  // ── RECEIVE ──────────────────────────────────────────────────────────────────
  function listenForIncoming() {
    signaling.onSignal(async (from, data) => {
      const msg = data as InboundSignal;
      if (msg.sdp?.type !== "offer") return; // act only on offers
      if (busy) return; // one transfer at a time — ignore until the current one ends
      try {
        await beginReceive(from, msg);
      } catch (err) {
        console.error("relayium receive setup error", err);
        recv = { peer: from, dir: "recv", files: [], index: 0, sent: 0, total: 0, status: "建立连接失败 ✗", done: true, ok: false, speed: 0 };
      }
    });
  }

  async function beginReceive(from: string, offer: InboundSignal) {
    const selfKey = generateKeyPair(); // per-transfer ephemeral keypair
    let keys: SessionKeys | undefined;
    const receiver = new Receiver();
    let target: SaveTarget | undefined;
    let sink: FileSink | undefined;
    let manifest: FileMeta[] = [];
    let total = 0, got = 0, fileIndex = 0, start = 0;
    let allOk = true;

    let r: Xfer = { peer: from, dir: "recv", files: [], index: 0, sent: 0, total: 0, status: "正在建立加密连接…", done: false, ok: false, speed: 0 };
    recv = r;

    const conn: Conn = await connect({
      signaling, peerId: from, selfKey: selfKey.publicKey, role: "responder",
      initialSignal: offer,
      onPeerKey: async (pk) => { keys = await deriveSession("responder", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
    });

    const openSink = async () => {
      const f = manifest[fileIndex];
      sink = f ? await target!.file(f.name, f.size) : undefined;
    };

    // The accept click is the user gesture that lets the save picker open.
    acceptFn = async () => {
      const req = incoming;
      if (!req) return;
      try {
        target = await pickSaveTarget(req.files);
      } catch (err) {
        console.error("relayium save-target error", err);
        recv = r = { ...r, status: "未选择保存位置，已取消", done: true, ok: false };
        incoming = null;
        try { conn.channel.send(REJECT); } catch { /* gone */ }
        conn.close();
        return;
      }
      fileIndex = 0; got = 0; start = Date.now();
      await openSink(); // prepare file 0 (also covers a leading zero-byte file)
      recv = r = { peer: from, dir: "recv", files: req.files, index: 0, sent: 0, total: req.total, status: "接收中…", done: false, ok: false, speed: 0 };
      incoming = null;
      conn.channel.send(ACCEPT);
    };

    rejectFn = () => {
      try { conn.channel.send(REJECT); } catch { /* gone */ }
      incoming = null; recv = null; conn.close();
    };

    const handleFrame = async (buf: ArrayBuffer) => {
      while (!keys) await sleep(5); // queue frames until keys are derived
      const out = await receiver.feed(new Uint8Array(buf), keys);
      if (out.batch) {
        manifest = out.batch.files;
        total = manifest.reduce((n, f) => n + f.size, 0);
        incoming = { from, files: manifest, total };
        recv = null; // the accept card takes over
        return;
      }
      if (out.chunk && sink) {
        await sink.write(out.chunk);
        got += out.chunk.length;
        const elapsed = (Date.now() - start) / 1000;
        recv = r = { ...r, sent: got, index: fileIndex, speed: elapsed > 0 ? got / elapsed : 0 };
        return;
      }
      if (out.done) {
        if (sink) await sink.close();
        allOk = allOk && out.done.ok;
        fileIndex++;
        if (fileIndex < manifest.length) {
          await openSink();
          recv = r = { ...r, index: fileIndex };
        } else {
          const n = manifest.length;
          recv = r = {
            ...r, sent: total, index: n - 1,
            status: allOk ? `接收完成 ✓（${n} 个文件）` : "完整性校验失败 ✗",
            done: true, ok: allOk, speed: 0,
          };
          conn.close();
        }
        return;
      }
    };

    let pending: Promise<void> = Promise.resolve();
    conn.channel.onmessage = (ev) => {
      pending = pending
        .then(() => handleFrame(ev.data as ArrayBuffer))
        .catch((err) => {
          console.error("relayium receive error", err);
          recv = r = { ...r, status: "接收失败 ✗", done: true, ok: false };
          incoming = null;
          conn.close();
        });
    };
  }

  // ── SEND ───────────────────────────────────────────────────────────────────────
  async function sendFiles(peerId: string, picked: FileList | File[]) {
    if (busy) { flash("已有传输进行中，请等待完成"); return; }
    const all = Array.from(picked);
    const files = all.slice(0, MAX_FILES);
    if (files.length === 0) return;
    const dropped = all.length - files.length;

    const metas: FileMeta[] = files.map((f) => ({ name: f.name, size: f.size }));
    const total = metas.reduce((n, m) => n + m.size, 0);
    let s: Xfer = { peer: peerId, dir: "send", files: metas, index: 0, sent: 0, total, status: "正在建立加密连接…", done: false, ok: false, speed: 0 };
    send = s;
    if (dropped > 0) flash(`一次最多 ${MAX_FILES} 个文件，已忽略多余的 ${dropped} 个`);

    const selfKey = generateKeyPair();
    let keys: SessionKeys | undefined;
    let resolveAccept!: (ok: boolean) => void;
    const accepted = new Promise<boolean>((r) => (resolveAccept = r));
    let conn: Conn | undefined;

    try {
      conn = await connect({
        signaling, peerId, selfKey: selfKey.publicKey, role: "initiator",
        onPeerKey: async (pk) => { keys = await deriveSession("initiator", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
      });
      conn.channel.onmessage = (ev) => {
        const k = controlKind(ev.data as ArrayBuffer);
        if (k === "accept") resolveAccept(true);
        else if (k === "reject") resolveAccept(false);
      };
      conn.channel.onclose = () => resolveAccept(false);

      while (!keys) await sleep(20);

      const sender = new Sender();
      conn.channel.send(sender.batchFrame(metas)); // announce the batch; wait for the decision
      send = s = { ...s, status: "等待对方确认接收…" };

      if (!(await accepted)) {
        send = s = { ...s, status: "对方已拒绝 ✗", done: true, ok: false };
        return;
      }

      send = s = { ...s, status: "发送中…" };
      const start = Date.now();
      let sent = 0, idx = 0;
      for await (const frame of sender.dataFrames(files, keys)) {
        await backpressure(conn.channel);
        conn.channel.send(frame);
        if (frame[0] === FRAME.CHUNK) sent += frame.byteLength - CHUNK_OVERHEAD;
        else if (frame[0] === FRAME.DONE) idx++;
        const elapsed = (Date.now() - start) / 1000;
        send = s = { ...s, sent: Math.min(total, sent), index: Math.min(idx, files.length - 1), speed: elapsed > 0 ? sent / elapsed : 0 };
      }
      send = s = { ...s, sent: total, index: files.length - 1, status: `发送完成 ✓（${files.length} 个文件）`, done: true, ok: true, speed: 0 };
    } catch (err) {
      console.error("relayium send error", err);
      send = s = { ...s, status: "发送失败 ✗", done: true, ok: false };
    } finally {
      conn?.close();
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────────
  async function backpressure(ch: RTCDataChannel) {
    if (ch.bufferedAmount > ch.bufferedAmountLowThreshold) {
      await new Promise<void>((resolve) => {
        ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; resolve(); };
      });
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function pct(x: Xfer): number {
    return x.total ? Math.min(100, Math.round((x.sent / x.total) * 100)) : (x.done ? 100 : 0);
  }
  function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
  }
  function formatSpeed(bps: number): string {
    return bps > 0 ? `${formatSize(bps)}/s` : "";
  }

  function pickFile(e: Event, peerId: string) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) sendFiles(peerId, input.files);
    input.value = ""; // allow re-picking the same files
  }
  function onDrop(e: DragEvent, peerId: string) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove("drag");
    const files = e.dataTransfer?.files;
    if (files?.length) sendFiles(peerId, files);
  }
</script>

<main>
  <header>
    <div class="logo">⇌</div>
    <h1>Relayium</h1>
    <p class="tagline">端到端加密的点对点文件传输 · 文件不经过服务器</p>
    <div class="statusbar">
      <span class="dot" class:on={connState === "ready"}></span>
      {#if unsupported}
        无法使用
      {:else if connState === "ready"}
        已连接 · 本机 <b>{selfName}</b>
      {:else}
        正在连接信令服务器…
      {/if}
    </div>
  </header>

  {#if notice}
    <div class="toast">{notice}</div>
  {/if}

  {#if unsupported}
    <div class="banner error">{unsupported}</div>
  {:else}
    <section class="guide">
      <h2>如何使用</h2>
      <ol>
        <li>在<b>同一网络</b>下的另一台设备或浏览器打开本页面（同一公网 IP 归为同一「房间」）。</li>
        <li>双方会出现在下方「附近的设备」列表中。</li>
        <li>点击对方卡片选择文件，或把文件<b>拖到</b>对方卡片上（一次最多 {MAX_FILES} 个）。</li>
        <li>对方点「接收」，<b>核对两边校验码一致</b>后开始传输。</li>
      </ol>
      <p class="hint">推荐 Chrome（大文件流式落盘、多文件可直接选目标文件夹，不占内存）。若同一路由器下互相看不到设备，请关闭路由器的「AP 隔离 / 客户端隔离」。</p>
    </section>

    {#if incoming}
      <section class="card request">
        <div class="req-head">📥 <b>{nameOf(incoming.from)}</b> 想发送 {incoming.files.length} 个文件 · 共 {formatSize(incoming.total)}</div>
        <ul class="filelist">
          {#each incoming.files as f}
            <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
          {/each}
        </ul>
        {#if sasCode}
          <div class="sas">校验码 <code>{sasCode}</code> — 请与发送方屏幕核对一致后再接收</div>
        {/if}
        <div class="actions">
          <button class="primary" onclick={() => acceptFn?.()}>接收</button>
          <button class="ghost" onclick={() => rejectFn?.()}>拒绝</button>
        </div>
      </section>
    {/if}

    {#each [send, recv].filter(Boolean) as x (x!.dir)}
      {@const xf = x as Xfer}
      <section class="card xfer" class:ok={xf.done && xf.ok} class:bad={xf.done && !xf.ok}>
        <div class="xfer-head">
          <span class="label">{xf.dir === "send" ? `发送 → ${nameOf(xf.peer)}` : `接收 ← ${nameOf(xf.peer)}`}</span>
          {#if xf.files.length}<span class="count">{xf.files.length > 1 ? `文件 ${xf.index + 1}/${xf.files.length}` : xf.files[0].name}</span>{/if}
          {#if xf.done}<button class="x" onclick={() => (xf.dir === "send" ? (send = null) : (recv = null))} aria-label="关闭">✕</button>{/if}
        </div>
        <div class="status">
          {xf.status}
          {#if sasCode && !xf.done} · 校验码 <code>{sasCode}</code>{/if}
        </div>
        {#if !xf.done}
          <div class="bar"><div class="fill" style:width="{pct(xf)}%"></div></div>
          <div class="meta">
            <span>{pct(xf)}% · {formatSize(xf.sent)} / {formatSize(xf.total)}</span>
            {#if xf.speed > 0}<span>{formatSpeed(xf.speed)}</span>{/if}
          </div>
        {/if}
      </section>
    {/each}

    <section class="peers">
      <h2>附近的设备</h2>
      {#if visiblePeers.length === 0}
        <p class="empty">还没有其它设备。请在同一网络下的另一台设备 / 另一个浏览器窗口打开本页面。</p>
      {:else}
        <ul>
          {#each visiblePeers as p (p.id)}
            <li
              class="peer"
              class:disabled={busy}
              ondragover={(e) => { e.preventDefault(); if (!busy) (e.currentTarget as HTMLElement).classList.add("drag"); }}
              ondragleave={(e) => (e.currentTarget as HTMLElement).classList.remove("drag")}
              ondrop={(e) => { if (busy) { e.preventDefault(); flash("已有传输进行中，请等待完成"); return; } onDrop(e, p.id); }}
            >
              <label>
                <span class="pavatar">{p.name.slice(0, 1).toUpperCase()}</span>
                <span class="ptext">
                  <span class="pname">{p.name}</span>
                  <span class="pick">点击选择文件 · 或拖放到此处（最多 {MAX_FILES} 个）</span>
                </span>
                <input type="file" multiple disabled={busy} onchange={(e) => pickFile(e, p.id)} />
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <footer>端到端加密（X25519 + AES-256-GCM）· 信令服务器只转发连接信息，看不到文件内容</footer>
  {/if}
</main>

<style>
  main {
    width: 660px;
    max-width: 100%;
    margin: 0 auto;
    padding: 0 20px 48px;
    box-sizing: border-box;
    text-align: left;
  }

  header { text-align: center; padding-top: 40px; }
  .logo {
    width: 56px; height: 56px; line-height: 56px;
    margin: 0 auto 10px;
    font-size: 30px; color: #fff;
    border-radius: 16px;
    background: linear-gradient(135deg, var(--accent), #6d28d9);
    box-shadow: var(--shadow);
  }
  h1 { font-size: 44px; margin: 0 0 6px; letter-spacing: -1.2px; }
  .tagline { color: var(--text); font-size: 15px; }

  .statusbar {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 14px; margin-top: 16px;
    padding: 6px 14px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--social-bg);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
  .dot.on { background: #2ecc71; box-shadow: 0 0 0 3px rgba(46, 204, 113, .18); }

  h2 { font-size: 18px; margin: 0 0 12px; }

  .toast {
    position: sticky; top: 12px; z-index: 5;
    margin: 16px 0 0; padding: 10px 14px;
    border-radius: 10px; font-size: 14px; text-align: center;
    color: var(--text-h); background: var(--accent-bg);
    border: 1px solid var(--accent-border);
  }

  .banner.error {
    margin-top: 24px; padding: 16px; border-radius: 12px; text-align: center;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }

  .guide { margin: 32px 0 24px; }
  .guide ol { margin: 0; padding-left: 22px; }
  .guide li { margin: 7px 0; }
  .guide .hint { margin-top: 12px; font-size: 13.5px; color: var(--text); }

  .card {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px 18px;
    margin-bottom: 16px;
    background: var(--social-bg);
  }
  .card.ok { border-color: #2ecc71; }
  .card.bad { border-color: var(--accent-border); }
  .card.request { border-color: var(--accent-border); background: var(--accent-bg); }

  .req-head { font-size: 15px; margin-bottom: 10px; }
  .filelist { list-style: none; margin: 0 0 12px; padding: 0; max-height: 200px; overflow: auto; }
  .filelist li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px dashed var(--border); font-size: 14px; }
  .filelist li:last-child { border-bottom: none; }
  .fname { color: var(--text-h); word-break: break-all; }
  .fsize { color: var(--text); white-space: nowrap; }
  .sas { font-size: 13.5px; margin-bottom: 14px; }

  .actions { display: flex; gap: 10px; }
  button {
    font: inherit; font-size: 15px; padding: 9px 22px; border-radius: 9px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg); color: var(--text-h);
    transition: filter .15s, box-shadow .15s, transform .05s;
  }
  button:hover { box-shadow: var(--shadow); }
  button:active { transform: translateY(1px); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { filter: brightness(1.08); }

  .xfer-head { display: flex; align-items: center; gap: 10px; }
  .xfer-head .label { color: var(--accent); font-size: 14px; font-weight: 500; white-space: nowrap; }
  .xfer-head .count { color: var(--text); font-size: 13px; margin-left: auto; word-break: break-all; text-align: right; }
  button.x { margin-left: 8px; padding: 2px 8px; font-size: 13px; border-radius: 7px; color: var(--text); }
  .status { font-size: 13.5px; color: var(--text); margin: 8px 0 10px; }

  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s ease; }
  .meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: 12.5px; color: var(--text); }

  .peers { margin-top: 8px; }
  .peers ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  .peer {
    border: 1.5px dashed var(--border); border-radius: 14px;
    transition: border-color .15s, background .15s;
  }
  .peer:not(.disabled):hover, .peer:global(.drag) { border-color: var(--accent-border); background: var(--accent-bg); }
  .peer.disabled { opacity: .5; }
  .peer label { display: flex; align-items: center; gap: 14px; padding: 14px 16px; cursor: pointer; }
  .peer.disabled label { cursor: not-allowed; }
  .pavatar {
    flex: none; width: 40px; height: 40px; line-height: 40px; text-align: center;
    border-radius: 50%; color: #fff; font-weight: 600;
    background: linear-gradient(135deg, var(--accent), #6d28d9);
  }
  .ptext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .pname { color: var(--text-h); font-weight: 500; font-size: 16px; }
  .pick { color: var(--text); font-size: 13px; }
  .peer input[type="file"] { display: none; }

  .empty { color: var(--text); font-size: 14px; }

  footer {
    margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--border);
    text-align: center; font-size: 12.5px; color: var(--text);
  }

  @media (max-width: 1024px) {
    h1 { font-size: 34px; }
    header { padding-top: 28px; }
  }
</style>
