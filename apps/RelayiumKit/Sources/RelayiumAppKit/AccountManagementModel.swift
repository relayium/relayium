import Foundation
// @preconcurrency for the same reason AccountSession needs it: RelayiumKit
// predates strict concurrency and marks nothing Sendable, and this type hands
// its service and key store to child tasks that run the two list calls
// concurrently.
@preconcurrency import RelayiumKit

/// Which account, holding which credential, the on-screen rows belong to.
///
/// Carried into every call rather than captured once, so a result can be checked
/// against the account that is on screen when it *arrives* — not the one that was
/// on screen when it was asked for. Those differ exactly when it matters: a
/// signed-out-and-back-in user, or a second sign-in as somebody else.
public struct AccountScope: Equatable, Hashable {
    public let accountId: String
    public let token: String
    public init(accountId: String, token: String) {
        self.accountId = accountId
        self.token = token
    }
}

/// What to do with the device and stored-file rows after refreshing the session.
public enum AccountRefreshOutcome: Equatable {
    /// The same account is still signed in with a usable credential. Reload
    /// against the scope carried here — the CURRENT one, which may hold a
    /// rotated token.
    case reload(AccountScope)
    /// Whatever the session is now, it is not the account these rows belong to.
    /// Let go of them rather than fetching more of them.
    case clear(AccountScope)
}

/// Where the Account screen's Refresh button goes after `session.refresh()`.
///
/// Extracted from the view because it is a decision, not a layout: the naive
/// version — refresh the session, then reload with the scope the view computes —
/// is wrong in two ways that only appear once refreshing can CHANGE the session.
/// An expired bearer sends the session to `.loggedOut`, so the recomputed scope
/// pairs the old user id with an empty token; a second sign-in lands as somebody
/// else, so it pairs the old user id with a stranger's credential. Neither can
/// return rows belonging on this screen, and both make the model adopt a scope
/// no session actually holds.
public enum AccountRefreshDecision {
    public static func next(previous: AccountScope,
                            state: SessionState,
                            bearer: String?) -> AccountRefreshOutcome {
        // Only `.ready` means an account is on screen. `.unavailable` in
        // particular still holds the token, deliberately, so that the user can
        // retry — but it is not a state whose rows are being displayed.
        guard case .ready(let user, _) = state,
              user.id == previous.accountId,
              let bearer, !bearer.isEmpty else {
            return .clear(previous)
        }
        // The account is the same but the credential may not be: a refresh can
        // rotate it, and a load must go out under the one the session holds now.
        return .reload(AccountScope(accountId: user.id, token: bearer))
    }
}

/// Whether this installation can rebuild the share link for a stored object.
///
/// Three cases, not two, because "we could not read the keychain" and "the key
/// is not here" have opposite meanings for the user: the first may be one unlock
/// away, the second is permanent from this Mac. Collapsing them would tell
/// someone their file is unrecoverable on the strength of a locked keychain.
public enum StoredLinkAvailability: Equatable {
    case available(link: String)
    case keyNotOnThisMac
    case keyLookupFailed(String)
}

/// One stored object as the Account tab shows it: the server's own facts, plus
/// what this Mac can do about them.
public struct StoredFileRow: Equatable, Identifiable {
    public let file: StoredFileSummary
    public let link: StoredLinkAvailability
    public var id: String { file.id }
    public init(file: StoredFileSummary, link: StoredLinkAvailability) {
        self.file = file
        self.link = link
    }
}

