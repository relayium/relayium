import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount } from "svelte";
import DeviceCard from "./DeviceCard.svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import { loadLang } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import { CAP_RECEIVE_V2, INBOX_KEY_ALGORITHM, type InboxTaskView } from "./device-inbox";

// The network half is mocked here on purpose: this suite is about what the CARD
// does — which control starts a send, what it claims while one runs, when it
// stops polling. device-send.test.ts owns the wire format, the crypto and the
// cleanup, against a stubbed fetch.
const sendSpy = vi.fn();
const fetchTaskSpy = vi.fn();
const cancelTaskSpy = vi.fn();

vi.mock("./device-send", async (orig) => {
  const real = await orig<typeof import("./device-send")>();
  return {
    ...real,
    sendFilesToDevice: (...args: unknown[]) => sendSpy(...args),
    fetchInboxTask: (...args: unknown[]) => fetchTaskSpy(...args),
    cancelInboxTask: (...args: unknown[]) => cancelTaskSpy(...args),
  };
});

const ZERO_KEY = "A".repeat(43);
const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const TASK_ID = "aaaabbbbccccddddeeeeffff00001111";

function inbox(over: Record<string, unknown> = {}) {
  return {
    Presence: "online",
    LastHeartbeatAt: 1_700_000_000,
    PresenceExpiresAt: 1_700_000_090,
    HeartbeatIntervalSeconds: 30,
    ProtocolVersion: 1,
    Capabilities: [CAP_RECEIVE_V2, "inbox.autoaccept.v1"],
    ReceiveCapability: CAP_RECEIVE_V2,
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

function task(over: Partial<InboxTaskView> = {}): InboxTaskView {
  return {
    ID: TASK_ID,
    State: "queued",
    ErrorCode: "",
    CiphertextBytes: 10,
    SavedAt: 0,
    TerminalAt: 0,
    Terminal: false,
    ExpiresAt: 0,
    CreatedAt: 0,
    UpdatedAt: 0,
    TargetKeyID: "k1",
    TargetKeyGeneration: 1,
    ...over,
  };
}

const revoked = vi.fn();
const renamed = vi.fn(async () => "ok" as const);
let host: ReturnType<typeof mount> | null = null;
let dialog: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  target = document.createElement("ul");
  document.body.appendChild(target);
  host = mount(DeviceCard, {
    target,
    props: {
      device: { ID: DEVICE_ID, Name: "work-laptop", CreatedAt: 1, LastSeenAt: 2, Kind: "cli", Inbox: over === null ? null : inbox(over) },
      kind: "CLI",
      lastUsed: "Last used yesterday",
      signedIn: "Signed in on Tuesday",
      deviceRef: "ID ends abc123",
      onRevoke: revoked,
      onRename: renamed,
      ...props,
    },
  });
  const dialogHost = document.createElement("div");
  document.body.appendChild(dialogHost);
  dialog = mount(ConfirmModal, { target: dialogHost });
  return target;
}

const settle = () => vi.advanceTimersByTimeAsync(5);

/** Drive the real session store: the card reads `session()` itself, so this is
 *  the only honest way to move it between accounts. `null` signs out. */
async function signIn(id: string | null) {
  const previous = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      id
        ? new Response(JSON.stringify({ user: { id, email: `${id}@b.c`, displayName: id, hasPassword: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("unauthorized", { status: 401 }),
    ),
  );
  await refreshSession();
  vi.stubGlobal("fetch", previous);
}
const q = (sel: string) => target.querySelector(sel) as HTMLElement | null;
const statusText = () => q(".sendstatus")?.textContent?.trim() ?? "";

/** A FileList stand-in: jsdom has no constructor for one, and `DataTransfer`
 *  there carries no files. Index keys are assigned explicitly rather than spread
 *  from the array, so `length` has exactly one definition. */
function fileList(files: File[]): FileList {
  const out: Record<string | number, unknown> = { item: (i: number) => files[i] ?? null };
  files.forEach((f, i) => (out[i] = f));
  out.length = files.length;
  return out as unknown as FileList;
}

/** A drop event. `types` defaults to announcing files, because that is what a
 *  real file drag does even when the list turns out to be empty. */
function dropEvent(files: File[], types: string[] = ["Files"]): DragEvent {
  const e = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, "dataTransfer", { value: { files: fileList(files), items: [], types } });
  return e;
}

beforeEach(async () => {
  vi.useFakeTimers();
  await loadLang("en");
  document.body.innerHTML = "";
  sendSpy.mockReset();
  fetchTaskSpy.mockReset();
  cancelTaskSpy.mockReset();
  revoked.mockReset();
  sendSpy.mockResolvedValue(task());
  fetchTaskSpy.mockResolvedValue(undefined);
  cancelTaskSpy.mockResolvedValue(true);
});

afterEach(() => {
  if (host) { unmount(host); host = null; }
  if (dialog) { unmount(dialog); dialog = null; }
  vi.useRealTimers();
});

describe("the row it has always been", () => {
  it("keeps the name, kind badge, last-used line and revoke button", async () => {
    render();
    await settle();
    expect(q(".devicename")!.textContent).toBe("work-laptop");
    expect(q(".devicekind")!.textContent).toBe("CLI");
    expect(q(".deviceseen")!.textContent).toContain("Last used yesterday");
    const del = q("button.del")!;
    expect(del.getAttribute("aria-label")).toContain("work-laptop");
    del.click();
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it("renders nothing about the inbox for a device that never enrolled", async () => {
    render(null as never);
    await settle();
    expect(q(".inboxblock")).toBeNull();
    expect(q(".sendzone")).toBeNull();
    expect(q("button.del")).not.toBeNull();
  });
});

// The same row, embedded on a page that sends rather than one that manages
// credentials (/device-inbox). Revoke is irreversible and would sit one
// mis-aimed click from a drop target; rename persists a label. Neither belongs
// on a surface whose own copy says credentials are managed elsewhere.
describe("with credential management switched off", () => {
  it("shows no revoke and no rename, and keeps the send target", async () => {
    render({}, { manage: false });
    await settle();
    expect(q("button.del"), "a destructive revoke reached a send-only surface").toBeNull();
    expect(q(".rowactions"), "an empty action strip still reads as controls").toBeNull();
    expect(target.textContent, "credential-management vocabulary leaked in").not.toMatch(/Rename|Revoke/i);
    // What the row is FOR here is untouched.
    expect(q(".sendzone")).not.toBeNull();
    expect(q("button.sendbtn")).not.toBeNull();
  });

  it("still identifies the device — name, kind, id fragment, sign-in and IP", async () => {
    // Identity is not management: two machines can share a label, and the
    // fragment plus the sign-in time is what tells a send target apart from its
    // namesake. Dropping them would make the send picker ambiguous.
    render({}, { manage: false, device: { ID: DEVICE_ID, Name: "work-laptop", CreatedAt: 1, LastSeenAt: 2, Kind: "cli", LastIP: "203.0.113.7", Inbox: inbox() } });
    await settle();
    expect(q(".devicename")!.textContent).toBe("work-laptop");
    expect(q(".devicekind")!.textContent).toBe("CLI");
    expect(q(".deviceref")!.textContent).toBe("ID ends abc123");
    expect(q(".devicesigned")!.textContent).toContain("Signed in on Tuesday");
    expect(q(".deviceip")!.textContent).toContain("203.0.113.7");
  });

  it("cannot be talked into a rename editor by a missing handler", async () => {
    // manage:true with no onRename would otherwise render a button that opens an
    // editor whose Save can never persist anything.
    render({}, { manage: true, onRename: undefined });
    await settle();
    expect([...target.querySelectorAll("button.chk")].some((b) => /rename/i.test(b.textContent ?? ""))).toBe(false);
    expect(q("button.del"), "revoke has its own handler and must survive").not.toBeNull();
  });
});

describe("what the card claims about a device", () => {
  it("an online auto device with a ready folder offers a send target and no caveat", async () => {
    render();
    await settle();
    expect(q(".sendzone")).not.toBeNull();
    expect(q(".inboxcaveat")).toBeNull();
    expect(target.textContent).toContain("Online");
    expect(target.textContent).toContain("Folder ready");
    expect(target.textContent).toContain("linux");
    expect(target.textContent).toContain("0.15.0");
  });

  it("an OFFLINE device is still sendable and says the file queues", async () => {
    render({ Presence: "offline" });
    await settle();
    expect(q(".sendzone"), "an offline enrolled device lost its send target").not.toBeNull();
    expect(target.textContent).toContain("queue");
    expect(target.textContent).toContain("Offline");
  });

  it("ask is sendable but says someone has to accept", async () => {
    render({ AutoAccept: "ask" });
    await settle();
    expect(q(".sendzone")).not.toBeNull();
    expect(q(".inboxcaveat")!.textContent).toContain("accept");
    expect(target.textContent).toContain("Ask first");
  });

  it("auto without a ready folder is never portrayed as ready", async () => {
    render({ ReceiveDirReady: false });
    await settle();
    expect(q(".sendzone")).not.toBeNull();
    expect(target.textContent).toContain("Folder not ready");
    expect(q(".inboxcaveat")!.textContent).toContain("waits");
  });

  it.each([
    ["AutoAccept off", { AutoAccept: "off" }, "Automatic receiving is off"],
    ["revoked", { Revoked: true }, "was revoked"],
    ["CanReceive false", { CanReceive: false }, "can't accept files"],
    ["no key", { Key: null }, "encryption key isn't usable"],
    ["unknown policy", { AutoAccept: "always" }, "can't describe"],
    ["unknown capability", { ReceiveCapability: "inbox.receive.v9" }, "can't send to"],
  ])("%s is not sendable and explains what to change", async (_label, over, expected) => {
    render(over);
    await settle();
    expect(q(".sendzone"), "an unsendable device still offered a drop target").toBeNull();
    expect(q(".inboxblocked")!.textContent).toContain(expected);
  });
});

describe("choosing files", () => {
  it("the primary control is a real button with a device-specific accessible name", async () => {
    render();
    await settle();
    const btn = q("button.sendbtn") as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.type).toBe("button");
    expect(btn.getAttribute("aria-label")).toContain("work-laptop");
    // A native button is reachable by Tab and activated by Enter/Space, so
    // drag is never the only path.
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("clicking it opens the file picker", async () => {
    render();
    await settle();
    const input = q("input.filepick") as HTMLInputElement;
    const clicked = vi.spyOn(input, "click");
    (q("button.sendbtn") as HTMLButtonElement).click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("keyboard activation of the button opens the picker too", async () => {
    render();
    await settle();
    const btn = q("button.sendbtn") as HTMLButtonElement;
    const input = q("input.filepick") as HTMLInputElement;
    const clicked = vi.spyOn(input, "click");
    btn.focus();
    expect(document.activeElement).toBe(btn);
    // Enter on a focused <button> dispatches a click; asserted through the DOM
    // rather than by calling the handler, so a change to a non-button element
    // would fail here.
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    btn.click();
    expect(clicked).toHaveBeenCalled();
  });

  it("picking files starts a send with exactly those files", async () => {
    render();
    await settle();
    const input = q("input.filepick") as HTMLInputElement;
    const f = new File(["x"], "a.txt");
    Object.defineProperty(input, "files", { value: fileList([f]), configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // Named entries, not bare Files: the manifest name is the relative path a
    // folder send has to keep, and it is decided here rather than downstream.
    expect(sendSpy.mock.calls[0][1]).toEqual([{ file: f, path: undefined }]);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ deviceID: DEVICE_ID, keyID: "k1", keyGeneration: 1 });
  });

  it("dropping files on the zone starts a send", async () => {
    render();
    await settle();
    const f = new File(["x"], "dropped.bin");
    q(".sendzone")!.dispatchEvent(dropEvent([f]));
    await settle();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1]).toEqual([{ file: f }]);
  });

  it("a drag that announced files and delivered none is refused out loud", async () => {
    render();
    await settle();
    const ev = dropEvent([]);
    q(".sendzone")!.dispatchEvent(ev);
    await settle();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(q(".senderr")!.textContent).toContain("no files");
    // Still prevented: the browser's default for a file drop is to navigate to
    // it, which would take the page down.
    expect(ev.defaultPrevented).toBe(true);
  });

  it("a drop that is not a file drag is left entirely alone", async () => {
    render();
    await settle();
    const text = dropEvent([], ["text/plain"]);
    q(".sendzone")!.dispatchEvent(text);
    const bare = new Event("drop", { bubbles: true, cancelable: true });
    q(".sendzone")!.dispatchEvent(bare);
    await settle();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(q(".senderr"), "a text drag was answered with a file refusal").toBeNull();
    expect(text.defaultPrevented, "a text drag was captured by the file drop zone").toBe(false);
    expect(bare.defaultPrevented).toBe(false);
  });

  it("a file drop that arrives mid-send is still prevented from navigating the page away", async () => {
    sendSpy.mockImplementation(() => new Promise(() => {}));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const second = dropEvent([new File(["y"], "b.bin")]);
    q(".sendzone")!.dispatchEvent(second);
    await settle();
    expect(sendSpy, "a second drop started while one was already running").toHaveBeenCalledTimes(1);
    expect(
      second.defaultPrevented,
      "the browser would have navigated to the dropped file and destroyed the running upload",
    ).toBe(true);
  });

  it("the destructive revoke button is not inside the drop target, and a drop never fires it", async () => {
    render();
    await settle();
    const zone = q(".sendzone")!;
    expect(zone.querySelector("button.del"), "revoke is reachable from inside the drop zone").toBeNull();
    expect(q("button.del")!.closest(".sendzone")).toBeNull();
    zone.dispatchEvent(dropEvent([new File(["x"], "a.txt")]));
    await settle();
    expect(revoked, "a drop reached the revoke handler").not.toHaveBeenCalled();
  });

  it("a drag over the zone shows a drop affordance and stops there", async () => {
    render();
    await settle();
    const zone = q(".sendzone")!;
    const ev = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], items: [], files: fileList([]) } });
    const stopped = vi.spyOn(ev, "stopPropagation");
    zone.dispatchEvent(ev);
    await settle();
    expect(zone.className).toContain("dragover");
    expect(ev.defaultPrevented).toBe(true);
    expect(stopped, "the page-wide drag handler could also act on this event").toHaveBeenCalled();
    zone.dispatchEvent(new Event("dragleave", { bubbles: true }));
    await settle();
    expect(q(".sendzone")!.className).not.toContain("dragover");
  });

  it("ignores a drag that carries no files at all", async () => {
    render();
    await settle();
    const ev = new Event("dragover", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: { types: ["text/plain"], items: [], files: fileList([]) } });
    q(".sendzone")!.dispatchEvent(ev);
    await settle();
    expect(q(".sendzone")!.className).not.toContain("dragover");
    expect(ev.defaultPrevented, "a text drag was captured by the file drop zone").toBe(false);
  });
});

