import Foundation
@preconcurrency import RelayiumKit

public struct InboxDeliveryRecord: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case message, files }

    public struct FileReference: Codable, Equatable, Sendable {
        public let urlPath: String
        public let displayName: String

        public init(url: URL) {
            urlPath = url.path
            displayName = url.lastPathComponent
        }

        public var url: URL { URL(fileURLWithPath: urlPath) }
    }

    public let taskID: String
    public let senderDeviceID: String
    public var senderNameSnapshot: String
    public let kind: Kind
    public let receivedAt: Date
    public let messageID: String?
    public let files: [FileReference]
    public let byteCount: Int64
    public var readAt: Date?

    public var id: String { taskID }

    public init(taskID: String, senderDeviceID: String, senderNameSnapshot: String,
                kind: Kind, receivedAt: Date, messageID: String? = nil,
                files: [FileReference] = [], byteCount: Int64, readAt: Date? = nil) {
        self.taskID = taskID
        self.senderDeviceID = senderDeviceID
        self.senderNameSnapshot = senderNameSnapshot
        self.kind = kind
        self.receivedAt = receivedAt
        self.messageID = messageID
        self.files = files
        self.byteCount = byteCount
        self.readAt = readAt
    }
}

public struct InboxConversation: Equatable, Sendable, Identifiable {
    public let senderDeviceID: String
    public let senderNameSnapshot: String
    public let deliveries: [InboxDeliveryRecord]

    public var id: String { senderDeviceID }
    public var unreadCount: Int { deliveries.lazy.filter { $0.readAt == nil }.count }
    public var lastActivity: Date { deliveries.first?.receivedAt ?? .distantPast }
    public var messageCount: Int { deliveries.lazy.filter { $0.kind == .message }.count }
    public var fileCount: Int { deliveries.reduce(0) { $0 + $1.files.count } }
}

public enum InboxConversationStoreError: Error, Equatable, Sendable {
    case invalidRecord
    case unreadable
    case system(Int32)
}

/// Account-scoped durable metadata for the local conversation view.
///
/// Message plaintext remains exclusively in `InboxMessageStore`; this index
/// carries only its task reference. Central never receives any field here.
public final class InboxConversationStore: @unchecked Sendable {
    private struct Index: Codable {
        var version: Int
        var records: [InboxDeliveryRecord]
    }

    static let version = 1
    public static let legacySenderID = "legacy-v2"

    public let directory: URL
    private let lock = NSLock()
    private var indexURL: URL { directory.appendingPathComponent("conversations-v1.json") }

    public init(directory: URL) { self.directory = directory }

    @discardableResult
    public func record(_ record: InboxDeliveryRecord) throws -> Bool {
        try locked {
            guard Self.valid(record) else { throw InboxConversationStoreError.invalidRecord }
            var record = record
            record.senderNameSnapshot = Self.safeName(record.senderNameSnapshot)
            var index = try loadIndex()
            if let existing = index.records.firstIndex(where: { $0.taskID == record.taskID }) {
                let previous = index.records[existing]
                if previous.senderDeviceID == Self.legacySenderID,
                   record.senderDeviceID != Self.legacySenderID {
                    // A startup import may see the old flat record before the
                    // retained v3 journal is replayed. Authenticated journal
                    // attribution upgrades that placeholder; it never lets one
                    // real sender overwrite another. Preserve the old read mark
                    // so a restart does not announce the delivery again.
                    if record.readAt == nil { record.readAt = previous.readAt }
                    index.records[existing] = record
                    try save(index)
                    return false
                }
                guard previous.senderDeviceID == record.senderDeviceID else {
                    throw InboxConversationStoreError.invalidRecord
                }
                if !record.senderNameSnapshot.isEmpty {
                    index.records[existing].senderNameSnapshot = record.senderNameSnapshot
                    try save(index)
                }
                return false
            }
            index.records.append(record)
            try save(index)
            return true
        }
    }

