import { describe, expect, it } from "vitest";
import { createActivityAnnouncer, type AnnouncementContext } from "./activity-announcement";

const CODE = "Code";
const legacy = (linkGeneration = 0): AnnouncementContext =>
  ({ mixed: false, linkGeneration, codeLabel: CODE });
const mixed = (linkGeneration: number): AnnouncementContext =>
  ({ mixed: true, linkGeneration, codeLabel: CODE });

const consent = { lead: "Alice wants to send you 3 files", sas: "123456", sasCompare: "Compare it" };
const progress = { lead: "Sending…", sas: "123456", sasCompare: "Compare it" };
const noCode = { lead: "Alice wants to send you files" };

/** Compose a sentence AND confirm it reached the live region — what every edge
 *  that actually stayed on screen does. The two-phase split matters only when a
 *  sentence is superseded before it renders, which has its own tests below. */
const said = (
  announcer: ReturnType<typeof createActivityAnnouncer>,
  edge: Parameters<ReturnType<typeof createActivityAnnouncer>["announce"]>[0],
  ctx: AnnouncementContext,
): string => {
  const announcement = announcer.announce(edge, ctx);
  announcement.confirm();
  return announcement.text;
};

describe("activity announcer", () => {
  it("appends the code to every legacy edge, exactly as before", () => {
    const announcer = createActivityAnnouncer();
    for (const edge of [consent, progress, consent]) {
      expect(said(announcer, edge, legacy())).toBe(
        `${edge.lead}. ${CODE} 123456. Compare it`,
      );
    }
  });

  it("says a mixed link's code on the first edge and not on the next lane", () => {
    const announcer = createActivityAnnouncer();
    expect(said(announcer, consent, mixed(7))).toBe(
      "Alice wants to send you 3 files. Code 123456. Compare it",
    );
    // Same link, later edge: the header still shows the code, so repeating it
    // would make one authentication step sound like two.
    expect(said(announcer, progress, mixed(7))).toBe("Sending…");
  });

  it("announces a later link that produced the SAME code — the dedupe is per link", () => {
    const announcer = createActivityAnnouncer();
    expect(said(announcer, consent, mixed(7))).toContain("123456");
    // The link ends (teardown bumps the generation) and a new one opens whose
    // six digits collide with the old ones. This is a fresh authentication step
    // and a screen reader user must be told the code again. Keying the dedupe on
    // the digits instead of the link is exactly the bug this pins.
    expect(said(announcer, consent, mixed(9))).toBe(
      "Alice wants to send you 3 files. Code 123456. Compare it",
    );
    expect(said(announcer, progress, mixed(9))).toBe("Sending…");
  });

  it("does not let a mixed link silence a later legacy edge", () => {
    const announcer = createActivityAnnouncer();
    said(announcer, consent, mixed(3));
    expect(said(announcer, consent, legacy(3))).toContain("Code 123456");
    // …and a mixed link that reuses that generation still gets announced,
    // because the legacy edge dropped the memory.
    expect(said(announcer, consent, mixed(3))).toContain("Code 123456");
  });

  it("leaves an edge that carries no code alone in both modes", () => {
    const announcer = createActivityAnnouncer();
    expect(said(announcer, noCode, mixed(1))).toBe(noCode.lead);
    expect(said(announcer, noCode, legacy())).toBe(noCode.lead);
    // A code-less edge must not consume the once-per-link allowance either.
    expect(said(announcer, consent, mixed(1))).toContain("Code 123456");
  });

  it("keeps its memory per instance, so it cannot leak across page sessions", () => {
    const first = createActivityAnnouncer();
    expect(said(first, consent, mixed(1))).toContain("Code 123456");
    expect(said(first, consent, mixed(1))).not.toContain("Code 123456");
    expect(said(createActivityAnnouncer(), consent, mixed(1))).toContain("Code 123456");
  });

  // ── composing is not saying ────────────────────────────────────────────────
  // A sentence is a pending state write. A newer edge arriving before the next
  // flush replaces it, and the two writes coalesce, so the earlier sentence
  // never reaches the DOM at all. Spending the once-per-link allowance at
  // COMPOSE time therefore let a sentence nobody ever heard count as "the code
  // was said", and the edge that did land dropped the code — the link
  // authenticated and its code was never announced. Measured on a real glare
  // between two tabs opening the text lane at once (e2e/mixed-link.mjs).
  describe("the once-per-link allowance is spent by rendering, not by composing", () => {
    it("keeps the code for the next edge when a sentence never reached the screen", () => {
      const announcer = createActivityAnnouncer();
      // "Waiting for the other device to accept…" is composed, then the glare
      // flips this lane to an incoming request before Svelte flushes.
      expect(announcer.announce(progress, mixed(1)).text).toContain("Code 123456");
      // Never confirmed, so this link has still never said its code, and the
      // edge that actually lands has to carry it.
      const landed = announcer.announce(consent, mixed(1));
      expect(landed.text).toBe("Alice wants to send you 3 files. Code 123456. Compare it");
      landed.confirm();
      // Now — and only now — a later lane on the same link stays quiet.
      expect(announcer.announce(progress, mixed(1)).text).toBe("Sending…");
    });

    it("does not drop a mixed link's memory for a legacy sentence that never rendered", () => {
      const announcer = createActivityAnnouncer();
      said(announcer, consent, mixed(4));
      // A legacy edge composed and superseded must not hand the mixed link its
      // allowance back: the code IS still on screen in the trust header.
      announcer.announce(consent, legacy(4));
      expect(announcer.announce(progress, mixed(4)).text).toBe("Sending…");
    });

    it("confirming twice spends the allowance once", () => {
      const announcer = createActivityAnnouncer();
      const first = announcer.announce(consent, mixed(2));
      first.confirm();
      first.confirm();
      expect(announcer.announce(progress, mixed(2)).text).toBe("Sending…");
    });

    it("composes the same sentence every time until one is confirmed", () => {
      const announcer = createActivityAnnouncer();
      const a = announcer.announce(consent, mixed(5)).text;
      const b = announcer.announce(consent, mixed(5)).text;
      expect(b).toBe(a);
      expect(b).toContain("Code 123456");
    });
  });
});
