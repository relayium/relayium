import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// Mapping local reality onto the closed set of things a device may tell central.
///
/// Two decisions are made here and nowhere else, and both are product decisions
/// rather than plumbing:
///
///   - WHICH CODE. `InboxDeviceErrorCode` is a closed vocabulary precisely so a
///     file name or a path can never reach central through an error message
///     (protocol §16). Every local error is therefore classified into a category,
///     and the local detail stays local.
///   - WHICH STATE. `failed_retryable` says "try me again"; `attention_required`
///     says "a person at this machine must do something"; `failed_terminal` says
///     "this will never work". Getting that wrong is worse than a wrong code: a
///     terminal misclassification silently drops a delivery, and a retryable one
///     burns eight attempts against a full disk nobody was told about.
///
/// The rule used throughout: if a RETRY OF THE SAME BYTES could plausibly succeed
/// without anyone doing anything, it is retryable. If it needs a person at this
/// Mac (space, permissions, a folder grant, a name), it is `attention_required`.
/// If the bytes themselves are the problem, it is terminal.

/// A classified local failure. `code` and `state` are what central is told; the
/// reason is a closed local token that never leaves this process.
public struct InboxFailure: Error, Equatable, Sendable {
    public let code: InboxDeviceErrorCode
    public let state: InboxTaskState
    public let reason: InboxFailureReason

    public init(code: InboxDeviceErrorCode, state: InboxTaskState, reason: InboxFailureReason) {
        self.code = code
        self.state = state
        self.reason = reason
    }

    static func retryable(_ code: InboxDeviceErrorCode, _ reason: InboxFailureReason) -> InboxFailure {
        InboxFailure(code: code, state: .failedRetryable, reason: reason)
    }
    static func terminal(_ code: InboxDeviceErrorCode, _ reason: InboxFailureReason) -> InboxFailure {
        InboxFailure(code: code, state: .failedTerminal, reason: reason)
    }
    static func attention(_ code: InboxDeviceErrorCode, _ reason: InboxFailureReason) -> InboxFailure {
        InboxFailure(code: code, state: .attentionRequired, reason: reason)
    }
}

/// Why, in this device's own closed vocabulary.
///
/// A token rather than a message, for the same reason the protocol's error set is
/// closed: this value is what a log line and a future UI are allowed to see, and
/// a string would eventually carry a file name into one of them.
public enum InboxFailureReason: String, Equatable, Sendable {
    case noLocalPrivateKey
    case wrappedKeyUnusable
    case manifestUnreadable
    case manifestInvalid
    case manifestExceedsCiphertext
    case unsafeManifestName
    case duplicateDestination
    case noFreeName
    case destinationOccupied
    case directoryUnavailable
    case notEnoughSpace
    case diskFull
    case permissionDenied
    case truncatedStream
    case tamperedStream
    case stagedSizeMismatch
    case downloadFailed
    case rangeIgnored
    case journalUnreadable
    case journalWriteFailed
    case receiveFolderChanged
    case unexpected
}

/// Stop working this task and report NOTHING.
///
/// Raised when central has already taken the task away — the lease was reclaimed
/// and handed to another worker (`stale_claim`), or the task reached a terminal
/// state. A report in either case would be rejected at best, and at worst a stale
/// worker asserting something about work it no longer holds. Silence is the
/// correct and only safe response.
public struct InboxAbandon: Error, Equatable, Sendable {
    public enum Cause: String, Equatable, Sendable {
        case staleClaim
        case taskTerminal
        case storedObjectUnavailable
        case leaseRenewalRefused
    }
    public let cause: Cause
    public init(_ cause: Cause) { self.cause = cause }
}

public enum InboxClassify {
    /// Turn a filesystem or commit error into the honest category.
    ///
    /// The `attention_required` outcomes are the PRD §10 item 8 list verbatim —
    /// folder permissions, disk space, or a name a person has to resolve —
    /// because each is a condition this Mac genuinely cannot clear on its own, and
    /// retrying would consume the attempt budget while the sender's UI showed
    /// nothing actionable.
    public static func filesystem(_ error: Error) -> InboxFailure {
        if let failure = error as? InboxFailure { return failure }
        switch error {
        case let e as InboxCommitError:
            switch e {
            case .destinationOccupied:
                return .attention(.nameConflict, .destinationOccupied)
            case .directoryUnavailable, .crossDevice:
                return .attention(.directoryUnavailable, .directoryUnavailable)
            case .system(let code):
                return posix(code)
            }
        case let e as InboxPlanError:
            switch e {
            case .unsafeName:
                // The manifest itself is the problem, and the same manifest is
                // the same problem on every retry.
                return .terminal(.verifyFailed, .unsafeManifestName)
            case .duplicateDestination:
                return .terminal(.verifyFailed, .duplicateDestination)
            case .noFreeName:
                return .attention(.nameConflict, .noFreeName)
            }
        case let e as InboxJournalError:
            switch e {
            case .invalidTaskID: return .terminal(.internal, .journalUnreadable)
            case .unreadable: return .retryable(.internal, .journalUnreadable)
            case .system(let code): return posix(code, journalWrite: true)
            }
        case let e as InboxStagingError:
            return posix(e.code)
        default:
            // A Cocoa or POSIX wrapper from Foundation. Unwrapping it is not
            // tidiness: without this a read-only receive folder reads as
            // "internal", which is retryable — so the delivery would burn its
            // whole attempt budget against a condition no retry can change,
            // while the sender's UI showed nothing a person could act on.
            if let code = InboxPosix.code(of: error) { return posix(code) }
            return .retryable(.internal, .unexpected)
        }
    }

