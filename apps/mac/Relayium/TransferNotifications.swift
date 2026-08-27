import Combine
import Foundation
import RelayiumAppKit

/// App-scoped transfer notifications.
///
/// These used to be `.onChange` modifiers on `ContentView`. That was correct
/// while every transfer began with the user looking at the window, and wrong the
/// moment the app started accepting transfers it was not asked for: closing the
/// window destroys the view tree, and with it every observer — so the one case
/// where a notification is the *only* way to find out something arrived is
/// exactly the case that had none.
///
/// Living here also removes the duplicate risk in the other direction: there is
/// one subscriber per model for the whole process, so a second window (or a
/// rebuilt view tree) cannot produce a second notification for one event.
@MainActor
final class TransferNotificationCenter: ObservableObject {
    private let notifier = TransferNotifier()
    private var cancellables: Set<AnyCancellable> = []
    /// The last message id already announced **per module and per session**, so
    /// a transcript republished for any other reason cannot re-announce its
    /// tail.
    ///
    /// Keyed by the module's route rather than held as one value, and that
    /// became load-bearing the moment macOS gained two independent transfer
    /// modules: message ids are per session, so a single shared "last id" would
    /// let a message arriving in the Nearby module suppress the announcement of
    /// a message with the same id arriving in the Direct one.
    ///
    /// Keyed by ROUTE rather than by the presentation model's identity: an
    /// identity key would grow an entry per session and never reclaim one. The
    /// SESSION half of the key is supplied by clearing the entry whenever that
    /// route publishes a new model — see `observe(_:)` — which is what an
    /// identity key was buying and is bounded at two entries per route.
    ///
    /// Without that reset, ids being model-local and restarting from zero means
    /// the first message of a second session is silently suppressed whenever it
    /// lands on the id the previous session stopped at.
    private var lastAnnouncedMessageID: [AppDestination: Int] = [:]
    /// **Every terminal batch id already announced, per module and per session.**
    ///
    /// A SET rather than a high-water cursor, because batches do not finish in
    /// the order they started. A cursor that stored only the newest terminal id
    /// lost two real cases:
    ///
    ///  - **Reverse completion.** A small batch queued second can finish first.
    ///    The cursor then held #2, and #1 finishing afterwards was read as
    ///    already-announced — the transfer the user was actually waiting on was
    ///    the one that went unannounced.
    ///  - **Several at once.** One publication can carry more than one newly
    ///    terminal batch. Taking `last(where: isTerminal)` announced one of them
    ///    and silently dropped the rest.
    ///
    /// Cleared when the route publishes a new file model, exactly as the message
    /// cursor is: ids are model-local and restart at zero, so a set carried
    /// across sessions would suppress the next session's first batches. That
    /// reset is also what bounds it — a set per live session, not per process.
    private var announcedBatchIDs: [AppDestination: Set<Int>] = [:]
    /// Subscriptions that belong to ONE link's presentation models rather than
    /// to the module — **one store per lane, per route.**
    ///
    /// Two dictionaries rather than one set per route, and that separation is
    /// the whole correctness of this object. `LinkWorkspaceModel` publishes
    /// `textModel` and then `fileModel`, in that order, on both attach and
    /// teardown. A single shared set meant the second publication replaced
    /// whatever the first had just installed: the file model's arrival threw
    /// away the text subscription microseconds after it was made, and incoming
    /// MESSAGES stopped being announced entirely. An `appending:` flag hid that
    /// behind an assumption about ordering, which is exactly the kind of thing
    /// this object must not depend on — the publication order belongs to another
    /// type and can change without anything here failing to compile.
    ///
    /// Keyed separately, each lane's store is replaced only by its own model's
    /// publication, so the two cannot race and the order stops mattering.
    private var fileSubscriptions: [AppDestination: AnyCancellable] = [:]
    private var textSubscriptions: [AppDestination: AnyCancellable] = [:]

