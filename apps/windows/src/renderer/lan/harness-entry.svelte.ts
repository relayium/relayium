// A private entry that mounts the REAL same-network page for the renderer smoke.
//
// Nothing imports this file, so it is not in the shipped bundle. It is only ever
// reached by being named as a Vite entry by `test/smoke/lan-page-smoke.mjs`.
//
// ## Why this screen needed one
//
// Nothing drove the LAN roster. The realtime lane pairs by CODE — its driver
// clicks `nav-pair` — and `smoke-main.mjs` only asserts that `lan-start` is
// ABSENT when signed out. So every state on this page was compile-checked and
// never displayed: the empty roster, the offline card, the reconnecting card,
// the user-stopped card, the statement that stands in for a disabled Connect
// button, and — added in `4db88d5e9` and the reason this exists now — the two
// sentences saying who else can be at the same public address.
//
// ## The stand-in, and what it is honest about
//
// `RoomController` is a class that owns a signalling socket, a workspace and a
// capability map. None of that can exist in a page with no main process, so the
// object below is a plain one, cast ONCE at the mount boundary and nowhere else.
//
// The cast is the thing to be careful about, so the surface it stands in for is
// declared explicitly in `LanRoomStandIn` and checked against the real type with
// `satisfies`: every member here must exist on `RoomController` with a
// compatible shape, so a rename or a signature change fails the build rather
// than silently drifting from the object the app actually passes.
//
// What is NOT covered: `LinkPane`. `linkPeerId` stays empty here, so the page
// takes its roster branch. The link pane is a larger surface with its own
// harness still owed, and pretending to cover it from here would be worse than
// the gap.

import { mount } from "svelte";
import LanPage from "../pages/LanPage.svelte";
import type { RoomController, RoomConnection } from "../rooms/room-controller.svelte.js";
import { RoomCaps } from "../rooms/room-caps.js";
import type { RevealController } from "../receive/reveal-controller.svelte.js";
import type { ReceivedController } from "../receive/received-controller.svelte.js";
import type { Peer } from "../../../../../web/src/lib/protocol";
import { setLang } from "../i18n/index.svelte.js";
import "../tokens.css";

/** What `LanPage` actually reads off the controller. Read from the page. */
interface LanRoomStandIn {
  readonly caps: { supportsLink(peerId: string): boolean };
  readonly connection: RoomConnection;
  connectTo(peerId: string): void;
  readonly everJoined: boolean;
  readonly peers: readonly Peer[];
  retry(): void;
  readonly userStopped: boolean;
  readonly workspace: { readonly linkPeerId: string; blocksNewIntent(peerId: string): boolean };
}

const calls = { connectTo: [] as string[], retry: 0, start: 0, stop: 0 };

const state = $state({
  peers: [] as Peer[],
  connection: "joined" as RoomConnection,
  everJoined: true,
  userStopped: false,
  /** Peers whose hello did NOT announce `link/1`. */
  unsupported: [] as string[],
  /** Peers a live intent already blocks. */
  blocked: [] as string[],
  receiving: true,
  busy: false,
});

const room: LanRoomStandIn = {
  caps: { supportsLink: (peerId) => !state.unsupported.includes(peerId) },
  get connection() {
    return state.connection;
  },
  connectTo(peerId) {
    calls.connectTo.push(peerId);
  },
  get everJoined() {
    return state.everJoined;
  },
  get peers() {
    return state.peers;
  },
  retry() {
    calls.retry += 1;
  },
  get userStopped() {
    return state.userStopped;
  },
  workspace: {
    // Empty on purpose: this harness covers the ROSTER. See the header.
    get linkPeerId() {
      return "";
    },
    blocksNewIntent: (peerId) => state.blocked.includes(peerId),
  },
};

/**
 * The compile-time half of the cast below.
 *
 * This does the work a declared bridge does in the other harnesses: the
 * stand-in must be ASSIGNABLE to the real controller's own members, so renaming
 * `everJoined`, or changing what `peers` holds, breaks this file rather than
 * leaving a harness that quietly agrees with nothing.
 *
 * `caps` is deliberately outside the check. `RoomCaps` is a class with private
 * state, and no object literal is assignable to it — a stand-in for it can only
 * ever be structural. What the page uses is one method, and that one IS pinned,
 * by `LanRoomStandIn` above and by the signature written out here.
 */
const _assignable: Pick<
  RoomController,
  "connection" | "connectTo" | "everJoined" | "peers" | "retry" | "userStopped"
> = room;
void _assignable;
const _capsShape: (peerId: string) => boolean = (peerId) => new RoomCaps().supportsLink(peerId);
void _capsShape;

/** Neither is rendered on the roster branch; both are required props. */
const unusedPane = { reveal: null as unknown as RevealController, received: null as unknown as ReceivedController };

const target = document.getElementById("app");
if (target === null) throw new Error("the harness page has no mount point");

mount(LanPage, {
  target,
  props: {
    room: room as unknown as RoomController,
    reveal: unusedPane.reveal,
    received: unusedPane.received,
    get receiving() {
      return state.receiving;
    },
    get busy() {
      return state.busy;
    },
    onStart: () => {
      calls.start += 1;
    },
    onStop: () => {
      calls.stop += 1;
    },
    verifyPeers: false,
  },
});

/**
 * The driving surface, on `window`.
 *
 * Inputs only. The driver sets state and reads the DOM back; it never asks the
 * page what it thinks, because a field that is right while the screen is wrong
 * is the failure this exists to catch.
 */
Object.defineProperty(globalThis, "__lanHarness", {
  value: {
    setPeers(peers: readonly { id: string; name: string }[]): void {
      state.peers = peers.map((p) => ({ id: p.id, name: p.name }) as Peer);
    },
    setConnection(next: RoomConnection, everJoined = true): void {
      state.connection = next;
      state.everJoined = everJoined;
    },
    setUserStopped(stopped: boolean): void {
      state.userStopped = stopped;
    },
    setUnsupported(ids: readonly string[]): void {
      state.unsupported = [...ids];
    },
    setBlocked(ids: readonly string[]): void {
      state.blocked = [...ids];
    },
    setReceiving(on: boolean, busy = false): void {
      state.receiving = on;
      state.busy = busy;
    },
    setLang(next: "en" | "zh"): void {
      setLang(next);
    },
    calls(): typeof calls {
      return JSON.parse(JSON.stringify(calls)) as typeof calls;
    },
  },
  enumerable: true,
});
