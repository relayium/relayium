// The ICE control plane, read by the main process on the renderer's behalf.
//
// ## Why the renderer cannot do this itself
//
// `web/src/lib/ice.ts` fetches a RELATIVE `/api/ice`. In a browser that resolves
// against the server; in this renderer it resolves against `app://relayium` and
// reaches the bundle, not the API. So the read has to happen somewhere that
// knows the origin, and that is here.
//
// ## This file is a TRANSPORT. It decides nothing.
//
// An earlier draft classified the answer here — retried, capped `Retry-After`,
// and returned an `ok` flag with a flattened server list. That duplicated
// `ice.ts`'s reasoning and then lost most of it: `relayDenied` (the server
// deliberately withholding TURN over quota or an unverified email) never
// reached the renderer at all, a 429 was indistinguishable from a dead network,
// and each relay's `region`/`stun` were dropped. Every one of those is a
// distinct thing to tell a user, and all of them arrived as "no relay".
//
// So the split is: main performs the request, because only main can address the
// server; `fetchIceConfig` classifies it, because it already does, once, for
// every client. What crosses the boundary is a status line, a bounded
// `Retry-After`, and a narrowed body — never a verdict.
//
// ## What it is NOT
//
// Not a proxy. There is one path, built from this build's compiled origin; the
// renderer supplies at most a validated six-digit code. No renderer-supplied
// URL, no redirect following, no header passthrough, no method other than GET.
//
// ## And it carries no credential
//
// `account/turn.go handleICE` derives relay entitlement from
// `s.pairCodeOwner(code)` — the owner of the pairing CODE — and reads no
// requester session at all. The web client's `credentials: "include"` is not
// load-bearing for authorization. So this request sends no bearer, which is
// also what lets LAN and code-join work signed out.

import {
  MAX_ICE_RELAYS,
  MAX_ICE_REQUESTS_IN_FLIGHT,
  MAX_ICE_REQUESTS_PER_ROOM,
  MAX_ICE_ROOMS_PER_DOCUMENT,
  MAX_ICE_RETRY_AFTER_SECONDS,
  MAX_ICE_SERVERS,
  MAX_ICE_STRING_LENGTH,
  MAX_ICE_URLS_PER_SERVER,
  type IceBodyView,
  type IceRelayView,
  type IceReply,
  type IceServerView,
} from "../../shared/ipc-contract.js";
import { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "./transport.js";
import { isWellFormedCode } from "./signaling-socket.js";

const bounded = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ICE_STRING_LENGTH ? value : null;

/** A URL an ICE agent understands, and nothing else. A `javascript:` or `http:`
 *  string here would be handed straight to a platform API. */
const iceUrl = (value: unknown): string | null => {
  const url = bounded(value);
  return url && /^(stun|turn|turns):/.test(url) ? url : null;
};

/**
 * Narrow one server entry, or drop it.
 *
 * Dropping rather than throwing: a deployment that adds a field this build does
 * not understand must not cost the user their whole relay list. What survives is
 * exactly what `RTCPeerConnection` needs and nothing else.
 */
function narrowServer(raw: unknown): IceServerView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as { urls?: unknown; username?: unknown; credential?: unknown };
  const rawUrls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
  const urls: string[] = [];
  for (const candidate of rawUrls.slice(0, MAX_ICE_URLS_PER_SERVER)) {
    const url = iceUrl(candidate);
    if (url) urls.push(url);
  }
  if (urls.length === 0) return null;
  const username = bounded(entry.username);
  const credential = bounded(entry.credential);
  return {
    urls,
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
  };
}

function narrowServers(raw: unknown): IceServerView[] {
  if (!Array.isArray(raw)) return [];
  const out: IceServerView[] = [];
  for (const entry of raw.slice(0, MAX_ICE_SERVERS)) {
    const server = narrowServer(entry);
    if (server) out.push(server);
  }
  return out;
}

/**
 * Narrow the relay pool, keeping every field the shared classifier and the UI
 * read.
 *
 * `region` and `stun` are carried through deliberately. They are not
 * load-bearing for main — it has no view on either — but `RelayEntry` declares
 * them and the renderer displays the region, so dropping them here would be a
 * capability removed by a narrowing pass rather than by a decision.
 */
