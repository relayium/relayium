// Electron wiring. All policy lives in `app-service.ts`; this file narrows
// untrusted payloads and hands them on.
//
// The split is deliberate: rules that only exist inside an `ipcMain.handle`
// closure cannot be tested, and the rules here are the ones a race would break.

import { app, dialog, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import {
  IPC,
  IPC_EVENTS,
  MAX_ATTEMPT_NONCE_LENGTH,
  MAX_IPC_CHUNK_BYTES,
  MAX_REQUEST_ID_LENGTH,
  MAX_RESIDENT_DRAFTS,
  MAX_IPC_MANIFEST_ENTRIES,
  MAX_SIGNALING_FRAME_BYTES,
  MAX_SOCKET_TOKEN_LENGTH,
  type AppInfo,
  type IceReply,
  type ReceiveAuthority,
  type PublishReport,
  type ResidentAck,
  type ResidentCommand,
  type ResidentNotice,
  type ResidentSnapshot,
  type SignalingEvent,
  type SignalingRoom,
} from "../shared/ipc-contract.js";
import { AppService, type AppServiceDeps, type CleanupOutcome } from "./app-service.js";
import { DeviceAuthClient } from "./account/device-auth.js";
import { ENGINEERING_BANNER, engineeringOverride, isEngineeringBuild } from "./build-mode.js";
import { IceControl, IceRequestRegistry } from "./net/ice-control.js";
import { PairControl } from "./net/pair-control.js";
import { PreferenceStore, isPreferenceKey, preferencesPath } from "./preferences.js";
import {
  currentState,
  disable,
  enable,
  type LoginItemOutcome,
  type LoginItemSystem,
} from "./login-item.js";
import { SignalingHub, isWellFormedCode, type SignalingSocketFactory } from "./net/signaling-socket.js";
import { BoundedTransport } from "./net/transport.js";
import { SecretStore, platformCipher } from "./secrets.js";
import { currentDataRoot } from "./storage.js";
import { IpcRefusal, IpcRouter, expectChunk, expectIndex, expectObject, expectString } from "./ipc.js";
import { openApprovedExternal } from "./window.js";

/**
 * Composition a caller may substitute.
 *
 * Explicit injection at the call site, NOT an ambient environment override.
 * `build-mode.ts` refuses overrides in a packaged build precisely so nothing
 * outside the process can redirect where secrets live; this parameter cannot be
 * reached from outside the program at all, so a test can supply a task-owned
 * store without weakening the shipped path by one line.
 */
export interface HandlerComposition {
  makeStore?: () => Promise<SecretStore>;
  /** The destination a batch is written into. See `AppServiceDeps`. */
  makeDestination?: AppServiceDeps["makeDestination"];
  /** The signalling socket constructor, substituted so a test can drive the hub
   *  without a network. Absent means Electron's built-in `WebSocket`. */
  makeSignalingSocket?: SignalingSocketFactory;
  /** The ICE control-plane reader, substituted for the same reason. */
  makeIceControl?: () => IceControl;
  /** The pairing-code minter. */
  makePairControl?: () => PairControl;
  /** Where preferences live. Substituted so a test owns its own file rather
   *  than the user's real one. */
  makePreferences?: () => PreferenceStore;
  /**
   * The folder picker.
   *
   * Substituted so an automated run can open a real lease. There is no channel
   * that carries a path — the renderer still cannot name a destination — and
   * this is not reachable from the environment; it is the same reviewed
   * injection point as the auth client, for the same reason: a smoke that
   * cannot open a lease cannot exercise quit, cleanup or residue at all.
   */
  pickDirectory?: () => Promise<string | null>;
  /** The system that actually starts programs at sign-in. Substituted so an
   *  automated run does not add itself to a developer's startup programs. */
  loginItem?: LoginItemSystem;
  /**
   * A device-auth client the caller supplies instead of the real one.
   *
   * Exists so the Electron smoke can drive the ACTUAL renderer — click Sign in,
   * hold the poll, click Cancel, release a late success — without touching the
   * production auth endpoints or opening a browser. Wiring drift between the
   * contract, the preload, the handlers and the component is exactly what a
   * controller unit test cannot see.
   */
  makeAuthClient?: (installationID: string) => DeviceAuthClient;
  /**
   * Where the approval URL goes. Substituted so a test can assert the URL was
   * produced and validated without a browser window appearing.
   *
   * Deliberately narrow. These three are the composition a test may replace;
   * there is no spread of the whole dependency set, and nothing here is
   * reachable from the renderer or from the environment — `build-mode.ts`
   * refuses environment overrides in a packaged build for the same reason.
   */
  openApproval?: (url: string) => Promise<boolean>;
}

/**
 * How the resident runtime talks to the page.
 *
 * Deliberately narrow: a command goes out, ONE acknowledgement of that command
 * comes back, and an unsolicited snapshot is a separate thing that can never
 * settle an outstanding question.
 */
/** What main learns about, and may announce. */
export interface ResidentEvents {
  /** A publication actually finished. Files saved, or a failure — both are
   *  facts main observes itself rather than being told. */
  onPublished?: (report: PublishReport) => void;
  /** Something the page knows and main cannot see. A closed kind, nothing else. */
  onNotice?: (notice: ResidentNotice) => void;
  /** The page told main which language it is showing. */
  onLocale?: (locale: ResidentSnapshot["locale"]) => void;
  /** Whether Nearby is running, for the tray item that toggles it. */
  onNearby?: (active: boolean) => void;
  /** Enabling start-at-login needs the user's explicit yes, asked natively. */
  confirmLoginItem?: () => Promise<boolean>;
  /** Diagnostics sink for failures that must not reach a screen. */
  reportFailure?: (err: unknown) => void;
}

export interface ResidentBridge {
  /** Send one command; resolve with the page's answer to THAT request. */
  send(command: ResidentCommand, timeoutMs?: number): Promise<ResidentAck | "unavailable">;
  /** The last state the page volunteered, or `null` if it never has. */
  lastSnapshot(): ResidentSnapshot | null;
  /**
   * Ask, and believe only the answer to this question.
   *
   * `"unknown"` when the page is gone, unresponsive, or answered something that
   * did not describe its state. Never a stale push, and never a default.
   */
  freshSnapshot(timeoutMs?: number): Promise<ResidentSnapshot | "unknown">;
}

/** Everything the resident wiring needs from one registration. */
export interface HandlerControl {
  readonly service: AppService;
  readonly resident: ResidentBridge;
  /**
   * Stop main's own outgoing work, recoverably.
   *
   * The page acknowledging a quiesce says the UI stopped; it says nothing about
   * the sockets, the ICE reads and the leases MAIN owns, which is where the
   * outgoing work actually lives. Both halves have to stop, and this is the
   * half that does not end the process.
   */
  readonly quiesce: () => Promise<CleanupOutcome>;
  /**
   * The settings file this registration uses.
   *
   * Exposed so the resident surfaces write the SAME file, through the same
   * store: two stores over one path would each serialise their own writes and
   * neither would see the other's, and the first-close acknowledgement is
   * written by main while the page is writing preferences.
   */
  readonly preferences: () => PreferenceStore;
  /** The final, unrecoverable teardown. */
  readonly dispose: () => Promise<void>;
}

/** How long the page gets to answer before its state is treated as unknown. */
const RESIDENT_ACK_TIMEOUT_MS = 2_000;

/**
 * How long a quiesce waits for asked-to-stop network work to actually stop.
 *
 * Bounded because a quit must not hang on a socket the peer is not answering,
 * and reported because "we asked" is not "it stopped".
 */
const NETWORK_DRAIN_MS = 1_500;

/** A failure as a bounded string; never the `Error`, which crosses no boundary
 *  from here except into a log. */
function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? (err.message ?? err.name) : String(err);
  return raw.slice(0, 200);
}

