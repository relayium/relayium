import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { paceRealtimeFileFrame, chargeCancelledRealtimeFrame, realtimeFileFrameBudget, resetUploadPacingForTests, uploadFileResumable } from "./stored-file";
import { saveSpeedPref, pacedBurst, worstWindowExcess } from "./transfer-control";
import { settleWithFakeTimers } from "./settle-fake-timers";

const rate = 128 * 1024;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  resetUploadPacingForTests(); saveSpeedPref({ mode: "cap", capBytesPerSec: rate });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); saveSpeedPref({ mode: "fast", capBytesPerSec: 1048576 }); });

it("shares one strict byte budget between actual stored requests and live frames", async () => {
  const sent: { t: number; bytes: number; kind: string }[] = [];
  let received = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, req: RequestInit = {}) => {
    const reply = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    if (url.startsWith("/api/uploads?")) return reply({ uploadId: "u1", chunkSize: 1048576 });
    if (url.endsWith("/finalize")) return reply({ id: "obj-u1", expiresAt: 2_000_000_000 });
    const bytes = (req.body as Uint8Array).byteLength;
    sent.push({ t: performance.now(), bytes, kind: "stored" }); received += bytes;
    return reply({ received });
  }));
  const live = async () => {
    for (let i = 0; i < 8; i++) {
      const bytes = realtimeFileFrameBudget(262144);
      await paceRealtimeFileFrame(bytes);
      sent.push({ t: performance.now(), bytes, kind: "live" });
    }
  };
  const outcome = await settleWithFakeTimers(Promise.all([
    live(), uploadFileResumable([new File([new Uint8Array(128 * 1024)], "stored.bin")], { purpose: "pair_room", code: "483920" }),
  ]));
  expect(outcome).not.toBeInstanceOf(Error);
  expect(new Set(sent.map((s) => s.kind)).size).toBe(2);
  expect(worstWindowExcess(sent, rate, pacedBurst(rate))).toBeLessThanOrEqual(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("retires a cancelled head immediately and repays its already-sealed crossing frame", async () => {
  const bytes = pacedBurst(rate);
  await paceRealtimeFileFrame(bytes); // spend the initial burst
  const ctl = new AbortController();
  const head = paceRealtimeFileFrame(bytes, ctl.signal).catch((err) => err);
  const start = performance.now();
  const next = paceRealtimeFileFrame(bytes);
  ctl.abort();
  expect((await head).name).toBe("AbortError");
  chargeCancelledRealtimeFrame(bytes);
  expect(await settleWithFakeTimers(next)).not.toBeInstanceOf(Error);
  expect(performance.now() - start, "the crossing frame must not get free tokens").toBeGreaterThanOrEqual(500);
  expect(vi.getTimerCount()).toBe(0);
});

it("replans a pending cap when Fast is chosen and removes its timer", async () => {
  const bytes = pacedBurst(rate);
  await paceRealtimeFileFrame(bytes);
  const pending = paceRealtimeFileFrame(bytes);
  saveSpeedPref({ mode: "fast", capBytesPerSec: rate });
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
  expect(realtimeFileFrameBudget(262144)).toBe(262144);
});
