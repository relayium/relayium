// Consent to interrupt the running app, as the host actually grants it.
//
// Both cases below were found by an independent probe against this source, and
// both were real. They are about the same thing from two directions: a grant is
// permission to REPLACE a running application, and it may only be given when
// the app has genuinely stopped and somebody genuinely still wants it.
//
// The adapter under test is the PRODUCTION one: `hostQuiesceConsent`, the same
// function `handlers.ts` composes. Only its host dependencies — the native
// prompt, the quiesce and the resume — are faked, because those need an
// Electron main process and what matters here is the ORDER of its checks.
//
// An earlier version of this file re-implemented the adapter inline. That
// asserted the copy behaved and would have stayed green while the real one
// regressed, which is the one property a regression test may not have.

import { describe, expect, it } from "vitest";

import { hostQuiesceConsent } from "../../src/main/update/host-consent.js";
import { reasonOf } from "../../src/main/features/update-summary.js";
import type { CleanupOutcome } from "../../src/main/app-service.js";

const QUIET: CleanupOutcome = {
  openLeases: 0,
  opening: 0,
  unresolved: 0,
  networkUnsettled: 0,
  firstReason: null,
};

/**
 * The PRODUCTION adapter, with its host dependencies faked.
 *
 * Not a copy of it. The first version of this file re-implemented the adapter
 * inline, which asserted that the copy behaved and would have stayed green
 * while `handlers.ts` regressed — the one property a regression test may not
 * have. `hostQuiesceConsent` is the same function the host composes.
 */
function consentWith(host: {
  confirm(): Promise<boolean>;
  quiesce(exclude?: "update"): Promise<CleanupOutcome>;
  resume(): void;
  report?(err: unknown): void;
}) {
  return hostQuiesceConsent({
    confirm: host.confirm,
    quiesce: (exclude) => host.quiesce(exclude),
    resume: host.resume,
    ...(host.report === undefined ? {} : { reportFailure: host.report }),
  });
}

describe("an install cancelled while the person is reading the prompt", () => {
  it("stops nothing and grants nothing", async () => {
    // The window that matters: a person takes seconds or minutes to answer, and
    // the install can be abandoned inside it. Checking only on the way IN meant
    // an abandoned install still tore down every transfer, lease and socket the
    // user had — and then granted permission nobody was waiting for. The core's
    // own late-grant check cannot prevent this: it runs after the host has
    // already stopped everything.
    const control = new AbortController();
    const quiesced: string[] = [];
    const consent = consentWith({
      async confirm() {
        // Cancelled while the dialog is up.
        control.abort();
        return true;
      },
      async quiesce(exclude) {
        quiesced.push(exclude ?? "all");
        return QUIET;
      },
      resume: () => quiesced.push("resume"),
    });

    const decision = await consent.request({ excludeToken: "job-1", signal: control.signal });
    expect(decision.granted).toBe(false);
    // NOTHING was quiesced: the user's work is untouched.
    expect(quiesced).toEqual([]);
  });

  it("still refuses when the abort lands during the quiesce itself", async () => {
    const control = new AbortController();
    let resumed = 0;
    const consent = consentWith({
      confirm: async () => true,
      async quiesce() {
        control.abort();
        return QUIET;
      },
      resume: () => {
        resumed += 1;
      },
    });
    const decision = await consent.request({ excludeToken: "job-1", signal: control.signal });
    expect(decision.granted).toBe(false);
    expect(decision.granted === false && decision.reason).toBe("aborted:resumed");
    // The app was stopped for a grant that is not being given, so it is given
    // back rather than left quiesced.
    expect(resumed).toBe(1);
  });
});

