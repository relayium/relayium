package com.relayium.android.integration

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.relayium.android.R
import com.relayium.android.TestHooks
import com.relayium.android.TransferViewModel
import com.relayium.android.scan.ScannerState
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **The refusal half of the camera journey, through the real OS.**
 *
 * The grant path is proven elsewhere. This is what a person who says no
 * actually gets: a refusal they can act on, a second ask that works, a
 * permanent refusal that stops asking and offers the only thing that can help,
 * and a grant made in Settings being picked up when they come back.
 *
 * ## Nothing here is injected
 *
 * Every permission transition is a real tap on the real system dialog or the
 * real Settings page. `grantRuntimePermission` would make all of this pass
 * without exercising a single line of the path a user takes — and the defect
 * this area already produced (a granted camera showing a refusal screen) lived
 * exactly in that gap, between what Android recorded and what the app did with
 * it.
 *
 * ## One test, in order
 *
 * The states are cumulative: a first denial is what makes the second one
 * permanent, and a permanent refusal is what makes Settings the only way
 * forward. Split into separate methods they would fight over one device-wide
 * permission and pass or fail on JUnit's ordering.
 *
 * ## What the harness must do first
 *
 * Revoke `CAMERA` **and** clear the user-set flags, so the system will still
 * present a dialog. Asserted below rather than assumed: a run that starts from
 * a permanent refusal cannot exercise the first denial and would report a pass
 * for a journey it never took.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class ScannerPermissionJourneyTest {

    /**
     * Compose OUTER, the Activity INNER.
     *
     * `MainActivity.onCreate` calls `setContent`, so the test's Compose root
     * registry has to exist before the Activity starts — otherwise every
     * semantic assertion fails with "no compose hierarchies found", which reads
     * as the app having no UI rather than as a rule-ordering mistake.
     */
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
    fun requireAFreshRefusableState() {
        assertEquals(
            "this journey needs CAMERA revoked; granted, there is no refusal to make",
            PackageManager.PERMISSION_DENIED,
            context.checkSelfPermission(Manifest.permission.CAMERA),
        )
    }

    @Test
    fun denyThenRetryThenPermanentThenSettingsGrant() {
        openScanner()

        // ── the first refusal ───────────────────────────────────────────────
        val firstDialog = awaitPermissionDialog()
        assertNotNull("the system never asked for the camera", firstDialog)
        tap(denyButton(), "Deny")

        awaitState("a refusal the user can act on", ScannerState.DENIED)
        assertFalse("a refused scanner must hold no camera", viewModel.scanner.isBoundForTest())
        // The refusal offers the thing that works: asking again.
        compose.onNodeWithText(s(R.string.scan_denied_title)).assertExists()
        compose.onNode(hasText(s(R.string.scan_denied_retry)) and hasClickAction())
            .reach()

        // ── asking again, from a button the user pressed ────────────────────
        compose.onNode(hasText(s(R.string.scan_denied_retry)) and hasClickAction()).performClick()
        compose.waitForIdle()
        assertNotNull(
            "retry did not re-arm the prompt; a refusal that cannot be revisited is a dead end",
            awaitPermissionDialog(),
        )

        // ── the second refusal, which Android makes permanent ───────────────
        tap(denyButton(), "Deny (second)")
        awaitState(
            "a second refusal must be recognised as permanent — the system will not present the " +
                "dialog again, and offering 'try again' would be a button that does nothing",
            ScannerState.DENIED_PERMANENTLY,
        )
        assertFalse(viewModel.scanner.isBoundForTest())

        // The only honest offer left, and the retry is gone.
        compose.onNodeWithText(s(R.string.scan_denied_forever_body)).assertExists()
        compose.onNodeWithText(s(R.string.scan_denied_retry)).assertDoesNotExist()
        // The manual path is still there in every refusal state: the scanner is
        // the shortcut, not the only way in.
        compose.onNodeWithText(s(R.string.scan_manual)).assertExists()

        // ── Settings, and a grant made there ────────────────────────────────
        compose.onNode(hasText(s(R.string.scan_denied_forever_action)) and hasClickAction())
            .reach().performClick()
        assertTrue(
            "the app's settings page did not open",
            device.wait(Until.hasObject(By.pkg(SETTINGS_PACKAGE).depth(0)), UI_TIMEOUT),
        )

        grantCameraInSettings()

        // Back to the app. `resume` re-reads the permission and never prompts,
        // which is what makes the return trip from Settings work at all.
        returnFromSettings()
        compose.waitForIdle()

        assertEquals(
            PackageManager.PERMISSION_GRANTED,
            context.checkSelfPermission(Manifest.permission.CAMERA),
        )
        awaitBound(
            "a camera granted in Settings was not picked up on return — the refusal screen would " +
                "still be showing after the user did exactly what it asked",
        )
        // …and no dialog was raised to achieve it. `resume` must never prompt.
        assertFalse(
            "returning from Settings raised a permission dialog",
            device.hasObject(anyPermissionDialog()),
        )
    }

    // ── the app's own controls ──────────────────────────────────────────────

    private fun openScanner() {
        compose.onNode(hasText(s(R.string.scan_open)) and hasClickAction())
            .reach().performClick()
        compose.waitForIdle()
    }

    // ── the system's ───────────────────────────────────────────────────────

    /**
     * The allow/deny dialog, matched across the ids AOSP has used.
     *
     * A single exact id makes an image that names its button differently look
     * like "the app never asked", which is a product failure this test would be
     * reporting about itself.
     */
    private fun anyPermissionDialog(): BySelector =
        By.res(Pattern.compile(".*:id/permission_(allow|deny).*"))

    private fun denyButton(): BySelector =
        By.res(Pattern.compile(".*:id/permission_deny(_and_dont_ask_again)?_button"))

    private fun awaitPermissionDialog(): Any? =
        device.wait(Until.findObject(anyPermissionDialog()), UI_TIMEOUT)

    private fun tap(selector: BySelector, what: String) {
        val target = device.wait(Until.findObject(selector), UI_TIMEOUT)
            ?: error(
                "$what was not on screen. Present: " +
                    device.findObjects(anyPermissionDialog()).map { it.resourceName },
            )
        target.click()
        compose.waitForIdle()
    }

    /**
     * Turn the camera on for this app in the real Settings UI.
     *
     * Labels rather than ids, because the Settings permission rows are not
     * addressable by a stable id — and both maintained languages are covered,
     * since the owning harness runs this class under `en-US` and `zh-CN`. A
     * label that matches neither fails with what WAS on screen, so the run says
     * which control it could not find instead of timing out anonymously.
     */
    private fun grantCameraInSettings() {
        clickAnyLabel(PERMISSIONS_LABELS, "the Permissions entry")
        clickAnyLabel(CAMERA_LABELS, "the Camera permission row")
        clickAnyLabel(ALLOW_LABELS, "the Allow option")
    }

    private fun clickAnyLabel(labels: List<String>, what: String) {
        for (label in labels) {
            val found = device.wait(
                Until.findObject(By.text(Pattern.compile(label, Pattern.CASE_INSENSITIVE))),
                SHORT_TIMEOUT,
            )
            if (found != null) {
                found.click()
                device.waitForIdle()
                return
            }
        }
        error(
            "$what was not found. On screen: " +
                device.findObjects(By.clazz(Pattern.compile(".*TextView")))
                    .mapNotNull { it.text }
                    .filter { it.isNotBlank() }
                    .take(30),
        )
    }

    /**
     * Walk back out of Settings until this app is in front again.
     *
     * A fixed number of Backs is wrong, and a device run proved it: granting
     * the camera leaves the user on the permission DETAIL page, which is three
     * levels deep — detail, app permissions, app details — so two Backs land
     * still inside Settings and the return leg fails for a reason that has
     * nothing to do with the product.
     *
     * Bounded and OBSERVED: press, look at what is actually in front, stop the
     * moment it is this app. The bound exists so a Settings layout that never
     * yields fails as a stuck harness rather than pressing Back forever and
     * walking the device out to the launcher.
     */
    private fun returnFromSettings() {
        repeat(MAX_BACK_PRESSES) {
            if (device.currentPackageName == context.packageName) return
            device.pressBack()
            device.waitForIdle()
            device.wait(Until.hasObject(By.pkg(context.packageName).depth(0)), SHORT_TIMEOUT)
        }
        assertEquals(
            "still not back in the app after $MAX_BACK_PRESSES Back presses; last package was " +
                device.currentPackageName,
            context.packageName,
            device.currentPackageName,
        )
    }

    // ── waits ───────────────────────────────────────────────────────────────

    private fun awaitState(what: String, expected: ScannerState) {
        val deadline = System.currentTimeMillis() + UI_TIMEOUT
        while (System.currentTimeMillis() < deadline) {
            if (viewModel.scanner.state.value == expected) {
                compose.waitForIdle()
                return
            }
            Thread.sleep(POLL_MS)
        }
        error("$what: state is ${viewModel.scanner.state.value}, expected $expected")
    }

    private fun awaitBound(what: String) {
        val deadline = System.currentTimeMillis() + BIND_TIMEOUT
        while (System.currentTimeMillis() < deadline) {
            if (viewModel.scanner.isBoundForTest()) return
            Thread.sleep(POLL_MS)
        }
        error(
            "$what: state=${viewModel.scanner.state.value}, " +
                "generation=${viewModel.scanner.currentGenerationForTest()}",
        )
    }

    private companion object {
        const val UI_TIMEOUT = 15_000L
        const val SHORT_TIMEOUT = 3_000L
        const val BIND_TIMEOUT = 20_000L
        const val POLL_MS = 100L
        const val SETTINGS_PACKAGE = "com.android.settings"

        /** Deep enough for permission detail -> app permissions -> app details,
         *  with room to spare; bounded so a stuck page is a harness failure
         *  rather than a walk out to the launcher. */
        const val MAX_BACK_PRESSES = 5

        /** EN and zh-Hans, because the owning harness runs both locales. */
        val PERMISSIONS_LABELS = listOf("Permissions", "权限")
        val CAMERA_LABELS = listOf("Camera", "相机")
        val ALLOW_LABELS = listOf(
            "Allow only while using the app",
            "While using the app",
            "Allow",
            "仅在使用该应用时允许",
            "使用应用时允许",
            "允许",
        )
    }
}
