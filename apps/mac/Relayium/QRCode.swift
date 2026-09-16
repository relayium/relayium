import SwiftUI
import AppKit
import CoreImage.CIFilterBuiltins
import RelayiumAppKit

/// A QR code for the join link, rendered by the OS.
///
/// `CIQRCodeGenerator` ships with macOS, so this costs no dependency. The link
/// carries the pairing code in the fragment (`#c=<code>`), the form
/// `web/src/lib/transfer-link.ts` already builds so it never reaches a server
/// log or a Referer header. A phone that scans it can continue in a browser or,
/// when its OS has associated Relayium, hand it to the native app.
struct QRCodeView: View {
    let url: String
    var side: CGFloat = 160

    var body: some View {
        if let image = Self.render(url) {
            Image(nsImage: image)
                .interpolation(.none)          // keep the modules crisp
                .resizable()
                .frame(width: side, height: side)
                .accessibilityLabel(L10n.t(.qrA11yLabel))
        } else {
            // The code itself is the primary affordance; a failed QR is a
            // missing accelerator, not a broken screen.
            Color.clear.frame(width: side, height: side)
        }
    }

    private static func render(_ string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Scale before rasterising: the generator emits roughly one pixel per
        // module, which would be a blur at display size.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

/// The QR code is convenient when the other device has a camera, but it cannot
/// be inspected, copied into a message or used on the same machine. Always show
/// the underlying link as a first-class handoff beside it.
struct PairingJoinLinkView: View {
    let url: URL
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.pairingJoinLink))
                .font(.caption.weight(.semibold))
            Text(url.absoluteString)
                .font(.caption.monospaced())
                // A generated link is the result the sender hands off. Keep
                // every component visible instead of replacing its middle with
                // an ellipsis when the detail pane is narrow.
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            HStack {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url.absoluteString, forType: .string)
                    copied = true
                } label: {
                    Label(L10n.t(.commonCopy), systemImage: "doc.on.doc")
                }
                ShareLink(item: url) {
                    Label(L10n.t(.commonShare), systemImage: "square.and.arrow.up")
                }
                if copied {
                    Label(L10n.t(.pairingLinkCopied), systemImage: "checkmark")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        // SwiftUI may preserve this subtree while the model publishes a later
        // code. Copy feedback belongs to one URL, never the component slot.
        .onChange(of: url) { _ in copied = false }
    }
}

/// The handoff under a live code: the named wait, the way to share it, and
/// Cancel — on one compact line, so the pairing hero stays the reference's size.
///
/// **The QR and the join link are one press away, not gone.** They sit behind
/// an explicitly labelled disclosure that starts collapsed and announces its
/// expanded state; opening it shows the QR, the whole link, Copy and Share
/// exactly as before. Cancel and the wait are never behind it. File and text
/// pairing use this one component so neither can lose an affordance.
struct PairingCodeHandoffView: View {
    let url: URL
    let cancel: () -> Void

    @State private var sharing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 10) {
                ProgressView(L10n.t(.directWaitingForDevice))
                    .controlSize(.small)
                Spacer(minLength: 8)
                Button {
                    sharing.toggle()
                } label: {
                    Label(L10n.t(.pairingShareLinkToggle),
                          systemImage: sharing ? "chevron.up" : "qrcode")
                }
                .buttonStyle(.referenceSecondary)
                .accessibilityLabel(L10n.t(.pairingShareLinkToggle))
                .accessibilityValue(L10n.t(sharing ? .helpExpandedValue : .helpCollapsedValue))
                .accessibilityIdentifier("pairing-share-toggle")
                Button(L10n.t(.commonCancel), action: cancel)
                    .buttonStyle(.referenceSecondary)
            }
            if sharing {
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        QRCodeView(url: url.absoluteString, side: 144)
                        Text(L10n.t(.directScanOnPhone))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(width: 160, alignment: .leading)
                    PairingJoinLinkView(url: url)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("pairing-share-details")
            }
        }
        // A replacement code starts with its sharing folded again.
        .onChange(of: url) { _ in sharing = false }
    }
}
