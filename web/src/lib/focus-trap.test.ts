import { describe, it, expect, beforeEach } from "vitest";
import { trapFocus } from "./focus-trap";

function dialogWith(html: string): HTMLElement {
  const d = document.createElement("div");
  d.setAttribute("role", "dialog");
  d.innerHTML = html;
  document.body.appendChild(d);
  return d;
}

// jsdom 没有布局，offsetParent 恒为 null；action 里的可见性过滤要靠这个桩才走得通。
function makeVisible(el: HTMLElement) {
  Object.defineProperty(el, "offsetParent", { get: () => document.body, configurable: true });
}

describe("trapFocus", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("打开时把焦点移进对话框的第一个可聚焦元素", () => {
    const d = dialogWith('<button id="a">a</button><button id="b">b</button>');
    d.querySelectorAll("button").forEach(makeVisible);
    trapFocus(d);
    expect(document.activeElement?.id).toBe("a");
  });

  it("内容没有可聚焦元素时，焦点落到对话框本身", () => {
    const d = dialogWith("<p>just text</p>");
    trapFocus(d);
    expect(document.activeElement).toBe(d);
    expect(d.tabIndex).toBe(-1);
  });

  it("Tab 到最后一个之后回到第一个（不会跑到背景上）", () => {
    const d = dialogWith('<button id="a">a</button><button id="b">b</button>');
    const [a, b] = Array.from(d.querySelectorAll("button")) as HTMLButtonElement[];
    [a, b].forEach(makeVisible);
    trapFocus(d);
    b.focus();
    d.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(a);
  });

  it("Shift+Tab 从第一个回到最后一个", () => {
    const d = dialogWith('<button id="a">a</button><button id="b">b</button>');
    const [a, b] = Array.from(d.querySelectorAll("button")) as HTMLButtonElement[];
    [a, b].forEach(makeVisible);
    trapFocus(d);
    a.focus();
    d.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(b);
  });

  it("关闭时把焦点还给打开它的那个元素", () => {
    const opener = document.createElement("button");
    opener.id = "opener";
    document.body.appendChild(opener);
    makeVisible(opener);
    opener.focus();

    const d = dialogWith('<button id="a">a</button>');
    d.querySelectorAll("button").forEach(makeVisible);
    const handle = trapFocus(d);
    expect(document.activeElement?.id).toBe("a");
    handle.destroy();
    expect(document.activeElement?.id).toBe("opener");
  });

  it("用户自己把焦点点去了对话框外时不抢回来", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    makeVisible(opener);
    opener.focus();
    const elsewhere = document.createElement("button");
    elsewhere.id = "elsewhere";
    document.body.appendChild(elsewhere);
    makeVisible(elsewhere);

    const d = dialogWith('<button id="a">a</button>');
    d.querySelectorAll("button").forEach(makeVisible);
    const handle = trapFocus(d);
    elsewhere.focus();
    handle.destroy();
    expect(document.activeElement?.id).toBe("elsewhere");
  });
});
