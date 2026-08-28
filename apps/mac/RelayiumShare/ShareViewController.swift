import AppKit
import RelayiumShareKit
import SwiftUI

/// The macOS share extension's principal class, and deliberately the thinnest
/// file in this target.
///
/// It does three things: read the `NSItemProvider`s the host handed over, host
/// one SwiftUI view, and adapt `NSExtensionContext` to `SharedDraftHost`.
/// Everything else — what gets copied, in what order, what is refused, what is
/// published and what the user is told afterwards — belongs to
/// `SharedDraftPreparation` in the shared package, where `swift test` can drive
/// it with no Share menu in existence. That is the same division the iOS shell
/// uses, against the same model.
///
/// **It does not open the containing app, and must not learn how.** A Share
/// extension is not one of the extension points Apple documents
/// `NSExtensionContext.open(_:completionHandler:)` for. Nor is there a custom URL
/// scheme here, a walk up the responder chain to find `NSApplication`, a
/// pasteboard signal or a notification — each is a way to half-do the same
/// unsupported thing. The extension finishes the copy, says where the files are,
/// and the user opens Relayium; the app re-reads the inbox when it becomes
/// active.
///
/// **What this target does not contain, and must not gain.** No `URLSession`, no
/// `URLRequest`, no account client, no token store, no Keychain query, no
/// uploader and no key generation. It is a staging process: it copies plaintext
/// the user chose into the App Group and stops. `MacSurfaceGuardTests` scans this
/// directory for every one of those symbols, because each is an absence and an
/// absence has no runtime to observe. The entitlements enforce the same thing
/// from the other side: with no network entitlement at all, a request added here
/// would be refused by the sandbox rather than caught in review.
final class ShareViewController: NSViewController {
    private var model: SharedDraftPreparation?

    /// A Share extension is loaded from its principal class with no nib, so the
    /// view has to be made rather than found. A plain container: everything
    /// visible is the SwiftUI child added in `viewDidLoad`.
    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 320))
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        // Resolved here rather than in the model, so a missing App Group is one
        // sentence on screen instead of a crash inside a Share menu belonging to
        // somebody else's app. `AppGroup` fails closed: there is no fallback
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

    /// The user can dismiss this surface without pressing anything — closing the
    /// host's sheet tears this controller down. The draft in progress is this
    /// object's to abandon: `SharedDraftWriter` cleans up from `deinit` as a last
    /// resort, but relying on that alone would leave the timing to ARC, and
    /// `deinit` does not run at all if the system kills this process — which is
    /// what `SharedDraftStore.sweepIncomplete` is for.
    override func viewDidDisappear() {
        super.viewDidDisappear()
        // `isStaging`, not "busy". It is false once the draft is published — the
        // surface going away after Done is success, not a cancellation — and
        // false once the model has been cancelled, so pressing Cancel and then
        // having the view torn down cancels the host request exactly once.
        // `SharedDraftPreparation.cancel` is idempotent as well; this is the half
        // that keeps the two paths from disagreeing about what happened.
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
        // The direction the copy layer resolved, applied at this surface's root
        // for the reason the app's two scene roots do it: the catalogs live in a
        // package bundle, so SwiftUI does not mirror an RTL UI on its own.
        // Left-to-right for both shipped languages since Arabic was frozen; kept
        // derived rather than hard-coded so a restored RTL language reaches this
        // extension too.
        let hosting = NSHostingController(
            rootView: root.environment(\.layoutDirection,
                                       L10n.current.isRightToLeft ? .rightToLeft : .leftToRight))
        addChild(hosting)
        hosting.view.frame = view.bounds
        hosting.view.autoresizingMask = [.width, .height]
        view.addSubview(hosting.view)
    }
}

/// `NSExtensionContext`, behind the two calls the model actually makes — and they
/// are the only two an extension of this point is documented to have.
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
