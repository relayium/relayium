// `fetchIceConfig` can neither hang nor reject.
//
// Both halves are the same defect seen from the page: `App.svelte` awaits this
// at every room join with no `catch` and no deadline of its own, and holds
// `roomIcePending` — the gate every transport for that room is built behind —
// until the answer lands. A promise that never settles and one that rejects
// both leave that gate shut for the life of the tab: `whenRoomIce()` never
// resolves, the relay gate never opens, and no link can be established in that
// room again.
//
// The suites next door cover the CLASSIFICATION (`ice-config.test.ts`) and the
// relay-choice maths (`ice.test.ts`). This one covers only the liveness
// contract, because that is what the room gate's missing timeout rests on.
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIceConfig, type IceTransport } from "./ice";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** A transport that never settles: the request that got no status line at all. */
const neverAnswers: IceTransport = () => new Promise<Response>(() => {});

/** Headers arrived, body never completes — the shape a stalled proxy produces,
 *  and the one a `fetch`-level timeout alone would not catch. */
const headersThenStall: IceTransport = async () =>
  ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise<never>(() => {}) }) as unknown as Response;

/** A transport that ignores `signal` entirely, like the Electron renderer's:
 *  its request runs in main, under main's own deadline, and the renderer may
 *  not cancel it. `fetchIceConfig` must still settle. */
const ignoresAbort: IceTransport = (_url, _init) => new Promise<Response>(() => {});

/** Drive both attempts and the backoff between them to completion. */
async function runToCompletion<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  void pending.then(() => { settled = true; });
  for (let i = 0; i < 100 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000);
  return pending;
}

