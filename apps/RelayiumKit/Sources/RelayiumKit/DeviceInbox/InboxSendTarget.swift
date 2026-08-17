import Foundation

/// "May I send to this device, and what must I say about it?"
///
/// Pure by construction — no network, no storage, no clock — so every branch is
/// assertable without any of them. It is the native half of
/// `web/src/lib/device-inbox.ts`'s `sendAvailability`, in the same order and
/// with the same verdicts, because two surfaces that disagreed would let a user
/// watch a file upload from the browser and be refused from the phone.
///
/// Two rules shape the whole file:
///
///  1. **Presence is advisory, capability is not.** An offline but properly
///     enrolled device is a legitimate target: the task queues and lands when it
///     comes back. Only enrolment, revocation, key material, the negotiated
///     capability and the device owner's own receive policy can make a device
///     unsendable. Collapsing the two would make "offline" mean "rejected" and
///     delete the reason the queue exists.
///  2. **A refusal keeps its name.** Each block below has a different remedy —
///     clear the revocation over there, turn receiving on over there, update
///     that build — so none of them is flattened into an empty list or a generic
///     failure on the way to the UI.

/// Why a device cannot be sent to. Closed, and one case per distinct remedy.
public enum InboxTargetBlock: String, Equatable, Sendable, CaseIterable {
    /// The device id could not safely become a request path component.
    case unusableIdentifier
    /// No Device Inbox at all: a browser, or a client build predating Phase 1A.
    case notEnrolled
    /// Enrolment revoked. Only a human at another device can clear it.
    case revoked
    /// Central's own verdict is no — for a reason this build may not be able to
    /// see, which is exactly why its answer is preferred over a local guess.
    case cannotReceive
    /// The negotiated receive capability is not one this build can drive.
    case unsupportedCapability
    /// Missing, superseded, revoked, wrongly-spelled, wrong-algorithm or
    /// unusable key material. One case, because the user's remedy is the same:
    /// that device has to publish a current key this protocol can wrap to.
    case unsupportedKey
    /// The device owner turned automatic receiving off (protocol §14).
    case receiveOff
}

/// Truthful qualifications on a send that IS allowed.
///
/// Never suppressed: a target that is sendable but will not land unattended has
/// to say so BEFORE the file is encrypted and uploaded, not after.
public enum InboxTargetCaveat: String, Equatable, Sendable, CaseIterable {
    /// Policy `ask`: a person at that machine has to accept.
    case needsApproval
    /// Policy `auto`, but its receive folder was last reported unusable — so
    /// central will start the task at `attention_required` anyway.
    case directoryNotReady
    /// Offline but cryptographically able. The task waits.
    case queuedUntilOnline
}

/// The verdict on one device row.
public struct InboxTargetAvailability: Equatable, Sendable {
    public let sendable: Bool
    /// Set exactly when `sendable` is false.
    public let block: InboxTargetBlock?
    /// Ordered, most consequential first. Possibly empty.
    public let caveats: [InboxTargetCaveat]
    public let online: Bool
    /// The device owner's policy, nil when this row has no Device Inbox. It is
    /// never an "unknown" member: `InboxAutoAccept` is decoded through
    /// `InboxWire.closed`, so a policy this build does not know has already
    /// failed the decode and this row never reached here at all.
    public let policy: InboxAutoAccept?
    /// This is the device doing the sending. Reported rather than blocked: a
    /// send to yourself is not *wrong*, it is simply not what the picker offers.
    public let isCurrentDevice: Bool

    public init(sendable: Bool, block: InboxTargetBlock?, caveats: [InboxTargetCaveat],
                online: Bool, policy: InboxAutoAccept?, isCurrentDevice: Bool) {
        self.sendable = sendable
        self.block = block
        self.caveats = caveats
        self.online = online
        self.policy = policy
        self.isCurrentDevice = isCurrentDevice
    }
}

/// A device that may be sealed to, with the key material a seal actually needs.
///
/// Only ever produced from a row that passed every check, so a value of this
/// type is the proof rather than the intention: there is no initializer that
/// takes an unvalidated row.
public struct InboxSendTarget: Equatable, Sendable {
    public let deviceID: String
    public let name: String
    public let kind: String
    public let keyID: String
    public let keyGeneration: Int64
    public let algorithm: String
    /// Canonical base64url, already validated through `validatePublicKey`.
    public let publicKey: String
    public let availability: InboxTargetAvailability
}

public enum InboxTargetEligibility {

