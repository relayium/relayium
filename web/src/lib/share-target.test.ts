import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drainSharedFiles, activateWhenIdle, registerServiceWorker } from "./share-target";
import {
  appUpdateVisible,
  appUpdatePending,
  appUpdateReloadReady,
  refreshBlocked,
  applyAppUpdate,
  setReloadForTest,
  resetAppUpdate,
} from "./app-update.svelte";

// The stream-download registry lives in filesink and is plain module state, so
// drive it through a mock: "is a streaming download in flight" is the one input
// that decides whether a waiting worker may be let through.
const fake = vi.hoisted(() => ({ streaming: false }));
vi.mock("./filesink", () => ({
  probeStreamSupport: () => {},
  streamDownloadsActive: () => fake.streaming,
}));

// A tiny in-memory stand-in for the Cache API the SW writes shared files into.
function stubCaches(entries: Record<string, Response>) {
  const store = new Map(Object.entries(entries));
  const cache = {
    match: async (k: string) => store.get(k),
    delete: async (k: string) => store.delete(k),
    put: async (k: string, v: Response) => void store.set(k, v),
  };
  vi.stubGlobal("caches", { open: async () => cache });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("drainSharedFiles", () => {
  it("returns nothing and leaves the URL alone when there is no token", async () => {
    history.replaceState(null, "", "/?foo=bar");
    expect(await drainSharedFiles()).toEqual([]);
    expect(location.search).toBe("?foo=bar");
  });

  it("reconstructs shared files, then clears the cache and the URL param", async () => {
    history.replaceState(null, "", "/?share-target=tok123&keep=1");
    const store = stubCaches({
      "/__shared__/tok123/count": new Response("2"),
      "/__shared__/tok123/0": new Response(new Blob(["hello"]), {
        headers: { "content-type": "text/plain", "x-name": encodeURIComponent("a.txt") },
      }),
      "/__shared__/tok123/1": new Response(new Blob(["<x>"]), {
        headers: { "content-type": "image/svg+xml", "x-name": encodeURIComponent("图 片.svg") },
      }),
    });

    const files = await drainSharedFiles();

    // Names (percent-decoded, incl. non-ASCII) and types come from the stashed
    // headers; byte content flows through browser-native Response/File, which
    // jsdom/undici can't faithfully bridge, so it isn't asserted here.
    expect(files.map((f) => f.name)).toEqual(["a.txt", "图 片.svg"]);
    expect(files[0].type).toBe("text/plain");
    expect(files[1].type).toBe("image/svg+xml");

    // The one-shot entries are cleaned up and the param is stripped (keep=1 stays).
    expect(store.size).toBe(0);
    expect(location.search).toBe("?keep=1");
  });

  it("survives a missing cache entry without throwing", async () => {
    history.replaceState(null, "", "/?share-target=tokX");
    stubCaches({ "/__shared__/tokX/count": new Response("1") }); // entry 0 absent
    expect(await drainSharedFiles()).toEqual([]);
  });
});

// ── service-worker update detection ────────────────────────────────────────────
// activateWhenIdle does two jobs off the same registration: get the waiting
// worker activated at a moment when no streaming download anywhere would die
// with the old one, and drive the update state the notice reads (pending ↔ ready).
//
// The activation itself is NOT done by this page — it asks the old active worker
// to do it, because only that worker can check its global stream table and hand
// over in one indivisible step. See sw-template.js's retireIfIdle.

type Handler = () => void;

/** Minimal event target with a manual emit, standing in for a Registration /
 *  ServiceWorker / navigator.serviceWorker. */
function emitter() {
  const handlers = new Map<string, Handler[]>();
  return {
    addEventListener(type: string, fn: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
    /** Is anyone listening for this yet? Used to pin down listener ordering. */
    has(type: string) {
      return (handlers.get(type) ?? []).length > 0;
    },
    /** How many listeners — pins down that nothing is attached twice. */
    count(type: string) {
      return (handlers.get(type) ?? []).length;
    },
    emit(type: string) {
      for (const fn of handlers.get(type) ?? []) fn();
    },
  };
}

type FakeWorker = ReturnType<typeof emitter> & { state: string; postMessage: ReturnType<typeof vi.fn> };
type FakeReg = ReturnType<typeof emitter> & {
  installing: FakeWorker | null;
  waiting: FakeWorker | null;
  active: FakeWorker | null;
};

/**
 * What the active worker's own global `streams` map holds — i.e. the truth
 * across ALL tabs, which is exactly what this page cannot see for itself.
 */
let swStreams: "idle" | "busy" = "idle";

/**
 * Does the active worker implement the retirement handshake?
 *
 *   current — this build or newer: answers retire-if-idle
 *   legacy  — anything deployed before it: drops the message and never replies,
 *             which is the only thing the page can detect (a timeout)
 */
let swProtocol: "current" | "legacy" = "current";

function fakeWorker(): FakeWorker {
  return Object.assign(emitter(), { state: "installing", postMessage: vi.fn() });
}

/**
 * An activated worker that runs sw-template.js's retireIfIdle: in ONE task it
 * checks the global stream table, and only if it is empty hands over to the
 * registration's waiting worker. The page never posts skip-waiting itself on
 * this path — the `via: "sw"` marker below is what proves that.
 */
function fakeActive(reg?: FakeReg | null): FakeWorker {
  const w = fakeWorker();
  w.state = "activated";
  w.postMessage.mockImplementation(
    (msg: { type?: string } | null, transfer?: { postMessage(d: unknown): void }[]) => {
      if (msg?.type !== "retire-if-idle") return;
      if (swProtocol === "legacy") return; // does not know this message; stays silent
      const reply = (type: string) => transfer?.[0]?.postMessage({ type });
      if (swStreams === "busy") return reply("retire-busy");
      const waiting = reg?.waiting ?? null;
      if (!waiting) return reply("retire-none");
      // `via` marks who did it: the worker, never the page. pageSkipWaits()
      // reads this back to tell the atomic path from the legacy fallback.
      (waiting.postMessage as unknown as (m: unknown) => void)({ type: "skip-waiting", via: "sw" });
      reply("retire-ok");
    },
  );
  return w;
}

function fakeReg(waiting: FakeWorker | null = null): FakeReg {
  const reg = Object.assign(emitter(), {
    installing: null as FakeWorker | null,
    waiting,
    active: null as FakeWorker | null,
  });
  reg.active = fakeActive(reg);
  return reg;
}

/** Every port the double has handed out this test, so leaks are assertable. */
let channelPorts: { closed: boolean }[] = [];

/**
 * A MessageChannel replacement that delivers synchronously and records closes.
 *
 * jsdom's real MessagePort does not deliver anything at all while vitest's fake
 * timers are installed (measured), and these tests need the 15s activation
 * poll — so one of the two has to be a double. The production path stays
 * genuinely asynchronous either way: the answer still comes back through a
 * promise and a microtask.
 */
function stubMessageChannel() {
  class FakePort {
    other: FakePort | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    closed = false;
    postMessage(data: unknown) {
      if (this.other?.closed) return;
      this.other?.onmessage?.({ data });
    }
    close() {
      this.closed = true;
    }
  }
  class FakeChannel {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      this.port1.other = this.port2;
      this.port2.other = this.port1;
      channelPorts.push(this.port1);
    }
  }
  vi.stubGlobal("MessageChannel", FakeChannel);
}

const openPorts = () => channelPorts.filter((p) => !p.closed).length;

/** Install navigator.serviceWorker for one test. */
function stubServiceWorker(controller: unknown) {
  const sw = Object.assign(emitter(), { controller });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: sw });
  return sw;
}

