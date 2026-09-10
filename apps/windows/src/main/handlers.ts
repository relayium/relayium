// Electron wiring. All policy lives in `app-service.ts`; this file narrows
// untrusted payloads and hands them on.
//
// The split is deliberate: rules that only exist inside an `ipcMain.handle`
// closure cannot be tested, and the rules here are the ones a race would break.

import { dialog, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import {
  IPC,
  MAX_ATTEMPT_NONCE_LENGTH,
  MAX_IPC_CHUNK_BYTES,
  MAX_IPC_MANIFEST_ENTRIES,
  type AppInfo,
} from "../shared/ipc-contract.js";
import { AppService } from "./app-service.js";
import { DeviceAuthClient } from "./account/device-auth.js";
import { ENGINEERING_BANNER, isEngineeringBuild } from "./build-mode.js";
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
    return service.openReceive(manifest);
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

  // Destroying the window is one of the two ways this app ends; `before-quit`
  // is the other. Both must reach the same teardown.
  window.webContents.once("destroyed", () => {
    void service.dispose().catch(() => undefined);
  });

  return () => service.dispose();
}
