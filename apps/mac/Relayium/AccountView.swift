import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct AccountView: View {
    let user: NativeUser
    let usage: UsageResponse

    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var management: AccountManagementModel

    /// The row a confirmation dialog is currently asking about. Held here rather
    /// than in the model: nothing has been asked of the server yet, so it is a
    /// property of this screen, not of the account.
    @State private var deviceToRevoke: AccountDevice?
    @State private var fileToDelete: StoredFileSummary?

    /// Which account and credential the rows on screen belong to. Rebuilt each
    /// render and passed into every call, so a result that arrives after a sign
    /// out — or a sign in as someone else — can be recognised as stale.
    private var scope: AccountScope {
        AccountScope(accountId: user.id, token: session.bearerToken ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName.isEmpty ? user.email : user.displayName).font(.title2.weight(.semibold))
                Text(user.email).foregroundStyle(.secondary)
            }

            HStack {
                Text(usage.plan.name).font(.headline)
                // Both the "should this show at all" predicate and the wording live
                // in UsagePresentation, where they are tested. A raw Stripe status
                // must never reach this capsule.
                if let badge = UsagePresentation.subscriptionBadge(for: usage.plan.subscriptionStatus) {
                    Text(badge)
                        .font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Spacer()
                // macOS ships as a direct download, so billing is compliant on the web.
                // The app shows the tier read-only and hands off — to the plans page,
                // which is where a change of plan is actually made.
                Button("Manage plan") { NSWorkspace.shared.open(AppEnvironment.plansWebURL) }
            }

            meter("Traffic", UsagePresentation.display(usage.traffic))
            meter("Storage", UsagePresentation.display(usage.storage))

            Text(UsagePresentation.resetText(resetsAt: usage.resetsAt, now: Date()))
                .font(.caption).foregroundStyle(.secondary)

            if session.isStale {
                Label("Showing the last known figures — couldn't reach the server.", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Divider()
            devicesSection
            Divider()
            filesSection

            if let loadError = management.loadError {
                Label(loadError, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // A delete that succeeded on the server but could not clean up
            // locally. Not an error and not attached to a row — the row is gone —
            // but the app must not imply it removed something it did not.
            if let cleanupWarning = management.keyCleanupWarning {
                HStack(alignment: .firstTextBaseline) {
                    Label(cleanupWarning, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("Dismiss") { management.dismissKeyCleanupWarning() }
                        .buttonStyle(.link)
                }
            }

            Spacer()

            HStack {
                Button("Refresh") { refresh() }
                Spacer()
                Button("Sign out") { signOut() }
            }
        }
        // Keyed on the scope so signing in as someone else reloads rather than
        // leaving the previous account's devices on screen.
        .task(id: scope) { await management.load(scope) }
        // Revoking this Mac's own credential cascades the bearer server-side.
        // Leaving the account screen up would be a UI asserting an authentication
        // that no longer exists, so the app signs itself out locally.
        //
        // Two deliberate details. The signal is consumed BEFORE acting, so it is
        // one-shot: a sign-out that fails leaves the user on the retryable
        // `.unavailable` screen rather than re-firing forever, and signing back
        // in as the same account does not inherit it. And the sign-out itself is
        // an unstructured `Task` — it succeeds by removing this very view, which
        // would cancel a `.task` part-way through `client.logout` and leave the
        // local credential exactly where it was.
        .task(id: management.needsSignOut) {
            guard management.needsSignOut else { return }
            management.acknowledgeSignOut()
            // The account this model is holding rows for is the one being signed
            // out of, so let go of them here rather than leaving a signed-out
            // account's devices and #k= links in an app-scoped object.
            management.clear(scope: scope)
            Task { await session.logOut() }
        }
        .confirmationDialog(
            "Revoke “\(deviceToRevoke?.name ?? "")”?",
            isPresented: Binding(get: { deviceToRevoke != nil },
                                 set: { if !$0 { deviceToRevoke = nil } }),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                guard let device = deviceToRevoke else { return }
                deviceToRevoke = nil
                Task { await management.revoke(device, scope: scope) }
            }
            Button("Cancel", role: .cancel) { deviceToRevoke = nil }
        } message: {
            Text(deviceToRevoke?.current == true
                 ? "This is the Mac you're using. Revoking it signs this app out immediately."
                 : "That device will be signed out and will have to sign in again.")
        }
        .confirmationDialog(
            "Delete this stored file?",
            isPresented: Binding(get: { fileToDelete != nil },
                                 set: { if !$0 { fileToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                guard let file = fileToDelete else { return }
                fileToDelete = nil
                Task { await management.delete(file, scope: scope) }
            }
            Button("Cancel", role: .cancel) { fileToDelete = nil }
        } message: {
            Text("The encrypted data is erased from the server. Anyone holding the link will get nothing. This cannot be undone.")
        }
    }

    // MARK: - session actions

    /// Refresh the session, then the rows — but only if the refresh left the
    /// SAME account signed in with a usable credential.
    ///
    /// `scope` is recomputed on every read from `user` — this view's render-time
    /// value — and from the live `session.bearerToken`, so after `refresh()` it
    /// can name an account the session no longer holds. Which of the two
    /// outcomes that is belongs in `AccountRefreshDecision`, where it is tested;
    /// this only carries it out. The new account, if there is one, is loaded by
    /// `.task(id: scope)` when this view re-renders for it.
    private func refresh() {
        let previous = scope
        Task {
            await session.refresh()
            switch AccountRefreshDecision.next(previous: previous,
                                               state: session.state,
                                               bearer: session.bearerToken) {
            case .reload(let current): await management.load(current)
            case .clear(let stale):    management.clear(scope: stale)
            }
        }
    }

    /// Explicit sign-out. The rows go first, deliberately: `logOut()` makes a
    /// network call that can take a minute to time out, and there is no reason
    /// for a leaving user's device list and reconstructed `#k=` links to sit in
    /// an app-scoped object for it. Nothing is lost if the sign-out fails —
    /// returning to the account screen re-runs the load.
    private func signOut() {
        management.clear(scope: scope)
        Task { await session.logOut() }
    }

    // MARK: - devices

    @ViewBuilder
    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Signed-in devices")
            // Browsers are left out on purpose — see AccountDevice.holdsRevocableToken.
            Text("Apps and command-line logins that hold a token for this account. Browsers aren't listed: they sign in with a session, not a token.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if management.isLoading && management.devices.isEmpty {
                ProgressView().controlSize(.small)
            } else if management.devices.isEmpty {
                Text("No app or command-line device is signed in.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(management.devices) { device in
                    deviceRow(device)
                }
            }
        }
    }

    @ViewBuilder
    private func deviceRow(_ device: AccountDevice) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(device.name.isEmpty ? "Unnamed device" : device.name)
                            .lineLimit(1).truncationMode(.middle)
                        if device.current {
                            Text("This Mac")
                                .font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                                .background(.quaternary, in: Capsule())
                        }
                    }
                    Text(deviceDetail(device))
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                // Only the row being changed is disabled: a slow revoke on one
                // device must not freeze the rest of the list.
                Button("Revoke") { deviceToRevoke = device }
                    .disabled(management.isBusy(row: device.id))
            }
            if let error = management.error(forRow: device.id) {
                Text(error).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func deviceDetail(_ device: AccountDevice) -> String {
        let kind = device.kind == "cli" ? "Command line" : "App"
        // 0 means the credential has never been used since it was issued —
        // stated plainly rather than rendered as 1970.
        let used = device.lastSeenAt == 0
            ? "never used"
            : "last used \(shortDate(device.lastSeenAt))"
        return "\(kind) · \(used) · added \(shortDate(device.createdAt))"
    }

    // MARK: - stored files

    @ViewBuilder
    private var filesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Stored files")
            Text("Encrypted data this account is storing. Relayium's servers never see the file names or the keys, so only the details below are known to them.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if management.isLoading && management.files.isEmpty {
                ProgressView().controlSize(.small)
            } else if management.files.isEmpty {
                Text("Nothing stored right now.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(management.files) { row in
                    fileRow(row)
                }
            }
        }
    }

    @ViewBuilder
    private func fileRow(_ row: StoredFileRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.file.id)
                .font(.caption.monospaced()).textSelection(.enabled)
                .lineLimit(1).truncationMode(.middle)
            Text(fileDetail(row.file))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            switch row.link {
            case .available(let link):
                HStack {
                    Button("Copy link") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                    }
                    Spacer()
                    Button("Delete", role: .destructive) { fileToDelete = row.file }
                        .disabled(management.isBusy(row: row.id))
                }
            case .keyNotOnThisMac:
                // The honest version of a disabled button: the key was only ever
                // in the link, and this Mac does not have it. Saying "unavailable"
                // without saying why reads as a bug the user could work around.
                Text("The key for this file isn't on this Mac, so the link can't be rebuilt here. It was sent from another device, or before this version of the app started keeping keys. Relayium's servers never had it.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Delete", role: .destructive) { fileToDelete = row.file }
                        .disabled(management.isBusy(row: row.id))
                }
            case .keyLookupFailed(let message):
                // Not the same statement as "you don't have the key": this one
                // may be one keychain unlock away.
                Text("Couldn't check this Mac's keychain for the key, so the link can't be shown. \(message)")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Delete", role: .destructive) { fileToDelete = row.file }
                        .disabled(management.isBusy(row: row.id))
                }
            }

            if let error = management.error(forRow: row.id) {
                Text(error).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func fileDetail(_ file: StoredFileSummary) -> String {
        var parts = ["\(byteText(file.size)) encrypted"]
        parts.append(file.expiresAt == 0 ? "no expiry" : "expires \(shortDate(file.expiresAt))")
        if file.burnAfterRead { parts.append("deletes after one download") }
        switch file.downloadCount {
        case 0: parts.append(file.downloaded ? "downloaded" : "not downloaded yet")
        case 1: parts.append("downloaded once")
        default: parts.append("downloaded \(file.downloadCount) times")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - shared bits

    @ViewBuilder
    private func sectionHeader(_ title: String) -> some View {
        Text(title).font(.headline)
    }

    private func shortDate(_ epochSeconds: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(epochSeconds))
            .formatted(date: .abbreviated, time: .shortened)
    }

    private func byteText(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    @ViewBuilder
    private func meter(_ title: String, _ d: MeterDisplay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text("\(d.usedText) of \(d.capText)").font(.subheadline).foregroundStyle(.secondary)
            }
            // No bar when unlimited: there is no ratio to draw.
            if let fraction = d.fraction {
                ProgressView(value: fraction)
            }
        }
    }
}
