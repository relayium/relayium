// `waitIdle` observes the store; it does not change it.
//
// Quit joins active secret work before draining the helper's abandoned work.
// Getting that order wrong returns while a `put` is mid-rename, so the barrier
// below is the assertion that matters: a cipher operation is held open and
// `waitIdle()` must still be waiting.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore, type SecretCipher } from "../../src/main/secrets.js";

const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);

function heldCipher() {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let holding = false;
  const cipher: SecretCipher = {
    isAvailable: () => true,
    encrypt: (plaintext) => Buffer.concat([MAGIC, Buffer.from(plaintext, "utf8").map((b) => b ^ 0x5a)]),
    decrypt: (ciphertext) => {
      if (!ciphertext.subarray(0, 4).equals(MAGIC)) throw new Error("foreign");
      return Buffer.from(ciphertext.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
    },
  };
  return {
    cipher,
    release,
    hold(): void {
      holding = true;
      const realEncrypt = cipher.encrypt.bind(cipher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cipher as any).encrypt = async (plaintext: string) => {
        if (holding) await held;
        return realEncrypt(plaintext);
      };
    },
  };
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relayium-idle-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("waitIdle", () => {
  it("waits for an operation that is actually in flight", async () => {
    const { cipher, release, hold } = heldCipher();
    hold();
    const store = new SecretStore(dir, cipher);

    const writing = store.put("account-bearer", "token");
    let idle = false;
    const waiting = store.waitIdle().then(() => {
      idle = true;
    });

    // The barrier. The write cannot finish, so neither may this.
    await new Promise((r) => setTimeout(r, 30));
    expect(idle).toBe(false);

    release();
    await writing;
    await waiting;
    expect(idle).toBe(true);
    expect(await store.get("account-bearer")).toBe("token");
  });

  it("resolves on a store that has done nothing", async () => {
    const { cipher } = heldCipher();
    await new SecretStore(dir, cipher).waitIdle();
  });

  it("joins work queued behind the operation it is already waiting for", async () => {
    // One key's chain runs in order, so a second write queued behind the held
    // one is work `waitIdle` has to see even though it was invisible when the
    // first pass looked.
    const { cipher, release, hold } = heldCipher();
    hold();
    const store = new SecretStore(dir, cipher);

    const first = store.put("account-bearer", "one");
    const waiting = store.waitIdle();
    const second = store.put("account-bearer", "two");
    let idle = false;
    void waiting.then(() => {
      idle = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(idle).toBe(false);

    release();
    await Promise.all([first, second, waiting]);
    expect(await store.get("account-bearer")).toBe("two");
  });

  it("returns rather than rejecting when an operation failed", async () => {
    // It reports that work has STOPPED, not that it succeeded. A rejection here
    // would make a teardown's join fail and skip the drain that follows it.
    const cipher: SecretCipher = {
      isAvailable: () => true,
      encrypt: () => {
        throw new Error("cipher unavailable");
      },
      decrypt: () => "",
    };
    const store = new SecretStore(dir, cipher);
    await expect(store.put("account-bearer", "x")).rejects.toThrow();
    await expect(store.waitIdle()).resolves.toBeUndefined();
  });
});
