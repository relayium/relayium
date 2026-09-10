import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore, type SecretCipher } from "../../src/main/secrets.js";
import {
  INSTALL_ID_KEY,
  INSTALL_ID_LENGTH,
  isValidInstallID,
  loadOrMintInstallID,
  mintInstallID,
} from "../../src/main/account/install-id.js";

const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(`sealed:${p}`, "utf8"),
  decrypt: (c) => {
    const t = c.toString("utf8");
    if (!t.startsWith("sealed:")) throw new Error("foreign");
    return t.slice(7);
  },
};

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relayium-install-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("canonical spelling", () => {
  // `server/account/installid.go` decodes with RawURLEncoding.Strict(). A
  // 32-byte value leaves two unused bits in its last character, so a permissive
  // decoder accepts four spellings of one value — and this string is compared
  // and indexed AS TEXT, so more than one spelling is more than one identity.
  it("accepts what it mints", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = mintInstallID();
      expect(id).toHaveLength(INSTALL_ID_LENGTH);
      expect(isValidInstallID(id)).toBe(true);
    }
  });

  it("refuses a non-canonical final character", () => {
    const id = mintInstallID();
    const canonical = id[INSTALL_ID_LENGTH - 1]!;
    // Find a different final character that decodes to the same 32 bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alternatives = [...alphabet].filter((c) => {
      if (c === canonical) return false;
      const candidate = id.slice(0, -1) + c;
      return Buffer.from(candidate, "base64url").equals(Buffer.from(id, "base64url"));
    });
    expect(alternatives.length).toBeGreaterThan(0);
    for (const alt of alternatives) expect(isValidInstallID(id.slice(0, -1) + alt)).toBe(false);
  });

  it("refuses wrong lengths, padding and non-alphabet characters", () => {
    expect(isValidInstallID("")).toBe(false);
    expect(isValidInstallID("a".repeat(42))).toBe(false);
    expect(isValidInstallID("a".repeat(44))).toBe(false);
    expect(isValidInstallID(`${"A".repeat(42)}=`)).toBe(false);
    expect(isValidInstallID(`${"A".repeat(42)}+`)).toBe(false);
  });
});

describe("persistence", () => {
  it("returns the same identity across calls", async () => {
    const store = new SecretStore(dir, cipher);
    const first = await loadOrMintInstallID(store);
    expect(await loadOrMintInstallID(store)).toBe(first);
  });

  // Two startup paths racing must not leave one machine claiming two device rows.
  it("returns one identity to concurrent callers", async () => {
    const store = new SecretStore(dir, cipher);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadOrMintInstallID(store)),
    );
    expect(new Set(results).size).toBe(1);
  });

  // The regression that matters: a briefly unreadable file must not mint a
  // second identity for one machine.
  it("propagates an unreadable identity instead of silently replacing it", async () => {
    const store = new SecretStore(dir, cipher);
    await mkdir(join(dir, `${INSTALL_ID_KEY}.bin`));
    await expect(loadOrMintInstallID(store)).rejects.toMatchObject({ code: "unreadable" });
  });

  it("propagates an undecryptable identity instead of replacing it", async () => {
    const store = new SecretStore(dir, cipher);
    await writeFile(join(dir, `${INSTALL_ID_KEY}.bin`), "written under another OS account");
    await expect(loadOrMintInstallID(store)).rejects.toMatchObject({ code: "undecryptable" });
  });

  it("replaces a readable but non-canonical value, which central would refuse", async () => {
    const store = new SecretStore(dir, cipher);
    await store.put(INSTALL_ID_KEY, "not-an-identity");
    const id = await loadOrMintInstallID(store);
    expect(isValidInstallID(id)).toBe(true);
  });

  it("survives a sign-out, which clears the bearer and never this key", async () => {
    const store = new SecretStore(dir, cipher);
    const id = await loadOrMintInstallID(store);
    await store.put("account-bearer", "token");
    await store.delete("account-bearer");
    expect(await loadOrMintInstallID(store)).toBe(id);
  });
});
