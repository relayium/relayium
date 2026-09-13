// Showing a toast, and noticing when the OS did not.
//
// ## What was silent
//
// The platform used to construct a `Notification`, listen for `click`, and call
// `show()`. Electron emits `failed` on Windows "when an error is encountered
// while creating and showing the native notification" — and nothing listened.
// A toast the OS refused was silent twice over: the user never saw it, and the
// app went on believing it had told them.
//
// That matters here more than in most apps. This one's job is to stay reachable
// while its window is hidden, and a notification is how it says a file arrived.
// A delivery nobody is told about is, from the user's side, a delivery that did
// not happen.
//
// `isSupported()` returning false was silent for the same reason and is now
// reported too. It is not expected on Windows; that is exactly why it deserves
// a line rather than a shrug if it ever happens.
//
// ## Why this is a module and not four lines in `main.ts`
//
// The failure path is the part worth testing, and it cannot be reached through
// the real `Notification` — a unit test cannot make Windows refuse a toast, and
// a CI runner has no shortcut for this app's AppUserModelID, so asserting a
// real `show` there would measure the runner. Injecting the constructor makes
// the branch reachable; the shipped wiring stays one line.

/** The parts of `Electron.Notification` this uses. */
export interface NotificationHandle {
  on(event: "click", listener: () => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
  show(): void;
}

export interface NotifyDeps {
  /** `Notification.isSupported()`. */
  readonly isSupported: () => boolean;
  readonly create: (title: string, body: string) => NotificationHandle;
  /** What a click does. The window comes forward. */
  readonly onClick: () => void;
  /** Where a failure DETAIL goes. stderr in the shipped app; never a dialog,
   *  and never a user-facing surface: it is the platform's own string. */
  readonly report: (err: unknown) => void;
  /**
   * Whether a toast reached the screen, as a fact rather than a detail.
   *
   * Separate from `report` because they answer different questions and go to
   * different places. `report` carries the platform's message, which is a log
   * line. This carries only "it worked" or "it did not", which is the one part
   * of a failed notification a person can act on — and until now nothing acted
   * on it at all: every failure went to stderr and the user, whose window was
   * shut, was told nothing by a feature whose entire job is to tell them.
   *
   * `false` is only ever OBSERVED, never inferred. Electron cannot ask Windows
   * whether this app is muted, so nothing here claims notifications are off —
   * it claims one did not appear, which is what was seen.
   */
  readonly onOutcome?: (shown: boolean) => void;
}

/**
 * Show one notification, and report it if the platform will not.
 *
 * Returns whether `show()` was reached, so a caller can tell "asked" from "not
 * asked". It deliberately does NOT report whether the toast appeared: that is
 * asynchronous and the `failed` listener is what answers it.
 */
export function showNotification(deps: NotifyDeps, title: string, body: string): boolean {
  if (!deps.isSupported()) {
    deps.report(new Error("notification not shown: this platform reports no notification support"));
    deps.onOutcome?.(false);
    return false;
  }
  let handle: NotificationHandle;
  try {
    handle = deps.create(title, body);
  } catch (err) {
    // Constructing one can throw; an app that let that escape would take down
    // whatever produced the event rather than merely failing to announce it.
    deps.report(err);
    deps.onOutcome?.(false);
    return false;
  }
  handle.on("click", deps.onClick);
  // Windows and macOS emit this when the OS could not create or show the toast.
  // The error is the platform's own string; it goes to the same place a path or
  // an errno goes, and never to a user-facing surface.
  handle.on("failed", (_event, error) => {
    deps.report(new Error(`notification not shown: ${error}`));
    // Asynchronous, and the only signal Windows gives when the OS refuses or
    // suppresses a toast. A `show()` that returned is not a toast anybody saw.
    deps.onOutcome?.(false);
  });
  try {
    handle.show();
  } catch (err) {
    deps.report(err);
    deps.onOutcome?.(false);
    return false;
  }
  // Reached the platform. `failed` may still fire and say otherwise, which is
  // why this is reported here rather than assumed by the caller — and why a
  // later success is what clears the warning.
  deps.onOutcome?.(true);
  return true;
}
