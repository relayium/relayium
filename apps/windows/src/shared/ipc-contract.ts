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

/**
 * The terminal outcome and failure vocabulary are the Inbox's OWN.
 *
 * Imported as types rather than restated here. `receipts.ts` is the module that
 * decides what may cross out of the Inbox at all — its comment is explicit that
 * every member carries codes, counts and booleans and that no member can hold a
 * path, a key or a server string. Re-declaring that union in this file would
 * create a second copy free to drift from the rule it exists to enforce, and
 * the drift would be invisible: two structurally similar unions compile.
 *
 * Type-only, so nothing from `src/main/**` is bundled into the renderer.
 */
import type { DeliveryReceipt, InboxFailureCode, ResidueState } from "../main/inbox/receipts.js";
import type { TaskPhase } from "../main/inbox/journal.js";
import type { SupportReport } from "../main/policy/policy-gate.js";

export type { DeliveryReceipt, InboxFailureCode, ResidueState, TaskPhase, SupportReport };

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
   * Show the user the folder a FINISHED receive saved into.
   *
   * Named by the opaque token the receipt carried, never by a path. The
   * renderer was never given the directory, so it cannot ask for a different
   * one; main resolves the token against what it kept and refuses — with a
   * closed reason — when the receipt is stale, fenced or unknown.
   */
  receiveReveal: "relayium:receive-reveal",
  /**
   * What the OS handed this process, if anything.
   *
   * The pane asks once on mount; everything after that arrives on
   * `IPC_EVENTS.osEntryState`. A selection is STAGED by main from `--send-files`
   * — the renderer cannot stage one, because it would have to name paths to do
   * it, and no channel here takes a path.
   */
  osEntryState: "relayium:os-entry-state",
  /**
   * One bounded range of one staged file, named by its capability token.
   *
   * The token indexes a file main opened at staging; it is not a path and
   * cannot be turned into one. Ranges are bounded by `MAX_SELECTION_CHUNK` so a
   * page cannot ask main to materialise a file in memory.
   */
  osEntryRead: "relayium:os-entry-read",
  /**
   * Dismiss the staged selection.
   *
   * Sending belongs to the send lane, not here. This exists so a person who
   * opened the wrong thing can put it down, and so the tokens stop resolving.
   */
  osEntryClear: "relayium:os-entry-clear",
  /**
   * The pairing handoff: one live code, its join link and its QR.
   *
   * Read once on mount; everything after arrives on the pushed event. The code
   * itself is minted through `pairCreate` — this is the surface that turns a
   * minted code into something a person can hand to another device.
   */
  pairHandoffState: "relayium:pair-handoff-state",
  /**
   * Copy the join link, by NAMING the action rather than supplying the text.
   *
   * The payload carries no URL and no code. Main writes what main retained, so
   * a renderer cannot put arbitrary text on the user's clipboard through this
   * channel, and a code that has expired or outlived its document is refused
   * instead of copied.
   */
  pairHandoffCopy: "relayium:pair-handoff-copy",
  /**
   * Drag a received file out, or show it in Explorer.
   *
   * Named by the capability token the item was announced with. The renderer
   * never learns where the file is, so it cannot ask for one it was not given,
   * and main re-checks that the file is still the one it registered before the
   * OS is asked to do anything with it.
   */
  receivedAct: "relayium:received-act",
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

  // -------------------------------------------------------------------------
  // Device Inbox — receive
  // -------------------------------------------------------------------------
  //
  // ## What is deliberately absent from every channel below
  //
  // No claim token, no wrapped key, no manifest, no destination path, and no
  // way for the renderer to name one. Enabling opens a NATIVE folder dialog in
  // main; the page asks for the feature and main asks the person. A delivery is
  // named by its server task id, a message by its vault id, and a retained
  // cleanup by an opaque key. What comes back is closed codes and counts.
  //
  // The one payload here that is the user's own content is the body of a
  // message THEY received, returned by `inboxOpenMessage` because showing it is
  // the entire point of receiving it.

  /** Everything the Inbox page renders about state. Counts and closed codes. */
  inboxState: "relayium:inbox-state",
  /**
   * Turn receiving on, with explicit consent.
   *
   * Main opens the native folder dialog as part of this call, so there is no
   * window in which the app is "enabled" without a destination the user chose.
   * A declined dialog enrols nothing.
   */
  inboxEnable: "relayium:inbox-enable",
  /** Turn receiving off and withdraw the enrolment. Erases nothing local. */
  inboxDisable: "relayium:inbox-disable",
  /** Choose a different destination, natively. Does not change consent. */
  inboxChooseFolder: "relayium:inbox-choose-folder",
  /** What central says is waiting. Claims nothing and takes no lease. */
  inboxPending: "relayium:inbox-pending",
  /** Accept one held delivery and receive it. */
  inboxAccept: "relayium:inbox-accept",
  /** Decline one held delivery. */
  inboxReject: "relayium:inbox-reject",
  /** Messages already saved. Metadata only; no message bytes. */
  inboxMessages: "relayium:inbox-messages",
  /** One message's text, because reading it is why it was received. */
  inboxOpenMessage: "relayium:inbox-open-message",
  /**
   * Put one saved message on the clipboard, from MAIN.
   *
   * ## Why this is a channel rather than `navigator.clipboard`
   *
   * `window.ts` denies every permission request and every permission check, on
   * purpose — a renderer that never asks for a capability must not be granted
   * one by a default-allow policy. `navigator.clipboard.writeText` is subject
   * to exactly that guard, so a Copy button built on it does not sometimes
   * fail: it never works, and relaxing the session policy to make one button
   * work would open the same door for everything else the page could ask for.
   *
   * So the page names a MESSAGE — an id it could already open through
   * `inboxOpenMessage` — and main reads that message under the live account and
   * writes it. There is deliberately no channel that takes a string and puts it
   * on the clipboard: this can copy the user's own received messages and
   * nothing else, and an account that has gone away refuses.
   */
  inboxCopyMessage: "relayium:inbox-copy-message",
  /** Delete one message. Never rides along with disabling or signing out. */
  inboxDeleteMessage: "relayium:inbox-delete-message",
  /** Rename this device. The server judges the name. */
  inboxRename: "relayium:inbox-rename",
  /** "Try again now" — end the current backoff instead of waiting it out. */
  inboxWake: "relayium:inbox-wake",
  /** Ask a retained destination to tear down again. A key, never a path. */
  inboxReleaseRetained: "relayium:inbox-release-retained",
  /**
   * Choose off / ask / auto.
   *
   * `ask` and `auto` need a destination, so a call with none recorded opens the
   * native folder dialog exactly as enabling does. `off` needs none: it asks
   * central to stop sending here, which is meaningful either way.
   */
  inboxSetPolicy: "relayium:inbox-set-policy",
  /**
   * Show the receiving folder.
   *
   * MAIN owns the path and MAIN performs the action. There is no argument here
   * that could name a directory, and none is returned.
   */
  inboxRevealFolder: "relayium:inbox-reveal-folder",
  /** What this account has received. Counts and outcomes; never a name. */
  inboxReceipts: "relayium:inbox-receipts",
  /**
   * What this account has received, BY NAME.
   *
   * The one Inbox channel that carries the user's own file names, and it
   * carries them for the reason they were received: so a person can see what
   * arrived. Names are relative and the receiving directory is not among them —
   * `inboxRevealFolder` is what opens that, from a path only main holds.
   */
  inboxHistory: "relayium:inbox-history",
  /**
   * Forget one delivery's names, because the user asked.
   *
   * The ONLY thing that deletes from that record. Turning receiving off,
   * signing out and changing accounts all leave it alone, exactly as they leave
   * the message vault alone: a history that vanished as a side effect of a
   * settings toggle would be a product destroying the user's own record.
   */
  inboxForgetDelivery: "relayium:inbox-forget-delivery",

  // -------------------------------------------------------------------------
  // Inbox SEND — to this account's own devices
  // -------------------------------------------------------------------------
  //
  // The same split as stored send, and for the same reasons. The renderer holds
  // the user's `File` objects and runs the production shared `encryptFiles`, so
  // ciphertext flows renderer→main and the ONE secret that flows the other way
  // is the content key for the job that document owns. No path crosses in
  // either direction, and for a TEXT delivery main is told a byte LENGTH rather
  // than the message.
  //
  // A target is named by central's DEVICE ID. The device's public key, its key
  // id and its algorithm all stay in main: a renderer holding a target's key
  // could seal to it, which is the whole thing this boundary prevents.

  /** This account's other devices, as the picker may see them. */
  inboxSendTargets: "relayium:inbox-send-targets",
  /** Plan one delivery to one target. Returns the job's content key. */
  inboxSendStart: "relayium:inbox-send-start",
  /** One ciphertext frame, bounded. Answers with what is owed next. */
  inboxSendFeed: "relayium:inbox-send-feed",
  /** The producer is done. Finalize, create the task, report the outcome. */
  inboxSendEnd: "relayium:inbox-send-end",
  inboxSendCancel: "relayium:inbox-send-cancel",
  /**
   * Try again to establish what an UNKNOWN send did.
   *
   * Convergence, never a fresh send: an unknown outcome retains its plan and
   * its idempotency key precisely so the SAME attempt can be replayed. Sending
   * again would be a second delivery of one thing.
   */
  inboxSendConverge: "relayium:inbox-send-converge",

  // -------------------------------------------------------------------------
  // Account — profile, usage and this account's devices
  // -------------------------------------------------------------------------
  //
  // Reads and two device mutations. Nothing here buys, upgrades, cancels or
  // refunds anything, and there is no channel that could: the entire outbound
  // journey is `accountManage`, which names a DESTINATION with a closed token
  // and leaves main to map it to an address on this build's own pinned origin.
  //
  // Nothing in these payloads carries a bearer, an origin, a URL, an IP address
  // or an inbox key — the shared contract has no such field to leak. A device
  // is named by the opaque id of a row main itself handed the page, and main
  // resolves that id against the list it currently holds, so a page cannot
  // address a device it was never shown.

  /** The snapshot main holds. Triggers no read by itself. */
  accountSummaryState: "relayium:account-summary-state",
  /** Read again — all three sections, or one failed card retrying alone. */
  accountSummaryRefresh: "relayium:account-summary-refresh",
  /** Rename one device. Tied to the document that asked. */
  accountDeviceRename: "relayium:account-device-rename",
  /** Revoke one device. Signs out only on a self-revoke under this account. */
  accountDeviceRevoke: "relayium:account-device-revoke",
  /**
   * Ask for the verification email again.
   *
   * Carries NOTHING. The address is read by main from the profile the server
   * returns for the credential main holds — a payload with an email in it would
   * let the page make this app email anybody.
   */
  accountResendVerification: "relayium:account-resend-verification",
  /** Open the account page, from MAIN, at an address only main composes. */
  accountManage: "relayium:account-manage",

  // -------------------------------------------------------------------------
  // Help
  // -------------------------------------------------------------------------
  //
  // One channel, and it carries no address either. The page names a SCREEN and
  // a language; main owns the table of slugs and composes the address on the
  // product SITE's origin — which is not this build's API origin, because an
  // engineering build dials loopback and no documentation was ever published
  // there. See `shared/help-guides.ts`.

  /** Open this screen's guide on the product site, from MAIN. */
  helpOpenGuide: "relayium:help-open-guide",

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------
  //
  // Four names, and none of them carries an address, a key or a version the
  // page chose. A build with no pinned key answers `disabled` here and offers
  // nothing — that state is the truth about this build, not a placeholder.

  /** The snapshot main holds. Triggers no check by itself. */
  updateState: "relayium:update-state",
  /**
   * Ask for one of the four actions — check, download, install, reveal.
   *
   * Always as a MANUAL trigger: `automatic` is the scheduler's own word for its
   * timer, and a page that could claim it would be impersonating the thing that
   * runs when nobody is present.
   */
  updateAct: "relayium:update-act",
  /** Re-read what a previous run could not clean up. */
  updateResidue: "relayium:update-residue",
  /**
   * Open the release notes, from MAIN.
   *
   * A closed TOKEN crosses, never a URL. The address is composed here from the
   * SIGNED manifest and validated before anything opens, so there is no path by
   * which a page supplies one.
   */
  updateNotes: "relayium:update-notes",

  // -------------------------------------------------------------------------
  // Stored SEND and history
  // -------------------------------------------------------------------------
  //
  // The renderer holds the user's `File` objects — from the native `<input>`,
  // `webkitdirectory` and drag-drop pickers, none of which give it an
  // arbitrary-path read channel — and runs the production shared `encryptFiles`.
  // So the ciphertext flows renderer→main here, and the ONE secret that flows
  // the other way is the content key for the job that document owns. Both
  // directions are stated on the members below rather than glossed.

  /** Plan and open one upload. Returns the job's content key. */
  storedSendStart: "relayium:stored-send-start",
  /** One ciphertext frame, bounded. Answers with what is owed next. */
  storedSendFeed: "relayium:stored-send-feed",
  /** Finalize. The outcome is durable before it is reported. */
  storedSendEnd: "relayium:stored-send-end",
  storedSendCancel: "relayium:stored-send-cancel",
  /** This account's past sends. Counts and closed codes; no key, no link. */
  storedSendHistory: "relayium:stored-send-history",
  /** Compose the link for one published send, for exactly as long as it is
   *  shown. A link IS the key, so it is never stored. */
  storedSendLink: "relayium:stored-send-link",
  /** Delete one published object. The key is retired only after the server
   *  confirms it is gone. */
  storedSendDelete: "relayium:stored-send-delete",
  /** Try again to name the object an ambiguous send may have produced. */
  storedSendReconcile: "relayium:stored-send-reconcile",
  /**
   * Put one send's link on the clipboard, from MAIN.
   *
   * `window.ts` denies every renderer permission, the browser clipboard
   * included, so a Copy built on `navigator.clipboard` does not fail
   * occasionally — it never works. The page names a JOB; main composes the link
   * under the live account and writes it. There is deliberately no channel that
   * takes a string and puts it on the clipboard.
   */
  storedSendCopyLink: "relayium:stored-send-copy-link",
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
 * the generic `invoke` the bridge already refuses. `ipc.test.ts`
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
  /** Committed ciphertext bytes for one send, as the SERVER acknowledged them
   *  — never bytes merely handed to `feed`. */
  storedSendProgress: "relayium:stored-send-progress",
  /** How one send ended, pushed as soon as it does. */
  storedSendOutcome: "relayium:stored-send-outcome",
  /**
   * The account authority moved.
   *
   * Pushed so a page holding one account's links and history can drop them
   * SYNCHRONOUSLY rather than on its next read. A link is a key; leaving one on
   * screen across a sign-out is the failure this exists to prevent.
   */
  storedSendAccount: "relayium:stored-send-account",
  /**
   * The Inbox state changed.
   *
   * Pushed because the scheduler that owns it runs in MAIN and is not driven by
   * the page: deliveries arrive, a backoff elapses, an account changes. A page
   * that polled would either be slow or would be asking a privileged process a
   * question sixty times a minute for the life of the app.
   *
   * Unlike `storedProgress`, this is emitted on the CURRENT document rather
   * than an originating one, and the difference is deliberate. A stored
   * progress frame answers a request some document made, so a replacement
   * document must not receive it. This is a fact about main — is receiving on,
   * is a folder missing, is something waiting — and the document looking at the
   * screen now is exactly who needs it. It carries no authority: counts and
   * closed codes only.
   */
  inboxState: "relayium:inbox-state-changed",
  /** Committed ciphertext bytes for one inbox send, as the SERVER took them. */
  inboxSendProgress: "relayium:inbox-send-progress",
  /**
   * How one inbox send ended.
   *
   * Pushed as well as returned, because a send outlives the call that started
   * it: a page that navigated away, a sign-out that revoked the job, or a quit
   * drain all settle a delivery with nobody awaiting `end`.
   */
  inboxSendOutcome: "relayium:inbox-send-outcome",
  /**
   * A new account snapshot.
   *
   * Pushed because the READ is main's: an account change clears and re-reads
   * without any page asking, and the view a page renders on arrival is the one
   * main already holds. Emitted on the CURRENT document, like the Inbox state
   * and for the same reason — a fact about main that every document needs and
   * none requested.
   */
  accountSummary: "relayium:account-summary",
  /**
   * A new update snapshot.
   *
   * Pushed because the work is main's: a scheduled check, a download's
   * progress, a staged artifact re-verified at startup. Emitted on the CURRENT
   * document — a fact about the build that every page may show and none asked
   * for.
   */
  updateSummary: "relayium:update-summary",
  /**
   * A receive SAVED, and here is the token that can show the user where.
   *
   * Pushed rather than returned by `receivePublish`, because the page that
   * displays it is not always the one that published: a receive can settle
   * while the user is on another screen, and the reply to a call nobody is
   * awaiting reaches nothing.
   *
   * Emitted on the ORIGINATING document, unlike the inbox and account
   * snapshots. This is not a fact about main that any page may show — it is
   * authority to reveal one folder, granted to the document that asked for that
   * receive. A replacement page must not inherit a button for a transfer it did
   * not make.
   */
  receiveReceipt: "relayium:receive-receipt",
  /**
   * The staged selection changed — something arrived, or was put down.
   *
   * Pushed because the OS, not the page, decides when this happens: Explorer
   * launches the app or hands a second instance a new selection while the user
   * is looking at another screen entirely. A pane that only polled on mount
   * would show an empty tray for files that are already staged.
   *
   * Emitted on the CURRENT document. The staged selection belongs to whichever
   * page is showing, unlike a receive receipt, which is authority granted to
   * the one document that asked for it.
   */
  /**
   * Whether this build may still run, having changed since start-up.
   *
   * Pushed because the launch is judged from the CACHE — awaiting an 8-second
   * fetch on the path to the first paint would hold a start open for a slow
   * origin, which is the failure the whole mechanism exists to avoid. So the
   * refresh runs behind the launch and says so here when the answer moved.
   *
   * Without this a floor published now took effect on the next start. macOS
   * re-renders the moment a document lands; this is that.
   */
  clientSupport: "relayium:client-support-changed",
  osEntryState: "relayium:os-entry-state-changed",
  /**
   * The live pairing code changed — minted, copied, expired or withdrawn.
   *
   * Pushed because expiry is main's clock, not the page's: a link that has
   * lapsed must stop being offered even if nobody touches the screen.
   */
  pairHandoffState: "relayium:pair-handoff-state-changed",
  /**
   * The files one finished receive actually wrote, as draggable items.
   *
   * Pushed on the ORIGINATING document for the same reason the receipt is:
   * these are authority over particular files, granted to the page that asked
   * for that receive, not a fact about the build that any page may act on.
   */
  receivedItems: "relayium:received-items",
  /**
   * The account authority moved: signed in, signed out, or swapped.
   *
   * A fact about this PROCESS that any page may act on, emitted on the current
   * document like the inbox and account snapshots. It exists because the shell
   * otherwise has no authoritative account state: the sign-in controller's
   * phase is updated when the USER acts through the interface, so a change made
   * anywhere else — a sign-out from another surface, a session that expired —
   * would leave the screen describing an account that is gone.
   *
   * It carries no bearer, no email and no account id. A page learns THAT the
   * authority moved and re-reads what it is allowed to know.
   */
  accountAuthority: "relayium:account-authority",
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
  /**
   * Whether this build may run its product surfaces, and what to say if not.
   *
   * Carried on `appInfo` rather than its own channel because it is a property
   * of the BUILD, decided before there is a product surface to gate — the same
   * category as `version` and `engineering`, and answered at the same moment.
   *
   * Optional so a composition that has not opened a gate is `supported` by
   * absence rather than blocked by it. Failing open is the rule everywhere in
   * this mechanism, including here.
   */
  readonly support?: SupportReport;
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
/**
 * Something the page can see and main cannot.
 *
 * `incoming` is an offer waiting on the user. It is the page's to report
 * because the session lives in the room the page owns, and it is worth
 * reporting because the window may not be in front of anyone: nothing was
 * clicked to start it, and until it is answered the sender is waiting.
 */
