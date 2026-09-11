// Hiding keeps the app; quitting asks first, and Stay leaves it usable.
//
// The pure modules decide (`quit.ts`, `first-run.ts`); this is the composition,
// so what is asserted here is ORDER and CONSEQUENCE: what is torn down, when,
// what an unanswerable page produces, and what survives a Stay.

import { describe, expect, it, vi } from "vitest";
import { ResidentRuntime, type ResidentPlatform } from "../../src/main/resident-runtime.js";
import type { ResidentBridge } from "../../src/main/handlers.js";
import type { CleanupOutcome } from "../../src/main/app-service.js";
import type { ResidentAck, ResidentCommand, ResidentSnapshot } from "../../src/shared/ipc-contract.js";
import { EN, ZH_HANS } from "../../src/main/l10n.js";

/** A page that answers, or one that cannot be reached. */
function fakeBridge(options: {
  snapshot?: ResidentSnapshot | "unknown";
  refuse?: ResidentCommand["kind"][];
} = {}) {
  const sent: ResidentCommand[] = [];
  const bridge: ResidentBridge = {
    async send(command): Promise<ResidentAck | "unavailable"> {
      sent.push(command);
      if (options.snapshot === "unknown") return "unavailable";
      if (options.refuse?.includes(command.kind)) {
        return { requestId: "rq", generation: 0, ok: false, failure: "refused" };
      }
      const snapshot = options.snapshot ?? { sending: false, receiving: false, drafts: 0, locale: "en", nearby: false };
      return command.kind === "risk-snapshot" || command.kind === "quiesce"
        ? { requestId: "rq", generation: 0, ok: true, snapshot }
        : { requestId: "rq", generation: 0, ok: true };
    },
    lastSnapshot: () => null,
    async freshSnapshot() {
      const ack = await bridge.send({ kind: "risk-snapshot" });
      if (ack === "unavailable" || !ack.ok || !ack.snapshot) return "unknown";
      return ack.snapshot;
    },
  };
  return { bridge, sent };
}

