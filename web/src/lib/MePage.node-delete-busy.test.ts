// A-M3 round 3: the server keeps a BYO node while upload sessions still name it
// (their ciphertext is reachable only through the node's record) and answers
// DELETE /api/nodes/{id} with 409. The page must say why, keep the node listed,
// and still report any other failure generically.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MePage from "./MePage.svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import { setLang, messages } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";

const USER = { id: "u1", email: "ada@example.com", displayName: "Ada", hasPassword: true };
const NODE = {
  id: "0123456789abcdef0123456789abcdef", name: "home", region: "", host: "203.0.113.7", online: true,
  relayedBytes: 0, storedBytes: 0, storageFree: 0, storageTotal: 0, lastSeen: 0,
};

let deleteStatus = 409;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/nodes/${NODE.id}` && init?.method === "DELETE") {
        return json({ error: "busy", code: "node_has_uploads" }, deleteStatus);
      }
      if (url.startsWith("/api/nodes/mine")) return json({ nodes: [NODE] });
      if (url.startsWith("/api/devices")) return json({ devices: [] });
      if (url.startsWith("/api/files")) return json({ files: [] });
      if (url.startsWith("/api/stats")) {
        return json({ transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 });
      }
      if (url.startsWith("/api/me/usage")) {
        return json({ period: "202609", resetsAt: 0, traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 } });
      }
      if (url.startsWith("/api/me")) return json({ user: USER });
      return json({});
    }),
  );
}

const settle = () => new Promise((r) => setTimeout(r, 30));
let app: unknown;
let dialog: unknown;
let target: HTMLDivElement;

beforeEach(async () => {
  document.body.innerHTML = "";
  deleteStatus = 409;
  stubFetch();
  await refreshSession();
});

afterEach(() => {
  if (app) unmount(app as never);
  if (dialog) unmount(dialog as never);
  app = dialog = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

async function removeNode() {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(MePage, { target });
  dialog = mount(ConfirmModal, { target });
  await settle();
  const del = target.querySelector<HTMLButtonElement>(".nodelist button.del");
  expect(del, "the node row has no remove button").toBeTruthy();
  del!.click();
  await settle();
  target.querySelector<HTMLButtonElement>("[role='dialog'] .btn-primary")!.click();
  await settle();
}

describe("removing a BYO node the server still needs", () => {
  for (const lang of ["en", "zh"] as const) {
    it(`409 explains the wait and keeps the node (${lang})`, async () => {
      await setLang(lang);
      await removeNode();
      const err = target.querySelector(".action-err")?.textContent?.trim() ?? "";
      const busy = messages[lang].me.delNodeBusy;
      expect(busy, `${lang} has no delNodeBusy copy`).toBeTruthy();
      expect(err).toBe(busy);
      expect(target.querySelector(".nodelist")?.textContent).toContain("home");
    });
  }

  it("any other failure stays the generic message", async () => {
    await setLang("en");
    deleteStatus = 500;
    await removeNode();
    expect(target.querySelector(".action-err")?.textContent?.trim()).toBe(messages.en.me.actionFailed);
  });
});