    /// Decide one row, in the order a user would have to act in.
    ///
    /// The order is the design: checks run from "this is not a Device Inbox at
    /// all" outwards to "it is, and its owner turned receiving off", so the
    /// block that survives names the FIRST thing that would have to change.
    public static func availability(for row: InboxDeviceRow) -> InboxTargetAvailability {
        let inbox = row.inbox
        let online = inbox?.presence == .online
        let policy = inbox?.autoAccept
        func no(_ block: InboxTargetBlock) -> InboxTargetAvailability {
            InboxTargetAvailability(sendable: false, block: block, caveats: [],
                                    online: online, policy: policy,
                                    isCurrentDevice: row.isCurrent)
        }

        guard (try? StoredObjectID.checked(row.id)) == row.id else {
            return no(.unusableIdentifier)
        }
        // `registeredAt == 0` is central's own "this subtree describes nothing":
        // a row can carry a zeroed `Inbox` for a device that never enrolled.
        guard let inbox, inbox.registeredAt != 0 else { return no(.notEnrolled) }
        guard !inbox.revoked else { return no(.revoked) }
        // Before any key inspection, deliberately. Central can refuse for a
        // reason not visible in these fields (protocol version, cleared
        // enrolment), and its verdict must beat a local guess.
        guard inbox.canReceive else { return no(.cannotReceive) }
        // v2 only. A device still enrolled under `inbox.receive.v1` cannot decode
        // a v2 manifest, so it is refused here rather than offered as a target
        // and discovered after the file is already encrypted and uploaded. There
        // is no downgrade branch: the owner waived old-protocol compatibility.
        guard inbox.receiveCapability == InboxCapability.receiveV2 else {
            return no(.unsupportedCapability)
        }
        guard let key = inbox.key, key.isActive,
              (try? StoredObjectID.checked(key.id)) == key.id,
              key.generation > 0,
              // The same order and the same rules central's `ValidatePublicKey`
              // applies — including the low-order refusal, which is the check
              // that stops a content key being "sealed" to a point whose
              // exchange yields the all-zero shared secret.
              (try? InboxKeyMaterial.validatePublicKey(algorithm: key.algorithm,
                                                       encoded: key.publicKey)) != nil else {
            return no(.unsupportedKey)
        }
        // Refused here rather than after a whole encrypted upload: central
        // answers `auto_receive_disabled` and stores nothing at all.
        guard let policy, policy != .off else { return no(.receiveOff) }

        var caveats: [InboxTargetCaveat] = []
        switch policy {
        case .ask: caveats.append(.needsApproval)
        case .auto: if !inbox.receiveDirReady { caveats.append(.directoryNotReady) }
        case .off: break                                    // unreachable: refused above
        }
        if !online { caveats.append(.queuedUntilOnline) }
        return InboxTargetAvailability(sendable: true, block: nil, caveats: caveats,
                                       online: online, policy: policy,
                                       isCurrentDevice: row.isCurrent)
    }

    /// Would offering a TEXT send to this device be honest?
    ///
    /// Deliberately NOT folded into `availability(for:)`, and the separation is
    /// the point in both directions:
    ///
    ///  * a receiver without `inbox.text.v1` is a perfectly good FILE target,
    ///    so requiring the token in the general verdict would refuse ordinary
    ///    file deliveries to every build that does not render messages — the
    ///    CLI, iOS, and the headless receiver among them;
    ///  * a receiver without it would land a message as a file in somebody's
    ///    downloads folder, so offering "send text" to it would promise a
    ///    message and deliver a file.
    ///
    /// Central neither requires nor interprets the token and could not verify it
    /// if it wanted to — content kind is sealed — so its absence is read as the
    /// truthful answer rather than as a stale list: a device that has not said
    /// it presents text is one this sender must not offer text to.
    ///
    /// The receive FOLDER is deliberately not consulted. A message is never
    /// written there, so a missing, revoked or unwritable folder has nothing to
    /// do with whether one can land — the receiver classifies kind first and
    /// consults the folder second (protocol v2 §13.1), and suppressing text here
    /// would refuse a delivery that folder was never going to touch.
    public static func canReceiveText(_ row: InboxDeviceRow) -> Bool {
        guard availability(for: row).sendable else { return false }
        return row.inbox?.capabilities.contains(InboxCapability.textV1) == true
    }

    /// The seal target for a TEXT delivery, or nil when this device may not be
    /// sent one. Every file-send rule, plus `inbox.text.v1`.
    public static func textTarget(for row: InboxDeviceRow) -> InboxSendTarget? {
        guard canReceiveText(row) else { return nil }
        return target(for: row)
    }

    /// The seal target for a row, or nil when it may not be sent to.
    public static func target(for row: InboxDeviceRow) -> InboxSendTarget? {
        let availability = availability(for: row)
        guard availability.sendable, let key = row.inbox?.key else { return nil }
        return InboxSendTarget(deviceID: row.id, name: row.name, kind: row.kind,
                               keyID: key.id, keyGeneration: key.generation,
                               algorithm: key.algorithm, publicKey: key.publicKey,
                               availability: availability)
    }

    /// Every device on the account that may be sent to, in central's own order.
    ///
    /// The current device is excluded by default. That is a product decision,
    /// not a safety one — sending a file to the machine you are holding is not
    /// what this feature offers — so it is a parameter, and `isCurrentDevice`
    /// stays readable on the availability for a caller that wants to ask.
    public static func targets(from rows: [InboxDeviceRow],
                               includingCurrentDevice: Bool = false) -> [InboxSendTarget] {
        rows.filter { includingCurrentDevice || !$0.isCurrent }.compactMap(target(for:))
    }
}
