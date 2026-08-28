// /device-inbox — the page, as the surface the feature is OPERATED on.
//
// The assertions here are the ones the PRD makes non-negotiable (§8, §10, §12).
// They fall into four groups:
//
//  1. **Six named platforms, honestly badged**, and no invented executable
//     control for a native product that does not exist. A testing/planned native
//     section may show only a separately shipped, explicitly limited fallback.
//  2. **A start block that changes with the account.** Signed out it must offer
//     something that executes and ask for nothing; signed in it must render THIS
//     account's actual devices with the real send control on each one that can
//     receive, and a failed /api/devices must not be rendered as either "no
//     devices" or "ready" (WORKFLOW-LEARNINGS 2026-08-09: a failed background
//     refresh must not erase — or invent — trustworthy state).
//  3. **The journey ends here.** Sending, renaming and revoking devices are
//     available without navigating to /me.
//  4. **The two boundaries in prose**: uploaded is not saved, and a share link
//     is not permission to write to a disk.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import DeviceInboxPage from "./DeviceInboxPage.svelte";
import { loadLang, messages } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import { loginOpen, loginIntent, setLoginOpen } from "./login.svelte";
import { CAP_RECEIVE_V3, DEVICE_REFRESH_MS, INBOX_KEY_ALGORITHM } from "./device-inbox";
import { INBOX_PLATFORMS, REQUIRED_PLATFORM_IDS } from "./device-inbox-platforms";

// The network half of a send is mocked: this suite is about what the PAGE hands
// to the card. device-send.test.ts owns the wire format and the crypto, and
// DeviceCard.test.ts owns what the card does with them.
const sendSpy = vi.fn();
const fetchTaskSpy = vi.fn();

vi.mock("./device-send", async (orig) => {
  const real = await orig<typeof import("./device-send")>();
  return {
    ...real,
    sendFilesToDevice: (...args: unknown[]) => sendSpy(...args),
    fetchInboxTask: (...args: unknown[]) => fetchTaskSpy(...args),
  };
});

const ZERO_KEY = "A".repeat(43);
const USER = { id: "u1", email: "owner@example.com", displayName: "Owner", hasPassword: true };

