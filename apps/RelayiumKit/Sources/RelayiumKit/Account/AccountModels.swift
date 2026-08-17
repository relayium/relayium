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
    /// Which provider the entitlement comes from: `"stripe"`, `"apple"`,
    /// `"admin"`, `"multiple"` (more than one live at once), or `""`/absent.
    ///
    /// Deliberately OPTIONAL, unlike every field above it. Those are always
    /// emitted by `/api/me` and so are decoded strictly; this one is not
    /// present at all in a response from a server that predates it, and a
    /// client that refused those payloads would lock users out of an app that
    /// merely shipped ahead of the deployment. Absent and `""` mean the same
    /// thing — no paid provider — so no caller needs to tell them apart.
    ///
    /// Distinct from ``hasBilling``, which stays "this account has a Stripe
    /// customer, so the web Billing Portal is reachable".
    public var entitlementProvider: String? = nil
    public var appleRenewal: AppleRenewalInfo? = nil
}

public struct AppleRenewalInfo: Codable, Equatable, Sendable {
    public var available: Bool
    public var currentProductId: String?
    public var renewalProductId: String?
    public var renewalAt: Int64?
    public var inBillingRetry: Bool?
    public var inGracePeriod: Bool?
    public var graceUntil: Int64?
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
    /// See ``NativeUser/entitlementProvider``: same values, same optionality,
    /// same reason. `/api/me/usage` carries it so the plan card can decide
    /// whether a billing control is honest without a second request.
    public var entitlementProvider: String? = nil
    public var appleRenewal: AppleRenewalInfo? = nil
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

/// The 200 body of `POST /api/auth/register`: `{status,email}`.
///
/// `status` is decoded rather than ignored because it is the only thing that
/// distinguishes this response from some other 200 a proxy or a future endpoint
/// might return, and "the account was created" is not a claim to make on the
/// strength of a status code alone.
public struct RegistrationSuccessBody: Codable, Equatable {
    public var status: String
    /// Absent only from a server that stops sending it; the caller falls back to
    /// the address that was typed.
    public var email: String?

    public init(status: String, email: String?) {
        self.status = status
        self.email = email
    }
}

/// What a successful registration established: an account exists, no session
/// was issued, and one verification email is on its way.
///
/// It carries the address rather than nothing because the address it carries is
/// the **server's** normalization of what was typed — lower-cased and trimmed.
/// Showing the typed text instead is how a stray capital or a trailing space
/// becomes a user searching the wrong mailbox for an email that did arrive.
public struct RegistrationOutcome: Equatable {
    public let email: String

    public init(email: String) { self.email = email }
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
    /// The last network address the SERVER observed this credential being used
    /// from, exactly as `deviceView.LastIP` emits it — an address only, never a
    /// port and never a forwarded-header string.
    ///
    /// "" means the server has none: the credential has not been used since it
    /// was issued, or the response came from a build that predates the field.
    /// It is an identification hint for the account owner and nothing more: it
    /// may be a NAT, carrier or VPN address, so no surface may present it as a
    /// location. It is deliberately NOT the local interface address this app
    /// can enumerate for LAN transfer — that one describes this machine, and
    /// this one describes what central saw.
    public var lastIP: String

    public init(id: String, name: String, createdAt: Int64, lastSeenAt: Int64,
                kind: String, current: Bool, lastIP: String = "") {
        self.id = id; self.name = name; self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt; self.kind = kind; self.current = current
        self.lastIP = lastIP
    }

    enum CodingKeys: String, CodingKey {
        case id = "ID", name = "Name", createdAt = "CreatedAt"
        case lastSeenAt = "LastSeenAt", kind = "Kind", current = "Current"
        case lastIP = "LastIP"
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
        lastIP = try c.decodeIfPresent(String.self, forKey: .lastIP) ?? ""
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

    // MARK: - Registration
    //
    // Four refusals of `POST /api/auth/register`, each one a different thing for
    // the user to do next. Collapsing them into `.server(status:)` would put
    // "400" on screen where "that address is already registered — sign in
    // instead" belongs, which is the one failure a new user is most likely to
    // hit and the only one with a one-tap remedy.

    /// 400 `invalid_email` — the server could not parse the address.
    case emailInvalid
    /// 400 `password too short` — under the server's 8-byte minimum. The form
    /// checks the same rule first, so reaching this means the two disagreed.
    case passwordTooShort
    /// 409 `email already registered`.
    case emailTaken
    /// 409 `account_pending_deletion` — an account on this address (or its
    /// canonical sibling) is inside its deletion grace period. Registering again
    /// is refused so a second account cannot occupy an address the original
    /// owner may still reactivate into.
    case accountPendingDeletion

    // MARK: - Sign in with Apple
    //
    // Two cases, not one, and neither is `invalidCredentials`: no email and no
    // password was involved in an Apple authorization, so that error's copy
    // ("check your email and password") would name two fields the user never
    // touched and send them looking for a mistake they did not make.

    /// 401 — the server refused the Apple credential. The identity token failed
    /// verification, its audience was not this app's, the one-time
    /// authorization code was used/expired/invalid, or the token Apple returned
    /// for the code described a different authorization. All four are the same
    /// thing to the user: this attempt did not establish a sign-in.
    case appleRejected
    /// 502/503 — the exchange could not be completed at all: Apple was
    /// unreachable, or the server holds no Apple signing key. Nothing about the
    /// user's Apple ID is wrong, so a retry can work.
    case appleUnavailable
    /// 400 `no_email_first_signin` — this Apple identity has never been linked
    /// here, but Apple returned no address with which to create or find its
    /// account. The remedy lives in the device's Sign in with Apple settings,
    /// not in an HTTP status shown to the user.
    case appleEmailUnavailable
}
