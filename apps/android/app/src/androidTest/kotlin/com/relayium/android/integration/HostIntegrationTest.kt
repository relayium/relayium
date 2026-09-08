package com.relayium.android.integration

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.R
import com.relayium.android.TestHooks
import com.relayium.android.TransferViewModel
import com.relayium.android.account.AccountState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The shared host, driven through the REAL `MainActivity`.
 *
 * Everything here runs against the Activity the user launches, the ViewModel it
 * creates, and the activity-result launchers registered in the real
 * composition — not a `ComponentActivity` hosting one screen. That distinction
 * is the point: the invariants under test are about intents arriving at a real
 * task, a real recreation replaying or not replaying them, and launchers whose
 * registration outlives a destination change. A standalone screen has none of
 * those and would prove none of it.
 *
 * ## What this deliberately does not claim to cover
 *
 * Three gates need something this process cannot produce and belong to the
 * run that owns a device and a backend:
 *
 *  * **A real external share.** Admission refuses this app's own provider by
 *    design, so a genuine file share must come from a separate-UID sender APK.
 *    The text and refusal paths below are real end to end; the file path is
 *    exercised here only as far as admission, and the sender fixture proves the
 *    rest.
 *  * **The camera permission journey.** Revoking `CAMERA`, clearing the user
 *    flags, and answering the system dialog is a device-level sequence. What is
 *    asserted here is that the scanner is reachable and opens ONLY from the
 *    button — the part that lives in this app.
 *  * **A real SAF round trip and the wall-clock lease.** `DocumentsUI` is
 *    another app. The lease's arithmetic and its consequences are asserted here
 *    against the product's own clock seam; Home-pressed-inside-`DocumentsUI` is
 *    a device gate.
 */
@RunWith(AndroidJUnit4::class)
class HostIntegrationTest {

    /**
     * Compose OUTER, the Activity INNER — and that order is load-bearing.
     *
     * `createEmptyComposeRule` installs the test's Compose root registry, and
     * `MainActivity.onCreate` calls `setContent`. Start the Activity first and
     * the content is composed before that registry exists, so every semantic
     * assertion afterwards fails with "no compose hierarchies found" — the
     * whole suite reporting an environment problem as if the app had no UI.
     *
     * So the Compose environment is established around the Activity's entire
     * lifetime: up before it launches, still up while it is torn down.
     */
    @get:Rule(order = 0)
    val compose = createEmptyComposeRule()

    /**
     * The Activity, tracked without `ActivityScenario`.
     *
     * See [HostActivityRule] for why the scenario cannot be used by a suite
     * that delivers real intents: its listener identifies the Activity by
     * comparing intents, and `onNewIntent` + `setIntent` — which the replay
     * gate below depends on — is exactly what makes that comparison stop
     * matching.
     */
    @get:Rule(order = 1)
    internal val host = HostActivityRule()

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun s(id: Int) = context.getString(id)

    private val viewModel: TransferViewModel
        get() = requireNotNull(TestHooks.viewModel) { "the real ViewModel was not registered" }

    @After
    fun clearClock() {
        // The offset is process-wide; a case that moved it must not leave the
        // next one running against a shifted clock.
        TestHooks.pickerClockOffsetMillis = 0L
    }

    // ── five real destinations ──────────────────────────────────────────────

    @Test
    fun everyDestinationIsReachableAndLabelled() {
        // All five, by their own labels, with tab semantics — which is what a
        // screen reader and a user both navigate by. A destination that existed
        // only as an icon, or only after a gesture, would not be here.
        for (label in destinationLabels()) {
            val node = compose.onNode(hasText(label) and isSelectable())
            node.assertExists("the $label destination is missing from the bar")
            // …and is actually REACHABLE. A node that exists but cannot be
            // brought on screen is a destination the user does not have.
            node.reach()
        }
    }

    @Test
    fun everyDestinationOpensItsOwnSurface() {
        // Each one leads somewhere real. The Inbox is the one this host added,
        // and it must reach the actual Device Inbox surface rather than a
        // placeholder: a destination that opens onto nothing is a claim the
        // product does not honour.
        select(R.string.tab_nearby)
        compose.onNodeWithText(s(R.string.nearby_title)).assertIsDisplayed()

        select(R.string.tab_inbox)
        // Signed out, the Inbox says so and offers the way in — the accepted
        // screen's own signed-out card, reached through the real host.
        compose.onNodeWithText(s(R.string.inbox_signed_out_body)).assertIsDisplayed()

        select(R.string.tab_account)
        select(R.string.tab_cloud)
        select(R.string.tab_transfer)
        compose.onNodeWithText(s(R.string.join_title)).assertIsDisplayed()
    }