describe("fetchIceConfig attempt liveness", () => {
  // THE REGRESSION (headers half). Reproduced against this module before the
  // fix: settled=false, and zero timers scheduled anywhere.
  it("ends a request that never answers, and says it was unavailable", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(neverAnswers);
    const cfg = await runToCompletion(fetchIceConfig("483920", transport));
    expect(cfg.relayStatus).toBe("unavailable");
    expect(cfg.iceServers).toEqual([]); // never a third-party STUN — see FALLBACK
    expect(cfg.relays).toEqual([]);
  });

  // THE REGRESSION (body half). `fetch` resolves on the HEADERS, so a deadline
  // that only bounded the transport call would report a healthy 200 and then
  // hang forever inside res.json().
  it("ends a request whose headers arrived but whose body never completes", async () => {
    vi.useFakeTimers();
    const cfg = await runToCompletion(fetchIceConfig("483920", headersThenStall));
    expect(cfg.relayStatus).toBe("unavailable");
  });

  // The deadline is a race, not only an abort, precisely so that a transport
  // which cannot honour cancellation still cannot wedge the room.
  it("settles even when the transport ignores the abort signal", async () => {
    vi.useFakeTimers();
    const cfg = await runToCompletion(fetchIceConfig("483920", ignoresAbort));
    expect(cfg.relayStatus).toBe("unavailable");
  });

  it("aborts the request it gave up on, so a transport that can cancel does", async () => {
    vi.useFakeTimers();
    const seen: AbortSignal[] = [];
    const transport: IceTransport = (_url, init) => {
      if (init?.signal) seen.push(init.signal);
      return new Promise<Response>(() => {});
    };
    await runToCompletion(fetchIceConfig("483920", transport));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.aborted)).toBe(true);
  });

  // A stall is transient, so it gets the ONE retry the module already owns —
  // no more, and not a new retry policy.
  it("spends exactly one retry on a stalled attempt", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(neverAnswers);
    await runToCompletion(fetchIceConfig("483920", transport));
    expect(transport).toHaveBeenCalledTimes(2);
  });

  // A late answer belongs to an attempt whose classification was already made
  // and already returned. It must not reopen or overwrite anything.
  it("ignores an attempt that completes after its deadline", async () => {
    vi.useFakeTimers();
    let release!: (res: Response) => void;
    const transport = vi.fn<IceTransport>()
      .mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }))
      .mockImplementation(neverAnswers);
    const cfg = await runToCompletion(fetchIceConfig("483920", transport));
    expect(cfg.relayStatus).toBe("unavailable");
    release({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({ iceServers: [{ urls: ["turn:t:3478"], username: "u", credential: "c" }] }),
    } as unknown as Response);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cfg.relayStatus).toBe("unavailable"); // the returned value is final
    expect(cfg.iceServers).toEqual([]);
  });

  // The whole point of the bound is that the gate above has none of its own, so
  // it must not leave one of its own running either.
  it("leaves no timer behind on a fast, successful read", async () => {
    vi.useFakeTimers();
    const transport: IceTransport = async () =>
      ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ iceServers: [{ urls: "stun:s:3478" }] }) }) as unknown as Response;
    const cfg = await fetchIceConfig("", transport);
    expect(cfg.relayStatus).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind after the retry is spent", async () => {
    vi.useFakeTimers();
    await runToCompletion(fetchIceConfig("483920", neverAnswers));
    expect(vi.getTimerCount()).toBe(0);
  });

  // A stall must not become a *slower* answer for the paths that already had
  // one: a 429 still costs a single request, and a denial is still a reason.
  it("still refuses to retry a rate limit", async () => {
    const transport = vi.fn<IceTransport>().mockResolvedValue(
      { ok: false, status: 429, headers: new Headers(), json: async () => ({}) } as unknown as Response,
    );
    const cfg = await fetchIceConfig("483920", transport);
    expect(cfg.relayStatus).toBe("ratelimited");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("still passes a deliberate denial through unchanged", async () => {
    for (const denied of ["quota", "unverified"] as const) {
      const transport = vi.fn<IceTransport>().mockResolvedValue(
        { ok: false, status: 403, headers: new Headers(), json: async () => ({ relayDenied: denied }) } as unknown as Response,
      );
      const cfg = await fetchIceConfig("483920", transport);
      expect(cfg.relayStatus).toBe(denied);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
});

describe("fetchIceConfig cancellation, against real stream semantics", () => {
  // The fixtures above hand back a hand-rolled object whose `json()` never
  // settles. This one is a REAL `Response` over a REAL `ReadableStream`, read
  // by the real `res.json()`, and a transport that does to its body what a
  // browser `fetch` does on abort: errors the stream. That is the cancellation
  // path production actually takes.
  function streamingTransport() {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const state = { aborted: false, cancelled: false };
    const transport: IceTransport = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
          // Headers and the first bytes arrive; the body never completes.
          controller.enqueue(new TextEncoder().encode('{"iceServers":'));
        },
        cancel() { state.cancelled = true; },
      });
      init?.signal?.addEventListener("abort", () => {
        state.aborted = true;
        try { source.error(new DOMException("The operation was aborted.", "AbortError")); } catch { /* already errored */ }
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    return { transport, state };
  }

  it("cancels a real body stream that never completes, and still classifies", async () => {
    vi.useFakeTimers();
    const { transport, state } = streamingTransport();
    const cfg = await runToCompletion(fetchIceConfig("483920", transport));
    expect(cfg.relayStatus).toBe("unavailable");
    expect(state.aborted).toBe(true); // the deadline really did cancel the request
    expect(vi.getTimerCount()).toBe(0);
  });

  // What the browser transport itself does: `fetch` REJECTS with an AbortError
  // once its signal fires. That has to classify as a transient failure worth
  // the one retry, not as something exotic.
  it("classifies a fetch-shaped abort rejection as one retryable failure", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<IceTransport>((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The user aborted a request.", "AbortError")));
      }));
    const cfg = await runToCompletion(fetchIceConfig("483920", transport));
    expect(cfg.relayStatus).toBe("unavailable");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A request that succeeded must not be left holding a response body either:
  // the deadline is released AND the request is cancelled on the way out.
  it("releases the request on the success path too", async () => {
    const seen: AbortSignal[] = [];
    const transport: IceTransport = async (_url, init) => {
      if (init?.signal) seen.push(init.signal);
      return new Response(JSON.stringify({ iceServers: [{ urls: "stun:s:3478" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const cfg = await fetchIceConfig("", transport);
    expect(cfg.relayStatus).toBe("ok");
    expect(cfg.iceServers).toEqual([{ urls: "stun:s:3478" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(true);
  });

  // A 429 answers from its status line, so the body is never read. Leaving it
  // open would hold a connection for an answer nobody wants.
  it("releases the request when the status line alone answered", async () => {
    let cancelled = false;
    const seen: AbortSignal[] = [];
    const transport: IceTransport = async (_url, init) => {
      if (init?.signal) seen.push(init.signal);
      const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
      return new Response(body, { status: 429 });
    };
    const cfg = await fetchIceConfig("483920", transport);
    expect(cfg.relayStatus).toBe("ratelimited");
    expect(seen[0].aborted).toBe(true);
    expect(cancelled).toBe(false); // nothing read it; the transport owns the stream
  });
});

// **These are liveness assertions, not schema-validation ones.** What is being
// pinned is that `fetchIceConfig` returns a classification rather than throwing
// — see `toIceConfig`. Nothing here claims that what survives would construct
// an `RTCPeerConnection`: URI syntax and credential shapes are not checked and
// deliberately remain the constructor's problem.
describe("fetchIceConfig body shapes", () => {
  const reply = (body: unknown): IceTransport => async () =>
    ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as unknown as Response;

  // THE REGRESSION. Every one of these is a 200 carrying VALID JSON, and every
  // one of them used to throw a TypeError out of `relayStatusOf` — which runs
  // outside the body reader's try/catch — and so out of `fetchIceConfig`
  // itself, past two call sites that await it with no catch.
  const malformed: Array<[string, unknown]> = [
    ["relays is an object, not a list", { iceServers: [], relays: {} }],
    ["a null server entry", { iceServers: [null] }],
    ["a numeric urls", { iceServers: [{ urls: 42 }] }],
    ["a pool entry with no iceServers", { iceServers: [], relays: [{ id: "tok" }] }],
    ["a pool entry that is not an object", { relays: ["tok"] }],
    ["a pool entry with no id", { relays: [{ iceServers: [{ urls: "turn:t:3478" }] }] }],
    ["urls is an object", { iceServers: [{ urls: { turn: "turn:t:3478" } }] }],
    ["a list of non-strings in urls", { iceServers: [{ urls: [42, null] }] }],
    ["iceServers is a string", { iceServers: "turn:t:3478" }],
    ["the body is null", null],
    ["the body is a bare array", [{ urls: "turn:t:3478" }]],
    ["the body is a number", 7],
  ];

  for (const [name, body] of malformed) {
    it(`returns a classification rather than throwing: ${name}`, async () => {
      const cfg = await fetchIceConfig("483920", reply(body));
      // Resolved, not rejected — the assertion that matters. A code room with
      // no usable relay left is "none"; an unreadable body is "unavailable".
      expect(["none", "unavailable", "ok"]).toContain(cfg.relayStatus);
      expect(Array.isArray(cfg.iceServers)).toBe(true);
      expect(Array.isArray(cfg.relays)).toBe(true);
    });
  }

  it("keeps the valid siblings of a malformed entry", async () => {
    const good = { urls: ["turn:good.example:3478"], username: "u", credential: "c" };
    const cfg = await fetchIceConfig("483920", reply({ iceServers: [null, { urls: 42 }, good] }));
    expect(cfg.iceServers).toEqual([good]);
    expect(cfg.relayStatus).toBe("ok");
  });

  it("keeps the valid relays of a pool with one malformed member", async () => {
    const good = { id: "fra", iceServers: [{ urls: ["turn:fra.example:3478"], username: "u", credential: "c" }] };
    const cfg = await fetchIceConfig("483920", reply({ relays: [{ id: 7 }, null, good] }));
    expect(cfg.relays).toEqual([good]);
    expect(cfg.relayStatus).toBe("ok");
  });

  it("drops only the unusable URLs of an otherwise usable entry", async () => {
    const cfg = await fetchIceConfig("483920", reply({
      iceServers: [{ urls: ["turn:t:3478", 42, null, ""], username: "u", credential: "c" }],
    }));
    expect(cfg.iceServers).toEqual([{ urls: ["turn:t:3478"], username: "u", credential: "c" }]);
    expect(cfg.relayStatus).toBe("ok");
  });

  // Sanitising must not quietly rewrite a healthy response: the objects a
  // caller gets back are the ones the server sent, credentials and all.
  it("returns a well-formed body untouched", async () => {
    const body = {
      iceServers: [{ urls: "stun:s:3478" }, { urls: ["turn:t:3478"], username: "u", credential: "c" }],
      relays: [{ id: "tok", region: "ap-northeast", stun: "stun:tok:3478", iceServers: [{ urls: ["turn:tok:3478"], username: "ut", credential: "ct" }] }],
    };
    const cfg = await fetchIceConfig("483920", reply(body));
    expect(cfg.iceServers).toEqual(body.iceServers);
    expect(cfg.relays).toEqual(body.relays);
    expect(cfg.relayStatus).toBe("ok");
  });

  // A withheld relay is an ANSWER. Sanitising an empty pool beside it must not
  // downgrade the reason the UI shows into a generic "none".
  it("keeps a server's own denial reason over an empty sanitised pool", async () => {
    const cfg = await fetchIceConfig("483920", reply({ iceServers: [{ urls: 42 }], relays: [], relayDenied: "quota" }));
    expect(cfg.relayStatus).toBe("quota");
  });

  it("does not invent a denial from a non-string relayDenied", async () => {
    const cfg = await fetchIceConfig("483920", reply({ iceServers: [{ urls: "stun:s:3478" }], relayDenied: { reason: "quota" } }));
    expect(cfg.relayStatus).toBe("none");
    expect(cfg.relayDenied).toBeUndefined();
  });

  // A transport that is broken rather than merely failing — it throws
  // something that is not a Response — still has to produce a classification.
  it("classifies a transport that returns a non-Response", async () => {
    const cfg = await fetchIceConfig("483920", (async () => undefined) as unknown as IceTransport);
    expect(cfg.relayStatus).toBe("unavailable");
  });

  it("classifies a transport that throws synchronously", async () => {
    const cfg = await fetchIceConfig("483920", (() => { throw new Error("boom"); }) as unknown as IceTransport);
    expect(cfg.relayStatus).toBe("unavailable");
  });
});