describe("work the quiesce could not stop", () => {
  const cases: readonly (readonly [string, CleanupOutcome])[] = [
    ["a lease that refused to let go", { ...QUIET, openLeases: 1 }],
    ["an open still being created", { ...QUIET, opening: 1 }],
    ["a destination whose cleanup failed", { ...QUIET, unresolved: 1 }],
    ["a socket whose close was never seen", { ...QUIET, networkUnsettled: 1 }],
  ];

  for (const [what, cleanup] of cases) {
    it(`refuses the install over ${what}`, async () => {
      // Granting regardless would launch an installer over live work and
      // replace the app while it still held something it had told nobody
      // about. EVERY count is read: picking one would be choosing which kind
      // of loss is acceptable.
      let resumed = 0;
      const consent = consentWith({
        confirm: async () => true,
        quiesce: async () => cleanup,
        resume: () => {
          resumed += 1;
        },
      });
      const decision = await consent.request({
        excludeToken: "job-1",
        signal: new AbortController().signal,
      });
      expect(decision.granted).toBe(false);
      expect(decision.granted === false && decision.reason).toBe("work-unsettled:resumed");
      expect(resumed).toBe(1);
    });
  }

  it("reports NOT-RESUMED when giving the app back also fails", async () => {
    // An app left quiesced is not a healthy one, and saying "resumed" over it
    // would hide an app a refused install disabled.
    const reported: unknown[] = [];
    const consent = consentWith({
      confirm: async () => true,
      quiesce: async () => ({ ...QUIET, openLeases: 1 }),
      resume: () => {
        throw new Error("resume failed");
      },
      report: (err) => reported.push(err),
    });
    const decision = await consent.request({
      excludeToken: "job-1",
      signal: new AbortController().signal,
    });
    // `not-resumed:` is the grammar the summary already speaks — see the
    // composition cases at the end of this file. The earlier spelling was
    // reduced to `other` by `reasonOf`, which lost exactly the fact that
    // mattered.
    expect(decision.granted === false && decision.reason).toBe("not-resumed:work-unsettled");
    expect(reported).toHaveLength(1);
  });
});

describe("the grant that IS given", () => {
  it("comes only after a quiet cleanup that excluded the update itself", async () => {
    const excluded: (string | undefined)[] = [];
    const consent = consentWith({
      confirm: async () => true,
      async quiesce(exclude) {
        excluded.push(exclude);
        return QUIET;
      },
      resume: () => undefined,
    });
    const decision = await consent.request({
      excludeToken: "job-1",
      signal: new AbortController().signal,
    });
    expect(decision.granted).toBe(true);
    // The exclusion is what stops the install waiting on its own quiesce.
    expect(excluded).toEqual(["update"]);
  });

  it("is never given without a yes", async () => {
    const quiesced: string[] = [];
    const consent = consentWith({
      confirm: async () => false,
      async quiesce() {
        quiesced.push("quiesce");
        return QUIET;
      },
      resume: () => undefined,
    });
    const decision = await consent.request({
      excludeToken: "job-1",
      signal: new AbortController().signal,
    });
    expect(decision.granted).toBe(false);
    expect(decision.granted === false && decision.reason).toBe("declined");
    // A refusal stops nothing either: the app carries on as it was.
    expect(quiesced).toEqual([]);
  });
});

