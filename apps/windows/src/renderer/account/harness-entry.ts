// A private entry that mounts the REAL account screen for the real-renderer
// smoke, and nothing else.
//
// ## Why this file exists at all
//
// The controller cases run the real rune module, and they are still not proof
// that the screen works: `$state` that compiles is not `$state` that renders. A
// meter that is never drawn, a confirmation whose two buttons are wired to the
// same handler, a `{#each}` keyed so a rename re-creates the row and drops
// focus — none of those is visible to a test that never mounts anything. And an
// SSR render is not proof either: it produces markup once and then nothing ever
// updates, so every assertion about "click this and the screen changes" would
// pass vacuously.
//
// So `test/smoke/account-details-smoke.mjs` builds this entry with the ordinary
// Svelte CLIENT build and drives it inside a real Electron renderer, through the
// real DOM.
//
// ## It is NOT part of the app
//
// Nothing imports this file. It is not referenced by `index.html`, by
// `src/renderer/main.ts` or by any route, so it is not in the shipped bundle —
// it is only ever reached by being named as a Vite entry by the smoke.
//
// The bridge below is a SYNTHETIC transport, stated plainly: it is a plain
// object in the page that records what it was asked to do and answers with
// whatever the driving script last set. It reaches no network, no main process
// and no account. What it is standing in for — the real IPC surface and the real
// account client — is proven elsewhere: `src/main/account/summary.ts` against an
// actual Go server, and `AccountSummaryService` against its own cases. What is
// being proven HERE is the component and the controller: that the real markup
// renders the real state, and that clicking the real buttons does what the
// screen says it does.

import { mount } from "svelte";
import AccountDetails from "../pages/AccountDetails.svelte";
import { AccountSummaryController } from "./account-controller.svelte.js";
import type { AccountSummaryBridge } from "./bridge.js";
import { setLang } from "../i18n/index.svelte.js";
import {
  ACCOUNT_SUMMARY_LOADING,
  type AccountMutationOutcome,
  type AccountResendOutcome,
  type AccountSummaryView,
} from "../../shared/account-summary.js";
import "../tokens.css";

interface Calls {
  state: number;
  refresh: (string | undefined)[];
  rename: { id: string; name: string }[];
  revoke: string[];
  manage: string[];
  /** A count, because the channel carries no argument at all. */
  resend: number;
}

const calls: Calls = { state: 0, refresh: [], rename: [], revoke: [], manage: [], resend: 0 };
const listeners = new Set<(payload: unknown) => void>();

const answers = {
  view: ACCOUNT_SUMMARY_LOADING as AccountSummaryView,
  rename: { kind: "renamed", name: "Renamed" } as AccountMutationOutcome,
  revoke: { kind: "revoked", self: false, signedOut: false } as AccountMutationOutcome,
  manage: true,
  resend: { kind: "requested" } as AccountResendOutcome,
};

/** A hold the driver can take, so a busy row can actually be observed. */
let hold: { promise: Promise<void>; release: () => void } | null = null;

const waitForHold = async (): Promise<void> => {
  if (hold) await hold.promise;
};

const bridge: AccountSummaryBridge = {
  async state() {
    calls.state += 1;
    await waitForHold();
    return answers.view;
  },
  async refresh(payload) {
    calls.refresh.push(payload.section);
    await waitForHold();
    return answers.view;
  },
  async rename(payload) {
    calls.rename.push(payload);
    await waitForHold();
    return answers.rename;
  },
  async revoke(payload) {
    calls.revoke.push(payload.id);
    await waitForHold();
    return answers.revoke;
  },
  async resendVerification() {
    calls.resend += 1;
    await waitForHold();
    return answers.resend;
  },
  async manage(payload) {
    calls.manage.push(payload.target);
    return { ok: answers.manage };
  },
  onState(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

const controller = new AccountSummaryController(bridge);

const target = document.getElementById("app");
if (target === null) throw new Error("the harness page has no mount point");
mount(AccountDetails, { target, props: { controller } });

/**
 * The driving surface, on `window`.
 *
 * Deliberately small and deliberately about INPUTS: the driver pushes states and
 * reads the DOM back. It never reaches into the controller to assert a field,
 * because a field that is correct while the screen is wrong is exactly the
 * failure these cases exist to catch.
 */
Object.defineProperty(globalThis, "__accountHarness", {
  value: {
    /** Main pushed a snapshot. The controller's own guards then apply. */
    push(view: AccountSummaryView): void {
      answers.view = view;
      for (const listener of [...listeners]) listener(view);
    },
    /** Deliver a raw payload, for the malformed-push case. */
    pushRaw(payload: unknown): void {
      for (const listener of [...listeners]) listener(payload);
    },
    setRenameOutcome(outcome: AccountMutationOutcome): void {
      answers.rename = outcome;
    },
    setRevokeOutcome(outcome: AccountMutationOutcome): void {
      answers.revoke = outcome;
    },
    setResendOutcome(outcome: AccountResendOutcome): void {
      answers.resend = outcome;
    },
    setManageOk(ok: boolean): void {
      answers.manage = ok;
    },
    setLang(next: "en" | "zh"): void {
      setLang(next);
    },
    takeHold(): void {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { promise, release };
    },
    releaseHold(): void {
      hold?.release();
      hold = null;
    },
    calls(): Calls {
      return JSON.parse(JSON.stringify(calls)) as Calls;
    },
    resetCalls(): void {
      calls.state = 0;
      calls.refresh.length = 0;
      calls.rename.length = 0;
      calls.revoke.length = 0;
      calls.manage.length = 0;
      calls.resend = 0;
    },
  },
  enumerable: true,
});
