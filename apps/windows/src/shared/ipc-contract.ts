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
  /**
   * Move the staged batch to its final names, or say truthfully that it could
   * not. The terminal step, and the only one that means "saved".
   */
  receivePublish: "relayium:receive-publish",
  /**
   * Open the ONE signalling route this build has, for one room.
   *
   * The renderer names a room KIND (and, for a code room, a validated code) —
   * never a URL, a host or a path. Main builds the address from the compiled
   * origin.
   */
  signalingOpen: "relayium:signaling-open",
  signalingSend: "relayium:signaling-send",
  signalingClose: "relayium:signaling-close",
  /** The ICE control plane. Fixed path, no credential, no redirects. */
  iceConfig: "relayium:ice-config",
  /**
   * Mint a pairing code.
   *
   * Takes NO parameter. The renderer asks for a code; the URL, method, header
   * and body are fixed in main. This is deliberately not a generic
   * authenticated-request channel — a renderer-supplied URL plus the bearer is
   * exactly what that would be.
   */
  pairCreate: "relayium:pair-create",
  /** The user's settings. Booleans only; nothing here is a credential. */
  prefsRead: "relayium:prefs-read",
  prefsWrite: "relayium:prefs-write",
  /**
   * The page's answer to a resident command, named by the request it answers.
   *
   * Separate from the unsolicited snapshot below, and that separation is the
   * point: a quit asking what is at stake must be answered by THIS question,
   * not satisfied by a push that happened to arrive first and describes a
   * moment before the question was asked.
   */
  residentAck: "relayium:resident-ack",
  /** The page volunteering its current state, whenever it changes. */
  residentSnapshot: "relayium:resident-snapshot",
  /**
   * A fact the page knows and main does not, worth a notification.
   *
   * A closed KIND and nothing else — no filename, no body, no sender, no path.
   * Main decides whether to show anything and writes every word of it.
   */
  residentNotify: "relayium:resident-notify",
  /**
   * Receive a stored object from a link the user pasted or opened.
   *
   * ## The one payload in this contract that carries a secret
   *
   * A stored link's fragment IS the decryption key. It travels renderer→main
   * here because the user pasted it — their own clipboard, not a widening of
   * main's custody — and that direction is the mirror of the one exception on
   * the send side, where a per-job content key travels main→renderer because
   * the renderer is what encrypts. Both are stated rather than glossed.
   *
   * What follows from it: the link is never echoed back, never included in a
   * refusal, a log line or a diagnostic, and never stored. The page renders
   * closed rejection codes, not the input it gave.
   */
  storedReceiveStart: "relayium:stored-receive-start",
  storedReceiveCancel: "relayium:stored-receive-cancel",
  /**
   * The outcome of a receive whose start was already acknowledged.
   *
   * Start returns a job id as soon as the job is ADMITTED, because a page that
   * only learns the id when the transfer ends cannot show progress for it or
   * cancel it. The outcome arrives as an event; this is the fallback for a page
   * that was not listening when it did.
   */
  storedReceiveResult: "relayium:stored-receive-result",
  /** What this process is holding: live receives and retained cleanup tickets. */
  storedInventory: "relayium:stored-inventory",
  /** Ask a retained destination to tear down again. Ticket, never a path. */
  storedCleanupRetry: "relayium:stored-cleanup-retry",
  /** Whether Relayium starts at sign-in, read back from the system. */
  loginItemRead: "relayium:login-item-read",
  /** Turn it on or off. Enabling requires the user's explicit confirmation,
   *  which main asks for natively. */
  loginItemWrite: "relayium:login-item-write",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Every channel name, for the preload-parity test. */
export const IPC_CHANNELS: readonly string[] = Object.values(IPC);

