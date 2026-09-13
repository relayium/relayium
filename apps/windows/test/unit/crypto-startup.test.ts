// The startup contract, and the failure it explains.
//
// `crypto.ts` loads libsodium lazily; `sodiumSync()` throws until `ready()` has
// resolved. `peer-link.establish` calls `generateKeyPair()` SYNCHRONOUSLY before
// it opens a transport — so a renderer that never called `ready()` throws on the
// first link, before any `RTCPeerConnection` exists.
//
// That is not hypothetical. A real Mac→Windows pairing attempt delivered an
// offer over IPC, Windows constructed zero peer connections, and the UI sat on
// the code-entry screen while the Mac timed out.
//
// ## Why this file resets modules
//
// `protocol-fixtures.test.ts` calls `crypto.ready()` in a `beforeAll`, and the
// suite runs in one process. libsodium's `lib` is module state, so once ANY file
// has initialised it every later file sees a warm module — which would mask
// exactly this bug. `vi.resetModules()` plus dynamic import gives a genuinely
// cold graph, so RED is red for the real reason.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransportBridge } from "../../src/renderer/transport/bridge.js";

let constructed = 0;

/** Enough of the API for `establish` to get as far as a transport. */
class CountingPC {
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  ondatachannel: unknown = null;
  constructor() {
    constructed += 1;
  }
  createDataChannel() {
    return { readyState: "connecting", close() {}, addEventListener() {}, send() {} };
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
  async setRemoteDescription() {}
  async setLocalDescription() {}
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0" };
  }
  async addIceCandidate() {}
  get connectionState() {
    return "new";
  }
  get iceConnectionState() {
    return "new";
  }
}

function bridgeFor(selfId: string, peerId: string) {
  const listeners = new Set<(p: unknown) => void>();
  let token = "";
  const bridge: TransportBridge = {
    signaling: {
      open: async (p) => {
        token = p.token;
        return { ok: true };
      },
      send: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    ice: {
      config: async () => ({ ok: true, status: 200, body: { iceServers: [], relays: [] } }) as never,
    },
  };
  const msg = (o: unknown) => {
    for (const l of [...listeners]) l({ token, kind: "message", data: JSON.stringify(o) });
  };
  return {
    bridge,
    join() {
      for (const l of [...listeners]) l({ token, kind: "open" });
      msg({ type: "welcome", name: selfId, ip: "" });
      msg({
        type: "peers",
        peers: [
          { id: selfId, name: "windows" },
          { id: peerId, name: "mac" },
        ],
      });
      msg({ type: "signal", from: peerId, data: { caps: ["text/1", "link/1"] } });
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

/** One cold composition. `warm` decides whether `ready()` is awaited first. */
async function attemptLink(warm: boolean): Promise<number> {
  vi.resetModules();
  constructed = 0;
  vi.stubGlobal("RTCPeerConnection", CountingPC);

  const crypto = await import("../../../../web/src/lib/crypto");
  if (warm) await crypto.ready();

  const { RoomController } = await import("../../src/renderer/rooms/room-controller.svelte.js");
  // Windows is the lexicographically smaller id, so `linkRole` makes it the
  // initiator and it is the side that offers.
  const h = bridgeFor("0000aaaa0000aaaa", "ffffbbbbffffbbbb");
  const room = new RoomController({
    bridge: h.bridge,
    room: { kind: "code", code: "737256" },
    displayName: "this pc",
    autoConnect: true,
  });
  await settle();
  h.join();
  await settle();
  // Driven EXPLICITLY rather than through auto-connect. Auto-connect runs in a
  // `$effect`, and this suite is `environment: "node"` with no browser resolve
  // conditions, so Svelte compiles effects to their server no-op — an effect
  // that never fires here says nothing about the packaged renderer. Calling the
  // same entry point directly leaves `ready()` as the single variable between
  // RED and GREEN, which is the whole point of the pair.
  void room.workspace.openText("ffffbbbbffffbbbb");
  await settle();
  room.stop();
  return constructed;
}

afterEach(() => vi.unstubAllGlobals());

describe("a renderer that never initialises crypto cannot establish anything", () => {
  it("RED: builds zero peer connections on a cold module graph", async () => {
    // The observed production failure, reproduced: no `ready()`, so
    // `generateKeyPair()` throws inside `establish` and the transport is never
    // reached.
    expect(await attemptLink(false)).toBe(0);
  });

  it("GREEN: builds a peer connection once ready() has resolved", async () => {
    // Same composition, same counter, same frames. The only difference is the
    // startup contract being honoured.
    expect(await attemptLink(true)).toBeGreaterThan(0);
  });
});

describe("the App owns that contract itself", () => {
  // Deliberately NOT calling `ready()` here. The point is that `App.svelte`
  // awaits it before anything composes a room — a test that warmed the module
  // for it would assert nothing.
  const source = () =>
    import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/renderer/App.svelte", import.meta.url), "utf8"),
    );

  it("imports ready() from the shared crypto module", async () => {
    expect(await source()).toMatch(/import \{ ready \} from ".*web\/src\/lib\/crypto"/);
  });

  it("gates every room-creating action on it", async () => {
    const text = await source();
    // `startLan`, `createCode` and `joinCode` each compose a workspace, and each
    // would throw on its first link without the library loaded. Counted rather
    // than located, so reordering the functions does not break the assertion.
    const guards = [...text.matchAll(/cryptoPhase !== "ready"/g)].length;
    expect(guards).toBeGreaterThanOrEqual(3);
  });

  it("fences a late resolution against teardown", async () => {
    // `ready()` resolving after `onDestroy` must not spawn a room that nothing
    // will ever stop.
    const text = await source();
    expect(text).toMatch(/if \(torndown\) return;\s*\n\s*cryptoPhase = "ready"/);
    expect(text).toMatch(/torndown = true;/);
  });

  it("offers a retry rather than a dead screen", async () => {
    expect(await source()).toMatch(/data-test="crypto-retry"/);
  });
});
