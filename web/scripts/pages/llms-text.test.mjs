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

  // An answering model reads this file to decide what to tell someone about the
  // cross-network product. Leaving the unified workspace out of the pairing-code
  // bullet let it describe a surface that stopped existing on 2026-08-10 — one
  // where files and messages are separate flows across networks.
  it("states that a pairing-code room gets the same shared workspace", () => {
    expect(llms).toContain("Two up-to-date browsers get the same shared workspace here as on the same network");
    expect(llms).toContain("one end-to-end encrypted connection carrying files and ephemeral text together");
    expect(llms).toContain("one optional verification code (SAS) rather than one per session");
    // Relayed and therefore bounded — relay-deadline.ts derives it from the TURN
    // REST credential, so this is a product fact and not an implementation note.
    expect(llms).toContain("bounded lifetime derived from the TURN credential");
    // The exact-match capability gate, which is what keeps this from overclaiming.
    expect(llms).toContain("older browsers, the native apps, the CLI — keep the separate file and text flows");
    // The same-network bullet has to describe the same one surface, or the two
    // bullets teach a reader that the rooms differ in a way they no longer do.
    expect(llms).toContain("the peer card offers one action, which opens a shared workspace");
    expect(llms).not.toMatch(/pairing[- ]code[^.]{0,80}(?:older|legacy|separate) (?:controls|surface|flows?)/i);
  });

  it("states the account boundary for pairing-code creation and joining", () => {
    expect(llms).toContain("Same-network transfers need no account");
    expect(llms).toContain("Creating a cross-network file or text pairing code requires sign-in");
    expect(llms).toContain("joining with a code does not");
  });

  it("pins pairing-code shape and expiry, and separates it from the SAS", () => {
    // Both are six digits now, so the file cannot rely on "characters vs digits"
    // to tell them apart — it has to say so.
    expect(llms).toContain("6-digit pairing code");
    expect(llms).toContain("Codes expire 5 minutes");
    expect(llms).toContain("six decimal digits (0-9, leading zeros included)");
    expect(llms).toContain("not the same value as the 6-digit SAS");
    expect(llms).toContain("6-digit Short Authentication String (SAS)");
    // The alphabet and the two TTLs this file has carried before. Any of them
    // reappearing means the format or the window moved and this file was left
    // behind — which is exactly what happened at 5 -> 30 minutes.
    expect(llms).not.toMatch(/6-character/i);
    expect(llms).not.toMatch(/ACDEFHJKMNPRTWXY/);
    expect(llms).not.toMatch(/codes? (?:live|last|expire(?:s)?) (?:15|30) minutes/i);
  });

  // The SAS is opt-in. A file that describes it as something the product always
  // does would be teaching an LLM to tell users they are protected by a check
  // their browser never showed them.
  it("says the SAS comparison is optional and bounds what turning it off changes", () => {
    expect(llms).toMatch(/Anti man-in-the-middle \(optional\)/);
    expect(llms).toContain("it is off by default");
    expect(llms).toContain("only when a person actually compares the two values");
    expect(llms).toContain("it never disables commit-then-reveal");
    expect(llms).toContain("receiving files still asks before anything is saved");
  });

  it("distinguishes browser TURN ciphertext from direct-only CLI text", () => {
    expect(llms).toContain("cross-network browser file and text sessions carry end-to-end encrypted ciphertext through TURN by design");
    expect(llms).toContain("CLI text uses a separate direct-only protocol");
    expect(llms).toContain("CLI text is direct-only and does not use TURN");
    expect(llms).not.toMatch(/(?:file|message|realtime) bytes (?:never|do not) touch the server/i);
    expect(llms).not.toMatch(/all realtime transfers .*need no account/i);
  });

  it("keeps browser and CLI SAS constructions protocol-specific", () => {
    expect(llms).toContain("derived from the two X25519 endpoint public keys");
    expect(llms).toContain("derived from the two pinned TLS certificate fingerprints");
    expect(llms).toContain("authenticate endpoints rather than proving that no server or TURN relay exists");
    expect(llms).not.toMatch(/SAS\) is derived from the session keys/i);
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
