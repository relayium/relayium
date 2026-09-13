// Settings that must survive a broken account store.
//
// Both preferences govern transfers that work signed out, so the failure mode
// that matters is not "the file is wrong" — it is "the file could not be read,
// and the app answered the wrong way about a security prompt".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  PreferenceStore,
  PreferenceStoreError,
  isPreferenceKey,
  preferencesPath,
} from "../../src/main/preferences.js";
import { readdir } from "node:fs/promises";

let dir = "";
const store = () => new PreferenceStore(preferencesPath(dir));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relayium-prefs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("defaults", () => {
  it("asks for no verification and joins no room, on an untouched install", async () => {
    // Both mirror the shipped Mac behaviour. `verifyPeers` is
    // `com.relayium.verifyPeers`, whose absent key means off.
    expect(await store().read()).toEqual({ verifyPeers: false, firstCloseAcknowledged: false });
    expect(DEFAULT_PREFERENCES.verifyPeers).toBe(false);
    // Same-network receiving is deliberately NOT here: the shipped Mac joins
    // unconditionally at launch and keeps its pause in memory only.
    expect(Object.keys(DEFAULT_PREFERENCES)).toEqual(["verifyPeers", "firstCloseAcknowledged"]);
  });

  it("takes the defaults for a file that is not JSON", async () => {
    await writeFile(preferencesPath(dir), "<!doctype html>", "utf8");
    expect(await store().read()).toEqual(DEFAULT_PREFERENCES);
  });

  it("treats a JSON document that is not this schema as UNREADABLE", async () => {
    // The dangerous case: it parses, so an earlier version called it healthy
    // and served the defaults as though the user had chosen them. For
    // `verifyPeers` that silently answers a security question the user may have
    // answered the other way.
    for (const body of ["[1,2,3]", "null", '"nope"', "42", '{"verifyPeers":"yes"}', '{"verifyPeers":1}']) {
      await writeFile(preferencesPath(dir), body, "utf8");
      const snapshot = await store().snapshot();
      expect([body, snapshot.health]).toEqual([body, "unreadable"]);
      expect([body, snapshot.values]).toEqual([body, DEFAULT_PREFERENCES]);
    }
  });

  it("still accepts a file that merely predates a preference", async () => {
    // An ABSENT field is not malformed: nobody has ever set it, and the default
    // is genuinely the right answer.
    await writeFile(preferencesPath(dir), "{}", "utf8");
    const snapshot = await store().snapshot();
    expect(snapshot.health).toBe("ok");
    expect(snapshot.values).toEqual(DEFAULT_PREFERENCES);
  });

  it("refuses to write over a file whose schema it could not read", async () => {
    await writeFile(preferencesPath(dir), '{"verifyPeers":"yes"}', "utf8");
    await expect(store().write("verifyPeers", false)).rejects.toBeInstanceOf(PreferenceStoreError);
    expect(await readFile(preferencesPath(dir), "utf8")).toBe('{"verifyPeers":"yes"}');
  });

  it("keeps the fields it understands and defaults the rest", async () => {
    // A file written by another build must be read, not rejected.
    await writeFile(preferencesPath(dir), JSON.stringify({ verifyPeers: true, future: "x" }), "utf8");
    expect(await store().read()).toEqual({ verifyPeers: true, firstCloseAcknowledged: false });
  });

  it("ignores a non-boolean value rather than coercing it", async () => {
    await writeFile(preferencesPath(dir), JSON.stringify({ verifyPeers: "yes" }), "utf8");
    // Refused, not coerced. See the unreadable case above.
    expect((await store().snapshot()).health).toBe("unreadable");
  });

  it("does NOT cache a failed read as this session's answer", async () => {
    const s = store();
    expect(await s.read()).toEqual(DEFAULT_PREFERENCES);

    // The file becomes readable. A store that had cached the defaults would
    // keep answering "off" for the rest of the session — and then write that
    // over a preference the user had actually set.
    await writeFile(preferencesPath(dir), JSON.stringify({ verifyPeers: true }), "utf8");
    expect((await s.read()).verifyPeers).toBe(true);
  });
});

