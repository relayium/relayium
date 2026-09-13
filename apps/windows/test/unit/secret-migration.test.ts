import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore, SecretStoreError, secretHelperPath, type SecretCipher } from "../../src/main/secrets.js";
import { VersionedCipher } from "../../src/main/secret/versioned-cipher.js";
import { DpapiCipher } from "../../src/main/secret/dpapi-cipher.js";
import type { TransportResult } from "../../src/main/secret/helper-transport.js";

const LEGACY = Buffer.concat([Buffer.from("v10"), Buffer.from("legacy-bytes")]);
const CURRENT = (raw: string) => Buffer.concat([Buffer.from([0x52, 0x4c, 0x59, 0x4d, 0x01]), Buffer.from(raw)]);

/** A cipher that reads both formats and always writes the current one. */
const cipher = (over: Partial<SecretCipher> = {}): SecretCipher => ({
  isAvailable: () => true,
  encrypt: async (plaintext) => CURRENT(`sealed:${plaintext}`),
  decrypt: async (blob) => blob.subarray(5).toString().replace(/^sealed:/, ""),
  openWithMigration: async (blob) =>
    blob.subarray(0, 3).toString() === "v10"
      ? { value: "recovered", needsMigration: true }
      : { value: blob.subarray(5).toString().replace(/^sealed:/, ""), needsMigration: false },
  ...over,
});

const withStore = async (c: SecretCipher, body: (store: SecretStore, dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "relayium-migration-"));
  mkdirSync(dir, { recursive: true });
  try {
    await body(new SecretStore(dir, c), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("legacy data migrates on read", () => {
  it("returns the plaintext and re-seals in the current format", async () => {
    await withStore(cipher(), async (store, dir) => {
      const file = join(dir, "identity.bin");
      writeFileSync(file, LEGACY);
      expect(await store.get("identity")).toBe("recovered");
      const after = readFileSync(file);
      expect(after.subarray(0, 4).toString("ascii")).toBe("RLYM");
      expect(after.toString()).toContain("sealed:recovered");
    });
  });

  it("does not deadlock — the write happens inside the same serialized section", async () => {
    // `get` calling `put` would enqueue behind itself on that key's chain and
    // never resolve. A timeout here IS the deadlock assertion.
    await withStore(cipher(), async (store, dir) => {
      writeFileSync(join(dir, "identity.bin"), LEGACY);
      const value = await Promise.race([
        store.get("identity"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("deadlocked")), 2000)),
      ]);
      expect(value).toBe("recovered");
    });
  });
});

describe("a failed migration keeps the only readable copy", () => {
  it("retains the old bytes and still returns the plaintext when sealing fails", async () => {
    const c = cipher({ encrypt: async () => { throw new Error("helper down"); } });
    await withStore(c, async (store, dir) => {
      const file = join(dir, "identity.bin");
      writeFileSync(file, LEGACY);
      expect(await store.get("identity")).toBe("recovered");
      // Untouched: the read succeeded, and an optimisation failing must not
      // cost the user the one copy that works.
      expect(readFileSync(file).equals(LEGACY)).toBe(true);
    });
  });

  it("retains the old bytes when the re-sealed blob will not read back", async () => {
    // The defect that started this: a write reporting success that cannot be
    // read afterwards. The legacy blob is replaced only after a verified round
    // trip.
    const c = cipher({
      openWithMigration: async (blob) =>
        blob.subarray(0, 3).toString() === "v10"
          ? { value: "recovered", needsMigration: true }
          : { value: "CORRUPT", needsMigration: false },
    });
    await withStore(c, async (store, dir) => {
      const file = join(dir, "identity.bin");
      writeFileSync(file, LEGACY);
      expect(await store.get("identity")).toBe("recovered");
      expect(readFileSync(file).equals(LEGACY)).toBe(true);
    });
  });
});

describe("unreadable data is never reset", () => {
  it("throws undecryptable and leaves the bytes alone", async () => {
    const c = cipher({ openWithMigration: async () => { throw new Error("no key"); } });
    await withStore(c, async (store, dir) => {
      const file = join(dir, "identity.bin");
      writeFileSync(file, LEGACY);
      await expect(store.get("identity")).rejects.toThrow();
      expect(readFileSync(file).equals(LEGACY)).toBe(true);
    });
  });

  it("does not re-seal a blob that was already current", async () => {
    const encrypt = vi.fn(async (p: string) => CURRENT(`sealed:${p}`));
    await withStore(cipher({ encrypt }), async (store, dir) => {
      writeFileSync(join(dir, "identity.bin"), CURRENT("sealed:already"));
      expect(await store.get("identity")).toBe("already");
      expect(encrypt).not.toHaveBeenCalled();
    });
  });
});

