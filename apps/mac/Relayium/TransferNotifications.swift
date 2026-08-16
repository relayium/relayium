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
    /// The last message id already announced **per text model**, so a history
    /// array that is republished for any other reason cannot re-announce its
    /// tail.
    ///
    /// Keyed by the model rather than held as one value, and that became
    /// load-bearing the moment macOS gained two independent transfer modules:
    /// message ids are per session, so a single shared "last id" would let a
    /// message arriving in the Nearby module suppress the announcement of a
    /// message with the same id arriving in the Direct one.
    private var lastAnnouncedMessageID: [ObjectIdentifier: Int] = [:]

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

    /// One module's two lanes. Written once and applied to each module, so the
    /// two cannot drift into announcing different things.
    private func observe(_ module: TransferModule) {
        let lane = ObjectIdentifier(module.text)

        module.files.$state
            .sink { [weak self] state in
                switch state {
                case .minting, .joining, .connecting, .transferring:
                    self?.notifier.prepare()
                case let .completed(urls):
                    // Counts only. No filename, no peer name, no code, no key:
                    // this body is readable on a locked screen. It also says
                    // nothing about WHICH module finished, for the same reason.
                    self?.notifier.completed(urls.isEmpty
                        ? L10n.t(.notifyFilesDelivered)
                        : NotificationCopy.filesReady(count: urls.count))
                case .failed:
                    self?.notifier.completed(L10n.t(.notifyTransferStopped),
                                             title: L10n.t(.notifyTitleFailed))
                default:
                    break
                }
            }
            .store(in: &cancellables)

        module.text.$state
            .sink { [weak self] state in
                switch state {
                case .minting, .showingCode, .joining, .connecting, .verifying,
                     .waitingAccept, .incomingRequest, .open:
                    self?.notifier.prepare()
                default:
                    break
                }
            }
            .store(in: &cancellables)

        module.text.$history
            .sink { [weak self] history in
                guard let self, let last = history.last, last.direction == .incoming,
                      last.id != self.lastAnnouncedMessageID[lane] else { return }
                self.lastAnnouncedMessageID[lane] = last.id
                // Never the body — see above.
                self.notifier.completed(L10n.t(.notifyNewMessage),
                                        title: L10n.t(.notifyTitleMessage))
            }
            .store(in: &cancellables)
    }
}