const CLEAN: CleanupOutcome = {
  openLeases: 0,
  opening: 0,
  unresolved: 0,
  networkUnsettled: 0,
  firstReason: null,
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeService(outcome: CleanupOutcome = CLEAN, held = 0) {
  const calls: string[] = [];
  return {
    calls,
    outcome,
    service: {
      fenceReceives: () => calls.push("fence"),
      admitReceives: () => calls.push("admit"),
      resume: () => calls.push("resume"),
      cleanupOutcome: () => outcome,
      get heldReceiveCount() {
        return held;
      },
    } as never,
    /** What `HandlerControl.fence` composes: every admission fence, in one
     *  place. The runtime calls THIS, not the lease service's own fence, so a
     *  feature that is not covered here is a visible omission. */
    fence: () => {
      calls.push("fence");
    },
    quiesce: async () => {
      calls.push("quiesce");
      return outcome;
    },
    /** What `HandlerControl.resume` composes: every fence, in one place. */
    resume: () => {
      calls.push("resume");
      calls.push("admit");
    },
  };
}

function fakePlatform(over: Partial<ResidentPlatform> = {}) {
  const events: string[] = [];
  const platform: ResidentPlatform = {
    show: () => events.push("show"),
    hide: () => events.push("hide"),
    exit: () => events.push("exit"),
    askFirstClose: async () => 0,
    confirm: async () => true,
    notify: (title) => events.push(`notify:${title}`),
    showStopped: (notice) => events.push(`stopped:${notice.title}`),
    isFocused: () => false,
    readAcknowledged: () => true,
    writeAcknowledged: () => undefined,
    reportFailure: () => events.push("failure"),
    ...over,
  };
  return { platform, events };
}

function runtime(
  over: {
    bridge?: ResidentBridge;
    service?: never;
    fence?: () => void;
    quiesce?: () => Promise<CleanupOutcome>;
    resume?: () => void;
    platform?: ResidentPlatform;
    dispose?: () => Promise<void>;
    drainAbandoned?: () => Promise<number>;
    setInboxPaused?: (paused: boolean) => void;
    inboxPaused?: () => boolean;
  } = {},
) {
  const { bridge } = fakeBridge();
  const fake = fakeService();
  const { platform } = fakePlatform();
  return new ResidentRuntime({
    service: over.service ?? fake.service,
    resident: over.bridge ?? bridge,
    platform: over.platform ?? platform,
    fence: over.fence ?? fake.fence,
    quiesce: over.quiesce ?? fake.quiesce,
    resume: over.resume ?? fake.resume,
    dispose: over.dispose ?? (async () => undefined),
    ...(over.drainAbandoned ? { drainAbandoned: over.drainAbandoned } : {}),
    // Main's own service in production. Inert here: these cases are about the
    // window's lifecycle, and a runtime that silently had no inbox control
    // would offer a tray item that does nothing.
    setInboxPaused: over.setInboxPaused ?? (() => undefined),
    inboxPaused: over.inboxPaused ?? (() => false),
    locale: "en",
  });
}

describe("closing the window is not quitting", () => {
  it("hides, and tears nothing down", async () => {
    const { platform, events } = fakePlatform();
    const { service, calls } = fakeService();
    const dispose = vi.fn(async () => undefined);
    const app = runtime({ platform, service: service as never, dispose });

    expect((await app.onWindowClose()).action).toBe("hide");
    expect(events).toContain("hide");
    // Not one of these: the renderer, its rooms and its transfers survive.
    expect(calls).toEqual([]);
    expect(dispose).not.toHaveBeenCalled();
    expect(app.isQuitting).toBe(false);
  });

  it("leaves the window alone when the notice is cancelled", async () => {
    const { platform, events } = fakePlatform({
      readAcknowledged: () => false,
      askFirstClose: async () => 2,
    });
    const app = runtime({ platform });
    expect((await app.onWindowClose()).action).toBe("cancel");
    expect(events).not.toContain("hide");
    expect(events).not.toContain("exit");
  });

  it("does not hide when the notice itself could not be shown", async () => {
    // Hiding after a failed explanation delivers exactly the confusion the
    // notice exists to prevent.
    const { platform, events } = fakePlatform({
      readAcknowledged: () => false,
      askFirstClose: async () => {
        throw new Error("no display");
      },
    });
    const app = runtime({ platform });
    expect((await app.onWindowClose()).action).toBe("cancel");
    expect(events).not.toContain("hide");
  });
});

describe("quitting asks, and believes only an actual answer", () => {
  it("does not prompt when nothing is at stake, and quits", async () => {
    const confirm = vi.fn(async () => true);
    const { platform, events } = fakePlatform({ confirm });
    const dispose = vi.fn(async () => undefined);
    const app = runtime({ platform, dispose });

    expect(await app.requestQuit()).toBe("quit");
    expect(confirm).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events).toContain("exit");
  });

  it("fences BOTH halves before it asks, and keeps them fenced through the answer", async () => {
    const { service, calls, fence, quiesce, resume } = fakeService();
    let asked = false;
    const { platform } = fakePlatform({
      confirm: async () => {
        asked = true;
        // Fenced ALREADY: a receive that started while this dialog was up would
        // otherwise be stopped by a quit authorised when there was nothing to stop.
        expect(calls).toContain("fence");
        return true;
      },
    });
    const { bridge, sent } = fakeBridge({ snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: false } });
    const app = runtime({ platform, service: service as never, fence, quiesce, bridge });

    expect(await app.requestQuit()).toBe("quit");
    expect(asked).toBe(true);
    // The page was asked to start nothing BEFORE it was asked what is at stake:
    // an outgoing send begins in the page, so a snapshot taken without that
    // agreement describes a moment that can change before the quit lands.
    expect(sent.map((c) => c.kind).slice(0, 2)).toEqual(["admission", "risk-snapshot"]);
    // Never re-admitted on the way out.
    expect(calls).not.toContain("admit");
  });

  it("fences main BEFORE it awaits the page, and never waits on the page to do it", async () => {
    // The page is slow — held, not stale, which is the harder case: it answers
    // eventually, so nothing times out and main simply WAITS. Every await in
    // `runQuit` is behind this one.
    const release = deferred<void>();
    const { service, calls, fence, quiesce, resume } = fakeService();
    let fencedWhileHeld: readonly string[] = [];
    const bridge: ResidentBridge = {
      async send(command) {
        if (command.kind === "admission" && command.action === "fence") {
          // Main's own admission must ALREADY be closed at this point: it is a
          // fact about main, and a renderer acknowledgement is not what makes
          // it true. A page that never answers must not leave main admitting.
          fencedWhileHeld = [...calls];
          await release.promise;
        }
        return { requestId: "rq", generation: 0, ok: true };
      },
      lastSnapshot: () => null,
      freshSnapshot: async () => "unknown" as const,
    };
    const { platform } = fakePlatform({ confirm: async () => false });
    const app = runtime({ platform, service: service as never, fence, quiesce, resume, bridge });

    const deciding = app.requestQuit();
    await new Promise((r) => setTimeout(r, 10));
    expect(fencedWhileHeld).toEqual(["fence"]);
    // And nothing was decided while the page was being waited on: a held
    // renderer is not consent.
    expect(calls).not.toContain("quiesce");

    release.resolve();
    expect(await deciding).toBe("stay");
    // Stay lifts every fence, in one place.
    expect(calls).toEqual(["fence", "resume", "admit"]);
  });

  it("is UNKNOWN when the page would not agree to stop starting things", async () => {
    // The page answered the snapshot, but could not be fenced — so between that
    // answer and the quit it authorises, it can begin a send.
    const bridge: ResidentBridge = {
      async send(command) {
        if (command.kind === "admission") return { requestId: "rq", generation: 0, ok: false };
        return { requestId: "rq", generation: 0, ok: true };
      },
      lastSnapshot: () => null,
      freshSnapshot: async () => ({ sending: false, receiving: false, drafts: 0, locale: "en", nearby: false }),
    };
    const prompts: string[] = [];
    const { platform } = fakePlatform({
      confirm: async (prompt) => {
        prompts.push(prompt.title);
        return false;
      },
    });
    const app = runtime({ bridge, platform });

    expect(await app.requestQuit()).toBe("stay");
    expect(prompts).toEqual([EN["resident.quit.unknownTitle"]]);
  });

  it("counts what main holds beyond registered leases", async () => {
    // An open still inside the picker, or a destination whose cleanup failed,
    // is work this process is responsible for.
    const { service, fence, quiesce, resume } = fakeService(CLEAN, 1);
    const prompts: string[] = [];
    const { platform } = fakePlatform({
      confirm: async (prompt) => {
        prompts.push(prompt.title);
        return false;
      },
    });
    const app = runtime({ service: service as never, fence, quiesce, resume, platform });

    expect(await app.requestQuit()).toBe("stay");
    expect(prompts).toEqual([EN["resident.quit.transferTitle"]]);
  });

  it("treats an unreachable page as UNKNOWN, and still requires a real answer", async () => {
    const { bridge } = fakeBridge({ snapshot: "unknown" });
    const prompts: string[] = [];
    const { platform } = fakePlatform({
      confirm: async (prompt) => {
        prompts.push(prompt.title);
        return false;
      },
    });
    const app = runtime({ bridge, platform });

    expect(await app.requestQuit()).toBe("stay");
    // The unknown sentence, not a borrowed one that asserts unsent text exists.
    expect(prompts).toEqual([EN["resident.quit.unknownTitle"]]);
  });

  it("stays when the prompt is dismissed rather than answered", async () => {
    const { bridge } = fakeBridge({ snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: false } });
    const { platform, events } = fakePlatform({ confirm: async () => false });
    const app = runtime({ bridge, platform });

    expect(await app.requestQuit()).toBe("stay");
    expect(events).not.toContain("exit");
  });

  it("stays, and is USABLE again, when the user cancels", async () => {
    const { service, calls, fence, quiesce, resume } = fakeService();
    const { bridge, sent } = fakeBridge({ snapshot: { sending: false, receiving: false, drafts: 2, locale: "en", nearby: false } });
    const { platform } = fakePlatform({ confirm: async () => false });
    const app = runtime({ service: service as never, fence, quiesce, resume, bridge, platform });

    expect(await app.requestQuit()).toBe("stay");
    // Nothing was quiesced — the question was answered before any teardown —
    // and both fences were lifted.
    expect(calls).toEqual(["fence", "resume", "admit"]);
    expect(sent.map((c) => c.kind)).toEqual(["admission", "risk-snapshot", "admission", "resume"]);
    expect(sent.filter((c) => c.kind === "admission")).toEqual([
      { kind: "admission", action: "fence" },
      { kind: "admission", action: "admit" },
    ]);
  });

  it("runs ONE whole quit however many times it is requested", async () => {
    let asks = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { platform } = fakePlatform({
      confirm: async () => {
        asks += 1;
        await held;
        return false;
      },
    });
    const { bridge } = fakeBridge({ snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: false } });
    const app = runtime({ platform, bridge });

    const first = app.requestQuit();
    const second = app.requestQuit();
    const third = app.requestQuit();
    release();
    expect(await Promise.all([first, second, third])).toEqual(["stay", "stay", "stay"]);
    expect(asks).toBe(1);
  });

  it("disposes and exits ONCE for three concurrent requests", async () => {
    // The decision was already shared; the teardown was not. Three callers each
    // ran it, so the process was torn down three times and exited three times.
    const dispose = vi.fn(async () => undefined);
    const { platform, events } = fakePlatform();
    const app = runtime({ platform, dispose });

    const decisions = await Promise.all([app.requestQuit(), app.requestQuit(), app.requestQuit()]);
    expect(decisions).toEqual(["quit", "quit", "quit"]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e === "exit")).toHaveLength(1);
  });

  it("resumes ONCE for three concurrent requests that end in Stay", async () => {
    const { service, calls, fence, quiesce, resume } = fakeService();
    const { bridge } = fakeBridge({ snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: false } });
    const { platform } = fakePlatform({ confirm: async () => false });
    const app = runtime({ service: service as never, fence, quiesce, resume, bridge, platform });

    await Promise.all([app.requestQuit(), app.requestQuit(), app.requestQuit()]);
    expect(calls.filter((c) => c === "resume")).toHaveLength(1);
    expect(calls.filter((c) => c === "admit")).toHaveLength(1);

    // And a later, genuine quit is still possible.
    expect(await app.requestQuit()).toBe("stay");
  });
});

