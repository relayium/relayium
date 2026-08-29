import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import QueuedBatches from "./QueuedBatches.svelte";
import { loadLang, messages } from "./i18n.svelte";
import type { QueuedFileBatch } from "./mixed-file-session.svelte";
// The SAME strings `web/e2e/mixed-link.mjs` queries in a real browser. That
// runner needs a Go server and a headless Chrome; this file needs neither and
// runs on every push, so it is what fails FIRST when this markup moves. It has
// moved once already — `.fname` became `.file-name` and one `li` per file
// became one `.batch` wrapping N of them — and the browser runner carried its
// own private copies, so nothing went red until somebody ran it by hand weeks
// later. Import, do not retype.
import { QUEUED } from "../../e2e/dom-contracts.mjs";

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
});

const batch = (id: number, names: string[], total: number): QueuedFileBatch => ({
  id,
  peerId: "z",
  files: names.map((name) => ({ name, size: Math.floor(total / names.length) })),
  total,
  replayed: false,
});

const BATCHES: QueuedFileBatch[] = [
  batch(7, ["report.pdf"], 2048),
  batch(9, ["a.png", "b.png", "c.png"], 3072),
];

function open(props: Record<string, unknown> = {}) {
  app = mount(QueuedBatches, {
    target,
    props: { batches: BATCHES, onCancel: vi.fn(), ...props },
  });
  flushSync();
}
const card = () => target.querySelector<HTMLElement>(QUEUED.card);
const batches = () => [...target.querySelectorAll<HTMLElement>(QUEUED.batch)];
const fileRows = (batch: HTMLElement) => [...batch.querySelectorAll<HTMLElement>(QUEUED.fileRow)];
const fileNames = (batch: HTMLElement) =>
  [...batch.querySelectorAll<HTMLElement>(QUEUED.fileName)].map((el) => el.textContent?.trim());

describe("QueuedBatches", () => {
  it("makes the queued state explicit rather than an invisible backlog", () => {
    open();
    expect(target.querySelector("h2")?.textContent)
      .toBe(messages.en.workspace.queuedTitle(2));
    expect(target.textContent).toContain(messages.en.workspace.queuedHint);
    expect(batches()).toHaveLength(2);
    expect(fileRows(batches()[0])).toHaveLength(1);
    expect(fileRows(batches()[0])[0].textContent).toContain("report.pdf");
    expect(fileRows(batches()[0])[0].textContent).toContain("2.0 KB");

    expect(fileRows(batches()[1])).toHaveLength(3);
    expect(fileRows(batches()[1]).map((row) => row.textContent))
      .toEqual(["a.png 1.0 KB", "b.png 1.0 KB", "c.png 1.0 KB"]);
    expect(batches()[1].textContent).toContain(messages.en.workspace.queuedFiles(3));
    expect(batches()[1].textContent).not.toContain("+2");
  });

  it("gives every batch its own cancel control routed by id", () => {
    const onCancel = vi.fn();
    open({ onCancel });
    const buttons = [...target.querySelectorAll("button")] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.type).toBe("button");
      // .btn supplies the shared 44px coarse-pointer floor and dark-mode tokens.
      expect(b.className).toContain("btn");
      expect(b.textContent?.trim()).toBe(messages.en.workspace.queuedRemove);
    }
    buttons[1].click();
    flushSync();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledWith(9);
  });

  it("renders no rows for an empty queue", () => {
    open({ batches: [] });
    expect(batches()).toHaveLength(0);
    expect(card()!.querySelectorAll(QUEUED.cancel)).toHaveLength(0);
    expect(target.querySelector("h2")?.textContent)
      .toBe(messages.en.workspace.queuedTitle(0));
    // The card's own ABSENCE — which `mixed-link.mjs` waits for to prove a
    // cancellation landed — is the parent's contract, not this component's:
    // App.svelte mounts it only `{#if mixed && workspace.queuedBatches.length}`.
  });

  // ── the contract the real-browser runner depends on ────────────────────
  //
  // Everything above would still pass with the selectors written twice. This
  // block exists to make the SHARED strings load-bearing here, so that renaming
  // one in the component fails in `npm test` rather than months later in a
  // suite somebody has to remember to run.
  it("honours every shared selector web/e2e/mixed-link.mjs queries", () => {
    open();
    expect(card()).not.toBeNull();

    // One batch per selection, and the file rows counted INSIDE a batch. The
    // distinction is the whole defect: flattened to `card.querySelectorAll("li")`
    // this queue reports 2 + 1 + 3 = 6 rows, which is neither number.
    expect(batches()).toHaveLength(2);
    expect(card()!.querySelectorAll("li")).toHaveLength(6);
    expect(batches().map((b) => fileRows(b).length)).toEqual([1, 3]);

    // One cancel per batch, on the card — never one per file row.
    expect(card()!.querySelectorAll(QUEUED.cancel)).toHaveLength(2);
    for (const b of batches()) expect(b.querySelectorAll(QUEUED.cancel)).toHaveLength(1);

    // The name is readable through the shared selector. When it was not, the
    // browser runner got an empty array and threw `undefined.includes` instead
    // of naming the drift.
    expect(batches().flatMap(fileNames)).toEqual(["report.pdf", "a.png", "b.png", "c.png"]);
    for (const b of batches()) expect(fileNames(b).length).toBe(fileRows(b).length);
  });
});
