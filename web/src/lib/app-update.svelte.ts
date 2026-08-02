// "A newer build of this app is deployed" — the update lifecycle the notice
// hangs off, plus the refresh action it offers.
//
// Why this exists at all: a deploy replaces the files on the server, but a tab
// that is already open keeps running the JavaScript it loaded when it opened.
// A new service worker installing (and even taking control) does not touch the
// running page — it only decides what the NEXT navigation gets. So an open tab
// could keep behaving like the version it started as for days. That is exactly
// how a tab left open on v0.13 went on rejecting the digits 0 and 1 in a
// pairing code after v0.14.0 made codes six-digit decimal (see pair-code.ts) —
// it took a manual refresh to notice.
//
// What this mechanism can and cannot do, stated plainly:
//   - It CAN mark future deploys visible: once THIS version is the one running
//     in the tab, the service-worker signals below drive the stages below and
//     the notice appears, so the user knows a refresh is due and can take it.
//   - It CANNOT reach a page whose old JavaScript is already executing. That
//     page has no update state, no notice component and no listener; nothing a
//     new service worker or a new deploy does can inject UI into it. The tabs
//     open right now are, and remain, a manual refresh.
//
// Deliberately never auto-reloads. A reload tears down every WebRTC connection,
// drops the queued outbox and abandons in-flight transfers and unsent text, and
// the service worker cannot see any of that. The user chooses.

/**
 * Where this page stands relative to the newest build.
 *
 *   none    — nothing newer is known about. The notice renders nothing.
 *   pending — the NEWEST build this page knows of has installed and is parked
 *             in `waiting`; nothing has taken control since. Typically it is
 *             held back because a streaming download is still being served by
 *             the worker in control (see share-target.ts). The notice is
 *             visible, the refresh action is not: reloading now would kill that
 *             download and would land on a build older than the one waiting,
 *             because the current worker still answers the navigation.
 *   ready   — a new worker has actually taken control of this origin
 *             (controllerchange) and nothing newer has installed behind it. A
 *             reload now genuinely lands on the newest known build, and nothing
 *             this module knows of is left to interrupt.
 *
 * NOT monotonic, deliberately. The stage describes the newest deployment this
 * page has observed, not a one-way trip:
 *
 *     A open → B installs (pending) → B takes control (ready)
 *            → C installs while a download runs (pending again)
 *            → C takes control (ready)
 *
 * A one-way none→pending→ready would leave that page `ready` for the whole of
 * C's wait, so the button would stay live and a click would both kill the
 * download holding C back and land on B rather than C. Every genuinely new
 * installed worker resets the page to `pending`; only the controllerchange that
 * follows it makes the refresh honest again.
 *
 * Idempotence comes from the signals, not from the ordering: `pending` is
 * reported once per worker reaching `installed` (plus once at startup for a
 * worker left waiting by a previous visit), and `ready` is a plain assignment,
 * so repeated controllerchange events are free.
 */
type Stage = "none" | "pending" | "ready";

let stage = $state<Stage>("none");

/** Reactive read: is there anything to tell the user about? */
export function appUpdateVisible(): boolean {
  return stage !== "none";
}

/** Reactive read: known about, but this page cannot get onto it yet. */
export function appUpdatePending(): boolean {
  return stage === "pending";
}

/** Reactive read: a reload would actually land on the newest known build. */
export function appUpdateReloadReady(): boolean {
  return stage === "ready";
}

/** A genuinely newer build has installed and is waiting. Downgrades a `ready`
 *  page on purpose — see the Stage doc: while something newer sits in
 *  `waiting`, "refresh" is neither complete nor necessarily safe. */
export function markAppUpdatePending(): void {
  stage = "pending";
}

/** A new worker is now in control of this origin. Only ever called for a
 *  genuine update with a real (non-null) controller — this device's first-ever
 *  install also fires controllerchange, and so does an unregistration, and
 *  neither is an update (see share-target.ts). */
export function markAppUpdateReloadReady(): void {
  stage = "ready";
}

/**
 * How many local operations are currently holding the refresh action down.
 *
 * The other two blockers only see the peer workspace: `busy` is
 * workspace.warnsOnLeave (a live link, a transfer, a message session) and
 * `queued` is the outbox. Neither knows about work that never involves a peer:
 *   - a stored download running through DownloadPage — File System Access,
 *     ZIP or an in-memory Blob. A reload throws away everything received so far
 *     and the user starts the transfer again from zero.
 *   - a resumable stored upload in StoredUpload. A reload abandons the session
 *     and, with it, the only copy of the zero-knowledge key that had not been
 *     persisted yet.
 * Both are perfectly capable of running while the workspace is idle, which is
 * exactly the state in which the notice would otherwise say "refresh is safe".
 */
