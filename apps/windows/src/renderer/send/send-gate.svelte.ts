// Whether this page may START outgoing work right now.
//
// ## Why a gate and not a disabled button
//
// A quit asks what is at stake, gets an answer, and then shows a dialog a person
// reads for several seconds. Main can refuse a new RECEIVE by itself, but every
// outgoing path begins here: a file picker, a drop, a Send press, and — the one
// that has no button at all — a held message auto-delivering the moment a peer
// accepts the lane. Each of those has an await in the middle, so checking at the
// click is checking the wrong moment: the picker the user opened before the quit
// resolves after it, and a snapshot that said "nothing at stake" becomes false
// while the dialog is still on screen.
//
// So permission is a TICKET taken when the user acts and checked when the work
// is finally ready to start, and a fence invalidates every ticket outstanding.
// A boolean alone let a pick that began before a quit complete after it, once
// the user chose Stay — the same intent, formed before a question they had since
// answered. The flag remains, to disable the controls so nothing looks live that
// is not.
//
// ## What it is NOT
//
// Not a stop. A transfer that is running keeps running — fencing is about
// admission, and cancelling in-flight work is what a quiesce does, after the
// user has agreed to quit. And it is lifted on Stay, so the next thing the user
// does works.

/**
 * The page's outgoing admission, shared by every surface that can start work.
 *
 * A module singleton on purpose: there is one window, one quit at a time, and
 * one answer to "may this page begin something". Threading it as a prop through
 * every page and pane would leave whichever one was missed silently open, which
 * is the failure this exists to close.
 */
class SendGate {
  #fenced = $state(false);
  /**
   * Bumped by every fence, so permission cannot be recovered by waiting.
   *
   * A boolean was not enough, and the hole was specific: a picker opened before
   * a quit, a fence, then Stay, then the picker resolves — the flag reads
   * "open" and the file goes out, from an intent the user formed before a
   * question they have since answered. A permission captured at the moment they
   * acted is compared against this, so a fence invalidates it permanently. What
   * they get instead is one more click, deliberately.
   */
  #generation = $state(0);

  /** True while a quit is deciding. Read by the UI to disable its controls. */
  get fenced(): boolean {
    return this.#fenced;
  }

  fence(): void {
    // Bumped even when already fenced: two quits in a row must not let a ticket
    // taken between them survive.
    this.#generation += 1;
    this.#fenced = true;
  }

  admit(): void {
    this.#fenced = false;
  }

  /**
   * Permission to start something, taken at the moment the user asked for it.
   *
   * `null` when the page is already fenced. Hold it across the await — the
   * native dialog, the directory read, the lane opening — and present it when
   * the work is finally ready to start.
   */
  ticket(): Ticket {
    return this.#fenced ? null : { generation: this.#generation };
  }

  /** Whether a ticket still authorises anything. */
  valid(ticket: Ticket): boolean {
    return ticket !== null && !this.#fenced && ticket.generation === this.#generation;
  }

  /**
   * Start work a ticket authorises.
   *
   * Returns whether it ran, so a caller can leave its own state alone — a
   * composer must keep the text it did not send.
   */
  startWith(ticket: Ticket, work: () => void): boolean {
    if (!this.valid(ticket)) return false;
    work();
    return true;
  }

  /** Start work the user is asking for right now. */
  start(work: () => void): boolean {
    return this.startWith(this.ticket(), work);
  }

  /**
   * Choose something, then send it — carrying the permission across the choice.
   *
   * This is the ordering the whole file exists for. `pick` is a native file
   * dialog or a drop being read off the filesystem; both take time a person
   * spends, and a quit can begin AND be answered inside it.
   */
  async pickThenStart<T>(pick: () => Promise<T>, send: (picked: T) => void): Promise<boolean> {
    const ticket = this.ticket();
    if (ticket === null) return false;
    const picked = await pick();
    return this.startWith(ticket, () => send(picked));
  }
}

/** Permission to start outgoing work, or `null` for none. */
export type Ticket = { readonly generation: number } | null;

export const sendGate = new SendGate();
