// web/src/lib/PairRoomStorage.test.ts — the /me surface for pair-room storage.
//
// What this component is for: a joined pairing transfer leaves encrypted copies
// on the server with NO expiry, so an account can be charged for storage it can
// neither see nor remove. The section makes it visible and gives it one
// deliberate, destructive control.
//
// The properties pinned here are the ones whose loss is silent:
//
//   * nothing is ever released without an explicit confirmation, and DISMISSING
//     the dialog releases nothing and changes nothing on screen;
//   * a refusal (409) does not optimistically subtract — the row and its bytes
//     stay exactly as the server last described them;
//   * a success re-reads the server rather than editing the list locally, and
//     invalidates the shared usage cache so the storage meter above it moves;
//   * a room the SERVER says is not releasable has no working control at all.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import PairRoomStorage from "./PairRoomStorage.svelte";
import { refreshSession } from "./auth.svelte";
import { loadLang } from "./i18n.svelte";
import { invalidateUsage, usageVersion } from "./usage.svelte";
import { confirmState, resolveConfirm } from "./confirm-dialog.svelte";

let targets: HTMLDivElement[] = [];
let apps: unknown[] = [];

const USER = { id: "owner-1", email: "o@example.com", displayName: "O" };

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function room(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "room-abcdef0123",
    createdAt: 1_767_312_000,
    joinedAt: 1_767_312_500,
    objects: 2,
    bytes: 3_000_000,
    releasable: true,
    ...over,
  };
}

function holdings(rooms: unknown[], over: Record<string, unknown> = {}) {
  const list = rooms as { objects: number; bytes: number }[];
  return {
    rooms,
    totals: {
      rooms: rooms.length,
      objects: list.reduce((n, r) => n + r.objects, 0),
      bytes: list.reduce((n, r) => n + r.bytes, 0),
    },
    limit: 200,
    truncated: false,
    ...over,
  };
}

async function setSession(user: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/me") return user ? json({ user }) : json({}, 401);
    throw new Error(`unexpected fetch ${url} during session setup`);
  }) as unknown as typeof fetch);
  await refreshSession();
}

function mountIt(): HTMLDivElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  targets.push(target);
  apps.push(mount(PairRoomStorage, { target }));
  return target;
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

beforeEach(async () => {
  await loadLang("en");
});

afterEach(() => {
  resolveConfirm(false); // never leave a shared dialog open across tests
  for (const app of apps) unmount(app as never);
  for (const target of targets) target.remove();
  apps = [];
  targets = [];
  vi.unstubAllGlobals();
  invalidateUsage();
});

