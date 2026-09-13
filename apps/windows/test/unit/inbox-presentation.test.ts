// The named history store: what it keeps, and what it refuses to invent.
//
// REAL WebCrypto, a REAL temp directory and the REAL at-rest sealing. The
// assertions that matter are about truthfulness — a partial recorded as a
// partial, an unreadable record distinguished from an empty one, and a
// substitution failing authentication rather than decrypting into something
// plausible.

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureAccount } from "../../src/main/inbox/account.js";
import { newAtRestKeyBytes, importAtRestKey, seal } from "../../src/main/inbox/atrest.js";
import {
  InboxPresentationStore,
  MAX_PRESENTATION_RECORDS,
  MAX_SEALED_BYTES,
  type PresentationRecord,
} from "../../src/main/features/inbox-presentation.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const files = {
  async readFile(path: string) {
    return new Uint8Array(await readFile(path));
  },
  async writeAtomic(path: string, bytes: Uint8Array) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async mkdirp(path: string) {
    await mkdir(path, { recursive: true });
  },
};

async function store() {
  const root = await mkdtemp(join(tmpdir(), "inbox-presentation-"));
  roots.push(root);
  const context = captureAccount({
    accountID: "dev-1",
    deviceID: "dev-1",
    epoch: 1,
    inboxRoot: `${root}/inbox`,
  });
  const raw = newAtRestKeyBytes();
  const key = await importAtRestKey(raw);
  return { context, key, store: new InboxPresentationStore(context, files, async () => key) };
}

const ENTRY = (over: Partial<PresentationRecord> = {}): PresentationRecord => ({
  taskID: "task-1",
  receivedAt: 1_700_000_000,
  text: false,
  declared: 2,
  items: [
    { name: "report.pdf", size: 10 },
    { name: "photos/one.jpg", size: 20 },
  ],
  ...over,
});

