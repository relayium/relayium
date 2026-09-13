// Whether Windows starts Relayium when the user signs in.
//
// ## Not a Bool, and not what `setLoginItemSettings` returned
//
// macOS models this with five states because `SMAppService` can report
// `requiresApproval` — registered, but held until the user approves it — and
// reporting that as "on" would claim a residency the app does not have.
//
// Electron 44.3.0 has no such status on Windows: `LoginItemSettings.status` is
// `@platform darwin`, and there is no `startupApproved` field. What Windows does
// give is `executableWillLaunchAtLogin`, documented as true when the app is set
// to open at login **and its run key is not deactivated**.
//
// That difference is the whole point of this module. A user who turns Relayium
// off under Task Manager → Startup apps leaves `openAtLogin` true and
// `executableWillLaunchAtLogin` false. The registration exists; nothing will
// launch. Calling that "on" would be a lie the user cannot see through, because
// the switch they turned off is in a different application.
//
// `setLoginItemSettings` returns nothing, so it is never treated as evidence:
// the state after a write is whatever the system reports afterwards.

export type LoginItemState =
  /** No registration, nothing will launch. */
  | "off"
  /** Registered and will launch. */
  | "on"
  /** Registered, but switched off under Task Manager → Startup apps. */
  | "disabled-by-user"
  /**
   * Not registered by this app, yet something on this PC will launch it — a
   * Group Policy run key, a shortcut in the Startup folder, another installer.
   * Reported honestly instead of being flattened into "off", which would invite
   * the user to enable a startup entry they already effectively have.
   */
  | "on-by-other-means";

/** The subset of `Electron.LoginItemSettings` this module depends on. */
export interface LoginItemSettingsSnapshot {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin: boolean;
}

/**
 * The system, injected.
 *
 * `read` must ask Windows every time. The user can change this in Task Manager
 * while the app runs and nothing tells the app when they do, so a cached answer
 * is a stale answer — the same reason macOS's `SystemLoginItem` deliberately
 * holds no state.
 */
export interface LoginItemSystem {
  readonly read: () => LoginItemSettingsSnapshot;
  readonly write: (openAtLogin: boolean) => void;
  /**
   * Where the actual error goes.
   *
   * Required, so it cannot be forgotten. The failures below are CLOSED codes
   * with no message, because they cross into IPC and onto a settings screen; a
   * raw `err.message` from the registry or a policy denial is arbitrary text
   * that may name paths or accounts. Not swallowed, not shown.
   */
  readonly reportFailure: (err: unknown) => void;
}

export function classify(snapshot: LoginItemSettingsSnapshot): LoginItemState {
  if (snapshot.openAtLogin) {
    return snapshot.executableWillLaunchAtLogin ? "on" : "disabled-by-user";
  }
  return snapshot.executableWillLaunchAtLogin ? "on-by-other-means" : "off";
}

export type LoginItemFailure =
  /** The system could not be asked. NOT the same as "off". */
  | { readonly kind: "unreadable" }
  | { readonly kind: "write-failed" }
  /** The consent step did not produce an answer, so nothing was written. */
  | { readonly kind: "consent-failed" };

export type LoginItemOutcome =
  | { readonly ok: true; readonly state: LoginItemState }
  | { readonly ok: false; readonly failure: LoginItemFailure };

/**
 * What the system says right now.
 *
 * A throwing `read` is reported, not turned into "off". "Off" is a claim about
 * the machine; "I could not find out" is a claim about this call, and a settings
 * screen that shows the first when it means the second invites the user to fix
 * something that may not be broken.
 */
export function currentState(system: LoginItemSystem): LoginItemOutcome {
  try {
    return { ok: true, state: classify(system.read()) };
  } catch (err) {
    system.reportFailure(err);
    return { ok: false, failure: { kind: "unreadable" } };
  }
}

export type ConsentDecision = "confirmed" | "declined";

/**
 * Turn startup on, but only after the user says so.
 *
 * The confirmation is required by the caller's signature rather than
 * recommended in a comment: `enable` cannot be called without a decision. A
 * `declined` decision performs no write at all — not a write followed by an
 * undo, which would leave a startup entry behind if the process died between
 * the two.
 */
export async function enable(
  system: LoginItemSystem,
  askConsent: () => Promise<ConsentDecision>,
): Promise<LoginItemOutcome> {
  let decision: ConsentDecision;
  try {
    decision = await askConsent();
  } catch (err) {
    // A prompt that failed is not consent.
    system.reportFailure(err);
    return { ok: false, failure: { kind: "consent-failed" } };
  }

  // Exactly `confirmed`, not "anything that is not declined". The adapter is a
  // dialog at the other end of an IPC boundary; an undefined, a malformed
  // value, or a future third option must not add a startup entry the user
  // never agreed to. Enabling is the privileged direction, so it takes the
  // affirmative test.
  if (decision !== "confirmed") return currentState(system);

  try {
    system.write(true);
  } catch (err) {
    system.reportFailure(err);
    return { ok: false, failure: { kind: "write-failed" } };
  }
  // Deliberately re-read: the write returns nothing, and on Windows it can
  // succeed while the run key remains deactivated.
  return currentState(system);
}

/** Turn startup off. No consent step: removing a permission is not a grant. */
export function disable(system: LoginItemSystem): LoginItemOutcome {
  try {
    system.write(false);
  } catch (err) {
    system.reportFailure(err);
    return { ok: false, failure: { kind: "write-failed" } };
  }
  return currentState(system);
}