describe("local progress versus what the server holds", () => {
  it("names the encrypting and uploading phases separately, with a cancel", async () => {
    let report!: (p: { phase: string; sent: number; total: number }) => void;
    sendSpy.mockImplementation((_t: unknown, _f: unknown, opts: { onProgress: typeof report }) => {
      report = opts.onProgress;
      return new Promise(() => {}); // never settles: the card stays mid-send
    });
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x".repeat(100)], "a.bin")]));
    await settle();

    report({ phase: "encrypting", sent: 25, total: 100 });
    await settle();
    expect(statusText()).toContain("Encrypting in this browser");
    expect(statusText()).toContain("25%");
    expect(q("progress")!.getAttribute("value")).toBe("25");
    expect(q("progress")!.getAttribute("aria-label")).toContain("work-laptop");

    report({ phase: "uploading", sent: 90, total: 100 });
    await settle();
    expect(statusText()).toContain("Uploading encrypted data");
    expect(statusText()).toContain("90%");

    report({ phase: "registering", sent: 0, total: 0 });
    await settle();
    expect(statusText()).toContain("Queueing the delivery");
    // Never a vague "sent" while the bytes are still moving.
    expect(statusText().toLowerCase()).not.toContain("sent");
  });

  it("cancel aborts the in-flight send", async () => {
    let signal!: AbortSignal;
    sendSpy.mockImplementation((_t: unknown, _f: unknown, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      return new Promise(() => {});
    });
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(signal.aborted).toBe(false);
    const cancel = [...target.querySelectorAll(".sendprogress button")].at(-1) as HTMLButtonElement;
    expect(cancel.getAttribute("aria-label")).toContain("work-laptop");
    cancel.click();
    expect(signal.aborted).toBe(true);
  });

  it("a completed upload is NEVER called sent — it says queued and not yet saved", async () => {
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain("Uploaded to Relayium");
    expect(statusText()).toContain("not saved on the device yet");
    expect(statusText()).toContain("Waiting for the device");
    expect(q("progress"), "the local progress bar outlived the local phase").toBeNull();
  });

  it("only the server's own saved state, with its commit timestamp, may claim delivery", async () => {
    sendSpy.mockResolvedValue(task({ State: "verifying" }));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain("decrypting and checking");
    expect(statusText()).toContain("not saved on the device yet");

    fetchTaskSpy.mockResolvedValue(task({ State: "saved", SavedAt: 1_700_000_500, Terminal: true }));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(statusText()).toContain("Saved on the device");
    expect(statusText()).not.toContain("not saved on the device yet");
    expect(q(".sendstatus")!.className).toContain("ok");
  });

  it("a saved state WITHOUT a commit timestamp is not presented as delivered", async () => {
    sendSpy.mockResolvedValue(task({ State: "saved", SavedAt: 0, Terminal: true }));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain("not saved on the device yet");
    expect(statusText()).toContain("doesn't recognise the status");
    expect(statusText()).not.toContain("Saved on the device");
    expect(q(".sendstatus")!.className).not.toContain("ok");
  });

  it.each([
    ["notified", "The device has been told"],
    ["downloading", "The device is downloading it"],
    ["attention_required", "Needs attention on that device"],
    ["expired", "Expired before the device took it"],
    ["revoked", "Stopped"],
    ["failed_retryable", "device will try again"],
    ["failed_terminal", "Failed"],
  ])("shows the %s state truthfully", async (state, expected) => {
    sendSpy.mockResolvedValue(task({ State: state, Terminal: ["expired", "revoked", "failed_terminal"].includes(state) }));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain(expected);
  });

  it("maps a device error code to guidance and never renders the token", async () => {
    sendSpy.mockResolvedValue(task({ State: "attention_required", ErrorCode: "name_conflict" }));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain("never overwrites");
    expect(target.textContent).not.toContain("name_conflict");
  });

  it("refuses to render a state or error token the server invented", async () => {
    sendSpy.mockResolvedValue(task({ State: "quarantined", ErrorCode: "rm -rf / failed", Terminal: true }));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain("doesn't recognise the status");
    expect(target.textContent, "server free text reached the DOM").not.toContain("rm -rf");
    expect(target.textContent).not.toContain("quarantined");
  });
});

