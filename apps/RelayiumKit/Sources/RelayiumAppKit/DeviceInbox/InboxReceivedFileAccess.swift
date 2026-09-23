import Foundation

/// **Reaching a file the Device Inbox actually saved on this device — and only
/// that file, only for the account that received it, only while it is there.**
///
/// A received row carries `InboxTimelineEntry.FileReference`, an ABSOLUTE path
/// written when the delivery was committed. On iOS that path is not something to
/// hand to a share sheet as it stands:
///
///  - **The container moves.** iOS assigns the app container's path, and it can
///    differ after an update or a restore. A stored absolute path is a record of
///    where the file WAS; the file is found again by its place inside the
///    receive folder (`Relayium › Received`), re-rooted under the folder this
///    process resolves now.
///  - **The folder is the user's.** It is published to the Files app, so a file
///    can be deleted, renamed, moved or replaced — with a folder or a symbolic
///    link — at any time. Existence is asked at the moment of use, a folder
///    where a file was is not the file, and a symbolic link is followed only to
///    see where it leads: anything that resolves outside the receive folder is
///    refused rather than opened.
///  - **The history is an account's.** The receive folder is shared by every
///    account that has used this device, but a conversation is not. So an action
///    starts from an entry in the CURRENT account's conversation, and its result
///    is re-checked against the account and the entry again when it lands —
///    a resolution that finishes after a sign-out, an account switch, a device
///    revocation that dropped the conversation, or a local delete, publishes
///    nothing.
///
/// Nothing here writes, moves or deletes anything. It only answers where a file
/// is, and whether it may be handed to the system.
public enum InboxReceivedFileAccess {

    /// Where one received file stands right now.
    public enum Availability: Equatable, Sendable {
        /// On disk, a readable regular file inside the receive folder.
        case available(URL)
        /// Not there any more — deleted, moved, or replaced by a folder.
        case missing
        /// Its recorded location cannot be mapped into the receive folder, or it
        /// resolves outside it. Never opened.
        case refused
    }

    /// One file of a received delivery.
    public struct File: Equatable, Sendable, Identifiable {
        /// Position in the delivery's own file list.
        public let id: Int
        public let displayName: String
        /// Where it sits inside the receive folder, forward-slash separated, or
        /// nil when the recorded path could not be mapped. A value with a `/` in
        /// it is a file that arrived inside a folder.
        public let relativePath: String?
        public let availability: Availability

        public var url: URL? {
            if case let .available(url) = availability { return url }
            return nil
        }
    }

    /// The part of a recorded path below the receive folder, validated.
    ///
    /// Two ways to find it, tried in order:
    ///  1. the recorded path is under the folder as resolved now — the ordinary
    ///     case, and the only one a non-container folder can take;
    ///  2. the container moved: the recorded path is re-rooted at the FIRST
    ///     occurrence of the folder's last two components (`Documents/Received`
    ///     in the product), which is where the old container's prefix ends.
    ///
    /// Either way the remainder must be a plain relative path — no empty,
    /// `.` or `..` component and no NUL — before anything is built from it.
    /// Containment is checked again after symbolic links are resolved, in
    /// `locate`, because a well-formed name can still be a link.
    public static func relativePath(ofRecorded recorded: String,
                                    in receiveFolder: URL) -> String? {
        let folderPaths = [receiveFolder.standardizedFileURL.path,
                           receiveFolder.resolvingSymlinksInPath().standardizedFileURL.path]
        var remainder: String?
        for folder in folderPaths where !folder.isEmpty {
            let prefix = folder.hasSuffix("/") ? folder : folder + "/"
            if recorded.hasPrefix(prefix) {
                remainder = String(recorded.dropFirst(prefix.count))
                break
            }
        }
        if remainder == nil {
            let leaf = receiveFolder.standardizedFileURL
            let parent = leaf.deletingLastPathComponent().lastPathComponent
            let marker = "/" + parent + "/" + leaf.lastPathComponent + "/"
            if !parent.isEmpty, parent != "/", let range = recorded.range(of: marker) {
                remainder = String(recorded[range.upperBound...])
            }
        }
        guard let relative = remainder, !relative.isEmpty,
              !relative.hasPrefix("/"), !relative.contains("\u{0}") else { return nil }
        let components = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            return nil
        }
        return relative
    }

    /// Where one recorded file is now.
    public static func locate(_ reference: InboxTimelineEntry.FileReference,
                              in receiveFolder: URL,
                              fileManager: FileManager = .default) -> Availability {
        guard let relative = relativePath(ofRecorded: reference.urlPath, in: receiveFolder) else {
            return .refused
        }
        let candidate = receiveFolder.appendingPathComponent(relative, isDirectory: false)
        // Existence first: `resolvingSymlinksInPath` keeps a `/private` prefix
        // for a path that does not exist, which would turn an honest "missing"
        // into a false "refused". `fileExists` follows links, so a dangling one
        // is missing too.
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else {
            return .missing
        }
        let root = receiveFolder.resolvingSymlinksInPath().standardizedFileURL.path
        let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
        guard resolved.path.hasPrefix(root.hasSuffix("/") ? root : root + "/") else {
            return .refused
        }
        // A folder where a file was is not the file that was received.
        guard !isDirectory.boolValue,
              fileManager.isReadableFile(atPath: resolved.path) else { return .missing }
        return .available(resolved)
    }

    /// Every file of one received delivery. An outgoing or message entry has no
    /// received file and answers with none.
    public static func files(of entry: InboxTimelineEntry,
                             in receiveFolder: URL,
                             fileManager: FileManager = .default) -> [File] {
        guard entry.direction == .received, entry.kind == .files else { return [] }
        return entry.files.enumerated().map { index, reference in
            File(id: index,
                 displayName: reference.displayName,
                 relativePath: relativePath(ofRecorded: reference.urlPath, in: receiveFolder),
                 availability: locate(reference, in: receiveFolder, fileManager: fileManager))
        }
    }
}

