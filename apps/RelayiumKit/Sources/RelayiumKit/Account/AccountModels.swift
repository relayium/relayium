import Foundation

public struct NativeUser: Codable, Equatable {
    public var id: String
    public var email: String
    public var displayName: String
    public var hasPassword: Bool
    public var emailVerified: Bool
    public var linkedMethods: [String]
    public var onlyOwnNodes: Bool
    public var planId: String
    public var subscriptionStatus: String
    public var subscriptionEnd: Int64
    public var hasBilling: Bool
    public var scheduledPlanId: String
    public var scheduledCycle: String
    public var billingCycle: String
}

public struct MeResponse: Codable, Equatable { public let user: NativeUser }

/// The 6-field user shape emitted by `finishNativeLogin` (native password login
/// and Apple native login share this path) — NOT the full 14-field `NativeUser`.
/// Only `/api/me` sends the billing fields.
public struct LoginUser: Codable, Equatable {
    public var id: String
    public var email: String
    public var displayName: String
    public var hasPassword: Bool
    public var emailVerified: Bool
    public var linkedMethods: [String]
}

public struct Meter: Codable, Equatable {
    public var used: Int64
    public var cap: Int64                      // 0 == unlimited
    public var isUnlimited: Bool { cap == 0 }
}

public struct PlanInfo: Codable, Equatable {
    public var id: String
    public var name: String
    public var storageBytes: Int64
    public var trafficBytes: Int64
    public var retentionSecs: Int64
    public var priceMonthly: Int64
    public var priceYearly: Int64
    public var isTop: Bool
    public var subscriptionStatus: String
    public var subscriptionEnd: Int64
    public var billingCycle: String
    public var scheduledPlanId: String
    public var scheduledPlanName: String
    public var scheduledCycle: String
}

public struct UsageResponse: Codable, Equatable {
    public var period: String                  // "200601"-format, e.g. "202607"
    public var resetsAt: Int64
    public var traffic: Meter
    public var storage: Meter
    public var plan: PlanInfo
}

/// The 200-success login body (`{token, user}`). Decoded only on the 200 path.
public struct LoginSuccessBody: Codable, Equatable {
    public var token: String
    public var user: LoginUser
}

public enum LoginOutcome: Equatable {
    case success(token: String, user: LoginUser)
    case emailUnverified(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)
}

/// One row of `GET /api/devices`: a machine that has signed in to this account.
///
/// The wire keys are Go's default capitalization (`ID`, `Name`, …) because that
/// response predates any client that asked for lowerCamel, and the web reads it
/// in exactly that shape. Spelling them out here rather than renaming the server
/// keeps one shipped contract instead of two.
public struct AccountDevice: Codable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var createdAt: Int64
    /// 0 means the credential has never been used since it was issued — the
    /// state most worth revoking, so it is preserved rather than shown as 1970.
    public var lastSeenAt: Int64
    /// "cli", "app", or "browser"/"" for a row the website registered itself.
    public var kind: String
    /// True for the device whose bearer token made the request that returned
    /// this row. Never true for a cookie-authenticated (browser) request.
    public var current: Bool

    public init(id: String, name: String, createdAt: Int64, lastSeenAt: Int64,
                kind: String, current: Bool) {
        self.id = id; self.name = name; self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt; self.kind = kind; self.current = current
    }

    enum CodingKeys: String, CodingKey {
        case id = "ID", name = "Name", createdAt = "CreatedAt"
        case lastSeenAt = "LastSeenAt", kind = "Kind", current = "Current"
    }

    /// Hand-written so that only `ID` is actually required. A server that
    /// predates `Current` — or that stops sending a field this app never
    /// displays — must not make the whole Account tab fail to load; the list it
    /// did send is still true.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        lastSeenAt = try c.decodeIfPresent(Int64.self, forKey: .lastSeenAt) ?? 0
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        current = try c.decodeIfPresent(Bool.self, forKey: .current) ?? false
    }
}

extension AccountDevice {
    /// Whether this row represents a credential that can be carried off a
    /// machine and revoked — a CLI login or a native app.
    ///
    /// Browser rows are excluded, and that is the whole point of the predicate:
    /// the website registers one automatically, they hold a session cookie
    /// rather than a token, and listing them buries the two or three rows the
    /// user actually needs to see under one per browser they ever used.
    public var holdsRevocableToken: Bool { kind == "cli" || kind == "app" }
}

public struct DeviceListResponse: Codable, Equatable {
    public var devices: [AccountDevice]
    public init(devices: [AccountDevice]) { self.devices = devices }
}

/// One row of `GET /api/files`: an encrypted object this account has stored.
///
/// Every field is something the server genuinely knows. There is deliberately no
/// name and no content type — the manifest that holds those is itself encrypted
/// with a key the server never sees, so a name here could only be a guess.
public struct StoredFileSummary: Codable, Equatable, Identifiable {
    public var id: String
    /// Ciphertext length, not plaintext: it is what the account is billed for
    /// and what the server can measure.
    public var size: Int64
    public var createdAt: Int64
    public var expiresAt: Int64
    public var burnAfterRead: Bool
    public var downloaded: Bool
    public var downloadCount: Int

    public init(id: String, size: Int64, createdAt: Int64, expiresAt: Int64,
                burnAfterRead: Bool, downloaded: Bool, downloadCount: Int) {
        self.id = id; self.size = size; self.createdAt = createdAt
        self.expiresAt = expiresAt; self.burnAfterRead = burnAfterRead
        self.downloaded = downloaded; self.downloadCount = downloadCount
    }
}

public struct StoredFileListResponse: Codable, Equatable {
    public var files: [StoredFileSummary]
    public init(files: [StoredFileSummary]) { self.files = files }
}

public enum AccountError: Error, Equatable {
    case invalidCredentials      // 401 from a credential exchange
    /// 401 from an endpoint that needed an account, not a password — minting a
    /// pairing code, chiefly. Distinct from `invalidCredentials` because the
    /// copy for that one talks about an email and password the user never typed.
    case notSignedIn
    case rateLimited             // 429
    case server(status: Int)     // other non-2xx
    case decoding                // body didn't match the expected shape
    case network                 // URLSession transport error
}
