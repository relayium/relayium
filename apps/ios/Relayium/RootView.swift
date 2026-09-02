import SwiftUI
import RelayiumAppKit

/// The app's shell, and deliberately the dumbest file in it.
///
/// It never reads `session.state`. The receive flow R3-A shipped works with no
/// account, and the only way to keep that true in a shell that hosts
/// account-backed destinations is to make it structural: every browseable
/// surface exists in every session state, so signing out, failing to sign in, or
/// never signing in cannot remove, gate or rebuild the anonymous ones. Every
/// gate lives INSIDE the destination it belongs to, and the only thing this file
/// learns about the account is where to route a user who needs one — as
/// destination selections handed down as closures, not session reads.
///
/// ## 0.3.0: one screen list, two shells, and a destination that is presented
///
/// **The five surfaces are enumerated once.** `IOSSurface.browseable` is the
/// list, `destination(for:)` is the switch, and both the tab bar and the iPad
/// sidebar render from them. That is what makes "compact and regular show the
/// same app" a property of the composition rather than a rule two layouts have
/// to keep — and it is also the positive form of a guard this file used to need
/// as a ban. `IOSSurfaceGuardTests` refused the word `deviceInbox` anywhere
/// under `apps/ios`, because `AppDestination` had a case iOS could not draw and
/// a `TabView` handed a selection with no matching `.tag` renders an empty
/// screen. iOS draws it now, so the ban is gone; what replaces it is that the
/// selection binding below can only ever produce `IOSShellPlacement.backgroundRoute`,
/// which is a browseable surface's route by construction.
///
/// **`storedReceive` is presented, not selected.** Opening a stored link is
/// something the OS hands this app — a verified Universal Link, or a stored-file
/// row inside Account — rather than somewhere a person sets out to go, so it no
/// longer occupies one of five primary tabs. `IOSShellModel` keeps the
/// browseable surface underneath it, which is what makes dismissing the sheet
/// return the user to where they actually were rather than to whichever tab
/// happens to be first.
///
/// ## What this file still owns, and why each has to be here
///
///  1. **The selection is app-scoped**, in `AppNavigationModel`. An unsolicited
///     nearby session has to be able to select the LAN Transfer surface from
///     outside the view tree — it is admitted on a socket's queue, with no view
///     involved — and a `@State` is reset whenever SwiftUI rebuilds that tree.
///  2. **It reconciles `TransferPresence` when both models go idle.** Ownership
///     outlives a transfer on purpose, so the one fact that can make it stale is
///     that there is no session left at all — and the surface that claimed it
///     may be the one SwiftUI has torn down.
///  3. **The one Universal Link subscription.** A link the OS delivers arrives
///     for a surface that is not on screen; a handler inside a destination is
///     absent for exactly the case that matters. It decides nothing:
///     `AppDeepLinkCoordinator` owns where a link goes and what it may
///     overwrite, and that object lives where a test can drive it.
struct RootView: View {
    @EnvironmentObject private var session: AccountSession
    /// The ONE account-adjacent fact this file learns, and it is not who is
    /// signed in: whether a sign-out's network revocation is currently running.
    ///
    /// That distinction is the whole reason this does not break the rule above.
    /// A gate on `session.state` would decide which surfaces exist from whether
    /// somebody has an account, which is what the shell's structure exists to
    /// avoid. This is a transient operation — it goes up when a revocation
    /// starts and comes down when it ends, signed in or not — and while it is up
    /// the bearer is either already dead server-side or being killed, so an
    /// action on ANY surface would be spent against a credential that is going
    /// away.
    @EnvironmentObject private var signOut: AccountSignOutCoordinator
    @ObservedObject var download: CloudDownloadModel
    @ObservedObject var upload: CloudUploadModel
    @ObservedObject var send: SendSelectionModel
    /// The receive half of the Device Inbox, and the send half. Passed through
    /// for the same reason every other model here is: this file renders none of
    /// it and decides none of it.
    @ObservedObject var inbox: InboxController
    @ObservedObject var deliveries: InboxSendModel
    // The direct half's app-scoped owners, passed through rather than read:
    // this file renders none of their state and decides none of it. The four
    // that both transfer surfaces share are handed to BOTH — one set of models,
    // one set of security scopes, one answer to files-or-text.
    @ObservedObject var direct: RealtimeSessionModel
    @ObservedObject var directText: RealtimeTextSessionModel
    @ObservedObject var directSelection: DirectSendSelection
    @ObservedObject var directModes: DirectModeSelection
    @ObservedObject var foreground: ForegroundSessionCoordinator
    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var nearbyReceive: NearbyReceiveModel
    @ObservedObject var residency: NearbyResidencyCoordinator
    /// The unified `link/1` and its own post-connect file selection. Both go to
    /// LAN Transfer alone: `link/1` is code-less-room only on this platform, so
    /// Cross-network Transfer has nothing to do with either.
    @ObservedObject var link: LinkWorkspaceModel
    @ObservedObject var linkSelection: DirectSendSelection
    @ObservedObject var navigation: AppNavigationModel
    /// Which surface is drawn and which is presented over it, derived from the
    /// one selection above. App-scoped so "where the user was before the link"
    /// survives the rebuild that presenting a sheet causes.
    @ObservedObject var shell: IOSShellModel
    @ObservedObject var presence: TransferPresence
    // Routing only. This file renders neither: it observes the one place a
    // verified link arrives and hands it straight to the coordinator that
    // decides what it may touch.
    @ObservedObject var deepLinks: AppDeepLinkRouter
    @ObservedObject var deepLinkRouting: AppDeepLinkCoordinator