describe("the named history store", () => {
  it("keeps names and sizes, newest first, and survives a reload", async () => {
    const { context, key, store: first } = await store();
    await first.record(ENTRY());
    await first.record(ENTRY({ taskID: "task-2", receivedAt: 1_700_000_100 }));

    // A SECOND instance over the same directory: this is what a restart is.
    const reopened = new InboxPresentationStore(context, files, async () => key);
    const listed = await reopened.list();
    expect(listed.map((r) => r.taskID)).toEqual(["task-2", "task-1"]);
    expect(listed[0]?.items.map((i) => i.name)).toEqual(["report.pdf", "photos/one.jpg"]);
  });

  it("records a partial as a partial, never the whole manifest", async () => {
    // The reassuring lie this store exists to avoid: presenting everything the
    // sender declared as though it had all been saved.
    const { store: s } = await store();
    await s.record(ENTRY({ declared: 7, items: [{ name: "one.bin", size: 1 }] }));
    const [record] = await s.list();
    expect(record?.declared).toBe(7);
    expect(record?.items).toHaveLength(1);
  });

  it("is idempotent by task id", async () => {
    const { store: s } = await store();
    await s.record(ENTRY());
    await s.record(ENTRY({ receivedAt: 999 }));
    expect(await s.list()).toHaveLength(1);
  });

  it("refuses when full rather than evicting what the user was shown", async () => {
    const { store: s } = await store();
    for (let i = 0; i < MAX_PRESENTATION_RECORDS; i += 1) {
      await s.record(ENTRY({ taskID: `task-${String(i)}` }));
    }
    await expect(s.record(ENTRY({ taskID: "one-too-many" }))).rejects.toMatchObject({
      code: "too-large",
    });
    // And nothing already recorded was dropped to make room.
    expect(await s.list()).toHaveLength(MAX_PRESENTATION_RECORDS);
  });

  it("deletes one record, and only when asked", async () => {
    const { store: s } = await store();
    await s.record(ENTRY());
    await s.record(ENTRY({ taskID: "task-2" }));
    await s.remove("task-1");
    expect((await s.list()).map((r) => r.taskID)).toEqual(["task-2"]);
  });

  it("reports an unreadable record rather than starting fresh", async () => {
    // Starting fresh would silently discard the user's history — the failure
    // this whole store exists to avoid.
    const { context, key, store: s } = await store();
    await s.record(ENTRY());
    await writeFile(`${context.directory}/presentation.enc`, "not an envelope");
    const reopened = new InboxPresentationStore(context, files, async () => key);
    await expect(reopened.list()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses a record sealed as a different KIND", async () => {
    // The kind is in the associated data, so a journal or vault record dropped
    // in here fails authentication rather than decrypting into something
    // plausible. That is the whole point of the additive AAD kind.
    const { context, key, store: s } = await store();
    await s.record(ENTRY());
    const impostor = await seal(key, context.accountKey, "journal", new TextEncoder().encode("{}"));
    await writeFile(`${context.directory}/presentation.enc`, impostor);
    const reopened = new InboxPresentationStore(context, files, async () => key);
    await expect(reopened.list()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses a record sealed under a different ACCOUNT", async () => {
    const { context, key, store: s } = await store();
    await s.record(ENTRY());
    const otherAccount = await seal(key, "another-account-digest", "presentation", new TextEncoder().encode("{}"));
    await writeFile(`${context.directory}/presentation.enc`, otherAccount);
    const reopened = new InboxPresentationStore(context, files, async () => key);
    await expect(reopened.list()).rejects.toMatchObject({ code: "unreadable" });
  });
});

// ---------------------------------------------------------------------------
// Negative controls: the three ways this store used to invent history
// ---------------------------------------------------------------------------
//
// Each of these was a REAL defect in the first cut of this file, found by an
// independent probe rather than by the tests above. They are kept as named
// controls because all three are the kind of bug that reappears the moment
// somebody makes the store "more forgiving".

describe("a read that fails for a reason other than absence", () => {
  /** `readFile` that fails with a chosen errno, like a real filesystem does. */
  function faultyFiles(code: string, failing: string) {
    return {
      ...files,
      async readFile(path: string) {
        if (path.endsWith(failing)) {
          throw Object.assign(new Error(`${code}: simulated`), { code });
        }
        return files.readFile(path);
      },
    };
  }

  it("is unreadable, NOT empty — and the next capture does not overwrite it", async () => {
    // The journal's own bug, one store later: a catch-all made EACCES look like
    // "nothing has ever been received", and the very next write destroyed the
    // history that could not be read.
    const { context, key, store: s } = await store();
    await s.record(ENTRY());
    const before = await readFile(`${context.directory}/presentation.enc`);

    const blocked = new InboxPresentationStore(context, faultyFiles("EACCES", "presentation.enc"), async () => key);
    await expect(blocked.list()).rejects.toMatchObject({ code: "unreadable" });

    // The capture that follows must FAIL rather than start a fresh history.
    await expect(blocked.record(ENTRY({ taskID: "task-after-fault" }))).rejects.toMatchObject({
      code: "unreadable",
    });

    // And the bytes on disk are untouched: the record that could not be read is
    // still exactly the record that was there.
    const after = await readFile(`${context.directory}/presentation.enc`);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
    // Readable again once the fault clears, with its original content intact.
    const recovered = new InboxPresentationStore(context, files, async () => key);
    expect((await recovered.list()).map((r) => r.taskID)).toEqual(["task-1"]);
  });

  it("treats EIO the same way, and ENOENT as the only empty", async () => {
    const { context, key } = await store();
    const io = new InboxPresentationStore(context, faultyFiles("EIO", "presentation.enc"), async () => key);
    await expect(io.list()).rejects.toMatchObject({ code: "unreadable" });

    // Nothing has ever been written here, so the real read raises ENOENT — the
    // ONE case that legitimately reads as empty.
    const missing = new InboxPresentationStore(context, files, async () => key);
    expect(await missing.list()).toEqual([]);
  });
});

describe("what a caller is handed", () => {
  it("cannot be edited into the store's own state", async () => {
    // Only the outer array was frozen, so editing a returned item edited the
    // cache — and the next read returned the edit as though it had been
    // received that way. A history rewritten with no write.
    const { store: s } = await store();
    await s.record(ENTRY());

    const first = await s.list();
    // Cast through `unknown` deliberately: the returned type IS readonly, and
    // the point of this control is that a caller who ignores that — which is
    // what a plain JavaScript caller does — still cannot reach the store's
    // state.
    const mutable = first[0] as unknown as {
      taskID: string;
      declared: number;
      items: { name: string; size: number }[];
    };
    mutable.items[0]!.name = "invoice-YOU-owe-me.pdf";
    mutable.items[0]!.size = 999;
    mutable.items.push({ name: "extra.bin", size: 1 });
    mutable.declared = 99;
    mutable.taskID = "not-task-1";

    const second = await s.list();
    expect(second[0]?.taskID).toBe("task-1");
    expect(second[0]?.declared).toBe(2);
    expect(second[0]?.items.map((i) => i.name)).toEqual(["report.pdf", "photos/one.jpg"]);
    expect(second[0]?.items[0]?.size).toBe(10);

    // And it survives a reload, because nothing was written either.
    expect((await s.list())[0]?.items).toHaveLength(2);
  });
});

describe("a record that is not presentable", () => {
  /** Nothing may be written by a refused capture. */
  async function refuses(over: Partial<PresentationRecord>, code = "invalid"): Promise<void> {
    const { context, key, store: s } = await store();
    await expect(s.record(ENTRY(over))).rejects.toMatchObject({ code });
    // Refused BEFORE any write: the file does not exist at all.
    const reopened = new InboxPresentationStore(context, files, async () => key);
    expect(await reopened.list()).toEqual([]);
  }

  it("refuses a name past the protocol's byte ceiling rather than truncating it", async () => {
    // The observed failure: a 4097-character name was accepted and written,
    // silently shortened to something no sender ever sent.
    await refuses({ declared: 1, items: [{ name: "a".repeat(1025), size: 1 }] });
    // 1024 BYTES is the protocol's limit and is accepted unchanged.
    const { store: s } = await store();
    const exact = "a".repeat(1024);
    await s.record(ENTRY({ declared: 1, items: [{ name: exact, size: 1 }] }));
    expect((await s.list())[0]?.items[0]?.name).toBe(exact);
  });

  it("measures that ceiling in UTF-8 bytes, as every other implementation does", async () => {
    // 512 two-byte characters is 1024 bytes: acceptable. 513 is 1026 and is not,
    // even though the string is far shorter than any character count would say.
    const { store: s } = await store();
    await s.record(ENTRY({ taskID: "t-ok", declared: 1, items: [{ name: "é".repeat(512), size: 0 }] }));
    await expect(
      s.record(ENTRY({ taskID: "t-no", declared: 1, items: [{ name: "é".repeat(513), size: 0 }] })),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses every name shape that would escape the folder the user chose", async () => {
    for (const name of [
      "../escape.txt",
      "a/../../escape.txt",
      "/absolute.txt",
      "C:/drive.txt",
      "C:relative.txt",
      "back\\slash.txt",
      "bell\u0007.txt",
      "nul\u0000.txt",
      "a//b.txt",
      "./here.txt",
      "",
      "deep/".repeat(64) + "leaf.txt",
    ]) {
      await refuses({ declared: 1, items: [{ name, size: 1 }] });
    }
  });

  it("refuses a count, a size or an id that is not what it claims to be", async () => {
    await refuses({ declared: 1, items: [{ name: "a.bin", size: -1 }] });
    await refuses({ declared: 1, items: [{ name: "a.bin", size: 1.5 }] });
    await refuses({ declared: 1, items: [{ name: "a.bin", size: Number.NaN }] });
    await refuses({ declared: -1, items: [] });
    await refuses({ receivedAt: -1 });
    await refuses({ taskID: "" });
    await refuses({ taskID: "t".repeat(257) });
    // More published than declared is neither a partial nor a whole.
    await refuses({ declared: 1, items: [{ name: "a.bin", size: 1 }, { name: "b.bin", size: 1 }] });
    // A message lands in the vault; `describeManifest` refuses a text item that
    // carries a name at all, so a record claiming one could not have happened.
    await refuses({ text: true, declared: 1, items: [{ name: "message.txt", size: 1 }] });
  });

  it("refuses more items than the manifest ceiling rather than clamping to it", async () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ name: `f-${String(i)}.bin`, size: 0 }));
    await refuses({ declared: 1001, items });
  });
});

