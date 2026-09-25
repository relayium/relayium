import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MePage from "./MePage.svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import { loadLang, setLang } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import { BROWSER_SENDER_LIMIT, browserSenderIdentities, supportedDevices } from "./device-list";
import { deviceSuffix } from "./device-identity";

// 发送用的浏览器登记（Kind = "browser"，POST /api/devices/browser-install 铸的
// HttpOnly 凭据）。服务端最多给一个账号 20 行；第 21 个浏览器的发送会被
// browser_device_limit 拒绝。以前没有任何客户端能列出或移除这些行，满了只能找
// 支持。/me 上单独一节管理它们：不和 App/CLI 混在一起（那样 /device-inbox 会把
// 浏览器当收件目标，吊销那句"要重新登录"也不成立）。
const DEVICES = {
  devices: [
    { ID: "d-cli-1", Name: "work-laptop", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_100_000, Kind: "cli" },
    // ID 里带斜杠和空格：移除要走路径拼接，没编码就会打到别的路径上。
    { ID: "br old/1", Name: "Web browser", CreatedAt: 1_690_000_000, LastSeenAt: 1_690_500_000, LastIP: "198.51.100.7", Kind: "browser" },
    { ID: "br-new-2", Name: "Web browser", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_200_000, Kind: "browser" },
    { ID: "br-idle-3", Name: "Web browser", CreatedAt: 1_700_300_000, LastSeenAt: 0, Kind: "browser" },
    { ID: "d-empty", Name: "kindless-row", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_000_000, Kind: "" },
  ],
};

// 新账号故意复用 A 的一条浏览器 ID：旧账号的移除响应若迟到，按 ID 过滤就会误删它。
const B_DEVICES = {
  devices: [
    { ID: "br-new-2", Name: "Grace browser", CreatedAt: 1_710_000_000, LastSeenAt: 1_710_100_000, Kind: "browser" },
  ],
};

const USER_A = { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true };
const USER_B = { id: "u2", email: "b@c.d", displayName: "B", hasPassword: true };
let currentUser: typeof USER_A | null = USER_A;
let devicesReply: () => Promise<Response>;
let deleteReply: () => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/devices") && init?.method === "DELETE") return deleteReply();
    if (url.startsWith("/api/devices")) return devicesReply();
    if (url.startsWith("/api/me") && !url.startsWith("/api/me/usage") && !currentUser) {
      return new Response("unauthorized", { status: 401 });
    }
    const body =
      url.startsWith("/api/nodes/mine") ? { nodes: [] } :
      url.startsWith("/api/files") ? { files: [] } :
      url.startsWith("/api/stats") ? { transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 } :
      url.startsWith("/api/me/usage") ? { period: "202607", resetsAt: 0, traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 } } :
      url.startsWith("/api/me") ? { user: currentUser } : {};
    return json(body);
  }));
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => {
  await loadLang("en");
  await setLang("en");
  document.body.innerHTML = "";
  currentUser = USER_A;
  devicesReply = async () => json(DEVICES);
  deleteReply = async () => json({});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
  await refreshSession();
  vi.unstubAllGlobals();
});

let hosts: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const h of hosts) unmount(h);
  hosts = [];
  vi.unstubAllGlobals();
});

async function render() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  // Unmounted in afterEach, not at the end of each test: a failed assertion
  // would otherwise leave this page mounted, still fetching, and taking the next
  // test's first /api/devices reply.
  hosts.push(mount(MePage, { target }));
  hosts.push(mount(ConfirmModal, { target }));
  await settle();
  return { target };
}

function senderRows(target: HTMLElement): Element[] {
  return [...target.querySelectorAll(".browsersenders .senderlist li")];
}
function senderRow(target: HTMLElement, suffix: string): Element | undefined {
  return senderRows(target).find((li) => li.querySelector(".senderref")?.textContent?.includes(suffix));
}
function refOf(id: string): string {
  return deviceSuffix(id); // what the row and its confirmation render
}
function dialogText(): string {
  return document.querySelector('[role="dialog"]')?.textContent ?? "";
}
function clickDialog(pattern: RegExp) {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => pattern.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
  expect(btn, `no dialog button matching ${pattern}`).toBeTruthy();
  btn!.click();
}
function deletes(calls: { url: string; init?: RequestInit }[]) {
  return calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url);
}

describe("browserSenderIdentities", () => {
  it("keeps only browser rows, most recently used first, and never feeds the App/CLI list", () => {
    const rows = browserSenderIdentities(DEVICES.devices);
    expect(rows.map((d) => d.ID)).toEqual(["br-new-2", "br old/1", "br-idle-3"]);
    expect(supportedDevices(DEVICES.devices).map((d) => d.ID)).toEqual(["d-cli-1"]);
  });

  it("matches the limit central enforces", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const storeGo = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "server", "account", "store.go"), "utf8");
    expect(storeGo).toContain(`const MaxBrowserDevicesPerAccount = ${BROWSER_SENDER_LIMIT}`);
  });
});