function inbox(over: Record<string, unknown> = {}) {
  return {
    Presence: "online",
    LastHeartbeatAt: 1_700_000_000,
    PresenceExpiresAt: 1_700_000_090,
    HeartbeatIntervalSeconds: 30,
    Capabilities: [CAP_RECEIVE_V3],
    ReceiveCapability: CAP_RECEIVE_V3,
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

const READY_DEVICE = {
  ID: "0123456789abcdef0123456789aaa111", Name: "build-server",
  CreatedAt: 1_690_000_000, LastSeenAt: 1_700_000_000, Kind: "cli", Inbox: inbox(),
};
const BARE_DEVICE = {
  ID: "0123456789abcdef0123456789bbb222", Name: "old-vps",
  CreatedAt: 1_690_000_000, LastSeenAt: 1_699_000_000, Kind: "cli", Inbox: null,
};
// Enrolled, but centrally revoked: it must NOT be counted as ready. This is the
// row that a looser "has an Inbox subtree" rule would have called ready.
const REVOKED_DEVICE = {
  ID: "0123456789abcdef0123456789ccc333", Name: "lost-laptop",
  CreatedAt: 1_690_000_000, LastSeenAt: 1_698_000_000, Kind: "cli", Inbox: inbox({ Revoked: true }),
};
// A kind this build cannot describe. Listed by neither page: it holds a session
// cookie rather than a carryable token, and it never enrols an inbox.
const BROWSER_DEVICE = {
  ID: "0123456789abcdef0123456789ddd444", Name: "this browser",
  CreatedAt: 1_690_000_000, LastSeenAt: 1_700_000_001, Kind: "browser", Inbox: null,
};

/** A drop carrying real `File`s. jsdom has no FileList constructor and its
 *  DataTransfer carries no files, so the list is built by hand. */
function dropOn(zone: Element, files: File[]) {
  const list: Record<string | number, unknown> = { item: (i: number) => files[i] ?? null };
  files.forEach((f, i) => (list[i] = f));
  list.length = files.length;
  const e = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, "dataTransfer", { value: { files: list, items: [], types: ["Files"] } });
  zone.dispatchEvent(e);
}

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
  sendSpy.mockReset();
  fetchTaskSpy.mockReset();
  fetchTaskSpy.mockResolvedValue(undefined);
  sendSpy.mockResolvedValue({
    ID: "aaaabbbbccccddddeeeeffff00001111",
    State: "queued", ErrorCode: "", CiphertextBytes: 1, SavedAt: 0, TerminalAt: 0,
    Terminal: false, ExpiresAt: 0, CreatedAt: 0, UpdatedAt: 0, TargetKeyID: "k1", TargetKeyGeneration: 1,
  });
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

  // The six rows used to be decorated with platform emoji, which rendered as
  // vendor artwork on one OS, a flat outline on the next and a tofu box where
  // the font had neither — beside a page whose every other mark is a stroked
  // icon on an accent token. The hero above them had already moved to `Icon`.
  //
  // The path assertion is the one that matters most: `Icon` renders a bare
  // <svg> with no geometry for a name it does not know, so a typo in an
  // `icon:` field would otherwise ship an invisible, entirely silent blank.
  it("marks each platform row with a real shared icon, not an emoji", () => {
    const root = render();
    for (const p of INBOX_PLATFORMS) {
      const sec = root.querySelector(`[data-platform="${p.id}"]`)!;
      const g = sec.querySelector("summary h3 .g")!;
      expect(g, p.id).not.toBeNull();
      const svgs = g.querySelectorAll("svg");
      expect(svgs.length, `${p.id} should carry exactly one mark`).toBe(1);
      expect(
        svgs[0].querySelectorAll("path").length,
        `${p.id} declares icon "${p.icon}", which Icon.svelte does not draw`,
      ).toBeGreaterThan(0);
    }
  });

  // Decorative, and it has to stay that way: the localized name sits in the very
  // next element and the <summary> takes its accessible name from this same h3,
  // so anything nameable inside the mark would announce the platform twice —
  // the second time in English on a Chinese page.
  it("keeps the platform mark decorative and the row named exactly once", () => {
    const root = render();
    for (const p of INBOX_PLATFORMS) {
      const sec = root.querySelector(`[data-platform="${p.id}"]`)!;
      const g = sec.querySelector("summary h3 .g")!;
      expect(g.getAttribute("aria-hidden"), p.id).toBe("true");
      const svg = g.querySelector("svg")!;
      expect(svg.getAttribute("aria-hidden"), p.id).toBe("true");
      expect(svg.getAttribute("aria-label"), p.id).toBeNull();
      expect(svg.querySelector("title"), p.id).toBeNull();
      // No text of any kind, which is also what keeps an emoji from returning.
      expect(g.textContent!.trim(), p.id).toBe("");

      const name = en().platforms[p.id].name;
      expect(sec.querySelector("summary .pname")!.textContent!.trim(), p.id).toBe(name);
      // The summary still reads as name + status, and nothing else.
      const summary = sec.querySelector("summary")!.textContent!;
      expect(summary, p.id).toContain(name);
      expect(summary.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))!.length, p.id).toBe(1);
    }
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
    // macOS is derived, not declared — see the manifest pair below.
    //
    // `planned` is a legacy discriminant, retained on 2026-08-28 rather than
    // renamed: it is the key behind `statusPlanned`, which seven frozen locales
    // type against. It now means "Relayium publishes no native receiver here",
    // and the maintained badge a reader sees says exactly that — asserted on the
    // next line so the id and the visible word cannot drift apart again.
    for (const id of ["windows", "iphone", "android"]) expect(status(id), id).toBe("planned");
    for (const id of ["windows", "iphone", "android"]) {
      const badge = root.querySelector(`[data-platform="${id}"] .badge`)!.textContent!;
      expect(badge, id).toContain(en().statusPlanned);
      expect(badge, `${id} badge still promises a plan`).not.toMatch(/\bplanned\b/i);
    }
  });

  // The badge and the download button answer to ONE input, and this is the pair
  // that pins it. The defect it closes was live on production 2026-08-11: macOS
  // 1.1.3 was published and downloadable FROM THIS PAGE, and the badge next to
  // that download still read "In testing", because the status was written down
  // a second time in device-inbox-platforms.ts and nobody updated it on release.
  it("calls macOS available exactly when the manifest offers a download", () => {
    const root = render({ macRelease: { available: true, downloadUrl: "https://example.test/Relayium.dmg" } });
    const mac = root.querySelector('[data-platform="macos"]')!;
    expect(mac.getAttribute("data-status")).toBe("available");
    expect(mac.querySelector(".badge")!.textContent).toContain(en().statusAvailable);
    // The badge cannot say "available" while the button that would prove it is
    // missing: same input, so this is the same assertion from the other side.
    expect(mac.querySelector('[data-di="mac-download"]')).not.toBeNull();
  });

  it("falls back to the pre-release status when the manifest offers nothing", () => {
    const root = render({ macRelease: { available: false, downloadUrl: null } });
    const mac = root.querySelector('[data-platform="macos"]')!;
    expect(mac.getAttribute("data-status")).toBe("testing");
    expect(mac.querySelector(".badge")!.textContent).toContain(en().statusTesting);
    expect(mac.querySelector('[data-di="mac-download"]')).toBeNull();
  });

  it("shows no command block for a platform with no receiver at all", () => {
    const root = render();
    // iPhone and Android are senders today. A command in either section would
    // read as "there is something to install here", which there is not.
    for (const id of ["iphone", "android"]) {
      const sec = root.querySelector(`[data-platform="${id}"]`)!;
      expect(sec.querySelector("pre"), id).toBeNull();
    }
    // Relayium publishes no Windows app, but Windows DOES have a verified
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

// The order and the disclosures are a product decision, not styling, so they
// are asserted on the document rather than left to a screenshot. Both defects
// they close were measured in a real browser at 390px on 2026-08-11: the start
// block began 2,774px down a 12,436px page — three and a third phone screens of
// explanation before the control — and the six expanded platform sections were
// most of what was in between.
describe("the tool comes before the explanation", () => {
  /** True when `a` starts before `b` in document order. */
  const precedes = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("puts the operational block above every explanatory one", () => {
    const root = render();
    const start = root.querySelector('[data-di="start"]')!;
    // The three blocks a returning owner used to scroll past every visit.
    for (const sel of ['[data-di="not-saved"]', '[data-di="link-boundary"]', "#platforms"]) {
      const later = root.querySelector(sel)!;
      expect(later, sel).not.toBeNull();
      expect(precedes(start, later), `${sel} still comes before the start block`).toBe(true);
    }
    // And it is still the FIRST thing under the hero, not merely above them.
    const blocks = [...root.querySelectorAll(".block")];
    expect(blocks[0]).toBe(start);
  });

  it("keeps every explanatory block on the page rather than deleting it", () => {
    const root = render();
    // Reordering is not a licence to drop content: the two boundary callouts and
    // the four prerequisites are PRD requirements wherever they sit.
    expect(root.querySelector('[data-di="not-saved"]')).not.toBeNull();
    expect(root.querySelector('[data-di="link-boundary"]')).not.toBeNull();
    expect(root.querySelectorAll(".prereq li").length).toBe(4);
    expect(root.querySelectorAll(".steps li").length).toBe(en().howSteps.length);
  });

  it("collapses each platform behind a disclosure that still states its status", () => {
    const root = render();
    for (const id of REQUIRED_PLATFORM_IDS) {
      const sec = root.querySelector<HTMLDetailsElement>(`[data-platform="${id}"]`)!;
      expect(sec.tagName, id).toBe("DETAILS");
      expect(sec.open, `${id} is expanded, which is the wall of text this replaces`).toBe(false);
      // What must never be behind the click: the name and the honest status.
      const summary = sec.querySelector("summary")!;
      expect(summary.textContent, id).toContain(en().platforms[id].name);
      expect(summary.querySelector(".badge")!.textContent, id).toContain("Status:");
      // The heading survives the move into <summary>: the outline is unchanged.
      expect(summary.querySelector("h3"), id).not.toBeNull();
    }
  });

  it("opens the section a same-page link names, instead of scrolling to a closed row", async () => {
    // An account with nothing to send to: the state whose remedy IS the server
    // section, and the one that renders the link to it.
    const root = await signedIn({ fetchDevices: async () => [] });
    const server = root.querySelector<HTMLDetailsElement>('[data-platform="server"]')!;
    expect(server.open).toBe(false);

    const cta = root.querySelector<HTMLAnchorElement>('[data-di="setup-server"]')!;
    expect(cta.getAttribute("href")).toBe("#platform-server");
    cta.click();
    flushSync();
    // Without this the anchor resolves, the page jumps, and the reader is left
    // looking at a summary line — the same dead end as a broken link.
    expect(server.open, "the setup CTA scrolled to a section it did not open").toBe(true);
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
    // Not merely "no rows": no list, no send control, nothing that would imply
    // a signed-out visitor has devices at all.
    expect(root.querySelector('[data-di="devices"]')).toBeNull();
    expect(root.querySelector(".sendzone")).toBeNull();
  });
});

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

const rowsOf = (root: HTMLElement) => [...root.querySelectorAll('[data-di="devices"] li')];
const rowFor = (root: HTMLElement, name: string) =>
  rowsOf(root).find((r) => r.textContent?.includes(name))!;
const openDevice = (root: HTMLElement, name: string) => {
  rowFor(root, name).querySelector<HTMLButtonElement>("button.open")!.click();
  flushSync();
};

describe("the five things the signed-in block may say", () => {
  it("says it is still checking, and claims nothing while it does", async () => {
    // A pending lookup is not an empty account. Rendering "no devices" here —
    // even for one frame — tells someone with three servers to go set one up.
    currentUser = USER;
    await refreshSession();
    const root = render({ fetchDevices: () => new Promise<never[]>(() => {}) });
    await Promise.resolve();
    flushSync();
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("checking");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().startChecking);
    expect(root.querySelector('[data-di="devices"]')).toBeNull();
    expect(root.querySelector('[data-di="retry"]')).toBeNull();
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
    // No invented rows, and no send control aimed at a device we cannot name.
    expect(root.querySelector('[data-di="devices"]')).toBeNull();
    expect(root.querySelector(".sendzone")).toBeNull();
  });

  // Found by an earlier round: an injected fetcher that REJECTS used to escape
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

  it("treats a malformed successful device payload as unknown", async () => {
    // A 200 response is not trustworthy merely because it parsed as JSON. If a
    // rolling deployment or server regression changes `devices` away from an
    // array, the page must not throw or turn that shape into an empty account.
    const root = await signedIn({
      fetchDevices: async () => "not-an-array" as unknown as unknown[],
    });
    const start = root.querySelector('[data-di="start"]')!;
    expect(start.getAttribute("data-state")).toBe("unknown");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateUnknown);
    expect(root.querySelector('[data-di="devices"]')).toBeNull();
  });

  it("offers a retry that can actually resolve the unknown", async () => {
    // The remedy for "we do not know" is asking again, so this is the one state
    // that gets a control rather than only a sentence.
    let answer: unknown[] | null = null;
    const root = await signedIn({ fetchDevices: async () => answer });
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("unknown");

    answer = [READY_DEVICE];
    root.querySelector<HTMLButtonElement>('[data-di="retry"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("ready");
    expect(rowsOf(root)).toHaveLength(1);
  });

  it("says so when the account has no devices at all", async () => {
    const root = await signedIn({ fetchDevices: async () => [] });
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("none");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateNone);
    expect(root.querySelector('[data-di="devices"]')).toBeNull();
    expect(root.querySelector<HTMLAnchorElement>('[data-di="setup-server"]')!.getAttribute("href"))
      .toBe("#platform-server");
  });

  it("lists devices that exist but cannot receive, each with its own reason", async () => {
    const root = await signedIn({ fetchDevices: async () => [BARE_DEVICE, REVOKED_DEVICE] });
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("no-inbox");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateNoInbox(2));
    // Present, not hidden: "you have two devices, neither can receive" is only
    // checkable by the owner if both are on screen with their reasons.
    expect(rowsOf(root)).toHaveLength(2);
    expect(root.querySelector(".sendzone"), "an unsendable device was given a drop target").toBeNull();
    expect(rowFor(root, "lost-laptop").querySelector(".inboxblocked")!.textContent).toMatch(/was revoked/i);
    // A device that never enrolled has no inbox block at all — that IS its
    // reason, and inventing a sentence for it would be noise.
    expect(rowFor(root, "old-vps").querySelector(".inboxblock")).toBeNull();
    expect(root.querySelector<HTMLAnchorElement>('[data-di="setup-server"]')).not.toBeNull();
  });

  it("counts only devices that could actually receive, and shows the rest anyway", async () => {
    const root = await signedIn({
      fetchDevices: async () => [READY_DEVICE, BARE_DEVICE, REVOKED_DEVICE],
    });
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("ready");
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateReady(1));
    expect(rowsOf(root)).toHaveLength(3);
    expect(root.querySelectorAll(".sendzone")).toHaveLength(0);
  });

  it("lists only device kinds this build can describe", async () => {
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE, BROWSER_DEVICE] });
    expect(rowsOf(root)).toHaveLength(1);
    expect(root.textContent).not.toContain("this browser");
    // …and the count agrees with the list, rather than with the raw response.
    expect(root.querySelector('[data-di="next-step"]')!.textContent!.trim()).toBe(en().stateReady(1));
  });
});

