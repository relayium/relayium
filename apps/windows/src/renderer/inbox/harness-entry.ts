// A private entry that mounts the REAL Device Inbox page for the real-renderer
// smoke, and nothing else.
//
// ## Why this file exists
//
// The Inbox is this app's flagship screen and, until this file, the only major
// one with no real-renderer coverage: the account screen, the update pane, the
// OS-entry pane and the pairing handoff each have a harness, and this did not.
// Its controller cases run the real rune module, which is not the same claim —
// `$state` that compiles is not `$state` that renders, and a row keyed so that
// an update re-creates it, a button wired to nothing, or a sentence that is
// never reached are all invisible to a test that mounts nothing.
//
// It is also where two of 2026-09-12's fixes landed: the retained card now says
// what residue was left instead of printing an OS errno, and a delivery's phase
// is a closed union whose copy is total. Both are compile-checked. Neither had
// ever been DISPLAYED by anything.
//
// ## It is NOT part of the app
//
// Nothing imports this file. It is not referenced by `index.html`, by
// `src/renderer/main.ts` or by any route, so it is not in the shipped bundle —
// it is only ever reached by being named as a Vite entry by the smoke.
//
// The bridge below is a SYNTHETIC transport, stated plainly: a plain object in
// the page that answers with whatever the driving script last set. It reaches no
// main process, no network and no disk. What it stands in for is proven
// elsewhere — `feature-inbox.test.ts` and `inbox-server-acceptance.mjs` against
// a real server. What is proven HERE is the screen: that the real markup renders
// the real state, and that the real buttons do what the screen says.

import { mount } from "svelte";
import InboxPage from "../pages/InboxPage.svelte";
import { InboxController, type InboxBridge } from "./inbox-controller.svelte.js";
import { InboxSendController, type InboxSendBridge } from "./inbox-send-controller.svelte.js";
import { setLang } from "../i18n/index.svelte.js";
import type {
  InboxMessageView,
  InboxPendingView,
  InboxReceiptView,
  InboxView,
} from "../../shared/ipc-contract.js";
import "../tokens.css";

/** A signed-in, receiving Inbox with nothing wrong. Scenarios modify a copy. */
const BASE: InboxView = {
  status: { kind: "idle", pending: 0 },
  capabilities: ["receive"],
  enabled: true,
  hasDestination: true,
  deviceName: "This PC",
  withdrawalPending: false,
  policy: "auto",
  epoch: 1,
  retained: [],
};

const calls = { release: [] as string[], wake: 0 };
const listeners = new Set<(payload: unknown) => void>();

const answers = {
  view: BASE as InboxView,
  receipts: null as readonly InboxReceiptView[] | null,
  /** `release` reports success unless a scenario says otherwise. */
  releaseOk: true,
};

const ok = { kind: "ok" } as const;

const bridge: InboxBridge = {
  state: () => Promise.resolve(answers.view),
  enable: () => Promise.resolve({ kind: "enabled" } as const),
  disable: () => Promise.resolve({ kind: "disabled" } as const),
  chooseFolder: () => Promise.resolve(ok),
  pending: () => Promise.resolve([] as readonly InboxPendingView[]),
  accept: () => Promise.resolve({ kind: "queued" } as const),
  reject: () => Promise.resolve(ok),
  messages: () => Promise.resolve([] as readonly InboxMessageView[]),
  open: () => Promise.resolve({ text: "" }),
  copy: () => Promise.resolve(ok),
  remove: () => Promise.resolve(ok),
  rename: () => Promise.resolve({ kind: "renamed", name: "This PC" } as const),
  wake: () => {
    calls.wake += 1;
    return Promise.resolve({ ok: true });
  },
  release: (payload) => {
    calls.release.push(payload.key);
    if (!answers.releaseOk) {
      return Promise.resolve({ kind: "failed", reason: "internal" } as const);
    }
    // A release that SUCCEEDS drops the row, which is what the page must then
    // stop showing. Pushing the new view is main's job, so the harness does it.
    answers.view = { ...answers.view, retained: [] };
    for (const listener of [...listeners]) listener(answers.view);
    return Promise.resolve(ok);
  },
  setPolicy: () => Promise.resolve({ kind: "enabled" } as const),
  reveal: () => Promise.resolve(ok),
  receipts: () => Promise.resolve({ entries: answers.receipts }),
  history: () => Promise.resolve({ entries: null }),
  forget: () => Promise.resolve(ok),
  onState(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/** The send half is not what this harness drives; it is here to mount. */
const sendBridge: InboxSendBridge = {
  targets: () => Promise.resolve({ ok: true, targets: [] } as const),
  start: () => Promise.reject(new Error("the send half is not driven by this harness")),
  feed: () => Promise.reject(new Error("the send half is not driven by this harness")),
  end: () => Promise.reject(new Error("the send half is not driven by this harness")),
  cancel: () => Promise.reject(new Error("the send half is not driven by this harness")),
  converge: () => Promise.reject(new Error("the send half is not driven by this harness")),
  onProgress: () => () => undefined,
  onOutcome: () => () => undefined,
};

const inbox = new InboxController(bridge);
const send = new InboxSendController(sendBridge, bridge.onState);

const target = document.getElementById("app");
if (target === null) throw new Error("the harness page has no mount point");
/** Counted, so a scenario can prove the sign-in offer is wired, not just drawn. */
let signInClicks = 0;
mount(InboxPage, {
  target,
  props: {
    inbox,
    send,
    onSignIn: () => {
      signInClicks += 1;
    },
  },
});

/**
 * The driving surface, on `window`.
 *
 * About INPUTS. The driver pushes state and reads the DOM back; it never
 * inspects the controller, because a field that is right while the screen is
 * wrong is exactly what these cases exist to catch.
 */
Object.defineProperty(globalThis, "__inboxHarness", {
  value: {
    /** Main pushed a snapshot. The controller's own guards then apply. */
    push(view: Partial<InboxView>): void {
      answers.view = { ...BASE, ...view };
      for (const listener of [...listeners]) listener(answers.view);
    },
    setReceipts(entries: readonly InboxReceiptView[] | null): void {
      answers.receipts = entries;
    },
    setReleaseOk(okay: boolean): void {
      answers.releaseOk = okay;
    },
    setLang(next: "en" | "zh"): void {
      setLang(next);
    },
    calls(): { release: string[]; wake: number; signIn: number } {
      return { ...(JSON.parse(JSON.stringify(calls)) as typeof calls), signIn: signInClicks };
    },
  },
  enumerable: true,
});
