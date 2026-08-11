import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import CodePairing from "./CodePairing.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import { clearOutbox, setOutbox, outbox } from "./outbox.svelte";
import { resetPreupload } from "./preupload.svelte";
import { currentRoute } from "./router.svelte";
import { reactiveProps } from "./reactive-props.svelte";
import { PAIR_TRAFFIC_SPENT } from "./transfer-link";
import { roomCode as activeRoom, enterRoom } from "./room.svelte";

// B3 on the choose screen: what a signed-in sender sees when this month's
// cross-network allowance is gone.
//
// The screen's job is to stop offering an action that cannot succeed, and to be
// truthful about what is left. Two things are still possible and both must stay
// reachable: RECEIVING somebody else's code (the receiver is anonymous and the
// bytes are billed to the other side), and LAN (no Relayium traffic at all).
// What is NOT possible is the stored/async path, which draws on the same meter —
// so this surface must never point at it.
//
// The preflight behind it is ADVISORY. It fails open on every error, and the
// authoritative answer is the POST's, which is why the last cases here are about
// what happens when the two disagree.

const EXP_KEY = "relayium_pair_exp";

let target: HTMLDivElement;
let app: unknown;

const USER = { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true };

beforeEach(async () => {
  await loadLang("en");
  clearOutbox();
  resetPreupload();
  sessionStorage.clear();
  target = document.createElement("div");
  document.body.appendChild(target);
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
  clearOutbox();
  resetPreupload();
  enterRoom({}); // the module-level room is global state; a stale one leaks
  sessionStorage.clear();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

/** A deferred whose resolution the test controls, so "the answer has not come
 *  back yet" is a state rather than a sleep. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type ServerOpts = {
  /** What GET /api/pair/preflight answers. A promise lets a test hold it open. */
  preflight?: () => unknown | Promise<unknown>;
  /** What POST /api/pair answers. Defaults to a successful mint. */
  pair?: () => unknown | Promise<unknown>;
  user?: typeof USER | null;
};

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Signs in (or not) and stubs the two endpoints this screen touches. Returns
 *  the fetch mock so a test can assert what was NOT called. */
async function serve(opts: ServerOpts = {}) {
  const user = opts.user === undefined ? USER : opts.user;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/me") {
      return user ? json({ user }) : json({}, 401);
    }
    if (url === "/api/pair/preflight") {
      return opts.preflight ? await opts.preflight() : json({ allowed: true });
    }
    if (url === "/api/pair") {
      return opts.pair ? await opts.pair() : json({ code: "483920", expiresAt: 9e9 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  await refreshSession();
  return fetchMock;
}

function render(props: Record<string, unknown> = {}) {
  const p = reactiveProps(props);
  app = mount(CodePairing, { target, props: p });
  flushSync();
  return p;
}

/** Drain the microtask/macrotask turns a fetch answer needs, then settle the
 *  render. Deterministic: every promise in play is already resolved or is one
 *  the test resolves itself. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

const blockedCopy = () => target.querySelector(".traffic-blocked");
const mintButton = () => target.querySelector<HTMLButtonElement>(".create-code");
const upgradeButton = () => target.querySelector<HTMLButtonElement>(".upgrade-plan");
const lanButton = () => target.querySelector<HTMLButtonElement>(".lan-fallback");
const buttonLabels = () =>
  [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());

const spent = () => json({ allowed: false, reason: PAIR_TRAFFIC_SPENT });

describe("the choose screen when the monthly allowance is spent", () => {
  it("replaces the create-code action before it can be clicked", async () => {
    await serve({ preflight: spent });
    render();
    await settle();

    expect(mintButton(), "the mint action must be gone, not merely disabled").toBeNull();
    expect(blockedCopy()?.textContent).toBe(messages.en.pair.trafficBlocked);
  });

  // The half that must not be collateral damage. The receiver is anonymous and
  // the transfer is billed to whoever minted the code, so an account with no
  // allowance left can still be given six digits and still receive.
  it("still lets this account enter someone else's code", async () => {
    await serve({ preflight: spent });
    render();
    await settle();

    expect(buttonLabels()).toContain(messages.en.pair.enterCode);
    (
      [...target.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === messages.en.pair.enterCode,
      ) as HTMLButtonElement
    ).click();
    flushSync();
    expect(target.querySelector('input[inputmode="numeric"]')).not.toBeNull();
  });

  it("offers an upgrade that goes to pricing", async () => {
    await serve({ preflight: spent });
    render();
    await settle();

    expect(upgradeButton()?.textContent?.trim()).toBe(messages.en.quota.upgrade);
    upgradeButton()!.click();
    flushSync();
    expect(currentRoute()).toBe("pricing");
  });

  // The route out that actually works. LAN moves no bytes through Relayium, so
  // it is unaffected by the meter — and it is the only fallback this screen may
  // offer, because the stored/async path draws on the same allowance.
  it("offers LAN as the way through, and goes there", async () => {
    await serve({ preflight: spent });
    render();
    await settle();

    expect(lanButton()?.textContent?.trim()).toBe(messages.en.pair.trafficBlockedLan);
    lanButton()!.click();
    flushSync();
    expect(currentRoute()).toBe("lan");
  });

  it("asks nothing about an anonymous visitor's account", async () => {
    const fetchMock = await serve({ user: null, preflight: spent });
    render();
    await settle();

    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain("/api/pair/preflight");
    expect(blockedCopy()).toBeNull();
  });
});

describe("the create-code action itself", () => {
  // Its whole label, and only once. A duplicated icon or a doubled expression
  // inside the button renders as "Send codeSend code" and still satisfies every
  // "the button exists" assertion in this file, so the shape is pinned here:
  // exactly the localized string, exactly one decorative icon beside it.
  it("reads exactly the localized label, once", async () => {
    await serve();
    render();
    await settle();

    const btn = mintButton();
    expect(btn?.textContent?.trim()).toBe(messages.en.pair.sendCode);
    expect(btn?.querySelectorAll("svg"),
      "one decorative icon; a second is duplicated markup").toHaveLength(1);
  });
});

describe("a late MINT answer is discarded", () => {
  // The preflight guard's counterpart, on the request that actually does
  // something. The POST is authoritative and slow enough to outlive the screen
  // that sent it: sign-out does not unmount this card, a join link can put a room
  // on it, and the user can move to code entry while the mint is still in flight.
  //
  // A successful stale mint cannot be unminted — the code exists and is left to
  // expire. What it must not do is land: no mint marker, no room, no reset of a
  // queue it never staged.

  /** Clicks the mint button against a POST the test resolves by hand. */
  async function clickMintWith(pair: () => Promise<unknown>) {
    const fetchMock = await serve({ preflight: () => json({ allowed: true }), pair });
    render();
    await settle();
    mintButton()!.click();
    await settle();
    return fetchMock;
  }

  /** Replaces the signed-in account underneath a pending request. */
  async function switchAccountTo(user: typeof USER | null) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return user ? json({ user }) : json({}, 401);
      if (url === "/api/pair/preflight") return json({ allowed: true });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await refreshSession();
    await settle();
  }

  it("cannot enter a room for an account that has since signed out", async () => {
    const held = deferred<unknown>();
    await clickMintWith(() => held.promise);

    await switchAccountTo(null);
    held.resolve(json({ code: "483920", expiresAt: 9e9 }));
    await settle();

    expect(activeRoom(), "the signed-out screen was pulled into the old account's room").toBe("");
    expect(location.hash).not.toContain("483920");
    expect(sessionStorage.getItem(EXP_KEY),
      "a mint marker was written for a code nobody was shown").toBeNull();
    expect(target.querySelector(".signin"),
      "the signed-out screen must still be the signed-out screen").not.toBeNull();
  });

  it("cannot overwrite the mint marker of a room entered while it was in flight", async () => {
    const held = deferred<unknown>();
    const ownExpiry = String(Math.floor(Date.now() / 1000) + 300);
    sessionStorage.setItem(EXP_KEY, ownExpiry);
    const fetchMock = await serve({
      preflight: () => json({ allowed: true }),
      pair: () => held.promise,
    });
    const props = render();
    await settle();
    mintButton()!.click();
    await settle();

    // A join link opens (or the peer's code lands) while the POST is out.
    props.roomCode = "111111";
    flushSync();
    setOutbox([{ file: new File(["x"], "report.pdf", { lastModified: 0 }) }]);

    held.resolve(json({ code: "483920", expiresAt: 9e9 }));
    await settle();

    expect(fetchMock.mock.calls.filter(([u]) => u === "/api/pair"),
      "the mint did happen; it is the landing that is refused").toHaveLength(1);
    expect(sessionStorage.getItem(EXP_KEY),
      "the current room's countdown was overwritten by a code it knows nothing about").toBe(ownExpiry);
    expect(activeRoom(), "the user was yanked out of the room they are in").toBe("");
    expect(target.querySelector(".code")?.textContent).toBe("111111");
    expect(outbox().map((p) => p.file.name),
      "a batch staged for the current room was reset by the stale mint").toEqual(["report.pdf"]);
  });

  it("cannot enter a room after the screen has moved to code entry", async () => {
    const held = deferred<unknown>();
    await clickMintWith(() => held.promise);

    (
      [...target.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === messages.en.pair.enterCode,
      ) as HTMLButtonElement
    ).click();
    flushSync();

    held.resolve(json({ code: "483920", expiresAt: 9e9 }));
    await settle();

    expect(activeRoom()).toBe("");
    expect(sessionStorage.getItem(EXP_KEY)).toBeNull();
    expect(target.querySelector('input[inputmode="numeric"]'),
      "the code the user is typing was replaced by a minted room").not.toBeNull();
  });

  // The refusal half. It is a fact about one account's allowance; applied to the
  // next account it takes away an action that account can still perform.
  it("cannot block the account that signed in after it", async () => {
    const held = deferred<unknown>();
    await clickMintWith(() => held.promise);

    await switchAccountTo({ ...USER, id: "u2", email: "b@b.c" });
    held.resolve(json({ error: PAIR_TRAFFIC_SPENT }, 429));
    await settle();

    expect(blockedCopy(), "the first account's refusal blocked the second").toBeNull();
    expect(mintButton()).not.toBeNull();
  });

  // And a plain failure must not take the new screen's error line or its queue.
  it("cannot fail a screen it is not about, or clear its staged batch", async () => {
    const held = deferred<unknown>();
    await clickMintWith(() => held.promise);

    await switchAccountTo({ ...USER, id: "u2", email: "b@b.c" });
    setOutbox([{ file: new File(["x"], "report.pdf", { lastModified: 0 }) }]);
    held.resolve(json("server exploded", 500));
    await settle();

    expect(target.querySelector(".error"),
      "the previous account's mint failure was reported to this one").toBeNull();
    expect(outbox().map((p) => p.file.name)).toEqual(["report.pdf"]);
    expect(mintButton()?.disabled,
      "the button must not be left spinning for the account that inherited it").toBe(false);
  });

  // The fourth boundary, and the one with no screen left to be wrong about: the
  // card is gone, but enterRoom and the mint marker are page-global, so a landing
  // here would rewrite the URL under whatever replaced it.
  it("cannot enter a room after the card has been torn down", async () => {
    const held = deferred<unknown>();
    await clickMintWith(() => held.promise);

    unmount(app!);
    app = undefined;

    held.resolve(json({ code: "483920", expiresAt: 9e9 }));
    await settle();

    expect(activeRoom()).toBe("");
    expect(location.hash).not.toContain("483920");
    expect(sessionStorage.getItem(EXP_KEY)).toBeNull();
  });

  // The same tear-down, from the one screen that asks no preflight at all: a
  // lapsed room, where the only action left is re-minting. Nothing stamps a
  // generation here except the effect's exit, so this is the case that decides
  // whether that exit is registered on every path or only on the asking one.
  it("cannot enter a room after a lapsed room's re-mint outlived the card", async () => {
    const held = deferred<unknown>();
    const lapsed = String(Math.floor(Date.now() / 1000) - 10);
    sessionStorage.setItem(EXP_KEY, lapsed);
    await serve({ pair: () => held.promise });
    render({ roomCode: "483920" });
    await settle();

    const remint = [...target.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === messages.en.pair.sendCode,
    ) as HTMLButtonElement;
    expect(remint, "the lapsed room must still offer a re-mint").toBeTruthy();
    remint.click();
    await settle();

    unmount(app!);
    app = undefined;

    held.resolve(json({ code: "111111", expiresAt: 9e9 }));
    await settle();

    expect(activeRoom(), "a torn-down card walked the page into a room").toBe("");
    expect(sessionStorage.getItem(EXP_KEY)).toBe(lapsed);
  });

  // The guard must be about identity, not about churn. Refreshing the session
  // returns a NEW object for the SAME account several times on this page (the
  // nav polls it), and a mint dropped by one of those would be a click that
  // silently did nothing.
  it("still lands when the session is refreshed for the same account", async () => {
    const held = deferred<unknown>();
    await clickMintWith(() => held.promise);

    await refreshSession(); // same user, fresh object
    await settle();

    held.resolve(json({ code: "483920", expiresAt: 9e9 }));
    await settle();

    expect(activeRoom(), "a same-account refresh threw away a good mint").toBe("483920");
    expect(sessionStorage.getItem(EXP_KEY)).toBe(String(9e9));
  });
});

