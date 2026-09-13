// The policy in force, and how it is arrived at.
//
// Three inputs, in decreasing order of authority, and the order is the whole
// design:
//
//  1. A document served now, if it decodes against this build's floor and the
//     replay barrier.
//  2. The document this device remembered, re-decoded the same way.
//  3. The floor compiled into this build.
//
// Every step down is silent and safe. A network that is down, an origin that is
// hostile, a cache that is corrupt, a document from a newer schema — each of
// them lands on the floor, and the floor cannot block the build carrying it.
// That is `client-policy.ts` invariant 1, and this module is where it is
// actually delivered: a policy source that could throw on start-up would be a
// policy source that can stop the app.
//
// **Nothing here reads a URL from the document.** The address is composed from
// this build's own origin, and `decodePolicy` drops every field it was not
// asked for. A document fetched over the network cannot move where the next one
// is fetched from, and cannot name where an update comes from.
import { boundedGet, HttpError } from "../net/bounded-get.js";
import {
  decodePolicy,
  EMBEDDED_FLOOR,
  MAX_POLICY_BYTES,
  type ClientPolicy,
} from "./client-policy.js";
import { NO_MEMORY, type PolicyMemory, type PolicyStore } from "./policy-store.js";

/** Where the document lives, relative to the app's own origin. */
export const POLICY_PATH = "/api/client-policy/windows";

/** Generous for a few hundred bytes, short enough not to hold up a launch. */
export const POLICY_TIMEOUT_MS = 8_000;

/** Where the policy in force came from. For a log line, never for a decision. */
export type PolicyOrigin = "served" | "remembered" | "floor";

export interface PolicyResolution {
  readonly policy: ClientPolicy;
  readonly origin: PolicyOrigin;
  /** The barrier after this resolution. Persisted with an accepted document. */
  readonly acceptedRevision: number;
}

export interface PolicySourceDeps {
  readonly origin: string;
  readonly store: PolicyStore;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Decode a document, or answer `null`.
 *
 * Every refusal is the same outcome here — fall back — so the taxonomy stays in
 * `PolicyError` for a caller that wants to log it, and this returns a value
 * rather than throwing. A policy path that throws is a policy path that can
 * take the app with it.
 */
function decodeOrNull(document: unknown, barrier: number): ClientPolicy | null {
  if (document === null || document === undefined) return null;
  try {
    return decodePolicy(document, barrier);
  } catch {
    return null;
  }
}

/**
 * What this device remembers, re-decoded against THIS build's floor.
 *
 * Never throws, and never lowers the barrier: a remembered document this build
 * refuses still leaves its revision standing, because it was accepted once and
 * forgetting that reopens the replay.
 */
export function fromMemory(memory: PolicyMemory): PolicyResolution {
  const remembered = decodeOrNull(memory.document, memory.acceptedRevision);
  if (remembered === null) {
    return {
      policy: EMBEDDED_FLOOR,
      origin: "floor",
      acceptedRevision: Math.max(memory.acceptedRevision, EMBEDDED_FLOOR.revision),
    };
  }
  return { policy: remembered, origin: "remembered", acceptedRevision: remembered.revision };
}

export class PolicySource {
  readonly #deps: PolicySourceDeps;

  constructor(deps: PolicySourceDeps) {
    this.#deps = deps;
  }

  /**
   * The policy to run under right now.
   *
   * Reads the cache first and answers from it if the network says nothing
   * useful, so a launch is never held hostage to an origin. The served document
   * is only ever an improvement on what is already known.
   */
  async resolve(signal?: AbortSignal): Promise<PolicyResolution> {
    const memory = await this.#deps.store.read().catch(() => NO_MEMORY);
    const remembered = fromMemory(memory);

    const document = await this.#fetchDocument(signal);
    if (document === null) return remembered;

    // Held against the barrier the MEMORY established, not the floor's: that is
    // what makes a rolled-back document a replay rather than an update.
    const served = decodeOrNull(document, remembered.acceptedRevision);
    if (served === null) return remembered;

    await this.#deps.store.write({ document, acceptedRevision: served.revision });
    return { policy: served, origin: "served", acceptedRevision: served.revision };
  }

  /** The document, or `null` for every failure there is. */
  async #fetchDocument(signal: AbortSignal | undefined): Promise<unknown> {
    const url = `${this.#deps.origin}${POLICY_PATH}`;
    // https only, and composed here rather than read from anywhere: a plaintext
    // origin would let the network decide whether this build may run.
    if (!url.startsWith("https://")) return null;
    let bytes: Uint8Array;
    try {
      bytes = await boundedGet(
        this.#deps.fetchImpl ?? fetch,
        url,
        MAX_POLICY_BYTES,
        this.#deps.timeoutMs ?? POLICY_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      // Including `HttpError`. Every transport outcome is the same outcome for
      // a policy: run under what is already known.
      void (error instanceof HttpError);
      return null;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }
}
