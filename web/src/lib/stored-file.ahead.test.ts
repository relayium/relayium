import { afterEach, expect, it, vi } from "vitest";
import { uploadFileResumable } from "./stored-file";
import { decodeKey, importStoreKey, StoreDecryptor, STORE_CHUNK_SIZE, encryptFiles, generateStoreKey } from "./store-crypto";

afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

it("does not start another file read when cancellation arrives during a pending read", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const file = { name: "blocked.bin", size: STORE_CHUNK_SIZE * 3, slice: () => {
    reads++;
    return { arrayBuffer: async () => { await gate; return new ArrayBuffer(STORE_CHUNK_SIZE); } };
  } } as unknown as File;
  const ac = new AbortController();
  const source = encryptFiles([file], (await generateStoreKey()).key, ac.signal);
  const pulling = source.next();
  expect(reads).toBe(1);
  ac.abort();release();
  await expect(pulling).rejects.toMatchObject({ name: "AbortError" });
  expect(reads).toBe(1);
  await source.return(undefined);
});

it("retains the original preparation path for server targets larger than 1 MiB", async () => {
  const real = new File([new Uint8Array(5 << 20)], "large-pack.bin");
  let reads = 0;
  let firstReads = 0;
  let patches = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ac = new AbortController();
  const file = { name: real.name, size: real.size, slice(a: number, b: number) { reads++; return real.slice(a, b); } } as File;
  vi.stubGlobal("fetch", async (_url: string, req?: RequestInit) => {
    if (req?.method === "POST") return json({ uploadId: "large1", chunkSize: 2 << 20 });
    if (req?.method !== "PATCH") throw Error("unexpected request");
    patches++;firstReads=reads;await gate;
    return json({ received: (req.body as Uint8Array).byteLength });
  });
  const upload = uploadFileResumable([file], {burnAfterRead:false,ttl:0}, undefined, ac.signal);
  try {
    await vi.waitFor(() => expect(firstReads).toBeGreaterThan(0));
    // File reads here resolve immediately; give any speculative producer a turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(firstReads);
    expect(patches).toBe(1);
  } finally { ac.abort();release();await expect(upload).rejects.toMatchObject({ name: "AbortError" }); }
});

it("prepares the next pack during a blocked PATCH and decrypts exactly once after partial/lost answers", async () => {
  const plain = Uint8Array.from({ length: STORE_CHUNK_SIZE * 24 + 71 }, (_, i) => i * 31);
  const real = new File([plain], "ahead.bin");
  let reads = 0;
  const file = {
    name: real.name, size: real.size,
    slice: (a: number, b: number) => { reads++; return real.slice(a, b); },
  } as File;
  let firstReads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let patches = 0;
  let active = 0;
  let finalized = 0;
  let retained = new Uint8Array();
  let uniqueBytes = 0;
  let sentBytes = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && input.startsWith("/api/uploads?")) return json({ uploadId: "ahead1", chunkSize: 1 << 20 });
    if (method === "GET") return json({ received: retained.length });
    if (method === "PATCH") {
      expect(active++).toBe(0);
      try {
        const body = (init!.body as Uint8Array).slice();
        sentBytes += body.length;
        const headers = init!.headers as Record<string, string>;
        const offset = Number(headers["Content-Range"].match(/^bytes (\d+)-/)![1]);
        expect(offset).toBe(retained.length);
        patches++;
        if (patches === 1) {
          firstReads = reads;
          await gate;
        }
        // A committed prefix with a lost answer; replay starts at that prefix.
        const take = patches === 1 ? Math.floor(body.length / 2) : body.length;
        const next = new Uint8Array(retained.length + take);
        next.set(retained); next.set(body.subarray(0, take), retained.length);
        retained = next;
        uniqueBytes += take;
        if (patches === 1) throw new TypeError("lost partial answer");
        if (patches === 3) throw new TypeError("lost complete answer");
        return json({ received: retained.length });
      } finally { active--; }
    }
    if (input.endsWith("/finalize")) { finalized++; return json({ id: "ahead1", expiresAt: 9 }); }
    throw new Error(`unexpected ${method} ${input}`);
  });
  const uploading = uploadFileResumable([file], { burnAfterRead: false, ttl: 0 });
  // Always release the pending request even when the causal old-source assertion fails.
  try {
    await vi.waitFor(() => {
      expect(firstReads).toBeGreaterThan(0);
      expect(reads, "next pack must prepare before the first PATCH answer").toBeGreaterThan(firstReads + 2);
    }, { timeout: 1500, interval: 10 });
  } catch (error) {
    release();
    await uploading.catch(() => {});
    throw error;
  } finally { release(); }
  const result = await uploading;
  expect(finalized).toBe(1);
  expect(uniqueBytes).toBe(retained.length);
  expect(sentBytes).toBeGreaterThan(uniqueBytes);
  const decryptor = new StoreDecryptor(await importStoreKey(decodeKey(result.key)));
  const chunks: Uint8Array[] = [];
  for await (const chunk of decryptor.push(retained)) chunks.push(chunk);
  for await (const chunk of decryptor.end(plain.length)) chunks.push(chunk);
  const actual = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let off = 0;
  for (const chunk of chunks) { actual.set(chunk, off); off += chunk.length; }
  expect(actual.length).toBe(plain.length);
  expect(await crypto.subtle.digest("SHA-256", actual)).toEqual(await crypto.subtle.digest("SHA-256", plain));
});
