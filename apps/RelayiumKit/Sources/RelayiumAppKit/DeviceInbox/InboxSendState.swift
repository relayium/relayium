import Foundation
import RelayiumKit

/// The vocabulary the sender's product surface is written against.
///
/// Everything here is pure — no network, no storage, no clock — for the reason
/// `InboxSendTarget.swift` gives about eligibility: the interesting decisions
/// are "what may this say" and "what may this offer", and both have to be
/// assertable without a server, a keychain or a view.
///
/// **The rule the whole file exists to enforce** is that an upload is not a
/// delivery. The sender knows three things about a send — that bytes are being
/// staged here, that ciphertext is going up, and that central then owns a task —
/// and only the third can ever produce the word *saved*. `InboxSendActivity`
/// keeps the local phases and the remote state in separate cases so no branch
/// can reach `saved` without a target device having reported it.

/// One device on the account, as the picker must describe it.
///
/// It carries no key material. `InboxSendTarget` — which does — is produced
/// inside `InboxSendModel` at the moment of sending, from the row central just
/// answered with. A picker that held a public key would be one more place a
/// rotation could go stale, and the seal has to use the CURRENT key.
public struct InboxSendCandidate: Identifiable, Equatable, Sendable {
    public let id: String
    /// The name the account gave this device. Rendered only — it is never
    /// composed into a request path; `id` is, and central checks it.
    public let name: String
    /// `mac`, `cli`, `app`: central's own label, rendered as a detail so a user
    /// with two similarly named devices can tell them apart.
    public let kind: String
    public let availability: InboxTargetAvailability
    /// Whether offering this device a TEXT send would be honest — it announces
    /// `inbox.text.v1`, so a message arrives somewhere a person can read it.
    ///
    /// Carried on the candidate rather than derived at the composer, because the
    /// device rows this is read from are private to `InboxSendModel` — a seal
    /// must use the target's CURRENT key, so no key material leaves that model
    /// and no surface holds a row. A composer that could not ask this question
    /// would have to offer text to every device and discover the refusal after
    /// the user had written the message.
    ///
    /// Deliberately separate from `isSendable`: a receiver without the token is
    /// a perfectly good FILE target — the CLI, iOS and the headless receiver
    /// among them — so this gates the message composer and nothing else.
    /// `false` on a blocked row, because `InboxTargetEligibility.canReceiveText`
    /// requires the general verdict first.
    public let canReceiveText: Bool

    public init(id: String, name: String, kind: String,
                availability: InboxTargetAvailability,
                canReceiveText: Bool = false) {
        self.id = id
        self.name = name
        self.kind = kind
        self.availability = availability
        self.canReceiveText = canReceiveText
    }

    public var isSendable: Bool { availability.sendable }

    /// Every device that may be OFFERED — sendable or not.
    ///
    /// Blocked rows are kept rather than filtered out, which is the whole point
    /// of the PRD's "truthful target list": a device whose owner turned
    /// receiving off is a device the user is looking for, and dropping it from
    /// the list turns a two-second fix into "Relayium cannot see my Mac".
    ///
    /// The CURRENT device is excluded from both halves. Sending a file to the
    /// phone in your hand is not what this feature does, and listing it as
    /// blocked would invite somebody to go and fix something that is not broken.
    public static func candidates(from rows: [InboxDeviceRow]) -> [InboxSendCandidate] {
        rows.filter { !$0.isCurrent }.map { row in
            InboxSendCandidate(id: row.id, name: row.name, kind: row.kind,
                               availability: InboxTargetEligibility.availability(for: row),
                               // The same predicate the send path re-checks
                               // against a fresh device read, asked once here so
                               // the composer can be honest before anything is
                               // typed. It is never the authority: `sendText`
                               // and the coordinator both ask again.
                               canReceiveText: InboxTargetEligibility.canReceiveText(row))
        }
    }
}

/// Whether the account's device list has been read, and what came back.
///
/// `unavailable` is a distinct case from an empty `loaded` for the reason every
/// closed set in this feature is closed: "you have no device that can receive"
/// and "we could not ask" have different remedies, and collapsing them tells a
/// user with a perfectly good Mac to go and set one up.
public enum InboxSendDirectory: Equatable, Sendable {
    /// Nothing has been asked yet. Not an error, and not an empty list.
    case idle
    case loading
    case loaded
    case unavailable(InboxSendDirectoryFailure)
}

public enum InboxSendDirectoryFailure: Equatable, Sendable {
    /// The credential was rejected. The remedy is the account, not the network.
    case notAuthorized
    /// Central could not be reached, or answered in a shape this build refuses.
    case unreachable
}

