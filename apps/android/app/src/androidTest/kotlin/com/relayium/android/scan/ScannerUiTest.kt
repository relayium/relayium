package com.relayium.android.scan

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.relayium.android.MainActivity
import com.relayium.android.R
import com.relayium.android.ingress.IngressRequest
import com.relayium.android.ui.RelayiumTheme
import com.relayium.protocol.PairCode
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The two composables, composed for real, in a real activity.
 *
 * [ScannerCameraTest] drives the controller; this drives what the user actually
 * touches — the sheet that hosts the viewfinder and the card that draws the
 * code. The difference matters: a controller can be perfect while the sheet
 * holding it renders its Cancel button below the bottom of the screen.
 *
 * ## How the content gets there
 *
 * `MainActivity` already calls `setContent` in `onCreate`, so the compose
 * rule's own `setContent` refuses — it will not take over a hierarchy that
 * already has a composition. The activity is therefore launched for its window,
 * lifecycle and foreground, and a FRESH `ComposeView` is installed as its
 * content view on the UI thread. The rule discovers the new composition and
 * drives it normally.
 *
 * `MainActivity` is read-only here and unmodified; this is a test-time
 * replacement of what it displays. If the replacement itself ever fails, the
 * failure belongs to this harness rather than to the composables under test.
 *
 * ## Configuration comes from the device
 *
 * Nothing here hard-codes English, a width or a font scale. Copy is looked up
 * through the app's own resources, so the same class asserts `en` and `zh-Hans`
 * as the driver switches the emulator's locale, and layout assertions read
 * whatever density, font scale and theme the device is configured with —
 * matching how `UiAcceptanceTest` is run across that matrix.
 *
 * ## Waiting is done with the rule, not with the thread
 *
 * `Thread.sleep` on the test thread does not advance Compose's clock; it stops
 * the frames the assertion is waiting for. Everything below waits through
 * `compose.waitUntil`, including the places where the point is that something
 * must NOT happen — there the wait is expected to time out, which is stated
 * rather than hidden.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class ScannerUiTest {

    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val cameraPermission: GrantPermissionRule =
        GrantPermissionRule.grant(android.Manifest.permission.CAMERA)

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun s(id: Int) = context.getString(id)

    /** What the acceptance camera is pointed at. */
    private val origin = "https://relayium.com"

    /**
     * An origin nothing in front of any lens will match.
     *
     * The lifecycle cases need a pipeline that RUNS and never succeeds: on the
     * acceptance emulator a controller trusting the real origin decodes the
     * fixture within a frame or two and closes its own run, and a test that
     * then asserted "the run ended" would be reading that success rather than
     * the dismissal it claims to test. Real frames, real decodes, every result
     * refused by policy.
     */
    private val inertOrigin = "https://never-matches.invalid"

    private val expectedCode = "042913"

    // ── the sheet ───────────────────────────────────────────────────────────

    @Test
    fun theSheetShowsItselfAndItsWayOutIsReachable() {
        val controller = ScannerController(inertOrigin) { }
        var dismissed = false
        show { ScannerSheet(controller = controller, onDismiss = { dismissed = true }) }

        // The title is at the top of the sheet, so it is visible in every
        // configuration this runs under.
        compose.onNodeWithText(s(R.string.scan_title)).assertIsDisplayed()

        // The way out and the manual-entry line are asserted as REACHABLE, not
        // as initially visible, and the difference is the product decision: at
        // 320dp with the largest font the sheet does not fit on one screen, and
        // it scrolls rather than shrinking its own copy to fit. What must never
        // be true is that the exit cannot be got to at all, which is what it
        // was before the sheet became scrollable — laid out past the bottom
        // edge with no way to bring it into view.
        compose.onNodeWithText(s(R.string.scan_manual)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(s(R.string.scan_cancel)).performScrollTo().assertIsDisplayed()

        compose.onNodeWithText(s(R.string.scan_cancel)).performClick()
        compose.waitForIdle()
        assertTrue("cancel must dismiss", dismissed)
    }

    @Test
    fun dismissingTheSheetClosesTheCamera() {
        val controller = ScannerController(inertOrigin) { }
        var visible by mutableStateOf(true)
        show {
            if (visible) ScannerSheet(controller = controller, onDismiss = { visible = false })
        }
        awaitBound(controller)

        compose.onNodeWithText(s(R.string.scan_cancel)).performScrollTo().performClick()
        // Leaving the tree disposes the sheet, and disposal closes: a camera
        // held open behind a dismissed sheet is a privacy failure with a light
        // on it.
        compose.waitUntil(5_000) { !controller.isBoundForTest() }
        assertFalse(controller.isBoundForTest())
        assertEquals(ScannerState.IDLE, controller.state.value)
    }

    @Test
    fun aScannedCodeReachesTheCallerOnceThroughTheRealSheet() {
        val scanned = AtomicReference<IngressRequest.PrefillCode?>()
        val count = AtomicInteger()
        val controller = ScannerController(origin) {
            scanned.set(it)
            count.incrementAndGet()
        }
        show { ScannerSheet(controller = controller, onDismiss = { }) }

        val decoded = runCatching { compose.waitUntil(25_000) { count.get() > 0 } }.isSuccess
        assumeTrue(
            "no QR code in front of the camera; start the emulator with -camera-back imagefile:",
            decoded,
        )
        assertEquals(expectedCode, scanned.get()!!.code.digits)

        // The viewfinder keeps running for a moment, so the same code arrives
        // in many more frames. This wait is EXPECTED to time out: a second
        // result would end it early and fail the assertion below.
        runCatching { compose.waitUntil(3_000) { count.get() > 1 } }
        assertEquals("one scan, many frames", 1, count.get())
    }

    @Test
    fun recomposingTheSheetDoesNotAskForThePermissionAgain() {
        // A recomposition is not a new request. The sheet asks once and the
        // controller refuses to re-arm without an explicit retry, so a screen
        // that redraws — for any of the reasons Compose redraws — cannot turn
        // into a second system dialog.
        val controller = ScannerController(inertOrigin) { }
        var tick by mutableStateOf(0)
        show {
            Box(Modifier.fillMaxSize()) {
                // Reading `tick` here forces this subtree to recompose.
                remember(tick) { tick }
                ScannerSheet(controller = controller, onDismiss = { })
            }
        }
        val before = controller.state.value
        repeat(5) {
            compose.runOnUiThread { tick += 1 }
            compose.waitForIdle()
        }
        assertEquals("a redraw must not change what the scanner is doing", before, controller.state.value)
        assertTrue(
            "and must never leave it asking again: ${controller.state.value}",
            controller.state.value != ScannerState.REQUESTING,
        )
    }

    @Test
    fun returningToTheSheetDoesNotReprompt() {
        // Sheet away, sheet back — the trip a user makes by backgrounding the
        // app or visiting Settings. The scanner comes back to something usable
        // and does not put a dialog up on its own.
        val controller = ScannerController(inertOrigin) { }
        var visible by mutableStateOf(true)
        show {
            if (visible) ScannerSheet(controller = controller, onDismiss = { }) else Box(Modifier.fillMaxSize())
        }
        awaitBound(controller)

        compose.runOnUiThread { visible = false }
        compose.waitUntil(5_000) { controller.state.value == ScannerState.IDLE }

        compose.runOnUiThread { visible = true }
        compose.waitForIdle()
        assertTrue(
            "returning must not ask again: ${controller.state.value}",
            controller.state.value != ScannerState.REQUESTING,
        )
        compose.onNodeWithText(s(R.string.scan_cancel)).performScrollTo().assertIsDisplayed()
    }

    // ── the card ────────────────────────────────────────────────────────────

    @Test
    fun theDrawnPairingCodeIsActuallyScannable() {
        // The whole point of the card: another device's camera has to be able
        // to read what this one drew. Rendering it and decoding the PIXELS is
        // the only assertion that means that — a test that checked the matrix
        // would be testing the encoder again, and the encoder is not what draws
        // module edges at a fractional scale on a real canvas.
        show {
            PairingQrCard(
                origin = origin,
                code = PairCode(expectedCode),
                expiresAtEpochSeconds = 0L,
                nowEpochSeconds = 0L,
            )
        }

        compose.onNodeWithText(s(R.string.qr_title)).assertIsDisplayed()
        val bitmap = compose.onNodeWithContentDescription(s(R.string.qr_description))
            .captureToImage()
            .asAndroidBitmap()
        val width = bitmap.width
        val height = bitmap.height
        assertTrue("the card drew nothing", width > 0 && height > 0)

        // The card paints its own black and white, so any channel is the
        // brightness; green is used because it is the dominant luminance term.
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        val luminance = ByteArray(width * height) { ((pixels[it] shr 8) and 0xFF).toByte() }
        val frame = LuminanceFrame.of(luminance, width, 1, 0, 0, width, height, 0)
        assertNotNull("the captured card is not a readable frame", frame)
        assertEquals(
            "the drawn code must decode to the link this device is offering",
            "$origin/cross-network#c=$expectedCode",
            QrCodec.decode(frame!!),
        )
    }

    @Test
    fun anExpiredCodeIsNotDrawnAtAll() {
        // Not greyed out, not blurred, not watermarked: absent. A photograph of
        // a stale square is scanned somewhere else, minutes later, and fails on
        // the device that did nothing wrong.
        show {
            PairingQrCard(
                origin = origin,
                code = PairCode(expectedCode),
                expiresAtEpochSeconds = 1_000L,
                nowEpochSeconds = 1_000L,
            )
        }
        compose.onNodeWithText(s(R.string.qr_expired)).assertIsDisplayed()
        compose.onNodeWithContentDescription(s(R.string.qr_description)).assertDoesNotExist()
        compose.onNodeWithText(s(R.string.qr_title)).assertDoesNotExist()
    }

    @Test
    fun noCodeAtAllDrawsNoSquare() {
        show {
            PairingQrCard(origin = origin, code = null, expiresAtEpochSeconds = 0L, nowEpochSeconds = 0L)
        }
        compose.onNodeWithContentDescription(s(R.string.qr_description)).assertDoesNotExist()
        compose.onNodeWithText(s(R.string.qr_expired)).assertIsDisplayed()
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Put [content] on screen inside the launched activity.
     *
     * A fresh `ComposeView` installed as the activity's content view, on the UI
     * thread. The compose rule's own `setContent` cannot be used: `MainActivity`
     * composed in `onCreate`, and the rule refuses to take over a hierarchy that
     * already holds a composition.
     */
    private fun show(content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { activity ->
            activity.setContentView(
                ComposeView(activity).apply { setContent { RelayiumTheme { content() } } },
            )
        }
        compose.waitForIdle()
    }

    /**
     * Wait for a pipeline that is actually bound.
     *
     * Through the rule, so frames keep being produced while it waits —
     * `Thread.sleep` here would stop the very work being waited for. Skips
     * rather than fails where there is no usable camera.
     */
    private fun awaitBound(controller: ScannerController) {
        val bound = runCatching {
            compose.waitUntil(15_000) {
                when (controller.state.value) {
                    ScannerState.UNAVAILABLE, ScannerState.FAILED -> true
                    else -> controller.isBoundForTest() && controller.currentGenerationForTest() > 0L
                }
            }
        }.isSuccess
        assumeTrue("the camera never bound a pipeline", bound)
        when (controller.state.value) {
            ScannerState.UNAVAILABLE, ScannerState.FAILED ->
                assumeTrue("no usable camera: ${controller.state.value}", false)
            else -> Unit
        }
    }
}
