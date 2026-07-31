import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const llms = readFileSync(resolve(process.cwd(), "public/llms.txt"), "utf8");
const homepage = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const readme = readFileSync(resolve(process.cwd(), "../README.md"), "utf8");

describe("llms.txt file and ephemeral text product facts", () => {
  it("positions text as online-only, bounded, and not server-stored", () => {
    expect(llms).toContain("file and online-only ephemeral text transfer");
    expect(llms).toContain("both devices must be online at the same time");
    expect(llms).toContain("no offline delivery or server-side message history");
    expect(llms).toContain("65,536 UTF-8 bytes");
    expect(llms).toContain("Either endpoint can copy, log, screenshot, or otherwise retain text");
  });

  it("states the account boundary for pairing-code creation and joining", () => {
    expect(llms).toContain("Same-network transfers need no account");
    expect(llms).toContain("Creating a cross-network file or text pairing code requires sign-in");
    expect(llms).toContain("joining with a code does not");
  });

  it("pins pairing-code shape and expiry without confusing it with the SAS", () => {
    expect(llms).toContain("6-character code");
    expect(llms).toContain("Codes expire 5 minutes");
    expect(llms).toContain("6-digit Short Authentication String (SAS)");
    expect(llms).not.toMatch(/6-digit pairing code/i);
    expect(llms).not.toMatch(/codes? (?:live|last|expire(?:s)?) 15 minutes/i);
  });

  it("distinguishes browser TURN ciphertext from direct-only CLI text", () => {
    expect(llms).toContain("cross-network browser file and text sessions carry end-to-end encrypted ciphertext through TURN by design");
    expect(llms).toContain("CLI text uses a separate direct-only protocol");
    expect(llms).toContain("CLI text is direct-only and does not use TURN");
    expect(llms).not.toMatch(/(?:file|message|realtime) bytes (?:never|do not) touch the server/i);
    expect(llms).not.toMatch(/all realtime transfers .*need no account/i);
  });

  it("keeps the buffered-browser warning consistent across crawler sources", () => {
    for (const [name, copy] of [
      ["llms.txt", llms],
      ["index.html", homepage],
      ["README.md", readme],
    ]) {
      expect(copy, `${name}: warning threshold`).toContain("256 MB");
      expect(copy, `${name}: no stale recommendation`).not.toMatch(/(?:under|about) ~?200 MB/i);
    }
    expect(llms).toMatch(/conservative estimate, not a hard limit/i);
    expect(homepage).toMatch(/conservative estimate, not a hard limit/i);
    expect(readme).toMatch(/conservative estimate, not a hard limit/i);
  });
});
