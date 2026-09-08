package com.relayium.android.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The geometry a camera actually hands over.
 *
 * Row padding, a pixel stride above one, an analysis crop and a rotation are
 * all ordinary — and every one of them, read wrong, produces a viewfinder that
 * looks alive and never decodes anything. That failure is invisible on a
 * device: there is nothing to see except a code that "does not work".
 */
class LuminanceFrameTest {

    /** A 3x2 image, laid out with [rowStride] bytes per row and [pixelStride]
     *  bytes per pixel, with padding bytes set to a value that must never
     *  appear in the packed output. */
    private fun padded(rowStride: Int, pixelStride: Int, width: Int = 3, height: Int = 2): ByteArray {
        val plane = ByteArray(rowStride * height) { PADDING }
        var value = 1
        for (y in 0 until height) {
            for (x in 0 until width) {
                plane[y * rowStride + x * pixelStride] = value.toByte()
                value++
            }
        }
        return plane
    }

    private fun bytesOf(frame: LuminanceFrame?): List<Int> {
        assertNotNull(frame)
        return frame!!.bytes.map { it.toInt() and 0xFF }
    }

    @Test
    fun `a tightly packed frame is copied as it is`() {
        val frame = LuminanceFrame.of(padded(3, 1), 3, 1, 0, 0, 3, 2, 0)
        assertEquals(listOf(1, 2, 3, 4, 5, 6), bytesOf(frame))
        assertEquals(3, frame!!.width)
        assertEquals(2, frame.height)
    }

    @Test
    fun `row padding is dropped rather than read as image data`() {
        // The usual hardware layout: rows aligned to a larger stride. Read
        // as-is, the padding becomes bright or dark columns straight through
        // the middle of the code.
        val frame = LuminanceFrame.of(padded(8, 1), 8, 1, 0, 0, 3, 2, 0)
        assertEquals(listOf(1, 2, 3, 4, 5, 6), bytesOf(frame))
    }

    @Test
    fun `a pixel stride above one is honoured`() {
        val frame = LuminanceFrame.of(padded(16, 2), 16, 2, 0, 0, 3, 2, 0)
        assertEquals(listOf(1, 2, 3, 4, 5, 6), bytesOf(frame))
    }

    @Test
    fun `a crop reads the requested rectangle and nothing around it`() {
        // 4x4 counting up from 1, cropped to the middle 2x2 -> 6,7 / 10,11.
        val plane = ByteArray(4 * 4) { (it + 1).toByte() }
        val frame = LuminanceFrame.of(plane, 4, 1, 1, 1, 2, 2, 0)
        assertEquals(listOf(6, 7, 10, 11), bytesOf(frame))
        assertEquals(2, frame!!.width)
    }

    @Test
    fun `a crop combines with padding and stride`() {
        val plane = ByteArray(20 * 4) { PADDING }
        var value = 1
        for (y in 0 until 4) for (x in 0 until 4) plane[y * 20 + x * 2] = (value++).toByte()
        val frame = LuminanceFrame.of(plane, 20, 2, 1, 1, 2, 2, 0)
        assertEquals(listOf(6, 7, 10, 11), bytesOf(frame))
    }

    @Test
    fun `rotation by ninety degrees turns the image clockwise`() {
        // 1 2 3      4 1
        // 4 5 6  ->  5 2
        //            6 3
        val frame = LuminanceFrame.of(padded(3, 1), 3, 1, 0, 0, 3, 2, 90)
        assertEquals(2, frame!!.width)
        assertEquals(3, frame.height)
        assertEquals(listOf(4, 1, 5, 2, 6, 3), bytesOf(frame))
    }

    @Test
    fun `rotation by one hundred and eighty degrees reverses the image`() {
        val frame = LuminanceFrame.of(padded(3, 1), 3, 1, 0, 0, 3, 2, 180)
        assertEquals(3, frame!!.width)
        assertEquals(2, frame.height)
        assertEquals(listOf(6, 5, 4, 3, 2, 1), bytesOf(frame))
    }

    @Test
    fun `rotation by two hundred and seventy degrees turns the image the other way`() {
        // 1 2 3      3 6
        // 4 5 6  ->  2 5
        //            1 4
        val frame = LuminanceFrame.of(padded(3, 1), 3, 1, 0, 0, 3, 2, 270)
        assertEquals(2, frame!!.width)
        assertEquals(3, frame.height)
        assertEquals(listOf(3, 6, 2, 5, 1, 4), bytesOf(frame))
    }

    @Test
    fun `four rotations return the image to where it started`() {
        var bytes = padded(3, 1)
        var width = 3
        var height = 2
        repeat(4) {
            val frame = LuminanceFrame.of(bytes, width, 1, 0, 0, width, height, 90)!!
            bytes = frame.bytes
            width = frame.width
            height = frame.height
        }
        assertEquals(listOf(1, 2, 3, 4, 5, 6), bytes.map { it.toInt() and 0xFF })
        assertEquals(3, width)
    }

    @Test
    fun `a rotation this does not know is refused rather than guessed`() {
        for (degrees in listOf(-90, 45, 89, 360, 1, Int.MAX_VALUE)) {
            assertNull("$degrees", LuminanceFrame.of(padded(3, 1), 3, 1, 0, 0, 3, 2, degrees))
        }
    }