describe("the preflight is advisory, never a blocker in its own right", () => {
  // A preflight that could not be read must leave the button exactly where it
  // was. The gate is the POST; a screen that refused on its own would turn one
  // network blip into "you cannot send anything".
  it("keeps the mint action when the preflight fails", async () => {
    const fetchMock = await serve({
      preflight: () => { throw new TypeError("offline"); },
    });
    render();
    await settle();

    expect(blockedCopy()).toBeNull();
    expect(mintButton()).not.toBeNull();
    mintButton()!.click();
    await settle();
    expect(fetchMock.mock.calls.filter(([u]) => u === "/api/pair")).toHaveLength(1);
  });

  // Clicked before the advisory answer arrived. The click waits for the answer
  // that is already in flight rather than firing a mint the screen is about to
  // say is impossible — and when that answer is a block, no POST is sent.
  it("a click while the answer is still in flight waits for it", async () => {
    const held = deferred<unknown>();
    const fetchMock = await serve({ preflight: () => held.promise });
    render();
    await settle();

    // Still offering the action: nothing is known yet, and a spinner-locked
    // screen on every render would be worse than the occasional wasted click.
    expect(mintButton()).not.toBeNull();
    mintButton()!.click();
    await settle();
    expect(fetchMock.mock.calls.filter(([u]) => u === "/api/pair"),
      "the mint must not have been sent while the answer was pending").toHaveLength(0);

    held.resolve(json({ allowed: false, reason: PAIR_TRAFFIC_SPENT }));
    await settle();

    expect(fetchMock.mock.calls.filter(([u]) => u === "/api/pair")).toHaveLength(0);
    expect(blockedCopy()).not.toBeNull();
  });
});

