// My Devices as a sender directory: what the PAGE owes the cards.
//
// The card itself is covered by DeviceCard.test.ts. This suite is about the two
// things only the page can get wrong: keeping presence fresh without polling a
// backgrounded tab, and not letting one account's device list — or an in-flight
// send — survive into another account's session.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount } from "svelte";
import MePage from "./MePage.svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import { loadLang } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import { CAP_RECEIVE_V2, DEVICE_REFRESH_MS, INBOX_KEY_ALGORITHM } from "./device-inbox";

const sendSpy = vi.fn();
const fetchTaskSpy = vi.fn();

vi.mock("./device-send", async (orig) => {
  const real = await orig<typeof import("./device-send")>();
  return {
    ...real,
    sendFilesToDevice: (...args: unknown[]) => sendSpy(...args),
    fetchInboxTask: (...args: unknown[]) => fetchTaskSpy(...args),
  };
});

const ZERO_KEY = "A".repeat(43);
const SHARED_ID = "0123456789abcdef0123456789abcdef"; // deliberately present in BOTH accounts

function inbox(over: Record<string, unknown> = {}) {
  return {
    Presence: "online",
    LastHeartbeatAt: 1_700_000_000,
    PresenceExpiresAt: 1_700_000_090,
    HeartbeatIntervalSeconds: 30,
    Capabilities: [CAP_RECEIVE_V2, "inbox.autoaccept.v1"],
    ReceiveCapability: CAP_RECEIVE_V2,
    ProtocolVersion: 1,
    AutoAccept: "auto",
    ReceiveDirReady: true,
    Platform: "linux",
    AppVersion: "0.15.0",
    Revoked: false,
    CanReceive: true,
    RegisteredAt: 1_699_000_000,
    Key: { ID: "k1", Algorithm: INBOX_KEY_ALGORITHM, PublicKey: ZERO_KEY, Generation: 1, CreatedAt: 1, SupersededAt: 0, RevokedAt: 0 },
    ...over,
  };
}

const A_DEVICES = {
  devices: [
    { ID: SHARED_ID, Name: "build-server", CreatedAt: 1, LastSeenAt: 9, Kind: "cli", Inbox: inbox() },
    { ID: "no-inbox-device-000000000000000", Name: "old-vps", CreatedAt: 1, LastSeenAt: 2, Kind: "cli", Inbox: null },
  ],
};
const B_DEVICES = {
  devices: [{ ID: SHARED_ID, Name: "grace-nas", CreatedAt: 1, LastSeenAt: 9, Kind: "cli", Inbox: inbox() }],
};

const USER_A = { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true };
const USER_B = { id: "u2", email: "b@c.d", displayName: "B", hasPassword: true };
let currentUser: typeof USER_A | null = USER_A;
let devicesReply: () => unknown = () => A_DEVICES;
let deviceRequests = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.startsWith("/api/devices")) {
        deviceRequests++;
        return json(devicesReply());
      }
      if (u.startsWith("/api/nodes/mine")) return json({ nodes: [] });
      if (u.startsWith("/api/files")) return json({ files: [] });
      if (u.startsWith("/api/stats")) return json({ transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 });
      if (u.startsWith("/api/me/usage")) {
        return json({ period: "202608", resetsAt: 0, traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 } });
      }
      if (u.startsWith("/api/me")) return currentUser ? json({ user: currentUser }) : new Response("no", { status: 401 });
      return json({});
    }),
  );
  return calls;
}

let host: ReturnType<typeof mount> | null = null;
let dialog: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

const settle = () => vi.advanceTimersByTimeAsync(20);

async function render() {
  target = document.createElement("div");
  document.body.appendChild(target);
  host = mount(MePage, { target });
  dialog = mount(ConfirmModal, { target });
  await settle();
  return target;
}

beforeEach(async () => {
  vi.useFakeTimers();
  await loadLang("en");
  document.body.innerHTML = "";
  currentUser = USER_A;
  devicesReply = () => A_DEVICES;
  deviceRequests = 0;
  sendSpy.mockReset();
  fetchTaskSpy.mockReset();
  fetchTaskSpy.mockResolvedValue(undefined);
  sendSpy.mockResolvedValue({
    ID: "aaaabbbbccccddddeeeeffff00001111",
    State: "queued", ErrorCode: "", CiphertextBytes: 1, SavedAt: 0, TerminalAt: 0,
    Terminal: false, ExpiresAt: 0, CreatedAt: 0, UpdatedAt: 0, TargetKeyID: "k1", TargetKeyGeneration: 1,
  });
  // Clear any session left behind by another suite before this page mounts.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
  await refreshSession();
  vi.unstubAllGlobals();
});