export type ResidentNotice = "saved-message" | "attention" | "incoming";

/**
 * The closed set, in one place.
 *
 * The handler used to restate it as a pair of comparisons, so adding a kind
 * meant remembering to widen a condition in another file — and forgetting would
 * refuse the new kind at the boundary while every type checked.
 */
export function isResidentNotice(value: unknown): value is ResidentNotice {
  return value === "saved-message" || value === "attention" || value === "incoming";
}

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

// ---------------------------------------------------------------------------
// Device Inbox — the shapes the receive channels carry
// ---------------------------------------------------------------------------

/**
 * What the Inbox is doing, as a page may render it.
 *
 * Wider than `InboxRuntimeState` on purpose, and the extra members are the ones
 * that belong to the HOST rather than to the facade: whether an account is
 * signed in, whether its secret store could be read, whether a destination is
 * still there, and how long a failed pass is waiting before it tries again.
 * The facade cannot answer any of those — it is handed an account and a
 * destination — so a page shown only its state would have to say "disabled"
 * for four different situations with four different remedies.
 */
export type InboxStatus =
  /** This build cannot receive, so there is nothing to switch on. */
  | { readonly kind: "unavailable"; readonly reason: InboxFailureCode }
  /** Nobody is signed in. The Inbox belongs to an account. */
  | { readonly kind: "needs-account" }
  /**
   * Signed in, and this PC's encrypted store could not be read.
   *
   * Its own state rather than "disabled": the enrolment may well still be live
   * on the server, and showing an off switch over it would be false.
   */
  | { readonly kind: "account-unreadable" }
  /** The user has not asked to receive. */
  | { readonly kind: "disabled" }
  /**
   * Receiving is on and the chosen folder is not there.
   *
   * Never `disabled` and never `idle`: the user's answer is still their answer,
   * and this names what is missing.
   */
  | { readonly kind: "folder-missing" }
  /** Adopting the account or enrolling. Nothing has failed. */
  | { readonly kind: "starting" }
  | { readonly kind: "idle"; readonly pending: number }
  /** A delivery is being received right now. */
  | { readonly kind: "receiving" }
  /** Stopped on something only a decision can clear. */
  | {
      readonly kind: "blocked";
      readonly reason: InboxFailureCode;
      readonly residue: ResidueState;
      readonly pending: number;
    }
  /**
   * The last pass failed and the next one is waiting.
   *
   * Carries the delay so the page can say "trying again in a moment" instead of
   * looking stuck, and so "Try again now" is visibly a shortcut rather than the
   * only thing that will ever happen.
   */
  | {
      readonly kind: "offline";
      readonly reason: InboxFailureCode;
      readonly retryInSeconds: number;
    };

