package com.relayium.android.integration

import android.app.Activity
import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.UiDevice
import com.relayium.android.MainActivity
import org.junit.rules.ExternalResource

/**
 * The Activity under test for the LIVE Inbox lane, with a real Home key.
 *
 * ## Why this is not `HostActivityRule`
 *
 * `HostActivityRule` belongs to the shared-host writer and is being corrected
 * while this lane is authored. Depending on it would couple a live acceptance
 * that root runs against a NEWER host to a helper whose behaviour moved
 * underneath it, and the first symptom would be a teardown failure attributed
 * to the Inbox. So this lane owns its own, under the `HostInboxLive*` fence.
 *
 * The identity technique is deliberately the same as that rule's, and for the
 * same reason: `ActivityScenario` recognises "its" Activity by comparing the
 * launch intent against `activity.getIntent()`, and `MainActivity.onNewIntent`
 * calls `setIntent(…)`. One real share delivery and the scenario stops seeing
 * lifecycle callbacks entirely. Asking the framework's lifecycle monitor which
 * `MainActivity` is resumed, every time, has no remembered instance to go stale
 * and no intent comparison to break.
 *
 * ## What this adds that an offline rule does not need
 *
 * The live lane asserts that leaving the app WITHDRAWS receiving and that
 * coming back restores the chosen policy. That is a real Home key and a real
 * return through the launcher — [background] and [foreground] — because the
 * product gates on the process's actual foreground state and a synthetic
 * `onPause` would prove the callback rather than the behaviour.
 */
internal class HostInboxLiveActivity : ExternalResource() {

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val device: UiDevice get() = UiDevice.getInstance(instrumentation)

    /**
     * The `MainActivity` on screen right now.
     *
     * Resolved on every access. A recreation replaces the instance, and a held
     * reference would quietly become the destroyed one.
     */
    val activity: MainActivity
        get() = resumed() ?: error("no MainActivity is resumed")

    override fun before() = launch()

    override fun after() = finishAll()

    /** Start the app the way the launcher does. */
    fun launch() {
        val intent = Intent(instrumentation.targetContext, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        instrumentation.startActivitySync(intent)
        awaitResumed("the app did not start")
    }

    /**
     * Really leave the app, and do not return until the framework agrees.
     *
     * Waiting for NO resumed `MainActivity` rather than sleeping: the policy
     * assertion that follows is about what the product does once it is actually
     * in the background, and a fixed pause would sometimes assert it while the
     * app was still on screen.
     */
    fun background() {
        device.pressHome()
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (resumed() == null) {
                instrumentation.waitForIdleSync()
                return
            }
            Thread.sleep(POLL_MS)
        }
        error("the app was still resumed ${TIMEOUT_MS}ms after Home")
    }

    /**
     * Come back the way a person does — through the launcher.
     *
     * **Not `startActivitySync`, and not [launch].** That call blocks on an
     * `ActivityMonitor` waiting for an Activity to be CREATED, and
     * `MainActivity` is `launchMode="singleTask"`: an instance that Home merely
     * stopped is brought back to the front and never created again. The monitor
     * therefore never fires and the call sits until its own timeout — observed
     * as a 45s hang on this leg, reported as a launch failure when the app had
     * in fact returned perfectly well.
     *
     * Starting from the target context and waiting for the framework's own
     * lifecycle monitor to report RESUMED covers both outcomes: the instance
     * that came back, and a genuinely new one had the system destroyed it.
     */
    fun foreground() {
        val intent = Intent(instrumentation.targetContext, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        instrumentation.targetContext.startActivity(intent)
        awaitResumed("the app did not come back to the foreground")
    }

    /**
     * Recreate the Activity, as a configuration change does.
     *
     * Waits for an instance that is not the previous one: a recreation is only
     * complete when the NEW instance is resumed, and asserting against the old
     * one is asserting about a destroyed object.
     */
    fun recreate() {
        val previous = activity
        instrumentation.runOnMainSync { previous.recreate() }
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val current = resumed()
            if (current != null && current !== previous) {
                instrumentation.waitForIdleSync()
                return
            }
            Thread.sleep(POLL_MS)
        }
        error("the Activity was not recreated within ${TIMEOUT_MS}ms")
    }

    private fun resumed(): MainActivity? {
        var found: MainActivity? = null
        instrumentation.runOnMainSync {
            found = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<MainActivity>()
                .firstOrNull()
        }
        return found
    }

    private fun awaitResumed(what: String) {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (resumed() != null) {
                instrumentation.waitForIdleSync()
                return
            }
            Thread.sleep(POLL_MS)
        }
        error("$what within ${TIMEOUT_MS}ms")
    }

    /**
     * Finish every `MainActivity` still alive, and wait until they are gone.
     *
     * ## Every main-thread hop is made from OFF the main thread
     *
     * `Instrumentation.runOnMainSync` refuses to be called from the main thread,
     * so a helper that hops internally must never run inside another hop.
     * Collecting the live Activities is one hop; finishing them is a second,
     * given the list the first returned.
     *
     * ## A teardown that cannot finish is a FAILURE
     *
     * This lane runs one method per `am instrument` invocation, so a leaked
     * Activity does not reach a sibling test — but it does reach the NEXT
     * invocation through a process that never went idle, carrying the account
     * session and the staged share with it. Reporting that as a warning would
     * produce green legs against contaminated state.
     */
    private fun finishAll() {
        // OFF main: this is the test thread, and each call below hops once.
        val alive = liveActivities()
        if (alive.isNotEmpty()) {
            instrumentation.runOnMainSync { alive.forEach { it.finish() } }
        }
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (liveActivities().isEmpty()) {
                instrumentation.waitForIdleSync()
                return
            }
            Thread.sleep(POLL_MS)
        }
        error(
            "a MainActivity was still alive ${TIMEOUT_MS}ms after finish(); its ViewModel would " +
                "carry the account session and staged share into the next invocation",
        )
    }

    /**
     * Every `MainActivity` in a stage that is not DESTROYED.
     *
     * Every stage, not just RESUMED: a recreation or a dialog can leave an
     * instance paused or stopped, and one that is merely off screen is still one
     * whose ViewModel is alive.
     *
     * MUST be called from off the main thread; it hops once, itself.
     */
    private fun liveActivities(): List<Activity> {
        val out = ArrayList<Activity>()
        instrumentation.runOnMainSync {
            val monitor = ActivityLifecycleMonitorRegistry.getInstance()
            for (stage in Stage.entries) {
                if (stage == Stage.DESTROYED) continue
                out += monitor.getActivitiesInStage(stage).filterIsInstance<MainActivity>()
            }
        }
        return out
    }

    private companion object {
        const val TIMEOUT_MS = 15_000L
        const val POLL_MS = 20L
    }
}
