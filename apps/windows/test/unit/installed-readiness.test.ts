import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Execute the actual Windows runner's function without launching an installer
// or bypassing its platform/ownership guards. Only the external CDP/poll seam
// is a fixture. The bridge and renderer intentionally become ready separately.
const source = readFileSync(new URL("../smoke/installed-acceptance.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function attachToApp(");
const end = source.indexOf("\n// ---------------------------------------------------------------------------\n// The run.", start);
if (start < 0 || end <= start) throw new Error("cannot locate the actual installed readiness function");
const body = source.slice(start, end);

function fixture(options: {
  bridge?: boolean; mounted?: boolean; mountAfterFirstPoll?: boolean;
  throwsFirstRender?: boolean; appTarget?: boolean;
} = {}) {
  let mounted = options.mounted ?? false;
  let polls = 0, opens = 0, closes = 0, shellReads = 0, budget = 0;
  const failures: string[] = [];
  const page = { type: "page", url: options.appTarget === false ? "about:blank" : "app://relayium/index.html",
    webSocketDebuggerUrl: "ws://loopback-fixture" };
  const context = vm.createContext({
    DEADLINE: { launch: 120_000 },
    cdpTargets: async () => [page],
    CdpSession: { open: async () => {
      opens++;
      return {
        evaluate: async (expression: string) => {
          if (expression.includes("document.body")) {
            shellReads++;
            if (options.throwsFirstRender && shellReads === 1) throw new Error("target navigated");
            return mounted;
          }
          return options.bridge ?? true;
        },
        close: () => { closes++; },
      };
    } },
    poll: async (predicate: () => Promise<boolean>, timeout: number) => {
      budget = timeout;
      for (let i = 0; i < 3; i++) {
        polls++;
        if (await predicate()) return true;
        if (options.mountAfterFirstPoll) mounted = true;
      }
      return false;
    },
    check: (label: string, _ok: boolean, detail: string) => failures.push(`${label}: ${detail}`),
  });
  const attach = vm.runInContext(body + "\nattachToApp", context) as
    (port: number, label: string) => Promise<{ target: unknown; cdp: { close: () => void } } | null>;
  return { run: () => attach(1, "fixture"), state: () => ({ mounted, polls, opens, closes, shellReads, budget, failures }) };
}

describe("installed artifact readiness waits for the actual shell", () => {
  it("returns a usable bridge and an already mounted renderer on the first poll", async () => {
    const f = fixture({ mounted: true });
    expect(await f.run()).not.toBeNull();
    expect(f.state()).toMatchObject({ polls: 1, opens: 1, closes: 0, shellReads: 1, budget: 120_000, failures: [] });
  });

  it("does not return while the bridge is ready but the body is still empty", async () => {
    const f = fixture({ mountAfterFirstPoll: true });
    const attached = await f.run();
    expect(attached).not.toBeNull();
    expect(f.state()).toMatchObject({ mounted: true, polls: 2, opens: 2, closes: 1, shellReads: 2, budget: 120_000 });
    attached!.cdp.close(); expect(f.state().closes).toBe(2);
  });

  it("fails closed with an observation when a renderer never mounts", async () => {
    const f = fixture();
    expect(await f.run()).toBeNull();
    expect(f.state()).toMatchObject({ polls: 3, opens: 3, closes: 3, budget: 120_000 });
    expect(f.state().failures).toHaveLength(1);
    expect(f.state().failures[0]).toContain("shell has not rendered yet");
  });

  it("still requires the preload bridge even if a page rendered", async () => {
    const f = fixture({ bridge: false, mounted: true });
    expect(await f.run()).toBeNull();
    expect(f.state()).toMatchObject({ opens: 3, closes: 3, shellReads: 0 });
    expect(f.state().failures[0]).toContain("no bridge yet");
  });

  it("closes a navigated render probe before trying a fresh session", async () => {
    const f = fixture({ mounted: true, throwsFirstRender: true });
    expect(await f.run()).not.toBeNull();
    expect(f.state()).toMatchObject({ polls: 2, opens: 2, closes: 1, failures: [] });
  });

  it("does not attach to a page outside the app scheme", async () => {
    const f = fixture({ appTarget: false, mounted: true });
    expect(await f.run()).toBeNull();
    expect(f.state()).toMatchObject({ opens: 0, closes: 0, shellReads: 0 });
  });
});
