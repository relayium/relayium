// The account detail screen's state, owned by the SHELL rather than by the page.
//
// The same shape as `InboxController`, for the same reasons and with the same
// guards, because the failures are the same ones.
//
// A page unmounts the moment the user looks at another row, and everything held
// in a component goes with it — a half-typed device name, the confirmation
// somebody is reading right now, the outcome of the revoke they just approved.
// So this lives above the page, subscribes once, and renders what main pushes.
//
// ## What it does NOT do
//
// * It does not sign in, sign out, or observe sign-in state. That is
//   `SignInController`'s, it already has one subscription for it, and a second
//   observer here would mean two objects disagreeing about whether somebody is
//   signed in. A self-revoke's sign-out is performed by MAIN, under the epoch
//   the revoke was captured with; this object only reports what happened.
// * It does not read files or the clipboard. Every renderer permission in this
//   app is denied by `window.ts`, deliberately.
// * It does not hold a bearer, an origin or an address, because the contract it
//   speaks has no such field.
//
// ## The four guards
//
// `#epoch` drops one account's data before another's is rendered. `#viewSeq`
// stops an older read landing after a newer push. `#rows` stops a mutation's
// answer being applied to a row whose operation has been superseded. `#destroyed`
// stops all three at once when the app tears this down.
//
// The epoch one is not theoretical: a `state()` read issued before a sign-out
// answers afterwards, and installing it would put the previous account's device
// list back on screen — with its rename buttons live.

import {
  ACCOUNT_DEVICE_NAME_MAX_RUNES,
  ACCOUNT_SUMMARY_LOADING,
  type AccountDeviceView,
  type AccountMutationOutcome,
  type AccountSectionName,
  type AccountSummaryView,
} from "../../shared/account-summary.js";
import type { AccountSummaryBridge } from "./bridge.js";
import { normalizeDeviceName, runeLength } from "./format.js";

/**
 * What a row is doing, and what it was last told.
 *
 * `outcome` is a closed value from the contract, never a sentence: the wording
 * belongs to the catalogue, and a controller that stored English would have to
 * be re-run to change language.
 */
export interface AccountRowState {
  readonly busy: boolean;
  readonly outcome: AccountMutationOutcome | null;
}

const IDLE: AccountRowState = Object.freeze({ busy: false, outcome: null });

/** Which row has an editor or a confirmation open. At most one of each. */
export type AccountPrompt =
  | { readonly kind: "rename"; readonly id: string }
  | { readonly kind: "revoke"; readonly id: string };

export class AccountSummaryController {
  view = $state<AccountSummaryView>(ACCOUNT_SUMMARY_LOADING);
  /** Sections with a read in flight, so a card can say it is re-reading. */
  refreshing = $state<readonly AccountSectionName[]>([]);
  /** Per row, so ONE failed revoke does not blank the list or the other rows. */
  rows = $state<Readonly<Record<string, AccountRowState>>>({});
  /** The open rename editor or revoke confirmation. Never both. */
  prompt = $state<AccountPrompt | null>(null);
  /** The rename field's contents. Lives here so navigation does not eat it. */
  renameDraft = $state("");
  /** The last "open my account page" attempt failed. */
  manageFailed = $state(false);

  readonly #stop: Array<() => void> = [];
  #epoch = 0;
  #viewSeq = 0;
  /** Per row: which operation may still write. Bumped by every supersession. */
  readonly #rowSeq = new Map<string, number>();
  #rowToken = 0;
  /**
   * Per section: which refresh call owns the "reading" indicator.
   *
   * A `finally` is not a guard. An earlier account's refresh still runs its
   * cleanup after that account has gone, and a cleanup that removed its section
   * by NAME cleared the indicator belonging to the refresh the NEW account had
   * already started — which both hid that it was reading and re-opened the door
   * to a duplicate read of the same section.
   */
  readonly #refreshOwner = new Map<AccountSectionName, number>();
  #refreshToken = 0;
  /** Which `manage` answer may still be reported. */
  #manageSeq = 0;
  #destroyed = false;

