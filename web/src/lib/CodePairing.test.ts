import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import CodePairing from "./CodePairing.svelte";
import { loadLang, messages } from "./i18n.svelte";
import type { RelayAvailability } from "./ice";
import { addToOutbox, clearOutbox, removeFromOutbox, setOutbox, outboxState, outboxToken, uploadedRefs } from "./outbox.svelte";
import { resetPreupload, startPreupload, preuploadProgress, preuploadUnconfirmed } from "./preupload.svelte";
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

function render(props: { roomCode?: string; relayStatus?: RelayAvailability; expired?: boolean }) {
  app = mount(CodePairing, { target, props });
  flushSync();
}

const warnings = () => [...target.querySelectorAll<HTMLElement>(".quota-warn")];

/** Poll until `check` holds, on real timers. Used by every case that drives a
 *  real upload through a fake server: the work is spread over microtasks, real
 *  WebCrypto continuations and fetch turns, so a single drain returns too early. */
async function until(check: () => boolean, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

// Pre-upload's sender half is wired into this surface, and this build both
// sends the key handoff and receives it — so the surface really does upload.
// That is the load-bearing fact, and it is pinned here.
describe("the waiting room and pre-upload", () => {
  const EXPIRY = () => String(Math.floor(Date.now() / 1000) + 300);

  // Both ends, not just the way out: an earlier case in this file renders a
  // minted room with files staged, which starts a real driver against the same
  // code and leaves it `closed` when the unstubbed fetch fails. A room this
  // module already believes is over accepts no upload, so without this the case
  // below waits for a request that will never be made.
  beforeEach(() => resetPreupload());

  afterEach(() => {
    resetPreupload();
    clearOutbox();
    vi.unstubAllGlobals();
  });

  it("pre-uploads the staged batch against this room's code", async () => {
    // This assertion used to be the exact opposite — "uploads nothing at all
    // while this build cannot hand the keys over" — and it went on passing after
    // the handoff landed and switched the uploader on, because it drained a
    // single microtask and the upload had not reached `fetch` yet. A guard that
    // proves the absence of something has to WAIT for it; this one waits for the
    // upload to finish instead, so there is nothing left for it to miss.
    const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
    let received = 0;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.startsWith("/api/uploads?")) return json({ uploadId: "u1", chunkSize: 1024 });
      if (url.endsWith("/finalize")) return json({ id: "obj1", expiresAt: 123 });
      if (method === "PATCH") {
        received += new Uint8Array(await (init!.body as Blob).arrayBuffer?.() ?? (init!.body as Uint8Array)).length;
        return json({ received });
      }
      return json({ received });
    });
    vi.stubGlobal("fetch", f);
    setOutbox([{ file: new File(["x"], "a.bin", { lastModified: 0 }) }]);
    sessionStorage.setItem(EXP_KEY, EXPIRY());
    render({ roomCode: "483920" });

    await until(() => outboxState(0) === "uploaded");
    const init = f.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith("/api/uploads?"));
    // Bound to THIS room, and naming no retention of its own: retention here
    // belongs to the room, and the server refuses a pre-upload that mentions it.
    expect(init).toContain("purpose=pair_room");
    expect(init).toContain("code=483920");
    expect(init).not.toContain("ttl=");
    // The key is the outbox's, to be handed over on the link — never in the URL.
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj1"]);
  });

  it("crosses the pre-upload boundary itself on a re-mint, before the new room exists", async () => {
    // Who owns the sender half of a code→code boundary, proved through the real
    // button. `send()` releases the old room's finished objects SYNCHRONOUSLY,
    // between the mint and enterRoom — so by the time roomCode changes there is
    // nothing left for a second owner to release, and any reset that arrives
    // afterwards can only take the NEW room's work away (preupload.test.ts
    // executes that). App's room-binding effect therefore does not reset
    // pre-upload on code→code; workspace-orchestration.test.ts pins its absence.
    //
    // Asserted AT the room change rather than after it, because "before" is the
    // whole claim: history.replaceState is enterRoom's first statement, so this
    // observes the outbox at the instant the room flips.
    const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
    let sessions = 0, received = 0, pairs = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/pair") { pairs++; return json({ code: "100200", expiresAt: 9e9 }); }
      if (method === "POST" && url.startsWith("/api/uploads?")) {
        received = 0;
        return json({ uploadId: `u${++sessions}`, chunkSize: 1024 });
      }
      if (url.endsWith("/finalize")) return json({ id: `obj-u${sessions}`, expiresAt: 123 });
      if (method === "PATCH") {
        received += new Uint8Array(await (init!.body as Blob).arrayBuffer?.() ?? (init!.body as Uint8Array)).length;
        return json({ received });
      }
      return json({ received });
    }));

    setOutbox([{ file: new File(["x"], "a.bin", { lastModified: 0 }) }]);
    await startPreupload("483920", true); // room A finishes the batch
    expect(outboxState(0)).toBe("uploaded");
    expect(uploadedRefs().map((r) => r.id)).toEqual(["obj-u1"]);

    const atRoomChange: { url: string; state: string; refs: string[] }[] = [];
    const replaceState = history.replaceState.bind(history);
    vi.spyOn(history, "replaceState").mockImplementation((...args: Parameters<typeof replaceState>) => {
      atRoomChange.push({
        url: String(args[2] ?? ""),
        state: outboxState(0),
        refs: uploadedRefs().map((r) => r.id),
      });
      replaceState(...args);
    });

    // The minter's own countdown has lapsed, so the card offers the re-mint.
    sessionStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) - 1));
    render({ roomCode: "483920" });
    const remint = [...target.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === messages.en.pair.sendCode);
    expect(remint, "the lapsed card offers no re-mint").toBeTruthy();
    remint!.click();
    await vi.waitFor(() => expect(pairs).toBe(1));
    await vi.waitFor(() => expect(atRoomChange).toHaveLength(1));

    // Already back on the live link, and already off the set the handoff would
    // seal into a frame — at the moment the new code takes over, not later.
    expect(atRoomChange[0].url).toContain("100200");
    expect(atRoomChange[0].state).toBe("staged");
    expect(atRoomChange[0].refs).toEqual([]);
    // The other half — the new room's driver uploading it again under the new
    // code — is preupload.test.ts's "re-uploads into the new room a file the old
    // room had already finished"; it cannot be shown here, where App is absent
    // and this instance's roomCode prop therefore never changes.
  });

  it("explains an expired pre-upload even after the card has flipped to expired", async () => {
    // The 410 lands after the on-screen countdown (which runs from the mint) has
    // already given up, so this line has to live outside the waiting branch or
    // the user never sees why their upload bought nothing.
    const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
    let received = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.startsWith("/api/uploads?")) return json({ uploadId: "u1", chunkSize: 1024 });
      if (url.endsWith("/finalize")) return json({}, 410);
      if (method === "PATCH") {
        received += new Uint8Array(await (init!.body as Blob).arrayBuffer?.() ?? (init!.body as Uint8Array)).length;
        return json({ received });
      }
      return json({ received });
    }));
    setOutbox([{ file: new File(["x"], "a.bin", { lastModified: 0 }) }]);
    await startPreupload("483920", true);
    expect(outboxState(0)).toBe("staged"); // back on the live link

    render({ roomCode: "483920", expired: true });
    expect(target.textContent).toContain(messages.en.pair.preuploadExpired);
  });
});

