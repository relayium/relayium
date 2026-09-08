package com.relayium.android.integration

import android.os.SystemClock
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.relayium.android.DocumentsUiDriver
import com.relayium.android.InteropDriver
import com.relayium.android.R
import com.relayium.android.TestHooks
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **The bounded picker lease, on the real monotonic clock, through the real
 * journey.**
 *
 * This is the case no lifecycle event can produce and no injected clock can
 * prove: the user taps Send on a live Nearby session, `DocumentsUI` comes to
 * the front, and they press **Home while still inside it**. This app receives
 * no second `ON_STOP` — it was already stopped — and nothing tells it the
 * picker is gone either. Left alone, the device goes on advertising itself on
 * the local link with its owner two apps away.
 *
 * ## The session is established HERE, against the real Apple peer
 *
 * A Nearby file picker is only reachable from a CONNECTED session, and the
 * Activity this class launches is a fresh one — there is no session to inherit.
 * So the same establishment `NearbyAppleCounterpartTest` uses is performed
 * inside this run: the unchanged shipped `LocalTransferPeer` in its
 * `local-link-peer` role is discovered over real Bonjour BY NAME, connected to,
 * and the `link/1` handshake completed. Nothing is sent to it — the peer's only
 * job here is to make the session real, so the presence claim being bounded is
 * a claim about something this device is actually advertising.
 *
 * ## Nothing here is shortened
 *
 * The debug clock offset is asserted to be ZERO and never touched, and the
 * elapsed time is read from [SystemClock.elapsedRealtime] — the same monotonic
 * clock the product measures the lease against. Wall-clock time is not a
 * duration: an NTP correction during a two-minute wait would move it, and the
 * test would then be measuring the device's clock rather than the app's rule.
 *
 * ## Why the recreation is placed where it is
 *
 * It happens well before the deadline and the expiry is checked well after it.
 * If a recreation renewed the lease, the deadline would move to
 * `recreate + 120s` — LATER than the moment this test checks — so a renewed
 * lease shows up as "still running" rather than being missed by a margin. That
 * ordering is the assertion.
 *
 * It also uses [HostActivityRule.recreateWhileCovered]: the ordinary recreate
 * waits for RESUMED, which a covering `DocumentsUI` correctly prevents forever.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class NearbyPickerLeaseWallClockTest {

    @get:Rule(order = 0)
    val compose = createEmptyComposeRule()

    @get:Rule(order = 1)
    internal val host = HostActivityRule()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val device: UiDevice get() = UiDevice.getInstance(instrumentation)
    private val context get() = instrumentation.targetContext
    private fun s(id: Int) = context.getString(id)

    private val viewModel: TransferViewModel
        get() = requireNotNull(TestHooks.viewModel) { "the real ViewModel was not registered" }

    @Before
    fun theClockMustBeReal() {
        assertEquals(
            "this case measures the SHIPPED deadline on the real monotonic clock; an offset " +
                "would make it prove arithmetic the JVM suite already covers",
            0L,
            TestHooks.pickerClockOffsetMillis,
        )
    }

    @Test
    fun homeFromDocumentsUiEndsTheClaimAndRetiresTheOperation() {
        val peerName = decodeHex(InteropDriver.requireArg("apple.peerNameHex"))
        val expectOrigin = InteropDriver.requireArg("apple.expectOrigin")
        val fixtureName = InteropDriver.requireArg("picker.fixtureName")
        assertEquals(
            "the run must point this build at its own throwaway origin",
            expectOrigin,
            viewModel.backendOrigin,
        )

        // A document for the LATE pick to choose, staged into the disposable
        // test provider before anything else needs it.
        InteropDriver.stageOutgoing(fixtureName, ByteArray(2048) { (it and 0x7f).toByte() })

        establishNearbySessionWith(peerName)
        val room = viewModel.state.value.nearby.roomId

        // ── the owned picker, launched from the app's own control ───────────
        //
        // The task is remembered BEFORE the picker covers it, so the return leg
        // can bring that exact task forward without launching anything.
        val taskId = host.activity.taskId
        val startedAt = SystemClock.elapsedRealtime()
        compose.onNode(hasText(s(R.string.files_pick)) and hasClickAction())
            .reach().performClick()
        assertTrue(
            "the document picker did not come to the front",
            device.wait(
                Until.hasObject(By.pkg(DocumentsUiDriver.DOCS_PKG).depth(0)),
                UI_TIMEOUT,
            ),
        )
        assertEquals(
            "launching an owned picker must take exactly one lease",
            1,
            compose.runOnUiThread { viewModel.pickerLease.outstandingCount() },
        )
        assertTrue("an owned picker round trip is not the user leaving", foreground())

        // ── a real recreation BEHIND the picker, well before the deadline ───
        sleepUntil(startedAt + RECREATE_AT_MS)
        host.recreateWhileCovered()
        assertEquals(
            "a recreation must not start a second lease",
            1,
            compose.runOnUiThread { viewModel.pickerLease.outstandingCount() },
        )

        // ── Home, from inside DocumentsUI ───────────────────────────────────
        //
        // The journey the platform reports nothing about: no second ON_STOP,
        // no callback saying the picker is gone.
        device.pressHome()
        device.waitForIdle()

        // ── the real 120 seconds, from the ORIGINAL launch ──────────────────
        sleepUntil(startedAt + CHECK_AT_MS)

        assertEquals(
            "the lease did not expire on its ORIGINAL deadline — a renewal at the recreation " +
                "would put it at recreate+120s, which is still in the future at this point",
            0,
            compose.runOnUiThread { viewModel.pickerLease.outstandingCount() },
        )
        assertFalse(
            "the app still claims to be in front of the user after being away past the deadline",
            foreground(),
        )
        assertFalse(
            "Nearby was still advertising this device with its owner two apps away",
            viewModel.state.value.nearby.active,
        )

        // ── the late result, from a REAL document choice ────────────────────
        //
        // Back to the task, where DocumentsUI is still waiting, and the staged
        // fixture is chosen by its own label — long after the operation it
        // belonged to was retired. A tap on "any clickable" would be a preview,
        // a folder or a sort header, and would return no result at all while
        // looking like it had.
        returnToTask(taskId)
        // The picker must still be the thing on top. If the return leg had
        // launched a new intent instead of moving the task, `singleTask` would
        // have cleared DocumentsUI off the stack and this run would be choosing
        // a document in a picker it had just destroyed and relaunched — a
        // different operation entirely, and not a late result at all.
        assertTrue(
            "DocumentsUI was not still on top after returning; the pending picker was lost",
            device.wait(
                Until.hasObject(By.pkg(DocumentsUiDriver.DOCS_PKG).depth(0)),
                UI_TIMEOUT,
            ),
        )
        DocumentsUiDriver.enterTestRootThenTap(fixtureName)

        // WAITED FOR FIRST, and the diagnostic collected only if it fails.
        //
        // Kotlin evaluates an argument before the call, so putting a UI dump in
        // the assertion MESSAGE ran it before the condition — while the picker
        // was still handing its result back and the tree was mid-transition.
        // The dump walked nodes that had just gone away and died with a
        // `StaleObjectException`, failing the run at the very last step of a
        // 128-second journey that had otherwise passed.
        //
        // The dump is also fallible by nature: it reads a UI that is allowed to
        // move underneath it. So even on the failure path it is best-effort —
        // losing the diagnostic is worth far less than replacing a real verdict
        // with an exception from the thing describing it.
        val consumed = DocumentsUiDriver.waitConsumed {
            device.currentPackageName == context.packageName
        }
        if (!consumed) {
            val visible = runCatching { DocumentsUiDriver.uiDump() }
                .getOrElse { "<ui dump unavailable: ${it.javaClass.simpleName}>" }
            fail(
                "the picker result never came back to the app; the late-callback path was " +
                    "never exercised. Visible: $visible",
            )
        }
        compose.waitForIdle()

        // It may not revive the room it was chosen for, and it may not attach
        // itself to anything newer.
        assertFalse(
            "a late picker result restarted Nearby",
            viewModel.state.value.nearby.active,
        )
        // ENDED, not IDLE. The timeout's withdrawal goes through
        // `stopNearby()`, which sends the same authenticated leave an ordinary
        // disconnect does and settles on `Phase.ENDED` — the session is over,
        // not un-started, and the surface says so. `NearbyLifecycleAcceptanceTest`
        // asserts the same terminal for the same reason.
        //
        // What is under test is that the late result did not move it FORWARD:
        // a revived session would be CONNECTED, and a batch attached to one
        // would show in `outgoing` below.
        assertEquals(
            "a late picker result moved the ended session somewhere",
            TransferController.Phase.ENDED,
            viewModel.state.value.phase,
        )
        // `stopNearby` resets the whole Nearby block, so the room the pick was
        // made for is gone; the link id is deliberately NOT reset, and a late
        // result must not be able to bring the old room back with it.
        assertTrue(
            "a late picker result revived the retired room",
            viewModel.state.value.nearby.roomId != room,
        )
        assertEquals(
            "a retired operation must not be outstanding again",
            0,
            compose.runOnUiThread { viewModel.pickerLease.outstandingCount() },
        )
        assertTrue(
            "the late result was applied as an outgoing batch",
            viewModel.state.value.outgoing.isEmpty(),
        )
    }

    // ── establishment, exactly as the accepted Apple counterpart does it ────

    private fun establishNearbySessionWith(peerName: String) {
        // The destination bar has no scrollable ancestor in its wide form, so a
        // bare `performScrollTo` here fails on the default layout. See [reach].
        compose.onNode(hasText(s(R.string.tab_nearby)) and isSelectable())
            .reach().performClick()
        compose.waitForIdle()
        compose.onNode(hasText(s(R.string.nearby_start_direct)) and hasClickAction())
            .reach().performClick()
        InteropDriver.awaitTrue("the local link came up") {
            viewModel.state.value.nearby.room == TransferController.NearbyRoom.JOINED
        }

        // Discovered over real Bonjour, by the name the peer advertises. No
        // address is passed in, and exactly one device must answer to that name
        // or the run cannot say which one it chose.
        InteropDriver.awaitTrue("the Apple peer was DISCOVERED by name", 120_000) {
            viewModel.state.value.nearby.devices.count { it.name == peerName } == 1
        }
        val peer = viewModel.state.value.nearby.devices.first { it.name == peerName }
        assertTrue(
            "the peer must announce link/1, or the session under test is the legacy wire",
            peer.supportsLink,
        )
        viewModel.connectToPeer(peer.id, viewModel.state.value.nearby.roomId)
        InteropDriver.awaitTrue("the link to the Apple peer came up", 120_000) {
            viewModel.state.value.phase == TransferController.Phase.CONNECTED
        }
        assertNotNull("a connected link has compared keys", viewModel.state.value.sas)
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun foreground(): Boolean = compose.runOnUiThread { viewModel.foreground.value }

    /**
     * Real elapsed time on the MONOTONIC clock, in small steps so a stuck
     * device fails on its own deadline rather than inside one long opaque
     * sleep.
     */
    private fun sleepUntil(target: Long) {
        while (SystemClock.elapsedRealtime() < target) {
            val remaining = target - SystemClock.elapsedRealtime()
            Thread.sleep(STEP_MS.coerceAtMost(remaining).coerceAtLeast(1L))
        }
    }

    /**
     * Bring this app's OWN task forward, without launching anything.
     *
     * A launcher intent is destructive here. `MainActivity` is `singleTask`, so
     * starting it again delivers a new intent to the existing instance and
     * CLEARS whatever is above it — which is precisely the `DocumentsUI` this
     * case needs to still be waiting. The picker would be torn down and a fresh
     * one would have to be launched to choose anything, and that is a different
     * operation with a live lease: the exact opposite of the late result under
     * test. It would also deliver an intent the ingress coordinator has to
     * consider, muddying a run that is about the picker and nothing else.
     *
     * `AppTask.moveToFront` moves the task the user was in, with the OS's own
     * lifecycle and the picker still on top of it.
     */
    private fun returnToTask(taskId: Int) {
        val manager = context.getSystemService(android.app.ActivityManager::class.java)
            ?: error("no ActivityManager")
        val task = manager.appTasks.firstOrNull {
            runCatching { it.taskInfo?.taskId }.getOrNull() == taskId
        } ?: error(
            "this app's task $taskId is gone; tasks now: " +
                manager.appTasks.map { runCatching { it.taskInfo?.taskId }.getOrNull() },
        )
        instrumentation.runOnMainSync { task.moveToFront() }
        device.waitForIdle()
    }

    private fun decodeHex(hex: String): String =
        String(ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() })

    private companion object {
        const val UI_TIMEOUT = 20_000L
        const val STEP_MS = 500L

        /** Far enough before the deadline that a renewal here would still be
         *  outstanding at [CHECK_AT_MS]. */
        const val RECREATE_AT_MS = 30_000L

        /** The shipped 120s, plus margin for the sweep to run. */
        const val CHECK_AT_MS = 128_000L
    }
}