describe("a document on disk", () => {
  /** Seal an arbitrary document under the real at-rest key and kind. */
  async function plant(document: unknown): Promise<{ store: InboxPresentationStore }> {
    const { context, key } = await store();
    const sealed = await seal(
      key,
      context.accountKey,
      "presentation",
      new TextEncoder().encode(JSON.stringify(document)),
    );
    await mkdir(context.directory, { recursive: true });
    await writeFile(`${context.directory}/presentation.enc`, sealed);
    return { store: new InboxPresentationStore(context, files, async () => key) };
  }

  it("gets the same validation a caller's record does, not a repair", async () => {
    // Written by an older build, or tampered with. The two are indistinguishable
    // and neither is a licence to guess at what the user was sent.
    const { store: s } = await plant({
      v: 1,
      records: [{ ...ENTRY(), declared: 1, items: [{ name: "a".repeat(4097), size: 1 }] }],
    });
    await expect(s.list()).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses a traversal name that reached the file some other way", async () => {
    const { store: s } = await plant({
      v: 1,
      records: [{ ...ENTRY(), declared: 1, items: [{ name: "../../etc/passwd", size: 1 }] }],
    });
    await expect(s.list()).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses more records than this store would ever write", async () => {
    const records = Array.from({ length: MAX_PRESENTATION_RECORDS + 1 }, (_, i) => ENTRY({ taskID: `t-${String(i)}` }));
    const { store: s } = await plant({ v: 1, records });
    await expect(s.list()).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses a version it does not know", async () => {
    const { store: s } = await plant({ v: 2, records: [] });
    await expect(s.list()).rejects.toMatchObject({ code: "malformed" });
  });

  it("is bounded BEFORE it is decrypted", async () => {
    // The size gate runs on the sealed bytes, so an oversized file is refused
    // without the key being touched at all. The at-rest key throws to prove it.
    const { context } = await store();
    await mkdir(context.directory, { recursive: true });
    await writeFile(`${context.directory}/presentation.enc`, Buffer.alloc(MAX_SEALED_BYTES + 1, 0x41));
    const s = new InboxPresentationStore(context, files, () => {
      throw new Error("the key must not be needed to refuse an oversized document");
    });
    await expect(s.list()).rejects.toMatchObject({ code: "too-large" });
  });
});
