package com.relayium.android

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A32 D3: the launch intent is routed exactly once, and never from Recents. */
class LaunchIntentRoutingTest {

    @Test
    fun `a genuine first launch routes its intent`() {
        assertTrue(MainActivity.routesLaunchIntent(restored = false, flags = Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @Test
    fun `a relaunch from Recents does not replay the base intent`() {
        // The exact flags the emulator reported: NEW_TASK | LAUNCHED_FROM_HISTORY.
        assertFalse(MainActivity.routesLaunchIntent(restored = false, flags = 0x10100000))
    }

    @Test
    fun `a recreation does not replay it either`() {
        assertFalse(MainActivity.routesLaunchIntent(restored = true, flags = 0))
    }
}
