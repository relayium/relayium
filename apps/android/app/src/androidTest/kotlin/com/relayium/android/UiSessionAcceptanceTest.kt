package com.relayium.android

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.requireArg
import com.relayium.android.InteropDriver.sha256
import com.relayium.android.InteropDriver.state
import com.relayium.protocol.TextLaneSession
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The UI half of the interop acceptance: the SAME live browser peer, but every
 * consequential step goes through the REAL user surface — the join form, the
 * Accept button, the SYSTEM DocumentsUI folder picker, the SYSTEM file picker,
 * and an Activity recreation in the middle of the live session.
 *
 * `InteropAcceptanceTest` deliberately stubs exactly one thing: the picker UI,
 * because the grant a same-uid provider gives is the grant the picker would
 * return. That leaves one honest gap — whether the app's real launch-picker →
 * DocumentsUI → grant → resume round-trip works, with the identity fences the
 * UI carries across it — and this class is that gap's evidence. It drives
 * DocumentsUI through UIAutomator by its visible affordances (the roots
 * drawer, the provider's advertised title, the confirm button), which is what
 * a person does.
 *
 * The recreation happens BETWEEN the inbound save and the outbound pick, on
 * purpose: the ViewModel must carry the live link across it, and the file
 * picked AFTER recreation exercises the saved `sendLinkId` state the R14
 * fence depends on.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class UiSessionAcceptanceTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    private val doneMessage = "relayium-e2e:done"

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun s(id: Int) = context.getString(id)
    private val device: UiDevice =
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i ->
            ((Character.digit(hex[i * 2], 16) shl 4) or Character.digit(hex[i * 2 + 1], 16)).toByte()
        }

    private fun payload(size: Int, seed: Int) =
        ByteArray(size) { i -> ((i * 31 + seed) and 0xff).toByte() }

    /** Scroll a labelled control into view, then click it — the session screen
     *  is one vertically-scrolling column, and a Files card can push a Messages
     *  control below the fold. Driving the real affordance (not a coordinate)
     *  is the point of a UI acceptance. */
    private fun clickText(id: Int) =
        compose.onNodeWithText(s(id)).performScrollTo().performClick()

    // The DocumentsUI selectors and their hard-won ordering live in
    // `DocumentsUiDriver`, shared with the cloud acceptance. These remain the
    // names this test reads by, with the session's own readiness observable
    // supplied where the driver takes one.
    private fun byLabel(label: String) = DocumentsUiDriver.byLabel(label)

    private fun uiDump(): String = DocumentsUiDriver.uiDump()

    private fun tapInDocumentsUi(label: String, what: String, requireEnabled: Boolean = false) =
        DocumentsUiDriver.tap(label, what, requireEnabled)

    private fun confirmTreeGrant(vm: TransferViewModel) =
        DocumentsUiDriver.confirmTreeGrant { !state(vm).awaitingFolder }

    private fun enterTestRootThenTap(fileName: String) =
        DocumentsUiDriver.enterTestRootThenTap(fileName)

    private fun openRoots() = DocumentsUiDriver.openRoots()

    private val docsPkg = DocumentsUiDriver.DOCS_PKG

    /**
     * Wait for the join to connect, and on timeout say what the app actually
     * thought — which is the difference between "the click never took effect"
     * and "the code was refused".
     *
     * `joinError` is a separate observable from the controller's `errorKey`: a
     * refused code leaves the phase IDLE with no error key and only
     * `joinError` set, so a report that omits it cannot tell the two apart.
     * That is exactly the ambiguity the first RED run left behind.
     *
     * Everything reported is an enum or a boolean. The pairing code itself is
     * not printed — a disposable test code is not a secret worth arguing
     * about, but a failure label is a durable artifact and there is no reason
     * for it to carry one.
     */
    private fun awaitJoinConnected(vm: TransferViewModel, code: String) {
        try {
            awaitTrue("the UI join reached CONNECTED", 90_000) {
                state(vm).phase == TransferController.Phase.CONNECTED
            }
        } catch (timeout: IllegalStateException) {
            // `awaitTrue` reports a timeout through `error(...)`, which is an
            // IllegalStateException — NOT an AssertionError. Catching the wrong
            // type is how a diagnostic silently never runs, which is exactly
            // what left the first RED ambiguous.
            throw AssertionError(
                "${timeout.message} | finalPhase=${state(vm).phase}" +
                    " finalJoinError=${vm.joinError.value}" +
                    " finalErrorKey=${state(vm).errorKey}" +
                    " fieldHeldCode=${
                        runCatching { editableTextOf(compose.onNode(hasSetTextAction())) == code }
                            .getOrDefault(false)
                    }",
                timeout,
            )
        }
    }

    /** What the user typed, and nothing else — the `EditableText` semantics
     *  property, read exactly rather than matched against the node's text
     *  values (which include the field's label). */
    private fun editableTextOf(node: SemanticsNodeInteraction): String? =
        node.fetchSemanticsNode().config
            .getOrNull(SemanticsProperties.EditableText)?.text

    @Test
    fun round() {
        val expectedOrigin = requireArg("relayium.origin")
        val code = requireArg("relayium.code")
        val out = requireArg("relayium.out")
        val message = String(hexToBytes(requireArg("relayium.messageHex")), Charsets.UTF_8)
        val sendName = requireArg("relayium.sendName")
        val sendSize = requireArg("relayium.sendSize").toInt()
        val sendSeed = requireArg("relayium.sendSeed").toInt()

        val observations = LinkedHashMap<String, Any?>()
        var failure: Throwable? = null
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            val vm = InteropDriver.viewModel()
            assertEquals(
                "the app under test must be pointed at this run's throwaway server",
                expectedOrigin, vm.backendOrigin,
            )
            observations["origin"] = vm.backendOrigin

            // The outbound file exists in the provider BEFORE the session, so
            // the system file picker has something real to show.
            val body = payload(sendSize, sendSeed)
            InteropDriver.stageOutgoing(sendName, body)

            // ── join through the REAL form ──────────────────────────────────
            //
            // Every step is a precondition rather than a hope, because an
            // observed run reached the 90s CONNECTED timeout with
            // `joinError == null`, phase IDLE and no error key — the signature
            // of `join()` never having been CALLED, since a click that landed
            // on an empty field would have set `EMPTY`. This does not establish
            // WHY (a private variant that merely added an assertion before the
            // click completed the whole run), so the repair is determinism, not
            // a fix for a diagnosed cause: replace rather than append text,
            // assert the field really holds the code, and require the button to
            // be scrolled to, displayed and enabled before it is clicked.
            //
            // Deliberately absent: sleeps, retry clicks, and any direct call to
            // the ViewModel. A retry would hide exactly the flake this is meant
            // to expose, and driving `vm.join` would stop testing the form.
            val field = compose.onNode(hasSetTextAction())
            field.performScrollTo().performTextReplacement(code)
            // EXACT editable text, not a text-value match: the field's
            // semantics also carry its label, so anything comparing the node's
            // text values is either label-coupled or satisfied by the label
            // alone. This reads the one property the user actually typed into.
            assertEquals("the field must hold exactly the code", code, editableTextOf(field))

            val joinButton = compose.onNodeWithText(s(R.string.join_action))
            joinButton.performScrollTo().assertIsDisplayed().assertIsEnabled()
            joinButton.performClick()

            awaitJoinConnected(vm, code)
            val link = state(vm).linkId
            observations["sas"] = state(vm).sas
            observations["linkId"] = link

            // ── text lane through the REAL Accept button ────────────────────
            awaitTrue("the peer asked for the text lane") {
                state(vm).textState == TextLaneSession.State.INCOMING_REQUEST
            }
            clickText(R.string.text_accept)
            awaitTrue("the text lane opened") {
                state(vm).textState == TextLaneSession.State.OPEN
            }
            awaitTrue("the peer's message arrived") { state(vm).messages.any { it.fromPeer } }
            observations["receivedMessage"] = state(vm).messages.first { it.fromPeer }.body

            // Reply through the REAL composer — the only text field on the
            // session screen once the join form is gone. Scroll it into view
            // first: an Incoming-files card can push the composer below the
            // viewport, and a click on an off-screen node is not what a person
            // does.
            compose.onNode(hasSetTextAction()).performScrollTo().performTextInput(message)
            clickText(R.string.text_send)
            awaitTrue("the reply entered the channel") {
                state(vm).messages.any { !it.fromPeer && it.body == message }
            }
            observations["sentMessage"] = message

            // ── inbound batch through the REAL folder picker ────────────────
            awaitTrue("the peer offered files", 180_000) { state(vm).awaitingFolder }
            val offered = state(vm).incoming.map { it.name }
            observations["offered"] = offered
            clickText(R.string.files_choose_folder)

            // DocumentsUI: wait for it, open the roots drawer, pick the
            // disposable provider's advertised root, confirm.
            device.wait(Until.findObject(By.pkg("com.android.documentsui").depth(0)), 20_000)
                ?: error("the system folder picker never appeared; visible: ${uiDump()}")
            openRoots()
            tapInDocumentsUi("Relayium test tree", "the disposable provider root")
            tapInDocumentsUi("Use this folder", "the tree confirmation", requireEnabled = true)
            // The scoped-access GRANT for a fresh tree is a REQUIRED, OBSERVED
            // step, not an optional best-effort that silently falls through
            // while the picker is still open (which left the save waiting
            // forever). On this API level a dialog appears ("Allow Relayium to
            // access files in Relayium test tree?", CANCEL / ALLOW); on a
            // platform that auto-grants there is none and the app simply
            // returns. Waiting for EITHER — the dialog tapped, or DocumentsUI
            // gone with the prompt consumed — covers both without a blind sleep.
            confirmTreeGrant(vm)

            awaitTrue("the offered batch saved through the picker's real grant", 180_000) {
                state(vm).savedBatchCount == 1 && state(vm).incoming.isEmpty()
            }
            observations["saved"] = offered.map { name ->
                val bytes = InteropDriver.readSaved(name)
                    ?: error("the app reported a saved batch but $name is not in the tree")
                mapOf("name" to name, "size" to bytes.size, "sha256" to sha256(bytes))
            }

            // ── recreation in the MIDDLE of the live session ────────────────
            scenario.recreate()
            awaitTrue("the recreated Activity re-registered its ViewModel") {
                TestHooks.viewModel === vm
            }
            assertEquals(
                "recreation must not tear down or replace the live link",
                link, state(vm).linkId,
            )
            assertEquals(TransferController.Phase.CONNECTED, state(vm).phase)
            observations["recreatedMidSession"] = true

            // ── outbound batch through the REAL file picker, post-recreation ─
            clickText(R.string.files_pick)
            enterTestRootThenTap(sendName)

            awaitTrue("the picked file reached the peer's verified COMPLETE", 180_000) {
                state(vm).sentBatchCount == 1
            }
            observations["sent"] = listOf(
                mapOf("name" to sendName, "size" to body.size, "sha256" to sha256(body)),
            )
            observations["sendCancelled"] = false

            // ── terminal handshake, as in the wire acceptance ───────────────
            awaitTrue("the browser confirmed it observed everything", 180_000) {
                state(vm).messages.any { it.fromPeer && it.body == doneMessage }
            }
            observations["peerConfirmedDone"] = true
            observations["errorKey"] = state(vm).errorKey
            observations["cleanupIncomplete"] = state(vm).cleanupIncomplete
            observations["complete"] = true
        } catch (t: Throwable) {
            failure = t
            throw t
        } finally {
            runCatching {
                val s = state(InteropDriver.viewModel())
                observations["finalPhase"] = s.phase.name
                observations["finalErrorKey"] = s.errorKey
                observations["finalSavedBatchCount"] = s.savedBatchCount
                observations["finalSentBatchCount"] = s.sentBatchCount
            }
            try {
                InteropDriver.report(out, observations)
            } catch (r: Throwable) {
                failure?.addSuppressed(r) ?: run { scenario.close(); throw r }
            }
            scenario.close()
        }
    }
}
