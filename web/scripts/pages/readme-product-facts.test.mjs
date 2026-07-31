import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readme = readFileSync(resolve(process.cwd(), "../README.md"), "utf8");
const prose = readme.replace(/\s+/g, " ");

describe("README product facts", () => {
  it("defines Relayium as file plus ephemeral text transfer", () => {
    expect(readme).toContain("next-generation file and ephemeral text transfer protocol");
    expect(readme).toContain("The same protocol also carries **ephemeral text**");
    expect(readme).toContain("65,536 UTF-8 bytes");
    expect(readme).toContain("Multi-file batches** (up to 1,000)");
  });

  it("states the cross-network account boundary", () => {
    expect(prose).toContain(
      "Creating a cross-network pairing code for files or text requires sign-in; joining with that code does not",
    );
  });

  it("distinguishes LAN, browser TURN, and CLI content paths", () => {
    expect(prose).toContain("On a LAN, file bytes stream directly between devices");
    expect(prose).toContain("Cross-network browser transfers use a TURN relay by design");
    expect(readme).toContain("The CLI is direct-only");
    expect(readme).not.toContain("Files never hit a server");
    expect(readme).not.toContain("file bytes flow over the WebRTC DataChannel and **never traverse the server**");
  });
});