/** A destination whose teardown did not conclude. A key and closed codes. */
export interface InboxRetainedView {
  /** Opaque. `inboxReleaseRetained` takes this; it is not a path. */
  readonly key: string;
  readonly taskID: string;
  /**
   * Whether partly-written files are still on disk. The ONLY thing this row
   * can honestly tell a person, and the only thing it now shows.
   *
   * The teardown's failure code used to ride along here and the page rendered
   * it as the row's entire label, so a person read `EBUSY` — `codeOf` returns
   * `error.code` verbatim, so the label was an unbounded OS errno in whatever
   * language the OS produced it. It stays in the main process, where
   * `receiver.ts` logs it, because that is where a diagnostic belongs.
   */
  readonly residue: ResidueState;
}

/** Everything the Inbox page renders. No path, no token, no key. */
export interface InboxView {
  readonly status: InboxStatus;
  /**
   * What this build advertises to central.
   *
   * Rendered so the page cannot claim a capability the build does not have:
   * it is computed from the composed feature switches in main, never written
   * as a literal on either side.
   */
  readonly capabilities: readonly string[];
  /** Whether the user has consented. Distinct from `status`, which says what
   *  is happening about it. */
  readonly enabled: boolean;
  /** THAT a destination is recorded. Never which one. */
  readonly hasDestination: boolean;
  /** Central's name for this device, empty until it is known. */
  readonly deviceName: string;
  /** A withdrawal central has not confirmed, retried on later ticks. */
  readonly withdrawalPending: boolean;
  /** What the user asked central to do with an arriving delivery. */
  readonly policy: "off" | "ask" | "auto";
  /**
   * The account generation this view describes.
   *
   * Carried so a page can tell a state change from an ACCOUNT change and drop
   * one account's messages, receipts and open text before rendering another's.
   * Zero when nothing is bound.
   */
  readonly epoch: number;
  readonly retained: readonly InboxRetainedView[];
}

