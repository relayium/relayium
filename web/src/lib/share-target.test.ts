import { describe, it, expect, vi, afterEach } from "vitest";
import { drainSharedFiles } from "./share-target";

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
