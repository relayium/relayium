import Foundation
import RelayiumKit

/// Every user-facing error string in the native apps.
///
/// No error type in RelayiumKit implements `LocalizedError`, so
/// `localizedDescription` on any of them is a useless type name. This is not a
/// polish layer — without it the UI has nothing to show.
///
/// The shape matters as much as the contents: G3 will route `ConnectionError`,
/// `HandshakeError`, `RealtimeError`, `RealtimeSenderError` and bare WebRTC
/// `NSError`s through a single `((Error) -> Void)` callback. Extending a layered
/// chain that already has a total fallback beats inventing one under pressure.
public enum ErrorCopy {
    public static func message(for error: Error) -> String {
        if let e = error as? AccountError {
            switch e {
            case .invalidCredentials:
                return "That email and password don't match an account."
            case .rateLimited:
                return "Too many attempts. Wait a minute, then try again."
            case .server(let status):
                return "The server returned an error (\(status)). Try again shortly."
            case .decoding:
                return "The server sent a response this version of the app doesn't understand. Updating may fix it."
            case .network:
                return "Couldn't reach the server. Check your internet connection."
            }
        }
        if let e = error as? KeychainError {
            switch e {
            case .status(let s):
                return "macOS wouldn't store your sign-in (keychain error \(s)). You'll stay signed in until you quit."
            }
        }
        // Total by construction: name the type so a bug report is actionable.
        return "Something went wrong (\(type(of: error)))."
    }
}
