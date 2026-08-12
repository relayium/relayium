// The receiver's card for pre-uploaded files, mounted for real.
//
// Three things are asserted here and nowhere else, because all three are about
// what is ON SCREEN at the moment the user decides:
//
//   - the large-batch memory warning, which has to be answered BEFORE the click
//     (the click is the gesture the save picker needs, so there is no second
//     chance to ask), and which this card gets by reusing the live lane's own
//     ReceiveActions rather than re-deriving the condition;
//   - the retry control, which must appear exactly when a retry could work;
//   - the outcome sentence, which must not say "Nothing was saved" for a batch
//     that already flushed files to a per-file target.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import StoredIncoming from "./StoredIncoming.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { LARGE_DOWNLOAD_WARN_BYTES, type FileMetaLite } from "./filesink";
import { formatSize } from "./format";
import type { StoredReceiver, StoredReceiveStatus, StoredReceiveError } from "./preupload-receive.svelte";

let target: HTMLDivElement;
let app: unknown;

beforeEach(async () => {
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
  vi.unstubAllGlobals();
});

/** A plain stand-in for the driver: this file is about the card, and the driver
 *  has its own suite driving real ciphertext. */
function fakeReceiver(over: Partial<StoredReceiver> = {}): StoredReceiver {
  return {
    status: "prompt" as StoredReceiveStatus,
    errorKey: "" as StoredReceiveError,
    files: [] as readonly FileMetaLite[],
    total: 0,
    received: 0,
    waitingCount: 0,
    savedCount: 0,
    retryable: false,
    offer: vi.fn(),
    accept: vi.fn(async () => {}),
    reject: vi.fn(),
    retry: vi.fn(),
    dismiss: vi.fn(),
    reset: vi.fn(),
    active: () => false,
    ...over,
  };
}

function open(receiver: StoredReceiver) {
  app = mount(StoredIncoming, { target, props: { receiver } });
  flushSync();
  return target;
}

const t = () => messages.en.storedRecv;
const text = () => target.textContent ?? "";
const buttons = () => [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("the pre-uploaded batch's consent card", () => {
  it("warns about memory before the click, on a browser that cannot stream to disk", () => {
    // The window is exactly this: accepting IS the gesture pickSaveTarget needs,
    // so a batch that will be assembled in memory has to be flagged while the
    // question is still unanswered. This card gets that from the same component
    // (and therefore the same condition) the live receive lane uses — writing
    // the test against the rendered copy is what stops the two drifting.
    const total = LARGE_DOWNLOAD_WARN_BYTES + 1;
    const r = fakeReceiver({ files: [{ name: "huge.bin", size: total }], total });
    open(r);
    expect(text()).toContain(messages.en.recvMemWarn(formatSize(total)));
    // Accept is not even rendered in the warned state: continuing is a separate,
    // explicit control, and Decline is the primary.
    expect(buttons()).toContain(messages.en.recvMemWarnAccept);
    expect(buttons()).not.toContain(t().accept);
  });

  it("keeps its own wording for the two answers when there is nothing to warn about", () => {
    const r = fakeReceiver({ files: [{ name: "a.txt", size: 5 }], total: 5 });
    open(r);
    expect(buttons()).toEqual([t().accept, t().reject]);
    // And it still says where the files will go before the click.
    expect(text()).toContain(messages.en.recvSaveHintDownload);
  });

  it("offers a retry only when a retry could work", () => {
    const failed = fakeReceiver({ status: "failed", errorKey: "netFail", retryable: true });
    open(failed);
    expect(text()).toContain(t().errNet);
    expect(buttons()).toEqual([t().retry, t().dismiss]);
  });

  it("offers no retry when the stored ciphertext is already deleted", () => {
    const gone = fakeReceiver({ status: "failed", errorKey: "gone", retryable: false });
    open(gone);
    expect(text()).toContain(t().errGone);
    expect(buttons()).toEqual([t().dismiss]);
  });

  it("says how much was really saved instead of claiming none of it was", () => {
    // The lie this replaced: four error strings that all ended in "Nothing was
    // saved", including on a target that had already written two files to a
    // folder the user chose.
    const partial = fakeReceiver({ status: "failed", errorKey: "netFail", retryable: true, savedCount: 2 });
    open(partial);
    expect(text()).toContain(t().savedSome(2));
    expect(text()).not.toContain(t().nothingSaved);
  });

  it("says nothing was saved when nothing was", () => {
    const none = fakeReceiver({ status: "failed", errorKey: "saveFail", retryable: true, savedCount: 0 });
    open(none);
    expect(text()).toContain(t().nothingSaved);
    expect(text()).not.toContain(t().savedSome(1));
  });
});
