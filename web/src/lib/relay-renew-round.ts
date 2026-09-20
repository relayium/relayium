// The `ice-renew` / `ice-grant` round exchange, as a correlator.
//
// One per room, owned by whoever owns the signalling socket — `App.svelte` in
// the browser, `room-controller.svelte.ts` in the Electron renderer. Shared
// rather than reimplemented per client for exactly the reason `ice.ts`'s
// classifier is: a second copy is silent divergence with a green board on both
// sides.
//
// It owns three things and deliberately nothing else: matching a reply to its
// request, bounding the wait, and making sure a room switch cannot deliver one
// room's credentials to the next room's link.

import { parseIceGrant, type IceGrant } from "./relay-renew-wire";

/**
 * How long one round request waits.
 *
 * ## Why this is the prepare bound and not the server's collection window
 *
 * The server may hold a round open for up to 30 s while it waits for the SECOND
 * peer to ask (`relay-renew-v1.md` §2.3), which is longer than this. That is
 * not a contradiction, it is the retry design: both peers exchange `prepare`
 * before either asks, so in the normal case the two requests land milliseconds
 * apart and the reply is immediate. When it is not, this attempt times out, the
 * epoch aborts, and the NEXT epoch's request for the same round is served from
 * the server's per-round cache — no reissuance, no rate charge, and an instant
 * answer.
 *
 * So the client's patience is deliberately shorter than the server's window.
 * Waiting out the full 30 s inside one epoch would spend most of the epoch's
 * 60 s ceiling before ICE had even started.
 */
export const RENEW_ROUND_TIMEOUT_MS = 15_000;

/**
 * How many round requests may be in flight at once.
 *
 * One epoch asks once, and only one epoch runs at a time, so two is already
 * slack: it covers the window where an aborted epoch's request has not yet
 * timed out while its successor asks. A third would mean something is wrong
 * with the caller, and an unbounded map would mean a caller's bug becomes this
 * module's leak.
 */
export const RENEW_MAX_INFLIGHT = 2;

export interface RenewRoundDeps {
  /** Put the request on the room's signalling socket. */
  send(round: number, rid: number): void;
  setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  timeoutMs?: number;
}

export interface RenewRoundClient {
  /** Ask for `round`. Resolves with the grant, or null on timeout, on a room
   *  switch, or when too many requests are already in flight. Never rejects:
   *  the caller treats null as "unavailable", which is also what an older
   *  server that ignores the frame produces. */
  request(round: number, rid: number): Promise<IceGrant | null>;
  /** Feed an inbound `ice-grant` payload, straight from `onIceGrant`. */
  accept(data: unknown): void;
  /**
   * The room changed, or the socket did.
   *
   * Every pending request is settled with null rather than dropped: a caller is
   * awaiting it, and the reply that would have settled it belongs to a room
   * this page has left. Settling is also what stops a grant issued for the
   * PREVIOUS room being applied to the next room's link — the rid map is empty
   * before the new room can produce one.
   */
  reset(): void;
}

export function createRenewRoundClient(deps: RenewRoundDeps): RenewRoundClient {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const timeoutMs = deps.timeoutMs ?? RENEW_ROUND_TIMEOUT_MS;

  interface Pending {
    round: number;
    settle(grant: IceGrant | null): void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<number, Pending>();

  function finish(rid: number, grant: IceGrant | null) {
    const entry = pending.get(rid);
    if (!entry) return;
    pending.delete(rid);
    clearTimer(entry.timer);
    entry.settle(grant);
  }

  return {
    request(round, rid) {
      // A repeated rid would make two requests indistinguishable, and the
      // caller generates it randomly, so a collision is a caller bug rather
      // than a race. Refused rather than allowed to overwrite the first.
      if (pending.has(rid)) return Promise.resolve(null);
      if (pending.size >= RENEW_MAX_INFLIGHT) return Promise.resolve(null);
      return new Promise<IceGrant | null>((resolve) => {
        const timer = setTimer(() => finish(rid, null), timeoutMs);
        pending.set(rid, { round, settle: resolve, timer });
        try {
          deps.send(round, rid);
        } catch (err) {
          // A socket in its reconnect window throws rather than queues. Same
          // answer as silence, and settled now rather than after the timeout.
          console.error("relayium renew round send error", err);
          finish(rid, null);
        }
      });
    },

    accept(data) {
      const grant = parseIceGrant(data);
      // Unparseable, or for a request this page never made. Dropped in silence:
      // it cannot be correlated, so there is nothing it could answer.
      if (!grant) return;
      const entry = pending.get(grant.rid);
      if (!entry) return;
      // A grant must answer the round it was asked about. The one exception is
      // `stale`, whose whole purpose is to report a DIFFERENT round — the one
      // the server actually holds — so the caller can resynchronise.
      if (grant.status !== "stale" && grant.round !== entry.round) return;
      finish(grant.rid, grant);
    },

    reset() {
      const entries = [...pending.keys()];
      for (const rid of entries) finish(rid, null);
    },
  };
}