describe("cleanup is joined, and its failure is the user's decision", () => {
  it("stops the page first, then main, then the abandoned helpers", async () => {
    const order: string[] = [];
    const { service } = fakeService();
    const bridge: ResidentBridge = {
      async send(command) {
        if (command.kind === "quiesce") order.push("page");
        return { requestId: "rq", generation: 0, ok: true };
      },
      lastSnapshot: () => null,
      freshSnapshot: async () => ({ sending: false, receiving: false, drafts: 0, locale: "en", nearby: false }),
    };
    const app = runtime({
      service: service as never,
      quiesce: async () => {
        order.push("service");
        return CLEAN;
      },
      bridge,
      drainAbandoned: async () => {
        order.push("drain");
        return 0;
      },
    });

    expect(await app.requestQuit()).toBe("quit");
    // The drain tracks ABANDONED work only, so it cannot substitute for joining
    // what is still active — it has to come last.
    expect(order).toEqual(["page", "service", "drain"]);
  });

  it("asks again when cleanup left something behind, and Stay leaves the app usable", async () => {
    const { service, calls, fence, quiesce, resume } = fakeService({ openLeases: 1, opening: 0, unresolved: 2, networkUnsettled: 0, firstReason: "EBUSY" });
    const titles: string[] = [];
    const { platform, events } = fakePlatform({
      confirm: async (prompt) => {
        titles.push(prompt.title);
        // Yes to quitting, no to quitting over residue.
        return titles.length === 1;
      },
    });
    const { bridge } = fakeBridge({ snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: false } });
    const app = runtime({ service: service as never, fence, quiesce, resume, bridge, platform });

    expect(await app.requestQuit()).toBe("stay");
    expect(titles).toEqual([EN["resident.quit.transferTitle"], EN["resident.quit.residueTitle"]]);
    // Usable again: the service is resumed and admission restored, so the next
    // transfer and the next sign-in work.
    expect(calls).toEqual(["fence", "quiesce", "resume", "admit"]);
    expect(events).not.toContain("exit");
  });

  it("never renders the diagnostic reason", async () => {
    // `firstReason` is a filesystem error and routinely names a path. The
    // dialog gets closed copy and counts.
    const { service, fence, quiesce, resume } = fakeService({
      openLeases: 0,
      opening: 0,
      unresolved: 1,
      networkUnsettled: 0,
      firstReason: "EPERM: C:\\\\Users\\\\someone\\\\Desktop\\\\report.txt",
    });
    const bodies: string[] = [];
    const { platform } = fakePlatform({
      confirm: async (prompt) => {
        bodies.push(prompt.body, prompt.title);
        return true;
      },
    });
    const { bridge } = fakeBridge({ snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: false } });
    const app = runtime({ service: service as never, fence, quiesce, resume, bridge, platform });

    await app.requestQuit();
    for (const text of bodies) expect(text).not.toMatch(/EPERM|Users|report\.txt/);
  });
});

