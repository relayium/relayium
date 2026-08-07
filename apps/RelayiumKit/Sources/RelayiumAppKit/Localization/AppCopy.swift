import Foundation
import RelayiumKit
import RelayiumShareKit

/// Copy that a SwiftUI view would otherwise assemble inline.
///
/// Everything here used to live in `apps/mac/Relayium/*.swift` as a `switch`
/// returning English literals, a dictionary of labels, or a `"\(a) · \(b)"`
/// interpolation. Three reasons it moved:
///
///  1. **Testability.** A string built inside a `View`'s computed property is
///     unreachable from `swift test`. These are reachable, and the localized
///     assertions in `LocalizedCopyTests` drive them directly.
///  2. **One copy, two clients.** The menu-bar extra and the nearby pane render
///     the same receive status; the R3 iOS app will render the same device rows.
///     Two `switch` statements over the same enum is two places for a state to
///     go missing.
///  3. **The literal guard.** `LocalizationSourceGuardTests` refuses user-facing
///     English literals in the view layer, and these were exactly that.
public enum NearbyStatusPresentation {
    /// Deliberately never says "ready" for a state that is not. A dropped socket
    /// says it is reconnecting, because during that gap this Mac genuinely
    /// cannot be reached and a user who is waiting for a file needs to know it
    /// is the app, not the sender.
    public static func text(for state: NearbyReceiveState,
                            language: AppLanguage? = nil) -> String {
        switch state {
        case .off:            return L10n.t(.nearbyStatusOff, language: language)
        case .paused:         return L10n.t(.nearbyStatusPaused, language: language)
        case .connecting:     return L10n.t(.nearbyStatusJoining, language: language)
        case .ready:          return L10n.t(.nearbyStatusReady, language: language)
        case .reconnecting:   return L10n.t(.nearbyStatusReconnecting, language: language)
        case .active(.file):  return L10n.t(.nearbyStatusReceivingFiles, language: language)
        case .active(.text):  return L10n.t(.nearbyStatusMessageSession, language: language)
        }
    }
}

/// Accessible action labels for one ephemeral text row. The visible Copy/Share
/// controls are intentionally compact, but assistive technology must retain the
/// sent/received context after Copy changes its visible state to “Copied”.
public enum TextMessagePresentation {
    public static func copyActionLabel(direction: RealtimeTextMessage.Direction,
                                       copied: Bool,
                                       language: AppLanguage? = nil) -> String {
        if !copied {
            return L10n.t(direction == .outgoing
                          ? .textCopySentMessage : .textCopyReceivedMessage,
                          language: language)
        }
        return L10n.detail([
            L10n.t(.commonCopied, language: language),
            L10n.t(direction == .outgoing ? .textSent : .textReceived,
                   language: language),
        ], language: language)
    }

    public static func shareActionLabel(direction: RealtimeTextMessage.Direction,
                                        language: AppLanguage? = nil) -> String {
        L10n.detail([
            L10n.t(.commonShare, language: language),
            L10n.t(direction == .outgoing ? .textSent : .textReceived,
                   language: language),
        ], language: language)
    }
}

/// The Account tab's row details.
public enum AccountPresentation {
    /// "App · last used 3 Jan 2026 at 09:12 · added 1 Jan 2026 at 08:00".
    ///
    /// The device's own NAME is not in here — it is the user's or the peer's
    /// text and is rendered verbatim beside this line.
    public static func deviceDetail(kind: String,
                                    lastSeenAt: Int64,
                                    createdAt: Int64,
                                    language: AppLanguage? = nil) -> String {
        let kindText = kind == "cli"
            ? L10n.t(.accountDeviceKindCli, language: language)
            : L10n.t(.accountDeviceKindApp, language: language)
        // 0 means the credential has never been used since it was issued —
        // stated plainly rather than rendered as 1970.
        let used = lastSeenAt == 0
            ? L10n.t(.accountDeviceNeverUsed, language: language)
            : L10n.t(.accountDeviceLastUsed, [shortDate(lastSeenAt, language: language)],
                     language: language)
        let added = L10n.t(.accountDeviceAdded, [shortDate(createdAt, language: language)],
                           language: language)
        return L10n.detail([kindText, used, added], language: language)
    }

