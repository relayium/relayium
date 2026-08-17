import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// Where a received MESSAGE is kept, and why it is not a file.
///
/// ## The whole reason this type exists
///
/// A Device Inbox delivery is files or it is a message (`InboxManifestKind`),
/// and the two have nothing in common past the ciphertext. A message has no
/// name, no extension and no place in a folder somebody chose for their
/// downloads. A receiver that wrote one there as `message.txt` would deliver a
/// different thing from the one that was sent — and it would do it into a
/// directory the user shares, syncs or backs up on the strength of a decision
/// they made about FILES.
///
/// So a message is committed HERE: a per-account directory in Application
/// Support at 0700, one 0600 record per delivery. That has four consequences
/// worth naming, because each is a requirement rather than a side effect.
///
///  1. **It never touches the receive folder.** Nothing in this file resolves a
///     bookmark, opens a security scope, or takes a path from the user's grant.
///     A message therefore lands on a Mac whose receive folder is missing,
///     revoked, unwritable or simply never chosen — which is the point:
///     `InboxReceiver` classifies the delivery BEFORE it consults the folder,
///     and only a file delivery can be blocked by one.
///  2. **It is not purgeable.** Application Support, not `tmp` and not
///     `caches`: this is the user's own content and the system may not decide to
///     reclaim it. `IOSSurfaceGuardTests` already refuses the other two here.
///  3. **It is account-scoped**, for the same reason the journal and the key
///     history are. Two accounts on one Mac, and a message one of them received
///     must not be readable by, or survive into, the other's session.
///  4. **It is keyed by TASK ID**, which is what makes a replayed commit
///     idempotent. A crash between writing the record and journalling it leaves
///     the retry writing the SAME record at the SAME name, so a duplicate
///     delivery is impossible by construction rather than by a check that could
///     be forgotten.
///
/// ## What never leaves it
///
/// The message body. It is not logged, not put in a notification, not sent to
/// central, not written into the journal, and not carried on an `InboxReceipt`.
/// Everything downstream of a commit carries a byte COUNT and an id; a caller
/// that wants the text asks this store for it, which is a deliberate, auditable
/// call and not something a log line can do by accident.

/// One received message.
public struct InboxMessage: Equatable, Sendable, Identifiable {
    /// The delivery's task id. The de-duplication identity, and the file name.
    public let id: String
    /// When this Mac committed it.
    public let receivedAt: Date
    /// The message itself. Only ever read from disk by an explicit call.
    public let text: String

    public init(id: String, receivedAt: Date, text: String) {
        self.id = id
        self.receivedAt = receivedAt
        self.text = text
    }

    /// The length the manifest declared, and the only measure of a message that
    /// anything outside this file is allowed to render.
    public var byteCount: Int { text.utf8.count }
}

public enum InboxMessageStoreError: Error, Equatable, Sendable {
    /// A task id that could not safely become a file name.
    case invalidID
    /// Not one nonempty UTF-8 message within the protocol's bounds. Refused
    /// rather than truncated or repaired: a message this store cannot hold
    /// exactly is one it must not claim to have received.
    case invalidMessage
    /// The stored record is unreadable, or a version this build does not
    /// understand. Refused rather than parsed optimistically.
    case unreadable
    /// A filesystem call failed. Carries `errno` and nothing else — a path in an
    /// error is one step from a path in a log.
    case system(Int32)
}