    private let uploadModel: CloudUploadModel
    private let downloadModel: CloudDownloadModel
    /// Both transfer modules. Each one has its own file and text lane, and an
    /// arrival in either is equally invisible when the window is closed — which
    /// is the entire case these notifications exist for.
    private let modules: TransferModules
    private let receiveModel: NearbyReceiveModel
    private var started = false

    init(uploadModel: CloudUploadModel,
         downloadModel: CloudDownloadModel,
         modules: TransferModules,
         receiveModel: NearbyReceiveModel) {
        self.uploadModel = uploadModel
        self.downloadModel = downloadModel
        self.modules = modules
        self.receiveModel = receiveModel
    }

    /// Subscribes. Idempotent, and separate from `init` on purpose: `@StateObject`
    /// takes its initial value as an autoclosure, so an object nobody reads is
    /// never built — and a notification centre that is never built is a silent
    /// app. The launch task calls this, which is also the read that creates it.
    func start() {
        guard !started else { return }
        started = true

        uploadModel.$state
            .sink { [weak self] state in
                switch state {
                case .uploading: self?.notifier.prepare()
                case .done: self?.notifier.completed(L10n.t(.notifyUploadReady))
                default: break
                }
            }
            .store(in: &cancellables)

        downloadModel.$state
            .sink { [weak self] state in
                switch state {
                case .downloading:
                    self?.notifier.prepare()
                case let .done(urls):
                    self?.notifier.completed(NotificationCopy.filesReady(count: urls.count))
                default:
                    break
                }
            }
            .store(in: &cancellables)

        // Every module, rather than one pair of models. Nearby and Direct run
        // independently now, so a transfer the user cannot see may be in either
        // — and a subscription to one of them would announce half of them.
        for module in modules.all { observe(module) }

        // An unsolicited session is the one event the user has no other way to
        // notice: the window may be closed and nothing was clicked to start it.
        receiveModel.onSessionStarted = { [weak self] kind in
            self?.notifier.prepare()
            self?.notifier.completed(
                L10n.t(kind == .file ? .notifyIncomingFiles : .notifyIncomingText),
                title: L10n.t(.notifyTitleIncoming))
        }

        receiveModel.$lastFailure
            .sink { [weak self] failure in
                guard failure != nil else { return }
                self?.notifier.completed(L10n.t(.notifyIncomingFailed),
                                         title: L10n.t(.notifyTitleFailed))
            }
            .store(in: &cancellables)
    }

