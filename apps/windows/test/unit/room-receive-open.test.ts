// A destination that cannot be OPENED must still end visibly.
//
// ## The defect this file exists for, and how it was found
//
// `RoomController.#pickSaveTarget` recorded a receipt only for
// `ReceiveCancelledError` and rethrew every other failure in silence. Every
// branch of `LinkPane`'s receipt card is gated on `receipt?.kind`, so a failure
// to open the destination produced a transfer that ended with NOTHING on the
// pane — no outcome, no reason, no notice.
//
// It was not found by reasoning. The Windows runner reported it, for a manifest
// the native path guards had correctly refused:
//
//     refusal={"manifest":["NUL.txt"],"outcome":"refused",
//              "errorName":"NativeHelperError","helperCode":"E_MANIFEST"}
//     entries=[]  [panel, reported only: outcome=(none) notice=""]
//
// The helper was right, nothing was written, and the user was told nothing.
// That hosted log is the independent RED and is preserved separately; these
// cases are the owning regression, and they fail against the old catch at the
// receipt assertion.
//
// ## Why the composition is mocked at ONE seam and nowhere else
//
// The callback under test is the one `RoomController` hands to
// `createPeerWorkspace`. Reaching it the way the product does means an accepted
// inbound manifest over a live `RTCDataChannel`, which does not exist in this
// environment — and faking a peer connection would test a fake, not the wiring.
//
// So `createPeerWorkspace` is wrapped rather than replaced: the real one is
// imported and called, and the only thing the wrapper does is keep a reference
// to the `pickSaveTarget` option it was passed. What these tests then invoke is
// the ACTUAL closure the ACTUAL workspace received from an ACTUAL controller,
// over a real `ReceiveCoordinator` and a real bridge. Nothing about the product
// path is simulated except the moment of arrival.
//
// It lives in its own file because `vi.mock` is hoisted per module: the room
// transport tests next door must keep composing the unwrapped workspace.
//
// ## The specifier below ends in `.svelte.ts`, and that is load-bearing
//
// The product imports this module as `.../peer-workspace.svelte`, and Vite
// resolves that to the `.svelte.ts` file. Mocking the SHORT form makes vitest
// resolve a different id — the Svelte plugin then treats it as a component —
// and the whole imported graph loads without the rune transform, so the first
// `$state` it meets throws `$state is not defined` from `peer-caps.svelte.ts`
// before a single test runs. The full extension resolves to the same module the
// product actually loaded, and the transform survives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalingRoom } from "../../src/shared/ipc-contract.js";
import type { TransportBridge } from "../../src/renderer/transport/bridge.js";
import { ReceiveCancelledError } from "../../src/renderer/receive/receive-coordinator.js";
// Statically imported, like every other room test: `vi.mock` is hoisted above
// the imports, so the wrapper below is already installed when this module is
// evaluated. A dynamic `await import` here would load the `.svelte.ts` graph
// outside the Svelte transform and fail on the first rune it met.
import { RoomController } from "../../src/renderer/rooms/room-controller.svelte.js";

/** The option the controller wired, captured as it was handed over. */
let wired: ((files: { name: string; size: number }[]) => Promise<unknown>) | undefined;

vi.mock("../../../../web/src/lib/peer-workspace.svelte.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../web/src/lib/peer-workspace.svelte")>();
  return {
    ...actual,
    createPeerWorkspace(options: Parameters<typeof actual.createPeerWorkspace>[0]) {
      wired = options.pickSaveTarget as typeof wired;
      // Delegated, not replaced: the room gets the real workspace.
      return actual.createPeerWorkspace(options);
    },
  };
});


/** Enough transport for a room to exist. Nothing here is exercised. */
function idleBridge(): TransportBridge {
  return {
    signaling: {
      open: async () => ({ ok: true }),
      send: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      subscribe: () => () => undefined,
    },
    ice: {
      config: async () => ({ ok: true, status: 200, body: { iceServers: [], relays: [] } }) as never,
    },
  } as TransportBridge;
}

const FILES = [{ name: "NUL.txt", size: 21 }];
const ROOM: SignalingRoom = { kind: "code", code: "424242" };

/** A path and a message that must never reach a receipt. */
const SECRET_PATH = "C:\\Users\\someone\\Documents\\Taxes\\return.pdf";
const SECRET_MESSAGE = `E_MANIFEST while opening ${SECRET_PATH}`;