/// The Account tab's devices and stored files: what is on screen, what is in
/// flight, and what failed.
///
/// It exists as a model rather than as `@State` in the view for the reason
/// `AccountSession` does: every operation here has suspension points, and the
/// user can sign out, sign in as someone else, or revoke a row in the middle of
/// one. A late result that writes unconditionally shows one account's devices
/// under another account's name — with a revoke button next to each.
@MainActor
public final class AccountManagementModel: ObservableObject {
    /// CLI and app devices only, most recently used first.
    @Published public private(set) var devices: [AccountDevice] = []
    /// Stored ciphertext, newest first.
    @Published public private(set) var files: [StoredFileRow] = []
    /// True only while a load with nothing yet on screen is running: a refresh
    /// must not replace a usable list with a spinner.
    @Published public private(set) var isLoading = false
    /// The last load failed. Rows may still be present — in that case this is a
    /// "these figures may be stale" banner, not an empty state.
    @Published public private(set) var loadError: String?
    /// Per-row action failures, keyed by device or file id.
    @Published public private(set) var rowErrors: [String: String] = [:]
    /// Rows with an action in flight. Only these are disabled; the rest of the
    /// list stays usable.
    @Published public private(set) var busyRows: Set<String> = []
    /// This Mac's own credential was just revoked, so the app must sign out
    /// locally. Set only on a SUCCESSFUL self-revoke: a failed one leaves a
    /// working server-side credential, and discarding the local copy would take
    /// away the only thing that can retry.
    @Published public private(set) var needsSignOut = false
    /// A stored object was deleted from the server, but its local key could not
    /// be removed afterwards.
    ///
    /// Not a row error: the row is gone, so there is nothing left to attach it
    /// to, and the delete the user asked for did happen. It is still said out
    /// loud, because the alternative is the app silently implying it removed
    /// something it did not. Non-blocking and dismissible — nothing is broken
    /// and there is nothing to retry.
    @Published public private(set) var keyCleanupWarning: String?

    private let service: AccountManagementService
    private let keyStore: StoredLinkKeyStore
    private let origin: String

    /// The account+credential the current rows belong to. A result whose scope
    /// no longer matches writes nothing.
    private var activeScope: AccountScope?
    /// Load identity. Actions claim a number too — not to protect themselves,
    /// but to invalidate any load already in flight: that load's response was
    /// served before the row was removed and would put it straight back.
    private var generation = 0

    public init(service: AccountManagementService,
                keyStore: StoredLinkKeyStore,
                origin: String) {
        self.service = service
        self.keyStore = keyStore
        self.origin = origin
    }

    public func isBusy(row id: String) -> Bool { busyRows.contains(id) }
    public func error(forRow id: String) -> String? { rowErrors[id] }

    /// Acknowledge `needsSignOut` once the app has acted on it, so reopening a
    /// window does not sign the next session out again.
    public func acknowledgeSignOut() { needsSignOut = false }

    public func dismissKeyCleanupWarning() { keyCleanupWarning = nil }

    // MARK: - leaving an account

    /// Forget everything held for `scope` and stop belonging to any account.
    ///
    /// This model is app-scoped — one instance for the life of the process, so a
    /// revoke survives the window's view tree being rebuilt. The cost of that
    /// lifetime is that signing out otherwise leaves the previous account's
    /// device list, stored-object list and RECONSTRUCTED SHARE LINKS sitting in
    /// memory behind a signed-out screen. The links are the sharp part: each one
    /// carries a `#k=` key that grants anyone holding it the plaintext. Nothing
    /// renders them once the session is gone, but "not currently drawn" is not
    /// the same promise as "not held", and this is the type that can make the
    /// stronger one.
    ///
    /// Scope-aware on the ACCOUNT, not the credential: the caller is saying "the
    /// user left this account", and a token refresh in between must not stop
    /// that from taking effect. Matching also means a clear that races a sign-in
    /// as somebody else cannot wipe the new account's freshly loaded rows —
    /// which is exactly the ordering `AccountView`'s Refresh can produce.
    public func clear(scope: AccountScope) {
        guard activeScope?.accountId == scope.accountId else { return }
        deactivate()
    }

    /// Drop the rows and stop being scoped to anything.
    ///
    /// Clearing `activeScope` is what stops a late result from repainting: every
    /// load and every action compares against it on the way out, and `nil` never
    /// matches. The generation bump makes an in-flight load stale by the second
    /// test as well, so neither guard is carrying this alone.
    private func deactivate() {
        generation += 1
        activeScope = nil
        clearRows()
    }

    // MARK: - loading

