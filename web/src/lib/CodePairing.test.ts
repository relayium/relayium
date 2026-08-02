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
    render({ roomCode: "483920", relayStatus: "quota" });
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
      render({ roomCode: "483920", relayStatus: status });
      expect(warnings().map((p) => p.textContent), status).toEqual([text]);
      unmount(app!);
      app = undefined;
      target.innerHTML = "";
    }
  });

  it("shows it exactly once on the minter, not twice", () => {
    sessionStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + 1800));
    render({ roomCode: "483920", relayStatus: "none" });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].textContent).toBe(messages.en.crossnet.relayNoneWarn);
  });

  it("says nothing when a relay was issued", () => {
    render({ roomCode: "483920", relayStatus: "ok" });
    expect(warnings()).toHaveLength(0);
  });

  // LAN never asks for a relay and never needs one; it is reported as "ok" and
  // is not in a code room at all, so no warning may appear on that surface.
  it("says nothing outside a code room", () => {
    render({ relayStatus: "ok" });
    expect(warnings()).toHaveLength(0);
  });
});

// ── the code entry field ────────────────────────────────────────────────────
//
// The receiving device is most often a phone, and a pairing code is now six
// decimal digits precisely so that phone can put a numeric keypad under it.
// Getting the attribute combination wrong costs exactly that benefit while
// looking fine on the desktop where it is written.
describe("the join-code input", () => {
  const field = () => target.querySelector<HTMLInputElement>("input")!;

  function receiveMode() {
    render({});
    // The joiner reaches the field through "enter a pairing code".
    const enter = [...target.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === messages.en.pair.enterCode)!;
    enter.click();
    flushSync();
  }

  it("asks Android and iOS for the numeric keyboard", () => {
    receiveMode();
    const el = field();
    expect(el.getAttribute("inputmode")).toBe("numeric");
    // Android's Chrome needs BOTH: with inputmode alone on a text field it
    // still offers a full keyboard variant on several OEM IMEs.
    expect(el.getAttribute("pattern")).toBe("[0-9]*");
    // type=number would bring spinners, accept e/+/-/., and normalize "004291"
    // to 4291 in some engines. The code is a string; leading zeros are real.
    expect(el.getAttribute("type")).toBe("text");
    // Regression guard, not an oversight: maxlength must stay OFF. Browsers
    // apply it to the raw pasted string before oninput runs, so pasting the
    // formatted "483-920" is cut to "483-92" and normalizes to the invalid
    // five-digit "48392" — a code the user never mistyped. normalizeCode() is
    // the six-digit cap (it slices to CODE_LEN on every input); the DOM
    // attribute only adds a truncation that happens too early to be correct.
    expect(el.hasAttribute("maxlength")).toBe(false);
    // A letters-era hint would be a lie now, and autocapitalize is meaningless
    // for digits (it also forces some IMEs back to the alpha layout).
    expect(el.getAttribute("placeholder")).toMatch(/^\d{6}$/);
    expect(el.getAttribute("autocapitalize")).toBeNull();
  });

  it("normalizes typed input to digits only, keeping leading zeros", () => {
    receiveMode();
    const el = field();
    el.value = "00 42-91";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(el.value).toBe("004291");

    el.value = "4a8b3c";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(el.value).toBe("483");
  });

  // The bug this pair of cases pins down was found in a real browser, not here:
  // jsdom applies no maxlength to a programmatic `el.value =`, so a unit test
  // can never reproduce the truncation itself. What it can do is assert the
  // attribute is gone (above) and that normalizeCode alone lands on six digits.
  it("keeps a pasted, formatted code whole and caps overlong input at six", () => {
    receiveMode();
    const el = field();
    // Codes get copied out of chat as "483-920". With maxlength the browser cut
    // the raw paste to "483-92" first and the field settled on "48392" — five
    // digits, rejected on join, and nothing the user could see they did wrong.
    el.value = "483-920";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(el.value).toBe("483920");

    // And the cap itself still exists — it just lives in normalizeCode, which
    // slices to CODE_LEN after the non-digits are gone rather than before.
    el.value = "4839201234";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(el.value).toBe("483920");
  });
});
