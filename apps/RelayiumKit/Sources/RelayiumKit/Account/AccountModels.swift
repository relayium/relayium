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

public enum AccountError: Error, Equatable {
    case invalidCredentials      // 401
    case rateLimited             // 429
    case server(status: Int)     // other non-2xx
    case decoding                // body didn't match the expected shape
    case network                 // URLSession transport error
}
