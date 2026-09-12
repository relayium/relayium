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
  /** Where a failure goes. stderr in the shipped app; never a dialog. */
  readonly report: (err: unknown) => void;
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
    return false;
  }
  let handle: NotificationHandle;
  try {
    handle = deps.create(title, body);
  } catch (err) {
    // Constructing one can throw; an app that let that escape would take down
    // whatever produced the event rather than merely failing to announce it.
    deps.report(err);
    return false;
  }
  handle.on("click", deps.onClick);
  // Windows and macOS emit this when the OS could not create or show the toast.
  // The error is the platform's own string; it goes to the same place a path or
  // an errno goes, and never to a user-facing surface.
  handle.on("failed", (_event, error) => {
    deps.report(new Error(`notification not shown: ${error}`));
  });
  try {
    handle.show();
  } catch (err) {
    deps.report(err);
    return false;
  }
  return true;
}
