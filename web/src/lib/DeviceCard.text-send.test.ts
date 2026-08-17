// The message composer on a device card. DeviceCard.test.ts owns the file half
// and device-send.test.ts owns the wire; this suite is about the four claims
// that are only true if the UI makes them true:
//
//  1. **The offer is honest.** A message is offered only to a target that
//     announces `inbox.text.v1`, and a target without it keeps its file
//     controls — the token says "this receiver shows a message as a message",
//     which has nothing to do with taking a file.
//  2. **The bound is the protocol's.** UTF-8 bytes, so an emoji costs four and
//     the button is disabled before the send would refuse, with the reason on
//     screen.
//  3. **The words are the user's.** They reach `sendTextToDevice` and nothing
//     else — no DOM, no summary, no error — and they survive every failure so a
//     retry is a click rather than retyping.
//  4. **One card runs one send, of one kind.** The message shares the file
//     send's state machine, generation counter and AbortController rather than
//     running beside it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount } from "svelte";
import DeviceCard from "./DeviceCard.svelte";
import { loadLang } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import {
  CAP_RECEIVE_V2,
  CAP_TEXT_V1,
  INBOX_KEY_ALGORITHM,
  type InboxTaskView,
} from "./device-inbox";
import { INBOX_MANIFEST_MAX_TEXT_BYTES } from "./inbox-manifest";
// The real class, reached through the partial mock below: the card maps a
// `SendFailure` to one localized sentence and anything else to the generic one,
// so a stand-in error here would test the wrong branch.
import { SendFailure } from "./device-send";

const sendSpy = vi.fn();
const sendTextSpy = vi.fn();
const fetchTaskSpy = vi.fn();
const cancelTaskSpy = vi.fn();

vi.mock("./device-send", async (orig) => {
  const real = await orig<typeof import("./device-send")>();
  return {
    ...real,
    sendFilesToDevice: (...args: unknown[]) => sendSpy(...args),
    sendTextToDevice: (...args: unknown[]) => sendTextSpy(...args),
    fetchInboxTask: (...args: unknown[]) => fetchTaskSpy(...args),
    cancelInboxTask: (...args: unknown[]) => cancelTaskSpy(...args),
  };
});

const ZERO_KEY = "A".repeat(43);
const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const TASK_ID = "aaaabbbbccccddddeeeeffff00001111";

/** A message with a trailing space and an astral character in it, on purpose:
 *  it is what proves the draft is neither trimmed nor measured in UTF-16. */
const MESSAGE = "meet me at 6 — 会议室 B 🙂 ";
const MESSAGE_BYTES = new TextEncoder().encode(MESSAGE).length;

