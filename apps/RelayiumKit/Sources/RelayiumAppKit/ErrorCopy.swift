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
            case .outOfOrder, .malformed, .lengthMismatch:
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
            case .invalidManifest:
                return "The selected files could not be described safely, so the transfer was not started."
            case .sourceShorterThanDeclared(let name):
                // Almost always a file edited or deleted mid-send.
                return "“\(name)” changed while it was being sent, so the transfer was stopped. Try again."
            case .sourceLongerThanDeclared(let name):
                return "“\(name)” grew after it was selected, so bytes outside the approved file list were not sent. Choose it again and retry."
            }
        }
        if let e = error as? RealtimeConnection.ConnectionError {
            switch e {
            case .peerBusy:
                return "The other device is already in a transfer. Wait for it to finish, then try again."
            case .unsupportedPeer:
                return "The other device does not support encrypted text sessions yet. It may need updating."
            case .peerConnectionFailed, .notReady:
                return "The private connection could not be opened. Check both devices are online, then try again."
            case .alreadySending:
                return "This connection is already sending. Start a new session for another transfer."
            case .rejected:
                return "The other device declined this transfer."
            case .timedOut:
                return "The other device stopped responding, so the session ended."
            case .textSendBufferFull:
                return "The connection is catching up. Wait a moment, then send the message again."
            case .textSendFailed:
                return "The encrypted message could not be sent. Try it again."
            case .textReceiveBufferFull:
                return "The other device sent too much before verification finished, so the session was closed."
            }
        }
        if let e = error as? RealtimeConnectionFactory.FactoryError {
            switch e {
            case .noPeerAppeared:
                return "Nobody joined before the pairing code expired. Create a new code and try again."
            case .unsupportedPeer:
                return "The other device does not support encrypted text sessions yet. It may need updating."
            }
        }
        if let e = error as? NearbyError {
            switch e {
            case .notScanning:
                return "Relayium stopped looking for nearby devices, so that one is no longer available. Scan again, then pick it."
            case .noAnswer:
                // Recovery steps, not a diagnosis: the roster proves the two
                // devices reached the same rendezvous, so "you're not on the
                // same network" would be a claim this code cannot make. What it
                // can say is what makes a device answer — a listening peer,
                // which today means relayium.com — and where to go instead.
                return "That device didn't answer. Open relayium.com on it, keep that page open, and pick it again. A pairing code works instead, and is the way to receive on this Mac."
            }
        }
        if let e = error as? RealtimeStagingError {
            switch e {
            case .fileCount:
                return "Choose between 1 and \(MAX_FILES) files."
            case .unreadable:
                return "Couldn't open every selected file, so nothing was sent. Choose the files again."
            }
        }
        if let e = error as? RealtimeTextError {
            switch e {
            case .authenticationFailed:
                return "The encrypted message failed its integrity check, so it was discarded and the session was closed."
            case .outOfOrder:
                return "The connection dropped or reordered a message, so the session was closed without showing it."
            case .messageTooLarge:
                return "The other device sent a message larger than this version supports, so the session was closed."
            case .invalidKey, .malformedFrame, .wrongKind, .sequenceExhausted, .invalidUTF8:
                return "The other device sent an invalid encrypted message, so it was discarded and the session was closed."
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
            case .fileExists(let name):
                return "“\(name)” already exists in the destination. Choose another folder; Relayium will not overwrite it."
            case .exceedsManifest, .incomplete:
                return "The received byte count did not match the file list, so the incomplete files were discarded. Ask the sender to try again."
            case .systemError(let code):
                // Names the two a user can actually act on and keeps the number
                // for everything else — "something went wrong" on a full disk
                // sends people looking in the wrong place.
                if code == ENOSPC {
                    return "There isn't enough free space to save this transfer, so nothing was saved. Free up space and try again."
                }
                if code == EACCES || code == EPERM {
                    return "Relayium isn't allowed to write to that folder, so nothing was saved. Choose another folder."
                }
                return "The destination folder couldn't be written to (error \(code)), so nothing was saved. Try another folder."
            }
        }
        if let e = error as? ManifestPathError {
            switch e {
            case .unsafePath(let path):
                // Names the path rather than saying "invalid": on the receiving
                // end this is the one message that lets the user tell a broken
                // sender from an attempt to write outside the folder they chose.
                return "The other device described a file at “\(path)”, which would be written outside the folder you chose. Nothing was saved."
            case .duplicatePath(let path):
                return "The transfer contains more than one file at “\(path)” — on this Mac those are the same file — so nothing was saved. Ask the sender to rename one of them."
            case .pathCollision(let path):
                return "The transfer wants “\(path)” to be both a file and a folder, which cannot exist at once, so nothing was saved. Ask the sender to try again."
            }
        }
        if let e = error as? PlaintextSourceError {
            switch e {
            case .unreadable(let name):
                return "Couldn't open “\(name)”, so nothing was sent. Check the file still exists and you have permission to read it."
            case .readFailed(let name, _):
                return "Reading “\(name)” failed part-way through, so the transfer was stopped. The other device discarded the incomplete file."
            case .tooManyOpenFiles(let limit):
                // Says what to do rather than naming a rlimit: the actionable
                // half is "send fewer files at once".
                return "This Mac ran out of open-file handles part-way through your selection (its limit is \(limit)). Relayium holds every selected file open so the exact files you chose are the ones that get sent, so send them in smaller batches."
            }
        }
        if let e = error as? FileSelectionError {
            switch e {
            case .noFiles:
                // Distinct from the count error on purpose: "choose between 1
                // and 1000 files" is baffling advice for someone who did choose
                // a folder — it just has nothing in it.
                return "There are no files to send. An empty folder can't be transferred on its own — the file list has no way to describe a folder with nothing in it."
            case .tooManyFiles:
                return "That selection holds more than \(MAX_FILES) files. Send fewer files, or zip the folder first."
            case .unreadable(let name):
                return "Couldn't read “\(name)”, so nothing was sent. Check the item still exists and you have permission to open it."
            case .symbolicLink(let name):
                // Neither choice is silent: following the link would send a
                // different tree (possibly from outside what was selected) and
                // skipping it would send an incomplete one without saying so.
                return "“\(name)” is a symbolic link. Relayium won't follow it — that could send files from outside what you chose — and won't skip it silently either. Remove it from the selection, or send the real folder it points at."
            case .pathTooLong(let path):
                return "The path “\(path)” is too long to describe in a transfer. Send from a shallower folder, or shorten the names."
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
            case .invalidManifest, .frameTooLarge, .truncatedStream, .lengthMismatch:
                // Not transient: the bytes did not match the manifest. Inviting a
                // retry would send the user back for the same corrupt data.
                return "The downloaded data didn't match what the link described, so it was discarded. Ask the sender for a new link."
            }
        }
        // Total by construction: name the type so a bug report is actionable.
        return "Something went wrong (\(type(of: error)))."
    }
}
