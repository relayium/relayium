import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadError } from "./stored-file";
import { startPreupload, resetPreupload, holdPreupload, preuploadProgress, preuploadDeadline, preuploadUnconfirmed, preuploadNotice } from "./preupload.svelte";
import { addToOutbox, clearOutbox, outboxState, removeFromOutbox, uploadedRefs } from "./outbox.svelte";

const CODE = "483920";
const picked = (name: string, size = 10 * 1024) => ({ file: new File([new Uint8Array(size)], name) });
const gate = () => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
type Hook = (id: number, signal?: AbortSignal) => Promise<void>;

// Exercise the real encrypted resumable uploader, not a replacement scheduler
// or a mocked uploadFileResumable. Each object's request sequence is checked.
function server(hooks: { init?: Hook; patch?: Hook; finish?: Hook; initStatus?: number; patchStatus?: (id: number) => number } = {}) {
  const state = { count: 0, active: 0, peak: 0, finals: [] as number[], starts: [] as string[], received: new Map<number, number>(), patching: new Set<number>() };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, req: RequestInit = {}) => {
    const signal = req.signal ?? undefined;
    const check = () => { if (signal?.aborted) throw new DOMException("aborted", "AbortError"); };
    if (url.startsWith("/api/uploads?")) {
      const id = ++state.count;
      state.starts.push(url);
      await hooks.init?.(id, signal);
      check();
      if (hooks.initStatus) return reply({}, hooks.initStatus);
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      state.received.set(id, 0);
      return reply({ uploadId: `u${id}`, chunkSize: 1024 * 1024 });
    }
    const match = /^\/api\/uploads\/u(\d+)(\/finalize)?$/.exec(url);
    if (!match) throw new Error(`unexpected request ${url}`);
    const id = Number(match[1]);
    expect(state.received.has(id)).toBe(true);
    if (match[2]) {
      expect(state.patching.has(id)).toBe(false);
      await hooks.finish?.(id, signal);
      check();
      state.active--;
      state.finals.push(id);
      return reply({ id: `obj-u${id}`, expiresAt: 2_000_000_000 + id });
    }
    if (req.method === "GET") return reply({ received: state.received.get(id) });
    expect(req.method).toBe("PATCH");
    expect(state.patching.has(id), "parallel PATCH on the same object").toBe(false);
    state.patching.add(id);
    try {
      await hooks.patch?.(id, signal);
      check();
      const status = hooks.patchStatus?.(id) ?? 200;
      if (status !== 200) return reply({}, status);
      const body = req.body as Uint8Array;
      const n = state.received.get(id)! + body.byteLength;
      state.received.set(id, n);
      return reply({ received: n, expiresAt: 2_000_000_000 + id });
    } finally { state.patching.delete(id); }
  }));
  return state;
}

beforeEach(() => { resetPreupload(); clearOutbox(); });
afterEach(() => { resetPreupload(); clearOutbox(); vi.unstubAllGlobals(); });

