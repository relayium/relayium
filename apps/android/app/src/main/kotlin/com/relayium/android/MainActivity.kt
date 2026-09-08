package com.relayium.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.relayium.android.ui.RelayiumApp
import com.relayium.android.ui.RelayiumTheme

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
 */
class MainActivity : ComponentActivity() {

    private val viewModel: TransferViewModel by viewModels()

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
        if (savedInstanceState == null) {
            viewModel.deliverIntent(intent)
        }
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
    }

    override fun onStop() {
        super.onStop()
        viewModel.hostStopped(changingConfigurations = isChangingConfigurations)
    }
}
