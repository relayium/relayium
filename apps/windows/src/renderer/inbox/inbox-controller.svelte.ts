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
  InboxDisableOutcome,
  InboxEnableOutcome,
  InboxMessageView,
  InboxPendingView,
  InboxRenameOutcome,
  InboxSimpleOutcome,
  InboxView,
} from "../../shared/ipc-contract.js";

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
  | { readonly kind: "renamed" };

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

  readonly #stop: Array<() => void> = [];

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
        this.view = shaped;
        // A state change is the moment the lists may have moved: a delivery
        // arrived, one was worked, an account changed. Refreshed here rather
        // than on a timer in the page, because the page may not be mounted.
        void this.refreshLists();
      }),
    );
  }

  /** Read everything once. Called by the shell at startup, not by the page. */
  async refresh(): Promise<void> {
    this.view = await this.bridge.state();
    await this.refreshLists();
  }

  private async refreshLists(): Promise<void> {
    const [pending, messages] = await Promise.all([
      this.bridge.pending().catch(() => this.pending),
      this.bridge.messages().catch(() => this.messages),
    ]);
    this.pending = pending;
    this.messages = messages;
    // A message that was deleted — or that belongs to an account that has gone
    // away — must not stay on screen as though it were still there.
    if (this.openId !== null && !messages.some((message) => message.id === this.openId)) {
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
      this.view = await this.bridge.state();
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
      this.view = await this.bridge.state();
    } finally {
      this.busy = false;
    }
  }

  async chooseFolder(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = null;
    try {
      const outcome = await this.bridge.chooseFolder();
      if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
      this.view = await this.bridge.state();
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
      return;
    }
    const answer = await this.bridge.open({ id });
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
    const outcome = await this.bridge.remove({ id });
    if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
    if (this.openId === id) {
      this.openId = null;
      this.openText = "";
    }
    await this.refreshLists();
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
      this.view = await this.bridge.state();
    } finally {
      this.busy = false;
    }
  }

  /** "Try again now": end main's backoff instead of waiting it out. */
  async retryNow(): Promise<void> {
    await this.bridge.wake();
  }

  async release(key: string): Promise<void> {
    const outcome = await this.bridge.release({ key });
    if (outcome.kind === "failed") this.notice = { kind: "failed", reason: outcome.reason };
    this.view = await this.bridge.state();
  }

  dismiss(): void {
    this.notice = null;
  }

  /** Only the app's own teardown calls this. A page never does. */
  destroy(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }
}
