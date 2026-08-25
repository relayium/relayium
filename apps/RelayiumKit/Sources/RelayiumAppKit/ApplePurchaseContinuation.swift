import Foundation
import RelayiumKit

/// **The client half of the Apple purchase-cancellation recovery protocol.**
///
/// The problem it exists for: before this protocol, a user who opened a StoreKit
/// sheet and pressed Cancel could never buy again. The server had armed one
/// dispatch for the authority generation, nothing resolved it, and every later
/// attempt got `409 purchase_reconciliation_required` for ever. A zero-charge
/// permanent deadlock.
///
/// The fix is a **capability**: the client mints and durably stores a 32-byte
/// secret before the initial arm; the server stores only its digest, and the
/// client presents the secret to say "the sheet *I* armed was cancelled — let
/// me open another". Older clients that do not pre-mint one remain compatible
/// with the server-generated, first-response-only form.
///
/// ## What this file is, and what it deliberately is not
///
/// Everything here is **pure value logic over one persisted struct**. There is
/// no networking, no StoreKit, no Keychain access and no clock. That is what
/// lets the rules below — which are money rules — be driven exhaustively by
/// tests instead of being reasoned about inside an `async` method nothing can
/// reach.
///
/// ## The rules, and why each one is load-bearing
///
///  1. **Only an explicit `.userCancelled` is resumable.** `pending`, a thrown
///     store error, an unrecognised result and *no report at all* leave the
///     attempt locked. None of them proves Apple will not charge, and turning
///     any of them into a cancellation authorizes a second sheet over a live
///     one — a double charge.
///  2. **Every logical sheet gets a fresh arm identity**, and an identity is
///     spent once ever. It is what makes an outcome report a statement about one
///     *sheet* rather than about one *client*: the attempt, the instance and the
///     secret all survive a resume unchanged, so without it a duplicate report
///     issued before a resume would still authenticate and could move a live
///     armed attempt back to cancelled.
///  3. **A report is bound to the arm that is open.** A completion or
///     cancellation belonging to an earlier arm is dropped rather than applied —
///     see ``applying(_:to:forArm:serverResumable:)``, which returns `nil` for
///     exactly that.
///  4. **A resume intent is recorded before it is sent.** Without that, a lost
///     resume response is a permanent deadlock: the server would be armed under
///     an identity the client never learned, so it could neither report that
///     arm's outcome nor mint a new one the server would accept.
///  5. **An outcome report is recorded before it is sent, too, and for the same
///     reason — except that for a cancellation the deadlock is worse.** A
///     completed purchase carries a signed transaction, so a lost report still
///     converges: the store redelivers the JWS and reconciliation resolves the
///     attempt. **A cancellation carries nothing.** Apple signs transactions,
///     never their absence, so there is no JWS for `Transaction.updates` or
///     `restore` to redeliver and *nothing whatsoever* converges an
///     unreported cancellation. Without a durable record, one dropped packet
///     between this client and `purchase-outcome` leaves the phase at `armed`
///     for ever and every later purchase is refused — the exact zero-charge
///     lockout this protocol was built to remove, reintroduced by a transient
///     failure. The record is what makes the report **replayable**, and the
///     server's own `RecordAppleBillingPurchaseOutcome` admits
///     `continuation_state IN (armed, cancelled)` at read time and repeats it as
///     a write-time predicate, so replaying the same report for the same arm is
///     idempotent rather than a second arming.
///  6. **Nothing here expires.** There is no TTL, no clock and no automatic
///     release. A capability is retired on authoritative convergence — the
///     server saying the attempt is resolved — and on nothing else. A
///     time-based release would re-create the double-charge window on a device
///     whose clock is wrong.
///
/// The secret's storage rules live with ``ApplePurchaseCapabilityStoring``.

// MARK: - the persisted capability

