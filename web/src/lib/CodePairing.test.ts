import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import CodePairing from "./CodePairing.svelte";
import { loadLang, messages } from "./i18n.svelte";
import type { RelayAvailability } from "./ice";

// The one thing that decides which role the component renders as: the minting
// device stashes the code's expiry here, a joiner never has it.
const EXP_KEY = "relayium_pair_exp";

let target: HTMLDivElement;
let app: unknown;

beforeEach(async () => {
  await loadLang("en");
  sessionStorage.clear();
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
  sessionStorage.clear();
});

function render(props: { roomCode?: string; relayStatus?: RelayAvailability }) {
  app = mount(CodePairing, { target, props });
  flushSync();
}

const warnings = () => [...target.querySelectorAll<HTMLElement>(".quota-warn")];

describe("the relay warning on a code room", () => {
  // The reported gap: only the minter's branch rendered it, so the person who
  // typed or scanned the code — the one with nothing else on screen — waited out
  // a connection that could never succeed and was told nothing.
  it("warns the side that joined with a code, not just the minter", () => {
    render({ roomCode: "K7M3X9", relayStatus: "quota" });
    expect(sessionStorage.getItem(EXP_KEY)).toBeNull(); // this is the joiner
    expect(warnings().map((p) => p.textContent)).toEqual([messages.en.crossnet.relayQuotaWarn]);
  });

  it("warns each of the other withheld/unreadable reasons for a joiner too", () => {
    const cases: [RelayAvailability, string][] = [
      ["unverified", messages.en.crossnet.relayUnverifiedWarn],
      ["ratelimited", messages.en.crossnet.relayUnavailableWarn],
      ["unavailable", messages.en.crossnet.relayUnavailableWarn],
      ["none", messages.en.crossnet.relayNoneWarn],
    ];
    for (const [status, text] of cases) {
      render({ roomCode: "K7M3X9", relayStatus: status });
      expect(warnings().map((p) => p.textContent), status).toEqual([text]);
      unmount(app!);
      app = undefined;
      target.innerHTML = "";
    }
  });

  it("shows it exactly once on the minter, not twice", () => {
    sessionStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + 1800));
    render({ roomCode: "K7M3X9", relayStatus: "none" });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].textContent).toBe(messages.en.crossnet.relayNoneWarn);
  });

  it("says nothing when a relay was issued", () => {
    render({ roomCode: "K7M3X9", relayStatus: "ok" });
    expect(warnings()).toHaveLength(0);
  });

  // LAN never asks for a relay and never needs one; it is reported as "ok" and
  // is not in a code room at all, so no warning may appear on that surface.
  it("says nothing outside a code room", () => {
    render({ relayStatus: "ok" });
    expect(warnings()).toHaveLength(0);
  });
});
