import Foundation
@preconcurrency import RelayiumKit

/// One line of a device conversation, in either direction.
///
/// ## Why a flat union rather than two payload cases
///
/// This type is the shape of a JSON index and nothing else. A flat record makes
/// the migration from v1 a field mapping, and it makes "is this record legal"
/// ONE direction-aware assertion — `InboxConversationStore.valid` — instead of a
/// rule spread over two associated values. The cost is that the union has to be
/// enforced rather than expressed, and that cost is paid deliberately: the
/// validator refuses a `sent` record carrying any received-only field and a
/// `received` record carrying any sent-only field, at every read AND at every
/// write, and `InboxTimelineStoreTests` drives both halves.
///
/// ## The invariant this file exists to protect
///
/// **A sent entry never carries a filesystem path.** A received file lives at a
/// path the user chose and Reveal needs it; an outgoing file belongs to the user
/// and its staged copy lives inside this app's container, so putting either on a
/// timeline row would put a container path — or the user's own directory
/// structure — into a durable index, a screenshot and an accessibility label.
/// A sent entry therefore carries `FileNameSnapshot`: the sanitized manifest
/// name and the size, which is exactly what every other send surface renders.
///
/// ## Identity, and why it is prefixed
///
/// A received delivery's stable identity is central's TASK id; an outgoing one's
/// is the local JOB id, which exists before any task does. They are minted by
/// different systems and there is no rule making them disjoint, so the local id
/// is `r:<taskID>` or `s:<jobID>`. Two raw identifiers that happen to be equal
/// therefore cannot collide, and a tombstone is direction-scoped for free.
public struct InboxTimelineEntry: Codable, Equatable, Sendable, Identifiable {

    public enum Direction: String, Codable, Sendable, CaseIterable {
        /// Committed by this Mac's receiver.
        case received
        /// Staged by this Mac's sender.
        case sent
    }

    public enum Kind: String, Codable, Sendable, CaseIterable { case message, files }

    /// The most conservative fact known about an outgoing delivery, as a durable
    /// snapshot.
    ///
    /// **`saved` is writable from exactly one predicate.** `InboxSendState`'s
    /// whole argument is that an upload is not a delivery, and this enum is the
    /// durable half of it: `InboxSendModel.sentState(for:)` maps everything
    /// local — preparing, uploading, creating — onto `sending`, and reaches
    /// `saved` only through `InboxSendActivity.isSavedOnTarget`, which is
    /// `tracking(.saved)` and nothing else.
    ///
    /// There is deliberately no case for a stop REASON. A reason is live
    /// session information (`InboxSendFailure`) and persisting it would make a
    /// relaunched app assert something about a delivery it can no longer verify.
    public enum SentState: String, Codable, Sendable, CaseIterable {
        /// A durable plan exists and nothing has left this Mac.
        case staged
        /// This Mac is preparing, uploading, or creating. Never an arrival.
        case sending
        /// Central holds a task for it and the target has not saved it yet.
        case created
        /// The target device reported it committed. The only arrival claim.
        case saved
        /// The attempt ended without an arrival.
        case stopped
        /// Nobody knows whether a delivery exists. Nothing was released.
        case unknown
    }

    /// A received file, at the path this Mac committed it to.
    ///
    /// The path is retained for exactly one reason — Reveal cannot open a folder
    /// it cannot name — and `InboxSurfaceGuardTests` refuses every surface that
    /// renders it. Only a `received` entry may carry one.
    public struct FileReference: Codable, Equatable, Sendable {
        public let urlPath: String
        public let displayName: String

        public init(url: URL) {
            urlPath = url.path
            displayName = url.lastPathComponent
        }

        public init(urlPath: String, displayName: String) {
            self.urlPath = urlPath
            self.displayName = displayName
        }

        public var url: URL { URL(fileURLWithPath: urlPath) }
    }

    /// What an outgoing delivery contained, by safe manifest identity.
    ///
    /// The name is the manifest name the receiver rebuilds — which may be a
    /// forward-slash relative path inside a chosen folder — and never a staged
    /// slot name, a container path or anything absolute. `InboxConversationStore
    /// .isSafeManifestName` is what enforces that, at every write and every
    /// read.
    public struct FileNameSnapshot: Codable, Equatable, Sendable {
        public let name: String
        public let size: Int64

        public init(name: String, size: Int64) {
            self.name = name
            self.size = size
        }
    }

    /// `r:<taskID>` for a received entry, `s:<jobID>` for a sent one.
    public let id: String
    /// The other device. `InboxConversationStore.legacySenderID` for the
    /// read-only bucket that predates authenticated sender attribution.
    public let peerDeviceID: String
    public let direction: Direction
    public let kind: Kind
    /// **The ordering anchor, and it is immutable.**
    ///
    /// A local clock reading: the moment this Mac committed a receive, or the
    /// moment it staged a send. Central's own `savedAt` is deliberately not used
    /// — it is a different clock, so polling a delivery's state later would move
    /// the row the user is looking at. Nothing in this file ever rewrites it.
    public let at: Date
    public var peerNameSnapshot: String
    public let byteCount: Int64

