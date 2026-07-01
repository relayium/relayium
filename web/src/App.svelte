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
  import { wsURL } from "./lib/transfer-link";
  import { roomToken as roomTokenStore, roomCode as roomCodeStore, initRoomFromLocation } from "./lib/room.svelte";
  import { connect, type InboundSignal, type Conn } from "./lib/webrtc";
  import {
    Sender,
    Receiver,
    ACCEPT,
    REJECT,
    COMPLETE,
    controlKind,
    FRAME,
    CHUNK_OVERHEAD,
    MAX_FILES,
    type FileMeta,
  } from "./lib/transfer";
  import { pickSaveTarget, type SaveTarget, type FileSink } from "./lib/filesink";
  import { fetchIceServers } from "./lib/ice";
  import type { Peer } from "./lib/protocol";
  import { lang, messages, legalUrl, type Messages, type StatusKey } from "./lib/i18n.svelte";
  import { hasFiles, dropTarget } from "./lib/drag";
  import CrossPage from "./lib/CrossPage.svelte";
  import Nav from "./lib/Nav.svelte";
  import { currentRoute, syncRouteFromLocation, downloadId, navigate } from "./lib/router.svelte";
  import Hero from "./lib/Hero.svelte";
  import DownloadPage from "./lib/DownloadPage.svelte";
  import FeatureStrip from "./lib/FeatureStrip.svelte";
  import UseCases from "./lib/UseCases.svelte";
  import Faq from "./lib/Faq.svelte";

  interface Incoming { from: string; files: FileMeta[]; total: number }
  interface Xfer {
    peer: string;
    dir: "send" | "recv";
    files: FileMeta[];
    index: number; // current file (0-based)
    sent: number; // plaintext bytes done across the batch
    total: number; // plaintext bytes total
    status: StatusKey; // translated at render time so it follows the language switch
    done: boolean;
    ok: boolean;
    speed: number; // bytes/sec
  }

  // Reactive state
  let connState = $state<"connecting" | "ready">("connecting");
  let unsupported = $state(false);
  let selfName = $state("");
  let selfId = $state("");
  let selfIP = $state("");
  let peers = $state<Peer[]>([]);
  let sasCode = $state("");

  let incoming = $state<Incoming | null>(null); // pending receive awaiting accept/reject
  let recv = $state<Xfer | null>(null);
  let send = $state<Xfer | null>(null);
  let notice = $state(""); // transient hint (e.g. "busy", "too many files")
  let dragActive = $state(false);
  let dragDepth = 0; // non-reactive: dragenter/dragleave fire per element; count to know when the drag truly leaves the window
  // The active room lives in the URL-driven store; read reactively here so a live
  // room switch (no reload) reconnects the socket via the effect below.
  const roomToken = $derived(roomTokenStore());
  const roomCode = $derived(roomCodeStore());
  let joinedRoom = $state(false);
  let linkDead = $state(false);

  // Non-reactive locals
  let signaling: SignalingClient;
  let socketRoomKey = ""; // which room the current socket is bound to; guards the reconnect effect
  let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  let acceptFn: (() => void) | null = null;
  let rejectFn: (() => void) | null = null;
  // Abort handles for an in-flight transfer — let the user bail out of a stuck
  // send/receive and return to idle (so they can pick another method).
  let sendAbort: (() => void) | null = null;
  let recvAbort: (() => void) | null = null;

  const t = $derived<Messages>(messages[lang()]);
  const visiblePeers = $derived(peers.filter((p) => p.id !== selfId));
  const busy = $derived(
    !!incoming || !!(recv && !recv.done) || !!(send && !send.done),
  );
  const showTransfer = $derived(visiblePeers.length > 0 || busy);

  // The window-wide drop only makes sense where the device cards are actually
  // rendered: the LAN page (unless unsupported), or the cross page once a
  // realtime peer is connected. Never on the download page.
  const surfaceShown = $derived(
    currentRoute() === "download"
      ? false
      : currentRoute() === "cross"
        ? showTransfer
        : !unsupported,
  );

  // Reflect transfer progress in the tab title (follows the language switch).
  $effect(() => {
    const x = (send && !send.done && send) || (recv && !recv.done && recv);
    document.title = x
      ? `${pct(x)}% ${x.dir === "send" ? "↑" : "↓"} · Relayium`
      : messages[lang()].titleDefault;
  });

  onMount(async () => {
    document.documentElement.lang = lang();
    initRoomFromLocation();
    syncRouteFromLocation();
    window.addEventListener("popstate", onPopState);
    if (!window.isSecureContext || !crypto.subtle) {
      unsupported = true;
      return;
    }
    await ready();
    selfName = deviceName();
    iceServers = await fetchIceServers(roomToken, roomCode);
    signaling = new SignalingClient(wsURL(location, roomToken, roomCode), selfName);
    signaling.onSelfId((id, ip) => { selfId = id; selfIP = ip; joinedRoom = true; });
    signaling.onPeers((p) => (peers = p));
    signaling.onClose(() => {
      // In a token-room, a close before we ever joined means the link was
      // invalid/expired or the room was full.
      if ((roomToken || roomCode) && !joinedRoom) linkDead = true;
    });
    listenForIncoming();
    socketRoomKey = `${roomToken}|${roomCode}`;
    connState = "ready";
  });

  function onPopState() {
    syncRouteFromLocation();
    initRoomFromLocation();
  }

  // Switch the signaling socket to a newly-entered room without reloading the page.
  // Only reached after the socket exists; reconnection happens pre-transfer, so there
  // is no in-flight WebRTC session to preserve — we reset room-scoped state and rebind.
  async function switchRoom() {
    // Tear down any in-flight transfer/connection before rebinding — switching
    // methods mid-transfer must not leak the old WebRTC session or leave the UI
    // wedged as "busy".
    sendAbort?.();
    recvAbort?.();
    peers = [];
    selfId = "";
    selfIP = "";
    joinedRoom = false;
    linkDead = false;
    incoming = null;
    send = null;
    recv = null;
    sasCode = "";
    iceServers = await fetchIceServers(roomToken, roomCode);
    signaling.reconnect(wsURL(location, roomToken, roomCode));
  }

  $effect(() => {
    const key = `${roomToken}|${roomCode}`;
    if (!signaling) return; // socket not built yet (initial mount)
    if (key === socketRoomKey) return; // already bound to this room
    socketRoomKey = key;
    void switchRoom();
  });

  onMount(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      dragDepth++;
      dragActive = true;
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      e.preventDefault(); // without this the browser opens the dropped file
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dragActive = false;
    };
    const onWindowDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      dragDepth = 0;
      dragActive = false;
      if (surfaceShown && dropTarget(visiblePeers.length, busy) === "send") {
        const files = e.dataTransfer?.files;
        if (files?.length) sendFiles(visiblePeers[0].id, files);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onWindowDrop);
    };
  });

  function deviceName(): string {
    const base = navigator.platform || "device";
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
        recv = { peer: from, dir: "recv", files: [], index: 0, sent: 0, total: 0, status: "connectFail", done: true, ok: false, speed: 0 };
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

    let r: Xfer = { peer: from, dir: "recv", files: [], index: 0, sent: 0, total: 0, status: "connecting", done: false, ok: false, speed: 0 };
    recv = r;

    // Stall detection: a receive that goes quiet for STALL_MS (peer vanished, path
    // died before ICE noticed) is failed rather than left frozen mid-progress.
    let conn: Conn | undefined;
    let lastActivity = Date.now();
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const clearWatchdog = () => { if (watchdog) { clearInterval(watchdog); watchdog = undefined; } };
    // Central "this receive is dead" path: mark failed once, stop the watchdog,
    // drop any pending accept card, and tear down the connection.
    const failRecv = (status: StatusKey) => {
      if (r.done) return;
      clearWatchdog();
      recv = r = { ...r, status, done: true, ok: false };
      incoming = null;
      recvAbort = null;
      conn?.close();
    };

    conn = await connect({
      signaling, peerId: from, selfKey: selfKey.publicKey, role: "responder",
      initialSignal: offer,
      onPeerKey: async (pk) => { keys = await deriveSession("responder", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
      config: { iceServers },
      // A drop ICE can't recover surfaces as a failed receive instead of a
      // progress bar stuck forever. The normal end-of-batch close also fires
      // "closed", but failRecv is a no-op once the batch is already done.
      onStateChange: (state) => { if (state === "failed" || state === "closed") failRecv("recvFail"); },
    });

    // User pressed cancel: tear down and return to idle (not a failure card).
    recvAbort = () => {
      clearWatchdog();
      conn?.close();
      recv = null;
      incoming = null;
      sasCode = "";
      recvAbort = null;
    };

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
        recv = r = { ...r, status: "noSave", done: true, ok: false };
        incoming = null;
        try { conn!.channel.send(REJECT); } catch { /* gone */ }
        conn!.close();
        return;
      }
      fileIndex = 0; got = 0; start = Date.now();
      await openSink(); // prepare file 0 (also covers a leading zero-byte file)
      recv = r = { peer: from, dir: "recv", files: req.files, index: 0, sent: 0, total: req.total, status: "receiving", done: false, ok: false, speed: 0 };
      incoming = null;
      conn!.channel.send(ACCEPT);
      // Arm the stall watchdog only once data is actually expected.
      lastActivity = Date.now();
      watchdog = setInterval(() => {
        if (!r.done && Date.now() - lastActivity > 45_000) failRecv("recvFail");
      }, 5_000);
    };

    rejectFn = () => {
      clearWatchdog();
      recvAbort = null;
      try { conn!.channel.send(REJECT); } catch { /* gone */ }
      incoming = null; recv = null; conn!.close();
    };

    const handleFrame = async (buf: ArrayBuffer) => {
      while (!keys) {
        if (r.done) return; // connection failed/cancelled during handshake — drop the frame
        await sleep(5); // queue frames until keys are derived
      }
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
        lastActivity = Date.now(); // progress resets the stall watchdog
        const elapsed = (Date.now() - start) / 1000;
        recv = r = { ...r, sent: got, index: fileIndex, speed: elapsed > 0 ? got / elapsed : 0 };
        return;
      }
      if (out.done) {
        lastActivity = Date.now();
        if (sink) await sink.close();
        allOk = allOk && out.done.ok;
        fileIndex++;
        if (fileIndex < manifest.length) {
          await openSink();
          recv = r = { ...r, index: fileIndex };
        } else {
          clearWatchdog();
          recvAbort = null;
          const n = manifest.length;
          recv = r = {
            ...r, sent: total, index: n - 1,
            status: allOk ? "recvDone" : "integrityFail",
            done: true, ok: allOk, speed: 0,
          };
          // Tell the sender we have the whole batch so it can close without dropping
          // any still-buffered tail. Delay our own close so the ack actually flushes.
          try { conn!.channel.send(COMPLETE); } catch { /* gone */ }
          setTimeout(() => conn!.close(), 1500);
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
          failRecv("recvFail");
        });
    };
  }

  // ── SEND ───────────────────────────────────────────────────────────────────────
  async function sendFiles(peerId: string, picked: FileList | File[]) {
    if (busy) { flash(messages[lang()].busy); return; }
    const all = Array.from(picked);
    const files = all.slice(0, MAX_FILES);
    if (files.length === 0) return;
    const dropped = all.length - files.length;

    const metas: FileMeta[] = files.map((f) => ({ name: f.name, size: f.size }));
    const total = metas.reduce((n, m) => n + m.size, 0);
    let s: Xfer = { peer: peerId, dir: "send", files: metas, index: 0, sent: 0, total, status: "connecting", done: false, ok: false, speed: 0 };
    send = s;
    if (dropped > 0) flash(messages[lang()].tooMany(MAX_FILES, dropped));

    const selfKey = generateKeyPair();
    let keys: SessionKeys | undefined;
    let resolveAccept!: (ok: boolean) => void;
    const accepted = new Promise<boolean>((r) => (resolveAccept = r));
    let resolveComplete!: () => void;
    const completed = new Promise<void>((r) => (resolveComplete = r));
    let conn: Conn | undefined;
    let connLost = false;
    let cancelled = false;

    // User pressed cancel: unblock every await, tear down, and clear the card so
    // the UI returns to idle (not a failure state) and other methods reopen.
    sendAbort = () => {
      cancelled = true;
      connLost = true;
      resolveAccept(false);
      resolveComplete();
      conn?.close();
      send = null;
      sasCode = "";
    };

    try {
      conn = await connect({
        signaling, peerId, selfKey: selfKey.publicKey, role: "initiator",
        onPeerKey: async (pk) => { keys = await deriveSession("initiator", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
        config: { iceServers },
        // A drop that ICE can't recover unblocks every await so the loop stops
        // instead of hanging; the post-await connLost checks turn it into a
        // visible failure the user can retry.
        onStateChange: (state) => {
          if (state === "failed" || state === "closed") {
            connLost = true;
            resolveAccept(false);
            resolveComplete();
          }
        },
      });
      conn.channel.onmessage = (ev) => {
        const k = controlKind(ev.data as ArrayBuffer);
        if (k === "accept") resolveAccept(true);
        else if (k === "reject") resolveAccept(false);
        else if (k === "complete") resolveComplete();
      };
      conn.channel.onclose = () => resolveAccept(false);

      // Wait for the peer's key (arrives with the answer). Bail if the connection
      // dies during the handshake so this doesn't spin forever.
      while (!keys) {
        if (connLost) throw new Error("connection lost before key exchange");
        await sleep(20);
      }

      const sender = new Sender();
      conn.channel.send(sender.batchFrame(metas)); // announce the batch; wait for the decision
      send = s = { ...s, status: "waitingAccept" };

      const ok = await accepted;
      if (connLost) throw new Error("connection lost");
      if (!ok) {
        send = s = { ...s, status: "rejected", done: true, ok: false };
        return;
      }

      send = s = { ...s, status: "sending" };
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
      // All frames are queued, but channel.send() only buffers them. Closing now would
      // drop whatever is still in flight (the receiver would stall short of 100%), so
      // wait for the receiver's completion ack — or our buffer to drain — before closing.
      send = s = { ...s, sent: total, index: files.length - 1, status: "finishing", speed: 0 };
      await flush(conn.channel, completed);
      if (connLost) throw new Error("connection lost");
      send = s = { ...s, status: "sendDone", done: true, ok: true };
    } catch (err) {
      if (!cancelled) {
        console.error("relayium send error", err);
        send = s = { ...s, status: "sendFail", done: true, ok: false };
      }
    } finally {
      conn?.close();
      sendAbort = null;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────────
  // Wait for the in-flight buffer to drain below the window before sending more.
  // Bounded: if the peer stops draining (frozen tab, dead path that hasn't yet
  // surfaced as an ICE failure) the low-water event never fires, so time out and
  // let the send loop error instead of hanging forever.
  async function backpressure(ch: RTCDataChannel) {
    if (ch.bufferedAmount <= ch.bufferedAmountLowThreshold) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ch.onbufferedamountlow = null;
        reject(new Error("send stalled: peer stopped draining"));
      }, 60_000);
      ch.onbufferedamountlow = () => {
        clearTimeout(timer);
        ch.onbufferedamountlow = null;
        resolve();
      };
    });
  }

  // Wait until it is safe to close: ideally the receiver's explicit completion ack,
  // otherwise our send buffer draining plus a grace period for in-flight delivery
  // (bounded so a dead peer can't hang the sender forever).
  async function flush(ch: RTCDataChannel, completed: Promise<void>) {
    const fallback = (async () => {
      for (let i = 0; i < 600 && ch.bufferedAmount > 0; i++) await sleep(50); // up to ~30s
      await sleep(1000);
    })();
    await Promise.race([completed, fallback]);
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function pct(x: Xfer): number {
    return x.total ? Math.min(100, Math.round((x.sent / x.total) * 100)) : (x.done ? 100 : 0);
  }
  // Resolve a status key against the active language at render time.
  function statusText(m: Messages, x: Xfer): string {
    if (x.status === "sendDone") return m.status.sendDone(x.files.length);
    if (x.status === "recvDone") return m.status.recvDone(x.files.length);
    return m.status[x.status] as string;
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
{#snippet transferSurface()}
  {@const solo = visiblePeers.length === 1}
  <section class="peers">
    <h2>{currentRoute() === "cross" ? t.crossPeersTitle : t.peersTitle}</h2>
    {#if visiblePeers.length === 0}
      <p class="empty">{t.emptyPeers}</p>
    {:else}
      <ul class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, busy) === "pick"}>
        {#each visiblePeers as p (p.id)}
          <li
            class="peer"
            class:disabled={busy}
            ondragover={(e) => { e.preventDefault(); if (!busy) (e.currentTarget as HTMLElement).classList.add("drag"); }}
            ondragleave={(e) => (e.currentTarget as HTMLElement).classList.remove("drag")}
            ondrop={(e) => { e.stopPropagation(); if (busy) { e.preventDefault(); flash(messages[lang()].busy); return; } onDrop(e, p.id); }}
          >
            <label>
              <span class="pavatar" class:big={solo}>{p.name.slice(0, 1).toUpperCase()}</span>
              <span class="ptext">
                {#if solo}
                  <span class="pname">{t.pickSendTo(p.name)}</span>
                {:else}
                  <span class="pname">{p.name}</span>
                  <span class="pick">{t.pickHint(MAX_FILES)}</span>
                {/if}
              </span>
              <input type="file" multiple disabled={busy} onchange={(e) => pickFile(e, p.id)} />
            </label>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if incoming}
    <section class="card request">
      <div class="req-head">{t.requestHead(nameOf(incoming.from), incoming.files.length, formatSize(incoming.total))}</div>
      <ul class="filelist">
        {#each incoming.files as f}
          <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
        {/each}
      </ul>
      {#if sasCode}
        <div class="sas">{t.codeLabel} <code>{sasCode}</code> — {t.codeCompare}</div>
      {/if}
      <div class="actions">
        <button class="btn btn-primary" onclick={() => acceptFn?.()}>{t.accept}</button>
        <button class="btn btn-ghost" onclick={() => rejectFn?.()}>{t.decline}</button>
      </div>
    </section>
  {/if}

  {#each [send, recv].filter(Boolean) as x (x!.dir)}
    {@const xf = x as Xfer}
    <section class="card xfer" class:ok={xf.done && xf.ok} class:bad={xf.done && !xf.ok}>
      <div class="xfer-head">
        <span class="label">{xf.dir === "send" ? t.sendTo(nameOf(xf.peer)) : t.recvFrom(nameOf(xf.peer))}</span>
        {#if xf.files.length}<span class="count">{xf.files.length > 1 ? t.fileCounter(xf.index + 1, xf.files.length) : xf.files[0].name}</span>{/if}
        {#if xf.done}
          <button class="x" onclick={() => (xf.dir === "send" ? (send = null) : (recv = null))} aria-label={t.close}>✕</button>
        {:else}
          <button class="x cancel" onclick={() => (xf.dir === "send" ? sendAbort?.() : recvAbort?.())}>{t.cancel}</button>
        {/if}
      </div>
      <div class="status">
        {statusText(t, xf)}
        {#if sasCode && !xf.done} · {t.codeLabel} <code>{sasCode}</code>{/if}
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
{/snippet}

  {#if surfaceShown && dragActive && dropTarget(visiblePeers.length, busy) !== "off"}
    <div class="dropzone">
      <div class="dropzone-inner">
        {dropTarget(visiblePeers.length, busy) === "send"
          ? t.dragSendOne(visiblePeers[0].name)
          : t.dragSendMany}
      </div>
    </div>
  {/if}

  {#if currentRoute() === "download"}
    <DownloadPage id={downloadId(location.pathname)} />
  {:else}
  <Nav />

  {#if currentRoute() === "cross"}
    <CrossPage {roomToken} {roomCode} {linkDead} {showTransfer} {transferSurface} />
  {:else}
    <Hero {connState} {unsupported} {selfName} {selfIP} />

  {#if notice}
    <div class="toast">{notice}</div>
  {/if}

  {#if unsupported}
    <div class="banner error">{t.unsupported}</div>
  {:else}
    {@render transferSurface()}

    <section class="guide">
      <h2>{t.guideTitle}</h2>
      <ol>
        <li>{t.step1}</li>
        <li>{t.step2}</li>
        <li>{t.step3(MAX_FILES)}</li>
        <li>{t.step4}</li>
      </ol>
      <p class="hint">{t.hint}</p>
    </section>

    <section class="crosscta">
      <div class="cc-text">
        <h3>{t.homeCross.title}</h3>
        <p>{t.homeCross.desc}</p>
      </div>
      <button class="btn btn-primary" onclick={() => navigate("cross")}>{t.homeCross.cta}</button>
    </section>

    <FeatureStrip />
    <UseCases />
    <Faq />

    <footer>
      <nav class="legal">
        <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
        <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
        <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
      <span class="fineprint">{t.footer}</span>
    </footer>
  {/if}
  {/if}
  {/if}
</main>

<style>
  main {
    position: relative;
    width: 820px;
    max-width: 100%;
    margin: 0 auto;
    padding: 0 20px 48px;
    box-sizing: border-box;
    text-align: left;
  }

  /* In-app section headings stay modest; marketing sections use the larger global --fs-h2. */
  h2 { font-size: var(--fs-h3); margin: 0 0 var(--space-3); }

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

  .guide { margin: var(--section-gap) 0 var(--space-5); }
  .guide ol { margin: 0; padding-left: 22px; }
  .guide li { margin: 7px 0; }
  .guide .hint { margin-top: var(--space-3); font-size: var(--fs-xs); color: var(--text); }

  .crosscta {
    margin: var(--section-gap) 0 var(--space-2);
    display: flex; align-items: center; gap: var(--space-5); flex-wrap: wrap;
    padding: var(--space-5) var(--space-6); border-radius: var(--radius);
    border: 1px solid var(--accent-border); background: var(--accent-bg);
  }
  .crosscta .cc-text { flex: 1 1 260px; min-width: 0; }
  .crosscta h3 { margin: 0 0 6px; font-size: 18px; color: var(--text-h); font-weight: 600; }
  .crosscta p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text); }
  .crosscta .btn { white-space: nowrap; }

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
  .sas {
    font-size: 13.5px; margin-bottom: 14px; padding: 10px 12px;
    border-radius: 10px; background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  .sas code { font-size: 16px; font-weight: 700; letter-spacing: 1px; background: transparent; padding: 0 2px; }

  .actions { display: flex; gap: var(--space-3); }

  .xfer-head { display: flex; align-items: center; gap: 10px; }
  .xfer-head .label { color: var(--accent); font-size: 14px; font-weight: 500; white-space: nowrap; }
  .xfer-head .count { color: var(--text); font-size: 13px; margin-left: auto; word-break: break-all; text-align: right; }
  button.x {
    margin-left: 8px; padding: 2px 8px; font: inherit; font-size: var(--fs-xs);
    border-radius: 7px; cursor: pointer; border: 1px solid var(--border);
    background: var(--bg); color: var(--text);
    transition: color .13s, box-shadow .13s;
  }
  button.x:hover { color: var(--text-h); box-shadow: var(--shadow); }
  /* The in-progress variant is a labelled "Cancel" rather than a bare ✕. */
  button.x.cancel { padding: 2px 12px; }
  button.x.cancel:hover { color: var(--accent); border-color: var(--accent-border); }
  .status { font-size: 13.5px; color: var(--text); margin: 8px 0 10px; }

  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s ease; }
  .meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: 12.5px; color: var(--text); }

  .peers { margin-top: var(--space-7); }
  .peers h2 { font-size: 20px; }
  .peers ul {
    list-style: none; padding: 0; margin: 0;
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }
  /* A single connected peer (typical cross-network) reads as one prominent send target. */
  .peers ul.solo { grid-template-columns: 1fr; }
  .peers ul.solo .peer { border-style: solid; border-color: var(--accent-border); background: var(--accent-bg); }
  .peers ul.solo .peer label { justify-content: center; padding: 20px; }
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
  .pavatar.big { width: 48px; height: 48px; line-height: 48px; font-size: 20px; }
  .ptext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .peers ul.solo .pname { font-size: 17px; }
  .pname { color: var(--text-h); font-weight: 500; font-size: 16px; }
  .pick { color: var(--text); font-size: 13px; }
  .peer input[type="file"] { display: none; }

  .empty {
    color: var(--text); font-size: 14px; text-align: center;
    padding: 28px 20px; border: 1.5px dashed var(--border); border-radius: 14px;
    background: var(--surface-2);
  }

  footer {
    margin-top: var(--space-6); padding-top: var(--space-5); border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent); }
  footer .fineprint { max-width: 60ch; }

  .dropzone {
    position: fixed; inset: 0; z-index: 50;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent-bg);
    pointer-events: none; /* never intercept device-card drops */
  }
  .dropzone-inner {
    padding: 22px 34px; border-radius: 16px;
    border: 2px dashed var(--accent); color: var(--text-h);
    background: var(--bg); box-shadow: var(--shadow);
    font-size: 18px; font-weight: 500;
  }
  .peers ul.dragging .peer { border-color: var(--accent-border); background: var(--accent-bg); }
</style>
