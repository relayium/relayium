import Foundation
import RelayiumKit
import RelayiumShareKit

/// Which stored-link-key operation a failure belongs to.
///
/// Three cases rather than one because the consequence differs: a failed save
/// means the key exists only in the link on screen, a failed read means a key
/// that may well be here cannot be reached, and a failed remove means an
/// obsolete key outlived the ciphertext it belonged to. Only the first is
/// something the user has to act on now.
public enum StoredLinkKeyOperation {
    case save, read, remove
}

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
///
/// ## Localization
///
/// Every arm resolves an `L10nKey` rather than returning a literal. The
/// `language` argument is optional and defaults to `L10n.current`, so no call
/// site changed — but it exists, and it is the reason a test can assert the
/// Arabic wording of a MITM warning without touching the machine's settings.
///
/// Values interpolated into these sentences are the user's or the peer's, or
/// they are diagnostics: file names, manifest paths, HTTP statuses, an OSStatus,
/// an errno, a file-count limit. They are never translated, and they go through
/// `L10n.token` so Arabic lays each one out as one unit instead of letting the
/// bidi algorithm rearrange a path around the sentence.
public enum ErrorCopy {
    /// Copy for a failure of the store holding each upload's E2E key.
    ///
    /// It exists because both types these paths raise carry somebody else's
    /// meaning by default.
    ///
    /// `KeychainError` is raised by two stores that mean entirely different
    /// things by it. `KeychainTokenStore` holds this device's bearer, so
    /// `message(for:)`'s wording — the sign-in was not stored, you will stay
    /// signed in until you quit — is exactly right there and is left alone.
    /// `KeychainStoredLinkKeyStore` holds one file's key, and for it that same
    /// sentence is false three times over: no sign-in was involved, the session
    /// is untouched, and quitting changes nothing.
    ///
    /// `StoredLinkKeyError` needs the operation for a different reason. Its
    /// shared wording answers for the callers that raise it WITHOUT touching the
    /// key store — `AccountClient`'s id check before a DELETE goes out, and the
    /// upload path's checks on the ids a server returns — so it describes a
    /// refusal that stopped everything, and `invalidKey`'s describes bytes read
    /// back from the keychain. Reused verbatim on a save
    /// both are false: nothing was stored, so there is no unreadable stored key
    /// to describe, and the save runs AFTER the upload landed, so copy that
    /// reads as "the request never went" sends the user to repeat work the
    /// server has already done. Every arm below therefore says which LOCAL key
    /// operation did not happen, and says nothing about a request that
    /// succeeded.
    public static func storedLinkKeyMessage(for error: Error,
                                            operation: StoredLinkKeyOperation,
                                            language: AppLanguage? = nil) -> String {
        if let e = error as? KeychainError {
            switch e {
            case .status(let s):
                // The status is the only diagnosable part of a keychain refusal
                // — -25308 (interaction not allowed, a locked keychain) and
                // -34018 (missing entitlement) are different problems with the
                // same symptom. It names an OSStatus and nothing about the key
                // or the file, so there is nothing here to leak.
                let key: L10nKey
                switch operation {
                case .save:   key = .errorStoredKeyKeychainSave
                case .read:   key = .errorStoredKeyKeychainRead
                case .remove: key = .errorStoredKeyKeychainRemove
                }
                return L10n.t(key, [token(s, language)], language: language)
            }
        }
        if let e = error as? StoredLinkKeyError {
            switch e {
            case .invalidIdentifier:
                // The app refused an id the server sent: a bug on one side or
                // the other, never something the user did, and never worth a
                // retry, because the same id would be refused again. What
                // changes per operation is what was left undone and whether
                // there is anywhere else to go — after a remove the object is
                // already deleted from the server, so pointing at the web would
                // be pointing at nothing.
                switch operation {
                case .save:   return L10n.t(.errorStoredKeyBadIdSave, language: language)
                case .read:   return L10n.t(.errorStoredKeyBadIdRead, language: language)
                case .remove: return L10n.t(.errorStoredKeyBadIdRemove, language: language)
                }
            case .invalidKey:
                // Only the read arm may say a stored key is unreadable, because
                // it is the only one where something IS stored: `invalidKey`
                // reaches it from `checkedKey(fromStored:)`, i.e. bytes the
                // keychain returned. On a save the key was refused on its way
                // in and no item was written, so the same sentence would send
                // the user looking for a keychain entry that does not exist.
                switch operation {
                case .save:
                    return L10n.t(.errorStoredKeyBadKeySave, language: language)
                case .read:
                    // Deliberately the shared table's key, not a copy of its
                    // words: that path is the one it was written for, and one
                    // key is what stops the two from drifting apart in any of
                    // the nine catalogs. Pinned by a test as well.
                    return L10n.t(.errorStoredLinkKeyInvalidKey, language: language)
                case .remove:
                    return L10n.t(.errorStoredKeyBadKeyRemove, language: language)
                }
            }
        }
        return message(for: error, language: language)
    }

