/**
 * @vitest-environment node
 *
 * `stopOwnedChild` against real child processes: one that exits on SIGTERM,
 * one that ignores it, one that already exited, and one that was never spawned.
 * Only the "SIGKILL did not take effect" boundary uses a stand-in object,
 * because a process that survives SIGKILL cannot be produced on demand.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { closeOwnedBrowser, stopOwnedChild } from "./chrome-close.mjs";

const posixOnly = process.platform === "win32" ? it.skip : it;
const children = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

function child(script) {
  const c = spawn("/bin/sh", ["-c", script], { stdio: "ignore" });
  children.push(c);
  return c;
}

/** Signal 0: does the pid still exist? */
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** Resolves once the child is running its final program. */
const started = (c) => new Promise((resolve) => c.once("spawn", resolve));
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("stopOwnedChild", () => {
  posixOnly("stops a cooperative child with SIGTERM alone", async () => {
    const c = child("exec sleep 30");
    await started(c);
    const result = await stopOwnedChild(c, { termGraceMs: 2_000, killGraceMs: 2_000 });
    expect(result).toEqual({ exited: true, via: "SIGTERM" });
    expect(c.signalCode).toBe("SIGTERM");
    expect(alive(c.pid)).toBe(false);
  });

  posixOnly("escalates to SIGKILL for a real child that ignores SIGTERM", async () => {
    // Ignored dispositions survive exec, so the pid we hold is the one ignoring it.
    const c = child("trap '' TERM; exec sleep 30");
    await started(c);
    await settle(100); // the trap is installed before the exec
    const t0 = performance.now();
    const result = await stopOwnedChild(c, { termGraceMs: 400, killGraceMs: 2_000 });
    const elapsed = performance.now() - t0;
    expect(result).toEqual({ exited: true, via: "SIGKILL" });
    expect(c.signalCode).toBe("SIGKILL");
    expect(alive(c.pid)).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(350); // TERM was given its grace
    expect(elapsed).toBeLessThan(2_000);
  });

  posixOnly("sends nothing to a child that already exited", async () => {
    const c = child("exit 3");
    await new Promise((resolve) => c.once("exit", resolve));
    const sent = [];
    const kill = c.kill.bind(c);
    c.kill = (s) => { sent.push(s); return kill(s); };
    expect(await stopOwnedChild(c)).toEqual({ exited: true, via: "already-exited" });
    expect(sent).toEqual([]);
  });

  it("treats a spawn that never produced a process as stopped, without signalling", async () => {
    const c = spawn(join(tmpdir(), "relayium-no-such-browser-binary"), [], { stdio: "ignore" });
    const errored = new Promise((resolve) => c.once("error", resolve));
    const sent = [];
    c.kill = (s) => { sent.push(s); return false; };
    expect(await stopOwnedChild(c)).toEqual({ exited: true, via: "never-spawned" });
    expect(sent).toEqual([]);
    expect((await errored).code).toBe("ENOENT");
  });

  it("reports, within its bounds, a child that SIGKILL did not end — and does not throw", async () => {
    const stuck = Object.assign(new EventEmitter(), {
      pid: 424242, exitCode: null, signalCode: null, sent: [],
      kill(s) { this.sent.push(s); return true; },
    });
    const t0 = performance.now();
    const result = await stopOwnedChild(stuck, { termGraceMs: 100, killGraceMs: 100 });
    expect(result).toEqual({ exited: false, via: null });
    expect(stuck.sent).toEqual(["SIGTERM", "SIGKILL"]);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it("keeps going when kill() itself throws, and judges by the observed exit", async () => {
    const flaky = Object.assign(new EventEmitter(), {
      pid: 424243, exitCode: null, signalCode: null, sent: [],
      kill(s) {
        this.sent.push(s);
        if (s === "SIGTERM") throw new Error("EPERM-ish");
        setTimeout(() => { this.signalCode = "SIGKILL"; this.emit("exit", null, "SIGKILL"); }, 10);
        return true;
      },
    });
    expect(await stopOwnedChild(flaky, { termGraceMs: 50, killGraceMs: 1_000 }))
      .toEqual({ exited: true, via: "SIGKILL" });
    expect(flaky.sent).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("closeOwnedBrowser", () => {
  const stuckChild = () => Object.assign(new EventEmitter(), {
    pid: 424244, exitCode: null, signalCode: null, kill() { return true; },
  });

  it("keeps the profile, and says so, when the child was not observed to exit", async () => {
    const calls = [];
    const result = await closeOwnedBrowser(stuckChild(), {
      termGraceMs: 50, killGraceMs: 50,
      dispose: () => calls.push("dispose"),
      removeProfile: () => calls.push("removeProfile"),
      warn: (line) => calls.push(`warn: ${line}`),
    });
    expect(result).toEqual({ exited: false, via: null });
    expect(calls).toEqual([
      "dispose",
      "warn:   chrome pid 424244 was not observed to exit after SIGTERM and SIGKILL; its temporary profile was left in place",
    ]);
  });

  posixOnly("removes the profile only after the observed exit, and disposes first", async () => {
    const c = child("trap '' TERM; exec sleep 30");
    await started(c);
    await settle(100);
    const calls = [];
    const result = await closeOwnedBrowser(c, {
      termGraceMs: 200, killGraceMs: 2_000,
      dispose: () => calls.push(`dispose alive=${alive(c.pid)}`),
      removeProfile: () => calls.push(`removeProfile alive=${alive(c.pid)}`),
      warn: (line) => calls.push(`warn: ${line}`),
    });
    expect(result).toEqual({ exited: true, via: "SIGKILL" });
    expect(calls).toEqual(["dispose alive=false", "removeProfile alive=false"]);
  });

  it("with no removeProfile (keep), stops the child and leaves the profile alone", async () => {
    const c = spawn(join(tmpdir(), "relayium-no-such-browser-binary"), [], { stdio: "ignore" });
    c.once("error", () => {});
    const warned = [];
    expect(await closeOwnedBrowser(c, { removeProfile: null, warn: (l) => warned.push(l) }))
      .toEqual({ exited: true, via: "never-spawned" });
    expect(warned).toEqual([]);
  });
});
