import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// The v1 index row, kept for exactly one purpose: reading the file this build
/// replaces.
///
/// It is `Decodable` and nothing writes it. Migration maps every row to a
/// `received` timeline entry, because that is all v1 could ever hold — the store
/// had no outgoing concept at all, which is the defect 1.2.11 repairs.
struct InboxLegacyDeliveryRecord: Codable, Equatable, Sendable {
    struct FileReference: Codable, Equatable, Sendable {
        let urlPath: String
        let displayName: String
    }

    let taskID: String
    let senderDeviceID: String
    var senderNameSnapshot: String
    let kind: String
    let receivedAt: Date
    let messageID: String?
    let files: [FileReference]
    let byteCount: Int64
    var readAt: Date?
}

public enum InboxConversationStoreError: Error, Equatable, Sendable {
    case invalidRecord
    case unreadable
    case system(Int32)
}

/// Account-scoped durable metadata for the local conversation view — **both
/// directions, and erasable.**
///
/// ## What it holds and what it deliberately does not
///
/// Message plaintext is never here. A received body stays in `InboxMessageStore`
/// and an outgoing body in the separate sent-message store beside it; this index
/// carries only their keys. Central never receives any field in this file, and
/// no field here is a wire value.
///
/// ## The three properties every method below is written against
///
///  1. **One write gate.** `record`, `recordSent`, `updateSent` and `markRead`
///     are the only mutators, they all take the same lock, and each consults the
///     tombstone list before it upserts anything. That is what makes deletion
///     survive receipt replay, both legacy imports, a repeated startup import,
///     an outgoing status update, a retry, a recovered plan, a refresh, a
///     sign-out/in and a process restart — nine sources, one check.
///  2. **Deletion is history deletion.** Nothing in this file calls central,
///     touches a `PendingUploadPlan`, removes staged bytes, invalidates an
///     idempotency key or stops a delivery. `delete(entryIDs:)` writes tombstones
///     and returns the Relayium-owned plaintext the CALLER must unlink; the
///     user's own files are not reachable from here.
///  3. **A snapshot, not a predicate.** `delete(entryIDs:)` takes the exact ids
///     the open screen observed, exactly as `markRead` takes the ids it saw. A
///     delivery committed after the user pressed Delete has no tombstone, so it
///     lands as a new unread item instead of being silently swallowed by a
///     permanent peer-wide ban.
public final class InboxConversationStore: @unchecked Sendable {

    private struct Index: Codable {
        var version: Int
        var entries: [InboxTimelineEntry]
        var tombstones: [InboxTombstone]
    }

    public static let version = 2
    static let legacyVersion = 1
    /// The read-only bucket for deliveries committed before the journal carried
    /// authenticated sender attribution. It is not a device id and can never be
    /// sent to.
    public static let legacySenderID = "legacy-v2"

    public let directory: URL
    private let lock = NSLock()
    private var indexURL: URL { directory.appendingPathComponent("conversations-v2.json") }
    private var legacyIndexURL: URL { directory.appendingPathComponent("conversations-v1.json") }

    public init(directory: URL) { self.directory = directory }

    // MARK: - write gates