/// One arming of one purchase attempt, as this device remembers it.
///
/// **This whole value is secret-bearing** and goes to the Keychain as one item.
/// It is not split across `UserDefaults` and the Keychain: the non-secret half
/// would then be a durable record of what the user tried to buy, in a file any
/// backup copies, for no benefit.
public struct ApplePurchaseCapability: Equatable, Codable, Sendable {
    /// Where the *server* believes this attempt is, as far as this client knows.
    public enum Phase: String, Codable, Sendable, CaseIterable {
        /// The client has durably prepared the initial capability, but has not
        /// yet received the server's attempt id. Replaying this value sends the
        /// same product, arm and secret; it never creates a second logical arm.
        case preparing
        /// A sheet is authorized for ``armRequestID``/``productID``. Not
        /// resumable: either it is open right now, or this process died while it
        /// was and nobody knows what StoreKit did.
        case armed
        /// An explicit `.userCancelled` was reported *for the arm that was
        /// open*. The one resumable state.
        case cancelled
        /// A terminal outcome was reported — `pending`, `failed` or `success`.
        /// Never resumable, and a later report can never move it back.
        case locked
    }

    /// The server's authoritative attempt id. It is stable while the server is
    /// resuming the same unresolved attempt. If this installation holds a stale
    /// cancelled capability whose attempt another installation already resolved,
    /// the next dispatch may create a replacement attempt; the returned id must
    /// then replace this value before StoreKit opens.
    public let attemptID: String
    /// Relayium account that prepared this capability. Optional only so a
    /// pre-field compatibility fixture still decodes; strict production policy
    /// refuses an absent or different owner rather than guessing.
    public let ownerAccountID: String?
    /// Stable for the life of this installation.
    public let appInstanceID: String
    /// **The raw 32-byte capability secret.** Current clients persist it before
    /// the initial request, so initial and resume responses are both replayable.
    /// It is never stored by the server in raw form.
    public let secret: String
    /// The arm identity currently believed open (or last opened).
    public var armRequestID: String
    /// The product that arm was authorized for. It moves on a cross-product
    /// resume, in the same server statement as the arm id.
    public var productID: String
    public var phase: Phase
    /// A resume that was **sent** and whose response was never seen.
    ///
    /// Recorded before the request goes out. While it is set, this client must
    /// replay exactly this arm and product rather than mint a new identity — see
    /// rule 4 above.
    public var unconfirmedResume: ApplePurchaseResumeIntent?
    /// An outcome report that was **recorded** and whose delivery was never
    /// confirmed. See rule 5 above.
    ///
    /// Written before the request goes out and cleared only by the server's own
    /// answer. While it names the arm that is open, this client must replay
    /// exactly this report before it may plan anything at all — which is what
    /// gives a lost cancellation a way back, given that no JWS exists to
    /// reconcile it with.
    ///
    /// It is **mutually exclusive with `unconfirmedResume` by construction**: a
    /// report is only ever recorded for an arm the server has confirmed, and
    /// confirming an arm discharges the resume. ``plan(capability:productID:appInstanceID:freshArmRequestID:)``
    /// still orders them, so a value corrupted or written by some other build
    /// converges instead of deadlocking.
    public var unconfirmedOutcome: ApplePurchaseOutcomeIntent?

    public init(attemptID: String, ownerAccountID: String? = nil,
                appInstanceID: String, secret: String,
                armRequestID: String, productID: String,
                phase: Phase, unconfirmedResume: ApplePurchaseResumeIntent? = nil,
                unconfirmedOutcome: ApplePurchaseOutcomeIntent? = nil) {
        self.attemptID = attemptID
        self.ownerAccountID = ownerAccountID
        self.appInstanceID = appInstanceID
        self.secret = secret
        self.armRequestID = armRequestID
        self.productID = productID
        self.phase = phase
        self.unconfirmedResume = unconfirmedResume
        self.unconfirmedOutcome = unconfirmedOutcome
    }

    /// The wire half, for a request about the arm that is open.
    public var fields: ApplePurchaseContinuationFields {
        ApplePurchaseContinuationFields(appInstanceID: appInstanceID,
                                        armRequestID: armRequestID,
                                        continuationSecret: secret)
    }

    /// The wire half for a *named* arm, which is not always the stored one: a
    /// resume presents the arm it is asking for, not the one it is leaving.
    public func fields(forArm arm: String) -> ApplePurchaseContinuationFields {
        ApplePurchaseContinuationFields(appInstanceID: appInstanceID,
                                        armRequestID: arm,
                                        continuationSecret: secret)
    }
}

