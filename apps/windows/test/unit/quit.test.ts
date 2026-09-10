import { describe, expect, it, vi } from "vitest";
import {
  QuitCoordinator,
  quitPrompt,
  quitRisk,
  type CleanupResidue,
  type QuitDeps,
  type QuitPrompt,
} from "../../src/main/quit.js";
import { translator } from "../../src/main/l10n.js";

const t = translator("en");
const clean: CleanupResidue = { reasons: [], count: 0 };

/** Typed so `mock.calls` carries the argument types, not `[]`. */
type OnResidue = (residue: CleanupResidue, prompt: QuitPrompt) => Promise<boolean>;

const deps = (over: Partial<QuitDeps> = {}): QuitDeps => ({
  risk: () => "none",
  confirm: async () => true,
  cleanup: async () => clean,
  onResidue: async () => true,
  reportFailure: vi.fn(),
  t,
  ...over,
});

describe("the four risk states", () => {
  it("distinguishes them", () => {
    expect(quitRisk(false, false)).toBe("none");
    expect(quitRisk(true, false)).toBe("transfer");
    expect(quitRisk(false, true)).toBe("local-text");
    expect(quitRisk(true, true)).toBe("transfer-and-local-text");
  });

  it("does not prompt when nothing is at stake", () => {
    expect(quitPrompt("none", t)).toBeNull();
  });

  it("gives each risk its own body, in both languages", () => {
    const bodies = new Set(
      (["transfer", "local-text", "transfer-and-local-text"] as const).map((r) => quitPrompt(r, t)!.body),
    );
    expect(bodies.size).toBe(3);
    expect(quitPrompt("transfer", translator("zh-Hans"))!.body).not.toBe(quitPrompt("transfer", t)!.body);
  });
});

describe("consent", () => {
  it("stays when the user declines", async () => {
    const cleanup = vi.fn(async () => clean);
    const decision = await new QuitCoordinator(deps({ risk: () => "transfer", confirm: async () => false, cleanup })).request();
    expect(decision).toBe("stay");
    // And nothing was torn down on the way to declining.
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("stays, and reports, when the prompt itself fails", async () => {
    // A rejecting confirm previously escaped `request()` into `before-quit`,
    // where it was an unhandled rejection AND the quit proceeded anyway.
    const reportFailure = vi.fn();
    const cleanup = vi.fn(async () => clean);
    const decision = await new QuitCoordinator(
      deps({ risk: () => "transfer", confirm: async () => { throw new Error("no dialog"); }, cleanup, reportFailure }),
    ).request();
    expect(decision).toBe("stay");
    expect(cleanup).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledOnce();
  });
});

describe("cleanup is joined, and its residue is a decision", () => {
  it("quits when cleanup leaves nothing behind", async () => {
    await expect(new QuitCoordinator(deps()).request()).resolves.toBe("quit");
  });

  it("asks when there is residue, and honours staying", async () => {
    const residue: CleanupResidue = { reasons: ["staged-files"], count: 2 };
    const onResidue = vi.fn<OnResidue>(async () => false);
    const decision = await new QuitCoordinator(deps({ cleanup: async () => residue, onResidue })).request();
    expect(decision).toBe("stay");
    expect(onResidue).toHaveBeenCalledOnce();
    expect(onResidue.mock.calls[0]![0]).toEqual(residue);
  });

  it("honours quitting anyway", async () => {
    const decision = await new QuitCoordinator(
      deps({ cleanup: async () => ({ reasons: ["open-lease"], count: 1 }), onResidue: async () => true }),
    ).request();
    expect(decision).toBe("quit");
  });

  it("turns a thrown cleanup into an asked question, not a silent quit", async () => {
    const reportFailure = vi.fn();
    const onResidue = vi.fn<OnResidue>(async () => false);
    const decision = await new QuitCoordinator(
      deps({ cleanup: async () => { throw new Error("EPERM: C:\\Users\\lily\\AppData\\Local\\Relayium\\staging\\x"); }, onResidue, reportFailure }),
    ).request();
    expect(decision).toBe("stay");
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("never puts the error text in front of the user", async () => {
    // The invariant: `onResidue` receives closed reasons and a count. A raw
    // filesystem message routinely contains the full path of the failing file.
    const secret = "C:\\Users\\lily\\AppData\\Local\\Relayium\\staging\\invoice.pdf";
    const onResidue = vi.fn<OnResidue>(async () => true);
    await new QuitCoordinator(
      deps({ cleanup: async () => { throw new Error(`EPERM: ${secret}`); }, onResidue }),
    ).request();
    const [residue, prompt] = onResidue.mock.calls[0]!;
    expect(JSON.stringify(residue)).not.toContain("invoice");
    expect(JSON.stringify(residue)).not.toContain("C:\\");
    expect(residue.reasons).toEqual(["unknown"]);
    expect(JSON.stringify(prompt)).not.toContain("invoice");
  });

  it("stays when even the residue question cannot be asked", async () => {
    const reportFailure = vi.fn();
    const decision = await new QuitCoordinator(
      deps({
        cleanup: async () => ({ reasons: ["staged-files"], count: 1 }),
        onResidue: async () => { throw new Error("no dialog"); },
        reportFailure,
      }),
    ).request();
    expect(decision).toBe("stay");
    expect(reportFailure).toHaveBeenCalledOnce();
  });
});

describe("one quit at a time", () => {
  it("joins the first cleanup instead of starting a second", async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cleanup = vi.fn(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate;
      running -= 1;
      return clean;
    });
    const coordinator = new QuitCoordinator(deps({ cleanup }));
    const a = coordinator.request();
    const b = coordinator.request();
    release();
    expect(await a).toBe("quit");
    expect(await b).toBe("quit");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(peak).toBe(1);
  });

  it("allows a genuine quit after a stay", async () => {
    let staying = true;
    const coordinator = new QuitCoordinator(deps({ risk: () => "transfer", confirm: async () => !staying }));
    expect(await coordinator.request()).toBe("stay");
    staying = false;
    expect(await coordinator.request()).toBe("quit");
  });
});