/**
 * The ONE main-to-renderer event name.
 *
 * ## Why an event direction exists at all, having been avoided until now
 *
 * The foundation is invoke-only, and that was right for everything it did: a
 * request with an answer needs no push. A signalling socket is not that shape.
 * Frames arrive because a PEER acted, not because this side asked, so without a
 * push the renderer would have to poll a socket — which is both slower and a
 * worse trust boundary, because a poll has to be allowed to ask repeatedly.
 *
 * ## Why this is one name and not a forwarder
 *
 * `preload.cts` subscribes to exactly this literal and re-exposes a typed
 * callback. There is no `on(channel, cb)`: a generic subscribe would make every
 * present and future main-to-renderer message reachable, which is the mirror of
 * the generic `invoke` the bridge already refuses. `ipc-contract.test.ts`
 * asserts the preload's set matches this file, so a second event cannot arrive
 * without review.
 */
export const IPC_EVENTS = {
  signalingEvent: "relayium:signaling-event",
  /** Main asking the page to do one of a closed set of things. */
  residentCommand: "relayium:resident-command",
  /** Cumulative decrypted bytes for one stored receive. Counts, nothing else. */
  storedProgress: "relayium:stored-progress",
  /** How one stored receive ended. */
  storedOutcome: "relayium:stored-outcome",
} as const;

export const IPC_EVENT_NAMES: readonly string[] = Object.values(IPC_EVENTS);

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
  /**
   * Whether same-network discovery should start on its own.
   *
   * Always true in a shipped build — matching `RelayiumApp.swift`, which calls
   * `startResident()` unconditionally. Only an ENGINEERING build can turn it
   * off, so an automated UI run can avoid joining a real production room.
   */
  readonly lanAutoStart: boolean;
}

/** A write is bounded before it is buffered, so a chunk cannot become an
 *  allocation of the renderer's choosing. Mirrors the lease's own ceiling. */
export const MAX_IPC_CHUNK_BYTES = 256 * 1024;
/** A manifest above this is refused at the boundary, before planning. */
export const MAX_IPC_MANIFEST_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// Signalling
// ---------------------------------------------------------------------------

/**
 * The renderer names its own socket, before it opens one.
 *
 * Exactly the reasoning behind `MAX_ATTEMPT_NONCE_LENGTH` above, applied to a
 * harder ordering problem. `signalingOpen` returns a promise, but the socket it
 * creates is live BEFORE that promise settles: a server can send `welcome` and
 * a peer roster in the same tick main calls `new WebSocket`. A renderer that
 * waited for the response to learn which socket to listen for would miss every
 * frame delivered in that window — and `welcome` carries this page's own peer
 * id, so losing it is losing the room.
 *
 * So the renderer mints the token, subscribes to it, and only then asks main to
 * open. No frame can precede the listener, because the listener exists before
 * the request is sent. The token is correlation only: it grants nothing, and
 * the trust boundary remains the sender check in `ipc.ts`.
 */
export const MAX_SOCKET_TOKEN_LENGTH = 64;

/** Which room a socket is for. A kind, never an address. */
export type SignalingRoom = { readonly kind: "lan" } | { readonly kind: "code"; readonly code: string };

/**
 * One socket per room, and there are two rooms.
 *
 * The Mac runs same-network and pairing transfers at the same time, so a single
 * socket (which is what the web page has, swapping rooms with `reconnect`) is
 * not the shape this client needs. Two is not a soft target: main refuses a
 * third, so a renderer fault cannot turn this into a connection pool.
 */
export const MAX_SIGNALING_SOCKETS = 2;

/**
 * The biggest signalling frame this app will send, or forward inbound.
 *
 * Signalling frames are SDP, ICE candidates and small JSON hellos. 64 KiB is
 * far above the largest real one and far below anything that matters as an
 * allocation.
 *
 * ## BYTES means bytes
 *
 * Measured as UTF-8 octets, which is what actually goes on the wire — not
 * `String.length`, which counts UTF-16 code units. The two differ by up to 3×
 * for CJK text and by 2× for astral characters, so a length check against a
 * byte-named ceiling silently accepts frames well over it. A filename in
 * Chinese is not an exotic input for this product; it is the common case.
 */
export const MAX_SIGNALING_FRAME_BYTES = 64 * 1024;

/** Outbound frames per second, per socket, before main starts refusing. */
export const MAX_SIGNALING_SENDS_PER_SECOND = 60;

/** Inbound frames per second, per socket, before main closes it. */
export const MAX_SIGNALING_INBOUND_PER_SECOND = 120;