describe("when the POST disagrees with the preflight", () => {
  // The race the preflight cannot close: the allowance is spent between the
  // advisory answer and the click (another device, a download, a relay session).
  // The authoritative refusal must land on the SAME surface as the advisory one
  // — not on a generic "couldn't create a code" — and it must not throw the
  // staged batch away, which is the user's work and is still sendable over LAN.
  it("shows the blocked surface and keeps the staged queue", async () => {
    const fetchMock = await serve({
      preflight: () => json({ allowed: true }),
      pair: () => json({ error: PAIR_TRAFFIC_SPENT }, 429),
    });
    setOutbox([{ file: new File(["x"], "report.pdf", { lastModified: 0 }) }]);
    render();
    await settle();

    expect(mintButton()).not.toBeNull();
    mintButton()!.click();
    await settle();

    expect(fetchMock.mock.calls.filter(([u]) => u === "/api/pair")).toHaveLength(1);
    expect(blockedCopy()?.textContent).toBe(messages.en.pair.trafficBlocked);
    expect(target.querySelector(".error"),
      "a quota refusal is not a mint failure and must not read as one").toBeNull();
    expect(outbox().map((p) => p.file.name),
      "the staged batch is the user's work and is still sendable over LAN").toEqual(["report.pdf"]);
  });

  // Any OTHER refusal is still the ordinary mint failure it always was. The
  // per-IP rate limiter answers 429 too, and it means "try again in a moment",
  // not "upgrade or use LAN".
  it("leaves an unrelated 429 as a plain mint failure", async () => {
    await serve({
      preflight: () => json({ allowed: true }),
      pair: () => json("too many pairing requests", 429),
    });
    render();
    await settle();

    mintButton()!.click();
    await settle();

    expect(blockedCopy()).toBeNull();
    expect(target.querySelector(".error")?.textContent).toBe(messages.en.pair.mintFailed);
  });
});

