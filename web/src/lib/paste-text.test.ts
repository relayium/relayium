import { describe, it, expect } from "vitest";
import { pastedText } from "./paste-text";

// jsdom does not construct a ClipboardEvent carrying data, so build the shape the
// function actually reads.
function ev(text: string | null, target: EventTarget | null): ClipboardEvent {
  return {
    clipboardData: text === null ? null : { getData: (t: string) => (t === "text/plain" ? text : "") },
    target,
  } as unknown as ClipboardEvent;
}
const div = () => document.createElement("div");

describe("pastedText", () => {
  it("returns pasted plain text", () => {
    expect(pastedText(ev("hello", div()))).toBe("hello");
  });

  // The bytes are the content: this feeds a composer whose whole promise is exact
  // preservation, so a trim here would silently break it at the entry point.
  it("preserves whitespace, newlines and tabs exactly", () => {
    const gnarly = "  \tif x:\n\n\t\tprint('你好 🌍')\n  trailing   ";
    const got = pastedText(ev(gnarly, div()))!;
    expect(got).toBe(gnarly);
    const enc = new TextEncoder();
    expect([...enc.encode(got)]).toEqual([...enc.encode(gnarly)]);
  });

  it("does not trim a paste that is only whitespace", () => {
    expect(pastedText(ev("   \n\t ", div()))).toBe("   \n\t ");
  });

  it("ignores an empty clipboard and a missing clipboardData", () => {
    expect(pastedText(ev("", div()))).toBe(null);
    expect(pastedText(ev(null, div()))).toBe(null);
  });

  // Pasting a file is unhandled today and stays unhandled: text/plain is empty,
  // so this is not ours.
  it("ignores a paste that carries no text", () => {
    const fileOnly = { clipboardData: { getData: () => "" }, target: div() } as unknown as ClipboardEvent;
    expect(pastedText(fileOnly)).toBe(null);
  });

  // The pairing-code box and the rename input rely on native paste. Breaking
  // those to add this would be a bad trade.
  it("stays out of the way of text controls", () => {
    expect(pastedText(ev("x", document.createElement("input")))).toBe(null);
    expect(pastedText(ev("x", document.createElement("textarea")))).toBe(null);
    expect(pastedText(ev("x", document.createElement("select")))).toBe(null);
  });

  it("stays out of the way of a contenteditable, including inside one", () => {
    const editable = div();
    editable.setAttribute("contenteditable", "true");
    expect(pastedText(ev("x", editable))).toBe(null);
    // A paste inside a rich-text region targets the inner node, not the host.
    const inner = document.createElement("span");
    editable.appendChild(inner);
    document.body.appendChild(editable);
    expect(pastedText(ev("x", inner))).toBe(null);
    editable.remove();
  });

  it("survives a target that is not an element", () => {
    expect(pastedText(ev("x", null))).toBe("x");
    expect(pastedText(ev("x", document))).toBe("x");
  });

  // It reads the paste EVENT and nothing else: no navigator.clipboard.readText,
  // which would need a permission and could read the clipboard unprompted.
  it("never reads the clipboard API", () => {
    let read = false;
    const spy = { readText: () => { read = true; return Promise.resolve("x"); } };
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: spy, configurable: true });
    pastedText(ev("hello", div()));
    if (original) Object.defineProperty(navigator, "clipboard", original);
    expect(read).toBe(false);
  });
});