/**
 * One delivery this device has worked. Counts and phases; never a name.
 *
 * The Inbox journal carries no filenames or paths by design — a diagnostic
 * record of a delivery is not a record of its contents — and this carries it
 * unchanged rather than enriching it. Naming files in the foreground, as the
 * Mac does, needs presentation metadata captured during receive; that is a
 * separate design and a separate seam, and nothing here stands in for it.
 */
export interface InboxReceiptView {
  readonly taskID: string;
  /**
   * The journal's own phase, as the journal's own type.
   *
   * Not widened to `string`. The page turns this into a sentence, and its
   * fallback for an unrecognised phase says the delivery is BLOCKED — a claim
   * about somebody's files, not a blank. Widening here is what would let a
   * seventh phase reach that fallback silently; with the union, adding one is a
   * compile error at the map that has to describe it.
   */
  readonly phase: TaskPhase;
  /** Items the manifest declared. */
  readonly total: number;
  /** Items actually published. */
  readonly published: number;
  /** True for a message, which lands in the vault rather than on disk. */
  readonly text: boolean;
  readonly updatedAt: number;
  readonly serverTerminal: boolean;
}

/**
 * One item a delivery actually saved. A relative name and its size.
 *
 * The user's own content, and treated as such: it crosses this boundary because
 * showing people what arrived is the point of receiving it, and it goes nowhere
 * else — no log, no failure string, no telemetry.
 */