    /// "1.2 MB encrypted · expires 4 Jan 2026 at 09:00 · downloaded twice".
    public static func fileDetail(_ file: StoredFileSummary,
                                  language: AppLanguage? = nil) -> String {
        var parts = [L10n.t(.accountFileEncryptedSize,
                            [L10n.bytes(file.size, language: language)], language: language)]
        parts.append(file.expiresAt == 0
                     ? L10n.t(.accountFileNoExpiry, language: language)
                     : L10n.t(.accountFileExpires,
                              [shortDate(file.expiresAt, language: language)], language: language))
        if file.burnAfterRead { parts.append(L10n.t(.accountFileBurn, language: language)) }
        switch file.downloadCount {
        case 0:
            parts.append(file.downloaded
                         ? L10n.t(.accountFileDownloaded, language: language)
                         : L10n.t(.accountFileNotDownloaded, language: language))
        case 1:
            parts.append(L10n.t(.accountFileDownloadedOnce, language: language))
        default:
            parts.append(L10n.plural(.accountFileDownloadedTimes, file.downloadCount,
                                     language: language))
        }
        return L10n.detail(parts, language: language)
    }

    /// The abbreviated date/time the account rows use throughout.
    public static func shortDate(_ epochSeconds: Int64, language: AppLanguage? = nil) -> String {
        L10n.date(Date(timeIntervalSince1970: TimeInterval(epochSeconds)),
                  dateStyle: .medium, timeStyle: .short, language: language)
    }

    // MARK: - decisions the two account surfaces would otherwise each make

    /// The device's name as it should appear, or the localized stand-in.
    ///
    /// Trimmed, not merely checked for empty: a name that is only whitespace is
    /// a blank row with extra steps, and the server does not promise otherwise —
    /// `AccountDevice`'s decoder already defaults a missing `Name` to `""`.
    public static func deviceName(_ device: AccountDevice,
                                  language: AppLanguage? = nil) -> String {
        let name = device.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? L10n.t(.accountUnnamedDevice, language: language) : name
    }

    /// What revoking this row actually costs.
    ///
    /// Revoking the credential in your hand cascades this app's own bearer
    /// server-side and signs it out immediately; revoking another device's does
    /// not. A confirmation that stated the wrong one would be a destructive
    /// dialog lying about its own button, which is why the choice is here rather
    /// than as a ternary inside a `View`.
    public static func revokeConsequence(current: Bool,
                                         language: AppLanguage? = nil) -> String {
        L10n.t(current ? .accountRevokeThisMac : .accountRevokeOther, language: language)
    }

    /// The revoke button's accessible label.
    ///
    /// The visible label is one word for every row, which is the right thing to
    /// look at and the wrong thing to hear: two devices of the same model sign in
    /// under the same name routinely, and then the list is two identical
    /// buttons. The detail line is what separates them — it carries the kind and
    /// both dates — and the current device says so outright, because that is the
    /// one whose consequence is different.
    public static func revokeActionLabel(for device: AccountDevice,
                                         language: AppLanguage? = nil) -> String {
        var detail = deviceDetail(kind: device.kind,
                                  lastSeenAt: device.lastSeenAt,
                                  createdAt: device.createdAt,
                                  language: language)
        if device.current {
            detail = L10n.detail([L10n.t(.accountThisMac, language: language), detail],
                                 language: language)
        }
        // The name is the user's or the peer's own text: isolated under Arabic,
        // never translated.
        return L10n.t(.accountRevokeDeviceLabel,
                      [L10n.token(deviceName(device, language: language), language: language),
                       detail],
                      language: language)
    }

    /// The stored-row actions' accessible labels. The id is server-issued and
    /// opaque, so it is isolated rather than translated.
    public static func shareActionLabel(fileId: String,
                                        language: AppLanguage? = nil) -> String {
        L10n.t(.accountShareFileLabel, [L10n.token(fileId, language: language)],
               language: language)
    }