function narrowRelays(raw: unknown): IceRelayView[] {
  if (!Array.isArray(raw)) return [];
  const out: IceRelayView[] = [];
  for (const entry of raw.slice(0, MAX_ICE_RELAYS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const shaped = entry as { id?: unknown; region?: unknown; stun?: unknown; iceServers?: unknown };
    const id = bounded(shaped.id);
    if (!id) continue;
    const iceServers = narrowServers(shaped.iceServers);
    if (iceServers.length === 0) continue;
    const region = bounded(shaped.region);
    const stun = iceUrl(shaped.stun);
    out.push({
      id,
      ...(region ? { region } : {}),
      ...(stun ? { stun } : {}),
      iceServers,
    });
  }
  return out;
}

/**
 * Narrow the whole body.
 *
 * `relayDenied` is bounded and passed through as the server sent it. It is NOT
 * matched against the two reasons this build knows about: `relayStatusOf` in
 * `ice.ts` is what decides which values mean something, and a main process that
 * pre-filtered them would silently delete a reason a newer server introduced.
 */
export function narrowIceBody(raw: unknown): IceBodyView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const shaped = raw as { iceServers?: unknown; relays?: unknown; relayDenied?: unknown };
  const relayDenied = bounded(shaped.relayDenied);
  return {
    iceServers: narrowServers(shaped.iceServers),
    relays: narrowRelays(shaped.relays),
    ...(relayDenied ? { relayDenied } : {}),
  };
}

/** `Retry-After` as bounded delta-seconds, when the server sent a usable one. */
function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_ICE_RETRY_AFTER_SECONDS);
}

/**
 * Let go of a body this call is not going to read.
 *
 * Not tidiness. An undici response whose body is never consumed and never
 * cancelled holds its connection out of the pool until GC gets to it, and the
 * three early returns below — a 429, an oversized `Content-Length`, a status
 * outside the range a `Response` can even be reconstructed from — are exactly
 * the paths a misbehaving or rate-limiting server drives repeatedly. Leaking a
 * socket per refusal is a resource the user cannot see and the app cannot
 * reclaim.
 */
async function release(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already errored or already consumed; there is nothing left to release.
  }
}

