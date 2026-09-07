package com.relayium.android

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

    /** Case-insensitive substring match on text OR content-description:
     *  DocumentsUI capitalises labels differently across releases ("Use this
     *  folder" rendered USE THIS FOLDER) and exposes some affordances only by
     *  description, so both are tried. */
    private fun byLabel(label: String) = By.text(
        Pattern.compile(".*" + Pattern.quote(label) + ".*", Pattern.CASE_INSENSITIVE),
    )
    private fun byDesc(label: String) = By.desc(
        Pattern.compile(".*" + Pattern.quote(label) + ".*", Pattern.CASE_INSENSITIVE),
    )

    /** The visible text and content-descriptions on screen, so a selector that
     *  stopped matching a new DocumentsUI names the labels it actually saw
     *  instead of a bare timeout. Bounded. */
    private fun uiDump(): String =
        device.findObjects(By.clazz(Pattern.compile(".*")))
            .mapNotNull { o -> (o.text ?: o.contentDescription)?.takeIf { t -> t.isNotBlank() } }
            .distinct().take(40).joinToString(" | ")

    /** Find a DocumentsUI affordance by text or description and click it,
     *  re-finding on a StaleObjectException. DocumentsUI animates between the
     *  roots drawer, the directory list and the confirm bar, so a reference
     *  found a frame before the click can go stale mid-transition; the fix is to
     *  look it up again, not to sleep and hope. */
    private fun tapInDocumentsUi(label: String, what: String, requireEnabled: Boolean = false) {
        val deadline = System.currentTimeMillis() + 25_000
        var lastSeen = ""
        while (System.currentTimeMillis() < deadline) {
            val obj = device.wait(Until.findObject(byLabel(label)), 2_000)
                ?: device.findObject(byDesc(label))
            if (obj != null) {
                try {
                    // The tree-confirm button ("Use this folder") is DISABLED
                    // until a selectable root is actually chosen; clicking it
                    // then does nothing. Wait for it to become enabled rather
                    // than tapping a dead control.
                    if (requireEnabled && !obj.isEnabled) {
                        lastSeen = "$label present but disabled"
                    } else {
                        obj.click()
                        return
                    }
                } catch (_: androidx.test.uiautomator.StaleObjectException) {
                    // The view moved under us; re-find on the next loop.
                }
            } else {
                lastSeen = uiDump()
            }
        }
        error("DocumentsUI never let $what ('$label') be tapped; last visible: $lastSeen")
    }

    /** Complete a fresh tree grant: click the scoped-access ALLOW dialog if the
     *  platform shows one, or confirm the app returned (DocumentsUI gone and the
     *  folder prompt consumed) if it auto-granted. Fails only if neither happens
     *  within the bound — i.e. the picker is genuinely stuck — rather than
     *  falling through while it is still open. */
    private fun confirmTreeGrant(vm: TransferViewModel) {
        // EXACT "Allow", not a substring: the dialog TITLE ("Allow Relayium to
        // access files in Relayium test tree?") also contains "Allow" and is an
        // enabled TextView, so a `.*Allow.*` match clicks the title and the
        // grant never happens — which is exactly how a run hung here with the
        // consent dialog still on screen. `^Allow$` targets the BUTTON.
        val allowButton = By.text(Pattern.compile("^Allow$", Pattern.CASE_INSENSITIVE))
        val deadline = System.currentTimeMillis() + 25_000
        while (System.currentTimeMillis() < deadline) {
            val allow = device.wait(Until.findObject(allowButton), 1_000)
            if (allow != null) {
                try {
                    if (allow.isEnabled) {
                        allow.click()
                        // The grant is only real once the dialog is GONE and the
                        // app has consumed the prompt — not the moment the click
                        // is dispatched.
                        device.wait(Until.gone(allowButton), 5_000)
                        if (waitPromptConsumed(vm)) return
                    }
                } catch (_: androidx.test.uiautomator.StaleObjectException) { /* re-find */ }
            }
            // Auto-grant path: no dialog, the picker closed and the app returned.
            val docsUiGone = device.wait(
                Until.gone(By.pkg("com.android.documentsui").depth(0)), 500,
            ) ?: false
            if (docsUiGone && !state(vm).awaitingFolder) return
        }
        error("the scoped-access grant never completed; visible: ${uiDump()}")
    }

    /** True once the app has left the folder prompt (accepted the tree), within
     *  a short bound — the observable that the grant actually reached the app. */
    private fun waitPromptConsumed(vm: TransferViewModel): Boolean {
        val until = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < until) {
            if (!state(vm).awaitingFolder) return true
            Thread.sleep(50)
        }
        return false
    }

    private val docsPkg = "com.android.documentsui"

    /**
     * Enter the disposable provider's ROOT in the file picker (OPEN_DOCUMENT),
     * then tap a document in it. This picker's home is "Recent", whose apps row
     * carries a BACKGROUND tile of the same "Relayium test tree" label — and
     * that tile stays in the view tree even after the roots drawer opens, so a
     * bare label match selects the wrong node. The provider root is therefore
     * entered from the drawer's `roots_list` (opened via "Show roots"), and
     * readiness is the provider's OWN document list appearing — the target file
     * present — which is how a stale Recent view (a leftover recent file) is
     * told apart from the real root having loaded.
     */
    private fun enterTestRootThenTap(fileName: String) {
        device.wait(Until.findObject(By.pkg(docsPkg).depth(0)), 20_000)
            ?: error("the system file picker never appeared; visible: ${uiDump()}")
        // Open the roots drawer via its "Show roots" affordance (found by its
        // current bounds, not hardcoded). The file picker's home is "Recent",
        // whose apps row carries a BACKGROUND tile of the same "Relayium test
        // tree" label — which is why the root MUST be selected from the drawer's
        // `roots_list`, never by a bare label that would match that background
        // tile. The drawer is open once "Open from" and the roots list appear.
        device.wait(Until.findObject(By.desc("Show roots")), 8_000)?.click()
            ?: error("the file picker showed no Show roots affordance; visible: ${uiDump()}")
        device.wait(Until.findObject(By.textContains("Open from")), 5_000)
        val rootsList = device.wait(Until.findObject(By.res(docsPkg, "roots_list")), 8_000)
            ?: error("the roots drawer never opened; visible: ${uiDump()}")
        val rootRow = rootsList.findObject(By.textContains("Relayium test tree"))
            ?: error("the test root is not in the drawer's roots list; visible: ${uiDump()}")
        try {
            rootRow.click()
        } catch (_: androidx.test.uiautomator.StaleObjectException) {
            device.findObject(By.res(docsPkg, "roots_list"))
                ?.findObject(By.textContains("Relayium test tree"))?.click()
        }
        // Readiness: the provider's OWN file list, proven by the target file
        // appearing — not merely that some list rendered (the stale Recent view
        // shows a different, leftover document).
        device.wait(Until.findObject(byLabel(fileName)), 20_000)
            ?: error("the provider root never listed $fileName after entering it; visible: ${uiDump()}")
        tapInDocumentsUi(fileName, "the staged outgoing document")
    }

    /** Open the roots drawer if it is not already showing the roots list. AOSP
     *  releases label the toggle differently ("Show roots", a navigation
     *  description) or open it by an edge swipe, so several are tried before
     *  giving up with what was actually on screen. */
    private fun openRoots() {
        val opener = device.wait(Until.findObject(byDesc("Show roots")), 5_000)
            ?: device.wait(Until.findObject(byDesc("roots")), 2_000)
            ?: device.wait(Until.findObject(byDesc("navigation")), 2_000)
            ?: device.wait(Until.findObject(byDesc("drawer")), 2_000)
        if (opener != null) {
            opener.click()
            return
        }
        // No labelled toggle: swipe the drawer open from the left edge.
        device.swipe(0, device.displayHeight / 2, device.displayWidth / 2, device.displayHeight / 2, 10)
    }

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
            compose.onNode(hasSetTextAction()).performTextInput(code)
            compose.onNodeWithText(s(R.string.join_action)).performClick()
            awaitTrue("the UI join reached CONNECTED", 90_000) {
                state(vm).phase == TransferController.Phase.CONNECTED
            }
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
