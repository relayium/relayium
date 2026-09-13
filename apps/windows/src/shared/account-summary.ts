// What the account screen is allowed to know.
//
// This file is the boundary. `src/main/account/summary.ts` parses three server
// documents into closed types that carry a bearer's worth of authority with
// them; this is the reduction of those types that may cross into a renderer,
// and the vocabulary a page renders. Nothing here is a credential, an origin, a
// URL, an IP address or an inbox key, and nothing here is derived from a value
// this process failed to read.
//
// ## Three sections, three outcomes, on purpose
//
// `/api/me`, `/api/me/usage` and `/api/devices` are three requests. The client
// keeps them separate so a broken usage endpoint cannot blank a profile, and
// this contract keeps them separate for the same reason one step further out: a
// page that received one object would have to invent a meaning for "half of it
// is missing", and the meaning it would invent is the dangerous one — a zero
// quota, an unlimited cap, or a free plan that nobody is actually on.
//
// So each section is independently `loading`, `ready` or `failed`, and a
// `failed` section is rendered as a failure with its own retry. That is the
// single most important rule in this file: **a read that did not happen is
// never a number.**
//
// ## What is deliberately absent
//
// * No bearer, no origin, no request URL. The renderer cannot address the
//   account API and must not be able to describe one.
// * No `LastIP`. The client already drops it; restating that here means the
//   field has no path to a page even if the client's reduction changed.
// * No inbox capabilities or public key — a row reports `enrolled`, a boolean.
// * No price, no checkout, no portal URL and no provider mutation of any kind.
//   Windows renders entitlement read-only; the one journey out is a fixed,
//   main-validated page named by a closed token below.
// * No plan inferred from `entitlementProvider`, `hasBilling` or `isTop`. Those
//   describe the provider, the Stripe customer and the upgrade ladder
//   respectively, and none of them is the tier a person is on.

/**
 * Why a section could not be read.
 *
 * A closed set, mapped in main from `AccountApiError`. Server prose never
 * appears here: the routes behind this mostly emit `http.Error` text, and a
 * string chosen by a server is not a sentence this app is willing to put on
 * somebody's screen or into a log.
 */
export type AccountFailureKind =
  /** Nobody is signed in. Not an error — a state. */
  | "signed-out"
  /** The credential could not be read, or this process is going away. */
  | "unavailable"
  /** The request did not reach a conclusion. */
  | "network"
  /** The request ran out of time. */
  | "timeout"
  /** The server answered, and the answer was a refusal. `status` says which. */
  | "refused"
  /**
   * The answer was not one this build can read.
   *
   * Malformed JSON, a response larger than the ceiling, an origin or redirect
   * this build refuses — and, importantly, a document from a NEWER server
   * carrying an entitlement provider this build does not understand. All four
   * mean the same thing to a person: this client cannot show you your account
   * right now. Guessing would be worse than saying so.
   */
  | "unreadable";

/** A read that failed, with the HTTP status when there was one. */
export interface AccountFailure {
  readonly kind: AccountFailureKind;
  /** Present only for `refused`. A number, never a body. */
  readonly status?: number;
}

/**
 * One independently-read part of the screen.
 *
 * `loading` is the state before main has answered, and it is NOT a value: a
 * page must render it as "reading", never as an empty account.
 */
export type AccountSection<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "failed"; readonly failure: AccountFailure };

/** `""` means no paid provider. Mirrors the client's closed set. */
export type AccountProviderView = "" | "stripe" | "apple" | "admin" | "multiple";
/** `""` means UNKNOWN. It does not mean monthly. */
export type AccountCycleView = "" | "monthly" | "yearly";

/**
 * What Apple says about the next renewal, reduced to what a page can honestly
 * state.
 *
 * The two product identifiers are dropped: they are Apple SKU strings, they
 * mean nothing to a person, and rendering one invites a client to map it to a
 * plan name — a second entitlement opinion, which is exactly what the account
 * client refuses to compute. `inGracePeriod` is the SERVER's computation and is
 * carried as such; re-deriving it from `graceUntil` against this machine's
 * clock would disagree with what is actually enforced.
 */
export type AccountRenewalView =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly renewalAt: number;
      readonly autoRenewEnabled: boolean;
      readonly inBillingRetry: boolean;
      readonly inGracePeriod: boolean;
      readonly graceUntil: number;
    };

