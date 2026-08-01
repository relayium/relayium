<script lang="ts">
  import { onMount, tick } from "svelte";
  import { formatSize } from "./lib/format";
  import { fade } from "svelte/transition";
  import { ready } from "./lib/crypto";
  import { SignalingClient } from "./lib/signaling";
  import { wsURL } from "./lib/transfer-link";
  import { roomCode as roomCodeStore, initRoomFromLocation } from "./lib/room.svelte";
  import type { Conn, ConnPath, RtcConfig } from "./lib/webrtc";
  import { applyRename } from "./lib/apply-rename";
  import { capsSignal, recordPeerCaps, retainPeers, resetPeerCaps, peerSupportsText } from "./lib/peer-caps.svelte";
  import { createTextSession } from "./lib/text-session.svelte";
  import { createTextLink } from "./lib/text-link";
  import { pastedText } from "./lib/paste-text";
  import MessagePanel from "./lib/MessagePanel.svelte";
  import Icon from "./lib/Icon.svelte";
  import { createWakeLock } from "./lib/wakelock";
  import { registerServiceWorker, drainSharedFiles } from "./lib/share-target";
  import { requestNotifyPermission, notifyTransfer } from "./lib/notify";
  import { MAX_FILES } from "./lib/transfer";
  import { createTransferSession, type Xfer } from "./lib/transfer-session.svelte";
  import { createPeerWorkspace, type PeerWorkspace } from "./lib/peer-workspace.svelte";
  import { recordTransfer, loadHistory, clearHistory, historyEnabled, setHistoryEnabled, type HistEntry } from "./lib/history";
  import { fetchIceConfig, hasTurnServer, measureRelays, pickRelay, type RelayEntry } from "./lib/ice";
  import type { Peer } from "./lib/protocol";
  import { lang, dir, messages, legalUrl, pageUrl, type Messages, type StatusKey } from "./lib/i18n.svelte";
  import { applyHeadMeta, pageMeta } from "./lib/page-meta";
  import { hasFiles, dropTarget, pickedFromInput, filesFromDataTransfer, type PickedFile } from "./lib/drag";
  import { outbox, setOutbox, takeOutbox, clearOutbox } from "./lib/outbox.svelte";
  import { shouldConfirmBeforeSend } from "./lib/confirm-send";
  import { folderUploadSupported } from "./lib/platform";
  import { reveal } from "./lib/reveal";
  import Nav from "./lib/Nav.svelte";
  import { currentRoute, syncRouteFromLocation, downloadId, navigate, setNavGuard, PRICING_PATH } from "./lib/router.svelte";
  import Hero from "./lib/Hero.svelte";
  import DeviceRadar from "./lib/DeviceRadar.svelte";
  import PeerLink from "./lib/PeerLink.svelte";
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
    "magic-link": () => import("./lib/MagicLink.svelte"),
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

  // 收发管道 + 它们的状态（send/recv/incoming/SAS/每向路径）都住在这里。
  // 依赖用 getter 传进去：signaling 会随房间切换整个换掉，rtcConfig 依赖中继选优
  // 的结果，两者都不能在创建时定死。
  // 消息会话。phase 1 里它和文件传输互斥，靠 textActive 让 busy() 看见它。
  // textLink 和 textSession 互相引用（前者预检后者的策略，后者用前者建连），所以两边都
  // 用 thunk 接：真正调用都发生在两者构造完之后。session 同理，它声明在下面。
  const textLink = createTextLink({
    signaling: () => signaling,
    rtcConfig: () => rtcConfig(),
    // 握手之前就问：能拒就别白跑一次 commit-reveal，也别白占一次 TURN 分配。
    canAccept: (from) => textSession.canAcceptFrom(from),
  });
  const textSession = createTextSession({
    connect: textLink.connect,
    listen: textLink.listen,
    // 互斥的另一半：文件传输在跑的时候不接消息会话，否则屏幕上会同时挂两串 SAS。
    // 这里读的是只算文件那一半的 transferActive，不是 busy()——busy() 本身读 textActive，
    // 拿它来问会绕回自己。
    transferActive: () => session.transferActive || workspace?.blocksLegacyInbound === true,
    now: () => Date.now(),
  });
  let textCompose = $state(""); // 粘贴进来的草稿，交给面板预填
  const session = createTransferSession({
    signaling: () => signaling,
    rtcConfig: () => rtcConfig(),
    t: () => messages[lang()],
    flash,
    textActive: () => textSession.active() || workspace?.blocksLegacyInbound === true,
  });
  const workspace: PeerWorkspace = createPeerWorkspace({
    selfId: () => selfId,
    joined: () => joinedRoom,
    peerIds: () => peers.map((peer) => peer.id),
    unsupported: () => unsupported,
    signaling: () => signaling,
    rtcConfig: () => rtcConfig(),
    legacyFiles: session,
    legacyText: textSession,
    requestNotify: requestNotifyPermission,
  });
  // 模板里读得最多的三个，取个短名字（getter 转发，响应式不丢）。
  const send = $derived(workspace.send);
  const recv = $derived(workspace.recv);
  const incoming = $derived(workspace.incoming);
  const activeText = $derived(workspace.text);

  // Client-local "recent transfers" log (localStorage-backed, this device only).
  // Refreshed after each recorded completion and on clear — never read live from
  // storage during render.
  let history = $state<HistEntry[]>(loadHistory());
  let historyKeep = $state(historyEnabled());
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
  // Tell each peer what this build can do, so we know before ever offering a
  // connection. Same envelope as the relay-RTT broadcast above; peers that do not
  // understand it ignore it, and a peer that never announces is treated as not
  // supporting messages rather than probed for it.
  function broadcastCaps() {
    if (!signaling) return;
    for (const p of peers) if (p.id !== selfId) signaling.sendSignal(p.id, capsSignal());
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
    // A capability hello shares this envelope but is neither of the two things
    // below. The WebRTC handlers ignore it too (it carries no sdp/ice), which is
    // why it needs no generation tag.
    if (recordPeerCaps(from, data)) return;
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

  // The chooser only renders a selector when there is something to choose. One
  // peer needs no radar (effectiveSelected already picked it), zero peers need no
  // blip surface at all — both cases were spending the largest block on the page
  // to say nothing. Rolling this back means rendering <DeviceRadar> unconditionally
  // again; no transfer, protocol or peer-card behaviour depends on it.
  const chooser = $derived<"empty" | "link" | "radar">(
    visiblePeers.length === 0 ? "empty" : visiblePeers.length === 1 ? "link" : "radar",
  );

  // Selecting a blip in the multi-peer radar reveals a card that can sit below the
  // fold on a phone, so bring it into view. Only ever from an explicit blip click —
  // the automatic single-peer selection must never move the page under the user.
  //
  // The scroll is instant rather than smooth. Measured in Chrome 1xx on this page
  // (headless *and* headful): scrollIntoView({block:"nearest", behavior:"smooth"})
  // scrolls by zero, while the identical call with behavior:"auto" scrolls
  // correctly — smooth scrolling itself is fine there (window.scrollTo smooth
  // works), so it is specific to this call. An animation preference must not be
  // able to swallow the reveal entirely, and `block: "nearest"` already moves the
  // minimum distance possible. This also makes the reduced-motion requirement
  // unconditional instead of a branch.
  let peerCardList = $state<HTMLElement | undefined>(undefined);
  async function selectFromRadar(id: string) {
    // The full radar only renders with multiple peers. Re-check at the event
    // boundary for the narrow race where peers disappear after render but before
    // the queued click is handled; automatic one-peer selection never calls here.
    const wasMultiple = visiblePeers.length >= 2;
    selectedPeerId = id;
    if (!wasMultiple) return;
    await tick();
    peerCardList?.scrollIntoView?.({ block: "nearest" });
  }

  const busy = $derived(workspace.warnsOnLeave);
  const dropBusy = $derived(
    visiblePeers.length === 0 || visiblePeers.every((peer) => workspace.blocksNewIntent(peer.id)),
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
    || currentRoute() === "magic-link"
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
    // Upsert public canonical/og:url elements and remove them for private routes;
    // likewise replace or clear the hreflang cluster. Keeping this symmetric is
    // what makes private → public client navigation restore the public head.
    applyHeadMeta(document, meta, location.origin);
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
  // 收到消息也提醒一声，但**只带发送方的名字，永远不带正文**：通知会渲染在锁屏上、
  // 共享的屏幕上、录屏里。边沿检测靠最后一条入站消息的 id，所以每条只提醒一次，而且
  // clearHistory 之后不会重播。
  let lastNotifiedMsgId = 0;
  $effect(() => {
    const last = activeText.history.at(-1);
    if (!last) { lastNotifiedMsgId = 0; return; }
    if (last.dir !== "in" || last.id <= lastNotifiedMsgId) return;
    lastNotifiedMsgId = last.id;
    void notifyTransfer(messages[lang()].text.newMessageFrom(nameOf(activeText.peerId)));
  });
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
      const timer = setTimeout(() => workspace.dismissSend(s), DISMISS_MS);
      return () => clearTimeout(timer);
    }
  });
  $effect(() => {
    const r = recv;
    if (r?.done && r.ok) {
      const timer = setTimeout(() => workspace.dismissRecv(r), DISMISS_MS);
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
    if (outbox().length && surfaceShown && visiblePeers.length === 1
      && !workspace.blocksNewIntent(visiblePeers[0].id)) {
      const peer = visiblePeers[0];
      if (!shouldConfirmBeforeSend(roomCode)) {
        workspace.sendFiles(peer.id, takeOutbox()); // LAN: unchanged frictionless auto-send
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
      workspace.sendFiles(id, takeOutbox());
    }
  }
  function cancelSend() {
    if (pendingPeer) {
      dismissedPeerId = pendingPeer.id; // don't re-prompt this joiner; keep files queued for a different peer
      pendingPeer = null;
    }
  }

  // A newly actionable verification/consent step must not appear silently below
  // the phone viewport. Keep this separate from visual ordering: every activity
  // card is activity-first, but only a fresh decision-bearing edge gets one
  // minimal reveal. Progress and terminal updates never move the page again.
  type ActivityRevealTarget = "pending" | "incoming" | "file" | "text";
  type ActivityReveal = { key: string; target: ActivityRevealTarget; announcement: string };
  let pendingReveal = $state<HTMLElement | undefined>(undefined);
  let incomingReveal = $state<HTMLElement | undefined>(undefined);
  let fileReveal = $state<HTMLElement | undefined>(undefined);
  let textReveal = $state<HTMLElement | undefined>(undefined);
  let activityAnnouncement = $state("");
  let revealedActivity = "";

  function activityReveal(): ActivityReveal | null {
    if (pendingPeer) {
      return {
        key: `pending:${pendingPeer.id}`,
        target: "pending",
        announcement: t.confirmRecv(nameOf(pendingPeer.id)),
      };
    }
    if (incoming && workspace.sasCode) {
      return {
        // Keep the same identity after Accept turns `incoming` into the recv
        // progress card; that state transition must not reveal a second time.
        key: `file:recv:${incoming.from}`,
        target: "incoming",
        announcement: `${t.requestHead(nameOf(incoming.from), incoming.files.length, formatSize(incoming.total))}. ${t.codeLabel} ${workspace.sasCode}. ${t.codeCompare}`,
      };
    }
    const file = [send, recv].find((x) => x && !x.done && workspace.sasCode);
    if (file) {
      return {
        key: `file:${file.dir}:${file.peer}`,
        target: "file",
        announcement: `${statusText(t, file)}. ${t.codeLabel} ${workspace.sasCode}. ${t.codeCompare}`,
      };
    }
    if (
      activeText.sasCode &&
      (activeText.status === "waitingAccept" || activeText.status === "incomingRequest")
    ) {
      const lead = activeText.status === "incomingRequest"
        ? t.text.requestHead(nameOf(activeText.peerId))
        : t.text.waitingAccept;
      return {
        key: `text:${activeText.status}:${activeText.peerId}`,
        target: "text",
        announcement: `${lead}. ${t.codeLabel} ${activeText.sasCode}. ${t.text.sasCompare}`,
      };
    }
    return null;
  }

  function revealElement(target: ActivityRevealTarget): HTMLElement | undefined {
    if (target === "pending") return pendingReveal;
    if (target === "incoming") return incomingReveal;
    if (target === "file") return fileReveal;
    return textReveal;
  }

  $effect(() => {
    const candidate = activityReveal();
    if (!candidate) {
      revealedActivity = "";
      return;
    }
    if (candidate.key === revealedActivity) return;
    revealedActivity = candidate.key;
    activityAnnouncement = "";
    void (async () => {
      await tick();
      const current = activityReveal();
      if (!current || current.key !== candidate.key) return;
      activityAnnouncement = current.announcement;
      await tick();
      // Intentionally instant. Smooth scrollIntoView has measured as a zero-scroll
      // no-op in Chrome on this page, while nearest+auto reveals correctly and
      // satisfies reduced-motion without a preference branch.
      revealElement(current.target)?.scrollIntoView?.({ block: "nearest" });
    })();
  });

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
      workspace.stop();
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
    signaling.onPeers((p) => {
      peers = p;
      retainPeers(p.map((x) => x.id));
      workspace.syncPeers();
      broadcastRelayRtt();
      broadcastCaps();
    });
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
    textSession.listenForRequests();
    workspace.start();
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
    workspace.resetRoom();
    peers = [];
    selfId = "";
    selfIP = "";
    joinedRoom = false;
    linkDead = false;
    relayDenied = "";
    session.reset();
    connState = "connecting";
    resetRelaySelection(); // the new room has its own relay pool + measurements
    resetPeerCaps(); // the new room has its own peers; nothing carries over
    textSession.end(); // 换房间就是换对端，消息会话跟着结束（历史留在页面上）
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
      if (surfaceShown && dropTarget(visiblePeers.length, dropBusy) === "send" && e.dataTransfer) {
        const peer = visiblePeers[0].id;
        filesFromDataTransfer(e.dataTransfer).then((picked) => { if (picked.length) workspace.sendFiles(peer, picked); });
      }
    };
    // 粘贴文本 = 打开草稿框并预填，**不发送**。粘贴不是"同意发出去"，而且粘贴常常是
    // 手误——按下发送这一步必须留给用户。作用域和拖放覆盖层一样窄：只有传输界面真的
    // 在屏幕上、有一个明确的目标对端、那个对端声明过能收消息、而且当前不忙的时候才接手。
    const onPaste = (e: ClipboardEvent) => {
      if (!surfaceShown) return;
      const text = pastedText(e);
      if (text === null) return;
      const peer = effectiveSelected;
      if (!peer || workspace.blocksNewIntent(peer)
        || (!workspace.routes(peer) && !peerSupportsText(peer))) return;
      e.preventDefault();
      textCompose = text;
      void workspace.openText(peer);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onWindowDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onWindowDrop);
      window.removeEventListener("paste", onPaste);
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
  // Turning recording off also wipes what's already there (see setHistoryEnabled),
  // so the panel has to be re-read either way.
  function toggleHistoryKeep(e: Event) {
    historyKeep = (e.currentTarget as HTMLInputElement).checked;
    setHistoryEnabled(historyKeep);
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
    if (input.files?.length) workspace.sendFiles(peerId, pickedFromInput(input.files));
    input.value = ""; // allow re-picking the same files
  }
  function onDrop(e: DragEvent, peerId: string) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove("drag");
    if (!e.dataTransfer) return;
    // Kick off entry extraction now (it captures DataTransfer items synchronously
    // before its first await), then send once the folder tree is flattened.
    filesFromDataTransfer(e.dataTransfer).then((picked) => { if (picked.length) workspace.sendFiles(peerId, picked); });
  }
</script>

<main>
{#snippet peerCard(p: Peer, solo: boolean)}
  {@const intentBlocked = workspace.blocksNewIntent(p.id)}
  <li
    class="peer"
    class:disabled={intentBlocked}
    ondragover={(e) => { e.preventDefault(); if (!intentBlocked) (e.currentTarget as HTMLElement).classList.add("drag"); }}
    ondragleave={(e) => (e.currentTarget as HTMLElement).classList.remove("drag")}
    ondrop={(e) => { e.stopPropagation(); if (intentBlocked) { e.preventDefault(); flash(messages[lang()].busy); return; } onDrop(e, p.id); }}
  >
    <label class="pcard" for={`pick-${p.id}`}>
      <span class="pavatar" class:big={solo}>{p.name.slice(0, 1).toUpperCase()}</span>
      <span class="ptext">
        {#if solo}
          <span class="pname" id={`peer-target-${p.id}`}>{t.pickSendTo(p.name)}</span>
        {:else}
          <span class="pname" id={`peer-target-${p.id}`}>{p.name}</span>
          <span class="pick">{t.pickHint(MAX_FILES)}</span>
        {/if}
      </span>
    </label>
    <!-- 这三个动作共用全局 .btn 原语（其中两个是包着隐藏 file input 的 <label>，
         :disabled 对 label 不生效，所以停用态走 .is-disabled）。以前它们是本组件
         里自成一套的 .act-btn：透明底 + --border 描边，在暗色下边框只有 1.36:1，
         等于看不见。 -->
    <div class="peer-actions">
      <label class="btn btn-secondary btn-sm pa-files" class:is-disabled={intentBlocked}>
        <span class="pa-icon" aria-hidden="true"><Icon name="file" /></span><span class="pa-label" id={`send-file-label-${p.id}`}>{t.sendFile}</span>
        <input class="file-pick-input" id={`pick-${p.id}`} type="file" multiple disabled={intentBlocked}
          aria-labelledby={`send-file-label-${p.id}`}
          aria-describedby={`peer-target-${p.id}`}
          onclick={(e) => { if (outbox().length) { e.preventDefault(); workspace.sendFiles(p.id, takeOutbox()); } }}
          onchange={(e) => pickFile(e, p.id)} />
      </label>
      {#if folderUploadSupported}
        <label class="btn btn-secondary btn-sm" class:is-disabled={intentBlocked}>
          <span class="pa-icon" aria-hidden="true"><Icon name="folder" /></span><span class="pa-label">{t.sendFolder}</span>
          <input class="file-pick-input" type="file" webkitdirectory multiple disabled={intentBlocked} onchange={(e) => pickFile(e, p.id)} />
        </label>
      {/if}
      {#if workspace.routes(p.id) || peerSupportsText(p.id)}
        <button type="button" class="btn btn-secondary btn-sm" disabled={intentBlocked}
          onclick={() => { textCompose = ""; void workspace.openText(p.id); }}>
          <span class="pa-icon" aria-hidden="true"><Icon name="message" /></span><span class="pa-label">{t.text.open}</span>
        </button>
      {/if}
    </div>
  </li>
{/snippet}

{#snippet transferSurface()}
  {@const solo = visiblePeers.length === 1}
  {@const revealFile = [send, recv].find((x) => x && !x.done && workspace.sasCode)}
  {@const hasActivity = !!pendingPeer || !!incoming || !!send || !!recv || activeText.status !== "idle"}
  <!-- This live node exists before an event occurs; mounting a live region and
       its message in the same update is not announced reliably. Protected text
       bodies never enter it. -->
  <div class="activity-announcement" role="status" aria-live="polite" aria-atomic="true">{activityAnnouncement}</div>

  {#if pendingPeer}
    <div class="activity-reveal-marker" bind:this={pendingReveal} aria-hidden="true"></div>
    <div class="ui-callout ui-callout-accent confirm-send">
      <span>{t.confirmRecv(nameOf(pendingPeer.id))}</span>
      <button class="btn btn-primary" onclick={confirmSend}>{t.confirmRecvSend}</button>
      <button class="btn" onclick={cancelSend}>{t.confirmRecvCancel}</button>
    </div>
  {/if}

  {#if incoming}
    <section class="ui-card request">
      <div class="req-head">{t.requestHead(nameOf(incoming.from), incoming.files.length, formatSize(incoming.total))}</div>
      <ul class="filelist">
        {#each incoming.files as f}
          <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
        {/each}
      </ul>
      {#if workspace.sasCode}
        <div class="sas activity-reveal-target" bind:this={incomingReveal}>{t.codeLabel} <code>{workspace.sasCode}</code> — {t.codeCompare}</div>
      {/if}
      <!-- 收/拒按钮住在 ReceiveActions 里，因为大批次的内存提示必须拦在这一下
           点击之前：接受即用户手势，pickSaveTarget 在同一个手势里开选择器。 -->
      <ReceiveActions
        files={incoming.files}
        total={incoming.total}
        onAccept={() => workspace.acceptFile()}
        onReject={() => workspace.rejectFile()}
      />
    </section>
  {/if}

  {#each [send, recv].filter(Boolean) as x (x!.dir)}
    {@const xf = x as Xfer}
    {#if revealFile?.dir === xf.dir}
      <div class="activity-reveal-marker" bind:this={fileReveal} aria-hidden="true"></div>
    {/if}
    <section class="ui-card xfer" class:ok={xf.done && xf.ok} class:bad={xf.done && !xf.ok} out:fade={{ duration: 300 }}>
      <div class="xfer-head">
        <span class="label">{xf.dir === "send" ? t.sendTo(nameOf(xf.peer)) : t.recvFrom(nameOf(xf.peer))}</span>
        {#if xf.files.length}<span class="count">{xf.files.length > 1 ? t.fileCounter(xf.index + 1, xf.files.length) : xf.files[0].name}</span>{/if}
        {#if xf.done}
          <button class="btn btn-sm x" onclick={() => (xf.dir === "send" ? workspace.dismissSend(xf) : workspace.dismissRecv(xf))} aria-label={t.close}>✕</button>
        {:else}
          <button class="btn btn-sm x cancel" onclick={() => workspace.abortFile(xf.dir)}>{t.cancel}</button>
        {/if}
      </div>
      <div class="status" aria-live="polite">
        {statusText(t, xf)}
        {#if workspace.sasCode && !xf.done} · {t.codeLabel} <code>{workspace.sasCode}</code>{/if}
      </div>
      {#if xf.done && !xf.ok && xf.status === "connectFail" && relayDenied === "quota"}
        <p class="ui-callout quota-note">{t.crossnet.relayQuotaFail}</p>
      {/if}
      {#if !xf.done}
        {@const path = xf.dir === "send" ? workspace.sendPath : workspace.recvPath}
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

  <!-- 消息面板放在这个 snippet 里面，所以 LAN 那条路径和 CrossPage 都从这一处拿到它。 -->
  {#if activeText.status !== "idle"}
    <MessagePanel
      status={activeText.status}
      peerName={nameOf(activeText.peerId)}
      sasCode={activeText.sasCode}
      path={workspace.textPath}
      history={activeText.history}
      errorKey={activeText.errorKey}
      prefill={textCompose}
      bind:revealTarget={textReveal}
      onSend={(body) => void workspace.sendText(body)}
      onAccept={() => workspace.acceptText()}
      onReject={() => workspace.rejectText()}
      onClear={() => workspace.clearText()}
      onEnd={() => workspace.endText()}
      onPrefillConsumed={() => (textCompose = "")}
    />
  {/if}

  <section class="peers" class:cross={currentRoute() === "cross"} class:after-activity={hasActivity}>
    <!-- A pairing room currently has one remote target (the signalling room cap
         is two participants). Cross without roomCode is the LAN auto-surface,
         where “Nearby devices” remains truthful for one or many peers. -->
    <h2>{currentRoute() === "cross" && roomCode ? t.crossPeersTitle : t.peersTitle}</h2>
    <QuotaNotice />
    {#if outbox().length && visiblePeers.length !== 1}
      <p class="ui-callout share-pending">{t.sharePending(outbox().length)}</p>
    {/if}
    {#if currentRoute() === "lan"}
      {#if chooser === "empty"}
        <!-- The scanning signal lives inside the empty state rather than above a
             second card repeating the same absence. -->
        <div class="empty">
          <DeviceRadar peers={[]} {selfName} selectedId="" onSelect={selectFromRadar} compact />
          <p class="empty-lead">{t.emptyPeers}</p>
          <button class="btn btn-ghost empty-cta" onclick={() => navigate("cross")}>{t.emptyCrossCta}</button>
        </div>
      {:else if chooser === "link"}
        <PeerLink {selfName} peerName={visiblePeers[0].name} />
      {:else}
        <DeviceRadar
          peers={visiblePeers}
          {selfName}
          selectedId={effectiveSelected}
          onSelect={selectFromRadar}
        />
      {/if}
      {#if selectedPeer}
        <ul bind:this={peerCardList} class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, dropBusy) === "pick"}>
          {@render peerCard(selectedPeer, solo)}
        </ul>
      {/if}
    {:else}
      {#if visiblePeers.length === 0}
        <div class="empty">
          <p class="empty-lead">{t.emptyPeers}</p>
        </div>
      {:else}
        <ul class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, dropBusy) === "pick"}>
          {#each visiblePeers as p (p.id)}
            {@render peerCard(p, solo)}
          {/each}
        </ul>
      {/if}
    {/if}
    <!-- Sits with the message action it describes. Above the chooser it merely
         delayed the primary task; with no peer visible there is no such action,
         so it says nothing actionable at all. -->
    {#if visiblePeers.length > 0}
      <p class="ui-callout text-availability">
        <span class="text-availability-icon" aria-hidden="true"><Icon name="message" /></span>
        <span>{t.text.availabilityHint}</span>
      </p>
    {/if}
  </section>
{/snippet}

  {#if surfaceShown && dragActive && dropTarget(visiblePeers.length, dropBusy) !== "off"}
    <div class="dropzone" transition:fade={{ duration: 140 }}>
      <div class="dropzone-inner">
        {dropTarget(visiblePeers.length, dropBusy) === "send"
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
  {:else if currentRoute() === "magic-link"}
    {#await routePage("magic-link") then { default: MagicLink }}
      <MagicLink />
    {/await}
  {:else}
    {#if notice}
      <div class="toast" role="status" aria-live="polite">{notice}</div>
    {/if}

    <!-- Wide LAN is an identity/task workspace. Keep the whole transferSurface in
         one task column: its chooser, requests, progress and message states are a
         single workflow, and Cross renders the same snippet with different chrome. -->
    <div class="lan-workspace" class:two-col={!unsupported}>
      <Hero {connState} {unsupported} {selfName} {selfIP} onRename={commitName} workspace={!unsupported} />

      <div class="lan-task">
        {#if unsupported}
          <div class="ui-callout ui-callout-danger banner">{t.unsupported}</div>
        {:else}
          {@render transferSurface()}

          <section class="ui-card history">
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
                <button type="button" class="btn btn-ghost btn-sm history-clear" onclick={clearHistoryPanel}>{t.historyClear}</button>
              {:else}
                <p class="history-empty">{t.historyEmpty}</p>
              {/if}
              <label class="history-keep">
                <input type="checkbox" checked={historyKeep} onchange={toggleHistoryKeep} />
                {t.historyKeep}
              </label>
            </details>
          </section>
        {/if}
      </div>
    </div>

  {#if !unsupported}
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
    conn={workspace.conn}
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

  /* The desktop LAN route is an application workspace once there is enough room
     for a proven-wide activity column. Cross also renders transferSurface, so every
     chooser override stays anchored below .lan-workspace to prevent style leakage. */
  @media (min-width: 1180px) {
    .lan-workspace {
      margin-block-start: var(--space-5);
    }
    .lan-workspace.two-col {
      display: grid;
      grid-template-columns: 340px minmax(0, 1fr);
      column-gap: var(--space-7);
      align-items: start;
    }
    .lan-task { min-width: 0; }
    .lan-workspace.two-col .peers { margin-top: 0; }
    .lan-workspace.two-col .empty {
      box-sizing: border-box;
      inline-size: 100%;
      max-inline-size: 640px;
    }
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

  /* Sizing/placement only — the surface comes from .ui-callout.ui-callout-danger.
     It used to be accent-tinted, which made a hard "your browser can't do this"
     failure read like a promo strip. */
  .banner {
    margin-block-start: var(--space-5); padding: var(--space-4);
    border-radius: var(--radius-sm); text-align: center; font-size: var(--fs-sm);
  }

  /* The card surface, and its ok/bad state borders, are the shared .ui-card
     primitive now (app.css). What stays here is App-specific: the one-shot
     success pulse, and the accent treatment for a request that wants an answer. */
  .ui-card { margin-block-end: var(--space-4); }
  .ui-card.ok { animation: card-ok-pop .55s ease-out; }
  @keyframes card-ok-pop {
    0% { box-shadow: 0 0 0 0 rgba(46, 204, 113, .45); }
    100% { box-shadow: 0 0 0 7px rgba(46, 204, 113, 0); }
  }
  .ui-card.request { border-color: var(--accent-border); background: var(--accent-bg); }

  .req-head { font-size: 15px; margin-bottom: 10px; }
  .filelist { list-style: none; margin: 0 0 12px; padding: 0; max-height: 200px; overflow: auto; }
  .filelist li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px dashed var(--border); font-size: 14px; }
  .filelist li:last-child { border-bottom: none; }
  .fname { color: var(--text-h); word-break: break-all; }
  .fsize { color: var(--text); white-space: nowrap; }

  .history summary { cursor: pointer; font-weight: 600; color: var(--text-h); }
  .history .filelist { margin-top: 12px; }
  .history-empty { margin: 12px 0 0; font-size: 13.5px; color: var(--text); }
  .history-clear { margin-block-start: var(--space-1); }
  .history-keep {
    display: flex; align-items: center; gap: 8px;
    margin-block-start: 12px; font-size: 13px; color: var(--text); cursor: pointer;
  }
  .history-keep input { cursor: pointer; }
  /* .sas itself is a shared primitive (app.css) — the verification box looks the
     same here and in the message panel. Only the stacking gap is local. */
  .sas { margin-block-end: 14px; }

  .xfer-head { display: flex; align-items: center; gap: 10px; }
  .xfer-head .label { color: var(--accent); font-size: 14px; font-weight: 500; white-space: nowrap; }
  .xfer-head .count { color: var(--text); font-size: 13px; margin-inline-start: auto; word-break: break-all; text-align: end; }
  /* Close (✕) / Cancel share the .btn primitive; only their position and the
     cancel-specific hover colour are local. */
  .x { margin-inline-start: var(--space-2); flex: none; }
  .x.cancel:hover { color: var(--accent); }
  .status { font-size: 13.5px; color: var(--text); margin-block: 8px 10px; }
  .xfer .quota-note { margin-block: var(--space-2) 0; }
  /* A translucent sheen sweeps across the filled portion so an in-flight transfer
     reads as actively moving, not stalled. The fill only renders while !done. */
  .meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: 12.5px; color: var(--text); }
  .meta-right { display: inline-flex; align-items: center; gap: 12px; }
  /* The connection-path badge (.path / .dot / .path-lan|p2p|relay) is shared with
     MessagePanel and lives in app.css — it used to exist only here, so the panel
     rendered the same markup with no dot at all. */
  @media (prefers-reduced-motion: reduce) {
    .ui-card.ok { animation: none; }
  }

  /* Exclude the old peer control from browser scroll anchoring: when an activity
     card is inserted above it, the explicit one-shot reveal below is the only
     source of scroll movement across Chrome/Firefox/Safari. */
  .peers { margin-top: var(--space-7); overflow-anchor: none; }
  .peers.after-activity { margin-top: var(--space-4); }
  .activity-reveal-marker {
    block-size: 0;
    scroll-margin-block-start: calc(64px + var(--space-3));
    overflow-anchor: none;
  }
  .activity-reveal-target {
    scroll-margin-block-start: calc(64px + var(--space-3));
    overflow-anchor: none;
  }
  .activity-announcement {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  /* 48px of separation is desktop rhythm; on a phone it is a third of the
     distance between the masthead and the send action. */
  @media (max-width: 700px) {
    .peers { margin-top: var(--space-5); }
  }
  /* Cross already lives in a .ui-stack; the homepage's Hero-to-task margin would
     otherwise add another 48px on top of that parent gap. */
  .peers.cross { margin-top: 0; }
  .peers h2 { font-size: 20px; }
  /* Both notices use the shared .ui-callout; the queued-share hint is neutral
     (it is information) and the send confirmation is accent (it wants a
     decision). Only spacing/layout is local. */
  .share-pending { margin-block: 0 12px; }
  .confirm-send {
    margin-block: 0 12px;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .confirm-send span { flex: 1 1 auto; }
  .peers ul {
    list-style: none; padding: 0; margin: 0;
    display: grid; gap: 12px;
    grid-template-columns: minmax(0, 1fr);
    max-inline-size: 560px;
  }
  /* Cross is already constrained by its 720px page card and benefits from using
     the full 672px inner measure; LAN keeps the Batch-3 560px action measure. */
  .peers.cross ul { max-inline-size: none; }
  /* A single connected peer (typical cross-network) reads as one prominent send target. */
  .peers ul.solo .peer { border-style: solid; border-color: var(--accent-border); background: var(--accent-bg); }
  .peers ul.solo .peer .pcard { justify-content: center; padding: 20px; }
  /* --control-border, not --border: the peer card is an interactive drop/pick
     target, so its dashed outline is a control boundary and has to clear 3:1. */
  .peer {
    position: relative;
    border: 1.5px dashed var(--control-border); border-radius: 14px;
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
  /* Files is the stable primary row. Capability-gated secondary actions share a
     row only when both have enough room for the longest localized labels; flex
     naturally fills the row when folder or text is absent. */
  .peer-actions {
    display: flex; flex-wrap: wrap; gap: 8px;
    margin-block: 0 10px; margin-inline: 12px;
  }
  .peer-actions > .btn { flex: 1 1 165px; min-block-size: 36px; }
  .peer-actions > .pa-files { flex-basis: 100%; }
  .peer-actions .btn { gap: 6px; }
  .pa-icon { flex: none; }
  .pa-label { min-inline-size: 0; overflow-wrap: anywhere; }
  /* The scoped desktop floor above is more specific than global .btn, so repeat
     the shared touch contract at the same local specificity. */
  @media (pointer: coarse) {
    .peer-actions > .btn { min-block-size: 44px; }
  }
  .peers ul.solo .peer-actions { max-inline-size: 360px; margin-inline: auto; }

  .empty {
    display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
    text-align: center;
    padding: 28px 20px; border: 1.5px dashed var(--border); border-radius: 14px;
    background: var(--surface-2);
  }
  .empty-lead { margin: 0; color: var(--text); font-size: 14px; max-width: 46ch; }
  .empty-cta { margin-top: var(--space-1); }
  /* Passive availability/privacy information → the neutral shared callout.
     The surface stays neutral because the sentence asks nothing of the user;
     only its small workflow glyph uses the accent. It now trails the peer card
     it describes, so its margin flipped sides. */
  .text-availability {
    display: flex; align-items: flex-start; gap: var(--space-2);
    margin-block: var(--space-3) 0;
  }
  .text-availability-icon { flex: none; color: var(--accent); margin-block-start: 1px; }

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
