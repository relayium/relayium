<script lang="ts">
  import { onMount, tick } from "svelte";
  import { formatSize } from "./lib/format";
  import { fade } from "svelte/transition";
  import { ready } from "./lib/crypto";
  import { SignalingClient } from "./lib/signaling";
  import { lanDeviceId } from "./lib/lan-device-id";
  import { isCurrentPage, watchCurrentPage } from "./lib/current-page";
  import { labelPeers } from "./lib/peer-labels";
  import { wsURL } from "./lib/transfer-link";
  import { roomCode as roomCodeStore, initRoomFromLocation } from "./lib/room.svelte";
  import type { Conn, ConnPath, RtcConfig } from "./lib/webrtc";
  import { applyRename } from "./lib/apply-rename";
  import { capsSignal, recordPeerCaps, retainPeers, resetPeerCaps, peerSupportsText } from "./lib/peer-caps.svelte";
  import { createTextSession } from "./lib/text-session.svelte";
  import { createTextLink } from "./lib/text-link";
  import { pastedText } from "./lib/paste-text";
  import MessagePanel from "./lib/MessagePanel.svelte";
  import ConfirmModal from "./lib/ConfirmModal.svelte";
  import { confirmDialog } from "./lib/confirm-dialog.svelte";
  import Icon from "./lib/Icon.svelte";
  import { createWakeLock } from "./lib/wakelock";
  import { registerServiceWorker, drainSharedFiles } from "./lib/share-target";
  import { requestNotifyPermission, notifyTransfer } from "./lib/notify";
  import { MAX_FILES } from "./lib/transfer";
  import { createTransferSession, type Xfer } from "./lib/transfer-session.svelte";
  import { createPeerWorkspace, type PeerWorkspace } from "./lib/peer-workspace.svelte";
  import { createUnifiedTextOpener } from "./lib/unified-text-open";
  import { createActivityAnnouncer, type ActivityEdge } from "./lib/activity-announcement";
  import { recordTransfer, loadHistory, clearHistory, historyEnabled, setHistoryEnabled, type HistEntry } from "./lib/history";
  import { chooseRtcConfig, fetchIceConfig, measureRelays, pickRelay, type RelayAvailability, type RelayEntry } from "./lib/ice";
  import { relayFailNote } from "./lib/relay-status";
  import { relayDeadline, type RelayDeadline } from "./lib/relay-deadline";
  import type { Peer } from "./lib/protocol";
  import { lang, dir, messages, legalUrl, pageUrl, type Messages, type StatusKey } from "./lib/i18n.svelte";
  import { applyHeadMeta, pageMeta } from "./lib/page-meta";
  import { hasFiles, dropTarget, pickedFromInput, filesFromDataTransfer } from "./lib/drag";
  import { outbox, setOutbox, clearOutbox, uploadedRefs, uploadedFingerprint } from "./lib/outbox.svelte";
  import { resetPreupload } from "./lib/preupload.svelte";
  import { createStoredReceiver } from "./lib/preupload-receive.svelte";
  import { peerSupportsPreupload } from "./lib/peer-caps.svelte";
  // The pre-upload lane decision, and the gate and drain that read it. Not
  // inline here, because the answer has three states and the middle one is a
  // state machine over two signalling frames whose order this component cannot
  // control — see handoff-lane.svelte.ts.
  import {
    drainFor, handoffOwed, liveLinkFor, noteRosterPeers, notePeerCaps,
    pendingCountFor, pendingFilesFor, resetHandoffLanes,
  } from "./lib/handoff-lane.svelte";
  // …and the sender-side stop in front of that handoff. Separate from the lane
  // on purpose: the lane answers "which transport owes this peer these entries",
  // which is a protocol question, and this answers "may they leave yet", which
  // is the user's. See handoff-authorization.svelte.ts.
  import {
    authorizeHandoff, handoffAllowed, revokeHandoff, type HandoffContext,
  } from "./lib/handoff-authorization.svelte";
  import StoredIncoming from "./lib/StoredIncoming.svelte";
  import { needsSendConfirmation, shownSasCode, autoAcceptsIncomingText } from "./lib/verify-gates";
  import { canReleaseConfirmedSend, queuedReleaseTarget } from "./lib/confirm-send";
  import { verifyPeers, setVerifyPeers } from "./lib/verify-pref.svelte";
  import { folderUploadSupported } from "./lib/platform";
  import { reveal } from "./lib/reveal";
  import Nav from "./lib/Nav.svelte";
  import { currentRoute, syncRouteFromLocation, downloadId, navigate, setNavGuard, PRICING_PATH } from "./lib/router.svelte";
  import { showsTransferSurface, showsPeerRoster } from "./lib/transfer-surface";
  import Hero from "./lib/Hero.svelte";
  import DeviceRadar from "./lib/DeviceRadar.svelte";
  import PeerLink from "./lib/PeerLink.svelte";
  import LanPathRail from "./lib/LanPathRail.svelte";
  import QuotaNotice from "./lib/QuotaNotice.svelte";
  import ReceiveActions from "./lib/ReceiveActions.svelte";
  import WorkspaceHeader from "./lib/WorkspaceHeader.svelte";
  import QueuedBatches from "./lib/QueuedBatches.svelte";
  import PendingFiles from "./lib/PendingFiles.svelte";
  import DebugPanel from "./lib/DebugPanel.svelte";
  import UpdateNotice from "./lib/UpdateNotice.svelte";

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
    "device-inbox": () => import("./lib/DeviceInboxPage.svelte"),
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
    // The room refused or expired this page's membership. In a code room that is
    // exactly `linkDead` — a close before we ever joined — and it means no
    // rebuild offer will ever be delivered, so a link that drops afterwards is
    // terminal rather than recoverable.
    rejoinRefused: () => linkDead,
    relayDeadline: () => relayBound,
    peerIds: () => peers.map((peer) => peer.id),
    unsupported: () => unsupported,
    signaling: () => signaling,
    rtcConfig: () => rtcConfig(),
    legacyFiles: session,
    legacyText: textSession,
    requestNotify: requestNotifyPermission,
    // Pre-upload key handoff (frame kind 12). A PULL of the CURRENT set, asked
    // again on every (re)established transport — which is exactly the protocol's
    // retry rule, expressed as "there is no remembered partial state to be
    // wrong about".
    //
    // Room-guarded, because the pull happens LATE: it runs inside the send
    // chain, at seal time, which can be well after the frame was scheduled. A
    // stored object belongs to the room it was uploaded into, so a set pulled
    // while this page is between rooms could name objects the link's peer can
    // only 404 on. The room boundary already empties the set — the sender's own
    // `resetPreupload`/`startPreupload` on a re-mint, this effect's on the way
    // out; this covers the window around it, when `roomCode` has changed and the
    // socket is still bound to the room being left.
    //
    // And AUTHORIZATION-guarded, which is the sender-side stop itself. In a code
    // room with advanced verification on the batch waits for an explicit Send,
    // because the joiner might be someone who guessed a live code — but the
    // handoff does not travel in that batch. It rides the link, and a link
    // exists the moment the workspace is opened, which is the only way the code
    // the user is told to compare gets on screen. So without this the keys are
    // handed over one link BEFORE the person is asked anything, and there is no
    // second stop behind it: the receiver's accept step gates bytes landing on a
    // disk, and these bytes are already on a server that serves them to whoever
    // holds the key. `keysReleasedTo` is the answer, asked here — late, at the
    // wire — rather than remembered by whoever scheduled the frame.
    storedKeysToSend: (peerId) => (
      roomCode && roomCode === socketRoomKey && keysReleasedTo(peerId) ? uploadedRefs() : []
    ),
    onStoredKeys: (items) => storedReceiver.offer(items),
    supportsPreupload: peerSupportsPreupload,
  });
  /** Files a peer pre-uploaded and then handed us the keys to. Its own surface
   *  and its own accept step; see preupload-receive.svelte.ts. */
  const storedReceiver = createStoredReceiver();
  // 模板里读得最多的三个，取个短名字（getter 转发，响应式不丢）。
  const send = $derived(workspace.send);
  const recv = $derived(workspace.recv);
  const incoming = $derived(workspace.incoming);
  /** The workspace router's own answer, which deliberately RETAINS a non-idle
   *  legacy transcript so it stays rendered while a mixed lane is idle.
   *
   *  That retention is the whole point of it, and it is why this is now used for
   *  exactly one question: "is there still legacy text history to render?" Every
   *  product side effect — auto-accept, the reveal/announcement, the new-message
   *  notification — reads `surfaceText` instead, because they must act on the
   *  session that is actually on screen rather than on a preserved one. */
  const activeText = $derived(workspace.text);
  /** The text session the workspace SURFACE renders and acts on.
   *
   *  Deliberately not `workspace.text`. That getter keeps a non-idle LEGACY
   *  transcript on screen while the mixed lane is idle, which is correct for the
   *  legacy card and its history — and wrong the moment a link owns the screen.
   *  A `link/1` workspace is usually established by the FILE lane, so its text
   *  lane is idle for a while; reading the legacy session during that window put
   *  an EARLIER peer's conversation on screen under the LINKED peer's name, and
   *  told the auto-opener the lane was already busy so the real one never opened.
   *  Inside a mixed workspace the link's own lane is the only identity; outside
   *  one nothing changes. */
  const surfaceText = $derived(workspace.usingMixed ? workspace.mixed.text : workspace.text);
  // Panel actions land on the session the panel is showing, for the same reason
  // its props read it: inside a mixed workspace that is the link's own lane, and
  // outside one the workspace router decides exactly as before — it owns the
  // legacy/mixed lane bookkeeping and is left untouched.
  function sendSurfaceText(body: string) {
    if (workspace.usingMixed) void workspace.mixed.text.send(body);
    else void workspace.sendText(body);
  }
  function acceptSurfaceText() {
    if (workspace.usingMixed) workspace.mixed.text.accept();
    else workspace.acceptText();
  }
  function rejectSurfaceText() {
    if (workspace.usingMixed) workspace.mixed.text.reject();
    else workspace.rejectText();
  }
  function clearSurfaceText() {
    if (workspace.usingMixed) workspace.mixed.text.clearHistory();
    else workspace.clearText();
  }
  function endSurfaceText() {
    if (workspace.usingMixed) workspace.mixed.text.end();
    else workspace.endText();
  }
  // 「高级验证」偏好，默认关。关的时候 SAS 不上屏，围绕比对它建立的额外确认步骤
  // 也一并省掉；开的时候完全恢复原来的行为。理由与边界写在 verify-pref 里——
  // 尤其是：这个开关**不**影响 commit-reveal / AEAD，也不影响接收文件的保存同意。
  const verifyOn = $derived(verifyPeers());
  /** 这条链路的 SAS，只有在偏好打开时才是可显示的。模板一律读这个而不是
   *  workspace.sasCode，避免某一处漏掉判断又把码渲染出来。 */
  const shownSas = $derived(shownSasCode(verifyOn, workspace.sasCode));

  /** Whether the unified panel's attachment controls are usable right now.
   *
   *  It asks the live workspace policy about the LINKED peer and nothing else.
   *  Deliberately not derived from the conversation: "is this conversation
   *  open?" and "can this link take another file?" are different questions, and
   *  answering the second with the first is what greyed the picker out during a
   *  live conversation. Picking during a transfer queues (see queuedBatches)
   *  rather than disabling, so this stays true through file work too; a torn-down
   *  or stale workspace has no linked peer and turns it off. */
  const unifiedAttachments = $derived(
    workspace.usingMixed && workspace.linkPeerId !== ""
      && !workspace.blocksNewIntent(workspace.linkPeerId),
  );

  /** How many links this page has torn down.
   *
   *  It exists to remount the unified MessagePanel, which keeps its draft in
   *  component state and stays mounted across a teardown (the transcript is
   *  still on screen). Without a remount, text typed for one peer would reappear
   *  in the composer of the NEXT authenticated link.
   *
   *  Counted on teardown and deliberately NEVER on establishment. The unified
   *  composer is on screen from "connecting…" onward precisely so that what
   *  someone types while the link comes up is not lost — and establishment is
   *  exactly when `linkGeneration` advances, so keying on that identity would
   *  delete what the composer exists to keep. An authenticated transport
   *  replacement holds the link, so it is not a teardown either. */
  let linkEpoch = $state(0);
  let hadLink = false;
  $effect(() => {
    const has = workspace.hasLink;
    if (hadLink && !has) linkEpoch++;
    hadLink = has;
  });

  // ── the unified workspace's one automatic step ───────────────────────────────
  // A mixed link is usually established by the FILE lane (files picked, dropped,
  // or handed over by the OS share sheet), which leaves the workspace promising a
  // composer that no one has opened. Open the text lane once per authenticated
  // link so the promise holds.
  //
  // "Once" is the safety property, not a nicety: every extra open raises another
  // consent prompt on the peer. The rule itself lives in unified-text-open.ts
  // where its lifecycle cases are directly testable; what stays here is only the
  // wiring. This effect deliberately writes NO state after the call and never
  // awaits it, so a resolution landing after Disconnect or a room switch is left
  // entirely to the lane's own attempt/generation guards — which is where it is
  // tested (peer-workspace.test.ts, mixed-text-session.test.ts).
  const textOpener = createUnifiedTextOpener();
  $effect(() => {
    const peerId = workspace.linkPeerId;
    const generation = workspace.linkGeneration;
    if (!peerId) return;
    if (!textOpener.shouldOpen({
      hasLink: workspace.hasLink,
      linkGeneration: generation,
      // The LINK's own lane, never the legacy-preserving workspace getter: that
      // one still resolves to a retained legacy transcript while this lane is
      // idle, and a stale "ended" read from it would permanently suppress the
      // single open this workspace promises. See surfaceText.
      textIdle: workspace.mixed.text.status === "idle",
    })) return;
    // Spend the generation BEFORE starting the open: openText is async, and a
    // synchronous re-evaluation between here and its first status write must not
    // be able to start a second one.
    textOpener.markOpened(generation);
    void workspace.openText(peerId);
  });

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
  // Why a relay is (not) available for this room — see RelayAvailability. Every
  // non-"ok" value used to be invisible: the UI only ever recognised "quota",
  // so a withheld or unreachable relay surfaced as a bare "connection failed".
  let relayStatus = $state<RelayAvailability>("ok");

  // Non-reactive locals
  let signaling: SignalingClient;
  // This installation's opaque LAN presence id (see lan-device-id.ts). Read once
  // at mount; "" when storage is unavailable, which simply means this browser
  // joins the way a client without the field does.
  let lanDevice = "";
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
  // The credential boundary for a RELAYED unified link in this room, derived
  // once from the ICE config the moment it was fetched, and null whenever
  // nothing in that config relays (every LAN room, and a code room the server
  // issued no TURN username for). Derived here rather than inside the session
  // because `Date.now()` at FETCH time is what makes the skew correction a
  // duration on this clock — see relay-deadline.ts.
  let relayBound = $state<RelayDeadline | null>(null);
  let myRelayRtt = $state<Record<string, number>>({});
  let peerRelayRtt = $state<Record<string, number>>({});
  let selectedRelayId = $state<string | null>(null);
  // Build the RTCConfiguration for a new connection: prefer the relay the two
  // peers agreed is fastest, otherwise use every relay we were handed, and keep
  // "all" only when there is genuinely no relay (LAN). The reasoning — why
  // cross-network forces relay-only, and why a missing measurement must not
  // throw the pool away — is on chooseRtcConfig.
  //
  // It lives in ice.ts so it is unit-testable. In here it had no coverage at
  // all, and the case it got wrong (no relay selected yet on a pool-only
  // deployment) is exactly the one that stranded cross-network peers.
  const rtcConfig = (): RtcConfig => chooseRtcConfig({ iceServers, relays: relayPool }, selectedRelayId);

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
    // A hello also SETTLES this peer's pre-upload lane, and it is recorded here
    // rather than read later because the roster prunes announcements: a peer
    // whose socket drops while its DataChannel keeps working must not read back
    // as "never announced" and lose its handoff.
    if (recordPeerCaps(from, data)) { notePeerCaps(from); return; }
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
  // Same-installation pages are already collapsed into one entry by the hub, so
  // anything still sharing a name here is a genuinely different device and gets
  // a short id suffix — the same disambiguation the native chooser does. Only
  // the shown name changes; every action below still binds to the full peer id.
  const visiblePeers = $derived(labelPeers(peers.filter((p) => p.id !== selfId)));
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

  /**
   * "A reload, a navigation or a version swap right now destroys work in flight."
   *
   * The stored-receive lane is part of this and is easy to leave out, because it
   * is the one transfer that does not look like one from the workspace's side:
   * no peer, no link, no `send`/`recv`. What it does have is a manifest fetch, a
   * consent prompt the user has not answered yet, and a download writing to a
   * save target — all of which a refresh, a Back, or the update banner reloading
   * the page would end mid-file, with the ciphertext's only keys held in this
   * tab's memory and nothing on the server that could hand them over again.
   */
  const busy = $derived(workspace.warnsOnLeave || storedReceiver.active());
  const dropBusy = $derived(
    visiblePeers.length === 0 || visiblePeers.every((peer) => workspace.blocksNewIntent(peer.id)),
  );
  // `storedReceiver` is part of this test because a pre-uploaded batch does not
  // need the peer any more: the ciphertext is on the server and the keys are
  // already here. Without it, a sender whose signalling socket dropped after the
  // handoff would empty the roster and take the unanswered prompt — and the
  // downloads behind it — off the screen, for a transfer that could still have
  // completed on its own.
  //
  // The route term is the sibling-product boundary and lives in
  // `transfer-surface.ts` with the reasoning: /cross-network draws this surface
  // for its pairing room and for nothing else, so a LAN neighbour appearing on
  // this Wi-Fi can never put a device card, a name or a same-network prompt on
  // the destination whose premise is that no shared network exists.
  const showTransfer = $derived(showsTransferSurface({
    route: currentRoute(),
    roomCode,
    busy,
    storedReceiveActive: storedReceiver.status !== "idle",
    visiblePeers: visiblePeers.length,
  }));

  // The window-wide drop only makes sense where the device cards are actually
  // rendered: the LAN page (unless unsupported), or the cross page once a
  // realtime peer is connected. Never on the download page.
  const surfaceShown = $derived(
    currentRoute() === "download" || currentRoute() === "offline" || currentRoute() === "me" || currentRoute() === "cli"
    || currentRoute() === "apps" || currentRoute() === "device-inbox"
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
  // 读的是 surfaceText，和面板同一个会话：通知报的是**谁**发来的消息，而这个"谁"必须
  // 是屏幕上那条对话的对端。统一工作区里那是这条链路自己的通道；`workspace.text` 在这
  // 条通道还空着的时候会保留旧的 legacy 记录，拿它报名字就会用上一个对端的名字去通知
  // 一条根本不在屏幕上的对话。
  let lastNotifiedMsgId = 0;
  $effect(() => {
    const last = surfaceText.history.at(-1);
    if (!last) { lastNotifiedMsgId = 0; return; }
    if (last.dir !== "in" || last.id <= lastNotifiedMsgId) return;
    lastNotifiedMsgId = last.id;
    void notifyTransfer(messages[lang()].text.newMessageFrom(nameOf(surfaceText.peerId)));
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
    // The stored lane counts for the same reason it counts as `busy`: a phone
    // that locks its screen while a pre-uploaded batch is downloading is a
    // suspended tab, and this transfer cannot be resumed from the other side —
    // the keys only exist here.
    const active = (send && !send.done) || (recv && !recv.done) || storedReceiver.active();
    if (active) wake.acquire();
    else wake.release();
  });

  // `liveLinkFor` (the gate in front of every drain) and `drainFor` (the drain
  // itself, plus the one-way release behind it) are imported rather than written
  // here. Both used to read `peerSupportsPreupload` directly, and both were wrong
  // in the same way: that predicate answers "has not announced yet" as "cannot
  // take keys", and the roster frame that first names a peer ALWAYS arrives
  // before that peer's capability hello — so a batch that finished uploading
  // before anyone joined was released back to the live lane and re-sent, for a
  // peer perfectly able to be handed its keys. The three-state answer, why the
  // wait is bounded, and what an old peer still gets are all in
  // handoff-lane.svelte.ts.

  /**
   * The world an emission of the stored key set would happen in, right now.
   *
   * Every field is something a person could have checked, or something whose
   * change means they checked a different thing — so an authorization recorded
   * against one of these simply stops matching when any of them moves, and the
   * gate fails closed without anybody having to remember to revoke it. That is
   * deliberate: the emission does not go through the confirmation button, and an
   * inbound link the peer builds itself goes through no button at all, so
   * hiding a control cannot be the mechanism.
   *
   * `linkGeneration` is the identity of a LIVE link to THIS peer, or -1. Not
   * `linkPeerId` alone, which still names the peer of a link that has ENDED
   * (whose code is no longer on screen), and not another peer's link either: the
   * six digits the user compared belong to one authentication step with one
   * peer.
   */
  function handoffCtx(peerId: string): HandoffContext {
    return {
      peerId,
      roomCode: roomCode ?? "",
      linkGeneration: workspace.hasLink && workspace.linkPeerId === peerId
        ? workspace.linkGeneration : -1,
      verifyOn,
    };
  }
  /** Whether this peer's pre-uploaded keys may leave this device right now. One
   *  question, read by the pull that seals the frame, by the send gate that
   *  decides there is still something to do, and by the release control that
   *  describes what is left — so none of the three can mean a different thing by
   *  "already handed over". */
  function keysReleasedTo(peerId: string): boolean {
    return handoffAllowed(handoffCtx(peerId));
  }

  // Queued files (OS share sheet, or picked before pairing) auto-send the
  // moment there's exactly one reachable device and nothing else in flight;
  // with several devices the user picks one (the peer cards become targets).
  let pendingPeer = $state<Peer | null>(null);
  let dismissedPeerId = $state<string | null>(null);

  $effect(() => {
    // `liveLinkFor(peer)`, never `outbox().length` and never the peer-independent
    // `stagedCount()`. Three different bugs live in those differences, and all
    // three only exist once pre-upload can leave entries behind:
    //
    //  1. A queue whose only entry is still UPLOADING is not empty, but it has
    //     nothing for the live link. `outbox().length` passed, `takeOutbox()`
    //     returned [], and the peer was offered a batch with no files in it.
    //  2. `failUpload` (the room expired, the upload broke) moves an entry back
    //     to `staged` by rewriting the STATE array only — `files` is untouched.
    //     A reader that tracks `outbox()` alone therefore never re-runs, and the
    //     released file goes over neither transport. Reading the per-entry state
    //     is what makes this effect fire on exactly that transition.
    //  3. A batch that finished uploading before anyone joined has a
    //     `stagedCount()` of 0, so a gate on that number never opened and
    //     `drainFor`'s old-peer fallback — the only thing that can deliver those
    //     entries to a peer with no `preupload/1` — was never reached at all.
    //  4. And the answer that fallback turns on is not available yet when this
    //     effect first runs. The roster change that put `solo` here is the same
    //     handler that broadcasts OUR capabilities; the peer's own hello is a
    //     round trip behind it. So `liveLinkFor` holds a batch with uploaded
    //     entries in it until that peer's lane is settled, rather than reading
    //     silence as "cannot take keys" and spending the handoff on a peer that
    //     was about to say otherwise — handoff-lane.svelte.ts.
    //  5. And a fully pre-uploaded batch owes the live lane NOTHING — correctly,
    //     because the keys are the whole transfer — which is the ordinary shape
    //     of a code room: stage, mint, finalize, wait. A sender driven only by
    //     the live-lane count therefore does nothing at all with the ordinary
    //     case: no link is built, no frame kind 12 is emitted, and a batch whose
    //     ciphertext is already paid for arrives as silence. That debt is
    //     `handoffOwed`, and it is settled by a frame rather than by a batch, so
    //     no count the live lane keeps can see it.
    const solo = visiblePeers.length === 1 ? visiblePeers[0] : null;
    const liveOwed = solo ? liveLinkFor(solo.id) : 0;
    // Owed AND not yet handed over: either no link to this peer exists to carry
    // the frame, or one does and the keys are not authorized to leave it yet.
    // Both are things to act on. Neither survives the handoff actually
    // happening, which is what keeps the confirmation bar from coming straight
    // back one flush after the user answered it.
    const keysPending = solo !== null && handoffOwed(solo.id) > 0
      && !(workspace.hasLink && workspace.linkPeerId === solo.id && keysReleasedTo(solo.id));
    if (solo && (liveOwed > 0 || keysPending) && surfaceShown
      && !workspace.blocksNewIntent(solo.id)) {
      const peer = solo;
      // The extra sender confirmation belongs to advanced verification: its only
      // stated reason was "the joiner might be a code-guesser, so look at the SAS
      // before you send". With the preference off there is no SAS on screen to
      // look at, so the bar would be a prompt with nothing behind it. LAN was
      // always frictionless; a code room now matches it unless the user opted in.
      //
      // The exposure this accepts, stated plainly: someone who guesses a live
      // code and joins first can be the peer this offer goes to. What stops it
      // becoming a received file is the recipient's own accept step, which no
      // mode skips (autoAcceptsIncomingFile). Turning verification on restores
      // the sender-side confirmation as well.
      if (!needsSendConfirmation(verifyOn, roomCode)) {
        const files = drainFor(peer.id);
        // Only when there ARE some. An all-keys batch drains to nothing, and
        // calling through with it seals a manifest with no files in it and
        // raises a consent prompt on the peer for a transfer that does not
        // exist. What that batch needs is a link for its frame to travel on,
        // asked for as its own intent — never by opening a conversation nobody
        // asked for, and never by an empty batch. The keys themselves ride the
        // pull that follows attachment; with no confirmation in force that pull
        // already answers yes.
        if (files.length) workspace.sendFiles(peer.id, files);
        else workspace.prepareHandoff(peer.id);
        return;
      }
      // Code room, verification on: surface a confirmation bar instead of
      // auto-sending, so a code-guesser who joined never receives the files
      // automatically.
      if (!pendingPeer && peer.id !== dismissedPeerId) pendingPeer = peer;
      // The link is still built — and ONLY the link. The whole remedy this bar
      // offers is "compare the verification code before you send", and that code
      // does not exist until a link does; unlike a staged batch, an all-keys one
      // has no live-lane send that would ever build one, so the bar would sit
      // there telling the user to compare something they cannot see. Nothing is
      // drained and no authorization is recorded here, so the pull behind the
      // attachment still answers no.
      if (keysPending) workspace.prepareHandoff(peer.id);
    } else if (!pendingPeer || pendingPeer.id !== releaseTarget) {
      // The peer left, or the conditions changed — EXCEPT in the one state where
      // an empty roster does not mean the peer left: a bar armed for the peer of
      // a LIVE link whose signalling went away underneath a DataChannel that is
      // still carrying files. `releaseTarget` is what put that bar on screen, so
      // clearing it here would take it away again one tick after the user asked
      // for it, and leave the queue with no control that could reach it.
      pendingPeer = null;
    }
  });

  /**
   * Re-hand the peer the pre-uploaded set whenever that set changes.
   *
   * `attach()` already sends it on every (re)established transport, which covers
   * the ordinary case where everything was uploaded before anyone joined. This
   * covers the one that is not ordinary and is easy to lose: an upload that was
   * still IN FLIGHT when the peer joined is allowed to finish (the protocol
   * refuses only a new init), so a new object appears on an already-open link
   * minutes after the first handoff. Without this the receiver is never told
   * about it — and no clock ends it: the peer has joined, so the room has no
   * deadline and no fallback expiry, and an object no completion names is held
   * until its owner releases the room or the account is deleted.
   *
   * Re-sending the whole set rather than the delta is the protocol's own rule,
   * and it is why over-sending here is CHEAP — the receiver dedupes by id, so a
   * spurious re-send costs one frame and changes nothing. It is not free, and
   * that is what `uploadedFingerprint` is for: a `$derived` over `uploadedRefs()`
   * would allocate a new array on every unrelated state transition (a file
   * picked, an upload started, an entry removed), never compare equal, and
   * re-emit the whole set each time — O(N) frames per upload, O(N²) over an
   * N-file batch, every one of them a seal and a send. A string of the ids
   * settles, so the re-send happens once per genuinely new object.
   */
  const uploadedIds = $derived(uploadedFingerprint());
  $effect(() => {
    if (!uploadedIds || !workspace.hasLink) return;
    workspace.sendStoredKeys();
  });

  /**
   * The peer the workspace's standing release control acts on, or "".
   *
   * Read by the control's `{#if}` and by `releaseQueued` alike — see
   * queuedReleaseTarget, which exists so those two cannot disagree. Resolved
   * from the LINK, never from the roster: a peer whose signalling socket
   * dropped is gone from the roster while its DataChannel is still open, and
   * that is precisely when a user has queued files and a working link to send
   * them over.
   */
  const releaseTarget = $derived.by(() => {
    const peerId = workspace.hasLink ? workspace.linkPeerId : "";
    return queuedReleaseTarget({
      linkPeerId: peerId,
      // Everything this peer is still waiting on, whichever transport will
      // carry it. Not `outbox().length`: an entry still uploading is nobody's
      // to release. Not the peer-independent staged count either. And wider
      // than the live lane's own question, because the Send this control
      // re-arms hands over the keys as well: measured with the live lane's
      // ruler a fully pre-uploaded batch counts 0, renders no control at all,
      // and — after a Cancel, inside a workspace where the peer chooser is
      // gone — leaves those files with nothing on screen that can reach them.
      queued: peerId === "" ? 0 : pendingCountFor(peerId, keysReleasedTo(peerId)),
      // The same live policy every other outbound control reads, so the button
      // is never offered for a link that would refuse the batch anyway.
      blocked: peerId !== "" && workspace.blocksNewIntent(peerId),
    });
  });

  /**
   * Whether the confirmation bar's Send may release the batch right now.
   *
   * The bar can be armed before any link exists — a preselected batch (OS share
   * sheet, or files picked before the code was minted) arms it the instant the
   * one peer joins — and for a unified target the verification code it tells the
   * user to compare only exists once the workspace is open. Read both by the
   * handler and by the template, so the button cannot say one thing while the
   * handler does another.
   */
  const canRelease = $derived.by(() => {
    const target = pendingPeer;
    if (!target) return false;
    return canReleaseConfirmedSend({
      confirmed: needsSendConfirmation(verifyOn, roomCode),
      unified: workspace.routes(target.id),
      targetPeerId: target.id,
      // A LIVE link, never `linkPeerId` alone: that one still names the peer of a
      // link that has ended, and an ended link's code is not on screen.
      linkPeerId: workspace.hasLink ? workspace.linkPeerId : "",
      shownSas,
    });
  });

  function confirmSend() {
    // Fails closed, and not merely because the button is hidden: this is the one
    // step between a queued batch and a peer who may have guessed the code, so
    // it must not depend on a template branch to be correct.
    if (!pendingPeer || !canRelease) return;
    const id = pendingPeer.id;
    pendingPeer = null;
    // The authorization FIRST, and for exactly this world: this peer, this room,
    // this link, this preference. It is what the handoff pull answers to, and
    // that pull happens late — inside the send chain, at seal time — so anything
    // recorded after the release below would be a race with the frame it is
    // supposed to authorize.
    authorizeHandoff(handoffCtx(id));
    const files = drainFor(id);
    // Only when the live lane owes something: a batch that is all keys drains to
    // nothing, and sending that is an empty manifest and a consent prompt for a
    // transfer that does not exist.
    if (files.length) workspace.sendFiles(id, files);
    // And the keys, once, on the link whose code the user just compared.
    // `attach()` already asked for them — before this authorization existed —
    // and was told no, so nothing has carried them yet.
    if (handoffOwed(id)) workspace.sendStoredKeys();
  }
  function cancelSend() {
    if (pendingPeer) {
      dismissedPeerId = pendingPeer.id; // don't re-prompt this joiner; keep files queued for a different peer
      pendingPeer = null;
    }
  }

  // With advanced verification off, an incoming TEXT request opens straight into
  // the composer. The accept/reject pair existed to hold the session shut until
  // the SAS had been compared; with no SAS shown, it degrades into "a stranger
  // wants to talk to you — [Accept]", which nobody can answer more safely than
  // the composer itself can. Nothing is decrypted early by this: accept() is
  // exactly the step the session already required, and it is what installs the
  // message listener.
  //
  // Deliberately NOT extended to an incoming FILE request. That prompt is about
  // what lands on disk (and carries the user gesture the save-target picker
  // needs), so it stays in every mode — see ReceiveActions.
  //
  // Both halves read the surface, never `workspace.text`: an automatic accept is
  // only defensible for the conversation the user is actually looking at. Inside
  // a mixed workspace the retained legacy session is neither on screen nor
  // reachable, so letting it decide here would silently accept a stranger's
  // request the user was never shown — and `acceptSurfaceText` is what lands the
  // accept on that same session instead of routing it back to the legacy lane.
  $effect(() => {
    if (autoAcceptsIncomingText(verifyOn, surfaceText.status)) acceptSurfaceText();
  });

  // A newly actionable verification/consent step must not appear silently below
  // the phone viewport. Keep this separate from visual ordering: every activity
  // card is activity-first, but only a fresh decision-bearing edge gets one
  // minimal reveal. Progress and terminal updates never move the page again.
  type ActivityRevealTarget = "pending" | "incoming" | "file" | "text";
  // `lead` is the edge itself; the verification code is kept apart from it so a
  // unified workspace can decide whether this edge still needs to say the code.
  // A legacy surface always appends it, exactly as before.
  type ActivityReveal = ActivityEdge & {
    key: string;
    target: ActivityRevealTarget;
  };
  let pendingReveal = $state<HTMLElement | undefined>(undefined);
  let incomingReveal = $state<HTMLElement | undefined>(undefined);
  let fileReveal = $state<HTMLElement | undefined>(undefined);
  let textReveal = $state<HTMLElement | undefined>(undefined);
  let activityAnnouncement = $state("");
  let revealedActivity = "";
  /** Which edge currently owns the live region.
   *
   *  Bumped where the region is cleared for a new edge, so the announcement that
   *  is still in flight for the previous one can tell that it was superseded
   *  before it ever rendered — the exact condition under which its sentence must
   *  NOT count as having been said. See Announcement.confirm. */
  let announcementTurn = 0;
  // The pinned trust header, kept so a reveal can measure it at the instant it
  // scrolls. Every cheaper option was measured and found wrong on a real tab: a
  // hardcoded reserve assumed 196px against a real 274px, and a ResizeObserver
  // binding still reported 54px — the header before the SAS row arrives — while
  // the reveal was already scrolling, leaving the consent card 121px behind it.
  let headEl = $state<HTMLElement | undefined>(undefined);
  // One link is one authentication step, so a unified workspace reads its code
  // out once and then leaves it visible in the persistent header instead of
  // repeating it for the file lane and again for text. The rule — and the fact
  // that its memory is scoped to *this* link, not to six digits that a later
  // link could repeat — lives in activity-announcement.ts, where it is tested.
  const announcer = createActivityAnnouncer();

  function activityReveal(): ActivityReveal | null {
    if (pendingPeer) {
      return {
        key: `pending:${pendingPeer.id}`,
        target: "pending",
        lead: t.confirmRecv(nameOf(pendingPeer.id)),
      };
    }
    if (incoming && workspace.sasCode) {
      return {
        // Keep the same identity after Accept turns `incoming` into the recv
        // progress card; that state transition must not reveal a second time.
        key: `file:recv:${incoming.from}`,
        target: "incoming",
        lead: t.requestHead(nameOf(incoming.from), incoming.files.length, formatSize(incoming.total)),
        // Undefined rather than "" so the announcer takes its no-code path and
        // reads the edge alone, instead of "…. Code . compare it with…".
        sas: shownSas || undefined,
        sasCompare: t.codeCompare,
      };
    }
    const file = [send, recv].find((x) => x && !x.done && workspace.sasCode);
    if (file) {
      return {
        key: `file:${file.dir}:${file.peer}`,
        target: "file",
        lead: statusText(t, file),
        sas: shownSas || undefined,
        sasCompare: t.codeCompare,
      };
    }
    // The surface, never `workspace.text`: this edge is a reveal, a spoken
    // identity and a verification code, and all three have to describe the
    // conversation the panel is showing. A retained legacy transcript read here
    // while a link owns the screen scrolls to a card that is not on it, names
    // the wrong peer, and — worst — reads out the LEGACY session's code under
    // the linked peer's name, which is a verification step pointed at the wrong
    // connection.
    if (
      surfaceText.sasCode &&
      (surfaceText.status === "waitingAccept" || surfaceText.status === "incomingRequest")
    ) {
      const lead = surfaceText.status === "incomingRequest"
        ? t.text.requestHead(nameOf(surfaceText.peerId))
        : t.text.waitingAccept;
      return {
        key: `text:${surfaceText.status}:${surfaceText.peerId}`,
        target: "text",
        lead,
        sas: verifyOn ? surfaceText.sasCode : undefined,
        sasCompare: t.text.sasCompare,
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
      // Load-bearing for more than tidiness: the reveal key is peer+lane and
      // carries no link generation, so a second link to the same peer computes
      // the SAME key. This reset is what stops the guard below from swallowing
      // that new link's authentication edge. It is reachable on every relink
      // because a link cannot be replaced in place — peer-link's establish()
      // refuses while one is current — and with no link there is no SAS, so no
      // sas-bearing candidate survives the gap. e2e/mixed-link.mjs drives that
      // exact sequence with a consent left pending across the teardown.
      revealedActivity = "";
      return;
    }
    if (candidate.key === revealedActivity) return;
    revealedActivity = candidate.key;
    activityAnnouncement = "";
    const turn = ++announcementTurn;
    void (async () => {
      await tick();
      const current = activityReveal();
      if (!current || current.key !== candidate.key) return;
      // Legacy surfaces keep the previous "<edge>. Code <sas>. <compare>"
      // sentence verbatim; only a mixed link ever drops the code, and only after
      // this same link already said it.
      const announcement = announcer.announce(current, {
        mixed: workspace.usingMixed,
        linkGeneration: workspace.linkGeneration,
        codeLabel: t.codeLabel,
      });
      activityAnnouncement = announcement.text;
      await tick();
      // Confirm only what a person could actually have heard. This tick is the
      // flush, so surviving it means the sentence really is in the live region;
      // a newer edge that took the region first has already cleared it and taken
      // the turn, and coalesced both writes, so its own sentence must be the one
      // that carries the code. Erring this way can repeat a code that was on
      // screen for one frame — never lose the only announcement of it.
      if (announcementTurn === turn) announcement.confirm();
      // Intentionally instant. Smooth scrollIntoView has measured as a zero-scroll
      // no-op in Chrome on this page, while nearest+auto reveals correctly and
      // satisfies reduced-motion without a preference branch.
      //
      // "nearest" is the legacy behaviour and stays that way: it scrolls the
      // minimum, so a decision that is already on screen never moves the page.
      //
      // A unified workspace cannot use it. Its anchor sits inside a card whose
      // consent buttons are below the fold, and "nearest" does nothing at all for
      // an anchor that is itself already visible — measured on a real 390x844
      // tab: scrollY 13, Accept/Decline at 879. So place the anchor explicitly,
      // just below a header measured HERE. Both numbers are read in the same
      // synchronous block as the scroll, which is the only way they can describe
      // the same frame: the header grows by its SAS row (54px → 188px) in the
      // very update that produces this edge.
      const target = revealElement(current.target);
      if (workspace.usingMixed && target && headEl) {
        const gap = 12; // --space-3
        // Clear the box the anchor belongs to, not just the anchor. MessagePanel
        // keeps its anchor INSIDE the card, within its padding, so aligning the
        // anchor alone left the card's top edge 5px behind the header. The
        // markers App places itself are siblings ahead of their card, where the
        // two tops coincide and this min() changes nothing.
        const anchorTop = target.getBoundingClientRect().top;
        const box = target.closest(".ui-card, .ui-callout");
        const visualTop = box ? Math.min(anchorTop, box.getBoundingClientRect().top) : anchorTop;
        const top = visualTop + window.scrollY
          - headEl.getBoundingClientRect().height - gap;
        window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
      } else {
        target?.scrollIntoView?.({ block: "nearest" });
      }
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
    relayStatus = ice.relayStatus;
    relayBound = relayDeadline(ice, Date.now());
    lanDevice = await lanDeviceId();
    signaling = new SignalingClient(wsURL(location, roomCode), selfName, undefined, {
      // LAN room only. A pairing-code room is a two-participant capability room
      // — announcing the installation there would merge a user's own two tabs
      // into one participant and break pairing a browser with itself. Read as a
      // getter because switchRoom() rebinds this same client to another room.
      deviceId: () => (roomCode ? "" : lanDevice),
      active: () => isCurrentPage(),
    });
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
      // Same handler, same instant, and deliberately alongside the broadcast
      // below: this is where we announce to a peer, so it is where a peer that
      // speaks the protocol starts announcing back. Until one of the two lands,
      // that peer's pre-uploaded entries belong to neither lane.
      noteRosterPeers(p.map((x) => x.id));
      workspace.syncPeers();
      broadcastRelayRtt();
      broadcastCaps();
    });
    signaling.onPeerLeft((peerId) => workspace.peerLeft(peerId));
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
    relayStatus = "ok";
    session.reset();
    connState = "connecting";
    resetRelaySelection(); // the new room has its own relay pool + measurements
    resetPeerCaps(); // the new room has its own peers; nothing carries over
    resetHandoffLanes(); // …including which of them had settled a pre-upload lane
    revokeHandoff(); // …and any Send confirmed against the room being left
    textSession.end(); // 换房间就是换对端，消息会话跟着结束（历史留在页面上）
    const ice = await fetchIceConfig(roomCode);
    // A rapid second switch may have started (and possibly finished) while this
    // fetch was in flight — discard the stale credentials rather than clobbering
    // the newer room's TURN config and socket.
    if (epoch !== roomEpoch) return;
    iceServers = ice.iceServers;
    relayPool = ice.relays;
    relayStatus = ice.relayStatus;
    // The new room has its own credentials with their own expiry. Recomputed
    // beside them so the boundary can never outlive the config it came from.
    relayBound = relayDeadline(ice, Date.now());
    signaling.reconnect(wsURL(location, roomCode));
    startRelayMeasurement(); // measure the new room's pool in the background
  }

  $effect(() => {
    const key = roomCode;
    if (!signaling) return; // socket not built yet (initial mount)
    if (key === socketRoomKey) return; // already bound to this room
    // A room is ending. Nothing it decided may be inherited by the next one, and
    // that is true of a re-mint (code→code) exactly as it is of the way out —
    // the new room has a new deadline, new ciphertext and, as far as either side
    // knows, a different peer. What differs between the two halves is only WHO
    // crosses that boundary.
    //
    // THE RECEIVER IS THIS EFFECT'S, on every change including code→code. It
    // holds the last room's keys, its prompt, and its record of which ids it has
    // already answered for; carried across, an id the new peer sends is silently
    // a no-op because the OLD room settled it, and the user is never offered a
    // file that was really sent. App is its only holder, so there is no second
    // owner to race with.
    //
    // THE SENDER'S HALF IS NOT, except on the way out. `CodePairing.send()`
    // already calls `resetPreupload()` synchronously, between the mint and
    // `enterRoom`, and `startPreupload` runs the same boundary itself when it is
    // handed a different code. Both happen at or before the moment `roomCode`
    // changes — so by the time this effect runs on a code→code re-mint there is
    // nothing left to release, and a reset here would be a SECOND one.
    //
    // That second reset is not merely redundant. This effect and CodePairing's
    // room effect are both woken by the one roomCode change, and if the child
    // runs first it has already started the NEW room's driver: the reset would
    // then abort that upload, release its refs and blank the active code, which
    // stops the driver at the top of its loop. Nothing re-arms it — the child
    // effect has run for this roomCode, and its incidental dependency on the
    // outbox's state array disappears as soon as a pass is already running. The
    // new room would sit there uploading nothing.
    //
    // On the way OUT (code→"") there is no new room and no new driver, so this
    // is the last owner standing and does both. The QUEUE goes only here for its
    // own reason: queued files belong to the pairing attempt that queued them,
    // so leaving the code room by ANY path (start over, tab switch, back button)
    // drops them rather than letting them surprise-send to an unrelated peer
    // later — but ""→code (files were just queued) and code→code (a timedOut
    // re-mint) are the same user still sending the same batch, and must keep it.
    if (socketRoomKey) {
      storedReceiver.reset();
      if (!key) {
        clearOutbox();
        resetPreupload();
      }
    }
    socketRoomKey = key;
    void switchRoom();
  });

  // Tell the hub when this page becomes the one the user is looking at, so a
  // nearby device that picks this browser reaches THIS tab. Only fires on a real
  // transition (see watchCurrentPage) — every announcement spends a frame from
  // this connection's server-side budget. The join frame carries the initial
  // state, so nothing is sent at startup.
  onMount(() => watchCurrentPage(() => { if (signaling) signaling.sendActivate(); }));

  onMount(() => {
    // Guard tab/logo navigation and tab-close while a transfer is live: navigating
    // tears down the room (aborting the transfer), so confirm first; and warn on a
    // full page unload so an accidental close doesn't silently kill a transfer.
    // In-app dialog, not window.confirm(): the native one is unstyled, ignores
    // the page's language direction, and on some browsers is suppressed outright
    // when the click was not judged a user gesture — which would silently drop
    // the guard on the one navigation that must ask. Returning the promise keeps
    // the transfer alive until the reader actually answers.
    setNavGuard(() => (busy ? confirmDialog(messages[lang()].confirmLeave) : true));
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
  function toggleVerify(e: Event) {
    setVerifyPeers((e.currentTarget as HTMLInputElement).checked);
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

  /**
   * The one explicit action a link-capable LAN peer offers.
   *
   * It replaces the old file / folder / message fork, because on a `link/1` peer
   * that fork asked the user to choose between three things that all live in the
   * same place: one authenticated connection with both lanes on it. Choosing
   * "message" there did not mean "and not files", it just decided which surface
   * happened to build the link first.
   *
   * A queued OS share is the single thing that outranks it. Those files were
   * handed to us by the system with their destination still missing, so picking
   * the peer completes THAT intent rather than throwing it away — and a typed
   * draft is never sent by this path, on either branch.
   *
   * Except where the sender-side verification stop applies. In a code room with
   * advanced verification ON, the peer that joined might be someone who guessed
   * a live code, and the whole remedy is "look at the verification code before
   * you send". Opening the workspace is how the code gets on screen — so it must
   * not also be what sends the files. The batch stays queued and the workspace
   * carries an explicit, persistent release action for it (releaseQueued below).
   */
  function openWorkspace(peerId: string) {
    if (workspace.blocksNewIntent(peerId)) return;
    if (liveLinkFor(peerId) && !needsSendConfirmation(verifyOn, roomCode)) {
      workspace.sendFiles(peerId, drainFor(peerId));
      return;
    }
    void workspace.openText(peerId);
  }
  /**
   * Put the queued batch back in front of the user, from inside the workspace.
   *
   * The confirmation bar is dismissible, and dismissing it must not be a way to
   * lose files: inside a unified workspace the peer chooser is gone, so Cancel
   * used to leave a queue with no control anywhere on screen that could still
   * reach it. This is that control, and it re-arms the SAME confirmation rather
   * than sending — the code comparison is the point of the stop, so the release
   * cannot be the thing that skips it.
   */
  function releaseQueued() {
    // The exact value the control's own branch renders on, so there is no state
    // in which it is clickable and does nothing. A LIVE link is part of that
    // answer: this control exists so the files can leave after their code is
    // compared, and a link that has ended has no code to compare. With none,
    // the way back is the terminal card's "start again", which returns the
    // chooser and its own queued-files UI.
    const peerId = releaseTarget;
    if (!peerId) return;
    dismissedPeerId = null; // asked for again explicitly; the earlier Cancel is spent
    // Built from the link, not looked up in the roster. The peer of a live link
    // is not always in the roster — losing a signalling socket removes it from
    // every page's roster and leaves the DataChannel untouched — and a lookup
    // that missed used to silently arm nothing at all. `nameOf` degrades to a
    // short id there, exactly as the workspace header already does.
    pendingPeer = { id: peerId, name: nameOf(peerId) };
  }
  /** MessagePanel's explicit restart, scoped to the peer this link belongs to.
   *  With no link there is nothing to restart — reopening would silently build a
   *  new one, and a new authentication step must be something a person asked for. */
  function restartText() {
    const peerId = workspace.linkPeerId;
    if (!peerId) return;
    void workspace.openText(peerId);
  }
  /** The workspace header's Disconnect. Local state first and all of it
   *  synchronous: the draft box and the once-per-link launcher belong to this
   *  component, and a Disconnect that tore both lanes down while leaving them set
   *  is exactly how a stale composer and a spent launcher survive into the next
   *  link. The lane teardown itself is the workspace's. */
  function disconnectWorkspace() {
    textCompose = "";
    textOpener.reset();
    // The link the user compared a code on is what they just ended. The context
    // comparison already fails closed on it (a torn-down link reports no
    // generation at all), but an authorization is the one piece of state whose
    // stale form is a disclosure rather than a glitch, so it is dropped here too.
    revokeHandoff();
    workspace.disconnect();
  }
  /** The action on a link that ended of something the user has to act on. Same
   *  local cleanup as Disconnect, but there is nothing left to tear down —
   *  answering the explanation is the whole job, and it returns the chooser so a
   *  new link (or, in a code room, a fresh pairing) can be started. */
  function restartWorkspace() {
    textCompose = "";
    textOpener.reset();
    workspace.dismissLinkEnd();
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
  <!-- Whether this peer can carry a unified workspace: it announced exactly
       `link/1`. Every room qualifies now — LAN and pairing-code alike (see
       peer-caps' linkRoomActive) — so what decides this is the peer, not the
       room. A peer that does not speak the protocol (older browsers, the native
       clients, the CLI) is false here and renders the untouched legacy card
       below; it must never be sent a two-channel offer it would read as a file
       transfer whose manifest never arrives. -->
  {@const unifiedPeer = workspace.routes(p.id)}
  <li
    class="peer"
    class:disabled={intentBlocked}
    ondragover={(e) => { e.preventDefault(); if (!intentBlocked) (e.currentTarget as HTMLElement).classList.add("drag"); }}
    ondragleave={(e) => (e.currentTarget as HTMLElement).classList.remove("drag")}
    ondrop={(e) => { e.stopPropagation(); if (intentBlocked) { e.preventDefault(); flash(messages[lang()].busy); return; } onDrop(e, p.id); }}
  >
    <!-- The whole card is a pointer/touch shortcut to the primary picker below —
         not a second <label> for it. It used to be `<label for={pick-…}>`, which
         left one input associated with two labels (this card plus the .pa-files
         wrapper): axe flags form-field-multiple-labels and every AT gets to pick
         a different name. The name belongs to the visible action ("Send files");
         this card's text is *who* the files go to, which is already wired up as
         the input's aria-describedby.
         svelte-ignore: the keyboard path is deliberately not duplicated here. The
         real <input> is itself the tab stop for this action, so a key handler on
         the card would be a second control for the same thing. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="pcard"
      onclick={(e) => {
        // A click that ends a selection drag over the peer name is not a tap. The
        // <label> this replaces suppressed its activation in exactly that case,
        // and "I was selecting the name" is the one way opening a file chooser
        // here can surprise someone. A stale selection cannot block the shortcut:
        // mousedown collapses it before this ever runs.
        const picked = getSelection();
        if (intentBlocked || (picked && !picked.isCollapsed && picked.containsNode(e.currentTarget as Node, true))) return;
        // A unified peer has one action, so the card shortcut is that same one
        // action rather than a picker the card no longer shows.
        if (unifiedPeer) { openWorkspace(p.id); return; }
        const input = document.getElementById(`pick-${p.id}`) as HTMLInputElement | null;
        // Native label activation focuses its control before opening the picker.
        // Preserve that continuation point for pointer/keyboard mixed use without
        // letting a clipped 1px input scroll the page.
        input?.focus({ preventScroll: true, focusVisible: false });
        input?.click();
      }}
    >
      <span class="pavatar" class:big={solo}>{p.name.slice(0, 1).toUpperCase()}</span>
      <span class="ptext">
        {#if unifiedPeer}
          <!-- The lead must promise both lanes. "Click or drop files to send to
               X" described a fork that no longer exists here, and would leave
               the one action looking like it only sends files. -->
          <span class="pname" id={`peer-target-${p.id}`}>{solo ? t.workspace.openWith(p.name) : p.name}</span>
          <span class="pick">{t.workspace.openHint}</span>
        {:else if solo}
          <span class="pname" id={`peer-target-${p.id}`}>{t.pickSendTo(p.name)}</span>
        {:else}
          <span class="pname" id={`peer-target-${p.id}`}>{p.name}</span>
          <span class="pick">{t.pickHint(MAX_FILES)}</span>
        {/if}
      </span>
    </div>
    <!-- 这三个动作共用全局 .btn 原语（其中两个是包着隐藏 file input 的 <label>，
         :disabled 对 label 不生效，所以停用态走 .is-disabled）。以前它们是本组件
         里自成一套的 .act-btn：透明底 + --border 描边，在暗色下边框只有 1.36:1，
         等于看不见。 -->
    <div class="peer-actions">
      {#if unifiedPeer}
      <!-- ONE action. Files, folders and messages are all inside the workspace it
           opens, on one connection, so offering three entry points here made the
           user pick a lane before there was anything to pick between. Named
           `.open-workspace` on purpose: E2E and assistive tech both address it. -->
      <button type="button" class="btn btn-primary btn-sm open-workspace" disabled={intentBlocked}
        aria-describedby={`peer-target-${p.id}`}
        onclick={() => openWorkspace(p.id)}>
        <span class="pa-icon" aria-hidden="true"><Icon name="message" /></span><span class="pa-label">{t.workspace.open}</span>
      </button>
      {:else}
      <label class="btn btn-secondary btn-sm pa-files" class:is-disabled={intentBlocked}>
        <span class="pa-icon" aria-hidden="true"><Icon name="file" /></span><span class="pa-label" id={`send-file-label-${p.id}`}>{t.sendFile}</span>
        <input class="file-pick-input" id={`pick-${p.id}`} type="file" multiple disabled={intentBlocked}
          aria-labelledby={`send-file-label-${p.id}`}
          aria-describedby={`peer-target-${p.id}`}
          onclick={(e) => { if (liveLinkFor(p.id)) { e.preventDefault(); workspace.sendFiles(p.id, drainFor(p.id)); } }}
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
      {/if}
    </div>
  </li>
{/snippet}

{#snippet transferSurface()}
  {@const solo = visiblePeers.length === 1}
  {@const revealFile = [send, recv].find((x) => x && !x.done && workspace.sasCode)}
  {@const mixed = workspace.usingMixed}
  {@const hasActivity = !!pendingPeer || !!incoming || !!send || !!recv || activeText.status !== "idle" || mixed
    || storedReceiver.status !== "idle"}
  <!-- This live node exists before an event occurs; mounting a live region and
       its message in the same update is not announced reliably. Protected text
       bodies never enter it. -->
  <div class="activity-announcement" role="status" aria-live="polite" aria-atomic="true">{activityAnnouncement}</div>

  <!-- One authenticated link, one trust header. Peer name, link state, the single
       path label, the single SAS and the explicit Disconnect live here and only
       here; every lane card below deliberately renders none of them again. Legacy
       peers (workspace.usingMixed === false) keep their untouched per-surface
       chrome — that is now the path for exactly one thing: a peer that does not
       speak link/1, in either kind of room. -->
  {#if mixed}
    <WorkspaceHeader
      peerName={nameOf(workspace.linkPeerId)}
      status={workspace.linkStatus}
      sasCode={shownSas}
      path={workspace.linkPath}
      relayExpiring={workspace.relayExpiring}
      recoveryAvailable={workspace.recoveryAvailable}
      endReason={workspace.linkEndReason}
      onDisconnect={disconnectWorkspace}
      onRestart={restartWorkspace}
      bind:element={headEl}
    />
  {/if}

  <!-- Files the peer uploaded against the pairing code before this device
       joined, handed over as keys the moment it did. Above the live-link cards
       because it is the thing that is already finished waiting: the ciphertext
       exists, and no clock ends it — this device has joined, so the room has no
       deadline and no fallback expiry. Taking delivery is the only thing THIS
       device can do about it; the other end can release the room itself. -->
  <StoredIncoming receiver={storedReceiver} />

  {#if pendingPeer}
    <!-- Captured once: the handlers below are closures, and narrowing a $state
         binding does not survive into one. -->
    {@const pendingTarget = pendingPeer}
    <div class="activity-reveal-marker" bind:this={pendingReveal} aria-hidden="true"></div>
    <div class="ui-callout ui-callout-accent confirm-send">
      <!-- Two sentences, not one: who is asking, and what to do before saying
           yes. Gated on `shownSas` rather than on the preference, because that
           is exactly "a code is on screen right now" — in the workspace header
           above, or in the legacy card below. Telling someone to compare a code
           they cannot see would be worse than saying nothing. Naming the
           comparison is the whole point of the stop; "a device wants to receive
           — [Send]" is a prompt with no stated way to answer it correctly. -->
      <span>{t.confirmRecv(nameOf(pendingPeer.id))}{#if shownSas} {t.confirmRecvCompare}{:else if !canRelease} {t.confirmRecvNeedsCode}{/if}</span>
      <!-- Send only exists once there IS a code to compare. A preselected batch
           arms this bar before any link does, so on a unified target the Send it
           used to render was a release with nothing behind it — see
           canReleaseConfirmedSend. It is REPLACED rather than disabled: the way
           forward is a different action, and a greyed Send says only "no". The
           workspace it opens builds the link and drains nothing. -->
      {#if canRelease}
        <button class="btn btn-primary confirm-send-btn" onclick={confirmSend}>{t.confirmRecvSend}</button>
      {:else}
        <button class="btn btn-primary confirm-send-open" onclick={() => openWorkspace(pendingTarget.id)}>{t.workspace.open}</button>
      {/if}
      <button class="btn" onclick={cancelSend}>{t.confirmRecvCancel}</button>
    </div>
  {/if}

  <!-- The queue's own way back, and the reason Cancel above is not a trap.
       Inside a unified workspace the peer chooser is gone, so without this a
       dismissed confirmation would leave files queued with no control anywhere
       on screen that could still reach them. It re-arms the confirmation rather
       than sending: the comparison is the stop, and the release must not be a
       way around it. -->
  {#if releaseTarget && !pendingPeer}
    <!-- Counted over exactly what releaseQueued will hand THIS peer, which is
         peer-specific: an entry still uploading is in nobody's batch, and an
         already-uploaded one is in this batch precisely when the peer cannot be
         handed its key, or its key has not been released yet — and none of them
         at all while that peer's lane is still undecided, because the control
         must not name files it is not yet allowed to release. Asking a
         different question here than the Send it re-arms will ask is how the
         sentence and the send come to disagree about which files they mean. -->
    {@const releasing = pendingFilesFor(releaseTarget, keysReleasedTo(releaseTarget))}
    <div class="ui-callout release-queued">
      <span>{t.workspace.queuedRelease(
        releasing.length,
        formatSize(releasing.reduce((total, item) => total + item.file.size, 0)),
      )}</span>
      <button class="btn btn-primary btn-sm release-queued-btn" onclick={releaseQueued}>
        {t.workspace.queuedReleaseBtn}
      </button>
    </div>
  {/if}

  {#if incoming}
    <!-- The unified workspace already shows this link's one SAS in its header, so
         the consent card carries no second code — only this anchor. It sits at the
         TOP of the card, not where the code used to be: the reveal aligns it just
         under the pinned header, and anchoring mid-card would instead scroll the
         filenames (what the user is consenting to) up behind that header. -->
    {#if mixed}
      <div class="activity-reveal-marker" bind:this={incomingReveal} aria-hidden="true"></div>
    {/if}
    <section class="ui-card request">
      <div class="req-head" id="request-head">{t.requestHead(nameOf(incoming.from), incoming.files.length, formatSize(incoming.total))}</div>
      <!-- A long manifest scrolls inside its own box. Without a tab stop, someone
           deciding whether to accept 40 files can only read the first few of them
           unless they have a mouse — on the one screen where knowing exactly what
           you are consenting to is the entire point. Named by the card's heading,
           which already says who is sending and how much. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <ul class="filelist" tabindex="0" aria-labelledby="request-head">
        {#each incoming.files as f}
          <li><span class="fname">{f.name}</span><span class="fsize">{formatSize(f.size)}</span></li>
        {/each}
      </ul>
      <!-- Legacy surface. The verification box is shown only when the preference
           is on, but the reveal anchor is NOT optional: without it a consent
           card arriving below the fold would never be scrolled into view. The
           anchor keeps the box's position either way. -->
      {#if !mixed}
        {#if shownSas}
          <div class="sas activity-reveal-target" bind:this={incomingReveal}>{t.codeLabel} <code>{shownSas}</code> — {t.codeCompare}</div>
        {:else}
          <div class="activity-reveal-marker" bind:this={incomingReveal} aria-hidden="true"></div>
        {/if}
      {/if}
      <!-- 收/拒按钮住在 ReceiveActions 里，因为大批次的内存提示必须拦在这一下
           点击之前：接受即用户手势，pickSaveTarget 在同一个手势里开选择器。 -->
      <ReceiveActions
        files={incoming.files}
        total={incoming.total}
        retry={incoming.retry === true}
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
        <span class="label" id={`xfer-label-${xf.dir}`}>{xf.dir === "send" ? t.sendTo(nameOf(xf.peer)) : t.recvFrom(nameOf(xf.peer))}</span>
        {#if xf.files.length}<span class="count">{xf.files.length > 1 ? t.fileCounter(xf.index + 1, xf.files.length) : xf.files[0].name}</span>{/if}
        {#if xf.done}
          <button class="btn btn-sm x" onclick={() => (xf.dir === "send" ? workspace.dismissSend(xf) : workspace.dismissRecv(xf))} aria-label={t.close}><Icon name="close" size={14} /></button>
        {:else}
          <button class="btn btn-sm x cancel" onclick={() => workspace.abortFile(xf.dir)}>{t.cancel}</button>
        {/if}
      </div>
      <div class="status" aria-live="polite">
        {statusText(t, xf)}
        <!-- A mixed link's code belongs to the link, not to this batch: the header
             above owns it. Repeating it per card is what the one-SAS rule forbids. -->
        {#if shownSas && !xf.done && !mixed} · {t.codeLabel} <code>{shownSas}</code>{/if}
      </div>
      <!-- A cross-network connection that never came up is almost never "the
           transfer failed" — it is "there was no relay to carry it". Say which,
           so the user knows whether to retry, verify their email, wait for the
           quota to reset, or reload. relayFailNote returns "" for a plain
           relay-was-available failure, which keeps the generic status line. -->
      {#if xf.done && !xf.ok && xf.status === "connectFail" && relayFailNote(t, relayStatus)}
        <p class="ui-callout quota-note">{relayFailNote(t, relayStatus)}</p>
      {/if}
      <!-- Same rule for the path badge: one link, one path label, and it is in the
           header. Legacy keeps its per-direction badge. -->
      {#if !xf.done}
        {@const path = mixed ? undefined : xf.dir === "send" ? workspace.sendPath : workspace.recvPath}
        <!-- Named by the card's own heading ("Sending to Alice"): a bare
             progressbar announces a percentage of nothing. One card per
             direction, so the id is unique. -->
        <div class="progress-bar" role="progressbar" aria-labelledby={`xfer-label-${xf.dir}`}
             aria-valuenow={pct(xf)} aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style:width="{pct(xf)}%"></div></div>
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

  <!-- Picking more files during a transfer queues instead of disabling the file
       control, so that queue has to be visible and cancellable rather than an
       invisible backlog. Mixed links only: the legacy path has no queue. -->
  {#if mixed && workspace.queuedBatches.length}
    <QueuedBatches
      batches={workspace.queuedBatches}
      onCancel={(id) => workspace.cancelQueuedBatch(id)}
    />
  {/if}

  <!-- 消息面板放在这个 snippet 里面，所以 LAN 那条路径和 CrossPage 都从这一处拿到它。
       On a unified link it is also the workspace's whole activity surface: there
       is no peer card left to hang the file and folder controls on, so they live
       in the panel (`unified`). It therefore renders for a mixed link even while
       the text lane is still idle — the link exists, so its composer and its
       attachment controls are what should be on the screen.
       Every prop below is opt-in on the panel side; the legacy branch passes
       `unified={false}` and behaves exactly as before. -->
  {#if mixed || activeText.status !== "idle"}
    <!-- Remounted once per torn-down link, so no draft crosses from one
         authenticated link into the next. See linkEpoch for why this is not the
         link identity: that advances at establishment, which is mid-compose. -->
    {#key linkEpoch}
    <MessagePanel
      status={surfaceText.status}
      peerName={nameOf(workspace.linkPeerId || surfaceText.peerId)}
      sasCode={surfaceText.sasCode}
      showSas={!mixed && verifyOn}
      path={mixed ? undefined : workspace.textPath}
      history={surfaceText.history}
      errorKey={surfaceText.errorKey}
      prefill={textCompose}
      unified={mixed}
      attachmentsEnabled={unifiedAttachments}
      folderPickSupported={folderUploadSupported}
      bind:revealTarget={textReveal}
      onSend={sendSurfaceText}
      onAccept={acceptSurfaceText}
      onReject={rejectSurfaceText}
      onClear={clearSurfaceText}
      onEnd={endSurfaceText}
      onPrefillConsumed={() => (textCompose = "")}
      onPickFiles={(e) => pickFile(e, workspace.linkPeerId)}
      onPickFolder={(e) => pickFile(e, workspace.linkPeerId)}
      onRestart={restartText}
    />
    {/key}
  {/if}

  <!-- While a unified workspace exists it owns the screen. The chooser, the old
       per-peer file/folder/message controls and the message-availability hint all
       describe a device you have NOT connected to yet — leaving them up next to a
       live workspace offers a second, contradictory way to start one. Disconnect
       brings this whole section straight back. Legacy peers and every pairing
       room never take this branch. -->
  <!-- `showsPeerRoster` is the second half of the sibling boundary. LAN keeps
       its section unconditionally — the empty state IS its answer, and the
       scanning signal lives inside it. Cross-network keeps it only while the
       one participant the code let in is present, because "no other devices
       yet, open this page on another device on the same network" describes a
       network that destination does not use. -->
  {#if !mixed && showsPeerRoster(currentRoute(), visiblePeers.length)}
  <section class="peers" class:cross={currentRoute() === "cross"} class:after-activity={hasActivity} aria-labelledby={currentRoute() === "lan" ? "lan-peers-title" : undefined}>
    <!-- A pairing room currently has one remote target (the signalling room cap
         is two participants), and the roster on this route is that room — the
         socket is bound to the code, so “Connected peer” is its own title.
         LAN renders no heading here: its page <h1> IS “Nearby devices”, and the
         section points at it rather than printing the same words twice. -->
    {#if currentRoute() === "cross"}
      <h2>{t.crossPeersTitle}</h2>
    {/if}
    <QuotaNotice />
    {#if outbox().length && visiblePeers.length !== 1}
      <PendingFiles
        files={outbox()}
        summary={t.sharePending(
          outbox().length,
          formatSize(outbox().reduce((total, item) => total + item.file.size, 0)),
        )}
      />
      <!-- Only on LAN, and deliberately so. It is a standing owner promise that
           LAN staging is local and stays local — free LAN transfer is the whole
           point of not putting it on the server — and it is the one surface
           where the stronger claim is also true: these bytes go peer to peer,
           with no relay in the path. A code room must NOT reuse this string;
           its own note (pair.stageNote) stays silent about where the bytes are,
           because that is exactly what pre-upload changes. -->
      {#if currentRoute() === "lan"}
        <p class="ui-callout staged-local">{t.lanStagedNote}</p>
      {/if}
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
        <!-- The route this send would take, stated only once there is a real
             recipient to state it about. Inside the same branch as the send
             card on purpose: `selectedPeer` is a live entry of the visible
             roster, so the empty and still-scanning states draw no rail at all.
             What it may and may not claim is documented in the component. -->
        <LanPathRail {selfName} peerName={selectedPeer.name} />
        <ul bind:this={peerCardList} class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, dropBusy) === "pick"}>
          {@render peerCard(selectedPeer, solo)}
        </ul>
      {/if}
    {:else}
      <!-- No empty state here on purpose: `showsPeerRoster` has already decided
           this section only exists while the code's participant is present. -->
      <ul class:solo class:dragging={dragActive && dropTarget(visiblePeers.length, dropBusy) === "pick"}>
        {#each visiblePeers as p (p.id)}
          {@render peerCard(p, solo)}
        {/each}
      </ul>
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
  {/if}

  <!-- Deliberately inside transferSurface: LAN renders this snippet and so does
       CrossPage, so one placement makes the setting reachable from both kinds of
       session. Collapsed by default — it is an advanced option, and unfolding it
       is the moment to read what the comparison does and does not detect. -->
  <details class="ui-card verify-pref">
    <summary>{t.verify.title}</summary>
    <label class="verify-toggle">
      <input type="checkbox" checked={verifyOn} onchange={toggleVerify} />
      {t.verify.toggle}
    </label>
    <p class="verify-note">{t.verify.note}</p>
    <p class="verify-note">{t.verify.unaffected}</p>
  </details>
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
      <CrossPage {roomCode} {linkDead} {showTransfer} {relayStatus} {transferSurface} />
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
  {:else if currentRoute() === "device-inbox"}
    {#await routePage("device-inbox") then { default: DeviceInboxPage }}
      <DeviceInboxPage />
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
        <!-- The LAN destination's one page heading, and the only <h1> on it.
             It sits here rather than inside the roster below because the roster
             is replaced whole by a unified workspace — a heading in there would
             leave the page with no h1 at all in exactly the state someone is
             using it hardest. It also survives the unsupported-browser branch,
             where the page still needs a title over its explanation.
             The roster section is named by this heading instead of repeating
             it: the page must say "Nearby devices" once. -->
        <h1 class="lan-title" id="lan-peers-title">{t.peersTitle}</h1>
        {#if unsupported}
          <div class="ui-callout ui-callout-danger banner">{t.unsupported}</div>
        {:else}
          {@render transferSurface()}

          <section class="ui-card history">
            <details>
              <summary id="history-title">{t.historyTitle}</summary>
              {#if history.length}
                <!-- Same scrollable box as the consent manifest, same reason. -->
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <ul class="filelist" tabindex="0" aria-labelledby="history-title">
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
      <nav class="legal" aria-label={t.nav.footerLegalLabel}>
        <a href={legalUrl("security", lang())}>{t.legal.security}</a>
        <a href={legalUrl("privacy", lang())}>{t.legal.privacy}</a>
        <a href={legalUrl("terms", lang())}>{t.legal.terms}</a>
        <a href="https://github.com/relayium/relayium" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
      <nav class="legal" aria-label={t.nav.footerGuidesLabel}>
        <a href={PRICING_PATH} onclick={(e) => { e.preventDefault(); navigate("pricing"); }}>{t.pricingPage.navLink}</a>
        <a href={pageUrl("guides", lang())}>{t.learn.hub}</a>
        <a href={pageUrl("releases", lang()) + "/"}>{t.legal.releases}</a>
      </nav>
      <span class="fineprint">{t.footer}</span>
    </footer>
  {/if}
  {/if}
  {/if}
</main>

<!-- Global and route-independent on purpose: it sits outside <main>'s route
     branches, so a deploy that lands while the user is on /d/<id>, /me or the
     pricing page is just as visible as on the transfer page. It renders nothing
     until a genuinely newer service worker has installed (never on this
     device's first install). See app-update.svelte.ts for what it can and
     cannot reach — in particular, it cannot help a tab that is still executing
     an older build; it makes the NEXT deploy visible.

     `busy` is the workspace half of "a reload would destroy this": a live link,
     an in-flight transfer or an open message session. The notice folds in the
     queued outbox itself (a global store) and disables its refresh action for
     either. -->
<UpdateNotice {busy} />

<!-- Mounted here, not inside a route: the navigation guard can ask its question
     from any tab, and until this moved up it only rendered inside /me. A guard
     that opens a dialog nobody renders is worse than no guard — the promise
     never settles, so the navigation silently never happens. -->
<ConfirmModal />

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
    /* The task column starts at the top of the grid, so its heading carries no
       separating margin here — the column gap already does that job. */
    .lan-workspace.two-col .lan-title { margin-block-start: 0; }
    .lan-workspace.two-col .peers { margin-top: 0; }
    .lan-workspace.two-col .empty {
      box-sizing: border-box;
      inline-size: 100%;
      max-inline-size: 640px;
    }
  }

  /* In-app section headings stay modest; marketing sections use the larger global --fs-h2. */
  h2 { font-size: var(--fs-h3); margin: 0 0 var(--space-3); }
  /* The LAN page title. Same size the roster heading it replaces had: the global
     h1 is the marketing display size, and an application workspace's title is a
     label for the column under it, not a masthead. It also carries the spacing
     the roster's own top margin used to provide, so the heading and the devices
     it names stay one block. */
  .lan-title {
    font-size: 20px; line-height: 1.15; letter-spacing: -0.4px;
    margin: var(--space-7) 0 var(--space-3);
  }

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

  /* Same visual weight as the history preference: both are per-device settings
     that live under the task column rather than competing with it. */
  .verify-pref { margin-block-start: var(--space-3); }
  .verify-pref summary { cursor: pointer; font-weight: 600; color: var(--text-h); }
  .verify-toggle {
    display: flex; align-items: center; gap: 8px;
    margin-block-start: 12px; font-size: 13px; color: var(--text); cursor: pointer;
  }
  .verify-toggle input { cursor: pointer; }
  .verify-note { margin: 8px 0 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--text); }
  /* .sas itself is a shared primitive (app.css) — the verification box looks the
     same here and in the message panel. Only the stacking gap is local. */
  .sas { margin-block-end: 14px; }

  .xfer-head { display: flex; align-items: center; gap: 10px; }
  .xfer-head .label { color: var(--accent-fg); font-size: 14px; font-weight: 500; white-space: nowrap; }
  .xfer-head .count { color: var(--text); font-size: 13px; margin-inline-start: auto; word-break: break-all; text-align: end; }
  /* Close / Cancel share the .btn primitive; only their position and the
     cancel-specific hover colour are local. */
  .x { margin-inline-start: var(--space-2); flex: none; }
  .x.cancel:hover { color: var(--accent-fg); }
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
  /* The heading above owns the separation from the identity rail now; what is
     left here is the gap that opens once activity cards sit between them. */
  .peers { margin-top: 0; overflow-anchor: none; }
  .peers.after-activity { margin-top: var(--space-4); }
  .activity-reveal-marker {
    block-size: 0;
    scroll-margin-block-start: calc(64px + var(--space-3));
    overflow-anchor: none;
  }
  /* A unified workspace deliberately gets NO extra rule here, and its markers
     carry no extra class. Its reveal does not go through scrollIntoView at all:
     scroll-margin is resolved from whatever the stylesheet says, and the trust
     header's height is not a constant a stylesheet can know — it depends on
     locale, on width, and on whether the link has produced its code yet. The
     reveal scrolls explicitly instead, measuring the header in the same block. */
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
    .lan-title { margin-block-start: var(--space-5); }
  }
  /* Cross already lives in a .ui-stack; the homepage's Hero-to-task margin would
     otherwise add another 48px on top of that parent gap. */
  .peers.cross { margin-top: 0; }
  .peers h2 { font-size: 20px; }
  /* The send confirmation is accent because it wants a decision. The queued
     share now owns its file-detail layout inside PendingFiles. */
  .confirm-send {
    margin-block: 0 12px;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .confirm-send span { flex: 1 1 auto; }
  /* Same shape as the confirmation it re-arms, one step quieter: it is a
     standing reminder that files are still waiting, not a decision being asked
     for right now. */
  .release-queued {
    margin-block: 0 12px;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .release-queued span { flex: 1 1 auto; }
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
    background: var(--grad-action);
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

  /* Sits directly under the staged-file list it describes, so the promise and
     the files it is about are read together. */
  .staged-local { margin-block: 0 var(--space-3); font-size: var(--fs-xs); line-height: 1.5; }

  footer {
    margin-top: var(--space-6); padding-top: var(--space-5); border-top: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 10px;
    font-size: 12.5px; color: var(--text); text-align: center;
  }
  footer .legal { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  footer .legal a { color: var(--text-h); text-decoration: none; }
  footer .legal a:hover { color: var(--accent-fg); }
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