describe("PairRoomStorage — what it shows", () => {
  it("renders nothing at all while loading and for an account with no such storage", async () => {
    await setSession(USER);
    let resolveList!: (v: unknown) => void;
    const pending = new Promise((r) => { resolveList = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/pair-rooms") return pending;
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();
    // Loading: the section's very presence is the message ("you are being
    // charged for storage you cannot see"), so it must not appear on a guess.
    expect(target.querySelector(".pairstore")).toBeNull();

    resolveList(json(holdings([])));
    await settle();
    // Empty: still nothing — and, critically, no release control anywhere.
    expect(target.querySelector(".pairstore")).toBeNull();
    expect(target.querySelector("button")).toBeNull();
  });

  it("does not disguise a failed listing as an empty account and can retry", async () => {
    await setSession(USER);
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/pair-rooms") {
        attempts += 1;
        if (attempts === 1) throw new Error("network down");
        return json(holdings([room()]));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("not changed");
    expect(target.querySelectorAll(".roomlist li").length).toBe(0);

    (target.querySelector("button.retry") as HTMLButtonElement).click();
    await settle();
    expect(attempts).toBe(2);
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelectorAll(".roomlist li").length).toBe(1);
  });

  it("shows the count, the bytes and one release control per transfer", async () => {
    await setSession(USER);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/pair-rooms") return json(holdings([room(), room({ id: "room-99", bytes: 1024, objects: 1 })]));
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();

    expect(target.querySelector(".pairstore")).not.toBeNull();
    expect(target.querySelectorAll(".roomlist li").length).toBe(2);
    expect(target.querySelectorAll("button.rel").length).toBe(2);
    // The copy that makes the section honest is on screen.
    expect(target.textContent).toContain("encrypted");
    expect(target.textContent?.toLowerCase()).toContain("no file names");
    // The opaque room id is shown truncated, and the full id is not a link or a
    // code — there is nothing here to copy and use.
    expect(target.textContent).toContain("#room-abc");
  });

  it("keeps a not-yet-releasable transfer's control disabled and explains why", async () => {
    await setSession(USER);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/pair-rooms") return json(holdings([room({ releasable: false })]));
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();

    const btn = target.querySelector("button.rel") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(target.querySelector(".busy")?.textContent).toBeTruthy();
    // Clicking it anyway (a keyboard/AT path, or a stale DOM) neither opens the
    // dialog nor sends a DELETE.
    btn.click();
    await settle();
    expect(confirmState.open).toBe(false);
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });
});

describe("PairRoomStorage — releasing", () => {
  it("asks first, and dismissing the dialog releases nothing", async () => {
    await setSession(USER);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/pair-rooms") return json(holdings([room()]));
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();
    (target.querySelector("button.rel") as HTMLButtonElement).click();
    await settle();

    // A destructive dialog, carrying the two facts the user needs.
    expect(confirmState.open).toBe(true);
    expect(confirmState.message.toLowerCase()).toContain("cannot be undone");
    expect(confirmState.message.toLowerCase()).toContain("download will fail");
    expect(confirmState.confirmLabel).toBeTruthy();

    resolveConfirm(false); // dismiss
    await settle();

    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    // The list is untouched — a dismissal is not a release and not a refresh.
    expect(target.querySelectorAll(".roomlist li").length).toBe(1);
  });

  it("on success re-reads the server and invalidates the shared usage cache", async () => {
    await setSession(USER);
    let listed = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/pair-rooms") {
        listed += 1;
        return json(holdings(listed === 1 ? [room()] : []));
      }
      if (url.startsWith("/api/pair-rooms/") && init?.method === "DELETE") return json({ status: "ok" });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();
    const before = usageVersion();

    (target.querySelector("button.rel") as HTMLButtonElement).click();
    await settle();
    resolveConfirm(true);
    await settle();

    expect(listed).toBe(2); // re-read, never a local splice
    expect(target.querySelectorAll(".roomlist li").length).toBe(0);
    // The storage meter above this section reads the shared usage cache; without
    // this bump it would go on showing bytes that are gone.
    expect(usageVersion()).toBeGreaterThan(before);
    // The section stays on screen to carry the confirmation, rather than
    // vanishing with the last row and leaving the click unacknowledged.
    expect(target.querySelector(".notice")?.textContent).toBeTruthy();
  });

  it("on a 409 tells the truth and does not optimistically subtract anything", async () => {
    await setSession(USER);
    let listed = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/pair-rooms") {
        listed += 1;
        return json(holdings([room()]));
      }
      if (url.startsWith("/api/pair-rooms/") && init?.method === "DELETE") {
        return json({ error: "pair_room_uploading" }, 409);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();
    (target.querySelector("button.rel") as HTMLButtonElement).click();
    await settle();
    resolveConfirm(true);
    await settle();

    // Still there, with the same bytes: nothing was removed, so nothing may look
    // removed.
    expect(target.querySelectorAll(".roomlist li").length).toBe(1);
    const notice = target.querySelector(".notice") as HTMLElement;
    expect(notice.textContent?.toLowerCase()).toContain("still being uploaded");
    expect(notice.classList.contains("err")).toBe(true);
    expect(listed).toBe(2); // and the truth is re-read from the server
  });

  it("distinguishes the two conflicts, because they mean different things", async () => {
    await setSession(USER);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/pair-rooms") return json(holdings([room()]));
      if (url.startsWith("/api/pair-rooms/") && init?.method === "DELETE") {
        return json({ error: "pair_room_waiting" }, 409);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();
    (target.querySelector("button.rel") as HTMLButtonElement).click();
    await settle();
    resolveConfirm(true);
    await settle();

    expect(target.querySelector(".notice")?.textContent?.toLowerCase()).toContain("nobody has joined");
  });

  it("on a network failure says so and leaves the list alone", async () => {
    await setSession(USER);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/pair-rooms") return json(holdings([room()]));
      if (init?.method === "DELETE") throw new Error("network down");
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();
    (target.querySelector("button.rel") as HTMLButtonElement).click();
    await settle();
    resolveConfirm(true);
    await settle();

    expect(target.querySelectorAll(".roomlist li").length).toBe(1);
    const notice = target.querySelector(".notice") as HTMLElement;
    expect(notice.classList.contains("err")).toBe(true);
    expect(notice.textContent?.toLowerCase()).toContain("nothing was removed");
  });
});

describe("PairRoomStorage — session hygiene and accessibility", () => {
  it("drops another account's rooms when the session changes", async () => {
    let user: unknown = USER;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return user ? json({ user }) : json({}, 401);
      if (url === "/api/pair-rooms") {
        return json(holdings((user as { id: string } | null)?.id === USER.id ? [room()] : []));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await refreshSession();

    const target = mountIt();
    await settle();
    expect(target.querySelectorAll(".roomlist li").length).toBe(1);

    user = null; // sign out; /me does not unmount on logout
    await refreshSession();
    await settle();

    expect(target.querySelector(".pairstore")).toBeNull();
  });

  it("gives every control an accessible name and a live region for its outcome", async () => {
    await setSession(USER);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/pair-rooms") return json(holdings([room()]));
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();

    const btn = target.querySelector("button.rel") as HTMLButtonElement;
    // A bare "Release" repeated down a list names nothing; the accessible name
    // has to say WHICH transfer.
    expect(btn.getAttribute("aria-label")).toContain("room-abc");
    expect(btn.type).toBe("button"); // never a form submit
    // The live region exists BEFORE it has anything to say — inserting one later
    // is not announced.
    const notice = target.querySelector(".notice") as HTMLElement;
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.getAttribute("role")).toBe("status");
    // A heading, so the section is reachable by heading navigation like every
    // other block on /me.
    expect(target.querySelector("h2")?.textContent).toBeTruthy();
  });

  it("says when the list is bounded rather than letting it read as complete", async () => {
    await setSession(USER);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/pair-rooms") {
        return json(holdings([room()], { truncated: true, totals: { rooms: 400, objects: 800, bytes: 9_000_000 } }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    const target = mountIt();
    await settle();

    expect(target.querySelector(".trunc")?.textContent).toBeTruthy();
    // The totals shown are the server's complete ones, not the page's sum.
    expect(target.querySelector(".totals")?.textContent).toContain("400");
  });
});