/// **The one received entry an action is about, as the current account sees it.**
///
/// Built from live controller state at the moment it is asked for — never
/// stored by a view — so "is this still that account's file?" has one answer.
public struct InboxReceivedFileScope: Equatable, Sendable {
    public let accountID: String
    public let entry: InboxTimelineEntry

    public init(accountID: String, entry: InboxTimelineEntry) {
        self.accountID = accountID
        self.entry = entry
    }

    /// The scope, or nil when there is no signed-in account, the entry is not in
    /// that account's conversation with `peerDeviceID`, it was deleted locally,
    /// or it is not a received files row.
    public static func current(accountID: String?,
                               conversations: [InboxConversation],
                               deletedTimelineIDs: Set<String>,
                               peerDeviceID: String,
                               entryID: String) -> InboxReceivedFileScope? {
        guard let accountID, !accountID.isEmpty,
              !deletedTimelineIDs.contains(entryID),
              let entry = conversations.first(where: { $0.peerDeviceID == peerDeviceID })?
                .entries.first(where: { $0.id == entryID }),
              entry.direction == .received, entry.kind == .files,
              !entry.files.isEmpty else { return nil }
        return InboxReceivedFileScope(accountID: accountID, entry: entry)
    }

    /// Whether two scopes are the same account's same delivery. Deliberately
    /// narrower than `==`: marking a row read changes the entry, and a lookup
    /// must not be dropped because the page that started it also marked it read.
    public func isSameDelivery(as other: InboxReceivedFileScope) -> Bool {
        accountID == other.accountID && entry.id == other.entry.id
            && entry.files == other.entry.files
    }
}

@MainActor
public extension InboxController {
    /// `InboxReceivedFileScope.current`, read from this controller's live state.
    func receivedFileScope(peerDeviceID: String, entryID: String) -> InboxReceivedFileScope? {
        InboxReceivedFileScope.current(accountID: activeAccountID,
                                       conversations: conversations,
                                       deletedTimelineIDs: deletedTimelineIDs,
                                       peerDeviceID: peerDeviceID,
                                       entryID: entryID)
    }
}

/// What the user asked to do with a received delivery's files.
public enum InboxReceivedFileAction: String, Sendable, CaseIterable {
    /// Preview in the system viewer.
    case open
    /// The system share sheet.
    case share
    /// A copy into a place the user picks in the Files browser.
    case export
}

/// One approved hand-off to the system: these URLs, for this action, on behalf
/// of this account's entry. `id` is fresh per request, so a presenter can tell a
/// new request from the one it is already showing.
public struct InboxReceivedFileRequest: Equatable, Sendable, Identifiable {
    public let id: UUID
    public let action: InboxReceivedFileAction
    public let accountID: String
    public let entryID: String
    public let urls: [URL]
}

/// **The page-side owner of received-file actions and of what each row shows.**
///
/// Both jobs touch the disk, so both run off the main actor, and both publish
/// only after re-checking — on the main actor, against live state — that the
/// account and the entry they started from are still the current ones. A
/// generation counter drops every result that an account change, a newer
/// request or `invalidate` has overtaken.
///
/// The receive folder is passed in on every call rather than resolved here: the
/// caller reads the one the Device Inbox controller resolved for the current
/// account (`InboxController.folder.url`), so this never becomes a second
/// resolver that could disagree with where deliveries are actually written.
@MainActor
public final class InboxReceivedFileAccessModel: ObservableObject {

