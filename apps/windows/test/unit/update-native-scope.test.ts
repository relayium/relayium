// The host half of the adapter, driven against a real child process.
//
// The Windows custody cannot run here, so what is proven is everything BETWEEN
// the core and it: framing, the payload-frame pairing that the 512 KiB record
// channel depends on, sequencing, handle release, and the refusal mapping. The
// fake helper implements no custody and argues nothing about the Windows side.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CustodyError } from "../../src/main/update/custody.js";
import {
  HELPER_FILE_NAME,
  nativeInstaller,
  nativePublisherVerifier,
  nativeScopeProvider,
} from "../../src/main/update/native-scope.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-update-helper.mjs", import.meta.url));

/**
 * These fixtures are shell scripts named `*.exe`.
 *
 * `CreateProcess` cannot run one, so they are POSIX-only by construction — and
 * saying so is better than weakening the production spawn to accommodate a
 * test. The same host adapter is exercised against the REAL helper on Windows
 * in `update-windows-native.test.ts`.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * A shim named exactly like the packaged helper, running the fake.
 *
 * The name matters: `native-scope.ts` refuses to spawn anything not called
 * `relayium-update-helper.exe`, and that check is part of what is under test.
 */
async function helper(
  replies: Record<string, unknown>,
  opsLog?: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-update-helper-"));
  owned.push(dir);
  const script = join(dir, "script.json");
  await writeFile(script, JSON.stringify({ replies, opsLog }), "utf8");
  const shim = join(dir, HELPER_FILE_NAME);
  await writeFile(shim, `#!/bin/sh\nexec ${process.execPath} ${FIXTURE} ${script}\n`, "utf8");
  await chmod(shim, 0o755);
  return shim;
}

const opened = { "scope.open": { reply: { ok: true } } };