    /// Which shell to draw.
    ///
    /// **The size class, not the idiom.** A `UIDevice.userInterfaceIdiom` check
    /// would give an iPad in a narrow Split View or a Slide Over the sidebar it
    /// has no room for, and would give the iPhone-sized layout to nothing at
    /// all. The size class is the platform's own answer to "is there room for a
    /// second column", it changes live as the user resizes, and it is what makes
    /// a full-width iPad and a compact one two layouts of one app rather than
    /// two apps.
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        shellBody
            // Applied to the shell itself, so it reaches every control on every
            // surface AND the tab bar or sidebar — a surface the user could
            // still switch to would be a surface they could still act in. It is
            // the one place this rule lives; no individual screen repeats it.
            .disabled(signOut.isSigningOut)
            // Said out loud, not merely enforced. A shell that stops responding
            // with no explanation reads as the app having hung, and a bare
            // `ProgressView()` reads as nothing at all to VoiceOver. The overlay
            // is deliberately outside the `.disabled` chain's meaning — it
            // states what the app is waiting for, and it goes away when the call
            // does.
            .overlay {
                if signOut.isSigningOut {
                    ProgressView { Text(L10n.t(.accountSigningOut)) }
                        .padding(24)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            // The one non-browseable surface, over whichever browseable one the
            // user was on. `isPresented` is derived from the placement rather
            // than held here, so a link arriving from outside the view tree
            // raises it — the case a `@State` flag would miss entirely.
            .sheet(isPresented: isPresentingStoredReceive) {
                storedReceive
            }
            // Launch restore. This is the ONE call site, which is what the
            // surface guard checks — not that it runs once. SwiftUI decides when
            // a view's task runs, and a rebuilt root or a re-created scene can
            // start it again; no Info.plist key makes that impossible. Safety
            // comes from the session instead: it is App-scoped, so every
            // invocation reaches the same object, and `restore()` is re-entrant
            // — early-returning on a live account or an in-flight sign-in,
            // refreshing rather than cold-starting when a token is held, and
            // guarding every post-await write on its operation generation.
            .task { await session.restore() }
            // A link the OS handed this app. `AppDeepLinkRouter` has already
            // refused anything that is not a relayium.com link this app can
            // serve, so what arrives is one of exactly two shapes — and
            // everything that happens to it is the shared coordinator's. In
            // particular this file does not decide whether the link may
            // overwrite a transfer that is running; that is the whole reason the
            // coordinator exists.
            .onReceive(deepLinks.$pending.compactMap { $0 }) { link in
                deepLinkRouting.deliver(link)
                // Consumed one turn later, and BOTH halves of that are
                // load-bearing.
                //
                // Deferred, because `@Published` emits in `willSet`: this
                // handler runs before the router has stored the link, so a
                // `consume()` from here is overwritten by the very assignment
                // that delivered it — leaving the router holding a link that
                // `Published` then replays to the next subscriber, which is a
                // re-resolve of a download the user may already have saved.
                // `AppDeepLinkTests` pins that ordering.
                //
                // And EXPECTED, because that deferral is real time: a second
                // link can land inside it, and a bare `consume()` would throw
                // away a link this subscription has never seen and `Published`
                // will not re-emit.
                Task { @MainActor in deepLinks.consume(link) }
            }
    }

    // MARK: - the two shells, over one list of surfaces

    @ViewBuilder
    private var shellBody: some View {
        if horizontalSizeClass == .regular {
            splitShell
        } else {
            tabShell
        }
    }

    /// iPhone, and an iPad that is not at full width: five tabs.
    ///
    /// `ForEach` over `IOSSurface.browseable` rather than five written-out tabs,
    /// so the tab bar and the sidebar cannot list different things or list them
    /// in a different order. Each tab's `.tag` is that surface's route, and the
    /// selection binding can only ever produce a browseable route — which is
    /// what makes "a selection with no matching tag" unreachable rather than
    /// merely avoided.
    private var tabShell: some View {
        TabView(selection: surfaceSelection) {
            ForEach(IOSSurface.browseable, id: \.self) { surface in
                destination(for: surface)
                    // Addressed by the surface's own raw value, exactly as the
                    // sidebar row and the detail column below are. Acceptance
                    // used to reach these tabs by their rendered copy, which is
                    // why a batch that renamed one destination and removed
                    // another compiled, built for testing, and then failed at
                    // runtime waiting for a tab that no longer exists. An
                    // identifier is the same string on both shells and in both
                    // languages, so a copy change stops being able to break
                    // navigation that has nothing to do with copy.
                    //
                    // iOS 18 exposes this identifier on the SELECTED tab's bar
                    // button only (iOS 26 exposes all of them), so acceptance
                    // falls back to the `browseable` ORDER for unselected tabs
                    // — reordering this list moves both halves together, but
                    // `Shell.browseable` in the UI-test target must follow.
                    .tabItem {
                        Label(title(for: surface), systemImage: surface.symbol)
                            .accessibilityIdentifier("tab-\(surface.rawValue)")
                    }
                    .tag(surface.route)
            }
        }
    }

    /// A full-width iPad: a sidebar and a detail column.
    ///
    /// It renders the SAME `destination(for:)` the tab bar does — one app in two
    /// layouts, not two implementations — and the sidebar rows carry the
    /// subtitles the macOS sidebar carries, because on a screen with room for
    /// them "what does this destination do" is answerable before it is opened
    /// rather than after.
    ///
    /// `.balanced` rather than `.prominentDetail`: the destinations here are
    /// full working surfaces rather than a reading pane over a list, so the
    /// sidebar is not something to push out of the way.
    private var splitShell: some View {
        NavigationSplitView {
            List(selection: sidebarSelection) {
                ForEach(IOSSurface.browseable, id: \.self) { surface in
                    sidebarRow(surface)
                }
            }
            .navigationTitle(L10n.t(.navA11ySections))
            .accessibilityIdentifier("sidebar")
        } detail: {
            destination(for: shell.placement.background)
                // Keyed on the SURFACE, so acceptance observes the detail column
                // itself rather than mistaking an identically titled sidebar row
                // for proof that a destination rendered.
                .accessibilityIdentifier("destination-\(shell.placement.background.rawValue)")
        }
        .navigationSplitViewStyle(.balanced)
    }

    private func sidebarRow(_ surface: IOSSurface) -> some View {
        Label {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(title(for: surface))
                Text(subtitle(for: surface))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: surface.symbol)
                // Decorative, and hidden for the reason the conversation rows'
                // chevron is: the glyph repeats what the title beside it already
                // says, and an `Image(systemName:)` with nothing else to go on
                // is announced by its SYMBOL NAME. The first iPad run of this
                // shell found a sidebar whose rows read "number.circle" and
                // "link.badge.plus" aloud.
                .accessibilityHidden(true)
        }
        .tag(surface.route)
        // **One element per row, not three.**
        //
        // Without this the row published its icon, its title and its subtitle as
        // three separate accessibility elements — so a VoiceOver user swiping
        // the sidebar met each destination three times, and automation
        // addressing the row by identifier resolved whichever of the three came
        // first. `.combine` makes the row what it looks like: one thing, whose
        // spoken name is its title followed by what it does.
        .accessibilityElement(children: .combine)
        // The subtitle is the row's hint as well as its second line, so a
        // VoiceOver user hears what a destination does before opening it — the
        // same reason the macOS sidebar's subtitles are its hints.
        .accessibilityHint(subtitle(for: surface))
        .accessibilityIdentifier("sidebar-\(surface.rawValue)")
    }

