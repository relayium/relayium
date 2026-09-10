// The complete list of things the renderer may ask the main process to do.
//
// ## Why the list is a constant and not a convention
//
// Every channel here is a hole in the sandbox. Written down in one place, the
// set is reviewable and testable: a test asserts that the preload bridge exposes
// exactly these names and no others, so a new capability cannot arrive by
// someone adding an `ipcRenderer.invoke` next to the code that needed it.
//
// ## What is deliberately absent
//
// There is no channel that takes a filesystem path, spawns a process, reads an
// arbitrary URL, or forwards a raw IPC message. The renderer cannot name a
// destination: it opens a lease against a folder the USER chose in a native
// dialog and afterwards refers to files by index. That is the whole reason a
// compromised renderer cannot write outside the chosen folder.

export const IPC = {
  /** Build/runtime facts the shell renders. No secrets. */
  appInfo: "relayium:app-info",
  /** Begin device-code sign-in. Returns the user code and opens the browser. */
  authStart: "relayium:auth-start",
  /** Poll once. Returns a status, never a token — see below. */
  authPoll: "relayium:auth-poll",
  /**
   * Abandon the sign-in attempt named by the renderer's nonce.
   *
   * A separate channel from `authSignOut` because they are separate acts:
   * cancelling an attempt must not touch a credential, and signing out must not
   * be reachable by a stale Cancel. Collapsing them would make an abandoned
   * sign-in able to log somebody out.
   */
  authCancel: "relayium:auth-cancel",
  /** Forget the bearer. Never touches the installation identity. */
  authSignOut: "relayium:auth-sign-out",
  /** Whether a bearer is held, and for which account. */
  authState: "relayium:auth-state",
  /** Native folder picker, then a validated lease. Returns a lease id. */
  receiveOpen: "relayium:receive-open",
  receiveBegin: "relayium:receive-begin",
  receiveWrite: "relayium:receive-write",
  receiveFinish: "relayium:receive-finish",
  receiveCancel: "relayium:receive-cancel",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Every channel name, for the preload-parity test. */
export const IPC_CHANNELS: readonly string[] = Object.values(IPC);

/**
 * The bearer never crosses to the renderer.
 *
 * The renderer is told *that* it is signed in and for which account; the token
 * itself stays in the main process, which is the only side that can attach it to
 * a request. A renderer that never holds the credential cannot leak it, and this
 * is the desktop equivalent of the web client's `HttpOnly` cookie — the property
 * that makes a script foothold survivable.
 */
export interface AuthState {
  readonly signedIn: boolean;
  readonly accountEmail: string;
  /** Distinguished from `signedIn: false`. "No session" and "I cannot open my
   *  own storage" are different problems, and only one is fixed by signing in —
   *  so the renderer must be able to tell them apart and say so. */
  readonly store: "ok" | "unreadable" | "unavailable";
}

/**
 * The renderer names its own sign-in attempt.
 *
 * It has to: Cancel must work while `authStart` is still in flight, and a name
 * the main process invents when that call RETURNS does not exist while it is
 * running. The nonce is correlation only — it grants no authority, and the
 * trust boundary remains the sender check in `ipc.ts`.
 */
export const MAX_ATTEMPT_NONCE_LENGTH = 64;

export interface AppInfo {
  readonly origin: string;
  readonly engineering: boolean;
  readonly banner: string | null;
  readonly version: string;
}

/** A write is bounded before it is buffered, so a chunk cannot become an
 *  allocation of the renderer's choosing. Mirrors the lease's own ceiling. */
export const MAX_IPC_CHUNK_BYTES = 256 * 1024;
/** A manifest above this is refused at the boundary, before planning. */
export const MAX_IPC_MANIFEST_ENTRIES = 1000;
