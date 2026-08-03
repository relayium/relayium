import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The signed-in account surface: who this is, what the plan allows and how much
/// of it is used, which devices hold a token, what is stored on the server, and
/// how to end the account.
///
/// Built on `SectionCard` and `InlineMessage` like the other four destinations.
/// It used to be a flat column grouped by `Divider()`, with three headings that
/// were `Text(...).font(.headline)` — the pattern the component vocabulary
/// exists to replace — and it stated every failure in red text with no symbol
/// beside it, which is no statement at all to a reader who cannot distinguish
/// the colour. Nothing about the model moved: the same scope, the same
/// confirmations, the same row-local busy flags, the same one-shot sign-out.
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
    /// Whether the account-deletion confirmation is up. Here for the same
    /// reason as the two above: until the user confirms, nothing has been asked
    /// of the server, so it is a property of this screen.
    @State private var confirmingAccountDeletion = false

    /// Which account and credential the rows on screen belong to. Rebuilt each
    /// render and passed into every call, so a result that arrives after a sign
    /// out — or a sign in as someone else — can be recognised as stale.
    private var scope: AccountScope {
        AccountScope(accountId: user.id, token: session.bearerToken ?? "")
    }

    var body: some View {
        // ONE structural identity, with every modifier below still attached to
        // it: `deviceToRevoke`/`fileToDelete`, both confirmations and both
        // `.task(id:)`s live on this view, and splitting it would restart the
        // load and drop a dialog mid-question.
        VStack(alignment: .leading, spacing: 20) {
            profileCard
                .frame(maxWidth: 720, alignment: .leading)
            devicesCard
            filesCard
            deleteAccountCard

            // The rows could not be loaded at all — distinct from a per-row
            // failure, which is drawn on the row it belongs to.
            if let loadError = management.loadError {
                InlineMessage(.failure, loadError)
            }

            // A delete that succeeded on the server but could not clean up
            // locally. Not an error and not attached to a row — the row is gone —
            // but the app must not imply it removed something it did not.
            if let cleanupWarning = management.keyCleanupWarning {
                HStack(alignment: .firstTextBaseline) {
                    InlineMessage(.warning, cleanupWarning)
                    Spacer(minLength: 8)
                    Button(L10n.t(.commonDismiss)) { management.dismissKeyCleanupWarning() }
                        .buttonStyle(.link)
                }
            }

            HStack {
                // The destination's primary action, so it answers Return — the
                // design's rule for all five. Refresh is the safe one to put
                // there: it is idempotent, and the alternative on this screen
                // signs the user out.
                Button(L10n.t(.commonRefresh)) { refresh() }
                    .keyboardShortcut(.defaultAction)
                Spacer()
                Button(L10n.t(.commonSignOut)) { signOut() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
            L10n.t(.accountRevokeTitle, [L10n.token(deviceToRevoke?.name ?? "")]),
            isPresented: Binding(get: { deviceToRevoke != nil },
                                 set: { if !$0 { deviceToRevoke = nil } }),
            titleVisibility: .visible
        ) {
            Button(L10n.t(.commonRevoke), role: .destructive) {
                guard let device = deviceToRevoke else { return }
                deviceToRevoke = nil
                Task { await management.revoke(device, scope: scope) }
            }
            Button(L10n.t(.commonCancel), role: .cancel) { deviceToRevoke = nil }
        } message: {
            Text(L10n.t(deviceToRevoke?.current == true
                        ? .accountRevokeThisMac : .accountRevokeOther))
        }
        .confirmationDialog(
            L10n.t(.accountDeleteFileTitle),
            isPresented: Binding(get: { fileToDelete != nil },
                                 set: { if !$0 { fileToDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button(L10n.t(.commonDelete), role: .destructive) {
                guard let file = fileToDelete else { return }
                fileToDelete = nil
                Task { await management.delete(file, scope: scope) }
            }
            Button(L10n.t(.commonCancel), role: .cancel) { fileToDelete = nil }
        } message: {
            Text(L10n.t(.accountDeleteFileBody))
        }
        // The third confirmation, and the only one whose subject is the account
        // rather than a row. The system dialog is what makes it accessible and
        // dismissible the way the platform's users expect; the destructive role
        // is on the button that sends the request, and Cancel is the default.
        .confirmationDialog(
            L10n.t(.accountDeleteAccountConfirmTitle),
            isPresented: $confirmingAccountDeletion,
            titleVisibility: .visible
        ) {
            // Labelled for what pressing it does. It sends an email; it deletes
            // nothing, and the message above says so — a button reading
            // "Delete" here would contradict the sentence it sits under.
            Button(L10n.t(.accountDeleteAccountConfirmAction), role: .destructive) {
                confirmingAccountDeletion = false
                // Unstructured on purpose: the session owns the scoping, and
                // this view stays on screen either way, so nothing about the
                // request should be tied to this dialog's lifetime.
                Task { await session.requestAccountDeletion() }
            }
            Button(L10n.t(.commonCancel), role: .cancel) { confirmingAccountDeletion = false }
        } message: {
            Text(L10n.t(.accountDeleteAccountConfirmBody, [L10n.token(user.email)]))
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

    // MARK: - profile, plan and usage

    /// The card is titled with whoever this account belongs to, because that is
    /// the one thing on the screen that answers "whose account am I looking at" —
    /// the question a shared Mac makes worth answering before any figure below it.
    private var profileTitle: String {
        user.displayName.isEmpty ? user.email : user.displayName
    }

    @ViewBuilder
    private var profileCard: some View {
        SectionCard(title: profileTitle) {
            // Only when it adds something: with no display name the card is
            // already titled with the address.
            if !user.displayName.isEmpty {
                Text(user.email).foregroundStyle(.secondary)
            }

            HStack {
                Text(usage.plan.name).font(.subheadline.weight(.semibold))
                // Both the "should this show at all" predicate and the wording live
                // in UsagePresentation, where they are tested. A raw Stripe status
                // must never reach this capsule.
                if let badge = UsagePresentation.subscriptionBadge(for: usage.plan.subscriptionStatus) {
                    Text(badge)
                        .font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Spacer()
                // The Mac build is a direct download, so billing is compliant on
                // the web. The app shows the tier read-only and hands off — to the
                // plans page, which is where a change of plan is actually made.
                Button(L10n.t(.accountManagePlan)) { NSWorkspace.shared.open(AppEnvironment.plansWebURL) }
            }

            meter(L10n.t(.accountTraffic), UsagePresentation.display(usage.traffic))
            meter(L10n.t(.accountStorage), UsagePresentation.display(usage.storage))

            Text(UsagePresentation.resetText(resetsAt: usage.resetsAt, now: Date()))
                .font(.caption).foregroundStyle(.secondary)

            // The figures above are the last ones that arrived, not the current
            // ones. That is a caveat on the meters, so it sits inside their card.
            if session.isStale {
                InlineMessage(.warning, L10n.t(.accountStaleFigures))
            }
        }
    }

    // MARK: - devices

    @ViewBuilder
    private var devicesCard: some View {
        SectionCard(title: L10n.t(.accountDevicesHeading)) {
            // Browsers are left out on purpose — see AccountDevice.holdsRevocableToken.
            Text(L10n.t(.accountDevicesBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if management.isLoading && management.devices.isEmpty {
                ProgressView().controlSize(.small)
            } else if management.devices.isEmpty {
                Text(L10n.t(.accountNoDevices))
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
                        Text(device.name.isEmpty ? L10n.t(.accountUnnamedDevice) : device.name)
                            .lineLimit(1).truncationMode(.middle)
                        if device.current {
                            Text(L10n.t(.accountThisMac))
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
                Button(L10n.t(.commonRevoke)) { deviceToRevoke = device }
                    .disabled(management.isBusy(row: device.id))
            }
            if let error = management.error(forRow: device.id) {
                InlineMessage(.failure, error)
            }
        }
    }

    private func deviceDetail(_ device: AccountDevice) -> String {
        AccountPresentation.deviceDetail(kind: device.kind,
                                         lastSeenAt: device.lastSeenAt,
                                         createdAt: device.createdAt)
    }

    // MARK: - stored files

    @ViewBuilder
    private var filesCard: some View {
        SectionCard(title: L10n.t(.accountFilesHeading)) {
            Text(L10n.t(.accountFilesBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if management.isLoading && management.files.isEmpty {
                ProgressView().controlSize(.small)
            } else if management.files.isEmpty {
                Text(L10n.t(.accountNoFiles))
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
                    Button(L10n.t(.accountCopyLink)) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                    }
                    Spacer()
                    Button(L10n.t(.commonDelete), role: .destructive) { fileToDelete = row.file }
                        .disabled(management.isBusy(row: row.id))
                }
            case .keyNotOnThisMac:
                // The honest version of a disabled button: the key was only ever
                // in the link, and this Mac does not have it. Saying "unavailable"
                // without saying why reads as a bug the user could work around.
                // `.info` rather than `.warning`: nothing went wrong, and nothing
                // here can be retried into working.
                InlineMessage(.info, L10n.t(.accountKeyNotOnThisMac))
                HStack {
                    Spacer()
                    Button(L10n.t(.commonDelete), role: .destructive) { fileToDelete = row.file }
                        .disabled(management.isBusy(row: row.id))
                }
            case .keyLookupFailed(let message):
                // Not the same statement as "you don't have the key": this one
                // may be one keychain unlock away, which is why it warns rather
                // than merely informs.
                InlineMessage(.warning, L10n.t(.accountKeyLookupFailed, [message]))
                HStack {
                    Spacer()
                    Button(L10n.t(.commonDelete), role: .destructive) { fileToDelete = row.file }
                        .disabled(management.isBusy(row: row.id))
                }
            }

            if let error = management.error(forRow: row.id) {
                InlineMessage(.failure, error)
            }
        }
    }

    private func fileDetail(_ file: StoredFileSummary) -> String {
        AccountPresentation.fileDetail(file)
    }

    // MARK: - deleting the account itself

    /// The one control on this screen that can end the account, and the only
    /// one that is deliberately two steps away from happening: the button opens
    /// a confirmation, the confirmation sends an email, and only the link in
    /// that email destroys anything.
    ///
    /// It is a card at the bottom rather than a menu item or a hidden setting
    /// because it has to be findable — a deletion the user cannot locate is a
    /// deletion that happens by writing to support. What keeps it from being a
    /// hazard is the double opt-in, not obscurity.
    ///
    /// Nothing here signs the user out. The credential stays valid until the
    /// server revokes it on confirmation, which is what leaves a way back for
    /// somebody who changes their mind between the two steps.
    @ViewBuilder
    private var deleteAccountCard: some View {
        SectionCard(title: L10n.t(.accountDeleteAccountHeading)) {
            // The address is the user's own: isolated, never translated.
            Text(L10n.t(.accountDeleteAccountBody, [L10n.token(user.email)]))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            switch session.deletionRequestState {
            case .requested:
                // `.info`, not a success mark: the endpoint answers the same
                // way whether it mailed anything or throttled the request, and
                // nothing has been deleted in either case.
                InlineMessage(.info, L10n.t(.accountDeleteAccountRequested,
                                            [L10n.token(user.email)]))
            case let .failed(message):
                InlineMessage(.failure, message)
            case .idle, .requesting:
                EmptyView()
            }

            HStack {
                // One slot, so the row does not jump and a second press cannot
                // start a second request — the button is simply not the control
                // on screen while one is in flight.
                if isRequestingAccountDeletion {
                    ProgressView { Text(L10n.t(.accountDeleteAccountRequesting)) }
                        .controlSize(.small)
                } else {
                    // Retrying is the same button: a failure left the account
                    // exactly as it was, so there is one action, not two.
                    Button(L10n.t(.accountDeleteAccount), role: .destructive) {
                        confirmingAccountDeletion = true
                    }
                }
                Spacer()
            }
        }
    }

    private var isRequestingAccountDeletion: Bool {
        if case .requesting = session.deletionRequestState { return true }
        return false
    }

    // MARK: - shared bits

    @ViewBuilder
    private func meter(_ title: String, _ d: MeterDisplay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text(L10n.t(.accountMeterOf, [d.usedText, d.capText]))
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            // No bar when unlimited: there is no ratio to draw.
            if let fraction = d.fraction {
                ProgressView(value: fraction)
            }
        }
    }
}