    /// **One module's link, and the code it is waiting on.** Written once and
    /// applied to each module, so the two cannot drift into announcing different
    /// things.
    ///
    /// The lanes are reached through the link's two presentation models, which
    /// are OPTIONAL and are replaced with every session — so the subscriptions
    /// to them are nested and are torn down with the link that owned them. A
    /// flat subscription would either miss every session after the first or keep
    /// a dead session's projection announcing into a live one.
    private func observe(_ module: TransferModule) {
        let route = module.route

        // The pre-peer half: a mint in flight, or six digits on screen waiting
        // for somebody to type them.
        module.code.$state
            .sink { [weak self] state in
                switch state {
                case .minting, .showing: self?.notifier.prepare()
                case .idle, .failed: break
                }
            }
            .store(in: &cancellables)

        module.link.$connection
            .sink { [weak self] connection in
                switch connection {
                case .watching, .requesting, .establishing, .open:
                    self?.notifier.prepare()
                case let .ended(reason):
                    // Only the endings that went wrong. `closed` is the user's
                    // own hangup or the peer's, and announcing it would put a
                    // notification on a locked screen for an action they just
                    // took. The same rule `LinkEndingCopy` states for its own
                    // callers, spelled here because this is `RelayiumAppKit`'s
                    // consumer rather than one of its surfaces.
                    guard reason != .closed else { return }
                    self?.notifier.completed(L10n.t(.notifyTransferStopped),
                                             title: L10n.t(.notifyTitleFailed))
                case .idle:
                    break
                }
            }
            .store(in: &cancellables)

        // **The peer could not be reached at all.** Its own announcement rather
        // than a link ending, because no attempt was ever claimed for that peer:
        // there is nothing to report as stopped, only a rendezvous that cannot
        // work. Silent while false, so this fires once per refusal.
        module.link.$unsupportedPairingPeer
            .sink { [weak self] refused in
                guard refused else { return }
                self?.notifier.completed(L10n.t(.errorRealtimeLegacyPeer),
                                         title: L10n.t(.notifyTitleFailed))
            }
            .store(in: &cancellables)

        // Each lane subscribes to ITS OWN store, so neither publication can
        // disturb the other's — see `fileSubscriptions` / `textSubscriptions`.
        //
        // The de-duplication cursor is reset in the same step, because a new
        // presentation model is a new SESSION and its ids restart from zero. A
        // cursor carried across sessions suppresses the first message or batch
        // of the next one whenever the id happens to repeat, which for
        // model-local counters is the common case rather than a rare one.
        module.link.$fileModel
            .sink { [weak self] files in
                guard let self else { return }
                self.announcedBatchIDs[route] = []
                self.fileSubscriptions[route] = files?.$batches
                    .sink { [weak self] batches in
                        self?.announceFinishedBatch(batches, route: route)
                    }
            }
            .store(in: &cancellables)

        module.link.$textModel
            .sink { [weak self] text in
                guard let self else { return }
                self.lastAnnouncedMessageID[route] = nil
                self.textSubscriptions[route] = text?.$textMessages
                    .sink { [weak self] messages in
                        self?.announceIncomingMessage(messages, route: route)
                    }
            }
            .store(in: &cancellables)
    }

    /// **Every batch that has newly finished, announced once each.**
    ///
    /// Iterated in the model's own order rather than reduced to one, because a
    /// publication can carry more than one newly terminal batch and batches do
    /// not finish in the order they started. `batches` is republished on every
    /// progress tick, so the set is what makes "newly" mean anything.
    ///
    /// Counts only. No filename, no peer name, no code, no key: these bodies are
    /// readable on a locked screen. They also say nothing about WHICH module
    /// finished, for the same reason.
    private func announceFinishedBatch(_ batches: [LinkFileBatch], route: AppDestination) {
        var announced = announcedBatchIDs[route] ?? []
        // Written back before the first notification, so a re-entrant publish
        // cannot see the old set and announce the same batch twice.
        let newlyTerminal = batches.filter { $0.isTerminal && !announced.contains($0.id) }
        guard !newlyTerminal.isEmpty else { return }
        announced.formUnion(newlyTerminal.map(\.id))
        announcedBatchIDs[route] = announced

        for batch in newlyTerminal {
            switch batch.state {
            case let .received(files, _):
                notifier.completed(files.isEmpty
                    ? L10n.t(.notifyFilesDelivered)
                    : NotificationCopy.filesReady(count: files.count))
            case .finished:
                // Outbound: the peer took it. Nothing on this disk to open.
                notifier.completed(L10n.t(.notifyFilesDelivered))
            case .failed:
                notifier.completed(L10n.t(.notifyTransferStopped),
                                   title: L10n.t(.notifyTitleFailed))
            case .offered, .queued, .transferring:
                break
            }
        }
    }

    /// An incoming message, announced once. Never the body — see above.
    private func announceIncomingMessage(_ messages: [LinkTextMessage],
                                         route: AppDestination) {
        guard let last = messages.last, last.direction == .incoming,
              last.id != lastAnnouncedMessageID[route] else { return }
        lastAnnouncedMessageID[route] = last.id
        notifier.completed(L10n.t(.notifyNewMessage),
                           title: L10n.t(.notifyTitleMessage))
    }
}
