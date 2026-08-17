import Foundation

/// The wire shapes of `inbox/1`, decoded STRICTLY.
///
/// The server speaks Go's default capitalization (`ID`, `State`, …) on these
/// routes, because the Device Inbox subtree follows `GET /api/devices`, which
/// predates any client that asked for lowerCamel. The names are spelled out here
/// rather than renamed on the server, so there stays one shipped contract.
///
/// Every decoder below is hand-written for one reason: a synthesised
/// `Decodable` on an enum-typed property throws a `DataCorrupted` error that
/// says nothing about WHICH value was unknown, and — worse — a `String` property
/// would accept any value at all. Turning an unrecognised state, policy,
/// presence or error code into a thrown `InboxError` is what makes "fail closed
/// on unknown protocol values" a property of the type rather than of whoever
/// remembers to check.

/// One entry of this device's public-key history as central reports it.
///
/// There is no private-key field here by construction: central never receives
/// one, so no shape that could carry one exists on this side either.
public struct InboxKey: Equatable, Sendable {
    public let id: String
    public let algorithm: String
    public let publicKey: String
    public let generation: Int64
    public let createdAt: Int64
    public let supersededAt: Int64
    public let revokedAt: Int64

    public init(id: String, algorithm: String, publicKey: String, generation: Int64,
                createdAt: Int64 = 0, supersededAt: Int64 = 0, revokedAt: Int64 = 0) {
        self.id = id
        self.algorithm = algorithm
        self.publicKey = publicKey
        self.generation = generation
        self.createdAt = createdAt
        self.supersededAt = supersededAt
        self.revokedAt = revokedAt
    }

    /// Whether new tasks are sealed to this key. Superseded and revoked are
    /// different states on purpose: a superseded key still opens tasks queued
    /// before the rotation, a revoked one never opens anything again.
    public var isActive: Bool { supersededAt == 0 && revokedAt == 0 }
}

extension InboxKey: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id = "ID", algorithm = "Algorithm", publicKey = "PublicKey"
        case generation = "Generation", createdAt = "CreatedAt"
        case supersededAt = "SupersededAt", revokedAt = "RevokedAt"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        algorithm = try c.decode(String.self, forKey: .algorithm)
        publicKey = try c.decode(String.self, forKey: .publicKey)
        generation = try c.decode(Int64.self, forKey: .generation)
        createdAt = try c.decode(Int64.self, forKey: .createdAt)
        supersededAt = try c.decode(Int64.self, forKey: .supersededAt)
        revokedAt = try c.decode(Int64.self, forKey: .revokedAt)
    }
}

/// The enrolment central holds for a device.
public struct InboxView: Equatable, Sendable {
    public let presence: InboxPresence
    public let lastHeartbeatAt: Int64
    public let presenceExpiresAt: Int64
    public let heartbeatIntervalSeconds: Int
    public let protocolVersion: Int
    public let capabilities: [String]
    public let receiveCapability: String
    public let autoAccept: InboxAutoAccept
    public let receiveDirReady: Bool
    public let revoked: Bool
    public let canReceive: Bool
    public let registeredAt: Int64
    public let key: InboxKey?

    public init(presence: InboxPresence = .offline, lastHeartbeatAt: Int64 = 0,
                presenceExpiresAt: Int64 = 0,
                heartbeatIntervalSeconds: Int = InboxProtocol.defaultHeartbeatSeconds,
                protocolVersion: Int = 1, capabilities: [String] = [],
                receiveCapability: String = InboxCapability.receiveV1,
                autoAccept: InboxAutoAccept = .off, receiveDirReady: Bool = false,
                revoked: Bool = false, canReceive: Bool = false,
                registeredAt: Int64 = 0, key: InboxKey? = nil) {
        self.presence = presence
        self.lastHeartbeatAt = lastHeartbeatAt
        self.presenceExpiresAt = presenceExpiresAt
        self.heartbeatIntervalSeconds = heartbeatIntervalSeconds
        self.protocolVersion = protocolVersion
        self.capabilities = capabilities
        self.receiveCapability = receiveCapability
        self.autoAccept = autoAccept
        self.receiveDirReady = receiveDirReady
        self.revoked = revoked
        self.canReceive = canReceive
        self.registeredAt = registeredAt
        self.key = key
    }
}

