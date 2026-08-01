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
    const items = [...target.querySelectorAll(".msg")];
    expect(items.length).toBe(3);
    expect(items[0].classList.contains("out")).toBe(false);
    expect(items[1].classList.contains("out")).toBe(true);
    expect(items[2].classList.contains("failed")).toBe(true);
    expect(items[2].textContent).toContain(messages.en.status.sendFail);
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
