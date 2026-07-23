<script lang="ts">
  import { onMount } from "svelte";
  import { formatSize } from "./lib/format";
  import { fade } from "svelte/transition";
  import { ready } from "./lib/crypto";
  import { SignalingClient } from "./lib/signaling";
  import { wsURL } from "./lib/transfer-link";
  import { roomCode as roomCodeStore, initRoomFromLocation } from "./lib/room.svelte";
  import type { Conn, ConnPath, RtcConfig } from "./lib/webrtc";
  import { applyRename } from "./lib/apply-rename";
  import { createWakeLock } from "./lib/wakelock";
  import { registerServiceWorker, drainSharedFiles } from "./lib/share-target";
  import { requestNotifyPermission, notifyTransfer } from "./lib/notify";
  import { MAX_FILES } from "./lib/transfer";
  import { createTransferSession, type Xfer } from "./lib/transfer-session.svelte";
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
  import ReceiveActions from "./lib/ReceiveActions.svelte";
  import DebugPanel from "./lib/DebugPanel.svelte";

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
    // 不是路由，是首页折叠线以下那一大块 —— 借用同一个记忆化加载器，省得再写一套。
    "home-sections": () => import("./lib/HomeSections.svelte"),
  } as const;
  const routeCache = new Map<string, ReturnType<(typeof routeLoaders)[keyof typeof routeLoaders]>>();
  function routePage<K extends keyof typeof routeLoaders>(key: K): ReturnType<(typeof routeLoaders)[K]> {
    let p = routeCache.get(key);
    if (!p) { p = routeLoaders[key](); routeCache.set(key, p); }
    return p as ReturnType<(typeof routeLoaders)[K]>;
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

  // 收发管道 + 它们的状态（send/recv/incoming/SAS/每向路径）都住在这里。
  // 依赖用 getter 传进去：signaling 会随房间切换整个换掉，rtcConfig 依赖中继选优
  // 的结果，两者都不能在创建时定死。
  const session = createTransferSession({
    signaling: () => signaling,
    rtcConfig: () => rtcConfig(),
    t: () => messages[lang()],
    flash,
  });
  // 模板里读得最多的三个，取个短名字（getter 转发，响应式不丢）。
  const send = $derived(session.send);
  const recv = $derived(session.recv);
  const incoming = $derived(session.incoming);

  // Client-local "recent transfers" log (localStorage-backed, this device only).
  // Refreshed after each recorded completion and on clear — never read live from
  // storage during render.
  let history = $state<HistEntry[]>(loadHistory());
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
  // /api/ice 返回前的初始值。空列表：默认值放第三方 STUN 等于每次加载都可能先向它
  // 报到一次（公网 IP + 会话时序）。理由同 ice.ts 的 FALLBACK。
  let iceServers: RTCIceServer[] = [];
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
  const busy = $derived(session.busy);
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

  // <head> upkeep, split in two on purpose. The meta/canonical/hreflang block
  // depends only on route + language, but it used to sit in the same effect as
  // the progress title — which reads `send`/`recv` and therefore re-ran on every
  // 192KB chunk, redoing ~14 querySelector/setAttribute calls hundreds of times
  // a second during a transfer. Keeping them apart means the DOM work happens
  // on navigation, and the hot path only touches document.title.
  $effect(() => {
    const meta = pageMeta(currentRoute(), messages[lang()]);
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

  // Reflect transfer progress in the tab title (follows the language switch), and
  // fall back to the per-route title when nothing is in flight. Throttled at the
  // source: `send`/`recv` only change every UI_TICK_MS during a transfer.
  $effect(() => {
    const x = (send && !send.done && send) || (recv && !recv.done && recv);
    document.title = x
      ? `${pct(x)}% ${x.dir === "send" ? "↑" : "↓"} · Relayium`
      : pageMeta(currentRoute(), messages[lang()]).title;
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
      const timer = setTimeout(() => session.dismissSend(s), DISMISS_MS);
      return () => clearTimeout(timer);
    }
  });
  $effect(() => {
    const r = recv;
    if (r?.done && r.ok) {
      const timer = setTimeout(() => session.dismissRecv(r), DISMISS_MS);
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
        session.sendFiles(peer.id, takeOutbox()); // LAN: unchanged frictionless auto-send
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
      session.sendFiles(id, takeOutbox());
    }
  }
  function cancelSend() {
    if (pendingPeer) {
      dismissedPeerId = pendingPeer.id; // don't re-prompt this joiner; keep files queued for a different peer
      pendingPeer = null;
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
  function closeDebug() {
    try { localStorage.removeItem("relayium-debug"); } catch { /* ignore */ }
    debugOn = false;
  }

  // Separate, *synchronous* onMount: Svelte only honours a cleanup function
  // returned directly, so anything registered in the async onMount below can
  // never be torn down (its return value is a Promise, which Svelte ignores).
  onMount(() => {
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      wake.destroy(); // 摘掉它自己挂的 visibilitychange
    };
  });

  onMount(async () => {
    document.documentElement.lang = lang();
    document.documentElement.dir = dir(lang());
    initRoomFromLocation();
    syncRouteFromLocation();
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
      reconnectAttempt = 0; // the next outage starts from the short delay again
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
    session.listenForIncoming();
    socketRoomKey = roomCode;
    connState = "ready";
  });

  // Reconnect the signalling socket to the current room after an unexpected drop.
  // A single pending timer at a time; onSelfId cancels it once the welcome lands.
  //
  // Exponential backoff with jitter, NOT a fixed interval: when the signalling
  // server restarts, every client in the world drops at the same instant, and a
  // fixed 2s retry turns them into a synchronised herd that re-DoSes the server
  // as it comes back up (and drains phone batteries while it's down). The jitter
  // is what breaks the synchronisation; the ceiling keeps a long outage cheap.
  const RECONNECT_BASE_MS = 2_000;
  const RECONNECT_MAX_MS = 30_000;
  let reconnectAttempt = 0;
  function scheduleReconnect() {
    if (reconnectTimer) return;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    const delay = Math.round(backoff * (0.75 + Math.random() * 0.5)); // ±25% jitter
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!signaling) return;
      // reconnect() intentionally swaps the socket (won't re-fire onClose); if this
      // fresh socket also closes, onClose runs again and re-schedules.
      signaling.reconnect(wsURL(location, roomCode));
    }, delay);
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
    reconnectAttempt = 0; // a deliberate room switch is not an outage — don't inherit its backoff
    session.abortAll();
    peers = [];
    selfId = "";
    selfIP = "";
    joinedRoom = false;
    linkDead = false;
    relayDenied = "";
    session.reset();
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
        filesFromDataTransfer(e.dataTransfer).then((picked) => { if (picked.length) session.sendFiles(peer, picked); });
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
    if (input.files?.length) session.sendFiles(peerId, pickedFromInput(input.files));
    input.value = ""; // allow re-picking the same files
  }
  function onDrop(e: DragEvent, peerId: string) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove("drag");
    if (!e.dataTransfer) return;
    // Kick off entry extraction now (it captures DataTransfer items synchronously
    // before its first await), then send once the folder tree is flattened.
    filesFromDataTransfer(e.dataTransfer).then((picked) => { if (picked.length) session.sendFiles(peerId, picked); });
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
      <input class="file-pick-input" id={`pick-${p.id}`} type="file" multiple disabled={busy}
        onclick={(e) => { if (outbox().length) { e.preventDefault(); session.sendFiles(p.id, takeOutbox()); } }}
        onchange={(e) => pickFile(e, p.id)} />
    </label>
    <div class="peer-actions">
      <label class="act-btn" class:disabled={busy} for={`pick-${p.id}`}>📄 {t.sendFile}</label>
      {#if folderUploadSupported}
        <label class="act-btn" class:disabled={busy}>
          📁 {t.sendFolder}
          <input class="file-pick-input" type="file" webkitdirectory multiple disabled={busy} onchange={(e) => pickFile(e, p.id)} />
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
      {#if session.sasCode}
        <div class="sas">{t.codeLabel} <code>{session.sasCode}</code> — {t.codeCompare}</div>
      {/if}
      <!-- 收/拒按钮住在 ReceiveActions 里，因为大批次的内存提示必须拦在这一下
           点击之前：接受即用户手势，pickSaveTarget 在同一个手势里开选择器。 -->
      <ReceiveActions
        files={incoming.files}
        total={incoming.total}
        onAccept={() => session.accept()}
        onReject={() => session.reject()}
      />
    </section>
  {/if}

  {#each [send, recv].filter(Boolean) as x (x!.dir)}
    {@const xf = x as Xfer}
    <section class="card xfer" class:ok={xf.done && xf.ok} class:bad={xf.done && !xf.ok} out:fade={{ duration: 300 }}>
      <div class="xfer-head">
        <span class="label">{xf.dir === "send" ? t.sendTo(nameOf(xf.peer)) : t.recvFrom(nameOf(xf.peer))}</span>
        {#if xf.files.length}<span class="count">{xf.files.length > 1 ? t.fileCounter(xf.index + 1, xf.files.length) : xf.files[0].name}</span>{/if}
        {#if xf.done}
          <button class="x" onclick={() => (xf.dir === "send" ? session.dismissSend(xf) : session.dismissRecv(xf))} aria-label={t.close}>✕</button>
        {:else}
          <button class="x cancel" onclick={() => session.abort(xf.dir)}>{t.cancel}</button>
        {/if}
      </div>
      <div class="status" aria-live="polite">
        {statusText(t, xf)}
        {#if session.sasCode && !xf.done} · {t.codeLabel} <code>{session.sasCode}</code>{/if}
      </div>
      {#if xf.done && !xf.ok && xf.status === "connectFail" && relayDenied === "quota"}
        <p class="quota-note">{t.crossnet.relayQuotaFail}</p>
      {/if}
      {#if !xf.done}
        {@const path = xf.dir === "send" ? session.sendPath : session.recvPath}
        <div class="progress-bar" role="progressbar" aria-valuenow={pct(xf)} aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style:width="{pct(xf)}%"></div></div>
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

    <!-- 折叠线以下的营销区块：懒加载，深链访客（/d/<id>、/me…）不必为首页长文案
         付下载成本。await 里不放占位骨架——它在首屏之外，加载期间什么都不显示比
         闪一块灰更安稳。 -->
    {#await routePage("home-sections") then { default: HomeSections }}
      <HomeSections maxFiles={MAX_FILES} />
    {/await}

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
  <DebugPanel
    conn={session.conn}
    relayPool={relayPool}
    selectedRelayId={selectedRelayId}
    myRelayRtt={myRelayRtt}
    peerRelayRtt={peerRelayRtt}
    onclose={closeDebug}
  />
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
  /* A translucent sheen sweeps across the filled portion so an in-flight transfer
     reads as actively moving, not stalled. The fill only renders while !done. */
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
</style>
