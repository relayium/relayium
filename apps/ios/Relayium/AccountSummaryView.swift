import SwiftUI
import UIKit
import RelayiumKit
import RelayiumAppKit

/// The signed-in account: who this is, what the plan allows and how much of it
/// is used, which devices hold a token, what ciphertext is stored — and the
/// three writes that belong here.
///
/// Read-only for the plan is the product decision, not a shortcut: changing a
/// plan is a billing write and lives on the web. The device list and the
/// stored-file list are R3-D, and they arrive with their writes rather than as
/// read-only lists: a device row nobody can revoke is a security surface with no
/// security action on it.
///
/// Everything is vertical and everything wraps. This is one column on an iPhone
/// and the same column on an iPad, so a device name at the largest Dynamic Type
/// size pushes its badge and its detail onto their own lines instead of
/// truncating one of the two — which is the failure the macOS pane's side-by-side
/// rows would have here.
///
/// Rendered by `AccountTab` for `.ready` and only for `.ready`. That is why all
/// three writes live here rather than in the tab: the tab is a router over
/// session states, and this is the one state that has an account whose devices,
/// files and existence there is anything to do about.
struct AccountSummaryView: View {
    let user: NativeUser
    let usage: UsageResponse
    let onOpenStoredLink: (String) -> Void

    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var management: AccountManagementModel
    /// Leaving the account, from either direction. App-scoped rather than this
    /// view's `@State`, because the moment that matters is the one where this
    /// view does not exist: a revoke of the current device can land after the
    /// user has switched tabs. See `AccountSignOutCoordinator`.
    @EnvironmentObject private var signOut: AccountSignOutCoordinator
    @Environment(\.openURL) private var openURL

    /// The row a confirmation is currently asking about. Held here rather than
    /// in the model: nothing has been asked of the server until the user
    /// confirms, so it is a property of this screen, not of the account.
    @State private var deviceToRevoke: AccountDevice?
    @State private var fileToDelete: StoredFileSummary?
    /// Clipboard acknowledgement is keyed only by the server-issued row id.
    /// The `#k=` capability remains in the model and is not copied into state.
    @State private var copiedStoredFileID: String?
    /// Whether the account-deletion confirmation is up, for the same reason.
    @State private var confirmingAccountDeletion = false

    /// Which account and credential the rows on screen belong to.
    ///
    /// Computed on every read rather than stored, and passed into every call, so
    /// a result can be checked against the account that is on screen when it
    /// ARRIVES — not the one that was on screen when it was asked for. Those
    /// differ exactly when it matters: a signed-out-and-back-in user, a second
    /// sign-in as somebody else, or a refresh that rotated the token. A `@State`
    /// copy would outlive every one of those.
    private var scope: AccountScope {
        AccountScope(accountId: user.id, token: session.bearerToken ?? "")
    }