describe("bounded small-file preupload", () => {
  it("overlaps two small objects, keeps per-object order and stable keys when finalizes arrive backwards", async () => {
    const first = gate();
    const s = server({ finish: async (id) => { if (id === 1) await first.promise; } });
    addToOutbox([picked("first"), picked("second")]);
    const run = startPreupload(CODE);
    try {
      await vi.waitFor(() => expect([...s.finals]).toEqual([2]));
      expect(outboxState(0)).toBe("uploading");
      expect(outboxState(1)).toBe("uploaded");
      expect(preuploadProgress()?.token).toBeTruthy();
    } finally { first.open(); await run; }
    expect(s.peak).toBe(2);
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u1", "obj-u2"]);
    expect(new Set(uploadedRefs().map((r) => r.key)).size).toBe(2);
    expect(preuploadProgress()).toBeNull();
  });

  it("does not speculate beyond an unanswered or refused first admission", async () => {
    const first = gate();
    const s = server({ init: async () => first.promise, initStatus: 403 });
    addToOutbox([picked("a"), picked("b"), picked("c")]);
    const run = startPreupload(CODE);
    try { await vi.waitFor(() => expect(s.count).toBe(1)); expect(s.count).toBe(1); }
    finally { first.open(); await run; }
    expect(s.count).toBe(1);
    expect([0, 1, 2].map(outboxState)).toEqual(["staged", "staged", "staged"]);
  });

  it("lets two admitted objects finish on join but starts no third", async () => {
    const finish = gate();
    const s = server({ finish: async () => finish.promise });
    addToOutbox([picked("a"), picked("b"), picked("c")]);
    const run = startPreupload(CODE);
    try { await vi.waitFor(() => expect(s.active).toBe(2)); holdPreupload(CODE); }
    finally { finish.open(); await run; }
    expect(s.count).toBe(2);
    expect([0, 1, 2].map(outboxState)).toEqual(["uploaded", "uploaded", "staged"]);
  });

  it("runs large files alone, without starting a small sibling beside them", async () => {
    const s = server();
    addToOutbox([picked("big", 300 * 1024), picked("small"), picked("big2", 300 * 1024)]);
    await startPreupload(CODE);
    expect(s.peak).toBe(1);
    expect(s.finals).toHaveLength(3);
  });

  it("claims each of 128 small/empty entries exactly once across duplicate starts", async () => {
    const s = server();
    addToOutbox(Array.from({ length: 128 }, (_, i) => picked(String(i), i % 2 ? 10 * 1024 : 0)));
    await Promise.all([startPreupload(CODE), startPreupload(CODE)]);
    expect(s.count).toBe(128);
    expect(s.finals).toHaveLength(128);
    expect(s.peak).toBeLessThanOrEqual(2);
    expect(new Set(uploadedRefs().map((r) => r.id)).size).toBe(128);
    expect(new Set(uploadedRefs().map((r) => r.key)).size).toBe(128);
  });

  it("aborts both owners on reset, even when the same code is minted again; old refusals cannot close it", async () => {
    const old = gate();
    const signals: AbortSignal[] = [];
    const atFreshInit: unknown[] = [];
    const s = server({ init: async (id) => {
      if (id === 3) atFreshInit.push({ notice: preuploadNotice(), doubt: preuploadUnconfirmed(), deadline: preuploadDeadline() });
    }, finish: async (id, signal) => {
      if (id <= 2) { signals.push(signal!); await old.promise; throw new UploadError(410); }
    } });
    addToOutbox([picked("a"), picked("b")]);
    const run = startPreupload(CODE);
    let next: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      resetPreupload();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(preuploadProgress()).toBeNull();
      next = startPreupload(CODE);
      expect(s.count).toBe(2); // old owners must retire before any reclaim
    } finally { old.open(); await Promise.all([run, next]); }
    expect(s.count).toBe(4);
    expect(atFreshInit, "old aborts must not mark the fresh room uncertain even before its first answer").toEqual([{ notice: "", doubt: "", deadline: null }]);
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u3", "obj-u4"]);
    expect(preuploadNotice()).toBe("");
  });

  it("does not let a sibling's late success erase an ambiguous on-wire failure", async () => {
    const failed = gate();
    const finish = gate();
    const s = server({
      patch: async (id) => { if (id === 1) await failed.promise; },
      patchStatus: (id) => id === 1 ? 401 : 200,
      finish: async () => finish.promise,
    });
    addToOutbox([picked("a"), picked("b"), picked("c")]);
    const run = startPreupload(CODE);
    try {
      await vi.waitFor(() => expect(s.count).toBe(2));
      failed.open();
      await vi.waitFor(() => expect(preuploadUnconfirmed()).toBe(CODE));
    } finally { failed.open(); finish.open(); await run; }
    expect(s.count).toBe(2);
    expect(preuploadUnconfirmed()).toBe(CODE);
    expect([0, 1, 2].map(outboxState)).toEqual(["staged", "uploaded", "staged"]);
  });

  it("lets terminal expiry outrank every sibling's delayed deadline and key", async () => {
    const expired = gate();
    const finish = gate();
    const s = server({
      patch: async (id) => { if (id === 1) await expired.promise; },
      patchStatus: (id) => id === 1 ? 410 : 200,
      finish: async () => finish.promise,
    });
    addToOutbox([picked("a"), picked("b"), picked("c")]);
    const run = startPreupload(CODE);
    try {
      await vi.waitFor(() => expect(s.count).toBe(2));
      expired.open();
      await vi.waitFor(() => expect(preuploadNotice()).toBe("expired"));
    } finally { expired.open(); finish.open(); await run; }
    expect(s.count).toBe(2);
    expect(preuploadDeadline()).toBeNull();
    expect(preuploadUnconfirmed()).toBe("");
    expect(uploadedRefs()).toEqual([]);
    expect([0, 1, 2].map(outboxState)).toEqual(["staged", "staged", "staged"]);
  });

  it("does not let a sibling's late failure restore uncertainty after room expiry", async () => {
    const expired = gate();
    const failed = gate();
    const s = server({
      patch: async (id) => { await (id === 1 ? expired.promise : failed.promise); },
      patchStatus: (id) => id === 1 ? 410 : 401,
    });
    addToOutbox([picked("a"), picked("b")]);
    const run = startPreupload(CODE);
    try {
      await vi.waitFor(() => expect(s.count).toBe(2));
      expired.open();
      await vi.waitFor(() => expect(preuploadNotice()).toBe("expired"));
    } finally { expired.open(); failed.open(); await run; }
    expect(preuploadUnconfirmed()).toBe("");
    expect(preuploadDeadline()).toBeNull();
    expect(uploadedRefs()).toEqual([]);
  });

  it("does not assign a removed entry's late key to the shifted sibling", async () => {
    const finish = gate();
    const s = server({ finish: async () => finish.promise });
    addToOutbox([picked("a"), picked("b")]);
    const run = startPreupload(CODE);
    try { await vi.waitFor(() => expect(s.active).toBe(2)); removeFromOutbox(0); }
    finally { finish.open(); await run; }
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u2"]);
  });
});
