package com.relayium.android

import android.view.WindowManager
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.account.AccountState
import com.relayium.android.account.KeystoreTokenStore
import com.relayium.android.cloud.CloudDownloadModel
import com.relayium.android.cloud.CloudUploadModel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **The incoming-link entry point, and the screen staying awake — on a device.**
 *
 * Driven through the REAL `MainActivity`, the real [TransferViewModel], the real
 * Compose tree and a real Relayium server the shell half started, exactly like
 * [CloudAcceptanceTest]. Every expected string is resolved from the app's own
 * resources under the device's configuration, so this asserts each maintained
 * localisation rather than hard-coded English.
 *
 * ## What is proved here and what is proved elsewhere
 *
 * The entry, navigation, ordering, IME and window-flag behaviour need a real
 * Activity, a real keyboard and a real window, so they live here.
 *
 * The download RECOVERY does not. Proving a resume means cutting a connection at
 * an exact ciphertext offset and answering `Range` in ways a correct server never
 * would, which a real server cannot be asked to do — so `CloudResumeTest` and
 * `CloudDownloadRecoveryTest` own it against a loopback host that can. What this
 * class asserts of that work is the part a device can actually show: that a save
 * announces one discrete status rather than a byte counter per frame.
 *
 * Nothing here simulates a real idle screen timeout. Instrumentation keeps the
 * device awake, so what is asserted is the flag the system reads — set while
 * there is work, cleared when there is not. Whether a physical phone then stays
 * lit is a device gate for a person holding one.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class StoredEntryAwakeAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun s(id: Int) = context.getString(id)

    private val origin get() = InteropDriver.requireArg("relayium.origin")
    private val email get() = InteropDriver.requireArg("relayium.email")
    private val password get() = InteropDriver.requireArg("relayium.password")

    @Before
    fun startFromASignedOutDevice() {
        runCatching { KeystoreTokenStore(context).clear() }
    }

    private fun button(text: String) = compose.onNode(hasText(text) and hasClickAction())

    private fun vm() = InteropDriver.viewModel()

    private fun uploadState() = vm().cloudUpload.state.value

    private fun downloadState() = vm().cloudDownload.state.value

    /** The mandatory preflight: this run must be on its own disposable server
     *  before a credential or a byte goes anywhere. */
    private fun launch(): ActivityScenario<MainActivity> {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        assertEquals("the app must be on this run's local backend", origin, vm().backendOrigin)
        compose.waitForIdle()
        return scenario
    }

    private fun onCloudTab() {
        button(s(R.string.tab_cloud)).performClick()
        compose.waitForIdle()
    }

    private fun signIn() {
        vm().account.signIn(email, password)
        InteropDriver.awaitTrue("the account to be ready") {
            vm().account.state.value is AccountState.Ready
        }
    }

    /** Publish a real stored object and return the link that opens it. */
    private fun publish(name: String, bytes: ByteArray): String {
        val uri = InteropDriver.stageOutgoing(name, bytes)
        vm().cloudFilesPicked(listOf(uri), vm().cloudUpload.beginSelection())
        InteropDriver.awaitTrue("the selection to be described") {
            uploadState() is CloudUploadModel.State.Selected
        }
        compose.waitForIdle()
        button(s(R.string.cloud_upload)).performScrollTo().performClick()
        InteropDriver.awaitTrue("the upload to finish") {
            uploadState() is CloudUploadModel.State.Ready
        }
        return (uploadState() as CloudUploadModel.State.Ready).link
    }

    private fun ActivityScenario<MainActivity>.holdsKeepScreenOn(): Boolean {
        var held = false
        onActivity { activity ->
            held = activity.window.attributes.flags and
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
        }
        return held
    }

    /** The top edge of a node, for asserting which card comes first. */
    private fun topOf(text: String): Float =
        compose.onNode(hasText(text)).fetchSemanticsNode().positionInRoot.y

    // ── the defect: a supported link refused by the field that accepts links ─

    /**
     * A stored-file link pasted into **Code or link** opens the surface that
     * receives it.
     *
     * The 0.2.2 build answered this with "That is a stored-file link. This app
     * joins live transfers between two devices that are both open" — false about
     * the app it appeared in, since the Cloud surface receives exactly these
     * links anonymously in the same build. The user was told the app could not
     * do the thing it does, and given no route to the screen that does it.
     */
    @Test
    fun aStoredLinkPastedIntoTheJoinFieldOpensTheReceiveSurface() {
        launch().use { scenario ->
            onCloudTab()
            signIn()
            val link = publish("entry-routed.txt", "routed through the join field".toByteArray())

            // Back to the transfer surface, and clear whatever the publish left
            // on the cloud one, so what follows is only this paste's doing.
            vm().cloudDownload.reset()
            vm().cloudLinkDraft.clear()
            button(s(R.string.tab_transfer)).performClick()
            compose.waitForIdle()

            compose.onNode(hasSetTextAction() and hasText(s(R.string.join_field_label)))
                .performScrollTo()
                .performTextInput(link)
            compose.waitForIdle()
            button(s(R.string.join_action)).performScrollTo().performClick()

            // It RESOLVED the link — metadata only — and it did so on the Cloud
            // surface, without the user finding that screen themselves.
            InteropDriver.awaitTrue("the pasted link to open") {
                downloadState() is CloudDownloadModel.State.Ready
            }
            compose.waitForIdle()
            compose.onNode(hasText(s(R.string.cloud_receive_title))).assertIsDisplayed()

            // Nothing was downloaded or saved: writing plaintext stays a tap on
            // a folder the user picks.
            compose.onNode(hasText(s(R.string.cloud_choose_folder))).assertIsDisplayed()
            assertEquals("entry-routed.txt", (downloadState() as CloudDownloadModel.State.Ready).names.single())

            // The link moved to the field that owns it, and the join field was
            // not left holding a string it had already consumed.
            assertEquals(link, vm().cloudLinkDraft.text.value)
            assertEquals("", vm().joinDraft.value)
            assertTrue("no join error was raised", vm().joinError.value == null)

            InteropDriver.report(
                "stored-link-join-entry",
                mapOf("routed" to true, "autoSaved" to false),
            )
        }
    }

    /**
     * The receive card leads while a transfer is incoming.
     *
     * Arriving here with a link means the receive half is what the user asked
     * for, and it otherwise renders below a send card, its retention controls
     * and an account prompt — entirely below the fold on a phone.
     */
    @Test
    fun theReceiveCardLeadsOnlyWhileATransferIsIncoming() {
        launch().use {
            onCloudTab()
            // Nothing incoming: sending leads, which is what most visits are for.
            assertTrue(
                "the send card must lead by default",
                topOf(s(R.string.cloud_send_title)) < topOf(s(R.string.cloud_receive_title)),
            )

            signIn()
            val link = publish("entry-order.txt", "order".toByteArray())
            vm().cloudDownload.open(link)
            InteropDriver.awaitTrue("the link to open") {
                downloadState() is CloudDownloadModel.State.Ready
            }
            compose.waitForIdle()

            assertTrue(
                "an incoming transfer must put the receive card first",
                topOf(s(R.string.cloud_receive_title)) < topOf(s(R.string.cloud_send_title)),
            )
        }
    }

    /** The keyboard's Done runs the SAME explicit open the button runs, once. */
    @Test
    fun theKeyboardDoneOpensTheLinkExactlyOnce() {
        launch().use {
            onCloudTab()
            signIn()
            val link = publish("entry-ime.txt", "ime".toByteArray())
            vm().cloudDownload.reset()
            vm().cloudLinkDraft.clear()
            compose.waitForIdle()

            compose.onNode(hasSetTextAction() and hasText(s(R.string.cloud_link_label)))
                .performScrollTo()
                .performTextInput(link)
            compose.waitForIdle()
            // The model's transfer token advances once per admitted `open`, so
            // it counts dispatches exactly — a keyboard action that also fell
            // through to the button, or a field wired to submit twice, would
            // move it by two.
            val before = vm().cloudDownload.currentTransfer()
            compose.onNode(hasSetTextAction() and hasText(s(R.string.cloud_link_label)))
                .performImeAction()

            InteropDriver.awaitTrue("the link to open from the keyboard action") {
                downloadState() is CloudDownloadModel.State.Ready
            }
            compose.waitForIdle()
            assertEquals(
                "the keyboard action must dispatch exactly one open",
                before + 1,
                vm().cloudDownload.currentTransfer(),
            )
        }
    }

    // ── what a screen reader is told ────────────────────────────────────────

    // ── the wiring, the lifecycle, and what a screen reader is told ─────────

    /**
     * TEST-ONLY seam: publish a state straight onto `CloudDownloadModel`'s own
     * `_state` flow by reflection.
     *
     * **This proves WIRING, LIFECYCLE and RENDERING — never transport.** It
     * asserts that a given model state reaches the window flag and the screen;
     * it asserts nothing about downloads, resumes or bytes, which
     * `CloudResumeTest` and `CloudDownloadRecoveryTest` own against a loopback
     * host that can cut a connection at an exact ciphertext offset, and which
     * `CloudAcceptanceTest` covers end to end against a real server.
     *
     * Reflection rather than a product API on purpose: a settable state on a
     * shipped model would be a test hook in release source, and there is nothing
     * here worth that. The field's TYPE and the published value are both checked
     * so a rename or a refactor fails loudly instead of quietly testing nothing.
     */
    private fun publishDownloadState(state: CloudDownloadModel.State) {
        val model = vm().cloudDownload
        val field = CloudDownloadModel::class.java.getDeclaredField("_state")
        field.isAccessible = true
        val flow = field.get(model)
        assertTrue(
            "CloudDownloadModel._state is no longer a MutableStateFlow; this seam is stale",
            flow is MutableStateFlow<*>,
        )
        @Suppress("UNCHECKED_CAST")
        (flow as MutableStateFlow<CloudDownloadModel.State>).value = state
        assertEquals("the seam did not reach the model's published state", state, downloadState())
        compose.waitForIdle()
    }

    private fun awaitFlag(scenario: ActivityScenario<MainActivity>, expected: Boolean, why: String) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            if (scenario.holdsKeepScreenOn() == expected) return
            Thread.sleep(10)
        }
        throw AssertionError("$why (flag was ${scenario.holdsKeepScreenOn()}, wanted $expected)")
    }

    /**
     * The saving state announces ONE discrete status, and names a recovery.
     *
     * `CloudDownloadModel` republishes `Saving` on every write — once per
     * 192 KiB frame — so the live region that used to sit on the byte counter
     * interrupted TalkBack about eleven thousand times on a 2 GB receive. The
     * counter is no longer announced; one discrete status is.
     *
     * The absence of a live region on the counter is NOT asserted here: that
     * would mean matching it by its localised, byte-formatted text, and a
     * matcher that failed to find the node would report a pass for an assertion
     * it never made. It is one `Modifier` argument at one call site in
     * `CloudScreen.ReceiveCard`, verified by reading it.
     */
    @Test
    fun theSavingStateAnnouncesOneDiscreteStatusAndNamesARecovery() {
        launch().use {
            onCloudTab()
            publishDownloadState(CloudDownloadModel.State.Saving(10, 100))
            compose.onNode(hasText(s(R.string.cloud_saving_status)))
                .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion))
                .assertIsDisplayed()

            // A recovery window is the same node saying something else, so a
            // screen reader hears one transition rather than a new region.
            publishDownloadState(CloudDownloadModel.State.Saving(10, 100, reconnecting = true))
            compose.onNode(hasText(s(R.string.cloud_reconnecting)))
                .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.LiveRegion))
                .assertIsDisplayed()

            publishDownloadState(CloudDownloadModel.State.Idle)
            InteropDriver.report(
                "cloud-saving-announcement",
                mapOf("discreteStatusAnnounced" to true, "recoveryNamed" to true),
            )
        }
    }

    // ── the screen, while there is work ─────────────────────────────────────

    /**
     * Work in flight holds `FLAG_KEEP_SCREEN_ON`; finished work gives it back.
     *
     * The device's own idle timeout is what was ending Nearby sessions and Inbox
     * deliveries: screen-off delivers a bare `ON_STOP`, which the presence rule
     * correctly reads as leaving. Holding the window awake while there is real
     * work keeps that rule honest instead of weakening it.
     */
    @Test
    fun workInFlightHoldsTheScreenAwakeAndReleasesItAfterwards() {
        launch().use { scenario ->
            onCloudTab()
            awaitFlag(scenario, false, "an idle app must hold no claim on the screen")

            publishDownloadState(CloudDownloadModel.State.Saving(10, 100))
            assertTrue("the policy must claim work", vm().keepScreenAwake.value)
            awaitFlag(scenario, true, "work in flight must hold the screen awake")

            // A recovery window is part of the same operation and must not let
            // the device sleep at the moment the transfer is most fragile.
            publishDownloadState(CloudDownloadModel.State.Saving(10, 100, reconnecting = true))
            awaitFlag(scenario, true, "a recovering transfer must still hold the screen")

            publishDownloadState(CloudDownloadModel.State.Done(1))
            awaitFlag(scenario, false, "the claim must end with the work")

            InteropDriver.report(
                "keep-awake-window-flag",
                mapOf("heldDuringWork" to true, "heldWhileRecovering" to true, "releasedAfter" to true),
            )
        }
    }

    /**
     * Leaving the app gives the screen back, whatever the transfer is doing —
     * and coming back re-establishes the claim while the work continues.
     *
     * Nothing here makes a stopped Activity count as foreground. That would be
     * the wrong fix and would have this build advertising a sleeping device to a
     * peer that then waits out a presence TTL; `HostPresence` is untouched.
     */
    @Test
    fun leavingTheAppReleasesTheScreenEvenWithWorkRunning() {
        launch().use { scenario ->
            onCloudTab()
            publishDownloadState(CloudDownloadModel.State.Saving(10, 100))
            awaitFlag(scenario, true, "work in flight must hold the screen awake")

            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            assertFalse(
                "a stopped window must hold no claim on the display",
                scenario.holdsKeepScreenOn(),
            )
            assertTrue("the work itself is untouched by leaving", vm().keepScreenAwake.value)

            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            awaitFlag(scenario, true, "returning to running work must reapply the claim")

            publishDownloadState(CloudDownloadModel.State.Idle)
            awaitFlag(scenario, false, "the claim must be released with the work")
        }
    }
}