/// What one send is doing, as the only thing a surface may claim about it.
///
/// The order below is the order a send moves through, and the split between the
/// first three and `tracking` is the product invariant: `preparing`,
/// `uploading` and `creating` are all assertions about THIS device, and none of
/// them may be rendered as an arrival. `tracking` carries central's own state,
/// which is the only authority on whether the target saved anything.
public enum InboxSendActivity: Equatable, Sendable {
    /// The bytes are staged here under a durable plan and nothing has left this
    /// device. Reached by a recovered plan and by an attempt the user stopped.
    case staged
    /// Copying the selection into this app's own storage.
    case preparing
    /// The ciphertext is going up. **Never** an arrival: completing this is
    /// completing an upload, and the target has not been told anything yet.
    case uploading(sent: Int, total: Int)
    /// The ciphertext is up and the delivery is being created.
    case creating
    /// Central holds a task, in the state central reports.
    case tracking(InboxTaskState)
    /// Nobody knows whether a delivery exists. NOTHING has been released.
    case unknown
    /// This attempt stopped for a named reason.
    case stopped(InboxSendFailure)

    /// Whether this device is currently doing work that a stop would interrupt.
    public var isRunning: Bool {
        switch self {
        case .preparing, .uploading, .creating: return true
        case .staged, .tracking, .unknown, .stopped: return false
        }
    }

    /// The one predicate allowed to answer "has it arrived".
    ///
    /// A single computed property rather than a `case .saved` at each call site:
    /// the mistake this feature cannot make is a surface deciding for itself
    /// that a finished upload counts, and one definition is one place to read.
    public var isSavedOnTarget: Bool {
        if case .tracking(.saved) = self { return true }
        return false
    }
}

/// One send the user can see and act on.
///
/// Identified by the JOB, not by the task: a job exists before any task does,
/// and keeping the identity stable across the create is what stops a card
/// disappearing and reappearing as a different one at the exact moment the user
/// is watching it.
public struct InboxSendItem: Identifiable, Equatable, Sendable {
    public let id: String
    /// What is actually in this delivery, by safe manifest identity.
    ///
    /// Carried rather than summarized because a recovered plan offers **Send** —
    /// a first send, days later, of files chosen in a session the user does not
    /// remember. "3 files · 1.2 MB" is not enough to decide that, and it is the
    /// same reason every other send surface in this app lists names and sizes
    /// before the button. Names come from the plan's own manifest, which is
    /// already sanitized; no staged URL and no container path is here.
    public let files: [FileMeta]
    public let fileCount: Int
    public let byteCount: Int
    public let targetDeviceID: String
    /// nil until the device list has been read at least once. A recovered plan
    /// records the device ID and deliberately not its name — a name is central's
    /// to change — so the surface says "a device on your account" until it knows.
    public let targetName: String?
    public let activity: InboxSendActivity
    /// Central's task, once one definitively exists.
    public let taskID: String?
    /// Central's own `SavedAt`, and the only source of an arrival time.
    public let savedAt: Int64
    public let expiresAt: Int64
    /// Whether a durable plan for this job is still on disk. It is what decides
    /// whether Retry and Discard mean anything: a plan the coordinator already
    /// released cannot be retried, and offering to discard it would be a button
    /// that deletes nothing.
    public let isRecoverable: Bool

    public init(id: String, files: [FileMeta] = [], fileCount: Int, byteCount: Int,
                targetDeviceID: String,
                targetName: String?, activity: InboxSendActivity, taskID: String?,
                savedAt: Int64, expiresAt: Int64, isRecoverable: Bool) {
        self.id = id
        self.files = files
        self.fileCount = fileCount
        self.byteCount = byteCount
        self.targetDeviceID = targetDeviceID
        self.targetName = targetName
        self.activity = activity
        self.taskID = taskID
        self.savedAt = savedAt
        self.expiresAt = expiresAt
        self.isRecoverable = isRecoverable
    }
}

/// What a user may do about one send.
///
/// Closed, and one case per distinct consequence — because three of them touch
/// the user's only local copy of their files or a delivery that may be live, and
/// a surface that offered the wrong one would look identical.
public enum InboxSendAction: String, Equatable, Sendable, CaseIterable {
    /// Start a staged delivery that has never been attempted.
    case send
    /// Attempt the same plan again, under the SAME idempotency key.
    case retry
    /// End the attempt running right now. The durable plan survives.
    case stopAttempt
    /// Ask central to cancel the queued delivery. Refused while a device holds a
    /// live claim, and a refusal is reported rather than swallowed.
    case cancelDelivery
    /// Abandon the staged delivery and release what is safe to release.
    case discard
    /// Stop showing a finished send. Removes nothing anywhere.
    case dismiss
}

public enum InboxSendActions {

