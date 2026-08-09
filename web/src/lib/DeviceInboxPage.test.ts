// /device-inbox — the page, as a product surface rather than as an article.
//
// The assertions here are the ones the PRD makes non-negotiable (§8, §10, §12).
// They fall into three groups:
//
//  1. **Six named platforms, honestly badged**, and no invented executable
//     control for a native product that does not exist. A testing/planned native
//     section may show only a separately shipped, explicitly limited fallback.
//  2. **A start block that changes with the account.** Signed out it must offer
//     something that executes; signed in it must say something about THIS
//     account; and a failed /api/devices must not be rendered as either "no
//     devices" or "ready" (WORKFLOW-LEARNINGS 2026-08-09: a failed background
//     refresh must not erase — or invent — trustworthy state).
//  3. **The two boundaries in prose**: uploaded is not saved, and a share link
//     is not permission to write to a disk.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import DeviceInboxPage from "./DeviceInboxPage.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import { loginOpen, loginIntent, setLoginOpen } from "./login.svelte";
import { CAP_RECEIVE_V1, INBOX_KEY_ALGORITHM } from "./device-inbox";
import { REQUIRED_PLATFORM_IDS } from "./device-inbox-platforms";

const ZERO_KEY = "A".repeat(43);
const USER = { id: "u1", email: "owner@example.com", displayName: "Owner", hasPassword: true };

function inbox(over: Record<string, unknown> = {}) {
  return {
    Presence: "online",
    LastHeartbeatAt: 1_700_000_000,
    PresenceExpiresAt: 1_700_000_090,
    HeartbeatIntervalSeconds: 30,
    Capabilities: [CAP_RECEIVE_V1],
    ReceiveCapability: CAP_RECEIVE_V1,
    ProtocolVersion: 1,
    AutoAccept: "auto",
    ReceiveDirReady: true,
    Platform: "linux",
    AppVersion: "0.16.0",
    Revoked: false,
    CanReceive: true,
    RegisteredAt: 1_699_000_000,
    Key: {
      ID: "k1", Algorithm: INBOX_KEY_ALGORITHM, PublicKey: ZERO_KEY,
      Generation: 1, CreatedAt: 1, SupersededAt: 0, RevokedAt: 0,
    },
    ...over,
  };
}

const READY_DEVICE = { ID: "0123456789abcdef0123456789aaa111", Kind: "cli", Inbox: inbox() };
const BARE_DEVICE = { ID: "0123456789abcdef0123456789bbb222", Kind: "cli", Inbox: null };
// Enrolled, but centrally revoked: it must NOT be counted as ready. This is the
// row that a looser "has an Inbox subtree" rule would have called ready.
const REVOKED_DEVICE = { ID: "0123456789abcdef0123456789ccc333", Kind: "cli", Inbox: inbox({ Revoked: true }) };

let currentUser: typeof USER | null = null;
const mounted: { app: Record<string, unknown>; target: HTMLElement }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function render(props: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(DeviceInboxPage, { target, props });
  mounted.push({ app, target });
  flushSync();
  return target;
}

beforeEach(async () => {
  await loadLang("en");
  currentUser = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/me")) {
        return currentUser ? json({ user: currentUser }) : json({}, 401);
      }
      return json({}, 404);
    }),
  );
  await refreshSession();
  setLoginOpen(false);
});

// Unmounting belongs here and not at the end of a test body: a failing assertion
// skips whatever follows it, and a leaked component's session effect then eats
// the next test's stubbed response (WORKFLOW-LEARNINGS, 2026-08-09).
afterEach(async () => {
  for (const m of mounted) {
    unmount(m.app);
    m.target.remove();
  }
  mounted.length = 0;
  currentUser = null;
  await refreshSession();
  setLoginOpen(false);
  vi.unstubAllGlobals();
});

const en = () => messages.en.deviceInboxPage;

