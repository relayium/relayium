// W-N12 F-Web: a resumable share or Device Inbox upload whose finalize may have
// committed is never re-sent through the single-shot fallback, and a lost
// finalize answer is recovered as the SAME object through the server's
// `{"recoverFinalized":true}` record, decryptable with the key this upload
// encrypted it with.
//
// The fake server below keeps the server's facts, not just its answers: every
// committed chunk, the objects it stored, the daily debits they cost, and every
// single-shot POST. Its finalize follows answerFinalizeRecovery
// (server/account/uploads_resumable.go): the first finalize to arrive commits
// the object and its debit, and every later opted-in finalize of the same
// session is a pure read — 200 `recovered:true` for the live object, or a 409
// JSON outcome. Each test scripts only what the NETWORK does to a request: lose
// it, lose its answer, garble the answer, or have a server without recovery
// answer it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { settleWithFakeTimers, realTurn } from "./settle-fake-timers";
import { uploadFileResumable, UploadError, UploadFinalizeError, keyFromFragment } from "./stored-file";
import { StoreDecryptor } from "./store-crypto";

type Net =
  | "deliver" // the request arrives; its answer arrives
  | "lose-request" // the request never reaches the server
  | "lose-answer" // the request arrives and commits; its answer never comes back
  | "garble-answer" // the request arrives and commits; the 2xx body is unreadable
  | "drop-expiry" // the request arrives; the 2xx body lacks expiresAt
  | "gateway-502" // a proxy answers 502; the request may or may not have arrived (it did)
  | "legacy-409" // a server without finalize recovery answers the repeat: text 409
  | { status: number }; // the server refuses outright with this status

