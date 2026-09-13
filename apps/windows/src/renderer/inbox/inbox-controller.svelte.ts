// The Inbox page's state, owned by the SHELL rather than by the page.
//
// ## Why this is not component state
//
// The same reason `StoredController` is not, and one more that is specific to
// this feature.
//
// The ordinary reason: a page unmounts the moment the user looks at another
// row, and everything held in the component goes with it — the message the user
// had open, the outcome of the delivery they just accepted, the rename draft
// they switched away to check a spelling for.
//
// The reason that matters more: RECEIVING IS NOT THIS PAGE'S. It belongs to the
// main process, which schedules it whether or not a window is on screen. So
// this object is not a driver, it is a VIEW: it subscribes once, for the life
// of the app, and renders what main pushes. Nothing here starts, stops or
// paces the scheduler, and a component that mounts twice cannot create a second
// one — there is nothing here to create.
//
// That is also why the subscription is taken in the constructor and never torn
// down per page: a state push that arrived while the user was on another row is
// exactly the one they need when they come back.
//
// ## What this never holds
//
// No destination path — main answers `hasDestination`, a boolean. No claim
// token, no key, no manifest. The one piece of content is the text of a message
// the user asked to open, which is their own message.

import type {
  InboxAcceptOutcome,
  InboxNamedDeliveryView,
  InboxReceiptView,
  InboxDisableOutcome,
  InboxEnableOutcome,
  InboxMessageView,
  InboxPendingView,
  InboxRenameOutcome,
  InboxSimpleOutcome,
  InboxView,
} from "../../shared/ipc-contract.js";

/** The three answers a person can give about arriving deliveries. */
export type InboxPolicy = "off" | "ask" | "auto";

/** The preload surface this controller uses. Declared, not inferred. */
export interface InboxBridge {
  state(): Promise<InboxView>;
  enable(): Promise<InboxEnableOutcome>;
  disable(): Promise<InboxDisableOutcome>;
  chooseFolder(): Promise<InboxSimpleOutcome>;
  pending(): Promise<readonly InboxPendingView[]>;
  accept(payload: { id: string }): Promise<InboxAcceptOutcome>;
  reject(payload: { id: string }): Promise<InboxSimpleOutcome>;
  messages(): Promise<readonly InboxMessageView[]>;
  open(payload: { id: string }): Promise<{ text: string } | { failed: string }>;
  copy(payload: { id: string }): Promise<InboxSimpleOutcome>;
  remove(payload: { id: string }): Promise<InboxSimpleOutcome>;
  rename(payload: { name: string }): Promise<InboxRenameOutcome>;
  wake(): Promise<{ ok: boolean }>;
  release(payload: { key: string }): Promise<InboxSimpleOutcome>;
  setPolicy(payload: { policy: InboxPolicy }): Promise<InboxEnableOutcome>;
  reveal(): Promise<InboxSimpleOutcome>;
  receipts(): Promise<{ entries: readonly InboxReceiptView[] | null }>;
  history(): Promise<{ entries: readonly InboxNamedDeliveryView[] | null }>;
  forget(payload: { id: string }): Promise<InboxSimpleOutcome>;
  onState(cb: (payload: unknown) => void): () => void;
}

/** The view before main has answered. Never rendered as a real state. */
const LOADING: InboxView = {
  status: { kind: "starting" },
  capabilities: [],
  enabled: false,
  hasDestination: false,
  deviceName: "",
  withdrawalPending: false,
  policy: "off",
  epoch: 0,
  retained: [],
};

/**
 * What the last thing the user did resulted in.
 *
 * Separate from `view` because it is about an ACT, not a state: "the folder
 * dialog was closed" and "receiving is off" are different sentences, and a page
 * that only rendered state would have nothing to say about the first.
 */
