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

describe("activity announcer", () => {
  it("appends the code to every legacy edge, exactly as before", () => {
    const announcer = createActivityAnnouncer();
    for (const edge of [consent, progress, consent]) {
      expect(announcer.announce(edge, legacy())).toBe(
        `${edge.lead}. ${CODE} 123456. Compare it`,
      );
    }
  });

  it("says a mixed link's code on the first edge and not on the next lane", () => {
    const announcer = createActivityAnnouncer();
    expect(announcer.announce(consent, mixed(7))).toBe(
      "Alice wants to send you 3 files. Code 123456. Compare it",
    );
    // Same link, later edge: the header still shows the code, so repeating it
    // would make one authentication step sound like two.
    expect(announcer.announce(progress, mixed(7))).toBe("Sending…");
  });

  it("announces a later link that produced the SAME code — the dedupe is per link", () => {
    const announcer = createActivityAnnouncer();
    expect(announcer.announce(consent, mixed(7))).toContain("123456");
    // The link ends (teardown bumps the generation) and a new one opens whose
    // six digits collide with the old ones. This is a fresh authentication step
    // and a screen reader user must be told the code again. Keying the dedupe on
    // the digits instead of the link is exactly the bug this pins.
    expect(announcer.announce(consent, mixed(9))).toBe(
      "Alice wants to send you 3 files. Code 123456. Compare it",
    );
    expect(announcer.announce(progress, mixed(9))).toBe("Sending…");
  });

  it("does not let a mixed link silence a later legacy edge", () => {
    const announcer = createActivityAnnouncer();
    announcer.announce(consent, mixed(3));
    expect(announcer.announce(consent, legacy(3))).toContain("Code 123456");
    // …and a mixed link that reuses that generation still gets announced,
    // because the legacy edge dropped the memory.
    expect(announcer.announce(consent, mixed(3))).toContain("Code 123456");
  });

  it("leaves an edge that carries no code alone in both modes", () => {
    const announcer = createActivityAnnouncer();
    expect(announcer.announce(noCode, mixed(1))).toBe(noCode.lead);
    expect(announcer.announce(noCode, legacy())).toBe(noCode.lead);
    // A code-less edge must not consume the once-per-link allowance either.
    expect(announcer.announce(consent, mixed(1))).toContain("Code 123456");
  });

  it("keeps its memory per instance, so it cannot leak across page sessions", () => {
    const first = createActivityAnnouncer();
    expect(first.announce(consent, mixed(1))).toContain("Code 123456");
    expect(first.announce(consent, mixed(1))).not.toContain("Code 123456");
    expect(createActivityAnnouncer().announce(consent, mixed(1))).toContain("Code 123456");
  });
});
