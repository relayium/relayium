import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import WorkspaceHeader from "./WorkspaceHeader.svelte";
import { loadLang, messages } from "./i18n.svelte";
import type { PeerWorkspace } from "./peer-workspace.svelte";

type LinkStatus = PeerWorkspace["linkStatus"];

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

function open(props: Record<string, unknown> = {}) {
  app = mount(WorkspaceHeader, {
    target,
    props: {
      peerName: "Alice", status: "open" as LinkStatus, sasCode: "384719",
      path: "lan", onDisconnect: vi.fn(), ...props,
    },
  });
  flushSync();
  return target.querySelector("section") as HTMLElement;
}

describe("WorkspaceHeader", () => {
  it("carries the whole link identity in one place", () => {
    const t = messages.en;
    const section = open();
    expect(section.textContent).toContain(t.workspace.peer("Alice"));
    expect(section.textContent).toContain(t.workspace.stateOpen);
    expect(section.getAttribute("aria-label")).toBe(t.workspace.heading);
    // One path badge, and it is this one.
    expect(target.querySelectorAll(".path")).toHaveLength(1);
    expect(target.querySelector(".path")?.textContent).toContain(t.pathLan);
  });

  it("renders exactly one SAS and never a second copy", () => {
    open();
    const sas = target.querySelectorAll(".sas");
    expect(sas).toHaveLength(1);
    expect(sas[0].querySelector("code")?.textContent).toBe("384719");
    expect(sas[0].textContent).toContain(messages.en.codeCompare);
  });

  it("shows no verification box before the link produces a code", () => {
    open({ sasCode: "", status: "connecting" as LinkStatus });
    expect(target.querySelectorAll(".sas")).toHaveLength(0);
    expect(target.textContent).toContain(messages.en.workspace.stateConnecting);
  });

  it("omits the path badge until a path is known", () => {
    open({ path: undefined });
    expect(target.querySelectorAll(".path")).toHaveLength(0);
  });

  it("says nothing about a peer it cannot yet name", () => {
    const section = open({ peerName: "", status: "connecting" as LinkStatus });
    expect(target.querySelector(".wh-peer")).toBe(null);
    expect(section.textContent).toContain(messages.en.workspace.stateConnecting);
    // The disconnect escape hatch still exists during establishment.
    expect(target.querySelector("button")).not.toBe(null);
  });

  it("names every link state it can be given", () => {
    const cases: [LinkStatus, string][] = [
      ["idle", messages.en.workspace.stateIdle],
      ["requesting", messages.en.workspace.stateRequesting],
      ["connecting", messages.en.workspace.stateConnecting],
      ["open", messages.en.workspace.stateOpen],
      ["failed", messages.en.workspace.stateFailed],
    ];
    for (const [status, label] of cases) {
      const section = open({ status });
      expect(label, `${status} has copy`).toBeTruthy();
      expect(section.textContent, `${status} renders its own state`).toContain(label);
      unmount(app!);
      app = undefined;
      target.innerHTML = "";
    }
  });

  it("pins only the trust state, leaving the explanation to scroll away", () => {
    const section = open();
    // The sentence is still rendered, and still right below the header…
    const note = target.querySelector(".wh-note") as HTMLElement;
    expect(note.textContent).toContain(messages.en.workspace.lanesNote);
    // …but outside the sticky box. Measured on a real 390x844 tab, keeping it
    // inside made the pinned region 274px — a third of the phone screen, taken
    // from every subsequent scroll position, for a sentence read once.
    expect(section.contains(note)).toBe(false);
    expect(section.nextElementSibling).toBe(note);
    // What stays pinned is exactly the trust state: peer, link state, path, code
    // and the escape hatch.
    expect(section.querySelectorAll(".sas")).toHaveLength(1);
    expect(section.querySelectorAll(".wh-disconnect")).toHaveLength(1);
  });

  it("hands back the pinned box so a reveal can measure it at scroll time", () => {
    // Not a measured number: this header grows by its SAS row the instant the
    // link produces a code, so any height sampled ahead of the scroll is the
    // wrong height. The caller gets the element and measures it itself.
    const probe: { value: HTMLElement | undefined } = { value: undefined };
    app = mount(WorkspaceHeader, {
      target,
      props: {
        peerName: "Alice", status: "open" as LinkStatus, sasCode: "384719",
        path: "lan", onDisconnect: vi.fn(),
        get element() { return probe.value; },
        set element(v: HTMLElement | undefined) { probe.value = v; },
      },
    });
    flushSync();
    expect(probe.value).toBe(target.querySelector("section.workspace-head"));
    // It is the sticky box that is handed back, not the whole component: the
    // explanation below it scrolls away and must not be counted as pinned.
    expect(probe.value?.querySelector(".wh-note")).toBe(null);
  });

  it("offers an explicit disconnect action as a real, reachable button", () => {
    const onDisconnect = vi.fn();
    open({ onDisconnect });
    const button = target.querySelector("button") as HTMLButtonElement;
    expect(button.type).toBe("button");
    // Shares the .btn primitive, which is what supplies the 44px coarse-pointer
    // touch floor and the dark-mode control tokens.
    expect(button.className).toContain("btn");
    expect(button.textContent?.trim()).toBe(messages.en.workspace.disconnect);
    button.click();
    flushSync();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});
