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
            case .notSignedIn:
                // Says why rather than just refusing: the asymmetry is the
                // server's billing policy — whoever creates a code pays for any
                // traffic relayed through it — and a user who can receive fine
                // deserves to know why sending is different.
                return "Sign in to create a pairing code. You can still receive files with a code someone shares with you."
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
        if let e = error as? HandshakeError {
            switch e {
            case .mitm:
                // The sharpest wording in the app, and the only error here that
                // means someone may be attacking the user. No retry, no
                // reconnect: the instruction is to stop and pair again, because
                // reconnecting means reconnecting to whoever that was.
                return "The two devices could not agree on a shared secret. Someone may be interfering with this connection — stop, and pair again with a new code."
            case .noCommitRecorded, .badBase64, .invalidKey:
                return "The other device sent something this version of the app doesn't understand. Both sides may need updating."
            }
        }
        if let e = error as? RealtimeError {
            switch e {
            case .tamper:
                return "The data that arrived didn't match what the sender described, so it was discarded. Ask them to send it again."
            case .outOfOrder, .malformed:
                return "The connection dropped part of the transfer. Nothing was saved — try again."
            case .legacyPeer:
                return "The other device is running an older version that can't complete this transfer. It needs updating."
            case .unknownKind:
                return "The other device sent something this version of the app doesn't understand. Both sides may need updating."
            }
        }
        if let e = error as? RealtimeSenderError {
            switch e {
            case .manifestTooLarge:
                return "Too many files at once for a single transfer. Send them in smaller batches."
            case .sourceShorterThanDeclared(let name):
                // Almost always a file edited or deleted mid-send.
                return "“\(name)” changed while it was being sent, so the transfer was stopped. Try again."
            }
        }
        if let e = error as? DeviceAuthOutcomeError {
            switch e {
            case .denied:
                return "That sign-in was declined in the browser. Try again if that wasn't you."
            case .expired:
                // Nobody's mistake — the request simply went unanswered. Copy
                // that read as a rejection would send the user looking for one.
                return "The sign-in request timed out. Start again to get a new one."
            }
        }
        if let e = error as? DownloadDestinationError {
            switch e {
            case .directoryExists(let name):
                // A bare "refused" reads as a bug. Say what it found and why it
                // will not merge: it cannot tell a leftover partial download from
                // files the user put there.
                return "“\(name)” already exists here — this link was downloaded to this folder before. Choose another folder: the app won't merge into an existing one, because it can't tell a half-finished download from your own files."
            case .unsafeName(let name):
                return "The link describes a file named “\(name)” that would be written outside the folder you chose, so nothing was saved. Ask the sender for a new link."
            }
        }
        if let e = error as? CloudError {
            switch e {
            case .unauthorized:
                return "Your sign-in expired. Sign in again to send files."
            case .quota:
                return "Not enough space or daily quota left for this file. Free up space or upgrade."
            case .rateLimited:
                return "Too many uploads right now. Wait a minute, then try again."
            case .dailyQuota:
                // Not "you've used too much": the gate is used + this file >
                // quota, so one large file can trip it on its own with nothing
                // else sent today. The wording has to cover both.
                return "This file needs more than your remaining daily upload allowance — a single large file can use it all on its own. Try again tomorrow, or upgrade for a bigger daily allowance."
            case .monthlyTraffic:
                return "Your account has reached its monthly traffic limit. Uploads resume next month, or upgrade to continue now."
            case .notFound:
                return "This link has expired, was already downloaded, or was mistyped."
            case .server(let status):
                return "The server returned an error (\(status)). Try again shortly."
            case .network:
                return "Couldn't reach the server. Check your internet connection."
            case .decoding:
                return "The server sent a response this version of the app doesn't understand. Updating may fix it."
            }
        }
        if let e = error as? StoredWireError {
            switch e {
            case .invalidKey:
                return "That link's key is malformed — it was probably copied incompletely."
            case .frameTooLarge, .truncatedStream, .lengthMismatch:
                // Not transient: the bytes did not match the manifest. Inviting a
                // retry would send the user back for the same corrupt data.
                return "The downloaded data didn't match what the link described, so it was discarded. Ask the sender for a new link."
            }
        }
        // Total by construction: name the type so a bug report is actionable.
        return "Something went wrong (\(type(of: error)))."
    }
}