describe("the six platform sections", () => {
  it("names every platform the PRD requires, each exactly once", () => {
    const root = render();
    const ids = [...root.querySelectorAll("[data-platform]")].map((e) => e.getAttribute("data-platform"));
    expect(new Set(ids)).toEqual(new Set(REQUIRED_PLATFORM_IDS));
    expect(ids.length).toBe(REQUIRED_PLATFORM_IDS.length);
  });

  it("gives each one an honest status badge and the seven product facts", () => {
    const root = render();
    for (const id of REQUIRED_PLATFORM_IDS) {
      const sec = root.querySelector(`[data-platform="${id}"]`)!;
      expect(sec, id).not.toBeNull();
      expect(["available", "testing", "planned"], id).toContain(sec.getAttribute("data-status"));
      expect(sec.querySelector(".badge")!.textContent, id).toContain("Status:");
      // Use · setup · files · residency · send · recovery · stop.
      expect(sec.querySelectorAll("dt").length, id).toBe(7);
      for (const dd of sec.querySelectorAll("dd")) {
        expect(dd.textContent!.trim().length, `${id} has an empty answer`).toBeGreaterThan(0);
      }
    }
  });

  it("uses the statuses the shipped product actually has", () => {
    const root = render();
    const status = (id: string) => root.querySelector(`[data-platform="${id}"]`)!.getAttribute("data-status");
    // The two receivers a reader can install today.
    expect(status("server")).toBe("available");
    expect(status("linux")).toBe("available");
    // native-releases.json is available:false, and a signed engineering DMG is
    // not a release. Anything but "testing" here would be a distribution claim.
    expect(status("macos")).toBe("testing");
    for (const id of ["windows", "iphone", "android"]) expect(status(id), id).toBe("planned");
  });

  it("shows no command block for a platform with no receiver at all", () => {
    const root = render();
    // iPhone and Android are senders today. A command in either section would
    // read as "there is something to install here", which there is not.
    for (const id of ["iphone", "android"]) {
      const sec = root.querySelector(`[data-platform="${id}"]`)!;
      expect(sec.querySelector("pre"), id).toBeNull();
    }
    // Windows is planned as a native tray app but DOES have a verified
    // foreground command — shown, with its limit stated in the same section.
    const win = root.querySelector('[data-platform="windows"]')!;
    expect(win.querySelector("pre")).not.toBeNull();
    expect(win.textContent).toMatch(/no Windows service and no startup entry/i);
    expect(win.textContent).toMatch(/while the window stays open/i);
  });

  it("leads the server section with download-inspect-install, not with a foreground run", () => {
    const root = render();
    const setup = root.querySelector('[data-platform="server"] dd pre')!.textContent!;
    const install = setup.indexOf("inbox-server-install.sh");
    expect(install).toBeGreaterThan(-1);
    expect(setup).toContain("less inbox-server-install.sh"); // inspect before root
    expect(setup).toContain("sudo sh inbox-server-install.sh --dir /srv/relayium-inbox");
    // `inbox run` is the foreground diagnostic; it must not be the server's
    // primary instruction (WORKFLOW-LEARNINGS, 2026-08-09).
    expect(setup).not.toContain("inbox run");
    const sec = root.querySelector('[data-platform="server"]')!;
    expect(sec.textContent).toContain("/srv/relayium-inbox");
    expect(sec.textContent).toMatch(/low-privilege/i);
    expect(sec.textContent).toMatch(/systemd/i);
    expect(sec.querySelector('[data-di="server-guide"]')!.getAttribute("href"))
      .toBe("/guides/device-inbox-server/");
  });

  it("keeps the Linux desktop path distinct from the unattended server one", () => {
    const root = render();
    const linux = root.querySelector('[data-platform="linux"]')!;
    expect(linux.textContent).toContain("systemd-user");
    expect(linux.textContent).toMatch(/stops when you log out/i);
    expect(linux.textContent).toMatch(/linger/i);
    // The desktop section must not hand out the system-wide server recipe.
    expect(linux.textContent).not.toContain("/srv/relayium-inbox");
  });

  it("offers no macOS download while the release manifest says there is none", () => {
    const root = render({ macRelease: { available: false, downloadUrl: null } });
    const mac = root.querySelector('[data-platform="macos"]')!;
    expect(mac.querySelector('[data-di="mac-download"]')).toBeNull();
    expect(mac.querySelector('[data-di="mac-no-download"]')!.textContent).toBe(en().macNoDownload);
    // The truthful alternative that does exist is still offered.
    expect(mac.querySelector("pre")!.textContent).toContain("inbox service launchd");
    expect(mac.textContent).toContain("~/.config/relayium/logs/relayium-inbox.log");
    expect(mac.textContent).toContain("~/.config/relayium/logs/relayium-inbox.err.log");
    expect(mac.textContent).not.toContain("~/Library/Logs/relayium-inbox");
  });

  it("fails closed on a half-filled manifest, and links a real one", () => {
    const half = render({ macRelease: { available: true, downloadUrl: null } });
    expect(half.querySelector('[data-di="mac-download"]')).toBeNull();

    const full = render({ macRelease: { available: true, downloadUrl: "https://relayium.com/Relayium.dmg" } });
    const cta = full.querySelector<HTMLAnchorElement>('[data-di="mac-download"]')!;
    expect(cta.getAttribute("href")).toBe("https://relayium.com/Relayium.dmg");
  });
});

