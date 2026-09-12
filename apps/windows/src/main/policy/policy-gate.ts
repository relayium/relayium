// The gate: what this process does with the policy it resolved.
//
// ## Two speeds, and the slow one is deliberate
//
// Reading the cache is local and immediate. Fetching is not, and `appInfo` is
// on the path to the first paint — awaiting an 8-second timeout there would
// hold a launch open for a slow origin, which is the failure this whole
// mechanism exists to avoid rather than to cause.
//
// So: this launch is judged by what the device already remembers, and the
// network refresh runs behind it and writes the cache for the NEXT launch.
//
// **That is weaker than macOS, and it is recorded rather than glossed.** The
// Mac's model is observable and re-renders the moment a document lands, so a
// floor published now takes effect now. Here it takes effect on the next start.
// Closing that difference needs a push to the shell and is a separate batch;
// what is here is a real lever — an emergency floor reaches every client that
// restarts — and it is the half that cannot be added later, because it has to
// be in the binary before the binary ships.
import {
  EMBEDDED_FLOOR,
  supportState,
  thisBuild,
  type ClientPolicy,
  type SupportState,
} from "./client-policy.js";
import { fromMemory, type PolicySource } from "./policy-source.js";
import { NO_MEMORY, type PolicyStore } from "./policy-store.js";

/**
 * What the shell is told. Versions as text, for the sentence a person reads.
 *
 * Both `blocked` and `recommended` have a surface now: the first replaces the
 * product, the second is a dismissible line above it, exactly as macOS does it.
 * Neither is reachable while the shipped floor is inert.
 */
export interface SupportReport {
  readonly state: SupportState;
  /** This build. */
  readonly current: string;
  /** The floor in force, so the screen can say what is required. */
  readonly minimum: string;
  /** The newest published version, so the screen can say what to move to. */
  readonly latest: string;
}

const asText = (version: readonly [number, number, number]): string => version.join(".");

export function report(version: string, policy: ClientPolicy): SupportReport {
  return {
    state: supportState(thisBuild(version), policy),
    current: version,
    minimum: asText(policy.minimumSupported),
    latest: asText(policy.latest),
  };
}

export interface PolicyGateDeps {
  readonly version: string;
  readonly store: PolicyStore;

  /** Absent in a build with no network policy source, which is every build
   *  until an endpoint is served. Its absence is not a failure. */
  readonly source?: PolicySource;
}

export class PolicyGate {
  #report: SupportReport;
  readonly #deps: PolicyGateDeps;

  private constructor(deps: PolicyGateDeps, initial: SupportReport) {
    this.#deps = deps;
    this.#report = initial;
  }

  /**
   * Judge this launch from the cache, and never throw.
   *
   * A store that cannot be read is no memory, and no memory is the floor. The
   * one thing this must not do is prevent a start.
   */
  static async open(deps: PolicyGateDeps): Promise<PolicyGate> {
    const memory = await deps.store.read().catch(() => NO_MEMORY);
    const resolved = fromMemory(memory);
    return new PolicyGate(deps, report(deps.version, resolved.policy));
  }

  #listeners = new Set<(report: SupportReport) => void>();

  /**
   * Hear about a change, and only a change.
   *
   * A method rather than a constructor dependency because the gate is opened
   * before the IPC router exists — the launch has to be judged before a window
   * loads, and the thing that would listen is built after.
   *
   * The gap this closes: the launch is judged from the CACHE, so without a push
   * a floor published now took effect on the next start. macOS re-renders the
   * moment a document lands.
   */
  listen(cb: (report: SupportReport) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** What `appInfo` carries. Synchronous by construction. */
  current(): SupportReport {
    return this.#report;
  }

  /** Whether this build may run its product surfaces. */
  get blocked(): boolean {
    return this.#report.state === "blocked";
  }

  /**
   * Refresh from the network, for the next launch.
   *
   * Deliberately not awaited by anything on the launch path, and deliberately
   * unable to throw: its only job is to leave a better cache behind. It updates
   * this process's own report, and tells `onChange` when the answer actually
   * moved — which is what lets a floor published now take effect now rather
   * than on the next start.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    const source = this.#deps.source;
    if (source === undefined) return;
    try {
      const resolved = await source.resolve(signal);
      const next = report(this.#deps.version, resolved.policy);
      const changed =
        next.state !== this.#report.state ||
        next.minimum !== this.#report.minimum ||
        next.latest !== this.#report.latest;
      this.#report = next;
      // Outside the comparison on purpose: a listener that throws must not make
      // `refresh` look like a failed refresh. Its own errors are its own.
      if (changed) {
        for (const listener of [...this.#listeners]) {
          try {
            listener(next);
          } catch {
            /* a shell that cannot take the news is not this gate's problem */
          }
        }
      }
    } catch {
      /* the cache and the floor already answered; a refresh cannot make it worse */
    }
  }
}

/** The report a build with no gate at all would produce. For tests and for a
 *  composition that has not opened one. */
export const FLOOR_REPORT = (version: string): SupportReport => report(version, EMBEDDED_FLOOR);
