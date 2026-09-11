// Consent to interrupt the running app, as the HOST grants it.
//
// ## Why this is a module and not a closure in `handlers.ts`
//
// It was a closure, and the test for it was a handwritten copy of that closure.
// A copy asserts that the copy behaves; it stays green while the thing it was
// copied from regresses, which is the one property a regression test may not
// have. So the adapter lives here, `handlers.ts` imports it, and the tests
// import the same function — there is one implementation and everything points
// at it.
//
// ## What it is actually deciding
//
// A grant is permission to REPLACE a running application. Two things must be
// true at the moment it is given, and both were wrong before an independent
// probe found them:
//
//   1. somebody must still want it. The prompt is a native dialog a person
//      reads for seconds or minutes, and the install can be cancelled inside
//      that window. Checking the signal only on the way IN meant an abandoned
//      install still tore down every transfer, lease and socket the user had,
//      and then returned a grant nobody was waiting for. The core's own
//      late-grant check cannot help: it runs after the host has already stopped
//      everything, so the interruption has happened by then.
//
//   2. the app must actually have stopped. `quiesce` REPORTS what it could not
//      stop, and granting regardless would launch an installer over a live
//      transfer, an unfinished open, or a socket whose close was never seen.
//      Every count is read, because picking one would be choosing which kind of
//      loss is acceptable.
//
// ## The exclusion
//
// This runs WHILE `UpdateService.install` awaits it, so the quiesce it asks for
// must skip the update facade — and therefore the core inside it, which is the
// thing waiting for this answer. A single-flight guard would not save that: the
// wait is circular, not re-entrant.
import type { CleanupOutcome } from "../app-service.js";
import type { QuiesceConsent, QuiesceDecision, QuiesceRequest } from "./contracts.js";

export interface HostConsentDeps {
  /**
   * Ask the person. Native, every time.
   *
   * Consent to close somebody's app has no default and cannot be remembered. A
   * host that cannot ask returns false, and no install proceeds.
   */
  confirm(): Promise<boolean>;
  /**
   * Stop everything EXCEPT the update. See the note on the exclusion above.
   *
   * Returns what it could not stop; the counts decide.
   */
  quiesce(exclude: "update"): Promise<CleanupOutcome>;
  /** Give the app back. May throw, and that is reported rather than assumed. */
  resume(): void;
  reportFailure?(err: unknown): void;
}

/** Total work the cleanup could not settle. Every count, deliberately. */
export function unsettledWork(cleanup: CleanupOutcome): number {
  return cleanup.openLeases + cleanup.opening + cleanup.unresolved + cleanup.networkUnsettled;
}

export function hostQuiesceConsent(deps: HostConsentDeps): QuiesceConsent {
  /**
   * Give the app back after a grant that is not being given.
   *
   * The outcome is carried into the refusal reason rather than swallowed: an
   * app left quiesced is not a healthy one, and reporting a failed resume as
   * healthy would hide an app that a REFUSED install disabled.
   */
  const giveBack = (): "resumed" | "unknown" => {
    try {
      deps.resume();
      return "resumed";
    } catch (err) {
      deps.reportFailure?.(err);
      return "unknown";
    }
  };

  /**
   * The refusal reason, in the grammar the summary already speaks.
   *
   * ## Why a failed resume must say `not-resumed`
   *
   * `reasonOf` maps every reason it does not recognise to `other`, which is
   * what stops a host string leaking to a page. My first spelling —
   * `work-unsettled:unknown`, `quiesce-failed:unknown` — was therefore reduced
   * to `other`, and the page said "something went wrong" over an app that had
   * been STOPPED AND NOT STARTED AGAIN. The one fact the user most needed was
   * the one the boundary dropped.
   *
   * `not-resumed` and `not-resumed:<detail>` are already in that closed set,
   * with copy of their own. So every branch where the app was stopped and the
   * resume FAILED speaks it, and the detail says which branch — a closed token,
   * never an error message.
   *
   * A branch that resumed successfully keeps its own generic reason: the app is
   * working, and `not-resumed` would be false.
   */
  const refusal = (cause: "work-unsettled" | "quiesce-failed" | "aborted", outcome: "resumed" | "unknown") =>
    outcome === "unknown" ? `not-resumed:${cause}` : `${cause}:resumed`;

  return {
    async request(request: QuiesceRequest): Promise<QuiesceDecision> {
      if (request.signal.aborted) return { granted: false, reason: "aborted" };

      const wanted = await deps.confirm();
      if (!wanted) return { granted: false, reason: "declined" };

      // Re-checked AFTER the prompt and BEFORE anything is torn down. See (1).
      if (request.signal.aborted) return { granted: false, reason: "aborted" };

      // ## A quiesce that THROWS has still stopped things
      //
      // By the time it rejects it has fenced admissions and asked every feature
      // to stop; the rejection says it could not finish, not that it did
      // nothing. Letting the exception escape meant `UpdateService.install`
      // caught it as `install-deferred/platform-error` with the lease already
      // null — so NOBODY resumed, and the app was left stopped with no install
      // to show for it. The non-zero-count path below always gave the app back;
      // this one has to do the same.
      let cleanup: CleanupOutcome;
      try {
        cleanup = await deps.quiesce("update");
      } catch (err) {
        deps.reportFailure?.(err);
        return { granted: false, reason: refusal("quiesce-failed", giveBack()) };
      }
      if (unsettledWork(cleanup) > 0 || request.signal.aborted) {
        return {
          granted: false,
          reason: refusal(request.signal.aborted ? "aborted" : "work-unsettled", giveBack()),
        };
      }

      return {
        granted: true,
        lease: {
          async release(reason: string) {
            const outcome = giveBack();
            return outcome === "resumed" ? { outcome: "resumed" } : { outcome: "unknown", detail: reason };
          },
        },
      };
    },
  };
}