  constructor(private readonly bridge: AccountSummaryBridge) {
    // ONE subscription, for the life of the app. Rebuilt per page it would be
    // torn down and replaced in the same tick a push arrives in.
    this.#stop.push(
      bridge.onState((payload) => {
        const shaped = payload as AccountSummaryView | null;
        // Shaped rather than trusted: this crosses a process boundary, and a
        // malformed push must not blank a view that was known to be true.
        if (shaped === null || typeof shaped !== "object") return;
        if (typeof shaped.epoch !== "number") return;
        if (typeof (shaped as { profile?: unknown }).profile !== "object") return;
        if (typeof (shaped as { usage?: unknown }).usage !== "object") return;
        if (typeof (shaped as { devices?: unknown }).devices !== "object") return;
        // A push is the newest word, whatever it says. Every read still in
        // flight is superseded by it — including a same-account one, because a
        // mutation that landed in main publishes through here too and a stale
        // `state()` answer would put the old device name back.
        this.#viewSeq += 1;
        this.#adopt(shaped);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Account identity
  // -------------------------------------------------------------------------

  /**
   * Install a view, whatever observed it.
   *
   * ONE path, because a read can be the first thing to see an account change
   * just as a push can, and the clearing has to happen either way.
   */
  #adopt(view: AccountSummaryView): void {
    if (this.#destroyed) return;
    if (view.epoch !== this.#epoch) this.#forgetAccount(view.epoch);
    this.view = view;
  }

  /**
   * Drop everything belonging to the account that is leaving.
   *
   * Synchronous, and it clears the INPUTS first. A half-typed device name and an
   * open "Sign this PC out?" confirmation belong to whoever was signed in; a
   * confirmation left standing across an account change is a question about one
   * account answered against another.
   */
  #forgetAccount(epoch: number): void {
    this.#epoch = epoch;
    this.#viewSeq += 1;
    // Every row's in-flight operation is invalidated, then the map is emptied:
    // bumping first means an answer already on its way back cannot re-create the
    // row state it belonged to.
    for (const id of [...this.#rowSeq.keys()]) this.#rowSeq.set(id, ++this.#rowToken);
    this.#rowSeq.clear();
    // The same invalidation for the two things that are not per row: a refresh
    // whose cleanup has yet to run, and a browser open whose answer has yet to
    // arrive. Both would otherwise write into the account that has just
    // arrived.
    this.#refreshOwner.clear();
    this.#refreshToken += 1;
    this.#manageSeq += 1;
    this.prompt = null;
    this.renameDraft = "";
    this.rows = {};
    this.refreshing = [];
    this.manageFailed = false;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Read what main already holds. Called by the shell at startup. */
  async load(): Promise<void> {
    const seq = ++this.#viewSeq;
    const view = await this.bridge.state().catch(() => null);
    // Dropped if a push — or a newer read — has already spoken.
    if (view === null || this.#destroyed || this.#viewSeq !== seq) return;
    this.#adopt(view);
  }

  /**
   * Ask main to read again.
   *
   * A named section retries only that card. The three endpoints are independent
   * all the way down, so a usage endpoint that is failing does not make somebody
   * re-read a profile that is fine.
   */
  async refresh(section?: AccountSectionName): Promise<void> {
    if (this.#destroyed) return;
    const sections: readonly AccountSectionName[] =
      section === undefined ? ["profile", "usage", "devices"] : [section];
    if (sections.some((name) => this.refreshing.includes(name))) return;
    const epoch = this.#epoch;
    const seq = ++this.#viewSeq;
    const token = ++this.#refreshToken;
    for (const name of sections) this.#refreshOwner.set(name, token);
    this.refreshing = [...this.refreshing, ...sections];
    try {
      const view = await this.bridge
        .refresh(section === undefined ? {} : { section })
        .catch(() => null);
      // An answer that arrived after an account change describes an account
      // that has gone away; one superseded by a push is simply older news.
      if (view === null || this.#destroyed || this.#epoch !== epoch || this.#viewSeq !== seq) return;
      this.#adopt(view);
    } finally {
      // Only the sections this call is STILL the owner of. An account change,
      // or a newer refresh of the same section, takes ownership away — and
      // clearing an indicator this call no longer owns would say "finished
      // reading" about a read that is still running.
      const mine = sections.filter((name) => this.#refreshOwner.get(name) === token);
      for (const name of mine) this.#refreshOwner.delete(name);
      if (mine.length > 0) {
        this.refreshing = this.refreshing.filter((name) => !mine.includes(name));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Prompts — a rename editor, or a revoke confirmation
  // -------------------------------------------------------------------------

  /** Open the rename editor for one row, seeded with its current name. */
  beginRename(device: AccountDeviceView): void {
    if (this.#destroyed) return;
    this.prompt = { kind: "rename", id: device.id };
    this.renameDraft = device.name;
    this.#clearOutcome(device.id);
  }

  /** Ask before revoking. The confirmation is bound to the row's ID. */
  askRevoke(device: AccountDeviceView): void {
    if (this.#destroyed) return;
    this.prompt = { kind: "revoke", id: device.id };
    this.renameDraft = "";
    this.#clearOutcome(device.id);
  }

  /** Close whatever is open without doing it. */
  dismissPrompt(): void {
    this.prompt = null;
    this.renameDraft = "";
  }

  /** Drop one row's last result, so a notice does not sit there for ever. */
  dismissRow(id: string): void {
    this.#clearOutcome(id);
  }

  /** The row's state, always defined so a component need not test for null. */
  rowState(id: string): AccountRowState {
    return this.rows[id] ?? IDLE;
  }

  /**
   * Whether the draft could be sent at all.
   *
   * Local, advisory and deliberately shallow: it disables a Save button over an
   * empty or over-long field so a person is not made to wait for a round trip to
   * learn that. Main re-checks with its own normaliser and the SERVER decides —
   * the control-character and bidi rules live in `internal/devicelabel` and are
   * not restated in any client.
   */
  get renameValid(): boolean {
    const cleaned = normalizeDeviceName(this.renameDraft);
    return cleaned.length > 0 && runeLength(cleaned) <= ACCOUNT_DEVICE_NAME_MAX_RUNES;
  }

  /** How far over the ceiling the draft is, in runes. `0` when it fits. */
  get renameOverBy(): number {
    return Math.max(0, runeLength(normalizeDeviceName(this.renameDraft)) - ACCOUNT_DEVICE_NAME_MAX_RUNES);
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Send the open rename. One request; the prompt closes either way. */
  async submitRename(): Promise<void> {
    const open = this.prompt;
    if (open === null || open.kind !== "rename" || !this.renameValid) return;
    const id = open.id;
    const name = normalizeDeviceName(this.renameDraft);
    this.prompt = null;
    this.renameDraft = "";
    await this.#run(id, () => this.bridge.rename({ id, name }));
  }

  /**
   * Perform the confirmed revoke.
   *
   * Nothing here decides whether revoking the current device is allowed, and
   * nothing here signs anybody out: main owns both, under the account epoch the
   * revoke was captured with, so a late completion belonging to an account
   * somebody has already left cannot sign out whoever has since signed in.
   */
  async confirmRevoke(): Promise<void> {
    const open = this.prompt;
    if (open === null || open.kind !== "revoke") return;
    const id = open.id;
    this.prompt = null;
    await this.#run(id, () => this.bridge.revoke({ id }));
  }

  /**
   * One row operation, with the row held busy for exactly its duration.
   *
   * The token is what makes a superseded answer harmless: an account change
   * re-stamps every row, so an answer arriving afterwards finds its token gone
   * and writes nothing — rather than marking a row on the NEW account as
   * finished, or putting the previous account's failure beside it.
   */
  async #run(id: string, send: () => Promise<AccountMutationOutcome>): Promise<void> {
    if (this.#destroyed) return;
    if (this.rowState(id).busy) return;
    const epoch = this.#epoch;
    const token = ++this.#rowToken;
    this.#rowSeq.set(id, token);
    this.#setRow(id, { busy: true, outcome: null });
    let outcome: AccountMutationOutcome;
    try {
      outcome = await send();
    } catch {
      // The channel itself failed, so this app cannot tell whether main got as
      // far as sending anything. Reported as unknown for the same reason main
      // reports a lost reply as unknown: a retry might repeat something that
      // already happened.
      outcome = { kind: "uncertain" };
    }
    if (this.#destroyed || this.#epoch !== epoch || this.#rowSeq.get(id) !== token) return;
    this.#rowSeq.delete(id);
    this.#setRow(id, { busy: false, outcome });
    // A landed mutation is main's news to publish — it pushes the shortened or
    // renamed list itself. What is refreshed here is the case main CANNOT
    // resolve: an outcome this app could not determine leaves the local list
    // possibly wrong, so the list is re-READ. Never a re-send.
    if (outcome.kind === "uncertain") await this.refresh("devices");
  }

  #setRow(id: string, state: AccountRowState): void {
    this.rows = { ...this.rows, [id]: Object.freeze(state) };
  }

  #clearOutcome(id: string): void {
    if (this.rows[id] === undefined) return;
    const next = { ...this.rows };
    // A busy row keeps its busy flag: clearing a notice must not make a running
    // operation look finished.
    if (next[id].busy) next[id] = Object.freeze({ busy: true, outcome: null });
    else delete next[id];
    this.rows = next;
  }

  // -------------------------------------------------------------------------
  // The one way out of the app
  // -------------------------------------------------------------------------

  /**
   * Open the account page in the user's browser.
   *
   * A closed TOKEN crosses, never a URL: main maps it to a fixed path on this
   * build's own pinned origin and validates it before `shell.openExternal`. A
   * refusal is shown rather than a button that appears to do nothing.
   */
  async manage(): Promise<void> {
    if (this.#destroyed) return;
    const epoch = this.#epoch;
    const seq = ++this.#manageSeq;
    this.manageFailed = false;
    const result = await this.bridge
      .manage({ target: "account-management" })
      .catch(() => ({ ok: false }));
    // Guarded exactly like every other answer. Without the epoch check, a
    // refused open belonging to the account that has just been signed out put
    // "Could not open your browser" in front of whoever signed in next.
    if (this.#destroyed || this.#epoch !== epoch || this.#manageSeq !== seq) return;
    this.manageFailed = !result.ok;
  }

  /** Only the app's own teardown calls this. A page never does. */
  destroy(): void {
    this.#destroyed = true;
    // Everything in flight is invalidated: a read, a push or a mutation
    // answering after this point must write nothing.
    this.#viewSeq += 1;
    for (const id of [...this.#rowSeq.keys()]) this.#rowSeq.set(id, ++this.#rowToken);
    this.#rowSeq.clear();
    this.#refreshOwner.clear();
    this.#refreshToken += 1;
    this.#manageSeq += 1;
    for (const stop of this.#stop.splice(0)) stop();
  }
}
