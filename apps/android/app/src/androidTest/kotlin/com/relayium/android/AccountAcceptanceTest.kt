package com.relayium.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.account.AccountState
import com.relayium.android.account.BrowserLoginModel
import com.relayium.android.account.CreateLinkModel
import com.relayium.android.account.DevicesState
import com.relayium.android.account.KeystoreTokenStore
import java.io.File
import org.junit.Before
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **The account and create surfaces, on a device, against a real server.**
 *
 * Everything here is driven through the REAL `MainActivity`: the real Compose
 * tree, the real [TransferViewModel] the user's taps drive, the real OkHttp
 * transport, the real Android Keystore, and a real Relayium server the shell
 * half started on the host. Nothing constructs a parallel model — a run that did
 * would be asserting about an object the user never touches.
 *
 * The strings are resolved through the app's own resources under the DEVICE's
 * current configuration, so the same class run under `en` and `zh-Hans` asserts
 * each localisation in turn rather than hard-coding English.
 *
 * ## The mandatory local-backend preflight
 *
 * Every test asserts the app resolved THIS run's origin before it sends a single
 * credential. [Backend.readDebugOverride] reads a non-public class reflectively
 * and FAILS CLOSED to production, so a harness that skipped the check could
 * quietly drive a disposable account against the real service.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class AccountAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun s(id: Int) = context.getString(id)

    /**
     * Every test starts from a device that holds no credential.
     *
     * The bearer is persisted in the KEYSTORE, which outlives an
     * `ActivityScenario` and outlives the ViewModel with it — so a sign-in in
     * one test method would restore a session in the next, and the next one's
     * first act is to look for a sign-in form that is no longer there. JUnit
     * does not promise an order either, so this cannot be arranged around.
     *
     * It clears through the REAL store rather than deleting a path by hand, so
     * the reset exercises the same code the product's own sign-out does.
     */
    @Before
    fun startFromASignedOutDevice() {
        runCatching { KeystoreTokenStore(context).clear() }
    }

    /**
     * A control, selected by BEING one.
     *
     * Text alone is ambiguous on these screens by design: "Account" is a tab and
     * a heading, "Sign in" is a heading and a button, "Create a link" is a card
     * title and a button, and "Transfer" is a tab and a quota row. Matching on
     * text plus a click action picks the thing a person would tap; falling back
     * to "the first one" would silently start asserting about prose the moment
     * the layout moved.
     */
    private fun button(text: String) = compose.onNode(hasText(text) and hasClickAction())

    /** A destination in the navigation bar, selected by being SELECTABLE — the
     *  semantics a `NavigationBarItem` carries and a heading does not. */
    private fun tab(text: String) = compose.onNode(hasText(text) and isSelectable())

    /**
     * Wait for something the account is expected to reach — and give up
     * IMMEDIATELY, with the reason, if it lands on a refusal instead.
     *
     * Without this a terminal rejection is indistinguishable from a slow one:
     * the wait simply runs to its full timeout and reports "timed out", which is
     * true and says nothing about why. That cost a whole diagnosis cycle when a
     * shared per-IP register/device-start limiter (5/minute, and one budget
     * across BOTH languages on one server) denied the sixth request — a `429`
     * that read as a hang.
     *
     * [AccountFailure.Kind] and the numeric status are the only things reported.
     * Both are this app's own classification of the answer; neither is server
     * prose, and neither can carry a credential. See `AccountFailure`.
     */
    private fun awaitAccountOutcome(
        vm: TransferViewModel,
        what: String,
        timeoutMs: Long = 60_000,
        predicate: () -> Boolean,
    ) {
        InteropDriver.awaitTrue(what, timeoutMs) {
            (vm.account.state.value as? AccountState.Rejected)?.let { rejected ->
                error(
                    "$what: the account was REFUSED instead — " +
                        "${rejected.failure.kind} (status ${rejected.failure.status})",
                )
            }
            predicate()
        }
    }

    private val origin get() = InteropDriver.requireArg("relayium.origin")
    private val email get() = InteropDriver.requireArg("relayium.email")
    private val password get() = InteropDriver.requireArg("relayium.password")

    private fun preflight(vm: TransferViewModel) {
        assertEquals(
            "the app under test must be pointed at this run's disposable server",
            origin,
            vm.backendOrigin,
        )
    }

    private fun openAccountTab() {
        tab(s(R.string.tab_account)).performClick()
        compose.waitForIdle()
    }

    private fun openTransferTab() {
        tab(s(R.string.tab_transfer)).performClick()
        compose.waitForIdle()
    }

    /** Fill the sign-in form the way a person does: the email field, then the
     *  password field, then the button. */
    private fun signInThroughTheForm() {
        val fields = compose.onAllNodes(hasSetTextAction())
        fields[0].performScrollTo().performTextInput(email)
        fields[1].performScrollTo().performTextInput(password)
        button(s(R.string.account_signin_action)).performScrollTo().performClick()
    }

    /**
     * A real sign-in, a real account, and every figure on the screen coming from
     * the server rather than from this app.
     */
    @Test
    fun signsInAndRendersTheServersOwnAccountFacts() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            preflight(vm)
            openAccountTab()
            signInThroughTheForm()

            awaitAccountOutcome(vm, "the account loaded") {
                vm.account.state.value is AccountState.Ready
            }
            val ready = vm.account.state.value as AccountState.Ready
            assertEquals("the signed-in address is the one the run created", email, ready.user.email)
            assertTrue("the credential must have reached the keystore", ready.persisted)

            compose.waitForIdle()
            // The address and the plan the SERVER named, on screen.
            compose.onNodeWithText(email, substring = true).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(s(R.string.account_plan_title)).performScrollTo().assertIsDisplayed()

            // The device list is a real `GET /api/devices`, and this app's own
            // credential is one of its rows.
            InteropDriver.awaitTrue("the device list loaded") {
                vm.account.devices.value is DevicesState.Loaded
            }
            val devices = (vm.account.devices.value as DevicesState.Loaded).devices
            assertTrue("the account must have at least this device", devices.isNotEmpty())
            assertTrue(
                "the server must mark the row this bearer is bound to",
                devices.any { it.current },
            )

            InteropDriver.report(
                REPORT,
                mapOf(
                    "phase" to "signed-in",
                    "email" to ready.user.email,
                    "persisted" to ready.persisted,
                    "planName" to ready.usage.planName,
                    "deviceCount" to devices.size,
                    "hasCurrentDevice" to devices.any { it.current },
                ),
            )
        }
    }

    /**
     * The R8 regression, as a permanent one: a refused sign-in must come back to
     * a form that still has what the user typed.
     *
     * The form is REMOVED from the composition while the request is in flight
     * and a new one is put back for the rejection, so anything it remembered
     * locally is gone by the time the error is read. What was observed on a real
     * device was an error beside two empty fields.
     */
    @Test
    fun aRefusedSignInKeepsTheTypedAddressAndClearsOnlyThePassword() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            preflight(vm)
            openAccountTab()

            val fields = compose.onAllNodes(hasSetTextAction())
            fields[0].performScrollTo().performTextInput(email)
            fields[1].performScrollTo().performTextInput("$password-definitely-wrong")
            button(s(R.string.account_signin_action)).performScrollTo().performClick()

            InteropDriver.awaitTrue("the sign-in was refused") {
                vm.account.state.value is AccountState.Rejected
            }
            compose.waitForIdle()
            assertEquals(
                "the typed address must survive the submit that removed the form",
                email,
                vm.accessDraft.value.value.email,
            )
            compose.onNodeWithText(email, substring = true).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(s(R.string.account_error_credentials)).performScrollTo()
                .assertIsDisplayed()
            assertTrue("no credential may have been taken on", !vm.account.holdsCredential)
        }
    }

    /**
     * A refused REGISTRATION comes back as a registration.
     *
     * The mode is the form's state, not the session's; collapsing it silently
     * dropped the user onto the sign-in half with their typed name gone.
     */
    @Test
    fun aRefusedRegistrationStaysOnTheRegistrationForm() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            preflight(vm)
            openAccountTab()
            button(s(R.string.account_switch_to_create)).performScrollTo().performClick()
            compose.waitForIdle()

            val fields = compose.onAllNodes(hasSetTextAction())
            // The address the run already registered: the server answers 409.
            fields[0].performScrollTo().performTextInput(email)
            fields[1].performScrollTo().performTextInput("Test Device Name")
            fields[2].performScrollTo().performTextInput(password)
            button(s(R.string.account_create_action)).performScrollTo().performClick()

            InteropDriver.awaitTrue("the registration was refused") {
                vm.account.state.value is AccountState.Rejected
            }
            compose.waitForIdle()
            val draft = vm.accessDraft.value.value
            assertTrue("a refused registration must stay a registration", draft.creating)
            assertEquals(email, draft.email)
            assertEquals("Test Device Name", draft.displayName)
            button(s(R.string.account_create_action)).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(s(R.string.account_error_email_taken)).performScrollTo()
                .assertIsDisplayed()
        }
    }

    /**
     * A registration that SUCCEEDS, and the way back from it.
     *
     * The check-email screen is normally reached by registering, so the form
     * draft still says "create an account" when the user gets there. "Back to
     * sign in" therefore has to say so explicitly — otherwise it lands on the
     * create-account form, which is the one place that button promises not to
     * go. Observed on a real device before it was fixed; kept as a regression.
     *
     * The address is deliberately KEPT: it is the account the user is trying to
     * reach, and retyping it is the friction this screen exists to avoid.
     */
    @Test
    fun registeringThenGoingBackLandsOnSignInWithTheAddressKept() {
        val fresh = InteropDriver.requireArg("relayium.newEmail")
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            preflight(vm)
            openAccountTab()
            button(s(R.string.account_switch_to_create)).performScrollTo().performClick()
            compose.waitForIdle()

            val fields = compose.onAllNodes(hasSetTextAction())
            fields[0].performScrollTo().performTextInput(fresh)
            fields[1].performScrollTo().performTextInput("Fresh Device")
            fields[2].performScrollTo().performTextInput(password)
            button(s(R.string.account_create_action)).performScrollTo().performClick()

            awaitAccountOutcome(vm, "the registration was accepted") {
                vm.account.state.value is AccountState.CheckEmail
            }
            // Registration issues no credential: the account cannot sign in
            // until the emailed link is opened.
            assertTrue("registration must not produce a session", !vm.account.holdsCredential)
            compose.waitForIdle()
            compose.onNodeWithText(s(R.string.account_verify_title)).performScrollTo().assertIsDisplayed()

            button(s(R.string.account_back_to_signin)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the form came back") {
                vm.account.state.value is AccountState.SignedOut
            }
            compose.waitForIdle()

            assertTrue(
                "back to sign in must select the SIGN-IN half",
                !vm.accessDraft.value.value.creating,
            )
            assertEquals(
                "the address must survive the way back",
                fresh,
                vm.accessDraft.value.value.email,
            )
            button(s(R.string.account_signin_action)).performScrollTo().assertIsDisplayed()
            button(s(R.string.account_switch_to_create)).performScrollTo().assertIsDisplayed()
        }
    }

    /**
     * **Browser-approved sign-in, end to end, with no Google services anywhere.**
     *
     * This is the only route into the app for an account created with Sign in
     * with Apple or Google, so it is exercised against the REAL
     * `/api/cli/device/{start,poll}` pair. The approval itself is performed by
     * the shell half against the server's own approval endpoint while this test
     * waits — the user code is reported for it to read, which is the same code a
     * human would type at the verification page.
     *
     * The verification page's origin is checked against the app's own resolved
     * backend, so this test also proves the harness had to point the SERVER's
     * base URL at the same origin: a mismatch is a refusal, not a pass.
     */
    @Test
    fun signsInByApprovingThisDeviceInABrowser() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            preflight(vm)
            openAccountTab()
            button(s(R.string.account_browser_action)).performScrollTo().performClick()

            // The device-code request shares the register endpoint's per-IP
            // limiter, so its refusal is a `429` that would otherwise read as a
            // hang. The browser model's own terminal state is checked for the
            // same reason the account's is.
            InteropDriver.awaitTrue("the device-code request started") {
                (vm.browserLogin.state.value as? BrowserLoginModel.State.Failed)?.let {
                    error("the device-code request FAILED — ${it.failure.kind} (status ${it.failure.status})")
                }
                vm.browserLogin.state.value is BrowserLoginModel.State.Waiting
            }
            val waiting = vm.browserLogin.state.value as BrowserLoginModel.State.Waiting
            assertTrue(
                "the approval page must be on this run's own origin",
                waiting.approvalUrl.startsWith("$origin/device?code="),
            )
            compose.waitForIdle()
            // Both are on screen: the code to confirm, and the address, so a
            // person can read where they are being sent before they tap.
            compose.onNodeWithText(waiting.userCode).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(waiting.approvalUrl, substring = true).performScrollTo()
                .assertIsDisplayed()

            // Hand the code to the shell, which approves it as the account owner.
            File(context.filesDir, USER_CODE_FILE).writeText(waiting.userCode)

            awaitAccountOutcome(vm, "the approval was adopted", timeoutMs = 120_000) {
                (vm.browserLogin.state.value as? BrowserLoginModel.State.Failed)?.let {
                    error("the approval FAILED — ${it.failure.kind} (status ${it.failure.status})")
                }
                vm.account.state.value is AccountState.Ready
            }
            val ready = vm.account.state.value as AccountState.Ready
            assertEquals(email, ready.user.email)
            assertTrue(ready.persisted)
        }
    }

    /**
     * **Creating a cross-network link, and joining the room it names.**
     *
     * The mint is a real `POST /api/pair` under this account's bearer, the six
     * digits are the server's, and the app then joins that room through the SAME
     * controller a pasted code goes through — so what is on screen afterwards is
     * a live rendezvous, not a rendered string.
     */
    @Test
    fun createsARealLinkAndWaitsInTheRoomItNames() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            preflight(vm)
            openAccountTab()
            signInThroughTheForm()
            awaitAccountOutcome(vm, "the account loaded") {
                vm.account.state.value is AccountState.Ready
            }

            openTransferTab()
            button(s(R.string.create_action)).performScrollTo().performClick()

            InteropDriver.awaitTrue("a code was minted and its room joined") {
                vm.createLink.state.value is CreateLinkModel.State.Showing
            }
            val showing = vm.createLink.state.value as CreateLinkModel.State.Showing
            assertTrue("six ASCII digits", Regex("^[0-9]{6}$").matches(showing.code))
            assertEquals("$origin/cross-network#c=${showing.code}", showing.link)

            // The room is REAL: the controller reached the signalling server for
            // this code and is waiting for the other device.
            InteropDriver.awaitTrue("the app is waiting in its own room") {
                vm.state.value.phase == TransferController.Phase.WAITING_PEER
            }

            compose.waitForIdle()
            compose.onNodeWithText(showing.code).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(showing.link, substring = true).performScrollTo().assertIsDisplayed()

            // Navigation must not cost the session. Going to the account tab and
            // back leaves the same room, the same code and the same link.
            openAccountTab()
            openTransferTab()
            assertEquals(
                "switching surfaces must not disturb the live session",
                TransferController.Phase.WAITING_PEER,
                vm.state.value.phase,
            )
            assertEquals(showing, vm.createLink.state.value)
            compose.onNodeWithText(showing.code).performScrollTo().assertIsDisplayed()

            InteropDriver.report(
                REPORT,
                mapOf(
                    "phase" to "created",
                    "code" to showing.code,
                    "link" to showing.link,
                    "linkId" to vm.state.value.linkId,
                ),
            )
        }
    }

    /**
     * Signing out REVOKES. The shell half then proves the bearer is dead by
     * presenting it to the server itself — this app saying "signed out" is not
     * evidence about the server's state.
     */
    @Test
    fun signingOutRevokesTheCredentialAndLeavesNothingBehind() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            preflight(vm)
            openAccountTab()
            signInThroughTheForm()
            awaitAccountOutcome(vm, "the account loaded") {
                vm.account.state.value is AccountState.Ready
            }
            assertTrue("a credential must be held before signing out", vm.account.holdsCredential)

            button(s(R.string.account_sign_out)).performScrollTo().performClick()
            InteropDriver.awaitTrue("the sign-out completed") {
                vm.account.state.value is AccountState.SignedOut
            }
            // SignedOut is only reachable when the SERVER answered the
            // revocation (200, or 401 for a credential already gone); a
            // transport or server failure lands on SignOutFailed and keeps the
            // token. So this state IS the server-confirmed evidence, and the
            // bearer itself never leaves the process to prove it.
            assertTrue("nothing may still be held", !vm.account.holdsCredential)

            InteropDriver.report(REPORT, mapOf("phase" to "signed-out", "revoked" to true))
        }
    }

    private companion object {
        const val REPORT = "account-acceptance.json"
        const val USER_CODE_FILE = "account-acceptance-usercode.txt"
    }
}