export type InboxNotice =
  | { readonly kind: "declined" }
  | { readonly kind: "enabled" }
  | { readonly kind: "disabled" }
  | { readonly kind: "still-enrolled"; readonly reason: string }
  | { readonly kind: "needs-account" }
  | { readonly kind: "refused" }
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "accepted"; readonly receipt: InboxAcceptOutcome }
  | { readonly kind: "renamed" }
  /**
   * A policy was set, and WHICH one.
   *
   * Not `enabled`: `setPolicy("off")` succeeds, and reporting that success as
   * "Receiving is on" told the user the opposite of what they had just chosen.
   * The policy travels with the notice so the sentence can be the right one.
   */
  | { readonly kind: "policy"; readonly policy: InboxPolicy };

export class InboxController {
  view = $state<InboxView>(LOADING);
  pending = $state<readonly InboxPendingView[]>([]);
  messages = $state<readonly InboxMessageView[]>([]);
  /** The message the user opened, and its id, so the page can close it. */
  openId = $state<string | null>(null);
  openText = $state<string>("");
  /** The rename box. Survives navigation, which is why it lives here. */
  nameDraft = $state("");
  busy = $state(false);
  notice = $state<InboxNotice | null>(null);
  /** Ids currently being accepted or rejected, so one row can show progress. */
  working = $state<readonly string[]>([]);
  /** What this account has received. Counts and outcomes; never a name. */
  receipts = $state<readonly InboxReceiptView[]>([]);
  /**
   * The record could not be READ.
   *
   * Distinct from having received nothing, and the distinction is the point:
   * "nothing has arrived yet" over a journal this app failed to open would tell
   * the user their deliveries never happened.
   */
  receiptsUnavailable = $state(false);
  /**
   * What arrived, BY NAME, keyed by task id.
   *
   * Read beside the receipts rather than instead of them. The journal is the
   * authoritative list of deliveries — it is written before anything
   * irreversible and it survives a name capture that failed — so a row exists
   * for every delivery either way, and this is what fills in the names for the
   * ones that have them. A delivery with no record renders as "the names were
   * not recorded", never as a delivery that arrived empty.
   */
  named = $state<Readonly<Record<string, InboxNamedDeliveryView>>>({});
  /**
   * The NAMES could not be read.
   *
   * Separate from `receiptsUnavailable`, because they are separate records with
   * separate failures: the counts can be perfectly readable while the names are
   * not, and telling the user their deliveries are gone because a second file
   * would not open would be false.
   */
  namesUnavailable = $state(false);
  /** What the last reveal did, so a refused one is never silent. */
  revealFailed = $state(false);

  readonly #stop: Array<() => void> = [];
  /**
   * The account this state belongs to, and which reads may still write.
   *
   * The same pattern the stored send controller uses, and for the same two
   * failures. `#epoch` drops one account's rows before another's are rendered;
   * `#listSeq` and `#openSeq` stop an OLDER answer landing after a newer one —
   * a list read issued before a delete putting the row back, or a message body
   * arriving after the user opened a different one.
   */
  #epoch = 0;
  #listSeq = 0;
  #openSeq = 0;
  /**
   * Which view answer may still be installed.
   *
   * A `state()` read is a request like any other, and a slow one issued before
   * an account push came back afterwards and rolled the UI back to the previous
   * account's idle view — over a `needs-account` the page had already been
   * told. Every assignment of `view` from a response goes through this.
   */
  #viewSeq = 0;