/** Returns the owned teardown and the resident bridge for everything it started. */
export function registerHandlers(
  window: BrowserWindow,
  origin: string,
  scheme: string,
  host: string,
  composition: HandlerComposition = {},
  events: ResidentEvents = {},
): HandlerControl {
  const router = new IpcRouter(scheme, host);
  router.bind(window.webContents);

  const service = new AppService({
    origin,
    makeStore:
      composition.makeStore ??
      (async () => {
        const root = currentDataRoot();
        if (!root.ok) throw new IpcRefusal(`data root unavailable: ${root.reason}`);
        return new SecretStore(`${root.path}/secrets`, await platformCipher());
      }),
    makeAuthClient:
      composition.makeAuthClient ??
      ((installationID) => new DeviceAuthClient(origin, new BoundedTransport(origin), installationID)),
    async pickDirectory() {
      if (composition.pickDirectory) return composition.pickDirectory();
      // The user names the destination, in a native dialog. No IPC channel in
      // this app carries a filesystem path, which is what makes the renderer
      // unable to choose one.
      const picked = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        title: "Choose where to save",
      });
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    openApproval: composition.openApproval ?? ((url) => openApprovedExternal(url, origin)),
    newId: () => randomUUID(),
    // The service fences leases on this the way it fences them on the account
    // epoch. A reload keeps the same `WebContents`, so `destroyed` never fires
    // and `dispose()` never runs — without a document identity, the previous
    // page's transfers would keep an open handle and staged bytes with nobody
    // left to finish or cancel them.
    documentGeneration: () => router.generation,
    makePairControl:
      composition.makePairControl ?? (() => new PairControl(origin)),
    // Forwarded, so an injected destination is actually the one a lease opens.
    // Without this the composition was accepted and then ignored, and a test
    // that thought it was driving its own destination was driving the real one.
    ...(composition.makeDestination ? { makeDestination: composition.makeDestination } : {}),
  });

  router.handle(IPC.appInfo, async (): Promise<AppInfo> => ({
    origin,
    engineering: isEngineeringBuild(),
    banner: isEngineeringBuild() ? ENGINEERING_BANNER : null,
    version: process.env["npm_package_version"] ?? "0.0.1",
    // Same-network discovery starts automatically, exactly as the shipped Mac
    // does. This is the one way to suppress it, and it is deliberately narrow:
    // `engineeringOverride` returns nothing in a packaged build, so a shipped
    // client cannot be told to stay out of the room by anything in its
    // environment. It exists so an automated UI run does not join a real
    // production room — which is precisely what Mac's own `UITestMode`
    // residency gate is for.
    lanAutoStart: engineeringOverride("RELAYIUM_WINDOWS_NO_LAN_AUTOSTART") === undefined,
  }));

  // The attempt nonce is renderer-supplied, so it is bounded and shaped at this
  // boundary like every other untrusted payload. It names an attempt; it
  // authorises nothing.
  const attemptNonce = (payload: unknown): string =>
    expectString(expectObject(payload)["nonce"], MAX_ATTEMPT_NONCE_LENGTH);

  router.handle(IPC.authState, () => service.authState());
  router.handle(IPC.authStart, (payload) => service.startSignIn(attemptNonce(payload)));
  router.handle(IPC.authPoll, (payload) => service.pollSignIn(attemptNonce(payload)));
  router.handle(IPC.authCancel, (payload) => service.cancelSignIn(attemptNonce(payload)));
  router.handle(IPC.authSignOut, () => service.signOut());

  router.handle(IPC.receiveOpen, async (payload) => {
    const body = expectObject(payload);
    const entries = body["manifest"];
    if (!Array.isArray(entries) || entries.length === 0) throw new IpcRefusal("expected a manifest");
    if (entries.length > MAX_IPC_MANIFEST_ENTRIES) throw new IpcRefusal("manifest too large");
    const manifest = entries.map((entry) => {
      const e = expectObject(entry);
      return { name: expectString(e["name"], 4096), size: expectIndex(e["size"]) };
    });
    // Absent means `account`, so every existing caller keeps the accepted
    // epoch fencing. Only an explicit `direct` opts out, and only into the
    // no-account authority — there is no third value to reach.
    const raw = body["authority"];
    if (raw !== undefined && raw !== "account" && raw !== "direct") {
      throw new IpcRefusal("unknown receive authority");
    }
    const authority: ReceiveAuthority = raw === "direct" ? "direct" : "account";
    return service.openReceive(manifest, authority);
  });

  const leaseId = (body: Record<string, unknown>): string => expectString(body["leaseId"], 64);

  router.handle(IPC.receiveBegin, async (payload) => {
    const body = expectObject(payload);
    await service.beginFile(leaseId(body), expectIndex(body["index"]));
    return { ok: true };
  });

  router.handle(IPC.receiveWrite, async (payload) => {
    const body = expectObject(payload);
    await service.writeChunk(
      leaseId(body),
      expectIndex(body["index"]),
      expectChunk(body["chunk"], MAX_IPC_CHUNK_BYTES),
    );
    return { ok: true };
  });

  router.handle(IPC.receiveFinish, async (payload) => {
    const body = expectObject(payload);
    await service.finishFile(leaseId(body), expectIndex(body["index"]));
    return { ok: true };
  });

  router.handle(IPC.receiveCancel, async (payload) => {
    const body = expectObject(payload);
    await service.cancelReceive(leaseId(body));
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Signalling
  // -------------------------------------------------------------------------

  /**
   * Which ICE reads this process holds. Bounds and lifetimes live in the
   * registry; this file only says WHEN a group ends.
   */
  const iceRequests = new IceRequestRegistry();

  const hub = new SignalingHub({
    origin,
    emit: (event: SignalingEvent, generation: number) => {
      // `emit` refuses an undeclared event name, a stale generation and a
      // destroyed WebContents. A close event for a document that already went
      // away is dropped here, which is correct: nothing is left to render it.
      router.emit(IPC_EVENTS.signalingEvent, generation, event);
    },
    // A room's socket ended, so anything main is still holding for that room
    // goes with it. An ICE read outliving its room is an answer with no
    // listener; the room cannot work without a socket either way.
    onRetire: (owner, generation) => iceRequests.abortRoom(generation, owner),
    ...(composition.makeSignalingSocket ? { factory: composition.makeSignalingSocket } : {}),
  });

  /** A room the renderer named, narrowed to a kind and a validated code. */
  const expectRoom = (value: unknown): SignalingRoom => {
    const room = expectObject(value);
    const kind = room["kind"];
    if (kind === "lan") return { kind: "lan" };
    if (kind !== "code") throw new IpcRefusal("unknown room kind");
    const code = expectString(room["code"], 16);
    // Validated HERE as well as in `signalingURL`, so a malformed code is
    // refused at the boundary rather than deep inside URL construction.
    if (!isWellFormedCode(code)) throw new IpcRefusal("malformed room code");
    return { kind: "code", code };
  };

  const socketToken = (body: Record<string, unknown>): string =>
    expectString(body["token"], MAX_SOCKET_TOKEN_LENGTH);

  const roomOwner = (body: Record<string, unknown>): string =>
    expectString(body["owner"], MAX_SOCKET_TOKEN_LENGTH);

  router.handle(IPC.signalingOpen, async (payload) => {
    const body = expectObject(payload);
    // The generation is read at the moment the socket is created, so a socket
    // opened by a document that is already being torn down is retired by the
    // same revocation that retired the document.
    hub.open(socketToken(body), roomOwner(body), expectRoom(body["room"]), router.generation);
    return { ok: true };
  });

  router.handle(IPC.signalingSend, async (payload) => {
    const body = expectObject(payload);
    // Bounded before the hub sees it. The hub's own UTF-8 byte check is the
    // authoritative one; this refuses an obviously absurd allocation earlier.
    hub.send(socketToken(body), expectString(body["frame"], MAX_SIGNALING_FRAME_BYTES));
    return { ok: true };
  });

  router.handle(IPC.signalingClose, async (payload) => {
    hub.close(socketToken(expectObject(payload)));
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // ICE control plane
  // -------------------------------------------------------------------------

  const ice = composition.makeIceControl ? composition.makeIceControl() : new IceControl(origin);

  router.handle(IPC.iceConfig, async (payload): Promise<IceReply> => {
    const body = expectObject(payload);
    const raw = body["code"];
    const code = raw === undefined || raw === "" ? undefined : expectString(raw, 16);
    const owner = roomOwner(body);

    // Admission happens BEFORE the request is made, and the lease is released
    // only when it settles — never when it is aborted. See `IceRequestRegistry`.
    const lease = iceRequests.admit(router.generation, owner);
    try {
      return await ice.read(code, lease.signal);
    } finally {
      lease.release();
    }
  });

  /**
   * Everything held on a retired document's behalf goes at once.
   *
   * ## Why the leases are here and not only in `dispose`
   *
   * Because `dispose` runs on `destroyed`, and a reload does not destroy
   * anything: the `WebContents` and its id survive, so a transfer started by
   * the previous document would keep an open file handle and staged bytes in
   * the user's folder with no page left to finish or cancel it. A crashed
   * renderer is the same shape and never sends a close for anything it held.
   * Hiding the window reaches none of this — it navigates nothing and kills
   * nothing — so a hidden window keeps receiving, which is the behaviour
   * R-RESIDENT depends on.
   *
   * Sockets and requests first, then leases: a socket left open would keep
   * delivering frames into `emit`, which would refuse them for a stale
   * generation — a refusal loop rather than a teardown.
   */
  /**
   * Revocation cleanups that have not settled yet.
   *
   * `onRevoke` is synchronous and there is no document left to report to, so
   * the cleanup is tracked and joined by `teardown` rather than dropped: a
   * failure to remove a user's staged bytes must surface somewhere, and this is
   * the last place it can.
   *
   * A `Set` that entries remove themselves from, not a growing array. A page
   * that reloads repeatedly would otherwise accumulate one settled promise per
   * reload in the privileged process, for the life of the app — small, but it
   * is exactly the unbounded-growth-on-the-renderer's-say-so shape every other
   * bound in this file exists to prevent.
   */
  const revocations = new Set<Promise<void>>();
  /** The first revocation failure seen, kept for `teardown` to surface. */
  let revocationFailure: unknown = null;

  router.onRevoke((retiring) => {
    hub.revoke(retiring);
    iceRequests.abortDocument(retiring);
    const cleanup = service.revokeDocument(retiring);
    revocations.add(cleanup);
    void cleanup
      .catch((err: unknown) => {
        if (revocationFailure === null) revocationFailure = err;
      })
      .finally(() => revocations.delete(cleanup));
  });

  // -------------------------------------------------------------------------
  // Receive
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Pairing code
  // -------------------------------------------------------------------------

  // No payload. The renderer asks for a code and names nothing.
  router.handle(IPC.pairCreate, () => service.createPairCode());

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  const preferences =
    composition.makePreferences ??
    (() => {
      const root = currentDataRoot();
      if (!root.ok) throw new IpcRefusal(`data root unavailable: ${root.reason}`);
      return new PreferenceStore(preferencesPath(root.path));
    });
  let preferenceStore: PreferenceStore | null = null;
  const prefs = (): PreferenceStore => (preferenceStore ??= preferences());

  // The snapshot, not just the values: a UI that shows a security preference
  // has to be able to say "this could not be read" rather than displaying the
  // default as though the user had chosen it.
  router.handle(IPC.prefsRead, () => prefs().snapshot());

  router.handle(IPC.prefsWrite, async (payload) => {
    const body = expectObject(payload);
    const key = body["key"];
    // A fixed list of names, not an arbitrary key/value store. A renderer that
    // could name the key could write anything into a file main later reads.
    if (!isPreferenceKey(key)) throw new IpcRefusal("unknown preference");
    const value = body["value"];
    if (typeof value !== "boolean") throw new IpcRefusal("expected a boolean");
    return prefs().write(key, value);
  });

  router.handle(IPC.receivePublish, async (payload) => {
    const body = expectObject(payload);
    const report = await service.publishReceive(leaseId(body));
    // Observed here, not reported by the page: "files were saved" is a fact
    // about what this process wrote, and a renderer that could assert it could
    // also assert it falsely.
    events.onPublished?.(report);
    return report;
  });

  // -------------------------------------------------------------------------
  // Resident commands, acknowledgements and snapshots
  // -------------------------------------------------------------------------

  let requestSeq = 0;
  /** Questions that have been asked and not yet answered or retired. */
  const outstanding = new Map<string, (ack: ResidentAck) => void>();
  let volunteered: ResidentSnapshot | null = null;

  /** The page's own numbers, bounded and shaped before anything believes them. */
  const narrowSnapshot = (value: unknown): ResidentSnapshot | null => {
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    const drafts = raw["drafts"];
    if (typeof raw["sending"] !== "boolean" || typeof raw["receiving"] !== "boolean") return null;
    if (typeof raw["nearby"] !== "boolean") return null;
    if (typeof drafts !== "number" || !Number.isInteger(drafts) || drafts < 0) return null;
    const locale = raw["locale"];
    return {
      sending: raw["sending"],
      receiving: raw["receiving"],
      // Clamped rather than refused: an implausible count still means "there is
      // unsent text", and the exact number is only ever used as a boolean.
      drafts: Math.min(drafts, MAX_RESIDENT_DRAFTS),
      // English is the fallback for anything else, which is also the product's
      // fallback everywhere else.
      locale: locale === "zh-Hans" ? "zh-Hans" : "en",
      nearby: raw["nearby"],
    };
  };

  router.handle(IPC.residentSnapshot, async (payload) => {
    const snapshot = narrowSnapshot(payload);
    // A malformed push does not overwrite what was last known to be true.
    if (snapshot !== null) {
      volunteered = snapshot;
      events.onLocale?.(snapshot.locale);
      events.onNearby?.(snapshot.nearby);
    }
    return { accepted: snapshot !== null };
  });

  router.handle(IPC.residentNotify, async (payload) => {
    const body = expectObject(payload);
    const kind = body["kind"];
    // A closed set. The page cannot supply a title, a body, a name or a count:
    // it names a KIND, and main writes every word the user sees.
    if (kind !== "saved-message" && kind !== "attention") {
      throw new IpcRefusal("unknown notice");
    }
    events.onNotice?.(kind);
    return { accepted: true };
  });

  // -------------------------------------------------------------------------
  // Start at sign-in
  // -------------------------------------------------------------------------

  // The real Windows setting, read fresh every time: the user can change it in
  // Task Manager while the app runs and nothing tells the app when they do.
  const loginItem: LoginItemSystem = composition.loginItem ?? {
    read: () => {
      const settings = app.getLoginItemSettings();
      return {
        openAtLogin: settings.openAtLogin === true,
        executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin === true,
      };
    },
    write: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
    reportFailure: (err) => events.reportFailure?.(err),
  };

  router.handle(IPC.loginItemRead, async (): Promise<LoginItemOutcome> => currentState(loginItem));

  router.handle(IPC.loginItemWrite, async (payload): Promise<LoginItemOutcome> => {
    const body = expectObject(payload);
    const enabled = body["enabled"];
    if (typeof enabled !== "boolean") throw new IpcRefusal("enabled must be a boolean");
    if (!enabled) return disable(loginItem);
    // Turning it ON changes the user's Windows startup programs, so it is
    // confirmed NATIVELY before anything is written — a renderer click is a
    // request, not consent for a system-wide setting.
    return enable(loginItem, async () =>
      (await events.confirmLoginItem?.()) === true ? "confirmed" : "declined",
    );
  });

  router.handle(IPC.residentAck, async (payload) => {
    const body = expectObject(payload);
    const requestId = expectString(body["requestId"], MAX_REQUEST_ID_LENGTH);
    const generation = body["generation"];
    // A reply from a document that has since been replaced answers nothing: the
    // page that asked to be told about is gone.
    if (typeof generation !== "number" || generation !== router.generation) {
      return { accepted: false };
    }
    const resolve = outstanding.get(requestId);
    // Unknown or already retired — a late or duplicate answer. Dropped, never
    // allowed to settle a question that has already been answered another way.
    if (!resolve) return { accepted: false };
    outstanding.delete(requestId);
    const snapshot = narrowSnapshot(body["snapshot"]);
    resolve({
      requestId,
      generation,
      ok: body["ok"] === true,
      ...(snapshot ? { snapshot } : {}),
    });
    return { accepted: true };
  });

  const resident: ResidentBridge = {
    async send(command, timeoutMs = RESIDENT_ACK_TIMEOUT_MS) {
      const requestId = `rq-${++requestSeq}`;
      const generation = router.generation;
      let settle!: (ack: ResidentAck) => void;
      const answered = new Promise<ResidentAck>((resolve) => {
        settle = resolve;
      });
      outstanding.set(requestId, settle);
      // A destroyed page, or one whose document already moved on, is unreachable
      // rather than slow — there is nothing to wait for.
      if (!router.emit(IPC_EVENTS.residentCommand, generation, { requestId, generation, command })) {
        outstanding.delete(requestId);
        return "unavailable";
      }
      const timer = setTimeout(() => {
        // Retired here, so an answer that arrives afterwards cannot turn an
        // unreachable page into a reassuring one.
        if (outstanding.delete(requestId)) settle({ requestId, generation, ok: false, failure: "stale" });
      }, timeoutMs);
      try {
        return await answered;
      } finally {
        clearTimeout(timer);
        outstanding.delete(requestId);
      }
    },
    lastSnapshot: () => volunteered,
    async freshSnapshot(timeoutMs = RESIDENT_ACK_TIMEOUT_MS) {
      const ack = await resident.send({ kind: "risk-snapshot" }, timeoutMs);
      if (ack === "unavailable" || !ack.ok || !ack.snapshot) return "unknown";
      return ack.snapshot;
    },
  };

  // A document that goes away takes its outstanding questions with it: they are
  // failed, not left to time out into an answer nobody is waiting for.
  router.onRevoke(() => {
    volunteered = null;
    for (const [requestId, resolve] of [...outstanding]) {
      outstanding.delete(requestId);
      resolve({ requestId, generation: router.generation, ok: false, failure: "stale" });
    }
  });

  const quiesce = async (): Promise<CleanupOutcome> => {
    // Main's own network first: a socket left open is a room this app is still
    // in, and an ICE read in flight is a request still outstanding against the
    // control plane. Neither is visible to the page.
    //
    // ASKED, then JOINED, and the two are different things. `closeAll` and
    // `abortAll` request; the drains below wait for the close to be observed
    // and for the aborted reads to settle. Whatever is still outstanding at the
    // deadline is COUNTED — not waited for forever, and not called finished.
    hub.closeAll();
    iceRequests.abortAll();
    const [sockets, reads] = await Promise.all([
      hub.drainClosing(NETWORK_DRAIN_MS),
      iceRequests.drain(NETWORK_DRAIN_MS),
    ]);

    // Then the leases, the sign-in, the queued transitions and the secret work.
    const outcome = await service.quiesce();

    // And the revocation failure the teardown remembers: it is rethrown by
    // `dispose`, so a quiesce that did not mention it would let a "nothing left
    // to decide" path walk into a failing final teardown.
    const revocation = revocationFailure === null ? null : reasonOf(revocationFailure);
    return {
      ...outcome,
      networkUnsettled: sockets + reads,
      firstReason: outcome.firstReason ?? revocation,
      unresolved: outcome.unresolved + (revocation !== null ? 1 : 0),
    };
  };

  const teardown = async (): Promise<void> => {
    // Sockets and requests are main's own resources and are dropped
    // unconditionally; the service owns the leases and reports its own
    // failures, which must still surface.
    hub.closeAll();
    iceRequests.abortAll();
    // Joined before disposing, and its failures surfaced after: a revocation
    // that could not clean up a previous document's staged bytes is a real
    // failure with no renderer left to hear it, and swallowing it here would be
    // the last place it could have been reported.
    await Promise.allSettled([...revocations]);
    await service.dispose();
    if (revocationFailure !== null) throw revocationFailure;
  };

  // Destroying the window is one of the two ways this app ends; `before-quit`
  // is the other. Both must reach the same teardown.
  window.webContents.once("destroyed", () => {
    void teardown().catch(() => undefined);
  });

  return { service, resident, quiesce, preferences: prefs, dispose: teardown };
}