describeOnPosix("the framed session", () => {
  it("carries a record far larger than a control frame", async () => {
    // The composition that was broken: the core reads with a 512 KiB budget,
    // and a record of any real size cannot come back inside a control frame.
    const path = await helper({
      ...opened,
      "scope.read": { reply: { ok: true, present: true }, bytes: 200 * 1024, fill: 0x7b },
    });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    const text = await scope.readBounded("candidate.json", 512 * 1024);
    expect(text).not.toBeNull();
    expect(text?.length).toBe(200 * 1024);
    expect(text?.startsWith("{{{")).toBe(true);
    await scope.close();
  });

  it("distinguishes an absent record from an empty one", async () => {
    const path = await helper({ ...opened, "scope.read": { reply: { ok: true, present: false } } });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    expect(await scope.readBounded("candidate.json", 512 * 1024)).toBeNull();
    await scope.close();
  });

  it("keeps replies in step across a streamed write", async () => {
    // `custody.write` is the two-frame request. If the pairing were wrong, the
    // reply to a later request would be attributed to this one.
    const path = await helper({
      ...opened,
      "custody.create": { reply: { ok: true, handle: 4, receipt: "win:1:2" } },
      "custody.sync": { reply: { ok: true } },
      "scope.identity": { reply: { ok: true, present: true, receipt: "win:1:2" } },
    });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    const file = await scope.createExclusive("relayium-0.3.0-9-0011223344556677.exe");
    expect(file.receipt).toBe("win:1:2");
    // Larger than one chunk, so it is split and each part answered in turn.
    await file.write(new Uint8Array(2_500_000).fill(7));
    await file.sync();
    expect(await scope.identityOf("relayium-0.3.0-9-0011223344556677.exe")).toBe("win:1:2");
    await scope.close();
  });

  it("releases a handle without deleting, and discards through the receipt after", async () => {
    const seen: string[] = [];
    const path = await helper({
      ...opened,
      "custody.create": { reply: { ok: true, handle: 9, receipt: "win:1:2" } },
      "custody.close": { reply: { ok: true } },
      "scope.remove": { reply: { ok: true, gone: true } },
    });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    const file = await scope.createExclusive("candidate.json.aabbccddeeff.tmp");
    await file.close();
    // After a release the handle is gone, so ownership is proven by the receipt
    // — which is exactly what `scope.remove` requires.
    expect(await file.discard()).toEqual({ outcome: "gone" });
    void seen;
    await scope.close();
  });

  it("reports a pending deletion as residue, never as gone", async () => {
    const path = await helper({
      ...opened,
      "custody.create": { reply: { ok: true, handle: 1, receipt: "win:1:2" } },
      "custody.discard": { reply: { ok: true, gone: false } },
    });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    const file = await scope.createExclusive("a.exe");
    expect(await file.discard()).toEqual({ outcome: "residue", detail: "pending" });
    await scope.close();
  });

  it("refuses a handle issued by a DIFFERENT session", async () => {
    // Root's first RED. Handle ids are small integers each session allocates
    // from one, so two scopes hand out the same numbers; committing another
    // scope's handle would publish a file this one never wrote.
    const script = {
      ...opened,
      "custody.create": { reply: { ok: true, handle: 1, receipt: "win:1:2" } },
      "custody.commit": { reply: { ok: true } },
    };
    const provider = nativeScopeProvider({ helperPath: await helper(script) });
    const first = await provider.open("/data", "updates");
    const second = await provider.open("/data", "updates");
    const foreign = await second.createExclusive("candidate.json.aabbccddeeff.tmp");

    await expect(first.commit(foreign, "candidate.json")).rejects.toMatchObject({
      code: "bad-name",
    });
    // Positive control: its OWN handle commits.
    const mine = await first.createExclusive("candidate.json.112233445566.tmp");
    await expect(first.commit(mine, "candidate.json")).resolves.toBeUndefined();
    // And a released handle names nothing the helper still holds.
    await mine.close().catch(() => undefined);
    await expect(first.commit(mine, "candidate.json")).rejects.toMatchObject({ code: "bad-name" });
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
  });

  it("maps a refusal to its code rather than to a generic failure", async () => {
    const path = await helper({
      ...opened,
      "custody.create": { reply: { ok: false, code: "exists" } },
      "scope.hash": { reply: { ok: false, code: "redirected" } },
    });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    await expect(scope.createExclusive("a.exe")).rejects.toMatchObject({ code: "exists" });
    await expect(scope.hashOwned("a.exe", "win:1:2", 10)).rejects.toMatchObject({
      code: "redirected",
    });
    await scope.close();
  });

  it("refuses a payload that disagrees with its announced length", async () => {
    // Root's second RED: the reply announced ten bytes and three arrived, and
    // the host resolved with them anyway. A stream whose framing is not
    // understood cannot be resynchronised, so it is terminal.
    const path = await helper({
      ...opened,
      "scope.read": { reply: { ok: true, present: true }, bytes: 10, announce: 10, body: "abc" },
    });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    await expect(scope.readBounded("candidate.json", 512 * 1024)).rejects.toBeInstanceOf(
      CustodyError,
    );
    // And the session is poisoned: a later request cannot be answered by a
    // frame that belonged to the broken one.
    await expect(scope.identityOf("a.exe")).rejects.toBeInstanceOf(CustodyError);
    await scope.close().catch(() => undefined);
  });

  it("refuses an oversized control frame and an unknown frame kind", async () => {
    for (const raw of [{ kind: 0x4a, length: 600 * 1024 }, { kind: 0x5a, length: 4 }]) {
      const path = await helper({ ...opened, "scope.identity": { raw } });
      const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
      await expect(scope.identityOf("a.exe")).rejects.toBeInstanceOf(CustodyError);
      await scope.close().catch(() => undefined);
    }
  });

  it("expires a request the helper never answers, and joins the child", async () => {
    // The DEADLINE, not the close. The helper receives the request and says
    // nothing; the budget is narrowed so this proves the timer rather than
    // waiting two minutes for it.
    const path = await helper({ ...opened, "scope.identity": { silent: true } });
    // The budget covers every request in the session, `scope.open` included —
    // and that one has to spawn a process first. Narrow enough to prove the
    // timer without waiting two minutes, wide enough that a spawn is not what
    // expires.
    const scope = await nativeScopeProvider({ helperPath: path, requestDeadlineMs: 1_500 }).open(
      "/data",
      "updates",
    );
    // The handler is attached eagerly: the rejection arrives from a timer, and
    // a `rejects` matcher added a tick later would leave it briefly unhandled.
    const expired = scope.identityOf("a.exe").then(
      () => null,
      (error: unknown) => error as CustodyError,
    );
    expect((await expired)?.detail).toBe("helper-timeout");
    // Poisoned, so a later request cannot be answered by a frame belonging to
    // the expired one.
    const poisoned = scope.identityOf("b.exe").then(
      () => null,
      (error: unknown) => error,
    );
    expect(await poisoned).toBeInstanceOf(CustodyError);
    // And the child is still joined cleanly afterwards.
    await expect(scope.close()).resolves.toBeUndefined();
  });

  it("answers well inside the deadline when the helper is healthy", async () => {
    // The positive control: the same narrow budget, a helper that replies.
    const path = await helper({
      ...opened,
      "scope.identity": { reply: { ok: true, present: true, receipt: "win:1:2" }, delayMs: 10 },
    });
    const scope = await nativeScopeProvider({ helperPath: path, requestDeadlineMs: 2_000 }).open(
      "/data",
      "updates",
    );
    expect(await scope.identityOf("a.exe")).toBe("win:1:2");
    await expect(scope.close()).resolves.toBeUndefined();
  });

  it("settles an in-flight request promptly when the session is closed", async () => {
    // A helper that stops answering must not hold a quiesce — and therefore a
    // quit — open forever.
    const path = await helper({ ...opened, "scope.identity": { silent: true } });
    const scope = await nativeScopeProvider({ helperPath: path }).open("/data", "updates");
    // The handler is attached BEFORE the close, because the rejection happens
    // during it — a `rejects` assertion added afterwards would arrive a tick too
    // late and the rejection would be unhandled.
    const settled = scope.identityOf("a.exe").then(
      () => null,
      (error: unknown) => error,
    );
    // Closing settles it immediately, without waiting for the child to exit:
    // the request is failed as the close begins, not as a side effect of the
    // process finally going away.
    const closed = scope.close();
    expect(await settled).toBeInstanceOf(Error);
    await expect(closed).resolves.toBeUndefined();
  });

  it("refuses to open a scope the helper refused", async () => {
    const path = await helper({ "scope.open": { reply: { ok: false, code: "redirected" } } });
    await expect(
      nativeScopeProvider({ helperPath: path }).open("/data", "updates"),
    ).rejects.toMatchObject({ code: "redirected" });
  });
});