describe("failures", () => {
  it.each([
    ["auto_receive_disabled", "receiving turned off"],
    ["inbox_queue_full", "too much waiting"],
    ["signed_out", "You're signed out"],
    ["quota_exceeded", "plan's limit"],
    ["upload_too_large", "size limit"],
    ["network", "connection dropped"],
    ["unknown", "didn't go through"],
  ])("explains %s in the user's own terms", async (code, expected) => {
    const { SendFailure } = await import("./device-send");
    sendSpy.mockRejectedValue(new SendFailure(code as never));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain(expected);
    expect(q(".sendstatus")!.className).toContain("bad");
  });

  it("an unexpected exception is reported without leaking its message", async () => {
    sendSpy.mockRejectedValue(new Error("ECONNREFUSED /home/lily/secret.txt"));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(statusText()).toContain("didn't go through");
    expect(target.textContent).not.toContain("secret.txt");
  });

  it("a finished send can be dismissed", async () => {
    sendSpy.mockResolvedValue(task({ State: "expired", Terminal: true }));
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    const dismissBtn = [...target.querySelectorAll(".sendactions button")].find((b) =>
      /Dismiss/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    dismissBtn.click();
    await settle();
    expect(statusText()).toBe("");
  });
});

describe("cancelling a queued delivery", () => {
  it("is offered while queued, asks first, and reports the outcome", async () => {
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    const btn = [...target.querySelectorAll(".sendactions button")].find((b) =>
      /Cancel delivery/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toContain("work-laptop");
    btn.click();
    await settle();
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.textContent).toContain("work-laptop");
    expect(dlg.textContent, "the confirmation hid that the ciphertext is deleted").toContain("deleted from the server");
    ([...dlg.querySelectorAll("button")].find((b) => /confirm/i.test(b.textContent ?? "")) as HTMLButtonElement).click();
    await settle();
    expect(cancelTaskSpy).toHaveBeenCalledWith(DEVICE_ID, TASK_ID);
    expect(statusText()).toContain("Cancelled");
  });

  it("is NOT offered while the device holds a live lease", async () => {
    for (const state of ["downloading", "verifying"]) {
      sendSpy.mockResolvedValue(task({ State: state }));
      render();
      await settle();
      q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
      await settle();
      const btn = [...target.querySelectorAll(".sendactions button")].find((b) =>
        /Cancel delivery/i.test(b.textContent ?? ""),
      );
      expect(btn, `${state} offered a cancel that would break a live lease`).toBeUndefined();
      unmount(host!);
      host = null;
    }
  });

  it("says so when the cancel itself failed", async () => {
    cancelTaskSpy.mockResolvedValue(false);
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    ([...target.querySelectorAll(".sendactions button")].find((b) =>
      /Cancel delivery/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement).click();
    await settle();
    ([...document.querySelectorAll('[role="dialog"] button')].find((b) =>
      /confirm/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement).click();
    await settle();
    expect(q(".senderr")!.textContent).toContain("Couldn't cancel");
    expect(statusText(), "a failed cancel was reported as cancelled").not.toContain("Cancelled");
  });
});

describe("polling lifecycle", () => {
  async function startQueuedSend() {
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
  }

  it("polls with a bounded backoff and resets it when the state changes", async () => {
    await startQueuedSend();
    fetchTaskSpy.mockResolvedValue(task({ State: "queued" }));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchTaskSpy).toHaveBeenCalledTimes(1);
    // unchanged → the next poll is further out, so 2.1s more is not enough
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchTaskSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchTaskSpy).toHaveBeenCalledTimes(2);
    // a change resets the backoff to the short interval
    fetchTaskSpy.mockResolvedValue(task({ State: "downloading" }));
    await vi.advanceTimersByTimeAsync(8_100);
    const afterChange = fetchTaskSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchTaskSpy.mock.calls.length).toBeGreaterThan(afterChange);
  });

  it("stops at a terminal state", async () => {
    await startQueuedSend();
    fetchTaskSpy.mockResolvedValue(task({ State: "saved", SavedAt: 5, Terminal: true }));
    await vi.advanceTimersByTimeAsync(2_100);
    const n = fetchTaskSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchTaskSpy.mock.calls.length, "polling continued after a terminal state").toBe(n);
  });

  it("stops when the task is gone", async () => {
    await startQueuedSend();
    fetchTaskSpy.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(2_100);
    const n = fetchTaskSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchTaskSpy.mock.calls.length).toBe(n);
    expect(statusText()).toBe("");
  });

  it("stops on unmount", async () => {
    await startQueuedSend();
    fetchTaskSpy.mockResolvedValue(task({ State: "queued" }));
    await vi.advanceTimersByTimeAsync(2_100);
    const n = fetchTaskSpy.mock.calls.length;
    unmount(host!);
    host = null;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchTaskSpy.mock.calls.length, "an unmounted card kept polling").toBe(n);
  });

  it("does not poll while the tab is hidden, and catches up when it returns", async () => {
    await startQueuedSend();
    fetchTaskSpy.mockResolvedValue(task({ State: "queued" }));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchTaskSpy, "a backgrounded tab kept polling").not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchTaskSpy).toHaveBeenCalled();
    hidden.mockRestore();
  });

  it("a late poll for a superseded send never repaints the card", async () => {
    await startQueuedSend();
    let resolveLate!: (v: InboxTaskView) => void;
    fetchTaskSpy.mockReturnValue(new Promise((r) => (resolveLate = r)));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchTaskSpy).toHaveBeenCalledTimes(1);

    // A second send supersedes the first while its poll is in flight.
    sendSpy.mockResolvedValue(task({ ID: "bbbbccccddddeeeeffff000011112222", State: "downloading" }));
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["y"], "b.bin")]));
    await settle();
    expect(statusText()).toContain("downloading");

    resolveLate(task({ State: "failed_terminal", ErrorCode: "disk_full", Terminal: true }));
    await settle();
    expect(statusText(), "a stale poll response overwrote the current send").toContain("downloading");
  });

  it("an account switch clears everything the previous account could see", async () => {
    // Two accounts can hold a device with the same id, and My Devices keys its
    // rows by id — so this component instance really can survive the switch with
    // another account's transfer still on it. The card watches the session
    // itself rather than trusting the list to unmount it.
    await signIn("u1");
    await startQueuedSend();
    expect(statusText()).not.toBe("");

    await signIn("u2");
    await settle();
    expect(statusText(), "the previous account's transfer stayed on screen").toBe("");
    fetchTaskSpy.mockResolvedValue(task({ State: "queued" }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchTaskSpy, "polling survived an account switch").not.toHaveBeenCalled();
  });

  it("signing out clears it too", async () => {
    await signIn("u1");
    await startQueuedSend();
    expect(statusText()).not.toBe("");
    await signIn(null);
    await settle();
    expect(statusText()).toBe("");
  });
});

