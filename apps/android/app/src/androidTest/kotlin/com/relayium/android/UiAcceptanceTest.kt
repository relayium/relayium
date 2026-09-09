package com.relayium.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * UI acceptance that needs NO peer and NO server: the join form's visible
 * validation and the launch-intent/recreation lifecycle, against the real
 * `MainActivity` and its real Compose tree.
 *
 * Locale-portable on purpose: every expected string is resolved through the
 * app's own resources under the DEVICE's current configuration, so the same
 * class run under `en` and `zh-Hans` (the driver switches the emulator's
 * per-app locale between runs) asserts each localisation in turn instead of
 * hard-coding English.
 *
 * The join test here presses the real Connect button over an INVALID code, so
 * no join ever leaves the device. The lifecycle test DOES join — but only after
 * a real tap on Connect, because a launch link now prefills rather than joins —
 * and therefore refuses to run unless the app's resolved backend is the origin
 * the driver announced — the same fail-closed preflight the interop
 * acceptance runs, so a reflective override that quietly fell back to
 * production can never send even one stray join there.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class UiAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun s(id: Int) = context.getString(id)

    /**
     * Assert an error is DISPLAYED, but wait for it — bounded — first.
     *
     * The product hides the soft keyboard on submit (the R16 fix), and that
     * hide is ASYNCHRONOUS: the IME animates out over several frames, and until
     * it does, a supporting-text error at a large font (zh, font 2) can be
     * under the retracting keyboard. A bare `assertIsDisplayed` immediately
     * after the click RACES that animation. Waiting for the error to actually
     * come into view tests the real behaviour without masking it — there is no
     * `performScrollTo` and no forced keyboard dismissal here, either of which
     * WOULD hide a genuine product defect where the error stays invisible. If
     * it never displays within the bound, that IS such a defect: a screenshot
     * is captured before the Activity closes, and the assertion fails.
     */
    private fun assertDisplayedEventually(errorText: String) {
        try {
            compose.waitUntil(8_000) {
                runCatching { compose.onNodeWithText(errorText).assertIsDisplayed() }.isSuccess
            }
        } catch (t: Throwable) {
            captureScreenshot("error-not-displayed")
            // Re-assert so the failure is the precise "not displayed" one, with
            // the node's own diagnostics, rather than a bare wait timeout.
            compose.onNodeWithText(errorText).assertIsDisplayed()
            throw t
        }
        compose.onNodeWithText(errorText).assertIsDisplayed()
    }

    /** Best-effort screenshot into the app's OWN internal files dir, so a
     *  persistent invisible-error failure leaves visual evidence the runner can
     *  pull with `run-as`. Shared storage is deliberately NOT used: this app has
     *  no storage permission, so a write there is denied — capturing to a path
     *  the process cannot write would be a screenshot promised but never made. */
    private fun captureScreenshot(tag: String) {
        runCatching {
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                .takeScreenshot(File(context.filesDir, "ui-acceptance-$tag.png"))
        }
    }

    /** R16's observed failure, as a permanent regression: five digits, submit,
     *  and the digits error must be VISIBLE — not rendered below a keyboard
     *  that swallowed the only feedback. Submit hides the keyboard first, so
     *  displayed-ness here is the product behaviour under test. */
    @Test
    fun invalidCodeRevealsItsErrorAfterSubmit() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            compose.onNode(hasSetTextAction()).performTextInput("12345")
            submit()
            // Prove the submit actually ran VALIDATION — not an off-screen no-op
            // click on a Connect button the IME pushed below the fold, which is
            // how this read as "no error" with the keyboard still up.
            InteropDriver.awaitTrue("submit reached validation") {
                vm.joinError.value != null
            }
            // Only now is a display race even possible; wait for it, bounded.
            assertDisplayedEventually(s(R.string.join_error_digits))
            // The error clears the moment the user edits — a sticky error over
            // corrected input would read as a dead form.
            compose.onNode(hasSetTextAction()).performScrollTo().performTextInput("6")
            compose.onNodeWithText(s(R.string.join_error_digits)).assertDoesNotExist()
        }
    }

    /** The empty-input rejection, same visibility contract. */
    @Test
    fun emptyCodeRevealsItsErrorAfterSubmit() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            submit()
            InteropDriver.awaitTrue("submit reached validation") { vm.joinError.value != null }
            assertDisplayedEventually(s(R.string.join_error_empty))
        }
    }

    /** Press Connect the way a person does: bring the action into view first.
     *  With the soft keyboard open, the button can sit BELOW the visible
     *  viewport, and a click on an off-screen node never reaches it — so the
     *  submit silently does nothing. Scrolling to the ACTION is legitimate;
     *  scrolling the error after submit, or force-hiding the IME, would mask the
     *  very visibility this test exists to check. */
    private fun submit() {
        compose.onNodeWithText(s(R.string.join_action)).performScrollTo().performClick()
    }

    /**
     * A launch link PREFILLS; the join is the user's own tap; recreation
     * replays neither.
     *
     * This test previously asserted that an `ACTION_VIEW` launch joined inside
     * `onCreate`. That was true of the build it was written against and is the
     * exact behaviour 0.2 removed: `MainActivity.joinFromIntent` used to call
     * `viewModel.join(url)` for any VIEW intent, so a tapped link replaced a
     * running transfer with no confirmation. `IngressCoordinator` cannot join
     * at all now — structurally, not by convention — and `applyIngressLink`
     * resolves `IngressRequest.PrefillCode` to a write into `_joinDraft` and
     * nothing else. So the old assertion was demanding the app re-acquire a
     * defect, and it timed out waiting for a join that must never happen.
     *
     * The lifecycle worth testing is the real one, in four steps:
     *
     *  1. the origin preflight, BEFORE any external intent;
     *  2. the cold VIEW launch prefills the field and does NOT join;
     *  3. a real tap on the real Connect button is what joins;
     *  4. recreation does not re-consume the link into a second JOIN.
     *
     * The origin preflight stays first and stays deliberate. If a reflective
     * override fell back to production, a VIEW launch would reach THERE inside
     * `onCreate`, before any assertion could run, and a post-launch check
     * cannot un-send that. A plain launcher intent has no such leak, so it is
     * the safe place to prove the resolved backend is this run's local origin.
     * That guard matters MORE now, not less: step 3 deliberately does join.
     *
     * "Joined" is a non-zero controller link id, and "no replay" is that
     * captured id staying UNCHANGED. The ids are monotonic but `join` closes
     * any prior session first, so the first id is not necessarily 1 — the
     * captured value is what a replay would move, never a literal.
     */
    @Test
    fun aLaunchLinkPrefillsThenJoinsOnlyOnConsentAndRecreationDoesNotReplay() {
        val expectedOrigin = InteropDriver.requireArg("relayium.origin")

        // STEP 1 — a plain launcher intent joins NOTHING and prefills nothing,
        // and it is where the origin is proven local. Doing this before any
        // ACTION_VIEW is the whole point: a VIEW launch against a fallen-back
        // backend could reach production inside onCreate, and no post-launch
        // assertion could recall it.
        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            assertEquals(
                "the app must resolve this run's throwaway origin before any link is delivered",
                expectedOrigin, vm.backendOrigin,
            )
            Thread.sleep(500)
            assertEquals("a launch without a link must not join", 0, InteropDriver.state(vm).linkId)
            assertEquals(
                "a launch without a link must not prefill the join field",
                "", vm.joinDraft.value,
            )
        }

        // STEP 2 — only now, with the backend proven local in this very
        // process, deliver the cold ACTION_VIEW launch. It may NAVIGATE and
        // PREFILL, and it may not do anything else.
        //
        // The link is built from THIS RUN'S origin, not from a hard-coded
        // `relayium.com`. That was the test's second stale assumption and the
        // actual cause of the hosted timeout: `IngressLinkPolicy` takes its
        // `trustedOrigin` from `Backend`'s resolved origin — deliberately, so
        // the policy cannot drift from the origin the app really talks to —
        // and this harness overrides that to a disposable loopback. A
        // relayium.com link is therefore FOREIGN_ORIGIN here and is refused
        // before anything acts on it, so the old test waited forever for a
        // join that the policy had already, correctly, rejected. Hard-coding
        // the production host would also make the assertion pass only on a
        // build pointed at production, which is the one thing the preflight
        // above exists to forbid.
        val view = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse("$expectedOrigin/cross-network#c=123456"))
        ActivityScenario.launch<MainActivity>(view).use { scenario ->
            val vm = InteropDriver.viewModel()
            assertEquals(
                "even the VIEW launch must be local; the prop was proven, this re-reads it",
                expectedOrigin, vm.backendOrigin,
            )

            // The link's ONLY write: the code lands in the field the user then
            // presses Connect on. Asserted positively, so "no join" below
            // cannot pass merely because the intent was dropped on the floor —
            // which would be a different defect wearing the same green.
            InteropDriver.awaitTrue("the launch link prefilled the join field") {
                vm.joinDraft.value == "123456"
            }

            // And it must NOT join. A negative claim, so it gets a bounded
            // window rather than an instant read: an autojoin regression would
            // post within milliseconds of onCreate, well inside this.
            Thread.sleep(1_500)
            assertEquals(
                "an ACTION_VIEW launch must not join before the user has confirmed",
                0, InteropDriver.state(vm).linkId,
            )

            // STEP 3 — consent, as a person gives it: a real tap on the real
            // Connect button in the real Compose tree. This is the only thing
            // in the whole test that may start a session.
            submit()
            InteropDriver.awaitTrue("the tap on Connect started the join") {
                InteropDriver.state(vm).linkId != 0
            }
            val joinedLink = InteropDriver.state(vm).linkId

            // STEP 4 — recreation (savedInstanceState != null) must not replay
            // the link into a second JOIN, which would tear down the live
            // session the retained ViewModel holds.
            //
            // Scope note, because the obvious extra assertion here is a trap.
            // This does NOT also prove the PREFILL was not replayed, and a
            // `joinDraft` check after `recreate()` would not prove it either:
            // `join` deliberately leaves the draft alone (see
            // `TransferViewModel.join` — it clears the error and retires a
            // minted code, and never touches `_joinDraft`), so the field still
            // reads "123456" at this point. A replayed `PrefillCode` would
            // write that same value over itself and the assertion could never
            // fail — vacuously green, and worse than absent, because it would
            // read as coverage. Proving prefill non-replay needs the draft to
            // DIFFER from the link's code first, which means editing the field
            // after consent, and the join screen is gone by then. Left out on
            // purpose rather than faked.
            scenario.recreate()
            InteropDriver.awaitTrue("the recreated Activity re-registered its ViewModel") {
                TestHooks.viewModel != null
            }
            assertTrue(
                "recreation must reuse the SAME ViewModel, not build a second session owner",
                TestHooks.viewModel === vm,
            )
            Thread.sleep(1_500)
            assertEquals(
                "recreation must not re-consume the launch link — the session's identity is unchanged",
                joinedLink, InteropDriver.state(vm).linkId,
            )
        }
    }
}
