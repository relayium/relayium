package com.relayium.android.scan

import com.relayium.android.ingress.IngressRequest
import com.relayium.android.ingress.ScanPolicy
import com.relayium.protocol.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Real ZXing, both directions.
 *
 * Nothing here stubs the codec. `zxing:core` is pure Java, so the decoder that
 * runs on the camera thread is the decoder under test, and a round trip through
 * it is evidence about the shipped path rather than about a fake.
 *
 * What a camera adds on top of this is optics and geometry —
 * [LuminanceFrameTest] covers the geometry, and the frame path itself is an
 * instrumentation case against an emulator fed a real image.
 */
class QrCodecTest {

    private val origin = "https://relayium.com"

    private fun scan(text: String, scale: Int = 4): String? {
        val matrix = QrCodec.encode(text)
        assertNotNull("encode produced nothing for $text", matrix)
        val frame = matrix!!.toLuminance(scale)
        assertNotNull("no frame", frame)
        return QrCodec.decode(frame!!)
    }

    @Test
    fun `a join link survives the round trip byte for byte`() {
        val link = "$origin/cross-network#c=042913"
        assertEquals(link, scan(link))
    }

    @Test
    fun `a decoded join link is accepted by the same policy a tapped link crosses`() {
        // The property that matters is not "ZXing works" — it is that what
        // comes out of a real QR code is what the app's own link policy
        // accepts, with no second parser in between.
        val link = PairingQr.payload(origin, PairCode("042913"), expiresAt = 0, now = 0)
        assertNotNull(link)
        val decoded = scan(link!!)
        assertEquals(link, decoded)
        val request = ScanPolicy.result(decoded!!, origin)
        assertNotNull("the app cannot read its own QR code", request)
        assertEquals("042913", request!!.code.digits)
        assertNull(request.modeHint)
    }

    @Test
    fun `leading zeros survive the round trip`() {
        val link = PairingQr.payload(origin, PairCode("000000"), 0, 0)!!
        assertEquals("000000", ScanPolicy.result(scan(link)!!, origin)!!.code.digits)
    }

    @Test
    fun `an Apple link with a lane hint round trips with its hint`() {
        // Not produced by this app, but scanned from an Apple screen.
        val link = "$origin/cross-network?mode=text#c=042913"
        val request = ScanPolicy.result(scan(link)!!, origin)
        assertNotNull(request)
        assertEquals(com.relayium.android.ingress.IngressTransferMode.TEXT, request!!.modeHint)
    }

    @Test
    fun `a foreign link decodes and is then refused`() {
        // The decoder's job is to read the square; refusing is the policy's.
        // Both halves are asserted here because a scanner that refused at the
        // wrong layer would be one that could be widened by a decoder change.
        val hostile = "https://evil.example/cross-network#c=042913"
        assertEquals(hostile, scan(hostile))
        assertNull(ScanPolicy.result(hostile, origin))
    }

    @Test
    fun `a wall of text in a QR code is refused by the payload bound`() {
        // A QR code can carry a few kilobytes; the policy bound is 512 UTF-8
        // bytes, applied before parsing.
        val long = "$origin/cross-network?pad=" + "0".repeat(600) + "#c=042913"
        assertNull(ScanPolicy.result(long, origin))
    }

    @Test
    fun `a QR code holding something that is not a link is nothing`() {
        for (payload in listOf("hello", "042913", "tel:+15551234", "{\"code\":\"042913\"}")) {
            assertEquals(payload, scan(payload))
            assertNull(payload, ScanPolicy.result(payload, origin))
        }
    }

    @Test
    fun `a frame with no code in it decodes to nothing`() {
        val blank = LuminanceFrame.of(
            plane = ByteArray(200 * 200) { 0xFF.toByte() },
            rowStride = 200, pixelStride = 1,
            cropLeft = 0, cropTop = 0, cropWidth = 200, cropHeight = 200,
            rotationDegrees = 0,
        )
        assertNull(QrCodec.decode(blank!!))
    }

    @Test
    fun `noise never decodes and never throws`() {
        // The camera thread must survive whatever it is pointed at. A
        // deterministic pattern rather than a random one, so a failure here is
        // reproducible.
        val side = 128
        val bytes = ByteArray(side * side) { i -> ((i * 37 + (i shr 5) * 11) and 0xFF).toByte() }
        val frame = LuminanceFrame.of(bytes, side, 1, 0, 0, side, side, 0)!!
        assertNull(QrCodec.decode(frame))
    }

    @Test
    fun `a damaged QR code still decodes, and a destroyed one does not`() {
        val link = "$origin/cross-network#c=042913"
        val matrix = QrCodec.encode(link)!!
        val scale = 4
        val side = matrix.size * scale
        // Error correction level M tolerates a modest occlusion. Blank out a
        // small square away from the finder patterns.
        val damaged = ByteArray(side * side) { i ->
            val x = i % side
            val y = i / side
            val hidden = x in (side / 2)..(side / 2 + scale * 2) && y in (side / 2)..(side / 2 + scale * 2)
            if (hidden) 0xFF.toByte() else if (matrix.isDark(x / scale, y / scale)) 0 else 0xFF.toByte()
        }
        val stillReadable = QrCodec.decode(LuminanceFrame.of(damaged, side, 1, 0, 0, side, side, 0)!!)
        assertEquals(link, stillReadable)

        // A finder pattern destroyed is not a QR code any more.
        val wrecked = ByteArray(side * side) { i ->
            val x = i % side
            val y = i / side
            if (x < side / 2 && y < side / 2) 0xFF.toByte()
            else if (matrix.isDark(x / scale, y / scale)) 0 else 0xFF.toByte()
        }
        assertNull(QrCodec.decode(LuminanceFrame.of(wrecked, side, 1, 0, 0, side, side, 0)!!))
    }

    @Test
    fun `the encoder refuses content it cannot represent`() {
        assertNull(QrCodec.encode(""))
        // Far past what any QR version holds.
        assertNull(QrCodec.encode("x".repeat(10_000)))
    }

    @Test
    fun `an encoded code carries the quiet zone a scanner needs to find it`() {
        val matrix = QrCodec.encode("$origin/cross-network#c=042913")!!
        for (i in 0 until QrCodec.QUIET_ZONE) {
            assertTrue("row $i is not quiet", (0 until matrix.size).none { matrix.isDark(it, i) })
            assertTrue("column $i is not quiet", (0 until matrix.size).none { matrix.isDark(i, it) })
        }
    }

    @Test
    fun `the matrix reads false outside its own bounds rather than throwing`() {
        val matrix = QrCodec.encode("x")!!
        assertTrue(!matrix.isDark(-1, 0))
        assertTrue(!matrix.isDark(0, -1))
        assertTrue(!matrix.isDark(matrix.size, 0))
        assertTrue(!matrix.isDark(0, matrix.size))
    }

    @Test
    fun `a scan result can only ever be a prefill`() {
        val request: IngressRequest.PrefillCode? =
            ScanPolicy.result(scan("$origin/cross-network#c=042913")!!, origin)
        assertNotNull(request)
        // The static type is the assertion: there is no case in this return
        // type that could start a connection.
        assertEquals(com.relayium.android.ingress.IngressSurface.JOIN, request!!.surface)
    }
}
