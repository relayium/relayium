// A selection the operating system handed this process, staged for a person to
// look at before anything is sent.
//
// ## The grammar is explicit, and it is the whole grammar
//
// `--send-files <path> [<path> …]`, ending at the end of `argv` or at the next
// `--` argument. Nothing else in `argv` is a file. An earlier shape that read
// "any argument that looks like a path" would turn every future flag, and every
// token a shell happened to expand, into something this process opened.
//
// The paths come from an OS activation — an Explorer verb, a Send-to shortcut,
// Open With, a drop on the executable — which is a user action against files
// they already had. They are still validated as if they were not.
//
// ## Staged, never sent
//
// This stages and stops. The renderer is shown what was selected and the person
// decides. An activation that sent on its own would make "open with" a transmit
// button, and the user would have shared something before seeing what it was.
//
// ## What crosses to a page
//
// A capability token, a name, a relative path and a size. Never an absolute
// path, never a directory, never a handle. A token authorises exactly one
// thing: a bounded range read of the file it was minted for, from the document
// it was minted for.

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  MAX_RELATIVE_PATH,
  MAX_SELECTION_CHUNK,
  MAX_SELECTION_DEPTH,
  MAX_SELECTION_FILES,
  MAX_SELECTION_ROOTS,
  OS_ENTRY_EMPTY,
  SEND_FILES_FLAG,
  isReadableRange,
  type OsEntryView,
  type SelectionEntryView,
  type SelectionReadResult,
  type SelectionRefusal,
} from "../../shared/os-entry.js";
import {
  SelectionReader,
  examine,
  isReservedDevicePath,
  type FileIdentity,
} from "../io/selection-reader.js";
import { createNativeSourceProvider, type NativeSourceProvider } from "../io/native-source.js";

export interface OsEntryDeps {
  currentDocument(): number;
  accountEpoch(): number;
  onView?(view: OsEntryView): void;
  /** Test seam. Production is the real reader. */
  reader?: SelectionReader;
  /**
   * Where staged bytes come from, or `null` for Node's own descriptors.
   *
   * Defaults to `createNativeSourceProvider()`: null off Windows, and on
   * Windows a provider that REFUSES every open when the helper binary is
   * missing rather than quietly substituting a reader that cannot make the
   * same guarantee.
   *
   * Stated as a seam because that default is a hard dependency on a packaged
   * binary. A caller running outside a packaged app — a unit test, a harness —
   * has to say `null` and mean it, rather than discovering on Windows only that
   * every read answers `changed`.
   */
  nativeSource?: NativeSourceProvider | null;
  now?(): number;
  reportFailure?(err: unknown): void;
}

export interface OsEntryInventory {
  readonly staged: number;
  /** Files still open because a read had not finished. Truthful. */
  readonly leftover: number;
}

/**
 * The `--send-files` arguments, or nothing.
 *
 * Exported so the grammar is testable on its own, and so nothing else has to
 * re-derive what counts as a selection.
 *
 * ## Position is not part of the grammar, and assuming it was a real defect
 *
 * This used to read the values IMMEDIATELY after the flag and stop at the first
 * later `--`. That is true of the command line Explorer builds, and it is not
 * true of the one this process is handed when the app is ALREADY RUNNING:
 * Electron reconstructs the second instance's command line before delivering
 * it, and a switch landing between the flag and the path ended the list before
 * it had collected anything. The app then refused with `no-selection` — "could
 * not read that" — for a file it had never looked at.
 *
 * The installed-artifact acceptance caught it by launching the verb the
 * installer registered: started COLD the same command line stages the file, and
 * delivered to a running instance it did not. Right-click send worked exactly
 * once per app lifetime, which is the shape of bug nobody reports precisely
 * because the second try is the one that fails.
 *
 * So the flag is a MODE and the selection is every ordinary argument: switches
 * are skipped wherever they appear, and what is left is what the OS handed
 * over. `handleDeepLink` already reads the same argv this way — it searches all
 * of it rather than a position — and this is now consistent with it.
 */
