package com.relayium.android.integration

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one foreground answer both presence claims read.
 *
 * The cases are the three things that produce `ON_STOP` — an owned picker, a
 * recreation, and the user actually leaving — plus the platform hole that has
 * no lifecycle event at all: Home pressed from inside `DocumentsUI`.
 */
class HostPresenceTest {

    @Test
    fun `starting is foreground`() {
        val presence = HostPresence()
        assertFalse(presence.isForeground)
        assertTrue(presence.onStart())
    }

    @Test
    fun `leaving the app ends the claims`() {
        val presence = HostPresence()
        presence.onStart()
        assertFalse(presence.onStop(changingConfigurations = false, ownedPickerOutstanding = false))
    }

    @Test
    fun `an owned picker in front is not leaving`() {
        val presence = HostPresence()
        presence.onStart()
        assertTrue(presence.onStop(changingConfigurations = false, ownedPickerOutstanding = true))
    }

    @Test
    fun `a configuration recreation is not leaving`() {
        val presence = HostPresence()
        presence.onStart()
        assertTrue(presence.onStop(changingConfigurations = true, ownedPickerOutstanding = false))
        // …and the Activity coming straight back leaves it foreground.
        assertTrue(presence.onStart())
    }

    @Test
    fun `Home pressed inside the picker ends the claims when the lease expires`() {
        val presence = HostPresence()
        presence.onStart()
        // The picker came to the front: still foreground, and this is the ONLY
        // stop event Android will deliver for this journey.
        assertTrue(presence.onStop(changingConfigurations = false, ownedPickerOutstanding = true))
        // The user pressed Home from inside DocumentsUI. No second ON_STOP
        // arrives; the lease running out is what says the app is gone.
        assertFalse(presence.onPickerLeaseExpired())
    }

    @Test
    fun `a lease expiring while the user is back on screen keeps the claims`() {
        val presence = HostPresence()
        presence.onStart()
        presence.onStop(changingConfigurations = false, ownedPickerOutstanding = true)
        // They came back — with the pick lost or abandoned, but they are here.
        assertTrue(presence.onStart())
        // Ending Nearby now would be a session destroyed by navigation, which
        // is the exact failure the covered state exists to prevent.
        assertTrue(presence.onPickerLeaseExpired())
    }

    @Test
    fun `returning from the picker clears the covered state`() {
        val presence = HostPresence()
        presence.onStart()
        presence.onStop(changingConfigurations = false, ownedPickerOutstanding = true)
        presence.onStart()
        // A later ordinary stop is now abandonment again: the covered state
        // does not linger past the round trip that produced it.
        assertFalse(presence.onStop(changingConfigurations = false, ownedPickerOutstanding = false))
    }

    @Test
    fun `a second stop while still covered stays covered`() {
        val presence = HostPresence()
        presence.onStart()
        presence.onStop(changingConfigurations = false, ownedPickerOutstanding = true)
        // A stop delivered again for a still-outstanding picker must not be
        // read as the user leaving.
        assertTrue(presence.onStop(changingConfigurations = false, ownedPickerOutstanding = true))
    }

    @Test
    fun `the host being destroyed ends everything`() {
        val presence = HostPresence()
        presence.onStart()
        presence.onStop(changingConfigurations = false, ownedPickerOutstanding = true)
        assertFalse(presence.onDestroyed())
    }
}