describe("MePage browser sending identities", () => {
  it("lists browser rows in their own section with count, id suffix, registration and last use", async () => {
    stubFetch();
    const { target } = await render();
    const section = target.querySelector(".browsersenders")!;
    expect(section.textContent).toContain("Browsers registered for sending");
    expect(section.textContent).toContain(`3 of ${BROWSER_SENDER_LIMIT} places used`);
    expect(senderRows(target)).toHaveLength(3);
    const old = senderRow(target, refOf("br old/1"))!;
    expect(old.textContent).toContain("Web browser");
    expect(old.textContent).toContain("Registered");
    expect(old.textContent).toContain("Last used");
    expect(old.textContent).toContain("198.51.100.7");
    expect(senderRow(target, refOf("br-idle-3"))!.textContent).toContain("No send recorded yet");
    expect(section.textContent, "a kind-less legacy row is not a counted browser identity").not.toContain("kindless-row");
    // Not offered as an App/CLI credential, and the CLI row is not offered here.
    expect(target.querySelector(".accountdevices")!.textContent).not.toContain("Web browser");
    expect(section.textContent).not.toContain("work-laptop");
  });

  it("shows the server's fixed name in the page language", async () => {
    await setLang("zh");
    stubFetch();
    const { target } = await render();
    const section = target.querySelector(".browsersenders")!;
    expect(section.textContent).toContain("登记用于发送的浏览器");
    expect(section.textContent).toContain("网页浏览器");
    expect(section.textContent).not.toContain("Web browser");
  });

  it("says so when no browser has sent yet", async () => {
    devicesReply = async () => json({ devices: [DEVICES.devices[0]] });
    stubFetch();
    const { target } = await render();
    expect(target.querySelector(".browsersenders")!.textContent).toContain("No browser has sent from this account yet.");
    expect(senderRows(target)).toHaveLength(0);
  });

  it("names the exact row in the confirmation and does not claim a sign-out", async () => {
    const calls = stubFetch();
    const { target } = await render();
    const btn = senderRow(target, refOf("br old/1"))!.querySelector("button") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toContain(refOf("br old/1"));
    btn.click();
    await settle();
    const text = dialogText();
    expect(text).toContain(refOf("br old/1"));
    expect(text).toContain("stays signed in");
    expect(text).toContain("sending again registers it as a new sender");
    expect(text).not.toMatch(/has to sign in again/i);
    clickDialog(/^Cancel$/i);
    await settle();
    expect(deletes(calls), "cancel must not delete").toEqual([]);
    expect(senderRows(target)).toHaveLength(3);
  });

  it("removes only that row, through the encoded id, and leaves the App/CLI list alone", async () => {
    const calls = stubFetch();
    const { target } = await render();
    (senderRow(target, refOf("br old/1"))!.querySelector("button") as HTMLButtonElement).click();
    await settle();
    clickDialog(/^Remove$/);
    await settle();
    expect(deletes(calls)).toEqual([`/api/devices/${encodeURIComponent("br old/1")}`]);
    expect(senderRows(target)).toHaveLength(2);
    expect(senderRow(target, refOf("br old/1"))).toBeUndefined();
    expect(target.querySelector(".browsersenders")!.textContent).toContain(`2 of ${BROWSER_SENDER_LIMIT} places used`);
    expect(target.querySelector(".accountdevices")!.textContent).toContain("work-laptop");
  });

  it("keeps the row and reports a failure the server refused", async () => {
    deleteReply = async () => json({ error: "failed" }, 500);
    stubFetch();
    const { target } = await render();
    (senderRow(target, refOf("br-new-2"))!.querySelector("button") as HTMLButtonElement).click();
    await settle();
    clickDialog(/^Remove$/);
    await settle();
    expect(senderRows(target)).toHaveLength(3);
    expect(target.querySelector(".action-err")?.textContent).toContain("Something went wrong");
  });

  it("clears the previous account's rows at once when the account switches", async () => {
    const second = deferred<Response>();
    let n = 0;
    devicesReply = async () => (++n === 1 ? json(DEVICES) : second.promise);
    stubFetch();
    const { target } = await render();
    expect(senderRows(target)).toHaveLength(3);
    currentUser = USER_B;
    await refreshSession();
    await settle();
    expect(senderRows(target), "the new account saw the old account's browsers").toHaveLength(0);
    second.resolve(json(B_DEVICES));
    await settle();
    expect(target.querySelector(".browsersenders")!.textContent).toContain("Grace browser");
  });

  it("a late removal from the previous account cannot remove the new account's row with the same id", async () => {
    const deletion = deferred<Response>();
    deleteReply = () => deletion.promise;
    stubFetch();
    const { target } = await render();
    (senderRow(target, refOf("br-new-2"))!.querySelector("button") as HTMLButtonElement).click();
    await settle();
    clickDialog(/^Remove$/);
    await settle();

    devicesReply = async () => json(B_DEVICES);
    currentUser = USER_B;
    await refreshSession();
    await settle();
    expect(target.querySelector(".browsersenders")!.textContent).toContain("Grace browser");

    deletion.resolve(json({}));
    await settle();
    expect(target.querySelector(".browsersenders")!.textContent, "late response removed the new account's row").toContain("Grace browser");
    expect(target.querySelector(".action-err")?.textContent ?? "").toBe("");
  });
});
