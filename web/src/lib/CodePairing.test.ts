import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import CodePairing from "./CodePairing.svelte";
import { loadLang, messages } from "./i18n.svelte";
import type { RelayAvailability } from "./ice";
import { clearOutbox, setOutbox } from "./outbox.svelte";
import { refreshSession } from "./auth.svelte";

// The one thing that decides which role the component renders as: the minting
// device stashes the code's expiry here, a joiner never has it.
const EXP_KEY = "relayium_pair_exp";

let target: HTMLDivElement;
let app: unknown;

beforeEach(async () => {
  await loadLang("en");
  clearOutbox();
  sessionStorage.clear();
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
  clearOutbox();
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

describe("files waiting in a minted code room", () => {
  it("keeps every current outbox name and size visible while waiting for the peer", () => {
    sessionStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + 1800));
    setOutbox([
      { file: new File([], "empty.txt") },
      { file: new File([new Uint8Array(2048)], "报告.pdf") },
    ]);

    render({ roomCode: "483920", relayStatus: "ok" });

    expect(target.querySelector(".summary")?.textContent)
      .toBe(messages.en.pair.queued(2, "2.0 KB"));
    expect([...target.querySelectorAll<HTMLElement>(".file-name")].map((node) => node.textContent))
      .toEqual(["empty.txt", "报告.pdf"]);
    expect([...target.querySelectorAll<HTMLElement>(".file-size")].map((node) => node.textContent))
      .toEqual(["0 B", "2.0 KB"]);
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

// The pre-pair choice, for a signed-in sender.
//
// The owner inverted this flow on 2026-08-11: it used to lead with "Send files"
// / "Send a folder", which mint a code only AFTER a batch is picked, and offered
// minting-without-files as a secondary ghost button. Picking first is what made
// the sender wait with nothing to do, so the order is now reversed — mint first,
// decide what to send while the code is out. That leaves exactly one sender
// action on this screen and no file input at all: staging moved into the waiting
// room, where the code is already on screen to pass on.
describe("the signed-in choose screen", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  async function signedIn() {
    const user = { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true };
    fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
      if (url === "/api/pair") {
        return { ok: true, status: 200, json: async () => ({ code: "483920", expiresAt: 9e9 }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await refreshSession();
    render({});
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it("offers creating a code as the one primary action", async () => {
    await signedIn();
    const create = target.querySelector(".create-code") as HTMLButtonElement;
    expect(create).not.toBe(null);
    expect(create.tagName).toBe("BUTTON");
    expect(create.className).toContain("btn-primary");
    expect(create.textContent?.trim()).toBe(messages.en.pair.sendCode);
  });

  it("offers no file picker before a code exists", async () => {
    await signedIn();
    // The whole point of the inversion. A picker here would rebuild the
    // "choose files, then wait" ordering next to the button that replaced it.
    expect(target.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it("still lets a receiver enter someone else's code", async () => {
    await signedIn();
    // Without this the six-digit half of the product is unreachable: a receiver
    // who was read a code over the phone has no other way in.
    const buttons = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain(messages.en.pair.enterCode);
  });

  it("mints exactly one code when that action is used", async () => {
    await signedIn();
    (target.querySelector(".create-code") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([u]) => u === "/api/pair")).toHaveLength(1);
    });
  });

  // The nine-locale shape of that label (short, trimmed, not a sentence) is
  // asserted in i18n.test.ts, which is the file that imports every table.
});

// The other half of the inversion: the wait is now where the batch is built.
describe("staging inside a waiting code room", () => {
  // The minter's branch is the one with the staging box — a joiner has nothing
  // to stage, it is the sender who is waiting.
  function asMinter() {
    sessionStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + 300));
    render({ roomCode: "483920" });
  }
  const pick = (n: number) =>
    [...target.querySelectorAll<HTMLInputElement>('input[type="file"]')][n];
  const file = (name: string) => new File(["x"], name, { lastModified: 0 });

  /** Drive a file input the way a user's pick does. jsdom will not let `.files`
   *  be assigned, so it is redefined for this one element. */
  function choose(input: HTMLInputElement, ...names: string[]) {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: Object.assign(names.map(file), { item: (i: number) => file(names[i]) }),
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
  }

  it("tells the sender to pass the code on", () => {
    asMinter();
    expect(target.textContent).toContain(messages.en.pair.handoff);
  });

  it("offers to stage files without waiting for the other device", () => {
    asMinter();
    expect(target.textContent).toContain(messages.en.pair.stageLead);
    expect(pick(0)).toBeTruthy();
  });

  it("adds each pick to the batch instead of replacing the last one", () => {
    asMinter();
    choose(pick(0), "a.txt");
    choose(pick(0), "b.txt");
    // The regression this guards: setOutbox semantics here would silently throw
    // away "a.txt" — including when it arrived from the OS share sheet.
    expect(target.textContent).toContain("a.txt");
    expect(target.textContent).toContain("b.txt");
  });

  it("keeps a batch that was already queued before the code was minted", () => {
    setOutbox([{ file: file("shared.bin") }]);
    asMinter();
    choose(pick(0), "picked.bin");
    expect(target.textContent).toContain("shared.bin");
    expect(target.textContent).toContain("picked.bin");
  });

  it("lets one staged file be removed again", () => {
    asMinter();
    choose(pick(0), "a.txt");
    choose(pick(0), "b.txt");
    const remove = [...target.querySelectorAll<HTMLButtonElement>(".file-remove")];
    expect(remove).toHaveLength(2);
    // Named with the file, not just "Remove": a column of identical labels
    // names nothing to a screen reader.
    expect(remove[0].getAttribute("aria-label")).toContain("a.txt");
    remove[0].click();
    flushSync();
    expect(target.textContent).not.toContain("a.txt");
    expect(target.textContent).toContain("b.txt");
  });

  it("says the transfer starts by itself, and claims nothing about uploading", () => {
    asMinter();
    choose(pick(0), "a.txt");
    expect(target.textContent).toContain(messages.en.pair.stageNote);
    // stageNote must survive pre-upload landing, so it may not promise either
    // that the bytes stay local or that they go straight to the peer (a
    // cross-network room relays them through TURN).
    expect(messages.en.pair.stageNote.toLowerCase()).not.toContain("upload");
    expect(messages.en.pair.stageNote.toLowerCase()).not.toContain("directly");
  });

  it("shows no staging box to the side that joined with a code", () => {
    render({ roomCode: "483920" }); // no EXP_KEY: this is the joiner
    expect(target.textContent).not.toContain(messages.en.pair.stageLead);
    expect(target.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });
});
