import SwiftUI
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