    // MARK: - one screen list

    /// The five browseable screens.
    ///
    /// **No `default`**: a sixth browseable surface is a compile error here
    /// rather than a tab or a sidebar row that opens nothing. `storedReceive` is
    /// listed and draws the same screen the sheet does, because a `switch` over
    /// `IOSSurface` must be total — and if a future change ever makes it
    /// browseable, that arm is already honest rather than empty.
    @ViewBuilder
    private func destination(for surface: IOSSurface) -> some View {
        switch surface {
        case .lanTransfer:
            NearbyView(file: direct, text: directText,
                       selection: directSelection, modes: directModes,
                       foreground: foreground, presence: presence,
                       discovery: discovery, receive: nearbyReceive,
                       residency: residency,
                       link: link, linkSelection: linkSelection,
                       onShowSession: { navigation.select($0) })
        case .crossNetworkTransfer:
            DirectView(file: direct, text: directText,
                       selection: directSelection, modes: directModes,
                       foreground: foreground, presence: presence,
                       // Two destination selections, and neither is a session
                       // read. The first is the honest route for a large file —
                       // a live transfer needs both devices open, a stored link
                       // does not — and the second is where a user who needs an
                       // account goes.
                       onOpenSend: { navigation.select(.storedSend) },
                       onOpenAccount: { navigation.select(.account) },
                       onShowSession: { navigation.select($0) })
        case .storedSend:
            SendView(upload: upload, selection: send,
                     onOpenAccount: { navigation.select(.account) })
        case .deviceInbox:
            DeviceInboxView(inbox: inbox, deliveries: deliveries,
                            onOpenAccount: { navigation.select(.account) })
        case .account:
            AccountTab(onOpenStoredLink: { deepLinkRouting.deliverStoredLink($0) })
        case .storedReceive:
            ReceiveView(model: download)
        }
    }

