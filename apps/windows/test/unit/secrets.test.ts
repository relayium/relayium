import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore, MAX_SECRET_BYTES, MAX_SEALED_BYTES, type SecretCipher } from "../../src/main/secrets.js";

// A test cipher, never the platform one. `safeStorage` on macOS raises a system
// prompt and touches the developer's own login keychain; a unit test must do
// neither.
//
// It obscures the bytes rather than wrapping them in a readable prefix,
// specifically so "the plaintext is not on disk" is a claim this suite can
// actually test. A stub that stored `sealed:<plaintext>` would make that
// assertion pass only by being unfalsifiable.
const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);
const testCipher = (available = true): SecretCipher => ({
  isAvailable: () => available,
  encrypt: (plaintext) => {
    const body = Buffer.from(plaintext, "utf8").map((b) => b ^ 0x5a);
    return Buffer.concat([MAGIC, body]);
  },
  decrypt: (ciphertext) => {
    if (!ciphertext.subarray(0, 4).equals(MAGIC)) throw new Error("not sealed by this cipher");
    return Buffer.from(ciphertext.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
  },
});

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relayium-secrets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fail closed", () => {
  it("refuses to write when the platform cipher is unavailable", async () => {
    const store = new SecretStore(dir, testCipher(false));
    await expect(store.put("account-bearer", "t")).rejects.toMatchObject({
      code: "encryption-unavailable",
    });
    // And nothing was written in the clear as a consolation.
    await expect(readFile(join(dir, "account-bearer.bin"))).rejects.toThrow();
  });

  it("refuses to read when the cipher is unavailable, rather than guessing", async () => {
    await new SecretStore(dir, testCipher(true)).put("k", "v");
    await expect(new SecretStore(dir, testCipher(false)).get("k")).rejects.toMatchObject({
      code: "encryption-unavailable",
    });
  });

  it("never stores the plaintext", async () => {
    const store = new SecretStore(dir, testCipher());
    await store.put("account-bearer", "super-secret-token");
    const raw = await readFile(join(dir, "account-bearer.bin"), "utf8");
    expect(raw).not.toContain("super-secret-token");
  });
});

describe("failure classification", () => {
  it("distinguishes absent from unreadable", async () => {
    const store = new SecretStore(dir, testCipher());
    await expect(store.get("missing")).rejects.toMatchObject({ code: "not-found" });

    // A directory in the secret's slot is an IO failure, not an absence. The
    // difference matters: "absent" licenses minting a replacement.
    await mkdir(join(dir, "occupied.bin"));
    await expect(store.get("occupied")).rejects.toMatchObject({ code: "unreadable" });
  });

  it("distinguishes undecryptable bytes from absence", async () => {
    const store = new SecretStore(dir, testCipher());
    await writeFile(join(dir, "foreign.bin"), "written under a different OS account");
    await expect(store.get("foreign")).rejects.toMatchObject({ code: "undecryptable" });
  });

  it("refuses a key that would not be a safe filename", async () => {
    const store = new SecretStore(dir, testCipher());
    await expect(store.get("../escape")).rejects.toMatchObject({ code: "invalid-key" });
    await expect(store.put("NUL", "x")).rejects.toMatchObject({ code: "invalid-key" });
  });

  it("bounds what it will store", async () => {
    const store = new SecretStore(dir, testCipher());
    await expect(store.put("big", "x".repeat(MAX_SECRET_BYTES + 1))).rejects.toMatchObject({
      code: "too-large",
    });
  });

  // The sealed ceiling must exceed the plaintext one by at least the cipher's
  // overhead, or a value the store AGREED to write is unreadable on the way
  // back — a bug that appears only at the size boundary and looks like
  // corruption.
  it("can read back the largest value it agreed to write", async () => {
    const store = new SecretStore(dir, testCipher());
    const largest = "x".repeat(MAX_SECRET_BYTES);
    await store.put("big", largest);
    expect(await store.get("big")).toBe(largest);
  });
});

describe("atomic replace", () => {
  it("leaves the previous value intact when the replacement fails", async () => {
    const store = new SecretStore(dir, testCipher());
    await store.put("account-bearer", "first");

    // A cipher that throws stands in for any interruption between "decide to
    // write" and "the new bytes are durable".
    const exploding = new SecretStore(dir, {
      isAvailable: () => true,
      encrypt: () => {
        throw new Error("interrupted");
      },
      decrypt: testCipher().decrypt,
    });
    await expect(exploding.put("account-bearer", "second")).rejects.toThrow();

    expect(await store.get("account-bearer")).toBe("first");
  });

  // The leak this closes: a throw from `write`/`sync` used to skip the removal,
  // because only the rename failure path cleaned up.
  it("removes the temp file when the write itself fails, keeping the old value", async () => {
    const store = new SecretStore(dir, testCipher());
    await store.put("account-bearer", "first");

    const exploding = new SecretStore(dir, {
      isAvailable: () => true,
      encrypt: () => {
        // A Buffer whose `write` will throw when the store tries to use it.
        const bad = Buffer.from("x");
        Object.defineProperty(bad, "byteLength", {
          get() {
            throw new Error("interrupted mid-write");
          },
        });
        return bad;
      },
      decrypt: testCipher().decrypt,
    });
    await expect(exploding.put("account-bearer", "second")).rejects.toThrow();

    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await store.get("account-bearer")).toBe("first");
  });

  it("leaves no temp files behind", async () => {
    const store = new SecretStore(dir, testCipher());
    await store.put("k", "v");
    await store.put("k", "v2");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await store.get("k")).toBe("v2");
  });

  it("serialises concurrent writers to one key", async () => {
    const store = new SecretStore(dir, testCipher());
    await Promise.all([store.put("k", "a"), store.put("k", "b"), store.put("k", "c")]);
    // Whichever won, the value is one of the three and not a mixture.
    expect(["a", "b", "c"]).toContain(await store.get("k"));
  });
});

describe("putIfAbsent", () => {
  it("creates once and reports which caller created it", async () => {
    const store = new SecretStore(dir, testCipher());
    expect(await store.putIfAbsent("k", "first")).toEqual({ created: true, value: "first" });
    expect(await store.putIfAbsent("k", "second")).toEqual({ created: false, value: "first" });
  });

  it("refuses to create over bytes it cannot read", async () => {
    const store = new SecretStore(dir, testCipher());
    await writeFile(join(dir, "k.bin"), "foreign");
    await expect(store.putIfAbsent("k", "new")).rejects.toMatchObject({ code: "undecryptable" });
  });
});
