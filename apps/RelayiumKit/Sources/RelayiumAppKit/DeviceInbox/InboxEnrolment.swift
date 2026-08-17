import Foundation
@preconcurrency import RelayiumKit

/// Getting from "this Mac has credentials" to "this Mac holds the private half
/// of the key senders are wrapping to".
///
/// This is the part of Device Inbox where a mistake is unrecoverable rather than
/// merely annoying. Central publishes a public key and senders seal content keys
/// to it; if the matching private key is not in this account's keychain history,
/// those tasks cannot be opened by anybody, ever. Two rules follow, and
/// everything below exists to keep them:
///
///   - PERSIST BEFORE PUBLISH. A key is durable locally before it is registered.
///   - RECONCILE, DO NOT REGENERATE. A lost registration response is repaired by
///     asking central which id it gave the key we already hold — never by minting
///     a second key, which would abandon the first and could strand tasks already
///     sealed to it.
public enum InboxEnrolment {

    public enum Failure: Error, Equatable, Sendable {
        /// Central's active key cannot be made usable here and this device could
        /// not rotate onto one it holds. Continuing would advertise a device that
        /// silently cannot decrypt anything.
        case keyUnrecoverable
        /// Central registered a different public key, or a different algorithm,
        /// than the one submitted. Storing that binding would mean the local
        /// private key does not belong to the published public key.
        case registrationMismatch
    }

    /// Announce this build, then fail closed on what central selected.
    ///
    /// A 409 from enrolment is "upgrade or stop", never "retry with a default".
    /// The three checks below are separate on purpose: each names the exact field
    /// central chose that this build cannot honour, which is the difference
    /// between an actionable message and "the server said no".
    /// - Parameter capabilities: what THIS build announces. Defaulted to the set
    ///   every build may honestly claim, so a caller that says nothing announces
    ///   nothing extra — the safe direction, because the additional tokens are
    ///   claims about surfaces this module cannot see. A build whose own screens
    ///   back a further claim passes it explicitly; see
    ///   `InboxProtocol.announcedCapabilities(presentingText:)`.
    @discardableResult
    public static func enrol(_ transport: InboxTransport,
                             platform: String, appVersion: String,
                             capabilities: [String] = InboxProtocol.capabilities,
                             autoAccept: InboxAutoAccept,
                             receiveDirReady: Bool) async throws -> InboxEnrolResult {
        let result = try await transport.enrol(InboxEnrolRequest(
            platform: platform, appVersion: appVersion, capabilities: capabilities,
            autoAccept: autoAccept, receiveDirReady: receiveDirReady))
        guard InboxProtocol.versions.contains(result.protocolVersion) else {
            throw InboxError.unsupportedByServer(field: .protocolVersion)
        }
        // Checked against what was ANNOUNCED, not against the library's base
        // set: central selects from the list this device sent, so the announced
        // set is the only one whose contents this build has promised to honour.
        guard capabilities.contains(result.receiveCapability) else {
            throw InboxError.unsupportedByServer(field: .receiveCapability)
        }
        guard result.keyAlgorithm == InboxProtocol.keyAlgorithm else {
            throw InboxError.unsupportedByServer(field: .keyAlgorithm)
        }
        return result
    }

    /// Make central's ACTIVE key one this account holds the private half of, and
    /// return it.
    ///
    /// `current` is the active key from the enrolment response (nil when there is
    /// none). The four cases, in the order they are tried:
    ///
    ///  1. Central's active key is in this account's history — nothing to do.
    ///  2. Central's active key matches a local private key whose server id was
    ///     never recorded (the registration response was lost). Bind the id; no
    ///     new key.
    ///  3. Central has no active key. Publish the local one, or mint one if this
    ///     account has never had a key on this Mac.
    ///  4. Central's active key is NOT locally usable — a restored machine, a
    ///     cleared keychain, a key registered by another installation. Rotate onto
    ///     a fresh key with a compare-and-swap against the current id. This is a
    ///     recovery, and it is honest about its cost: tasks already sealed to the
    ///     old key stay sealed to it and will fail to decrypt here.
    public static func ensureUsableKey(transport: InboxTransport,
                                       keys: InboxDeviceKeyStoring,
                                       account: InboxAccountID,
                                       current: InboxKey?,
                                       now: Date) async throws -> InboxKey {
        if let current, current.isActive {
            if try await keys.keyPair(forKeyID: current.id, account: account) != nil {
                return current
            }
            if let record = try await keys.record(forPublicKey: current.publicKey, account: account) {
                try await keys.bind(publicKey: record.publicKey, keyID: current.id,
                                    generation: current.generation, account: account)
                return current
            }
            return try await rotateOnto(transport: transport, keys: keys, account: account,
                                        previousKeyID: current.id, now: now)
        }
        return try await publishLocalOrNew(transport: transport, keys: keys,
                                           account: account, now: now)
    }