describe("a late preflight answer is discarded", () => {
  // It is an answer about an account. Sessions end and change on this very page
  // (the nav's sign-out does not unmount this component), so an answer that
  // resolves after the account has, is about somebody who is no longer here.
  it("cannot block the account that signed in after it", async () => {
    const held = deferred<unknown>();
    await serve({ preflight: () => held.promise });
    render();
    await settle();

    // A different account takes over the page mid-flight.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return json({ user: { ...USER, id: "u2", email: "b@b.c" } });
      if (url === "/api/pair/preflight") return json({ allowed: true });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await refreshSession();
    await settle();

    held.resolve(json({ allowed: false, reason: PAIR_TRAFFIC_SPENT }));
    await settle();

    expect(blockedCopy(), "the first account's verdict was applied to the second").toBeNull();
    expect(mintButton()).not.toBeNull();
  });

  // And it is an answer about the CHOOSE screen. Once this instance is showing a
  // room — a join link opened, a code entered, a mint that landed — the blocked
  // surface is not a thing that may appear over it.
  it("cannot block a room this screen has since entered", async () => {
    const held = deferred<unknown>();
    await serve({ preflight: () => held.promise });
    // The mint marker is read once, at init — this instance is the minting
    // device from the start; what changes underneath the pending answer is which
    // room it is showing.
    sessionStorage.setItem(EXP_KEY, String(Math.floor(Date.now() / 1000) + 300));
    const props = render();
    await settle();

    props.roomCode = "483920";
    flushSync();

    held.resolve(json({ allowed: false, reason: PAIR_TRAFFIC_SPENT }));
    await settle();

    expect(blockedCopy()).toBeNull();
    expect(target.querySelector(".code")?.textContent).toBe("483920");
  });

  // Switching to the code-entry view and back must not resurrect a verdict from
  // before: the same guard, on the third thing that changes underneath a pending
  // request.
  it("cannot block after the screen has moved to code entry", async () => {
    const held = deferred<unknown>();
    await serve({ preflight: () => held.promise });
    render();
    await settle();

    (
      [...target.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === messages.en.pair.enterCode,
      ) as HTMLButtonElement
    ).click();
    flushSync();

    held.resolve(json({ allowed: false, reason: PAIR_TRAFFIC_SPENT }));
    await settle();

    expect(blockedCopy()).toBeNull();
    expect(target.querySelector('input[inputmode="numeric"]')).not.toBeNull();
  });
});