extension ApplePurchaseCapability: CustomStringConvertible, CustomDebugStringConvertible {
    /// **Never the secret**, and this is the reason the conformance is written
    /// out rather than synthesized. A capability is carried through error paths
    /// and test failure messages, and Swift's default description of a struct
    /// prints every stored property — which would put a live capability into
    /// whatever printed it.
    public var description: String {
        // nonlocalized: a build diagnostic, never rendered to a user
        "ApplePurchaseCapability(attemptID: \(attemptID), ownerAccountID: <bound>, appInstanceID: \(appInstanceID), "
            // nonlocalized: a build diagnostic, never rendered to a user
            + "armRequestID: \(armRequestID), productID: \(productID), phase: \(phase.rawValue), "
            + "unconfirmedResume: \(unconfirmedResume.map(String.init(describing:)) ?? "nil"), "
            // nonlocalized: a build diagnostic, never rendered to a user
            + "unconfirmedOutcome: \(unconfirmedOutcome.map(String.init(describing:)) ?? "nil"), "
            // nonlocalized: a build diagnostic, never rendered to a user
            + "secret: <redacted>)"
    }
    public var debugDescription: String { description }
}

/// A resume this client has sent and not yet had answered.
public struct ApplePurchaseResumeIntent: Equatable, Codable, Sendable {
    public let armRequestID: String
    public let productID: String
    public init(armRequestID: String, productID: String) {
        self.armRequestID = armRequestID
        self.productID = productID
    }
}

/// An outcome report this client has recorded and not yet had answered.
///
/// It carries the arm and the outcome and **nothing else**, because everything
/// else a replay needs — attempt, app instance and secret — is already stable on
/// the capability that holds it. Storing the outcome VERBATIM is the point: a
/// replay re-sends what StoreKit actually did, so no code path can widen a
/// `pending`, a `failed` or a `success` into the one outcome that is resumable.
public struct ApplePurchaseOutcomeIntent: Equatable, Codable, Sendable {
    public let armRequestID: String
    public let outcome: ApplePurchaseOutcome
    public init(armRequestID: String, outcome: ApplePurchaseOutcome) {
        self.armRequestID = armRequestID
        self.outcome = outcome
    }
}

// MARK: - persistence

/// Where a capability lives.
///
/// **Every requirement here is about the secret, and none of them is optional.**
///
///  * **The Keychain, never `UserDefaults` and never a plain file.** A defaults
///    plist is world-readable inside the container, is copied by every backup,
///    and is not protected at rest.
///  * **`kSecAttrSynchronizable = false`, explicitly.** iCloud Keychain sync
///    would put the capability on the user's *other* Macs. The capability's
///    entire claim is "the same app instance on the same device"; a synced copy
///    makes that claim false and hands a second machine the authority to re-arm
///    a sheet this one holds.
///  * **`…AfterFirstUnlockThisDeviceOnly`.** Apple documents `ThisDeviceOnly`
///    items as not migrating to a new device on a backup restore, so a restored
///    clone does not arrive holding this Mac's purchase capability.
///
/// Satisfied by `KeychainTokenStore` under its own account key — the same
/// pattern `InstallationIdentityStoring` uses, so there is one audited Keychain
/// implementation in the product rather than a second one written for this.
public protocol ApplePurchaseCapabilityStoring {
    func saveCapability(_ encoded: String) throws
    func loadCapability() throws -> String?
    func clearCapability() throws
}

extension KeychainTokenStore: ApplePurchaseCapabilityStoring {
    public func saveCapability(_ encoded: String) throws { try save(encoded) }
    public func loadCapability() throws -> String? { try load() }
    public func clearCapability() throws { try clear() }
}

/// An in-memory store, for tests and for a host with no Keychain entitlement.
public final class InMemoryApplePurchaseCapabilityStore: ApplePurchaseCapabilityStoring {
    private let lock = NSLock()
    private var encoded: String?
    public init() {}
    public func saveCapability(_ encoded: String) throws {
        lock.lock(); defer { lock.unlock() }
        self.encoded = encoded
    }
    public func loadCapability() throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return encoded
    }
    public func clearCapability() throws {
        lock.lock(); defer { lock.unlock() }
        encoded = nil
    }
}