// ── the countdown, once the deadline moves ──────────────────────────────────
//
// The card used to read the mint's expiry once and count it down to "expired,
// generate a new one". Pre-upload makes that a claim the client is not entitled
// to: the room — and with it the code — stays joinable for five minutes after
// the last byte the SERVER committed, so a long upload outlives the mint's
// window and a finalize hands back exactly where the new one ends.
//
// Driven through the real driver against a fake server, not by poking state:
// what has to be shown is that the card WAKES on an upload and on the deadline
// it earns, and a hand-set store proves nothing about that.
describe("the countdown under a moving deadline", () => {
  const CODE = "483920";
  const NOW = () => Math.floor(Date.now() / 1000);
  const ttl = () => target.querySelector<HTMLElement>(".ttl")?.textContent ?? "";
  const isDead = () => (target.textContent ?? "").includes(messages.en.pair.expired);
  /** The countdown's own m:ss, in seconds, or -1 when no number is on screen. */
  const secondsShown = () => {
    const m = /(\d+):(\d\d)/.exec(ttl());
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const file = (name: string) => ({ file: new File(["x"], name, { lastModified: 0 }) });
  /** A file whose ciphertext needs more than one PATCH, so a test can move the
   *  queue while its bytes are genuinely still going up. */
  const bigFile = (name: string) => ({ file: new File([new Uint8Array(300 * 1024)], name, { lastModified: 0 }) });

  /**
   * A pair-room server that answers finalize with the deadline the room is now
   * on. `holdPatch` never answers the first chunk, which is how a test keeps an
   * upload genuinely in flight for as long as it needs it.
   */
  function fakeServer(opts: {
    holdPatch?: boolean;
    expiry?: (n: number) => number;
    goneAt?: number;
    /** What each PATCH ack reports as the room's join deadline (undefined = a
     *  server too old to answer, or an ordinary upload). */
    patchExpiry?: (n: number) => number | undefined;
    /** Answer PATCHes with this status instead of committing — an answer that
     *  says nothing about the room, which the append path really can give after
     *  committing bytes and extending it in the same transaction. */
    patchStatus?: number;
    /** Answer finalize with this status. Unlike `goneAt`'s 410 it is NOT an
     *  answer about the room, so what the appends already reported stands. */
    finalizeStatus?: number;
    /** Called on every PATCH, so a test can move the queue mid-upload. */
    onPatch?: (n: number) => void;
    /** Hold the Nth PATCH and every one after it in flight, so a LATER file's
     *  upload can be kept running while the card is inspected. */
    holdPatchFrom?: number;
    /** Called on the Nth init (1-based) and AWAITED, so a test can hold an
     *  upload before it reports any progress — the only window in which nothing
     *  is in flight and the card is speaking for the room on its own. */
    onInit?: (n: number) => void | Promise<void>;
  } = {}) {
    const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
    const state = { sessions: 0, finalized: 0, patches: 0 };
    let received = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.startsWith("/api/uploads?")) {
        received = 0;
        await opts.onInit?.(++state.sessions);
        return json({ uploadId: `u${state.sessions}`, chunkSize: 1024 });
      }
      if (url.endsWith("/finalize")) {
        state.finalized++;
        // The room ended under this upload — the one refusal with a consequence
        // the user can see.
        if (state.finalized === opts.goneAt) return json({}, 410);
        if (opts.finalizeStatus) return json({}, opts.finalizeStatus);
        return json({ id: `obj${state.finalized}`, expiresAt: opts.expiry?.(state.finalized) ?? 123 });
      }
      if (method === "PATCH") {
        // In flight, and staying there — until the signal says otherwise, which
        // is what a real fetch does and what lets the driver be torn down.
        if (opts.holdPatch) {
          await new Promise((_, reject) => {
            init!.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        state.patches++;
        opts.onPatch?.(state.patches);
        if (opts.holdPatchFrom && state.patches >= opts.holdPatchFrom) {
          await new Promise((_, reject) => {
            init!.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        if (opts.patchStatus) return json({}, opts.patchStatus);
        received += new Uint8Array(await (init!.body as Blob).arrayBuffer?.() ?? (init!.body as Uint8Array)).length;
        const ack: Record<string, unknown> = { received };
        const exp = opts.patchExpiry?.(state.patches);
        if (exp !== undefined) ack.expiresAt = exp;
        return json(ack);
      }
      return json({ received });
    }));
    return state;
  }

  beforeEach(() => resetPreupload());
  afterEach(() => {
    vi.useRealTimers();
    resetPreupload();
    clearOutbox();
    vi.unstubAllGlobals();
  });

  // The control, and the behaviour that must survive every case below: with no
  // pre-upload in the picture at all, the mint's window is still the whole
  // story. A "never give up" fix passes every other case in this describe and
  // fails this one.
  it("counts a mint-only room down and gives up exactly as it always did", () => {
    vi.useFakeTimers();
    sessionStorage.setItem(EXP_KEY, String(NOW() + 3));
    render({ roomCode: CODE });

    expect(ttl()).toBe(messages.en.pair.expiresIn("0:03"));
    vi.advanceTimersByTime(2000);
    flushSync();
    expect(ttl()).toBe(messages.en.pair.expiresIn("0:01"));
    expect(isDead()).toBe(false);

    vi.advanceTimersByTime(2000);
    flushSync();
    expect(isDead()).toBe(true);
    expect(ttl()).toBe("");
  });

  it("does not call the code dead while its own upload is holding it open", async () => {
    // The mint's five minutes are gone. The room's are not: bytes are being
    // committed against it right now, and each one pushes its deadline out.
    fakeServer({ holdPatch: true });
    setOutbox([file("a.bin")]);
    sessionStorage.setItem(EXP_KEY, String(NOW() - 1));
    render({ roomCode: CODE });

    await until(() => { flushSync(); return preuploadProgress() !== null; });
    expect(isDead()).toBe(false);
    expect(target.textContent).toContain(CODE); // still the code to pass on
    // No number, because there is none to know: the client is told where the
    // window landed only when the upload finishes.
    expect(ttl()).toBe(messages.en.pair.ttlUploading);
    expect(secondsShown()).toBe(-1);
  });

  it("still gives up when the same lapsed room is uploading nothing", async () => {
    // The other half of the case above, and the one that keeps it honest: a
    // staged batch is not a reason to hold the card open — bytes moving are. The
    // deployment refuses pre-upload here (503), so nothing is ever in flight.
    const refused = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal("fetch", refused);
    setOutbox([file("a.bin")]);
    sessionStorage.setItem(EXP_KEY, String(NOW() - 1));
    render({ roomCode: CODE });

    await until(() => { flushSync(); return refused.mock.calls.length > 0; });
    await until(() => { flushSync(); return isDead(); });
    expect(ttl()).toBe("");
  });

  it("counts from the deadline the server returned, and from each later one", async () => {
    const base = NOW();
    fakeServer({ expiry: (n) => base + (n === 1 ? 300 : 900) });
    setOutbox([file("a.bin")]);
    sessionStorage.setItem(EXP_KEY, String(base - 1)); // the mint's window is long gone
    render({ roomCode: CODE });

    await until(() => { flushSync(); return outboxState(0) === "uploaded"; });
    // The card is alive again on the server's own answer, not on anything this
    // page decided, and it counts down from there.
    expect(isDead()).toBe(false);
    expect(secondsShown()).toBeGreaterThan(290);
    expect(secondsShown()).toBeLessThanOrEqual(300);

    // A file staged afterwards uploads too, and its finalize moves the same
    // countdown out again — the deadline follows the last byte, not the first.
    addToOutbox([file("b.bin")]);
    flushSync();
    await until(() => { flushSync(); return outboxState(1) === "uploaded"; });
    expect(secondsShown()).toBeGreaterThan(890);
  });

  it("takes the server's 410 over the window an earlier upload had bought", async () => {
    // The authoritative end of the room, arriving while the card is counting
    // down a perfectly good fifteen minutes the first file earned. The 410 wins:
    // the code is dead, the files are back on the live link, and the one line
    // that explains why is on screen.
    const base = NOW();
    fakeServer({ expiry: () => base + 900, goneAt: 2 });
    setOutbox([file("a.bin")]);
    sessionStorage.setItem(EXP_KEY, String(base - 1));
    render({ roomCode: CODE });
    await until(() => { flushSync(); return outboxState(0) === "uploaded"; });
    expect(secondsShown()).toBeGreaterThan(890);

    addToOutbox([file("b.bin")]);
    flushSync();
    await until(() => { flushSync(); return isDead(); });
    expect(target.textContent).toContain(messages.en.pair.preuploadExpired);
    expect(secondsShown()).toBe(-1);
  });

  it("never lets the server's answer shorten a window the mint already promised", async () => {
    // The code's own registry entry is moved FORWARD to the room's join
    // deadline and never back (§2, "forward only, never a resurrection"), so an
    // answer that lands behind the mint's five minutes — a clock skew, a
    // response served late — takes nothing away. The later of the two is the
    // one the server will actually honour.
    const base = NOW();
    fakeServer({ expiry: () => base + 60 });
    setOutbox([file("a.bin")]);
    sessionStorage.setItem(EXP_KEY, String(base + 300));
    render({ roomCode: CODE });

    await until(() => { flushSync(); return outboxState(0) === "uploaded"; });
    expect(secondsShown()).toBeGreaterThan(290);
  });

  // ── the failure that has no answer at all ────────────────────────────────
  //
  // THE release blocker. An append may have committed bytes — extending the room
  // and the code with it — and then had its answer, and the resume probe behind
  // it, both lost. Falling back to the mint here does not "understate": it
  // announces a dead code the server is still admitting joins on, and puts a
  // button under it offering to burn that rendezvous and mint another.
  it("will not call the code dead after an upload whose answer never came back", async () => {
    // Bytes went out; every response about them was a 500, which is an answer
    // about the request and none at all about the room.
    const server = fakeServer({ patchStatus: 500 });
    setOutbox([file("a.bin")]);
    const mintUntil = NOW() + 2;
    sessionStorage.setItem(EXP_KEY, String(mintUntil)); // and now the mint lapses
    render({ roomCode: CODE });
    const uploadTried = () => server.patches > 0;

    // The upload gives up (the file goes back to the live link), and then the
    // mint's own window lapses under a card that has nothing else to go on.
    await until(() => { flushSync(); return uploadTried() && outboxState(0) === "staged"; });
    await until(() => { flushSync(); return NOW() > mintUntil; });
    await new Promise((r) => setTimeout(r, 1200)); // a full tick past it
    flushSync();

    expect(isDead(), "the card must not announce an expiry it was never told about").toBe(false);
    expect(target.textContent).toContain(CODE); // still six digits to pass on
    expect(ttl()).toBe(messages.en.pair.ttlUnknown);
    expect(secondsShown(), "no invented number either").toBe(-1);
    // A truthful choice, not a claim: try it over there, or make a new one.
    expect(target.textContent).toContain(messages.en.pair.ttlUnknownNote);
    expect(target.textContent).toContain(messages.en.pair.sendCode);
    // And it may not silently promise the code is fine.
    expect(target.textContent).not.toContain(messages.en.pair.ttlUploading);
  });

  it("still lets the server's 410 end an unconfirmed room", async () => {
    // Doubt is about missing evidence. When the evidence arrives, it wins — the
    // room is over, its ciphertext is gone, and a card that stayed vague would
    // go on offering a rendezvous the server has emptied.
    //
    // The doubt is made by removing the first file while its bytes are going up:
    // its request is abandoned mid-flight (so what the server did with it is
    // unknown) and, unlike every other failure, the driver keeps going — which
    // is what lets the NEXT file be the one that hears the 410.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    fakeServer({
      // a.bin's own request is abandoned mid-flight (the user removed the file),
      // so what the server did with its bytes is unknown — and unlike every
      // other failure the driver keeps going, which is what lets b.bin be the
      // one that hears the 410. b.bin's append is held so the card can be read
      // while the room is in exactly that state.
      onPatch: (n) => { if (n === 1) removeFromOutbox(0); },
      // b.bin is held at INIT, before it reports any progress: the one window in
      // which nothing is in flight, so the card has to speak for the room on the
      // strength of what it knows — which is nothing it can confirm.
      onInit: (n) => (n === 2 ? held : undefined),
      goneAt: 1,
    });
    setOutbox([bigFile("a.bin"), file("b.bin")]);
    sessionStorage.setItem(EXP_KEY, String(NOW() - 1));
    render({ roomCode: CODE });
    await until(() => { flushSync(); return ttl() === messages.en.pair.ttlUnknown; });
    expect(isDead()).toBe(false);

    release();
    await until(() => { flushSync(); return isDead(); });
    expect(target.textContent).toContain(messages.en.pair.preuploadExpired);
    expect(ttl()).toBe("");
    expect(target.textContent).not.toContain(messages.en.pair.ttlUnknownNote);
  });

  it("does not say the window is unconfirmable while a later file is uploading", async () => {
    // Doubt about an earlier attempt is real, but it is not what the card should
    // be saying while bytes are committing RIGHT NOW: those bytes push the room
    // (and the code) out again whatever the earlier one failed to report. Two
    // answers to one question is worse than the vaguer of them alone.
    fakeServer({ onPatch: (n) => { if (n === 1) removeFromOutbox(0); }, holdPatchFrom: 2 });
    setOutbox([bigFile("a.bin"), file("b.bin")]);
    sessionStorage.setItem(EXP_KEY, String(NOW() - 1));
    render({ roomCode: CODE });

    // The state this is about: a.bin's abandoned attempt has left the room in
    // doubt, and b.bin's append is in flight and staying there.
    await until(() => {
      flushSync();
      return preuploadUnconfirmed() === CODE && preuploadProgress()?.token === outboxToken(0);
    });
    expect(ttl()).toBe(messages.en.pair.ttlUploading);
    expect(target.textContent).not.toContain(messages.en.pair.ttlUnknown);
    expect(target.textContent).not.toContain(messages.en.pair.ttlUnknownNote);
    expect(isDead()).toBe(false);
  });

  it("counts a mid-upload failure to the deadline it was acknowledged, never the mint", async () => {
    // An append DID answer, with the window it had just bought. The upload then
    // failed. That acknowledged instant is what the countdown runs to — the
    // mint's window is behind it and was never the truth once bytes landed.
    const base = NOW();
    fakeServer({ patchExpiry: () => base + 900, finalizeStatus: 500 });
    setOutbox([file("a.bin")]);
    sessionStorage.setItem(EXP_KEY, String(base - 1));
    render({ roomCode: CODE });

    await until(() => { flushSync(); return secondsShown() > 0; });
    expect(secondsShown()).toBeGreaterThan(890);
    expect(isDead()).toBe(false);
  });

  it("does not flash a dead mint between two files of one batch", async () => {
    // Between files nothing is in flight, so the "an upload is running" branch
    // is off for a round trip. With the room's own deadline recorded from the
    // first file's appends there is a real, later number to show in that gap —
    // the card must not fall back to the mint's lapsed window for even one tick.
    const base = NOW();
    const dead: boolean[] = [];
    fakeServer({ patchExpiry: () => base + 900 });
    setOutbox([file("a.bin"), file("b.bin")]);
    sessionStorage.setItem(EXP_KEY, String(base - 1)); // the mint is already gone
    render({ roomCode: CODE });

    await until(() => {
      flushSync();
      if (outboxState(0) === "uploaded" || outboxState(1) === "uploaded") dead.push(isDead());
      return outboxState(0) === "uploaded" && outboxState(1) === "uploaded";
    });
    flushSync();
    expect(dead.some(Boolean), "the card flashed the expired state between files").toBe(false);
    expect(secondsShown()).toBeGreaterThan(890);
  });

  it("never counts one room's card down on a deadline another room earned", async () => {
    // Room A really is joinable for another fifteen minutes. Room B is a
    // different rendezvous with its own dead mint, and nothing room A did can
    // speak for it. Nothing is staged in B, so no driver runs there to clear
    // the record — which is exactly when this has to be decided by the card.
    const base = NOW();
    fakeServer({ expiry: () => base + 900 });
    setOutbox([file("a.bin")]);
    sessionStorage.setItem(EXP_KEY, String(base - 1));
    render({ roomCode: CODE });
    await until(() => { flushSync(); return outboxState(0) === "uploaded"; });
    expect(isDead()).toBe(false);

    unmount(app!);
    app = undefined;
    target.innerHTML = "";
    clearOutbox();
    sessionStorage.setItem(EXP_KEY, String(base - 1));
    render({ roomCode: "100200" });

    expect(isDead()).toBe(true);
  });
});
