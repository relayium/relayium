package com.relayium.android.scan

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * The QR code itself: bytes to text, and text to a grid of squares.
 *
 * ZXing's `core` module does both, and it is pure Java — no native library, no
 * downloaded model, no Play Services. That is a distribution decision (this app
 * installs without GMS) and a testing one: the same decoder that runs on the
 * camera thread runs in a host unit test, so "a real QR code decodes" and "a
 * hostile payload does not crash the analyzer" are ordinary tests.
 */
object QrCodec {

    /**
     * Read a QR code out of one frame, or null.
     *
     * **QR only.** [QRCodeReader] is the QR decoder rather than
     * `MultiFormatReader`, and the format hint says so a second time. A scanner
     * that also read Code 128 and Data Matrix would be accepting whole
     * additional payload grammars from a printed sticker, for a feature nobody
     * asked for.
     *
     * **`TRY_HARDER` is on.** This runs on a handheld camera, where the code is
     * at an angle, half-lit and slightly out of focus; the cost is CPU on one
     * frame and the benefit is the scan finishing at all.
     *
     * **No character-set hint.** ZXing follows the code's own ECI declaration,
     * defaulting to ISO-8859-1 — forcing UTF-8 here would REINTERPRET bytes the
     * producer labelled otherwise, which is a way to turn one payload into a
     * different string. What this app accepts is an ASCII URL either way, and
     * [com.relayium.android.ingress.ScanPolicy] is what decides.
     */
    fun decode(frame: LuminanceFrame): String? {
        val source = PlanarYUVLuminanceSource(
            frame.bytes,
            frame.width,
            frame.height,
            0,
            0,
            frame.width,
            frame.height,
            // Do NOT invert on failure: a second full decode attempt per frame
            // doubles the work on the frame-rate path, and a QR code printed in
            // reverse video is not a case this product needs.
            false,
        )
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        return try {
            QRCodeReader().decode(bitmap, DECODE_HINTS).text
        } catch (_: ReaderException) {
            // Not found, checksum failed, format wrong. All of them mean the
            // same thing to a viewfinder: keep looking.
            null
        } catch (_: RuntimeException) {
            // ZXing is being handed adversarial pixels at frame rate. Its
            // failure modes on malformed input are not exhaustively specified,
            // and an unexpected throw here would take down the camera thread —
            // a crash anybody could cause by printing the right square.
            null
        }
    }

    /**
     * Render [text] as a QR grid, or null if it cannot be rendered.
     *
     * Returns a matrix rather than a bitmap: the drawing belongs to the
     * composable, and a pure grid is comparable in a test — which is what makes
     * the encode/decode round trip through real ZXing assertable on a host.
     *
     * Error correction is M, the level the web QR uses for the same link, which
     * keeps a printed or photographed code readable with a modest amount of the
     * square obscured without inflating it.
     */
    fun encode(text: String, margin: Int = QUIET_ZONE): QrMatrix? {
        if (text.isEmpty()) return null
        return try {
            val hints = mapOf(
                EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
                EncodeHintType.MARGIN to margin,
                // A join link is ASCII; saying so keeps the encoder from
                // emitting an ECI header that a stricter reader might refuse.
                EncodeHintType.CHARACTER_SET to "ISO-8859-1",
            )
            // Size 1 asks the writer for the smallest matrix that fits, rather
            // than scaling here: scaling is the renderer's job, and a matrix
            // scaled by a non-integer factor is a QR code with ragged modules.
            val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 1, 1, hints)
            val size = matrix.width
            if (size <= 0 || matrix.height != size) return null
            val bits = BooleanArray(size * size)
            for (y in 0 until size) {
                for (x in 0 until size) bits[y * size + x] = matrix.get(x, y)
            }
            QrMatrix(size, bits)
        } catch (_: Exception) {
            // `WriterException` for content that will not fit, and
            // `IllegalArgumentException` from the encoder's own validation.
            // Either way there is no code to show, which the caller renders as
            // the absence of one rather than as a broken image.
            null
        }
    }

    /** The white border a scanner needs to find the code's edges. Four modules
     *  is the QR specification's own quiet zone. */
    const val QUIET_ZONE = 4

    private val DECODE_HINTS = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
    )
}

/**
 * A square grid of dark and light modules.
 *
 * Immutable and framework-free: the composable reads it to draw rectangles, and
 * a test reads it to assert what was encoded.
 */
class QrMatrix internal constructor(val size: Int, private val bits: BooleanArray) {

    fun isDark(x: Int, y: Int): Boolean {
        if (x < 0 || y < 0 || x >= size || y >= size) return false
        return bits[y * size + x]
    }

    /**
     * The grid as a luminance frame, exactly as a camera pointed at it would
     * see it: dark modules black, light modules white, one byte per module.
     *
     * This exists so the round trip is testable without a camera or an image
     * decoder — it is the honest inverse of [QrCodec.encode], and a test that
     * uses it is testing real encoding and real decoding, not a stub.
     * [scale] repeats each module, because a decoder needs more than one pixel
     * per module to find the timing pattern.
     */
    fun toLuminance(scale: Int = 4): LuminanceFrame? {
        if (scale <= 0) return null
        val side = size * scale
        val bytes = ByteArray(side * side)
        for (y in 0 until side) {
            for (x in 0 until side) {
                bytes[y * side + x] = if (isDark(x / scale, y / scale)) 0x00 else 0xFF.toByte()
            }
        }
        return LuminanceFrame.of(
            plane = bytes,
            rowStride = side,
            pixelStride = 1,
            cropLeft = 0,
            cropTop = 0,
            cropWidth = side,
            cropHeight = side,
            rotationDegrees = 0,
        )
    }
}