describe("the boundaries this page must not blur", () => {
  it("separates uploaded from saved, in its own callout", () => {
    const root = render();
    const box = root.querySelector('[data-di="not-saved"]')!;
    expect(box.querySelector("h3")!.textContent).toBe(en().notSavedH3);
    expect(box.textContent).toContain(en().notSavedBody);
  });

  it("says a share link can never make a device write to disk", () => {
    const root = render();
    const box = root.querySelector('[data-di="link-boundary"]')!;
    expect(box.textContent).toContain(en().linkBoundary);
    expect(box.textContent).toMatch(/never make one of your devices write to disk/i);
  });

  it("states the account, same-account and enable-at-the-device prerequisites", () => {
    const root = render();
    const items = [...root.querySelectorAll(".prereq li")].map((li) => li.textContent);
    expect(items).toEqual([
      en().prereqAccount, en().prereqSameAccount, en().prereqEnable, en().prereqOffline,
    ]);
  });
});

describe("the start block, signed out", () => {
  it("offers two controls that actually open the account modal", () => {
    const root = render();
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("signed-out");

    const signIn = root.querySelector<HTMLButtonElement>('[data-di="sign-in"]')!;
    const create = root.querySelector<HTMLButtonElement>('[data-di="create-account"]')!;
    expect(signIn.tagName).toBe("BUTTON"); // opens a dialog; it is not a navigation
    expect(create.tagName).toBe("BUTTON");

    signIn.click();
    flushSync();
    expect(loginOpen()).toBe(true);
    expect(loginIntent()).toBe("login");

    setLoginOpen(false);
    create.click();
    flushSync();
    expect(loginOpen()).toBe(true);
    // Two buttons that opened the same panel would make one of them a lie about
    // what it does.
    expect(loginIntent()).toBe("register");
  });

  it("makes no claim about devices and asks for none", () => {
    const fetchDevices = vi.fn(async () => [READY_DEVICE]);
    const root = render({ fetchDevices });
    expect(fetchDevices).not.toHaveBeenCalled();
    expect(root.querySelector('[data-di="next-step"]')).toBeNull();
    expect(root.querySelector('[data-di="my-devices"]')).toBeNull();
  });
});

describe("the start block, signed in", () => {
  async function signedIn(props: Record<string, unknown> = {}) {
    currentUser = USER;
    await refreshSession();
    const root = render(props);
    // One microtask for the fetch, then flush the effect it settles.
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    return root;
  }

  it("names the account and offers My Devices", async () => {
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE] });
    expect(root.querySelector(".start .lead")!.textContent).toContain(USER.email);
    const cta = root.querySelector<HTMLAnchorElement>('[data-di="my-devices"]')!;
    expect(cta.getAttribute("href")).toBe("/me");
  });

  it("counts only devices that could actually receive", async () => {
    const root = await signedIn({
      fetchDevices: async () => [READY_DEVICE, BARE_DEVICE, REVOKED_DEVICE],
    });
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("ready");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateReady(1));
  });

  it("says so when devices exist but none has an inbox, and offers the setup jump", async () => {
    const root = await signedIn({ fetchDevices: async () => [BARE_DEVICE, REVOKED_DEVICE] });
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("no-inbox");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateNoInbox(2));
    expect(root.querySelector<HTMLAnchorElement>('[data-di="setup-server"]')!.getAttribute("href"))
      .toBe("#platform-server");
  });

  it("says so when the account has no devices at all", async () => {
    const root = await signedIn({ fetchDevices: async () => [] });
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("none");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateNone);
  });

  // The one that matters most: a failed lookup is an absence of knowledge. It
  // must not become "no devices" (which would send someone to set up a receiver
  // they already have) and must never become "ready".
  it("never turns a failed device lookup into a device-ready claim", async () => {
    const root = await signedIn({ fetchDevices: async () => null });
    const start = root.querySelector('[data-di="start"]')!;
    expect(start.getAttribute("data-state")).toBe("unknown");
    const next = root.querySelector('[data-di="next-step"]')!.textContent!.trim();
    expect(next).toBe(en().stateUnknown);
    expect(next).not.toBe(en().stateNone);
    expect(next).not.toContain(en().stateReady(1));
    // The escape hatch stays: My Devices knows the real state.
    expect(root.querySelector('[data-di="my-devices"]')).not.toBeNull();
  });

  // Found by this test: an injected fetcher that REJECTS used to escape
  // loadDevices entirely, so the effect rejected unhandled and the block sat on
  // "checking…" forever — a spinner that resolves to nothing. A throw now means
  // exactly what a non-ok response means.
  it("treats a thrown request the same way — unknown, not empty and not ready", async () => {
    const root = await signedIn({
      fetchDevices: async () => {
        throw new Error("offline");
      },
    });
    const start = root.querySelector('[data-di="start"]')!;
    expect(start.getAttribute("data-state")).toBe("unknown");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateUnknown);
  });
});
