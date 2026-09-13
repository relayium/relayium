// Dragging a received file out to Explorer, and showing it in a folder.
//
// The macOS parity is `ReceivedResultView.swift`: `.onDrag` over an
// `NSItemProvider(contentsOf:)` at line 37, `activateFileViewerSelecting` at
// line 50, and `ShareLink(items: payload.dragURLs)` at line 53. Three
// affordances, not two.
//
// This module implements the first two, through `webContents.startDrag` and
// `shell.showItemInFolder`.
//
// ## Share is MISSING here, not impossible on Windows
//
// An earlier version of this header claimed Windows could not offer a share
// sheet without repackaging as MSIX. That was wrong, and the error was
// conflating two different things: share TARGET — being listed inside other
// apps' share sheets — does require a package manifest, but share SOURCE does
// not. `IDataTransferManagerInterop::GetForWindow` plus `ShowShareUIForWindow`
// and `DataPackage.SetStorageItems` is supported for unpackaged desktop apps.
//
// So `share` is a third action this contract should eventually carry, and it is
// absent only because it needs a native bridge that has not been written or
// granted. Nothing here may be read as "Windows cannot do this".
//
// ## This registry is FILE-LEVEL, and does not reach folder parity
//
// macOS drags `payload.dragURLs`, which for a folder transfer is one complete
// hierarchy — the user drags the folder, and the folder arrives.
//
// Every entry here is a single regular file, so a received folder drags as N
// separate files and its structure is lost. That is a real gap against parity
// and it is stated rather than papered over.
//
// It is NOT closed by registering the receive root instead. `Sink.destinationDirectory`
// opens or creates nested directories and may share the chosen root, or a
// pre-existing subdirectory, with files this app never wrote. Registering such a
// directory would hand the user's unrelated files to whatever they dropped onto,
// which is far worse than losing the hierarchy.
//
// Closing it properly needs a subtree the writer can PROVE it created in full —
// see the native-bridge proposal. Until then the honest position is: file-level
// drag works, folder-level drag does not, and nothing here pretends otherwise.
//
// ## A registry of its own, not the receipt registry
//
// The receipt registry records that a task arrived and how many items it
// published; it holds no file names, and the receive ROOT is a directory the
// user chose. Deriving a path by joining that root to a name a renderer supplied
// would be a path-traversal channel with extra steps, and enumerating the root
// would hand out files this app never wrote.
//
// So this is a separate registry, and it is populated by the CALLER at the one
// moment the truth is known: when a per-item write has been published
// successfully and the writer still has the final native path in hand. A failed
// or cancelled publication registers nothing.
//
// ## Ownership travels with the entry
//
// Each item records the authority that received it — account, epoch, document —
// COPIED at registration. A token is only usable while that authority is still
// current, so a file received under one account cannot be dragged out from
// another, and a page that has reloaded cannot drag what its predecessor got.

import {
  MAX_RECEIVED_ITEMS,
  isReceivedAction,
  isSafeRelativePath,
  type ReceivedAction,
  type ReceivedActionOutcome,
  type ReceivedItemView,
} from "../../shared/received-drag.js";
import { examine, sameIdentity, type FileIdentity } from "../io/selection-reader.js";

/**
 * Who received an item. The accepted `ReceiptOwner` shape, for its reason.
 *
 * `direct` is a LAN or paired transfer that no account authorised: no account
 * change invalidates it, and its `epoch` is ignored entirely. `account` is a
 * Device Inbox receive, which belongs to the account that was signed in and
 * must stop being reachable the moment that account does.
 *
 * Binding every receipt to an account — as an earlier shape here did — would
 * make a LAN file the user received while signed out vanish the moment they
 * signed in, which is a file they own disappearing for no reason.
 */
export interface ReceivedAuthority {
  readonly authority: "direct" | "account";
  /** Ignored for `direct`. */
  readonly epoch: number;
  readonly document: number;
  /** Only meaningful for `account`; "" otherwise. */
  readonly accountId: string;
}

/** What a caller must supply, and can only supply on the success path. */
export interface ReceivedRegistration {
  /** The final native path the writer actually published. */
  readonly absolutePath: string;
  /** Relative to the receive root, as the writer resolved it. */
  readonly relativePath: string;
  readonly authority: ReceivedAuthority;
}