describe("what main pushes to the page, and what it tells the user", () => {
  it("suppresses a notification for something the user is looking at", () => {
    const { platform, events } = fakePlatform({ isFocused: () => true });
    const app = runtime({ platform });
    expect(app.notify({ kind: "saved", files: 2 })).toBe(false);
    // Attention is not suppressed: something is waiting for them.
    expect(app.notify({ kind: "attention" })).toBe(true);
    expect(events).toContain(`notify:${EN["resident.notify.attentionTitle"]}`);
  });

  it("shows the window before it navigates or offers a code", async () => {
    const { platform, events } = fakePlatform();
    const { bridge, sent } = fakeBridge();
    const app = runtime({ platform, bridge });

    expect(await app.openPage("inbox")).toBe(true);
    expect(await app.offerPairCode("004291", "text")).toBe(true);
    expect(events.filter((e) => e === "show")).toHaveLength(2);
    // The code keeps its leading zeros all the way to the page.
    expect(sent).toEqual([
      { kind: "navigate", page: "inbox" },
      { kind: "pair-code", code: "004291", mode: "text" },
    ]);
  });

  it("reports rather than pretends when the page refuses a command", async () => {
    const { bridge } = fakeBridge({ refuse: ["navigate"] });
    const app = runtime({ bridge });
    expect(await app.openPage("account")).toBe(false);
  });

  it("pauses and resumes Nearby from outside the page", async () => {
    const { bridge, sent } = fakeBridge();
    const app = runtime({ bridge });
    expect(await app.setLan("pause")).toBe(true);
    expect(await app.setLan("resume")).toBe(true);
    expect(sent).toEqual([
      { kind: "lan", action: "pause" },
      { kind: "lan", action: "resume" },
    ]);
  });
});