export function parseSendFiles(argv: readonly string[]): readonly string[] | null {
  if (!argv.includes(SEND_FILES_FLAG)) return null;
  const out: string[] = [];
  // From 1: argv[0] is this executable, which is not a selection.
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === undefined || value.length === 0) continue;
    // Any switch, in any of the forms a command line can carry one. Chromium
    // spells a switch's value as `--name=value`, so a bare argument is never
    // the value OF a switch — it is a positional argument, which here means a
    // path.
    if (value.startsWith("-")) continue;
    // A deep link travels in this same argv and belongs to another handler.
    // A selection is a filesystem path; it never contains a scheme.
    if (value.includes("://")) continue;
    out.push(value);
  }
  return out;
}

/** One staged file: what a page sees, plus what only main may know. */
interface Entry {
  readonly token: string;
  /** The reader's key. Deliberately not the token. */
  readonly id: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly name: string;
  readonly identity: FileIdentity;
}

interface Staged {
  readonly selectionId: string;
  readonly document: number;
  readonly epoch: number;
  readonly entries: readonly Entry[];
  readonly rootNames: readonly string[];
  readonly totalBytes: number;
  readonly stagedAt: number;
}

const token = (): string => `sel-${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;

export class OsEntryService {
  #staged: Staged | null = null;
  #view: OsEntryView = OS_ENTRY_EMPTY;
  #sequence = 0;
  /** Activations refused because a selection was already held. */
  #refusedSince = 0;
  /** Refusals that landed while an activation was still examining. */
  #pendingRefusals = 0;
  /**
   * The activation in flight, captured BEFORE its first await.
   *
   * Every cancel and every lifecycle transition moves the ticket, so a walk
   * that finishes after a clear, a dispose, a document revocation or a sign-out
   * commits nothing. Without it, each of those still staged a selection built
   * from an examination that began under conditions that no longer hold.
   */
  #activation: { ticket: number; document: number; epoch: number } | null = null;
  #activationTicket = 0;
  readonly #reader: SelectionReader;
  /** Reads in flight, so a teardown can join them. */
  #reads = 0;
  #fenced = false;
  #disposed = false;

  constructor(private readonly deps: OsEntryDeps) {
    // The provider decides for itself whether this platform has a native
    // guarantee: null off Windows, and on Windows a provider that REFUSES every
    // open when the helper is missing rather than quietly handing back a Node
    // reader. A staged file is read through the helper's component-by-component
    // walk, so no ancestor can redirect the open.
    // `undefined` means "not stated", which takes the platform default. `null`
    // is a STATED choice of the portable reader and is honoured as one.
    const native = deps.nativeSource !== undefined ? deps.nativeSource : createNativeSourceProvider();
    this.#reader = deps.reader ?? new SelectionReader(native);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  view(): OsEntryView {
    return this.#view;
  }

  get stagedCount(): number {
    return this.#staged?.entries.length ?? 0;
  }

  /**
   * Stage what an activation delivered, if nothing is staged already.
   *
   * A held selection is NEVER replaced here — see the refusal below. Only an
   * explicit discard returns this to empty, which is what stops a burst of
   * activations from throwing away files the person meant to send.
   */
  async activate(argv: readonly string[]): Promise<OsEntryView> {
    const paths = parseSendFiles(argv);
    if (paths === null) return this.#view;
    if (this.#disposed || this.#fenced) return this.#refuse("unavailable");
    // ## A held selection is never replaced by another activation
    //
    // The installer offers a BULK `--send-files`, so one invocation carries
    // every path. A second intent arriving while something is staged is either
    // a burst or a second deliberate action, and in both cases overwriting
    // would throw away files the person believes they are about to send. It is
    // refused, counted, and made visible; discarding is the user's to do.
    //
    // Counted, and deliberately NOT a `SelectionRefusal` member. The staged
    // view stays on screen and says how many activations were turned away, so
    // the person can act on it; a refusal code would have been rendered by a
    // pane that only appears when nothing is staged, and could never have
    // reached them. `SelectionRefusal` carried an `already-staged` member for
    // exactly that unreachable path until an exhaustiveness check found it.
    if (this.#staged !== null) {
      this.#refusedSince += 1;
      this.#publish();
      return this.#view;
    }
    // A SYNCHRONOUS reservation, before the first await. Without it a second
    // activation was admitted while the first was still examining, both walked
    // the filesystem, and the later one overwrote the earlier one's intent.
    if (this.#activation !== null) {
      this.#pendingRefusals += 1;
      return this.#view;
    }
    if (paths.length === 0) return this.#refuse("no-selection");
    if (paths.length > MAX_SELECTION_ROOTS) return this.#refuse("too-many");

    const document = this.deps.currentDocument();
    const epoch = this.deps.accountEpoch();
    const ticket = ++this.#activationTicket;
    this.#activation = { ticket, document, epoch };
    try {
      return await this.#stage(paths, ticket, document, epoch);
    } finally {
      if (this.#activation?.ticket === ticket) this.#activation = null;
    }
  }

  async #stage(
    paths: readonly string[],
    ticket: number,
    document: number,
    epoch: number,
  ): Promise<OsEntryView> {
    const entries: Entry[] = [];
    const rootNames: string[] = [];
    const taken = new Set<string>();

    for (const root of paths) {
      // Refused on the RAW argument, before `resolve` and before any filesystem
      // call. `\\.\C:\picked.txt` resolves to an ordinary file and `lstat`
      // reports it as one, so the shape of the string is the only thing that
      // can refuse it.
      if (isReservedDevicePath(root)) return this.#refuse("unsupported-kind", ticket);
      const resolved = path.resolve(root);
      if (isReservedDevicePath(resolved)) return this.#refuse("unsupported-kind", ticket);
      const kind = await examine(resolved);
      if (kind.kind === "rejected") {
        return this.#refuse(
          kind.reason === "symlink" ? "escapes-root" : kind.reason === "special" ? "unsupported-kind" : "unreadable",
          ticket,
        );
      }
      if (kind.kind === "file") {
        const name = path.basename(resolved);
        if (!this.#claim(taken, name)) return this.#refuse("collision", ticket);
        entries.push(this.#entry(resolved, name, name, kind.identity));
        rootNames.push(name);
        if (entries.length > MAX_SELECTION_FILES) return this.#refuse("too-many", ticket);
        continue;
      }
      // An ordinary folder. Its own name prefixes everything inside it, which
      // is what makes a folder send arrive as a folder.
      const base = path.basename(resolved) || resolved;
      rootNames.push(base);
      const walked = await this.#walk(resolved, base, entries, taken);
      if (walked !== null) return this.#refuse(walked, ticket);
    }

    if (entries.length === 0) return this.#refuse("no-selection", ticket);

    // ## Re-checked immediately before the commit, with nothing awaited after
    //
    // The walk above is the longest wait in this method, and a clear, a
    // dispose, a document revocation or a sign-out can all land inside it. Each
    // one moves the ticket; committing anyway would stage a selection built
    // from an examination that began under conditions that are gone.
    if (ticket !== this.#activationTicket) return this.#view;
    if (this.#disposed || this.#fenced) return this.#refuse("unavailable", ticket);
    if (document !== this.deps.currentDocument()) return this.#refuse("unavailable", ticket);
    if (epoch !== this.deps.accountEpoch()) return this.#refuse("unavailable", ticket);
    if (this.#staged !== null) {
      this.#refusedSince += 1;
      this.#publish();
      return this.#view;
    }

    this.#sequence += 1;
    // Refusals that arrived while this activation was examining belong to the
    // selection it is about to stage.
    this.#refusedSince = this.#pendingRefusals;
    this.#pendingRefusals = 0;
    const totalBytes = entries.reduce((sum, entry) => sum + entry.identity.size, 0);
    this.#staged = {
      selectionId: `sel-${String(this.#sequence)}`,
      document,
      epoch,
      entries,
      rootNames,
      totalBytes,
      stagedAt: this.now(),
    };
    this.#publish();
    return this.#view;
  }

  #entry(absolutePath: string, name: string, relativePath: string, identity: FileIdentity): Entry {
    return {
      token: token(),
      id: `${String(this.#sequence + 1)}:${relativePath}`,
      absolutePath,
      relativePath,
      name,
      identity,
    };
  }

  /** Reserve a relative path. A second claim on one is a collision, not a merge. */
  #claim(taken: Set<string>, relativePath: string): boolean {
    const key = relativePath.toLowerCase();
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  }

  /**
   * Walk one folder, bounded in count and depth, refusing rather than
   * truncating.
   *
   * Cycles are caught by device+inode of each directory actually visited, so a
   * junction that points at an ancestor ends the walk instead of spinning.
   */
  async #walk(
    root: string,
    prefix: string,
    out: Entry[],
    taken: Set<string>,
  ): Promise<SelectionRefusal | null> {
    const seen = new Set<string>();
    const stack: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: prefix, depth: 0 }];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined) break;
      if (next.depth > MAX_SELECTION_DEPTH) return "too-many";
      const identity = await SelectionReader.directoryIdentity(next.dir);
      if (identity === null) return "unreadable";
      if (seen.has(identity)) return "escapes-root";
      seen.add(identity);
      let names: string[];
      try {
        names = await readdir(next.dir);
      } catch {
        return "unreadable";
      }
      for (const name of names) {
        const child = path.join(next.dir, name);
        const rel = `${next.rel}/${name}`;
        if (rel.length > MAX_RELATIVE_PATH) return "too-many";
        const kind = await examine(child);
        if (kind.kind === "rejected") {
          // A symlink inside a folder is refused rather than skipped: silently
          // omitting it would send a folder that is not the folder on disk.
          if (kind.reason === "symlink") return "escapes-root";
          if (kind.reason === "special") return "unsupported-kind";
          return "unreadable";
        }
        if (kind.kind === "directory") {
          stack.push({ dir: child, rel, depth: next.depth + 1 });
          continue;
        }
        if (!this.#claim(taken, rel)) return "collision";
        // Empty files are kept: a folder that arrives missing its empty files
        // is not the folder that was sent.
        out.push(this.#entry(child, name, rel, kind.identity));
        if (out.length > MAX_SELECTION_FILES) return "too-many";
      }
    }
    return null;
  }

  /**
   * Read one bounded range of a staged file.
   *
   * The token names the file; the range is checked against what staging
   * measured; the document and the account are re-checked here, because a token
   * minted for one page must not be usable from the page that replaced it.
   */
  async read(
    tokenValue: string,
    offset: number,
    length: number,
    document: number,
  ): Promise<SelectionReadResult> {
    if (this.#disposed || this.#fenced) return { kind: "unavailable" };
    if (!isReadableRange(offset, length)) return { kind: "bad-range" };
    const staged = this.#staged;
    if (staged === null) return { kind: "unknown-token" };
    if (staged.document !== document) return { kind: "unknown-token" };
    if (staged.document !== this.deps.currentDocument()) return { kind: "unknown-token" };
    if (staged.epoch !== this.deps.accountEpoch()) return { kind: "unknown-token" };
    const entry = staged.entries.find((candidate) => candidate.token === tokenValue);
    if (entry === undefined) return { kind: "unknown-token" };

    this.#reads += 1;
    try {
      const outcome = await this.#reader.read(
        entry.id,
        entry.absolutePath,
        entry.identity,
        offset,
        Math.min(length, MAX_SELECTION_CHUNK),
      );
      // Re-checked AFTER the await: a reload or a sign-out during a read must
      // not hand its bytes to whatever is on screen now.
      if (this.#disposed) return { kind: "unavailable" };
      if (this.#staged !== staged) return { kind: "unknown-token" };
      if (staged.document !== this.deps.currentDocument()) return { kind: "unknown-token" };
      if (staged.epoch !== this.deps.accountEpoch()) return { kind: "unknown-token" };
      switch (outcome.kind) {
        case "bytes":
          return { kind: "bytes", bytes: outcome.bytes };
        case "changed":
          return { kind: "changed" };
        case "bad-range":
          return { kind: "bad-range" };
        case "at-capacity":
          // Honest: this build is holding as many files as it will, and every
          // one is in use. Not a failure of the file.
          return { kind: "unavailable" };
        default:
          return { kind: "failed" };
      }
    } finally {
      this.#reads -= 1;
    }
  }

  /**
   * The user dismissed the staged selection, or sent it.
   *
   * The only route from held back to empty. An activation cannot take it, which
   * is what makes "already staged" a refusal rather than a race.
   */
  async clear(): Promise<void> {
    this.#cancelActivation();
    await this.#releaseStaged();
    this.#refusedSince = 0;
    this.#publish();
  }

  /**
   * Invalidate whatever activation is examining, even when nothing is staged.
   *
   * `#staged === null` is exactly the window the bug lived in: a walk in
   * progress had produced no selection yet, so a guard that looked only at the
   * staged value saw nothing to cancel and let it commit afterwards.
   */
  #cancelActivation(): void {
    this.#activationTicket += 1;
    this.#activation = null;
    this.#pendingRefusals = 0;
  }

  /** A document was destroyed or reloaded. Its capabilities go with it. */
  async revokeDocument(document: number): Promise<void> {
    if (this.#activation?.document === document) this.#cancelActivation();
    if (this.#staged === null || this.#staged.document !== document) return;
    await this.#releaseStaged();
    this.#publish();
  }

  /** The account moved. A selection belongs to the session that staged it. */
  async onAccountChanged(): Promise<void> {
    this.#cancelActivation();
    if (this.#staged === null) return;
    await this.#releaseStaged();
    this.#publish();
  }

  fence(): void {
    this.#fenced = true;
  }

  resume(): void {
    if (!this.#disposed) this.#fenced = false;
  }

  /**
   * Stop admitting, close handles, and report what is still held.
   *
   * RECOVERABLE. The selection is kept and the reader stays usable, so a quit
   * prompt answered with Stay leaves the staged files readable again — closing
   * the reader terminally here made every later read fail for the life of the
   * process, caused by nothing more than a question being asked.
   */
  async quiesce(): Promise<OsEntryInventory> {
    this.#fenced = true;
    this.#cancelActivation();
    const staged = this.stagedCount;
    const { leftover } = await this.#reader.closeAll();
    return { staged, leftover };
  }

  /** Terminal. Handles are closed for good and the selection is dropped. */
  async dispose(): Promise<OsEntryInventory> {
    this.#fenced = true;
    this.#cancelActivation();
    const staged = this.stagedCount;
    const { leftover } = await this.#reader.disposeAll();
    this.#disposed = true;
    this.#staged = null;
    this.#publish();
    return { staged, leftover };
  }

  async #releaseStaged(): Promise<void> {
    const staged = this.#staged;
    this.#staged = null;
    if (staged === null) return;
    for (const entry of staged.entries) await this.#reader.release(entry.id);
  }

  /**
   * Publish a refusal — unless doing so would erase something true.
   *
   * Two rules, both learned the same way:
   *
   *   * A refusal from a SUPERSEDED activation writes nothing. An examination
   *     that failed long after the user cleared and staged something else would
   *     otherwise replace the current selection with that old failure.
   *   * A HELD selection is never replaced by an empty view. A refused OS
   *     intent while fenced left `stagedCount` at one and the view at empty —
   *     the files were still there, and the screen said they were not.
   */
  #refuse(refusal: SelectionRefusal, ticket?: number): OsEntryView {
    if (ticket !== undefined && ticket !== this.#activationTicket) return this.#view;
    if (this.#staged !== null) {
      // Visible as a refusal against the selection that survived it, rather
      // than as an erasure of it.
      this.#refusedSince += 1;
      this.#publish();
      return this.#view;
    }
    this.#sequence += 1;
    this.#view = Object.freeze({
      kind: "empty" as const,
      selectionId: `sel-${String(this.#sequence)}`,
      refusal,
    });
    this.#emit();
    return this.#view;
  }

  #publish(): void {
    const staged = this.#staged;
    this.#view =
      staged === null
        ? Object.freeze({ kind: "empty" as const, selectionId: `sel-${String(this.#sequence)}`, refusal: null })
        : Object.freeze({
            kind: "staged" as const,
            selectionId: staged.selectionId,
            entries: Object.freeze(
              staged.entries.map(
                (entry): SelectionEntryView =>
                  Object.freeze({
                    token: entry.token,
                    name: entry.name,
                    relativePath: entry.relativePath,
                    size: entry.identity.size,
                  }),
              ),
            ),
            rootNames: Object.freeze([...staged.rootNames]),
            totalBytes: staged.totalBytes,
            stagedAt: staged.stagedAt,
            refusedSince: this.#refusedSince,
          });
    this.#emit();
  }

  #emit(): void {
    if (this.#disposed && this.#view.kind === "staged") return;
    try {
      this.deps.onView?.(this.#view);
    } catch (err) {
      // Reported as an object, never with a path or a name in it.
      this.deps.reportFailure?.(err);
    }
  }
}