describe("writing", () => {
  it("persists the last value written", async () => {
    const s = store();
    await s.write("verifyPeers", true);
    await s.write("verifyPeers", false);
    await s.write("verifyPeers", true);
    expect(await new PreferenceStore(preferencesPath(dir)).read()).toEqual({ verifyPeers: true, firstCloseAcknowledged: false });
  });

  it("leaves no staging file behind", async () => {
    // Written to a sibling and renamed, so a crash mid-write leaves the
    // previous file intact rather than a truncated one that reads as "no
    // answer" — which for `verifyPeers` would turn a prompt back off.
    await store().write("verifyPeers", true);
    await expect(readFile(`${preferencesPath(dir)}.new`, "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(preferencesPath(dir), "utf8"))).toEqual({
      verifyPeers: true,
      firstCloseAcknowledged: false,
    });
  });

  it("creates the directory if it does not exist yet", async () => {
    const nested = new PreferenceStore(join(dir, "deep", "nested", "preferences.json"));
    await nested.write("verifyPeers", true);
    expect((await nested.read()).verifyPeers).toBe(true);
  });

  it("holds no secret", async () => {
    await store().write("verifyPeers", true);
    const raw = await readFile(preferencesPath(dir), "utf8");
    // Booleans by name, and nothing else. A token or a code appearing here
    // would be a credential in a plaintext file.
    expect(JSON.parse(raw)).toEqual({ verifyPeers: true, firstCloseAcknowledged: false });
  });
});

describe("concurrent writes", () => {
  it("serialises writes so the last one wins rather than a stale snapshot", async () => {
    const s = store();
    await Promise.all([
      s.write("verifyPeers", true),
      s.write("verifyPeers", false),
      s.write("verifyPeers", true),
    ]);
    expect(await new PreferenceStore(preferencesPath(dir)).read()).toEqual({ verifyPeers: true, firstCloseAcknowledged: false });
  });

  it("leaves no staging file behind after concurrent writes", async () => {
    // A shared `.new` sibling meant the second write could rename a file the
    // first had already moved, and fail with ENOENT.
    const s = store();
    await Promise.all([
      s.write("verifyPeers", true),
      s.write("verifyPeers", false),
      s.write("verifyPeers", true),
    ]);
    expect((await readdir(dir)).filter((f) => f.includes(".new"))).toEqual([]);
  });

  it("keeps two stores on one file from corrupting it", async () => {
    // Two `PreferenceStore` instances is what a second window would produce.
    const a = new PreferenceStore(preferencesPath(dir));
    const b = new PreferenceStore(preferencesPath(dir));
    await Promise.all([a.write("verifyPeers", true), b.write("verifyPeers", true)]);
    expect(await new PreferenceStore(preferencesPath(dir)).read()).toEqual({ verifyPeers: true, firstCloseAcknowledged: false });
  });
});

describe("an unreadable file is never silently rebuilt", () => {
  it("reports health rather than presenting defaults as the user's choice", async () => {
    await writeFile(preferencesPath(dir), "{ this is not json", "utf8");
    const snapshot = await store().snapshot();
    // The values are the safe defaults, but the caller can tell they are not
    // the user's — which is the difference between "off" and "unknown".
    expect(snapshot.values).toEqual(DEFAULT_PREFERENCES);
    expect(snapshot.health).toBe("unreadable");
  });

  it("distinguishes a fresh install from a broken file", async () => {
    expect((await store().snapshot()).health).toBe("missing");
    await writeFile(preferencesPath(dir), "{}", "utf8");
    expect((await store().snapshot()).health).toBe("ok");
  });

  it("REFUSES a write while the file is unreadable", async () => {
    // The one that matters. `verifyPeers: true` is a security decision. A write
    // that rebuilt the file from defaults would revert it and report success.
    await writeFile(preferencesPath(dir), "corrupt", "utf8");
    const s = store();
    await expect(s.write("verifyPeers", true)).rejects.toBeInstanceOf(PreferenceStoreError);
  });

  it("does not overwrite the corrupt file it refused to use", async () => {
    await writeFile(preferencesPath(dir), "corrupt", "utf8");
    await store().write("verifyPeers", true).catch(() => undefined);
    // Left exactly as found, so a later repair can still recover it.
    expect(await readFile(preferencesPath(dir), "utf8")).toBe("corrupt");
  });

  it("writes normally once the file becomes readable again", async () => {
    await writeFile(preferencesPath(dir), "corrupt", "utf8");
    const s = store();
    await expect(s.write("verifyPeers", true)).rejects.toThrow();

    await writeFile(preferencesPath(dir), JSON.stringify({ verifyPeers: true }), "utf8");
    await s.write("verifyPeers", true);
    // And the preference the user had set is still there.
    expect(await new PreferenceStore(preferencesPath(dir)).read()).toEqual({ verifyPeers: true, firstCloseAcknowledged: false });
  });

  it("writes on a fresh install, where nothing has been chosen yet", async () => {
    // A MISSING file is not a failure. Refusing here would make the settings
    // card permanently unusable on a new machine.
    await expect(store().write("verifyPeers", true)).resolves.toEqual({ verifyPeers: true, firstCloseAcknowledged: false });
  });

  it("does not let one refused write poison the queue behind it", async () => {
    await writeFile(preferencesPath(dir), "corrupt", "utf8");
    const s = store();
    const refused = s.write("verifyPeers", true).catch(() => "refused");
    expect(await refused).toBe("refused");
    // A second write is refused on its own merits, not stuck behind a rejected
    // tail promise.
    await expect(s.write("verifyPeers", true)).rejects.toBeInstanceOf(PreferenceStoreError);
  });
});

