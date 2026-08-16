import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import MessagePanel from "./MessagePanel.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { TEXT_MAX_BYTES } from "./text-wire";
import type { TextMessage } from "./text-session.svelte";

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

// The exact content the invariants promise to preserve, plus a payload that would
// be markup if anything ever stopped escaping.
const GNARLY = "  \tif x:\n\n\t\tprint('你好 🌍')\n  trailing   ";
const INJECTION = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const RTL = "مرحبا بالعالم";

const HISTORY: TextMessage[] = [
  { id: 1, dir: "in", body: GNARLY, at: 0, failed: false },
  { id: 2, dir: "out", body: INJECTION, at: 0, failed: false },
  { id: 3, dir: "out", body: RTL, at: 0, failed: true },
];

function open(props: Record<string, unknown> = {}) {
  app = mount(MessagePanel, {
    target,
    props: {
      status: "open", peerName: "Alice", sasCode: "123456", path: "lan",
      history: HISTORY, errorKey: "", onSend: vi.fn(), onAccept: vi.fn(),
      onReject: vi.fn(), onClear: vi.fn(), onEnd: vi.fn(), ...props,
    },
  });
  flushSync();
}
const bodies = () => [...target.querySelectorAll(".msg-body")] as HTMLElement[];
const ta = () => target.querySelector("textarea") as HTMLTextAreaElement;
function reset() {
  if (app) unmount(app);
  app = undefined;
  target.innerHTML = "";
}
function type(text: string) {
  const el = ta();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("MessagePanel", () => {
  // ── plaintext fidelity ─────────────────────────────────────────────────────
  it("renders a body as an exact text node, byte for byte", () => {
    open();
    const got = bodies().find((n) => n.textContent!.includes("print"))!;
    expect(got.textContent).toBe(GNARLY);
    // Not merely equal as a string: the same UTF-8 bytes.
    const enc = new TextEncoder();
    expect([...enc.encode(got.textContent!)]).toEqual([...enc.encode(GNARLY)]);
  });

  it("never turns a body into markup", () => {
    open();
    expect(target.querySelector("script")).toBe(null);
    expect(target.querySelector("img")).toBe(null);
    const got = bodies().find((n) => n.textContent!.includes("alert"))!;
    expect(got.textContent).toBe(INJECTION);
    expect(got.children.length).toBe(0); // a text node, nothing else
  });

  it("does not linkify, preview, or otherwise interpret a body", () => {
    open({ history: [{ id: 1, dir: "in", body: "see https://example.com/x and **bold**", at: 0, failed: false }] });
    expect(target.querySelector(".msg-body a")).toBe(null);
    expect(target.querySelector(".msg-body strong")).toBe(null);
    expect(bodies()[0].textContent).toBe("see https://example.com/x and **bold**");
  });

  // Asserted against the component's own <style> source rather than through
  // getComputedStyle: the Svelte plugin does not inject scoped CSS into the
  // document under vitest, so a computed-style assertion here would pass
  // vacuously. Preserved bytes that render collapsed are a content-fidelity bug,
  // not a cosmetic one, so it gets a test that can actually fail.
  it("preserves whitespace visually, not just in the DOM", async () => {
    const { readFileSync } = await import("node:fs");
    // vitest runs from web/, and import.meta.url is not a file URL after transform.
    const src = readFileSync("src/lib/MessagePanel.svelte", "utf8");
    const body = src.slice(src.indexOf(".msg-body {"), src.indexOf("}", src.indexOf(".msg-body {")));
    expect(body).toMatch(/white-space:\s*pre-wrap/);
    // And long unbroken content must break inside its box, never widen the page.
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    // The draft is multiline content too, so the composer needs it as well.
    const area = src.slice(src.indexOf("  textarea {"), src.indexOf("}", src.indexOf("  textarea {")));
    expect(area).toMatch(/white-space:\s*pre-wrap/);
  });

  it("marks every body dir=auto so RTL content reads correctly under an LTR UI", () => {
    open();
    for (const n of bodies()) expect(n.getAttribute("dir")).toBe("auto");
    const rtl = bodies().find((n) => n.textContent === RTL)!;
    expect(rtl.getAttribute("dir")).toBe("auto");
  });

  it("shows which direction each message went, and marks a failed send", () => {
    open();
    // Addressed by BODY rather than by index: the list is rendered newest first,
    // and an index here would only restate the ordering test below while quietly
    // breaking whenever it changed.
    const rowFor = (body: string) =>
      [...target.querySelectorAll(".msg")].find(
        (n) => n.querySelector(".msg-body")!.textContent === body,
      )!;
    expect(target.querySelectorAll(".msg").length).toBe(3);
    expect(rowFor(GNARLY).classList.contains("out")).toBe(false);
    expect(rowFor(INJECTION).classList.contains("out")).toBe(true);
    expect(rowFor(RTL).classList.contains("failed")).toBe(true);
    expect(rowFor(RTL).textContent).toContain(messages.en.status.sendFail);
    expect(rowFor(GNARLY).classList.contains("failed")).toBe(false);
  });

  // ── composer ───────────────────────────────────────────────────────────────
  it("counts the composer in UTF-8 bytes, not characters", () => {
    open();
    type("你好");
    expect(target.querySelector(".byte-count")!.textContent).toContain("6");
  });

  it("blocks send above the limit and names the file alternative", () => {
    open();
    type("a".repeat(TEXT_MAX_BYTES + 1));
    expect((target.querySelector("button.send") as HTMLButtonElement).disabled).toBe(true);
    expect(target.textContent).toContain(messages.en.text.tooLong);
    expect(target.textContent).toContain(messages.en.text.useFileInstead);
  });

  it("allows a message of exactly the limit", () => {
    open();
    type("a".repeat(TEXT_MAX_BYTES));
    expect((target.querySelector("button.send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Enter inserts a newline; Cmd/Ctrl+Enter sends", () => {
    const onSend = vi.fn();
    open({ onSend });
    type("line");
    ta().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSend).not.toHaveBeenCalled();
    ta().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    expect(onSend).toHaveBeenCalledWith("line");
    ta().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  });

  it("does not trim what it sends", () => {
    const onSend = vi.fn();
    open({ onSend });
    type("  padded\n\n\t  ");
    ta().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(onSend).toHaveBeenCalledWith("  padded\n\n\t  ");
  });

  it("refuses to send an over-limit body even by the chord", () => {
    const onSend = vi.fn();
    open({ onSend });
    type("a".repeat(TEXT_MAX_BYTES + 1));
    ta().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears the draft after sending", () => {
    open();
    type("gone after send");
    (target.querySelector("button.send") as HTMLButtonElement).click();
    flushSync();
    expect(ta().value).toBe("");
  });

  it("does not let form restoration resurrect a draft", () => {
    open();
    expect(ta().getAttribute("autocomplete")).toBe("off");
  });

  it("opens with prefilled text without sending it", () => {
    const onSend = vi.fn();
    const onPrefillConsumed = vi.fn();
    open({ onSend, prefill: "  pasted\n" });
    expect(ta().value).toBe("  pasted\n");
    expect(onSend).not.toHaveBeenCalled();
    expect(onPrefillConsumed).not.toHaveBeenCalled(); // not passed in this mount
  });

  // ── session state ──────────────────────────────────────────────────────────
  it("shows the SAS and the compare copy while a session is live", () => {
    open();
    expect(target.querySelector(".sas code")!.textContent).toBe("123456");
    expect(target.textContent).toContain(messages.en.text.sasCompare);
  });

  it("hides the SAS once the session has ended", () => {
    open({ status: "ended" });
    expect(target.querySelector(".sas")).toBe(null);
  });

  // On a unified `link/1` workspace the link owns one SAS and the workspace header
  // renders it. A second copy here would present the same authentication step
  // twice, which is precisely what the one-SAS product rule forbids.
  it("renders no verification code at all when the workspace header owns it", () => {
    for (const status of ["open", "waitingAccept", "incomingRequest"] as const) {
      open({ status, showSas: false });
      expect(target.querySelectorAll(".sas"), status).toHaveLength(0);
      expect(target.textContent, status).not.toContain("123456");
      // The one-shot reveal still has somewhere to point.
      const anchor = target.querySelector(".reveal-anchor");
      expect(anchor, status).not.toBe(null);
      expect(anchor!.getAttribute("aria-hidden"), status).toBe("true");
      unmount(app!);
      app = undefined;
      target.innerHTML = "";
    }
  });

  it("keeps its own SAS by default so the legacy surface is unchanged", () => {
    open({ status: "incomingRequest" });
    expect(target.querySelectorAll(".sas")).toHaveLength(1);
    expect(target.querySelector(".reveal-anchor")).toBe(null);
  });

  it("shows the connection path badge", () => {
    open();
    const badge = target.querySelector(".path")!;
    expect(badge.classList.contains("path-lan")).toBe(true);
    expect(badge.textContent).toContain(messages.en.pathLan);
    // The dot is drawn by the shared `.path .dot` rule in app.css. It used to be
    // styled ONLY inside App.svelte's scoped <style>, which does not cross a
    // component boundary — so this element rendered as an invisible nothing here.
    expect(badge.querySelector(".dot")).not.toBe(null);
  });

  // The panel's shell is the shared `.ui-card` primitive. Before, it asked for
  // `.card`, which is defined in App.svelte's *scoped* style block and therefore
  // never applied to this component: no border, no surface, no padding, and an
  // <h2> falling through to the 30px marketing heading size.
  it("uses the shared card primitive for its shell", () => {
    open();
    const panel = target.querySelector(".msgpanel")!;
    expect(panel.classList.contains("ui-card")).toBe(true);
    expect(panel.querySelector("h2")).not.toBe(null);
  });

  it("keeps the panel's shared visual contracts in the global stylesheet", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/app.css", "utf8");
    expect(css).toMatch(/\.ui-card\s*\{/);
    expect(css).toMatch(/\.path \.dot\s*\{[^}]*inline-size:\s*7px/s);
    expect(css).toMatch(/\.sas\s*\{/);
    expect(css).toMatch(/\.btn:not\(:disabled\):not\(\.is-disabled\):not\(\.disabled\):hover/);
    expect(css).toMatch(/\.btn-primary:not\(:disabled\):not\(\.is-disabled\):not\(\.disabled\):hover/);
    expect(css).toMatch(/\.btn-link:not\(:disabled\):not\(\.is-disabled\):not\(\.disabled\):hover/);

    const component = readFileSync("src/lib/MessagePanel.svelte", "utf8");
    expect(component).toMatch(/\.msg\.failed\s*\{[^}]*border-color:\s*var\(--danger\)/s);
  });

  it("renders each session state from its own string", () => {
    for (const [status, expected] of [
      ["connecting", messages.en.text.connecting],
      ["waitingAccept", messages.en.text.waitingAccept],
      ["open", messages.en.text.open_],
      ["ended", messages.en.text.ended],
    ] as const) {
      open({ status, history: [] });
      expect(target.querySelector(".state")!.textContent, status).toContain(expected);
      unmount(app!);
      app = undefined;
      target.innerHTML = "";
    }
  });

  it("renders every terminal error from its key with no mapping table", () => {
    for (const key of ["tooLong", "flooding", "unsupported", "peerBusy", "failed", "refused"] as const) {
      open({ status: "failed", errorKey: key, history: [] });
      expect(target.querySelector(".bad")!.textContent, key).toContain(messages.en.text[key]);
      unmount(app!);
      app = undefined;
      target.innerHTML = "";
    }
  });

  // ── consent ────────────────────────────────────────────────────────────────
  it("shows an inbound request with no composer and both choices", () => {
    open({ status: "incomingRequest", history: [] });
    expect(target.textContent).toContain("Alice");
    expect(target.querySelector("textarea")).toBe(null);
    expect(target.textContent).toContain(messages.en.text.accept);
    expect(target.textContent).toContain(messages.en.text.reject);
    // The SAS is on screen before any message can be.
    expect(target.querySelector(".sas code")!.textContent).toBe("123456");
  });

  it("shows no message bodies at all while a request is pending", () => {
    open({ status: "incomingRequest", history: HISTORY });
    expect(bodies().length).toBe(0);
  });

  it("wires accept and decline", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    open({ status: "incomingRequest", history: [], onAccept, onReject });
    const btns = [...target.querySelectorAll("button")];
    btns.find((b) => b.textContent!.includes(messages.en.text.accept))!.click();
    btns.find((b) => b.textContent!.includes(messages.en.text.reject))!.click();
    expect(onAccept).toHaveBeenCalled();
    expect(onReject).toHaveBeenCalled();
  });

  // ── history controls ───────────────────────────────────────────────────────
  it("offers a copy control per message and states the clipboard risk", () => {
    open();
    expect(target.querySelectorAll("button.copy").length).toBe(3);
    expect(target.textContent).toContain(messages.en.text.clipboardNote);
  });

  it("copies the exact body, untrimmed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    open();
    const row = [...target.querySelectorAll(".msg")].find((n) => n.textContent!.includes("print"))!;
    (row.querySelector("button.copy") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(GNARLY);
    vi.unstubAllGlobals();
  });

  // ── reading order ──────────────────────────────────────────────────────────
  //
  // The transcript only grows. Rendering it oldest-first put the message someone
  // is waiting for at the bottom, below the composer's own scroll position, and
  // moved it further down every time another arrived.
  it("renders the newest message first without touching the array it was given", () => {
    const given: TextMessage[] = [
      { id: 1, dir: "in", body: "oldest", at: 0, failed: false },
      { id: 2, dir: "out", body: "middle", at: 0, failed: false },
      { id: 3, dir: "in", body: "newest", at: 0, failed: false },
    ];
    const snapshot = [...given];
    open({ history: given });

    expect(bodies().map((n) => n.textContent)).toEqual(["newest", "middle", "oldest"]);
    // The prop array is the session's storage: protocol order, `.at` ordering
    // and the retention rules all read it. Reversing in place would corrupt it
    // for every other consumer.
    expect(given).toEqual(snapshot);
    // Reverse mutation: the rendered order really is the other one. A panel that
    // rendered the array unchanged would pass the first assertion only if the
    // fixture happened to be reversed already.
    expect(bodies().map((n) => n.textContent)).not.toEqual(given.map((m) => m.body));
  });

  it("keeps each row's own identity, direction and failed state after reordering", () => {
    open();
    const rows = [...target.querySelectorAll(".msg")] as HTMLElement[];
    // HISTORY is [in GNARLY, out INJECTION, out RTL failed].
    expect(rows.map((r) => r.querySelector(".msg-body")!.textContent))
      .toEqual([RTL, INJECTION, GNARLY]);
    expect(rows[0].classList.contains("out")).toBe(true);
    expect(rows[0].classList.contains("failed")).toBe(true);
    expect(rows[2].classList.contains("out")).toBe(false);
    expect(rows[2].classList.contains("failed")).toBe(false);
  });

  it("puts a later arrival at the top rather than the bottom", () => {
    const first: TextMessage[] = [{ id: 1, dir: "in", body: "one", at: 0, failed: false }];
    open({ history: first });
    expect(bodies().map((n) => n.textContent)).toEqual(["one"]);
    reset();
    open({ history: [...first, { id: 2, dir: "in", body: "two", at: 0, failed: false }] });
    expect(bodies().map((n) => n.textContent)).toEqual(["two", "one"]);
  });

  it("copies the row the user pressed, not the one at the same index in storage", () => {
    // The defect a reordered list invites: the button reads a position rather
    // than its own row's body.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    open({
      history: [
        { id: 1, dir: "in", body: "oldest", at: 0, failed: false },
        { id: 2, dir: "in", body: "newest", at: 0, failed: false },
      ] as TextMessage[],
    });
    const rows = [...target.querySelectorAll(".msg")] as HTMLElement[];
    (rows[0].querySelector("button.copy") as HTMLButtonElement).click();
    expect(writeText).toHaveBeenCalledWith("newest");
    vi.unstubAllGlobals();
  });

  it("shows the empty state and the ephemerality note", () => {
    open({ history: [] });
    expect(target.textContent).toContain(messages.en.text.emptyHistory);
    expect(target.textContent).toContain(messages.en.text.ephemeralNote);
  });

  it("wires clear and end", () => {
    const onClear = vi.fn();
    const onEnd = vi.fn();
    open({ onClear, onEnd });
    const btns = [...target.querySelectorAll("button")];
    btns.find((b) => b.textContent!.trim() === messages.en.text.clear)!.click();
    expect(onClear).toHaveBeenCalled();
    btns.find((b) => b.textContent!.trim() === messages.en.text.ended || b.classList.contains("end"))?.click();
    expect(onEnd).toHaveBeenCalled();
  });

  // ── accessibility ──────────────────────────────────────────────────────────
  it("announces arrivals in a polite log region", () => {
    open();
    const live = target.querySelector('[role="log"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("does not put aria-live on the byte counter", () => {
    open();
    // DownloadPage records the anti-pattern: a continuously updating value in a
    // live region floods a screen reader.
    expect(target.querySelector(".byte-count")!.hasAttribute("aria-live")).toBe(false);
  });

  it("labels the composer and describes it with the counter and the hint", () => {
    open();
    const el = ta();
    const labelled = el.getAttribute("aria-label") || target.querySelector(`label[for="${el.id}"]`);
    expect(labelled).toBeTruthy();
    const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(target.querySelector(`#${id}`), id).toBeTruthy();
    expect(target.textContent).toContain(messages.en.text.sendHint);
  });

  it("gives every control an accessible name", () => {
    open();
    for (const b of target.querySelectorAll("button")) {
      const name = (b.textContent ?? "").trim() || b.getAttribute("aria-label");
      expect(name, b.className).toBeTruthy();
    }
  });
});

// ─── unified (`link/1`) workspace mode ───────────────────────────────────────
// One workspace, one link, one composer: on a mixed link this panel is not "the
// text card" any more, it is the peer's whole activity surface, so file/folder
// attachment lives beside the text composer instead of on a separate peer card
// that the unified workspace no longer renders.
//
// Every prop below is optional and every default reproduces the legacy panel
// byte for byte — the legacy surface is the shipped path and this batch is not
// allowed to move a single selector in it.
// Read at call time: the catalogs are loaded by `loadLang` in beforeEach, so a
// module-level constant here would capture an undefined catalog.
const FILE_LABEL = () => messages.en.sendFile;
const FOLDER_LABEL = () => messages.en.sendFolder;
const RESTART_LABEL = () => messages.en.text.open;

const fileInput = () => target.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement | null;
const folderInput = () => target.querySelector('input[type="file"][webkitdirectory]') as HTMLInputElement | null;
const buttons = () => [...target.querySelectorAll("button")];
const byText = (s: string) => buttons().find((b) => b.textContent!.trim() === s);

function unified(props: Record<string, unknown> = {}) {
  open({
    unified: true, showSas: false, attachmentsEnabled: true,
    onPickFiles: vi.fn(), onPickFolder: vi.fn(), onRestart: vi.fn(), ...props,
  });
}

/** jsdom's `files` is a read-only getter; a real picker result is the only thing
 *  worth asserting the callback receives, so install one on the instance. */
function stubPick(input: HTMLInputElement, files: File[]): FileList {
  const list = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: () => files[Symbol.iterator](),
    ...Object.fromEntries(files.map((f, i) => [i, f])),
  } as unknown as FileList;
  Object.defineProperty(input, "files", { configurable: true, value: list });
  return list;
}

describe("MessagePanel — unified workspace mode", () => {
  // ── composer + attachments ─────────────────────────────────────────────────
  it("renders a text composer and a file attachment, and the folder attachment only when the caller says the browser has one", () => {
    unified({ folderPickSupported: false });
    expect(ta()).not.toBe(null);
    expect(fileInput()).not.toBe(null);
    expect(target.textContent).toContain(FILE_LABEL());
    expect(folderInput()).toBe(null);
    expect(target.textContent).not.toContain(FOLDER_LABEL());
    reset();

    unified({ folderPickSupported: true });
    expect(fileInput()).not.toBe(null);
    expect(folderInput()).not.toBe(null);
    expect(target.textContent).toContain(FOLDER_LABEL());
  });

  it("hands the attachment callback the actual change event and its FileList", () => {
    let seen: { current: EventTarget | null; files: FileList | null } | null = null;
    const onPickFiles = vi.fn((e: Event) => {
      seen = { current: e.currentTarget, files: (e.currentTarget as HTMLInputElement).files };
    });
    let seenFolder: FileList | null = null;
    const onPickFolder = vi.fn((e: Event) => { seenFolder = (e.currentTarget as HTMLInputElement).files; });
    unified({ onPickFiles, onPickFolder, folderPickSupported: true });

    const input = fileInput()!;
    const picked = stubPick(input, [new File(["x"], "a.txt")]);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(onPickFiles).toHaveBeenCalledTimes(1);
    expect(seen!.current).toBe(input);
    expect(seen!.files).toBe(picked); // the exact list, not a copy or a mapping
    expect(onPickFolder).not.toHaveBeenCalled();

    const dir = folderInput()!;
    const pickedDir = stubPick(dir, [new File(["y"], "b.txt")]);
    dir.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(onPickFolder).toHaveBeenCalledTimes(1);
    expect(seenFolder).toBe(pickedDir);
    expect(onPickFiles).toHaveBeenCalledTimes(1);
  });

  // Bytes are the caller's business. This panel is the surface that must never
  // read a body it did not render, and a file is the biggest body of all.
  it("never reads or sends file bytes itself", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/MessagePanel.svelte", "utf8");
    // Named APIs only. A bare "slice(" would also match ordinary string work and
    // become a tripwire that fires on something harmless.
    for (const forbidden of ["arrayBuffer", "FileReader", "pickedFromInput", "sendFiles", "stream()"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps attachments usable in every state where the caller allows another intent", () => {
    // Text being connecting/open/ended says nothing about whether the LINK can
    // take another file — that is one question, and only the caller can answer it.
    for (const status of ["connecting", "waitingAccept", "open", "ended", "failed"] as const) {
      unified({ status });
      expect(fileInput()!.disabled, status).toBe(false);
      reset();
    }
  });

  it("disables attachments when the caller says the peer cannot take another intent", () => {
    unified({ attachmentsEnabled: false });
    const input = fileInput()!;
    expect(input.disabled).toBe(true);
    // :disabled does not apply to the <label> that carries the visible button,
    // so the disabled look has to be a class, exactly as the peer card does it.
    expect(input.closest("label")!.classList.contains("is-disabled")).toBe(true);
  });

  // ── connecting / waiting ───────────────────────────────────────────────────
  it("shows the draft while the session is still connecting but refuses to send it", () => {
    for (const status of ["connecting", "waitingAccept"] as const) {
      const onSend = vi.fn();
      unified({ status, prefill: "  half typed\n", onSend });
      expect(ta(), status).not.toBe(null);
      expect(ta().value, status).toBe("  half typed\n");
      const send = target.querySelector("button.send") as HTMLButtonElement;
      expect(send.disabled, status).toBe(true);
      send.click();
      ta().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
      flushSync();
      expect(onSend, status).not.toHaveBeenCalled();
      expect(ta().value, status).toBe("  half typed\n"); // and it is still there
      reset();
    }
  });

  // ── terminal states ────────────────────────────────────────────────────────
  it("keeps the transcript and the attachments after the conversation ends, and restarts only when asked", () => {
    for (const status of ["ended", "refused", "failed"] as const) {
      const onRestart = vi.fn();
      unified({ status, onRestart });
      expect(bodies().length, status).toBe(3);
      expect(fileInput(), status).not.toBe(null);
      expect(fileInput()!.disabled, status).toBe(false);

      const restart = byText(RESTART_LABEL());
      expect(restart, status).toBeTruthy();
      expect(onRestart, status).not.toHaveBeenCalled(); // nothing auto-restarts
      restart!.click();
      flushSync();
      expect(onRestart, status).toHaveBeenCalledTimes(1);
      reset();
    }
  });

  it("offers no restart while the conversation is live", () => {
    for (const status of ["connecting", "waitingAccept", "open"] as const) {
      unified({ status });
      expect(byText(RESTART_LABEL()), status).toBeUndefined();
      reset();
    }
  });

  // ── the end control belongs to the workspace header ────────────────────────
  it("hides the legacy end control while open, because Disconnect lives in the workspace header", () => {
    const onEnd = vi.fn();
    unified({ onEnd });
    expect(target.querySelector("button.end")).toBe(null);
    expect(target.textContent).not.toContain(messages.en.startOver);
    expect(byText(messages.en.text.clear)).toBeTruthy(); // Clear is local, and stays
    expect(onEnd).not.toHaveBeenCalled();
  });

  // ── consent ────────────────────────────────────────────────────────────────
  it("shows no bodies and no editable composer before an inbound conversation is accepted", () => {
    unified({ status: "incomingRequest" });
    expect(bodies().length).toBe(0);
    expect(target.querySelector("textarea")).toBe(null);
    expect(target.textContent).toContain(messages.en.text.accept);
    // Nothing is pre-armed: a stray Enter/Space must not answer for the user.
    expect(target.querySelector("[autofocus]")).toBe(null);
    expect(target.contains(document.activeElement)).toBe(false);
  });

  it("offers file attachment during consent only when the caller explicitly enables it", () => {
    unified({ status: "incomingRequest", attachmentsEnabled: true });
    expect(fileInput()).not.toBe(null);
    reset();

    unified({ status: "incomingRequest", attachmentsEnabled: false });
    expect(fileInput()).toBe(null);
    expect(target.textContent).not.toContain(FILE_LABEL());
  });

  // ── unchanged invariants ───────────────────────────────────────────────────
  it("still renders a body as an exact, uninterpreted text node", () => {
    unified();
    const got = bodies().find((n) => n.textContent!.includes("alert"))!;
    expect(got.textContent).toBe(INJECTION);
    expect(got.children.length).toBe(0);
    expect(target.querySelector("script")).toBe(null);
    expect(target.querySelector(".msg-body a")).toBe(null);
  });

  it("still renders no verification code of its own", () => {
    unified();
    expect(target.querySelectorAll(".sas")).toHaveLength(0);
    expect(target.textContent).not.toContain("123456");
    expect(target.querySelector(".reveal-anchor")).not.toBe(null);
  });

  // ── accessibility ──────────────────────────────────────────────────────────
  it("names each hidden file input from its visible label and keeps a 44px target", async () => {
    unified({ folderPickSupported: true });
    for (const input of [fileInput()!, folderInput()!]) {
      const id = input.getAttribute("aria-labelledby");
      expect(id, input.className).toBeTruthy();
      const label = target.querySelector(`#${id}`);
      expect(label, id!).not.toBe(null);
      expect(label!.textContent!.trim().length).toBeGreaterThan(0);
      // The visible target is the <label> wrapping the 1px input; `.btn` is what
      // carries the global coarse-pointer 44px floor.
      const wrapper = input.closest("label")!;
      expect(wrapper.classList.contains("btn"), input.className).toBe(true);
      expect(input.classList.contains("file-pick-input")).toBe(true);
    }
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/app.css", "utf8");
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.btn\s*\{[^}]*min-block-size:\s*44px/s);
  });

  it("puts the attachments in the composer's keyboard order, before Send", () => {
    unified({ folderPickSupported: true });
    const order = [ta(), fileInput()!, folderInput()!, target.querySelector("button.send")!];
    for (let i = 1; i < order.length; i++) {
      const rel = order[i - 1].compareDocumentPosition(order[i]);
      expect(rel & Node.DOCUMENT_POSITION_FOLLOWING, String(i)).toBeTruthy();
    }
  });

  it("gives every unified control an accessible name", () => {
    for (const status of ["open", "connecting", "ended", "incomingRequest"] as const) {
      unified({ status, folderPickSupported: true });
      for (const b of target.querySelectorAll("button")) {
        expect((b.textContent ?? "").trim() || b.getAttribute("aria-label"), `${status} ${b.className}`).toBeTruthy();
      }
      reset();
    }
  });
});

// ─── the legacy surface, pinned ──────────────────────────────────────────────
describe("MessagePanel — legacy mode is untouched", () => {
  it("renders no attachment control, no restart, and keeps its own end control", () => {
    open();
    expect(target.querySelector('input[type="file"]')).toBe(null);
    expect(target.textContent).not.toContain(FILE_LABEL());
    expect(target.querySelector("button.end")).not.toBe(null);
    expect(byText(RESTART_LABEL())).toBeUndefined();
  });

  it("renders the composer only while the session is open, exactly as before", () => {
    for (const status of ["connecting", "waitingAccept", "ended", "failed", "refused"] as const) {
      open({ status });
      expect(target.querySelector("textarea"), status).toBe(null);
      expect(target.querySelector("button.send"), status).toBe(null);
      reset();
    }
    open({ status: "open" });
    expect(target.querySelector("textarea")).not.toBe(null);
  });

  it("keeps every attachment prop opt-in: passing the callbacks alone changes nothing", () => {
    open({ onPickFiles: vi.fn(), onPickFolder: vi.fn(), onRestart: vi.fn(), folderPickSupported: true, attachmentsEnabled: true });
    expect(target.querySelector('input[type="file"]')).toBe(null);
    expect(target.querySelector("button.end")).not.toBe(null);
  });
});