describeOnPosix("the preview verifier", () => {
  const subject = {
    directory: "/data/updates",
    name: "relayium-0.3.0-9-0011223344556677.exe",
    receipt: "win:1:2",
    sizeBytes: 2048,
    sha256: "a".repeat(64),
  };

  it("classifies an unsigned artifact as unsigned, not unavailable", async () => {
    const path = await helper({
      ...opened,
      "install.verify": { reply: { ok: false, code: "unsigned", verdict: "unsigned" } },
    });
    const verifier = nativePublisherVerifier({ helperPath: path, expectedPublisher: null });
    expect(await verifier.verify(subject)).toBe("unsigned");
  });

  it("reports the expected publisher when the pin matches", async () => {
    const path = await helper({
      ...opened,
      "install.verify": { reply: { ok: true, verdict: "signed-by-expected-publisher" } },
    });
    const verifier = nativePublisherVerifier({
      helperPath: path,
      expectedPublisher: "CN=Relayium",
    });
    expect(await verifier.verify(subject)).toBe("signed-by-expected-publisher");
  });

  it("never invents a verdict it does not recognise", async () => {
    const path = await helper({
      ...opened,
      "install.verify": { reply: { ok: true, verdict: "probably-fine" } },
    });
    const verifier = nativePublisherVerifier({ helperPath: path, expectedPublisher: null });
    // An unrecognised answer is an unanswered question.
    expect(await verifier.verify(subject)).toBe("unavailable");
  });

  it("never launches: the preview only ever sends install.verify", async () => {
    const path = await helper({
      ...opened,
      "install.verify": { reply: { ok: true, verdict: "unsigned" } },
      // If the preview ever sent `install.run`, this would answer and the
      // verdict would come back as the launch's.
      "install.run": { reply: { ok: true, verdict: "signed-by-expected-publisher" } },
    });
    const verifier = nativePublisherVerifier({ helperPath: path, expectedPublisher: null });
    expect(await verifier.verify(subject)).toBe("unsigned");
  });
});

describeOnPosix("what this build will spawn", () => {
  it("refuses any executable that is not the packaged helper", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relayium-update-helper-"));
    owned.push(dir);
    for (const candidate of [join(dir, "anything.exe"), "relayium-update-helper.exe"]) {
      await expect(
        nativeScopeProvider({ helperPath: candidate }).open("/data", "updates"),
      ).rejects.toBeInstanceOf(CustodyError);
    }
  });
});