export class IceControl {
  constructor(
    private readonly origin: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * One attempt at `/api/ice`, optionally for one pairing code.
   *
   * Exactly one request per call: the retry belongs to `fetchIceConfig`, which
   * knows which failures are worth repeating. Never rejects — an unreachable
   * server is `ok: false` with a named failure, which the renderer's transport
   * turns back into a rejected promise for the shared classifier to read.
   *
   * `signal` is the OWNING room's. A room that is closed, or a document that
   * navigated away, aborts the request it is still waiting on rather than
   * letting it run to completion for a listener that no longer exists.
   */
  async read(code: string | undefined, signal?: AbortSignal): Promise<IceReply> {
    if (code !== undefined && code !== "" && !isWellFormedCode(code)) {
      return { ok: false, failure: "refused" };
    }
    const url = `${this.origin}/api/ice${code ? `?code=${encodeURIComponent(code)}` : ""}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        // A 302 to another host, followed, is this app fetching an attacker's
        // body with the privileged process's credibility. There is no redirect
        // on this endpoint, so refusing one gives nothing up.
        redirect: "error",
        signal: this.deadline(signal),
      });
    } catch (err) {
      return { ok: false, failure: classifyFailure(err) };
    }

    const status = response.status;
    // Outside what `new Response(...)` accepts, so the renderer could not
    // reconstruct it even if it wanted to. A completed fetch does not produce
    // one; refusing is the honest answer rather than a coerced status.
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      await release(response);
      return { ok: false, failure: "network" };
    }

    const retryAfter = retryAfterSeconds(response);
    const withRetryAfter = retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter };

    // A 429 is classified on the status line alone — `readIceConfig` returns
    // before it looks at the body — so reading one would be work done for
    // nobody. Released rather than abandoned.
    if (status === 429) {
      await release(response);
      return { ok: true, status, ...withRetryAfter, body: null };
    }

    // `Content-Length` is a hint from the peer: used to refuse early, never
    // trusted as the real bound. The counted read below is that.
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await release(response);
      return { ok: true, status, ...withRetryAfter, body: null };
    }

    let body: IceBodyView | null;
    try {
      body = narrowIceBody(JSON.parse(await this.readBounded(response)));
    } catch {
      // A body that is not JSON, or one over the ceiling. `ice.ts` treats a
      // null body exactly as it treats an unparseable one, which is what this
      // is.
      body = null;
    }
    return { ok: true, status, ...withRetryAfter, body };
  }

  /** The caller's cancellation merged with this transport's deadline, so a room
   *  that supplies a signal does not lose the bound that stops a stalled
   *  connection from pinning the request forever. */
  private deadline(caller: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return caller ? AbortSignal.any([timeout, caller]) : timeout;
  }

  /** Counted read against the ceiling, cancelling the stream the moment it is
   *  exceeded rather than draining a body this call has already refused. */
  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("ice response exceeds the ceiling");
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}

/** Which of the three no-response outcomes this was. Named separately so a
 *  redirect is never reported as an ordinary network blip. */
function classifyFailure(err: unknown): "network" | "timeout" | "redirect" {
  const name = (err as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (/redirect/i.test(String((err as Error)?.message))) return "redirect";
  return "network";
}


// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export class IceAdmissionError extends Error {
  constructor(readonly reason: string) {
    super(`ice admission refused: ${reason}`);
    this.name = "IceAdmissionError";
  }
}

/** One admitted request. Released exactly once, when it SETTLES. */
export interface IceRequestLease {
  readonly signal: AbortSignal;
  release(): void;
}

/** The requests one room has open. Held by identity, never by name — see
 *  `release` for the replacement race that makes the difference. */
interface RoomGroup {
  readonly controllers: Set<AbortController>;
}

/**
 * Which ICE reads this process is holding, and whether it will take another.
 *
 * ## Why a bounded body was never admission control
 *
 * A response ceiling bounds one answer. It says nothing about how many requests
 * exist, and each one is a privileged outbound connection with a fifteen-second
 * deadline attached. The first version of this bounded requests per `owner` —
 * and `owner` is a string the renderer picks, so varying it per call bought two
 * more every time. That is measured, not argued: 500 concurrent requests were
 * admitted under a cap that read as two.
 *
 * So there are three bounds, and they answer three different questions:
 *
 *   * per ROOM, so one room cannot starve the other;
 *   * per DOCUMENT, on the number of distinct rooms, which is what turns the
 *     renderer-supplied owner into a partition rather than an escape hatch;
 *   * GLOBAL and unsettled, which is the one that counts the actual resource.
 *
 * ## Capacity is freed at settlement, never at abort
 *
 * `abort()` asks a connection to end. It does not end it — the fetch rejects a
 * tick later, and the socket closes when it closes. A registry that decremented
 * on abort would let a fault abort in a loop and keep every connection while
 * the ledger reported none. So `release()` is called from the request's
 * `finally`, and only from there.
 */
export class IceRequestRegistry {
  readonly #documents = new Map<number, Map<string, RoomGroup>>();
  #inFlight = 0;

  /** Unsettled requests, over everything. The number the global bound is on. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Distinct rooms currently holding a request, for one document. */
  roomCount(generation: number): number {
    return this.#documents.get(generation)?.size ?? 0;
  }

  admit(generation: number, owner: string): IceRequestLease {
    if (this.#inFlight >= MAX_ICE_REQUESTS_IN_FLIGHT) {
      throw new IceAdmissionError("too many ICE reads in flight");
    }
    let rooms = this.#documents.get(generation);
    if (!rooms) {
      rooms = new Map();
      this.#documents.set(generation, rooms);
    }
    let group = rooms.get(owner);
    if (!group) {
      if (rooms.size >= MAX_ICE_ROOMS_PER_DOCUMENT) {
        throw new IceAdmissionError("too many ICE rooms for this document");
      }
      group = { controllers: new Set() };
      rooms.set(owner, group);
    }
    if (group.controllers.size >= MAX_ICE_REQUESTS_PER_ROOM) {
      throw new IceAdmissionError("too many ICE reads for this room");
    }

    const controller = new AbortController();
    group.controllers.add(controller);
    this.#inFlight += 1;

    // Captured by IDENTITY. `abortRoom` drops the group from the map while its
    // requests are still unsettled, and the room may immediately open a
    // REPLACEMENT group under the same owner name. Releasing by name would then
    // delete the live group on behalf of a request that was aborted before it —
    // leaving the live request's capacity untracked and its controller
    // unreachable, which is a request nothing can ever abort again. Measured
    // against the frozen implementation; see `ice-admission-repro.mjs`.
    const ownedRooms = rooms;
    const ownedGroup = group;
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.#inFlight -= 1;
        ownedGroup.controllers.delete(controller);
        if (ownedGroup.controllers.size > 0) return;
        // Only if this group is still the one registered under that name.
        if (ownedRooms.get(owner) === ownedGroup) ownedRooms.delete(owner);
        if (ownedRooms.size === 0 && this.#documents.get(generation) === ownedRooms) {
          this.#documents.delete(generation);
        }
      },
    };
  }

  /** This room is done. Its requests are asked to end; their capacity is freed
   *  when they actually settle. */
  abortRoom(generation: number, owner: string): void {
    const rooms = this.#documents.get(generation);
    const group = rooms?.get(owner);
    if (!rooms || !group) return;
    rooms.delete(owner);
    if (rooms.size === 0) this.#documents.delete(generation);
    for (const controller of group.controllers) controller.abort();
  }

  /** This document is gone. */
  abortDocument(generation: number): void {
    const rooms = this.#documents.get(generation);
    if (!rooms) return;
    this.#documents.delete(generation);
    for (const group of rooms.values()) {
      for (const controller of group.controllers) controller.abort();
    }
  }

  /** Teardown. */
  abortAll(): void {
    for (const generation of [...this.#documents.keys()]) this.abortDocument(generation);
  }
}
