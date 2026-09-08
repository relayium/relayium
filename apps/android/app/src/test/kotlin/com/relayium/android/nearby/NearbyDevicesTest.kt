package com.relayium.android.nearby

import com.relayium.protocol.Envelope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The projection the user actually reads. Every rule here is a way the wrong
 *  device gets picked. */
class NearbyDevicesTest {

    private fun peers(vararg pairs: Pair<String, String>) =
        pairs.map { Envelope.Peer(it.first, it.second) }

    @Test
    fun `nothing is listed until this device knows which entry is its own`() {
        assertEquals(
            emptyList<NearbyDevice>(),
            nearbyDevices(peers("a" to "One", "b" to "Two"), selfId = ""),
        )
    }

    @Test
    fun `this device is excluded from its own list`() {
        val devices = nearbyDevices(peers("me" to "Mine", "b" to "Other"), selfId = "me")
        assertEquals(listOf("b"), devices.map { it.id })
    }

    @Test
    fun `the list is sorted, so it does not reshuffle between two roster frames`() {
        val one = nearbyDevices(peers("me" to "M", "c" to "Zeta", "a" to "Alpha", "b" to "Mid"), "me")
        val two = nearbyDevices(peers("me" to "M", "a" to "Alpha", "b" to "Mid", "c" to "Zeta"), "me")
        assertEquals(listOf("Alpha", "Mid", "Zeta"), one.map { it.name })
        assertEquals(one, two)
    }

    @Test
    fun `two devices with the same name are marked for disambiguation`() {
        val devices = nearbyDevices(
            peers("me" to "M", "aaaaaa111111" to "Pixel 9", "bbbbbb222222" to "Pixel 9", "c" to "iPhone"),
            selfId = "me",
        )
        assertEquals(listOf(true, true, false), devices.map { it.ambiguous })
        assertEquals("111111", shortPeerId("aaaaaa111111"))
    }

    @Test
    fun `a device that gave no usable name is listed with an empty name, not an invented one`() {
        val devices = nearbyDevices(peers("me" to "M", "b" to "   "), selfId = "me")
        assertEquals("", devices.single().name)
    }

    /** Peer-supplied text rendered in this app's UI gets the same treatment an
     *  incoming file name gets: a right-to-left override would let one device
     *  dress its row up as another. */
    @Test
    fun `a name carrying bidi or control characters is sanitised`() {
        val hostile = "safe‮" + "gnp.exe"
        val devices = nearbyDevices(peers("me" to "M", "b" to hostile), selfId = "me")
        assertFalse(devices.single().name.contains('‮'))
        assertEquals("safegnp.exe", devices.single().name)
    }

    @Test
    fun `a duplicated roster entry is listed once`() {
        val devices = nearbyDevices(
            peers("me" to "M", "b" to "One", "b" to "One again"), selfId = "me",
        )
        assertEquals(1, devices.size)
        assertEquals("the first entry wins", "One", devices.single().name)
    }

    @Test
    fun `announcements are read per peer and are never this build's own list`() {
        val devices = nearbyDevices(
            peers("me" to "M", "a" to "Alpha", "b" to "Bravo"),
            selfId = "me",
            supportsLink = { it == "a" },
            announcesText = { it == "b" },
        )
        assertTrue(devices.first { it.id == "a" }.supportsLink)
        assertFalse(devices.first { it.id == "a" }.announcesText)
        assertFalse(devices.first { it.id == "b" }.supportsLink)
        assertTrue(devices.first { it.id == "b" }.announcesText)
    }

    @Test
    fun `an empty peer id is not a device`() {
        assertEquals(
            emptyList<String>(),
            nearbyDevices(peers("me" to "M", "" to "Ghost"), "me").map { it.id },
        )
    }
}