    /// What to offer for one send, most consequential last.
    ///
    /// Derived from what is actually true — is work running, is a plan still on
    /// disk, can central still be asked to cancel — rather than from a table
    /// keyed on the failure. That matters because `InboxSendCoordinator` decides
    /// per failure whether it released anything, and a second table here would
    /// be a copy of that decision that can drift out of step with it.
    public static func offered(for item: InboxSendItem) -> [InboxSendAction] {
        switch item.activity {
        case .preparing, .uploading, .creating:
            return [.stopAttempt]
        case .staged:
            return [.send, .discard]
        case .stopped(.contentKeyMissing):
            // The staged plaintext is intentionally preserved because it may
            // be the last copy Relayium holds, but the missing content key can
            // never be reconstructed. Offering Retry would only repeat the
            // same refusal. Keep the one honest recovery: let the user decide
            // when to discard the preserved local copy.
            return item.isRecoverable ? [.discard] : [.dismiss]
        case .stopped, .unknown:
            // A plan the coordinator released is gone: retrying it would stage
            // nothing and discarding it would delete nothing.
            return item.isRecoverable ? [.retry, .discard] : [.dismiss]
        case .tracking(let state):
            if state.isTerminal { return [.dismiss] }
            // `downloading` and `verifying` are deliberately absent: central
            // refuses a cancel while a device holds the claim, so offering one
            // would be a control whose only outcome is an error message.
            switch state {
            case .queued, .notified, .attentionRequired, .failedRetryable:
                return [.cancelDelivery]
            case .downloading, .verifying:
                return []
            case .saved, .expired, .revoked, .failedTerminal:
                return [.dismiss]                       // unreachable: terminal above
            }
        }
    }

    /// The one control that STOPS what is happening to this send right now, or
    /// nil when nothing is happening that could be stopped.
    ///
    /// Derived from `offered(for:)` rather than from a second `switch` over the
    /// activity, which is the same rule that function follows about the failure
    /// table: a surface that decided for itself which cancel applied would be a
    /// copy of this decision able to drift out of step with it — and the two
    /// answers are not interchangeable. `stopAttempt` ends work on THIS device
    /// and touches nothing durable; `cancelDelivery` asks central to drop a
    /// delivery that may be one moment from landing, and central refuses it
    /// while the target holds a live claim.
    ///
    /// The order is deliberate: while an attempt is running there is no task to
    /// cancel yet, and `offered(for:)` never returns both.
    public static func cancel(for item: InboxSendItem) -> InboxSendAction? {
        let offered = offered(for: item)
        if offered.contains(.stopAttempt) { return .stopAttempt }
        if offered.contains(.cancelDelivery) { return .cancelDelivery }
        return nil
    }

    /// The newest send aimed at one device, or nil.
    ///
    /// `items` is newest-first from `InboxSendModel.publish()`, so the first
    /// match is the one a per-device screen is about. It is a lookup rather than
    /// a second list: the model owns every send this account has, and a surface
    /// bound to one device asks which of them is this device's rather than
    /// keeping its own.
    public static func current(in items: [InboxSendItem],
                               for deviceID: String) -> InboxSendItem? {
        items.first { $0.targetDeviceID == deviceID }
    }

    /// Whether this action needs the user to be warned that a delivery it cannot
    /// see may still arrive.
    ///
    /// True for exactly one combination, and it is the honest one: discarding a
    /// send whose create outcome is UNKNOWN. Nothing local is lost that matters
    /// — the account's own ciphertext stays reachable only through a task, and a
    /// device-task object is not deletable through the generic file route — but
    /// a delivery may already exist, and the user has to be told before they
    /// stop being able to watch it.
    public static func warnsDeliveryMayStillArrive(_ action: InboxSendAction,
                                                   for item: InboxSendItem) -> Bool {
        guard action == .discard else { return false }
        if case .unknown = item.activity { return true }
        if case .stopped(.unknownOutcome) = item.activity { return true }
        if case .stopped(.recoveryStateWriteFailed) = item.activity { return true }
        return false
    }
}

/// An action the user took that did not do what it said.
///
/// Separate from `InboxSendRefusal` because these happen AFTER a request left
/// this device: a cancel central refused means a delivery is still live, and the
/// one thing the surface must not do is quietly remove the card for it.
public enum InboxSendActionError: Equatable, Sendable {
    /// Central would not cancel — normally because the target device already
    /// holds a claim on the delivery.
    case cancelRefused(itemID: String)

    public var itemID: String {
        switch self {
        case .cancelRefused(let id): return id
        }
    }
}