describe("the native surfaces follow the page's language", () => {
  it("switches catalogue when the page says which one it is showing", async () => {
    const titles: string[] = [];
    const { platform } = fakePlatform({
      confirm: async (prompt) => {
        titles.push(prompt.title);
        return false;
      },
    });
    const { bridge } = fakeBridge({
      snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: false },
    });
    let rebuilt = 0;
    const fake = fakeService();
    const app = new ResidentRuntime({
      service: fake.service,
      resident: bridge,
      platform,
      fence: fake.fence,
      quiesce: fake.quiesce,
      resume: fake.resume,
      dispose: async () => undefined,
      locale: "en",
      setInboxPaused: () => undefined,
      inboxPaused: () => false,
      onLocaleChanged: () => {
        rebuilt += 1;
      },
    });

    expect(app.trayMenu().map((e) => ("label" in e ? e.label : ""))[0]).toBe(EN["resident.tray.show"]);
    await app.requestQuit();

    app.setLocale("zh-Hans");
    // The tray is already on screen, so a language change has to rebuild it.
    expect(rebuilt).toBe(1);
    expect(app.trayMenu().map((e) => ("label" in e ? e.label : ""))[0]).toBe(
      ZH_HANS["resident.tray.show"],
    );

    await app.requestQuit();
    // The coordinators were built once, at construction, and still followed.
    expect(titles).toEqual([EN["resident.quit.transferTitle"], ZH_HANS["resident.quit.transferTitle"]]);
  });

  it("says what the Nearby tray item will do, from what the page reported", () => {
    const app = runtime();
    expect(app.trayMenu().some((e) => "label" in e && e.label === EN["resident.tray.resumeNearby"])).toBe(true);
    app.setNearbyActive(true);
    expect(app.trayMenu().some((e) => "label" in e && e.label === EN["resident.tray.pauseNearby"])).toBe(true);
  });
});

