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
 * rotation and the system pickers; this class only routes the launch intent.
 *
 * An incoming `https://relayium.com/cross-network#c=…` VIEW intent goes through
 * the SAME [com.relayium.protocol.JoinInput] parser as pasted input: a stored
 * `#k=` link, a foreign origin, or a malformed fragment is refused with the
 * same honest message, never joined. The filter has no autoVerify — there is
 * no assetlinks.json on the server — so on Android 12+ tapping a link opens
 * the BROWSER by default; this filter only matters when the user pastes the
 * link or enables "open supported links" by hand. There is no ACTION_SEND
 * handler in this stage, so sharing a link INTO the app is not a supported
 * entry point and is deliberately not claimed. Nothing here pretends to be a
 * verified App Link either.
 *
 * The launch intent is consumed EXACTLY ONCE. `onCreate` runs again on every
 * ordinary recreation — theme change, split-screen, process-alive restarts
 * the manifest's configChanges list does not cover — with the ORIGINAL intent
 * still attached; re-joining from it there would tear down a live transfer
 * the retained ViewModel is in the middle of. `savedInstanceState != null` is
 * that recreation, so only the genuinely first creation routes it, and a link
 * tapped later arrives through [onNewIntent] (singleTask), where the intent
 * really is new.
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
            joinFromIntent(intent)
        }
    }

    /** launchMode=singleTask: a link tapped while the app is open lands here.
     *  The stored intent is replaced so a later recreation replays THIS one's
     *  absence, not the original launch link. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        joinFromIntent(intent)
    }

    private fun joinFromIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val url = intent.dataString ?: return
        // The parser owns every safety rule (origin, #k= refusal, six ASCII
        // digits with leading zeros preserved); a rejection surfaces on the
        // join form exactly as a pasted rejection would.
        viewModel.join(url)
    }
}
