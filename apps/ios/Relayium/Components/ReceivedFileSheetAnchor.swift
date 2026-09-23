import QuickLook
import SwiftUI
import UIKit
import RelayiumAppKit

/// **A21: hands an approved received-file request to the system — preview,
/// share sheet or Save to Files — anchored to the controls that asked for it.**
///
/// UIKit rather than `ShareLink`/`.quickLookPreview`, for two reasons that are
/// both about correctness rather than taste:
///
///  - **The URLs are approved at the tap, not at render.** `ShareLink` needs its
///    items while the row is drawn, which would hand the share sheet whatever the
///    row last believed. `InboxReceivedFileAccessModel.begin` re-locates the
///    files and re-checks the account and the entry first; only its request is
///    presented here.
///  - **A request can be withdrawn.** When the account changes or the row is
///    deleted, the model drops the request and this view dismisses whatever it
///    had presented, rather than leaving a share sheet for another session's
///    file on screen.
///
/// On iPad the share sheet is a popover, and a popover needs an anchor: this view
/// sits behind the row's action buttons, so that is where it points. Save to
/// Files exports a COPY (`asCopy: true`): the received file stays where the
/// Device Inbox put it.
struct ReceivedFileSheetAnchor: UIViewRepresentable {
    /// This row's request, or nil. A request for another row is not passed in.
    let request: InboxReceivedFileRequest?
    let onFinish: (UUID) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onFinish = onFinish
        if let request {
            if coordinator.presentedID != request.id {
                // After this update pass: presenting from inside one is not
                // something UIKit promises to accept.
                DispatchQueue.main.async { coordinator.present(request, from: view) }
            }
        } else if coordinator.presentedID != nil {
            coordinator.dismissPresented()
        }
    }

    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) {
        coordinator.dismissPresented()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource,
                             QLPreviewControllerDelegate, UIDocumentPickerDelegate {
        var onFinish: ((UUID) -> Void)?
        private(set) var presentedID: UUID?
        private weak var presented: UIViewController?
        private var previewURLs: [URL] = []

        func present(_ request: InboxReceivedFileRequest, from anchor: UIView) {
            guard presentedID != request.id else { return }
            guard var host = anchor.window?.rootViewController else {
                // Not on screen any more: nothing to anchor to, so the request
                // ends here rather than waiting for a view that is gone.
                onFinish?(request.id)
                return
            }
            while let next = host.presentedViewController, !next.isBeingDismissed {
                host = next
            }
            dismissPresented()
            let controller: UIViewController
            switch request.action {
            case .open:
                previewURLs = request.urls
                let preview = QLPreviewController()
                preview.dataSource = self
                preview.delegate = self
                controller = preview
            case .share:
                let share = UIActivityViewController(activityItems: request.urls,
                                                     applicationActivities: nil)
                share.completionWithItemsHandler = { [weak self] _, _, _, _ in
                    self?.finished(request.id)
                }
                controller = share
            case .export:
                let picker = UIDocumentPickerViewController(forExporting: request.urls,
                                                            asCopy: true)
                picker.delegate = self
                controller = picker
            }
            if let popover = controller.popoverPresentationController {
                popover.sourceView = anchor
                popover.sourceRect = anchor.bounds
            }
            presentedID = request.id
            presented = controller
            host.present(controller, animated: true)
        }

        /// Withdraw whatever is on screen. Called when the request is dropped.
        func dismissPresented() {
            let controller = presented
            presentedID = nil
            presented = nil
            if let controller, controller.presentingViewController != nil,
               !controller.isBeingDismissed {
                controller.dismiss(animated: true)
            }
        }

        private func finished(_ id: UUID) {
            guard presentedID == id else { return }
            presentedID = nil
            presented = nil
            onFinish?(id)
        }

        // MARK: QuickLook

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
            previewURLs.count
        }

        func previewController(_ controller: QLPreviewController,
                               previewItemAt index: Int) -> QLPreviewItem {
            // Bounds-checked: a preview being dismissed can still ask.
            (previewURLs.indices.contains(index) ? previewURLs[index]
                : URL(fileURLWithPath: "/dev/null")) as NSURL
        }

        func previewControllerDidDismiss(_ controller: QLPreviewController) {
            if let id = presentedID { finished(id) }
        }

        // MARK: Save to Files

        func documentPicker(_ controller: UIDocumentPickerViewController,
                            didPickDocumentsAt urls: [URL]) {
            if let id = presentedID { finished(id) }
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            if let id = presentedID { finished(id) }
        }
    }
}