describeOnPosix("the installer", () => {
  const expectation = {
    directory: "/data/updates",
    name: "relayium-0.3.0-9-0011223344556677.exe",
    receipt: "win:1:2",
    sizeBytes: 2048,
    sha256: "a".repeat(64),
    publisher: "CN=Relayium",
  };

  it("refuses without a pinned publisher, and never asks the helper", async () => {
    const path = await helper({ ...opened, "install.run": { reply: { ok: true } } });
    const outcome = await nativeInstaller({ helperPath: path }).installVerified({
      ...expectation,
      publisher: null,
    });
    expect(outcome).toEqual({ outcome: "refused", refusal: "no-expected-publisher" });
  });

  it("reports the platform's verdict when it refuses", async () => {
    const path = await helper({
      ...opened,
      "install.run": {
        reply: { ok: false, code: "publisher", verdict: "signed-by-other-publisher" },
      },
    });
    const outcome = await nativeInstaller({ helperPath: path }).installVerified(expectation);
    expect(outcome).toEqual({
      outcome: "refused",
      refusal: "publisher",
      verdict: "signed-by-other-publisher",
    });
  });

  it("refuses a pre-aborted install without spawning anything", async () => {
    const path = await helper({ ...opened, "install.run": { reply: { ok: true } } });
    const signal = AbortSignal.abort();
    expect(await nativeInstaller({ helperPath: path }).installVerified(expectation, signal)).toEqual(
      { outcome: "refused", refusal: "cancelled" },
    );
  });

  it("refuses a cancel that arrives while the scope is KNOWN to be opening", async () => {
    // A real barrier, not a race. `scope.open` is held for a second, the ops
    // log proves the helper received it, and only then does the signal fire —
    // so this can only pass by actually rechecking before `install.run`.
    const dir = await mkdtemp(join(tmpdir(), "relayium-update-ops-"));
    owned.push(dir);
    const opsLog = join(dir, "ops.log");
    await writeFile(opsLog, "", "utf8");
    const path = await helper(
      {
        "scope.open": { reply: { ok: true }, delayMs: 1_000 },
        "install.run": { reply: { ok: true } },
      },
      opsLog,
    );
    const controller = new AbortController();
    const pending = nativeInstaller({ helperPath: path }).installVerified(
      expectation,
      controller.signal,
    );
    // Wait until the helper has the open in hand.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readFile(opsLog, "utf8")).includes("scope.open")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readFile(opsLog, "utf8")).toContain("scope.open");
    controller.abort();

    // EXACT, and no union: the launch had not been admitted, so nothing else is
    // truthful.
    expect(await pending).toEqual({ outcome: "refused", refusal: "cancelled" });
    // And the marker proves it: `install.run` was never sent.
    expect(await readFile(opsLog, "utf8")).not.toContain("install.run");
  });

  it("launches when nothing cancels it", async () => {
    // The healthy control for the case above, kept separate so neither can
    // stand in for the other.
    const dir = await mkdtemp(join(tmpdir(), "relayium-update-ops-"));
    owned.push(dir);
    const opsLog = join(dir, "ops.log");
    await writeFile(opsLog, "", "utf8");
    const path = await helper(
      { "scope.open": { reply: { ok: true }, delayMs: 50 }, "install.run": { reply: { ok: true } } },
      opsLog,
    );
    expect(
      await nativeInstaller({ helperPath: path }).installVerified(expectation),
    ).toEqual({ outcome: "launched" });
    expect(await readFile(opsLog, "utf8")).toContain("install.run");
  });

  it("reports a launch only when the platform actually launched", async () => {
    const path = await helper({ ...opened, "install.run": { reply: { ok: true } } });
    expect(await nativeInstaller({ helperPath: path }).installVerified(expectation)).toEqual({
      outcome: "launched",
    });
  });

  it("turns an unknown refusal into a platform error, not a launch", async () => {
    const path = await helper({
      ...opened,
      "install.run": { reply: { ok: false, code: "something-new" } },
    });
    expect(await nativeInstaller({ helperPath: path }).installVerified(expectation)).toEqual({
      outcome: "refused",
      refusal: "platform-error",
    });
  });
});