    // MARK: received-only

    public let taskID: String?
    public let messageID: String?
    public let files: [FileReference]
    public var readAt: Date?

    // MARK: sent-only

    public let jobID: String?
    /// Central's task for this job, once one definitively exists. Rendered as a
    /// fact about the delivery; never used for ordering.
    public var sentTaskID: String?
    public var sentState: SentState?
    public let sentFiles: [FileNameSnapshot]
    /// The key this Mac's own outgoing message body is stored under, in the
    /// protected sent-message directory. Equal to `jobID` when present.
    public let sentMessageID: String?

    public static func receivedID(taskID: String) -> String { "r:" + taskID }
    public static func sentID(jobID: String) -> String { "s:" + jobID }

    public init(id: String, peerDeviceID: String, direction: Direction, kind: Kind,
                at: Date, peerNameSnapshot: String, byteCount: Int64,
                taskID: String? = nil, messageID: String? = nil,
                files: [FileReference] = [], readAt: Date? = nil,
                jobID: String? = nil, sentTaskID: String? = nil,
                sentState: SentState? = nil, sentFiles: [FileNameSnapshot] = [],
                sentMessageID: String? = nil) {
        self.id = id
        self.peerDeviceID = peerDeviceID
        self.direction = direction
        self.kind = kind
        self.at = at
        self.peerNameSnapshot = peerNameSnapshot
        self.byteCount = byteCount
        self.taskID = taskID
        self.messageID = messageID
        self.files = files
        self.readAt = readAt
        self.jobID = jobID
        self.sentTaskID = sentTaskID
        self.sentState = sentState
        self.sentFiles = sentFiles
        self.sentMessageID = sentMessageID
    }

    /// One received delivery, as the receiver commits it.
    public static func received(taskID: String, peerDeviceID: String,
                                peerNameSnapshot: String, kind: Kind, at: Date,
                                messageID: String? = nil,
                                files: [FileReference] = [], byteCount: Int64,
                                readAt: Date? = nil) -> InboxTimelineEntry {
        InboxTimelineEntry(id: receivedID(taskID: taskID), peerDeviceID: peerDeviceID,
                           direction: .received, kind: kind, at: at,
                           peerNameSnapshot: peerNameSnapshot, byteCount: byteCount,
                           taskID: taskID, messageID: messageID, files: files, readAt: readAt)
    }

    /// One outgoing delivery, the moment a durable plan owns its bytes.
    public static func sent(jobID: String, peerDeviceID: String, peerNameSnapshot: String,
                            kind: Kind, at: Date, byteCount: Int64,
                            files: [FileNameSnapshot] = [],
                            state: SentState = .staged,
                            taskID: String? = nil) -> InboxTimelineEntry {
        InboxTimelineEntry(id: sentID(jobID: jobID), peerDeviceID: peerDeviceID,
                           direction: .sent, kind: kind, at: at,
                           peerNameSnapshot: peerNameSnapshot, byteCount: byteCount,
                           jobID: jobID, sentTaskID: taskID, sentState: state,
                           sentFiles: files,
                           // A message body is stored under the job id; a file
                           // delivery has no body and must carry no key to one.
                           sentMessageID: kind == .message ? jobID : nil)
    }

    /// Whether the target device has reported it committed this delivery.
    ///
    /// The durable mirror of `InboxSendActivity.isSavedOnTarget`, and the one
    /// predicate a surface may use to say a sent item arrived.
    public var isSavedOnTarget: Bool { sentState == .saved }

    /// Whether this entry is one the user has not seen. Only a received entry
    /// can be unread — this Mac cannot have missed something it sent itself.
    public var isUnread: Bool { direction == .received && readAt == nil }

    /// How many files this row is about, in either direction.
    public var fileCount: Int { direction == .received ? files.count : sentFiles.count }
}

/// A local deletion, made durable BEFORE the entry goes.
///
/// This is what makes deletion survive every replay source the Device Inbox has:
/// journal receipt replay, both legacy imports, an outgoing status update, a
/// retry, a recovered plan, a refresh, a restart and a sign-out/in. All of them
/// pass through a write gate that consults this list first.
///
/// **Nothing prunes these in 1.2.11.** A journal expires after thirty days but
/// `InboxMessageStore` has no retention at all, so journal age cannot prove that
/// a deleted identity has no remaining import source. Pruning needs a proof
/// covering every source, and that proof is a separate task.
public struct InboxTombstone: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let at: Date
    /// The protected RECEIVED message body still to be unlinked, or nil once it
    /// has been. Non-nil after a crash between the index write and the unlink,
    /// which is what makes local plaintext cleanup converge on the next refresh.
    public var receivedMessageID: String?
    /// The protected SENT message body still to be unlinked, or nil once it has.
    public var sentMessageID: String?

    public init(id: String, at: Date, receivedMessageID: String? = nil,
                sentMessageID: String? = nil) {
        self.id = id
        self.at = at
        self.receivedMessageID = receivedMessageID
        self.sentMessageID = sentMessageID
    }

    /// Whether this tombstone still owes a local plaintext unlink.
    public var needsPlaintextCleanup: Bool {
        receivedMessageID != nil || sentMessageID != nil
    }
}

