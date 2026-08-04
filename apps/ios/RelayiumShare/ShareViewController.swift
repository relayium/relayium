import SwiftUI
import UIKit
import RelayiumShareKit

/// The share extension's principal class, and deliberately the thinnest file in
/// this target.
///
/// It does three things: read the `NSItemProvider`s the host handed over, host
/// one SwiftUI view, and adapt `NSExtensionContext` to `SharedDraftHost`.
/// Everything else — what gets copied, in what order, what is refused, what is
/// published and what the user is told afterwards — belongs to
/// `SharedDraftPreparation` in the shared package, where `swift test` can drive
/// it with no share sheet in existence.
///
/// **It does not open the containing app, and must not learn how.** Apple
/// documents `NSExtensionContext.open(_:completionHandler:)` as supported by the
/// Today and iMessage extension points on iOS; a Share Extension is neither.
/// Nor is there a custom URL scheme here, a walk up the responder chain to find
/// `UIApplication`, a pasteboard signal or a notification — each is a way to
/// half-do the same unsupported thing. The extension finishes the copy, says
/// where the files are, and the user opens Relayium; the app re-reads the inbox
/// when its scene becomes active.
///
/// **What this target does not contain, and must not gain.** No `URLSession`, no
/// `URLRequest`, no account client, no token store, no Keychain query, no
/// uploader and no key generation. The extension is a staging process: it copies
/// plaintext the user chose into the App Group and stops. Encryption, the
/// account's limits, the upload and the link are all the app's, and stay the
/// app's. `IOSSurfaceGuardTests` scans this directory for every one of those
/// symbols, because each is an absence and an absence has no runtime to observe.
final class ShareViewController: UIViewController {
    private var model: SharedDraftPreparation?

    override func viewDidLoad() {
        super.viewDidLoad()

        // Resolved here rather than in the model, so a missing App Group is one
        // sentence on screen instead of a crash inside a share sheet belonging
        // to somebody else's app. `AppGroup` fails closed: there is no fallback
        // container, because a draft the app cannot read is a copy of the user's
        // files that nothing will ever show them.
        guard let store = try? SharedDraftStore.shared() else {
            return present(.unavailable(SharedDraftCopy.message(
                for: SharedDraftError.unavailableContainer)))
        }

        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        guard !providers.isEmpty else {
            return present(.unavailable(SharedDraftCopy.message(
                for: SharedDraftError.nothingUsable)))
        }

        let model = SharedDraftPreparation(store: store,
                                           loader: ItemProviderLoader(providers: providers),
                                           host: self)
        self.model = model
        present(.preparation(model))
    }

    /// A sheet is a modal the user can swipe away, and doing so tears this
    /// controller down without any button being pressed. The draft in progress
    /// is this object's to abandon: `SharedDraftWriter` cleans up from `deinit`
    /// as a last resort, but relying on that alone would leave the timing to
    /// ARC — and `deinit` does not run at all if the system kills this process,
    /// which is what `SharedDraftStore.sweepIncomplete` is for.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // `isStaging`, not "busy". It is false once the draft is published — the
        // sheet dismissing after Done is success, not a cancellation — and false
        // once the model has been cancelled, so pressing Cancel and then having
        // the sheet torn down cancels the host request exactly once.
        // `SharedDraftPreparation.cancel` is idempotent as well; this is the
        // half that keeps the two paths from disagreeing about what happened.
        guard let model, model.isStaging else { return }
        model.cancel()
    }

    // MARK: - hosting

    private enum Surface {
        case preparation(SharedDraftPreparation)
        case unavailable(String)
    }

    private func present(_ surface: Surface) {
        let root: AnyView
        switch surface {
        case let .preparation(model):
            root = AnyView(ShareRootView(model: model))
        case let .unavailable(message):
            root = AnyView(ShareUnavailableView(message: message) { [weak self] in
                self?.cancelled()
            })
        }
        let hosting = UIHostingController(rootView: root)
        addChild(hosting)
        hosting.view.frame = view.bounds
        hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(hosting.view)
        hosting.didMove(toParent: self)
    }
}

/// `NSExtensionContext`, behind the two calls the model actually makes — and
/// they are the only two an extension of this point is documented to have.
extension ShareViewController: SharedDraftHost {
    func finish() {
        // Nothing is returned to the host app. What this extension produced is a
        // draft in the App Group, not an item the sharing app is waiting for.
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    func cancelled() {
        extensionContext?.cancelRequest(withError: SharedDraftError.cancelled)
    }
}