    /// The stored-link screen, presented over whatever the user was on.
    ///
    /// It carries an explicit dismissal rather than relying on the swipe alone:
    /// a sheet that can only be dismissed by a gesture is a sheet a VoiceOver
    /// user cannot leave. Dismissing goes through `navigation.select`, like every
    /// other navigation event in this app, so there is still exactly one
    /// authority for where the user is — `IOSShellModel` reads that selection
    /// and never writes it.
    private var storedReceive: some View {
        ReceiveView(model: download,
                    onDismiss: { navigation.select(shell.placement.backgroundRoute) })
    }

    // MARK: - bindings, and why they cannot produce an untaggable selection

    /// The tab bar's selection.
    ///
    /// **Reads the placement, writes the navigation model.** Reading
    /// `navigation.selection` directly would hand the `TabView` `.storedReceive`
    /// the moment a link arrived — a selection with no matching `.tag`, which
    /// renders an empty screen behind the sheet and leaves the user on it after
    /// dismissing. Reading `backgroundRoute` cannot: it is a browseable
    /// surface's route by construction.
    private var surfaceSelection: Binding<AppDestination> {
        Binding(get: { shell.placement.backgroundRoute },
                set: { navigation.select($0) })
    }

    /// The sidebar's selection. The same binding as the tab bar's, made optional
    /// because `List(selection:)` is — and a nil write (the user deselecting) is
    /// deliberately ignored rather than treated as a navigation event, because
    /// there is no "no destination" state for the detail column to draw.
    private var sidebarSelection: Binding<AppDestination?> {
        Binding(get: { shell.placement.backgroundRoute },
                set: { if let next = $0 { navigation.select(next) } })
    }

    /// Whether the stored-link screen is up.
    ///
    /// Derived rather than stored, so a link arriving from outside the view tree
    /// raises it. The setter handles the swipe-to-dismiss the sheet does on its
    /// own: SwiftUI writes `false`, and the selection has to follow, or the
    /// navigation model would still say `.storedReceive` while nothing showed it
    /// — and the next link would then be a no-op change that raises nothing.
    private var isPresentingStoredReceive: Binding<Bool> {
        Binding(get: { shell.placement.presented != nil },
                set: { presented in
                    guard !presented else { return }
                    navigation.select(shell.placement.backgroundRoute)
                })
    }

    // MARK: - what each surface is called

    /// The tab item and sidebar row title.
    ///
    /// `storedReceive` answers with its own screen title. It is not browseable,
    /// so nothing renders this for it today; it is here because the `switch` is
    /// total and an arm returning an empty string would be a blank row if that
    /// ever changed.
    private func title(for surface: IOSSurface) -> String {
        switch surface {
        case .lanTransfer:          return L10n.t(.navNearby)
        case .crossNetworkTransfer: return L10n.t(.tabDirect)
        case .storedSend:           return L10n.t(.tabSend)
        case .deviceInbox:          return L10n.t(.tabDeviceInbox)
        case .account:              return L10n.t(.tabAccount)
        case .storedReceive:        return L10n.t(.navStoredReceive)
        }
    }

    /// The sidebar row's second line, and its accessibility hint.
    ///
    /// Three of these are the macOS sidebar's own subtitles, unchanged, because
    /// they name platform-neutral facts — an account, a network, both sides
    /// online. The Device Inbox has its own: the macOS one promises *a folder
    /// you choose* and *works with the window closed*, and neither is true here.
    private func subtitle(for surface: IOSSurface) -> String {
        switch surface {
        case .lanTransfer:          return L10n.t(.navLanTransferSubtitle)
        case .crossNetworkTransfer: return L10n.t(.navCrossNetworkSubtitle)
        case .storedSend:           return L10n.t(.navStoredSendSubtitle)
        case .deviceInbox:          return L10n.t(.navIOSDeviceInboxSubtitle)
        case .account:              return L10n.t(.navAccountSubtitle)
        case .storedReceive:        return L10n.t(.navStoredReceive)
        }
    }
}