/// Reads and writes the capability as JSON through a ``ApplePurchaseCapabilityStoring``.
///
/// A failure to *load* is `nil` rather than a thrown error, and that is a safety
/// choice: no capability means no resume, which fails closed. A failure to
/// *save* is thrown, because the caller must not open a sheet it will be unable
/// to report the outcome of.
public struct ApplePurchaseCapabilityRepository {
    private let storeForOwner: (String?) -> ApplePurchaseCapabilityStoring?

    public init(store: ApplePurchaseCapabilityStoring) {
        self.storeForOwner = { _ in store }
    }

    /// Build an account-scoped repository. A capability for account A must not
    /// occupy account B's slot, and must not be overwritten merely because B
    /// signs in on the same Mac.
    public init(storeForOwner: @escaping (String) -> ApplePurchaseCapabilityStoring) {
        self.storeForOwner = { owner in owner.map(storeForOwner) }
    }

    public func read(ownerAccountID: String? = nil) -> ApplePurchaseCapabilityRead {
        guard let store = storeForOwner(ownerAccountID) else { return .unavailable }
        do {
            guard let encoded = try store.loadCapability() else { return .missing }
            guard let data = encoded.data(using: .utf8),
                  let value = try? JSONDecoder().decode(
                    ApplePurchaseCapability.self, from: data) else { return .unavailable }
            return .value(value)
        } catch {
            return .unavailable
        }
    }

    public func load(ownerAccountID: String? = nil) -> ApplePurchaseCapability? {
        guard case let .value(value) = read(ownerAccountID: ownerAccountID) else { return nil }
        return value
    }

    public func save(_ capability: ApplePurchaseCapability) throws {
        guard let store = storeForOwner(capability.ownerAccountID) else {
            throw ApplePurchaseCapabilityError.missingOwner
        }
        let data = try JSONEncoder().encode(capability)
        guard let encoded = String(data: data, encoding: .utf8) else {
            throw ApplePurchaseCapabilityError.encoding
        }
        try store.saveCapability(encoded)
    }

    /// Retire the capability.
    ///
    /// Called on **authoritative convergence only** — the server reporting the
    /// attempt resolved — and never on a timer, a launch count or a clock.
    public func retire(ownerAccountID: String? = nil) throws {
        guard let store = storeForOwner(ownerAccountID) else {
            throw ApplePurchaseCapabilityError.missingOwner
        }
        try store.clearCapability()
    }
}

public enum ApplePurchaseCapabilityError: Error, Equatable { case encoding, missingOwner }

public enum ApplePurchaseCapabilityRead: Equatable {
    case missing
    case value(ApplePurchaseCapability)
    case unavailable
}

/// The non-secret write-ahead record for a StoreKit outcome.
///
/// It deliberately contains no continuation secret. Its sole purpose is to
/// survive the interval in which Keychain is temporarily locked after a sheet
/// has already returned. Once Keychain is readable again, the capability
/// supplies the secret and this intent tells the client exactly which outcome
/// it still owes the server.
public struct ApplePurchaseOutcomeJournalEntry: Codable, Equatable, Sendable {
    public let ownerAccountID: String
    public let attemptID: String
    public let armRequestID: String
    public let outcome: ApplePurchaseOutcome

    public init(ownerAccountID: String, attemptID: String,
                armRequestID: String, outcome: ApplePurchaseOutcome) {
        self.ownerAccountID = ownerAccountID
        self.attemptID = attemptID
        self.armRequestID = armRequestID
        self.outcome = outcome
    }
}

public protocol ApplePurchaseOutcomeJournal {
    func load(ownerAccountID: String) -> ApplePurchaseOutcomeJournalEntry?
    func save(_ entry: ApplePurchaseOutcomeJournalEntry) throws
    func clear(ownerAccountID: String) throws
}

public final class FileApplePurchaseOutcomeJournal: ApplePurchaseOutcomeJournal {
    private let url: URL
    private let fileManager: FileManager
    private let lock = NSLock()