    /// Fetch both lists. Also the refresh path: the only difference a refresh
    /// makes is that there is already something on screen, which this reads off
    /// the current state rather than off a flag the caller has to get right.
    public func load(_ scope: AccountScope) async {
        // A different account has nothing in common with what is on screen.
        // Clearing BEFORE the await is the point: otherwise the previous
        // account's devices stay visible, and revocable, until the fetch lands.
        if activeScope?.accountId != scope.accountId { clearRows() }
        activeScope = scope
        generation += 1
        let g = generation
        isLoading = devices.isEmpty && files.isEmpty

        async let deviceCall = service.listDevices(token: scope.token)
        async let fileCall = service.listStoredFiles(token: scope.token)

        var failure: Error?
        var fetchedDevices: [AccountDevice]?
        var fetchedFiles: [StoredFileSummary]?
        do { fetchedDevices = try await deviceCall } catch { failure = error }
        do { fetchedFiles = try await fileCall } catch { failure = failure ?? error }

        // Key lookups happen before the guard so no await follows it.
        var rows: [StoredFileRow]?
        if let fetchedFiles { rows = await self.rows(for: fetchedFiles) }

        guard isCurrent(scope, g) else { return }
        isLoading = false
        if let fetchedDevices {
            devices = fetchedDevices.filter(\.holdsRevocableToken).sorted(by: Self.byRecency)
        }
        if let rows { files = rows }
        loadError = failure.map(Self.message(for:))
    }

    private func rows(for files: [StoredFileSummary]) async -> [StoredFileRow] {
        var out: [StoredFileRow] = []
        out.reserveCapacity(files.count)
        for file in files.sorted(by: { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }) {
            out.append(StoredFileRow(file: file, link: await availability(for: file)))
        }
        return out
    }

    /// The key never leaves this Mac and is never asked of the server: if it is
    /// not here, the honest answer is that the link cannot be rebuilt here.
    ///
    /// `buildDownloadLink` interpolates the id straight into a URL, and it is
    /// only ever reached through a key lookup that validated that id first
    /// (`StoredLinkKeyValidation.checkedID`, the same contract `AccountClient`
    /// applies before a DELETE). A hostile id therefore lands in the
    /// `keyLookupFailed` branch rather than in a link — deliberately, not
    /// incidentally.
    private func availability(for file: StoredFileSummary) async -> StoredLinkAvailability {
        do {
            guard let key = try await keyStore.key(for: file.id) else { return .keyNotOnThisMac }
            return .available(link: buildDownloadLink(origin: origin, id: file.id, keyB64url: key))
        } catch {
            // Not `message(for:)`: its `KeychainError` copy belongs to the
            // sign-in token store, and nothing about the session is in question
            // here — one file's key could not be read.
            return .keyLookupFailed(ErrorCopy.storedLinkKeyMessage(for: error, operation: .read))
        }
    }

    // MARK: - actions

    /// Revoke one device. Revoking the current one cascades this app's own
    /// bearer server-side, which is why success sets `needsSignOut`.
    public func revoke(_ device: AccountDevice, scope: AccountScope) async {
        await act(on: device.id, scope: scope) {
            try await self.service.deleteDevice(id: device.id, token: scope.token)
            return {
                self.devices.removeAll { $0.id == device.id }
                if device.current { self.needsSignOut = true }
            }
        }
    }