extension InboxView: Decodable {
    private enum CodingKeys: String, CodingKey {
        case presence = "Presence", lastHeartbeatAt = "LastHeartbeatAt"
        case presenceExpiresAt = "PresenceExpiresAt"
        case heartbeatIntervalSeconds = "HeartbeatIntervalSeconds"
        case protocolVersion = "ProtocolVersion", capabilities = "Capabilities"
        case receiveCapability = "ReceiveCapability", autoAccept = "AutoAccept"
        case receiveDirReady = "ReceiveDirReady", revoked = "Revoked"
        case canReceive = "CanReceive", registeredAt = "RegisteredAt", key = "Key"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        presence = try InboxWire.closed(InboxPresence.self,
                                        try c.decode(String.self, forKey: .presence),
                                        field: .presence)
        autoAccept = try InboxWire.closed(InboxAutoAccept.self,
                                          try c.decode(String.self, forKey: .autoAccept),
                                          field: .autoAccept)
        lastHeartbeatAt = try c.decode(Int64.self, forKey: .lastHeartbeatAt)
        presenceExpiresAt = try c.decode(Int64.self, forKey: .presenceExpiresAt)
        heartbeatIntervalSeconds = try c.decode(Int.self, forKey: .heartbeatIntervalSeconds)
        protocolVersion = try c.decode(Int.self, forKey: .protocolVersion)
        capabilities = try c.decode([String].self, forKey: .capabilities)
        receiveCapability = try c.decode(String.self, forKey: .receiveCapability)
        receiveDirReady = try c.decode(Bool.self, forKey: .receiveDirReady)
        revoked = try c.decode(Bool.self, forKey: .revoked)
        canReceive = try c.decode(Bool.self, forKey: .canReceive)
        registeredAt = try c.decode(Int64.self, forKey: .registeredAt)
        key = try c.decodeIfPresent(InboxKey.self, forKey: .key)
    }
}

/// One row of `GET /api/devices`, in the fields this client needs.
///
/// `isCurrent` is how a native client learns which device it IS: the id is
/// minted server-side when the login is approved, so the honest way to find it
/// is to ask which row the presented bearer authenticates as.
public struct InboxDeviceRow: Equatable, Sendable, Decodable {
    public let id: String
    public let name: String
    public let kind: String
    public let isCurrent: Bool
    public let inbox: InboxView?

    private enum CodingKeys: String, CodingKey {
        case id = "ID", name = "Name", kind = "Kind", isCurrent = "Current", inbox = "Inbox"
    }

    public init(id: String, name: String = "", kind: String = "",
                isCurrent: Bool = false, inbox: InboxView? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.isCurrent = isCurrent
        self.inbox = inbox
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decode(String.self, forKey: .kind)
        isCurrent = try c.decode(Bool.self, forKey: .isCurrent)
        inbox = try c.decodeIfPresent(InboxView.self, forKey: .inbox)
    }
}

/// The account-visible view of one queued delivery.
public struct InboxTask: Equatable, Sendable {
    public let id: String
    public let targetDeviceID: String
    public let sourceDeviceID: String
    public let idempotencyKey: String
    public let storedFileID: String
    public let state: InboxTaskState
    public let errorCode: InboxTaskErrorCode
    public let ciphertextBytes: Int64
    public let wrapAlgorithm: String
    public let targetKeyID: String
    public let targetKeyGeneration: Int64
    public let attempts: Int64
    public let leaseExpiresAt: Int64
    public let expiresAt: Int64
    public let savedAt: Int64
    public let isTerminal: Bool

    public init(id: String, targetDeviceID: String = "", sourceDeviceID: String = "",
                idempotencyKey: String = "",
                storedFileID: String = "",
                state: InboxTaskState, errorCode: InboxTaskErrorCode = .device(.none),
                ciphertextBytes: Int64 = 0,
                wrapAlgorithm: String = InboxProtocol.keyAlgorithm,
                targetKeyID: String = "", targetKeyGeneration: Int64 = 0,
                attempts: Int64 = 0, leaseExpiresAt: Int64 = 0, expiresAt: Int64 = 0,
                savedAt: Int64 = 0, isTerminal: Bool? = nil) {
        self.id = id
        self.targetDeviceID = targetDeviceID
        self.sourceDeviceID = sourceDeviceID
        self.idempotencyKey = idempotencyKey
        self.storedFileID = storedFileID
        self.state = state
        self.errorCode = errorCode
        self.ciphertextBytes = ciphertextBytes
        self.wrapAlgorithm = wrapAlgorithm
        self.targetKeyID = targetKeyID
        self.targetKeyGeneration = targetKeyGeneration
        self.attempts = attempts
        self.leaseExpiresAt = leaseExpiresAt
        self.expiresAt = expiresAt
        self.savedAt = savedAt
        self.isTerminal = isTerminal ?? state.isTerminal
    }
}

extension InboxTask: Decodable {
    fileprivate enum CodingKeys: String, CodingKey {
        case id = "ID", targetDeviceID = "TargetDeviceID", sourceDeviceID = "SourceDeviceID"
        case idempotencyKey = "IdempotencyKey", storedFileID = "StoredFileID"
        case state = "State", errorCode = "ErrorCode", ciphertextBytes = "CiphertextBytes"
        case wrapAlgorithm = "WrapAlgorithm", targetKeyID = "TargetKeyID"
        case targetKeyGeneration = "TargetKeyGeneration", attempts = "Attempts"
        case leaseExpiresAt = "LeaseExpiresAt", expiresAt = "ExpiresAt"
        case savedAt = "SavedAt", terminal = "Terminal"
        case encManifest = "EncManifest", wrappedKey = "WrappedKey", claimToken = "ClaimToken"
    }

    public init(from decoder: Decoder) throws {
        try self.init(container: decoder.container(keyedBy: CodingKeys.self))
    }

