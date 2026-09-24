package com.relayium.android

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.relayium.android.ui.RelayiumApp
import com.relayium.android.ui.RelayiumTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The single Activity. All state lives in [TransferViewModel], which survives
 * rotation and the system pickers; this class only routes intents into the
 * accepted ingress boundary.
 *
 * ## Everything from outside crosses one boundary
 *
 * `ACTION_VIEW`, `ACTION_SEND` and `ACTION_SEND_MULTIPLE` all go to
 * [TransferViewModel.deliverIntent], which hands them to
 * `IngressIntents.read` and then to the one `IngressCoordinator`. Nothing here
 * parses a URL, reads an extra, or decides what an intent means — which is the
 * point. The behaviour this replaced called `viewModel.join(url)` for any
 * `ACTION_VIEW`, so a tapped link tore down whatever transfer was running with
 * no confirmation. The coordinator's vocabulary has no case that can join,
 * download or send: a link prefills a field and selects a screen, and the
 * transfer stays a tap.
 *
 * A share is staged as REFERENCES — nothing is opened, copied or read — and
 * waits for the user to choose a destination. There is no path on which
 * receiving an intent sends anything.
 *
 * ## The launch intent is consumed EXACTLY ONCE
 *
 * `onCreate` runs again on every ordinary recreation — a locale change,
 * split-screen, a configuration the manifest's `configChanges` does not cover —
 * with the ORIGINAL intent still attached. Routing it again there would replay
 * a share the user has already dealt with, or re-select a screen they have
 * since left. `savedInstanceState != null` is exactly that recreation, so only
 * the genuinely first creation routes the launch intent; anything tapped later
 * arrives through [onNewIntent] (`singleTask`), where the intent really is new.
 *
 * After process death the guard means the app comes back with nothing pending,
 * which is the truthful outcome: the staged references and their grants died
 * with the process, and nothing here reconstructs them.
 *
 * ## The link filter is deliberately unverified
 *
 * There is no `assetlinks.json` on the production origin, so the `VIEW` filter
 * has no `autoVerify`: on Android 12+ tapping a link opens the BROWSER, and
 * this filter matters when the user pastes the link or turns on "open supported
 * links" by hand. Nothing here pretends to be a verified App Link. The share
 * filters have no such caveat — `ACTION_SEND` needs no domain verification —
 * and a share is a real, complete entry point in this build.
 *
 * ## The screen is held awake by THIS window, for as long as there is work
 *
 * See [com.relayium.android.integration.TransferAwakePolicy] for why a screen
 * timeout was ending live transfers and why the fix belongs here rather than in
 * the presence rule. The mechanics are the part this class owns: the flag is
 * applied only between `ON_START` and `ON_STOP`, from a scope created at start
 * and cancelled at stop, and it is cleared on the way out of BOTH.
 */
class MainActivity : ComponentActivity() {

    private val viewModel: TransferViewModel by viewModels()

    /**
     * Collects the keep-awake answer while this Activity is on screen.
     *
     * Its own scope, created in `onStart` and cancelled in `onStop`, rather than
     * a ViewModel-scoped collection: the flag belongs to a WINDOW, and the
     * ViewModel outlives this one across a recreation. A collection that
     * outlived the window would be writing into the flags of an Activity that is
     * no longer there.
     */
    private var awakeScope: CoroutineScope? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A no-op in release; the debug variant lets the instrumentation
        // acceptance observe the REAL ViewModel this Activity drives.
        TestHooks.register(viewModel)
        enableEdgeToEdge()
        setContent {
            RelayiumTheme {
                RelayiumApp(viewModel)
            }
        }
        if (routesLaunchIntent(restored = savedInstanceState != null, flags = intent?.flags ?: 0)) {
            viewModel.deliverIntent(intent)
        }
    }

    companion object {
        /**
         * Whether `onCreate` should route the intent the Activity was created
         * with. Two cases must NOT, because in both the intent is not new:
         *
         *  - a recreation (`savedInstanceState != null`), see the class doc;
         *  - a relaunch from Recents (A32 D3). A share that cold-launched this
         *    `singleTask` Activity became its task's BASE intent. After the user
         *    discarded it and backed out — which finishes the Activity, since a
         *    SEND-rooted task is not a launcher root — opening the task from
         *    Recents creates the Activity afresh with that same base intent and
         *    `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`, and no saved state. Routing
         *    it staged the discarded share again (reproduced on an API 36
         *    emulator, 2026-09-23).
         */
        internal fun routesLaunchIntent(restored: Boolean, flags: Int): Boolean =
            !restored && (flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
    }

    /** `launchMode=singleTask`: a link tapped, or a share sent, while the app is
     *  open lands here. The stored intent is replaced so a later recreation
     *  replays THIS one's absence, not the original launch intent. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        viewModel.deliverIntent(intent)
    }

    /**
     * The two lifecycle facts the presence claims are computed from.
     *
     * Reported from the Activity rather than observed inside the composition
     * because `isChangingConfigurations` is the Activity's own answer, and
     * because a claim made to another device must not depend on whether a
     * particular composable happened to be in the tree.
     */
    override fun onStart() {
        super.onStart()
        viewModel.hostStarted()
        // `Main.immediate`, so a value already in the flow is applied without a
        // dispatch: an Activity restarted while a transfer is running must come
        // back holding the flag, not one frame later.
        val scope = CoroutineScope(Dispatchers.Main.immediate)
        awakeScope = scope
        scope.launch { viewModel.keepScreenAwake.collect(::keepScreenOn) }
    }

    override fun onStop() {
        super.onStop()
        // Released BEFORE the presence report, and unconditionally: whatever the
        // last collected value was, a window that is not on screen holds no
        // claim on the display. The system would drop the effect anyway; saying
        // so here means the flag's lifetime is readable in one place.
        awakeScope?.cancel()
        awakeScope = null
        keepScreenOn(false)
        viewModel.hostStopped(changingConfigurations = isChangingConfigurations)
    }

    /**
     * `onStop` always precedes `onDestroy`, so this is belt and braces rather
     * than a second release path — and it is kept because "the flag is cleared
     * when this Activity goes away" should be true by inspection, not by
     * reasoning about lifecycle ordering.
     */
    override fun onDestroy() {
        super.onDestroy()
        awakeScope?.cancel()
        awakeScope = null
        keepScreenOn(false)
    }

    private fun keepScreenOn(hold: Boolean) {
        if (hold) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
}
