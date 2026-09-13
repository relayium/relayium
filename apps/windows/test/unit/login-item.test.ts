import { describe, expect, it, vi } from "vitest";
import { classify, currentState, disable, enable, type LoginItemSystem } from "../../src/main/login-item.js";

const system = (
  snapshot: { openAtLogin: boolean; executableWillLaunchAtLogin: boolean },
  write = vi.fn(),
  reportFailure = vi.fn(),
): LoginItemSystem => ({ read: () => snapshot, write, reportFailure });

describe("the Windows state table", () => {
  it("is not a Bool", () => {
    expect(classify({ openAtLogin: false, executableWillLaunchAtLogin: false })).toBe("off");
    expect(classify({ openAtLogin: true, executableWillLaunchAtLogin: true })).toBe("on");
    expect(classify({ openAtLogin: false, executableWillLaunchAtLogin: true })).toBe("on-by-other-means");
  });

  it("never reports a Task-Manager-disabled entry as on", () => {
    // `executableWillLaunchAtLogin` is documented as true only when the run key
    // is NOT deactivated. Registered-but-off is the Windows analogue of macOS's
    // `requiresApproval`, and calling it "on" claims a residency the app does
    // not have — from a switch that lives in a different application.
    expect(classify({ openAtLogin: true, executableWillLaunchAtLogin: false })).toBe("disabled-by-user");
  });
});

describe("the system is asked every time", () => {
  it("re-reads rather than caching", () => {
    let snapshot = { openAtLogin: false, executableWillLaunchAtLogin: false };
    const s: LoginItemSystem = { read: () => snapshot, write: vi.fn(), reportFailure: vi.fn() };
    expect(currentState(s)).toEqual({ ok: true, state: "off" });
    // The user changed it in Task Manager; nothing told the app.
    snapshot = { openAtLogin: true, executableWillLaunchAtLogin: true };
    expect(currentState(s)).toEqual({ ok: true, state: "on" });
  });

  it("reports an unreadable system rather than calling it off", () => {
    const s: LoginItemSystem = { read: () => { throw new Error("denied"); }, write: vi.fn(), reportFailure: vi.fn() };
    const result = currentState(s);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind).toBe("unreadable");
  });
});

describe("consent", () => {
  it("does not write without it", async () => {
    const write = vi.fn();
    await enable(system({ openAtLogin: false, executableWillLaunchAtLogin: false }, write), async () => "declined");
    expect(write).not.toHaveBeenCalled();
  });

  it("requires exactly `confirmed`, not merely not-declined", async () => {
    // The adapter is a dialog behind IPC. An undefined, a typo or a future third
    // option must not add a startup entry nobody agreed to, so enabling takes
    // the affirmative test rather than the negative one.
    for (const answer of [undefined, null, "", "confirm", "yes", "CONFIRMED"]) {
      const write = vi.fn();
      await enable(
        system({ openAtLogin: false, executableWillLaunchAtLogin: false }, write),
        async () => answer as never,
      );
      expect(write, String(answer)).not.toHaveBeenCalled();
    }
  });

  it("writes nothing and reports when the consent prompt fails", async () => {
    const write = vi.fn();
    const reportFailure = vi.fn();
    const result = await enable(
      system({ openAtLogin: false, executableWillLaunchAtLogin: false }, write, reportFailure),
      async () => { throw new Error("no window"); },
    );
    expect(write).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind).toBe("consent-failed");
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("carries no error text into the failure it returns", async () => {
    // Closed codes only: this value crosses IPC and reaches a settings screen.
    const reportFailure = vi.fn();
    const s: LoginItemSystem = {
      read: () => { throw new Error("registry denied for C:\\Users\\lily\\NTUSER.DAT"); },
      write: vi.fn(),
      reportFailure,
    };
    const result = currentState(s);
    expect(JSON.stringify(result)).not.toContain("NTUSER");
    expect(JSON.stringify(result)).not.toContain("C:\\");
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("writes once consent is given", async () => {
    const write = vi.fn();
    await enable(system({ openAtLogin: true, executableWillLaunchAtLogin: true }, write), async () => "confirmed");
    expect(write).toHaveBeenCalledWith(true);
  });

  it("reports the system's answer, not the write's success", async () => {
    // `setLoginItemSettings` returns nothing, and on Windows it can succeed
    // while the run key stays deactivated.
    const state = await enable(system({ openAtLogin: true, executableWillLaunchAtLogin: false }), async () => "confirmed");
    expect(state).toEqual({ ok: true, state: "disabled-by-user" });
  });

  it("surfaces a failed write", async () => {
    const s: LoginItemSystem = {
      read: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }),
      write: () => { throw new Error("policy"); },
      reportFailure: vi.fn(),
    };
    const result = await enable(s, async () => "confirmed");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind).toBe("write-failed");
  });
});

describe("disable", () => {
  it("needs no consent, because removing a permission is not a grant", () => {
    const write = vi.fn();
    disable(system({ openAtLogin: false, executableWillLaunchAtLogin: false }, write));
    expect(write).toHaveBeenCalledWith(false);
  });
});