describe("sending, without leaving this page", () => {
  it("opens a named device workspace, distinguishes duplicate names, and returns to the list", async () => {
    const twin = { ...READY_DEVICE, ID: "0123456789abcdef0123456789bbb999" };
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE, twin] });
    expect(root.querySelector(".sendzone")).toBeNull();
    const labels = [...root.querySelectorAll<HTMLButtonElement>("button.open")].map((button) => button.getAttribute("aria-label"));
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);

    openDevice(root, "build-server");
    expect(root.querySelector('[data-di="device-workspace-heading"]')!.textContent).toContain("build-server");
    expect(root.querySelector(".sendzone")).not.toBeNull();
    expect(root.textContent).toContain(en().deviceWorkspaceNote);
    root.querySelector<HTMLButtonElement>('[data-di="device-back"]')!.click();
    flushSync();
    expect(root.querySelectorAll("button.open")).toHaveLength(2);
    expect(root.querySelector(".sendzone")).toBeNull();
  });

  it("puts the real send control on every device that can receive", async () => {
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE] });
    openDevice(root, "build-server");
    const row = rowFor(root, "build-server");
    expect(row.querySelector(".sendzone"), "the ready device has no drop target").not.toBeNull();
    const btn = row.querySelector<HTMLButtonElement>("button.sendbtn")!;
    expect(btn.getAttribute("aria-label")).toContain("build-server");
  });

  it("a real drop starts a real send, from this page, to that device", async () => {
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE] });
    openDevice(root, "build-server");
    const files = [new File(["hello"], "notes.txt"), new File(["x"], "b.bin")];
    dropOn(rowFor(root, "build-server").querySelector(".sendzone")!, files);
    // The send walks several awaits before central's answer becomes a task.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    flushSync();

    expect(sendSpy, "the drop did not reach the send pipeline").toHaveBeenCalledTimes(1);
    const [target, sent] = sendSpy.mock.calls[0] as [
      { deviceID: string; publicKey: string },
      { file: File; path?: string }[],
    ];
    expect(target.deviceID).toBe(READY_DEVICE.ID);
    expect(target.publicKey).toBe(ZERO_KEY);
    // Named entries: each file travels with the relative path its manifest name
    // will be, so a dropped FOLDER keeps its shape on the other device.
    expect(sent).toEqual(files.map((file) => ({ file })));
    // And it reports what happened, in the card's persistent live region.
    expect(root.querySelector(".sendstatus")!.textContent).toMatch(/Uploaded to Relayium/i);
  });

  it("choosing files with the button reaches the same pipeline", async () => {
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE] });
    openDevice(root, "build-server");
    const row = rowFor(root, "build-server");
    const input = row.querySelector<HTMLInputElement>("input.filepick")!;
    const file = new File(["picked"], "picked.txt");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    flushSync();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect((sendSpy.mock.calls[0] as [unknown, { file: File; path?: string }[]])[1])
      .toEqual([{ file, path: undefined }]);
  });

  it("names the account and keeps device management on this page", async () => {
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE] });
    expect(root.querySelector(".start .lead")!.textContent).toContain(USER.email);
    expect(root.querySelector('[data-di="my-devices"]')).toBeNull();
    expect(rowFor(root, "build-server").querySelector("button.del")).not.toBeNull();
  });

  it("carries rename and revoke controls on every account device row", async () => {
    const root = await signedIn({
      fetchDevices: async () => [READY_DEVICE, BARE_DEVICE, REVOKED_DEVICE],
    });
    const block = root.querySelector('[data-di="devices"]')!;
    expect(block.querySelector("button.del")).not.toBeNull();
    expect(block.querySelector("button.open")).not.toBeNull();
    // Asserted against the real labels rather than the words: "This device's
    // inbox was revoked" is an explanation the row SHOULD carry, and a blanket
    // /revoke/i ban would forbid the sentence while permitting the button.
    const labels = [messages.en.me.deviceRename, messages.en.me.deviceRevoke];
    const buttons = [...block.querySelectorAll("button")].map((b) => b.textContent!.trim());
    for (const label of labels) expect(buttons).toContain(label);
    // The aria-labels carry the same vocabulary, and are what a screen reader
    // would hear even if the visible text were trimmed away.
    const aria = [...block.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")!);
    expect(aria.some((a) => a.includes(messages.en.me.deviceRevoke))).toBe(true);
  });

  it("points each platform section back at this page, never at /me", async () => {
    const root = await signedIn({ fetchDevices: async () => [READY_DEVICE] });
    for (const id of REQUIRED_PLATFORM_IDS) {
      const link = root.querySelector<HTMLAnchorElement>(`[data-di="send-${id}"]`)!;
      expect(link, id).not.toBeNull();
      expect(link.getAttribute("href"), id).toBe("#start");
    }
  });
});

