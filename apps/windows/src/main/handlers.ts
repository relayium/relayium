// Electron wiring. All policy lives in `app-service.ts`; this file narrows
// untrusted payloads and hands them on.
//
// The split is deliberate: rules that only exist inside an `ipcMain.handle`
// closure cannot be tested, and the rules here are the ones a race would break.

import { dialog, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import {
  IPC,
  IPC_EVENTS,
  MAX_ATTEMPT_NONCE_LENGTH,
  MAX_IPC_CHUNK_BYTES,
  MAX_IPC_MANIFEST_ENTRIES,
  MAX_SIGNALING_FRAME_BYTES,
  MAX_SOCKET_TOKEN_LENGTH,
  type AppInfo,
  type IceReply,
  type ReceiveAuthority,
  type SignalingEvent,
  type SignalingRoom,
} from "../shared/ipc-contract.js";
import { AppService } from "./app-service.js";
import { DeviceAuthClient } from "./account/device-auth.js";
import { ENGINEERING_BANNER, isEngineeringBuild } from "./build-mode.js";
import { IceControl, IceRequestRegistry } from "./net/ice-control.js";
import { SignalingHub, isWellFormedCode, type SignalingSocketFactory } from "./net/signaling-socket.js";
import { BoundedTransport } from "./net/transport.js";
import { SecretStore, electronCipher } from "./secrets.js";
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
  /** The signalling socket constructor, substituted so a test can drive the hub
   *  without a network. Absent means Electron's built-in `WebSocket`. */
  makeSignalingSocket?: SignalingSocketFactory;
  /** The ICE control-plane reader, substituted for the same reason. */
  makeIceControl?: () => IceControl;
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

/** Returns the owned teardown for everything it started. */
export function registerHandlers(
  window: BrowserWindow,
  origin: string,
  scheme: string,
  host: string,
  composition: HandlerComposition = {},
): () => Promise<void> {
  const router = new IpcRouter(scheme, host);
  router.bind(window.webContents);

  const service = new AppService({
    origin,
    makeStore:
      composition.makeStore ??
      (async () => {
        const root = currentDataRoot();
        if (!root.ok) throw new IpcRefusal(`data root unavailable: ${root.reason}`);
        return new SecretStore(`${root.path}/secrets`, await electronCipher());
      }),
    makeAuthClient:
      composition.makeAuthClient ??
      ((installationID) => new DeviceAuthClient(origin, new BoundedTransport(origin), installationID)),
    async pickDirectory() {
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
  });

  router.handle(IPC.appInfo, async (): Promise<AppInfo> => ({
    origin,
    engineering: isEngineeringBuild(),
    banner: isEngineeringBuild() ? ENGINEERING_BANNER : null,
    version: process.env["npm_package_version"] ?? "0.0.1",
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

  router.handle(IPC.receivePublish, async (payload) => {
    const body = expectObject(payload);
    return service.publishReceive(leaseId(body));
  });

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

  return teardown;
}