/**
 * How much unsent data may sit in one socket's kernel/undici buffer.
 *
 * `bufferedAmount` is the real backpressure signal, and ignoring it is how a
 * renderer that sends faster than the network drains turns into unbounded
 * memory growth in the PRIVILEGED process. Above this, sends are refused until
 * it drains — refused loudly, because a silently dropped signalling frame is a
 * session that hangs with nothing on screen explaining it.
 */
export const MAX_SIGNALING_BUFFERED_BYTES = 1024 * 1024;

/** The frame types this build will put on a signalling socket. */
export const SIGNALING_FRAME_TYPES: readonly string[] = ["join", "signal", "activate"];

/** What main pushes to the renderer for a socket it owns. */
export type SignalingEvent =
  | { readonly token: string; readonly kind: "open" }
  | { readonly token: string; readonly kind: "message"; readonly data: string }
  | { readonly token: string; readonly kind: "close"; readonly reason: SignalingCloseReason };

/**
 * Why a socket ended. The renderer renders these; none of them may be silent.
 *
 * `oversize` and `flooded` are main's own refusals rather than the network's,
 * and they are named separately so a bug in this app is never displayed as the
 * peer having gone away.
 */
export type SignalingCloseReason =
  | "remote"
  | "failed"
  | "local"
  | "oversize"
  | "flooded"
  | "revoked";

// ---------------------------------------------------------------------------
// ICE control plane
// ---------------------------------------------------------------------------

/**
 * What main says about one `/api/ice` attempt.
 *
 * ## Main is the TRANSPORT here, and nothing more
 *
 * The first draft of this channel returned a verdict — an `ok` flag and a
 * flattened server list — and that was wrong in a way worth writing down,
 * because it looked like hardening. `web/src/lib/ice.ts` owns roughly eighty
 * lines of argued classification: a 429 is rate-limiting and is NOT retried, a
 * 403 carrying `relayDenied` is a deliberate withholding the user must be told
 * about, a 5xx is transient and gets exactly one retry inside a `Retry-After`
 * cap, and a code room that came back with no TURN anywhere is `none` rather
 * than a healthy LAN answer. A verdict computed in main threw all of that away:
 * quota exhaustion, an unverified email and an unplugged network cable all
 * arrived at the renderer as the same empty list, which is precisely the silent
 * failure `RelayAvailability` was introduced to end.
 *
 * So main answers with the two things only main can know — what the server's
 * status line said, and a bounded body — and `fetchIceConfig` classifies. One
 * copy of the reasoning, in the module that already had it.
 *
 * ## What main still refuses to pass on
 *
 * The body is narrowed to the fields this protocol defines, with every string
 * bounded and every URL restricted to the three schemes an ICE agent
 * understands. The renderer does not receive an arbitrary JSON blob from the
 * network with the privileged process's credibility attached to it — it
 * receives a shape. `relayDenied`, `region` and `stun` are part of that shape:
 * dropping them is not narrowing, it is losing the answer.
 */