export interface InboxNamedItemView {
  /** Manifest-relative. Never absolute, and never the receiving directory. */
  readonly name: string;
  readonly size: number;
}

/**
 * What one delivery saved, by name.
 *
 * Returned BESIDE `InboxReceiptView` rather than merged into it. The journal is
 * the authoritative list of deliveries — written before anything irreversible,
 * and still there when a name capture failed — and this is the presentation
 * metadata for the ones that have it. A page joins the two by task id, so a
 * delivery whose names were not recorded renders as exactly that rather than as
 * a delivery that arrived empty.
 *
 * `items` is only what was CONFIRMED PUBLISHED. `declared` is what the manifest
 * asked for, kept beside it so "3 of 7" is sayable and a partial is never
 * presented as a whole.
 */
export interface InboxNamedDeliveryView {
  readonly taskID: string;
  readonly receivedAt: number;
  /** True for a message, which lands in the vault and has no named items. */
  readonly text: boolean;
  readonly declared: number;
  readonly items: readonly InboxNamedItemView[];
}

/** One delivery central is holding for this device. Never its contents. */
export interface InboxPendingView {
  readonly taskID: string;
  /** Central's device id for the sender. Not a name. */
  readonly sourceDeviceID: string;
  /** Ciphertext bytes central declared for the whole body. */
  readonly bytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** The server's own state token. */
  readonly state: string;
}