    fileprivate init(container c: KeyedDecodingContainer<CodingKeys>) throws {
        id = try c.decode(String.self, forKey: .id)
        state = try InboxWire.closed(InboxTaskState.self,
                                     try c.decode(String.self, forKey: .state),
                                     field: .taskState)
        let rawError = try c.decode(String.self, forKey: .errorCode)
        guard let code = InboxTaskErrorCode(rawValue: rawError) else {
            throw InboxError.unknownProtocolValue(field: .errorCode)
        }
        errorCode = code
        targetDeviceID = try c.decode(String.self, forKey: .targetDeviceID)
        sourceDeviceID = try c.decode(String.self, forKey: .sourceDeviceID)
        // Older receiver fixtures and pre-sender servers did not expose this
        // account-only field. Receiver reads remain backward-compatible, while
        // `InboxSenderClient.createTask` requires an exact non-empty match.
        idempotencyKey = try c.decodeIfPresent(String.self, forKey: .idempotencyKey) ?? ""
        storedFileID = try c.decode(String.self, forKey: .storedFileID)
        ciphertextBytes = try c.decode(Int64.self, forKey: .ciphertextBytes)
        wrapAlgorithm = try c.decode(String.self, forKey: .wrapAlgorithm)
        targetKeyID = try c.decode(String.self, forKey: .targetKeyID)
        targetKeyGeneration = try c.decode(Int64.self, forKey: .targetKeyGeneration)
        attempts = try c.decode(Int64.self, forKey: .attempts)
        leaseExpiresAt = try c.decode(Int64.self, forKey: .leaseExpiresAt)
        expiresAt = try c.decode(Int64.self, forKey: .expiresAt)
        savedAt = try c.decode(Int64.self, forKey: .savedAt)
        // Central's own terminal flag when it sends one, the state's otherwise.
        // Never a disagreement that silently prefers the flag: a `saved` row with
        // `Terminal: false` is still terminal here, because the STATE is the
        // thing the transition table is written against.
        isTerminal = try c.decode(Bool.self, forKey: .terminal) || state.isTerminal
    }
}

/// The claim response: a task plus the material only the target device may hold.
///
/// None of the three extra fields is ever written to disk or logged. The sealed
/// key and the manifest are the delivery; the claim token is a bearer for
/// advancing exactly this task under exactly this lease.
public struct InboxDelivery: Equatable, Sendable, Decodable {
    public let task: InboxTask
    /// Standard base64, matching `GET /api/files/{id}/meta`, so a client has one
    /// decoding rule for the manifest wherever it obtains it.
    public let encManifest: String
    /// Raw base64url, exactly `InboxProtocol.sealedBoxBytes` decoded.
    public let wrappedKey: String
    public let claimToken: String

    public init(task: InboxTask, encManifest: String, wrappedKey: String, claimToken: String) {
        self.task = task
        self.encManifest = encManifest
        self.wrappedKey = wrappedKey
        self.claimToken = claimToken
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: InboxTask.CodingKeys.self)
        task = try InboxTask(container: c)
        encManifest = try c.decode(String.self, forKey: .encManifest)
        wrappedKey = try c.decode(String.self, forKey: .wrappedKey)
        claimToken = try c.decode(String.self, forKey: .claimToken)
    }
}

/// What the two sides agreed on at enrolment. A client that cannot satisfy the
/// negotiated version/capability/algorithm must stop rather than guess.
public struct InboxEnrolResult: Equatable, Sendable, Decodable {
    public let inbox: InboxView
    public let protocolVersion: Int
    public let receiveCapability: String
    public let keyAlgorithm: String

    private enum CodingKeys: String, CodingKey {
        case inbox, protocolVersion, receiveCapability, keyAlgorithm
    }

    public init(inbox: InboxView, protocolVersion: Int,
                receiveCapability: String, keyAlgorithm: String) {
        self.inbox = inbox
        self.protocolVersion = protocolVersion
        self.receiveCapability = receiveCapability
        self.keyAlgorithm = keyAlgorithm
    }
}

/// The presence central recorded and the cadence it expects. The device follows
/// the advertised interval rather than a compiled-in guess that could drift.
public struct InboxHeartbeatResult: Equatable, Sendable, Decodable {
    public let presence: InboxPresence
    public let presenceExpiresAt: Int64
    public let heartbeatIntervalSeconds: Int

    private enum CodingKeys: String, CodingKey {
        case presence, presenceExpiresAt, heartbeatIntervalSeconds
    }

    public init(presence: InboxPresence, presenceExpiresAt: Int64 = 0,
                heartbeatIntervalSeconds: Int = 0) {
        self.presence = presence
        self.presenceExpiresAt = presenceExpiresAt
        self.heartbeatIntervalSeconds = heartbeatIntervalSeconds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        presence = try InboxWire.closed(InboxPresence.self,
                                        try c.decode(String.self, forKey: .presence),
                                        field: .presence)
        presenceExpiresAt = try c.decode(Int64.self, forKey: .presenceExpiresAt)
        heartbeatIntervalSeconds = try c.decode(Int.self, forKey: .heartbeatIntervalSeconds)
    }
}

/// The one place a wire string becomes a member of a closed set. The method
/// itself lives in `InboxError.swift`, beside the error it throws.
enum InboxWire {}