    /// Register the newest local key, or mint one first.
    ///
    /// An unpublished local record is preferred over a fresh key: it may already
    /// be registered under an id whose response was lost, and `reconcile` finds
    /// that out for certain instead of guessing.
    private static func publishLocalOrNew(transport: InboxTransport,
                                          keys: InboxDeviceKeyStoring,
                                          account: InboxAccountID,
                                          now: Date) async throws -> InboxKey {
        guard let record = try await keys.latest(account: account) else {
            return try await mintAndRegister(transport: transport, keys: keys, account: account,
                                             previousKeyID: nil, now: now)
        }
        do {
            let key = try await transport.registerKey(algorithm: record.algorithm,
                                                      publicKey: record.publicKey,
                                                      previousKeyID: nil)
            try await bindRegistered(keys: keys, account: account,
                                     publicKey: record.publicKey, key: key)
            return key
        } catch let error as InboxError {
            // Both of these mean central's history disagrees with ours, and the
            // truth is on central's side. Read it rather than guessing.
            switch error.rejection {
            case .staleKeyRotation, .deviceKeyReused:
                return try await reconcile(transport: transport, keys: keys,
                                           account: account, now: now)
            default:
                throw error
            }
        }
    }

    private static func rotateOnto(transport: InboxTransport, keys: InboxDeviceKeyStoring,
                                   account: InboxAccountID, previousKeyID: String,
                                   now: Date) async throws -> InboxKey {
        do {
            return try await mintAndRegister(transport: transport, keys: keys, account: account,
                                             previousKeyID: previousKeyID, now: now)
        } catch let error as InboxError where error.rejection == .staleKeyRotation {
            // The compare-and-swap lost: something rotated the key between the
            // enrolment response and now. Re-read and try once from the truth.
            return try await reconcile(transport: transport, keys: keys, account: account, now: now)
        }
    }

    /// Generate a key, make it durable, and only THEN publish it.
    ///
    /// The ordering is the invariant and the whole reason this is not two lines:
    /// if the process dies after the append, an unpublished private key is a
    /// recoverable nuisance. If it died after the registration but before the
    /// append, central would be handing senders a public key whose private half
    /// never existed.
    private static func mintAndRegister(transport: InboxTransport, keys: InboxDeviceKeyStoring,
                                        account: InboxAccountID, previousKeyID: String?,
                                        now: Date) async throws -> InboxKey {
        let keyPair = try InboxKeyMaterial.generateKeyPair()
        let record = try await keys.append(keyPair, account: account, now: now)
        let key = try await transport.registerKey(algorithm: record.algorithm,
                                                  publicKey: record.publicKey,
                                                  previousKeyID: previousKeyID)
        try await bindRegistered(keys: keys, account: account,
                                 publicKey: record.publicKey, key: key)
        return key
    }

    /// Record central's id for a key, after checking central named the key we
    /// actually sent.
    private static func bindRegistered(keys: InboxDeviceKeyStoring, account: InboxAccountID,
                                       publicKey: String, key: InboxKey) async throws {
        guard key.publicKey == publicKey else { throw Failure.registrationMismatch }
        guard key.algorithm == InboxProtocol.keyAlgorithm else { throw Failure.registrationMismatch }
        try await keys.bind(publicKey: publicKey, keyID: key.id,
                            generation: key.generation, account: account)
    }

    /// Read central's key history and repair the local record when a response was
    /// lost, or rotate ONCE when central's active key is genuinely not ours.
    ///
    /// It is the only place a second registration attempt is made, and it is
    /// bounded: one read, then at most one rotation. Looping here against a server
    /// that keeps disagreeing would mint keys forever.
    private static func reconcile(transport: InboxTransport, keys: InboxDeviceKeyStoring,
                                  account: InboxAccountID, now: Date) async throws -> InboxKey {
        let history = try await transport.listKeys()
        guard let active = history.first(where: { $0.isActive }) else {
            throw Failure.keyUnrecoverable
        }
        if try await keys.keyPair(forKeyID: active.id, account: account) != nil { return active }
        if let record = try await keys.record(forPublicKey: active.publicKey, account: account) {
            try await keys.bind(publicKey: record.publicKey, keyID: active.id,
                                generation: active.generation, account: account)
            return active
        }
        do {
            return try await mintAndRegister(transport: transport, keys: keys, account: account,
                                             previousKeyID: active.id, now: now)
        } catch {
            throw Failure.keyUnrecoverable
        }
    }
}
