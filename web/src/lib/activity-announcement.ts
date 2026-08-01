// What the polite live region says when a new verification/consent edge appears.
//
// This lives outside App.svelte because it is the one announcement rule that has
// to *remember* something: a unified (`link/1`) workspace reads its verification
// code out on the first consent edge and not again on the next lane, since the
// same code stays visible in the persistent header. A rule that remembers is a
// rule whose memory can outlive what it remembered — and a screen reader user
// who is never told the code of their *second* link has lost the only channel
// they had for that authentication step. So the memory and its lifetime live
// here, where a test can actually drive two links past it.

/** One decision-bearing edge, already localized by the caller. */
export interface ActivityEdge {
  /** The edge itself: "Alice wants to send you 3 files", "Sending…". */
  readonly lead: string;
  /** The verification code this edge carries, if it carries one. */
  readonly sas?: string;
  /** The localized "compare it with theirs" tail that follows the code. */
  readonly sasCompare?: string;
}

export interface AnnouncementContext {
  /** True while the unified workspace owns the screen for this peer. */
  readonly mixed: boolean;
  /**
   * Identity of the current authenticated link. Any change is a new
   * authentication step — including a later link that happens to produce the
   * same six digits. Never compare the digits themselves: a 1-in-10^6 collision
   * is rare by accident and cheap on purpose for a relay that would like one
   * announcement suppressed.
   */
  readonly linkGeneration: number;
  /** Localized "Code" label placed before the digits. */
  readonly codeLabel: string;
}

export interface ActivityAnnouncer {
  /** The sentence for this edge. Calling it records that the code was said. */
  announce(edge: ActivityEdge, ctx: AnnouncementContext): string;
}

export function createActivityAnnouncer(): ActivityAnnouncer {
  // The link whose code has already been read out; null means "none yet".
  let announcedGeneration: number | null = null;
  return {
    announce(edge, ctx) {
      if (!edge.sas) return edge.lead;
      if (ctx.mixed) {
        if (announcedGeneration === ctx.linkGeneration) return edge.lead;
        announcedGeneration = ctx.linkGeneration;
      } else {
        // A legacy surface has no single link speaking for both lanes, so it
        // says the code on every edge exactly as it always did. Dropping the
        // memory here as well keeps the mixed branch from ever being satisfied
        // by a generation that belongs to a link nobody is looking at.
        announcedGeneration = null;
      }
      return `${edge.lead}. ${ctx.codeLabel} ${edge.sas}. ${edge.sasCompare}`;
    },
  };
}