/// The messages one account has received, in a 0700 directory.
public struct InboxMessageStore: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    /// **There is no retention, and no time-based deletion anywhere in this
    /// type.**
    ///
    /// This store briefly had both: a one-year cutoff and a `prune(now:)` the
    /// receive loop called on every idle pass. Both are gone, and their absence
    /// is a requirement rather than an omission waiting to be filled in.
    ///
    /// A journal entry is bookkeeping ABOUT a delivery and may expire once it
    /// can no longer prevent a duplicate or a data loss — `InboxJournalStore`
    /// still prunes for exactly that reason. A message IS the delivery. It is
    /// the user's own content, it exists in no other copy on this Mac, and no
    /// interval is long enough to make deleting it on a schedule they never
    /// chose anything other than silent data loss. A person who has not opened
    /// the app in fourteen months has not consented to losing what was sent to
    /// them; they have been away.
    ///
    /// `remove(_:)` below is the only deletion this type offers, it takes one
    /// id, and nothing in the receive loop calls it. Deletion is a thing a user
    /// does, so it needs a user.

    /// The stored-record format. Bumped only for a change this build could not
    /// read; an unrecognised version is refused, never guessed at.
    static let version = 1

    private struct Record: Codable {
        var version: Int
        var id: String
        var receivedAt: Int64
        var text: String
    }

    func path(_ id: String) throws -> URL {
        guard let checked = try? StoredObjectID.checked(id), checked.count <= 64 else {
            throw InboxMessageStoreError.invalidID
        }
        return directory.appendingPathComponent(checked + ".json")
    }

    /// Whether `text` is a message this store will accept.
    ///
    /// The same bounds the manifest declares, re-applied to the BYTES that
    /// actually arrived: the manifest is sender-controlled and says only what
    /// the sender intended to send. Nonempty because an empty message is not a
    /// message, and bounded at 64 KiB because that is the protocol's ceiling and
    /// this store holds a message in memory to hand it back.
    public static func isAcceptable(_ text: String) -> Bool {
        let bytes = text.utf8.count
        return bytes >= InboxManifest.minTextBytes && bytes <= InboxManifest.maxTextBytes
    }

    /// Commit one message, durably, and return only once it is on stable
    /// storage.
    ///
    /// Idempotent by construction: the record is named by task id, so a replayed
    /// commit rewrites the same record rather than adding a second one. That is
    /// the message half of the journal's no-duplicate contract — the caller
    /// records the commit in the journal AFTER this returns, and a crash in
    /// between costs a rewrite of identical bytes and nothing else.
    public func commit(id: String, text: String, receivedAt: Date) throws {
        guard Self.isAcceptable(text) else { throw InboxMessageStoreError.invalidMessage }
        let url = try path(id)
        let record = Record(version: Self.version, id: url.deletingPathExtension().lastPathComponent,
                            receivedAt: Int64(receivedAt.timeIntervalSince1970), text: text)
        guard let data = try? JSONEncoder().encode(record) else {
            throw InboxMessageStoreError.invalidMessage
        }
        do {
            try InboxJournalStore.ensureDirectory(directory)
            try InboxJournalStore.writeSecretFile(at: url, data: data, in: directory)
        } catch let error as InboxJournalError {
            // Re-typed rather than rethrown: the two stores fail for the same
            // POSIX reasons and a caller classifying this one must not have to
            // know it borrows the other's durable-write primitive.
            switch error {
            case .invalidTaskID: throw InboxMessageStoreError.invalidID
            case .unreadable: throw InboxMessageStoreError.unreadable
            case .system(let code): throw InboxMessageStoreError.system(code)
            }
        }
    }

    /// One message, or nil when this account has never received that delivery.
    public func load(_ id: String) throws -> InboxMessage? {
        let url = try path(id)
        guard let data = FileManager.default.contents(atPath: url.path) else {
            // Distinguish "not there" from "there and unreadable": only the
            // first is a delivery that never happened.
            var st = stat()
            if lstat(url.path, &st) == 0 { throw InboxMessageStoreError.unreadable }
            return nil
        }
        guard let record = try? JSONDecoder().decode(Record.self, from: data),
              record.version == Self.version, Self.isAcceptable(record.text) else {
            throw InboxMessageStoreError.unreadable
        }
        return InboxMessage(id: record.id,
                            receivedAt: Date(timeIntervalSince1970: TimeInterval(record.receivedAt)),
                            text: record.text)
    }

    /// Every message this account holds, newest first — ALL of them, however old.
    ///
    /// Unreadable records are SKIPPED rather than thrown: one corrupt file must
    /// not make the rest of a person's messages unreachable. Nothing else is
    /// skipped; there is no cutoff and no limit, because this is the call the
    /// surface renders and a message missing from it is a message the user has
    /// no way to reach.
    ///
    /// The tie-break on id is not decoration. `receivedAt` is stored to the
    /// second, so two deliveries worked in the same second compare equal — and
    /// `sorted(by:)` is not stable, so without it the newest-first order of a
    /// pair that landed together would differ between two reads of the same
    /// unchanged directory. The id ordering is arbitrary but FIXED, which is
    /// what a list that must not reshuffle under the reader needs.
    public func all() -> [InboxMessage] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else {
            return []
        }
        return names
            .filter { $0.hasSuffix(".json") }
            .compactMap { try? load(String($0.dropLast(".json".count))) }
            .sorted {
                $0.receivedAt == $1.receivedAt ? $0.id > $1.id : $0.receivedAt > $1.receivedAt
            }
    }

    /// Delete ONE message, named by the caller.
    ///
    /// The only deletion this type has, and it is deliberately the shape that
    /// cannot become a policy: it takes a single id, so there is nothing here to
    /// hand a cutoff, a count or a predicate to. Nothing in the receive loop
    /// calls it — see the note above `version`.
    public func remove(_ id: String) throws {
        let url = try path(id)
        if unlink(url.path) != 0, errno != ENOENT {
            throw InboxMessageStoreError.system(errno)
        }
        InboxJournalStore.fsyncDirectory(directory)
    }
}
