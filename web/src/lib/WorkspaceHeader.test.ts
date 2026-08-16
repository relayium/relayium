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
    // What stays pinned is exactly the trust state: peer, link state, path, the
    // code when advanced verification produced one, and the escape hatch.
    expect(section.querySelectorAll(".sas")).toHaveLength(1);
    expect(section.querySelectorAll(".wh-disconnect")).toHaveLength(1);
  });

  it("explains the shared connection on a session that shows no code at all", () => {
    // The default session has advanced verification OFF, so there is no SAS row
    // here — and this note is rendered in exactly that case too. It is therefore
    // the one sentence that must stay true without any comparison having
    // happened: it may not call the link verified or refer to comparing a code
    // as something the user did.
    open({ sasCode: "" });
    expect(target.querySelectorAll(".sas")).toHaveLength(0);
    const note = target.querySelector(".wh-note") as HTMLElement;
    expect(note.textContent).toContain(messages.en.workspace.lanesNote);
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

// The bounded relay lifetime and the correlated-loss boundary, as the user sees
// them. The state machine behind them is covered by mixed-link-lifecycle.test.ts;
// what has to hold here is that a warning reads as a warning, a terminal state
// reads as terminal AND offers a way out, and neither one is silent.
describe("WorkspaceHeader lifecycle states", () => {
  const t = () => messages.en.workspace;

  it("warns about the relay boundary without pretending the link is broken", () => {
    const section = open({ relayExpiring: true });
    expect(section.textContent).toContain(t().relayExpiring);
    // Still a live, fully-identified link: state, path and the code stay put,
    // and the action is still Disconnect rather than a restart.
    expect(section.textContent).toContain(t().stateOpen);
    expect(target.querySelectorAll(".path")).toHaveLength(1);
    expect(target.querySelectorAll(".sas")).toHaveLength(1);
    expect(target.querySelector(".wh-restart")).toBe(null);
  });

  it("says a live link is unrecoverable before anything has gone wrong", () => {
    const section = open({ recoveryAvailable: false });
    expect(section.textContent).toContain(t().recoveryUnavailable);
    expect(section.textContent).toContain(t().stateOpen);
    expect(target.querySelector(".wh-restart")).toBe(null);
  });

  it("shows no warnings at all on an ordinary link", () => {
    open();
    expect(target.querySelectorAll(".wh-warn")).toHaveLength(0);
  });

  it.each([
    ["relayExpired", () => messages.en.workspace.endedRelay],
    ["signalingLost", () => messages.en.workspace.endedSignaling],
  ])("states %s as the link's own state, with the action that answers it", (endReason, copy) => {
    const onRestart = vi.fn();
    const section = open({ endReason, onRestart, status: "idle" as LinkStatus });
    expect(copy()).toBeTruthy();
    expect(section.textContent).toContain(copy());
    // The raw status is "idle" or "failed" depending on which teardown path got
    // there first, and neither tells anyone what to do. The reason replaces it.
    expect(section.textContent).not.toContain(t().stateIdle);
    // Nothing left that describes a live link: no path badge, no code to
    // compare — the connection they belonged to is gone.
    expect(target.querySelectorAll(".path")).toHaveLength(0);
    expect(target.querySelectorAll(".sas")).toHaveLength(0);

    const restart = target.querySelector(".wh-restart") as HTMLButtonElement;
    expect(restart).not.toBe(null);
    expect(restart.textContent?.trim()).toBe(t().restart);
    expect(target.querySelector(".wh-disconnect")).toBe(null);
    restart.click();
    flushSync();
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("treats a plain failure as terminal, with no reason string to lean on", () => {
    // The ending that carries no name: the peer refused, the transport never
    // opened, the request ran out. It is every bit as over as the two above, and
    // it used to render as a live link — path badge, code, Disconnect and all.
    const onRestart = vi.fn();
    const onDisconnect = vi.fn();
    const section = open({
      status: "failed" as LinkStatus, endReason: "", onRestart, onDisconnect,
      path: "lan", sasCode: "384719", relayExpiring: true, recoveryAvailable: false,
    });

    // The sentence is the status, because `stateFailed` is the most this side
    // knows — there is no reason string to replace it with.
    expect(section.textContent).toContain(t().stateFailed);
    expect(section.textContent).not.toContain(t().endedRelay);
    expect(section.textContent).not.toContain(t().endedSignaling);
    // Nothing that describes a live link survives it.
    expect(target.querySelectorAll(".path")).toHaveLength(0);
    expect(target.querySelectorAll(".sas")).toHaveLength(0);
    expect(target.querySelectorAll(".wh-warn")).toHaveLength(0);

    // One action, and it answers the card rather than ending a connection that
    // has already ended.
    const restart = target.querySelector(".wh-restart") as HTMLButtonElement;
    expect(restart).not.toBe(null);
    expect(restart.textContent?.trim()).toBe(t().restart);
    expect(target.querySelector(".wh-disconnect")).toBe(null);
    restart.click();
    flushSync();
    expect(onRestart).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("still shows the live chrome and Disconnect on every non-terminal state", () => {
    // Reverse mutation for the assertions above: a header that treated every
    // state as terminal would satisfy them and break the live link entirely.
    for (const status of ["requesting", "connecting", "open", "interrupted"] as LinkStatus[]) {
      open({ status, path: "lan", sasCode: "384719", onRestart: vi.fn() });
      expect(target.querySelectorAll(".path"), status).toHaveLength(1);
      expect(target.querySelectorAll(".sas"), status).toHaveLength(1);
      expect(target.querySelector(".wh-disconnect"), status).not.toBe(null);
      expect(target.querySelector(".wh-restart"), status).toBe(null);
      unmount(app!);
      app = undefined;
      target.innerHTML = "";
    }
  });

  it("drops the live warnings once the link has actually ended", () => {
    // By then the state line says more than either of them, and a "close to its
    // time limit" note under "the time limit was reached" is simply wrong.
    open({ endReason: "relayExpired", relayExpiring: true, recoveryAvailable: false, onRestart: vi.fn() });
    expect(target.querySelectorAll(".wh-warn")).toHaveLength(0);
  });
});