/// The Relayium-owned local plaintext a deletion made the caller responsible
/// for removing.
///
/// Returned from the store's locked read-modify-write and acted on OUTSIDE the
/// lock, because file IO under a lock the receiver's callback also takes would
/// block a delivery on a directory sync.
///
/// **It contains no user-owned file.** A received file already committed to the
/// user's chosen folder and an outgoing source file are never in here, by
/// construction: the only ids this carries are message-store keys.
public struct InboxTimelineCleanup: Equatable, Sendable {
    /// Received message bodies, by task id, in `InboxMessageStore`.
    public let receivedMessageIDs: [String]
    /// Sent message bodies, by job id, in the separate sent-message store.
    public let sentMessageIDs: [String]

    public init(receivedMessageIDs: [String] = [], sentMessageIDs: [String] = []) {
        self.receivedMessageIDs = receivedMessageIDs
        self.sentMessageIDs = sentMessageIDs
    }

    public var isEmpty: Bool { receivedMessageIDs.isEmpty && sentMessageIDs.isEmpty }
}

/// One device's whole local history, both directions, newest first.
public struct InboxConversation: Equatable, Sendable, Identifiable {
    public let peerDeviceID: String
    public let peerNameSnapshot: String
    public let entries: [InboxTimelineEntry]

    public init(peerDeviceID: String, peerNameSnapshot: String,
                entries: [InboxTimelineEntry]) {
        self.peerDeviceID = peerDeviceID
        self.peerNameSnapshot = peerNameSnapshot
        self.entries = entries
    }

    public var id: String { peerDeviceID }
    public var unreadCount: Int { entries.lazy.filter(\.isUnread).count }
    public var lastActivity: Date { entries.first?.at ?? .distantPast }
    public var messageCount: Int { entries.lazy.filter { $0.kind == .message }.count }
    public var fileCount: Int { entries.reduce(0) { $0 + $1.fileCount } }
    /// Every file this Mac RECEIVED here, for the one Finder action. An
    /// outgoing entry carries no path and can contribute nothing.
    public var receivedFileURLs: [URL] {
        entries.filter { $0.direction == .received }.flatMap(\.files).map(\.url)
    }
    /// Exactly what the open screen can see, which is what a conversation
    /// deletion is allowed to remove.
    public var entryIDs: Set<String> { Set(entries.map(\.id)) }
}

/// One outgoing delivery, described the moment a durable plan owns its bytes.
///
/// **The account is a field rather than an assumption.** `InboxSendModel` is
/// app-scoped and holds its account as the plain user id the session publishes;
/// the stores this ends up in are scoped to an `InboxAccountID`. They come from
/// one session a turn apart, and the cost of trusting that instead of checking
/// it is one account's sent history appearing under another's. The receiving
/// side refuses the merge unless the two agree.
///
/// It carries no message BODY and no path. The body travels as a separate
/// argument to exactly one method, so nothing that logs or compares this value
/// can print what the user wrote.
public struct InboxSentHistoryEvent: Equatable, Sendable {
    public let accountID: String
    /// The local job id. Stable from before any task exists, which is why it is
    /// the sent identity — and never the sender's transient staging placeholder.
    public let jobID: String
    public let peerDeviceID: String
    public let kind: InboxTimelineEntry.Kind
    /// The immutable local ordering anchor: the plan's own creation time, so a
    /// plan recovered days later keeps its place instead of jumping to the top.
    public let at: Date
    public let byteCount: Int64
    /// Sanitized manifest names and sizes. Never a staged slot name and never a
    /// container path — `InboxConversationStore.isSafeManifestName` refuses both.
    public let files: [InboxTimelineEntry.FileNameSnapshot]
    public let state: InboxTimelineEntry.SentState
    public let taskID: String?

    public init(accountID: String, jobID: String, peerDeviceID: String,
                kind: InboxTimelineEntry.Kind, at: Date, byteCount: Int64,
                files: [InboxTimelineEntry.FileNameSnapshot] = [],
                state: InboxTimelineEntry.SentState = .staged, taskID: String? = nil) {
        self.accountID = accountID
        self.jobID = jobID
        self.peerDeviceID = peerDeviceID
        self.kind = kind
        self.at = at
        self.byteCount = byteCount
        self.files = files
        self.state = state
        self.taskID = taskID
    }
}