describe("notifications come from things that actually happened", () => {
  it("announces a completed publication with its real count", () => {
    const { platform, events } = fakePlatform();
    const app = runtime({ platform });
    app.onPublished({ status: "complete", publishedCount: 3, total: 3 });
    expect(events).toContain(`notify:${EN["resident.notify.savedTitle"]}`);
  });

  it("never claims files were saved for a publication that did not finish", () => {
    const { platform, events } = fakePlatform();
    const app = runtime({ platform });
    app.onPublished({ status: "failed", reason: "io-failed", residue: true });
    expect(events).toContain(`notify:${EN["resident.notify.failedTitle"]}`);
    expect(events).not.toContain(`notify:${EN["resident.notify.savedTitle"]}`);
  });

  it("announces a received message as a MESSAGE, with no count", () => {
    // A text saves no files; "Files saved" for one is a lie the user acts on.
    const { platform, events } = fakePlatform();
    const app = runtime({ platform });
    app.onNotice("saved-message");
    expect(events).toContain(`notify:${EN["resident.notify.messageSavedTitle"]}`);
    expect(events).not.toContain(`notify:${EN["resident.notify.savedTitle"]}`);
  });
});

describe("what was ASKED to stop is not what was seen to stop", () => {
  it("carries unsettled network work into the decision", async () => {
    // A socket that was told to close and never said it did, or an ICE read
    // still settling, is not "cleaned up". It reaches the user as residue.
    const { service, resume } = fakeService();
    const titles: string[] = [];
    const { platform, events } = fakePlatform({
      confirm: async (prompt) => {
        titles.push(prompt.title);
        return titles.length === 1;
      },
    });
    const { bridge } = fakeBridge({
      snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: true },
    });
    const app = runtime({
      service: service as never,
      quiesce: async () => ({ ...CLEAN, networkUnsettled: 2 }),
      resume,
      bridge,
      platform,
    });

    expect(await app.requestQuit()).toBe("stay");
    // The unknown sentence, not the file one: nothing is known to be left on
    // disk, and something may still be talking to the network.
    expect(titles).toEqual([EN["resident.quit.transferTitle"], EN["resident.quit.residueUnknownTitle"]]);
    expect(events).not.toContain("exit");
  });

  it("asks before quitting on a failure discovered only in the final teardown", async () => {
    // The clean path: nothing at stake, no prompt, no residue — and then the
    // teardown fails. Exiting here on "they already accepted residue" would be
    // claiming a consent nobody was asked for.
    const titles: string[] = [];
    const { platform, events } = fakePlatform({
      confirm: async (prompt) => {
        titles.push(prompt.title);
        return false;
      },
    });
    const app = runtime({
      platform,
      dispose: async () => {
        throw new Error("could not remove staged bytes");
      },
    });

    expect(await app.requestQuit()).toBe("stay");
    expect(titles).toEqual([EN["resident.quit.residueUnknownTitle"]]);
    expect(events).not.toContain("exit");
  });

  it("SHOWS the user that the app has stopped, rather than logging it", async () => {
    // The promise "the app must be restarted" was being made to stderr, where
    // nobody using the product can read it. What they had was a window that
    // looked fine and did nothing.
    const { platform, events } = fakePlatform({ confirm: async () => false });
    const app = runtime({
      platform,
      dispose: async () => {
        throw new Error("EPERM: C:\\Users\\someone\\Desktop\\report.txt");
      },
    });

    expect(await app.requestQuit()).toBe("stay");
    expect(events).toContain(`stopped:${EN["resident.stopped.title"]}`);
    // Said, and true: no exit, no relaunch, and the state is not described as
    // a working app.
    expect(events).not.toContain("exit");
    expect(app.isStopped).toBe(true);
    expect(app.isQuitting).toBe(false);
  });

  it("shows that notice in the page's language", async () => {
    const notices: string[] = [];
    const { platform } = fakePlatform({
      confirm: async () => false,
      showStopped: (notice) => notices.push(notice.title + "|" + notice.dismiss),
    });
    const app = runtime({
      platform,
      dispose: async () => {
        throw new Error("failed");
      },
    });
    app.setLocale("zh-Hans");

    await app.requestQuit();
    expect(notices).toEqual([`${ZH_HANS["resident.stopped.title"]}|${ZH_HANS["resident.stopped.dismiss"]}`]);
  });

  it("carries no error text or path into what the user sees", async () => {
    const notices: Array<{ title: string; body: string; dismiss: string }> = [];
    const { platform } = fakePlatform({
      confirm: async () => false,
      showStopped: (notice) => notices.push(notice),
    });
    const app = runtime({
      platform,
      dispose: async () => {
        throw new Error("EPERM: C:\\Users\\someone\\Desktop\\report.txt");
      },
    });

    await app.requestQuit();
    for (const text of Object.values(notices[0]!)) {
      expect(text).not.toMatch(/EPERM|Users|report\.txt/);
    }
  });

  it("stays truthful on a retry: quitting again asks again", async () => {
    // A stopped app is not a quitting one. The tray must still be able to try,
    // and the try must still be honest about what it could not clean up.
    const titles: string[] = [];
    const { platform, events } = fakePlatform({
      confirm: async (prompt) => {
        titles.push(prompt.title);
        return false;
      },
    });
    const app = runtime({
      platform,
      dispose: async () => {
        throw new Error("still failing");
      },
    });

    expect(await app.requestQuit()).toBe("stay");
    expect(await app.requestQuit()).toBe("stay");
    expect(titles).toEqual([
      EN["resident.quit.residueUnknownTitle"],
      EN["resident.quit.residueUnknownTitle"],
    ]);
    expect(events.filter((e) => e.startsWith("stopped:"))).toHaveLength(2);
    expect(events).not.toContain("exit");
  });

  it("does not ask twice when the residue was already accepted", async () => {
    const { service, resume } = fakeService();
    let asks = 0;
    const { platform, events } = fakePlatform({
      confirm: async () => {
        asks += 1;
        return true;
      },
    });
    const { bridge } = fakeBridge({
      snapshot: { sending: true, receiving: false, drafts: 0, locale: "en", nearby: true },
    });
    const app = runtime({
      service: service as never,
      quiesce: async () => ({ ...CLEAN, unresolved: 1, firstReason: "EBUSY" }),
      resume,
      bridge,
      platform,
      dispose: async () => {
        throw new Error("still locked");
      },
    });

    expect(await app.requestQuit()).toBe("quit");
    // Risk, then residue. The teardown failure is the same fact they just
    // agreed to leave behind.
    expect(asks).toBe(2);
    expect(events).toContain("exit");
  });
});
