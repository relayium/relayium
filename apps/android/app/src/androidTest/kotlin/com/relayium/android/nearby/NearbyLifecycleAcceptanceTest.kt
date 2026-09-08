package com.relayium.android.nearby

import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.state
import com.relayium.android.InteropDriver.viewModel
import com.relayium.android.MainActivity
import com.relayium.android.R
import com.relayium.android.TransferController
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What an Activity STOP actually means for a running Nearby session, on the
 * real Activity.
 *
 * This is not a state-machine test with a simulated lifecycle: it drives the
 * shipped `MainActivity` through real `ON_STOP` and real recreation, because the
 * whole question is what the platform does rather than what the model believes.
 *
 * ## Why it exists
 *
 * `ON_STOP` was read as "the user left the app" and it is not. Android's own
 * document picker is a separate Activity, so choosing a file to send — or a
 * folder to receive into — stops this one every time. Ending Nearby there made
 * its file flows impossible to finish: the user taps Send, and the session they
 * were arranging is gone before the picker has even drawn. A locale change is
 * the same shape for a different reason.
 *
 * So the cases are separated here, on the real thing, and a run that "passes" by
 * ending and rejoining is a run that failed — the assertions are on the SAME
 * session identity, not on a session existing again afterwards.
 *
 * The DOCUMENT-PICKER case is not here, and deliberately: the file and folder
 * pickers are reached from a connected session, which needs a second device.
 * It lives in `NearbyLanAcceptanceTest`, driven through the real DocumentsUI by
 * `scripts/android-nearby-acceptance.sh`, where there is a real transfer for the
 * picker to interrupt.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class NearbyLifecycleAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private fun instrumentation() = InstrumentationRegistry.getInstrumentation()

    /** A REAL stop, delivered the way the platform delivers one. */
    private fun stopAndReturn(scenario: ActivityScenario<MainActivity>) {
        scenario.moveToState(Lifecycle.State.CREATED)
        instrumentation().waitForIdleSync()
        scenario.moveToState(Lifecycle.State.RESUMED)
        instrumentation().waitForIdleSync()
    }

    @Test
    fun leavingTheAppStopsNearby() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val vm = viewModel()
            vm.startNearbyDirect()
            awaitTrue("Nearby is running") { state(vm).nearby.active }

            stopAndReturn(scenario)

            awaitTrue("a device that left the foreground stops announcing itself") {
                !state(vm).nearby.active
            }
            assertEquals(
                "and the session is honestly over rather than idling",
                TransferController.Phase.ENDED, state(vm).phase,
            )
        }
    }

    @Test
    fun recreatingTheActivityDoesNotEndNearby() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val vm = viewModel()
            vm.startNearbyDirect()
            awaitTrue("Nearby is running") { state(vm).nearby.active }
            val room = state(vm).nearby.roomId

            scenario.recreate()
            instrumentation().waitForIdleSync()

            assertTrue(
                "a configuration this Activity does not handle rebuilds the UI, " +
                    "not the session",
                state(vm).nearby.active,
            )
            assertEquals(room, state(vm).nearby.roomId)
        }
    }

    /** The two transfer surfaces share one controller, so neither may quietly
     *  take the other's session; the switch is a button that names it. */
    @Test
    fun switchingSurfacesIsExplicit() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = viewModel()
            vm.startNearbyDirect()
            awaitTrue("Nearby is running") { state(vm).nearby.active }

            compose.onNodeWithText(string(R.string.tab_transfer)).performClick()
            instrumentation().waitForIdleSync()
            // The join form is NOT offered; the explanation and the one button
            // that frees the controller are.
            compose.onNodeWithText(string(R.string.transfer_nearby_running)).assertIsDisplayed()
            compose.onNode(
                hasText(string(R.string.transfer_stop_nearby)) and hasClickAction(),
            ).performClick()
            awaitTrue("and only that button ends it") { !state(vm).nearby.active }
        }
    }

    private fun string(id: Int) = instrumentation().targetContext.getString(id)
}
