import Foundation

/// Where a bearer credential lives in the data-protection keychain.
///
/// A value rather than three loose constants because the answer is per
/// platform, and a per-platform answer spread across `#if` at each call site is
/// one no test can read. Everything here is inert data; the only compile-time
/// conditional in the whole policy is `AppEnvironment.currentKeychainPlatform`.
public struct KeychainConfiguration: Equatable, Sendable {
    public let service: String
    public let account: String
    /// `nil` means "this app's own default access group", which is the ONLY
    /// correct value on a host carrying no `keychain-access-groups` entitlement:
    /// naming a group without it fails with `errSecMissingEntitlement` (-34018)
    /// on a signed device build, and claims a cross-app credential share that
    /// does not exist.
    public let accessGroup: String?

    public init(service: String, account: String, accessGroup: String?) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }
}

/// The platforms the Relayium apps run on, as data.
///
/// `CaseIterable` so a test can prove every platform has a decision rather than
/// only the two somebody remembered to assert.
public enum KeychainPlatform: String, CaseIterable, Sendable {
    case macOS
    case iOS
}
