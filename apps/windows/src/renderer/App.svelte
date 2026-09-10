<!--
  The composition root.

  This file owns the two rooms and the page selection, and nothing else: every
  protocol decision belongs to a `web/src/lib` module imported and run unmodified,
  and every privileged operation belongs to main. What is here is wiring.

  ## The same-network room opens by itself; the pairing room does not

  A `RoomController` opens a socket and reads ICE the moment it exists, so a room
  is built exactly when it should exist and stopped when it should not.

  Same-network is built at startup, because that is what the shipped Mac does —
  `RelayiumApp.swift:869` calls `startResident()` unconditionally, and
  `LanDiscovery` holds no `UserDefaults` at all. An earlier draft here defaulted
  it off and persisted the choice; that was a Windows-only behaviour wearing
  parity's name, and it left a first-run user looking at an empty screen with a
  button the Mac never asks anyone to press. A pause the user makes lasts for
  this process, exactly like `isPausedByUser`.

  Pairing is built when a code exists, because until then there is no room.

  ## Hiding the window is not leaving

  Nothing here reacts to visibility, focus or window state. A room survives the
  window being hidden or minimised, because receiving while not on screen is the
  point of a resident desktop client. Only an explicit stop, a document
  revocation and quit end a room — the same line main draws.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { ready } from "../../../../web/src/lib/crypto";
  import AppShell from "./shell/AppShell.svelte";
  import Card from "./shell/Card.svelte";
  import AccountPage from "./pages/AccountPage.svelte";
  import LanPage from "./pages/LanPage.svelte";
  import PairPage from "./pages/PairPage.svelte";
  import InboxPage from "./pages/InboxPage.svelte";
  import StoredPage from "./pages/StoredPage.svelte";
  import { StoredController, type StoredBridge } from "./stored/stored-controller.svelte.js";
  import { InboxController, type InboxBridge } from "./inbox/inbox-controller.svelte.js";
  import { StoredSendController, type StoredSendBridge } from "./send/stored-send-controller.svelte.js";
  import { goTo, page } from "./shell/navigation.svelte.js";
  import { lang, t } from "./i18n/index.svelte.js";
  import { RoomController } from "./rooms/room-controller.svelte.js";
  import { SignInController, type Phase, type SignInBridge } from "./sign-in-controller.js";
  import type { ReceiveBridge } from "./receive/receive-coordinator.js";
  import type { TransportBridge } from "./transport/bridge.js";
  import type {
    PairMintResult,
    PreferencesValues,
    PreferencesView,
    SignalingRoom,
  } from "../shared/ipc-contract.js";
  import { isWellFormedPairCode } from "./pair-code.js";
  import { attachResident, pushSnapshot, type ResidentBridge } from "./shell/resident.js";
  import { sendGate } from "./send/send-gate.svelte.js";
  import type { LoginItemOutcome } from "../main/login-item.js";

  /** The whole preload surface this app uses. Declared, not inferred. */
  type Bridge = SignInBridge &
    TransportBridge & {
      receive: ReceiveBridge;
      pair: { create(): Promise<PairMintResult> };
      prefs: {
        read(): Promise<PreferencesView>;
        write(payload: { key: string; value: boolean }): Promise<PreferencesValues>;
      };
      resident: ResidentBridge;
      loginItem: {
        read(): Promise<LoginItemOutcome>;
        write(payload: { enabled: boolean }): Promise<LoginItemOutcome>;
      };
      stored: StoredBridge;
      inbox: InboxBridge;
      send: StoredSendBridge;
    };

  const bridge = (globalThis as unknown as { relayium: Bridge }).relayium;

  /**
   * Whether the encryption library is loaded.
   *
   * ## Why this gates everything
   *
   * `crypto.ts` loads libsodium lazily and `sodiumSync()` THROWS until it has —
   * "libsodium not initialised — await ready() first". `peer-link.establish`
   * calls `generateKeyPair()` synchronously BEFORE it opens a transport, so
   * without this the first thing any link does is throw: before an
   * `RTCPeerConnection` is constructed, before a candidate is gathered, and
   * with nothing on screen to show for it.
   *
   * That is exactly what a real pairing attempt did. The Mac peer's offer
   * arrived over IPC, Windows threw inside `establish`, zero peer connections
   * were built, and the UI sat on the code-entry screen while the Mac timed
   * out. The shipping Web client awaits `ready()` before it joins anything
   * (`web/src/App.svelte:1463`); this client never called it at all.
   *
   * So no room is opened, no code is minted or joined, and no LAN discovery
   * starts until this is `ready`.
   */
  let cryptoPhase = $state<"pending" | "ready" | "failed">("pending");
  /** Set in `onDestroy`, so a `ready()` that resolves after teardown cannot
   *  spawn a room into a component that is gone. */
  let torndown = false;
  /** Suppressible only by an engineering build, so an automated UI run does not
   *  join a real production room. A shipped client always starts. */
  let lanAutoStart = true;

  let phase = $state<Phase>({ kind: "loading" });
  /**
   * The engineering build's permanent banner.
   *
   * The foundation rendered this and the shell rewrite dropped it — `onInfo`
   * took the payload and threw it away. That is not cosmetic: it is the one
   * thing on screen that distinguishes a build which accepts environment
   * overrides for its data root and its origin from one that refuses them, and
   * macOS shows the same banner for the same reason. Non-dismissible, and above
   * everything, so it cannot be scrolled out of sight.
   */
  let banner = $state<string | null>(null);
  let prefs = $state<PreferencesValues>({ verifyPeers: false });
  /** Set when the settings file exists and could not be read. The values shown
   *  are then defaults rather than the user's, and Account says so instead of
   *  rendering "off" as though it had been chosen. */
  let prefsUnreadable = $state(false);
  /**
   * What the app actually enforces while the settings file is unreadable.
   *
   * Treated as ON. The file may say the user asked to check every peer, and
   * this process cannot read it — so the two options are "enforce a check the
   * user may not have asked for" and "skip a check the user may have asked
   * for". Only one of those is recoverable by the user noticing, and it is not
   * the second. The Account surface says why, so this is a stated state rather
   * than a mysterious prompt.
   */
  const effectiveVerifyPeers = $derived(prefsUnreadable ? true : prefs.verifyPeers);
  /** A save that was refused — most importantly one refused because the file is
   *  unreadable, which must not silently revert a security preference. */
  let prefsSaveFailed = $state(false);

  let lanRoom = $state<RoomController | null>(null);
  let lanBusy = $state(false);
  /** The user's pause, for this process only. See `stopLan`. */
  let lanPaused = $state(false);
  let pairRoom = $state<RoomController | null>(null);
  let minted = $state<Extract<PairMintResult, { ok: true }> | null>(null);
  let minting = $state(false);
  let mintRefusal = $state<string | null>(null);
  let joinError = $state<string | null>(null);
  /**
   * A clock the expiry countdown can actually read.
   *
   * `Date.now()` inside a `$derived` is not reactive — nothing invalidates it,
   * so "expires in 5 min" was computed once and then sat there while the code
   * quietly died. This is the owned ticker that makes it move, and it runs only
   * while a code is on screen.
   */
  let now = $state(Date.now());

  /**
   * Text the user typed, kept above the pages that render it.
   *
   * A page component unmounts when the user looks at another route, so a draft
   * held inside one is destroyed by a sidebar click — and the six digits someone
   * is halfway through reading off another screen are exactly what they were
   * about to switch away to check. Keeping them here costs two variables and
   * removes a whole class of "it cleared itself".
   */
  /**
   * A stored link the OS handed us, waiting for the user to act on it.
   *
   * Held, not acted on: opening a link authorises nothing, and the folder
   * picker is what authorises writing files. It is a SECRET — the fragment is
   * the key — so it lives here and is never logged or echoed.
   */
  let storedLinkOffer = $state("");

  /**
   * The stored receive, owned here rather than by its page.
   *
   * A page unmounts when the user looks at another row; a running transfer, its
   * progress and a half-pasted link must not. Same reason the message and code
   * drafts live up here.
   */
  const stored = new StoredController(bridge.stored);
  /**
   * App-lived, exactly like `stored` and for a stronger reason.
   *
   * The Inbox scheduler runs in MAIN whether or not this page is mounted, so a
   * controller built by the page would miss every state push sent while the
   * user was on another row — including the one saying a delivery arrived. Held
   * here, its subscription spans the life of the window.
   */
  const inbox = new InboxController(bridge.inbox);
  /**
   * App-lived, and for a stronger reason than the others.
   *
   * The picked `File` objects are the one thing a page cannot recover on its
   * own: losing them on an unmount means asking the user to choose their files
   * again, mid-upload.
   */
  const send = new StoredSendController(bridge.send);

  /** What Windows says about starting at sign-in. Null until it has answered. */
  let startup = $state<LoginItemOutcome | null>(null);

  let messageDraft = $state("");
  let codeDraft = $state("");
  $effect(() => {
    if (!minted) return;
    const handle = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(handle);
  });

  /**
   * A room reported something outside its own reactive state.
   *
   * Read by the `$effect` below and by nothing else. It used to key an
   * `{#key revision}` block, which REMOUNTED the whole active page on every
   * roster tick, ICE arrival and capability hello — throwing away a half-typed
   * message, a partly-entered code, keyboard focus and the SAS confirmation
   * along with it. The controller's observable fields are `$state` now, so
   * Svelte re-renders the parts that changed and nothing is destroyed.
   */
  let revision = $state(0);
  const bump = () => {
    revision += 1;
  };

  const controller = new SignInController({
    bridge,
    onPhase: (next) => {
      phase = next;
    },
    onInfo: (info) => {
      banner = info.banner;
      lanAutoStart = info.lanAutoStart !== false;
      // Deferred until crypto is ready: starting a room here would compose a
      // workspace whose very first link throws.
      maybeAutoStartLan();
    },
  });

  const openRoom = (room: SignalingRoom) =>
    new RoomController({
      bridge,
      room,
      // The name a peer sees. Product vocabulary, not a hostname or a peer id.
      displayName: t("thisPc"),
      receive: bridge.receive,
      onChange: bump,
      // A code room holds exactly the two peers who agreed the code, so the
      // intent is already expressed and a Connect button would ask again. LAN
      // stays manual: its roster is devices the user did not choose.
      autoConnect: room.kind === "code",
    });

  async function setPref(key: "verifyPeers", value: boolean) {
    try {
      prefs = await bridge.prefs.write({ key, value });
      prefsSaveFailed = false;
    } catch {
      // Surfaced, never swallowed: the checkbox must not sit there looking set
      // when nothing was written.
      prefsSaveFailed = true;
      throw new Error("preference not saved");
    }
  }

  /**
   * Join the same-network room.
   *
   * Called automatically at startup, exactly as the shipped Mac does
   * (`RelayiumApp.swift:869` calls `startResident()` unconditionally). It is not
   * an opt-in: `LanDiscovery` holds no `UserDefaults` at all, so there is no
   * shipped state in which a fresh Relayium sits out of the room waiting to be
   * asked.
   */
  function startLan() {
    if (lanRoom || lanBusy || residentFenced) return;
    lanBusy = true;
    try {
      lanRoom = openRoom({ kind: "lan" });
      lanPaused = false;
    } finally {
      lanBusy = false;
    }
  }

  /**
   * Leave the room, for this PROCESS.
   *
   * In memory, and that is parity rather than a shortcut: Mac's
   * `isPausedByUser` is a plain field, so its pause survives hiding the window
   * and reopening it and every reconnect, and does not survive a restart.
   * Persisting it here would be a Windows-only behaviour wearing parity's name.
   */
  function stopLan() {
    lanRoom?.stop();
    lanRoom = null;
    lanPaused = true;
  }

  async function createCode() {
    if (cryptoPhase !== "ready" || torndown || minting || residentFenced) return;
    minting = true;
    mintRefusal = null;
    try {
      const result = await bridge.pair.create();
      // Re-checked after the mint: a quit can begin and be answered while the
      // request is in flight, and installing a live code into the page — or
      // opening the room for it — would be starting work the answer excluded.
      if (residentFenced) return;
      if (result.ok) {
        minted = result;
        pairRoom?.stop();
        pairRoom = openRoom({ kind: "code", code: result.code });
      } else {
        mintRefusal = t(
          result.refusal === "signed-out"
            ? "pairSignedOut"
            : result.refusal === "quota"
              ? "pairQuota"
              : result.refusal === "unverified"
                ? "pairUnverified"
                : result.refusal === "rate-limited"
                  ? "pairRateLimited"
                  : "pairUnavailable",
        );
      }
    } catch {
      // `createPairCode` throws when the authority that started it went away —
      // a sign-out, an account switch, a reload. There is no code to install
      // and nothing to say beyond that it did not happen.
      mintRefusal = t("pairUnavailable");
    } finally {
      minting = false;
    }
  }

  /** Leave the pairing room and clear its code. */
  function leavePair() {
    pairRoom?.stop();
    pairRoom = null;
    minted = null;
    joinError = null;
    mintRefusal = null;
  }

  function joinCode(code: string) {
    if (cryptoPhase !== "ready" || torndown || residentFenced) return;
    const trimmed = code.trim();
    if (!isWellFormedPairCode(trimmed)) {
      joinError = t("pairBadCode");
      return;
    }
    joinError = null;
    minted = null;
    pairRoom?.stop();
    pairRoom = openRoom({ kind: "code", code: trimmed });
  }

  function maybeAutoStartLan() {
    if (cryptoPhase !== "ready" || torndown || lanPaused || !lanAutoStart || residentFenced) return;
    void startLan();
  }

  /**
   * Load the encryption library, then let anything happen.
   *
   * Retryable: a failed dynamic import is usually transient, and `crypto.ts`
   * clears its cached promise on failure precisely so a second `ready()` is a
   * real retry rather than a replay of the same rejection.
   */
  async function initCrypto() {
    cryptoPhase = "pending";
    try {
      await ready();
    } catch {
      if (!torndown) cryptoPhase = "failed";
      return;
    }
    // The fence. A `ready()` that resolves after teardown must not spawn a room
    // nothing will ever stop.
    if (torndown) return;
    cryptoPhase = "ready";
    maybeAutoStartLan();
  }

  /**
   * What quitting would cost, from the page's side.
   *
   * The two facts main cannot see: an outgoing WebRTC send, and text that has
   * been typed and not sent. `workspace.send`/`recv` are the transfer halves;
   * the drafts are the two variables above, which survive page changes exactly
   * so a quit prompt can be honest about them.
   */
  function residentSnapshot() {
    const rooms = [lanRoom, pairRoom].filter((room) => room !== null);
    // A pasted link nobody has opened yet is unfinished work too, and a quit
    // that called it nothing would be wrong.
    const drafts =
      (messageDraft.trim() ? 1 : 0) + (codeDraft.trim() ? 1 : 0) + (stored.link.trim() ? 1 : 0);
    return {
      sending: rooms.some((room) => room.workspace.send),
      // A stored receive is incoming bytes like any other.
      receiving: stored.busy || rooms.some((room) => room.workspace.recv || room.openReceiveCount > 0),
      drafts,
      // So main's dialogs, tray and notifications are in the language this
      // window is actually showing, whatever the OS APIs each side reads.
      locale: lang() === "zh" ? ("zh-Hans" as const) : ("en" as const),
      nearby: lanRoom !== null,
    };
  }

  /**
   * Stop everything this page is doing. The user has agreed to quit.
   *
   * Rooms are stopped, not merely paused: this is the page's half of the
   * teardown, and main joins its own leases after it. The drafts are left
   * alone — a "Stay" must find the half-typed message still there.
   */
  function residentQuiesce() {
    lanRoom?.stop();
    lanRoom = null;
    pairRoom?.stop();
    pairRoom = null;
    // Suppressed so the auto-start effect does not immediately reopen the room
    // that was just closed for a quit.
    lanPaused = true;
  }

  /**
   * Set while a quit is deciding: start nothing new, stop nothing running.
   *
   * Every place the PAGE begins work checks it — opening a room, minting a
   * code, joining one — because those are the halves main cannot refuse by
   * itself, and a "nothing at stake" answer has to still be true when the user
   * finishes reading the dialog.
   */
  let residentFenced = $state(false);

  const detachResident = attachResident(bridge.resident, {
    snapshot: residentSnapshot,
    navigate: (page) => goTo(page),
    setAdmission: (action) => {
      residentFenced = action === "fence";
      // The same fence the SEND surfaces read. Main refusing a new receive
      // protects only the inbound half; every outgoing path starts in this page.
      if (residentFenced) sendGate.fence();
      else sendGate.admit();
    },
    setLan: (action) => (action === "pause" ? stopLan() : startLan()),
    quiesce: residentQuiesce,
    // The user stayed. Nothing reopens: the rooms were told to stop, and a
    // resumed app is one that CAN start them again, not one that already has.
    resume: () => {},
    storedLink: (link) => {
      goTo("stored");
      storedLinkOffer = link;
      return true;
    },
    pairCode: (code) => {
      if (!isWellFormedPairCode(code)) return false;
      // Offered, never merged: the code lands in the join field on the pairing
      // page, where the user confirms it. An active room is left running.
      goTo("pair");
      codeDraft = code;
      return true;
    },
  });

  /**
   * Facts main cannot observe, announced once each.
   *
   * A received MESSAGE saves no files, so main can never learn about one from a
   * publication report — it happens entirely in this page. The same is true of
   * a verification code waiting to be compared. Both are reported as a closed
   * KIND: no body, no sender, no code, nothing that could reach a lock screen.
   */
  let seenInbound = new Map<RoomController, number>();
  let announcedSas = new Set<RoomController>();
  $effect(() => {
    void revision;
    for (const room of [lanRoom, pairRoom]) {
      if (!room) continue;
      const history = room.workspace.text.history;
      const latest = history.reduce((id, entry) => (entry.dir === "in" ? Math.max(id, entry.id) : id), 0);
      const previous = seenInbound.get(room) ?? 0;
      if (latest > previous) {
        seenInbound.set(room, latest);
        // Only for messages that arrived after this page started watching, so a
        // reconnect that replays a transcript does not re-announce it.
        if (previous > 0 || history.some((entry) => entry.dir === "in" && entry.id === latest)) {
          void bridge.resident.notify({ kind: "saved-message" }).catch(() => undefined);
        }
      }
      // A code waiting to be compared is the one thing that genuinely needs the
      // user, which is what `attention` is for. Announced once per room.
      const waiting = room.workspace.sasCode !== "" && !room.verificationConfirmed;
      if (waiting && !announcedSas.has(room)) {
        announcedSas.add(room);
        void bridge.resident.notify({ kind: "attention" }).catch(() => undefined);
      }
      if (!waiting) announcedSas.delete(room);
    }
  });

  // Volunteered whenever it changes, so main has something recent even if the
  // page is too busy to answer a question. It never SETTLES a question — main
  // asks explicitly and waits for that answer.
  $effect(() => {
    const snapshot = residentSnapshot();
    void revision;
    pushSnapshot(bridge.resident, snapshot);
  });

  // Quit and window destruction reach here. Hiding does not.
  onDestroy(() => {
    torndown = true;
    stored.dispose();
    inbox.destroy();
    send.dispose();
    detachResident();
    controller.dispose();
    lanRoom?.stop();
    pairRoom?.stop();
  });

  void initCrypto();
  void controller.refresh();
  // Read once at startup rather than when the Inbox row is first clicked: the
  // sidebar and the resident surfaces describe a feature that is already
  // running, and a page that only learned its state on arrival would show
  // "starting" for a scheduler that has been receiving for an hour.
  void inbox.refresh().catch(() => undefined);
  void send.refreshHistory().catch(() => undefined);
  void bridge.loginItem
    .read()
    .then((outcome) => {
      startup = outcome;
    })
    .catch(() => undefined);

  async function setStartup(enabled: boolean) {
    // The answer is the system's, not the checkbox's: enabling asks for consent
    // natively and can be declined, and Windows can refuse the write outright.
    startup = await bridge.loginItem.write({ enabled }).catch(() => startup);
  }

  void bridge.prefs.read().then((snapshot) => {
    prefs = snapshot.values;
    prefsUnreadable = snapshot.health === "unreadable";
  });

  // A code room says which of the two things happened, rather than spinning —
  // and rather than blaming the code for a network it could not reach.
  $effect(() => {
    void revision;
    if (!pairRoom) return;
    if (pairRoom.refused) joinError = t("pairRefused");
    else if (pairRoom.connection === "offline") joinError = t("pairUnreachable");
  });
