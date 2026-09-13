import { describe, expect, it, vi } from "vitest";
import { DpapiCipher, DpapiCipherError } from "../../src/main/secret/dpapi-cipher.js";
import { classify, unwrap } from "../../src/main/secret/envelope.js";
import { MAX_PLAINTEXT_BYTES, OP_OPEN, OP_SEAL } from "../../src/main/secret/protocol.js";
import type { HelperTransport, TransportResult } from "../../src/main/secret/helper-transport.js";

const transport = (fn: (op: number, payload: Buffer) => TransportResult): HelperTransport => ({
  invoke: async (op, payload) => fn(op, payload),
});
const code = async (p: Promise<unknown>) => {
  try { await p; return "no-throw"; } catch (e) { return e instanceof DpapiCipherError ? e.code : "wrong-error"; }
};

describe("seal", () => {
  it("sends plaintext and wraps the returned blob", async () => {
    const seen: number[] = [];
    const cipher = new DpapiCipher(transport((op, payload) => {
      seen.push(op);
      expect(payload.toString("utf8")).toBe("token");
      return { ok: true, payload: Buffer.from("protected") };
    }));
    const sealed = await cipher.seal("token");
    expect(seen).toEqual([OP_SEAL]);
    expect(classify(sealed)).toBe("relayium-v1");
    expect(unwrap(sealed).toString()).toBe("protected");
  });

  it("refuses an over-bound plaintext before spawning anything", async () => {
    const invoke = vi.fn();
    const cipher = new DpapiCipher({ invoke });
    expect(await code(cipher.seal("x".repeat(MAX_PLAINTEXT_BYTES + 1)))).toBe("too-large");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cannot report a seal as undecryptable", async () => {
    // There is nothing to decrypt yet, so a refusal here is the helper
    // declining, not bad data.
    const cipher = new DpapiCipher(transport(() => ({ ok: false, failure: "refused" })));
    expect(await code(cipher.seal("t"))).toBe("helper-unavailable");
  });
});

describe("open", () => {
  it("strips the discriminator — the helper never sees it", async () => {
    const cipher = new DpapiCipher(transport((op, payload) => {
      expect(op).toBe(OP_OPEN);
      expect(payload.toString()).toBe("protected");
      return { ok: true, payload: Buffer.from("token", "utf8") };
    }));
    const sealed = await new DpapiCipher(transport(() => ({ ok: true, payload: Buffer.from("protected") }))).seal("t");
    expect(await cipher.open(sealed)).toBe("token");
  });

  it("maps refused to undecryptable, not to a transient failure", async () => {
    // `refused` now also covers the helper's integrity check rejecting a blob
    // CryptUnprotectData returned success for. That is a fact about the data.
    const cipher = new DpapiCipher(transport(() => ({ ok: false, failure: "refused" })));
    expect(await code(cipher.open(Buffer.from([0x52, 0x4c, 0x59, 0x4d, 0x01, 9])))).toBe("undecryptable");
  });

  it("maps helper-unavailable through unchanged", async () => {
    const cipher = new DpapiCipher(transport(() => ({ ok: false, failure: "helper-unavailable" })));
    expect(await code(cipher.open(Buffer.from([0x52, 0x4c, 0x59, 0x4d, 0x01, 9])))).toBe("helper-unavailable");
  });

  it("refuses a payload that is not valid UTF-8 rather than decoding it lossily", async () => {
    const cipher = new DpapiCipher(transport(() => ({ ok: true, payload: Buffer.from([0xff, 0xfe, 0xfd]) })));
    expect(await code(cipher.open(Buffer.from([0x52, 0x4c, 0x59, 0x4d, 0x01, 9])))).toBe("undecryptable");
  });
});

describe("errors carry no secret", () => {
  it("has a message equal to its closed code", async () => {
    const cipher = new DpapiCipher(transport(() => ({ ok: false, failure: "refused" })));
    try {
      await cipher.open(Buffer.from([0x52, 0x4c, 0x59, 0x4d, 0x01, 9]));
    } catch (err) {
      expect((err as Error).message).toBe("undecryptable");
    }
  });
});