    @Test
    fun `a plane shorter than its own geometry is refused before it is read`() {
        // The shape a broken or hostile producer sends. Discovering it per
        // pixel would be an exception on the camera thread.
        val short = ByteArray(5)
        assertNull(LuminanceFrame.of(short, 3, 1, 0, 0, 3, 2, 0))
        // Exactly long enough is fine.
        assertNotNull(LuminanceFrame.of(ByteArray(6), 3, 1, 0, 0, 3, 2, 0))
        // A crop that runs off the end of a real buffer.
        assertNull(LuminanceFrame.of(ByteArray(16), 4, 1, 2, 2, 4, 4, 0))
    }

    @Test
    fun `impossible geometry is refused`() {
        val plane = ByteArray(64)
        assertNull("zero row stride", LuminanceFrame.of(plane, 0, 1, 0, 0, 3, 2, 0))
        assertNull("zero pixel stride", LuminanceFrame.of(plane, 8, 0, 0, 0, 3, 2, 0))
        assertNull("negative crop", LuminanceFrame.of(plane, 8, 1, -1, 0, 3, 2, 0))
        assertNull("negative crop top", LuminanceFrame.of(plane, 8, 1, 0, -1, 3, 2, 0))
        assertNull("empty crop", LuminanceFrame.of(plane, 8, 1, 0, 0, 0, 2, 0))
        assertNull("empty crop height", LuminanceFrame.of(plane, 8, 1, 0, 0, 3, 0, 0))
    }

    @Test
    fun `a crop origin near the integer ceiling cannot wrap past the length check`() {
        // Widening the SUM instead of the operands is the bug: `Int.MAX_VALUE +
        // 2 - 1` wraps to a large negative, which passes a `>= plane.size`
        // test and then indexes the array negatively — an exception on the
        // camera thread, reachable from a header that simply lies.
        val plane = ByteArray(4096)
        for (origin in listOf(Int.MAX_VALUE, Int.MAX_VALUE - 1, Int.MAX_VALUE / 2)) {
            assertNull("left $origin", LuminanceFrame.of(plane, 64, 1, origin, 0, 2, 2, 0))
            assertNull("top $origin", LuminanceFrame.of(plane, 64, 1, 0, origin, 2, 2, 0))
        }
        // And with a large stride, where the multiplication is what overflows.
        assertNull(LuminanceFrame.of(plane, Int.MAX_VALUE, 1, 0, 2, 2, 2, 0))
        assertNull(LuminanceFrame.of(plane, 64, Int.MAX_VALUE, 0, 0, 2, 2, 0))
    }

    @Test
    fun `a crop whose columns run past the row stride is refused, not sheared`() {
        // The selected columns have to lie inside ONE row. A crop reaching past
        // the stride reads padding, or the next row's first pixels, and
        // produces a plausible-looking picture of the wrong thing.
        val plane = ByteArray(8 * 8)
        // Row is 8 bytes: columns 0..7 at stride 1 are fine, 0..8 are not.
        assertNotNull(LuminanceFrame.of(plane, 8, 1, 0, 0, 8, 2, 0))
        assertNull(LuminanceFrame.of(plane, 8, 1, 0, 0, 9, 2, 0))
        assertNull(LuminanceFrame.of(plane, 8, 1, 2, 0, 7, 2, 0))
        // At pixel stride 2 a row of 8 bytes holds four pixels, not eight.
        assertNotNull(LuminanceFrame.of(plane, 8, 2, 0, 0, 4, 2, 0))
        assertNull(LuminanceFrame.of(plane, 8, 2, 0, 0, 5, 2, 0))
    }

    @Test
    fun `an absurdly large frame is refused rather than normalised`() {
        // Bounds the WORK: normalising is a per-pixel copy on a frame-rate
        // path, and a buffer's own header is not a reason to spend an arbitrary
        // amount of time on one frame.
        val plane = ByteArray(64)
        assertNull(LuminanceFrame.of(plane, 8, 1, 0, 0, LuminanceFrame.MAX_SIDE + 1, 2, 0))
        assertNull(LuminanceFrame.of(plane, 8, 1, 0, 0, 2, LuminanceFrame.MAX_SIDE + 1, 0))
        assertNull(LuminanceFrame.of(plane, 8, 1, 0, 0, LuminanceFrame.MAX_SIDE, LuminanceFrame.MAX_SIDE, 0))
    }

    @Test
    fun `a padded rotated crop of a real QR code still decodes`() {
        // Everything at once, against the real decoder: the layout a camera
        // hands over and the code a person is holding.
        val matrix = QrCodec.encode("https://relayium.com/cross-network#c=042913")!!
        val scale = 4
        val side = matrix.size * scale
        val margin = 6
        val stride = (side + margin) * 2
        val plane = ByteArray(stride * (side + margin)) { PADDING }
        for (y in 0 until side) {
            for (x in 0 until side) {
                val dark = matrix.isDark(x / scale, y / scale)
                plane[(y + margin) * stride + (x + margin) * 2] = if (dark) 0 else 0xFF.toByte()
            }
        }
        for (rotation in listOf(0, 90, 180, 270)) {
            val frame = LuminanceFrame.of(plane, stride, 2, margin, margin, side, side, rotation)
            assertNotNull("no frame at $rotation", frame)
            assertEquals(
                "rotation $rotation",
                "https://relayium.com/cross-network#c=042913",
                QrCodec.decode(frame!!),
            )
        }
    }

    /** A value the packed output must never contain: it only exists in the
     *  gaps between rows and pixels. */
    private val PADDING = 0xEE.toByte()
}
