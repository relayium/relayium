import Foundation
import RelayiumKit

/// Wiring: the few constants and factory calls the SwiftUI layer would otherwise
/// hard-code, kept here so tests and the iOS app in R3 can point elsewhere.
public enum AppEnvironment {
    public static let productionBaseURL = URL(string: "https://relayium.com")!
    public static let keychainService = "com.relayium.mac"
    public static let keychainAccount = "bearer-token"

    /// The user-visible computer name, so the web device list reads the way the
    /// person expects rather than showing a hostname they never chose.
    ///
    /// `Host` is a macOS API; this target also builds for iOS 16 (R3), where the
    /// device's own name is the right answer.
    public static func deviceName() -> String {
        #if os(macOS)
        let name = Host.current().localizedName ?? ""
        return name.isEmpty ? "Mac" : name
        #else
        let name = ProcessInfo.processInfo.hostName
        return name.isEmpty ? "iPhone" : name
        #endif
    }

    @MainActor
    public static func makeSession(baseURL: URL = productionBaseURL) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: baseURL),
            tokenStore: KeychainTokenStore(service: keychainService, account: keychainAccount),
            deviceName: deviceName()
        )
    }
}