    public typealias Locate = @Sendable (InboxTimelineEntry, URL) -> [InboxReceivedFileAccess.File]

    /// What a row can show about its files, by entry id. Absent until checked.
    @Published public private(set) var files: [String: [InboxReceivedFileAccess.File]] = [:]
    /// The approved hand-off being presented, or nil.
    @Published public private(set) var request: InboxReceivedFileRequest?
    /// The entry whose last request found nothing it could hand over.
    @Published public private(set) var unavailableEntryID: String?

    /// The disk lookup. A seam so a test can hold a lookup in flight while it
    /// moves the account underneath it; the product uses the real one.
    private let locate: Locate
    private var generation = 0
    /// The account the published `files` describe.
    private var filesAccountID: String?

    public init(locate: @escaping Locate = { entry, folder in
        InboxReceivedFileAccess.files(of: entry, in: folder)
    }) {
        self.locate = locate
    }

    /// Re-check what each of these entries' files looks like on disk now.
    ///
    /// `scope` is asked again when the answer lands, per entry; an entry that is
    /// no longer the current account's same delivery is dropped rather than
    /// described.
    public func refresh(entryIDs: [String], receiveFolder: URL?,
                        scope: @escaping @MainActor (String) -> InboxReceivedFileScope?) {
        let scopes = entryIDs.compactMap(scope)
        let account = scopes.first?.accountID
        if account != filesAccountID {
            files = [:]
            filesAccountID = account
        }
        guard !scopes.isEmpty, let receiveFolder else { return }
        generation += 1
        let g = generation
        let locate = self.locate
        Task { [weak self] in
            let resolved = await Task.detached(priority: .userInitiated) {
                () -> [String: [InboxReceivedFileAccess.File]] in
                var out: [String: [InboxReceivedFileAccess.File]] = [:]
                for s in scopes { out[s.entry.id] = locate(s.entry, receiveFolder) }
                return out
            }.value
            guard let self, g == self.generation else { return }
            var next = self.files
            for (entryID, value) in resolved {
                guard let now = scope(entryID),
                      scopes.contains(where: { $0.isSameDelivery(as: now) }) else {
                    next[entryID] = nil
                    continue
                }
                next[entryID] = value
            }
            self.files = next
        }
    }

    /// Ask to hand one entry's files to the system.
    ///
    /// The files are located again NOW, not taken from what the row last showed,
    /// and the request is published only if `scope` still answers the same
    /// account and the same delivery when that lookup finishes.
    public func begin(_ action: InboxReceivedFileAction, entryID: String, receiveFolder: URL?,
                      scope: @escaping @MainActor (String) -> InboxReceivedFileScope?) {
        request = nil
        unavailableEntryID = nil
        guard let start = scope(entryID) else { return }
        generation += 1
        guard let receiveFolder else {
            unavailableEntryID = entryID
            return
        }
        let g = generation
        let locate = self.locate
        Task { [weak self] in
            let located = await Task.detached(priority: .userInitiated) {
                locate(start.entry, receiveFolder)
            }.value
            guard let self, g == self.generation else { return }
            // The whole guard against an old callback: the answer is about the
            // account and the delivery the tap was about, or it is dropped.
            guard let now = scope(entryID), now.isSameDelivery(as: start) else { return }
            if start.accountID != self.filesAccountID {
                self.files = [:]
                self.filesAccountID = start.accountID
            }
            self.files[entryID] = located
            let urls = located.compactMap(\.url)
            guard !urls.isEmpty else {
                self.unavailableEntryID = entryID
                return
            }
            self.request = InboxReceivedFileRequest(id: UUID(), action: action,
                                                    accountID: start.accountID,
                                                    entryID: entryID, urls: urls)
        }
    }

    /// The presenter finished — dismissed, completed or cancelled.
    public func finish(_ id: UUID) {
        if request?.id == id { request = nil }
    }

    /// Re-check the presented request against live state, and drop it — and
    /// every in-flight lookup — if its account or entry is gone. Called whenever
    /// the account or the conversations change.
    public func invalidate(scope: @MainActor (String) -> InboxReceivedFileScope?,
                           accountID: String?) {
        if let request {
            let now = scope(request.entryID)
            if now == nil || now?.accountID != request.accountID {
                generation += 1
                self.request = nil
            }
        }
        if accountID != filesAccountID {
            generation += 1
            files = [:]
            filesAccountID = accountID
            unavailableEntryID = nil
        }
    }

    /// Drop everything in flight or presented: the page is going away.
    public func reset() {
        generation += 1
        request = nil
        unavailableEntryID = nil
    }
}