/** Who the person is, and what the provider says about them. */
export interface AccountProfileView {
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly hasPassword: boolean;
  /** How this account can be signed in to. Method names, never credentials. */
  readonly linkedMethods: readonly string[];
  /**
   * The EFFECTIVE tier, including an administrator grant.
   *
   * May disagree with `subscriptionStatus`, which describes the PROVIDER. Both
   * are rendered; neither is reconciled into the other.
   */
  readonly planId: string;
  readonly subscriptionStatus: string;
  readonly subscriptionEnd: number;
  /**
   * A Stripe customer exists — i.e. a billing page is reachable.
   *
   * NOT "is subscribed": an App Store subscriber has `false`. It gates the link
   * out and nothing else, and it is never read as a plan.
   */
  readonly hasBilling: boolean;
  readonly billingCycle: AccountCycleView;
  readonly scheduledPlanId: string;
  readonly scheduledCycle: AccountCycleView;
  readonly entitlementProvider: AccountProviderView;
  readonly appleRenewal: AccountRenewalView;
}

/**
 * A ceiling in bytes or seconds. **`0` means unlimited.**
 *
 * Stated once, here, because every rule that follows from it is a rule about
 * not lying: no progress bar, no percentage, and above all no "100% full" for a
 * quota that has no limit.
 */
export type AccountCap = number;

/** What the plan advertises. NOT what is currently enforced. */
export interface AccountPlanView {
  readonly id: string;
  readonly name: string;
  readonly storageBytes: AccountCap;
  /**
   * The tier's NOMINAL monthly figure.
   *
   * Deliberately not the same number as `AccountUsageView.traffic.cap`, which
   * is the EFFECTIVE allowance after a mid-month tier change is prorated. A
   * page that rendered one as the other would show a progress bar against a
   * limit that is not the one being enforced.
   */
  readonly trafficBytes: AccountCap;
  /**
   * How long a stored transfer is kept, in seconds. The only place retention
   * appears on either endpoint — it does not exist on the profile.
   */
  readonly retentionSecs: AccountCap;
  /** Fail-closed: `false` does not prove an upgrade exists. Never a plan. */
  readonly isTop: boolean;
  readonly subscriptionStatus: string;
  readonly subscriptionEnd: number;
  readonly billingCycle: AccountCycleView;
  readonly scheduledPlanId: string;
  /** Best-effort on the server; may be `""` while `scheduledPlanId` is set. */
  readonly scheduledPlanName: string;
  readonly scheduledCycle: AccountCycleView;
  readonly entitlementProvider: AccountProviderView;
  readonly appleRenewal: AccountRenewalView;
}

/** What is actually being counted this period, against what is enforced. */
export interface AccountUsageView {
  readonly period: string;
  readonly resetsAt: number;
  /** `cap` is EFFECTIVE, and `0` is unlimited. See `AccountPlanView`. */
  readonly traffic: { readonly used: number; readonly cap: AccountCap };
  readonly storage: { readonly used: number; readonly cap: AccountCap };
  readonly plan: AccountPlanView;
}

/**
 * One device row.
 *
 * `id` travels because two of a person's machines can honestly have the same
 * name, and a list that could not tell them apart would ask somebody to confirm
 * revoking "Laptop" with no way to know which. It is an opaque server
 * identifier, not a credential.
 */
export interface AccountDeviceView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  /** The device this app is signed in on. The row a self-revoke warning is for. */
  readonly current: boolean;
  /** Whether it has enrolled for Device Inbox. Presence only. */
  readonly enrolled: boolean;
}

/**
 * Everything the account screen renders, as one snapshot.
 *
 * `epoch` is opaque and is the whole reason this is one object: a controller
 * compares it to drop an account's data before another account's is rendered,
 * and an answer that arrives carrying an older epoch is discarded rather than
 * merged. It carries no credential and identifies nothing outside this process.
 */
export interface AccountSummaryView {
  readonly epoch: number;
  /**
   * Whether a credential is actually held.
   *
   * Separate from the epoch because signing in changes this WITHOUT changing
   * that, and separate from the sections because "signed out" is not a failed
   * read — it is the ordinary state of a person who has not signed in.
   */
  readonly signedIn: boolean;
  readonly profile: AccountSection<AccountProfileView>;
  readonly usage: AccountSection<AccountUsageView>;
  readonly devices: AccountSection<readonly AccountDeviceView[]>;
}

/** The three sections, named — for a caller that refreshes one of them. */
export type AccountSectionName = "profile" | "usage" | "devices";

export const ACCOUNT_SECTIONS: readonly AccountSectionName[] = ["profile", "usage", "devices"];

/**
 * How a rename or a revoke ended.
 *
 * Closed, and deliberately including two outcomes that are neither success nor
 * failure:
 *
 * * `busy` — this row already has an operation running. The second click is
 *   refused rather than sent, because two revokes of one device is one revoke
 *   and one confusing failure.
 * * `uncertain` — the request was abandoned (quit, sign-out, a reload) while it
 *   was in flight, and this process does not know whether the server acted. It
 *   is reported as unknown. Calling it a failure would invite a retry of
 *   something that may already have happened; calling it a success would show a
 *   device as gone that may still be enrolled.
 */