describe("keeping a trustworthy list across a presence refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Signed in, with fake timers already installed. */
  async function mounted(fetchDevices: () => Promise<unknown[] | null>) {
    currentUser = USER;
    await refreshSession();
    const root = render({ fetchDevices });
    await vi.advanceTimersByTimeAsync(5);
    flushSync();
    return root;
  }

  it("refreshes presence on a bounded timer, in place, keeping the same rows", async () => {
    let presence = "online";
    let calls = 0;
    const root = await mounted(async () => {
      calls++;
      return [{ ...READY_DEVICE, Inbox: inbox({ Presence: presence }) }];
    });
    openDevice(root, "build-server");
    expect(calls).toBe(1);
    expect(rowFor(root, "build-server").textContent).toContain("Online");

    presence = "offline";
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS + 100);
    flushSync();
    expect(calls, "presence went stale — the list was never refreshed").toBe(2);
    expect(rowFor(root, "build-server").textContent).toContain("Offline");
    // Still sendable: an offline device is a queue, not a refusal.
    expect(rowFor(root, "build-server").querySelector(".sendzone")).not.toBeNull();
  });

  it("a failed refresh preserves the rows and does not abort a send in flight", async () => {
    // The failure this test exists for: clearing the list on a transient error
    // unmounts every card, and with it the upload running inside one.
    let report!: (p: { phase: string; sent: number; total: number }) => void;
    sendSpy.mockImplementation((_t: unknown, _f: unknown, opts: { onProgress: typeof report }) => {
      report = opts.onProgress;
      return new Promise(() => {}); // never settles: the send stays in flight
    });
    let ok = true;
    const root = await mounted(async () => (ok ? [READY_DEVICE] : null));
    openDevice(root, "build-server");

    dropOn(rowFor(root, "build-server").querySelector(".sendzone")!, [new File(["x"], "a.bin")]);
    await vi.advanceTimersByTimeAsync(5);
    report({ phase: "uploading", sent: 50, total: 100 });
    await vi.advanceTimersByTimeAsync(5);
    flushSync();
    expect(root.querySelector(".sendstatus")!.textContent).toContain("50%");

    ok = false;
    await vi.advanceTimersByTimeAsync(DEVICE_REFRESH_MS + 100);
    flushSync();

    const start = root.querySelector('[data-di="start"]')!;
    expect(start.getAttribute("data-state"), "a failed refresh became 'we know nothing'").toBe("ready");
    expect(rowsOf(root), "a failed refresh removed the last trustworthy list").toHaveLength(1);
    expect(root.querySelector(".sendstatus")!.textContent, "a failed refresh aborted the send")
      .toContain("50%");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    // …and it says the presence above may now be out of date, rather than
    // quietly presenting stale rows as fresh.
    expect(root.querySelector('[data-di="stale"]')!.textContent).toBe(en().refreshFailed);
  });

  it("signing out drops the rows entirely", async () => {
    const root = await mounted(async () => [READY_DEVICE]);
    openDevice(root, "build-server");
    expect(rowsOf(root)).toHaveLength(1);
    currentUser = null;
    await refreshSession();
    await vi.advanceTimersByTimeAsync(5);
    flushSync();
    expect(root.querySelector('[data-di="devices"]'), "another session's device stayed on screen").toBeNull();
    expect(root.querySelector('[data-di="start"]')!.getAttribute("data-state")).toBe("signed-out");
  });

  it("an account switch clears an open device workspace", async () => {
    const root = await mounted(async () => [READY_DEVICE]);
    openDevice(root, "build-server");
    currentUser = { ...USER, id: "u2", email: "second@example.com" };
    await refreshSession();
    await vi.advanceTimersByTimeAsync(5);
    flushSync();
    expect(root.querySelector('[data-di="device-workspace-heading"]')).toBeNull();
    expect(root.querySelectorAll("button.open")).toHaveLength(1);
  });
});