    public static func message(for error: Error, language: AppLanguage? = nil) -> String {
        if let e = error as? AccountError {
            switch e {
            case .invalidCredentials:
                return L10n.t(.errorAccountInvalidCredentials, language: language)
            case .notSignedIn:
                // Says why rather than just refusing: the asymmetry is the
                // server's billing policy — whoever creates a code pays for any
                // traffic relayed through it — and a user who can receive fine
                // deserves to know why sending is different.
                return L10n.t(.errorAccountNotSignedIn, language: language)
            case .rateLimited:
                return L10n.t(.errorAccountRateLimited, language: language)
            case .server(let status):
                return L10n.t(.errorAccountServer, [token(status, language)], language: language)
            case .decoding:
                return L10n.t(.errorAccountDecoding, language: language)
            case .network:
                return L10n.t(.errorAccountNetwork, language: language)
            case .emailInvalid:
                return L10n.t(.errorAccountEmailInvalid, language: language)
            case .passwordTooShort:
                // The same sentence the form shows before it sends anything, and
                // deliberately the same key: one rule stated one way, whether it
                // was the app or the server that noticed.
                return L10n.t(.errorAccountPasswordTooShort, language: language)
            case .emailTaken:
                // Names the remedy — sign in — because "already registered" on
                // its own reads as a refusal rather than as an invitation to the
                // form directly above.
                return L10n.t(.errorAccountEmailTaken, language: language)
            case .accountPendingDeletion:
                // The one registration failure whose remedy is not on this
                // screen: the reactivation link was emailed when the account was
                // deleted, and nothing the user types here can substitute for it.
                return L10n.t(.errorAccountPendingDeletion, language: language)
            case .appleRejected:
                // Never `.errorAccountInvalidCredentials`: that sentence tells
                // the user to check an email and a password, and an Apple
                // authorization involved neither. It names the remedy that
                // exists on the same screen — try again, or use the form.
                return L10n.t(.errorAppleRejected, language: language)
            case .appleUnavailable:
                // The attempt could not be completed with Apple at all. A retry
                // is genuinely worth making, which is the whole difference from
                // the case above.
                return L10n.t(.errorAppleUnavailable, language: language)
            case .appleEmailUnavailable:
                return L10n.t(.errorAppleEmailUnavailable, language: language)
            }
        }
        if let e = error as? AppleSignInError {
            switch e {
            case .missingIdentityToken, .missingAuthorizationCode, .unexpectedCredential:
                // The authorization came back without what the exchange needs,
                // so nothing was sent. Says that rather than "your sign-in was
                // refused", which would be a claim about a server that never
                // saw it.
                return L10n.t(.errorAppleIncompleteCredential, language: language)
            case .authorizationFailed:
                return L10n.t(.errorAppleAuthorizationFailed, language: language)
            }
        }
        if let e = error as? KeychainError {
            switch e {
            case .status(let s):
                // Specifically the SIGN-IN token store's failure, and only
                // `AccountSession` may reach it. The same type is raised for
                // each upload's E2E key, where every clause of this is false —
                // that caller goes through `storedLinkKeyMessage(for:operation:)`.
                return L10n.t(.errorKeychainSignIn, [token(s, language)], language: language)
            }
        }
        if let e = error as? HandshakeError {
            switch e {
            case .mitm:
                // The sharpest wording in the app, and the only error here that
                // means someone may be attacking the user. No retry, no
                // reconnect: the instruction is to stop and pair again, because
                // reconnecting means reconnecting to whoever that was.
                return L10n.t(.errorHandshakeMitm, language: language)
            case .noCommitRecorded, .badBase64, .invalidKey:
                return L10n.t(.errorPeerProtocol, language: language)
            }
        }
        if let e = error as? RealtimeError {
            switch e {
            case .tamper:
                return L10n.t(.errorRealtimeTamper, language: language)
            case .outOfOrder, .malformed, .lengthMismatch:
                return L10n.t(.errorRealtimeDropped, language: language)
            case .legacyPeer:
                return L10n.t(.errorRealtimeLegacyPeer, language: language)
            // The fragmentation and resume failures are all "the peer's framing
            // and ours disagree", which is what the peer-protocol string already
            // says. They are reachable only through the durable file-lane wire,
            // which no app surface is wired to yet; when the lane ships and the
            // user can actually see one of these, they get their own copy rather
            // than a shared generic line.
            case .unknownKind, .oversizedFrame, .interleavedParts, .resumeRejected:
                return L10n.t(.errorPeerProtocol, language: language)
            }
        }
        if let e = error as? RealtimeSenderError {
            switch e {
            case .manifestTooLarge:
                return L10n.t(.errorSenderManifestTooLarge, language: language)
            case .invalidManifest:
                return L10n.t(.errorSenderInvalidManifest, language: language)
            case .sourceShorterThanDeclared(let name):
                // Almost always a file edited or deleted mid-send.
                return L10n.t(.errorSenderSourceShorter,
                              [L10n.token(name, language: language)], language: language)
            case .sourceLongerThanDeclared(let name):
                return L10n.t(.errorSenderSourceLonger,
                              [L10n.token(name, language: language)], language: language)
            // Same reasoning as the RealtimeError fragmentation cases above:
            // these three are connection/peer-framing failures on the durable
            // file-lane wire, which is not yet reachable from any app surface.
            case .frameSizeTooSmall, .resumePointRejected, .sequenceExhausted:
                return L10n.t(.errorPeerProtocol, language: language)
            }
        }
        if let e = error as? RealtimeConnection.ConnectionError {
            switch e {
            case .peerBusy:
                return L10n.t(.errorConnectionPeerBusy, language: language)
            case .unsupportedPeer:
                return L10n.t(.errorConnectionUnsupportedPeer, language: language)
            case .peerConnectionFailed, .notReady:
                return L10n.t(.errorConnectionFailed, language: language)
            case .alreadySending:
                return L10n.t(.errorConnectionAlreadySending, language: language)
            case .rejected:
                return L10n.t(.errorConnectionRejected, language: language)
            case .timedOut:
                return L10n.t(.errorConnectionTimedOut, language: language)
            case .textSendBufferFull:
                return L10n.t(.errorConnectionTextSendBufferFull, language: language)
            case .textSendFailed:
                return L10n.t(.errorConnectionTextSendFailed, language: language)
            case .textReceiveBufferFull:
                return L10n.t(.errorConnectionTextReceiveBufferFull, language: language)
            }
        }
        if let e = error as? RealtimeConnectionFactory.FactoryError {
            switch e {
            case .noPeerAppeared:
                return L10n.t(.errorFactoryNoPeerAppeared, language: language)
            case .unsupportedPeer:
                return L10n.t(.errorConnectionUnsupportedPeer, language: language)
            }
        }
        if let e = error as? NearbyError {
            switch e {
            case .notScanning:
                return L10n.t(.errorNearbyNotScanning, language: language)
            case .noAnswer:
                // Recovery steps, not a diagnosis: the roster proves the two
                // devices reached the same rendezvous, so "you're not on the
                // same network" would be a claim this code cannot make. What it
                // can say is what makes a device answer — a listening peer,
                // which today means relayium.com — and where to go instead.
                return L10n.t(.errorNearbyNoAnswer, language: language)
            }
        }
        if let e = error as? RealtimeStagingError {
            switch e {
            case .fileCount:
                return L10n.t(.errorStagingFileCount, [token(MAX_FILES, language)],
                              language: language)
            case .unreadable:
                return L10n.t(.errorStagingUnreadable, language: language)
            }
        }
        if let e = error as? RealtimeTextError {
            switch e {
            case .authenticationFailed:
                return L10n.t(.errorTextAuthenticationFailed, language: language)
            case .outOfOrder:
                return L10n.t(.errorTextOutOfOrder, language: language)
            case .messageTooLarge:
                return L10n.t(.errorTextMessageTooLarge, language: language)
            case .invalidKey, .malformedFrame, .wrongKind, .sequenceExhausted, .invalidUTF8:
                return L10n.t(.errorTextInvalid, language: language)
            }
        }
        if let e = error as? DeviceAuthOutcomeError {
            switch e {
            case .denied:
                return L10n.t(.errorDeviceAuthDenied, language: language)
            case .expired:
                // Nobody's mistake — the request simply went unanswered. Copy
                // that read as a rejection would send the user looking for one.
                return L10n.t(.errorDeviceAuthExpired, language: language)
            }
        }
        if let e = error as? DownloadDestinationError {
            switch e {
            case .directoryExists(let name):
                // A bare "refused" reads as a bug. Say what it found and why it
                // will not merge: it cannot tell a leftover partial download from
                // files the user put there.
                return L10n.t(.errorDestinationDirectoryExists,
                              [L10n.token(name, language: language)], language: language)
            case .unsafeName(let name):
                return L10n.t(.errorDestinationUnsafeName,
                              [L10n.token(name, language: language)], language: language)
            case .fileExists(let name):
                return L10n.t(.errorDestinationFileExists,
                              [L10n.token(name, language: language)], language: language)
            case .exceedsManifest, .incomplete:
                return L10n.t(.errorDestinationIncomplete, language: language)
            case .systemError(let code):
                // Names the two a user can actually act on and keeps the number
                // for everything else — "something went wrong" on a full disk
                // sends people looking in the wrong place.
                if code == ENOSPC {
                    return L10n.t(.errorDestinationNoSpace, language: language)
                }
                if code == EACCES || code == EPERM {
                    return L10n.t(.errorDestinationNotPermitted, language: language)
                }
                return L10n.t(.errorDestinationSystemError, [token(code, language)],
                              language: language)
            }
        }
        if let e = error as? ManifestPathError {
            switch e {
            case .unsafePath(let path):
                // Names the path rather than saying "invalid": on the receiving
                // end this is the one message that lets the user tell a broken
                // sender from an attempt to write outside the folder they chose.
                return L10n.t(.errorManifestUnsafePath,
                              [L10n.token(path, language: language)], language: language)
            case .duplicatePath(let path):
                return L10n.t(.errorManifestDuplicatePath,
                              [L10n.token(path, language: language)], language: language)
            case .pathCollision(let path):
                return L10n.t(.errorManifestPathCollision,
                              [L10n.token(path, language: language)], language: language)
            }
        }
        if let e = error as? PlaintextSourceError {
            switch e {
            case .unreadable(let name):
                return L10n.t(.errorPlaintextUnreadable,
                              [L10n.token(name, language: language)], language: language)
            case .readFailed(let name, _):
                return L10n.t(.errorPlaintextReadFailed,
                              [L10n.token(name, language: language)], language: language)
            case .tooManyOpenFiles(let limit):
                // Says what to do rather than naming a rlimit: the actionable
                // half is "send fewer files at once".
                return L10n.t(.errorPlaintextTooManyOpenFiles, [token(limit, language)],
                              language: language)
            }
        }
        if let e = error as? FileSelectionError {
            switch e {
            case .noFiles:
                // Distinct from the count error on purpose: "choose between 1
                // and 1000 files" is baffling advice for someone who did choose
                // a folder — it just has nothing in it.
                return L10n.t(.errorSelectionNoFiles, language: language)
            case .tooManyFiles:
                return L10n.t(.errorSelectionTooManyFiles, [token(MAX_FILES, language)],
                              language: language)
            case .unreadable(let name):
                return L10n.t(.errorSelectionUnreadable,
                              [L10n.token(name, language: language)], language: language)
            case .symbolicLink(let name):
                // Neither choice is silent: following the link would send a
                // different tree (possibly from outside what was selected) and
                // skipping it would send an incomplete one without saying so.
                return L10n.t(.errorSelectionSymbolicLink,
                              [L10n.token(name, language: language)], language: language)
            case .pathTooLong(let path):
                return L10n.t(.errorSelectionPathTooLong,
                              [L10n.token(path, language: language)], language: language)
            }
        }
        if let e = error as? CloudError {
            switch e {
            case .unauthorized:
                return L10n.t(.errorCloudUnauthorized, language: language)
            case .quota:
                return L10n.t(.errorCloudQuota, language: language)
            case .rateLimited:
                return L10n.t(.errorCloudRateLimited, language: language)
            case .dailyQuota:
                // Not "you've used too much": the gate is used + this file >
                // quota, so one large file can trip it on its own with nothing
                // else sent today. The wording has to cover both.
                return L10n.t(.errorCloudDailyQuota, language: language)
            case .monthlyTraffic:
                return L10n.t(.errorCloudMonthlyTraffic, language: language)
            case .downloadLimited:
                // Names both causes and asserts neither, because the client
                // cannot tell a per-IP download limit from the sender's
                // exhausted monthly allowance — same status, same request, and
                // the only discriminator is server prose. Says wait rather than
                // upgrade: the allowance that may be gone is the SENDER's, so
                // the reader of this sentence cannot buy their way past it, and
                // the other cause genuinely does clear on its own.
                return L10n.t(.errorCloudDownloadLimited, language: language)
            case .downloadUnavailable:
                // The status is intentionally not rendered. It is retained on
                // the case for logs and bug reports, but a recipient shown
                // "(503)" has been handed a number to act on and no action; the
                // sentence they need is that neither their link nor their key
                // is the problem and the service is worth trying again.
                return L10n.t(.errorCloudDownloadUnavailable, language: language)
            case .notFound:
                return L10n.t(.errorCloudNotFound, language: language)
            case .server(let status):
                return L10n.t(.errorCloudServer, [token(status, language)], language: language)
            case .network:
                return L10n.t(.errorCloudNetwork, language: language)
            case .decoding:
                return L10n.t(.errorCloudDecoding, language: language)
            }
        }
        if let e = error as? StoredLinkKeyError {
            switch e {
            case .invalidIdentifier:
                // The app refused to act on an id the server sent, which is a
                // bug on one side or the other — never something the user did.
                // Naming the row is what makes it reportable; inviting a retry
                // would not be, because the same id would be refused again.
                //
                // This wording belongs to the paths where the refusal IS the
                // whole outcome: `AccountClient` checks the id before a DELETE
                // is sent, and `CloudUploadModel.finish` checks the id an
                // upload returned before anything is filed or shown — so
                // nothing was saved, no link exists, and "it was refused,
                // manage it on relayium.com" is exactly true. (The object is
                // on the server in the upload case, which is what makes that
                // last clause the useful half rather than a deflection.) The
                // three key-store paths raise the same case around an
                // operation that follows a request which already succeeded,
                // and go through `storedLinkKeyMessage(for:operation:)`
                // instead.
                return L10n.t(.errorStoredLinkKeyInvalidIdentifier, language: language)
            case .invalidKey:
                // Distinct from "the key isn't on this Mac": something IS stored
                // and it is not usable. Saying the key is absent would close the
                // question; this leaves it open, because it is.
                return L10n.t(.errorStoredLinkKeyInvalidKey, language: language)
            }
        }
        if let e = error as? StoredWireError {
            switch e {
            case .invalidKey:
                return L10n.t(.errorStoredWireInvalidKey, language: language)
            case .invalidManifest, .frameTooLarge, .truncatedStream, .lengthMismatch:
                // Not transient: the bytes did not match the manifest. Inviting a
                // retry would send the user back for the same corrupt data.
                return L10n.t(.errorStoredWireCorrupt, language: language)
            }
        }
        // Total by construction: name the type so a bug report is actionable.
        return L10n.t(.errorUnknown,
                      [L10n.token(String(describing: type(of: error)), language: language)],
                      language: language)
    }

    /// A diagnostic number, rendered verbatim and isolated for RTL.
    ///
    /// Verbatim matters: an HTTP status, an OSStatus, an errno and a file-count
    /// limit are values someone will type into a search box or paste into a bug
    /// report, so they get no grouping separators and no digit substitution.
    private static func token<T: BinaryInteger>(_ value: T, _ language: AppLanguage?) -> String {
        L10n.token(String(value), language: language)
    }
}