    /// Commit one RECEIVED delivery. Returns whether it was new.
    ///
    /// The first thing it does is ask whether this identity has been deleted on
    /// this Mac. Every replay source in the product funnels through here, so a
    /// deleted receive cannot come back through any of them.
    @discardableResult
    public func record(_ entry: InboxTimelineEntry) throws -> Bool {
        try locked {
            guard entry.direction == .received, Self.valid(entry) else {
                throw InboxConversationStoreError.invalidRecord
            }
            var entry = entry
            entry.peerNameSnapshot = Self.safeName(entry.peerNameSnapshot)
            var index = try loadIndex()
            guard !index.tombstones.contains(where: { $0.id == entry.id }) else { return false }
            if let existing = index.entries.firstIndex(where: { $0.id == entry.id }) {
                let previous = index.entries[existing]
                if previous.peerDeviceID == Self.legacySenderID,
                   entry.peerDeviceID != Self.legacySenderID {
                    // A startup import may see the old flat record before the
                    // retained v3 journal is replayed. Authenticated journal
                    // attribution upgrades that placeholder; it never lets one
                    // real sender overwrite another. Preserve the old read mark
                    // so a restart does not announce the delivery again.
                    if entry.readAt == nil { entry.readAt = previous.readAt }
                    index.entries[existing] = entry
                    try save(index)
                    return false
                }
                guard previous.peerDeviceID == entry.peerDeviceID else {
                    // **A legacy placeholder losing to real attribution is not
                    // an error.** `importLegacy(messages:)` replays the whole
                    // flat message store on every start, so a message already
                    // upgraded to its authenticated sender comes back through
                    // here on the next launch. Throwing made that the caller's
                    // problem — `refreshConversations` catches, blanks the
                    // published list and raises the history-unreadable banner —
                    // so one received message plus one restart emptied the whole
                    // Conversations section. It is already recorded, better
                    // attributed than this import could manage, so it is a
                    // no-op. One REAL sender overwriting another still throws,
                    // which is the forgery this guard exists for.
                    guard entry.peerDeviceID == Self.legacySenderID else {
                        throw InboxConversationStoreError.invalidRecord
                    }
                    return false
                }
                if !entry.peerNameSnapshot.isEmpty {
                    index.entries[existing].peerNameSnapshot = entry.peerNameSnapshot
                    try save(index)
                }
                return false
            }
            index.entries.append(entry)
            try save(index)
            return true
        }
    }

    /// Commit or refresh one SENT delivery's durable history row.
    ///
    /// Called the moment a durable plan owns the bytes — before any network work
    /// — and again by recovery when a plan is rediscovered in a later process.
    /// The second call must not resurrect a row the user deleted in between,
    /// which is why the tombstone check is the first thing here too.
    ///
    /// It never rewrites `at`. A materialization that recomputed the anchor from
    /// the current clock would move a two-day-old recovered send to the top of
    /// the timeline on every launch.
    @discardableResult
    public func recordSent(_ entry: InboxTimelineEntry) throws -> Bool {
        try locked {
            guard entry.direction == .sent, Self.valid(entry) else {
                throw InboxConversationStoreError.invalidRecord
            }
            var entry = entry
            entry.peerNameSnapshot = Self.safeName(entry.peerNameSnapshot)
            var index = try loadIndex()
            guard !index.tombstones.contains(where: { $0.id == entry.id }) else { return false }
            if let existing = index.entries.firstIndex(where: { $0.id == entry.id }) {
                guard index.entries[existing].direction == .sent,
                      index.entries[existing].peerDeviceID == entry.peerDeviceID else {
                    throw InboxConversationStoreError.invalidRecord
                }
                var changed = false
                if !entry.peerNameSnapshot.isEmpty,
                   index.entries[existing].peerNameSnapshot != entry.peerNameSnapshot {
                    index.entries[existing].peerNameSnapshot = entry.peerNameSnapshot
                    changed = true
                }
                if changed { try save(index) }
                return false
            }
            index.entries.append(entry)
            try save(index)
            return true
        }
    }

    /// Record what is now known about one outgoing delivery.
    ///
    /// **It changes state and the task id, and nothing else.** In particular it
    /// cannot move `at`, so a poll that discovers central saved a delivery an
    /// hour ago does not reorder the timeline under the reader.
    ///
    /// A tombstoned job is a no-op: the delivery goes on running and reporting,
    /// and none of it comes back on screen.
    public func updateSent(jobID: String, state: InboxTimelineEntry.SentState,
                           taskID: String? = nil) throws {
        try locked {
            let id = InboxTimelineEntry.sentID(jobID: jobID)
            var index = try loadIndex()
            guard !index.tombstones.contains(where: { $0.id == id }),
                  let position = index.entries.firstIndex(where: { $0.id == id }),
                  index.entries[position].direction == .sent else { return }
            var entry = index.entries[position]
            var changed = false
            if entry.sentState != state { entry.sentState = state; changed = true }
            if let taskID, entry.sentTaskID != taskID {
                guard (try? StoredObjectID.checked(taskID)) != nil else {
                    throw InboxConversationStoreError.invalidRecord
                }
                entry.sentTaskID = taskID
                changed = true
            }
            guard changed, Self.valid(entry) else { return }
            index.entries[position] = entry
            try save(index)
        }
    }