/** One saved message, as the list renders it. The body is fetched separately. */
export interface InboxMessageView {
  readonly id: string;
  readonly taskID: string;
  readonly sourceDeviceID: string;
  /** Plaintext length. */
  readonly bytes: number;
  readonly receivedAt: number;
}

export type InboxEnableOutcome =
  | { readonly kind: "enabled" }
  /** The user closed the folder dialog. Not an error, and nothing enrolled. */
  | { readonly kind: "declined" }
  | { readonly kind: "needs-account" }
  | { readonly kind: "unavailable"; readonly reason: InboxFailureCode }
  /** Not admitting: a quit is being decided, or the process is going away. */
  | { readonly kind: "refused" }
  /**
   * A newer change owns the state now.
   *
   * Its own answer rather than a failure or a refusal, because neither is true
   * and both would mislead. The commonest way to reach it is a folder dialog
   * left open while the user turned receiving off somewhere else: nothing went
   * wrong, nothing was refused, and the state on screen is the one they last
   * asked for rather than the one this call was about.
   */
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly reason: InboxFailureCode };

export type InboxDisableOutcome =
  | { readonly kind: "disabled" }
  /**
   * Local receiving stopped and central still lists this device.
   *
   * Reported rather than swallowed: a device central still holds keeps being
   * offered to senders, and deliveries queued against it will never be worked.
   * The withdrawal is retried by the scheduler.
   */
  | { readonly kind: "still-enrolled"; readonly reason: InboxFailureCode }
  | { readonly kind: "needs-account" }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly reason: InboxFailureCode };

