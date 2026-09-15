// 一个存储对象落到磁盘上的那一段：明文流按清单切成文件、零字节条目也要被创建、
// 每个 sink 只 close 一次（close 就是提交）。
//
// 这里专盯**断线续传之后**这些不变量还成不成立：续传发生在 downloadBlob 内部，
// 上面这一层根本看不见它 —— 看不见是对的，但"看不见"必须意味着"没受影响"，而不是
// "重复写了一段没人发现"。用真密文 + 真 ReadableStream，sink 是记录式替身。
import { describe, it, expect, vi, afterEach } from "vitest";
import { writeStoredObject, storedSaveSpecs, storedTotalBytes } from "./stored-download";
import { generateStoreKey, encryptFiles } from "./store-crypto";
import type { FileMetaLite, FileSink, SaveTarget } from "./filesink";
import type { StoredManifest } from "./store-crypto";

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 一份真密文 + 每个文件的原始明文。 */
async function fixture(sizes: number[]) {
  const sk = await generateStoreKey();
  const files = sizes.map((n, i) => {
    const bytes = new Uint8Array(n);
    for (let j = 0; j < n; j++) bytes[j] = (i * 31 + j) & 0xff;
    return new File([bytes], `d${i}.bin`);
  });
  const frames: Uint8Array[] = [];
  for await (const fr of encryptFiles(files, sk.key)) frames.push(fr);
  const plains = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
  const manifest: StoredManifest = { files: files.map((f, i) => ({ name: f.name, size: sizes[i] })) };
  return { key: sk.key, cipher: concat(frames), plains, manifest };
}

/** 记录式保存目标：每个文件收到的字节、关了几次、done 有没有被调过。 */
function recorder() {
  const opened: string[] = [];
  const writes = new Map<string, Uint8Array[]>();
  const closes = new Map<string, number>();
  let done = 0;
  const target: SaveTarget = {
    label: "记录式目标",
    file: async (name: string): Promise<FileSink> => {
      opened.push(name);
      writes.set(name, writes.get(name) ?? []);
      return {
        write: async (b: Uint8Array) => { writes.get(name)!.push(b.slice()); },
        close: async () => { closes.set(name, (closes.get(name) ?? 0) + 1); },
      };
    },
    done: async () => { done++; },
  };
  return {
    target,
    opened,
    closes,
    doneCount: () => done,
    bytes: (name: string) => concat(writes.get(name) ?? []),
  };
}