    /// Marks exactly the rows the opened screen observed. A delivery committed
    /// concurrently after that snapshot remains unread.
    public func markRead(peerDeviceID: String, observedEntryIDs: Set<String>,
                         at: Date) throws {
        try locked {
            var index = try loadIndex()
            var changed = false
            for position in index.entries.indices
                where index.entries[position].peerDeviceID == peerDeviceID
                    && observedEntryIDs.contains(index.entries[position].id)
                    && index.entries[position].isUnread {
                index.entries[position].readAt = at
                changed = true
            }
            if changed { try save(index) }
        }
    }

    // MARK: - deletion

    /// Delete exactly these entries from THIS Mac.
    ///
    /// One locked read-modify-write: the tombstones are on stable storage before
    /// this returns, so a crash immediately afterwards leaves the entries gone
    /// and unable to return. What it returns is the Relayium-owned plaintext the
    /// caller must now unlink — which is deliberately NOT done in here, because
    /// this lock is also taken by the receiver's commit callback and a directory
    /// sync under it would stall a delivery.
    ///
    /// **It is not a recall and it is not a cancel.** Nothing in this method can
    /// reach central, a plan, a content key, an idempotency key or a staged byte.
    /// A delivery in flight continues, its later status updates hit the tombstone
    /// gate above and change nothing on screen.
    ///
    /// `peerDeviceID`, when given, is a REFUSAL rather than a hint: an id is
    /// deleted only if the row currently on disk belongs to that peer. The whole
    /// point of taking an observed id set is that it comes from a screen, and a
    /// screen's snapshot can be stale, mis-plumbed by a later refactor, or — for
    /// a conversation delete — simply the wrong conversation's. Without this,
    /// one mistaken argument turns "delete this device's history" into "delete
    /// these rows wherever they live", and a tombstone makes that permanent.
    /// An id whose row is absent is skipped for the same reason: this store
    /// cannot attribute it to a peer, so it cannot prove the deletion was asked
    /// for.
    @discardableResult
    public func delete(entryIDs: Set<String>,
                       peerDeviceID: String? = nil) throws -> InboxTimelineCleanup {
        try locked {
            guard !entryIDs.isEmpty else { return InboxTimelineCleanup() }
            var index = try loadIndex()
            var received: [String] = []
            var sent: [String] = []
            var removed = Set<String>()
            let now = Date()
            for id in entryIDs.sorted() {
                let entry = index.entries.first { $0.id == id }
                if let peerDeviceID {
                    guard let entry, entry.peerDeviceID == peerDeviceID else { continue }
                }
                removed.insert(id)
                let receivedMessageID = entry?.direction == .received ? entry?.messageID : nil
                let sentMessageID = entry?.direction == .sent ? entry?.sentMessageID : nil
                if let receivedMessageID { received.append(receivedMessageID) }
                if let sentMessageID { sent.append(sentMessageID) }
                if let position = index.tombstones.firstIndex(where: { $0.id == id }) {
                    // Re-deleting an id already tombstoned re-arms its cleanup
                    // rather than dropping it: the entry may have been rewritten
                    // and the unlink may still be owed.
                    index.tombstones[position].receivedMessageID =
                        receivedMessageID ?? index.tombstones[position].receivedMessageID
                    index.tombstones[position].sentMessageID =
                        sentMessageID ?? index.tombstones[position].sentMessageID
                } else if Self.isTombstonable(id) {
                    index.tombstones.append(InboxTombstone(id: id, at: now,
                                                           receivedMessageID: receivedMessageID,
                                                           sentMessageID: sentMessageID))
                }
            }
            index.entries.removeAll { removed.contains($0.id) }
            try save(index)
            return InboxTimelineCleanup(receivedMessageIDs: received, sentMessageIDs: sent)
        }
    }

    /// Whether this local identity has been deleted on this Mac.
    ///
    /// Read by `InboxSendModel`'s publish filter through the controller, so a
    /// deleted outgoing job stops being described even while its delivery runs.
    /// Returns false on an unreadable index rather than throwing: a store that
    /// cannot be read must not silently hide live work.
    public func isDeleted(_ id: String) -> Bool {
        (try? locked { try loadIndex().tombstones.contains { $0.id == id } }) ?? false
    }

    /// Every id this store considers deleted, for a caller that needs the whole
    /// set at once rather than a lookup per row.
    public func deletedIDs() throws -> Set<String> {
        try locked { Set(try loadIndex().tombstones.map(\.id)) }
    }