export type InboxAcceptOutcome =
  | { readonly kind: "received"; readonly receipt: DeliveryReceipt }
  /** Accepted on the server and not reached in this pass. Not a failure. */
  | { readonly kind: "queued" }
  | { readonly kind: "not-enabled" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "already-settled" }
  | { readonly kind: "busy" }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly reason: InboxFailureCode };

export type InboxSimpleOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused" }
  /** A newer change owns the state. See `InboxEnableOutcome`. */
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly reason: InboxFailureCode };

export type InboxRenameOutcome =
  | { readonly kind: "renamed"; readonly name: string }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly reason: InboxFailureCode };

/** The longest device name this boundary will forward. Matches the server. */
export const MAX_INBOX_DEVICE_NAME_LENGTH = 64;
/** The longest vault or task id this boundary will forward. */
export const MAX_INBOX_ID_LENGTH = 256;
/** The most pending deliveries one request will ask central for. */
export const MAX_INBOX_PENDING = 50;

// ---------------------------------------------------------------------------
// Stored SEND — the shapes the send and history channels carry
// ---------------------------------------------------------------------------

/**
 * The manifest refusal vocabulary is the send planner's own.
 *
 * Imported rather than restated for the same reason `DeliveryReceipt` is: it is
 * the type that decides what a refusal may say, and it says a SHAPE — a count,
 * a bound, a rule that was broken — never a filename. A second copy here would
 * be free to drift from that rule invisibly.
 */
import type { ManifestRefusal } from "../main/stored/manifest.js";
import type { FrameExpectation } from "../main/stored/upload/service.js";
import type {
  AccountExternalTarget,
  AccountMutationOutcome,
  AccountSectionName,
  AccountSummaryView,
} from "./account-summary.js";

export type { ManifestRefusal, FrameExpectation };

/**
 * The account contract, re-exported rather than restated.
 *
 * `src/shared/account-summary.ts` is the authority for these shapes and is
 * reviewed as its own module. A second copy here would be free to drift from it
 * invisibly — the same reason `ManifestRefusal` and `DeliveryReceipt` are
 * imported above rather than mirrored.
 */
export type { AccountExternalTarget, AccountMutationOutcome, AccountSectionName, AccountSummaryView };

/**
 * What one upload ended as.
 *
 * `ambiguous` is a first-class member and is never collapsed into a neighbour.
 * A finalize whose answer was lost may or may not have created an object:
 * calling it published invents an id, and calling it failed asserts nothing was
 * created. Neither is a claim this process is entitled to make, so the page is
 * told the truth and offered a re-check.
 */
