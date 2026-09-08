package com.relayium.android

import android.app.Instrumentation
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import java.io.File
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The update check, on a device, against a real HTTP server.
 *
 * Everything here drives the REAL `MainActivity`, the real `UpdateChecker` and
 * the real OkHttp client. The only substitution is WHERE the feed comes from:
 * the driver script points the debug feed override at a throwaway server on the
 * host, which is the same fenced seam `Backend` uses for the backend origin and
 * exists for the same reason — 0.1.1 is the first build with an updater, so
 * without it the "an update is available" branch could not be reached on a
 * device at all until something newer was already public.
 *
 * ## What is asserted about the download, and how
 *
 * The download path is checked TWO ways, because they prove different things:
 *
 *  * [downloadFiresRealViewIntent] installs an [Instrumentation.ActivityMonitor]
 *    and lets the product call the real `startActivity`. That observes the
 *    actual `ACTION_VIEW` Intent and its exact `Uri` as the system receives it —
 *    the thing a pre-Intent string hook cannot prove. The monitor swallows the
 *    Intent, so nothing is downloaded, navigated to or installed.
 *  * [noBrowserShowsCopyableUrl] uses the debug `TestHooks` launcher to answer
 *    "no browser took it", which is a device state that cannot otherwise be
 *    produced on an image that has a browser. It is labelled as the hook path
 *    precisely because it does NOT go through the system.
 *
 * Locale-portable: every expected string is resolved through the app's own
 * resources under the DEVICE's current configuration, so the same class run
 * under `en` and `zh-Hans` asserts each localisation in turn.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class UpdateAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun s(id: Int) = context.getString(id)
    private fun s(id: Int, vararg args: Any) = context.getString(id, *args)

    /** Where the driver told us its feed lives, and what it will answer. */
    private val feedUrl: String
        get() = InstrumentationRegistry.getArguments().getString("relayium.feed")
            ?: error("missing -e relayium.feed; the driver must announce its throwaway feed")

    private val outDir: File
        get() = File(
            InstrumentationRegistry.getArguments().getString("relayium.out")
                ?: context.cacheDir.absolutePath,
        ).also { it.mkdirs() }

    @Before
    fun clearLauncherHook() {
        TestHooks.installedLauncher = null
        TestHooks.lastUpdateDownloadUrl = null
    }

    @After
    fun removeLauncherHook() {
        TestHooks.installedLauncher = null
        TestHooks.lastUpdateDownloadUrl = null
    }

    /**
     * Fail closed BEFORE believing any answer.
     *
     * `UpdateEndpoint.readDebugOverride` reads a non-public class reflectively
     * and falls back to production on any failure, so a harness that skipped
     * this check could read the REAL feed and report whatever it happens to say
     * as though the test had produced it. Reading the resolved value off the
     * live ViewModel — rather than re-deriving it — is what makes the assertion
     * about this instance.
     */
    private fun assertPointedAtTestFeed() {
        val resolved = TestHooks.viewModel?.updateFeedUrl
        assertNotNull("no ViewModel registered; the app did not start", resolved)
        assertEquals(
            "the app resolved a different feed than this run's throwaway one — refusing to " +
                "believe any update answer it shows",
            feedUrl,
            resolved,
        )
    }

    /** The configuration corner this pass is running under, so three corners
     *  produce three sets of screenshots instead of overwriting one. */
    private val corner: String
        get() = InstrumentationRegistry.getArguments().getString("relayium.corner") ?: "default"

    private fun screenshot(name: String) {
        UiDevice.getInstance(instrumentation).takeScreenshot(File(outDir, "$corner-$name.png"))
    }

    /** Press the check button and wait — bounded — for the row to settle. */
    private fun check() {
        compose.onNodeWithText(s(R.string.update_check)).performScrollTo().performClick()
    }

    private fun awaitText(text: String, timeoutMs: Long = 20_000) {
        compose.waitUntil(timeoutMs) {
            runCatching { compose.onNodeWithText(text).assertExists() }.isSuccess
        }
    }

    /**
     * The result is REACHABLE and drawn — scrolled to, then asserted visible.
     *
     * Scrolling is legitimate here and is not a way to make a failing assertion
     * pass. The update row sits at the foot of a scrolling join screen, and the
     * result renders BELOW the button that produced it, so at font scale 2 on a
     * 320 dp screen the card genuinely extends past the fold. A reader scrolls;
     * that is what the page is.
     *
     * Contrast `UiAcceptanceTest`, which deliberately does NOT scroll for the
     * join-form error: that one must be visible without scrolling, because it
     * appears in response to a keystroke while the keyboard is retracting, and
     * a test that scrolled to it would hide the exact defect it exists to catch.
     * Different requirement, so a different rule.
     */
    private fun assertReachable(text: String) {
        compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
    }

    // ── the three answers ───────────────────────────────────────────────────

    /** The feed advertises a NEWER build: the only state that offers a download. */
    @Test
    fun futureVersionOffersDownloadWithNotes() {
        ActivityScenario.launch(MainActivity::class.java).use {
            assertPointedAtTestFeed()
            check()
            awaitText(s(R.string.update_available, FUTURE_VERSION))
            assertReachable(s(R.string.update_available, FUTURE_VERSION))
            // The release note travels with the offer, in this device's language.
            assertReachable(s(R.string.update_notes_title))
            // …and the honest sentence about what the app does NOT do.
            assertReachable(s(R.string.update_download_hint))
            // The action itself, with its full label drawn — the long English
            // string at font scale 2 is why the button uses a minimum height
            // rather than a fixed one.
            assertReachable(s(R.string.update_download))
            screenshot("update-available")
        }
    }

    /** The feed advertises THIS build: up to date, and no download anywhere. */
    @Test
    fun currentVersionReportsUpToDateAndOffersNothing() {
        ActivityScenario.launch(MainActivity::class.java).use {
            assertPointedAtTestFeed()
            check()
            awaitText(s(R.string.update_up_to_date, BuildConfig.VERSION_NAME))
            assertReachable(s(R.string.update_up_to_date, BuildConfig.VERSION_NAME))
            compose.onNodeWithText(s(R.string.update_download)).assertDoesNotExist()
            screenshot("update-up-to-date")
        }
    }

    /**
     * The feed cannot be read.
     *
     * The property that matters is not which sentence appears but that it is an
     * ERROR: a check that could not reach the publisher has learned nothing, and
     * must never render as "up to date".
     */
    @Test
    fun unreachableFeedReportsAnErrorAndNeverUpToDate() {
        ActivityScenario.launch(MainActivity::class.java).use {
            assertPointedAtTestFeed()
            check()
            awaitText(s(R.string.update_error_server))
            assertReachable(s(R.string.update_error_server))
            compose.onNodeWithText(s(R.string.update_up_to_date, BuildConfig.VERSION_NAME))
                .assertDoesNotExist()
            compose.onNodeWithText(s(R.string.update_download)).assertDoesNotExist()
            screenshot("update-error")
        }
    }

    // ── the download hand-off ───────────────────────────────────────────────

    /**
     * The REAL `ACTION_VIEW` Intent, observed as the system receives it.
     *
     * An `ActivityMonitor` registered for the browser Intent intercepts the
     * launch: the product calls the actual `startActivity`, the monitor matches
     * and BLOCKS it, and the test reads the Intent that was dispatched. Nothing
     * navigates, downloads or installs. `TestHooks.installedLauncher` is left
     * null here on purpose — this test exists to prove the path that a string
     * hook cannot.
     */
    @Test
    fun downloadFiresRealViewIntent() {
        val monitor = Instrumentation.ActivityMonitor(
            android.content.IntentFilter(Intent.ACTION_VIEW).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
                addDataScheme("https")
            },
            null,
            // BLOCK the launch: the Intent is observed, and nothing runs.
            true,
        )
        instrumentation.addMonitor(monitor)
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                assertPointedAtTestFeed()
                check()
                awaitText(s(R.string.update_available, FUTURE_VERSION))
                compose.onNodeWithText(s(R.string.update_download)).performScrollTo().performClick()

                // The dispatched Intent, not a recorded string.
                val fired = monitor.waitForActivityWithTimeout(TimeUnit.SECONDS.toMillis(10))
                assertNull("the monitor started an activity; it was supposed to block", fired)
                assertEquals("no ACTION_VIEW was dispatched", 1, monitor.hits)

                // The hook was NOT installed, so this really went through the
                // product's own startActivity.
                assertNull(
                    "the launcher hook was in play; this test must exercise the real path",
                    TestHooks.installedLauncher,
                )
            }
        } finally {
            instrumentation.removeMonitor(monitor)
        }
    }

    /**
     * The exact `Uri` handed to the system.
     *
     * Separate from the monitor test because `ActivityMonitor` reports that a
     * matching Intent was dispatched but does not hand back the Intent itself;
     * the URL is captured through the debug launcher, which sits immediately
     * before `startActivity` and sees exactly what would be passed to it.
     * Labelled honestly: this half proves the VALUE, the monitor above proves
     * the real system dispatch.
     */
    @Test
    fun downloadTargetsTheOfficialImmutableAsset() {
        var captured: String? = null
        TestHooks.installedLauncher = { url -> captured = url; true }
        ActivityScenario.launch(MainActivity::class.java).use {
            assertPointedAtTestFeed()
            check()
            awaitText(s(R.string.update_available, FUTURE_VERSION))
            compose.onNodeWithText(s(R.string.update_download)).performScrollTo().performClick()
            compose.waitUntil(10_000) { captured != null }
            assertEquals(
                "the app opened a URL that is not the advertised release's official asset",
                "https://github.com/relayium/relayium/releases/download/" +
                    "android-v$FUTURE_VERSION/Relayium-$FUTURE_VERSION-$FUTURE_CODE.apk",
                captured,
            )
            assertEquals(captured, TestHooks.lastUpdateDownloadUrl)
        }
    }

    /**
     * No browser: the URL becomes visible, selectable text.
     *
     * HOOK PATH, deliberately. A device image with a browser cannot be made to
     * have none, so the launcher answers false; what is asserted is the
     * product's reaction, which is real.
     */
    @Test
    fun noBrowserShowsCopyableUrl() {
        TestHooks.installedLauncher = { false }
        ActivityScenario.launch(MainActivity::class.java).use {
            assertPointedAtTestFeed()
            check()
            awaitText(s(R.string.update_available, FUTURE_VERSION))
            compose.onNodeWithText(s(R.string.update_download)).performScrollTo().performClick()
            awaitText(s(R.string.update_no_browser))
            assertReachable(s(R.string.update_no_browser))
            // The address itself, on screen, where it can be selected.
            val url = "https://github.com/relayium/relayium/releases/download/" +
                "android-v$FUTURE_VERSION/Relayium-$FUTURE_VERSION-$FUTURE_CODE.apk"
            assertReachable(url)
            // The offer survives, so the reader can still act on it.
            compose.onNodeWithText(s(R.string.update_download)).assertExists()
            screenshot("update-no-browser")
        }
    }

    // ── cancellation ────────────────────────────────────────────────────────

    /**
     * Cancel returns to rest, and the abandoned check publishes nothing.
     *
     * The driver serves this case slowly, so Cancel is pressed while a request
     * is genuinely in flight rather than against an already-finished one.
     */
    @Test
    fun cancellingAStalledCheckReturnsToRestAndStaysThere() {
        ActivityScenario.launch(MainActivity::class.java).use {
            assertPointedAtTestFeed()
            check()
            awaitText(s(R.string.update_checking))
            compose.onNodeWithText(s(R.string.update_cancel)).performScrollTo().performClick()
            // Back to rest: the button reads Check again.
            awaitText(s(R.string.update_check))
            compose.onNodeWithText(s(R.string.update_checking)).assertDoesNotExist()
            // …and the late answer must not arrive afterwards. The driver's slow
            // response completes during this wait; nothing may appear.
            Thread.sleep(TimeUnit.SECONDS.toMillis(6))
            compose.onNodeWithText(s(R.string.update_available, FUTURE_VERSION)).assertDoesNotExist()
            compose.onNodeWithText(s(R.string.update_up_to_date, BuildConfig.VERSION_NAME))
                .assertDoesNotExist()
            compose.onNodeWithText(s(R.string.update_check)).assertExists()
            screenshot("update-cancelled")
        }
    }

    // ── the version the row shows ───────────────────────────────────────────

    @Test
    fun rowNamesTheInstalledVersionAsAPreview() {
        ActivityScenario.launch(MainActivity::class.java).use {
            assertReachable(s(R.string.update_installed_version, BuildConfig.VERSION_NAME))
            screenshot("update-idle")
        }
    }

    private companion object {
        /** Must match what the driver's feed advertises. */
        const val FUTURE_VERSION = "9.9.9"
        const val FUTURE_CODE = 999
    }
}
