// Electron wiring. All policy lives in `app-service.ts`; this file narrows
// untrusted payloads and hands them on.
//
// The split is deliberate: rules that only exist inside an `ipcMain.handle`
// closure cannot be tested, and the rules here are the ones a race would break.

import { app, clipboard, dialog, shell, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import {
  IPC,
  IPC_EVENTS,
  MAX_ATTEMPT_NONCE_LENGTH,
  MAX_IPC_CHUNK_BYTES,
  MAX_REQUEST_ID_LENGTH,
  MAX_INBOX_DEVICE_NAME_LENGTH,
  MAX_INBOX_ID_LENGTH,
  MAX_SEND_ENTRIES,
  MAX_SEND_FRAME_BYTES,
  MAX_SEND_PATH_LENGTH,
  MAX_RESIDENT_DRAFTS,
  MAX_STORED_LINK_LENGTH,
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
import { StoredReceiveService, type StoredReceiveDeps } from "./features/stored-receive.js";
import { InboxService, type InboxServiceDeps } from "./features/inbox.js";
import { AccountIdentity } from "./features/account-identity.js";
import { StoredSendService, type StoredSendDeps } from "./features/stored-send.js";
import { InboxSendService, type InboxSendDeps } from "./features/inbox-send-service.js";
import { AccountSummaryService, type AccountSummaryDeps } from "./features/account-summary.js";
import { isAccountExternalTarget } from "../shared/account-summary.js";
import { DeviceAuthClient } from "./account/device-auth.js";
import { ENGINEERING_BANNER, engineeringOverride, isEngineeringBuild } from "./build-mode.js";
import { IceControl, IceRequestRegistry } from "./net/ice-control.js";
import { PairControl } from "./net/pair-control.js";
import { catalogFor, counter, type Locale, type Translate, type TranslateCount } from "./l10n.js";
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
   * The language the native dialogs opened here are written in.
   *
   * A function, read when a dialog opens rather than captured once: the window
   * reports its own catalogue after startup, and a value taken at registration
   * would be the OS guess forever. `main.ts` supplies the resident runtime's
   * current locale; absent, English — the declared fallback.
   */
  locale?: () => Locale;
  /** Stored receive seams: the object source, the destination factory and the
   *  shared-protocol runtime. Injection only, like every other one here. */
  storedReceive?: Pick<StoredReceiveDeps, "receive" | "transport" | "destination" | "runtime" | "hosts" | "cleanups">;
  /**
   * Device Inbox seams: the shared-protocol runtime, the authenticated client,
   * the device-row lookup, the folder probe and the receive destination.
   *
   * The same kind of injection as every other entry here and for the same
   * reason: an automated run has to be able to drive consent, enrolment,
   * a pending delivery and an account change without a live server or a person
   * at a folder dialog. Nothing here is reachable from the renderer or from the
   * environment, and none of it widens what the shipped path does.
   */
  inbox?: Pick<
    InboxServiceDeps,
    /** Substituted so a run can observe a reveal without opening Explorer. */
    | "revealDirectory"
    | "runtime"
    | "makeApi"
    | "makeDestination"
    | "resolveDevice"
    | "directoryUsable"
    | "backoff"
    | "now"
    /** Substituted so a run can read back the bytes a copy actually wrote. */
    | "writeClipboard"
    /** A task-owned root, so a run does not write into the user's profile —
     *  and so this feature is drivable on a host that is not Windows. */
    | "dataRoot"
  >;
  /**
   * Stored send seams: the upload transport, the metadata reader and the
   * shared-protocol runtime.
   *
   * The same injection discipline as everything else here. What it exists for
   * is an acceptance run that drives the REAL producer — the renderer's own
   * `encryptFiles` — against a loopback server and reads the ciphertext back,
   * which is the only way to prove the frames are the shared format.
   */
  storedSend?: NonNullable<StoredSendDeps["upload"]>;
  /**
   * Device Inbox SEND seams: the two protocol runtimes and the HTTP.
   *
   * The same injection discipline, for the same acceptance need: a run has to
   * drive the REAL producer — the renderer's own `encryptFiles` — and the real
   * task/upload requests against a controlled sink, without a live account. The
   * origin, the authority and the account identity are NOT in this `Pick` and
   * cannot be replaced from here.
   */
  inboxSend?: Pick<InboxSendDeps, "runtime" | "storedRuntime" | "fetchImpl" | "requestTimeoutMs" | "now">;
  /**
   * Account seams: the read client and its HTTP.
   *
   * The origin, the account authority and the document generation are NOT in
   * this `Pick` and cannot be replaced from here.
   */
  accountSummary?: Pick<AccountSummaryDeps, "makeClient" | "fetchImpl" | "timeoutMs" | "quiesceTimeoutMs">;
  /** A task-owned journal directory, so a run does not write into the user's
   *  profile — and so send is drivable on a host that is not Windows. */
  storedSendJournalDirectory?: string;
  /**
   * Whether the Inbox scheduler starts with the process.
   *
   * Present so a test that composes no Inbox seams does not have a scheduler
   * making real requests behind it. A shipped build always starts: the loop is
   * what makes receiving resident, and its first act on a signed-out or
   * unconsented profile is to park at a guard.
   */
  startInbox?: boolean;
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
  /** Stored receive, for the resident runtime's risk and teardown. */
  readonly storedReceive: StoredReceiveService;
  /** The Device Inbox scheduler, for the same risk snapshot and teardown. */
  readonly inbox: InboxService;
  /** Stored send, for the same risk snapshot and teardown. */
  readonly storedSend: StoredSendService;
  /** Device Inbox send, for the same risk snapshot and teardown. */
  readonly inboxSend: InboxSendService;
  /** The account screen's reader, for the quit risk snapshot and teardown. */
  readonly accountSummary: AccountSummaryService;
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
   * Stop admitting new work, everywhere, without stopping anything.
   *
   * The partner of `resume`, and the reason it is one call: a quit fences,
   * then ASKS — the page for an acknowledgement, then a human, for as long as
   * they take. A caller that fenced only the lease service left every other
   * feature admitting through that window, so the risk the prompt described
   * was not the risk that was quit over. Synchronous, so nothing can be
   * admitted between the fences.
   */
  readonly fence: () => void;
  /**
   * The user stayed. Everything that was fenced becomes usable again.
   *
   * One place, because there is more than one thing to resume: the lease
   * service, its admission fence, and stored receive. A caller that resumed
   * only what it happened to know about left the others refusing forever —
   * which is exactly what happened to stored receive.
   */
  readonly resume: () => void;
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

  // Looked up per call, so a dialog follows the language the window changed to.
  const dialogLocale = (): Locale => composition.locale?.() ?? "en";
  const t: Translate = (key) => catalogFor(dialogLocale())[key];
  /** The counted keys, formatted by the catalog that owns the word order. */
  const tc: TranslateCount = (key, count) => counter(dialogLocale())(key, count);

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
        title: t("native.receive.pickTitle"),
        buttonLabel: t("native.receive.pickConfirm"),
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
  // Stored receive
  // -------------------------------------------------------------------------

  const storedReceive = new StoredReceiveService({
    ...(composition.storedReceive ?? {}),
    // The native folder picker, asked only after the manifest is judged — so a
    // dialog never opens for a transfer that is going to be refused, and the
    // renderer never names a destination.
    pickDestination: async (facts, job) => {
      // The job's OWN document names the authority, not whichever document is
      // current when the dialog closes: a grant is authority the document that
      // asked gave, and a reload replaces that document rather than inheriting
      // what it authorised.
      const authorityId = `stored-${String(job.document)}`;
      if (composition.pickDirectory) {
        const chosen = await composition.pickDirectory();
        return chosen === null ? null : { rootPath: chosen, authorityId };
      }
      const picked = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        // The count comes from the VALIDATED manifest, and this dialog is
        // where the user authorises the write. Windows has no facts surface
        // before it yet, so the number belongs here rather than nowhere.
        title: tc("native.download.pickTitle", facts.fileCount),
        buttonLabel: t("native.download.pickConfirm"),
      });
      const rootPath = picked.canceled ? null : (picked.filePaths[0] ?? null);
      return rootPath === null ? null : { rootPath, authorityId };
    },
    // Emitted on the generation the job STARTED under, which `emit` then
    // compares against the current one. Reading `router.generation` here instead
    // asked "is there a document?" when the question is "is it still the one
    // that asked?" — so a reload's replacement received the retired document's
    // progress and its final outcome. The job-id fence in the controller does
    // not close it: a freshly mounted controller has no id to mismatch.
    onProgress: (job, received, total) => {
      // Counts only, and dropped when the document that asked is gone.
      router.emit(IPC_EVENTS.storedProgress, job.document, { jobId: job.id, received, total });
    },
    onOutcome: (job, outcome) => {
      router.emit(IPC_EVENTS.storedOutcome, job.document, { jobId: job.id, outcome });
    },
  });

  router.handle(IPC.storedReceiveStart, async (payload) => {
    const body = expectObject(payload);
    // Shaped and bounded before anything is parsed or fetched. The link is NOT
    // logged, echoed or retained here.
    const link = expectString(body["link"], MAX_STORED_LINK_LENGTH);
    const started = storedReceive.start({
      link,
      // Document only. A public link download is anonymous — see
      // `StoredReceiveAuthority`, and the Mac composition it mirrors.
      authority: { document: router.generation },
    });
    if ("refusal" in started) return { ok: false, refusal: started.refusal };
    // Returns as soon as the job is ADMITTED, not when it ends. The id is what
    // progress is matched against and what Cancel names; a page that only got
    // it at the end could do neither.
    //
    // The outcome is handled here rather than awaited: it is pushed as an event
    // by the service, and remembered for a page that missed it.
    void started.outcome.catch(() => undefined);
    return { ok: true, jobId: started.jobId };
  });

  router.handle(IPC.storedReceiveResult, async (payload) => {
    const body = expectObject(payload);
    return { result: storedReceive.result(expectString(body["jobId"], 64)) };
  });

  router.handle(IPC.storedReceiveCancel, async (payload) => {
    const body = expectObject(payload);
    return { cancelled: storedReceive.cancel(expectString(body["jobId"], 64)) };
  });

  router.handle(IPC.storedInventory, async () => storedReceive.inventory());

  router.handle(IPC.storedCleanupRetry, async (payload) => {
    const body = expectObject(payload);
    return storedReceive.retryCleanup(expectString(body["ticket"], 64));
  });

  // -------------------------------------------------------------------------
  // Device Inbox — receive
  // -------------------------------------------------------------------------

  const inbox = new InboxService({
    origin,
    // The host's OWN data root. There is no payload, argument or environment
    // value on any path below that can move it — and it is resolved on first
    // use, because it can fail and a registration that threw here would take
    // the whole app down rather than one feature.
    dataRoot: () => {
      const root = currentDataRoot();
      if (!root.ok) throw new IpcRefusal(`data root unavailable: ${root.reason}`);
      return root.path;
    },
    platform: "windows",
    appVersion: process.env["npm_package_version"] ?? "0.0.1",
    authority: () => service.captureAccountAuthority(),
    accountEpoch: () => service.accountEpoch,
    // Read at the moment a copy is admitted and re-checked before it writes.
    // Nothing else in this feature consults it: a reload must not stop
    // receiving, which is the whole point of the scheduler being main's.
    currentDocument: () => router.generation,
    grantSlot: () => service.secretStore(),
    keySlot: () => service.secretStore(),
    // The user names the destination, in a native dialog, and the dialog is the
    // consent. There is no IPC channel in this app that carries a path.
    async pickDirectory() {
      if (composition.pickDirectory) return composition.pickDirectory();
      const picked = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        title: t("native.inbox.pickTitle"),
        buttonLabel: t("native.inbox.pickConfirm"),
      });
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    // ## Emitted on the CURRENT document, unlike stored progress
    //
    // A stored progress frame answers a request some document made, so it is
    // emitted on the generation that asked and a replacement never sees it.
    // This is a fact about MAIN — receiving is on, a folder is missing,
    // something is waiting — that no document requested and every document
    // needs. It carries no authority: counts and closed codes only, and
    // `hasDestination` rather than a destination.
    onState: (view) => {
      router.emit(IPC_EVENTS.inboxState, router.generation, view);
    },
    reportFailure: (err) => events.reportFailure?.(err),
    // The system clipboard, written by MAIN. There is no channel that takes a
    // string and puts it there: the only caller reads a message this account
    // has already received. `window.ts` denies every renderer permission —
    // including the clipboard — and that policy stays exactly as it is.
    writeClipboard: (text) => clipboard.writeText(text),
    // Main performs it, on a path main holds. `openPath` shows the folder;
    // it opens nothing inside it and takes nothing from the page.
    revealDirectory: async (directory) => {
      await shell.openPath(directory);
    },
    // LAST, so an injected seam actually wins. Spread first — the shape the
    // stored-receive composition uses, where the keys are disjoint — the
    // defaults above would silently override every one of them, and a run that
    // thought it was driving its own data root and its own device lookup would
    // be driving the shipped ones. The `Pick` on `HandlerComposition["inbox"]`
    // is what keeps this narrow: `origin`, the authority and the folder dialog
    // are not in it and cannot be replaced from here.
    ...(composition.inbox ?? {}),
  });
  // Started here rather than lazily on the page's first request, because the
  // whole point of it is that it runs when nobody is looking at the Inbox page
  // — or at any page. A signed-out or unconsented profile parks at a guard.
  if (composition.startInbox !== false) inbox.start();

  // -------------------------------------------------------------------------
  // Device Inbox — send
  // -------------------------------------------------------------------------
  //
  // Composed against the RECEIVE feature's own account seam rather than against
  // a second derivation of the account identity: a send plan lives in the same
  // per-account directory as the journal and the vault, under the same digest.
  const inboxComposition = inbox.composition();
  const inboxSend = new InboxSendService({
    origin,
    authority: () => service.captureAccountAuthority(),
    accountEpoch: () => service.accountEpoch,
    identity: () => inboxComposition.identity(),
    atRestKeyFor: (context) => inboxComposition.atRestKeyFor(context),
    runtime: () => inboxComposition.runtime(),
    // The document that ASKED owns the job. One document, one job.
    currentDocument: () => router.generation,
    onProgress: (job, committed, total) => {
      // Emitted on the document that asked, never whichever is current: a
      // reload replaces the page rather than inheriting the delivery it began.
      router.emit(IPC_EVENTS.inboxSendProgress, job.document, { jobId: job.id, committed, total });
    },
    onOutcome: (job, view) => {
      router.emit(IPC_EVENTS.inboxSendOutcome, job.document, { jobId: job.id, outcome: view });
    },
    reportFailure: (err) => events.reportFailure?.(err),
    ...(composition.inboxSend ?? {}),
  });

  /** One target device. Central's id; never a key and never a name. */
  const inboxTarget = (payload: unknown): string =>
    expectString(expectObject(payload)["target"], MAX_INBOX_ID_LENGTH);
  const inboxSendJob = (payload: unknown): string => expectString(expectObject(payload)["jobId"], 64);

  router.handle(IPC.inboxSendTargets, () => inboxSend.targets());
  router.handle(IPC.inboxSendStart, async (payload) => {
    const body = expectObject(payload);
    const kind = body["kind"];
    // A closed set, checked here: `buildSendManifest` branches on it, and a
    // third value would reach the manifest builder as an unhandled case.
    if (kind !== "file" && kind !== "text") throw new IpcRefusal("unknown delivery kind");
    return inboxSend.start({
      target: inboxTarget(body),
      kind,
      entries: sendDescriptors(body["entries"]),
      document: router.generation,
    });
  });
  router.handle(IPC.inboxSendFeed, async (payload) => {
    const body = expectObject(payload);
    // Bounded before anything is allocated. The engine checks the EXACT length
    // it expects; this refuses an absurd one at the boundary.
    return inboxSend.feed(expectString(body["jobId"], 64), {
      fileIndex: expectIndex(body["fileIndex"]),
      seq: expectIndex(body["seq"]),
      bytes: expectChunk(body["bytes"], MAX_SEND_FRAME_BYTES),
    });
  });
  router.handle(IPC.inboxSendEnd, (payload) => inboxSend.end(inboxSendJob(payload)));
  router.handle(IPC.inboxSendCancel, (payload) => inboxSend.cancel(inboxSendJob(payload)));
  router.handle(IPC.inboxSendConverge, (payload) => inboxSend.converge(inboxSendJob(payload)));

  // -------------------------------------------------------------------------
  // Account — profile, usage and this account's devices
  // -------------------------------------------------------------------------
  //
  // The READ is main's, not the page's: the service registers its own account
  // watcher and re-reads on a change, so the view a page renders on arrival is
  // one main already holds. Nothing here buys, upgrades or cancels anything —
  // the whole outbound journey is a fixed path on this build's own origin,
  // named by a closed token and composed HERE.
  const accountSummary = new AccountSummaryService({
    origin,
    // Satisfied directly by `AppService`; a signature change to any of the four
    // members is a compile error here rather than a runtime shape mismatch.
    account: service,
    // The document that asked owns a mutation, so a confirmation given on a
    // page that has since reloaded cannot submit.
    currentDocument: () => router.generation,
    onView: (view) => {
      router.emit(IPC_EVENTS.accountSummary, router.generation, view);
    },
    reportFailure: (err) => events.reportFailure?.(err),
    ...(composition.accountSummary ?? {}),
  });
  // Construction publishes only the initial loading view, so the first real
  // read is asked for here. Not awaited: a registration that waited on the
  // network would delay every other channel behind it.
  void accountSummary.refresh().catch((err: unknown) => events.reportFailure?.(err));

  router.handle(IPC.accountSummaryState, async () => accountSummary.view());
  router.handle(IPC.accountSummaryRefresh, async (payload) => {
    const section = expectObject(payload)["section"];
    if (section === undefined) return accountSummary.refresh();
    // A closed set. A named section is how ONE failed card retries without
    // disturbing the two beside it that succeeded.
    if (section !== "profile" && section !== "usage" && section !== "devices") {
      throw new IpcRefusal("unknown account section");
    }
    await (section === "profile"
      ? accountSummary.refreshProfile()
      : section === "usage"
        ? accountSummary.refreshUsage()
        : accountSummary.refreshDevices());
    return accountSummary.view();
  });
  router.handle(IPC.accountDeviceRename, (payload) => {
    const body = expectObject(payload);
    // The generation is read HERE, where the request arrives, so the mutation
    // carries the document that asked rather than whichever one is current by
    // the time the server answers.
    return accountSummary.renameDevice(
      router.generation,
      expectString(body["id"], MAX_INBOX_ID_LENGTH),
      expectString(body["name"], MAX_INBOX_DEVICE_NAME_LENGTH),
    );
  });
  router.handle(IPC.accountDeviceRevoke, (payload) =>
    accountSummary.revokeDevice(router.generation, expectString(expectObject(payload)["id"], MAX_INBOX_ID_LENGTH)),
  );
  // A closed TOKEN, never a URL. A channel that took an address from a page
  // would be script-triggered navigation carrying the user's real session.
  router.handle(IPC.accountManage, async (payload) => {
    const target = expectObject(payload)["target"];
    if (!isAccountExternalTarget(target)) throw new IpcRefusal("unknown account target");
    const url = accountSummary.externalUrl(target);
    if (url === null) return { ok: false };
    return { ok: await openApprovedExternal(url, origin) };
  });

  // The account moved. The service compares the epoch itself, because this also
  // fires for a document change and a reload must not stop receiving.
  const releaseAccountWatch = service.onAccountChanged(() => {
    inbox.onAuthorityChanged();
    // A delivery in flight under the previous account's bearer is revoked and
    // JOINED. Not awaited here: this callback is synchronous and the watcher
    // must not be held by a network drain.
    void inboxSend.onAccountChanged().catch((err: unknown) => events.reportFailure?.(err));
  });

  /** A task or vault id the renderer named. It names; it authorises nothing. */
  const inboxId = (payload: unknown): string =>
    expectString(expectObject(payload)["id"], MAX_INBOX_ID_LENGTH);

  router.handle(IPC.inboxState, async () => inbox.view());
  router.handle(IPC.inboxEnable, () => inbox.enable());
  router.handle(IPC.inboxDisable, () => inbox.disable());
  router.handle(IPC.inboxChooseFolder, () => inbox.chooseFolder());
  router.handle(IPC.inboxPending, () => inbox.refreshPending());
  router.handle(IPC.inboxAccept, (payload) => inbox.accept(inboxId(payload)));
  router.handle(IPC.inboxReject, (payload) => inbox.reject(inboxId(payload)));
  router.handle(IPC.inboxMessages, () => inbox.messages());
  router.handle(IPC.inboxOpenMessage, (payload) => inbox.openMessage(inboxId(payload)));
  // The generation is read HERE, where the request arrives, so the copy carries
  // the document that asked rather than whichever one is current when the vault
  // read comes back.
  router.handle(IPC.inboxCopyMessage, (payload) => inbox.copyMessage(inboxId(payload), router.generation));
  router.handle(IPC.inboxDeleteMessage, (payload) => inbox.deleteMessage(inboxId(payload)));
  router.handle(IPC.inboxRename, (payload) => {
    const body = expectObject(payload);
    // Bounded here and normalised by the shared runtime inside the facade; the
    // SERVER judges whether the name is acceptable, and its refusal is what the
    // page renders. This boundary only refuses an absurd allocation.
    return inbox.rename(expectString(body["name"], MAX_INBOX_DEVICE_NAME_LENGTH));
  });
  router.handle(IPC.inboxWake, async () => {
    inbox.wake();
    return { ok: true };
  });
  router.handle(IPC.inboxSetPolicy, (payload) => {
    const body = expectObject(payload);
    const policy = body["policy"];
    // A closed set of three. The renderer names one; it cannot invent a fourth.
    if (policy !== "off" && policy !== "ask" && policy !== "auto") {
      throw new IpcRefusal("unknown inbox policy");
    }
    return inbox.setPolicy(policy);
  });
  // The generation is read HERE, so the reveal carries the document that asked.
  router.handle(IPC.inboxRevealFolder, () => inbox.revealFolder(router.generation));
  router.handle(IPC.inboxReceipts, async () => ({ entries: await inbox.receipts() }));
  // `null` is "could not be read", not "empty" — carried across as such so the
  // page can say the names are unavailable rather than claiming nothing has
  // ever arrived. The counts in `inboxReceipts` are unaffected by it.
  router.handle(IPC.inboxHistory, async () => ({ entries: await inbox.history() }));
  router.handle(IPC.inboxForgetDelivery, (payload) => inbox.forgetDelivery(inboxId(payload)));

  router.handle(IPC.inboxReleaseRetained, (payload) => {
    const body = expectObject(payload);
    // An opaque key the service issued, never a path.
    return inbox.releaseRetained(expectString(body["key"], MAX_INBOX_ID_LENGTH));
  });

  // -------------------------------------------------------------------------
  // Stored send and history
  // -------------------------------------------------------------------------

  /**
   * ONE device identity for both account-owned features.
   *
   * The Inbox is ADDRESSED by it and stored send SCOPES ITS JOURNAL by it, so
   * two independent resolutions would be two values that merely usually agree —
   * and the day they did not, a user's send history would be filed under an
   * account their inbox was not. Resolved once per epoch, shared here.
   */
  const identity = new AccountIdentity({
    origin,
    // The SAME injected lookup the Inbox uses, when one is supplied. Two
    // resolvers would be two identities, and a run that injected one for the
    // Inbox while stored send reached the real network is a run where send
    // refuses for a reason that has nothing to do with sending.
    ...(composition.inbox?.resolveDevice ? { resolve: composition.inbox.resolveDevice } : {}),
  });

  /**
   * The account authority a send is admitted under.
   *
   * Reads the credential and resolves the device row, both under the epoch that
   * was current when it started. The BEARER goes to the engine and nowhere
   * else; nothing here publishes it, and no channel returns it.
   */
  const sendAuthority: StoredSendDeps["authority"] = async () => {
    const captured = await service.captureAccountAuthority();
    if (captured.kind !== "ok") return { kind: captured.kind };
    try {
      const device = await identity.resolve(
        captured.bearer,
        captured.epoch,
        AbortSignal.timeout(20_000),
      );
      // Re-checked after the lookup: an answer that arrived after an account
      // change describes an account that has gone away.
      if (service.accountEpoch !== captured.epoch) return { kind: "unavailable" };
      return {
        kind: "ok",
        authority: {
          // The same scoping value the Inbox uses. See `AccountIdentity`.
          accountId: device.id,
          deviceId: device.id,
          bearer: captured.bearer,
          epoch: captured.epoch,
        },
      };
    } catch {
      return { kind: "unavailable" };
    }
  };

  const storedSend = new StoredSendService({
    origin,
    authority: sendAuthority,
    accountEpoch: () => service.accountEpoch,
    async options() {
      // The injected directory is consulted FIRST, and the host root is
      // resolved only when there is none. Resolving it unconditionally threw on
      // every host that is not Windows — so an injected, task-owned journal was
      // accepted and then never reached, and every send refused as `internal`
      // for a reason that had nothing to do with the send.
      const journalDirectory =
        composition.storedSendJournalDirectory ??
        (() => {
          const root = currentDataRoot();
          if (!root.ok) throw new IpcRefusal(`data root unavailable: ${root.reason}`);
          return `${root.path}/uploads`;
        })();
      return {
        secrets: await service.secretStore(),
        journalDirectory,
        ...(composition.storedSend ?? {}),
      };
    },
    onProgress: (job, committed, total) => {
      // The document that ASKED, never whichever one is current: a reload
      // replaces the page rather than inheriting the upload it started.
      router.emit(IPC_EVENTS.storedSendProgress, job.document, {
        jobId: job.id,
        committed,
        total,
      });
    },
    onOutcome: (job, outcome) => {
      router.emit(IPC_EVENTS.storedSendOutcome, job.document, { jobId: job.id, outcome });
    },
    reportFailure: (err) => events.reportFailure?.(err),
    // The clipboard, written by MAIN. See the contract's note: there is no
    // channel that takes a string and puts it there.
    writeClipboard: (text) => clipboard.writeText(text),
    currentDocument: () => router.generation,
  });

  // The Inbox resolves the SAME identity, through the same cache.
  /**
   * What the page was last told about the account.
   *
   * BOTH the epoch and whether a credential is actually held, because a
   * sign-in changes the second without changing the first. `AppService.adopt`
   * notifies watchers twice under one epoch — once at the start, before the
   * bearer is written, and again once it is durable — and only the second
   * notification means "there is an account to read history for". Comparing the
   * epoch alone discarded it, so a page that signed in kept showing an empty
   * history until something else happened to refresh it.
   */
  let lastSendAccount = { epoch: service.accountEpoch, signedIn: false };
  const releaseSendAccountWatch = service.onAccountChanged(() => {
    const epoch = service.accountEpoch;
    if (identity.known(epoch) === null) identity.invalidate();
    void storedSend.onAccountChanged().catch((err: unknown) => events.reportFailure?.(err));
    void (async () => {
      const captured = await service.captureAccountAuthority();
      const signedIn = captured.kind === "ok";
      if (epoch === lastSendAccount.epoch && signedIn === lastSendAccount.signedIn) return;
      lastSendAccount = { epoch, signedIn };
      // The page decides what to do with it: a DIFFERENT epoch means drop the
      // previous account's links and history, and the same epoch newly signed
      // in means read the history that is now available. A document change
      // reaches neither, which is why receiving and an in-flight send survive
      // a reload.
      router.emit(IPC_EVENTS.storedSendAccount, router.generation, { epoch, signedIn });
    })().catch((err: unknown) => events.reportFailure?.(err));
  });

  /** One entry the user picked. A relative path the RENDERER already holds —
   *  it names a file inside what the user chose, and grants nothing. */
  const sendDescriptors = (value: unknown): { path: string; size: number }[] => {
    if (!Array.isArray(value) || value.length === 0) throw new IpcRefusal("expected entries");
    if (value.length > MAX_SEND_ENTRIES) throw new IpcRefusal("too many entries");
    return value.map((entry) => {
      const e = expectObject(entry);
      return {
        path: expectString(e["path"], MAX_SEND_PATH_LENGTH),
        size: expectIndex(e["size"]),
      };
    });
  };

  router.handle(IPC.storedSendStart, async (payload) => {
    const body = expectObject(payload);
    const retention = expectObject(body["retention"]);
    const burn = retention["burnAfterRead"];
    if (typeof burn !== "boolean") throw new IpcRefusal("expected a boolean");
    return storedSend.start(
      sendDescriptors(body["entries"]),
      { burnAfterRead: burn, ttlSeconds: expectIndex(retention["ttlSeconds"]) },
      router.generation,
    );
  });

  router.handle(IPC.storedSendFeed, async (payload) => {
    const body = expectObject(payload);
    // Bounded before anything is allocated. The engine checks the exact length
    // it expects; this refuses an absurd one at the boundary.
    return storedSend.feed(expectString(body["jobId"], 64), {
      fileIndex: expectIndex(body["fileIndex"]),
      seq: expectIndex(body["seq"]),
      bytes: expectChunk(body["bytes"], MAX_SEND_FRAME_BYTES),
    });
  });

  const sendJob = (payload: unknown): string => expectString(expectObject(payload)["jobId"], 64);

  router.handle(IPC.storedSendEnd, (payload) => storedSend.end(sendJob(payload)));
  router.handle(IPC.storedSendCancel, (payload) => storedSend.cancel(sendJob(payload)));
  // `null` is "could not be read", not "empty". Carried across as such so the
  // page can say so rather than claiming the user has never sent anything.
  router.handle(IPC.storedSendHistory, async () => ({ entries: await storedSend.history() }));
  router.handle(IPC.storedSendLink, async (payload) => ({ link: await storedSend.link(sendJob(payload)) }));
  router.handle(IPC.storedSendDelete, async (payload) => ({
    result: await storedSend.remove(sendJob(payload)),
  }));
  router.handle(IPC.storedSendReconcile, (payload) => storedSend.reconcile(sendJob(payload)));
  // The generation is read HERE, where the request arrives, so the copy carries
  // the document that asked rather than whichever one is current when the link
  // has been composed.
  router.handle(IPC.storedSendCopyLink, async (payload) => ({
    result: await storedSend.copyLink(sendJob(payload), router.generation),
  }));

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
  router.onRevoke((generation) => {
    // The document that asked is gone: its receives are aborted synchronously
    // and joined, exactly as its leases and sockets are.
    revocations.add(storedReceive.revokeDocument(generation));
    // A send genuinely belongs to its page: the page holds the `File` objects
    // and produces the ciphertext, so a document that is gone cannot finish
    // what it started. Receiving is the opposite and is deliberately untouched.
    revocations.add(storedSend.revokeDocument(generation));
    // The same rule for an Inbox delivery, and for the same reason: the page
    // holds the `File` objects and produces the ciphertext, so a document that
    // is gone cannot finish what it started. RECEIVING is deliberately
    // untouched — it is main's, and surviving a reload is the point of it.
    revocations.add(inboxSend.revokeDocument(generation));
    volunteered = null;
    for (const [requestId, resolve] of [...outstanding]) {
      outstanding.delete(requestId);
      resolve({ requestId, generation: router.generation, ok: false, failure: "stale" });
    }
  });

  /**
   * Every admission fence in this registration, set in one synchronous run.
   *
   * Listed here rather than at the call site so a feature added later is
   * fenced by editing the thing whose job that is. `resume` below is its exact
   * inverse and has to stay that way.
   */
  const fence = (): void => {
    service.fenceReceives();
    storedReceive.fence();
    inbox.fence();
    storedSend.fence();
    inboxSend.fence();
    // Mutations only. An explicit READ stays open on purpose: a screen frozen
    // mid-question is worse than one still reading.
    accountSummary.fence();
  };

  const quiesce = async (): Promise<CleanupOutcome> => {
    // ## Everything is ASKED to stop before anything is JOINED
    //
    // Admission first, and synchronously: a fence set after a 1.5s network
    // drain is a 1.5s window in which a page could start the very transfer
    // this is tearing down.
    //
    // Then the requests. `closeAll` and `abortAll` ask; `storedReceive.quiesce`
    // aborts every receive before its own first await, so starting it here and
    // joining it below stops those transfers now rather than after the drains.
    // A socket left open is a room this app is still in, and an ICE read in
    // flight is a request still outstanding against the control plane; neither
    // is visible to the page.
    //
    // Only then the joins. Whatever is still outstanding at the deadline is
    // COUNTED — not waited for forever, and not called finished.
    fence();
    hub.closeAll();
    iceRequests.abortAll();
    const storedStopping = storedReceive.quiesce();
    // Aborts its pass and every operation before its own first await, so
    // starting it here and joining it below stops the scheduler NOW rather
    // than after the network drains.
    const inboxStopping = inbox.quiesce();
    // Revokes every job's fence before its own first await, so starting it here
    // and joining it below stops the uploads NOW.
    const sendStopping = storedSend.quiesce();
    // The same, for a delivery to one of the user's own devices: the producers
    // are abandoned before the drain, so a page that has been told to stop
    // cannot leave the join waiting for frames nobody will send.
    const inboxSendStopping = inboxSend.quiesce();
    // Stronger than its fence on purpose: this has already reported an
    // inventory, and anything admitted afterwards would make that report untrue.
    const accountStopping = accountSummary.quiesce();
    // The leases, the sign-in, the queued transitions and the secret work. It
    // retires the in-flight sign-in before ITS first await too, so this is a
    // request as much as a join.
    const serviceStopping = service.quiesce();

    const [sockets, reads, storedHeld, inboxHeld, sendHeld, inboxSendHeld, accountHeld, outcome] = await Promise.all([
      hub.drainClosing(NETWORK_DRAIN_MS),
      iceRequests.drain(NETWORK_DRAIN_MS),
      storedStopping,
      inboxStopping,
      sendStopping,
      inboxSendStopping,
      accountStopping,
      serviceStopping,
    ]);

    // And the revocation failure the teardown remembers: it is rethrown by
    // `dispose`, so a quiesce that did not mention it would let a "nothing left
    // to decide" path walk into a failing final teardown.
    const revocation = revocationFailure === null ? null : reasonOf(revocationFailure);
    return {
      ...outcome,
      // A stored receive still running is an open transfer, and a retained
      // cleanup ticket is a destination this process could not close — both
      // belong in the same counts the leases use.
      // A delivery still being received is an open transfer, and a retained
      // Inbox destination is one this process could not close — the same two
      // facts the stored counts carry, from the other receiving feature.
      openLeases:
        outcome.openLeases + storedHeld.active + inboxHeld.active + sendHeld.active + inboxSendHeld.active,
      unresolved:
        outcome.unresolved +
        storedHeld.retained.length +
        inboxHeld.retained.length +
        // An upload whose outcome could not be established is exactly the kind
        // of thing a quit prompt exists to mention.
        sendHeld.unresolved +
        // And a DELIVERY whose outcome could not be established: it may or may
        // not be waiting on the user's other device, and quitting over it
        // without saying so is the same omission one line up.
        inboxSendHeld.unresolved +
        // Work the account reader could not stop inside its bounded wait. It
        // reports this truthfully rather than assuming it away, so a quit that
        // ignored it would be discarding the one honest number it produces.
        accountHeld.unjoined +
        (revocation !== null ? 1 : 0),
      networkUnsettled: sockets + reads,
      firstReason: outcome.firstReason ?? revocation,
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
    releaseAccountWatch();
    releaseSendAccountWatch();
    await storedSend.dispose();
    await inboxSend.dispose();
    await accountSummary.dispose();
    await inbox.dispose();
    await storedReceive.dispose();
    await service.dispose();
    if (revocationFailure !== null) throw revocationFailure;
  };

  // Destroying the window is one of the two ways this app ends; `before-quit`
  // is the other. Both must reach the same teardown.
  window.webContents.once("destroyed", () => {
    void teardown().catch(() => undefined);
  });

  const resume = (): void => {
    service.resume();
    service.admitReceives();
    storedReceive.resume();
    storedSend.resume();
    inboxSend.resume();
    accountSummary.resume();
    // The scheduler too: it was stopped by the same quiesce, and a Stay that
    // left it stopped would be an app that quietly never receives again.
    inbox.resume();
  };

  return {
    service,
    storedReceive,
    inbox,
    storedSend,
    inboxSend,
    accountSummary,
    resident,
    fence,
    quiesce,
    resume,
    preferences: prefs,
    dispose: teardown,
  };
}