    /// The local plaintext a previous deletion has not finished unlinking.
    ///
    /// Non-empty only after a crash between the durable index write and the
    /// unlink. The caller retries the unlink and then calls
    /// `clearPlaintextCleanup`, which is what makes deletion converge across a
    /// restart instead of leaving a body on disk for an entry the user can no
    /// longer see or delete again.
    public func pendingPlaintextCleanup() throws -> InboxTimelineCleanup {
        try locked {
            let tombstones = try loadIndex().tombstones
            return InboxTimelineCleanup(
                receivedMessageIDs: tombstones.compactMap(\.receivedMessageID),
                sentMessageIDs: tombstones.compactMap(\.sentMessageID))
        }
    }

    /// Record that these bodies are gone. Idempotent.
    public func clearPlaintextCleanup(_ cleanup: InboxTimelineCleanup) throws {
        guard !cleanup.isEmpty else { return }
        try locked {
            var index = try loadIndex()
            let received = Set(cleanup.receivedMessageIDs)
            let sent = Set(cleanup.sentMessageIDs)
            var changed = false
            for position in index.tombstones.indices {
                if let id = index.tombstones[position].receivedMessageID, received.contains(id) {
                    index.tombstones[position].receivedMessageID = nil
                    changed = true
                }
                if let id = index.tombstones[position].sentMessageID, sent.contains(id) {
                    index.tombstones[position].sentMessageID = nil
                    changed = true
                }
            }
            if changed { try save(index) }
        }
    }

    // MARK: - reading

    public func conversations() throws -> [InboxConversation] {
        try locked {
            let groups = Dictionary(grouping: try loadIndex().entries, by: \.peerDeviceID)
            return groups.map { peer, entries in
                // `(at desc, id desc)`. The id tie-break is not decoration: two
                // entries worked in the same second compare equal on `at`, and
                // `sorted(by:)` is not stable, so without it a mixed timeline
                // would reshuffle between two reads of an unchanged file.
                let ordered = entries.sorted {
                    $0.at == $1.at ? $0.id > $1.id : $0.at > $1.at
                }
                return InboxConversation(peerDeviceID: peer,
                    peerNameSnapshot: ordered.first(where: { !$0.peerNameSnapshot.isEmpty })?
                        .peerNameSnapshot ?? "", entries: ordered)
            }.sorted {
                $0.lastActivity == $1.lastActivity ? $0.peerDeviceID < $1.peerDeviceID
                                                   : $0.lastActivity > $1.lastActivity
            }
        }
    }

    // MARK: - legacy import

    /// Imports old flat messages without copying plaintext. Repeated imports are
    /// idempotent by the original task id and remain visibly grouped as legacy.
    public func importLegacy(messages: [InboxMessage]) throws {
        for message in messages {
            _ = try record(.received(taskID: message.id, peerDeviceID: Self.legacySenderID,
                                     peerNameSnapshot: "", kind: .message,
                                     at: message.receivedAt, messageID: message.id,
                                     byteCount: Int64(message.byteCount),
                                     readAt: message.receivedAt))
        }
    }

    public func importLegacy(receipts: [InboxReceipt]) throws {
        for receipt in receipts {
            _ = try record(.received(taskID: receipt.taskID,
                // v3 journals carry authenticated sender identity. Only an old
                // journal whose field was absent belongs in Legacy.
                peerDeviceID: receipt.senderDeviceID, peerNameSnapshot: "",
                kind: receipt.kind == .message ? .message : .files,
                at: receipt.savedAt,
                messageID: receipt.kind == .message ? receipt.taskID : nil,
                files: receipt.urls.map(InboxTimelineEntry.FileReference.init),
                byteCount: receipt.byteCount, readAt: receipt.savedAt))
        }
    }

    // MARK: - validation

