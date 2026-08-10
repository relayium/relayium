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

  // The unified workspace is no longer LAN-scoped. `linkRoomActive()` is
  // `LINK_BUILD_SUPPORT` and nothing else (web/src/lib/peer-caps.svelte.ts), so a
  // default build advertises and routes `link/1` in a pairing-code room too —
  // web/e2e/code-room.mjs proves it in two real browsers. The README said the
  // opposite in the same breath as the claim itself ("Pairing-code (cross-network)
  // rooms and the native clients keep the existing separate file and message
  // flows"), which is the shape this pins: state the room scope, and never state
  // it as LAN-only again.
  it("scopes the shared workspace to both rooms, not to the LAN", () => {
    expect(prose).toContain("on a LAN and in a pairing-code");
    expect(prose).toContain("(cross-network) room alike");
    expect(prose).toContain("**one shared workspace**");
    // The capability gate is the real boundary and has to stay stated: an exact
    // `peerSupportsLink()` match, so these three keep the legacy surfaces.
    expect(prose).toContain("Peers that do not announce this exact capability keep the existing separate file and message flows");
    expect(prose).toMatch(/the native\s+clients, the CLI, and older browsers/);
    // Relayed links are bounded — the half a "one workspace everywhere" rewrite
    // is most likely to drop (web/src/lib/relay-deadline.ts).
    expect(prose).toContain("bounded lifetime derived from the relay credential");
    // The retired sentences, verbatim from the diff that removed them.
    expect(prose).not.toContain("Pairing-code (cross-network) rooms and the native clients keep the existing separate file and message flows");
    expect(prose).not.toContain("On a LAN, two up-to-date browsers do not choose between the two at all");
    expect(prose).not.toContain("shared LAN workspace");
    expect(prose).not.toMatch(/pairing-code[^.]{0,60}keep(?:s)? the (?:existing )?(?:separate|older)/i);
  });

  it("distinguishes LAN, browser TURN, and CLI content paths", () => {
    expect(prose).toContain("On a LAN, file bytes stream directly between devices");
    expect(prose).toContain("Cross-network browser transfers use a TURN relay by design");
    expect(readme).toContain("The CLI is direct-only");
    expect(readme).not.toContain("Files never hit a server");
    expect(readme).not.toContain("file bytes flow over the WebRTC DataChannel and **never traverse the server**");
  });
});