    public convenience init?() {
        guard let root = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        self.init(url: root.appendingPathComponent("Relayium", isDirectory: true)
            .appendingPathComponent("apple-purchase-outcomes-v1.json"))
    }

    public init(url: URL, fileManager: FileManager = .default) {
        self.url = url
        self.fileManager = fileManager
    }

    public func load(ownerAccountID: String) -> ApplePurchaseOutcomeJournalEntry? {
        lock.lock(); defer { lock.unlock() }
        return entries()[ownerAccountID]
    }

    public func save(_ entry: ApplePurchaseOutcomeJournalEntry) throws {
        lock.lock(); defer { lock.unlock() }
        var current = entries()
        current[entry.ownerAccountID] = entry
        try persist(current)
    }

    public func clear(ownerAccountID: String) throws {
        lock.lock(); defer { lock.unlock() }
        var current = entries()
        current.removeValue(forKey: ownerAccountID)
        try persist(current)
    }

    private func entries() -> [String: ApplePurchaseOutcomeJournalEntry] {
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONDecoder().decode(
            [String: ApplePurchaseOutcomeJournalEntry].self, from: data)) ?? [:]
    }

    private func persist(_ entries: [String: ApplePurchaseOutcomeJournalEntry]) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(),
                                        withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(entries)
        try data.write(to: url, options: .atomic)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }
}

public final class InMemoryApplePurchaseOutcomeJournal: ApplePurchaseOutcomeJournal {
    private let lock = NSLock()
    private var values: [String: ApplePurchaseOutcomeJournalEntry] = [:]
    public init() {}
    public func load(ownerAccountID: String) -> ApplePurchaseOutcomeJournalEntry? {
        lock.lock(); defer { lock.unlock() }
        return values[ownerAccountID]
    }
    public func save(_ entry: ApplePurchaseOutcomeJournalEntry) throws {
        lock.lock(); defer { lock.unlock() }
        values[entry.ownerAccountID] = entry
    }
    public func clear(ownerAccountID: String) throws {
        lock.lock(); defer { lock.unlock() }
        values.removeValue(forKey: ownerAccountID)
    }
}

// MARK: - identities

/// The client-authored identifiers.
///
/// Both must satisfy the server's `validAppleContinuationID`: non-empty, at most
/// 128 characters, every byte in `0x21…0x7e`. Base64url of 32 random bytes is 43
/// characters from that set, so the format is proved by construction rather than
/// by a length check at the call site.
public enum ApplePurchaseIdentity {
    /// A fresh arm identity, for one logical sheet.
    ///
    /// **`InstallationIdentity.generate()` is reused deliberately.** It is the
    /// product's audited CSPRNG-backed base64url generator — `SecRandomCopyBytes`
    /// over 32 bytes, returning `""` rather than weak entropy on failure — and
    /// duplicating that here would be a second copy of security-sensitive code
    /// to keep correct. Only the *generator* is shared; the arm identity is
    /// stored nowhere and is minted fresh per sheet, so it is not the
    /// installation's identity and is never compared against it.
    ///
    /// Returns `nil` when the system CSPRNG refused, which the caller must treat
    /// as "do not arm" rather than substituting a value.
    public static func freshArmRequestID() -> String? {
        let minted = InstallationIdentity.generate()
        return isValid(minted) ? minted : nil
    }

    /// A client-authored 32-byte capability secret. It is generated by the same
    /// audited CSPRNG path as arm identities and persisted before the initial
    /// request, so losing either that request or its response is replayable.
    public static func freshContinuationSecret() -> String? {
        let minted = InstallationIdentity.generate()
        return isValid(minted) ? minted : nil
    }

    /// The server's own predicate, restated so a value is rejected here rather
    /// than one round trip later — and so a `400` can never spend an arm id.
    public static func isValid(_ candidate: String) -> Bool {
        guard !candidate.isEmpty, candidate.count <= 128 else { return false }
        return candidate.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
    }
}

// MARK: - the planner