/** 见 stored-file.test.ts 的同名替身：认 `bytes=N-`，可以在任意字节处掐断。 */
function serve(cipher: Uint8Array, turns: { deliver?: number; cut?: boolean }[] = []) {
  const ranges: (string | null)[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const raw = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    ranges.push(raw);
    const t = turns[i++] ?? {};
    const m = /^bytes=(\d+)-$/.exec(raw ?? "");
    const start = m ? Number(m[1]) : 0;
    const tail = cipher.subarray(start);
    const give = t.deliver ?? tail.length;
    let off = 0;
    return {
      ok: true,
      status: start > 0 ? 206 : 200,
      headers: new Headers(
        start > 0
          ? {
              "Content-Range": `bytes ${start}-${cipher.length - 1}/${cipher.length}`,
              "Content-Length": String(cipher.length - start),
            }
          : { "Accept-Ranges": "bytes", "Content-Length": String(cipher.length) },
      ),
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          if (off < give) {
            c.enqueue(tail.slice(off, Math.min(off + 8192, give)));
            off += 8192;
            return;
          }
          if (t.cut) c.error(new TypeError("network error"));
          else c.close();
        },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { ranges, fetchMock };
}

/** 假时钟推到 promise 落定为止（退避是真的 setTimeout）。 */
async function settle<T>(p: Promise<T>): Promise<T | Error> {
  const done = p.then((v) => v as T | Error).catch((e: Error) => e);
  for (let i = 0; i < 40; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    const raced = await Promise.race([done, Promise.resolve("pending" as const)]);
    if (raced !== "pending") return raced;
  }
  return done;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("writeStoredObject 与断线续传", () => {
  it("断在文件边界两侧：每个文件的字节逐字节正确，且各只 close 一次", async () => {
    // 三个文件、两次中断，其中一次刻意落在跨文件的那一块明文中间。
    const { key, cipher, plains, manifest } = await fixture([150 * 1024, 90 * 1024, 40 * 1024]);
    serve(cipher, [
      { deliver: 60 * 1024, cut: true },
      { deliver: 120 * 1024, cut: true },
    ]);
    vi.useFakeTimers();
    const r = recorder();
    const out = await settle(writeStoredObject({ id: "obj", key, manifest, target: r.target }));
    expect(out, String(out)).toBeUndefined();
    for (let i = 0; i < plains.length; i++) {
      expect(r.bytes(`d${i}.bin`), `d${i}.bin 的内容不对`).toEqual(plains[i]);
    }
    // 重复交付会同时表现为字节变长和 close 变多 —— 两条都钉住。
    expect(r.opened).toEqual(["d0.bin", "d1.bin", "d2.bin"]);
    expect([...r.closes.values()]).toEqual([1, 1, 1]);
    expect(r.doneCount()).toBe(1);
  });

  it("空文件夹在续传之后照样被创建（密文里没有它们的帧）", async () => {
    const { key, cipher, plains, manifest } = await fixture([100 * 1024, 0, 0]);
    serve(cipher, [{ deliver: 30 * 1024, cut: true }]);
    vi.useFakeTimers();
    const r = recorder();
    const out = await settle(writeStoredObject({ id: "obj", key, manifest, target: r.target }));
    expect(out, String(out)).toBeUndefined();
    expect(r.opened).toEqual(["d0.bin", "d1.bin", "d2.bin"]);
    expect(r.bytes("d0.bin")).toEqual(plains[0]);
    expect(r.bytes("d1.bin").length).toBe(0);
    expect(r.bytes("d2.bin").length).toBe(0);
    expect(r.doneCount()).toBe(1);
  });

  it("把重连状态原样交给调用方 —— 界面才有话可说", async () => {
    const { key, cipher, manifest } = await fixture([120 * 1024]);
    serve(cipher, [{ deliver: 20 * 1024, cut: true }]);
    vi.useFakeTimers();
    const r = recorder();
    const seen: { phase: string; attempt: number; max: number }[] = [];
    const out = await settle(
      writeStoredObject({
        id: "obj",
        key,
        manifest,
        target: r.target,
        onRecovery: (x) => seen.push({ phase: x.phase, attempt: x.attempt, max: x.max }),
      }),
    );
    expect(out, String(out)).toBeUndefined();
    expect(seen.map((s) => s.phase)).toEqual(["waiting", "resuming", "streaming"]);
    expect(seen[0].attempt).toBe(1);
    expect(seen[0].max).toBeGreaterThan(1);
  });

  it("退避等待中取消：不再打开新文件、不 done()、不报完成", async () => {
    const { key, cipher, manifest } = await fixture([150 * 1024, 40 * 1024]);
    const { fetchMock } = serve(cipher, [{ deliver: 20 * 1024, cut: true }]);
    vi.useFakeTimers();
    const r = recorder();
    const ac = new AbortController();
    const run = writeStoredObject({ id: "obj", key, manifest, target: r.target, signal: ac.signal });
    const settled = run.then(() => null).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(100); // 停在退避里
    ac.abort();
    const err = await settled;
    expect((err as DOMException).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.doneCount(), "取消之后仍然收尾了这一批").toBe(0);
    expect(r.opened).toEqual(["d0.bin"]); // 只有开跑时那一个
    expect([...r.closes.values()], "取消之后提交了文件").toEqual([]);
  });

  it("specs / 总量这些纯函数不受续传影响", () => {
    const manifest: StoredManifest = { files: [{ name: "trip/day1/a.txt", size: 3 }, { name: "b.bin", size: 5 }] };
    const specs: FileMetaLite[] = storedSaveSpecs(manifest);
    expect(specs[0]).toEqual({ name: "a.txt", size: 3, path: "trip/day1/a.txt" });
    expect(specs[1].path).toBeUndefined();
    expect(storedTotalBytes(manifest)).toBe(8);
  });
});