interface ServerOpts {
  /** What happens to each successive finalize request. Past the end: deliver. */
  finalizeNet?: Net[];
  /** Force the recovery outcome once the session is terminal. */
  outcome?: "running" | "failed" | "expired" | "removed";
  /** Running answers before the in-flight finalize commits (a racing finalize). */
  runningFor?: number;
  retryAfter?: string | null;
  /** init answers this instead of opening a session. */
  initStatus?: number;
  pairRoom?: boolean;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function installServer(opts: ServerOpts = {}) {
  const state = {
    committed: [] as Uint8Array[],
    received: 0,
    finalizeCalls: 0,
    finalizeBodies: [] as (string | null)[],
    objects: [] as { id: string; expiresAt: number }[],
    debits: 0,
    singleShots: 0,
    terminal: false,
    runningLeft: opts.runningFor ?? 0,
  };
  const net = [...(opts.finalizeNet ?? [])];
  const commit = () => {
    if (!state.terminal) {
      state.terminal = true;
      state.objects.push({ id: "obj00000000000000000000000000001", expiresAt: 1_800_000_000 });
      state.debits++;
      return { first: true };
    }
    return { first: false };
  };
  const recoveryAnswer = (): Response => {
    if (opts.outcome && opts.outcome !== "running") {
      return json({ error: "already_finalized", outcome: opts.outcome }, 409);
    }
    const o = state.objects[0];
    return json({ id: o.id, expiresAt: o.expiresAt, recovered: true });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.startsWith("/api/uploads?")) {
        if (opts.initStatus) return json({}, opts.initStatus);
        return json({ uploadId: "u1", chunkSize: 64 * 1024 });
      }
      if (method === "PATCH" && url === "/api/uploads/u1") {
        const body = new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer());
        state.committed.push(body.slice());
        state.received += body.length;
        return json({ received: state.received });
      }
      if (method === "GET" && url === "/api/uploads/u1") return json({ received: state.received });
      if (method === "POST" && url === "/api/uploads/u1/finalize") {
        state.finalizeCalls++;
        state.finalizeBodies.push(typeof init?.body === "string" ? init.body : null);
        const optIn = typeof init?.body === "string" && JSON.parse(init.body).recoverFinalized === true;
        const n = net.shift() ?? "deliver";
        if (n === "lose-request") throw new TypeError("network");
        if (typeof n === "object") return new Response("refused\n", { status: n.status });
        if (n === "gateway-502") {
          commit();
          return new Response("bad gateway", { status: 502 });
        }
        // From here the request has reached the server.
        if (state.runningLeft > 0) {
          state.runningLeft--;
          const h: Record<string, string> = {};
          if (opts.retryAfter !== null) h["Retry-After"] = opts.retryAfter ?? "5";
          return json({ error: "already_finalized", outcome: "running" }, 409, h);
        }
        if (opts.outcome === "running") {
          const h: Record<string, string> = {};
          if (opts.retryAfter !== null) h["Retry-After"] = opts.retryAfter ?? "5";
          return json({ error: "already_finalized", outcome: "running" }, 409, h);
        }
        if (n === "legacy-409") {
          commit();
          return new Response("already finalized\n", { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        let res: Response;
        // opts.outcome is not "running" here: that case returned above.
        if (!state.terminal && opts.outcome) {
          // A session some earlier request already ended without an object.
          state.terminal = true;
          res = json({ error: "already_finalized", outcome: opts.outcome }, 409);
        } else {
          const { first } = commit();
          const o = state.objects[0];
          res = first ? json({ id: o.id, expiresAt: o.expiresAt }) : optIn ? recoveryAnswer() : new Response("already finalized\n", { status: 409 });
        }
        if (n === "lose-answer") throw new TypeError("network");
        if (n === "garble-answer") return new Response('{"id":"obj0000', { status: 200, headers: { "content-type": "application/json" } });
        if (n === "drop-expiry") return json({ id: state.objects[0].id });
        return res;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
  // The single-shot fallback POSTs through XHR. Counted, and answered as a real
  // server would: a second object and a second debit.
  class CountingXHR {
    withCredentials = false;
    status = 0;
    responseText = "";
    upload = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    send() {
      state.singleShots++;
      state.objects.push({ id: "obj00000000000000000000000000002", expiresAt: 1_800_000_000 });
      state.debits++;
      queueMicrotask(() => {
        this.status = 200;
        this.responseText = JSON.stringify(state.objects[state.objects.length - 1]);
        this.onload?.();
      });
    }
    abort() {
      this.onabort?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", CountingXHR);
  return state;
}

const PLAIN = new Uint8Array(150_000).map((_, i) => (i * 7) & 0xff);
const file = () => new File([PLAIN], "report.bin");
const share = { burnAfterRead: false, ttl: 3600 } as const;

async function decrypts(committed: Uint8Array[], key: string): Promise<Uint8Array> {
  const all = new Uint8Array(committed.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of committed) {
    all.set(c, at);
    at += c.length;
  }
  const dec = new StoreDecryptor(await keyFromFragment(key));
  const parts: Uint8Array[] = [];
  for await (const pt of dec.push(all)) parts.push(pt);
  for await (const pt of dec.end()) parts.push(pt);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function run(p: Promise<unknown>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return settleWithFakeTimers(p);
}

describe("finalize recovery (F-Web)", () => {
  it("every non-pair-room finalize opts in; a clean finalize is one request", async () => {
    const s = installServer();
    const out = await uploadFileResumable([file()], share);
    expect(s.finalizeBodies).toEqual(['{"recoverFinalized":true}']);
    expect(out.id).toBe(s.objects[0].id);
    expect([s.objects.length, s.debits, s.singleShots]).toEqual([1, 1, 0]);
    expect(await decrypts(s.committed, out.key)).toEqual(PLAIN);
  });

  it("a lost finalize answer recovers the same object: one object, one debit, no re-send, decryptable", async () => {
    const s = installServer({ finalizeNet: ["lose-answer"] });
    const out = (await run(uploadFileResumable([file()], share))) as Awaited<ReturnType<typeof uploadFileResumable>>;
    expect(out).not.toBeInstanceOf(Error);
    expect(out.id).toBe(s.objects[0].id);
    expect(out.expiresAt).toBe(s.objects[0].expiresAt);
    expect([s.objects.length, s.debits, s.singleShots, s.finalizeCalls]).toEqual([1, 1, 0, 2]);
    expect(s.finalizeBodies.every((b) => b === '{"recoverFinalized":true}')).toBe(true);
    // The recovered id names ciphertext this upload's own key opens.
    expect(await decrypts(s.committed, out.key)).toEqual(PLAIN);
  });

  it("a Device Inbox upload recovers the same way", async () => {
    const s = installServer({ finalizeNet: ["lose-answer"] });
    const out = (await run(
      uploadFileResumable([file()], {
        burnAfterRead: false,
        ttl: 604_800,
        purpose: "device_task",
        sealedManifest: new Uint8Array([123, 125]),
      }),
    )) as Awaited<ReturnType<typeof uploadFileResumable>>;
    expect(out.id).toBe(s.objects[0].id);
    expect([s.objects.length, s.debits, s.singleShots]).toEqual([1, 1, 0]);
  });

  it("a garbled 2xx and a 502 are asked again, never re-sent", async () => {
    for (const first of ["garble-answer", "drop-expiry", "gateway-502"] as const) {
      const s = installServer({ finalizeNet: [first] });
      const out = (await run(uploadFileResumable([file()], share))) as Awaited<ReturnType<typeof uploadFileResumable>>;
      expect(out.id, first).toBe(s.objects[0].id);
      expect([s.objects.length, s.debits, s.singleShots], first).toEqual([1, 1, 0]);
      expect(await decrypts(s.committed, out.key)).toEqual(PLAIN);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("exhausted network failures end unconfirmed after a bounded number of requests, with no fallback", async () => {
    const s = installServer({ finalizeNet: ["lose-answer", "lose-request", "lose-request", "lose-request", "lose-request"] });
    const e = await run(uploadFileResumable([file()], share));
    expect(e).toBeInstanceOf(UploadFinalizeError);
    expect((e as UploadFinalizeError).outcome).toBe("unconfirmed");
    expect(s.finalizeCalls).toBe(4);
    expect([s.objects.length, s.debits, s.singleShots]).toEqual([1, 1, 0]);
  });

  it("unreadable 2xx answers every time end unconfirmed, with no fallback", async () => {
    const s = installServer({ finalizeNet: ["garble-answer", "garble-answer", "garble-answer", "garble-answer", "garble-answer"] });
    const e = await run(uploadFileResumable([file()], share));
    expect((e as UploadFinalizeError).outcome).toBe("unconfirmed");
    expect(s.finalizeCalls).toBe(4);
    expect([s.objects.length, s.debits, s.singleShots]).toEqual([1, 1, 0]);
  });

  it("a legacy text 409 is unconfirmed, never a fallback", async () => {
    // A server without recovery: the retry of a lost answer hears the text 409.
    const s = installServer({ finalizeNet: ["lose-answer", "legacy-409"] });
    const e = await run(uploadFileResumable([file()], share));
    expect(e).toBeInstanceOf(UploadFinalizeError);
    expect((e as UploadFinalizeError).outcome).toBe("unconfirmed");
    expect([s.objects.length, s.debits, s.singleShots, s.finalizeCalls]).toEqual([1, 1, 0, 2]);
  });

  it("running is followed with Retry-After, then the object", async () => {
    const s = installServer({ runningFor: 2, retryAfter: "3" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t0 = Date.now();
    const out = (await settleWithFakeTimers(uploadFileResumable([file()], share))) as Awaited<ReturnType<typeof uploadFileResumable>>;
    expect(out.id).toBe(s.objects[0].id);
    expect(s.finalizeCalls).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(6_000);
    expect([s.objects.length, s.debits, s.singleShots]).toEqual([1, 1, 0]);
  });

  it("Retry-After is bounded both ways", async () => {
    for (const [ra, want] of [["3600", 30_000], ["0", 1_000], ["soon", 5_000], [null, 5_000]] as const) {
      installServer({ runningFor: 1, retryAfter: ra });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const start = Date.now();
      const p = uploadFileResumable([file()], share);
      const out = await settleWithFakeTimers(p);
      expect(out, String(ra)).not.toBeInstanceOf(Error);
      expect(Date.now() - start, String(ra)).toBe(want);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("running that never ends is unconfirmed after a bounded number of polls", async () => {
    const s = installServer({ outcome: "running", retryAfter: "5" });
    const e = await run(uploadFileResumable([file()], share));
    expect((e as UploadFinalizeError).outcome).toBe("unconfirmed");
    expect(s.finalizeCalls).toBe(13);
    expect(s.singleShots).toBe(0);
  });

  it("failed, expired and removed are terminal, as themselves, with no fallback", async () => {
    for (const outcome of ["failed", "expired", "removed"] as const) {
      const s = installServer({ outcome });
      const e = await run(uploadFileResumable([file()], share));
      expect(e, outcome).toBeInstanceOf(UploadFinalizeError);
      expect((e as UploadFinalizeError).outcome).toBe(outcome);
      expect([s.finalizeCalls, s.singleShots], outcome).toEqual([1, 0]);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("a definitive first refusal keeps its status and does not fall back", async () => {
    for (const status of [401, 404, 413, 429]) {
      const s = installServer({ finalizeNet: [{ status }] });
      const e = await run(uploadFileResumable([file()], share));
      expect(e, String(status)).toBeInstanceOf(UploadError);
      expect((e as UploadError).status).toBe(status);
      expect([s.finalizeCalls, s.singleShots], String(status)).toEqual([1, 0]);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("a refusal after a request that may have committed is unconfirmed", async () => {
    const s = installServer({ finalizeNet: ["lose-answer", { status: 404 }] });
    const e = await run(uploadFileResumable([file()], share));
    expect((e as UploadFinalizeError).outcome).toBe("unconfirmed");
    expect([s.objects.length, s.singleShots]).toEqual([1, 0]);
  });

  // R1: "running" proves a finalize is in flight and may commit, so a refusal
  // that follows it is not proof that nothing was stored.
  it("a refusal after a running answer is unconfirmed, never a plain refusal or a fallback", async () => {
    for (const status of [401, 403, 404, 413, 429]) {
      const s = installServer({ runningFor: 1, retryAfter: "1", finalizeNet: ["deliver", { status }] });
      const e = await run(uploadFileResumable([file()], share));
      expect(e, String(status)).toBeInstanceOf(UploadFinalizeError);
      expect((e as UploadFinalizeError).outcome, String(status)).toBe("unconfirmed");
      expect([s.finalizeCalls, s.singleShots], String(status)).toEqual([2, 0]);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("known terminal outcomes after a running answer stay themselves", async () => {
    for (const outcome of ["failed", "expired", "removed"] as const) {
      const s = installServer({ runningFor: 1, retryAfter: "1", outcome });
      const e = await run(uploadFileResumable([file()], share));
      expect((e as UploadFinalizeError).outcome, outcome).toBe(outcome);
      expect([s.finalizeCalls, s.singleShots], outcome).toEqual([2, 0]);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("cancelling while waiting on a running answer stops: no more requests, no re-send", async () => {
    const s = installServer({ outcome: "running", retryAfter: "10" });
    const ctl = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = uploadFileResumable([file()], share, undefined, ctl.signal);
    const settled = p.then(
      () => "resolved",
      (e: Error) => e.name,
    );
    for (let i = 0; i < 10_000 && s.finalizeCalls < 2; i++) {
      await realTurn();
      if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    }
    expect(s.finalizeCalls).toBe(2);
    await realTurn();
    ctl.abort();
    expect(await settled).toBe("AbortError");
    const calls = s.finalizeCalls;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.finalizeCalls).toBe(calls);
    expect(s.singleShots).toBe(0);
  });

  it("a failure BEFORE finalize still takes the bounded single-shot fallback", async () => {
    const s = installServer({ initStatus: 404 });
    const out = await uploadFileResumable([file()], share);
    expect(s.finalizeCalls).toBe(0);
    expect(s.singleShots).toBe(1);
    expect(out.id).toBe("obj00000000000000000000000000002");
  });

  it("a pair-room finalize is unchanged: verifier only, no opt-in, no fallback", async () => {
    // Pair-room uploads need a live room; only the finalize request shape and
    // its failure path are under test, so init/PATCH are the same fake.
    const s = installServer({ finalizeNet: ["lose-request", "lose-request", "lose-request", "lose-request"] });
    const e = await run(uploadFileResumable([file()], { purpose: "pair_room", code: "123456" }));
    expect(e).toBeInstanceOf(UploadError);
    expect((e as UploadError).status).toBe(0);
    expect(s.finalizeCalls).toBe(4);
    for (const b of s.finalizeBodies) {
      const parsed = JSON.parse(b!);
      expect(Object.keys(parsed)).toEqual(["completionVerifier"]);
    }
    expect(s.singleShots).toBe(0);
  });
});
