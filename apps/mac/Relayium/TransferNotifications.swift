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
    /// The last message id already announced, so a history array that is
    /// republished for any other reason cannot re-announce its tail.
    private var lastAnnouncedMessageID: Int?

    private let uploadModel: CloudUploadModel
    private let downloadModel: CloudDownloadModel
    private let fileModel: RealtimeSessionModel
    private let textModel: RealtimeTextSessionModel
    private let receiveModel: NearbyReceiveModel
    private var started = false

    init(uploadModel: CloudUploadModel,
         downloadModel: CloudDownloadModel,
         fileModel: RealtimeSessionModel,
         textModel: RealtimeTextSessionModel,
         receiveModel: NearbyReceiveModel) {
        self.uploadModel = uploadModel
        self.downloadModel = downloadModel
        self.fileModel = fileModel
        self.textModel = textModel
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

        fileModel.$state
            .sink { [weak self] state in
                switch state {
                case .minting, .joining, .connecting, .transferring:
                    self?.notifier.prepare()
                case let .completed(urls):
                    // Counts only. No filename, no peer name, no code, no key:
                    // this body is readable on a locked screen.
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

        textModel.$state
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

        textModel.$history
            .sink { [weak self] history in
                guard let self, let last = history.last, last.direction == .incoming,
                      last.id != self.lastAnnouncedMessageID else { return }
                self.lastAnnouncedMessageID = last.id
                // Never the body — see above.
                self.notifier.completed(L10n.t(.notifyNewMessage),
                                        title: L10n.t(.notifyTitleMessage))
            }
            .store(in: &cancellables)

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
}