afterEach(() => {
  if (host) { unmount(host); host = null; }
  if (dialog) { unmount(dialog); dialog = null; }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function dropOn(zone: Element, files: File[]) {
  // jsdom has no FileList constructor and its DataTransfer carries no files, so
  // the list is built by hand. Index keys are assigned rather than spread so
  // `length` has exactly one definition.
  const list: Record<string | number, unknown> = { item: (i: number) => files[i] ?? null };
  files.forEach((f, i) => (list[i] = f));
  list.length = files.length;
  const e = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, "dataTransfer", { value: { files: list, items: [], types: ["Files"] } });
  zone.dispatchEvent(e);
}

describe("My Devices as a send directory", () => {
  it("explains what sending to a device means, and offers a target only where one exists", async () => {
    stubFetch();
    await render();
    expect(target.textContent).toContain("encrypted in this browser");
    const rows = [...target.querySelectorAll(".devicelist li")];
    expect(rows).toHaveLength(2);
    const withInbox = rows.find((r) => r.textContent?.includes("build-server"))!;
    const without = rows.find((r) => r.textContent?.includes("old-vps"))!;
    expect(withInbox.querySelector(".sendzone")).not.toBeNull();
    expect(without.querySelector(".sendzone"), "a device with no inbox was offered as a target").toBeNull();
    // Revoke survives for both — this section's original job is unchanged.
    expect(rows.every((r) => r.querySelector("button.del"))).toBe(true);
  });

  it("refreshes presence on a bounded timer while the tab is visible", async () => {
    stubFetch();
    await render();
    const initial = deviceRequests;
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS + 100);
    expect(deviceRequests, "presence went stale — the list was never refreshed").toBe(initial + 1);
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS + 100);
    expect(deviceRequests).toBe(initial + 2);
  });

  it("does not refresh a backgrounded tab, and catches up when it returns", async () => {
    stubFetch();
    await render();
    const initial = deviceRequests;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS * 3);
    expect(deviceRequests, "a hidden tab kept polling the device list").toBe(initial);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(deviceRequests).toBe(initial + 1);
    hidden.mockRestore();
  });

  it("stops refreshing once the page is gone", async () => {
    stubFetch();
    await render();
    unmount(host!);
    host = null;
    const after = deviceRequests;
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS * 4);
    expect(deviceRequests, "an unmounted page kept refreshing").toBe(after);
  });

  it("a presence refresh does not interrupt a send already running on that card", async () => {
    let report!: (p: { phase: string; sent: number; total: number }) => void;
    sendSpy.mockImplementation((_t: unknown, _f: unknown, opts: { onProgress: typeof report }) => {
      report = opts.onProgress;
      return new Promise(() => {});
    });
    stubFetch();
    await render();
    const row = [...target.querySelectorAll(".devicelist li")].find((r) => r.textContent?.includes("build-server"))!;
    dropOn(row.querySelector(".sendzone")!, [new File(["x"], "a.bin")]);
    await settle();
    report({ phase: "uploading", sent: 50, total: 100 });
    await settle();
    expect(row.querySelector(".sendstatus")!.textContent).toContain("50%");

    // The device goes offline; the row must update its presence WITHOUT losing
    // the transfer running on it.
    devicesReply = () => ({
      devices: [{ ...A_DEVICES.devices[0], Inbox: inbox({ Presence: "offline" }) }, A_DEVICES.devices[1]],
    });
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS + 100);
    const same = [...target.querySelectorAll(".devicelist li")].find((r) => r.textContent?.includes("build-server"))!;
    expect(same.textContent).toContain("Offline");
    expect(same.querySelector(".sendstatus")!.textContent, "the refresh destroyed the in-flight send").toContain("50%");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the cards and an in-flight send when a presence refresh fails", async () => {
    let report!: (p: { phase: string; sent: number; total: number }) => void;
    sendSpy.mockImplementation((_t: unknown, _f: unknown, opts: { onProgress: typeof report }) => {
      report = opts.onProgress;
      return new Promise(() => {});
    });
    stubFetch();
    await render();
    const row = [...target.querySelectorAll(".devicelist li")].find((r) => r.textContent?.includes("build-server"))!;
    dropOn(row.querySelector(".sendzone")!, [new File(["x"], "a.bin")]);
    await settle();
    report({ phase: "uploading", sent: 50, total: 100 });
    await settle();

    devicesReply = () => { throw new Error("offline"); };
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS + 100);

    const same = [...target.querySelectorAll(".devicelist li")].find((r) => r.textContent?.includes("build-server"))!;
    expect(same, "a failed refresh removed the last trustworthy device list").toBeTruthy();
    expect(same.querySelector(".sendstatus")!.textContent, "a failed refresh aborted the in-flight send").toContain("50%");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe("account boundaries", () => {
  it("an in-flight send does not survive into another account's session", async () => {
    // Both accounts own a device with the SAME id, and the list is keyed by id,
    // so the row can be reused rather than rebuilt. The card watches the session
    // itself for exactly this.
    stubFetch();
    await render();
    const row = [...target.querySelectorAll(".devicelist li")].find((r) => r.textContent?.includes("build-server"))!;
    dropOn(row.querySelector(".sendzone")!, [new File(["x"], "a.bin")]);
    await settle();
    expect(row.querySelector(".sendstatus")!.textContent).toContain("Waiting for the device");

    devicesReply = () => B_DEVICES;
    currentUser = USER_B;
    await refreshSession();
    await settle();

    expect(target.textContent, "the previous account's device stayed on screen").not.toContain("build-server");
    expect(target.textContent).toContain("grace-nas");
    const status = target.querySelector(".sendstatus")!.textContent ?? "";
    expect(status, "another account's transfer is still being reported").toBe("");
  });

  it("signing out removes the section entirely", async () => {
    stubFetch();
    await render();
    expect(target.querySelector(".accountdevices")).not.toBeNull();
    currentUser = null;
    await refreshSession();
    await settle();
    expect(target.querySelector(".accountdevices")).toBeNull();
  });
});
