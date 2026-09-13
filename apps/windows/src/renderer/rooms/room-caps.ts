// What each peer in ONE room has announced it can speak.
//
// ## Why this exists at all, when `peer-caps.svelte.ts` already does it
//
// Because it does it once, for the whole page. `announced` there is a module
// global, and `retainPeers`/`resetPeerCaps` prune it wholesale. The web page can
// live with that: it holds a single socket and swaps rooms with
// `signaling.reconnect`, so there is only ever one roster.
//
// This client is the Mac shape, not the web one — a same-network transfer and a
// pairing transfer run at the same time, each drawing its own destination. Share
// one global between them and the LAN roster's ordinary churn deletes the
// pairing room's capability records: `retainPeers(lanIds)` drops every pairing
// peer, `peerSupportsLink` then answers false for a peer that is right there,
// and that peer becomes permanently unreachable with nothing on either screen
// explaining it. Reconnecting the LAN room would do it. So would a phone
// walking out of Wi-Fi range.
//
// ## Why this is a registry and not a change to the web module
//
// It does not need to be one. Every read this slice performs goes through an
// injectable seam: `supportsLink` is threaded `peer-workspace` →
// `mixed-session` → `peer-link`, and `supportsPreupload` reaches
// `mixed-file-session`. Inject both per room and the globals are never called.
//
// One module DOES read the globals with no seam — `handoff-lane.svelte.ts`, via
// `peerCapsKnown`/`peerSupportsPreupload`. That is the pre-upload/stored-key
// lane, which belongs to the stored-send route and not to this slice: no
// `storedKeysToSend` is passed, so `mixed-file-session` short-circuits before
// any capability is read. If the stored-send route ever needs per-room handoff
// state, the correct fix is a `createPeerCaps()` factory in the web module with
// the globals delegating to a default instance. Recorded as the trigger; not
// requested now.
//
// ## The duplication that is left, and how it is held closed
//
// The hello parse below is the same five lines as `recordPeerCaps`. That is
// real drift risk, and it is closed mechanically rather than by discipline:
// `room-caps.test.ts` feeds identical frames through the web function and this
// one and asserts identical verdicts, and asserts the web global stays EMPTY
// for the whole lifetime of two concurrent rooms — which is the regression that
// catches any future accidental global read.

import { SvelteMap } from "svelte/reactivity";
import {
  CAP_LINK,
  CAP_PREUPLOAD,
  linkRoomActive,
} from "../../../../../web/src/lib/peer-caps.svelte";

export class RoomCaps {
  /**
   * Peer id → exactly what that peer said.
   *
   * A `Map` rather than an object, so an id like `"toString"` cannot answer with
   * `Object.prototype`'s member — which would read as "already announced" for a
   * peer that never has, and which makes `peerSupportsLink` throw in the shared
   * module for the same ids.
   *
   * A **`SvelteMap`** rather than a plain one, because a plain `Map` is not a
   * reactive dependency: an `$effect` reading `supportsLink(id)` was never
   * invalidated when a hello arrived. That is measured, not inferred — a
   * compiled Vite bundle of this exact file, running in Electron 44, showed the
   * caps effect at one run before and after `record(link/1)` while a control
   * effect beside it advanced, with `supportsLink` returning true the whole
   * time. The value was correct and nothing was told.
   *
   * `SvelteMap` changes only that. The registry is still per room, still
   * private, and still validates exactly what it validated before.
   */
  readonly #announced = new SvelteMap<string, readonly string[]>();

  /**
   * Record a peer's announcement.
   *
   * Returns true if this frame WAS a caps hello, so a caller can tell it apart
   * from the other piggybacks sharing this envelope (`relayRtt`, `rename`).
   *
   * Peer-authored input on an untrusted channel: anything malformed is recorded
   * as "no capabilities" rather than thrown, because throwing here would land
   * in the signalling dispatch loop. A non-array `caps` is not a hello at all —
   * that is a frame we do not understand, not a peer with no capabilities.
   * Identical rules to `recordPeerCaps`, and pinned to it by test.
   */
  record(peerId: string, data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const caps = (data as { caps?: unknown }).caps;
    if (caps === undefined || !Array.isArray(caps)) return false;
    this.#announced.set(peerId, caps.filter((c): c is string => typeof c === "string"));
    return true;
  }

  /** Whether this peer has announced AT ALL — the third state the predicates
   *  below deliberately do not have. See `peerCapsKnown`. */
  known(peerId: string): boolean {
    return this.#announced.has(peerId);
  }

  /**
   * Exact match; never inferred from `text/1`.
   *
   * "Exact" is load-bearing. This is the only admission decision there is —
   * there is no second transport to fall through to — so a false answer is not a
   * downgrade, it is a connection that cannot work. `link/2`, a capitalised
   * variant, `text/1` and a peer that never announced are all equally not this
   * protocol and all equally unreachable. The scope check stays in front of the
   * membership test for the same reason it does in the web module.
   */
  supportsLink(peerId: string): boolean {
    if (!linkRoomActive()) return false;
    return (this.#announced.get(peerId) ?? []).includes(CAP_LINK);
  }

  /** Exact match, and never inferred from `link/1`. An unknown frame kind is a
   *  hard error in every implementation, so a speculative handoff kills the
   *  transfer rather than degrading to the live lane. */
  supportsPreupload(peerId: string): boolean {
    if (!linkRoomActive()) return false;
    return (this.#announced.get(peerId) ?? []).includes(CAP_PREUPLOAD);
  }

  /** Drop announcements for peers no longer in THIS room's roster. A
   *  reconnecting peer is issued a fresh id by the server, so nothing stale can
   *  be inherited — but a departed peer's entry would otherwise leak for the
   *  life of the room. */
  retain(peerIds: readonly string[]): void {
    const keep = new Set(peerIds);
    for (const id of [...this.#announced.keys()]) if (!keep.has(id)) this.#announced.delete(id);
  }

  /** This room is gone. Its peer ids mean nothing outside it. */
  reset(): void {
    this.#announced.clear();
  }

  /** Test/diagnostic only. */
  get size(): number {
    return this.#announced.size;
  }
}
