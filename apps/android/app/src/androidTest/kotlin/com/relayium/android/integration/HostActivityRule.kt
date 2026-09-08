package com.relayium.android.integration

import android.app.Activity
import android.content.Intent
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.relayium.android.MainActivity
import org.junit.rules.ExternalResource

/**
 * The Activity under test, tracked WITHOUT `ActivityScenario`.
 *
 * ## Why not `ActivityScenario`
 *
 * `ActivityScenario` identifies "its" Activity by comparing the intent it
 * launched with against `activity.getIntent()` — `activityMatchesIntent` in
 * `androidx.test.core`, called first thing in its lifecycle listener, checking
 * action, data, type, package, component and categories.
 *
 * That is incompatible with the behaviour this suite exists to prove.
 * `MainActivity.onNewIntent` calls `setIntent(…)` — correctly, and load-bearing:
 * the stored intent is what a later recreation replays, and replacing it is how
 * a handled share stops being replayed. The moment a real `ACTION_SEND` is
 * delivered, the Activity's intent is no longer the `MAIN` one the scenario
 * launched, the listener stops recognising it, every subsequent lifecycle
 * callback is discarded, and `close()` waits forever for a DESTROYED that the
 * scenario will never observe. The run ends in teardown with the Activity
 * merely PAUSED.
 *
 * The fix belongs here, not in the product. Restoring the original intent after
 * delivery to keep the scenario happy would delete the exact state the replay
 * gate asserts about.
 *
 * ## What this does instead
 *
 * It asks the framework's own lifecycle monitor which `MainActivity` is
 * currently resumed, every time. There is no remembered instance to go stale
 * across a recreation, and no intent comparison anywhere — so what the Activity
 * holds in `getIntent()` is free to be whatever the product decided, which is
 * the point.
 *
 * Teardown finishes whatever is still up and waits for it to actually be gone,
 * so one test's Activity cannot leak into the next.
 *
 * ## This rule must be INNER to the Compose rule
 *
 * `MainActivity.onCreate` calls `setContent`, and a Compose test rule installs
 * the root registry the semantics tree is published into. Launching the
 * Activity before that registry exists composes the content into nothing the
 * test can see, and every assertion afterwards fails with "no compose
 * hierarchies found" — an environment mistake wearing the costume of a product
 * one.
 *
 * So a class using this declares `createEmptyComposeRule()` at `order = 0` and
 * this at `order = 1`: the Compose environment is up before the launch here and
 * still up while teardown runs.
 */
internal class HostActivityRule : ExternalResource() {

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    /**
     * The `MainActivity` that is on screen right now.
     *
     * Resolved on every access rather than captured: a recreation replaces the
     * instance, and a held reference would quietly become the destroyed one —
     * the same class of bug as the scenario's stale identity, arrived at from
     * the other side.
     */
    val activity: MainActivity
        get() = resumed() ?: error("no MainActivity is resumed")

    override fun before() {
        launch()
    }

    override fun after() {
        finishAll()
    }

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
     * Deliver an intent to the RUNNING Activity, through the system.
     *
     * Started from the Activity's own context and without
     * `FLAG_ACTIVITY_NEW_TASK`, so `launchMode=singleTask` routes it to the
     * instance that is already up and the framework calls the real
     * `onNewIntent`. Calling `onNewIntent` directly would test a method rather
     * than the routing the product depends on.
     */
    fun deliver(intent: Intent) {
        val target = activity
        intent.setClass(target, MainActivity::class.java)
        instrumentation.runOnMainSync { target.startActivity(intent) }
        instrumentation.waitForIdleSync()
    }

    /**
     * Recreate the Activity, as a configuration change does.
     *
     * Waits for an instance that is not the one that was there before: a
     * recreation is only complete when the NEW instance is resumed, and
     * asserting against the old one would be asserting about a destroyed
     * object.
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

    /**
     * Recreate the Activity while something else is in front of it.
     *
     * [recreate] waits for RESUMED, which is correct when the app is on screen
     * and WRONG when it is not: a system picker or a permission dialog covering
     * the Activity keeps it out of RESUMED for as long as it is there, so that
     * wait can never be satisfied. What still happens underneath is a real
     * configuration change — the instance is destroyed and a new one CREATED
     * behind the cover — so the new instance reaching CREATED is the signal.
     */
    fun recreateWhileCovered() {
        val previous = currentInstance() ?: error("no MainActivity to recreate")
        val created = java.util.concurrent.CountDownLatch(1)
        val monitor = ActivityLifecycleMonitorRegistry.getInstance()
        val callback = androidx.test.runner.lifecycle.ActivityLifecycleCallback { activity, stage ->
            if (activity is MainActivity && activity !== previous && stage == Stage.CREATED) {
                created.countDown()
            }
        }
        instrumentation.runOnMainSync {
            monitor.addLifecycleCallback(callback)
            previous.recreate()
        }
        try {
            check(created.await(TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                "no new MainActivity was CREATED within ${TIMEOUT_MS}ms while covered"
            }
        } finally {
            instrumentation.runOnMainSync { monitor.removeLifecycleCallback(callback) }
        }
    }

    /**
     * The current instance in ANY live stage.
     *
     * [activity] answers only from RESUMED, which is what a test wants while
     * the app is on screen. This one is for the covered case, where the
     * Activity is real and addressable but deliberately not resumed.
     */
    fun currentInstance(): MainActivity? {
        var found: MainActivity? = null
        instrumentation.runOnMainSync {
            val monitor = ActivityLifecycleMonitorRegistry.getInstance()
            found = Stage.entries
                .filter { it != Stage.DESTROYED }
                .flatMap { monitor.getActivitiesInStage(it) }
                .filterIsInstance<MainActivity>()
                .lastOrNull()
        }
        return found
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
     * `Instrumentation.runOnMainSync` refuses to be called from the main thread
     * — it would deadlock waiting for itself — so a helper that hops internally
     * must never be invoked from inside another hop. Collecting the live
     * Activities is one hop; finishing them is a second, given the list the
     * first returned. Nesting the two threw on every teardown, which is exactly
     * the kind of failure that turns into "the run ended, so it passed".
     *
     * ## A teardown that cannot finish is a FAILURE
     *
     * An Activity that outlives its test carries its ViewModel — the picker
     * lease, the staged share, the account session — into the next one, whose
     * assumptions about its own starting state are then false. Reporting that
     * as a warning and continuing would produce green results for a matrix
     * running against contaminated state. So this throws, and JUnit records it
     * alongside whatever the test itself reported.
     */
    private fun finishAll() {
        // OFF main: this is the test thread, and each call hops once.
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
                "carry the picker lease, staged share and account session into the next test",
        )
    }

    /**
     * Every `MainActivity` in a stage that is not DESTROYED.
     *
     * Every stage, not just RESUMED: a recreation or a dialog can leave an
     * instance paused or stopped, and one that is merely not on screen is still
     * one whose ViewModel is alive.
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
        const val TIMEOUT_MS = 10_000L
        const val POLL_MS = 20L
    }
}