/// What this client may do next about a purchase, given what it remembers.
public enum ApplePurchasePlan: Equatable {
    /// A durably prepared initial arm. The secret is sent on the first request
    /// and every exact replay, but the server stores only its digest.
    case initialArm(ApplePurchaseCapability)
    /// A cancelled attempt this client armed. Resume it with a fresh identity and
    /// the product the user actually chose, which need not be the cancelled one.
    case resume(ApplePurchaseCapability, armRequestID: String, productID: String)
    /// A resume was sent and never answered. Replay it **byte for byte** — same
    /// arm, same product — which the server reads back idempotently without
    /// opening a second logical sheet.
    case replayResume(ApplePurchaseCapability, armRequestID: String, productID: String)
    /// An outcome report was recorded and never confirmed delivered. Replay it
    /// **exactly** — same arm, same outcome — before anything else may be
    /// planned, and open no sheet until the server has answered it.
    ///
    /// This is the only plan that is not about arming: it is about discharging
    /// something already owed. It carries the outcome verbatim so a replay can
    /// never report a different one than StoreKit produced.
    case replayOutcome(ApplePurchaseCapability, armRequestID: String,
                       outcome: ApplePurchaseOutcome)
    /// Nothing may be armed. See ``ApplePurchaseRefusal``.
    case blocked(ApplePurchaseRefusal)
}

/// Why no sheet may be opened.
///
/// Both are **fail-closed** states, and neither is a transient retry.
public enum ApplePurchaseRefusal: Equatable, Sendable {
    /// A sheet is authorized and no outcome for it has been **recorded** — this
    /// process died while it was open, or it is open right now.
    ///
    /// Never a second sheet. What converges it depends on what StoreKit did, and
    /// only one of the two has an automatic path:
    ///
    ///  * a purchase that completed carries a signed transaction, and
    ///    `Transaction.updates`/`restore` redeliver it until the server accepts
    ///    it — that is the reconciliation this refusal used to promise;
    ///  * a **cancellation carries nothing at all**. Apple signs transactions,
    ///    never their absence, so there is no JWS to redeliver and reconciliation
    ///    converges *nothing*.
    ///
    /// The second case is why an outcome report is recorded **before** it is
    /// sent: once recorded it is replayed by ``ApplePurchasePlan/replayOutcome(_:armRequestID:outcome:)``
    /// and never reaches this state. This refusal therefore now means only that
    /// nothing was ever recorded — a sheet genuinely open, or a process that died
    /// between the server arming and StoreKit answering.
    case sheetOutstanding
    /// A terminal outcome was reported. `pending` in particular lands here: it
    /// may still become a real charge.
    case locked
}

public enum ApplePurchaseContinuation {
    /// **The one place that decides whether a StoreKit sheet may be opened.**
    ///
    /// Pure, total, and dependent on nothing but the persisted value and the
    /// product the user chose. `freshArmRequestID` is a parameter rather than
    /// minted inside, so a test drives an exact identity instead of asserting
    /// around randomness.
    ///
    /// Note the order: **both unconfirmed intents are handled before `phase`**,
    /// and that is deliberate in each case.
    ///
    ///  * An unconfirmed **resume** outranks the phase because the phase still
    ///    says `cancelled` at that point — the resume's answer was never seen —
    ///    so a planner that looked at the phase first would mint a second
    ///    identity for a sheet the server may already have armed.
    ///  * An unconfirmed **outcome** outranks the phase because the phase still
    ///    says `armed` at that point — the report's answer was never seen — so a
    ///    planner that looked at the phase first would refuse
    ///    `.sheetOutstanding` for ever. For a cancellation nothing else can ever
    ///    clear that, because there is no transaction to reconcile with.
    ///
    /// Resume is ordered first. The two are mutually exclusive by construction,
    /// so the order is unobservable in practice; it is fixed anyway so that a
    /// value written by some other build converges — replaying the resume moves
    /// the arm, which makes any older outcome intent stale, and a stale intent
    /// is inert.
    ///
    /// **A stale outcome intent is not a plan.** One naming an arm the current
    /// value has already moved past falls through to the phase, because the
    /// server superseded that arm itself: `armRequestID` moves only on an
    /// authoritative 200, and an arm identity is never reissued.
    public static func plan(capability: ApplePurchaseCapability?,
                            productID: String,
                            appInstanceID: String,
                            freshArmRequestID: String) -> ApplePurchasePlan {
        guard let capability else { return .blocked(.locked) }
        if let intent = capability.unconfirmedResume {
            return .replayResume(capability,
                                 armRequestID: intent.armRequestID,
                                 productID: intent.productID)
        }
        if let pending = capability.unconfirmedOutcome,
           pending.armRequestID == capability.armRequestID {
            return .replayOutcome(capability,
                                  armRequestID: pending.armRequestID,
                                  outcome: pending.outcome)
        }
        switch capability.phase {
        case .preparing: return .initialArm(capability)
        case .armed: return .blocked(.sheetOutstanding)
        case .locked: return .blocked(.locked)
        case .cancelled:
            return .resume(capability,
                           armRequestID: freshArmRequestID,
                           productID: productID)
        }
    }