let rooms: Array<{ stop: () => void }> = [];

function roomThatFailsToOpen(open: () => Promise<never>) {
  const controller = new RoomController({
    bridge: idleBridge(),
    room: ROOM,
    displayName: "windows",
    receive: {
      open,
      begin: async () => undefined,
      write: async () => undefined,
      finish: async () => undefined,
      publish: async () => ({ status: "complete", publishedCount: 0, total: 0 }) as never,
      cancel: async () => undefined,
    },
  });
  rooms.push(controller);
  return controller;
}

beforeEach(() => {
  wired = undefined;
});
afterEach(() => {
  for (const room of rooms) room.stop();
  rooms = [];
});

describe("a destination that cannot be opened", () => {
  it("wires the real callback into the real workspace", () => {
    roomThatFailsToOpen(async () => {
      throw new Error("unused");
    });
    // The premise of every case below: this IS the product's own closure.
    expect(typeof wired).toBe("function");
  });

  it("records a TERMINAL failed receipt, where it used to record nothing", async () => {
    const controller = roomThatFailsToOpen(async () => {
      throw new Error(SECRET_MESSAGE);
    });
    expect(controller.lastReceipt).toBeNull();

    await expect(wired!(FILES)).rejects.toThrow();

    // The assertion the old catch fails: it left this null, and every branch of
    // the pane's receipt card is gated on it.
    const receipt = controller.lastReceipt;
    expect(receipt).not.toBeNull();
    expect(receipt!.kind).toBe("failed");
  });

  it("says nothing was PUBLISHED and refuses to call the folder clean", async () => {
    const controller = roomThatFailsToOpen(async () => {
      throw new Error(SECRET_MESSAGE);
    });
    await expect(wired!(FILES)).rejects.toThrow();

    const receipt = controller.lastReceipt as {
      kind: string; saved: number; total: number; residue: boolean;
    };
    // `saved: 0` is a fact about the phase reached — publication never began.
    expect(receipt.saved).toBe(0);
    expect(receipt.total).toBe(FILES.length);
    // `residue: true` is the honest answer, not a pessimistic default: a lease
    // may already have staged bytes, cleanup has not settled, and this is
    // exactly the case where the folder cannot be described as clean. A `false`
    // here would be a claim about a disk nobody has looked at.
    expect(receipt.residue).toBe(true);
  });

  it("carries no path, no message and no typed cause", async () => {
    const controller = roomThatFailsToOpen(async () => {
      throw Object.assign(new Error(SECRET_MESSAGE), { code: "manifest-refused", helperCode: "E_MANIFEST" });
    });
    await expect(wired!(FILES)).rejects.toThrow();

    // The receipt is rendered. What went wrong belongs in the log and in main,
    // not on a pane — and a refused MANIFEST is a list of the sender's file
    // names, which is user content.
    const serialised = JSON.stringify(controller.lastReceipt);
    expect(serialised).not.toContain(SECRET_PATH);
    expect(serialised).not.toContain("E_MANIFEST");
    expect(serialised).not.toContain("manifest-refused");
    expect(serialised).not.toContain("NUL.txt");
    // `internal` is the honest classification: this layer genuinely does not
    // know which of the many open failures happened, and it does not guess.
    expect((controller.lastReceipt as { reason: string }).reason).toBe("internal");
  });

  it("still reports a cancelled picker as CANCELLED, not as a failure", async () => {
    const controller = roomThatFailsToOpen(async () => {
      throw new ReceiveCancelledError();
    });
    await expect(wired!(FILES)).rejects.toBeInstanceOf(ReceiveCancelledError);
    // Closing the folder dialog is a choice, and calling it a failure would put
    // a red error in front of a user who simply changed their mind.
    expect(controller.lastReceipt).toEqual({ kind: "cancelled" });
  });

  it("rethrows, so the session still rejects the batch", async () => {
    const controller = roomThatFailsToOpen(async () => {
      throw new Error(SECRET_MESSAGE);
    });
    // The receipt is additional to the rejection, never a substitute: the
    // session needs the throw to send REJECT and retire the lane, and a
    // swallowed failure would leave the sender waiting.
    await expect(wired!(FILES)).rejects.toThrow(SECRET_MESSAGE);
    expect(controller.lastReceipt!.kind).toBe("failed");
  });
});
