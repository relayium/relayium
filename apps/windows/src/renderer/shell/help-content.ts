// The six answers each screen owes a reader, and which keys carry them.
//
// ## Why the content is a table and not markup
//
// Every screen answers the same six questions — what this is for, the shortest
// path through it, what Relayium can see, where things end up, what goes wrong,
// and what to do about it. Holding that shape in one table means a screen
// cannot quietly answer five of them: a missing key is a compile error, not a
// gap somebody notices a year later.
//
// The wording is checked against WINDOWS behaviour rather than ported. The Mac
// says received files go to Downloads, which is true there and false here,
// where a destination is chosen at every receive; it points at the Account
// screen to delete a stored file, which on this client lives with the send
// history instead. Copying those would have made the help wrong, and wrong help
// is worse than none.

import type { MessageKey } from "../i18n/messages.js";
import type { Page } from "./navigation.svelte.js";

export interface HelpContent {
  readonly purpose: MessageKey;
  /** The shortest path, in order. Three, because a fourth is a manual. */
  readonly steps: readonly [MessageKey, MessageKey, MessageKey];
  /** What Relayium can see. Named plainly, including where it cannot tell. */
  readonly boundary: MessageKey;
  readonly where: MessageKey;
  readonly failure: MessageKey;
  readonly recovery: MessageKey;
}

/**
 * Every browseable screen, so adding one without its help is a type error.
 *
 * `Record<Page, …>` rather than a partial map on purpose: a screen with no
 * answers is exactly the state this exists to remove.
 */
export const HELP: Readonly<Record<Page, HelpContent>> = {
  lan: {
    purpose: "helpLanPurpose",
    steps: ["helpLanStep1", "helpLanStep2", "helpLanStep3"],
    boundary: "helpLanBoundary",
    where: "helpLanWhere",
    failure: "helpLanFailure",
    recovery: "helpLanRecovery",
  },
  pair: {
    purpose: "helpPairPurpose",
    steps: ["helpPairStep1", "helpPairStep2", "helpPairStep3"],
    boundary: "helpPairBoundary",
    where: "helpPairWhere",
    failure: "helpPairFailure",
    recovery: "helpPairRecovery",
  },
  stored: {
    purpose: "helpStoredPurpose",
    steps: ["helpStoredStep1", "helpStoredStep2", "helpStoredStep3"],
    boundary: "helpStoredBoundary",
    where: "helpStoredWhere",
    failure: "helpStoredFailure",
    recovery: "helpStoredRecovery",
  },
  inbox: {
    purpose: "helpInboxPurpose",
    steps: ["helpInboxStep1", "helpInboxStep2", "helpInboxStep3"],
    boundary: "helpInboxBoundary",
    where: "helpInboxWhere",
    failure: "helpInboxFailure",
    recovery: "helpInboxRecovery",
  },
  account: {
    purpose: "helpAccountPurpose",
    steps: ["helpAccountStep1", "helpAccountStep2", "helpAccountStep3"],
    boundary: "helpAccountBoundary",
    where: "helpAccountWhere",
    failure: "helpAccountFailure",
    recovery: "helpAccountRecovery",
  },
};