/// Why a send could not be started, as a closed set.
///
/// None of these is a server answer: each is something this device can see
/// before a byte moves, which is exactly why they are separate from
/// `InboxSendFailure`.
public enum InboxSendRefusal: Error, Equatable, Sendable {
    /// Nothing is selected.
    case noSelection
    /// No device has been chosen yet.
    case noTargetChosen
    /// The chosen device is no longer a legal destination.
    case targetUnavailable(InboxTargetBlock)
    /// The account is not ready, or its credential is empty.
    case notSignedIn
    /// The selection could not be copied into this app's own storage.
    case stagingFailed
    /// The content key could not be filed, so the delivery could never be
    /// opened. The staged job is removed rather than left pretending.
    case keyStorageFailed
    /// A send for this selection is already running.
    case alreadySending
    /// There is no message to send. An empty message is not a message: a
    /// receiver asked to commit one would have to invent something to show.
    case messageEmpty
    /// The message is longer than this protocol carries (64 KiB of UTF-8).
    case messageTooLong
    /// The chosen device does not announce `inbox.text.v1`, so it would not
    /// present a message AS a message. Refused before anything is staged, and
    /// applying to messages only — a file send never consults the token.
    case textUnsupported
}

// MARK: - what one send is made of

/// What one delivery to a device may be, as a closed set.
///
/// **One send is one kind, and there are exactly two.** It mirrors the wire —
/// `InboxManifest` carries file items or one text item and refuses a mixed
/// document outright — so a composer offering a message with an attachment could
/// only ever produce a delivery no receiver accepts. The surface therefore gives
/// each kind its own group with its own Send, and there is no control anywhere
/// that could combine them.
///
/// Choosing FILES and choosing a FOLDER are two actions and one kind: both stage
/// into the same batch and produce the same delivery, and a folder keeps its
/// hierarchy inside the seal because `expandSelection` records each file's
/// relative path. They are separate buttons because `NSOpenPanel` has to be told
/// whether a file is a legal choice — not separate kinds.
public enum InboxSendContentKind: String, Equatable, Sendable, CaseIterable {
    case message
    case files

    /// Whether this kind needs the target to announce `inbox.text.v1`.
    ///
    /// True for exactly one of them, which is the whole capability split: a
    /// receiver without the token is a perfectly good FILE target — the CLI, iOS
    /// and the headless receiver among them — so requiring it of files would
    /// refuse ordinary deliveries to every build that renders no messages.
    public var needsTextCapability: Bool { self == .message }
}

/// A message being written, measured the way the protocol measures it.
///
/// **Bytes, not characters, and that is the whole reason this type exists.**
/// `InboxSendModel.sendText` bounds the message in UTF-8 bytes because that is
/// what the manifest declares and what the receiver re-measures — so a composer
/// counting `String.count` would let a screenful of emoji past its own check and
/// hand the user a refusal after they had written the message. One emoji is four
/// bytes; 16,384 of them are exactly the limit this type reports and the limit
/// `String.count` would have said was a quarter spent.
///
/// Pure, and holding no text: it is constructed from the draft and answers three
/// questions about it. The message itself never leaves the composer except as the
/// argument to `sendText`, so nothing here can put a body in a published property.
public struct InboxTextDraft: Equatable, Sendable {
    /// The exact number of UTF-8 bytes the manifest would declare.
    public let byteCount: Int

    public init(_ text: String) {
        byteCount = text.utf8.count
    }

    /// Nothing to send. An empty message is not a message: a receiver asked to
    /// commit one would have to invent something to show.
    public var isEmpty: Bool { byteCount < InboxManifest.minTextBytes }
    public var isTooLong: Bool { byteCount > InboxManifest.maxTextBytes }
    /// The exact precondition `sendText` applies, asked before the button is
    /// enabled rather than after it is pressed.
    public var isSendable: Bool { !isEmpty && !isTooLong }
    /// How far over the limit, for the sentence that says so. Zero when within.
    public var overflowBytes: Int { max(byteCount - InboxManifest.maxTextBytes, 0) }
}

/// How a device's own send screen is laid out.
public enum InboxSendComposer {

    /// Both kinds, in the order this device's screen stacks them.
    ///
    /// **A dead end never leads.** A device that does not announce
    /// `inbox.text.v1` still shows its message group — with the reason, because
    /// a control that is simply absent teaches nobody why — but it shows it
    /// BELOW the files, so the first thing on the screen is the thing that
    /// works. A device that does announce it leads with the message, which is
    /// the cheapest thing a person opens a per-device screen to do.
    ///
    /// Neither kind is ever dropped: hiding the message composer on a CLI target
    /// would leave a user believing this build cannot send messages at all,
    /// which is the opposite of the truth.
    ///
    /// It is a function rather than a layout decision inside the view so
    /// `swift test` can assert both orders without one — the same reason every
    /// other decision on this screen lives outside it.
    public static func order(canReceiveText: Bool) -> [InboxSendContentKind] {
        canReceiveText ? [.message, .files] : [.files, .message]
    }
}