    /// A raw `errno`, categorised.
    static func posix(_ code: Int32, journalWrite: Bool = false) -> InboxFailure {
        switch code {
        case ENOSPC, EDQUOT:
            return .attention(.diskFull, .diskFull)
        case EACCES, EPERM, EROFS:
            return .attention(.permissionDenied, .permissionDenied)
        case ENOENT, ENOTDIR, ELOOP, ENXIO, EIO:
            return .attention(.directoryUnavailable, .directoryUnavailable)
        case EEXIST:
            return .attention(.nameConflict, .destinationOccupied)
        default:
            return .retryable(.internal, journalWrite ? .journalWriteFailed : .unexpected)
        }
    }

    /// Categorise a decryption or verification failure.
    ///
    /// AEAD rejection is TERMINAL: the ciphertext on central does not change
    /// between attempts, so a frame that failed authentication once fails
    /// identically eight more times. A length/framing mismatch is RETRYABLE —
    /// that is what a truncated TRANSFER looks like, and the next attempt gets a
    /// fresh stream.
    public static func crypto(_ error: Error) -> InboxFailure {
        if let failure = error as? InboxFailure { return failure }
        switch error {
        case let e as InboxKeyError:
            switch e {
            case .unseal, .unsupportedAlgorithm, .malformedKeyMaterial,
                 .unusablePublicKey, .generationFailed:
                return .terminal(.decryptFailed, .wrappedKeyUnusable)
            }
        case let e as StoredWireError:
            switch e {
            case .truncatedStream:
                // Ambiguous by design in `StoreDecryptor`: an authentication
                // failure and a dangling partial frame share this case. Retryable
                // is the safe reading — a genuinely tampered blob then costs the
                // attempt budget and ends as `attempts_exhausted`, whereas calling
                // a truncated TRANSFER terminal would drop a delivery a reconnect
                // would have completed.
                return .retryable(.verifyFailed, .truncatedStream)
            case .lengthMismatch:
                return .retryable(.verifyFailed, .truncatedStream)
            case .frameTooLarge:
                return .terminal(.verifyFailed, .tamperedStream)
            case .invalidManifest:
                return .terminal(.verifyFailed, .manifestInvalid)
            case .invalidKey:
                return .terminal(.decryptFailed, .wrappedKeyUnusable)
            }
        default:
            return .retryable(.internal, .unexpected)
        }
    }

    /// Categorise a failure to obtain the ciphertext. Everything here is
    /// retryable by definition; a permanently missing object is central's
    /// judgement to make (`stored_object_unavailable`), not this device's.
    public static func transport(_ error: Error) -> InboxFailure {
        if let failure = error as? InboxFailure { return failure }
        if case InboxError.rangeIgnored = error {
            return .retryable(.downloadFailed, .rangeIgnored)
        }
        return .retryable(.downloadFailed, .downloadFailed)
    }
}

/// A staging failure carrying the `errno` that produced it.
public struct InboxStagingError: Error, Equatable, Sendable {
    public let code: Int32
    public init(_ code: Int32) { self.code = code }
}

/// Recovering the POSIX reason from a Foundation error.
///
/// `FileManager` reports a full disk and a permission refusal as the SAME
/// `CocoaError` domain, distinguished only by an underlying `NSPOSIXErrorDomain`
/// error a caller has to go and look for. Since the code decides whether a
/// delivery is parked for a person or retried pointlessly, looking is required.
enum InboxPosix {
    static func code(of error: Error) -> Int32? {
        if let posix = error as? POSIXError { return posix.code.rawValue }
        let ns = error as NSError
        if ns.domain == NSPOSIXErrorDomain { return Int32(ns.code) }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            return code(of: underlying)
        }
        return nil
    }
}

/// Free-space preflight, refused BEFORE anything is downloaded so a doomed
/// transfer does not fill the disk on its way to failing.
///
/// Slack is added because "exactly enough" is not enough: the staged copy, the
/// journal and the filesystem's own metadata all need room, and a receive folder
/// driven to zero free bytes takes the rest of the Mac with it. Where free space
/// cannot be read the check is SKIPPED rather than guessed — the commit path
/// still fails closed on a real `ENOSPC`.
public enum InboxSpace {
    public static let slack: Int64 = 16 << 20

    public static func hasRoom(at url: URL, for need: Int64,
                               freeBytes: (URL) -> Int64?) -> Bool {
        guard let free = freeBytes(url) else { return true }
        return need + slack <= free
    }

    @Sendable
    public static func freeBytes(_ url: URL) -> Int64? {
        var fs = statfs()
        guard statfs(url.path, &fs) == 0 else { return nil }
        return Int64(fs.f_bavail) * Int64(fs.f_bsize)
    }
}