    // MARK: transitions

    /// Prepare the initial capability before any request can arm the server.
    public static func prepared(ownerAccountID: String, appInstanceID: String, secret: String,
                                armRequestID: String,
                                productID: String) -> ApplePurchaseCapability {
        ApplePurchaseCapability(attemptID: "", ownerAccountID: ownerAccountID,
                                appInstanceID: appInstanceID,
                                secret: secret, armRequestID: armRequestID,
                                productID: productID, phase: .preparing)
    }

    /// Bind a prepared capability to the attempt id returned by the server.
    /// An older compatible server may return its own secret; a current server
    /// returns none because the client already persisted the one it presented.
    public static func confirmedInitialArm(_ prepared: ApplePurchaseCapability,
                                           attemptID: String,
                                           serverSecret: String?) -> ApplePurchaseCapability? {
        guard prepared.phase == .preparing, !attemptID.isEmpty else { return nil }
        let secret = serverSecret.flatMap { $0.isEmpty ? nil : $0 } ?? prepared.secret
        guard !secret.isEmpty else { return nil }
        return ApplePurchaseCapability(attemptID: attemptID,
                                       ownerAccountID: prepared.ownerAccountID,
                                       appInstanceID: prepared.appInstanceID,
                                       secret: secret,
                                       armRequestID: prepared.armRequestID,
                                       productID: prepared.productID,
                                       phase: .armed)
    }

    /// The capability an initial arm's 200 creates.
    ///
    /// `nil` when the server returned no secret — a legacy deployment, or one
    /// that answered a shape this protocol does not recognise. The caller must
    /// then behave as a one-shot client rather than inventing a capability.
    public static func armed(attemptID: String,
                             appInstanceID: String,
                             secret: String?,
                             armRequestID: String,
                             productID: String) -> ApplePurchaseCapability? {
        guard let secret, !secret.isEmpty else { return nil }
        return ApplePurchaseCapability(attemptID: attemptID,
                                       ownerAccountID: nil,
                                       appInstanceID: appInstanceID,
                                       secret: secret,
                                       armRequestID: armRequestID,
                                       productID: productID,
                                       phase: .armed)
    }

    /// Record a resume **before sending it**, so a lost response is replayable.
    ///
    /// The phase deliberately stays `cancelled`: nothing is armed until the
    /// server says so, and claiming `armed` here would block the very replay
    /// this record exists to enable.
    public static func recordingResumeIntent(_ capability: ApplePurchaseCapability,
                                             armRequestID: String,
                                             productID: String) -> ApplePurchaseCapability {
        var next = capability
        next.unconfirmedResume = ApplePurchaseResumeIntent(armRequestID: armRequestID,
                                                           productID: productID)
        return next
    }

