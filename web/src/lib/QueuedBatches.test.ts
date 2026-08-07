import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import QueuedBatches from "./QueuedBatches.svelte";
import { loadLang, messages } from "./i18n.svelte";
import type { QueuedFileBatch } from "./mixed-file-session.svelte";

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
const batches = () => [...target.querySelectorAll<HTMLElement>(".batch-list > .batch")];
const fileRows = (batch: HTMLElement) => [...batch.querySelectorAll<HTMLElement>(".file-list li")];

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
    expect(target.querySelector("h2")?.textContent)
      .toBe(messages.en.workspace.queuedTitle(0));
  });
});