export type StoredSendOutcome =
  | { readonly status: "published"; readonly objectId: string; readonly expiresAt: number }
  | { readonly status: "ambiguous"; readonly code: string }
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "cancelled" };

export type StoredSendStart =
  | {
      readonly ok: true;
      readonly jobId: string;
      /**
       * The content key for THIS job, base64url.
       *
       * The one secret in this contract that travels main→renderer, and the
       * mirror of the one that travels renderer→main on the receive side. The
       * renderer is what encrypts — it holds the user's `File` objects, which
       * is what keeps an arbitrary-path reader out of main — so it needs the
       * key. It is released to one document for one job and revoked when the
       * job settles or that document goes away.
       *
       * What follows from it: it is never logged, never echoed into a refusal
       * or a diagnostic, and never persisted by the page.
       */
      readonly contentKey: string;
      /** The first frame the producer owes, or null for an empty object. */
      readonly expects: FrameExpectation | null;
      readonly cipherBytes: number;
      readonly fileCount: number;
    }
  | {
      readonly ok: false;
      readonly refusal: "unavailable" | "at-capacity" | "signed-out" | "nothing-picked" | "internal" | "refused";
      /** The engine's closed code, when the refusal came from it. */
      readonly code?: string;
      /** Which manifest SHAPE was refused. Never a filename. */
      readonly manifest?: ManifestRefusal | null;
    };

/** One past send, as the history list renders it. No key, no link, no path. */
export interface StoredSendHistoryEntry {
  readonly jobId: string;
  readonly state: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly burnAfterRead: boolean;
  readonly expiresAt: number;
  readonly createdAt: number;
  /** A closed code this process wrote, or nothing. */
  readonly note: string | null;
  /** Whether a link can be composed at all. The link itself is asked for
   *  separately, so it exists for exactly as long as it is being shown. */
  readonly linkable: boolean;
}

/** Committed ciphertext bytes for one send, as the SERVER acknowledged them. */
export interface StoredSendProgress {
  readonly jobId: string;
  readonly committed: number;
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Inbox SEND — the shapes the delivery channels carry
// ---------------------------------------------------------------------------

/**
 * What `inboxSendStart` answers.
 *
 * The refusals are this feature's own vocabulary rather than stored send's, and
 * `no-target` is the one that is genuinely new: a delivery is addressed to a
 * DEVICE, so "nothing picked" and "nobody to send it to" are different failures
 * and a page has different things to say about them.
 */
export type InboxSendStart =
  | {
      readonly ok: true;
      readonly jobId: string;
      /**
       * The content key for THIS delivery, base64url.
       *
       * The one secret in this contract that travels main→renderer on the Inbox
       * path, and it exists for the same reason the stored one does: the
       * renderer is what encrypts. It belongs to ONE immutable selection — a
       * re-pick is a new job with a new key, because AES-GCM under a repeated
       * nonce over different plaintext is a break rather than a bug.
       *
       * Never logged, never echoed into a refusal, never persisted by the page.
       */
      readonly contentKey: string;
      /** The first frame the producer owes, or null for an empty object. */
      readonly expects: FrameExpectation | null;
      readonly cipherBytes: number;
      readonly fileCount: number;
    }
  | {
      readonly ok: false;
      readonly refusal:
        | "unavailable"
        | "at-capacity"
        | "signed-out"
        | "nothing-picked"
        /** No device was named. A delivery is addressed, not broadcast. */
        | "no-target"
        | "internal"
        | "refused";
      /** The planner's or the manifest builder's closed code. */
      readonly code?: string;
      /** Which manifest SHAPE was refused. Never a filename. */
      readonly manifest?: ManifestRefusal | null;
    };

/** Committed ciphertext bytes for one inbox send, as the SERVER took them. */
export interface InboxSendProgress {
  readonly jobId: string;
  readonly committed: number;
  readonly total: number;
}

/** The most devices one target list will carry. */
export const MAX_INBOX_SEND_TARGETS = 100;

/** The longest relative path this boundary will forward for one entry. */
export const MAX_SEND_PATH_LENGTH = 4096;
/** The most entries one send may declare. Mirrors the manifest planner. */
export const MAX_SEND_ENTRIES = 1000;
/**
 * The largest ciphertext frame this boundary will accept.
 *
 * `STORE_CHUNK_SIZE` (192 KiB) plus the GCM tag, the length prefix and slack —
 * the shared `MAX_FRAME_CT` bound, restated here so an absurd allocation is
 * refused at the boundary rather than inside the engine.
 */
export const MAX_SEND_FRAME_BYTES = 192 * 1024 + 16 + 256 + 4;