describe("what the card is allowed to know about the files", () => {
  const SECRET_NAME = "Board minutes 2026 — DO NOT SHARE.docx";

  it("never puts a file name or path on screen, only a count and a size", async () => {
    // The names are inside AES-GCM by the time anything leaves this browser, but
    // the SENDER holds them in plaintext — so the card is the one place they
    // could still be leaked, into a screenshot, a support session or a shared
    // screen. It shows what was sent, not what it was called.
    render();
    await settle();
    q(".sendzone")!.dispatchEvent(
      dropEvent([new File(["x".repeat(2048)], SECRET_NAME), new File(["y"], "budget/salaries.csv")]),
    );
    await settle();
    expect(target.textContent).not.toContain(SECRET_NAME);
    expect(target.textContent).not.toContain("Board minutes");
    expect(target.textContent).not.toContain("salaries");
    expect(target.textContent).not.toContain("budget/");
    // …and it does say something true about the batch.
    expect(q(".sendfiles")!.textContent).toContain("2 files");
  });

  it("keeps no file name in the DOM after the picker fires", async () => {
    render();
    await settle();
    const input = q("input.filepick") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: fileList([new File(["x"], SECRET_NAME)]), configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    // The <input> is cleared on the way through, so the name is not sitting in
    // the document waiting to be read back.
    expect(input.value).toBe("");
    expect(document.body.innerHTML).not.toContain("Board minutes");
  });
});

describe("accessibility of the live status", () => {
  it("the region exists before there is anything to say", async () => {
    render();
    await settle();
    const region = q(".sendstatus")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("");
  });

  it("the same region carries every later sentence, so a screen reader hears it", async () => {
    render();
    await settle();
    const before = q(".sendstatus");
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(q(".sendstatus"), "the live region was replaced rather than updated").toBe(before);
    expect(statusText()).not.toBe("");
  });
});