</script>

<AppShell current={page()} {banner}>
  <!-- Nothing composes a room until the encryption library is loaded, so this
       says which state it is in rather than rendering a pairing screen whose
       buttons cannot work. -->
  {#if cryptoPhase !== "ready"}
    <Card>
      <h2>{cryptoPhase === "failed" ? t("startFailedTitle") : t("startingTitle")}</h2>
      <p class="dim">{cryptoPhase === "failed" ? t("startFailedBody") : t("startingBody")}</p>
      {#if cryptoPhase === "failed"}
        <button class="primary" data-test="crypto-retry" onclick={() => void initCrypto()}>
          {t("startRetry")}
        </button>
      {:else}
        <div class="indeterminate" data-test="crypto-pending" role="progressbar" aria-label={t("startingTitle")}>
          <span></span>
        </div>
      {/if}
    </Card>
  {:else if page() === "lan"}
    <LanPage
      room={lanRoom}
      receiving={lanRoom !== null}
      busy={lanBusy}
      onStart={() => void startLan()}
      onStop={() => void stopLan()}
      verifyPeers={prefs.verifyPeers}
    />
  {:else if page() === "pair"}
    <PairPage
      room={pairRoom}
      {minted}
      {minting}
      refusal={mintRefusal}
      {joinError}
      onCreate={() => void createCode()}
      onJoin={joinCode}
      onLeave={leavePair}
      {now}
      bind:codeDraft
      bind:messageDraft
      verifyPeers={effectiveVerifyPeers}
    />
  {:else if page() === "stored"}
    <StoredPage
      {stored}
      {send}
      offered={storedLinkOffer}
      onConsumed={() => {
        // Consumed by the box, not by a transfer: the link is on screen and the
        // user still has to ask for it.
        storedLinkOffer = "";
      }}
    />
  {:else if page() === "inbox"}
    <InboxPage {inbox} onSignIn={() => goTo("account")} />
  {:else}
    <AccountPage
      {controller}
      {phase}
      {startup}
      verifyPeers={prefs.verifyPeers}
      prefsUnreadable={prefsUnreadable}
      prefsSaveFailed={prefsSaveFailed}
      onVerifyPeers={(value) => void setPref("verifyPeers", value)}
      onStartup={(enabled) => void setStartup(enabled)}
    />
  {/if}
</AppShell>

<style>
  h2 { margin: 0 0 var(--space-hairline); font-size: 15px; font-weight: 600; }
  .dim { color: var(--text-dim); margin: 0 0 var(--space-section); }
  .indeterminate {
    position: relative;
    overflow: hidden;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
  }
  .indeterminate span {
    position: absolute;
    inset: 0 auto 0 0;
    width: 35%;
    border-radius: 2px;
    background: var(--accent);
    animation: indeterminate 1.4s var(--ease) infinite;
  }
  /* Controls come from `tokens.css`; this file styles only the crypto gate. */
</style>
