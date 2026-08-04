// "Should the unified workspace open its text lane for this link?"
//
// A mixed link is often established by the FILE lane — the user picked files, or
// dropped them, and the link came up to carry them. The unified workspace then
// promises a composer as well, so the text lane is opened automatically. That
// automatic step is the whole reason this rule needs a model: an extra open is
// not a cosmetic glitch but a second consent prompt raised on the peer that
// nobody asked for.
//
// Deliberately pure and free of Svelte state. The interesting cases are all
// lifecycle mutations — a conversation that ended, a transport that was rebuilt
// under the same authentication step, a second link to the same peer — and each
// one is a two-line test here instead of a source-regex guess about a boolean
// buried in a component.

export interface UnifiedTextOpenState {
  /** An authenticated link object genuinely exists right now (PeerWorkspace's
   *  `hasLink`, NOT `usingMixed` — the latter is already true while a request is
   *  still in flight, and opening a lane there would race establishment). */
  hasLink: boolean;
  /** Identity of that link (PeerWorkspace's `linkGeneration`). It advances on
   *  establishment and teardown but NOT on an authenticated transport
   *  replacement, which is exactly the distinction this rule needs. */
  linkGeneration: number;
  /** The text lane has nothing at all on it. Every terminal state — ended,
   *  refused, failed, peerBusy — is not idle, so a conversation the user or the
   *  peer finished is never reopened underneath them. */
  textIdle: boolean;
}

export interface UnifiedTextOpener {
  shouldOpen(state: UnifiedTextOpenState): boolean;
  /** Record that this generation has been spent. Called by the orchestration
   *  BEFORE it starts the open, so a synchronous re-evaluation cannot open twice. */
  markOpened(generation: number): void;
  /** Forget everything. The explicit Disconnect action does this so the launcher
   *  cannot carry a spent generation into whatever comes next. */
  reset(): void;
}

export function createUnifiedTextOpener(): UnifiedTextOpener {
  // `null`, not -1 or 0: generation 0 is a real generation (the first link a
  // page ever makes), and it must not be indistinguishable from "never opened".
  let opened: number | null = null;
  return {
    shouldOpen({ hasLink, linkGeneration, textIdle }) {
      if (!hasLink) return false;
      if (!textIdle) return false;
      // Monotonic, not `!==`. Link identity only ever advances, so a value at or
      // below the spent one is either the same link or a stale sample of an
      // older one — and both must refuse. Plain inequality would answer "yes" to
      // a stale sample, opening a lane on a link that is already gone.
      return opened === null || linkGeneration > opened;
    },
    markOpened(generation) { opened = generation; },
    reset() { opened = null; },
  };
}
