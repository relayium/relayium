package com.relayium.android.integration

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.onSiblings
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.DocumentsUiDriver
import com.relayium.android.InteropDriver
import com.relayium.android.R
import com.relayium.android.TransferViewModel
import com.relayium.android.account.AccountState
import com.relayium.android.inbox.InboxConversationEntry
import com.relayium.android.inbox.InboxModel
import com.relayium.android.inbox.InboxReceiving
import com.relayium.android.inbox.InboxSendStatus
import com.relayium.protocol.inbox.InboxAutoAccept
import java.io.File
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * **The Android Device Inbox against a real macOS endpoint, on a device.**
 *
 * Everything here goes through the REAL `MainActivity`: the real Compose tree,
 * the real [TransferViewModel] the user's taps drive, the real `InboxRuntime`,
 * the real Android Keystore, a real `DocumentsUI` round trip, and a real
 * Relayium server the shell half started on loopback. The counterpart is a real
 * `LocalTransferPeer --role inbox-endpoint`, which composes the shipped
 * `InboxController`, `InboxSendModel` and `AccountSession` — not a script that
 * imitates them.
 *
 * ## One method per `am instrument` invocation
 *
 * `scripts/android-host-inbox-acceptance.sh` runs each `@Test` below in its own
 * invocation, asserting exactly one passing test each time. That is not a
 * stylistic choice:
 *
 *  * it makes the exact-count rule in `scripts/lib/instrumentation-result.sh`
 *    trivially exact, and `am instrument` exits 0 when nothing ran at all;
 *  * it gives every receiving leg a real barrier — the shell re-provisions the
 *    fixture, and the test waits for the product's own `LISTENING` before the
 *    Mac is asked to send, instead of racing a sleep;
 *  * the account session, the conversation store and the tombstone ledger are
 *    on the device and survive between invocations, which is what makes
 *    [historySurvivesARestart] an assertion rather than setup.
 *
 * **There is no `Assume` anywhere in this class, deliberately.** An
 * assumption-skipped test does not emit `INSTRUMENTATION_STATUS_CODE: 0`, so a
 * leg that quietly opted out would break the count the harness depends on — and
 * a harness that then relaxed the count would stop being able to tell a passing
 * run from an empty one.
 *
 * ## Nothing here prints a credential
 *
 * The password, the control bearer and the message body arrive through
 * [LiveFixture], which reads them from a file only this app can open and deletes
 * it on the way out. They are never instrumentation arguments, because those are
 * process argv — visible to `ps` and echoed into the very log a failed run gets
 * attached to. Assertions name keys and shapes, never values.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class HostInboxLiveTest {

    /**
     * **Compose is OUTER, the Activity is INNER. The order is load-bearing.**
     *
     * JUnit applies `order = 0` outermost, so the lower number is the rule that
     * wraps the other. Getting this backwards — the Activity at `order = 0` —
     * launches `MainActivity`, and with it `setContent`, BEFORE
     * `createEmptyComposeRule` has installed its root registry. Every semantic
     * assertion then fails with "No compose hierarchies found", and the error
     * says so explicitly: `setContent` was called before the Compose test rule.
     *
     * Observed on a real device against the full host, not reasoned about. With
     * Compose outside, the registry is live for the whole of the Activity's
     * startup AND its teardown, which is what the semantics need at both ends.
     */
    @get:Rule(order = 0)
    val compose = createEmptyComposeRule()

    /**
     * The Activity, started and torn down inside the live Compose environment.
     * See [HostInboxLiveActivity] for why this lane owns its own helper rather
     * than the shared host's.
     */
    @get:Rule(order = 1)
    internal val host = HostInboxLiveActivity()

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun s(id: Int) = context.getString(id)
    private fun s(id: Int, vararg args: Any) = context.getString(id, *args)

    /** Read once per invocation; the file is consumed by the read. */
    private val fixture by lazy { LiveFixture.load() }

    private val vm: TransferViewModel get() = InteropDriver.viewModel()

    private val driver by lazy {
        HostInboxLiveDriver(fixture.require("peerUrl"), fixture.require("controlToken"))
    }

    private val appleName get() = fixture.require("appleName")
    private val runTag get() = fixture.require("runTag")

    /**
     * The message body, base64 in the fixture and exact here.
     *
     * [LiveFixture] trims each value as it parses — deliberately, because a
     * parser that could throw on the SHAPE of a value is a place a secret
     * reaches a stack trace. A message whose leading and trailing whitespace is
     * the thing under test therefore cannot travel as a bare value: it would
     * arrive already corrected, and the assertion would pass against a fixture
     * that had quietly done the product's job for it.
     */
    private val messageText: String
        get() = String(Base64.getDecoder().decode(fixture.require("textB64")), Charsets.UTF_8)

    // ── selecting the real thing ────────────────────────────────────────────

    /**
     * A control, selected by BEING one.
     *
     * Text alone is ambiguous on these screens: "Inbox" is a tab and a heading,
     * "Delete" is a row button and a dialog's confirm. Matching on text plus a
     * click action picks what a person would tap, and falling back to "the first
     * one" would start asserting about prose the moment the layout moved.
     */
    private fun button(text: String) = compose.onNode(hasText(text) and hasClickAction())

    private fun tab(id: Int) = compose.onNode(hasText(s(id)) and isSelectable())

    private fun openTab(id: Int) = tapOnce(tab(id))

    /**
     * Bring a node into view ONLY if it is not already there.
     *
     * `performScrollTo` throws "Semantic Node has no parent layout with a Scroll
     * SemanticsAction" when nothing above the node scrolls — and at the DEFAULT
     * width nothing does: the destination bar is a `NavigationBar`, which
     * divides its width evenly, and only the narrow corner swaps in a
     * `Row(…horizontalScroll(…))`. Scrolling unconditionally therefore failed on
     * the very first tab tap, before a single credential was typed.
     *
     * The throw is NOT swallowed wholesale. Wrapping the scroll in
     * `runCatching` would equally hide a node that is genuinely unreachable
     * inside a list that really does scroll, and the assertion after it would
     * then describe the wrong problem. Only the already-visible case skips.
     */
    private fun reach(node: SemanticsNodeInteraction): SemanticsNodeInteraction {
        if (!node.isShowing()) node.performScrollTo()
        return node
    }

    /** Displayed right now — a question, not an assertion. */
    private fun SemanticsNodeInteraction.isShowing(): Boolean =
        runCatching { assertIsDisplayed() }.isSuccess

    /**
     * Reach it, require it usable, click it ONCE.
     *
     * Every tap in this class goes through here, so "displayed and enabled
     * before exactly one click" is a property of the suite rather than of the
     * call sites that remembered to do it.
     */
    private fun tapOnce(node: SemanticsNodeInteraction) {
        reach(node)
        node.assertIsDisplayed()
        node.assertIsEnabled()
        node.performClick()
        compose.waitForIdle()
    }

    /** Reach it and require it visible, without touching it. */
    private fun requireShown(node: SemanticsNodeInteraction): SemanticsNodeInteraction {
        reach(node)
        node.assertIsDisplayed()
        return node
    }

    private fun click(text: String) = tapOnce(button(text))

    private fun click(id: Int) = click(s(id))

    /**
     * A control belonging to ONE entry, addressed by that entry's ID.
     *
     * The history holds every entry at once and every row draws the same four
     * labels — Open, Export, Share, Delete — so a bare `hasText("Delete")` is
     * ambiguous the moment a second entry exists.
     *
     * ## Why an ancestor tag, and not a sibling walk
     *
     * An earlier version anchored on a file name the entry carries and looked
     * among that `Text`'s siblings. It found nothing, and the reason is
     * structural: `ConversationDetail` is a plain `Column` emitting entries in a
     * loop, and `EntryRow` is a plain `Column` holding a plain `FlowRow`. None
     * of them carries semantics, and Compose emits no `SemanticsNode` for a
     * layout that has none — so every entry's Texts and buttons collapse into
     * ONE flat sibling set with no per-entry boundary anywhere in the tree. The
     * buttons were siblings of the anchor, not descendants of a sibling, and no
     * arrangement of sibling matchers can recover a grouping that does not
     * exist.
     *
     * `EntryRow` now carries `Modifier.testTag("inboxEntry:<id>")`, which gives
     * that Column a semantics config and therefore a real node, making the row's
     * controls its descendants. `hasAnyAncestor` is used rather than
     * `onChildren` so an intermediate layout gaining semantics later cannot
     * quietly break this.
     *
     * Addressing by ID is also better than the name it replaces: an id is a task
     * or job identifier, unique by construction, and carries no user data.
     */
    private fun entryAction(entryId: String, label: String) = compose.onNode(
        hasText(label) and hasClickAction() and
            hasAnyAncestor(hasTestTag("inboxEntry:$entryId")),
    )

    private fun clickInEntry(entryId: String, id: Int) = tapOnce(entryAction(entryId, s(id)))

    /**
     * A dialog's own button, never the row button that shares its label.
     *
     * The delete confirmation says "Delete" and so does every row, and the rows
     * are still composed behind the dialog. `isDialog()` is the only thing that
     * separates them.
     */
    private fun clickInDialog(id: Int) = tapOnce(
        compose.onNode(hasText(s(id)) and hasClickAction() and hasAnyAncestor(isDialog())),
    )

    private val inbox: InboxModel.State get() = vm.inbox.value

    private fun awaitInbox(what: String, timeoutMs: Long = 120_000, p: (InboxModel.State) -> Boolean) {
        InteropDriver.awaitTrue(what, timeoutMs) { p(inbox) }
        compose.waitForIdle()
    }

    /**
     * The app, signed in and receiving, on the Inbox tab.
     *
     * Every leg after the first begins here. The credential is in the keystore
     * from [signsInThroughTheAccountFormAndRegistersTheInbox], so this is a
     * restore rather than a second sign-in — which is itself the thing
     * [historySurvivesARestart] leans on.
     */
    private fun onInboxSignedIn() {
        assertEquals(
            "the app under test must be pointed at this run's disposable server",
            fixture.require("origin"),
            vm.backendOrigin,
        )
        InteropDriver.awaitTrue("the account session was restored") {
            vm.account.state.value is AccountState.Ready
        }
        openTab(R.string.tab_inbox)
        awaitInbox("the Inbox became ready") { it.ready }
    }

    private fun awaitListening() =
        awaitInbox("this device is listening") { it.receiving == InboxReceiving.LISTENING }

    /** Select the Apple device row, which is what reveals its send card. */
    /**
     * Select the Apple device row, and be safe to call AGAIN.
     *
     * `DeviceRow` is a toggle: `selectedId = if (target.deviceId == selectedId)
     * null else target.deviceId`. So a second unconditional tap DESELECTS the
     * row and takes the send card down with it, and the next assertion fails
     * looking for a card that the tap itself closed. The file leg calls this
     * once per pick, which is exactly the shape that trips it.
     *
     * The row is addressed BY NAME and by being selectable — never positionally
     * — and it is required displayed and enabled whether or not a tap is needed,
     * so an unusable row fails here rather than in whatever comes after.
     */
    private fun selectAppleTarget() {
        val row = compose.onNode(hasText(appleName) and isSelectable())
        reach(row)
        row.assertIsDisplayed()
        row.assertIsEnabled()
        // Tap only if it is not already the selected one. Asking first is the
        // whole fix: the control has no idempotent "select", only a toggle.
        if (!row.isSelectedNow()) {
            row.performClick()
            compose.waitForIdle()
        }
        row.assertIsSelected()
        requireShown(compose.onNodeWithText(s(R.string.inbox_send_to, appleName)))
    }

    /** Selected right now — a question, not an assertion. */
    private fun SemanticsNodeInteraction.isSelectedNow(): Boolean =
        runCatching { assertIsSelected() }.isSuccess

    private fun setPolicy(policy: InboxAutoAccept) {
        click(
            when (policy) {
                InboxAutoAccept.OFF -> R.string.inbox_policy_off
                InboxAutoAccept.ASK -> R.string.inbox_policy_ask
                InboxAutoAccept.AUTO -> R.string.inbox_policy_auto
            },
        )
        awaitInbox("the policy became $policy") { it.policy == policy }
    }

    /**
     * Wait until the Mac can actually address THIS device, asking again each
     * round.
     *
     * Every leg where the Mac sends has to do this first. `send-files` aims by
     * name at the model's own candidate list, so issuing a send before that list
     * has been re-read fails as "no candidate named …" — a harness fault that
     * reads exactly like a product one.
     */
    private fun awaitAppleSeesUs(self: String) {
        driver.awaitObserved(
            "the Mac lists this Android device as a target",
            poke = { driver.drive("refresh-targets") },
        ) { snapshot ->
            val rows = snapshot.getJSONArray("candidates")
            (0 until rows.length()).any { rows.getJSONObject(it).optString("name") == self }
        }
    }

    /**
     * A reader receipt that proves the OTHER APP READ THE RIGHT BYTES.
     *
     * The read flags alone are not enough. `read1 && read2 && writeDenied` says
     * a grant worked and refused writes; it says nothing about WHICH bytes came
     * back. A grant minted over the wrong file, or the same file handed out
     * twice, satisfies every boolean and every count. So the receipt's
     * `(name, size, sha256)` tuples are compared as a MULTISET against the
     * delivery this suite already verified on disk — which catches wrong bytes
     * and duplicate grants in one comparison.
     *
     * The reader reads each URI twice and reports both. Pass 2 is required to
     * equal pass 1: a provider that answered differently on reopen would be
     * handing out a stream that is not stable, and only comparing pass 1 would
     * miss it.
     *
     * All three read flags stay, and stay together — `writeDenied` alone is also
     * what a MISSING grant produces, so on its own it would confirm
     * write-protection over a URI that granted nothing at all.
     *
     * Nothing here is logged: the report carries delivered file names.
     */
    private fun assertReaderReceipt(
        text: String,
        what: String,
        expected: Collection<HostInboxLiveDriver.Receipt>,
    ): org.json.JSONObject {
        val doc = org.json.JSONObject(text)
        assertTrue("$what: the reader did not complete", doc.optBoolean("ok"))
        val count = doc.getInt("count")
        assertEquals("$what: the reader was granted the wrong number of files",
            expected.size, count)
        val files = doc.getJSONArray("files")
        assertEquals("$what: the count and the file list disagree", count, files.length())

        val actual = ArrayList<Triple<String, Long, String>>()
        for (i in 0 until files.length()) {
            val file = files.getJSONObject(i)
            assertTrue("$what: a granted file was not readable", file.getBoolean("read1"))
            assertTrue("$what: a granted file could not be reopened", file.getBoolean("read2"))
            assertTrue("$what: a granted file was writable", file.getBoolean("writeDenied"))
            assertEquals(
                "$what: a granted file answered a different length on reopen",
                file.getLong("size1"), file.getLong("size2"),
            )
            assertEquals(
                "$what: a granted file answered different bytes on reopen",
                file.getString("sha256_1"), file.getString("sha256_2"),
            )
            actual += Triple(file.getString("name"), file.getLong("size1"),
                file.getString("sha256_1"))
        }
        // Sorted multisets: order is the grant's, not something to assert, but a
        // repeat must not cancel out against a missing one.
        assertEquals(
            "$what: the bytes another app could read are not the delivered bytes",
            expected.map { Triple(it.name, it.size, it.sha256) }.sortedBy { it.third },
            actual.sortedBy { it.third },
        )
        return doc
    }

    /** Every send row the Mac currently holds, by id. */
    private fun macSendIds(snapshot: org.json.JSONObject = driver.observed()): Set<String> {
        val out = LinkedHashSet<String>()
        val rows = snapshot.optJSONArray("sends") ?: return out
        for (i in 0 until rows.length()) out += rows.getJSONObject(i).getString("id")
        return out
    }

    /**
     * Whether the Mac considers one send delivered — by ITS id, not a count.
     *
     * `isSavedOnTarget` is the field `InboxSendModel` exposes for exactly this
     * question, and the peer's own source calls it "the ONE predicate allowed to
     * answer 'has it arrived'". Asking it about a specific row is what turns
     * "nothing showed up in eight seconds" into "the sender itself says this
     * delivery was never saved on the target".
     */
    private fun macSaysSaved(id: String): Boolean {
        val rows = driver.observed().optJSONArray("sends") ?: return false
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            if (row.getString("id") == id) return row.optBoolean("isSavedOnTarget", false)
        }
        return false
    }

    /** Issue a send from the Mac and return the id of the row it created. */
    private fun macSends(self: String, batch: String): String {
        val before = macSendIds()
        val answer = driver.drive("send-files", mapOf("name" to self, "batch" to batch))
        assertFalse(
            "the Mac refused to send at all, so nothing downstream is being tested: " +
                answer.optString("refusal", answer.optString("targetBlock", "")),
            answer.has("refusal"),
        )
        val snapshot = driver.awaitObserved("the Mac created a send row") { observed ->
            (macSendIds(observed) - before).isNotEmpty()
        }
        return (macSendIds(snapshot) - before).first()
    }

    /** The Apple endpoint's id, as the endpoint itself reports it. */
    private fun appleDeviceId(): String = driver.observed().getString("selfDeviceID")

    private fun receivedEntries(): List<InboxConversationEntry> =
        inbox.conversations.flatMap { it.entries }
            .filter { it.direction == InboxConversationEntry.Direction.RECEIVED }

    private fun sentEntries(): List<InboxConversationEntry> =
        inbox.conversations.flatMap { it.entries }
            .filter { it.direction == InboxConversationEntry.Direction.SENT }

    // ────────────────────────────────────────────────────────────────────────
    // 1. A real sign-in, a real registration, a real target list
    // ────────────────────────────────────────────────────────────────────────

    /**
     * The normal first authentication: the Account form, typed.
     *
     * Not a bearer pushed into the ViewModel. Signing in through the form is
     * what exercises the shared host's credential adoption — `InboxHost.run`
     * observing the account flow, `InboxAdoption` deciding this is a new
     * identity, and the runtime enrolling a device key under it. A test that
     * injected a session would skip precisely the path this lane exists to
     * prove.
     */
    @Test
    fun signsInThroughTheAccountFormAndRegistersTheInbox() {
        assertEquals(
            "the app under test must be pointed at this run's disposable server",
            fixture.require("origin"),
            vm.backendOrigin,
        )
        openTab(R.string.tab_account)

        // **The device must arrive here signed OUT**, and saying so is the whole
        // point: `install -r` preserves application data, so a device that ran
        // this suite before restores the previous run's credential and renders a
        // signed-in Account tab with no form on it. The failure then surfaces as
        // "no SetText nodes" — an error about a missing text field, which is
        // true, unhelpful, and three steps from the cause.
        //
        // The reset itself belongs to the harness, once per run, and stays out
        // of the acceptance: a test that signed itself out would be arranging
        // its own precondition and would no longer be proving that a real first
        // authentication works.
        assertFalse(
            "this device is still holding a credential; the harness must reset the " +
                "disposable debug app once before the run (see " +
                "scripts/android-host-inbox-acceptance.sh)",
            vm.account.holdsCredential,
        )

        val fields = compose.onAllNodes(hasSetTextAction())
        reach(fields[0]).performTextInput(fixture.require("email"))
        reach(fields[1]).performTextInput(fixture.require("password"))
        click(R.string.account_signin_action)

        InteropDriver.awaitTrue("the account signed in", 90_000) {
            (vm.account.state.value as? AccountState.Rejected)?.let {
                error("the sign-in was REFUSED: ${it.failure.kind} (status ${it.failure.status})")
            }
            vm.account.state.value is AccountState.Ready
        }
        assertTrue(
            "the credential must have reached the keystore, or no later leg can resume",
            (vm.account.state.value as AccountState.Ready).persisted,
        )

        openTab(R.string.tab_inbox)
        awaitInbox("the Inbox enrolled this device", 120_000) { it.ready && it.deviceName != null }

        // **A fresh device accepts nothing until its owner says so** — asserted
        // BEFORE it is changed, because this is a privacy default and not an
        // accident of a new install. `InboxServices.read` answers OFF for an
        // absent policy file, `InboxRuntime` starts OFF, and an OFF policy maps
        // to `InboxReceiving.OFF` and never to LISTENING. A build that quietly
        // shipped AUTO would be a regression every later leg would hide, since
        // they all turn it on themselves.
        assertEquals(
            "a fresh device must accept nothing until asked",
            InboxAutoAccept.OFF,
            inbox.policy,
        )
        assertEquals(
            "and must not claim to be listening while it accepts nothing",
            InboxReceiving.OFF,
            inbox.receiving,
        )

        // Turned on the way a person turns it on: the real chip on the real
        // surface, not a call into the runtime.
        setPolicy(InboxAutoAccept.AUTO)
        awaitListening()

        // The device list is a real `GET`, and the Mac is a real row on it.
        awaitInbox("the Apple endpoint appeared as a target") { state ->
            state.devices.any { it.name == appleName }
        }
        val self = requireNotNull(inbox.deviceName)
        assertFalse(
            "this device must not be offered as a target to itself",
            inbox.devices.any { it.name == self },
        )
        compose.onNodeWithText(s(R.string.inbox_this_device, self)).let { requireShown(it) }

        // …and the far side independently sees THIS device, which is the half a
        // one-sided target list cannot prove.
        awaitAppleSeesUs(self)

        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "signed-in",
                "inboxReady" to inbox.ready,
                "receiving" to inbox.receiving.name,
                "targetCount" to inbox.devices.size,
                "selfExcluded" to true,
            ),
        )
    }

    // ────────────────────────────────────────────────────────────────────────
    // 2. Android → Apple
    // ────────────────────────────────────────────────────────────────────────

    /**
     * A message whose leading and trailing whitespace is load-bearing.
     *
     * Compared byte for byte against what the Mac read back through
     * `InboxController.sentMessage`/`message` — the production accessors — so a
     * receiver that trimmed on the way in, or a sender that trimmed on the way
     * out, fails here rather than in somebody's notes.
     */
    @Test
    fun sendsWhitespaceSignificantUnicodeTextToTheAppleTarget() {
        onInboxSignedIn()
        // Deliberately NOT waiting to be receiving: this leg SENDS, and the
        // receive policy says what arrives HERE. Waiting on it would couple every
        // send leg to whatever the previous leg left the policy at — and after
        // the OFF leg that wait can never be satisfied.
        selectAppleTarget()

        val text = messageText
        // The ONLY editable field on the Inbox surface — the send card's message
        // box, revealed by selecting a target. Matching on the label's text
        // instead would depend on whether a `TextField` merges its label into
        // its own semantics, which is not a promise worth resting a live leg on.
        reach(compose.onNode(hasSetTextAction())).performTextInput(text)
        click(R.string.inbox_send_message)

        val appleId = appleDeviceId()
        driver.drive("refresh")
        val snapshot = driver.awaitObserved("the Mac holds the message") { observed ->
            conversationTexts(observed).contains(text)
        }
        assertTrue(
            "the Mac must hold this text EXACTLY, whitespace included",
            conversationTexts(snapshot).contains(text),
        )

        // The sender's own history says it was sent, to the device addressed.
        awaitInbox("this device recorded the send") { state ->
            state.conversations.any { it.peerDeviceId == appleId } &&
                sentEntries().any { it.kind == InboxConversationEntry.Kind.MESSAGE }
        }
        InteropDriver.report(
            REPORT,
            mapOf("leg" to "text-sent", "bytes" to text.toByteArray(Charsets.UTF_8).size),
        )
    }

    /**
     * Two real `DocumentsUI` round trips: a multiframe file with a Unicode name,
     * and an empty one.
     *
     * 307_200 bytes is past `STORE_CHUNK_SIZE` (192 KiB), so the delivery
     * crosses a chunk boundary rather than fitting in a single frame. The empty
     * file is the one a length-driven splitter skips.
     *
     * Two separate picks rather than one multi-select: the send path takes a
     * list either way, and driving `DocumentsUI`'s long-press selection mode
     * would add UI fragility without adding product coverage. The Android
     * picker's own input is flat, so no nested path is invented here — nesting
     * is proven in the other direction, where a real tree exists.
     */
    @Test
    fun sendsAnEmptyAndAMultiframeFileThroughTheRealPicker() {
        onInboxSignedIn()

        // Prefixed, because the `android-parity` batch the Mac sends contains a
        // file called `大文件-<tag>.bin` too. Two entries carrying the same file
        // name would make every scoped selector below ambiguous, and would let a
        // digest comparison pass against the wrong direction's bytes.
        val large = "android-大文件-$runTag.bin"
        val empty = "android-empty-$runTag.bin"
        val largeBytes = ByteArray(MULTIFRAME_BYTES) { (it * 31 + 7).toByte() }
        InteropDriver.stageOutgoing(large, largeBytes)
        InteropDriver.stageOutgoing(empty, ByteArray(0))

        for (name in listOf(large, empty)) {
            selectAppleTarget()
            click(R.string.inbox_send_choose_files)
            DocumentsUiDriver.enterTestRootThenTap(name)
            compose.waitForIdle()
            awaitInbox("the send for $name was accepted") { state ->
                state.sends.any { name in it.names } ||
                    sentEntries().any { name in it.names }
            }
        }

        val expected = mapOf(
            large to HostInboxLiveDriver.sha256(largeBytes),
            empty to HostInboxLiveDriver.sha256(ByteArray(0)),
        )
        val snapshot = driver.awaitObserved("the Mac committed both files", 180_000) { observed ->
            val got = appleFiles(observed)
            expected.keys.all { got.containsKey(it) }
        }
        val got = appleFiles(snapshot)
        for ((name, sha) in expected) {
            val receipt = requireNotNull(got[name]) { "the Mac never committed $name" }
            assertEquals("$name must arrive with its own bytes", sha, receipt.sha256)
        }
        assertEquals(
            "the multiframe file must arrive whole",
            MULTIFRAME_BYTES.toLong(),
            got.getValue(large).size,
        )
        assertEquals("the empty file must arrive, and be empty", 0L, got.getValue(empty).size)

        InteropDriver.report(
            REPORT,
            mapOf("leg" to "files-sent", "multiframeBytes" to MULTIFRAME_BYTES, "emptySent" to true),
        )
    }

    // ────────────────────────────────────────────────────────────────────────
    // 3. Apple → Android
    // ────────────────────────────────────────────────────────────────────────

    /**
     * The `android-parity` batch, arriving while the app is foreground on AUTO.
     *
     * Asserted against the files ON DISK, not against the entry's own metadata:
     * a receiver that recorded a delivery it never committed would produce a
     * perfect row. The comparison is between the SENDER's stated receipts and an
     * independent walk of what actually landed, which is two walks rather than
     * one value copied twice.
     */
    @Test
    fun receivesTheAndroidParityBatchWhileForeground() {
        onInboxSignedIn()
        setPolicy(InboxAutoAccept.AUTO)
        awaitListening()

        val self = requireNotNull(inbox.deviceName)
        awaitAppleSeesUs(self)
        val answer = driver.drive("send-files", mapOf("name" to self, "batch" to "android-parity"))
        val stated = HostInboxLiveDriver.receipts(answer)
        assertEquals("the android-parity batch must carry three files", 3, stated.size)

        awaitInbox("the batch arrived", 240_000) { state ->
            state.conversations.flatMap { it.entries }.any { entry ->
                entry.direction == InboxConversationEntry.Direction.RECEIVED &&
                    entry.kind == InboxConversationEntry.Kind.FILES &&
                    entry.names.size == stated.size &&
                    entry.directory != null
            }
        }
        val entry = receivedEntries().first { it.names.size == stated.size && it.directory != null }
        val directory = File(requireNotNull(entry.directory))

        // The commit receipt is the product's own bookkeeping, written after
        // every file is on disk. Its PRESENCE is the delivery being committed,
        // so it is asserted rather than merely skipped — and then excluded from
        // the payload, which is what the sender's receipts describe.
        assertTrue(
            "a committed delivery must carry its commit receipt",
            HostInboxLiveDriver.isCommitted(directory),
        )
        val landed = HostInboxLiveDriver.payload(directory)

        assertEquals(
            "every file the Mac sent must be on this device, under its own relative path",
            stated.keys.sorted(),
            landed.keys.sorted(),
        )
        for ((key, sent) in stated) {
            val here = requireNotNull(landed[key]) { "nothing landed at $key" }
            assertEquals("$key must keep its size", sent.size, here.size)
            assertEquals("$key must keep its bytes", sent.sha256, here.sha256)
        }
        assertTrue(
            "the batch must include a file past one 192 KiB chunk",
            landed.values.any { it.size >= MULTIFRAME_BYTES },
        )
        assertTrue("the batch must include the zero-byte leaf", landed.values.any { it.size == 0L })
        assertTrue(
            "the nested Unicode path must survive the trip",
            landed.keys.any { it.contains('/') && it.any { c -> c.code > 0x7F } },
        )

        // Named for the restart leg, which must assert that THIS entry and THESE
        // bytes came back — not merely that some history existed.
        val largest = landed.values.maxByOrNull { it.size }!!
        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "batch-received",
                "files" to landed.size,
                "nested" to landed.keys.count { it.contains('/') },
                "largest" to largest.size,
                "survivingEntryId" to entry.id,
                "survivingKey" to largest.key,
                "survivingSha" to largest.sha256,
            ),
        )
    }

    /**
     * AUTO is an APP-WIDE claim, not a property of the Inbox tab.
     *
     * The presence claim is made from the ViewModel for the whole app —
     * switching destination must not withdraw it — so a delivery has to land
     * while the person is looking at Account, Cloud or Nearby. Getting this
     * wrong reads as an Inbox that only works when you are watching it.
     */
    @Test
    fun receivesWhileForegroundOnAccountCloudAndNearbyTabs() {
        onInboxSignedIn()
        setPolicy(InboxAutoAccept.AUTO)
        awaitListening()
        val self = requireNotNull(inbox.deviceName)
        awaitAppleSeesUs(self)

        var before = receivedEntries().size
        val landedOn = ArrayList<String>()
        for (tab in listOf(R.string.tab_account, R.string.tab_cloud, R.string.tab_nearby)) {
            openTab(tab)
            assertEquals(
                "leaving the Inbox tab must not withdraw the claim",
                InboxReceiving.LISTENING,
                inbox.receiving,
            )
            driver.drive("send-files", mapOf("name" to self, "batch" to "competing"))
            val target = before + 1
            awaitInbox("a delivery landed while on ${s(tab)}", 240_000) {
                receivedEntries().size >= target
            }
            before = receivedEntries().size
            landedOn += s(tab)
        }
        InteropDriver.report(REPORT, mapOf("leg" to "tab-independence", "tabs" to landedOn.size))
    }

    /**
     * Leaving the app really does withdraw receiving, and coming back really
     * does restore the policy that was chosen.
     *
     * A real Home key, because the product gates on the process's actual
     * foreground state; a synthetic `onPause` would prove the callback rather
     * than the behaviour. The delivery issued while the app is away must not be
     * lost either — it is held and lands on return, which is the honest version
     * of "this device is not receiving right now".
     */
    @Test
    fun homeWithdrawsReceivingAndComingBackRestoresThePolicy() {
        onInboxSignedIn()
        setPolicy(InboxAutoAccept.AUTO)
        awaitListening()
        val self = requireNotNull(inbox.deviceName)
        val before = receivedEntries().size
        // The ViewModel that held the chosen policy. Captured so the assertion
        // after the return is about THIS app coming back, not about a fresh one
        // starting.
        val viewModelBefore = vm

        host.background()
        InteropDriver.awaitTrue("receiving was withdrawn in the background", 60_000) {
            inbox.receiving != InboxReceiving.LISTENING
        }

        // Issued while this device is away. Offline presence is a CAVEAT on the
        // target row, not a block, so the Mac may still address it and central
        // holds the task — which is what "the delivery is held, not lost" means.
        // Asserting the send was accepted here keeps a refusal from surfacing
        // later as an unexplained timeout waiting for something never sent.
        awaitAppleSeesUs(self)
        val held = macSends(self, "competing")

        host.foreground()
        // Same process, same ViewModel. If Android had killed the app while it
        // was away, the policy would be restored from disk instead — correct
        // behaviour, but a DIFFERENT claim, and this leg would be quietly
        // proving the other one.
        assertSame(
            "the app must come back in the same process; a restart proves a " +
                "different thing than a resume",
            viewModelBefore,
            vm,
        )
        openTab(R.string.tab_inbox)
        awaitInbox("the chosen policy came back with the app") {
            it.policy == InboxAutoAccept.AUTO && it.receiving == InboxReceiving.LISTENING
        }
        awaitInbox("the held delivery landed once the app was back", 240_000) {
            receivedEntries().size > before
        }
        // …and the sender agrees it finally arrived, rather than this device
        // having produced a row from somewhere else.
        driver.awaitObserved("the Mac sees the held delivery saved") { macSaysSaved(held) }
        InteropDriver.report(
            REPORT,
            mapOf("leg" to "background-withdraws", "resumedPolicy" to "AUTO", "heldThenSaved" to true),
        )
    }

    /**
     * ASK really asks, and BOTH answers are honoured.
     *
     * The accept path is the easy half. The decline is the one worth a test: a
     * refusal that still wrote the files, or that reported success to the
     * sender, is the failure this policy exists to prevent.
     */
    @Test
    fun askHoldsTheDeliveryUntilThePersonAnswers() {
        onInboxSignedIn()
        setPolicy(InboxAutoAccept.ASK)
        awaitListening()
        val self = requireNotNull(inbox.deviceName)
        awaitAppleSeesUs(self)

        // ── accepted ────────────────────────────────────────────────────────
        val before = receivedEntries().size
        macSends(self, "competing")
        awaitInbox("the delivery is waiting for an answer", 180_000) { it.awaitingAnswer.isNotEmpty() }
        requireShown(compose.onNodeWithText(s(R.string.inbox_pending_title)))
        click(R.string.inbox_pending_accept)
        awaitInbox("the accepted delivery landed", 240_000) { receivedEntries().size > before }

        // ── declined ────────────────────────────────────────────────────────
        val afterAccept = receivedEntries().size
        val declined = macSends(self, "competing")
        awaitInbox("the second delivery is waiting", 180_000) { it.awaitingAnswer.isNotEmpty() }
        click(R.string.inbox_pending_decline)
        awaitInbox("the prompt was answered") { it.awaitingAnswer.isEmpty() }

        // Two independent statements, and the SENDER'S is the one that matters.
        // A count that did not move could equally mean the delivery was merely
        // slow; the Mac reporting its own row as never saved on the target is
        // the far side agreeing that nothing was accepted.
        Thread.sleep(SETTLE_MS)
        assertFalse(
            "the Mac must not report a declined delivery as saved on the target",
            macSaysSaved(declined),
        )
        assertEquals(
            "a declined delivery must not be written to this device",
            afterAccept,
            receivedEntries().size,
        )
        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "ask",
                "accepted" to 1,
                "declined" to 1,
                "declinedSavedOnTarget" to false,
            ),
        )
    }

    /**
     * OFF refuses, and says so to the other device rather than going quiet.
     *
     * The honest part is the target list: a device that accepts nothing must be
     * shown to its siblings as not sendable, with the reason, instead of
     * disappearing or silently swallowing what they send.
     */
    @Test
    fun offRefusesNewDeliveryAndSaysSoToTheOtherDevice() {
        onInboxSignedIn()
        setPolicy(InboxAutoAccept.OFF)
        val self = requireNotNull(inbox.deviceName)
        val before = receivedEntries().size

        // Re-asked each round: the Mac learns this device stopped receiving only
        // by re-reading the account's device list, so a single ask before the
        // policy had propagated would poll a stale "sendable" for the full
        // timeout and fail a product that behaved correctly.
        driver.awaitObserved(
            "the Mac sees this device as not sendable",
            120_000,
            poke = { driver.drive("refresh-targets") },
        ) { observed ->
            val rows = observed.getJSONArray("candidates")
            (0 until rows.length()).any { i ->
                val row = rows.getJSONObject(i)
                row.optString("name") == self && !row.optBoolean("sendable", true)
            }
        }

        // Issued anyway: a send this test declined to make would prove nothing
        // about the product's own guard. The refusal must be the MODEL'S, so the
        // send goes through `drive` directly rather than through `macSends`,
        // which exists to fail loudly on exactly the refusal wanted here.
        val idsBefore = macSendIds()
        val answer = driver.drive("send-files", mapOf("name" to self, "batch" to "competing"))
        assertTrue(
            "the Mac's own send model must refuse a device that is not receiving",
            answer.has("refusal") || !answer.optBoolean("ok", false),
        )

        // Belt and braces, and both are about a NAMED row rather than a count:
        // if the model created a send at all despite refusing, that row must
        // never be reported as saved on the target.
        Thread.sleep(SETTLE_MS)
        for (id in macSendIds() - idsBefore) {
            assertFalse(
                "a send refused for a device that is not receiving must never " +
                    "be reported as saved on the target",
                macSaysSaved(id),
            )
        }
        assertEquals(
            "nothing may be written while receiving is off",
            before,
            receivedEntries().size,
        )
        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "off",
                "refused" to true,
                "refusal" to answer.optString("refusal", answer.optString("targetBlock", "none")),
            ),
        )
    }

    // ────────────────────────────────────────────────────────────────────────
    // 4. History, and the files it published
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Unread becomes read by BEING READ — opening the conversation — and the
     * body comes back through the product's own accessor.
     */
    @Test
    fun historyUnreadMarkReadAndTheMessageBody() {
        onInboxSignedIn()
        awaitInbox("there is history to read") { it.conversations.any { c -> c.entries.isNotEmpty() } }

        val conversation = inbox.conversations.first { it.entries.isNotEmpty() }
        val unreadBefore = conversation.unreadCount
        assertTrue("earlier legs must have left something unread", unreadBefore > 0)
        requireShown(compose.onNodeWithText(s(R.string.inbox_history_title)))

        // Opening the detail is what marks the entries the person was SHOWN.
        click(R.string.inbox_history_open)
        awaitInbox("opening the conversation marked it read", 60_000) { state ->
            state.conversations.firstOrNull { it.peerDeviceId == conversation.peerDeviceId }
                ?.unreadCount == 0
        }
        val after = inbox.conversations.first { it.peerDeviceId == conversation.peerDeviceId }
        assertTrue(
            "every entry that was on screen must carry a read time",
            after.entries.filter { it.direction == InboxConversationEntry.Direction.RECEIVED }
                .all { it.readAt != null },
        )

        val message = requireNotNull(
            after.entries.firstOrNull { it.kind == InboxConversationEntry.Kind.MESSAGE },
        ) { "an earlier leg exchanged a message and it is not in history" }
        // The EXACT text, not merely a non-null one. "The body is readable"
        // passes on a store that returned somebody else's message, or a
        // whitespace-trimmed copy of this one — which is the specific corruption
        // the send leg went to the trouble of encoding in base64 to detect.
        assertEquals(
            "the stored body must come back exactly as it was sent",
            messageText,
            kotlinx.coroutines.runBlocking { vm.inboxMessage(message) },
        )

        InteropDriver.report(
            REPORT,
            mapOf("leg" to "history", "unreadBefore" to unreadBefore, "unreadAfter" to 0),
        )
    }

    /**
     * A real SAF export that keeps the tree.
     *
     * The export goes through `OpenDocumentTree` and a real grant confirmation,
     * and the destination is read back as BYTES ON DISK rather than through the
     * provider that wrote them.
     */
    @Test
    fun exportsThroughRealSafKeepingNestedPaths() {
        onInboxSignedIn()
        awaitInbox("there is a file delivery to export") { parityEntry() != null }
        val entry = requireNotNull(parityEntry())
        val landed = HostInboxLiveDriver.payload(File(requireNotNull(entry.directory)))
        assertTrue(
            "the entry under test must have a nested file, or nesting is not being proven",
            landed.keys.any { it.contains('/') },
        )
        click(R.string.inbox_history_open)
        clickInEntry(entry.id, R.string.inbox_action_export)

        // **A tree grant is THREE steps, and only the last is the dialog.**
        //
        // `OpenDocumentTree` opens `DocumentsUI` at a place that is not the
        // destination: a folder must be entered, then confirmed with "Use this
        // folder", and only then does the consent dialog appear.
        // `confirmTreeGrant` handles that dialog and the auto-grant path — it
        // does not navigate and it does not confirm a folder. Calling it alone
        // leaves the picker sitting on screen until its own 25s deadline and
        // fails as "the scoped-access grant never completed", which reads like a
        // consent problem and is really a picker that was never answered.
        //
        // This is the sequence `NearbyAppleBidirectionalTest` already uses for
        // the same grant.
        DocumentsUiDriver.enterTestRootFromDrawer()
        DocumentsUiDriver.tap("Use this folder", "the tree confirm button", requireEnabled = true)
        DocumentsUiDriver.confirmTreeGrant { exportSettled() }
        compose.waitForIdle()
        InteropDriver.awaitTrue("the export reported an outcome", 120_000) { exportSettled() }
        requireShown(compose.onNodeWithText(s(R.string.inbox_export_done)))

        val exported = HostInboxLiveDriver.walk(testTreeRoot())
        // The receipt is internal bookkeeping. Copying it into a folder the
        // person chose would put a file they never received into their own
        // storage, so its ABSENCE here is part of what a correct export means.
        assertFalse(
            "the commit receipt must not be exported into the user's folder",
            exported.containsKey(com.relayium.android.inbox.InboxCommit.RECEIPT_NAME),
        )
        for ((key, here) in landed) {
            val out = requireNotNull(exported[key]) { "the export flattened or dropped $key" }
            assertEquals("$key must keep its bytes through the export", here.sha256, out.sha256)
        }
        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "export",
                "files" to landed.size,
                "nested" to landed.keys.count { it.contains('/') },
            ),
        )
    }

    /**
     * **A genuinely other app reads what the product granted it, and cannot
     * write it.**
     *
     * Both doors: `Open` sends `ACTION_VIEW` to one app, `Share` goes through
     * `Intent.createChooser`. They mint their grants by the same route but they
     * are different intents, and a run that proved one would be silent about the
     * other.
     *
     * The reader is a separate UID, so this test cannot read its report — only
     * `run-as com.relayium.acceptance.reader` can, and that is the shell's job.
     * What is asserted HERE is that the hand-off actually happened: the reader
     * was chosen BY NAME, came to the foreground, and said it had finished. The
     * shell then judges the report it wrote, and the revoke gate after the
     * identity change re-checks the same retained URIs in the same process.
     */
    @Test
    fun opensAndSharesToTheExternalReader() {
        onInboxSignedIn()
        awaitInbox("there is a file delivery to hand off") { parityEntry() != null }
        val entry = requireNotNull(parityEntry())

        click(R.string.inbox_history_open)

        // ── Open ────────────────────────────────────────────────────────────
        //
        // Judged HERE, not by the harness afterwards. Both hand-offs write the
        // same `received.json`, so the Share below overwrites this one — a shell
        // that read the file at the end of the leg would judge Share twice and
        // never look at Open's bytes at all. Open would then prove that a
        // resolver hand-off happened and nothing about what the other app could
        // actually read.
        // What this delivery actually holds, verified on disk by an earlier leg.
        val onDisk = HostInboxLiveDriver.payload(File(requireNotNull(entry.directory)))

        // **Open grants exactly ONE file.** `ACTION_VIEW` carries a single datum
        // — `setDataAndType(uris.first(), …)` with no `ClipData` — so expecting
        // the whole delivery here would fail against correct behaviour. The one
        // it grants is the first of `entry.names`, because `locate` builds its
        // file list in that order and the grant preserves it.
        val firstDelivered = entry.names.first()
        val expectedOpen = requireNotNull(
            onDisk[firstDelivered] ?: onDisk.values.firstOrNull {
                it.name == File(firstDelivered).name
            },
        ) { "the first delivered name is not on disk, so Open has no expected file" }

        HostInboxLiveChooser.clearReports()
        clickInEntry(entry.id, R.string.inbox_action_open)
        HostInboxLiveChooser.handOffToPrivateReader()
        HostInboxLiveChooser.awaitReaderFinished()
        HostInboxLiveChooser.back()
        val opened = assertReaderReceipt(
            HostInboxLiveChooser.awaitReport("received.json"), "the Open hand-off",
            listOf(expectedOpen),
        )

        // ── Share ───────────────────────────────────────────────────────────
        //
        // Cleared first, so the report the harness judges after this leg is
        // unambiguously Share's and not a leftover from Open.
        HostInboxLiveChooser.clearReports()
        compose.waitForIdle()
        clickInEntry(entry.id, R.string.inbox_action_share)
        HostInboxLiveChooser.handOffToPrivateReader()
        HostInboxLiveChooser.awaitReaderFinished()
        HostInboxLiveChooser.back()
        // Share carries EVERY delivered file — `ACTION_SEND` for one,
        // `ACTION_SEND_MULTIPLE` for several — and never the commit receipt,
        // which `payload` excludes. A receipt handed out would show up here as a
        // tuple the delivery does not contain.
        val shared = assertReaderReceipt(
            HostInboxLiveChooser.awaitReport("received.json"), "the Share hand-off",
            onDisk.values,
        )

        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "external-reader",
                "opened" to true,
                "shared" to true,
                // Counts only; the names are the user's.
                "openedFiles" to opened.getInt("count"),
                "sharedFiles" to shared.getInt("count"),
                "bytesVerified" to true,
            ),
        )
    }

    /**
     * Deleting ONE entry removes that row and stops answering for its body.
     *
     * The entry deleted is the one this device SENT — addressed by the file name
     * only that direction uses — so the received `android-parity` batch is left
     * intact for [historySurvivesARestart] to require back.
     */
    @Test
    fun deletionRemovesTheEntryAndItsBody() {
        onInboxSignedIn()
        awaitInbox("there is history to delete") { it.conversations.any { c -> c.entries.isNotEmpty() } }
        click(R.string.inbox_history_open)

        // Read from the model rather than reconstructed: `names` are relative as
        // delivered, and the row renders exactly what the model holds.
        val entry = requireNotNull(
            inbox.conversations.flatMap { it.entries }
                .firstOrNull { row -> row.names.any { it.contains("android-大文件-$runTag") } },
        ) { "the send leg's entry is not in history, so there is nothing to delete" }
        val id = entry.id
        val survivors = inbox.conversations.flatMap { it.entries }.map { it.id }.filter { it != id }

        clickInEntry(id, R.string.inbox_delete_action)
        compose.onNode(hasText(s(R.string.inbox_delete_title)) and hasAnyAncestor(isDialog()))
            .assertIsDisplayed()
        clickInDialog(R.string.inbox_delete_action)

        awaitInbox("the entry left this device's history", 60_000) { state ->
            state.conversations.flatMap { it.entries }.none { it.id == id }
        }
        // Exactly one row went. A deletion that took the conversation with it
        // would satisfy "the id is gone" and destroy everything else too.
        val remaining = inbox.conversations.flatMap { it.entries }.map { it.id }
        assertTrue(
            "deleting one entry must not remove the others",
            remaining.containsAll(survivors),
        )
        // The whole id, so `historySurvivesARestart` can require this exact entry
        // did not come back. An id names a task or job, never a file or a body.
        InteropDriver.report(
            REPORT,
            mapOf("leg" to "delete", "removed" to id, "survivors" to survivors.size),
        )
    }

    // ────────────────────────────────────────────────────────────────────────
    // 5. Identity, persistence, cancellation
    // ────────────────────────────────────────────────────────────────────────

    /**
     * **A new identity cancels the old account's work — including a capability
     * already handed to another application.**
     *
     * ## Everything below happens in ONE invocation, deliberately
     *
     * The grant is minted, proven to WORK from outside this process, and then
     * proven to have STOPPED working — all inside a single `am instrument` run,
     * without the Activity being torn down in between.
     *
     * That is not tidiness. `TransferViewModel.onCleared` calls
     * `SharedFileGrants.revokeAll()` — "every outstanding capability over this
     * account's deliveries ends with the process that granted it" — and this
     * suite finishes the Activity at the end of every leg. So a baseline taken
     * in one leg and a re-check taken in another would show the grant gone no
     * matter what the account did, and the run would report an account
     * revocation it had never observed. The teardown would have done it.
     *
     * Keeping both halves in one lifetime is what makes the difference
     * observable, because the only thing that changes between them is the
     * identity. The product path under test is
     * `SharedFileGrants.revokeExcept(grantAuthority(binding))`, which
     * `TransferViewModel` runs on every account-state change so that "a URI
     * minted for one session must stop resolving in the next".
     *
     * ## Two observers, and neither is this process
     *
     * `inboxGrantFiles` answers for the app's own view. The separate-UID reader
     * answers for the outside world, and it is the one that matters: a token
     * this app declines to mint again says nothing about a URI another app is
     * still holding.
     */
    @Test
    fun aNewIdentityCancelsTheOldAccountsWork() {
        onInboxSignedIn()

        // **`ready` is not a history barrier** — the same defect
        // `historySurvivesARestart` hit. `InboxRuntime.refresh` publishes
        // `ready = true` and only THEN calls `reconcileHistory`, so the surface
        // can be ready with the conversation list still empty. Counting rows or
        // looking up the delivery at that moment reads a store that is merely
        // late as a store that lost something — and here it would do worse than
        // fail: `oldConversations` would be captured as 0 and the "must have
        // history to leak" assertion would fire against a healthy device.
        //
        // Waited on the parity delivery specifically, because that is the entry
        // the grant below is minted over. A count barrier would be satisfied by
        // any row at all.
        awaitInbox("the history rehydrated before the baseline", 120_000) {
            parityEntry() != null
        }

        val oldGeneration = vm.accountGeneration()
        val oldConversations = inbox.conversations.size
        assertTrue("the first account must have history to leak", oldConversations > 0)

        val oldEntry = requireNotNull(parityEntry()) {
            "the first account must hold a file delivery for the grant check"
        }
        assertTrue(
            "the old account's files must be grantable BEFORE the switch, or the " +
                "check after it is vacuous",
            kotlinx.coroutines.runBlocking { vm.inboxGrantFiles(oldEntry) }.isNotEmpty(),
        )

        // ── a FRESH grant, and proof it actually works ──────────────────────
        HostInboxLiveChooser.clearReports()
        click(R.string.inbox_history_open)
        clickInEntry(oldEntry.id, R.string.inbox_action_share)
        HostInboxLiveChooser.handOffToPrivateReader()
        HostInboxLiveChooser.awaitReaderFinished()
        HostInboxLiveChooser.back()
        compose.waitForIdle()

        val baseline = assertReaderReceipt(
            HostInboxLiveChooser.awaitReport("received.json"), "the pre-logout grant",
            // The OLD account's delivered bytes. A baseline that merely proved
            // "some grant worked" would let the revocation half compare against
            // files the previous identity never owned.
            HostInboxLiveDriver.payload(File(requireNotNull(oldEntry.directory))).values,
        )
        val grantedCount = baseline.getInt("count")
        val readerProcess = baseline.getString("process")
        val readerDelivery = baseline.getString("delivery")

        // ── the identity changes, and NOTHING is torn down ──────────────────
        openTab(R.string.tab_account)
        click(R.string.account_sign_out)
        InteropDriver.awaitTrue("the session ended", 60_000) { !vm.account.holdsCredential }

        val fields = compose.onAllNodes(hasSetTextAction())
        reach(fields[0]).performTextInput(fixture.require("email2"))
        reach(fields[1]).performTextInput(fixture.require("password2"))
        click(R.string.account_signin_action)
        InteropDriver.awaitTrue("the second account signed in", 90_000) {
            vm.account.state.value is AccountState.Ready
        }

        openTab(R.string.tab_inbox)
        awaitInbox("the Inbox adopted the new identity", 120_000) { it.ready }
        assertTrue(
            "the new identity must not accept work launched under the old one",
            vm.accountGeneration() != oldGeneration,
        )
        assertTrue(
            "the previous account's conversations must not be visible under the new identity",
            inbox.conversations.isEmpty(),
        )
        assertTrue(
            "the previous account's files must not be grantable under a new identity",
            kotlinx.coroutines.runBlocking { vm.inboxGrantFiles(oldEntry) }.isEmpty(),
        )
        vm.inboxSendPicked(listOf(InteropDriver.treeUri()), "whatever", oldGeneration)
        Thread.sleep(SETTLE_MS)
        assertTrue(
            "a send launched under the old account must not run under the new one",
            inbox.sends.isEmpty(),
        )

        // ── the SAME reader, the SAME retained URIs, now refused ────────────
        val nonce = java.util.UUID.randomUUID().toString()
        HostInboxLiveChooser.recheck(context, nonce)
        HostInboxLiveChooser.awaitReaderFinished()
        HostInboxLiveChooser.back()
        val recheck = org.json.JSONObject(HostInboxLiveChooser.awaitReport("recheck.json"))

        assertTrue("the reader could not complete the re-check", recheck.optBoolean("ok"))
        assertEquals("the re-check echoed a different nonce", nonce, recheck.getString("nonce"))
        assertTrue("the re-check does not say it is one", recheck.getBoolean("recheck"))
        // A RESTARTED reader lost its URIs to process death, not to revocation.
        // Scoring that as a pass would credit the product with something Android
        // did, so it is INDETERMINATE and fails.
        assertEquals(
            "INDETERMINATE: the reader process restarted between the grant and the " +
                "re-check, so lost access proves process death rather than revocation",
            readerProcess,
            recheck.getString("process"),
        )
        assertEquals(
            "the re-check refers to a different delivery than the one granted",
            readerDelivery,
            recheck.getString("delivery"),
        )
        assertEquals(
            "the re-check lost track of the granted files; an empty list proves nothing",
            grantedCount,
            recheck.getInt("count"),
        )
        val after = recheck.getJSONArray("files")
        assertTrue("the re-check reported no files", after.length() > 0)
        for (i in 0 until after.length()) {
            val file = after.getJSONObject(i)
            assertFalse(
                "a URI retained by another app was STILL READABLE after the " +
                    "identity changed",
                file.optBoolean("read1", false) || file.optBoolean("read2", false),
            )
        }

        // Identities and counts only. The reports carry delivered file names,
        // which are plaintext-derived and stay on the device.
        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "identity-switch",
                "oldConversations" to oldConversations,
                "nowVisible" to 0,
                "oldGrantsRevoked" to true,
                "readerProcess" to readerProcess,
                "readerDelivery" to readerDelivery,
                "grantedCount" to grantedCount,
                "sameProcess" to true,
                "externallyRevoked" to true,
            ),
        )
    }

    /**
     * History, tombstones and the session survive the process going away.
     *
     * The harness force-stops the app before this leg, so the runtime, every
     * store and the whole controller generation are genuinely rebuilt from disk.
     * That is the only version of this that can show a deletion outliving the
     * object that wrote it.
     *
     * **Named survivors, not a count.** An assertion that "history is not empty"
     * passes on a store that came back holding the wrong thing, and an assertion
     * about a deleted id alone passes on a store that came back EMPTY. So this
     * requires the exact entry the batch leg recorded, its file still on disk at
     * its relative path with its original digest, and the message body still
     * readable — and separately requires the deleted entry to have stayed gone.
     */
    @Test
    fun historySurvivesARestart() {
        val survivingId = fixture.require("survivingEntryId")
        val survivingKey = fixture.require("survivingKey")
        val survivingSha = fixture.require("survivingSha")
        val deletedId = fixture.require("deletedEntryId")

        onInboxSignedIn()
        awaitInbox("the store was reopened", 120_000) { it.ready }
        assertTrue(
            "the credential must have survived the restart without another sign-in",
            vm.account.state.value is AccountState.Ready,
        )

        // **`ready` is NOT a history barrier.** `InboxRuntime.refresh` publishes
        // `ready = true` and only THEN calls `reconcileHistory`, which rebuilds
        // the ledger from the receipts and jobs on disk. So the surface can be
        // ready with the conversation list still empty, and a snapshot taken
        // there reports a survivor missing that is merely late.
        //
        // The barrier is the survivor itself: wait for the exact entry this run
        // recorded before the batch was ever restarted. Waiting on a COUNT
        // instead would be satisfied by any row at all, which is the assertion
        // this leg exists to avoid.
        awaitInbox("the restored history rehydrated the surviving entry", 120_000) { state ->
            state.conversations.flatMap { it.entries }.any { it.id == survivingId }
        }
        val entry = requireNotNull(
            inbox.conversations.flatMap { it.entries }.firstOrNull { it.id == survivingId },
        ) { "the entry the batch leg recorded did not come back after the restart" }

        // Read OFF DISK again. A store that reopened its index but lost the
        // files would satisfy every assertion made against the entry alone.
        val landed = HostInboxLiveDriver.payload(File(requireNotNull(entry.directory)))
        val here = requireNotNull(landed[survivingKey]) {
            "the surviving entry came back without its file at $survivingKey"
        }
        assertEquals(
            "the surviving file's bytes must be the ones that arrived before the restart",
            survivingSha,
            here.sha256,
        )

        assertTrue(
            "a deleted entry must not come back when the store is reopened",
            inbox.conversations.flatMap { it.entries }.none { it.id == deletedId },
        )

        // The body too: a message whose text did not survive is a row that lies.
        //
        // REQUIRED, not conditional. An earlier leg sent this message and the
        // delete leg removed a FILES entry, so it must be here — and a store
        // that came back without it would satisfy an `if (message != null)`
        // guard by having nothing to check, which is the precise shape of a
        // false pass this leg exists to prevent.
        // Same barrier for the message: `reconcileHistory` rebuilds every entry
        // together, but the wait above only proves the ONE it was told to look
        // for. A message rehydrating a moment later would otherwise read as a
        // message that did not survive.
        awaitInbox("the restored history rehydrated the message", 120_000) { state ->
            state.conversations.flatMap { it.entries }
                .any { it.kind == InboxConversationEntry.Kind.MESSAGE }
        }
        val message = requireNotNull(
            inbox.conversations.flatMap { it.entries }
                .firstOrNull { it.kind == InboxConversationEntry.Kind.MESSAGE },
        ) { "the message sent before the restart did not survive it" }
        assertEquals(
            "a surviving message must still hold its exact text",
            messageText,
            kotlinx.coroutines.runBlocking { vm.inboxMessage(message) },
        )

        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "restart",
                "conversations" to inbox.conversations.size,
                "survivorVerified" to true,
                "deletedStayedGone" to true,
            ),
        )
    }

    /**
     * **A cancelled send does not claim success.**
     *
     * ## The window is entered, not inferred
     *
     * The cancel is issued only once the send is observably `SENDING`. A job
     * still sitting at `STAGED` has not started, so cancelling it would stop
     * nothing and prove nothing — crediting that as cancellation coverage would
     * be the easiest false pass in this suite.
     *
     * ## Leaving SENDING is the outcome, not reaching STOPPED
     *
     * A cancelled job may honestly come to rest at `STOPPED` **or** back at
     * `STAGED` — retained and ready to retry, which is a real product state and
     * not a failure. An earlier version accepted only `STOPPED` and would have
     * timed out for three minutes against that perfectly correct outcome. What
     * is actually required is that the job LEAVES `SENDING` and does not land on
     * `DELIVERED`.
     *
     * ## What this leg does NOT establish
     *
     * It does not claim the far side is untouched. That would need to know the
     * upload had not begun when the cancel was issued, and a UI phase cannot
     * establish that — registration and the first bytes race. The no-create path
     * is covered independently by a controlled held-uploader probe; asserting it
     * from here would be inference dressed as evidence.
     *
     * A cancel that simply lost the race is reported INDETERMINATE. The product
     * behaved correctly and the leg proved nothing, which is a third outcome and
     * must not be recorded as either of the other two.
     */
    @Test
    fun aCancelledSendDoesNotClaimSuccess() {
        onInboxSignedIn()
        selectAppleTarget()

        val name = "cancelled-$runTag.bin"
        InteropDriver.stageOutgoing(name, ByteArray(MULTIFRAME_BYTES) { (it * 17 + 3).toByte() })

        click(R.string.inbox_send_choose_files)
        DocumentsUiDriver.enterTestRootThenTap(name)
        compose.waitForIdle()

        awaitInbox("the send appeared", 120_000) { it.sends.any { row -> name in row.names } }
        val job = inbox.sends.first { name in it.names }.jobId

        // Enter the window before acting on it. `DELIVERED` here means the whole
        // delivery finished before the cancel could be issued.
        awaitInbox("the send started", 120_000) { state ->
            val row = state.sends.firstOrNull { it.jobId == job }
            row != null && (
                row.phase == InboxSendStatus.Phase.SENDING ||
                    row.phase == InboxSendStatus.Phase.DELIVERED
                )
        }
        val phaseAtCancel = requireNotNull(inbox.sends.firstOrNull { it.jobId == job }).phase
        if (phaseAtCancel != InboxSendStatus.Phase.SENDING) {
            error(
                "INDETERMINATE: the send was $phaseAtCancel before the cancel could be " +
                    "issued, so cancellation was never exercised",
            )
        }

        vm.inboxCancelSend(job)

        // STOPPED, STAGED-and-retryable, or gone — any of those is the job
        // leaving the attempt. Only DELIVERED is excluded, and it is excluded
        // because it means the cancel lost.
        awaitInbox("the send left SENDING", 180_000) { state ->
            val row = state.sends.firstOrNull { it.jobId == job }
            row == null || row.phase != InboxSendStatus.Phase.SENDING
        }
        val terminal = inbox.sends.firstOrNull { it.jobId == job }
        if (terminal?.phase == InboxSendStatus.Phase.DELIVERED) {
            error(
                "INDETERMINATE: the delivery completed despite the cancel, so this run " +
                    "did not exercise cancellation",
            )
        }

        // The claim this leg does make: whatever happened on the wire, this
        // device must not tell its owner the file reached the target.
        assertTrue(
            "a cancelled send must never be recorded as saved on the target",
            sentEntries().none {
                name in it.names && it.sentState == InboxConversationEntry.SentState.SAVED
            },
        )

        InteropDriver.report(
            REPORT,
            mapOf(
                "leg" to "cancelled-send",
                "phaseAtCancel" to phaseAtCancel.name,
                "phaseAfter" to (terminal?.phase?.name ?: "gone"),
                "ambiguous" to (terminal?.ambiguous ?: false),
                "stop" to (terminal?.stop?.let { it::class.simpleName } ?: "none"),
                "claimedSaved" to false,
                // Stated so a reader cannot mistake this leg for remote proof.
                // The far side is covered by the controlled held-uploader probe.
                "coversRemoteAbsence" to false,
            ),
        )
    }

    // ── reading the far side ────────────────────────────────────────────────

    private fun conversationTexts(observed: org.json.JSONObject): Set<String> {
        val out = HashSet<String>()
        val conversations = observed.optJSONArray("conversations") ?: return out
        for (i in 0 until conversations.length()) {
            val entries = conversations.getJSONObject(i).optJSONArray("entries") ?: continue
            for (j in 0 until entries.length()) {
                entries.getJSONObject(j).takeIf { it.has("text") }?.let { out += it.getString("text") }
            }
        }
        return out
    }

    /** Every file the Mac has actually written, by name. */
    private fun appleFiles(observed: org.json.JSONObject): Map<String, HostInboxLiveDriver.Receipt> {
        val out = LinkedHashMap<String, HostInboxLiveDriver.Receipt>()
        val files = observed.optJSONArray("files") ?: return out
        for (i in 0 until files.length()) {
            val row = files.getJSONObject(i)
            out[row.getString("name")] = HostInboxLiveDriver.Receipt(
                name = row.getString("name"),
                path = row.optString("path", "").ifEmpty { null },
                size = row.getLong("size"),
                sha256 = row.getString("sha256"),
            )
        }
        return out
    }

    /**
     * The directory behind the test documents provider.
     *
     * `TestDocumentsProvider` is backed by `filesDir/test-tree`, and the
     * instrumentation shares the app's uid — so the export destination the
     * harness chose in `DocumentsUI` is readable here directly, as bytes on
     * disk, rather than back through the provider that wrote them.
     */
    private fun testTreeRoot(): File = File(context.filesDir, "test-tree")

    /**
     * The `android-parity` delivery specifically — not "the first file entry".
     *
     * Conversations and their entries are newest-first, and the tab-independence
     * and ASK legs each land a one-file `competing` batch AFTER the parity batch
     * arrives. "The first received file entry" is therefore one of those by the
     * time the export leg runs, and it has no nested path and no zero-byte leaf:
     * the nesting assertion would fail against a product that was behaving
     * perfectly. This picks the delivery those assertions are actually about.
     */
    private fun parityEntry(): InboxConversationEntry? = receivedEntries()
        .firstOrNull { entry ->
            entry.kind == InboxConversationEntry.Kind.FILES &&
                entry.directory != null &&
                entry.names.any { it.contains("大文件-$runTag") }
        }

    private fun exportSettled(): Boolean = listOf(
        R.string.inbox_export_done,
        R.string.inbox_export_failed,
        R.string.inbox_export_incomplete,
        R.string.inbox_export_unavailable,
    ).any { runCatching { compose.onNodeWithText(s(it)).assertExists() }.isSuccess }

    private companion object {
        const val REPORT = "host-inbox-live"

        /** Past `STORE_CHUNK_SIZE` (192 KiB), so a delivery spans two chunks. */
        const val MULTIFRAME_BYTES = 307_200

        /**
         * Long enough that a delivery which was merely SLOW would have arrived.
         *
         * Used only for the negative assertions — declined, off, cancelled —
         * where the claim is that nothing happens. A positive wait polls a
         * monotonic receipt instead and never sleeps.
         */
        const val SETTLE_MS = 8_000L
    }
}