function inbox(over: Record<string, unknown> = {}) {
  return {
    Presence: "online",
    LastHeartbeatAt: 1_700_000_000,
    PresenceExpiresAt: 1_700_000_090,
    HeartbeatIntervalSeconds: 30,
    ProtocolVersion: 2,
    Capabilities: [CAP_RECEIVE_V2, CAP_TEXT_V1],
    ReceiveCapability: CAP_RECEIVE_V2,
    AutoAccept: "auto",
    ReceiveDirReady: true,
    Platform: "macos",
    AppVersion: "1.0.0",
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

let host: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(over: Record<string, unknown> = {}) {
  target = document.createElement("ul");
  document.body.appendChild(target);
  host = mount(DeviceCard, {
    target,
    props: {
      device: { ID: DEVICE_ID, Name: "work-laptop", CreatedAt: 1, LastSeenAt: 2, Kind: "app", Inbox: inbox(over) },
      kind: "App",
      lastUsed: "Last used yesterday",
      signedIn: "Signed in on Tuesday",
      deviceRef: "ID ends abc123",
      manage: false,
    },
  });
  return target;
}

const settle = () => vi.advanceTimersByTimeAsync(5);
const q = (sel: string) => target.querySelector(sel) as HTMLElement | null;
const field = () => q("textarea.composerfield") as HTMLTextAreaElement | null;
const msgBtn = () => q("button.msgbtn") as HTMLButtonElement;
const sendBtn = () => q(".composeractions button.sendbtn") as HTMLButtonElement;

/** Open the composer the way a user does. */
async function openComposer() {
  msgBtn().click();
  await settle();
}

/** Type into the composer. `bind:value` listens for `input`, so setting the
 *  property alone would leave the component's state untouched. */
async function type(text: string) {
  const el = field()!;
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

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

function fileList(files: File[]): FileList {
  const out: Record<string | number, unknown> = { item: (i: number) => files[i] ?? null };
  files.forEach((f, i) => (out[i] = f));
  out.length = files.length;
  return out as unknown as FileList;
}

function dropEvent(files: File[]): DragEvent {
  const e = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, "dataTransfer", { value: { files: fileList(files), items: [], types: ["Files"] } });
  return e;
}

beforeEach(async () => {
  vi.useFakeTimers();
  await loadLang("en");
  document.body.innerHTML = "";
  sendSpy.mockReset();
  sendTextSpy.mockReset();
  fetchTaskSpy.mockReset();
  cancelTaskSpy.mockReset();
  sendSpy.mockResolvedValue(task());
  sendTextSpy.mockResolvedValue(task());
  fetchTaskSpy.mockResolvedValue(undefined);
  cancelTaskSpy.mockResolvedValue(true);
});

afterEach(() => {
  if (host) { unmount(host); host = null; }
  vi.useRealTimers();
});

describe("who is offered a message", () => {
  it("offers one to a device that announces inbox.text.v1", async () => {
    render();
    await settle();
    const btn = msgBtn();
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-label"), "the control did not name its target").toContain("work-laptop");
    expect(btn.getAttribute("aria-label"), "the accessible name did not contain the visible label")
      .toContain(btn.textContent?.trim());
    expect(q(".inboxtextoff"), "an available message surface was explained away").toBeNull();
  });

  it("names the target device on the composer itself", async () => {
    render();
    await settle();
    await openComposer();
    const head = q(".composerhead")!;
    expect(head.textContent).toContain("work-laptop");
    // A real label, so the field's accessible name is the device context and
    // not a placeholder that disappears the moment anything is typed.
    expect(head.tagName).toBe("LABEL");
    expect(head.getAttribute("for")).toBe(field()!.id);
    expect(field()!.id).not.toBe("");
  });

  it("disables it and says why when the device announces no message surface", async () => {
    render({ Capabilities: [CAP_RECEIVE_V2] });
    await settle();
    expect(msgBtn().disabled, "a message was offered to a device that shows none").toBe(true);
    // Disabled AND explained: a dead control with nothing beside it is
    // indistinguishable from a broken one, and a control simply removed would
    // teach the reader that this browser cannot send messages at all.
    expect(q(".inboxtextoff")!.textContent).toContain("doesn't say it can show a message");
    // Pressing it anyway opens nothing.
    msgBtn().click();
    await settle();
    expect(field()).toBeNull();
  });

  it("leaves the file half of that same device completely alone", async () => {
    // The more important half of the rule: requiring `inbox.text.v1` of a file
    // send would refuse the CLI and every other receiver that takes files
    // perfectly well and renders no messages.
    render({ Capabilities: [CAP_RECEIVE_V2] });
    await settle();
    expect(q(".sendzone")).not.toBeNull();
    const btn = q("button.sendbtn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("is not suppressed by a receive folder that isn't ready", async () => {
    // A message is never written to that folder — a v2 receiver classifies the
    // sealed kind first — so the folder caveat is truthful about FILES and has
    // nothing to say about whether a message can land.
    render({ ReceiveDirReady: false });
    await settle();
    expect(q(".inboxcaveat")!.textContent, "the file caveat went missing").toContain("receive folder");
    expect(msgBtn().disabled, "a file caveat was allowed to refuse a message").toBe(false);
    await openComposer();
    expect(field()).not.toBeNull();
  });

  it("is not offered at all for a device that cannot be sent to", async () => {
    render({ AutoAccept: "off" });
    await settle();
    expect(q(".sendzone")).toBeNull();
    expect(q("button.msgbtn")).toBeNull();
  });
});

describe("what the composer says about a draft", () => {
  it("counts UTF-8 bytes against the protocol limit, live", async () => {
    render();
    await settle();
    await openComposer();
    expect(q(".composerbytes")!.textContent).toContain(`0 of ${INBOX_MANIFEST_MAX_TEXT_BYTES}`);
    await type("🙂");
    // Four bytes for one character: the whole reason the counter is in bytes.
    expect(q(".composerbytes")!.textContent).toContain(`4 of ${INBOX_MANIFEST_MAX_TEXT_BYTES}`);
    await type(MESSAGE);
    expect(q(".composerbytes")!.textContent).toContain(`${MESSAGE_BYTES} of`);
  });

  it("disables Send on an empty draft and explains it", async () => {
    render();
    await settle();
    await openComposer();
    expect(sendBtn().disabled).toBe(true);
    expect(q(".composerwhy")!.textContent).toContain("empty message can't be sent");
    sendBtn().click();
    await settle();
    expect(sendTextSpy, "an empty message was queued").not.toHaveBeenCalled();
  });

  it("disables Send past 64 KiB, says how far over, and marks the field invalid", async () => {
    render();
    await settle();
    await openComposer();
    await type("a".repeat(INBOX_MANIFEST_MAX_TEXT_BYTES));
    expect(sendBtn().disabled, "a message exactly at the limit was refused").toBe(false);
    expect(field()!.getAttribute("aria-invalid")).toBe("false");

    await type("a".repeat(INBOX_MANIFEST_MAX_TEXT_BYTES + 7));
    expect(sendBtn().disabled).toBe(true);
    expect(field()!.getAttribute("aria-invalid")).toBe("true");
    expect(q(".composercount")!.className).toContain("bad");
    expect(q(".composerwhy")!.textContent).toContain("7 bytes over the limit");
    sendBtn().click();
    await settle();
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("describes the field through the count, so the bound is announced with it", async () => {
    render();
    await settle();
    await openComposer();
    const described = field()!.getAttribute("aria-describedby");
    expect(described).toBe(q(".composercount")!.id);
    expect(described).not.toBe("");
  });
});

describe("sending one", () => {
  it("hands the draft to sendTextToDevice exactly as typed, with the target", async () => {
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();

    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    const [target_, body, opts] = sendTextSpy.mock.calls[0];
    // Never trimmed, never normalized: the trailing space is part of what the
    // counter measured and part of what the receiver will show.
    expect(body).toBe(MESSAGE);
    expect(target_).toMatchObject({ deviceID: DEVICE_ID, keyID: "k1", keyGeneration: 1, algorithm: INBOX_KEY_ALGORITHM });
    // Carried for real here: `sendTextToDevice` fails closed without it.
    expect(target_.capabilities).toContain(CAP_TEXT_V1);
    expect(opts.idempotencyKey).toMatch(/^web-[0-9a-f]{32}$/);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("is one kind: no files travel with it, and no message travels with a file", async () => {
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    expect(sendSpy, "a message send also queued a file delivery").not.toHaveBeenCalled();
    expect(sendTextSpy.mock.calls[0]).toHaveLength(3);
    expect(sendTextSpy.mock.calls[0][1], "the message argument was not the bare body").toBe(MESSAGE);

    // And the reverse, with a draft sitting in an open composer.
    await type(MESSAGE);
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendSpy.mock.calls[0]), "the draft leaked into a file send").not.toContain("会议室");
  });

  it("reports progress and a queued task through the card's own state machine", async () => {
    let report: ((p: { phase: string; sent: number; total: number }) => void) | null = null;
    sendTextSpy.mockImplementation((_t: unknown, _m: unknown, o: { onProgress: typeof report }) => {
      report = o.onProgress;
      return new Promise(() => {});
    });
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();

    report!({ phase: "uploading", sent: 5, total: 10 });
    await settle();
    // The same progress bar, the same cancel, the same live region as a file
    // send — not a second tracker rendered beside them.
    expect(q(".sendprogress progress")!.getAttribute("value")).toBe("50");
    expect(q(".sendstatus")!.textContent).toContain("Uploading encrypted data… 50%");
    expect(q(".sendprogress button.linkish")!.textContent).toContain("Cancel");
  });

  it("never says sent: a queued message is uploaded and not yet saved", async () => {
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    expect(q(".sendstatus")!.textContent).toContain("not saved on the device yet");
  });

  it("summarises the delivery as a byte count, never as its text", async () => {
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    const summary = q(".sendfiles")!;
    expect(summary.textContent).toContain(`${MESSAGE_BYTES} bytes`);
    expect(summary.textContent).not.toContain("会议室");
    // A message has no files, so the file summary must not be standing beside it.
    expect(summary.textContent).not.toMatch(/\bfiles?\b/);
  });
});

describe("the draft is the user's", () => {
  it("clears only after central confirms the task", async () => {
    let resolve!: (t: InboxTaskView) => void;
    sendTextSpy.mockImplementation(() => new Promise<InboxTaskView>((r) => (resolve = r)));
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    // In flight: the words are still there. Losing them here would mean a
    // failure a moment later left the user with nothing to retry from.
    expect(field()!.value).toBe(MESSAGE);

    resolve(task());
    await settle();
    expect(field()!.value, "the queued message was left to be sent twice").toBe("");
  });

  it("keeps it when the send fails, with the reason on screen", async () => {
    sendTextSpy.mockRejectedValue(new SendFailure("inbox_queue_full"));
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    expect(field()!.value, "a failure destroyed the message").toBe(MESSAGE);
    expect(q(".sendstatus")!.textContent).toContain("too much waiting for it already");
    // And it can simply be sent again.
    sendBtn().click();
    await settle();
    expect(sendTextSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps it when the send is cancelled", async () => {
    let signal!: AbortSignal;
    sendTextSpy.mockImplementation(
      (_t: unknown, _m: unknown, o: { signal: AbortSignal }) =>
        new Promise((_r, reject) => {
          signal = o.signal;
          o.signal.addEventListener("abort", () => reject(new SendFailure("cancelled")));
        }),
    );
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();

    (q(".sendprogress button.linkish") as HTMLButtonElement).click();
    await settle();
    expect(signal.aborted).toBe(true);
    expect(field()!.value, "cancelling threw the message away").toBe(MESSAGE);
    expect(q(".sendstatus")!.textContent).toContain("Cancelled");
  });

  it("keeps it when the composer is collapsed and reopened", async () => {
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    (q(".composeractions button.linkish") as HTMLButtonElement).click();
    await settle();
    expect(field(), "the composer stayed open").toBeNull();
    await openComposer();
    expect(field()!.value).toBe(MESSAGE);
  });

  it("keeps an edit made while the send was running", async () => {
    let resolve!: (t: InboxTaskView) => void;
    sendTextSpy.mockImplementation(() => new Promise<InboxTaskView>((r) => (resolve = r)));
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    await type("the next thing I was writing");
    resolve(task());
    await settle();
    // Only the message that was actually queued may be cleared; what the user
    // typed afterwards is a different message and is theirs.
    expect(field()!.value).toBe("the next thing I was writing");
  });

  it("is dropped when the account changes, like a half-typed rename", async () => {
    await signIn("acct-1");
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    await signIn("acct-2");
    await settle();
    expect(field(), "a message addressed to another account's device stayed on screen").toBeNull();
    // And reopening does not resurrect it.
    await openComposer();
    expect(field()!.value).toBe("");
    await signIn(null);
  });

  it("never puts the body anywhere but the field it was typed in", async () => {
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    // After a successful send the draft is gone, and no other element — status,
    // summary, title, aria-label — is holding a copy of what was sent.
    expect(target.textContent, "the message body was rendered outside the draft").not.toContain("会议室");
    expect(target.innerHTML).not.toContain("会议室");
  });
});

describe("one card runs one send", () => {
  it("refuses a second message while one is in flight", async () => {
    sendTextSpy.mockImplementation(() => new Promise(() => {}));
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();
    expect(sendBtn().disabled, "the send button stayed live during a send").toBe(true);
    sendBtn().click();
    await settle();
    expect(sendTextSpy, "the same message was queued twice").toHaveBeenCalledTimes(1);
  });

  it("refuses a message while a FILE send is running, and the reverse", async () => {
    sendSpy.mockImplementation(() => new Promise(() => {}));
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    q(".sendzone")!.dispatchEvent(dropEvent([new File(["x"], "a.bin")]));
    await settle();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendBtn().disabled).toBe(true);
    sendBtn().click();
    await settle();
    expect(sendTextSpy, "a message started beside a running file upload").not.toHaveBeenCalled();
    // The composer itself stays usable: writing the next message while an
    // upload finishes is not a second send, and the draft is untouched.
    expect(msgBtn().disabled).toBe(false);
    expect(field()!.value).toBe(MESSAGE);
  });

  it("does not repaint the card from a superseded message send", async () => {
    let resolve!: (t: InboxTaskView) => void;
    sendTextSpy.mockImplementationOnce(() => new Promise<InboxTaskView>((r) => (resolve = r)));
    await signIn("acct-1");
    render();
    await settle();
    await openComposer();
    await type(MESSAGE);
    sendBtn().click();
    await settle();

    // The account changes under it; the card resets and the old send is aborted.
    await signIn("acct-2");
    await settle();
    resolve(task());
    await settle();
    expect(q(".sendstatus")!.textContent, "a superseded send painted a task onto a reset card").toBe("");
    expect(q(".sendfiles")).toBeNull();
    await signIn(null);
  });
});