/** Start the lifecycle. `hadController` is the second argument the real caller
 *  reads immediately before register() — see registerServiceWorker. */
function start(reg: FakeReg, hadController: boolean) {
  activateWhenIdle(reg as unknown as ServiceWorkerRegistration, hadController);
}

/** Drive a new worker from `installing` to `installed`. `waits` mirrors the
 *  browser: a worker only parks in `waiting` when another one already controls
 *  the page; the first install on a device activates straight away. */
function install(reg: FakeReg, { waits }: { waits: boolean }): FakeWorker {
  const worker = fakeWorker();
  reg.installing = worker;
  reg.emit("updatefound");
  worker.state = "installed";
  if (waits) reg.waiting = worker;
  worker.emit("statechange");
  return worker;
}

/** The waiting worker takes control: the browser clears `waiting` and promotes
 *  it to `active` first, then fires controllerchange with a non-null controller. */
function takeControl(reg: FakeReg, sw: ReturnType<typeof stubServiceWorker>) {
  const promoted = reg.waiting ?? fakeWorker();
  reg.waiting = null;
  reg.active = fakeActive(reg);
  sw.controller = promoted;
  sw.emit("controllerchange");
}

/** Let the retirement request and its microtasks run to a verdict. */
async function settle() {
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

/** Every skip-waiting the worker received, however it got there. */
const skipWaits = (w: FakeWorker) => w.postMessage.mock.calls.filter((c) => c[0]?.type === "skip-waiting").length;
/** Only the ones the PAGE sent directly — i.e. the legacy compatibility path. */
const pageSkipWaits = (w: FakeWorker) =>
  w.postMessage.mock.calls.filter((c) => c[0]?.type === "skip-waiting" && c[0]?.via !== "sw").length;
const retireAsks = (w: FakeWorker | null) =>
  (w?.postMessage.mock.calls ?? []).filter((c) => c[0]?.type === "retire-if-idle").length;

describe("activateWhenIdle", () => {
  beforeEach(() => {
    channelPorts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetAppUpdate();
    fake.streaming = false;
    swStreams = "idle";
    swProtocol = "current";
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it("says nothing on this device's first-ever install", async () => {
    stubMessageChannel();
    const sw = stubServiceWorker(null); // nothing controls this page yet
    const reg = fakeReg();
    start(reg, false);

    install(reg, { waits: false });
    // The first worker activates by itself, which fires controllerchange. That
    // is not "your page is stale" — the page was never running an older build.
    takeControl(reg, sw);
    await settle();

    expect(appUpdateVisible()).toBe(false);
  });

  // register() resolves asynchronously, and this device's first-ever worker can
  // have activated and claimed the page by the time this runs — the
  // controllerchange that would have set the baseline fired before there was
  // anyone listening. Reading the controller here recovers that baseline; it
  // cannot cause a false prompt, because that worker IS the controller, not a
  // waiting or installing one, and only those two ever announce.
  it("takes a controller that appeared during registration as the baseline, not as an update", async () => {
    stubMessageChannel();
    const sw = stubServiceWorker({}); // the first-ever worker has already claimed the page…
    const reg = fakeReg();
    start(reg, false); // …and there was no controller when we registered

    await settle();
    expect(appUpdateVisible()).toBe(false); // the claim itself is not an update

    // …but the NEXT deploy is: this page's JavaScript is older than it.
    const b = install(reg, { waits: true });
    await settle();
    expect(appUpdatePending()).toBe(true);

    takeControl(reg, sw);
    expect(appUpdateReloadReady()).toBe(true);
    expect(skipWaits(b)).toBe(1);
  });

  it("does announce a deploy that lands after the first-ever install claimed this page", async () => {
    stubMessageChannel();
    const sw = stubServiceWorker(null);
    const reg = fakeReg();
    start(reg, false);

    install(reg, { waits: false }); // first install on this device…
    takeControl(reg, sw); // …claims the page. Still not an update.
    expect(appUpdateVisible()).toBe(false);

    // The page's JavaScript is the build it loaded with, so the NEXT one is.
    install(reg, { waits: true });
    await settle();

    expect(appUpdatePending()).toBe(true);
  });

  // register()'s promise settles part-way through the install algorithm, so
  // reg.installing is usually already there — and its updatefound already fired.
  // Only attaching an updatefound listener would miss that worker entirely.
  it("watches an installing worker that was already there when the listeners went up", async () => {
    stubMessageChannel();
    stubServiceWorker({});
    const reg = fakeReg();
    const w = fakeWorker();
    reg.installing = w; // updatefound fired before activateWhenIdle ran

    start(reg, true);

    w.state = "installed";
    reg.waiting = w;
    w.emit("statechange");
    await settle();

    expect(appUpdatePending()).toBe(true);
    expect(skipWaits(w)).toBe(1);
  });

  it("catches an installing worker that had already reached installed", async () => {
    stubMessageChannel();
    stubServiceWorker({});
    const reg = fakeReg();
    const w = fakeWorker();
    w.state = "installed"; // statechange fired before we could listen for it
    reg.installing = w;

    start(reg, true);
    await settle();

    expect(appUpdatePending()).toBe(true);
  });

  it("does not watch the same installing worker twice", () => {
    stubMessageChannel();
    stubServiceWorker({});
    const reg = fakeReg();
    const w = fakeWorker();
    reg.installing = w;

    start(reg, true);
    reg.emit("updatefound"); // the same worker reported again

    expect(w.count("statechange")).toBe(1);
  });

  it("announces an update that installs while an older worker controls the page", async () => {
    stubMessageChannel();
    const sw = stubServiceWorker({}); // a previous version is in control
    const reg = fakeReg();
    start(reg, true);
    expect(appUpdateVisible()).toBe(false); // nothing installed yet

    const worker = install(reg, { waits: true });
    await settle();

    // Installed is not refreshable: the old worker still answers navigations,
    // so a reload here would serve the same build back.
    expect(appUpdatePending()).toBe(true);
    expect(skipWaits(worker)).toBe(1); // it is let through immediately…
    // …and by the active worker, not by this page: the page asking one worker
    // and then poking another is exactly the two-step race this replaced.
    expect(pageSkipWaits(worker)).toBe(0);

    takeControl(reg, sw); // only when it lands does refresh mean anything
    expect(appUpdateReloadReady()).toBe(true);
  });

  it("announces an update left waiting by a previous visit", async () => {
    stubMessageChannel();
    const waiting = fakeWorker();
    const reg = fakeReg(waiting);
    stubServiceWorker({});

    start(reg, true);
    await settle();

    expect(appUpdatePending()).toBe(true);
    expect(skipWaits(waiting)).toBe(1);
  });

  // Ordering, not decoration: the handover can complete at any point after the
  // request goes out. A listener attached afterwards can miss that
  // controllerchange for good, which would strand the notice at "pending" with
  // a permanently dead Refresh button.
  it("listens for controllerchange before anything can ask for a handover", async () => {
    stubMessageChannel();
    const sw = stubServiceWorker({});
    const reg = fakeReg(fakeWorker());
    const listeningWhenAsked: boolean[] = [];
    const real = reg.active!.postMessage.getMockImplementation() as
      | ((m: unknown, t?: unknown[]) => void)
      | undefined;
    reg.active!.postMessage.mockImplementation((m: { type?: string } | null, t?: unknown[]) => {
      if (m?.type === "retire-if-idle") listeningWhenAsked.push(sw.has("controllerchange"));
      real?.(m, t);
    });

    start(reg, true);
    await settle();

    expect(listeningWhenAsked).toEqual([true]);
  });

  it("announces on controllerchange — a new worker in control means this page's JS is old", () => {
    stubMessageChannel();
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    takeControl(reg, sw);

    expect(appUpdateReloadReady()).toBe(true);
  });

  // controllerchange also fires when the page is left with NO controller — an
  // unregistration, or the gap in some swap paths. Nothing newer is in control
  // there, so treating it as an update would light up a Refresh button that
  // leads back to the same build.
  it("ignores a controllerchange that leaves no controller at all", () => {
    stubMessageChannel();
    const sw = stubServiceWorker({});
    start(fakeReg(), true);

    sw.controller = null;
    sw.emit("controllerchange");

    expect(appUpdateVisible()).toBe(false);
  });

  it("still announces a real takeover that follows a null-controller event", () => {
    stubMessageChannel();
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    sw.controller = null;
    sw.emit("controllerchange");
    takeControl(reg, sw);

    expect(appUpdateReloadReady()).toBe(true);
  });

  it("is idempotent across repeated and overlapping signals", async () => {
    stubMessageChannel();
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    install(reg, { waits: true });
    await settle();
    takeControl(reg, sw); // it activated
    sw.emit("controllerchange"); // a stray repeat of the same event
    sw.emit("controllerchange");

    expect(appUpdateReloadReady()).toBe(true);
  });

  it("survives a registration that throws when asked about its waiting worker", () => {
    stubMessageChannel();
    stubServiceWorker({});
    const reg = fakeReg();
    Object.defineProperty(reg, "waiting", {
      configurable: true,
      get() {
        throw new Error("sw gone");
      },
    });

    // Best-effort throughout: the offline shell failing must not take App's
    // boot down with it.
    expect(() => start(reg, true)).not.toThrow();
  });

  // ── the streaming-download case, end to end ────────────────────────────────
  // A streaming download is served by the worker that is currently in control.
  // Letting the new one through kills it (the old worker's in-memory registry
  // of stream acks goes with it), and reloading kills it too — while landing on
  // a build older than the one waiting, because the old worker still answers the
  // navigation. So for as long as one is in flight the notice stays visible and
  // the refresh action stays unavailable, from the UI and programmatically.
  it("keeps refresh unavailable for the whole life of a streaming download", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    const reload = vi.fn();
    setReloadForTest(reload);
    fake.streaming = true;
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();

    // Visible, so the user knows a refresh is due — but not takeable.
    expect(appUpdateVisible()).toBe(true);
    expect(appUpdatePending()).toBe(true);
    expect(refreshBlocked(false, 0)).toBe(true);
    expect(skipWaits(worker)).toBe(0);

    // Not even by calling it directly: the button is not the only way in.
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(skipWaits(worker)).toBe(0); // still downloading
    expect(refreshBlocked(false, 0)).toBe(true);

    // Download done: the next poll gets the handover through.
    fake.streaming = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(skipWaits(worker)).toBe(1);

    // Handing over is a request, not an arrival. Until the new worker is
    // actually in control, a reload would still land on the old build, so the
    // action stays unavailable.
    expect(appUpdatePending()).toBe(true);
    expect(refreshBlocked(false, 0)).toBe(true);
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    // It arrives. Now — and only now — refreshing means something.
    takeControl(reg, sw);
    expect(appUpdateReloadReady()).toBe(true);
    expect(refreshBlocked(false, 0)).toBe(false);
    expect(applyAppUpdate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // The retry timer stops once it has done its job.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(skipWaits(worker)).toBe(1);
  });

  // The second-deploy-behind-a-live-one case. A stage that only ever moved
  // forward would leave this page `ready` for the whole of C's wait: the button
  // stays live, and one click both kills the download holding C back and lands
  // on B rather than C.
  it("drops back to pending when a further build installs behind the live one", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    const reload = vi.fn();
    setReloadForTest(reload);
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true); // the page is running A

    // B installs and takes control. The user is offered a refresh and ignores it.
    const b = install(reg, { waits: true });
    await settle();
    expect(skipWaits(b)).toBe(1);
    takeControl(reg, sw);
    expect(appUpdateReloadReady()).toBe(true);

    // A download starts, then C installs and is held back by it.
    fake.streaming = true;
    const c = install(reg, { waits: true });

    expect(appUpdatePending()).toBe(true);
    expect(refreshBlocked(false, 0)).toBe(true);
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(skipWaits(c)).toBe(0);

    // Download finishes: C is handed over to, but it is not in control yet.
    fake.streaming = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(skipWaits(c)).toBe(1);
    expect(appUpdatePending()).toBe(true);
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    // C takes control. Only now does the button lead to C.
    takeControl(reg, sw);
    expect(appUpdateReloadReady()).toBe(true);
    expect(applyAppUpdate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Events do not have to arrive in the order they were caused. B activates,
  // C installs, and B's controllerchange is only dispatched to this page after
  // C is already parked in `waiting`. Taking that event at face value flips the
  // page to `ready` — the button goes live for a moment, and a click both lands
  // on B rather than C and kills whatever is holding C back. The handler has to
  // look at the registration as it is NOW, not at what the event implies.
  it("does not go ready on a late controllerchange when a newer build is already waiting", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    const reload = vi.fn();
    setReloadForTest(reload);
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    // B installs and is handed over to, but its controllerchange is delayed.
    const b = install(reg, { waits: true });
    await settle();
    expect(skipWaits(b)).toBe(1);
    reg.waiting = null; // B activated…
    reg.active = fakeActive(reg);
    sw.controller = b; // …and is the controller now; the event has not run yet

    // C installs behind it and parks in waiting (a download holds it back).
    fake.streaming = true;
    const c = install(reg, { waits: true });
    expect(appUpdatePending()).toBe(true);

    // NOW B's controllerchange finally runs.
    sw.emit("controllerchange");

    expect(appUpdatePending()).toBe(true);
    expect(appUpdateReloadReady()).toBe(false);
    expect(refreshBlocked(false, 0)).toBe(true);
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    // C's own takeover is what makes it honest.
    fake.streaming = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(skipWaits(c)).toBe(1);
    takeControl(reg, sw);
    expect(appUpdateReloadReady()).toBe(true);
  });

  // The registration can throw on a property read once the worker has been
  // unregistered or evicted. Whether something newer is waiting is then
  // *unknown* — and the only guess that does damage is "nothing is", because
  // that flips the page to ready and hands the user a live Refresh button.
  it("changes nothing on a controllerchange when the waiting state cannot be read", async () => {
    stubMessageChannel();
    const reload = vi.fn();
    setReloadForTest(reload);
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    install(reg, { waits: true }); // a build is installed and held back
    await settle();
    expect(appUpdatePending()).toBe(true);

    // Now the registration goes bad.
    Object.defineProperty(reg, "waiting", {
      configurable: true,
      get() {
        throw new Error("registration gone");
      },
    });
    sw.controller = fakeWorker();
    sw.emit("controllerchange");

    expect(appUpdatePending(), "unknown must not be read as 'nothing waiting'").toBe(true);
    expect(appUpdateReloadReady()).toBe(false);
    expect(refreshBlocked(false, 0)).toBe(true);
    expect(applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves a fresh page silent when the waiting state cannot be read", () => {
    stubMessageChannel();
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    Object.defineProperty(reg, "waiting", {
      configurable: true,
      get() {
        throw new Error("registration gone");
      },
    });
    sw.controller = fakeWorker();
    sw.emit("controllerchange");

    // Nothing was known about, and an unreadable registration teaches nothing.
    expect(appUpdateVisible()).toBe(false);
  });

  it("still goes ready on a controllerchange with nothing newer waiting", () => {
    stubMessageChannel();
    const sw = stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    reg.waiting = null;
    sw.controller = fakeWorker();
    sw.emit("controllerchange");

    expect(appUpdateReloadReady()).toBe(true);
  });

  // ── the cross-tab gate ─────────────────────────────────────────────────────
  // streamDownloadsActive() is this Window's module state. It says nothing
  // about the other tabs the same worker is serving, so an idle tab acting on
  // its own would kill a download running next door. The decision belongs to
  // the worker, which is the only party that can see all of them.
  it("never hands over while ANOTHER tab is streaming", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    fake.streaming = false; // this tab is idle…
    swStreams = "busy"; // …and the worker is serving a download for another one
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();
    expect(skipWaits(worker)).toBe(0);
    expect(retireAsks(reg.active)).toBe(1); // it really did ask

    await vi.advanceTimersByTimeAsync(60_000);
    expect(skipWaits(worker)).toBe(0); // still downloading over there
    // And the page never took matters into its own hands.
    expect(pageSkipWaits(worker)).toBe(0);

    // The other tab finishes.
    swStreams = "idle";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(skipWaits(worker)).toBe(1);
  });

  it("does not bother asking when this tab is the one streaming", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    fake.streaming = true;
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();

    expect(skipWaits(worker)).toBe(0);
    expect(retireAsks(reg.active)).toBe(0); // the local gate already decided
  });

  // Compatibility with every worker deployed before this handshake existed:
  // they ignore retire-if-idle and never reply. Treating silence as "busy"
  // would mean nobody could ever upgrade off those builds. This is also the
  // shape of the release that introduces the protocol: a page can be served
  // fresh from the network while an older worker is still in control.
  it("falls back to posting skip-waiting itself when the active worker never answers", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    swProtocol = "legacy";
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();
    expect(skipWaits(worker)).toBe(0); // waiting for an answer that never comes

    await vi.advanceTimersByTimeAsync(2_000);
    expect(skipWaits(worker)).toBe(1);
    expect(pageSkipWaits(worker)).toBe(1); // the old two-step path, deliberately
  });

  it("still respects its own local gate on the compatibility path", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    swProtocol = "legacy";
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    const worker = install(reg, { waits: true });
    // The download starts while the doomed query is still outstanding.
    fake.streaming = true;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(skipWaits(worker)).toBe(0);

    fake.streaming = false;
    await vi.advanceTimersByTimeAsync(15_000 + 2_000);
    expect(skipWaits(worker)).toBe(1);
  });

  // Several signals can land at once (an updatefound while the poll fires, a
  // repeated statechange). Without a single-flight guard each one would open
  // its own request, and the compatibility path could post skip-waiting twice.
  it("keeps one request in flight, so overlapping signals cannot ask twice", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    swProtocol = "legacy"; // holds the request open until it times out
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();
    expect(retireAsks(reg.active)).toBe(1);

    // More signals about the same worker while the answer is outstanding.
    worker.emit("statechange");
    worker.emit("statechange");
    await settle();

    expect(retireAsks(reg.active)).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(skipWaits(worker)).toBe(1);
  });

  it("keeps polling when the worker reports nothing to hand over to", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    // reg.waiting is set for this page, but the worker's own registration view
    // has no waiting worker yet — it answers retire-none.
    const active = reg.active!;
    active.postMessage.mockImplementation(
      (msg: { type?: string } | null, transfer?: { postMessage(d: unknown): void }[]) => {
        if (msg?.type === "retire-if-idle") transfer?.[0]?.postMessage({ type: "retire-none" });
      },
    );

    const worker = install(reg, { waits: true });
    await settle();
    expect(skipWaits(worker)).toBe(0);

    // It must not give up while this page can still see something waiting.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(retireAsks(active)).toBeGreaterThanOrEqual(2);

    // …and it does stop once there really is nothing waiting.
    reg.waiting = null;
    await vi.advanceTimersByTimeAsync(15_000);
    const settledAsks = retireAsks(active);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retireAsks(active)).toBe(settledAsks);
  });

  it("asks the page's controller when the registration has no active worker", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    swStreams = "busy";
    const controller = fakeActive(null);
    stubServiceWorker(controller);
    const reg = fakeReg();
    reg.active = null;
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();

    expect(retireAsks(controller)).toBe(1);
    expect(skipWaits(worker)).toBe(0);
  });

  it("falls back when there is no worker to ask and no MessageChannel", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MessageChannel", undefined);
    stubServiceWorker(null);
    const reg = fakeReg();
    reg.active = null;
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();

    expect(skipWaits(worker)).toBe(1);
  });

  it("falls back when asking the worker throws", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    stubServiceWorker({});
    const reg = fakeReg();
    reg.active!.postMessage.mockImplementation(() => {
      throw new Error("worker gone");
    });
    start(reg, true);

    const worker = install(reg, { waits: true });
    await settle();

    expect(skipWaits(worker)).toBe(1);
  });

  // 15 seconds a poll, for as long as a download runs: anything held per attempt
  // accumulates. Each request must clear its timeout and close its port.
  it("holds no timers or ports open between polls", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    swStreams = "busy"; // keeps the poll going for the whole test
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);

    install(reg, { waits: true });
    await settle();

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(15_000);

    expect(channelPorts.length).toBeGreaterThanOrEqual(10); // it really did poll
    expect(openPorts()).toBe(0);
    // Only the activation poll itself is still scheduled — no 2s timeout left
    // behind by any of the answered requests.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops polling once there is nothing waiting any more", async () => {
    vi.useFakeTimers();
    stubMessageChannel();
    fake.streaming = true;
    stubServiceWorker({});
    const reg = fakeReg();
    start(reg, true);
    const worker = install(reg, { waits: true });
    await settle();
    expect(skipWaits(worker)).toBe(0);

    // Another tab got it activated, so this registration has nothing to hand over.
    reg.waiting = null;
    await vi.advanceTimersByTimeAsync(15_000);
    fake.streaming = false;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(skipWaits(worker)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("registerServiceWorker", () => {
  beforeEach(() => {
    channelPorts = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAppUpdate();
    swStreams = "idle";
    swProtocol = "current";
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    delete (window as { isSecureContext?: unknown }).isSecureContext;
  });

  // The captured value is what survives the controller going away: an
  // unregistration between register() and its promise does not make this page's
  // JavaScript any fresher, so a later deploy is still an update to it.
  it("carries the pre-register controller fact through, even if the controller has since gone", async () => {
    vi.stubEnv("PROD", true);
    stubMessageChannel();
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    const sw = stubServiceWorker({}) as ReturnType<typeof stubServiceWorker> & {
      controller: unknown;
      register: (path: string) => Promise<unknown>;
    };
    const reg = fakeReg();
    let settleRegister: (r: unknown) => void = () => {};
    const register = vi.fn(() => new Promise((res) => (settleRegister = res)));
    sw.register = register;

    registerServiceWorker();
    // Guards the test itself: without the PROD/secure-context stubs above,
    // registerServiceWorker returns early and everything below is vacuous.
    expect(register).toHaveBeenCalledWith("/sw.js");

    sw.controller = null; // unregistered while register() was still pending
    settleRegister(reg);
    await settle();

    install(reg, { waits: true });
    await settle();

    expect(appUpdatePending()).toBe(true);
  });
});
