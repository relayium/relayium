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
  import { connect, connectResume, summarizeStats, PeerBusyError, type InboundSignal, type Conn, type ConnPath, type RtcConfig, type ConnDiagnostics } from "./lib/webrtc";
  import { applyRename } from "./lib/apply-rename";
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
    ackFrame,
    parseAck,
    FLOW_WINDOW,
    FLOW_ACK_INTERVAL,
    FRAME,
    CHUNK_OVERHEAD,
    MAX_FILES,
    type FileMeta,
    type ResumePoint,
  } from "./lib/transfer";
  import { pickSaveTarget, type SaveTarget, type FileSink } from "./lib/filesink";
  import { recordTransfer, loadHistory, clearHistory, type HistEntry } from "./lib/history";
  import { fetchIceConfig, hasTurnServer, measureRelays, pickRelay, type RelayEntry } from "./lib/ice";
  import type { Peer } from "./lib/protocol";
  import { lang, dir, messages, legalUrl, pageUrl, type Messages, type StatusKey } from "./lib/i18n.svelte";
  import { pageMeta, altHreflangs } from "./lib/page-meta";
  import { hasFiles, dropTarget, pickedFromInput, filesFromDataTransfer, type PickedFile } from "./lib/drag";
  import { outbox, setOutbox, takeOutbox, clearOutbox } from "./lib/outbox.svelte";
  import { shouldConfirmBeforeSend } from "./lib/confirm-send";
  import { folderUploadSupported } from "./lib/platform";
  import { reveal } from "./lib/reveal";
  import Nav from "./lib/Nav.svelte";
  import { currentRoute, syncRouteFromLocation, downloadId, navigate, setNavGuard, PRICING_PATH } from "./lib/router.svelte";
  import Hero from "./lib/Hero.svelte";
  import DeviceRadar from "./lib/DeviceRadar.svelte";
  import QuotaNotice from "./lib/QuotaNotice.svelte";
  import FeatureStrip from "./lib/FeatureStrip.svelte";
  import CliCallout from "./lib/CliCallout.svelte";
  import HowToSteps from "./lib/HowToSteps.svelte";

  // Route pages are code-split and loaded on first navigation, so they stay out of
  // the initial bundle (the LAN transfer home path is what loads first). The import
  // promise per route is memoized so a component's reactive prop changes (e.g.
  // CrossPage during a transfer) don't re-trigger the import or flash the await.
  const routeLoaders = {
    download: () => import("./lib/DownloadPage.svelte"),
    cross: () => import("./lib/CrossPage.svelte"),
    offline: () => import("./lib/OfflinePage.svelte"),
    me: () => import("./lib/MePage.svelte"),
    cli: () => import("./lib/CliPage.svelte"),
    apps: () => import("./lib/AppsPage.svelte"),
    pricing: () => import("./lib/PricingPage.svelte"),
    "verify-email": () => import("./lib/VerifyEmail.svelte"),
    "reset-password": () => import("./lib/ResetPassword.svelte"),
  } as const;
  const routeCache = new Map<string, ReturnType<(typeof routeLoaders)[keyof typeof routeLoaders]>>();
  function routePage<K extends keyof typeof routeLoaders>(key: K): ReturnType<(typeof routeLoaders)[K]> {
    let p = routeCache.get(key);
    if (!p) { p = routeLoaders[key](); routeCache.set(key, p); }
    return p as ReturnType<(typeof routeLoaders)[K]>;
  }
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

  // Concise label for a completed transfer's history entry: the first file's
  // name, plus a "+N" count when the batch had more than one.
  const xferLabel = (x: Xfer) =>
    x.files.length === 1 ? x.files[0].name : `${x.files[0]?.name ?? "?"} +${x.files.length - 1}`;

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
  // Client-local "recent transfers" log (localStorage-backed, this device only).
  // Refreshed after each recorded completion and on clear — never read live from
  // storage during render.
  let history = $state<HistEntry[]>(loadHistory());
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
  let relayDenied = $state<string>(""); // "quota" when the code owner is over the monthly relay cap (no TURN issued)

  // Non-reactive locals
  let signaling: SignalingClient;
  let socketRoomKey = ""; // which room the current socket is bound to; guards the reconnect effect
  let roomEpoch = 0; // bumped per room switch; discards a stale fetchIceServers response
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined; // pending auto-reconnect after a WS drop
  let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  // Multi-relay pool + the two peers' measured RTTs to it. Both sides run pickRelay
  // over the same (mine, theirs) data and converge on the same relay id — see the
  // relay-measurement block below.
  let relayPool = $state<RelayEntry[]>([]);
  let myRelayRtt = $state<Record<string, number>>({});
  let peerRelayRtt = $state<Record<string, number>>({});
  let selectedRelayId = $state<string | null>(null);
  // Build the RTCConfiguration for a new connection. On the cross-network path a
  // TURN relay is handed out (via the pairing code); force relay-only ICE there so
  // connection setup is ~1-2 s instead of ~20 s spent waiting for cross-NAT direct
  // candidate checks to time out before ICE would fall back to that relay anyway.
  // Prefer the relay the two peers agreed is fastest; fall back to the whole
  // advertised set. STUN-only rooms (LAN, no code) keep "all" so host candidates work.
  const rtcConfig = (): RtcConfig => {
    const picked = selectedRelayId ? relayPool.find((r) => r.id === selectedRelayId) : undefined;
    if (picked) return { iceServers: picked.iceServers, iceTransportPolicy: "relay" };
    return hasTurnServer(iceServers) ? { iceServers, iceTransportPolicy: "relay" } : { iceServers };
  };

  // ── nearest-relay selection ──────────────────────────────────────────────────────
  // Each peer measures its RTT to every pool relay; the maps are swapped over signaling
  // and both run pickRelay(mine, theirs) to converge on the fastest COMMON relay id
  // (symmetric → same result on both sides, no negotiation). Runs in the background at
  // room join so the choice is usually ready before a transfer starts; until then
  // rtcConfig() falls back to the whole advertised set. No effect on LAN (empty pool).
  let relayMeasureEpoch = 0;
  function resetRelaySelection() {
    relayMeasureEpoch++; // supersede any in-flight measurement from the previous room
    myRelayRtt = {};
    peerRelayRtt = {};
    selectedRelayId = null;
  }
  function broadcastRelayRtt() {
    if (!signaling || Object.keys(myRelayRtt).length === 0) return;
    for (const p of peers) if (p.id !== selfId) signaling.sendSignal(p.id, { relayRtt: myRelayRtt });
  }
  async function startRelayMeasurement() {
    if (relayPool.length === 0) return;
    const epoch = relayMeasureEpoch;
    const rtt = await measureRelays(relayPool);
    if (epoch !== relayMeasureEpoch) return; // room switched while measuring — discard
    myRelayRtt = rtt;
    selectedRelayId = pickRelay(myRelayRtt, peerRelayRtt);
    broadcastRelayRtt();
  }
  // Peer's measurement arrived: record it and re-derive the choice. We never reply
  // here (broadcasts fire on measure-done and on peer-join instead), so there is no
  // ping-pong loop.
  function onPeerRelayRtt(from: string, data: unknown) {
    const d = data as { relayRtt?: Record<string, number>; rename?: string };
    const m = d.relayRtt;
    if (m && from !== selfId) {
      peerRelayRtt = m;
      selectedRelayId = pickRelay(myRelayRtt, peerRelayRtt);
    }
    if (typeof d.rename === "string") {
      peers = applyRename(peers, from, d.rename);
    }
  }
  let acceptFn: (() => void) | null = null;
  let rejectFn: (() => void) | null = null;
  // Abort handles for an in-flight transfer — let the user bail out of a stuck
  // send/receive and return to idle (so they can pick another method).
  let sendAbort: (() => void) | null = null;
  let recvAbort: (() => void) | null = null;

  const t = $derived<Messages>(messages[lang()]);
  const visiblePeers = $derived(peers.filter((p) => p.id !== selfId));
  // Which peer's send card is expanded below the radar. Solo auto-selects; a
  // stale selection (peer left) falls back to none.
  let selectedPeerId = $state("");
  const effectiveSelected = $derived(
    visiblePeers.length === 1
      ? visiblePeers[0].id
      : visiblePeers.some((p) => p.id === selectedPeerId) ? selectedPeerId : "",
  );
  const selectedPeer = $derived(visiblePeers.find((p) => p.id === effectiveSelected) ?? null);
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
    currentRoute() === "download" || currentRoute() === "offline" || currentRoute() === "me" || currentRoute() === "cli"
    || currentRoute() === "apps"
    || currentRoute() === "pricing" || currentRoute() === "verify-email" || currentRoute() === "reset-password"
      ? false
      : currentRoute() === "cross"
        ? showTransfer
        : !unsupported,
  );

  // Reflect transfer progress in the tab title (follows the language switch), and
  // set the per-route <title>/<meta description> otherwise (SEO for the
  // cross-network/offline-transfer product modes).
  $effect(() => {
    const x = (send && !send.done && send) || (recv && !recv.done && recv);
    const meta = pageMeta(currentRoute(), messages[lang()]);
    document.title = x
      ? `${pct(x)}% ${x.dir === "send" ? "↑" : "↓"} · Relayium`
      : meta.title;
    const md = document.querySelector('meta[name="description"]');
    if (md) md.setAttribute("content", meta.description);
    const canon = location.origin + meta.canonicalPath;
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", canon);
    document.querySelector('meta[property="og:url"]')?.setAttribute("content", canon);
    // Repoint the hreflang alternates at this route's own localized URLs; index.html
    // hard-codes the homepage cluster, which is wrong for /cross-network & /offline-transfer.
    for (const { hreflang, path } of altHreflangs(meta.canonicalPath)) {
      document
        .querySelector(`link[rel="alternate"][hreflang="${hreflang}"]`)
        ?.setAttribute("href", location.origin + path);
    }
  });

  // Notify when a transfer finishes and the user is on another tab/app, so a long
  // transfer needn't be babysat. Edge-detected per direction; each flag resets
  // when its card clears so the next transfer notifies again. notifyTransfer
  // itself no-ops when the tab is visible or permission wasn't granted.
  let sendNotified = false;
  let recvNotified = false;
  $effect(() => {
    const s = send;
    if (s?.done) {
      if (!sendNotified) {
        sendNotified = true;
        void notifyTransfer(statusText(messages[lang()], s));
        // Record exactly once per completed transfer, reusing this same one-shot
        // gate (client-local, best-effort — never touches the server).
        if (s.ok) {
          recordTransfer({ name: xferLabel(s), size: s.total, direction: "send", peer: nameOf(s.peer) });
          history = loadHistory();
        }
      }
    }
    else sendNotified = false;
  });
  $effect(() => {
    const r = recv;
    if (r?.done) {
      if (!recvNotified) {
        recvNotified = true;
        void notifyTransfer(statusText(messages[lang()], r));
        if (r.ok) {
          recordTransfer({ name: xferLabel(r), size: r.total, direction: "recv", peer: nameOf(r.peer) });
          history = loadHistory();
        }
      }
    }
    else recvNotified = false;
  });

  // Auto-dismiss a *successful* completion card after a few minutes so the user has
  // ample time to see the result, while back-to-back batches still don't stack stale
  // cards (a new transfer replaces the card immediately — the effect's cleanup
  // cancels this timer and the identity guard avoids clearing the new one). Failure
  // cards stay put (they need a read + a deliberate dismiss).
  const DISMISS_MS = 180_000; // 3 minutes
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
  let pendingPeer = $state<Peer | null>(null);
  let dismissedPeerId = $state<string | null>(null);

  $effect(() => {
    if (outbox().length && surfaceShown && !busy && visiblePeers.length === 1) {
      const peer = visiblePeers[0];
      if (!shouldConfirmBeforeSend(roomCode)) {
        sendFiles(peer.id, takeOutbox()); // LAN: unchanged frictionless auto-send
        return;
      }
      // Code room: surface a confirmation bar instead of auto-sending, so a
      // code-guesser who joined never receives the files automatically.
      if (!pendingPeer && peer.id !== dismissedPeerId) pendingPeer = peer;
    } else {
      pendingPeer = null; // peer left / conditions changed
    }
  });

  function confirmSend() {
    if (pendingPeer) {
      const id = pendingPeer.id;
      pendingPeer = null;
      sendFiles(id, takeOutbox());
    }
  }
  function cancelSend() {
    if (pendingPeer) {
      dismissedPeerId = pendingPeer.id; // don't re-prompt this joiner; keep files queued for a different peer
      pendingPeer = null;
    }
  }

  // Poll the live ICE path a few times once a channel is up: the selected
  // candidate pair can settle shortly after the data channel opens.
  async function trackPath(conn: Conn, set: (p: ConnPath) => void) {
    activeConn = conn; // latest live connection — the ?debug=1 panel polls its stats
    for (let i = 0; i < 8; i++) {
      const p = await conn.path();
      if (p !== "unknown") { set(p); return; }
      await sleep(400);
    }
  }

  // ── ?debug=1 diagnostics ─────────────────────────────────────────────────────────
  // Read-only WebRTC stats surfaced in-page (phones have no dev console). Never
  // auto-uploaded — the user copies what to share. ?debug=1 turns it on and REMEMBERS
  // it (localStorage), because room entry rewrites the URL: the pairing code lives in
  // the # fragment and enterRoom drops the query string, so a one-shot ?debug=1 would
  // vanish. Persisting lets a phone enable it once on the base URL, then open a code
  // link normally and still get the panel. ?debug=0 turns it back off.
  function readDebugFlag(): boolean {
    const q = new URLSearchParams(location.search).get("debug");
    try {
      if (q === "1") { localStorage.setItem("relayium-debug", "1"); return true; }
      if (q === "0") { localStorage.removeItem("relayium-debug"); return false; }
      return localStorage.getItem("relayium-debug") === "1";
    } catch { return q === "1"; } // storage disabled (private mode) — honour the URL only
  }
  let debugOn = $state(readDebugFlag());
  let activeConn: Conn | null = null; // set in trackPath; the panel reads .stats()
  let dbg = $state<ConnDiagnostics | null>(null);
  let dbgIncludeIps = $state(false);
  let dbgFrozen = $state(false); // pause polling so values hold still to read/copy
  $effect(() => {
    if (!debugOn) return;
    const poll = async () => {
      if (dbgFrozen) return; // frozen: keep the last snapshot on screen
      if (!activeConn) { dbg = null; return; }
      try { dbg = summarizeStats(await activeConn.stats(), dbgIncludeIps); }
      catch { dbg = null; } // pc closed between transfers — stats() can reject
    };
    poll();
    const iv = setInterval(poll, 1000);
    return () => clearInterval(iv);
  });
  function copyDiagnostics() {
    navigator.clipboard?.writeText(JSON.stringify(dbg, null, 2)).catch(() => { /* denied */ });
  }
  function closeDebug() {
    try { localStorage.removeItem("relayium-debug"); } catch { /* ignore */ }
    debugOn = false;
  }
  const relayRttText = (m: Record<string, number>): string => {
    const parts = Object.entries(m).map(([id, ms]) => `${id}:${ms}`);
    return parts.length ? parts.join(" ") : "—";
  };

  onMount(async () => {
    document.documentElement.lang = lang();
    document.documentElement.dir = dir(lang());
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
    const ice = await fetchIceConfig(roomCode);
    iceServers = ice.iceServers;
    relayPool = ice.relays;
    relayDenied = ice.relayDenied ?? "";
    signaling = new SignalingClient(wsURL(location, roomCode), selfName);
    signaling.onSelfId((id, ip) => {
      selfId = id; selfIP = ip; joinedRoom = true;
      // A welcome means the socket is (re)connected — clear any reconnect state.
      connState = "ready";
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    });
    // A peer (re)appearing is our cue to (re)send our relay measurements to it.
    signaling.onPeers((p) => { peers = p; broadcastRelayRtt(); });
    signaling.onSignal(onPeerRelayRtt); // capture peers' relay-RTT maps (ignored by the WebRTC handlers)
    startRelayMeasurement(); // background; the choice is usually ready before a transfer
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
    relayDenied = "";
    incoming = null;
    send = null;
    recv = null;
    sasCode = "";
    connState = "connecting";
    resetRelaySelection(); // the new room has its own relay pool + measurements
    const ice = await fetchIceConfig(roomCode);
    // A rapid second switch may have started (and possibly finished) while this
    // fetch was in flight — discard the stale credentials rather than clobbering
    // the newer room's TURN config and socket.
    if (epoch !== roomEpoch) return;
    iceServers = ice.iceServers;
    relayPool = ice.relays;
    relayDenied = ice.relayDenied ?? "";
    signaling.reconnect(wsURL(location, roomCode));
    startRelayMeasurement(); // measure the new room's pool in the background
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
  // User-initiated rename of this device: persist under the same key deviceName()
  // reads, then tell every visible peer so their roster picks up the new name too.
  // An empty (post-trim) name is a no-op — keeps whatever name was already set.
  function commitName(next: string) {
    const name = next.trim().slice(0, 64);
    if (!name) return;
    selfName = name;
    try { localStorage.setItem(DEVICE_NAME_KEY, name); } catch { /* ignore */ }
    for (const p of visiblePeers) signaling.sendSignal(p.id, { rename: name });
  }
  function flash(msg: string) {
    notice = msg;
    setTimeout(() => { if (notice === msg) notice = ""; }, 3500);
  }
  function clearHistoryPanel() {
    clearHistory();
    history = loadHistory();
  }
  function historyWhen(at: number): string {
    return new Date(at).toLocaleString();
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
    let lastAckSent = 0; // cumulative bytes at our last flow-control ack to the sender
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
      config: rtcConfig(),
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
          config: rtcConfig(),
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
        lastAckSent = got; // realign the ack cursor so the first post-resume ack is fresh
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
        // Flow-control: report durably-written bytes so the sender paces itself to
        // our disk speed and keeps at most one window ahead. Throttled by interval.
        if (got - lastAckSent >= FLOW_ACK_INTERVAL) {
          lastAckSent = got;
          try { conn!.channel.send(ackFrame(got)); } catch { /* gone — the drop path handles it */ }
        }
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

    // Application-level flow control: the receiver reports cumulative durably-written
    // bytes; we never run more than FLOW_WINDOW ahead of that. `ackedAt` is the last
    // time the ack advanced — flush() uses it as a liveness signal so it waits for a
    // slow-but-alive receiver instead of closing on a fixed short timeout.
    let acked = 0;
    let ackedAt = Date.now();
    let ackWaiter: (() => void) | null = null;
    const onAck = (n: number) => {
      if (n > acked) { acked = n; ackedAt = Date.now(); const w = ackWaiter; ackWaiter = null; w?.(); }
    };
    // Block until the receiver's acks let us send more (or it goes silent — then
    // throw so the send loop treats it as a drop and resumes/fails, not hangs).
    const creditGate = async (sent: number) => {
      while (sent - acked > FLOW_WINDOW) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { ackWaiter = null; reject(new Error("send stalled: receiver not acking")); }, 60_000);
          ackWaiter = () => { clearTimeout(timer); resolve(); };
        });
      }
    };

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
            signaling, peerId, role: "initiator", config: rtcConfig(),
            onStateChange: (state) => { if (state === "failed" || state === "closed") lost = true; },
          });
          conn = rconn; // so sendAbort tears down the current connection
          let resolveReq!: (rp: ResumePoint) => void;
          const reqReceived = new Promise<ResumePoint>((r) => (resolveReq = r));
          let doneAck = false;
          rconn.channel.onmessage = (ev) => {
            const buf = ev.data as ArrayBuffer;
            const a = parseAck(buf);
            if (a !== null) { onAck(a); return; }
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
          acked = base; // the receiver already has these bytes; open the window from here
          ackedAt = Date.now();
          const start = Date.now();
          let sent = base, idx = rp.index;
          for await (const frame of sender.dataFrames(files, keys, rp)) {
            if (lost) throw new Error("connection lost during resume");
            await backpressure(rconn.channel);
            await creditGate(sent); // don't outrun the receiver's durable writes
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
          await flush(rconn.channel, completeAck, () => ackedAt);
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
        config: rtcConfig(),
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
        const buf = ev.data as ArrayBuffer;
        const a = parseAck(buf);
        if (a !== null) { onAck(a); return; }
        const k = controlKind(buf);
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
        await creditGate(sent); // don't outrun the receiver's durable writes
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
      await flush(conn.channel, completed, () => ackedAt);
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

  // Wait until it is safe to close: ideally the receiver's explicit completion ack.
  // Until then keep waiting while the receiver is still alive — either our send
  // buffer is still draining, or its flow-control acks are still advancing (a slow
  // phone writing the last window to disk). Only give up once BOTH have been idle
  // for the grace period, so we never close on a receiver that is merely slow (the
  // old fixed 1 s fallback did exactly that, dropping the tail and faking a "drop").
  async function flush(ch: RTCDataChannel, completed: Promise<void>, lastAckAt: () => number) {
    let done = false;
    void completed.then(() => { done = true; });
    while (!done) {
      if (ch.bufferedAmount === 0 && Date.now() - lastAckAt() > 30_000) return;
      await sleep(250);
    }
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
{#snippet peerCard(p: Peer, solo: boolean)}
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
{/snippet}

{#snippet transferSurface()}
  {@const solo = visiblePeers.length === 1}
  <section class="peers">
    <h2>{currentRoute() === "cross" ? t.crossPeersTitle : t.peersTitle}</h2>
    <QuotaNotice />
    {#if outbox().length && visiblePeers.length !== 1}
      <p class="share-pending">{t.sharePending(outbox().length)}</p>
    {/if}
    {#if pendingPeer}
      <div class="confirm-send" role="alertdialog" aria-live="polite">
        <span>{t.confirmRecv(nameOf(pendingPeer.id))}</span>
        <button class="btn btn-primary" onclick={confirmSend}>{t.confirmRecvSend}</button>
        <button class="btn" onclick={cancelSend}>{t.confirmRecvCancel}</button>
      </div>
    {/if}
    {#if currentRoute() === "lan"}
      <DeviceRadar
        peers={visiblePeers}
        {selfName}
        selectedId={effectiveSelected}
        onSelect={(id) => (selectedPeerId = id)}
      />
      {#if visiblePeers.length === 0}
        <div class="empty">
          <p class="empty-lead">{t.emptyPeers}</p>
          <button class="btn btn-ghost empty-cta" onclick={() => navigate("cross")}>{t.emptyCrossCta}</button>
        </div>
      {:else if selectedPeer}
        <ul class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, busy) === "pick"}>
          {@render peerCard(selectedPeer, solo)}
        </ul>
      {/if}
    {:else}
      {#if visiblePeers.length === 0}
        <div class="empty">
          <p class="empty-lead">{t.emptyPeers}</p>
        </div>
      {:else}
        <ul class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, busy) === "pick"}>
          {#each visiblePeers as p (p.id)}
            {@render peerCard(p, solo)}
          {/each}
        </ul>
      {/if}
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
      {#if xf.done && !xf.ok && xf.status === "connectFail" && relayDenied === "quota"}
        <p class="quota-note">{t.crossnet.relayQuotaFail}</p>
      {/if}
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
    <div class="dropzone" transition:fade={{ duration: 140 }}>
      <div class="dropzone-inner">
        {dropTarget(visiblePeers.length, busy) === "send"
          ? t.dragSendOne(visiblePeers[0].name)
          : t.dragSendMany}
      </div>
    </div>
  {/if}

  {#if currentRoute() === "download"}
    {#await routePage("download") then { default: DownloadPage }}
      <DownloadPage id={downloadId(location.pathname)} />
    {/await}
  {:else}
  <Nav />

  {#if currentRoute() === "cross"}
    {#await routePage("cross") then { default: CrossPage }}
      <CrossPage {roomCode} {linkDead} {showTransfer} {relayDenied} {transferSurface} dismissLan={() => (lanDismissed = true)} />
    {/await}
  {:else if currentRoute() === "offline"}
    {#await routePage("offline") then { default: OfflinePage }}
      <OfflinePage />
    {/await}
  {:else if currentRoute() === "me"}
    {#await routePage("me") then { default: MePage }}
      <MePage />
    {/await}
  {:else if currentRoute() === "cli"}
    {#await routePage("cli") then { default: CliPage }}
      <CliPage />
    {/await}
  {:else if currentRoute() === "apps"}
    {#await routePage("apps") then { default: AppsPage }}
      <AppsPage />
    {/await}
  {:else if currentRoute() === "pricing"}
    {#await routePage("pricing") then { default: PricingPage }}
      <PricingPage />
    {/await}
  {:else if currentRoute() === "verify-email"}
    {#await routePage("verify-email") then { default: VerifyEmail }}
      <VerifyEmail />
    {/await}
  {:else if currentRoute() === "reset-password"}
    {#await routePage("reset-password") then { default: ResetPassword }}
      <ResetPassword />
    {/await}
  {:else}
    <Hero {connState} {unsupported} {selfName} {selfIP} onRename={commitName} />

  {#if notice}
    <div class="toast" role="status" aria-live="polite">{notice}</div>
  {/if}

  {#if unsupported}
    <div class="banner error">{t.unsupported}</div>
  {:else}
    {@render transferSurface()}

    <section class="card history">
      <details>
        <summary>{t.historyTitle}</summary>
        {#if history.length}
          <ul class="filelist">
            {#each history as e (e.id)}
              <li>
                <span class="fname">{e.direction === "send" ? "↑" : "↓"} {e.name} · {e.peer}</span>
                <span class="fsize">{formatSize(e.size)} · {historyWhen(e.at)}</span>
              </li>
            {/each}
          </ul>
          <button type="button" class="btn btn-ghost history-clear" onclick={clearHistoryPanel}>{t.historyClear}</button>
        {:else}
          <p class="history-empty">{t.historyEmpty}</p>
        {/if}
      </details>
    </section>

    <HowToSteps maxFiles={MAX_FILES} />

    <section class="crosscta reveal" use:reveal>
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
    <CliCallout />
    <UseCases />
    <Faq variant="home" />

    <footer>
      <nav class="legal" aria-label="Legal">
        <a href={legalUrl("security", lang())}>{t.legal.security}</a>
        <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
        <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
        <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
      <nav class="legal" aria-label="Guides">
        <a href={PRICING_PATH} onclick={(e) => { e.preventDefault(); navigate("pricing"); }}>{t.pricingPage.navLink}</a>
        <a href={pageUrl("guides", lang())}>{t.learn.hub}</a>
      </nav>
      <span class="fineprint">{t.footer}</span>
    </footer>
  {/if}
  {/if}
  {/if}
</main>

{#if debugOn}
  <aside class="dbg" class:frozen={dbgFrozen} aria-label="connection diagnostics">
    <div class="dbg-head">
      <strong>调试 · 连接诊断{dbgFrozen ? " · 已冻结" : ""}</strong>
      <label><input type="checkbox" bind:checked={dbgIncludeIps} /> 含 IP</label>
      <button type="button" onclick={() => (dbgFrozen = !dbgFrozen)}>{dbgFrozen ? "继续" : "冻结"}</button>
      <button type="button" onclick={copyDiagnostics} disabled={!dbg}>复制</button>
      <button type="button" class="dbg-x" onclick={closeDebug} title="关闭调试" aria-label="关闭调试">✕</button>
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
{/if}

<style>
  main {
    position: relative;
    width: 100%;
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 20px 48px;
    box-sizing: border-box;
    text-align: start;
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
  .card.ok { border-color: #2ecc71; animation: card-ok-pop .55s ease-out; }
  @keyframes card-ok-pop {
    0% { box-shadow: 0 0 0 0 rgba(46, 204, 113, .45); }
    100% { box-shadow: 0 0 0 7px rgba(46, 204, 113, 0); }
  }
  .card.bad { border-color: var(--accent-border); }
  .card.request { border-color: var(--accent-border); background: var(--accent-bg); }

  .req-head { font-size: 15px; margin-bottom: 10px; }
  .filelist { list-style: none; margin: 0 0 12px; padding: 0; max-height: 200px; overflow: auto; }
  .filelist li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px dashed var(--border); font-size: 14px; }
  .filelist li:last-child { border-bottom: none; }
  .fname { color: var(--text-h); word-break: break-all; }
  .fsize { color: var(--text); white-space: nowrap; }

  .history summary { cursor: pointer; font-weight: 600; color: var(--text-h); }
  .history .filelist { margin-top: 12px; }
  .history-empty { margin: 12px 0 0; font-size: 13.5px; color: var(--text); }
  .history-clear { margin-top: 4px; font-size: 13px; padding: 6px 12px; }
  .sas {
    font-size: 13.5px; margin-bottom: 14px; padding: 10px 12px;
    border-radius: 10px; background: var(--accent-bg); border: 1px solid var(--accent-border);
  }
  .sas code { font-size: 16px; font-weight: 700; letter-spacing: 1px; background: transparent; padding: 0 2px; }

  .actions { display: flex; gap: var(--space-3); }

  .xfer-head { display: flex; align-items: center; gap: 10px; }
  .xfer-head .label { color: var(--accent); font-size: 14px; font-weight: 500; white-space: nowrap; }
  .xfer-head .count { color: var(--text); font-size: 13px; margin-inline-start: auto; word-break: break-all; text-align: end; }
  button.x {
    margin-inline-start: 8px; padding: 2px 8px; font: inherit; font-size: var(--fs-xs);
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
  .xfer .quota-note {
    margin: var(--space-2) 0 0; font-size: var(--fs-xs); line-height: 1.5;
    color: var(--text-h);
    border: 1px solid var(--accent-border); border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3); background: var(--accent-bg);
  }

  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
  /* A translucent sheen sweeps across the filled portion so an in-flight transfer
     reads as actively moving, not stalled. The fill only renders while !done. */
  .fill {
    height: 100%; border-radius: 999px;
    background:
      linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, .35) 50%, transparent 100%),
      linear-gradient(90deg, var(--accent), var(--accent-deep));
    background-size: 40% 100%, 100% 100%;
    background-repeat: no-repeat;
    transition: width .2s ease;
    animation: fill-sheen 1.4s linear infinite;
  }
  @keyframes fill-sheen {
    from { background-position: -45% 0, 0 0; }
    to   { background-position: 145% 0, 0 0; }
  }
  .meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: 12.5px; color: var(--text); }
  .meta-right { display: inline-flex; align-items: center; gap: 12px; }
  /* Connection-path badge: a coloured dot + label. Green LAN, blue P2P, orange relay. */
  .path { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .path .dot {
    width: 7px; height: 7px; border-radius: 999px; background: currentColor; flex: none;
    animation: dot-pulse 1.2s ease-in-out infinite;
  }
  @keyframes dot-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .fill { animation: none; background: linear-gradient(90deg, var(--accent), var(--accent-deep)); }
    .path .dot { animation: none; }
    .card.ok { animation: none; }
  }
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
  .confirm-send {
    margin: 0 0 12px; padding: 10px 14px; border-radius: 10px;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    color: var(--text); font-size: 14px;
  }
  .confirm-send span { flex: 1 1 auto; }
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
    background: var(--grad-accent);
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
    animation: dz-pop .28s cubic-bezier(.22, 1, .36, 1), dz-breathe 1.8s ease-in-out .28s infinite;
  }
  /* Pop in on grab, then a slow accent breathe so the target reads as "live". */
  @keyframes dz-pop {
    0% { opacity: 0; transform: scale(.9); }
    100% { opacity: 1; transform: scale(1); }
  }
  @keyframes dz-breathe {
    0%, 100% { box-shadow: var(--shadow), 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
    50% { box-shadow: var(--shadow), 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) { .dropzone-inner { animation: none; } }
  .peers ul.dragging .peer { border-color: var(--accent-border); background: var(--accent-bg); }

  /* ?debug=1 connection diagnostics — fixed, unobtrusive, monospace. */
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
  .dbg-head .dbg-x { margin-inline-start: auto; padding: 3px 8px; }
  .dbg dl { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 0; }
  .dbg dt { opacity: 0.6; }
  .dbg dd { margin: 0; word-break: break-all; }
  .dbg dd.relay { color: #ffb454; } /* relay path is highlighted — the speed-relevant case */
  .dbg-idle { margin: 0; opacity: 0.7; }
  .dbg-relay { margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #3a3a40; word-break: break-all; }
  .dbg-relay b { color: #7fd88f; }
</style>