export interface IceServerView {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface IceRelayView {
  readonly id: string;
  /** Carried, not interpreted. The renderer shows it; main has no view on it. */
  readonly region?: string;
  readonly stun?: string;
  readonly iceServers: readonly IceServerView[];
}

/** The narrowed `/api/ice` body — success or denial, both matter. */
export interface IceBodyView {
  readonly iceServers?: readonly IceServerView[];
  readonly relays?: readonly IceRelayView[];
  /** The server's own explanation for withholding TURN. An ANSWER, not a
   *  failure, and the one field a lossy narrowing would have deleted. */
  readonly relayDenied?: string;
}

/**
 * Why main could not produce a status line at all.
 *
 * Distinct from an HTTP status: these are the cases where there is no response
 * to classify, and the renderer's transport turns each of them into a rejected
 * promise — which is exactly what `readIceConfig`'s `catch` already treats as
 * "unavailable, worth one retry".
 */
export type IceTransportFailure = "network" | "timeout" | "redirect" | "refused";

export type IceReply =
  | { readonly ok: false; readonly failure: IceTransportFailure }
  | {
      readonly ok: true;
      readonly status: number;
      /** `Retry-After` as delta-seconds, when the server sent a usable one.
       *  Bounded here so a hostile value cannot become an unbounded wait; the
       *  five-second retry cap in `ice.ts` still applies on top. */
      readonly retryAfterSeconds?: number;
      /** `null` when the body was absent, unreadable, or over the ceiling —
       *  which `ice.ts` classifies exactly as it classifies a body that is not
       *  JSON, because that is what it is. */
      readonly body: IceBodyView | null;
    };

/** Bounds on what main will accept back from `/api/ice` before forwarding it. */
export const MAX_ICE_SERVERS = 16;
export const MAX_ICE_RELAYS = 8;
export const MAX_ICE_URLS_PER_SERVER = 8;
export const MAX_ICE_STRING_LENGTH = 512;
/** An hour. Far past anything `ice.ts` would wait for, and a ceiling rather than
 *  a policy: the retry decision stays in the shared module. */
export const MAX_ICE_RETRY_AFTER_SECONDS = 3600;

/**
 * How many `/api/ice` reads one room may have in flight at once.
 *
 * A bounded body is not admission control: a renderer fault that loops on
 * `iceConfig` would open one privileged outbound connection per call, each with
 * its own fifteen-second deadline, and the size ceiling would bound none of it.
 * Two, because the shared module's one retry means a healthy room issues at
 * most two — and the second only after the first has settled.
 *
 * Requests belong to a ROOM, not merely to a document: closing one room must
 * release what that room is holding while the other room's read continues.
 */
export const MAX_ICE_REQUESTS_PER_ROOM = 2;

/**
 * How many distinct rooms one document may have ICE reads open for.
 *
 * The per-room cap alone bounds nothing: `owner` is a string the RENDERER
 * chooses, so varying it per call yields two more requests every time. Measured
 * against the frozen implementation, 500 concurrent privileged outbound
 * requests were admitted under a cap that reads as two
 * (`ice-admission-repro.mjs`). This is the bound that makes the owner name a
 * partition rather than an escape hatch, and it is `MAX_SIGNALING_SOCKETS`
 * because a document has exactly that many rooms.
 */
export const MAX_ICE_ROOMS_PER_DOCUMENT = MAX_SIGNALING_SOCKETS;

/**
 * How many ICE reads this process will have UNSETTLED at once, over everything.
 *
 * The backstop, and the only bound that counts the actual resource: one
 * privileged outbound connection with its own deadline. Counted against
 * requests that have not settled — NOT against requests that have merely been
 * aborted. An abort asks a connection to end; it does not end it, and freeing
 * capacity at the ask is how a fault that aborts in a loop keeps its
 * connections while the ledger says it holds none.
 *
 * Two documents' worth (2 rooms x 2 reads x 2), so a reload whose aborted reads
 * have not yet settled cannot starve the document replacing it.
 */
export const MAX_ICE_REQUESTS_IN_FLIGHT = 8;

// ---------------------------------------------------------------------------
// Pairing code
// ---------------------------------------------------------------------------

/**
 * Exactly how many digits a pairing code has.
 *
 * One number, because four independent checks have to agree on it:
 * `ValidCodeFormat` on the server, `isValidCode` in `web/src/lib/pair-code`,
 * `isWellFormedCode` in `signaling-socket.ts`, and the mint parser. A build that
 * accepted a longer code somewhere would put one on screen and then refuse to
 * open the room with it.
 */
export const PAIR_CODE_LENGTH = 6;

/**
 * What main says about a mint.
 *
 * The refusals are separate values because each is a different sentence to the
 * user and a different next action: sign in, wait, verify your email, upgrade,
 * try again. Collapsing them into one failure is what makes a product say
 * "something went wrong" at somebody who could have fixed it in ten seconds.
 */
export type PairMintResult =
  | { readonly ok: true; readonly code: string; readonly expiresAt: number }
  | {
      readonly ok: false;
      readonly refusal: "signed-out" | "quota" | "unverified" | "rate-limited" | "unavailable";
    };

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/**
 * The settings the renderer may read and set. Booleans, by name, from a fixed
 * list — never an arbitrary key/value store.
 */
export interface PreferencesValues {
  /** Ask the user to compare a verification code. Default off, mirroring
   *  `com.relayium.verifyPeers`. Governs the PROMPT, never the cryptography. */
  readonly verifyPeers: boolean;
}

/**
 * The values, and whether they are known to be the user's.
 *
 * `health` exists because the alternative is a lie the user cannot see: a
 * settings file that has become unreadable would otherwise render as "verify
 * peers: off", which is indistinguishable from the user having turned it off.
 */
export interface PreferencesView {
  readonly values: PreferencesValues;
  readonly health: "ok" | "missing" | "unreadable";
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

/**
 * Which authority a receive lease belongs to.
 *
 * `account` is the existing behaviour and remains the DEFAULT, so every
 * account-fenced guarantee the foundation established — a picker that returned
 * after a sign-out is refused, an account change cancels in-flight leases —
 * applies unchanged to everything that does not explicitly ask otherwise.
 *
 * `direct` exists because LAN and pairing transfers work signed out. Their
 * leases are owned by the room, not by an account: signing in or out must not
 * cancel a transfer between two machines that never had an account in it, and
 * the Mac agrees — `LanTransferDestination` holds no `AccountSession` at all.
 * A `direct` lease is still cancelled by its room, by an explicit cancel, and
 * by quit.
 */
export type ReceiveAuthority = "account" | "direct";

/**
 * The result of the terminal publication step.
 *
 * `partial` is a first-class outcome, not an error string: the helper publishes
 * in manifest order and stops at the first conflict, so some files may genuinely
 * exist under their final names while others never will. Reporting that as
 * either total success or total failure would be a lie in one direction or the
 * other.
 */
export type PublishReport =
  | { readonly status: "complete"; readonly publishedCount: number; readonly total: number }
  | {
      readonly status: "partial";
      readonly publishedCount: number;
      readonly total: number;
      readonly failedIndex: number;
      readonly reason: string;
    }
  /**
   * Publication did not produce a receipt.
   *
   * ## Why this is a RESULT and not a thrown error
   *
   * Electron serialises a rejection across IPC by its message. Every custom
   * property is lost — so `NativeHelperError`'s `code`, its `residue` flag and
   * its `publishReport` would all arrive at the renderer as a string, and the
   * renderer would have to parse prose to find out whether the user's files
   * were written or whether bytes were left on their disk. Both of those are
   * facts a person acts on.
   *
   * So the failure is a value with named fields, and the fields are the ones a
   * user needs: was anything saved, and is anything left behind.
   */
  | {
      readonly status: "failed";
      /** A stable reason this build understands. Never the helper's raw message,
       *  which can carry a path. */
      readonly reason: PublishFailureReason;
      /**
       * Bytes may remain in the user's folder. Never a guess dressed as
       * `false` — it is `true` whenever cleanup could not confirm otherwise.
       */
      readonly residue: boolean;
      /**
       * The receipt, when publication SUCCEEDED and only the teardown after it
       * failed. Those files exist under their final names, and an error about
       * cleanup must not erase that.
       */
      readonly published?: { readonly publishedCount: number; readonly total: number };
    };

/**
 * Why a publication produced no receipt.
 *
 * A closed list, mapped from the helper's own codes. The helper's message and
 * any path it might contain are deliberately NOT forwarded: the renderer needs
 * to know which sentence to show, not where on disk anything is.
 */
export type PublishFailureReason =
  | "unsupported"
  | "helper-unavailable"
  | "timeout"
  | "cancelled"
  | "cleanup-uncertain"
  | "io-failed"
  | "internal";

/** The five browseable pages, mirrored from the renderer's own navigation. */
export const RESIDENT_PAGES = ["lan", "pair", "stored", "inbox", "account"] as const;
export type ResidentPage = (typeof RESIDENT_PAGES)[number];

/**
 * Everything main may ask the page to do.
 *
 * A closed union of verbs with bounded operands — no URL, no path, no script, no
 * selector. The tray can open a page and pause Nearby; a deep link can carry a
 * pairing code; a quit can ask what is at stake and, once the user has agreed,
 * tell the page to stop. Nothing here can name a destination.
 */
export type ResidentCommand =
  | { readonly kind: "navigate"; readonly page: ResidentPage }
  | { readonly kind: "lan"; readonly action: "pause" | "resume" }
  /** Answer with a FRESH snapshot in the acknowledgement. */
  | { readonly kind: "risk-snapshot" }
  /**
   * Stop STARTING things, without stopping what is running.
   *
   * The renderer half of the quit fence. Main can refuse a new receive by
   * itself, but an outgoing send, a new room and a pairing join all begin in
   * the page — so a "nothing at stake" answer is only true if the page has also
   * agreed to start nothing while the question is being answered.
   */
  | { readonly kind: "admission"; readonly action: "fence" | "admit" }
  /** Stop rooms and transfers. Sent only after the user agreed to quit. */
  | { readonly kind: "quiesce" }
  /** The user stayed. Operate again — without resurrecting what was stopped. */
  | { readonly kind: "resume" }
  /**
   * A pairing code that arrived from outside the app.
   *
   * The code stays a STRING end to end, so `004291` keeps its leading zeros; a
   * number would deliver `4291` and join the wrong room.
   */
  | { readonly kind: "pair-code"; readonly code: string; readonly mode?: "text" | "files" }
  /**
   * A stored link that arrived from outside the app.
   *
   * Carries the whole link, fragment included, because the fragment IS the key
   * and the page is what offers it back to be received. Showing it is not
   * receiving it: the page puts it on the Stored page for the user to confirm,
   * and the folder picker is what authorises writing files.
   */
  | { readonly kind: "stored-link"; readonly link: string };

export type ResidentCommandKind = ResidentCommand["kind"];

/** What the page believes is at stake right now. */
export interface ResidentSnapshot {
  /** Outgoing bytes in flight — the half main cannot see, because a WebRTC
   *  send lives in the page. */
  readonly sending: boolean;
  /** Incoming bytes in flight. */
  readonly receiving: boolean;
  /** Composed-but-unsent text, per room. Bounded; a count, never the text. */
  readonly drafts: number;
  /**
   * The language the PAGE is showing.
   *
   * Main's dialogs, tray and notifications follow this rather than reading the
   * OS themselves: `app.getLocale()` and Chromium's `navigator.language` can
   * disagree, and a Chinese window with an English quit dialog is one product
   * speaking two languages.
   */
  readonly locale: "en" | "zh-Hans";
  /** Whether same-network discovery is running right now, so the tray item can
   *  say which thing it does rather than guessing. */
  readonly nearby: boolean;
}

/** What the page may ask main to announce. Facts main cannot observe itself. */
export type ResidentNotice = "saved-message" | "attention";

/** The largest draft count that will be believed. Beyond it the page is not
 *  describing a person's unsent messages. */
export const MAX_RESIDENT_DRAFTS = 64;

export type ResidentAckFailure = "unknown-command" | "stale" | "refused";

/**
 * One answer to one command.
 *
 * `requestId` and `generation` together are what make a late reply harmless: an
 * answer to a retired question, or one from a document that has since been
 * replaced, is dropped rather than allowed to settle an outstanding query.
 */
export interface ResidentAck {
  readonly requestId: string;
  readonly generation: number;
  readonly ok: boolean;
  readonly snapshot?: ResidentSnapshot;
  readonly failure?: ResidentAckFailure;
}

export const MAX_REQUEST_ID_LENGTH = 64;

export function isResidentPage(value: unknown): value is ResidentPage {
  return typeof value === "string" && (RESIDENT_PAGES as readonly string[]).includes(value);
}

/** Progress for one stored receive. A job id and two counts; never a name. */
export interface StoredProgress {
  readonly jobId: string;
  readonly received: number;
  readonly total: number;
}

/**
 * A link the page is offering to main, from a paste or an OS deep link.
 *
 * The page may put a code on screen for a refusal, and nothing else about it.
 */
export const MAX_STORED_LINK_LENGTH = 2048;