describe("a cleanup that fails outright", () => {
  it("still gives the app back, and grants nothing", async () => {
    // By the time `quiesce` rejects it has already fenced admissions and asked
    // every feature to stop — the rejection says it could not FINISH, not that
    // it did nothing. Letting the exception escape meant the core caught it as
    // `platform-error` with the lease already null, so nobody resumed and the
    // app was left stopped with no install to show for it.
    let resumed = 0;
    const reported: unknown[] = [];
    const consent = consentWith({
      confirm: async () => true,
      quiesce: async () => {
        throw new Error("a feature refused to stop");
      },
      resume: () => {
        resumed += 1;
      },
      report: (err) => reported.push(err),
    });

    const decision = await consent.request({
      excludeToken: "job-1",
      signal: new AbortController().signal,
    });
    expect(decision.granted).toBe(false);
    expect(decision.granted === false && decision.reason).toBe("quiesce-failed:resumed");
    // The whole point: the app is working again.
    expect(resumed).toBe(1);
    // And the failure was reported rather than swallowed into a closed code.
    expect(reported).toHaveLength(1);
  });

  it("reports NOT-RESUMED when the resume after it also fails", async () => {
    // Two failures in a row, and the second is the one the user feels: an app
    // left quiesced is not a healthy one, and saying "resumed" over it would
    // hide an app that a FAILED INSTALL ATTEMPT disabled.
    const reported: unknown[] = [];
    const consent = consentWith({
      confirm: async () => true,
      quiesce: async () => {
        throw new Error("a feature refused to stop");
      },
      resume: () => {
        throw new Error("resume failed too");
      },
      report: (err) => reported.push(err),
    });

    const decision = await consent.request({
      excludeToken: "job-1",
      signal: new AbortController().signal,
    });
    expect(decision.granted === false && decision.reason).toBe("not-resumed:quiesce-failed");
    // BOTH failures are reported: the one that stopped the app and the one that
    // could not start it again.
    expect(reported).toHaveLength(2);
  });

  it("never installs over a cleanup it could not complete", async () => {
    // The refusal is what matters most here. A grant would launch an installer
    // against an app whose own teardown just failed — the state in which it is
    // least able to say what it is still holding.
    const consent = consentWith({
      confirm: async () => true,
      quiesce: async () => {
        throw new Error("cleanup exploded");
      },
      resume: () => undefined,
    });
    const decision = await consent.request({
      excludeToken: "job-1",
      signal: new AbortController().signal,
    });
    expect(decision.granted).toBe(false);
    expect("lease" in decision).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the PAGE is told when the app was not started again
// ---------------------------------------------------------------------------
//
// The adapter and the boundary have to agree, and a unit that only read the
// adapter's string could not see that they did not. `reasonOf` maps anything it
// does not recognise to `other` — deliberately, so a host string cannot leak —
// and my first spelling of these reasons was therefore reduced to a generic
// "something went wrong" over an app that had been STOPPED AND NEVER STARTED
// AGAIN. The one fact the user most needed was the one that got dropped.
//
// So these compose: the REAL adapter produces the reason, and the REAL
// `reasonOf` maps it.

describe("a refusal whose resume also failed", () => {
  /** Refuse through the real adapter, and map through the real boundary. */
  async function refusalReason(host: {
    quiesce(): Promise<CleanupOutcome>;
    resume(): void;
    signal?: AbortSignal;
  }) {
    const consent = consentWith({
      confirm: async () => true,
      quiesce: host.quiesce,
      resume: host.resume,
      report: () => undefined,
    });
    const decision = await consent.request({
      excludeToken: "job-1",
      signal: host.signal ?? new AbortController().signal,
    });
    if (decision.granted) throw new Error("expected a refusal");
    return { raw: decision.reason, mapped: reasonOf(decision.reason) };
  }

  const failingResume = () => {
    throw new Error("resume failed");
  };

  it("says NOT-RESUMED when the cleanup could not be completed", async () => {
    const { raw, mapped } = await refusalReason({
      quiesce: async () => {
        throw new Error("cleanup exploded");
      },
      resume: failingResume,
    });
    expect(mapped).toBe("not-resumed");
    // The detail says WHICH branch, and is a closed token — never an error
    // message, which is what the boundary exists to keep out.
    expect(raw).toBe("not-resumed:quiesce-failed");
  });

  it("says NOT-RESUMED when work was left unsettled", async () => {
    const { raw, mapped } = await refusalReason({
      quiesce: async () => ({ ...QUIET, openLeases: 1 }),
      resume: failingResume,
    });
    expect(mapped).toBe("not-resumed");
    expect(raw).toBe("not-resumed:work-unsettled");
  });

  it("says NOT-RESUMED when the install was abandoned during the cleanup", async () => {
    const control = new AbortController();
    const { raw, mapped } = await refusalReason({
      quiesce: async () => {
        control.abort();
        return QUIET;
      },
      resume: failingResume,
      signal: control.signal,
    });
    expect(mapped).toBe("not-resumed");
    expect(raw).toBe("not-resumed:aborted");
  });

  it("does NOT claim not-resumed when the app really did come back", async () => {
    // The app is working, so `not-resumed` would be false. A generic reason is
    // correct here: nothing is owed to the user beyond "it did not install".
    const { raw, mapped } = await refusalReason({
      quiesce: async () => ({ ...QUIET, networkUnsettled: 1 }),
      resume: () => undefined,
    });
    expect(mapped).not.toBe("not-resumed");
    expect(raw).toBe("work-unsettled:resumed");
  });

  it("carries no error text in any of them", async () => {
    // Every suffix is a closed token chosen by this adapter. A thrown message
    // routinely contains a path, and none of these reasons may carry one.
    const secret = "C:\\Users\\somebody\\Private";
    const { raw } = await refusalReason({
      quiesce: async () => {
        throw new Error(`cleanup failed at ${secret}`);
      },
      resume: () => {
        throw new Error(`resume failed at ${secret}`);
      },
    });
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("Users");
    expect(raw).toBe("not-resumed:quiesce-failed");
  });
});