    /// Marks exactly the rows the opened screen observed. A delivery committed
    /// concurrently after that snapshot remains unread.
    public func markRead(senderDeviceID: String, observedTaskIDs: Set<String>, at: Date) throws {
        try locked {
            var index = try loadIndex()
            var changed = false
            for position in index.records.indices
                where index.records[position].senderDeviceID == senderDeviceID
                    && observedTaskIDs.contains(index.records[position].taskID)
                    && index.records[position].readAt == nil {
                index.records[position].readAt = at
                changed = true
            }
            if changed { try save(index) }
        }
    }

    public func conversations() throws -> [InboxConversation] {
        try locked {
            let groups = Dictionary(grouping: try loadIndex().records, by: \.senderDeviceID)
            return groups.map { sender, records in
                let ordered = records.sorted {
                    $0.receivedAt == $1.receivedAt ? $0.taskID > $1.taskID
                                                   : $0.receivedAt > $1.receivedAt
                }
                return InboxConversation(senderDeviceID: sender,
                    senderNameSnapshot: ordered.first(where: { !$0.senderNameSnapshot.isEmpty })?
                        .senderNameSnapshot ?? "", deliveries: ordered)
            }.sorted {
                $0.lastActivity == $1.lastActivity ? $0.senderDeviceID < $1.senderDeviceID
                                                   : $0.lastActivity > $1.lastActivity
            }
        }
    }

    /// Imports old flat messages without copying plaintext. Repeated imports are
    /// idempotent by the original task id and remain visibly grouped as legacy.
    public func importLegacy(messages: [InboxMessage]) throws {
        for message in messages {
            _ = try record(InboxDeliveryRecord(taskID: message.id,
                senderDeviceID: Self.legacySenderID, senderNameSnapshot: "",
                kind: .message, receivedAt: message.receivedAt, messageID: message.id,
                byteCount: Int64(message.byteCount), readAt: message.receivedAt))
        }
    }

    public func importLegacy(receipts: [InboxReceipt]) throws {
        for receipt in receipts {
            _ = try record(InboxDeliveryRecord(taskID: receipt.taskID,
                // v3 journals carry authenticated sender identity. Only an old
                // journal whose field was absent belongs in Legacy.
                senderDeviceID: receipt.senderDeviceID, senderNameSnapshot: "",
                kind: receipt.kind == .message ? .message : .files,
                receivedAt: receipt.savedAt,
                messageID: receipt.kind == .message ? receipt.taskID : nil,
                files: receipt.urls.map(InboxDeliveryRecord.FileReference.init),
                byteCount: receipt.byteCount, readAt: receipt.savedAt))
        }
    }

    static func safeName(_ value: String) -> String {
        String(value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(80))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func valid(_ record: InboxDeliveryRecord) -> Bool {
        guard (try? StoredObjectID.checked(record.taskID)) != nil,
              (try? StoredObjectID.checked(record.senderDeviceID)) != nil,
              record.byteCount >= 0 else { return false }
        switch record.kind {
        case .message: return record.messageID == record.taskID && record.files.isEmpty
        case .files: return record.messageID == nil && !record.files.isEmpty
        }
    }

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

    private func loadIndex() throws -> Index {
        guard FileManager.default.fileExists(atPath: indexURL.path) else {
            return Index(version: Self.version, records: [])
        }
        guard let data = FileManager.default.contents(atPath: indexURL.path),
              let index = try? JSONDecoder().decode(Index.self, from: data),
              index.version == Self.version,
              index.records.allSatisfy(Self.valid),
              Set(index.records.map(\.taskID)).count == index.records.count else {
            throw InboxConversationStoreError.unreadable
        }
        return index
    }

    private func save(_ index: Index) throws {
        guard let data = try? JSONEncoder().encode(index) else {
            throw InboxConversationStoreError.unreadable
        }
        try InboxJournalStore.ensureDirectory(directory)
        try InboxJournalStore.writeSecretFile(at: indexURL, data: data, in: directory)
    }
}