describe("the helper is resolved from two fixed locations", () => {
  it("uses the packaged resource when packaged", () => {
    expect(secretHelperPath(true, "C:\\app\\resources", "C:\\app\\resources\\app.asar")).toBe(
      "C:\\app\\resources\\relayium-secret-helper.exe",
    );
  });

  it("uses the engineering build directory when not packaged", () => {
    expect(secretHelperPath(false, "C:\\ignored", "C:\\src\\apps\\windows")).toBe(
      "C:\\src\\apps\\windows\\native\\build\\relayium-secret-helper.exe",
    );
  });

  it("never consults PATH or an environment override", () => {
    // The process is about to hand this binary the account bearer. "Whichever
    // one we found" is not an acceptable answer to which binary that is, so the
    // name is fixed and the only variable is packaged vs not.
    for (const packaged of [true, false]) {
      const resolved = secretHelperPath(packaged, "R", "A");
      expect(resolved.endsWith("relayium-secret-helper.exe")).toBe(true);
      expect(resolved).not.toBe("relayium-secret-helper.exe");
    }
  });
});

// ---------------------------------------------------------------------------
// The real VersionedCipher through the real SecretStore. The cipher alone
// cannot show what the STORE does with each outcome, and it is the store that
// decides whether an identity survives.
// ---------------------------------------------------------------------------

describe("VersionedCipher composed with SecretStore", () => {
  /** Echoes, so a seal really can be opened again — the read-back guard is real. */
  const echo = (): ((op: number, payload: Buffer) => TransportResult) =>
    (_op, payload) => ({ ok: true, payload: Buffer.from(payload) });

  const composed = (
    transportResult: (op: number, payload: Buffer) => TransportResult,
    legacyValue?: () => string,
  ) => {
    const versioned = new VersionedCipher(
      new DpapiCipher({ invoke: async (op, payload) => transportResult(op, payload) }),
      {
        isAvailable: () => true,
        decrypt: () => (legacyValue ? legacyValue() : "legacy-plain"),
      },
    );
    const cipher: SecretCipher = {
      isAvailable: () => true,
      encrypt: (p) => versioned.seal(p),
      decrypt: async (b) => {
        const o = await versioned.open(b);
        if (o.kind === "ok") return o.value;
        throw new SecretStoreError(o.kind === "undecryptable" ? "undecryptable" : "encryption-unavailable");
      },
      openWithMigration: async (b) => {
        const o = await versioned.open(b);
        if (o.kind === "ok") return { value: o.value, needsMigration: o.needsMigration };
        throw new SecretStoreError(o.kind === "undecryptable" ? "undecryptable" : "encryption-unavailable");
      },
    };
    return cipher;
  };

  it("keeps 'helper unavailable' distinct from 'these bytes will not decrypt'", async () => {
    // The distinction the store must not flatten: one says retry, the other
    // says the identity is gone. A catch-all made them the same failure.
    await withStore(composed(() => ({ ok: false, failure: "helper-unavailable" })), async (store, dir) => {
      writeFileSync(join(dir, "identity.bin"), CURRENT("anything"));
      await expect(store.get("identity")).rejects.toMatchObject({ code: "encryption-unavailable" });
    });
  });

  it("reports a refused blob as undecryptable", async () => {
    await withStore(composed(() => ({ ok: false, failure: "refused" })), async (store, dir) => {
      writeFileSync(join(dir, "identity.bin"), CURRENT("anything"));
      await expect(store.get("identity")).rejects.toMatchObject({ code: "undecryptable" });
    });
  });

  it("does NOT mint a second identity when the helper is unavailable", async () => {
    // `putIfAbsent` is how the install ID is read. Falling through to the write
    // here would give one machine two identities — the exact silent replacement
    // this store exists to prevent.
    await withStore(composed(() => ({ ok: false, failure: "helper-unavailable" })), async (store, dir) => {
      const file = join(dir, "identity.bin");
      writeFileSync(file, CURRENT("existing"));
      const before = readFileSync(file);
      await expect(store.putIfAbsent("identity", "brand-new")).rejects.toMatchObject({
        code: "encryption-unavailable",
      });
      expect(readFileSync(file).equals(before)).toBe(true);
    });
  });

  it("migrates a legacy identity read through putIfAbsent", async () => {
    await withStore(composed(echo(), () => "install-id"), async (store, dir) => {
      const file = join(dir, "identity.bin");
      writeFileSync(file, LEGACY);
      const result = await store.putIfAbsent("identity", "would-be-new");
      expect(result).toEqual({ created: false, value: "install-id" });
      expect(readFileSync(file).subarray(0, 4).toString("ascii")).toBe("RLYM");
    });
  });

  it("refuses an unknown envelope without ever reaching the helper", async () => {
    let invoked = 0;
    const cipher = composed(() => { invoked += 1; return { ok: true, payload: Buffer.from("x") }; });
    await withStore(cipher, async (store, dir) => {
      writeFileSync(join(dir, "identity.bin"), Buffer.from("v12-not-a-format"));
      await expect(store.get("identity")).rejects.toMatchObject({ code: "undecryptable" });
      expect(invoked).toBe(0);
    });
  });
});
