import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadFileResumable, resetUploadPacingForTests } from "./stored-file";
import { saveSpeedPref, pacedBurst, worstWindowExcess } from "./transfer-control";
import { settleWithFakeTimers } from "./settle-fake-timers";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  resetUploadPacingForTests();
  saveSpeedPref({ mode: "cap", capBytesPerSec: 128 * 1024 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); saveSpeedPref({ mode: "fast", capBytesPerSec: 1048576 }); });

it("hands a shared pacing turn to the next upload immediately, without spending extra tokens", async () => {
  const sent: { t: number; bytes: number; id: string }[] = [];
  const offsets = new Map<string, number>();
  let seq = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, req: RequestInit = {}) => {
    const reply = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    if (url.startsWith("/api/uploads?")) {
      const id = `u${++seq}`; offsets.set(id, 0); return reply({ uploadId: id, chunkSize: 1024 });
    }
    const match = /^\/api\/uploads\/(u\d+)(\/finalize)?$/.exec(url)!;
    const id = match[1];
    if (match[2]) return reply({ id: `obj-${id}`, expiresAt: 2_000_000_000 });
    const body = req.body as Uint8Array;
    sent.push({ t: performance.now(), bytes: body.byteLength, id });
    const offset = offsets.get(id)! + body.byteLength;
    offsets.set(id, offset);
    return reply({ received: offset });
  }));
  const file = () => new File([new Uint8Array(128 * 1024)], "paced.bin");
  const result = await settleWithFakeTimers(Promise.all([
    uploadFileResumable([file()], { purpose: "pair_room", code: "483920" }),
    uploadFileResumable([file()], { purpose: "pair_room", code: "483920" }),
  ]));
  expect(result).not.toBeInstanceOf(Error);
  expect(new Set(sent.map((s) => s.id)).size).toBe(2);
  const rate = 128 * 1024;
  const capacity = Math.min(1024, pacedBurst(rate)); // this fixture requests 1KiB slices
  expect(worstWindowExcess(sent, rate, capacity)).toBeLessThanOrEqual(1);
  // Once encryption has produced the work, the FIFO handoff adds no 250ms
  // polling bubble. Ciphertext volume fixes the ideal token-bucket schedule;
  // allow one existing setting-poll interval for startup/real crypto turns,
  // plus the existing minimum 1ms timer quantization per dispatch.
  const bytes = sent.reduce((n, s) => n + s.bytes, 0);
  const ideal = ((bytes - capacity) * 1000) / rate;
  expect(sent.at(-1)!.t - sent[0].t, "polling-only FIFO handoff stranded available bandwidth").toBeLessThanOrEqual(ideal + 250 + sent.length);
  expect(vi.getTimerCount(), "every pacing timer is retired").toBe(0);
});
