import SwiftUI
import AppKit
import CoreImage.CIFilterBuiltins
import RelayiumAppKit

/// A QR code for the join link, rendered by the OS.
///
/// `CIQRCodeGenerator` ships with macOS, so this costs no dependency. The link
/// carries the pairing code in the fragment (`#c=<code>`), the form
/// `web/src/lib/transfer-link.ts` already builds so it never reaches a server
/// log or a Referer header — a phone that scans it lands in the web app and
/// joins the room, with no native app and no Universal Links involved.
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
                .lineLimit(1)
                .truncationMode(.middle)
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
    }
}

/// The complete handoff stays above the fold at the app's minimum window size:
/// scan on the left; inspect/copy/share, current status and Cancel on the right.
/// File and text pairing use this exact component so one cannot quietly lose an
/// affordance the other has.
struct PairingCodeHandoffView: View {
    let url: URL
    let cancel: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                QRCodeView(url: url.absoluteString, side: 144)
                Text(L10n.t(.directScanOnPhone))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(width: 160, alignment: .leading)

            VStack(alignment: .leading, spacing: 12) {
                PairingJoinLinkView(url: url)
                ProgressView(L10n.t(.directWaitingForDevice))
                    .controlSize(.small)
                Button(L10n.t(.commonCancel), action: cancel)
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