let holds = $state(0);

/**
 * Which generation of the counter a release belongs to.
 *
 * resetAppUpdate() zeroes `holds`, but it cannot reach the release closures
 * already handed out — a component unmounted by a test teardown finishes its
 * `finally` afterwards, and an operation genuinely still in flight will call its
 * release later too. Without a generation those stale releases decrement a
 * counter they never incremented: the count goes negative (or, worse, cancels a
 * hold taken *after* the reset, so `refreshHeld()` reports false while a real
 * download is running). Bumping the epoch makes every outstanding release a
 * no-op without touching holds taken since.
 */
let holdEpoch = 0;

/**
 * Hold the refresh action down for the length of a local operation a reload
 * would destroy. Returns the release, which is **idempotent** — call it from
 * every success / error / cancel path (a `finally` is the usual shape) without
 * worrying about double-release or underflow.
 *
 * Reference-counted, so overlapping operations compose: two downloads and an
 * upload at once are three holds, and the action only comes back when the last
 * one lets go.
 */
export function holdRefresh(): () => void {
  const epoch = holdEpoch;
  holds++;
  let released = false;
  return () => {
    if (released || epoch !== holdEpoch) return; // spent, or from before a reset
    released = true;
    holds = Math.max(0, holds - 1); // belt and braces: the count never lies negative
  };
}

/** Reactive read: is any local operation holding the refresh action down? */
export function refreshHeld(): boolean {
  return holds > 0;
}

/** How many holds are outstanding. Exported for tests and for debugging a stuck
 *  button; nothing in the app branches on the count itself. */
export function refreshHolds(): number {
  return holds;
}

/** How the page reloads. Indirected only so tests can observe the last step:
 *  jsdom's location.reload is non-configurable, so there is no way to spy on it
 *  in place, and asserting "the button reloads" is the whole point of the
 *  refresh action. The app never replaces it. */
let reload = () => location.reload();

/** Test seam — see `reload`. resetAppUpdate() puts the real one back. */
export function setReloadForTest(fn: () => void): void {
  reload = fn;
}

/** Test seam: back to a pristine page. The app never rewinds the stage — a real
 *  page that has seen an update only leaves that state by reloading. The hold
 *  count is cleared too: a test that leaves one outstanding would otherwise
 *  wedge the button for every test after it, in a different file. */
export function resetAppUpdate(): void {
  stage = "none";
  holds = 0;
  holdEpoch++; // retire every release handed out so far — see holdEpoch
  reload = () => location.reload();
}

/**
 * Is refreshing unavailable right now? Four independent reasons, and this is
 * the only place they are combined — `applyAppUpdate` runs the very same
 * predicate, so the button and the action cannot drift apart.
 *
 *   - not `ready` — the new worker has not taken control, so a reload would
 *     serve the same build back (and, in the case that holds it back, would
 *     kill the streaming download that is the reason it is held back).
 *   - `busy` — workspace.warnsOnLeave: a live link, an in-flight transfer, an
 *     open message session. This is the same predicate that already puts up the
 *     beforeunload prompt, so the notice cannot contradict it.
 *   - `queued` — files sitting in the outbox (OS share sheet, or picked before
 *     pairing). They only exist in memory; a reload silently drops them, and
 *     nothing on screen would have warned the user.
 *   - a hold — a local stored download or upload, which no peer-workspace
 *     signal reflects. See holdRefresh.
 */
export function refreshBlocked(busy: boolean, queued: number): boolean {
  return !appUpdateReloadReady() || busy || queued > 0 || refreshHeld();
}

/**
 * Take the update: reload onto the build that is already in control.
 *
 * Runs `refreshBlocked` itself rather than trusting the caller, because the
 * disabled button is not the only way in — this is exported, and a reload from
 * the wrong state is the one outcome the whole lifecycle exists to prevent.
 * `busy` and `queued` are the caller-owned halves (App knows warnsOnLeave, the
 * notice reads the outbox); the readiness stage and the global hold count are
 * checked here whatever the caller passes, so a bare `applyAppUpdate()` is
 * still safe against them. Returns whether it reloaded.
 *
 * Note what is deliberately NOT here: no "post skip-waiting, then reload". That
 * ordering cannot work — skip-waiting is asynchronous, so the reload races the
 * activation and usually loses, which is a refresh that changes nothing while
 * having killed whatever was in flight. Activation is share-target's job, on
 * its own schedule, behind the stream guard; when it lands, controllerchange
 * flips this to `ready` and the button enables itself.
 */
export function applyAppUpdate(busy = false, queued = 0): boolean {
  if (refreshBlocked(busy, queued)) return false;
  reload();
  return true;
}