    /// Apply a resume's 200: the named arm is now the open one, on the named
    /// product, and the intent is discharged.
    ///
    /// The product moves here because the server moved it in the same statement
    /// as the arm id. Leaving it behind is the money-side defect this protocol's
    /// cross-product rule exists to prevent: convergence is exact on product, so
    /// a Plus purchase against a Pro-labelled attempt charges correctly and then
    /// never resolves.
    public static func confirmedArm(_ capability: ApplePurchaseCapability,
                                    attemptID: String,
                                    armRequestID: String,
                                    productID: String) -> ApplePurchaseCapability? {
        guard !attemptID.isEmpty else { return nil }
        var next = ApplePurchaseCapability(
            attemptID: attemptID,
            ownerAccountID: capability.ownerAccountID,
            appInstanceID: capability.appInstanceID,
            secret: capability.secret,
            armRequestID: armRequestID,
            productID: productID,
            phase: .armed)
        // Any recorded outcome belongs to the arm being left behind, and the
        // server has just superseded that arm itself. Dropping it here is what
        // keeps a stale intent from accumulating in a value that outlives every
        // launch — it could never become live again, since an arm identity is
        // never reissued, but a money-critical struct should not carry a field
        // whose only remaining property is that it is ignored.
        next.unconfirmedOutcome = nil
        return next
    }

    /// Record an outcome report **before it is sent**.
    ///
    /// Returns `nil` — meaning *record nothing and send nothing* — when the
    /// report does not belong to the arm that is open, or when a resume is still
    /// unconfirmed and therefore nobody knows which arm is open. Those are the
    /// same two conditions under which ``applying(_:to:forArm:serverResumable:)``
    /// would refuse to apply the answer, checked here so a report that could
    /// never be applied is never sent either.
    ///
    /// The outcome is stored **verbatim**. Nothing between here and the wire may
    /// widen it, which is what makes rule 1 hold across a replay: a recorded
    /// `pending` replays as `pending` and locks, however many times it is
    /// retried.
    public static func recordingOutcomeIntent(_ capability: ApplePurchaseCapability,
                                              outcome: ApplePurchaseOutcome,
                                              forArm armRequestID: String) -> ApplePurchaseCapability? {
        guard capability.armRequestID == armRequestID else { return nil }
        guard capability.unconfirmedResume == nil else { return nil }
        var next = capability
        next.unconfirmedOutcome = ApplePurchaseOutcomeIntent(armRequestID: armRequestID,
                                                             outcome: outcome)
        return next
    }

    /// Apply the server's **answer** to an outcome report, for the arm it
    /// belongs to.
    ///
    /// Returns `nil` — meaning *drop it, change nothing* — when the report names
    /// an arm that is no longer the open one. That is the guard that stops a
    /// late completion from an earlier sheet cancelling or retiring a newer one,
    /// and it holds across a restart because both sides of the comparison come
    /// from the persisted value.
    ///
    /// ## `serverResumable` is a parameter, and that is the whole point
    ///
    /// The phase is the **conjunction** of two independent facts, so local
    /// resumability can exceed neither:
    ///
    ///  * `outcome.isResumable` — *this client reported a cancellation*. Without
    ///    it a server answering `resumable: true` to a `success` report would
    ///    authorize a second sheet over a paid one.
    ///  * `serverResumable` — *the server agreed to re-arm*. Without it, a 200
    ///    that says `resumable: false` is recorded locally as `cancelled`
    ///    anyway. That is not hypothetical: `RecordAppleBillingPurchaseOutcome`
    ///    short-circuits an already-`locked` attempt to
    ///    `Accepted: true, Resumable: false` **whatever outcome was requested**,
    ///    so a `userCancelled` report against an attempt some earlier `pending`
    ///    already locked answers exactly that. Believing it would plan a resume
    ///    the server must then refuse — and a client that believes it may buy
    ///    while the server holds a possibly-charging attempt is the wrong side
    ///    of this protocol to be wrong on.
    ///
    /// The recorded intent is discharged here, and only here: the answer is what
    /// makes the report no longer owed.
    public static func applying(_ outcome: ApplePurchaseOutcome,
                                to capability: ApplePurchaseCapability,
                                forArm armRequestID: String,
                                serverResumable: Bool) -> ApplePurchaseCapability? {
        guard capability.armRequestID == armRequestID else { return nil }
        // An outcome for an arm whose resume was never confirmed cannot be
        // trusted to be about the open sheet either.
        guard capability.unconfirmedResume == nil else { return nil }
        var next = capability
        next.phase = (outcome.isResumable && serverResumable) ? .cancelled : .locked
        next.unconfirmedOutcome = nil
        return next
    }
}
