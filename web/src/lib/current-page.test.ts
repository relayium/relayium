import { describe, it, expect, vi } from "vitest";
import { isCurrentPage, watchCurrentPage } from "./current-page";

/** A minimal stand-in for document/window: jsdom's visibilityState is read-only
 *  and its focus model does not model "another tab is in front" at all. */
function fakeEnv(visible = true, focused = visible) {
  const listeners: Record<string, (() => void)[]> = {};
  const target = {
    visibilityState: visible ? "visible" : "hidden",
    hasFocus: () => focused,
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  return {
    doc: target,
    fire(type: string) {
      if (type === "focus") focused = true;
      if (type === "blur") focused = false;
      for (const fn of [...(listeners[type] ?? [])]) fn();
    },
    show() { target.visibilityState = "visible"; focused = true; },
    hide() { target.visibilityState = "hidden"; },
    count(type: string) { return (listeners[type] ?? []).length; },
  };
}

describe("isCurrentPage", () => {
  it("is true only for the page the user is looking at", () => {
    const env = fakeEnv(true);
    expect(isCurrentPage(env.doc)).toBe(true);
    env.hide();
    expect(isCurrentPage(env.doc)).toBe(false);
  });

  it("does not let a visible but unfocused sibling window claim the initial join", () => {
    expect(isCurrentPage(fakeEnv(true, false).doc)).toBe(false);
  });
});

describe("watchCurrentPage", () => {
  it("does not announce on start — the join frame already carries the state", () => {
    const env = fakeEnv(true);
    const onBecome = vi.fn();
    watchCurrentPage(onBecome, env.doc, env.doc);
    expect(onBecome).not.toHaveBeenCalled();
  });

  it("announces when a background page comes to the front", () => {
    const env = fakeEnv(false);
    const onBecome = vi.fn();
    watchCurrentPage(onBecome, env.doc, env.doc);
    env.show();
    env.fire("visibilitychange");
    expect(onBecome).toHaveBeenCalledTimes(1);
  });

  it("does not re-announce while it stays the current page", () => {
    // Every announcement costs a frame out of this connection's server-side
    // budget, and focus/visibility fire in bursts (alt-tab, window manager,
    // devtools). Only a genuine transition may spend one.
    const env = fakeEnv(false);
    const onBecome = vi.fn();
    watchCurrentPage(onBecome, env.doc, env.doc);
    env.show();
    for (let i = 0; i < 50; i++) {
      env.fire("visibilitychange");
      env.fire("focus");
    }
    expect(onBecome).toHaveBeenCalledTimes(1);
  });

  it("announces again after the user leaves and comes back", () => {
    const env = fakeEnv(true);
    const onBecome = vi.fn();
    watchCurrentPage(onBecome, env.doc, env.doc);
    env.hide();
    env.fire("visibilitychange");
    env.show();
    env.fire("visibilitychange");
    expect(onBecome).toHaveBeenCalledTimes(1);
    env.hide();
    env.fire("visibilitychange");
    env.show();
    env.fire("visibilitychange");
    expect(onBecome).toHaveBeenCalledTimes(2);
  });

  it("treats a focus on an already-visible page as a handover", () => {
    // Two visible windows side by side: visibility never changes, so focus is
    // the only signal that says which one the user just moved to.
    const env = fakeEnv(true);
    const onBecome = vi.fn();
    watchCurrentPage(onBecome, env.doc, env.doc);
    env.fire("blur");
    env.fire("focus");
    expect(onBecome).toHaveBeenCalledTimes(1);
  });

  it("stops listening when torn down", () => {
    const env = fakeEnv(false);
    const onBecome = vi.fn();
    const stop = watchCurrentPage(onBecome, env.doc, env.doc);
    stop();
    env.show();
    env.fire("visibilitychange");
    expect(onBecome).not.toHaveBeenCalled();
    expect(env.count("visibilitychange")).toBe(0);
    expect(env.count("focus")).toBe(0);
    expect(env.count("blur")).toBe(0);
  });
});
