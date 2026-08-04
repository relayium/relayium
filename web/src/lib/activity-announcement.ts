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

/** A composed sentence, plus the memory effect it earns by actually being said. */
export interface Announcement {
  /** What to put in the live region. */
  readonly text: string;
  /**
   * Record that this sentence really reached the live region.
   *
   * Composing is deliberately pure, because composing is not saying. The
   * sentence is only a pending state write: an edge that arrives before the
   * next flush replaces it, the two writes coalesce, and the earlier sentence
   * never reaches the DOM at all. Spending the once-per-link allowance while
   * composing therefore let a sentence nobody could hear count as "the code was
   * said", and the edge that DID land then dropped the code — the link
   * authenticated and its code was never announced to a screen reader user.
   *
   * Measured on a real glare between two tabs opening the text lane at once:
   * "Waiting for the other device to accept… Code 977161" was composed and
   * superseded by "Mac-117 wants to send you a message" within one flush, and
   * the code was never spoken (e2e/mixed-link.mjs).
   *
   * Only the caller can know whether its sentence survived to the screen, so
   * only the caller commits. Idempotent: confirming twice spends nothing extra.
   */
  confirm(): void;
}

export interface ActivityAnnouncer {
  /** The sentence for this edge. Records nothing until `confirm()`. */
  announce(edge: ActivityEdge, ctx: AnnouncementContext): Announcement;
}

export function createActivityAnnouncer(): ActivityAnnouncer {
  // The link whose code has already been read out; null means "none yet".
  let announcedGeneration: number | null = null;
  const nothingToRecord = () => {};
  return {
    announce(edge, ctx) {
      if (!edge.sas) return { text: edge.lead, confirm: nothingToRecord };
      if (ctx.mixed && announcedGeneration === ctx.linkGeneration) {
        return { text: edge.lead, confirm: nothingToRecord };
      }
      return {
        text: `${edge.lead}. ${ctx.codeLabel} ${edge.sas}. ${edge.sasCompare}`,
        confirm: ctx.mixed
          ? () => { announcedGeneration = ctx.linkGeneration; }
          // A legacy surface has no single link speaking for both lanes, so it
          // says the code on every edge exactly as it always did. Dropping the
          // memory here as well keeps the mixed branch from ever being satisfied
          // by a generation that belongs to a link nobody is looking at — but
          // only once such an edge has actually been said, for the same reason
          // the mixed branch waits.
          : () => { announcedGeneration = null; },
      };
    },
  };
}
