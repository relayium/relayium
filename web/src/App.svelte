<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import {
    ready,
    generateKeyPair,
    deriveSession,
    sas,
    type SessionKeys,
  } from "./lib/crypto";
  import { SignalingClient } from "./lib/signaling";
  import { wsURL } from "./lib/transfer-link";
  import { roomCode as roomCodeStore, initRoomFromLocation } from "./lib/room.svelte";
  import { connect, connectResume, PeerBusyError, type InboundSignal, type Conn, type ConnPath } from "./lib/webrtc";
  import { createWakeLock } from "./lib/wakelock";
  import { registerServiceWorker, drainSharedFiles } from "./lib/share-target";
  import { requestNotifyPermission, notifyTransfer } from "./lib/notify";
  import {
    Sender,
    Receiver,
    ACCEPT,
    REJECT,
    COMPLETE,
    controlKind,
    resumeReqFrame,
    parseResumeReq,
    FRAME,
    CHUNK_OVERHEAD,
    MAX_FILES,
    type FileMeta,
    type ResumePoint,
  } from "./lib/transfer";
  import { pickSaveTarget, type SaveTarget, type FileSink } from "./lib/filesink";
  import { fetchIceServers } from "./lib/ice";
  import type { Peer } from "./lib/protocol";
  import { lang, messages, legalUrl, pageUrl, type Messages, type StatusKey } from "./lib/i18n.svelte";
  import { hasFiles, dropTarget, pickedFromInput, filesFromDataTransfer, type PickedFile } from "./lib/drag";
  import { outbox, setOutbox, takeOutbox, clearOutbox } from "./lib/outbox.svelte";
  import { folderUploadSupported } from "./lib/platform";
  import CrossPage from "./lib/CrossPage.svelte";
  import OfflinePage from "./lib/OfflinePage.svelte";
  import MePage from "./lib/MePage.svelte";
  import Nav from "./lib/Nav.svelte";
  import { currentRoute, syncRouteFromLocation, downloadId, navigate, setNavGuard } from "./lib/router.svelte";
  import Hero from "./lib/Hero.svelte";
  import DownloadPage from "./lib/DownloadPage.svelte";
  import FeatureStrip from "./lib/FeatureStrip.svelte";
  import HowToSteps from "./lib/HowToSteps.svelte";
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
  let connState = $state<"connecting" | "ready" | "reconnecting">("connecting");
  let unsupported = $state(false);
  let selfName = $state("");
  let selfId = $state("");
  let selfIP = $state("");
  let peers = $state<Peer[]>([]);
  let sasCode = $state("");

  let incoming = $state<Incoming | null>(null); // pending receive awaiting accept/reject
  let recv = $state<Xfer | null>(null);
  let send = $state<Xfer | null>(null);
  // A receive whose connection dropped mid-transfer, waiting for the sender to
  // re-offer so it can resume. Non-reactive: it's a coordination handle for the
  // signalling router, not UI state. See beginReceive's resume closure.
  let pausedRecv: { from: string; resume: (offer: InboundSignal) => void } | null = null;
  // How long each side keeps trying to reconnect-and-resume after a mid-transfer
  // drop before giving up and failing the transfer.
  const RESUME_WINDOW_MS = 90_000;
  // Live ICE path per direction, kept out of Xfer so the async getStats() poll
  // never races the transfer loop's high-frequency rewrites of send/recv.
  let sendPath = $state<ConnPath | undefined>();
  let recvPath = $state<ConnPath | undefined>();
  let notice = $state(""); // transient hint (e.g. "busy", "too many files")
  let dragActive = $state(false);
  let dragDepth = 0; // non-reactive: dragenter/dragleave fire per element; count to know when the drag truly leaves the window
  // The active room lives in the URL-driven store; read reactively here so a live
  // room switch (no reload) reconnects the socket via the effect below.
  const roomCode = $derived(roomCodeStore());
  let joinedRoom = $state(false);
  let linkDead = $state(false);

  // Non-reactive locals
  let signaling: SignalingClient;
  let socketRoomKey = ""; // which room the current socket is bound to; guards the reconnect effect
  let roomEpoch = 0; // bumped per room switch; discards a stale fetchIceServers response
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined; // pending auto-reconnect after a WS drop
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
  // The realtime surface auto-appears whenever a LAN peer is visible, but there's
  // no room to leave — so "Start over" there sets this flag to fall back to the
  // method choices instead. An in-flight transfer (busy) always wins over it, and
  // the reset effect below clears it once the peer drops, so a reconnect re-shows.
  let lanDismissed = $state(false);
  const showTransfer = $derived(busy || (visiblePeers.length > 0 && !lanDismissed));

  // Un-dismiss once the LAN peer disconnects, so the next device that appears
  // re-shows the transfer surface rather than staying hidden behind a stale flag.
  $effect(() => {
    if (visiblePeers.length === 0) lanDismissed = false;
  });

  // The window-wide drop only makes sense where the device cards are actually
  // rendered: the LAN page (unless unsupported), or the cross page once a
  // realtime peer is connected. Never on the download page.
  const surfaceShown = $derived(
    currentRoute() === "download" || currentRoute() === "offline" || currentRoute() === "me"
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

  // Notify when a transfer finishes and the user is on another tab/app, so a long
  // transfer needn't be babysat. Edge-detected per direction; each flag resets
  // when its card clears so the next transfer notifies again. notifyTransfer
  // itself no-ops when the tab is visible or permission wasn't granted.
  let sendNotified = false;
  let recvNotified = false;
  $effect(() => {
    const s = send;
    if (s?.done) { if (!sendNotified) { sendNotified = true; void notifyTransfer(statusText(messages[lang()], s)); } }
    else sendNotified = false;
  });
  $effect(() => {
    const r = recv;
    if (r?.done) { if (!recvNotified) { recvNotified = true; void notifyTransfer(statusText(messages[lang()], r)); } }
    else recvNotified = false;
  });

  // Auto-dismiss a *successful* completion card after a few seconds so back-to-back
  // batches don't stack stale cards; failure cards stay put (they need a read + a
  // deliberate dismiss). The effect's cleanup cancels the timer if a new transfer
  // replaces the card first, and the identity guard avoids clearing that new one.
  const DISMISS_MS = 6000;
  $effect(() => {
    const s = send;
    if (s?.done && s.ok) {
      const timer = setTimeout(() => { if (send === s) send = null; }, DISMISS_MS);
      return () => clearTimeout(timer);
    }
  });
  $effect(() => {
    const r = recv;
    if (r?.done && r.ok) {
      const timer = setTimeout(() => { if (recv === r) recv = null; }, DISMISS_MS);
      return () => clearTimeout(timer);
    }
  });

  // Hold a screen wake lock while any transfer is in flight so a phone locking
  // its screen mid-transfer doesn't tear down the connection. Centralised here so
  // every exit path (done/fail/cancel) releases without per-branch bookkeeping.
  const wake = createWakeLock();
  $effect(() => {
    const active = (send && !send.done) || (recv && !recv.done);
    if (active) wake.acquire();
    else wake.release();
  });

  // Queued files (OS share sheet, or picked before pairing) auto-send the
  // moment there's exactly one reachable device and nothing else in flight;
  // with several devices the user picks one (the peer cards become targets).
  $effect(() => {
    if (outbox().length && surfaceShown && !busy && visiblePeers.length === 1) {
      sendFiles(visiblePeers[0].id, takeOutbox());
    }
  });

  // Poll the live ICE path a few times once a channel is up: the selected
  // candidate pair can settle shortly after the data channel opens.
  async function trackPath(conn: Conn, set: (p: ConnPath) => void) {
    for (let i = 0; i < 8; i++) {
      const p = await conn.path();
      if (p !== "unknown") { set(p); return; }
      await sleep(400);
    }
  }

  onMount(async () => {
    document.documentElement.lang = lang();
    initRoomFromLocation();
    syncRouteFromLocation();
    window.addEventListener("popstate", onPopState);
    registerServiceWorker();
    // Pick up any files launched into the app via the OS share sheet (installed
    // PWA, Android/Chromium). The auto-send effect routes them once a peer is up.
    drainSharedFiles().then((files) => {
      if (files.length) setOutbox(files.map((file) => ({ file })));
    });
    if (!window.isSecureContext || !crypto.subtle) {
      unsupported = true;
      return;
    }
    await ready();
    selfName = deviceName();
    iceServers = await fetchIceServers(roomCode);
    signaling = new SignalingClient(wsURL(location, roomCode), selfName);
    signaling.onSelfId((id, ip) => {
      selfId = id; selfIP = ip; joinedRoom = true;
      // A welcome means the socket is (re)connected — clear any reconnect state.
      connState = "ready";
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    });
    signaling.onPeers((p) => (peers = p));
    signaling.onClose(() => {
      // In a code room, a close before we ever joined means the code/link was
      // invalid/expired or the room was full — surface that, don't retry.
      if (roomCode && !joinedRoom) { linkDead = true; return; }
      // Otherwise the signalling socket dropped unexpectedly. Reflect the break in
      // the UI (no green "connected" dot, no zombie devices) and auto-reconnect.
      peers = [];
      selfId = "";
      selfIP = "";
      joinedRoom = false;
      connState = "reconnecting";
      scheduleReconnect();
    });
    listenForIncoming();
    socketRoomKey = roomCode;
    connState = "ready";
  });

  // Reconnect the signalling socket to the current room after an unexpected drop.
  // A single pending timer at a time; onSelfId cancels it once the welcome lands.
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!signaling) return;
      // reconnect() intentionally swaps the socket (won't re-fire onClose); if this
      // fresh socket also closes, onClose runs again and re-schedules.
      signaling.reconnect(wsURL(location, roomCode));
    }, 2000);
  }

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
    const epoch = ++roomEpoch; // newer switch supersedes any slower in-flight one
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
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
    connState = "connecting";
    const servers = await fetchIceServers(roomCode);
    // A rapid second switch may have started (and possibly finished) while this
    // fetch was in flight — discard the stale credentials rather than clobbering
    // the newer room's TURN config and socket.
    if (epoch !== roomEpoch) return;
    iceServers = servers;
    signaling.reconnect(wsURL(location, roomCode));
  }

  $effect(() => {
    const key = roomCode;
    if (!signaling) return; // socket not built yet (initial mount)
    if (key === socketRoomKey) return; // already bound to this room
    // Queued files belong to the pairing attempt that queued them: leaving the code
    // room by ANY path (start over, tab switch, back button) must drop them so they
    // can't surprise-send to an unrelated peer later. Only the code→"" exit clears —
    // ""→code (files were just queued) and code→code (timedOut re-mint) keep the queue.
    if (socketRoomKey && !key) clearOutbox();
    socketRoomKey = key;
    void switchRoom();
  });

  onMount(() => {
    // Guard tab/logo navigation and tab-close while a transfer is live: navigating
    // tears down the room (aborting the transfer), so confirm first; and warn on a
    // full page unload so an accidental close doesn't silently kill a transfer.
    setNavGuard(() => (busy ? confirm(messages[lang()].confirmLeave) : true));
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!busy) return;
      e.preventDefault();
      e.returnValue = ""; // required for the native "leave site?" prompt in some browsers
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      setNavGuard(null);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
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
      if (surfaceShown && dropTarget(visiblePeers.length, busy) === "send" && e.dataTransfer) {
        const peer = visiblePeers[0].id;
        filesFromDataTransfer(e.dataTransfer).then((picked) => { if (picked.length) sendFiles(peer, picked); });
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

  const DEVICE_NAME_KEY = "relayium_device_name";
  // A stable, readable device name. Persisted so a peer sees the same "iPhone-482"
  // across reloads instead of a fresh random platform string every visit.
  function deviceName(): string {
    try {
      const saved = localStorage.getItem(DEVICE_NAME_KEY);
      if (saved) return saved;
    } catch { /* storage blocked (private mode) — fall through to a fresh name */ }
    const name = `${deviceLabel()}-${Math.floor(Math.random() * 1000)}`;
    try { localStorage.setItem(DEVICE_NAME_KEY, name); } catch { /* ignore */ }
    return name;
  }
  // A short device class from the UA (best-effort; navigator.platform is deprecated
  // and unreadable). Never throws — an unknown UA just reads as "Device".
  function deviceLabel(): string {
    const ua = navigator.userAgent || "";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android" : "Android-Tablet";
    if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
    if (/Windows/.test(ua)) return "Windows";
    if (/Linux/.test(ua)) return "Linux";
    return "Device";
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
      // A re-offer from a peer whose transfer dropped mid-flight is a resume, not
      // a new receive — route it before the busy guard (busy is true here).
      if (pausedRecv && pausedRecv.from === from) { pausedRecv.resume(msg); return; }
      if (msg.resume) return; // a stray resume offer with nothing paused to attach to
      // One transfer at a time. Tell the sender we're busy so it fails fast with a
      // clear "peer busy" message instead of waiting out its ICE timeout.
      if (busy) { signaling.sendSignal(from, { busy: true }); return; }
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
    // Resume state: `fileOffset` is bytes written of the *current* file (got is
    // batch-cumulative); `checkpoint` is the last point where the receiver's
    // chain hash and durably-written bytes agree — restored on resume.
    let fileOffset = 0;
    let checkpoint: { index: number; offset: number; chain: Uint8Array } = { index: 0, offset: 0, chain: new Uint8Array(32) };
    let resumable = false; // true once a byte is durably written — before that a drop just fails
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    let resuming = false; // a resume() is mid-flight — blocks re-entrant offers
    let completing = false; // final batch is being flushed — a late "closed" must not resume
    let speedBase = 0; // bytes at the current speed-measurement epoch (reset on resume)
    // One serialized frame-handling chain shared across the original and every
    // resumed channel, so an in-flight write can't race a resumed write on the sink.
    let pending: Promise<void> = Promise.resolve();

    let r: Xfer = { peer: from, dir: "recv", files: [], index: 0, sent: 0, total: 0, status: "connecting", done: false, ok: false, speed: 0 };
    recv = r;
    recvPath = undefined;

    // Stall detection: a receive that goes quiet for STALL_MS (peer vanished, path
    // died before ICE noticed) is failed rather than left frozen mid-progress.
    let conn: Conn | undefined;
    let cancelled = false; // user hit cancel (possibly during ICE, before conn exists)
    let lastActivity = Date.now();
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const clearWatchdog = () => { if (watchdog) { clearInterval(watchdog); watchdog = undefined; } };
    // Central "this receive is dead" path: mark failed once, stop the watchdog,
    // drop any pending accept card, and tear down the connection.
    const failRecv = (status: StatusKey) => {
      if (r.done) return;
      clearWatchdog();
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
      if (pausedRecv?.from === from) pausedRecv = null;
      recv = r = { ...r, status, done: true, ok: false };
      incoming = null;
      recvAbort = null;
      conn?.close();
    };

    // User pressed cancel: tear down and return to idle (not a failure card).
    // Installed *before* connect so cancel works during ICE negotiation too — at
    // that point conn is undefined, so we flag `cancelled` and the post-connect
    // check closes the late connection. Mirrors the sender's pre-connect sendAbort.
    recvAbort = () => {
      cancelled = true;
      clearWatchdog();
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
      if (pausedRecv?.from === from) pausedRecv = null;
      conn?.close();
      recv = null;
      incoming = null;
      sasCode = "";
      recvAbort = null;
    };

    conn = await connect({
      signaling, peerId: from, selfKey: selfKey.publicKey, role: "responder",
      initialSignal: offer,
      onPeerKey: async (pk) => { keys = await deriveSession("responder", selfKey, pk); sasCode = sas(selfKey.publicKey, pk); },
      config: { iceServers },
      // A drop ICE can't recover: if bytes were already flowing, pause and wait
      // for the sender to re-offer so we can resume; otherwise fail. The normal
      // end-of-batch close also fires "closed", but this is a no-op once done.
      onStateChange: (state) => { if (state === "failed" || state === "closed") onRecvDrop(); },
    });

    // Cancelled while ICE was negotiating: the connection resolved after the abort,
    // so close it now (recvAbort already reset the UI to idle) and stop here.
    if (cancelled) { conn.close(); return; }

    const openSink = async () => {
      const f = manifest[fileIndex];
      sink = f ? await target!.file(f.name, f.size, f.path) : undefined;
    };

    // The accept click is the user gesture that lets the save picker open.
    acceptFn = async () => {
      const req = incoming;
      if (!req) return;
      try {
        // The save picker requires the click's transient user activation. Ask for
        // notification permission only AFTER it opens — Notification.requestPermission()
        // consumes that activation, and asking first makes the picker throw
        // "must be handling a user gesture" (no dialog shown) on mobile.
        target = await pickSaveTarget(req.files);
        requestNotifyPermission();
      } catch (err) {
        console.error("relayium save-target error", err);
        recv = r = { ...r, status: "noSave", done: true, ok: false };
        incoming = null;
        try { conn!.channel.send(REJECT); } catch { /* gone */ }
        conn!.close();
        return;
      }
      // The save picker can sit open for tens of seconds. If the connection died
      // (or the user cancelled) meanwhile, failRecv/recvAbort already tore this
      // receive down — do NOT resurrect it as "receiving" over a dead channel.
      if (r.done || cancelled) return;
      fileIndex = 0; got = 0; start = Date.now();
      await openSink(); // prepare file 0 (also covers a leading zero-byte file)
      // Tell the sender we're ready. On an already-closed channel this throws
      // InvalidStateError — surface a failure the user can dismiss/retry instead
      // of freezing at "receiving 0%" with a dead cancel button.
      try {
        conn!.channel.send(ACCEPT);
      } catch (err) {
        console.error("relayium accept send error", err);
        if (sink) { try { await sink.close(); } catch { /* ignore */ } }
        failRecv("recvFail");
        return;
      }
      recv = r = { peer: from, dir: "recv", files: req.files, index: 0, sent: 0, total: req.total, status: "receiving", done: false, ok: false, speed: 0 };
      if (conn) trackPath(conn, (p) => (recvPath = p));
      incoming = null;
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

    // Wire a (re)connected channel to the shared, serialized frame pipeline. A
    // real (non-connection) error fails hard; connection drops come via state.
    const installChannel = (c: Conn) => {
      c.channel.onmessage = (ev) => {
        pending = pending
          .then(() => handleFrame(ev.data as ArrayBuffer))
          .catch((err) => { console.error("relayium receive error", err); failRecv("recvFail"); });
      };
    };

    // A connection drop. Before any bytes flow (or after done/cancel/while
    // finishing) it's a plain failure; mid-transfer it pauses for a re-offer.
    const onRecvDrop = () => {
      if (r.done || cancelled || completing) return;
      if (!resumable) { failRecv("recvFail"); return; }
      if (pausedRecv || resuming) return; // already waiting or mid-resume
      clearWatchdog();
      conn?.close(); // drop the dead pc + its signalling listener so it can't cross-route the resume
      recv = r = { ...r, status: "resuming", speed: 0 };
      pausedRecv = { from, resume };
      // Give up if the sender never comes back within the window.
      resumeTimer = setTimeout(() => { pausedRecv = null; failRecv("recvFail"); }, RESUME_WINDOW_MS);
    };

    // The sender re-offered: rebuild the channel reusing the existing keys (no new
    // handshake, SAS unchanged) and ask it to resume from our checkpoint. Guarded
    // against re-entrancy so a duplicate/ICE-restart offer can't spawn a second one.
    const resume = async (offer: InboundSignal) => {
      if (r.done || cancelled || resuming) return;
      resuming = true;
      pausedRecv = null; // claim it: a concurrent offer must not re-enter
      const old = conn;
      let c: Conn;
      try {
        c = await connectResume({
          signaling, peerId: from, role: "responder", initialSignal: offer,
          config: { iceServers },
          onStateChange: (state) => { if (state === "failed" || state === "closed") onRecvDrop(); },
        });
      } catch {
        resuming = false;
        if (!r.done && !cancelled) pausedRecv = { from, resume }; // stay available for the next re-offer
        return;
      }
      if (r.done || cancelled) { c.close(); resuming = false; return; }
      old?.close(); // tear down the previous pc/listener before switching channels
      await pending.catch(() => {}); // let any in-flight old-channel frame finish first
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
      conn = c;
      installChannel(c);
      trackPath(c, (p) => (recvPath = p));
      recv = r = { ...r, status: "receiving" };
      lastActivity = Date.now();
      watchdog = setInterval(() => {
        if (!r.done && Date.now() - lastActivity > 45_000) failRecv("recvFail");
      }, 5_000);
      resuming = false; // setup done; a further drop is handled by onRecvDrop again
      // Ask the sender to pick up from our last durable point.
      try { c.channel.send(resumeReqFrame(checkpoint.index, checkpoint.offset)); }
      catch { onRecvDrop(); }
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
      if (out.resume) {
        // The sender announced where it's picking up. Restore the chain hash to
        // our last durable checkpoint and align the nonce; keep writing the same
        // (still-open) sink from here. `got` is recomputed batch-cumulatively.
        receiver.resumeAt(checkpoint.chain, out.resume.seq);
        fileIndex = checkpoint.index;
        fileOffset = checkpoint.offset;
        got = manifest.slice(0, checkpoint.index).reduce((n, f) => n + f.size, 0) + checkpoint.offset;
        speedBase = got; // measure post-resume throughput from here, not from 0
        start = Date.now();
        lastActivity = Date.now();
        return;
      }
      if (out.chunk && sink) {
        await sink.write(out.chunk);
        resumable = true; // a byte is now durably written — a drop from here can resume
        got += out.chunk.length;
        fileOffset += out.chunk.length;
        lastActivity = Date.now(); // progress resets the stall watchdog
        // Checkpoint only after the write lands, so a resume never claims bytes
        // that weren't durably written.
        checkpoint = { index: fileIndex, offset: fileOffset, chain: receiver.snapshotChain() };
        const elapsed = (Date.now() - start) / 1000;
        recv = r = { ...r, sent: got, index: fileIndex, speed: elapsed > 0 ? (got - speedBase) / elapsed : 0 };
        return;
      }
      if (out.done) {
        lastActivity = Date.now();
        if (sink) await sink.close();
        allOk = allOk && out.done.ok;
        fileIndex++;
        fileOffset = 0;
        if (fileIndex < manifest.length) {
          await openSink();
          // New file, fresh chain: checkpoint the boundary so a drop before the
          // first chunk resumes this file from 0.
          checkpoint = { index: fileIndex, offset: 0, chain: new Uint8Array(32) };
          recv = r = { ...r, index: fileIndex };
        } else {
          completing = true; // from here a "closed" is the normal end-of-batch, not a drop
          clearWatchdog();
          if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = undefined; }
          if (pausedRecv?.from === from) pausedRecv = null;
          recvAbort = null;
          // Finalise the batch destination — flushes the bundled ZIP on the
          // fallback path; a no-op for streaming targets.
          await target!.done?.();
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

    installChannel(conn);
  }

  // ── SEND ───────────────────────────────────────────────────────────────────────
  async function sendFiles(peerId: string, picked: PickedFile[]) {
    if (busy) { flash(messages[lang()].busy); return; }
    const chosen = picked.slice(0, MAX_FILES);
    if (chosen.length === 0) return;
    requestNotifyPermission(); // ask once, inside the gesture that starts the send
    const dropped = picked.length - chosen.length;
    const files = chosen.map((p) => p.file);

    const metas: FileMeta[] = chosen.map((p) => ({ name: p.file.name, size: p.file.size, path: p.path }));
    const total = metas.reduce((n, m) => n + m.size, 0);
    let s: Xfer = { peer: peerId, dir: "send", files: metas, index: 0, sent: 0, total, status: "connecting", done: false, ok: false, speed: 0 };
    send = s;
    sendPath = undefined;
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
    let gotComplete = false; // receiver acked the whole batch — success even if the pc then drops
    let sender: Sender | undefined; // hoisted so a resume can keep its monotonic seq
    let dataStarted = false; // true once we're actually streaming file data (resume only applies after this)

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

    // Reconnect-and-resume after a mid-send drop: retry connectResume (reusing the
    // authenticated keys — no new handshake, SAS unchanged) until the receiver's
    // resume request arrives and we stream the rest, or the window elapses.
    const resumeSend = async (): Promise<boolean> => {
      if (!sender || !keys) return false;
      const deadline = Date.now() + RESUME_WINDOW_MS;
      while (Date.now() < deadline) {
        if (cancelled) return false;
        send = s = { ...s, status: "resuming", speed: 0 };
        let rconn: Conn | undefined;
        try {
          let lost = false;
          rconn = await connectResume({
            signaling, peerId, role: "initiator", config: { iceServers },
            onStateChange: (state) => { if (state === "failed" || state === "closed") lost = true; },
          });
          conn = rconn; // so sendAbort tears down the current connection
          let resolveReq!: (rp: ResumePoint) => void;
          const reqReceived = new Promise<ResumePoint>((r) => (resolveReq = r));
          let doneAck = false;
          rconn.channel.onmessage = (ev) => {
            const buf = ev.data as ArrayBuffer;
            const rp = parseResumeReq(buf);
            if (rp) { resolveReq(rp); return; }
            if (controlKind(buf) === "complete") doneAck = true;
          };
          // The receiver sends its resume request as soon as the channel opens.
          const rp = await Promise.race([
            reqReceived,
            sleep(15_000).then(() => Promise.reject(new Error("no resume request"))),
          ]) as ResumePoint;
          if (cancelled) return false;
          rconn.channel.send(sender.resumeStartFrame(rp));
          send = s = { ...s, status: "sending" };
          const base = files.slice(0, rp.index).reduce((n, f) => n + f.size, 0) + rp.offset;
          const start = Date.now();
          let sent = base, idx = rp.index;
          for await (const frame of sender.dataFrames(files, keys, rp)) {
            if (lost) throw new Error("connection lost during resume");
            await backpressure(rconn.channel);
            rconn.channel.send(frame);
            if (frame[0] === FRAME.CHUNK) sent += frame.byteLength - CHUNK_OVERHEAD;
            else if (frame[0] === FRAME.DONE) idx++;
            const elapsed = (Date.now() - start) / 1000;
            send = s = { ...s, sent: Math.min(total, sent), index: Math.min(idx, files.length - 1), speed: elapsed > 0 ? (sent - base) / elapsed : 0 };
          }
          send = s = { ...s, sent: total, index: files.length - 1, status: "finishing", speed: 0 };
          const completeAck = new Promise<void>((r) => {
            const iv = setInterval(() => { if (doneAck) { clearInterval(iv); r(); } }, 100);
            setTimeout(() => { clearInterval(iv); r(); }, 30_000);
          });
          await flush(rconn.channel, completeAck);
          if (lost) throw new Error("connection lost");
          return true;
        } catch {
          rconn?.close();
          if (cancelled) return false;
          await sleep(1500); // backoff before the next reconnect attempt
        }
      }
      return false;
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
        else if (k === "complete") { gotComplete = true; resolveComplete(); }
      };
      conn.channel.onclose = () => resolveAccept(false);

      // Wait for the peer's key (arrives with the answer). Bail if the connection
      // dies during the handshake so this doesn't spin forever.
      while (!keys) {
        if (connLost) throw new Error("connection lost before key exchange");
        await sleep(20);
      }

      sender = new Sender();
      conn.channel.send(sender.batchFrame(metas)); // announce the batch; wait for the decision
      send = s = { ...s, status: "waitingAccept" };

      const ok = await accepted;
      if (connLost) throw new Error("connection lost");
      if (!ok) {
        send = s = { ...s, status: "rejected", done: true, ok: false };
        return;
      }

      send = s = { ...s, status: "sending" };
      dataStarted = true; // from here a drop can resume instead of failing
      trackPath(conn, (p) => (sendPath = p));
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
      // If the receiver already acked the whole batch, the transfer succeeded even
      // if the pc dropped right after — don't fail (or needlessly try to resume) it.
      if (connLost && !gotComplete) throw new Error("connection lost");
      send = s = { ...s, status: "sendDone", done: true, ok: true };
    } catch (err) {
      if (cancelled) return;
      // The peer refused the offer because it's already in a transfer — a clean
      // "busy", not a failure to connect. Surface it as such and don't retry.
      if (err instanceof PeerBusyError) {
        send = s = { ...s, status: "peerBusy", done: true, ok: false };
        return;
      }
      console.error("relayium send error", err);
      // A mid-send drop is resumable: reconnect (reusing keys) and finish from the
      // receiver's checkpoint. Only fall through to failure if that gives up.
      if (dataStarted && !gotComplete && (await resumeSend())) {
        send = s = { ...s, status: "sendDone", done: true, ok: true };
      } else if (!cancelled) {
        // Distinguish "never connected" from "dropped mid-send" so the user knows
        // whether to retry the connection or the transfer.
        const status = s.status === "connecting" || s.status === "waitingAccept" ? "connectFail" : "sendFail";
        send = s = { ...s, status, done: true, ok: false };
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
  function pathLabel(m: Messages, p: ConnPath): string {
    return p === "lan" ? m.pathLan : p === "relay" ? m.pathRelay : m.pathP2p;
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
  // Estimated time remaining from the live speed. Clock format (m:ss / Ns) so it
  // needs no per-language copy. "" when there's nothing meaningful to show yet.
  function formatEta(x: Xfer): string {
    if (x.done || x.speed <= 0 || x.total <= x.sent) return "";
    const secLeft = Math.ceil((x.total - x.sent) / x.speed);
    if (secLeft <= 0) return "";
    const m = Math.floor(secLeft / 60);
    const s = secLeft % 60;
    return m > 0 ? `~${m}:${String(s).padStart(2, "0")}` : `~${s}s`;
  }

  function pickFile(e: Event, peerId: string) {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files?.length) sendFiles(peerId, pickedFromInput(input.files));
    input.value = ""; // allow re-picking the same files
  }
  function onDrop(e: DragEvent, peerId: string) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove("drag");
    if (!e.dataTransfer) return;
    // Kick off entry extraction now (it captures DataTransfer items synchronously
    // before its first await), then send once the folder tree is flattened.
    filesFromDataTransfer(e.dataTransfer).then((picked) => { if (picked.length) sendFiles(peerId, picked); });
  }
</script>

<main>
{#snippet transferSurface()}
  {@const solo = visiblePeers.length === 1}
  <section class="peers">
    <h2>{currentRoute() === "cross" ? t.crossPeersTitle : t.peersTitle}</h2>
    {#if outbox().length && visiblePeers.length !== 1}
      <p class="share-pending">{t.sharePending(outbox().length)}</p>
    {/if}
    {#if visiblePeers.length === 0}
      <div class="empty">
        <p class="empty-lead">{t.emptyPeers}</p>
        {#if currentRoute() === "lan"}
          <button class="btn btn-ghost empty-cta" onclick={() => navigate("cross")}>{t.emptyCrossCta}</button>
        {/if}
      </div>
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
            <label class="pcard">
              <span class="pavatar" class:big={solo}>{p.name.slice(0, 1).toUpperCase()}</span>
              <span class="ptext">
                {#if solo}
                  <span class="pname">{t.pickSendTo(p.name)}</span>
                {:else}
                  <span class="pname">{p.name}</span>
                  <span class="pick">{t.pickHint(MAX_FILES)}</span>
                {/if}
              </span>
              <input id={`pick-${p.id}`} type="file" multiple disabled={busy}
                onclick={(e) => { if (outbox().length) { e.preventDefault(); sendFiles(p.id, takeOutbox()); } }}
                onchange={(e) => pickFile(e, p.id)} />
            </label>
            <div class="peer-actions">
              <label class="act-btn" class:disabled={busy} for={`pick-${p.id}`}>📄 {t.sendFile}</label>
              {#if folderUploadSupported}
                <label class="act-btn" class:disabled={busy}>
                  📁 {t.sendFolder}
                  <input type="file" webkitdirectory multiple disabled={busy} onchange={(e) => pickFile(e, p.id)} />
                </label>
              {/if}
            </div>
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
    <section class="card xfer" class:ok={xf.done && xf.ok} class:bad={xf.done && !xf.ok} out:fade={{ duration: 300 }}>
      <div class="xfer-head">
        <span class="label">{xf.dir === "send" ? t.sendTo(nameOf(xf.peer)) : t.recvFrom(nameOf(xf.peer))}</span>
        {#if xf.files.length}<span class="count">{xf.files.length > 1 ? t.fileCounter(xf.index + 1, xf.files.length) : xf.files[0].name}</span>{/if}
        {#if xf.done}
          <button class="x" onclick={() => (xf.dir === "send" ? (send = null) : (recv = null))} aria-label={t.close}>✕</button>
        {:else}
          <button class="x cancel" onclick={() => (xf.dir === "send" ? sendAbort?.() : recvAbort?.())}>{t.cancel}</button>
        {/if}
      </div>
      <div class="status" aria-live="polite">
        {statusText(t, xf)}
        {#if sasCode && !xf.done} · {t.codeLabel} <code>{sasCode}</code>{/if}
      </div>
      {#if !xf.done}
        {@const path = xf.dir === "send" ? sendPath : recvPath}
        <div class="bar" role="progressbar" aria-valuenow={pct(xf)} aria-valuemin="0" aria-valuemax="100"><div class="fill" style:width="{pct(xf)}%"></div></div>
        <div class="meta">
          <span>{pct(xf)}% · {formatSize(xf.sent)} / {formatSize(xf.total)}</span>
          <span class="meta-right">
            {#if path}<span class="path path-{path}"><i class="dot"></i>{pathLabel(t, path)}</span>{/if}
            {#if xf.speed > 0}<span>{formatSpeed(xf.speed)}{#if formatEta(xf)} · {formatEta(xf)}{/if}</span>{/if}
          </span>
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
    <CrossPage {roomCode} {linkDead} {showTransfer} {transferSurface} dismissLan={() => (lanDismissed = true)} />
  {:else if currentRoute() === "offline"}
    <OfflinePage />
  {:else if currentRoute() === "me"}
    <MePage />
  {:else}
    <Hero {connState} {unsupported} {selfName} {selfIP} />

  {#if notice}
    <div class="toast" role="status" aria-live="polite">{notice}</div>
  {/if}

  {#if unsupported}
    <div class="banner error">{t.unsupported}</div>
  {:else}
    {@render transferSurface()}

    <HowToSteps maxFiles={MAX_FILES} />

    <section class="crosscta">
      <div class="cc-text">
        <h3>{t.homeCross.title}</h3>
        <p>{t.homeCross.desc}</p>
      </div>
      <div class="cc-actions">
        <button class="btn btn-primary" onclick={() => navigate("cross")}>{t.homeCross.realtimeCta}</button>
        <button class="btn btn-ghost" onclick={() => navigate("offline")}>{t.homeCross.offlineCta}</button>
      </div>
    </section>

    <FeatureStrip />
    <UseCases />
    <Faq />

    <footer>
      <nav class="legal" aria-label="Legal">
        <a href={legalUrl("security", lang())}>{t.legal.security}</a>
        <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
        <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
        <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
      <nav class="legal" aria-label="Guides">
        <a href={pageUrl("compare/snapdrop", lang())}>{t.learn.compareSnapdrop}</a>
        <a href={pageUrl("compare/airdrop", lang())}>{t.learn.compareAirdrop}</a>
        <a href={pageUrl("compare/wetransfer", lang())}>{t.learn.compareWetransfer}</a>
        <a href={pageUrl("how-to/transfer-files-android-to-iphone", lang())}>{t.learn.howtoAndroidIphone}</a>
        <a href={pageUrl("how-to/send-files-pc-to-phone-wirelessly", lang())}>{t.learn.howtoPcPhone}</a>
        <a href={pageUrl("how-to/send-large-files-without-cloud", lang())}>{t.learn.howtoLargeFiles}</a>
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

  /* Fixed overlay (not sticky-in-flow) so appearing/dismissing the toast doesn't
     shove the page content below it up and down. */
  .toast {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 30;
    margin: 0; padding: 10px 16px; max-width: calc(100vw - 32px);
    border-radius: 10px; font-size: 14px; text-align: center;
    color: var(--text-h); background: var(--accent-bg);
    border: 1px solid var(--accent-border); box-shadow: var(--shadow);
  }

  .banner.error {
    margin-top: 24px; padding: 16px; border-radius: 12px; text-align: center;
    color: var(--text-h); background: var(--accent-bg); border: 1px solid var(--accent-border);
  }


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
  .crosscta .cc-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; }

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
  /* On touch devices, grow the close/cancel and folder-pick hit areas to the ~44px
     minimum comfortable tap target (visual padding stays modest via flex centring). */
  @media (pointer: coarse) {
    button.x { min-height: 44px; padding-inline: 14px; }
    .act-btn { min-height: 44px; }
  }
  .status { font-size: 13.5px; color: var(--text); margin: 8px 0 10px; }

  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), #6d28d9); transition: width .2s ease; }
  .meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: 12.5px; color: var(--text); }
  .meta-right { display: inline-flex; align-items: center; gap: 12px; }
  /* Connection-path badge: a coloured dot + label. Green LAN, blue P2P, orange relay. */
  .path { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .path .dot { width: 7px; height: 7px; border-radius: 999px; background: currentColor; flex: none; }
  .path-lan { color: #16a34a; }
  .path-p2p { color: #2563eb; }
  .path-relay { color: #d97706; }

  .peers { margin-top: var(--space-7); }
  .peers h2 { font-size: 20px; }
  .share-pending {
    margin: 0 0 12px; padding: 10px 14px; border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    color: var(--text); font-size: 14px;
  }
  .peers ul {
    list-style: none; padding: 0; margin: 0;
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }
  /* A single connected peer (typical cross-network) reads as one prominent send target. */
  .peers ul.solo { grid-template-columns: 1fr; }
  .peers ul.solo .peer { border-style: solid; border-color: var(--accent-border); background: var(--accent-bg); }
  .peers ul.solo .peer .pcard { justify-content: center; padding: 20px; }
  .peer {
    border: 1.5px dashed var(--border); border-radius: 14px;
    transition: border-color .15s, background .15s;
  }
  .peer:not(.disabled):hover, .peer:global(.drag) { border-color: var(--accent-border); background: var(--accent-bg); }
  .peer.disabled { opacity: .5; }
  .peer .pcard { display: flex; align-items: center; gap: 14px; padding: 14px 16px; cursor: pointer; }
  .peer.disabled .pcard { cursor: not-allowed; }
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
  .peer-actions { display: flex; gap: 8px; margin: 0 12px 10px; }
  .act-btn {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px; border-radius: 9px;
    border: 1px solid var(--border); font-size: 13px; color: var(--text); cursor: pointer;
    transition: border-color .15s, background .15s, color .15s;
  }
  .act-btn:not(.disabled):hover { border-color: var(--accent-border); background: var(--accent-bg); color: var(--text-h); }
  .act-btn.disabled { cursor: not-allowed; opacity: .6; }
  .peers ul.solo .peer-actions { max-width: 360px; margin-inline: auto; }

  .empty {
    display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
    text-align: center;
    padding: 28px 20px; border: 1.5px dashed var(--border); border-radius: 14px;
    background: var(--surface-2);
  }
  .empty-lead { margin: 0; color: var(--text); font-size: 14px; max-width: 46ch; }
  .empty-cta { margin-top: var(--space-1); }

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