    /// Delete one stored ciphertext object, and the local key that could open it.
    ///
    /// The key is discarded only on a CONFIRMED delete. A 404 means the object is
    /// almost certainly gone — burned, expired, removed from another device — but
    /// it is also what a failed read on the server looks like, and the two
    /// mistakes are not symmetric: an orphaned key is an inert keychain item,
    /// while a key destroyed for an object that still exists is the only thing
    /// that could ever have opened it. The row leaves the list either way.
    ///
    /// Failing to remove the key AFTER a confirmed delete is a third outcome and
    /// gets its own treatment. It is not a failed delete — the ciphertext really
    /// is gone, and reporting an error would send the user to retry a server
    /// operation that already succeeded — but it is not nothing either, because
    /// swallowing it means the app implies it cleaned up something it did not.
    /// So the row goes, no row error is raised, and a non-blocking warning says
    /// what is actually still on this Mac.
    public func delete(_ file: StoredFileSummary, scope: AccountScope) async {
        await act(on: file.id, scope: scope) {
            let outcome = try await self.service.deleteStoredFile(id: file.id, token: scope.token)
            var cleanupFailure: Error?
            if outcome == .deleted {
                do { try await self.keyStore.remove(id: file.id) } catch { cleanupFailure = error }
            }
            return {
                self.files.removeAll { $0.id == file.id }
                if let cleanupFailure {
                    self.keyCleanupWarning = Self.cleanupMessage(id: file.id, error: cleanupFailure)
                }
            }
        }
    }

    /// The shape both row actions share: mark the row busy, run the call, then
    /// apply its effect — but only if this is still the account it was asked for.
    ///
    /// The action claims a generation so that a load already in flight cannot
    /// resurrect the row it removes. It does not check that generation on the way
    /// out: two actions on different rows overlap routinely, and each one owns
    /// only its own row.
    ///
    /// A stale result still clears its own busy marker before bailing out. It has
    /// to: signing out and back in as the SAME account replaces the credential
    /// without replacing the rows, so nothing else would ever clear it, and the
    /// row would sit disabled with no operation left to finish it.
    private func act(on rowId: String, scope: AccountScope,
                     _ body: @escaping () async throws -> () -> Void) async {
        guard activeScope == scope else { return }
        generation += 1
        busyRows.insert(rowId)
        rowErrors[rowId] = nil
        do {
            let apply = try await body()
            busyRows.remove(rowId)
            guard activeScope == scope else { return }
            apply()
        } catch {
            busyRows.remove(rowId)
            guard activeScope == scope else { return }
            rowErrors[rowId] = Self.message(for: error)
        }
    }

    // MARK: - helpers

    private func isCurrent(_ scope: AccountScope, _ g: Int) -> Bool {
        activeScope == scope && generation == g
    }

    /// `isLoading` is cleared here rather than only where a load finishes, and it
    /// has to be: a load suspended in `service` at the moment of a clear returns
    /// to its `isCurrent` guard and bails out WITHOUT reaching the line that
    /// lowers the flag. Nothing else would ever lower it, and this model is
    /// app-scoped, so the next sign-in would inherit a spinner from the account
    /// that left. `load` recomputes the flag straight after calling this, so the
    /// account-switch path is unaffected.
    private func clearRows() {
        devices = []
        files = []
        isLoading = false
        rowErrors = [:]
        busyRows = []
        loadError = nil
        needsSignOut = false
        keyCleanupWarning = nil
    }

    /// Says exactly what happened and exactly what it costs, which here is
    /// nothing: the bytes the key unlocked no longer exist, so the leftover item
    /// is inert. No retry is offered because there is no operation to retry —
    /// the object is already gone.
    private static func cleanupMessage(id: String, error: Error) -> String {
        """
        The stored file “\(id)” was deleted from the server, but its key is still on \
        this Mac. \(ErrorCopy.storedLinkKeyMessage(for: error, operation: .remove)) \
        The key can't open anything any more — the encrypted data it belonged to is gone.
        """
    }

    /// Most recently used first — the web's ordering — with a total tie-break so
    /// a list of never-used devices does not reshuffle on every refresh.
    private static func byRecency(_ a: AccountDevice, _ b: AccountDevice) -> Bool {
        (a.lastSeenAt, a.createdAt, b.id) > (b.lastSeenAt, b.createdAt, a.id)
    }

    private static func message(for error: Error) -> String {
        // `ErrorCopy`'s wording for a rejected credential is about an email and
        // a password, which is not what happened here: the bearer this screen is
        // using expired or was revoked elsewhere.
        if let e = error as? AccountError, e == .invalidCredentials {
            return "This Mac's sign-in is no longer valid. Sign out and sign in again."
        }
        return ErrorCopy.message(for: error)
    }
}