/** Whether an item's owner is still the live authority. */
function ownerIsCurrent(
  owner: ReceivedAuthority,
  deps: Pick<ReceivedDragDeps, "currentDocument" | "accountEpoch" | "currentAccountId">,
): boolean {
  if (owner.document !== deps.currentDocument()) return false;
  // `direct` survives an account change by design: nothing about it was
  // authorised by an account, so nothing about an account revokes it.
  if (owner.authority === "direct") return true;
  if (owner.epoch !== deps.accountEpoch()) return false;
  return owner.accountId === deps.currentAccountId();
}

export interface ReceivedDragDeps {
  /** Start an OS drag of one file, with this app's fixed icon. RT wires it. */
  startDrag(absolutePath: string): boolean;
  /** Show one file in Explorer. RT wires `shell.showItemInFolder`. */
  showItemInFolder(absolutePath: string): void;
  currentDocument(): number;
  accountEpoch(): number;
  /** The account this process is signed in to, or "" when signed out. */
  currentAccountId(): string;
  reportFailure?(err: unknown): void;
}

interface Item {
  readonly token: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly name: string;
  readonly authority: ReceivedAuthority;
  readonly identity: FileIdentity;
}

const token = (): string => `rcv-${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;

/** The last segment of a forward-slashed relative path. */
function leafOf(relativePath: string): string {
  const parts = relativePath.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? relativePath;
}

export class ReceivedDragService {
  readonly #items = new Map<string, Item>();
  /** Insertion order, for the bound. */
  readonly #order: string[] = [];
  /**
   * A generation per owner scope, so a revocation can cancel a registration
   * that is still examining the file.
   */
  readonly #generations = new Map<string, number>();
  /**
   * Owners with a registration still examining the filesystem.
   *
   * A revocation cannot bump a scope it has never heard of, and a registration
   * in flight has no item yet — so without this the revoker iterated an empty
   * map, bumped nothing, and the item appeared afterwards as though nothing had
   * happened.
   */
  readonly #pendingScopes = new Map<string, ReceivedAuthority>();
  #fenced = false;
  #disposed = false;

  constructor(private readonly deps: ReceivedDragDeps) {}

  get size(): number {
    return this.#items.size;
  }

  /**
   * Register one item that was PUBLISHED.
   *
   * Returns the view, or null when it was refused. The caller must only reach
   * this on the success path; a failed or cancelled publication has no final
   * path to register, and registering one anyway would hand out a token for a
   * file that does not exist or is half written.
   *
   * The file is examined here: a path that is not a regular file right now is
   * not registered at all, so a token never names something that was never
   * written.
   */
  async register(registration: ReceivedRegistration): Promise<ReceivedItemView | null> {
    // Deliberately NOT refused while fenced. A receive that completed during a
    // quit prompt really did complete, and if the user chooses Stay the file
    // should still be draggable. `act` is what refuses while fenced, which is
    // the point where something would actually happen. Same rule as the
    // accepted `ReceiptRegistry.register`.
    if (this.#disposed) return null;
    const { absolutePath, relativePath, authority } = registration;
    if (typeof absolutePath !== "string" || absolutePath.length === 0) return null;
    // Segment semantics, not a substring test: `photo..jpg` is an ordinary file.
    if (!isSafeRelativePath(relativePath)) return null;

    // COPIED BEFORE the await. A caller that reuses one authority object across
    // receives — bumping an epoch in place, reassigning a document — would
    // otherwise relabel a receipt that had already been captured, because the
    // copy happened after the filesystem check rather than before it.
    const owner: ReceivedAuthority = {
      authority: authority.authority,
      epoch: authority.epoch,
      document: authority.document,
      accountId: authority.accountId,
    };
    // A generation per owner, taken before the await, so a revocation that
    // lands during the check cancels this registration instead of letting the
    // item appear afterwards.
    const scope = this.#scopeKey(owner);
    const generation = this.#generations.get(scope) ?? 0;
    // Announced before the await, so a revocation landing during the check can
    // find this scope and cancel it.
    this.#pendingScopes.set(scope, owner);

    let kind;
    try {
      kind = await examine(absolutePath);
    } finally {
      this.#pendingScopes.delete(scope);
    }
    if (kind.kind !== "file") return null;
    if (this.#disposed) return null;
    if ((this.#generations.get(scope) ?? 0) !== generation) return null;

    const item: Item = {
      token: token(),
      absolutePath,
      relativePath,
      name: leafOf(relativePath),
      authority: owner,
      identity: kind.identity,
    };
    this.#items.set(item.token, item);
    this.#order.push(item.token);
    // Oldest first, and the bound is a refusal to grow rather than a silent
    // overwrite: the evicted token simply stops working, which the page is told.
    while (this.#order.length > MAX_RECEIVED_ITEMS) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#items.delete(oldest);
    }
    return Object.freeze({
      token: item.token,
      name: item.name,
      relativePath: item.relativePath,
      size: item.identity.size,
    });
  }

  /**
   * Drag one item out, or show it in a folder.
   *
   * The file is re-examined immediately before the OS acts: a token minted
   * minutes ago names a file the user may have moved, deleted or replaced, and
   * dragging out whatever now sits at that path would be dragging out something
   * this app never received.
   */
  async act(action: ReceivedAction, tokenValue: string, document: number): Promise<ReceivedActionOutcome> {
    if (this.#disposed || this.#fenced) return { kind: "unavailable" };
    if (!isReceivedAction(action)) return { kind: "unknown-token" };
    const item = this.#items.get(tokenValue);
    if (item === undefined) return { kind: "unknown-token" };
    if (item.authority.document !== document) return { kind: "unknown-token" };
    if (!ownerIsCurrent(item.authority, this.deps)) return { kind: "unknown-token" };

    const kind = await examine(item.absolutePath);
    if (kind.kind !== "file") return { kind: "missing" };
    if (!sameIdentity(item.identity, kind.identity)) return { kind: "missing" };
    // ## Re-checked in FULL after the await, before the OS is asked to act
    //
    // Membership as well as authority. An earlier shape re-checked only the
    // document, so an account change during the `stat` cleared the map while
    // this call still held its own reference to the item — and went on to drag
    // out a file the current account never received.
    if (this.#disposed || this.#fenced) return { kind: "unavailable" };
    if (this.#items.get(tokenValue) !== item) return { kind: "unknown-token" };
    if (!ownerIsCurrent(item.authority, this.deps)) return { kind: "unknown-token" };

    try {
      if (action === "reveal") {
        this.deps.showItemInFolder(item.absolutePath);
        return { kind: "revealed" };
      }
      return this.deps.startDrag(item.absolutePath) ? { kind: "started" } : { kind: "failed" };
    } catch (err) {
      this.deps.reportFailure?.(err);
      return { kind: "failed" };
    }
  }

  /** Forget everything a document owned, including registrations in flight. */
  revokeDocument(document: number): void {
    this.#bumpWhere((owner) => owner.document === document);
    this.#dropWhere((item) => item.authority.document === document);
  }

  /**
   * The account moved.
   *
   * ACCOUNT receipts go; DIRECT ones stay. A LAN file the user received is
   * theirs regardless of who is signed in, and dropping it because they signed
   * in would be a file disappearing for no reason.
   */
  onAccountChanged(): void {
    this.#bumpWhere((owner) => owner.authority === "account");
    this.#dropWhere((item) => item.authority.authority === "account");
  }

  #scopeKey(owner: ReceivedAuthority): string {
    return owner.authority === "direct"
      ? `direct:${String(owner.document)}`
      : `account:${owner.accountId}:${String(owner.epoch)}:${String(owner.document)}`;
  }

  /** Invalidate in-flight registrations whose owner matches. */
  #bumpWhere(matches: (owner: ReceivedAuthority) => boolean): void {
    const scopes = new Set<string>();
    for (const item of this.#items.values()) {
      if (matches(item.authority)) scopes.add(this.#scopeKey(item.authority));
    }
    // The scopes that matter most: registrations still examining, which have no
    // item to be found by.
    for (const [key, owner] of this.#pendingScopes) {
      if (matches(owner)) scopes.add(key);
    }
    for (const key of scopes) {
      this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    }
  }

  fence(): void {
    this.#fenced = true;
  }

  resume(): void {
    if (!this.#disposed) this.#fenced = false;
  }

  dispose(): void {
    this.#disposed = true;
    this.#fenced = true;
    this.#items.clear();
    this.#order.length = 0;
  }

  #dropWhere(predicate: (item: Item) => boolean): void {
    for (const [key, item] of [...this.#items]) {
      if (!predicate(item)) continue;
      this.#items.delete(key);
      const at = this.#order.indexOf(key);
      if (at >= 0) this.#order.splice(at, 1);
    }
  }
}