    var body: some View {
        // ONE structural identity, with every modifier below still attached to
        // it: both row selections, all three confirmations and both `.task(id:)`s
        // live on this view, and splitting it would restart the load and drop a
        // dialog mid-question.
        VStack(alignment: .leading, spacing: 24) {
            profileSection
            devicesSection
            filesSection

            // The rows could not be loaded at all — distinct from a per-row
            // failure, which is drawn on the row it belongs to.
            if let loadError = management.loadError {
                failureLine(loadError)
            }

            // A delete the server CONFIRMED whose local key could not be removed
            // afterwards. Not an error and not attached to a row — the row is
            // gone, and there is no operation left to retry — but the app must
            // not imply it cleaned up something it did not.
            if let cleanupWarning = management.keyCleanupWarning {
                VStack(alignment: .leading, spacing: 8) {
                    Label(cleanupWarning, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L10n.t(.commonDismiss)) { management.dismissKeyCleanupWarning() }
                        .font(.callout)
                }
            }

            Button(L10n.t(.commonRefresh)) { refresh() }
            // Handed to the coordinator rather than performed here. Doing it
            // here would be a second logout path racing the self-revoke one, and
            // the "Signing out" state would die with this view.
            Button(L10n.t(.commonSignOut), role: .destructive) {
                signOut.signOut(scope: scope)
            }

            deleteAccountSection
        }
        // Nothing on this screen is disabled locally while a sign-out runs, and
        // that is not an omission: `RootView` disables the whole `TabView`, which
        // reaches every control in every tab including these. A second
        // `.disabled` here would be a second owner of the same rule, and the one
        // that matters is the one covering the tabs this screen cannot see.
        //
        // Keyed on the scope, so signing in as somebody else reloads rather than
        // leaving the previous account's devices — each with a revoke button —
        // on screen under the new account's name.
        //
        // This is the ONLY task on this view now. Noticing a successful
        // self-revoke used to be a second one, and that was the R3-D review's
        // finding: a `.task` dies with the view, and the view dies when the user
        // switches tabs — which is exactly what somebody who has just revoked
        // this device tends to do next. `AccountSignOutCoordinator` observes the
        // signal at app scope instead.
        .task(id: scope) { await management.load(scope) }
        .onChange(of: scope) { _ in copiedStoredFileID = nil }
        .onChange(of: management.files) { files in
            copiedStoredFileID = AccountPresentation.retainedCopiedFileID(
                copiedStoredFileID, in: files)
        }
        // The system's own confirmations, so they are dismissible, readable at
        // every Dynamic Type size and announced the way the platform's users
        // expect. The destructive role is on the button that acts; Cancel is the
        // default.
        // Titled with the SAME name the row showed, fallback included: reading
        // `device.name` straight would title the dialog `Revoke “”?` for a
        // device the list itself calls "Unnamed device".
        .confirmationDialog(
            L10n.t(.accountRevokeTitle,
                   [L10n.token(deviceToRevoke.map { AccountPresentation.deviceName($0) } ?? "")]),
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
            // Revoking the credential in your hand signs this app out; revoking
            // another one does not. Which sentence that is belongs in
            // `AccountPresentation`, where a test drives it — a dialog stating
            // the wrong consequence is a destructive button lying about itself.
            Text(AccountPresentation.revokeConsequence(current: deviceToRevoke?.current == true))
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
        // rather than a row.
        .confirmationDialog(
            L10n.t(.accountDeleteAccountConfirmTitle),
            isPresented: $confirmingAccountDeletion,
            titleVisibility: .visible
        ) {
            // Labelled for what pressing it does — it sends an email and
            // deletes nothing, which is exactly what the message says.
            Button(L10n.t(.accountDeleteAccountConfirmAction), role: .destructive) {
                confirmingAccountDeletion = false
                // Unstructured on purpose: the session owns the scoping, and
                // this view stays on screen either way.
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
    /// `scope` is recomputed from `user` — this render's value — and from the
    /// live `session.bearerToken`, so after `refresh()` it can name an account
    /// the session no longer holds: an expired bearer pairs the old id with an
    /// empty token, and a second sign-in pairs it with a stranger's credential.
    /// Which outcome that is belongs to `AccountRefreshDecision`, where it is
    /// tested; this only carries it out. A new account, if there is one, is
    /// loaded by `.task(id: scope)` when this view re-renders for it.
    private func refresh() {
        let previous = scope
        Task {
            await session.refresh()
            // `logOut()` supersedes the session refresh, but deliberately keeps
            // `.ready` until its own network call finishes. Without this gate the
            // returning refresh would see that old ready state and recreate all
            // rows and reconstructed links after sign-out already cleared them.
            //
            // Read from the coordinator rather than from this view's `@State`:
            // the account view can be torn down and rebuilt while the logout is
            // still running — a tab switch away and back — and a fresh `@State`
            // would come back `false` and reopen the gate mid-sign-out.
            guard !signOut.isSigningOut else {
                management.clear(scope: previous)
                return
            }
            switch AccountRefreshDecision.next(previous: previous,
                                               state: session.state,
                                               bearer: session.bearerToken) {
            case .reload(let current): await management.load(current)
            case .clear(let stale):    management.clear(scope: stale)
            }
        }
    }

    // MARK: - profile, plan and usage

    @ViewBuilder
    private var profileSection: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName.isEmpty ? user.email : user.displayName)
                    .font(.title3.weight(.semibold))
                Text(user.email).foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(usage.plan.name).font(.headline)
                    // Both the "should this show at all" predicate and the
                    // wording live in UsagePresentation, where they are tested.
                    // A raw Stripe status must never reach this capsule.
                    if let badge = UsagePresentation.subscriptionBadge(
                        for: usage.plan.subscriptionStatus) {
                        Text(badge)
                            .font(.caption)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Button(L10n.t(.accountManagePlan)) { openURL(AppEnvironment.plansWebURL) }
            }

            meter(L10n.t(.accountTraffic), UsagePresentation.display(usage.traffic))
            meter(L10n.t(.accountStorage), UsagePresentation.display(usage.storage))

            Text(UsagePresentation.resetText(resetsAt: usage.resetsAt, now: Date()))
                .font(.caption).foregroundStyle(.secondary)

            if session.isStale {
                Label(L10n.t(.accountStaleFigures), systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - devices

    @ViewBuilder
    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.accountDevicesHeading)).font(.headline)
            // Browsers are left out on purpose — see AccountDevice.holdsRevocableToken.
            Text(L10n.t(.accountDevicesBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // A refresh must never replace a usable list with a spinner, which
            // is why the model's `isLoading` is combined with "nothing on screen"
            // rather than read alone. Labelled rather than bare: VoiceOver reads
            // nothing from a spinner, and this screen has two lists loading.
            if management.isLoading && management.devices.isEmpty {
                ProgressView { Text(L10n.t(.accountLoadingDevices)) }
            } else if management.devices.isEmpty {
                Text(L10n.t(.accountNoDevices))
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(management.devices) { device in
                    deviceRow(device)
                }
            }
        }
    }

    @ViewBuilder
    private func deviceRow(_ device: AccountDevice) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Name, badge and detail each on their own line. Side by side they
            // would compete for one row's width, and at the largest Dynamic Type
            // sizes the name — the only thing identifying the row — is what
            // would lose.
            Text(AccountPresentation.deviceName(device))
                .font(.callout.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            if device.current {
                Text(L10n.t(.accountThisMac))
                    .font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }
            Text(AccountPresentation.deviceDetail(kind: device.kind,
                                                  lastSeenAt: device.lastSeenAt,
                                                  createdAt: device.createdAt))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // Only the row being changed is disabled: a slow revoke on one
            // device must not freeze the rest of the list.
            Button(L10n.t(.commonRevoke), role: .destructive) { deviceToRevoke = device }
                .buttonStyle(.bordered)
                .disabled(management.isBusy(row: device.id))
                // The visible label is one word on every row, which is right to
                // look at and useless to hear: two devices of the same model
                // sign in under the same name routinely.
                .accessibilityLabel(AccountPresentation.revokeActionLabel(for: device))

            if let error = management.error(forRow: device.id) {
                failureLine(error)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - stored files

    @ViewBuilder
    private var filesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.accountFilesHeading)).font(.headline)
            Text(L10n.t(.accountFilesBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if management.isLoading && management.files.isEmpty {
                ProgressView { Text(L10n.t(.accountLoadingFiles)) }
            } else if management.files.isEmpty {
                Text(L10n.t(.accountNoFiles))
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(management.files) { row in
                    fileRow(row)
                }
            }
        }
    }

    @ViewBuilder
    private func fileRow(_ row: StoredFileRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // The id is what the server knows this object by and the only thing
            // that identifies the row, so it is selectable and monospaced rather
            // than decorative.
            Text(row.file.id)
                .font(.caption.monospaced()).textSelection(.enabled)
                .lineLimit(2).truncationMode(.middle)
            Text(AccountPresentation.fileDetail(row.file))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // Which of the three states this row is in is decided in
            // `AccountPresentation`, where a test drives it. The consequential
            // half is that a `#k=` link — which IS the plaintext to anybody
            // holding it — reaches Open and Share in exactly one of them.
            switch AccountPresentation.link(for: row.link) {
            case .shareable(let link):
                Button(L10n.t(.downloadOpen)) { onOpenStoredLink(link) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel(
                        AccountPresentation.openActionLabel(fileId: row.file.id))
                Button {
                    UIPasteboard.general.string = link
                    copiedStoredFileID = row.id
                } label: {
                    Label(L10n.t(copiedStoredFileID == row.id
                                 ? .commonCopied : .accountCopyLink),
                          systemImage: copiedStoredFileID == row.id
                              ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(AccountPresentation.copyActionLabel(
                    fileId: row.file.id, copied: copiedStoredFileID == row.id))
                ShareLink(item: link) { Text(L10n.t(.commonShare)) }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(
                        AccountPresentation.shareActionLabel(fileId: row.file.id))
            case .unavailable(let explanation):
                // The honest version of a disabled button: the key was only ever
                // in the link and this device does not have it. Informational
                // rather than a warning — nothing went wrong, and nothing here
                // can be retried into working.
                Label(explanation, systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            case .lookupFailed(let explanation):
                // Not the same statement as "you don't have the key": this one
                // may be one keychain unlock away, which is why it warns rather
                // than merely informs.
                Label(explanation, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(L10n.t(.commonDelete), role: .destructive) { fileToDelete = row.file }
                .buttonStyle(.bordered)
                .disabled(management.isBusy(row: row.id))
                .accessibilityLabel(AccountPresentation.deleteActionLabel(fileId: row.file.id))

            if let error = management.error(forRow: row.id) {
                failureLine(error)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - deleting the account itself

    /// Ending the account, in two steps that are deliberately separate: this
    /// button opens a confirmation, the confirmation asks the server for an
    /// email, and only the link in that email destroys anything.
    ///
    /// Findable rather than hidden — a deletion nobody can locate becomes a
    /// support request — and safe because of the double opt-in, not because of
    /// obscurity. Nothing here signs the user out: the credential stays valid
    /// until the server revokes it on confirmation, which is what leaves a way
    /// back to somebody who changes their mind in between.
    @ViewBuilder
    private var deleteAccountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.accountDeleteAccountHeading)).font(.headline)
            // The address is the user's own: isolated, never translated.
            Text(L10n.t(.accountDeleteAccountBody, [L10n.token(user.email)]))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            switch session.deletionRequestState {
            case .requested:
                // Not "sent": the endpoint answers the same way whether it
                // mailed anything or throttled the request, and nothing has
                // been deleted either way. A symbol as well as the words, so
                // the notice does not depend on where it sits on screen.
                Label(L10n.t(.accountDeleteAccountRequested, [L10n.token(user.email)]),
                      systemImage: "envelope")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            case let .failed(message):
                failureLine(message)
            case .idle, .requesting:
                EmptyView()
            }

            // One slot, so the layout does not jump and a second press cannot
            // start a second request — the button is not on screen while one is
            // in flight. Labelled rather than a bare spinner, which VoiceOver
            // reads nothing from.
            if isRequestingAccountDeletion {
                ProgressView { Text(L10n.t(.accountDeleteAccountRequesting)) }
            } else {
                // Retrying is this same button: a failure left the account
                // exactly as it was, so there is one action, not two.
                Button(L10n.t(.accountDeleteAccount), role: .destructive) {
                    confirmingAccountDeletion = true
                }
            }
        }
    }

    private var isRequestingAccountDeletion: Bool {
        if case .requesting = session.deletionRequestState { return true }
        return false
    }

    // MARK: - shared bits

    /// Every failure on this screen, said the same way. Colour is never the only
    /// carrier: the symbol says "problem" to a reader who cannot distinguish the
    /// red, and the text wraps rather than truncating.
    private func failureLine(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle")
            .font(.callout).foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Label above value rather than beside it: at the largest Dynamic Type
    /// sizes a row truncates one of the two, and the figure is the point.
    @ViewBuilder
    private func meter(_ title: String, _ display: MeterDisplay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline)
            Text(L10n.t(.accountMeterOf, [display.usedText, display.capText]))
                .font(.subheadline).foregroundStyle(.secondary)
            // No bar when unlimited: there is no ratio to draw.
            if let fraction = display.fraction {
                ProgressView(value: fraction)
            }
        }
        // One element, so VoiceOver reads "Traffic, 1 MB of 5 GB" instead of a
        // bare percentage with no idea what it measures.
        .accessibilityElement(children: .combine)
    }
}
