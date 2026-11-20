import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureAccount } from "../../src/main/inbox/account.js";
import { InboxFiles } from "../../src/main/inbox/files.js";
import { SentHistoryStore } from "../../src/main/inbox/sent-history.js";
import type { InboxSentHistoryView } from "../../src/shared/ipc-contract.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const entry = (id = "job-ab"): InboxSentHistoryView => ({ id, peerID: "peer-1", createdAt: 100,
  kind: "text", body: "私密\n🧪", bytes: new TextEncoder().encode("私密\n🧪").byteLength, items: [], state: "queued" });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sent-history-")); roots.push(root);
  const context = captureAccount({ accountID: "account-1", deviceID: "self", epoch: 1, inboxRoot: root });
  const key = crypto.getRandomValues(new Uint8Array(32)); const files = new InboxFiles(context);
  return { context, files, key, store: new SentHistoryStore(context, files, async () => key) };
}
it("retains exact Unicode text across restart in authenticated ciphertext only", async () => {
  const f = await fixture(); await f.store.record(entry());
  const encrypted = await readFile(`${f.context.directory}/sent-history.enc`);
  expect(encrypted.includes(Buffer.from("私密"))).toBe(false); expect(encrypted.includes(Buffer.from("peer-1"))).toBe(false);
  const reopened = new SentHistoryStore(f.context, f.files, async () => f.key);
  expect(await reopened.list()).toEqual([entry()]);
  const copy = await reopened.list(); (copy[0] as { body: string }).body = "changed";
  expect((await reopened.list())[0]?.body).toBe("私密\n🧪");
});
it("retains authenticated device aliases across roster removal and restart without plaintext or mutable references", async () => {
  const f = await fixture();
  await f.store.rememberPeers({ "peer-1": "家里的 Windows", "peer-2": "Mac" });
  await f.store.rememberPeers({ "peer-2": "Renamed Mac" });
  const raw = await readFile(`${f.context.directory}/sent-history.enc`);
  expect(raw.includes(Buffer.from("家里的"))).toBe(false);
  const reopened = new SentHistoryStore(f.context, f.files, async () => f.key);
  expect(await reopened.peerNames()).toEqual({ "peer-1": "家里的 Windows", "peer-2": "Renamed Mac" });
  const copy = await reopened.peerNames(); (copy as Record<string, string>)["peer-1"] = "changed";
  expect((await reopened.peerNames())["peer-1"]).toBe("家里的 Windows");
  expect(() => reopened.rememberPeers({ "peer-1": "unsafe\u202ename" })).toThrow();
});
it("a snapshot delete preserves a later arrival and late results cannot resurrect deleted rows", async () => {
  const f = await fixture(); await f.store.record(entry());
  const snapshot = (await f.store.list()).map((item) => item.id);
  await f.store.record(entry("job-cd")); await f.store.remove(snapshot);
  await f.store.update("job-ab", { body: "replacement", state: "saved" });
  const reopened = new SentHistoryStore(f.context, f.files, async () => f.key);
  await reopened.record(entry());
  expect((await reopened.list()).map((item) => item.id)).toEqual(["job-cd"]);
  expect((await f.store.list()).map((item) => item.id)).toEqual(["job-cd"]);
});
it("refuses cross-account replay and preserves unreadable bytes", async () => {
  const f = await fixture(); await f.store.record(entry());
  const raw = await readFile(`${f.context.directory}/sent-history.enc`);
  const other = captureAccount({ accountID: "other", deviceID: "self", epoch: 2, inboxRoot: roots[0]! });
  const files = new InboxFiles(other); await files.mkdirp(other.directory);
  await files.writeAtomic(`${other.directory}/sent-history.enc`, raw);
  const stolen = new SentHistoryStore(other, files, async () => f.key);
  await expect(stolen.list()).rejects.toThrow(); await expect(stolen.record(entry("job-cd"))).rejects.toThrow();
  expect(await readFile(`${other.directory}/sent-history.enc`)).toEqual(raw);
});
it("never treats corrupt or inaccessible storage as an empty history", async () => {
  const f = await fixture(); await f.files.mkdirp(f.context.directory);
  await writeFile(`${f.context.directory}/sent-history.enc`, "broken");
  const reopened = new SentHistoryStore(f.context, f.files, async () => f.key);
  await expect(reopened.record(entry())).rejects.toThrow();
  expect(await readFile(`${f.context.directory}/sent-history.enc`, "utf8")).toBe("broken");
});
it("serialises simultaneous record/update/delete and validates text byte counts", async () => {
  const f = await fixture();
  await expect(f.store.record({ ...entry(), bytes: 1 })).rejects.toThrow();
  await Promise.all([f.store.record(entry()), f.store.record(entry("job-cd"))]);
  await Promise.all([f.store.update("job-ab", { state: "saved" }), f.store.remove(["job-cd"])]);
  expect(await f.store.list()).toEqual([{ ...entry(), state: "saved" }]);
});