    public static func copyActionLabel(fileId: String, copied: Bool,
                                       language: AppLanguage? = nil) -> String {
        L10n.detail([
            L10n.t(copied ? .commonCopied : .accountCopyLink, language: language),
            L10n.token(fileId, language: language),
        ], language: language)
    }

    public static func openActionLabel(fileId: String,
                                       language: AppLanguage? = nil) -> String {
        L10n.detail([
            L10n.t(.downloadOpen, language: language),
            L10n.token(fileId, language: language),
        ], language: language)
    }

    public static func deleteActionLabel(fileId: String,
                                         language: AppLanguage? = nil) -> String {
        L10n.t(.accountDeleteFileLabel, [L10n.token(fileId, language: language)],
               language: language)
    }

    /// What a stored row's link area can offer, and what it has to say when it
    /// can offer nothing.
    ///
    /// The mapping is one line per case and is still worth its own function: it
    /// is the point where a `#k=` link — which IS the plaintext to anybody
    /// holding it — either reaches a share sheet or does not, and it is the point
    /// where the two ways of not holding a key stop being interchangeable.
    public static func link(for availability: StoredLinkAvailability,
                            language: AppLanguage? = nil) -> StoredLinkPresentation {
        switch availability {
        case .available(let link):
            return .shareable(link)
        case .keyNotOnThisMac:
            return .unavailable(L10n.t(.accountKeyNotOnThisMac, language: language))
        case .keyLookupFailed(let reason):
            return .lookupFailed(L10n.t(.accountKeyLookupFailed, [reason], language: language))
        }
    }

    /// Keeps clipboard acknowledgement only while that exact row can still
    /// provide its recovery link. A reload can delete the row or discover that
    /// its key is no longer readable; either outcome makes an old “Copied” claim
    /// misleading even though the server-issued id itself has not changed.
    public static func retainedCopiedFileID(_ copiedFileID: String?,
                                            in rows: [StoredFileRow]) -> String? {
        guard let copiedFileID,
              rows.contains(where: { row in
                  guard row.id == copiedFileID else { return false }
                  if case .available = row.link { return true }
                  return false
              }) else { return nil }
        return copiedFileID
    }
}

/// What one stored row can do about its link.
///
/// Three cases rather than "a link or nothing", because the two empty-handed
/// states are opposite statements about what the user can do next: `.unavailable`
/// is permanent from this installation — the key was only ever in the link, and
/// the server never had it — while `.lookupFailed` may be one keychain unlock
/// away. Collapsing them would tell somebody their file is unrecoverable on the
/// strength of a locked keychain.
public enum StoredLinkPresentation: Equatable {
    /// The link was rebuilt here. Hand it to the platform's own share sheet.
    case shareable(String)
    /// This installation does not hold the key, and nothing can retry into it.
    case unavailable(String)
    /// The keychain would not answer. Carries the underlying reason.
    case lookupFailed(String)
}

/// The stored-download pane's counts.
public enum DownloadPresentation {
    /// "3 files · 12.4 MB".
    public static func manifestSummary(fileCount: Int,
                                       totalBytes: Int64,
                                       language: AppLanguage? = nil) -> String {
        L10n.t(.downloadManifestSummary,
               [L10n.plural(.downloadFileCount, fileCount, language: language),
                L10n.bytes(totalBytes, language: language)],
               language: language)
    }

    public static func savedSummary(fileCount: Int, language: AppLanguage? = nil) -> String {
        L10n.plural(.downloadSavedFiles, fileCount, language: language)
    }
}

/// What a notification says.
///
/// Bodies deliberately contain no filenames, links, pairing codes or keys —
/// notification previews are visible on a locked screen — so localizing them
/// introduces no new disclosure. Counts are the only substitution.
public enum NotificationCopy {
    public static func filesReady(count: Int, language: AppLanguage? = nil) -> String {
        L10n.plural(.notifyFilesReady, count, language: language)
    }
}