export type AccountMutationOutcome =
  | { readonly kind: "renamed"; readonly name: string }
  | {
      readonly kind: "revoked";
      /** The revoked row was this device. */
      readonly self: boolean;
      /**
       * Main signed this app out as a result.
       *
       * `false` for a self-revoke means the account had already moved on by the
       * time the revoke landed, so the sign-out was deliberately NOT performed:
       * it would have signed out whoever is signed in now.
       */
      readonly signedOut: boolean;
    }
  /** No such row in the device list this process currently holds. */
  | { readonly kind: "unknown-device" }
  /** The name is empty, too long, or the server refused it as a label. */
  | { readonly kind: "invalid-name" }
  /** Another operation on this row is already running. Nothing was sent. */
  | { readonly kind: "busy" }
  /** Nobody is signed in any more. Nothing was sent. */
  | { readonly kind: "signed-out" }
  /** A quit is being decided, the page reloaded, or the account moved. */
  | { readonly kind: "unavailable" }
  /** Abandoned in flight. Whether the server acted is NOT known. */
  | { readonly kind: "uncertain" }
  | { readonly kind: "failed"; readonly failure: AccountFailure };

/**
 * What asking for the verification email again did.
 *
 * Its own union rather than a reuse of `AccountMutationOutcome`: none of the
 * device-shaped members can occur here, and a screen forced to handle
 * `unknown-device` for an email is a screen with unreachable branches in it.
 *
 * There is deliberately no `uncertain`. The server answers 200 whatever it
 * decides — it will not say whether the account exists, whether it was already
 * verified, or whether the throttle swallowed the request — so the only claim
 * this app can honestly make is that it ASKED, and that claim is equally true
 * when the reply is lost on the way back. `requested` therefore covers both,
 * and only a failure raised BEFORE anything was sent is reported as one.
 */
export type AccountResendOutcome =
  /** The request left this machine. Nothing more than that is knowable. */
  | { readonly kind: "requested" }
  /** The server's current answer for this credential is already verified. */
  | { readonly kind: "already-verified" }
  /** A resend is already running. Nothing was sent. */
  | { readonly kind: "busy" }
  /** Nobody is signed in any more. Nothing was sent. */
  | { readonly kind: "signed-out" }
  /** A quit is being decided, the page reloaded, or the account moved. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly failure: AccountFailure };

/**
 * The longest device name this client will send, in RUNES.
 *
 * Restated from the account client, which takes it from the server's own
 * `internal/devicelabel.MaxRunes`. Counted in code points, because a UTF-16
 * length disagrees for any astral character — and disagreeing with the
 * validator that decides is how a client refuses a name the server would have
 * taken, or sends one it will not.
 */
export const ACCOUNT_DEVICE_NAME_MAX_RUNES = 64;

/**
 * The one place this screen may send somebody outside the app.
 *
 * A closed token, not a URL. The renderer names a destination; MAIN owns the
 * mapping to an actual address, validates it against this build's pinned origin
 * and hands it to `openApprovedExternal`. A channel that accepted a URL from a
 * page would be script-triggered browser navigation with the user's real
 * session — which is precisely why `hardenContents` denies `window.open` and
 * `will-navigate` outright.
 */
export type AccountExternalTarget = "account-management";

export const ACCOUNT_EXTERNAL_TARGETS: readonly AccountExternalTarget[] = ["account-management"];

/** Whether a value is a destination this build knows. Main re-checks it. */
export function isAccountExternalTarget(value: unknown): value is AccountExternalTarget {
  return value === "account-management";
}

/**
 * The path on this build's own origin that `account-management` means.
 *
 * A constant rather than a computed value: the whole point of the token is that
 * the set of reachable addresses is written down in one place and is finite.
 */
export const ACCOUNT_MANAGEMENT_PATH = "/me";

/** The view a page holds before main has answered. Never a real account. */
export const ACCOUNT_SUMMARY_LOADING: AccountSummaryView = Object.freeze({
  epoch: 0,
  signedIn: false,
  profile: Object.freeze({ kind: "loading" as const }),
  usage: Object.freeze({ kind: "loading" as const }),
  devices: Object.freeze({ kind: "loading" as const }),
});

/**
 * A signed-out view at a given epoch.
 *
 * Every section is `signed-out` rather than `loading`, because there is nothing
 * to wait for, and rather than `ready` with empty values, because an empty
 * value is a claim about an account and there is no account.
 */
export function signedOutAccountView(epoch: number): AccountSummaryView {
  const failure = Object.freeze({
    kind: "failed" as const,
    failure: Object.freeze({ kind: "signed-out" as const }),
  });
  return Object.freeze({
    epoch,
    signedIn: false,
    profile: failure,
    usage: failure,
    devices: failure,
  });
}
