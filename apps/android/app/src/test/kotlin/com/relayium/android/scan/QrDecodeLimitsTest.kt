package com.relayium.android.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * How small a code can get, and what happens when a frame holds several.
 *
 * Both are properties of the shipped decoder, measured rather than assumed, and
 * both are the kind of thing that is otherwise rediscovered against a camera at
 * the worst possible moment. Neither is a claim about any particular acceptance
 * image: what a specific delivered frame did is settled by the capture and the
 * offline decode of that frame, not by anything synthesised here.
 *
 * The reason to have them is [PairingQrCard]: it draws a code for another
 * device to read, and the numbers below are what say whether the size it draws
 * at can survive being photographed at a distance and downscaled by the reader's
 * pipeline.
 */
class QrDecodeLimitsTest {

    private val link = "https://relayium.com/cross-network#c=042913"

    /** The same code laid out on a light field, as a photographed page is. */
    private fun page(columns: Int, rows: Int, scale: Int, gap: Int): LuminanceFrame {
        val matrix = QrCodec.encode(link)!!
        val tile = matrix.size * scale
        val width = columns * tile + (columns + 1) * gap
        val height = rows * tile + (rows + 1) * gap
        val bytes = ByteArray(width * height) { FIELD }
        for (row in 0 until rows) {
            for (column in 0 until columns) {
                val originX = gap + column * (tile + gap)
                val originY = gap + row * (tile + gap)
                for (y in 0 until tile) {
                    for (x in 0 until tile) {
                        val dark = matrix.isDark(x / scale, y / scale)
                        bytes[(originY + y) * width + originX + x] = if (dark) 0 else 0xFF.toByte()
                    }
                }
            }
        }
        return LuminanceFrame.of(bytes, width, 1, 0, 0, width, height, 0)!!
    }

    /**
     * The frame as a pipeline would deliver it: box-filtered down to
     * [targetWidth].
     *
     * Averaging rather than dropping pixels, because that is what a scaler
     * does and it is the part that matters — a module smaller than a pixel does
     * not vanish, it turns grey, and grey is what a binarizer has to make a
     * decision about.
     */
    private fun downscaled(frame: LuminanceFrame, targetWidth: Int): LuminanceFrame {
        val factor = frame.width.toDouble() / targetWidth
        val targetHeight = (frame.height / factor).toInt()
        val out = ByteArray(targetWidth * targetHeight)
        for (y in 0 until targetHeight) {
            for (x in 0 until targetWidth) {
                val fromX = (x * factor).toInt()
                val toX = maxOf(minOf(((x + 1) * factor).toInt(), frame.width), fromX + 1)
                val fromY = (y * factor).toInt()
                val toY = maxOf(minOf(((y + 1) * factor).toInt(), frame.height), fromY + 1)
                var total = 0
                var count = 0
                for (sy in fromY until toY) {
                    for (sx in fromX until toX) {
                        total += frame.bytes[sy * frame.width + sx].toInt() and 0xFF
                        count++
                    }
                }
                out[y * targetWidth + x] = (total / maxOf(count, 1)).toByte()
            }
        }
        return LuminanceFrame.of(out, targetWidth, 1, 0, 0, targetWidth, targetHeight, 0)!!
    }

    @Test
    fun `several complete codes in one frame are not inherently undecodable`() {
        // Worth pinning because the opposite is the intuitive guess: a
        // single-code reader given eight symbols might be expected to fail
        // outright. It does not. Whether a particular frame full of codes
        // decodes depends on that frame, so a failure is never explained by
        // the count alone.
        assertEquals(link, QrCodec.decode(page(columns = 2, rows = 1, scale = 3, gap = 24)))
        assertEquals(link, QrCodec.decode(page(columns = 2, rows = 4, scale = 3, gap = 24)))
    }

    @Test
    fun `the module floor is about two pixels, measured rather than assumed`() {
        // Below this a code is not "hard to read", it is gone. Anything that
        // renders a code for a camera — the pairing card, an acceptance image
        // — has to clear it with room to spare, or it works and fails by luck.
        val matrix = QrCodec.encode(link)!!
        val readable = (1..4).filter { scale ->
            matrix.toLuminance(scale)?.let { QrCodec.decode(it) == link } == true
        }
        assertTrue("nothing decoded at any module size", readable.isNotEmpty())
        assertTrue("expected a floor at or below two pixels per module, readable at $readable", readable.min() <= 2)
        assertNotNull("and comfortably readable at four", QrCodec.decode(matrix.toLuminance(4)!!))
    }

    @Test
    fun `a code too small to survive downscaling is not recoverable afterwards`() {
        // The same symbol, delivered at two different sizes. This is why the
        // size a code is DRAWN at is a functional decision and not a visual
        // one: no amount of decoder effort recovers modules that were averaged
        // away before the decoder saw them.
        val small = page(columns = 2, rows = 4, scale = 3, gap = 24)
        assertEquals("readable at full size", link, QrCodec.decode(small))
        assertNull("and gone once scaled to a frame width", QrCodec.decode(downscaled(small, 480)))

        val large = page(columns = 1, rows = 1, scale = 12, gap = 40)
        assertEquals("a large symbol survives the same delivery", link, QrCodec.decode(downscaled(large, 480)))
    }
}

/** The page behind the codes: light, but not paper-white. */
private const val FIELD: Byte = 0xEA.toByte()