  constructor(private readonly bridge: InboxBridge) {
    // ONE subscription, for the life of the app. Rebuilding it per page would
    // tear it down and replace it in the same tick a push arrives in.
    this.#stop.push(
      bridge.onState((payload) => {
        const shaped = payload as InboxView | null;
        // Shaped rather than trusted: this crosses a process boundary, and a
        // malformed push must not blank a view that was known to be true.
        if (shaped === null || typeof shaped !== "object") return;
        if (typeof (shaped as { status?: unknown }).status !== "object") return;
        if (typeof shaped.epoch !== "number") return;
        // ## A push is the newest word, whatever it says
        //
        // Invalidating only on an EPOCH change was not enough: a same-account
        // push — the user choosing Off — could be overwritten by a `state()`
        // read issued before it that answered `ask`. Every accepted push
        // supersedes every read still in flight.
        this.#viewSeq += 1;
        this.#adopt(shaped);
        // A state change is the moment the lists may have moved: a delivery
        // arrived, one was worked, an account changed. Refreshed here rather
        // than on a timer in the page, because the page may not be mounted.
        void this.refreshLists();
      }),
    );
  }

  /**
   * Install a view, whatever observed it.
   *
   * ONE path, because a read can be the first thing to see an account change
   * just as a push can, and the clearing has to happen either way. It used to
   * live only in the push handler, so a `state()` answer carrying a new epoch
   * installed the new account's status beside the OLD account's open message
   * body and lists.
   */
  #adopt(view: InboxView): void {
    if (view.epoch !== this.#epoch) this.#forgetAccount(view.epoch);
    this.view = view;
  }

  /**
   * Drop everything that belonged to the account that is leaving.
   *
   * Synchronous, and it clears the open message body first: that is the user's
   * own text, and it belongs to whoever was signed in.
   */
  #forgetAccount(epoch: number): void {
    this.#epoch = epoch;
    this.#viewSeq += 1;
    this.#listSeq += 1;
    this.#openSeq += 1;
    this.openId = null;
    this.openText = "";
    this.pending = [];
    this.messages = [];
    this.receipts = [];
    this.receiptsUnavailable = false;
    // The user's own file names, dropped SYNCHRONOUSLY with everything else
    // that belonged to the account that is leaving.
    this.named = {};
    this.namesUnavailable = false;
    this.notice = null;
  }

  /** Read everything once. Called by the shell at startup, not by the page. */
  async refresh(): Promise<void> {
    await this.#installState();
    await this.refreshLists();
  }

  /** Install a view read by an action, unless something newer has spoken. */
  async #installState(): Promise<void> {
    const seq = ++this.#viewSeq;
    const view = await this.bridge.state();
    // Dropped if a push — or a newer read — has already spoken. Installing it
    // would roll the UI back to an account, or a policy, that has moved on.
    if (this.#viewSeq !== seq) return;
    this.#adopt(view);
  }

  /**
   * Re-read the lists this page renders.
   *
   * PUBLIC, and called from three places: the shell at startup, every state
   * push, and the page when it MOUNTS. The third is not redundant. A push
   * happens when main's state changes, and the last thing to change after a
   * delivery is the scheduler going back to idle — which can land before the
   * names have been written. Without a read on mount, opening the Inbox page
   * showed lists gathered at some earlier moment and looked, for a delivery
   * that had definitely arrived, exactly like one that had not.
   */
  async refreshLists(): Promise<void> {
    const epoch = this.#epoch;
    const seq = ++this.#listSeq;
    const [pending, messages, receipts, named] = await Promise.all([
      this.bridge.pending().catch(() => this.pending),
      this.bridge.messages().catch(() => this.messages),
      this.bridge.receipts().catch(() => ({ entries: null })),
      this.bridge.history().catch(() => ({ entries: null })),
    ]);
    // An older read must not overwrite a newer one's answer, and a read issued
    // before an account change must not restore the previous account's rows.
    if (this.#epoch !== epoch || this.#listSeq !== seq) return;
    this.pending = pending;
    this.messages = messages;
    if (receipts.entries === null) {
      this.receiptsUnavailable = true;
    } else {
      this.receiptsUnavailable = false;
      this.receipts = receipts.entries;
    }
    if (named.entries === null) {
      // Unavailable, NOT empty. The counts above still render, so a delivery is
      // never presented as having arrived with nothing in it.
      this.namesUnavailable = true;
    } else {
      this.namesUnavailable = false;
      const byTask: Record<string, InboxNamedDeliveryView> = {};
      for (const entry of named.entries) byTask[entry.taskID] = entry;
      this.named = byTask;
    }
    // A message that was deleted — or that belongs to an account that has gone
    // away — must not stay on screen as though it were still there.
    if (this.openId !== null && !messages.some((message) => message.id === this.openId)) {
      // Gone from the list. A body still in flight for it must not land either.
      this.#openSeq += 1;
      this.openId = null;
      this.openText = "";
    }
  }

  /**
   * Ask for the feature. Main opens the folder dialog; this only asks.
   *
   * `busy` is set around it because the native dialog is modal to the window
   * and a second click while it is open would queue a second dialog.
   */
  async enable(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = null;
    try {
      const outcome = await this.bridge.enable();
      this.notice =
        outcome.kind === "enabled"
          ? { kind: "enabled" }
          : outcome.kind === "declined"
            ? { kind: "declined" }
            : outcome.kind === "needs-account"
              ? { kind: "needs-account" }
              : outcome.kind === "refused"
                ? { kind: "refused" }
                : outcome.kind === "superseded"
                  ? { kind: "superseded" }
                  : { kind: "failed", reason: outcome.reason };
      await this.#installState();
    } finally {
      this.busy = false;
    }
  }

  async disable(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = null;
    try {
      const outcome = await this.bridge.disable();
      this.notice =
        outcome.kind === "disabled"
          ? { kind: "disabled" }
          : outcome.kind === "still-enrolled"
            ? { kind: "still-enrolled", reason: outcome.reason }
            : outcome.kind === "needs-account"
              ? { kind: "needs-account" }
              : outcome.kind === "refused"
                ? { kind: "refused" }
                : { kind: "failed", reason: outcome.reason };
      await this.#installState();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Choose off / ask / auto.
   *
   * `busy` is held around it because `ask` and `auto` with no folder recorded
   * open the native dialog, which is modal to the window — a second click would
   * queue a second dialog and ask the same question twice.
   */
  async setPolicy(policy: InboxPolicy): Promise<void> {
    if (this.busy || this.view.policy === policy) return;
    this.busy = true;
    this.notice = null;
    try {
      const outcome = await this.bridge.setPolicy({ policy });
      this.notice =
        outcome.kind === "enabled"
          ? { kind: "policy", policy }
          : outcome.kind === "declined"
            ? { kind: "declined" }
            : outcome.kind === "needs-account"
              ? { kind: "needs-account" }
              : outcome.kind === "refused"
                ? { kind: "refused" }
                : outcome.kind === "superseded"
                  ? { kind: "superseded" }
                  : { kind: "failed", reason: outcome.reason };
      await this.#installState();
      await this.refreshLists();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Show the receiving folder.
   *
   * Main performs it on a path main holds; this asks and renders the answer.
   * A refusal is shown rather than a button that appears to do nothing.
   */
  async reveal(): Promise<void> {
    const outcome = await this.bridge.reveal().catch(() => ({ kind: "failed" as const, reason: "internal" }));
    this.revealFailed = outcome.kind !== "ok";
    if (!this.revealFailed) return;
    setTimeout(() => {
      this.revealFailed = false;
    }, 3000);
  }

  async chooseFolder(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = null;
    try {
      const outcome = await this.bridge.chooseFolder();
      if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
      await this.#installState();
    } finally {
      this.busy = false;
    }
  }

  async accept(id: string): Promise<void> {
    if (this.working.includes(id)) return;
    this.working = [...this.working, id];
    this.notice = null;
    try {
      const outcome = await this.bridge.accept({ id });
      this.notice =
        outcome.kind === "failed"
          ? { kind: "failed", reason: outcome.reason }
          : { kind: "accepted", receipt: outcome };
      await this.refreshLists();
    } finally {
      this.working = this.working.filter((entry) => entry !== id);
    }
  }

  async reject(id: string): Promise<void> {
    if (this.working.includes(id)) return;
    this.working = [...this.working, id];
    this.notice = null;
    try {
      const outcome = await this.bridge.reject({ id });
      if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
      await this.refreshLists();
    } finally {
      this.working = this.working.filter((entry) => entry !== id);
    }
  }

  /** Open one message. The body is fetched only when the user asks for it. */
  async open(id: string): Promise<void> {
    if (this.openId === id) {
      this.openId = null;
      this.openText = "";
      this.#openSeq += 1;
      return;
    }
    const epoch = this.#epoch;
    const seq = ++this.#openSeq;
    const answer = await this.bridge.open({ id });
    // A body that arrived after the user opened a different message — or after
    // the account changed — is somebody else's text on their screen.
    if (this.#epoch !== epoch || this.#openSeq !== seq) return;
    if ("failed" in answer) {
      this.notice = { kind: "failed", reason: answer.failed };
      return;
    }
    this.openId = id;
    this.openText = answer.text;
  }

  /**
   * Put the open message on the clipboard, from main.
   *
   * The page never touches `navigator.clipboard`: every renderer permission in
   * this app is denied by `window.ts`, deliberately, so a Copy built on the
   * browser API would not sometimes fail — it would never work. Main reads the
   * message and writes it, and what comes back is whether it did.
   */
  async copy(id: string): Promise<boolean> {
    const outcome = await this.bridge.copy({ id });
    if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
    if (outcome.kind === "refused") this.notice = { kind: "refused" };
    return outcome.kind === "ok";
  }

  async remove(id: string): Promise<void> {
    // Invalidated BEFORE the delete, not after: an `open` already in flight for
    // this message would otherwise come back with its plaintext and put a
    // deleted message back on screen. The user asked for it to be gone.
    this.#openSeq += 1;
    const outcome = await this.bridge.remove({ id });
    if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
    if (this.openId === id) {
      this.openId = null;
      this.openText = "";
    }
    await this.refreshLists();
  }

  /**
   * Forget one delivery's names, because the user asked for that.
   *
   * The only thing that deletes from that record. Turning receiving off and
   * signing out leave it alone, exactly as they leave the message vault alone.
   * The files themselves are untouched: this is the record of what arrived, not
   * what arrived.
   */
  async forget(taskID: string): Promise<void> {
    if (this.working.includes(taskID)) return;
    this.working = [...this.working, taskID];
    try {
      const outcome = await this.bridge.forget({ id: taskID }).catch(() => ({
        kind: "failed" as const,
        reason: "internal",
      }));
      if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
      await this.refreshLists();
    } finally {
      this.working = this.working.filter((entry) => entry !== taskID);
    }
  }

  async rename(): Promise<void> {
    const name = this.nameDraft.trim();
    if (name.length === 0 || this.busy) return;
    this.busy = true;
    this.notice = null;
    try {
      const outcome = await this.bridge.rename({ name });
      if (outcome.kind === "renamed") {
        this.notice = { kind: "renamed" };
        this.nameDraft = "";
      } else if (outcome.kind === "failed") {
        this.notice = { kind: "failed", reason: outcome.reason };
      }
      await this.#installState();
    } finally {
      this.busy = false;
    }
  }

  /** "Try again now": end main's backoff instead of waiting it out. */
  async retryNow(): Promise<void> {
    await this.bridge.wake();
  }

  async release(key: string): Promise<void> {
    const epoch = this.#epoch;
    const outcome = await this.bridge.release({ key });
    // The account captured at admission, re-checked before the notice: a
    // failure from the previous account's cleanup is not this account's news.
    if (this.#epoch !== epoch) return;
    if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
    await this.#installState();
  }

  dismiss(): void {
    this.notice = null;
  }

  /** Only the app's own teardown calls this. A page never does. */
  destroy(): void {
    // Everything in flight is invalidated: a read or a message body answering
    // after the app has torn this down must write nothing.
    this.#viewSeq += 1;
    this.#listSeq += 1;
    this.#openSeq += 1;
    for (const stop of this.#stop.splice(0)) stop();
  }
}