    @Test
    fun theStoredCredentialIsRestoredWithoutVisitingTheAccountTab() {
        // A cold start lands on Transfer, and most people never open Account.
        // While the restore lived in that screen's `LaunchedEffect`, staying
        // anywhere else left the session on `Restoring` FOREVER: the Inbox
        // never adopted, so it never received; the cloud surfaces looked signed
        // out; and nothing on screen explained any of it.
        //
        // Deliberately asserts only that the restore HAPPENED — the terminal
        // state depends on what this device holds and what the origin answers,
        // and pinning that here would make the case about the environment
        // rather than about the wiring.
        //
        // Nothing below touches the Account destination. That is the point.
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline &&
            viewModel.account.state.value is AccountState.Restoring
        ) {
            Thread.sleep(50)
        }
        assertFalse(
            "the account never left Restoring without the Account tab being opened; the stored " +
                "credential is only read when that screen composes",
            viewModel.account.state.value is AccountState.Restoring,
        )
    }

    // ── the Inbox is app-wide, never tab-owned ──────────────────────────────

    @Test
    fun navigatingBetweenDestinationsNeverDropsTheForegroundClaim() {
        // The iOS scene root calls `inbox.foreground(phase != .background)` from
        // the app root, not from the Inbox screen. This is the Android
        // equivalent asserted directly: switching destinations must not change
        // the one answer both presence claims read, or a sender would be told
        // this device is offline because its owner looked at another tab.
        assertTrue("the app should be foreground while under test", foreground())
        for (label in destinationLabels()) {
            select(label)
            assertTrue("selecting $label dropped the foreground claim", foreground())
        }
    }

    @Test
    fun aConfigurationRecreationDoesNotDropTheForegroundClaim() {
        assertTrue(foreground())
        // A locale or theme change stops the Activity and brings it straight
        // back. Announcing `offline` to central on every one of them would be
        // presence churn describing nothing.
        host.recreate()
        compose.waitForIdle()
        assertTrue("a recreation dropped the foreground claim", foreground())
    }

    // ── the bounded owned-picker lease ──────────────────────────────────────

    @Test
    fun aPickerResultInsideTheLeaseIsAccepted() {
        val token = compose.runOnUiThread { viewModel.pickerLaunched(PickerLease.Claim.PRESENCE) }
        assertEquals(
            PickerLease.Verdict.LIVE,
            compose.runOnUiThread { viewModel.pickerReturned(token) },
        )
    }

    @Test
    fun aPickerResultAfterTheLeaseExpiresIsRefused() {
        val token = compose.runOnUiThread { viewModel.pickerLaunched(PickerLease.Claim.PRESENCE) }
        // The product's own deadline arithmetic against the product's own clock
        // seam — only `now` is shifted, so what is proven is the shipped rule
        // rather than a shortened copy of it.
        TestHooks.pickerClockOffsetMillis = PickerLease.DEFAULT_TIMEOUT_MILLIS + 1_000L
        assertEquals(
            PickerLease.Verdict.EXPIRED,
            compose.runOnUiThread { viewModel.pickerReturned(token) },
        )
    }

    @Test
    fun aLateResultCannotReviveAnOperationTheSweepAlreadyRetired() {
        val token = compose.runOnUiThread { viewModel.pickerLaunched(PickerLease.Claim.PRESENCE) }
        TestHooks.pickerClockOffsetMillis = PickerLease.DEFAULT_TIMEOUT_MILLIS + 1_000L
        // The sweep is what runs when nothing came back at all — the
        // Home-pressed-inside-DocumentsUI journey, which delivers no lifecycle
        // event of its own.
        compose.runOnUiThread {
            assertTrue(viewModel.pickerLease.sweep(Long.MAX_VALUE / 2).isNotEmpty())
        }
        // UNKNOWN, not EXPIRED: the operation was already retired, and a second
        // statement that it timed out would not be true twice.
        assertEquals(
            PickerLease.Verdict.UNKNOWN,
            compose.runOnUiThread { viewModel.pickerReturned(token) },
        )
    }

    @Test
    fun theLeaseSurvivesARecreationWithoutRenewing() {
        val token = compose.runOnUiThread { viewModel.pickerLaunched(PickerLease.Claim.PRESENCE) }
        val deadline = compose.runOnUiThread { viewModel.pickerLease.nextDeadline() }
        assertNotNull(deadline)

        // The recreation that happens behind a picker: the composition is
        // rebuilt and the token restored, while the ViewModel — and therefore
        // the deadline — survives untouched. If the clock restarted here, a
        // user who left through Home during a rotation would get a fresh two
        // minutes for a picker nobody is looking at.
        host.recreate()
        compose.waitForIdle()
        assertEquals(deadline, compose.runOnUiThread { viewModel.pickerLease.nextDeadline() })

        TestHooks.pickerClockOffsetMillis = PickerLease.DEFAULT_TIMEOUT_MILLIS + 1_000L
        assertEquals(
            PickerLease.Verdict.EXPIRED,
            compose.runOnUiThread { viewModel.pickerReturned(token) },
        )
    }

    @Test
    fun aDataOnlyPickerAbandonedInTheBackgroundEndsThePresenceClaim() {
        // The covered state is about the APP being behind one of its own
        // pickers, and EVERY owned picker produces it — `hostStopped` is given
        // an outstanding count, not a claim kind. Withdrawing presence only
        // when a PRESENCE round trip expired therefore left a cloud, Inbox or
        // export picker, abandoned in the background, holding the app
        // "foreground" forever — and with it the Device Inbox's claim to
        // central that this device is listening.
        val token = compose.runOnUiThread { viewModel.pickerLaunched(PickerLease.Claim.DATA) }
        compose.runOnUiThread { viewModel.hostStopped(changingConfigurations = false) }
        // Still present: the app is behind its own picker, which is not leaving.
        assertTrue("an owned picker round trip is not the user leaving", foreground())

        TestHooks.pickerClockOffsetMillis = PickerLease.DEFAULT_TIMEOUT_MILLIS + 1_000L
        compose.runOnUiThread { viewModel.sweepPickerLease() }

        assertEquals(0, compose.runOnUiThread { viewModel.pickerLease.outstandingCount() })
        assertFalse(
            "a DATA-only picker that ran out left the app claiming to be in front of the user",
            foreground(),
        )
        // The coverage is over, but the CHOICE is not thrown away: a DATA round
        // trip claimed nothing to anybody else while it was away, so its answer
        // is still recognised — exactly once — and the account fence decides
        // whether it may be delivered. Only the second delivery is unknown.
        assertEquals(
            PickerLease.Verdict.EXPIRED,
            compose.runOnUiThread { viewModel.pickerReturned(token) },
        )
        assertEquals(
            PickerLease.Verdict.UNKNOWN,
            compose.runOnUiThread { viewModel.pickerReturned(token) },
        )
        // Put the Activity back, so the cases after this one start foreground.
        compose.runOnUiThread { viewModel.hostStarted() }
    }

    @Test
    fun theNearbySurfaceExplainsTheTimeoutWhereItIsRelevant() {
        // The copy belongs on the one surface holding a claim other devices can
        // see, and nowhere else: a timeout notice on the account screen would be
        // explaining a rule that does not apply there.
        select(R.string.tab_nearby)
        compose.onNodeWithText(s(R.string.nearby_picker_timeout)).assertDoesNotExist()
    }

    // ── things arriving from outside ────────────────────────────────────────

    @Test
    fun sharedTextIsStagedAndNothingIsSent() {
        deliver(
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, SHARED_TEXT),
        )

        // The share surface, showing what was actually shared…
        compose.onNodeWithText(s(R.string.share_title)).assertIsDisplayed()
        compose.onNodeWithText(SHARED_TEXT).assertIsDisplayed()
        // …and a destination to CHOOSE. Nothing has been sent: an app that
        // auto-sent on intent delivery would be uploading somebody's message the
        // moment they mis-tapped a share sheet.
        compose.onNodeWithText(s(R.string.share_destination_title)).assertIsDisplayed()
        assertEquals(
            com.relayium.android.TransferController.Phase.IDLE,
            viewModel.state.value.phase,
        )
    }

    @Test
    fun anAccountBoundDestinationIsGatedRatherThanHidden() {
        deliver(
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, SHARED_TEXT),
        )
        // Settled first, so the assertions below describe a decided state rather
        // than one in flight. Bounded, and a real state rather than a sleep.
        //
        // This is NOT what was failing. My earlier diagnosis blamed a race with
        // the eager restore and was wrong: the destination is disabled while
        // signed out BY DESIGN, and waiting for the account to settle only
        // makes that more certain, never less.
        val settled = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < settled &&
            viewModel.account.state.value is AccountState.Restoring
        ) {
            Thread.sleep(50)
        }
        assertFalse(
            "the account never settled, so what the destination should show is undecided",
            viewModel.account.state.value is AccountState.Restoring,
        )
        compose.waitForIdle()

        // Signed out, the Inbox destination is present and says why it cannot be
        // used, with the way to fix it. A hidden control would read as a
        // destination this build does not have.
        //
        // SHOWN AND DISABLED is the whole assertion, so it is stated as such.
        // `reach()` would require it to be enabled — the contract for a control
        // the user is meant to press — and that is the opposite of what this
        // surface promises here (`RelayiumApp`: `enabled = false` when signed
        // out). It failed on correct behaviour until this said what it meant.
        compose.onNodeWithText(s(R.string.share_to_inbox)).bringIntoView().assertIsNotEnabled()
        compose.onNodeWithText(s(R.string.share_needs_account)).assertExists()
        // The way OUT of the gate is a real control and must be pressable, or
        // the surface would be a dead end explaining itself.
        compose.onNode(hasText(s(R.string.share_sign_in)) and hasClickAction()).reach()
    }

    @Test
    fun aStagedShareSurvivesNavigatingAwayAndIsReachableAgain() {
        deliver(
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, SHARED_TEXT),
        )
        select(R.string.tab_account)

        // Held, and reachable. A share the app accepted and then made
        // unreachable would be a grant kept for a screen nobody can get to.
        compose.onNodeWithText(s(R.string.share_banner_text)).assertIsDisplayed()
        compose.onNode(hasText(s(R.string.share_banner_action)) and hasClickAction()).performClick()
        compose.onNodeWithText(s(R.string.share_title)).assertIsDisplayed()
    }

    @Test
    fun discardingAStagedShareReleasesIt() {
        deliver(
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, SHARED_TEXT),
        )
        // Scrolled into view and required to be reachable before the one tap.
        // At 320dp and font 2 the discard control sits below the fold, and a
        // bare `performClick` on an off-screen node is how a test reports "the
        // user discarded it" for something no user could have pressed.
        val discard = compose.onNode(hasText(s(R.string.share_discard)) and hasClickAction())
        discard.reach()
        discard.performClick()
        compose.waitForIdle()

        // Waited for, not assumed: the release happens off the tap's own frame.
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline && viewModel.ingress.staged.value != null) {
            Thread.sleep(50)
        }
        assertNull("the share was still held after discarding", viewModel.ingress.staged.value)
        compose.onNodeWithText(s(R.string.share_banner_text)).assertDoesNotExist()
    }

    @Test
    fun aRecreationDoesNotReplayTheIntentThatWasAlreadyHandled() {
        deliver(
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, SHARED_TEXT),
        )
        val staged = requireNotNull(viewModel.ingress.staged.value)

        host.recreate()
        compose.waitForIdle()

        // `onCreate` runs again with the ORIGINAL intent still attached. The
        // saved-state guard is what stops it being routed a second time: the
        // share the user already dealt with is the SAME staging, not a new one
        // that replaced it.
        val after = requireNotNull(viewModel.ingress.staged.value)
        assertEquals(staged.id, after.id)
        assertEquals(staged.epoch, after.epoch)
    }

    @Test
    fun aLinkForAnotherSiteIsRefusedAndNothingIsJoined() {
        deliver(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://example.com/cross-network#c=123456")))

        // A well-formed code on the WRONG HOST: the refusal under test is the
        // origin, so the fragment must be valid or the case would pass for the
        // wrong reason.
        // The refusal names the condition and never quotes the input.
        compose.onNodeWithText(s(R.string.ingress_refused_foreign_origin)).assertIsDisplayed()
        assertEquals(
            com.relayium.android.TransferController.Phase.IDLE,
            viewModel.state.value.phase,
        )
        assertFalse(
            "a refused link must not prefill the join field",
            viewModel.joinDraft.value.isNotEmpty(),
        )
    }

    @Test
    fun aValidJoinLinkPrefillsAndDoesNotConnect() {
        deliver(
            Intent(
                Intent.ACTION_VIEW,
                android.net.Uri.parse("${com.relayium.protocol.JoinInput.DEFAULT_ORIGIN}/cross-network#c=123456"),
            ),
        )

        // `#c=` is the shipped fragment form — `PairCode`/`JoinInput` refuse a
        // bare `#123456` as a link with no code in it. A fixture in the wrong
        // format would have asserted the prefill path while actually exercising
        // the refusal one.
        // Prefilled, and nothing more. The vocabulary the coordinator speaks has
        // no case that could start a connection — the behaviour this replaced
        // called `join(url)` on any ACTION_VIEW and tore down whatever transfer
        // was running.
        assertEquals("123456", viewModel.joinDraft.value)
        assertEquals(
            com.relayium.android.TransferController.Phase.IDLE,
            viewModel.state.value.phase,
        )
    }

    // ── the scanner ─────────────────────────────────────────────────────────

    @Test
    fun theScannerOpensOnlyFromItsOwnButton() {
        select(R.string.tab_transfer)
        // Nothing has asked for the camera: the sheet is not on screen at
        // launch, which is what makes the permission prompt arrive attached to
        // the thing that needs it rather than to opening the app.
        compose.onNodeWithText(s(R.string.scan_title)).assertDoesNotExist()

        compose.onNode(hasText(s(R.string.scan_open)) and hasClickAction()).reach().performClick()
        compose.onNodeWithText(s(R.string.scan_title)).assertIsDisplayed()
        // The manual six-digit path is offered in every scanner state, so the
        // full path is never blocked by the shortcut.
        compose.onNodeWithText(s(R.string.scan_manual)).assertExists()
    }

    // ── the corner this run is actually in ──────────────────────────────────

    @Test
    fun theConfigurationCornerTheHarnessAskedForIsTheOneUnderTest() {
        // A shell command returning 0 says a setting was ACCEPTED, not that the
        // app is running under it. An app-locale override that silently failed
        // to apply, a density the window manager clamped, or a font scale the
        // device ignored would each leave the harness reporting a corner it
        // never entered — and the five-destination bar's whole reason for
        // having two forms is what happens at 320dp and font 2.
        //
        // So the expectation is handed in by the owning script and asserted
        // against what the Activity's own configuration reports.
        val arguments = InstrumentationRegistry.getArguments()
        val expectedLocale = requireNotNull(arguments.getString("relayium.expect.locale")) {
            "run this through scripts/android-host-acceptance.sh: it supplies the corner this asserts"
        }
        val expectedNight = requireNotNull(arguments.getString("relayium.expect.night"))
        val expectedFont = requireNotNull(arguments.getString("relayium.expect.font")).toFloat()
        val expectedDp = requireNotNull(arguments.getString("relayium.expect.dp"))

        val configuration = host.activity.resources.configuration

        assertEquals(
            "the app is not running under the locale the harness set",
            expectedLocale,
            configuration.locales.get(0).toLanguageTag(),
        )
        assertEquals(
            "the app is not running under the font scale the harness set",
            expectedFont,
            configuration.fontScale,
            0.01f,
        )
        val night = configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK
        assertEquals(
            "the app is not running under the night mode the harness set",
            if (expectedNight == "yes") {
                android.content.res.Configuration.UI_MODE_NIGHT_YES
            } else {
                android.content.res.Configuration.UI_MODE_NIGHT_NO
            },
            night,
        )
        if (expectedDp != "any") {
            assertEquals(
                "the app is not running at the width the harness set",
                expectedDp.toInt(),
                configuration.smallestScreenWidthDp,
            )
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun destinationLabels() = listOf(
        s(R.string.tab_transfer),
        s(R.string.tab_nearby),
        s(R.string.tab_inbox),
        s(R.string.tab_cloud),
        s(R.string.tab_account),
    )

    private fun foreground(): Boolean = compose.runOnUiThread { viewModel.foreground.value }

    private fun select(id: Int) = select(s(id))

    /**
     * Select a destination the way a person can actually reach it.
     *
     * Existing in the tree is not reachability. At 320dp and font scale 2 the
     * bar is its scrolling form, and a destination past the right edge is
     * composed, counted and completely untappable — so the node is scrolled
     * into view, required to be DISPLAYED and ENABLED, and only then clicked
     * once. A bare `performClick` on an off-screen node is exactly the check
     * that would let the fifth destination become unreachable without failing.
     */
    private fun select(label: String) {
        compose.onNode(hasText(label) and isSelectable()).reach().performClick()
        compose.waitForIdle()
    }

    /**
     * Deliver an intent to the RUNNING Activity, the way the system does when
     * the app is already open.
     *
     * `singleTask` means a share sent to a live app lands in `onNewIntent`, not
     * in a second `onCreate`. Driving it through the real Activity is what makes
     * this a test of the shipped routing rather than of a direct ViewModel call.
     */
    private fun deliver(intent: Intent) {
        host.deliver(intent)
        compose.waitForIdle()
    }

    private companion object {
        const val SHARED_TEXT = "relayium acceptance shared text"
    }
}
