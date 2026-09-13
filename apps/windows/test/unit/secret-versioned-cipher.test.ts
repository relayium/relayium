import { describe, expect, it, vi } from "vitest";
import { VersionedCipher } from "../../src/main/secret/versioned-cipher.js";
import { DpapiCipher } from "../../src/main/secret/dpapi-cipher.js";
import { wrap } from "../../src/main/secret/envelope.js";
import type { LegacyReader } from "../../src/main/secret/legacy-cipher.js";
import type { HelperTransport } from "../../src/main/secret/helper-transport.js";

const legacyBlob = Buffer.concat([Buffer.from("v10"), Buffer.from("old")]);
const legacy = (over: Partial<LegacyReader> = {}): LegacyReader => ({
  isAvailable: () => true,
  decrypt: () => "recovered",
  ...over,
});
const helper = (t: HelperTransport) => new DpapiCipher(t);

describe("read dispatch", () => {
  it("routes the current envelope to the helper, with no migration", async () => {
    const cipher = new VersionedCipher(
      helper({ invoke: async () => ({ ok: true, payload: Buffer.from("plain") }) }),
      legacy(),
    );
    expect(await cipher.open(wrap(Buffer.from("blob")))).toEqual({
      kind: "ok", value: "plain", needsMigration: false,
    });
  });

  it("routes a legacy blob to the legacy reader and flags migration", async () => {
    const invoke = vi.fn();
    const cipher = new VersionedCipher(helper({ invoke }), legacy());
    expect(await cipher.open(legacyBlob)).toEqual({ kind: "ok", value: "recovered", needsMigration: true });
    // The helper is not involved in reading legacy data.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an unknown envelope WITHOUT spawning the helper", async () => {
    const invoke = vi.fn();
    const cipher = new VersionedCipher(helper({ invoke }), legacy());
    expect(await cipher.open(Buffer.from("v12nonsense"))).toEqual({ kind: "undecryptable" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a failed legacy read as undecryptable, never as absent", async () => {
    const cipher = new VersionedCipher(
      helper({ invoke: vi.fn() }),
      legacy({ decrypt: () => { throw new Error("no key"); } }),
    );
    // The exact state of field installs: bytes intact, master key gone.
    expect(await cipher.open(legacyBlob)).toEqual({ kind: "undecryptable" });
  });

  it("separates an unavailable legacy cipher from bad data", async () => {
    const cipher = new VersionedCipher(helper({ invoke: vi.fn() }), legacy({ isAvailable: () => false }));
    expect(await cipher.open(legacyBlob)).toEqual({ kind: "helper-unavailable" });
  });
});

describe("writes", () => {
  it("always use the current envelope", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const, payload: Buffer.from("p") }));
    const cipher = new VersionedCipher(helper({ invoke }), legacy());
    const sealed = await cipher.seal("v");
    expect(invoke).toHaveBeenCalledOnce();
    expect(sealed.subarray(0, 4).toString("ascii")).toBe("RLYM");
  });

  it("has no path that can write the legacy format", () => {
    // `LegacyReader` has no encrypt member at all, so this is a type-level
    // guarantee rather than a discipline.
    expect("encrypt" in legacy()).toBe(false);
  });
});