    static func safeName(_ value: String) -> String {
        String(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(80))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether a sent entry's file name is a manifest identity rather than a
    /// path into somebody's disk.
    ///
    /// A manifest name legitimately contains forward slashes — that is how a
    /// chosen folder keeps its hierarchy inside the seal — so a slash alone is
    /// not the defect. What is refused is everything that makes a name a PATH:
    /// an absolute root, a home reference, a parent traversal, a Windows
    /// separator, an embedded NUL or any other control character. That refusal
    /// is what stops a `PendingUpload` container path or a staged slot name ever
    /// being written into a durable index the surface renders.
    static func isSafeManifestName(_ name: String) -> Bool {
        guard !name.isEmpty, name.count <= 200,
              !name.hasPrefix("/"), !name.hasPrefix("~"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        else { return false }
        return !name.components(separatedBy: "/").contains("..")
    }

    /// The placeholder key `InboxSendModel` tracks a staging attempt under.
    ///
    /// It is a global singleton slot, so two sends in one session share it — a
    /// durable entry built on it would be one send overwriting another's
    /// history. History is created from a real job id and never from this.
    // nonlocalized: the sender's internal staging slot key, never displayed
    static let stagingPlaceholderID = "staging"

    /// An id worth a tombstone.
    ///
    /// Direction-prefixed and non-empty. The staging placeholder is refused for
    /// the reason above: banning it permanently would ban every future send.
    static func isTombstonable(_ id: String) -> Bool {
        guard id.hasPrefix("r:") || id.hasPrefix("s:") else { return false }
        let raw = String(id.dropFirst(2))
        guard (try? StoredObjectID.checked(raw)) != nil else { return false }
        return !(id.hasPrefix("s:") && raw == stagingPlaceholderID)
    }

    /// The one direction-aware assertion, applied at every write AND every read.
    ///
    /// Reading matters as much as writing: a hand-edited or partially written
    /// index is refused as `unreadable` rather than rendered, so a `sent` row
    /// carrying a path could not be introduced by editing the file either.
    static func valid(_ entry: InboxTimelineEntry) -> Bool {
        guard (try? StoredObjectID.checked(entry.peerDeviceID)) != nil,
              entry.byteCount >= 0 else { return false }
        switch entry.direction {
        case .received:
            guard let taskID = entry.taskID,
                  (try? StoredObjectID.checked(taskID)) != nil,
                  entry.id == InboxTimelineEntry.receivedID(taskID: taskID),
                  // Every sent-only field absent. A received row carrying one is
                  // a union this build refuses to guess about.
                  entry.jobID == nil, entry.sentTaskID == nil, entry.sentState == nil,
                  entry.sentFiles.isEmpty, entry.sentMessageID == nil else { return false }
            switch entry.kind {
            case .message: return entry.messageID == taskID && entry.files.isEmpty
            case .files: return entry.messageID == nil && !entry.files.isEmpty
            }
        case .sent:
            guard let jobID = entry.jobID,
                  (try? StoredObjectID.checked(jobID)) != nil,
                  jobID != stagingPlaceholderID,
                  entry.id == InboxTimelineEntry.sentID(jobID: jobID),
                  entry.sentState != nil,
                  // Every received-only field absent — including `readAt`: this
                  // Mac cannot have failed to read something it sent itself.
                  entry.taskID == nil, entry.messageID == nil, entry.files.isEmpty,
                  entry.readAt == nil else { return false }
            if let taskID = entry.sentTaskID,
               (try? StoredObjectID.checked(taskID)) == nil { return false }
            guard entry.sentFiles.allSatisfy({ isSafeManifestName($0.name) && $0.size >= 0 })
            else { return false }
            switch entry.kind {
            case .message: return entry.sentMessageID == jobID && entry.sentFiles.isEmpty
            case .files: return entry.sentMessageID == nil && !entry.sentFiles.isEmpty
            }
        }
    }

    private static func validTombstone(_ tombstone: InboxTombstone) -> Bool {
        guard isTombstonable(tombstone.id) else { return false }
        for id in [tombstone.receivedMessageID, tombstone.sentMessageID].compactMap({ $0 })
            where (try? StoredObjectID.checked(id)) == nil { return false }
        return true
    }

    // MARK: - storage

    private func locked<T>(_ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        do { return try body() }
        catch let error as InboxConversationStoreError { throw error }
        catch let error as InboxJournalError {
            switch error {
            case .invalidTaskID: throw InboxConversationStoreError.invalidRecord
            case .unreadable: throw InboxConversationStoreError.unreadable
            case .system(let code): throw InboxConversationStoreError.system(code)
            }
        }
        catch { throw InboxConversationStoreError.unreadable }
    }

    /// The v2 index, migrating v1 exactly once if that is what is on disk.
    ///
    /// **The order is the correctness, and it is two rules rather than one.**
    ///
    /// The first is the foundation of the whole tombstone mechanism: once a
    /// USABLE v2 exists, v1 is never read. Merging a leftover v1 back in would
    /// resurrect every deleted received entry on the next launch, which is the
    /// one failure this feature cannot have.
    ///
    /// The second is why `retireLegacyIndex` is called AFTER the validation
    /// below rather than before it. A v2 file that is truncated, hand-edited or
    /// half-written is refused as `unreadable` — and if v1 had already been
    /// unlinked by then, that refusal would have destroyed the only remaining
    /// copy of the user's received history on the way to reporting a problem.
    /// So v1 is retired only once a v2 has actually decoded and passed every
    /// assertion, which makes the unlink a consequence of a good migration
    /// instead of a bet on one.
    private func loadIndex() throws -> Index {
        if FileManager.default.fileExists(atPath: indexURL.path) {
            guard let data = FileManager.default.contents(atPath: indexURL.path),
                  let index = try? JSONDecoder().decode(Index.self, from: data),
                  index.version == Self.version,
                  index.entries.allSatisfy(Self.valid),
                  index.tombstones.allSatisfy(Self.validTombstone),
                  Set(index.entries.map(\.id)).count == index.entries.count,
                  Set(index.tombstones.map(\.id)).count == index.tombstones.count,
                  // A row that is both present and tombstoned is a file this
                  // build did not write. Refused rather than resolved silently
                  // in whichever direction happened to be convenient.
                  Set(index.entries.map(\.id))
                      .isDisjoint(with: Set(index.tombstones.map(\.id)))
            else { throw InboxConversationStoreError.unreadable }
            // Proven good. Only now is the v1 file provably redundant.
            retireLegacyIndex()
            return index
        }
        guard FileManager.default.fileExists(atPath: legacyIndexURL.path) else {
            return Index(version: Self.version, entries: [], tombstones: [])
        }
        let migrated = try migrateLegacyIndex()
        // Durable BEFORE the v1 file is retired, so a crash in between leaves v1
        // in place and the migration simply runs again.
        try save(migrated)
        retireLegacyIndex()
        return migrated
    }

    private struct LegacyIndex: Codable {
        var version: Int
        var records: [InboxLegacyDeliveryRecord]
    }

    /// Every v1 row becomes a RECEIVED entry, because that is the only thing v1
    /// could hold. `readAt` and the sender attribution are preserved exactly;
    /// nothing is re-derived and nothing is dropped.
    private func migrateLegacyIndex() throws -> Index {
        guard let data = FileManager.default.contents(atPath: legacyIndexURL.path),
              let legacy = try? JSONDecoder().decode(LegacyIndex.self, from: data),
              legacy.version == Self.legacyVersion else {
            throw InboxConversationStoreError.unreadable
        }
        var entries: [InboxTimelineEntry] = []
        var seen = Set<String>()
        for record in legacy.records {
            let entry = InboxTimelineEntry.received(
                taskID: record.taskID, peerDeviceID: record.senderDeviceID,
                peerNameSnapshot: Self.safeName(record.senderNameSnapshot),
                kind: record.kind == "message" ? .message : .files,
                at: record.receivedAt, messageID: record.messageID,
                files: record.files.map { InboxTimelineEntry.FileReference(
                    urlPath: $0.urlPath, displayName: $0.displayName) },
                byteCount: record.byteCount, readAt: record.readAt)
            guard Self.valid(entry), seen.insert(entry.id).inserted else {
                throw InboxConversationStoreError.unreadable
            }
            entries.append(entry)
        }
        return Index(version: Self.version, entries: entries, tombstones: [])
    }

    /// Best effort, and correctness does not depend on it: once v2 exists the v1
    /// file is unreachable by `loadIndex` whether or not it is still there.
    private func retireLegacyIndex() {
        if unlink(legacyIndexURL.path) == 0 {
            InboxJournalStore.fsyncDirectory(directory)
        }
    }

    private func save(_ index: Index) throws {
        guard let data = try? JSONEncoder().encode(index) else {
            throw InboxConversationStoreError.unreadable
        }
        try InboxJournalStore.ensureDirectory(directory)
        try InboxJournalStore.writeSecretFile(at: indexURL, data: data, in: directory)
    }
}
