package com.relayium.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.MediumTest
import androidx.test.platform.app.InstrumentationRegistry
import java.io.FileInputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What the transfer bar actually reports, frame by frame.
 *
 * This is a behaviour test, not a look test. The property under examination is
 * that [SmoothLinearProgress] may only ever ease FORWARD: every other kind of
 * change — a decrease, a new operation, a device with animation turned off —
 * must be shown in the frame it happens.
 *
 * ## Why that is worth a test
 *
 * A plain `animateFloatAsState` interpolates in both directions, so when a
 * batch moves to its next file and the fraction drops from 0.9 to 0.0, the bar
 * spends the animation showing 0.7, 0.5, 0.3 — a claim that the NEW file is
 * most of the way done when nothing of it has been sent. Every number in that
 * sequence is wrong, and it is wrong in the direction that flatters the app.
 *
 * ## How it is observed
 *
 * Through `ProgressBarRangeInfo`, which the indicator publishes into the
 * semantics tree — the same value a screen reader announces. Nothing here reads
 * a pixel or a private field.
 *
 * The test clock is driven manually (`autoAdvance = false`) so each assertion
 * is about a specific frame rather than about wherever the animation happened
 * to be when the assertion ran. Without that, every one of these cases would
 * pass against the defect simply by waiting for it to finish.
 */
@RunWith(AndroidJUnit4::class)
@MediumTest
class SmoothProgressTest {

    @get:Rule
    val compose = createComposeRule()

    private var restoreScale: String? = null

    @Before
    fun freezeTheClock() {
        compose.mainClock.autoAdvance = false
    }

    @After
    fun restoreAnimatorScale() {
        restoreScale?.let { shell("settings put global animator_duration_scale $it") }
        restoreScale = null
    }

    /**
     * The reported fraction in the CURRENT frame.
     *
     * `ProgressBarRangeInfo.current` is the value the composable published, so
     * this reads what the user is being shown rather than what the caller asked
     * for.
     */
    private fun reported(): Float {
        val info = compose.onRoot().fetchSemanticsNode()
            .findProgress() ?: error("no progress indicator in the tree")
        return info.current
    }

    private fun androidx.compose.ui.semantics.SemanticsNode.findProgress(): ProgressBarRangeInfo? {
        config.getOrNull(SemanticsProperties.ProgressBarRangeInfo)?.let { return it }
        for (child in children) child.findProgress()?.let { return it }
        return null
    }

    /** One frame of the app's longest animation, plus a margin. Long enough
     *  that a real tween has certainly finished, so "still not there" can only
     *  mean it never started. */
    private fun settle() = compose.mainClock.advanceTimeBy(Motion.STANDARD * 2L)

    /** Exactly one frame: enough for a snap to be visible and far too little
     *  for a 150ms tween to have arrived. */
    private fun oneFrame() = compose.mainClock.advanceTimeByFrame()

    @Test
    fun growthIsEasedRatherThanTeleported() {
        var fraction by mutableFloatStateOf(0f)
        compose.setContent { RelayiumTheme { SmoothLinearProgress(fraction, operation = "file") } }
        oneFrame()
        assertEquals(0f, reported(), 0.001f)

        fraction = 1f
        // One frame after a jump to full, an eased bar is on its way and has
        // NOT arrived. This is the case the smoothing exists for.
        oneFrame()
        val midway = reported()
        assertTrue("growth must be eased, not teleported; reported $midway", midway < 0.95f)

        settle()
        assertEquals("and it must still arrive", 1f, reported(), 0.01f)
    }

    /**
     * The defect this class was written for: a decrease must SNAP.
     *
     * Against an ordinary `animateFloatAsState` the assertion below reads
     * something near 0.7 one frame after the drop — the new file shown as most
     * of the way through.
     */
    @Test
    fun aDecreaseIsShownImmediatelyAndNeverInterpolatedDownward() {
        var fraction by mutableFloatStateOf(0.9f)
        compose.setContent { RelayiumTheme { SmoothLinearProgress(fraction, operation = "file") } }
        settle()
        assertEquals(0.9f, reported(), 0.01f)

        fraction = 0f
        oneFrame()
        assertEquals(
            "a reset must be reported in the frame it happens, never eased down through" +
                " fractions the new transfer has not reached",
            0f,
            reported(),
            0.001f,
        )
    }

    /**
     * A new operation starts at its own fraction even when that fraction is
     * HIGHER than where the last one stopped.
     *
     * A decrease check alone cannot catch this: 0.2 → 0.5 is an increase, so it
     * would be eased, and for 150ms the second file would be reported at the
     * first file's progress. The operation key is what makes the bar restart
     * rather than continue.
     */
    @Test
    fun aNewOperationStartsAtItsOwnFractionEvenWhenItIsHigher() {
        var fraction by mutableFloatStateOf(0.2f)
        var operation by mutableStateOf("first")
        compose.setContent { RelayiumTheme { SmoothLinearProgress(fraction, operation) } }
        settle()
        assertEquals(0.2f, reported(), 0.01f)

        operation = "second"
        fraction = 0.5f
        oneFrame()
        assertEquals(
            "a different operation is a different bar and starts where it actually is",
            0.5f,
            reported(),
            0.001f,
        )
    }

    /**
     * With the animator duration scale at zero, growth snaps too.
     *
     * The setting is written through the shell, which is what an instrumentation
     * run has the privilege for, and restored in teardown so one case cannot
     * leave the device — or the next test — animation-free.
     *
     * This asserts the whole path, not just the helper: the value is read by an
     * observer in [RelayiumTheme], published through `LocalMotionEnabled`, and
     * turned into a `snap` spec by `uiSpec`.
     */
    @Test
    fun turningAnimationOffMakesGrowthImmediate() {
        restoreScale = shell("settings get global animator_duration_scale")
            .trim()
            .ifBlank { "1.0" }
            .let { if (it == "null") "1.0" else it }
        shell("settings put global animator_duration_scale 0")

        var fraction by mutableFloatStateOf(0f)
        compose.setContent { RelayiumTheme { SmoothLinearProgress(fraction, operation = "file") } }
        oneFrame()

        fraction = 1f
        oneFrame()
        assertEquals(
            "with animation turned off, a change is shown in the frame it happens",
            1f,
            reported(),
            0.001f,
        )
    }

    /** A non-finite fraction — a division by a zero total upstream — is shown
     *  as no progress rather than propagated into the animation, where it would
     *  poison every later value. */
    @Test
    fun aNonFiniteFractionIsTreatedAsNoProgress() {
        compose.setContent {
            RelayiumTheme { SmoothLinearProgress(Float.NaN, operation = "file") }
        }
        settle()
        assertEquals(0f, reported(), 0.001f)
    }

    private fun shell(command: String): String {
        val descriptor = InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .executeShellCommand(command)
        return FileInputStream(descriptor.fileDescriptor).use { String(it.readBytes()) }
    }
}