// Every case above builds a FRESH store, so its cache — when there was one —
// was always empty and the read always reached disk. These are the cases where
// a store has already read successfully, which is the state a running app is in
// approximately always, and which nothing here used to cover.
describe("a store that has already read is not a store that knows the file", () => {
  it("REFUSES a write when the file went corrupt after an earlier successful read", async () => {
    // The store reads a healthy file, so a cache would now hold real values.
    await writeFile(
      preferencesPath(dir),
      JSON.stringify({ verifyPeers: true, firstCloseAcknowledged: false }),
      "utf8",
    );
    const s = store();
    expect((await s.snapshot()).health).toBe("ok");

    // Something breaks the file — a bad shutdown, a disk error, another tool.
    await writeFile(preferencesPath(dir), "broken", "utf8");

    // A store answering from that earlier read reports "ok", never sees the
    // corruption, and rebuilds the file from what it remembers. That defeats
    // the refusal entirely and destroys a file that may still be recoverable.
    await expect(s.write("firstCloseAcknowledged", true)).rejects.toBeInstanceOf(PreferenceStoreError);
    expect(await readFile(preferencesPath(dir), "utf8")).toBe("broken");
  });

  it("does not answer a READ from an earlier one once another store has written", async () => {
    await writeFile(preferencesPath(dir), JSON.stringify({ verifyPeers: false }), "utf8");
    const a = store();
    const b = store();
    expect((await a.read()).verifyPeers).toBe(false);

    await b.write("verifyPeers", true);
    // `a` answered this question before, and the answer has changed. A
    // remembered one would leave a second window showing "off" for a security
    // preference the user has just turned on.
    expect((await a.read()).verifyPeers).toBe(true);
  });

  it("keeps the choice another store saved, when both had already read", async () => {
    // Two windows, both showing the settings card, both having read it.
    await writeFile(
      preferencesPath(dir),
      JSON.stringify({ verifyPeers: false, firstCloseAcknowledged: false }),
      "utf8",
    );
    const a = store();
    const b = store();
    await a.read();
    await b.read();

    await a.write("verifyPeers", true);
    // `b` writes a DIFFERENT field. From a remembered snapshot it would spread
    // `verifyPeers: false` back over the file and silently revert the security
    // decision `a` just saved — reporting success for it.
    await b.write("firstCloseAcknowledged", true);

    expect(JSON.parse(await readFile(preferencesPath(dir), "utf8"))).toEqual({
      verifyPeers: true,
      firstCloseAcknowledged: true,
    });
  });
});

// The Windows failure. `MoveFileEx` with replace-existing REFUSES a destination
// another handle has open, so a read overlapping a rename fails the WRITER with
// EPERM — where POSIX renames happily under an open reader and this passes for
// the wrong reason. Serialising writes against each other is not enough; the
// reads have to be in the same order.
describe("a read must not collide with another store's rename", () => {
  it("survives reads interleaved with writes from a second store", async () => {
    await writeFile(preferencesPath(dir), JSON.stringify({ verifyPeers: false }), "utf8");
    const reader = store();
    const writer = store();

    const reads = Array.from({ length: 40 }, () => reader.snapshot());
    const writes = Array.from({ length: 20 }, (_, i) => writer.write("verifyPeers", i % 2 === 0));
    const settled = await Promise.allSettled([...reads, ...writes]);

    const failed = settled.filter((r) => r.status === "rejected");
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    // Not one of them saw a half-written file either: every read is either the
    // old value or a new one, never a parse failure.
    for (const outcome of settled.slice(0, reads.length)) {
      expect((outcome as PromiseFulfilledResult<{ health: string }>).value.health).toBe("ok");
    }
  });

  it("leaves no staging file behind after interleaved reads and writes", async () => {
    const reader = store();
    const writer = store();
    await Promise.all([
      writer.write("verifyPeers", true),
      reader.snapshot(),
      writer.write("firstCloseAcknowledged", true),
      reader.snapshot(),
    ]);
    expect(await readdir(dir)).toEqual(["preferences.json"]);
  });
});

describe("the key list is closed", () => {
  it("accepts exactly the declared name", () => {
    expect(isPreferenceKey("verifyPeers")).toBe(true);
    expect(isPreferenceKey("lanReceiving")).toBe(false);
  });

  it("refuses anything else, including prototype members", () => {
    // A renderer that could name the key could write arbitrary content into a
    // file main later reads.
    for (const bad of ["", "other", "__proto__", "constructor", "toString"]) {
      expect([bad, isPreferenceKey(bad)]).toEqual([bad, false]);
    }
    expect(isPreferenceKey(1)).toBe(false);
    expect(isPreferenceKey(null)).toBe(false);
  });
});
