import { describe, expect, it } from "vitest";
import { RELAYIUM_ENVELOPE_V1, classify, unwrap, wrap } from "../../src/main/secret/envelope.js";

const legacy = (tag: string) => Buffer.concat([Buffer.from(tag, "ascii"), Buffer.from([1, 2, 3])]);

describe("discriminator", () => {
  it("identifies the current envelope", () => {
    expect(classify(wrap(Buffer.from([9, 9])))).toBe("relayium-v1");
  });

  it("identifies both legacy OSCrypt prefixes", () => {
    expect(classify(legacy("v10"))).toBe("legacy-oscrypt");
    expect(classify(legacy("v11"))).toBe("legacy-oscrypt");
  });

  it("cannot confuse the two families", () => {
    // Byte 0 differs, so no suffix can make one look like the other.
    expect(RELAYIUM_ENVELOPE_V1[0]).not.toBe(Buffer.from("v", "ascii")[0]);
  });

  it("refuses anything else rather than guessing", () => {
    for (const blob of [Buffer.alloc(0), Buffer.from("v12abc"), Buffer.from("RLYM"), Buffer.from([0x52, 0x4c, 0x59, 0x4d, 0x02])]) {
      expect(classify(blob)).toBe("unknown");
    }
  });

  it("round-trips wrap and unwrap", () => {
    const raw = Buffer.from("dpapi-blob");
    expect(unwrap(wrap(raw)).equals(raw)).toBe(true);
  });
});
