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
    expect(readme).not.toContain("Files never hit a server");
    expect(readme).not.toContain("file bytes flow over the WebRTC DataChannel and **never traverse the server**");
  });

  // `relayium up` uploads a client-side-encrypted copy into hosted storage
  // (server/cmd/relayium/cloud.go runUp) and the server truncates its TTL to the
  // account plan's cap (cloud_ttl_notice_test.go), so it is metered storage by
  // construction. Until 2026-08-28 this README said the opposite three ways:
  // "every CLI mode" was unmetered and free, the CLI was "Completely free", and
  // "The CLI is direct-only" — the last of which an earlier version of THIS FILE
  // required verbatim, so the guard was pinning the defect in place. The rule is
  // now shaped the other way round: the overbroad claims may not come back, and
  // the exception has to stay named.
  it("never calls every CLI mode direct, free, or unmetered", () => {
    for (const retired of [
      "every CLI mode",
      "The CLI is direct-only",
      "Completely free",
    ]) {
      expect(readme, `the retired claim came back: ${retired}`).not.toContain(retired);
    }
    // Not just the exact retired strings — the claim shape, in either order.
    expect(prose).not.toMatch(/\b(every|all|any) CLI (mode|command|verb)s?\b/i);
    expect(prose).not.toMatch(/\bthe CLI (is|are|stays?) (completely |entirely |always )?(free|direct|unmetered)\b/i);
  });

  // The plan has four caps and they measure four different things
  // (server/account/plan_enforce.go): monthly traffic is hosted upload +
  // hosted download + billable relay; storage is how much ciphertext is live
  // right now; retention is how long a stored file may live; the daily upload
  // quota is a rolling 24-hour window. README called relay and storage alike
  // "a monthly allowance of both", which makes storage sound like a monthly
  // budget you can spend down and refill — it is occupancy, and deleting a
  // file frees it immediately while refunding no traffic.
  it("keeps the four plan limits four, and storage out of the monthly bucket", () => {
    for (const dimension of [
      /monthly traffic allowance/i,
      /storage cap/i,
      /retention window/i,
      /daily upload quota/i,
    ])
      expect(readme, `${dimension} is missing`).toMatch(dimension);
    // What monthly traffic actually sums, said once rather than implied.
    expect(readme).toMatch(/hosted uploads?,? hosted downloads? and relayed bytes/i);
    expect(readme).toMatch(/occupancy rather than a monthly total|hosted uploads \+ hosted downloads \+ relayed bytes/i);
    // The retired shape, and the shapes it could return as.
    expect(readme).not.toContain("gets a monthly allowance of both");
    expect(readme).not.toMatch(/monthly[^.\n]{0,40}\bstorage\b/i);
    expect(readme).not.toMatch(/\bstorage\b[^.\n]{0,25}\bper month\b/i);
  });

  it("names `up` as the hosted-storage exception wherever the CLI is called direct", () => {
    // The honest replacement has to be present, not merely the absence above: a
    // reader deciding whether `relayium up` costs them anything must be told.
    expect(prose).toContain("The one CLI mode that is not direct is `relayium up`");
    expect(prose).toMatch(/`relayium up`[^.]{0,200}hosted storage/);
    expect(prose).toMatch(/`relayium up`[^.]{0,400}exactly like a stored download link/);
    expect(prose).not.toMatch(/`relayium up`[^.]{0,400}storage cap and\s+retention window/);
    // And the direct modes still have to be enumerable, or "not free" replaces
    // one wrong claim with another.
    for (const mode of ["`push`/`pull`", "`sync`", "daemon-direct", "`send`/`receive`", "`text`"]) {
      expect(prose, `the direct-mode list lost ${mode}`).toContain(mode);
    }
  });
});
